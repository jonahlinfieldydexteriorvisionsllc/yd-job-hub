// Customers -- one list, tied to QuickBooks, that is also the call list.
//
// Jonah (15 Oct 2026): the Customers tab replaces Contacts. Everyone in
// QuickBooks is here (customers/{QuickBooks id}, kept in step by the server,
// functions/customers.py), old ones under "Past", still callable. People who
// are not customers yet are here too, marked Lead (customers/ld...), until
// their first estimate makes their QuickBooks profile.
//
// Contact details go both ways: a change made here is sent to QuickBooks at
// once (/qb/customer-save), or by the server's next hourly look when there
// was no signal (qbPending). If QuickBooks changed the same thing meanwhile,
// both are kept (qbConflict) and Jonah picks on the customer's page. Tags,
// notes and the time to call live only here -- QuickBooks' API cannot read
// or write its tags.
//
// Everything is tied BY CUSTOMER, never by the spelling of a name: jobs and
// bids carry customerId (customerBy 'auto' | 'hand'), invoices already carry
// QuickBooks' customer id, snow accounts get customerId. The mistakes of
// 15 Oct (a short name vs the same customer's full one, lowercase names,
// duplicate jobs) came from matching by name. What is already there is tied
// once, on "To sort": the sure ones in one tap, the unsure ones listed with
// buttons to pick (manual override always).
//
// Nothing changes until the owner switches the list on (settings/customers
// .importOn): until then this tab is the Contacts screen, as it was.
//
// Who sees it follows the Contacts access area. Money -- prices, invoices,
// what they owe, payments -- only for whoever sees Billing. Crew never.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const s = v => String(v == null ? '' : v).trim();
  const low = v => s(v).toLowerCase().replace(/\s+/g, ' ');
  const digits = v => String(v || '').replace(/\D/g, '').slice(-10);
  const sid = v => (typeof safeId === 'function' ? safeId(v) : String(v || '').replace(/[^A-Za-z0-9_-]/g, ''));
  const can = (area, lvl) => typeof ydCan === 'function' && ydCan(area, lvl);
  const VIEW_KEY = 'ydjobhub_custView';
  const SHOW_STEP = 150;          // rows drawn at a time in a long list

  let conf = { importOn: false, pastYears: 2 };
  let confRead = false;
  let customers = {};             // id -> record (merged-away leads left out)
  let merged = {};                // lead id -> the customer it became
  let loaded = false;
  let unsub = null;
  let view = 'call';
  let showN = SHOW_STEP;
  let openId = null;              // the customer whose page is open
  let editing = false;            // the contact form is open on it
  const drafts = {};              // customer id -> a dated note being written
  const sortPick = {};            // To sort: "kind:id" -> customer id picked (or 'lead' / 'skip')

  try { view = localStorage.getItem(VIEW_KEY) || 'call'; } catch (e) { /* private window */ }

  const isOn = () => confRead && conf.importOn === true && can('contacts', 'see');
  const isQb = c => !!(c && c.qbCustomerId);

  // ------------------------------------------------------------ what they are
  //
  // Lead: no QuickBooks profile yet. Past: switched off in QuickBooks, or
  // nothing worked or bid for them in `pastYears` (settings/customers, 2 by
  // default) -- going by QuickBooks' own invoices, estimates and sales
  // receipts (lastWorkAt), the day the profile was made, and their jobs here.
  // Jonah can say otherwise on their page (kindByHand), which always wins.
  function lastActivity(c) {
    let best = s(c.lastWorkAt).slice(0, 10);
    const made = s(c.qbCreatedAt).slice(0, 10);
    if (made > best) best = made;
    jobsOf(c.id).forEach(j => {
      const d = s(j.quoteDate || j.completedAt || j.lastModified).slice(0, 10);
      if (d > best) best = d;
    });
    return best;
  }
  function kindOf(c) {
    if (!isQb(c)) return 'lead';
    if (c.kindByHand === 'customer' || c.kindByHand === 'past') return c.kindByHand;
    if (c.qbActive === false) return 'past';
    const last = lastActivity(c);
    if (!last) return 'past';
    const cut = new Date();
    cut.setFullYear(cut.getFullYear() - (Number(conf.pastYears) > 0 ? Number(conf.pastYears) : 2));
    return last < ymd(cut) ? 'past' : 'customer';
  }
  const KIND_WORD = { lead: 'Lead', customer: 'Customer', past: 'Past customer' };

  // ------------------------------------------------------------ when to call
  //
  // Jonah can rarely name a day: "usually its a season or within a couple
  // months". So the time to call is a window -- from, to -- and the call list
  // shows someone once theirs has opened. Stored as when {from, to, label}
  // when picked that way (the picker waits on his say -- see the report of
  // 15 Oct); until then it is read out of the words typed in contactWhen,
  // which still works as it always did.
  const two = n => String(n).padStart(2, '0');
  function ymd(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  const today = () => ymd(new Date());
  const lastDay = (y, m) => ymd(new Date(y, m, 0));        // m 1-12
  const SEASON = { spring: [3, 5], summer: [6, 8], fall: [9, 11], autumn: [9, 11], winter: [12, 2] };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;
  const SEASON_RE = /\b(spring|summer|fall|autumn|winter)\b/;
  const validDay = v => /^\d{4}-\d{2}-\d{2}$/.test(s(v));

  function windowFromText(text) {
    const t = low(text);
    if (!t) return null;
    const ym = t.match(/\b((?:19|20)\d{2})\b/);
    const now = new Date();
    const thisYear = now.getFullYear(), thisMonth = now.getMonth() + 1;
    // A month as a number: 2027-04, 4/2027, 4/15/2027.
    const iso = t.match(/\b(?:19|20)\d{2}[-\/](\d{1,2})\b/);
    const slash = t.match(/\b(\d{1,2})[-\/](?:\d{1,2}[-\/])?(?:19|20)\d{2}\b/);
    let m = iso ? +iso[1] : slash ? +slash[1] : 0;
    if (m < 1 || m > 12) m = 0;
    const name = t.match(MONTH_RE), season = t.match(SEASON_RE);
    let y = ym ? +ym[1] : 0;
    if (!m && name) m = MONTHS.indexOf(name[1].slice(0, 3)) + 1;
    if (m) {
      // No year: the next time that month comes round (this one if we are in it).
      if (!y) y = m >= thisMonth ? thisYear : thisYear + 1;
      return { from: y + '-' + two(m) + '-01', to: lastDay(y, m), label: s(text) };
    }
    if (season) {
      const [a, b] = SEASON[season[1]];
      // No year: this one if we are in it or before it, else next year's.
      // Winter runs Dec-Feb: January and February belong to last December's.
      if (!y) {
        if (a <= b) y = thisMonth <= b ? thisYear : thisYear + 1;
        else y = thisMonth <= b ? thisYear - 1 : thisYear;
      }
      return { from: y + '-' + two(a) + '-01', to: a > b ? lastDay(y + 1, b) : lastDay(y, b), label: s(text) };
    }
    if (y) return { from: y + '-01-01', to: y + '-12-31', label: s(text) };
    return null;
  }
  function windowOf(c) {
    const w = c.when;
    if (w && validDay(w.from) && validDay(w.to || w.from)) return { from: w.from, to: w.to || w.from, label: s(w.label) || s(c.contactWhen) };
    return windowFromText(c.contactWhen);
  }
  function niceDay(d) {
    return validDay(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  function windowWords(w) {
    if (!w) return '';
    return w.from === w.to ? niceDay(w.from) : niceDay(w.from) + ' – ' + niceDay(w.to);
  }
  // Reached since their window opened -- and since the time to call was last
  // changed (a new "call me in the fall" written after the call is a new
  // reason to call).
  function reachedFor(c, w) {
    const at = s(c.reachedAt);
    if (!at || isNaN(new Date(at))) return false;
    if (at.slice(0, 10) < w.from) return false;
    return !(c.whenSetAt && s(c.whenSetAt) > at);
  }
  function callState(c) {
    if (c.notInterested) return { on: false };
    const w = windowOf(c);
    if (!w) return { on: false, none: true };
    const t = today();
    if (w.from > t) return { on: false, soon: w.from, w: w };
    if (reachedFor(c, w)) return { on: false, done: true, w: w };
    return { on: true, w: w };
  }

  // ------------------------------------------------------------ their jobs, invoices, snow
  function allJobs() {
    if (!can('jobs', 'see') || typeof loadAllJobs !== 'function') return [];
    try { return loadAllJobs() || []; } catch (e) { return []; }
  }
  const resolve = id => merged[id] || id;
  // Customer id -> their jobs, worked out once per redraw (every customer's
  // "Past" line asks, and there are some five hundred).
  let jobMap = null;
  function jobsOf(id) {
    if (!jobMap) {
      jobMap = {};
      allJobs().forEach(j => { if (j.customerId && !j.removeWhy) (jobMap[resolve(j.customerId)] = jobMap[resolve(j.customerId)] || []).push(j); });
    }
    return jobMap[id] || [];
  }
  function invoicesOf(c, jobs) {
    if (!can('billing', 'see') || !window.YDInvoices) return [];
    const ids = {};
    (jobs || []).forEach(j => { ids[j._id] = true; });
    return Object.values(YDInvoices.all() || {}).filter(inv =>
      (c.qbCustomerId && s(inv.customerId) === s(c.qbCustomerId)) || (inv.jobId && ids[inv.jobId]));
  }
  function snowOf(id) {
    if (!can('snow', 'see') || !window.YDSnow) return [];
    const acc = YDSnow.accounts() || {};
    return Object.keys(acc).filter(k => acc[k] && resolve(acc[k].customerId) === id).map(k => Object.assign({ id: k }, acc[k]));
  }
  const money = n => (typeof fmtMoney === 'function' ? fmtMoney(n) : '$' + (Number(n) || 0).toFixed(2));

  // ------------------------------------------------------------ the list
  function render() {
    jobMap = null;
    applyOn();
    const wrap = el('custWrap');
    if (!wrap) return;
    if (!isOn()) { wrap.innerHTML = ''; renderOff(); return; }
    renderOff();
    if (!loaded) { wrap.innerHTML = '<p class="empty-msg">Loading the customer list…</p>'; return; }
    if (!Object.values(customers).some(isQb)) {
      wrap.innerHTML = '<p class="empty-msg">Waiting for the first read of your customers from QuickBooks — it happens at the next hourly look. ' +
        'Your Contacts list is below until then.</p>';
      return;
    }
    // Something being typed (a search, a note) keeps its place.
    const typing = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.id : null;
    const all = Object.values(customers);
    const counts = { call: 0, customers: 0, leads: 0, past: 0, sort: sortCount() };
    all.forEach(c => {
      const k = kindOf(c);
      if (k === 'lead') counts.leads++; else if (k === 'past') counts.past++; else counts.customers++;
      if (callState(c).on) counts.call++;
    });
    const badge = el('custBadge');
    if (badge) badge.textContent = counts.call ? counts.call + ' to call' : '';
    const VIEWS = [['call', '📞 Call list'], ['customers', '👥 Customers'], ['leads', '🌱 Leads'], ['past', '🕰 Past']]
      .concat(can('contacts', 'change') && counts.sort ? [['sort', '🧩 To sort']] : []);
    if (view === 'sort' && !(can('contacts', 'change') && counts.sort)) view = 'call';
    const q = s((el('custSearch') || {}).value).toLowerCase();
    const tag = s((el('custTag') || {}).value);
    let html = '<div class="cu-views">' + VIEWS.map(([k, label]) =>
      '<button class="cu-view' + (view === k ? ' on' : '') + '" onclick="custView(\'' + k + '\')">' + label +
      '<span class="cu-n">' + counts[k] + '</span></button>').join('') + '</div>';
    if (view !== 'sort') {
      const tags = {};
      all.forEach(c => (c.tags || []).forEach(t => { tags[t] = true; }));
      html += '<div class="cu-find"><input id="custSearch" type="search" placeholder="Search name, phone, street, note…" value="' + esc(q) + '" oninput="custSearchSoon()">' +
        '<select id="custTag" onchange="custRender()"><option value="">Any service</option>' +
        Object.keys(tags).sort().map(t => '<option' + (t === tag ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>' +
        (can('contacts', 'change') ? '<button class="btn btn-sm btn-filled" onclick="custAddLead()">+ Add a lead</button>' : '') + '</div>';
      html += view === 'call' ? callHtml(all, q, tag) : listHtml(all.filter(c => kindOf(c) === { customers: 'customer', leads: 'lead', past: 'past' }[view]), q, tag);
    } else {
      html += sortHtml();
    }
    wrap.innerHTML = html;
    const back = typing && el(typing);
    if (back) { back.focus(); try { back.setSelectionRange(back.value.length, back.value.length); } catch (e) { /* not a text box */ } }
    if (openId) renderPage();
  }

  function matches(c, q, tag) {
    if (tag && (c.tags || []).indexOf(tag) === -1) return false;
    if (!q) return true;
    const hay = [c.name, c.business, c.firstName, c.lastName, c.phone, c.mobile, c.email, c.address, c.note,
      c.contactWhen, (c.tags || []).join(' '), (c.meetings || []).map(m => m.text).join(' ')].join(' ').toLowerCase();
    const qd = q.replace(/\D/g, '');
    return hay.indexOf(q) !== -1 || (qd.length >= 4 && (digits(c.phone).indexOf(qd) !== -1 || digits(c.mobile).indexOf(qd) !== -1));
  }
  const byName = (a, b) => s(a.name).localeCompare(s(b.name));

  function callHtml(all, q, tag) {
    const list = all.filter(c => matches(c, q, tag));
    const due = [], soon = [], noTime = [];
    const month = new Date(); month.setDate(month.getDate() + 30);
    list.forEach(c => {
      const st = callState(c);
      if (st.on) due.push([c, st.w]);
      else if (st.soon && st.soon <= ymd(month)) soon.push([c, st.w]);
      else if (st.none && kindOf(c) === 'lead' && !c.notInterested) noTime.push(c);
    });
    due.sort((a, b) => a[1].from.localeCompare(b[1].from) || byName(a[0], b[0]));
    soon.sort((a, b) => a[1].from.localeCompare(b[1].from) || byName(a[0], b[0]));
    let h = due.length ? due.slice(0, showN).map(([c, w]) => rowHtml(c, w, true)).join('') + more(due.length)
      : '<p class="empty-msg">Nobody’s time to call has come' + (q || tag ? ' among these' : '') + '. 🎉</p>';
    if (soon.length) h += '<div class="cu-sub">Coming up in the next 30 days</div>' + soon.map(([c, w]) => rowHtml(c, w, false)).join('');
    if (noTime.length) h += '<details class="cu-fold"><summary>Leads with no time to call set (' + noTime.length + ')</summary>' +
      noTime.sort(byName).map(c => rowHtml(c, null, false)).join('') + '</details>';
    return h;
  }
  function listHtml(list, q, tag) {
    list = list.filter(c => matches(c, q, tag)).sort(byName);
    if (!list.length) return '<p class="empty-msg">' + (q || tag ? 'Nobody matches that.' : 'Nobody here yet.') + '</p>';
    return list.slice(0, showN).map(c => rowHtml(c, windowOf(c), false)).join('') + more(list.length);
  }
  function more(n) {
    return n > showN ? '<button class="btn btn-sm cu-more" onclick="custMore()">Show ' + Math.min(SHOW_STEP, n - showN) + ' more of ' + (n - showN) + '</button>' : '';
  }
  function telOf(v) { return String(v || '').replace(/[^0-9+]/g, ''); }
  function rowHtml(c, w, callable) {
    const k = kindOf(c), id = sid(c.id);
    const phone = c.phone || c.mobile;
    return '<div class="cu-row">' +
      '<div class="cu-main">' +
        '<button class="cu-name" onclick="openCustomer(\'' + id + '\')">' + esc(c.name || '(no name)') + '</button>' +
        (k !== 'customer' ? ' <span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span>' : '') +
        (w ? ' <span class="pp-when">' + esc(w.label || windowWords(w)) + '</span>' : '') +
        (c.qbConflict ? ' <span class="cu-kind k-warn">Check details</span>' : '') +
        ((c.tags || []).length ? '<div class="pp-svc">' + c.tags.map(t => '<span class="svc-tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
        '<div class="pp-contact">' + [c.address ? esc(c.address) : '',
          phone ? '<a href="tel:' + esc(telOf(phone)) + '">📞 ' + esc(phone) + '</a>' : ''].filter(Boolean).join(' &middot; ') + '</div>' +
      '</div>' +
      (callable && can('contacts', 'change')
        ? '<div class="cu-act"><button class="btn btn-sm btn-filled" onclick="custReached(\'' + id + '\')">✓ Reached out</button></div>' : '') +
    '</div>';
  }

  window.custView = function (v) {
    view = v; showN = SHOW_STEP;
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* private window */ }
    render();
  };
  window.custMore = function () { showN += SHOW_STEP; render(); };
  window.custRender = function () { showN = SHOW_STEP; render(); };
  let searchTimer = null;
  window.custSearchSoon = function () { clearTimeout(searchTimer); searchTimer = setTimeout(window.custRender, 150); };

  // ------------------------------------------------------------ writing
  //
  // Not awaited: Firestore applies a write here at once and settles only when
  // the server answers -- awaiting would freeze the screen with no signal.
  function write(id, data, what) {
    if (!window.YDDb) { showToast('Not saved — the app has not finished connecting'); return; }
    if (!can('contacts', 'change')) { showToast('You can look at customers but not change them'); return; }
    data = Object.assign({}, data, { updatedAt: new Date().toISOString() });
    if (customers[id]) Object.assign(customers[id], data);
    Promise.resolve(window.YDDb.put('customers', id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — this account is not allowed to change ' + what);
      else console.warn('[customers] ' + what + ' not yet on the server:', e && (e.code || e.message));
    });
  }

  window.custReached = function (id) {
    const c = customers[id];
    if (!c) return;
    const before = { reachedAt: c.reachedAt || null };
    write(id, { reachedAt: new Date().toISOString() }, 'reached out');
    render();
    if (typeof showUndo === 'function') showUndo('Reached ' + (c.name || ''), () => { write(id, before, 'reached out'); render(); });
  };

  // ------------------------------------------------------------ a customer's page
  function ensureModal() {
    if (el('custModal')) return;
    const o = document.createElement('div');
    o.className = 'modal-overlay';
    o.id = 'custModal';
    o.innerHTML = '<div class="modal cu-modal"><div class="modal-head"><h2 id="custTitle">Customer</h2>' +
      '<button class="modal-close" onclick="closeCustomer()">&times;</button></div><div class="modal-body" id="custBody"></div></div>';
    o.addEventListener('click', e => { if (e.target === o) window.closeCustomer(); });
    document.body.appendChild(o);
  }
  window.openCustomer = function (id) {
    id = resolve(id);
    if (!customers[id]) return;
    ensureModal();
    openId = id; editing = false;
    renderPage(true);
    el('custModal').classList.add('active');
  };
  window.closeCustomer = function () {
    const o = el('custModal');
    if (o) o.classList.remove('active');
    if (newLeadId && customers[newLeadId] && !customers[newLeadId].name) { delete customers[newLeadId]; render(); }
    newLeadId = null;
    openId = null; editing = false;
  };

  function renderPage(force) {
    const c = customers[openId], body = el('custBody');
    if (!c || !body) return;
    // A note or a form being typed in keeps what is typed (the list redraws
    // under it whenever anyone changes anything) -- unless the redraw is
    // what was asked for (another customer opened, the form saved).
    const act = document.activeElement;
    if (!force && act && body.contains(act) && /^(cuF|cuWhen|cuNote)/.test(act.id || '')) return;
    const k = kindOf(c), ch = can('contacts', 'change');
    el('custTitle').textContent = c.name || '(no name)';
    const id = sid(c.id);
    const phone = c.phone, mob = c.mobile;
    const dir = c.address ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(c.address) : '';
    let h = '<div class="cu-head"><span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span>' +
      (c.business && c.business !== c.name ? ' <span class="muted">' + esc(c.business) + '</span>' : '') +
      (c.qbParentId && c.qbFullName ? ' <span class="muted">' + esc(c.qbFullName.replace(/:/g, ' › ')) + '</span>' : '') + '</div>';
    if (isQb(c) && ch) {
      h += '<div class="cu-counts">Counts as: ' + [['', 'Worked out'], ['customer', 'Customer'], ['past', 'Past customer']].map(([v, w]) =>
        '<button class="cu-chip' + ((c.kindByHand || '') === v ? ' on' : '') + '" onclick="custKind(\'' + id + '\', \'' + v + '\')">' + w + '</button>').join('') +
        (!c.kindByHand ? '<span class="muted"> — ' + (lastActivity(c) ? 'last work or bid ' + esc(niceDay(lastActivity(c))) : 'no work on record') + '</span>' : '') + '</div>';
    }
    // Contact
    h += '<div class="cu-sec"><div class="cu-sec-h">Contact</div>' + syncHtml(c) +
      (editing ? editHtml(c) :
        '<div class="cu-contact">' +
          (phone ? '<a class="btn btn-sm" href="tel:' + esc(telOf(phone)) + '">📞 ' + esc(phone) + '</a>' : '') +
          (mob && mob !== phone ? '<a class="btn btn-sm" href="tel:' + esc(telOf(mob)) + '">📱 ' + esc(mob) + '</a>' : '') +
          (c.email ? '<a class="btn btn-sm" href="mailto:' + esc(c.email) + '">✉️ ' + esc(c.email) + '</a>' : '') +
          (dir ? '<a class="btn btn-sm" target="_blank" rel="noopener" href="' + esc(dir) + '">🧭 Directions</a>' : '') +
        '</div>' +
        (c.address ? '<div class="cu-line">' + esc(c.address) + '</div>' : '<div class="cu-line muted">No address</div>') +
        (c.ship && c.ship.address ? '<div class="cu-line"><span class="muted">Work address:</span> ' + esc(c.ship.address) + '</div>' : '') +
        (ch ? '<button class="link-btn" onclick="custEdit(true)">✎ Change contact details</button>' : '')) +
      '</div>';
    // When to call
    const st = callState(c), w = windowOf(c);
    h += '<div class="cu-sec"><div class="cu-sec-h">When to call</div>' +
      (ch ? '<div class="cu-when"><input id="cuWhen" value="' + esc(c.contactWhen || '') + '" placeholder="e.g. Spring 2027, Sept, early summer" onkeydown="if (event.key === \'Enter\') custSaveWhen(\'' + id + '\')">' +
        '<button class="btn btn-sm" onclick="custSaveWhen(\'' + id + '\')">Save</button></div>'
        : (c.contactWhen ? '<div>' + esc(c.contactWhen) + '</div>' : '')) +
      '<div class="cu-line muted">' + (c.notInterested ? 'Not interested — off the call list.'
        : w ? 'On the call list ' + esc(windowWords(w)) + (st.done ? ' · ✓ reached ' + esc(niceDay(s(c.reachedAt).slice(0, 10))) : st.on ? ' · due now' : '')
        : c.contactWhen ? 'Can’t tell when from that — write a month, a season or a year.' : 'No time to call set.') + '</div>' +
      (ch ? '<div class="cu-btns">' +
        (st.on ? '<button class="btn btn-sm btn-filled" onclick="custReached(\'' + id + '\')">✓ Reached out</button>' : '') +
        '<button class="btn btn-sm" onclick="custNotInterested(\'' + id + '\', ' + (!c.notInterested) + ')">' + (c.notInterested ? 'Back on the call list' : 'Not interested') + '</button></div>' : '') +
      '</div>';
    // Tags
    h += '<div class="cu-sec"><div class="cu-sec-h">What for</div><div class="pp-svc">' +
      ((c.tags || []).length ? c.tags.map((t, i) => '<span class="svc-tag">' + esc(t) +
        (ch ? '<button onclick="custTagOff(\'' + id + '\', ' + i + ')" title="Remove">&times;</button>' : '') + '</span>').join('') : '<span class="tag-none">No services yet</span>') +
      '</div>' + (ch ? '<select id="cuTagPick" class="tag-pick" onchange="custTagOn(\'' + id + '\', this.value)">' + tagOptions() + '</select>' : '') + '</div>';
    // Notes
    const meets = (c.meetings || []).slice().sort((a, b) => s(b.at).localeCompare(s(a.at)));
    h += '<div class="cu-sec"><div class="cu-sec-h">Notes</div>' +
      (c.note ? '<div class="pp-note">' + esc(c.note) + '</div>' : '') +
      (ch ? '<textarea id="cuNote_' + id + '" rows="3" placeholder="What you talked about, what they want…" oninput="custNoteDraft(\'' + id + '\', this.value)">' + esc(drafts[c.id] || '') + '</textarea>' +
        '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="custSaveNote(\'' + id + '\')">Save note</button></div>' : '') +
      meets.map(m => '<div class="pp-meet-item"><div class="pp-meet-when">' + esc(niceDay(s(m.at).slice(0, 10))) + '</div><div class="pp-meet-text">' + esc(m.text) + '</div></div>').join('') +
      '</div>';
    h += workHtml(c);
    if (ch && k === 'lead') {
      h += '<div class="cu-sec"><button class="link-btn" onclick="custRemoveLead(\'' + id + '\')">🗑 Take this lead off the list</button></div>';
    }
    body.innerHTML = h;
  }

  function syncHtml(c) {
    if (!isQb(c)) return '<div class="cu-sync muted">Not in QuickBooks yet — their profile is made with their first estimate.</div>';
    if (c.qbConflict) {
      const f = c.qbConflict, keys = Object.keys(f.theirs || {});
      return '<div class="cu-conflict"><b>QuickBooks was changed too.</b> Which is right?' +
        '<table class="cu-cmp"><tr><th></th><th>Job Hub</th><th>QuickBooks</th></tr>' +
        keys.map(k => '<tr><td>' + esc(FIELD_WORD[k] || k) + '</td><td>' + esc((f.mine || {})[k] || '—') + '</td><td>' + esc(f.theirs[k] || '—') + '</td></tr>').join('') +
        '</table><div class="cu-btns"><button class="btn btn-sm btn-filled" onclick="custConflict(\'' + sid(c.id) + '\', \'mine\')">Keep Job Hub’s</button>' +
        '<button class="btn btn-sm" onclick="custConflict(\'' + sid(c.id) + '\', \'theirs\')">Take QuickBooks’</button></div></div>';
    }
    if (c.qbPending) {
      return '<div class="cu-sync warn">' + (c.qbError ? esc(c.qbError.message || 'QuickBooks said no') + ' — ' : 'Not in QuickBooks yet — ') +
        'it goes at the next hourly look. <button class="link-btn" onclick="custSendNow(\'' + sid(c.id) + '\')">Send now</button></div>';
    }
    return '<div class="cu-sync ok">✓ Same as QuickBooks</div>';
  }

  function workHtml(c) {
    let h = '';
    const jobs = jobsOf(c.id).sort((a, b) => s(b.quoteDate || b.lastModified).localeCompare(s(a.quoteDate || a.lastModified)));
    const bills = can('billing', 'see');
    if (can('jobs', 'see')) {
      h += '<div class="cu-sec"><div class="cu-sec-h">Jobs &amp; bids' +
        (can('jobs', 'change') ? ' <button class="btn btn-sm" onclick="custStartBid(\'' + sid(c.id) + '\')">Start a bid</button>' : '') + '</div>' +
        (jobs.length ? jobs.map(j => {
          const bid = typeof isBidStatus === 'function' && isBidStatus(j.jobStatus);
          const word = bid ? (j.bidStage === 'lost' ? 'Lost bid' : 'Bid') : ({ booked: 'Booked', inprogress: 'In progress', complete: 'Done' }[j.jobStatus] || s(j.jobStatus));
          return '<div class="cu-job"><button class="link-btn" onclick="custOpenJob(\'' + sid(j._id) + '\')">' +
            (typeof jobNameHtml === 'function' ? jobNameHtml(j.customerName, j.estimateNumber) : esc(j.customerName)) + '</button> ' +
            '<span class="muted">' + esc(word) + (j.quoteDate ? ' · ' + esc(niceDay(s(j.quoteDate).slice(0, 10))) : '') + '</span>' +
            (bills && j.jobPrice ? ' <span class="cu-money">' + esc(money(parseFloat(String(j.jobPrice).replace(/[$,]/g, '')) || 0)) + '</span>' : '') +
            (can('jobs', 'change') ? ' <button class="link-btn cu-unlink" onclick="custUnlinkJob(\'' + sid(j._id) + '\')">Not theirs</button>' : '') +
            '</div>';
        }).join('') : '<div class="muted">No jobs or bids tied to them in Job Hub.</div>') + '</div>';
    }
    if (bills) {
      const invs = invoicesOf(c, jobs).sort((a, b) => s(b.txnDate).localeCompare(s(a.txnDate)));
      const owed = invs.reduce((t, i) => t + (Number(i.balance) || 0), 0);
      h += '<div class="cu-sec"><div class="cu-sec-h">Invoices' + (owed > 0 ? ' <span class="cu-owed">Owes ' + esc(money(owed)) + '</span>' : '') + '</div>' +
        (invs.length ? invs.map(i => '<div class="cu-job">#' + esc(i.docNumber || i.id) + ' <span class="muted">' + esc(niceDay(s(i.txnDate))) + '</span> · ' +
          esc(money(Number(i.total) || 0)) + (Number(i.balance) > 0 ? ' · <b>' + esc(money(Number(i.balance))) + ' owed</b>' : ' · paid') +
          (i.link ? ' <a href="' + esc(i.link) + '" target="_blank" rel="noopener">QuickBooks ↗</a>' : '') + '</div>').join('')
          : '<div class="muted">No open invoices.</div>') + '</div>';
      const pays = [];
      jobs.forEach(j => (j.payments || []).forEach(p => pays.push({ date: s(p.date || p.createdAt).slice(0, 10), amount: p.amount, label: p.label || p.method || '', job: j.customerName })));
      if (pays.length) {
        pays.sort((a, b) => b.date.localeCompare(a.date));
        h += '<div class="cu-sec"><div class="cu-sec-h">Payments</div>' + pays.map(p => '<div class="cu-job">' + esc(niceDay(p.date)) + ' · ' +
          esc(money(parseFloat(String(p.amount).replace(/[$,]/g, '')) || 0)) + (p.label ? ' <span class="muted">' + esc(p.label) + '</span>' : '') + '</div>').join('') + '</div>';
      }
    }
    if (can('snow', 'see')) {
      const snow = snowOf(c.id);
      h += '<div class="cu-sec"><div class="cu-sec-h">Snow</div>' + (snow.length
        ? snow.map(a => '<div class="cu-job">❄️ ' + esc(a.name || '') + (a.address ? ' <span class="muted">' + esc(a.address) + '</span>' : '') + '</div>').join('')
        : '<div class="muted">No snow account.</div>' + (can('snow', 'change') && typeof openSnowForm === 'function'
          ? '<button class="btn btn-sm" onclick="custToSnow(\'' + sid(c.id) + '\')">Make a snow account</button>' : '')) + '</div>';
    }
    return h;
  }

  // ------------------------------------------------------------ changing contact details
  const FIELD_WORD = { name: 'Name in QuickBooks', firstName: 'First name', lastName: 'Last name', business: 'Business',
    phone: 'Phone', mobile: 'Mobile', email: 'Email', street: 'Street', city: 'City', state: 'State', zip: 'ZIP' };
  const EDIT_KEYS = Object.keys(FIELD_WORD);
  function editHtml(c) {
    const f = (k, type, extra) => '<div class="field"><span class="label">' + FIELD_WORD[k] + '</span><input id="cuF_' + k + '"' +
      (type ? ' type="' + type + '"' : '') + ' value="' + esc(c[k] || '') + '"' + (extra || '') + '></div>';
    return '<div class="cu-edit">' +
      '<div class="grid g3">' + f('firstName') + f('lastName') + f('business') + '</div>' +
      f('name', '', isQb(c) ? '' : ' placeholder="Worked out from the name or business"') +
      '<div class="grid g3">' + f('phone', 'tel') + f('mobile', 'tel') + f('email', 'email') + '</div>' +
      f('street', '', ' autocomplete="off"') +
      '<div class="grid sf-addr">' + f('city') + f('state', '', ' maxlength="2"') + f('zip', '', ' inputmode="numeric" maxlength="10"') + '</div>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="custSaveContact(\'' + sid(c.id) + '\')">Save' + (isQb(c) ? ' — here and in QuickBooks' : '') + '</button>' +
      '<button class="btn btn-sm" onclick="custEdit(false)">Cancel</button></div></div>';
  }
  window.custEdit = function (on) { editing = !!on; renderPage(true); if (on && el('cuF_firstName')) el('cuF_firstName').focus(); };
  const lineOf = p => [s(p.street), s(p.city), [s(p.state).toUpperCase(), s(p.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  window.custSaveContact = function (id) {
    const c = customers[id];
    if (!c) return;
    const now = {};
    EDIT_KEYS.forEach(k => { const n = el('cuF_' + k); now[k] = n ? s(n.value) : s(c[k]); });
    now.state = now.state.toUpperCase();
    if (!now.name) now.name = now.business || [now.firstName, now.lastName].filter(Boolean).join(' ');
    if (!now.name) { showToast('Give them a name first'); return; }
    const fields = {}, was = {};
    EDIT_KEYS.forEach(k => { if (now[k] !== s(c[k])) { fields[k] = now[k]; was[k] = s(c[k]); } });
    if (!Object.keys(fields).length) { editing = false; renderPage(true); return; }
    editing = false;
    const patch = Object.assign({}, fields);
    if (['street', 'city', 'state', 'zip'].some(k => k in fields)) patch.address = lineOf(now);
    if (id === newLeadId) { patch.source = 'hand'; patch.addedAt = new Date().toISOString(); newLeadId = null; }
    if (isQb(c)) {
      // Held as waiting until QuickBooks has it: the server's hourly look
      // then neither overwrites it nor forgets to send it.
      const prev = c.qbPending || {};
      const keys = Array.from(new Set((prev.fields || []).concat(Object.keys(fields))));
      patch.qbPending = { at: new Date().toISOString(), fields: keys, base: prev.base || s(c.qbSyncToken),
        was: Object.assign({}, was, prev.was || {}) };
      patch.qbError = null;
    }
    write(id, patch, 'their details');
    render();
    renderPage(true);
    if (isQb(c)) sendToQb(id, fields, patch.qbPending.was, false);
    else showToast('Saved');
  };

  function sendToQb(id, fields, was, force) {
    if (!window.YDClaude || !navigator.onLine) { showToast('Saved here — it goes to QuickBooks when there’s signal'); return; }
    window.YDClaude.post('/qb/customer-save', { id: id, fields: fields, was: was || {}, force: !!force }).then(r => {
      if (r && r.conflict) { showToast('QuickBooks was changed too — pick which is right'); return; }
      showToast('Saved here and in QuickBooks');
    }).catch(e => showToast('Saved here — QuickBooks: ' + ((e && e.message) || 'not reached') + '. It is tried again every hour.'));
  }
  window.custSendNow = function (id) {
    const c = customers[id];
    if (!c || !c.qbPending) return;
    const keys = c.qbPending.fields || [], fields = {};
    keys.forEach(k => { fields[k] = s(c[k]); });
    sendToQb(id, fields, c.qbPending.was || {}, false);
  };
  window.custConflict = function (id, pick) {
    const c = customers[id];
    if (!c || !c.qbConflict) return;
    const f = c.qbConflict;
    if (pick === 'theirs') {
      const patch = Object.assign({}, f.theirs, { qbConflict: null, qbPending: null, qbError: null });
      const merged = Object.assign({}, c, f.theirs);
      if (['street', 'city', 'state', 'zip'].some(k => k in f.theirs)) patch.address = lineOf(merged);
      write(id, patch, 'their details');
      render();
      showToast('Took QuickBooks’');
    } else {
      write(id, { qbConflict: null }, 'their details');
      render();
      sendToQb(id, f.mine || {}, {}, true);
    }
  };

  window.custKind = function (id, v) { write(id, { kindByHand: v || null }, 'what they count as'); render(); };
  window.custSaveWhen = function (id) {
    const c = customers[id], n = el('cuWhen');
    if (!c || !n) return;
    const v = s(n.value);
    if (v === s(c.contactWhen)) return;
    n.blur();
    write(id, { contactWhen: v, whenSetAt: new Date().toISOString(), when: null }, 'when to call');
    render();
    const w = windowFromText(v);
    showToast(!v ? 'Time to call taken off' : w ? 'On the call list ' + windowWords(w) : 'Saved — but no month, season or year in it, so it’s not on the call list');
  };
  window.custNotInterested = function (id, on) { write(id, { notInterested: !!on }, 'not interested'); render(); };
  function tagOptions() {
    const src = el('serviceTypeSelect');
    let h = '<option value="">+ Add a service…</option>';
    if (src) Array.prototype.forEach.call(src.options, o => {
      if (o.value && o.value !== '__custom' && !o.dataset.typed) h += '<option value="' + esc(o.value) + '">' + esc(o.textContent) + '</option>';
    });
    return h + '<option value="__custom">Something else…</option>';
  }
  window.custTagOn = function (id, v) {
    const c = customers[id];
    if (!c || !v) return;
    if (v === '__custom') { v = s(prompt('What service?')); if (!v) { render(); return; } }
    if (window.rememberService) rememberService(v);
    const tags = (c.tags || []).slice();
    if (tags.indexOf(v) === -1) tags.push(v);
    write(id, { tags: tags }, 'their services');
    render();
  };
  window.custTagOff = function (id, i) {
    const c = customers[id];
    if (!c) return;
    const tags = (c.tags || []).slice();
    tags.splice(i, 1);
    write(id, { tags: tags }, 'their services');
    render();
  };
  window.custNoteDraft = function (id, v) { drafts[id] = v; };
  window.custSaveNote = function (id) {
    const c = customers[id], text = s(drafts[id]);
    if (!c || !text) { showToast('Write the note first'); return; }
    delete drafts[id];
    // A note means they were talked to: reached, for the call list.
    write(id, { meetings: (c.meetings || []).concat([{ at: new Date().toISOString(), text: text }]), reachedAt: new Date().toISOString() }, 'a note');
    render();
    showToast('Note saved');
  };
  window.custRemoveLead = function (id) {
    const c = customers[id];
    if (!c || isQb(c) || !confirm('Take ' + (c.name || 'this lead') + ' off the list? This cannot be undone.')) return;
    delete customers[id];
    window.closeCustomer();
    render();
    Promise.resolve(window.YDDb.remove('customers', id)).catch(e => showToast('Not removed: ' + ((e && e.code) || 'error')));
  };

  // A lead typed in by hand. Saved only once it has a name
  // (custSaveContact); a window closed before that leaves nothing behind.
  let newLeadId = null;
  window.custAddLead = function () {
    const id = 'ld' + Date.now().toString(36);
    customers[id] = { id: id, name: '' };
    newLeadId = id;
    openId = id;
    ensureModal();
    editing = true;
    renderPage(true);
    el('custModal').classList.add('active');
    const n = el('cuF_firstName'); if (n) n.focus();
  };

  // ------------------------------------------------------------ to a job / snow
  window.custOpenJob = function (jobId) {
    window.closeCustomer();
    if (typeof openJobFromBoard === 'function') openJobFromBoard(jobId);
  };
  window.custUnlinkJob = function (jobId) {
    if (!window.YDSync || !confirm('This job isn’t theirs? It goes back to “To sort” to be tied to the right customer.')) return;
    // By hand: the automatic tie never puts it back.
    YDSync.patchJob(jobId, { customerId: null, customerBy: 'hand' });
    render();
  };
  window.custStartBid = function (id) {
    const c = customers[id];
    if (!c || typeof newJob !== 'function') return;
    window.closeCustomer();
    newJob();
    if (typeof dirty !== 'undefined' && dirty) return;      // the job on screen was kept
    const set = (f, v) => { const n = el(f); if (n && v) n.value = v; };
    set('customerName', c.name);
    set('firstName', c.firstName); set('lastName', c.lastName); set('business', c.business);
    const site = c.ship && c.ship.street ? c.ship : c;
    set('address', site.street || site.address); set('city', site.city); set('state', site.state); set('zip', site.zip);
    set('phone', c.phone || c.mobile); set('email', c.email);
    if (typeof boardFields !== 'undefined') { boardFields.customerId = c.id; boardFields.customerBy = 'hand'; }
    const svc = (c.tags || []).filter(t => t !== 'Snow Removal');
    if (svc.length && typeof serviceTypes !== 'undefined') { serviceTypes = svc.slice(); if (typeof renderServiceTypes === 'function') renderServiceTypes(); }
    if (typeof markDirty === 'function') markDirty();
    const notes = (c.meetings || []).slice().sort((a, b) => s(a.at).localeCompare(s(b.at)))
      .map(m => niceDay(s(m.at).slice(0, 10)) + ': ' + m.text).join('\n\n');
    if (notes && window.YDEstimate && YDEstimate.setNotes) YDEstimate.setNotes(notes, true);
    if (typeof switchTab === 'function') switchTab('job');
    showToast((c.name || 'They') + ' started as a bid');
  };
  window.custToSnow = function (id) {
    const c = customers[id];
    if (!c || typeof openSnowForm !== 'function') return;
    window.closeCustomer();
    openSnowForm();
    if (typeof fillSnowFormFrom === 'function') fillSnowFormFrom(c);
    showToast('Fill in the rates and save — then tie it to them on “To sort”');
  };

  // ------------------------------------------------------------ To sort
  //
  // What was there before the list: the Contacts list, the jobs and bids,
  // the snow accounts -- each tied to its customer once. "Sure" is one
  // customer with that email, else that phone, else exactly that name (or
  // QuickBooks' own id, for a job sent from or brought in from QuickBooks);
  // anything else is listed with the likeliest customers as buttons.
  function index() {
    const by = { email: {}, phone: {}, name: {}, word: {} };
    Object.values(customers).forEach(c => {
      const add = (map, key) => { if (key) (map[key] = map[key] || []).push(c.id); };
      add(by.email, low(c.email));
      add(by.phone, digits(c.phone).length === 10 ? digits(c.phone) : '');
      if (digits(c.mobile) !== digits(c.phone)) add(by.phone, digits(c.mobile).length === 10 ? digits(c.mobile) : '');
      add(by.name, low(c.name));
      if (low(c.business) && low(c.business) !== low(c.name)) add(by.name, low(c.business));
      const fl = low([c.firstName, c.lastName].join(' '));
      if (fl && fl !== low(c.name)) add(by.name, fl);
      words(c.name + ' ' + (c.business || '')).forEach(w => add(by.word, w));
    });
    return by;
  }
  const STOP = { the: 1, and: 1, llc: 1, inc: 1, co: 1, of: 1, mr: 1, mrs: 1, ms: 1, dr: 1 };
  function words(t) { return Array.from(new Set(low(t).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP[w]))); }
  const one = list => (list && new Set(list).size === 1 ? list[0] : null);

  function guess(by, who) {
    const em = by.email[low(who.email)] || [], ph = by.phone[digits(who.phone)] || [], nm = by.name[low(who.name)] || [];
    let sure = null;
    if (who.qbId && customers[resolve(who.qbId)]) sure = resolve(who.qbId);      // QuickBooks' own id
    else {
      // Email and phone first: sure when they point at one customer and
      // nothing points at another (two customers sharing that email or
      // phone, or the email saying one and the phone another, is for Jonah
      // to pick). Two customers of the same name do not stop an email match
      // -- that is exactly when the name cannot tell them apart. With
      // neither, exactly that name, and only one customer of it.
      const strong = [em, ph].filter(l => l.length);
      if (strong.length) {
        const ids = Array.from(new Set([].concat(...strong)));
        const nmOne = one(nm);
        if (ids.length === 1 && !(nmOne && nmOne !== ids[0] && !nm.includes(ids[0]))) sure = ids[0];
      } else if (one(nm)) sure = one(nm);
    }
    const score = {};
    words(who.name).forEach(w => (by.word[w] || []).forEach(id => { score[id] = (score[id] || 0) + 1; }));
    [].concat(by.email[low(who.email)] || [], by.phone[digits(who.phone)] || []).forEach(id => { score[id] = (score[id] || 0) + 3; });
    const options = Object.keys(score).sort((a, b) => score[b] - score[a] || byName(customers[a], customers[b])).slice(0, 4);
    return { sure: sure, options: options };
  }

  function prospectsToSort() {
    const all = (window.YDProspects && YDProspects.all()) || {};
    return Object.values(all).filter(p => p && !p.movedTo);
  }
  function jobsToSort() {
    if (!can('jobs', 'change')) return [];
    return allJobs().filter(j => !j.customerId && !j.removeWhy);
  }
  function snowToSort() {
    if (!can('snow', 'change') || !window.YDSnow) return [];
    const acc = YDSnow.accounts() || {};
    return Object.keys(acc).filter(k => acc[k] && !acc[k].customerId && !acc[k].noCustomer).map(k => Object.assign({ id: k }, acc[k]));
  }
  function sortCount() { return prospectsToSort().length + jobsToSort().length + snowToSort().length; }
  function invoiceCustomer(jobId) {
    if (!window.YDInvoices || !can('billing', 'see')) return '';
    const inv = Object.values(YDInvoices.all() || {}).find(i => i.jobId === jobId && i.customerId);
    return inv ? s(inv.customerId) : '';
  }
  function whoOfJob(j) {
    const q = j.qbEstimate || {};
    return { name: j.customerName, email: j.email, phone: j.phone,
      qbId: (q.customerId && q.env === 'production' ? s(q.customerId) : '') || invoiceCustomer(j._id) };
  }

  function sortHtml() {
    const by = index();
    const groups = [
      ['contact', 'From the old Contacts list', prospectsToSort().map(p => ({ id: p.id, who: { name: p.name, email: p.email, phone: p.phone },
        line: [p.address, p.phone, p.email, p.contactWhen].filter(Boolean).join(' · '), canLead: true }))],
      ['job', 'Jobs and bids', jobsToSort().map(j => ({ id: j._id, who: whoOfJob(j), hand: j.customerBy === 'hand',
        line: [j.estimateNumber ? '#' + j.estimateNumber : '', j.address, typeof isBidStatus === 'function' && isBidStatus(j.jobStatus) ? 'bid' : s(j.jobStatus)].filter(Boolean).join(' · '), canLead: true }))],
      ['snow', 'Snow accounts', snowToSort().map(a => ({ id: a.id, who: { name: a.name, email: '', phone: '' }, line: s(a.address), canLead: false }))],
    ];
    let h = '<div class="hint">Each one tied to its customer once — then nothing is matched by name again. ' +
      'The sure ones (same email, phone, exact name, or QuickBooks’ own id) are ticked already; tap a name to pick a different one.</div>';
    groups.forEach(([kind, title, rows]) => {
      if (!rows.length) return;
      rows.forEach(r => {
        const g = guess(by, r.who);
        // A job someone untied by hand is never tied again by itself.
        r.sure = r.hand ? null : g.sure;
        r.options = g.options;
        const key = kind + ':' + r.id;
        if (!(key in sortPick) && r.sure) sortPick[key] = r.sure;
      });
      const ready = rows.filter(r => sortPick[kind + ':' + r.id]).length;
      h += '<div class="cu-sub">' + esc(title) + ' (' + rows.length + ')' +
        (ready ? ' <button class="btn btn-sm btn-filled" onclick="custSortApply(\'' + kind + '\')">Tie the ' + ready + ' picked</button>' : '') + '</div>';
      h += rows.slice(0, showN).map(r => sortRowHtml(kind, r)).join('') + more(rows.length);
    });
    return h;
  }
  function sortRowHtml(kind, r) {
    const key = kind + ':' + r.id, pick = sortPick[key];
    const ids = Array.from(new Set([].concat(r.sure ? [r.sure] : [], pick && customers[pick] ? [pick] : [], r.options))).slice(0, 5);
    const k = sid(key);
    const btn = (v, label, on) => '<button class="cu-chip' + (on ? ' on' : '') + '" onclick="custSortPick(\'' + k + '\', \'' + sid(v) + '\')">' + label + '</button>';
    return '<div class="cu-sort">' +
      '<div><b>' + esc(r.who.name || '(no name)') + '</b>' + (r.line ? ' <span class="muted">' + esc(r.line) + '</span>' : '') + '</div>' +
      '<div class="cu-picks">' +
        ids.map(id => { const c = customers[id]; return btn(id, (id === r.sure ? '✓ ' : '') + esc(c.name || '?') +
          '<small>' + esc([c.business && c.business !== c.name ? c.business : '', c.address ? c.address.split(',')[0] : '', c.phone || c.mobile].filter(Boolean).join(' · ') || KIND_WORD[kindOf(c)]) + '</small>', pick === id); }).join('') +
        (r.canLead ? btn('lead', 'New lead<small>not in QuickBooks yet</small>', pick === 'lead') : '') +
        btn('skip', 'Leave it<small>not now</small>', pick === 'skip' || !pick) +
      '</div>' +
      '<input class="cu-sort-find" placeholder="Someone else? Type a name…" oninput="custSortFind(\'' + k + '\', this.value)" id="cuFind_' + k + '">' +
      '<div class="cu-picks" id="cuFound_' + k + '"></div>' +
    '</div>';
  }
  // The key carries ":" -- safe-id'd for the page; looked up again here.
  function keyOf(k) { return Object.keys(sortPick).concat(allSortKeys()).find(x => sid(x) === k) || k; }
  function allSortKeys() {
    return prospectsToSort().map(p => 'contact:' + p.id).concat(jobsToSort().map(j => 'job:' + j._id), snowToSort().map(a => 'snow:' + a.id));
  }
  window.custSortPick = function (k, v) {
    const key = keyOf(k);
    if (v === 'skip') sortPick[key] = '';
    else sortPick[key] = v === 'lead' ? 'lead' : resolve(v);
    render();
  };
  window.custSortFind = function (k, q) {
    const box = el('cuFound_' + k);
    if (!box) return;
    q = low(q);
    if (q.length < 2) { box.innerHTML = ''; return; }
    const hits = Object.values(customers).filter(c => low([c.name, c.business, c.email, c.phone, c.address].join(' ')).indexOf(q) !== -1).sort(byName).slice(0, 6);
    box.innerHTML = hits.map(c => '<button class="cu-chip" onclick="custSortPick(\'' + k + '\', \'' + sid(c.id) + '\')">' + esc(c.name || '?') +
      '<small>' + esc(c.address ? c.address.split(',')[0] : (c.phone || '')) + '</small></button>').join('') || '<span class="muted">Nobody by that name</span>';
  };

  // A Contacts person onto their customer: tags joined, notes added, the
  // time to call kept unless the customer has one; the old record kept and
  // marked movedTo (nothing deleted).
  function carryOver(p, custId) {
    const now = new Date().toISOString();
    const base = {
      tags: (p.services || []).slice(), contactWhen: s(p.contactWhen), whenSetAt: p.whenSetAt || (p.contactWhen ? now : null),
      note: s(p.note), meetings: (p.meetings || []).slice(), reachedAt: p.reachedAt || null, declined: (p.declined || []).slice(),
      notInterested: p.status === 'no', fromProspect: p.id, addedAt: p.addedAt || now,
    };
    if (custId === 'lead') {
      const id = 'ld' + s(p.id).toLowerCase().replace(/[^a-z0-9]/g, '');
      const rec = Object.assign(base, { name: s(p.name), firstName: s(p.firstName), lastName: s(p.lastName), business: s(p.business),
        phone: s(p.phone), mobile: '', email: s(p.email).toLowerCase(), street: s(p.street), city: s(p.city), state: s(p.state), zip: s(p.zip),
        address: s(p.address), source: 'contacts' });
      if (!rec.street && rec.address && window.YDAddr) Object.assign(rec, (({ street, city, state, zip }) => ({ street, city, state, zip }))(YDAddr.partsOf(rec)));
      customers[id] = Object.assign({ id: id }, rec);
      write(id, rec, 'a lead');
      return id;
    }
    const c = customers[custId];
    if (!c) return null;
    const join = (a, b) => (a || []).concat((b || []).filter(x => (a || []).indexOf(x) === -1));
    const patch = { tags: join(c.tags, base.tags), meetings: (c.meetings || []).concat(base.meetings),
      declined: (c.declined || []).concat(base.declined), fromProspect: p.id };
    if (base.note) patch.note = [s(c.note), base.note].filter(Boolean).join('\n');
    if (!s(c.contactWhen) && base.contactWhen) { patch.contactWhen = base.contactWhen; patch.whenSetAt = base.whenSetAt; }
    if (base.reachedAt && s(base.reachedAt) > s(c.reachedAt)) patch.reachedAt = base.reachedAt;
    if (base.notInterested) patch.notInterested = true;
    write(custId, patch, 'carrying the contact over');
    return custId;
  }

  window.custSortApply = function (kind) {
    if (!can('contacts', 'change')) return;
    let n = 0;
    if (kind === 'contact') {
      const all = (window.YDProspects && YDProspects.all()) || {};
      prospectsToSort().forEach(p => {
        const pick = sortPick['contact:' + p.id];
        if (!pick) return;
        const to = carryOver(p, pick);
        if (!to) return;
        if (all[p.id]) all[p.id].movedTo = to;
        Promise.resolve(window.YDDb.put('prospects', p.id, { movedTo: to, movedAt: new Date().toISOString() }))
          .catch(e => console.warn('[customers] contact not marked carried over:', e && e.code));
        delete sortPick['contact:' + p.id];
        n++;
      });
    } else if (kind === 'job') {
      const by = index();
      jobsToSort().forEach(j => {
        const key = 'job:' + j._id;
        let pick = sortPick[key];
        if (!pick || !window.YDSync) return;
        if (pick === 'lead') pick = newLeadFromJob(j);
        const g = guess(by, whoOfJob(j));
        YDSync.patchJob(j._id, { customerId: pick, customerBy: pick === g.sure ? 'auto' : 'hand' });
        delete sortPick[key];
        n++;
      });
    } else if (kind === 'snow') {
      snowToSort().forEach(a => {
        const key = 'snow:' + a.id, pick = sortPick[key];
        if (!pick || pick === 'lead') return;
        Promise.resolve(window.YDDb.put('snowAccounts', a.id, { customerId: pick }))
          .catch(e => showToast('Snow account not tied: ' + ((e && e.code) || 'error')));
        const acc = YDSnow.accounts() || {};
        if (acc[a.id]) acc[a.id].customerId = pick;
        delete sortPick[key];
        n++;
      });
    }
    render();
    showToast(n + ' tied to their customer');
  };
  function newLeadFromJob(j) {
    const id = 'ld' + s(j._id).toLowerCase().replace(/[^a-z0-9]/g, '');
    const rec = { name: s(j.customerName), firstName: s(j.firstName), lastName: s(j.lastName), business: s(j.business),
      phone: s(j.phone), mobile: '', email: s(j.email).toLowerCase(), street: s(j.address), city: s(j.city), state: s(j.state), zip: s(j.zip),
      tags: (j.serviceTypes || []).slice(), source: 'job', addedAt: new Date().toISOString() };
    rec.address = lineOf(rec);
    customers[id] = Object.assign({ id: id }, rec);
    write(id, rec, 'a lead');
    return id;
  }

  // ------------------------------------------------------------ a bid turned down
  //
  // The same as the Contacts list did (prospects.js fromLostBid, Jonah 9 Oct):
  // tagged with the bid's services, a dated note of what they turned down
  // (no price -- Contacts can be an admin's who has no business seeing it),
  // the time to call next spring if none is set. Onto the bid's own
  // customer; a bid tied to nobody finds them by email, phone or exact name,
  // or makes them a lead.
  function fromLostBid(jobId, j) {
    if (!j || !can('contacts', 'change')) return null;
    let id = j.customerId ? resolve(j.customerId) : null;
    let added = false;
    if (!id || !customers[id]) {
      const g = guess(index(), { name: j.customerName, email: j.email, phone: j.phone });
      id = g.sure;
      if (!id) { id = newLeadFromJob(Object.assign({ _id: jobId }, j)); added = true; }
      if (window.YDSync) YDSync.patchJob(jobId, { customerId: id, customerBy: 'auto' });
    }
    const c = customers[id];
    if (!c) return null;
    const now = new Date();
    const services = (Array.isArray(j.serviceTypes) ? j.serviceTypes : []).map(s).filter(Boolean);
    const est = s(j.estimateNumber);
    const before = c.declined || [];
    if (before.some(d => d.jobId === jobId)) return { id: id, added: false };
    const line = 'Declined our bid' + (est ? ' #' + est : '') + (services.length ? ' for ' + services.join(', ') : '') +
      ' on ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.';
    const patch = {
      tags: (c.tags || []).concat(services.filter(x => (c.tags || []).indexOf(x) === -1)),
      declined: before.concat([{ at: now.toISOString(), jobId: jobId, est: est || null, services: services }]),
      note: [s(c.note), line].filter(Boolean).join('\n'),
    };
    if (!s(c.contactWhen) && !(c.when && c.when.from)) {
      patch.contactWhen = 'Spring ' + (now.getFullYear() + (now.getMonth() >= 2 ? 1 : 0));
      patch.whenSetAt = now.toISOString();
    }
    write(id, patch, 'the declined bid');
    render();
    return { id: id, added: added };
  }

  // The QuickBooks id to send a job's estimate to (estimate.js): the job's
  // customer, when they have a profile -- so a second estimate never makes a
  // second QuickBooks customer because the name was typed differently.
  function qbIdFor(customerId) {
    const c = customerId && customers[resolve(customerId)];
    return c && c.qbCustomerId ? s(c.qbCustomerId) : '';
  }

  // ------------------------------------------------------------ switched on / off
  //
  // Off: the tab is the Contacts screen as it always was. The owner sees one
  // line offering to bring the customers in (his yes is the switch).
  function applyOn() {
    const on = isOn();
    // The old Contacts screen goes only once the customers have actually
    // arrived: switched on before the server could read them (not deployed
    // yet, QuickBooks not connected), his list stays where it was.
    const have = on && loaded && Object.values(customers).some(isQb);
    document.documentElement.toggleAttribute('data-customers-on', have);
    const sec = el('custSection');
    if (sec) sec.hidden = !on;
    const tab = el('tabContacts');
    if (tab) tab.innerHTML = '<span class="tab-icon">' + (on ? '👥' : '📇') + '</span>' + (on ? 'Customers' : 'Contacts');
    if (typeof TAB_LABEL === 'object') TAB_LABEL.contacts = on ? '👥 Customers' : '📇 Contacts';
    if (typeof TAB_HINT === 'object') TAB_HINT.contacts = on ? 'Everyone you’ve worked for, leads, and who to call' : 'People to ring later';
  }
  function renderOff() {
    const box = el('custOff');
    if (!box) return;
    const owner = !!(window.YDAuth && window.YDAuth.isOwner);
    box.hidden = !(owner && confRead && conf.importOn !== true);
    if (box.hidden) return;
    box.innerHTML = '<div class="cu-off"><b>👥 Your QuickBooks customers here?</b> Every customer in QuickBooks — old ones too, under “Past” — ' +
      'in one list with this one, kept in step both ways, with the call list built in. ' +
      '<button class="btn btn-sm btn-filled" onclick="custSwitchOn()">Bring them in</button></div>';
  }
  window.custSwitchOn = function () {
    if (!(window.YDAuth && window.YDAuth.isOwner)) return;
    if (!confirm('Bring in every customer from your real QuickBooks (about 500), and keep them in step both ways from now on?\n\n' +
      'Nothing in QuickBooks is changed by this. Your Contacts list stays until you sort it onto them.')) return;
    conf.importOn = true;
    Promise.resolve(window.YDDb.put('settings', 'customers', { importOn: true, importOnAt: new Date().toISOString(),
      importOnBy: (window.YDAuth.user && window.YDAuth.user.uid) || null })).catch(e => showToast('Not switched on: ' + ((e && e.code) || 'error')));
    start();
    render();
    if (window.YDClaude) window.YDClaude.post('/qb/customers-now', {}).then(() => showToast('Customers brought in from QuickBooks'))
      .catch(e => showToast('Switched on — QuickBooks: ' + ((e && e.message) || 'not reached') + '. They come in at the next hourly look.'));
  };

  function readConf() {
    if (!window.YDDb || !can('contacts', 'see')) return;
    Promise.resolve(window.YDDb.get('settings', 'customers')).then(d => {
      conf = Object.assign({ importOn: false, pastYears: 2 }, d || {});
      confRead = true;
      if (isOn()) start();
      render();
    }).catch(() => { confRead = true; render(); });
  }

  function start() {
    if (unsub || !window.YDDb || !isOn()) return;
    unsub = window.YDDb.watch('customers', (changes, meta) => {
      changes.forEach(ch => {
        if (ch.type === 'removed') { delete customers[ch.id]; delete merged[ch.id]; return; }
        const rec = Object.assign({ id: ch.id }, ch.data);
        if (rec.mergedInto) { merged[ch.id] = s(rec.mergedInto); delete customers[ch.id]; return; }
        customers[ch.id] = rec;
      });
      if (!meta || meta.fromCache === false || Object.keys(customers).length) loaded = true;
      render();
      document.dispatchEvent(new CustomEvent('yd-customers'));
    }, err => {
      loaded = true;
      render();
      if (err && err.code === 'permission-denied') showToast('Customers could not be loaded — security rules need publishing');
    });
  }
  function stop() {
    if (unsub) { try { unsub(); } catch (e) { /* already gone */ } }
    unsub = null; customers = {}; merged = {}; loaded = false;
  }

  window.YDCustomers = {
    on: isOn, all: () => customers, kindOf: kindOf, windowOf: windowOf, windowFromText: windowFromText,
    fromLostBid: fromLostBid, qbIdFor: qbIdFor, open: id => window.openCustomer(id), render: render,
  };
  window.custRenderNow = render;

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const ok = a.mode === 'cloud' && !!a.user && can('contacts', 'see');
    const k = ok ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k === authKey) return;
    authKey = k;
    stop(); confRead = false;
    if (ok) readConf(); else render();
  });
  // Their jobs, invoices and snow accounts change under the page.
  ['yd-jobs-changed', 'yd-invoices', 'yd-prospects'].forEach(ev => document.addEventListener(ev, () => { if (isOn()) render(); }));
  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
