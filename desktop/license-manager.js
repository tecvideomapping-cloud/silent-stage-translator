const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
class LicenseManager{
 constructor(storagePath=process.env.VMT_LICENSE_PATH||path.join(os.homedir(),'.silent-stage','license.json')){this.storagePath=storagePath;this.currentLease=null;this.loadLocalLease()}
 verifySignature(payload){
  try{const key=process.env.VMT_LICENSE_PUBLIC_KEY;if(!key||!payload||typeof payload!=='object'||typeof payload.signature!=='string')return false;
   const {signature,...grant}=payload;if(!Number.isFinite(grant.hoursTotal)||grant.hoursTotal<=0||grant.hoursTotal>720||!Number.isFinite(Date.parse(grant.expiresAt))||typeof grant.eventId!=='string'||!Array.isArray(grant.languages)||!Number.isInteger(grant.maxListeners)||grant.maxListeners<1)return false;
   const sig=Buffer.from(signature,'base64');if(sig.length!==64)return false;
   return crypto.verify(null,Buffer.from(JSON.stringify(grant)),key.replace(/\\n/g,'\n'),sig);
  }catch{return false}
 }
 loadLocalLease(){try{const value=JSON.parse(fs.readFileSync(this.storagePath,'utf8'));if(this.verifySignature(value))this.currentLease=value;}catch{}return this.currentLease}
 activateLicense(value){let grant;try{grant=typeof value==='string'?JSON.parse(value):value}catch{return{success:false,error:'Use uma licença assinada emitida para o seu evento. Chaves avulsas não são aceitas.'}}
  if(!this.verifySignature(grant))return{success:false,error:'Assinatura criptográfica da licença inválida.'};
  if(Date.parse(grant.expiresAt)<=Date.now())return{success:false,error:'Licença expirada.'};
  const fingerprint=require('./hardware-probe').getHardwareFingerprint();if(grant.fingerprint!==fingerprint)return{success:false,error:'Licença vinculada a outra instalação.'};
  try{fs.mkdirSync(path.dirname(this.storagePath),{recursive:true});fs.writeFileSync(this.storagePath,JSON.stringify(grant),{encoding:'utf8',mode:0o600});this.currentLease=structuredClone(grant);return{success:true,lease:this.getStatus()}}catch{return{success:false,error:'Não foi possível salvar a licença no diretório de dados do usuário.'}}
 }
 getStatus(){const grant=this.currentLease;if(!grant)return{isActive:false,mode:'unlicensed',trialAvailable:false,hoursRemaining:0,message:'Contrate e acompanhe o plano na área do cliente. O saldo é controlado pelo evento.'};const active=this.verifySignature(grant)&&Date.parse(grant.expiresAt)>Date.now();return{...grant,signature:undefined,isActive:active,mode:'signed_entitlement',hoursRemaining:grant.hoursTotal,message:'Comprovante assinado. O consumo e o saldo atual são consultados na área do evento.'}}
 // A desktop file is never an authority for financial credits or consumption.
 consumeTransmissionSeconds(){return{allowed:false,reason:'O saldo é controlado pelo servidor do evento. Conecte-se ao evento contratado.'}}
 addHoursCredit(){throw new Error('Créditos só são liberados pelo pagamento confirmado do evento.')}
}
module.exports=new LicenseManager();
