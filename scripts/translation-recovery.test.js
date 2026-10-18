const test=require('node:test'),assert=require('node:assert/strict');
const {FreeTranslator}=require('../server/free-translator');
test('two transient failures never disable the only usable mirror for twenty seconds',async()=>{
 let tries=0;const t=new FreeTranslator({hedgeMs:1,request:async url=>{
  if(!url.includes('clients5'))return new Response('{}',{status:429});
  if(++tries<=2)throw Object.assign(Error('timeout'),{name:'TimeoutError'});
  return new Response(JSON.stringify(['Recovered']));
 }});
 assert.equal(await t.translate('A','es'),null);assert.equal(await t.translate('B','es'),null);
 assert.equal((await t.translate('C','es')).text,'Recovered');
});
test('daily quota backs off until reset and gives final translations priority',async()=>{
 let calls=0;const t=new FreeTranslator({hedgeMs:1,request:async url=>{
  if(url.includes('mymemory')){calls++;return new Response(JSON.stringify({quotaFinished:true,responseData:{translatedText:'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN 18 HOURS 02 MINUTES 57 SECONDS'}}),{status:429});}
  return new Response('{}',{status:429});
 }});
 await t.translate('A','es');assert.equal(t.canTranslateInterim(),false);
 const state=t.stats().find(x=>x.provider==='mymemory');assert.ok(state.retryAt>Date.now()+18*3600000);assert.equal(state.failureReason,'daily-quota');
 await t.translate('B','es');assert.equal(calls,1);
});
test('a previously successful mirror starts immediately instead of waiting behind a failed primary',async()=>{
 const order=[];const t=new FreeTranslator({hedgeMs:1,request:async url=>{order.push(url.includes('clients5')?'mirror':'primary');return url.includes('clients5')?new Response(JSON.stringify(['OK'])):new Response('{}',{status:503});}});
 await t.translate('A','es');order.length=0;await t.translate('B','es');assert.equal(order[0],'mirror');
});
