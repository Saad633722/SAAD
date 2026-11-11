(async function () {
  'use strict';
  const { api, esc, money } = UI;
  const go = (user) => (location.href = user.role === 'customer' ? '/app' : '/admin');

  const me = await api('GET', '/api/auth/me').catch(() => ({}));
  if (me.user) return go(me.user);

  const err = document.getElementById('error');
  const showError = (m) => {
    err.textContent = m;
    err.classList.toggle('hidden', !m);
  };

  const showTab = (tab) => {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    for (const id of ['login', 'register', 'pin']) document.getElementById(id).classList.toggle('hidden', id !== tab);
    showError('');
  };
  document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
  // The shop tablet opens /staff: straight to the PIN pad.
  if (location.pathname.startsWith('/staff') || location.hash === '#pin') {
    // shop-tablet mode: just the logo and the PIN pad
    document.body.classList.add('staff-mode');
    document.querySelector('.auth .card').insertAdjacentHTML(
      'afterbegin',
      `<div class="brand staff-brand"><span class="logo">${UI.LOGO}</span><span class="brand-text"><b data-business-name>Mr.Clean Car Detailing</b><small data-tagline>&amp; PPF Ceramic Coating</small></span></div>`,
    );
    showTab('pin');
  }

  // ---- PIN pad (also works with the keyboard)
  let pin = '';
  let busy = false;
  const dots = document.querySelectorAll('.pin-dots span');
  const render = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
  const press = async (key) => {
    if (busy) return;
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (/^\d$/.test(key) && pin.length < 4) pin += key;
    render();
    if (pin.length === 4) {
      busy = true;
      try {
        const { user } = await api('POST', '/api/auth/pin', { pin });
        go(user);
      } catch (ex) {
        showError(ex.message);
        document.querySelector('.pin-dots').classList.add('shake');
        setTimeout(() => document.querySelector('.pin-dots').classList.remove('shake'), 400);
        pin = '';
        render();
      } finally {
        busy = false;
      }
    }
  };
  document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => press(b.dataset.key)));
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('pin').classList.contains('hidden')) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Escape') press('clear');
  });

  for (const id of ['login', 'register']) {
    const form = document.getElementById(id);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const { user } = await api('POST', `/api/auth/${id}`, UI.formData(form));
        go(user);
      } catch (ex) {
        showError(ex.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  try {
    const [{ settings }, { services }] = await Promise.all([UI.loadSettings(), api('GET', '/api/services')]);
    document.title = `${settings.business_name} — Sign in`;
    const packages = services.filter((s) => s.kind === 'package');
    document.getElementById('services').innerHTML = UI.byCategory(packages)
      .map(([cat, list]) => {
        const from = Math.min(...list.map((s) => s.price));
        const warranty = Math.max(0, ...list.map((s) => s.warranty_months || 0));
        const names = list.map((s) => s.name.replace(/^(Ceramic Coating|PPF) – /, '')).join(' · ');
        return `<div><b><span>${esc(UI.CATEGORY[cat] || cat)}</span><span>from ${esc(money(from))}</span></b>
          <small>${esc(names)}${warranty ? ` · warranty up to ${esc(UI.fmtMonths(warranty))}` : ''}</small></div>`;
      })
      .join('');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    document.getElementById('hours').textContent =
      `Open ${settings.open_days.map((d) => days[d]).join(', ')} · ${settings.open_time}–${settings.close_time}` +
      (settings.address ? ` · ${settings.address}` : '') +
      (settings.phone ? ` · ${settings.phone}` : '');
  } catch {
    /* landing info is optional */
  }
})();
