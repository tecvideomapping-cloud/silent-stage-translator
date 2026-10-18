'use strict';
(()=>{
 const panel=document.getElementById('subtitlesSection'),button=document.getElementById('expandCaptionsButton');if(!panel||!button)return;
 let focused=false,busy=false,background=[];
 function setFocus(active){
  focused=active;panel.classList.toggle('captions-expanded',active);document.body.classList.toggle('captions-focused',active);button.setAttribute('aria-pressed',String(active));button.textContent=active?'Sair da tela cheia':'Legendas em tela cheia';
  if(active){background=[...document.querySelectorAll('body > header, body > footer, #audioUnlockBanner, .vmt-session-story, .vmt-listener > section:not(#subtitlesSection), #translationServiceStatus')].map(node=>({node,inert:node.inert}));background.forEach(({node})=>node.inert=true);}
  else{background.forEach(({node,inert})=>node.inert=inert);background=[];button.focus({preventScroll:true});}
 }
 button.addEventListener('click',async()=>{
  if(busy)return;busy=true;
  try{if(focused){if(document.fullscreenElement===panel)await document.exitFullscreen();setFocus(false);}else{setFocus(true);try{await panel.requestFullscreen?.();}catch{/* Full viewport remains available when native fullscreen is unsupported. */}}}
  finally{busy=false;}
 });
 document.addEventListener('fullscreenchange',()=>{if(focused&&document.fullscreenElement!==panel)setFocus(false);});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&focused&&!document.fullscreenElement){event.preventDefault();setFocus(false);}});
})();
