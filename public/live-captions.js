(()=>{
 const states=new WeakMap();
 function append(container,text,metadata={}){
  if(!container||!String(text||'').trim())return;
  let state=states.get(container);if(!state){state={seen:new Set()};states.set(container,state);}
  const key=metadata.segmentId?String(metadata.lang||'original')+':'+metadata.segmentId:null;
  if(key&&state.seen.has(key))return;
  if(key){state.seen.add(key);if(state.seen.size>512)state.seen.delete(state.seen.values().next().value);}
  const speaker=Number.isInteger(metadata.speakerId)&&metadata.speakerId>=0?metadata.speakerId:null;
  const turn=String(metadata.turnId||metadata.segmentId||'');
  let row=container.lastElementChild;
  if(!turn||!row||row.dataset.turn!==turn||row.dataset.speaker!==String(speaker)||row.textContent.length>280){
   row=document.createElement('div');row.className='vmt-caption-turn';row.dataset.turn=turn;row.dataset.speaker=String(speaker);
   if(speaker!==null){const label=document.createElement('span');label.className='vmt-caption-speaker';label.textContent='Locutor '+(speaker+1);row.appendChild(label);}
   const content=document.createElement('span');content.className='vmt-caption-content';row.appendChild(content);container.appendChild(row);
  }
  const content=row.querySelector('.vmt-caption-content');content.appendChild(document.createTextNode((content.textContent?' ':'')+String(text).trim()));
  while(container.children.length>100)container.firstElementChild.remove();
 }
 window.VmtCaptions={append};
})();
