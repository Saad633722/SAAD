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
const PAYMENT_METHODS = ['cash', 'card', 'mobile', 'other'];

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
  return 'CW-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
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

/** Work out the price for a booking. */
function quote(db, { serviceId, addonIds = [], vehicleType = 'sedan', redeemPoints = false, availablePoints = 0, extraDiscount = 0 }) {
  const settings = db.getSettings();
  const service = db.get("SELECT * FROM services WHERE id = ? AND kind = 'package'", int(serviceId));
  if (!service) throw new HttpError(400, 'Please choose a wash package.');
  if (!service.active) throw new HttpError(400, 'That package is no longer available.');

  const ids = [...new Set((Array.isArray(addonIds) ? addonIds : [addonIds]).map(int).filter(Boolean))];
  const addons = ids.map((id) => {
    const a = db.get("SELECT * FROM services WHERE id = ? AND kind = 'addon' AND active = 1", id);
    if (!a) throw new HttpError(400, 'One of the selected extras is not available.');
    return a;
  });

  const subtotal = round2(service.price + addons.reduce((s, a) => s + a.price, 0));
  const surcharge = LARGE_TYPES.has(vehicleType) ? round2((subtotal * Number(settings.large_vehicle_surcharge || 0)) / 100) : 0;
  const gross = subtotal + surcharge;

  let discount = 0;
  let pointsRedeemed = 0;
  const rewardPoints = Number(settings.reward_points) || 0;
  const rewardValue = Number(settings.reward_value) || 0;
  if (redeemPoints && rewardPoints > 0 && rewardValue > 0) {
    const maxBlocks = Math.floor(availablePoints / rewardPoints);
    const neededBlocks = Math.ceil(gross / rewardValue);
    const blocks = Math.min(maxBlocks, neededBlocks);
    discount = Math.min(blocks * rewardValue, gross);
    pointsRedeemed = blocks * rewardPoints;
  }
  discount = round2(Math.min(gross, discount + Math.max(0, Number(extraDiscount) || 0)));

  const taxable = Math.max(0, gross - discount);
  const tax = round2((taxable * Number(settings.tax_rate || 0)) / 100);
  const total = round2(taxable + tax);
  const duration = service.duration_min + addons.reduce((s, a) => s + a.duration_min, 0);

  return { service, addons, subtotal, surcharge, discount, tax, total, pointsRedeemed, duration };
}

/** List bookable time slots for a given date. */
function availability(db, date) {
  if (!isValidDate(date)) throw new HttpError(400, 'Invalid date.');
  const s = db.getSettings();
  const day = new Date(`${date}T00:00:00`).getDay();
  const openDays = Array.isArray(s.open_days) ? s.open_days.map(Number) : [];
  if (!openDays.includes(day)) return { date, open: false, slots: [] };

  const open = toMinutes(s.open_time);
  const close = toMinutes(s.close_time);
  const step = Math.max(10, Number(s.slot_minutes) || 30);
  const bays = Math.max(1, Number(s.bays) || 1);
  const rows = db.all(
    `SELECT substr(scheduled_at, 12, 5) AS t, COUNT(*) AS c FROM bookings
      WHERE substr(scheduled_at, 1, 10) = ? AND status NOT IN ('cancelled', 'no_show')
      GROUP BY t`,
    date,
  );
  const taken = Object.fromEntries(rows.map((r) => [r.t, r.c]));
  const nowStr = now().slice(0, 16);
  const slots = [];
  for (let m = open; m + step <= close; m += step) {
    const time = fromMinutes(m);
    const at = `${date} ${time}`;
    const remaining = bays - (taken[time] || 0);
    slots.push({ time, remaining: Math.max(0, remaining), available: remaining > 0 && at > nowStr });
  }
  return { date, open: true, slots };
}

function assertSlotBookable(db, scheduledAt) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(scheduledAt || '');
  if (!m) throw new HttpError(400, 'Please choose a date and time.');
  const [, date, time] = m;
  if (`${date} ${time}` <= now().slice(0, 16)) throw new HttpError(400, 'That time has already passed. Please pick a later slot.');
  const s = db.getSettings();
  const last = new Date();
  last.setDate(last.getDate() + Number(s.booking_window_days || 30));
  if (date > today(last)) throw new HttpError(400, `Bookings can only be made up to ${s.booking_window_days} days ahead.`);
  const { slots, open } = availability(db, date);
  if (!open) throw new HttpError(400, 'We are closed on that day.');
  const slot = slots.find((x) => x.time === time);
  if (!slot) throw new HttpError(400, 'That time is outside our opening hours.');
  if (!slot.available) throw new HttpError(409, 'Sorry, that time slot is no longer available.');
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
 * Create a booking (inside a transaction). Caller is responsible for
 * validating the vehicle and the slot.
 */
function createBooking(db, { vehicle, customerId, serviceId, addonIds, scheduledAt, redeemPoints, customerNotes, adminNotes, source, status, staffId, bay, actorName, extraDiscount }) {
  return db.tx(() => {
    let availablePoints = 0;
    if (customerId) {
      const c = db.get('SELECT loyalty_points FROM users WHERE id = ?', customerId);
      availablePoints = c ? c.loyalty_points : 0;
    }
    const q = quote(db, { serviceId, addonIds, vehicleType: vehicle.type, redeemPoints: Boolean(redeemPoints) && Boolean(customerId), availablePoints, extraDiscount });
    let code = makeCode();
    while (db.get('SELECT 1 FROM bookings WHERE code = ?', code)) code = makeCode();
    const initial = status || 'pending';
    const ts = now();
    const { id } = db.run(
      `INSERT INTO bookings (code, vehicle_id, customer_id, service_id, service_name, service_price, duration_min, scheduled_at, status,
         bay, staff_id, subtotal, surcharge, discount, tax, total, points_redeemed, customer_notes, admin_notes, source, created_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      vehicle.id,
      customerId || null,
      q.service.id,
      q.service.name,
      q.service.price,
      q.duration,
      scheduledAt,
      initial,
      int(bay),
      int(staffId),
      q.subtotal,
      q.surcharge,
      q.discount,
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
    return id;
  });
}

/** Change the status of a booking, keeping timestamps and loyalty points consistent. */
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
    addEvent(db, booking.id, next, note, actorName);
  });
}

/** Full booking record with add-ons, staff, vehicle and timeline. */
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
  return b;
}

/** Attach add-on names to a list of bookings (single query). */
function withAddons(db, bookings) {
  if (!bookings.length) return bookings;
  const ids = bookings.map((b) => b.id);
  const rows = db.all(`SELECT booking_id, name, price FROM booking_addons WHERE booking_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push({ name: r.name, price: r.price });
  }
  for (const b of bookings) b.addons = map.get(b.id) || [];
  return bookings;
}

/** Complete wash history + stats for one vehicle. */
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
  return { vehicle, stats, bookings, notes };
}

module.exports = {
  HttpError,
  VEHICLE_TYPES,
  STATUSES,
  ACTIVE_STATUSES,
  PAYMENT_METHODS,
  TRANSITIONS,
  normalizePlate,
  vehicleInput,
  quote,
  availability,
  assertSlotBookable,
  createBooking,
  changeStatus,
  bookingDetail,
  withAddons,
  vehicleHistory,
  addEvent,
  isValidDate,
  round2,
  str,
  int,
};
