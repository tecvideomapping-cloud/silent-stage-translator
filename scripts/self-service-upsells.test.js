const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {Commerce}=require('../server/commerce');
const {CommerceStore}=require('../server/commerce-store');
const {MercadoPagoProvider}=require('../server/commerce-providers');

// Contract tests use the real router, ledger and payment processor. Only the
// external checkout provider and mail transport are replaced with local adapters.
async function fixture(t,{event=true}={}) {
 const env={APP_BASE_URL:'https://upsells.example.test',MERCADOPAGO_ACCESS_TOKEN:'test-only',MERCADOPAGO_WEBHOOK_SECRET:'test-secret',MERCADOPAGO_SANDBOX:'false'};
 const store=new CommerceStore({memory:true});store.persistent=true;
 const provider=new MercadoPagoProvider(env);
 provider.createCheckout=async order=>({id:'preference-'+order.id,url:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id='+order.id});
 const commerce=new Commerce({store,provider,mailer:{configured:true,send:async()=>({id:'test-mail'})},env});await commerce.ready;
 const app=express();app.use(express.json());app.use('/api',commerce.router((req,res,next)=>req.get('Authorization')==='Bearer test-admin'?next():res.status(403).json({error:'Sem acesso'})));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{commerce.stopWorkers();await new Promise(r=>server.close(r));});
 const call=async(path,{method='GET',body,cookie,csrf,headers={}}={})=>{
  const response=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const type=response.headers.get('content-type')||'';
  return {status:response.status,data:type.includes('json')?await response.json():await response.text(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 const admin=(path,options={})=>call('/admin/commerce'+path,{...options,headers:{Authorization:'Bearer test-admin',...options.headers}});
 const register=async email=>{const r=await call('/customer/register',{method:'POST',body:{name:'Responsável pelo evento',email,password:'Senha-Forte-2026'}});assert.equal(r.status,201,JSON.stringify(r.data));return {cookie:r.cookie,csrf:r.data.csrfToken};};
 const owner=await register('owner@example.test'),other=await register('other@example.test');
 const f={commerce,store,provider,call,admin,owner,other,sequence:0};
 f.pay=async(order,status='approved',id='pay-'+order.id)=>commerce.processPayment({id,external_reference:order.id,transaction_amount:order.amountCents/100,currency_id:'BRL',live_mode:true,status,date_last_updated:new Date(Date.now()+ ++f.sequence*10000).toISOString()});
 f.offer=async(overrides={})=>{
  const body={id:'extra-'+(++f.sequence),name:'Amplie seu evento',description:'Créditos adicionais para este evento',priceCents:25000,active:true,eligibleProductIds:['upsell-fixture'],addHours:1,addParticipants:2,addLanguages:1,triggerMetric:'hours',thresholdPercent:75,leadMinutes:0,features:['Mais capacidade no mesmo evento'],...overrides};
  const r=await admin('/upsells',{method:'POST',body});assert.equal(r.status,201,JSON.stringify(r.data));assert.ok(r.data.upsell?.revision);return r.data.upsell;
 };
 if(event){
  const product=await admin('/products',{method:'POST',body:{id:'upsell-fixture',name:'Evento de teste',description:'Uma hora, dois participantes e um idioma',priceCents:10000,hours:1,maxParticipants:2,maxLanguages:1,features:['Plano base imutável'],active:true,selfService:true}});assert.equal(product.status,201);
  const checkout=await call('/customer/checkout',{method:'POST',...owner,body:{planId:'upsell-fixture',planVersion:product.data.product.revision,eventName:'Evento com adicionais',termsAccepted:true}});assert.equal(checkout.status,201,JSON.stringify(checkout.data));
  f.baseOrder=checkout.data.order;await f.pay(f.baseOrder);
  f.event=(await call('/customer/events',owner)).data.events[0];assert.ok(f.event);
  f.usage=async(auth=owner)=>{const r=await call('/customer/events/'+f.event.id+'/usage',auth);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
  f.setUsed=async seconds=>store.transaction(async tx=>{const e=await tx.get('event',f.event.id);e.usedSeconds=seconds;await tx.put('event',e.id,e);});
  f.buy=(offer,key='checkout-'+offer.id,auth=owner,overrides={})=>call('/customer/events/'+f.event.id+'/upsells/checkout',{method:'POST',...auth,headers:{'Idempotency-Key':key},body:{offerId:offer.id,offerVersion:offer.revision,termsAccepted:true,...overrides}});
 }
 return f;
}

function limits(data){return Object.fromEntries(['hours','participants','languages'].map(metric=>[metric,data.usage[metric].limit]));}

 test('upsell admin: autorização, validação, revisões e desativação',async t=>{
 const f=await fixture(t,{event:false});
 assert.equal((await f.call('/admin/commerce/upsells',f.owner)).status,403);
 assert.equal((await f.call('/admin/commerce/upsells',{method:'POST',...f.owner,body:{name:'Não autorizado'}})).status,403);
 const offer=await f.offer({eligibleProductIds:['pocket']});
 const list=await f.admin('/upsells');assert.equal(list.status,200);assert.ok(list.data.upsells.some(o=>o.id===offer.id));
 for(const patch of [{thresholdPercent:0},{thresholdPercent:101},{leadMinutes:-1},{leadMinutes:1441},{triggerMetric:'other'},{priceCents:-1},{addHours:-1},{addParticipants:-1},{addLanguages:-1}]){
  assert.equal((await f.admin('/upsells/'+offer.id,{method:'PATCH',body:patch})).status,400,JSON.stringify(patch));
 }
 const update=await f.admin('/upsells/'+offer.id,{method:'PATCH',body:{name:'Capacidade ampliada',features:['Nova vantagem'],priceCents:32000}});
 assert.equal(update.status,200);assert.notEqual(update.data.upsell.revision,offer.revision);assert.deepEqual(update.data.upsell.features,['Nova vantagem']);
 assert.equal((await f.admin('/upsells/'+offer.id,{method:'PATCH',body:{active:false}})).status,200);
 assert.equal((await f.admin('/upsells')).data.upsells.find(o=>o.id===offer.id).active,false);
 });

 test('upsell usage: isolamento entre clientes e ausência de crédito antecipado',async t=>{
 const f=await fixture(t);const offer=await f.offer();
 const anonymous=await f.call('/customer/events/'+f.event.id+'/usage');assert.equal(anonymous.status,401);
 assert.equal((await f.call('/customer/events/'+f.event.id+'/usage',f.other)).status,404);
 assert.equal((await f.buy(offer,'wrong-owner',f.other)).status,404);
 assert.equal((await f.buy(offer,'missing-csrf',{cookie:f.owner.cookie})).status,403);
 assert.equal((await f.buy(offer,'no-consent',f.owner,{termsAccepted:false})).status,400);
 const usage=await f.usage();assert.deepEqual(limits(usage),{hours:1,participants:2,languages:1});
 for(const metric of ['hours','participants','languages'])for(const field of ['used','limit','remaining','percent'])assert.ok(field in usage.usage[metric],metric+'.'+field);
 assert.equal(usage.checkoutAvailable,true);assert.ok(Array.isArray(usage.pendingOrders));
 });

 test('upsell offers: alertas antecipados por tempo e participantes, respeitando produto e ativação',async t=>{
 const f=await fixture(t);const timed=await f.offer({id:'time-warning',triggerMetric:'hours',thresholdPercent:90,leadMinutes:15});
 const crowd=await f.offer({id:'crowd-warning',triggerMetric:'participants',thresholdPercent:75});
 const irrelevant=await f.offer({id:'other-product',eligibleProductIds:['pocket'],triggerMetric:'hours',thresholdPercent:1});
 const inactive=await f.offer({id:'inactive-offer',active:false,triggerMetric:'hours',thresholdPercent:1});
 let usage=await f.usage();assert.ok(!usage.offers.some(o=>o.id===timed.id||o.id===crowd.id));
 await f.setUsed(46*60);usage=await f.usage();assert.ok(usage.usage.hours.percent<90);assert.ok(usage.offers.some(o=>o.id===timed.id),'Lead time must warn before the percent threshold');
 assert.ok(!usage.offers.some(o=>o.id===irrelevant.id||o.id===inactive.id));
 assert.equal((await f.call('/customer/events/'+f.event.id+'/publish',{method:'POST',...f.owner,body:{published:true}})).status,200);
 const guest={headers:{},socket:{remoteAddress:'127.0.0.1'}};
 const a=await f.commerce.acquireSocket(guest,f.event.id,'listener','original'),b=await f.commerce.acquireSocket(guest,f.event.id,'listener','original');
 try{usage=await f.usage();assert.equal(usage.usage.participants.used,2);assert.equal(usage.usage.participants.percent,100);assert.ok(usage.offers.some(o=>o.id===crowd.id));}
 finally{await f.commerce.releaseSocket(a);await f.commerce.releaseSocket(b);}
 });

 test('upsell checkout: versão vencida, preço imutável, recuperação do pedido e idempotência',async t=>{
 const f=await fixture(t);const offer=await f.offer();await f.setUsed(50*60);
 const changed=await f.admin('/upsells/'+offer.id,{method:'PATCH',body:{priceCents:35000}});assert.equal(changed.status,200);const current=changed.data.upsell;
 assert.equal((await f.buy(offer,'old-price')).status,409);
 const purchase=await f.buy(current,'stable-checkout',f.owner,{amountCents:1,addHours:1000});assert.equal(purchase.status,201,JSON.stringify(purchase.data));const order=purchase.data.order;
 assert.equal(order.kind,'upsell');assert.equal(order.amountCents,35000);assert.equal(order.eventId,f.event.id);
 assert.ok(order.grants,'The add-on order exposes its purchased quota snapshot');
 assert.deepEqual(limits(await f.usage()),{hours:1,participants:2,languages:1},'Pending payment must not grant capacity');
 const replay=await f.buy(current,'stable-checkout');assert.ok([200,201].includes(replay.status));assert.equal(replay.data.order.id,order.id);
 const me=await f.call('/customer/me',{cookie:f.owner.cookie});assert.equal(me.status,200);
 const reloaded=await f.buy(current,'stable-checkout',{cookie:f.owner.cookie,csrf:me.data.csrfToken});assert.equal(reloaded.data.order.id,order.id);
 const usage=await f.usage();assert.ok(usage.pendingOrders.some(o=>o.id===order.id));
 const latest=await f.admin('/upsells/'+offer.id,{method:'PATCH',body:{priceCents:49000,addHours:3}});
 assert.equal((await f.buy(latest.data.upsell,'changed-pending-conditions')).status,409,'Never redirect a newly accepted price to an older pending checkout');
 assert.equal((await f.store.get('order',order.id)).amountCents,35000);
 await f.pay(order,'pending');assert.deepEqual(limits(await f.usage()),{hours:1,participants:2,languages:1});
 await f.pay(order);assert.deepEqual(limits(await f.usage()),{hours:2,participants:4,languages:2},'Payment grants the purchased snapshot, not the changed catalog');
 });

 test('upsell paid: créditos aditivos idempotentes e limites efetivos na transmissão',async t=>{
 const f=await fixture(t);const offer=await f.offer();await f.setUsed(50*60);
 const baseSnapshot=structuredClone((await f.store.get('order',f.baseOrder.id)).plan);
 const result=await f.buy(offer);assert.equal(result.status,201,JSON.stringify(result.data));const addon=result.data.order;
 await Promise.all([f.pay(addon),f.pay(addon),f.pay(addon)]);
 assert.deepEqual(limits(await f.usage()),{hours:2,participants:4,languages:2});
 assert.deepEqual((await f.store.get('order',f.baseOrder.id)).plan,baseSnapshot,'Base purchase snapshot is never rewritten by add-ons');
 assert.equal((await f.call('/customer/events',{cookie:f.owner.cookie})).data.events.length,1,'An add-on must not provision a second event');
 assert.equal((await f.call('/customer/events/'+f.event.id,{method:'PATCH',...f.owner,body:{targetLanguages:['en','es']}})).status,200);
 await f.setUsed(3600+60);
 assert.equal((await f.call('/customer/events/'+f.event.id+'/publish',{method:'POST',...f.owner,body:{published:true}})).status,200,'Purchased extra hours permit publishing beyond the base duration');
 const guest={headers:{},socket:{remoteAddress:'127.0.0.1'}},connections=[];
 try{
  for(let i=0;i<4;i++)connections.push(await f.commerce.acquireSocket(guest,f.event.id,'listener','original'));
  await assert.rejects(()=>f.commerce.acquireSocket(guest,f.event.id,'listener','original'));
  assert.equal(await f.commerce.refreshSocket(connections[0]),true);
  const host=await f.commerce.acquireSocket({headers:{cookie:f.owner.cookie}},f.event.id,'host','original');connections.push(host);
  assert.equal(await f.commerce.consumeSocket(host),true,'Host metering uses additive hour entitlement');
 }finally{for(const context of connections)await f.commerce.releaseSocket(context);}
 });

 test('upsell refund: revoga apenas adicionais e mantém o evento base pago utilizável',async t=>{
 const f=await fixture(t);const offer=await f.offer();await f.setUsed(50*60);
 const purchased=await f.buy(offer);assert.equal(purchased.status,201);const addon=purchased.data.order;
 await f.pay(addon);assert.deepEqual(limits(await f.usage()),{hours:2,participants:4,languages:2});
 await f.pay(addon,'refunded');
 assert.deepEqual(limits(await f.usage()),{hours:1,participants:2,languages:1});
 assert.equal((await f.store.get('order',f.baseOrder.id)).status,'paid');assert.equal((await f.store.get('order',addon.id)).status,'refunded');
 assert.equal((await f.store.get('event',f.event.id)).revoked,false);
 assert.equal((await f.call('/customer/events/'+f.event.id+'/publish',{method:'POST',...f.owner,body:{published:true}})).status,200);
 const guest={headers:{},socket:{remoteAddress:'127.0.0.1'}},a=await f.commerce.acquireSocket(guest,f.event.id,'listener','original'),b=await f.commerce.acquireSocket(guest,f.event.id,'listener','original');
 try{await assert.rejects(()=>f.commerce.acquireSocket(guest,f.event.id,'listener','original'));}finally{await f.commerce.releaseSocket(a);await f.commerce.releaseSocket(b);}
 await f.setUsed(3600);await assert.rejects(()=>f.commerce.acquireSocket(guest,f.event.id,'listener','original'));
 });

 test('upsell inactive: alteração no catálogo bloqueia novas compras sem reescrever pedidos pendentes',async t=>{
 const f=await fixture(t);const offer=await f.offer();await f.setUsed(50*60);
 const pending=await f.buy(offer);assert.equal(pending.status,201);
 const deactivated=await f.admin('/upsells/'+offer.id,{method:'PATCH',body:{active:false}});assert.equal(deactivated.status,200);
 const denied=await f.buy(deactivated.data.upsell,'new-after-deactivation');assert.ok([404,409].includes(denied.status),JSON.stringify(denied));
 assert.ok(!(await f.usage()).offers.some(o=>o.id===offer.id));
 assert.equal((await f.store.get('order',pending.data.order.id)).amountCents,offer.priceCents);
 assert.equal((await f.store.get('order',pending.data.order.id)).status,'pending');
 assert.deepEqual(limits(await f.usage()),{hours:1,participants:2,languages:1});
 });


 test('upsell languages: alerta no limite e teto de onze idiomas aplicado na oferta e no checkout',async t=>{
 const f=await fixture(t);
 const expansion=await f.offer({id:'ten-more-languages',addHours:0,addParticipants:0,addLanguages:10,triggerMetric:'languages',thresholdPercent:90});
 const oneMore=await f.offer({id:'one-more-language',addHours:0,addParticipants:0,addLanguages:1,triggerMetric:'languages',thresholdPercent:90});
 let usage=await f.usage();assert.equal(usage.usage.languages.used,1);assert.equal(usage.usage.languages.percent,100);assert.ok(usage.offers.some(o=>o.id===expansion.id));
 const bought=await f.buy(expansion,'reach-eleven');assert.equal(bought.status,201,JSON.stringify(bought.data));await f.pay(bought.data.order);
 usage=await f.usage();assert.equal(usage.usage.languages.limit,11);assert.ok(!usage.offers.some(o=>o.id===oneMore.id));
 assert.equal((await f.buy(oneMore,'above-eleven')).status,409);
 const languages=['en','es','fr','de','it','ja','ko','zh','pt','ar','hi'];
 assert.equal((await f.call('/customer/events/'+f.event.id,{method:'PATCH',...f.owner,body:{targetLanguages:languages}})).status,200);
 });

 test('upsell languages: compras concorrentes reservam o teto enquanto o pagamento está pendente',async t=>{
 const f=await fixture(t);
 const a=await f.offer({id:'language-offer-a',addHours:0,addParticipants:0,addLanguages:6,triggerMetric:'languages'});
 const b=await f.offer({id:'language-offer-b',addHours:0,addParticipants:0,addLanguages:6,triggerMetric:'languages'});
 const attempts=await Promise.all([f.buy(a,'reserve-a'),f.buy(b,'reserve-b')]);
 assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409],'Only one +6 language purchase fits a base limit of 1 under the global cap of 11');
 const winner=attempts.find(r=>r.status===201).data.order;
 let usage=await f.usage();assert.equal(usage.usage.languages.limit,1,'Pending reservations do not become usable credits');assert.equal(usage.pendingOrders.length,1);assert.equal(usage.pendingOrders[0].id,winner.id);
 const pending=(await f.store.list('order',{eventId:f.event.id})).filter(o=>o.kind==='upsell'&&o.status==='pending');assert.equal(pending.length,1,'Rejected simultaneous request must not leave a payable oversubscribed order');
 await f.pay(winner);usage=await f.usage();assert.equal(usage.usage.languages.limit,7);
 });

 test('upsell time: antecedência zero alerta no esgotamento e permite recuperar a transmissão',async t=>{
 const f=await fixture(t);
 const offer=await f.offer({id:'exhausted-hour',addHours:1,addParticipants:0,addLanguages:0,triggerMetric:'hours',thresholdPercent:100,leadMinutes:0});
 await f.setUsed(3590);assert.ok(!(await f.usage()).offers.some(o=>o.id===offer.id),'Zero lead must not be mistaken for a default positive lead time');
 await f.setUsed(3600);let usage=await f.usage();assert.equal(usage.usage.hours.remaining,0);assert.equal(usage.usage.hours.percent,100);assert.ok(usage.offers.some(o=>o.id===offer.id));assert.equal(usage.checkoutAvailable,true);
 const checkout=await f.buy(offer,'recover-expired-hours');assert.equal(checkout.status,201,JSON.stringify(checkout.data));
 assert.equal((await f.usage()).usage.hours.remaining,0);await f.pay(checkout.data.order);
 usage=await f.usage();assert.equal(usage.usage.hours.limit,2);assert.equal(usage.usage.hours.remaining,1);
 assert.equal((await f.call('/customer/events/'+f.event.id+'/publish',{method:'POST',...f.owner,body:{published:true}})).status,200);
 });
