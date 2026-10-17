const crypto = require('crypto');
let sessionStore = null;
let ready = () => Promise.resolve();
const local = new Map();
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
function setSessionStore(store, wait) { sessionStore = store; ready = wait || ready; }
function tokenFrom(req) {
 const header=req.headers?.authorization;
 if(header?.startsWith('Bearer '))return header.slice(7);
 const cookie=String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('vmt_admin_session='));
 return cookie?.slice(18)||req.headers?.['x-admin-token']||req.query?.token||new URL(req.url||'/','http://localhost').searchParams.get('token')||'';
}
function hashPassword(password,salt=null) {
 const generatedSalt=salt||crypto.randomBytes(16).toString('hex');
 const hash=crypto.scryptSync(password,generatedSalt,64).toString('hex');
 return {hash:'scrypt:'+hash,salt:generatedSalt};
}
function verifyPassword(password,storedHash,storedSalt) {
 if(typeof password!=='string'||password.length>128||!storedSalt||typeof storedHash!=='string')return false;
 const expected=storedHash.startsWith('scrypt:')?hashPassword(password,storedSalt).hash.slice(7):crypto.pbkdf2Sync(password,storedSalt,1000,64,'sha512').toString('hex');
 const actual=storedHash.replace(/^scrypt:/,'');const a=Buffer.from(expected),b=Buffer.from(actual);
 return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
async function createSession(user) {
 await ready();
 if(!['admin','superadmin'].includes(user.role))throw Object.assign(new Error('Acesso administrativo obrigatório.'),{status:403});
 const token=crypto.randomBytes(32).toString('hex'),id=digest(token),expiresAt=Date.now()+7*86400000;
 const record={id,userId:user.id,email:user.email,name:user.name,role:user.role,expiresAt};
 if(sessionStore)await sessionStore.transaction(tx=>tx.put('adminsession',id,record));
 else {if(process.env.NODE_ENV==='production')throw Error('Armazenamento de sessão indisponível.');local.set(id,record);}
 return {token,expiresAt};
}
async function getSession(token) {
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
 await ready();const id=digest(token);const record=sessionStore?await sessionStore.get('adminsession',id):local.get(id);
 return record&&record.expiresAt>Date.now()?record:null;
}
async function removeSession(token) {
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return;
 await ready();if(sessionStore)await sessionStore.transaction(tx=>tx.remove('adminsession',digest(token)));else local.delete(digest(token));
}
async function revokeUserSessions(email) {
 await ready();if(sessionStore)await sessionStore.transaction(async tx=>{for(const s of await tx.list('adminsession',{email}))await tx.remove('adminsession',s.id)});
 else for(const [id,s]of local)if(s.email===email)local.delete(id);
}
async function requireAuth(req,res,next) {
 try{const session=await getSession(tokenFrom(req));if(!session)return res.status(401).json({error:'Não autorizado. Faça login para continuar.'});req.user=session;next()}
 catch{return res.status(503).json({error:'Autenticação temporariamente indisponível.'})}
}
module.exports={hashPassword,verifyPassword,createSession,getSession,removeSession,revokeUserSessions,requireAuth,setSessionStore,tokenFrom};
