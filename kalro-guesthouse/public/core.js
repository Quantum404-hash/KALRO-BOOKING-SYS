'use strict';
/* ---------- tiny helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const rend = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(rend).join('') : v == null || v === false ? '' : esc(v));
const html = (strs, ...vals) => new Raw(strs.reduce((o, s, i) => o + s + (i < vals.length ? rend(vals[i]) : ''), ''));
const mount = (el, tpl) => { el.innerHTML = rend(tpl); return el; };

const kes = (n) => 'KES ' + Math.round(Number(n || 0)).toLocaleString('en-KE');
const num = (n) => Number(n || 0).toLocaleString('en-KE');
const D = (iso) => new Date(iso + 'T00:00:00');
const fdate = (iso) => (iso ? D(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const fdateY = (iso) => (iso ? D(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fdt = (s) => { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + (s.length <= 19 && !s.includes('Z') ? 'Z' : '')); return isNaN(d) ? s : d.toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nightsBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const initials = (n) => String(n || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter((w) => !/^(dr|prof|mr|mrs|ms)\.?$/i.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const cleanName = (n) => String(n || '');

const LABEL = { pending: 'Pending', confirmed: 'Confirmed', checked_in: 'Checked in', checked_out: 'Checked out', cancelled: 'Cancelled', no_show: 'No-show',
  paid: 'Paid', partial: 'Part paid', unpaid: 'Unpaid', void: 'Void', overdue: 'Overdue' };
const chip = (st) => html`<span class="chip st-${st}">${LABEL[st] || st}</span>`;

const ICON = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  bed: '<path d="M3 18V6M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11h.01"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  mic: '<path d="M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6"/>',
  cup: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8zM17 9h2a2 2 0 0 1 0 5h-2M7 3v2M11 3v2M15 3v2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6 6 0 0 1 3 6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  out: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
};
const icon = (n, size = 18) => raw(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`);

const BRAND_IMG = `<img src="/logo.png" alt="KALRO" onerror="this.outerHTML='<div class=&quot;mono&quot;>K</div>'">`;

/* ---------- state + api ---------- */
const S = { user: null, token: null, page: null };
try { S.token = localStorage.getItem('kalro_token'); } catch { /* storage may be blocked */ }

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401 && path !== '/auth/login') { signOut(true); throw new Error('Please sign in again.'); }
  if (!res.ok) { const e = new Error((data && data.error) || 'Request failed'); e.status = res.status; e.data = data; throw e; }
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b || {});
const patch = (p, b) => api('PATCH', p, b || {});
const del = (p) => api('DELETE', p);
const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); }); const s = p.toString(); return s ? '?' + s : ''; };

async function download(path, fallbackName) {
  try {
    const res = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) throw new Error((await res.json()).error || 'Download failed');
    const cd = res.headers.get('content-disposition') || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, true); }
}

function toast(msg, isErr) {
  const el = Object.assign(document.createElement('div'), { className: 'toast' + (isErr ? ' err' : ''), textContent: msg });
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 6500 : 3500);
}

/* ---------- modal ---------- */
let CURRENT_MODAL = null;
function openModal(title, bodyTpl, o = {}) {
  closeModal();
  const footer = o.footer === false ? '' : (o.footer || html`<footer>
      <button type="button" class="btn" data-act="close-modal">${o.onSubmit ? 'Cancel' : 'Close'}</button>
      ${o.onSubmit ? html`<button type="submit" class="btn ${o.danger ? 'red' : 'primary'}">${o.submit || 'Save'}</button>` : ''}
    </footer>`);
  $('#modal-root').innerHTML = html`<div class="overlay" data-overlay>
    <div class="modal ${o.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <header><h2>${title}</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="Close">${icon('x')}</button></header>
      <form class="mform" novalidate>
        <div class="mbody">${bodyTpl}<div class="notice err hidden" data-err role="alert"></div></div>
        ${footer}
      </form>
    </div></div>`.s;
  const form = $('#modal-root form');
  CURRENT_MODAL = { o, form };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!o.onSubmit) return closeModal();
    const btn = $('button[type=submit]', form);
    const err = $('[data-err]', form);
    err.classList.add('hidden');
    if (btn) btn.disabled = true;
    try { await o.onSubmit(new FormData(form), form); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); }
    finally { if (btn) btn.disabled = false; }
  });
  if (o.onMount) o.onMount(form);
  const first = $('input:not([type=hidden]):not([disabled]), select, textarea', form);
  if (first && !o.noFocus) first.focus();
  return form;
}
function closeModal() { $('#modal-root').innerHTML = ''; CURRENT_MODAL = null; }
function confirmBox(title, msgTpl, okLabel, onOk, danger) {
  openModal(title, html`<p style="margin:0">${msgTpl}</p>`, { submit: okLabel, danger, onSubmit: async () => { await onOk(); closeModal(); } });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && CURRENT_MODAL) closeModal(); });
document.addEventListener('mousedown', (e) => { if (e.target.matches('[data-overlay]')) closeModal(); });

/* ---------- action delegation ---------- */
const ACTIONS = {};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACTIONS[el.dataset.act]) return;
  e.preventDefault();
  Promise.resolve(ACTIONS[el.dataset.act](el.dataset, el, e)).catch((ex) => toast(ex.message, true));
});
ACTIONS['close-modal'] = () => closeModal();

/* ---------- shell + router ---------- */
const PAGES = {};
const NAV = [
  { group: 'Operations' },
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'rooms', label: 'Rooms & inventory', icon: 'bed' },
  { id: 'bookings', label: 'Bookings', icon: 'cal' },
  { id: 'events', label: 'Events & seminars', icon: 'mic' },
  { id: 'amenities', label: 'Lounge & amenities', icon: 'cup' },
  { group: 'Finance' },
  { id: 'billing', label: 'Billing & invoices', icon: 'receipt' },
  { id: 'reports', label: 'Reports', icon: 'chart' },
  { group: 'System' },
  { id: 'users', label: 'Users & roles', icon: 'users' },
  { id: 'audit', label: 'Audit log', icon: 'shield' },
];
const ROLE_NAME = { admin: 'Administrator', manager: 'Manager', reception: 'Front desk', finance: 'Finance' };
const can = (...roles) => S.user && roles.includes(S.user.role);

function renderLogin(msg) {
  mount($('#app'), html`<div class="login">
    <section class="login-hero">
      <div class="flag"></div>
      <div class="brand" style="margin-bottom:22px">${raw(BRAND_IMG)}<div><b>KALRO</b><span>Dairy Research Institute, Naivasha</span></div></div>
      <h1>Guesthouse and conference lodge</h1>
      <p>Rooms, bookings, seminars and billing for the guest rooms and the Resource Centre, in one place.</p>
    </section>
    <section class="login-form">
      <h2>Sign in</h2>
      <p class="muted" style="margin:0">Use the account the administrator gave you.</p>
      <form id="login-form" novalidate>
        <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required autofocus></label>
        <label class="field"><span>Password</span>${pwInput('password', 'current-password')}</label>
        <a href="#" data-act="forgot-pw" class="small" style="justify-self:start">Forgot your password?</a>
        <div class="notice err ${msg ? '' : 'hidden'}" id="login-err" role="alert">${msg || ''}</div>
        <button class="btn primary" type="submit" style="padding:11px">Sign in</button>
      </form>
    </section></div>`);
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), btn = $('button', e.target), err = $('#login-err');
    btn.disabled = true; err.classList.add('hidden');
    try {
      const r = await post('/auth/login', { username: fd.get('username'), password: fd.get('password') });
      S.token = r.token; S.user = r.user;
      try { localStorage.setItem('kalro_token', r.token); } catch { /* ignore */ }
      location.hash = '#/dashboard';
      startApp();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
  });
}

function signOut(expired) {
  S.token = null; S.user = null;
  try { localStorage.removeItem('kalro_token'); } catch { /* ignore */ }
  closeModal();
  renderLogin(expired ? 'Your session ended. Please sign in again.' : '');
}

function startApp() {
  const items = NAV.filter((n, i) => {
    if (n.group) { // keep a group only if some item after it (before next group) is allowed
      for (let j = i + 1; j < NAV.length && !NAV[j].group; j++) if (PAGES[NAV[j].id].roles.includes(S.user.role)) return true;
      return false;
    }
    return PAGES[n.id].roles.includes(S.user.role);
  });
  mount($('#app'), html`<div class="shell">
    <aside class="side" id="side">
      <div class="brand">${raw(BRAND_IMG)}<div><b>KALRO</b><span>Guesthouse, Naivasha</span></div></div>
      <nav>${items.map((n) => n.group ? html`<div class="group">${n.group}</div>`
        : html`<a class="nav" href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${n.label}</span></a>`)}</nav>
      <div class="me">
        <div class="avatar">${initials(S.user.name)}</div>
        <div class="who"><b>${S.user.name}</b><span>${ROLE_NAME[S.user.role]}</span></div>
        <button class="icon-btn" data-act="my-password" title="Change password" aria-label="Change password">${icon('key')}</button>
        <button class="icon-btn" data-act="sign-out" title="Sign out" aria-label="Sign out">${icon('out')}</button>
      </div>
    </aside>
    <div class="main">
      <div class="flag"></div>
      <div class="topbar">
        <button class="icon-btn burger" data-act="toggle-side" aria-label="Menu">${icon('menu', 22)}</button>
        <span class="spacer"></span>
        <span class="muted small" id="topdate"></span>
      </div>
      <main class="page" id="page"></main>
    </div></div>`);
  $('#topdate').textContent = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  route();
}

ACTIONS['forgot-pw'] = () => openModal('Forgot your password?', html`
  <p style="margin:0">Passwords can't be recovered, but an administrator can set a new one for you in a minute.</p>
  <ol style="margin:0;padding-left:20px;display:grid;gap:6px"><li>Ask the system administrator to open <b>Users &amp; roles</b> and choose <b>Edit</b> next to your name.</li>
    <li>They type a new temporary password under <b>Reset password</b>.</li><li>Sign in with it, then change it with the key icon at the bottom left.</li></ol>
  <div class="notice">If you are the administrator and locked out, see <b>README.md</b>, section "Forgot a password".</div>`, { footer: html`<footer><button type="button" class="btn primary" data-act="close-modal">Close</button></footer>` });
ACTIONS['sign-out'] = () => signOut(false);
ACTIONS['toggle-side'] = () => $('#side').classList.toggle('open');
ACTIONS['my-password'] = () => openModal('Change your password', html`
  <label class="field"><span>Current password</span>${pwInput('current', 'current-password')}</label>
  <label class="field"><span>New password (at least 8 characters)</span>${pwInput('new', 'new-password')}</label>`,
  { submit: 'Change password', onSubmit: async (fd) => { await post('/auth/password', { current: fd.get('current'), new: fd.get('new') }); closeModal(); toast('Password changed'); } });

async function route() {
  if (!S.user) return;
  const name = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
  const page = PAGES[name];
  if (!page || !page.roles.includes(S.user.role)) { location.hash = '#/dashboard'; return; }
  S.page = name;
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
  $('#side').classList.remove('open');
  const host = $('#page');
  host.innerHTML = '<div class="empty">Loading…</div>';
  try { await page.render(host); window.scrollTo(0, 0); }
  catch (e) { mount(host, html`<div class="notice err">${e.message}</div>`); }
}
const refresh = async () => {
  const host = $('#page'); if (!host || !S.page) return;
  const y = window.scrollY;
  try { await PAGES[S.page].render(host); window.scrollTo(0, y); } catch (e) { toast(e.message, true); }
};
window.addEventListener('hashchange', route);

async function boot() {
  if (!S.token) return renderLogin();
  try { S.user = (await get('/auth/me')).user; startApp(); } catch { renderLogin(); }
}
window.addEventListener('DOMContentLoaded', boot);

/* shared UI bits */
const pageHead = (title, sub, actions) => html`<div class="page-head"><div class="grow"><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions || ''}</div>`;
const empty = (title, text) => html`<div class="empty"><b>${title}</b>${text}</div>`;
const pwInput = (name, auto) => html`<span class="pw"><input type="password" name="${name}" autocomplete="${auto}" required><button type="button" class="pw-toggle" data-act="toggle-pw" aria-label="Show password" aria-pressed="false">Show</button></span>`;
ACTIONS['toggle-pw'] = (d, btn) => {
  const input = btn.previousElementSibling, show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
  btn.setAttribute('aria-pressed', String(show)); btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
};
const field = (label, input) => html`<label class="field"><span>${label}</span>${input}</label>`;
