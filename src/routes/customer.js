'use strict';

const express = require('express');
const { hashPassword, verifyPassword } = require('../auth');
const B = require('../bookings');
const { now } = require('../db');

const { HttpError, str, int } = B;

module.exports = function customerRoutes(db) {
  const r = express.Router();

  const ownVehicle = (req, id) => {
    const v = db.get('SELECT * FROM vehicles WHERE id = ? AND owner_id = ?', int(id), req.user.id);
    if (!v) throw new HttpError(404, 'Vehicle not found.');
    return v;
  };
  const ownBooking = (req, id) => {
    const b = db.get('SELECT * FROM bookings WHERE id = ? AND customer_id = ?', int(id), req.user.id);
    if (!b) throw new HttpError(404, 'Booking not found.');
    return b;
  };
  /** Strip staff-only fields from a booking before sending it to a customer. */
  const forCustomer = (b) => {
    if (!b) return b;
    const { admin_notes: _a, events, ...rest } = b;
    if (events) rest.events = events.map(({ actor_name: _n, ...e }) => e);
    return rest;
  };

  // ---------- Profile ----------
  r.get('/me', (req, res) => {
    const stats = db.get(
      `SELECT COUNT(*) AS bookings,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) AS spent
         FROM bookings WHERE customer_id = ?`,
      req.user.id,
    );
    res.json({ user: req.user, stats });
  });

  r.patch('/me', (req, res) => {
    const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    const name = req.body.name !== undefined ? str(req.body.name, 80) : user.name;
    const phone = req.body.phone !== undefined ? str(req.body.phone, 30) : user.phone;
    if (!name) throw new HttpError(400, 'Name cannot be empty.');
    let hash = user.password_hash;
    if (req.body.new_password) {
      if (!verifyPassword(req.body.current_password || '', user.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
      if (String(req.body.new_password).length < 6) throw new HttpError(400, 'New password must be at least 6 characters.');
      hash = hashPassword(req.body.new_password);
    }
    db.run('UPDATE users SET name = ?, phone = ?, password_hash = ? WHERE id = ?', name, phone, hash, user.id);
    res.json({ user: db.get('SELECT id, name, email, phone, role, loyalty_points FROM users WHERE id = ?', user.id) });
  });

  // ---------- Vehicles ----------
  r.get('/vehicles', (req, res) => {
    const vehicles = db.all(
      `SELECT v.*,
              (SELECT COUNT(*) FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'completed') AS washes,
              (SELECT MAX(scheduled_at) FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'completed') AS last_wash
         FROM vehicles v WHERE v.owner_id = ? ORDER BY v.id`,
      req.user.id,
    );
    const protections = B.protectionsByVehicle(db, vehicles.map((v) => v.id));
    for (const v of vehicles) v.protections = protections.get(v.id);
    res.json({ vehicles });
  });

  r.post('/vehicles', (req, res) => {
    const v = B.vehicleInput(req.body);
    const existing = db.get('SELECT * FROM vehicles WHERE plate = ?', v.plate);
    if (existing && existing.owner_id && existing.owner_id !== req.user.id) {
      throw new HttpError(409, 'This plate is already registered to another account. Please contact us.');
    }
    if (existing && existing.owner_id === req.user.id) throw new HttpError(409, 'You have already added this vehicle.');
    let id;
    if (existing) {
      // A walk-in vehicle we already know: link it so its wash history carries over.
      db.run(
        'UPDATE vehicles SET owner_id = ?, make = COALESCE(?, make), model = COALESCE(?, model), year = COALESCE(?, year), color = COALESCE(?, color), type = ?, notes = COALESCE(?, notes) WHERE id = ?',
        req.user.id,
        v.make,
        v.model,
        v.year,
        v.color,
        v.type,
        v.notes,
        existing.id,
      );
      id = existing.id;
    } else {
      ({ id } = db.run(
        'INSERT INTO vehicles (owner_id, plate, make, model, year, color, type, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        req.user.id,
        v.plate,
        v.make,
        v.model,
        v.year,
        v.color,
        v.type,
        v.notes,
        now(),
      ));
    }
    res.status(201).json({ vehicle: db.get('SELECT * FROM vehicles WHERE id = ?', id) });
  });

  r.patch('/vehicles/:id', (req, res) => {
    const current = ownVehicle(req, req.params.id);
    const v = B.vehicleInput(req.body, { partial: true });
    if (v.plate && v.plate !== current.plate && db.get('SELECT 1 FROM vehicles WHERE plate = ? AND id <> ?', v.plate, current.id)) {
      throw new HttpError(409, 'Another vehicle already uses this plate.');
    }
    const merged = { ...current, ...v };
    db.run(
      'UPDATE vehicles SET plate = ?, make = ?, model = ?, year = ?, color = ?, type = ?, notes = ? WHERE id = ?',
      merged.plate,
      merged.make,
      merged.model,
      merged.year,
      merged.color,
      merged.type,
      merged.notes,
      current.id,
    );
    res.json({ vehicle: db.get('SELECT * FROM vehicles WHERE id = ?', current.id) });
  });

  r.delete('/vehicles/:id', (req, res) => {
    const v = ownVehicle(req, req.params.id);
    const active = db.get(`SELECT 1 FROM bookings WHERE vehicle_id = ? AND status IN ('pending','confirmed','in_progress')`, v.id);
    if (active) throw new HttpError(400, 'This vehicle has an upcoming booking. Cancel it first.');
    const hasHistory = db.get('SELECT 1 FROM bookings WHERE vehicle_id = ?', v.id);
    // Keep the vehicle (and its history) for the business, just unlink it from this account.
    if (hasHistory) db.run('UPDATE vehicles SET owner_id = NULL WHERE id = ?', v.id);
    else db.run('DELETE FROM vehicles WHERE id = ?', v.id);
    res.json({ ok: true });
  });

  r.get('/vehicles/:id/history', (req, res) => {
    const v = ownVehicle(req, req.params.id);
    const h = B.vehicleHistory(db, v.id);
    h.bookings = h.bookings.filter((b) => b.customer_id === req.user.id).map(forCustomer);
    delete h.notes; // internal staff notes
    res.json(h);
  });

  // ---------- Bookings ----------
  r.post('/quote', (req, res) => {
    const vehicle = req.body.vehicle_id ? ownVehicle(req, req.body.vehicle_id) : { type: 'sedan' };
    const user = db.get('SELECT loyalty_points FROM users WHERE id = ?', req.user.id);
    const q = B.quote(db, {
      serviceId: req.body.service_id,
      addonIds: req.body.addon_ids || [],
      vehicleType: vehicle.type,
      redeemPoints: req.body.redeem_points,
      availablePoints: user.loyalty_points,
    });
    res.json({
      subtotal: q.subtotal,
      surcharge: q.surcharge,
      discount: q.discount,
      tax: q.tax,
      total: q.total,
      points_redeemed: q.pointsRedeemed,
      duration_min: q.duration,
    });
  });

  r.get('/bookings', (req, res) => {
    const rows = db.all(
      `SELECT b.*, v.plate, v.make, v.model, v.color, v.type AS vehicle_type
         FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
        WHERE b.customer_id = ?
        ORDER BY CASE WHEN b.status IN ('pending','confirmed','in_progress') THEN 0 ELSE 1 END,
                 CASE WHEN b.status IN ('pending','confirmed','in_progress') THEN b.scheduled_at END ASC,
                 b.scheduled_at DESC`,
      req.user.id,
    );
    res.json({ bookings: B.withAddons(db, rows).map(forCustomer) });
  });

  r.get('/bookings/:id', (req, res) => {
    const b = ownBooking(req, req.params.id);
    res.json({ booking: forCustomer(B.bookingDetail(db, b.id)) });
  });

  r.post('/bookings', (req, res) => {
    const vehicle = ownVehicle(req, req.body.vehicle_id);
    const { duration } = B.quote(db, { serviceId: req.body.service_id, addonIds: req.body.addon_ids || [], vehicleType: vehicle.type });
    const scheduledAt = B.assertSlotBookable(db, req.body.scheduled_at, { duration });
    const clash = db.get(`SELECT code FROM bookings WHERE vehicle_id = ? AND status IN ('pending','confirmed','in_progress')`, vehicle.id);
    if (clash) throw new HttpError(409, `This vehicle already has an active booking (${clash.code}).`);
    const id = B.createBooking(db, {
      vehicle,
      customerId: req.user.id,
      serviceId: req.body.service_id,
      addonIds: req.body.addon_ids || [],
      scheduledAt,
      redeemPoints: req.body.redeem_points,
      customerNotes: req.body.notes,
      source: 'online',
      actorName: req.user.name,
      enforceSlot: true,
    });
    res.status(201).json({ booking: forCustomer(B.bookingDetail(db, id)) });
  });

  r.post('/bookings/:id/cancel', (req, res) => {
    const b = ownBooking(req, req.params.id);
    if (!['pending', 'confirmed'].includes(b.status)) throw new HttpError(400, 'This booking can no longer be cancelled.');
    B.changeStatus(db, b, 'cancelled', { actorName: req.user.name, note: str(req.body.reason, 300) || 'Cancelled by customer' });
    res.json({ booking: forCustomer(B.bookingDetail(db, b.id)) });
  });

  r.post('/bookings/:id/reschedule', (req, res) => {
    const b = ownBooking(req, req.params.id);
    if (!['pending', 'confirmed'].includes(b.status)) throw new HttpError(400, 'This booking can no longer be rescheduled.');
    const scheduledAt = B.assertSlotBookable(db, req.body.scheduled_at, { duration: b.duration_min, excludeId: b.id });
    db.tx(() => {
      db.run("UPDATE bookings SET scheduled_at = ?, status = 'pending' WHERE id = ?", scheduledAt, b.id);
      B.addEvent(db, b.id, 'pending', `Rescheduled from ${b.scheduled_at} to ${scheduledAt}`, req.user.name);
    });
    res.json({ booking: forCustomer(B.bookingDetail(db, b.id)) });
  });

  r.post('/bookings/:id/rate', (req, res) => {
    const b = ownBooking(req, req.params.id);
    if (b.status !== 'completed') throw new HttpError(400, 'You can only rate completed washes.');
    const rating = int(req.body.rating);
    if (!rating || rating < 1 || rating > 5) throw new HttpError(400, 'Rating must be between 1 and 5.');
    db.run('UPDATE bookings SET rating = ?, feedback = ? WHERE id = ?', rating, str(req.body.feedback, 1000), b.id);
    res.json({ booking: forCustomer(B.bookingDetail(db, b.id)) });
  });

  return r;
};
