// Recurring crew tasks, signed off by the office.
//
// Jonah (5 Oct 2026): "monthly & weekly recurring crew tasks ... taking the
// truck through a car wash twice a month, checking truck & trailer tire
// pressures once per week. And these need to be checked off by an Admin or i
// want to get notifications if they havent been done." His answers (6 Oct):
// crew do them, an admin (or Jonah) confirms; he is told the morning after
// one is due; car wash and tire pressures all year. And (7 Oct): "the
// recurring tasks that the crew does should be in the crew tasks thing as
// recurring tasks. And weekly ones should show up on friday on the calendar
// every week for the crew."
//
// THE LIST lives on the Crew tasks board itself: boards/crew.recurring
// {id: {what, every, days, from, season, machineId, off}}. Everyone the board
// is shared with reads it -- the calendar draws every date from it, weeks
// ahead, for the crew too -- and only whoever may change boards edits it.
//   every: 'week' (due Friday) | 'twice' (due the 15th and the month's last
//   day) | 'month' (due the last day) | 'days' (every N days from `from`).
//   season: 'all' | 'season' (1 Apr - 31 Oct only).
// Until 7 Oct it lived in settings/recurring (the owner's alone) with its cards
// on the Maintenance board; the owner's device moves it over once.
//
// THE CARDS go on Crew tasks, one per task per period: id rc-<task>-<due day>,
// made by the owner's device when the period starts (fixed ids, so two
// devices make the same card). The crew move it to Done; it only counts once
// the owner or an admin confirms it (confirmedAt -- a field the board rules
// do not let crew write). One about a machine is logged in that machine's
// service history when confirmed, with the miles. The morning summary lists
// any left unconfirmed past their due day (digest.py), which is the
// notification Jonah asked for.
//
// Crew tasks is shared with every active crew member and admin, by the
// owner's device, the way the Maintenance board is.

(function () {
  'use strict';

  const CREW = 'crew';
  const MAINT = 'maintenance';           // where the cards used to go
  const LABEL = { id: 'recurring', name: 'Recurring', color: '#2a9d8f' };
  const EVERY = [['week', 'Every week (due Friday)'], ['twice', 'Twice a month (15th and month end)'],
                 ['month', 'Every month (month end)'], ['days', 'Every so many days']];
  // What Jonah asked for, one press away on the list screen.
  const ASKED_FOR = [
    { what: 'Truck through the car wash', every: 'twice', season: 'all' },
    { what: 'Check truck tire pressures', every: 'week', season: 'all' },
    { what: 'Check trailer tire pressures', every: 'week', season: 'all' },
  ];

  let migrating = false;
  const el = id => document.getElementById(id);
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  // Confirming is for whoever runs the boards: the owner, or an admin.
  const confirms = () => typeof ydCan === 'function' && ydCan('boards', 'change');
  const two = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  const newId = () => 'rt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const crewBoard = () => (window.YDBoards && YDBoards.boards ? YDBoards.boards()[CREW] : null) || null;
  // The task list, as the board has it (a key written null is a removed task).
  function tasksNow() {
    const b = crewBoard(), t = (b && b.recurring) || {}, out = {};
    Object.keys(t).forEach(id => { if (t[id]) out[id] = t[id]; });
    return out;
  }
  const doneCol = b => (YDBoards.doneCol ? YDBoards.doneCol(b) : b.columns[b.columns.length - 1].id);
  function put(path, id, data, what) {
    Promise.resolve(window.YDDb.put(path, id, data))
      .catch(e => console.warn('[recurring] ' + what + ' not yet on the server:', (e && e.code) || e));
  }

  // ---------------------------------------------------------------- periods

  // The period a day falls in: {start, due} as local YYYY-MM-DD, or null when
  // the task does not run then (out of season).
  function periodOf(t, day) {
    const d = new Date(day + 'T00:00:00');
    if (t.season === 'season' && (d.getMonth() < 3 || d.getMonth() > 9)) return null;
    if (t.every === 'week') {
      const start = new Date(d); start.setDate(d.getDate() - ((d.getDay() + 6) % 7));     // Monday
      const due = new Date(start); due.setDate(start.getDate() + 4);                      // Friday
      return { start: ymd(start), due: ymd(due) };
    }
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    if (t.every === 'twice') {
      return d.getDate() <= 15
        ? { start: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), due: ymd(new Date(d.getFullYear(), d.getMonth(), 15)) }
        : { start: ymd(new Date(d.getFullYear(), d.getMonth(), 16)), due: ymd(last) };
    }
    if (t.every === 'month') return { start: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), due: ymd(last) };
    if (t.every === 'days') {
      const n = Math.max(1, parseInt(t.days, 10) || 7);
      const from = new Date((t.from || day) + 'T00:00:00');
      if (d < from) return null;
      const k = Math.floor(Math.round((d - from) / 864e5) / n);
      const start = new Date(from); start.setDate(from.getDate() + k * n);
      const due = new Date(start); due.setDate(start.getDate() + n - 1);
      return { start: ymd(start), due: ymd(due) };
    }
    return null;
  }
  function everyText(t) {
    if (t.every === 'days') return 'every ' + (parseInt(t.days, 10) || 7) + ' days';
    return ({ week: 'every week, due Friday', twice: 'twice a month', month: 'every month' })[t.every] || '';
  }

  // ------------------------------------------------------------- the move

  // Once, on the owner's device: the list from settings/recurring onto the
  // board (an empty list too, so it is not asked again), then the old cards
  // still open on Maintenance come off -- this period's go on Crew tasks.
  // Ones already moved to Done or confirmed stay there as the record.
  function migrate() {
    if (migrating) return;
    migrating = true;
    Promise.resolve(window.YDDb.getFresh('settings', 'recurring')).then(old => {
      const t = (old && old.tasks) || {}, list = {};
      Object.keys(t).forEach(id => { if (t[id]) list[id] = t[id]; });
      const b = crewBoard();
      if (!b || b.recurring) return;
      b.recurring = list;
      return window.YDDb.put('boards', CREW, { recurring: list }).then(() => sync());
    }).catch(e => console.warn('[recurring] not moved yet:', (e && e.code) || e))
      .then(() => { migrating = false; });
  }
  function clearOldCards() {
    if (!YDBoards.cardsReady || !YDBoards.cardsReady(MAINT)) return;
    const old = YDBoards.cards()[MAINT] || {};
    Object.keys(old).forEach(cid => {
      const k = old[cid];
      if (!k || !k.recurring || k.doneAt || k.confirmedAt) return;
      delete old[cid];
      Promise.resolve(window.YDDb.remove('boards/' + MAINT + '/cards', cid)).catch(() => {});
    });
  }

  // Crew tasks is the crew's: shared with every active crew member and admin,
  // a newcomer added the next time this runs. Nobody is taken off.
  function share(b) {
    const ppl = YDBoards.people ? YDBoards.people() : {};
    if (!Object.keys(ppl).length) return;
    const crew = Object.keys(ppl).filter(uid => ppl[uid].active && ['crew', 'admin'].indexOf(ppl[uid].role) !== -1);
    const vis = Array.isArray(b.visibleTo) ? b.visibleTo : [];
    const add = crew.filter(uid => vis.indexOf(uid) === -1);
    if (!add.length) return;
    b.visibleTo = vis.concat(add);
    put('boards', CREW, { visibleTo: b.visibleTo }, 'sharing Crew tasks');
  }

  // ---------------------------------------------------------------- the cards

  // The owner's device makes this period's card for each task. Only once the
  // boards and the card list have come from the server (a card "missing"
  // from an empty cache is not missing).
  function sync() {
    if (!owner() || !window.YDDb || !window.YDBoards || !YDBoards.ready()) return;
    const board = crewBoard();
    if (!board || !(board.columns || []).length) return;
    share(board);
    if (!board.recurring) { migrate(); return; }
    clearOldCards();
    if (!YDBoards.cardsReady || !YDBoards.cardsReady(CREW)) return;
    const tasks = tasksNow();
    const have = YDBoards.cards()[CREW] || {};
    const first = board.columns[0].id;
    if (!(board.labels || []).some(l => l.id === LABEL.id)) {
      board.labels = (board.labels || []).concat([LABEL]);
      put('boards', CREW, { labels: board.labels }, 'the Recurring label');
    }
    const today = ymd(new Date());
    const gear = window.YDEquipment ? YDEquipment.all() : {};
    const notes = (t, machine) => 'Recurring — ' + everyText(t) + (machine ? ' · ' + machine : '') + '.\n\n' +
      'Move it to Done when it is done; Jonah or an admin confirms it.';
    let order = Object.values(have).reduce((m, k) => Math.max(m, k.order || 0), 0);
    Object.keys(tasks).forEach(id => {
      const t = tasks[id];
      if (t.off || !t.what) return;
      const p = periodOf(t, today);
      if (!p) return;
      const cid = 'rc-' + id + '-' + p.due;
      const machine = t.machineId && gear[t.machineId] ? gear[t.machineId].name : '';
      if (have[cid]) {
        // The task changed since its card was made (renamed, or a truck put
        // on it): this period's card follows, until it is confirmed.
        const k = have[cid];
        if (!k.confirmedAt && (k.title !== t.what || (k.machineId || null) !== (t.machineId || null))) {
          const fix = { title: t.what, machineId: t.machineId || null, notes: notes(t, machine) };
          Object.assign(k, fix);
          put('boards/' + CREW + '/cards', cid, fix, 'a recurring card');
        }
        return;
      }
      const card = {
        title: t.what, due: p.due, column: first, order: (order += 1000), notes: notes(t, machine),
        labels: [LABEL.id], recurring: id, machineId: t.machineId || null, confirmedAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: 'Recurring',
      };
      have[cid] = Object.assign({ id: cid }, card);
      put('boards/' + CREW + '/cards', cid, card, 'a recurring card');
    });
    // A task removed or switched off takes its open card with it -- left, it
    // sat on the board and in every morning summary as "not done". One
    // already moved to Done (waiting for an OK) or confirmed stays.
    Object.keys(have).forEach(cid => {
      const k = have[cid];
      if (!k || !k.recurring || k.confirmedAt || k.doneAt) return;
      const t = tasks[k.recurring];
      if (t && !t.off && t.what) return;
      delete have[cid];
      Promise.resolve(window.YDDb.remove('boards/' + CREW + '/cards', cid)).catch(() => {});
    });
  }

  // Confirmed done by the owner or an admin. A task about a machine goes in
  // its service history (not as a service -- it does not move the next one).
  // The card may still be on Maintenance (one done before the move).
  window.confirmRecurring = function (cardId, boardId) {
    if (!confirms() || !window.YDBoards) return;
    const all = YDBoards.cards();
    const where = boardId || ((all[CREW] || {})[cardId] ? CREW : MAINT);
    const board = YDBoards.boards()[where];
    const k = (all[where] || {})[cardId];
    if (!board || !k || !k.recurring) return;
    const me = (window.YDAuth && window.YDAuth.user) || {};
    let miles = null;
    const g = k.machineId && window.YDEquipment ? YDEquipment.all()[k.machineId] : null;
    // Anything serviced by the mile (a vehicle, or one of Jonah's own types
    // with miles on it -- equipment.js countsMiles).
    if (g && (YDEquipment.countsMiles ? YDEquipment.countsMiles(g) : g.kind === 'vehicle')) {
      const a = prompt('Miles on ' + (g.name || 'it') + ' now? (blank if you don’t know)', g.miles != null ? String(g.miles) : '');
      if (a === null) return;
      const n = parseInt(String(a).replace(/[^0-9]/g, ''), 10);
      miles = n > 0 ? n : null;
    }
    const at = new Date().toISOString();
    const patch = { confirmedAt: at, confirmedBy: me.uid || '', column: doneCol(board), doneAt: k.doneAt || at,
                    updatedAt: at, updatedBy: 'Confirmed' };
    Object.assign(k, patch);
    Promise.resolve(window.YDDb.put('boards/' + where + '/cards', cardId, patch))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not saved — not allowed' : 'Not on the server yet'));
    if (g && window.YDEquipment && YDEquipment.logTask) YDEquipment.logTask(g.id, k.title, miles, me.displayName || me.email || '');
    if (window.YDBoards.render) YDBoards.render();
    showToast('Confirmed — ' + k.title);
  };

  // What a card on the board says about itself (boards.js).
  window.recurringBadge = function (k, inLast) {
    if (!k || !k.recurring) return '';
    if (k.confirmedAt) return '<span class="bd-rc ok" title="Confirmed">✔</span>';
    if (inLast) return '<span class="bd-rc ask" title="Done — waiting to be confirmed">✔ OK?</span>';
    return '<span class="bd-rc" title="Recurring">🔁</span>';
  };
  window.recurringDetail = function (k, inLast) {
    if (!k || !k.recurring) return '';
    if (k.confirmedAt) return '<div class="hint">✔ Confirmed ' + new Date(k.confirmedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '.</div>';
    return '<div class="bd-rc-box">' + (inLast ? 'Marked done — ' : 'Recurring task. ') +
      (confirms() ? '<button class="btn btn-sm btn-filled" onclick="confirmRecurring(\'' + String(k.id).replace(/[^A-Za-z0-9_-]/g, '') + '\')">✔ Confirm it was done</button>'
        : 'Jonah or an admin confirms it once it is in Done.') + '</div>';
  };

  // ---------------------------------------------------------------- the list

  window.openRecurring = function () {
    if (!owner()) return;
    const m = el('recurModal');
    if (m) m.classList.add('active');
    renderList();
  };
  window.closeRecurring = function () { const m = el('recurModal'); if (m) m.classList.remove('active'); };

  function machineOptions(sel) {
    const gear = window.YDEquipment ? YDEquipment.all() : {};
    return '<option value="">— none —</option>' + Object.values(gear).sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(g => '<option value="' + esc(g.id) + '"' + (g.id === sel ? ' selected' : '') + '>' + esc(g.name || 'Machine') + '</option>').join('');
  }
  function renderList() {
    const body = el('recurBody');
    if (!body) return;
    const b = crewBoard();
    if (!b || !b.recurring) { body.innerHTML = '<p class="empty-msg">Loading…</p>'; return; }
    const tasks = tasksNow();
    const ids = Object.keys(tasks).sort((x, y) => String(tasks[x].what).localeCompare(String(tasks[y].what)));
    const today = ymd(new Date());
    body.innerHTML =
      '<p class="hint">Each one goes on the Crew tasks board when it comes round, and shows on the crew’s calendar on its ' +
        'day — weekly ones every Friday. The crew move it to Done; it counts once you (or an admin) confirm it. ' +
        'Anything not confirmed by its day is in your morning summary.</p>' +
      (ids.length ? ids.map(id => {
        const t = tasks[id];
        const p = periodOf(t, today);
        const sid = id.replace(/[^A-Za-z0-9_-]/g, '');
        return '<div class="rc-task' + (t.off ? ' off' : '') + '">' +
          '<input value="' + esc(t.what || '') + '" onchange="rcSet(\'' + sid + '\', \'what\', this.value)">' +
          '<select onchange="rcSet(\'' + sid + '\', \'every\', this.value)">' + EVERY.map(([k, n]) =>
            '<option value="' + k + '"' + (t.every === k ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>' +
          (t.every === 'days' ? '<label>days <input class="rc-days" inputmode="numeric" value="' + esc(t.days || 7) + '" onchange="rcSet(\'' + sid + '\', \'days\', this.value)"></label>' : '') +
          '<select onchange="rcSet(\'' + sid + '\', \'season\', this.value)">' +
            '<option value="all"' + (t.season !== 'season' ? ' selected' : '') + '>All year</option>' +
            '<option value="season"' + (t.season === 'season' ? ' selected' : '') + '>Apr–Oct only</option></select>' +
          '<select title="Machine (optional)" onchange="rcSet(\'' + sid + '\', \'machineId\', this.value)">' + machineOptions(t.machineId) + '</select>' +
          '<label class="chk"><input type="checkbox"' + (t.off ? '' : ' checked') + ' onchange="rcSet(\'' + sid + '\', \'off\', !this.checked)"> On</label>' +
          '<button class="remove-btn" onclick="rcRemove(\'' + sid + '\')" title="Remove">&times;</button>' +
          '<div class="muted rc-next">' + (t.off ? 'Off' : p ? 'This one due ' + new Date(p.due + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Not in season now') + '</div>' +
        '</div>';
      }).join('') : '<p class="empty-msg">No recurring tasks yet.</p>') +
      '<div class="field-actions">' +
        '<button class="btn btn-sm btn-filled" onclick="rcAdd()">+ Add a task</button>' +
        (ids.length ? '' : '<button class="btn btn-sm" onclick="rcAddAsked()">Add the three you asked for (car wash, truck & trailer tires)</button>') +
        '<button class="btn btn-sm" onclick="closeRecurring()">Close</button>' +
      '</div>';
  }

  // Saved onto the board; the screen and the cards follow at once.
  function save(patch) {
    const b = crewBoard();
    if (!b) return;
    b.recurring = Object.assign({}, b.recurring || {}, patch);
    Promise.resolve(window.YDDb.put('boards', CREW, { recurring: patch }))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Only the owner sets these' : 'Not on the server yet'));
  }
  window.rcSet = function (id, field, v) {
    const tasks = tasksNow();
    if (!owner() || !tasks[id]) return;
    const val = field === 'off' ? !!v : field === 'days' ? Math.max(1, parseInt(v, 10) || 7) : field === 'machineId' ? (v || null) : String(v || '').trim();
    if (field === 'what' && !val) { showToast('Say what the task is'); renderList(); return; }
    const t = Object.assign({}, tasks[id], { [field]: val });
    if (field === 'every' && val === 'days' && !t.from) t.from = ymd(new Date());
    save({ [id]: t });
    renderList(); sync(); redrawCalendar();
  };
  window.rcAdd = function () {
    if (!owner()) return;
    const what = prompt('What needs doing? (e.g. Grease the loader)');
    if (!what || !what.trim()) return;
    save({ [newId()]: { what: what.trim(), every: 'week', season: 'all', days: 7, from: ymd(new Date()), machineId: null, off: false } });
    renderList(); sync(); redrawCalendar();
  };
  window.rcAddAsked = function () {
    if (!owner()) return;
    const patch = {};
    ASKED_FOR.forEach((t, i) => { patch[newId() + i] = Object.assign({ days: 7, from: ymd(new Date()), machineId: null, off: false }, t); });
    save(patch);
    renderList(); sync(); redrawCalendar();
    showToast('Added — pick the truck and trailer for each, if you like');
  };
  window.rcRemove = function (id) {
    const tasks = tasksNow();
    if (!owner() || !tasks[id] || !confirm('Remove “' + tasks[id].what + '”? Cards already done stay on the board.')) return;
    save({ [id]: null });      // merged saves keep a key left out
    renderList(); sync(); redrawCalendar();
  };
  function redrawCalendar() { if (window.YDCalendar && YDCalendar.redraw) YDCalendar.redraw(); }

  // ------------------------------------------------------ for the calendar

  // Every date a task falls due between two days (inclusive) -- weeks ahead,
  // not only this period's card -- with whether that date's card is done.
  function dues(from, to) {
    const tasks = tasksNow(), out = [], seen = {};
    const cards = (window.YDBoards && YDBoards.cards ? YDBoards.cards()[CREW] : null) || {};
    const b = crewBoard();
    const done = b ? doneCol(b) : '';
    const d = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
    let guard = 0;
    for (; d <= end && guard++ < 400; d.setDate(d.getDate() + 1)) {
      const day = ymd(d);
      Object.keys(tasks).forEach(id => {
        const t = tasks[id];
        if (t.off || !t.what) return;
        const p = periodOf(t, day);
        if (!p || p.due < from || p.due > to || seen[id + p.due]) return;
        // Not before the task existed (its first period is the one it was added in).
        const first = t.from ? periodOf(t, t.from) : null;
        if (first && p.due < first.due) return;
        seen[id + p.due] = 1;
        const cid = 'rc-' + id + '-' + p.due, k = cards[cid];
        out.push({ day: p.due, taskId: id, what: t.what, cardId: k ? cid : '',
                   done: !!(k && (k.confirmedAt || k.doneAt || k.column === done)) });
      });
    }
    return out;
  }
  window.YDRecurring = {
    dues: dues,
    // Whether this person can see the list (the Crew tasks board is theirs).
    visible: () => !!(crewBoard() && crewBoard().recurring),
  };

  // ---------------------------------------------------------------- start

  function relist() { const m = el('recurModal'); if (m && m.classList.contains('active')) renderList(); }
  document.addEventListener('yd-boards-ready', sync);
  document.addEventListener('yd-boards-changed', () => { sync(); relist(); });
  document.addEventListener('yd-cards-changed', sync);
  // A new period starts at midnight: looked at again when the app comes back.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  document.addEventListener('yd-auth', () => { migrating = false; });
})();
