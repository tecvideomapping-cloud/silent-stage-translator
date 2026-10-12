const { Pool } = require('pg');

let pool = null;
const memoryStore = {
  rooms: new Map(),
  transcripts: [],
  leads: []
};

function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL não configurada. Operando em modo In-Memory.');
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
        banner_url TEXT DEFAULT '',
        logo_url TEXT DEFAULT '',
        primary_color VARCHAR(30) DEFAULT '#06b6d4',
        sponsors JSONB DEFAULT '[]'::jsonb,
        allow_original_audio BOOLEAN DEFAULT true,
        allow_translation BOOLEAN DEFAULT true,
        allow_subtitles BOOLEAN DEFAULT true,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT '';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT '';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS primary_color VARCHAR(30) DEFAULT '#06b6d4';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sponsors JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS allow_original_audio BOOLEAN DEFAULT true;
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS allow_translation BOOLEAN DEFAULT true;
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS allow_subtitles BOOLEAN DEFAULT true;

      CREATE TABLE IF NOT EXISTS transcripts (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(64) REFERENCES rooms(id) ON DELETE CASCADE,
        source_text TEXT NOT NULL,
        translations JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        company VARCHAR(255),
        event_type VARCHAR(100),
        estimated_hours INT DEFAULT 4,
        message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `).then(() => {
      console.log('[DB] Tabelas e campos PostgreSQL sincronizados com sucesso.');
    }).catch(err => {
      console.error('[DB] Erro ao sincronizar PostgreSQL:', err.message);
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
        `INSERT INTO rooms (
          id, name, host_key, source_language, target_languages, glossary,
          banner_url, logo_url, primary_color, sponsors,
          allow_original_audio, allow_translation, allow_subtitles, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          source_language = EXCLUDED.source_language,
          target_languages = EXCLUDED.target_languages,
          glossary = EXCLUDED.glossary,
          banner_url = EXCLUDED.banner_url,
          logo_url = EXCLUDED.logo_url,
          primary_color = EXCLUDED.primary_color,
          sponsors = EXCLUDED.sponsors,
          allow_original_audio = EXCLUDED.allow_original_audio,
          allow_translation = EXCLUDED.allow_translation,
          allow_subtitles = EXCLUDED.allow_subtitles,
          status = EXCLUDED.status`,
        [
          room.id,
          room.name,
          room.host_key,
          room.source_language || 'pt-BR',
          room.target_languages || ['en', 'es'],
          JSON.stringify(room.glossary || {}),
          room.banner_url || '',
          room.logo_url || '',
          room.primary_color || '#06b6d4',
          JSON.stringify(room.sponsors || []),
          room.allow_original_audio !== false,
          room.allow_translation !== false,
          room.allow_subtitles !== false,
          room.status || 'active'
        ]
      );
    } catch (e) {
      console.error('[DB] Erro ao salvar sala no Postgres:', e.message);
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

async function listRooms() {
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM rooms ORDER BY created_at DESC LIMIT 100');
      return res.rows;
    } catch (e) {
      console.error('[DB] Erro ao listar salas:', e.message);
    }
  }
  return Array.from(memoryStore.rooms.values());
}

async function deleteRoom(roomId) {
  memoryStore.rooms.delete(roomId);
  if (pool) {
    try {
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      return true;
    } catch (e) {
      console.error('[DB] Erro ao deletar sala:', e.message);
    }
  }
  return false;
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
      console.error('[DB] Erro ao salvar transcrição:', e.message);
    }
  }
  return item;
}

async function getTranscripts(roomId, limit = 500) {
  if (pool) {
    try {
      const res = await pool.query(
        'SELECT * FROM transcripts WHERE room_id = $1 ORDER BY created_at ASC LIMIT $2',
        [roomId, limit]
      );
      return res.rows;
    } catch (e) {
      console.error('[DB] Erro ao buscar transcrições:', e.message);
    }
  }
  return memoryStore.transcripts.filter(t => t.roomId === roomId).slice(-limit);
}

async function saveLead(lead) {
  memoryStore.leads.push(lead);
  if (pool) {
    try {
      const res = await pool.query(
        `INSERT INTO leads (name, email, phone, company, event_type, estimated_hours, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [lead.name, lead.email, lead.phone, lead.company, lead.eventType, lead.estimatedHours || 4, lead.message]
      );
      return res.rows[0];
    } catch (e) {
      console.error('[DB] Erro ao salvar lead:', e.message);
    }
  }
  return lead;
}

async function listLeads() {
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100');
      return res.rows;
    } catch (e) {
      console.error('[DB] Erro ao listar leads:', e.message);
    }
  }
  return memoryStore.leads;
}

module.exports = {
  initDb,
  saveRoom,
  getRoom,
  listRooms,
  deleteRoom,
  saveTranscript,
  getTranscripts,
  saveLead,
  listLeads
};
