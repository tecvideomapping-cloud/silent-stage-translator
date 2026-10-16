require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const {
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
} = require('./db');
const { verifyPassword, createSession, removeSession, requireAuth } = require('./auth');
const { pubSub } = require('./redis');
const { aiPipeline } = require('./ai-pipeline');
const QRCode = require('qrcode');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Inicializa Banco e Redis
initDb();
pubSub.init();

// Map de clientes conectados: roomId -> Set<ws>
const roomsClients = new Map();

function getRoomClients(roomId) {
  if (!roomsClients.has(roomId)) {
    roomsClients.set(roomId, new Set());
  }
  return roomsClients.get(roomId);
}

// Relatório em tempo real de usuários online, ouvintes por canal e telões conectados
function getRoomOnlineStats(roomId) {
  const normalizedId = (roomId || '').trim().toLowerCase();
  const clients = roomsClients.get(normalizedId);
  if (!clients) {
    return {
      total: 0,
      listeners: 0,
      hosts: 0,
      screens: 0,
      channels: { original: 0, en: 0, es: 0, text: 0 }
    };
  }
  let listeners = 0;
  let hosts = 0;
  let screens = 0;
  const channels = { original: 0, en: 0, es: 0, text: 0 };

  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.role === 'host') {
      hosts++;
    } else if (client.role === 'screen') {
      screens++;
    } else {
      listeners++;
      const ch = client.channel || 'original';
      channels[ch] = (channels[ch] || 0) + 1;
    }
  }

  return {
    total: listeners + hosts + screens,
    listeners,
    hosts,
    screens,
    channels
  };
}

function broadcastRoomStats(roomId) {
  const normalizedId = (roomId || '').trim().toLowerCase();
  const clients = roomsClients.get(normalizedId);
  if (!clients) return;
  const stats = getRoomOnlineStats(normalizedId);
  const payload = JSON.stringify({
    type: 'room_online_stats',
    roomId: normalizedId,
    stats,
    timestamp: Date.now()
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && (client.role === 'host' || client.role === 'admin' || client.role === 'screen')) {
      try {
        client.send(payload);
      } catch (e) {}
    }
  }
}

// ----------------------------------------------------
// ROTAS DE AUTENTICAÇÃO (LOGIN / SESSÃO)
// ----------------------------------------------------

// Login de Administrador
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const isValid = verifyPassword(password, user.password_hash, user.password_salt);
    if (!isValid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const { token, expiresAt } = createSession(user);
    res.json({
      success: true,
      token,
      expiresAt,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Checar sessão do admin
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Alterar senha
app.put('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres.' });
    }

    await updateUserPassword(req.user.email, newPassword);
    res.json({ success: true, message: 'Senha atualizada com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.authorization?.substring(7);
  removeSession(token);
  res.json({ success: true });
});

// ----------------------------------------------------
// GESTÃO DE CLIENTES / EMPRESAS (PROTEGIDO)
// ----------------------------------------------------

app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const clients = await listClients();
    res.json({ clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    const client = await saveClient(req.body);
    res.json({ success: true, client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    await deleteClient(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// GESTÃO DE SALAS / EVENTOS (PROTEGIDO)
// ----------------------------------------------------

// Listar todas as salas (Apenas Admin autenticado, inclui métricas online em tempo real)
app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const rooms = await listRooms();
    const roomsWithStats = rooms.map(r => ({
      ...r,
      onlineStats: getRoomOnlineStats(r.id)
    }));
    res.json({ rooms: roomsWithStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Relatório público/host de ouvintes e usuários online da sala
app.get('/api/rooms/:id/stats', async (req, res) => {
  try {
    const stats = getRoomOnlineStats(req.params.id);
    res.json({ roomId: req.params.id, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar ou Atualizar Sala/Evento (Apenas Admin autenticado)
app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const {
      id,
      name,
      clientId,
      sourceLanguage,
      targetLanguages,
      glossary,
      bannerUrl,
      logoUrl,
      primaryColor,
      secondaryColor,
      bgColor,
      fontFamily,
      customCss,
      sponsors,
      allowOriginalAudio,
      allowTranslation,
      allowSubtitles
    } = req.body;

    const roomId = (id || `evento-${Date.now().toString(36)}`).trim().toLowerCase();
    const existing = await getRoom(roomId);
    const hostKey = existing?.host_key || `host-${Math.random().toString(36).substring(2, 10)}`;

    const room = {
      id: roomId,
      name: name || `Evento ${roomId}`,
      host_key: hostKey,
      client_id: clientId ? parseInt(clientId) : null,
      source_language: sourceLanguage || 'pt-BR',
      target_languages: targetLanguages || ['en', 'es'],
      glossary: glossary || {},
      banner_url: bannerUrl || '',
      logo_url: logoUrl || '',
      primary_color: primaryColor || '#06b6d4',
      secondary_color: secondaryColor || '#3b82f6',
      bg_color: bgColor || '#020617',
      font_family: fontFamily || 'Inter',
      custom_css: customCss || '',
      sponsors: sponsors || [],
      allow_original_audio: allowOriginalAudio !== false,
      allow_translation: allowTranslation !== false,
      allow_subtitles: allowSubtitles !== false,
      status: 'active',
      created_at: existing?.created_at || new Date()
    };

    await saveRoom(room);
    res.json({ success: true, room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excluir sala (Apenas Admin autenticado)
app.delete('/api/rooms/:id', requireAuth, async (req, res) => {
  try {
    await deleteRoom(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ver leads recebidos (Apenas Admin autenticado)
app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const leads = await listLeads();
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ROTAS PÚBLICAS (OUVINTES, TELÕES E FORMULÁRIO DE CONTATO)
// ----------------------------------------------------

// Gerador de QR Code SVG
app.get('/api/qr', async (req, res) => {
  try {
    const text = req.query.text || 'https://videomappingtech.com';
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 220 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Detalhes da sala (Público para ouvintes e telões)
app.get('/api/rooms/:id', async (req, res) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    
    const { host_key, ...publicData } = room;
    res.json(publicData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar glossário em tempo real (Palco)
app.put('/api/rooms/:id/glossary', async (req, res) => {
  try {
    const { hostKey, glossary } = req.body;
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    if (room.host_key !== hostKey && hostKey !== 'admin') {
      return res.status(403).json({ error: 'Chave de host inválida' });
    }

    room.glossary = glossary;
    await saveRoom(room);
    res.json({ success: true, glossary: room.glossary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// BIBLIOTECA DE GLOSSÁRIOS REUTILIZÁVEIS
// ----------------------------------------------------
// Listar todos os glossários salvos
app.get('/api/glossaries', async (req, res) => {
  try {
    const glossaries = await listSavedGlossaries();
    res.json({ glossaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter glossário específico
app.get('/api/glossaries/:id', async (req, res) => {
  try {
    const glossary = await getSavedGlossary(req.params.id);
    if (!glossary) return res.status(404).json({ error: 'Glossário não encontrado' });
    res.json(glossary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar novo modelo de glossário reutilizável
app.post('/api/glossaries', async (req, res) => {
  try {
    const { name, description, category, terms } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome do glossário é obrigatório' });
    }
    const created = await saveSavedGlossary({
      name: name.trim(),
      description: (description || '').trim(),
      category: (category || 'Geral').trim(),
      terms: terms || {}
    });
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar modelo de glossário existente
app.put('/api/glossaries/:id', async (req, res) => {
  try {
    const { name, description, category, terms } = req.body;
    const existing = await getSavedGlossary(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Glossário não encontrado' });

    const updated = await saveSavedGlossary({
      id: req.params.id,
      name: name !== undefined ? name.trim() : existing.name,
      description: description !== undefined ? description.trim() : existing.description,
      category: category !== undefined ? category.trim() : existing.category,
      terms: terms !== undefined ? terms : existing.terms
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletar modelo de glossário
app.delete('/api/glossaries/:id', async (req, res) => {
  try {
    const success = await deleteSavedGlossary(req.params.id);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transcrições da sala
app.get('/api/rooms/:id/transcripts', async (req, res) => {
  try {
    const transcripts = await getTranscripts(req.params.id);
    res.json({ transcripts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exportar legendas (SRT, TXT)
app.get('/api/rooms/:id/export', async (req, res) => {
  try {
    const { format = 'txt', lang } = req.query;
    const transcripts = await getTranscripts(req.params.id);
    
    if (format === 'srt') {
      let srtContent = '';
      transcripts.forEach((t, i) => {
        const text = (lang && t.translations?.[lang]) ? t.translations[lang] : t.source_text;
        const startSec = i * 4;
        const endSec = startSec + 3;
        const formatTime = (s) => {
          const hrs = String(Math.floor(s / 3600)).padStart(2, '0');
          const mins = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
          const secs = String(s % 60).padStart(2, '0');
          return `${hrs}:${mins}:${secs},000`;
        };
        srtContent += `${i + 1}\n${formatTime(startSec)} --> ${formatTime(endSec)}\n${text}\n\n`;
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-legendas.srt"`);
      return res.send(srtContent);
    }

    let txtContent = `TRANSCRIÇÃO DO EVENTO: ${req.params.id}\nData: ${new Date().toLocaleString()}\n\n`;
    transcripts.forEach(t => {
      const text = (lang && t.translations?.[lang]) ? t.translations[lang] : t.source_text;
      txtContent += `[${new Date(t.created_at).toLocaleTimeString()}] ${text}\n`;
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-transcricao.txt"`);
    res.send(txtContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastro de Leads / Orçamentos pelo Site Institucional (Público)
app.post('/api/leads', async (req, res) => {
  try {
    const lead = await saveLead(req.body);
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chaves dinâmicas configuradas pelo Painel do Host ou variáveis de ambiente
let customOpenAiKey = process.env.OPENAI_API_KEY || '';
let customElevenLabsKey = process.env.ELEVENLABS_API_KEY || '';

// Endpoints de Configuração de Chaves de Voz IA (OpenAI / ElevenLabs / Microsoft Neural Studio)
app.get('/api/config/tts-keys', (req, res) => {
  const activeOai = !!(customOpenAiKey || process.env.OPENAI_API_KEY);
  const activeEl = !!(customElevenLabsKey || process.env.ELEVENLABS_API_KEY);
  res.json({
    hasOpenAi: activeOai,
    hasElevenLabs: activeEl,
    provider: activeOai ? 'OpenAI Neural (tts-1)' : (activeEl ? 'ElevenLabs Multilingual' : 'Microsoft Neural Studio (Edge-TTS HD)')
  });
});

app.post('/api/config/tts-keys', (req, res) => {
  const { openAiKey, elevenLabsKey } = req.body || {};
  if (typeof openAiKey === 'string') {
    customOpenAiKey = openAiKey.trim();
    aiPipeline.setApiKeys({ openaiKey: customOpenAiKey });
  }
  if (typeof elevenLabsKey === 'string') customElevenLabsKey = elevenLabsKey.trim();
  ttsMemoryCache.clear();
  const activeOai = !!(customOpenAiKey || process.env.OPENAI_API_KEY);
  const activeEl = !!(customElevenLabsKey || process.env.ELEVENLABS_API_KEY);
  res.json({
    success: true,
    hasOpenAi: activeOai,
    hasElevenLabs: activeEl,
    provider: activeOai ? 'OpenAI Neural (tts-1)' : (activeEl ? 'ElevenLabs Multilingual' : 'Microsoft Neural Studio (Edge-TTS HD)')
  });
});

// Mapeamento de Timbres Neurais Microsoft Edge Studio por idioma e perfil calibrado
function resolveEdgeNeuralVoiceAndProsody(targetLang, voiceProfile, userSpeed, userPitchSt) {
  const lang = (targetLang || 'en').split('-')[0].toLowerCase();
  const v = (voiceProfile || 'male_deep').toLowerCase();
  const pitchSemitones = Math.max(-8, Math.min(8, parseFloat(userPitchSt) || 0));
  const speedRatio = Math.max(0.75, Math.min(1.45, parseFloat(userSpeed) || 1.05));

  // Vozes Neurais Reais (Masculinas e Femininas distintas) + ajuste fino de formante/tom base em Hz
  let edgeVoiceName = 'en-US-ChristopherNeural';
  let basePitchHzOffset = 0;

  if (lang === 'pt') {
    if (v === 'male_deep' || v === 'onyx' || v === 'baritone') {
      edgeVoiceName = 'pt-BR-AntonioNeural';
      basePitchHzOffset = -10; // Barítono encorpado
    } else if (v === 'male_natural' || v === 'echo' || v === 'orador') {
      edgeVoiceName = 'pt-BR-AntonioNeural';
      basePitchHzOffset = +3; // Orador masculino natural
    } else if (v === 'female_warm' || v === 'nova' || v === 'expressiva') {
      edgeVoiceName = 'pt-BR-FranciscaNeural';
      basePitchHzOffset = -3; // Feminina envolvente e expressiva
    } else {
      edgeVoiceName = 'pt-BR-FranciscaNeural';
      basePitchHzOffset = +10; // Feminina clara e suave
    }
  } else if (lang === 'es') {
    if (v === 'male_deep' || v === 'onyx' || v === 'baritone') {
      edgeVoiceName = 'es-ES-AlvaroNeural';
      basePitchHzOffset = -10;
    } else if (v === 'male_natural' || v === 'echo' || v === 'orador') {
      edgeVoiceName = 'es-ES-AlvaroNeural';
      basePitchHzOffset = +4;
    } else if (v === 'female_warm' || v === 'nova' || v === 'expressiva') {
      edgeVoiceName = 'es-ES-ElviraNeural';
      basePitchHzOffset = -3;
    } else {
      edgeVoiceName = 'es-ES-ElviraNeural';
      basePitchHzOffset = +10;
    }
  } else if (lang === 'fr') {
    if (v === 'male_deep' || v === 'onyx' || v === 'baritone') {
      edgeVoiceName = 'fr-FR-HenriNeural';
      basePitchHzOffset = -10;
    } else if (v === 'male_natural' || v === 'echo' || v === 'orador') {
      edgeVoiceName = 'fr-FR-HenriNeural';
      basePitchHzOffset = +3;
    } else if (v === 'female_warm' || v === 'nova' || v === 'expressiva') {
      edgeVoiceName = 'fr-FR-DeniseNeural';
      basePitchHzOffset = -3;
    } else {
      edgeVoiceName = 'fr-FR-DeniseNeural';
      basePitchHzOffset = +10;
    }
  } else {
    // Inglês (en-US) com 4 vozes neurais dedicadas
    if (v === 'male_deep' || v === 'onyx' || v === 'baritone') {
      edgeVoiceName = 'en-US-ChristopherNeural';
      basePitchHzOffset = -8;
    } else if (v === 'male_natural' || v === 'echo' || v === 'orador') {
      edgeVoiceName = 'en-US-GuyNeural';
      basePitchHzOffset = 0;
    } else if (v === 'female_warm' || v === 'nova' || v === 'expressiva') {
      edgeVoiceName = 'en-US-AriaNeural';
      basePitchHzOffset = -2;
    } else {
      edgeVoiceName = 'en-US-JennyNeural';
      basePitchHzOffset = +6;
    }
  }

  // Cada semitom no controle de Pitch equivale a ~8Hz no modelo prosódico neural (sem alterar a velocidade!)
  const totalPitchHz = Math.round(basePitchHzOffset + (pitchSemitones * 8));
  const prosodyPitch = (totalPitchHz >= 0 ? `+${totalPitchHz}Hz` : `${totalPitchHz}Hz`);

  const ratePct = Math.round((speedRatio - 1.0) * 100);
  const prosodyRate = (ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`);

  return { edgeVoiceName, prosodyPitch, prosodyRate };
}

function escapeSsmlText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function synthesizeWithEdgeNeural(targetLang, sanitizedText, voice, speed, pitch) {
  const { edgeVoiceName, prosodyPitch, prosodyRate } = resolveEdgeNeuralVoiceAndProsody(targetLang, voice, speed, pitch);
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(edgeVoiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeSsmlText(sanitizedText), {
      pitch: prosodyPitch,
      rate: prosodyRate
    });
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Edge-TTS timeout')), 4500);
      audioStream.on('data', (d) => chunks.push(d));
      audioStream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      audioStream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const finalBuf = Buffer.concat(chunks);
    if (finalBuf.length < 256) {
      throw new Error('Edge-TTS returned empty audio');
    }
    return finalBuf;
  } finally {
    try { tts.close(); } catch (e) {}
  }
}

// Cache em memória de alta performance para TTS (LRU 800 itens) & Deduplicação de requisições concorrentes
const ttsMemoryCache = new Map();
const ttsInFlightRequests = new Map();

async function getOrGenerateTts(targetLang, cleanText, voice, speed, pitch) {
  const sanitizedText = String(cleanText || '').replace(/^\s*\[[A-Za-z-]{2,8}\]\s*/g, '').trim();
  const normVoice = (voice || 'male_deep').toLowerCase();
  const normSpeed = (parseFloat(speed) || 1.05).toFixed(2);
  const normPitch = Math.round(parseFloat(pitch) || 0);
  const cacheKey = `${targetLang}_${normVoice}_${normSpeed}_${normPitch}_${sanitizedText}`;
  if (ttsMemoryCache.has(cacheKey)) {
    return ttsMemoryCache.get(cacheKey);
  }

  // Se já há uma requisição em andamento para a mesma frase (ex: múltiplos ouvintes na sala), compartilha a Promise
  if (ttsInFlightRequests.has(cacheKey)) {
    return await ttsInFlightRequests.get(cacheKey);
  }

  const generatePromise = (async () => {
    const activeOpenAiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
    const activeElevenLabsKey = customElevenLabsKey || process.env.ELEVENLABS_API_KEY;

    // 1. OpenAI Neural TTS (Se chave configurada E pitch == 0; caso haja ajuste de Pitch fino em semitons, Edge Neural aplica SSML nativo sem distorcer velocidade)
    if (activeOpenAiKey) {
      try {
        let openAiVoice = 'alloy';
        const v = normVoice;
        if (v === 'male_deep' || v === 'onyx' || v === 'baritone') {
          openAiVoice = 'onyx';
        } else if (v === 'male_natural' || v === 'echo' || v === 'orador') {
          openAiVoice = 'echo';
        } else if (v === 'female_warm' || v === 'nova' || v === 'expressiva') {
          openAiVoice = 'nova';
        } else if (v === 'female_clear' || v === 'shimmer' || v === 'suave') {
          openAiVoice = 'shimmer';
        } else if (['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(v)) {
          openAiVoice = v;
        }

        const openAiSpeed = Math.max(0.85, Math.min(1.3, parseFloat(speed) || 1.05));

        const oaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${activeOpenAiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'tts-1',
            input: sanitizedText,
            voice: openAiVoice,
            speed: openAiSpeed,
            response_format: 'mp3'
          }),
          signal: AbortSignal.timeout(4500)
        });

        if (oaiRes.ok) {
          return { buffer: Buffer.from(await oaiRes.arrayBuffer()), provider: 'openai' };
        }
      } catch (oaiErr) {
        console.warn('[TTS OpenAI] Falha na síntese neural, usando Microsoft Edge Neural:', oaiErr.message);
      }
    }

    // 2. ElevenLabs Multilingual (Se configurado via painel ou .env)
    if (activeElevenLabsKey) {
      try {
        const v = normVoice;
        const voiceId = (v.includes('female') || v === 'nova' || v === 'shimmer')
          ? '21m00Tcm4TlvDq8ikWAM' // Rachel
          : 'ErXwobaYiN019PkySvjV'; // Antoni

        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': activeElevenLabsKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: sanitizedText,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          }),
          signal: AbortSignal.timeout(4500)
        });

        if (elRes.ok) {
          return { buffer: Buffer.from(await elRes.arrayBuffer()), provider: 'elevenlabs' };
        }
      } catch (elErr) {}
    }

    // 3. Motor Padrão Nativo de Estúdio: Microsoft Edge Neural TTS (Vozes Masculinas e Femininas Reais + Pitch e Velocidade SSML independentes)
    try {
      const edgeBuf = await synthesizeWithEdgeNeural(targetLang, sanitizedText, normVoice, speed, pitch);
      return { buffer: edgeBuf, provider: 'edge-neural' };
    } catch (edgeErr) {
      console.warn('[TTS Edge Neural] Contingência para Google TTS:', edgeErr.message);
    }

    // 4. Contingência de Emergência (Google TTS)
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(targetLang)}&client=tw-ob&q=${encodeURIComponent(sanitizedText)}`;
    const response = await fetch(googleTtsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      return { buffer: Buffer.from(await response.arrayBuffer()), provider: 'google-fallback' };
    }
    throw new Error('TTS Provider Error');
  })();

  ttsInFlightRequests.set(cacheKey, generatePromise);
  try {
    const result = await generatePromise;
    // Mantém cache LRU em memória limitado a 800 itens
    if (ttsMemoryCache.size > 800) {
      const firstKey = ttsMemoryCache.keys().next().value;
      ttsMemoryCache.delete(firstKey);
    }
    ttsMemoryCache.set(cacheKey, result);
    return result;
  } finally {
    ttsInFlightRequests.delete(cacheKey);
  }
}

// Endpoint de Áudio TTS em MP3 (Vozes Neurais Humanas, Calibração de Timbre e Reprodução em Segundo Plano)
app.get('/api/tts', async (req, res) => {
  try {
    const { lang, text, voice, speed, pitch } = req.query;
    if (!text) return res.status(400).send('Text required');
    const targetLang = (lang || 'en').split('-')[0].toLowerCase();
    const cleanText = String(text).replace(/^\s*\[[A-Za-z-]{2,8}\]\s*/g, '').trim();
    if (!cleanText) return res.status(400).send('Empty text');

    const result = await getOrGenerateTts(targetLang, cleanText, voice, speed, pitch);
    const buffer = result.buffer || result;
    const provider = result.provider || 'edge-neural';
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-TTS-Provider', provider);
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(buffer);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Endpoint de Transcrição Direta de Áudio Digital do Sistema / Arquivo (WAV 16kHz -> Whisper / Deepgram)
app.post('/api/stt-chunk', express.raw({ type: 'audio/wav', limit: '5mb' }), async (req, res) => {
  try {
    const wavBuffer = req.body;
    if (!wavBuffer || !Buffer.isBuffer(wavBuffer) || wavBuffer.length < 100) {
      return res.json({ text: '' });
    }
    const rawLang = (req.query.lang || 'pt-BR').split('-')[0].toLowerCase();
    const activeOpenAiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
    const activeGroqKey = process.env.GROQ_API_KEY;
    const activeDeepgramKey = process.env.DEEPGRAM_API_KEY;

    // 1. Groq Whisper Turbo / OpenAI Whisper
    if (activeGroqKey || activeOpenAiKey) {
      const endpoint = activeGroqKey
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions';
      const apiKey = activeGroqKey || activeOpenAiKey;
      const model = activeGroqKey ? 'whisper-large-v3-turbo' : 'whisper-1';

      const formData = new FormData();
      formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'chunk.wav');
      formData.append('model', model);
      formData.append('language', rawLang);
      formData.append('response_format', 'json');

      const sttRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(4500)
      });

      if (sttRes.ok) {
        const data = await sttRes.json();
        return res.json({ text: (data.text || '').trim(), provider: activeGroqKey ? 'groq' : 'openai' });
      }
    }

    // 2. Deepgram Nova-2 REST
    if (activeDeepgramKey) {
      const dgRes = await fetch(`https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=${encodeURIComponent(rawLang)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${activeDeepgramKey}`,
          'Content-Type': 'audio/wav'
        },
        body: wavBuffer,
        signal: AbortSignal.timeout(4500)
      });

      if (dgRes.ok) {
        const dgData = await dgRes.json();
        const transcript = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        return res.json({ text: transcript.trim(), provider: 'deepgram' });
      }
    }

    return res.json({ text: '', needsAcousticLoopback: true });
  } catch (err) {
    return res.json({ text: '', error: err.message });
  }
});

// ----------------------------------------------------
// WebSocket Server (Áudio Original + Tradução + Legendas)
// ----------------------------------------------------
const roomAudioMeta = new Map(); // roomId -> { type: 'audio_meta', format, sampleRate, kbps, profileName }
const roomSpeakerProfile = new Map(); // roomId -> { voice, pitch, speed }
const roomLastFinalTranscript = new Map(); // roomId -> { text, time }
const roomLastInterimTranslate = new Map(); // roomId -> { text, time, seq }
const roomCatchupHistory = new Map(); // roomId -> Array<{ seqId, type, lang, text, timestamp }>
let globalCatchupSeqId = 1;

function appendToCatchupHistory(roomId, entry) {
  if (!roomCatchupHistory.has(roomId)) {
    roomCatchupHistory.set(roomId, []);
  }
  const list = roomCatchupHistory.get(roomId);
  const now = Date.now();
  list.push({
    seqId: globalCatchupSeqId++,
    timestamp: now,
    ...entry
  });
  // Mantém janela dos últimos 40 segundos (máx 25 trechos) para recuperação de quedas de rede
  while (list.length > 25 || (list.length > 0 && (now - list[0].timestamp) > 40000)) {
    list.shift();
  }
}

// Codificador G.711 μ-law stateless para Degrade Quality individual por ouvinte no servidor
function encodeMuLawServerSample(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

/**
 * Converte sob demanda um pacote PCM16 para um ouvinte específico com conexão ruim:
 * - tier 1: G.711 μ-law na taxa original (-50% de consumo de banda, 100% stateless)
 * - tier 2: G.711 μ-law com decimação passa-baixas 2:1 (-75% de consumo de banda, 100% stateless)
 */
function buildDegradedAudioPacket(rawBuffer, targetTier) {
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  if (buf.length < 6 || buf[0] !== 0xAA) return buf;
  const codecId = buf[1];
  const sampleRate = buf[2] | (buf[3] << 8);

  // Se o Host já estiver enviando comprimido (mulaw/adpcm), mantém ou reduz taxa no Tier 2
  if (codecId !== 0) {
    return buf;
  }

  const numSamples = Math.floor((buf.length - 4) / 2);
  if (numSamples <= 0) return buf;

  if (targetTier === 1) {
    // Tier 1: Reduz 50% da banda (PCM 16-bit -> G.711 8-bit na mesma frequência)
    const out = Buffer.allocUnsafe(4 + numSamples);
    out[0] = 0xAA;
    out[1] = 1; // G.711 μ-law
    out[2] = sampleRate & 0xFF;
    out[3] = (sampleRate >> 8) & 0xFF;
    for (let i = 0; i < numSamples; i++) {
      const s = buf.readInt16LE(4 + i * 2);
      out[4 + i] = encodeMuLawServerSample(s);
    }
    return out;
  } else {
    // Tier 2: Reduz 75% da banda (Filtro anti-aliasing 2:1 + G.711 8-bit para conexões críticas)
    const halfSamples = Math.floor(numSamples / 2);
    const halfRate = Math.max(6000, Math.round(sampleRate / 2));
    const out = Buffer.allocUnsafe(4 + halfSamples);
    out[0] = 0xAA;
    out[1] = 1; // G.711 μ-law
    out[2] = halfRate & 0xFF;
    out[3] = (halfRate >> 8) & 0xFF;
    for (let i = 0; i < halfSamples; i++) {
      const s0 = buf.readInt16LE(4 + (i * 2) * 2);
      const s1 = buf.readInt16LE(4 + (i * 2 + 1) * 2);
      const avg = (s0 + s1) >> 1;
      out[4 + i] = encodeMuLawServerSample(avg);
    }
    return out;
  }
}

wss.on('connection', (ws, req) => {
  // Parse à prova de falhas com URL padrão Node.js e normalização de slug
  const parsedUrl = new URL(req.url, 'http://localhost');
  const rawRoom = parsedUrl.searchParams.get('roomId') || parsedUrl.searchParams.get('room') || 'palco1';
  const roomId = decodeURIComponent(rawRoom).trim().toLowerCase();
  const role = parsedUrl.searchParams.get('role') || 'listener';
  let channel = parsedUrl.searchParams.get('channel') || 'original';
  const lastSeenSeq = parseInt(parsedUrl.searchParams.get('lastSeq') || '0', 10);

  const clientId = 'c_' + Math.random().toString(36).substring(2, 9);
  ws.clientId = clientId;
  ws.roomId = roomId;
  ws.role = role;
  ws.channel = channel;
  ws.isAlive = true;
  ws.abrMode = 'auto'; // 'auto' | 'high' | 'saver'
  ws.abrTier = 0;      // 0 = Original PCM 256k, 1 = Degrade -50% (128k), 2 = Degrade -75% (64k)
  ws.lastAbrChangeTime = Date.now();

  const roomClients = getRoomClients(roomId);
  roomClients.add(ws);

  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    roomId,
    role,
    channel,
    timestamp: Date.now()
  }));

  // Envia perfil de compressão e taxa de bits atual da sala para novos ouvintes
  if (roomAudioMeta.has(roomId)) {
    try {
      ws.send(JSON.stringify(roomAudioMeta.get(roomId)));
    } catch (e) {}
  }

  // Envia perfil de voz calibrado do palestrante
  if (roomSpeakerProfile.has(roomId)) {
    try {
      ws.send(JSON.stringify({
        type: 'speaker_voice_profile',
        ...roomSpeakerProfile.get(roomId)
      }));
    } catch (e) {}
  }

  // Se o ouvinte reconectou após oscilação de rede, envia imediatamente os trechos recentes perdidos
  if (role === 'listener' && roomCatchupHistory.has(roomId)) {
    const now = Date.now();
    const recentItems = roomCatchupHistory.get(roomId).filter(
      item => item.seqId > lastSeenSeq && (now - item.timestamp) <= 30000
    );
    if (recentItems.length > 0) {
      try {
        ws.send(JSON.stringify({
          type: 'subtitle_catchup',
          items: recentItems
        }));
      } catch (e) {}
    }
  }

  // Notifica imediatamente anfitrião e telões sobre métricas de ouvintes online
  broadcastRoomStats(roomId);

  ws.on('message', async (data, isBinary) => {
    // 1. Mensagens Binárias: Chunks de Áudio
    if (isBinary) {
      if (ws.role !== 'host') return;

      // Cache sob demanda para pacotes degradados neste frame (só calcula se algum ouvinte precisar)
      let cachedTier1Packet = null;
      let cachedTier2Packet = null;

      // Broadcast inteligente do Áudio Original com Degrade Quality individual por ouvinte
      for (const client of roomClients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === 'original') {
          const backpressureBytes = client.bufferedAmount || 0;

          // Proteção contra congelamento total de TCP (se acumular >192KB na fila do sistema operacional, aguarda esvaziar)
          if (backpressureBytes > 196608) {
            client.abrTier = 2;
            client.lastAbrChangeTime = Date.now();
            continue;
          }

          // Adaptação automática por fila de congestão TCP individual daquele ouvinte
          let effectiveTier = client.abrTier || 0;
          if (client.abrMode === 'saver') {
            effectiveTier = 2;
          } else if (client.abrMode === 'high') {
            effectiveTier = backpressureBytes > 65536 ? 1 : 0;
          } else {
            if (backpressureBytes > 32768) {
              effectiveTier = 2;
              client.abrTier = 2;
              client.lastAbrChangeTime = Date.now();
            } else if (backpressureBytes > 12288 && effectiveTier < 1) {
              effectiveTier = 1;
              client.abrTier = 1;
              client.lastAbrChangeTime = Date.now();
            }
          }

          if (effectiveTier === 0) {
            client.send(data, { binary: true });
          } else if (effectiveTier === 1) {
            if (!cachedTier1Packet) cachedTier1Packet = buildDegradedAudioPacket(data, 1);
            client.send(cachedTier1Packet, { binary: true });
          } else {
            if (!cachedTier2Packet) cachedTier2Packet = buildDegradedAudioPacket(data, 2);
            client.send(cachedTier2Packet, { binary: true });
          }
        }
      }

      // Se o Host já estiver transcrevendo nativamente pelo navegador, ignora STT secundário
      if (ws.hasHostSpeechSTT) {
        return;
      }

      // Processamento de IA (Deepgram / Fallback)
      getRoom(roomId).then(room => {
        const sourceLang = room?.source_language || 'pt-BR';
        const targetLangs = room?.target_languages || ['en', 'es'];
        const glossary = room?.glossary || {};

        aiPipeline.feedAudio(roomId, data, sourceLang, async (sttEvent) => {
          const subtitlePayload = {
            type: 'subtitle',
            text: sttEvent.text,
            isFinal: sttEvent.isFinal,
            sourceLang,
            timestamp: sttEvent.timestamp
          };

          for (const client of roomClients) {
            if (client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.channel === 'original' || client.channel === 'text')) {
              client.send(JSON.stringify(subtitlePayload));
            }
          }

          if (sttEvent.isFinal) {
            const translations = await aiPipeline.translateText(sttEvent.text, targetLangs, glossary);
            await saveTranscript(roomId, sttEvent.text, translations);

            for (const [lang, translatedText] of Object.entries(translations)) {
              const transPayload = JSON.stringify({
                type: 'subtitle_translated',
                lang,
                text: translatedText,
                sourceText: sttEvent.text,
                timestamp: Date.now()
              });

              for (const client of roomClients) {
                if (client.readyState === WebSocket.OPEN && (client.channel === lang || client.role === 'screen')) {
                  client.send(transPayload);
                }
              }

              aiPipeline.synthesizeSpeech(translatedText, lang).then(ttsAudioBuffer => {
                if (ttsAudioBuffer) {
                  for (const client of roomClients) {
                    if (client.readyState === WebSocket.OPEN && client.channel === lang) {
                      client.send(ttsAudioBuffer, { binary: true });
                    }
                  }
                }
              });
            }
          }
        });
      });

      return;
    }

    // 2. Mensagens JSON
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'switch_channel') {
        ws.channel = msg.channel;
        ws.send(JSON.stringify({ type: 'channel_switched', channel: ws.channel }));
        broadcastRoomStats(roomId);
      } else if (msg.type === 'audio_meta') {
        roomAudioMeta.set(roomId, msg);
        for (const client of roomClients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        }
      } else if (msg.type === 'speech_transcript') {
        ws.hasHostSpeechSTT = true;
        const { text, isFinal, sourceLang } = msg;
        const currentSeqId = isFinal ? globalCatchupSeqId : undefined;
        const subPayload = JSON.stringify({
          type: 'subtitle',
          seqId: currentSeqId,
          text,
          isFinal,
          sourceLang: sourceLang || 'pt-BR',
          timestamp: Date.now()
        });

        for (const client of roomClients) {
          if (client !== ws && client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.role === 'listener' || client.channel === 'original' || client.channel === 'text')) {
            client.send(subPayload);
          }
        }

        if (isFinal) {
          const cleanText = (text || '').trim();
          if (!cleanText) return;

          // Registra fala original no buffer de recuperação de quedas de rede
          appendToCatchupHistory(roomId, {
            lang: 'original',
            text: cleanText
          });

          // Invalida qualquer tradução parcial (interim) anterior que ainda esteja em trânsito
          const prevInterim = roomLastInterimTranslate.get(roomId);
          roomLastInterimTranslate.set(roomId, { text: '', time: Date.now(), seq: (prevInterim?.seq || 0) + 1 });

          const lastObj = roomLastFinalTranscript.get(roomId);
          if (lastObj && lastObj.text.toLowerCase() === cleanText.toLowerCase() && (Date.now() - lastObj.time) < 400) {
            // Ignora apenas disparo duplicado instantâneo de rede (< 400ms)
            return;
          }
          roomLastFinalTranscript.set(roomId, { text: cleanText, time: Date.now() });

          getRoom(roomId).then(async (room) => {
            const targetLangs = room?.target_languages || ['en', 'es'];
            const glossary = room?.glossary || {};

            // Callback disparado instantaneamente no momento em que a tradução de cada idioma fica pronta (<100ms)
            const onLangReady = (lang, translatedText) => {
              const transSeqId = globalCatchupSeqId;
              appendToCatchupHistory(roomId, {
                lang,
                text: translatedText,
                sourceText: text
              });

              const transPayload = JSON.stringify({
                type: 'subtitle_translated',
                seqId: transSeqId,
                lang,
                text: translatedText,
                isFinal: true,
                sourceText: text,
                timestamp: Date.now()
              });

              for (const client of roomClients) {
                if (client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.role === 'listener')) {
                  client.send(transPayload);
                }
              }

              aiPipeline.synthesizeSpeech(translatedText, lang).then(ttsAudioBuffer => {
                if (ttsAudioBuffer) {
                  for (const client of roomClients) {
                    if (client.readyState === WebSocket.OPEN && client.channel === lang) {
                      client.send(ttsAudioBuffer, { binary: true });
                    }
                  }
                }
              }).catch(() => {});
            };

            const translations = await aiPipeline.translateText(text, targetLangs, glossary, onLangReady);

            // Persistência assíncrona não-bloqueante no banco de dados (não atrasa transmissão ao vivo)
            saveTranscript(roomId, text, translations).catch(err => {
              console.error('[DB] Erro não-bloqueante ao salvar transcrição:', err.message);
            });
          });
        } else {
          // Tradução simultânea em tempo real da fala em andamento (isFinal: false) para exibição imediata nas legendas
          const cleanInterim = (text || '').trim();
          const interimWords = cleanInterim.split(/\s+/).filter(Boolean);
          if (interimWords.length >= 2) {
            const lastInterim = roomLastInterimTranslate.get(roomId);
            const now = Date.now();
            if (!lastInterim || (cleanInterim.toLowerCase() !== lastInterim.text.toLowerCase() && (now - lastInterim.time) >= 420)) {
              const currentSeq = (lastInterim?.seq || 0) + 1;
              roomLastInterimTranslate.set(roomId, { text: cleanInterim, time: now, seq: currentSeq });

              getRoom(roomId).then(room => {
                const targetLangs = room?.target_languages || ['en', 'es'];
                const glossary = room?.glossary || {};

                aiPipeline.translateText(cleanInterim, targetLangs, glossary, (lang, translatedText) => {
                  // Só envia se esta prévia ainda for a mais recente (não atropela frase finalizada)
                  if (roomLastInterimTranslate.get(roomId)?.seq !== currentSeq) return;

                  const interimPayload = JSON.stringify({
                    type: 'subtitle_translated',
                    lang,
                    text: translatedText,
                    isFinal: false,
                    sourceText: cleanInterim,
                    timestamp: Date.now()
                  });

                  for (const client of roomClients) {
                    if (client !== ws && client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.role === 'listener')) {
                      client.send(interimPayload);
                    }
                  }
                }).catch(() => {});
              }).catch(() => {});
            }
          }
        }
      } else if (msg.type === 'set_screen_lang') {
        // Administrador/Host define remotamente o idioma, fundo chroma/preto e logo de todos os telões da sala
        for (const client of roomClients) {
          if (client.readyState === WebSocket.OPEN && client.role === 'screen') {
            client.send(JSON.stringify({
              type: 'screen_config',
              screenMode: msg.screenMode,
              screenLogo: msg.screenLogo || 'vmp',
              screenTheme: msg.screenTheme || 'theme-lowerthird',
              screenPosition: msg.screenPosition || 'pos-bottom',
              selectedLangs: msg.selectedLangs
            }));
          }
        }
      } else if (msg.type === 'p2p_signal') {
        // Roteamento de sinalização WebRTC P2P (Offer, Answer, ICE Candidate)
        const targetId = msg.targetClientId;
        for (const client of roomClients) {
          if (client.clientId === targetId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'p2p_signal',
              fromClientId: ws.clientId,
              signal: msg.signal
            }));
            break;
          }
        }
      } else if (msg.type === 'speaker_voice_profile') {
        // Calibração de timbre do palestrante transmitida pelo host
        roomSpeakerProfile.set(roomId, {
          voice: msg.voice || 'male_deep',
          pitch: msg.pitch || 0,
          speed: msg.speed || 1.05
        });
        for (const client of roomClients) {
          if (client !== ws && client.readyState === WebSocket.OPEN && client.roomId === roomId) {
            client.send(JSON.stringify({
              type: 'speaker_voice_profile',
              voice: msg.voice,
              pitch: msg.pitch,
              speed: msg.speed
            }));
          }
        }
      } else if (msg.type === 'p2p_find_peers') {
        // Retorna candidatos a pares na mesma sala e canal para mesh P2P
        const peers = [];
        for (const client of roomClients) {
          if (client !== ws && client.readyState === WebSocket.OPEN && client.roomId === roomId && client.role === 'listener' && client.channel === ws.channel) {
            peers.push(client.clientId);
            if (peers.length >= 4) break; // Limita a 4 vizinhos por nó para topologia leve
          }
        }
        ws.send(JSON.stringify({
          type: 'p2p_peers',
          peers
        }));
      } else if (msg.type === 'set_abr_mode') {
        ws.abrMode = msg.mode || 'auto';
        if (ws.abrMode === 'high') ws.abrTier = 0;
        else if (ws.abrMode === 'saver') ws.abrTier = 2;
        ws.lastAbrChangeTime = Date.now();
        ws.send(JSON.stringify({
          type: 'pong',
          abrTier: ws.abrTier,
          abrMode: ws.abrMode
        }));
      } else if (msg.type === 'ping') {
        if (msg.abrMode) ws.abrMode = msg.abrMode;
        const underruns = Number(msg.underruns || 0);
        const jitterMs = Number(msg.jitterMs || 0);
        const now = Date.now();

        if (ws.abrMode === 'saver') {
          ws.abrTier = 2;
        } else if (ws.abrMode === 'high') {
          ws.abrTier = 0;
        } else {
          // Modo Automático Inteligente por Ouvinte:
          if (underruns >= 2 || jitterMs > 140 || (ws.bufferedAmount || 0) > 24576) {
            ws.abrTier = 2; // Reduz 75% da banda imediatamente para estancar cortes
            ws.lastAbrChangeTime = now;
          } else if (underruns === 1 || jitterMs > 75 || (ws.bufferedAmount || 0) > 8192) {
            if (ws.abrTier < 1) ws.abrTier = 1; // Reduz 50% da banda preventivamente
            ws.lastAbrChangeTime = now;
          } else if (underruns === 0 && jitterMs < 45 && (ws.bufferedAmount || 0) < 2048 && ws.abrTier > 0 && (now - ws.lastAbrChangeTime) > 8000) {
            // Conexão do ouvinte estabilizou por >8s: restaura gradualmente até Linear PCM 100% puro
            ws.abrTier = Math.max(0, ws.abrTier - 1);
            ws.lastAbrChangeTime = now;
          }
        }

        ws.send(JSON.stringify({
          type: 'pong',
          abrTier: ws.abrTier,
          abrMode: ws.abrMode
        }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    roomClients.delete(ws);
    broadcastRoomStats(roomId);
    if (roomClients.size === 0) {
      roomsClients.delete(roomId);
      roomAudioMeta.delete(roomId);
      roomSpeakerProfile.delete(roomId);
      roomLastFinalTranscript.delete(roomId);
      roomCatchupHistory.delete(roomId);
    }
    if (ws.role === 'host') {
      aiPipeline.closeSession(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Videomappingtech Silent Translator no ar na porta ${PORT}`);
});
