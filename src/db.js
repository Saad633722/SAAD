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
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  price               REAL NOT NULL,
  duration_min        INTEGER NOT NULL DEFAULT 30,
  kind                TEXT NOT NULL CHECK (kind IN ('package', 'addon')),
  category            TEXT NOT NULL DEFAULT 'wash',
  warranty_months     INTEGER,
  maintenance_months  INTEGER,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
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
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  vehicle_id        INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  customer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  service_id        INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name      TEXT NOT NULL,
  service_price     REAL NOT NULL,
  service_category  TEXT,
  duration_min      INTEGER NOT NULL DEFAULT 30,
  scheduled_at      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  bay               INTEGER,
  staff_id          INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  subtotal          REAL NOT NULL DEFAULT 0,
  surcharge         REAL NOT NULL DEFAULT 0,
  discount          REAL NOT NULL DEFAULT 0,
  tax               REAL NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  points_redeemed   INTEGER NOT NULL DEFAULT 0,
  points_earned     INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'unpaid',
  payment_method    TEXT,
  customer_notes    TEXT,
  admin_notes       TEXT,
  mileage           INTEGER,
  source            TEXT NOT NULL DEFAULT 'online',
  rating            INTEGER,
  feedback          TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  cancelled_at      TEXT
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

-- Ceramic coatings, PPF and other treatments that carry a warranty and/or
-- need maintenance visits. Created automatically when such a job is completed,
-- or added by hand (e.g. a coating applied before the app was in use).
CREATE TABLE IF NOT EXISTS vehicle_protections (
  id                  INTEGER PRIMARY KEY,
  vehicle_id          INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  booking_id          INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  service_id          INTEGER REFERENCES services(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'other',
  applied_at          TEXT NOT NULL,
  warranty_months     INTEGER,
  warranty_until      TEXT,
  maintenance_months  INTEGER,
  details             TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_vehicle    ON bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer   ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled  ON bookings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status     ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_events_booking      ON booking_events(booking_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner      ON vehicles(owner_id);
CREATE INDEX IF NOT EXISTS idx_protections_vehicle ON vehicle_protections(vehicle_id);
`;

// Columns added after the first release. Existing databases get them on start-up.
const MIGRATIONS = [
  ['services', 'category', "TEXT NOT NULL DEFAULT 'wash'"],
  ['services', 'warranty_months', 'INTEGER'],
  ['services', 'maintenance_months', 'INTEGER'],
  ['bookings', 'service_category', 'TEXT'],
];

const DEFAULT_SETTINGS = {
  business_name: 'Mr.Clean Car Detailing',
  tagline: '& PPF Ceramic Coating',
  phone: '',
  address: '',
  currency: '$',
  tax_rate: 0, // percent
  open_time: '08:00',
  close_time: '18:00',
  slot_minutes: 30,
  bays: 3, // how many cars can be worked on at the same time
  open_days: [1, 2, 3, 4, 5, 6], // 0 = Sunday
  booking_window_days: 30,
  large_vehicle_surcharge: 20, // percent, applied to SUV / pickup / van
  points_per_unit: 1, // loyalty points earned per 1 currency unit spent
  reward_points: 500, // points needed for one reward
  reward_value: 25, // currency value of one reward
};

// Starter price list. Everything here can be edited under "Services & pricing".
// [name, description, price, duration (working minutes), kind, category, warranty months, maintenance every N months]
const DEFAULT_SERVICES = [
  ['Exterior Wash', 'Snow-foam pre-wash, hand wash, wheels and spot-free dry.', 15, 30, 'package', 'wash', null, null],
  ['Wash & Vacuum', 'Exterior hand wash plus interior vacuum, dashboard wipe-down and glass.', 25, 60, 'package', 'wash', null, null],
  ['Interior Detailing', 'Deep vacuum, seat and carpet shampoo, leather care, dashboard, vents and door panels.', 90, 240, 'package', 'detailing', null, null],
  ['Exterior Detailing', 'Iron and tar decontamination, clay bar, machine polish and paint sealant.', 120, 300, 'package', 'detailing', null, null],
  ['Full Car Detailing', 'Complete interior and exterior detailing for a showroom finish.', 190, 480, 'package', 'detailing', null, null],
  ['Paint Correction', 'Multi-stage machine polishing to remove swirl marks, holograms and light scratches.', 300, 600, 'package', 'detailing', null, null],
  ['Ceramic Coating – 1 Year', 'Decontamination, one-step polish and a 1-year ceramic coating for gloss and easy cleaning.', 350, 480, 'package', 'ceramic', 12, 3],
  ['Ceramic Coating – 3 Years', 'Paint correction and a 3-year 9H ceramic coating on paint and trims.', 750, 900, 'package', 'ceramic', 36, 6],
  ['Ceramic Coating – 5 Years', 'Two-stage paint correction and a multi-layer 5-year ceramic coating.', 1200, 1200, 'package', 'ceramic', 60, 6],
  ['PPF – Front Package', 'Self-healing clear paint protection film on front bumper, hood, fenders and mirrors.', 1200, 900, 'package', 'ppf', 60, 12],
  ['PPF – Full Body', 'Every painted panel wrapped in self-healing, stone-chip resistant clear film.', 4500, 2400, 'package', 'ppf', 120, 12],
  ['Engine Bay Cleaning', 'Safe degrease and dressing of the engine bay.', 30, 45, 'addon', 'detailing', null, null],
  ['Headlight Restoration', 'Removes yellowing and haze, finished with UV protection.', 40, 60, 'addon', 'detailing', null, null],
  ['Leather Conditioning', 'Cleans and nourishes leather seats and trims.', 25, 30, 'addon', 'detailing', null, null],
  ['Odor Removal', 'Ozone treatment to eliminate smells.', 30, 45, 'addon', 'detailing', null, null],
  ['Glass Ceramic Coating', 'Hydrophobic coating on all windows for better visibility in the rain.', 60, 45, 'addon', 'ceramic', 12, null],
  ['Wheel & Caliper Coating', 'Ceramic coating for wheels and calipers so brake dust wipes right off.', 120, 90, 'addon', 'ceramic', 12, null],
  ['Tire Shine', 'Long-lasting tire dressing.', 5, 10, 'addon', 'wash', null, null],
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

function migrate(raw) {
  for (const [table, column, definition] of MIGRATIONS) {
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes(column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function openDatabase(file, { adminEmail, adminPassword, adminName } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA);
  migrate(raw);
  const db = wrap(raw);

  // Seed: one admin account, the starter price list and a couple of staff.
  const admin = db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!admin) {
    db.run(
      "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
      adminName || 'Administrator',
      (adminEmail || 'admin@mrclean.local').toLowerCase(),
      null,
      hashPassword(adminPassword || 'admin123'),
      now(),
    );
  }
  if (!db.get('SELECT id FROM services LIMIT 1')) {
    for (const [name, description, price, duration, kind, category, warranty, maintenance] of DEFAULT_SERVICES) {
      db.run(
        `INSERT INTO services (name, description, price, duration_min, kind, category, warranty_months, maintenance_months, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name,
        description,
        price,
        duration,
        kind,
        category,
        warranty,
        maintenance,
        now(),
      );
    }
  }
  if (!db.get('SELECT id FROM staff LIMIT 1')) {
    db.run("INSERT INTO staff (name, position, created_at) VALUES ('Alex Carter', 'Senior Detailer', ?)", now());
    db.run("INSERT INTO staff (name, position, created_at) VALUES ('Sam Lee', 'PPF & Coating Installer', ?)", now());
  }
  // Clean up expired sessions on boot.
  db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  return db;
}

module.exports = { openDatabase, now, today, DEFAULT_SETTINGS };
