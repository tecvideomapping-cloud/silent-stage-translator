const crypto = require('crypto');

// Map em memória para tokens de sessão ativos: token -> { userId, email, role, expiresAt }
const activeSessions = new Map();

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
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24 horas
  activeSessions.set(token, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role || 'admin',
    expiresAt
  });
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

function removeSession(token) {
  if (token) activeSessions.delete(token);
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : req.query.token;

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
