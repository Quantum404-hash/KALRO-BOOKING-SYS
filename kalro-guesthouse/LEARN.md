# Understanding the KALRO Guesthouse code

Goal: after this you can explain every part, change it safely, and rebuild it yourself.
Read in order. Open the file beside each section. Line numbers drift as the code changes, so search for the function name.

---

## 1. The big picture

```
Browser (public/*.js)  --HTTP + JSON-->  Server (src/server.js)  --SQL-->  SQLite file (data/kalro.db)
   draws the screens                      checks login + rules               stores everything
```

- The **browser** only shows things and sends requests. It is never trusted.
- The **server** is where the rules live: who may do what, no double-booking, billing maths.
- The **database** is one file. Copy it to back up.

Golden rule: **hiding a button in the browser is cosmetic. The server must enforce every rule.** That is why roles are checked in `server.js`, not only in the screens.

| File | Job |
|---|---|
| `src/db.js` | Creates tables, small helpers (`q`, `tx`, `audit`, date helpers) |
| `src/auth.js` | Password hashing, login tokens, login throttling |
| `src/billing.js` | Invoice maths: totals, running vs due |
| `src/seed.js` | First-run rooms, users, amenities, sample data |
| `src/server.js` | The web server: routes (URLs), rules, JSON in/out, serving `public/` |
| `public/core.js` | Frontend toolkit: `html` templates, `api()`, modal, router, login |
| `public/dashboard.js` ... `admin.js` | One file per area of screens |

---

## 2. Follow ONE click: "Check in"

This one trace touches almost every idea. Do it with your browser's DevTools open (F12, Network tab).

1. **Button** (`public/dashboard.js`, `arrivalRow`): `<button data-act="checkin" data-id="5">`. No click handler is attached to it directly.
2. **Event delegation** (`public/core.js`, search `document.addEventListener('click'`): one listener on the whole page finds the nearest element with `data-act`, then runs `ACTIONS['checkin']`. Why? Screens get redrawn constantly; one listener on `document` survives redraws, hundreds of per-button listeners would not.
3. **Action** (`public/dashboard.js`, `ACTIONS.checkin`): calls `post('/bookings/5/checkin')`, then shows a toast and redraws with `refresh()`.
4. **`api()`** (`public/core.js`): uses `fetch`, adds the header `Authorization: Bearer <token>`, turns the reply into JSON, throws an `Error` if the status is not OK.
5. **Server entry** (`src/server.js`, search `http.createServer`): finds the matching route with a regular expression, pulls `:id` out of the URL, then checks the **role** (`FRONT` = admin, manager, reception). Wrong role gives 403. No valid token gives 401.
6. **Handler** (`route('POST', '/api/bookings/:id/checkin'`): validates (is it pending/confirmed? is the room in service? is the arrival date today?), then inside `tx(...)`: checks nobody is still in the room, sets `status='checked_in'`, creates the invoice via `billing.ensureInvoice`, writes the audit log.
7. **Reply** goes back as JSON and the screen redraws from fresh data.

Exercise: in the Network tab find the request, read its headers and response. Then try the same URL with a bad token (copy as cURL and edit it) and watch the 401.

---

## 3. The database (`src/db.js`)

Read the `CREATE TABLE` statements. Things to notice:

- **Relationships**: `bookings.guest_id -> guests.id`, `bookings.room_id -> rooms.id`, `invoices.booking_id -> bookings.id`. `PRAGMA foreign_keys = ON` makes the database refuse a booking for a room that does not exist.
- **`CHECK (status IN (...))`**: the database itself rejects invalid statuses, a second safety net behind the server's validation.
- **Dates are text `YYYY-MM-DD`**. That format sorts correctly as text, so `check_in < ?` works with plain string comparison. Times use `HH:MM`.
- **Money is whole shillings (integers)**. Never store money as floating point, because `0.1 + 0.2` is not `0.3` in computers. Kenyan shilling prices here have no cents, so integers are exact.
- **Totals are not stored.** `invoiceTotals()` in `billing.js` adds up the lines and payments each time. One source of truth, so totals can never disagree with lines.

### The most important query: double-booking (`findConflict` in `server.js`)

```sql
... WHERE room_id = ? AND status IN ('pending','confirmed','checked_in')
      AND check_in < :newCheckOut AND check_out > :newCheckIn
```

Two stays overlap exactly when each one starts before the other ends. Check-out day is **not** a night stayed, so a guest leaving on the 10th and another arriving on the 10th is fine. Draw two timelines on paper and convince yourself.

### Transactions (`tx` in `db.js`)

`BEGIN IMMEDIATE ... COMMIT` makes "check for a clash, then insert" one unbreakable step. Without it, two receptionists clicking at the same moment could both pass the check and both book the room. If anything throws inside `tx`, everything is rolled back.

---

## 4. Login and security (`src/auth.js`)

- **Passwords are never stored.** We store `scrypt(password + salt)`. The **salt** is random per user, so two people with the same password get different hashes. `scrypt` is deliberately slow, which makes guessing expensive.
- **Token**: after login the server sends `base64(payload).signature`. The signature is an HMAC with a secret only the server knows (`data/secret.key`). Change one character of the payload and the signature no longer matches, so users cannot make themselves admin. This is the idea behind JWT, built by hand.
- **`timingSafeEqual`**: compares in constant time so an attacker cannot learn a hash byte by byte from response times.
- **Throttle**: 8 failed logins per 10 minutes per user+IP.
- **SQL injection**: every query uses `?` placeholders (`q.get('... WHERE id = ?', id)`), never string-joined input. The test script tries `' OR 1=1 --` as a search.
- **XSS** (a guest named `<script>...`): the `html` tagged template in `core.js` escapes every inserted value with `esc()` unless you explicitly wrap it with `raw()`. Look at how `html\`...\`` works; it is only ~5 lines and worth understanding.

---

## 5. The frontend pattern (`public/core.js`)

No framework, so the pattern is visible:

1. `PAGES.name = { roles, render(host) }`: each page fetches data, then calls `mount(host, html\`...\`)`.
2. `html\`...\`` is a **tagged template**: JavaScript calls your function with the text pieces and the inserted values, so we can escape the values.
3. `route()` reads `location.hash` (`#/bookings`), checks the role, calls that page's `render`.
4. `refresh()` just re-runs the current page's `render`. Simple and always correct, at the cost of redrawing everything.
5. `openModal()` builds the dialog, wires submit, shows server errors inside it.

Compare with React: React keeps the screen in sync with state automatically and only changes what differs. Here we redraw by hand. You will feel exactly why frameworks exist after writing the booking form (`public/bookings.js`, `bookingForm`).

---

## 6. Business rules in plain words (all enforced in `server.js`)

- No overlapping bookings for one room; no booking a room that is in maintenance.
- Reception cannot change rates or book in the past; managers/admin can.
- Check-in needs the arrival date to be today (unless manager/admin) and the room to be empty.
- Early check-out cuts the stay to the nights actually used and re-prices the invoice.
- Guests pay after the stay: a bill is **running** while the guest is in house and **due** after check-out. Payments need a reference (ERP code), and a code cannot be reused.
- Every important change writes to `audit_log`.

---

## 7. The tests (`tests/`)

They are plain scripts that call the API like a browser would and print PASS/FAIL. Run them against a **fresh** database:

```
npm run reset-demo        # in one terminal (starts the server fresh; stop it with Ctrl+C when done)
# the tests expect port 3111, so start with PORT=3111, e.g. (Windows PowerShell)  $env:PORT=3111; npm run reset-demo
node tests/api.test.mjs
```

Read `tests/api.test.mjs` top to bottom. It is the best summary of what the rules are, written as examples. Notice the tests for *rejected* actions (overlap, wrong role, overpayment). Good tests check what must NOT work.

---

## 8. Exercises (do them in this order)

1. **Change a rule**: make reception unable to cancel bookings. Find `route('POST', '/api/bookings/:id/cancel'` and change its roles. Run the app as `reception` and see the server answer 403 even though the button still shows. Then hide the button too (`bookings.js`, `can(...)`).
2. **Add a field**: add "vehicle registration" to bookings. Touch four places: `CREATE TABLE` (and think about existing databases: you need `ALTER TABLE`), the `POST/PATCH` handlers, `bookingForm`, the booking detail modal.
3. **Write a test first**: write a test that a guest cannot check in to a room whose previous guest has not checked out, then confirm it passes.
4. **New report**: "Top 5 longest stays this month" as a new endpoint and a small table.
5. **Break it on purpose**: remove `BEGIN IMMEDIATE` from `tx` and try to double-book with two quick requests (`Promise.all` in a script). Seeing the bug teaches why the line exists.
6. **Port one piece**: rewrite just the room map (`buildingMap`) as a React component that calls the same API. That is the migration path if you ever move to React.

---

## 9. Where I would be careful (honest risks)

- Default passwords must be changed before real use.
- It has been tested with scripts and in a headless browser, not by real front-desk staff. Expect small gaps (for example group bookings of many rooms, meal pricing).
- `node:sqlite` is still marked experimental in Node. It works, but pin your Node version and back up `data/`.
- Run behind HTTPS if it is ever reachable beyond the office network.
