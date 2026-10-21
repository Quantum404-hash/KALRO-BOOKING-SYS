'use strict';
/* ---------------- billing & invoices ---------------- */
const billUI = { q: '', status: '', from: '', to: '' };
const PAY_METHODS = ['ERP payment', 'M-Pesa', 'Cash', 'Bank transfer', 'Cheque', 'Card', 'LPO / Gov. voucher'];
const BILL_ROLES = ['admin', 'manager', 'finance', 'reception'];

PAGES.billing = {
  roles: BILL_ROLES,
  async render(host) {
    mount(host, html`
      ${pageHead('Billing & invoices', 'Room charges, extras and payments for every guest and group.', can(...MONEY) ? html`<button class="btn primary" data-act="new-invoice">${icon('plus', 16)} New invoice</button>` : '')}
      <div class="kpis" id="bill-kpis"></div>
      <div class="toolbar">
        <label class="field grow"><span>Search</span><input type="search" id="bl-q" value="${billUI.q}" placeholder="Invoice number, guest, organisation, booking or payment code"></label>
        <label class="field"><span>Status</span><select id="bl-status">${[['', 'All'], ['due', 'Awaiting payment (guest has left)'], ['running', 'Running (guest in house)'], ['partial', 'Part paid'], ['paid', 'Paid'], ['void', 'Void']].map(([v, l]) => html`<option value="${v}" ${billUI.status === v ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label class="field"><span>Issued from</span><input type="date" id="bl-from" value="${billUI.from}"></label>
        <label class="field"><span>Issued until</span><input type="date" id="bl-to" value="${billUI.to}"></label>
      </div>
      <section class="panel"><div class="table-wrap" id="bill-table"><div class="empty">Loading…</div></div></section>`);
    let t;
    $('#bl-q').addEventListener('input', (e) => { billUI.q = e.target.value; clearTimeout(t); t = setTimeout(loadInvoices, 250); });
    [['bl-status', 'status'], ['bl-from', 'from'], ['bl-to', 'to']].forEach(([id, k]) => $('#' + id).addEventListener('change', (e) => { billUI[k] = e.target.value; loadInvoices(); }));
    await loadInvoices();
  },
};
async function loadInvoices() {
  const box = $('#bill-table'); if (!box) return;
  const rows = await get('/invoices' + qs(billUI));
  const live = rows.filter((r) => r.status !== 'void');
  const due = live.filter((r) => !r.running), run = live.filter((r) => r.running);
  const sumBal = (arr) => arr.reduce((t, r) => t + Math.max(0, r.balance), 0);
  mount($('#bill-kpis'), html`
    <div class="kpi ${sumBal(due) ? 'alert' : ''}"><div class="n" style="font-size:24px">${kes(sumBal(due))}</div><div class="l">Awaiting payment</div><div class="s">${due.filter((r) => r.balance > 0).length === 1 ? '1 guest has' : due.filter((r) => r.balance > 0).length + ' guests have'} left without paying in full</div></div>
    <div class="kpi"><div class="n" style="font-size:24px">${kes(sumBal(run))}</div><div class="l">Running bills</div><div class="s">${run.length === 1 ? '1 guest' : run.length + ' guests'} still in house, pays at checkout</div></div>
    <div class="kpi good"><div class="n" style="font-size:24px">${kes(live.reduce((s, r) => s + r.paid, 0))}</div><div class="l">Collected</div><div class="s">Payments received</div></div>`);
  mount(box, rows.length ? html`<table>
    <thead><tr><th>Invoice</th><th>Bill to</th><th>Issued</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead>
    <tbody>${rows.map((i) => html`<tr class="click" data-act="invoice" data-id="${i.id}">
      <td><b>${i.number}</b><span class="sub">${i.booking_ref || 'Manual invoice'}</span></td>
      <td>${i.bill_to}${i.guest_name && i.guest_name !== i.bill_to ? html`<span class="sub">${i.guest_name}</span>` : ''}</td>
      <td class="nowrap">${fdate(i.issued_on)}</td><td class="num">${num(i.total)}</td><td class="num">${num(i.paid)}</td>
      <td class="num"><b>${num(i.balance)}</b></td><td>${i.stay_status === 'checked_in' && i.status !== 'paid' ? html`<span class="chip st-confirmed">Running bill</span>` : chip(i.status)}</td></tr>`)}</tbody></table>`
    : empty('No invoices found', 'Invoices are created at check-in and settled when the guest leaves.'));
}

ACTIONS.invoice = async ({ id }) => {
  const inv = await get(`/invoices/${id}`);
  const money = can(...MONEY);
  const open = inv.status !== 'void';
  openModal(inv.number, html`
    <div style="display:flex;gap:8px;align-items:center">${inv.stay_status === 'checked_in' && inv.status !== 'paid' ? html`<span class="chip st-confirmed">Running bill</span>` : chip(inv.status)}<span class="muted small">Issued ${fdateY(inv.issued_on)}, due ${fdateY(inv.due_on)}</span></div>
    ${inv.stay_status === 'checked_out' && inv.balance > 0 ? html`<div class="notice">The guest has checked out. Collect ${kes(inv.balance)} and record the payment below.</div>` : ''}
    ${inv.stay_status === 'checked_in' ? html`<div class="notice">The guest is still in house, so this bill can still grow. Payment is normally taken at checkout, but you can record a deposit now.</div>` : ''}
    <dl class="dl"><dt>Bill to</dt><dd>${inv.bill_to}</dd>
      ${inv.booking_ref ? html`<dt>Booking</dt><dd>${inv.booking_ref}, room ${inv.room_number}, ${fdate(inv.check_in)} to ${fdate(inv.check_out)}</dd>` : ''}
      ${inv.guest_name ? html`<dt>Guest</dt><dd>${inv.guest_name}</dd>` : ''}${inv.notes ? html`<dt>Notes</dt><dd>${inv.notes}</dd>` : ''}</dl>
    <div class="table-wrap" style="border:1px solid var(--line);border-radius:8px"><table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${inv.items.map((it) => html`<tr><td>${it.description}</td><td class="num">${it.qty}</td><td class="num">${num(it.unit_price)}</td><td class="num">${num(it.qty * it.unit_price)}</td>
        <td class="right">${open && money && it.kind !== 'room' ? html`<button class="icon-btn" style="color:var(--roof)" data-act="del-item" data-inv="${inv.id}" data-id="${it.id}" title="Remove line" aria-label="Remove line">${icon('x', 15)}</button>` : ''}</td></tr>`)}</tbody></table></div>
    <div class="totals"><div><span>Total</span><span>${kes(inv.total)}</span></div><div><span>Paid</span><span>${kes(inv.paid)}</span></div><div class="big"><span>Balance</span><span style="color:${inv.balance > 0 ? 'var(--roof)' : 'var(--leaf)'}">${kes(inv.balance)}</span></div></div>
    ${inv.payments.length ? html`<div><h3 style="margin-bottom:6px">Payments</h3>${inv.payments.map((p) => html`<div class="slot" style="margin-bottom:6px"><b>${kes(p.amount)}</b><span>${p.method}${p.reference ? `, ${p.reference}` : ''}, ${fdate(p.paid_on)}</span><span class="muted small" style="margin-left:auto">${p.received_by_name || ''}</span></div>`)}</div>` : ''}`,
    { wide: true, footer: html`<footer><button type="button" class="btn" data-act="close-modal">Close</button>
      <button type="button" class="btn" data-act="print-invoice" data-id="${inv.id}">${icon('print', 16)} Print</button>
      ${open && money && inv.paid === 0 ? html`<button type="button" class="btn danger" data-act="void-invoice" data-id="${inv.id}">Void invoice</button>` : ''}
      ${open ? html`<button type="button" class="btn" data-act="add-charge" data-id="${inv.id}">Add charge</button>` : ''}
      ${open && inv.balance > 0 ? html`<button type="button" class="btn primary" data-act="add-payment" data-id="${inv.id}" data-bal="${inv.balance}">Record payment</button>` : ''}</footer>` });
};
ACTIONS['del-item'] = async ({ inv, id }) => { await del(`/invoices/${inv}/items/${id}`); toast('Line removed'); await ACTIONS.invoice({ id: inv }); refresh(); };
ACTIONS['void-invoice'] = ({ id }) => confirmBox('Void this invoice?', 'A void invoice no longer counts as money owed. This cannot be undone.', 'Void invoice',
  async () => { await post(`/invoices/${id}/void`); toast('Invoice voided'); refresh(); }, true);
ACTIONS['add-charge'] = ({ id }) => openModal('Add a charge', html`
  ${field('Description', html`<input type="text" name="description" required maxlength="200" placeholder="For example: Lunch for 12, conference hall">`)}
  <div class="row">${field('Quantity', html`<input type="number" name="qty" min="0.5" step="0.5" value="1" required>`)}
    ${field('Unit price (KES)', html`<input type="number" name="unit_price" min="0" step="50" required>`)}
    ${field('Kind', html`<select name="kind">${[['meal', 'Meals'], ['hall', 'Hall or lounge'], ['laundry', 'Laundry'], ['other', 'Other']].map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>`)}</div>`,
  { submit: 'Add charge', onSubmit: async (fd) => { await post(`/invoices/${id}/items`, Object.fromEntries(fd.entries())); toast('Charge added'); await ACTIONS.invoice({ id }); refresh(); } });
ACTIONS['add-payment'] = ({ id, bal }) => openModal('Record a payment', html`
  <div class="notice">Balance on this invoice: <b>${kes(bal)}</b></div>
  <div class="row">${field('Amount (KES)', html`<input type="number" name="amount" min="1" max="${bal}" value="${bal}" required>`)}
    ${field('Method', html`<select name="method">${PAY_METHODS.map((m) => html`<option>${m}</option>`)}</select>`)}
    ${field('Paid on', html`<input type="date" name="paid_on" value="${todayISO()}" max="${todayISO()}">`)}</div>
  <label class="field"><span id="ref-label">ERP payment code (copy it exactly from the ERP receipt)</span><input type="text" name="reference" maxlength="60" autocomplete="off" required></label>`,
  { submit: 'Save payment',
    onMount: (frm) => {
      const sel = frm.elements.method, ref = frm.elements.reference, lab = $('#ref-label', frm);
      const sync = () => {
        const m = sel.value;
        lab.textContent = m === 'ERP payment' ? 'ERP payment code (copy it exactly from the ERP receipt)' : m === 'Cash' ? 'Receipt number (optional)' : m === 'M-Pesa' ? 'M-Pesa code' : m === 'LPO / Gov. voucher' ? 'LPO or voucher number' : 'Reference';
        ref.required = m !== 'Cash';
      };
      sel.addEventListener('change', sync); sync();
    },
    onSubmit: async (fd) => { await post(`/invoices/${id}/payments`, Object.fromEntries(fd.entries())); toast('Payment recorded'); await ACTIONS.invoice({ id }); refresh(); } });

const lineRow = () => html`<tr><td><input type="text" name="d" placeholder="Description" maxlength="200"></td><td style="width:80px"><input type="number" name="q" value="1" min="0.5" step="0.5"></td>
  <td style="width:130px"><input type="number" name="p" min="0" step="50" placeholder="Unit price"></td><td style="width:40px"><button type="button" class="icon-btn" data-act="del-line" aria-label="Remove line">${icon('x', 15)}</button></td></tr>`;
ACTIONS['new-invoice'] = () => openModal('New invoice', html`
  ${field('Bill to', html`<input type="text" name="bill_to" required maxlength="200" placeholder="Organisation or person being billed">`)}
  <div class="table-wrap lines"><table><tbody id="lines">${lineRow()}${lineRow()}</tbody></table></div>
  <button type="button" class="btn sm" data-act="add-line" style="justify-self:start">${icon('plus', 14)} Add another line</button>
  ${field('Notes', html`<input type="text" name="notes" maxlength="300">`)}`,
  { wide: true, submit: 'Create invoice', onSubmit: async (fd) => {
    const d = fd.getAll('d'), q = fd.getAll('q'), p = fd.getAll('p');
    const items = d.map((desc, i) => ({ description: desc, qty: q[i], unit_price: p[i] })).filter((x) => x.description.trim());
    const inv = await post('/invoices', { bill_to: fd.get('bill_to'), notes: fd.get('notes'), items });
    toast(`Invoice ${inv.number} created`); await ACTIONS.invoice({ id: inv.id }); refresh();
  } });
ACTIONS['add-line'] = () => $('#lines').insertAdjacentHTML('beforeend', lineRow().s);
ACTIONS['del-line'] = (d, el) => { const tb = $('#lines'); if (tb.children.length > 1) el.closest('tr').remove(); };

ACTIONS['print-invoice'] = async ({ id }) => {
  const inv = await get(`/invoices/${id}`);
  mount($('#print-area'), html`
    <div class="inv-head"><div><h1>Invoice ${inv.number}</h1><div>Issued ${fdateY(inv.issued_on)}, due ${fdateY(inv.due_on)}</div></div>
      <div style="text-align:right"><b>KALRO Dairy Research Institute</b><br>Guesthouse<br>P. O. Box 25-20117, Naivasha</div></div>
    <div class="flag inv-bar"></div>
    <p><b>Bill to:</b> ${inv.bill_to}${inv.guest_name ? html`<br>Guest: ${inv.guest_name}` : ''}${inv.booking_ref ? html`<br>Booking ${inv.booking_ref}, room ${inv.room_number}, ${fdate(inv.check_in)} to ${fdate(inv.check_out)}` : ''}</p>
    <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price (KES)</th><th class="num">Amount (KES)</th></tr></thead>
      <tbody>${inv.items.map((it) => html`<tr><td>${it.description}</td><td class="num">${it.qty}</td><td class="num">${num(it.unit_price)}</td><td class="num">${num(it.qty * it.unit_price)}</td></tr>`)}</tbody></table>
    <div class="totals" style="margin-top:14px"><div><span>Total</span><span>${kes(inv.total)}</span></div><div><span>Paid</span><span>${kes(inv.paid)}</span></div><div class="big"><span>Balance due</span><span>${kes(inv.balance)}</span></div></div>
    ${inv.payments.length ? html`<h3 style="margin-top:16px">Payments received</h3>${inv.payments.map((p) => html`<div>${fdateY(p.paid_on)}: ${kes(p.amount)} by ${p.method}${p.reference ? `, ref ${p.reference}` : ''}</div>`)}` : ''}
    <p style="margin-top:20px"><b>How to pay:</b> pay through the KALRO ERP quoting invoice number <b>${inv.number}</b>, then give the ERP payment code to the guesthouse office.</p><p style="margin-top:12px">Thank you for staying with us.</p>`);
  window.print();
};

/* ---------------- reports ---------------- */
const repUI = { from: addDays(todayISO(), -29), to: todayISO() };
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
function chartAxis(W, H, pl, pr, pt, pb, max, fmt, ticks = 4) {
  const ih = H - pt - pb; let s = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i, y = pt + ih - (v / max) * ih;
    s += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#e3ebe6"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  return s;
}
function xLabels(points, W, pl, pr, H, pb, xf) {
  const n = points.length, k = Math.max(1, Math.ceil(n / 8)); let s = '';
  points.forEach((p, i) => { if (i % k === 0) s += `<text x="${xf(i)}" y="${H - pb + 17}" text-anchor="middle">${esc(p.label)}</text>`; });
  return s;
}
function lineChart(points, o = {}) {
  const W = 760, H = 230, pl = 44, pr = 12, pt = 12, pb = 28, max = o.max || 100, n = points.length;
  const iw = W - pl - pr, ih = H - pt - pb;
  const x = (i) => (n === 1 ? pl + iw / 2 : pl + (i * iw) / (n - 1)), y = (v) => pt + ih - (Math.min(v, max) / max) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${pt + ih}L${x(0).toFixed(1)},${pt + ih}Z`;
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || 'Chart')}">
    ${chartAxis(W, H, pl, pr, pt, pb, max, (v) => v + '%')}<path d="${area}" fill="var(--leaf)" opacity=".13"/><path d="${line}" fill="none" stroke="var(--leaf)" stroke-width="2.4" stroke-linejoin="round"/>
    ${points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${n > 45 ? 0 : 3.2}" fill="var(--leaf)"><title>${esc(p.label)}: ${esc(p.tip)}</title></circle>`).join('')}
    ${xLabels(points, W, pl, pr, H, pb, x)}</svg>`);
}
function barChart(points, o = {}) {
  const W = 760, H = 230, pl = 52, pr = 12, pt = 12, pb = 28, n = points.length;
  const max = niceMax(Math.max(...points.map((p) => p.v), 1)), iw = W - pl - pr, ih = H - pt - pb, bw = Math.max(2, (iw / n) * 0.68);
  const x = (i) => pl + (i + 0.5) * (iw / n);
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || 'Chart')}">
    ${chartAxis(W, H, pl, pr, pt, pb, max, (v) => (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)))}
    ${points.map((p, i) => { const h = (p.v / max) * ih; return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(pt + ih - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" rx="2" fill="var(--roof)" opacity=".85"><title>${esc(p.label)}: ${esc(p.tip)}</title></rect>`; }).join('')}
    ${xLabels(points, W, pl, pr, H, pb, x)}</svg>`);
}
const hbars = (rows, valueKey, fmt) => { const m = Math.max(...rows.map((r) => r[valueKey]), 1); return rows.map((r) => html`<div class="hbar"><span>${r.name}</span><div class="t"><i style="width:${(r[valueKey] / m) * 100}%"></i></div><span>${fmt(r[valueKey])}</span></div>`); };

PAGES.reports = {
  roles: MONEY,
  async render(host) {
    const r = await get('/reports/summary' + qs(repUI));
    const T = r.totals, lab = (iso) => D(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const pay = new Map(r.payments.map((p) => [p.date, p.collected]));
    const preset = (label, from, to) => html`<button type="button" class="${repUI.from === from && repUI.to === to ? 'on' : ''}" data-act="rep-preset" data-from="${from}" data-to="${to}">${label}</button>`;
    const t = todayISO();
    mount(host, html`
      ${pageHead('Reports', `${fdateY(r.from)} to ${fdateY(r.to)}`, html`<div style="display:flex;gap:8px;flex-wrap:wrap">
        ${['bookings', 'invoices', 'payments'].map((k) => html`<button class="btn sm" data-act="export" data-type="${k}">Export ${k} (CSV)</button>`)}</div>`)}
      <div class="toolbar">
        <div class="seg">${preset('Last 7 days', addDays(t, -6), t)}${preset('Last 30 days', addDays(t, -29), t)}${preset('Last 90 days', addDays(t, -89), t)}${preset('This month', t.slice(0, 8) + '01', t)}${preset('This year', t.slice(0, 4) + '-01-01', t)}</div>
        <label class="field"><span>From</span><input type="date" id="rp-from" value="${repUI.from}"></label>
        <label class="field"><span>To</span><input type="date" id="rp-to" value="${repUI.to}"></label>
        <button class="btn" data-act="rep-apply">Show report</button>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="n">${T.occupancyPct}%</div><div class="l">Average occupancy</div><div class="s">${num(T.roomNights)} room nights</div></div>
        <div class="kpi"><div class="n" style="font-size:26px">${kes(T.adr)}</div><div class="l">Average room rate</div><div class="s">Per occupied night</div></div>
        <div class="kpi"><div class="n" style="font-size:26px">${kes(T.roomRevenue)}</div><div class="l">Room revenue</div><div class="s">${T.bookings} bookings</div></div>
        <div class="kpi good"><div class="n" style="font-size:26px">${kes(T.collected)}</div><div class="l">Collected</div><div class="s">Billed ${kes(T.invoiced)}</div></div>
        <div class="kpi ${T.outstanding ? 'alert' : ''}"><div class="n" style="font-size:26px">${kes(T.outstanding)}</div><div class="l">Outstanding now</div><div class="s">All unpaid invoices</div></div>
      </div>
      <div class="stack">
        <section class="panel"><header><h2>Occupancy by day</h2><span class="muted small">Share of all rooms in use</span></header><div class="body">
          ${lineChart(r.days.map((d) => ({ label: lab(d.date), v: d.occupancy, tip: `${d.occupied} of ${d.available} rooms (${d.occupancy}%)` })), { label: 'Occupancy by day' })}</div></section>
        <section class="panel"><header><h2>Payments collected by day</h2><span class="muted small">KES</span></header><div class="body">
          ${barChart(r.days.map((d) => ({ label: lab(d.date), v: pay.get(d.date) || 0, tip: kes(pay.get(d.date) || 0) })), { label: 'Payments by day' })}</div></section>
        <div class="row" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start">
          <section class="panel"><header><h3>Nights by booking type</h3></header><div class="body">${r.byCategory.length ? hbars(r.byCategory, 'nights', (v) => v + ' nights') : empty('No stays in this period', '')}</div></section>
          <section class="panel"><header><h3>Nights by room type</h3></header><div class="body">${r.byType.length ? hbars(r.byType, 'nights', (v) => v + ' nights') : empty('No stays in this period', '')}</div></section>
          <section class="panel"><header><h3>Top organisations</h3></header><div class="body">${r.topOrganisations.length ? hbars(r.topOrganisations, 'nights', (v) => v + ' nights') : empty('No stays in this period', '')}</div></section>
          <section class="panel"><header><h3>Payments by method</h3></header><div class="body">${r.byMethod.length ? hbars(r.byMethod.map((m) => ({ name: m.method, amount: m.amount })), 'amount', kes) : empty('No payments in this period', '')}</div></section>
        </div>
      </div>`);
  },
};
ACTIONS['rep-preset'] = ({ from, to }) => { repUI.from = from; repUI.to = to; refresh(); };
ACTIONS['rep-apply'] = () => { const f = $('#rp-from').value, t = $('#rp-to').value; if (!f || !t || t < f) { toast('Choose a start date and a later end date', true); return; } repUI.from = f; repUI.to = t; refresh(); };
ACTIONS.export = ({ type }) => download('/reports/export' + qs({ type, from: repUI.from, to: repUI.to }), `kalro-${type}.csv`);
