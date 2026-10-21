const B = 'http://localhost:3111/api';
const call = async (m, p, t, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, j: await r.json() };
};
const tok = async (u, p) => (await call('POST', '/auth/login', null, { username: u, password: p })).j.token;
const fin = await tok('finance', 'finance123'), rec = await tok('reception', 'reception123');
const ok = (n, c, x = '') => console.log(c ? 'PASS' : 'FAIL', n, c ? '' : x);

const d = (await call('GET', '/dashboard', fin)).j.money;
console.log('money', d);
ok('running bills counted separately', d.runningBills > 0, JSON.stringify(d));
const due = (await call('GET', '/invoices?status=due', fin)).j;
console.log('due', due.map((i) => [i.number, i.balance, i.days_since_checkout]));
ok('due list only has guests who left, with a balance', due.every((i) => !i.running && i.balance > 0));
const run = (await call('GET', '/invoices?status=running', fin)).j;
ok('running list only has in-house guests', run.length > 0 && run.every((i) => i.running));

const b = (await call('GET', '/bookings?q=Njoroge', rec)).j[0];
const co = await call('POST', `/bookings/${b.id}/checkout`, rec);
ok('checkout keeps the unpaid balance', co.s === 200 && co.j.invoice.balance > 0, JSON.stringify(co.j.invoice));
const due2 = (await call('GET', '/invoices?status=due', fin)).j;
ok('guest now shows as awaiting payment (left today)', due2.some((i) => i.id === co.j.invoice_id && i.days_since_checkout === 0));
const d2 = (await call('GET', '/dashboard', fin)).j.money;
ok('outstanding now includes that guest', d2.outstanding > d.outstanding - 1 && d2.runningBills < d.runningBills, JSON.stringify([d.outstanding, d2.outstanding, d.runningBills, d2.runningBills]));
const pay = await call('POST', `/invoices/${co.j.invoice_id}/payments`, fin, { amount: co.j.invoice.balance, method: 'LPO / Gov. voucher', reference: 'LPO-123' });
ok('paid in full after the stay', pay.s === 200 && pay.j.status === 'paid', JSON.stringify(pay.j).slice(0, 150));
const due3 = (await call('GET', '/invoices?status=due', fin)).j;
ok('and leaves the awaiting-payment list', !due3.some((i) => i.id === co.j.invoice_id));
