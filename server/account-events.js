'use strict';
const db=require('./db');
const fail=(status,message)=>Object.assign(new Error(message),{status});
async function balance(commerce,customer,tx=commerce.store){
 if(!customer?.legacyClientId)return null;
 const client=await db.getClient(customer.legacyClientId,tx);if(!client)return null;
 const totalSeconds=Number(client.total_hours)*3600,usedSeconds=Number(client.used_hours)*3600;
 return {clientId:client.id,plan:client.plan,totalSeconds,usedSeconds,remainingSeconds:Math.max(0,totalSeconds-usedSeconds),maxRooms:client.max_rooms,maxParticipants:client.max_listeners,expiresAt:client.license_expires_at||null,active:client.status==='active'&&['active','trial'].includes(client.license_status)&&(!client.license_expires_at||Date.parse(client.license_expires_at)>Date.now())};
}
async function funding(commerce,event,tx=commerce.store){
 if(event.fundingType!=='account')return tx.get('order',event.orderId);
 const customer=await tx.get('customer',event.customerId),account=await balance(commerce,customer,tx);
 const linked=account&&Number(event.fundingClientId)===Number(account.clientId);
 return {status:linked&&account.active?'paid':'unfunded',account:linked?account:null,plan:{id:'account',name:linked?account.plan:'Sem pacote vinculado',hours:linked?account.totalSeconds/3600:0,maxParticipants:linked?account.maxParticipants:0,maxLanguages:11}};
}
async function charge(commerce,event,seconds,tx){
 const source=await funding(commerce,event,tx);if(source.status!=='paid'||!source.account||source.account.remainingSeconds+0.0001<seconds)return false;
 const client=await db.getClient(source.account.clientId,tx);
 // The same transaction/lock protects the shared balance of simultaneous events.
 await db.saveClient({...client,used_hours:Math.min(Number(client.total_hours),Number(client.used_hours)+seconds/3600)},tx);
 return true;
}
function validateActive(source){if(source?.status!=='paid'||source.account&&(!source.account.active||source.account.remainingSeconds<=0))throw fail(409,'Vincule um pacote de horas válido e com saldo antes de ativar o evento.');}
module.exports={balance,funding,charge,validateActive};
