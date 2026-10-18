// This module is inert in browsers: recognition is a native desktop capability.
(() => {
  const bridge=window.desktopHost?.speech;if(!bridge)return;
  let active=false,wanted=false,inFlight=false,sendTranscript=null,language='pt',carry=[],phase=0,lastSample=0,hasLast=false;
  let selected={model:'base',diarization:false};
  let panel,status,button,model,diarization;
  const setStatus=text=>{if(status)status.textContent=text;};
  function publishState(value){active=value.state==='ready';inFlight=value.state==='loading';setStatus(value.message||({stopped:'Modo atual selecionado.',ready:'Motor local pronto.'}[value.state])||value.state);if(button)button.textContent=(active||inFlight)?'Usar modo atual':'Ativar motor local';if(model)model.disabled=active||inFlight;if(diarization)diarization.disabled=active||inFlight;window.dispatchEvent(new CustomEvent('vmt-local-speech-state',{detail:{active,loading:inFlight}}));}
  bridge.onEvent(event=>{
    if(event.kind==='status')publishState(event.data);
    else if(event.kind==='transcript'&&active&&wanted&&sendTranscript)sendTranscript(event.data);
    else if(event.kind==='metrics')setStatus(`Motor local · processamento ${(event.data.processingMs/1000).toFixed(1)}s · ${event.data.pending} trecho(s) na fila`);
  });
  window.localSpeech={
    get active(){return active;},get selected(){return active||inFlight;},
    async begin(send,sourceLanguage){sendTranscript=send;const previousLanguage=language;language=String(sourceLanguage||'pt').split('-')[0];wanted=true;carry=[];phase=0;hasLast=false;if((active||inFlight)&&previousLanguage!==language){await bridge.stop();await bridge.start({...selected,language});}},
    end(){wanted=false;sendTranscript=null;carry=[];phase=0;hasLast=false;if(active||inFlight)bridge.stop().catch(()=>{});},
    feed(samples,rate){
      if(!active||!wanted||!Number.isFinite(rate)||rate<8000)return;
      // Stateful linear resampling: fractional position survives audio blocks.
      const step=rate/16000;
      const input=hasLast?[lastSample,...samples]:samples;
      while(phase<input.length-1){const left=Math.floor(phase),weight=phase-left;const value=input[left]*(1-weight)+input[left+1]*weight;carry.push(Math.round(Math.max(-1,Math.min(1,value))*32767));phase+=step;}
      phase-=input.length-1;lastSample=input[input.length-1];hasLast=true;
      while(carry.length>=3200){bridge.audio(new Int16Array(carry.splice(0,3200)).buffer);}
    }
  };
  document.addEventListener('DOMContentLoaded',()=>{
    panel=document.createElement('section');panel.className='vmt-local-speech';panel.setAttribute('aria-label','Reconhecimento local');
    panel.innerHTML='<div><strong>Reconhecimento no computador</strong><p>Transcrição local; tradução e voz continuam usando o serviço atual.</p></div><div class="vmt-local-controls"><label>Modelo <select><option value="tiny">Leve · Tiny</option><option value="base" selected>Equilibrado · Base</option><option value="small">Precisão · Small</option></select></label><label><input type="checkbox"> Separar locutores (Pyannote)</label><button type="button">Ativar motor local</button></div><p role="status" aria-live="polite">Modo atual selecionado. A primeira ativação baixa o modelo de transcrição.</p>';
    const container=document.querySelector('main')||document.body;container.prepend(panel);
    status=panel.querySelector('[role="status"]');button=panel.querySelector('button');model=panel.querySelector('select');diarization=panel.querySelector('input');
    button.addEventListener('click',async()=>{button.disabled=true;try{if(active||inFlight){await bridge.stop();}else{selected={model:model.value,diarization:diarization.checked};await bridge.start({...selected,language});}}catch{setStatus('Não foi possível iniciar o motor. Confira a instalação local.');}finally{button.disabled=false;}});
    bridge.status().then(publishState).catch(()=>setStatus('Motor local indisponível nesta instalação.'));
  });
  window.addEventListener('beforeunload',()=>{wanted=false;bridge.stop().catch(()=>{});});
})();
