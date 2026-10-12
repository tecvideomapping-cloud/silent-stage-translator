require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const { initDb, saveRoom, getRoom, saveTranscript, getTranscripts } = require('./db');
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
// REST APIs
// ----------------------------------------------------

// Criar nova sala
app.post('/api/rooms', async (req, res) => {
  try {
    const { id, name, sourceLanguage, targetLanguages, glossary } = req.body;
    const roomId = (id || `room-${Date.now().toString(36)}`).toLowerCase();
    const hostKey = `host-${Math.random().toString(36).substring(2, 10)}`;

    const room = {
      id: roomId,
      name: name || `Palestra ${roomId}`,
      host_key: hostKey,
      source_language: sourceLanguage || 'pt-BR',
      target_languages: targetLanguages || ['en', 'es'],
      glossary: glossary || {},
      status: 'active',
      created_at: new Date()
    };

    await saveRoom(room);
    res.json({ success: true, room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detalhes da sala
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

// Atualizar glossário em tempo real
app.put('/api/rooms/:id/glossary', async (req, res) => {
  try {
    const { hostKey, glossary } = req.body;
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    if (room.host_key !== hostKey) return res.status(403).json({ error: 'Chave de host inválida' });

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

// ----------------------------------------------------
// WebSocket Server (Áudio Original + Tradução + Legendas)
// ----------------------------------------------------

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', '?'));
  const roomId = urlParams.get('roomId') || 'demo';
  const role = urlParams.get('role') || 'listener'; // 'host' | 'listener' | 'screen'
  let channel = urlParams.get('channel') || 'original'; // 'original' | 'en' | 'es' | 'text'

  ws.roomId = roomId;
  ws.role = role;
  ws.channel = channel;
  ws.isAlive = true;

  const roomClients = getRoomClients(roomId);
  roomClients.add(ws);

  console.log(`[WS] Novo cliente conectado: Sala=${roomId}, Papel=${role}, Canal=${channel}. Total na sala: ${roomClients.size}`);

  // Enviar confirmação de conexão
  ws.send(JSON.stringify({
    type: 'connected',
    roomId,
    role,
    channel,
    timestamp: Date.now()
  }));

  ws.on('message', async (data, isBinary) => {
    // 1. Mensagens Binárias: Fluxo de Áudio em Tempo Real
    if (isBinary) {
      if (ws.role !== 'host') return; // Apenas o Host transmite áudio

      // A) ROTA DO ÁUDIO ORIGINAL (PALESTRA SILENCIOSA / ULTRA-BAIXA LATÊNCIA)
      // Broadcast imediato para todos os ouvintes no canal 'original'
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
          // Broadcast de legendas (interim ou final)
          const subtitlePayload = {
            type: 'subtitle',
            text: sttEvent.text,
            isFinal: sttEvent.isFinal,
            sourceLang,
            timestamp: sttEvent.timestamp
          };

          // Notifica telas e ouvintes
          for (const client of roomClients) {
            if (client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.channel === 'original' || client.channel === 'text')) {
              client.send(JSON.stringify(subtitlePayload));
            }
          }

          // Quando a frase for finalizada, traduz e gera TTS
          if (sttEvent.isFinal) {
            const translations = await aiPipeline.translateText(sttEvent.text, targetLangs, glossary);
            await saveTranscript(roomId, sttEvent.text, translations);

            // Broadcast de traduções em texto
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

              // Síntese de Voz (TTS) para canais de voz traduzida
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

    // 2. Mensagens JSON: Controle e Troca de Canais
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'switch_channel') {
        ws.channel = msg.channel;
        console.log(`[WS] Cliente trocou para canal: ${msg.channel}`);
        ws.send(JSON.stringify({ type: 'channel_switched', channel: ws.channel }));
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error('[WS] Erro ao parsear mensagem JSON:', e.message);
    }
  });

  ws.on('close', () => {
    roomClients.delete(ws);
    console.log(`[WS] Cliente desconectado. Restantes na sala ${roomId}: ${roomClients.size}`);
    if (ws.role === 'host') {
      aiPipeline.closeSession(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Videomappingtech Silent Translator no ar!`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`📱 Web App do Ouvinte: http://localhost:${PORT}`);
  console.log(`🎙️ Painel do Palestrante: http://localhost:${PORT}/host.html`);
  console.log(`📺 Telão de Palco: http://localhost:${PORT}/screen.html`);
  console.log(`====================================================`);
});
