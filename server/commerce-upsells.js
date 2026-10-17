const crypto = require('crypto');
const {escapeHtml} = require('./commerce-providers');
const id = () => crypto.randomUUID();
const fail = (status,message) => Object.assign(new Error(message),{status});
const stamp = () => new Date().toISOString();

// Purchased grants are derived from paid, immutable order snapshots, never live offers.
async function entitlement(event, tx = this.store) {
 const base = await tx.get('order',event.orderId);
 const plan = {...base.plan};
 for (const order of await tx.list('order',{eventId:event.id})) {
  if(order.kind!=='upsell'||order.status!=='paid'||order.customerId!==event.customerId) continue;
  plan.hours += order.grants.hours;
  if(plan.maxParticipants!==null) plan.maxParticipants += order.grants.participants;
  plan.maxLanguages = Math.min(11,plan.maxLanguages + order.grants.languages);
 }
 return plan;
}
function useful(offer,plan) {
 return (!offer.addParticipants || plan.maxParticipants!==null) && plan.maxLanguages+offer.addLanguages<=11 &&
  (offer.addHours>0 || offer.addParticipants>0&&plan.maxParticipants!==null || offer.addLanguages>0);
}
async function usageView(event,tx=this.store) {
 const base=await tx.get('order',event.orderId),plan=await this.entitlement(event,tx);
 const leases=await tx.list('connection',{eventId:event.id});
 const metric=(used,limit)=>({used,limit,remaining:limit===null?null:Math.max(0,limit-used),percent:limit===null?0:limit===0?100:Math.min(100,used/limit*100)});
 const usage={hours:metric(event.usedSeconds/3600,plan.hours),participants:metric(leases.filter(l=>l.role==='listener'&&l.expiresAt>Date.now()).length,plan.maxParticipants),languages:metric(event.target_languages.length,plan.maxLanguages)};
 const active=base.status==='paid'&&!event.revoked;
 const offers=active?(await tx.list('upsell')).filter(o=>o.active&&(!o.eligibleProductIds.length||o.eligibleProductIds.includes(base.plan.id))&&useful(o,plan)).filter(o=>{
  const m=usage[o.triggerMetric];return m.limit!==null&&(m.percent>=o.thresholdPercent||o.triggerMetric==='hours'&&m.remaining*60<=o.leadMinutes);
 }).map(o=>({...o,reason:o.triggerMetric==='hours'?'Seu tempo de transmissão está próximo do limite.':o.triggerMetric==='participants'?'O público está se aproximando da capacidade contratada.':'Você está próximo do limite de idiomas.'})):[];
 const orders=(await tx.list('order',{eventId:event.id})).filter(o=>o.kind==='upsell'&&o.customerId===event.customerId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 return {usage,offers,pendingOrders:orders.filter(o=>o.status==='pending').map(o=>this.orderView(o)),recentOrders:orders.slice(0,10).map(o=>this.orderView(o)),checkoutAvailable:active&&this.checkoutAvailable()};
}
function upsellEmail(order,customer,event,baseUrl) {
 const grants=order.grants,lines=[grants.hours?`+${grants.hours} horas de transmissão`:null,grants.participants?`+${grants.participants} participantes simultâneos`:null,grants.languages?`+${grants.languages} idiomas`:null].filter(Boolean).join(' · ');
 const url=baseUrl+'/host.html?room='+encodeURIComponent(event.id);
 const text=`Olá, ${customer.name}!\nPagamento confirmado: ${order.plan.name}.\nEvento: ${event.name}\n${lines}\nOs adicionais estão disponíveis neste evento.\nMesa de operações: ${url}\nPedido: ${order.id}`;
 return {to:customer.email,subject:'Adicionais liberados para seu evento · Videomappingtech',text,html:`<h1>Seu evento ganhou mais espaço.</h1><p>Olá, ${escapeHtml(customer.name)}. O pagamento de ${escapeHtml(order.plan.name)} foi confirmado para ${escapeHtml(event.name)}.</p><p>${escapeHtml(lines)}</p><p><a href="${escapeHtml(url)}">Abrir mesa de operações</a></p><p>Pedido ${escapeHtml(order.id)}</p>`};
}
function routes(router,{wrap,auth,csrf,requireAdmin}) {
 router.get('/customer/events/:id/usage',auth,wrap(async(req,res)=>{
  const data=await this.store.transaction(async tx=>this.usageView(await this.eventFor(req.customer.id,req.params.id,tx),tx));res.json(data);
 }));
 router.post('/customer/events/:id/upsells/checkout',auth,csrf,this.throttle('upsell-checkout',20),wrap(async(req,res)=>{
  if(!this.checkoutAvailable())throw fail(503,'A contratação online está temporariamente indisponível.');
  if(req.body?.termsAccepted!==true)throw fail(400,'Confirme o valor e os adicionais antes de continuar.');
  const key=String(req.get('Idempotency-Key')||'').slice(0,100);
  const order=await this.store.transaction(async tx=>{
   const event=await this.eventFor(req.customer.id,req.params.id,tx),base=await tx.get('order',event.orderId);
   if(base.status!=='paid'||event.revoked)throw fail(409,'O pagamento do evento não está ativo.');
   const offer=await tx.get('upsell',String(req.body.offerId||''));
   if(!offer||!offer.active||offer.eligibleProductIds.length&&!offer.eligibleProductIds.includes(base.plan.id))throw fail(409,'Esta oferta não está disponível para este evento.');
   if(req.body.offerVersion!==offer.revision)throw fail(409,'Esta oferta foi atualizada. Confira as condições novamente.');
   const orders=await tx.list('order',{customerId:req.customer.id});
   const existing=orders.find(o=>key&&o.requestKey===key)||orders.find(o=>o.kind==='upsell'&&o.eventId===event.id&&o.plan.id===offer.id&&o.status==='pending');
   if(existing){
    if(existing.kind!=='upsell'||existing.eventId!==event.id||existing.plan.id!==offer.id)throw fail(409,'Esta tentativa pertence a outro pedido.');
    if(existing.status!=='pending')throw fail(409,'Este pedido já foi processado. Consulte seu saldo.');
    if(existing.plan.revision!==offer.revision)throw fail(409,'Existe um pedido pendente com outras condições. Confira o valor na opção Continuar pagamento.');
    if(existing.checkoutUrl)return existing;
    if(existing.checkoutLease>Date.now())throw fail(409,'Seu pagamento está sendo preparado. Aguarde alguns segundos.');
    existing.checkoutLease=Date.now()+30000;await tx.put('order',existing.id,existing);return existing;
   }
   const reserved=await this.entitlement(event,tx);
   for(const pending of orders)if(pending.kind==='upsell'&&pending.eventId===event.id&&['pending','expired'].includes(pending.status))reserved.maxLanguages+=pending.grants.languages;
   if(!useful(offer,reserved))throw fail(409,'Os adicionais desta oferta não se aplicam aos limites atuais do evento.');
   const order={id:id(),kind:'upsell',customerId:req.customer.id,eventId:event.id,baseOrderId:base.id,eventName:event.name,plan:structuredClone(offer),grants:{hours:offer.addHours,participants:offer.addParticipants,languages:offer.addLanguages},amountCents:offer.priceCents,currency:'BRL',status:'pending',createdAt:stamp(),termsAcceptedAt:stamp(),requestKey:key||id(),checkoutLease:Date.now()+30000};
   await tx.put('order',order.id,order);return order;
  });
  if(order.checkoutUrl)return res.json({order:this.orderView(order),checkoutUrl:order.checkoutUrl});
  try{
   const checkout=await this.provider.createCheckout(order,req.customer,this.baseUrl());
   await this.store.transaction(async tx=>{const current=await tx.get('order',order.id);current.preferenceId=checkout.id;current.checkoutUrl=checkout.url;current.checkoutLease=0;await tx.put('order',current.id,current);});
   res.status(201).json({order:this.orderView(order),checkoutUrl:checkout.url});
  }catch(error){await this.store.transaction(async tx=>{const current=await tx.get('order',order.id);current.checkoutLease=0;await tx.put('order',current.id,current);});throw fail(502,'Não foi possível preparar o pagamento. Tente novamente.');}
 }));
 if(!requireAdmin)return;
 router.get('/admin/commerce/upsells',requireAdmin,wrap(async(req,res)=>{await this.readyOrFail();res.json({upsells:await this.store.list('upsell')});}));
 const save=wrap(async(req,res)=>{
  await this.readyOrFail();const body=req.body||{},key=req.params.id||body.id||'extra-'+crypto.randomBytes(4).toString('hex');
  if(!/^[a-z0-9][a-z0-9-]{1,49}$/.test(key))throw fail(400,'Identificador de oferta inválido.');
  const upsell=await this.store.transaction(async tx=>{
   const previous=await tx.get('upsell',key);
   if(req.method==='PATCH'&&!previous)throw fail(404,'Oferta não encontrada.');
   if(req.method==='POST'&&previous)throw fail(409,'Já existe uma oferta com este identificador.');
   if(previous&&body.revision&&body.revision!==previous.revision)throw fail(409,'A oferta foi alterada. Recarregue antes de editar.');
   const allowed=['name','description','priceCents','active','eligibleProductIds','addHours','addParticipants','addLanguages','triggerMetric','thresholdPercent','leadMinutes','features'];
   const p={active:true,eligibleProductIds:[],addHours:0,addParticipants:0,addLanguages:0,triggerMetric:'hours',thresholdPercent:80,leadMinutes:30,features:[],...previous,...Object.fromEntries(allowed.filter(k=>body[k]!==undefined).map(k=>[k,body[k]])),id:key,currency:'BRL',createdAt:previous?.createdAt||stamp(),updatedAt:stamp(),revision:id()};
   if(typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.description!=='string'||p.description.length>500||!Number.isInteger(p.priceCents)||p.priceCents<100||p.priceCents>100000000||typeof p.active!=='boolean'||!Number.isFinite(p.addHours)||p.addHours<0||p.addHours>720||p.addHours*4%1!==0||!Number.isInteger(p.addParticipants)||p.addParticipants<0||p.addParticipants>100000||!Number.isInteger(p.addLanguages)||p.addLanguages<0||p.addLanguages>11||!(p.addHours||p.addParticipants||p.addLanguages)||!['hours','participants','languages'].includes(p.triggerMetric)||!Number.isInteger(p.thresholdPercent)||p.thresholdPercent<1||p.thresholdPercent>100||!Number.isInteger(p.leadMinutes)||p.leadMinutes<0||p.leadMinutes>1440||!Array.isArray(p.features)||p.features.length>20||p.features.some(f=>typeof f!=='string'||!f.trim()||f.length>200)||!Array.isArray(p.eligibleProductIds)||p.eligibleProductIds.length>30||p.eligibleProductIds.some(v=>typeof v!=='string'))throw fail(400,'Confira preço, benefícios, limites e antecedência do alerta.');
   // A trigger must be relieved by this offer, otherwise it would sell an unrelated resource.
   if(!({hours:p.addHours,participants:p.addParticipants,languages:p.addLanguages})[p.triggerMetric])throw fail(400,'O adicional precisa ampliar o limite usado para exibir a oferta.');
   for(const productId of p.eligibleProductIds)if(!await tx.get('product',productId))throw fail(400,'Escolha serviços existentes.');
   if(!previous&&(await tx.list('upsell')).length>=60)throw fail(409,'Limite de 60 ofertas atingido.');
   p.name=p.name.trim();p.features=p.features.map(f=>f.trim());p.eligibleProductIds=[...new Set(p.eligibleProductIds)];await tx.put('upsell',key,p);return p;
  });res.status(req.method==='POST'?201:200).json({upsell});
 });
 router.post('/admin/commerce/upsells',requireAdmin,save);router.patch('/admin/commerce/upsells/:id',requireAdmin,save);
}
module.exports={entitlement,usageView,routes,upsellEmail};
