'use strict';
/* ---------------- events & seminars ---------------- */
let EVENTS_CACHE = [];
const eventCard = (e) => html`<div class="card click" data-act="event" data-id="${e.id}">
  <div style="display:flex;gap:8px;align-items:start"><h3 style="flex:1">${e.name}</h3>
    ${e.phase === 'active' ? html`<span class="chip st-checked_in">Running</span>` : e.phase === 'upcoming' ? html`<span class="chip st-confirmed">Upcoming</span>` : e.phase === 'cancelled' ? html`<span class="chip st-cancelled">Cancelled</span>` : html`<span class="chip">Finished</span>`}</div>
  <div class="meta"><span>${fdate(e.start_date)} to ${fdate(e.end_date)}</span><span>${e.venue || 'Venue not set'}</span></div>
  ${e.phase === 'active' ? html`<div><div class="progress"><i style="width:${(e.day / e.total_days) * 100}%"></i></div><span class="small muted">Day ${e.day} of ${e.total_days}</span></div>` : ''}
  <div class="meta"><span><b>${e.participants}</b> participants</span><span><b>${e.rooms_booked}</b> rooms booked for ${e.pax_booked} guests</span></div>
  ${e.organiser ? html`<span class="small muted">Organised by ${e.organiser}</span>` : ''}</div>`;

PAGES.events = {
  roles: ALL,
  async render(host) {
    const list = await get('/events');
    EVENTS_CACHE = list;
    const grp = (p) => list.filter((e) => e.phase === p).sort((a, b) => (p === 'past' ? b.start_date.localeCompare(a.start_date) : a.start_date.localeCompare(b.start_date)));
    const sec = (title, arr) => arr.length ? html`<h2 class="section-title">${title}</h2><div class="cards">${arr.map(eventCard)}</div>` : '';
    mount(host, html`
      ${pageHead('Events & seminars', 'Workshops, seminars and trainings that bring guests to the lodge.', can(...FRONT) ? html`<button class="btn primary" data-act="new-event">${icon('plus', 16)} New event</button>` : '')}
      ${list.length ? html`${sec('Running now', grp('active'))}${sec('Upcoming', grp('upcoming'))}${sec('Finished', grp('past'))}${sec('Cancelled', grp('cancelled'))}`
        : html`<section class="panel">${empty('No events yet', 'Create an event, then link guest bookings to it.')}</section>`}`);
  },
};

async function eventForm(e) {
  const { amenities } = await get('/amenities');
  const venues = amenities.filter((a) => a.kind === 'Conference' || a.kind === 'Dining' || a.kind === 'Lounge');
  const T = todayISO();
  openModal(e ? 'Edit event' : 'New event', html`
    ${field('Event name', html`<input type="text" name="name" required maxlength="200" value="${e ? e.name : ''}" placeholder="For example: Dairy Goat Breeding Workshop">`)}
    <div class="row">${field('Starts', html`<input type="date" name="start_date" required value="${e ? e.start_date : T}">`)}
      ${field('Ends', html`<input type="date" name="end_date" required value="${e ? e.end_date : T}">`)}
      ${field('Participants', html`<input type="number" name="participants" min="0" max="2000" value="${e ? e.participants : 20}">`)}</div>
    <div class="row">${field('Venue', html`<input type="text" name="venue" list="venues" maxlength="120" value="${e ? e.venue || '' : ''}"><datalist id="venues">${venues.map((v) => html`<option value="${v.name}">`)}</datalist>`)}
      ${field('Organised by', html`<input type="text" name="organiser" maxlength="120" value="${e ? e.organiser || '' : ''}" placeholder="Unit or department">`)}</div>
    ${field('Notes', html`<textarea name="notes" maxlength="500">${e ? e.notes || '' : ''}</textarea>`)}
    ${e ? field('Status', html`<select name="status">${[['planned', 'Planned'], ['done', 'Finished'], ['cancelled', 'Cancelled']].map(([v, l]) => html`<option value="${v}" ${e.status === v ? 'selected' : ''}>${l}</option>`)}</select>`) : ''}`,
    { submit: e ? 'Save changes' : 'Create event',
      onSubmit: async (fd) => {
        const body = Object.fromEntries(fd.entries());
        if (e) await patch(`/events/${e.id}`, body); else await post('/events', body);
        closeModal(); toast(e ? 'Event updated' : 'Event created'); refresh();
      } });
}
ACTIONS['new-event'] = () => eventForm(null);
ACTIONS['edit-event'] = ({ id }) => eventForm(EVENTS_CACHE.find((e) => String(e.id) === String(id)));
ACTIONS.event = async ({ id }) => {
  const e = EVENTS_CACHE.find((x) => String(x.id) === String(id));
  const bks = (await get('/bookings' + qs({ event_id: id }))).filter((b) => !['cancelled', 'no_show'].includes(b.status));
  openModal(e.name, html`
    <dl class="dl"><dt>Dates</dt><dd>${fdateY(e.start_date)} to ${fdateY(e.end_date)} (${e.total_days} day${e.total_days === 1 ? '' : 's'})</dd>
      <dt>Venue</dt><dd>${e.venue || 'Not set'}</dd><dt>Participants</dt><dd>${e.participants}</dd>
      ${e.organiser ? html`<dt>Organised by</dt><dd>${e.organiser}</dd>` : ''}${e.notes ? html`<dt>Notes</dt><dd>${e.notes}</dd>` : ''}</dl>
    <div><h3 style="margin-bottom:8px">Rooms booked for this event (${bks.length})</h3>
      ${bks.length ? html`<div class="table-wrap" style="border:1px solid var(--line);border-radius:8px"><table><tbody>${bks.map((b) => html`<tr class="click" data-act="booking" data-id="${b.id}">
        <td><b>${b.guest_name}</b><span class="sub">${b.organisation || ''}</span></td><td>Room ${b.room_number}</td>
        <td class="nowrap">${fdate(b.check_in)} to ${fdate(b.check_out)}</td><td>${chip(b.status)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="muted">No rooms are linked to this event yet.</div>`}</div>`,
    { footer: html`<footer><button type="button" class="btn" data-act="close-modal">Close</button>
      ${can(...FRONT) ? html`<button type="button" class="btn" data-act="edit-event" data-id="${e.id}">Edit event</button>
      <button type="button" class="btn primary" data-act="book-for-event" data-id="${e.id}">Book a room for this event</button>` : ''}</footer>`, wide: true });
};
ACTIONS['book-for-event'] = ({ id }) => {
  const e = EVENTS_CACHE.find((x) => String(x.id) === String(id));
  const ci = e.start_date > todayISO() ? e.start_date : todayISO();
  bookingForm({ event_id: e.id, check_in: ci, check_out: e.end_date > ci ? e.end_date : addDays(ci, 1) });
};

/* ---------------- lounge & amenities ---------------- */
const amUI = { date: todayISO() };
PAGES.amenities = {
  roles: ALL,
  async render(host) {
    const { date, amenities } = await get('/amenities' + qs({ date: amUI.date }));
    window.AMENITIES = amenities;
    mount(host, html`
      ${pageHead('Lounge & amenities', 'Conference halls, lounges, dining and guest services in the Resource Centre and rooms block.')}
      <div class="toolbar">
        <button class="btn" data-act="am-day" data-d="-1" aria-label="Previous day">Previous day</button>
        <label class="field"><span>Showing reservations for</span><input type="date" id="am-date" value="${date}"></label>
        <button class="btn" data-act="am-day" data-d="1" aria-label="Next day">Next day</button>
        ${date !== todayISO() ? html`<button class="btn" data-act="am-day" data-d="0">Today</button>` : ''}
      </div>
      <div class="cards">${amenities.map((a) => html`<div class="card">
        <div style="display:flex;gap:8px;align-items:start"><h3 style="flex:1">${a.name}</h3><span class="chip cat">${a.kind}</span></div>
        <div class="meta"><span>${a.location}</span>${a.capacity ? html`<span>Holds ${a.capacity}</span>` : ''}<span>${a.rate ? `${kes(a.rate)} ${a.rate_unit}` : a.rate_unit}</span></div>
        <div style="display:grid;gap:6px;margin-top:4px">
          ${a.reservations.length ? a.reservations.map((r) => html`<div class="slot"><b>${r.start_time} to ${r.end_time}</b><span>${r.reserved_for}${r.pax ? `, ${r.pax} people` : ''}</span>
            ${can(...FRONT) ? html`<button class="icon-btn x" data-act="cancel-res" data-id="${r.id}" title="Cancel reservation" aria-label="Cancel reservation">${icon('x', 15)}</button>` : ''}</div>`)
            : html`<span class="small muted">Free all day on ${fdate(date)}</span>`}</div>
        <div style="display:flex;gap:8px;margin-top:6px">
          ${can(...FRONT) && a.kind !== 'Service' ? html`<button class="btn sm primary" data-act="reserve" data-id="${a.id}">Reserve</button>` : ''}
          ${can(...BOSS) ? html`<button class="btn sm" data-act="edit-rate" data-id="${a.id}">Change rate</button>` : ''}</div></div>`)}</div>`);
    $('#am-date').addEventListener('change', (e) => { if (e.target.value) { amUI.date = e.target.value; refresh(); } });
  },
};
ACTIONS['am-day'] = ({ d }) => { amUI.date = d === '0' ? todayISO() : addDays(amUI.date, Number(d)); refresh(); };
ACTIONS.reserve = async ({ id }) => {
  const a = window.AMENITIES.find((x) => String(x.id) === String(id));
  const events = (await get('/events')).filter((e) => e.phase === 'active' || e.phase === 'upcoming');
  openModal(`Reserve: ${a.name}`, html`
    ${a.capacity ? html`<div class="notice">Holds up to ${a.capacity} people.</div>` : ''}
    ${field('Reserved for', html`<input type="text" name="reserved_for" required maxlength="200" placeholder="Group, unit or person">`)}
    <div class="row">${field('Date', html`<input type="date" name="on_date" value="${amUI.date}" required>`)}
      ${field('From', html`<input type="time" name="start_time" value="09:00" required>`)}
      ${field('Until', html`<input type="time" name="end_time" value="17:00" required>`)}
      ${field('People', html`<input type="number" name="pax" min="1" ${a.capacity ? html`max="${a.capacity}"` : ''}>`)}</div>
    ${field('Linked event', html`<select name="event_id"><option value="">None</option>${events.map((e) => html`<option value="${e.id}">${e.name}</option>`)}</select>`)}`,
    { submit: 'Reserve',
      onSubmit: async (fd) => { await post(`/amenities/${a.id}/reserve`, Object.fromEntries(fd.entries())); closeModal(); toast('Reservation saved'); refresh(); } });
};
ACTIONS['cancel-res'] = ({ id }) => confirmBox('Cancel this reservation?', 'The time slot becomes free again.', 'Cancel reservation',
  async () => { await del(`/reservations/${id}`); toast('Reservation cancelled'); refresh(); }, true);
ACTIONS['edit-rate'] = ({ id }) => {
  const a = window.AMENITIES.find((x) => String(x.id) === String(id));
  openModal(`Rate for ${a.name}`, field(`Rate in KES (${a.rate_unit})`, html`<input type="number" name="rate" min="0" step="100" value="${a.rate}" required>`),
    { submit: 'Save rate', onSubmit: async (fd) => { await patch(`/amenities/${a.id}`, { rate: fd.get('rate') }); closeModal(); toast('Rate updated'); refresh(); } });
};
