'use strict';

const { HttpError } = require('./errors');
const { now } = require('./db');

const ITEM_CATEGORIES = ['chemicals', 'polish', 'coating', 'ppf', 'consumables', 'tools', 'other'];
const MOVEMENT_TYPES = ['purchase', 'use', 'waste', 'adjust'];
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function text(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function num(v, label, { min = 0, max = 1e9, allowEmpty = false } = {}) {
  if ((v === '' || v === null || v === undefined) && allowEmpty) return null;
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} must be a number${min > 0 ? ' above 0' : ''}.`);
  return n;
}

function describe(item) {
  return { ...item, low: item.active && item.quantity <= item.min_quantity, value: r2(Math.max(0, item.quantity) * item.cost_price) };
}

function listItems(db, { includeArchived = false } = {}) {
  return db
    .all(`SELECT * FROM inventory_items ${includeArchived ? '' : 'WHERE active = 1'} ORDER BY active DESC, category, name`)
    .map(describe);
}

function getItem(db, id) {
  const item = db.get('SELECT * FROM inventory_items WHERE id = ?', Number.parseInt(id, 10));
  if (!item) throw new HttpError(404, 'Item not found.');
  return item;
}

function itemInput(body, current = {}) {
  const pick = (k) => (body[k] !== undefined ? body[k] : current[k]);
  const name = text(pick('name'), 80);
  if (!name) throw new HttpError(400, 'Item name is required.');
  const category = pick('category') || 'other';
  if (!ITEM_CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category.');
  const unit = text(pick('unit'), 10) || 'pcs';
  return {
    name,
    category,
    unit,
    min_quantity: r3(num(pick('min_quantity') ?? 0, 'Reorder level')),
    cost_price: r2(num(pick('cost_price') ?? 0, 'Cost per unit')),
    supplier: text(pick('supplier'), 80),
    notes: text(pick('notes'), 500),
    active: pick('active') === undefined ? 1 : pick('active') ? 1 : 0,
  };
}

function createItem(db, body, actorName) {
  const it = itemInput(body);
  const qty = r3(num(body.quantity ?? 0, 'Opening stock'));
  return db.tx(() => {
    const { id } = db.run(
      'INSERT INTO inventory_items (name, category, unit, quantity, min_quantity, cost_price, supplier, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      it.name, it.category, it.unit, qty, it.min_quantity, it.cost_price, it.supplier, it.notes, it.active, now(),
    );
    if (qty) db.run("INSERT INTO inventory_movements (item_id, type, quantity, unit_cost, note, actor_name, created_at) VALUES (?, 'adjust', ?, ?, 'Opening stock', ?, ?)", id, qty, it.cost_price, actorName || null, now());
    return describe(getItem(db, id));
  });
}

function updateItem(db, id, body) {
  const current = getItem(db, id);
  const it = itemInput(body, current);
  db.run(
    'UPDATE inventory_items SET name = ?, category = ?, unit = ?, min_quantity = ?, cost_price = ?, supplier = ?, notes = ?, active = ? WHERE id = ?',
    it.name, it.category, it.unit, it.min_quantity, it.cost_price, it.supplier, it.notes, it.active, current.id,
  );
  return describe(getItem(db, current.id));
}

/**
 * Record a stock change.
 *  purchase: { quantity, unit_cost? }  adds stock, updates the average cost
 *  use / waste: { quantity }           removes stock (may go negative — shown in red)
 *  adjust: { counted }                 sets the stock to what was physically counted
 */
function move(db, itemId, { type, quantity, unit_cost: unitCost, counted, note, booking_id: bookingId }, actorName) {
  if (!MOVEMENT_TYPES.includes(type)) throw new HttpError(400, 'Unknown stock movement.');
  const item = getItem(db, itemId);
  let delta;
  let cost = item.cost_price;
  if (type === 'adjust') {
    delta = r3(num(counted, 'Counted quantity') - item.quantity);
    if (!delta) throw new HttpError(400, 'The counted quantity is the same as the current stock.');
  } else {
    const q = r3(num(quantity, 'Quantity', { min: 0.0005 }));
    delta = type === 'purchase' ? q : -q;
    if (type === 'purchase' && unitCost !== undefined && unitCost !== '' && unitCost !== null) cost = r2(num(unitCost, 'Cost per unit'));
  }
  return db.tx(() => {
    if (type === 'purchase') {
      // weighted average cost
      const before = Math.max(0, item.quantity);
      const avg = before + delta > 0 ? r2((before * item.cost_price + delta * cost) / (before + delta)) : cost;
      db.run('UPDATE inventory_items SET quantity = quantity + ?, cost_price = ? WHERE id = ?', delta, avg, item.id);
    } else {
      db.run('UPDATE inventory_items SET quantity = quantity + ? WHERE id = ?', delta, item.id);
    }
    db.run(
      'INSERT INTO inventory_movements (item_id, type, quantity, unit_cost, booking_id, note, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      item.id, type, delta, cost, bookingId || null, text(note, 200), actorName || null, now(),
    );
    db.run('UPDATE inventory_items SET quantity = ROUND(quantity, 3) WHERE id = ?', item.id);
    return describe(getItem(db, item.id));
  });
}

function movements(db, itemId, limit = 200) {
  return db.all(
    `SELECT m.*, b.code AS booking_code FROM inventory_movements m LEFT JOIN bookings b ON b.id = m.booking_id
      WHERE m.item_id = ? ORDER BY m.id DESC LIMIT ?`,
    Number.parseInt(itemId, 10),
    limit,
  );
}

function materialsFor(db, serviceId) {
  return db.all(
    `SELECT sm.item_id, sm.quantity, i.name, i.unit, i.cost_price FROM service_materials sm JOIN inventory_items i ON i.id = sm.item_id
      WHERE sm.service_id = ? ORDER BY i.name`,
    serviceId,
  );
}

function setMaterials(db, serviceId, list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Materials must be a list.');
  const rows = list
    .filter((m) => m && m.item_id)
    .map((m) => {
      getItem(db, m.item_id);
      return { item_id: Number.parseInt(m.item_id, 10), quantity: r3(num(m.quantity, 'Material quantity', { min: 0.0005 })) };
    });
  db.tx(() => {
    db.run('DELETE FROM service_materials WHERE service_id = ?', serviceId);
    for (const m of rows) db.run('INSERT OR REPLACE INTO service_materials (service_id, item_id, quantity) VALUES (?, ?, ?)', serviceId, m.item_id, m.quantity);
  });
  return materialsFor(db, serviceId);
}

/** When a job is completed, take the materials of its package and catalog extras out of stock. Runs once per booking. */
function deductForBooking(db, bookingId, actorName) {
  if (db.get("SELECT 1 FROM inventory_movements WHERE booking_id = ? AND type = 'use' AND note LIKE 'Used on job%'", bookingId)) return [];
  const b = db.get('SELECT id, code, service_id FROM bookings WHERE id = ?', bookingId);
  if (!b) return [];
  const serviceIds = [b.service_id, ...db.all('SELECT service_id FROM booking_addons WHERE booking_id = ? AND service_id IS NOT NULL', bookingId).map((a) => a.service_id)].filter(Boolean);
  const totals = new Map();
  for (const sid of serviceIds) for (const m of materialsFor(db, sid)) totals.set(m.item_id, r3((totals.get(m.item_id) || 0) + m.quantity));
  const used = [];
  for (const [itemId, qty] of totals) {
    const item = db.get('SELECT id, active FROM inventory_items WHERE id = ?', itemId);
    if (!item || !item.active) continue;
    move(db, itemId, { type: 'use', quantity: qty, booking_id: bookingId, note: `Used on job ${b.code}` }, actorName);
    used.push({ item_id: itemId, quantity: qty });
  }
  return used;
}

module.exports = { ITEM_CATEGORIES, MOVEMENT_TYPES, listItems, getItem, createItem, updateItem, move, movements, materialsFor, setMaterials, deductForBooking, describe };
