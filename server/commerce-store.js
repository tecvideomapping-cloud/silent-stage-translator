const { Pool } = require('pg');

// A small transactional ledger, separate from the existing event tables. All
// payment/provisioning writes share one advisory lock, including across replicas.
class CommerceStore {
  constructor({ pool = null, memory = false } = {}) {
    this.pool = pool;
    this.persistent = !!pool;
    this.memory = new Map();
    this.assets = new Map();
    this.queue = Promise.resolve();
    this.allowMemory = memory;
  }
  async init() {
    if (!this.pool && process.env.DATABASE_URL) {
      const isSsl = !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1') && (
        process.env.NODE_ENV === 'production' ||
        process.env.DATABASE_URL.includes('sslmode=') ||
        process.env.DATABASE_URL.includes('.supabase.') ||
        process.env.DATABASE_URL.includes('.neon.') ||
        process.env.DATABASE_URL.includes('.railway.') ||
        process.env.DATABASE_URL.includes('pooler.') ||
        process.env.DATABASE_URL.includes('render.com')
      );
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: isSsl ? { rejectUnauthorized: false } : false
      });
      this.persistent = true;
    }
    if (!this.pool) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS self_service_records (
          kind TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(kind,id)
        );
        CREATE INDEX IF NOT EXISTS self_service_customer_idx ON self_service_records ((data->>'customerId'));
        CREATE INDEX IF NOT EXISTS self_service_order_idx ON self_service_records ((data->>'orderId'));
        CREATE TABLE IF NOT EXISTS self_service_assets (
          id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, event_id TEXT NOT NULL,
          kind TEXT NOT NULL, mime TEXT NOT NULL, bytes BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    } catch (err) {
      console.warn('[CommerceStore] Falha ao inicializar tabelas PostgreSQL, operando em memória:', err.message);
      this.pool = null;
      this.persistent = false;
    }
  }
  async get(kind, id) {
    if (this.pool) {
      try {
        return (await this.pool.query('SELECT data FROM self_service_records WHERE kind=$1 AND id=$2', [kind,id])).rows[0]?.data || null;
      } catch (err) {
        console.warn(`[CommerceStore] Falha no get(${kind}, ${id}) PostgreSQL, consultando memória:`, err.message);
      }
    }
    return structuredClone(this.memory.get(`${kind}:${id}`) || null);
  }
  async list(kind, filter = {}) {
    if (this.pool) {
      try {
        return (await this.pool.query('SELECT data FROM self_service_records WHERE kind=$1 AND data @> $2::jsonb ORDER BY updated_at DESC', [kind,JSON.stringify(filter)])).rows.map(r=>r.data);
      } catch (err) {
        console.warn(`[CommerceStore] Falha no list(${kind}) PostgreSQL, consultando memória:`, err.message);
      }
    }
    return Array.from(this.memory.entries()).filter(([key,value])=>key.startsWith(kind+':') && Object.entries(filter).every(([k,v])=>value[k]===v)).map(([,v])=>structuredClone(v));
  }
  async asset(id) {
    if (this.pool) {
      try {
        return (await this.pool.query('SELECT id,event_id,mime,bytes FROM self_service_assets WHERE id=$1', [id])).rows[0] || null;
      } catch (err) {
        console.warn(`[CommerceStore] Falha no asset(${id}) PostgreSQL, consultando memória:`, err.message);
      }
    }
    return this.assets.get(id) || null;
  }
  async runInMemoryTransaction(fn) {
    const run = async () => {
      const next = new Map(Array.from(this.memory, ([k, v]) => [k, structuredClone(v)]));
      const assets = new Map(this.assets);
      const tx = {
        get: async (k, id) => structuredClone(next.get(`${k}:${id}`) || null),
        list: async (k, filter = {}) => Array.from(next).filter(([key, v]) => key.startsWith(k + ':') && Object.entries(filter).every(([a, b]) => v[a] === b)).map(([, v]) => structuredClone(v)),
        put: async (k, id, data) => { next.set(`${k}:${id}`, structuredClone(data)); },
        remove: async (k, id) => { next.delete(`${k}:${id}`); },
        asset: async a => { assets.set(a.id, { id: a.id, event_id: a.eventId, mime: a.mime, bytes: a.bytes }); },
        query: (sql, args) => null
      };
      const result = await fn(tx);
      this.memory = next;
      this.assets = assets;
      return result;
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }
  async transaction(fn) {
    if (this.pool) {
      let client;
      try {
        client = await this.pool.connect();
      } catch (connErr) {
        console.warn('[CommerceStore] Falha ao conectar no PostgreSQL, executando transação em memória:', connErr.message);
        return this.runInMemoryTransaction(fn);
      }
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(754824129)");
        const tx = {
          get:async(kind,id)=>(await client.query('SELECT data FROM self_service_records WHERE kind=$1 AND id=$2 FOR UPDATE',[kind,id])).rows[0]?.data || null,
          list:async(kind,filter={})=>(await client.query('SELECT data FROM self_service_records WHERE kind=$1 AND data @> $2::jsonb',[kind,JSON.stringify(filter)])).rows.map(r=>r.data),
          put:async(kind,id,data)=>{await client.query('INSERT INTO self_service_records(kind,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()',[kind,id,JSON.stringify(data)]);},
          remove:async(kind,id)=>{await client.query('DELETE FROM self_service_records WHERE kind=$1 AND id=$2',[kind,id]);},
          asset:async a=>{await client.query('INSERT INTO self_service_assets(id,customer_id,event_id,kind,mime,bytes) VALUES($1,$2,$3,$4,$5,$6)',[a.id,a.customerId,a.eventId,a.kind,a.mime,a.bytes]);},
          query:(sql,args)=>client.query(sql,args)
        };
        const result=await fn(tx); await client.query('COMMIT'); return result;
      } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
      finally { client.release(); }
    }
    return this.runInMemoryTransaction(fn);
  }
  async close() { if(this.pool)await this.pool.end().catch(()=>{}); }
}
module.exports={CommerceStore};
