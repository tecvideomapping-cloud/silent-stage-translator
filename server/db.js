const { Pool } = require('pg');
const { hashPassword } = require('./auth');

let pool = null;
let nextClientId=1,nextClientPaymentId=1;
const memoryStore = {
  users: new Map(),
  clients: new Map(),
  clientPayments: new Map(),
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
  const bootstrapPassword = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV==='production'?null:'Videomapping2026!');
  const defaultAdminPass = bootstrapPassword?hashPassword(bootstrapPassword):{hash:null,salt:null};
  const defaultAdmin = {
    id: 1,
    email: (process.env.ADMIN_EMAIL || 'admin@videomappingtech.com').toLowerCase().trim(),
    password_hash: defaultAdminPass.hash,
    password_salt: defaultAdminPass.salt,
    name: 'Administrador Silent Stage',
    role: 'superadmin',
    created_at: new Date()
  };
  if(process.env.NODE_ENV!=='production')memoryStore.users.set(defaultAdmin.email, defaultAdmin);

  if (!process.env.DATABASE_URL) {
    if(process.env.NODE_ENV==='production')throw new Error('DATABASE_URL é obrigatória em produção.');
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
        ssl: useSsl ? { rejectUnauthorized: process.env.PG_SSL_INSECURE!=='true' } : false,
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
        password_hash VARCHAR(255),
        password_salt VARCHAR(255),
        plan VARCHAR(100) DEFAULT 'Pro',
        license_status VARCHAR(50) DEFAULT 'active',
        license_expires_at TIMESTAMP WITH TIME ZONE,
        max_rooms INT DEFAULT 2,
        max_listeners INT DEFAULT 250,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_salt VARCHAR(255);
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS plan VARCHAR(100) DEFAULT 'Pro';
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS license_status VARCHAR(50) DEFAULT 'active';
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS license_expires_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS max_rooms INT DEFAULT 2;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS max_listeners INT DEFAULT 250;

      CREATE TABLE IF NOT EXISTS client_payments (
        id SERIAL PRIMARY KEY,
        client_id INT REFERENCES clients(id) ON DELETE CASCADE,
        amount_cents INT NOT NULL,
        currency VARCHAR(10) DEFAULT 'BRL',
        status VARCHAR(30) DEFAULT 'paid',
        method VARCHAR(50) DEFAULT 'pix',
        description TEXT,
        reference_id VARCHAR(100),
        paid_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_client_payments_client_id ON client_payments(client_id);

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

      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS audio_quality TEXT DEFAULT 'pcm256';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS screen_logo TEXT DEFAULT 'vmp';
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS p2p_enabled BOOLEAN DEFAULT false;
      CREATE TABLE IF NOT EXISTS transcripts (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(64) REFERENCES rooms(id) ON DELETE CASCADE,
        source_text TEXT NOT NULL,
        translations JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker_id INTEGER;
      ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS turn_id TEXT;
      ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS segment_id TEXT;

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
      if(!bootstrapPassword||bootstrapPassword.length<12)throw new Error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres para criar o administrador.');
      await pool.query(
        `INSERT INTO users (email, password_hash, password_salt, name, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [defaultAdmin.email, defaultAdmin.password_hash, defaultAdmin.password_salt, defaultAdmin.name, defaultAdmin.role]
      );
      console.log('[DB] Usuário administrador padrão criado com sucesso: ' + defaultAdmin.email);
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
    if(process.env.NODE_ENV==='production'){err.status=503;throw err;}
    console.error('[DB] Erro ao inicializar tabelas PostgreSQL:', err.message);
    return null;
  }
}

// ----------------------------------------------------
// USUÁRIOS & AUTENTICAÇÃO
// ----------------------------------------------------
async function getUserByEmail(value){
 if(typeof value!=='string')return null;let email=value.trim().toLowerCase();if(email==='admin')email=(process.env.ADMIN_EMAIL||'admin@videomappingtech.com').toLowerCase();
 if(pool)return(await pool.query('SELECT * FROM users WHERE email=$1',[email])).rows[0]||null;
 if(process.env.NODE_ENV==='production')throw Object.assign(new Error('Banco indisponível.'),{status:503});
 return memoryStore.users.get(email)||null;
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
function sanitizeClient(c) {
  if (!c) return null;
  const clone = { ...c };
  clone.id = parseInt(c.id, 10);
  clone.has_password = Boolean(c.password_hash);
  clone.plan = c.plan || 'Pro';
  clone.license_status = c.license_status || 'active';
  clone.license_expires_at = c.license_expires_at || null;
  clone.max_rooms = c.max_rooms != null ? parseInt(c.max_rooms, 10) : 2;
  clone.max_listeners = c.max_listeners != null ? parseInt(c.max_listeners, 10) : 250;
  clone.total_hours = c.total_hours != null ? Number(c.total_hours) : 10;
  clone.used_hours = c.used_hours != null ? Number(c.used_hours) : 0;
  delete clone.password_hash;
  delete clone.password_salt;
  delete clone.password;
  return clone;
}

// ----------------------------------------------------
// CLIENTES (EMPRESAS CONTRATANTES)
// ----------------------------------------------------
async function saveClient(client, executor=null) {
  const connection=executor?.query?executor:pool;
  if(client.id){const current=await getClient(client.id,executor);if(!current)throw Object.assign(new Error('Cliente não encontrado.'),{status:404});client={...current,...client};}
  let pwdHash = null;
  let pwdSalt = null;
  if (client.password && typeof client.password === 'string' && client.password.trim().length > 0) {
    pwdSalt=require('crypto').randomBytes(16).toString('hex');
    const bytes=await require('util').promisify(require('crypto').scrypt)(client.password,pwdSalt,64);
    pwdHash='scrypt:'+bytes.toString('hex');
  }

  const plan = client.plan || 'Pro';
  const licenseStatus = client.license_status || 'active';
  const licenseExpires = client.license_expires_at ? new Date(client.license_expires_at) : null;
  const maxRooms = client.max_rooms != null ? parseInt(client.max_rooms, 10) : 2;
  const maxListeners = client.max_listeners != null ? parseInt(client.max_listeners, 10) : 250;
  const totalHours = client.total_hours != null ? Number(client.total_hours) : 10;
  const usedHours = client.used_hours != null ? Number(client.used_hours) : 0;

  if (connection) {
    try {
      if (client.id) {
        const res = await connection.query(
          `UPDATE clients SET
            name = $1, company = $2, email = $3, phone = $4, cnpj_cpf = $5,
            total_hours = $6, used_hours = $7, status = $8, notes = $9,
            plan = $10, license_status = $11, license_expires_at = $12,
            max_rooms = $13, max_listeners = $14,
            password_hash = COALESCE($15, password_hash),
            password_salt = COALESCE($16, password_salt)
           WHERE id = $17 RETURNING *`,
          [
            client.name, client.company, client.email, client.phone, client.cnpj_cpf,
            totalHours, usedHours, client.status || 'active', client.notes,
            plan, licenseStatus, licenseExpires, maxRooms, maxListeners,
            pwdHash, pwdSalt, parseInt(client.id, 10)
          ]
        );
        const saved = res.rows[0];
        if (saved) {
          memoryStore.clients.set(saved.id, saved);
          return sanitizeClient(saved);
        }
      } else {
        const res = await connection.query(
          `INSERT INTO clients (
            name, company, email, phone, cnpj_cpf, total_hours, used_hours, status, notes,
            plan, license_status, license_expires_at, max_rooms, max_listeners, password_hash, password_salt
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
          [
            client.name, client.company, client.email, client.phone, client.cnpj_cpf,
            totalHours, usedHours, client.status || 'active', client.notes,
            plan, licenseStatus, licenseExpires, maxRooms, maxListeners,
            pwdHash, pwdSalt
          ]
        );
        const saved = res.rows[0];
        if (saved) {
          memoryStore.clients.set(saved.id, saved);
          return sanitizeClient(saved);
        }
      }
    } catch (e) {
      if(executor?.query||process.env.NODE_ENV==='production'){e.status=503;throw e;}
      console.error('[DB] Erro ao salvar cliente no Postgres:', e.message);
    }
  }

  const id = client.id ? parseInt(client.id, 10) : nextClientId++;
  const existing = memoryStore.clients.get(id) || {};
  const saved = {
    ...existing,
    ...client,
    id,
    plan: client.plan || existing.plan || 'Pro',
    license_status: client.license_status || existing.license_status || 'active',
    license_expires_at: client.license_expires_at !== undefined ? client.license_expires_at : (existing.license_expires_at || null),
    max_rooms: client.max_rooms !== undefined ? client.max_rooms : (existing.max_rooms || 2),
    max_listeners: client.max_listeners !== undefined ? client.max_listeners : (existing.max_listeners || 250),
    total_hours: client.total_hours !== undefined ? totalHours : (existing.total_hours || 10),
    used_hours: client.used_hours !== undefined ? usedHours : (existing.used_hours || 0),
    status: client.status || existing.status || 'active',
    created_at: existing.created_at || client.created_at || new Date()
  };
  if (pwdHash) {
    saved.password_hash = pwdHash;
    saved.password_salt = pwdSalt;
  }
  delete saved.password;
  memoryStore.clients.set(id, saved);
  return sanitizeClient(saved);
}

async function getClient(id, executor=null) {
  const connection=executor?.query?executor:pool;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;
  if (connection) {
    try {
      const res = await connection.query('SELECT * FROM clients WHERE id = $1', [numId]);
      if (res.rows[0]) {
        memoryStore.clients.set(res.rows[0].id, res.rows[0]);
        return sanitizeClient(res.rows[0]);
      }
      return null;
    } catch (e) {
      if(executor?.query||process.env.NODE_ENV==='production'){e.status=503;throw e;}
      console.error('[DB] Erro ao obter cliente no Postgres:', e.message);
    }
  }
  const client = memoryStore.clients.get(numId);
  return client ? sanitizeClient(client) : null;
}

async function getClientByEmail(email, executor=null) {
  const connection=executor?.query?executor:pool;
  if (!email || typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (connection) {
    try {
      const res = await connection.query('SELECT * FROM clients WHERE LOWER(TRIM(email)) = $1 LIMIT 1', [normalized]);
      if (res.rows[0]) {
        memoryStore.clients.set(res.rows[0].id, res.rows[0]);
        return res.rows[0];
      }
      return null;
    } catch (e) {
      if(executor?.query||process.env.NODE_ENV==='production'){e.status=503;throw e;}
      console.error('[DB] Erro ao buscar cliente por e-mail:', e.message);
    }
  }
  return Array.from(memoryStore.clients.values()).find(c => (c.email || '').trim().toLowerCase() === normalized) || null;
}

async function listClients() {
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
      res.rows.forEach(c => memoryStore.clients.set(c.id, c));
      return res.rows.map(sanitizeClient);
    } catch (e) {
      if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
      console.error('[DB] Erro ao listar clientes no Postgres:', e.message);
    }
  }
  return Array.from(memoryStore.clients.values()).map(sanitizeClient);
}

async function deleteClient(id) {
  const numId = parseInt(id, 10);
  if (pool) {
    try {
      await pool.query('DELETE FROM clients WHERE id = $1', [numId]);
      memoryStore.clients.delete(numId);
      for (const [pId, p] of memoryStore.clientPayments) {
        if (p.client_id === numId) memoryStore.clientPayments.delete(pId);
      }
      return true;
    } catch (e) {
      if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
      console.error('[DB] Erro ao excluir cliente:', e.message);
    }
  }
  memoryStore.clients.delete(numId);
  for (const [pId, p] of memoryStore.clientPayments) {
    if (p.client_id === numId) memoryStore.clientPayments.delete(pId);
  }
  return true;
}

// ----------------------------------------------------
// HISTÓRICO DE PAGAMENTOS DE CLIENTES
// ----------------------------------------------------
async function saveClientPayment(payment, executor=null) {
  const connection=executor?.query?executor:pool;
  const numClientId = parseInt(payment.client_id, 10);
  const amountCents = parseInt(payment.amount_cents ?? Math.round(Number(payment.amount || 0) * 100), 10);
  const currency = payment.currency || 'BRL';
  const status = payment.status || 'paid';
  const method = payment.method || 'pix';
  const description = payment.description || '';
  const referenceId = payment.reference_id || '';
  const paidAt = payment.paid_at ? new Date(payment.paid_at) : new Date();

  if (connection) {
    try {
      if (payment.id) {
        const res = await connection.query(
          `UPDATE client_payments SET
             amount_cents = $1, currency = $2, status = $3, method = $4,
             description = $5, reference_id = $6, paid_at = $7
           WHERE id = $8 AND client_id = $9 RETURNING *`,
          [amountCents, currency, status, method, description, referenceId, paidAt, parseInt(payment.id, 10), numClientId]
        );
        const saved = res.rows[0];
        if (saved) {
          memoryStore.clientPayments.set(saved.id, saved);
          return saved;
        }
      } else {
        const res = await connection.query(
          `INSERT INTO client_payments (client_id, amount_cents, currency, status, method, description, reference_id, paid_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [numClientId, amountCents, currency, status, method, description, referenceId, paidAt]
        );
        const saved = res.rows[0];
        if (saved) {
          memoryStore.clientPayments.set(saved.id, saved);
          return saved;
        }
      }
    } catch (e) {
      if (executor?.query || process.env.NODE_ENV === 'production') { e.status = 503; throw e; }
      console.error('[DB] Erro ao salvar pagamento no Postgres:', e.message);
    }
  }

  const id = payment.id ? parseInt(payment.id, 10) : nextClientPaymentId++;
  const saved = {
    id,
    client_id: numClientId,
    amount_cents: amountCents,
    currency,
    status,
    method,
    description,
    reference_id: referenceId,
    paid_at: paidAt,
    created_at: payment.created_at ? new Date(payment.created_at) : new Date()
  };
  memoryStore.clientPayments.set(id, saved);
  return saved;
}

async function listClientPayments(clientId) {
  const numClientId = parseInt(clientId, 10);
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM client_payments WHERE client_id = $1 ORDER BY paid_at DESC, created_at DESC', [numClientId]);
      res.rows.forEach(p => memoryStore.clientPayments.set(p.id, p));
      return res.rows;
    } catch (e) {
      if (process.env.NODE_ENV === 'production') { e.status = 503; throw e; }
      console.error('[DB] Erro ao listar pagamentos no Postgres:', e.message);
    }
  }
  return Array.from(memoryStore.clientPayments.values())
    .filter(p => parseInt(p.client_id, 10) === numClientId)
    .sort((a, b) => new Date(b.paid_at || b.created_at) - new Date(a.paid_at || a.created_at));
}

async function deleteClientPayment(id, clientId, executor=null) {
  const connection=executor?.query?executor:pool;
  const numId = parseInt(id, 10);
  const numClientId = clientId ? parseInt(clientId, 10) : null;
  if (connection) {
    try {
      await connection.query('DELETE FROM client_payments WHERE id = $1 AND ($2::int IS NULL OR client_id = $2::int)', [numId, numClientId]);
      memoryStore.clientPayments.delete(numId);
      return true;
    } catch (e) {
      if (executor?.query || process.env.NODE_ENV === 'production') { e.status = 503; throw e; }
      console.error('[DB] Erro ao excluir pagamento no Postgres:', e.message);
    }
  }
  const record=memoryStore.clientPayments.get(numId);
  if(record&&(!numClientId||record.client_id===numClientId))memoryStore.clientPayments.delete(numId);
  return true;
}

// ----------------------------------------------------
// SALAS & EVENTOS
// ----------------------------------------------------
async function saveRoom(room) {
 if(pool){
  const fields=['id','name','host_key','client_id','source_language','target_languages','glossary','banner_url','logo_url','primary_color','secondary_color','bg_color','font_family','custom_css','sponsors','allow_original_audio','allow_translation','allow_subtitles','status','audio_quality','screen_logo','p2p_enabled'];
  const defaults={client_id:null,glossary:{},sponsors:[],status:'active',audio_quality:'pcm256',screen_logo:'vmp',p2p_enabled:false};
  const values=fields.map(k=>['glossary','sponsors'].includes(k)?JSON.stringify(room[k]??defaults[k]):room[k]??defaults[k]??null);
  await pool.query(`INSERT INTO rooms(${fields.join(',')}) VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT(id) DO UPDATE SET ${fields.filter(k=>k!=='id').map(k=>k+'=EXCLUDED.'+k).join(',')}`,values);
 }
 memoryStore.rooms.set(room.id,room);return room;
}

async function getRoom(roomId) {
  if (!pool && memoryStore.rooms.has(roomId)) {
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
      console.error('[DB] Erro ao deletar sala:', e.message);
    }
  }
  return false;
}

async function saveTranscript(roomId, sourceText, translations = {}, metadata = {}) {
  const item = { roomId, sourceText, translations, speaker_id:Number.isInteger(metadata.speakerId)?metadata.speakerId:null,turn_id:metadata.turnId||null,segment_id:metadata.segmentId||null,createdAt: new Date() };
  if(!pool){memoryStore.transcripts.push(item);if(memoryStore.transcripts.length>10000)memoryStore.transcripts.splice(0,memoryStore.transcripts.length-10000);}
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO transcripts (room_id, source_text, translations, speaker_id, turn_id, segment_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [roomId, sourceText, JSON.stringify(translations),item.speaker_id,item.turn_id,item.segment_id]
      );
    } catch (e) {
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
      console.error('[DB] Erro ao salvar transcrição:', e.message);
    }
  }
  return item;
}

async function getTranscripts(roomId,limit=500,offset=0){
 if(pool){const values=limit===null?[roomId]:[roomId,limit,offset];return(await pool.query('SELECT * FROM transcripts WHERE room_id=$1 ORDER BY created_at ASC'+(limit===null?'':' LIMIT $2 OFFSET $3'),values)).rows}
 const records=memoryStore.transcripts.filter(t=>t.roomId===roomId);return records.slice(offset,limit===null?undefined:offset+limit).map(t=>({...t,room_id:t.roomId,source_text:t.sourceText,created_at:t.createdAt}));
}

async function saveLead(lead) {
  if(!pool){memoryStore.leads.push(lead);if(memoryStore.leads.length>1000)memoryStore.leads.shift();}
  if (pool) {
    try {
      const res = await pool.query(
        `INSERT INTO leads (name, email, phone, company, event_type, estimated_hours, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [lead.name, lead.email, lead.phone, lead.company, lead.eventType, lead.estimatedHours || 4, lead.message]
      );
      return res.rows[0];
    } catch (e) {
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
    if(process.env.NODE_ENV==='production'){e.status=503;throw e;}
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
  getClient,
  getClientByEmail,
  listClients,
  deleteClient,
  saveClientPayment,
  listClientPayments,
  deleteClientPayment,
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
