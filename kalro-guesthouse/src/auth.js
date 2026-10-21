'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir, q } = require('./db');

// Signing secret: from env, or generated once and stored next to the database.
const secretFile = path.join(dataDir, 'secret.key');
let SECRET = process.env.KALRO_SECRET;
if (!SECRET) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(secretFile, 'utf8').trim();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64 = (s) => Buffer.from(s).toString('base64url');
function signToken(uid, hours = 12) {
  const body = b64(JSON.stringify({ uid, exp: Date.now() + hours * 3600 * 1000 }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function userFromRequest(req) {
  const h = req.headers['authorization'] || '';
  const p = readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return null;
  const u = q.get('SELECT id, username, name, role, active FROM users WHERE id = ?', p.uid);
  return u && u.active ? u : null;
}

// Very small in-memory login throttle: 8 failed attempts / 10 min per ip+username.
const fails = new Map();
function throttled(key) {
  const rec = fails.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > 10 * 60 * 1000) { fails.delete(key); return false; }
  return rec.n >= 8;
}
function noteFail(key) {
  const rec = fails.get(key);
  if (!rec || Date.now() - rec.first > 10 * 60 * 1000) fails.set(key, { n: 1, first: Date.now() });
  else rec.n++;
}
const clearFails = (key) => fails.delete(key);

module.exports = { hashPassword, verifyPassword, signToken, userFromRequest, throttled, noteFail, clearFails };
