const crypto = require('crypto');

// Map em memória para cache rápido de tokens ativos
const activeSessions = new Map();
const revokedTokens = new Set();

const SESSION_SECRET = process.env.SESSION_SECRET || 'vmt-silent-stage-2026-auth-session-key-v1';

function signToken(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!data || !data.expiresAt || Date.now() > data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}

function hashPassword(password, salt = null) {
  const generatedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, generatedSalt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt: generatedSalt };
}

function verifyPassword(password, storedHash, storedSalt) {
  const { hash } = hashPassword(password, storedSalt);
  return hash === storedHash;
}

function createSession(user) {
  const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 dias de sessão contínua
  const sessionData = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role || 'admin',
    expiresAt,
    salt: crypto.randomBytes(8).toString('hex')
  };
  const token = signToken(sessionData);
  activeSessions.set(token, sessionData);
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  if (revokedTokens.has(token)) return null;

  // 1. Cache rápido em memória
  const memorySession = activeSessions.get(token);
  if (memorySession) {
    if (Date.now() > memorySession.expiresAt) {
      activeSessions.delete(token);
      return null;
    }
    return memorySession;
  }

  // 2. Validação criptográfica com auto-recuperação (sobrevive a reinicializações do servidor / Railway)
  const verified = verifyToken(token);
  if (verified) {
    activeSessions.set(token, verified);
    return verified;
  }

  return null;
}

function removeSession(token) {
  if (token) {
    activeSessions.delete(token);
    revokedTokens.add(token);
  }
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.token || req.headers['x-admin-token']);

  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Não autorizado. Faça login para continuar.' });
  }

  req.user = session;
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  removeSession,
  requireAuth
};
