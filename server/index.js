require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const { initDb, saveRoom, getRoom, listRooms, deleteRoom, saveTranscript, getTranscripts, saveLead, listLeads } = require('./db');
const { pubSub } = require('./redis');
const { aiPipeline } = require('./ai-pipeline');

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

// Map de clientes conectados localmente: roomId -> Set<ws>
const roomsClients = new Map();

function getRoomClients(roomId) {
  if (!roomsClients.has(roomId)) {
    roomsClients.set(roomId, new Set());
  }
  return roomsClients.get(roomId);
}

// ----------------------------------------------------
// REST APIs (Admin, Eventos, Configuração e Leads)
// ----------------------------------------------------

// Listar todas as salas (Painel Admin)
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await listRooms();
    res.json({ rooms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar ou Atualizar Sala/Evento
app.post('/api/rooms', async (req, res) => {
  try {
    const {
      id,
      name,
      sourceLanguage,
      targetLanguages,
      glossary,
      bannerUrl,
      logoUrl,
      primaryColor,
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
      source_language: sourceLanguage || 'pt-BR',
      target_languages: targetLanguages || ['en', 'es'],
      glossary: glossary || {},
      banner_url: bannerUrl || '',
      logo_url: logoUrl || '',
      primary_color: primaryColor || '#06b6d4',
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

// Detalhes da sala (Público para ouvintes e telões)
app.get('/api/rooms/:id', async (req, res) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    
    // Oculta a host_key na resposta pública
    const { host_key, ...publicData } = room;
    res.json(publicData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excluir sala
app.delete('/api/rooms/:id', async (req, res) => {
  try {
    await deleteRoom(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar glossário em tempo real
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

// Transcrições da sala
app.get('/api/rooms/:id/transcripts', async (req, res) => {
  try {
    const transcripts = await getTranscripts(req.params.id);
    res.json({ transcripts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exportar legendas (SRT, VTT, TXT)
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

    // Formato TXT padrão
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

// Cadastro de Leads / Orçamentos pelo Site Institucional
app.post('/api/leads', async (req, res) => {
  try {
    const lead = await saveLead(req.body);
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const leads = await listLeads();
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// WebSocket Server (Áudio Original + Tradução + Legendas)
// ----------------------------------------------------

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', '?'));
  const roomId = urlParams.get('roomId') || 'palco1';
  const role = urlParams.get('role') || 'listener'; // 'host' | 'listener' | 'screen'
  let channel = urlParams.get('channel') || 'original'; // 'original' | 'en' | 'es' | 'text'

  ws.roomId = roomId;
  ws.role = role;
  ws.channel = channel;
  ws.isAlive = true;

  const roomClients = getRoomClients(roomId);
  roomClients.add(ws);

  ws.send(JSON.stringify({
    type: 'connected',
    roomId,
    role,
    channel,
    timestamp: Date.now()
  }));

  ws.on('message', async (data, isBinary) => {
    // 1. Mensagens Binárias: Chunks de Áudio
    if (isBinary) {
      if (ws.role !== 'host') return;

      // A) ROTA DO ÁUDIO ORIGINAL (PALESTRA SILENCIOSA)
      for (const client of roomClients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === 'original') {
          client.send(data, { binary: true });
        }
      }

      // B) ROTA DA IA (STT -> TRADUÇÃO -> TTS)
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
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    roomClients.delete(ws);
    if (ws.role === 'host') {
      aiPipeline.closeSession(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Videomappingtech Silent Translator no ar na porta ${PORT}`);
});
