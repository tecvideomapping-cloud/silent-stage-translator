const { Pool } = require('pg');
const { hashPassword } = require('./auth');

let pool = null;
const memoryStore = {
  users: new Map(),
  clients: new Map(),
  rooms: new Map(),
  savedGlossaries: new Map(),
  transcripts: [],
  leads: []
};

const defaultGlossaryPresets = [
  {
    id: 1,
    name: 'Videomapping & Tecnologia de Eventos',
    description: 'Termos de projeção mapeada, áudio profissional e palco silencioso',
    category: 'Tecnologia & Eventos',
    terms: {
      'Videomappingtech': 'Marca registrada - não traduzir',
      'Silent Stage': 'Palco Silencioso',
      'Keynote': 'Palestra Magna',
      'Line Array': 'Sistema de Caixas Acústicas Line Array',
      'Sidecar': 'Módulo Auxiliar',
      'Prompt': 'Instrução de IA',
      'Chroma Key': 'Fundo Verde de Recorte',
      'Breakout Room': 'Sala Temática / Sala de Apoio'
    },
    created_at: new Date()
  },
  {
    id: 2,
    name: 'Corporativo, Negócios & Finanças',
    description: 'Jargões empresariais, siglas executivas e governança',
    category: 'Corporativo',
    terms: {
      'B2B': 'Business-to-Business',
      'Stakeholder': 'Parte Interessada / Acionista',
      'ROI': 'Retorno sobre Investimento',
      'Briefing': 'Alinhamento de Requisitos',
      'Pitch': 'Apresentação Rápida de Negócios',
      'EBITDA': 'Lucro antes de Juros, Impostos e Depreciação',
      'Compliance': 'Conformidade e Ética Corporativa'
    },
    created_at: new Date()
  },
  {
    id: 3,
    name: 'Inteligência Artificial & TI',
    description: 'Vocabulário técnico de modelos de linguagem, computação e nuvem',
    category: 'Inteligência Artificial',
    terms: {
      'LLM': 'Modelo de Linguagem Amplo',
      'Fine-Tuning': 'Ajuste Fino de Modelo',
      'Zero-Shot': 'Inferência sem Treinamento Prévio',
      'Embeddings': 'Vetores Semânticos',
      'Latency': 'Latência de Rede',
      'Throughput': 'Capacidade de Processamento',
      'Pipeline': 'Fluxo Automatizado de Dados'
    },
    created_at: new Date()
  },
  {
    id: 4,
    name: 'Medicina, Saúde & Farma',
    description: 'Terminologias de ensaios clínicos, farmacologia e saúde',
    category: 'Saúde & Medicina',
    terms: {
      'Randomized Trial': 'Ensaio Clínico Randomizado',
      'Double-Blind': 'Duplo-Cego',
      'Adverse Event': 'Evento Adverso',
      'Peer-Reviewed': 'Revisado por Pares',
      'Placebo-Controlled': 'Controlado por Placebo',
      'Protocol': 'Protocolo Clínico'
    },
    created_at: new Date()
  }
];

// Carrega presets na memória
defaultGlossaryPresets.forEach(g => memoryStore.savedGlossaries.set(g.id, g));

async function initDb() {
  // Inicializa usuário admin em memória
  const bootstrapPassword = process.env.ADMIN_PASSWORD || 'Videomapping2026!';
  const defaultAdminPass = hashPassword(bootstrapPassword);
  const defaultAdmin = {
    id: 1,
    email: (process.env.ADMIN_EMAIL || 'admin@videomappingtech.com').toLowerCase().trim(),
    password_hash: defaultAdminPass.hash,
    password_salt: defaultAdminPass.salt,
    name: 'Administrador Videomappingtech',
    role: 'superadmin',
    created_at: new Date()
  };
  memoryStore.users.set(defaultAdmin.email, defaultAdmin);

  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL não configurada. Operando em modo In-Memory.');
    return null;
  }

  try {
    const connectionString = process.env.DATABASE_URL;
    const explicitlyDisabled = connectionString.includes('sslmode=disable');
    const isInternalHost = connectionString.includes('.railway.internal') || connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
    const shouldTrySsl = !explicitlyDisabled && !isInternalHost && (
      process.env.NODE_ENV === 'production' ||
      connectionString.includes('sslmode=') ||
      connectionString.includes('.supabase.') ||
      connectionString.includes('.neon.') ||
      connectionString.includes('.pooler.')
    );

    async function connectPool(useSsl) {
      const p = new Pool({
        connectionString,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 5000
      });
      await p.query('SELECT 1');
      return p;
    }

    try {
      pool = await connectPool(shouldTrySsl);
    } catch (sslErr) {
      if (shouldTrySsl && (sslErr.message.includes('does not support SSL') || sslErr.message.includes('SSL'))) {
        console.warn('[DB] Servidor PostgreSQL não suporta SSL. Conectando sem SSL...');
        pool = await connectPool(false);
      } else {
        throw sslErr;
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        password_salt VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        company VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(50),
        cnpj_cpf VARCHAR(50),
        total_hours INT DEFAULT 10,
        used_hours NUMERIC(6,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        host_key VARCHAR(128) NOT NULL,
        client_id INT REFERENCES clients(id) ON DELETE SET NULL,
        source_language VARCHAR(10) DEFAULT 'pt-BR',
        target_languages TEXT[] DEFAULT ARRAY['en', 'es'],
        glossary JSONB DEFAULT '{}'::jsonb,
        banner_url TEXT DEFAULT '',
        logo_url TEXT DEFAULT '',
        primary_color VARCHAR(30) DEFAULT '#06b6d4',
        secondary_color VARCHAR(30) DEFAULT '#3b82f6',
        bg_color VARCHAR(30) DEFAULT '#020617',
        font_family VARCHAR(50) DEFAULT 'Inter',
        custom_css TEXT DEFAULT '',
        sponsors JSONB DEFAULT '[]'::jsonb,
        allow_original_audio BOOLEAN DEFAULT true,
        allow_translation BOOLEAN DEFAULT true,
        allow_subtitles BOOLEAN DEFAULT true,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS client_id INT REFERENCES clients(id) ON DELETE SET NULL;
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT '';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT '';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS primary_color VARCHAR(30) DEFAULT '#06b6d4';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS secondary_color VARCHAR(30) DEFAULT '#3b82f6';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS bg_color VARCHAR(30) DEFAULT '#020617';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS font_family VARCHAR(50) DEFAULT 'Inter';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS custom_css TEXT DEFAULT '';
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

      CREATE TABLE IF NOT EXISTS saved_glossaries (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT DEFAULT '',
        category VARCHAR(100) DEFAULT 'Geral',
        terms JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Cria ou atualiza o administrador padrão no Postgres
    const seeded = await pool.query('SELECT id, password_hash, password_salt FROM users WHERE email=$1', [defaultAdmin.email]);
    if (seeded.rows.length === 0) {
      await pool.query(
        `INSERT INTO users (email, password_hash, password_salt, name, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [defaultAdmin.email, defaultAdmin.password_hash, defaultAdmin.password_salt, defaultAdmin.name, defaultAdmin.role]
      );
      console.log('[DB] Usuário administrador padrão criado com sucesso: ' + defaultAdmin.email);
    } else {
      await pool.query('UPDATE users SET password_hash=$1, password_salt=$2 WHERE email=$3', [defaultAdmin.password_hash, defaultAdmin.password_salt, defaultAdmin.email]);
    }

    // Inicializa glossários padrão no Postgres se a tabela estiver vazia
    const glossCheck = await pool.query('SELECT count(*) FROM saved_glossaries');
    if (parseInt(glossCheck.rows[0].count) === 0) {
      for (const preset of defaultGlossaryPresets) {
        await pool.query(
          `INSERT INTO saved_glossaries (id, name, description, category, terms)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [preset.id, preset.name, preset.description, preset.category, JSON.stringify(preset.terms)]
        );
      }
      // Ajusta o sequence para novos IDs não conflitarem
      await pool.query(`SELECT setval('saved_glossaries_id_seq', (SELECT COALESCE(MAX(id), 1) FROM saved_glossaries))`);
      console.log('[DB] Modelos de glossário padrão inicializados no PostgreSQL.');
    }

    console.log('[DB] Tabelas PostgreSQL inicializadas.');
    return pool;
  } catch (err) {
    console.error('[DB] Erro ao inicializar tabelas PostgreSQL:', err.message);
    return null;
  }
}

// ----------------------------------------------------
// USUÁRIOS & AUTENTICAÇÃO
// ----------------------------------------------------
async function getUserByEmail(rawEmail) {
  let normalized = (rawEmail || '').toLowerCase().trim();
  const defaultEmail = (process.env.ADMIN_EMAIL || 'admin@videomappingtech.com').toLowerCase().trim();
  if (normalized === 'admin' || normalized === 'admin@videomapping.com' || normalized === 'admin@videomappingtech.com') {
    normalized = defaultEmail;
  }

  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM users WHERE email = $1', [normalized]);
      if (res.rows.length > 0) return res.rows[0];
      if (normalized === defaultEmail) {
        const superAdminRes = await pool.query("SELECT * FROM users WHERE role = 'superadmin' LIMIT 1");
        if (superAdminRes.rows.length > 0) return superAdminRes.rows[0];
      }
    } catch (e) {
      console.error('[DB] Erro ao buscar usuário por email:', e.message);
    }
  }
  return memoryStore.users.get(normalized) || memoryStore.users.get(defaultEmail) || null;
}

async function createUser({ email, password, name, role = 'admin' }) {
  const { hash, salt } = hashPassword(password);
  const user = {
    email: email.toLowerCase().trim(),
    password_hash: hash,
    password_salt: salt,
    name,
    role,
    created_at: new Date()
  };

  if (pool) {
    try {
      const res = await pool.query(
        `INSERT INTO users (email, password_hash, password_salt, name, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, created_at`,
        [user.email, user.password_hash, user.password_salt, user.name, user.role]
      );
      return res.rows[0];
    } catch (e) {
      console.error('[DB] Erro ao criar usuário:', e.message);
      throw e;
    }
  }
  user.id = memoryStore.users.size + 1;
  memoryStore.users.set(user.email, user);
  const { password_hash, password_salt, ...safeUser } = user;
  return safeUser;
}

async function updateUserPassword(email, newPassword) {
  const { hash, salt } = hashPassword(newPassword);
  if (pool) {
    try {
      await pool.query(
        'UPDATE users SET password_hash = $1, password_salt = $2 WHERE email = $3',
        [hash, salt, email.toLowerCase().trim()]
      );
      return true;
    } catch (e) {
      console.error('[DB] Erro ao atualizar senha:', e.message);
      return false;
    }
  }
  const u = memoryStore.users.get(email.toLowerCase().trim());
  if (u) {
    u.password_hash = hash;
    u.password_salt = salt;
    return true;
  }
  return false;
}

// ----------------------------------------------------
// CLIENTES (EMPRESAS CONTRATANTES)
// ----------------------------------------------------
async function saveClient(client) {
  if (pool) {
    try {
      if (client.id) {
        const res = await pool.query(
          `UPDATE clients SET
            name = $1, company = $2, email = $3, phone = $4, cnpj_cpf = $5,
            total_hours = $6, used_hours = $7, status = $8, notes = $9
           WHERE id = $10 RETURNING *`,
          [
            client.name, client.company, client.email, client.phone, client.cnpj_cpf,
            client.total_hours || 10, client.used_hours || 0, client.status || 'active', client.notes, client.id
          ]
        );
        const saved = res.rows[0];
        if (saved) {
          memoryStore.clients.set(saved.id, saved);
          return saved;
        }
      } else {
        const res = await pool.query(
          `INSERT INTO clients (name, company, email, phone, cnpj_cpf, total_hours, used_hours, status, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            client.name, client.company, client.email, client.phone, client.cnpj_cpf,
            client.total_hours || 10, client.used_hours || 0, client.status || 'active', client.notes
          ]
        );
        const saved = res.rows[0];
        if (saved) {
          memoryStore.clients.set(saved.id, saved);
          return saved;
        }
      }
    } catch (e) {
      console.error('[DB] Erro ao salvar cliente no Postgres:', e.message);
    }
  }

  const id = client.id || (memoryStore.clients.size + 1);
  const saved = { ...client, id, created_at: client.created_at || new Date() };
  memoryStore.clients.set(id, saved);
  return saved;
}

async function listClients() {
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
      res.rows.forEach(c => memoryStore.clients.set(c.id, c));
      return res.rows;
    } catch (e) {
      console.error('[DB] Erro ao listar clientes no Postgres:', e.message);
    }
  }
  return Array.from(memoryStore.clients.values());
}

async function deleteClient(id) {
  if (pool) {
    try {
      await pool.query('DELETE FROM clients WHERE id = $1', [id]);
      return true;
    } catch (e) {
      console.error('[DB] Erro ao excluir cliente:', e.message);
    }
  }
  memoryStore.clients.delete(parseInt(id));
  return true;
}

// ----------------------------------------------------
// SALAS & EVENTOS
// ----------------------------------------------------
async function saveRoom(room) {
  memoryStore.rooms.set(room.id, room);
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO rooms (
          id, name, host_key, client_id, source_language, target_languages, glossary,
          banner_url, logo_url, primary_color, secondary_color, bg_color, font_family, custom_css, sponsors,
          allow_original_audio, allow_translation, allow_subtitles, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          client_id = EXCLUDED.client_id,
          source_language = EXCLUDED.source_language,
          target_languages = EXCLUDED.target_languages,
          glossary = EXCLUDED.glossary,
          banner_url = EXCLUDED.banner_url,
          logo_url = EXCLUDED.logo_url,
          primary_color = EXCLUDED.primary_color,
          secondary_color = EXCLUDED.secondary_color,
          bg_color = EXCLUDED.bg_color,
          font_family = EXCLUDED.font_family,
          custom_css = EXCLUDED.custom_css,
          sponsors = EXCLUDED.sponsors,
          allow_original_audio = EXCLUDED.allow_original_audio,
          allow_translation = EXCLUDED.allow_translation,
          allow_subtitles = EXCLUDED.allow_subtitles,
          status = EXCLUDED.status`,
        [
          room.id,
          room.name,
          room.host_key,
          room.client_id || null,
          room.source_language || 'pt-BR',
          room.target_languages || ['en', 'es'],
          JSON.stringify(room.glossary || {}),
          room.banner_url || '',
          room.logo_url || '',
          room.primary_color || '#06b6d4',
          room.secondary_color || '#3b82f6',
          room.bg_color || '#020617',
          room.font_family || 'Inter',
          room.custom_css || '',
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
      const res = await pool.query(`
        SELECT r.*, c.name as client_name, c.company as client_company
        FROM rooms r
        LEFT JOIN clients c ON r.client_id = c.id
        ORDER BY r.created_at DESC LIMIT 100
      `);
      res.rows.forEach(r => memoryStore.rooms.set(r.id, r));
      return res.rows;
    } catch (e) {
      console.error('[DB] Erro ao listar salas no Postgres:', e.message);
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

// ----------------------------------------------------
// GLOSSÁRIOS REUTILIZÁVEIS / MODELOS SALVOS
// ----------------------------------------------------
async function listSavedGlossaries() {
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM saved_glossaries ORDER BY id ASC');
      return res.rows;
    } catch (e) {
      console.error('[DB] Erro ao listar glossários salvos:', e.message);
    }
  }
  return Array.from(memoryStore.savedGlossaries.values());
}

async function getSavedGlossary(id) {
  const numericId = parseInt(id);
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM saved_glossaries WHERE id = $1', [numericId]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (e) {
      console.error('[DB] Erro ao buscar glossário salvo:', e.message);
    }
  }
  return memoryStore.savedGlossaries.get(numericId) || null;
}

async function saveSavedGlossary(glossary) {
  const termsJson = JSON.stringify(glossary.terms || {});
  if (pool) {
    try {
      if (glossary.id) {
        const numericId = parseInt(glossary.id);
        const res = await pool.query(
          `UPDATE saved_glossaries SET
            name = $1, description = $2, category = $3, terms = $4, updated_at = NOW()
           WHERE id = $5 RETURNING *`,
          [glossary.name, glossary.description || '', glossary.category || 'Geral', termsJson, numericId]
        );
        if (res.rows.length > 0) {
          memoryStore.savedGlossaries.set(numericId, res.rows[0]);
          return res.rows[0];
        }
      } else {
        const res = await pool.query(
          `INSERT INTO saved_glossaries (name, description, category, terms)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [glossary.name, glossary.description || '', glossary.category || 'Geral', termsJson]
        );
        if (res.rows.length > 0) {
          memoryStore.savedGlossaries.set(res.rows[0].id, res.rows[0]);
          return res.rows[0];
        }
      }
    } catch (e) {
      console.error('[DB] Erro ao salvar modelo de glossário no Postgres:', e.message);
      throw e;
    }
  }

  // Fallback em memória
  const id = glossary.id ? parseInt(glossary.id) : (Math.max(0, ...memoryStore.savedGlossaries.keys()) + 1);
  const entry = {
    id,
    name: glossary.name,
    description: glossary.description || '',
    category: glossary.category || 'Geral',
    terms: glossary.terms || {},
    created_at: glossary.created_at || new Date(),
    updated_at: new Date()
  };
  memoryStore.savedGlossaries.set(id, entry);
  return entry;
}

async function deleteSavedGlossary(id) {
  const numericId = parseInt(id);
  if (pool) {
    try {
      await pool.query('DELETE FROM saved_glossaries WHERE id = $1', [numericId]);
    } catch (e) {
      console.error('[DB] Erro ao deletar glossário salvo:', e.message);
    }
  }
  memoryStore.savedGlossaries.delete(numericId);
  return true;
}

module.exports = {
  invalidateRoom: roomId => memoryStore.rooms.delete(roomId),
  initDb,
  getUserByEmail,
  createUser,
  updateUserPassword,
  saveClient,
  listClients,
  deleteClient,
  saveRoom,
  getRoom,
  listRooms,
  deleteRoom,
  saveTranscript,
  getTranscripts,
  saveLead,
  listLeads,
  listSavedGlossaries,
  getSavedGlossary,
  saveSavedGlossary,
  deleteSavedGlossary
};
