const { Pool } = require('pg');

let pool = null;
const memoryStore = {
  rooms: new Map(),
  transcripts: []
};

function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL não configurada. Operando em modo In-Memory (ótimo para testes locais).');
    return null;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        host_key VARCHAR(128) NOT NULL,
        source_language VARCHAR(10) DEFAULT 'pt-BR',
        target_languages TEXT[] DEFAULT ARRAY['en', 'es'],
        glossary JSONB DEFAULT '{}'::jsonb,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transcripts (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(64) REFERENCES rooms(id) ON DELETE CASCADE,
        source_text TEXT NOT NULL,
        translations JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `).then(() => {
      console.log('[DB] Tabelas PostgreSQL inicializadas com sucesso.');
    }).catch(err => {
      console.error('[DB] Erro ao inicializar tabelas PostgreSQL:', err.message);
    });

    return pool;
  } catch (err) {
    console.error('[DB] Falha ao conectar ao PostgreSQL:', err.message);
    return null;
  }
}

async function saveRoom(room) {
  memoryStore.rooms.set(room.id, room);
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO rooms (id, name, host_key, source_language, target_languages, glossary, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           source_language = EXCLUDED.source_language,
           target_languages = EXCLUDED.target_languages,
           glossary = EXCLUDED.glossary,
           status = EXCLUDED.status`,
        [room.id, room.name, room.host_key, room.source_language, room.target_languages, JSON.stringify(room.glossary || {}), room.status]
      );
    } catch (e) {
      console.error('[DB] Erro ao persistir sala no Postgres:', e.message);
    }
  }
  return room;
}

async function getRoom(roomId) {
  if (memoryStore.rooms.has(roomId)) {
    return memoryStore.rooms.get(roomId);
  }
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        memoryStore.rooms.set(roomId, row);
        return row;
      }
    } catch (e) {
      console.error('[DB] Erro ao consultar sala:', e.message);
    }
  }
  return null;
}

async function saveTranscript(roomId, sourceText, translations = {}) {
  const item = { roomId, sourceText, translations, createdAt: new Date() };
  memoryStore.transcripts.push(item);
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO transcripts (room_id, source_text, translations) VALUES ($1, $2, $3)',
        [roomId, sourceText, JSON.stringify(translations)]
      );
    } catch (e) {
      console.error('[DB] Erro ao persistir transcrição:', e.message);
    }
  }
  return item;
}

async function getTranscripts(roomId, limit = 50) {
  if (pool) {
    try {
      const res = await pool.query(
        'SELECT * FROM transcripts WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2',
        [roomId, limit]
      );
      return res.rows.reverse();
    } catch (e) {
      console.error('[DB] Erro ao buscar transcrições:', e.message);
    }
  }
  return memoryStore.transcripts.filter(t => t.roomId === roomId).slice(-limit);
}

module.exports = {
  initDb,
  saveRoom,
  getRoom,
  saveTranscript,
  getTranscripts
};
