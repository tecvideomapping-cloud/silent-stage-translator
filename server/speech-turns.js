const crypto=require('crypto');

// Speaker numbers are supplied by the recognizer, never guessed from text/pitch.
class SpeechTurns {
 constructor(){this.session=crypto.randomUUID();this.counter=0;this.speaker=null;this.turnId=null;this.closed=true;this.lastEnd=-1;}
 accept(message){
  if(message.type==='UtteranceEnd'){this.closed=true;return [];}
  const alternative=message.channel?.alternatives?.[0];if(!alternative)return [];
  const final=message.is_final===true,words=alternative.words||[],groups=[];
  for(const word of words){
   if(final&&Number.isFinite(word.end)&&word.end<=this.lastEnd+0.0001)continue;
   const text=String(word.punctuated_word||word.word||'').trim();if(!text)continue;
   const speaker=Number.isInteger(word.speaker)&&word.speaker>=0?word.speaker:null;
   let group=groups[groups.length-1];
   if(!group||group.speakerId!==speaker){group={speakerId:speaker,text:'',start:word.start,end:word.end};groups.push(group);}
   group.text+=(group.text?' ':'')+text;group.end=word.end;
  }
  if(!words.length&&alternative.transcript?.trim())groups.push({speakerId:null,text:alternative.transcript.trim()});
  const events=groups.map((group,index)=>{
   const newTurn=this.closed||this.speaker!==group.speakerId||!this.turnId;
   const turnId=newTurn?this.session+':'+(++this.counter):this.turnId;
   if(final){this.turnId=turnId;this.speaker=group.speakerId;this.closed=false;if(Number.isFinite(group.end))this.lastEnd=Math.max(this.lastEnd,group.end);}
   return {text:group.text,isFinal:final,speechFinal:message.speech_final===true&&index===groups.length-1,speakerId:group.speakerId,turnId,segmentId:final?crypto.randomUUID():null,startSeconds:group.start,endSeconds:group.end,timestamp:Date.now(),source:'deepgram'};
  });
  if(final&&message.speech_final===true)this.closed=true;
  return events;
 }
}

// Work starts concurrently; each language publishes in source order independently.
class OrderedTranslations {
 constructor(){this.tails=new Map();}
 async translate(roomId,text,languages,glossary,pipeline,onReady,sourceLang='pt'){
  const started=Date.now();
  const tickets=new Map();
  for(const language of [...new Set(languages)]){
   const key=roomId+':'+language,previous=this.tails.get(key)||Promise.resolve();let resolve;
   const result=new Promise(r=>{resolve=r});
   const published=previous.catch(()=>{}).then(()=>result).then(value=>{if(value!==null)onReady(language,value.text,{providerMs:value.readyAt-started,orderingWaitMs:Date.now()-value.readyAt})});
   this.tails.set(key,published);published.finally(()=>{if(this.tails.get(key)===published)this.tails.delete(key)}).catch(()=>{});
   tickets.set(language,{resolve:value=>resolve(value===null?null:{text:value,readyAt:Date.now()}),published});
  }
  try{return await pipeline.translateText(text,[...tickets.keys()],glossary,(language,value)=>tickets.get(language)?.resolve(value),roomId,sourceLang);}
  finally{for(const ticket of tickets.values())ticket.resolve(null);await Promise.all([...tickets.values()].map(t=>t.published));}
 }
}
module.exports={SpeechTurns,OrderedTranslations};
