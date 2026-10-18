const fs=require('fs'),path=require('path'),os=require('os');
const tokenPath=()=>path.join(os.homedir(),'.silentstageai','huggingface.encrypted');
function loadToken(){
  if(process.env.HF_TOKEN)return process.env.HF_TOKEN;
  try{const {safeStorage}=require('electron');if(!safeStorage?.isEncryptionAvailable())return '';return safeStorage.decryptString(fs.readFileSync(tokenPath()));}catch{return '';}
}
function saveToken(token){
  if(typeof token!=='string'||!/^hf_[a-zA-Z0-9]{10,}$/.test(token))throw Error('Token inválido.');
  const {safeStorage}=require('electron');if(!safeStorage.isEncryptionAvailable())throw Error('Proteção de credenciais indisponível.');
  fs.mkdirSync(path.dirname(tokenPath()),{recursive:true});fs.writeFileSync(tokenPath(),safeStorage.encryptString(token),{mode:0o600});
}
module.exports={loadToken,saveToken};
