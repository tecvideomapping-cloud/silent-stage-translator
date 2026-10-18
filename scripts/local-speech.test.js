const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('events');
const {PassThrough,Writable}=require('stream');
const {LocalSpeech}=require('../desktop/local-speech');
function fixture(){
  const messages=[];const children=[];const spawnCalls=[];
  const engine=new LocalSpeech({spawn:(...args)=>{spawnCalls.push(args);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,_encoding,done){messages.push(JSON.parse(chunk));done();}});child.kill=()=>{child.killed=true;};children.push(child);return child;}});
  const ready=()=>children.at(-1).stdout.write('{"type":"ready"}\n');
  return {engine,messages,children,ready,spawnCalls};
}
const audio=value=>new Int16Array(3200).fill(value).buffer;
test('per-engine devices and compute settings are passed as bounded arguments',()=>{const f=fixture();try{f.engine.start({device:'cuda',gpuIndex:1,computeType:'float16',cpuThreads:2,diarization:true,diarizationDevice:'cuda',diarizationGpuIndex:0});const args=f.spawnCalls[0][1];assert.equal(args[args.indexOf('--device')+1],'cuda');assert.equal(args[args.indexOf('--gpu-index')+1],'1');assert.equal(args[args.indexOf('--diarization-gpu-index')+1],'0');f.children[0].stdout.write(JSON.stringify({type:'ready',runtime:{device:'cuda',gpuIndex:1,computeType:'float16'}})+'\n');assert.equal(f.engine.status().runtime.gpuIndex,1);f.children[0].stdout.write('{"type":"telemetry","cpuPercent":12,"memoryMb":300,"memoryKind":"resident"}\n');assert.equal(f.engine.status().metrics.memoryMb,300);f.engine.stop();assert.equal(f.engine.status().runtime,null);assert.deepEqual(f.engine.status().metrics,{});}finally{f.engine.stop();}});
test('invalid devices and library failures cannot silently claim GPU execution',()=>{const {normalize}=require('../desktop/speech-config');const c=normalize({device:'cuda;exec',cpuThreads:999999,gpuIndex:-1,computeType:'../../payload',diarizationDevice:'malicious'});assert.equal(c.device,'cpu');assert.equal(c.gpuIndex,0);assert.equal(c.computeType,'int8');assert.equal(c.diarizationDevice,'cpu');const f=fixture();f.engine.start({device:'cuda'});f.children[0].stdout.write('{"type":"error","code":"CUDA_RUNTIME_UNAVAILABLE"}\n');assert.equal(f.engine.status().state,'error');assert.equal(f.engine.status().runtime,null);assert.match(f.engine.status().message,/CUDA\/cuDNN/);});
test('installer accepts only fixed dependency options, never renderer commands',()=>{const {setupArguments}=require('../desktop/engine-setup');const args=setupArguments({check:true,cuda:true,diarization:true,path:'evil.ps1',command:'arbitrary',EnvironmentRoot:'other'});assert.ok(args.includes('-Cuda'));assert.ok(args.includes('-Diarization'));assert.ok(args.includes('-CheckOnly'));assert.ok(args.some(a=>a.endsWith('ensure-engine.ps1')));assert.ok(!args.some(a=>String(a).includes('evil')||String(a).includes('arbitrary')||a==='other'));});
test('local recognizer segments speech on silence and never transcribes silence',()=>{
  const {engine,messages,ready}=fixture();try{engine.start();ready();for(let i=0;i<20;i++)engine.feed(audio(0));assert.equal(messages.length,0);for(let i=0;i<4;i++)engine.feed(audio(2000));for(let i=0;i<3;i++)engine.feed(audio(0));assert.equal(messages.length,1);assert.equal(messages[0].id,1);assert.ok(messages[0].start>=3.5);assert.ok(Buffer.from(messages[0].pcm,'base64').length<224000);}finally{engine.stop();}
});
test('speaker turns preserved, session reset kills stale inference',()=>{
  const {engine,children,ready}=fixture();const result=[];engine.on('transcript',value=>result.push(value));try{engine.start({diarization:true});ready();children[0].stdout.write(JSON.stringify({type:'result',id:1,segments:[{text:'Pergunta',speakerId:0},{text:'Resposta',speakerId:1},{text:'Obrigado',speakerId:0}]})+'\n');assert.deepEqual(result.map(e=>e.speakerId),[0,1,0]);assert.equal(new Set(result.map(e=>e.turnId)).size,3);engine.stop();children[0].stdout.write('{"type":"result","id":2,"segments":[{"text":"stale"}]}\n');assert.equal(result.length,3);assert.equal(children[0].killed,true);}finally{engine.stop();}
});
test('bounded queue fails visibly instead of accumulating unlimited latency',()=>{
  const {engine,messages,ready}=fixture();try{engine.start();ready();for(let i=0;i<100;i++)engine.feed(audio(3000));assert.equal(messages.length,2);assert.equal(engine.status().state,'error');assert.match(engine.status().message,/não acompanha/);}finally{engine.stop();}
});
test('malformed audio and renderer model paths are rejected',()=>{
  const {engine,ready}=fixture();try{engine.start({model:'../../untrusted.py',language:'--arbitrary',diarization:'true'});ready();assert.equal(engine.status().model,'base');assert.equal(engine.status().diarization,false);assert.throws(()=>engine.feed(new ArrayBuffer(3)));assert.throws(()=>engine.feed(new ArrayBuffer(32002)));}finally{engine.stop();}
});
test('IPC rejects other windows, subframes and pages even on trusted domain',()=>{
  const {registerSpeechIpc}=require('../desktop/speech-ipc');const calls={};const ipcMain={handle:(name,fn)=>calls[name]=fn,on:(name,fn)=>calls[name]=fn};const engine=fixture().engine;const sender={mainFrame:{url:'https://example.com/host.html'},isDestroyed:()=>false,send:()=>{}};
  registerSpeechIpc({ipcMain,cloudBase:'https://example.com',getWindow:()=>({webContents:sender}),getLocalOrigin:()=>null,engine});
  const event={sender,senderFrame:sender.mainFrame};assert.equal(calls['vmt:speech:status'](event).state,'stopped');assert.throws(()=>calls['vmt:speech:status']({...event,senderFrame:{url:'https://example.com/host.html'}}));sender.mainFrame.url='https://example.com/customer.html';assert.throws(()=>calls['vmt:speech:status'](event));sender.mainFrame.url='https://evil.test/host.html';assert.throws(()=>calls['vmt:speech:status'](event));
});
