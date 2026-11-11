'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'cw_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function createSession(db, res, userId, { secure } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(secure),
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  return token;
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.run('DELETE FROM sessions WHERE token = ?', token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Middleware: attaches req.user when a valid session cookie is present. */
function loadUser(db) {
  return (req, _res, next) => {
    req.user = null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = db.get(
        `SELECT u.id, u.name, u.email, u.phone, u.role, u.loyalty_points, u.active, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`,
        token,
      );
      if (row && row.expires_at > Date.now() && row.active) {
        delete row.expires_at;
        req.user = row;
      } else if (row) {
        db.run('DELETE FROM sessions WHERE token = ?', token);
      }
    }
    next();
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in.' });
    if (role && req.user.role !== role) return res.status(403).json({ error: 'You do not have access to this area.' });
    next();
  };
}

/** Very small in-memory rate limiter for login / register endpoints. */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 20 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const t = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < t) {
      hits.set(key, { count: 1, reset: t + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  requireRole,
  rateLimit,
  SESSION_COOKIE,
};
