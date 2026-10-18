const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),crypto=require('crypto');
const {SpeechLedger}=require('../public/speech-ledger');
function engine(){
 const source=fs.readFileSync(require.resolve('../public/host.html'),'utf8');const start=source.indexOf('    window.speechEngine = {'),end=source.indexOf('    let hostTranscriptFontSize',start);const sent=[];
 const context={window:{VmtSpeechLedger:SpeechLedger},socket:{readyState:1,send:raw=>sent.push(JSON.parse(raw))},WebSocket:{OPEN:1},document:{getElementById:()=>null},crypto,setTimeout,clearTimeout,clearInterval,Date,console};
 vm.runInNewContext(source.slice(start,end),context);const instance=context.window.speechEngine;
 const result=(index,text,isFinal)=>{const item=[{transcript:text}];item.isFinal=isFinal;const results=[];results[index]=item;instance.handleResult({resultIndex:index,results});};
 return {instance,sent,result};
}
test('real host handler preserves a final suffix after Chrome revises an already flushed interim',async()=>{
 const {instance,sent,result}=engine();try{result(0,'é essencial ter',false);await new Promise(r=>setTimeout(r,780));result(0,'essencial ter acesso',true);assert.deepEqual(sent.filter(item=>item.isFinal).map(item=>item.text),['é essencial ter','acesso']);}finally{instance.stop();}
});
test('real host handler does not suppress two genuine repeated replies',()=>{
 const {instance,sent,result}=engine();try{result(0,'Sim.',true);result(1,'Sim.',true);const finals=sent.filter(item=>item.isFinal);assert.equal(finals.length,2);assert.notEqual(finals[0].segmentId,finals[1].segmentId);}finally{instance.stop();}
});
test('stopping drains all unfinished recognition results, not only the last one',()=>{
 const {instance,sent,result}=engine();result(0,'sobre a',false);result(1,'para uma',false);instance.stop();assert.deepEqual(sent.filter(item=>item.isFinal).map(item=>item.text),['sobre a','para uma']);instance.stop();assert.equal(sent.filter(item=>item.isFinal).length,2);
});
test('delayed audio unlocking must not pause the first translated sentence',async()=>{
 const source=fs.readFileSync(require.resolve('../public/index.html'),'utf8');const start=source.indexOf('    function unlockAudioForMobile()'),end=source.indexOf("    document.addEventListener('touchstart'",start);
 let resolvePlay,paused=0;const player={src:'',paused:false,play:()=>new Promise(resolve=>{resolvePlay=resolve;}),pause:()=>paused++};
 const context={ensureAudioContext:()=>{},armBackgroundAudioKeepAlive:()=>{},ensureSharedTtsPlayer:()=>player,setupTtsAudioGraph:()=>{},isTtsPlaying:false,isPlaying:true,ttsPlaybackGeneration:0,document:{getElementById:()=>null},currentChannel:'original',ttsAudioQueue:[]};vm.createContext(context);vm.runInContext(source.slice(start,end),context);context.unlockAudioForMobile();
 context.isTtsPlaying=true;player.src='blob:first-real-sentence';resolvePlay();await Promise.resolve();assert.equal(paused,0);
});
