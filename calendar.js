// Calendars: who is working where, site visits, follow-ups, personal life,
// storms and anything else with a date -- each in its own colour, with one
// view that lays all of it on top of each other.
//
// TWO KINDS OF LAYER, and the difference matters.
//
// STORED calendars live in calendars/{id} with their events in
// calendars/{id}/events. Personal, Work schedule, Site visits, Follow-ups, and
// any the owner adds. Each carries a visibleTo list of crew uids, and the
// security rules let a crew member read a calendar only when listed -- which is
// what makes "the calendars I set specific guys to see" real rather than a
// hidden button. Only the owner writes events.
//
// WORKED-OUT layers are never stored. Storm nights come from the storms
// themselves, equipment service dates from the equipment records, and due
// dates from board cards. Copying them into a calendar would mean the same
// fact in two places, and the copy would be wrong the first time a storm was
// abandoned or a service logged. Reading them where they already live means
// the calendar cannot disagree with the rest of the app.
//
// DATES ARE LOCAL CALENDAR DAYS, written YYYY-MM-DD, never toISOString(). An
// evening event converted through UTC lands on the next day -- the same bug
// that once filed 9 pm storms under tomorrow.

(function () {
  'use strict';

  // Fixed ids, so two devices seeding at the same moment write the same four
  // calendars rather than eight.
  const SEED = [
    { id: 'schedule', name: 'Work schedule', color: '#2f6fd6', kind: 'schedule', order: 1,
      about: 'Who is working which job on which day' },
    { id: 'visits', name: 'Site visits', color: '#1a9c8c', kind: 'visits', order: 2,
      about: 'Estimates and walk-throughs' },
    { id: 'followups', name: 'Follow-ups', color: '#e07b24', kind: 'followups', order: 3,
      about: 'Calls to make and things to chase' },
    { id: 'personal', name: 'Personal', color: '#d94f8a', kind: 'personal', order: 4,
      about: 'Yours only' },
  ];

  // How long before an entry its phone reminder pops up, in minutes. For an
  // all-day entry the time counts back from 7 am that day.
  const REMIND = [
    [null, 'No reminder'], [0, 'At the time'], [10, '10 minutes before'], [30, '30 minutes before'],
    [60, '1 hour before'], [120, '2 hours before'], [1440, 'The day before'], [2880, 'Two days before'],
  ];
  function remindWords(ev) {
    if (!ev.hasReminder || ev.remindMins == null) return '';
    const hit = REMIND.find(r => r[0] === ev.remindMins);
    return hit ? hit[1] : ev.remindMins + ' minutes before';
  }

  const AUTO = {
    'auto:storms': { id: 'auto:storms', name: 'Storm nights', color: '#3fb6d8', auto: true,
                     about: 'From the Snow tab' },
    'auto:equipment': { id: 'auto:equipment', name: 'Equipment due', color: '#8a6d3b', auto: true,
                        ownerOnly: true, about: 'Service dates from the Equipment tab' },
    'auto:cards': { id: 'auto:cards', name: 'Board due dates', color: '#6b7a8f', auto: true,
                    about: 'Cards with a due date' },
    // Jonah (7 Oct): the crew's recurring tasks on the calendar, every week
    // ahead -- worked out from the list on the Crew tasks board
    // (recurring.js), never copied in.
    'auto:recurring': { id: 'auto:recurring', name: 'Crew tasks', color: '#2a9d8f', auto: true,
                        about: 'Recurring crew tasks, from the Crew tasks board' },
  };

  const PALETTE = ['#2f6fd6', '#1a9c8c', '#2f8f5b', '#8bb22a', '#e0a526',
                   '#e07b24', '#d64545', '#d94f8a', '#8e5bc7', '#66418f', '#6b7a8f'];
  const REPEAT = { none: 'Does not repeat', weekly: 'Every week', biweekly: 'Every 2 weeks',
                   monthly: 'Every month', yearly: 'Every year' };
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ------------------------------------------------------------------- views
  //
  // Jonah (5 Oct 2026): "I want the calendar to have more of a google calendar
  // layout." So it is laid out the way Google Calendar is: Day, 3 days and Week
  // are a time grid (hours down the side, each entry a block as long as it
  // lasts, all-day entries in a strip along the top, a red line at now); Month
  // is a grid of chips; List runs down the next two months. The calendars sit
  // down the left with a tick box each and a small month to jump about -- on a
  // phone, behind the ☰ button. Tap an empty hour to add something there; drag
  // an entry to move it, or its bottom edge to change how long it runs. A phone
  // opens in 3 days (his answer, 6 Oct), and a swipe moves along.
  const VIEWS = [['day', 'Day'], ['3day', '3 days'], ['week', 'Week'], ['month', 'Month'], ['schedule', 'List']];
  const HOUR = 48;          // pixels an hour takes in the time grid
  const SNAP = 15;          // minutes a dragged entry moves by

  // ------------------------------------------------------------------- state

  let cals = {};            // stored calendars
  let events = {};          // calId -> { eventId -> event }
  let storms = {};
  let people = {};          // owner only
  let unsubCals = null, unsubStorms = null, unsubPeople = null;
  let eventUnsubs = {};
  let seeded = false;

  let view = loadView();    // one of VIEWS (null until the first draw picks one)
  let cursor = '';          // the day the view is on (set on first draw)
  let selected = '';        // the day picked in month view
  let miniMonth = '';       // the month the small calendar shows, YYYY-MM-01
  let sideOpen = false;     // phone: the calendars list is open
  let hidden = loadHidden();// layer ids switched off
  let onlyMine = false;
  let editing = null;       // { calId, eventId, occ, date, time } in the editor
  let lastCal = null;       // calendar last added to, offered first next time
  let drawn = {};           // key -> the occurrence drawn with that key
  let shown = null;         // the occurrence open in the details window
  let pending = null;       // waiting for "this date / the ones after / every date"
  let drag = null;          // an entry being dragged
  let justDragged = 0;      // a drag ends in a click; that click opens nothing
  let gridScroll = null;     // where the hours were scrolled to (null: not yet)

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const isPhone = () => window.matchMedia('(max-width:720px)').matches;
  // An admin given Calendars sees every calendar except the owner's own ones
  // (ownerOnly: Personal, and any other the owner marks private) -- and with
  // "change" adds and edits events on them. Making, sharing and deleting
  // calendars stays the owner's.
  const seesAllCals = () => ydCan('calendars', 'see');
  const editsCal = cal => !!cal && (isOwner() || (ydCan('calendars', 'change') && cal.ownerOnly === false));
  const editableCals = () => storedCals().filter(editsCal);
  const adds = () => isOwner() || ydCan('calendars', 'change');
  const two = n => String(n).padStart(2, '0');
  const nowIso = () => new Date().toISOString();
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const isRepeating = ev => !!ev && (ev.repeat || 'none') !== 'none';
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const snap = m => Math.round(m / SNAP) * SNAP;

  function loadView() {
    try {
      const v = localStorage.getItem('ydjobhub_calView');
      return VIEWS.some(x => x[0] === v) ? v : null;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ dates

  function dayOf(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  function today() { return dayOf(new Date()); }
  function parseDay(s) { return new Date(s + 'T00:00:00'); }
  function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return dayOf(d); }
  function addMonths(s, n) {
    const d = parseDay(s);
    const want = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(want, last));
    return dayOf(d);
  }
  function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 864e5); }
  function weekStart(s) { const d = parseDay(s); d.setDate(d.getDate() - d.getDay()); return dayOf(d); }
  function longDay(s) {
    return parseDay(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function shortDay(s) {
    return parseDay(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function monthTitle(s) {
    return parseDay(s).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  function fmtTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    if (!isFinite(h)) return '';
    const ap = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    return h12 + (m ? ':' + two(m) : '') + ap;
  }
  // Minutes after midnight <-> "HH:MM". Midnight at the END of a day is
  // written 23:59: a time field has no 24:00.
  function hhmm(m) { m = clamp(Math.round(m), 0, 1439); return two(Math.floor(m / 60)) + ':' + two(m % 60); }
  function minutesOf(t) { const m = /^(\d{2}):(\d{2})$/.exec(to24(t)); return m ? +m[1] * 60 + +m[2] : null; }
  function fmtMin(m) { return m >= 1440 ? '12am' : fmtTime(hhmm(m)); }
  function hourLabel(h) { return h === 12 ? '12 PM' : h < 12 ? h + ' AM' : (h - 12) + ' PM'; }

  // ---------------------------------------------------------------- layers

  function storedCals() {
    return Object.values(cals).sort((a, b) => (a.order || 0) - (b.order || 0) ||
      String(a.name || '').localeCompare(b.name || ''));
  }
  function layers() {
    const auto = Object.values(AUTO).filter(l => (!l.ownerOnly || ydCan('equipment', 'see')) &&
      (l.id !== 'auto:recurring' || (window.YDRecurring && YDRecurring.visible())));
    return storedCals().concat(auto);
  }
  function layerOf(id) { return cals[id] || AUTO[id] || null; }

  function loadHidden() {
    try { return new Set(JSON.parse(localStorage.getItem('ydjobhub_calHidden') || '[]')); }
    catch (e) { return new Set(); }
  }
  function saveHidden() {
    try { localStorage.setItem('ydjobhub_calHidden', JSON.stringify(Array.from(hidden))); } catch (e) {}
  }

  // Every occurrence of everything between two days, inclusive, as flat
  // entries ready to draw: { day, layer, title, time, ev, ... }. `ev` is the
  // entry as it is on that date (its own date, or what was changed for it);
  // `orig` is the date a repeat fell on, which names its single-date change.
  function occurrences(from, to) {
    const out = [];
    const uid = me() && me().uid;

    Object.keys(events).forEach(cid => {
      const cal = cals[cid];
      if (!cal || hidden.has(cid)) return;
      Object.values(events[cid]).forEach(base => {
        occurrencesOf(base, from, to).forEach(x => {
          const ev = x.ev;
          if (onlyMine && !isMine(ev, cal, uid)) return;
          out.push({
            day: x.day, layer: cal, ev: ev, calId: cid, id: base.id, orig: x.orig,
            title: ev.title || (ev.jobName ? ev.jobName : 'Untitled'),
            time: ev.allDay ? '' : ev.time, endTime: ev.allDay ? '' : ev.endTime,
            crew: ev.crew || [], address: ev.address || '', jobName: ev.jobName || '',
            multi: !!(ev.endDate && ev.endDate > ev.date), changed: x.changed,
          });
        });
      });
    });

    if (!hidden.has('auto:storms') && !onlyMine) {
      Object.values(storms).forEach(s => {
        if (!s.startedAt || s.status === 'abandoned') return;
        const day = dayOf(new Date(s.startedAt));
        if (day < from || day > to) return;
        out.push({ day: day, layer: AUTO['auto:storms'], auto: 'storm', id: s.id,
          title: '❄️ ' + (s.label ? 'Storm — ' + s.label : 'Storm'),
          time: fmtClock(s.startedAt), note: s.status === 'closed' ? 'Finished' : 'In progress' });
      });
    }

    if (ydCan('equipment', 'see') && !hidden.has('auto:equipment') && !onlyMine && window.YDEquipment) {
      Object.values(YDEquipment.all()).forEach(g => {
        if (!g.dueDate || g.dueDate < from || g.dueDate > to) return;
        out.push({ day: g.dueDate, layer: AUTO['auto:equipment'], auto: 'equipment', id: g.id,
          title: '🚜 ' + (g.name || 'Machine') + ' service due' });
      });
    }

    if (!hidden.has('auto:cards') && window.YDBoards) {
      YDBoards.dueCards().forEach(x => {
        if (x.card.due < from || x.card.due > to) return;
        // A Maintenance card is the machine's own due date, which the
        // Equipment layer already shows -- listing both put it on the day twice.
        if (x.card.auto && x.card.equipmentId && ydCan('equipment', 'see')) return;
        // A recurring task's card is drawn by the Crew tasks layer below.
        if (x.card.recurring && window.YDRecurring && YDRecurring.visible()) return;
        if (onlyMine && !(x.card.assignees || []).some(a => a.uid === uid)) return;
        out.push({ day: x.card.due, layer: Object.assign({}, AUTO['auto:cards'], { color: x.board.color }),
          // A card with a time sits at that hour (an hour long); without one,
          // with the day's all-day entries.
          time: /^\d{2}:\d{2}$/.test(x.card.dueTime || '') ? x.card.dueTime : '',
          auto: 'card', id: x.card.id, boardId: x.board.id, done: x.done,
          title: '📌 ' + (x.card.title || 'Card'), note: x.board.name,
          crew: x.card.assignees || [] });
      });
    }

    if (!hidden.has('auto:recurring') && window.YDRecurring && YDRecurring.visible()) {
      YDRecurring.dues(from, to).forEach(x => {
        out.push({ day: x.day, layer: AUTO['auto:recurring'], auto: 'recurring', id: x.cardId, boardId: 'crew',
          done: x.done, title: '🔁 ' + x.what, note: 'Crew tasks' });
      });
    }

    // All-day first, then by time, then by calendar, so a day reads top to
    // bottom in the order it will actually happen.
    out.sort((a, b) => a.day.localeCompare(b.day) ||
      (a.time ? 1 : 0) - (b.time ? 1 : 0) ||
      String(to24(a.time)).localeCompare(String(to24(b.time))) ||
      String(a.layer.name).localeCompare(b.layer.name));
    return out;
  }

  // Storm times come from a timestamp, event times from an "HH:MM" field; both
  // sort as 24-hour text.
  function to24(t) {
    if (!t) return '';
    if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, '0');
    const m = String(t).match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
    if (!m) return t;
    let h = +m[1] % 12; if (m[3] === 'pm') h += 12;
    return two(h) + ':' + (m[2] || '00');
  }
  function fmtClock(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : fmtTime(two(d.getHours()) + ':' + two(d.getMinutes()));
  }

  function isMine(ev, cal, uid) {
    if (!uid) return false;
    if ((ev.crew || []).some(c => c.uid === uid)) return true;
    // For the owner, their own personal calendar is "theirs" too.
    return isOwner() && cal.kind === 'personal';
  }

  // The days each repeat of an event starts on, up to `to`.
  function startsOf(ev, from, to) {
    if (!ev.date) return [];
    const rep = ev.repeat || 'none';
    if (rep === 'none') return ev.date <= to ? [ev.date] : [];
    const starts = [];
    const until = ev.repeatUntil || to;
    // Monthly and yearly repeats are counted from the original date each
    // time, so an event on the 31st lands on the last day of short months
    // and then returns to the 31st, rather than drifting to the 28th forever.
    const step = rep === 'weekly' ? 7 : rep === 'biweekly' ? 14 : 0;
    const months = rep === 'monthly' ? 1 : rep === 'yearly' ? 12 : 0;
    let d = ev.date, k = 0, guard = 0;
    // Skip ahead cheaply for weekly repeats that began long ago.
    if (step && d < from) {
      const jumps = Math.floor(daysBetween(d, from) / step) - 1;
      if (jumps > 0) { k = jumps; d = addDays(ev.date, k * step); }
    }
    while (d <= to && d <= until && guard++ < 1000) {
      starts.push(d);
      k++;
      d = step ? addDays(ev.date, k * step) : months ? addMonths(ev.date, k * months) : '9999';
    }
    return starts;
  }
  const spanOf = ev => (ev.endDate && ev.endDate > ev.date ? daysBetween(ev.date, ev.endDate) : 0);
  // Every day an event covers within [from, to], with the day its repeat
  // started -- multi-day events land on each of their days.
  function expand(ev, from, to) {
    const span = spanOf(ev), out = [];
    startsOf(ev, addDays(from, -span), to).forEach(s => {
      for (let i = 0; i <= span; i++) {
        const day = i ? addDays(s, i) : s;
        if (day >= from && day <= to) out.push({ day: day, start: s });
      }
    });
    return out;
  }

  // A repeating entry's single dates can be changed or cancelled on their
  // own (Google's "This event"), kept on the entry itself:
  //   exceptions: { 'YYYY-MM-DD' (the date the repeat fell on):
  //                 'cancelled' | { date, endDate, time, endTime, allDay,
  //                                 title, notes, address, crew, ... } }
  // null means none -- writes merge, so a date is cleared by writing null.
  // Before this, changing one Monday of a weekly job changed every Monday
  // (CLAUDE.md §4). The server reads them the same way (digest.py
  // _occurrences), so reminders and the summaries agree with this screen.
  function occurrencesOf(base, from, to) {
    const ex = (isRepeating(base) && base.exceptions) || {};
    const span = spanOf(base), copies = {};
    // Each repeat is the entry with its own dates, so anything drawing it
    // (overnight times, the details window) sees the right ones.
    const at = s => copies[s] || (copies[s] = s === base.date ? base
      : Object.assign({}, base, { date: s, endDate: span ? addDays(s, span) : null }));
    const out = [];
    expand(base, from, to).forEach(x => {
      if (!ex[x.start]) out.push({ day: x.day, orig: x.start, ev: at(x.start) });
    });
    Object.keys(ex).forEach(k => {
      const x = ex[k];
      if (!x || typeof x !== 'object') return;              // cancelled, or cleared
      if (startsOf(base, k, k).indexOf(k) === -1) return;    // no longer a date it falls on
      const one = Object.assign({}, base, x, { repeat: 'none', exceptions: null });
      one.date = x.date || k;
      expand(one, from, to).forEach(y => out.push({ day: y.day, orig: k, ev: one, changed: true }));
    });
    return out;
  }

  // ---------------------------------------------------------------- render

  const isGrid = () => view === 'day' || view === '3day' || view === 'week';
  function gridDays() {
    const first = view === 'week' ? weekStart(cursor) : cursor;
    const n = view === 'day' ? 1 : view === '3day' ? 3 : 7;
    const out = [];
    for (let i = 0; i < n; i++) out.push(addDays(first, i));
    return out;
  }
  // Every entry drawn gets a short key; a tap or a drag finds it by that.
  function keyOf(o) { const k = 'o' + Object.keys(drawn).length; drawn[k] = o; return k; }
  const movable = o => !o.auto && !!o.calId && editsCal(cals[o.calId]);

  function render() {
    const wrap = el('calWrap');
    if (!wrap) return;
    if (!me() || !window.YDDb) {
      // Before sign-in has finished this is the normal state for a second or
      // two, not an instruction -- saying "sign in" here sent a signed-in
      // person looking for a button that does not exist.
      const local = window.YDAuth && window.YDAuth.mode === 'local';
      wrap.innerHTML = '<p class="empty-msg">' + (local
        ? 'The calendar needs a connection. It will appear once Job Hub can reach the internet.'
        : 'Loading…') + '</p>';
      return;
    }
    if (drag && drag.live) return;      // not under someone's finger
    // A finger still holding (not yet dragging) would be left holding an
    // entry no longer on the page: it lets go instead.
    if (drag) stopDrag();
    if (!view) view = isPhone() ? '3day' : 'week';
    if (!cursor) { cursor = today(); selected = cursor; }
    if (!miniMonth) miniMonth = cursor.slice(0, 8) + '01';
    // Where the hours are scrolled to, read off the grid -- only one that
    // was on screen when it was placed: one drawn hidden reads 0, which is
    // not where it was.
    const old = wrap.querySelector('.cg-scroll');
    if (old && old.clientHeight && old.dataset.placed) gridScroll = old.scrollTop;
    drawn = {};
    wrap.innerHTML = '<div class="cal-shell">' +
        '<aside class="cal-side' + (sideOpen ? ' open' : '') + '">' + sideHtml() + '</aside>' +
        '<div class="cal-main">' + topHtml() +
          '<div class="cal-body" id="calBody">' +
            (view === 'month' ? monthHtml() : view === 'schedule' ? listHtml() : gridHtml(gridDays())) +
          '</div>' +
        '</div>' +
      '</div>';
    if (isGrid()) placeScroll();
    wireSlots();
  }

  function topHtml() {
    return '<div class="cal-top">' +
        '<div class="cal-nav">' +
          '<button class="btn btn-sm cal-side-btn" onclick="calSide()" aria-label="Calendars">☰</button>' +
          '<button class="btn btn-sm" onclick="calToday()">Today</button>' +
          '<button class="cal-arrow" onclick="calStep(-1)" aria-label="Back">‹</button>' +
          '<button class="cal-arrow" onclick="calStep(1)" aria-label="Forward">›</button>' +
          '<span class="cal-title">' + titleFor() + '</span>' +
        '</div>' +
        '<div class="cal-views">' +
          '<div class="cal-seg">' + VIEWS.map(([v, n]) => '<button class="cal-vbtn' + (view === v ? ' on' : '') +
            '" onclick="calView(\'' + v + '\')">' + n + '</button>').join('') + '</div>' +
          (adds() ? '<button class="btn btn-sm btn-accent cal-add" onclick="calAdd()">+ Add</button>' : '') +
        '</div>' +
      '</div>';
  }

  // Down the side: the small month, then every calendar with a tick box.
  function sideHtml() {
    return miniHtml() +
      '<div class="cal-side-head">Calendars</div>' +
      '<div class="cal-checks">' + layers().map(l =>
        '<label class="cal-check" style="--c:' + safeColor(l.color) + '" title="' + esc(l.about || '') + '">' +
          '<input type="checkbox"' + (hidden.has(l.id) ? '' : ' checked') + ' onchange="calSet(\'' + l.id + '\', this.checked)">' +
          '<span class="cal-box"></span><span class="cal-check-name">' + esc(l.name) + '</span>' +
          (isOwner() && !l.auto && (l.visibleTo || []).length ? '<span class="cal-shared">👥' + l.visibleTo.length + '</span>' : '') +
        '</label>').join('') +
        '<label class="cal-check mine"><input type="checkbox"' + (onlyMine ? ' checked' : '') + ' onchange="calOnlyMine()">' +
          '<span class="cal-box"></span><span class="cal-check-name">👤 Only what I’m on</span></label>' +
      '</div>' +
      '<div class="cal-side-links">' +
        (hidden.size || onlyMine ? '<button class="link-btn" onclick="calShowAll()">Show everything</button>' : '') +
        (isOwner() ? '<button class="link-btn" onclick="calManage()">⚙ Manage calendars</button>' : '') +
      '</div>';
  }

  function miniHtml() {
    const start = weekStart(miniMonth), month = miniMonth.slice(0, 7), t = today();
    const onView = new Set(isGrid() ? gridDays() : [cursor]);
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      cells += '<button class="cal-mini-d' + (d.slice(0, 7) !== month ? ' out' : '') + (d === t ? ' today' : '') +
        (onView.has(d) ? ' on' : '') + '" onclick="calGo(\'' + d + '\')">' + parseDay(d).getDate() + '</button>';
    }
    return '<div class="cal-mini">' +
        '<div class="cal-mini-top"><span>' + monthTitle(miniMonth) + '</span>' +
          '<button class="cal-arrow sm" onclick="calMini(-1)" aria-label="Previous month">‹</button>' +
          '<button class="cal-arrow sm" onclick="calMini(1)" aria-label="Next month">›</button></div>' +
        '<div class="cal-mini-grid">' + WEEKDAYS.map(w => '<span>' + w[0] + '</span>').join('') + cells + '</div>' +
      '</div>';
  }

  function titleFor() {
    if (view === 'month') return monthTitle(cursor);
    if (view === 'day') return parseDay(cursor).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (view === 'schedule') return 'From ' + parseDay(cursor).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const ds = gridDays(), a = parseDay(ds[0]), b = parseDay(ds[ds.length - 1]);
    return a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' +
      b.toLocaleDateString('en-US', a.getMonth() === b.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' }) +
      ', ' + b.getFullYear();
  }

  // ------------------------------------------------------------ time grid

  // Where a timed entry sits on its day, in minutes [start, end). An entry
  // with no end time takes an hour; one ending at 12:00 am ends at midnight.
  // Work past midnight (an end before the start, ending the next day) runs to
  // midnight on the first day and from midnight on the second -- and one
  // ending exactly at midnight has nothing on the second day ([0, 0]).
  function segOf(o) {
    if (!o.time) return null;
    let a = minutesOf(o.time);
    if (a == null) return null;
    let b = o.endTime ? minutesOf(o.endTime) : null;
    const e = o.ev;
    if (e && e.endDate && b != null && b <= a && daysBetween(e.date, e.endDate) === 1) {
      if (o.day === e.date) b = 1440; else { a = 0; if (b === 0) return [0, 0]; }
    }
    if (b === 0 && a > 0) b = 1440;
    if (b == null || b <= a) b = Math.min(1440, a + 60);
    return [a, b];
  }

  // Entries that overlap share the width, side by side: each run of
  // overlapping entries is split into as many columns as it needs.
  function layout(items) {
    items.sort((x, y) => x.a - y.a || y.b - x.b);
    let group = [], groupEnd = -1, ends = [];
    const close = () => { group.forEach(it => { it.n = ends.length; }); group = []; ends = []; groupEnd = -1; };
    items.forEach(it => {
      if (group.length && it.a >= groupEnd) close();
      let c = ends.findIndex(end => end <= it.a);
      if (c === -1) { c = ends.length; ends.push(it.b); } else ends[c] = it.b;
      it.col = c; group.push(it); groupEnd = Math.max(groupEnd, it.b);
    });
    close();
    return items;
  }

  const nowTop = () => { const d = new Date(); return Math.round((d.getHours() * 60 + d.getMinutes()) * HOUR / 60); };

  function gridHtml(days) {
    const occ = occurrences(days[0], days[days.length - 1]);
    const t = today();
    const head = '<div class="cg-row cg-head"><div class="cg-gut"></div>' + days.map(d => {
        const p = parseDay(d);
        return '<button class="cg-dh' + (d === t ? ' today' : d < t ? ' past' : '') + '" onclick="calGoDay(\'' + d + '\')">' +
          '<span class="cg-wd">' + WEEKDAYS[p.getDay()] + '</span><span class="cg-dn">' + p.getDate() + '</span></button>';
      }).join('') + '</div>';
    const allDay = '<div class="cg-row cg-all"><div class="cg-gut cg-all-l">all day</div>' + days.map(d =>
        '<div class="cg-allcell" data-day="' + d + '">' +
          occ.filter(o => o.day === d && !segOf(o)).map(chipHtml).join('') + '</div>').join('') + '</div>';
    let hours = '';
    for (let h = 1; h < 24; h++) hours += '<span style="top:' + h * HOUR + 'px">' + hourLabel(h) + '</span>';
    const cols = days.map(d => {
      const items = layout(occ.filter(o => o.day === d).map(o => {
        const s = segOf(o);
        return s && s[1] > s[0] && { o: o, a: s[0], b: s[1] };
      }).filter(Boolean));
      return '<div class="cg-col' + (d === t ? ' today' : '') + '" data-day="' + d + '">' +
        items.map(blockHtml).join('') +
        (d === t ? '<div class="cg-now" style="top:' + nowTop() + 'px"></div>' : '') +
      '</div>';
    }).join('');
    return '<div class="cg" style="--n:' + days.length + ';--h:' + HOUR + 'px">' +
      '<div class="cg-scroll">' +
        '<div class="cg-sticky">' + head + allDay + '</div>' +
        '<div class="cg-row cg-body" style="height:' + 24 * HOUR + 'px">' +
          '<div class="cg-gut cg-hours">' + hours + '</div>' + cols +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function chipHtml(o) {
    const k = keyOf(o);
    return '<div class="cg-chip' + (o.done ? ' done' : '') + (movable(o) ? ' mv' : '') + '" data-k="' + k + '" ' +
      'style="--c:' + safeColor(o.layer.color) + '" onclick="calClick(\'' + k + '\')">' + esc(o.title) + '</div>';
  }

  function blockHtml(it) {
    const o = it.o, k = keyOf(o);
    const h = Math.max(18, (it.b - it.a) * HOUR / 60 - 2), w = 100 / it.n;
    // Days-long and past-midnight entries are moved in the editor: dragging
    // one piece of them would have to guess what happens to the rest.
    const mv = movable(o) && !o.multi;
    return '<div class="cg-ev' + (o.done ? ' done' : '') + (h < 34 ? ' short' : '') + (mv ? ' mv' : '') + '" data-k="' + k + '" ' +
        'style="--c:' + safeColor(o.layer.color) + ';top:' + (it.a * HOUR / 60) + 'px;height:' + h + 'px;' +
        'left:calc(' + (it.col * w) + '% + 1px);width:calc(' + w + '% - 3px)" onclick="calClick(\'' + k + '\')">' +
        '<div class="cg-ev-t">' + esc(o.title) + '</div>' +
        '<div class="cg-ev-s">' + esc(fmtMin(it.a) + '–' + fmtMin(it.b)) + (o.address ? ' · ' + esc(o.address) : '') + '</div>' +
        // Who is on it, as the old list showed on every entry.
        ((o.crew || []).length ? '<div class="cg-ev-s">👷 ' + o.crew.map(c => esc(firstName(nameOf(c)))).join(', ') + '</div>' : '') +
        (mv ? '<div class="cg-rs" aria-hidden="true"></div>' : '') +
      '</div>';
  }

  // The hours open at the morning -- or around now, when today is on screen
  // -- and after that stay where they were scrolled to. Kept here, not read
  // off the page: a grid drawn while the tab is hidden cannot be scrolled,
  // and reading its 0 back opened the next visit at midnight.
  function placeScroll() {
    const s = document.querySelector('#calBody .cg-scroll');
    if (!s) return;
    if (gridScroll != null) s.scrollTop = gridScroll;
    else {
      const onToday = gridDays().indexOf(today()) !== -1;
      s.scrollTop = (onToday ? Math.max(0, new Date().getHours() - 2) : 6) * HOUR;
    }
    if (s.clientHeight) s.dataset.placed = '1';
    s.addEventListener('scroll', () => { if (s.clientHeight) { gridScroll = s.scrollTop; s.dataset.placed = '1'; } }, { passive: true });
  }

  // A tap on an empty hour adds an entry at that half hour.
  function wireSlots() {
    if (!adds()) return;
    document.querySelectorAll('#calBody .cg-col').forEach(col => col.addEventListener('click', e => {
      if (e.target !== col || Date.now() - justDragged < 400) return;
      const y = e.clientY - col.getBoundingClientRect().top;
      calAdd(col.dataset.day, hhmm(clamp(Math.floor(y / HOUR * 2) * 30, 0, 1410)));
    }));
  }

  // ------------------------------------------------------- month and list

  function monthHtml() {
    const first = cursor.slice(0, 8) + '01';
    const gridStart = weekStart(first);
    const gridEnd = addDays(gridStart, 41);
    const occ = occurrences(gridStart, gridEnd);
    const byDay = {};
    occ.forEach(o => { (byDay[o.day] = byDay[o.day] || []).push(o); });
    const month = cursor.slice(0, 7);
    const t = today();

    let cells = '';
    for (let i = 0; i < 42; i++) {
      const day = addDays(gridStart, i);
      const list = byDay[day] || [];
      cells += '<div class="cal-cell' + (day.slice(0, 7) !== month ? ' out' : '') + (day === t ? ' today' : '') +
          (day === selected ? ' sel' : '') + '" data-day="' + day + '" onclick="calPick(\'' + day + '\')">' +
        '<div class="cal-num">' + parseDay(day).getDate() + '</div>' +
        '<div class="cal-bars">' +
          list.slice(0, 3).map(o => {
            const k = keyOf(o);
            return '<div class="cal-bar' + (o.done ? ' done' : '') + (movable(o) ? ' mv' : '') + '" data-k="' + k + '" ' +
              'style="--c:' + safeColor(o.layer.color) + '" onclick="event.stopPropagation();calClick(\'' + k + '\')">' +
              (o.time ? '<b>' + esc(fmtTimeRange(o.time)) + '</b> ' : '') + esc(o.title) + '</div>';
          }).join('') +
          (list.length > 3 ? '<button class="cal-more" onclick="event.stopPropagation();calGoDay(\'' + day + '\')">+' +
            (list.length - 3) + ' more</button>' : '') +
        '</div>' +
        '<div class="cal-dots">' + list.slice(0, 5).map(o =>
          '<span style="--c:' + safeColor(o.layer.color) + '"></span>').join('') + '</div>' +
      '</div>';
    }
    return '<div class="cal-month">' +
        WEEKDAYS.map(w => '<div class="cal-wd">' + w + '</div>').join('') + cells +
      '</div>' +
      '<div class="cal-daypanel">' + dayBlock(selected, byDay[selected] || occurrences(selected, selected), true) + '</div>';
  }

  function listHtml() {
    const from = cursor, to = addDays(from, 60);
    const occ = occurrences(from, to);
    if (!occ.length) return '<p class="empty-msg">Nothing in the two months from here on the calendars you have switched on.</p>';
    const days = Array.from(new Set(occ.map(o => o.day)));
    return '<div class="cal-week">' + days.map(d => dayBlock(d, occ.filter(o => o.day === d), false)).join('') + '</div>';
  }

  function dayBlock(day, list, showEmpty) {
    const t = today();
    const label = day === t ? 'Today · ' + shortDay(day)
      : day === addDays(t, 1) ? 'Tomorrow · ' + shortDay(day) : longDay(day);
    if (!list.length && !showEmpty) return '';
    return '<div class="cal-day' + (day === t ? ' today' : '') + '">' +
      '<div class="cal-day-head"><span>' + label + '</span>' +
        (adds() ? '<button class="cal-plus" onclick="calAdd(\'' + day + '\')" aria-label="Add on this day">+</button>' : '') +
      '</div>' +
      (list.length ? list.map(entryHtml).join('') : '<div class="cal-none">Nothing scheduled</div>') +
    '</div>';
  }

  function entryHtml(o) {
    const k = keyOf(o);
    const time = o.time ? fmtTimeRange(o.time, o.endTime) : 'All day';
    return '<div class="cal-entry' + (o.done ? ' done' : '') + '" style="--c:' + safeColor(o.layer.color) + '" onclick="calClick(\'' + k + '\')">' +
      '<div class="cal-entry-time">' + esc(time) + '</div>' +
      '<div class="cal-entry-main">' +
        '<div class="cal-entry-title">' + esc(o.title) + '</div>' +
        '<div class="cal-entry-sub">' +
          '<span class="cal-entry-cal">' + esc(o.layer.name) + '</span>' +
          (o.jobName && o.jobName !== o.title ? ' · 📋 ' + esc(o.jobName) : '') +
          (o.address ? ' · ' + esc(o.address) : '') +
          (o.note ? ' · ' + esc(o.note) : '') +
        '</div>' +
        ((o.crew || []).length ? '<div class="cal-crew">' + o.crew.map(c =>
          '<span class="cal-face" style="--c:' + personColor(c.uid) + '">' + esc(firstName(nameOf(c))) + '</span>').join('') + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function fmtTimeRange(a, b) {
    const x = /^\d/.test(a) && a.indexOf(':') !== -1 && !/[ap]m$/.test(a) ? fmtTime(a) : a;
    return b ? x + '–' + fmtTime(b) : x;
  }
  // A person's CURRENT name where it is known (the owner's phone), so a rename
  // shows on events made before it; otherwise the name saved on the event.
  function nameOf(c) { return (people[c.uid] && people[c.uid].name) || c.name; }
  function firstName(n) { return String(n || '').split(/[\s@]/)[0] || 'Crew'; }

  // Each person keeps the same colour everywhere, worked out from their uid so
  // it needs storing nowhere and is the same on every phone.
  function personColor(uid) {
    let h = 0;
    for (const ch of String(uid || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function safeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#6b7a8f';
  }

  // ------------------------------------------------------------- controls

  window.calView = function (v) {
    if (!VIEWS.some(x => x[0] === v)) return;
    // Leaving the month for days: the day picked in it is where they start.
    if (view === 'month' && v !== 'month' && selected) cursor = selected;
    view = v;
    if (v === 'month') selected = cursor;
    try { localStorage.setItem('ydjobhub_calView', v); } catch (e) {}
    render();
  };
  window.calToday = function () { cursor = today(); selected = cursor; miniMonth = cursor.slice(0, 8) + '01'; render(); };
  window.calStep = function (n) {
    cursor = view === 'month' ? addMonths(cursor.slice(0, 8) + '01', n)
      : addDays(cursor, n * ({ day: 1, '3day': 3, week: 7, schedule: 14 }[view] || 7));
    if (view === 'month') selected = cursor.slice(0, 7) === today().slice(0, 7) ? today() : cursor;
    miniMonth = cursor.slice(0, 8) + '01';
    render();
  };
  // The small month: a day picked goes to it in the view on screen.
  window.calGo = function (day) {
    cursor = day; selected = day; miniMonth = day.slice(0, 8) + '01';
    if (isPhone()) sideOpen = false;
    render();
  };
  window.calMini = function (n) { miniMonth = addMonths(miniMonth, n).slice(0, 8) + '01'; render(); };
  // A day's heading, or "+3 more": that day on its own.
  window.calGoDay = function (day) { cursor = day; selected = day; miniMonth = day.slice(0, 8) + '01'; view = 'day'; render(); };
  window.calSide = function () { sideOpen = !sideOpen; render(); };
  window.calPick = function (day) {
    if (Date.now() - justDragged < 400) return;
    selected = day;
    render();
    const p = document.querySelector('.cal-daypanel');
    if (p && isPhone()) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  window.calSet = function (id, on) {
    if (on) hidden.delete(id); else hidden.add(id);
    saveHidden(); render();
  };
  window.calShowAll = function () { hidden = new Set(); onlyMine = false; saveHidden(); render(); };
  window.calOnlyMine = function () { onlyMine = !onlyMine; render(); };

  // ----------------------------------------------------------- open things

  window.calOpenStorm = function () { switchTab('snow'); };
  window.calOpenEquipment = function (id) {
    switchTab('equipment');
    if (window.openEquipment) openEquipment(id);
  };
  window.calOpenCard = function (boardId, cardId) {
    switchTab('boards');
    if (window.showBoard) showBoard(boardId);
    if (window.openCardDetail) openCardDetail(boardId, cardId);
  };

  window.calClick = function (k) {
    if (Date.now() - justDragged < 400) return;
    const o = drawn[k];
    if (!o) return;
    if (o.auto === 'storm') return calOpenStorm();
    if (o.auto === 'equipment') return calOpenEquipment(o.id);
    if (o.auto === 'card') return calOpenCard(o.boardId, o.id);
    // A recurring task: its card when this date's has been made, otherwise
    // the Crew tasks board.
    if (o.auto === 'recurring') {
      if (o.id) return calOpenCard('crew', o.id);
      switchTab('boards'); if (window.showBoard) showBoard('crew');
      return;
    }
    openOcc(o);
  };

  function openOcc(o) {
    const cal = cals[o.calId];
    const base = cal && (events[o.calId] || {})[o.id];
    if (!base) return;
    shown = o;
    const ev = o.ev || base;
    const when = ev.allDay || !ev.time ? 'All day' : fmtTimeRange(ev.time, ev.endTime);
    const mapUrl = ev.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.address) : '';
    openModal(esc(ev.title || ev.jobName || 'Event'),
      '<div class="cal-detail" style="--c:' + safeColor(cal.color) + '">' +
        '<div class="cal-detail-cal"><span class="cal-dot"></span>' + esc(cal.name) + '</div>' +
        '<div class="cal-detail-when">' + longDay(o.day || ev.date) + ' · ' + esc(when) +
          (ev.endDate && ev.endDate > ev.date ? '<br><span class="muted">' + shortDay(ev.date) + ' to ' + shortDay(ev.endDate) + '</span>' : '') +
          (isRepeating(base) ? '<br><span class="muted">' + REPEAT[base.repeat] +
            (base.repeatUntil ? ' until ' + shortDay(base.repeatUntil) : '') +
            (o.changed ? ' · changed for this date' : '') + '</span>' : '') +
        '</div>' +
        (ev.jobName ? '<div class="cal-detail-line">📋 ' + esc(ev.jobName) + '</div>' : '') +
        (ev.address ? '<a class="snow-addr" href="' + mapUrl + '" target="_blank" rel="noopener">📍 ' + esc(ev.address) +
          '<span class="snow-go">Directions</span></a>' : '') +
        ((ev.crew || []).length ? '<div class="cal-detail-line">👷 ' + ev.crew.map(c =>
          '<span class="cal-face" style="--c:' + personColor(c.uid) + '">' + esc(nameOf(c)) + '</span>').join(' ') + '</div>' : '') +
        (remindWords(base) ? '<div class="cal-detail-line">🔔 Reminder: ' + esc(remindWords(base).toLowerCase()) + '</div>' : '') +
        (ev.notes ? '<div class="bd-notes">' + esc(ev.notes) + '</div>' : '') +
      '</div>' +
      '<div class="field-actions">' +
        (editsCal(cal) ? '<button class="btn btn-filled" onclick="calEditShown()">Edit</button>' : '') +
        (ydCan('jobs', 'see') && ev.jobId ? '<button class="btn btn-sm" onclick="calOpenJob(\'' + safeKey(ev.jobId) + '\')">Open the job</button>' : '') +
        '<button class="btn btn-sm" onclick="closeCalModal()">Close</button>' +
      '</div>');
  }
  const safeKey = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');

  window.calOpenJob = function (jobId) {
    closeCalModal();
    // Already the job in the form: just go to it. Loading it again would read
    // the saved copy over whatever has been typed and not yet saved.
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId) { switchTab('job'); return; }
    if (typeof dirty !== 'undefined' && dirty &&
        !confirm('The job open now has unsaved changes. Open this one anyway?')) return;
    if (typeof loadJob === 'function') loadJob(jobId);
    switchTab('job');
  };

  // --------------------------------------------------------------- editor

  window.calAdd = function (day, time) {
    if (!adds()) return;
    editing = { calId: '', eventId: '', occ: null, date: day || dayForNew(), time: time || '' };
    renderEditor();
  };

  // The day a new entry starts on when no particular day was tapped: the one
  // picked in month view; in the time grid, today if it is on screen,
  // otherwise the first day shown. Always using today put entries meant for
  // next week into this one.
  function dayForNew() {
    const t = today();
    if (view === 'month') return selected || t;
    if (isGrid()) { const ds = gridDays(); return ds.indexOf(t) !== -1 ? t : ds[0]; }
    return view === 'schedule' ? cursor : t;
  }
  window.calEditShown = function () {
    if (!shown) return;
    editing = { calId: shown.calId, eventId: shown.id, occ: shown };
    renderEditor();
  };

  function renderEditor() {
    const list = editableCals();
    if (!list.length) { showToast('Calendars are still loading'); return; }
    const base = editing.eventId ? (events[editing.calId] || {})[editing.eventId] || {} : {};
    // A repeat is edited as the date that was opened: its own day, and
    // whatever was changed for it.
    const ev = editing.occ && editing.occ.ev ? editing.occ.ev : base;
    const calId = editing.calId || (lastCal && cals[lastCal] ? lastCal : list[0].id);
    const crew = crewPeople();
    const chosen = new Set((ev.crew || []).map(c => c.uid));
    const jobs = (typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id && (j.jobStatus || 'quoting') !== 'complete')
      .sort((a, b) => String(a.customerName || '').localeCompare(b.customerName || ''));
    // Added from an hour in the grid: at that time, for an hour.
    const allDay = ev.allDay != null ? ev.allDay : editing.time ? false : !ev.time;
    const startT = ev.time || editing.time || '07:00';
    const endT = ev.endTime || (editing.time ? hhmm(minutesOf(editing.time) + 60) : '');

    openModal(editing.eventId ? 'Edit' : 'Add to the calendar',
      '<div class="field"><span class="label">Calendar</span><div class="cal-pickcal">' +
        list.map(c => '<label class="cal-pickcal-item" style="--c:' + safeColor(c.color) + '">' +
          '<input type="radio" name="evCal" value="' + c.id + '"' + (c.id === calId ? ' checked' : '') +
          ' onchange="calCalChanged()"><span><span class="cal-dot"></span>' + esc(c.name) + '</span></label>').join('') +
      '</div></div>' +
      '<div class="field"><span class="label">Job</span><select id="evJob" class="searchable" onchange="calJobChanged()">' +
        '<option value="">— not about a job —</option>' +
        jobs.map(j => '<option value="' + j._id + '"' + (j._id === ev.jobId ? ' selected' : '') + '>' +
          esc(j.customerName || 'Untitled job') + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><span class="label">Title</span>' +
        '<input id="evTitle" value="' + esc(ev.title || '') + '" placeholder="Leave blank to use the job’s name"></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Date</span>' +
          '<input type="date" id="evDate" value="' + esc(ev.date || editing.date || today()) + '"></div>' +
        '<div class="field"><span class="label">Until (for more than one day)</span>' +
          '<input type="date" id="evEnd" value="' + esc(ev.endDate || '') + '"></div>' +
      '</div>' +
      '<label class="chk"><input type="checkbox" id="evAllDay"' + (allDay ? ' checked' : '') +
        ' onchange="calAllDayChanged()"> All day</label>' +
      '<div class="grid g2" id="evTimes"' + (allDay ? ' hidden' : '') + '>' +
        '<div class="field"><span class="label">Starts</span>' +
          '<input type="time" id="evTime" value="' + esc(startT) + '"></div>' +
        '<div class="field"><span class="label">Ends</span>' +
          '<input type="time" id="evEndTime" value="' + esc(endT) + '"></div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Repeats</span><select id="evRepeat">' +
          Object.keys(REPEAT).map(r => '<option value="' + r + '"' + ((base.repeat || 'none') === r ? ' selected' : '') + '>' +
            REPEAT[r] + '</option>').join('') + '</select></div>' +
        '<div class="field"><span class="label">Repeat until (optional)</span>' +
          '<input type="date" id="evUntil" value="' + esc(base.repeatUntil || '') + '"></div>' +
      '</div>' +
      // A pop-up on the phone, like Google Calendar's: to whoever sets it and
      // to the crew on it, on every phone with notifications switched on.
      '<div class="field"><span class="label">Remind</span><select id="evRemind">' +
        REMIND.map(([m, words]) => '<option value="' + (m == null ? '' : m) + '"' +
          ((base.hasReminder ? base.remindMins : null) === m ? ' selected' : '') + '>' + words + '</option>').join('') +
        '</select>' +
        '<div class="hint">A pop-up on your phone (and on the phones of anyone on it). All-day entries remind ' +
          'from 7 am. Phones need notifications switched on: ⋯ → Notifications &amp; summaries.</div></div>' +
      '<div class="field" id="evCrewField"><span class="label">Who is on it</span>' +
        (crew.length ? '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item" style="--c:' + personColor(p.uid) + '">' +
          '<input type="checkbox" class="evWho" value="' + p.uid + '"' + (chosen.has(p.uid) ? ' checked' : '') + '>' +
          '<span class="cal-face">' + esc(p.name) + '</span></label>').join('') + '</div>'
          : '<div class="hint">No crew accounts yet.</div>') +
        '<div class="hint" id="evShareHint"></div>' +
      '</div>' +
      '<div class="field"><span class="label">Address</span>' +
        '<input id="evAddr" value="' + esc(ev.address || '') + '" placeholder="Filled in from the job, or type one"></div>' +
      '<div class="field"><span class="label">Notes</span>' +
        '<textarea id="evNotes" rows="3" placeholder="What to bring, gate code, who to ask for">' + esc(ev.notes || '') + '</textarea></div>' +
      '<div class="field-actions" id="evActions">' + editorActions() + '</div>');
    calCalChanged();
  }
  function editorActions() {
    return '<button class="btn btn-filled" onclick="calSave()">Save</button>' +
      '<button class="btn btn-sm" onclick="closeCalModal()">Cancel</button>' +
      (editing && editing.eventId ? '<button class="btn btn-sm" onclick="calRemove()">Delete</button>' : '');
  }

  window.calAllDayChanged = function () {
    const t = el('evTimes');
    if (t) t.hidden = el('evAllDay').checked;
  };
  window.calJobChanged = function () {
    const id = val('evJob');
    const j = id && (loadAllJobs() || []).find(x => x._id === id);
    const a = el('evAddr');
    if (j && a && !a.value.trim()) a.value = [j.address, j.city, j.state].filter(Boolean).join(', ');
  };
  // Says plainly whether the people being picked will actually see this.
  window.calCalChanged = function () {
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    const hint = el('evShareHint');
    if (!cal || !hint) return;
    const n = (cal.visibleTo || []).length;
    hint.textContent = cal.kind === 'personal' ? 'Personal is yours only — nobody else sees it.'
      : n ? cal.name + ' is shared with ' + (cal.visibleTo || []).map(u => firstName(personName(u))).join(', ') + '.'
      : cal.name + ' is not shared with anyone yet. Share it under ⚙ Calendars so the crew see it.';
  };

  // What the editor says, checked; null (with a word why) when it cannot be
  // saved as it is. Read again when "which dates?" is answered, so anything
  // typed while that question was showing is kept.
  function readEditor(ed) {
    const c = document.querySelector('input[name="evCal"]:checked');
    if (!c) { showToast('Pick a calendar'); return null; }
    const calId = c.value;
    // Both ends of a move: the calendar it is going to, and the one it leaves.
    if (!editsCal(cals[calId]) || (ed.calId && !editsCal(cals[ed.calId]))) {
      showToast('You cannot change that calendar');
      return null;
    }
    const jobId = val('evJob');
    const job = jobId ? (loadAllJobs() || []).find(j => j._id === jobId) : null;
    const title = val('evTitle') || (job ? (job.customerName || 'Job') : '');
    if (!title) { showToast('Give it a title'); return null; }
    const date = val('evDate');
    if (!date) { showToast('Pick a date'); return null; }
    const end = val('evEnd');
    if (end && end < date) { showToast('"Until" is before the start date'); return null; }
    const allDay = el('evAllDay').checked;
    // A repeat that stops before it starts would save and then never show
    // up anywhere, which looks exactly like the entry being lost.
    const repeat = val('evRepeat') || 'none';
    const until = val('evUntil');
    if (repeat !== 'none' && until && until < date) {
      showToast('"Repeat until" is before the start date'); return null;
    }
    // Times are on the same day unless "Until" says otherwise, so work that
    // runs past midnight is entered with an end date rather than refused.
    // Ending at 12:00 am is ending at midnight, the same day.
    const startT = allDay ? '' : val('evTime');
    const endT = allDay ? '' : val('evEndTime');
    if (startT && endT && endT < startT && endT !== '00:00' && !(end && end > date)) {
      showToast('"Ends" is before "Starts" — for work past midnight, set "Until" to the next day'); return null;
    }
    const crew = crewPeople();
    const rec = {
      title: title,
      date: date,
      endDate: end && end > date ? end : null,
      allDay: allDay,
      time: startT || null,
      endTime: endT || null,
      repeat: repeat,
      repeatUntil: until || null,
      jobId: job ? job._id : null,
      jobName: job ? (job.customerName || 'Untitled job') : null,
      address: val('evAddr'),
      crew: Array.from(document.querySelectorAll('.evWho:checked'))
        .map(i => crew.find(p => p.uid === i.value)).filter(Boolean)
        .map(p => ({ uid: p.uid, name: p.name })),
      notes: el('evNotes').value.trim(),
      updatedAt: nowIso(),
    };
    // The reminder, and who asked for it. Whoever set one before keeps theirs
    // when someone else edits the entry.
    const remind = val('evRemind');
    const base = ed.eventId ? (events[ed.calId] || {})[ed.eventId] : null;
    rec.hasReminder = remind !== '';
    rec.remindMins = remind === '' ? null : parseInt(remind, 10);
    rec.remindUids = remind === '' ? [] : Array.from(new Set(
      ((base && base.remindUids) || []).concat([(me() || {}).uid]).filter(Boolean)));
    return { rec: rec, calId: calId, base: base };
  }

  window.calSave = function () {
    const ed = editing;
    if (!ed) return;
    const first = readEditor(ed);
    if (!first) return;
    const done = (rec, calId) => {
      lastCal = calId;
      closeCalModal();
      cursor = rec.date; selected = rec.date; miniMonth = rec.date.slice(0, 8) + '01';
      render();
      showToast('Saved to ' + cals[calId].name);
    };
    const base = first.base;
    if (!base) {
      const rec = first.rec, id = newId('ev');
      rec.createdAt = nowIso();
      events[first.calId] = events[first.calId] || {};
      events[first.calId][id] = Object.assign({ id: id }, rec);
      write('calendars/' + first.calId + '/events', id, rec, 'saving ' + rec.title);
      done(rec, first.calId);
      return;
    }
    const o = ed.occ || { ev: base, orig: base.date, day: base.date };
    if (isRepeating(base) && ed.occ) {
      // A different calendar, repeat or reminder is about the series, not
      // one date of it.
      const r = first.rec;
      const ruleChanged = first.calId !== ed.calId || r.repeat !== (base.repeat || 'none') ||
        (r.repeatUntil || null) !== (base.repeatUntil || null) ||
        r.hasReminder !== !!base.hasReminder || (r.remindMins == null ? null : r.remindMins) !== (base.remindMins == null ? null : base.remindMins);
      askScope('Save the change to', ruleChanged ? ['following', 'all'] : ['one', 'following', 'all'], scope => {
        const now = readEditor(ed);
        if (!now) { calScope(''); return; }
        applyChange(ed.calId, base, o, now.rec, scope, now.calId);
        done(now.rec, now.calId);
      }, true);
      return;
    }
    applyChange(ed.calId, base, o, first.rec, 'all', first.calId);
    done(first.rec, first.calId);
  };

  window.calRemove = function () {
    const ed = editing;
    if (!ed || !ed.eventId || !editsCal(cals[ed.calId])) return;
    const base = (events[ed.calId] || {})[ed.eventId];
    if (!base) return;
    if (isRepeating(base) && ed.occ) {
      askScope('Delete', ['one', 'following', 'all'], scope => {
        removeScoped(ed.calId, base, ed.occ, scope);
        closeCalModal(); render();
      }, true);
      return;
    }
    if (!confirm('Delete "' + (base.title || 'this') + '"' + (isRepeating(base) ? ' and every repeat of it' : '') + '?')) return;
    delete events[ed.calId][ed.eventId];
    removeEvent(ed.calId, ed.eventId);
    closeCalModal(); render();
  };

  function removeEvent(calId, eventId) {
    Promise.resolve(window.YDDb.remove('calendars/' + calId + '/events', eventId))
      .catch(e => console.warn('[calendar] event not removed:', e.code || e.message));
  }

  // ------------------------------------------- one date, the rest, or all
  //
  // Google Calendar's question when a repeating entry is changed: "This
  // event / This and following events / All events".
  const SCOPES = { one: 'This date only', following: 'This date and the ones after', all: 'Every date' };
  // `inline`: asked at the foot of the editor, so Cancel goes back to what
  // was typed; otherwise in its own window (after a drag).
  function askScope(what, opts, then, inline) {
    pending = then;
    const html = '<div class="cal-scope"><div class="cal-scope-q">' + esc(what) + ' — which dates?</div>' +
      opts.map((s, i) => '<button class="btn' + (i ? '' : ' btn-filled') + '" onclick="calScope(\'' + s + '\')">' + SCOPES[s] + '</button>').join('') +
      '<button class="btn btn-sm" onclick="calScope(\'\')">Cancel</button></div>';
    if (inline && el('evActions')) el('evActions').innerHTML = html;
    else openModal('A repeating entry', html);
  }
  window.calScope = function (s) {
    const then = pending;
    pending = null;
    if (s && then) { then(s); return; }
    if (el('evActions') && editing) { el('evActions').innerHTML = editorActions(); return; }
    closeCalModal(); render();          // a drag let go of: back where it was
  };

  // The fields that make up one date of an entry -- what a single-date
  // change keeps.
  const OCC_FIELDS = ['date', 'endDate', 'allDay', 'time', 'endTime', 'title', 'jobId', 'jobName', 'address', 'crew', 'notes'];
  function pick(o, keys) {
    const out = {};
    keys.forEach(k => { out[k] = o[k] === undefined ? null : o[k]; });
    return out;
  }
  // Written the way Firestore merges: a map of single-date changes merges
  // date by date, everything else is replaced.
  function applyLocal(calId, id, patch) {
    const set = events[calId] = events[calId] || {};
    const cur = set[id] = set[id] || { id: id };
    Object.keys(patch).forEach(k => {
      if (k === 'exceptions' && patch[k] && cur.exceptions) cur.exceptions = Object.assign({}, cur.exceptions, patch[k]);
      else cur[k] = patch[k];
    });
  }
  function setException(calId, base, key, value) {
    const patch = { exceptions: { [key]: value }, updatedAt: nowIso() };
    applyLocal(calId, base.id, patch);
    write('calendars/' + calId + '/events', base.id, patch, 'changing one date');
  }
  const nulled = ex => { const out = {}; Object.keys(ex || {}).forEach(k => { out[k] = null; }); return out; };
  const live = ex => { const out = {}; Object.keys(ex || {}).forEach(k => { if (ex[k]) out[k] = ex[k]; }); return Object.keys(out).length ? out : null; };

  const same = (x, y) => JSON.stringify(x == null ? null : x) === JSON.stringify(y == null ? null : y);
  const isStep = ev => ev.repeat === 'weekly' || ev.repeat === 'biweekly';

  // A single date's own change, with what was just changed for more dates
  // than that. The date acted on takes every change; another date changed on
  // its own keeps its own time, unless it had the series' time anyway.
  function withFields(x, fields, isThis, base) {
    if (!x || typeof x !== 'object') return x;
    const upd = Object.assign({}, x);
    Object.keys(fields).forEach(f => {
      if (OCC_FIELDS.indexOf(f) === -1 || f === 'date' || f === 'endDate') return;
      if (isThis || ['time', 'endTime', 'allDay'].indexOf(f) === -1 || same(x[f], base[f])) upd[f] = fields[f];
    });
    return upd;
  }
  // The single-date changes from `from` on, moved with a series that moved
  // by `delta` days: a weekly repeat's changes (cancelled ones too) move by
  // the same days; a monthly or yearly one's dates do not move by days, so
  // theirs go. The date the move was made from is an ordinary date of the
  // moved series now.
  function movedExceptions(ex, from, delta, step, origKey) {
    const out = {};
    Object.keys(ex).forEach(k => {
      const x = ex[k];
      if (!x || k < from || k === origKey || !step) return;
      out[addDays(k, delta)] = typeof x === 'object'
        ? Object.assign({}, x, { date: addDays(x.date || k, delta), endDate: x.endDate ? addDays(x.endDate, delta) : null })
        : x;
    });
    return out;
  }

  // A change to the date `o` of the entry `base` (from the editor, or a
  // drag): `next` is that date as it should now be. Only what this change
  // made different from the date as shown is applied to other dates -- a
  // date changed on its own earlier carries its own title or time, which
  // must not spread to every date (review, 7 Oct). A date moved re-anchors
  // the repeat on its new day, counted from the day the repeat fell on, and
  // "Repeat until" moves with it -- left behind, a series dragged past its
  // last date vanished.
  function applyChange(calId, base, o, next, scope, toCal) {
    toCal = toCal || calId;
    const path = 'calendars/' + calId + '/events';
    const repeating = isRepeating(base);
    const ex = (repeating && base.exceptions) || {};
    if (repeating && scope === 'one') {
      setException(calId, base, o.orig, pick(Object.assign({}, o.ev, next), OCC_FIELDS));
      return;
    }
    const diff = {};
    Object.keys(next).forEach(k => { if (k !== 'updatedAt' && !same(next[k], o.ev[k])) diff[k] = next[k]; });
    const moved = 'date' in diff;
    const delta = moved ? daysBetween(o.orig, next.date) : 0;
    const reSpan = moved || 'endDate' in diff;
    const span = reSpan ? (next.endDate && next.endDate > next.date ? daysBetween(next.date, next.endDate) : 0) : spanOf(base);
    const fields = Object.assign({}, diff);
    delete fields.date; delete fields.endDate;
    // Never a repeat that stops before it starts.
    const untilFor = (start, given) => {
      let u = given !== undefined ? given : (base.repeatUntil && delta ? addDays(base.repeatUntil, delta) : base.repeatUntil || null);
      if (u && u < start) u = start;
      return u || null;
    };
    const series = Object.assign({}, base);
    delete series.id; delete series.exceptions;

    if (repeating && scope === 'following' && o.orig > base.date) {
      // The series stops the day before; a new one carries on from this date
      // with the change, taking the single-date changes from here on.
      const cleared = {};
      let carried = {};
      Object.keys(ex).forEach(k => { if (k >= o.orig) cleared[k] = null; });
      if (delta) carried = movedExceptions(ex, o.orig, delta, isStep(base), o.orig);
      else Object.keys(ex).forEach(k => { if (k >= o.orig && ex[k]) carried[k] = withFields(ex[k], fields, k === o.orig, base); });
      const stop = { repeatUntil: addDays(o.orig, -1), updatedAt: nowIso() };
      if (Object.keys(cleared).length) stop.exceptions = cleared;
      applyLocal(calId, base.id, stop);
      write(path, base.id, stop, 'ending a repeat');
      const rec = Object.assign(series, fields);
      rec.date = addDays(o.orig, delta);
      rec.endDate = span ? addDays(rec.date, span) : null;
      rec.repeatUntil = untilFor(rec.date, 'repeatUntil' in diff ? diff.repeatUntil : undefined);
      rec.exceptions = Object.keys(carried).length ? carried : null;
      rec.createdAt = nowIso(); rec.updatedAt = nowIso();
      const nid = newId('ev');
      applyLocal(toCal, nid, rec);
      write('calendars/' + toCal + '/events', nid, rec, 'starting the repeat again');
      return;
    }

    // The whole entry -- every date of a repeat.
    const rec = Object.assign({}, fields, { updatedAt: nowIso() });
    const start = reSpan ? addDays(base.date, delta) : base.date;
    if (reSpan) { rec.date = start; rec.endDate = span ? addDays(start, span) : null; }
    if (repeating) {
      const u = untilFor(start, 'repeatUntil' in diff ? diff.repeatUntil : undefined);
      if (!same(u, base.repeatUntil)) rec.repeatUntil = u;
    }
    let exPatch = null;
    if (Object.keys(ex).length) {
      exPatch = {};
      if (delta) Object.assign(exPatch, nulled(ex), movedExceptions(ex, '', delta, isStep(base), o.orig));
      else Object.keys(ex).forEach(k => {
        const upd = withFields(ex[k], fields, k === o.orig, base);
        if (ex[k] && !same(upd, ex[k])) exPatch[k] = upd;
      });
      if (!Object.keys(exPatch).length) exPatch = null;
    }
    if (toCal !== calId) {
      // Another calendar is another place: written new there, taken away here.
      const full = Object.assign(series, rec, { createdAt: base.createdAt || nowIso() });
      full.exceptions = live(Object.assign({}, ex, exPatch || {}));
      const nid = newId('ev');
      delete events[calId][base.id];
      removeEvent(calId, base.id);
      applyLocal(toCal, nid, full);
      write('calendars/' + toCal + '/events', nid, full, 'moving it');
      return;
    }
    if (exPatch) rec.exceptions = exPatch;
    applyLocal(calId, base.id, rec);
    write(path, base.id, rec, 'saving ' + (rec.title || base.title || ''));
  }

  function removeScoped(calId, base, o, scope) {
    if (scope === 'one') { setException(calId, base, o.orig, 'cancelled'); return; }
    if (scope === 'following' && o.orig > base.date) {
      const ex = base.exceptions || {}, cleared = {};
      Object.keys(ex).forEach(k => { if (k >= o.orig) cleared[k] = null; });
      const stop = { repeatUntil: addDays(o.orig, -1), updatedAt: nowIso() };
      if (Object.keys(cleared).length) stop.exceptions = cleared;
      applyLocal(calId, base.id, stop);
      write('calendars/' + calId + '/events', base.id, stop, 'ending a repeat');
      return;
    }
    delete events[calId][base.id];
    removeEvent(calId, base.id);
  }

  // ------------------------------------------------------------------ drag
  //
  // With a mouse, an entry moves as soon as it is pulled. On a touch screen a
  // finger on an entry is usually scrolling, so it is held for a moment first
  // (as in Google Calendar); moving before then scrolls as normal.
  function onDown(e) {
    if (e.button > 0 || drag) return;
    const it = e.target.closest && e.target.closest('#calBody [data-k].mv');
    if (!it) return;
    const o = drawn[it.dataset.k];
    if (!o) return;
    drag = { el: it, o: o, block: it.classList.contains('cg-ev'), resize: e.target.classList.contains('cg-rs'),
             x0: e.clientX, y0: e.clientY, grabY: e.clientY - it.getBoundingClientRect().top,
             live: false, touch: e.pointerType !== 'mouse', id: e.pointerId, day: o.day };
    if (drag.touch) {
      drag.timer = setTimeout(() => {
        if (drag && !drag.live) { goLive(); if (navigator.vibrate) navigator.vibrate(15); }
      }, 380);
    }
  }
  function goLive() {
    // Redrawn since it was pressed: the entry held is no longer on the page.
    if (!drag.el.isConnected) { stopDrag(); return false; }
    drag.live = true;
    drag.el.classList.add('dragging');
    // A month square (or an all-day box) hides what spills out of it; while
    // dragging, it may.
    const body = el('calBody');
    if (body) body.classList.add('dragging');
    try { drag.el.setPointerCapture(drag.id); } catch (err) {}
    if (drag.block) { const s = segOf(drag.o); drag.s0 = s; drag.a = s[0]; drag.b = s[1]; }
    return true;
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    // The mouse button let go somewhere the page never heard about (another
    // window): the drag is over, not carried on with no button held.
    if (!drag.touch && !(e.buttons & 1)) { const was = drag.live; stopDrag(); if (was) render(); return; }
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.live) {
      if (drag.touch) { if (Math.abs(dx) + Math.abs(dy) > 10) stopDrag(); return; }
      if (Math.abs(dx) + Math.abs(dy) < 6) return;
      if (!goLive()) return;
    }
    if (e.cancelable) e.preventDefault();
    if (drag.block) moveBlock(e); else moveChip(e, dx, dy);
  }
  function moveBlock(e) {
    const scroller = document.querySelector('#calBody .cg-scroll');
    if (scroller) {
      // Near the top or bottom edge, the hours scroll along.
      const r = scroller.getBoundingClientRect();
      if (e.clientY > r.bottom - 36) scroller.scrollTop += 14;
      else if (e.clientY < r.top + 90) scroller.scrollTop -= 14;
    }
    if (drag.resize) {
      const top = drag.el.parentNode.getBoundingClientRect().top;
      drag.b = clamp(snap((e.clientY - top) / HOUR * 60), drag.a + SNAP, 1440);
      drag.el.style.height = Math.max(18, (drag.b - drag.a) * HOUR / 60 - 2) + 'px';
    } else {
      const cols = Array.from(document.querySelectorAll('#calBody .cg-col'));
      if (!cols.length) return;
      const col = cols.find(c => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX < r.right; }) ||
        (e.clientX < cols[0].getBoundingClientRect().left ? cols[0] : cols[cols.length - 1]);
      const dur = drag.s0[1] - drag.s0[0];
      const top = col.getBoundingClientRect().top;
      drag.a = clamp(snap((e.clientY - drag.grabY - top) / HOUR * 60), 0, 1440 - dur);
      drag.b = drag.a + dur;
      drag.day = col.dataset.day;
      if (drag.el.parentNode !== col) col.appendChild(drag.el);
      drag.el.style.top = (drag.a * HOUR / 60) + 'px';
      drag.el.style.left = '1px';
      drag.el.style.width = 'calc(100% - 3px)';
    }
    const s = drag.el.querySelector('.cg-ev-s');
    if (s) s.textContent = fmtMin(drag.a) + '–' + fmtMin(drag.b);
  }
  // An all-day chip or a month bar: it follows the finger; the day under it
  // is where it lands.
  function moveChip(e, dx, dy) {
    drag.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    drag.el.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cell = under && under.closest && under.closest('#calBody .cal-cell[data-day], #calBody .cg-allcell[data-day]');
    document.querySelectorAll('#calBody .drop-on').forEach(c => c.classList.remove('drop-on'));
    if (cell) { cell.classList.add('drop-on'); drag.day = cell.dataset.day; }
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    stopDrag();
    if (!d.live) return;
    justDragged = Date.now();
    const o = d.o, ev = o.ev || {};
    let patch = null;
    if (d.block) {
      if (d.resize) { if (d.b !== d.s0[1]) patch = { endTime: hhmm(d.b) }; }
      else if (d.day !== o.day || d.a !== d.s0[0]) {
        // An entry with no end time stays without one (it shows as an hour).
        patch = { date: d.day, endDate: null, allDay: false, time: hhmm(d.a),
                  endTime: ev.endTime ? hhmm(d.b) : null };
      }
    } else if (d.day && d.day !== o.day) {
      const delta = daysBetween(o.day, d.day);
      patch = { date: addDays(ev.date, delta), endDate: ev.endDate ? addDays(ev.endDate, delta) : null };
    }
    if (!patch) { render(); return; }
    moveOcc(o, patch);
  }
  function stopDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    const it = drag.el;
    it.classList.remove('dragging');
    it.style.transform = ''; it.style.pointerEvents = '';
    document.querySelectorAll('#calBody .drop-on').forEach(c => c.classList.remove('drop-on'));
    const body = el('calBody');
    if (body) body.classList.remove('dragging');
    drag = null;
  }
  function moveOcc(o, patch) {
    const base = (events[o.calId] || {})[o.id];
    if (!base || !editsCal(cals[o.calId])) { render(); return; }
    const next = Object.assign(pick(o.ev || base, OCC_FIELDS), patch);
    const moved = () => showToast('Moved — ' + shortDay(next.date) + (next.time && !next.allDay ? ' ' + fmtTime(next.time) : ''));
    if (isRepeating(base)) {
      askScope('Move “' + (o.title || 'this') + '”', ['one', 'following', 'all'], scope => {
        closeCalModal();
        applyChange(o.calId, base, o, next, scope);
        render(); moved();
      });
      return;
    }
    applyChange(o.calId, base, o, next, 'all');
    render(); moved();
  }

  // Swiping across the calendar on a phone moves to the next days, or back.
  let swipe = null;
  function onTouchStart(e) {
    swipe = e.touches.length === 1 && e.target.closest && e.target.closest('#calBody')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }
  function onTouchEnd(e) {
    const s = swipe;
    swipe = null;
    if (!s || drag || Date.now() - justDragged < 500 || view === 'schedule') return;
    const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Date.now() - s.t < 600 && Math.abs(dx) > 70 && Math.abs(dy) < 45) calStep(dx < 0 ? 1 : -1);
  }

  function wire() {
    const wrap = el('calWrap');
    if (!wrap || wrap.dataset.wired) return;
    wrap.dataset.wired = '1';
    wrap.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', () => { const was = drag && drag.live; stopDrag(); if (was) render(); });
    // Once an entry is held, the finger moves it rather than the page.
    wrap.addEventListener('touchmove', e => { if (drag && drag.live && e.cancelable) e.preventDefault(); }, { passive: false });
    wrap.addEventListener('touchstart', onTouchStart, { passive: true });
    wrap.addEventListener('touchend', onTouchEnd, { passive: true });
    // The red line at now keeps up.
    setInterval(() => document.querySelectorAll('#calBody .cg-now').forEach(n => { n.style.top = nowTop() + 'px'; }), 60000);
  }

  // ------------------------------------------------------ manage calendars

  window.calManage = function () {
    if (!isOwner()) return;
    openModal('Calendars',
      '<div class="cal-manage">' + storedCals().map(c =>
        '<div class="cal-manage-row" style="--c:' + safeColor(c.color) + '">' +
          '<span class="cal-dot"></span>' +
          '<div class="cal-manage-name"><b>' + esc(c.name) + '</b><span class="muted">' +
            (c.kind === 'personal' ? 'Only you'
              : (c.visibleTo || []).length ? 'Shared with ' + c.visibleTo.map(u => esc(firstName(personName(u)))).join(', ')
              : 'Only you so far') + '</span></div>' +
          '<button class="btn btn-sm" onclick="calEditCal(\'' + c.id + '\')">Edit</button>' +
        '</div>').join('') + '</div>' +
      '<div class="hint">Storm nights, equipment service dates and board due dates appear by themselves — ' +
        'they come from the Snow, Equipment and Boards tabs, so they are always right.</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="calEditCal(\'\')">+ New calendar</button>' +
        '<button class="btn btn-sm" onclick="closeCalModal()">Done</button>' +
      '</div>');
  };

  window.calEditCal = function (id) {
    if (!isOwner()) return;
    const c = id ? cals[id] : {};
    const crew = crewPeople().filter(p => p.role !== 'owner');
    const shared = new Set(c.visibleTo || []);
    const color = c.color || PALETTE[(Object.keys(cals).length + 3) % PALETTE.length];
    openModal(id ? 'Edit ' + esc(c.name) : 'New calendar',
      '<div class="field"><span class="label">Name</span>' +
        '<input id="ccName" value="' + esc(c.name || '') + '" placeholder="e.g. Mowing route"></div>' +
      '<div class="field"><span class="label">Colour</span><div class="bd-swatches">' +
        PALETTE.map(p => '<label class="bd-swatch" style="--c:' + p + '"><input type="radio" name="ccColor" value="' + p + '"' +
          (p === color ? ' checked' : '') + '><span></span></label>').join('') + '</div></div>' +
      (c.kind === 'personal' ? '<div class="hint">Personal is never shared.</div>' :
        '<div class="field"><span class="label">Who can see it</span>' +
          (crew.length ? '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="ccShare" value="' +
              p.uid + '"' + (shared.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') + '</div>' +
            '<div class="hint">Anyone ticked sees every event on this calendar, including the address. ' +
            'They cannot add or change anything.</div>'
            : '<div class="hint">No crew accounts yet. Once someone signs in and you approve them, they appear here.</div>') +
        '</div>' +
        '<label class="chk"><input type="checkbox" id="ccPrivate"' + (c.ownerOnly ? ' checked' : '') +
          '> Private — admins with Calendars access do not see it (anyone ticked above still does)</label>') +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="calSaveCal(\'' + (id || '') + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="calManage()">Back</button>' +
        (id && c.kind === 'custom' ? '<button class="btn btn-sm" onclick="calRemoveCal(\'' + id + '\')">Delete calendar</button>' : '') +
      '</div>');
  };

  window.calSaveCal = function (id) {
    if (!isOwner()) return;
    const name = val('ccName');
    if (!name) { showToast('Give it a name'); return; }
    const was = id ? cals[id] : null;
    const cid = id || newId('cal');
    const colorInput = document.querySelector('input[name="ccColor"]:checked');
    const rec = {
      name: name,
      color: colorInput ? colorInput.value : PALETTE[0],
      kind: was ? was.kind : 'custom',
      // Personal is never shared, whatever was ticked.
      visibleTo: was && was.kind === 'personal' ? []
        : Array.from(document.querySelectorAll('.ccShare:checked')).map(i => i.value),
      // Always written, true or false: an admin's calendars are fetched by
      // asking for ownerOnly == false, and a calendar without the field at
      // all would be missing from their screen.
      ownerOnly: was && was.kind === 'personal' ? true : !!(el('ccPrivate') && el('ccPrivate').checked),
      order: was && was.order != null ? was.order : Object.keys(cals).length + 1,
      updatedAt: nowIso(),
    };
    cals[cid] = Object.assign({ id: cid }, was || {}, rec);
    write('calendars', cid, rec, 'saving ' + name);
    if (!eventUnsubs[cid]) watchEvents(cid);
    calManage(); render();
  };

  window.calRemoveCal = function (id) {
    if (!isOwner()) return;
    const c = cals[id];
    const ids = Object.keys(events[id] || {});
    if (!c || !confirm('Delete the calendar "' + c.name + '"' + (ids.length ? ' and its ' + ids.length + ' events' : '') +
        '? This cannot be undone.')) return;
    if (eventUnsubs[id]) { eventUnsubs[id](); delete eventUnsubs[id]; }
    delete cals[id]; delete events[id];
    closeCalModal(); render();
    Promise.resolve(window.YDDb.removeMany(
      ids.map(e => ['calendars/' + id + '/events', e]).concat([['calendars', id]])
    )).catch(e => console.warn('[calendar] not yet removed:', e.code || e.message));
  };

  // --------------------------------------------------------------- people

  function crewPeople() {
    return Object.keys(people)
      .filter(uid => people[uid].active && ['crew', 'admin', 'owner'].indexOf(people[uid].role) !== -1)
      .map(uid => ({ uid: uid, name: people[uid].name || people[uid].email || 'Worker', role: people[uid].role }))
      .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.name.localeCompare(b.name));
  }
  function personName(uid) {
    const p = people[uid];
    return p ? (p.name || p.email || 'Worker') : 'Worker';
  }

  // ----------------------------------------------------------------- modal

  function openModal(title, html) {
    const m = el('calModal'), t = el('calModalTitle'), b = el('calModalBody');
    if (!m || !b) return;
    if (t) t.innerHTML = title;
    b.innerHTML = html;
    m.classList.add('active');
  }
  window.closeCalModal = function () {
    const m = el('calModal');
    if (m) m.classList.remove('active');
    editing = null;
    // Closed while asking which dates a drag should move: it goes back.
    if (pending) { pending = null; render(); }
  };

  // ---------------------------------------------------------------- writes

  // Never awaited -- see the note in boards.js. The screen is already updated;
  // Firestore sends the write when there is signal.
  function write(path, id, data, what) {
    if (!window.YDDb) { showToast('Not saved — still connecting'); return; }
    Promise.resolve(window.YDDb.put(path, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[calendar] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }

  // --------------------------------------------------------------- loading

  function watchEvents(calId) {
    if (eventUnsubs[calId] || !window.YDDb) return;
    eventUnsubs[calId] = window.YDDb.watch('calendars/' + calId + '/events', changes => {
      const set = events[calId] = events[calId] || {};
      changes.forEach(c => {
        if (c.type === 'removed') delete set[c.id];
        else set[c.id] = Object.assign({ id: c.id }, c.data);
      });
      redrawIfVisible();
    });
  }

  function onCals(changes, meta) {
    changes.forEach(c => {
      if (c.type === 'removed') {
        delete cals[c.id];
        if (eventUnsubs[c.id]) { eventUnsubs[c.id](); delete eventUnsubs[c.id]; }
        delete events[c.id];
      } else {
        cals[c.id] = Object.assign({ id: c.id }, c.data);
        watchEvents(c.id);
      }
    });
    // Seed the four starting calendars once the server has answered -- and
    // only the ones missing, so a calendar the owner deleted is not resurrected
    // unless it is one of the four built-ins.
    if (isOwner() && !seeded && meta && !meta.fromCache) {
      seeded = true;
      SEED.forEach(s => {
        if (cals[s.id]) return;
        const rec = { name: s.name, color: s.color, kind: s.kind, order: s.order, visibleTo: [],
                      ownerOnly: s.kind === 'personal', updatedAt: nowIso() };
        cals[s.id] = Object.assign({ id: s.id }, rec);
        write('calendars', s.id, rec, 'seeding');
        watchEvents(s.id);
      });
      // Calendars made before admins existed have no ownerOnly at all. Each
      // is marked once: Personal private, the rest not. Until then an admin
      // given Calendars would see none of them, since they are fetched by
      // asking for ownerOnly == false.
      Object.values(cals).forEach(c => {
        if (typeof c.ownerOnly === 'boolean') return;
        c.ownerOnly = c.kind === 'personal';
        write('calendars', c.id, { ownerOnly: c.ownerOnly }, 'marking private or not');
      });
    }
    redrawIfVisible();
  }

  function redrawIfVisible() {
    const p = el('panel-calendar');
    if (!p || !p.classList.contains('active')) return;
    // Do not redraw under someone filling in the editor.
    const m = el('calModal');
    if (m && m.classList.contains('active') && (el('evTitle') || el('ccName'))) return;
    render();
  }

  function stop() {
    [unsubCals, unsubStorms, unsubPeople].forEach(u => { if (u) u(); });
    unsubCals = unsubStorms = unsubPeople = null;
    Object.values(eventUnsubs).forEach(u => u());
    eventUnsubs = {}; cals = {}; events = {}; storms = {}; people = {}; seeded = false;
  }

  function start(a) {
    stop();
    if (!window.YDDb || !a.user) return;
    if (a.isOwner) {
      unsubCals = window.YDDb.watch('calendars', onCals);
    } else if (seesAllCals()) {
      // Never the whole collection: the rules refuse a question whose answer
      // could include the owner's Personal calendar. Two questions instead --
      // every calendar not kept private, and any shared with them by name --
      // and a calendar goes only when neither still returns it.
      const from = {};
      const tagged = name => (changes, meta) => {
        const pass = [];
        changes.forEach(c => {
          const s = from[c.id] || (from[c.id] = new Set());
          if (c.type === 'removed') {
            s.delete(name);
            if (!s.size) { delete from[c.id]; pass.push(c); }
          } else { s.add(name); pass.push(c); }
        });
        if (pass.length || meta) onCals(pass, meta);
      };
      const open = window.YDDb.watchWhere('calendars', 'ownerOnly', false, tagged('open'), () => redrawIfVisible());
      const mine = window.YDDb.watchContains('calendars', 'visibleTo', a.user.uid, tagged('mine'), () => redrawIfVisible());
      unsubCals = () => { open(); mine(); };
    } else {
      unsubCals = window.YDDb.watchContains('calendars', 'visibleTo', a.user.uid, onCals, () => redrawIfVisible());
    }
    // Names for the people on events, and who a calendar can be shared with.
    if (a.isOwner || a.isAdmin) {
      unsubPeople = window.YDDb.watch('users', changes => {
        changes.forEach(c => { if (c.type === 'removed') delete people[c.id]; else people[c.id] = c.data; });
        redrawIfVisible();
      }, () => {});
    }
    // Crew can read storms, so both see storm nights.
    unsubStorms = window.YDDb.watch('storms', changes => {
      changes.forEach(c => { if (c.type === 'removed') delete storms[c.id]; else storms[c.id] = Object.assign({ id: c.id }, c.data); });
      redrawIfVisible();
    }, () => {});
  }

  window.YDCalendar = {
    render: render,
    redraw: () => redrawIfVisible(),
    occurrences: occurrences,
    calendars: () => cals,
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const tab = el('tabCalendar');
    if (tab) tab.hidden = !on;
    if (on) start(a); else stop();
    render();
  });
  document.addEventListener('yd-jobs-changed', redrawIfVisible);
  document.addEventListener('yd-cards-changed', redrawIfVisible);
  document.addEventListener('yd-boards-changed', redrawIfVisible);

  function boot() { wire(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
