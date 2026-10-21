const B = 'http://localhost:3111/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
async function call(method, path, token, body) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: r.status, j };
}
const login = async (u, p) => (await call('POST', '/auth/login', null, { username: u, password: p })).j.token;
const admin = await login('admin', 'admin123'), rec = await login('reception', 'reception123'), fin = await login('finance', 'finance123');
const T = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const add = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

ok('no token → 401', (await call('GET', '/dashboard')).s === 401);
ok('bad password → 401', (await call('POST', '/auth/login', null, { username: 'admin', password: 'x' })).s === 401);
ok('finance cannot list users → 403', (await call('GET', '/users', fin)).s === 403);
ok('reception cannot see reports → 403', (await call('GET', '/reports/summary', rec)).s === 403);

const d = (await call('GET', '/dashboard', rec)).j;
console.log('dashboard stats', JSON.stringify(d.stats), 'inHouse', JSON.stringify(d.inHouse), 'arrivals', d.arrivals.length, 'money?', !!d.money);
ok('dashboard has 25 rooms, 1 out of service', d.stats.rooms === 25 && d.stats.outOfService === 1);
ok('reception sees no money block', !d.money);
ok('in-house total pax is 6+5+14+2+3=30', d.inHouse.total === 30, d.inHouse.total);

const rooms = (await call('GET', '/rooms', rec)).j.rooms;
const r = (n) => rooms.find((x) => x.number === n);

// double booking: room 112 is booked today→+3
let x = await call('POST', '/bookings', rec, { guest: { name: 'Test Guest' }, room_id: r('112').id, check_in: add(T, 1), check_out: add(T, 2), pax: 1 });
ok('overlapping booking rejected 409', x.s === 409, JSON.stringify(x.j));
// adjacent booking allowed (back-to-back)
x = await call('POST', '/bookings', rec, { guest: { name: 'Back To Back', organisation: 'Test Org' }, room_id: r('112').id, check_in: add(T, 3), check_out: add(T, 5), pax: 2, category: 'Research' });
ok('back-to-back booking allowed', x.s === 200 && x.j.ref, JSON.stringify(x.j));
const bb = x.j;
// maintenance room
x = await call('POST', '/bookings', rec, { guest: { name: 'Maint' }, room_id: r('106').id, check_in: add(T, 1), check_out: add(T, 2) });
ok('booking a maintenance room rejected', x.s === 400, JSON.stringify(x.j));
// past date
x = await call('POST', '/bookings', rec, { guest: { name: 'Past' }, room_id: r('107').id, check_in: add(T, -2), check_out: add(T, 1) });
ok('past check-in rejected for reception', x.s === 400, JSON.stringify(x.j));
// bad dates
x = await call('POST', '/bookings', rec, { guest: { name: 'Bad' }, room_id: r('107').id, check_in: add(T, 2), check_out: add(T, 2) });
ok('zero-night booking rejected', x.s === 400);
// rate override by reception
x = await call('POST', '/bookings', rec, { guest: { name: 'Disc' }, room_id: r('107').id, check_in: add(T, 1), check_out: add(T, 2), rate: 100 });
ok('reception rate override → 403', x.s === 403);

// check-in flow: Dr Osei (401) arrives today
const bks = (await call('GET', '/bookings?q=Osei', rec)).j;
const osei = bks[0];
let ci = await call('POST', `/bookings/${osei.id}/checkin`, rec);
ok('check-in works and creates invoice', ci.s === 200 && ci.j.status === 'checked_in' && ci.j.invoice_id, JSON.stringify(ci.j).slice(0, 200));
ci = await call('POST', `/bookings/${osei.id}/checkin`, rec);
ok('double check-in rejected', ci.s === 400);
// check in into occupied room: create another booking for 103 (occupied by Kipchoge) today? 103 is checked-in until +1, so book from +1
// invoice + payment
const inv = (await call('GET', `/invoices/${ci.j.invoice_id || (await call('GET', `/bookings/${osei.id}`, rec)).j.invoice_id}`, rec)).j;
ok('invoice has room line 2 nights × 12000 = 24000', inv.total === 24000, inv.total);
let p = await call('POST', `/invoices/${inv.id}/payments`, fin, { amount: 30000, method: 'Cash' });
ok('overpayment rejected', p.s === 400, JSON.stringify(p.j));
p = await call('POST', `/invoices/${inv.id}/payments`, fin, { amount: 10000, method: 'M-Pesa', reference: 'TEST1' });
ok('partial payment → partial', p.s === 200 && p.j.status === 'partial' && p.j.balance === 14000, JSON.stringify(p.j).slice(0, 200));
let it = await call('POST', `/invoices/${inv.id}/items`, rec, { description: 'Laundry', qty: 4, unit_price: 300, kind: 'laundry' });
ok('reception can add charge → total 25200', it.s === 200 && it.j.total === 25200, JSON.stringify(it.j).slice(0, 150));
ok('reception cannot void invoice → 403', (await call('POST', `/invoices/${inv.id}/void`, rec)).s === 403);
ok('cannot void invoice with payments', (await call('POST', `/invoices/${inv.id}/void`, fin)).s === 400);

// early checkout adjusts nights: Osei 2 nights → checkout today = min 1 night
const co = await call('POST', `/bookings/${osei.id}/checkout`, rec);
ok('early checkout → 1 night, status checked_out', co.s === 200 && co.j.status === 'checked_out' && co.j.check_out === add(T, 1), JSON.stringify(co.j).slice(0, 200));
const inv2 = (await call('GET', `/invoices/${inv.id}`, rec)).j;
ok('invoice room line adjusted to 1 night (12000 + 1200 laundry)', inv2.total === 13200, inv2.total);

// room now free tonight for same-day rebooking after checkout
x = await call('POST', '/bookings', rec, { guest: { name: 'Next Guest' }, room_id: r('401').id, check_in: T, check_out: add(T, 1), pax: 1 });
ok('room can be rebooked after early checkout', x.s === 200, JSON.stringify(x.j));

// cancel
const cx = await call('POST', `/bookings/${bb.id}/cancel`, rec);
ok('cancel works', cx.s === 200 && cx.j.status === 'cancelled');
x = await call('POST', '/bookings', rec, { guest: { name: 'Reuse' }, room_id: r('112').id, check_in: add(T, 3), check_out: add(T, 4) });
ok('cancelled booking frees the room', x.s === 200, JSON.stringify(x.j));

// room maintenance conflict
x = await call('PATCH', `/rooms/${r('112').id}`, admin, { status: 'maintenance' });
ok('cannot put a booked room into maintenance (409)', x.s === 409);

// reports
const rep = (await call('GET', '/reports/summary', fin)).j;
ok('report has days & totals', rep.days.length === 30 && rep.totals.collected >= 10000, JSON.stringify(rep.totals));
console.log('report totals', JSON.stringify(rep.totals));
const csv = await fetch(B + `/reports/export?type=invoices`, { headers: { authorization: 'Bearer ' + fin } });
ok('CSV export', csv.status === 200 && (await csv.text()).includes('Invoice'));

// users
x = await call('POST', '/users', admin, { username: 'newuser', name: 'New User', role: 'reception', password: 'short' });
ok('short password rejected', x.s === 400);
x = await call('PATCH', '/users/1', admin, { role: 'reception' });
ok('cannot demote last admin', x.s === 400, JSON.stringify(x.j));
// sql injection-ish
x = await call('GET', "/bookings?q=' OR 1=1 --", rec);
ok('search is parameterised', x.s === 200 && x.j.length === 0);
// static + traversal
const s1 = await fetch('http://localhost:3111/../../etc/passwd');
const s2 = await fetch('http://localhost:3111/%2e%2e/%2e%2e/etc/passwd');
ok('path traversal blocked', s2.status !== 200 || !(await s2.text()).includes('root:'));
console.log(`\n${pass} passed, ${fail} failed`);
