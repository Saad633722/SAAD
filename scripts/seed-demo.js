'use strict';

/**
 * Fills the database with realistic demo data for Mr.Clean Car Detailing:
 * customers, vehicles and ~6 months of history (washes, detailing, ceramic
 * coatings and PPF with warranties), plus today's queue and upcoming jobs.
 *
 *   npm run seed:demo              (uses DB_PATH or data/carwash.db)
 *
 * Demo customers can log in with password "demo123".
 */
const path = require('node:path');
const { openDatabase, now } = require('../src/db');
const { hashPassword } = require('../src/auth');
const B = require('../src/bookings');
const inventory = require('../src/inventory');
const { pinHash } = require('../src/auth');

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

const services = db.all('SELECT * FROM services');
const byName = (name) => {
  const s = services.find((x) => x.name === name);
  if (!s) throw new Error(`Unknown service ${name}`);
  return s;
};
const washes = services.filter((s) => s.kind === 'package' && s.category === 'wash');
const detailing = services.filter((s) => s.kind === 'package' && s.category === 'detailing' && !/Paint Correction/.test(s.name));
const extras = services.filter((s) => s.kind === 'addon' && !s.warranty_months);
const staff = db.all('SELECT * FROM staff');
const feedback = ['Spotless, thank you!', 'Great job as always.', 'Quick and friendly.', 'Interior looks brand new.', 'The coating looks incredible.', 'A bit of a wait but worth it.', null, null];
const settings = db.getSettings();

function makeBooking(vehicleId, { day, hour, status, payment = 'paid', rating, pkg, addons }) {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
  const service = pkg ? byName(pkg) : rand() < 0.7 ? pick(washes) : pick(detailing);
  const addonIds = addons ? addons.map((n) => byName(n).id) : extras.filter(() => rand() < 0.15).map((a) => a.id);
  const scheduled = daysAgo(day, hour, pick([0, 30]));
  const id = B.createBooking(db, {
    vehicle: v,
    customerId: v.owner_id,
    serviceId: service.id,
    addonIds,
    scheduledAt: ts(scheduled).slice(0, 16),
    source: v.owner_id && rand() < 0.75 ? 'online' : 'walk_in',
    status: 'pending',
    staffId: service.category === 'ppf' || service.category === 'ceramic' ? staff[1].id : pick(staff).id,
    bay: 1 + Math.floor(rand() * settings.bays),
    customerNotes: rand() < 0.15 ? pick(['Please be careful with the roof rack.', 'Dog hair in the back seats.', 'Stone chips on the bonnet.']) : null,
    ...(rand() < 0.12 ? { discountType: 'percent', discountValue: 10, discountReason: pick(['Regular customer', 'Friend of the owner', 'Waited too long']) } : {}),
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
    db.run('UPDATE bookings SET status = ?, cancelled_at = ? WHERE id = ?', status, status === 'cancelled' ? ts(scheduled) : null, id);
    return id;
  }
  const started = new Date(scheduled.getTime() + 5 * 60000);
  ev('in_progress', started);
  if (status === 'in_progress') {
    db.run("UPDATE bookings SET status = 'in_progress', started_at = ? WHERE id = ?", ts(started), id);
    return id;
  }
  const ready = B.readyAt(settings, ts(started).slice(0, 16), b.duration_min);
  const done = ready ? new Date(ready.replace(' ', 'T')) : new Date(started.getTime() + b.duration_min * 60000);
  ev('completed', done);
  const earned = v.owner_id ? Math.floor(b.total * settings.points_per_unit) : 0;
  if (earned) db.run('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?', earned, v.owner_id);
  db.run(
    `UPDATE bookings SET status = 'completed', started_at = ?, completed_at = ?, points_earned = ?, mileage = ?, rating = ?, feedback = ? WHERE id = ?`,
    ts(started),
    ts(done),
    earned,
    20000 + Math.floor((200 - day) * 45 + rand() * 300),
    rating ?? (rand() < 0.5 ? 3 + Math.floor(rand() * 3) : null),
    feedback[Math.floor(rand() * feedback.length)],
    id,
  );
  B.recordProtections(db, id, ts(done));
  inventory.deductForBooking(db, id, 'Administrator');
  db.run('UPDATE inventory_movements SET created_at = ? WHERE booking_id = ?', ts(done), id);
  // Payments: mostly one method, sometimes split (e.g. cash + JazzCash), sometimes only partly paid
  const bill = db.get('SELECT * FROM bookings WHERE id = ?', id);
  if (bill.total > 0 && payment !== 'unpaid') {
    let list;
    if (payment === 'partial') list = [{ method: 'Cash', amount: Math.round(bill.total / 2) }];
    else if (rand() < 0.2) {
      const cash = Math.min(bill.total, Math.round((bill.total * 0.4) / 100) * 100 || bill.total);
      list = [{ method: 'Cash', amount: cash }, ...(bill.total - cash > 0 ? [{ method: pick(['JazzCash', 'Easypaisa', 'Card']), amount: Math.round((bill.total - cash) * 100) / 100 }] : [])];
    } else list = [{ method: pick(['Cash', 'Cash', 'Cash', 'Card', 'JazzCash', 'Easypaisa', 'Bank transfer']), amount: bill.total }];
    B.addPayments(db, bill, list, 'Administrator');
    db.run('UPDATE payments SET created_at = ? WHERE booking_id = ?', ts(done), id);
    db.run("UPDATE booking_events SET created_at = ? WHERE booking_id = ? AND note LIKE 'Payment:%'", ts(done), id);
  }
  return id;
}

// Special jobs per vehicle (index into `vehicles`), and the day a customer stopped coming.
const PLAN = {
  0: { special: [{ day: 150, pkg: 'Ceramic Coating – 3 Years', addons: ['Glass Ceramic Coating'] }] },
  2: { special: [{ day: 160, pkg: 'PPF – Front Package' }] },
  3: { special: [{ day: 125, pkg: 'Ceramic Coating – 1 Year' }], lastVisit: 100 }, // maintenance now overdue
  5: { special: [{ day: 60, pkg: 'PPF – Full Body', addons: ['Wheel & Caliper Coating'] }] },
};

db.tx(() => {
  vehicles.forEach((vid, i) => {
    const plan = PLAN[i] || { special: [] };
    const visits = plan.special.map((s) => ({ ...s, status: 'completed', rating: 5 }));
    for (let day = 170 - i * 7; day > 2; day -= 12 + Math.floor(rand() * 20)) {
      if (plan.lastVisit && day < plan.lastVisit) break;
      if (plan.special.some((s) => Math.abs(s.day - day) < 6)) continue;
      const r = rand();
      visits.push({ day, status: r < 0.86 ? 'completed' : r < 0.95 ? 'cancelled' : 'no_show' });
    }
    if (plan.lastVisit && !visits.some((v) => v.day === plan.lastVisit)) visits.push({ day: plan.lastVisit, status: 'completed' });
    visits.sort((a, b) => b.day - a.day);
    for (const v of visits) makeBooking(vid, { ...v, hour: v.pkg ? 9 : 8 + Math.floor(rand() * 9) });
  });

  // Today's queue
  const h = new Date().getHours();
  makeBooking(vehicles[0], { day: 0, hour: 8, status: 'completed', payment: 'paid', rating: 5, pkg: 'Service' });
  makeBooking(vehicles[6], { day: 0, hour: 9, status: 'completed', payment: 'partial', pkg: 'Simple Polish', addons: ['Tire Shine'] });
  makeBooking(vehicles[1], { day: 0, hour: 10, status: 'completed', payment: 'unpaid', pkg: 'Wash' });
  makeBooking(vehicles[7], { day: 1, hour: 9, status: 'in_progress', pkg: 'PPF – Front Package' }); // multi-day job started yesterday
  makeBooking(vehicles[2], { day: 0, hour: Math.min(h, 16), status: 'in_progress', pkg: 'Full Car Detailing' });
  makeBooking(vehicles[5], { day: 0, hour: Math.min(17, h + 1), status: 'confirmed', pkg: 'Wash' });
  makeBooking(vehicles[4], { day: 0, hour: Math.min(17, h + 2), status: 'pending', pkg: 'Interior Detailing' });
  // Upcoming: a 1-day ceramic coating
  makeBooking(vehicles[1], { day: -2, hour: 9, status: 'pending', pkg: 'Ceramic Coating – 1 Year' });

  // A coating done before the shop started using the app, warranty about to run out
  const applied = B.addDays(B.addMonths(now().slice(0, 10), -36), 12);
  db.run(
    `INSERT INTO vehicle_protections (vehicle_id, name, category, applied_at, warranty_months, warranty_until, maintenance_months, details, created_at)
     VALUES (?, 'Ceramic Coating – 3 Years', 'ceramic', ?, 36, ?, 6, '2 layers on paint, 1 on wheels. Record added from the paper job card.', ?)`,
    vehicles[4],
    applied,
    B.addMonths(applied, 36),
    now(),
  );

  // Stock: a delivery last week and a stock count; Sam Lee signs in with PIN 3333
  const item = (name) => db.get('SELECT id FROM inventory_items WHERE name = ?', name).id;
  inventory.move(db, item('Car shampoo'), { type: 'purchase', quantity: 20, unit_cost: 850, note: 'Delivery — invoice 1043' }, 'Administrator');
  inventory.move(db, item('Microfiber towels'), { type: 'adjust', counted: 26, note: 'Monthly stock count' }, 'Administrator');
  inventory.move(db, item('Glass coating kit'), { type: 'waste', quantity: 1, note: 'Bottle dropped' }, 'Alex Carter');
  db.run("UPDATE inventory_movements SET created_at = ? WHERE note IN ('Delivery — invoice 1043', 'Monthly stock count', 'Bottle dropped')", ts(daysAgo(6, 11)));
  db.run('UPDATE staff SET pin_hash = ? WHERE id = ?', pinHash(db.pinSecret(), '3333'), staff[1].id);

  const note = (vid, kind, text, day) => db.run('INSERT INTO vehicle_notes (vehicle_id, kind, note, author_name, created_at) VALUES (?, ?, ?, ?, ?)', vid, kind, text, 'Administrator', ts(daysAgo(day, 10)));
  note(vehicles[0], 'damage', 'Small dent on rear left door (pre-existing, photographed).', 120);
  note(vehicles[0], 'preference', 'Customer prefers no tire shine.', 60);
  note(vehicles[2], 'warning', 'Aftermarket roof rack — no automatic brushes.', 90);
  note(vehicles[5], 'general', 'Full-body PPF — use pH-neutral shampoo only, no polishing compounds.', 55);
  note(vehicles[6], 'general', 'Regular walk-in, usually pays cash.', 40);
});

console.log('Demo data created.');
console.log('  Customers: maria@example.com, james@example.com, aisha@example.com, tom@example.com, yuki@example.com');
console.log('  Password:  demo123');
console.log('  Staff PINs: admin 2222 · Alex Carter 1111 · Sam Lee 3333');
