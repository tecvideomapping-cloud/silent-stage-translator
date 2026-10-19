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
  getClient,
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
} = require('./db');
const { verifyPassword, createSession, removeSession, requireAuth, getSession, setSessionStore, tokenFrom: adminTokenFrom, revokeUserSessions } = require('./auth');
const { Commerce,tokenFrom:customerTokenFrom } = require('./commerce');
const {ClientManagement,positiveId}=require('./client-management');

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
const clientManagement=new ClientManagement(require('./db'),commerce);
setSessionStore(commerce.store,()=>commerce.ready);
const adminSession=req=>getSession(adminTokenFrom(req));
const isAdminRequest=async req=>['admin','superadmin'].includes((await adminSession(req))?.role);
const requireAdmin = [requireAuth,(req,res,next)=>['admin','superadmin'].includes(req.user.role)?next():res.status(403).json({error:'Acesso administrativo obrigatório.'})];
app.use('/api/desktop',(req,res,next)=>{if(process.env.VMT_DESKTOP_MODE!=='1'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return res.status(404).json({error:'Recurso disponível apenas no aplicativo local.'});next();},require('../desktop/desktop-api'));
app.get('/api/health',(req,res)=>res.json({status:'alive'}));
app.get('/api/ready',async(req,res)=>{await commerce.ready;const ok=commerce.healthy&&await commerce.store.health()&&roomBus.healthy;res.status(ok?200:503).json({status:ok?'ready':'unavailable'});});
app.get('/api/latency',...requireAdmin,(req,res)=>res.json({translationProviders:aiPipeline.freeTranslator.stats()}));
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
        if(!access){const legacyRoom=await getRoom(roomId);if(legacyRoom)await validateLegacyRoom(legacyRoom);}
        if(!access&&!isTts)return res.status(403).json({error:'Entre na área do responsável para operar o evento.'});
        if(isTts&&!access?.owner){
          if(!access&&!await getRoom(roomId))return res.status(403).json({error:'Evento não disponível.'});
          const text=String(req.query.text||'').replace(/^\s*\[[A-Za-z-]{2,8}\]\s*/g,'').trim();
          const recent=await roomBus.getRoomState(roomId,'history')||roomCatchupHistory.get(roomId)||[];
          if(!recent.some(item=>item.text===text&&Date.now()-item.timestamp<=120000))return res.status(403).json({error:'Trecho de áudio não disponível neste evento.'});
        }
        if(req.path==='/stt-chunk'&&access){
          if(access.legacy){await validateLegacyRoom(await getRoom(roomId));if(![...(roomsClients.get(roomId)||[])].some(c=>c.role==='host'&&c.readyState===WebSocket.OPEN))return res.status(403).json({error:'Inicie uma transmissão antes de enviar o áudio.'});}
          const auth=await commerce.session(req);
          if(req.get('X-CSRF-Token')!==auth?.session.csrfToken)return res.status(403).json({error:'Sessão desatualizada.'});
          const lease=(await commerce.store.list('connection',{eventId:roomId})).find(c=>c.role==='host'&&c.expiresAt>Date.now());
          if(!access.legacy&&(!lease||!await commerce.consumeSocket({eventId:roomId,leaseId:lease.id,role:'host'})))return res.status(403).json({error:'Inicie uma transmissão com horas disponíveis.'});
        }
      }
    }
    if(req.path==='/rooms'&&req.method==='POST'&&req.body?.id&&await commerce.managedEvent(req.body.id))return res.status(409).json({error:'Eventos contratados são configurados na área do cliente.'});
    const eventPath=req.path.match(/^\/rooms\/([^/]+)(?:\/(glossary|transcripts|export))?$/);
    if(eventPath){
      const id=decodeURIComponent(eventPath[1]),action=eventPath[2];
      const event=await commerce.managedEvent(id);
      if(event){
        const order=await commerce.funding(event);const owner=admin||await commerce.isOwner(req,event);
        if(action){if(!owner)return res.status(403).json({error:'Acesso reservado ao responsável pelo evento.'});}
        else if(!owner&&(order?.status!=='paid'||await commerce.remaining(event)<=0||!event.published||event.revoked))return res.status(403).json({error:'Este evento ainda não está disponível para os participantes.'});
        if(req.method==='DELETE')return res.status(409).json({error:'Um evento contratado não pode ser excluído pelo cadastro de salas.'});
      }
      const legacyOwner=!event&&!admin&&await commerce.isLegacyOwner(req,await getRoom(id));
      if(action&&action!=='glossary'&&!event&&!admin&&!legacyOwner)return res.status(403).json({error:'Acesso administrativo obrigatório.'});
      if(action==='glossary'){
        const room=event?commerce.roomFromEvent(event):await getRoom(id);
        const key=req.body?.hostKey;
        if(!admin&&!legacyOwner&&!(event&&await commerce.isOwner(req,event))&&(!room||!key||key==='admin'||key!==room.host_key))return res.status(403).json({error:'Acesso de operador obrigatório.'});
        if(legacyOwner){const auth=await commerce.session(req);if(req.get('X-CSRF-Token')!==auth?.session.csrfToken)return res.status(403).json({error:'Sessão desatualizada.'});}
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

async function validateLegacyRoom(room){
 if(!room?.client_id)return;
 const client=await getClient(room.client_id);
 if(!client||client.status!=='active'||!['active','trial'].includes(client.license_status)||client.license_expires_at&&Date.parse(client.license_expires_at)<=Date.now()||Number(client.used_hours)>=Number(client.total_hours))throw Object.assign(new Error('A licença ou o saldo deste cliente não está disponível.'),{status:403});
}

// Map de clientes conectados: roomId -> Set<ws>
const roomsClients=new Map();
const roomBus=new (require('./room-bus').RoomBus)({rooms:roomsClients,sync:client=>{
 if(typeof roomAudioMeta!=='undefined'&&roomAudioMeta.has(client.roomId))client.send(JSON.stringify(roomAudioMeta.get(client.roomId)));
 if(typeof roomSpeakerProfile!=='undefined'&&roomSpeakerProfile.has(client.roomId))client.send(JSON.stringify({type:'speaker_voice_profile',...roomSpeakerProfile.get(client.roomId)}));
}});


function broadcastSourceRoster(roomId){const clients=roomsClients.get(roomId);if(!clients)return;const sources=[...clients].filter(c=>c.role==='host'&&c.readyState===WebSocket.OPEN).map(require('./multi-source').sourceView);const payload=JSON.stringify({type:'source_roster',sources,maxSources:require('./multi-source').MAX_SOURCES});for(const c of clients)if(c.role==='host'&&c.readyState===WebSocket.OPEN)c.send(JSON.stringify({...JSON.parse(payload),selfId:c.clientId}));}
roomBus.onChange=broadcastSourceRoster;
roomBus.onControl=source=>{if((source.sourceMuted||!source.sourceActive)&&aiPipeline.sttSockets.has(source.speechStreamKey))aiPipeline.closeSession(source.speechStreamKey);const payload=JSON.stringify({type:'audio_source_state',sourceId:source.clientId,muted:!!source.sourceMuted,active:!!source.sourceActive});for(const c of roomsClients.get(source.roomId)||[])if(c.readyState===WebSocket.OPEN)c.send(payload);};

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

app.use('/api/clients/:id',(req,res,next)=>{try{positiveId(req.params.id);next();}catch(e){res.status(400).json({error:e.message});}});

app.get('/api/clients/:id', ...requireAdmin, async (req, res) => {
  try {
    const client = await getClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const allRooms = await listRooms();
    const rooms = allRooms.filter(r => r.client_id === client.id);
    res.json({ client, rooms });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

const clientWrite=async(req,res)=>{
 try{const client=await clientManagement.save(req.body,req.params.id||null);res.json({success:true,client});}
 catch(error){res.status(error.status||500).json({error:error.status&&error.status<500?error.message:'Não foi possível salvar o cliente. Nenhuma alteração foi confirmada.'});}
};
app.post('/api/clients',...requireAdmin,clientWrite);
app.put('/api/clients/:id',...requireAdmin,clientWrite);
app.put('/api/clients/:id/license',...requireAdmin,async(req,res)=>{
 const fields=['plan','license_status','license_expires_at','max_rooms','max_listeners','total_hours','used_hours','notes'];
 req.body=Object.fromEntries(fields.filter(key=>req.body[key]!==undefined).map(key=>[key,req.body[key]]));return clientWrite(req,res);
});

app.get('/api/clients/:id/payments', ...requireAdmin, async (req, res) => {
  try {
    const client = await getClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const dbPayments = await listClientPayments(req.params.id);
    let commerceOrders = [];
    if (commerce?.store && client.email) {
      try {
        const emailAddr = String(client.email).trim().toLowerCase();
        const mapping = await commerce.store.get('email', emailAddr);
        if (mapping?.customerId) {
          const orders = await commerce.store.list('order', { customerId: mapping.customerId });
          commerceOrders = orders.map(o => ({
            id: 'order-' + o.id,
            client_id: client.id,
            amount_cents: o.amountCents,
            currency: o.currency || 'BRL',
            status: o.status,
            method: 'mercadopago',
            description: 'Pedido Online #' + o.id.slice(0, 8) + ' (' + (o.eventName || o.plan?.name || 'Evento') + ')',
            reference_id: o.paymentId || o.id,
            paid_at: o.paidAt || o.createdAt,
            created_at: o.createdAt,
            is_commerce_order: true
          }));
        }
      } catch { return res.status(503).json({error:'Histórico online temporariamente indisponível. Tente novamente.'}); }
    }
    const allPayments = [...dbPayments, ...commerceOrders].sort((a, b) => new Date(b.paid_at || b.created_at) - new Date(a.paid_at || a.created_at));
    res.json({ payments: allPayments });
  } catch (err) {
    res.status(err.status||500).json({error:err.status===503?'Serviço temporariamente indisponível.':'Não foi possível concluir a operação.'});
  }
});

app.post('/api/clients/:id/payments',...requireAdmin,async(req,res)=>{
 try{const payment=await clientManagement.payment(req.params.id,req.body);res.json({success:true,payment});}
 catch(error){res.status(error.status||500).json({error:error.status&&error.status<500?error.message:'Não foi possível registrar o pagamento. Nenhuma alteração foi confirmada.'});}
});

app.delete('/api/clients/:id/payments/:paymentId', ...requireAdmin, async (req, res) => {
  try {
    await clientManagement.removePayment(req.params.id,req.params.paymentId);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status||500).json({error:err.status&&err.status<500?err.message:'Não foi possível excluir o pagamento.'});
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
    if(clientId){positiveId(clientId);const client=await getClient(clientId);if(!client)return res.status(400).json({error:'Cliente não encontrado.'});const assigned=(await listRooms()).filter(r=>Number(r.client_id)===Number(clientId)&&r.id!==roomId);if(assigned.length>=client.max_rooms)return res.status(409).json({error:'O cliente atingiu o limite de eventos da licença.'});}
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
        const rawText = (lang && t.translations?.[lang]) ? t.translations[lang] : t.source_text;
      const label=[t.source_name,Number.isInteger(t.speaker_id)?'Locutor '+(t.speaker_id+1):''].filter(Boolean).join(' · ');
      const text=(label?label+': ':'')+rawText;
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
      const rawText = (lang && t.translations?.[lang]) ? t.translations[lang] : t.source_text;
      const label=[t.source_name,Number.isInteger(t.speaker_id)?'Locutor '+(t.speaker_id+1):''].filter(Boolean).join(' · ');
      const text=(label?label+': ':'')+rawText;
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
      console.warn('[TTS Edge Neural] Voz temporariamente indisponível:', edgeErr.message);
    }

    // Keep speaker timbre stable: a failed voice is retried, never replaced by Google default voices.
    throw Object.assign(new Error('Voice synthesis temporarily unavailable'),{status:503});
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

    const started=Date.now();
    const result = await getOrGenerateTts(targetLang, cleanText, voice, speed, pitch);
    const buffer = result.buffer || result;
    const provider = result.provider || 'edge-neural';
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-TTS-Provider', provider);
    res.setHeader('Server-Timing',`tts;dur=${Date.now()-started}`);
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
const orderedTranslations=new (require('./speech-turns').OrderedTranslations)();
const roomAudioMeta = new Map(); // roomId -> { type: 'audio_meta', format, sampleRate, kbps, profileName }
const roomSpeakerProfile = new Map(); // roomId -> { voice, pitch, speed }
const roomLastFinalTranscript = new Map(); // roomId -> { text, time }
const roomLastInterimTranslate = new Map(); // roomId -> { text, time, seq }
const roomInterimInFlight=new Set();
const roomCatchupHistory = new Map(); // roomId -> Array<{ seqId, type, lang, text, timestamp }>
let globalCatchupSeqId=Date.now()*1000;
const translationWarnings=new Map();
aiPipeline.onTranslationFailure=(roomId,lang)=>{const key=roomId+':'+lang;if(Date.now()-(translationWarnings.get(key)||0)<10000)return;translationWarnings.set(key,Date.now());for(const c of roomsClients.get(roomId)||[])if(c.readyState===WebSocket.OPEN)c.send(JSON.stringify({type:'service_warning',lang,message:'A tradução está temporariamente indisponível. A transcrição original continua ativa.'}));};

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

// Keep final text, translation, speaker identity and timing on the same segment.
async function processRecognizedSpeech(roomId,ws,event){
 if(ws.sourceMuted)return;
 const text=String(event.text||'').trim().slice(0,4000);if(!text)return;
 const clients=getRoomClients(roomId),now=Date.now();
 const meta={sourceId:ws.clientId,sourceName:ws.sourceName,sourceVoice:ws.speakerVoiceProfile, speakerId:Number.isInteger(event.speakerId)?event.speakerId:null,turnId:ws.clientId+':'+(event.turnId||require('crypto').randomUUID()),segmentId:ws.clientId+':'+(event.segmentId||require('crypto').randomUUID()),recognizedAt:now};
 const final=event.isFinal===true;
 const originalSeqId=final?globalCatchupSeqId:undefined;
 if(final){const last=roomLastInterimTranslate.get(roomId);roomLastInterimTranslate.set(roomId,{text:'',time:now,seq:(last?.seq||0)+1});}
 if(final){const previous=roomLastFinalTranscript.get(roomId);if(!event.segmentId&&previous?.text===text&&previous?.sourceId===ws.clientId&&now-previous.time<400)return;roomLastFinalTranscript.set(roomId,{text,time:now,sourceId:ws.clientId});appendToCatchupHistory(roomId,{...meta,lang:'original',text});}
 const payload=JSON.stringify({type:'subtitle',text,isFinal:final,seqId:originalSeqId,sourceLang:event.sourceLang||ws.speechRoom?.source_language||'pt-BR',...meta,timestamp:now});
 for(const client of clients)if(client.readyState===WebSocket.OPEN)client.send(payload);
 if(final){
  // Serialize only room lookup/registration, not provider response time.
  await enqueueRoomTranslation(roomId,async()=>{
   const room=await getRoom(roomId);if(!room)return;
   const lookupMs=Date.now()-now;
   const task=orderedTranslations.translate(roomId,text,room.target_languages||['en','es'],room.glossary||{},aiPipeline,(lang,translatedText,timing)=>{
    if(ws.sourceMuted)return;
    const readyAt=Date.now(),seqId=globalCatchupSeqId;translationWarnings.delete(roomId+':'+lang);
    appendToCatchupHistory(roomId,{...meta,lang,text:translatedText,sourceText:text});
    const profile=ws.speakerVoiceProfile||roomSpeakerProfile.get(roomId)||{};
    if([...clients].some(client=>client.role==='listener'&&client.channel===lang&&client.readyState===WebSocket.OPEN))getOrGenerateTts(lang,translatedText,profile.voice||'male_deep',profile.speed||1.05,profile.pitch||0).catch(()=>{});
    const translated=JSON.stringify({type:'subtitle_translated',text:translatedText,sourceText:text,lang,isFinal:true,seqId,...meta,translationReadyAt:readyAt,translationMs:readyAt-now,translationLookupMs:lookupMs,translationProviderMs:timing.providerMs,translationOrderingMs:timing.orderingWaitMs,timestamp:readyAt});
    for(const client of clients)if(client.readyState===WebSocket.OPEN)client.send(translated);
   },event.sourceLang||room.source_language||'pt');
   task.then(translations=>saveTranscript(roomId,text,translations,meta)).catch(()=>{});
  });
 }else{
  const last=roomLastInterimTranslate.get(roomId);if(roomInterimInFlight.has(roomId)||!aiPipeline.freeTranslator.canTranslateInterim()||text.split(/\s+/).length<4||last&&now-last.time<1500)return;
  roomInterimInFlight.add(roomId);
  const seq=(last?.seq||0)+1;roomLastInterimTranslate.set(roomId,{text,time:now,seq});
  getRoom(roomId).then(room=>room&&aiPipeline.translateText(text,room.target_languages||['en','es'],room.glossary||{},(lang,translatedText)=>{
   if(roomLastInterimTranslate.get(roomId)?.seq!==seq)return;
   const partial=JSON.stringify({type:'subtitle_translated',text:translatedText,sourceText:text,lang,isFinal:false,...meta,timestamp:Date.now()});
   for(const client of clients)if(client.readyState===WebSocket.OPEN)client.send(partial);
  },roomId,event.sourceLang||room.source_language||'pt')).catch(()=>{}).finally(()=>roomInterimInFlight.delete(roomId));
 }
}

aiPipeline.onRecognitionStatus=(streamKey,status)=>{const roomId=streamKey.split(':')[0];for(const client of roomsClients.get(roomId)||[])if(client.role==='host'&&(!streamKey.includes(':')||client.speechStreamKey===streamKey)&&client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'speech_recognition',...status}));};

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
  let managed=null,operatorAdmin=false;
  try{
    const admin=await isAdminRequest(req);operatorAdmin=admin;
    managed=await commerce.acquireSocket(req,roomId,role,channel,admin);
    if(!managed&&role==='host'){
      const room=await getRoom(roomId),key=parsedUrl.searchParams.get('hostKey');
      if(!admin&&!await commerce.isLegacyOwner(req,room)&&(!room||!key||key!==room.host_key))throw Object.assign(new Error('Acesso de operador obrigatório.'),{status:403});
    }
    if(!managed){const room=await getRoom(roomId);if(!room)throw new Error('Evento não encontrado.');if(role!=='host'&&room.status!=='active')throw new Error('Evento indisponível.');if(role!=='host'&&!channelAllowed(room,channel))throw new Error('Canal indisponível.');if(role==='host'&&Array.from(roomsClients.get(roomId)||[]).filter(c=>c.role==='host'&&c.readyState===WebSocket.OPEN).length>=require('./multi-source').MAX_SOURCES)throw Object.assign(new Error('O evento atingiu o limite de transmissores simultâneos.'),{status:409});}
    if(!managed){const room=await getRoom(roomId);await validateLegacyRoom(room);if(role==='listener'&&room.client_id){const client=await getClient(room.client_id),ids=new Set((await listRooms()).filter(r=>Number(r.client_id)===Number(room.client_id)).map(r=>r.id));let count=0;for(const id of ids)count+=[...(roomsClients.get(id)||[])].filter(c=>c.role==='listener'&&c.readyState===WebSocket.OPEN).length;if(count>=client.max_listeners)throw Object.assign(new Error('O cliente atingiu o limite de participantes simultâneos.'),{status:403});}}
    if(ws.readyState!==WebSocket.OPEN){await commerce.releaseSocket(managed);return;}
  }catch(e){ws.close(e.status===409?1013:1008,String(e.message||'Acesso indisponível').slice(0,115));return;}
  ws.commerce=managed;
  const operatorToken=role==='host'&&operatorAdmin?adminTokenFrom(req):'';
  const customerOperatorToken=role==='host'&&!operatorAdmin?customerTokenFrom(req):'';
  const entitlementTimer=setInterval(async()=>{
    try{
    if(customerOperatorToken&&!await commerce.session({headers:{'x-session-token':customerOperatorToken}})){ws.close(1008,'Sessão encerrada. Entre novamente.');return;}
    if(operatorToken&&!await getSession(operatorToken)){ws.close(1008,'Sessão encerrada. Entre novamente.');return;}
    if(!managed){const room=await getRoom(roomId);if(!room){ws.close(1008,'Evento indisponível.');return;}await validateLegacyRoom(room);}
    if(!await commerce.refreshSocket(managed))ws.close(1008,'O acesso a este evento não está ativo.');}catch{ws.close(1011,'Verificação de acesso indisponível.');}
  },15000);

  const clientId='c_'+require('crypto').randomUUID();
  ws.clientId = clientId;
  ws.roomId = roomId;
  ws.role = role;
  ws.channel = channel;
  ws.multiAudio=parsedUrl.searchParams.get('multiAudio')==='1';
  ws.sourceName='Dispositivo '+clientId.slice(-4);ws.sourceMuted=false;ws.sourceActive=false;
  ws.speechStreamKey=roomId+':'+clientId;
  ws.speechRoom=await getRoom(roomId);
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
    speechRecognition:{provider:aiPipeline.useStreaming(roomId)?'deepgram':'browser',diarization:aiPipeline.useStreaming(roomId)},
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
    if(isBinary&&(ws.role!=='host'||data.length<6||data.length>65536||data[0]!==0xaa||data[1]>2||data.readUInt16LE(2)<8000||data.readUInt16LE(2)>48000||data[1]===0&&(data.length-4)%2))return;
    if(isBinary&&ws.sourceMuted){if(data[1]===2){try{ws.sttDecoder??={};require('./audio-codec').decodeForStt(data,ws.sttDecoder);}catch{}}return;}
    try{if(managed&&role==='host'&&isBinary&&!ws.sourceMuted&&!await commerce.consumeSocket(managed)){ws.close(1008,'As horas de transmissão foram utilizadas.');return;}}catch{ws.close(1011,'Verificação de saldo indisponível.');return;}
    // 1. Mensagens Binárias: Chunks de Áudio
    if (isBinary) {
      if (ws.role !== 'host'||data.length>65536||ws.sourceMuted) return;
      ws.lastAudioAt=Date.now();
      if(!ws.sourceActive){ws.sourceActive=true;roomBus.changed(roomId);}
      let decodedPcm=null,legacyAudio=data;
      if(data[0]!==0xaa||data.length<6||data[1]>2||data.readUInt16LE(2)<8000||data.readUInt16LE(2)>48000)return;
      if(data[1]===2){try{ws.sttDecoder??={};const rate=data.readUInt16LE(2),header=Buffer.from(data.subarray(0,4));header[1]=0;const nativePcm=require('./audio-codec').decodeForStt(data,ws.sttDecoder,rate);legacyAudio=Buffer.concat([header,nativePcm]);decodedPcm=rate===16000?nativePcm:require('./audio-codec').decodeForStt(legacyAudio);}catch{return;}}
      const routedAudio=require('./multi-source').wrapAudio(ws.clientId,legacyAudio);
      const primary=[...roomClients].filter(c=>c.role==='host'&&c.readyState===WebSocket.OPEN&&!c.sourceMuted&&c.sourceActive).sort((a,b)=>a.clientId.localeCompare(b.clientId))[0];

      // Broadcast direto do Áudio Original limpo em alta fidelidade (100% puro, sem degradação ou decimação com ruído)
      for (const client of roomClients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === 'original' && client.role==='listener' && (client.multiAudio||primary?.clientId===ws.clientId)) {
          try {
            if(client.bufferedAmount>192*1024){client.close(1013,'Conexão lenta. Reconecte para continuar.');continue;}
            if(!client.multiAudio&&!client.multiWarningSent&&[...roomClients].filter(c=>c.role==='host'&&c.sourceActive).length>1){client.multiWarningSent=true;client.send(JSON.stringify({type:'service_warning',lang:'original',message:'Atualize a página do participante para ouvir todos os dispositivos simultaneamente.'}));}
            client.send(client.multiAudio?routedAudio:legacyAudio, { binary: true });
          } catch {}
        }
      }

      // Se o Host já estiver transcrevendo nativamente pelo navegador, ignora STT secundário
      if (ws.localRecognition || (ws.hasHostSpeechSTT&&!aiPipeline.useStreaming(ws.speechStreamKey))) {
        return;
      }

      // Feed frames synchronously in arrival order; translation reads room settings separately.
      let pcm;try{ws.sttDecoder??={};pcm=decodedPcm||require('./audio-codec').decodeForStt(data,ws.sttDecoder)}catch{return;}
      aiPipeline.feedAudio(ws.speechStreamKey,pcm,ws.speechRoom?.source_language||'pt-BR',event=>ws.localRecognition?undefined:processRecognizedSpeech(roomId,ws,event));

      return;
    }

    // 2. Mensagens JSON
    try {
      const msg = JSON.parse(data.toString());
      const hostMessages=['audio_meta','speech_transcript','set_screen_lang','speaker_voice_profile','recognition_mode','source_hello','source_live','source_mute'];
      if(hostMessages.includes(msg.type)&&ws.role!=='host')return;
      if(msg.type==='speech_transcript'&&(typeof msg.text!=='string'||msg.text.length>4000))return;
      if(msg.type==='speech_transcript'&&ws.sourceMuted)return;
      if(managed&&msg.type==='speech_transcript'&&!await commerce.consumeSocket(managed)){ws.close(1008,'As horas de transmissão foram utilizadas.');return;}
      if(managed&&msg.type==='switch_channel'){
        const event=await commerce.managedEvent(roomId);
        if(!['original','text',...event.target_languages].includes(msg.channel))return;
      }
      if(msg.type==='source_hello'){
        const name=typeof msg.name==='string'?msg.name.trim().replace(/[\u0000-\u001f]/g,'').slice(0,48):'';
        if(name)roomBus.controlSource(ws.clientId,roomId,{sourceName:name});return;
      }
      if(msg.type==='source_live'){if(msg.active===true)ws.lastAudioAt=Date.now();roomBus.controlSource(ws.clientId,roomId,{sourceActive:msg.active===true});return;}
      if(msg.type==='source_mute'){
        const target=[...roomClients].find(c=>c.role==='host'&&c.clientId===msg.sourceId);
        if(target&&typeof msg.muted==='boolean')roomBus.controlSource(target.clientId,roomId,{sourceMuted:msg.muted});return;
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
      } else if (msg.type === 'recognition_mode') {
        ws.localRecognition=msg.mode==='desktop-local';
        if(ws.localRecognition)aiPipeline.closeSession(ws.speechStreamKey);
      } else if (msg.type === 'speech_transcript') {
        if(aiPipeline.useStreaming(ws.speechStreamKey)&&!ws.localRecognition)return;
        ws.hasHostSpeechSTT=true;
        const local=msg.source==='desktop-local';
        const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(value)?value:null;
        processRecognizedSpeech(roomId,ws,{text:msg.text,isFinal:msg.isFinal===true,sourceLang:msg.sourceLang,source:local?'desktop-local':'browser',speakerId:local&&Number.isInteger(msg.speakerId)&&msg.speakerId>=0&&msg.speakerId<10000?msg.speakerId:null,turnId:safeId(msg.turnId),segmentId:safeId(msg.segmentId)}).catch(()=>{});
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
          const previous=ws.speakerVoiceProfile;
          const requested=['male_deep','male_natural','female_warm','female_clear','alloy','echo','fable','onyx','nova','shimmer'].includes(msg.voice)?msg.voice:'male_deep';
          const profile={voice:previous&&msg.manual!==true?previous.voice:requested,pitch:Math.max(-8,Math.min(8,Number(msg.pitch)||0)),speed:Math.max(.75,Math.min(1.45,Number(msg.speed)||1.05))};
          ws.speakerVoiceProfile=profile;roomSpeakerProfile.set(roomId,profile);
          for (const client of roomClients)if(client!==ws&&client.readyState===WebSocket.OPEN&&client.roomId===roomId)client.send(JSON.stringify({type:'speaker_voice_profile',...profile}));
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
      aiPipeline.closeSession(ws.speechStreamKey);
      for(const c of roomClients)if(c.readyState===WebSocket.OPEN)c.send(JSON.stringify({type:'audio_source_end',sourceId:ws.clientId}));
    }
  });
}

function channelAllowed(room,channel){return channel==='original'?room.allow_original_audio!==false:channel==='text'?room.allow_subtitles!==false:room.allow_translation!==false&&Array.isArray(room.target_languages)&&room.target_languages.includes(channel)}
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30000);heartbeat.unref();
const sourceActivityTimer=setInterval(()=>{for(const ws of wss.clients)if(ws.role==='host'&&ws.sourceActive&&Date.now()-(ws.lastAudioAt||0)>5000)roomBus.controlSource(ws.clientId,ws.roomId,{sourceActive:false});},1000);sourceActivityTimer.unref();
wss.on('close',()=>{clearInterval(sourceActivityTimer);clearInterval(heartbeat);roomBus.close().catch(()=>{})});

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
        console.log(`🚀 Silent Stage no ar na porta ${actualPort}`);
        resolve(actualPort);
      });
    };
    tryPort(Number(port));
  });
}

if (require.main === module) {
  let shuttingDown=false;
  process.once('SIGTERM',async()=>{
    if(shuttingDown)return;shuttingDown=true;commerce.stopWorkers();
    const deadline=setTimeout(()=>process.exit(0),8000);deadline.unref();
    for(const client of wss.clients)client.close(1012,'Serviço reiniciando. Reconectando.');
    await roomBus.close().catch(()=>{});
    server.close(()=>process.exit(0));
  });
  startServer(PORT).catch(err => {
    console.error('Falha ao iniciar servidor:', err);
    process.exit(1);
  });
}

module.exports={app,server,wss,commerce,startServer,roomBus};

