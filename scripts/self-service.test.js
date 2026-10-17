const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const express=require('express');
const {Commerce}=require('../server/commerce');
const {CommerceStore}=require('../server/commerce-store');
const {MercadoPagoProvider}=require('../server/commerce-providers');

test('self-service: catálogo, pagamento, propriedade, imagens, limites e recuperação',async t=>{
 const env={APP_BASE_URL:'https://service.example.test',MERCADOPAGO_ACCESS_TOKEN:'test-only',MERCADOPAGO_WEBHOOK_SECRET:'test-webhook-secret',MERCADOPAGO_SANDBOX:'false'};
 const store=new CommerceStore({memory:true});store.persistent=true; // Test adapter; no production bypass route.
 const payments=new Map(),messages=[];
 const provider=new MercadoPagoProvider(env);
 provider.createCheckout=async order=>({id:'preference-'+order.id,url:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id='+order.id});
 provider.getPayment=async id=>payments.get(String(id));
 const mailer={configured:true,send:async(message,key)=>{messages.push({message,key});return {id:'email-'+messages.length};}};
 const commerce=new Commerce({store,provider,mailer,env});await commerce.ready;
 const app=express();app.use(express.json());const admin=(req,res,next)=>req.get('Authorization')==='Bearer test-admin'?next():res.status(403).json({error:'Sem acesso'});app.use('/api',commerce.router(admin));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{commerce.stopWorkers();await new Promise(r=>server.close(r));});
 async function call(path,{method='GET',body,cookie,csrf,headers={}}={}){
  const res=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  const type=res.headers.get('content-type')||'';return {status:res.status,data:type.includes('json')?await res.json():await res.text(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
 }
 const register=address=>call('/customer/register',{method:'POST',body:{name:'Cliente Teste',email:address,password:'Senha-Forte-2026'}});
 const first=await register('one@example.test');assert.equal(first.status,201);let cookie=first.cookie,csrf=first.data.csrfToken;
 const second=await register('two@example.test');assert.equal(second.status,201);
 const adminHeaders={Authorization:'Bearer test-admin'};
 let catalog=(await call('/store/plans')).data.plans;let pocket=catalog.find(p=>p.id==='pocket');
 let order,event;
 await t.test('sessão e CSRF; catálogo administrativo isolado',async()=>{
  assert.equal((await call('/admin/commerce/products',{cookie})).status,403);
  assert.equal((await call('/customer/checkout',{method:'POST',cookie,body:{planId:'pocket',eventName:'Evento'}})).status,403);
  assert.equal((await call('/customer/register',{method:'POST',headers:{Origin:'https://attacker.invalid'},body:{}})).status,403);
  const create=await call('/admin/commerce/products',{method:'POST',headers:adminHeaders,body:{id:'novo-servico',name:'Tradução para workshops',description:'Plano criado no admin',priceCents:45000,hours:2,maxParticipants:50,maxLanguages:1,features:['Uma vantagem editável'],active:true,selfService:true}});
  assert.equal(create.status,201);
  assert.ok((await call('/store/plans')).data.plans.some(p=>p.id==='novo-servico'));
  assert.equal((await call('/admin/commerce/products/novo-servico',{method:'PATCH',headers:adminHeaders,body:{active:false,features:['Vantagem atualizada']}})).status,200);
  assert.ok(!(await call('/store/plans')).data.plans.some(p=>p.id==='novo-servico'));
 });
 await t.test('preço vem do catálogo; compra não libera pelo redirect',async()=>{
  const result=await call('/customer/checkout',{method:'POST',cookie,csrf,body:{planId:'pocket',planVersion:pocket.revision||pocket.updatedAt||pocket.createdAt,eventName:'Evento comprado',termsAccepted:true,amountCents:1}});
  assert.equal(result.status,201);order=result.data.order;assert.equal(order.amountCents,120000);
  assert.equal((await call('/customer/events',{cookie})).data.events.length,0);
  assert.equal((await call('/customer/checkout',{method:'POST',cookie,csrf,body:{planId:'pocket',planVersion:pocket.revision||pocket.updatedAt||pocket.createdAt,eventName:'Evento comprado',termsAccepted:true}})).data.order.id,order.id);
  await call('/admin/commerce/products/pocket',{method:'PATCH',headers:adminHeaders,body:{priceCents:180000,features:['Nova vantagem']}});
  assert.equal((await call('/customer/orders',{cookie})).data.orders[0].amountCents,120000);
  assert.equal((await call('/customer/checkout',{method:'POST',cookie,csrf,body:{planId:'pocket',planVersion:pocket.revision||pocket.updatedAt||pocket.createdAt,eventName:'Outro evento',termsAccepted:true}})).status,409);
 });
 function payment(id,status='approved',amount=1200){return {id,external_reference:order.id,transaction_amount:amount,currency_id:'BRL',live_mode:true,status,date_last_updated:new Date(Date.now()+Number(id)).toISOString()};}
 async function webhook(id,valid=true){const ts=String(Date.now()),requestId='request-'+id;const manifest=`id:${id};request-id:${requestId};ts:${ts};`;const v1=crypto.createHmac('sha256',env.MERCADOPAGO_WEBHOOK_SECRET).update(manifest).digest('hex');return call('/payments/mercadopago/webhook?data.id='+id+'&type=payment',{method:'POST',body:{type:'payment',data:{id}},headers:{'x-request-id':requestId,'x-signature':`ts=${ts},v1=${valid?v1:'0'.repeat(64)}`}});}
 await t.test('assinatura, valor e provisionamento idempotente',async()=>{
  payments.set('101',payment('101'));assert.equal((await webhook('101',false)).status,401);
  payments.set('102',payment('102','approved',1));assert.equal((await webhook('102')).status,422);
  const results=await Promise.all([webhook('101'),webhook('101'),webhook('101')]);assert.ok(results.every(r=>r.status===200));
  const events=(await call('/customer/events',{cookie})).data.events;assert.equal(events.length,1);event=events[0];assert.equal(event.published,false);assert.equal(event.hostKey,undefined);
  await commerce.drainOutbox();await new Promise(r=>setTimeout(r,30));assert.equal(messages.filter(m=>m.key==='purchase-'+order.id).length,1);
  assert.ok(messages[0].message.text.includes('/customer.html?order='));assert.ok(!messages[0].message.text.includes('Senha-Forte-2026'));
 });
 await t.test('propriedade, arquivos reais, idiomas e publicação',async()=>{
  assert.equal((await call('/customer/events/'+event.id,{method:'PATCH',cookie:second.cookie,csrf:second.data.csrfToken,body:{name:'Invasão'}})).status,404);
  assert.equal((await call('/customer/events/'+event.id,{method:'PATCH',cookie,csrf,body:{targetLanguages:['en','es','fr']}})).status,400);
  assert.equal((await call('/customer/events/'+event.id+'/assets',{method:'POST',cookie,csrf,headers:{'Content-Type':'image/png','X-Asset-Kind':'logo'},body:Buffer.from('<script>not an image</script>')})).status,400);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const upload=await call('/customer/events/'+event.id+'/assets',{method:'POST',cookie,csrf,headers:{'Content-Type':'image/png','X-Asset-Kind':'logo'},body:png});assert.equal(upload.status,201);
  const edited=await call('/customer/events/'+event.id,{method:'PATCH',cookie,csrf,body:{name:'Marca própria',logoUrl:upload.data.url,primaryColor:'#9933ff',targetLanguages:['en']}});assert.equal(edited.status,200);assert.equal(edited.data.event.name,'Marca própria');
  assert.equal((await call('/customer/events/'+event.id+'/publish',{method:'POST',cookie,csrf,body:{published:true}})).status,200);
  const guest={headers:{},socket:{remoteAddress:'127.0.0.1'}};
  const connection=await commerce.acquireSocket(guest,event.id,'listener','en');assert.ok(connection);await commerce.releaseSocket(connection);
  await assert.rejects(()=>commerce.acquireSocket(guest,event.id,'host','original'));
  const owner={headers:{cookie}};const host=await commerce.acquireSocket(owner,event.id,'host','original');await assert.rejects(()=>commerce.acquireSocket(owner,event.id,'host','original'));assert.equal(await commerce.consumeSocket(host),true);assert.equal((await store.get('event',event.id)).usedSeconds,5);assert.equal(await commerce.consumeSocket(host),true);assert.equal((await store.get('event',event.id)).usedSeconds,5);await commerce.releaseSocket(host);
  await store.transaction(async tx=>{const e=await tx.get('event',event.id),o=await tx.get('order',order.id);o.plan.maxParticipants=1;await tx.put('order',o.id,o);e.usedSeconds=0;await tx.put('event',e.id,e);});
  const limited=await commerce.acquireSocket(guest,event.id,'listener','original');await assert.rejects(()=>commerce.acquireSocket(guest,event.id,'listener','original'));await commerce.releaseSocket(limited);
  await store.transaction(async tx=>{const e=await tx.get('event',event.id);e.usedSeconds=planHours();await tx.put('event',e.id,e);});
  function planHours(){return event.plan.hours*3600;}
  await assert.rejects(()=>commerce.acquireSocket(guest,event.id,'listener','original'));
  assert.equal((await call('/customer/events/'+event.id+'/publish',{method:'POST',cookie,csrf,body:{published:true}})).status,409);
 });
 await t.test('reembolso revoga acesso; notificações antigas não reativam',async()=>{
  const refund=payment('101','refunded');refund.date_last_updated=new Date(Date.now()+50000).toISOString();payments.set('101',refund);assert.equal((await webhook('101')).status,200);
  assert.equal((await call('/customer/events',{cookie})).data.events[0].published,false);
  assert.equal((await call('/customer/events/'+event.id+'/publish',{method:'POST',cookie,csrf,body:{published:true}})).status,409);
  payments.set('101',payment('101'));await webhook('101');assert.equal((await store.get('order',order.id)).status,'refunded');
 });
 await t.test('recuperação de senha é única e invalida sessões anteriores',async()=>{
  const response=await call('/customer/forgot-password',{method:'POST',body:{email:'one@example.test'}});assert.equal(response.status,202);await new Promise(r=>setTimeout(r,50));await commerce.drainOutbox();
  const reset=messages.find(m=>m.key.startsWith('reset-'));assert.ok(reset);const token=reset.message.text.match(/reset=([a-f0-9]{64})/)[1];
  assert.equal((await call('/customer/reset-password',{method:'POST',body:{token,password:'NovaSenha-Forte-2026'}})).status,200);
  assert.equal((await call('/customer/me',{cookie})).status,401);
  assert.equal((await call('/customer/reset-password',{method:'POST',body:{token,password:'OutraSenha-Forte-2026'}})).status,400);
  assert.equal((await call('/customer/login',{method:'POST',body:{email:'one@example.test',password:'NovaSenha-Forte-2026'}})).status,200);
 });
});

test('sem integrações reais, checkout permanece fechado',async()=>{
 const commerce=new Commerce({env:{},store:new CommerceStore({memory:true}),provider:{configured:false},mailer:{configured:false}});await commerce.ready;assert.equal(commerce.checkoutAvailable(),false);assert.equal(commerce.readiness().databaseConfigured,false);
});

test('falha no Resend permanece na fila e pode ser retomada',async()=>{
 const store=new CommerceStore({memory:true});
 const mailer={configured:true,send:async()=>{throw Error('Falha simulada de rede');}};
 const commerce=new Commerce({store,mailer,provider:{configured:false},env:{}});await commerce.ready;
 await store.transaction(async tx=>{await tx.put('order','email-order',{id:'email-order',status:'paid',emailStatus:'pending'});await commerce.queue(tx,'test-email',{to:'test@example.test',subject:'Teste',text:'Conteúdo de teste'},'email-order');});
 await commerce.drainOutbox();const queued=await store.get('outbox','test-email');assert.equal(queued.status,'pending');assert.equal(queued.attempts,1);assert.ok(queued.dueAt>Date.now());
 await store.transaction(async tx=>{const item=await tx.get('outbox','test-email');item.dueAt=0;await tx.put('outbox',item.id,item);});mailer.send=async()=>({id:'resent-test'});await commerce.drainOutbox();assert.equal((await store.get('outbox','test-email')).status,'sent');assert.equal((await store.get('order','email-order')).emailStatus,'sent');
});
