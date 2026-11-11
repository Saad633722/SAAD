(async function () {
  'use strict';
  const { api, esc, money } = UI;
  const go = (user) => (location.href = user.role === 'admin' ? '/admin' : '/app');

  const me = await api('GET', '/api/auth/me').catch(() => ({}));
  if (me.user) return go(me.user);

  const err = document.getElementById('error');
  const showError = (m) => {
    err.textContent = m;
    err.classList.toggle('hidden', !m);
  };

  document.querySelectorAll('[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('login').classList.toggle('hidden', btn.dataset.tab !== 'login');
      document.getElementById('register').classList.toggle('hidden', btn.dataset.tab !== 'register');
      showError('');
    }),
  );

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
