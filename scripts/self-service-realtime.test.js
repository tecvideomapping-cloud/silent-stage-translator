const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
for(const key of ['DATABASE_URL','REDIS_URL','RESEND_API_KEY','MERCADOPAGO_ACCESS_TOKEN','MERCADOPAGO_WEBHOOK_SECRET','APP_BASE_URL'])delete process.env[key];
process.env.NODE_ENV='development';
const {WebSocket}=require('ws');
const {aiPipeline}=require('../server/ai-pipeline');
aiPipeline.feedAudio=()=>{}; // This test never contacts an AI provider.
const {server,wss,commerce}=require('../server/index');

test('servidor integrado: pagamento, publicação e permissão do transmissor',async t=>{
 await commerce.ready;await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port,base='http://127.0.0.1:'+port;const sockets=[];
 t.after(async()=>{for(const ws of wss.clients)ws.terminate();for(const ws of sockets)ws.terminate();commerce.stopWorkers();await new Promise(r=>server.close(r));});
 const registered=await fetch(base+'/api/customer/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Teste integrado',email:'realtime@example.test',password:'Teste-Seguro-2026'})});
 const session=await registered.json(),cookie=registered.headers.get('set-cookie').split(';')[0];
 const plan=await commerce.store.get('product','pocket'),order={id:crypto.randomUUID(),customerId:session.customer.id,plan,amountCents:plan.priceCents,currency:'BRL',eventName:'Palco integrado',status:'pending',createdAt:new Date().toISOString()};
 await commerce.store.transaction(tx=>tx.put('order',order.id,order));
 await commerce.processPayment({id:'98765',external_reference:order.id,transaction_amount:1200,currency_id:'BRL',live_mode:true,status:'approved',date_last_updated:new Date().toISOString()});
 const event=(await commerce.store.list('event'))[0];
 function connect(role,headers={}){return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/?roomId=${event.id}&role=${role}`,{headers});sockets.push(ws);const timer=setTimeout(()=>reject(Error('Sem confirmação de conexão')),3000);ws.on('message',(data,binary)=>{if(!binary&&JSON.parse(data).type==='connected'){clearTimeout(timer);resolve(ws);}});ws.on('close',(code,reason)=>{clearTimeout(timer);reject(Object.assign(Error(reason.toString()),{code}));});ws.on('error',reject);});}
 assert.equal((await fetch(base+'/api/rooms/'+event.id)).status,403);
 await assert.rejects(()=>connect('listener'),e=>e.code===1008);
 await assert.rejects(()=>connect('host'),e=>e.code===1008);
 const published=await fetch(base+'/api/customer/events/'+event.id+'/publish',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({published:true})});assert.equal(published.status,200);
 assert.equal((await fetch(base+'/api/rooms/'+event.id)).status,200);
 const host=await connect('host',{Cookie:cookie});
 await assert.rejects(()=>connect('host',{Cookie:cookie}),e=>e.code===1013);
 const listener=await connect('listener');const screen=await connect('screen');
 let forbiddenForwarded=false;screen.on('message',(data,binary)=>{if(!binary&&JSON.parse(data).text==='tentativa indevida')forbiddenForwarded=true;});
 listener.send(JSON.stringify({type:'speech_transcript',text:'tentativa indevida',isFinal:true}));
 const payload=Buffer.alloc(128,1);const delivered=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Áudio não chegou ao participante')),3000);listener.on('message',(data,binary)=>{if(binary){clearTimeout(timeout);resolve(data);}});});
 host.send(payload);assert.deepEqual(await delivered,payload);
 assert.equal((await commerce.store.get('event',event.id)).usedSeconds,5);
 await new Promise(r=>setTimeout(r,150));assert.equal(forbiddenForwarded,false);
 const unavailable=await fetch(base+'/api/customer/checkout',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({planId:'pocket',eventName:'Sem configuração',termsAccepted:true})});assert.equal(unavailable.status,503);
 const config=await fetch(base+'/api/config/tts-keys',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({openAiKey:'unauthorized'})});assert.equal(config.status,403);
 const publicKeyBypass=await fetch(base+'/api/rooms/'+event.id+'/glossary',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({hostKey:'admin',glossary:{test:'test'}})});assert.equal(publicKeyBypass.status,403);
 const home=await(await fetch(base+'/')).text();assert.ok(home.includes('publicProducts'));
});
