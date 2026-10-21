'use strict';
const { q, today, addDays, nightsBetween, audit } = require('./db');

function nextNumber() {
  const y = today().slice(0, 4);
  const n = q.get('SELECT COUNT(*) n FROM invoices WHERE number LIKE ?', `INV-${y}-%`).n + 1;
  return `INV-${y}-${String(n).padStart(4, '0')}`;
}

function stayNights(b) {
  return Math.max(1, nightsBetween(b.check_in, b.check_out));
}

// One invoice per booking (the guest's "folio"). Created at check-in or checkout.
function ensureInvoice(bookingId, user) {
  const ex = q.get('SELECT id FROM invoices WHERE booking_id = ? AND voided = 0', bookingId);
  if (ex) return ex.id;
  const b = q.get(
    `SELECT b.*, r.number AS room_number, r.type AS room_type, g.name AS guest_name, g.organisation
     FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN guests g ON g.id=b.guest_id WHERE b.id=?`, bookingId);
  const id = Number(q.run(
    'INSERT INTO invoices (number, booking_id, bill_to, issued_on, due_on) VALUES (?,?,?,?,?)',
    nextNumber(), bookingId, b.organisation || b.guest_name, today(), addDays(today(), 30)).lastInsertRowid);
  const n = stayNights(b);
  q.run('INSERT INTO invoice_items (invoice_id, description, qty, unit_price, kind) VALUES (?,?,?,?,?)',
    id, `Room ${b.room_number} (${b.room_type}) accommodation`, n, b.rate, 'room');
  audit(user, 'invoice.create', 'invoice', id, `Invoice for ${b.ref}`);
  return id;
}

// Keep the room-charge line in step with the booking dates / rate.
function syncRoomCharge(bookingId) {
  const b = q.get('SELECT * FROM bookings WHERE id=?', bookingId);
  const inv = q.get('SELECT id FROM invoices WHERE booking_id=? AND voided=0', bookingId);
  if (!inv) return;
  q.run("UPDATE invoice_items SET qty=?, unit_price=? WHERE invoice_id=? AND kind='room'",
    stayNights(b), b.rate, inv.id);
}

function invoiceTotals(invoiceId) {
  const t = q.get('SELECT COALESCE(SUM(qty*unit_price),0) AS total FROM invoice_items WHERE invoice_id=?', invoiceId).total;
  const p = q.get('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE invoice_id=?', invoiceId).paid;
  const inv = q.get('SELECT voided FROM invoices WHERE id=?', invoiceId);
  const total = Math.round(t);
  let status = 'unpaid';
  if (inv && inv.voided) status = 'void';
  else if (total > 0 && p >= total) status = 'paid';
  else if (p > 0) status = 'partial';
  return { total, paid: p, balance: total - p, status };
}

function invoiceDetail(id) {
  const inv = q.get(
    `SELECT i.*, b.ref AS booking_ref, b.status AS stay_status, b.check_in, b.check_out, r.number AS room_number, g.name AS guest_name, g.phone
     FROM invoices i
     LEFT JOIN bookings b ON b.id=i.booking_id
     LEFT JOIN rooms r ON r.id=b.room_id
     LEFT JOIN guests g ON g.id=b.guest_id WHERE i.id=?`, id);
  if (!inv) return null;
  inv.items = q.all('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id', id);
  inv.payments = q.all(
    `SELECT p.*, u.name AS received_by_name FROM payments p LEFT JOIN users u ON u.id=p.received_by
     WHERE invoice_id=? ORDER BY paid_on, id`, id);
  Object.assign(inv, invoiceTotals(id));
  return inv;
}

// A bill is "running" while the guest is still booked/in house; it only becomes "due" after they leave.
function isRunning(invoiceId) {
  const r = q.get("SELECT b.status FROM invoices i JOIN bookings b ON b.id=i.booking_id WHERE i.id=?", invoiceId);
  return !!r && ['pending', 'confirmed', 'checked_in'].includes(r.status);
}
function owedAfterStay() {
  return q.all('SELECT id FROM invoices WHERE voided=0').reduce((s, i) => (isRunning(i.id) ? s : s + Math.max(0, invoiceTotals(i.id).balance)), 0);
}
function runningBills() {
  return q.all('SELECT id FROM invoices WHERE voided=0').reduce((s, i) => (isRunning(i.id) ? s + Math.max(0, invoiceTotals(i.id).balance) : s), 0);
}

module.exports = { isRunning, owedAfterStay, runningBills, ensureInvoice, syncRoomCharge, invoiceTotals, invoiceDetail, stayNights };
