const test=require('node:test'),assert=require('node:assert/strict');
for(const key of ['DATABASE_URL','REDIS_URL','DEEPGRAM_API_KEY','RESEND_API_KEY','APP_BASE_URL'])delete process.env[key];process.env.NODE_ENV='development';
const {server,commerce,wss}=require('../server/index'),db=require('../server/db'),{aiPipeline}=require('../server/ai-pipeline'),{WebSocket}=require('ws');
test('authenticated desktop transcripts retain speaker and turn through listener and translation',async t=>{
 await commerce.ready;await db.saveRoom({id:'local-speech-wire',name:'Local speech',status:'active',target_languages:['en'],host_key:'test-key'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{commerce.stopWorkers();for(const client of wss.clients)client.terminate();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port;const auth=await(await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@videomappingtech.com',password:process.env.ADMIN_PASSWORD||'Videomapping2026!'})})).json();
 const events=[];const connect=role=>new Promise((resolve,reject)=>{const socket=new WebSocket(base.replace('http','ws')+'/?room=local-speech-wire&role='+role+'&channel=en',{headers:role==='host'?{Authorization:'Bearer '+auth.token}:{}});socket.on('error',reject);socket.on('message',raw=>{const event=JSON.parse(raw);if(event.type==='connected')resolve(socket);else events.push(event);});});
 const listener=await connect('listener'),host=await connect('host');
 aiPipeline.translateText=async(text,languages,glossary,callback)=>{callback('en','Translated');return {en:'Translated'};};
 aiPipeline.useStreaming=()=>true; // Desktop must override an available cloud recognizer.
 host.send(JSON.stringify({type:'recognition_mode',mode:'desktop-local'}));host.send(JSON.stringify({type:'speech_transcript',source:'desktop-local',text:'Pergunta',isFinal:true,speakerId:1,turnId:'session:turn:1',segmentId:'segment-1'}));
 const started=Date.now();while(!events.some(event=>event.type==='subtitle_translated')){assert.ok(Date.now()-started<5000);await new Promise(r=>setTimeout(r,10));}
 for(const type of ['subtitle','subtitle_translated']){const event=events.find(item=>item.type===type);assert.equal(event.speakerId,1);assert.ok(event.sourceId.startsWith('c_'));assert.equal(event.turnId,event.sourceId+':session:turn:1');assert.equal(event.segmentId,event.sourceId+':segment-1');}
 listener.send(JSON.stringify({type:'recognition_mode',mode:'desktop-local'}));assert.equal([...wss.clients].find(client=>client.role==='listener').localRecognition,undefined);
});
