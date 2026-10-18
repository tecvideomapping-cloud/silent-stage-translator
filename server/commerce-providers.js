const crypto=require('crypto');
const escapeHtml=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

class MercadoPagoProvider {
  constructor(env=process.env,fetcher=fetch){this.env=env;this.fetch=fetcher;}
  get configured(){return !!(this.env.MERCADOPAGO_ACCESS_TOKEN&&this.env.MERCADOPAGO_WEBHOOK_SECRET);}
  async request(path,options={}) {
    const response=await this.fetch('https://api.mercadopago.com'+path,{...options,headers:{Authorization:'Bearer '+this.env.MERCADOPAGO_ACCESS_TOKEN,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Não foi possível consultar o pagamento. Tente novamente.');
    return response.json();
  }
  async createCheckout(order,customer,baseUrl){
    const data=await this.request('/checkout/preferences',{method:'POST',headers:{'X-Idempotency-Key':order.id},body:JSON.stringify({
      items:[{id:order.plan.id,title:`${order.plan.name} · ${order.eventName}`,description:order.plan.description,quantity:1,currency_id:'BRL',unit_price:order.amountCents/100}],
      payer:{name:customer.name,email:customer.email},external_reference:order.id,
      notification_url:baseUrl+'/api/payments/mercadopago/webhook',
      back_urls:Object.fromEntries(['success','pending','failure'].map(result=>[result,baseUrl+`/checkout.html?order=${order.id}&result=${result}`])),
      auto_return:'approved',expires:true,expiration_date_to:new Date(Date.now()+24*3600000).toISOString(),
      metadata:{order_id:order.id,customer_id:customer.id},statement_descriptor:'SILENT STAGE'
    })});
    const url=this.env.MERCADOPAGO_SANDBOX==='true'?data.sandbox_init_point:data.init_point;
    const parsed=new URL(url);if(parsed.protocol!=='https:'||!/(^|\.)mercadopago\.(com|com\.br)$/.test(parsed.hostname))throw new Error('Endereço de pagamento inválido.');
    return {id:data.id,url};
  }
  verifyNotification(req){
    const id=String(req.query['data.id']||'').toLowerCase();
    const requestId=req.get('x-request-id');
    const fields=String(req.get('x-signature')||'').split(',').map(x=>x.trim().split('='));
    const signature=Object.fromEntries(fields);const ts=signature.ts,v1=signature.v1;
    if(!this.env.MERCADOPAGO_WEBHOOK_SECRET||!id||!requestId||!/^\d+$/.test(ts||'')||!/^[a-f0-9]{64}$/i.test(v1||''))return null;
    // Official manifest: use the ID from the query string, never the unsigned body.
    const manifest=`id:${id};request-id:${requestId};ts:${ts};`;
    const expected=crypto.createHmac('sha256',this.env.MERCADOPAGO_WEBHOOK_SECRET).update(manifest).digest();
    return crypto.timingSafeEqual(expected,Buffer.from(v1,'hex'))?id:null;
  }
  getPayment(id){if(!/^\d+$/.test(String(id)))throw new Error('ID de pagamento inválido.');return this.request('/v1/payments/'+encodeURIComponent(id));}
}

class ResendMailer {
  constructor(env=process.env,fetcher=fetch){this.env=env;this.fetch=fetcher;}
  get configured(){return !!(this.env.RESEND_API_KEY&&this.env.EMAIL_FROM);}
  async send(message,key){
    if(!this.configured)throw new Error('Resend não configurado.');
    const response=await this.fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+this.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:this.env.EMAIL_FROM,to:[message.to],subject:message.subject,html:message.html,text:message.text}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Resend retornou erro '+response.status);
    return response.json();
  }
}
function purchaseEmail(order,customer,event,baseUrl){
 const portal=baseUrl+'/customer.html?order='+order.id;
 const participants=baseUrl+'/?room='+encodeURIComponent(event.id);
 const text=`Olá, ${customer.name}!\n\nPagamento confirmado: ${order.plan.name}.\nEvento: ${event.name}.\nPedido: ${order.id}.\n\nAcesse sua área com o e-mail usado na compra e a senha que você criou: ${portal}\n\n1. Envie seu logo e banner.\n2. Escolha as cores e idiomas.\n3. Publique o evento para liberar os participantes.\n4. Abra o estúdio na sua área para transmitir o áudio.\n\nLink dos participantes (disponível após publicação): ${participants}\n\nPlano: ${order.plan.hours} horas de transmissão; ${order.plan.maxParticipants??'sem limite de'} participantes simultâneos; até ${order.plan.maxLanguages} idiomas de tradução.\n\nNunca compartilhe seu acesso de operador. Se não lembrar sua senha, use Recuperar acesso na área do cliente.`;
 return {to:customer.email,subject:'Seu evento está pronto para personalizar · Silent Stage',text,html:`<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#242137"><p style="font-family:Arial,sans-serif;font-size:20px;font-weight:700;color:#242137"><img src="${escapeHtml(baseUrl+'/brand/silent-stage-icon-192.png')}" width="40" height="40" alt="" style="vertical-align:middle;border-radius:10px;margin-right:10px">Silent Stage</p><h1 style="font-size:26px">Seu próximo encontro começa aqui.</h1><p>Olá, ${escapeHtml(customer.name)}. O pagamento do plano <strong>${escapeHtml(order.plan.name)}</strong> foi confirmado.</p><p><strong>${escapeHtml(event.name)}</strong></p><ol><li>Envie seu logo e banner.</li><li>Escolha suas cores e idiomas.</li><li>Publique e compartilhe o link com os participantes.</li><li>Abra o estúdio para transmitir o áudio.</li></ol><p><a href="${escapeHtml(portal)}" style="display:inline-block;padding:14px 20px;background:#7250d6;color:white;border-radius:10px;text-decoration:none">Personalizar meu evento</a></p><p>Entre com o e-mail da compra e a senha que você criou. Nunca enviamos senhas por e-mail.</p><p>Link dos participantes, após a publicação:<br><a href="${escapeHtml(participants)}">${escapeHtml(participants)}</a></p><p>${order.plan.hours} horas de transmissão · ${order.plan.maxParticipants??'Sem limite de'} participantes · Até ${order.plan.maxLanguages} idiomas</p><p style="font-size:12px;color:#6f687f">Pedido ${escapeHtml(order.id)} · Silent Stage</p></div>`};
}
module.exports={MercadoPagoProvider,ResendMailer,purchaseEmail,escapeHtml};
