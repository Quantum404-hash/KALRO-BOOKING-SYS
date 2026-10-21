'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { q, tx, audit, today, nowTime, addDays, nightsBetween } = require('./db');
const auth = require('./auth');
const billing = require('./billing');
const { seedCore, seedDemo } = require('./seed');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const ALL = ['admin', 'manager', 'reception', 'finance'];
const FRONT = ['admin', 'manager', 'reception'];
const MONEY = ['admin', 'manager', 'finance'];
const BOSS = ['admin', 'manager'];
const ACTIVE = "('pending','confirmed','checked_in')";

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m, extra) => new HttpError(400, m, extra);

// ---- validation helpers -------------------------------------------------------
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const int = (v, def = null) => (v === '' || v == null || isNaN(Number(v)) ? def : Math.trunc(Number(v)));
const oneOf = (v, list, label) => { if (!list.includes(v)) throw bad(`${label} must be one of: ${list.join(', ')}`); return v; };
const CATEGORIES = ['Research', 'Seminar', 'Delegation', 'Training', 'VIP', 'Other'];

// ---- router ---------------------------------------------------------------------
const routes = [];
function route(method, pattern, roles, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, roles, handler });
}

// ---- auth -------------------------------------------------------------------------
route('POST', '/api/auth/login', null, (c) => {
  const username = str(c.body.username, 60).toLowerCase();
  const key = `${c.ip}|${username}`;
  if (auth.throttled(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 10 minutes.');
  const u = q.get('SELECT * FROM users WHERE username = ?', username);
  if (!u || !u.active || !auth.verifyPassword(String(c.body.password || ''), u.salt, u.hash)) {
    auth.noteFail(key);
    audit(null, 'login.failed', 'user', null, `Failed login for "${username}"`);
    throw new HttpError(401, 'Wrong username or password.');
  }
  auth.clearFails(key);
  audit(u, 'login', 'user', u.id);
  return { token: auth.signToken(u.id), user: { id: u.id, username: u.username, name: u.name, role: u.role } };
});
route('GET', '/api/auth/me', ALL, (c) => ({ user: c.user }));
route('POST', '/api/auth/password', ALL, (c) => {
  const u = q.get('SELECT * FROM users WHERE id=?', c.user.id);
  if (!auth.verifyPassword(String(c.body.current || ''), u.salt, u.hash)) throw bad('Current password is wrong.');
  const pw = String(c.body.new || '');
  if (pw.length < 8) throw bad('New password must be at least 8 characters.');
  const { salt, hash } = auth.hashPassword(pw);
  q.run('UPDATE users SET salt=?, hash=? WHERE id=?', salt, hash, u.id);
  audit(c.user, 'password.change', 'user', u.id);
  return { ok: true };
});

// ---- dashboard --------------------------------------------------------------------
const BOOKING_SELECT = `
  SELECT b.*, g.name AS guest_name, g.organisation, g.phone, r.number AS room_number, r.type AS room_type,
         r.view AS room_view, e.name AS event_name,
         (SELECT id FROM invoices i WHERE i.booking_id=b.id AND i.voided=0) AS invoice_id
  FROM bookings b JOIN guests g ON g.id=b.guest_id JOIN rooms r ON r.id=b.room_id
  LEFT JOIN events e ON e.id=b.event_id`;

route('GET', '/api/dashboard', ALL, (c) => {
  const T = today();
  const rooms = q.all('SELECT * FROM rooms');
  const activeRooms = rooms.filter((r) => r.status === 'active');
  const busyIds = new Set(q.all(
    `SELECT DISTINCT room_id FROM bookings WHERE status IN ${ACTIVE} AND check_in <= ? AND check_out > ?`, T, T).map((r) => r.room_id));
  // a checked-in guest who is due out today still occupies the room until they leave
  const inHouseRoomIds = new Set(q.all("SELECT room_id FROM bookings WHERE status='checked_in'").map((r) => r.room_id));
  const types = ['Suite', 'Deluxe', 'Standard', 'Twin Share'];
  const availability = types.map((t) => {
    const all = rooms.filter((r) => r.type === t);
    const act = all.filter((r) => r.status === 'active');
    const busy = act.filter((r) => busyIds.has(r.id)).length;
    return { type: t, total: all.length, outOfService: all.length - act.length, busy, free: act.length - busy };
  });
  const busyTonight = activeRooms.filter((r) => busyIds.has(r.id)).length;

  const arrivals = q.all(
    `${BOOKING_SELECT} WHERE (b.check_in = ? AND b.status IN ('pending','confirmed','checked_in'))
        OR (b.check_in < ? AND b.check_out > ? AND b.status IN ('pending','confirmed'))
     ORDER BY COALESCE(b.eta,'99:99'), b.id`, T, T, T);
  arrivals.forEach((a) => { a.overdue = a.check_in < T; });
  const departures = q.all(`${BOOKING_SELECT} WHERE b.status='checked_in' AND b.check_out <= ? ORDER BY b.id`, T);
  departures.forEach((d) => { if (d.invoice_id) Object.assign(d, { bill: billing.invoiceTotals(d.invoice_id).total, paid: billing.invoiceTotals(d.invoice_id).paid, balance: billing.invoiceTotals(d.invoice_id).balance }); });

  const ih = q.all(`${BOOKING_SELECT} WHERE b.status='checked_in'`);
  const sum = (arr) => arr.reduce((s, b) => s + b.pax, 0);
  const inHouse = {
    rooms: ih.length,
    total: sum(ih),
    research: sum(ih.filter((b) => b.category === 'Research')),
    vip: sum(ih.filter((b) => b.category === 'VIP' || b.vip_level)),
    seminar: sum(ih.filter((b) => b.category === 'Seminar' || b.event_id)),
  };

  const events = q.all("SELECT * FROM events WHERE status='planned' AND end_date >= ? ORDER BY start_date LIMIT 6", T)
    .map((e) => ({
      ...e,
      total_days: nightsBetween(e.start_date, e.end_date) + 1,
      day: e.start_date <= T ? nightsBetween(e.start_date, T) + 1 : 0,
      starts_in: e.start_date > T ? nightsBetween(T, e.start_date) : 0,
    }));
  const activity = q.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 8');

  const out = {
    date: T, now: nowTime(),
    stats: {
      rooms: rooms.length, outOfService: rooms.length - activeRooms.length,
      occupiedNow: ih.length, busyTonight, freeTonight: activeRooms.length - busyTonight,
      occupancyPct: activeRooms.length ? Math.round((busyTonight / activeRooms.length) * 100) : 0,
      expectedArrivals: arrivals.filter((a) => a.status !== 'checked_in').length,
      arrivalsToday: arrivals.length,
      dueOut: departures.length,
    },
    arrivals, departures, inHouse, availability, events, activity,
    inHouseRoomIds: [...inHouseRoomIds],
  };
  if (MONEY.includes(c.user.role) || c.user.role === 'manager') {
    const month = T.slice(0, 7);
    out.money = {
      collectedThisMonth: q.get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE substr(paid_on,1,7)=?", month).s,
      ...(() => {
        // guests pay at the end of their stay: bills of guests still in the house are "running", not overdue
        let running = 0, unpaid = 0;
        q.all('SELECT i.id, b.status AS stay FROM invoices i LEFT JOIN bookings b ON b.id=i.booking_id WHERE i.voided=0').forEach((i) => {
          const bal = Math.max(0, billing.invoiceTotals(i.id).balance);
          if (i.stay === 'checked_in') running += bal; else unpaid += bal;
        });
        return { outstanding: unpaid, runningBills: running };
      })(),
    };
  }
  return out;
});

// ---- rooms --------------------------------------------------------------------------
route('GET', '/api/rooms', ALL, (c) => {
  const T = today();
  const rooms = q.all('SELECT * FROM rooms ORDER BY number');
  const stays = q.all(
    `SELECT b.id, b.ref, b.room_id, b.status, b.check_in, b.check_out, b.pax, g.name AS guest_name
     FROM bookings b JOIN guests g ON g.id=b.guest_id
     WHERE b.status IN ${ACTIVE} AND b.check_out > ?`, T);
  const wantFrom = c.query.from, wantTo = c.query.to;
  rooms.forEach((r) => {
    const mine = stays.filter((s) => s.room_id === r.id).sort((a, b) => a.check_in.localeCompare(b.check_in));
    const current = mine.find((s) => s.status === 'checked_in');
    const covering = mine.find((s) => s.check_in <= T && s.check_out > T);
    const next = mine.find((s) => s.check_in > T);
    r.state = r.status !== 'active' ? r.status : current ? 'occupied' : covering ? 'reserved' : 'vacant';
    r.current = current || covering || null;
    r.next = next || null;
    r.departing_today = !!(current && current.check_out <= T);
    if (isDate(wantFrom) && isDate(wantTo)) {
      r.free_for_range = r.status === 'active' &&
        !mine.some((s) => s.check_in < wantTo && s.check_out > wantFrom);
    }
  });
  return { rooms, today: T };
});

route('PATCH', '/api/rooms/:id', BOSS, (c) => {
  const r = q.get('SELECT * FROM rooms WHERE id=?', c.params.id);
  if (!r) throw new HttpError(404, 'Room not found');
  const b = c.body;
  const status = b.status ? oneOf(b.status, ['active', 'maintenance', 'blocked'], 'status') : r.status;
  const rate = b.rate != null ? int(b.rate) : r.rate;
  if (!(rate >= 0)) throw bad('Rate must be a positive number');
  if (status !== 'active') {
    const clash = q.all(`SELECT ref FROM bookings WHERE room_id=? AND status IN ${ACTIVE} AND check_out > ?`, r.id, today());
    if (clash.length && !b.force) throw new HttpError(409, `Room ${r.number} has ${clash.length} active/upcoming booking(s) (${clash.map((x) => x.ref).join(', ')}). Move them first.`, { clash });
  }
  q.run('UPDATE rooms SET status=?, status_note=?, rate=?, view=? WHERE id=?',
    status, status === 'active' ? null : str(b.status_note, 200) || r.status_note, rate, b.view != null ? str(b.view, 60) : r.view, r.id);
  audit(c.user, 'room.update', 'room', r.id, `Room ${r.number}: status ${status}, rate ${rate}`);
  return q.get('SELECT * FROM rooms WHERE id=?', r.id);
});

// ---- guests -------------------------------------------------------------------------
route('GET', '/api/guests', FRONT.concat('finance'), (c) => {
  const s = `%${str(c.query.q, 60)}%`;
  return q.all('SELECT * FROM guests WHERE name LIKE ? OR organisation LIKE ? OR phone LIKE ? ORDER BY name LIMIT 25', s, s, s);
});

// ---- bookings -----------------------------------------------------------------------
function findConflict(roomId, ci, co, excludeId = 0) {
  return q.get(
    `SELECT b.ref, b.check_in, b.check_out, g.name AS guest FROM bookings b JOIN guests g ON g.id=b.guest_id
     WHERE b.room_id=? AND b.status IN ${ACTIVE} AND b.id != ? AND b.check_in < ? AND b.check_out > ?`,
    roomId, excludeId, co, ci);
}
function checkStayInput(ci, co, user, existingCheckIn) {
  if (!isDate(ci) || !isDate(co)) throw bad('Check-in and check-out dates are required (YYYY-MM-DD).');
  if (co <= ci) throw bad('Check-out must be after check-in.');
  if (ci < today() && !BOSS.includes(user.role) && ci !== existingCheckIn) throw bad('Check-in date cannot be in the past.');
  if (nightsBetween(ci, co) > 180) throw bad('A stay cannot be longer than 180 nights.');
}
function bookingFull(id) {
  const b = q.get(`${BOOKING_SELECT} WHERE b.id=?`, id);
  if (b && b.invoice_id) Object.assign(b, { invoice: billing.invoiceTotals(b.invoice_id) });
  return b;
}

route('GET', '/api/bookings', ALL, (c) => {
  const where = [], p = [];
  if (c.query.status) { where.push('b.status = ?'); p.push(c.query.status); }
  if (c.query.from && isDate(c.query.from)) { where.push('b.check_out >= ?'); p.push(c.query.from); }
  if (c.query.to && isDate(c.query.to)) { where.push('b.check_in <= ?'); p.push(c.query.to); }
  if (c.query.event_id) { where.push('b.event_id = ?'); p.push(int(c.query.event_id)); }
  if (c.query.q) {
    const s = `%${str(c.query.q, 60)}%`;
    where.push('(g.name LIKE ? OR g.organisation LIKE ? OR b.ref LIKE ? OR r.number LIKE ?)'); p.push(s, s, s, s);
  }
  const rows = q.all(`${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                      ORDER BY b.check_in DESC, b.id DESC LIMIT 500`, ...p);
  rows.forEach((b) => { b.nights = Math.max(1, nightsBetween(b.check_in, b.check_out)); });
  return rows;
});
route('GET', '/api/bookings/:id', ALL, (c) => {
  const b = bookingFull(c.params.id);
  if (!b) throw new HttpError(404, 'Booking not found');
  b.nights = Math.max(1, nightsBetween(b.check_in, b.check_out));
  return b;
});

route('POST', '/api/bookings', FRONT, (c) => {
  const b = c.body;
  checkStayInput(b.check_in, b.check_out, c.user);
  const room = q.get('SELECT * FROM rooms WHERE id=?', int(b.room_id));
  if (!room) throw bad('Choose a room.');
  if (room.status !== 'active') throw bad(`Room ${room.number} is out of service (${room.status}).`);
  const pax = int(b.pax, 1);
  if (!(pax >= 1 && pax <= 20)) throw bad('Number of guests must be between 1 and 20.');
  const category = oneOf(b.category || 'Other', CATEGORIES, 'category');
  if (b.eta && !isTime(b.eta)) throw bad('ETA must be HH:MM.');
  let rate = room.rate;
  if (b.rate != null && int(b.rate) !== room.rate) {
    if (!BOSS.includes(c.user.role)) throw new HttpError(403, 'Only a manager or admin can change the room rate.');
    rate = int(b.rate); if (!(rate >= 0)) throw bad('Invalid rate.');
  }
  const status = b.status === 'pending' ? 'pending' : 'confirmed';

  return tx(() => {
    const clash = findConflict(room.id, b.check_in, b.check_out);
    if (clash) throw new HttpError(409, `Room ${room.number} is already booked ${clash.check_in} → ${clash.check_out} (${clash.ref}, ${clash.guest}).`);
    let guestId = int(b.guest_id);
    if (!guestId) {
      const g = b.guest || {};
      if (!str(g.name)) throw bad('Guest name is required.');
      guestId = Number(q.run('INSERT INTO guests (name,organisation,phone,email) VALUES (?,?,?,?)',
        str(g.name), str(g.organisation), str(g.phone, 40), str(g.email, 100)).lastInsertRowid);
    } else if (!q.get('SELECT id FROM guests WHERE id=?', guestId)) throw bad('Guest not found.');
    const eventId = int(b.event_id);
    if (eventId && !q.get('SELECT id FROM events WHERE id=?', eventId)) throw bad('Event not found.');
    const n = q.get("SELECT COUNT(*) n FROM bookings WHERE ref LIKE ?", `BK-${today().slice(0, 4)}-%`).n + 1;
    const ref = `BK-${today().slice(0, 4)}-${String(n).padStart(4, '0')}`;
    const id = Number(q.run(
      `INSERT INTO bookings (ref,guest_id,room_id,event_id,check_in,check_out,eta,pax,category,purpose,vip_level,rate,status,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, guestId, room.id, eventId || null, b.check_in, b.check_out, b.eta || null, pax, category,
      str(b.purpose), str(b.vip_level, 40) || null, rate, status, str(b.notes, 500), c.user.id).lastInsertRowid);
    audit(c.user, 'booking.create', 'booking', id, `${ref}: room ${room.number}, ${b.check_in} → ${b.check_out}`);
    return bookingFull(id);
  });
});

route('PATCH', '/api/bookings/:id', FRONT, (c) => {
  const old = q.get('SELECT * FROM bookings WHERE id=?', c.params.id);
  if (!old) throw new HttpError(404, 'Booking not found');
  if (!['pending', 'confirmed', 'checked_in'].includes(old.status)) throw bad('Only active bookings can be edited.');
  const b = c.body;
  const ci = old.status === 'checked_in' ? old.check_in : (b.check_in || old.check_in);
  const co = b.check_out || old.check_out;
  checkStayInput(ci, co, c.user, old.check_in);
  const roomId = b.room_id ? int(b.room_id) : old.room_id;
  const room = q.get('SELECT * FROM rooms WHERE id=?', roomId);
  if (!room) throw bad('Room not found.');
  if (roomId !== old.room_id && room.status !== 'active') throw bad(`Room ${room.number} is out of service.`);
  let rate = old.rate;
  if (b.rate != null && int(b.rate) !== old.rate) {
    if (!BOSS.includes(c.user.role)) throw new HttpError(403, 'Only a manager or admin can change the room rate.');
    rate = int(b.rate);
  }
  const category = oneOf(b.category || old.category, CATEGORIES, 'category');
  const pax = b.pax != null ? int(b.pax, old.pax) : old.pax;
  if (!(pax >= 1 && pax <= 20)) throw bad('Number of guests must be between 1 and 20.');
  if (b.eta && !isTime(b.eta)) throw bad('ETA must be HH:MM.');

  return tx(() => {
    const clash = findConflict(roomId, ci, co, old.id);
    if (clash) throw new HttpError(409, `Room ${room.number} is already booked ${clash.check_in} → ${clash.check_out} (${clash.ref}, ${clash.guest}).`);
    if (old.status === 'checked_in' && roomId !== old.room_id) {
      const occ = q.get("SELECT 1 x FROM bookings WHERE room_id=? AND status='checked_in' AND id != ?", roomId, old.id);
      if (occ) throw new HttpError(409, `Room ${room.number} is currently occupied.`);
    }
    q.run(`UPDATE bookings SET check_in=?, check_out=?, room_id=?, rate=?, eta=?, pax=?, category=?, purpose=?, vip_level=?, event_id=?, notes=? WHERE id=?`,
      ci, co, roomId, rate, b.eta !== undefined ? (b.eta || null) : old.eta, pax, category,
      b.purpose !== undefined ? str(b.purpose) : old.purpose,
      b.vip_level !== undefined ? str(b.vip_level, 40) || null : old.vip_level,
      b.event_id !== undefined ? int(b.event_id) || null : old.event_id,
      b.notes !== undefined ? str(b.notes, 500) : old.notes, old.id);
    billing.syncRoomCharge(old.id);
    audit(c.user, 'booking.update', 'booking', old.id, `${old.ref} updated`);
    return bookingFull(old.id);
  });
});

function transition(c, from, to, action, extra) {
  const b = q.get('SELECT * FROM bookings WHERE id=?', c.params.id);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (!from.includes(b.status)) throw bad(`Cannot ${action} a booking that is ${b.status.replace('_', ' ')}.`);
  return tx(() => {
    if (extra) extra(b);
    q.run('UPDATE bookings SET status=? WHERE id=?', to, b.id);
    audit(c.user, `booking.${action}`, 'booking', b.id, b.ref);
    return bookingFull(b.id);
  });
}
route('POST', '/api/bookings/:id/confirm', FRONT, (c) => transition(c, ['pending'], 'confirmed', 'confirm'));
route('POST', '/api/bookings/:id/cancel', FRONT, (c) =>
  transition(c, ['pending', 'confirmed'], 'cancelled', 'cancel', (b) => {
    const inv = q.get('SELECT id FROM invoices WHERE booking_id=? AND voided=0', b.id);
    if (inv && billing.invoiceTotals(inv.id).paid === 0) q.run('UPDATE invoices SET voided=1 WHERE id=?', inv.id);
  }));
route('POST', '/api/bookings/:id/noshow', FRONT, (c) => transition(c, ['pending', 'confirmed'], 'no_show', 'noshow'));

route('POST', '/api/bookings/:id/checkin', FRONT, (c) => {
  const b = q.get('SELECT b.*, r.number AS rn, r.status AS rs FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.id=?', c.params.id);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (!['pending', 'confirmed'].includes(b.status)) throw bad(`Cannot check in a booking that is ${b.status.replace('_', ' ')}.`);
  if (b.check_in > today() && !BOSS.includes(c.user.role)) throw bad(`Arrival is on ${b.check_in}. Edit the booking dates first if the guest arrived early.`);
  if (b.rs !== 'active') throw bad(`Room ${b.rn} is out of service.`);
  return tx(() => {
    const occ = q.get(`SELECT g.name FROM bookings x JOIN guests g ON g.id=x.guest_id WHERE x.room_id=? AND x.status='checked_in'`, b.room_id);
    if (occ) throw new HttpError(409, `Room ${b.rn} is still occupied by ${occ.name}. Check them out first.`);
    q.run("UPDATE bookings SET status='checked_in', checked_in_at=? WHERE id=?", `${today()} ${nowTime()}`, b.id);
    billing.ensureInvoice(b.id, c.user);
    audit(c.user, 'booking.checkin', 'booking', b.id, `${b.ref} checked in to room ${b.rn}`);
    return bookingFull(b.id);
  });
});

route('POST', '/api/bookings/:id/checkout', FRONT, (c) => {
  const b = q.get('SELECT b.*, r.number AS rn FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.id=?', c.params.id);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (b.status !== 'checked_in') throw bad('Only checked-in guests can be checked out.');
  return tx(() => {
    const T = today();
    let co = b.check_out;
    if (T < co) co = T > b.check_in ? T : addDays(b.check_in, 1); // early departure
    q.run("UPDATE bookings SET status='checked_out', check_out=?, checked_out_at=? WHERE id=?", co, `${T} ${nowTime()}`, b.id);
    billing.ensureInvoice(b.id, c.user);
    billing.syncRoomCharge(b.id);
    audit(c.user, 'booking.checkout', 'booking', b.id, `${b.ref} checked out of room ${b.rn}`);
    return bookingFull(b.id);
  });
});

// ---- events -------------------------------------------------------------------------
route('GET', '/api/events', ALL, () => {
  const T = today();
  return q.all(`SELECT e.*, (SELECT COUNT(*) FROM bookings b WHERE b.event_id=e.id AND b.status IN ${ACTIVE}) AS rooms_booked,
                       (SELECT COALESCE(SUM(pax),0) FROM bookings b WHERE b.event_id=e.id AND b.status IN ${ACTIVE}) AS pax_booked
                FROM events e ORDER BY e.start_date DESC`).map((e) => ({
    ...e,
    phase: e.status === 'cancelled' ? 'cancelled' : e.end_date < T ? 'past' : e.start_date <= T ? 'active' : 'upcoming',
    total_days: nightsBetween(e.start_date, e.end_date) + 1,
    day: e.start_date <= T && e.end_date >= T ? nightsBetween(e.start_date, T) + 1 : 0,
  }));
});
function eventInput(b, old) {
  const name = str(b.name ?? old?.name);
  if (!name) throw bad('Event name is required.');
  const s = b.start_date ?? old?.start_date, e = b.end_date ?? old?.end_date;
  if (!isDate(s) || !isDate(e) || e < s) throw bad('Valid start and end dates are required (end not before start).');
  const participants = int(b.participants ?? old?.participants, 0);
  if (participants < 0 || participants > 2000) throw bad('Invalid number of participants.');
  return [name, str(b.venue ?? old?.venue), s, e, participants, str(b.organiser ?? old?.organiser), str(b.notes ?? old?.notes, 500)];
}
route('POST', '/api/events', FRONT, (c) => {
  const v = eventInput(c.body);
  const id = Number(q.run('INSERT INTO events (name,venue,start_date,end_date,participants,organiser,notes) VALUES (?,?,?,?,?,?,?)', ...v).lastInsertRowid);
  audit(c.user, 'event.create', 'event', id, v[0]);
  return q.get('SELECT * FROM events WHERE id=?', id);
});
route('PATCH', '/api/events/:id', FRONT, (c) => {
  const old = q.get('SELECT * FROM events WHERE id=?', c.params.id);
  if (!old) throw new HttpError(404, 'Event not found');
  const v = eventInput(c.body, old);
  const status = c.body.status ? oneOf(c.body.status, ['planned', 'cancelled', 'done'], 'status') : old.status;
  q.run('UPDATE events SET name=?,venue=?,start_date=?,end_date=?,participants=?,organiser=?,notes=?,status=? WHERE id=?', ...v, status, old.id);
  audit(c.user, 'event.update', 'event', old.id, v[0]);
  return q.get('SELECT * FROM events WHERE id=?', old.id);
});

// ---- amenities ------------------------------------------------------------------------
route('GET', '/api/amenities', ALL, (c) => {
  const date = isDate(c.query.date) ? c.query.date : today();
  const list = q.all('SELECT * FROM amenities ORDER BY kind, name');
  const res = q.all(
    `SELECT a.*, e.name AS event_name FROM amenity_reservations a LEFT JOIN events e ON e.id=a.event_id
     WHERE a.on_date=? AND a.status='confirmed' ORDER BY a.start_time`, date);
  list.forEach((a) => { a.reservations = res.filter((r) => r.amenity_id === a.id); });
  return { date, amenities: list };
});
route('POST', '/api/amenities/:id/reserve', FRONT, (c) => {
  const a = q.get('SELECT * FROM amenities WHERE id=? AND active=1', c.params.id);
  if (!a) throw new HttpError(404, 'Amenity not found');
  const b = c.body;
  if (!isDate(b.on_date)) throw bad('Date is required.');
  if (b.on_date < today() && !BOSS.includes(c.user.role)) throw bad('Date cannot be in the past.');
  if (!isTime(b.start_time) || !isTime(b.end_time) || b.end_time <= b.start_time) throw bad('Valid start and end times are required (end after start).');
  const who = str(b.reserved_for);
  if (!who) throw bad('Say who the reservation is for.');
  const pax = int(b.pax);
  if (a.capacity && pax && pax > a.capacity) throw bad(`${a.name} holds at most ${a.capacity} people.`);
  return tx(() => {
    const clash = q.get(
      `SELECT reserved_for, start_time, end_time FROM amenity_reservations
       WHERE amenity_id=? AND on_date=? AND status='confirmed' AND start_time < ? AND end_time > ?`,
      a.id, b.on_date, b.end_time, b.start_time);
    if (clash && a.kind !== 'Dining') throw new HttpError(409, `${a.name} is already reserved ${clash.start_time}–${clash.end_time} for ${clash.reserved_for}.`);
    const id = Number(q.run(
      'INSERT INTO amenity_reservations (amenity_id,event_id,reserved_for,on_date,start_time,end_time,pax,created_by) VALUES (?,?,?,?,?,?,?,?)',
      a.id, int(b.event_id) || null, who, b.on_date, b.start_time, b.end_time, pax, c.user.id).lastInsertRowid);
    audit(c.user, 'amenity.reserve', 'amenity', a.id, `${a.name} for ${who} on ${b.on_date}`);
    return q.get('SELECT * FROM amenity_reservations WHERE id=?', id);
  });
});
route('DELETE', '/api/reservations/:id', FRONT, (c) => {
  const r = q.get('SELECT * FROM amenity_reservations WHERE id=?', c.params.id);
  if (!r) throw new HttpError(404, 'Reservation not found');
  q.run("UPDATE amenity_reservations SET status='cancelled' WHERE id=?", r.id);
  audit(c.user, 'amenity.cancel', 'amenity', r.amenity_id, `Reservation for ${r.reserved_for} on ${r.on_date} cancelled`);
  return { ok: true };
});
route('PATCH', '/api/amenities/:id', BOSS, (c) => {
  const a = q.get('SELECT * FROM amenities WHERE id=?', c.params.id);
  if (!a) throw new HttpError(404, 'Amenity not found');
  const rate = c.body.rate != null ? int(c.body.rate) : a.rate;
  if (!(rate >= 0)) throw bad('Invalid rate.');
  q.run('UPDATE amenities SET rate=?, active=? WHERE id=?', rate, c.body.active === false ? 0 : 1, a.id);
  audit(c.user, 'amenity.update', 'amenity', a.id, `${a.name} rate ${rate}`);
  return q.get('SELECT * FROM amenities WHERE id=?', a.id);
});

// ---- invoices & payments --------------------------------------------------------------
route('GET', '/api/invoices', MONEY.concat('reception'), (c) => {
  const where = [], p = [];
  if (c.query.q) { const s = `%${str(c.query.q, 60)}%`; where.push('(i.number LIKE ? OR i.bill_to LIKE ? OR g.name LIKE ? OR b.ref LIKE ? OR EXISTS (SELECT 1 FROM payments pp WHERE pp.invoice_id=i.id AND pp.reference LIKE ?))'); p.push(s, s, s, s, s); }
  if (isDate(c.query.from)) { where.push('i.issued_on >= ?'); p.push(c.query.from); }
  if (isDate(c.query.to)) { where.push('i.issued_on <= ?'); p.push(c.query.to); }
  let rows = q.all(
    `SELECT i.*, b.ref AS booking_ref, b.status AS booking_status, b.status AS stay_status, b.checked_out_at, g.name AS guest_name FROM invoices i
     LEFT JOIN bookings b ON b.id=i.booking_id LEFT JOIN guests g ON g.id=b.guest_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC LIMIT 500`, ...p);
  rows = rows.map((i) => {
    const t = billing.invoiceTotals(i.id);
    const running = ['pending', 'confirmed', 'checked_in'].includes(i.booking_status);
    const left = i.checked_out_at ? i.checked_out_at.slice(0, 10) : null;
    return { ...i, ...t, running, days_since_checkout: left ? nightsBetween(left, today()) : null };
  });
  if (c.query.status === 'due') rows = rows.filter((i) => !i.running && i.balance > 0 && i.status !== 'void');
  else if (c.query.status === 'running') rows = rows.filter((i) => i.running && i.status !== 'void');
  else if (c.query.status) rows = rows.filter((i) => i.status === c.query.status);
  return rows;
});
route('GET', '/api/invoices/:id', MONEY.concat('reception'), (c) => {
  const i = billing.invoiceDetail(int(c.params.id));
  if (!i) throw new HttpError(404, 'Invoice not found');
  i.running = billing.isRunning(i.id);
  return i;
});
route('POST', '/api/invoices', MONEY, (c) => {
  const b = c.body;
  const billTo = str(b.bill_to);
  if (!billTo) throw bad('Bill-to name is required.');
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw bad('Add at least one line item.');
  return tx(() => {
    const bookingId = int(b.booking_id) || null;
    if (bookingId && !q.get('SELECT id FROM bookings WHERE id=?', bookingId)) throw bad('Booking not found.');
    const id = Number(q.run('INSERT INTO invoices (number,booking_id,bill_to,issued_on,due_on,notes) VALUES (?,?,?,?,?,?)',
      nextInvoiceNumber(), bookingId, billTo, today(), addDays(today(), 30), str(b.notes, 300)).lastInsertRowid);
    items.forEach((it) => addItem(id, it));
    audit(c.user, 'invoice.create', 'invoice', id, `Manual invoice for ${billTo}`);
    return billing.invoiceDetail(id);
  });
});
function nextInvoiceNumber() {
  const y = today().slice(0, 4);
  return `INV-${y}-${String(q.get('SELECT COUNT(*) n FROM invoices WHERE number LIKE ?', `INV-${y}-%`).n + 1).padStart(4, '0')}`;
}
function addItem(invoiceId, it) {
  const description = str(it.description);
  const qty = Number(it.qty ?? 1), price = int(it.unit_price);
  if (!description) throw bad('Each line needs a description.');
  if (!(qty > 0 && qty <= 10000)) throw bad('Quantity must be greater than zero.');
  if (price == null || price < 0) throw bad('Unit price must be zero or more.');
  q.run('INSERT INTO invoice_items (invoice_id,description,qty,unit_price,kind) VALUES (?,?,?,?,?)',
    invoiceId, description, qty, price, ['room', 'meal', 'hall', 'laundry', 'other'].includes(it.kind) ? it.kind : 'other');
}
function openInvoice(id) {
  const i = q.get('SELECT * FROM invoices WHERE id=?', id);
  if (!i) throw new HttpError(404, 'Invoice not found');
  if (i.voided) throw bad('This invoice is void.');
  return i;
}
route('POST', '/api/invoices/:id/items', MONEY.concat('reception'), (c) => {
  const i = openInvoice(c.params.id);
  addItem(i.id, c.body);
  audit(c.user, 'invoice.item', 'invoice', i.id, `${i.number}: ${str(c.body.description)}`);
  return billing.invoiceDetail(i.id);
});
route('DELETE', '/api/invoices/:id/items/:itemId', MONEY, (c) => {
  const i = openInvoice(c.params.id);
  const it = q.get('SELECT * FROM invoice_items WHERE id=? AND invoice_id=?', c.params.itemId, i.id);
  if (!it) throw new HttpError(404, 'Line not found');
  if (it.kind === 'room') throw bad('The room charge follows the booking dates. Edit the booking instead.');
  q.run('DELETE FROM invoice_items WHERE id=?', it.id);
  audit(c.user, 'invoice.item.delete', 'invoice', i.id, `${i.number}: removed "${it.description}"`);
  return billing.invoiceDetail(i.id);
});
const PAY_METHODS = ['ERP payment', 'M-Pesa', 'Cash', 'Bank transfer', 'Cheque', 'Card', 'LPO / Gov. voucher'];
route('POST', '/api/invoices/:id/payments', MONEY.concat('reception'), (c) => {
  const i = openInvoice(c.params.id);
  const amount = int(c.body.amount);
  const t = billing.invoiceTotals(i.id);
  if (!(amount > 0)) throw bad('Enter an amount greater than zero.');
  if (amount > t.balance) throw bad(`Amount is more than the balance (${t.balance.toLocaleString()}).`);
  const paidOn = isDate(c.body.paid_on) ? c.body.paid_on : today();
  const method = oneOf(c.body.method || 'ERP payment', PAY_METHODS, 'method');
  const reference = str(c.body.reference, 60);
  if (method !== 'Cash' && !reference) throw bad(method === 'ERP payment' ? 'Enter the ERP payment code.' : 'Enter the payment reference.');
  if (method === 'ERP payment' && !/^[A-Za-z0-9][A-Za-z0-9\-_\/. ]{2,59}$/.test(reference)) throw bad('The ERP code should be 3 to 60 letters, numbers, dashes or slashes.');
  if (reference) {
    const dup = q.get(
      `SELECT i2.number FROM payments p JOIN invoices i2 ON i2.id=p.invoice_id WHERE p.method=? AND lower(p.reference)=lower(?)`, method, reference);
    if (dup) throw new HttpError(409, `This ${method} code was already recorded on invoice ${dup.number}.`);
  }
  q.run('INSERT INTO payments (invoice_id,amount,method,reference,paid_on,received_by) VALUES (?,?,?,?,?,?)',
    i.id, amount, method, reference, paidOn, c.user.id);
  audit(c.user, 'payment.add', 'invoice', i.id, `${i.number}: KES ${amount.toLocaleString()} via ${method}${reference ? ' ' + reference : ''}`);
  return billing.invoiceDetail(i.id);
});
route('POST', '/api/invoices/:id/void', MONEY, (c) => {
  const i = openInvoice(c.params.id);
  if (billing.invoiceTotals(i.id).paid > 0) throw bad('Invoices with payments cannot be voided.');
  q.run('UPDATE invoices SET voided=1 WHERE id=?', i.id);
  audit(c.user, 'invoice.void', 'invoice', i.id, i.number);
  return billing.invoiceDetail(i.id);
});

// ---- reports -------------------------------------------------------------------------
function rangeFrom(c) {
  const to = isDate(c.query.to) ? c.query.to : today();
  const from = isDate(c.query.from) ? c.query.from : addDays(to, -29);
  if (to < from) throw bad('"To" date is before "From" date.');
  if (nightsBetween(from, to) > 400) throw bad('Choose a range of 400 days or less.');
  return { from, to };
}
route('GET', '/api/reports/summary', MONEY, (c) => {
  const { from, to } = rangeFrom(c);
  const totalRooms = q.get('SELECT COUNT(*) n FROM rooms').n;
  const stays = q.all(
    `SELECT b.*, r.type AS room_type, g.organisation, g.name AS guest_name FROM bookings b
     JOIN rooms r ON r.id=b.room_id JOIN guests g ON g.id=b.guest_id
     WHERE b.status IN ('confirmed','checked_in','checked_out') AND b.check_in <= ? AND b.check_out > ?`, to, from);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const occ = stays.filter((s) => s.check_in <= d && s.check_out > d).length;
    days.push({ date: d, occupied: occ, available: totalRooms, occupancy: Math.round((occ / totalRooms) * 100) });
  }
  const nights = days.reduce((s, d) => s + d.occupied, 0);
  const roomRevenue = stays.reduce((s, b) => {
    const ov = Math.max(0, nightsBetween(b.check_in > from ? b.check_in : from, b.check_out < addDays(to, 1) ? b.check_out : addDays(to, 1)));
    return s + ov * b.rate;
  }, 0);
  const pay = q.all('SELECT paid_on AS date, SUM(amount) AS collected FROM payments WHERE paid_on BETWEEN ? AND ? GROUP BY paid_on ORDER BY paid_on', from, to);
  const byMethod = q.all('SELECT method, SUM(amount) AS amount, COUNT(*) AS n FROM payments WHERE paid_on BETWEEN ? AND ? GROUP BY method ORDER BY amount DESC', from, to);
  const issued = q.all('SELECT id FROM invoices WHERE voided=0 AND issued_on BETWEEN ? AND ?', from, to)
    .reduce((s, i) => s + billing.invoiceTotals(i.id).total, 0);
  const outstanding = billing.owedAfterStay();
  const group = (key) => {
    const m = new Map();
    stays.forEach((b) => {
      const n = Math.max(0, nightsBetween(b.check_in > from ? b.check_in : from, b.check_out < addDays(to, 1) ? b.check_out : addDays(to, 1)));
      const k = key(b) || 'Unspecified';
      const o = m.get(k) || { name: k, bookings: 0, nights: 0, revenue: 0 };
      o.bookings++; o.nights += n; o.revenue += n * b.rate; m.set(k, o);
    });
    return [...m.values()].sort((a, b) => b.nights - a.nights);
  };
  return {
    from, to, days,
    totals: {
      roomNights: nights,
      occupancyPct: Math.round((nights / (totalRooms * days.length)) * 100),
      adr: nights ? Math.round(roomRevenue / nights) : 0,
      roomRevenue, invoiced: issued, collected: pay.reduce((s, p) => s + p.collected, 0), outstanding,
      bookings: stays.length,
    },
    payments: pay, byMethod,
    byCategory: group((b) => b.category), byType: group((b) => b.room_type),
    topOrganisations: group((b) => b.organisation || b.guest_name).slice(0, 8),
  };
});

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
route('GET', '/api/reports/export', MONEY, (c) => {
  const { from, to } = rangeFrom(c);
  const type = oneOf(c.query.type || 'bookings', ['bookings', 'invoices', 'payments'], 'type');
  let head, rows;
  if (type === 'bookings') {
    head = ['Ref', 'Guest', 'Organisation', 'Room', 'Type', 'Check-in', 'Check-out', 'Nights', 'Guests', 'Category', 'Status', 'Rate (KES)'];
    rows = q.all(`${BOOKING_SELECT} WHERE b.check_out >= ? AND b.check_in <= ? ORDER BY b.check_in`, from, to).map((b) =>
      [b.ref, b.guest_name, b.organisation, b.room_number, b.room_type, b.check_in, b.check_out, Math.max(1, nightsBetween(b.check_in, b.check_out)), b.pax, b.category, b.status, b.rate]);
  } else if (type === 'invoices') {
    head = ['Invoice', 'Issued', 'Bill to', 'Booking', 'Total (KES)', 'Paid (KES)', 'Balance (KES)', 'Status'];
    rows = q.all('SELECT i.*, b.ref AS booking_ref FROM invoices i LEFT JOIN bookings b ON b.id=i.booking_id WHERE i.issued_on BETWEEN ? AND ? ORDER BY i.id', from, to)
      .map((i) => { const t = billing.invoiceTotals(i.id); return [i.number, i.issued_on, i.bill_to, i.booking_ref, t.total, t.paid, t.balance, t.status]; });
  } else {
    head = ['Date', 'Invoice', 'Bill to', 'Amount (KES)', 'Method', 'Reference'];
    rows = q.all('SELECT p.*, i.number, i.bill_to FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on, p.id', from, to)
      .map((p) => [p.paid_on, p.number, p.bill_to, p.amount, p.method, p.reference]);
  }
  audit(c.user, 'report.export', 'report', null, `${type} ${from} → ${to}`);
  return { __csv: [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n'), filename: `kalro-${type}-${from}-to-${to}.csv` };
});

// ---- users & audit ---------------------------------------------------------------------
const ROLES = ['admin', 'manager', 'reception', 'finance'];
route('GET', '/api/users', ['admin'], () => q.all('SELECT id, username, name, role, active, created_at FROM users ORDER BY name'));
route('POST', '/api/users', ['admin'], (c) => {
  const username = str(c.body.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('Username: 3–40 letters, numbers, dot, dash or underscore.');
  if (!str(c.body.name)) throw bad('Full name is required.');
  const role = oneOf(c.body.role, ROLES, 'role');
  const pw = String(c.body.password || '');
  if (pw.length < 8) throw bad('Password must be at least 8 characters.');
  if (q.get('SELECT id FROM users WHERE username=?', username)) throw new HttpError(409, 'That username is taken.');
  const { salt, hash } = auth.hashPassword(pw);
  const id = Number(q.run('INSERT INTO users (username,name,role,salt,hash) VALUES (?,?,?,?,?)', username, str(c.body.name), role, salt, hash).lastInsertRowid);
  audit(c.user, 'user.create', 'user', id, `${username} (${role})`);
  return q.get('SELECT id, username, name, role, active FROM users WHERE id=?', id);
});
route('PATCH', '/api/users/:id', ['admin'], (c) => {
  const u = q.get('SELECT * FROM users WHERE id=?', c.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  const role = c.body.role ? oneOf(c.body.role, ROLES, 'role') : u.role;
  const active = c.body.active === undefined ? u.active : c.body.active ? 1 : 0;
  const stillAdmin = role === 'admin' && active === 1;
  if (u.role === 'admin' && u.active && !stillAdmin && q.get("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").n <= 1)
    throw bad('You cannot remove the last active administrator.');
  let { salt, hash } = u;
  if (c.body.password) {
    if (String(c.body.password).length < 8) throw bad('Password must be at least 8 characters.');
    ({ salt, hash } = auth.hashPassword(String(c.body.password)));
  }
  q.run('UPDATE users SET name=?, role=?, active=?, salt=?, hash=? WHERE id=?', str(c.body.name) || u.name, role, active, salt, hash, u.id);
  audit(c.user, 'user.update', 'user', u.id, `${u.username}: role ${role}${active ? '' : ', deactivated'}${c.body.password ? ', password reset' : ''}`);
  return q.get('SELECT id, username, name, role, active FROM users WHERE id=?', u.id);
});
route('GET', '/api/audit', BOSS, (c) => {
  const where = [], p = [];
  if (c.query.q) { const s = `%${str(c.query.q, 60)}%`; where.push('(action LIKE ? OR detail LIKE ? OR user_name LIKE ?)'); p.push(s, s, s); }
  return q.all(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(int(c.query.limit, 200), 1000)}`, ...p);
});

// ---- http plumbing -------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (ch) => { size += ch.length; if (size > 1_000_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(bad('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' ) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      if (path.extname(rel)) return send(res, 404, { error: 'Not found' });
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) =>
        e2 ? send(res, 404, { error: 'Not found' }) : send(res, 200, d2, { 'Content-Type': MIME['.html'] }));
    }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.jpg' ? 'public, max-age=86400' : 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url.pathname);
  }
  try {
    const r = routes.find((x) => x.method === req.method && x.rx.test(url.pathname));
    if (!r) {
      if (routes.some((x) => x.rx.test(url.pathname))) throw new HttpError(405, 'Method not allowed');
      throw new HttpError(404, 'Not found');
    }
    const m = url.pathname.match(r.rx);
    const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    let user = null;
    if (r.roles) {
      user = auth.userFromRequest(req);
      if (!user) throw new HttpError(401, 'Please sign in.');
      if (!r.roles.includes(user.role)) throw new HttpError(403, 'Your role does not have access to this.');
    }
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const out = await r.handler({ params, query: Object.fromEntries(url.searchParams), body, user, ip: req.socket.remoteAddress });
    if (out && out.__csv !== undefined)
      return send(res, 200, '﻿' + out.__csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` });
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    if (e && /constraint/i.test(String(e.message))) return send(res, 400, { error: 'That change conflicts with existing data.' });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

if (require.main === module) {
  const fresh = seedCore();
  if (fresh && process.env.KALRO_CLEAN !== '1') seedDemo();
  server.listen(PORT, () => {
    console.log(`KALRO Guesthouse running → http://localhost:${PORT}`);
    if (fresh) console.log('First run: default logins are admin/admin123, manager/manager123, reception/reception123, finance/finance123 — change them under Users & Roles.');
  });
}
module.exports = { server };
