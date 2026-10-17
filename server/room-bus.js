const crypto=require('crypto');
const Redis=require('ioredis');
// Redis presence + directed delivery keeps media authorization on the owning process.
// A shadow is only a routing handle; it never authenticates or consumes credit.
class RoomBus{
 constructor({rooms,redisUrl=process.env.REDIS_URL,namespace=(process.env.RAILWAY_PROJECT_ID||'silent-stage')+':'+(process.env.RAILWAY_ENVIRONMENT_ID||'local'),sync=()=>{}}){
  this.rooms=rooms;this.sync=sync;this.instance=crypto.randomUUID();this.local=new Map();this.peers=new Map();this.channel=namespace+':room-bus:v1';this.registry=this.channel+':presence';this.healthy=!redisUrl;this.closed=false;
  if(!redisUrl){this.ready=Promise.resolve();return;}
  const options={maxRetriesPerRequest:1,connectTimeout:5000,retryStrategy:n=>Math.min(3000,n*300)};this.pub=new Redis(redisUrl,options);this.sub=new Redis(redisUrl,options);
  for(const client of [this.pub,this.sub])client.on('error',()=>{this.healthy=false});
  this.sub.on('message',(_,raw)=>{try{this.receive(JSON.parse(raw))}catch{}});
  this.ready=this.sub.subscribe(this.channel).then(async()=>{const entries=await this.pub.hgetall(this.registry);for(const [instance,value]of Object.entries(entries)){try{const p=JSON.parse(value);if(p.at>Date.now()-35000)this.presence(instance,p);else await this.pub.hdel(this.registry,instance)}catch{}}this.healthy=true;await this.announce()}).catch(()=>{this.healthy=false});
  this.timer=setInterval(()=>{this.announce().catch(()=>{this.healthy=false});for(const [instance,p]of this.peers)if(p.at<Date.now()-35000)this.presence(instance,{at:Date.now(),clients:[]})},10000);this.timer.unref();
 }
 async announce(){if(!this.pub||this.closed)return;const snapshot={at:Date.now(),clients:[...this.local.values()].filter(c=>c.readyState===1).map(c=>({id:c.clientId,room:c.roomId,role:c.role,channel:c.channel}))};await this.pub.hset(this.registry,this.instance,JSON.stringify(snapshot));await this.pub.publish(this.channel,JSON.stringify({kind:'presence',instance:this.instance,...snapshot}));this.healthy=true}
 attach(client){this.local.set(client.clientId,client);this.announce().catch(()=>{this.healthy=false})}
 detach(client){this.local.delete(client.clientId);this.announce().catch(()=>{this.healthy=false})}
 changed(){this.announce().catch(()=>{this.healthy=false})}
 presence(instance,p){if(instance===this.instance)return;const previous=this.peers.get(instance);for(const client of previous?.shadows||[]){const room=this.rooms.get(client.roomId);room?.delete(client);if(room?.size===0)this.rooms.delete(client.roomId)}
  const shadows=[];for(const value of p.clients||[]){if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.room)||!['host','listener','screen'].includes(value.role))continue;const shadow={clientId:value.id,roomId:value.room,role:value.role,channel:value.channel,readyState:1,bufferedAmount:0,remote:true,
   send:(data,options)=>this.publish({kind:'deliver',target:value.id,data:Buffer.from(data).toString('base64'),binary:!!options?.binary}),
   close:(code,reason)=>this.publish({kind:'close',target:value.id,code,reason})};if(!this.rooms.has(value.room))this.rooms.set(value.room,new Set());this.rooms.get(value.room).add(shadow);shadows.push(shadow);if(!previous?.shadows?.some(c=>c.clientId===value.id))this.sync(shadow);}
  this.peers.set(instance,{at:p.at,shadows});
 }
 publish(message){if(this.pub)this.pub.publish(this.channel,JSON.stringify({...message,instance:this.instance})).catch(()=>{this.healthy=false})}
 receive(message){if(message.instance===this.instance)return;if(message.kind==='presence')return this.presence(message.instance,message);const client=this.local.get(message.target);if(!client||client.readyState!==1)return;if(message.kind==='close'){client.close(message.code||1008,String(message.reason||''));return;}if(message.kind==='deliver'){if(client.bufferedAmount>192*1024){client.close(1013,'Conexão lenta. Reconecte.');return;}const data=Buffer.from(message.data,'base64');client.send(message.binary?data:data.toString(),{binary:message.binary});}}
 setRoomState(room,key,value){if(!this.pub)return;const name=this.channel+':room:'+room;this.pub.pipeline().hset(name,key,JSON.stringify(value)).expire(name,120).exec().catch(()=>{this.healthy=false})}
 async getRoomState(room,key){if(!this.pub)return null;try{const raw=await this.pub.hget(this.channel+':room:'+room,key);return raw?JSON.parse(raw):null}catch{this.healthy=false;return null}}
 async close(){this.closed=true;clearInterval(this.timer);if(this.pub){await this.pub.hdel(this.registry,this.instance).catch(()=>{});await this.pub.publish(this.channel,JSON.stringify({kind:'presence',instance:this.instance,at:Date.now(),clients:[]})).catch(()=>{});await Promise.allSettled([this.pub.quit(),this.sub.quit()])}for(const [id]of this.peers)this.presence(id,{at:Date.now(),clients:[]})}
}
module.exports={RoomBus};
