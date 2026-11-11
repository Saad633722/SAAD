(async function () {
  'use strict';
  const { api, esc, money, fmtDate, fmtShortDate, fmtTime, fmtDateTime, timeAgo, statusBadge, payBadge, plate, stars, cap, vehicleName, toast, modal, confirmDialog } = UI;
  const main = document.getElementById('main');

  let { user } = await api('GET', '/api/auth/me');
  if (!user) return (location.href = '/');
  if (user.role === 'admin') return (location.href = '/admin');
  UI.bindShell(user);
  await UI.loadSettings();
  document.title = `My account — ${UI.state.settings.business_name}`;
  const S = () => UI.state.settings;

  const refreshUser = async () => {
    const r = await api('GET', '/api/my/me');
    user = r.user;
    return r;
  };
  const setPage = (html) => (main.innerHTML = html);
  const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="btn-row">${actions}</div></div>`;
  const addonsText = (b) => (b.addons && b.addons.length ? `<div class="muted" style="font-size:.85rem">+ ${b.addons.map((a) => esc(a.name)).join(', ')}</div>` : '');
  const isActive = (b) => ['pending', 'confirmed', 'in_progress'].includes(b.status);
  const STATUS_HELP = {
    pending: 'Waiting for the team to confirm your booking.',
    confirmed: 'You are booked in — see you soon!',
    in_progress: 'We are working on your car right now.',
    completed: 'All done. Thanks for visiting!',
    cancelled: 'This booking was cancelled.',
    no_show: 'Marked as missed.',
  };

  // ---------------------------------------------------------------------
  // Shared pieces
  // ---------------------------------------------------------------------
  let slotRequests = 0;
  /** Render bookable start times for a date. Returns the availability data (or null if superseded). */
  async function slotPicker(container, date, { selected, duration, exclude } = {}) {
    const token = String(++slotRequests);
    container.dataset.req = token;
    container.innerHTML = '<div class="muted">Loading times…</div>';
    try {
      const qs = new URLSearchParams({ date });
      if (duration) qs.set('duration', duration);
      if (exclude) qs.set('exclude', exclude);
      const av = await api('GET', `/api/availability?${qs}`);
      if (container.dataset.req !== token) return null;
      if (!av.open) return (container.innerHTML = '<div class="alert info">We are closed on this day. Please pick another date.</div>'), av;
      if (!av.slots.some((s) => s.available)) {
        container.innerHTML = `<div class="alert info">No free bay for ${duration && duration > 120 ? 'a job this long' : 'this service'} on this day. Please pick another date.</div>`;
        return av;
      }
      container.innerHTML = `<div class="slots">${av.slots
        .map(
          (s) => `<label class="slot ${s.available ? '' : 'disabled'}"><input type="radio" name="time" value="${s.time}" ${s.available ? '' : 'disabled'} ${s.time === selected && s.available ? 'checked' : ''}>${s.time}
          <small>${s.available ? `${s.remaining} bay${s.remaining === 1 ? '' : 's'} free` : 'full'}</small></label>`,
        )
        .join('')}</div>`;
      return av;
    } catch (e) {
      if (container.dataset.req === token) container.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
      return null;
    }
  }

  function dateLimits() {
    const max = new Date();
    max.setDate(max.getDate() + Number(S().booking_window_days || 30));
    return { min: UI.localDate(), max: UI.localDate(max) };
  }

  /** First open day from today onwards. */
  function firstOpenDate() {
    const d = new Date();
    for (let i = 0; i < 14; i++) {
      if ((S().open_days || []).includes(d.getDay())) {
        if (i > 0 || `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` < S().close_time) return UI.localDate(d);
      }
      d.setDate(d.getDate() + 1);
    }
    return UI.localDate();
  }

  function vehicleModal(v, onSaved) {
    modal({
      title: v ? `Edit ${v.plate}` : 'Add a vehicle',
      body: `${UI.vehicleFields(v || {})}<div class="field"><label>Notes for our team</label><textarea name="notes" placeholder="e.g. child seat in the back, roof rack…">${esc(v?.notes)}</textarea></div>`,
      onSubmit: async (d) => {
        const r = v ? await api('PATCH', `/api/my/vehicles/${v.id}`, d) : await api('POST', '/api/my/vehicles', d);
        toast(v ? 'Vehicle updated' : 'Vehicle added', 'success');
        await onSaved(r.vehicle);
      },
    });
  }

  async function showBooking(id, onChange) {
    const { booking: b } = await api('GET', `/api/my/bookings/${id}`);
    const m = modal({
      title: `Booking ${b.code}`,
      wide: true,
      body: `<div class="grid grid-2">
        <div>
          <p>${statusBadge(b.status)} ${b.status === 'completed' ? payBadge(b.payment_status) : ''}</p>
          <p class="muted">${esc(STATUS_HELP[b.status])}</p>
          <dl class="kv">
            <dt>When</dt><dd>${esc(fmtDateTime(b.scheduled_at))}</dd>
            <dt>Vehicle</dt><dd>${plate(b.plate)} ${esc(vehicleName(b))}</dd>
            <dt>Work time</dt><dd>${esc(UI.fmtDuration(b.duration_min))}</dd>
            ${b.ready_at && isActive(b) ? `<dt>Ready around</dt><dd>${esc(fmtDateTime(b.ready_at))}</dd>` : ''}
            ${b.staff_name ? `<dt>Handled by</dt><dd>${esc(b.staff_name)}</dd>` : ''}
            ${b.points_earned ? `<dt>Points earned</dt><dd>+${b.points_earned}</dd>` : ''}
            ${b.customer_notes ? `<dt>Your note</dt><dd>${esc(b.customer_notes)}</dd>` : ''}
            ${b.rating ? `<dt>Your rating</dt><dd>${stars(b.rating)} ${esc(b.feedback || '')}</dd>` : ''}
          </dl>
          <h3 style="margin-top:16px">Progress</h3>${UI.timeline(b.events)}
        </div>
        <div><h3>Receipt</h3>${UI.priceLines(b)}</div></div>`,
      footer: `${['pending', 'confirmed'].includes(b.status) ? '<button class="btn" data-resched>Reschedule</button><button class="btn btn-danger" data-cancel>Cancel booking</button>' : ''}
        ${b.status === 'completed' && !b.rating ? '<button class="btn btn-primary" data-rate>Rate this service</button>' : ''}
        <button class="btn" onclick="window.print()">🖨 Print</button><button class="btn" data-close>Close</button>`,
    });
    const after = async () => {
      m.close();
      if (onChange) await onChange();
    };
    m.el.querySelector('[data-cancel]')?.addEventListener('click', () => cancelBooking(b, after));
    m.el.querySelector('[data-resched]')?.addEventListener('click', () => reschedule(b, after));
    m.el.querySelector('[data-rate]')?.addEventListener('click', () => rate(b, after));
  }

  async function cancelBooking(b, done) {
    if (!(await confirmDialog(`Cancel your ${b.service_name} on ${fmtDateTime(b.scheduled_at)}?${b.points_redeemed ? ` Your ${b.points_redeemed} points will be refunded.` : ''}`, { okLabel: 'Yes, cancel', danger: true }))) return;
    try {
      await api('POST', `/api/my/bookings/${b.id}/cancel`, {});
      toast('Booking cancelled', 'success');
      await done();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function reschedule(b, done) {
    const lim = dateLimits();
    const date = b.scheduled_at.slice(0, 10) >= lim.min ? b.scheduled_at.slice(0, 10) : firstOpenDate();
    modal({
      title: 'Reschedule booking',
      body: `<div class="field"><label>Date</label><input type="date" name="date" value="${date}" min="${lim.min}" max="${lim.max}" required></div><label>Time</label><div data-slots></div>`,
      submitLabel: 'Move booking',
      onOpen: (el) => {
        const box = el.querySelector('[data-slots]');
        const input = el.querySelector('[name=date]');
        const load = () => slotPicker(box, input.value, { duration: b.duration_min, exclude: b.id });
        load();
        input.addEventListener('change', load);
      },
      onSubmit: async (d) => {
        if (!d.time) throw new Error('Please choose a time.');
        await api('POST', `/api/my/bookings/${b.id}/reschedule`, { scheduled_at: `${d.date} ${d.time}` });
        toast('Booking moved', 'success');
        await done();
      },
    });
  }

  function rate(b, done) {
    modal({
      title: 'How did we do?',
      body: `<div class="field"><div class="star-input">${[1, 2, 3, 4, 5].map((n) => `<label data-star="${n}"><input type="radio" name="rating" value="${n}">★</label>`).join('')}</div></div>
        <div class="field"><label>Comments (optional)</label><textarea name="feedback" placeholder="Tell us what went well or what we can improve"></textarea></div>`,
      submitLabel: 'Submit rating',
      onOpen: (el) => {
        const labels = el.querySelectorAll('[data-star]');
        labels.forEach((l) => l.addEventListener('click', () => labels.forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= Number(l.dataset.star)))));
      },
      onSubmit: async (d) => {
        if (!d.rating) throw new Error('Please choose a star rating.');
        await api('POST', `/api/my/bookings/${b.id}/rate`, d);
        toast('Thanks for your feedback!', 'success');
        await done();
      },
    });
  }

  const bookingCard = (b) => `
    <div class="card">
      <div class="card-head"><div><b>${esc(fmtDate(b.scheduled_at))}</b> · ${esc(fmtTime(b.scheduled_at))}</div>${statusBadge(b.status)}</div>
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div><div><b>${esc(b.service_name)}</b></div>${addonsText(b)}<div style="margin-top:6px">${plate(b.plate)} <span class="muted">${esc(vehicleName(b))}</span></div></div>
        <div style="text-align:right"><b>${money(b.total)}</b><div class="muted mono" style="font-size:.8rem">${esc(b.code)}</div></div>
      </div>
      <p class="muted" style="margin:10px 0">${esc(STATUS_HELP[b.status])}${isActive(b) && b.ready_at ? ` <span class="ready">Ready around <b>${esc(fmtDateTime(b.ready_at))}</b></span>` : ''}</p>
      <div class="btn-row">
        <button class="btn btn-sm" data-show="${b.id}">Details</button>
        ${['pending', 'confirmed'].includes(b.status) ? `<button class="btn btn-sm" data-resched="${b.id}">Reschedule</button><button class="btn btn-sm btn-danger" data-cancel="${b.id}">Cancel</button>` : ''}
        ${b.status === 'completed' && !b.rating ? `<button class="btn btn-sm btn-primary" data-rate="${b.id}">Rate</button>` : ''}
        ${b.rating ? stars(b.rating) : ''}
        ${!isActive(b) ? `<a class="btn btn-sm btn-ghost" href="#/book?vehicle=${b.vehicle_id}&service=${b.service_id || ''}">Book again</a>` : ''}
      </div>
    </div>`;

  function bindBookingActions(list, reload) {
    const find = (id) => list.find((b) => b.id === Number(id));
    main.querySelectorAll('[data-show]').forEach((el) => el.addEventListener('click', () => showBooking(el.dataset.show, reload)));
    main.querySelectorAll('[data-cancel]').forEach((el) => el.addEventListener('click', () => cancelBooking(find(el.dataset.cancel), reload)));
    main.querySelectorAll('[data-resched]').forEach((el) => el.addEventListener('click', () => reschedule(find(el.dataset.resched), reload)));
    main.querySelectorAll('[data-rate]').forEach((el) => el.addEventListener('click', () => rate(find(el.dataset.rate), reload)));
  }

  // ---------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------
  async function home() {
    const [{ stats }, { bookings }, { vehicles }] = await Promise.all([refreshUser(), api('GET', '/api/my/bookings'), api('GET', '/api/my/vehicles')]);
    const upcoming = bookings.filter(isActive);
    const last = bookings.find((b) => b.status === 'completed');
    const busyIds = new Set(upcoming.map((b) => b.vehicle_id));
    const reminders = vehicles
      .flatMap((v) => (v.protections || []).map((p) => ({ v, p })))
      .filter(({ p }) => p.maintenance_status === 'overdue' || p.maintenance_status === 'due_soon' || p.warranty_status === 'expiring')
      .map(({ v, p }) => {
        const due = p.maintenance_status === 'overdue' || p.maintenance_status === 'due_soon';
        const text = due
          ? `Your <b>${esc(p.name)}</b> on ${plate(v.plate)} ${p.maintenance_status === 'overdue' ? 'was due for a maintenance visit on' : 'is due for a maintenance visit on'} <b>${esc(fmtDate(p.next_maintenance_at))}</b>. Regular maintenance keeps it looking its best and your warranty valid.`
          : `The warranty on your <b>${esc(p.name)}</b> (${plate(v.plate)}) ends on <b>${esc(fmtDate(p.warranty_until))}</b>. Ask us about a top-up.`;
        return `<div class="alert warn" style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><span>🛡 ${text}</span>${busyIds.has(v.id) ? '<span class="badge confirmed">Booked</span>' : `<a class="btn btn-sm" href="#/book?vehicle=${v.id}">Book a visit</a>`}</div>`;
      })
      .join('');
    const rp = Number(S().reward_points) || 0;
    const loyaltyOn = Number(S().points_per_unit) > 0 && rp > 0;
    const pct = loyaltyOn ? Math.min(100, ((user.loyalty_points % rp) / rp) * 100) : 0;
    const rewards = loyaltyOn ? Math.floor(user.loyalty_points / rp) : 0;
    setPage(`
      ${pageHead(`Hi ${user.name.split(' ')[0]} 👋`, 'Welcome back. Ready for a sparkling car?', '<a class="btn btn-primary" href="#/book">+ Book a service</a>')}
      ${reminders}
      <div class="grid grid-3">
        ${
          loyaltyOn
            ? `<div class="card stat loyalty"><span class="label">Loyalty points</span><span class="value">${user.loyalty_points}</span>
          <span class="sub">${rewards ? `You can redeem ${rewards} reward${rewards > 1 ? 's' : ''} worth ${money(rewards * S().reward_value)}!` : `${rp - (user.loyalty_points % rp)} more points to a ${money(S().reward_value)} reward`}</span>
          <div class="progress"><div style="width:${pct}%"></div></div></div>`
            : ''
        }
        <div class="card stat"><span class="label">Visits completed</span><span class="value">${stats.completed || 0}</span><span class="sub">${last ? `Last one ${esc(timeAgo(last.scheduled_at))}` : 'No visits yet'}</span></div>
        <div class="card stat"><span class="label">My vehicles</span><span class="value">${vehicles.length}</span><span class="sub"><a href="#/vehicles">Manage vehicles →</a></span></div>
      </div>
      <h2 style="margin-top:24px">Upcoming</h2>
      ${upcoming.length ? `<div class="grid grid-2">${upcoming.map(bookingCard).join('')}</div>` : `<div class="card empty">No upcoming bookings. <a href="#/book">Book your next service →</a></div>`}
      ${
        !vehicles.length
          ? `<div class="card" style="margin-top:16px"><h3>Add your first vehicle</h3><p class="muted">Add your car once and book in seconds from then on. We'll also keep its full service history and any coating or PPF warranty for you.</p><button class="btn btn-primary" data-add-vehicle>+ Add vehicle</button></div>`
          : ''
      }`);
    bindBookingActions(bookings, home);
    main.querySelector('[data-add-vehicle]')?.addEventListener('click', () => vehicleModal(null, home));
  }

  // ---------------------------------------------------------------------
  // Book a service
  // ---------------------------------------------------------------------
  async function book(_p, query) {
    const [{ services }, { vehicles }] = await Promise.all([api('GET', '/api/services'), api('GET', '/api/my/vehicles'), refreshUser()]);
    const packages = services.filter((s) => s.kind === 'package');
    const addons = services.filter((s) => s.kind === 'addon');
    if (!vehicles.length) {
      setPage(`${pageHead('Book a service')}<div class="card"><h3>First, add your vehicle</h3><p class="muted">We need to know which car we're working on.</p><button class="btn btn-primary" data-add>+ Add vehicle</button></div>`);
      main.querySelector('[data-add]').addEventListener('click', () => vehicleModal(null, () => book(_p, query)));
      return;
    }
    const lim = dateLimits();
    const busy = await api('GET', '/api/my/bookings').then((r) => new Set(r.bookings.filter(isActive).map((b) => b.vehicle_id)));
    const preVehicle = Number(query.vehicle) || vehicles.find((v) => !busy.has(v.id))?.id;
    const preService = Number(query.service) || packages.find((s) => s.category === 'wash')?.id || packages[0]?.id;
    const canRedeem = Number(S().reward_points) > 0 && user.loyalty_points >= Number(S().reward_points);
    const chips = (s) =>
      `<div class="meta-line"><span class="chip muted">⏱ ${esc(UI.fmtDuration(s.duration_min))}</span>${s.warranty_months ? `<span class="chip">🛡 Warranty ${esc(UI.fmtMonths(s.warranty_months))}</span>` : ''}</div>`;
    setPage(`
      ${pageHead('Book a service', 'Pick your car, a service and a drop-off time.')}
      <form data-book class="grid grid-3" novalidate>
        <div class="span-2 stack">
          <div class="card"><div class="card-head"><h2>1. Vehicle</h2><button type="button" class="btn btn-sm" data-add-vehicle>+ Add vehicle</button></div>
            <div class="choice-grid">${vehicles
              .map(
                (v) => `<label class="choice" ${busy.has(v.id) ? 'style="opacity:.55" title="This vehicle already has an upcoming booking"' : ''}><input type="radio" name="vehicle_id" value="${v.id}" ${v.id === preVehicle ? 'checked' : ''} ${busy.has(v.id) ? 'disabled' : ''}>
                <div class="title"><span>${esc(vehicleName(v))}</span>${plate(v.plate)}</div><div class="desc">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''}${busy.has(v.id) ? ' · already booked' : ''}</div></label>`,
              )
              .join('')}</div>
            ${Number(S().large_vehicle_surcharge) ? `<small class="muted" style="display:block;margin-top:8px">SUVs, pickups and vans have a ${esc(S().large_vehicle_surcharge)}% size surcharge.</small>` : ''}
          </div>
          <div class="card"><h2>2. Service</h2>
            ${UI.byCategory(packages)
              .map(
                ([cat, list]) => `<h3 class="cat-title">${esc(UI.CATEGORY[cat] || cat)}</h3>
              <div class="choice-grid">${list
                .map(
                  (s) => `<label class="choice"><input type="radio" name="service_id" value="${s.id}" ${s.id === preService ? 'checked' : ''}>
                  <div class="title"><span>${esc(s.name)}</span><span>${money(s.price)}</span></div><div class="desc">${esc(s.description || '')}</div>${chips(s)}</label>`,
                )
                .join('')}</div>`,
              )
              .join('')}
          </div>
          ${
            addons.length
              ? `<div class="card"><h2>3. Extras <small class="muted">(optional)</small></h2>
            <div class="choice-grid">${addons
              .map((a) => `<label class="choice"><input type="checkbox" name="addon_ids" value="${a.id}" data-array><div class="title"><span>${esc(a.name)}</span><span>+${money(a.price)}</span></div><div class="desc">${esc(a.description || '')}</div>${chips(a)}</label>`)
              .join('')}</div></div>`
              : ''
          }
          <div class="card"><h2>${addons.length ? 4 : 3}. Drop-off date &amp; time</h2>
            <p class="muted" style="margin-top:-4px">Longer jobs like PPF and ceramic coating keep your car with us for more than a day — we only show times when a bay is free for the whole job.</p>
            <div class="field" style="max-width:240px"><input type="date" name="date" value="${firstOpenDate()}" min="${lim.min}" max="${lim.max}"></div>
            <div data-slots></div>
          </div>
          <div class="card"><h2>Anything we should know?</h2><textarea name="notes" placeholder="e.g. stone chips on the bonnet, pet hair in the boot, please skip the air freshener"></textarea></div>
        </div>
        <div>
          <div class="card sticky-summary">
            <h2>Summary</h2>
            <div data-summary class="muted">Choose a service to see the price.</div>
            <div data-ready></div>
            ${canRedeem ? `<label class="check" style="margin:14px 0 0"><input type="checkbox" name="redeem_points"> Use my ${user.loyalty_points} points</label><small class="muted">${S().reward_points} points = ${money(S().reward_value)} off</small>` : ''}
            <div class="alert hidden" data-error style="margin-top:14px"></div>
            <button class="btn btn-primary btn-block" style="margin-top:16px" type="submit">Confirm booking</button>
            <small class="muted" style="display:block;margin-top:8px;text-align:center">Pay at the shop when you collect your car.</small>
          </div>
        </div>
      </form>`);
    const form = main.querySelector('[data-book]');
    const slots = main.querySelector('[data-slots]');
    const summary = main.querySelector('[data-summary]');
    const readyBox = main.querySelector('[data-ready]');
    const dateInput = form.querySelector('[name=date]');
    main.querySelector('[data-add-vehicle]').addEventListener('click', () => vehicleModal(null, (v) => (location.hash = `#/book?vehicle=${v.id}`)));

    let duration = null;
    let av = null;
    const renderReady = () => {
      const time = form.querySelector('[name=time]:checked')?.value;
      const slot = av?.slots?.find((x) => x.time === time);
      readyBox.innerHTML = slot
        ? `<div class="alert info" style="margin:12px 0 0">Drop-off <b>${esc(fmtDateTime(`${dateInput.value} ${time}`))}</b><br>Ready around <b>${esc(slot.ready_at.slice(0, 10) === dateInput.value ? fmtTime(slot.ready_at) : fmtDateTime(slot.ready_at))}</b></div>`
        : '';
    };
    const loadSlots = async () => {
      const selected = form.querySelector('[name=time]:checked')?.value;
      const res = await slotPicker(slots, dateInput.value, { selected, duration });
      if (res) av = res;
      renderReady();
    };

    let seq = 0;
    const updateQuote = async () => {
      const d = UI.formData(form);
      if (!d.service_id) return;
      const mySeq = ++seq;
      try {
        const q = await api('POST', '/api/my/quote', { vehicle_id: d.vehicle_id, service_id: d.service_id, addon_ids: d.addon_ids || [], redeem_points: d.redeem_points });
        if (mySeq !== seq) return;
        const svc = packages.find((s) => s.id === Number(d.service_id));
        const chosen = addons.filter((a) => (d.addon_ids || []).includes(String(a.id)));
        summary.innerHTML = UI.priceLines({ service_name: svc.name, service_price: svc.price, addons: chosen, ...q }) + `<div class="muted" style="margin-top:8px">⏱ Work time: ${esc(UI.fmtDuration(q.duration_min))}</div>`;
        if (q.duration_min !== duration) {
          duration = q.duration_min;
          loadSlots();
        }
      } catch (e) {
        summary.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
      }
    };
    form.addEventListener('change', (e) => {
      if (e.target.name === 'date') loadSlots();
      else if (e.target.name === 'time') renderReady();
      else updateQuote();
    });
    updateQuote().then(() => duration === null && loadSlots());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = UI.formData(form);
      const err = form.querySelector('[data-error]');
      err.classList.add('hidden');
      const fail = (m) => {
        err.textContent = m;
        err.classList.remove('hidden');
      };
      if (!d.vehicle_id) return fail('Please choose a vehicle.');
      if (!d.service_id) return fail('Please choose a service.');
      if (!d.time) return fail('Please choose a drop-off time.');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const { booking } = await api('POST', '/api/my/bookings', {
          vehicle_id: d.vehicle_id,
          service_id: d.service_id,
          addon_ids: d.addon_ids || [],
          scheduled_at: `${d.date} ${d.time}`,
          notes: d.notes,
          redeem_points: d.redeem_points,
        });
        modal({
          title: 'Booking received 🎉',
          body: `<p>Your booking <b class="mono">${esc(booking.code)}</b> for <b>${esc(booking.service_name)}</b> is set for <b>${esc(fmtDateTime(booking.scheduled_at))}</b>.
            ${booking.ready_at ? `We expect your car to be ready around <b>${esc(fmtDateTime(booking.ready_at))}</b>.` : ''}</p>
            <p class="muted">We'll confirm it shortly. You can follow its status under “My bookings”.</p>${UI.priceLines(booking)}`,
        });
        location.hash = '#/bookings';
      } catch (ex) {
        fail(ex.message);
        if (/slot|time|bay/i.test(ex.message)) loadSlots();
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------
  // My bookings
  // ---------------------------------------------------------------------
  async function bookings() {
    const { bookings: list } = await api('GET', '/api/my/bookings');
    const upcoming = list.filter(isActive);
    const past = list.filter((b) => !isActive(b));
    setPage(`
      ${pageHead('My bookings', '', '<a class="btn btn-primary" href="#/book">+ Book a service</a>')}
      <h2>Upcoming</h2>
      ${upcoming.length ? `<div class="grid grid-2">${upcoming.map(bookingCard).join('')}</div>` : '<div class="card empty">Nothing booked. <a href="#/book">Book a service →</a></div>'}
      <h2 style="margin-top:24px">Past</h2>
      <div class="card">${
        past.length
          ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Vehicle</th><th>Service</th><th>Status</th><th class="num">Total</th><th></th></tr></thead><tbody>
          ${past
            .map(
              (b) => `<tr><td>${esc(fmtDate(b.scheduled_at))}<br><small>${esc(fmtTime(b.scheduled_at))}</small></td><td>${plate(b.plate)}</td><td>${esc(b.service_name)}${addonsText(b)}</td>
              <td>${statusBadge(b.status)} ${stars(b.rating)}</td><td class="num">${money(b.total)}</td>
              <td class="num"><div class="btn-row" style="justify-content:flex-end"><button class="btn btn-sm" data-show="${b.id}">Receipt</button>${b.status === 'completed' && !b.rating ? `<button class="btn btn-sm btn-primary" data-rate="${b.id}">Rate</button>` : ''}<a class="btn btn-sm btn-ghost" href="#/book?vehicle=${b.vehicle_id}&service=${b.service_id || ''}">Book again</a></div></td></tr>`,
            )
            .join('')}</tbody></table></div>`
          : '<div class="empty">No past bookings yet.</div>'
      }</div>`);
    bindBookingActions(list, bookings);
  }

  // ---------------------------------------------------------------------
  // My vehicles
  // ---------------------------------------------------------------------
  async function vehicles() {
    const { vehicles: list } = await api('GET', '/api/my/vehicles');
    setPage(`
      ${pageHead('My vehicles', 'Your cars, their service history and warranties.', '<button class="btn btn-primary" data-add>+ Add vehicle</button>')}
      ${
        list.length
          ? `<div class="grid grid-cards">${list
              .map(
                (v) => `<div class="card vehicle-card">
            <div class="top"><div><div class="name">${esc(vehicleName(v))}</div><div class="muted">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''}</div></div>${plate(v.plate)}</div>
            <div class="muted">${v.washes} visit${v.washes === 1 ? '' : 's'}${v.last_wash ? ` · last ${esc(timeAgo(v.last_wash))}` : ''}</div>
            ${(v.protections || []).filter((p) => p.active).length ? `<div class="btn-row">${v.protections.filter((p) => p.active).map((p) => `<span class="chip">🛡 ${esc(p.name)}${p.warranty_until ? ` · until ${esc(fmtShortDate(p.warranty_until))} ${esc(p.warranty_until.slice(0, 4))}` : ''}</span>`).join('')}</div>` : ''}
            <div class="btn-row"><a class="btn btn-sm btn-primary" href="#/book?vehicle=${v.id}">Book</a><a class="btn btn-sm" href="#/vehicles/${v.id}">History</a><button class="btn btn-sm" data-edit="${v.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${v.id}">Remove</button></div>
          </div>`,
              )
              .join('')}</div>`
          : '<div class="card empty">You have not added any vehicles yet.</div>'
      }`);
    main.querySelector('[data-add]').addEventListener('click', () => vehicleModal(null, vehicles));
    main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => vehicleModal(list.find((v) => v.id === Number(b.dataset.edit)), vehicles)));
    main.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const v = list.find((x) => x.id === Number(b.dataset.del));
        if (!(await confirmDialog(`Remove ${v.plate} from your account?`, { okLabel: 'Remove', danger: true }))) return;
        try {
          await api('DELETE', `/api/my/vehicles/${v.id}`);
          toast('Vehicle removed', 'success');
          vehicles();
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
  }

  async function vehicleHistory({ id }) {
    const { vehicle: v, stats: st, bookings: list, protections } = await api('GET', `/api/my/vehicles/${id}/history`);
    setPage(`
      <div style="margin-bottom:12px"><a href="#/vehicles">← My vehicles</a></div>
      <div class="card"><div class="page-head" style="margin:0">
        <div><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${plate(v.plate, 'lg')}<h1 style="margin:0">${esc(vehicleName(v))}</h1></div>
        <p style="margin-top:8px">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''}</p></div>
        <div class="btn-row"><a class="btn btn-primary" href="#/book?vehicle=${v.id}">Book a service</a></div></div></div>
      <div class="grid grid-4" style="margin-top:16px">
        <div class="card stat"><span class="label">Visits</span><span class="value">${st.completed_washes}</span></div>
        <div class="card stat"><span class="label">Total spent</span><span class="value">${money(st.total_spent)}</span></div>
        <div class="card stat"><span class="label">Last visit</span><span class="value" style="font-size:1.2rem">${st.last_visit ? esc(timeAgo(st.last_visit)) : 'Never'}</span></div>
        <div class="card stat"><span class="label">Favourite</span><span class="value" style="font-size:1.2rem">${esc(st.favourite_service || '—')}</span></div>
      </div>
      ${protections && protections.length ? `<div class="card" style="margin-top:16px"><h2>Protection &amp; warranty</h2>${UI.protectionCards(protections)}</div>` : ''}
      <div class="card" style="margin-top:16px"><h2>Service history</h2>
        ${
          list.length
            ? `<ul class="timeline">${list
                .map(
                  (b) => `<li class="${esc(b.status)}"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                <div><b>${esc(b.service_name)}</b> ${statusBadge(b.status)} ${stars(b.rating)}${addonsText(b)}</div><b>${money(b.total)}</b></div>
                <div class="when">${esc(fmtDateTime(b.scheduled_at))} · <a href="#" data-show="${b.id}">details</a></div></li>`,
                )
                .join('')}</ul>`
            : '<div class="empty">No services yet for this vehicle.</div>'
        }
      </div>`);
    main.querySelectorAll('[data-show]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        showBooking(a.dataset.show, () => vehicleHistory({ id }));
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------
  async function profile() {
    const { stats } = await refreshUser();
    setPage(`
      ${pageHead('Profile', `${stats.completed || 0} visits · ${money(stats.spent)} spent · ${user.loyalty_points} loyalty points`)}
      <div class="grid grid-2">
        <form class="card" data-profile><h2>Your details</h2>
          <div class="field"><label>Name</label><input name="name" value="${esc(user.name)}" required></div>
          <div class="field"><label>Email</label><input value="${esc(user.email)}" disabled></div>
          <div class="field"><label>Phone</label><input name="phone" value="${esc(user.phone)}"></div>
          <button class="btn btn-primary">Save</button>
        </form>
        <form class="card" data-password><h2>Change password</h2>
          <div class="field"><label>Current password</label><input type="password" name="current_password" required></div>
          <div class="field"><label>New password</label><input type="password" name="new_password" minlength="6" required></div>
          <button class="btn">Update password</button>
        </form>
      </div>`);
    main.querySelector('[data-profile]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('PATCH', '/api/my/me', UI.formData(e.target));
        user = r.user;
        document.querySelectorAll('[data-user-name]').forEach((el) => (el.textContent = user.name));
        toast('Profile saved', 'success');
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
    main.querySelector('[data-password]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PATCH', '/api/my/me', UI.formData(e.target));
        e.target.reset();
        toast('Password updated', 'success');
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
  }

  UI.router(
    {
      '/': home,
      '/book': book,
      '/bookings': bookings,
      '/vehicles': vehicles,
      '/vehicles/:id': vehicleHistory,
      '/profile': profile,
    },
    { onChange: UI.setActiveNav },
  ).run();
})();
