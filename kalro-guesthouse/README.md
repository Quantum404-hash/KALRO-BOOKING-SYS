# KALRO Guesthouse system

Rooms, bookings, check-in/out, events, lounge/hall reservations, invoices and payments, reports, users and an audit log.
No `npm install` needed: it uses only what ships with Node.js.

## Run it
1. Install Node.js 22.13 or newer (https://nodejs.org, LTS or Current).
2. Windows: double-click `start.bat`. Anywhere else: `npm start`.
3. Open http://localhost:3000. Other computers on the same network use `http://<this-computer's-IP>:3000`.

First start loads SAMPLE data so you can explore. To start empty instead: delete the `data` folder, then run `npm run clean` once.
To bring the sample data back: `npm run reset-demo` (this erases everything).

## Default logins (change them first, under Users & roles)
| Username | Password | Role |
|---|---|---|
| admin | admin123 | Administrator: everything |
| manager | manager123 | Manager: everything except users |
| reception | reception123 | Front desk: bookings, check-in/out, events, amenities, charges, payments |
| finance | finance123 | Finance: invoices, payments, reports |

## Forgot a password
- Staff: ask an administrator to reset it under **Users & roles, Edit**.
- Administrator locked out: stop nothing, open a terminal in the project folder and run
  `node src/reset-password.js admin NewPassword123` (use the real username and a new password of 8+ characters).

## Where things are
- `data/kalro.db`: the whole database (one file, copy it to back up). `data/secret.key`: login signing key. Keep both private.
- `src/`: server (API, rules, billing). `public/`: the screens.
- Room list, rates and amenities are set in `src/seed.js` (first run only); afterwards rates change in the app.

## Before real use
- Change all four default passwords; disable accounts you don't need.
- Run it on one office computer or server, and back up `data/` regularly.
- For access over the internet put it behind HTTPS (e.g. a reverse proxy); don't expose port 3000 directly.

## Learn how it works
See `LEARN.md` for a guided walkthrough, and `tests/` for runnable examples of every rule.
