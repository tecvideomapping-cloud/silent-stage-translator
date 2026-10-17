/* Admin-only offer management. Data is rendered as text, never HTML. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const base='/api/admin/commerce/upsells';
  const currency=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
  const decimal=new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2});
  const state={offers:[],products:[],productsLoaded:false,loading:false,saving:false,editing:null,trigger:null,busy:new Set()};
  const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
  function message(id,text='',error=false){const e=$(id);e.textContent=text;e.hidden=!text;e.classList.toggle('is-error',error);}
  function formError(text){message('upsellFormError',text,true);$('upsellFormError').focus();}
  async function request(path,options={}){
    let token='';try{token=localStorage.getItem('vmt_admin_token')||'';}catch{}
    if(!token)throw new Error('Entre no painel administrativo para gerenciar as ofertas.');
    const response=await fetch(path,{...options,cache:'no-store',headers:{Accept:'application/json',...options.headers,Authorization:'Bearer '+token}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){let text=typeof data.error==='string'?data.error:typeof data.message==='string'?data.message:'Não foi possível concluir a solicitação. Tente novamente.';if(response.status===401||response.status===403)text='Sua sessão expirou ou não tem permissão. Entre novamente no painel administrativo.';if(response.status===409)text='Esta oferta foi atualizada em outra sessão. Atualize as ofertas e reabra a edição para continuar.';throw new Error(text);}
    return data;
  }
  function mutation(path,method,payload){return request(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}
  function listPayload(data,key){if(Array.isArray(data))return data;if(Array.isArray(data[key]))return data[key];throw new Error('O servidor retornou uma lista inválida. Atualize e tente novamente.');}
  async function load(){
    if(state.loading)return;state.loading=true;$('refreshUpsells').disabled=true;$('upsellsPanel').setAttribute('aria-busy','true');message('upsellsFeedback');
    const results=await Promise.allSettled([request(base),request('/api/admin/commerce/products')]);
    const errors=[];let offersLoaded=false;
    if(results[0].status==='fulfilled'){try{state.offers=listPayload(results[0].value,'upsells');offersLoaded=true;}catch(err){errors.push(err.message);}}
    else errors.push(results[0].reason.message);
    if(results[1].status==='fulfilled'){try{state.products=listPayload(results[1].value,'products');state.productsLoaded=true;}catch(err){state.productsLoaded=false;errors.push(err.message);}}
    else{state.productsLoaded=false;errors.push('Produtos: '+results[1].reason.message);}
    render();
    if(errors.length){message('upsellsFeedback',errors.join(' '),true);if(!state.offers.length&&!offersLoaded){$('upsellsState').hidden=false;$('upsellsState').textContent='Não foi possível carregar as ofertas. Use “Atualizar ofertas” para tentar novamente.';}}
    state.loading=false;$('refreshUpsells').disabled=false;$('upsellsPanel').setAttribute('aria-busy','false');return errors.length===0;
  }
  function metricName(metric){return {hours:'horas de transmissão',participants:'participantes',languages:'idiomas'}[metric]||String(metric);}
  function triggerText(offer){let text='Ao atingir '+offer.thresholdPercent+'% do limite de '+metricName(offer.triggerMetric);if(offer.triggerMetric==='hours')text+=' ou restarem até '+offer.leadMinutes+' minutos';return text+'.';}
  function applicability(offer){const ids=Array.isArray(offer.eligibleProductIds)?offer.eligibleProductIds:[];if(!ids.length)return 'Todos os produtos';return ids.map(id=>state.products.find(p=>String(p.id)===String(id))?.name||String(id)).join(', ');}
  function btn(text,fn,cls=''){const b=node('button','vmt-btn '+cls,text);b.type='button';b.addEventListener('click',()=>fn(b));return b;}
  function render(){
    const list=$('upsellsList');list.replaceChildren();$('upsellsState').hidden=state.offers.length>0;
    $('upsellsState').textContent='Nenhuma oferta adicional cadastrada. Crie uma oferta com preço e benefícios definidos por você.';
    state.offers.forEach(offer=>{
      const card=node('article','upsell-card'+(offer.active?'':' is-inactive'));
      const header=node('div','upsell-card-header');header.append(node('span','upsell-status'+(offer.active?' is-active':''),offer.active?'Ativa':'Inativa'));if(offer.revision!==undefined)header.append(node('small','','Revisão '+offer.revision));
      card.append(header,node('h3','',offer.name||'Oferta sem nome'));
      const amount=Number(offer.priceCents);card.append(node('div','upsell-price',Number.isFinite(amount)?currency.format(amount/100):'Preço não informado'));
      if(offer.description)card.append(node('p','',offer.description));
      const benefits=node('div','upsell-benefits');if(Number(offer.addHours)>0)benefits.append(node('span','upsell-benefit','+'+decimal.format(offer.addHours)+' h'));if(Number(offer.addParticipants)>0)benefits.append(node('span','upsell-benefit','+'+decimal.format(offer.addParticipants)+' participantes'));if(Number(offer.addLanguages)>0)benefits.append(node('span','upsell-benefit','+'+offer.addLanguages+' idiomas'));card.append(benefits);
      const context=node('div','upsell-context');const condition=node('p');condition.append(node('strong','','Quando oferecer: '),document.createTextNode(triggerText(offer)));const eligible=node('p');eligible.append(node('strong','','Aplicável a: '),document.createTextNode(applicability(offer)));context.append(condition,eligible);card.append(context);
      if(Array.isArray(offer.features)&&offer.features.length){const ul=node('ul','upsell-perks');offer.features.forEach(feature=>ul.append(node('li','',feature)));card.append(ul);}
      const actions=node('div','upsell-card-actions');const edit=btn('Editar oferta',button=>open(offer,button));const toggle=btn(offer.active?'Desativar':'Ativar',button=>toggleOffer(offer,button),offer.active?'upsell-deactivate':'upsell-activate');edit.disabled=toggle.disabled=state.busy.has(String(offer.id));actions.append(edit,toggle);card.append(actions);list.append(card);
    });
  }
  function productChoices(selected){
    const container=$('upsellProductChoices');container.replaceChildren();const ids=new Set(selected.map(String));const products=[...state.products];
    selected.forEach(id=>{if(!products.some(p=>String(p.id)===String(id)))products.push({id,name:'Produto indisponível ('+id+')',active:false});});
    products.forEach(product=>{const label=node('label','upsell-check'),input=node('input');input.type='checkbox';input.value=String(product.id);input.checked=ids.has(String(product.id));label.append(input,node('span','',product.name+(product.active===false?' · inativo':'')));container.append(label);});
    $('upsellProductsWarning').hidden=state.productsLoaded&&products.length>0;$('upsellProductsWarning').textContent=state.productsLoaded?'Nenhum produto cadastrado. A oferta pode ser configurada para todos os produtos.':'Não foi possível atualizar os produtos. As seleções existentes foram preservadas. Feche a edição e atualize as ofertas para tentar novamente.';
    syncProducts();
  }
  function syncProducts(){const all=$('upsellAllProducts').checked;$('upsellProductChoices').classList.toggle('is-disabled',all);$('upsellProductChoices').querySelectorAll('input').forEach(input=>input.disabled=all||state.saving);}
  function syncTrigger(){const hours=$('upsellMetric').value==='hours';$('upsellLeadField').hidden=!hours;$('upsellLead').disabled=!hours||state.saving;const percent=$('upsellThreshold').value;const lead=$('upsellLead').value;$('upsellTriggerSummary').textContent=percent?triggerText({triggerMetric:$('upsellMetric').value,thresholdPercent:percent,leadMinutes:lead||'…'}):'Defina o percentual de uso para configurar o alerta.';}
  function open(offer=null,trigger=null){
    state.editing=offer;state.trigger=trigger||document.activeElement;$('upsellForm').reset();message('upsellFormError');
    $('upsellDialogTitle').textContent=offer?'Editar oferta':'Nova oferta';$('saveUpsell').textContent=offer?'Salvar alterações':'Criar oferta';
    $('upsellName').value=offer?.name||'';$('upsellDescription').value=offer?.description||'';$('upsellPrice').value=offer&&offer.priceCents!=null?(Number(offer.priceCents)/100).toFixed(2).replace('.',','):'';
    $('upsellHours').value=offer?.addHours??0;$('upsellParticipants').value=offer?.addParticipants??0;$('upsellLanguages').value=offer?.addLanguages??0;
    $('upsellMetric').value=offer?.triggerMetric||'hours';$('upsellThreshold').value=offer?.thresholdPercent??'';$('upsellLead').value=offer?.leadMinutes??0;
    $('upsellFeatures').value=Array.isArray(offer?.features)?offer.features.join('\n'):'';$('upsellActive').checked=offer?.active===true;
    const selected=Array.isArray(offer?.eligibleProductIds)?offer.eligibleProductIds:[];$('upsellAllProducts').checked=selected.length===0;productChoices(selected);syncTrigger();$('upsellDialog').showModal();
  }
  function close(){if(state.saving)return;$('upsellDialog').close();if(state.trigger&&document.contains(state.trigger))state.trigger.focus();}
  function integer(id,min,max,label){const value=$(id).value;if(value.trim()==='')throw new Error('Preencha '+label+'.');const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw new Error(label+' deve ser um número inteiro entre '+min+' e '+max+'.');return n;}
  function price(){let value=$('upsellPrice').value.trim();if(!value)throw new Error('Informe explicitamente o preço da oferta.');if(value.includes(',')){if(!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(value))throw new Error('Informe um preço válido, como 49,90.');value=value.replace(/\./g,'').replace(',','.');}else if(!/^\d+(?:\.\d{1,2})?$/.test(value))throw new Error('Informe um preço válido com até duas casas decimais.');const cents=Math.round(Number(value)*100);if(!Number.isSafeInteger(cents)||cents<100||cents>100000000)throw new Error('O preço deve estar entre R$ 1,00 e R$ 1.000.000,00.');return cents;}
  function payload(){
    const name=$('upsellName').value.trim();if(!name)throw new Error('Informe o nome da oferta.');
    const addHours=Number($('upsellHours').value);if($('upsellHours').value.trim()===''||!Number.isFinite(addHours)||addHours<0||addHours>720||!Number.isInteger(addHours*4))throw new Error('Horas extras devem estar entre 0 e 720, em intervalos de 0,25 hora.');
    const addParticipants=integer('upsellParticipants',0,100000,'Participantes extras'),addLanguages=integer('upsellLanguages',0,11,'Idiomas extras');if(!addHours&&!addParticipants&&!addLanguages)throw new Error('Adicione pelo menos um benefício: horas, participantes ou idiomas extras.');
    const triggerMetric=$('upsellMetric').value;if(!['hours','participants','languages'].includes(triggerMetric))throw new Error('Selecione o limite acompanhado.');if((triggerMetric==='hours'&&addHours<=0)||(triggerMetric==='participants'&&addParticipants<=0)||(triggerMetric==='languages'&&addLanguages<=0))throw new Error('A oferta deve ampliar o limite acompanhado: adicione '+metricName(triggerMetric)+' ou escolha outro limite para o alerta.');
    const eligibleProductIds=$('upsellAllProducts').checked?[]:[...$('upsellProductChoices').querySelectorAll('input:checked')].map(input=>input.value);if(!$('upsellAllProducts').checked&&!eligibleProductIds.length)throw new Error('Selecione ao menos um produto ou marque “Todos os produtos”.');
    const features=$('upsellFeatures').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(features.length>20||features.some(x=>x.length>200))throw new Error('Use até 20 vantagens, com no máximo 200 caracteres por linha.');
    const data={name,description:$('upsellDescription').value.trim(),priceCents:price(),active:$('upsellActive').checked,eligibleProductIds,addHours,addParticipants,addLanguages,triggerMetric,thresholdPercent:integer('upsellThreshold',1,100,'Percentual de uso'),leadMinutes:triggerMetric==='hours'?integer('upsellLead',0,1440,'Minutos restantes'):0,features};
    if(state.editing?.revision!==undefined)data.revision=state.editing.revision;return data;
  }
  function busy(saving){state.saving=saving;$('upsellForm').querySelectorAll('input,textarea,select,button').forEach(e=>e.disabled=saving);$('closeUpsell').disabled=saving;if(!saving){syncProducts();syncTrigger();}}
  async function save(event){
    event.preventDefault();if(state.saving)return;message('upsellFormError');let data;try{data=payload();}catch(err){formError(err.message);return;}
    const editing=state.editing;busy(true);
    try{await mutation(editing?base+'/'+encodeURIComponent(editing.id):base,editing?'PATCH':'POST',data);busy(false);close();const loaded=await load();if(loaded)message('upsellsFeedback',editing?'Oferta atualizada.':'Oferta criada.');}
    catch(err){formError(err.message);}finally{busy(false);}
  }
  async function toggleOffer(offer,button){
    const id=String(offer.id);if(state.busy.has(id))return;state.busy.add(id);button.disabled=true;message('upsellsFeedback');
    try{const data={active:!offer.active};if(offer.revision!==undefined)data.revision=offer.revision;await mutation(base+'/'+encodeURIComponent(offer.id),'PATCH',data);const loaded=await load();if(loaded)message('upsellsFeedback',offer.active?'Oferta desativada. Compras já realizadas foram preservadas.':'Oferta ativada.');}
    catch(err){message('upsellsFeedback',err.message,true);}finally{state.busy.delete(id);render();}
  }
  $('newUpsell').addEventListener('click',()=>open());$('refreshUpsells').addEventListener('click',load);$('closeUpsell').addEventListener('click',close);$('cancelUpsell').addEventListener('click',close);$('upsellForm').addEventListener('submit',save);
  $('upsellDialog').addEventListener('cancel',event=>{if(state.saving)event.preventDefault();});$('upsellAllProducts').addEventListener('change',syncProducts);['upsellMetric','upsellThreshold','upsellLead'].forEach(id=>$(id).addEventListener('input',syncTrigger));
  load();
})();
