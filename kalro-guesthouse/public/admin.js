'use strict';
const ROLE_HELP = {
  admin: 'Everything, including users and the audit log',
  manager: 'Everything except managing users; can change rates and room status',
  reception: 'Bookings, check-in and check-out, events, amenities, adding charges and taking payments',
  finance: 'Invoices, payments and reports; can view bookings',
};
let USERS_CACHE = [];

PAGES.users = {
  roles: ['admin'],
  async render(host) {
    USERS_CACHE = await get('/users');
    mount(host, html`
      ${pageHead('Users & roles', 'Who can sign in, and what each person is allowed to do.', html`<button class="btn primary" data-act="new-user">${icon('plus', 16)} Add user</button>`)}
      <section class="panel"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>${USERS_CACHE.map((u) => html`<tr>
          <td><b>${u.name}</b></td><td>${u.username}</td><td>${ROLE_NAME[u.role]}<span class="sub">${ROLE_HELP[u.role]}</span></td>
          <td>${u.active ? html`<span class="chip st-paid">Active</span>` : html`<span class="chip st-cancelled">Disabled</span>`}</td>
          <td class="right"><button class="btn sm" data-act="edit-user" data-id="${u.id}">Edit</button></td></tr>`)}</tbody></table></div></section>`);
  },
};
const roleSelect = (cur) => html`<select name="role">${Object.keys(ROLE_NAME).map((r) => html`<option value="${r}" ${cur === r ? 'selected' : ''}>${ROLE_NAME[r]}</option>`)}</select>`;
ACTIONS['new-user'] = () => openModal('Add user', html`
  ${field('Full name', html`<input type="text" name="name" required maxlength="100">`)}
  <div class="row">${field('Username', html`<input type="text" name="username" required maxlength="40" autocapitalize="none" placeholder="letters and numbers">`)}${field('Role', roleSelect('reception'))}</div>
  ${field('Starting password (at least 8 characters)', html`<input type="text" name="password" required minlength="8" autocomplete="off">`)}
  <div class="notice">Tell the person to change this password the first time they sign in.</div>`,
  { submit: 'Add user', onSubmit: async (fd) => { await post('/users', Object.fromEntries(fd.entries())); closeModal(); toast('User added'); refresh(); } });
ACTIONS['edit-user'] = ({ id }) => {
  const u = USERS_CACHE.find((x) => String(x.id) === String(id));
  openModal(`Edit ${u.username}`, html`
    ${field('Full name', html`<input type="text" name="name" required maxlength="100" value="${u.name}">`)}
    <div class="row">${field('Role', roleSelect(u.role))}
      ${field('Account', html`<select name="active"><option value="1" ${u.active ? 'selected' : ''}>Active</option><option value="0" ${u.active ? '' : 'selected'}>Disabled (cannot sign in)</option></select>`)}</div>
    ${field('Reset password (leave empty to keep the current one)', html`<input type="text" name="password" minlength="8" autocomplete="off">`)}`,
    { submit: 'Save changes', onSubmit: async (fd) => {
      const body = { name: fd.get('name'), role: fd.get('role'), active: fd.get('active') === '1' };
      if (fd.get('password')) body.password = fd.get('password');
      await patch(`/users/${u.id}`, body); closeModal(); toast('User updated'); refresh();
    } });
};

const auUI = { q: '' };
PAGES.audit = {
  roles: BOSS,
  async render(host) {
    mount(host, html`${pageHead('Audit log', 'Every sign-in and change, with who did it and when.')}
      <div class="toolbar"><label class="field grow"><span>Search</span><input type="search" id="au-q" value="${auUI.q}" placeholder="Person, action or detail"></label></div>
      <section class="panel"><div class="table-wrap" id="au-table"></div></section>`);
    let t;
    $('#au-q').addEventListener('input', (e) => { auUI.q = e.target.value; clearTimeout(t); t = setTimeout(loadAudit, 250); });
    await loadAudit();
  },
};
async function loadAudit() {
  const rows = await get('/audit' + qs({ q: auUI.q, limit: 300 }));
  mount($('#au-table'), rows.length ? html`<table><thead><tr><th>When</th><th>Person</th><th>Action</th><th>Detail</th></tr></thead>
    <tbody>${rows.map((a) => html`<tr><td class="nowrap">${fdt(a.at)}</td><td>${a.user_name}</td><td><span class="chip cat">${a.action}</span></td><td>${a.detail}</td></tr>`)}</tbody></table>`
    : empty('Nothing found', 'Try a different search.'));
}
