'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { openDatabase, today } = require('../src/db');
const { addMonths, addDays } = require('../src/bookings');

let server;
let base;
let db;

/** Tiny client that keeps its own session cookie. */
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

const OPEN_DAYS = [1, 2, 3, 4, 5, 6]; // default: Mon–Sat
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The n-th open day after today (n = 1 is the next open day), as YYYY-MM-DD. */
function openDay(n = 1) {
  const d = new Date();
  let found = 0;
  while (found < n) {
    d.setDate(d.getDate() + 1);
    if (OPEN_DAYS.includes(d.getDay())) found += 1;
  }
  return fmt(d);
}

/** The n-th open day on or after the given date. */
function nthOpenFrom(date, n) {
  const d = new Date(`${date}T12:00:00`);
  let found = 0;
  for (;;) {
    if (OPEN_DAYS.includes(d.getDay())) found += 1;
    if (found === n) return fmt(d);
    d.setDate(d.getDate() + 1);
  }
}

before(async () => {
  const app = createApp({ dbPath: ':memory:', adminEmail: 'admin@test.local', adminPassword: 'secret123' });
  db = app.locals.db;
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const admin = client();
const alice = client();
const bob = client();
const carol = client();
const ctx = {};

test('admin can log in, wrong password is rejected', async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'nope' })).status, 401);
  const r = await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'secret123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
});

test('business branding and starter price list are seeded', async () => {
  const { data } = await alice('GET', '/api/settings');
  assert.equal(data.settings.business_name, 'Mr.Clean Car Detailing');
  assert.equal(data.settings.tagline, '& PPF Ceramic Coating');
  assert.deepEqual(data.categories, ['wash', 'detailing', 'ceramic', 'ppf', 'other']);
  const { services } = (await alice('GET', '/api/services')).data;
  const cats = new Set(services.filter((s) => s.kind === 'package').map((s) => s.category));
  for (const c of ['wash', 'detailing', 'ceramic', 'ppf']) assert.ok(cats.has(c), `has ${c} packages`);
  const coating = services.find((s) => s.name === 'Ceramic Coating – 3 Years');
  assert.equal(coating.warranty_months, 36);
  assert.equal(coating.maintenance_months, 6);
  ctx.services = services;
  ctx.pkg = services.find((s) => s.name === 'Wash & Vacuum');
  ctx.shine = services.find((s) => s.name === 'Tire Shine');
  ctx.coating = coating;
  ctx.ppf = services.find((s) => s.name === 'PPF – Full Body');
});

test('customers register and panels are role-protected', async () => {
  const r = await alice('POST', '/api/auth/register', { name: 'Alice', email: 'alice@example.com', password: 'password1', phone: '555-1' });
  assert.equal(r.status, 201);
  assert.equal((await bob('POST', '/api/auth/register', { name: 'Bob', email: 'ALICE@example.com', password: 'password1' })).status, 409);
  assert.equal((await bob('POST', '/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'password1' })).status, 201);
  assert.equal((await carol('POST', '/api/auth/register', { name: 'Carol', email: 'carol@example.com', password: 'password1' })).status, 201);

  assert.equal((await alice('GET', '/api/admin/stats')).status, 403);
  assert.equal((await alice('POST', '/api/admin/vehicles/1/protections', { name: 'x' })).status, 403);
  assert.equal((await admin('GET', '/api/my/vehicles')).status, 403);
  assert.equal((await client()('GET', '/api/my/vehicles')).status, 401);
  // page guards
  assert.equal((await alice('GET', '/admin')).status, 302);
  assert.equal((await admin('GET', '/admin')).status, 200);
});

test('non-JSON mutating requests are rejected', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(res.status, 415);
});

test('customer manages vehicles; plates are normalised and unique', async () => {
  const r = await alice('POST', '/api/my/vehicles', { plate: 'abc-123', make: 'Toyota', model: 'RAV4', type: 'suv', color: 'Blue', year: 2021 });
  assert.equal(r.status, 201);
  assert.equal(r.data.vehicle.plate, 'ABC123');
  ctx.aliceCar = r.data.vehicle;
  assert.equal((await bob('POST', '/api/my/vehicles', { plate: 'ABC 123' })).status, 409);
  assert.equal((await bob('GET', `/api/my/vehicles/${ctx.aliceCar.id}/history`)).status, 404);
});

test('quote applies large-vehicle surcharge and adds up working time', async () => {
  const q = await alice('POST', '/api/my/quote', { vehicle_id: ctx.aliceCar.id, service_id: ctx.pkg.id, addon_ids: [ctx.shine.id] });
  assert.equal(q.status, 200);
  assert.equal(q.data.subtotal, 30);
  assert.equal(q.data.surcharge, 6); // 20% for SUV
  assert.equal(q.data.total, 36);
  assert.equal(q.data.duration_min, 70);
});

test('customer books an available slot; bay capacity covers the whole job', async () => {
  const date = openDay(1);
  const av = await alice('GET', `/api/availability?date=${date}&duration=70`);
  assert.equal(av.status, 200);
  assert.ok(av.data.open);
  const slot = av.data.slots[0];
  assert.equal(slot.time, '08:00');
  assert.equal(slot.ready_at, `${date} 09:10`);
  ctx.slot = `${date} ${slot.time}`;

  const r = await alice('POST', '/api/my/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.pkg.id, addon_ids: [ctx.shine.id], scheduled_at: ctx.slot, notes: 'Dog hair in the back' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.booking.status, 'pending');
  assert.equal(r.data.booking.total, 36);
  assert.equal(r.data.booking.code.slice(0, 3), 'MC-');
  assert.equal(r.data.booking.ready_at, `${date} 09:10`);
  assert.equal(r.data.booking.addons.length, 1);
  assert.equal(r.data.booking.admin_notes, undefined);
  ctx.booking = r.data.booking;

  // same vehicle can't have two active bookings
  assert.equal((await alice('POST', '/api/my/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.pkg.id, scheduled_at: `${date} 15:00` })).status, 409);

  // fill all 3 bays at 08:00 with 60-minute jobs
  for (const plate of ['BOB1', 'BOB2']) {
    const v = await bob('POST', '/api/my/vehicles', { plate });
    assert.equal((await bob('POST', '/api/my/bookings', { vehicle_id: v.data.vehicle.id, service_id: ctx.pkg.id, scheduled_at: ctx.slot })).status, 201);
  }
  const v3 = await bob('POST', '/api/my/vehicles', { plate: 'BOB3' });
  ctx.bob3 = v3.data.vehicle;
  assert.equal((await bob('POST', '/api/my/bookings', { vehicle_id: v3.data.vehicle.id, service_id: ctx.pkg.id, scheduled_at: ctx.slot })).status, 409);
  // 08:30 is still inside all three jobs, so it is full too
  assert.equal((await bob('POST', '/api/my/bookings', { vehicle_id: v3.data.vehicle.id, service_id: ctx.pkg.id, scheduled_at: `${date} 08:30` })).status, 409);
  const av2 = (await alice('GET', `/api/availability?date=${date}`)).data.slots;
  assert.equal(av2.find((s) => s.time === '08:00').remaining, 0);
  assert.equal(av2.find((s) => s.time === '08:30').remaining, 0);
  assert.equal(av2.find((s) => s.time === '09:00').remaining, 2); // only Alice's 70-minute job is still running
  assert.equal(av2.find((s) => s.time === '09:30').remaining, 3);
});

test('booking in the past or on a bad slot is rejected', async () => {
  assert.equal((await bob('POST', '/api/my/bookings', { vehicle_id: ctx.bob3.id, service_id: ctx.pkg.id, scheduled_at: '2000-01-03 10:00' })).status, 400);
  assert.equal((await bob('POST', '/api/my/bookings', { vehicle_id: ctx.bob3.id, service_id: ctx.pkg.id, scheduled_at: `${openDay(1)} 03:00` })).status, 400);
});

test('multi-day jobs (PPF) block a bay across several days and show when the car is ready', async () => {
  const start = openDay(8);
  const at = `${start} 08:00`;
  const ids = [];
  for (const plate of ['CAR1', 'CAR2', 'CAR3']) {
    const v = await carol('POST', '/api/my/vehicles', { plate, type: 'sedan' });
    const r = await carol('POST', '/api/my/bookings', { vehicle_id: v.data.vehicle.id, service_id: ctx.ppf.id, scheduled_at: at });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ids.push(r.data.booking.id);
  }
  // 2400 working minutes at 10 h/day = 4 open days, ready at closing time on the 4th
  const ready = `${nthOpenFrom(start, 4)} 18:00`;
  const detail = await carol('GET', `/api/my/bookings/${ids[0]}`);
  assert.equal(detail.data.booking.ready_at, ready);

  // Every bay is taken on the following open days, even for a 30-minute wash
  const nextDay = nthOpenFrom(start, 2);
  const av = (await carol('GET', `/api/availability?date=${nextDay}&duration=30`)).data.slots;
  assert.ok(av.every((s) => !s.available && s.remaining === 0));
  // ...and a job starting the day before would run into them
  const v4 = await carol('POST', '/api/my/vehicles', { plate: 'CAR4' });
  const dayBefore = (await carol('GET', `/api/availability?date=${addDays(start, -1)}&duration=600`)).data;
  if (dayBefore.open) assert.ok(dayBefore.slots.every((s) => s.remaining === 0 || s.ready_at <= at), 'jobs ending before the PPF starts are fine');
  assert.equal((await carol('POST', '/api/my/bookings', { vehicle_id: v4.data.vehicle.id, service_id: ctx.pkg.id, scheduled_at: `${nextDay} 12:00` })).status, 409);

  // Rescheduling a job ignores its own bay usage
  const re = await carol('POST', `/api/my/bookings/${ids[2]}/reschedule`, { scheduled_at: at });
  assert.equal(re.status, 200, JSON.stringify(re.data));
  const avEx = (await carol('GET', `/api/availability?date=${start}&duration=2400&exclude=${ids[2]}`)).data.slots;
  assert.equal(avEx.find((s) => s.time === '08:00').remaining, 1);
  // ...but exclude only works for your own bookings
  const avOther = (await bob('GET', `/api/availability?date=${start}&duration=2400&exclude=${ids[2]}`)).data.slots;
  assert.equal(avOther.find((s) => s.time === '08:00').remaining, 0);

  // Cancel them so they don't affect later tests
  for (const id of ids) assert.equal((await carol('POST', `/api/my/bookings/${id}/cancel`, {})).status, 200);
});

test('admin runs the booking through its lifecycle; points are awarded', async () => {
  const staff = (await admin('GET', '/api/admin/staff')).data.staff[0];
  let r = await admin('PATCH', `/api/admin/bookings/${ctx.booking.id}`, { status: 'confirmed', staff_id: staff.id, bay: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.booking.staff_name, staff.name);
  assert.equal((await admin('PATCH', `/api/admin/bookings/${ctx.booking.id}`, { status: 'completed' })).status, 400); // must start first
  await admin('PATCH', `/api/admin/bookings/${ctx.booking.id}`, { status: 'in_progress', mileage: 42000 });
  r = await admin('PATCH', `/api/admin/bookings/${ctx.booking.id}`, { status: 'completed', payment_status: 'paid', payment_method: 'card', admin_notes: 'Small scratch rear bumper' });
  assert.equal(r.data.booking.status, 'completed');
  assert.equal(r.data.booking.points_earned, 36);
  assert.ok(r.data.booking.started_at && r.data.booking.completed_at);
  assert.ok(r.data.booking.events.length >= 4);

  const me = await alice('GET', '/api/my/me');
  assert.equal(me.data.user.loyalty_points, 36);
  // customers never see internal notes
  const mine = await alice('GET', `/api/my/bookings/${ctx.booking.id}`);
  assert.equal(mine.data.booking.admin_notes, undefined);
});

test('customer rates a completed wash', async () => {
  const r = await alice('POST', `/api/my/bookings/${ctx.booking.id}/rate`, { rating: 5, feedback: 'Spotless!' });
  assert.equal(r.status, 200);
  assert.equal(r.data.booking.rating, 5);
  assert.equal((await alice('POST', `/api/my/bookings/${ctx.booking.id}/cancel`)).status, 400);
});

test('admin walk-in creates vehicle and booking; customer later claims history', async () => {
  const packages = (await admin('GET', '/api/admin/services')).data.services.filter((s) => s.kind === 'package');
  const r = await admin('POST', '/api/admin/bookings', { vehicle: { plate: 'walk 9', make: 'Honda', model: 'Civic', type: 'sedan' }, service_id: packages[0].id, start_now: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.booking.status, 'in_progress');
  assert.equal(r.data.booking.source, 'walk_in');
  await admin('PATCH', `/api/admin/bookings/${r.data.booking.id}`, { status: 'completed' });

  const claim = await bob('POST', '/api/my/vehicles', { plate: 'WALK9' });
  assert.equal(claim.status, 201);
  assert.equal(claim.data.vehicle.make, 'Honda');
  const hist = await admin('GET', `/api/admin/vehicles/${claim.data.vehicle.id}`);
  assert.equal(hist.data.vehicle.owner_name, 'Bob');
  assert.equal(hist.data.stats.completed_washes, 1);
});

test('completing a ceramic coating records its warranty and maintenance schedule', async () => {
  const glass = ctx.services.find((s) => s.name === 'Glass Ceramic Coating');
  const r = await admin('POST', '/api/admin/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.coating.id, addon_ids: [glass.id], start_now: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.booking.service_category, 'ceramic');
  await admin('PATCH', `/api/admin/bookings/${r.data.booking.id}`, { status: 'completed' });

  const h = (await admin('GET', `/api/admin/vehicles/${ctx.aliceCar.id}`)).data;
  assert.equal(h.protections.length, 2);
  const coat = h.protections.find((p) => p.name === 'Ceramic Coating – 3 Years');
  assert.equal(coat.category, 'ceramic');
  assert.equal(coat.applied_at, today());
  assert.equal(coat.warranty_until, addMonths(today(), 36));
  assert.equal(coat.next_maintenance_at, addMonths(today(), 6));
  assert.equal(coat.maintenance_status, 'ok');
  assert.equal(coat.warranty_status, 'active');
  const glassP = h.protections.find((p) => p.name === 'Glass Ceramic Coating');
  assert.equal(glassP.warranty_until, addMonths(today(), 12));
  assert.equal(glassP.next_maintenance_at, null);

  // the customer sees it on their car too
  const mine = (await alice('GET', `/api/my/vehicles/${ctx.aliceCar.id}/history`)).data;
  assert.equal(mine.protections.length, 2);
  const list = (await alice('GET', '/api/my/vehicles')).data.vehicles;
  assert.equal(list.find((v) => v.id === ctx.aliceCar.id).protections.length, 2);
  // admin vehicle list shows active protection categories
  const vlist = (await admin('GET', '/api/admin/vehicles?q=ABC123')).data.vehicles;
  assert.equal(vlist[0].protection_categories, 'ceramic');
});

test('manual protections, follow-ups for due maintenance and expiring warranties', async () => {
  const bob1 = db.get("SELECT id FROM vehicles WHERE plate = 'BOB1'");
  // PPF applied 14 months ago, yearly inspection -> overdue
  let r = await admin('POST', `/api/admin/vehicles/${bob1.id}/protections`, { name: 'PPF – Front Package', category: 'ppf', applied_at: addMonths(today(), -14), warranty_months: 60, maintenance_months: 12, details: 'Hood, bumper, mirrors' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.protection.maintenance_status, 'overdue');
  const ppfId = r.data.protection.id;
  // coating whose 36-month warranty ends in 10 days -> expiring
  r = await admin('POST', `/api/admin/vehicles/${bob1.id}/protections`, { name: 'Old coating', category: 'ceramic', applied_at: addMonths(addDays(today(), 10), -36), warranty_months: 36 });
  assert.equal(r.data.protection.warranty_status, 'expiring');
  // invalid input
  assert.equal((await admin('POST', `/api/admin/vehicles/${bob1.id}/protections`, { name: '', category: 'ppf' })).status, 400);
  assert.equal((await admin('POST', `/api/admin/vehicles/${bob1.id}/protections`, { name: 'x', category: 'nope' })).status, 400);
  assert.equal((await admin('POST', `/api/admin/vehicles/${bob1.id}/protections`, { name: 'x', applied_at: '2024-02-30' })).status, 400);

  const f = (await admin('GET', '/api/admin/followups')).data.followups;
  const plates = f.map((x) => `${x.plate}:${x.reason}`);
  assert.ok(plates.includes('BOB1:maintenance'), JSON.stringify(plates));
  assert.ok(plates.includes('BOB1:warranty'), JSON.stringify(plates));
  assert.ok(f.every((x, i) => i === 0 || f[i - 1].due_at <= x.due_at), 'sorted by due date');
  assert.equal(f.find((x) => x.reason === 'maintenance').owner_name, 'Bob');
  const stats = (await admin('GET', '/api/admin/stats')).data;
  assert.equal(stats.followups.length, f.length);

  // a visit resets the maintenance clock
  r = await admin('PATCH', `/api/admin/protections/${ppfId}`, { applied_at: today() });
  assert.equal(r.data.protection.maintenance_status, 'ok');
  assert.equal(r.data.protection.warranty_until, addMonths(today(), 60));
  assert.equal(r.data.protection.details, 'Hood, bumper, mirrors');
  assert.equal((await admin('DELETE', `/api/admin/protections/${ppfId}`)).status, 200);
  assert.ok(!(await admin('GET', '/api/admin/followups')).data.followups.some((x) => x.id === ppfId));
});

test('vehicle history for admin includes services, stats, timeline and notes', async () => {
  const n = await admin('POST', `/api/admin/vehicles/${ctx.aliceCar.id}/notes`, { kind: 'damage', note: 'Scratch on rear bumper' });
  assert.equal(n.status, 201);
  const h = await admin('GET', `/api/admin/vehicles/${ctx.aliceCar.id}`);
  assert.equal(h.status, 200);
  assert.equal(h.data.vehicle.plate, 'ABC123');
  assert.equal(h.data.vehicle.owner_name, 'Alice');
  assert.equal(h.data.stats.completed_washes, 2);
  assert.equal(h.data.stats.last_mileage, 42000);
  assert.equal(h.data.stats.average_rating, 5);
  const wash = h.data.bookings.find((b) => b.id === ctx.booking.id);
  assert.equal(wash.addons[0].name, 'Tire Shine');
  assert.ok(wash.events.some((e) => e.status === 'completed'));
  assert.equal(h.data.notes[0].kind, 'damage');

  const list = await admin('GET', '/api/admin/vehicles?q=abc 123');
  assert.equal(list.data.vehicles.length, 1);
  assert.equal(list.data.vehicles[0].washes, 2);

  const custHist = await alice('GET', `/api/my/vehicles/${ctx.aliceCar.id}/history`);
  assert.equal(custHist.data.notes, undefined);
  assert.equal(custHist.data.bookings.length, 2); // staff bookings for an owned car belong to its owner
});

test('redeeming points discounts a booking and cancelling refunds them', async () => {
  // Alice has 36 (wash) + 972 (coating: 810 + 20% SUV surcharge) points; add 500 more.
  const users = (await admin('GET', '/api/admin/customers?q=alice')).data.customers;
  await admin('PATCH', `/api/admin/customers/${users[0].id}`, { points_adjustment: 500 });
  const before = (await alice('GET', '/api/my/me')).data.user.loyalty_points;
  assert.equal(before, 1508);
  const date = openDay(1);
  const slot = (await alice('GET', `/api/availability?date=${date}&duration=60`)).data.slots.filter((s) => s.available).at(-1);
  const r = await alice('POST', '/api/my/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.pkg.id, scheduled_at: `${date} ${slot.time}`, redeem_points: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  // 30.00 to pay (25 + 20% SUV); rewards are 500 points = 25 off, so two rewards cover it in full
  assert.equal(r.data.booking.discount, 30);
  assert.equal(r.data.booking.total, 0);
  assert.equal(r.data.booking.points_redeemed, 1000);
  assert.equal((await alice('GET', '/api/my/me')).data.user.loyalty_points, before - 1000);
  const c = await alice('POST', `/api/my/bookings/${r.data.booking.id}/cancel`, { reason: 'Change of plans' });
  assert.equal(c.data.booking.status, 'cancelled');
  assert.equal((await alice('GET', '/api/my/me')).data.user.loyalty_points, before);
});

test('dashboard stats, reports and CSV export', async () => {
  const s = await admin('GET', '/api/admin/stats');
  assert.equal(s.status, 200);
  assert.equal(s.data.revenue_14d.length, 14);
  assert.ok(s.data.totals.washes >= 3);
  assert.ok(s.data.today.revenue > 0);

  const from = '2000-01-01';
  const to = openDay(10);
  const rep = await admin('GET', `/api/admin/reports?from=${from}&to=${to}`);
  assert.equal(rep.status, 200);
  assert.ok(rep.data.summary.completed >= 3);
  assert.ok(rep.data.by_service.length >= 1);
  const cats = Object.fromEntries(rep.data.by_category.map((c) => [c.category, c.count]));
  assert.equal(cats.ceramic, 1);
  assert.ok(cats.wash >= 2);

  const csv = await admin('GET', `/api/admin/reports/bookings.csv?from=${from}&to=${to}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /ABC123/);
});

test('admin manages services (with warranty fields), staff and settings', async () => {
  let r = await admin('POST', '/api/admin/services', { name: 'Interior Ceramic', price: 80, duration_min: 90, kind: 'addon', category: 'ceramic', warranty_months: 24, maintenance_months: '' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.service.category, 'ceramic');
  assert.equal(r.data.service.warranty_months, 24);
  assert.equal(r.data.service.maintenance_months, null);
  r = await admin('PATCH', `/api/admin/services/${r.data.service.id}`, { price: 95.5, warranty_months: 0 });
  assert.equal(r.data.service.price, 95.5);
  assert.equal(r.data.service.warranty_months, null);
  assert.equal(r.data.service.category, 'ceramic');
  assert.equal((await admin('DELETE', `/api/admin/services/${r.data.service.id}`)).data.archived, false);
  assert.equal((await admin('POST', '/api/admin/services', { name: 'X', price: 1, duration_min: 10, kind: 'package', category: 'tint' })).status, 400);
  // used package is archived, not deleted
  assert.equal((await admin('DELETE', `/api/admin/services/${ctx.pkg.id}`)).data.archived, true);
  await admin('PATCH', `/api/admin/services/${ctx.pkg.id}`, { active: true });

  r = await admin('POST', '/api/admin/staff', { name: 'Jo', position: 'Detailer' });
  assert.equal(r.status, 201);

  assert.equal((await admin('PUT', '/api/admin/settings', { open_time: '19:00', close_time: '08:00' })).status, 400);
  r = await admin('PUT', '/api/admin/settings', { bays: 5, business_name: 'Mr.Clean Car Detailing', tagline: 'PPF · Ceramic Coating', phone: '0300 1234567', open_days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.bays, 5);
  const pub = (await alice('GET', '/api/settings')).data.settings;
  assert.equal(pub.tagline, 'PPF · Ceramic Coating');
  assert.equal(pub.phone, '0300 1234567');
});

test('disabled customers cannot log in', async () => {
  const bobRow = db.get("SELECT id FROM users WHERE email = 'bob@example.com'");
  await admin('PATCH', `/api/admin/customers/${bobRow.id}`, { active: false });
  assert.equal((await bob('GET', '/api/my/me')).status, 401);
  assert.equal((await bob('POST', '/api/auth/login', { email: 'bob@example.com', password: 'password1' })).status, 403);
});

test('databases from the first version are upgraded in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrclean-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE services (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, price REAL NOT NULL,
              duration_min INTEGER NOT NULL DEFAULT 30, kind TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
            INSERT INTO services (name, price, kind, created_at) VALUES ('Old Wash', 10, 'package', '2025-01-01 10:00:00');`);
  old.close();
  const upgraded = openDatabase(file);
  const cols = upgraded.all('PRAGMA table_info(services)').map((c) => c.name);
  for (const c of ['category', 'warranty_months', 'maintenance_months']) assert.ok(cols.includes(c), c);
  assert.ok(upgraded.all('PRAGMA table_info(bookings)').some((c) => c.name === 'service_category'));
  assert.equal(upgraded.get("SELECT category FROM services WHERE name = 'Old Wash'").category, 'wash');
  upgraded.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
