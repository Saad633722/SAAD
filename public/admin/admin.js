(async function () {
  'use strict';
  const { api, esc, money, fmtDate, fmtShortDate, fmtTime, fmtDateTime, timeAgo, statusBadge, payBadge, plate, stars, cap, vehicleName, toast, modal, confirmDialog } = UI;
  const main = document.getElementById('main');
  const cache = { services: [], staff: [] };

  const me = await api('GET', '/api/auth/me');
  if (!me.user || me.user.role !== 'admin') return (location.href = '/');
  UI.bindShell(me.user);
  await UI.loadSettings();
  document.title = `Admin — ${UI.state.settings.business_name}`;

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
          <h3 style="margin-top:16px">Services ${b.service_category ? UI.catBadge(b.service_category) : ''}</h3>
          ${UI.priceLines(b)}
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
          <form data-edit>
            <div class="form-row">
              <div class="field"><label>Staff</label><select name="staff_id">${staffOptions(b.staff_id)}</select></div>
              <div class="field"><label>Bay</label><input name="bay" type="number" min="1" value="${esc(b.bay)}"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>Date &amp; time</label><input name="scheduled_at" type="datetime-local" value="${esc(b.scheduled_at.replace(' ', 'T'))}" ${['completed', 'cancelled', 'no_show'].includes(b.status) ? 'disabled' : ''}></div>
              <div class="field"><label>Mileage</label><input name="mileage" type="number" min="0" value="${esc(b.mileage)}" placeholder="km / mi"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>Payment</label><select name="payment_status">${['unpaid', 'paid', 'refunded'].map((p) => `<option ${p === b.payment_status ? 'selected' : ''} value="${p}">${cap(p)}</option>`).join('')}</select></div>
              <div class="field"><label>Method</label><select name="payment_method"><option value="">—</option>${UI.state.paymentMethods.map((p) => `<option ${p === b.payment_method ? 'selected' : ''} value="${p}">${cap(p)}</option>`).join('')}</select></div>
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
    m.el.querySelectorAll('[data-status]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const status = btn.dataset.status;
        let note;
        if (status === 'cancelled' || status === 'no_show') {
          if (!(await confirmDialog(`${ACTION_LABEL[status]} for ${b.plate}?`, { okLabel: ACTION_LABEL[status], danger: true }))) return;
        }
        try {
          const patch = { status, status_note: note };
          if (status === 'completed') {
            const form = m.el.querySelector('[data-edit]');
            Object.assign(patch, editPayload(UI.formData(form)));
          }
          await api('PATCH', `/api/admin/bookings/${id}`, patch);
          toast(`Booking ${UI.STATUS[status].toLowerCase()}`, 'success');
          await reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
    const editPayload = (d) => {
      const p = { staff_id: d.staff_id || null, bay: d.bay || null, mileage: d.mileage || null, payment_status: d.payment_status, payment_method: d.payment_method || null, admin_notes: d.admin_notes };
      if (d.scheduled_at) p.scheduled_at = d.scheduled_at.replace('T', ' ');
      return p;
    };
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
    m.el.querySelector('[data-print]').addEventListener('click', () => printReceipt(b));
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
      <h3>When &amp; who</h3>
      <label class="check" style="margin-bottom:10px"><input type="checkbox" name="start_now" checked> Start the job now (car is here)</label>
      <div class="field" data-when style="display:none"><label>Scheduled for</label><input type="datetime-local" name="scheduled_at" value="${now.toISOString().slice(0, 16)}"></div>
      <div class="form-row form-row-3">
        <div class="field"><label>Staff</label><select name="staff_id">${staffOptions(null)}</select></div>
        <div class="field"><label>Bay</label><input type="number" min="1" name="bay"></div>
        <div class="field"><label>Mileage</label><input type="number" min="0" name="mileage"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Extra discount (${esc(UI.state.settings.currency)})</label><input type="number" min="0" step="0.01" name="discount" placeholder="0.00"></div>
        <div class="field"><label>Internal notes</label><input name="admin_notes" placeholder="e.g. scratch on driver door"></div>
      </div>`;
    modal({
      title: 'New booking / walk-in',
      body,
      wide: true,
      submitLabel: 'Create booking',
      onOpen: (el) => {
        const cb = el.querySelector('[name=start_now]');
        cb.addEventListener('change', () => (el.querySelector('[data-when]').style.display = cb.checked ? 'none' : ''));
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
          discount: d.discount || 0,
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
        <td class="num">${next ? `<button class="btn btn-sm ${next[0] === 'completed' ? 'btn-success' : 'btn-primary'}" data-quick="${b.id}" data-to="${next[0]}">${next[1]}</button>` : b.status === 'completed' && b.payment_status === 'unpaid' ? `<button class="btn btn-sm" data-paid="${b.id}">Mark paid</button>` : ''}</td>
      </tr>`;
    };
    setPage(`
      ${pageHead('Dashboard', esc(fmtDate(UI.localDate() + ' 12:00')), '<button class="btn btn-primary" data-new>+ New booking / walk-in</button>')}
      <div class="grid grid-4">
        <div class="card stat"><span class="label">Today's bookings</span><span class="value">${t.total || 0}</span><span class="sub">${t.waiting || 0} waiting · ${t.in_progress || 0} in progress · ${t.completed || 0} done</span></div>
        <div class="card stat"><span class="label">Revenue today</span><span class="value">${money(t.revenue)}</span><span class="sub">This month: ${money(s.month.revenue)}</span></div>
        <div class="card stat"><span class="label">Unpaid completed</span><span class="value">${s.unpaid.count}</span><span class="sub">${money(s.unpaid.amount)} outstanding</span></div>
        <div class="card stat"><span class="label">Customer rating</span><span class="value">${s.totals.avg_rating ? `${s.totals.avg_rating} ★` : '—'}</span><span class="sub">${s.totals.customers} customers · ${s.totals.vehicles} vehicles</span></div>
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
      <div class="grid grid-3" style="margin-top:16px">
        <div class="card span-2"><div class="card-head"><h2>Revenue — last 14 days</h2></div>
          ${UI.barChart(s.revenue_14d.map((d) => ({ label: fmtShortDate(d.day).replace(' ', ' '), value: d.revenue, title: `${fmtDate(d.day)}: ${money(d.revenue)} · ${d.washes} jobs` })), { format: money })}</div>
        <div class="card"><div class="card-head"><h2>Top packages (30 days)</h2></div>${UI.hbars(s.top_services.map((x) => ({ name: x.name, value: x.count, display: `${x.count}×` })))}</div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Latest feedback</h2></div>
        ${s.recent_feedback.length ? s.recent_feedback.map((f) => `<div class="note"><div class="meta"><span>${stars(f.rating)} · ${plate(f.plate)} · ${esc(f.customer_name || 'Walk-in')}</span><span>${esc(timeAgo(f.completed_at))}</span></div>${f.feedback ? esc(f.feedback) : '<span class="muted">No comment</span>'}</div>`).join('') : '<div class="empty">No ratings yet.</div>'}
      </div>`);
    main.querySelector('[data-new]').addEventListener('click', () => newBooking({ onDone: dashboard }));
    main.querySelectorAll('[data-followup]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const f = s.followups.find((x) => x.id === Number(btn.dataset.followup));
        newBooking({ vehicle: { id: f.vehicle_id, plate: f.plate, make: f.make, model: f.model, year: f.year, owner_name: f.owner_name }, onDone: dashboard });
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
      btn.addEventListener('click', () => {
        modal({
          title: 'Record payment',
          body: `<div class="field"><label>Payment method</label><select name="payment_method">${UI.state.paymentMethods.map((p) => `<option value="${p}">${cap(p)}</option>`).join('')}</select></div>`,
          submitLabel: 'Mark as paid',
          onSubmit: async (d) => {
            await api('PATCH', `/api/admin/bookings/${btn.dataset.paid}`, { payment_status: 'paid', payment_method: d.payment_method });
            toast('Payment recorded', 'success');
            dashboard();
          },
        });
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
          <select name="payment"><option value="">Any payment</option><option value="unpaid" ${q.payment === 'unpaid' ? 'selected' : ''}>Unpaid</option><option value="paid" ${q.payment === 'paid' ? 'selected' : ''}>Paid</option><option value="refunded" ${q.payment === 'refunded' ? 'selected' : ''}>Refunded</option></select>
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
        <div class="card-head"><h2>Protection &amp; warranty</h2><button class="btn btn-sm no-print" data-add-protection>+ Add coating / PPF record</button></div>
        ${
          protections.length
            ? UI.protectionCards(protections, { admin: true })
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
                     <button class="btn btn-ghost btn-sm no-print" data-del-note="${n.id}" title="Delete">✕</button></div>${esc(n.note)}</div>`,
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
    main.querySelector('[data-add-protection]').addEventListener('click', () => protectionForm(v, null, reload));
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
    const form = (s = {}) =>
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
          <label class="check"><input type="checkbox" name="active" ${s.active === 0 ? '' : 'checked'}> Available for booking</label>`,
        onOpen: (el) => {
          const input = el.querySelector('[name=duration_min]');
          const hint = el.querySelector('[data-duration-hint]');
          const show = () => (hint.textContent = Number(input.value) >= 60 ? `= ${UI.fmtDuration(Number(input.value))}` : '');
          input.addEventListener('input', show);
          show();
        },
        onSubmit: async (d) => {
          if (s.id) await api('PATCH', `/api/admin/services/${s.id}`, d);
          else await api('POST', '/api/admin/services', d);
          toast('Service saved', 'success');
          services();
        },
      });
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
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Position</th><th>Phone</th><th class="num">Jobs today</th><th class="num">Jobs total</th><th class="num">Avg rating</th><th>Status</th><th></th></tr></thead><tbody>
      ${
        cache.staff.length
          ? cache.staff
              .map(
                (s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.position || '—')}</td><td>${esc(s.phone || '—')}</td><td class="num">${s.jobs_today}</td><td class="num">${s.jobs_completed}</td><td class="num">${s.avg_rating ? `${s.avg_rating} ★` : '—'}</td>
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
          ${s.id ? `<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Active</label>` : ''}`,
        onSubmit: async (d) => {
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
        <div class="card stat"><span class="label">Revenue</span><span class="value">${money(s.revenue)}</span><span class="sub">Discounts ${money(s.discounts)} · tax ${money(s.tax)}</span></div>
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
        <div class="card"><div class="card-head"><h2>Payments</h2></div>${simpleTable(r.by_payment, [['Method', (x) => esc(cap(x.method))], ['Status', (x) => payBadge(x.status)], ['Count', (x) => x.count, 1], ['Amount', (x) => money(x.amount), 1]])}</div>
        <div class="card"><div class="card-head"><h2>Busiest hours</h2></div>${r.by_hour.length ? UI.barChart(r.by_hour.map((h) => ({ label: `${h.hour}h`, value: h.count, title: `${h.hour}:00 — ${h.count} jobs` }))) : '<div class="empty">No data.</div>'}</div>
        <div class="card"><div class="card-head"><h2>Vehicle types</h2></div>${UI.hbars(r.by_vehicle_type.map((x) => ({ name: cap(x.type), value: x.count, display: `${x.count} · ${money(x.revenue)}` })))}</div>
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
          <div class="form-row"><div class="field"><label>Currency symbol</label><input name="currency" value="${esc(s.currency)}" maxlength="4"><small class="muted">e.g. $, Rs, AED, £, €</small></div></div>
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
            <div class="field"><label>Points per ${esc(s.currency)}1 spent</label><input type="number" min="0" step="0.1" name="points_per_unit" value="${esc(s.points_per_unit)}"></div>
            <div class="field"><label>Points for a reward</label><input type="number" min="0" name="reward_points" value="${esc(s.reward_points)}"></div>
            <div class="field"><label>Reward value (${esc(s.currency)})</label><input type="number" min="0" step="0.01" name="reward_value" value="${esc(s.reward_value)}"></div>
          </div>
          <small class="muted">Customers can redeem points for a discount when booking. Set points per ${esc(s.currency)}1 to 0 to switch the programme off.</small>
        </div>
        <div><button class="btn btn-primary">Save settings</button></div>
      </form>
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
      try {
        await api('PUT', '/api/admin/settings', d);
        await UI.loadSettings();
        toast('Settings saved', 'success');
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
  UI.router(
    {
      '/': dashboard,
      '/bookings': bookings,
      '/vehicles': vehicles,
      '/vehicles/:id': vehicleDetail,
      '/customers': customers,
      '/customers/:id': customerDetail,
      '/services': services,
      '/staff': staff,
      '/reports': reports,
      '/settings': settings,
    },
    { onChange: UI.setActiveNav },
  ).run();
})();
