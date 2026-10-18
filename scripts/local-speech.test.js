const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('events');
const {PassThrough,Writable}=require('stream');
const {LocalSpeech}=require('../desktop/local-speech');
function fixture(){
  const messages=[];const children=[];
  const engine=new LocalSpeech({spawn:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,_encoding,done){messages.push(JSON.parse(chunk));done();}});child.kill=()=>{child.killed=true;};children.push(child);return child;}});
  const ready=()=>children.at(-1).stdout.write('{"type":"ready"}\n');
  return {engine,messages,children,ready};
}
const audio=value=>new Int16Array(3200).fill(value).buffer;
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
