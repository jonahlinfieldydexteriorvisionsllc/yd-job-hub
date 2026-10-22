// Calendars: where the crew are working, Jonah's own work, his personal life,
// storms and anything else with a date -- each kind of thing in its own
// colour, with one view that lays all of it on top of each other.
//
// TWO KINDS OF LAYER, and the difference matters.
//
// STORED calendars live in calendars/{id} with their events in
// calendars/{id}/events: the Crew schedule, My work and Personal (SEED), and
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

  // Jonah (15 Oct 2026): "i dont want a million separate calendars i just
  // want tags and assigned colors for different things." Three calendars,
  // and what each thing is is its kind (remind.js TYPES):
  //   - the Crew schedule: "where the crews working, crew tasks, anything i
  //     assign crew members to" -- kept shared with everybody ticked as
  //     crew on Your Crew (shareCrewCals);
  //   - My work: his own -- quote appointments (QP), pickups, emails to
  //     send, things to do;
  //   - Personal: "anything i do not to do with the business", doctor's
  //     appointments yellow and the rest pink.
  // "Admins can see all 3 calendars. Crew can only see crew calander." So
  // none is ownerOnly any more; Personal is `seeOnly` -- an admin looks but
  // never changes it (the Job schedule, below, made a fourth on 16 Oct).
  // Fixed ids, so two devices seeding at the same moment
  // write the same three rather than six. Site visits and Follow-ups were
  // folded into My work that day (`mergedInto`; never shown again).
  // A day later (16 Oct 2026): "Let the crew see My work. They can look but
  // not change anything." My work is `crewSees` (shared with every crew
  // member, as the Crew schedule is -- shareCrewCals) and `lookOnly` (those
  // it is shared with tick nothing off; firestore.rules hold the same).
  // The same day: "within the calendars I want tags ... I want the separate
  // calendars and within them have tags. The crew calendar should have tags
  // and set colors for material pickups etc. and then the job calendar will
  // be solely for where the crew is working each day." So a fourth, the Job
  // schedule (kind `jobs`): every entry on it is a day on a job -- the job,
  // who is working there, the days -- drawn in that job's colour; the crew
  // see it and change nothing on it (crewSees, lookOnly). The Crew schedule
  // keeps the crew's tasks, each tagged (remind.js CAL_TAGS): material
  // pickup, delivery, equipment repair, shop / yard work, errand, crew task.
  const SEED = [
    { id: 'schedule', name: 'My work', color: '#66418f', kind: 'work', order: 1, crewSees: true, lookOnly: true,
      about: 'Your own work: quote appointments, pickups, emails to send — the crew can look' },
    { id: 'jobs', name: 'Job schedule', color: '#1a9c8c', kind: 'jobs', order: 2, crewSees: true, lookOnly: true,
      about: 'Where the crew is working each day — the crew can look' },
    { id: 'crewtasks', name: 'Crew schedule', color: '#2f6fd6', kind: 'crew', order: 3,
      about: 'The crew’s tasks: pickups, deliveries, repairs, shop work, errands — the crew see this one' },
    { id: 'personal', name: 'Personal', color: '#d94f8a', kind: 'personal', order: 4, seeOnly: true,
      about: 'Not to do with the business — you, and admins can look' },
  ];
  const WORK_CAL = 'schedule', JOBS_CAL = 'jobs';
  // Before the Job schedule (16 Oct 2026) the Crew schedule was second and
  // Personal third: moved down one, once, when the Job schedule is made.
  const OLD_ORDER = { crewtasks: 2, personal: 3 };

  // What an entry is (a bid appointment, a pickup...) and when it buzzes the
  // phone by itself: remind.js. For an all-day entry the time counts back
  // from 7 am that day.
  // Its tag on the calendar it is on (remind.js typeOf / tagOf): the
  // calendar's own list decides.
  const typeOfEv = (ev, cal) => YDRemind.typeOf(ev, { cal: cal });
  const tagOfEv = (ev, cal) => YDRemind.tagOf(typeOfEv(ev, cal), cal);
  // How an entry stands on its calendar, as remind.js reads it.
  const whereOf = (ev, cal) => ({ cal: cal, calKind: cal && cal.kind, typed: YDRemind.knownOn(cal, ev && ev.type) });
  const isTimed = ev => !ev.allDay && !!ev.time;
  // At a set time and ending the next day no later than it started: work
  // past midnight (segOf draws it that way), not a two-day job.
  const overnight = ev => isTimed(ev) && !!ev.endTime && !!ev.endDate && daysBetween(ev.date, ev.endDate) === 1 &&
    minutesOf(ev.endTime) != null && minutesOf(ev.endTime) <= minutesOf(ev.time);

  const AUTO = {
    // A deeper blue than the storm card on Home: white words must read on it.
    'auto:storms': { id: 'auto:storms', name: 'Storm nights', color: '#17809e', auto: true,
                     about: 'From the Snow tab' },
    'auto:equipment': { id: 'auto:equipment', name: 'Equipment due', color: '#6f6a2e', auto: true,
                        ownerOnly: true, about: 'Service dates from the Equipment tab' },
    'auto:cards': { id: 'auto:cards', name: 'Board due dates', color: '#6b7a8f', auto: true,
                    about: 'Cards with a due date' },
    // Jonah (7 Oct): the crew's recurring tasks on the calendar, every week
    // ahead -- worked out from the list on the Crew tasks board
    // (recurring.js), never copied in.
    // Blue, as every crew task is (remind.js, Jonah 12 Oct).
    'auto:recurring': { id: 'auto:recurring', name: 'Recurring crew tasks', color: '#2f6fd6', auto: true,
                        about: 'Recurring crew tasks, from the Crew tasks board' },
    // Jonah (14 Oct 2026): the day to start reaching out to people for next
    // season's work -- worked out from the date on the Contacts tab
    // (prospects.js), never stored as an entry, so moving the date moves it.
    // The owner's alone (only he can read the date).
    'auto:outreach': { id: 'auto:outreach', name: 'Next season outreach', color: '#2f8f5b', auto: true,
                       about: 'The start date on the Contacts tab' },
  };
  // {start: 'YYYY-MM-DD', due(day)} once the owner has set the date, else null.
  const outreachInfo = () => (window.YDProspects && YDProspects.outreach ? YDProspects.outreach() : null);

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
  // My day (12 Oct 2026): one person's day -- what is theirs, in order.
  const VIEWS = [['myday', 'My day'], ['day', 'Day'], ['3day', '3 days'], ['week', 'Week'], ['month', 'Month'], ['schedule', 'List']];
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
  let peopleLoaded = false; // the users list has come from the server (owner, admin)
  let calsHeard = false;    // the calendars have answered at least once (Home waits for it)

  let view = loadView();    // one of VIEWS (null until the first draw picks one)
  let cursor = '';          // the day the view is on (set on first draw)
  let selected = '';        // the day picked in month view
  let miniMonth = '';       // the month the small calendar shows, YYYY-MM-01
  let sideOpen = false;     // phone: the calendars list is open
  let hidden = loadHidden();// layer ids switched off
  let onlyMineOn = false;   // "👤 Only mine" in the side (remind.js isMine)
  let editing = null;       // { calId, eventId, occ, date, time } in the editor
  let lastCal = null;       // calendar last added to, offered first next time
  let drawn = {};           // key -> the occurrence drawn with that key
  let shown = null;         // the occurrence open in the details window
  let pending = null;       // waiting for "this date / the ones after / every date"
  let drag = null;          // an entry being dragged
  let justDragged = 0;      // a drag ends in a click; that click opens nothing
  let gridScroll = null;     // where the hours were scrolled to (null: not yet)
  let drawFrame = 0;        // a redraw waiting for the next frame (redrawIfVisible)

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const isPhone = () => window.matchMedia('(max-width:720px)').matches;
  // An admin given Calendars sees every calendar except any the owner marks
  // private (ownerOnly) -- and with "change" adds and edits events on them,
  // but never on Personal (seeOnly). Making, sharing and deleting calendars
  // stays the owner's.
  const seesAllCals = () => ydCan('calendars', 'see');
  // ...and anyone the owner ticked under "Who can add & change" on that one
  // calendar (`editors`; Jonah, 12 Oct 2026: "select specific calendars and
  // boards that the guys can change not just set it so they can change every
  // single one they have access to").
  const editsCal = cal => !!cal && (isOwner() ||
    (ydCan('calendars', 'change') && cal.ownerOnly === false && cal.seeOnly !== true) ||
    (!!me() && (cal.editors || []).indexOf(me().uid) !== -1));
  const editableCals = () => storedCals().filter(editsCal);
  // Shared with this person to look at only (`lookOnly`): they tick nothing
  // off on it, and its things are not on their lists of things to do.
  const looksOnly = cal => !!cal && cal.lookOnly === true && !editsCal(cal);
  const adds = () => isOwner() || ydCan('calendars', 'change') || editableCals().length > 0;
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
      (l.id !== 'auto:recurring' || (window.YDRecurring && YDRecurring.visible())) &&
      (l.id !== 'auto:outreach' || !!outreachInfo()));
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
  // The tags switched off within a calendar ("calendarId:tagId"), as the
  // calendars are: a tap on a tag in "Calendars & tags" hides that kind
  // of thing from the calendar on this device, and "Show everything" brings
  // it all back.
  const tagKey = (calId, type) => calId + ':' + (type || '');
  let tagsOff = (() => {
    try { return new Set(JSON.parse(localStorage.getItem('ydjobhub_calTagsOff') || '[]')); } catch (e) { return new Set(); }
  })();
  function saveTagsOff() {
    try { localStorage.setItem('ydjobhub_calTagsOff', JSON.stringify(Array.from(tagsOff))); } catch (e) { /* private window: just not kept */ }
  }
  // Only the tags still on a calendar this person sees count as switched
  // off (one taken off a calendar's list since stays out of the count).
  const tagsOffNow = () => storedCals().reduce((n, c) => n +
    YDRemind.tagsOf(c).filter(t => tagsOff.has(tagKey(c.id, t.id))).length, 0);

  // ------------------------------------------------------- a job's colour
  //
  // Every day of one job reads the same colour (Jonah, 16 Oct 2026: the job
  // calendar "solely for where the crew is working each day"): the colour
  // its card was given on the Bids and Jobs boards (cardColor) -- read from
  // the job where this device has it (the owner's, an admin's), else from
  // the copy kept on the entry (`jobColor`, kept in step by the owner's
  // device: fillJobColors) for the crew, who cannot read jobs. A job given
  // no colour gets one of JOB_COLORS, picked from its id, so it is the
  // same on every phone and two jobs on one day are told apart.
  const JOB_COLORS = ['#1a9c8c', '#3f51b5', '#8e5bc7', '#2e7d32', '#ad1457', '#00838f', '#6d4c41', '#5c6bc0', '#7b1fa2', '#558b2f'];
  const isHex = c => /^#[0-9a-fA-F]{6}$/.test(String(c || ''));
  let jobsSeen = null, jobsMap = {};
  function jobById(id) {
    const all = typeof loadAllJobs === 'function' && ydCan('jobs', 'see') ? loadAllJobs() : null;
    if (!all) return null;
    if (all !== jobsSeen) {
      jobsSeen = all; jobsMap = {};
      all.forEach(j => { if (j && j._id) jobsMap[j._id] = j; });
    }
    return jobsMap[id] || null;
  }
  function hashOf(s) {
    let h = 0;
    for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
  }
  // The colour a job's own card has, as this device knows it ('' none).
  function cardColorOf(ev) {
    const j = ev && ev.jobId ? jobById(ev.jobId) : null;
    const own = j ? j.cardColor : ev && ev.jobColor;
    return isHex(own) ? own : '';
  }
  function jobColorOf(ev, cal) {
    if (!ev || !ev.jobId) return (cal && cal.color) || '';
    return cardColorOf(ev) || JOB_COLORS[hashOf(ev.jobId) % JOB_COLORS.length];
  }

  // Every occurrence of everything between two days, inclusive, as flat
  // entries ready to draw: { day, layer, title, time, ev, ... }. `ev` is the
  // entry as it is on that date (its own date, or what was changed for it);
  // `orig` is the date a repeat fell on, which names its single-date change.
  // `everything`: every layer, whatever is ticked in the side (My day).
  // `cardsOnly`: just the board cards and the recurring crew tasks (Home's
  // late list looks months back, and needs none of the rest).
  function occurrences(from, to, everything, cardsOnly) {
    const out = [];
    const uid = me() && me().uid;
    const w = YDRemind.who(people);
    const off = id => !everything && hidden.has(id);
    const onlyMine = !everything && onlyMineOn;

    if (!cardsOnly) Object.keys(events).forEach(cid => {
      const cal = cals[cid];
      if (!cal || off(cid)) return;
      Object.values(events[cid]).forEach(base => {
        occurrencesOf(base, from, to).forEach(x => {
          const ev = x.ev;
          if (onlyMine && !YDRemind.eventIsMine(ev, cal, w)) return;
          const name = ev.title || (ev.jobName ? ev.jobName : 'Untitled');
          const type = typeOfEv(ev, cal), tag = YDRemind.tagOf(type, cal) || null, ic = tag ? tag.icon : '';
          const where = whereOf(ev, cal);
          // A job's day (everything on the Job schedule; one picked as such
          // before it existed): no tick box, never "not done".
          const jobDay = YDRemind.isJobDay(type, where);
          // A tag switched off in "Calendars & tags" (tagsOff) is not
          // drawn -- on this screen; My day, Home and the counts read the
          // whole day, as they do with a calendar switched off.
          if (!everything && !jobDay && tagsOff.has(tagKey(cid, type))) return;
          // Work at a set time that runs past midnight into the next morning
          // is one thing, done or not on the day it starts: the piece after
          // midnight shares that day's tick (`doneKey`) and is not a second
          // task left undone (`after`).
          const night = overnight(ev), key = night ? ev.date : x.day;
          const mark = base.done && base.done[key];
          // A job's day in its job's own colour, the same every day it is
          // on (jobColorOf); anything else in its tag's.
          const color = jobDay ? jobColorOf(ev, cal) : (tag && tag.color) || '';
          out.push({
            day: x.day, layer: cal, ev: ev, calId: cid, id: base.id, orig: x.orig,
            title: (ic ? ic + ' ' : '') + name, name: name,
            color: color, ink: !jobDay && tag && tag.ink ? tag.ink : '', type: type,
            tagName: tag ? tag.name : '', crewTag: !!(tag && tag.crew),
            // Has to be ticked off (remind.js isTask), or it is "not done".
            task: YDRemind.isTask(type, isTimed(ev), where), after: key !== x.day,
            // Ticked off on the "any time" list, date by date (a repeat too).
            done: !!mark, doneAt: (mark && mark.at) || '', doneKey: key,
            time: ev.allDay ? '' : ev.time, endTime: ev.allDay ? '' : ev.endTime,
            crew: ev.crew || [], address: ev.address || '', jobName: ev.jobName || '',
            multi: !!(ev.endDate && ev.endDate > ev.date), changed: x.changed,
            jobDay: jobDay,
          });
        });
      });
    });

    if (!off('auto:storms') && !onlyMine && !cardsOnly) {
      Object.values(storms).forEach(s => {
        // Its one status (stages.js): an abandoned storm is not shown.
        const st = window.YDStages.storm(s);
        if (!s.startedAt || st.id === 'abandoned') return;
        const day = dayOf(new Date(s.startedAt));
        if (day < from || day > to) return;
        out.push({ day: day, layer: AUTO['auto:storms'], auto: 'storm', id: s.id,
          title: '❄️ ' + (s.label ? 'Storm — ' + s.label : 'Storm'),
          time: fmtClock(s.startedAt), note: st.name });
      });
    }

    if (ydCan('equipment', 'see') && !off('auto:equipment') && !onlyMine && !cardsOnly && window.YDEquipment) {
      Object.values(YDEquipment.all()).forEach(g => {
        if (!g.dueDate || g.dueDate < from || g.dueDate > to) return;
        // Done when its service is logged, which moves the due date on: a
        // date still showing is a service not done yet.
        out.push({ day: g.dueDate, layer: AUTO['auto:equipment'], auto: 'equipment', id: g.id, task: true,
          title: '🚜 ' + (g.name || 'Machine') + ' service due' });
      });
    }

    if (!off('auto:cards') && window.YDBoards) {
      YDBoards.dueCards().forEach(x => {
        if (x.card.due < from || x.card.due > to) return;
        // A Maintenance card is the machine's own due date, which the
        // Equipment layer already shows -- listing both put it on the day twice.
        if (x.card.auto && x.card.equipmentId && ydCan('equipment', 'see')) return;
        // A recurring task's card is drawn by the Crew tasks layer below.
        if (x.card.recurring && window.YDRecurring && YDRecurring.visible()) return;
        if (onlyMine && !YDRemind.cardIsMine(x.card, x.board, w)) return;
        const type = YDRemind.typeOf(x.card, { boardId: x.board.id });
        const ic = YDRemind.icon(type) || '📌';
        // A card with a time sits at that hour (an hour long); without one,
        // with the day's all-day entries.
        const time = /^\d{2}:\d{2}$/.test(x.card.dueTime || '') ? x.card.dueTime : '';
        out.push({ day: x.card.due, layer: Object.assign({}, AUTO['auto:cards'], { color: x.board.color }),
          color: YDRemind.color(type), ink: YDRemind.ink(type), type: type,
          time: time, task: YDRemind.isTask(type, !!time, { card: true }),
          auto: 'card', id: x.card.id, boardId: x.board.id, done: x.done, doneAt: x.card.doneAt || '',
          title: ic + ' ' + (x.card.title || 'Card'), note: x.board.name,
          crew: x.card.assignees || [] });
      });
      // A pickup with no date is ready now: today's, every day until it is
      // picked up (boards.js pickupsWaiting).
      const t = today();
      if (t >= from && t <= to) {
        YDBoards.pickupsWaiting().forEach(x => {
          if (onlyMine && !YDRemind.cardIsMine(x.card, x.board, w)) return;
          out.push({ day: t, layer: Object.assign({}, AUTO['auto:cards'], { color: x.board.color }),
            color: YDRemind.color(x.type), ink: YDRemind.ink(x.type), type: x.type, time: '', task: true, undated: true,
            auto: 'card', id: x.card.id, boardId: x.board.id, done: x.done, doneAt: x.card.doneAt || '',
            title: YDRemind.icon(x.type) + ' ' + (x.card.title || 'Card'), note: x.board.name + ' · ready to pick up',
            crew: x.card.assignees || [] });
        });
      }
    }

    if (!off('auto:recurring') && window.YDRecurring && YDRecurring.visible()) {
      const rc = (YDBoards.cards() || {}).crew || {};
      YDRecurring.dues(from, to).forEach(x => {
        out.push({ day: x.day, layer: AUTO['auto:recurring'], auto: 'recurring', id: x.cardId, boardId: 'crew',
          done: x.done, doneAt: (x.cardId && rc[x.cardId] && rc[x.cardId].doneAt) || '',
          // Where its card is: the board (the Crew tasks calendar is
          // another thing -- one-off tasks -- and "Crew tasks" alone
          // beside "Recurring crew tasks" read as the calendar).
          title: '🔁 ' + x.what, note: 'Crew tasks board', type: 'crew', task: true,
          color: YDRemind.color('crew') });
      });
    }

    // His own reminder, so "Only mine" keeps it.
    const oi = outreachInfo();
    if (oi && !off('auto:outreach') && !cardsOnly && oi.start >= from && oi.start <= to) {
      const n = oi.due(oi.start);
      // Shown done once the day has come and nobody is left to reach.
      out.push({ day: oi.start, layer: AUTO['auto:outreach'], auto: 'outreach', id: 'outreach', done: !n && oi.start <= today(),
        title: '📞 Start reaching out for next season', name: 'Start reaching out for next season',
        note: n ? n + (n === 1 ? ' person' : ' people') + ' to reach — Contacts' : 'Contacts tab' });
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
    // Nor under a swipe: drawn once it has settled (settle).
    if ((pan && pan.dir) || settling || wheel) { panRedraw = true; return; }
    // A finger still holding (not yet dragging) would be left holding an
    // entry no longer on the page: it lets go instead.
    if (drag) stopDrag();
    // The crew start on their own day; the owner's phone in 3 days (his
    // answer, 6 Oct), a computer in the week.
    if (!view) view = !isOwner() && !(window.YDAuth && window.YDAuth.isAdmin) ? 'myday' : isPhone() ? '3day' : 'week';
    if (!cursor) { cursor = today(); selected = cursor; }
    if (!miniMonth) miniMonth = cursor.slice(0, 8) + '01';
    // Where the hours are scrolled to, read off the grid -- only one that
    // was on screen when it was placed: one drawn hidden reads 0, which is
    // not where it was.
    const old = wrap.querySelector('.cg-scroll');
    if (old && old.clientHeight && old.dataset.placed) gridScroll = old.scrollTop;
    // Drawn now: a redraw already waiting for the next frame has nothing
    // left to do.
    if (drawFrame) { cancelAnimationFrame(drawFrame); drawFrame = 0; }
    drawn = {};
    countMemo = {};
    // The "any time" list goes in two places -- down the side on a computer,
    // above the calendar on a phone (the stylesheet shows one) -- built once.
    // My day has it in the page already.
    const anyTime = view === 'myday' ? '' : todayHtml();
    wrap.innerHTML = filtersHtml() + '<div class="cal-shell">' +
        '<aside class="cal-side' + (sideOpen ? ' open' : '') + '">' + sideHtml() + '</aside>' +
        '<div class="cal-main">' + topHtml() +
          // A phone has the side folded away behind ☰: the list goes on top.
          anyTime +
          '<div class="cal-body" id="calBody">' +
            (view === 'month' ? monthHtml() : view === 'schedule' ? listHtml() : view === 'myday' ? myDayHtml()
              : gridHtml(gridDays())) +
          '</div>' +
        '</div>' +
      '</div>';
    if (isGrid()) { fitGrid(); placeScroll(); }
    wireSlots();
    wireHolds();
  }

  // The crew get three ways to look -- their day, the week, the month --
  // as bigger buttons: six small ones in a row were hard to hit with a
  // glove, and Day / 3 days / List are the office's. A view they reach
  // another way (a day's heading in Month opens Day) keeps its button
  // while it is on screen, so they can see where they are.
  const CREW_VIEWS = ['myday', 'week', 'month'];
  const crewViews = () => !isOwner() && !(window.YDAuth && window.YDAuth.isAdmin);
  function shownViews() {
    if (!crewViews()) return VIEWS;
    return VIEWS.filter(([v]) => CREW_VIEWS.indexOf(v) !== -1 || v === view);
  }

  function topHtml() {
    return '<div class="cal-top">' +
        '<div class="cal-nav">' +
          '<button class="btn btn-sm cal-side-btn" onclick="calSide()" aria-label="Pick a day">☰</button>' +
          '<button class="btn btn-sm" onclick="calToday()">Today</button>' +
          '<button class="cal-arrow" onclick="calStep(-1)" aria-label="Back">‹</button>' +
          '<button class="cal-arrow" onclick="calStep(1)" aria-label="Forward">›</button>' +
          '<span class="cal-title">' + titleFor() + '</span>' +
        '</div>' +
        '<div class="cal-views">' +
          '<div class="cal-seg' + (crewViews() ? ' cal-seg-crew' : '') + '">' + shownViews().map(([v, n]) => '<button class="cal-vbtn' + (view === v ? ' on' : '') +
            '" onclick="calView(\'' + v + '\')">' + n + '</button>').join('') + '</div>' +
          (adds() ? '<button class="btn btn-sm btn-accent cal-add" onclick="calAdd()">+ Add</button>' : '') +
        '</div>' +
      '</div>';
  }

  // ------------------------------------------------------ any time today
  //
  // Jonah (12 Oct 2026): "some cards dont have a specific time to be
  // completed that day but need to be done that day ... a small board on the
  // side of the calendar view so theres also a checklist of just stuff that
  // needs to be done each day but not at specific times." Everything on the
  // day in view with no time -- all-day entries, cards due with no time, the
  // week's crew tasks, machines due -- to tick off here. His first, then the
  // crew's (not his to handle, but he sees them all); each sorted by kind,
  // what is done at the foot. Down the side on a computer; above the
  // calendar on a phone, folding away with a tap.
  //
  // Ticking a card moves it to Done, as a drag there would (a recurring task
  // is confirmed, a machine's service form opens). Ticking a calendar entry
  // marks that one date done: done {YYYY-MM-DD: {at, by}} on the entry, so a
  // repeat is done date by date, and the reminders skip it.
  let todayFolded = (() => { try { return localStorage.getItem('ydjobhub_calTodayFolded') === '1'; } catch (e) { return false; } })();
  // Above the calendar (a phone, a narrow window: the stylesheet puts it
  // there at 900px and under) the open list took a third of the screen over
  // every view, every time. There it opens the first time the calendar is
  // looked at each day -- so the day's list is seen -- and from then on
  // starts folded to its one line with the count, a tap away. Remembered
  // per device (ydjobhub_calTodaySeen: the day it was last seen open). A
  // tap to open or fold it holds until the calendar is next opened.
  const listOnTop = () => window.matchMedia('(max-width:900px)').matches;
  const TODAY_SEEN = 'ydjobhub_calTodaySeen';
  let topFold = null;       // the tap's choice on this visit; null: as the day goes
  function foldedNow() {
    if (!listOnTop()) return todayFolded;
    if (topFold != null) return topFold;
    let seen = '';
    try { seen = localStorage.getItem(TODAY_SEEN) || ''; } catch (e) {}
    if (seen === today()) return true;
    // Only a list actually on screen counts as seen (the calendar is also
    // drawn behind other tabs, at sign-in).
    const p = el('panel-calendar');
    if (!p || !p.classList.contains('active')) return false;
    try { localStorage.setItem(TODAY_SEEN, today()); } catch (e) {}
    topFold = false;          // open for the rest of this look
    return false;
  }
  // The crew's: a crew task, or anything on the Crew schedule -- whose it is
  // goes by the same rule (remind.js eventIsMine), or a pickup or a job's day
  // there with nobody on it was nobody's on the owner's Home: not his, and
  // not among the crew's either.
  // A day on the Job schedule is the crew's as well: where they are working.
  const isCrewOcc = o => (o.auto ? !!(YDRemind.typeById(o.type) || {}).crew : !!o.crewTag) ||
    (!o.auto && !!cals[o.calId] && (cals[o.calId].kind === 'crew' || cals[o.calId].kind === 'jobs'));
  // Who may tick a thing off. Jonah (15 Oct 2026): "Anyone a calendar is
  // shared with can tick anyone's task. Make this their own and 'anyone can
  // do' tasks only." So: whoever may change the calendar (or the card's
  // board) ticks anything; anyone else only what they are on, or what nobody
  // is on. firestore.rules hold the same for calendar entries (crewUids).
  function canTick(o) {
    if (o.auto === 'recurring' && !o.id) return false;  // only once this week's card exists
    if (o.auto === 'card' || o.auto === 'recurring') {
      if (window.YDBoards && YDBoards.editsBoard && YDBoards.editsBoard(o.auto === 'card' ? o.boardId : 'crew')) return true;
      return onlyOnesOwn(onUids(o));
    }
    if (o.auto) return false;                      // a machine is done by logging its service
    const cal = cals[o.calId], u = me();
    // A job's day is not ticked off (remind.js isJobDay / isTask).
    if (cal && o.jobDay && !o.task) return false;
    if (editsCal(cal)) return true;
    if (looksOnly(cal)) return false;
    if (!(cal && u && (cal.visibleTo || []).indexOf(u.uid) !== -1)) return false;
    // The rules look at everyone on the entry, on any of its dates
    // (crewUids); this date's own list on top.
    const base = (events[o.calId] || {})[o.id];
    return onlyOnesOwn(crewUidsOf(base || {})) && onlyOnesOwn(onUids(o));
  }
  // Theirs to tick: they are on it, or nobody is.
  function onlyOnesOwn(uids) {
    const u = me();
    return !uids.length || (!!u && uids.indexOf(u.uid) !== -1);
  }
  // Everyone on an entry, on its own date or any changed date of a repeat --
  // kept on the entry as `crewUids`, because the rules cannot look inside
  // the list of {uid, name} in `crew`.
  function crewUidsOf(ev) {
    const out = [];
    const add = list => (Array.isArray(list) ? list : []).forEach(c => {
      if (c && c.uid && out.indexOf(c.uid) === -1) out.push(c.uid);
    });
    add(ev.crew);
    Object.values(ev.exceptions || {}).forEach(x => { if (x && typeof x === 'object') add(x.crew); });
    return out.sort();
  }
  function todayHtml() {
    const day = dayForNew();
    const all = occurrences(day, day).filter(o => !o.time && o.auto !== 'storm');
    const group = (label, list) => !list.length ? '' :
      (label ? '<div class="cal-todo-group">' + label + '</div>' : '') + list.slice().sort(byKind).map(o => todoRow(o)).join('');
    // Where the crew is working that day (the Job schedule) heads the list:
    // not things to tick, but what the day is built round.
    const jobs = all.filter(o => o.jobDay);
    // A calendar this person only looks at (the crew and Jonah's work): its
    // things last, in a group of their own, with no boxes to tick.
    const look = all.filter(o => !o.jobDay && looksOnly(cals[o.calId]));
    const items = all.filter(o => !o.jobDay && look.indexOf(o) === -1);
    const lookNames = Array.from(new Set(look.map(o => calName(o.calId))));
    const mine = items.filter(o => !isCrewOcc(o)), crew = items.filter(isCrewOcc);
    // Tasks from the days before that nobody ticked off, at the top -- on
    // today's list only (a later day's "earlier" has not happened yet).
    const late = day === today() ? carried() : [];
    const folded = foldedNow();
    return '<div class="cal-today' + (folded ? ' folded' : '') + '">' +
      '<button class="cal-today-head" onclick="calTodayFold()" aria-expanded="' + !folded + '">✅ Any time ' +
        (day === today() ? 'today' : esc(shortDay(day))) + countHtml(dayCount(day)) +
        '<span class="cal-today-fold">' + (folded ? '▸' : '▾') + '</span></button>' +
      '<div class="cal-today-body">' + lateHtml(late, null, true) + jobDaysHtml(jobs) +
        (items.length ? group(crew.length && mine.length ? 'Yours' : late.length || jobs.length ? 'Today' : '', mine) + group('👷 Crew', crew)
          : '<div class="cal-today-none">' + (late.length || jobs.length ? 'Nothing else for today.' : 'Nothing for any time this day.') + '</div>') +
        group('👀 ' + esc(lookNames.join(', ')) + ' — to look at', look) +
      '</div></div>';
  }
  // A day's job days, under one heading: the job (in its colour), who is
  // there, and the time when it has one. `label`: the heading's words ('' for
  // none: My day has its own).
  function jobDaysHtml(list, label) {
    if (!list.length) return '';
    if (label === undefined) label = '🔨 Where the crew is working';
    return (label ? '<div class="cal-todo-group cal-jobs-group">' + label + '</div>' : '') +
      list.slice().sort((a, b) => String(to24(a.time || '')).localeCompare(String(to24(b.time || ''))) ||
        String(a.name).localeCompare(String(b.name)))
        // Nobody put on it: anyone on the crew (as the crew's job page says).
        .map(o => todoRow(o, [(o.crew || []).length ? whoOn(o) : '👷 Anyone', o.address].filter(Boolean).join(' · '),
          false, o.time ? fmtTimeRange(o.time, o.endTime || '') : '')).join('');
  }

  // ------------------------------------------------- not ticked off: carried
  //
  // Jonah (14 Oct 2026): tasks "have to be marked done or they get included
  // in the end day summary ... Appointments are different." A task (remind.js
  // isTask) left unticked on its day -- at a set time or not -- is not
  // forgotten when the day turns: it heads today's list as "From earlier",
  // with the day it was for, until it is ticked off (for that date: a
  // repeat's other dates are their own) or deleted. A fortnight back at most
  // (remind.js CARRY_DAYS). The evening summary and the 7 am list say the
  // same (functions/reminders.py open_tasks). Whatever is switched off in the
  // side, or "Only mine", is left out here as on the day itself.
  // One ticked off today stays in the list, ticked, until tomorrow -- so a
  // slip of the finger can be put back where it was.
  function carried(everything) {
    const t = today();
    const from = [addDays(t, -YDRemind.CARRY_DAYS), YDRemind.TICK_FROM].sort()[1];
    const to = addDays(t, -1);
    if (from > to) return [];
    // Not what someone only looks at: Jonah's to-dos are not theirs to carry.
    return occurrences(from, to, everything).filter(o => o.task && !o.after && (!o.done || doneToday(o)) &&
        !looksOnly(cals[o.calId]))
      .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || a.day.localeCompare(b.day) || byKind(a, b));
  }
  function doneToday(o) {
    const d = o.doneAt ? new Date(o.doneAt) : null;
    return !!d && !isNaN(d) && dayOf(d) === today();
  }
  // ------------------------------------------------- how many left to do
  //
  // Crew testing, 16 Oct 2026: for the same person on the same day Home
  // said "4 to do", the Week view's day list "5 to do", and My day "2 to do"
  // with 2 more from earlier. Each counted its own way -- everyone's or just
  // theirs, appointments or not, timed things or not, the calendars ticked
  // in the side or all of them, the days before folded in or not. Now there
  // is one count, in one set of words, wherever a day's figure shows (Home,
  // My day, the day list down the side, the "any time" list on a phone):
  //   - this person's own (remind.js isMine) -- the crew's tasks that are
  //     not theirs are the crew's count, on Home's crew card;
  //   - things that have to be ticked off (remind.js isTask, unchanged: an
  //     appointment never is), at a set time or not, not ticked off yet;
  //   - on every calendar, whatever is ticked in the side, as My day and
  //     Home read the day -- so hiding a calendar does not change the figure;
  //   - and apart from them, the ones carried from earlier days (carried).
  // "3 to do today · 2 from earlier"; "all done" once there were some and
  // none are left; nothing at all when there were none.
  // `all`: the day's occurrences on every calendar; `late`: carried(true).
  function tally(all, late, pick, day) {
    const tasks = all.filter(o => o.task && !o.after && pick(o));
    const earlier = late.filter(pick);
    return { day: day, today: tasks.filter(o => !o.done).length, earlier: earlier.filter(o => !o.done).length,
             any: tasks.length + earlier.length };
  }
  // This person's count for a day. Worked out once for each draw: the day
  // list and the "any time" list both show it (countMemo, emptied by render).
  let countMemo = {};
  function dayCount(day) {
    if (countMemo[day]) return countMemo[day];
    const w = YDRemind.who(people);
    if (!w) return null;
    return (countMemo[day] = tally(occurrences(day, day, true), day === today() ? carried(true) : [],
      o => occIsMine(o, w), day));
  }
  function countWords(c) {
    if (!c) return '';
    const parts = [];
    if (c.today) parts.push(c.today + ' to do' + (c.day === today() ? ' today' : ''));
    if (c.earlier) parts.push(c.earlier + ' from earlier');
    return parts.join(' · ') || (c.any ? 'all done' : '');
  }
  // The count where the day's lists are headed. Its title says whose it is:
  // a list down the side holds the crew's things too, for the owner.
  function countHtml(c) {
    const words = countWords(c);
    return words ? ' <span class="cal-today-n" title="Yours — the same count as Home and My day">' + esc(words) + '</span>' : '';
  }
  // Above the calendar on a phone, a long list of them would push the days
  // off the screen: the side list shows the first few and the rest on a tap
  // (`short`). My day, which is the list, shows them all.
  const LATE_SHOW = 4;
  let lateAll = false;
  function lateHtml(late, subOf, short) {
    if (!late.length) return '';
    const cut = short && !lateAll && late.length > LATE_SHOW + 1;
    return '<div class="cal-todo-group late">⏰ From earlier — not done</div>' +
      (cut ? late.slice(0, LATE_SHOW) : late).map(o =>
        todoRow(o, [shortDay(o.day), subOf ? subOf(o) : ''].filter(Boolean).join(' · '), !o.done)).join('') +
      (cut ? '<button class="link-btn cal-late-more" onclick="calLateAll(true)">Show all ' + late.length + ' from earlier</button>'
        : short && lateAll && late.length > LATE_SHOW + 1
          ? '<button class="link-btn cal-late-more" onclick="calLateAll(false)">Show fewer</button>' : '');
  }
  window.calLateAll = function (on) { lateAll = !!on; render(); };
  // One thing on the "any time" list: a tick box when this person may tick
  // it off, its kind's colour down the side, a tap to open it. `sub`: a
  // second line (who is on it). `late`: from an earlier day, not done.
  function todoRow(o, sub, late, at) {
    const k = keyOf(o);
    // Someone else's, with no box to tick: whose it is, instead.
    const tickable = canTick(o), theirs = !tickable && o.task ? whoOn(o) : '';
    if (theirs && String(sub || '').indexOf(theirs) === -1) sub = [sub, theirs].filter(Boolean).join(' · ');
    return '<div class="cal-todo' + (o.done ? ' done' : '') + (late ? ' late' : '') + '" style="--c:' + colorOf(o) + '">' +
      (tickable ? '<input type="checkbox"' + (o.done ? ' checked' : '') + ' onchange="calTick(\'' + k + '\', this.checked)" ' +
        'aria-label="Done">' : '<span class="cal-todo-dot"></span>') +
      (at ? '<span class="cal-todo-at">' + esc(at) + '</span>' : '') +
      '<button class="cal-todo-t" onclick="calClick(\'' + k + '\')">' + esc(o.title) +
        (sub ? '<small>' + esc(sub) + '</small>' : '') + '</button></div>';
  }
  const rankOf = o => { const i = YDRemind.TYPES.findIndex(t => t.id === o.type); return i === -1 ? YDRemind.TYPES.length : i; };
  const byKind = (a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || rankOf(a) - rankOf(b) ||
    String(a.name || a.title).localeCompare(String(b.name || b.title));

  // ------------------------------------------------------------------ my day
  //
  // Jonah (12 Oct 2026): "a daily overview section where each person can
  // view what their day consists of." One day, only what is theirs
  // (remind.js isMine): what is at a set time, in order, then what is for any
  // time that day, to tick off. Below, what the crew have that day that is
  // not theirs -- the owner sees every crew task, as he asked. Every
  // calendar counts, whatever is ticked in the side. The crew open the
  // calendar here.
  let pushState = '';       // this phone's notifications (notify.js); '' until asked
  function occIsMine(o, w) {
    if (o.auto === 'storm') return true;                       // a storm is everybody's
    if (o.auto === 'equipment' || o.auto === 'outreach') return !!w.owner;
    if (o.auto === 'card' || o.auto === 'recurring') {
      const boardId = o.auto === 'card' ? o.boardId : 'crew';
      const b = (YDBoards.boards() || {})[boardId] || { id: boardId };
      const card = ((YDBoards.cards() || {})[boardId] || {})[o.id] || { assignees: [] };
      return YDRemind.cardIsMine(card, b, w);
    }
    return YDRemind.eventIsMine(o.ev, cals[o.calId], w);
  }
  function whoOn(o) {
    const names = (o.crew || []).map(c => {
      const p = people[c.uid];
      const n = (p && (p.name || p.email)) || c.name || '';
      return n ? firstName(n) : '';
    }).filter(Boolean);
    return names.length ? '👤 ' + names.join(', ') : '';
  }
  function myDayHtml() {
    const day = cursor, w = YDRemind.who(people);
    if (!w) return '';
    const all = occurrences(day, day, true);
    // Where this person is working that day (the Job schedule) heads it,
    // apart from what they have to do; the crew's job days head the crew's.
    const mineJobs = all.filter(o => o.jobDay && occIsMine(o, w));
    const crewJobs = all.filter(o => o.jobDay && !occIsMine(o, w) && isCrewOcc(o));
    const mine = all.filter(o => !o.jobDay && occIsMine(o, w));
    const crew = all.filter(o => !o.jobDay && !occIsMine(o, w) && isCrewOcc(o));
    const timed = list => list.filter(o => o.time).sort((a, b) => String(to24(a.time)).localeCompare(String(to24(b.time))));
    const untimed = list => list.filter(o => !o.time).sort(byKind);
    // A task at a set time is ticked off here too (an appointment needs no
    // tick, so it has none).
    const timedRow = o => {
      const k = keyOf(o);
      const sub = [o.address, o.note, o.auto ? '' : o.layer.name, whoOn(o)].filter(Boolean).join(' · ');
      return '<div class="md-row' + (o.done ? ' done' : '') + '" style="--c:' + colorOf(o) + '">' +
        (o.task && canTick(o) ? '<input type="checkbox"' + (o.done ? ' checked' : '') +
          ' onchange="calTick(\'' + k + '\', this.checked)" aria-label="Done">' : '') +
        '<button class="md-open" onclick="calClick(\'' + k + '\')">' +
          '<span class="md-time">' + esc(o.endTime ? fmtTimeRange(o.time, o.endTime) : fmtTimeRange(o.time)) + '</span>' +
          '<span class="md-what"><b>' + esc(o.title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
        '</button></div>';
    };
    const mineT = timed(mine), mineU = untimed(mine);
    // What was not ticked off on the days before (carried): theirs at the
    // top; the crew's with the crew's day, for the owner.
    const late = day === today() ? carried(true) : [];
    const lateMine = late.filter(o => occIsMine(o, w));
    const lateCrew = late.filter(o => !occIsMine(o, w) && isCrewOcc(o));
    const which = day === today() ? 'today' : 'this day';
    // The day's one count (tally) at the top, as Home and the day list say
    // it -- not a count of each part, which read as two different figures.
    const count = countWords(countMemo[day] = tally(all, late, o => occIsMine(o, w), day));
    return '<div class="md cal-pan">' + nudgeHtml() +
      (count ? '<div class="md-count">' + esc(count) + '</div>' : '') +
      (mineJobs.length ? '<div class="md-head md-jobs">🔨 Where you’re working</div>' + jobDaysHtml(mineJobs, '') : '') +
      (lateMine.length ? '<div class="md-head md-late">⏰ From earlier — not done</div>' +
        lateMine.map(o => todoRow(o, [shortDay(o.day), whoOn(o)].filter(Boolean).join(' · '), !o.done)).join('') : '') +
      (!mine.length ? (mineJobs.length ? '' : '<p class="empty-msg">Nothing ' + (lateMine.length ? 'else ' : '') + 'of yours ' + which + '.</p>') :
        (mineT.length ? '<div class="md-head">🕑 At set times</div>' + mineT.map(timedRow).join('') : '') +
        (mineU.length ? '<div class="md-head">✅ Any time ' + which + '</div>' +
          mineU.map(o => todoRow(o, whoOn(o))).join('') : '')) +
      (crew.length || lateCrew.length || crewJobs.length ? '<div class="md-head md-crew">👷 The crew’s day</div>' +
        jobDaysHtml(crewJobs) +
        lateHtml(lateCrew, whoOn) +
        timed(crew).map(timedRow).join('') + untimed(crew).map(o => todoRow(o, whoOn(o))).join('') : '') +
      '</div>';
  }
  // Reminders only reach a phone that has said yes to them: a note at the
  // top of My day -- and of Home's day (home.js) -- until this one has.
  // The phone is asked once; Home is told when the answer comes.
  function nudgeHtml() {
    if (!pushState && window.YDNotify) {
      pushState = 'asking';
      YDNotify.deviceState().then(st => { pushState = st; redrawIfVisible(); announce(); })
        .catch(() => { pushState = 'unsupported'; });
    }
    return YDRemind.autoOn() === false
      ? '<div class="md-nudge">🔕 Your reminders are switched off. <button class="link-btn" onclick="openNotifications()">Switch them on</button></div>'
      : pushState === 'off' ? '<div class="md-nudge">🔔 Get a buzz before each thing on your day. ' +
          '<button class="btn btn-sm btn-filled" onclick="calPushOn()">Turn on notifications</button></div>'
      : pushState === 'needs-home-screen' ? '<div class="md-nudge">🔔 For reminders on an iPhone, open Job Hub from the home screen ' +
          '(Safari → Share → Add to Home Screen), then turn notifications on.</div>'
      : pushState === 'blocked' ? '<div class="md-nudge">🔕 Notifications are blocked for Job Hub on this device — allow them in its settings.</div>'
      : '';
  }
  window.calPushOn = async function () {
    if (typeof ntfTurnOn !== 'function') return;
    await ntfTurnOn();
    pushState = '';
    render();
    announce();
  };

  window.calTodayFold = function () {
    // Above the calendar: for this look only (foldedNow). Down the side: kept.
    if (listOnTop()) { topFold = !foldedNow(); render(); return; }
    todayFolded = !todayFolded;
    try { localStorage.setItem('ydjobhub_calTodayFolded', todayFolded ? '1' : '0'); } catch (e) {}
    render();
  };
  window.calTick = function (k, on) {
    if (drawn[k]) tickOcc(drawn[k], on);
  };
  // Ticking one thing off (or back on), from here or from Home: a card
  // moves to Done the way a drag there would, an entry has that one date
  // marked done. Redraws, tells Home, and returns whether anything changed.
  function tickOcc(o, on) {
    const ok = tick(o, on);
    // Drawn again only where it shows: a tick from Home with the calendar
    // hidden needs no three periods of grid built behind it.
    const p = el('panel-calendar');
    if (p && p.classList.contains('active')) render();
    if (ok) announce();
    return ok;
  }
  // Ticks one thing off (or back on) for its own date. False when it could
  // not be.
  function tick(o, on) {
    if (o.auto === 'card' || o.auto === 'recurring') {
      if (!window.YDBoards || !YDBoards.setDone(o.auto === 'card' ? o.boardId : 'crew', o.id, on)) {
        showToast('That card is not on its board yet');
        return false;
      }
      return true;
    }
    const cal = cals[o.calId], base = cal && (events[o.calId] || {})[o.id];
    if (!base || !canTick(o)) return false;
    // Undone is written as null: a merge keeps whatever key is left out.
    const mark = on ? { at: nowIso(), by: (me() || {}).uid || '' } : null;
    const key = o.doneKey || o.day;
    base.done = Object.assign({}, base.done, { [key]: mark });
    write('calendars/' + o.calId + '/events', o.id, { done: { [key]: mark } }, 'ticking off ' + (base.title || 'an entry'));
    return true;
  }
  // The details window's "Mark done": a task at a set time is ticked off
  // here, as one for any time is on the list.
  window.calDoneShown = function (on) {
    const o = shown;
    if (!o || !tick(o, on)) return;
    closeCalModal();
    render();
    announce();
    showToast(on ? 'Done — ' + shortDay(o.doneKey || o.day) : 'Not done after all');
  };

  // Jonah (15 Oct 2026): "the checkmarks for the different calendars can go
  // at the top under the tabs" -- "same with the color key". A day later:
  // "within the calendars I want tags". So each calendar's tick is followed
  // by its own tags, each in its colour -- the key to what the colours mean
  // there -- and a tap on a tag hides that kind of thing (tagsOff) or shows
  // it again. The worked-out layers (storms, machines, due cards) after. A
  // phone has no room for all that above its days: it folds behind one
  // button there (remembered per device), open on a computer.
  let filtersOpen = (() => { try { return localStorage.getItem('ydjobhub_calFilters') === '1'; } catch (e) { return false; } })();
  // On an iPad (about 1024×768) or a laptop screen under ~900px tall the
  // ticks and the colour key together pushed the hours two-thirds of the way
  // down the screen (office testing, 16 Oct 2026). The ticks stay, in one
  // row; the tags fold behind a small "Tags" chip there (styles.css says
  // where), opened or shut as last left on this device.
  let keyOpen = (() => { try { return localStorage.getItem('ydjobhub_calKey') === '1'; } catch (e) { return false; } })();
  window.calKey = function () {
    keyOpen = !keyOpen;
    try { localStorage.setItem('ydjobhub_calKey', keyOpen ? '1' : '0'); } catch (e) { /* private window: just not kept */ }
    // Only the tags and their chip change -- not the whole calendar, so the
    // hours stay scrolled where they were.
    const box = document.querySelector('#calWrap .cal-filters'), btn = document.getElementById('calKeyBtn');
    if (box) box.classList.toggle('tags-open', keyOpen);
    if (btn) {
      btn.setAttribute('aria-expanded', String(keyOpen));
      const arrow = btn.querySelector('span');
      if (arrow) arrow.textContent = keyOpen ? '▾' : '▸';
    }
  };
  // One calendar's tick, or a worked-out layer's.
  function tickHtml(l) {
    return '<label class="cal-check" style="--c:' + safeColor(l.color) + '" title="' + esc(l.about || '') + '">' +
      '<input type="checkbox"' + (hidden.has(l.id) ? '' : ' checked') + ' onchange="calSet(\'' + safeKey(l.id) + '\', this.checked)">' +
      '<span class="cal-box"></span><span class="cal-check-name">' + esc(l.name) + '</span>' +
      (isOwner() && !l.auto && (l.visibleTo || []).length ? '<span class="cal-shared">👥' + l.visibleTo.length + '</span>' : '') +
    '</label>';
  }
  // A calendar's tags, as switches. The Job schedule has none to pick: each
  // job is its own colour there.
  function tagSwitchesHtml(c) {
    if (c.kind === 'jobs') return '<span class="cal-tags"><span class="cal-tags-note">🔨 Each job in its own colour</span></span>';
    return '<span class="cal-tags" role="group" aria-label="' + esc(c.name) + ' — tags">' + YDRemind.tagsOf(c).map(t => {
      const on = !tagsOff.has(tagKey(c.id, t.id));
      return '<button type="button" class="cal-tag' + (on ? '' : ' off') + '" aria-pressed="' + on + '" style="--c:' + safeColor(t.color) + '"' +
        ' onclick="calTagFilter(\'' + safeKey(c.id) + '\', \'' + safeKey(t.id) + '\')" title="' + (on ? 'Hide ' : 'Show ') + esc(t.name) + '">' +
        '<span class="cal-tag-dot"></span>' + esc((t.icon ? t.icon + ' ' : '') + t.name) + '</button>';
    }).join('') + '</span>';
  }
  function filtersHtml() {
    const off = hidden.size + (onlyMineOn ? 1 : 0) + tagsOffNow();
    return '<div class="cal-filters' + (filtersOpen ? ' open' : '') + (keyOpen ? ' tags-open' : '') + '">' +
      '<button class="btn btn-sm cal-filters-btn" onclick="calFilters()" aria-expanded="' + filtersOpen + '">Calendars &amp; tags' +
        (off ? ' <span class="cal-filters-n">' + off + ' off</span>' : '') + ' <span aria-hidden="true">' + (filtersOpen ? '▾' : '▸') + '</span></button>' +
      '<div class="cal-filters-body">' +
        '<div class="cal-checks">' +
          storedCals().map(c => '<div class="cal-tagrow' + (hidden.has(c.id) ? ' cal-off' : '') + '">' + tickHtml(c) + tagSwitchesHtml(c) + '</div>').join('') +
          layers().filter(l => l.auto).map(tickHtml).join('') +
          '<label class="cal-check mine"><input type="checkbox"' + (onlyMineOn ? ' checked' : '') + ' onchange="calOnlyMine()">' +
            '<span class="cal-box"></span><span class="cal-check-name">👤 Only mine</span></label>' +
          (off ? '<button class="link-btn" onclick="calShowAll()">Show everything</button>' : '') +
          (isOwner() ? '<button class="link-btn" onclick="calManage()">⚙ Manage calendars &amp; tags</button>' : '') +
          // The tags' own fold: shown only where the stylesheet folds them
          // (an iPad, a short laptop screen).
          '<button type="button" class="cal-key-btn" id="calKeyBtn" onclick="calKey()" aria-expanded="' + keyOpen + '">' +
            '🎨 Tags <span aria-hidden="true">' + (keyOpen ? '▾' : '▸') + '</span></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  window.calTagFilter = function (calId, tagId) {
    const k = tagKey(calId, tagId);
    if (tagsOff.has(k)) tagsOff.delete(k); else tagsOff.add(k);
    saveTagsOff(); render();
  };
  window.calFilters = function () {
    filtersOpen = !filtersOpen;
    try { localStorage.setItem('ydjobhub_calFilters', filtersOpen ? '1' : '0'); } catch (e) {}
    render();
  };

  // Down the side on a computer: the small month, then the day's list --
  // Jonah (15 Oct 2026): "along with the view of the calendar i want a
  // sidebar with each task for the day and just the time its due", in view
  // beside the whole calendar. Everything on the day picked (today when it
  // is on screen), at its time, in order; then what is for any time that
  // day; tasks from earlier days not ticked off at the head of today's.
  // Ticked off right here. A phone has the "any time" list above its days
  // instead (todayHtml), and its timed things are in the days themselves.
  function sideHtml() {
    return miniHtml() + dayListHtml();
  }
  function dayListHtml() {
    if (view === 'myday') return '';
    const day = dayForNew();
    const items = occurrences(day, day).filter(o => o.auto !== 'storm' && !o.after);
    // Where the crew is working first (the Job schedule), then the day.
    const jobs = items.filter(o => o.jobDay);
    const timed = items.filter(o => o.time && !o.jobDay).sort((a, b) => (minutesOf(a.time) || 0) - (minutesOf(b.time) || 0) || byKind(a, b));
    const anyTime = items.filter(o => !o.time && !o.jobDay).sort(byKind);
    const late = day === today() ? carried() : [];
    return '<div class="cal-daylist">' +
      '<div class="cal-daylist-head">' + esc(longDay(day)) + countHtml(dayCount(day)) + '</div>' +
      jobDaysHtml(jobs) +
      lateHtml(late, null, true) +
      // Under the job days, the rest needs a heading of its own.
      (timed.length && (jobs.length || late.length) ? '<div class="cal-todo-group">At set times</div>' : '') +
      timed.map(o => todoRow(o, '', false, fmtTime(o.time))).join('') +
      (anyTime.length ? '<div class="cal-todo-group">Any time</div>' + anyTime.map(o => todoRow(o)).join('') : '') +
      (!items.length ? '<div class="cal-today-none">' + (late.length ? 'Nothing else on this day.' : 'Nothing on this day.') + '</div>' : '') +
      (adds() ? '<button class="link-btn cal-daylist-add" onclick="calAdd(\'' + day + '\')">+ Add to ' +
        (day === today() ? 'today' : esc(shortDay(day))) + '</button>' : '') +
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
    if (view === 'day' || view === 'myday') return parseDay(cursor).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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

  // The days on screen, with the same number either side drawn too, just out
  // of sight: each row's days sit on a strip three times as wide, moved so
  // the middle shows (.cg-track). A finger swiping sideways slides the strip
  // and the next days come into view under it, as in Google Calendar -- see
  // "Swiping" below. The ones out of sight are inert: nothing in them can be
  // tapped or tabbed to, and an entry dragged along is dropped only on a day
  // on screen (moveBlock).
  function gridHtml(days) {
    const n = days.length;
    const all = days.map(d => addDays(d, -n)).concat(days, days.map(d => addDays(d, n)));
    const occ = occurrences(all[0], all[all.length - 1]);
    const t = today();
    const nb = d => d < days[0] || d > days[n - 1];
    const off = d => nb(d) ? ' cg-nb" inert aria-hidden="true' : '';
    const track = (cells, extra) => '<div class="cg-vp"><div class="cg-track" style="--cols:' + all.length +
      (extra || '') + '">' + cells + '</div></div>';
    const head = '<div class="cg-row cg-head"><div class="cg-gut"></div>' + track(all.map(d => {
        const p = parseDay(d);
        return '<button class="cg-dh' + (d === t ? ' today' : d < t ? ' past' : '') + off(d) + '" onclick="calGoDay(\'' + d + '\')">' +
          '<span class="cg-wd">' + WEEKDAYS[p.getDay()] + '</span><span class="cg-dn">' + p.getDate() + '</span></button>';
      }).join('')) + '</div>';
    const allDay = '<div class="cg-row cg-all"><div class="cg-gut cg-all-l">all day</div>' + track(all.map(d =>
        '<div class="cg-allcell' + off(d) + '" data-day="' + d + '">' +
          occ.filter(o => o.day === d && !segOf(o)).map(chipHtml).join('') + '</div>').join('')) + '</div>';
    let hours = '';
    for (let h = 1; h < 24; h++) hours += '<span style="top:' + h * HOUR + 'px">' + hourLabel(h) + '</span>';
    const cols = all.map(d => {
      const items = layout(occ.filter(o => o.day === d).map(o => {
        const s = segOf(o);
        return s && s[1] > s[0] && { o: o, a: s[0], b: s[1] };
      }).filter(Boolean));
      return '<div class="cg-col' + (d === t ? ' today' : '') + off(d) + '" data-day="' + d + '">' +
        items.map(blockHtml).join('') +
        (d === t ? '<div class="cg-now" style="top:' + nowTop() + 'px"></div>' : '') +
      '</div>';
    }).join('');
    return '<div class="cg" style="--n:' + n + ';--h:' + HOUR + 'px">' +
      '<div class="cg-scroll cal-pan">' +
        '<div class="cg-sticky">' + head + allDay + '</div>' +
        '<div class="cg-row cg-body" style="height:' + 24 * HOUR + 'px">' +
          '<div class="cg-gut cg-hours">' + hours + '</div>' + track(cols, ';height:' + 24 * HOUR + 'px') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function chipHtml(o) {
    const k = keyOf(o);
    return '<div class="cg-chip' + (o.done ? ' done' : '') + (movable(o) ? ' mv' : '') + '" data-k="' + k + '" ' +
      'style="' + paint(o) + '" onclick="calClick(\'' + k + '\')">' + esc(o.title) + '</div>';
  }

  function blockHtml(it) {
    const o = it.o, k = keyOf(o);
    const h = Math.max(18, (it.b - it.a) * HOUR / 60 - 2), w = 100 / it.n;
    // Days-long and past-midnight entries are moved in the editor: dragging
    // one piece of them would have to guess what happens to the rest.
    const mv = movable(o) && !o.multi;
    return '<div class="cg-ev' + (o.done ? ' done' : '') + (h < 34 ? ' short' : '') + (mv ? ' mv' : '') + '" data-k="' + k + '" ' +
        'style="' + paint(o) + ';top:' + (it.a * HOUR / 60) + 'px;height:' + h + 'px;' +
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

  // On a phone the hours fill the screen from where they start down to the
  // tab bar. The stylesheet's fixed height (the screen less a guess at what
  // sits above) ran on under the tab bar whenever more sat above it -- the
  // "any time" list, a long title -- so the hours and the page both scrolled
  // under the same finger and the evening was out of reach behind the bar.
  // Measured with the page at its top. Never under FIT_MIN, so with the list
  // open above it the hours are still a fair window once the page is
  // scrolled to them; never taller than the screen above the bar.
  const FIT_MIN = 320;
  function fitGrid() {
    const s = document.querySelector('#calBody .cg-scroll');
    if (!s) return;
    // Not on screen (drawn behind another tab): nothing to measure; the
    // stylesheet's height stands until it is opened.
    if (!isPhone() || !s.offsetParent) { s.style.height = s.style.minHeight = s.style.maxHeight = ''; return; }
    const bar = document.querySelector('.tab-bar');
    const floor = bar && getComputedStyle(bar).position === 'fixed' ? bar.getBoundingClientRect().top : window.innerHeight;
    const top = s.getBoundingClientRect().top + window.scrollY;
    const h = Math.round(clamp(floor - top - 8, FIT_MIN, floor - 8));
    s.style.height = s.style.minHeight = s.style.maxHeight = h + 'px';
  }

  // A tap on an empty hour adds an entry at that half hour.
  function wireSlots() {
    if (!adds()) return;
    document.querySelectorAll('#calBody .cg-col:not(.cg-nb)').forEach(col => col.addEventListener('click', e => {
      if (e.target !== col || Date.now() - justDragged < 400) return;
      const y = e.clientY - col.getBoundingClientRect().top;
      calAdd(col.dataset.day, hhmm(clamp(Math.floor(y / HOUR * 2) * 30, 0, 1410)));
    }));
  }

  // ------------------------------------------------------- month and list

  // The month, with the month before and after drawn out of sight beside it
  // (as the time grid's days are), so a swipe slides the next one in.
  function monthHtml() {
    const firsts = [-1, 0, 1].map(k => addMonths(cursor.slice(0, 8) + '01', k).slice(0, 8) + '01');
    const occ = occurrences(weekStart(firsts[0]), addDays(weekStart(firsts[2]), 41));
    const byDay = {};
    occ.forEach(o => { (byDay[o.day] = byDay[o.day] || []).push(o); });
    const t = today();

    const grid = (first, side) => {
      const gridStart = weekStart(first), month = first.slice(0, 7);
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const day = addDays(gridStart, i);
        const list = byDay[day] || [];
        cells += '<div class="cal-cell' + (day.slice(0, 7) !== month ? ' out' : '') + (day === t ? ' today' : '') +
            (day === selected && !side ? ' sel' : '') + '" data-day="' + day + '" onclick="calPick(\'' + day + '\')">' +
          '<div class="cal-num">' + parseDay(day).getDate() + '</div>' +
          '<div class="cal-bars">' +
            list.slice(0, 3).map(o => {
              const k = keyOf(o);
              return '<div class="cal-bar' + (o.done ? ' done' : '') + (movable(o) ? ' mv' : '') + '" data-k="' + k + '" ' +
                'style="' + paint(o) + '" onclick="event.stopPropagation();calClick(\'' + k + '\')">' +
                (o.time ? '<b>' + esc(fmtTimeRange(o.time)) + '</b> ' : '') + esc(o.title) + '</div>';
            }).join('') +
            (list.length > 3 ? '<button class="cal-more" onclick="event.stopPropagation();calGoDay(\'' + day + '\')">+' +
              (list.length - 3) + ' more</button>' : '') +
          '</div>' +
          '<div class="cal-dots">' + list.slice(0, 5).map(o =>
            '<span style="--c:' + colorOf(o) + '"></span>').join('') + '</div>' +
        '</div>';
      }
      return '<div class="cal-month' + (side ? '" inert aria-hidden="true' : '') + '">' +
        WEEKDAYS.map(w => '<div class="cal-wd">' + w + '</div>').join('') + cells + '</div>';
    };
    return '<div class="cal-pan-vp cal-pan"><div class="cal-month-track">' +
        firsts.map((f, i) => grid(f, i !== 1)).join('') +
      '</div></div>' +
      // The picked day is always one of the 42 squares (calStep and calPick
      // keep it in this month): nothing in byDay is nothing that day.
      '<div class="cal-daypanel">' + dayBlock(selected, byDay[selected] || [], true) + '</div>';
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
    const time = o.time ? fmtTimeRange(o.time, o.endTime) : 'Any time';
    return '<div class="cal-entry' + (o.done ? ' done' : '') + '" style="--c:' + colorOf(o) + '" onclick="calClick(\'' + k + '\')">' +
      '<div class="cal-entry-time">' + esc(time) + '</div>' +
      '<div class="cal-entry-main">' +
        '<div class="cal-entry-title">' + esc(o.title) + '</div>' +
        '<div class="cal-entry-sub">' +
          '<span class="cal-entry-cal">' + esc(o.layer.name) + '</span>' +
          (o.jobName && o.jobName !== (o.name || o.title) ? ' · 📋 ' + esc(o.jobName) : '') +
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
  // An entry's colour: its kind's (remind.js) when it has one, else its
  // calendar's. On the filled blocks a light colour (doctor's yellow) gets
  // dark writing (--ink; the tinted month bars keep the page's own).
  const colorOf = o => safeColor(o.color || o.layer.color);
  const paint = o => '--c:' + colorOf(o) + ';--ink:' + (o.ink ? safeColor(o.ink) : inkOn(colorOf(o)));

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
      : addDays(cursor, n * ({ day: 1, myday: 1, '3day': 3, week: 7, schedule: 14 }[view] || 7));
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
  window.calShowAll = function () { hidden = new Set(); tagsOff = new Set(); onlyMineOn = false; saveHidden(); saveTagsOff(); render(); };
  window.calOnlyMine = function () { onlyMineOn = !onlyMineOn; render(); };

  // ----------------------------------------------------------- open things

  window.calOpenStorm = function () { switchTab('snow'); };
  window.calOpenEquipment = function (id) {
    switchTab('equipment');
    if (window.openEquipment) openEquipment(id);
  };
  // The outreach day: the list of who is due, at the top of Contacts.
  window.calOpenOutreach = function () {
    switchTab('contacts');
    const s = el('ppOutSection');
    if (s) s.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  window.calOpenCard = function (boardId, cardId) {
    switchTab('boards');
    if (window.showBoard) showBoard(boardId);
    if (window.openCardDetail) openCardDetail(boardId, cardId);
  };

  window.calClick = function (k) {
    if (Date.now() - justDragged < 400) return;
    clickOcc(drawn[k]);
  };
  // Opening one thing on the calendar, wherever it was drawn: here, or on
  // Home (home.js, through YDCalendar.open).
  function clickOcc(o) {
    if (!o) return;
    if (o.auto === 'storm') return calOpenStorm();
    if (o.auto === 'equipment') return calOpenEquipment(o.id);
    if (o.auto === 'card') return calOpenCard(o.boardId, o.id);
    if (o.auto === 'outreach') return calOpenOutreach();
    // A recurring task: its card when this date's has been made, otherwise
    // the Crew tasks board.
    if (o.auto === 'recurring') {
      if (o.id) return calOpenCard('crew', o.id);
      switchTab('boards'); if (window.showBoard) showBoard('crew');
      return;
    }
    openOcc(o);
  }

  // ------------------------------------------------------------- files
  //
  // Jonah (15 Oct 2026): "i want to be able to add attachments to calendar
  // items" -- a plan, a quote, a photo of the spot. Each file goes to Cloud
  // Storage at calendarFiles/{calendar}/{entry}/{id}-{name} (storage.rules:
  // whoever may change that calendar adds and removes; anyone working for
  // the business opens one -- only from an entry they can see, which is
  // where the path is) and is listed on the entry as `files` [{id, name,
  // path, type, size, by, at}] -- the entry as a whole, every date of a
  // repeat. No address is kept: a download address works for anyone who
  // has it, so it is asked for each time the entry is opened.
  const FILE_MAX = 25 * 1024 * 1024;
  const fileSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const isImage = f => /^image\//.test(f.type || '') || /\.(jpe?g|png|gif|webp|heic)$/i.test(f.name || '');
  function filesHtml(base, mayChange) {
    const files = Array.isArray(base.files) ? base.files : [];
    if (!files.length && !mayChange) return '';
    return '<div class="cal-files">' +
      files.map(f => '<div class="cal-file" data-state="">' +
        (isImage(f) ? '<a class="cal-file-pic" data-path="' + esc(f.path) + '" target="_blank" rel="noopener" onclick="calFileTap(event, this)">' +
          '<img alt="" data-path="' + esc(f.path) + '"></a>' : '') +
        '<a class="cal-file-a" data-path="' + esc(f.path) + '" target="_blank" rel="noopener" onclick="calFileTap(event, this)">📎 ' + esc(f.name || 'File') +
          // How it is going, in words on the row: there is no hover on an
          // iPad or a phone to read a title by.
          '<span class="cal-file-state" aria-live="polite"></span></a>' +
        '<small>' + esc(fileSize(+f.size || 0)) + '</small>' +
        (mayChange ? '<button type="button" class="cal-file-x" onclick="calFileRemove(\'' + safeKey(f.id) + '\')" aria-label="Remove ' + esc(f.name || 'the file') + '">✕</button>' : '') +
      '</div>').join('') +
      (mayChange ? '<label class="btn btn-sm cal-file-add">📎 Attach a file' +
        '<input type="file" multiple hidden onchange="calFilesPicked(this)"></label>' : '') +
    '</div>';
  }
  // The links are filled in once Storage says where each file is. Crew
  // testing, 16 Oct 2026: with no signal a file was marked "could not be
  // found" only in a title shown on hover -- an iPad has no hover -- and a
  // tap on it did nothing. Now each row says in words how it stands
  // (fileState), and a tap on one that has no address yet asks again
  // (calFileTap); the rows still waiting are asked again too when the
  // signal comes back.
  function fillFileLinks() {
    document.querySelectorAll('.cal-files .cal-file').forEach(row => {
      const a = row.querySelector('.cal-file-a');
      if (a && !a.getAttribute('href')) fileLink(row);
    });
  }
  const FILE_SAY = {
    asking: 'Getting it…',
    offline: 'Can’t open with no signal — tap to try again',
    gone: 'Not found — it may have been taken off',
    refused: 'Not allowed to open it',
    failed: 'Couldn’t open it — tap to try again',
  };
  function fileState(row, state) {
    row.dataset.state = state || '';
    const a = row.querySelector('.cal-file-a'), say = row.querySelector('.cal-file-state');
    if (a) a.classList.toggle('missing', state === 'gone');
    if (say) say.textContent = state ? FILE_SAY[state] || '' : '';
  }
  // Asks Storage for the row's address. Resolves with it, or '' when it
  // could not be had (the row then says why). A phone with bars but no data
  // gets no answer at all for a couple of minutes (Storage keeps trying), so
  // after FILE_WAIT_MS the row says "no signal" -- and is filled in all the
  // same if the answer comes after all.
  const FILE_WAIT_MS = 10000;
  function fileLink(row) {
    if (row.dataset.state === 'asking' && row._asking) return row._asking;
    const a = row.querySelector('.cal-file-a');
    if (!a) return Promise.resolve('');
    if (!window.YDStore || navigator.onLine === false) { fileState(row, 'offline'); return Promise.resolve(''); }
    fileState(row, 'asking');
    const ask = window.YDStore.url(a.dataset.path).then(u => {
      row.querySelectorAll('[data-path]').forEach(n => { if (n.tagName === 'IMG') n.src = u; else n.href = u; });
      fileState(row, '');
      return u;
    }, e => {
      const code = (e && e.code) || '';
      // No code at all: the Storage code itself could not be fetched.
      fileState(row, code === 'storage/object-not-found' ? 'gone' : code === 'storage/unauthorized' ? 'refused'
        : navigator.onLine === false || code === 'storage/retry-limit-exceeded' || !code ? 'offline' : 'failed');
      return '';
    });
    const waited = new Promise(res => setTimeout(() => res(null), FILE_WAIT_MS));
    const out = Promise.race([ask, waited]).then(u => {
      if (u !== null) return u;
      if (row.dataset.state === 'asking') fileState(row, 'offline');
      return '';
    });
    row._asking = out;
    out.then(() => { if (row._asking === out) row._asking = null; });
    return out;
  }
  // A tap on a file: one with its address opens as any link does. One
  // without (no signal when the entry was opened, or still being asked)
  // asks again, and opens once it has it.
  window.calFileTap = function (e, link) {
    if (link.getAttribute('href')) return;
    e.preventDefault();
    const row = link.closest('.cal-file');
    if (!row) return;
    fileLink(row).then(u => {
      if (!u) return;
      // Opened straight away while the tap still counts as one (most
      // browsers allow a new tab for a few seconds after it); where the
      // browser says no, the row is ready for the next tap.
      const w = window.open(u, '_blank');
      if (w) { try { w.opener = null; } catch (err) { /* another site's window */ } }
      else showToast('Ready — tap the file again to open it');
    });
  };
  // The signal back with an entry open: its files that could not be had
  // are asked for again.
  window.addEventListener('online', () => {
    document.querySelectorAll('.cal-files .cal-file').forEach(row => {
      if (row.dataset.state === 'offline' || row.dataset.state === 'failed') fileLink(row);
    });
  });
  window.calFilesPicked = async function (input) {
    const o = shown, picked = Array.from((input && input.files) || []);
    if (input) input.value = '';
    const cal = o && cals[o.calId], base = cal && (events[o.calId] || {})[o.id];
    if (!base || !picked.length || !editsCal(cal)) return;
    if (!window.YDStore) { showToast('Files are still loading — try again in a moment'); return; }
    if (navigator.onLine === false) { showToast('Attaching a file needs signal'); return; }
    const added = [];
    for (let i = 0; i < picked.length; i++) {
      const f = picked[i];
      if (f.size > FILE_MAX) { showToast(f.name + ' is over 25 MB — not attached'); continue; }
      const id = newId('cf');
      const name = String(f.name || 'file').replace(/[\\/#?\[\]*]+/g, '-').slice(-90);
      const path = 'calendarFiles/' + o.calId + '/' + base.id + '/' + id + '-' + name.replace(/\s+/g, '-');
      const what = picked.length > 1 ? ' (' + (i + 1) + ' of ' + picked.length + ')' : '';
      try {
        await window.YDStore.upload(path, f, f.type || 'application/octet-stream',
          p => showToast('Attaching ' + name + what + ' — ' + Math.round(p * 100) + '%'));
        added.push({ id: id, name: name, path: path, type: f.type || '', size: f.size, by: (me() || {}).uid || null, at: nowIso() });
      } catch (e) {
        showToast(name + ' was not attached' + (e && e.code === 'storage/unauthorized' ? ' — not allowed' : ' — try again'));
      }
    }
    if (!added.length) return;
    // The list as it is now, so a file another device added meanwhile stays.
    const now = (events[o.calId] || {})[o.id];
    if (!now) return;
    const files = (Array.isArray(now.files) ? now.files : []).concat(added);
    applyLocal(o.calId, o.id, { files: files });
    write('calendars/' + o.calId + '/events', o.id, { files: files }, 'attaching');
    showToast(added.length === 1 ? 'Attached' : added.length + ' files attached');
    if (shown && shown.id === o.id) openOcc(shown);
  };
  window.calFileRemove = async function (fid) {
    const o = shown;
    const cal = o && cals[o.calId], base = cal && (events[o.calId] || {})[o.id];
    if (!base || !editsCal(cal)) return;
    const f = (base.files || []).find(x => x.id === fid);
    if (!f || !(await ydConfirm('It is deleted for good.', { title: 'Remove ' + (f.name || 'this file') + ' from the entry?', ok: 'Remove', danger: true }))) return;
    // The entry as it is now: a file attached while it was asked stays.
    const now = (events[o.calId] || {})[o.id];
    if (!now || !(now.files || []).some(x => x.id === fid)) return;
    const files = (now.files || []).filter(x => x.id !== fid);
    applyLocal(o.calId, o.id, { files: files });
    write('calendars/' + o.calId + '/events', o.id, { files: files }, 'removing a file');
    if (window.YDStore) window.YDStore.remove(f.path).catch(e => console.warn('[calendar] file not removed from storage:', e && (e.code || e.message)));
    openOcc(o);
  };
  // An entry deleted for good takes its files with it.
  function dropFiles(base) {
    (Array.isArray(base && base.files) ? base.files : []).forEach(f => {
      if (window.YDStore && f && f.path) window.YDStore.remove(f.path).catch(() => {});
    });
  }

  function openOcc(o) {
    const cal = cals[o.calId];
    const base = cal && (events[o.calId] || {})[o.id];
    if (!base) return;
    shown = o;
    const ev = o.ev || base;
    const when = ev.allDay || !ev.time ? 'Any time that day' : fmtTimeRange(ev.time, ev.endTime);
    const mapUrl = ev.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.address) : '';
    // Its tag, as its calendar has it (a name the owner gave it there).
    const type = tagOfEv(ev, cal);
    // The reminder is the series' (a single date cannot have its own). The
    // usual one is said only when the entry is this person's by the same
    // rule the reminders go by (remind.js isMine) -- not just when they are
    // on it, which left out the owner's own entries with nobody on them.
    const remindLine = YDRemind.line(base, type ? type.id : '', isTimed(ev),
      YDRemind.eventIsMine(ev, cal, YDRemind.who(people)));
    // Ticked off for this date: when, and by whom.
    // (A crew phone has no list of people: someone else is just "done".)
    const mark = base.done && base.done[o.doneKey || o.day];
    const doneBy = !mark || !mark.by ? '' : mark.by === (me() || {}).uid ? 'you'
      : people[mark.by] ? firstName(personName(mark.by)) : '';
    const doneAt = mark && mark.at && !isNaN(new Date(mark.at))
      ? new Date(mark.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const doneLine = !mark ? '' : '✅ Done' + (doneBy ? ' — ' + doneBy : '') + (doneAt ? ', ' + doneAt : '');
    const lateLine = !mark && o.task && (o.doneKey || o.day) < today() ? '⏰ Not ticked off — still to do' : '';
    openModal(esc(ev.title || ev.jobName || 'Event'),
      '<div class="cal-detail" style="--c:' + safeColor(cal.color) + '">' +
        '<div class="cal-detail-cal"><span class="cal-dot"></span>' + esc(cal.name) + '</div>' +
        '<div class="cal-detail-when">' + longDay(o.day || ev.date) + ' · ' + esc(when) +
          (ev.endDate && ev.endDate > ev.date ? '<br><span class="muted">' + shortDay(ev.date) + ' to ' + shortDay(ev.endDate) + '</span>' : '') +
          (isRepeating(base) ? '<br><span class="muted">' + REPEAT[base.repeat] +
            (base.repeatUntil ? ' until ' + shortDay(base.repeatUntil) : '') +
            (o.changed ? ' · changed for this date' : '') + '</span>' : '') +
        '</div>' +
        (type ? '<div class="cal-detail-line cal-detail-tag" style="--t:' + safeColor(o.color || type.color || cal.color) + '"><span class="cal-tag-dot"></span>' + esc((type.icon ? type.icon + ' ' : '') + type.name) + '</div>' : '') +
        (ev.jobName ? '<div class="cal-detail-line">📋 ' + esc(ev.jobName) + '</div>' : '') +
        (ev.address ? '<a class="snow-addr" href="' + mapUrl + '" target="_blank" rel="noopener">📍 ' + esc(ev.address) +
          '<span class="snow-go">Directions</span></a>' : '') +
        ((ev.crew || []).length ? '<div class="cal-detail-line">👷 ' + ev.crew.map(c =>
          '<span class="cal-face" style="--c:' + personColor(c.uid) + '">' + esc(nameOf(c)) + '</span>').join(' ') + '</div>' : '') +
        (remindLine ? '<div class="cal-detail-line">' + esc(remindLine) + '</div>' : '') +
        (doneLine ? '<div class="cal-detail-line">' + esc(doneLine) + '</div>' : '') +
        (lateLine ? '<div class="cal-detail-line cal-late">' + esc(lateLine) + '</div>' : '') +
        (ev.notes ? '<div class="bd-notes">' + esc(ev.notes) + '</div>' : '') +
        filesHtml(base, editsCal(cal)) +
      '</div>' +
      '<div class="field-actions">' +
        // A task is ticked off for this date (an appointment needs none).
        (o.task && canTick(o) ? (mark ? '<button class="btn btn-sm" onclick="calDoneShown(false)">↩ Not done after all</button>'
          : '<button class="btn btn-filled" onclick="calDoneShown(true)">✅ Mark done</button>') : '') +
        (editsCal(cal) ? '<button class="btn' + (o.task && canTick(o) && !mark ? '' : ' btn-filled') + '" onclick="calEditShown()">Edit</button>' : '') +
        // Not on the Crew schedule already, nor a day on a job.
        (editsCal(cal) && cal.kind !== 'crew' && cal.kind !== 'jobs' && !(type && type.crew)
          ? '<button class="btn btn-sm" onclick="calCrewTask()">👷 Make it a crew task</button>' : '') +
        (ydCan('jobs', 'see') && ev.jobId ? '<button class="btn btn-sm" onclick="calOpenJob(\'' + safeKey(ev.jobId) + '\')">Open the job</button>' : '') +
        // The crew: the job's page made for them (crewjobs.js) -- the gate
        // code, the work, Directions -- a tap from the entry sending them there.
        (!ydCan('jobs', 'see') && ev.jobId && window.YDCrewJobs && YDCrewJobs.list().some(j => j.id === ev.jobId)
          ? '<button class="btn btn-sm" onclick="calOpenCrewJob(\'' + safeKey(ev.jobId) + '\')">Open the job</button>' : '') +
        '<button class="btn btn-sm" onclick="closeCalModal()">Close</button>' +
      '</div>');
    fillFileLinks();
  }
  const safeKey = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');

  window.calOpenCrewJob = function (jobId) {
    closeCalModal();
    if (typeof window.openCrewJob === 'function') window.openCrewJob(jobId);
  };
  window.calOpenJob = async function (jobId) {
    closeCalModal();
    // Already the job in the form: just go to it. Loading it again would read
    // the saved copy over whatever has been typed and not yet saved.
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId) { switchTab('job'); return; }
    if (!(await ydLeaveUnsavedJob())) return;
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
    return view === 'schedule' || view === 'myday' ? cursor : t;
  }
  window.calEditShown = function () {
    if (!shown) return;
    editing = { calId: shown.calId, eventId: shown.id, occ: shown };
    renderEditor();
  };

  function renderEditor() {
    typeNote = '';
    const list = editableCals();
    if (!list.length) { showToast('Calendars are still loading'); return; }
    const base = editing.eventId ? (events[editing.calId] || {})[editing.eventId] || {} : {};
    // A repeat is edited as the date that was opened: its own day, and
    // whatever was changed for it.
    const ev = editing.occ && editing.occ.ev ? editing.occ.ev : base;
    const calId = editing.calId || (lastCal && cals[lastCal] ? lastCal : list[0].id);
    const crew = crewPeople();
    const chosen = new Set((ev.crew || []).map(c => c.uid));
    // The jobs not finished -- and the entry's own job even if it is, so
    // saving it again does not quietly untie it.
    const jobs = editorJobs()
      .filter(j => j && j._id && ((j.jobStatus || 'quoting') !== 'complete' || j._id === ev.jobId))
      .sort((a, b) => String(a.customerName || '').localeCompare(b.customerName || ''));
    const ownJob = ev.jobId && !jobs.some(j => j._id === ev.jobId)
      ? '<option value="' + esc(ev.jobId) + '" selected>' + esc(ev.jobName || 'This entry’s job') + '</option>' : '';
    // "Any time that day" is a box of its own, off unless ticked (Jonah, 15
    // Oct 2026: all the kinds, "and then just a box to check for any time
    // today"). A saved entry keeps what it had; a new one is at a set time --
    // the hour tapped in the grid, else 7 am -- for an hour.
    const allDay = editing.eventId ? (ev.allDay != null ? ev.allDay : !ev.time) : false;
    const startT = ev.time || editing.time || '07:00';
    const endT = ev.endTime || hhmm(minutesOf(startT) + 60);
    // Its tag, as it counts now: an entry nobody tagged already reads as one
    // by its title (remind.js typeOf), so that one is lit.
    const type = typeOfEv(ev, cals[calId]);
    edCal = calId;

    // What it is called and when, first -- the two things every entry
    // needs, at the top of a phone's screen -- then which calendar, what
    // kind of thing and which job, and the rest. The boxes are the same
    // ones whatever their order, so saving reads them just the same.
    openModal(editing.eventId ? 'Edit' : 'Add to the calendar',
      '<div class="field"><span class="label">Title</span>' +
        '<input id="evTitle" value="' + esc(ev.title || '') + '" placeholder="Leave blank to use the job’s name (below)"' +
          ' oninput="calTitleChanged()"></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Date</span>' +
          '<input type="date" id="evDate" value="' + esc(ev.date || editing.date || today()) + '"></div>' +
        '<div class="field"><span class="label">Until (for more than one day)</span>' +
          '<input type="date" id="evEnd" value="' + esc(ev.endDate || '') + '"></div>' +
      '</div>' +
      '<label class="chk"><input type="checkbox" id="evAllDay"' + (allDay ? ' checked' : '') +
        ' onchange="calAllDayChanged()"> Any time that day — no set time</label>' +
      '<div class="grid g2" id="evTimes"' + (allDay ? ' hidden' : '') + '>' +
        '<div class="field"><span class="label">Starts</span>' +
          '<input type="time" id="evTime" value="' + esc(startT) + '" onchange="calRemindHint()"></div>' +
        '<div class="field"><span class="label">Ends</span>' +
          '<input type="time" id="evEndTime" value="' + esc(endT) + '"></div>' +
      '</div>' +
      '<div class="field"><span class="label">Calendar</span><div class="cal-pickcal">' +
        list.map(c => '<label class="cal-pickcal-item" style="--c:' + safeColor(c.color) + '">' +
          '<input type="radio" name="evCal" value="' + c.id + '"' + (c.id === calId ? ' checked' : '') +
          ' onchange="calCalChanged(true)"><span><span class="cal-dot"></span>' + esc(c.name) + '</span></label>').join('') +
      '</div></div>' +
      // Jonah (12 Oct 2026): pick what it is -- some things are at a set time,
      // some just need doing that day. It decides when the phone buzzes. From
      // 16 Oct each calendar has its own tags ("within the calendars I want
      // tags"): a button each, in its colour, only the chosen calendar's
      // (drawTagPick) -- buttons in sight, not a list to open. The one lit is
      // kept in #evType; `picked` once tapped (until then it follows the
      // title and the calendar).
      '<div class="field" id="evTagField"><span class="label" id="evTagLabel">Tag — what it is</span>' +
        '<input type="hidden" id="evType" value="' + esc(type) + '"' +
          (YDRemind.knownOn(cals[calId], ev.type) ? ' data-picked="1"' : '') + '>' +
        '<div class="cal-tagpick" id="evTagChips"></div>' +
        '<div class="hint cal-type-note" id="evTypeNote"></div></div>' +
      '<div class="field"><span class="label" id="evJobLabel">Job</span><select id="evJob" class="searchable" onchange="calJobChanged()">' +
        '<option value="">— not about a job —</option>' +
        jobs.map(j => '<option value="' + esc(j._id) + '"' + (j._id === ev.jobId ? ' selected' : '') + '>' +
          esc(jobPickName(j)) + '</option>').join('') + ownJob +
      '</select></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Repeats</span><select id="evRepeat">' +
          Object.keys(REPEAT).map(r => '<option value="' + r + '"' + ((base.repeat || 'none') === r ? ' selected' : '') + '>' +
            REPEAT[r] + '</option>').join('') + '</select></div>' +
        '<div class="field"><span class="label">Repeat until (optional)</span>' +
          '<input type="date" id="evUntil" value="' + esc(base.repeatUntil || '') + '"></div>' +
      '</div>' +
      // A pop-up on the phone, like Google Calendar's. "Usual" goes by what it
      // is (remind.js) to everyone with automatic reminders on; a set time
      // goes to whoever sets it and to the crew on it.
      '<div class="field"><span class="label">Remind</span><select id="evRemind" onchange="calRemindHint()">' +
        YDRemind.optionsHtml(base) + '</select>' +
        '<div class="hint" id="evRemindHint"></div></div>' +
      '<div class="field" id="evCrewField"><span class="label" id="evCrewLabel">Who is on it</span>' +
        (crew.length ? '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item" style="--c:' + personColor(p.uid) + '">' +
          '<input type="checkbox" class="evWho" value="' + p.uid + '"' + (chosen.has(p.uid) ? ' checked' : '') +
            ' onchange="calWhoTicked(this)">' +
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
    calRemindHint();
    calTypeNote();
  }
  // The tag buttons for the calendar picked: just each one's name. What it
  // is and whether it has a set time are two separate questions -- a pickup
  // can be at 9:00 or any time that day -- answered by two separate boxes.
  // An entry tagged before each calendar had its own list keeps its tag,
  // in sight with the calendar's own, until another is tapped.
  // The Job schedule has none to pick: everything on it is a job's day.
  let edCal = '';           // the calendar the editor's tags were drawn for
  function drawTagPick() {
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    const box = el('evTagChips'), label = el('evTagLabel');
    if (!cal || !box) return;
    const jobs = cal.kind === 'jobs';
    if (label) label.textContent = jobs ? 'What it is' : 'Tag — what it is';
    if (jobs) {
      box.innerHTML = '<div class="cal-jobday-note">🔨 A day on a job — where the crew is working. ' +
        'Pick the job below; it shows in the job’s own colour. No box to tick: the job is finished on the job itself.</div>';
      return;
    }
    const current = val('evType');
    const list = YDRemind.tagsOf(cal);
    const own = current && !list.some(t => t.id === current) ? YDRemind.tagOf(current, cal) : null;
    box.innerHTML = list.concat(own ? [Object.assign({ old: true }, own)] : []).map(t => {
      const on = t.id === current, color = safeColor(t.color);
      return '<button type="button" class="cal-tagpick-b' + (on ? ' on' : '') + '" aria-pressed="' + on + '"' +
        ' style="--c:' + color + ';--ink:' + (t.ink ? safeColor(t.ink) : inkOn(color)) + '"' +
        ' onclick="calTagPick(\'' + safeKey(t.id) + '\')"><span class="cal-tag-dot"></span>' +
        esc((t.icon ? t.icon + ' ' : '') + t.name) + (t.old ? ' <small>(from before)</small>' : '') + '</button>';
    }).join('');
  }
  // A tag tapped: that is what it is now, whatever the title says.
  window.calTagPick = function (id) {
    const box = el('evType');
    if (!box) return;
    box.value = id;
    box.dataset.picked = '1';
    typeNote = '';
    drawTagPick();
    calRemindHint();
    calTypeNote();
  };
  // The jobs the Job box offers: every job, where this device has them (the
  // owner's, an admin's who sees jobs); else -- someone ticked to add to a
  // calendar who cannot read jobs -- the crew's own copies of the jobs on
  // the go (crewjobs.js), which have the name and what each one is.
  function editorJobs() {
    if (ydCan('jobs', 'see') && typeof loadAllJobs === 'function') return loadAllJobs() || [];
    return window.YDCrewJobs && YDCrewJobs.list ? YDCrewJobs.list().map(j => ({ _id: j.id, customerName: j.name, crewWhat: j.what,
      address: j.address, city: j.city, estimateNumber: j.est, jobStatus: j.status })) : [];
  }
  // A job in the Job box: who, its number and where. Two jobs for the same
  // customer (a patio in the spring, beds in the fall) read the same by name
  // alone -- and the number or the street can be typed to find it.
  function jobPickName(j) {
    const num = String(j.estimateNumber || '').trim();
    const where = [j.address, j.city].map(s => String(s || '').trim()).filter(Boolean).join(', ');
    return (j.customerName || 'Untitled job') + (num ? ' #' + num : '') + (where ? ' — ' + where : '');
  }
  function editorActions() {
    return '<button class="btn btn-filled" onclick="calSave()">Save</button>' +
      '<button class="btn btn-sm" onclick="closeCalModal()">Cancel</button>' +
      (editing && editing.eventId ? '<button class="btn btn-sm" onclick="calRemove()">Delete</button>' : '');
  }

  window.calAllDayChanged = function () {
    const t = el('evTimes');
    if (t) t.hidden = el('evAllDay').checked;
    calRemindHint();
    calTypeNote();
  };
  // Picking what it is never touches the time: only the "Any time that
  // day" box does -- nor, now each calendar has its own tags, the calendar:
  // the tags shown are the calendar's, so a tag never moves an entry.
  window.calTypeChanged = function () {
    drawTagPick();
    calRemindHint();
    calTypeNote();
  };
  const calName = id => (cals[id] && cals[id].name) || 'that calendar';
  let typeNote = '';
  // Ticks another calendar in the editor, with a word why under the kind.
  function moveTo(calId, why) {
    const r = document.querySelector('input[name="evCal"][value="' + calId + '"]');
    if (!r || r.checked) return;
    r.checked = true;
    typeNote = why;
    calCalChanged(false);
  }
  window.calTypeNote = function () {
    const note = el('evTypeNote');
    if (note) note.textContent = typeNote;
  };
  // Until a tag is tapped, it follows the title as it is typed (remind.js
  // typeOf: "Pickup mulch" a material pickup, "Send the bid" an email to send, "Call
  // Pat back" a phone call; on the Crew schedule "Fix the trailer lights"
  // an equipment repair).
  window.calTitleChanged = function () {
    const box = el('evType');
    const c = document.querySelector('input[name="evCal"]:checked');
    if (!box || box.dataset.picked || !c) return;
    const want = typeOfEv({ title: val('evTitle') }, cals[c.value]);
    if (box.value !== want) { box.value = want; calTypeChanged(); }
  };
  // Jonah (15 Oct 2026): the Crew schedule has "anything i assign crew
  // members to". Ticking a crew member on something on My work puts it on
  // the Crew schedule, in sight; it can still be picked back.
  window.calWhoTicked = function (box) {
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    if (box && box.checked && cal && cal.kind === 'work' && cals[CREW_CAL] && editsCal(cals[CREW_CAL]) &&
        people[box.value] && YDRemind.isCrewMember(people[box.value])) {
      moveTo(CREW_CAL, 'Goes on the ' + calName(CREW_CAL) + ' — ' + firstName(personName(box.value)) + ' is on it.');
      calTypeNote();
    }
    calWhoChanged();
  };
  // What "Usual" means for this entry as the form stands.
  window.calRemindHint = function () {
    const hint = el('evRemindHint');
    if (!hint) return;
    const choice = val('evRemind');
    const timed = !el('evAllDay').checked && !!val('evTime');
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    const type = val('evType') || typeOfEv({ title: val('evTitle') }, cal);
    hint.innerHTML = choice === 'none' ? 'Nobody gets a reminder for this one.'
      : choice === '' ? YDRemind.usualHint(type, timed, cal)
      : 'To you and anyone on it. Phones need notifications switched on: ⋯ → Notification settings.';
  };
  window.calJobChanged = function () {
    const id = val('evJob');
    const j = id && editorJobs().find(x => x._id === id);
    const a = el('evAddr');
    if (j && a && !a.value.trim()) a.value = [j.address, j.city, j.state].filter(Boolean).join(', ');
    jobTitleHint();
  };
  // A job's name and what it is in a few words (app.js jobWhat / jobLabel):
  // "Pat Smith · Paver patio" -- what a day on the Job schedule is called
  // when its title is left blank.
  function jobTitle(j) {
    const name = j.customerName || 'Untitled job';
    const what = typeof jobWhat === 'function' ? jobWhat(j) : '';
    return typeof jobLabel === 'function' ? jobLabel(name, what) : name + (what ? ' · ' + what : '');
  }
  // The title box says what a blank title will be: the job's name (and, on
  // the Job schedule, what it is).
  function jobTitleHint() {
    const t = el('evTitle');
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    if (!t || !cal) return;
    const id = val('evJob');
    const j = id && editorJobs().find(x => x._id === id);
    t.placeholder = cal.kind === 'jobs'
      ? (j ? jobTitle(j) + ' (from the job)' : 'Leave blank to use the job’s name and what it is')
      : (j ? (j.customerName || 'Untitled job') + ' (from the job)' : 'Leave blank to use the job’s name (below)');
  }
  // Says plainly whether the people being picked will actually see this.
  window.calCalChanged = function (byHand) {
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    const hint = el('evShareHint');
    if (!cal || !hint) return;
    // Another calendar, other tags. A tag tapped is kept when the new
    // calendar has one of the same; otherwise the new calendar's guess from
    // the title is lit -- and said so under the buttons, as a calendar
    // picked never quietly changes what was picked. Until a tag is tapped,
    // it simply follows the calendar and the title (the Crew schedule: a
    // pickup, a repair... else a crew task; Personal: a phone call, the
    // doctor, else personal; My work: a phone call, a pickup, an email...
    // else a to-do).
    const box = el('evType');
    const from = cals[edCal];
    if (byHand === true) typeNote = '';
    if (byHand !== undefined && box && cal.id !== edCal) {
      const was = box.value, picked = !!box.dataset.picked;
      const keeps = picked && was && cal.kind !== 'jobs' && YDRemind.tagsOf(cal).some(t => t.id === was);
      if (!keeps) {
        box.value = typeOfEv({ title: val('evTitle') }, cal);
        delete box.dataset.picked;
        const before = picked && from && YDRemind.tagOf(was, from);
        const now = YDRemind.tagOf(box.value, cal);
        if (before && now && cal.kind !== 'jobs' && box.value !== was) {
          // After any word on why the calendar changed (moveTo).
          typeNote = [typeNote, '“' + before.name + '” is not one of ' + calName(cal.id) + '’s tags — it is ' +
            (now.icon ? now.icon + ' ' : '') + now.name + ' there now. Tap another to change it.'].filter(Boolean).join(' ');
        }
      }
    }
    edCal = cal.id;
    drawTagPick();
    // The Job schedule: the job is the point of the entry, and who is
    // working there.
    const jobs = cal.kind === 'jobs';
    if (el('evJobLabel')) el('evJobLabel').textContent = jobs ? 'Job — which one they are working on' : 'Job';
    if (el('evCrewLabel')) el('evCrewLabel').textContent = jobs ? 'Who is working there' : 'Who is on it';
    jobTitleHint();
    calTypeNote();
    calRemindHint();
    calWhoChanged();
  };

  // Whether one person can see a calendar, as firestore.rules decide it: the
  // owner; anyone on its visibleTo; an admin given Calendars, every one not
  // marked private.
  function seesCal(uid, cal) {
    const p = people[uid];
    if (!cal || !p) return false;
    if (p.role === 'owner' || (cal.visibleTo || []).indexOf(uid) !== -1) return true;
    const level = p.access && p.access.calendars;
    return p.role === 'admin' && (level === 'see' || level === 'change') && cal.ownerOnly === false;
  }
  // Ticked on an entry but not able to see its calendar: they would never
  // see it, and the reminder would go to a phone that cannot open it. Said
  // right under the names, and the owner can share the calendar with them
  // there and then -- the same visibleTo that ⚙ Manage calendars writes.
  function unseeing(cal) {
    return Array.from(document.querySelectorAll('.evWho:checked')).map(i => i.value)
      .filter(uid => people[uid] && !seesCal(uid, cal));
  }
  window.calWhoChanged = function () {
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    const hint = el('evShareHint');
    if (!cal || !hint) return;
    const names = list => list.map(u => firstName(personName(u))).join(', ');
    const n = (cal.visibleTo || []).length;
    const missing = unseeing(cal);
    const who = esc(names(missing));
    hint.innerHTML = (cal.kind === 'personal' ? 'Personal: you, and admins can look — never the crew.'
        : n ? esc(cal.name) + ' is shared with ' + esc(names(cal.visibleTo)) +
            (cal.lookOnly === true ? ' — to look at; they can’t tick anything off.' : '.')
        : esc(cal.name) + ' is not shared with anyone yet.') +
      (!missing.length ? ''
        : '<div class="cal-share-ask">⚠ <b>' + who + '</b> can’t see ' + esc(cal.name) + ', so won’t see this entry.' +
          // Personal is never shared; the Crew schedule (and My work) follow
          // who is ticked as crew on Your Crew (shareCrewCals would take
          // anyone else off).
          (cal.kind === 'personal' ? ' Pick another calendar for them to see it.'
            : sharedWithCrew(cal) ? ' ' + esc(cal.name) + ' is shared with everyone ticked as a crew member on Your Crew.'
            : isOwner() ? ' <button type="button" class="btn btn-sm btn-filled" onclick="calShareWith()">Share ' +
                esc(cal.name) + ' with ' + who + '</button>'
            : ' Ask Jonah to share it with them.') +
        '</div>');
  };
  window.calShareWith = function () {
    if (!isOwner()) return;
    const c = document.querySelector('input[name="evCal"]:checked');
    const cal = c && cals[c.value];
    if (!cal || cal.kind === 'personal' || cal.kind === 'crew') return;
    const add = unseeing(cal);
    if (!add.length) return;
    cal.visibleTo = Array.from(new Set((cal.visibleTo || []).concat(add)));
    write('calendars', cal.id, { visibleTo: cal.visibleTo, updatedAt: nowIso() }, 'sharing ' + (cal.name || 'a calendar'));
    showToast(cal.name + ' is shared with ' + add.map(u => firstName(personName(u))).join(', ') + ' now');
    calWhoChanged();
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
    const job = jobId ? editorJobs().find(j => j._id === jobId) : null;
    // The entry's own job when this device cannot list it (a finished job,
    // or a phone that cannot read jobs): kept as it was, not dropped.
    const was = ed.eventId ? (events[ed.calId] || {})[ed.eventId] : null;
    const keptJob = !job && jobId && was && was.jobId === jobId ? { _id: jobId, customerName: was.jobName || '' } : null;
    const theJob = job || keptJob;
    const onJobs = !!cals[calId] && cals[calId].kind === 'jobs';
    // Jonah (16 Oct 2026): the Job schedule is "solely for where the crew is
    // working each day" -- an entry there is a day on a job, so it needs one.
    if (onJobs && !theJob) { showToast('Pick the job — the Job schedule is where the crew is working'); return null; }
    // Left blank, a day on the Job schedule is called by its job and what
    // the job is ("Pat Smith · Paver patio"); anything else by the job's name.
    const title = val('evTitle') || (job ? (onJobs ? jobTitle(job) : job.customerName || 'Job')
      : keptJob ? (keptJob.customerName || 'Job') : '');
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
      jobId: theJob ? theJob._id : null,
      jobName: theJob ? (theJob.customerName || 'Untitled job') : null,
      address: val('evAddr'),
      crew: Array.from(document.querySelectorAll('.evWho:checked'))
        .map(i => crew.find(p => p.uid === i.value)).filter(Boolean)
        .map(p => ({ uid: p.uid, name: p.name })),
      notes: el('evNotes').value.trim(),
      // Its tag: kept when it was tapped, or is not what the calendar and
      // the title make it anyway; one that only followed them is left to
      // follow them, so an entry moved to another calendar takes on that
      // one's. Only a tag this calendar knows (remind.js knownOn). On the
      // Job schedule there is nothing to keep: it is a job's day.
      type: !onJobs && YDRemind.knownOn(cals[calId], val('evType')) && (el('evType').dataset.picked ||
        val('evType') !== typeOfEv({ title: title }, cals[calId])) ? val('evType') : null,
      updatedAt: nowIso(),
    };
    // The job's own colour, for the crew's phones (jobColorOf): they cannot
    // read the job. Kept in step afterwards by the owner's (fillJobColors).
    if (onJobs) {
      rec.jobColor = job && ydCan('jobs', 'see') ? (isHex(job.cardColor) ? job.cardColor : null)
        : was && was.jobId === rec.jobId ? was.jobColor || null : null;
    }
    // The reminder: the usual one, none, or a set time (and who asked for it).
    const base = ed.eventId ? (events[ed.calId] || {})[ed.eventId] : null;
    Object.assign(rec, YDRemind.fromChoice(val('evRemind'), base, (me() || {}).uid));
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
      rec.createdBy = (me() || {}).uid || null;
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
        r.hasReminder !== !!base.hasReminder || (r.remindMins == null ? null : r.remindMins) !== (base.remindMins == null ? null : base.remindMins) ||
        !!r.noReminder !== !!base.noReminder;
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

  window.calRemove = async function () {
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
    const nFiles = (base.files || []).length;
    if (!(await ydConfirm('', { title: 'Delete "' + (base.title || 'this') + '"' + (isRepeating(base) ? ' and every repeat of it' : '') +
        (nFiles ? ' and its ' + nFiles + ' attached file' + (nFiles === 1 ? '' : 's') : '') + '?',
      ok: 'Delete', danger: true }))) return;
    if (editing !== ed || !(events[ed.calId] || {})[ed.eventId]) return;
    delete events[ed.calId][ed.eventId];
    removeEvent(ed.calId, ed.eventId);
    dropFiles(base);
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
  const OCC_FIELDS = ['date', 'endDate', 'allDay', 'time', 'endTime', 'title', 'jobId', 'jobName', 'address', 'crew', 'notes', 'type'];
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
    // "Repeat until" as the entry had it before this change. Read now:
    // `base` is the copy on screen, and "this date and the ones after" ends
    // it the day before (applyLocal) before the new series is worked out --
    // read after that, the new series ended on its own first date and every
    // later date of it was lost (found 15 Oct 2026).
    const baseUntil = base.repeatUntil || null;
    // Never a repeat that stops before it starts.
    const untilFor = (start, given) => {
      let u = given !== undefined ? given : (baseUntil && delta ? addDays(baseUntil, delta) : baseUntil);
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
    dropFiles(base);
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
      // Only the days on screen: the ones drawn out of sight either side
      // (gridHtml) are not somewhere to drop it.
      const cols = Array.from(document.querySelectorAll('#calBody .cg-col:not(.cg-nb)'));
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

  // Once an entry is held, the finger moves it rather than the page. A
  // listener that may stop the page scrolling makes the browser wait on the
  // page before every scroll that starts over it, so it goes only on the
  // entries that can be dragged -- on the whole calendar, every swipe through
  // the hours waited (review, 12 Oct). Not added when the hold begins: the
  // browser settles whether a touch can be stopped from scrolling as the
  // finger lands, so one added then could not keep the page still.
  function holdTouch(e) { if (drag && drag.live && e.cancelable) e.preventDefault(); }
  function wireHolds() {
    document.querySelectorAll('#calBody [data-k].mv').forEach(n =>
      n.addEventListener('touchmove', holdTouch, { passive: false }));
  }

  // --------------------------------------------------------------- swiping
  //
  // Jonah (14 Oct 2026): "make sideways scrolling on the calendar smooth
  // instead of choppy. right now when i do it it just cuts to the next 3
  // days i want it to be smooth like it is on google calendar." So the days
  // follow the finger: the days either side are already drawn out of sight
  // (gridHtml, monthHtml), and a sideways drag slides them in under it. Let
  // go past a third of the way, or with a flick, and they glide the rest of
  // the way (PAN_MS, slowing as they land); a short slow drag glides back.
  // Only when the glide has finished is the calendar drawn again on its new
  // days -- drawn exactly where the glide stopped, so nothing jumps. My day
  // has no neighbours drawn: it slides out, and the next day slides in.
  //
  // Up-and-down stays the browser's own scrolling: the swipe areas allow it
  // only vertical panning (touch-action, styles.css), so a finger that sets
  // off up or down scrolls the hours (the browser takes it and says
  // pointercancel), and one that sets off sideways is ours. A finger held
  // still on an entry still picks it up to move it (onDown); one that moves
  // first is a swipe. The mouse drags entries and uses the arrows; a
  // trackpad's sideways scroll slides the days too (onWheel). Anyone who has
  // asked their device for less motion gets no glide.
  const PAN_VIEWS = { day: 1, '3day': 1, week: 1, month: 1, myday: 1 };
  const PAN_MS = 240;
  let pan = null;           // a finger on a swipe area: { id, x0, y0, dir '' | 'x', dx, pts, t }
  let settling = false;     // gliding into place after a swipe
  let panRedraw = false;    // something changed during a swipe: draw when it is over
  let wheel = null;         // a trackpad's sideways scroll under way
  let wheelQuiet = 0;       // after one: wait for its momentum to die away
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // What slides, how wide a period is, and whether the days either side are
  // there to slide in.
  function panTargets() {
    const body = el('calBody');
    if (!body) return null;
    if (isGrid()) {
      const vp = body.querySelector('.cg-body .cg-vp');
      return vp && { els: Array.from(body.querySelectorAll('.cg-track')), w: vp.clientWidth, nb: true };
    }
    if (view === 'month') {
      const vp = body.querySelector('.cal-pan-vp');
      return vp && vp.firstElementChild && { els: [vp.firstElementChild], w: vp.clientWidth, nb: true };
    }
    if (view === 'myday') {
      const m = body.querySelector('.md');
      return m && { els: [m], w: body.clientWidth, nb: false };
    }
    return null;
  }
  function slideTo(t, x, ms) {
    const at = (t.nb ? -t.w : 0) + x;
    t.els.forEach(n => {
      n.style.transition = ms ? 'transform ' + ms + 'ms cubic-bezier(.22,.61,.36,1)' : 'none';
      n.style.transform = 'translate3d(' + at + 'px,0,0)';
    });
  }
  function letGo(t) {
    t.els.forEach(n => { n.style.transition = ''; n.style.transform = ''; n.style.willChange = ''; });
  }
  // `step`: 1 the next days, -1 the ones before, 0 back where it was.
  function settle(t, step) {
    settling = true;
    let over = false;
    const ended = e => { if (e.target === t.els[0]) finish(); };   // not a button's own fade inside it
    const finish = () => {
      if (over) return;
      over = true;
      settling = false;
      t.els[0].removeEventListener('transitionend', ended);
      if (step) {
        const w = t.w;
        calStep(step);
        if (!t.nb) slideIn(step * w);
      } else {
        letGo(t);
        if (panRedraw) render();
      }
      panRedraw = false;
    };
    const ms = reduceMotion() ? 0 : PAN_MS;
    if (!ms) { finish(); return; }
    slideTo(t, -step * t.w, ms);
    t.els[0].addEventListener('transitionend', ended);
    setTimeout(finish, ms + 80);          // no transitionend when nothing had to move
  }
  // My day: the new day comes in from the side the old one left by.
  function slideIn(from) {
    const m = document.querySelector('#calBody .md');
    if (!m || reduceMotion()) return;
    m.style.transition = 'none';
    m.style.transform = 'translate3d(' + from + 'px,0,0)';
    void m.offsetWidth;                   // placed there before the glide starts
    m.style.transition = 'transform ' + PAN_MS + 'ms cubic-bezier(.22,.61,.36,1)';
    m.style.transform = '';
    setTimeout(() => { m.style.transition = ''; }, PAN_MS + 80);
  }

  function panDown(e) {
    // A swipe whose finger was never heard lifting (the app was left
    // mid-swipe) is over: left in place it would stop every redraw.
    if (pan && e.isPrimary && e.pointerId !== pan.id) panCancel();
    if (e.pointerType === 'mouse' || !e.isPrimary || pan || settling || wheel || !PAN_VIEWS[view]) return;
    if (!e.target.closest || !e.target.closest('#calBody .cal-pan')) return;
    pan = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dir: '', dx: 0, pts: [[e.timeStamp, e.clientX]] };
  }
  function panMove(e) {
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x0, dy = e.clientY - pan.y0;
    if (!pan.dir) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      // Up or down, or an entry already being moved: not a swipe.
      if (Math.abs(dy) >= Math.abs(dx) || (drag && drag.live)) { pan = null; return; }
      const t = panTargets();
      if (!t || !t.w) { pan = null; return; }
      // A finger that might have been about to pick up an entry is sliding
      // the days instead.
      if (drag) stopDrag();
      pan.dir = 'x'; pan.t = t;
      t.els.forEach(n => { n.style.willChange = 'transform'; });
    }
    if (e.cancelable) e.preventDefault();
    pan.dx = clamp(dx, -pan.t.w, pan.t.w);
    pan.pts.push([e.timeStamp, e.clientX]);
    while (pan.pts.length > 2 && e.timeStamp - pan.pts[0][0] > 100) pan.pts.shift();
    slideTo(pan.t, pan.dx, 0);
  }
  function panUp(e) {
    if (!pan || e.pointerId !== pan.id) return;
    const p = pan;
    pan = null;
    if (p.dir !== 'x') return;
    justDragged = Date.now();             // the lift is not a tap on what it ends over
    // How fast it was going as it was let go: the last tenth of a second
    // (a finger that stopped before lifting was not flicking).
    const pts = p.pts.concat([[e.timeStamp, e.clientX]]).filter(q => e.timeStamp - q[0] <= 100);
    const ms = pts.length > 1 ? pts[pts.length - 1][0] - pts[0][0] : 0;
    const v = ms > 0 ? (pts[pts.length - 1][1] - pts[0][1]) / ms : 0;      // px per ms; minus is leftwards
    let step = 0;
    if (Math.abs(v) > 0.35 && Math.abs(p.dx) > 24 && Math.sign(v) === Math.sign(p.dx)) step = v < 0 ? 1 : -1;
    else if (Math.abs(p.dx) > p.t.w / 3) step = p.dx < 0 ? 1 : -1;
    settle(p.t, step);
  }
  function panCancel(e) {
    if (!pan || (e && e.pointerId !== pan.id)) return;
    const p = pan;
    pan = null;
    if (p.dir === 'x') settle(p.t, 0);
  }

  // A trackpad's sideways scroll (or shift + the mouse wheel): the days
  // follow it, and settle as a swipe does once it stops. Its momentum keeps
  // sending scrolls after the fingers lift; they are let die away before
  // another can begin, or one swipe would move two weeks.
  function onWheel(e) {
    if (!PAN_VIEWS[view] || e.ctrlKey || !e.target.closest || !e.target.closest('#calBody .cal-pan')) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit;
    if (Math.abs(dx) <= Math.abs(e.deltaY * unit)) return;    // up or down: the hours scroll
    // Sideways is ours -- and not the browser's "back a page" swipe.
    e.preventDefault();
    if (Date.now() < wheelQuiet) { wheelQuiet = Date.now() + 250; return; }
    if (settling || pan || (drag && drag.live)) return;
    if (!wheel) {
      const t = panTargets();
      if (!t || !t.w) return;
      wheel = { acc: 0, t: t, timer: 0 };
      t.els.forEach(n => { n.style.willChange = 'transform'; });
    }
    wheel.acc += dx;
    slideTo(wheel.t, clamp(-wheel.acc, -wheel.t.w, wheel.t.w), 0);
    clearTimeout(wheel.timer);
    if (Math.abs(wheel.acc) > wheel.t.w / 2) wheelEnd();
    else wheel.timer = setTimeout(wheelEnd, 140);
  }
  function wheelEnd() {
    const w = wheel;
    if (!w) return;
    wheel = null;
    clearTimeout(w.timer);
    justDragged = Date.now();
    wheelQuiet = Date.now() + 250;
    settle(w.t, Math.abs(w.acc) >= Math.min(100, w.t.w / 4) ? (w.acc > 0 ? 1 : -1) : 0);
  }

  function wire() {
    const wrap = el('calWrap');
    if (!wrap || wrap.dataset.wired) return;
    wrap.dataset.wired = '1';
    wrap.addEventListener('pointerdown', onDown);
    wrap.addEventListener('pointerdown', panDown);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointermove', panMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointerup', panUp);
    window.addEventListener('pointercancel', e => {
      panCancel(e);
      const was = drag && drag.live; stopDrag(); if (was) render();
    });
    // Holding an entry: see wireHolds.
    wrap.addEventListener('wheel', onWheel, { passive: false });
    // Switched away from mid-swipe: it goes back where it was.
    document.addEventListener('visibilitychange', () => { if (document.hidden) panCancel(); });
    // The red line at now keeps up.
    setInterval(() => document.querySelectorAll('#calBody .cg-now').forEach(n => { n.style.top = nowTop() + 'px'; }), 60000);
    // A phone turned on its side, or the window resized: the hours fit the
    // new screen (fitGrid).
    let fitTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => { if (isGrid()) fitGrid(); }, 150);
    });
  }

  // ------------------------------------------------------ manage calendars

  window.calManage = function () {
    if (!isOwner()) return;
    openModal('Calendars',
      '<div class="cal-manage">' + storedCals().map(c =>
        '<div class="cal-manage-row" style="--c:' + safeColor(c.color) + '">' +
          '<span class="cal-dot"></span>' +
          '<div class="cal-manage-name"><b>' + esc(c.name) + '</b><span class="muted">' +
            (c.kind === 'personal' ? 'You — admins can look, nobody else'
              : (c.visibleTo || []).length ? (sharedWithCrew(c) ? 'Every crew member' : 'Shared with ' +
                  c.visibleTo.map(u => esc(firstName(personName(u)))).join(', ')) +
                (c.lookOnly === true ? ' can look' : '') +
                ((c.editors || []).length ? ' · ' + c.editors.map(u => esc(firstName(personName(u)))).join(', ') + ' can change it' : '')
              : 'Only you so far') + '</span>' +
            // Its tags at a glance (Edit changes them).
            '<span class="cal-manage-tags">' + (c.kind === 'jobs' ? '<span class="muted">🔨 Job days, each in its job’s colour</span>'
              : YDRemind.tagsOf(c).map(t => '<span class="cal-tag sm" style="--c:' + safeColor(t.color) + '"><span class="cal-tag-dot"></span>' +
                  esc((t.icon ? t.icon + ' ' : '') + t.name) + '</span>').join('')) + '</span>' +
          '</div>' +
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
    const editors = new Set(c.editors || []);
    const color = c.color || PALETTE[(Object.keys(cals).length + 3) % PALETTE.length];
    openModal(id ? 'Edit ' + esc(c.name) : 'New calendar',
      '<div class="field"><span class="label">Name</span>' +
        '<input id="ccName" value="' + esc(c.name || '') + '" placeholder="e.g. Mowing route"></div>' +
      '<div class="field"><span class="label">Colour</span><div class="bd-swatches">' +
        PALETTE.map(p => '<label class="bd-swatch" style="--c:' + p + '"><input type="radio" name="ccColor" value="' + p + '"' +
          (p === color ? ' checked' : '') + '><span></span></label>').join('') + '</div></div>' +
      tagEditorHtml(c) +
      (c.kind === 'personal' ? '<div class="hint">Personal is never shared with the crew. Admins with Calendars ' +
          'access can look at it, and never change it.</div>' :
        '<div class="field"><span class="label">Who can see it</span>' +
          // Every crew member, kept so by itself (shareCrewCals) -- or the
          // people picked by hand. Two separate answers, so one never
          // quietly undoes the other: with the crew tick on, the picks are
          // put away rather than shown and then overwritten.
          (c.kind === 'crew' ? '' :
            '<label class="chk"><input type="checkbox" id="ccCrewSees"' + (c.crewSees === true ? ' checked' : '') +
              ' onchange="document.getElementById(\'ccShareBox\').hidden = this.checked"> 👷 Every crew member ' +
              '(everyone ticked as crew on Your Crew, now and later)</label>') +
          '<div id="ccShareBox"' + (c.kind !== 'crew' && c.crewSees === true ? ' hidden' : '') + '>' +
          (crew.length ? '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="ccShare" value="' +
              p.uid + '"' + (shared.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') + '</div>' +
            '<div class="hint">Anyone ticked sees every event on this calendar, including the address.' +
            (c.kind === 'crew' ? ' Everyone ticked as a crew member on Your Crew sees this one by itself.' : '') + '</div>'
            : '<div class="hint">No crew accounts yet. Once someone signs in and you approve them, they appear here.</div>') +
          '</div>' +
          '<label class="chk"><input type="checkbox" id="ccLookOnly"' + (c.lookOnly === true ? ' checked' : '') +
            '> 👀 Look only — they see it, and can’t tick anything off or change it</label>' +
          '<div class="hint">Unticked, anyone it is shared with can tick off a day’s entry that is theirs or that ' +
            'nobody is on. Whoever is under “Who can add &amp; change” always can.</div>' +
        '</div>' +
        (crew.length ? '<div class="field"><span class="label">Who can add &amp; change</span>' +
          '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="ccEdit" value="' +
              p.uid + '"' + (editors.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') + '</div>' +
          '<div class="hint">Anyone ticked here adds, changes and deletes entries on this calendar only (and sees it). ' +
            'An admin whose Calendars access is “change” can change every calendar not marked private — for ' +
            'hand-picking, set theirs to “see” on Your Crew and tick them here.</div></div>' : '') +
        '<label class="chk"><input type="checkbox" id="ccPrivate"' + (c.ownerOnly ? ' checked' : '') +
          '> Private — admins with Calendars access do not see it (anyone ticked above still does)</label>') +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="calSaveCal(\'' + (id || '') + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="calManage()">Back</button>' +
        (id && c.kind === 'custom' ? '<button class="btn btn-sm" onclick="calRemoveCal(\'' + id + '\')">Delete calendar</button>' : '') +
      '</div>');
  };

  // ------------------------------------------- a calendar's tags, by hand
  //
  // Jonah (16 Oct 2026): tags "and set colors" within each calendar. The
  // owner changes any calendar's list here: renames one, gives it another
  // colour (one of these, or any from the colour box), adds one, takes one
  // off. Saved with the calendar as `tags` [{id, name, icon, color,
  // appointment}] -- only once changed, so a calendar never touched keeps
  // the list it started with (remind.js CAL_TAGS). An entry keeps its tag's
  // id: renamed or recoloured, it follows; taken off, it reads as whatever
  // the calendar makes of its title (remind.js typeOf). Each tag's colour
  // stands out from the others; red, orange and grey are the urgency
  // colours everywhere else in Job Hub, so none is offered here (the colour
  // box still allows anything).
  const TAG_COLORS = ['#2f8f5b', '#7a4fd1', '#c026d3', '#8b5a2b', '#702018', '#f09888', '#c8a880', '#504028', '#2a3d8f',
                      '#13a7c4', '#8ab81e', '#0f766e', '#4d6b1a', '#a3369b', '#2f6fd6', '#d94f8a', '#f2c230', '#1a9c8c', '#66418f'];
  let tagDraft = null;      // the tags being edited, or null (the Job schedule has none)
  let tagsDirty = false;    // changed in this window: only then are they saved
  function tagEditorHtml(c) {
    tagsDirty = false;
    if (c.kind === 'jobs') {
      tagDraft = null;
      return '<div class="field"><span class="label">Tags</span><div class="hint">Every entry here is a day on a job — ' +
        'where the crew is working — shown in that job’s own colour (its card’s colour on the Jobs board). No tags to pick.</div></div>';
    }
    tagDraft = YDRemind.tagsOf(c.kind ? c : { kind: 'custom' })
      .map(t => ({ id: t.id, name: t.name, icon: t.icon || '', color: isHex(t.color) ? t.color.toLowerCase() : '#6b7a8f', appointment: !!t.appointment }));
    return '<div class="field"><span class="label">Tags — what an entry on it can be</span>' +
      '<div class="cc-tags" id="ccTags">' + tagRowsHtml() + '</div>' +
      '<button type="button" class="btn btn-sm cc-tag-add" onclick="calTagAdd()">+ Add a tag</button>' +
      '<div class="hint">Each entry gets one tag, in its colour. Renamed or given another colour, its entries follow; ' +
        'taken off, they go by their titles. Red, orange and grey mean late, today and whenever elsewhere in Job Hub — best left for those.</div></div>';
  }
  function tagRowsHtml() {
    return tagDraft.map((t, i) => '<div class="cc-tag" style="--c:' + safeColor(t.color) + '">' +
      '<div class="cc-tag-top"><span class="cc-tag-dot" aria-hidden="true"></span>' +
        '<input class="cc-tag-icon" value="' + esc(t.icon) + '" maxlength="4" placeholder="🏷" aria-label="Icon (optional)"' +
          ' oninput="calTagSet(' + i + ', \'icon\', this.value)">' +
        '<input class="cc-tag-name" value="' + esc(t.name) + '" maxlength="40" placeholder="Name it" aria-label="Tag name"' +
          ' oninput="calTagSet(' + i + ', \'name\', this.value)">' +
        '<button type="button" class="cc-tag-x" onclick="calTagDrop(' + i + ')" aria-label="Take ' + esc(t.name || 'this tag') + ' off">✕</button>' +
      '</div>' +
      '<div class="cc-tag-colors">' + TAG_COLORS.map(col => '<button type="button" class="cc-tag-sw' + (col === t.color ? ' on' : '') +
          '" style="--s:' + col + '" aria-label="Colour ' + col + '" aria-pressed="' + (col === t.color) + '"' +
          ' onclick="calTagSet(' + i + ', \'color\', \'' + col + '\')"></button>').join('') +
        '<input type="color" class="cc-tag-pick" value="' + safeColor(t.color) + '" aria-label="Another colour"' +
          ' onchange="calTagSet(' + i + ', \'color\', this.value)">' +
      '</div>' +
      '<label class="chk cc-tag-appt"><input type="checkbox"' + (t.appointment ? ' checked' : '') +
        ' onchange="calTagSet(' + i + ', \'appointment\', this.checked)"> Just happens at its time — nothing to tick off</label>' +
    '</div>').join('');
  }
  window.calTagSet = function (i, field, value) {
    const t = tagDraft && tagDraft[i];
    if (!t) return;
    if (field === 'color') { if (!isHex(value)) return; t.color = String(value).toLowerCase(); }
    else if (field === 'appointment') t.appointment = !!value;
    else if (field === 'name') t.name = String(value || '').slice(0, 40);
    else if (field === 'icon') t.icon = String(value || '').trim().slice(0, 4);
    tagsDirty = true;
    // A colour redraws the rows (its swatch lit, the row's stripe); typing
    // does not, so the box being typed in keeps its place.
    if (field === 'color' && el('ccTags')) el('ccTags').innerHTML = tagRowsHtml();
  };
  window.calTagAdd = function () {
    if (!tagDraft || !el('ccTags')) return;
    const used = tagDraft.map(t => t.color);
    tagDraft.push({ id: newId('tg'), name: '', icon: '', color: TAG_COLORS.find(c => used.indexOf(c) === -1) || TAG_COLORS[0],
                    appointment: false });
    tagsDirty = true;
    el('ccTags').innerHTML = tagRowsHtml();
    const boxes = document.querySelectorAll('#ccTags .cc-tag-name');
    if (boxes.length) boxes[boxes.length - 1].focus();
  };
  window.calTagDrop = function (i) {
    if (!tagDraft || !tagDraft[i] || !el('ccTags')) return;
    if (tagDraft.length < 2) { showToast('A calendar keeps at least one tag'); return; }
    tagDraft.splice(i, 1);
    tagsDirty = true;
    el('ccTags').innerHTML = tagRowsHtml();
  };
  // The tags as they will be saved, or null (with a word why) when one has
  // no name. A built-in left nameless keeps its own.
  function tagsToSave() {
    const out = [];
    for (const t of tagDraft) {
      const b = YDRemind.typeById(t.id);
      const name = String(t.name || '').trim() || (b ? b.name : '');
      if (!name) { showToast('Give each tag a name'); return null; }
      out.push({ id: t.id, name: name, icon: String(t.icon || ''), color: isHex(t.color) ? t.color : '#6b7a8f', appointment: !!t.appointment });
    }
    return out;
  }

  window.calSaveCal = function (id) {
    if (!isOwner()) return;
    const name = val('ccName');
    if (!name) { showToast('Give it a name'); return; }
    const tags = tagDraft && tagsDirty ? tagsToSave() : null;
    if (tagDraft && tagsDirty && !tags) return;
    const was = id ? cals[id] : null;
    const cid = id || newId('cal');
    const colorInput = document.querySelector('input[name="ccColor"]:checked');
    const rec = {
      name: name,
      color: colorInput ? colorInput.value : PALETTE[0],
      kind: was ? was.kind : 'custom',
      // Personal is never shared, whatever was ticked: admins look (seeOnly),
      // nobody else. Whoever may change any other one sees it too.
      editors: was && was.kind === 'personal' ? []
        : Array.from(document.querySelectorAll('.ccEdit:checked')).map(i => i.value),
      // Always written, true or false: an admin's calendars are fetched by
      // asking for ownerOnly == false, and a calendar without the field at
      // all would be missing from their screen.
      ownerOnly: was && was.kind === 'personal' ? false : !!(el('ccPrivate') && el('ccPrivate').checked),
      seeOnly: !!(was && was.kind === 'personal'),
      visibleTo: [],
      order: was && was.order != null ? was.order : Object.keys(cals).length + 1,
      updatedAt: nowIso(),
    };
    if (!(was && was.kind === 'personal')) {
      rec.crewSees = !!(el('ccCrewSees') && el('ccCrewSees').checked);
      rec.lookOnly = !!(el('ccLookOnly') && el('ccLookOnly').checked);
      // Every crew member: shared with them straight away, as the owner's
      // device keeps it from now on (shareCrewCals).
      const picked = rec.crewSees && peopleLoaded ? crewMemberUids()
        : Array.from(document.querySelectorAll('.ccShare:checked')).map(i => i.value);
      rec.visibleTo = Array.from(new Set(picked.concat(rec.editors)));
    }
    // With the built-ins this list was made knowing about, so one added to
    // the app later still joins it, and one he took off stays off
    // (remind.js ADDED_LATER).
    if (tags) { rec.tags = tags; rec.tagsSeen = YDRemind.startIds(rec.kind); }
    cals[cid] = Object.assign({ id: cid }, was || {}, rec);
    write('calendars', cid, rec, 'saving ' + name);
    if (!eventUnsubs[cid]) watchEvents(cid);
    calManage(); render();
  };

  window.calRemoveCal = async function (id) {
    if (!isOwner()) return;
    const c = cals[id];
    if (!c || !(await ydConfirm('This cannot be undone.', { title: 'Delete the calendar "' + c.name + '"' +
        (Object.keys(events[id] || {}).length ? ' and its ' + Object.keys(events[id] || {}).length + ' events' : '') + '?',
        ok: 'Delete the calendar', danger: true }))) return;
    if (!cals[id]) return;
    // Its events as they are now, added to since the question was asked or not.
    const ids = Object.keys(events[id] || {});
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
    // Every change to an entry carries who made it and when: the owner's
    // phone is told what the crew added or changed (functions/reminders.py
    // _activity), and the day's summary lists what was added.
    if (/\/events$/.test(path) && data && me()) data = Object.assign({}, data, { updatedAt: nowIso(), updatedBy: me().uid });
    // Who is on it, as the rules read it (canTick): worked out from the
    // entry as it will be once this merges in.
    if (/\/events$/.test(path) && data && ('crew' in data || 'exceptions' in data)) {
      const was = (events[path.split('/')[1]] || {})[id] || {};
      const ex = data.exceptions === null ? {} : Object.assign({}, was.exceptions, data.exceptions);
      data = Object.assign({}, data, { crewUids: crewUidsOf({ crew: 'crew' in data ? data.crew : was.crew, exceptions: ex }) });
    }
    Promise.resolve(window.YDDb.put(path, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[calendar] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }

  // --------------------------------------------------------------- loading

  // Entries saved before crewUids existed (15 Oct 2026) get it from the
  // owner's device, once each, from the server's copy -- until then the
  // rules let anyone it is shared with tick them, as before.
  const crewUidsAsked = new Set();
  function fillCrewUids(calId) {
    if (!isOwner() || !window.YDDb) return;
    Object.values(events[calId] || {}).forEach(ev => {
      const want = crewUidsOf(ev), have = (Array.isArray(ev.crewUids) ? ev.crewUids : []).slice().sort();
      const key = calId + '/' + ev.id;
      if (want.join(',') === have.join(',') || crewUidsAsked.has(key)) return;
      crewUidsAsked.add(key);
      Promise.resolve(window.YDDb.put('calendars/' + calId + '/events', ev.id, { crewUids: want }))
        .catch(e => console.warn('[calendar] who is on an entry not yet on the server:', (e && e.code) || e));
    });
  }
  function watchEvents(calId) {
    if (eventUnsubs[calId] || !window.YDDb) return;
    eventUnsubs[calId] = window.YDDb.watch('calendars/' + calId + '/events', (changes, meta) => {
      const set = events[calId] = events[calId] || {};
      changes.forEach(c => {
        if (c.type === 'removed') delete set[c.id];
        else set[c.id] = Object.assign({ id: c.id }, c.data);
      });
      if (meta && meta.fromCache === false) { fillCrewUids(calId); if (calId === JOBS_CAL) fillJobColors(); }
      redrawIfVisible();
      announce();
    });
  }

  // Home (home.js) shows today from here and redraws when told. Every
  // calendar's entries, the storms and the people each answer on their own
  // at start-up; the ones in one moment are told once. A timer, not the
  // next frame: a phone with the app in the background draws no frames, and
  // Home must still be right when it comes back.
  let announceTimer = 0;
  function announce() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => document.dispatchEvent(new CustomEvent('yd-calendar-changed')), 120);
  }

  function onCals(changes, meta) {
    calsHeard = true;
    changes.forEach(c => {
      // A calendar folded into another (15 Oct 2026: Site visits and
      // Follow-ups into My work) is as good as gone: nothing of it shows.
      if (c.type === 'removed' || (c.data && c.data.mergedInto)) {
        delete cals[c.id];
        if (eventUnsubs[c.id]) { eventUnsubs[c.id](); delete eventUnsubs[c.id]; }
        delete events[c.id];
      } else {
        cals[c.id] = Object.assign({ id: c.id }, c.data);
        // "My work" is Jonah's: on anyone else's screen it says whose, or
        // the crew read it as their own. Only on this screen -- nobody but
        // the owner writes a calendar (firestore.rules).
        if (c.id === WORK_CAL && !isOwner() && cals[c.id].name === 'My work') {
          cals[c.id].name = 'Jonah’s work';
          cals[c.id].about = 'Jonah’s own work: quote appointments, pickups, emails to send';
        }
        watchEvents(c.id);
      }
    });
    // Seed the four calendars once the server has answered -- and only the
    // ones missing, so a calendar the owner deleted is not resurrected
    // unless it is one of the four.
    if (isOwner() && !seeded && meta && !meta.fromCache) {
      seeded = true;
      const newJobs = !cals[JOBS_CAL];
      SEED.forEach(s => {
        if (cals[s.id]) return;
        const rec = { name: s.name, color: s.color, kind: s.kind, order: s.order, visibleTo: [],
                      ownerOnly: false, seeOnly: !!s.seeOnly, crewSees: !!s.crewSees, lookOnly: !!s.lookOnly,
                      about: s.about, updatedAt: nowIso() };
        cals[s.id] = Object.assign({ id: s.id }, rec);
        write('calendars', s.id, rec, 'seeding');
        watchEvents(s.id);
      });
      // The Job schedule just made (16 Oct 2026): it goes second, so the
      // Crew schedule and Personal move down one -- only where they are
      // still where the seed put them -- and the Crew schedule's words say
      // what it holds now (its job days have a calendar of their own).
      if (newJobs) {
        Object.keys(OLD_ORDER).forEach(id => {
          const c = cals[id], s = SEED.find(x => x.id === id);
          if (!c || !s) return;
          const patch = {};
          if (c.order === OLD_ORDER[id]) patch.order = s.order;
          if (id === CREW_CAL && c.about === 'Where the crew are working and their tasks — the crew see this one') patch.about = s.about;
          if (!Object.keys(patch).length) return;
          Object.assign(c, patch);
          write('calendars', id, Object.assign(patch, { updatedAt: nowIso() }), 'making room for the Job schedule');
        });
      }
      // My work as it was before 16 Oct (no crewSees at all): shared with
      // the crew to look at, once, as Jonah asked. Unticked later in its
      // settings, it stays unticked (the field is there then).
      const work = cals[WORK_CAL], ws = SEED.find(s => s.id === WORK_CAL);
      if (work && work.kind === 'work' && work.crewSees === undefined) {
        work.crewSees = true; work.lookOnly = true;
        const patch = { crewSees: true, lookOnly: true, updatedAt: nowIso() };
        if (work.about === 'Your own work: quote appointments, pickups, emails to send') work.about = patch.about = ws.about;
        write('calendars', WORK_CAL, patch, 'sharing My work with the crew to look at');
      }
      // Calendars made before admins existed have no ownerOnly at all. Each
      // is marked once, not private. Until then an admin given Calendars
      // would see none of them, since they are fetched by asking for
      // ownerOnly == false.
      Object.values(cals).forEach(c => {
        if (typeof c.ownerOnly === 'boolean') return;
        c.ownerOnly = false;
        write('calendars', c.id, { ownerOnly: false }, 'marking private or not');
      });
    }
    if (meta && !meta.fromCache) { shareCrewCals(); foldCalendars(); moveJobDays(); }
    redrawIfVisible();
    announce();
  }

  // Jonah (16 Oct 2026): job days on a calendar of their own. Once, on the
  // owner's device, as soon as the calendars have come from the server: an
  // entry on the Crew schedule or My work picked as a "Job day" (type
  // 'jobday' -- the only way one was ever marked) moves to the Job
  // schedule: copied there under the same id with `movedFrom` (where it
  // was), read back from the server, and only then removed where it was --
  // so no signal, or a second device at the same moment, loses nothing, and
  // a second run finds nothing left to move. Entries never given a kind
  // stay where they are: they go by their titles now. Marked done on the
  // Job schedule itself (jobDaysMovedAt, with how many).
  let movingJobDays = false, jobDaysMoved = false;
  async function moveJobDays() {
    if (jobDaysMoved || movingJobDays || !isOwner() || !window.YDDb) return;
    movingJobDays = true;
    try {
      const jobsCal = await window.YDDb.getFresh('calendars', JOBS_CAL);
      if (!jobsCal) return;                                 // not on the server yet: next time
      if (jobsCal.jobDaysMovedAt) { jobDaysMoved = true; return; }
      let n = 0;
      for (const from of [CREW_CAL, WORK_CAL]) {
        const path = 'calendars/' + from + '/events';
        const list = window.YDDb.listWhere ? await window.YDDb.listWhere(path, 'type', '==', 'jobday') : await window.YDDb.list(path);
        for (const [id, e] of Object.entries(list || {})) {
          if (!e || e.type !== 'jobday') continue;
          const rec = Object.assign({}, e, { movedFrom: from, updatedAt: nowIso() });
          delete rec.id;
          await window.YDDb.put('calendars/' + JOBS_CAL + '/events', id, rec);
          const back = await window.YDDb.getFresh('calendars/' + JOBS_CAL + '/events', id);
          if (back && back.movedFrom === from) { await window.YDDb.remove(path, id); n++; }
        }
      }
      await window.YDDb.put('calendars', JOBS_CAL, { jobDaysMovedAt: nowIso(), jobDaysMoved: n });
      jobDaysMoved = true;
      if (n) showToast(n === 1 ? 'One job day moved to the Job schedule' : n + ' job days moved to the Job schedule');
    } catch (e) {
      console.warn('[calendar] moving the job days stopped — tried again next time:', e && (e.code || e.message));
    } finally {
      movingJobDays = false;
    }
  }

  // The job's colour on each day of it on the Job schedule (`jobColor`),
  // for the crew's phones, which cannot read jobs (jobColorOf): put right
  // by the owner's device whenever the entries or the jobs come in, so a
  // job's card given another colour on the Jobs board is that colour on
  // every phone. Written without updatedAt: it is not news for the owner's
  // phone (functions/reminders.py _activity).
  const jobColorAsked = new Set();
  function fillJobColors() {
    if (!isOwner() || !window.YDDb || !events[JOBS_CAL]) return;
    Object.values(events[JOBS_CAL]).forEach(ev => {
      const j = ev && ev.jobId ? jobById(ev.jobId) : null;
      if (!j) return;                                       // a job this device does not have: left as it is
      const want = isHex(j.cardColor) ? j.cardColor : null;
      const key = ev.id + '|' + want;
      if ((ev.jobColor || null) === want || jobColorAsked.has(key)) return;
      jobColorAsked.add(key);
      Promise.resolve(window.YDDb.put('calendars/' + JOBS_CAL + '/events', ev.id, { jobColor: want }))
        .catch(e => console.warn('[calendar] a job day’s colour not yet on the server:', (e && e.code) || e));
    });
  }

  // The Crew schedule -- and any calendar ticked "Every crew member sees it"
  // (`crewSees`: My work, 16 Oct 2026) -- is shared with exactly the people
  // ticked as crew on Your Crew (remind.js isCrewMember), and whoever may
  // change it: put right by the owner's device whenever either list comes in
  // from the server, so ticking someone shares it with them and unticking
  // (or switching them off) takes it away.
  const CREW_CAL = 'crewtasks';
  function crewMemberUids() {
    return Object.keys(people).filter(uid => people[uid].active && YDRemind.isCrewMember(people[uid])).sort();
  }
  const sharedWithCrew = c => !!c && c.kind !== 'personal' && (c.kind === 'crew' || c.crewSees === true);
  function shareCrewCals() {
    if (!isOwner() || !peopleLoaded) return;
    storedCals().filter(sharedWithCrew).forEach(c => {
      const want = Array.from(new Set(crewMemberUids().concat(c.editors || []))).sort();
      if (same(want, (c.visibleTo || []).slice().sort())) return;
      c.visibleTo = want;
      write('calendars', c.id, { visibleTo: want, updatedAt: nowIso() }, 'sharing ' + (c.name || 'a calendar') + ' with the crew');
    });
  }
  // Jonah (15 Oct 2026): three calendars, not five. Done once, by the
  // owner's device, as soon as the calendars and the people have come from
  // the server: the Work schedule becomes My work, Crew tasks the Crew
  // schedule, Personal visible to admins (seeOnly -- they never change it);
  // Site visits' entries move onto My work as quote appointments and
  // Follow-ups' onto My work; anything on My work with a crew member on it
  // moves to the Crew schedule ("anything i assign crew members to"), and
  // anything marked personal to Personal. An entry is copied, read back from
  // the server, and only then removed where it was -- so no signal, or a
  // second device doing the same at the same moment, loses nothing (the
  // copy keeps its id). The emptied calendars are marked mergedInto and
  // never shown; nothing is deleted.
  let folding = false, folded = false;
  async function foldCalendars() {
    if (folded || folding || !isOwner() || !peopleLoaded || !window.YDDb) return;
    folding = true;
    const raw = {};
    for (const id of ['schedule', 'crewtasks', 'personal', 'visits', 'followups']) {
      try { raw[id] = await window.YDDb.getFresh('calendars', id); } catch (e) { folding = false; return; }   // no signal: next time
    }
    const work = raw.schedule, crew = raw.crewtasks;
    const toFold = ['visits', 'followups'].filter(id => raw[id] && !raw[id].mergedInto);
    if (!work || !crew) { folding = false; return; }           // still being seeded
    if (work.kind === 'work' && !toFold.length && crew.name !== 'Crew tasks' && (!raw.personal || raw.personal.seeOnly === true)) {
      folded = true; folding = false; return;                   // done already: not asked again this visit
    }
    try {
      const crewOn = e => (e.crew || []).some(c => c && people[c.uid] && YDRemind.isCrewMember(people[c.uid]));
      const move = async (from, id, e, to, type) => {
        const rec = Object.assign({}, e, { type: type || null, updatedAt: nowIso() });
        delete rec.id;
        if (to === from) { if ((e.type || null) !== (type || null)) await window.YDDb.put('calendars/' + from + '/events', id, { type: type || null, updatedAt: rec.updatedAt }); return; }
        await window.YDDb.put('calendars/' + to + '/events', id, rec);
        const back = await window.YDDb.getFresh('calendars/' + to + '/events', id);
        if (back && back.title === e.title) await window.YDDb.remove('calendars/' + from + '/events', id);
      };
      const sources = (work.kind === 'work' ? [] : ['schedule']).concat(toFold);
      for (const from of sources) {
        const list = await window.YDDb.list('calendars/' + from + '/events');
        for (const [id, e] of Object.entries(list)) {
          let type = e.type || (from === 'visits' ? 'bid' : null), to = 'schedule';
          if (type === 'personal' || type === 'doctor') { to = 'personal'; if (type === 'personal') type = null; }
          else if (crewOn(e)) to = 'crewtasks';
          await move(from, id, e, to, type);
        }
        if (from !== 'schedule') await window.YDDb.put('calendars', from, { mergedInto: 'schedule', updatedAt: nowIso() });
      }
      const seed = id => SEED.find(x => x.id === id);
      if (work.kind !== 'work') {
        const s = seed('schedule');
        await window.YDDb.put('calendars', 'schedule', { name: s.name, kind: s.kind, color: s.color, order: s.order, about: s.about, updatedAt: nowIso() });
      }
      if (crew.name === 'Crew tasks') {
        const s = seed('crewtasks');
        await window.YDDb.put('calendars', 'crewtasks', { name: s.name, order: s.order, about: s.about, updatedAt: nowIso() });
      }
      if (raw.personal && raw.personal.seeOnly !== true) {
        const s = seed('personal');
        await window.YDDb.put('calendars', 'personal', { ownerOnly: false, seeOnly: true, editors: [], visibleTo: [], order: s.order, about: s.about, updatedAt: nowIso() });
      }
      folded = true;
      showToast('Calendars folded into three: My work, the Crew schedule and Personal');
    } catch (e) {
      console.warn('[calendar] folding the calendars stopped — tried again next time:', e && (e.code || e.message));
    } finally {
      folding = false;
    }
  }

  // Jonah (12 Oct 2026): "click a button on a card on the boards or calendars
  // that marks it as a crew task so every profile marked as a crew member
  // can view it." It moves to the Crew schedule (every date of a repeat),
  // which every crew member sees and ticks off -- and, since each calendar
  // has its own tags (16 Oct 2026), takes the tag its title gives it there
  // (a pickup, a repair... else a crew task). Before, an entry on a
  // calendar the crew could all see stayed put as a crew task -- on My
  // work, which they only look at, nobody could have ticked it.
  window.calCrewTask = function () {
    const o = shown;
    const cal = o && cals[o.calId], base = cal && (events[o.calId] || {})[o.id];
    if (!base || !editsCal(cal) || cal.kind === 'crew' || cal.kind === 'jobs') return;
    if (!cals[CREW_CAL] || !editsCal(cals[CREW_CAL])) { showToast('The Crew schedule is still being set up — try again in a moment'); return; }
    const next = Object.assign({}, o.ev || base, { type: null });
    applyChange(o.calId, base, o.ev ? o : Object.assign({}, o, { ev: base }), next, 'all', CREW_CAL);
    closeCalModal(); render();
    showToast('Moved to the ' + cals[CREW_CAL].name + ' — every crew member can see it');
  };

  // Every calendar's entries, every board's cards, storms and people each
  // ask for a redraw -- at start-up dozens in a second, each running the
  // whole calendar again. The asks in one moment share a single draw at the
  // next frame (a hidden tab gets none until it is looked at; switchTab
  // draws on arrival anyway).
  function redrawIfVisible() {
    if (drawFrame) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      const p = el('panel-calendar');
      if (!p || !p.classList.contains('active')) return;
      // Do not redraw under someone filling in the editor.
      const m = el('calModal');
      if (m && m.classList.contains('active') && (el('evTitle') || el('ccName'))) return;
      render();
    });
  }

  function stop() {
    [unsubCals, unsubStorms, unsubPeople].forEach(u => { if (u) u(); });
    unsubCals = unsubStorms = unsubPeople = null;
    Object.values(eventUnsubs).forEach(u => u());
    eventUnsubs = {}; cals = {}; events = {}; storms = {}; people = {}; seeded = false; peopleLoaded = false;
    calsHeard = false;
    // Whether this phone gets reminders is asked again for whoever signs in
    // next: the answer is per person as well as per phone.
    pushState = '';
    announce();
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
      unsubPeople = window.YDDb.watch('users', (changes, meta) => {
        changes.forEach(c => { if (c.type === 'removed') delete people[c.id]; else people[c.id] = c.data; });
        if (meta && !meta.fromCache) { peopleLoaded = true; shareCrewCals(); foldCalendars(); }
        redrawIfVisible();
        announce();
      }, () => {});
    }
    // Crew can read storms, so both see storm nights.
    unsubStorms = window.YDDb.watch('storms', changes => {
      changes.forEach(c => { if (c.type === 'removed') delete storms[c.id]; else storms[c.id] = Object.assign({ id: c.id }, c.data); });
      redrawIfVisible();
      announce();
    }, () => {});
  }

  // ------------------------------------------------------------------ Home
  //
  // Home (home.js) shows the day the way My day splits it, drawn its own
  // way: this person's things at set times and for any time, the crew's
  // that are not theirs, and cards gone past their due date. Each comes
  // with what Home writes beside it, and the occurrence itself (`o`), which
  // Home hands back to open it or tick it off -- so a tap there does exactly
  // what the same tap does here.
  // Who is on something, by uid: a card's (or a recurring task's card's)
  // assignees, an entry's crew -- the list isMine goes by.
  function onUids(o) {
    if (o.auto === 'card' || o.auto === 'recurring') {
      const card = ((YDBoards.cards() || {})[o.auto === 'card' ? o.boardId : 'crew'] || {})[o.id] || {};
      return (card.assignees || []).map(a => a && a.uid).filter(Boolean);
    }
    return (o.crew || []).map(c => c && c.uid).filter(Boolean);
  }
  function forHome(o) {
    // A day on the Job schedule is the crew's, but no task: it goes with
    // the schedule (homeDay), not in the lists of things anyone can do.
    const crewTask = isCrewOcc(o) && !o.jobDay;
    return {
      o: o, title: o.title, day: o.day, done: !!o.done, color: colorOf(o), canTick: canTick(o), task: !!o.task,
      time: o.time ? fmtTimeRange(o.time, o.endTime || '') : o.jobDay ? 'All day' : '',
      sub: [o.address, o.note, o.auto ? '' : o.layer.name].filter(Boolean).join(' · '),
      who: whoOn(o),
      // A crew task, and whether nobody is on it yet (anyone may do it).
      crewTask: crewTask, open: crewTask && !onUids(o).length,
    };
  }
  function homeDay(day) {
    const w = YDRemind.who(people);
    if (!w) return null;
    // A job's day with no set time goes with the schedule, not the things
    // to get done (Home's "To do today" counts those).
    const atTime = o => !!o.time || !!o.jobDay;
    const timed = list => list.filter(atTime).sort((a, b) => String(to24(a.time || '')).localeCompare(String(to24(b.time || ''))));
    const untimed = list => list.filter(o => !atTime(o)).sort(byKind);
    const all = occurrences(day, day, true);
    const mine = all.filter(o => occIsMine(o, w));
    const crew = all.filter(o => !occIsMine(o, w) && isCrewOcc(o));
    // What was not ticked off on the days before: the same list My day, the
    // 7 am list and the evening summary carry (carried -- tasks only, from
    // TICK_FROM, a fortnight back at most, and kept ticked for the day once
    // done), so Home never says something different from them.
    const late = day === today() ? carried(true) : [];
    const crewOnly = o => !occIsMine(o, w) && isCrewOcc(o);
    return {
      // The day's counts, by the one rule (tally): this person's, and the
      // crew's that are not theirs (Home's crew card) -- in words by
      // YDCalendar.countWords, so Home says what My day and the calendar say.
      count: tally(all, late, o => occIsMine(o, w), day), crewCount: tally(all, late, crewOnly, day),
      mineTimed: timed(mine).map(forHome), mineAny: untimed(mine).map(forHome),
      crewTimed: timed(crew).map(forHome), crewAny: untimed(crew).map(forHome),
      mineLate: late.filter(o => occIsMine(o, w)).map(forHome),
      crewLate: late.filter(crewOnly).map(forHome),
    };
  }

  window.YDCalendar = {
    // Called as the calendar is opened (app.js switchTab): a fresh look, so
    // the "any time" list above it opens or folds by the day again
    // (foldedNow), whatever was tapped on the last visit.
    render: () => { topFold = null; render(); },
    redraw: () => redrawIfVisible(),
    // A job's days on the calendars this person can see, from today on
    // (crewjobs.js: who is working which day) -- every calendar, whatever is
    // ticked in the side.
    forJob: (jobId, days) => {
      const from = today();
      return occurrences(from, addDays(from, days || 45), true)
        .filter(o => o.ev && o.ev.jobId === jobId)
        // `when`: the times as the rest of the app writes them ("7:30am–3pm").
        .map(o => ({ day: o.day, time: o.time || '', endTime: o.endTime || '', title: o.name || o.title,
                     when: o.time ? fmtTimeRange(o.time, o.endTime || '') : '',
                     crew: (o.crew || []).map(c => {
                       const p = people[c.uid];
                       return (p && (p.name || p.email)) || c.name || '';
                     }).filter(Boolean),
                     // Nobody put on the entry at all -- anyone can do it --
                     // as against people on it whose names are not known here.
                     nobody: !(o.crew || []).length,
                     // A day on the Job schedule (who is working there), as
                     // against a pickup or a to-do tied to the job.
                     jobDay: !!o.jobDay }));
    },
    // Home (see homeDay above). `ready`: the calendars have answered once.
    ready: () => calsHeard,
    adds: () => adds(),
    day: homeDay,
    // A day's count (homeDay's count / crewCount) in the words every screen
    // uses: "3 to do today · 2 from earlier".
    countWords: countWords,
    // Every entry this person can see between two dates, drawn as Home draws
    // them (search.js: one call instead of a day at a time, and entries put
    // on someone else are found too).
    between: (from, to) => occurrences(from, to, true).map(forHome),
    // The "turn on notifications" note My day shows ('' once this phone
    // gets reminders) -- Home puts it at the top of its day too.
    nudge: () => nudgeHtml(),
    open: o => clickOcc(o),
    tick: (o, on) => tickOcc(o, on),
    // The next day each job is on a calendar, from today on: job id ->
    // { day, time } (Home's list of jobs on the go). One pass for them all.
    nextForJobs: days => {
      const from = today(), out = {}, any = {};
      // A day on the Job schedule is a day on the job; a pickup or a to-do
      // tied to it counts only for a job with no such day ahead.
      occurrences(from, addDays(from, days || 60), true).forEach(o => {
        const id = o.ev && o.ev.jobId;
        const into = o.jobDay ? out : any;
        if (id && !into[id]) into[id] = { day: o.day, time: o.time ? fmtTimeRange(o.time) : '' };
      });
      Object.keys(any).forEach(id => { if (!out[id]) out[id] = any[id]; });
      return out;
    },
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const tab = el('tabCalendar');
    if (tab) tab.hidden = !on;
    if (on) start(a); else stop();
    render();
  });
  // The jobs: only for the colour of each job's days on the Job schedule
  // (jobColorOf) -- an entry keeps its job's name, and the editor's job
  // list is built as it opens.
  document.addEventListener('yd-jobs-changed', () => {
    if (!Object.keys(events[JOBS_CAL] || {}).length) return;
    fillJobColors();
    redrawIfVisible();
  });
  document.addEventListener('yd-cards-changed', redrawIfVisible);
  document.addEventListener('yd-boards-changed', redrawIfVisible);
  // The outreach date set or moved, or who is due changed (prospects.js).
  document.addEventListener('yd-outreach', redrawIfVisible);
  // This person's own record has come in (remind.js): whether they are crew,
  // and so what My day holds, follows it.
  document.addEventListener('yd-remind-me', redrawIfVisible);

  function boot() { wire(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
