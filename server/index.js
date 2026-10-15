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

// Listar todas as salas (Apenas Admin autenticado)
app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const rooms = await listRooms();
    res.json({ rooms });
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

// Endpoint de Áudio TTS em MP3 (Vozes Neurais Humanas, Calibração de Timbre e Reprodução em Segundo Plano)
app.get('/api/tts', async (req, res) => {
  try {
    const { lang, text, voice, speed, pitch } = req.query;
    if (!text) return res.status(400).send('Text required');
    const targetLang = (lang || 'en').split('-')[0].toLowerCase();
    const cleanText = text.trim();

    // 1. OpenAI Neural TTS (Vozes de altíssima fidelidade humana, entonação e respiração natural)
    if (process.env.OPENAI_API_KEY) {
      try {
        let openAiVoice = 'alloy';
        const v = (voice || '').toLowerCase();
        if (v === 'male_deep' || v === 'onyx' || v === 'baritone') {
          openAiVoice = 'onyx'; // Masculina profunda, encorpada e firme
        } else if (v === 'male_natural' || v === 'echo' || v === 'orador') {
          openAiVoice = 'echo'; // Masculina natural, equilibrada e aveludada
        } else if (v === 'female_warm' || v === 'nova' || v === 'expressiva') {
          openAiVoice = 'nova'; // Feminina expressiva, dinâmica e humana
        } else if (v === 'female_clear' || v === 'shimmer' || v === 'suave') {
          openAiVoice = 'shimmer'; // Feminina clara, calma e cristalina
        } else if (['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(v)) {
          openAiVoice = v;
        }

        const openAiSpeed = Math.max(0.85, Math.min(1.3, parseFloat(speed) || 1.05));

        const oaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'tts-1',
            input: cleanText,
            voice: openAiVoice,
            speed: openAiSpeed,
            response_format: 'mp3'
          }),
          signal: AbortSignal.timeout(4500)
        });

        if (oaiRes.ok) {
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          const buffer = Buffer.from(await oaiRes.arrayBuffer());
          return res.send(buffer);
        }
      } catch (oaiErr) {
        console.warn('[TTS OpenAI] Falha na síntese neural, usando contingência:', oaiErr.message);
      }
    }

    // 2. ElevenLabs Multilingual (Se configurado no .env)
    if (process.env.ELEVENLABS_API_KEY) {
      try {
        const v = (voice || '').toLowerCase();
        // ID de voz masculina ou feminina padrão
        const voiceId = (v.includes('female') || v === 'nova') 
          ? '21m00Tcm4TlvDq8ikWAM' // Rachel
          : 'ErXwobaYiN019PkySvjV'; // Antoni

        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: cleanText,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          }),
          signal: AbortSignal.timeout(4500)
        });

        if (elRes.ok) {
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          const buffer = Buffer.from(await elRes.arrayBuffer());
          return res.send(buffer);
        }
      } catch (elErr) {}
    }

    // 3. Fallback Direto de Baixa Latência (Google TTS com cache persistente)
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(targetLang)}&client=tw-ob&q=${encodeURIComponent(cleanText)}`;
    const response = await fetch(googleTtsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      signal: AbortSignal.timeout(3500)
    });
    if (response.ok) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buffer = Buffer.from(await response.arrayBuffer());
      return res.send(buffer);
    }
    res.status(502).send('TTS Provider Error');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ----------------------------------------------------
// WebSocket Server (Áudio Original + Tradução + Legendas)
// ----------------------------------------------------
const roomAudioMeta = new Map(); // roomId -> { type: 'audio_meta', format, sampleRate, kbps, profileName }
const roomSpeakerProfile = new Map(); // roomId -> { voice, pitch, speed }
const roomLastFinalTranscript = new Map(); // roomId -> { text, time }

wss.on('connection', (ws, req) => {
  // Parse à prova de falhas com URL padrão Node.js e normalização de slug
  const parsedUrl = new URL(req.url, 'http://localhost');
  const rawRoom = parsedUrl.searchParams.get('roomId') || parsedUrl.searchParams.get('room') || 'palco1';
  const roomId = decodeURIComponent(rawRoom).trim().toLowerCase();
  const role = parsedUrl.searchParams.get('role') || 'listener';
  let channel = parsedUrl.searchParams.get('channel') || 'original';

  const clientId = 'c_' + Math.random().toString(36).substring(2, 9);
  ws.clientId = clientId;
  ws.roomId = roomId;
  ws.role = role;
  ws.channel = channel;
  ws.isAlive = true;

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

  ws.on('message', async (data, isBinary) => {
    // 1. Mensagens Binárias: Chunks de Áudio
    if (isBinary) {
      if (ws.role !== 'host') return;

      // Broadcast direto do Áudio Original com baixíssima latência (Palestra Silenciosa)
      for (const client of roomClients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === 'original') {
          client.send(data, { binary: true });
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
        const subPayload = JSON.stringify({
          type: 'subtitle',
          text,
          isFinal,
          sourceLang: sourceLang || 'pt-BR',
          timestamp: Date.now()
        });

        for (const client of roomClients) {
          if (client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.role === 'listener' || client.channel === 'original' || client.channel === 'text')) {
            client.send(subPayload);
          }
        }

        if (isFinal) {
          const cleanText = (text || '').trim();
          if (!cleanText) return;

          const lastObj = roomLastFinalTranscript.get(roomId);
          if (lastObj && lastObj.text.toLowerCase() === cleanText.toLowerCase() && (Date.now() - lastObj.time) < 1500) {
            // Ignora disparo duplicado idêntico recebido em menos de 1.5s
            return;
          }
          roomLastFinalTranscript.set(roomId, { text: cleanText, time: Date.now() });

          getRoom(roomId).then(async (room) => {
            const targetLangs = room?.target_languages || ['en', 'es'];
            const glossary = room?.glossary || {};

            // Callback disparado instantaneamente no momento em que a tradução de cada idioma fica pronta (<100ms)
            const onLangReady = (lang, translatedText) => {
              const transPayload = JSON.stringify({
                type: 'subtitle_translated',
                lang,
                text: translatedText,
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
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    roomClients.delete(ws);
    if (roomClients.size === 0) {
      roomsClients.delete(roomId);
      roomAudioMeta.delete(roomId);
      roomSpeakerProfile.delete(roomId);
      roomLastFinalTranscript.delete(roomId);
    }
    if (ws.role === 'host') {
      aiPipeline.closeSession(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Videomappingtech Silent Translator no ar na porta ${PORT}`);
});
