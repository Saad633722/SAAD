'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let base;
let db;

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
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}

before(async () => {
  const app = createApp({ dbPath: ':memory:', adminPassword: 'secret123' });
  db = app.locals.db;
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const admin = client();
const emp = client();
const ctx = {};

test('PIN sign-in: 2222 is the admin, 1111 an employee; wrong PINs fail', async () => {
  assert.equal((await client()('POST', '/api/auth/pin', { pin: '9999' })).status, 401);
  assert.equal((await client()('POST', '/api/auth/pin', { pin: '12' })).status, 400);
  let r = await admin('POST', '/api/auth/pin', { pin: '2222' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
  r = await emp('POST', '/api/auth/pin', { pin: '1111' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'employee');
  assert.equal(r.data.user.name, 'Alex Carter');
  const me = await emp('GET', '/api/auth/me');
  assert.equal(me.data.user.role, 'employee');
  // employees use the admin panel page, not the customer one
  assert.equal((await emp('GET', '/admin')).status, 200);
  assert.equal((await emp('GET', '/app')).status, 302);
  assert.equal((await emp('GET', '/api/my/vehicles')).status, 403);
  assert.equal((await client()('GET', '/staff')).status, 200);
});

test('employees cannot see reports, settings, prices catalogue, staff or customer accounts', async () => {
  for (const [m, url, body] of [
    ['GET', '/api/admin/reports'],
    ['GET', '/api/admin/reports/bookings.csv'],
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings', { bays: 9 }],
    ['POST', '/api/admin/services', { name: 'x', price: 1, duration_min: 1, kind: 'package' }],
    ['PATCH', '/api/admin/services/1', { price: 1 }],
    ['POST', '/api/admin/staff', { name: 'x' }],
    ['PATCH', '/api/admin/staff/1', { pin: '4444' }],
    ['GET', '/api/admin/customers/1'],
    ['PATCH', '/api/admin/customers/1', { points_adjustment: 100 }],
    ['DELETE', '/api/admin/payments/1'],
    ['POST', '/api/admin/vehicles/1/protections', { name: 'x' }],
    ['POST', '/api/admin/pin', { pin: '5555' }],
    ['POST', '/api/admin/inventory', { name: 'x' }],
    ['PUT', '/api/admin/inventory/materials/1', { materials: [] }],
  ]) {
    assert.equal((await emp(m, url, body)).status, 403, `${m} ${url}`);
  }
  // dashboard without money figures
  const s = (await emp('GET', '/api/admin/stats')).data;
  assert.ok(s.today && Array.isArray(s.queue) && Array.isArray(s.low_stock));
  assert.equal(s.month, undefined);
  assert.equal(s.revenue_14d, undefined);
  assert.equal(s.collected_today, undefined);
  assert.equal(s.today.revenue, undefined);
  // staff list without PIN data or phone numbers
  const staff = (await emp('GET', '/api/admin/staff')).data.staff;
  assert.ok(staff.every((x) => x.pin_hash === undefined && x.has_pin === undefined && x.phone === undefined));
  const adminStaff = (await admin('GET', '/api/admin/staff')).data.staff;
  assert.ok(adminStaff.every((x) => x.pin_hash === undefined));
  assert.equal(adminStaff.find((x) => x.name === 'Alex Carter').has_pin, true);
});

test('employees run the floor: walk-ins, status, payments; no discounts or refunds', async () => {
  const { services } = (await emp('GET', '/api/admin/services')).data;
  const wash = services.find((s) => s.name === 'Wash');
  ctx.wash = wash;
  // discount blocked
  assert.equal((await emp('POST', '/api/admin/bookings', { vehicle: { plate: 'EMP1' }, service_id: wash.id, discount_value: 50 })).status, 403);
  let r = await emp('POST', '/api/admin/bookings', { vehicle: { plate: 'EMP1', type: 'sedan' }, service_id: wash.id, service_price: 600, start_now: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const b = r.data.booking;
  assert.equal(b.total, 600);
  assert.ok(b.events[0].actor_name === 'Alex Carter');
  // manual price allowed, discount not
  r = await emp('PUT', `/api/admin/bookings/${b.id}/pricing`, { service_price: 700 });
  assert.equal(r.status, 200);
  assert.equal(r.data.booking.total, 700);
  assert.equal((await emp('PUT', `/api/admin/bookings/${b.id}/pricing`, { discount_type: 'percent', discount_value: 10 })).status, 403);
  // complete and take a split payment
  assert.equal((await emp('PATCH', `/api/admin/bookings/${b.id}`, { status: 'completed' })).status, 200);
  r = await emp('POST', `/api/admin/bookings/${b.id}/payments`, { payments: [{ method: 'Cash', amount: 400 }, { method: 'JazzCash', amount: 300 }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.booking.payments[0].received_by, 'Alex Carter');
  assert.equal((await emp('POST', `/api/admin/bookings/${b.id}/payments`, { method: 'Cash', amount: -100 })).status, 403);
  // admin can allow discounts for employees
  await admin('PUT', '/api/admin/settings', { employee_can_discount: true });
  r = await emp('PUT', `/api/admin/bookings/${b.id}/pricing`, { discount_type: 'amount', discount_value: 0, service_price: 700 });
  assert.equal(r.status, 200);
  await admin('PUT', '/api/admin/settings', { employee_can_discount: false });
  // customer list for the booking form: contact details only
  const cust = (await emp('GET', '/api/admin/customers')).data.customers;
  assert.ok(cust.every((c) => c.total_spent === undefined && c.loyalty_points === undefined));
  ctx.empBooking = b;
});

test('admin sets employee PINs (unique, 4 digits) and can change their own', async () => {
  let r = await admin('POST', '/api/admin/staff', { name: 'Bilal', position: 'Washer', pin: '3333' });
  assert.equal(r.status, 201);
  assert.equal(r.data.staff.has_pin, true);
  assert.equal(r.data.staff.pin_hash, undefined);
  const bilalId = r.data.staff.id;
  assert.equal((await admin('POST', '/api/admin/staff', { name: 'Dup', pin: '1111' })).status, 409);
  assert.equal((await admin('POST', '/api/admin/staff', { name: 'Dup', pin: '2222' })).status, 409); // the admin's PIN
  assert.equal((await admin('POST', '/api/admin/staff', { name: 'Bad', pin: '12a4' })).status, 400);
  const bilal = client();
  assert.equal((await bilal('POST', '/api/auth/pin', { pin: '3333' })).status, 200);
  // deactivating the employee signs them out and blocks their PIN
  await admin('PATCH', `/api/admin/staff/${bilalId}`, { active: false });
  assert.equal((await bilal('GET', '/api/admin/stats')).status, 401);
  assert.equal((await client()('POST', '/api/auth/pin', { pin: '3333' })).status, 401);
  // admin PIN change needs the password
  assert.equal((await admin('POST', '/api/admin/pin', { current_password: 'nope', pin: '8888' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/pin', { current_password: 'secret123', pin: '1111' })).status, 409);
  assert.equal((await admin('POST', '/api/admin/pin', { current_password: 'secret123', pin: '8888' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/pin', { pin: '2222' })).status, 401);
  assert.equal((await client()('POST', '/api/auth/pin', { pin: '8888' })).data.user.role, 'admin');
});

test('inventory: starter stock, purchases (average cost), counts, usage', async () => {
  let r = await admin('GET', '/api/admin/inventory');
  assert.equal(r.status, 200);
  assert.ok(r.data.items.length >= 15);
  assert.ok(r.data.summary.value > 0);
  const shampoo = r.data.items.find((i) => i.name === 'Car shampoo');
  assert.equal(shampoo.unit, 'L');
  ctx.shampoo = shampoo;
  // employees see stock but not costs
  const ei = (await emp('GET', '/api/admin/inventory')).data;
  assert.equal(ei.summary.value, undefined);
  assert.ok(ei.items.every((i) => i.cost_price === undefined && i.value === undefined));

  // new item with opening stock
  r = await admin('POST', '/api/admin/inventory', { name: 'Wax', category: 'polish', unit: 'kg', quantity: 2, min_quantity: 1, cost_price: 3000, supplier: 'Auto Chem Rawalpindi' });
  assert.equal(r.status, 201);
  const wax = r.data.item;
  assert.equal((await admin('POST', '/api/admin/inventory', { name: '', unit: 'kg' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/inventory', { name: 'x', category: 'food' })).status, 400);
  // purchase 2 kg at 4000 -> average cost 3500
  r = await admin('POST', `/api/admin/inventory/${wax.id}/movements`, { type: 'purchase', quantity: 2, unit_cost: 4000, note: 'Invoice 55' });
  assert.equal(r.data.item.quantity, 4);
  assert.equal(r.data.item.cost_price, 3500);
  // employee records use; cannot purchase or adjust
  r = await emp('POST', `/api/admin/inventory/${wax.id}/movements`, { type: 'use', quantity: 3.5 });
  assert.equal(r.status, 201);
  assert.equal(r.data.item.quantity, 0.5);
  assert.equal(r.data.item.low, true);
  assert.equal((await emp('POST', `/api/admin/inventory/${wax.id}/movements`, { type: 'purchase', quantity: 1 })).status, 403);
  assert.equal((await emp('POST', `/api/admin/inventory/${wax.id}/movements`, { type: 'adjust', counted: 9 })).status, 403);
  assert.equal((await emp('POST', `/api/admin/inventory/${wax.id}/movements`, { type: 'use', quantity: 0 })).status, 400);
  // stock count
  r = await admin('POST', `/api/admin/inventory/${wax.id}/movements`, { type: 'adjust', counted: 1, note: 'Monthly count' });
  assert.equal(r.data.item.quantity, 1);
  const hist = (await admin('GET', `/api/admin/inventory/${wax.id}/movements`)).data.movements;
  assert.deepEqual(hist.map((m) => [m.type, m.quantity]), [['adjust', 0.5], ['use', -3.5], ['purchase', 2], ['adjust', 2]]);
  assert.equal(hist[1].actor_name, 'Alex Carter');
  // low stock shows on the dashboard
  const s = (await admin('GET', '/api/admin/stats')).data;
  assert.ok(s.low_stock.some((i) => i.name === 'Wax'));
  // edit + archive
  r = await admin('PATCH', `/api/admin/inventory/${wax.id}`, { min_quantity: 0.5, active: false });
  assert.equal(r.data.item.active, 0);
  assert.ok(!(await admin('GET', '/api/admin/inventory')).data.items.some((i) => i.id === wax.id));
});

test('completing a job takes its materials out of stock (once) and reports the cost', async () => {
  // the Wash package uses 0.05 L shampoo by default
  const mats = (await admin('GET', `/api/admin/inventory/materials/${ctx.wash.id}`)).data.materials;
  assert.deepEqual(mats.map((m) => [m.name, m.quantity]), [['Car shampoo', 0.05]]);
  // the employee's completed wash already used 0.05 L of the 20 L opening stock
  const before = ctx.shampoo.quantity;
  assert.equal(before, 19.95);
  let items = (await admin('GET', '/api/admin/inventory')).data.items;

  // change the recipe: 0.1 L shampoo + 0.02 L glass cleaner
  const glass = items.find((i) => i.name === 'Glass cleaner');
  let r = await admin('PUT', `/api/admin/inventory/materials/${ctx.wash.id}`, { materials: [{ item_id: ctx.shampoo.id, quantity: 0.1 }, { item_id: glass.id, quantity: 0.02 }] });
  assert.equal(r.data.materials.length, 2);
  assert.equal((await admin('PUT', `/api/admin/inventory/materials/${ctx.wash.id}`, { materials: [{ item_id: 99999, quantity: 1 }] })).status, 404);

  r = await admin('POST', '/api/admin/bookings', { vehicle: { plate: 'MAT1' }, service_id: ctx.wash.id, start_now: true });
  const id = r.data.booking.id;
  await admin('PATCH', `/api/admin/bookings/${id}`, { status: 'completed' });
  items = (await admin('GET', '/api/admin/inventory')).data.items;
  assert.equal(items.find((i) => i.name === 'Car shampoo').quantity, Math.round((before - 0.1) * 1000) / 1000);
  assert.equal(items.find((i) => i.name === 'Glass cleaner').quantity, Math.round((glass.quantity - 0.02) * 1000) / 1000);
  const hist = (await admin('GET', `/api/admin/inventory/${ctx.shampoo.id}/movements`)).data.movements;
  assert.equal(hist[0].booking_code, r.data.booking.code);

  const rep = (await admin('GET', '/api/admin/reports?from=2000-01-01&to=2100-01-01')).data;
  const sh = rep.materials.find((m) => m.name === 'Car shampoo');
  assert.equal(sh.quantity, 0.15); // 0.05 (employee's job) + 0.1
  assert.equal(sh.cost, 120); // 0.15 L x Rs 800
  assert.ok(rep.summary.materials_cost >= 120);
  assert.equal(rep.summary.purchases, 8000);
});

test('sessions table from older versions is rebuilt', () => {
  const cols = db.all('PRAGMA table_info(sessions)').map((c) => c.name);
  assert.ok(cols.includes('staff_id'));
});

test('wrong PINs are rate-limited (successful sign-ins are not)', async () => {
  for (let i = 0; i < 15; i++) assert.equal((await client()('POST', '/api/auth/pin', { pin: '1111' })).status, 200);
  const c = client();
  let last;
  for (let i = 0; i < 11; i++) last = await c('POST', '/api/auth/pin', { pin: '0000' });
  assert.equal(last.status, 429);
  assert.equal((await c('POST', '/api/auth/pin', { pin: '1111' })).status, 429);
});
