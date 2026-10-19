const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function renderer(fail=false,saved={},migrated=false){
  const calls=[],frames=[],events=[];let receive;
  const bridge={onEvent:fn=>receive=fn,start:async config=>{calls.push(config);if(fail)throw Error('missing');return {state:'loading'};},stop:async()=>({state:'stopped'}),audio:frame=>frames.push(frame)};
  const window={desktopHost:{speech:bridge},addEventListener(){},dispatchEvent:event=>events.push(event.detail)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/local-speech.js'),'utf8'),{window,document:{addEventListener(){}},localStorage:{getItem:key=>key==='vmt.localEngineSettings.v1'?JSON.stringify(saved):migrated?'small':null,setItem(){}},CustomEvent:class{constructor(_name,options){this.detail=options.detail;}},setInterval,clearInterval,Int16Array});
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

test('accuracy migration upgrades an existing GPU Base profile once and preserves deliberate model choices',async()=>{const upgraded=renderer(false,{device:'cuda',model:'base'});await upgraded.speech.begin(()=>{},'pt-BR');assert.equal(upgraded.calls[0].model,'small');for(const [saved,migrated] of [[{device:'cpu',model:'base'},false],[{device:'cuda',model:'tiny'},false],[{device:'cuda',model:'base'},true]]){const r=renderer(false,saved,migrated);await r.speech.begin(()=>{},'pt-BR');assert.equal(r.calls[0].model,saved.model);}});

test('the renderer forwards captured audio while the local model is loading',async()=>{const r=renderer();await r.speech.begin(()=>{},'pt-BR');r.speech.feed(new Float32Array(6401).fill(.1),16000);assert.equal(r.frames.length,2);});
