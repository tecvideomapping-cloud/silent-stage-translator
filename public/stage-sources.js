'use strict';
(() => {
  const anchor=document.querySelector('#host-monitor')||document.querySelector('#tab-live')||document.querySelector('main');
  if(!anchor)return;
  const panel=document.createElement('section');panel.className='stage-source-panel vmt-glass';panel.setAttribute('aria-label','Dispositivos transmissores');
  const title=document.createElement('h2');title.textContent='Dispositivos do evento';
  const description=document.createElement('p');description.textContent='As entradas ao vivo são ouvidas juntas. Use fones para evitar retorno; todos os operadores precisam entrar na conta do evento.';
  const label=document.createElement('label');label.textContent='Nome deste dispositivo';
  const input=document.createElement('input');input.maxLength=48;input.setAttribute('aria-label','Nome deste dispositivo');
  const save=document.createElement('button');save.type='button';save.textContent='Salvar nome';
  const form=document.createElement('form');form.append(label,input,save);
  let saved='';try{saved=localStorage.getItem('vmt.sourceName')||'';}catch{}
  const suffix=Math.random().toString(36).slice(2,5).toUpperCase();input.value=saved||((navigator.maxTouchPoints>0?'Celular':'Mesa')+' '+suffix);
  const count=document.createElement('p');count.role='status';count.textContent='Conectando dispositivos…';
  const list=document.createElement('div');list.className='stage-source-list';
  const feedback=document.createElement('p');feedback.role='status';feedback.setAttribute('aria-live','polite');
  panel.append(title,description,form,count,list,feedback);if(anchor.id==='tab-live'||anchor.tagName==='MAIN')anchor.prepend(panel);else anchor.before(panel);
  let socket=null,ownId='',sources=[],limit=8;
  function send(value){if(socket?.readyState!==WebSocket.OPEN){feedback.textContent='Aguarde a reconexão para alterar as entradas.';return false;}socket.send(JSON.stringify(value));return true;}
  function render(){list.replaceChildren();count.textContent=sources.length+' de '+limit+' dispositivos conectados';for(const source of sources){const row=document.createElement('div');row.className='stage-source-row';const info=document.createElement('span');const name=document.createElement('strong');name.textContent=source.name+(source.id===ownId?' · este dispositivo':'');const status=document.createElement('small');status.textContent=source.muted?'Silenciado':source.active?'Ao vivo':'Conectado · microfone parado';info.append(name,status);const toggle=document.createElement('button');toggle.type='button';toggle.textContent=source.muted?'Liberar áudio':'Silenciar';toggle.setAttribute('aria-label',(source.muted?'Liberar áudio de ':'Silenciar ')+source.name);toggle.setAttribute('aria-pressed',String(source.muted));toggle.addEventListener('click',()=>send({type:'source_mute',sourceId:source.id,muted:!source.muted}));row.append(info,toggle);list.append(row);}}
  form.addEventListener('submit',event=>{event.preventDefault();const name=input.value.trim();if(!name)return;if(send({type:'source_hello',name})){try{localStorage.setItem('vmt.sourceName',name);}catch{}feedback.textContent='Nome enviado para o evento.';}});
  save.addEventListener('click',()=>form.requestSubmit());
  window.stageSources={
    get muted(){return sources.find(s=>s.id===ownId)?.muted===true;},
    connect(ws){socket=ws;send({type:'source_hello',name:input.value});},
    live(active){send({type:'source_live',active});},
    handle(message){if(message.type==='connected'){ownId=message.clientId;render();return false;}if(message.type==='source_roster'){if(message.selfId)ownId=message.selfId;sources=Array.isArray(message.sources)?message.sources:[];limit=message.maxSources||8;render();return true;}if(message.type==='audio_source_state'){const source=sources.find(s=>s.id===message.sourceId);if(source){source.muted=message.muted;source.active=message.active;render();}return true;}return false;}
  };
  const currentSocket=window.getStageSourceSocket?.();if(currentSocket?.readyState===WebSocket.OPEN)window.stageSources.connect(currentSocket);
})();
