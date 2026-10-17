const {Pool}=require('pg');
const unavailable=()=>Object.assign(new Error('Banco de dados indisponível. Nenhuma alteração foi confirmada.'),{status:503});
class CommerceStore {
 constructor({pool=null,memory=false}={}){this.pool=pool;this.persistent=!!pool;this.allowMemory=memory;this.memory=new Map();this.assets=new Map();this.queue=Promise.resolve();this.initialized=false;}
 async init(){
  if(!this.pool&&process.env.DATABASE_URL){
   const u=new URL(process.env.DATABASE_URL),internal=/\.railway\.internal$/.test(u.hostname)||['localhost','127.0.0.1'].includes(u.hostname);
   this.pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:internal||u.searchParams.get('sslmode')==='disable'?false:{rejectUnauthorized:process.env.PG_SSL_INSECURE!=='true'},connectionTimeoutMillis:5000,max:10,idleTimeoutMillis:30000});this.pool.on('error',()=>{});this.persistent=true;
  }
  if(!this.pool){if(process.env.NODE_ENV==='production'&&!this.allowMemory)throw unavailable();this.initialized=true;return;}
  await this.pool.query(`CREATE TABLE IF NOT EXISTS self_service_records(kind TEXT NOT NULL,id TEXT NOT NULL,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(kind,id));
   CREATE INDEX IF NOT EXISTS self_service_customer_idx ON self_service_records((data->>'customerId'));
   CREATE INDEX IF NOT EXISTS self_service_order_idx ON self_service_records((data->>'orderId'));
   CREATE INDEX IF NOT EXISTS self_service_data_idx ON self_service_records USING GIN(data);
   CREATE TABLE IF NOT EXISTS self_service_assets(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,event_id TEXT NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,bytes BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  this.initialized=true;
 }
 async health(){if(!this.initialized)return false;try{if(this.pool)await this.pool.query('SELECT 1');return true}catch{return false}}
 ensure(){if(!this.initialized)throw unavailable()}
 async get(kind,id){this.ensure();if(this.pool)return(await this.pool.query('SELECT data FROM self_service_records WHERE kind=$1 AND id=$2',[kind,id])).rows[0]?.data||null;return structuredClone(this.memory.get(`${kind}:${id}`)||null)}
 async list(kind,filter={}){this.ensure();if(this.pool)return(await this.pool.query('SELECT data FROM self_service_records WHERE kind=$1 AND data @> $2::jsonb ORDER BY updated_at DESC',[kind,JSON.stringify(filter)])).rows.map(r=>r.data);return Array.from(this.memory).filter(([k,v])=>k.startsWith(kind+':')&&Object.entries(filter).every(([a,b])=>v[a]===b)).map(([,v])=>structuredClone(v))}
 async asset(id){this.ensure();if(this.pool)return(await this.pool.query('SELECT id,event_id,mime,bytes FROM self_service_assets WHERE id=$1',[id])).rows[0]||null;return this.assets.get(id)||null}
 async transaction(fn){
  this.ensure();
  if(this.pool){const client=await this.pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(754824129)');const tx={
   get:async(k,id)=>(await client.query('SELECT data FROM self_service_records WHERE kind=$1 AND id=$2 FOR UPDATE',[k,id])).rows[0]?.data||null,
   list:async(k,f={})=>(await client.query('SELECT data FROM self_service_records WHERE kind=$1 AND data @> $2::jsonb',[k,JSON.stringify(f)])).rows.map(r=>r.data),
   put:async(k,id,data)=>{await client.query('INSERT INTO self_service_records(kind,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()',[k,id,JSON.stringify(data)])},
   remove:async(k,id)=>{await client.query('DELETE FROM self_service_records WHERE kind=$1 AND id=$2',[k,id])},
   asset:async a=>{await client.query('INSERT INTO self_service_assets(id,customer_id,event_id,kind,mime,bytes) VALUES($1,$2,$3,$4,$5,$6)',[a.id,a.customerId,a.eventId,a.kind,a.mime,a.bytes])},query:(sql,args)=>client.query(sql,args)};
   const result=await fn(tx);await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}finally{client.release()}}
  const run=async()=>{const records=new Map(Array.from(this.memory,([k,v])=>[k,structuredClone(v)])),assets=new Map(this.assets);const tx={get:async(k,id)=>structuredClone(records.get(`${k}:${id}`)||null),list:async(k,f={})=>Array.from(records).filter(([key,v])=>key.startsWith(k+':')&&Object.entries(f).every(([a,b])=>v[a]===b)).map(([,v])=>structuredClone(v)),put:async(k,id,v)=>{records.set(`${k}:${id}`,structuredClone(v))},remove:async(k,id)=>{records.delete(`${k}:${id}`)},asset:async a=>{assets.set(a.id,{id:a.id,event_id:a.eventId,mime:a.mime,bytes:Buffer.from(a.bytes)})}};const result=await fn(tx);this.memory=records;this.assets=assets;return result};const job=this.queue.then(run,run);this.queue=job.catch(()=>{});return job;
 }
 async close(){if(this.pool)await this.pool.end()}
}
module.exports={CommerceStore};
