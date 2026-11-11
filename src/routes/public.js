'use strict';

const express = require('express');
const { hashPassword, verifyPassword, createSession, destroySession, rateLimit } = require('../auth');
const { availability, HttpError, str, int, VEHICLE_TYPES, PAYMENT_METHODS, CATEGORIES } = require('../bookings');
const { now } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicSettings(s) {
  const keys = ['business_name', 'tagline', 'phone', 'address', 'currency', 'tax_rate', 'open_time', 'close_time', 'slot_minutes', 'open_days', 'booking_window_days', 'large_vehicle_surcharge', 'points_per_unit', 'reward_points', 'reward_value'];
  return Object.fromEntries(keys.map((k) => [k, s[k]]));
}

module.exports = function publicRoutes(db, { secureCookies }) {
  const r = express.Router();
  const limiter = rateLimit({ max: 30 });

  r.post('/auth/register', limiter, (req, res) => {
    const name = str(req.body.name, 80);
    const email = str(req.body.email, 120)?.toLowerCase();
    const phone = str(req.body.phone, 30);
    const password = String(req.body.password || '');
    if (!name) throw new HttpError(400, 'Please enter your name.');
    if (!email || !EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with this email already exists.');
    const { id } = db.run(
      "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'customer', ?)",
      name,
      email,
      phone,
      hashPassword(password),
      now(),
    );
    createSession(db, res, id, { secure: secureCookies });
    res.status(201).json({ user: { id, name, email, phone, role: 'customer', loyalty_points: 0 } });
  });

  r.post('/auth/login', limiter, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user || !verifyPassword(req.body.password || '', user.password_hash)) {
      throw new HttpError(401, 'Incorrect email or password.');
    }
    if (!user.active) throw new HttpError(403, 'This account has been disabled. Please contact us.');
    createSession(db, res, user.id, { secure: secureCookies });
    res.json({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, loyalty_points: user.loyalty_points } });
  });

  r.post('/auth/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => {
    res.json({ user: req.user });
  });

  r.get('/services', (_req, res) => {
    res.json({
      services: db.all(
        `SELECT id, name, description, price, duration_min, kind, category, warranty_months, maintenance_months
           FROM services WHERE active = 1 ORDER BY kind DESC, price`,
      ),
    });
  });

  r.get('/settings', (_req, res) => {
    res.json({ settings: publicSettings(db.getSettings()), vehicle_types: VEHICLE_TYPES, payment_methods: PAYMENT_METHODS, categories: CATEGORIES });
  });

  // ?duration=<minutes of work> checks that a bay is free for the whole job.
  // ?exclude=<booking id> ignores one of the caller's own bookings (used when rescheduling it).
  r.get('/availability', (req, res) => {
    let excludeId = int(req.query.exclude);
    if (excludeId) {
      const own = req.user && (req.user.role === 'admin' || db.get('SELECT 1 FROM bookings WHERE id = ? AND customer_id = ?', excludeId, req.user.id));
      if (!own) excludeId = null;
    }
    res.json(availability(db, String(req.query.date || ''), { duration: req.query.duration, excludeId }));
  });

  return r;
};
