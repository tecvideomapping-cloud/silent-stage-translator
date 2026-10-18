(function(root){
 const normalize=word=>word.toLocaleLowerCase().replace(/[.,!?;:]+$/g,'');
 class SpeechLedger {
  constructor(){this.entries=new Map();}
  pending(index,text){
   let entry=this.entries.get(index);if(!entry){entry={sent:[],words:[],offset:0};this.entries.set(index,entry);}
   if(text!==undefined)entry.words=String(text).trim().split(/\s+/).filter(Boolean);
   const sent=entry.sent.map(normalize),words=entry.words.map(normalize);let offset=0;
   if(sent.length&&sent.every((word,i)=>words[i]===word))offset=sent.length;
   else if(sent.length){
    // Recognizers revise/remove words in an interim prefix. A numeric cursor
    // silently eats new words; align the actual suffix that was already sent.
    for(let count=Math.min(sent.length,words.length);count>0;count--){
     if(count===1&&sent.length>1)continue;
     if(sent.slice(-count).every((word,i)=>words[i]===word)){offset=count;break;}
    }
   }
   entry.offset=offset;return entry.words.slice(offset);
  }
  commit(index,count){const entry=this.entries.get(index);if(!entry)return;entry.sent=entry.words.slice(0,entry.offset+count);entry.offset=entry.sent.length;}
  finish(index){this.entries.delete(index);}
  drain(){const result=[];for(const [index] of this.entries){const words=this.pending(index);if(words.length){this.commit(index,words.length);result.push(words.join(' '));}}return result;}
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={SpeechLedger};else root.VmtSpeechLedger=SpeechLedger;
})(typeof window!=='undefined'?window:globalThis);
