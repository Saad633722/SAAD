'use strict';

const express = require('express');
const { hashPassword, verifyPassword } = require('../auth');
const B = require('../bookings');
const { now, today, DEFAULT_SETTINGS } = require('../db');

const { HttpError, str, int, round2 } = B;

function dateRange(query) {
  const to = B.isValidDate(query.to) ? query.to : today();
  let from = query.from;
  if (!B.isValidDate(from)) {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    from = today(d);
  }
  if (from > to) throw new HttpError(400, '"From" date must be before "to" date.');
  return { from, to };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = function adminRoutes(db) {
  const r = express.Router();

  const getBooking = (id) => {
    const b = db.get('SELECT * FROM bookings WHERE id = ?', int(id));
    if (!b) throw new HttpError(404, 'Booking not found.');
    return b;
  };
  const getVehicle = (id) => {
    const v = db.get('SELECT * FROM vehicles WHERE id = ?', int(id));
    if (!v) throw new HttpError(404, 'Vehicle not found.');
    return v;
  };

  // ---------- Dashboard ----------
  r.get('/stats', (_req, res) => {
    const t = today();
    const month = t.slice(0, 7);
    const todayCounts = db.get(
      `SELECT COUNT(*) AS total,
              SUM(status IN ('pending','confirmed')) AS waiting,
              SUM(status = 'in_progress') AS in_progress,
              SUM(status = 'completed') AS completed,
              SUM(status IN ('cancelled','no_show')) AS cancelled
         FROM bookings WHERE substr(scheduled_at, 1, 10) = ?`,
      t,
    );
    const revenueToday = db.get("SELECT COALESCE(SUM(total), 0) AS v FROM bookings WHERE status = 'completed' AND substr(completed_at, 1, 10) = ?", t).v;
    const revenueMonth = db.get("SELECT COALESCE(SUM(total), 0) AS v FROM bookings WHERE status = 'completed' AND substr(completed_at, 1, 7) = ?", month).v;
    const unpaid = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS v FROM bookings WHERE status = 'completed' AND payment_status = 'unpaid'");
    const totals = db.get(
      `SELECT (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers,
              (SELECT COUNT(*) FROM vehicles) AS vehicles,
              (SELECT COUNT(*) FROM bookings WHERE status = 'completed') AS washes,
              (SELECT ROUND(AVG(rating), 2) FROM bookings WHERE rating IS NOT NULL) AS avg_rating,
              (SELECT COUNT(*) FROM bookings WHERE status = 'pending') AS pending_total`,
    );

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(today(d));
    }
    const revRows = db.all(
      `SELECT substr(completed_at, 1, 10) AS day, SUM(total) AS revenue, COUNT(*) AS washes
         FROM bookings WHERE status = 'completed' AND substr(completed_at, 1, 10) >= ? GROUP BY day`,
      days[0],
    );
    const revMap = Object.fromEntries(revRows.map((x) => [x.day, x]));
    const revenue_14d = days.map((day) => ({ day, revenue: round2(revMap[day]?.revenue || 0), washes: revMap[day]?.washes || 0 }));

    const since = new Date();
    since.setDate(since.getDate() - 30);
    const top_services = db.all(
      `SELECT service_name AS name, COUNT(*) AS count, ROUND(SUM(total), 2) AS revenue
         FROM bookings WHERE status = 'completed' AND completed_at >= ? GROUP BY service_name ORDER BY count DESC LIMIT 5`,
      now(since),
    );
    const queue = B.withAddons(
      db,
      db.all(
        `SELECT b.id, b.code, b.status, b.scheduled_at, b.duration_min, b.bay, b.total, b.service_name, b.service_category, b.payment_status, b.source,
                v.id AS vehicle_id, v.plate, v.make, v.model, v.color, u.name AS customer_name, st.name AS staff_name
           FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
           LEFT JOIN users u ON u.id = b.customer_id LEFT JOIN staff st ON st.id = b.staff_id
          WHERE (substr(b.scheduled_at, 1, 10) = ? AND b.status NOT IN ('cancelled'))
             OR b.status = 'in_progress'
          ORDER BY CASE b.status WHEN 'in_progress' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, b.scheduled_at`,
        t,
      ),
    );
    const recent_feedback = db.all(
      `SELECT b.id, b.code, b.rating, b.feedback, b.completed_at, v.plate, u.name AS customer_name
         FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN users u ON u.id = b.customer_id
        WHERE b.rating IS NOT NULL ORDER BY b.completed_at DESC LIMIT 5`,
    );

    res.json({
      today: { ...todayCounts, revenue: round2(revenueToday) },
      month: { revenue: round2(revenueMonth) },
      unpaid: { count: unpaid.c, amount: round2(unpaid.v) },
      totals,
      revenue_14d,
      top_services,
      queue,
      recent_feedback,
      followups: B.followUps(db),
    });
  });

  // ---------- Bookings ----------
  r.get('/bookings', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      if (req.query.status === 'active') where.push("b.status IN ('pending','confirmed','in_progress')");
      else (where.push('b.status = ?'), params.push(String(req.query.status)));
    }
    if (B.isValidDate(req.query.from)) where.push('substr(b.scheduled_at, 1, 10) >= ?'), params.push(req.query.from);
    if (B.isValidDate(req.query.to)) where.push('substr(b.scheduled_at, 1, 10) <= ?'), params.push(req.query.to);
    if (req.query.payment) where.push('b.payment_status = ?'), params.push(String(req.query.payment));
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      const plateQ = `%${B.normalizePlate(req.query.q)}%`;
      where.push('(b.code LIKE ? OR v.plate LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR v.make LIKE ? OR v.model LIKE ?)');
      params.push(q, plateQ, q, q, q, q, q);
    }
    const limit = Math.min(500, int(req.query.limit) || 200);
    const rows = db.all(
      `SELECT b.*, v.plate, v.make, v.model, v.color, v.type AS vehicle_type,
              u.name AS customer_name, u.phone AS customer_phone, st.name AS staff_name
         FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
         LEFT JOIN users u ON u.id = b.customer_id LEFT JOIN staff st ON st.id = b.staff_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY b.scheduled_at DESC, b.id DESC LIMIT ${limit}`,
      ...params,
    );
    res.json({ bookings: B.withAddons(db, rows) });
  });

  r.get('/bookings/:id', (req, res) => {
    const b = B.bookingDetail(db, getBooking(req.params.id).id);
    res.json({ booking: b, transitions: B.TRANSITIONS[b.status] });
  });

  /** Walk-in / phone booking created by staff. Creates the vehicle (and optionally the customer) on the fly. */
  r.post('/bookings', (req, res) => {
    const body = req.body;
    let vehicle;
    if (body.vehicle_id) {
      vehicle = getVehicle(body.vehicle_id);
    } else {
      const v = B.vehicleInput(body.vehicle || {});
      vehicle = db.get('SELECT * FROM vehicles WHERE plate = ?', v.plate);
      if (!vehicle) {
        const { id } = db.run(
          'INSERT INTO vehicles (owner_id, plate, make, model, year, color, type, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          int(body.customer_id),
          v.plate,
          v.make,
          v.model,
          v.year,
          v.color,
          v.type,
          v.notes,
          now(),
        );
        vehicle = getVehicle(id);
      }
    }
    let customerId = int(body.customer_id) || vehicle.owner_id || null;
    if (customerId && !db.get("SELECT 1 FROM users WHERE id = ? AND role = 'customer'", customerId)) throw new HttpError(400, 'Customer not found.');
    if (!vehicle.owner_id && customerId) db.run('UPDATE vehicles SET owner_id = ? WHERE id = ?', customerId, vehicle.id);

    const clash = db.get(`SELECT code FROM bookings WHERE vehicle_id = ? AND status IN ('pending','confirmed','in_progress')`, vehicle.id);
    if (clash) throw new HttpError(409, `${vehicle.plate} already has an active booking (${clash.code}).`);

    let scheduledAt;
    if (body.start_now || !body.scheduled_at) {
      scheduledAt = now().slice(0, 16);
    } else {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(body.scheduled_at);
      if (!m) throw new HttpError(400, 'Invalid date/time.');
      scheduledAt = `${m[1]} ${m[2]}`;
    }
    const id = B.createBooking(db, {
      vehicle,
      customerId,
      serviceId: body.service_id,
      addonIds: body.addon_ids || [],
      scheduledAt,
      redeemPoints: body.redeem_points,
      customerNotes: body.customer_notes,
      adminNotes: body.admin_notes,
      source: 'walk_in',
      status: body.start_now ? 'in_progress' : 'confirmed',
      staffId: body.staff_id,
      bay: body.bay,
      actorName: req.user.name,
      extraDiscount: body.discount,
    });
    if (int(body.mileage)) db.run('UPDATE bookings SET mileage = ? WHERE id = ?', int(body.mileage), id);
    res.status(201).json({ booking: B.bookingDetail(db, id) });
  });

  r.patch('/bookings/:id', (req, res) => {
    const b = getBooking(req.params.id);
    const body = req.body;
    if (body.status && body.status !== b.status) {
      B.changeStatus(db, b, body.status, { actorName: req.user.name, note: str(body.status_note, 300) });
    }
    const sets = [];
    const vals = [];
    const changes = [];
    if (body.staff_id !== undefined) {
      const staffId = int(body.staff_id);
      if (staffId && !db.get('SELECT 1 FROM staff WHERE id = ?', staffId)) throw new HttpError(400, 'Staff member not found.');
      sets.push('staff_id = ?'), vals.push(staffId);
      if (staffId !== b.staff_id) changes.push(staffId ? `Assigned to ${db.get('SELECT name FROM staff WHERE id = ?', staffId).name}` : 'Staff unassigned');
    }
    if (body.bay !== undefined) {
      sets.push('bay = ?'), vals.push(int(body.bay));
      if (int(body.bay) !== b.bay) changes.push(int(body.bay) ? `Moved to bay ${int(body.bay)}` : 'Bay cleared');
    }
    if (body.admin_notes !== undefined) sets.push('admin_notes = ?'), vals.push(str(body.admin_notes, 2000));
    if (body.mileage !== undefined) sets.push('mileage = ?'), vals.push(int(body.mileage));
    if (body.payment_status !== undefined) {
      if (!['unpaid', 'paid', 'refunded'].includes(body.payment_status)) throw new HttpError(400, 'Invalid payment status.');
      sets.push('payment_status = ?'), vals.push(body.payment_status);
      if (body.payment_status !== b.payment_status) changes.push(`Payment marked ${body.payment_status}${body.payment_method ? ` (${body.payment_method})` : ''}`);
    }
    if (body.payment_method !== undefined) {
      if (body.payment_method && !B.PAYMENT_METHODS.includes(body.payment_method)) throw new HttpError(400, 'Invalid payment method.');
      sets.push('payment_method = ?'), vals.push(body.payment_method || null);
    }
    if (body.scheduled_at !== undefined && body.scheduled_at !== b.scheduled_at) {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(body.scheduled_at);
      if (!m) throw new HttpError(400, 'Invalid date/time.');
      sets.push('scheduled_at = ?'), vals.push(`${m[1]} ${m[2]}`);
      changes.push(`Rescheduled from ${b.scheduled_at} to ${m[1]} ${m[2]}`);
    }
    if (sets.length) {
      db.tx(() => {
        db.run(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`, ...vals, b.id);
        const current = db.get('SELECT status FROM bookings WHERE id = ?', b.id).status;
        for (const c of changes) B.addEvent(db, b.id, current, c, req.user.name);
      });
    }
    const detail = B.bookingDetail(db, b.id);
    res.json({ booking: detail, transitions: B.TRANSITIONS[detail.status] });
  });

  // ---------- Vehicles (with full history) ----------
  r.get('/vehicles', (req, res) => {
    const params = [];
    let where = '';
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      where = 'WHERE v.plate LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR u.name LIKE ? OR u.phone LIKE ? OR v.color LIKE ?';
      params.push(`%${B.normalizePlate(req.query.q)}%`, q, q, q, q, q);
    }
    const vehicles = db.all(
      `SELECT v.*, u.name AS owner_name, u.phone AS owner_phone,
              COUNT(CASE WHEN b.status = 'completed' THEN 1 END) AS washes,
              COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.total END), 0) AS total_spent,
              MAX(CASE WHEN b.status = 'completed' THEN b.scheduled_at END) AS last_wash,
              COUNT(CASE WHEN b.status IN ('pending','confirmed','in_progress') THEN 1 END) AS active_bookings,
              (SELECT GROUP_CONCAT(DISTINCT p.category) FROM vehicle_protections p
                WHERE p.vehicle_id = v.id AND (p.warranty_until IS NULL OR p.warranty_until >= ?)) AS protection_categories
         FROM vehicles v
         LEFT JOIN users u ON u.id = v.owner_id
         LEFT JOIN bookings b ON b.vehicle_id = v.id
         ${where}
        GROUP BY v.id
        ORDER BY last_wash IS NULL, last_wash DESC, v.id DESC
        LIMIT 500`,
      today(),
      ...params,
    );
    res.json({ vehicles });
  });

  r.get('/vehicles/:id', (req, res) => {
    const h = B.vehicleHistory(db, getVehicle(req.params.id).id);
    res.json(h);
  });

  r.post('/vehicles', (req, res) => {
    const v = B.vehicleInput(req.body);
    if (db.get('SELECT 1 FROM vehicles WHERE plate = ?', v.plate)) throw new HttpError(409, 'A vehicle with this plate already exists.');
    const ownerId = int(req.body.owner_id);
    if (ownerId && !db.get("SELECT 1 FROM users WHERE id = ? AND role = 'customer'", ownerId)) throw new HttpError(400, 'Customer not found.');
    const { id } = db.run(
      'INSERT INTO vehicles (owner_id, plate, make, model, year, color, type, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ownerId,
      v.plate,
      v.make,
      v.model,
      v.year,
      v.color,
      v.type,
      v.notes,
      now(),
    );
    res.status(201).json({ vehicle: getVehicle(id) });
  });

  r.patch('/vehicles/:id', (req, res) => {
    const current = getVehicle(req.params.id);
    const v = B.vehicleInput(req.body, { partial: true });
    if (v.plate && v.plate !== current.plate && db.get('SELECT 1 FROM vehicles WHERE plate = ? AND id <> ?', v.plate, current.id)) {
      throw new HttpError(409, 'Another vehicle already uses this plate.');
    }
    const merged = { ...current, ...v };
    if (req.body.owner_id !== undefined) {
      merged.owner_id = int(req.body.owner_id);
      if (merged.owner_id && !db.get("SELECT 1 FROM users WHERE id = ? AND role = 'customer'", merged.owner_id)) throw new HttpError(400, 'Customer not found.');
    }
    db.run(
      'UPDATE vehicles SET owner_id = ?, plate = ?, make = ?, model = ?, year = ?, color = ?, type = ?, notes = ? WHERE id = ?',
      merged.owner_id,
      merged.plate,
      merged.make,
      merged.model,
      merged.year,
      merged.color,
      merged.type,
      merged.notes,
      current.id,
    );
    res.json({ vehicle: getVehicle(current.id) });
  });

  r.delete('/vehicles/:id', (req, res) => {
    const v = getVehicle(req.params.id);
    if (db.get('SELECT 1 FROM bookings WHERE vehicle_id = ?', v.id)) {
      throw new HttpError(400, 'This vehicle has wash history and cannot be deleted. You can unlink it from its owner instead.');
    }
    db.run('DELETE FROM vehicles WHERE id = ?', v.id);
    res.json({ ok: true });
  });

  r.post('/vehicles/:id/notes', (req, res) => {
    const v = getVehicle(req.params.id);
    const note = str(req.body.note, 1000);
    if (!note) throw new HttpError(400, 'Note cannot be empty.');
    const kind = ['general', 'damage', 'preference', 'warning'].includes(req.body.kind) ? req.body.kind : 'general';
    const { id } = db.run('INSERT INTO vehicle_notes (vehicle_id, kind, note, author_name, created_at) VALUES (?, ?, ?, ?, ?)', v.id, kind, note, req.user.name, now());
    res.status(201).json({ note: db.get('SELECT * FROM vehicle_notes WHERE id = ?', id) });
  });

  r.delete('/vehicles/:id/notes/:noteId', (req, res) => {
    db.run('DELETE FROM vehicle_notes WHERE id = ? AND vehicle_id = ?', int(req.params.noteId), int(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Protections (ceramic coating / PPF warranties) ----------
  const protectionResponse = (vehicleId, id) => ({
    protection: B.protectionsByVehicle(db, [vehicleId]).get(vehicleId).find((p) => p.id === id),
  });

  r.post('/vehicles/:id/protections', (req, res) => {
    const v = getVehicle(req.params.id);
    const p = B.protectionInput(req.body);
    const { id } = db.run(
      `INSERT INTO vehicle_protections (vehicle_id, name, category, applied_at, warranty_months, warranty_until, maintenance_months, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.id,
      p.name,
      p.category,
      p.applied_at,
      p.warranty_months,
      p.warranty_until,
      p.maintenance_months,
      p.details,
      now(),
    );
    res.status(201).json(protectionResponse(v.id, id));
  });

  r.patch('/protections/:id', (req, res) => {
    const current = db.get('SELECT * FROM vehicle_protections WHERE id = ?', int(req.params.id));
    if (!current) throw new HttpError(404, 'Protection record not found.');
    const p = B.protectionInput(req.body, current);
    db.run(
      `UPDATE vehicle_protections SET name = ?, category = ?, applied_at = ?, warranty_months = ?, warranty_until = ?, maintenance_months = ?, details = ?
        WHERE id = ?`,
      p.name,
      p.category,
      p.applied_at,
      p.warranty_months,
      p.warranty_until,
      p.maintenance_months,
      p.details,
      current.id,
    );
    res.json(protectionResponse(current.vehicle_id, current.id));
  });

  r.delete('/protections/:id', (req, res) => {
    db.run('DELETE FROM vehicle_protections WHERE id = ?', int(req.params.id));
    res.json({ ok: true });
  });

  r.get('/followups', (_req, res) => {
    res.json({ followups: B.followUps(db) });
  });

  // ---------- Customers ----------
  r.get('/customers', (req, res) => {
    const params = [];
    let where = "WHERE u.role = 'customer'";
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      where += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)';
      params.push(q, q, q);
    }
    const customers = db.all(
      `SELECT u.id, u.name, u.email, u.phone, u.loyalty_points, u.active, u.created_at,
              (SELECT COUNT(*) FROM vehicles v WHERE v.owner_id = u.id) AS vehicles,
              (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id AND b.status = 'completed') AS washes,
              (SELECT COALESCE(SUM(total), 0) FROM bookings b WHERE b.customer_id = u.id AND b.status = 'completed') AS total_spent,
              (SELECT MAX(scheduled_at) FROM bookings b WHERE b.customer_id = u.id AND b.status = 'completed') AS last_visit
         FROM users u ${where} ORDER BY u.created_at DESC LIMIT 500`,
      ...params,
    );
    res.json({ customers });
  });

  r.post('/customers', (req, res) => {
    const name = str(req.body.name, 80);
    const email = str(req.body.email, 120)?.toLowerCase();
    if (!name) throw new HttpError(400, 'Name is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'A valid email is required.');
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with this email already exists.');
    const password = String(req.body.password || '') || Math.random().toString(36).slice(2, 10);
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
    const { id } = db.run(
      "INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'customer', ?)",
      name,
      email,
      str(req.body.phone, 30),
      hashPassword(password),
      now(),
    );
    res.status(201).json({ customer: db.get('SELECT id, name, email, phone, loyalty_points, active, created_at FROM users WHERE id = ?', id), password });
  });

  r.get('/customers/:id', (req, res) => {
    const customer = db.get("SELECT id, name, email, phone, loyalty_points, active, created_at FROM users WHERE id = ? AND role = 'customer'", int(req.params.id));
    if (!customer) throw new HttpError(404, 'Customer not found.');
    const vehicles = db.all(
      `SELECT v.*, (SELECT COUNT(*) FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'completed') AS washes
         FROM vehicles v WHERE v.owner_id = ? ORDER BY v.id`,
      customer.id,
    );
    const bookings = B.withAddons(
      db,
      db.all(
        `SELECT b.*, v.plate, v.make, v.model, st.name AS staff_name FROM bookings b
           JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN staff st ON st.id = b.staff_id
          WHERE b.customer_id = ? ORDER BY b.scheduled_at DESC`,
        customer.id,
      ),
    );
    const completed = bookings.filter((b) => b.status === 'completed');
    const stats = {
      washes: completed.length,
      total_spent: round2(completed.reduce((s, b) => s + b.total, 0)),
      cancelled: bookings.filter((b) => b.status === 'cancelled').length,
      no_shows: bookings.filter((b) => b.status === 'no_show').length,
    };
    res.json({ customer, vehicles, bookings, stats });
  });

  r.patch('/customers/:id', (req, res) => {
    const c = db.get("SELECT * FROM users WHERE id = ? AND role = 'customer'", int(req.params.id));
    if (!c) throw new HttpError(404, 'Customer not found.');
    const name = req.body.name !== undefined ? str(req.body.name, 80) : c.name;
    const phone = req.body.phone !== undefined ? str(req.body.phone, 30) : c.phone;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : c.active;
    let points = c.loyalty_points;
    if (req.body.points_adjustment !== undefined) points = Math.max(0, points + (int(req.body.points_adjustment) || 0));
    if (!name) throw new HttpError(400, 'Name cannot be empty.');
    db.run('UPDATE users SET name = ?, phone = ?, active = ?, loyalty_points = ? WHERE id = ?', name, phone, active, points, c.id);
    if (!active) db.run('DELETE FROM sessions WHERE user_id = ?', c.id);
    if (req.body.new_password) {
      if (String(req.body.new_password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.new_password), c.id);
    }
    res.json({ customer: db.get('SELECT id, name, email, phone, loyalty_points, active, created_at FROM users WHERE id = ?', c.id) });
  });

  // ---------- Services ----------
  r.get('/services', (_req, res) => {
    res.json({
      services: db.all(
        `SELECT s.*,
                (SELECT COUNT(*) FROM bookings b WHERE b.service_id = s.id AND b.status = 'completed') +
                (SELECT COUNT(*) FROM booking_addons a JOIN bookings b ON b.id = a.booking_id WHERE a.service_id = s.id AND b.status = 'completed') AS times_sold
           FROM services s ORDER BY s.kind DESC, s.active DESC, s.price`,
      ),
    });
  });

  const serviceInput = (body, current = {}) => {
    const name = body.name !== undefined ? str(body.name, 80) : current.name;
    const price = body.price !== undefined ? Number(body.price) : current.price;
    const duration = body.duration_min !== undefined ? int(body.duration_min) : current.duration_min;
    const kind = body.kind !== undefined ? body.kind : current.kind;
    if (!name) throw new HttpError(400, 'Name is required.');
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'Price must be a positive number.');
    if (!duration || duration < 1) throw new HttpError(400, 'Duration must be at least 1 minute.');
    if (!['package', 'addon'].includes(kind)) throw new HttpError(400, 'Type must be package or add-on.');
    const category = body.category !== undefined ? String(body.category) : current.category || 'other';
    if (!B.CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category.');
    const months = (key, label) => {
      if (body[key] === undefined) return current[key] ?? null;
      const n = int(body[key]);
      if (n !== null && (n < 0 || n > 600)) throw new HttpError(400, `${label} must be between 0 and 600 months.`);
      return n || null;
    };
    return {
      name,
      description: body.description !== undefined ? str(body.description, 500) : current.description,
      price: round2(price),
      duration,
      kind,
      category,
      warranty: months('warranty_months', 'Warranty'),
      maintenance: months('maintenance_months', 'Maintenance interval'),
      active: body.active !== undefined ? (body.active ? 1 : 0) : (current.active ?? 1),
    };
  };

  r.post('/services', (req, res) => {
    const s = serviceInput(req.body);
    const { id } = db.run(
      `INSERT INTO services (name, description, price, duration_min, kind, category, warranty_months, maintenance_months, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.name,
      s.description,
      s.price,
      s.duration,
      s.kind,
      s.category,
      s.warranty,
      s.maintenance,
      s.active,
      now(),
    );
    res.status(201).json({ service: db.get('SELECT * FROM services WHERE id = ?', id) });
  });

  r.patch('/services/:id', (req, res) => {
    const current = db.get('SELECT * FROM services WHERE id = ?', int(req.params.id));
    if (!current) throw new HttpError(404, 'Service not found.');
    const s = serviceInput(req.body, current);
    db.run(
      `UPDATE services SET name = ?, description = ?, price = ?, duration_min = ?, kind = ?, category = ?, warranty_months = ?, maintenance_months = ?, active = ?
        WHERE id = ?`,
      s.name,
      s.description,
      s.price,
      s.duration,
      s.kind,
      s.category,
      s.warranty,
      s.maintenance,
      s.active,
      current.id,
    );
    res.json({ service: db.get('SELECT * FROM services WHERE id = ?', current.id) });
  });

  r.delete('/services/:id', (req, res) => {
    const id = int(req.params.id);
    const used = db.get('SELECT 1 FROM bookings WHERE service_id = ? UNION SELECT 1 FROM booking_addons WHERE service_id = ?', id, id);
    if (used) {
      db.run('UPDATE services SET active = 0 WHERE id = ?', id);
      return res.json({ ok: true, archived: true });
    }
    db.run('DELETE FROM services WHERE id = ?', id);
    res.json({ ok: true, archived: false });
  });

  // ---------- Staff ----------
  r.get('/staff', (_req, res) => {
    const t = today();
    res.json({
      staff: db.all(
        `SELECT s.*,
                (SELECT COUNT(*) FROM bookings b WHERE b.staff_id = s.id AND b.status = 'completed') AS jobs_completed,
                (SELECT COUNT(*) FROM bookings b WHERE b.staff_id = s.id AND b.status = 'completed' AND substr(b.completed_at, 1, 10) = ?) AS jobs_today,
                (SELECT ROUND(AVG(rating), 2) FROM bookings b WHERE b.staff_id = s.id AND b.rating IS NOT NULL) AS avg_rating,
                (SELECT COUNT(*) FROM bookings b WHERE b.staff_id = s.id AND b.status = 'in_progress') AS busy
           FROM staff s ORDER BY s.active DESC, s.name`,
        t,
      ),
    });
  });

  r.post('/staff', (req, res) => {
    const name = str(req.body.name, 80);
    if (!name) throw new HttpError(400, 'Name is required.');
    const { id } = db.run('INSERT INTO staff (name, phone, position, active, created_at) VALUES (?, ?, ?, 1, ?)', name, str(req.body.phone, 30), str(req.body.position, 60), now());
    res.status(201).json({ staff: db.get('SELECT * FROM staff WHERE id = ?', id) });
  });

  r.patch('/staff/:id', (req, res) => {
    const s = db.get('SELECT * FROM staff WHERE id = ?', int(req.params.id));
    if (!s) throw new HttpError(404, 'Staff member not found.');
    const name = req.body.name !== undefined ? str(req.body.name, 80) : s.name;
    if (!name) throw new HttpError(400, 'Name is required.');
    db.run(
      'UPDATE staff SET name = ?, phone = ?, position = ?, active = ? WHERE id = ?',
      name,
      req.body.phone !== undefined ? str(req.body.phone, 30) : s.phone,
      req.body.position !== undefined ? str(req.body.position, 60) : s.position,
      req.body.active !== undefined ? (req.body.active ? 1 : 0) : s.active,
      s.id,
    );
    res.json({ staff: db.get('SELECT * FROM staff WHERE id = ?', s.id) });
  });

  r.delete('/staff/:id', (req, res) => {
    const id = int(req.params.id);
    if (db.get('SELECT 1 FROM bookings WHERE staff_id = ?', id)) {
      db.run('UPDATE staff SET active = 0 WHERE id = ?', id);
      return res.json({ ok: true, archived: true });
    }
    db.run('DELETE FROM staff WHERE id = ?', id);
    res.json({ ok: true, archived: false });
  });

  // ---------- Reports ----------
  r.get('/reports', (req, res) => {
    const { from, to } = dateRange(req.query);
    const inRange = "substr(b.scheduled_at, 1, 10) BETWEEN ? AND ?";
    const summary = db.get(
      `SELECT COUNT(*) AS bookings,
              SUM(b.status = 'completed') AS completed,
              SUM(b.status = 'cancelled') AS cancelled,
              SUM(b.status = 'no_show') AS no_shows,
              ROUND(COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.total END), 0), 2) AS revenue,
              ROUND(COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.discount END), 0), 2) AS discounts,
              ROUND(COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.tax END), 0), 2) AS tax,
              ROUND(AVG(CASE WHEN b.status = 'completed' THEN b.total END), 2) AS avg_ticket,
              ROUND(AVG(b.rating), 2) AS avg_rating,
              COUNT(DISTINCT CASE WHEN b.status = 'completed' THEN b.vehicle_id END) AS unique_vehicles,
              SUM(b.source = 'walk_in') AS walk_ins,
              SUM(b.source = 'online') AS online
         FROM bookings b WHERE ${inRange}`,
      from,
      to,
    );
    const by_day = db.all(
      `SELECT substr(b.scheduled_at, 1, 10) AS day, COUNT(*) AS washes, ROUND(SUM(b.total), 2) AS revenue
         FROM bookings b WHERE b.status = 'completed' AND ${inRange} GROUP BY day ORDER BY day`,
      from,
      to,
    );
    const by_service = db.all(
      `SELECT b.service_name AS name, COUNT(*) AS count, ROUND(SUM(b.service_price), 2) AS revenue
         FROM bookings b WHERE b.status = 'completed' AND ${inRange} GROUP BY b.service_name ORDER BY revenue DESC`,
      from,
      to,
    );
    const by_addon = db.all(
      `SELECT a.name, COUNT(*) AS count, ROUND(SUM(a.price), 2) AS revenue
         FROM booking_addons a JOIN bookings b ON b.id = a.booking_id
        WHERE b.status = 'completed' AND ${inRange} GROUP BY a.name ORDER BY revenue DESC`,
      from,
      to,
    );
    const by_staff = db.all(
      `SELECT COALESCE(st.name, 'Unassigned') AS name, COUNT(*) AS count, ROUND(SUM(b.total), 2) AS revenue, ROUND(AVG(b.rating), 2) AS avg_rating
         FROM bookings b LEFT JOIN staff st ON st.id = b.staff_id
        WHERE b.status = 'completed' AND ${inRange} GROUP BY st.id ORDER BY revenue DESC`,
      from,
      to,
    );
    const by_payment = db.all(
      `SELECT COALESCE(b.payment_method, 'not recorded') AS method, b.payment_status AS status, COUNT(*) AS count, ROUND(SUM(b.total), 2) AS amount
         FROM bookings b WHERE b.status = 'completed' AND ${inRange} GROUP BY method, status ORDER BY amount DESC`,
      from,
      to,
    );
    const by_hour = db.all(
      `SELECT substr(b.scheduled_at, 12, 2) AS hour, COUNT(*) AS count
         FROM bookings b WHERE b.status = 'completed' AND ${inRange} GROUP BY hour ORDER BY hour`,
      from,
      to,
    );
    const by_vehicle_type = db.all(
      `SELECT v.type, COUNT(*) AS count, ROUND(SUM(b.total), 2) AS revenue
         FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
        WHERE b.status = 'completed' AND ${inRange} GROUP BY v.type ORDER BY count DESC`,
      from,
      to,
    );
    const by_category = db.all(
      `SELECT COALESCE(b.service_category, s.category, 'other') AS category, COUNT(*) AS count, ROUND(SUM(b.total), 2) AS revenue
         FROM bookings b LEFT JOIN services s ON s.id = b.service_id
        WHERE b.status = 'completed' AND ${inRange} GROUP BY 1 ORDER BY revenue DESC`,
      from,
      to,
    );
    res.json({ from, to, summary, by_day, by_category, by_service, by_addon, by_staff, by_payment, by_hour, by_vehicle_type });
  });

  r.get('/reports/bookings.csv', (req, res) => {
    const { from, to } = dateRange(req.query);
    const rows = B.withAddons(
      db,
      db.all(
        `SELECT b.*, v.plate, v.make, v.model, v.type AS vehicle_type, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone, st.name AS staff_name
           FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
           LEFT JOIN users u ON u.id = b.customer_id LEFT JOIN staff st ON st.id = b.staff_id
          WHERE substr(b.scheduled_at, 1, 10) BETWEEN ? AND ? ORDER BY b.scheduled_at`,
        from,
        to,
      ),
    );
    const cols = [
      ['Code', 'code'],
      ['Scheduled', 'scheduled_at'],
      ['Status', 'status'],
      ['Plate', 'plate'],
      ['Make', 'make'],
      ['Model', 'model'],
      ['Vehicle type', 'vehicle_type'],
      ['Customer', 'customer_name'],
      ['Email', 'customer_email'],
      ['Phone', 'customer_phone'],
      ['Package', 'service_name'],
      ['Add-ons', (b) => b.addons.map((a) => a.name).join('; ')],
      ['Staff', 'staff_name'],
      ['Bay', 'bay'],
      ['Subtotal', 'subtotal'],
      ['Surcharge', 'surcharge'],
      ['Discount', 'discount'],
      ['Tax', 'tax'],
      ['Total', 'total'],
      ['Payment status', 'payment_status'],
      ['Payment method', 'payment_method'],
      ['Mileage', 'mileage'],
      ['Source', 'source'],
      ['Rating', 'rating'],
      ['Feedback', 'feedback'],
      ['Completed at', 'completed_at'],
    ];
    const lines = [cols.map(([h]) => csvCell(h)).join(',')];
    for (const b of rows) lines.push(cols.map(([, k]) => csvCell(typeof k === 'function' ? k(b) : b[k])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookings_${from}_${to}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });

  // ---------- Settings ----------
  r.get('/settings', (_req, res) => {
    res.json({ settings: db.getSettings() });
  });

  r.put('/settings', (req, res) => {
    const body = req.body || {};
    const numeric = ['tax_rate', 'slot_minutes', 'bays', 'booking_window_days', 'large_vehicle_surcharge', 'points_per_unit', 'reward_points', 'reward_value'];
    const text = ['business_name', 'tagline', 'phone', 'address', 'currency'];
    const updates = {};
    for (const key of Object.keys(body)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      if (numeric.includes(key)) {
        const n = Number(body[key]);
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${key.replace(/_/g, ' ')} must be a positive number.`);
        updates[key] = n;
      } else if (text.includes(key)) {
        updates[key] = str(body[key], 120) || '';
      } else if (key === 'open_time' || key === 'close_time') {
        if (!/^\d{2}:\d{2}$/.test(body[key])) throw new HttpError(400, 'Times must be in HH:MM format.');
        updates[key] = body[key];
      } else if (key === 'open_days') {
        const days = (Array.isArray(body[key]) ? body[key] : []).map(Number).filter((d) => d >= 0 && d <= 6);
        updates[key] = [...new Set(days)].sort();
      }
    }
    if (updates.slot_minutes !== undefined && updates.slot_minutes < 10) throw new HttpError(400, 'Slot length must be at least 10 minutes.');
    if (updates.bays !== undefined && updates.bays < 1) throw new HttpError(400, 'You need at least one bay.');
    const merged = { ...db.getSettings(), ...updates };
    if (merged.open_time >= merged.close_time) throw new HttpError(400, 'Opening time must be before closing time.');
    db.tx(() => {
      for (const [k, v] of Object.entries(updates)) db.setSetting(k, v);
    });
    res.json({ settings: db.getSettings() });
  });

  // Admin's own password
  r.post('/password', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(req.body.current_password || '', u.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    if (String(req.body.new_password || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters.');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.new_password), u.id);
    res.json({ ok: true });
  });

  return r;
};
