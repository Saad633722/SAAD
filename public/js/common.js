/* Shared helpers for both panels. Exposes a global `UI` object. */
(function () {
  'use strict';

  const state = { settings: { currency: '$', open_time: '08:00', close_time: '18:00' }, vehicleTypes: [], paymentMethods: [] };

  // Logo mark: the pink arch with a car from the Mr.Clean sign.
  const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 28 108 58" aria-hidden="true">
    <path d="M10 82a50 50 0 0 1 100 0h-14a36 36 0 0 0-72 0z" fill="#f0899b"/>
    <g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M46.5 59 51 50.5c.6-1.2 1.6-1.8 2.9-1.8h12.2c1.3 0 2.3.6 2.9 1.8l4.5 8.5"/>
      <path d="M36 71v-6.5c0-3.4 2.3-5.6 5.6-5.8h36.8c3.3.2 5.6 2.4 5.6 5.8V71c0 1.8-1.2 3-3 3H39c-1.8 0-3-1.2-3-3z"/>
      <path d="M40.5 63.5 48 65M79.5 63.5 72 65M53 69.5h14M45 57.5l-3.4-1.2M75 57.5l3.4-1.2"/>
      <path d="M41.5 74v3.6M78.5 74v3.6" stroke-width="4.2"/></g></svg>`;
  document.querySelectorAll('[data-logo]').forEach((el) => (el.innerHTML = LOGO));

  const CATEGORY = { wash: 'Car wash', detailing: 'Detailing', ceramic: 'Ceramic coating', ppf: 'PPF (paint protection film)', other: 'Other' };
  const CATEGORY_SHORT = { wash: 'Wash', detailing: 'Detailing', ceramic: 'Ceramic', ppf: 'PPF', other: 'Other' };
  const CATEGORY_ORDER = ['wash', 'detailing', 'ceramic', 'ppf', 'other'];

  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new Error('Network error. Please check your connection.');
    }
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      location.href = '/';
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

  const money = (n) => {
    const v = Number(n || 0);
    return `${state.settings.currency || '$'}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const parse = (s) => (s ? new Date(String(s).replace(' ', 'T')) : null);
  const fmtDate = (s) => (s ? parse(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtShortDate = (s) => (s ? parse(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—');
  const fmtTime = (s) => (s ? parse(s).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
  const fmtDateTime = (s) => (s ? `${fmtDate(s)}, ${fmtTime(s)}` : '—');
  const timeAgo = (s) => {
    if (!s) return 'never';
    const days = Math.floor((Date.now() - parse(s).getTime()) / 86400000);
    if (days < 0) return `in ${-days} day${days === -1 ? '' : 's'}`;
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? '' : 's'} ago`;
    return `${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`;
  };
  const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const STATUS = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    in_progress: 'In progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'No-show',
  };
  const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS[s] || s)}</span>`;
  const payBadge = (s) => `<span class="badge ${esc(s)}">${esc(s ? s[0].toUpperCase() + s.slice(1) : '')}</span>`;
  const plate = (p, cls = '') => `<span class="plate ${cls}">${esc(p)}</span>`;
  const stars = (n) => (n ? `<span class="stars" title="${n}/5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : '');
  const cap = (s) => (s === 'suv' ? 'SUV' : s ? String(s)[0].toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '');
  const vehicleName = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';

  function toast(message, type = '') {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  /** Read a form into a plain object. Checkbox groups with the same name become arrays. */
  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') {
        const group = form.querySelectorAll(`input[type=checkbox][name="${CSS.escape(el.name)}"]`);
        if (group.length > 1 || el.dataset.array !== undefined) {
          out[el.name] = out[el.name] || [];
          if (el.checked) out[el.name].push(el.value);
        } else out[el.name] = el.checked;
      } else if (el.type === 'radio') {
        if (el.checked) out[el.name] = el.value;
      } else out[el.name] = el.value;
    }
    return out;
  }

  /**
   * Open a modal. `body` is HTML. If `onSubmit` is given the body is wrapped in a form
   * and the handler receives the form data; return false to keep the modal open.
   */
  function modal({ title, body, submitLabel = 'Save', onSubmit, wide = false, footer, onOpen, cancelLabel = 'Cancel' }) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    const inner = onSubmit
      ? `<form novalidate><div class="modal-body"><div class="alert hidden" data-error></div>${body}</div>
           <div class="modal-foot"><button type="button" class="btn" data-close>${esc(cancelLabel)}</button><button type="submit" class="btn btn-primary">${esc(submitLabel)}</button></div></form>`
      : `<div class="modal-body">${body}</div>${footer === false ? '' : `<div class="modal-foot">${footer || '<button type="button" class="btn" data-close>Close</button>'}</div>`}`;
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn btn-ghost btn-sm" data-close aria-label="Close">✕</button></div>${inner}</div>`;
    document.body.appendChild(wrap);
    document.body.classList.add('modal-open');
    const close = () => {
      wrap.remove();
      if (!document.querySelector('.modal-backdrop')) document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (e) => e.target === wrap && close());
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    const form = wrap.querySelector('form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        const err = form.querySelector('[data-error]');
        btn.disabled = true;
        err.classList.add('hidden');
        try {
          const keep = await onSubmit(formData(form), form);
          if (keep !== false) close();
        } catch (ex) {
          err.textContent = ex.message;
          err.classList.remove('hidden');
        } finally {
          btn.disabled = false;
        }
      });
      const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
      if (first) setTimeout(() => !wrap.contains(document.activeElement) && first.focus(), 30);
    }
    if (onOpen) onOpen(wrap.querySelector('.modal'), close);
    return { el: wrap.querySelector('.modal'), close };
  }

  function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const m = modal({
        title,
        body: `<p>${esc(message)}</p>`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button>`,
      });
      m.el.querySelector('[data-ok]').addEventListener('click', () => {
        done = true;
        m.close();
        resolve(true);
      });
      const obs = new MutationObserver(() => {
        if (!document.body.contains(m.el)) {
          obs.disconnect();
          if (!done) resolve(false);
        }
      });
      obs.observe(document.body, { childList: true });
    });
  }

  /** Very small hash router: routes = { '/': fn, '/vehicles/:id': fn } */
  function router(routes, { onChange } = {}) {
    const compiled = Object.entries(routes).map(([pattern, handler]) => {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
      return { re, keys, handler, pattern };
    });
    async function run() {
      const hash = location.hash.replace(/^#/, '') || '/';
      const [path, qs] = hash.split('?');
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      for (const r of compiled) {
        const m = r.re.exec(path);
        if (m) {
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          document.body.classList.remove('nav-open');
          if (onChange) onChange(path);
          try {
            await r.handler(params, query);
          } catch (e) {
            const main = document.getElementById('main');
            main.innerHTML = `<div class="card"><div class="alert">${esc(e.message)}</div><a class="btn" href="#/">Back to dashboard</a></div>`;
          }
          return;
        }
      }
      location.hash = '#/';
    }
    window.addEventListener('hashchange', run);
    return { run, refresh: run };
  }

  function setActiveNav(path) {
    document.querySelectorAll('.nav a').forEach((a) => {
      const target = a.getAttribute('href').replace(/^#/, '');
      const active = target === '/' ? path === '/' : path === target || path.startsWith(target + '/');
      a.classList.toggle('active', active);
    });
  }

  async function loadSettings() {
    const data = await api('GET', '/api/settings');
    state.settings = data.settings;
    state.vehicleTypes = data.vehicle_types;
    state.paymentMethods = data.payment_methods;
    document.querySelectorAll('[data-business-name]').forEach((el) => (el.textContent = data.settings.business_name));
    document.querySelectorAll('[data-tagline]').forEach((el) => (el.textContent = data.settings.tagline || ''));
    return data;
  }

  async function logout() {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.href = '/';
  }

  function bindShell(user) {
    document.querySelectorAll('[data-user-name]').forEach((el) => (el.textContent = user.name));
    document.querySelectorAll('[data-user-email]').forEach((el) => (el.textContent = user.email));
    document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', logout));
    document.querySelectorAll('[data-nav-toggle]').forEach((b) => b.addEventListener('click', () => document.body.classList.toggle('nav-open')));
  }

  /** Simple bar chart (vertical). items = [{label, value, title}] */
  function barChart(items, { format = (v) => v } = {}) {
    const max = Math.max(1, ...items.map((i) => i.value));
    return `<div class="bars">${items
      .map(
        (i) => `<div class="bar-col" title="${esc(i.title || `${i.label}: ${format(i.value)}`)}">
          <div class="bar" style="height:${Math.max(1, (i.value / max) * 100)}%"></div>
          <div class="bar-label">${esc(i.label)}</div></div>`,
      )
      .join('')}</div>`;
  }

  /** Horizontal bar list. items = [{name, value, display}] */
  function hbars(items, { format = (v) => v } = {}) {
    if (!items.length) return '<div class="empty">No data yet</div>';
    const max = Math.max(1, ...items.map((i) => i.value));
    return items
      .map(
        (i) => `<div class="hbar"><div class="name" title="${esc(i.name)}">${esc(i.name)}</div>
        <div class="track"><div class="fill" style="width:${(i.value / max) * 100}%"></div></div>
        <div class="mono">${esc(i.display ?? format(i.value))}</div></div>`,
      )
      .join('');
  }

  /** Price breakdown table for a booking or quote. */
  function priceLines(b) {
    const rows = [];
    if (b.service_name) rows.push([b.service_name, money(b.service_price)]);
    for (const a of b.addons || []) rows.push([`+ ${a.name}`, money(a.price)]);
    if (!b.service_name) rows.push(['Subtotal', money(b.subtotal)]);
    if (b.surcharge) rows.push(['Large vehicle surcharge', money(b.surcharge)]);
    if (b.discount) rows.push([`Discount${b.points_redeemed ? ` (${b.points_redeemed} pts)` : ''}`, '−' + money(b.discount)]);
    if (b.tax) rows.push(['Tax', money(b.tax)]);
    return `<table class="price-lines"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td>${esc(money(b.total))}</td></tr></tbody></table>`;
  }

  function timeline(events) {
    if (!events || !events.length) return '<div class="muted">No activity yet.</div>';
    return `<ul class="timeline">${events
      .map(
        (e) => `<li class="${esc(e.status)}"><div>${statusBadge(e.status)} ${e.note ? esc(e.note) : ''}</div>
        <div class="when">${esc(fmtDateTime(e.created_at))}${e.actor_name ? ` · ${esc(e.actor_name)}` : ''}</div></li>`,
      )
      .join('')}</ul>`;
  }

  function vehicleTypeOptions(selected) {
    return state.vehicleTypes.map((t) => `<option value="${t}" ${t === selected ? 'selected' : ''}>${esc(cap(t))}</option>`).join('');
  }

  /** Form fields for a vehicle (used by both panels). */
  function vehicleFields(v = {}) {
    return `<div class="form-row">
        <div class="field"><label>Licence plate *</label><input name="plate" required maxlength="15" value="${esc(v.plate)}" placeholder="ABC 123" style="text-transform:uppercase"></div>
        <div class="field"><label>Type</label><select name="type">${vehicleTypeOptions(v.type || 'sedan')}</select></div>
      </div>
      <div class="form-row form-row-3">
        <div class="field"><label>Make</label><input name="make" maxlength="60" value="${esc(v.make)}" placeholder="Toyota"></div>
        <div class="field"><label>Model</label><input name="model" maxlength="60" value="${esc(v.model)}" placeholder="Corolla"></div>
        <div class="field"><label>Year</label><input name="year" type="number" min="1950" max="2100" value="${esc(v.year)}"></div>
      </div>
      <div class="field"><label>Colour</label><input name="color" maxlength="60" value="${esc(v.color)}" placeholder="Silver"></div>`;
  }

  const toMin = (hhmm) => {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return h * 60 + m;
  };

  /** "45 min", "2 h 30 min", "40 h (about 4 working days)" */
  function fmtDuration(min) {
    min = Number(min) || 0;
    if (!min) return '';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    const base = `${h} h${m ? ` ${m} min` : ''}`;
    const day = toMin(state.settings.close_time) - toMin(state.settings.open_time);
    if (day > 0 && min > day) {
      const days = Math.round((min / day) * 2) / 2;
      return `${base} (about ${days} working day${days === 1 ? '' : 's'})`;
    }
    return base;
  }

  /** 6 -> "6 months", 12 -> "1 year", 18 -> "18 months", 36 -> "3 years" */
  function fmtMonths(n) {
    n = Number(n) || 0;
    if (!n) return '';
    if (n % 12 === 0) return `${n / 12} year${n === 12 ? '' : 's'}`;
    return `${n} month${n === 1 ? '' : 's'}`;
  }

  const catBadge = (c) => `<span class="badge cat">${esc(CATEGORY_SHORT[c] || cap(c))}</span>`;

  /** "Ready Thu 13 Nov, 4:00 PM" when a job runs past the day it starts. */
  function readyText(b, { always = false } = {}) {
    if (!b.ready_at || (b.status && !['pending', 'confirmed', 'in_progress'].includes(b.status))) return '';
    const sameDay = b.ready_at.slice(0, 10) === String(b.scheduled_at).slice(0, 10);
    if (sameDay && !always) return '';
    const isToday = b.ready_at.slice(0, 10) === localDate();
    const when = sameDay || isToday ? `${isToday ? 'today ' : ''}${fmtTime(b.ready_at)}` : `${fmtShortDate(b.ready_at)}, ${fmtTime(b.ready_at)}`;
    return `<span class="ready">Ready <b>${esc(when)}</b></span>`;
  }

  const MAINT = { ok: 'On schedule', due_soon: 'Due soon', overdue: 'Overdue' };
  const WARRANTY = { active: 'Active', expiring: 'Expiring soon', expired: 'Expired' };

  /** Cards for ceramic coating / PPF records with warranty and maintenance status. */
  function protectionCards(list, { admin = false } = {}) {
    if (!list || !list.length) return '';
    return `<div class="protections">${list
      .map((p) => {
        const left = p.warranty_until && p.warranty_status !== 'expired' ? ` · ${esc(timeLeft(p.warranty_until))} left` : '';
        return `<div class="protection ${p.warranty_status === 'expired' ? 'expired' : ''}">
          <div class="p-head"><div><div class="p-name">${esc(p.name)}</div><div class="muted" style="font-size:.8rem">Applied ${esc(fmtDate(p.applied_at))}</div></div>${catBadge(p.category)}</div>
          <div class="p-row"><span>Warranty</span><span>${p.warranty_until ? `${esc(fmtMonths(p.warranty_months))} · until ${esc(fmtDate(p.warranty_until))}${left} <span class="badge ${esc(p.warranty_status)}">${esc(WARRANTY[p.warranty_status])}</span>` : '—'}</span></div>
          ${p.maintenance_months ? `<div class="p-row"><span>Maintenance</span><span>every ${esc(fmtMonths(p.maintenance_months))}${p.next_maintenance_at ? ` · next ${esc(fmtDate(p.next_maintenance_at))} <span class="badge ${esc(p.maintenance_status)}">${esc(MAINT[p.maintenance_status])}</span>` : ''}</span></div>` : ''}
          ${p.details ? `<div class="p-details">${esc(p.details)}</div>` : ''}
          ${admin ? `<div class="btn-row no-print"><button class="btn btn-sm" data-edit-protection="${p.id}">Edit</button><button class="btn btn-sm btn-danger" data-del-protection="${p.id}">Delete</button>${p.booking_id ? `<button class="btn btn-sm btn-ghost" data-booking="${p.booking_id}">Job</button>` : ''}</div>` : ''}
        </div>`;
      })
      .join('')}</div>`;
  }

  function timeLeft(dateStr) {
    const days = Math.round((parse(dateStr + ' 12:00') - Date.now()) / 86400000);
    if (days < 0) return 'expired';
    if (days < 45) return `${days} day${days === 1 ? '' : 's'}`;
    const months = Math.round(days / 30.4);
    if (months < 24) return `${months} months`;
    return `${Math.floor(months / 12)} yr${months % 12 ? ` ${months % 12} mo` : 's'}`;
  }

  /** Group services by category in display order: [[category, services[]], ...] */
  function byCategory(services) {
    const groups = new Map(CATEGORY_ORDER.map((c) => [c, []]));
    for (const s of services) {
      if (!groups.has(s.category)) groups.set(s.category, []);
      groups.get(s.category).push(s);
    }
    return [...groups.entries()].filter(([, list]) => list.length);
  }

  window.UI = {
    state,
    api,
    esc,
    money,
    fmtDate,
    fmtShortDate,
    fmtTime,
    fmtDateTime,
    timeAgo,
    localDate,
    STATUS,
    statusBadge,
    payBadge,
    plate,
    stars,
    cap,
    vehicleName,
    toast,
    formData,
    modal,
    confirmDialog,
    router,
    setActiveNav,
    loadSettings,
    logout,
    bindShell,
    barChart,
    hbars,
    priceLines,
    timeline,
    vehicleTypeOptions,
    vehicleFields,
    LOGO,
    CATEGORY,
    CATEGORY_SHORT,
    CATEGORY_ORDER,
    fmtDuration,
    fmtMonths,
    catBadge,
    readyText,
    protectionCards,
    timeLeft,
    byCategory,
  };
})();
