const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function renderer(fail=false){
  const calls=[],frames=[],events=[];let receive;
  const bridge={onEvent:fn=>receive=fn,start:async config=>{calls.push(config);if(fail)throw Error('missing');return {state:'loading'};},stop:async()=>({state:'stopped'}),audio:frame=>frames.push(frame)};
  const window={desktopHost:{speech:bridge},addEventListener(){},dispatchEvent:event=>events.push(event.detail)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/local-speech.js'),'utf8'),{window,document:{addEventListener(){}},localStorage:{getItem:()=>null},CustomEvent:class{constructor(_name,options){this.detail=options.detail;}},setInterval,clearInterval,Int16Array});
  return {speech:window.localSpeech,calls,frames,events,emit:data=>receive(data)};
}
test('desktop capture starts its own model without a separate activation click and restarts after stopping',async()=>{
  const r=renderer(),texts=[];await r.speech.begin(text=>texts.push(text),'pt-BR');assert.equal(r.calls.length,1);assert.equal(r.calls[0].language,'pt');assert.equal(r.speech.selected,true);assert.equal(r.speech.active,false);
  r.emit({kind:'status',data:{state:'ready'}});r.speech.feed(new Float32Array(5000).fill(.1),16000);assert.ok(r.frames.length);r.emit({kind:'transcript',data:{text:'teste'}});assert.equal(texts[0].text,'teste');
  r.speech.end();r.emit({kind:'status',data:{state:'stopped'}});await r.speech.begin(()=>{},'en-US');assert.equal(r.calls.length,2);assert.equal(r.calls[1].language,'en');
});
test('failed desktop model remains selected instead of falling through to browser recognition',async()=>{
  const r=renderer(true);await r.speech.begin(()=>{},'pt-BR');assert.equal(r.speech.selected,true);assert.equal(r.speech.active,false);assert.equal(r.events.at(-1).active,false);
});
