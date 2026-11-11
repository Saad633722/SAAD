(async function () {
  'use strict';
  const { api, esc, money, fmtDate, fmtShortDate, fmtTime, fmtDateTime, timeAgo, statusBadge, payBadge, plate, stars, cap, vehicleName, toast, modal, confirmDialog } = UI;
  const main = document.getElementById('main');
  const cache = { services: [], staff: [] };

  const me = await api('GET', '/api/auth/me');
  if (!me.user || !['admin', 'employee'].includes(me.user.role)) return (location.href = '/staff');
  // Employees (PIN sign-in) see the floor tools only: no reports, settings, prices catalogue, staff or customer accounts.
  const isAdmin = me.user.role === 'admin';
  document.body.classList.add(`role-${me.user.role}`);
  if (!isAdmin) {
    document.querySelectorAll('[data-admin-only]').forEach((el) => el.remove());
    document.querySelectorAll('[data-role-badge]').forEach((el) => (el.textContent = 'EMPLOYEE'));
  }
  const canDiscount = () => isAdmin || UI.state.settings.employee_can_discount;
  const fmtQty = (n) => Number(n).toLocaleString('en', { maximumFractionDigits: 3 });
  UI.bindShell(me.user);
  await UI.loadSettings();
  document.title = `${isAdmin ? 'Admin' : 'Staff'} — ${UI.state.settings.business_name}`;

  async function refreshCatalog() {
    const [s, st] = await Promise.all([api('GET', '/api/admin/services'), api('GET', '/api/admin/staff')]);
    cache.services = s.services;
    cache.staff = st.staff;
  }
  await refreshCatalog();

  const NEXT = {
    pending: ['confirmed', 'Confirm'],
    confirmed: ['in_progress', 'Start job'],
    in_progress: ['completed', 'Complete'],
  };
  const ACTION_LABEL = { pending: 'Back to pending', confirmed: 'Confirm', in_progress: 'Start job', completed: 'Complete', cancelled: 'Cancel booking', no_show: 'Mark no-show' };

  const setPage = (html) => (main.innerHTML = html);
  const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="btn-row">${actions}</div></div>`;
  const vehicleLink = (b) => `<a href="#/vehicles/${b.vehicle_id}">${plate(b.plate)}</a>`;
  const addonsText = (b) => (b.addons && b.addons.length ? `<div class="muted" style="font-size:.8rem">+ ${b.addons.map((a) => esc(a.name)).join(', ')}</div>` : '');
  const staffOptions = (selected, includeInactive = false) =>
    `<option value="">— Unassigned —</option>` +
    cache.staff
      .filter((s) => s.active || includeInactive || s.id === selected)
      .map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}${s.position ? ` (${esc(s.position)})` : ''}</option>`)
      .join('');

  // =====================================================================
  // Booking detail modal (used everywhere)
  // =====================================================================
  async function openBooking(id, onChange) {
    const { booking: b, transitions } = await api('GET', `/api/admin/bookings/${id}`);
    const closed = ['cancelled', 'no_show'].includes(b.status);
    const body = `
      <div class="grid grid-2">
        <div>
          <div class="btn-row" style="margin-bottom:10px">${statusBadge(b.status)} ${payBadge(b.payment_status)} <span class="badge">${b.source === 'walk_in' ? 'Walk-in' : 'Online'}</span></div>
          <dl class="kv">
            <dt>Booking</dt><dd class="mono">${esc(b.code)}</dd>
            <dt>Scheduled</dt><dd>${esc(fmtDateTime(b.scheduled_at))}</dd>
            <dt>Work time</dt><dd>${esc(UI.fmtDuration(b.duration_min))}</dd>
            ${b.ready_at && ['pending', 'confirmed', 'in_progress'].includes(b.status) ? `<dt>Ready by</dt><dd>${esc(fmtDateTime(b.ready_at))}</dd>` : ''}
            <dt>Vehicle</dt><dd><a href="#/vehicles/${b.vehicle_id}" data-close>${plate(b.plate)}</a> ${esc(vehicleName(b))}${b.color ? ` · ${esc(b.color)}` : ''}</dd>
            <dt>Customer</dt><dd>${b.customer_id ? `<a href="#/customers/${b.customer_id}" data-close>${esc(b.customer_name)}</a><br><small>${esc(b.customer_phone || b.customer_email || '')}</small>` : '<span class="muted">Walk-in (no account)</span>'}</dd>
            ${b.started_at ? `<dt>Started</dt><dd>${esc(fmtDateTime(b.started_at))}</dd>` : ''}
            ${b.completed_at ? `<dt>Completed</dt><dd>${esc(fmtDateTime(b.completed_at))}</dd>` : ''}
            ${b.points_earned ? `<dt>Points earned</dt><dd>${b.points_earned}</dd>` : ''}
            ${b.rating ? `<dt>Rating</dt><dd>${stars(b.rating)}${b.feedback ? `<br><small>“${esc(b.feedback)}”</small>` : ''}</dd>` : ''}
          </dl>
          <div class="card-head" style="margin:16px 0 8px"><h3 style="margin:0">Bill ${b.service_category ? UI.catBadge(b.service_category) : ''}</h3>${closed ? '' : '<button type="button" class="btn btn-sm" data-pricing>✎ Price &amp; discount</button>'}</div>
          ${UI.priceLines({ ...b, payments: [] })}
          ${b.customer_notes ? `<div class="note" style="margin-top:12px"><div class="meta">Customer note</div>${esc(b.customer_notes)}</div>` : ''}
          <h3 style="margin-top:16px">Activity</h3>
          ${UI.timeline(b.events)}
        </div>
        <div>
          ${
            transitions.length
              ? `<h3>Update status</h3><div class="btn-row" style="margin-bottom:16px">${transitions
                  .map((s) => `<button type="button" class="btn btn-sm ${s === 'completed' ? 'btn-success' : s === 'cancelled' || s === 'no_show' ? 'btn-danger' : NEXT[b.status]?.[0] === s ? 'btn-primary' : ''}" data-status="${s}">${esc(ACTION_LABEL[s])}</button>`)
                  .join('')}</div>`
              : ''
          }
          <h3>Payments</h3>
          ${
            b.balance < -0.004
              ? `<div class="balance"><span>Refund due</span><span>${money(-b.balance)}</span></div>`
              : `<div class="balance ${b.balance <= 0.004 ? 'settled' : ''}"><span>${b.balance <= 0.004 ? (closed ? 'Nothing to pay' : b.total > 0 ? 'Fully paid' : 'Nothing to pay') : 'Balance due'}</span><span>${money(Math.max(0, b.balance))}</span></div>`
          }
          ${
            b.payments.length
              ? `<ul class="payment-list">${b.payments
                  .map(
                    (p) => `<li><span><b>${p.amount < 0 ? 'Refund' : esc(money(p.amount))}</b>${p.amount < 0 ? ` ${esc(money(-p.amount))}` : ''} · ${esc(p.method)}${p.reference ? ` <small class="muted">#${esc(p.reference)}</small>` : ''}
                    <br><small class="muted">${esc(fmtDateTime(p.created_at))}${p.received_by ? ` · ${esc(p.received_by)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</small></span>
                    ${isAdmin ? `<button type="button" class="btn btn-ghost btn-sm" data-del-payment="${p.id}" title="Remove (entered by mistake)">✕</button>` : ''}</li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted" style="font-size:.9rem">No payments yet.</p>'
          }
          <div class="btn-row" style="margin-bottom:18px">
            ${b.balance > 0.004 && !closed ? '<button type="button" class="btn btn-success btn-sm" data-pay>Take payment</button>' : ''}
            ${b.amount_paid > 0 && isAdmin ? `<button type="button" class="btn btn-sm ${b.balance < -0.004 ? 'btn-primary' : ''}" data-refund>Refund</button>` : ''}
          </div>
          <form data-edit>
            <div class="form-row">
              <div class="field"><label>Staff</label><select name="staff_id">${staffOptions(b.staff_id)}</select></div>
              <div class="field"><label>Bay</label><input name="bay" type="number" min="1" value="${esc(b.bay)}"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>Date &amp; time</label><input name="scheduled_at" type="datetime-local" value="${esc(b.scheduled_at.replace(' ', 'T'))}" ${['completed', 'cancelled', 'no_show'].includes(b.status) ? 'disabled' : ''}></div>
              <div class="field"><label>Mileage</label><input name="mileage" type="number" min="0" value="${esc(b.mileage)}" placeholder="km"></div>
            </div>
            <div class="field"><label>Internal notes <small class="muted" style="display:inline">(not visible to customer)</small></label><textarea name="admin_notes" placeholder="Condition on arrival, issues, etc.">${esc(b.admin_notes)}</textarea></div>
            <button class="btn btn-primary" type="submit">Save changes</button>
          </form>
        </div>
      </div>`;
    const m = modal({
      title: `Booking ${b.code}`,
      body,
      wide: true,
      footer: `<button class="btn" data-print>🖨 Print receipt</button><button class="btn" data-close>Close</button>`,
    });
    const reload = async () => {
      m.close();
      if (onChange) await onChange();
      await openBooking(id, onChange);
    };
    const editPayload = (d) => {
      const p = { staff_id: d.staff_id || null, bay: d.bay || null, mileage: d.mileage || null, admin_notes: d.admin_notes };
      if (d.scheduled_at) p.scheduled_at = d.scheduled_at.replace('T', ' ');
      return p;
    };
    m.el.querySelectorAll('[data-status]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const status = btn.dataset.status;
        if (status === 'cancelled' || status === 'no_show') {
          if (!(await confirmDialog(`${ACTION_LABEL[status]} for ${b.plate}?${b.amount_paid > 0 ? ` ${money(b.amount_paid)} has been paid — record a refund if needed.` : ''}`, { okLabel: ACTION_LABEL[status], danger: true }))) return;
        }
        try {
          const patch = { status };
          if (status === 'completed') Object.assign(patch, editPayload(UI.formData(m.el.querySelector('[data-edit]'))));
          const r = await api('PATCH', `/api/admin/bookings/${id}`, patch);
          toast(`Booking ${UI.STATUS[status].toLowerCase()}`, 'success');
          if (status === 'completed' && r.booking.balance > 0.004) {
            m.close();
            if (onChange) await onChange();
            paymentModal(r.booking, () => openBooking(id, onChange).then(() => onChange && onChange()));
            return;
          }
          await reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
    m.el.querySelector('[data-edit]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PATCH', `/api/admin/bookings/${id}`, editPayload(UI.formData(e.target)));
        toast('Booking updated', 'success');
        await reload();
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
    m.el.querySelector('[data-pricing]')?.addEventListener('click', () => pricingModal(b, reload));
    m.el.querySelector('[data-pay]')?.addEventListener('click', () => paymentModal(b, reload));
    m.el.querySelector('[data-refund]')?.addEventListener('click', () => paymentModal(b, reload, { refund: true }));
    m.el.querySelectorAll('[data-del-payment]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const p = b.payments.find((x) => x.id === Number(btn.dataset.delPayment));
        if (!(await confirmDialog(`Remove the ${money(Math.abs(p.amount))} ${p.method} ${p.amount < 0 ? 'refund' : 'payment'}? Only do this if it was entered by mistake.`, { okLabel: 'Remove', danger: true }))) return;
        try {
          await api('DELETE', `/api/admin/payments/${p.id}`);
          toast('Payment removed', 'success');
          await reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
    m.el.querySelector('[data-print]').addEventListener('click', () => printReceipt(b));
  }

  const LARGE = ['suv', 'pickup', 'van'];
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  /** Same order as the server: subtotal -> size surcharge -> staff discount -> points -> tax. */
  function billPreview({ subtotal, vehicleType, applySurcharge, discountType, discountValue, pointsDiscount = 0 }) {
    const st = UI.state.settings;
    const surcharge = applySurcharge && LARGE.includes(vehicleType) ? r2((subtotal * Number(st.large_vehicle_surcharge || 0)) / 100) : 0;
    const gross = r2(subtotal + surcharge);
    const v = Math.max(0, Number(discountValue) || 0);
    const manual = discountType === 'percent' ? r2((gross * Math.min(v, 100)) / 100) : r2(Math.min(v, gross));
    const points = r2(Math.min(pointsDiscount, gross - manual));
    const taxable = Math.max(0, gross - manual - points);
    const tax = r2((taxable * Number(st.tax_rate || 0)) / 100);
    return { subtotal: r2(subtotal), surcharge, manual, points, tax, total: r2(taxable + tax) };
  }

  function previewHtml(t) {
    const row = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
    return `<table class="price-lines"><tbody>${row('Subtotal', money(t.subtotal))}${t.surcharge ? row('Size surcharge', money(t.surcharge)) : ''}${t.manual ? row('Discount', '−' + money(t.manual)) : ''}${t.points ? row('Loyalty points', '−' + money(t.points)) : ''}${t.tax ? row('Tax', money(t.tax)) : ''}
      <tr class="total"><td>Total</td><td>${esc(money(t.total))}</td></tr></tbody></table>`;
  }

  const discountFields = (type = 'amount', value = '', reason = '') => `
    <div class="form-row">
      <div class="field"><label>Discount</label><div class="input-group"><select name="discount_type"><option value="amount" ${type === 'amount' ? 'selected' : ''}>${esc(UI.state.settings.currency)}</option><option value="percent" ${type === 'percent' ? 'selected' : ''}>%</option></select><input name="discount_value" type="number" min="0" step="any" value="${esc(value)}" placeholder="0"></div></div>
      <div class="field"><label>Reason</label><input name="discount_reason" maxlength="200" value="${esc(reason)}" placeholder="e.g. Regular customer, owner's friend"></div>
    </div>`;

  /** Change prices: package price, each extra (or remove it), add catalog extras or custom items, surcharge and discount. */
  function pricingModal(b, onDone) {
    const addons = cache.services.filter((x) => x.kind === 'addon' && x.active);
    const pointsDiscount = r2(b.discount - b.manual_discount);
    const large = LARGE.includes(b.vehicle_type);
    let custom = 0;
    const lineHtml = (key, { name, price, editableName, ref }) => `
      <div class="line-edit" data-line="${key}" ${ref ? `data-ref='${esc(JSON.stringify(ref))}'` : ''}>
        ${editableName ? `<input data-name value="${esc(name)}" placeholder="Item name" maxlength="80">` : `<span class="name">+ ${esc(name)}</span>`}
        <input data-price type="number" min="0" step="any" value="${esc(price)}">
        <button type="button" class="btn btn-ghost btn-sm" data-remove title="Remove">✕</button>
      </div>`;
    modal({
      title: `Price & discount — ${b.code}`,
      wide: true,
      submitLabel: 'Save prices',
      body: `
        <p class="muted" style="margin-top:0">Prices depend on the vehicle — enter what you are charging. ${pointsDiscount > 0 ? `${money(pointsDiscount)} of loyalty points stays applied.` : ''}</p>
        <div class="line-edit"><span class="name">${esc(b.service_name)}</span><input name="service_price" type="number" min="0" step="any" value="${esc(b.service_price)}" required><span></span></div>
        <div data-lines>${b.addons.map((a) => lineHtml(`a${a.id}`, { name: a.name, price: a.price, editableName: !a.service_id, ref: { id: a.id } })).join('')}</div>
        <div class="btn-row" style="margin:6px 0 16px">
          <select data-add-extra style="width:auto"><option value="">+ Add an extra…</option>${addons.map((a) => `<option value="${a.id}">${esc(a.name)} (${money(a.price)})</option>`).join('')}</select>
          <button type="button" class="btn btn-sm" data-add-custom>+ Custom item</button>
        </div>
        ${large ? `<label class="check" style="margin-bottom:12px"><input type="checkbox" name="apply_surcharge" ${b.surcharge > 0 ? 'checked' : ''}> Add size surcharge (${esc(UI.state.settings.large_vehicle_surcharge)}% for ${esc(cap(b.vehicle_type))})</label>` : ''}
        ${canDiscount() ? discountFields(b.manual_discount ? b.discount_type || 'amount' : 'amount', b.manual_discount ? b.discount_value || b.manual_discount : '', b.discount_reason || '') : b.manual_discount ? `<p class="muted">Discount: ${money(b.manual_discount)}${b.discount_reason ? ` (${esc(b.discount_reason)})` : ''} — only the admin can change discounts.</p>` : ''}
        <div class="bill-preview" data-preview></div>
        ${b.amount_paid > 0 ? `<small class="muted">Already paid: ${money(b.amount_paid)}. If the new total is lower, the difference shows as a refund due.</small>` : ''}`,
      onOpen: (el) => {
        const lines = el.querySelector('[data-lines]');
        const update = () => {
          const items = [...lines.querySelectorAll('[data-line]')].reduce((sum, row) => sum + (Number(row.querySelector('[data-price]').value) || 0), 0);
          const t = billPreview({
            subtotal: (Number(el.querySelector('[name=service_price]').value) || 0) + items,
            vehicleType: b.vehicle_type,
            applySurcharge: large ? el.querySelector('[name=apply_surcharge]').checked : false,
            discountType: el.querySelector('[name=discount_type]')?.value || b.discount_type || 'amount',
            discountValue: el.querySelector('[name=discount_value]') ? el.querySelector('[name=discount_value]').value : b.discount_value || b.manual_discount,
            pointsDiscount,
          });
          el.querySelector('[data-preview]').innerHTML = previewHtml(t);
        };
        el.addEventListener('input', update);
        el.addEventListener('change', update);
        lines.addEventListener('click', (e) => {
          if (e.target.closest('[data-remove]')) {
            e.target.closest('[data-line]').remove();
            update();
          }
        });
        el.querySelector('[data-add-extra]').addEventListener('change', (e) => {
          const a = addons.find((x) => x.id === Number(e.target.value));
          if (!a) return;
          lines.insertAdjacentHTML('beforeend', lineHtml(`s${a.id}-${custom++}`, { name: a.name, price: a.price, ref: { service_id: a.id } }));
          e.target.value = '';
          update();
        });
        el.querySelector('[data-add-custom]').addEventListener('click', () => {
          lines.insertAdjacentHTML('beforeend', lineHtml(`c${custom++}`, { name: '', price: '', editableName: true }));
          lines.lastElementChild.querySelector('[data-name]').focus();
          update();
        });
        update();
      },
      onSubmit: async (d, form) => {
        const items = [...form.querySelectorAll('[data-lines] [data-line]')].map((row) => {
          const ref = row.dataset.ref ? JSON.parse(row.dataset.ref) : {};
          const nameInput = row.querySelector('[data-name]');
          return { ...ref, ...(nameInput ? { name: nameInput.value } : {}), price: row.querySelector('[data-price]').value };
        });
        await api('PUT', `/api/admin/bookings/${b.id}/pricing`, {
          service_price: d.service_price,
          items,
          apply_surcharge: large ? d.apply_surcharge : false,
          ...(canDiscount() ? { discount_type: d.discount_type, discount_value: d.discount_value || 0, discount_reason: d.discount_reason } : {}),
        });
        toast('Prices updated', 'success');
        await onDone();
      },
    });
  }

  /** Take a payment, optionally split over several methods (e.g. part cash, part JazzCash). Or record a refund. */
  function paymentModal(b, onDone, { refund = false } = {}) {
    const methods = UI.state.paymentMethods;
    const due = refund ? (b.balance < -0.004 ? r2(-b.balance) : r2(b.amount_paid)) : r2(b.total - b.amount_paid);
    const rowHtml = (amount, method = methods[0]) => `
      <div class="pay-row" data-pay-row>
        <select data-method>${methods.map((x) => `<option ${x === method ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <input data-amount type="number" min="0" step="any" value="${esc(amount)}" placeholder="Amount">
        <input class="ref" data-ref placeholder="Reference / TID (optional)" maxlength="80">
        <button type="button" class="btn btn-ghost btn-sm" data-remove-row title="Remove">✕</button>
      </div>`;
    modal({
      title: refund ? `Refund — ${b.code}` : `Take payment — ${b.code}`,
      submitLabel: refund ? 'Record refund' : 'Record payment',
      wide: true,
      body: `
        <div class="balance ${refund ? 'settled' : ''}"><span>${refund ? (b.balance < -0.004 ? 'Refund due' : 'Paid so far') : 'Balance due'}</span><span>${money(due)}</span></div>
        ${refund ? `<p class="muted" style="margin-top:0">Paid so far: ${money(b.amount_paid)}. For a goodwill reduction, lower the price with “Price &amp; discount” first — the difference then shows as a refund due.</p>` : ''}
        <div data-rows>${rowHtml(due)}</div>
        ${refund ? '' : '<button type="button" class="btn btn-sm" data-split>+ Split with another method</button>'}
        <div class="field" style="margin-top:12px"><label>Note</label><input name="note" maxlength="200" placeholder="${refund ? 'Reason for the refund' : 'Optional'}"></div>
        <div class="muted" data-remaining></div>`,
      onOpen: (el) => {
        const rows = el.querySelector('[data-rows]');
        const sum = () => [...rows.querySelectorAll('[data-amount]')].reduce((s, i) => s + (Number(i.value) || 0), 0);
        const update = () => {
          const left = r2(due - sum());
          el.querySelector('[data-remaining]').textContent = refund ? '' : left > 0 ? `Still due after this: ${money(left)}` : left < 0 ? `That is ${money(-left)} more than the balance.` : 'This settles the bill.';
        };
        el.addEventListener('input', update);
        el.querySelector('[data-split]')?.addEventListener('click', () => {
          const used = new Set([...rows.querySelectorAll('[data-method]')].map((s) => s.value));
          rows.insertAdjacentHTML('beforeend', rowHtml(Math.max(0, r2(due - sum())) || '', methods.find((x) => !used.has(x)) || methods[0]));
          rows.lastElementChild.querySelector('[data-amount]').select();
          update();
        });
        rows.addEventListener('click', (e) => {
          if (e.target.closest('[data-remove-row]') && rows.children.length > 1) {
            e.target.closest('[data-pay-row]').remove();
            update();
          }
        });
        update();
      },
      onSubmit: async (d, form) => {
        const payments = [...form.querySelectorAll('[data-pay-row]')]
          .map((row) => ({ method: row.querySelector('[data-method]').value, amount: Number(row.querySelector('[data-amount]').value) || 0, reference: row.querySelector('[data-ref]').value, note: d.note }))
          .filter((p) => p.amount > 0)
          .map((p) => (refund ? { ...p, amount: -p.amount } : p));
        if (!payments.length) throw new Error('Enter an amount.');
        await api('POST', `/api/admin/bookings/${b.id}/payments`, { payments });
        toast(refund ? 'Refund recorded' : 'Payment recorded', 'success');
        await onDone();
      },
    });
  }

  function printReceipt(b) {
    const s = UI.state.settings;
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) return toast('Allow pop-ups to print receipts', 'error');
    w.document.write(`<!doctype html><html><head><title>Receipt ${esc(b.code)}</title><link rel="stylesheet" href="/css/style.css">
      <style>body{background:#fff;color:#000;padding:24px;font-size:14px}.price-lines td{color:#000}</style></head><body>
      <h2 style="margin:0">${esc(s.business_name)}</h2><div class="muted">${esc(s.tagline || '')}</div><div class="muted">${esc(s.address || '')} ${esc(s.phone || '')}</div><hr>
      <dl class="kv"><dt>Receipt</dt><dd>${esc(b.code)}</dd><dt>Date</dt><dd>${esc(fmtDateTime(b.completed_at || b.scheduled_at))}</dd>
      <dt>Vehicle</dt><dd>${esc(b.plate)} · ${esc(vehicleName(b))}</dd>${b.customer_name ? `<dt>Customer</dt><dd>${esc(b.customer_name)}</dd>` : ''}
      <dt>Payment</dt><dd>${esc(cap(b.payment_status))}${b.payment_method ? ` (${esc(cap(b.payment_method))})` : ''}</dd></dl><hr>
      ${UI.priceLines(b)}<hr><p style="text-align:center">Thank you for your visit!</p>
      <script>setTimeout(()=>print(),300)<\/script></body></html>`);
    w.document.close();
  }

  // =====================================================================
  // New booking / walk-in modal
  // =====================================================================
  async function newBooking({ vehicle, customer, onDone } = {}) {
    const packages = cache.services.filter((s) => s.kind === 'package' && s.active);
    const addons = cache.services.filter((s) => s.kind === 'addon' && s.active);
    const customers = vehicle || customer ? [] : (await api('GET', '/api/admin/customers')).customers.filter((c) => c.active);
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    const body = `
      ${
        vehicle
          ? `<div class="alert info">Vehicle: ${plate(vehicle.plate)} ${esc(vehicleName(vehicle))}${vehicle.owner_name ? ` · ${esc(vehicle.owner_name)}` : ''}</div>`
          : `<h3>Vehicle</h3>
             <div class="field"><small class="muted" style="margin:0 0 8px">If the plate is already known, its history is reused automatically.</small></div>
             ${UI.vehicleFields({})}
             ${customer ? `<div class="alert info">Customer: ${esc(customer.name)}</div>` : `<div class="field"><label>Customer account <small class="muted" style="display:inline">(optional)</small></label><select name="customer_id"><option value="">— Walk-in / no account —</option>${customers.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.phone || c.email)}</option>`).join('')}</select></div>`}`
      }
      <h3>Service</h3>
      <div class="field"><label>Package *</label><select name="service_id" required>${UI.byCategory(packages)
        .map(
          ([cat, list]) =>
            `<optgroup label="${esc(UI.CATEGORY[cat] || cat)}">${list
              .map((s) => `<option value="${s.id}">${esc(s.name)} — ${money(s.price)} · ${esc(UI.fmtDuration(s.duration_min))}${s.warranty_months ? ` · warranty ${esc(UI.fmtMonths(s.warranty_months))}` : ''}</option>`)
              .join('')}</optgroup>`,
        )
        .join('')}</select></div>
      <div class="field"><label>Extras</label><div class="grid grid-2" style="gap:6px">${addons.map((a) => `<label class="check"><input type="checkbox" name="addon_ids" value="${a.id}" data-array> ${esc(a.name)} <span class="muted">${money(a.price)}</span></label>`).join('')}</div></div>
      <h3>Price</h3>
      <div class="form-row">
        <div class="field"><label>Package price (${esc(UI.state.settings.currency)})</label><input name="service_price" type="number" min="0" step="any" required><small class="muted">Change it to match the vehicle (see your rate list).</small></div>
        <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="apply_surcharge" ${vehicle && !LARGE.includes(vehicle.type) ? '' : 'checked'}> Add size surcharge for SUV / pickup / van (${esc(UI.state.settings.large_vehicle_surcharge)}%)</label></div>
      </div>
      ${canDiscount() ? discountFields() : ''}
      <div class="bill-preview" data-preview style="margin-bottom:14px"></div>
      <h3>When &amp; who</h3>
      <label class="check" style="margin-bottom:10px"><input type="checkbox" name="start_now" checked> Start the job now (car is here)</label>
      <div class="field" data-when style="display:none"><label>Scheduled for</label><input type="datetime-local" name="scheduled_at" value="${now.toISOString().slice(0, 16)}"></div>
      <div class="form-row form-row-3">
        <div class="field"><label>Staff</label><select name="staff_id">${staffOptions(null)}</select></div>
        <div class="field"><label>Bay</label><input type="number" min="1" name="bay"></div>
        <div class="field"><label>Mileage</label><input type="number" min="0" name="mileage"></div>
      </div>
      <div class="field"><label>Internal notes</label><input name="admin_notes" placeholder="e.g. scratch on driver door"></div>`;
    modal({
      title: 'New booking / walk-in',
      body,
      wide: true,
      submitLabel: 'Create booking',
      onOpen: (el) => {
        const cb = el.querySelector('[name=start_now]');
        cb.addEventListener('change', () => (el.querySelector('[data-when]').style.display = cb.checked ? 'none' : ''));
        const pkg = el.querySelector('[name=service_id]');
        const price = el.querySelector('[name=service_price]');
        const setPrice = () => (price.value = packages.find((x) => x.id === Number(pkg.value))?.price ?? '');
        pkg.addEventListener('change', setPrice);
        setPrice();
        const update = () => {
          const extras = [...el.querySelectorAll('[name=addon_ids]:checked')].reduce((sum, i) => sum + (addons.find((a) => a.id === Number(i.value))?.price || 0), 0);
          const type = vehicle ? vehicle.type : el.querySelector('[name=type]')?.value;
          el.querySelector('[data-preview]').innerHTML = previewHtml(
            billPreview({
              subtotal: (Number(price.value) || 0) + extras,
              vehicleType: type,
              applySurcharge: el.querySelector('[name=apply_surcharge]').checked,
              discountType: el.querySelector('[name=discount_type]')?.value || 'amount',
              discountValue: el.querySelector('[name=discount_value]')?.value || 0,
            }),
          );
        };
        el.addEventListener('input', update);
        el.addEventListener('change', update);
        update();
      },
      onSubmit: async (d) => {
        const payload = {
          service_id: d.service_id,
          addon_ids: d.addon_ids || [],
          start_now: d.start_now,
          scheduled_at: d.start_now ? undefined : d.scheduled_at,
          staff_id: d.staff_id || null,
          bay: d.bay || null,
          mileage: d.mileage || null,
          service_price: d.service_price,
          apply_surcharge: d.apply_surcharge,
          ...(canDiscount() ? { discount_type: d.discount_type, discount_value: d.discount_value || 0, discount_reason: d.discount_reason } : {}),
          admin_notes: d.admin_notes,
        };
        if (vehicle) payload.vehicle_id = vehicle.id;
        else payload.vehicle = { plate: d.plate, make: d.make, model: d.model, year: d.year, color: d.color, type: d.type };
        payload.customer_id = customer ? customer.id : d.customer_id || null;
        const { booking } = await api('POST', '/api/admin/bookings', payload);
        toast(`Booking ${booking.code} created`, 'success');
        if (onDone) await onDone(booking);
        else location.hash = `#/vehicles/${booking.vehicle_id}`;
      },
    });
  }

  // =====================================================================
  // Dashboard
  // =====================================================================
  async function dashboard() {
    const s = await api('GET', '/api/admin/stats');
    const t = s.today;
    const followupRow = (f) => {
      const what =
        f.reason === 'maintenance'
          ? `${f.maintenance_status === 'overdue' ? 'Maintenance overdue since' : 'Maintenance due'} ${esc(fmtDate(f.due_at))} <span class="badge ${f.maintenance_status}">${f.maintenance_status === 'overdue' ? 'Overdue' : 'Due soon'}</span>`
          : `Warranty ends ${esc(fmtDate(f.due_at))} <span class="badge expiring">Expiring</span>`;
      const contact = f.owner_id ? `${esc(f.owner_name)}${f.owner_phone ? ` · <a href="tel:${esc(f.owner_phone)}">${esc(f.owner_phone)}</a>` : f.owner_email ? ` · ${esc(f.owner_email)}` : ''}` : 'Walk-in (no account)';
      return `<div class="followup">
        <a href="#/vehicles/${f.vehicle_id}">${plate(f.plate)}</a>
        <div class="what"><b>${esc(f.name)}</b> — ${what}<small class="muted">${esc(vehicleName(f))} · ${contact}</small></div>
        <div>${f.active_bookings ? '<span class="badge confirmed">Booked</span>' : `<button class="btn btn-sm btn-primary" data-followup="${f.id}">Book visit</button>`}</div>
      </div>`;
    };
    const queueRow = (b) => {
      const next = NEXT[b.status];
      return `<tr class="clickable" data-booking="${b.id}">
        <td style="white-space:nowrap"><b>${esc(fmtTime(b.scheduled_at))}</b>${b.scheduled_at.slice(0, 10) !== UI.localDate() ? `<br><small>${esc(fmtShortDate(b.scheduled_at))}</small>` : ''}</td>
        <td>${vehicleLink(b)}<div class="muted" style="font-size:.8rem">${esc(vehicleName(b))}${b.color ? ` · ${esc(b.color)}` : ''}</div></td>
        <td>${esc(b.service_name)}${addonsText(b)}${UI.readyText(b) ? `<div>${UI.readyText(b)}</div>` : ''}</td>
        <td>${esc(b.customer_name || 'Walk-in')}</td>
        <td>${esc(b.staff_name || '—')}${b.bay ? `<br><small>Bay ${b.bay}</small>` : ''}</td>
        <td>${statusBadge(b.status)}</td>
        <td class="num">${money(b.total)}</td>
        <td class="num">${next ? `<button class="btn btn-sm ${next[0] === 'completed' ? 'btn-success' : 'btn-primary'}" data-quick="${b.id}" data-to="${next[0]}">${next[1]}</button>` : b.status === 'completed' && ['unpaid', 'partial'].includes(b.payment_status) ? `<button class="btn btn-sm btn-success" data-paid="${b.id}">Take payment</button>${b.payment_status === 'partial' ? `<br><small class="muted">${money(b.total - b.amount_paid)} due</small>` : ''}` : ''}</td>
      </tr>`;
    };
    setPage(`
      ${pageHead('Dashboard', esc(fmtDate(UI.localDate() + ' 12:00')), '<button class="btn btn-primary" data-new>+ New booking / walk-in</button>')}
      <div class="grid grid-4">
        <div class="card stat"><span class="label">Today's bookings</span><span class="value">${t.total || 0}</span><span class="sub">${t.waiting || 0} waiting · ${t.in_progress || 0} in progress · ${t.completed || 0} done</span></div>
        ${
          isAdmin
            ? `<div class="card stat"><span class="label">Revenue today</span><span class="value">${money(t.revenue)}</span><span class="sub">This month: ${money(s.month.revenue)}</span></div>
        <div class="card stat"><span class="label">Collected today</span><span class="value">${money(s.collected_today.reduce((sum, m) => sum + m.amount, 0))}</span><span class="sub">${s.collected_today.length ? s.collected_today.map((m) => `${esc(m.method)} ${money(m.amount)}`).join(' · ') : 'No payments yet'}${s.unpaid.count ? `<br><a href="#/bookings?payment=due">${money(s.unpaid.amount)} still due on ${s.unpaid.count} job${s.unpaid.count === 1 ? '' : 's'}</a>` : ''}</span></div>
        <div class="card stat"><span class="label">Customer rating</span><span class="value">${s.totals.avg_rating ? `${s.totals.avg_rating} ★` : '—'}</span><span class="sub">${s.totals.customers} customers · ${s.totals.vehicles} vehicles</span></div>`
            : `<div class="card stat"><span class="label">In the bays</span><span class="value">${t.in_progress || 0}</span><span class="sub">${t.waiting || 0} waiting</span></div>
               <div class="card stat"><span class="label">Follow-ups</span><span class="value">${s.followups.length}</span><span class="sub">coating &amp; PPF customers to call</span></div>
               <div class="card stat"><span class="label">Low stock</span><span class="value">${s.low_stock.length}</span><span class="sub"><a href="#/inventory">Inventory →</a></span></div>`
        }
      </div>
      ${s.totals.pending_total ? `<div class="alert info" style="margin-top:16px">${s.totals.pending_total} online booking${s.totals.pending_total > 1 ? 's are' : ' is'} waiting for confirmation. <a href="#/bookings?status=pending">Review →</a></div>` : ''}
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Today's queue</h2><a href="#/bookings?status=active" class="btn btn-sm">All active bookings</a></div>
        <div class="table-wrap"><table><thead><tr><th>Time</th><th>Vehicle</th><th>Service</th><th>Customer</th><th>Staff</th><th>Status</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${s.queue.length ? s.queue.map(queueRow).join('') : '<tr><td colspan="8" class="empty">No cars scheduled for today yet.</td></tr>'}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Follow-ups: coating &amp; PPF care</h2><span class="muted">${s.followups.length ? `${s.followups.length} to contact` : ''}</span></div>
        ${s.followups.length ? s.followups.slice(0, 10).map(followupRow).join('') : '<div class="empty">No maintenance visits due and no warranties expiring in the next 30 days.</div>'}
      </div>
      ${
        s.low_stock.length
          ? `<div class="card" style="margin-top:16px"><div class="card-head"><h2>📦 Low stock</h2><a href="#/inventory" class="btn btn-sm">Inventory</a></div>
              <div class="btn-row">${s.low_stock.map((i) => `<span class="badge ${i.quantity <= 0 ? 'overdue' : 'due_soon'}">${esc(i.name)}: ${esc(fmtQty(i.quantity))} ${esc(i.unit)} (reorder at ${esc(fmtQty(i.min_quantity))})</span>`).join('')}</div></div>`
          : ''
      }
      ${
        isAdmin
          ? `<div class="grid grid-3" style="margin-top:16px">
        <div class="card span-2"><div class="card-head"><h2>Revenue — last 14 days</h2></div>
          ${UI.barChart(s.revenue_14d.map((d) => ({ label: fmtShortDate(d.day).replace(' ', ' '), value: d.revenue, title: `${fmtDate(d.day)}: ${money(d.revenue)} · ${d.washes} jobs` })), { format: money })}</div>
        <div class="card"><div class="card-head"><h2>Top packages (30 days)</h2></div>${UI.hbars(s.top_services.map((x) => ({ name: x.name, value: x.count, display: `${x.count}×` })))}</div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Latest feedback</h2></div>
        ${s.recent_feedback.length ? s.recent_feedback.map((f) => `<div class="note"><div class="meta"><span>${stars(f.rating)} · ${plate(f.plate)} · ${esc(f.customer_name || 'Walk-in')}</span><span>${esc(timeAgo(f.completed_at))}</span></div>${f.feedback ? esc(f.feedback) : '<span class="muted">No comment</span>'}</div>`).join('') : '<div class="empty">No ratings yet.</div>'}
      </div>`
          : ''
      }`);
    main.querySelector('[data-new]').addEventListener('click', () => newBooking({ onDone: dashboard }));
    main.querySelectorAll('[data-followup]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const f = s.followups.find((x) => x.id === Number(btn.dataset.followup));
        newBooking({ vehicle: { id: f.vehicle_id, plate: f.plate, make: f.make, model: f.model, year: f.year, type: f.type, owner_name: f.owner_name }, onDone: dashboard });
      }),
    );
    main.querySelectorAll('[data-booking]').forEach((tr) => tr.addEventListener('click', (e) => !e.target.closest('button, a') && openBooking(tr.dataset.booking, dashboard)));
    main.querySelectorAll('[data-quick]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('PATCH', `/api/admin/bookings/${btn.dataset.quick}`, { status: btn.dataset.to });
          toast(`Booking ${UI.STATUS[btn.dataset.to].toLowerCase()}`, 'success');
          dashboard();
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
      }),
    );
    main.querySelectorAll('[data-paid]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const { booking } = await api('GET', `/api/admin/bookings/${btn.dataset.paid}`);
        paymentModal(booking, dashboard);
      }),
    );
  }

  // =====================================================================
  // Bookings
  // =====================================================================
  async function bookings(_p, query) {
    const q = { status: query.status || '', from: query.from || '', to: query.to || '', q: query.q || '', payment: query.payment || '' };
    setPage(`
      ${pageHead('Bookings', 'All online and walk-in bookings.', '<button class="btn btn-primary" data-new>+ New booking / walk-in</button>')}
      <div class="card">
        <form class="filters" data-filters>
          <input type="search" name="q" placeholder="Search plate, code, customer, phone…" value="${esc(q.q)}">
          <select name="status"><option value="">All statuses</option><option value="active" ${q.status === 'active' ? 'selected' : ''}>Active (not finished)</option>${Object.entries(UI.STATUS).map(([k, v]) => `<option value="${k}" ${q.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <select name="payment"><option value="">Any payment</option>${[['due', 'Balance due'], ['unpaid', 'Unpaid'], ['partial', 'Partly paid'], ['paid', 'Paid'], ['refunded', 'Refunded']].map(([k, l]) => `<option value="${k}" ${q.payment === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input type="date" name="from" value="${esc(q.from)}" title="From">
          <input type="date" name="to" value="${esc(q.to)}" title="To">
          <button class="btn" type="submit">Filter</button>
          <button class="btn btn-ghost" type="button" data-today>Today</button>
          <button class="btn btn-ghost" type="button" data-clear>Clear</button>
        </form>
        <div data-results><div class="loading">Loading…</div></div>
      </div>`);
    const form = main.querySelector('[data-filters]');
    const apply = (d) => (location.hash = '#/bookings?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)).toString());
    form.addEventListener('submit', (e) => (e.preventDefault(), apply(UI.formData(form))));
    main.querySelector('[data-clear]').addEventListener('click', () => (location.hash = '#/bookings'));
    main.querySelector('[data-today]').addEventListener('click', () => apply({ ...UI.formData(form), from: UI.localDate(), to: UI.localDate() }));
    main.querySelector('[data-new]').addEventListener('click', () => newBooking({ onDone: () => bookings(_p, query) }));

    const { bookings: list } = await api('GET', '/api/admin/bookings?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString());
    const total = list.filter((b) => b.status === 'completed').reduce((s, b) => s + b.total, 0);
    main.querySelector('[data-results]').innerHTML = `
      <div class="muted" style="margin-bottom:8px">${list.length} booking${list.length === 1 ? '' : 's'} · completed revenue ${money(total)}</div>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Scheduled</th><th>Vehicle</th><th>Customer</th><th>Service</th><th>Staff</th><th>Status</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>
      ${
        list.length
          ? list
              .map(
                (b) => `<tr class="clickable" data-booking="${b.id}">
          <td class="mono">${esc(b.code)}${b.source === 'walk_in' ? '<br><small>walk-in</small>' : ''}</td>
          <td>${esc(fmtDate(b.scheduled_at))}<br><small>${esc(fmtTime(b.scheduled_at))}</small></td>
          <td>${vehicleLink(b)}<div class="muted" style="font-size:.8rem">${esc(vehicleName(b))}</div></td>
          <td>${b.customer_id ? `<a href="#/customers/${b.customer_id}">${esc(b.customer_name)}</a>` : '<span class="muted">Walk-in</span>'}</td>
          <td>${esc(b.service_name)}${addonsText(b)}${UI.readyText(b) ? `<div>${UI.readyText(b)}</div>` : ''}</td>
          <td>${esc(b.staff_name || '—')}</td>
          <td>${statusBadge(b.status)}${b.rating ? `<br>${stars(b.rating)}` : ''}</td>
          <td>${payBadge(b.payment_status)}</td>
          <td class="num">${money(b.total)}</td></tr>`,
              )
              .join('')
          : '<tr><td colspan="9" class="empty">No bookings match these filters.</td></tr>'
      }</tbody></table></div>`;
    main.querySelectorAll('[data-booking]').forEach((tr) => tr.addEventListener('click', (e) => !e.target.closest('a') && openBooking(tr.dataset.booking, () => bookings(_p, query))));
  }

  // =====================================================================
  // Vehicles list
  // =====================================================================
  async function vehicles(_p, query) {
    setPage(`
      ${pageHead('Vehicles & history', 'Every car that has visited, with its complete service history and coating / PPF warranties.', '<button class="btn" data-add>+ Add vehicle</button><button class="btn btn-primary" data-new>+ Walk-in</button>')}
      <div class="card">
        <form class="filters" data-search><input type="search" name="q" placeholder="Search by plate, make, model, colour or owner…" value="${esc(query.q || '')}"><button class="btn">Search</button></form>
        <div data-results><div class="loading">Loading…</div></div>
      </div>`);
    const form = main.querySelector('[data-search]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = UI.formData(form).q;
      location.hash = q ? `#/vehicles?q=${encodeURIComponent(q)}` : '#/vehicles';
    });
    main.querySelector('[data-new]').addEventListener('click', () => newBooking());
    main.querySelector('[data-add]').addEventListener('click', () => editVehicle(null, (v) => (location.hash = `#/vehicles/${v.id}`)));
    const { vehicles: list } = await api('GET', '/api/admin/vehicles' + (query.q ? `?q=${encodeURIComponent(query.q)}` : ''));
    main.querySelector('[data-results]').innerHTML = `
      <div class="table-wrap"><table><thead><tr><th>Plate</th><th>Vehicle</th><th>Owner</th><th class="num">Visits</th><th class="num">Total spent</th><th>Last visit</th><th></th></tr></thead><tbody>
      ${
        list.length
          ? list
              .map(
                (v) => `<tr class="clickable" data-vehicle="${v.id}">
          <td>${plate(v.plate)}</td>
          <td><b>${esc(vehicleName(v))}</b><div class="muted" style="font-size:.8rem">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''}</div>${v.protection_categories ? `<div style="margin-top:4px" class="btn-row">${v.protection_categories.split(',').map((c) => UI.catBadge(c)).join('')}</div>` : ''}</td>
          <td>${v.owner_id ? `<a href="#/customers/${v.owner_id}">${esc(v.owner_name)}</a><div class="muted" style="font-size:.8rem">${esc(v.owner_phone || '')}</div>` : '<span class="muted">Walk-in</span>'}</td>
          <td class="num">${v.washes}</td>
          <td class="num">${money(v.total_spent)}</td>
          <td>${v.last_wash ? `${esc(fmtShortDate(v.last_wash))}<br><small>${esc(timeAgo(v.last_wash))}</small>` : '<span class="muted">Never</span>'}</td>
          <td>${v.active_bookings ? '<span class="badge in_progress">Active booking</span>' : ''}</td></tr>`,
              )
              .join('')
          : '<tr><td colspan="7" class="empty">No vehicles found.</td></tr>'
      }</tbody></table></div>`;
    main.querySelectorAll('[data-vehicle]').forEach((tr) => tr.addEventListener('click', (e) => !e.target.closest('a') && (location.hash = `#/vehicles/${tr.dataset.vehicle}`)));
  }

  async function editVehicle(v, onSaved) {
    const customers = (await api('GET', '/api/admin/customers')).customers;
    modal({
      title: v ? `Edit ${v.plate}` : 'Add vehicle',
      body: `${UI.vehicleFields(v || {})}
        <div class="field"><label>Owner</label><select name="owner_id"><option value="">— No account (walk-in) —</option>${customers.map((c) => `<option value="${c.id}" ${v && v.owner_id === c.id ? 'selected' : ''}>${esc(c.name)} · ${esc(c.email)}</option>`).join('')}</select></div>
        <div class="field"><label>Vehicle notes</label><textarea name="notes" placeholder="Anything staff should know about this car">${esc(v?.notes)}</textarea></div>`,
      onSubmit: async (d) => {
        d.owner_id = d.owner_id || null;
        const { vehicle } = v ? await api('PATCH', `/api/admin/vehicles/${v.id}`, d) : await api('POST', '/api/admin/vehicles', d);
        toast('Vehicle saved', 'success');
        onSaved(vehicle);
      },
    });
  }

  // =====================================================================
  // Vehicle detail — complete history
  // =====================================================================
  async function vehicleDetail({ id }, query) {
    const h = await api('GET', `/api/admin/vehicles/${id}`);
    const { vehicle: v, stats: st, bookings: list, notes, protections } = h;
    const filter = query.show || 'all';
    const shown = list.filter((b) => filter === 'all' || (filter === 'completed' ? b.status === 'completed' : filter === 'other' ? b.status !== 'completed' : true));
    const statTile = (label, value, sub = '') => `<div class="card stat"><span class="label">${label}</span><span class="value" style="font-size:1.3rem">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

    const historyItem = (b) => `
      <details class="history-item">
        <summary>
          <div><div class="date">${esc(fmtShortDate(b.scheduled_at))} ${esc(b.scheduled_at.slice(0, 4))}</div><small>${esc(fmtTime(b.scheduled_at))} · <span class="mono">${esc(b.code)}</span></small></div>
          <div><b>${esc(b.service_name)}</b>${addonsText(b)}</div>
          <div>${statusBadge(b.status)} ${b.rating ? stars(b.rating) : ''}</div>
          <div class="num"><b>${money(b.total)}</b></div>
        </summary>
        <div class="body grid grid-3">
          <div>
            <h3>Details</h3>
            <dl class="kv">
              <dt>Customer</dt><dd>${b.customer_id ? `<a href="#/customers/${b.customer_id}">${esc(b.customer_name)}</a>` : 'Walk-in'}</dd>
              <dt>Staff</dt><dd>${esc(b.staff_name || '—')}</dd>
              <dt>Bay</dt><dd>${esc(b.bay || '—')}</dd>
              <dt>Mileage</dt><dd>${b.mileage ? esc(b.mileage.toLocaleString()) : '—'}</dd>
              <dt>Source</dt><dd>${b.source === 'walk_in' ? 'Walk-in' : 'Online'}</dd>
              <dt>Payment</dt><dd>${payBadge(b.payment_status)} ${esc(cap(b.payment_method || ''))}</dd>
              ${b.started_at && b.completed_at ? `<dt>Time in bay</dt><dd>${Math.max(1, Math.round((new Date(b.completed_at.replace(' ', 'T')) - new Date(b.started_at.replace(' ', 'T'))) / 60000))} min</dd>` : ''}
            </dl>
          </div>
          <div>
            <h3>Charges</h3>${UI.priceLines(b)}
            ${b.customer_notes ? `<div class="note" style="margin-top:10px"><div class="meta">Customer note</div>${esc(b.customer_notes)}</div>` : ''}
            ${b.admin_notes ? `<div class="note warning"><div class="meta">Internal note</div>${esc(b.admin_notes)}</div>` : ''}
            ${b.rating ? `<div class="note preference"><div class="meta">Customer rating ${stars(b.rating)}</div>${esc(b.feedback || '')}</div>` : ''}
          </div>
          <div><h3>Timeline</h3>${UI.timeline(b.events)}<button class="btn btn-sm" data-booking="${b.id}">Open booking</button></div>
        </div>
      </details>`;

    setPage(`
      <div class="no-print" style="margin-bottom:12px"><a href="#/vehicles">← All vehicles</a></div>
      <div class="card">
        <div class="page-head" style="margin:0">
          <div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${plate(v.plate, 'lg')}<h1 style="margin:0">${esc(vehicleName(v))}</h1></div>
            <p style="margin-top:8px">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''} · first seen ${esc(fmtDate(v.created_at))}</p>
            <p style="margin-top:4px">Owner: ${v.owner_id ? `<a href="#/customers/${v.owner_id}"><b>${esc(v.owner_name)}</b></a> · ${esc(v.owner_phone || v.owner_email || '')}` : '<span class="muted">No account (walk-in)</span>'}</p>
            ${v.notes ? `<p style="margin-top:4px"><small>📝 ${esc(v.notes)}</small></p>` : ''}
          </div>
          <div class="btn-row no-print">
            <button class="btn btn-primary" data-new ${st.next_booking ? 'disabled title="This vehicle already has an active booking"' : ''}>+ New booking</button>
            <button class="btn" data-edit>Edit vehicle</button>
            <button class="btn" onclick="window.print()">🖨 Print history</button>
          </div>
        </div>
      </div>
      ${st.next_booking ? `<div class="alert info" style="margin-top:16px">Active booking: <b>${esc(st.next_booking.service_name)}</b> on ${esc(fmtDateTime(st.next_booking.scheduled_at))} — ${statusBadge(st.next_booking.status)} <a href="#" data-booking="${st.next_booking.id}">Open →</a></div>` : ''}
      <div class="grid grid-4" style="margin-top:16px">
        ${statTile('Completed visits', st.completed_washes, `${st.total_bookings} bookings total${st.cancelled ? ` · ${st.cancelled} cancelled` : ''}${st.no_shows ? ` · ${st.no_shows} no-show` : ''}`)}
        ${statTile('Total spent', money(st.total_spent), `avg ${money(st.average_ticket)} per visit`)}
        ${statTile('Last visit', st.last_visit ? esc(timeAgo(st.last_visit)) : 'Never', st.last_visit ? esc(fmtDate(st.last_visit)) : '')}
        ${statTile('Visit frequency', st.avg_days_between ? `every ${st.avg_days_between} days` : '—', st.first_visit ? `customer since ${esc(fmtShortDate(st.first_visit))} ${esc(st.first_visit.slice(0, 4))}` : '')}
        ${statTile('Favourite package', esc(st.favourite_service || '—'))}
        ${statTile('Average rating', st.average_rating ? `${st.average_rating} ★` : '—')}
        ${statTile('Last mileage', st.last_mileage ? esc(st.last_mileage.toLocaleString()) : '—')}
        ${statTile('Notes on file', notes.length, notes.filter((n) => n.kind === 'damage').length ? `${notes.filter((n) => n.kind === 'damage').length} damage report(s)` : '')}
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Protection &amp; warranty</h2>${isAdmin ? '<button class="btn btn-sm no-print" data-add-protection>+ Add coating / PPF record</button>' : ''}</div>
        ${
          protections.length
            ? UI.protectionCards(protections, { admin: isAdmin })
            : '<div class="muted">No ceramic coating or PPF on record. A record is created automatically when a coating or PPF job is completed — use “Add” for work done before.</div>'
        }
      </div>
      <div class="grid grid-3" style="margin-top:16px">
        <div class="card span-2">
          <div class="card-head"><h2>Service history</h2>
            <div class="btn-row no-print">${[['all', 'All'], ['completed', 'Completed'], ['other', 'Cancelled / upcoming']].map(([k, l]) => `<a class="btn btn-sm ${filter === k ? 'btn-primary' : ''}" href="#/vehicles/${v.id}?show=${k}">${l}</a>`).join('')}</div>
          </div>
          ${shown.length ? shown.map(historyItem).join('') : '<div class="empty">No services recorded for this vehicle yet.</div>'}
        </div>
        <div class="card">
          <div class="card-head"><h2>Vehicle notes</h2></div>
          <form data-note class="no-print">
            <div class="field"><select name="kind"><option value="general">General</option><option value="damage">Damage / pre-existing</option><option value="preference">Customer preference</option><option value="warning">Warning</option></select></div>
            <div class="field"><textarea name="note" placeholder="e.g. Dent on rear left door (pre-existing)" required></textarea></div>
            <button class="btn btn-primary btn-sm">Add note</button>
          </form>
          <div style="margin-top:14px">${
            notes.length
              ? notes
                  .map(
                    (n) => `<div class="note ${esc(n.kind)}"><div class="meta"><span><span class="badge ${esc(n.kind)}">${esc(cap(n.kind))}</span> ${esc(fmtDateTime(n.created_at))}${n.author_name ? ` · ${esc(n.author_name)}` : ''}</span>
                     ${isAdmin ? `<button class="btn btn-ghost btn-sm no-print" data-del-note="${n.id}" title="Delete">✕</button>` : ''}</div>${esc(n.note)}</div>`,
                  )
                  .join('')
              : '<div class="muted">No notes yet. Use notes to record damage, special requests or anything staff should know.</div>'
          }</div>
        </div>
      </div>`);

    const reload = () => vehicleDetail({ id }, query);
    main.querySelectorAll('[data-booking]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openBooking(el.dataset.booking, reload);
      }),
    );
    main.querySelector('[data-new]').addEventListener('click', () => newBooking({ vehicle: v, onDone: reload }));
    main.querySelector('[data-edit]').addEventListener('click', () => editVehicle(v, reload));
    main.querySelector('[data-add-protection]')?.addEventListener('click', () => protectionForm(v, null, reload));
    main.querySelectorAll('[data-edit-protection]').forEach((b) =>
      b.addEventListener('click', () => protectionForm(v, protections.find((p) => p.id === Number(b.dataset.editProtection)), reload)),
    );
    main.querySelectorAll('[data-del-protection]').forEach((b) =>
      b.addEventListener('click', async () => {
        const p = protections.find((x) => x.id === Number(b.dataset.delProtection));
        if (!(await confirmDialog(`Delete the "${p.name}" record from ${v.plate}? Its warranty and maintenance reminders will be removed.`, { okLabel: 'Delete', danger: true }))) return;
        await api('DELETE', `/api/admin/protections/${p.id}`);
        toast('Record deleted', 'success');
        reload();
      }),
    );
    main.querySelector('[data-note]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/admin/vehicles/${v.id}/notes`, UI.formData(e.target));
        toast('Note added', 'success');
        reload();
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
    main.querySelectorAll('[data-del-note]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmDialog('Delete this note?', { okLabel: 'Delete', danger: true }))) return;
        await api('DELETE', `/api/admin/vehicles/${v.id}/notes/${b.dataset.delNote}`);
        reload();
      }),
    );
  }

  /** Add or edit a ceramic coating / PPF record on a vehicle. */
  function protectionForm(v, p, onSaved) {
    const templates = cache.services.filter((x) => x.warranty_months || x.maintenance_months);
    modal({
      title: p ? `Edit ${p.name}` : `Add coating / PPF record — ${v.plate}`,
      body: `
        ${
          p
            ? ''
            : `<div class="field"><label>Fill in from a service</label><select data-template><option value="">— Choose (optional) —</option>${templates
                .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
                .join('')}</select></div>`
        }
        <div class="form-row">
          <div class="field"><label>Name *</label><input name="name" required value="${esc(p?.name)}" placeholder="e.g. Ceramic Coating – 3 Years"></div>
          <div class="field"><label>Type</label><select name="category">${UI.CATEGORY_ORDER.map((c) => `<option value="${c}" ${(p?.category || 'ceramic') === c ? 'selected' : ''}>${esc(UI.CATEGORY[c])}</option>`).join('')}</select></div>
        </div>
        <div class="form-row form-row-3">
          <div class="field"><label>Applied on</label><input type="date" name="applied_at" required value="${esc(p?.applied_at || UI.localDate())}"></div>
          <div class="field"><label>Warranty (months)</label><input type="number" min="0" max="600" name="warranty_months" value="${esc(p?.warranty_months)}" placeholder="e.g. 36"></div>
          <div class="field"><label>Maintenance every (months)</label><input type="number" min="0" max="600" name="maintenance_months" value="${esc(p?.maintenance_months)}" placeholder="e.g. 6"></div>
        </div>
        <div class="field"><label>Details <small class="muted" style="display:inline">(shown to the customer)</small></label><textarea name="details" placeholder="Product, number of layers, panels covered, warranty card no.…">${esc(p?.details)}</textarea></div>`,
      onOpen: (el) => {
        el.querySelector('[data-template]')?.addEventListener('change', (e) => {
          const t = templates.find((x) => x.id === Number(e.target.value));
          if (!t) return;
          el.querySelector('[name=name]').value = t.name;
          el.querySelector('[name=category]').value = t.category;
          el.querySelector('[name=warranty_months]').value = t.warranty_months || '';
          el.querySelector('[name=maintenance_months]').value = t.maintenance_months || '';
        });
      },
      onSubmit: async (d) => {
        if (p) await api('PATCH', `/api/admin/protections/${p.id}`, d);
        else await api('POST', `/api/admin/vehicles/${v.id}/protections`, d);
        toast('Saved', 'success');
        await onSaved();
      },
    });
  }

  // =====================================================================
  // Customers
  // =====================================================================
  async function customers(_p, query) {
    setPage(`
      ${pageHead('Customers', 'Registered customer accounts.', '<button class="btn btn-primary" data-add>+ Add customer</button>')}
      <div class="card">
        <form class="filters" data-search><input type="search" name="q" placeholder="Search name, email or phone…" value="${esc(query.q || '')}"><button class="btn">Search</button></form>
        <div data-results><div class="loading">Loading…</div></div>
      </div>`);
    const form = main.querySelector('[data-search]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = UI.formData(form).q;
      location.hash = q ? `#/customers?q=${encodeURIComponent(q)}` : '#/customers';
    });
    main.querySelector('[data-add]').addEventListener('click', () =>
      modal({
        title: 'Add customer',
        body: `<div class="field"><label>Name *</label><input name="name" required></div>
          <div class="form-row"><div class="field"><label>Email *</label><input name="email" type="email" required></div><div class="field"><label>Phone</label><input name="phone"></div></div>
          <div class="field"><label>Password</label><input name="password" placeholder="Leave blank to generate one"><small class="muted">Share this with the customer so they can log in.</small></div>`,
        submitLabel: 'Create',
        onSubmit: async (d) => {
          const r = await api('POST', '/api/admin/customers', d);
          modal({ title: 'Customer created', body: `<p><b>${esc(r.customer.name)}</b> can now sign in with:</p><dl class="kv"><dt>Email</dt><dd>${esc(r.customer.email)}</dd><dt>Password</dt><dd class="mono">${esc(r.password)}</dd></dl>` });
          location.hash = `#/customers/${r.customer.id}`;
        },
      }),
    );
    const { customers: list } = await api('GET', '/api/admin/customers' + (query.q ? `?q=${encodeURIComponent(query.q)}` : ''));
    main.querySelector('[data-results]').innerHTML = `
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Contact</th><th class="num">Vehicles</th><th class="num">Visits</th><th class="num">Spent</th><th class="num">Points</th><th>Last visit</th><th>Status</th></tr></thead><tbody>
      ${
        list.length
          ? list
              .map(
                (c) => `<tr class="clickable" data-customer="${c.id}">
          <td><b>${esc(c.name)}</b><div class="muted" style="font-size:.8rem">since ${esc(fmtShortDate(c.created_at))} ${esc(c.created_at.slice(0, 4))}</div></td>
          <td>${esc(c.email)}<div class="muted" style="font-size:.8rem">${esc(c.phone || '')}</div></td>
          <td class="num">${c.vehicles}</td><td class="num">${c.washes}</td><td class="num">${money(c.total_spent)}</td><td class="num">${c.loyalty_points}</td>
          <td>${c.last_visit ? esc(timeAgo(c.last_visit)) : '<span class="muted">Never</span>'}</td>
          <td>${c.active ? '<span class="badge active">Active</span>' : '<span class="badge inactive">Disabled</span>'}</td></tr>`,
              )
              .join('')
          : '<tr><td colspan="8" class="empty">No customers found.</td></tr>'
      }</tbody></table></div>`;
    main.querySelectorAll('[data-customer]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/customers/${tr.dataset.customer}`)));
  }

  async function customerDetail({ id }) {
    const { customer: c, vehicles: vs, bookings: bs, stats } = await api('GET', `/api/admin/customers/${id}`);
    const reload = () => customerDetail({ id });
    setPage(`
      <div style="margin-bottom:12px"><a href="#/customers">← All customers</a></div>
      <div class="card"><div class="page-head" style="margin:0">
        <div><h1>${esc(c.name)} ${c.active ? '' : '<span class="badge inactive">Disabled</span>'}</h1>
          <p>${esc(c.email)}${c.phone ? ` · ${esc(c.phone)}` : ''} · customer since ${esc(fmtDate(c.created_at))}</p></div>
        <div class="btn-row">
          <button class="btn btn-primary" data-new>+ New booking</button>
          <button class="btn" data-edit>Edit</button>
          <button class="btn" data-points>Adjust points</button>
          <button class="btn ${c.active ? 'btn-danger' : ''}" data-toggle>${c.active ? 'Disable account' : 'Enable account'}</button>
        </div></div></div>
      <div class="grid grid-4" style="margin-top:16px">
        <div class="card stat"><span class="label">Completed visits</span><span class="value">${stats.washes}</span></div>
        <div class="card stat"><span class="label">Total spent</span><span class="value">${money(stats.total_spent)}</span></div>
        <div class="card stat"><span class="label">Loyalty points</span><span class="value">${c.loyalty_points}</span></div>
        <div class="card stat"><span class="label">Cancellations / no-shows</span><span class="value">${stats.cancelled} / ${stats.no_shows}</span></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Vehicles</h2></div>
        <div class="grid grid-cards">${vs.length ? vs.map((v) => `<a class="card vehicle-card" href="#/vehicles/${v.id}" style="color:inherit;text-decoration:none"><div class="top"><div><div class="name">${esc(vehicleName(v))}</div><div class="muted">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''}</div></div>${plate(v.plate)}</div><div class="muted">${v.washes} visit${v.washes === 1 ? '' : 's'} · view history →</div></a>`).join('') : '<div class="muted">No vehicles.</div>'}</div>
      </div>
      <div class="card"><div class="card-head"><h2>Bookings</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Vehicle</th><th>Service</th><th>Staff</th><th>Status</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>
        ${bs.length ? bs.map((b) => `<tr class="clickable" data-booking="${b.id}"><td>${esc(fmtDateTime(b.scheduled_at))}</td><td>${vehicleLink(b)}</td><td>${esc(b.service_name)}${addonsText(b)}${UI.readyText(b) ? `<div>${UI.readyText(b)}</div>` : ''}</td><td>${esc(b.staff_name || '—')}</td><td>${statusBadge(b.status)} ${stars(b.rating)}</td><td>${payBadge(b.payment_status)}</td><td class="num">${money(b.total)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No bookings yet.</td></tr>'}
        </tbody></table></div></div>`);
    main.querySelectorAll('[data-booking]').forEach((tr) => tr.addEventListener('click', (e) => !e.target.closest('a') && openBooking(tr.dataset.booking, reload)));
    main.querySelector('[data-new]').addEventListener('click', () => newBooking({ customer: c, onDone: reload }));
    main.querySelector('[data-edit]').addEventListener('click', () =>
      modal({
        title: 'Edit customer',
        body: `<div class="field"><label>Name</label><input name="name" value="${esc(c.name)}" required></div>
          <div class="field"><label>Phone</label><input name="phone" value="${esc(c.phone)}"></div>
          <div class="field"><label>Reset password</label><input name="new_password" type="text" placeholder="Leave blank to keep current"></div>`,
        onSubmit: async (d) => {
          if (!d.new_password) delete d.new_password;
          await api('PATCH', `/api/admin/customers/${c.id}`, d);
          toast('Customer updated', 'success');
          reload();
        },
      }),
    );
    main.querySelector('[data-points]').addEventListener('click', () =>
      modal({
        title: 'Adjust loyalty points',
        body: `<p>Current balance: <b>${c.loyalty_points}</b> points.</p><div class="field"><label>Add / remove points</label><input name="points_adjustment" type="number" placeholder="e.g. 50 or -20" required></div>`,
        onSubmit: async (d) => {
          await api('PATCH', `/api/admin/customers/${c.id}`, { points_adjustment: Number(d.points_adjustment) });
          toast('Points updated', 'success');
          reload();
        },
      }),
    );
    main.querySelector('[data-toggle]').addEventListener('click', async () => {
      if (c.active && !(await confirmDialog(`Disable ${c.name}'s account? They will be signed out and unable to log in.`, { okLabel: 'Disable', danger: true }))) return;
      await api('PATCH', `/api/admin/customers/${c.id}`, { active: !c.active });
      reload();
    });
  }

  // =====================================================================
  // Services
  // =====================================================================
  async function services() {
    await refreshCatalog();
    const row = (s) => `<tr>
      <td><b>${esc(s.name)}</b><div class="muted" style="font-size:.8rem">${esc(s.description || '')}</div></td>
      <td class="num">${money(s.price)}</td>
      <td class="num">${esc(UI.fmtDuration(s.duration_min))}</td>
      <td>${s.warranty_months ? esc(UI.fmtMonths(s.warranty_months)) : '<span class="muted">—</span>'}</td>
      <td>${s.maintenance_months ? `every ${esc(UI.fmtMonths(s.maintenance_months))}` : '<span class="muted">—</span>'}</td>
      <td class="num">${s.times_sold}</td>
      <td>${s.active ? '<span class="badge active">Active</span>' : '<span class="badge inactive">Hidden</span>'}</td>
      <td class="num"><div class="btn-row" style="justify-content:flex-end"><button class="btn btn-sm" data-edit="${s.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${s.id}">Delete</button></div></td></tr>`;
    const head = '<thead><tr><th>Name</th><th class="num">Price</th><th class="num">Work time</th><th>Warranty</th><th>Maintenance</th><th class="num">Sold</th><th>Status</th><th></th></tr></thead>';
    const table = (kind) => {
      const groups = UI.byCategory(cache.services.filter((s) => s.kind === kind));
      if (!groups.length) return '<div class="empty">None yet.</div>';
      return `<div class="table-wrap"><table>${head}<tbody>${groups
        .map(([cat, list]) => `<tr><td colspan="8" style="background:var(--surface-2)"><b>${esc(UI.CATEGORY[cat] || cat)}</b></td></tr>${list.map(row).join('')}`)
        .join('')}</tbody></table></div>`;
    };
    setPage(`
      ${pageHead('Services & pricing', `Large vehicles (SUV, pickup, van) get a ${esc(UI.state.settings.large_vehicle_surcharge)}% surcharge — change it in Settings. Services with a warranty or maintenance interval create a protection record on the car when the job is completed.`, '<button class="btn btn-primary" data-add>+ Add service</button>')}
      <div class="card"><div class="card-head"><h2>Service packages</h2></div>${table('package')}</div>
      <div class="card"><div class="card-head"><h2>Add-on extras</h2></div>${table('addon')}</div>`);
    const stock = (await api('GET', '/api/admin/inventory')).items;
    const matRow = (m = {}) => `<div class="line-edit" data-mat>
        <select data-item><option value="">— Choose item —</option>${stock.map((i) => `<option value="${i.id}" ${i.id === m.item_id ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)})</option>`).join('')}</select>
        <input data-qty type="number" min="0" step="any" value="${esc(m.quantity ?? '')}" placeholder="Qty per job">
        <button type="button" class="btn btn-ghost btn-sm" data-remove title="Remove">✕</button></div>`;
    const form = async (s = {}) => {
      const materials = s.id ? (await api('GET', `/api/admin/inventory/materials/${s.id}`)).materials : [];
      modal({
        title: s.id ? `Edit ${s.name}` : 'Add service',
        wide: true,
        body: `<div class="form-row">
            <div class="field"><label>Name *</label><input name="name" value="${esc(s.name)}" required></div>
            <div class="field"><label>Service line</label><select name="category">${UI.CATEGORY_ORDER.map((c) => `<option value="${c}" ${(s.category || 'wash') === c ? 'selected' : ''}>${esc(UI.CATEGORY[c])}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Description</label><textarea name="description">${esc(s.description)}</textarea></div>
          <div class="form-row form-row-3">
            <div class="field"><label>Type</label><select name="kind"><option value="package" ${s.kind !== 'addon' ? 'selected' : ''}>Service package</option><option value="addon" ${s.kind === 'addon' ? 'selected' : ''}>Add-on extra</option></select></div>
            <div class="field"><label>Price (${esc(UI.state.settings.currency)}) *</label><input name="price" type="number" min="0" step="0.01" value="${esc(s.price)}" required></div>
            <div class="field"><label>Work time (minutes) *</label><input name="duration_min" type="number" min="1" value="${esc(s.duration_min || 30)}" required><small class="muted" data-duration-hint></small></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Warranty (months)</label><input name="warranty_months" type="number" min="0" max="600" value="${esc(s.warranty_months)}" placeholder="e.g. 36 for a 3-year coating"><small class="muted">Leave empty if there is no warranty.</small></div>
            <div class="field"><label>Maintenance visit every (months)</label><input name="maintenance_months" type="number" min="0" max="600" value="${esc(s.maintenance_months)}" placeholder="e.g. 6"><small class="muted">Used for follow-up reminders.</small></div>
          </div>
          <label class="check"><input type="checkbox" name="active" ${s.active === 0 ? '' : 'checked'}> Available for booking</label>
          <h3 style="margin-top:18px">Materials used per job</h3>
          <p class="muted" style="margin-top:0">Taken out of inventory automatically when a job with this service is completed.</p>
          <div data-mats>${materials.map(matRow).join('')}</div>
          <button type="button" class="btn btn-sm" data-add-mat>+ Add material</button>`,
        onOpen: (el) => {
          const mats = el.querySelector('[data-mats]');
          el.querySelector('[data-add-mat]').addEventListener('click', () => mats.insertAdjacentHTML('beforeend', matRow()));
          mats.addEventListener('click', (e) => e.target.closest('[data-remove]') && e.target.closest('[data-mat]').remove());
          const input = el.querySelector('[name=duration_min]');
          const hint = el.querySelector('[data-duration-hint]');
          const show = () => (hint.textContent = Number(input.value) >= 60 ? `= ${UI.fmtDuration(Number(input.value))}` : '');
          input.addEventListener('input', show);
          show();
        },
        onSubmit: async (d, f) => {
          const list = [...f.querySelectorAll('[data-mat]')]
            .map((row) => ({ item_id: Number(row.querySelector('[data-item]').value), quantity: Number(row.querySelector('[data-qty]').value) }))
            .filter((m) => m.item_id);
          if (list.some((m) => !(m.quantity > 0))) throw new Error('Enter the quantity used for each material.');
          const saved = s.id ? await api('PATCH', `/api/admin/services/${s.id}`, d) : await api('POST', '/api/admin/services', d);
          await api('PUT', `/api/admin/inventory/materials/${saved.service.id}`, { materials: list });
          toast('Service saved', 'success');
          services();
        },
      });
    };
    main.querySelector('[data-add]').addEventListener('click', () => form());
    main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => form(cache.services.find((s) => s.id === Number(b.dataset.edit)))));
    main.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const s = cache.services.find((x) => x.id === Number(b.dataset.del));
        if (!(await confirmDialog(`Delete "${s.name}"? If it has been used in bookings it will be hidden instead so history stays intact.`, { okLabel: 'Delete', danger: true }))) return;
        const r = await api('DELETE', `/api/admin/services/${s.id}`);
        toast(r.archived ? 'Service hidden (it has booking history)' : 'Service deleted', 'success');
        services();
      }),
    );
  }

  // =====================================================================
  // Staff
  // =====================================================================
  async function staff() {
    await refreshCatalog();
    setPage(`
      ${pageHead('Staff', 'Detailers and installers you can assign to jobs.', '<button class="btn btn-primary" data-add>+ Add staff member</button>')}
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Position</th><th>Phone</th><th>PIN sign-in</th><th class="num">Jobs today</th><th class="num">Jobs total</th><th class="num">Avg rating</th><th>Status</th><th></th></tr></thead><tbody>
      ${
        cache.staff.length
          ? cache.staff
              .map(
                (s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.position || '—')}</td><td>${esc(s.phone || '—')}</td><td class="num">${s.jobs_today}</td><td class="num">${s.jobs_completed}</td><td class="num">${s.avg_rating ? `${s.avg_rating} ★` : '—'}</td>
          <td>${s.has_pin ? '<span class="badge active">PIN set</span>' : '<span class="badge">No PIN</span>'}</td>
          <td>${!s.active ? '<span class="badge inactive">Inactive</span>' : s.busy ? '<span class="badge in_progress">On a job</span>' : '<span class="badge active">Available</span>'}</td>
          <td class="num"><div class="btn-row" style="justify-content:flex-end"><button class="btn btn-sm" data-edit="${s.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${s.id}">Remove</button></div></td></tr>`,
              )
              .join('')
          : '<tr><td colspan="8" class="empty">No staff yet.</td></tr>'
      }</tbody></table></div></div>`);
    const form = (s = {}) =>
      modal({
        title: s.id ? `Edit ${s.name}` : 'Add staff member',
        body: `<div class="field"><label>Name *</label><input name="name" value="${esc(s.name)}" required></div>
          <div class="form-row"><div class="field"><label>Position</label><input name="position" value="${esc(s.position)}" placeholder="Detailer, PPF installer…"></div><div class="field"><label>Phone</label><input name="phone" value="${esc(s.phone)}"></div></div>
          <div class="field"><label>PIN for sign-in (4 digits)</label><input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" placeholder="${s.has_pin ? 'Leave empty to keep the current PIN' : 'e.g. 1111'}">
            <small class="muted">Employees sign in on the shop tablet at <b>/staff</b> with this PIN. They can't see reports, settings, prices or customer accounts.</small>
            ${s.has_pin ? '<label class="check" style="margin-top:6px"><input type="checkbox" name="remove_pin"> Remove PIN (this person can no longer sign in)</label>' : ''}</div>
          ${s.id ? `<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Active</label>` : ''}`,
        onSubmit: async (d) => {
          if (d.remove_pin) d.pin = null;
          else if (!d.pin) delete d.pin;
          delete d.remove_pin;
          if (s.id) await api('PATCH', `/api/admin/staff/${s.id}`, d);
          else await api('POST', '/api/admin/staff', d);
          toast('Saved', 'success');
          staff();
        },
      });
    main.querySelector('[data-add]').addEventListener('click', () => form());
    main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => form(cache.staff.find((s) => s.id === Number(b.dataset.edit)))));
    main.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const s = cache.staff.find((x) => x.id === Number(b.dataset.del));
        if (!(await confirmDialog(`Remove ${s.name}? Staff with job history are marked inactive instead.`, { okLabel: 'Remove', danger: true }))) return;
        const r = await api('DELETE', `/api/admin/staff/${s.id}`);
        toast(r.archived ? 'Marked inactive (has job history)' : 'Removed', 'success');
        staff();
      }),
    );
  }

  // =====================================================================
  // Reports
  // =====================================================================
  async function reports(_p, query) {
    const r = await api('GET', '/api/admin/reports?' + new URLSearchParams({ from: query.from || '', to: query.to || '' }));
    const s = r.summary;
    const preset = (days) => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days + 1);
      return `#/reports?from=${UI.localDate(from)}&to=${UI.localDate(to)}`;
    };
    const monthStart = UI.localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const simpleTable = (rows, cols) =>
      rows.length
        ? `<div class="table-wrap"><table><thead><tr>${cols.map(([h, , num]) => `<th class="${num ? 'num' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${cols.map(([, f, num]) => `<td class="${num ? 'num' : ''}">${f(row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">No data in this period.</div>';
    setPage(`
      ${pageHead('Reports', `${esc(fmtDate(r.from))} – ${esc(fmtDate(r.to))}`, `<a class="btn" href="/api/admin/reports/bookings.csv?from=${r.from}&to=${r.to}">⬇ Export CSV</a>`)}
      <div class="card"><form class="filters" data-range style="margin:0">
        <div><label>From</label><input type="date" name="from" value="${r.from}"></div>
        <div><label>To</label><input type="date" name="to" value="${r.to}"></div>
        <button class="btn btn-primary">Apply</button>
        <a class="btn btn-ghost" href="${preset(1)}">Today</a><a class="btn btn-ghost" href="${preset(7)}">7 days</a><a class="btn btn-ghost" href="${preset(30)}">30 days</a>
        <a class="btn btn-ghost" href="#/reports?from=${monthStart}&to=${UI.localDate()}">This month</a><a class="btn btn-ghost" href="${preset(365)}">12 months</a>
      </form></div>
      <div class="grid grid-4" style="margin-top:16px">
        <div class="card stat"><span class="label">Revenue</span><span class="value">${money(s.revenue)}</span><span class="sub">Discounts ${money(s.discounts)} (staff ${money(s.manual_discounts)}) · tax ${money(s.tax)}</span></div>
        <div class="card stat"><span class="label">Completed jobs</span><span class="value">${s.completed || 0}</span><span class="sub">${s.unique_vehicles || 0} unique vehicles</span></div>
        <div class="card stat"><span class="label">Average ticket</span><span class="value">${money(s.avg_ticket)}</span><span class="sub">${s.online || 0} online · ${s.walk_ins || 0} walk-in</span></div>
        <div class="card stat"><span class="label">Cancelled / no-show</span><span class="value">${s.cancelled || 0} / ${s.no_shows || 0}</span><span class="sub">of ${s.bookings || 0} bookings · rating ${s.avg_rating ? `${s.avg_rating} ★` : '—'}</span></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Daily revenue</h2></div>
        ${r.by_day.length ? UI.barChart(r.by_day.map((d) => ({ label: r.by_day.length > 20 ? '' : fmtShortDate(d.day), value: d.revenue, title: `${fmtDate(d.day)}: ${money(d.revenue)} · ${d.washes} jobs` }))) : '<div class="empty">No completed jobs in this period.</div>'}</div>
      <div class="grid grid-2" style="margin-top:16px">
        <div class="card span-2"><div class="card-head"><h2>Revenue by service line</h2></div>${UI.hbars(r.by_category.map((x) => ({ name: `${UI.CATEGORY[x.category] || x.category} (${x.count})`, value: x.revenue, display: money(x.revenue) })))}</div>
        <div class="card"><div class="card-head"><h2>Packages</h2></div>${UI.hbars(r.by_service.map((x) => ({ name: `${x.name} (${x.count})`, value: x.revenue, display: money(x.revenue) })))}</div>
        <div class="card"><div class="card-head"><h2>Add-ons</h2></div>${UI.hbars(r.by_addon.map((x) => ({ name: `${x.name} (${x.count})`, value: x.revenue, display: money(x.revenue) })))}</div>
        <div class="card"><div class="card-head"><h2>Staff performance</h2></div>${simpleTable(r.by_staff, [['Staff', (x) => esc(x.name)], ['Jobs', (x) => x.count, 1], ['Revenue', (x) => money(x.revenue), 1], ['Rating', (x) => (x.avg_rating ? `${x.avg_rating} ★` : '—'), 1]])}</div>
        <div class="card"><div class="card-head"><h2>Payments</h2></div>${simpleTable(r.by_payment, [['Method', (x) => esc(x.method)], ['Payments', (x) => x.count, 1], ['Received', (x) => money(x.received), 1], ['Refunded', (x) => (x.refunded ? money(x.refunded) : '—'), 1], ['Net', (x) => `<b>${money(x.amount)}</b>`, 1]])}
          <div class="muted" style="margin-top:8px">Collected in this period: <b>${money(s.collected)}</b> · still due on jobs in this period: <b>${money(s.outstanding)}</b></div></div>
        <div class="card"><div class="card-head"><h2>Busiest hours</h2></div>${r.by_hour.length ? UI.barChart(r.by_hour.map((h) => ({ label: `${h.hour}h`, value: h.count, title: `${h.hour}:00 — ${h.count} jobs` }))) : '<div class="empty">No data.</div>'}</div>
        <div class="card"><div class="card-head"><h2>Vehicle types</h2></div>${UI.hbars(r.by_vehicle_type.map((x) => ({ name: cap(x.type), value: x.count, display: `${x.count} · ${money(x.revenue)}` })))}</div>
        <div class="card span-2"><div class="card-head"><h2>Materials used</h2><span class="muted">cost ${money(s.materials_cost)} · stock bought ${money(s.purchases)} · revenue minus materials ${money(s.revenue - s.materials_cost)}</span></div>
          ${simpleTable(r.materials, [['Item', (x) => esc(x.name)], ['Used', (x) => `${fmtQty(x.quantity)} ${esc(x.unit)}`, 1], ['Cost', (x) => money(x.cost), 1]])}</div>
      </div>`);
    main.querySelector('[data-range]').addEventListener('submit', (e) => {
      e.preventDefault();
      const d = UI.formData(e.target);
      location.hash = `#/reports?from=${d.from}&to=${d.to}`;
    });
  }

  // =====================================================================
  // Settings
  // =====================================================================
  async function settings() {
    const { settings: s } = await api('GET', '/api/admin/settings');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    setPage(`
      ${pageHead('Settings', 'Business details, opening hours, pricing rules and loyalty programme.')}
      <form data-settings class="stack">
        <div class="card"><h2>Business</h2>
          <div class="form-row"><div class="field"><label>Business name</label><input name="business_name" value="${esc(s.business_name)}"></div><div class="field"><label>Tagline</label><input name="tagline" value="${esc(s.tagline)}" placeholder="& PPF Ceramic Coating"></div></div>
          <div class="form-row"><div class="field"><label>Phone</label><input name="phone" value="${esc(s.phone)}" placeholder="Shown on the sign-in page and receipts"></div><div class="field"><label>Address</label><input name="address" value="${esc(s.address)}"></div></div>
          <div class="form-row"><div class="field"><label>Currency symbol</label><input name="currency" value="${esc(s.currency)}" maxlength="4"><small class="muted">e.g. Rs, $, AED, £</small></div>
            <div class="field"><label>Payment methods</label><input name="payment_methods" value="${esc((s.payment_methods || []).join(', '))}"><small class="muted">Comma-separated, e.g. Cash, Card, JazzCash, Easypaisa, Bank transfer, Raast. Bills can be split across several.</small></div></div>
        </div>
        <div class="card"><h2>Opening hours &amp; capacity</h2>
          <div class="form-row form-row-3">
            <div class="field"><label>Opens</label><input type="time" name="open_time" value="${esc(s.open_time)}"></div>
            <div class="field"><label>Closes</label><input type="time" name="close_time" value="${esc(s.close_time)}"></div>
            <div class="field"><label>Slot length (min)</label><input type="number" min="10" name="slot_minutes" value="${esc(s.slot_minutes)}"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Bays</label><input type="number" min="1" name="bays" value="${esc(s.bays)}"><small class="muted">Cars you can work on at the same time. Long jobs (PPF, coatings) keep their bay until done.</small></div>
            <div class="field"><label>Booking window (days)</label><input type="number" min="1" name="booking_window_days" value="${esc(s.booking_window_days)}"><small class="muted">How far ahead customers can book.</small></div>
          </div>
          <label>Open on</label><div class="btn-row">${days.map((d, i) => `<label class="check"><input type="checkbox" name="open_days" value="${i}" ${s.open_days.includes(i) ? 'checked' : ''}> ${d.slice(0, 3)}</label>`).join('')}</div>
        </div>
        <div class="card"><h2>Pricing</h2>
          <div class="form-row"><div class="field"><label>Tax rate (%)</label><input type="number" min="0" step="0.01" name="tax_rate" value="${esc(s.tax_rate)}"></div>
          <div class="field"><label>Large vehicle surcharge (%)</label><input type="number" min="0" step="0.1" name="large_vehicle_surcharge" value="${esc(s.large_vehicle_surcharge)}"><small class="muted">Applied to SUVs, pickups and vans.</small></div></div>
        </div>
        <div class="card"><h2>Loyalty programme</h2>
          <div class="form-row form-row-3">
            <div class="field"><label>Points per ${esc(s.currency)}1 spent</label><input type="number" min="0" step="any" name="points_per_unit" value="${esc(s.points_per_unit)}"></div>
            <div class="field"><label>Points for a reward</label><input type="number" min="0" name="reward_points" value="${esc(s.reward_points)}"></div>
            <div class="field"><label>Reward value (${esc(s.currency)})</label><input type="number" min="0" step="0.01" name="reward_value" value="${esc(s.reward_value)}"></div>
          </div>
          <small class="muted">Customers can redeem points for a discount when booking. Set points per ${esc(s.currency)}1 to 0 to switch the programme off.</small>
        </div>
        <div class="card"><h2>Employees</h2>
          <input type="hidden" name="employee_can_discount" value="false">
          <label class="check"><input type="checkbox" name="employee_can_discount" value="true" data-single ${s.employee_can_discount ? 'checked' : ''}> Employees may give discounts</label>
          <small class="muted">Employees sign in with their PIN at <b>/staff</b>. They can take bookings, walk-ins and payments, set the price for the vehicle and record stock used — but cannot see reports, revenue, settings, the price list, staff or customer accounts, or give refunds. Set their PINs on the Staff page.</small>
        </div>
        <div><button class="btn btn-primary">Save settings</button></div>
      </form>
      <div class="card" style="margin-top:16px"><h2>Change admin PIN</h2>
        <form data-pin class="form-row form-row-3" style="align-items:end">
          <div class="field"><label>Current password</label><input type="password" name="current_password" required></div>
          <div class="field"><label>New 4-digit PIN</label><input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></div>
          <div class="field"><button class="btn">Update PIN</button></div>
        </form>
      </div>
      <div class="card" style="margin-top:16px"><h2>Change admin password</h2>
        <form data-password class="form-row form-row-3" style="align-items:end">
          <div class="field"><label>Current password</label><input type="password" name="current_password" required></div>
          <div class="field"><label>New password</label><input type="password" name="new_password" minlength="6" required></div>
          <div class="field"><button class="btn">Update password</button></div>
        </form>
      </div>`);
    main.querySelector('[data-settings]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = UI.formData(e.target);
      d.open_days = (d.open_days || []).map(Number);
      d.employee_can_discount = e.target.querySelector('[name=employee_can_discount][type=checkbox]').checked;
      try {
        await api('PUT', '/api/admin/settings', d);
        await UI.loadSettings();
        toast('Settings saved', 'success');
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
    main.querySelector('[data-pin]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/admin/pin', UI.formData(e.target));
        e.target.reset();
        toast('PIN updated', 'success');
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
    main.querySelector('[data-password]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/admin/password', UI.formData(e.target));
        e.target.reset();
        toast('Password updated', 'success');
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
  }

  // =====================================================================
  // =====================================================================
  // Inventory
  // =====================================================================
  const INV_CAT = { chemicals: 'Chemicals', polish: 'Polish & compounds', coating: 'Coatings', ppf: 'PPF film', consumables: 'Consumables', tools: 'Tools & equipment', other: 'Other' };
  const MOVE_LABEL = { purchase: 'Received', use: 'Used', waste: 'Wasted', adjust: 'Stock count' };

  async function inventory(_p, query) {
    const { items, summary, categories } = await api('GET', '/api/admin/inventory');
    const f = { q: query.q || '', cat: query.cat || '', low: query.low === '1' };
    const shown = items.filter(
      (i) => (!f.q || `${i.name} ${i.supplier || ''}`.toLowerCase().includes(f.q.toLowerCase())) && (!f.cat || i.category === f.cat) && (!f.low || i.low),
    );
    const qtyCell = (i) => `<span class="${i.quantity <= 0 ? 'stock-neg' : ''}">${esc(fmtQty(i.quantity))} ${esc(i.unit)}</span>${i.low ? ` <span class="badge ${i.quantity <= 0 ? 'overdue' : 'due_soon'}">${i.quantity <= 0 ? 'Out' : 'Low'}</span>` : ''}`;
    setPage(`
      ${pageHead('Inventory', 'Chemicals, polishes, coatings, PPF film and supplies. Materials are taken out of stock automatically when a job is completed.', isAdmin ? '<button class="btn btn-primary" data-add-item>+ Add item</button>' : '')}
      <div class="grid ${isAdmin ? 'grid-3' : 'grid-2'}">
        <div class="card stat"><span class="label">Items</span><span class="value">${summary.items}</span></div>
        <div class="card stat"><span class="label">Low / out of stock</span><span class="value">${summary.low}</span><span class="sub"><a href="#/inventory?low=1">Show them →</a></span></div>
        ${isAdmin ? `<div class="card stat"><span class="label">Stock value</span><span class="value">${money(summary.value)}</span><span class="sub">at average cost</span></div>` : ''}
      </div>
      <div class="card" style="margin-top:16px">
        <form class="filters" data-filter>
          <input type="search" name="q" placeholder="Search items or supplier…" value="${esc(f.q)}">
          <select name="cat"><option value="">All categories</option>${categories.map((c) => `<option value="${c}" ${f.cat === c ? 'selected' : ''}>${esc(INV_CAT[c] || c)}</option>`).join('')}</select>
          <label class="check"><input type="checkbox" name="low" ${f.low ? 'checked' : ''}> Low stock only</label>
          <button class="btn">Filter</button>
        </form>
        <div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th class="num">In stock</th><th class="num">Reorder at</th>${isAdmin ? '<th class="num">Cost / unit</th><th class="num">Value</th>' : ''}<th></th></tr></thead><tbody>
        ${
          shown.length
            ? shown
                .map(
                  (i) => `<tr ${i.active ? '' : 'style="opacity:.55"'}>
            <td><b>${esc(i.name)}</b>${!i.active ? ' <span class="badge inactive">Archived</span>' : ''}${isAdmin && (i.supplier || i.notes) ? `<div class="muted" style="font-size:.8rem">${esc([i.supplier, i.notes].filter(Boolean).join(' · '))}</div>` : ''}</td>
            <td><span class="badge">${esc(INV_CAT[i.category] || i.category)}</span></td>
            <td class="num">${qtyCell(i)}</td>
            <td class="num">${esc(fmtQty(i.min_quantity))} ${esc(i.unit)}</td>
            ${isAdmin ? `<td class="num">${money(i.cost_price)}</td><td class="num">${money(i.value)}</td>` : ''}
            <td class="num"><div class="btn-row inv-actions" style="justify-content:flex-end">
              <button class="btn btn-sm" data-use="${i.id}">Use</button>
              ${isAdmin ? `<button class="btn btn-sm btn-success" data-receive="${i.id}">Receive</button><button class="btn btn-sm" data-count="${i.id}">Count</button><button class="btn btn-sm" data-edit-item="${i.id}">Edit</button>` : ''}
              <button class="btn btn-sm btn-ghost" data-history="${i.id}">History</button>
            </div></td></tr>`,
                )
                .join('')
            : '<tr><td colspan="7" class="empty">No items match.</td></tr>'
        }</tbody></table></div>
      </div>`);
    const reload = () => inventory(_p, query);
    const byId = (id) => items.find((i) => i.id === Number(id));
    main.querySelector('[data-filter]').addEventListener('submit', (e) => {
      e.preventDefault();
      const d = UI.formData(e.target);
      const qs = new URLSearchParams(Object.entries({ q: d.q, cat: d.cat, low: d.low ? '1' : '' }).filter(([, v]) => v));
      location.hash = `#/inventory${qs.toString() ? `?${qs}` : ''}`;
    });
    const moveModal = (i, type) => {
      const titles = { use: `Record use — ${i.name}`, purchase: `Receive stock — ${i.name}`, adjust: `Stock count — ${i.name}` };
      modal({
        title: titles[type],
        submitLabel: 'Save',
        body: `<p class="muted" style="margin-top:0">In stock now: <b>${esc(fmtQty(i.quantity))} ${esc(i.unit)}</b></p>
          ${
            type === 'use'
              ? `<div class="form-row"><div class="field"><label>Quantity (${esc(i.unit)})</label><input name="quantity" type="number" min="0" step="any" required></div>
                 <div class="field"><label>Type</label><select name="type"><option value="use">Used on a job</option><option value="waste">Wasted / damaged</option></select></div></div>
                 <div class="field"><label>Booking code <small class="muted" style="display:inline">(optional)</small></label><input name="booking_code" placeholder="MC-XXXXXX" style="text-transform:uppercase"></div>`
              : type === 'purchase'
                ? `<div class="form-row"><div class="field"><label>Quantity received (${esc(i.unit)})</label><input name="quantity" type="number" min="0" step="any" required></div>
                   <div class="field"><label>Cost per ${esc(i.unit)} (${esc(UI.state.settings.currency)})</label><input name="unit_cost" type="number" min="0" step="any" value="${esc(i.cost_price)}"></div></div>`
                : `<div class="field"><label>Counted quantity (${esc(i.unit)})</label><input name="counted" type="number" min="0" step="any" required value="${esc(i.quantity)}"><small class="muted">The stock is set to what you counted; the difference is logged.</small></div>`
          }
          <div class="field"><label>Note</label><input name="note" maxlength="200" placeholder="${type === 'purchase' ? 'Supplier / invoice no.' : 'Optional'}"></div>`,
        onSubmit: async (d) => {
          await api('POST', `/api/admin/inventory/${i.id}/movements`, { type: d.type || type, ...d });
          toast('Stock updated', 'success');
          reload();
        },
      });
    };
    const itemModal = (i) =>
      modal({
        title: i ? `Edit ${i.name}` : 'Add inventory item',
        body: `<div class="form-row"><div class="field"><label>Name *</label><input name="name" required value="${esc(i?.name)}" placeholder="e.g. Car shampoo"></div>
            <div class="field"><label>Category</label><select name="category">${categories.map((c) => `<option value="${c}" ${(i?.category || 'chemicals') === c ? 'selected' : ''}>${esc(INV_CAT[c] || c)}</option>`).join('')}</select></div></div>
          <div class="form-row form-row-3">
            <div class="field"><label>Unit</label><input name="unit" maxlength="10" value="${esc(i?.unit || 'L')}" placeholder="L, ml, kg, m, pcs"></div>
            ${i ? '' : '<div class="field"><label>Opening stock</label><input name="quantity" type="number" min="0" step="any" value="0"></div>'}
            <div class="field"><label>Reorder at</label><input name="min_quantity" type="number" min="0" step="any" value="${esc(i?.min_quantity ?? 0)}"></div>
            <div class="field"><label>Cost per unit (${esc(UI.state.settings.currency)})</label><input name="cost_price" type="number" min="0" step="any" value="${esc(i?.cost_price ?? 0)}"></div>
          </div>
          <div class="form-row"><div class="field"><label>Supplier</label><input name="supplier" value="${esc(i?.supplier)}"></div><div class="field"><label>Notes</label><input name="notes" value="${esc(i?.notes)}"></div></div>
          ${i ? `<label class="check"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> Active (untick to archive)</label>` : ''}`,
        onSubmit: async (d) => {
          if (i) await api('PATCH', `/api/admin/inventory/${i.id}`, d);
          else await api('POST', '/api/admin/inventory', d);
          toast('Item saved', 'success');
          reload();
        },
      });
    main.querySelector('[data-add-item]')?.addEventListener('click', () => itemModal(null));
    main.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => moveModal(byId(b.dataset.use), 'use')));
    main.querySelectorAll('[data-receive]').forEach((b) => b.addEventListener('click', () => moveModal(byId(b.dataset.receive), 'purchase')));
    main.querySelectorAll('[data-count]').forEach((b) => b.addEventListener('click', () => moveModal(byId(b.dataset.count), 'adjust')));
    main.querySelectorAll('[data-edit-item]').forEach((b) => b.addEventListener('click', () => itemModal(byId(b.dataset.editItem))));
    main.querySelectorAll('[data-history]').forEach((b) =>
      b.addEventListener('click', async () => {
        const { item, movements } = await api('GET', `/api/admin/inventory/${b.dataset.history}/movements`);
        modal({
          title: `${item.name} — stock history`,
          wide: true,
          body: `<p class="muted" style="margin-top:0">In stock: <b>${esc(fmtQty(item.quantity))} ${esc(item.unit)}</b></p>
            <div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th class="num">Qty</th>${isAdmin ? '<th class="num">Cost / unit</th>' : ''}<th>Job</th><th>Note</th><th>By</th></tr></thead><tbody>
            ${
              movements.length
                ? movements
                    .map(
                      (m) => `<tr><td>${esc(fmtDateTime(m.created_at))}</td><td>${esc(MOVE_LABEL[m.type] || m.type)}</td>
                  <td class="num ${m.quantity < 0 ? 'stock-neg' : ''}">${m.quantity > 0 ? '+' : ''}${esc(fmtQty(m.quantity))} ${esc(item.unit)}</td>
                  ${isAdmin ? `<td class="num">${money(m.unit_cost)}</td>` : ''}
                  <td class="mono">${esc(m.booking_code || '')}</td><td>${esc(m.note || '')}</td><td>${esc(m.actor_name || '')}</td></tr>`,
                    )
                    .join('')
                : '<tr><td colspan="7" class="empty">No movements yet.</td></tr>'
            }</tbody></table></div>`,
        });
      }),
    );
  }

  function adminOnly(page) {
    return isAdmin ? page : () => {
      toast('Only the admin can open that page.', 'error');
      location.hash = '#/';
    };
  }

  UI.router(
    {
      '/': dashboard,
      '/bookings': bookings,
      '/vehicles': vehicles,
      '/vehicles/:id': vehicleDetail,
      '/customers': adminOnly(customers),
      '/customers/:id': adminOnly(customerDetail),
      '/inventory': inventory,
      '/services': adminOnly(services),
      '/staff': adminOnly(staff),
      '/reports': adminOnly(reports),
      '/settings': adminOnly(settings),
    },
    { onChange: UI.setActiveNav },
  ).run();
})();
