// Tax & filing dates. Jonah's routine 10 of 14 (wish card, 26 Oct 2026):
// "puts the recurring deadlines on his calendar with reminders 14 and 3
// days ahead: Wisconsin sales tax returns, Q4 federal estimated tax, 1099-
// NECs, the Wisconsin LLC annual report, insurance renewals ... Each
// reminder carries the number it needs (e.g. sales tax collected this
// period)."
//
// Worked out, never stored as calendar entries: the dates come from the
// rules below and his settings in settings/deadlines (owner only):
//   salesTax     'monthly' | 'quarterly' | 'annual' | ''   how often he files
//   llcReport    'MM-DD' the LLC annual report is due by ('06-30' when unset:
//                Wisconsin DFI's notice says 30 June for this one)
//   items        [{id, name, date 'YYYY-MM-DD', every 'year'|'once', note}]
//                his own dates (an insurance renewal, a licence)
//   off          {ruleId: true}  a built-in date that is not his
//   done         {key: {at, by}}  ticked off -- the reminders stop
//   numbers      {key: {cents, docs, at}}  written by the server
//                (functions/deadlines.py): the sales tax charged in the
//                period, from QuickBooks
// functions/deadlines.py holds the SAME rules (keys and dates must agree:
// the server pushes 14 days, 3 days and on the day, until ticked off).
//
// Shown: the calendar's "Tax & filing dates" layer (calendar.js), Home's
// Waiting on you within 14 days (home.js), and the window here (⚙ All
// settings, or a tap on any of them). The owner's alone.
(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.user);
  const SOON_DAYS = 14;
  // The clock began here (30 Oct 2026): a date before it is not shown as
  // late -- whether it was met was never asked (functions/deadlines.py
  // never reaches back that far either).
  const FROM = '2026-10-30';
  // A 1099-NEC is owed for $600 or more paid before 2026, $2,000 or more
  // from 2026 (the federal change of July 2025).
  const nec = y => (y >= 2026 ? '$2,000' : '$600');

  let cfg = null;            // settings/deadlines as read (null: not yet)
  let who = null;
  let adding = null;         // the "a date of your own" form, while open

  // ------------------------------------------------------------ dates

  const pad = n => String(n).padStart(2, '0');
  const ymdOf = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const lastDay = (y, m) => new Date(y, m, 0).getDate();          // m: 1-12
  const dow = s => new Date(s + 'T12:00:00').getDay();
  function addDaysTo(s, n) {
    const d = new Date(s + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return ymdOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  // The nth (1-based; -1 the last) weekday wd (0 Sunday) of a month.
  function nth(y, m, wd, n) {
    if (n < 0) {
      let d = lastDay(y, m);
      while (new Date(y, m - 1, d).getDay() !== wd) d--;
      return ymdOf(y, m, d);
    }
    let d = 1;
    while (new Date(y, m - 1, d).getDay() !== wd) d++;
    return ymdOf(y, m, d + 7 * (n - 1));
  }
  // Federal holidays (a fixed-date one on a weekend is kept on the Friday
  // or Monday). A filing due on one moves to the next working day.
  function holidays(y) {
    const fixed = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]].map(([m, d]) => {
      const s = ymdOf(y, m, d), w = dow(s);
      return w === 6 ? addDaysTo(s, -1) : w === 0 ? addDaysTo(s, 1) : s;
    });
    return new Set(fixed.concat([nth(y, 1, 1, 3), nth(y, 2, 1, 3), nth(y, 5, 1, -1), nth(y, 9, 1, 1),
      nth(y, 10, 1, 2), nth(y, 11, 4, 4)]));
  }
  // Next year's holidays too: a New Year's Day on a Saturday is kept on the
  // Friday before, 31 December (as functions/deadlines.py).
  function workday(s) {
    const y = +s.slice(0, 4), h = new Set([...holidays(y), ...holidays(y + 1)]);
    while (dow(s) === 0 || dow(s) === 6 || h.has(s)) s = addDaysTo(s, 1);
    return s;
  }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];
  const SHORT = MONTHS.map(m => m.slice(0, 3));

  // ------------------------------------------------------------ the rules

  // Every built-in date falling in year y: [{rule, key, name, due, from,
  // to, label}]. `from`/`to`: the period the filing covers.
  function builtIn(y, c) {
    const out = [];
    const st = c.salesTax;
    if (st === 'monthly') {
      for (let m = 1; m <= 12; m++) {
        const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
        out.push({ rule: 'salesTax', key: 'salesTax_' + y + '-' + pad(m), label: MONTHS[m - 1] + ' ' + y,
          from: ymdOf(y, m, 1), to: ymdOf(y, m, lastDay(y, m)), due: workday(ymdOf(ny, nm, lastDay(ny, nm))) });
      }
    } else if (st === 'quarterly') {
      for (let q = 1; q <= 4; q++) {
        const em = q * 3, ny = q === 4 ? y + 1 : y, nm = q === 4 ? 1 : em + 1;
        out.push({ rule: 'salesTax', key: 'salesTax_' + y + '-Q' + q,
          label: SHORT[em - 3] + '–' + SHORT[em - 1] + ' ' + y,
          from: ymdOf(y, em - 2, 1), to: ymdOf(y, em, lastDay(y, em)), due: workday(ymdOf(ny, nm, lastDay(ny, nm))) });
      }
    } else if (st === 'annual') {
      out.push({ rule: 'salesTax', key: 'salesTax_' + y, label: String(y), from: ymdOf(y, 1, 1), to: ymdOf(y, 12, 31),
        due: workday(ymdOf(y + 1, 1, 31)) });
    }
    out.forEach(x => { x.name = 'Wisconsin sales tax return — ' + x.label; });
    // Estimated tax: four payments for year y, the last in January.
    [[ymdOf(y, 4, 15), 'Jan–Mar'], [ymdOf(y, 6, 15), 'Apr–May'], [ymdOf(y, 9, 15), 'Jun–Aug'],
     [ymdOf(y + 1, 1, 15), 'Sep–Dec']].forEach(([d, months], i) => {
      out.push({ rule: 'estTax', key: 'estTax_' + y + '-' + (i + 1), due: workday(d), label: months + ' ' + y,
        name: 'Estimated tax ' + (i + 1) + ' of 4 for ' + y + ' — federal and Wisconsin' });
    });
    out.push({ rule: 'returns', key: 'returns_' + (y - 1), due: workday(ymdOf(y, 4, 15)), label: String(y - 1),
      name: 'Income tax returns for ' + (y - 1) + ' — federal and Wisconsin' });
    out.push({ rule: 'nec', key: 'nec_' + (y - 1), due: workday(ymdOf(y, 1, 31)), label: String(y - 1),
      name: '1099-NECs for ' + (y - 1) + ' — everyone paid ' + nec(y - 1) + '+ (to them and the IRS)' });
    const md = /^(\d{2})-(\d{2})$/.exec(c.llcReport || '') || [null, '06', '30'];
    const m = Math.min(12, Math.max(1, +md[1])), d = Math.min(lastDay(y, m), Math.max(1, +md[2]));
    out.push({ rule: 'llcReport', key: 'llcReport_' + y, due: workday(ymdOf(y, m, d)), label: String(y),
      name: 'Wisconsin LLC annual report (DFI, $25 online)' });
    return out.filter(x => !(c.off || {})[x.rule]);
  }

  // His own dates in year y: a yearly one on its month and day, a one-off
  // on its date. Not moved off weekends -- they are his dates as he gave them.
  function own(y, c) {
    return (c.items || []).filter(it => it && it.id && /^\d{4}-\d{2}-\d{2}$/.test(it.date || '')).map(it => {
      const m = +it.date.slice(5, 7), d = Math.min(+it.date.slice(8, 10), lastDay(y, m));
      const due = it.every === 'year' ? ymdOf(y, m, d) : (+it.date.slice(0, 4) === y ? it.date : null);
      return due && due >= it.date ? { rule: 'own', id: it.id, key: 'own_' + it.id + '_' + due, due: due,
        name: it.name || 'A date of yours', note: it.note || '', label: '' } : null;
    }).filter(Boolean);
  }

  // Every date due from `from` to `to` (YYYY-MM-DD), soonest first, with
  // whether it is done and what it needs.
  function between(from, to, c) {
    c = c || cfg;
    if (!c) return [];
    const out = [];
    if (from < FROM) from = FROM;
    for (let y = +from.slice(0, 4) - 1; y <= +to.slice(0, 4) + 1; y++) {
      builtIn(y, c).concat(own(y, c)).forEach(x => { if (x.due >= from && x.due <= to) out.push(x); });
    }
    out.forEach(x => {
      x.done = !!(c.done || {})[x.key];
      x.needs = needsOf(x, c);
    });
    return out.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
  }

  function money(cents) {
    return '$' + (Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // What each needs to hand -- the number when the server has it.
  function needsOf(x, c) {
    if (x.rule === 'salesTax') {
      const n = (c.numbers || {})[x.key];
      const today = localYMD();
      return n && typeof n.cents === 'number'
        ? 'Sales tax charged ' + (today <= x.to ? 'so far in ' : 'in ') + x.label + ': ' + money(n.cents) +
          ' on ' + n.docs + ' invoice' + (n.docs === 1 ? '' : 's') + ' (QuickBooks — check it against its Sales tax page)'
        : 'The sales tax charged in ' + x.label + ' — QuickBooks › Taxes';
    }
    if (x.rule === 'estTax') return 'What to pay: from the profit so far this year (your accountant, or last year’s return)';
    if (x.rule === 'returns') return 'The year’s books closed in QuickBooks, and every 1099 you were sent';
    if (x.rule === 'nec') return 'Each person’s W-9 and what they were paid in ' + x.label + ' — bank transfers, Cash App, checks';
    if (x.rule === 'llcReport') return 'apps.dfi.wi.gov — the entity ID is on last year’s report';
    return x.note || '';
  }

  const daysTo = s => Math.round((new Date(s + 'T12:00:00') - new Date(localYMD() + 'T12:00:00')) / 864e5);
  function whenWords(s) {
    const n = daysTo(s);
    const date = new Date(s + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (n === 0) return 'today, ' + date;
    if (n === 1) return 'tomorrow, ' + date;
    if (n < 0) return date + ' — ' + (-n) + ' day' + (n === -1 ? '' : 's') + ' ago';
    return date + ' — in ' + n + ' days';
  }

  // ------------------------------------------------------------ reading and saving

  async function load() {
    if (!isOwner() || !window.YDDb) return;
    try {
      cfg = (await window.YDDb.get('settings', 'deadlines')) || {};
    } catch (e) {
      if (!cfg) return;          // offline and nothing read yet: nothing to show
    }
    document.dispatchEvent(new CustomEvent('yd-deadlines'));
    if (el('dlModal') && el('dlModal').classList.contains('active')) draw();
  }
  // The maps merge key by key, as the database merges them (YDDb.put): a
  // null there is "not any more".
  const MAPS = ['done', 'off'];
  function save(patch, what) {
    if (!isOwner()) return;
    const next = Object.assign({}, cfg || {}, patch);
    MAPS.forEach(k => {
      if (!patch[k]) return;
      next[k] = Object.assign({}, (cfg || {})[k], patch[k]);
      Object.keys(next[k]).forEach(x => { if (next[k][x] == null) delete next[k][x]; });
    });
    cfg = next;
    Promise.resolve(window.YDDb.put('settings', 'deadlines', Object.assign({ updatedAt: new Date().toISOString() }, patch)))
      .catch(e => { console.warn('[deadlines] not saved:', e && (e.code || e.message)); showToast('Not saved yet — ' + what); });
    document.dispatchEvent(new CustomEvent('yd-deadlines'));
    draw();
  }

  // Ticked off (or back): its reminders stop. A merge keeps keys left out,
  // so undoing writes null.
  function setDone(key, on) {
    if (!isOwner() || !cfg) return false;
    const mark = on ? { at: new Date().toISOString(), by: (window.YDAuth.user || {}).uid || '' } : null;
    save({ done: { [key]: mark } }, 'ticking it off');
    return true;
  }

  // ------------------------------------------------------------ the window

  function modal() {
    let m = el('dlModal');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'modal-overlay';
    m.id = 'dlModal';
    m.innerHTML = '<div class="modal dl-modal" role="dialog" aria-labelledby="dlTitle">' +
      '<div class="modal-head"><h2 id="dlTitle">📅 Tax & filing dates</h2>' +
      '<button class="modal-close" onclick="closeDeadlines()" aria-label="Close">&times;</button></div>' +
      '<div class="modal-body" id="dlBody"></div></div>';
    document.body.appendChild(m);
    return m;
  }

  const FREQS = [['monthly', 'Every month'], ['quarterly', 'Every 3 months'], ['annual', 'Once a year']];

  function rowHtml(x) {
    const n = daysTo(x.due);
    const cls = x.done ? ' done' : n < 0 ? ' late' : n <= 3 ? ' now' : n <= SOON_DAYS ? ' soon' : '';
    return '<div class="dl-row' + cls + '">' +
      '<button class="dl-tick" onclick="dlTick(\'' + safeId(x.key) + '\', ' + (x.done ? 'false' : 'true') + ')" ' +
        'aria-label="' + (x.done ? 'Not done after all' : 'Done') + '">' + (x.done ? '✓' : '') + '</button>' +
      '<div class="dl-main"><b>' + esc(x.name) + '</b>' +
        '<small class="dl-when">' + esc((x.done ? '✓ Done · due ' : 'Due ') + whenWords(x.due)) + '</small>' +
        (x.needs && !x.done ? '<small>' + esc(x.needs) + '</small>' : '') + '</div>' +
      (x.rule === 'own'
        ? '<button class="link-btn dl-x" onclick="dlRemove(\'' + safeId(x.id) + '\')" aria-label="Take this date off">✕</button>'
        : '<button class="link-btn dl-x" onclick="dlOff(\'' + safeId(x.rule) + '\')" title="Not one of mine" ' +
            'aria-label="Not one of mine">✕</button>') +
    '</div>';
  }

  function draw() {
    const body = el('dlBody');
    if (!body) return;
    if (!cfg) { body.innerHTML = '<p class="empty-msg">Loading…</p>'; return; }
    const today = localYMD();
    const list = between(addDaysTo(today, -45), addDaysTo(today, 366));
    // Done ones from the past drop away; a late one stays until ticked off.
    const shown = list.filter(x => x.due >= today || !x.done);
    const off = Object.keys(cfg.off || {}).filter(k => cfg.off[k]);
    const OFF_NAMES = { salesTax: 'Sales tax returns', estTax: 'Estimated tax', returns: 'Income tax returns',
      nec: '1099-NECs', llcReport: 'LLC annual report' };
    body.innerHTML =
      '<p class="hint">Your phone is reminded 14 days before, 3 days before and on the day, until you tick it done. ' +
        'Dates that land on a weekend or holiday are moved to the next working day. Check them with your accountant.</p>' +
      '<div class="dl-ask"><b>How often do you file Wisconsin sales tax?</b>' +
        '<div class="dl-freq">' + FREQS.map(([k, w]) => '<button class="btn btn-sm' + (cfg.salesTax === k ? ' btn-filled' : '') +
          '" onclick="dlFreq(\'' + k + '\')">' + (cfg.salesTax === k ? '✓ ' : '') + w + '</button>').join('') + '</div>' +
        (cfg.salesTax ? '' : '<small>It says on your Wisconsin My Tax Account (Sales and use tax). ' +
          'Until you pick, there are no sales tax dates here.</small>') + '</div>' +
      (shown.length ? shown.map(rowHtml).join('') : '<p class="empty-msg">Nothing due in the next year.</p>') +
      (adding
        ? '<div class="dl-add">' +
            '<label>What is due<input id="dlAddName" value="' + esc(adding.name) + '" placeholder="Truck insurance renews" ' +
              'oninput="dlAddSet(\'name\', this.value)"></label>' +
            '<label>Date<input id="dlAddDate" type="date" value="' + esc(adding.date) + '" oninput="dlAddSet(\'date\', this.value)"></label>' +
            '<div class="dl-freq">' + [['year', 'Every year'], ['once', 'Just once']].map(([k, w]) =>
              '<button class="btn btn-sm' + (adding.every === k ? ' btn-filled' : '') + '" onclick="dlAddSet(\'every\', \'' + k + '\'); dlRedraw()">' +
              (adding.every === k ? '✓ ' : '') + w + '</button>').join('') + '</div>' +
            '<label>What it needs <span class="muted">(optional)</span><input id="dlAddNote" value="' + esc(adding.note) + '" ' +
              'placeholder="Policy number, who to call" oninput="dlAddSet(\'note\', this.value)"></label>' +
            '<div class="field-actions"><button class="btn btn-filled" onclick="dlAddSave()">Add it</button>' +
              '<button class="btn" onclick="dlAddCancel()">Cancel</button></div></div>'
        : '<button class="btn dl-add-btn" onclick="dlAddOpen()">+ A date of your own</button>') +
      (off.length ? '<p class="hint dl-off">Taken off: ' + off.map(k => esc(OFF_NAMES[k] || k) +
        ' <button class="link-btn" onclick="dlOn(\'' + safeId(k) + '\')">put back</button>').join(' · ') + '</p>' : '');
  }

  window.openDeadlines = function () {
    if (!isOwner()) return;
    const m = modal();
    m.classList.add('active');
    draw();
    load();
  };
  window.closeDeadlines = function () {
    // A date half typed in stays, for when the window is opened again.
    const m = el('dlModal');
    if (m) m.classList.remove('active');
  };
  window.dlRedraw = draw;
  window.dlTick = (key, on) => { setDone(key, on); };
  window.dlFreq = k => save({ salesTax: k }, 'how often you file');
  window.dlOff = rule => {
    const names = { salesTax: 'sales tax returns', estTax: 'estimated tax payments', returns: 'income tax returns',
      nec: '1099-NECs', llcReport: 'the LLC annual report' };
    save({ off: Object.assign({}, cfg.off, { [rule]: true }) }, 'taking it off');
    if (window.showUndo) showUndo('Took ' + (names[rule] || 'it') + ' off your dates', () => window.dlOn(rule));
  };
  window.dlOn = rule => save({ off: Object.assign({}, cfg.off, { [rule]: null }) }, 'putting it back');
  window.dlAddOpen = () => { adding = { name: '', date: '', every: 'year', note: '' }; draw(); const b = el('dlAddName'); if (b) b.focus(); };
  window.dlAddSet = (k, v) => { if (adding) adding[k] = v; };
  window.dlAddCancel = () => { adding = null; draw(); };
  window.dlAddSave = () => {
    if (!adding) return;
    const name = String(adding.name || '').trim();
    if (!name) { showToast('Say what is due'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(adding.date || '')) { showToast('Pick the date'); return; }
    const item = { id: 'dl' + Date.now().toString(36), name: name.slice(0, 120), date: adding.date,
      every: adding.every === 'once' ? 'once' : 'year', note: String(adding.note || '').trim().slice(0, 300) };
    adding = null;
    save({ items: (cfg.items || []).concat([item]) }, 'your date');
    showToast('Added — ' + item.name);
  };
  window.dlRemove = id => {
    const was = (cfg.items || []).slice();
    const it = was.find(x => x.id === id);
    if (!it) return;
    save({ items: was.filter(x => x.id !== id) }, 'taking it off');
    if (window.showUndo) showUndo('Took off ' + (it.name || 'that date'), () => save({ items: was }, 'putting it back'));
  };

  // ------------------------------------------------------------ the rest of Job Hub

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user && a.isOwner ? a.user.uid : null;
    if (k === who) return;
    who = k;
    cfg = null;
    adding = null;
    const m = el('dlModal');
    if (m) m.classList.remove('active');
    if (k) load();
    else document.dispatchEvent(new CustomEvent('yd-deadlines'));
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && who) load(); });

  window.YDDeadlines = {
    // The calendar's layer and Home: the owner's, once read.
    visible: () => isOwner() && !!cfg,
    between: (from, to) => between(from, to),
    // Not done and due within SOON_DAYS (or late): Home's Waiting on you.
    soon: () => {
      if (!isOwner() || !cfg) return [];
      const today = localYMD();
      return between(addDaysTo(today, -60), addDaysTo(today, SOON_DAYS)).filter(x => !x.done);
    },
    whenWords: whenWords,
    setDone: setDone,
    // For the tests: the rules with any settings.
    _between: between,
    _workday: workday,
  };
})();
