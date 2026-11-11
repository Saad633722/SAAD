'use strict';

const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const { loadUser, requireRole } = require('./auth');
const publicRoutes = require('./routes/public');
const customerRoutes = require('./routes/customer');
const adminRoutes = require('./routes/admin');
const inventoryRoutes = require('./routes/inventory');

function createApp(options = {}) {
  const db = options.db || openDatabase(options.dbPath || ':memory:', options);
  const app = express();
  app.locals.db = db;
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });

  // Basic CSRF protection: state-changing API calls must be JSON (cannot be sent by a plain cross-site form).
  app.use('/api', (req, res, next) => {
    const hasBody = req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && hasBody && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be sent as JSON.' });
    }
    next();
  });

  app.use(loadUser(db));
  app.use('/api', publicRoutes(db, { secureCookies: options.secureCookies }));
  app.use('/api/my', requireRole('customer'), customerRoutes(db));
  // The admin panel is shared by the admin and employees (PIN sign-in); routes limit what employees can do.
  app.use('/api/admin/inventory', requireRole(['admin', 'employee']), inventoryRoutes(db));
  app.use('/api/admin', requireRole(['admin', 'employee']), adminRoutes(db));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Pages: send people to the right panel.
  const pub = path.join(__dirname, '..', 'public');
  app.get(['/admin', '/admin/'], (req, res) => {
    if (!req.user || !['admin', 'employee'].includes(req.user.role)) return res.redirect('/staff');
    res.sendFile(path.join(pub, 'admin', 'index.html'));
  });
  app.get(['/app', '/app/'], (req, res) => {
    if (!req.user) return res.redirect('/');
    if (req.user.role !== 'customer') return res.redirect('/admin');
    res.sendFile(path.join(pub, 'app', 'index.html'));
  });
  // Shop tablet: the sign-in page opened on the PIN pad.
  app.get(['/staff', '/staff/'], (_req, res) => res.sendFile(path.join(pub, 'index.html')));
  app.use(express.static(pub, { index: 'index.html' }));

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
  });

  return app;
}

module.exports = { createApp };
