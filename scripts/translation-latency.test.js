const test=require('node:test'),assert=require('node:assert/strict');
const {FreeTranslator}=require('../server/free-translator');const {SpeechLedger}=require('../public/speech-ledger');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('a hung primary cannot block a valid mirror; losing requests abort',async()=>{
 let aborted=false;const translator=new FreeTranslator({hedgeMs:10,timeoutMs:500,request:async(url,{signal})=>{
  if(url.includes('googleapis'))return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));
  if(url.includes('clients5'))return new Response(JSON.stringify(['Translation']));return new Response('{}',{status:503});
 }});const started=Date.now();const result=await translator.translate('Texto','en');assert.equal(result.text,'Translation');assert.ok(Date.now()-started<300);assert.equal(aborted,true);
});
test('rate limited provider backs off and concurrent identical requests share work',async()=>{
 let primary=0;const translator=new FreeTranslator({hedgeMs:1,request:async url=>{if(url.includes('googleapis')){primary++;return new Response('',{status:429});}await sleep(5);return new Response(JSON.stringify(['Translated']));}});
 const [a,b]=await Promise.all([translator.translate('One','en'),translator.translate('One','en')]);assert.equal(a.text,b.text);assert.equal(primary,1);await translator.translate('Two','en');assert.equal(primary,1);assert.ok(translator.stats().find(item=>item.provider==='google-gtx').retryAt>Date.now());
});
test('fallback never publishes quota warnings or invalid bodies',async()=>{
 const translator=new FreeTranslator({hedgeMs:1,request:async()=>new Response(JSON.stringify({responseStatus:429,responseData:{translatedText:'MYMEMORY WARNING'}}))});assert.equal(await translator.translate('Texto','en'),null);
});
test('interim revisions cannot swallow the final words after the committed prefix shrinks',()=>{
 const ledger=new SpeechLedger();assert.deepEqual(ledger.pending(0,'é essencial ter'),['é','essencial','ter']);ledger.commit(0,3);assert.deepEqual(ledger.pending(0,'essencial ter acesso'),['acesso']);ledger.commit(0,1);assert.deepEqual(ledger.pending(0,'essencial ter acesso a todos'),['a','todos']);
});
test('ambiguous revisions preserve words and repeated short phrases are not discarded',()=>{
 const ledger=new SpeechLedger();ledger.pending(0,'muito importante');ledger.commit(0,2);assert.deepEqual(ledger.pending(0,'isso é fundamental agora'),['isso','é','fundamental','agora']);ledger.commit(0,4);ledger.finish(0);assert.deepEqual(ledger.pending(1,'sim'),['sim']);ledger.commit(1,1);assert.deepEqual(ledger.pending(1,'sim sim'),['sim']);
});
test('session end drains every pending result exactly once',()=>{
 const ledger=new SpeechLedger();ledger.pending(0,'primeiro trecho');ledger.pending(1,'segundo trecho');assert.deepEqual(ledger.drain(),['primeiro trecho','segundo trecho']);assert.deepEqual(ledger.drain(),[]);
});
