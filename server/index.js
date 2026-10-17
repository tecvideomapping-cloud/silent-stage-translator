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
const { verifyPassword, createSession, removeSession, requireAuth, getSession, setSessionStore, tokenFrom: adminTokenFrom, revokeUserSessions } = require('./auth');
const { Commerce } = require('./commerce');

const { aiPipeline } = require('./ai-pipeline');
const QRCode = require('qrcode');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

const PORT = process.env.PORT || 3000;

app.use(require('./security').headers);
app.use(cors({origin:require('./security').corsOrigin,credentials:true}));
app.use(express.json());
app.get('/',(req,res,next)=>{
  if(!req.query.room&&!req.query.roomId)return res.sendFile(path.join(__dirname,'../public/landing.html'));
  next();
});
app.use(express.static(path.join(__dirname, '../public')));
app.set('trust proxy', process.env.TRUST_PROXY_HOPS !== undefined ? (isNaN(Number(process.env.TRUST_PROXY_HOPS)) ? process.env.TRUST_PROXY_HOPS : Number(process.env.TRUST_PROXY_HOPS)) : (process.env.NODE_ENV === 'production' ? 1 : true));

// Inicializa Banco e Redis
const databaseReady = initDb().catch(e=>{console.error('[DB] Inicialização indisponível:',e.message);return null;});

const commerce = new Commerce({ legacy: { invalidateRoom: require('./db').invalidateRoom, saveRoom } });
const ledgerReady=commerce.ready;
commerce.ready=Promise.all([ledgerReady,databaseReady]).then(([,database])=>{
  if(process.env.NODE_ENV==='production'&&!database)commerce.healthy=false;
});
commerce.startWorkers();
setSessionStore(commerce.store,()=>commerce.ready);
const adminSession=req=>getSession(adminTokenFrom(req));
const isAdminRequest=async req=>['admin','superadmin'].includes((await adminSession(req))?.role);
const requireAdmin = [requireAuth,(req,res,next)=>['admin','superadmin'].includes(req.user.role)?next():res.status(403).json({error:'Acesso administrativo obrigatório.'})];
app.use('/api/desktop',(req,res,next)=>{if(process.env.VMT_DESKTOP_MODE!=='1'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return res.status(404).json({error:'Recurso disponível apenas no aplicativo local.'});next();},require('../desktop/desktop-api'));
app.get('/api/health',(req,res)=>res.json({status:'alive'}));
app.get('/api/ready',async(req,res)=>{await commerce.ready;const ok=commerce.healthy&&await commerce.store.health()&&roomBus.healthy;res.status(ok?200:503).json({status:ok?'ready':'unavailable'});});
app.use('/api',async(req,res,next)=>{try{await commerce.readyOrFail();next()}catch{res.status(503).json({error:'Serviço temporariamente indisponível.'})}});
app.use('/api',commerce.router(requireAdmin));

// Existing administrative endpoints must not become a route around customer ownership.
app.use('/api',async(req,res,next)=>{
  try {
    const admin=await isAdminRequest(req);
    if(req.path.startsWith('/config/tts-keys')&&req.method!=='GET'||req.path.startsWith('/glossaries')){
      if(!admin)return res.status(403).json({error:'Acesso administrativo obrigatório.'});
    }
    if(req.path==='/tts'||req.path==='/stt-chunk'){
      if(!admin){
        const roomId=String(req.query.room||'');const isTts=req.path==='/tts';
        const access=await commerce.checkEventAccess(req,roomId,{operator:!isTts});
        if(!access&&!isTts)return res.status(403).json({error:'Entre na área do responsável para operar o evento.'});
        if(isTts&&!access?.owner){
          if(!access&&!await getRoom(roomId))return res.status(403).json({error:'Evento não disponível.'});
          const text=String(req.query.text||'').replace(/^\s*\[[A-Za-z-]{2,8}\]\s*/g,'').trim();
          const recent=await roomBus.getRoomState(roomId,'history')||roomCatchupHistory.get(roomId)||[];
          if(!recent.some(item=>item.text===text&&Date.now()-item.timestamp<=120000))return res.status(403).json({error:'Trecho de áudio não disponível neste evento.'});
        }
        if(req.path==='/stt-chunk'&&access){
          const auth=await commerce.session(req);
          if(req.get('X-CSRF-Token')!==auth?.session.csrfToken)return res.status(403).json({error:'Sessão desatualizada.'});
          const lease=(await commerce.store.list('connection',{eventId:roomId})).find(c=>c.role==='host'&&c.expiresAt>Date.now());
          if(!lease||!await commerce.consumeSocket({eventId:roomId,leaseId:lease.id,role:'host'}))return res.status(403).json({error:'Inicie uma transmissão com horas disponíveis.'});
        }
      }
    }
    if(req.path==='/rooms'&&req.method==='POST'&&req.body?.id&&await commerce.managedEvent(req.body.id))return res.status(409).json({error:'Eventos contratados são configurados na área do cliente.'});
    const eventPath=req.path.match(/^\/rooms\/([^/]+)(?:\/(glossary|transcripts|export))?$/);
    if(eventPath){
      const id=decodeURIComponent(eventPath[1]),action=eventPath[2];
      const event=await commerce.managedEvent(id);
      if(event){
        const order=await commerce.store.get('order',event.orderId);const owner=admin||await commerce.isOwner(req,event);
        if(action){if(!owner)return res.status(403).json({error:'Acesso reservado ao responsável pelo evento.'});}
        else if(!owner&&(order?.status!=='paid'||!event.published||event.revoked))return res.status(403).json({error:'Este evento ainda não está disponível para os participantes.'});
        if(req.method==='DELETE')return res.status(409).json({error:'Um evento contratado não pode ser excluído pelo cadastro de salas.'});
      }
      if(action&&action!=='glossary'&&!event&&!admin)return res.status(403).json({error:'Acesso administrativo obrigatório.'});
      if(action==='glossary'){
        const room=event?commerce.roomFromEvent(event):await getRoom(id);
        const key=req.body?.hostKey;
        if(!admin&&!(event&&await commerce.isOwner(req,event))&&(!room||!key||key==='admin'||key!==room.host_key))return res.status(403).json({error:'Acesso de operador obrigatório.'});
        req.operatorAuthorized=true;
        if(event){
          if(!admin){const auth=await commerce.session(req);if(req.get('X-CSRF-Token')!==auth?.session.csrfToken)return res.status(403).json({error:'Sessão desatualizada.'});}
          const glossary=req.body?.glossary;
          if(!glossary||typeof glossary!=='object'||Array.isArray(glossary)||Object.keys(glossary).length>300)return res.status(400).json({error:'Glossário inválido.'});
          await commerce.store.transaction(async tx=>{const current=await tx.get('event',id);current.glossary=glossary;await tx.put('event',id,current);await commerce.syncRoom(tx,current);});
          require('./db').invalidateRoom(id);return res.json({success:true,glossary});
        }
      }
    }
    next();
  }catch(e){res.status(e.status||503).json({error:e.status?e.message:'Serviço temporariamente indisponível.'});}
});

// Map de clientes conectados: roomId -> Set<ws>
const roomsClients=new Map();
const roomBus=new (require('./room-bus').RoomBus)({rooms:roomsClients,sync:client=>{
 if(typeof roomAudioMeta!=='undefined'&&roomAudioMeta.has(client.roomId))client.send(JSON.stringify(roomAudioMeta.get(client.roomId)));
 if(typeof roomSpeakerProfile!=='undefined'&&roomSpeakerProfile.has(client.roomId))client.send(JSON.stringify({type:'speaker_voice_profile',...roomSpeakerProfile.get(client.roomId)}));
}});


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
app.post('/api/auth/login', commerce.throttle('admin-login', 60), async (req, res) => {
  try {
    const rawEmail = req.body?.email || req.body?.username;
    const password = req.body?.password;
    if (typeof rawEmail!=='string'||typeof password!=='string'||rawEmail.length>254||password.length>128||!rawEmail||!password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const user = await getUserByEmail(rawEmail);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    let isValid = verifyPassword(password, user.password_hash, user.password_salt);
    if (!isValid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if(!user.password_hash.startsWith('scrypt:'))await updateUserPassword(user.email,password);
    const { token, expiresAt } = await createSession(user);
    res.cookie('vmt_admin_session',token,{httpOnly:true,sameSite:'lax',secure:req.secure,maxAge:7*86400000,path:'/'});
    res.json({
      success: true,
      token,
      expiresAt,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Checar sessão do admin
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Alterar senha
app.put('/api/auth/password', ...requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (typeof newPassword!=='string' || newPassword.length < 12 || newPassword.length>128) {
      return res.status(400).json({ error: 'A nova senha deve ter no mínimo 12 e no máximo 128 caracteres.' });
    }

    if(!await updateUserPassword(req.user.email,newPassword))throw new Error('Não foi possível atualizar a senha.');
    await revokeUserSessions(req.user.email);
    res.clearCookie('vmt_admin_session',{path:'/'});
    res.json({ success: true, message: 'Senha atualizada com sucesso.' });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Logout
app.post('/api/auth/logout', async (req, res) => {
  try{await removeSession(adminTokenFrom(req))}catch{return res.status(503).json({error:'Não foi possível encerrar a sessão. Tente novamente.'})}
  res.clearCookie('vmt_admin_session',{path:'/'});
  res.json({ success: true });
});

// ----------------------------------------------------
// GESTÃO DE CLIENTES / EMPRESAS (PROTEGIDO)
// ----------------------------------------------------

app.get('/api/clients', ...requireAdmin, async (req, res) => {
  try {
    const clients = await listClients();
    res.json({ clients });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

app.post('/api/clients', ...requireAdmin, async (req, res) => {
  try {
    const client = await saveClient(req.body);
    res.json({ success: true, client });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

app.delete('/api/clients/:id', ...requireAdmin, async (req, res) => {
  try {
    await deleteClient(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// ----------------------------------------------------
// GESTÃO DE SALAS / EVENTOS (PROTEGIDO)
// ----------------------------------------------------

// Listar todas as salas (Apenas Admin autenticado, inclui métricas online em tempo real)
app.get('/api/rooms', ...requireAdmin, async (req, res) => {
  try {
    const rooms = await listRooms();
    const roomsWithStats = rooms.map(r => ({
      ...r,
      onlineStats: getRoomOnlineStats(r.id)
    }));
    res.json({ rooms: roomsWithStats });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Relatório público/host de ouvintes e usuários online da sala
app.get('/api/rooms/:id/stats', async (req, res) => {
  try {
    const stats = getRoomOnlineStats(req.params.id);
    res.json({ roomId: req.params.id, ...stats });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Criar ou Atualizar Sala/Evento (Apenas Admin autenticado)
app.post('/api/rooms', ...requireAdmin, async (req, res) => {
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
      allowSubtitles,
      audioQuality,
      screenLogo,
      p2pEnabled
    } = req.body;

    const roomId = (id || `evento-${Date.now().toString(36)}`).trim().toLowerCase();
    if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(roomId))return res.status(400).json({error:'Identificador de sala inválido.'});
    if(targetLanguages!==undefined&&(!Array.isArray(targetLanguages)||targetLanguages.length>11||targetLanguages.some(x=>typeof x!=='string'||!['en','es','fr','de','it','ja','ko','zh','pt','ar','hi'].includes(x))))return res.status(400).json({error:'Idiomas inválidos.'});
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
      audio_quality: audioQuality || 'pcm256',
      screen_logo: screenLogo || 'vmp',
      p2p_enabled: p2pEnabled !== false,
      status: 'active',
      created_at: existing?.created_at || new Date()
    };

    await saveRoom(room);
    res.json({ success: true, room });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Excluir sala (Apenas Admin autenticado)
app.delete('/api/rooms/:id', ...requireAdmin, async (req, res) => {
  try {
    await deleteRoom(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Ver leads recebidos (Apenas Admin autenticado)
app.get('/api/leads', ...requireAdmin, async (req, res) => {
  try {
    const leads = await listLeads();
    res.json({ leads });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
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
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Atualizar glossário em tempo real (Palco)
app.put('/api/rooms/:id/glossary', async (req, res) => {
  try {
    const { hostKey, glossary } = req.body;
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    if (!req.operatorAuthorized && room.host_key !== hostKey) {
      return res.status(403).json({ error: 'Chave de host inválida' });
    }

    room.glossary = glossary;
    await saveRoom(room);
    res.json({ success: true, glossary: room.glossary });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
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
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Obter glossário específico
app.get('/api/glossaries/:id', async (req, res) => {
  try {
    const glossary = await getSavedGlossary(req.params.id);
    if (!glossary) return res.status(404).json({ error: 'Glossário não encontrado' });
    res.json(glossary);
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
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
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
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
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Deletar modelo de glossário
app.delete('/api/glossaries/:id', async (req, res) => {
  try {
    const success = await deleteSavedGlossary(req.params.id);
    res.json({ success });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Transcrições da sala
app.get('/api/rooms/:id/transcripts', async (req, res) => {
  try {
    const limit=Math.min(1000,Math.max(1,Number(req.query.limit)||500));const offset=Math.max(0,Number(req.query.offset)||0);
    if(!Number.isInteger(limit)||!Number.isInteger(offset))return res.status(400).json({error:'Paginação inválida.'});
    const transcripts=await getTranscripts(req.params.id,limit,offset);
    res.json({ transcripts });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Exportar legendas (SRT, TXT)
app.get('/api/rooms/:id/export', async (req, res) => {
  try {
    const { format = 'txt', lang } = req.query;
    const transcripts = await getTranscripts(req.params.id,null);
    
    if (format === 'srt') {
      let srtContent = '';
      transcripts.forEach((t, i) => {
        const text = (lang && t.translations?.[lang]) ? t.translations[lang] : t.source_text;
        const origin=Date.parse(transcripts[0]?.created_at)||0;
        const startSec=Math.max(0,((Date.parse(t.created_at)||origin)-origin)/1000);
        const next=transcripts[i+1];const endSec=next?Math.max(startSec+0.5,((Date.parse(next.created_at)||origin)-origin)/1000):startSec+3;
        const formatTime = (s) => {
          const hrs = String(Math.floor(s / 3600)).padStart(2, '0');
          const mins = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
          const secs=String(Math.floor(s%60)).padStart(2,'0');const ms=String(Math.floor((s%1)*1000)).padStart(3,'0');
          return `${hrs}:${mins}:${secs},${ms}`;
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
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

// Cadastro de Leads / Orçamentos pelo Site Institucional (Público)
app.post('/api/leads',commerce.throttle('leads',12), async (req, res) => {
  try {
    const lead = await saveLead(req.body);
    res.json({ success: true, lead });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
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
    if (activeOpenAiKey&&Math.abs(Number(pitch)||0)<0.01) {
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
    if (activeElevenLabsKey&&Math.abs(Number(pitch)||0)<0.01&&Math.abs((Number(speed)||1)-1)<0.01) {
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
    if(typeof text!=='string'||text.length>4000)return res.status(400).json({error:'Trecho de áudio inválido.'});
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
const roomTranslationQueues = new Map();
function enqueueRoomTranslation(roomId,task){const previous=roomTranslationQueues.get(roomId)||Promise.resolve();const current=previous.catch(()=>{}).then(task);roomTranslationQueues.set(roomId,current);current.finally(()=>{if(roomTranslationQueues.get(roomId)===current)roomTranslationQueues.delete(roomId)}).catch(()=>{});return current;}
const roomAudioMeta = new Map(); // roomId -> { type: 'audio_meta', format, sampleRate, kbps, profileName }
const roomSpeakerProfile = new Map(); // roomId -> { voice, pitch, speed }
const roomLastFinalTranscript = new Map(); // roomId -> { text, time }
const roomLastInterimTranslate = new Map(); // roomId -> { text, time, seq }
const roomCatchupHistory = new Map(); // roomId -> Array<{ seqId, type, lang, text, timestamp }>
let globalCatchupSeqId=Date.now()*1000;
aiPipeline.onTranslationFailure=(roomId,lang)=>{for(const c of roomsClients.get(roomId)||[])if(c.readyState===WebSocket.OPEN)c.send(JSON.stringify({type:'service_warning',message:'Tradução temporariamente indisponível para '+lang+'.'}));};

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
  roomBus.setRoomState(roomId,'history',list);
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
  if (!targetTier || targetTier <= 0) return rawBuffer;
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  if (buf.length < 6 || buf[0] !== 0xAA) return buf;
  const codecId = buf[1];
  const sampleRate = buf[2] | (buf[3] << 8);

  // Se o Host já estiver enviando comprimido (mulaw/adpcm), mantém
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
  } else if (targetTier >= 2) {
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
  return rawBuffer;
}

wss.on('connection',(ws,req)=>{handleConnection(ws,req).catch(()=>{ws.close(1011,'Conexão indisponível.');});});
async function handleConnection(ws,req){
  // Parse à prova de falhas com URL padrão Node.js e normalização de slug
  if(!require('./security').isAllowed(req.headers.origin)){ws.close(1008,'Origem não autorizada.');return;}
  const parsedUrl = new URL(req.url, 'http://localhost');
  const rawRoom = parsedUrl.searchParams.get('roomId') || parsedUrl.searchParams.get('room') || 'palco1';
  const roomId=rawRoom.trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(roomId)){ws.close(1008,'Identificador de sala inválido.');return;}
  const role = parsedUrl.searchParams.get('role') || 'listener';
  let channel = parsedUrl.searchParams.get('channel') || 'original';
  const lastSeenSeq = parseInt(parsedUrl.searchParams.get('lastSeq') || '0', 10);
  if(!['host','listener','screen'].includes(role)){ws.close(1008,'Tipo de conexão inválido');return;}
  let managed=null;
  try{
    const admin=await isAdminRequest(req);
    managed=await commerce.acquireSocket(req,roomId,role,channel,admin);
    if(!managed&&role==='host'){
      const room=await getRoom(roomId),key=parsedUrl.searchParams.get('hostKey');
      if(!admin&&(!room||!key||key!==room.host_key))throw Object.assign(new Error('Acesso de operador obrigatório.'),{status:403});
    }
    if(!managed){const room=await getRoom(roomId);if(!room)throw new Error('Evento não encontrado.');if(role!=='host'&&room.status!=='active')throw new Error('Evento indisponível.');if(role!=='host'&&!channelAllowed(room,channel))throw new Error('Canal indisponível.');if(role==='host'&&Array.from(roomsClients.get(roomId)||[]).some(c=>c.role==='host'&&c.readyState===WebSocket.OPEN))throw new Error('Já existe um transmissor conectado.');}
    if(ws.readyState!==WebSocket.OPEN){await commerce.releaseSocket(managed);return;}
  }catch(e){ws.close(1008,String(e.message||'Acesso indisponível').slice(0,115));return;}
  ws.commerce=managed;
  const operatorToken=role==='host'?adminTokenFrom(req):'';
  const entitlementTimer=setInterval(async()=>{
    try{
    if(operatorToken&&!await getSession(operatorToken)){ws.close(1008,'Sessão encerrada. Entre novamente.');return;}
    if(!managed&&!await getRoom(roomId)){ws.close(1008,'Evento indisponível.');return;}
    if(!await commerce.refreshSocket(managed))ws.close(1008,'O acesso a este evento não está ativo.');}catch{ws.close(1011,'Verificação de acesso indisponível.');}
  },15000);

  const clientId='c_'+require('crypto').randomUUID();
  ws.clientId = clientId;
  ws.roomId = roomId;
  ws.role = role;
  ws.channel = channel;
  ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true});
  ws.on('error',()=>{});
  ws.abrMode = 'auto'; // 'auto' | 'high' | 'saver'
  ws.abrTier = 0;      // 0 = Original PCM 256k, 1 = Degrade -50% (128k), 2 = Degrade -75% (64k)
  ws.lastAbrChangeTime = Date.now();

  const roomClients = getRoomClients(roomId);
  roomClients.add(ws);
  roomBus.attach(ws);

  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    roomId,
    role,
    channel,
    timestamp: Date.now()
  }));

  const sharedMeta=await roomBus.getRoomState(roomId,'audio_meta');
  if(sharedMeta)roomAudioMeta.set(roomId,sharedMeta);
  const sharedHistory=await roomBus.getRoomState(roomId,'history');
  if(Array.isArray(sharedHistory))roomCatchupHistory.set(roomId,sharedHistory);
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
  if ((role === 'listener' || role === 'screen') && roomCatchupHistory.has(roomId)) {
    const now = Date.now();
    const recentItems = roomCatchupHistory.get(roomId).filter(
      item => (role === 'screen' ? true : item.seqId > lastSeenSeq) && (now - item.timestamp) <= 30000
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
  ws.on('message', async (data, isBinary) => {
    try{if(managed&&role==='host'&&isBinary&&!await commerce.consumeSocket(managed)){ws.close(1008,'As horas de transmissão foram utilizadas.');return;}}catch{ws.close(1011,'Verificação de saldo indisponível.');return;}
    // 1. Mensagens Binárias: Chunks de Áudio
    if (isBinary) {
      if (ws.role !== 'host'||data.length>65536) return;

      // Broadcast direto do Áudio Original limpo em alta fidelidade (100% puro, sem degradação ou decimação com ruído)
      for (const client of roomClients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === 'original') {
          try {
            if(client.bufferedAmount>192*1024){client.close(1013,'Conexão lenta. Reconecte para continuar.');continue;}
            client.send(data, { binary: true });
          } catch {}
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

        let pcm;try{ws.sttDecoder??={};pcm=require('./audio-codec').decodeForStt(data,ws.sttDecoder)}catch{return;}
        aiPipeline.feedAudio(roomId, pcm, sourceLang, async (sttEvent) => {
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
            await enqueueRoomTranslation(roomId,async()=>{
            const translations = await aiPipeline.translateText(sttEvent.text, targetLangs, glossary, null, roomId);
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

              const profile = roomSpeakerProfile.get(roomId);
              const voice = profile?.voice || 'male_deep';
              const speed = profile?.speed || 1.05;
              const pitch = profile?.pitch || 0;

              getOrGenerateTts(lang, translatedText, voice, speed, pitch).catch(() => {});
            }
            });
          }
        });
      }).catch(()=>{});

      return;
    }

    // 2. Mensagens JSON
    try {
      const msg = JSON.parse(data.toString());
      const hostMessages=['audio_meta','speech_transcript','set_screen_lang','speaker_voice_profile'];
      if(hostMessages.includes(msg.type)&&ws.role!=='host')return;
      if(msg.type==='speech_transcript'&&(typeof msg.text!=='string'||msg.text.length>4000))return;
      if(managed&&msg.type==='speech_transcript'&&!await commerce.consumeSocket(managed)){ws.close(1008,'As horas de transmissão foram utilizadas.');return;}
      if(managed&&msg.type==='switch_channel'){
        const event=await commerce.managedEvent(roomId);
        if(!['original','text',...event.target_languages].includes(msg.channel))return;
      }
      if (msg.type === 'switch_channel') {
        const currentRoom=await getRoom(roomId);if(!currentRoom||!channelAllowed(currentRoom,msg.channel))return;
        ws.channel=msg.channel;
        roomBus.changed();
        ws.send(JSON.stringify({ type: 'channel_switched', channel: ws.channel }));
        broadcastRoomStats(roomId);
      } else if (msg.type === 'audio_meta') {
        roomAudioMeta.set(roomId, msg);
        roomBus.setRoomState(roomId,'audio_meta',msg);
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
          if (client !== ws && client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.role === 'listener' || client.role === 'host' || client.channel === 'original' || client.channel === 'text')) {
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

          enqueueRoomTranslation(roomId,()=>getRoom(roomId).then(async (room) => {
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
                if (client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.role === 'listener' || client.role === 'host')) {
                  client.send(transPayload);
                }
              }

              const profile = roomSpeakerProfile.get(roomId);
              const voice = profile?.voice || 'male_deep';
              const speed = profile?.speed || 1.05;
              const pitch = profile?.pitch || 0;

              getOrGenerateTts(lang, translatedText, voice, speed, pitch).catch(() => {});
            };

            const translations = await aiPipeline.translateText(text, targetLangs, glossary, onLangReady, roomId);

            // Persistência assíncrona não-bloqueante no banco de dados (não atrasa transmissão ao vivo)
            saveTranscript(roomId, text, translations).catch(err => {
              console.error('[DB] Erro não-bloqueante ao salvar transcrição:', err.message);
            });
          })).catch(()=>{});
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
                    if (client !== ws && client.readyState === WebSocket.OPEN && (client.role === 'screen' || client.role === 'listener' || client.role === 'host')) {
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
    clearInterval(entitlementTimer);
    commerce.releaseSocket(managed).catch(()=>{});
    roomClients.delete(ws);
    roomBus.detach(ws);
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
}

function channelAllowed(room,channel){return channel==='original'?room.allow_original_audio!==false:channel==='text'?room.allow_subtitles!==false:room.allow_translation!==false&&Array.isArray(room.target_languages)&&room.target_languages.includes(channel)}
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30000);heartbeat.unref();
wss.on('close',()=>{clearInterval(heartbeat);roomBus.close().catch(()=>{})});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      const addr = server.address();
      const currentPort = typeof addr === 'object' && addr ? addr.port : port;
      return resolve(currentPort);
    }
    const tryPort = (targetPort) => {
      const onError = (err) => {
        if (process.env.NODE_ENV!=='production' && err.code === 'EADDRINUSE' && targetPort < Number(port) + 20) {
          console.warn(`[Server] Porta ${targetPort} ocupada, tentando ${targetPort + 1}...`);
          server.removeListener('error', onError);
          tryPort(targetPort + 1);
        } else {
          server.removeListener('error', onError);
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(targetPort,process.env.VMT_DESKTOP_MODE==='1'?'127.0.0.1':'0.0.0.0', () => {
        server.removeListener('error', onError);
        const actualPort = server.address().port;
        console.log(`🚀 Videomappingtech Silent Translator no ar na porta ${actualPort}`);
        resolve(actualPort);
      });
    };
    tryPort(Number(port));
  });
}

if (require.main === module) {
  startServer(PORT).catch(err => {
    console.error('Falha ao iniciar servidor:', err);
    process.exit(1);
  });
}

module.exports={app,server,wss,commerce,startServer,roomBus};

