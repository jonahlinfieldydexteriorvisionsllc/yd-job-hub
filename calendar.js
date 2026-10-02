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

  const AUTO = {
    'auto:storms': { id: 'auto:storms', name: 'Storm nights', color: '#3fb6d8', auto: true,
                     about: 'From the Snow tab' },
    'auto:equipment': { id: 'auto:equipment', name: 'Equipment due', color: '#8a6d3b', auto: true,
                        ownerOnly: true, about: 'Service dates from the Equipment tab' },
    'auto:cards': { id: 'auto:cards', name: 'Board due dates', color: '#6b7a8f', auto: true,
                    about: 'Cards with a due date' },
  };

  const PALETTE = ['#2f6fd6', '#1a9c8c', '#2f8f5b', '#8bb22a', '#e0a526',
                   '#e07b24', '#d64545', '#d94f8a', '#8e5bc7', '#66418f', '#6b7a8f'];
  const REPEAT = { none: 'Does not repeat', weekly: 'Every week', biweekly: 'Every 2 weeks',
                   monthly: 'Every month', yearly: 'Every year' };
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ------------------------------------------------------------------- state

  let cals = {};            // stored calendars
  let events = {};          // calId -> { eventId -> event }
  let storms = {};
  let people = {};          // owner only
  let unsubCals = null, unsubStorms = null, unsubPeople = null;
  let eventUnsubs = {};
  let seeded = false;

  let view = null;          // 'month' | 'week' | 'list'
  let cursor = '';          // the day the view is centred on (set on first draw)
  let selected = '';        // the day picked in month view
  let hidden = loadHidden();// layer ids switched off
  let onlyMine = false;
  let editing = null;       // { calId, eventId, date } in the editor
  let lastCal = null;       // calendar last added to, offered first next time

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  // An admin given Calendars sees every calendar except the owner's own ones
  // (ownerOnly: Personal, and any other the owner marks private) -- and with
  // "change" adds and edits events on them. Making, sharing and deleting
  // calendars stays the owner's.
  const seesAllCals = () => ydCan('calendars', 'see');
  const editsCal = cal => !!cal && (isOwner() || (ydCan('calendars', 'change') && cal.ownerOnly === false));
  const editableCals = () => storedCals().filter(editsCal);
  const two = n => String(n).padStart(2, '0');
  const nowIso = () => new Date().toISOString();
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

  // ---------------------------------------------------------------- layers

  function storedCals() {
    return Object.values(cals).sort((a, b) => (a.order || 0) - (b.order || 0) ||
      String(a.name || '').localeCompare(b.name || ''));
  }
  function layers() {
    const auto = Object.values(AUTO).filter(l => !l.ownerOnly || ydCan('equipment', 'see'));
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
  // entries ready to draw: { day, layer, title, time, ... }.
  function occurrences(from, to) {
    const out = [];
    const uid = me() && me().uid;

    Object.keys(events).forEach(cid => {
      const cal = cals[cid];
      if (!cal || hidden.has(cid)) return;
      Object.values(events[cid]).forEach(ev => {
        if (onlyMine && !isMine(ev, cal, uid)) return;
        datesOf(ev, from, to).forEach(day => out.push({
          day: day, layer: cal, ev: ev, calId: cid, id: ev.id,
          title: ev.title || (ev.jobName ? ev.jobName : 'Untitled'),
          time: ev.allDay ? '' : ev.time, endTime: ev.allDay ? '' : ev.endTime,
          crew: ev.crew || [], address: ev.address || '', jobName: ev.jobName || '',
          multi: ev.endDate && ev.endDate > ev.date,
        }));
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
        if (onlyMine && !(x.card.assignees || []).some(a => a.uid === uid)) return;
        out.push({ day: x.card.due, layer: Object.assign({}, AUTO['auto:cards'], { color: x.board.color }),
          auto: 'card', id: x.card.id, boardId: x.board.id, done: x.done,
          title: '📌 ' + (x.card.title || 'Card'), note: x.board.name,
          crew: x.card.assignees || [] });
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

  // The days an event lands on within [from, to] -- multi-day events land on
  // each of their days, repeating ones on each repeat.
  function datesOf(ev, from, to) {
    if (!ev.date) return [];
    const span = ev.endDate && ev.endDate > ev.date ? daysBetween(ev.date, ev.endDate) : 0;
    const starts = [];
    const rep = ev.repeat || 'none';
    const until = ev.repeatUntil || to;
    if (rep === 'none') starts.push(ev.date);
    else {
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
    }
    const out = [];
    starts.forEach(s => {
      for (let i = 0; i <= span; i++) {
        const day = i ? addDays(s, i) : s;
        if (day >= from && day <= to) out.push(day);
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- render

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
    if (!view) view = window.matchMedia('(max-width:720px)').matches ? 'week' : 'month';
    if (!cursor) { cursor = today(); selected = cursor; }

    const all = layers();
    const allOn = all.every(l => !hidden.has(l.id));

    wrap.innerHTML =
      '<div class="cal-top">' +
        '<div class="cal-nav">' +
          '<button class="btn btn-sm" onclick="calStep(-1)" aria-label="Back">‹</button>' +
          '<button class="btn btn-sm" onclick="calToday()">Today</button>' +
          '<button class="btn btn-sm" onclick="calStep(1)" aria-label="Forward">›</button>' +
          '<span class="cal-title">' + titleFor() + '</span>' +
        '</div>' +
        '<div class="cal-views">' +
          ['month', 'week', 'list'].map(v => '<button class="btn btn-sm' + (view === v ? ' btn-filled' : '') +
            '" onclick="calView(\'' + v + '\')">' + { month: 'Month', week: 'Week', list: 'List' }[v] + '</button>').join('') +
          ((isOwner() || ydCan('calendars', 'change')) ? '<button class="btn btn-sm btn-accent" onclick="calAdd()">+ Add</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="cal-layers">' +
        '<button class="cal-chip all' + (allOn && !onlyMine ? ' on' : '') + '" onclick="calShowAll()">Everything</button>' +
        all.map(l => '<button class="cal-chip' + (hidden.has(l.id) ? '' : ' on') + '" style="--c:' + safeColor(l.color) +
          '" onclick="calToggle(\'' + l.id + '\')" title="' + esc(l.about || '') + '">' +
          '<span class="cal-dot"></span>' + esc(l.name) +
          (isOwner() && !l.auto && (l.visibleTo || []).length ? ' <span class="cal-shared">👥' + l.visibleTo.length + '</span>' : '') +
          '</button>').join('') +
        '<button class="cal-chip mine' + (onlyMine ? ' on' : '') + '" onclick="calOnlyMine()">👤 Only mine</button>' +
        (isOwner() ? '<button class="cal-chip gear" onclick="calManage()">⚙ Calendars</button>' : '') +
      '</div>' +
      (view === 'month' ? monthHtml() : view === 'week' ? weekHtml() : listHtml());
  }

  function titleFor() {
    if (view === 'month') return monthTitle(cursor);
    if (view === 'week') {
      const s = weekStart(cursor), e = addDays(s, 6);
      const a = parseDay(s), b = parseDay(e);
      return a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' +
        b.toLocaleDateString('en-US', a.getMonth() === b.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' }) +
        ', ' + b.getFullYear();
    }
    return 'Coming up';
  }

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
          (day === selected ? ' sel' : '') + '" onclick="calPick(\'' + day + '\')">' +
        '<div class="cal-num">' + parseDay(day).getDate() + '</div>' +
        '<div class="cal-bars">' +
          list.slice(0, 3).map(o => '<div class="cal-bar' + (o.done ? ' done' : '') + '" style="--c:' + safeColor(o.layer.color) + '">' +
            (o.time ? '<b>' + esc(fmtTimeRange(o.time)) + '</b> ' : '') + esc(o.title) + '</div>').join('') +
          (list.length > 3 ? '<div class="cal-more">+' + (list.length - 3) + ' more</div>' : '') +
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

  function weekHtml() {
    const s = weekStart(cursor), e = addDays(s, 6);
    const occ = occurrences(s, e);
    let html = '<div class="cal-week">';
    for (let i = 0; i < 7; i++) {
      const day = addDays(s, i);
      html += dayBlock(day, occ.filter(o => o.day === day), true);
    }
    return html + '</div>';
  }

  function listHtml() {
    const from = today(), to = addDays(from, 60);
    const occ = occurrences(from, to);
    if (!occ.length) return '<p class="empty-msg">Nothing in the next two months on the calendars you have switched on.</p>';
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
        ((isOwner() || ydCan('calendars', 'change')) ? '<button class="cal-plus" onclick="calAdd(\'' + day + '\')" aria-label="Add on this day">+</button>' : '') +
      '</div>' +
      (list.length ? list.map(entryHtml).join('') : '<div class="cal-none">Nothing scheduled</div>') +
    '</div>';
  }

  function entryHtml(o) {
    const click = o.auto === 'storm' ? 'calOpenStorm()'
      : o.auto === 'equipment' ? 'calOpenEquipment(\'' + o.id + '\')'
      : o.auto === 'card' ? 'calOpenCard(\'' + o.boardId + '\', \'' + o.id + '\')'
      : 'calOpen(\'' + o.calId + '\', \'' + o.id + '\', \'' + o.day + '\')';
    const time = o.time ? fmtTimeRange(o.time, o.endTime) : 'All day';
    return '<div class="cal-entry' + (o.done ? ' done' : '') + '" style="--c:' + safeColor(o.layer.color) + '" onclick="' + click + '">' +
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

  window.calView = function (v) { view = v; if (v === 'month') selected = cursor; render(); };
  window.calToday = function () { cursor = today(); selected = cursor; render(); };
  window.calStep = function (n) {
    cursor = view === 'month' ? addMonths(cursor.slice(0, 8) + '01', n)
      : view === 'week' ? addDays(cursor, 7 * n) : cursor;
    if (view === 'month') selected = cursor.slice(0, 7) === today().slice(0, 7) ? today() : cursor;
    render();
  };
  window.calPick = function (day) {
    selected = day;
    render();
    const p = document.querySelector('.cal-daypanel');
    if (p && window.matchMedia('(max-width:720px)').matches) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  window.calToggle = function (id) {
    // With everything on, tapping one calendar shows just that one -- that is
    // what someone tapping a single colour almost always wants. After that,
    // taps add and remove calendars one at a time.
    const all = layers();
    if (all.every(l => !hidden.has(l.id))) {
      hidden = new Set(all.map(l => l.id).filter(x => x !== id));
    } else if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    if (all.every(l => hidden.has(l.id))) hidden = new Set();
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

  window.calOpen = function (calId, eventId, day) {
    const cal = cals[calId];
    const ev = cal && (events[calId] || {})[eventId];
    if (!ev) return;
    const when = ev.allDay ? 'All day' : fmtTimeRange(ev.time, ev.endTime);
    const mapUrl = ev.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.address) : '';
    openModal(esc(ev.title || ev.jobName || 'Event'),
      '<div class="cal-detail" style="--c:' + safeColor(cal.color) + '">' +
        '<div class="cal-detail-cal"><span class="cal-dot"></span>' + esc(cal.name) + '</div>' +
        '<div class="cal-detail-when">' + longDay(day || ev.date) + ' · ' + esc(when) +
          (ev.endDate && ev.endDate > ev.date ? '<br><span class="muted">' + shortDay(ev.date) + ' to ' + shortDay(ev.endDate) + '</span>' : '') +
          (ev.repeat && ev.repeat !== 'none' ? '<br><span class="muted">' + REPEAT[ev.repeat] +
            (ev.repeatUntil ? ' until ' + shortDay(ev.repeatUntil) : '') + '</span>' : '') +
        '</div>' +
        (ev.jobName ? '<div class="cal-detail-line">📋 ' + esc(ev.jobName) + '</div>' : '') +
        (ev.address ? '<a class="snow-addr" href="' + mapUrl + '" target="_blank" rel="noopener">📍 ' + esc(ev.address) +
          '<span class="snow-go">Directions</span></a>' : '') +
        ((ev.crew || []).length ? '<div class="cal-detail-line">👷 ' + ev.crew.map(c =>
          '<span class="cal-face" style="--c:' + personColor(c.uid) + '">' + esc(nameOf(c)) + '</span>').join(' ') + '</div>' : '') +
        (ev.notes ? '<div class="bd-notes">' + esc(ev.notes) + '</div>' : '') +
      '</div>' +
      '<div class="field-actions">' +
        (editsCal(cals[calId]) ? '<button class="btn btn-filled" onclick="calEdit(\'' + calId + '\', \'' + eventId + '\')">Edit</button>' : '') +
        (ydCan('jobs', 'see') && ev.jobId ? '<button class="btn btn-sm" onclick="calOpenJob(\'' + ev.jobId + '\')">Open the job</button>' : '') +
        '<button class="btn btn-sm" onclick="closeCalModal()">Close</button>' +
      '</div>');
  };

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

  window.calAdd = function (day) {
    if (!isOwner() && !ydCan('calendars', 'change')) return;
    editing = { calId: '', eventId: '', date: day || dayForNew() };
    renderEditor();
  };

  // The day a new entry starts on when no particular day was tapped: the one
  // picked in month view, and in week view the week on screen -- today if it
  // is in that week, otherwise its first day. Always using today put entries
  // meant for next week into this one.
  function dayForNew() {
    const t = today();
    if (view === 'month') return selected || t;
    if (view === 'week') {
      const s = weekStart(cursor);
      return t >= s && t <= addDays(s, 6) ? t : s;
    }
    return t;
  }
  window.calEdit = function (calId, eventId) {
    editing = { calId: calId, eventId: eventId };
    renderEditor();
  };

  function renderEditor() {
    const list = editableCals();
    if (!list.length) { showToast('Calendars are still loading'); return; }
    const ev = editing.eventId ? (events[editing.calId] || {})[editing.eventId] || {} : {};
    const calId = editing.calId || (lastCal && cals[lastCal] ? lastCal : list[0].id);
    const crew = crewPeople();
    const chosen = new Set((ev.crew || []).map(c => c.uid));
    const jobs = (typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id && (j.jobStatus || 'quoting') !== 'complete')
      .sort((a, b) => String(a.customerName || '').localeCompare(b.customerName || ''));
    const allDay = ev.allDay != null ? ev.allDay : !ev.time;

    openModal(editing.eventId ? 'Edit' : 'Add to the calendar',
      '<div class="field"><span class="label">Calendar</span><div class="cal-pickcal">' +
        list.map(c => '<label class="cal-pickcal-item" style="--c:' + safeColor(c.color) + '">' +
          '<input type="radio" name="evCal" value="' + c.id + '"' + (c.id === calId ? ' checked' : '') +
          ' onchange="calCalChanged()"><span><span class="cal-dot"></span>' + esc(c.name) + '</span></label>').join('') +
      '</div></div>' +
      '<div class="field"><span class="label">Job</span><select id="evJob" onchange="calJobChanged()">' +
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
          '<input type="time" id="evTime" value="' + esc(ev.time || '07:00') + '"></div>' +
        '<div class="field"><span class="label">Ends</span>' +
          '<input type="time" id="evEndTime" value="' + esc(ev.endTime || '') + '"></div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Repeats</span><select id="evRepeat">' +
          Object.keys(REPEAT).map(r => '<option value="' + r + '"' + ((ev.repeat || 'none') === r ? ' selected' : '') + '>' +
            REPEAT[r] + '</option>').join('') + '</select></div>' +
        '<div class="field"><span class="label">Repeat until (optional)</span>' +
          '<input type="date" id="evUntil" value="' + esc(ev.repeatUntil || '') + '"></div>' +
      '</div>' +
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
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="calSave()">Save</button>' +
        '<button class="btn btn-sm" onclick="closeCalModal()">Cancel</button>' +
        (editing.eventId ? '<button class="btn btn-sm" onclick="calRemove()">Delete</button>' : '') +
      '</div>');
    calCalChanged();
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

  window.calSave = function () {
    if (!editing) return;
    const c = document.querySelector('input[name="evCal"]:checked');
    if (!c) { showToast('Pick a calendar'); return; }
    const calId = c.value;
    // Both ends of a move: the calendar it is going to, and the one it leaves.
    if (!editsCal(cals[calId]) || (editing.calId && !editsCal(cals[editing.calId]))) {
      showToast('You cannot change that calendar');
      return;
    }
    const jobId = val('evJob');
    const job = jobId ? (loadAllJobs() || []).find(j => j._id === jobId) : null;
    const title = val('evTitle') || (job ? (job.customerName || 'Job') : '');
    if (!title) { showToast('Give it a title'); return; }
    const date = val('evDate');
    if (!date) { showToast('Pick a date'); return; }
    let end = val('evEnd');
    if (end && end < date) { showToast('"Until" is before the start date'); return; }
    const allDay = el('evAllDay').checked;
    // A repeat that stops before it starts would save and then never show
    // up anywhere, which looks exactly like the entry being lost.
    const repeat = val('evRepeat') || 'none';
    const until = val('evUntil');
    if (repeat !== 'none' && until && until < date) {
      showToast('"Repeat until" is before the start date'); return;
    }
    // Times are on the same day unless "Until" says otherwise, so work that
    // runs past midnight is entered with an end date rather than refused.
    const startT = allDay ? '' : val('evTime');
    const endT = allDay ? '' : val('evEndTime');
    if (startT && endT && endT < startT && !(end && end > date)) {
      showToast('"Ends" is before "Starts" — for work past midnight, set "Until" to the next day'); return;
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

    // Moving an event to a different calendar is a delete and a create, since
    // the calendar is part of where it is stored.
    const id = editing.eventId && editing.calId === calId ? editing.eventId : newId('ev');
    const was = editing.eventId ? (events[editing.calId] || {})[editing.eventId] : null;
    rec.createdAt = (was && was.createdAt) || nowIso();
    if (editing.eventId && editing.calId !== calId) {
      delete events[editing.calId][editing.eventId];
      removeEvent(editing.calId, editing.eventId);
    }
    events[calId] = events[calId] || {};
    events[calId][id] = Object.assign({ id: id }, rec);
    lastCal = calId;
    write('calendars/' + calId + '/events', id, rec, 'saving ' + title);
    closeCalModal();
    cursor = date; selected = date;
    render();
    showToast('Saved to ' + cals[calId].name);
  };

  window.calRemove = function () {
    if (!editing || !editing.eventId || !editsCal(cals[editing.calId])) return;
    const ev = (events[editing.calId] || {})[editing.eventId];
    if (!ev) return;
    const many = ev.repeat && ev.repeat !== 'none';
    if (!confirm('Delete "' + (ev.title || 'this') + '"' + (many ? ' and every repeat of it' : '') + '?')) return;
    delete events[editing.calId][editing.eventId];
    removeEvent(editing.calId, editing.eventId);
    closeCalModal(); render();
  };

  function removeEvent(calId, eventId) {
    Promise.resolve(window.YDDb.remove('calendars/' + calId + '/events', eventId))
      .catch(e => console.warn('[calendar] event not removed:', e.code || e.message));
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
          '> Private — admins never see it, whatever their access</label>') +
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
      // could include the owner's Personal calendar.
      unsubCals = window.YDDb.watchWhere('calendars', 'ownerOnly', false, onCals, () => redrawIfVisible());
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

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
