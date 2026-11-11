'use strict';

const express = require('express');
const { hashPassword, verifyPassword, createSession, destroySession, rateLimit, failureLimiter, pinHash, PIN_RE } = require('../auth');
const { availability, HttpError, str, int, VEHICLE_TYPES, CATEGORIES } = require('../bookings');
const { now } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicSettings(s) {
  const keys = ['business_name', 'tagline', 'phone', 'address', 'currency', 'tax_rate', 'open_time', 'close_time', 'slot_minutes', 'open_days', 'booking_window_days', 'large_vehicle_surcharge', 'points_per_unit', 'reward_points', 'reward_value', 'payment_methods', 'employee_can_discount'];
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

  // Quick sign-in for the shop: 4-digit PIN for the admin or an employee.
  const pinLimiter = failureLimiter({ max: 10 });
  r.post('/auth/pin', (req, res) => {
    if (pinLimiter.blocked(req)) throw new HttpError(429, 'Too many wrong PINs. Please wait 10 minutes.');
    const pin = String(req.body.pin || '');
    if (!PIN_RE.test(pin)) throw new HttpError(400, 'Enter your 4-digit PIN.');
    const hash = pinHash(db.pinSecret(), pin);
    const admin = db.get("SELECT * FROM users WHERE role = 'admin' AND active = 1 AND pin_hash = ?", hash);
    const staff = admin ? null : db.get('SELECT * FROM staff WHERE active = 1 AND pin_hash = ?', hash);
    if (!admin && !staff) {
      pinLimiter.fail(req);
      throw new HttpError(401, 'Wrong PIN.');
    }
    pinLimiter.ok(req);
    if (admin) {
      createSession(db, res, admin.id, { secure: secureCookies });
      return res.json({ user: { id: admin.id, name: admin.name, email: admin.email, role: 'admin' } });
    }
    createSession(db, res, null, { secure: secureCookies, staffId: staff.id });
    res.json({ user: { id: staff.id, staff_id: staff.id, name: staff.name, role: 'employee' } });
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
    const settings = db.getSettings();
    res.json({ settings: publicSettings(settings), vehicle_types: VEHICLE_TYPES, payment_methods: settings.payment_methods, categories: CATEGORIES });
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
