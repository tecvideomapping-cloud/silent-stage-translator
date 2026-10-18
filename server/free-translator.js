// A slow/unavailable mirror must not hold every subsequent sentence in order.
// Hedge only after a short grace period; cancel losers and back off failures.
class FreeTranslator {
 constructor({request=(...args)=>fetch(...args),hedgeMs=250,timeoutMs=4500,now=()=>Date.now()}={}){this.request=request;this.hedgeMs=hedgeMs;this.timeoutMs=timeoutMs;this.now=now;this.health=new Map();this.inFlight=new Map();}
 stats(){return [...this.health].map(([provider,value])=>({provider,...value}));}
 canTranslateInterim(){return ['google-gtx','google-clients5','mymemory'].filter(name=>(this.health.get(name)?.retryAt||0)<=this.now()).length>1&&this.inFlight.size<8;}
 async translate(text,target,source='pt'){
  const language=String(target).split('-')[0].toLowerCase(),from=/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(source)?source.split('-')[0]:'pt';
  const key=JSON.stringify([from,language,text]);if(this.inFlight.has(key))return this.inFlight.get(key);
  if(this.inFlight.size>=512)return null;
  const task=this.run(text,language,from);this.inFlight.set(key,task);
  try{return await task;}finally{this.inFlight.delete(key);}
 }
 async run(text,language,source){
  const controller=new AbortController();const started=this.now();
  const providers=[
   {name:'google-gtx',url:`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(language)}&dt=t&q=${encodeURIComponent(text)}`,parse:data=>Array.isArray(data?.[0])?data[0].map(item=>item[0]||'').join(''):''},
   {name:'google-clients5',url:`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(language)}&q=${encodeURIComponent(text)}`,parse:data=>Array.isArray(data)?typeof data[0]==='string'?data[0]:Array.isArray(data[0])?data.map(item=>item[0]||'').join(' '):'':Array.isArray(data?.sentences)?data.sentences.map(item=>item.trans||'').join(' '):''},
   {name:'mymemory',url:`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(source+'|'+language)}`,parse:data=>Number(data?.responseStatus||200)===200?data?.responseData?.translatedText||'':''}
  ];
  const available=providers.filter(provider=>(this.health.get(provider.name)?.retryAt||0)<=this.now()).sort((a,b)=>{const x=this.health.get(a.name),y=this.health.get(b.name);return Number(!!y?.successes)-Number(!!x?.successes)||(x?.consecutiveFailures||0)-(y?.consecutiveFailures||0);});
  if(!available.length)return null;
  const attempt=async(provider,index)=>{
   if(index)await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(Error('cancelled'));};const timer=setTimeout(()=>{controller.signal.removeEventListener('abort',abort);resolve();},this.hedgeMs*index);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();});
   if(controller.signal.aborted)throw Error('cancelled');
   const state=this.health.get(provider.name)||{requests:0,successes:0,failures:0,consecutiveFailures:0,retryAt:0,lastMs:0};this.health.set(provider.name,state);state.requests++;
   const at=this.now();let status=0,quotaDelay=60000;
   try{
    const response=await this.request(provider.url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs)])});status=response.status;state.lastStatus=status;
    const data=await response.json().catch(()=>null);
    const warning=String(data?.responseData?.translatedText||'');
    if(provider.name==='mymemory'&&(data?.quotaFinished||data?.quotaFinishe||/USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY/i.test(warning))){
     status=429;state.lastStatus=429;state.failureReason='daily-quota';
     const remaining=/NEXT AVAILABLE IN\s+(\d+) HOURS?\s+(\d+) MINUTES?\s+(\d+) SECONDS?/i.exec(warning);
     quotaDelay=remaining?Math.min(86400000,(Number(remaining[1])*3600+Number(remaining[2])*60+Number(remaining[3]))*1000+1000):86400000;
     throw Error('daily quota exhausted');
    }
    if(!response.ok)throw Error('provider unavailable');
    const translated=String(provider.parse(data)||'').trim();
    if(!translated||/QUERY LENGTH LIMIT|MYMEMORY WARNING|PLEASE SELECT TWO DISTINCT|USED ALL AVAILABLE FREE TRANSLATIONS/i.test(translated))throw Error('invalid translation');
    state.successes++;state.failureReason=null;state.consecutiveFailures=0;state.retryAt=0;state.lastMs=this.now()-at;
    return {text:translated,provider:provider.name,providerMs:state.lastMs,totalMs:this.now()-started};
   }catch(error){if(!controller.signal.aborted){state.failures++;state.consecutiveFailures++;state.lastMs=this.now()-at;if(status===429)state.retryAt=this.now()+quotaDelay;state.failureReason=state.failureReason==='daily-quota'?'daily-quota':status===429?'rate-limit':error.name==='TimeoutError'?'timeout':'unavailable';}throw error;}
  };
  try{return await Promise.any(available.map(attempt));}catch{return null;}finally{controller.abort();}
 }
}
module.exports={FreeTranslator};
