const allowed = () => new Set([process.env.APP_BASE_URL,...String(process.env.ALLOWED_ORIGINS||'').split(','),process.env.RAILWAY_PUBLIC_DOMAIN&&'https://'+process.env.RAILWAY_PUBLIC_DOMAIN].filter(Boolean).map(x=>{try{return new URL(x).origin}catch{return ''}}));
function isAllowed(origin){if(!origin)return true;try{const u=new URL(origin);return allowed().has(u.origin)||process.env.NODE_ENV!=='production'&&['localhost','127.0.0.1'].includes(u.hostname)}catch{return false}}
function corsOrigin(origin,cb){cb(null,isAllowed(origin))}
function headers(req,res,next){
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');
 res.setHeader('Permissions-Policy','camera=(), microphone=(self), display-capture=(self)');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' blob: data: https:; connect-src 'self' https: wss: ws:; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
 if(req.secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
 if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.get('origin')&&!isAllowed(req.get('origin')))return res.status(403).json({error:'Origem não autorizada.'});
 next();
}
module.exports={headers,corsOrigin,isAllowed};
