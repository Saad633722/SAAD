'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone           TEXT,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
  loyalty_points  INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  plate       TEXT NOT NULL UNIQUE,
  make        TEXT,
  model       TEXT,
  year        INTEGER,
  color       TEXT,
  type        TEXT NOT NULL DEFAULT 'sedan',
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  price         REAL NOT NULL,
  duration_min  INTEGER NOT NULL DEFAULT 30,
  kind          TEXT NOT NULL CHECK (kind IN ('package', 'addon')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  position    TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  vehicle_id       INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  customer_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  service_id       INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name     TEXT NOT NULL,
  service_price    REAL NOT NULL,
  duration_min     INTEGER NOT NULL DEFAULT 30,
  scheduled_at     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  bay              INTEGER,
  staff_id         INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  subtotal         REAL NOT NULL DEFAULT 0,
  surcharge        REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  tax              REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0,
  points_redeemed  INTEGER NOT NULL DEFAULT 0,
  points_earned    INTEGER NOT NULL DEFAULT 0,
  payment_status   TEXT NOT NULL DEFAULT 'unpaid',
  payment_method   TEXT,
  customer_notes   TEXT,
  admin_notes      TEXT,
  mileage          INTEGER,
  source           TEXT NOT NULL DEFAULT 'online',
  rating           INTEGER,
  feedback         TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  cancelled_at     TEXT
);

CREATE TABLE IF NOT EXISTS booking_addons (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id  INTEGER REFERENCES services(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  price       REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_events (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT,
  actor_name  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicle_notes (
  id           INTEGER PRIMARY KEY,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'general',
  note         TEXT NOT NULL,
  author_name  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_vehicle   ON bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer  ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled ON bookings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status    ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_events_booking     ON booking_events(booking_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner     ON vehicles(owner_id);
`;

const DEFAULT_SETTINGS = {
  business_name: 'SparkleWash',
  phone: '+1 555 0100',
  address: '123 Main Street',
  currency: '$',
  tax_rate: 0, // percent
  open_time: '08:00',
  close_time: '18:00',
  slot_minutes: 30,
  bays: 3, // how many cars can be washed in the same time slot
  open_days: [1, 2, 3, 4, 5, 6], // 0 = Sunday
  booking_window_days: 30,
  large_vehicle_surcharge: 20, // percent, applied to SUV / truck / van
  points_per_unit: 1, // loyalty points earned per 1 currency unit spent
  reward_points: 100, // points needed for one reward
  reward_value: 10, // currency value of one reward
};

const DEFAULT_SERVICES = [
  ['Express Exterior', 'Foam wash, rinse and spot-free dry.', 15, 20, 'package'],
  ['Premium Wash', 'Exterior wash, wheels & rims, interior vacuum, windows.', 30, 40, 'package'],
  ['Interior Deep Clean', 'Full vacuum, seats shampoo, dashboard and door panels.', 45, 60, 'package'],
  ['Full Detail', 'Complete interior + exterior detail with clay bar and hand wax.', 120, 150, 'package'],
  ['Hand Wax', 'Carnauba hand wax for shine and protection.', 15, 15, 'addon'],
  ['Tire Shine', 'Long-lasting tire dressing.', 5, 5, 'addon'],
  ['Engine Bay Clean', 'Degrease and dress the engine bay.', 20, 20, 'addon'],
  ['Odor Removal', 'Ozone treatment to remove smells.', 15, 15, 'addon'],
  ['Headlight Restoration', 'Remove yellowing and haze from headlights.', 25, 25, 'addon'],
  ['Ceramic Coating', 'Ceramic spray sealant, up to 6 months protection.', 60, 30, 'addon'],
];

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local timestamp in "YYYY-MM-DD HH:MM:SS" form. */
function now(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function today(d = new Date()) {
  return now(d).slice(0, 10);
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  const plain = (row) => (row ? { ...row } : row);
  let depth = 0;

  const api = {
    raw: db,
    all: (sql, ...params) => stmt(sql).all(...clean(params)).map(plain),
    get: (sql, ...params) => plain(stmt(sql).get(...clean(params))),
    run: (sql, ...params) => {
      const r = stmt(sql).run(...clean(params));
      return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
    },
    exec: (sql) => db.exec(sql),
    /** Run fn in a transaction. Nested calls use savepoints. */
    tx(fn) {
      const name = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (err) {
        depth -= 1;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      }
    },
    getSettings() {
      const out = { ...DEFAULT_SETTINGS };
      for (const row of api.all('SELECT key, value FROM settings')) {
        try {
          out[row.key] = JSON.parse(row.value);
        } catch {
          out[row.key] = row.value;
        }
      }
      return out;
    },
    setSetting(key, value) {
      api.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(value),
      );
    },
    close: () => db.close(),
  };
  return api;
}

function openDatabase(file, { adminEmail, adminPassword, adminName } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA);
  const db = wrap(raw);

  // Seed: one admin account, default services, a couple of staff.
  const admin = db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!admin) {
    db.run(
      "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
      adminName || 'Administrator',
      (adminEmail || 'admin@carwash.local').toLowerCase(),
      null,
      hashPassword(adminPassword || 'admin123'),
      now(),
    );
  }
  if (!db.get('SELECT id FROM services LIMIT 1')) {
    for (const [name, description, price, duration, kind] of DEFAULT_SERVICES) {
      db.run(
        'INSERT INTO services (name, description, price, duration_min, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        name,
        description,
        price,
        duration,
        kind,
        now(),
      );
    }
  }
  if (!db.get('SELECT id FROM staff LIMIT 1')) {
    db.run("INSERT INTO staff (name, position, created_at) VALUES ('Alex Carter', 'Senior Washer', ?)", now());
    db.run("INSERT INTO staff (name, position, created_at) VALUES ('Sam Lee', 'Detailer', ?)", now());
  }
  // Clean up expired sessions on boot.
  db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  return db;
}

module.exports = { openDatabase, now, today, DEFAULT_SETTINGS };
