'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { hashPassword, pinHash } = require('./auth');

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

-- A session belongs to a user (admin / customer) or to a staff member signed in with a PIN.
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  staff_id    INTEGER REFERENCES staff(id) ON DELETE CASCADE,
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
  manual_discount   REAL NOT NULL DEFAULT 0,
  discount_type     TEXT NOT NULL DEFAULT 'amount',
  discount_value    REAL NOT NULL DEFAULT 0,
  discount_reason   TEXT,
  tax               REAL NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  points_redeemed   INTEGER NOT NULL DEFAULT 0,
  points_earned     INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'unpaid',
  payment_method    TEXT,
  amount_paid       REAL NOT NULL DEFAULT 0,
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

-- Payments against a booking. A bill can be paid in parts and with several
-- methods (e.g. part cash, part JazzCash). Refunds are negative amounts.
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount       REAL NOT NULL,
  method       TEXT NOT NULL,
  reference    TEXT,
  note         TEXT,
  received_by  TEXT,
  created_at   TEXT NOT NULL
);

-- Stock of chemicals, coatings, PPF film, towels etc.
CREATE TABLE IF NOT EXISTS inventory_items (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',
  unit          TEXT NOT NULL DEFAULT 'pcs',
  quantity      REAL NOT NULL DEFAULT 0,
  min_quantity  REAL NOT NULL DEFAULT 0,
  cost_price    REAL NOT NULL DEFAULT 0,
  supplier      TEXT,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- Every stock change: purchase (+), use (-), waste (-), adjust (stock count correction).
CREATE TABLE IF NOT EXISTS inventory_movements (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  quantity    REAL NOT NULL,
  unit_cost   REAL NOT NULL DEFAULT 0,
  booking_id  INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  note        TEXT,
  actor_name  TEXT,
  created_at  TEXT NOT NULL
);

-- Materials a service uses per job; deducted from stock when the job is completed.
CREATE TABLE IF NOT EXISTS service_materials (
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity    REAL NOT NULL,
  PRIMARY KEY (service_id, item_id)
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
CREATE INDEX IF NOT EXISTS idx_payments_booking    ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_movements_item      ON inventory_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_movements_created   ON inventory_movements(created_at);
`;

// Columns added after the first release. Existing databases get them on start-up.
const MIGRATIONS = [
  ['services', 'category', "TEXT NOT NULL DEFAULT 'wash'"],
  ['services', 'warranty_months', 'INTEGER'],
  ['services', 'maintenance_months', 'INTEGER'],
  ['bookings', 'service_category', 'TEXT'],
  ['bookings', 'manual_discount', 'REAL NOT NULL DEFAULT 0'],
  ['bookings', 'discount_reason', 'TEXT'],
  ['bookings', 'amount_paid', 'REAL NOT NULL DEFAULT 0'],
  ['bookings', 'discount_type', "TEXT NOT NULL DEFAULT 'amount'"],
  ['bookings', 'discount_value', 'REAL NOT NULL DEFAULT 0'],
  ['users', 'pin_hash', 'TEXT'],
  ['staff', 'pin_hash', 'TEXT'],
];

const DEFAULT_SETTINGS = {
  business_name: 'Mr.Clean Car Detailing',
  tagline: '& PPF Ceramic Coating',
  phone: '',
  address: 'Rawalpindi / Islamabad',
  currency: 'Rs',
  payment_methods: ['Cash', 'Card', 'JazzCash', 'Easypaisa', 'Bank transfer'],
  employee_can_discount: false, // employees signed in with a PIN may give discounts
  tax_rate: 0, // percent
  open_time: '08:00',
  close_time: '18:00',
  slot_minutes: 30,
  bays: 3, // how many cars can be worked on at the same time
  open_days: [1, 2, 3, 4, 5, 6], // 0 = Sunday
  booking_window_days: 30,
  large_vehicle_surcharge: 50, // percent, applied to SUV / pickup / van (rate list: Rs 700 car vs Rs 1,000–1,200 SUV)
  points_per_unit: 0.1, // loyalty points earned per 1 currency unit spent (10 points per Rs 100)
  reward_points: 100, // points needed for one reward
  reward_value: 50, // currency value of one reward
};

// Starter price list. Everything here can be edited under "Services & pricing".
// [name, description, price, duration (working minutes), kind, category, warranty months, maintenance every N months]
const DEFAULT_SERVICES = [
  // Wash / service: standard-car prices from the Star Workers Service Station Union rate list (Rawalpindi/Islamabad).
  ['Wash', 'Body wash with shampoo, wheels and dry.', 500, 30, 'package', 'wash', null, null],
  ['Service', 'Full service: wash, underbody wash, interior vacuum, dashboard and glass.', 700, 60, 'package', 'wash', null, null],
  ['Simple Polish', 'Machine polish for gloss and light swirl removal.', 3000, 120, 'package', 'detailing', null, null],
  ['Interior Detailing', 'Deep vacuum, seat and carpet shampoo, leather care, dashboard, vents and door panels.', 6000, 240, 'package', 'detailing', null, null],
  ['Exterior Detailing', 'Iron and tar decontamination, clay bar, machine polish and paint sealant.', 8000, 300, 'package', 'detailing', null, null],
  ['Full Car Detailing', 'Complete interior and exterior detailing for a showroom finish.', 12000, 480, 'package', 'detailing', null, null],
  ['Compound Polish / Paint Correction', 'Multi-stage compound and polish to remove swirl marks and light scratches.', 15000, 600, 'package', 'detailing', null, null],
  ['Ceramic Coating – 1 Year', 'Decontamination, one-step polish and a 1-year ceramic coating for gloss and easy cleaning.', 25000, 480, 'package', 'ceramic', 12, 3],
  ['Ceramic Coating – 3 Years', 'Paint correction and a 3-year 9H ceramic coating on paint and trims.', 45000, 900, 'package', 'ceramic', 36, 6],
  ['Ceramic Coating – 5 Years', 'Two-stage paint correction and a multi-layer 5-year ceramic coating.', 70000, 1200, 'package', 'ceramic', 60, 6],
  ['PPF – Front Package', 'Self-healing clear paint protection film on front bumper, bonnet, fenders and mirrors.', 85000, 900, 'package', 'ppf', 60, 12],
  ['PPF – Full Body', 'Every painted panel wrapped in self-healing, stone-chip resistant clear film.', 350000, 2400, 'package', 'ppf', 120, 12],
  ['Engine Bay Cleaning', 'Safe degrease and dressing of the engine bay.', 1500, 45, 'addon', 'detailing', null, null],
  ['Headlight Restoration', 'Removes yellowing and haze, finished with UV protection.', 2500, 60, 'addon', 'detailing', null, null],
  ['Leather Conditioning', 'Cleans and nourishes leather seats and trims.', 2000, 30, 'addon', 'detailing', null, null],
  ['Odor Removal', 'Ozone treatment to eliminate smells.', 2000, 45, 'addon', 'detailing', null, null],
  ['Glass Ceramic Coating', 'Hydrophobic coating on all windows for better visibility in the rain.', 4000, 45, 'addon', 'ceramic', 12, null],
  ['Wheel & Caliper Coating', 'Ceramic coating for wheels and calipers so brake dust wipes right off.', 8000, 90, 'addon', 'ceramic', 12, null],
  ['Tire Shine', 'Long-lasting tire dressing.', 300, 10, 'addon', 'wash', null, null],
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
      for (const row of api.all("SELECT key, value FROM settings WHERE key <> 'pin_secret'")) {
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
    /** Secret used to hash PINs (never sent to the browser). */
    pinSecret() {
      let row = api.get("SELECT value FROM settings WHERE key = 'pin_secret'");
      if (!row) {
        api.run("INSERT INTO settings (key, value) VALUES ('pin_secret', ?)", JSON.stringify(crypto.randomBytes(32).toString('hex')));
        row = api.get("SELECT value FROM settings WHERE key = 'pin_secret'");
      }
      return JSON.parse(row.value);
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

const OLD_METHODS = { cash: 'Cash', card: 'Card', mobile: 'Mobile wallet', other: 'Other' };

/** Upgrading from the version with a single payment method: turn "paid" bookings into payment records. */
function backfillPayments(db) {
  db.tx(() => {
    for (const b of db.all("SELECT id, total, payment_method, completed_at, created_at FROM bookings WHERE payment_status = 'paid' AND total > 0")) {
      const method = OLD_METHODS[b.payment_method] || b.payment_method || 'Cash';
      db.run('INSERT INTO payments (booking_id, amount, method, note, created_at) VALUES (?, ?, ?, ?, ?)', b.id, b.total, method, 'Recorded before split payments', b.completed_at || b.created_at);
      db.run('UPDATE bookings SET amount_paid = total, payment_method = ? WHERE id = ?', method, b.id);
    }
  });
}

// Starter stock for a wash / detailing / coating / PPF shop: [name, category, unit, qty, reorder at, cost per unit, supplier]
const DEFAULT_INVENTORY = [
  ['Car shampoo', 'chemicals', 'L', 20, 5, 800, null],
  ['Snow foam', 'chemicals', 'L', 15, 5, 900, null],
  ['All-purpose / interior cleaner', 'chemicals', 'L', 10, 3, 700, null],
  ['Glass cleaner', 'chemicals', 'L', 6, 2, 500, null],
  ['Engine degreaser', 'chemicals', 'L', 6, 2, 900, null],
  ['Diesel (engine / underbody wash)', 'chemicals', 'L', 20, 5, 280, null],
  ['Tire dressing', 'chemicals', 'L', 8, 2, 1200, null],
  ['Leather conditioner', 'chemicals', 'L', 3, 1, 3500, null],
  ['Clay bar', 'polish', 'pcs', 10, 3, 1500, null],
  ['Cutting compound', 'polish', 'L', 4, 1, 6000, null],
  ['Finishing polish', 'polish', 'L', 3, 1, 6500, null],
  ['Ceramic coating kit (50 ml)', 'coating', 'pcs', 12, 4, 9000, null],
  ['Glass coating kit', 'coating', 'pcs', 6, 2, 3500, null],
  ['PPF film (1.52 m wide)', 'ppf', 'm', 60, 15, 4500, null],
  ['Microfiber towels', 'consumables', 'pcs', 80, 30, 250, null],
  ['Polishing pads', 'consumables', 'pcs', 12, 4, 1800, null],
];

// Materials per job: service name -> [[item name, quantity], ...]
const DEFAULT_MATERIALS = {
  Wash: [['Car shampoo', 0.05]],
  Service: [['Car shampoo', 0.08], ['Snow foam', 0.05], ['Glass cleaner', 0.02], ['Diesel (engine / underbody wash)', 0.5]],
  'Simple Polish': [['Finishing polish', 0.1]],
  'Interior Detailing': [['All-purpose / interior cleaner', 0.3], ['Glass cleaner', 0.05]],
  'Exterior Detailing': [['Car shampoo', 0.1], ['Clay bar', 0.25], ['Finishing polish', 0.1]],
  'Full Car Detailing': [['Car shampoo', 0.1], ['All-purpose / interior cleaner', 0.3], ['Clay bar', 0.25], ['Finishing polish', 0.1]],
  'Compound Polish / Paint Correction': [['Cutting compound', 0.25], ['Finishing polish', 0.15], ['Polishing pads', 0.5]],
  'Ceramic Coating – 1 Year': [['Ceramic coating kit (50 ml)', 1], ['Finishing polish', 0.1]],
  'Ceramic Coating – 3 Years': [['Ceramic coating kit (50 ml)', 1], ['Cutting compound', 0.15], ['Finishing polish', 0.1]],
  'Ceramic Coating – 5 Years': [['Ceramic coating kit (50 ml)', 2], ['Cutting compound', 0.2], ['Finishing polish', 0.15]],
  'PPF – Front Package': [['PPF film (1.52 m wide)', 8]],
  'PPF – Full Body': [['PPF film (1.52 m wide)', 25]],
  'Engine Bay Cleaning': [['Engine degreaser', 0.3]],
  'Leather Conditioning': [['Leather conditioner', 0.1]],
  'Glass Ceramic Coating': [['Glass coating kit', 1]],
  'Tire Shine': [['Tire dressing', 0.05]],
};

function seedInventory(db) {
  const ids = {};
  for (const [name, category, unit, qty, min, cost, supplier] of DEFAULT_INVENTORY) {
    ids[name] = db.run(
      'INSERT INTO inventory_items (name, category, unit, quantity, min_quantity, cost_price, supplier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      name, category, unit, qty, min, cost, supplier, now(),
    ).id;
    db.run("INSERT INTO inventory_movements (item_id, type, quantity, unit_cost, note, created_at) VALUES (?, 'adjust', ?, ?, 'Opening stock', ?)", ids[name], qty, cost, now());
  }
  for (const [service, materials] of Object.entries(DEFAULT_MATERIALS)) {
    const svc = db.get('SELECT id FROM services WHERE name = ?', service);
    if (!svc) continue;
    for (const [item, qty] of materials) if (ids[item]) db.run('INSERT OR IGNORE INTO service_materials (service_id, item_id, quantity) VALUES (?, ?, ?)', svc.id, ids[item], qty);
  }
}

function openDatabase(file, { adminEmail, adminPassword, adminName, adminPin, employeePin } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  const hadPayments = Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get());
  const hadBookings = Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookings'").get());
  // Older sessions table had no staff_id (and user_id NOT NULL): recreate it (signs everyone out once).
  const sessionCols = raw.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (sessionCols.length && !sessionCols.includes('staff_id')) raw.exec('DROP TABLE sessions');
  const hadInventory = Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory_items'").get());
  raw.exec(SCHEMA);
  migrate(raw);
  const db = wrap(raw);
  if (hadBookings && !hadPayments) backfillPayments(db);

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
  // PINs: admin 2222, first employee 1111 (change them under Settings / Staff).
  const secret = db.pinSecret();
  const adminRow = db.get("SELECT id, pin_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (adminRow && !adminRow.pin_hash) db.run('UPDATE users SET pin_hash = ? WHERE id = ?', pinHash(secret, adminPin || '2222'), adminRow.id);
  if (!db.get('SELECT 1 FROM staff WHERE pin_hash IS NOT NULL')) {
    const first = db.get('SELECT id FROM staff WHERE active = 1 ORDER BY id LIMIT 1');
    if (first) db.run('UPDATE staff SET pin_hash = ? WHERE id = ?', pinHash(secret, employeePin || '1111'), first.id);
  }
  if (!hadInventory) seedInventory(db);

  // Clean up expired sessions on boot.
  db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  return db;
}

module.exports = { openDatabase, now, today, DEFAULT_SETTINGS };
