'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

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

/** Next date (from tomorrow) that the shop is open, as YYYY-MM-DD. */
function nextOpenDate(openDays = [1, 2, 3, 4, 5, 6]) {
  const d = new Date();
  do d.setDate(d.getDate() + 1);
  while (!openDays.includes(d.getDay()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
const ctx = {};

test('admin can log in, wrong password is rejected', async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'nope' })).status, 401);
  const r = await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'secret123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
});

test('customers register and panels are role-protected', async () => {
  const r = await alice('POST', '/api/auth/register', { name: 'Alice', email: 'alice@example.com', password: 'password1', phone: '555-1' });
  assert.equal(r.status, 201);
  assert.equal((await bob('POST', '/api/auth/register', { name: 'Bob', email: 'ALICE@example.com', password: 'password1' })).status, 409);
  assert.equal((await bob('POST', '/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'password1' })).status, 201);

  assert.equal((await alice('GET', '/api/admin/stats')).status, 403);
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

test('quote applies large-vehicle surcharge', async () => {
  const { data } = await alice('GET', '/api/services');
  ctx.premium = data.services.find((s) => s.name === 'Premium Wash');
  ctx.wax = data.services.find((s) => s.name === 'Hand Wax');
  const q = await alice('POST', '/api/my/quote', { vehicle_id: ctx.aliceCar.id, service_id: ctx.premium.id, addon_ids: [ctx.wax.id] });
  assert.equal(q.status, 200);
  assert.equal(q.data.subtotal, 45);
  assert.equal(q.data.surcharge, 9); // 20% for SUV
  assert.equal(q.data.total, 54);
});

test('customer books an available slot; capacity is enforced', async () => {
  const date = nextOpenDate();
  const av = await alice('GET', `/api/availability?date=${date}`);
  assert.equal(av.status, 200);
  assert.ok(av.data.open);
  const slot = av.data.slots.find((s) => s.available);
  ctx.slot = `${date} ${slot.time}`;

  const r = await alice('POST', '/api/my/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.premium.id, addon_ids: [ctx.wax.id], scheduled_at: ctx.slot, notes: 'Dog hair in the back' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.booking.status, 'pending');
  assert.equal(r.data.booking.total, 54);
  assert.equal(r.data.booking.addons.length, 1);
  assert.equal(r.data.booking.admin_notes, undefined);
  ctx.booking = r.data.booking;

  // same vehicle can't have two active bookings
  assert.equal((await alice('POST', '/api/my/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.premium.id, scheduled_at: ctx.slot })).status, 409);

  // fill up the slot (3 bays by default) and check it's no longer bookable
  for (const plate of ['BOB1', 'BOB2']) {
    const v = await bob('POST', '/api/my/vehicles', { plate });
    assert.equal((await bob('POST', '/api/my/bookings', { vehicle_id: v.data.vehicle.id, service_id: ctx.premium.id, scheduled_at: ctx.slot })).status, 201);
  }
  const v3 = await bob('POST', '/api/my/vehicles', { plate: 'BOB3' });
  const full = await bob('POST', '/api/my/bookings', { vehicle_id: v3.data.vehicle.id, service_id: ctx.premium.id, scheduled_at: ctx.slot });
  assert.equal(full.status, 409);
  const av2 = await alice('GET', `/api/availability?date=${date}`);
  assert.equal(av2.data.slots.find((s) => s.time === slot.time).available, false);
});

test('booking in the past or on a bad slot is rejected', async () => {
  assert.equal((await alice('POST', '/api/my/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.premium.id, scheduled_at: '2000-01-03 10:00' })).status, 400);
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
  assert.equal(r.data.booking.points_earned, 54);
  assert.ok(r.data.booking.started_at && r.data.booking.completed_at);
  assert.ok(r.data.booking.events.length >= 4);

  const me = await alice('GET', '/api/my/me');
  assert.equal(me.data.user.loyalty_points, 54);
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

test('vehicle history for admin includes washes, stats, timeline and notes', async () => {
  const n = await admin('POST', `/api/admin/vehicles/${ctx.aliceCar.id}/notes`, { kind: 'damage', note: 'Scratch on rear bumper' });
  assert.equal(n.status, 201);
  const h = await admin('GET', `/api/admin/vehicles/${ctx.aliceCar.id}`);
  assert.equal(h.status, 200);
  assert.equal(h.data.vehicle.plate, 'ABC123');
  assert.equal(h.data.vehicle.owner_name, 'Alice');
  assert.equal(h.data.stats.completed_washes, 1);
  assert.equal(h.data.stats.total_spent, 54);
  assert.equal(h.data.stats.favourite_service, 'Premium Wash');
  assert.equal(h.data.stats.last_mileage, 42000);
  assert.equal(h.data.stats.average_rating, 5);
  assert.equal(h.data.bookings[0].addons[0].name, 'Hand Wax');
  assert.ok(h.data.bookings[0].events.some((e) => e.status === 'completed'));
  assert.equal(h.data.notes[0].kind, 'damage');

  const list = await admin('GET', '/api/admin/vehicles?q=abc 123');
  assert.equal(list.data.vehicles.length, 1);
  assert.equal(list.data.vehicles[0].washes, 1);

  const custHist = await alice('GET', `/api/my/vehicles/${ctx.aliceCar.id}/history`);
  assert.equal(custHist.data.notes, undefined);
  assert.equal(custHist.data.bookings.length, 1);
});

test('redeeming points discounts a booking and cancelling refunds them', async () => {
  // Give Alice enough points for a reward
  const users = (await admin('GET', '/api/admin/customers?q=alice')).data.customers;
  await admin('PATCH', `/api/admin/customers/${users[0].id}`, { points_adjustment: 100 }); // 154 total
  const date = nextOpenDate();
  const slot = (await alice('GET', `/api/availability?date=${date}`)).data.slots.filter((s) => s.available).at(-1);
  const r = await alice('POST', '/api/my/bookings', { vehicle_id: ctx.aliceCar.id, service_id: ctx.premium.id, scheduled_at: `${date} ${slot.time}`, redeem_points: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.booking.discount, 10);
  assert.equal(r.data.booking.points_redeemed, 100);
  assert.equal((await alice('GET', '/api/my/me')).data.user.loyalty_points, 54);
  const c = await alice('POST', `/api/my/bookings/${r.data.booking.id}/cancel`, { reason: 'Change of plans' });
  assert.equal(c.data.booking.status, 'cancelled');
  assert.equal((await alice('GET', '/api/my/me')).data.user.loyalty_points, 154);
});

test('dashboard stats, reports and CSV export', async () => {
  const s = await admin('GET', '/api/admin/stats');
  assert.equal(s.status, 200);
  assert.equal(s.data.revenue_14d.length, 14);
  assert.ok(s.data.totals.washes >= 2);
  assert.ok(s.data.today.revenue > 0);

  const from = '2000-01-01';
  const to = nextOpenDate();
  const rep = await admin('GET', `/api/admin/reports?from=${from}&to=${to}`);
  assert.equal(rep.status, 200);
  assert.ok(rep.data.summary.completed >= 2);
  assert.ok(rep.data.by_service.length >= 1);

  const csv = await admin('GET', `/api/admin/reports/bookings.csv?from=${from}&to=${to}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /ABC123/);
});

test('admin manages services, staff and settings', async () => {
  let r = await admin('POST', '/api/admin/services', { name: 'Bug Removal', price: 8, duration_min: 10, kind: 'addon' });
  assert.equal(r.status, 201);
  r = await admin('PATCH', `/api/admin/services/${r.data.service.id}`, { price: 9.5 });
  assert.equal(r.data.service.price, 9.5);
  assert.equal((await admin('DELETE', `/api/admin/services/${r.data.service.id}`)).data.archived, false);
  // used package is archived, not deleted
  assert.equal((await admin('DELETE', `/api/admin/services/${ctx.premium.id}`)).data.archived, true);
  await admin('PATCH', `/api/admin/services/${ctx.premium.id}`, { active: true });

  r = await admin('POST', '/api/admin/staff', { name: 'Jo', position: 'Washer' });
  assert.equal(r.status, 201);

  assert.equal((await admin('PUT', '/api/admin/settings', { open_time: '19:00', close_time: '08:00' })).status, 400);
  r = await admin('PUT', '/api/admin/settings', { bays: 5, business_name: 'Shiny Cars', open_days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.bays, 5);
  assert.equal((await alice('GET', '/api/settings')).data.settings.business_name, 'Shiny Cars');
});

test('disabled customers cannot log in', async () => {
  const bobRow = db.get("SELECT id FROM users WHERE email = 'bob@example.com'");
  await admin('PATCH', `/api/admin/customers/${bobRow.id}`, { active: false });
  assert.equal((await bob('GET', '/api/my/me')).status, 401);
  assert.equal((await bob('POST', '/api/auth/login', { email: 'bob@example.com', password: 'password1' })).status, 403);
});
