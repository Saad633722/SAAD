(async function () {
  'use strict';
  const { api, esc, money, fmtDate, fmtShortDate, fmtTime, fmtDateTime, timeAgo, statusBadge, payBadge, plate, stars, cap, vehicleName, toast, modal, confirmDialog } = UI;
  const main = document.getElementById('main');

  let { user } = await api('GET', '/api/auth/me');
  if (!user) return (location.href = '/');
  if (user.role === 'admin') return (location.href = '/admin');
  UI.bindShell(user);
  await UI.loadSettings();
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
    in_progress: 'Your car is being washed right now.',
    completed: 'All done. Thanks for visiting!',
    cancelled: 'This booking was cancelled.',
    no_show: 'Marked as missed.',
  };

  // ---------------------------------------------------------------------
  // Shared pieces
  // ---------------------------------------------------------------------
  async function slotPicker(container, date, selected) {
    container.innerHTML = '<div class="muted">Loading times…</div>';
    try {
      const av = await api('GET', `/api/availability?date=${date}`);
      if (!av.open) return (container.innerHTML = '<div class="alert info">We are closed on this day. Please pick another date.</div>');
      const free = av.slots.filter((s) => s.available);
      if (!free.length) return (container.innerHTML = '<div class="alert info">No free times left on this day. Please pick another date.</div>');
      container.innerHTML = `<div class="slots">${av.slots
        .map(
          (s) => `<label class="slot ${s.available ? '' : 'disabled'}"><input type="radio" name="time" value="${s.time}" ${s.available ? '' : 'disabled'} ${s.time === selected && s.available ? 'checked' : ''}>${s.time}
          <small>${s.available ? `${s.remaining} left` : 'full'}</small></label>`,
        )
        .join('')}</div>`;
    } catch (e) {
      container.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
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
            <dt>Est. duration</dt><dd>${b.duration_min} min</dd>
            ${b.staff_name ? `<dt>Washed by</dt><dd>${esc(b.staff_name)}</dd>` : ''}
            ${b.points_earned ? `<dt>Points earned</dt><dd>+${b.points_earned}</dd>` : ''}
            ${b.customer_notes ? `<dt>Your note</dt><dd>${esc(b.customer_notes)}</dd>` : ''}
            ${b.rating ? `<dt>Your rating</dt><dd>${stars(b.rating)} ${esc(b.feedback || '')}</dd>` : ''}
          </dl>
          <h3 style="margin-top:16px">Progress</h3>${UI.timeline(b.events)}
        </div>
        <div><h3>Receipt</h3>${UI.priceLines(b)}</div></div>`,
      footer: `${['pending', 'confirmed'].includes(b.status) ? '<button class="btn" data-resched>Reschedule</button><button class="btn btn-danger" data-cancel>Cancel booking</button>' : ''}
        ${b.status === 'completed' && !b.rating ? '<button class="btn btn-primary" data-rate>Rate this wash</button>' : ''}
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
        slotPicker(box, input.value);
        input.addEventListener('change', () => slotPicker(box, input.value));
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
      title: 'How was your wash?',
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
      <p class="muted" style="margin:10px 0">${esc(STATUS_HELP[b.status])}</p>
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
    const rp = Number(S().reward_points) || 0;
    const loyaltyOn = Number(S().points_per_unit) > 0 && rp > 0;
    const pct = loyaltyOn ? Math.min(100, ((user.loyalty_points % rp) / rp) * 100) : 0;
    const rewards = loyaltyOn ? Math.floor(user.loyalty_points / rp) : 0;
    setPage(`
      ${pageHead(`Hi ${user.name.split(' ')[0]} 👋`, 'Welcome back. Ready for a sparkling car?', '<a class="btn btn-primary" href="#/book">+ Book a wash</a>')}
      <div class="grid grid-3">
        ${
          loyaltyOn
            ? `<div class="card stat loyalty"><span class="label">Loyalty points</span><span class="value">${user.loyalty_points}</span>
          <span class="sub">${rewards ? `You can redeem ${rewards} reward${rewards > 1 ? 's' : ''} worth ${money(rewards * S().reward_value)}!` : `${rp - (user.loyalty_points % rp)} more points to a ${money(S().reward_value)} reward`}</span>
          <div class="progress"><div style="width:${pct}%"></div></div></div>`
            : ''
        }
        <div class="card stat"><span class="label">Washes completed</span><span class="value">${stats.completed || 0}</span><span class="sub">${last ? `Last one ${esc(timeAgo(last.scheduled_at))}` : 'No washes yet'}</span></div>
        <div class="card stat"><span class="label">My vehicles</span><span class="value">${vehicles.length}</span><span class="sub"><a href="#/vehicles">Manage vehicles →</a></span></div>
      </div>
      <h2 style="margin-top:24px">Upcoming</h2>
      ${upcoming.length ? `<div class="grid grid-2">${upcoming.map(bookingCard).join('')}</div>` : `<div class="card empty">No upcoming bookings. <a href="#/book">Book your next wash →</a></div>`}
      ${
        !vehicles.length
          ? `<div class="card" style="margin-top:16px"><h3>Add your first vehicle</h3><p class="muted">Add your car once and book in seconds from then on. We'll also keep its full wash history for you.</p><button class="btn btn-primary" data-add-vehicle>+ Add vehicle</button></div>`
          : ''
      }`);
    bindBookingActions(bookings, home);
    main.querySelector('[data-add-vehicle]')?.addEventListener('click', () => vehicleModal(null, home));
  }

  // ---------------------------------------------------------------------
  // Book a wash
  // ---------------------------------------------------------------------
  async function book(_p, query) {
    const [{ services }, { vehicles }] = await Promise.all([api('GET', '/api/services'), api('GET', '/api/my/vehicles'), refreshUser()]);
    const packages = services.filter((s) => s.kind === 'package');
    const addons = services.filter((s) => s.kind === 'addon');
    if (!vehicles.length) {
      setPage(`${pageHead('Book a wash')}<div class="card"><h3>First, add your vehicle</h3><p class="muted">We need to know which car we're washing.</p><button class="btn btn-primary" data-add>+ Add vehicle</button></div>`);
      main.querySelector('[data-add]').addEventListener('click', () => vehicleModal(null, () => book(_p, query)));
      return;
    }
    const lim = dateLimits();
    const busy = await api('GET', '/api/my/bookings').then((r) => new Set(r.bookings.filter(isActive).map((b) => b.vehicle_id)));
    const preVehicle = Number(query.vehicle) || vehicles.find((v) => !busy.has(v.id))?.id;
    const preService = Number(query.service) || packages[Math.min(1, packages.length - 1)]?.id;
    const canRedeem = Number(S().reward_points) > 0 && user.loyalty_points >= Number(S().reward_points);
    setPage(`
      ${pageHead('Book a wash', 'Pick your car, a package and a time.')}
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
          <div class="card"><h2>2. Package</h2>
            <div class="choice-grid">${packages
              .map(
                (s) => `<label class="choice"><input type="radio" name="service_id" value="${s.id}" ${s.id === preService ? 'checked' : ''}>
                <div class="title"><span>${esc(s.name)}</span><span>${money(s.price)}</span></div><div class="desc">${esc(s.description || '')}</div><div class="desc">⏱ ${s.duration_min} min</div></label>`,
              )
              .join('')}</div>
          </div>
          ${
            addons.length
              ? `<div class="card"><h2>3. Extras <small class="muted">(optional)</small></h2>
            <div class="choice-grid">${addons
              .map((a) => `<label class="choice"><input type="checkbox" name="addon_ids" value="${a.id}" data-array><div class="title"><span>${esc(a.name)}</span><span>+${money(a.price)}</span></div><div class="desc">${esc(a.description || '')}</div></label>`)
              .join('')}</div></div>`
              : ''
          }
          <div class="card"><h2>${addons.length ? 4 : 3}. Date &amp; time</h2>
            <div class="field" style="max-width:240px"><input type="date" name="date" value="${firstOpenDate()}" min="${lim.min}" max="${lim.max}"></div>
            <div data-slots></div>
          </div>
          <div class="card"><h2>Anything we should know?</h2><textarea name="notes" placeholder="e.g. pet hair in the boot, please skip the air freshener"></textarea></div>
        </div>
        <div>
          <div class="card sticky-summary">
            <h2>Summary</h2>
            <div data-summary class="muted">Choose a package to see the price.</div>
            ${canRedeem ? `<label class="check" style="margin:14px 0 0"><input type="checkbox" name="redeem_points"> Use my ${user.loyalty_points} points</label><small class="muted">${S().reward_points} points = ${money(S().reward_value)} off</small>` : ''}
            <div class="alert hidden" data-error style="margin-top:14px"></div>
            <button class="btn btn-primary btn-block" style="margin-top:16px" type="submit">Confirm booking</button>
            <small class="muted" style="display:block;margin-top:8px;text-align:center">Pay at the car wash after your service.</small>
          </div>
        </div>
      </form>`);
    const form = main.querySelector('[data-book]');
    const slots = main.querySelector('[data-slots]');
    const summary = main.querySelector('[data-summary]');
    const dateInput = form.querySelector('[name=date]');
    slotPicker(slots, dateInput.value);
    dateInput.addEventListener('change', () => slotPicker(slots, dateInput.value));
    main.querySelector('[data-add-vehicle]').addEventListener('click', () => vehicleModal(null, (v) => (location.hash = `#/book?vehicle=${v.id}`)));

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
        summary.innerHTML = UI.priceLines({ service_name: svc.name, service_price: svc.price, addons: chosen, ...q }) + `<div class="muted" style="margin-top:8px">⏱ About ${q.duration_min} minutes</div>`;
      } catch (e) {
        summary.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
      }
    };
    form.addEventListener('change', (e) => e.target.name !== 'date' && e.target.name !== 'time' && updateQuote());
    updateQuote();

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
      if (!d.service_id) return fail('Please choose a package.');
      if (!d.time) return fail('Please choose a time slot.');
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
          body: `<p>Your booking <b class="mono">${esc(booking.code)}</b> for <b>${esc(booking.service_name)}</b> is set for <b>${esc(fmtDateTime(booking.scheduled_at))}</b>.</p>
            <p class="muted">We'll confirm it shortly. You can follow its status under “My bookings”.</p>${UI.priceLines(booking)}`,
        });
        location.hash = '#/bookings';
      } catch (ex) {
        fail(ex.message);
        if (/slot|time/i.test(ex.message)) slotPicker(slots, dateInput.value);
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
      ${pageHead('My bookings', '', '<a class="btn btn-primary" href="#/book">+ Book a wash</a>')}
      <h2>Upcoming</h2>
      ${upcoming.length ? `<div class="grid grid-2">${upcoming.map(bookingCard).join('')}</div>` : '<div class="card empty">Nothing booked. <a href="#/book">Book a wash →</a></div>'}
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
      ${pageHead('My vehicles', 'Your cars and their wash history.', '<button class="btn btn-primary" data-add>+ Add vehicle</button>')}
      ${
        list.length
          ? `<div class="grid grid-cards">${list
              .map(
                (v) => `<div class="card vehicle-card">
            <div class="top"><div><div class="name">${esc(vehicleName(v))}</div><div class="muted">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''}</div></div>${plate(v.plate)}</div>
            <div class="muted">${v.washes} wash${v.washes === 1 ? '' : 'es'}${v.last_wash ? ` · last ${esc(timeAgo(v.last_wash))}` : ''}</div>
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
    const { vehicle: v, stats: st, bookings: list } = await api('GET', `/api/my/vehicles/${id}/history`);
    setPage(`
      <div style="margin-bottom:12px"><a href="#/vehicles">← My vehicles</a></div>
      <div class="card"><div class="page-head" style="margin:0">
        <div><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${plate(v.plate, 'lg')}<h1 style="margin:0">${esc(vehicleName(v))}</h1></div>
        <p style="margin-top:8px">${esc(cap(v.type))}${v.color ? ` · ${esc(v.color)}` : ''}</p></div>
        <div class="btn-row"><a class="btn btn-primary" href="#/book?vehicle=${v.id}">Book a wash</a></div></div></div>
      <div class="grid grid-4" style="margin-top:16px">
        <div class="card stat"><span class="label">Washes</span><span class="value">${st.completed_washes}</span></div>
        <div class="card stat"><span class="label">Total spent</span><span class="value">${money(st.total_spent)}</span></div>
        <div class="card stat"><span class="label">Last wash</span><span class="value" style="font-size:1.2rem">${st.last_visit ? esc(timeAgo(st.last_visit)) : 'Never'}</span></div>
        <div class="card stat"><span class="label">Favourite</span><span class="value" style="font-size:1.2rem">${esc(st.favourite_service || '—')}</span></div>
      </div>
      <div class="card" style="margin-top:16px"><h2>Wash history</h2>
        ${
          list.length
            ? `<ul class="timeline">${list
                .map(
                  (b) => `<li class="${esc(b.status)}"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                <div><b>${esc(b.service_name)}</b> ${statusBadge(b.status)} ${stars(b.rating)}${addonsText(b)}</div><b>${money(b.total)}</b></div>
                <div class="when">${esc(fmtDateTime(b.scheduled_at))} · <a href="#" data-show="${b.id}">details</a></div></li>`,
                )
                .join('')}</ul>`
            : '<div class="empty">No washes yet for this vehicle.</div>'
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
      ${pageHead('Profile', `${stats.completed || 0} washes · ${money(stats.spent)} spent · ${user.loyalty_points} loyalty points`)}
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
