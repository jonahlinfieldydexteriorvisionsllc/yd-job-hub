// Paychecks -- on the Clock tab, under Hours & Wages.
//
// Jonah pays the crew by person-to-person payment from the business's
// Heartland Bank account. The server reads those bank emails along with the
// receipts (functions/receipts.py) and files each payment in paychecks/{id}:
// who it went to (as the bank wrote the name, and the crew member that name
// matched), how much, the date and the bank's confirmation number. Only mail
// from the receipts start date on is read.
//
// Here they are listed and added up per person for the week or month, and a
// payment whose name matched nobody (or the wrong person) can be pointed at
// the right one. Pay is Hours, like pay rates: the owner, and admins given
// Hours. Only the owner deletes.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const money = c => fmtMoney((Number(c) || 0) / 100);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const sees = () => typeof ydCan === 'function' && ydCan('hours', 'see');
  const changes = () => typeof ydCan === 'function' && ydCan('hours', 'change');
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);

  let checks = {};            // id -> paycheck
  let people = {};            // uid -> user record, for names
  let unsubs = [];
  let loaded = false;
  let range = 'month';

  const RANGES = { week: 'This week', lastweek: 'Last week', month: 'This month', all: 'All time' };

  // The same weeks as Hours & Wages: Sunday to Saturday.
  function rangeStart(which) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (which === 'week' || which === 'lastweek') {
      d.setDate(d.getDate() - d.getDay());
      if (which === 'lastweek') d.setDate(d.getDate() - 7);
    } else if (which === 'month') {
      d.setDate(1);
    } else return 0;
    return d.getTime();
  }
  function inRange(p) {
    const t = Date.parse((p.date || '') + 'T12:00:00');
    if (isNaN(t)) return range === 'all';
    const from = rangeStart(range), to = range === 'lastweek' ? rangeStart('week') : Infinity;
    return t >= from && t < to;
  }

  function crew() {
    return Object.keys(people)
      .map(uid => Object.assign({ uid }, people[uid]))
      .filter(u => u.active && ['crew', 'admin', 'owner'].indexOf(u.role) !== -1 && u.name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  function nameOf(p) {
    return (p.uid && people[p.uid] && people[p.uid].name) || p.payee || 'Unknown';
  }

  // ------------------------------------------------------------ actions

  function write(id, data) {
    data.updatedAt = new Date().toISOString();
    data.updatedBy = (me() || {}).uid || '';
    Promise.resolve(window.YDDb.put('paychecks', id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[paychecks] not yet on the server:', (e && e.code) || e);
    });
  }

  window.payPick = function (id, uid) {
    if (!checks[id] || !changes()) return;
    checks[id] = Object.assign({}, checks[id], { uid: uid || '' });
    write(id, { uid: uid || '' });
    render();
  };

  window.payDelete = function (id) {
    const p = checks[id];
    if (!p || !owner()) return;
    if (!confirm('Delete the ' + money(p.cents) + ' payment to ' + nameOf(p) + ' from the hub?')) return;
    delete checks[id];
    Promise.resolve(window.YDDb.remove('paychecks', id))
      .catch(e => console.warn('[paychecks] not deleted:', (e && e.code) || e));
    render();
  };

  window.payRange = function (r) {
    if (RANGES[r]) { range = r; render(); }
  };

  // ------------------------------------------------------------ drawing

  function render() {
    const sec = el('paySection');
    if (!sec) return;
    const on = !!(window.YDAuth && window.YDAuth.mode === 'cloud' && me()) && sees();
    sec.hidden = !on;
    if (!on) return;

    const list = Object.keys(checks).map(id => Object.assign({ id }, checks[id])).filter(inRange)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const byPerson = {};
    list.forEach(p => {
      const n = nameOf(p);
      byPerson[n] = byPerson[n] || { cents: 0, count: 0 };
      byPerson[n].cents += p.cents || 0;
      byPerson[n].count++;
    });
    const total = list.reduce((s, p) => s + (p.cents || 0), 0);
    el('payBadge').textContent = list.length ? money(total) : '';

    const people_ = crew();
    el('payWrap').innerHTML =
      '<div class="filter-bar">' + Object.keys(RANGES).map(r =>
        '<button class="btn btn-sm' + (range === r ? ' btn-filled' : '') + '" onclick="payRange(\'' + r + '\')">' +
        RANGES[r] + '</button>').join('') + '</div>' +
      (!loaded ? '<p class="empty-msg">Loading paychecks…</p>'
        : !list.length ? '<p class="empty-msg">No paychecks ' + (range === 'all' ? 'yet' : 'in this range') +
          '. Payments sent from the bank to the crew show up here by themselves.</p>'
        : '<div class="dash-totals">' + Object.keys(byPerson).sort().map(n =>
            '<div class="summary-card"><div class="summary-label">' + esc(n) + '</div>' +
            '<div class="summary-value">' + money(byPerson[n].cents) + '</div>' +
            '<div class="summary-sub">' + byPerson[n].count + ' payment' + (byPerson[n].count === 1 ? '' : 's') +
            '</div></div>').join('') + '</div>' +
          list.map(p => {
            const id = safeId(p.id);
            const unmatched = !p.uid || !people[p.uid];
            return '<div class="rc-row">' +
              '<span class="rc-row-main"><b>' + esc(nameOf(p)) + '</b> ' +
                '<span class="muted">' + fmtDateMD(p.date) + ' · ' + esc(p.bank || 'Bank') +
                (p.confirmation ? ' · #' + esc(p.confirmation) : '') +
                (p.payee && p.payee.toLowerCase() !== nameOf(p).toLowerCase()
                  ? ' · sent to "' + esc(p.payee) + '"' : '') + '</span>' +
                (unmatched ? ' <span class="rc-tag rc-owed">Who is this?</span>' : '') + '</span>' +
              '<span class="rc-row-amt">' + money(p.cents) + '</span>' +
              (changes() ? '<select class="rc-skip" onchange="payPick(\'' + id + '\', this.value)">' +
                '<option value="">' + (unmatched ? 'Pick the crew member…' : 'Someone else…') + '</option>' +
                people_.map(u => '<option value="' + safeId(u.uid) + '"' + (u.uid === p.uid ? ' selected' : '') + '>' +
                  esc(u.name) + '</option>').join('') + '</select>' : '') +
              (p.link ? '<a class="btn btn-sm" href="' + esc(p.link) + '" target="_blank" rel="noopener">Email</a>' : '') +
              (owner() ? '<button class="btn btn-sm rc-del" onclick="payDelete(\'' + id + '\')" title="Delete">🗑</button>' : '') +
            '</div>';
          }).join(''));
  }

  // ------------------------------------------------------------ data

  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; checks = {}; people = {}; loaded = false;
  }
  function start() {
    stop();
    unsubs.push(window.YDDb.watch('paychecks', (list, meta) => {
      list.forEach(c => { if (c.type === 'removed') delete checks[c.id]; else checks[c.id] = c.data; });
      if (meta && meta.fromCache === false) loaded = true;
      render();
    }, () => { loaded = true; render(); }));
    // Names: owner and admins may read the user records.
    unsubs.push(window.YDDb.watch('users', list => {
      list.forEach(c => { if (c.type === 'removed') delete people[c.id]; else people[c.id] = c.data; });
      render();
    }, () => {}));
  }

  window.YDPaychecks = { render: render };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user && sees();
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) {
      authKey = k;
      if (on && window.YDDb) start(); else stop();
    }
    render();
  });
})();
