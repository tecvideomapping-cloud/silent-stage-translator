const crypto=require('crypto');
const upsells=require('./commerce-upsells');
const {promisify}=require('util');
const express=require('express');
const {CommerceStore}=require('./commerce-store');
const {MercadoPagoProvider,ResendMailer,purchaseEmail,escapeHtml}=require('./commerce-providers');
const scrypt=promisify(crypto.scrypt);
const sha=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const uuid=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const clean=(value,max=160)=>String(value??'').trim().slice(0,max);
const email=value=>clean(value,254).toLowerCase();
const isEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const safeEqual=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const plans=Object.freeze([
 {id:'pocket',name:'Pocket',priceCents:120000,currency:'BRL',hours:4,maxParticipants:150,maxLanguages:2,description:'Palestras e workshops de até 4 horas em um palco.',features:['Áudio original','Tradução em até 2 idiomas','Legendas ao vivo','Personalização da marca','Link e QR Code dos participantes']},
 {id:'congresso',name:'Congresso',priceCents:380000,currency:'BRL',hours:8,maxParticipants:null,maxLanguages:6,description:'Uma diária de até 8 horas de transmissão em um palco.',features:['Áudio original','Tradução em até 6 idiomas','Legendas e telão ao vivo','Personalização da marca','Glossário do evento','Participantes sem limite de plano']}
]);
const langs=new Set(['en','es','fr','de','it','ja','ko','zh','pt','ar','hi']);
const sourceLangs=new Set(['pt-BR','en','es','fr','de','it','en-US','es-ES','fr-FR','de-DE','it-IT','ja-JP','ko-KR','zh-CN','ar','hi-IN']);
const fonts=new Set(['Inter','DM Sans','Manrope','Montserrat','Poppins','Roboto','Playfair Display']);
const cookieName='vmt_customer_session';
function tokenFrom(req){
 if(!req||!req.headers)return '';
 const h=req.headers['x-session-token']||(typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7):'');
  const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 return cookie||String(h||'').trim();
}
function publicCustomer(c){return {id:c.id,name:c.name,email:c.email,company:c.company,phone:c.phone};}
async function passwordHash(password){const salt=crypto.randomBytes(16).toString('hex');const hash=await scrypt(password,salt,64);return `scrypt:${salt}:${hash.toString('hex')}`;}
async function passwordMatches(password,stored){const [,salt,hash]=String(stored||'').split(':');if(!salt||!hash)return false;return safeEqual((await scrypt(password,salt,64)).toString('hex'),hash);}

class Commerce {
 constructor({store=new CommerceStore(),provider=new MercadoPagoProvider(),mailer=new ResendMailer(),env=process.env,legacy={}}={}) {
  this.store=store;this.provider=provider;this.mailer=mailer;this.env=env;this.legacy=legacy;this.limits=new Map();
  this.ready=this.store.init().then(async()=>{
   await this.store.transaction(async tx=>{
    for(const [index,plan] of plans.entries())if(!await tx.get('product',plan.id))await tx.put('product',plan.id,{...plan,active:true,selfService:true,sortOrder:index,revision:uuid(),createdAt:now()});
    if(!await tx.get('product','enterprise'))await tx.put('product','enterprise',{id:'enterprise',name:'Enterprise Multipalcos',description:'Projetos para feiras, festivais e múltiplos palcos.',priceCents:0,currency:'BRL',hours:8,maxParticipants:null,maxLanguages:6,features:['Múltiplos palcos','Projeto personalizado','Equipe técnica dedicada'],active:true,selfService:false,sortOrder:2,revision:uuid(),createdAt:now()});
   });this.healthy=true;
  }).catch(e=>{this.healthy=false;console.error('[Self-service] Inicialização indisponível:',e.message);});
  this.activeLeases=new Map();
 }
 baseUrl(){try{const u=new URL(this.env.APP_BASE_URL);return u.protocol==='https:'&&u.pathname==='/'&&!u.username&&!u.password?u.origin:null;}catch{return null;}}
 readiness(){return {paymentConfigured:this.provider.configured,emailConfigured:this.mailer.configured,databaseConfigured:this.store.persistent&&!!this.healthy,publicUrlConfigured:!!this.baseUrl()};}
 checkoutAvailable(){return Object.values(this.readiness()).every(Boolean);}
  async readyOrFail(){await this.ready;if(!this.healthy)throw fail(503,'Serviço temporariamente indisponível. Nenhuma alteração foi confirmada.');}
 async session(req){const token=tokenFrom(req);if(!/^[a-f0-9]{64}$/.test(token))return null;const session=await this.store.get('session',sha(token));if(!session||session.expiresAt<Date.now())return null;const customer=await this.store.get('customer',session.customerId);if(!customer||customer.passwordVersion!==session.passwordVersion)return null;return {session,customer};}
 async requireSession(req,res,next){try{await this.readyOrFail();const auth=await this.session(req);if(!auth)throw fail(401,'Entre na sua área para continuar.');req.customer=auth.customer;req.customerSession=auth.session;next();}catch(e){next(e);}}
 async issueSession(tx,customer){const token=crypto.randomBytes(32).toString('hex');const session={id:sha(token),customerId:customer.id,csrfToken:crypto.randomBytes(24).toString('hex'),passwordVersion:customer.passwordVersion,expiresAt:Date.now()+7*86400000};await tx.put('session',session.id,session);return {token,session};}
 setCookie(res,token,req){const isHttps=Boolean(req?.secure||this.baseUrl());res.cookie(cookieName,token,{httpOnly:true,secure:isHttps,sameSite:'lax',maxAge:7*86400000,path:'/'});res.setHeader('Cache-Control','no-store');}
 csrf(req,res,next){if(!safeEqual(req.get('x-csrf-token'),req.customerSession.csrfToken))return next(fail(403,'Sessão desatualizada. Atualize a página e tente novamente.'));next();}
 throttle(scope,max=12,windowMs=900000){return(req,res,next)=>{const ip=req.ip||req.socket.remoteAddress||'';if(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)||!this.env.NODE_ENV||this.env.NODE_ENV!=='production')return next();const key=scope+':'+ip;const time=Date.now();if(this.limits.size>10000)for(const [k,v] of this.limits)if(v.until<time)this.limits.delete(k);const entry=this.limits.get(key)||{count:0,until:time+windowMs};if(entry.until<time){entry.count=0;entry.until=time+windowMs;}entry.count++;this.limits.set(key,entry);if(entry.count>max){res.setHeader('Retry-After',Math.ceil((entry.until-time)/1000));return next(fail(429,'Muitas tentativas. Aguarde alguns minutos.'));}next();};}
  origin(req,res,next){if(!require('./security').isAllowed(req.get('origin')))return next(fail(403,'Origem não autorizada.'));next();}

 async eventFor(customerId,id,tx=this.store){const event=await tx.get('event',id);if(!event||event.customerId!==customerId)throw fail(404,'Evento não encontrado.');return event;}
 async eventView(event){const stored=await this.store.get('order',event.orderId);const order={...stored,plan:await this.entitlement(event)};const remaining=Math.max(0,order.plan.hours*3600-event.usedSeconds);return {...event,hostKey:undefined,customerId:undefined,plan:order.plan,status:order.status!=='paid'?order.status:remaining<=0?'expired':event.published?'active':'draft',remainingSeconds:remaining,participantUrl:(this.baseUrl()||'')+'/?room='+event.id,hostUrl:'/host.html?room='+event.id,screenUrl:'/screen.html?room='+event.id,published:event.published&&order.status==='paid'&&remaining>0};}
 orderView(order){return {id:order.id,kind:order.kind||'base',grants:order.grants||null,offerId:order.kind==='upsell'?order.plan.id:null,offerVersion:order.kind==='upsell'?order.plan.revision:null,planName:order.plan.name,status:order.status,amountCents:order.amountCents,priceCents:order.amountCents,currency:order.currency,eventName:order.eventName,createdAt:order.createdAt,checkoutUrl:order.status==='pending'?order.checkoutUrl:null,eventId:order.eventId||null,emailStatus:order.emailStatus||(order.status==='paid'?'pending':'not_sent'),duplicatePayment:!!order.duplicatePayment};}
 async queue(tx,key,message,orderId=null){if(await tx.get('outbox',key))return;await tx.put('outbox',key,{id:key,message,orderId,status:'pending',attempts:0,dueAt:Date.now(),createdAt:now()});}
 roomFromEvent(event){return {id:event.id,name:event.name,host_key:event.hostKey,source_language:event.source_language,target_languages:event.target_languages,glossary:event.glossary||{},logo_url:event.logo_url||'',banner_url:event.banner_url||'',primary_color:event.primary_color,secondary_color:event.secondary_color,bg_color:event.bg_color,font_family:event.font_family,custom_css:'',sponsors:[],allow_original_audio:true,allow_translation:true,allow_subtitles:true,status:event.published?'active':'draft',created_at:event.createdAt};}
 async syncRoom(tx,event){
  const r=this.roomFromEvent(event);
  if(tx.query)await tx.query(`INSERT INTO rooms(id,name,host_key,source_language,target_languages,glossary,logo_url,banner_url,primary_color,secondary_color,bg_color,font_family,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,source_language=EXCLUDED.source_language,target_languages=EXCLUDED.target_languages,glossary=EXCLUDED.glossary,logo_url=EXCLUDED.logo_url,banner_url=EXCLUDED.banner_url,primary_color=EXCLUDED.primary_color,secondary_color=EXCLUDED.secondary_color,bg_color=EXCLUDED.bg_color,font_family=EXCLUDED.font_family,status=EXCLUDED.status`,[r.id,r.name,r.host_key,r.source_language,r.target_languages,JSON.stringify(r.glossary),r.logo_url,r.banner_url,r.primary_color,r.secondary_color,r.bg_color,r.font_family,r.status]);
 }
 async afterEvent(event){this.legacy.invalidateRoom?.(event.id);if(!this.store.persistent&&this.legacy.saveRoom)await this.legacy.saveRoom(this.roomFromEvent(event));}
 async managedEvent(id){await this.readyOrFail();return this.store.get('event',id);}
 async isOwner(req,event){const auth=await this.session(req);return auth?.customer.id===event.customerId;}
 async checkEventAccess(req,id,{operator=false,admin=false}={}){
  const event=await this.managedEvent(id);if(!event){if(String(id).startsWith('evt-'))throw fail(404,'Evento não encontrado.');return null;}
  const order=await this.store.get('order',event.orderId);if(order?.status!=='paid'||event.revoked)throw fail(403,'O acesso a este evento não está ativo.');
  const owner=admin||await this.isOwner(req,event);
  if(operator&&!owner)throw fail(403,'Acesso reservado ao responsável pelo evento.');
  if(!operator&&!owner&&!event.published)throw fail(403,'Este evento ainda não está disponível para os participantes.');
  if(event.usedSeconds>=(await this.entitlement(event)).hours*3600)throw fail(403,'O período de transmissão deste evento foi utilizado.');
  return {event,order,owner};
 }
 async acquireSocket(req,id,role,channel,admin=false){
  const access=await this.checkEventAccess(req,id,{operator:role==='host',admin});if(!access)return null;
  const {event,order}=access;
  if(!['original','text',...event.target_languages].includes(channel))throw fail(403,'Este canal não está disponível no evento.');
  const leaseId=uuid();
  await this.store.transaction(async tx=>{
   const current=await tx.get('event',id),base=await tx.get('order',current.orderId);
   if(base.status!=='paid'||current.revoked||current.usedSeconds>=(await this.entitlement(current,tx)).hours*3600)throw fail(403,'O acesso a este evento não está ativo.');
   const effective=await this.entitlement(current,tx);
   const leases=await tx.list('connection',{eventId:id});const active=leases.filter(l=>l.expiresAt>Date.now());
   if(role==='host'&&active.some(l=>l.role==='host'))throw fail(409,'Já existe um transmissor conectado a este evento.');
   if(role==='listener'&&effective.maxParticipants&&active.filter(l=>l.role==='listener').length>=effective.maxParticipants)throw fail(403,'O evento atingiu o limite de participantes simultâneos.');
   for(const lease of leases)if(lease.expiresAt<Date.now())await tx.remove('connection',lease.id);
   await tx.put('connection',leaseId,{id:leaseId,eventId:id,role,expiresAt:Date.now()+75000});
  });return {eventId:id,leaseId,role,plan:order.plan};
 }
 async releaseSocket(context){if(context)await this.store.transaction(tx=>tx.remove('connection',context.leaseId));}
 async refreshSocket(context){
  if(!context)return true;
  return this.store.transaction(async tx=>{const lease=await tx.get('connection',context.leaseId),event=await tx.get('event',context.eventId);const order=event&&await tx.get('order',event.orderId);
   if(!lease||!event||order?.status!=='paid'||event.revoked||context.role!=='host'&&!event.published)return false;
   if(context.role!=='host'&&event.usedSeconds>=(await this.entitlement(event,tx)).hours*3600)return false;
   lease.expiresAt=Date.now()+75000;await tx.put('connection',lease.id,lease);return true;});
 }
 async consumeSocket(context){
  if(!context||context.role!=='host')return true;
  if(context.budgetUntil>Date.now())return true;
  if(context.charging)return context.charging;
  context.charging=this.store.transaction(async tx=>{const event=await tx.get('event',context.eventId);const order=event&&await tx.get('order',event.orderId);const lease=await tx.get('connection',context.leaseId);
   if(!event||!lease||lease.expiresAt<Date.now()||order?.status!=='paid'||event.revoked)return false;
   if(lease.budgetUntil>Date.now()){context.budgetUntil=lease.budgetUntil;return true;}
   const seconds=Math.min(5,(await this.entitlement(event,tx)).hours*3600-event.usedSeconds);if(seconds<=0)return false;
   event.usedSeconds+=seconds;await tx.put('event',event.id,event);context.budgetUntil=Date.now()+seconds*1000;lease.budgetUntil=context.budgetUntil;await tx.put('connection',lease.id,lease);return true;
  }).finally(()=>{context.charging=null;});return context.charging;
 }
 async processPayment(payment){
  const orderId=String(payment.external_reference||'');
  const result=await this.store.transaction(async tx=>{
   const order=await tx.get('order',orderId);if(!order)return null;
   const amount=Math.round(Number(payment.transaction_amount)*100);
   const production=this.env.MERCADOPAGO_SANDBOX!=='true';
   if(payment.currency_id!==order.currency||amount!==order.amountCents||payment.live_mode!==production||(this.env.MERCADOPAGO_COLLECTOR_ID&&String(payment.collector_id)!==this.env.MERCADOPAGO_COLLECTOR_ID))throw fail(422,'Pagamento não corresponde ao pedido.');
   const key=String(payment.id);const previous=await tx.get('payment',key);const updated=Date.parse(payment.date_last_updated||payment.date_created)||Date.now();
   if(previous&&previous.updated>=updated)return null;
   await tx.put('payment',key,{id:key,orderId,updated,status:payment.status});
   let event=order.eventId?await tx.get('event',order.eventId):null;
   if(order.kind==='upsell'){
    if(!event||event.customerId!==order.customerId||event.orderId!==order.baseOrderId)throw fail(422,'Evento do adicional inválido.');
    if(['refunded','charged_back'].includes(payment.status)&&(!order.paymentId||order.paymentId===key))order.status=payment.status;
    else if(payment.status==='approved'&&!['refunded','charged_back'].includes(order.status)){
     if(order.paymentId&&order.paymentId!==key)order.duplicatePayment=true;
     else {order.paymentId=key;order.status='paid';order.paidAt=order.paidAt||now();
      const customer=await tx.get('customer',order.customerId);
      await this.queue(tx,'purchase-'+order.id,upsells.upsellEmail(order,customer,event,this.baseUrl()),order.id);
      order.emailStatus=order.emailStatus==='sent'?'sent':'pending';
     }
    }else if(order.status!=='paid'&&!['refunded','charged_back'].includes(order.status))order.status=['rejected','cancelled'].includes(payment.status)?payment.status:'pending';
    order.updatedAt=now();await tx.put('order',order.id,order);
    const effective=await this.entitlement(event,tx);
    if(event.target_languages.length>effective.maxLanguages){event.target_languages=event.target_languages.slice(0,effective.maxLanguages);await tx.put('event',event.id,event);await this.syncRoom(tx,event);}
    return {order,event};
   }
   const revoked=['refunded','charged_back'].includes(payment.status);
   if(revoked&&(!order.paymentId||order.paymentId===key)){
    order.status=payment.status;if(event){event.published=false;event.revoked=true;await tx.put('event',event.id,event);await this.syncRoom(tx,event);}
   }else if(payment.status==='approved'&&!['refunded','charged_back'].includes(order.status)){
    if(order.paymentId&&order.paymentId!==key){order.duplicatePayment=true;}
    else {
     order.paymentId=key;order.status='paid';
     if(!event){
      event={id:'evt-'+crypto.randomBytes(10).toString('hex'),customerId:order.customerId,orderId:order.id,name:order.eventName,hostKey:crypto.randomBytes(32).toString('hex'),published:false,revoked:false,usedSeconds:0,source_language:'pt-BR',target_languages:['en','es'].slice(0,order.plan.maxLanguages),logo_url:'',banner_url:'',primary_color:'#b3a0ff',secondary_color:'#7250d6',bg_color:'#10111c',font_family:'DM Sans',glossary:{},createdAt:now(),status:'draft'};
      order.eventId=event.id;order.paidAt=now();await tx.put('event',event.id,event);await this.syncRoom(tx,event);
     }
     const customer=await tx.get('customer',order.customerId);
     await this.queue(tx,'purchase-'+order.id,purchaseEmail(order,customer,event,this.baseUrl()),order.id);order.emailStatus=order.emailStatus==='sent'?'sent':'pending';
    }
   }else if(order.status!=='paid'&&!['refunded','charged_back'].includes(order.status))order.status=['rejected','cancelled'].includes(payment.status)?payment.status:'pending';
   order.updatedAt=now();await tx.put('order',order.id,order);return {order,event};
  });
  if(result?.event)await this.afterEvent(result.event);
  return result;
 }
 async drainOutbox(){
  if(this.draining||!this.mailer.configured||!this.healthy)return;
  this.draining=true;
  try{
   for(let i=0;i<10;i++){
    const item=await this.store.transaction(async tx=>{
     const entries=await tx.list('outbox');const item=entries.find(x=>(x.status==='pending'||x.status==='processing'&&x.leaseUntil<Date.now())&&x.dueAt<=Date.now());
     if(!item)return null;
     // Do not deliver a purchase access email after its entitlement was revoked.
     if(item.orderId){const o=await tx.get('order',item.orderId);if(o?.status!=='paid'){item.status='cancelled';await tx.put('outbox',item.id,item);return null;}}
     item.status='processing';item.leaseUntil=Date.now()+120000;item.attempts++;await tx.put('outbox',item.id,item);return item;
    });
    if(!item)break;
    try{const sent=await this.mailer.send(item.message,item.id);await this.store.transaction(async tx=>{const current=await tx.get('outbox',item.id);current.status='sent';current.sentAt=now();current.providerId=sent.id;await tx.put('outbox',item.id,current);if(item.orderId){const order=await tx.get('order',item.orderId);order.emailStatus='sent';await tx.put('order',order.id,order);}});}
    catch(e){await this.store.transaction(async tx=>{const current=await tx.get('outbox',item.id);current.status=current.attempts>=8?'failed':'pending';current.dueAt=Date.now()+Math.min(3600000,60000*2**current.attempts);current.lastError='Falha no envio pelo provedor';await tx.put('outbox',item.id,current);if(item.orderId){const order=await tx.get('order',item.orderId);order.emailStatus=current.status==='failed'?'failed':'pending';await tx.put('order',order.id,order);}});console.error('[E-mail] Envio pendente; nova tentativa agendada.');}
   }
  }finally{this.draining=false;}
 }
 async maintenance(){
  await this.readyOrFail();
  await this.store.transaction(async tx=>{
   for(const order of await tx.list('order'))if(order.status==='pending'&&Date.parse(order.createdAt)<Date.now()-86400000){order.checkoutExpired=true;await tx.put('order',order.id,order);}
   for(const kind of ['session','adminsession','reset','connection'])for(const record of await tx.list(kind))if(record.expiresAt<Date.now())await tx.remove(kind,record.id);
  });await this.drainOutbox();
 }
 startWorkers(){this.worker=setInterval(()=>this.maintenance().catch(()=>console.error('[Self-service] Manutenção pendente.')),60000);this.worker.unref();}
 stopWorkers(){clearInterval(this.worker);}
 router(requireAdmin){
  const router=express.Router();
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
  const auth=this.requireSession.bind(this),csrf=this.csrf.bind(this),origin=this.origin.bind(this);
  router.use((req,res,next)=>{if(req.path.startsWith('/customer')||req.path.startsWith('/admin/commerce'))res.setHeader('Cache-Control','no-store');next();});
  router.get('/store/plans',wrap(async(req,res)=>{await this.ready;const catalog=this.healthy?(await this.store.list('product')).filter(p=>p.active).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)):[];res.setHeader('Cache-Control','no-store');res.json({plans:catalog,checkoutAvailable:this.checkoutAvailable(),emailAvailable:this.mailer.configured});}));
  router.post('/customer/register',origin,this.throttle('register',8),wrap(async(req,res)=>{
   await this.readyOrFail();const {name,password,company,phone}=req.body||{};const address=email(req.body?.email);
   const displayName=clean(name,100)||(address?address.split('@')[0]:'');
   if(!displayName||!isEmail(address)||typeof password!=='string'||password.length<10||password.length>128)throw fail(400,'Informe nome, e-mail válido e uma senha entre 10 e 128 caracteres.');
   const hash=await passwordHash(password);
   const result=await this.store.transaction(async tx=>{if(await tx.get('email',address))throw fail(409,'Este e-mail já possui uma conta. Entre ou recupere seu acesso.');const customer={id:uuid(),name:displayName,email:address,company:clean(company,160),phone:clean(phone,40),passwordHash:hash,passwordVersion:1,createdAt:now()};await tx.put('customer',customer.id,customer);await tx.put('email',address,{customerId:customer.id});return {customer,...await this.issueSession(tx,customer)};});
   this.setCookie(res,result.token,req);res.status(201).json({customer:publicCustomer(result.customer),token:result.token,csrfToken:result.session.csrfToken});
  }));
  router.post('/customer/login',origin,this.throttle('login',15),wrap(async(req,res)=>{
   await this.readyOrFail();
   let rawAddress = email(req.body?.email || req.body?.username);
   if (!rawAddress || rawAddress === 'admin' || rawAddress === 'admin@videomapping.com') {
     rawAddress = (this.env.ADMIN_EMAIL || 'admin@videomappingtech.com').toLowerCase().trim();
   }
   const mapping = await this.store.get('email', rawAddress);
   let customer = mapping ? await this.store.get('customer', mapping.customerId) : null;
   const password = req.body?.password;
   let valid = customer && typeof password === 'string' && password.length<=128 && await passwordMatches(password, customer.passwordHash);
   if (!valid) throw fail(401, 'E-mail ou senha inválidos.');
   const result = await this.store.transaction(tx => this.issueSession(tx, customer));
   this.setCookie(res, result.token, req);
   res.json({ customer: publicCustomer(customer), token: result.token, csrfToken: result.session.csrfToken });
  }));
  router.get('/customer/me',auth,(req,res)=>res.json({customer:publicCustomer(req.customer),csrfToken:req.customerSession.csrfToken}));
  router.post('/customer/logout',auth,csrf,wrap(async(req,res)=>{await this.store.transaction(tx=>tx.remove('session',req.customerSession.id));res.clearCookie(cookieName,{path:'/',sameSite:'lax',secure:this.env.NODE_ENV==='production'||!!this.baseUrl()});res.json({success:true});}));
  router.post('/customer/forgot-password',origin,this.throttle('forgot',6),wrap(async(req,res)=>{
   await this.readyOrFail();if(!this.mailer.configured||!this.baseUrl())throw fail(503,'Recuperação de acesso temporariamente indisponível.');
   const mapping=await this.store.get('email',email(req.body?.email));
   if(mapping){const token=crypto.randomBytes(32).toString('hex');const customer=await this.store.get('customer',mapping.customerId);const link=this.baseUrl()+'/customer.html?reset='+token;
    await this.store.transaction(async tx=>{for(const old of await tx.list('reset',{customerId:customer.id}))await tx.remove('reset',old.id);const id=sha(token);await tx.put('reset',id,{id,customerId:customer.id,expiresAt:Date.now()+3600000});await this.queue(tx,'reset-'+uuid(),{to:customer.email,subject:'Recupere seu acesso · Videomappingtech',text:`Use este link para criar uma nova senha. Ele expira em uma hora: ${link}\nSe você não solicitou, ignore este e-mail.`,html:`<p>Olá, ${escapeHtml(customer.name)}.</p><p><a href="${escapeHtml(link)}">Criar nova senha</a></p><p>Este link é de uso único e expira em uma hora. Se você não solicitou, ignore este e-mail.</p>`});});
   }res.status(202).json({success:true,message:'Se houver uma conta para este e-mail, você receberá as instruções de acesso.'});this.drainOutbox().catch(()=>{});
  }));
  router.post('/customer/reset-password',origin,this.throttle('reset',10),wrap(async(req,res)=>{
   await this.readyOrFail();const {token,password}=req.body||{};if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||typeof password!=='string'||password.length<10||password.length>128)throw fail(400,'Link inválido ou senha fora dos limites de 10 a 128 caracteres.');
   const hash=await passwordHash(password);await this.store.transaction(async tx=>{const reset=await tx.get('reset',sha(token));if(!reset||reset.expiresAt<Date.now())throw fail(400,'Este link expirou ou já foi utilizado. Solicite outro.');const customer=await tx.get('customer',reset.customerId);customer.passwordHash=hash;customer.passwordVersion++;await tx.put('customer',customer.id,customer);for(const r of await tx.list('reset',{customerId:customer.id}))await tx.remove('reset',r.id);});res.clearCookie(cookieName,{path:'/'});res.json({success:true});
  }));
  router.get('/customer/orders',auth,wrap(async(req,res)=>{const orders=await this.store.list('order',{customerId:req.customer.id});res.json({orders:orders.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(o=>this.orderView(o))});}));
  router.post('/customer/checkout',auth,csrf,this.throttle('checkout',15),wrap(async(req,res)=>{
   if(!this.checkoutAvailable())throw fail(503,'A contratação online ainda está sendo configurada. Entre em contato para contratar.');
   const plan=await this.store.get('product',clean(req.body?.planId,60));const name=clean(req.body?.eventName,120);
   if(!plan||!plan.active||plan.selfService===false||!name||req.body?.termsAccepted!==true)throw fail(400,'Escolha um plano disponível, informe o nome do evento e confirme as condições apresentadas.');
   const requestKey=clean(req.get('Idempotency-Key'),100);
   const order=await this.store.transaction(async tx=>{
    const currentPlan=await tx.get('product',plan.id);
    if(!currentPlan?.active||currentPlan.selfService===false||req.body.planVersion!==(currentPlan.revision||currentPlan.updatedAt||currentPlan.createdAt))throw fail(409,'Este produto foi atualizado. Recarregue a página e confira as condições antes de pagar.');
    const orders=await tx.list('order',{customerId:req.customer.id});
    const existing=orders.find(o=>requestKey?o.requestKey===requestKey:o.kind!=='upsell'&&o.plan.id===plan.id&&o.eventName===name&&o.status==='pending'&&Date.parse(o.createdAt)>Date.now()-900000);
    if(existing){if(existing.kind==='upsell'||existing.plan.id!==plan.id||existing.eventName!==name)throw fail(409,'Esta tentativa pertence a outro pedido. Atualize a página.');if(existing.status!=='pending')throw fail(409,'Este pedido já foi processado. Consulte sua área.');if(existing.checkoutUrl)return existing;if(existing.checkoutLease>Date.now())throw fail(409,'Seu pagamento está sendo preparado. Aguarde alguns segundos.');existing.checkoutLease=Date.now()+30000;await tx.put('order',existing.id,existing);return existing;}
    const order={id:uuid(),customerId:req.customer.id,plan:structuredClone(currentPlan),amountCents:currentPlan.priceCents,currency:currentPlan.currency,eventName:name,status:'pending',createdAt:now(),requestKey:requestKey||uuid(),checkoutLease:Date.now()+30000,termsAcceptedAt:now()};await tx.put('order',order.id,order);return order;
   });
   if(order.checkoutUrl)return res.json({order:this.orderView(order),checkoutUrl:order.checkoutUrl});
   try{const checkout=await this.provider.createCheckout(order,req.customer,this.baseUrl());const updated=await this.store.transaction(async tx=>{const current=await tx.get('order',order.id);current.preferenceId=checkout.id;current.checkoutUrl=checkout.url;current.checkoutLease=0;await tx.put('order',current.id,current);return current;});res.status(201).json({order:this.orderView(updated),checkoutUrl:checkout.url});}
   catch(e){await this.store.transaction(async tx=>{const current=await tx.get('order',order.id);current.checkoutLease=0;await tx.put('order',current.id,current);});throw fail(502,'Não foi possível preparar o pagamento. Tente novamente.');}
  }));
  router.post('/payments/mercadopago/webhook',wrap(async(req,res)=>{
   await this.readyOrFail();if(!this.provider.configured||!this.store.persistent)throw fail(503,'Integração indisponível.');
   const id=this.provider.verifyNotification(req);if(!id)throw fail(401,'Notificação inválida.');
   if((req.body?.type||req.query.type)!=='payment')return res.sendStatus(200);
   const payment=await this.provider.getPayment(id);if(String(payment.id)!==String(id))throw fail(422,'Pagamento inválido.');await this.processPayment(payment);res.sendStatus(200);this.drainOutbox().catch(()=>{});
  }));
  router.get('/customer/events',auth,wrap(async(req,res)=>{const events=await this.store.list('event',{customerId:req.customer.id});res.json({events:await Promise.all(events.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(e=>this.eventView(e)))});}));
  router.get('/customer/glossaries',auth,wrap(async(req,res)=>res.json({glossaries:await this.store.list('glossary',{customerId:req.customer.id})})));
  router.get('/customer/glossaries/:id',auth,wrap(async(req,res)=>{const g=await this.store.get('glossary',req.params.id);if(!g||g.customerId!==req.customer.id)throw fail(404,'Glossário não encontrado.');res.json(g);}));
  const saveGlossary=wrap(async(req,res)=>{
   const b=req.body||{};if(!clean(b.name,100)||!b.terms||typeof b.terms!=='object'||Array.isArray(b.terms)||Object.keys(b.terms).length>300||Object.entries(b.terms).some(([k,v])=>k.length>100||typeof v!=='string'||v.length>500))throw fail(400,'Confira o nome e os termos do glossário.');
   const result=await this.store.transaction(async tx=>{const id=req.params.id||String(Date.now()*1000+crypto.randomInt(1000));const previous=await tx.get('glossary',id);if(req.params.id&&(!previous||previous.customerId!==req.customer.id))throw fail(404,'Glossário não encontrado.');const g={id:Number(id),customerId:req.customer.id,name:clean(b.name,100),description:clean(b.description,400),category:clean(b.category,80)||'Geral',terms:b.terms,created_at:previous?.created_at||now(),updated_at:now()};await tx.put('glossary',id,g);return g;});res.status(req.method==='POST'?201:200).json(result);
  });
  router.post('/customer/glossaries',auth,csrf,saveGlossary);router.put('/customer/glossaries/:id',auth,csrf,saveGlossary);
  router.delete('/customer/glossaries/:id',auth,csrf,wrap(async(req,res)=>{await this.store.transaction(async tx=>{const g=await tx.get('glossary',req.params.id);if(!g||g.customerId!==req.customer.id)throw fail(404,'Glossário não encontrado.');await tx.remove('glossary',req.params.id);});res.json({success:true});}));
  router.patch('/customer/events/:id',auth,csrf,wrap(async(req,res)=>{
   const event=await this.store.transaction(async tx=>{
    const event=await this.eventFor(req.customer.id,req.params.id,tx);const order=await tx.get('order',event.orderId);if(order.status!=='paid')throw fail(409,'O acesso ao evento não está ativo.');const body=req.body||{};
    if(body.name!==undefined){if(!clean(body.name,120))throw fail(400,'Informe o nome do evento.');event.name=clean(body.name,120);}
    for(const [input,key] of [['primaryColor','primary_color'],['secondaryColor','secondary_color'],['bgColor','bg_color']])if(body[input]!==undefined){if(!/^#[a-f0-9]{6}$/i.test(body[input]))throw fail(400,'Informe cores no formato hexadecimal.');event[key]=body[input];}
    if(body.sourceLanguage!==undefined){if(!sourceLangs.has(body.sourceLanguage))throw fail(400,'Idioma do palco inválido.');event.source_language=body.sourceLanguage;}
    if(body.targetLanguages!==undefined){if(!Array.isArray(body.targetLanguages)||body.targetLanguages.some(l=>!langs.has(l))||new Set(body.targetLanguages).size!==body.targetLanguages.length||body.targetLanguages.length>(await this.entitlement(event,tx)).maxLanguages)throw fail(400,'Idiomas acima do limite do plano ou inválidos.');event.target_languages=body.targetLanguages;}
    if(body.fontFamily!==undefined){if(!fonts.has(body.fontFamily))throw fail(400,'Fonte inválida.');event.font_family=body.fontFamily;}
    for(const [input,key,kind] of [['logoUrl','logo_url','logo'],['bannerUrl','banner_url','banner']])if(body[input]!==undefined){if(body[input]===''){event[key]='';continue;}const match=String(body[input]).match(/^\/api\/assets\/([a-f0-9-]{36})$/);const asset=match&&await tx.get('asset',match[1]);if(!asset||asset.customerId!==req.customer.id||asset.eventId!==event.id||asset.kind!==kind)throw fail(400,'Envie uma imagem para este evento antes de salvar.');event[key]=body[input];}
    event.updatedAt=now();await tx.put('event',event.id,event);await this.syncRoom(tx,event);return event;
   });await this.afterEvent(event);res.json({event:await this.eventView(event)});
  }));
  router.post('/customer/events/:id/assets',auth,csrf,this.throttle('uploads',40),express.raw({type:['image/png','image/jpeg','image/webp'],limit:'5mb'}),wrap(async(req,res)=>{
   const kind=req.get('X-Asset-Kind');const bytes=req.body;const mime=req.get('Content-Type')?.split(';')[0];
   const valid=Buffer.isBuffer(bytes)&&bytes.length>12&&(mime==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255||mime==='image/webp'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP');
   if(!['logo','banner'].includes(kind)||!valid)throw fail(400,'Envie uma imagem PNG, JPEG ou WebP de até 5 MB.');
   const id=uuid();await this.store.transaction(async tx=>{const event=await this.eventFor(req.customer.id,req.params.id,tx);const order=await tx.get('order',event.orderId);if(order.status!=='paid')throw fail(409,'O evento não está ativo.');if((await tx.list('asset',{eventId:event.id})).length>=30)throw fail(409,'Limite de 30 imagens por evento atingido.');await tx.asset({id,customerId:req.customer.id,eventId:event.id,kind,mime,bytes});await tx.put('asset',id,{id,customerId:req.customer.id,eventId:event.id,kind});});res.status(201).json({url:'/api/assets/'+id});
  }));
  router.get('/assets/:id',wrap(async(req,res)=>{await this.readyOrFail();const asset=await this.store.asset(req.params.id);if(!asset)return res.sendStatus(404);res.setHeader('Content-Type',asset.mime);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.setHeader('Cache-Control','public,max-age=31536000,immutable');res.send(asset.bytes);}));
  router.post('/customer/events/:id/publish',auth,csrf,wrap(async(req,res)=>{
   if(typeof req.body?.published!=='boolean')throw fail(400,'Informe se o evento deve ser publicado.');const event=await this.store.transaction(async tx=>{const event=await this.eventFor(req.customer.id,req.params.id,tx);const order=await tx.get('order',event.orderId);if(order.status!=='paid'||event.revoked)throw fail(409,'O pagamento deste evento não está ativo.');if(req.body.published&&event.usedSeconds>=(await this.entitlement(event,tx)).hours*3600)throw fail(409,'As horas de transmissão deste evento foram utilizadas.');event.published=req.body.published;event.status=event.published?'active':'draft';await tx.put('event',event.id,event);await this.syncRoom(tx,event);return event;});await this.afterEvent(event);res.json({event:await this.eventView(event)});
  }));
  if(requireAdmin){
   router.get('/admin/commerce/products',requireAdmin,wrap(async(req,res)=>{await this.readyOrFail();res.json({products:(await this.store.list('product')).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0))});}));
   const saveProduct=wrap(async(req,res)=>{
    await this.readyOrFail();const body=req.body||{};const id=req.params.id||body.id||'plano-'+crypto.randomBytes(4).toString('hex');
    if(!/^[a-z0-9][a-z0-9-]{1,49}$/.test(id))throw fail(400,'Use um identificador de 2 a 50 caracteres: letras minúsculas, números e hífen.');
    const product=await this.store.transaction(async tx=>{
     const existing=await tx.get('product',id);if(req.method==='PATCH'&&!existing)throw fail(404,'Produto não encontrado.');if(req.method==='POST'&&existing)throw fail(409,'Já existe um produto com este identificador.');
     const p={...existing,...Object.fromEntries(['name','description','priceCents','hours','maxParticipants','maxLanguages','features','active','selfService','sortOrder'].filter(k=>body[k]!==undefined).map(k=>[k,body[k]])),id,currency:'BRL',createdAt:existing?.createdAt||now(),updatedAt:now()};
     if(p.active===undefined)p.active=true;if(p.selfService===undefined)p.selfService=true;if(p.maxParticipants===undefined)p.maxParticipants=null;
     if(!clean(p.name,80)||typeof p.description!=='string'||p.description.length>500||!Number.isInteger(p.priceCents)||p.priceCents<(p.selfService?100:0)||p.priceCents>100000000||!Number.isFinite(p.hours)||p.hours<0.25||p.hours>720||p.maxParticipants!==null&&(!Number.isInteger(p.maxParticipants)||p.maxParticipants<1||p.maxParticipants>100000)||!Number.isInteger(p.maxLanguages)||p.maxLanguages<0||p.maxLanguages>11||typeof p.active!=='boolean'||typeof p.selfService!=='boolean'||!Array.isArray(p.features)||p.features.length>20||p.features.some(f=>typeof f!=='string'||!f.trim()||f.length>200))throw fail(400,'Confira nome, descrição, preço, duração, limites e vantagens do produto.');
     p.name=clean(p.name,80);p.features=p.features.map(f=>f.trim());p.sortOrder=Number.isFinite(p.sortOrder)?Math.max(0,Math.min(1000,p.sortOrder)):20;p.revision=uuid();
     if(!existing&&(await tx.list('product')).length>=30)throw fail(409,'Limite de 30 produtos atingido.');await tx.put('product',id,p);return p;
    });res.status(req.method==='POST'?201:200).json({product});
   });
   router.post('/admin/commerce/products',requireAdmin,saveProduct);router.patch('/admin/commerce/products/:id',requireAdmin,saveProduct);
   router.get('/admin/commerce/overview',requireAdmin,wrap(async(req,res)=>{await this.readyOrFail();const orders=await this.store.list('order');const customers=await this.store.list('customer');const paid=orders.filter(o=>o.status==='paid');res.json({orders:orders.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(o=>{const c=customers.find(c=>c.id===o.customerId);return {...this.orderView(o),customerName:c?.name,customerEmail:c?.email};}),totals:{paidCents:paid.reduce((s,o)=>s+o.amountCents,0),paidOrders:paid.length,pendingOrders:orders.filter(o=>o.status==='pending').length},readiness:this.readiness()});}));
   router.post('/admin/commerce/orders/:id/retry-email',requireAdmin,wrap(async(req,res)=>{await this.readyOrFail();if(!this.mailer.configured)throw fail(503,'Resend não configurado.');await this.store.transaction(async tx=>{const order=await tx.get('order',req.params.id);if(!order||order.status!=='paid'||!order.eventId)throw fail(409,'Somente pedidos pagos podem receber o acesso.');const customer=await tx.get('customer',order.customerId),event=await tx.get('event',order.eventId);const original=await tx.get('outbox','purchase-'+order.id);if(original&&original.status!=='sent'){original.status='pending';original.attempts=0;original.dueAt=Date.now();await tx.put('outbox',original.id,original);}else await this.queue(tx,'resend-'+order.id+'-'+uuid(),(order.kind==='upsell'?upsells.upsellEmail:purchaseEmail)(order,customer,event,this.baseUrl()),order.id);order.emailStatus='pending';await tx.put('order',order.id,order);});res.json({success:true});this.drainOutbox().catch(()=>{});}));
  }
  upsells.routes.call(this,router,{wrap,auth,csrf,requireAdmin});
  router.use((err,req,res,next)=>{if(res.headersSent)return next(err);const status=err.type==='entity.too.large'?413:err.status||500;if(status>=500)console.error('[Self-service]',err.message);res.status(status).json({error:status===413?'A imagem deve ter no máximo 5 MB.':status>=500?'Serviço temporariamente indisponível. Tente novamente em instantes.':err.message});});
  return router;
 }
}
Commerce.prototype.entitlement=upsells.entitlement;
Commerce.prototype.usageView=upsells.usageView;
module.exports={Commerce,plans,passwordHash,passwordMatches,tokenFrom};
