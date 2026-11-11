'use strict';

const crypto = require('node:crypto');
const { now, today } = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const VEHICLE_TYPES = ['sedan', 'hatchback', 'coupe', 'suv', 'pickup', 'van', 'motorbike'];
const LARGE_TYPES = new Set(['suv', 'pickup', 'van']);
const STATUSES = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'];
const ACTIVE_STATUSES = ['pending', 'confirmed', 'in_progress'];
const CATEGORIES = ['wash', 'detailing', 'ceramic', 'ppf', 'other'];

// Which status changes the admin is allowed to make.
const TRANSITIONS = {
  pending: ['confirmed', 'in_progress', 'cancelled', 'no_show'],
  confirmed: ['pending', 'in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function normalizePlate(plate) {
  return String(plate || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function str(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function int(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function makeCode() {
  return 'MC-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function isValidDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  if (!m) return false;
  const [y, mo, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const dt = new Date(Date.UTC(y, mo, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === day;
}

// ---------- Date helpers (on "YYYY-MM-DD" strings, timezone-free) ----------
function utc(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(dateStr, n) {
  const dt = utc(dateStr);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function addMonths(dateStr, months) {
  const src = utc(dateStr);
  const target = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(src.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr) {
  return utc(dateStr).getUTCDay();
}

/** Validate & normalise vehicle fields coming from a form. */
function vehicleInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.plate !== undefined) {
    const plate = normalizePlate(body.plate);
    if (plate.length < 2 || plate.length > 12) throw new HttpError(400, 'Please enter a valid licence plate.');
    out.plate = plate;
  }
  for (const key of ['make', 'model', 'color', 'notes']) {
    if (!partial || body[key] !== undefined) out[key] = str(body[key], key === 'notes' ? 1000 : 60);
  }
  if (!partial || body.year !== undefined) {
    const year = int(body.year);
    if (year !== null && (year < 1950 || year > new Date().getFullYear() + 1)) throw new HttpError(400, 'Please enter a valid year.');
    out.year = year;
  }
  if (!partial || body.type !== undefined) {
    const type = String(body.type || 'sedan').toLowerCase();
    if (!VEHICLE_TYPES.includes(type)) throw new HttpError(400, 'Unknown vehicle type.');
    out.type = type;
  }
  return out;
}

const MAX_PRICE = 10000000;
const DISCOUNT_TYPES = ['amount', 'percent'];

function priceValue(v, label) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) throw new HttpError(400, `${label} must be a number between 0 and ${MAX_PRICE.toLocaleString('en')}.`);
  return round2(n);
}

const moneyText = (settings, n) => `${settings.currency || ''} ${Number(n).toLocaleString('en', { maximumFractionDigits: 2 })}`.trim();

/**
 * Totals for a bill. Order: subtotal -> size surcharge -> staff discount (amount or %)
 * -> loyalty points -> tax.
 */
function computeTotals(settings, { subtotal, vehicleType, applySurcharge = true, discountType = 'amount', discountValue = 0, redeemPoints = false, availablePoints = 0, fixedPointsDiscount = null }) {
  if (!DISCOUNT_TYPES.includes(discountType)) throw new HttpError(400, 'Discount type must be "amount" or "percent".');
  const dv = Number(discountValue || 0);
  if (!Number.isFinite(dv) || dv < 0) throw new HttpError(400, 'Discount must be a positive number.');
  if (discountType === 'percent' && dv > 100) throw new HttpError(400, 'A percentage discount cannot be more than 100%.');
  const surcharge = applySurcharge && LARGE_TYPES.has(vehicleType) ? round2((subtotal * Number(settings.large_vehicle_surcharge || 0)) / 100) : 0;
  const gross = round2(subtotal + surcharge);
  const manualDiscount = discountType === 'percent' ? round2((gross * dv) / 100) : round2(Math.min(dv, gross));
  const remaining = round2(gross - manualDiscount);

  let pointsDiscount = 0;
  let pointsRedeemed = 0;
  const rewardPoints = Number(settings.reward_points) || 0;
  const rewardValue = Number(settings.reward_value) || 0;
  if (fixedPointsDiscount !== null) {
    pointsDiscount = round2(Math.min(Math.max(0, fixedPointsDiscount), remaining));
  } else if (redeemPoints && rewardPoints > 0 && rewardValue > 0 && remaining > 0) {
    const blocks = Math.min(Math.floor(availablePoints / rewardPoints), Math.ceil(remaining / rewardValue));
    pointsDiscount = round2(Math.min(blocks * rewardValue, remaining));
    pointsRedeemed = blocks * rewardPoints;
  }
  const discount = round2(manualDiscount + pointsDiscount);
  const taxable = Math.max(0, gross - discount);
  const tax = round2((taxable * Number(settings.tax_rate || 0)) / 100);
  return { subtotal: round2(subtotal), surcharge, manualDiscount, pointsDiscount, pointsRedeemed, discount, tax, total: round2(taxable + tax) };
}

/**
 * Work out the price (and total working time) for a booking.
 * Staff may override the package price and give a discount (amount or percent).
 */
function quote(db, { serviceId, addonIds = [], vehicleType = 'sedan', redeemPoints = false, availablePoints = 0, servicePrice, applySurcharge = true, discountType = 'amount', discountValue = 0 }) {
  const settings = db.getSettings();
  const service = db.get("SELECT * FROM services WHERE id = ? AND kind = 'package'", int(serviceId));
  if (!service) throw new HttpError(400, 'Please choose a service package.');
  if (!service.active) throw new HttpError(400, 'That package is no longer available.');

  const ids = [...new Set((Array.isArray(addonIds) ? addonIds : [addonIds]).map(int).filter(Boolean))];
  const addons = ids.map((id) => {
    const a = db.get("SELECT * FROM services WHERE id = ? AND kind = 'addon' AND active = 1", id);
    if (!a) throw new HttpError(400, 'One of the selected extras is not available.');
    return a;
  });
  const price = servicePrice === undefined || servicePrice === null || servicePrice === '' ? service.price : priceValue(servicePrice, 'Price');
  const totals = computeTotals(settings, {
    subtotal: price + addons.reduce((s, a) => s + a.price, 0),
    vehicleType,
    applySurcharge,
    discountType,
    discountValue,
    redeemPoints,
    availablePoints,
  });
  const duration = service.duration_min + addons.reduce((s, a) => s + a.duration_min, 0);
  return { service, servicePrice: price, addons, ...totals, duration };
}

// =====================================================================
// Scheduling. A job occupies one bay for its whole working time; long jobs
// (PPF, ceramic coating) carry on the next open day, so a 3-day job blocks
// a bay for 3 days.
// =====================================================================
function hoursOf(settings) {
  return {
    open: toMinutes(settings.open_time),
    close: toMinutes(settings.close_time),
    step: Math.max(10, Number(settings.slot_minutes) || 30),
    days: Array.isArray(settings.open_days) ? settings.open_days.map(Number) : [],
    bays: Math.max(1, Number(settings.bays) || 1),
  };
}

/** Split a job into the [from, to) minute spans it occupies, day by day, within opening hours. */
function workSpans(h, start, durationMin) {
  const spans = [];
  let date = start.slice(0, 10);
  let from = toMinutes(start.slice(11, 16));
  let remaining = Math.max(1, Number(durationMin) || 1);
  for (let guard = 0; remaining > 0 && guard < 366; guard++) {
    if (h.days.includes(dayOfWeek(date)) && h.close > h.open) {
      const s = Math.max(from, h.open);
      if (s < h.close) {
        const e = Math.min(h.close, s + remaining);
        spans.push({ date, from: s, to: e });
        remaining -= e - s;
      }
    }
    date = addDays(date, 1);
    from = h.open;
  }
  return spans;
}

function spanEnd(spans) {
  const last = spans[spans.length - 1];
  return last ? `${last.date} ${fromMinutes(last.to)}` : null;
}

/** Estimated time the car will be ready, given the opening hours. */
function readyAt(settings, start, durationMin) {
  return spanEnd(workSpans(hoursOf(settings), start, durationMin));
}

function* slotStarts(h, span) {
  for (let t = h.open + Math.floor((span.from - h.open) / h.step) * h.step; t < span.to; t += h.step) yield t;
}

/** How many bays are taken in each slot ("YYYY-MM-DD HH:MM" -> count) by active bookings. */
function occupancy(db, h, excludeId) {
  const rows = db.all(`SELECT id, scheduled_at, duration_min FROM bookings WHERE status IN ('pending', 'confirmed', 'in_progress')`);
  const counts = new Map();
  for (const b of rows) {
    if (excludeId && b.id === excludeId) continue;
    for (const span of workSpans(h, b.scheduled_at, b.duration_min)) {
      for (const t of slotStarts(h, span)) {
        const key = `${span.date} ${t}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

function peakUsage(counts, h, spans) {
  let peak = 0;
  for (const span of spans) for (const t of slotStarts(h, span)) peak = Math.max(peak, counts.get(`${span.date} ${t}`) || 0);
  return peak;
}

/**
 * Bookable start times for a date. A start time is available when a bay is free
 * for the whole duration of the job (which may run over several days).
 */
function availability(db, date, { duration, excludeId } = {}) {
  if (!isValidDate(date)) throw new HttpError(400, 'Invalid date.');
  const h = hoursOf(db.getSettings());
  if (!h.days.includes(dayOfWeek(date))) return { date, open: false, slots: [] };
  const dur = Math.max(1, int(duration) || h.step);
  const counts = occupancy(db, h, int(excludeId));
  const nowStr = now().slice(0, 16);
  const slots = [];
  for (let m = h.open; m + h.step <= h.close; m += h.step) {
    const time = fromMinutes(m);
    const at = `${date} ${time}`;
    const spans = workSpans(h, at, dur);
    const remaining = Math.max(0, h.bays - peakUsage(counts, h, spans));
    slots.push({ time, remaining, available: remaining > 0 && at > nowStr, ready_at: spanEnd(spans) });
  }
  return { date, open: true, duration_min: dur, slots };
}

function assertSlotBookable(db, scheduledAt, { duration, excludeId } = {}) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(scheduledAt || '');
  if (!m) throw new HttpError(400, 'Please choose a date and time.');
  const [, date, time] = m;
  if (`${date} ${time}` <= now().slice(0, 16)) throw new HttpError(400, 'That time has already passed. Please pick a later slot.');
  const s = db.getSettings();
  const last = new Date();
  last.setDate(last.getDate() + Number(s.booking_window_days || 30));
  if (date > today(last)) throw new HttpError(400, `Bookings can only be made up to ${s.booking_window_days} days ahead.`);
  const { slots, open } = availability(db, date, { duration, excludeId });
  if (!open) throw new HttpError(400, 'We are closed on that day.');
  const slot = slots.find((x) => x.time === time);
  if (!slot) throw new HttpError(400, 'That time is outside our opening hours.');
  if (!slot.available) throw new HttpError(409, 'Sorry, there is no free bay for the whole job at that time. Please choose another slot.');
  return `${date} ${time}`;
}

function addEvent(db, bookingId, status, note, actorName) {
  db.run(
    'INSERT INTO booking_events (booking_id, status, note, actor_name, created_at) VALUES (?, ?, ?, ?, ?)',
    bookingId,
    status,
    note || null,
    actorName || null,
    now(),
  );
}

/**
 * Create a booking (inside a transaction). With enforceSlot the time must be a
 * free slot for the whole job (customer bookings); staff can always book.
 */
function createBooking(db, { vehicle, customerId, serviceId, addonIds, scheduledAt, redeemPoints, customerNotes, adminNotes, source, status, staffId, bay, actorName, servicePrice, applySurcharge = true, discountType = 'amount', discountValue = 0, discountReason, enforceSlot = false }) {
  return db.tx(() => {
    let availablePoints = 0;
    if (customerId) {
      const c = db.get('SELECT loyalty_points FROM users WHERE id = ?', customerId);
      availablePoints = c ? c.loyalty_points : 0;
    }
    const q = quote(db, {
      serviceId,
      addonIds,
      vehicleType: vehicle.type,
      redeemPoints: Boolean(redeemPoints) && Boolean(customerId),
      availablePoints,
      servicePrice,
      applySurcharge,
      discountType,
      discountValue,
    });
    const at = enforceSlot ? assertSlotBookable(db, scheduledAt, { duration: q.duration }) : scheduledAt;
    let code = makeCode();
    while (db.get('SELECT 1 FROM bookings WHERE code = ?', code)) code = makeCode();
    const initial = status || 'pending';
    const ts = now();
    const { id } = db.run(
      `INSERT INTO bookings (code, vehicle_id, customer_id, service_id, service_name, service_price, service_category, duration_min, scheduled_at, status,
         bay, staff_id, subtotal, surcharge, discount, manual_discount, discount_type, discount_value, discount_reason, tax, total, points_redeemed, customer_notes, admin_notes, source, created_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      vehicle.id,
      customerId || null,
      q.service.id,
      q.service.name,
      q.servicePrice,
      q.service.category,
      q.duration,
      at,
      initial,
      int(bay),
      int(staffId),
      q.subtotal,
      q.surcharge,
      q.discount,
      q.manualDiscount,
      q.manualDiscount ? discountType : 'amount',
      q.manualDiscount ? Number(discountValue) : 0,
      q.manualDiscount ? str(discountReason, 200) : null,
      q.tax,
      q.total,
      q.pointsRedeemed,
      str(customerNotes, 1000),
      str(adminNotes, 2000),
      source || 'online',
      ts,
      initial === 'in_progress' ? ts : null,
    );
    for (const a of q.addons) {
      db.run('INSERT INTO booking_addons (booking_id, service_id, name, price) VALUES (?, ?, ?, ?)', id, a.id, a.name, a.price);
    }
    if (q.pointsRedeemed && customerId) {
      db.run('UPDATE users SET loyalty_points = loyalty_points - ? WHERE id = ?', q.pointsRedeemed, customerId);
    }
    addEvent(db, id, initial, source === 'walk_in' ? 'Walk-in booking created' : 'Booking created', actorName);
    if (q.total <= 0) recalcPayments(db, id);
    return id;
  });
}

// =====================================================================
// Protection (ceramic coating / PPF) warranties and maintenance
// =====================================================================

/**
 * When a job is completed, record every service in it that carries a warranty or
 * needs maintenance visits. Safe to call more than once.
 */
function recordProtections(db, bookingId, completedAt) {
  if (db.get('SELECT 1 FROM vehicle_protections WHERE booking_id = ?', bookingId)) return;
  const b = db.get('SELECT id, vehicle_id, service_id, service_name FROM bookings WHERE id = ?', bookingId);
  if (!b) return;
  const items = [];
  if (b.service_id) items.push({ service_id: b.service_id, name: b.service_name });
  for (const a of db.all('SELECT service_id, name FROM booking_addons WHERE booking_id = ? ORDER BY id', bookingId)) {
    if (a.service_id) items.push(a);
  }
  const applied = (completedAt || now()).slice(0, 10);
  for (const item of items) {
    const svc = db.get('SELECT * FROM services WHERE id = ?', item.service_id);
    if (!svc || !(svc.warranty_months > 0 || svc.maintenance_months > 0)) continue;
    db.run(
      `INSERT INTO vehicle_protections (vehicle_id, booking_id, service_id, name, category, applied_at, warranty_months, warranty_until, maintenance_months, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.vehicle_id,
      b.id,
      svc.id,
      item.name,
      svc.category || 'other',
      applied,
      svc.warranty_months || null,
      svc.warranty_months > 0 ? addMonths(applied, svc.warranty_months) : null,
      svc.maintenance_months || null,
      now(),
    );
  }
}

/** Add computed warranty / maintenance status to a protection record. */
function describeProtection(p, lastVisit, t = today()) {
  const active = !p.warranty_until || p.warranty_until >= t;
  let next = null;
  if (p.maintenance_months > 0) {
    const visit = lastVisit ? lastVisit.slice(0, 10) : null;
    next = addMonths(visit && visit > p.applied_at ? visit : p.applied_at, p.maintenance_months);
  }
  const maintenanceStatus = !next || !active ? null : next < t ? 'overdue' : next <= addDays(t, 14) ? 'due_soon' : 'ok';
  const warrantyStatus = !p.warranty_until ? null : p.warranty_until < t ? 'expired' : p.warranty_until <= addDays(t, 30) ? 'expiring' : 'active';
  return { ...p, active, next_maintenance_at: active ? next : null, maintenance_status: maintenanceStatus, warranty_status: warrantyStatus };
}

/** Map of vehicle id -> its protections (with status), newest first. */
function protectionsByVehicle(db, vehicleIds) {
  const map = new Map(vehicleIds.map((id) => [id, []]));
  if (!vehicleIds.length) return map;
  const ph = vehicleIds.map(() => '?').join(',');
  const lastVisits = Object.fromEntries(
    db.all(`SELECT vehicle_id, MAX(completed_at) AS d FROM bookings WHERE status = 'completed' AND vehicle_id IN (${ph}) GROUP BY vehicle_id`, ...vehicleIds).map((r) => [r.vehicle_id, r.d]),
  );
  for (const p of db.all(`SELECT * FROM vehicle_protections WHERE vehicle_id IN (${ph}) ORDER BY applied_at DESC, id DESC`, ...vehicleIds)) {
    map.get(p.vehicle_id).push(describeProtection(p, lastVisits[p.vehicle_id]));
  }
  return map;
}

/** Protections that need a maintenance visit soon (or are overdue) or whose warranty is about to expire. */
function followUps(db) {
  const rows = db.all(
    `SELECT p.*, v.plate, v.make, v.model, v.year, v.color, v.type, v.owner_id,
            u.name AS owner_name, u.phone AS owner_phone, u.email AS owner_email,
            (SELECT MAX(completed_at) FROM bookings b WHERE b.vehicle_id = p.vehicle_id AND b.status = 'completed') AS last_visit,
            (SELECT COUNT(*) FROM bookings b WHERE b.vehicle_id = p.vehicle_id AND b.status IN ('pending', 'confirmed', 'in_progress')) AS active_bookings
       FROM vehicle_protections p
       JOIN vehicles v ON v.id = p.vehicle_id
       LEFT JOIN users u ON u.id = v.owner_id`,
  );
  return rows
    .map((r) => describeProtection(r, r.last_visit))
    .filter((p) => p.maintenance_status === 'overdue' || p.maintenance_status === 'due_soon' || p.warranty_status === 'expiring')
    .map((p) => {
      const maintenance = p.maintenance_status === 'overdue' || p.maintenance_status === 'due_soon';
      return { ...p, reason: maintenance ? 'maintenance' : 'warranty', due_at: maintenance ? p.next_maintenance_at : p.warranty_until };
    })
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
}

function protectionInput(body, current = {}) {
  const name = body.name !== undefined ? str(body.name, 120) : current.name;
  if (!name) throw new HttpError(400, 'Please give the protection a name, e.g. "Ceramic Coating – 3 Years".');
  const category = body.category !== undefined ? String(body.category) : current.category || 'other';
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category.');
  const applied = body.applied_at !== undefined ? String(body.applied_at || '') : current.applied_at || today();
  if (!isValidDate(applied)) throw new HttpError(400, 'Please enter the date it was applied.');
  const months = (key) => {
    if (body[key] === undefined) return current[key] ?? null;
    const n = int(body[key]);
    if (n !== null && (n < 0 || n > 600)) throw new HttpError(400, 'Months must be between 0 and 600.');
    return n || null;
  };
  const warranty = months('warranty_months');
  const maintenance = months('maintenance_months');
  return {
    name,
    category,
    applied_at: applied,
    warranty_months: warranty,
    warranty_until: warranty ? addMonths(applied, warranty) : null,
    maintenance_months: maintenance,
    details: body.details !== undefined ? str(body.details, 1000) : current.details ?? null,
  };
}

/** Change the status of a booking, keeping timestamps, loyalty points and warranties consistent. */
function changeStatus(db, booking, next, { actorName, note, enforceTransitions = true } = {}) {
  if (!STATUSES.includes(next)) throw new HttpError(400, 'Unknown status.');
  if (next === booking.status) return;
  if (enforceTransitions && !TRANSITIONS[booking.status].includes(next)) {
    throw new HttpError(400, `Cannot change a ${booking.status.replace('_', ' ')} booking to ${next.replace('_', ' ')}.`);
  }
  const ts = now();
  db.tx(() => {
    const sets = ['status = ?'];
    const vals = [next];
    if (next === 'in_progress') sets.push('started_at = COALESCE(started_at, ?)'), vals.push(ts);
    if (next === 'completed') {
      sets.push('completed_at = ?');
      vals.push(ts);
      if (booking.customer_id) {
        const s = db.getSettings();
        const earned = Math.floor(booking.total * Number(s.points_per_unit || 0));
        if (earned > 0) {
          sets.push('points_earned = ?');
          vals.push(earned);
          db.run('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?', earned, booking.customer_id);
        }
      }
    }
    if (next === 'cancelled' || next === 'no_show') {
      if (next === 'cancelled') sets.push('cancelled_at = ?'), vals.push(ts);
      if (booking.points_redeemed && booking.customer_id) {
        db.run('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?', booking.points_redeemed, booking.customer_id);
        sets.push('points_redeemed = 0');
      }
    }
    db.run(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`, ...vals, booking.id);
    if (next === 'completed') recordProtections(db, booking.id, ts);
    addEvent(db, booking.id, next, note, actorName);
  });
}

// =====================================================================
// Manual pricing and discounts (staff)
// =====================================================================

/**
 * Change the prices on a bill: the package price, the extra items (existing
 * ones can be re-priced or removed, catalog add-ons or custom items added),
 * the size surcharge and a staff discount. Loyalty points already redeemed
 * stay applied; points earned on a completed job are adjusted.
 */
function repriceBooking(db, booking, body, actorName) {
  const settings = db.getSettings();
  if (['cancelled', 'no_show'].includes(booking.status)) throw new HttpError(400, 'Cancelled bookings cannot be re-priced.');
  const vehicle = db.get('SELECT type FROM vehicles WHERE id = ?', booking.vehicle_id);
  const current = db.all('SELECT * FROM booking_addons WHERE booking_id = ?', booking.id);
  const servicePrice = body.service_price === undefined ? booking.service_price : priceValue(body.service_price, 'Package price');

  const items = Array.isArray(body.items) ? body.items : current.map((a) => ({ id: a.id, price: a.price }));
  if (items.length > 30) throw new HttpError(400, 'Too many items on one bill.');
  const keep = [];
  const add = [];
  for (const it of items) {
    const price = priceValue(it.price, 'Item price');
    if (it.id) {
      const row = current.find((a) => a.id === int(it.id));
      if (!row) throw new HttpError(400, 'One of the items does not belong to this booking.');
      keep.push({ id: row.id, name: row.service_id ? row.name : str(it.name, 80) || row.name, price });
    } else if (it.service_id) {
      const svc = db.get("SELECT * FROM services WHERE id = ? AND kind = 'addon'", int(it.service_id));
      if (!svc) throw new HttpError(400, 'Unknown extra.');
      add.push({ service_id: svc.id, name: svc.name, price });
    } else {
      const name = str(it.name, 80);
      if (!name) throw new HttpError(400, 'Please give each custom item a name.');
      add.push({ service_id: null, name, price });
    }
  }

  const discountType = body.discount_type || (body.discount_value === undefined ? booking.discount_type : 'amount') || 'amount';
  const discountValue = body.discount_value === undefined ? (booking.discount_value || booking.manual_discount) : body.discount_value;
  const applySurcharge = body.apply_surcharge === undefined ? booking.surcharge > 0 || !LARGE_TYPES.has(vehicle.type) : Boolean(body.apply_surcharge);
  const subtotal = servicePrice + [...keep, ...add].reduce((sum, a) => sum + a.price, 0);
  const t = computeTotals(settings, {
    subtotal,
    vehicleType: vehicle.type,
    applySurcharge,
    discountType,
    discountValue,
    fixedPointsDiscount: round2(booking.discount - booking.manual_discount),
  });
  const reason = t.manualDiscount ? str(body.discount_reason, 200) ?? booking.discount_reason : null;

  db.tx(() => {
    for (const a of current) if (!keep.some((k) => k.id === a.id)) db.run('DELETE FROM booking_addons WHERE id = ?', a.id);
    for (const k of keep) db.run('UPDATE booking_addons SET name = ?, price = ? WHERE id = ?', k.name, k.price, k.id);
    for (const a of add) db.run('INSERT INTO booking_addons (booking_id, service_id, name, price) VALUES (?, ?, ?, ?)', booking.id, a.service_id, a.name, a.price);
    db.run(
      `UPDATE bookings SET service_price = ?, subtotal = ?, surcharge = ?, discount = ?, manual_discount = ?, discount_type = ?, discount_value = ?, discount_reason = ?, tax = ?, total = ? WHERE id = ?`,
      servicePrice,
      t.subtotal,
      t.surcharge,
      t.discount,
      t.manualDiscount,
      t.manualDiscount ? discountType : 'amount',
      t.manualDiscount ? Number(discountValue) : 0,
      reason,
      t.tax,
      t.total,
      booking.id,
    );
    if (booking.status === 'completed' && booking.customer_id) {
      const earned = Math.floor(t.total * Number(settings.points_per_unit || 0));
      const diff = earned - booking.points_earned;
      if (diff) {
        db.run('UPDATE users SET loyalty_points = MAX(0, loyalty_points + ?) WHERE id = ?', diff, booking.customer_id);
        db.run('UPDATE bookings SET points_earned = ? WHERE id = ?', earned, booking.id);
      }
    }
    if (Math.abs(t.total - booking.total) > 0.004 || t.manualDiscount !== booking.manual_discount) {
      const disc = t.manualDiscount ? ` · discount ${moneyText(settings, t.manualDiscount)}${reason ? ` (${reason})` : ''}` : '';
      addEvent(db, booking.id, booking.status, `Price updated: ${moneyText(settings, booking.total)} → ${moneyText(settings, t.total)}${disc}`, actorName);
    }
    recalcPayments(db, booking.id);
  });
}

// =====================================================================
// Payments (split / partial payments, several methods, refunds)
// =====================================================================

function resolveMethod(settings, method) {
  const list = Array.isArray(settings.payment_methods) ? settings.payment_methods : [];
  const found = list.find((m) => m.toLowerCase() === String(method || '').trim().toLowerCase());
  if (!found) throw new HttpError(400, `Unknown payment method. Use one of: ${list.join(', ')}.`);
  return found;
}

/** Recompute amount paid, payment status and the method summary for a booking. */
function recalcPayments(db, bookingId) {
  const b = db.get('SELECT total FROM bookings WHERE id = ?', bookingId);
  const rows = db.all('SELECT amount, method FROM payments WHERE booking_id = ? ORDER BY id', bookingId);
  const paid = round2(rows.reduce((s, r) => s + r.amount, 0));
  const methods = [...new Set(rows.filter((r) => r.amount > 0).map((r) => r.method))];
  let status;
  if (paid <= 0.004) status = rows.some((r) => r.amount < 0) ? 'refunded' : b.total <= 0.004 ? 'paid' : 'unpaid';
  else status = paid + 0.004 < b.total ? 'partial' : 'paid';
  db.run('UPDATE bookings SET amount_paid = ?, payment_status = ?, payment_method = ? WHERE id = ?', paid, status, methods.join(' + ') || null, bookingId);
  return { paid, status };
}

/**
 * Record one or more payments at once, e.g. [{ method: 'Cash', amount: 500 }, { method: 'JazzCash', amount: 200 }].
 * A negative amount is a refund.
 */
function addPayments(db, booking, list, actorName) {
  const settings = db.getSettings();
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Please enter at least one payment.');
  if (list.length > 10) throw new HttpError(400, 'Too many payments at once.');
  if (['cancelled', 'no_show'].includes(booking.status) && list.some((p) => Number(p.amount) > 0)) {
    throw new HttpError(400, 'This booking was cancelled — you can only record refunds.');
  }
  const rows = list.map((p) => {
    const amount = round2(Number(p.amount));
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_PRICE) throw new HttpError(400, 'Each payment needs an amount.');
    return { amount, method: resolveMethod(settings, p.method), reference: str(p.reference, 80), note: str(p.note, 200) };
  });
  const after = round2(booking.amount_paid + rows.reduce((s, r) => s + r.amount, 0));
  if (after > booking.total + 0.004) {
    throw new HttpError(400, `That is more than the balance due (${moneyText(settings, Math.max(0, booking.total - booking.amount_paid))}).`);
  }
  if (after < -0.004) throw new HttpError(400, 'You cannot refund more than has been paid.');
  return db.tx(() => {
    const ts = now();
    for (const r of rows) {
      db.run('INSERT INTO payments (booking_id, amount, method, reference, note, received_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', booking.id, r.amount, r.method, r.reference, r.note, actorName || null, ts);
    }
    const res = recalcPayments(db, booking.id);
    const text = rows.map((r) => `${moneyText(settings, Math.abs(r.amount))} ${r.method}`).join(' + ');
    addEvent(db, booking.id, db.get('SELECT status FROM bookings WHERE id = ?', booking.id).status, `${rows[0].amount < 0 ? 'Refund' : 'Payment'}: ${text}`, actorName);
    return res;
  });
}

function deletePayment(db, paymentId, actorName) {
  const p = db.get('SELECT * FROM payments WHERE id = ?', int(paymentId));
  if (!p) throw new HttpError(404, 'Payment not found.');
  const settings = db.getSettings();
  db.tx(() => {
    db.run('DELETE FROM payments WHERE id = ?', p.id);
    recalcPayments(db, p.booking_id);
    addEvent(db, p.booking_id, db.get('SELECT status FROM bookings WHERE id = ?', p.booking_id).status, `Payment removed: ${moneyText(settings, p.amount)} ${p.method}`, actorName);
  });
  return p;
}

/** Full booking record with add-ons, staff, vehicle, timeline and estimated ready time. */
function bookingDetail(db, id) {
  const b = db.get(
    `SELECT b.*, v.plate, v.make, v.model, v.color, v.type AS vehicle_type, v.year,
            u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
            st.name AS staff_name
       FROM bookings b
       JOIN vehicles v ON v.id = b.vehicle_id
       LEFT JOIN users u ON u.id = b.customer_id
       LEFT JOIN staff st ON st.id = b.staff_id
      WHERE b.id = ?`,
    id,
  );
  if (!b) return null;
  b.addons = db.all('SELECT id, service_id, name, price FROM booking_addons WHERE booking_id = ? ORDER BY id', id);
  b.events = db.all('SELECT status, note, actor_name, created_at FROM booking_events WHERE booking_id = ? ORDER BY id', id);
  b.ready_at = readyAt(db.getSettings(), b.scheduled_at, b.duration_min);
  b.payments = db.all('SELECT id, amount, method, reference, note, received_by, created_at FROM payments WHERE booking_id = ? ORDER BY id', id);
  // Negative balance = refund due (price lowered after paying, or a cancelled job that was paid for).
  b.balance = ['cancelled', 'no_show'].includes(b.status) ? round2(-b.amount_paid) : round2(b.total - b.amount_paid);
  return b;
}

/** Attach add-on names (and the estimated ready time) to a list of bookings. */
function withAddons(db, bookings) {
  if (!bookings.length) return bookings;
  const ids = bookings.map((b) => b.id);
  const rows = db.all(`SELECT booking_id, name, price FROM booking_addons WHERE booking_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push({ name: r.name, price: r.price });
  }
  const settings = db.getSettings();
  for (const b of bookings) {
    b.addons = map.get(b.id) || [];
    if (b.scheduled_at && b.duration_min) b.ready_at = readyAt(settings, b.scheduled_at, b.duration_min);
  }
  return bookings;
}

/** Complete service history, protections and stats for one vehicle. */
function vehicleHistory(db, vehicleId) {
  const vehicle = db.get(
    `SELECT v.*, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
       FROM vehicles v LEFT JOIN users u ON u.id = v.owner_id WHERE v.id = ?`,
    vehicleId,
  );
  if (!vehicle) return null;
  const bookings = withAddons(
    db,
    db.all(
      `SELECT b.*, st.name AS staff_name, u.name AS customer_name
         FROM bookings b
         LEFT JOIN staff st ON st.id = b.staff_id
         LEFT JOIN users u ON u.id = b.customer_id
        WHERE b.vehicle_id = ?
        ORDER BY b.scheduled_at DESC, b.id DESC`,
      vehicleId,
    ),
  );
  const events = db.all(
    `SELECT e.booking_id, e.status, e.note, e.actor_name, e.created_at FROM booking_events e
       JOIN bookings b ON b.id = e.booking_id WHERE b.vehicle_id = ? ORDER BY e.id`,
    vehicleId,
  );
  const eventsByBooking = new Map();
  for (const e of events) {
    if (!eventsByBooking.has(e.booking_id)) eventsByBooking.set(e.booking_id, []);
    eventsByBooking.get(e.booking_id).push(e);
  }
  for (const b of bookings) b.events = eventsByBooking.get(b.id) || [];

  const completed = bookings.filter((b) => b.status === 'completed').sort((a, b) => (a.completed_at || a.scheduled_at).localeCompare(b.completed_at || b.scheduled_at));
  const serviceCounts = {};
  for (const b of completed) serviceCounts[b.service_name] = (serviceCounts[b.service_name] || 0) + 1;
  const favourite = Object.entries(serviceCounts).sort((a, b) => b[1] - a[1])[0];
  let avgDaysBetween = null;
  if (completed.length > 1) {
    const first = new Date(completed[0].scheduled_at.replace(' ', 'T'));
    const last = new Date(completed[completed.length - 1].scheduled_at.replace(' ', 'T'));
    avgDaysBetween = Math.round((last - first) / 86400000 / (completed.length - 1));
  }
  const rated = completed.filter((b) => b.rating);
  const withMileage = bookings.filter((b) => b.mileage);
  const stats = {
    total_bookings: bookings.length,
    completed_washes: completed.length,
    cancelled: bookings.filter((b) => b.status === 'cancelled').length,
    no_shows: bookings.filter((b) => b.status === 'no_show').length,
    total_spent: round2(completed.reduce((s, b) => s + b.total, 0)),
    average_ticket: completed.length ? round2(completed.reduce((s, b) => s + b.total, 0) / completed.length) : 0,
    first_visit: completed[0]?.scheduled_at || null,
    last_visit: completed[completed.length - 1]?.scheduled_at || null,
    avg_days_between: avgDaysBetween,
    favourite_service: favourite ? favourite[0] : null,
    average_rating: rated.length ? round2(rated.reduce((s, b) => s + b.rating, 0) / rated.length) : null,
    last_mileage: withMileage.length ? withMileage[0].mileage : null,
    next_booking: bookings.filter((b) => ACTIVE_STATUSES.includes(b.status)).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0] || null,
  };
  const notes = db.all('SELECT * FROM vehicle_notes WHERE vehicle_id = ? ORDER BY id DESC', vehicleId);
  const protections = protectionsByVehicle(db, [vehicle.id]).get(vehicle.id);
  return { vehicle, stats, bookings, notes, protections };
}

module.exports = {
  HttpError,
  VEHICLE_TYPES,
  STATUSES,
  ACTIVE_STATUSES,
  CATEGORIES,
  TRANSITIONS,
  normalizePlate,
  vehicleInput,
  quote,
  availability,
  assertSlotBookable,
  readyAt,
  workSpans,
  hoursOf,
  createBooking,
  computeTotals,
  repriceBooking,
  addPayments,
  deletePayment,
  recalcPayments,
  resolveMethod,
  DISCOUNT_TYPES,
  changeStatus,
  recordProtections,
  describeProtection,
  protectionsByVehicle,
  protectionInput,
  followUps,
  bookingDetail,
  withAddons,
  vehicleHistory,
  addEvent,
  isValidDate,
  addDays,
  addMonths,
  round2,
  str,
  int,
};
