'use strict';

/**
 * Fills the database with realistic demo data: customers, vehicles and several
 * months of wash history, plus today's queue and some upcoming bookings.
 *
 *   npm run seed:demo              (uses DB_PATH or data/carwash.db)
 *
 * Demo customers can log in with password "demo123".
 */
const path = require('node:path');
const { openDatabase, now } = require('../src/db');
const { hashPassword } = require('../src/auth');
const B = require('../src/bookings');

const db = openDatabase(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'carwash.db'), {
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
});

if (db.get("SELECT 1 FROM users WHERE email = 'maria@example.com'")) {
  console.log('Demo data already present — nothing to do.');
  process.exit(0);
}

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const ts = (d) => now(d);
const daysAgo = (n, hour, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
};

const pw = hashPassword('demo123');
const customers = [
  ['Maria Gonzalez', 'maria@example.com', '+1 555 0111'],
  ['James Smith', 'james@example.com', '+1 555 0122'],
  ['Aisha Khan', 'aisha@example.com', '+1 555 0133'],
  ['Tom Becker', 'tom@example.com', '+1 555 0144'],
  ['Yuki Tanaka', 'yuki@example.com', '+1 555 0155'],
].map(([name, email, phone]) => db.run("INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'customer', ?)", name, email, phone, pw, ts(daysAgo(200, 9))).id);

const vehicles = [
  [customers[0], 'MGZ 2041', 'Toyota', 'RAV4', 2021, 'Pearl White', 'suv'],
  [customers[0], 'MGZ 77', 'Mini', 'Cooper', 2018, 'British Racing Green', 'hatchback'],
  [customers[1], 'JS 4410', 'Ford', 'F-150', 2020, 'Black', 'pickup'],
  [customers[2], 'AK 9087', 'Honda', 'Civic', 2022, 'Sonic Grey', 'sedan'],
  [customers[3], 'TB 1234', 'Volkswagen', 'Golf', 2017, 'Blue', 'hatchback'],
  [customers[4], 'YT 5050', 'Tesla', 'Model 3', 2023, 'Red', 'sedan'],
  [null, 'WLK 300', 'BMW', '3 Series', 2016, 'Silver', 'sedan'],
  [null, 'VAN 88', 'Mercedes', 'Sprinter', 2019, 'White', 'van'],
].map(([owner, plateRaw, make, model, year, color, type]) =>
  db.run('INSERT INTO vehicles (owner_id, plate, make, model, year, color, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', owner, B.normalizePlate(plateRaw), make, model, year, color, type, ts(daysAgo(190, 9))).id,
);

const packages = db.all("SELECT * FROM services WHERE kind = 'package'");
const addons = db.all("SELECT * FROM services WHERE kind = 'addon'");
const staff = db.all('SELECT * FROM staff');
const feedback = ['Spotless, thank you!', 'Great job as always.', 'Quick and friendly.', 'Interior looks brand new.', 'A bit of a wait but worth it.', null, null];
const settings = db.getSettings();

function makeBooking(vehicleId, { day, hour, status, payment = 'paid', rating }) {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
  const pkg = rand() < 0.55 ? packages[1] : pick(packages);
  const extras = addons.filter(() => rand() < 0.2).map((a) => a.id);
  const scheduled = daysAgo(day, hour, pick([0, 30]));
  const id = B.createBooking(db, {
    vehicle: v,
    customerId: v.owner_id,
    serviceId: pkg.id,
    addonIds: extras,
    scheduledAt: ts(scheduled).slice(0, 16),
    source: v.owner_id && rand() < 0.75 ? 'online' : 'walk_in',
    status: 'pending',
    staffId: pick(staff).id,
    bay: 1 + Math.floor(rand() * settings.bays),
    customerNotes: rand() < 0.15 ? pick(['Please be careful with the roof rack.', 'Dog hair in the back seats.', 'Skip the air freshener please.']) : null,
  });
  const b = db.get('SELECT * FROM bookings WHERE id = ?', id);
  const created = new Date(scheduled.getTime() - 2 * 86400000);
  db.run('UPDATE bookings SET created_at = ? WHERE id = ?', ts(created), id);
  db.run('UPDATE booking_events SET created_at = ? WHERE booking_id = ?', ts(created), id);

  const ev = (s, d, note) => db.run('INSERT INTO booking_events (booking_id, status, note, actor_name, created_at) VALUES (?, ?, ?, ?, ?)', id, s, note || null, 'Administrator', ts(d));
  if (status === 'pending') return id;
  ev('confirmed', new Date(created.getTime() + 3600000));
  if (status === 'confirmed') return db.run("UPDATE bookings SET status = 'confirmed' WHERE id = ?", id), id;
  if (status === 'cancelled' || status === 'no_show') {
    ev(status, scheduled, status === 'cancelled' ? 'Cancelled by customer' : null);
    db.run(`UPDATE bookings SET status = ?, cancelled_at = ? WHERE id = ?`, status, status === 'cancelled' ? ts(scheduled) : null, id);
    return id;
  }
  const started = new Date(scheduled.getTime() + 5 * 60000);
  ev('in_progress', started);
  if (status === 'in_progress') {
    db.run("UPDATE bookings SET status = 'in_progress', started_at = ? WHERE id = ?", ts(started), id);
    return id;
  }
  const done = new Date(started.getTime() + b.duration_min * 60000);
  ev('completed', done);
  const earned = v.owner_id ? Math.floor(b.total * settings.points_per_unit) : 0;
  if (earned) db.run('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?', earned, v.owner_id);
  db.run(
    `UPDATE bookings SET status = 'completed', started_at = ?, completed_at = ?, points_earned = ?, payment_status = ?, payment_method = ?, mileage = ?, rating = ?, feedback = ? WHERE id = ?`,
    ts(started),
    ts(done),
    earned,
    payment,
    payment === 'paid' ? pick(['card', 'card', 'cash', 'mobile']) : null,
    20000 + Math.floor((200 - day) * 45 + rand() * 300),
    rating ?? (rand() < 0.5 ? 3 + Math.floor(rand() * 3) : null),
    feedback[Math.floor(rand() * feedback.length)],
    id,
  );
  return id;
}

db.tx(() => {
  // History: each vehicle visits every ~2–4 weeks over the last ~6 months.
  vehicles.forEach((vid, i) => {
    let day = 170 - i * 7;
    while (day > 2) {
      const r = rand();
      const status = r < 0.85 ? 'completed' : r < 0.95 ? 'cancelled' : 'no_show';
      makeBooking(vid, { day, hour: 8 + Math.floor(rand() * 9), status });
      day -= 12 + Math.floor(rand() * 20);
    }
  });
  // Today: a mix of queue states.
  makeBooking(vehicles[0], { day: 0, hour: 8, status: 'completed', payment: 'paid', rating: 5 });
  makeBooking(vehicles[3], { day: 0, hour: 9, status: 'completed', payment: 'unpaid' });
  makeBooking(vehicles[2], { day: 0, hour: new Date().getHours(), status: 'in_progress' });
  makeBooking(vehicles[5], { day: 0, hour: Math.min(17, new Date().getHours() + 1), status: 'confirmed' });
  makeBooking(vehicles[4], { day: 0, hour: Math.min(17, new Date().getHours() + 2), status: 'pending' });
  // Upcoming
  makeBooking(vehicles[1], { day: -2, hour: 11, status: 'pending' });

  const note = (vid, kind, text, day) => db.run('INSERT INTO vehicle_notes (vehicle_id, kind, note, author_name, created_at) VALUES (?, ?, ?, ?, ?)', vid, kind, text, 'Administrator', ts(daysAgo(day, 10)));
  note(vehicles[0], 'damage', 'Small dent on rear left door (pre-existing, photographed).', 120);
  note(vehicles[0], 'preference', 'Customer prefers no tyre shine.', 60);
  note(vehicles[2], 'warning', 'Aftermarket roof rack — no automatic brushes.', 90);
  note(vehicles[6], 'general', 'Regular walk-in, usually pays cash.', 40);
});

console.log('Demo data created.');
console.log('  Customers: maria@example.com, james@example.com, aisha@example.com, tom@example.com, yuki@example.com');
console.log('  Password:  demo123');
