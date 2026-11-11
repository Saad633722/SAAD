'use strict';

const express = require('express');
const inv = require('../inventory');
const { HttpError } = require('../errors');

/** Employees see stock levels and record usage; costs, purchases, counts and the catalogue are admin-only. */
module.exports = function inventoryRoutes(db) {
  const r = express.Router();
  const isAdmin = (req) => req.user.role === 'admin';
  const adminOnly = (req, _res, next) => (isAdmin(req) ? next() : next(new HttpError(403, 'Only the admin can do this.')));
  const forRole = (req, item) => {
    if (isAdmin(req)) return item;
    const { cost_price: _c, value: _v, supplier: _s, ...rest } = item;
    return rest;
  };

  r.get('/', (req, res) => {
    const items = inv.listItems(db, { includeArchived: isAdmin(req) && req.query.archived === '1' });
    const active = items.filter((i) => i.active);
    const summary = { items: active.length, low: active.filter((i) => i.low).length };
    if (isAdmin(req)) summary.value = Math.round(active.reduce((s, i) => s + i.value, 0) * 100) / 100;
    res.json({ items: items.map((i) => forRole(req, i)), summary, categories: inv.ITEM_CATEGORIES });
  });

  r.post('/', adminOnly, (req, res) => {
    res.status(201).json({ item: inv.createItem(db, req.body, req.user.name) });
  });

  r.patch('/:id', adminOnly, (req, res) => {
    res.json({ item: inv.updateItem(db, req.params.id, req.body) });
  });

  r.get('/:id/movements', (req, res) => {
    const item = inv.describe(inv.getItem(db, req.params.id));
    let list = inv.movements(db, item.id);
    if (!isAdmin(req)) list = list.map(({ unit_cost: _u, ...m }) => m);
    res.json({ item: forRole(req, item), movements: list });
  });

  // { type: 'purchase' | 'use' | 'waste' | 'adjust', quantity | counted, unit_cost?, note?, booking_code? }
  r.post('/:id/movements', (req, res) => {
    const type = req.body.type;
    if (!isAdmin(req) && !['use', 'waste'].includes(type)) throw new HttpError(403, 'Employees can only record stock used or wasted.');
    let bookingId = null;
    if (req.body.booking_code) {
      const b = db.get('SELECT id FROM bookings WHERE code = ?', String(req.body.booking_code).trim().toUpperCase());
      if (!b) throw new HttpError(400, 'No booking with that code.');
      bookingId = b.id;
    }
    const item = inv.move(db, req.params.id, { ...req.body, booking_id: bookingId }, req.user.name);
    res.status(201).json({ item: forRole(req, item) });
  });

  // Materials each service uses per job (deducted automatically when a job is completed).
  r.get('/materials/:serviceId', adminOnly, (req, res) => {
    res.json({ materials: inv.materialsFor(db, Number(req.params.serviceId)) });
  });

  r.put('/materials/:serviceId', adminOnly, (req, res) => {
    const svc = db.get('SELECT id FROM services WHERE id = ?', Number(req.params.serviceId));
    if (!svc) throw new HttpError(404, 'Service not found.');
    res.json({ materials: inv.setMaterials(db, svc.id, req.body.materials) });
  });

  return r;
};
