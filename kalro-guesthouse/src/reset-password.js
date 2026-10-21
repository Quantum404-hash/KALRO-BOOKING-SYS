'use strict';
// Locked out? Run from the project folder:   node src/reset-password.js admin NewPassword123
// Works with the server stopped or running. Sets a new password for that username.
const { q, audit } = require('./db');
const { hashPassword } = require('./auth');
const [username, password] = process.argv.slice(2);
if (!username || !password) { console.log('Usage: node src/reset-password.js <username> <new password (8+ characters)>'); process.exit(1); }
if (password.length < 8) { console.log('The new password must be at least 8 characters.'); process.exit(1); }
const u = q.get('SELECT * FROM users WHERE username = ?', username.toLowerCase());
if (!u) { console.log(`No user called "${username}".`); process.exit(1); }
const { salt, hash } = hashPassword(password);
q.run('UPDATE users SET salt=?, hash=?, active=1 WHERE id=?', salt, hash, u.id);
audit(null, 'password.reset.cli', 'user', u.id, `${u.username}: password reset from the command line`);
console.log(`Password for "${u.username}" has been reset. Sign in, then change it under the key icon.`);
