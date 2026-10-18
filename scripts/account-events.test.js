const {test}=require('node:test'),assert=require('node:assert/strict');
for(const k of ['DATABASE_URL','REDIS_URL','APP_BASE_URL','OPENAI_API_KEY','DEEPGRAM_API_KEY'])delete process.env[k];process.env.NODE_ENV='development';process.env.ADMIN_PASSWORD='Account-Events-QA-2026!';
const {server,wss,commerce}=require('../server/index'),db=require('../server/db');
test('customer drafts, own account funding, shared consumption and activation guards',async t=>{
 await commerce.ready;await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{commerce.stopWorkers();for(const c of wss.clients)c.terminate();await new Promise(r=>server.close(r));});const base='http://127.0.0.1:'+server.address().port;
 async function call(path,method='GET',body,session){const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(session?{'X-Session-Token':session.token,'X-CSRF-Token':session.csrfToken}: {})},body:body===undefined?undefined:JSON.stringify(body)});return {...await r.json(),status:r.status};}
 const user=await call('/customer/register','POST',{name:'Account QA',email:'account-events@example.test',password:'Account-Events-2026!'});assert.equal(user.status,201);
 const draft=await call('/customer/events','POST',{name:'Sem pacote',fundingClientId:999},user);assert.equal(draft.status,201);const id=draft.event.id;assert.equal(draft.event.packageLinked,false);assert.equal(draft.event.published,false);assert.equal(draft.event.status,'unfunded');assert.equal(draft.event.hostKey,undefined);
 assert.equal((await call('/customer/events/'+id,'PATCH',{name:'Personalizado',primaryColor:'#123456',targetLanguages:['en']},user)).status,200);
 assert.equal((await call('/customer/events/'+id+'/publish','POST',{published:true},user)).status,409);
 await assert.rejects(commerce.acquireSocket({headers:{'x-session-token':user.token}},id,'host','original'),/ativo/);
 const other=await call('/customer/register','POST',{name:'Other QA',email:'account-other@example.test',password:'Account-Other-2026!'});
 assert.equal((await call('/customer/events/'+id+'/funding','POST',{},other)).status,404);
 assert.equal((await call('/customer/events/'+id+'/funding','POST',{},user)).status,409);
 const account=await db.saveClient({name:'Account QA',company:'QA',email:'account-events@example.test',total_hours:1,used_hours:0,max_rooms:2,max_listeners:2,status:'active',license_status:'active'});
 assert.equal((await call('/customer/events/'+id+'/funding','POST',{},user)).status,200);
 const second=await call('/customer/events','POST',{name:'Segundo',useAccountBalance:true},user);assert.equal(second.status,201);assert.equal(second.event.packageLinked,true);
 assert.equal((await call('/customer/events','POST',{name:'Excesso'},user)).status,409);
 assert.equal((await call('/customer/events/'+id+'/publish','POST',{published:true},user)).status,200);assert.equal((await call('/customer/events/'+second.event.id+'/publish','POST',{published:true},user)).status,200);
 assert.equal((await call('/rooms/'+id)).status,200,'published participant must load its room');
 await commerce.acquireSocket({},id,'listener','original');await commerce.acquireSocket({},second.event.id,'listener','original');await assert.rejects(commerce.acquireSocket({},second.event.id,'listener','original'),/limite de participantes/);
 const request={headers:{'x-session-token':user.token}},a=await commerce.acquireSocket(request,id,'host','original'),b=await commerce.acquireSocket(request,second.event.id,'host','original');
 assert.deepEqual(await Promise.all([commerce.consumeSocket(a),commerce.consumeSocket(a),commerce.consumeSocket(b)]),[true,true,true]);
 assert.ok(Math.abs((await db.getClient(account.id)).used_hours*3600-10)<0.001,'concurrent events share consumption and duplicate frames do not double charge');
 const view=await call('/customer/events','GET',undefined,user);assert.ok(Math.abs(view.accountBalance.remainingSeconds-3590)<0.001);assert.ok(view.events.every(e=>Math.abs(e.remainingSeconds-3590)<0.001));assert.equal((await call('/customer/events/'+id+'/usage','GET',undefined,user)).status,200);
 await db.saveClient({id:account.id,used_hours:1});assert.equal((await call('/customer/events/'+id+'/publish','POST',{published:true},user)).status,409);assert.equal((await call('/rooms/'+id)).status,403);assert.equal(await commerce.refreshSocket(a),false);a.budgetUntil=0;await commerce.store.transaction(async tx=>{const lease=await tx.get('connection',a.leaseId);lease.budgetUntil=0;await tx.put('connection',lease.id,lease);});assert.equal(await commerce.consumeSocket(a),false);
 assert.equal((await call('/customer/events/'+id+'/publish','POST',{published:false},user)).status,200,'deactivation remains available with exhausted balance');
 await db.saveClient({id:account.id,used_hours:0,license_expires_at:new Date(Date.now()-1000).toISOString()});await assert.rejects(commerce.checkEventAccess({},id),/ativo/);
 assert.equal((await call('/customer/events','POST',{name:'Unauthenticated'})).status,401);
});

