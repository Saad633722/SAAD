/* Shared helpers for both panels. Exposes a global `UI` object. */
(function () {
  'use strict';

  const state = { settings: { currency: '$' }, vehicleTypes: [], paymentMethods: [] };

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
  const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '');
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
  };
})();
