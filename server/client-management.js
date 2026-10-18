const crypto=require('crypto');
const {passwordHash}=require('./commerce');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const positiveId=value=>{if(!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)>2147483647)throw fail(400,'Identificador inválido.');return Number(value);};
function validateClient(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Cadastro inválido.');
 const result={};
 for(const [key,max] of Object.entries({name:160,company:255,email:254,phone:50,cnpj_cpf:50,notes:5000,plan:100}))if(input[key]!==undefined){if(typeof input[key]!=='string'||input[key].length>max)throw fail(400,'Campo inválido: '+key);result[key]=input[key].trim();}
 if(result.email){result.email=result.email.toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))throw fail(400,'Informe um e-mail válido.');}
 for(const [key,max] of Object.entries({total_hours:9999,used_hours:9999,max_rooms:10000,max_listeners:1000000}))if(input[key]!==undefined){const n=Number(input[key]);if(input[key]===null||input[key]===''||!Number.isFinite(n)||n<0||n>max||key.startsWith('max_')&&(!Number.isInteger(n)||n<1))throw fail(400,'Limite inválido: '+key);result[key]=n;}
 for(const [key,allowed] of Object.entries({status:['active','inactive','suspended'],license_status:['active','trial','suspended','expired']}))if(input[key]!==undefined){if(!allowed.includes(input[key]))throw fail(400,'Status inválido.');result[key]=input[key];}
 if(input.license_expires_at!==undefined){if(input.license_expires_at!==null&&input.license_expires_at!==''&&!Number.isFinite(Date.parse(input.license_expires_at)))throw fail(400,'Data de validade inválida.');result.license_expires_at=input.license_expires_at?new Date(input.license_expires_at).toISOString():null;}
 if(input.password!==undefined&&input.password!==''){if(typeof input.password!=='string'||input.password.length<10||input.password.length>128||input.password!==input.password.trim())throw fail(400,'Use uma senha de 10 a 128 caracteres, sem espaços nas extremidades.');result.password=input.password;}
 return result;
}
class ClientManagement {
 constructor(db,commerce){this.db=db;this.commerce=commerce;}
 async save(input,id=null){
  await this.commerce.readyOrFail();
  const current=id?await this.db.getClient(positiveId(id)):null;if(id&&!current)throw fail(404,'Cliente não encontrado.');
  const patch=validateClient(input),merged={total_hours:10,used_hours:0,status:'active',license_status:'active',...current,...patch};
  if(!merged.name&&!merged.company)throw fail(400,'Informe o nome ou a empresa do cliente.');
  if(patch.password&&!merged.email)throw fail(400,'Informe o e-mail para criar o acesso do cliente.');
  if(merged.used_hours>merged.total_hours)throw fail(400,'As horas utilizadas não podem superar o total contratado.');
  const duplicate=merged.email&&await this.db.getClientByEmail(merged.email);
  if(duplicate&&duplicate.id!==current?.id)throw fail(409,'Já existe um cliente com esse e-mail.');
  // Hash before taking the database lock; never block the audio event loop.
  const hash=patch.password?await passwordHash(patch.password):null;
  return this.commerce.store.transaction(async tx=>{
   if(current){Object.assign(merged,await this.db.getClient(current.id,tx),patch);if(merged.used_hours>merged.total_hours)throw fail(400,'As horas utilizadas não podem superar o total contratado.');}
   const linked=current&&(await tx.list('customer',{legacyClientId:current.id}))[0];
   const previousMapping=current?.email?await tx.get('email',current.email.toLowerCase()):null;
   let customer=linked||(previousMapping?await tx.get('customer',previousMapping.customerId):null);
   const mapping=merged.email?await tx.get('email',merged.email):null;
   if(mapping&&customer&&mapping.customerId!==customer.id)throw fail(409,'Este e-mail já pertence a outra conta.');
   if(mapping&&!customer){customer=await tx.get('customer',mapping.customerId);if(customer?.legacyClientId&&customer.legacyClientId!==current?.id&&await this.db.getClient(customer.legacyClientId))throw fail(409,'Este e-mail já pertence a outro cliente.');}
   if(customer&&!merged.email)throw fail(400,'O e-mail é obrigatório para uma conta com acesso ao portal.');
   const duplicate=merged.email&&await this.db.getClientByEmail(merged.email,tx);
   if(duplicate&&duplicate.id!==current?.id)throw fail(409,'Já existe um cliente com esse e-mail.');
   const saved=await this.db.saveClient(merged,tx);
   if(customer||hash){
    const previousEmail=customer?.email;
    customer=customer||{id:crypto.randomUUID(),passwordVersion:0,createdAt:new Date().toISOString()};
    Object.assign(customer,{legacyClientId:saved.id,name:saved.name||saved.company,email:saved.email,company:saved.company||'',phone:saved.phone||''});
    if(hash){customer.passwordHash=hash;customer.passwordVersion=(customer.passwordVersion||0)+1;}
    if(previousEmail&&previousEmail!==saved.email){const old=await tx.get('email',previousEmail);if(old?.customerId===customer.id)await tx.remove('email',previousEmail);}
    await tx.put('customer',customer.id,customer);await tx.put('email',customer.email,{customerId:customer.id});
    if(hash||previousEmail&&previousEmail!==saved.email)for(const session of await tx.list('session',{customerId:customer.id}))await tx.remove('session',session.id);
   }
   return saved;
  });
 }
 async payment(id,input){
  positiveId(id);await this.commerce.readyOrFail();
  const amount=Number(input.amount_cents??Math.round(Number(input.amount)*100)),hours=Number(input.add_hours||0);
  if(!Number.isSafeInteger(amount)||amount<0||amount>1000000000||!Number.isFinite(hours)||hours<0||hours>9999)throw fail(400,'Valor ou quantidade de horas inválidos.');
  const status=input.status||'paid';if(!['paid','pending','cancelled','refunded'].includes(status))throw fail(400,'Status de pagamento inválido.');
  if(hours&&status!=='paid')throw fail(400,'Somente pagamentos confirmados podem liberar horas.');
  if(input.paid_at&&!Number.isFinite(Date.parse(input.paid_at)))throw fail(400,'Data de pagamento inválida.');
  if(!['pix','credit_card','boleto','invoice','mercadopago','other'].includes(input.method||'pix'))throw fail(400,'Forma de pagamento inválida.');
  for(const field of ['description','reference_id'])if(input[field]!==undefined&&(typeof input[field]!=='string'||input[field].length>(field==='description'?5000:100)))throw fail(400,'Referência ou descrição inválida.');
  return this.commerce.store.transaction(async tx=>{
   let client;if(tx.query){const row=(await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE',[Number(id)])).rows[0];client=row;}else client=await this.db.getClient(id);
   if(!client)throw fail(404,'Cliente não encontrado.');
   if(Number(client.total_hours)+hours>9999)throw fail(400,'O saldo de horas excede o limite permitido.');
   const payment=await this.db.saveClientPayment({client_id:id,amount_cents:amount,currency:'BRL',status,method:input.method||'pix',description:input.description||'',reference_id:input.reference_id||'',paid_at:input.paid_at},tx);
   if(hours){await this.db.saveClient({...client,total_hours:Number(client.total_hours)+hours},tx);await tx.put('client-payment-credit',String(id)+':'+payment.id,{id:String(id)+':'+payment.id,clientId:Number(id),hours});}
   return payment;
  });
 }
 async removePayment(clientId,paymentId){
  positiveId(clientId);positiveId(paymentId);await this.commerce.readyOrFail();
  return this.commerce.store.transaction(async tx=>{
   const credit=await tx.get('client-payment-credit',clientId+':'+paymentId);
   if(credit){
    let client;if(tx.query)client=(await tx.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE',[Number(clientId)])).rows[0];else client=await this.db.getClient(clientId);
    if(!client)throw fail(404,'Cliente não encontrado.');
    const total=Number(client.total_hours)-credit.hours;
    if(total<Number(client.used_hours))throw fail(409,'Essas horas já foram utilizadas. Revise o saldo antes de excluir o pagamento.');
    await this.db.saveClient({...client,total_hours:total},tx);await tx.remove('client-payment-credit',clientId+':'+paymentId);
   }
   await this.db.deleteClientPayment(paymentId,clientId,tx);
  });
 }
}
module.exports={ClientManagement,validateClient,positiveId};
