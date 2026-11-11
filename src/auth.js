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

/**
 * PINs are hashed with a keyed HMAC (secret stored in the database) so a PIN can be
 * looked up directly. A 4-digit PIN is short, so the PIN endpoint is strictly rate-limited.
 */
function pinHash(secret, pin) {
  return crypto.createHmac('sha256', secret).update(`pin:${pin}`).digest('hex');
}

const PIN_RE = /^\d{4}$/;

/** userId for admins/customers; staffId for employees signed in with a PIN. */
function createSession(db, res, userId, { secure, staffId = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  db.run('INSERT INTO sessions (token, user_id, staff_id, expires_at) VALUES (?, ?, ?, ?)', token, staffId ? null : userId, staffId, Date.now() + SESSION_TTL_MS);
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
      const s = db.get('SELECT user_id, staff_id, expires_at FROM sessions WHERE token = ?', token);
      let user = null;
      if (s && s.expires_at > Date.now()) {
        if (s.user_id) {
          const u = db.get('SELECT id, name, email, phone, role, loyalty_points, active FROM users WHERE id = ?', s.user_id);
          if (u && u.active) user = u;
        } else if (s.staff_id) {
          const st = db.get('SELECT id, name, phone, position, active, pin_hash FROM staff WHERE id = ?', s.staff_id);
          if (st && st.active && st.pin_hash) user = { id: st.id, staff_id: st.id, name: st.name, email: null, phone: st.phone, position: st.position, role: 'employee', active: 1 };
        }
      }
      if (user) req.user = user;
      else if (s) db.run('DELETE FROM sessions WHERE token = ?', token);
    }
    next();
  };
}

function requireRole(role) {
  const roles = Array.isArray(role) ? role : [role];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in.' });
    if (role && !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this area.' });
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

/**
 * Limits wrong attempts only (successful sign-ins don't count), so a busy shop
 * tablet isn't locked out, while guessing a 4-digit PIN stays impractical.
 */
function failureLimiter({ windowMs = 10 * 60 * 1000, max = 10 } = {}) {
  const fails = new Map();
  const entry = (req) => {
    const e = fails.get(req.ip);
    return e && e.reset > Date.now() ? e : null;
  };
  return {
    blocked: (req) => (entry(req)?.count || 0) >= max,
    fail(req) {
      const e = entry(req) || { count: 0, reset: Date.now() + windowMs };
      e.count += 1;
      fails.set(req.ip, e);
    },
    ok: (req) => fails.delete(req.ip),
  };
}

module.exports = {
  failureLimiter,
  pinHash,
  PIN_RE,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  requireRole,
  rateLimit,
  SESSION_COOKIE,
};
