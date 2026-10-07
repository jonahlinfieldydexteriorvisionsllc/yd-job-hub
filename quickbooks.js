// QuickBooks, from the app's side.
//
// Everything secret is on the server; this file only ever talks to it with the
// owner's Firebase sign-in token. It does three jobs:
//
//   CONNECT   hand the owner to Intuit and notice when they come back
//   MATCH     say which QuickBooks customer each snow account is, and which
//             product each kind of line is
//   SEND      raise the invoices for a closed storm
//
// THE MATCHING IS THE PART THAT MATTERS. QuickBooks identifies a customer by
// an internal id, not by name, so an invoice cannot be raised until each snow
// account has been pointed at one. Names are matched automatically where they
// are obviously the same, but every match is shown and can be changed, because
// an invoice raised against the wrong customer is worse than one not raised.
//
// Nothing here guesses an invoice number. QuickBooks assigns it and hands it
// back, and that number is written onto the storm.

(function () {
  'use strict';

  const MAP_DOC = 'quickbooksMap';
  const LINE_KINDS = [
    ['plow', 'Snow removal', 'The plowing line'],
    ['salt', 'Salt', 'The salt line, where salt is part of the rate'],
    ['labor', 'Labor', 'The hourly line'],
  ];

  let state = null;        // last status from the server
  let customers = [];
  let items = [];
  let map = { customers: {}, items: {} };
  let busy = false;

  const el = id => document.getElementById(id);
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  // Sending storms to QuickBooks is billing: the owner, or an admin who may
  // change billing. Connecting and disconnecting stay the owner's alone.
  const sends = () => ydCan('billing', 'change');
  const endpoint = () => ((window.YD_CONFIG || {}).claudeEndpoint || '').replace(/\/+$/, '');

  // ------------------------------------------------------------ the server

  async function ask(path, body) {
    const user = window.YDAuth && window.YDAuth.user;
    if (!user) throw new Error('Not signed in');
    if (!endpoint()) throw new Error('The server address is not configured');
    const token = await user.getIdToken();
    const res = await fetch(endpoint() + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ('QuickBooks request failed (' + res.status + ')'));
      err.reconnect = !!data.reconnect;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------- the screen

  window.openQuickBooks = function () {
    const m = el('qbModal');
    if (m) m.classList.add('active');
    render();
    refresh();
  };
  window.closeQuickBooks = function () {
    const m = el('qbModal');
    if (m) m.classList.remove('active');
  };

  async function refresh() {
    if (!sends()) return;
    busy = true; render();
    try {
      state = await ask('/qb/status');
      if (state.connected) {
        await loadMap();
        const [c, i] = await Promise.all([
          ask('/qb/customers').catch(() => ({ customers: [] })),
          ask('/qb/items').catch(() => ({ items: [] })),
        ]);
        customers = c.customers || [];
        items = i.items || [];
        autoMatch();
      }
    } catch (e) {
      state = { connected: false, error: e.message, env: state && state.env };
    }
    busy = false;
    render();
  }

  async function loadMap() {
    try {
      map = (await window.YDDb.get('settings', MAP_DOC)) || { customers: {}, items: {} };
    } catch (e) { map = { customers: {}, items: {} }; }
    map.customers = map.customers || {};
    map.items = map.items || {};
  }

  function saveMap() {
    return Promise.resolve(window.YDDb.put('settings', MAP_DOC, map))
      .catch(e => console.warn('[qb] mapping not saved:', e.code || e.message));
  }

  // Names that are obviously the same are matched without being asked about.
  // Anything less than obvious is left blank rather than guessed, because a
  // wrong match means an invoice raised against the wrong customer.
  function tidy(s) {
    return String(s || '').toLowerCase()
      // Dashes of every kind become spaces. The same customer is written
      // "Acme - O'Brien" in QuickBooks and "Acme — O'Brien" here, and treating
      // those as different names would leave an obvious match unmade.
      .replace(/[‐-―−-]/g, ' ')
      .replace(/[.,'‘’“”]/g, '')
      .replace(/\b(llc|inc|ltd|co|company|and|&)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // A name two QuickBooks customers share is no match at all: which of them
  // is not obvious. A match Jonah cleared by hand is stored as false and never
  // guessed again; one never set is missing (or null).
  function byTidyName(list) {
    const out = {}, twice = {};
    list.forEach(o => { const k = tidy(o.name); if (k in out) twice[k] = true; else out[k] = o.id; });
    Object.keys(twice).forEach(k => { delete out[k]; });
    return out;
  }
  const unset = v => v === undefined || v === null;
  function autoMatch() {
    const accounts = (window.YDSnow && YDSnow.accounts()) || {};
    const byName = byTidyName(customers);
    let added = 0;
    Object.keys(accounts).forEach(id => {
      if (!unset(map.customers[id])) return;
      const hit = byName[tidy(accounts[id].name)];
      if (hit) { map.customers[id] = hit; added++; }
    });
    const byItem = byTidyName(items);
    LINE_KINDS.forEach(([key, label]) => {
      if (!unset(map.items[key])) return;
      const hit = byItem[tidy(label)] || byItem[tidy(key)];
      if (hit) { map.items[key] = hit; added++; }
    });
    if (added) saveMap();
  }

  // Cleared is written as false, not left out: the map is saved by merging,
  // so a key left out kept the old match -- and the next send raised the
  // invoice against the customer that had just been unpicked.
  window.setQbCustomer = function (accountId, customerId) {
    map.customers[accountId] = customerId || false;
    saveMap(); render();
  };
  window.setQbItem = function (key, itemId) {
    map.items[key] = itemId || false;
    saveMap(); render();
  };

  window.connectQuickBooks = async function () {
    try {
      const { url } = await ask('/qb/connect-url');
      // A full navigation, not a popup: Intuit's consent screen refuses to run
      // in one, and a phone handles a redirect far better anyway.
      window.location.href = url;
    } catch (e) {
      showToast(e.message);
    }
  };

  window.disconnectQuickBooks = async function () {
    if (!confirm('Disconnect QuickBooks?\n\nNothing already in QuickBooks changes. ' +
                 'Snow billing goes back to being exported as a file.')) return;
    try { await ask('/qb/disconnect'); showToast('Disconnected'); }
    catch (e) { showToast(e.message); }
    refresh();
  };

  function render() {
    const wrap = el('qbBody');
    if (!wrap) return;

    if (busy && !state) { wrap.innerHTML = '<p class="empty-msg">Checking…</p>'; return; }
    if (!state) { wrap.innerHTML = '<p class="empty-msg">Not checked yet.</p>'; return; }

    if (!state.connected) {
      wrap.innerHTML =
        '<div class="qb-intro">' +
          '<p>Connecting QuickBooks lets Job Hub raise the invoices for a storm ' +
          'directly, instead of you exporting a file and importing it. ' +
          'QuickBooks gives each invoice its own number, so the two can never ' +
          'drift apart.</p>' +
          (state.env === 'sandbox'
            ? '<div class="qb-note">This is pointed at a <strong>practice company</strong>, ' +
              'not your real books. Nothing here can touch your accounts.</div>' : '') +
          (state.error ? '<div class="qb-warn">' + esc(state.error) + '</div>' : '') +
          // Connecting is the owner's alone (the server refuses anyone else).
          (window.YDAuth && YDAuth.isOwner
            ? '<button class="btn btn-filled clock-big" onclick="connectQuickBooks()">Connect to QuickBooks</button>'
            : '<p class="hint">Only the owner can connect QuickBooks.</p>') +
        '</div>';
      return;
    }

    const accounts = (window.YDSnow && YDSnow.accounts()) || {};
    const ids = Object.keys(accounts).sort((a, b) =>
      String(accounts[a].name).localeCompare(accounts[b].name));
    const unmatched = ids.filter(id => !map.customers[id]).length;

    wrap.innerHTML =
      '<div class="qb-top">' +
        '<div><div class="qb-co">' + esc(state.company || 'Connected') + '</div>' +
        '<div class="qb-sub">' +
          (state.env === 'sandbox' ? 'Practice company' : 'Live company') +
          (state.refreshedAt ? ' · last checked ' + niceDate(state.refreshedAt) : '') +
        '</div></div>' +
        (window.YDAuth && YDAuth.isOwner ? '<button class="btn btn-sm" onclick="disconnectQuickBooks()">Disconnect</button>' : '') +
      '</div>' +
      (state.warning ? '<div class="qb-warn">' + esc(state.warning) + '</div>' : '') +
      (state.env === 'sandbox'
        ? '<div class="qb-note">A <strong>practice company</strong> — invoices raised ' +
          'here do not appear in your real books.</div>' : '') +

      '<div class="qb-head">What each line is sold as</div>' +
      '<div class="qb-rows">' +
        LINE_KINDS.map(([key, label, hint]) =>
          '<div class="qb-row">' +
            '<div><span class="qb-name">' + label + '</span>' +
            '<span class="qb-hint">' + hint + '</span></div>' +
            pick(items, map.items[key], 'setQbItem(\'' + key + '\', this.value)') +
          '</div>').join('') +
      '</div>' +

      '<div class="qb-head">Which customer each account is' +
        (unmatched ? '<span class="qb-todo">' + unmatched + ' to set</span>' : '') + '</div>' +
      (ids.length
        ? '<div class="qb-rows">' + ids.map(id =>
            '<div class="qb-row' + (map.customers[id] ? '' : ' unset') + '">' +
              '<div><span class="qb-name">' + esc(accounts[id].name) + '</span>' +
              (accounts[id].address ? '<span class="qb-hint">' + esc(accounts[id].address) + '</span>' : '') +
              '</div>' +
              pick(customers, map.customers[id], 'setQbCustomer(\'' + id + '\', this.value)') +
            '</div>').join('') + '</div>'
        : '<p class="empty-msg">No snow accounts yet.</p>') +

      '<div class="hint">Matched by name where the names are obviously the same. ' +
      'Anything else is left blank rather than guessed — an invoice raised against ' +
      'the wrong customer is worse than one not raised.</div>';
  }

  function pick(list, chosen, handler) {
    return '<select class="searchable" onchange="' + handler + '">' +
      '<option value="">— not set —</option>' +
      list.map(o => '<option value="' + esc(o.id) + '"' +
        (String(o.id) === String(chosen) ? ' selected' : '') + '>' +
        esc(o.name) + '</option>').join('') +
    '</select>';
  }

  function niceDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ------------------------------------------------------------- sending

  // Turns a storm's billing into invoices, one per account, and writes back the
  // number QuickBooks gave each one.
  window.sendStormToQuickBooks = async function (stormId) {
    if (!sends()) return;
    if (!state || !state.connected) { openQuickBooks(); return; }
    // The customer matches load when the QuickBooks screen opens, which may
    // not have happened yet this session.
    if (!customers.length) await refresh();
    if (!state || !state.connected) { openQuickBooks(); return; }

    const b = await window.YDDb.get('storms/' + stormId + '/private', 'billing');
    if (!b || !b.lines || !b.lines.length) { showToast('No billing recorded for that storm'); return; }

    const already = b.quickbooks || {};
    const byAccount = {};
    b.lines.forEach(l => { (byAccount[l.accountId] = byAccount[l.accountId] || []).push(l); });

    const accounts = (window.YDSnow && YDSnow.accounts()) || {};
    const todo = Object.keys(byAccount).filter(a => !already[a]);
    const missing = todo.filter(a => !map.customers[a]);
    if (missing.length) {
      showToast(missing.length + ' account' + (missing.length === 1 ? ' is' : 's are') +
                ' not matched to a QuickBooks customer yet');
      openQuickBooks();
      return;
    }
    if (!todo.length) { showToast('Every invoice for that storm is already in QuickBooks'); return; }

    const storm = (window.YDBilling && YDBilling.storms()[stormId]) || {};
    const when = new Date(storm.startedAt || storm.closedAt || Date.now());
    const day = when.getFullYear() + '-' + two(when.getMonth() + 1) + '-' + two(when.getDate());
    const due = new Date(when.getTime() + 30 * 864e5);
    const dueDay = due.getFullYear() + '-' + two(due.getMonth() + 1) + '-' + two(due.getDate());
    const label = when.toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    if (!confirm('Raise ' + todo.length + ' invoice' + (todo.length === 1 ? '' : 's') +
                 ' in QuickBooks for ' + label + '?' +
                 (state.env === 'sandbox' ? '\n\nThis is the practice company.' : ''))) return;

    const done = Object.assign({}, already);
    let made = 0, failed = 0;
    for (const accountId of todo) {
      const lines = [];
      byAccount[accountId].sort((x, y) => x.pass - y.pass).forEach(l => {
        const pass = l.pass > 1 ? ' (pass ' + l.pass + ')' : '';
        if (l.plowCents) {
          lines.push({ description: 'Snow removal ' + label + pass + ' — ' + l.inches + '" cleared',
                       qty: 1, rate: l.plowCents / 100, amount: l.plowCents / 100,
                       itemId: map.items.plow || '' });
        }
        if (l.saltCents) {
          lines.push({ description: 'Salt application' + (l.saltBags ? ' — ' + l.saltBags + ' bags' : ''),
                       qty: 1, rate: l.saltCents / 100, amount: l.saltCents / 100,
                       itemId: map.items.salt || '' });
        }
        if (l.laborCents) {
          const hours = l.manHours != null ? l.manHours
            : Math.round((l.minutes / 60) * (storm.crewSize || 1) * 100) / 100;
          // The rate stored when the storm closed -- the one the customer
          // agreed. Dividing the total back by the hours printed $25.53 on a
          // $25.50 rate for a short visit, on the customer's own invoice. The
          // CSV export already works this way. Storms closed before the rate
          // was stored fall back to the division, which at least keeps
          // quantity times rate equal to the amount.
          const rateCents = l.laborRateCents != null ? l.laborRateCents
            : (hours ? Math.round(l.laborCents / hours) : 0);
          lines.push({ description: 'Labor — ' + l.minutes + ' min on site, ' +
                         (storm.crewSize || 1) + ' crew',
                       qty: hours, rate: rateCents / 100,
                       amount: l.laborCents / 100, itemId: map.items.labor || '' });
        }
      });

      try {
        const res = await ask('/qb/invoice', {
          customerId: map.customers[accountId],
          txnDate: day, dueDate: dueDay,
          memo: 'Snow removal ' + label,
          privateNote: 'Raised from YD Job Hub, storm ' + stormId,
          lines: lines,
          // The same storm and account always send the same key, so if the
          // answer is lost on the way back and this is pressed again, QuickBooks
          // hands back the invoice it already made instead of raising another.
          requestKey: stormId + '/' + accountId,
        });
        // Recorded at once, one at a time, so if the next one fails the ones
        // already raised are not raised twice. Not awaited: the write lands on
        // this device straight away, and waiting for the server stalled the
        // send between invoices on a weak signal -- and a refused write counted
        // an invoice QuickBooks had already made as failed.
        done[accountId] = { id: res.id, number: res.docNumber, at: new Date().toISOString() };
        made++;
        Promise.resolve(window.YDDb.put('storms/' + stormId + '/private', 'billing', { quickbooks: Object.assign({}, done) }))
          .catch(e => {
            console.warn('[qb] invoice record not saved:', e.code || e.message);
            if (e && e.code === 'permission-denied') showToast('Invoice raised, but not recorded on the storm — note its number');
          });
      } catch (e) {
        failed++;
        console.warn('[qb] invoice failed for', accountId, e.message);
        showToast(((accounts[accountId] || {}).name || accountId) + ': ' + e.message);
        // A dead connection: stop, and show the Connect screen with the reason
        // rather than failing every remaining account one by one.
        if (e.reconnect) {
          state = { connected: false, reconnect: true, error: e.message, env: state.env };
          openQuickBooks();
          break;
        }
      }
    }

    if (made) {
      const numbers = todo.map(a => done[a] && done[a].number).filter(Boolean);
      showToast(made + ' invoice' + (made === 1 ? '' : 's') + ' raised' +
        (numbers.length ? ' — ' + numbers.join(', ') : '') +
        (failed ? ', ' + failed + ' failed' : ''));
      if (window.YDBilling) YDBilling.render();
    } else if (failed) {
      showToast('No invoices were raised');
    }
  };

  const two = n => String(n).padStart(2, '0');

  // At sign-in only the status is asked for. That call is what keeps the
  // QuickBooks connection from expiring over a quiet summer, so it has to run;
  // the full customer and item lists are three more round trips over a phone
  // signal and are only needed once the QuickBooks screen is opened.
  async function checkStatus() {
    try { state = await ask('/qb/status'); }
    catch (e) { state = { connected: false, error: e.message }; }
    // The storm list usually draws before this answers; its "Send to
    // QuickBooks" buttons depend on the answer.
    if (window.YDBilling && YDBilling.render) YDBilling.render();
  }

  window.YDQuickBooks = {
    state: () => state,
    connected: () => !!(state && state.connected),
    refresh: refresh,
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const entry = el('menuQuickBooks');
    if (entry) entry.hidden = !(a.isOwner === true);
    // Coming back from Intuit: the page reloads, so look at the connection.
    if (a.mode === 'cloud' && a.user && ydCan('billing', 'change')) {
      checkStatus();
    }
  });
})();
