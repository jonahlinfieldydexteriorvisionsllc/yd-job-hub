// Machines and vehicles, and what has been done to them.
//
// The problem this solves is remembering. A mower's last oil change lives in
// somebody's head or on a receipt in a truck door, and gets recalled only when
// something seizes in the middle of a job. Written down and totalled up, it
// turns into a list of what is overdue -- which is the only form of this
// information that prevents anything.
//
// Two decisions shape the file.
//
// WHAT IS DUE IS NOT ALWAYS A DATE. A mower wears by running hours, a truck by
// miles, and a filter by months. Each machine says which of the three it is
// measured in, and any combination can be set. Forcing everything into a date
// would mean either servicing a mower that has not run, or not servicing one
// that has run all season.
//
// THE SERVICE LOG LIVES ON THE RECORD ITSELF, not in a subcollection. A machine
// accumulates a few entries a year, so the whole history is small, and keeping
// it in one document means one read, no separate security rules, and a history
// that cannot half-load.

(function () {
  'use strict';

  const KINDS = { machine: 'Machine', vehicle: 'Vehicle' };

  // How close to due counts as "coming up". Different units, same idea.
  const SOON = { days: 30, hours: 10, miles: 500 };

  // How urgent a noted problem is, most urgent first. Worded the way it gets
  // said in the yard, because the point is that anyone picking up the keys
  // knows at a glance whether they can use the thing.
  const URGENCY = [
    { id: 'down', label: 'Out of service', hint: 'do not use it until it is fixed', color: '#d64545' },
    { id: 'before', label: 'Before next use', hint: 'fix it before it goes out again', color: '#e07b24' },
    { id: 'soon', label: 'Soon', hint: 'this week', color: '#e0a526' },
    { id: 'whenever', label: 'When you have time', hint: 'not holding anything up', color: '#6b7a8f' },
  ];
  const urgencyOf = id => URGENCY.find(u => u.id === id) || URGENCY[URGENCY.length - 1];
  const rankOf = id => { const i = URGENCY.findIndex(u => u.id === id); return i === -1 ? URGENCY.length : i; };
  // On the Maintenance board, a problem whose part has arrived says so.
  const PART_LABEL = { id: 'part-at-shop', name: 'Part at shop', color: '#2f8f5b' };

  // Problems are kept on the machine's record beside its service history, for
  // the same reason: a machine has a handful, and one document means one read
  // and a history that cannot half-load.
  const openIssues = g => (g.issues || []).filter(i => !i.doneAt)
    .sort((a, b) => rankOf(a.urgency) - rankOf(b.urgency) || String(a.at).localeCompare(String(b.at)));
  const worstIssue = g => openIssues(g)[0] || null;

  let gear = {};
  let notingIssue = false;   // the "note a problem" form is open
  let unsub = null;
  let openId = null;      // the machine whose history is on screen
  let editingId = null;   // the machine being edited, '' for a new one
  let filter = 'all';

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const num = id => { const n = parseFloat(val(id).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');

  // ------------------------------------------------------------ what is due

  const last = g => (g.service || []).slice().sort((a, b) =>
    String(b.at || '').localeCompare(String(a.at || '')))[0] || null;

  // The newest service that recorded a reading ('hours' or 'miles'), or the
  // newest of all when no reading is named. Two on the same day count in the
  // order they were logged.
  function newestWith(service, field) {
    let best = null;
    (service || []).forEach(e => {
      if (field && e[field] == null) return;
      if (!best || String(e.at || '') >= String(best.at || '')) best = e;
    });
    return best;
  }

  // Where the next service falls, counted from the newest service that
  // recorded each measure -- not from whichever entry happened to be typed
  // last. Back-filling last spring's oil change used to drag the next service
  // back to last spring. A measure with nothing to count from is left out, so
  // the machine keeps what it has.
  //
  // Repairs (logged by pressing Fixed on a problem) do not count: a new
  // hydraulic hose is not an oil change, and must not restart its countdown.
  function dueFromHistory(g, all) {
    const service = (all || []).filter(e => e.kind !== 'repair');
    const out = {};
    const h = newestWith(service, 'hours');
    if (g.intervalHours && h) out.dueHours = round1(h.hours + g.intervalHours);
    const m = newestWith(service, 'miles');
    if (g.intervalMiles && m) out.dueMiles = Math.round(m.miles + g.intervalMiles);
    const d = newestWith(service);
    if (g.intervalDays && d && d.at) {
      const base = new Date(d.at + 'T00:00:00');
      base.setDate(base.getDate() + g.intervalDays);
      out.dueDate = localDay(base);
    }
    return out;
  }

  // Returns { state, text } where state is overdue | soon | ok | none.
  // Whichever measure is closest to running out is the one reported, because
  // that is the one that decides whether the machine gets serviced.
  function due(g) {
    const bits = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);

    if (g.dueDate) {
      const d = new Date(g.dueDate + 'T00:00:00');
      const days = Math.round((d - today) / 864e5);
      bits.push({
        rank: days <= 0 ? 0 : days <= SOON.days ? 1 : 2,
        sort: days,
        text: days < 0 ? Math.abs(days) + ' days overdue'
          : days === 0 ? 'due today'
          : 'due in ' + days + ' day' + (days === 1 ? '' : 's'),
      });
    }
    if (g.dueHours != null && g.hours != null) {
      const left = g.dueHours - g.hours;
      bits.push({
        rank: left <= 0 ? 0 : left <= SOON.hours ? 1 : 2,
        sort: left,
        text: left < 0 ? Math.abs(round1(left)) + ' hours past due'
          : 'due in ' + round1(left) + ' hours',
      });
    }
    if (g.dueMiles != null && g.miles != null) {
      const left = g.dueMiles - g.miles;
      bits.push({
        rank: left <= 0 ? 0 : left <= SOON.miles ? 1 : 2,
        sort: left,
        text: left < 0 ? fmtNum(Math.abs(left)) + ' miles past due'
          : 'due in ' + fmtNum(left) + ' miles',
      });
    }
    if (!bits.length) return { state: 'none', text: 'nothing scheduled' };
    bits.sort((a, b) => a.rank - b.rank || a.sort - b.sort);
    const worst = bits[0];
    return { state: worst.rank === 0 ? 'overdue' : worst.rank === 1 ? 'soon' : 'ok', text: worst.text };
  }

  const round1 = n => Math.round(n * 10) / 10;
  const fmtNum = n => Math.round(n).toLocaleString('en-US');
  const money = c => '$' + (c / 100).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US',
      { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------------------------------------------------------------- the list

  window.renderEquipment = function () {
    const wrap = el('eqWrap');
    if (!wrap) return;

    const all = Object.values(gear);
    const overdue = all.filter(g => due(g).state === 'overdue');
    const soon = all.filter(g => due(g).state === 'soon');

    const down = all.filter(g => (worstIssue(g) || {}).urgency === 'down');
    const badge = el('eqBadge');
    if (badge) {
      badge.textContent = down.length ? down.length + ' out of service'
        : overdue.length ? overdue.length + ' overdue'
        : soon.length ? soon.length + ' coming up' : '';
      badge.className = 'section-badge' + (down.length || overdue.length ? ' accent' : '');
    }

    // Anything out of service first, then whatever must be fixed before it is
    // used, then by service due.
    const issueRank = g => { const w = worstIssue(g); return w ? rankOf(w.urgency) : URGENCY.length; };
    const list = all
      .filter(g => filter === 'all' || g.kind === filter)
      .sort((a, b) => {
        const order = { overdue: 0, soon: 1, ok: 2, none: 3 };
        return Math.min(issueRank(a), 2) - Math.min(issueRank(b), 2) ||
               order[due(a).state] - order[due(b).state] ||
               String(a.name || '').localeCompare(b.name || '');
      });

    wrap.innerHTML =
      '<div class="filter-bar">' +
        ['all', 'machine', 'vehicle'].map(f =>
          '<button class="btn btn-sm' + (filter === f ? ' btn-filled' : '') +
          '" onclick="filterEquipment(\'' + f + '\')">' +
          (f === 'all' ? 'Everything' : KINDS[f] + 's') + '</button>').join('') +
        '<button class="btn btn-sm btn-accent" onclick="editEquipment(\'\')">+ Add</button>' +
      '</div>' +
      (list.length
        ? list.map(card).join('')
        : '<p class="empty-msg">Nothing here yet. Add a machine or a truck and start ' +
          'writing down what gets done to it.</p>');
  };

  window.filterEquipment = function (f) { filter = f; renderEquipment(); };

  function card(g) {
    const d = due(g);
    const l = last(g);
    return '<div class="eq eq-' + d.state + '" onclick="openEquipment(\'' + g.id + '\')">' +
      '<div class="eq-top">' +
        '<span class="eq-name">' + esc(g.name) + '</span>' +
        '<span class="eq-kind">' + (KINDS[g.kind] || '') + '</span>' +
        '<span class="eq-due ' + d.state + '">' + d.text + '</span>' +
      '</div>' +
      (g.make || g.model || g.year
        ? '<div class="eq-what">' + esc([g.year, g.make, g.model].filter(Boolean).join(' ')) + '</div>'
        : '') +
      issueLine(g) +
      '<div class="eq-last">' +
        (l ? 'Last: ' + shortDate(l.at) + ' — ' + esc(l.what)
           : 'Nothing logged yet') +
      '</div>' +
      (g.hours != null || g.miles != null
        ? '<div class="eq-reading">' +
            (g.hours != null ? round1(g.hours) + ' hours' : '') +
            (g.hours != null && g.miles != null ? ' · ' : '') +
            (g.miles != null ? fmtNum(g.miles) + ' miles' : '') +
          '</div>'
        : '') +
    '</div>';
  }

  // The one line on a machine's card about what is wrong with it: the most
  // urgent problem, and how many more.
  function issueLine(g) {
    const open = openIssues(g);
    if (!open.length) return '';
    const u = urgencyOf(open[0].urgency);
    return '<div class="eq-issue" style="--c:' + u.color + '">' +
      '<span class="eq-urg">' + esc(u.label) + '</span> ' + esc(open[0].what) +
      (open[0].partAtShop ? ' <span class="eq-part-chip">part at shop</span>' : '') +
      (open.length > 1 ? ' <span class="eq-more">+' + (open.length - 1) + ' more</span>' : '') +
    '</div>';
  }

  // -------------------------------------------------------------- the detail

  window.openEquipment = function (id) {
    openId = id;
    notingIssue = false;
    const m = el('eqModal');
    if (m) m.classList.add('active');
    renderDetail();
  };
  window.closeEquipment = function () {
    openId = null; editingId = null; notingIssue = false;
    const m = el('eqModal');
    if (m) m.classList.remove('active');
  };

  function renderDetail() {
    const body = el('eqBody');
    const g = gear[openId];
    if (!body || !g) return;
    const title = el('eqTitle');
    if (title) title.textContent = g.name || 'Machine';

    const d = due(g);
    const log = (g.service || []).slice().sort((a, b) =>
      String(b.at || '').localeCompare(String(a.at || '')));
    const spent = log.reduce((s, e) => s + (e.costCents || 0), 0);

    body.innerHTML =
      '<div class="eq-head">' +
        '<div>' +
          '<div class="eq-sub">' + (KINDS[g.kind] || '') +
            (g.year || g.make || g.model
              ? ' · ' + esc([g.year, g.make, g.model].filter(Boolean).join(' ')) : '') +
          '</div>' +
          (g.serial ? '<div class="eq-serial">' +
            (g.kind === 'vehicle' ? 'VIN ' : 'Serial ') + esc(g.serial) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-sm" onclick="editEquipment(\'' + g.id + '\')">Edit</button>' +
      '</div>' +

      '<div class="eq-cards">' +
        eqCard('Next service', d.text, d.state) +
        eqCard('Hours', g.hours != null ? round1(g.hours) : '—', '') +
        eqCard('Miles', g.miles != null ? fmtNum(g.miles) : '—', '') +
        eqCard('Spent on it', spent ? money(spent) : '—', '') +
      '</div>' +

      (g.notes ? '<div class="eq-notes">' + esc(g.notes) + '</div>' : '') +

      issuesHtml(g) +

      '<div class="eq-loghead">Service history' +
        '<button class="btn btn-sm btn-filled" onclick="addService()">+ Log a service</button>' +
      '</div>' +
      // A list, not a table: on a phone the table scrolled sideways and its
      // Edit button sat off the right edge, so Jonah never found it. Now the
      // whole row is the button.
      (log.length
        ? '<div class="eq-log">' + log.map(e => {
            const reading = [e.hours != null ? round1(e.hours) + ' hrs' : '',
                             e.miles != null ? fmtNum(e.miles) + ' mi' : ''].filter(Boolean).join(' · ');
            return '<div class="eq-log-row" role="button" tabindex="0" title="Tap to change" ' +
                'onclick="editService(\'' + safeId(e.id) + '\')" ' +
                'onkeydown="if(event.key===\'Enter\')editService(\'' + safeId(e.id) + '\')">' +
              '<span class="eq-log-when">' + shortDate(e.at) + '</span>' +
              '<span class="eq-log-what"><b>' + esc(e.what) + '</b>' +
                (e.kind === 'repair' ? ' <span class="eq-repair">repair</span>' : '') +
                '<span class="eq-log-sub">' + [reading, e.by ? esc(e.by) : ''].filter(Boolean).join(' · ') + '</span>' +
              '</span>' +
              '<span class="eq-log-cost">' + (e.costCents ? money(e.costCents) : '') + '</span>' +
              '<span class="eq-log-edit">Edit ›</span>' +
              '<button class="remove-btn" onclick="event.stopPropagation();removeService(\'' + safeId(e.id) + '\')" ' +
                'title="Remove">&times;</button>' +
            '</div>';
          }).join('') + '</div>'
        : '<p class="empty-msg">Nothing logged yet.</p>');
  }

  function eqCard(label, value, state) {
    return '<div class="eq-card' + (state ? ' ' + state : '') + '">' +
      '<div class="eq-card-label">' + label + '</div>' +
      '<div class="eq-card-value">' + esc(String(value)) + '</div></div>';
  }

  // ------------------------------------------------------ what needs doing
  //
  // A part to order or a job to do on this machine, with how urgent it is.
  // Different from the service schedule: that is routine and predictable, this
  // is whatever someone noticed -- a cracked hose, a tyre going soft, a blade
  // to sharpen. Each one also becomes a card on the Maintenance board.

  function issuesHtml(g) {
    const open = openIssues(g);
    const fixed = (g.issues || []).filter(i => i.doneAt)
      .sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 5);
    return '<div class="eq-loghead">Needs doing' +
        (notingIssue ? '' : '<button class="btn btn-sm btn-accent" onclick="noteIssue()">+ Note a part or service</button>') +
      '</div>' +
      (notingIssue ? issueFormHtml() : '') +
      (open.length
        ? '<div class="eq-issues">' + open.map(i => {
            const u = urgencyOf(i.urgency);
            return '<div class="eq-issue-row" style="--c:' + u.color + '">' +
              '<div class="eq-issue-main">' +
                '<span class="eq-urg">' + esc(u.label) + '</span>' +
                '<div class="eq-issue-what">' + esc(i.what) + '</div>' +
                (i.note ? '<div class="eq-issue-note">' + esc(i.note) + '</div>' : '') +
                '<div class="eq-issue-meta">Noted ' + shortDate(i.at) + (i.by ? ' by ' + esc(i.by) : '') + '</div>' +
                // Ticked when the part turns up, so nobody orders it twice
                // and the job can be booked in.
                '<label class="chk eq-part"><input type="checkbox"' + (i.partAtShop ? ' checked' : '') +
                  ' onchange="togglePart(\'' + safeId(i.id) + '\', this.checked)"> Part at shop</label>' +
              '</div>' +
              '<div class="eq-issue-act">' +
                '<button class="btn btn-sm btn-filled" onclick="fixIssue(\'' + i.id + '\')">Fixed</button>' +
                '<button class="remove-btn" onclick="removeIssue(\'' + i.id + '\')" title="Delete">&times;</button>' +
              '</div>' +
            '</div>';
          }).join('') + '</div>'
        : (notingIssue ? '' : '<p class="empty-msg">Nothing noted. If something is wrong with it, note it here so it does not get forgotten.</p>')) +
      (fixed.length
        ? '<div class="eq-fixed">Fixed recently: ' + fixed.map(i =>
            esc(i.what) + ' <span class="muted">(' + shortDate(i.doneAt) + ')</span>').join(' · ') + '</div>'
        : '');
  }

  function issueFormHtml() {
    return '<div class="add-area" id="eqIssueForm">' +
      '<div class="field"><span class="label">What needs doing</span>' +
        '<input id="isWhat" placeholder="e.g. hydraulic hose leaking, new blades, front tyre soft"></div>' +
      '<div class="field"><span class="label">How urgent</span><div class="eq-urg-pick">' +
        URGENCY.map((u, n) => '<label class="eq-urg-opt" style="--c:' + u.color + '">' +
          '<input type="radio" name="isUrg" value="' + u.id + '"' + (u.id === 'soon' ? ' checked' : '') + '>' +
          '<span><b>' + esc(u.label) + '</b><small>' + esc(u.hint) + '</small></span></label>').join('') +
      '</div></div>' +
      '<div class="field"><span class="label">Notes (optional)</span>' +
        '<input id="isNote" placeholder="part number, where to get it, who noticed"></div>' +
      '<label class="chk"><input type="checkbox" id="isPart"> Part is already at the shop</label>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveIssue()">Save</button>' +
        '<button class="btn btn-sm" onclick="cancelIssue()">Cancel</button>' +
      '</div>' +
    '</div>';
  }

  window.noteIssue = function () {
    notingIssue = true;
    renderDetail();
    const w = el('isWhat'); if (w) w.focus();
  };
  window.cancelIssue = function () { notingIssue = false; renderDetail(); };

  function whoAmI() {
    const u = window.YDAuth && window.YDAuth.user;
    return (u && (u.displayName || u.email)) || '';
  }

  window.saveIssue = function () {
    const g = gear[openId];
    if (!g) return;
    const what = val('isWhat');
    if (!what) { showToast('Say what needs doing'); return; }
    const pick = document.querySelector('input[name="isUrg"]:checked');
    const issue = {
      id: 'is' + Date.now().toString(36),
      what: what,
      urgency: pick ? pick.value : 'soon',
      note: val('isNote'),
      partAtShop: !!(el('isPart') && el('isPart').checked),
      at: new Date().toISOString(),
      by: whoAmI(),
      doneAt: null,
    };
    g.issues = (g.issues || []).concat([issue]);
    notingIssue = false;
    renderDetail(); renderEquipment();
    write(g.id, { issues: g.issues }, 'noting a problem');
    showToast(urgencyOf(issue.urgency).label + ' — ' + what);
  };

  function setIssueDone(g, issueId, done) {
    g.issues = (g.issues || []).map(i => i.id === issueId
      ? Object.assign({}, i, { doneAt: done ? new Date().toISOString() : null, doneBy: done ? whoAmI() : null }) : i);
    write(g.id, { issues: g.issues }, done ? 'marking a problem fixed' : 'reopening a problem');
  }

  window.togglePart = function (issueId, on) {
    const g = gear[openId];
    if (!g) return;
    g.issues = (g.issues || []).map(i => i.id === issueId ? Object.assign({}, i, { partAtShop: !!on }) : i);
    renderDetail(); renderEquipment();
    write(g.id, { issues: g.issues }, on ? 'marking a part at the shop' : 'unmarking a part at the shop');
    showToast(on ? 'Part at the shop' : 'Part not at the shop');
  };

  // "Fixed" used to tick the problem off and keep nothing of the repair. It
  // now opens the service log already filled in with the problem, so the
  // date, the reading, who did it and the cost go into the history -- and
  // the problem is marked fixed only when that is saved.
  window.fixIssue = function (issueId) {
    const g = gear[openId];
    const i = g && (g.issues || []).find(x => x.id === issueId);
    if (!i) return;
    serviceForm(null, i);
  };

  window.removeIssue = function (issueId) {
    const g = gear[openId];
    if (!g) return;
    const i = (g.issues || []).find(x => x.id === issueId);
    if (!i || !confirm('Delete "' + i.what + '"? (Use Fixed instead if it was done — that keeps a record.)')) return;
    g.issues = (g.issues || []).filter(x => x.id !== issueId);
    renderDetail(); renderEquipment();
    write(g.id, { issues: g.issues }, 'deleting a problem');
  };

  // ------------------------------------------------------------ logging work

  // The logged service being changed, or null while logging a new one.
  let editingEntry = null;
  // The problem being fixed by the service on the form, if any.
  let fixingIssue = null;

  window.addService = function () { serviceForm(null); };
  // A service logged with the wrong date, cost or reading used to have to be
  // deleted and typed in again from scratch.
  window.editService = function (entryId) { serviceForm(entryId); };

  function serviceForm(entryId, issue) {
    const g = gear[openId];
    if (!g) return;
    const e = entryId ? (g.service || []).find(x => x.id === entryId) : null;
    if (entryId && !e) return;
    const fixing = !e && issue ? issue : null;
    // Already open: a second tap used to add a second form with the same
    // field ids, and Save then read whichever one came first. Asking for a
    // different entry swaps the form over instead.
    if (el('eqServiceForm')) {
      if (editingEntry === (e ? e.id : null) && fixingIssue === (fixing ? fixing.id : null)) {
        const w = el('svWhat'); if (w) w.focus(); return;
      }
      el('eqServiceForm').remove();
    }
    editingEntry = e ? e.id : null;
    fixingIssue = fixing ? fixing.id : null;
    const body = el('eqBody');
    const iso = localDay();
    const has = v => (v == null ? '' : esc(String(v)));
    const what = e ? e.what : (fixing ? fixing.what : '');

    body.insertAdjacentHTML('afterbegin',
      '<div class="add-area" id="eqServiceForm">' +
        '<div class="add-label">' + (e ? 'Change this service on ' + esc(g.name)
          : fixing ? 'Fixed: ' + esc(fixing.what) + ' — log the repair'
          : 'What was done to ' + esc(g.name)) + '</div>' +
        '<div class="grid g2">' +
          '<div class="field"><span class="label">When</span>' +
            '<input type="date" id="svAt" value="' + (e ? has(e.at) : iso) + '" max="' + iso + '"></div>' +
          '<div class="field"><span class="label">Cost</span>' +
            '<input id="svCost" inputmode="decimal" placeholder="$" value="' +
            (e && e.costCents != null ? has(e.costCents / 100) : '') + '"></div>' +
        '</div>' +
        '<div class="field"><span class="label">What was done</span>' +
          '<input id="svWhat" placeholder="e.g. oil and filter, new blades" value="' + has(what) + '"></div>' +
        '<div class="grid g3">' +
          '<div class="field"><span class="label">' + (e ? 'Hours then' : 'Hours now') +
            (!e && readingWanted(g) === 'hours' ? ' <b class="eq-need">*</b>' : '') + '</span>' +
            '<input id="svHours" inputmode="decimal" value="' + (e ? has(e.hours) : '') + '" placeholder="' +
            (g.hours != null ? 'last ' + round1(g.hours) : 'optional') + '"></div>' +
          '<div class="field"><span class="label">' + (e ? 'Miles then' : 'Miles now') +
            (!e && readingWanted(g) === 'miles' ? ' <b class="eq-need">*</b>' : '') + '</span>' +
            '<input id="svMiles" inputmode="numeric" value="' + (e ? has(e.miles) : '') + '" placeholder="' +
            (g.miles != null ? 'last ' + fmtNum(g.miles) : 'optional') + '"></div>' +
          '<div class="field"><span class="label">Who did it</span>' +
            '<input id="svBy" placeholder="you, or the shop" value="' + (e ? has(e.by) : '') + '"></div>' +
        '</div>' +
        '<div class="hint">Putting the hours or miles in is what lets the next service ' +
          'be worked out. Leave them blank if this machine goes by date.</div>' +
        '<div class="field-actions">' +
          '<button class="btn btn-filled" onclick="saveService()">' +
            (e ? 'Save changes' : fixing ? 'Save — mark it fixed' : 'Save') + '</button>' +
          '<button class="btn btn-sm" onclick="renderDetail2()">Cancel</button>' +
        '</div>' +
      '</div>');
    const form = el('eqServiceForm');
    if (form && form.scrollIntoView) form.scrollIntoView({ block: 'nearest' });
    const w = el('svWhat'); if (w) w.focus();
  }

  window.renderDetail2 = function () { editingEntry = null; fixingIssue = null; renderDetail(); };

  // The reading a new service should come with: miles for a vehicle, hours
  // for a machine on an hours interval. Jonah wants the count every time a
  // service is entered -- it is what keeps "next service" right.
  function readingWanted(g) {
    if (g.kind === 'vehicle') return 'miles';
    if (g.intervalHours || g.hours != null) return 'hours';
    return '';
  }

  window.saveService = function () {
    const g = gear[openId];
    if (!g) return;
    const what = val('svWhat');
    if (!what) { showToast('Say what was done'); return; }
    if (editingEntry) { saveServiceChange(g, what); return; }
    const want = readingWanted(g);
    const box = want === 'miles' ? 'svMiles' : want === 'hours' ? 'svHours' : '';
    if (box && num(box) == null && !confirm('No ' + want + ' reading this time? The next service is worked out from the ' +
        want + ' — OK to save without it, Cancel to type it in.')) {
      const b = el(box); if (b) b.focus();
      return;
    }

    const entry = {
      id: 'sv' + Date.now().toString(36),
      at: val('svAt') || localDay(),   // the LOCAL date; toISOString() is tomorrow after 7 pm
      what: what,
      costCents: num('svCost') != null ? Math.round(num('svCost') * 100) : null,
      hours: num('svHours'),
      miles: num('svMiles'),
      by: val('svBy'),
    };
    const fixed = fixingIssue ? (g.issues || []).find(i => i.id === fixingIssue) : null;
    fixingIssue = null;
    if (fixed) { entry.kind = 'repair'; entry.issueId = fixed.id; }

    const service = (g.service || []).concat([entry]);
    const patch = { service: service };
    if (fixed) {
      // Fixed on the day the repair was done, which may be before today.
      const doneAt = entry.at === localDay() ? new Date().toISOString() : entry.at + 'T12:00:00';
      patch.issues = (g.issues || []).map(i => i.id === fixed.id
        ? Object.assign({}, i, { doneAt: doneAt, doneBy: entry.by || whoAmI(), serviceId: entry.id }) : i);
    }

    // A reading taken during a service is the machine's current reading, and
    // moves the next service along with it. Without this the hours would have
    // to be typed twice and would drift apart. But meters only go forward: a
    // reading below the one on the machine belongs to an older service being
    // written up late, and goes into the history without winding it back.
    if (entry.hours != null && (g.hours == null || entry.hours >= g.hours)) patch.hours = entry.hours;
    if (entry.miles != null && (g.miles == null || entry.miles >= g.miles)) patch.miles = entry.miles;
    const next = dueFromHistory(g, service);
    if (entry.hours != null && next.dueHours != null) patch.dueHours = next.dueHours;
    if (entry.miles != null && next.dueMiles != null) patch.dueMiles = next.dueMiles;
    if (next.dueDate) patch.dueDate = next.dueDate;

    Object.assign(g, patch);
    renderDetail(); renderEquipment();
    write(g.id, patch, fixed ? 'logging a repair' : 'logging a service');
    showToast((fixed ? 'Fixed and logged — ' : 'Logged — ') + what);
  };

  // A changed entry keeps its id and its place in the history. The machine's
  // reading and the next service are then worked out the same way as when an
  // entry is logged or removed: if this entry is where the reading came from,
  // the reading follows the corrected history (a 300 typed for 100 comes back
  // down to 100); otherwise meters only go forward.
  function saveServiceChange(g, what) {
    const old = (g.service || []).find(e => e.id === editingEntry);
    editingEntry = null;
    if (!old) { renderDetail(); return; }
    const entry = Object.assign({}, old, {
      at: val('svAt') || old.at,
      what: what,
      costCents: num('svCost') != null ? Math.round(num('svCost') * 100) : null,
      hours: num('svHours'),
      miles: num('svMiles'),
      by: val('svBy'),
    });
    const service = (g.service || []).map(e => (e.id === entry.id ? entry : e));
    const patch = { service: service };

    ['hours', 'miles'].forEach(k => {
      const newest = newestWith(service, k);
      if (old[k] != null && old[k] === g[k]) {
        if (newest) patch[k] = newest[k];
      } else if (entry[k] != null && (g[k] == null || entry[k] > g[k])) {
        patch[k] = entry[k];
      }
    });
    const next = dueFromHistory(g, service);
    if ((old.hours != null || entry.hours != null) && next.dueHours != null) patch.dueHours = next.dueHours;
    if ((old.miles != null || entry.miles != null) && next.dueMiles != null) patch.dueMiles = next.dueMiles;
    if (next.dueDate) patch.dueDate = next.dueDate;

    Object.assign(g, patch);
    renderDetail(); renderEquipment();
    write(g.id, patch, 'changing a service entry');
    showToast('Changed — ' + what);
  }

  window.removeService = function (entryId) {
    const g = gear[openId];
    if (!g) return;
    const entry = (g.service || []).find(e => e.id === entryId);
    if (!entry || !confirm('Remove "' + entry.what + '" from the history?')) return;
    const service = (g.service || []).filter(e => e.id !== entryId);
    const patch = { service: service };
    // If this entry is where the machine's reading came from, the reading
    // goes back to the newest one left. Otherwise a mistaken 300-hour entry,
    // once removed, would leave the mower reading 300 against a next service
    // counted from 100 -- and showing it 150 hours past due.
    const h = newestWith(service, 'hours'), m = newestWith(service, 'miles');
    if (entry.hours != null && entry.hours === g.hours && h) patch.hours = h.hours;
    if (entry.miles != null && entry.miles === g.miles && m) patch.miles = m.miles;
    // The next service goes back to where the newest remaining one puts it.
    const next = dueFromHistory(g, service);
    if (entry.hours != null && next.dueHours != null) patch.dueHours = next.dueHours;
    if (entry.miles != null && next.dueMiles != null) patch.dueMiles = next.dueMiles;
    if (next.dueDate) patch.dueDate = next.dueDate;
    Object.assign(g, patch);
    renderDetail(); renderEquipment();
    write(g.id, patch, 'removing a service entry');
  };

  // ------------------------------------------------------------- the record

  window.editEquipment = function (id) {
    editingId = id;
    const g = id ? gear[id] : {};
    const body = el('eqBody');
    const m = el('eqModal');
    if (m) m.classList.add('active');
    const title = el('eqTitle');
    if (title) title.textContent = id ? 'Edit ' + (g.name || '') : 'Add a machine or vehicle';
    if (!body) return;

    body.innerHTML =
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Name</span>' +
          '<input id="eqName" value="' + esc(g.name || '') + '" placeholder="e.g. Toro 60\" or the F-250"></div>' +
        '<div class="field"><span class="label">What is it</span>' +
          '<select id="eqKind">' +
            Object.keys(KINDS).map(k => '<option value="' + k + '"' +
              ((g.kind || 'machine') === k ? ' selected' : '') + '>' + KINDS[k] + '</option>').join('') +
          '</select></div>' +
      '</div>' +
      '<div class="grid g3">' +
        '<div class="field"><span class="label">Year</span><input id="eqYear" inputmode="numeric" value="' + esc(g.year || '') + '"></div>' +
        '<div class="field"><span class="label">Make</span><input id="eqMake" value="' + esc(g.make || '') + '"></div>' +
        '<div class="field"><span class="label">Model</span><input id="eqModel" value="' + esc(g.model || '') + '"></div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Serial or VIN</span><input id="eqSerial" value="' + esc(g.serial || '') + '"></div>' +
        '<div class="field"><span class="label">Bought for</span><input id="eqPrice" inputmode="decimal" value="' +
          (g.priceCents != null ? (g.priceCents / 100) : '') + '" placeholder="$"></div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Hours now</span><input id="eqHours" inputmode="decimal" value="' +
          (g.hours != null ? g.hours : '') + '" placeholder="leave blank if it has no hour meter"></div>' +
        '<div class="field"><span class="label">Miles now</span><input id="eqMiles" inputmode="numeric" value="' +
          (g.miles != null ? g.miles : '') + '" placeholder="vehicles only"></div>' +
      '</div>' +

      '<div class="eq-loghead">How often it needs servicing</div>' +
      '<div class="grid g3">' +
        '<div class="field"><span class="label">Every X hours</span><input id="eqIntHours" inputmode="decimal" value="' +
          (g.intervalHours != null ? g.intervalHours : '') + '" placeholder="e.g. 50"></div>' +
        '<div class="field"><span class="label">Every X miles</span><input id="eqIntMiles" inputmode="numeric" value="' +
          (g.intervalMiles != null ? g.intervalMiles : '') + '" placeholder="e.g. 5000"></div>' +
        '<div class="field"><span class="label">Every X days</span><input id="eqIntDays" inputmode="numeric" value="' +
          (g.intervalDays != null ? g.intervalDays : '') + '" placeholder="e.g. 180"></div>' +
      '</div>' +
      '<div class="hint">Fill in whichever fits. A mower wears by hours, a truck by miles, ' +
        'a filter by months — set any or all of them and the next service works itself out ' +
        'each time you log one.</div>' +

      '<div class="field"><span class="label">Notes</span>' +
        '<textarea id="eqNotes" rows="2" placeholder="anything worth remembering about it">' +
        esc(g.notes || '') + '</textarea></div>' +

      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveEquipment()">Save</button>' +
        '<button class="btn btn-sm" onclick="cancelEquipmentEdit()">Cancel</button>' +
        (id ? '<button class="btn btn-sm" onclick="removeEquipment(\'' + id + '\')">Remove</button>' : '') +
      '</div>';
    const n = el('eqName'); if (n) n.focus();
  };

  window.cancelEquipmentEdit = function () {
    editingId = null;
    if (openId && gear[openId]) renderDetail();
    else closeEquipment();
  };

  window.saveEquipment = function () {
    const name = val('eqName');
    if (!name) { showToast('Give it a name'); return; }
    const id = editingId || ('eq' + Date.now().toString(36));
    const was = gear[id] || {};

    const rec = {
      name: name,
      kind: val('eqKind') || 'machine',
      year: val('eqYear'), make: val('eqMake'), model: val('eqModel'),
      serial: val('eqSerial'),
      priceCents: num('eqPrice') != null ? Math.round(num('eqPrice') * 100) : null,
      hours: num('eqHours'), miles: num('eqMiles'),
      intervalHours: num('eqIntHours'), intervalMiles: num('eqIntMiles'),
      intervalDays: num('eqIntDays'),
      notes: val('eqNotes'),
      service: was.service || [],
      addedAt: was.addedAt || new Date().toISOString(),
    };

    // A machine added with a reading and an interval already knows when it is
    // next due, rather than looking like nothing is scheduled until the first
    // service is logged.
    //
    // Only worked out when there is nothing to keep, or the interval itself was
    // changed. Re-working it on every save meant that editing the notes on a
    // mower due at 50 hours quietly moved it to "due at 98" -- hiding the very
    // service this screen exists to remind about.
    const hoursChanged = rec.intervalHours !== (was.intervalHours != null ? was.intervalHours : null);
    const milesChanged = rec.intervalMiles !== (was.intervalMiles != null ? was.intervalMiles : null);
    const daysChanged = rec.intervalDays !== (was.intervalDays != null ? was.intervalDays : null);
    if (rec.hours != null && rec.intervalHours && (was.dueHours == null || hoursChanged)) {
      rec.dueHours = round1(rec.hours + rec.intervalHours);
    } else if (was.dueHours != null && rec.intervalHours) rec.dueHours = was.dueHours;
    else rec.dueHours = null;
    if (rec.miles != null && rec.intervalMiles && (was.dueMiles == null || milesChanged)) {
      rec.dueMiles = Math.round(rec.miles + rec.intervalMiles);
    } else if (was.dueMiles != null && rec.intervalMiles) rec.dueMiles = was.dueMiles;
    else rec.dueMiles = null;
    // A machine that goes by date gets a first due date counted from today
    // (or from its last service), so it lands on the calendar straight away.
    if (rec.intervalDays && (!was.dueDate || daysChanged)) {
      const l = last(was);
      const base = new Date(((l && l.at) || localDay()) + 'T00:00:00');
      base.setDate(base.getDate() + rec.intervalDays);
      rec.dueDate = localDay(base);
    } else if (was.dueDate && rec.intervalDays) rec.dueDate = was.dueDate;
    // No interval in days any more, so no date to be due by. Keeping the old
    // one left a truck switched over to miles "overdue" by date for good, with
    // no field anywhere to clear it -- a due date only ever comes from this
    // interval, the same way the hours and miles ones above do.
    else rec.dueDate = null;

    gear[id] = Object.assign({ id: id }, rec);
    editingId = null; openId = id;
    renderDetail(); renderEquipment();
    write(id, rec, 'saving ' + name);
    showToast(name + ' saved');
  };

  window.removeEquipment = function (id) {
    if (!ydCan('equipment', 'change')) return;
    const g = gear[id];
    if (!g || !confirm('Remove ' + g.name + ' and its whole service history?')) return;
    delete gear[id];
    closeEquipment(); renderEquipment();
    if (!window.YDDb) return;
    Promise.resolve(window.YDDb.remove('equipment', id))
      .catch(e => console.warn('[equipment] not removed:', e.code || e.message));
  };

  function two(n) { return String(n).padStart(2, '0'); }
  function localDay(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  function write(id, data, what) {
    if (!window.YDDb) { showToast('Not saved — still connecting'); return; }
    // The backstop: someone who may only look has no buttons to get here.
    if (!ydCan('equipment', 'change')) { showToast('You can look at equipment but not change it'); return; }
    Promise.resolve(window.YDDb.put('equipment', id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[equipment] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }

  // ---------------------------------------------------------------- loading

  function start() {
    if (unsub || !window.YDDb) return;
    unsub = window.YDDb.watch('equipment', (changes, meta) => {
      changes.forEach(c => {
        if (c.type === 'removed') delete gear[c.id];
        else gear[c.id] = Object.assign({ id: c.id }, c.data);
      });
      if (meta && !meta.fromCache) gearLoaded = true;
      renderEquipment();
      // Not while something is being typed into the detail -- a change from
      // another device would otherwise wipe the half-written problem.
      if (openId && gear[openId] && !editingId && !notingIssue && !el('svWhat')) renderDetail();
      scheduleMaintSync();
    }, () => renderEquipment());
  }

  // ------------------------------------------------- the maintenance board
  //
  // Every machine with a next service gets one card on the Maintenance board,
  // kept in step from here: made when an interval is set, updated when a
  // service is logged or the due point changes, removed with the machine. The
  // calendar needs nothing from here -- it reads the due dates straight off
  // these records, so it can never show a date the machine no longer has.
  //
  // The card is the machine's NEXT service. Logging a service starts a new
  // cycle, so the card goes back to the first column with its new due point;
  // anything else (a rename, a label turning from "due soon" to "overdue")
  // updates the card where it sits. The card's column is only ever written at
  // the start of a cycle, so a card someone moved to "Booked in" stays put.

  const MAINT = 'maintenance';
  let maintTimer = null;
  // The machines have come from the server at least once. On a fresh phone
  // the first answer is the empty local cache, and a sync run on that would
  // take every card for a machine "no longer there" off the board.
  let gearLoaded = false;

  function dueKey(g) { return [g.dueDate || '', g.dueHours != null ? g.dueHours : '', g.dueMiles != null ? g.dueMiles : ''].join('|'); }
  function hasDue(g) { return !!(g.dueDate || g.dueHours != null || g.dueMiles != null); }

  // Absolute wording ("by Oct 15", "at 250 hours") rather than "due in 5 days",
  // which would change every day and rewrite every card daily for nothing.
  function dueWords(g) {
    const bits = [];
    if (g.dueDate) bits.push('by ' + shortDate(g.dueDate));
    if (g.dueHours != null) bits.push('at ' + round1(g.dueHours) + ' hours');
    if (g.dueMiles != null) bits.push('at ' + fmtNum(g.dueMiles) + ' miles');
    return bits.join(' or ');
  }

  function scheduleMaintSync() {
    clearTimeout(maintTimer);
    maintTimer = setTimeout(syncMaintenance, 400);
  }

  function syncMaintenance() {
    // Only once the boards have actually loaded from the server -- deciding
    // "there is no Maintenance board" from an empty first read would make one
    // over the top of the real one.
    // Whoever runs both the machines and the boards keeps the Maintenance
    // board in step: the owner, or an admin who may change both. Card ids are
    // fixed, so two devices doing it at once write the same cards.
    const runs = isOwner() || (ydCan('equipment', 'change') && ydCan('boards', 'change'));
    if (!runs || !window.YDDb || !window.YDBoards || !YDBoards.ready() || !gearLoaded) return;
    const board = YDBoards.boards()[MAINT];
    if (!board) {
      const rec = {
        name: 'Maintenance', color: '#8a6d3b', order: 3, visibleTo: [],
        columns: [{ id: 'm0', name: 'Due' }, { id: 'm1', name: 'Booked in' }, { id: 'm2', name: 'Done' }],
        labels: [{ id: 'overdue', name: 'Overdue', color: '#d64545' },
                 { id: 'soon', name: 'Due soon', color: '#e0a526' }],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      Promise.resolve(window.YDDb.put('boards', MAINT, rec))
        .catch(e => console.warn('[equipment] maintenance board not yet saved:', e.code || e.message));
      // The cards are made once its card list has answered, which the new
      // board's arrival sets going -- and which runs this again.
      return;
    }
    // The same for the cards: until the server has answered, a missing card
    // may only be missing from the cache. Taking that as "no card" put every
    // problem back in the first column -- including one the crew had just
    // moved to Done, so it was never recorded as fixed.
    if (!YDBoards.cardsReady || !YDBoards.cardsReady(MAINT)) return;
    const first = board.columns[0].id;
    const lastCol = board.columns[board.columns.length - 1].id;
    const have = (YDBoards.cards()[MAINT]) || {};
    const path = 'boards/' + MAINT + '/cards';

    // Cards made here, and cards this sync moves, go to the bottom of the
    // column they land in. With no order at all they tied at 0 and sat in
    // whatever order the database handed them back.
    const tail = {};
    const endOf = col => {
      if (tail[col] == null) {
        const inCol = Object.values(have).filter(k => (k.column || first) === col);
        tail[col] = inCol.length ? Math.max.apply(null, inCol.map(k => k.order || 0)) : 0;
      }
      tail[col] += 1000;
      return tail[col];
    };
    const placed = (k, patch) => {
      if (patch.column && (!k || k.column !== patch.column)) patch.order = endOf(patch.column);
      return patch;
    };

    // The urgency labels have to exist on the board for its cards to show
    // them. Added if missing; any the owner already renamed or recoloured
    // are left alone.
    const labelIds = new Set((board.labels || []).map(l => l.id));
    const missing = URGENCY.filter(u => !labelIds.has('u-' + u.id))
      .map(u => ({ id: 'u-' + u.id, name: u.label, color: u.color }))
      .concat(labelIds.has(PART_LABEL.id) ? [] : [PART_LABEL]);
    if (missing.length) {
      board.labels = (board.labels || []).concat(missing);
      Promise.resolve(window.YDDb.put('boards', MAINT, { labels: board.labels }))
        .catch(e => console.warn('[equipment] labels not yet saved:', e.code || e.message));
    }

    // Problems noted on machines: one card each.
    const wanted = new Set();
    Object.values(gear).forEach(g => {
      (g.issues || []).forEach(i => {
        const id = 'eqi-' + g.id + '-' + i.id;
        wanted.add(id);
        const k = have[id];
        // Moved to the last column on the board (by anyone it is shared with)
        // while still open on the machine: someone fixed it. Record that on
        // the machine, which is the record that counts.
        if (k && !i.doneAt && k.column === lastCol && k.doneAt) {
          setIssueDone(g, i.id, true);
          return;
        }
        // And the other way: a person moved it back out of Done after it was
        // marked fixed -- it is not fixed after all. Without this the card
        // was put straight back in Done (the machine still said fixed), so a
        // problem ticked off by mistake could never be reopened from the
        // board. Only a move made after the fix counts, so marking it fixed
        // on the machine still sends the card to Done.
        if (k && i.doneAt && k.column !== lastCol && k.updatedBy !== 'Equipment' &&
            String(k.updatedAt || '') > String(i.doneAt)) {
          setIssueDone(g, i.id, false);
          return;
        }
        const u = urgencyOf(i.urgency);
        const want = {
          title: (g.name || 'Machine') + ' — ' + i.what,
          due: null,
          notes: u.label + ' (' + u.hint + ').' + (i.partAtShop ? ' The part is at the shop.' : '') +
            (i.note ? '\n\n' + i.note : '') +
            '\n\nNoted ' + shortDate(i.at) + (i.by ? ' by ' + i.by : '') + '.',
          labels: ['u-' + u.id].concat(i.partAtShop ? [PART_LABEL.id] : []),
          equipmentId: g.id, issueId: i.id, auto: true,
        };
        const doneNow = !!i.doneAt;
        const same = k && k.title === want.title && k.notes === want.notes &&
          JSON.stringify(k.labels || []) === JSON.stringify(want.labels) &&
          (doneNow ? k.column === lastCol : k.column !== lastCol);
        if (same) return;
        const patch = Object.assign({}, want, { updatedAt: new Date().toISOString(), updatedBy: 'Equipment' });
        if (!k) { patch.createdAt = new Date().toISOString(); patch.column = doneNow ? lastCol : first; }
        if (doneNow && (!k || k.column !== lastCol)) { patch.column = lastCol; patch.doneAt = i.doneAt; }
        // Reopened on the machine: back out of Done.
        if (!doneNow && k && k.column === lastCol) { patch.column = first; patch.doneAt = null; }
        Promise.resolve(window.YDDb.put(path, id, placed(k, patch)))
          .catch(e => console.warn('[equipment] card not yet saved:', e.code || e.message));
      });
    });
    // A problem deleted from the machine takes its card with it.
    Object.keys(have).forEach(id => {
      if (id.indexOf('eqi-') === 0 && !wanted.has(id)) {
        Promise.resolve(window.YDDb.remove(path, id)).catch(() => {});
      }
    });

    Object.values(gear).forEach(g => {
      const id = 'eq-' + g.id;
      const k = have[id];
      if (!hasDue(g)) {
        if (k) Promise.resolve(window.YDDb.remove(path, id)).catch(() => {});
        return;
      }
      const state = due(g).state;
      const want = {
        title: (g.name || 'Machine') + ' — service due',
        due: g.dueDate || null,
        notes: 'Next service ' + dueWords(g) + '.' +
          (g.notes ? '\n\n' + g.notes : '') +
          '\n\nLog the service on the Equipment tab and this card resets itself for the next one.',
        labels: state === 'overdue' ? ['overdue'] : state === 'soon' ? ['soon'] : [],
        equipmentId: g.id,
        dueKey: dueKey(g),
        auto: true,
      };
      const newCycle = !k || k.dueKey !== want.dueKey;
      const same = k && !newCycle && k.title === want.title && k.due === want.due &&
        k.notes === want.notes && JSON.stringify(k.labels || []) === JSON.stringify(want.labels);
      if (same) return;
      const patch = Object.assign({}, want, { updatedAt: new Date().toISOString(), updatedBy: 'Equipment' });
      // A known card whose due point moved has been serviced: back to the start.
      if (k && newCycle) { patch.column = first; patch.doneAt = null; }
      if (!k) { patch.createdAt = new Date().toISOString(); patch.column = first; }
      Promise.resolve(window.YDDb.put(path, id, placed(k, patch)))
        .catch(e => console.warn('[equipment] card not yet saved:', e.code || e.message));
    });

    // Cards for machines that have been removed.
    Object.keys(have).forEach(id => {
      const k = have[id];
      if (k.auto && k.equipmentId && !gear[k.equipmentId]) {
        Promise.resolve(window.YDDb.remove(path, id)).catch(() => {});
      }
    });
  }

  document.addEventListener('yd-boards-ready', scheduleMaintSync);
  // The Maintenance cards themselves arrive a moment after the boards do;
  // checking again then is what lets a removed machine's card be cleared.
  document.addEventListener('yd-cards-changed', () => { if (YDBoards.boards()[MAINT]) scheduleMaintSync(); });

  window.YDEquipment = {
    all: () => gear,
    overdue: () => Object.values(gear).filter(g => due(g).state === 'overdue'),
    render: () => renderEquipment(),
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const sees = on && ydCan('equipment', 'see');
    const tab = el('tabEquipment');
    if (tab) tab.hidden = !sees;
    // Looking without changing: every editing control is hidden.
    document.documentElement.toggleAttribute('data-equipment-readonly', sees && !ydCan('equipment', 'change'));
    if (sees) start();
    else if (unsub) {
      // Access taken away (or signed out): stop listening, and nothing of
      // the machines stays on this device's screen.
      try { unsub(); } catch (err) {}
      unsub = null; gear = {}; gearLoaded = false;
      renderEquipment();
    }
  });

  function boot() { renderEquipment(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
