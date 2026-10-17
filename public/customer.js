'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = { customer:null, csrfToken:'', events:[], orders:[], mode:'login', selected:null, assets:{}, uploads:0, refreshing:false, saving:false };
  const params = new URLSearchParams(location.search);
  let resetToken = params.get('reset') || '';
  const returnOrder = params.get('order');
  const authFields = $('authForm').elements;
  const editorFields = $('eventForm').elements;
  const safeUrl = value => { if (!value) return ''; try { const u=new URL(String(value), location.origin); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const el = (tag, cls, text) => { const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=String(text); return n; };
  function feedback(id, message='', type='') { const n=$(id); n.textContent=message; n.className='feedback'+(type?' '+type:''); n.hidden=!message; }
  function pageStatus(text='') { $('pageStatus').textContent=text; $('pageStatus').hidden=!text; }
  function action(text, fn, primary=false) { const b=el('button','vmt-btn'+(primary?' vmt-primary':''),text); b.type='button'; b.addEventListener('click', fn); return b; }
  function link(text, url, cls='vmt-btn') { const href=safeUrl(url); if(!href)return null; const a=el('a',cls,text); a.href=href; a.target='_blank'; a.rel='noopener noreferrer'; return a; }
  function append(parent, ...nodes) { nodes.filter(Boolean).forEach(n=>parent.append(n)); return parent; }
  function showTab(tab) { const events=tab==='events'; $('eventsSection').hidden=!events; $('ordersSection').hidden=events; $('eventsTab').setAttribute('aria-pressed',String(events)); $('ordersTab').setAttribute('aria-pressed',String(!events)); }
  function unauthorized() { state.customer=null; state.csrfToken=''; state.events=[]; state.orders=[]; state.selected=null; $('eventsList').replaceChildren(); $('ordersList').replaceChildren(); if($('eventDialog').open)$('eventDialog').close(); if($('qrDialog').open)$('qrDialog').close(); $('dashboardSection').hidden=true; $('logoutButton').hidden=true; $('authSection').hidden=false; setMode('login'); }
  async function api(path, { method='GET', data, headers={}, raw, quietAuth=false }={}) {
    const mutation=method!=='GET';
    const init={method,credentials:'same-origin',headers:{'Accept':'application/json',...headers}};
    if(mutation && !/^\/(login|register|forgot-password|reset-password)$/.test(path))init.headers['X-CSRF-Token']=state.csrfToken;
    if(raw!==undefined)init.body=raw;
    else if(data!==undefined){ init.headers['Content-Type']='application/json'; init.body=JSON.stringify(data); }
    const response=await fetch('/api/customer'+path,init);
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){ if(response.status===401 && !quietAuth && state.customer){unauthorized();feedback('authFeedback','Sua sessão expirou. Entre novamente para continuar.','error');} const err=new Error(typeof payload.error==='string'?payload.error:typeof payload.message==='string'?payload.message:'Não foi possível concluir. Tente novamente.'); err.status=response.status; throw err; }
    return payload;
  }
  function setMode(mode) {
    state.mode=mode;
    const register=mode==='register', forgot=mode==='forgot', reset=mode==='reset';
    $('authTabs').hidden=forgot||reset;
    document.querySelectorAll('[data-auth-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.authMode===mode)));
    ['name','company','phone'].forEach(name=>{ $(name+'Field').hidden=!register; authFields[name].disabled=!register; });
    authFields.name.required=register;
    $('emailField').hidden=reset;authFields.email.disabled=reset;
    $('passwordField').hidden=forgot;authFields.password.disabled=forgot;
    authFields.password.autocomplete=register||reset?'new-password':'current-password';
    authFields.password.minLength=register||reset?10:1;
    $('passwordHint').hidden=!(register||reset);
    $('authTitle').textContent=register?'Sua próxima conexão começa aqui.':forgot?'Vamos recuperar seu acesso.':reset?'Uma nova senha, um novo começo.':'Que bom ter você aqui.';
    $('authDescription').textContent=register?'Crie sua conta para contratar e personalizar seus eventos.':forgot?'Informe seu e-mail para receber as instruções.':reset?'Escolha uma senha com pelo menos 10 caracteres.':'Entre para cuidar dos seus eventos.';
    $('authSubmit').textContent=register?'Criar minha conta':forgot?'Enviar instruções':reset?'Salvar nova senha':'Entrar na minha conta';
    $('forgotButton').hidden=mode!=='login';$('backLoginButton').hidden=!(forgot||reset);feedback('authFeedback');
  }
  async function authenticate(event) {
    event.preventDefault(); const b=$('authSubmit');b.disabled=true;feedback('authFeedback');
    const mode=state.mode;
    try {
      if(mode==='forgot'){ await api('/forgot-password',{method:'POST',data:{email:authFields.email.value.trim()},quietAuth:true});feedback('authFeedback','Se este e-mail estiver cadastrado, você receberá as instruções de recuperação.','success'); }
      else if(mode==='reset'){ await api('/reset-password',{method:'POST',data:{token:resetToken,password:authFields.password.value},quietAuth:true});resetToken='';params.delete('reset');history.replaceState(null,'',location.pathname+(params.size?'?'+params.toString():''));authFields.password.value='';setMode('login');feedback('authFeedback','Senha atualizada. Entre com sua nova senha.','success'); }
      else {
        const data={email:authFields.email.value.trim(),password:authFields.password.value};
        if(mode==='register')Object.assign(data,{name:authFields.name.value.trim(),company:authFields.company.value.trim(),phone:authFields.phone.value.trim()});
        const session=await api('/'+mode,{method:'POST',data,quietAuth:true});state.customer=session.customer;state.csrfToken=session.csrfToken||'';authFields.password.value='';await openDashboard();
      }
    }catch(err){feedback('authFeedback',err.message,'error');}finally{b.disabled=false;}
  }
  async function openDashboard() {
    $('authSection').hidden=true;$('dashboardSection').hidden=false;$('logoutButton').hidden=false;pageStatus();
    $('customerGreeting').textContent=state.customer?.name?'Bem-vindo(a), '+state.customer.name+'. Seu próximo encontro começa aqui.':'Seu próximo encontro começa aqui.';
    if(returnOrder){showTab('orders');feedback('dashboardFeedback','Confira abaixo a atualização do seu pedido. A confirmação do pagamento pode levar alguns instantes.');}
    await refresh();
  }
  async function refresh() {
    if(state.refreshing)return;state.refreshing=true;$('refreshButton').disabled=true;
    const results=await Promise.allSettled([api('/events'),api('/orders')]);
    if(!state.customer){state.refreshing=false;$('refreshButton').disabled=false;return;}
    const errors=[];
    if(results[0].status==='fulfilled'){state.events=Array.isArray(results[0].value.events)?results[0].value.events:[];renderEvents();}else errors.push('Eventos: '+results[0].reason.message);
    if(results[1].status==='fulfilled'){state.orders=Array.isArray(results[1].value.orders)?results[1].value.orders:[];renderOrders();}else errors.push('Pedidos: '+results[1].reason.message);
    if(errors.length)feedback('dashboardFeedback',errors.join(' '),'error');else if(!returnOrder)feedback('dashboardFeedback');
    state.refreshing=false;$('refreshButton').disabled=false;
  }
  function empty(title, description, cta=false) {const box=el('div','customer-empty');append(box,el('h3','',title),el('p','',description));if(cta){const a=el('a','vmt-btn vmt-primary','Conhecer os planos');a.href='/landing.html#planos';box.append(a);}return box;}
  const numeric=value=>Number.isFinite(Number(value))?Math.max(0,Number(value)):0;
  function hoursLabel(seconds){const mins=Math.ceil(numeric(seconds)/60);return Math.floor(mins/60)+'h '+String(mins%60).padStart(2,'0')+'min';}
  function limitLabel(value){return value===null||value===undefined?'Não informado':String(value);}
  function renderEvents() {
    const list=$('eventsList');list.replaceChildren();$('eventCount').textContent=state.events.length+' evento'+(state.events.length===1?'':'s');
    if(!state.events.length){list.append(empty('Sua próxima experiência vem aí.','Após a confirmação do pagamento, seu evento aparecerá aqui para você personalizar e compartilhar.',true));return;}
    state.events.forEach(event=>{
      const card=el('article','customer-event vmt-glass');const cover=el('div','event-cover');const banner=safeUrl(event.banner_url);
      if(banner){cover.classList.add('has-banner');cover.style.backgroundImage='linear-gradient(0deg,rgba(15,12,30,.8),rgba(15,12,30,.12)),url('+JSON.stringify(banner)+')';}
      const top=el('div','cover-meta');top.append(el('span','cover-label','SILENT TRANSLATOR'));const logo=safeUrl(event.logo_url);if(logo){const img=el('img','event-logo');img.src=logo;img.alt='Logo de '+event.name;img.loading='lazy';img.addEventListener('error',()=>img.hidden=true);top.append(img);}append(cover,top,el('h3','',event.name||'Evento'));
      const content=el('div','event-content'),meta=el('div','event-meta-row');append(meta,el('span','event-plan',event.plan?.name||'Plano do evento'),el('span','customer-badge'+(event.published?' live':''),event.published?'Publicado':'Não publicado'));
      const balance=el('div','event-balance'),remaining=el('div');append(remaining,el('strong','balance-number',hoursLabel(event.remainingSeconds)),el('span','balance-label','de transmissão restantes'));
      const limits=el('div','event-limits');append(limits,el('div','',limitLabel(event.plan?.hours)+' horas contratadas'),el('div','',event.plan?.maxParticipants==null?'Participantes ilimitados':'Até '+limitLabel(event.plan.maxParticipants)+' participantes'),el('div','','Até '+limitLabel(event.plan?.maxLanguages)+' idiomas'));append(balance,remaining,limits);
      append(content,meta,balance);
      if(event.status){const status=el('p','event-note','Situação: '+statusName(event.status));content.append(status);}
      const edit=action('Personalizar evento',()=>openEditor(event),true);edit.disabled=['refunded','charged_back'].includes(event.status);const actions=el('div','event-actions');actions.append(edit);content.append(actions);
      const participantUrl=safeUrl(event.participantUrl);
      if(participantUrl){const box=el('div','participant-box');const label=el('label','','Link dos participantes');const input=el('input');input.value=participantUrl;input.readOnly=true;input.setAttribute('aria-label','Link dos participantes de '+event.name);input.addEventListener('focus',()=>input.select());label.append(input);box.append(label);const controls=el('div','participant-controls');append(controls,action('Copiar link',()=>copy(participantUrl)),action('QR code',()=>openQr(event)),link('Abrir sala',participantUrl));box.append(controls);content.append(box);}
      const footer=el('div','event-footer'),tools=el('div','event-actions');append(tools,
        link('Painel do transmissor',event.hostUrl),
        link('Abrir projeção',event.screenUrl),
        link('📄 Ata (.TXT)', `/api/rooms/${encodeURIComponent(event.id)}/export?format=txt`),
        link('🎬 Legendas (.SRT)', `/api/rooms/${encodeURIComponent(event.id)}/export?format=srt`)
      );const publish=action(event.published?'Despublicar':'Publicar evento',()=>publishEvent(event,publish));publish.classList.add('publish-button');publish.disabled=['expired','refunded','charged_back'].includes(event.status);append(footer,tools,publish);content.append(footer);
      if(!event.published)content.append(el('p','event-note','Publique quando a identidade e os idiomas estiverem prontos para seus participantes.'));
      append(card,cover,content);list.append(card);
    });
  }
  const statusNames={created:'Aguardando pagamento',pending:'Aguardando pagamento',paid:'Pagamento confirmado',approved:'Pagamento confirmado',completed:'Concluído',cancelled:'Cancelado',canceled:'Cancelado',expired:'Expirado',failed:'Não concluído',processing:'Em processamento',active:'Ativo',draft:'Rascunho',published:'Publicado',pending_payment:'Aguardando pagamento',refunded:'Reembolsado',charged_back:'Pagamento contestado',rejected:'Pagamento não aprovado'};
  function statusName(status){return statusNames[String(status).toLowerCase()]||String(status);}
  function renderOrders(){
    const list=$('ordersList');list.replaceChildren();if(!state.orders.length){list.append(empty('Seu primeiro evento está a um passo.','Seus pedidos e confirmações de pagamento aparecerão aqui.',true));return;}
    state.orders.forEach(order=>{
      const card=el('article','customer-order vmt-glass'),info=el('div');append(info,el('h3','',order.planName||'Plano de evento'),el('p','','Pedido '+order.id));const date=new Date(order.createdAt);if(!Number.isNaN(date.getTime()))info.append(el('p','',date.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})));
      const financial=el('div');const amount=Number(order.amountCents);if(Number.isFinite(amount))financial.append(el('div','order-amount',new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(amount/100)));financial.append(el('span','customer-badge',statusName(order.status)));
      if(order.emailStatus){const messages={sent:'Confirmação enviada por e-mail',pending:'E-mail de confirmação em processamento',failed:'Não foi possível enviar a confirmação por e-mail',delivered:'Confirmação entregue por e-mail',not_sent:'Acesso ainda não enviado por e-mail',queued:'E-mail de confirmação em processamento'};info.append(el('p','',messages[order.emailStatus]||'E-mail: '+order.emailStatus));}
      const actions=el('div','order-actions');const pending=['pending','pending_payment','processing','created'].includes(String(order.status).toLowerCase());if(pending)append(actions,link('Continuar pagamento',order.checkoutUrl));
      if(order.eventId){const button=action('Ver meu evento',()=>{showTab('events');const event=state.events.find(x=>String(x.id)===String(order.eventId));if(event)openEditor(event);else feedback('dashboardFeedback','Seu evento ainda está sendo preparado. Atualize em alguns instantes.');});actions.append(button);}
      if(returnOrder && String(order.id)===returnOrder){card.style.borderColor='var(--vmt-accent)';info.prepend(el('span','customer-badge','Seu pedido'))}
      append(card,info,financial,actions);list.append(card);
    });
  }
  function openEditor(event){
    state.selected=event;state.assets={logoUrl:event.logo_url||'',bannerUrl:event.banner_url||''};
    $('eventForm').reset();editorFields.name.value=event.name||'';
    for(const [name,key,fallback] of [['primaryColor','primary_color','#b3a0ff'],['secondaryColor','secondary_color','#83e5bd'],['bgColor','bg_color','#10111c']])editorFields[name].value=/^#[0-9a-f]{6}$/i.test(event[key]||'')?event[key]:fallback;
    const source=event.source_language||'pt-BR';const select=editorFields.sourceLanguage;if(![...select.options].some(x=>x.value===source)){const option=el('option','',source);option.value=source;select.append(option);}select.value=source;
    editorFields.targetLanguages.value=Array.isArray(event.target_languages)?event.target_languages.join(', '):'';$('languageLimit').textContent='Códigos separados por vírgula (ex.: en, es). Limite: '+limitLabel(event.plan?.maxLanguages)+' idiomas.';
    preview('logo',state.assets.logoUrl);preview('banner',state.assets.bannerUrl);feedback('editorFeedback');$('eventDialog').showModal();
  }
  function preview(kind,url){const img=$(kind+'Preview'),safe=safeUrl(url);img.hidden=!safe;if(safe){img.src=safe;img.onerror=()=>{img.hidden=true;};}else img.removeAttribute('src');}
  function editorBusy(){const busy=state.uploads>0||state.saving;$('saveEvent').disabled=busy;$('closeEditor').disabled=busy;$('cancelEditor').disabled=busy;['logo','banner'].forEach(kind=>{$(kind+'Upload').disabled=busy;$('remove'+kind[0].toUpperCase()+kind.slice(1)).disabled=busy;});}
  async function upload(kind,input){
    const file=input.files[0];if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){feedback('editorFeedback','Envie uma imagem PNG, JPG ou WebP.','error');input.value='';return;}
    if(file.size>5*1024*1024){feedback('editorFeedback','A imagem deve ter no máximo 5 MB.','error');input.value='';return;}
    state.uploads++;editorBusy();input.disabled=true;feedback('editorFeedback','Enviando '+(kind==='logo'?'logo':'banner')+'…');
    try{const data=await api('/events/'+encodeURIComponent(state.selected.id)+'/assets',{method:'POST',raw:file,headers:{'Content-Type':file.type,'X-Asset-Kind':kind}});if(!safeUrl(data.url))throw new Error('O envio não retornou uma imagem válida. Tente novamente.');state.assets[kind+'Url']=data.url;preview(kind,data.url);feedback('editorFeedback','Imagem enviada. Salve a personalização para aplicar.','success');}
    catch(err){feedback('editorFeedback',err.message,'error');}finally{state.uploads--;editorBusy();input.disabled=false;input.value='';}
  }
  async function saveEvent(event){
    event.preventDefault();if(!state.selected||state.uploads||state.saving)return;
    const targetLanguages=[...new Set(editorFields.targetLanguages.value.split(',').map(x=>x.trim()).filter(Boolean))];
    if(targetLanguages.some(x=>!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(x))){feedback('editorFeedback','Use códigos de idioma válidos separados por vírgula, como en, es ou pt-BR.','error');return;}
    const max=Number(state.selected.plan?.maxLanguages);if(state.selected.plan?.maxLanguages!=null&&Number.isFinite(max)&&max>=0&&targetLanguages.length>max){feedback('editorFeedback','Seu plano permite até '+max+' idiomas de tradução.','error');return;}
    const name=editorFields.name.value.trim();if(!name){feedback('editorFeedback','Informe o nome do evento.','error');return;}
    const eventId=state.selected.id; state.saving=true; editorBusy(); const button=$('saveEvent');feedback('editorFeedback','Salvando sua personalização…');
    try{const result=await api('/events/'+encodeURIComponent(eventId),{method:'PATCH',data:{name,primaryColor:editorFields.primaryColor.value,secondaryColor:editorFields.secondaryColor.value,bgColor:editorFields.bgColor.value,logoUrl:state.assets.logoUrl,bannerUrl:state.assets.bannerUrl,sourceLanguage:editorFields.sourceLanguage.value,targetLanguages}});if(result.event){const index=state.events.findIndex(x=>x.id===eventId);if(index!==-1)state.events[index]={...state.events[index],...result.event};renderEvents();}else await refresh();$('eventDialog').close();feedback('dashboardFeedback','Personalização salva. Seu evento está com a sua identidade.','success');}
    catch(err){feedback('editorFeedback',err.message,'error');}finally{state.saving=false;editorBusy();}
  }
  async function publishEvent(event,button){
    button.disabled=true;feedback('dashboardFeedback');
    try{const result=await api('/events/'+encodeURIComponent(event.id)+'/publish',{method:'POST',data:{published:!event.published}});if(result.event){const index=state.events.findIndex(x=>x.id===event.id);if(index!==-1)state.events[index]={...state.events[index],...result.event};renderEvents();}else await refresh();feedback('dashboardFeedback',event.published?'Evento despublicado.':'Evento publicado. Compartilhe o acesso com seus participantes.','success');}
    catch(err){feedback('dashboardFeedback',err.message,'error');}finally{button.disabled=false;}
  }
  async function copy(value){try{await navigator.clipboard.writeText(value);feedback('dashboardFeedback','Link dos participantes copiado.','success');}catch{feedback('dashboardFeedback','Não foi possível copiar automaticamente. Selecione o link do evento e copie pelo seu dispositivo.','error');}}
  function openQr(event){
    const url=safeUrl(event.participantUrl);if(!url)return;
    $('qrEventName').textContent=event.name||'Evento';feedback('qrFeedback');
    const src='/api/qr?text='+encodeURIComponent(url);
    $('qrImage').hidden=false;$('qrDownload').hidden=false;
    $('qrImage').onerror=()=>{$('qrImage').hidden=true;$('qrDownload').hidden=true;feedback('qrFeedback','Não foi possível carregar o QR code. Tente novamente.','error');};
    $('qrImage').src=src;$('qrDownload').href=src;

    let printBtn = document.getElementById('qrPrintPlacardBtn');
    if(!printBtn){
      printBtn = document.createElement('button');
      printBtn.id = 'qrPrintPlacardBtn';
      printBtn.className = 'vmt-btn';
      printBtn.type = 'button';
      printBtn.textContent = 'Imprimir Placa de Mesa';
      $('qrDownload').after(printBtn);
    }
    printBtn.onclick = () => {
      const w = window.open('','_blank');
      if(w){
        w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Placa de Mesa - ${event.name}</title><style>body{font-family:sans-serif;text-align:center;padding:40px;margin:0;background:#fff;color:#111}.card{border:2px solid #222;border-radius:20px;padding:40px;max-width:480px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,.1)}h1{font-size:26px;margin:0 0 10px}h2{font-size:16px;font-weight:400;color:#555;margin:0 0 25px}img{width:220px;height:220px;margin:0 auto 20px;display:block}.inst{font-size:18px;font-weight:700;margin-bottom:8px}.url{font-family:monospace;font-size:14px;color:#333;word-break:break-all}.ft{margin-top:30px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px}</style></head><body><div class="card"><h1>${event.name || 'Palestra ao Vivo'}</h1><h2>Aponte a câmera do seu celular para ouvir a tradução ao vivo</h2><img src="${src}"><div class="inst">Tradução & Legendas no Celular</div><div class="url">${url}</div><div class="ft">Videomappingtech · Silent Stage AI</div></div><script>window.onload=function(){window.print();}</script></body></html>`);
        w.document.close();
      }
    };

    $('qrDialog').showModal();
  }
  function closeEditor(){if(!state.uploads&&!state.saving)$('eventDialog').close();}
  document.querySelectorAll('[data-auth-mode]').forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.authMode)));
  $('authForm').addEventListener('submit',authenticate);$('forgotButton').addEventListener('click',()=>setMode('forgot'));$('backLoginButton').addEventListener('click',()=>setMode('login'));
  $('eventsTab').addEventListener('click',()=>showTab('events'));$('ordersTab').addEventListener('click',()=>showTab('orders'));$('refreshButton').addEventListener('click',refresh);
  $('logoutButton').addEventListener('click',async()=>{const button=$('logoutButton');button.disabled=true;try{await api('/logout',{method:'POST',data:{}});unauthorized();feedback('authFeedback','Você saiu da sua conta.','success');}catch(err){feedback('dashboardFeedback',err.message,'error');}finally{button.disabled=false;}});
  $('closeEditor').addEventListener('click',closeEditor);$('cancelEditor').addEventListener('click',closeEditor);$('eventDialog').addEventListener('cancel',event=>{if(state.uploads||state.saving)event.preventDefault();});$('eventForm').addEventListener('submit',saveEvent);
  ['logo','banner'].forEach(kind=>{$(kind+'Upload').addEventListener('change',event=>upload(kind,event.target));$('remove'+kind[0].toUpperCase()+kind.slice(1)).addEventListener('click',()=>{state.assets[kind+'Url']='';preview(kind,'');feedback('editorFeedback','Salve a personalização para aplicar a remoção.');});});
  $('closeQr').addEventListener('click',()=>$('qrDialog').close());
  async function init(){
    if(resetToken){pageStatus();$('authSection').hidden=false;setMode('reset');return;}
    try{const session=await api('/me',{quietAuth:true});if(!session.customer){unauthorized();pageStatus();return;}state.customer=session.customer;state.csrfToken=session.csrfToken||'';await openDashboard();}
    catch(err){pageStatus();unauthorized();if(err.status!==401)feedback('authFeedback','Não foi possível verificar seu acesso. '+err.message,'error');}
  }
  init();
})();
