// Search everything, and every setting in one place.
//
// The overnight usability pass (15 Oct 2026) found two things that wasted
// the most time. Finding a customer meant looking in My Jobs, All Jobs,
// Contacts, Snow and Supplies one after the other, because each has its own
// search box and none looks anywhere else. And the settings were spread over
// eight places -- Pricing rules in the ⋯ menu, the services list behind a
// pencil on the Job tab, the automatic clock-out at the foot of Your Crew,
// the recurring tasks behind a button on one board.
//
// So: one 🔍 in the header (or "/" on a laptop) that looks through all of
// it as you type, and openSettings() -- one window listing every setting
// with a button that goes straight there.
//
// NOTHING HERE READS THE DATABASE. Every list comes from what the other
// screens already hold -- the jobs on this device (app.js) and each module's
// own window.YD... export -- so a search costs no reads, works with no
// signal, and can never turn up something the person's own screens would
// not show them. A crew phone never holds the jobs, the contacts, the
// receipts or a price, so it cannot find them either; the same checks the
// screens make (ydCan) are made again here so that nothing slips through if
// a module ever keeps something after access is taken away. The rules in
// firestore.rules are still the real lock; this only follows them.
//
// A tap opens the thing exactly the way its own screen does (the same
// functions), so what happens next is never different from opening it there.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ESC_MAP[c]));

  const RECENT_KEY = 'ydjobhub_recentSearches';   // cleared with the rest on sign-out
  const RECENT_MAX = 8;
  const IN_ALL = 5;          // rows of each kind under All, before "Show all"
  const IN_ONE = 60;         // rows once one kind is picked
  const STALE_MS = 20000;    // a list older than this is read again from its screen
  const CAL_DAYS = 60;       // calendar entries this far back and ahead

  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const signedIn = () => !!(window.YDAuth && window.YDAuth.mode === 'cloud' && me());
  // No Firebase on this device: the jobs saved here are still this person's
  // to see (Home and the job list work the same way).
  const localOnly = () => !!(window.YDAuth && window.YDAuth.mode === 'local');
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const can = (area, level) => (localOnly() ? area === 'jobs'
    : typeof ydCan === 'function' && ydCan(area, level || 'see'));
  const isPhone = () => (window.matchMedia ? window.matchMedia('(max-width:720px)').matches : window.innerWidth <= 720);
  const fn = name => (typeof window[name] === 'function' ? window[name] : null);

  // ------------------------------------------------------------ matching
  //
  // Case, accents and punctuation do not count: "smiths" finds Smith's,
  // "cafe" finds Café, "5550102030" finds (555) 010-2030 and "#1234" finds
  // job 1234. Punctuation is dropped rather than turned into a space,
  // so a phone number or an item number typed without its dashes still
  // matches. Every word typed has to be found somewhere in the thing.
  const CAN_NORMALIZE = typeof ''.normalize === 'function';
  function fold(s) {
    let t = String(s == null ? '' : s);
    if (CAN_NORMALIZE) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t.toLowerCase().replace(/[^a-z0-9\s]+/g, '').replace(/\s+/g, ' ').trim();
  }
  const wordsOf = q => fold(q).split(' ').filter(Boolean);

  // One thing that can be found. `name` is what it is called (a customer, a
  // machine, a card's title); `nums` its numbers (job #, phone, order #,
  // item #), which a whole number typed matches exactly; `more` everything
  // else worth finding it by.
  function entry(kind, o) {
    const name = fold(o.name != null ? o.name : o.title);
    const nums = (o.nums || []).map(n => fold(n).replace(/ /g, '')).filter(Boolean);
    return {
      kind: kind, title: o.title || 'Untitled', sub: o.sub || '', tag: o.tag || '',
      order: typeof o.order === 'number' && isFinite(o.order) ? o.order : 0, open: o.open,
      name: name, nums: nums, hay: name + ' ' + nums.join(' ') + ' ' + fold((o.more || []).join(' ')),
    };
  }

  // Best first: the whole name or number exactly, then a name that starts
  // with what was typed, then one with every word at the start of a word
  // ("jo sm" for Jo Smith), then the name containing it, then a match
  // somewhere else (an address, a note, a phone number). -1: not a match.
  function score(e, words, whole) {
    for (let i = 0; i < words.length; i++) if (e.hay.indexOf(words[i]) === -1) return -1;
    const compact = whole.replace(/ /g, '');
    if (e.name === whole || e.nums.indexOf(compact) !== -1) return 0;
    if (e.name.indexOf(whole) === 0 || e.nums.some(n => n.indexOf(compact) === 0)) return 1;
    const parts = e.name.split(' ');
    if (words.every(w => parts.some(p => p.indexOf(w) === 0))) return 2;
    if (words.every(w => e.name.indexOf(w) !== -1)) return 3;
    return 4;
  }

  // What was typed, lit up where it was found. The text is folded a letter
  // at a time, remembering where each folded letter came from, so "cafe"
  // lights up "Café" and "smiths" "Smith's".
  function marked(text, words) {
    const raw = String(text == null ? '' : text);
    let flat = '';
    const from = [];
    for (let i = 0; i < raw.length; i++) {
      let c = raw[i];
      if (CAN_NORMALIZE) c = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
      c = c.toLowerCase().replace(/[^a-z0-9\s]+/g, '');
      for (let j = 0; j < c.length; j++) { flat += c[j]; from.push(i); }
    }
    const spans = [];
    words.forEach(w => {
      if (w.length < 2 && words.length > 1) return;
      let at = flat.indexOf(w);
      while (at !== -1) {
        spans.push([from[at], from[at + w.length - 1] + 1]);
        at = flat.indexOf(w, at + w.length);
      }
    });
    if (!spans.length) return esc(raw);
    spans.sort((a, b) => a[0] - b[0]);
    let out = '', pos = 0;
    spans.forEach(s => {
      if (s[1] <= pos) return;
      const from = Math.max(s[0], pos);
      out += esc(raw.slice(pos, from)) + '<mark class="srch-hit">' + esc(raw.slice(from, s[1])) + '</mark>';
      pos = s[1];
    });
    return out + esc(raw.slice(pos));
  }

  // ------------------------------------------------------------ dates & money

  const two = n => (n < 10 ? '0' : '') + n;
  const ymd = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  function addDays(day, n) {
    const d = new Date(day + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  function dayWords(day, withWeekday) {
    const d = new Date(String(day || '') + 'T12:00:00');
    if (isNaN(d)) return '';
    const opts = { month: 'short', day: 'numeric' };
    if (withWeekday) opts.weekday = 'short';
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
  }
  const msOf = s => { const t = Date.parse(s || ''); return isFinite(t) ? t : 0; };
  const dollars = cents => (typeof cents === 'number' && isFinite(cents)
    ? '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
  const joinDot = list => list.filter(Boolean).join(' · ');

  // ------------------------------------------------------------ opening things
  //
  // Each kind opens the way its own screen opens it. Where the screen has no
  // way to point at one thing (a snow account, a supply), the screen is
  // brought up showing it and it is lit up for a moment so the eye finds it.

  function reveal(node) {
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('srch-flash');
    void node.offsetWidth;            // so the flash plays again on a second visit
    node.classList.add('srch-flash');
    setTimeout(() => node.classList.remove('srch-flash'), 2600);
  }
  const later = (f, ms) => setTimeout(f, ms || 80);

  // A job, on the Job tab -- as Home, the calendar and the boards open one:
  // the job already in the form is just shown (loading it again would read
  // the saved copy over whatever is typed and not yet saved).
  function openJob(id) {
    if (typeof currentJobId !== 'undefined' && currentJobId === id) { switchTab('job'); return; }
    if (typeof dirty !== 'undefined' && dirty &&
        !confirm('The job open now has unsaved changes. Open this one anyway?')) return;
    if (typeof loadJob === 'function') loadJob(id);
  }
  function openContact(id) {
    switchTab('contacts');
    if (fn('findProspect')) findProspect(id);
    later(() => reveal(el('ppCard_' + String(id).replace(/[^A-Za-z0-9_-]/g, ''))), 120);
  }
  // The Snow tab lists the accounts by name, as here; the card is found by
  // its place in that order, checked against its name.
  function openSnow(id) {
    switchTab('snow');
    const all = (window.YDSnow && YDSnow.accounts && YDSnow.accounts()) || {};
    const a = all[id];
    if (!a) return;
    const order = Object.keys(all).sort((x, y) => (all[x].name || '').localeCompare(all[y].name || ''));
    later(() => {
      const cards = document.querySelectorAll('#snowAccountsWrap .snow-card');
      const nameOf = c => ((c && c.querySelector('.snow-name')) || {}).textContent || '';
      let card = cards[order.indexOf(id)];
      if (!card || nameOf(card) !== (a.name || '')) {
        card = Array.prototype.find.call(cards, c => nameOf(c) === (a.name || '')) || null;
      }
      reveal(card);
    });
  }
  // Supplies: the supplier's own page. An item is shown on its supplier's
  // page with its name in that page's search box, so it is the one listed
  // (a supplier with many things folds them away by kind otherwise).
  function suppliesSearch(text) {
    const box = el('supSearch');
    if (box) box.value = text;
    if (fn('supSearch')) supSearch(text);
  }
  function openVendor(id) {
    switchTab('supplies');
    suppliesSearch('');
    if (fn('supFilter')) supFilter(id);
  }
  function openItem(it) {
    switchTab('supplies');
    const cat = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : { vendors: {} };
    suppliesSearch(it.name || '');
    if (fn('supFilter')) supFilter(cat.vendors && cat.vendors[it.vendorId] ? it.vendorId : '-');
    later(() => {
      const names = document.querySelectorAll('#supResults .sup-item .sup-name');
      const hit = Array.prototype.find.call(names, n => n.textContent === (it.name || ''));
      reveal(hit ? hit.closest('.sup-item') : null);
    }, 260);
  }
  function openMachine(id) {
    switchTab('equipment');
    if (fn('openEquipment')) openEquipment(id);
  }
  // A card: its board, then the card itself -- what the calendar does.
  function openCard(boardId, cardId) {
    switchTab('boards');
    if (fn('showBoard')) showBoard(boardId);
    if (fn('openCardDetail')) openCardDetail(boardId, cardId);
  }
  function openCalendar(o) {
    if (window.YDCalendar && YDCalendar.open) YDCalendar.open(o);
  }
  // A receipt still to sort is a card at the top of Receipts. A sorted one is
  // found in All receipts by its store and order number (or date), under
  // Set aside when that is the only place it shows.
  function openReceipt(r) {
    switchTab('receipts');
    if (r.status === 'new') { later(() => reveal(el('rc_' + String(r.id).replace(/[^A-Za-z0-9_-]/g, '')))); return; }
    const box = el('rcSearch');
    if (box) box.value = joinDot([r.vendor, r.orderNo || r.date]).replace(/ · /g, ' ');
    if (fn('rcView')) {
      rcView('all');
      if (!document.querySelector('#rcHistory .rc-row')) rcView('skipped');
    } else if (fn('rcSearchNow')) rcSearchNow();
    later(() => reveal(document.querySelector('#rcHistory .rc-row') || el('rcHistorySection')));
  }

  // ------------------------------------------------------------ what can be searched
  //
  // Each kind: who may search it (the same test its screen makes), what it
  // finds things by (said on the empty screen), and its list, built from
  // what its screen holds.

  const KINDS = [
    { id: 'jobs', name: 'Jobs', icon: '📋' },
    { id: 'contacts', name: 'Contacts', icon: '📇' },
    { id: 'snow', name: 'Snow', icon: '❄️' },
    { id: 'supplies', name: 'Supplies', icon: '🛒' },
    { id: 'equipment', name: 'Equipment', icon: '🚜' },
    { id: 'cards', name: 'Cards', icon: '📌' },
    { id: 'calendar', name: 'Calendar', icon: '📅' },
    { id: 'receipts', name: 'Receipts', icon: '🧾' },
    { id: 'settings', name: 'Settings', icon: '⚙️' },
  ];
  const kindById = id => KINDS.find(k => k.id === id) || KINDS[0];

  const SOURCES = {
    jobs: {
      // The jobs on this device for whoever may see jobs; the crew's own
      // list of booked jobs (no prices, no email) for everyone else.
      allowed: () => can('jobs', 'see') || (signedIn() && !!window.YDCrewJobs),
      about: () => (can('jobs', 'see') ? 'Jobs and bids — name, job #, address, phone, email, services'
        : 'Your booked jobs — name, job #, address'),
      build: buildJobs,
    },
    contacts: {
      allowed: () => signedIn() && can('contacts', 'see') && !!window.YDProspects,
      about: () => 'Contacts — name, address, phone, email, notes, when to call',
      build: buildContacts,
    },
    snow: {
      allowed: () => signedIn() && !!window.YDSnow,
      about: () => 'Snow accounts — name, address' + (seesSnowPrivate() ? ', phone, email' : ''),
      build: buildSnow,
    },
    supplies: {
      allowed: () => signedIn() && !!window.YDSupplies,
      about: () => 'Suppliers and supplies — name, item #, notes' + (can('supplies', 'see') ? ' (with prices)' : ''),
      build: buildSupplies,
    },
    equipment: {
      allowed: () => signedIn() && can('equipment', 'see') && !!window.YDEquipment,
      about: () => 'Machines and vehicles — name, make, model, serial, problems',
      build: buildEquipment,
    },
    cards: {
      allowed: () => signedIn() && !!window.YDBoards,
      about: () => 'Board cards — title, notes, checklists, job',
      build: buildCards,
    },
    calendar: {
      allowed: () => signedIn() && !!(window.YDCalendar && YDCalendar.day),
      about: () => 'Calendar — your entries and the crew’s, two months back and ahead',
      build: buildCalendar,
    },
    receipts: {
      allowed: () => signedIn() && can('jobs', 'see') && !!window.YDReceipts,
      about: () => 'Receipts — store, order #, items, job',
      build: buildReceipts,
    },
    settings: {
      allowed: () => true,
      about: () => {
        const names = visibleSettings().map(s => s.name);
        return 'Settings — ' + (names.length > 3 ? names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more'
          : names.join(', '));
      },
      build: buildSettings,
    },
  };

  const seesSnowPrivate = () => can('snow', 'see') || can('billing', 'see');

  function buildJobs() {
    if (can('jobs', 'see')) {
      if (typeof loadAllJobs !== 'function') return [];
      return loadAllJobs().map(d => {
        const id = d._id;
        const name = String(d.customerName || [d.firstName, d.lastName].filter(Boolean).join(' ') || d.business || '').trim() || 'Untitled';
        const bid = typeof isBidStatus === 'function' ? isBidStatus(d.jobStatus) : d.jobStatus === 'quoting';
        const status = bid ? (d.bidStage === 'lost' ? 'Bid · lost' : 'Bid')
          : typeof statusLabel === 'function' && typeof normStatus === 'function' ? statusLabel(normStatus(d.jobStatus, d)) : '';
        const est = String(d.estimateNumber || '').trim();
        const where = [d.address, d.city].filter(Boolean).join(', ');
        return entry('jobs', {
          title: name, tag: bid ? 'Bid' : 'Job',
          sub: joinDot([est ? '#' + est : '', status, where]),
          nums: [est, d.phone],
          more: [d.firstName, d.lastName, d.business, d.address, d.city, d.state, d.zip, d.phone, d.email,
                 (d.serviceTypes || []).join(' '), d.qbInvoice],
          order: -msOf(d.lastModified),
          open: () => openJob(id),
        });
      });
    }
    // A crew phone: the jobs on its Jobs tab, opened as that tab opens them.
    if (!window.YDCrewJobs || !YDCrewJobs.list) return [];
    return YDCrewJobs.list().map(j => entry('jobs', {
      title: j.name || 'Untitled job', tag: 'Job',
      sub: joinDot([j.est ? '#' + j.est : '', j.status === 'inprogress' ? 'In progress' : 'Booked',
                    [j.address, j.city].filter(Boolean).join(', ')]),
      nums: [j.est, j.phone],
      more: [j.address, j.city, j.zip, j.phone, (j.services || []).join(' ')],
      open: () => { if (fn('openCrewJob')) openCrewJob(j.id); },
    }));
  }

  const CONTACT_STATUS = { 'to-contact': 'To contact', contacted: 'Contacted', quoted: 'Quoted', won: 'Won', no: 'Not interested' };
  function buildContacts() {
    const all = window.YDProspects.all() || {};
    const whenKey = window.YDProspects.whenKey || (() => 0);
    return Object.keys(all).map(k => {
      const p = all[k] || {};
      const id = p.id || k;
      return entry('contacts', {
        title: p.name || '(no name)', tag: 'Contact',
        sub: joinDot([p.contactWhen, CONTACT_STATUS[p.status] || '', (p.services || []).join(', '), p.address]),
        nums: [p.phone],
        more: [p.firstName, p.lastName, p.business, p.address, p.phone, p.email, p.note, (p.services || []).join(' '),
               p.contactWhen, (p.meetings || []).map(m => m && m.text).join(' ')],
        order: whenKey(p.contactWhen),
        open: () => openContact(id),
      });
    });
  }

  function buildSnow() {
    const all = window.YDSnow.accounts() || {};
    // The phone and email live with the prices (owner, Snow or Billing).
    const priv = seesSnowPrivate() && YDSnow.pricing ? YDSnow.pricing() || {} : {};
    return Object.keys(all).map(id => {
      const a = all[id] || {}, p = priv[id] || {};
      const addr = (a.address || '') + (a.town && !a.street ? ', ' + a.town : '');
      return entry('snow', {
        title: a.name || 'Snow account', tag: 'Snow',
        sub: joinDot([addr, a.type === 'commercial' ? 'Commercial' : '', a.active === false ? 'Not active' : '']),
        nums: seesSnowPrivate() ? [p.phone] : [],
        more: [a.address, a.town, a.areaNotes, a.type].concat(seesSnowPrivate() ? [p.phone, p.email] : []),
        order: a.active === false ? 1 : 0,
        open: () => openSnow(id),
      });
    });
  }

  function buildSupplies() {
    const cat = window.YDSupplies.catalog() || {};
    const items = cat.items || {}, vendors = cat.vendors || {};
    // Prices only for whoever the Supplies screen shows them to.
    const prices = can('supplies', 'see') ? cat.prices || {} : {};
    const count = {};
    Object.values(items).forEach(it => { if (it) count[it.vendorId] = (count[it.vendorId] || 0) + 1; });
    const out = Object.keys(vendors).map(id => {
      const v = vendors[id] || {};
      const n = count[id] || 0;
      return entry('supplies', {
        title: v.name || 'Supplier', tag: 'Supplier',
        sub: joinDot([v.address, n + ' item' + (n === 1 ? '' : 's')]),
        nums: [v.phone],
        more: [v.address, v.notes, v.website, v.phone, v.email, v.hours],
        order: 0,
        open: () => openVendor(id),
      });
    });
    Object.keys(items).forEach(id => {
      const it = items[id];
      if (!it) return;
      const v = vendors[it.vendorId];
      const p = prices[id];
      const price = p && typeof p.cents === 'number' ? dollars(p.cents) + (p.per ? ' / ' + p.per : '') : '';
      out.push(entry('supplies', {
        title: it.name || 'Item', tag: 'Item',
        sub: joinDot([v ? v.name : 'No supplier set', it.sku ? '#' + it.sku : '', price]),
        nums: [it.sku],
        more: [it.sku, it.notes, it.where, it.category, it.unit, v && v.name,
               (Array.isArray(it.usedFor) ? it.usedFor : []).join(' ')],
        order: 1,
        open: () => openItem(Object.assign({ id: id }, it)),
      }));
    });
    return out;
  }

  function buildEquipment() {
    const gear = window.YDEquipment.all() || {};
    const KIND = { machine: 'Machine', vehicle: 'Vehicle' };
    return Object.keys(gear).map(id => {
      const g = gear[id] || {};
      const open = (g.issues || []).filter(i => i && !i.doneAt);
      return entry('equipment', {
        title: g.name || 'Machine', tag: KIND[g.kind] || String(g.kind || 'Machine'),
        sub: joinDot([[g.year, g.make, g.model].filter(Boolean).join(' '), g.serial ? 'Serial ' + g.serial : '',
                      open.length ? open.length + ' problem' + (open.length === 1 ? '' : 's') : '']),
        nums: [g.serial],
        more: [g.make, g.model, g.year, g.serial, KIND[g.kind] || g.kind, g.notes, (g.issues || []).map(i => i && i.what).join(' ')],
        open: () => openMachine(id),
      });
    });
  }

  function buildCards() {
    const boards = YDBoards.boards() || {}, cards = YDBoards.cards() || {};
    const out = [];
    Object.keys(cards).forEach(bid => {
      const b = boards[bid];
      if (!b || b.virtual) return;               // Bids and Jobs are the jobs themselves
      const done = YDBoards.doneCol ? YDBoards.doneCol(b) : '';
      const colName = id => ((b.columns || []).find(c => c.id === id) || {}).name || '';
      Object.keys(cards[bid] || {}).forEach(cid => {
        const k = cards[bid][cid];
        if (!k) return;
        const col = k.column || ((b.columns || [])[0] || {}).id || '';
        const isDone = !!done && col === done;
        const due = k.due ? 'Due ' + dayWords(k.due) + (/^\d{2}:\d{2}$/.test(k.dueTime || '') ? ' ' + k.dueTime : '') : '';
        const labels = (k.labels || []).map(l => ((b.labels || []).find(x => x.id === l) || {}).name).filter(Boolean);
        out.push(entry('cards', {
          title: k.title || 'Card', tag: 'Card',
          sub: joinDot([b.name, colName(col), due, k.jobName]),
          more: [k.notes, k.jobName, b.name, labels.join(' '), (k.checklist || []).map(i => i && i.text).join(' ')],
          // Still to do first, soonest due first; finished ones last.
          order: (isDone ? 2e13 : 0) + (k.due ? msOf(k.due + 'T12:00:00') : 1e13),
          open: () => openCard(bid, cid),
        }));
      });
    });
    return out;
  }

  // The calendar has no list of its own to hand over, only a day at a time
  // as Home asks for it (YDCalendar.day: this person's entries and the
  // crew's). Two months each way are asked for, a day at a time, and kept
  // until the calendar says something changed. Storms, machines' due dates
  // and cards are left out: they are found as themselves.
  function buildCalendar() {
    const today = ymd(new Date());
    const seen = {}, out = [];
    for (let i = -CAL_DAYS; i <= CAL_DAYS; i++) {
      const day = addDays(today, i);
      const d = YDCalendar.day(day);
      if (!d) continue;
      ['mineTimed', 'mineAny', 'crewTimed', 'crewAny', 'mineLate', 'crewLate'].forEach(list => {
        (d[list] || []).forEach(x => {
          const o = x && x.o;
          if (!o || o.auto) return;
          const key = (o.calId || '') + '|' + (o.id || '') + '|' + o.day;
          if (seen[key]) return;
          seen[key] = true;
          const ev = o.ev || {};
          // Coming up first, nearest first; then the ones gone by, latest first.
          const away = Math.round((Date.parse(o.day + 'T12:00:00') - Date.parse(today + 'T12:00:00')) / 864e5);
          out.push(entry('calendar', {
            title: o.name || ev.title || 'Entry', name: o.name || ev.title || '', tag: 'Calendar',
            sub: joinDot([dayWords(o.day, true), x.time || 'All day', o.layer && o.layer.name, o.address,
                          o.jobName && o.jobName !== o.name ? o.jobName : '', o.done ? 'Done' : '']),
            more: [o.address, o.jobName, o.layer && o.layer.name, ev.notes, ev.note],
            order: away >= 0 ? away : 1000 - away,
            open: () => openCalendar(o),
          }));
        });
      });
    }
    return out;
  }

  function buildReceipts() {
    const all = window.YDReceipts.all() || {};
    return Object.keys(all).map(id => {
      const r = Object.assign({ id: id }, all[id] || {});
      const where = r.status === 'new' ? 'To sort'
        : (r.splits || []).map(s => s && (s.jobName || s.name)).filter(Boolean).slice(0, 2).join(', ') ||
          (r.status === 'skipped' ? 'Set aside' : '');
      return entry('receipts', {
        title: r.vendor || 'Receipt', tag: 'Receipt',
        sub: joinDot([dayWords(r.date), r.orderNo ? '#' + r.orderNo : '', dollars(r.totalCents), where]),
        nums: [r.orderNo],
        more: [r.summary, r.date, (r.lines || []).map(l => l && (l.name + ' ' + (l.itemNo || ''))).join(' '),
               (r.splits || []).map(s => s && [s.jobName, s.name, s.est].filter(Boolean).join(' ')).join(' ')],
        order: -msOf(r.date),
        open: () => openReceipt(r),
      });
    });
  }

  // ------------------------------------------------------------ settings
  //
  // Every setting in the app, with who may use it -- the same test the
  // setting's own button makes, so nobody is offered one that would refuse
  // them -- and how to get there.

  const call = (name, ...args) => { const f = fn(name); if (f) f.apply(null, args); };
  // Pricing rules is one long window; its Claude part is near the bottom.
  function pricingAt(id) {
    call('openPricingRules');
    later(() => { const n = el(id); if (n) n.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 120);
  }
  // Boards whose settings this person may change (boards.js runsBoard).
  const runBoards = () => {
    if (!signedIn() || !window.YDBoards) return [];
    const all = YDBoards.boards() || {};
    return Object.keys(all).map(id => all[id]).filter(b => b && !b.virtual && !b.crewOnly &&
      (owner() || (can('boards', 'change') && b.ownerOnly === false)))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  };

  const SETTINGS = [
    { group: 'Prices & money', icon: '💲', name: 'Pricing rules',
      hint: 'Crew-day rate, profit, markups, delivery, sales tax, payments, the end of every estimate',
      words: 'markup margin profit tax delivery deposit payment terms warranty estimate',
      show: () => signedIn() && owner(), go: () => call('openPricingRules') },
    { group: 'Prices & money', icon: '🧰', name: 'Services & how they’re priced',
      hint: 'Services sold by the unit or the crew-day, their minimums and what adjusts them',
      words: 'price book turf sod flat rate minimum',
      show: () => signedIn() && owner(), go: () => call('openPriceBook') },
    { group: 'Prices & money', icon: '✨', name: 'Claude — switches & spend',
      hint: 'What Claude does by itself, the daily and monthly spending limits, what it has cost',
      words: 'ai anthropic budget cap spend cost auto draft cards plant care',
      show: () => signedIn() && owner(), go: () => pricingAt('prSpend') },
    { group: 'Prices & money', icon: '📗', name: 'QuickBooks',
      hint: 'The connection to QuickBooks, and matching customers and items',
      words: 'intuit qbo invoice connect accounting',
      show: () => signedIn() && (owner() || can('billing', 'change')), go: () => call('openQuickBooks') },
    { group: 'Prices & money', icon: '🤝', name: 'Subcontractors',
      hint: 'Who you sub work out to, their properties, what they charge and what they are owed',
      words: 'subs subbed mowing lawn care bills',
      show: () => signedIn() && owner(),
      go: () => { switchTab('dashboard'); later(() => reveal(el('subsSection')), 120); } },
    { group: 'Jobs & lists', icon: '🏷️', name: 'Services list',
      hint: 'The services picked on jobs, bids and contacts — add your own or take them off',
      words: 'service types tags list',
      show: () => (signedIn() && (can('jobs', 'change') || can('contacts', 'change'))) || localOnly(),
      go: () => call('openServicesEditor') },
    { group: 'People & the clock', icon: '👥', name: 'Your Crew, people & access',
      hint: 'Rename people, let them in, make an admin and choose what they may see, mark crew members, pay rates',
      words: 'people names rename admin access permissions crew member let in pay rate wage',
      show: () => signedIn() && owner(), go: () => call('openPeople') },
    { group: 'People & the clock', icon: '⏱️', name: 'Forgot to clock out',
      hint: 'How many hours a shift can run before it stops by itself',
      words: 'auto clock out automatic shift hours limit',
      show: () => signedIn() && owner(),
      go: () => {
        call('openPeople');
        later(() => reveal(document.querySelector('#clockCrewSection .crew-setting')), 260);
      } },
    { group: 'Boards & calendars', icon: '📅', name: 'Calendars',
      hint: 'Add a calendar, its colour, who sees it and who may change it',
      words: 'manage calendars share colour color personal',
      show: () => signedIn() && owner(), go: () => { switchTab('calendar'); call('calManage'); } },
    { group: 'Boards & calendars', icon: '📌', name: 'Board settings',
      hint: 'Each board’s columns, labels, colour and who sees it',
      words: 'boards columns labels share private',
      show: () => runBoards().length > 0, go: () => switchTab('boards'), boards: true },
    { group: 'Boards & calendars', icon: '🔁', name: 'Recurring crew tasks',
      hint: 'The weekly and monthly jobs that come back on the Crew tasks board',
      words: 'recurring repeat weekly monthly maintenance tasks',
      show: () => signedIn() && owner(),
      go: () => { switchTab('boards'); call('showBoard', 'crew'); call('openRecurring'); } },
    { group: 'On this device', icon: '🔔', name: 'Notifications & summaries',
      hint: 'The daily summaries by email and on this device, and reminders',
      words: 'push email digest reminders alerts phone',
      show: () => signedIn(), go: () => call('openNotifications') },
    { group: 'On this device', icon: '🌓', name: 'Appearance',
      hint: 'Light, dark, or the same as this device',
      words: 'dark mode light theme night',
      show: () => true, go: () => call('openAppearance') },
    { group: 'Your data', icon: '💾', name: 'Backup',
      hint: 'Download every job on this device as a file',
      words: 'export download save file',
      show: () => can('jobs', 'see'), go: () => call('exportAllJobs') },
    { group: 'Your data', icon: '📂', name: 'Restore',
      hint: 'Bring jobs back from a backup file',
      words: 'import upload file',
      show: () => can('jobs', 'change'),
      go: () => { const f = el('restoreInput'); if (f) f.click(); } },
  ];
  const visibleSettings = () => SETTINGS.filter(s => { try { return s.show(); } catch (e) { return false; } });

  function buildSettings() {
    return visibleSettings().map((s, i) => entry('settings', {
      title: s.name, tag: 'Setting', sub: s.hint, more: [s.group, s.hint, s.words], order: i,
      open: () => s.go(),
    }));
  }

  // ------------------------------------------------------------ the lists, kept
  //
  // Each kind's list is built the first time it is searched and kept until
  // its screen says it changed (its yd-... event) or it is STALE_MS old, so
  // typing a word does not rebuild ~900 supplies at every letter.

  let cache = {};            // kind -> { at, list }
  function listOf(kind) {
    const c = cache[kind];
    if (c && Date.now() - c.at < STALE_MS) return c.list;
    let list = [];
    try { list = SOURCES[kind].build() || []; }
    catch (e) { console.warn('[search] could not read ' + kind + ':', e); list = []; }
    cache[kind] = { at: Date.now(), list: list };
    return list;
  }
  const allowedKinds = () => KINDS.filter(k => { try { return SOURCES[k.id].allowed(); } catch (e) { return false; } });

  const CHANGES = {
    'yd-jobs-changed': ['jobs'], 'yd-jobs-restored': ['jobs'], 'yd-crew-jobs': ['jobs'],
    'yd-supplies': ['supplies'], 'yd-equipment-changed': ['equipment'], 'yd-receipts': ['receipts'],
    'yd-cards-changed': ['cards', 'calendar'], 'yd-boards-changed': ['cards', 'calendar', 'settings'],
    'yd-calendar-changed': ['calendar'], 'yd-outreach': ['contacts'], 'yd-remind-me': ['calendar'],
  };
  let redoTimer = null;
  Object.keys(CHANGES).forEach(ev => document.addEventListener(ev, () => {
    CHANGES[ev].forEach(k => { delete cache[k]; });
    // Open with something typed: the results follow, once things settle.
    if (!isOpen || !input() || !input().value.trim()) return;
    clearTimeout(redoTimer);
    redoTimer = setTimeout(() => draw(true), 300);
  }));

  // ------------------------------------------------------------ the search panel

  let panel = null;
  let isOpen = false;
  let filter = 'all';        // 'all' or a kind id
  let shown = [];            // the rows on screen, in order (keys, Enter, taps)
  let sel = -1;              // the row the arrow keys are on
  let typeTimer = null;
  const input = () => el('srchInput');

  function build() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.className = 'srch-panel';
    panel.id = 'srchPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Search everything');
    panel.innerHTML =
      '<div class="srch-top">' +
        '<span class="srch-glass" aria-hidden="true">🔍</span>' +
        '<input id="srchInput" type="search" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
          'enterkeyhint="search" role="combobox" aria-expanded="true" aria-controls="srchList" aria-autocomplete="list" ' +
          'aria-label="Search everything">' +
        '<button type="button" class="srch-close" onclick="closeSearch(true)" aria-label="Close search">' +
          '<span class="srch-close-word">Close</span><kbd class="srch-close-key">Esc</kbd></button>' +
      '</div>' +
      '<div class="srch-chips" id="srchChips" role="tablist" aria-label="What to search"></div>' +
      '<div class="srch-list" id="srchList" role="listbox" aria-label="Results"></div>';
    document.body.appendChild(panel);
    const box = input();
    box.addEventListener('input', () => {
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { sel = -1; draw(); }, 120);
    });
    box.addEventListener('keydown', onKey);
    return panel;
  }

  // Under the header button on a laptop, as wide as it needs; the whole
  // screen on a phone (the stylesheet does that part).
  function place() {
    if (!panel || panel.hidden) return;
    // A window dragged narrower or wider while open (or a phone turned).
    document.documentElement.classList.toggle('srch-locked', isPhone());
    if (isPhone()) { panel.style.top = panel.style.right = panel.style.maxHeight = ''; return; }
    const b = el('srchOpen');
    const r = b ? b.getBoundingClientRect() : null;
    // The width inside the scroll bar: that is what `right` counts from.
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const top = r && r.bottom > 0 ? Math.round(r.bottom + 8) : 16;
    const width = Math.min(640, vw - 32);
    const right = r ? Math.min(Math.max(16, Math.round(vw - r.right)), vw - width - 16) : 16;
    panel.style.top = top + 'px';
    panel.style.right = Math.max(16, right) + 'px';
    panel.style.maxHeight = Math.max(240, window.innerHeight - top - 16) + 'px';
  }
  window.addEventListener('resize', place);

  function openSearch(text) {
    build();
    // The week's weather drops down in the same place.
    const wx = el('wxPanel');
    if (wx && !wx.hidden && fn('toggleWeek')) toggleWeek();
    if (!isOpen) filter = 'all';
    isOpen = true;
    panel.hidden = false;
    const b = el('srchOpen');
    if (b) b.setAttribute('aria-expanded', 'true');
    const box = input();
    box.placeholder = placeholder();
    if (typeof text === 'string') box.value = text;
    place();
    sel = -1;
    draw();
    box.focus();
    if (typeof text !== 'string') box.select();
  }
  function closeSearch(backToButton) {
    if (!panel || !isOpen) return;
    isOpen = false;
    panel.hidden = true;
    clearTimeout(typeTimer);
    document.documentElement.classList.remove('srch-locked');
    const b = el('srchOpen');
    if (b) {
      b.setAttribute('aria-expanded', 'false');
      if (backToButton === true && !isPhone()) b.focus();
    }
  }

  function placeholder() {
    // A phone's box is too narrow for the list.
    if (isPhone()) return 'Search everything…';
    const k = allowedKinds().map(x => x.id);
    const say = [];
    if (k.indexOf('jobs') !== -1) say.push('jobs');
    if (k.indexOf('contacts') !== -1) say.push('contacts');
    if (k.indexOf('snow') !== -1) say.push('snow');
    if (k.indexOf('supplies') !== -1) say.push('supplies');
    if (k.indexOf('cards') !== -1) say.push('cards');
    return say.length ? 'Search ' + say.join(', ') + '…' : 'Search…';
  }

  // Every allowed kind searched, best first within each.
  function run(words) {
    const whole = words.join(' ');
    const by = {};
    allowedKinds().forEach(k => {
      const hits = [];
      listOf(k.id).forEach(e => {
        const s = score(e, words, whole);
        if (s !== -1) hits.push({ e: e, s: s });
      });
      hits.sort((a, b) => a.s - b.s || a.e.order - b.e.order || String(a.e.title).localeCompare(String(b.e.title)));
      by[k.id] = hits;
    });
    return by;
  }

  function rowHtml(e, i, words) {
    const k = kindById(e.kind);
    return '<button type="button" class="srch-row' + (i === sel ? ' sel' : '') + '" id="srchR' + i + '" role="option"' +
        ' aria-selected="' + (i === sel ? 'true' : 'false') + '" onclick="srchOpenAt(' + i + ')">' +
      '<span class="srch-row-icon" aria-hidden="true">' + k.icon + '</span>' +
      '<span class="srch-row-main">' +
        '<span class="srch-row-title">' + marked(e.title, words) + '</span>' +
        (e.sub ? '<span class="srch-row-sub">' + marked(e.sub, words) + '</span>' : '') +
      '</span>' +
      (e.tag ? '<span class="srch-row-tag">' + esc(e.tag) + '</span>' : '') +
    '</button>';
  }

  function draw(keepSel) {
    if (!panel || !isOpen) return;
    const box = input(), list = el('srchList'), chips = el('srchChips');
    const words = wordsOf(box.value);
    shown = [];
    if (!keepSel) sel = -1;
    if (!words.length) {
      chips.innerHTML = '';
      chips.hidden = true;
      list.innerHTML = emptyHtml();
      box.removeAttribute('aria-activedescendant');
      return;
    }
    const by = run(words);
    const kinds = allowedKinds();
    const total = kinds.reduce((t, k) => t + by[k.id].length, 0);
    if (filter !== 'all' && !by[filter]) filter = 'all';
    // Kinds with something found, the one with the best match first.
    const order = kinds.filter(k => by[k.id].length)
      .sort((a, b) => by[a.id][0].s - by[b.id][0].s || KINDS.indexOf(a) - KINDS.indexOf(b));
    // A chip for each kind something was found in (and the one picked, even
    // once nothing in it matches) -- not a row of greyed-out empty ones.
    chips.hidden = false;
    chips.innerHTML = '<button type="button" role="tab" class="srch-chip' + (filter === 'all' ? ' on' : '') + '" aria-selected="' +
        (filter === 'all') + '" onclick="srchFilter(\'all\')">All <b>' + total + '</b></button>' +
      kinds.filter(k => by[k.id].length || filter === k.id).map(k =>
        '<button type="button" role="tab" class="srch-chip' + (filter === k.id ? ' on' : '') + '" aria-selected="' +
          (filter === k.id) + '" onclick="srchFilter(\'' + k.id + '\')">' +
          esc(k.name) + ' <b>' + by[k.id].length + '</b></button>').join('');

    let html = '';
    const group = (k, rows, more) => {
      html += '<div class="srch-group" role="presentation"><span>' + k.icon + ' ' + esc(k.name) + '</span>' +
        '<span class="srch-count">' + by[k.id].length + '</span></div>';
      rows.forEach(h => { html += rowHtml(h.e, shown.length, words); shown.push(h.e); });
      if (more) html += more;
    };
    if (filter === 'all') {
      order.forEach(k => {
        const hits = by[k.id];
        group(k, hits.slice(0, IN_ALL), hits.length > IN_ALL
          ? '<button type="button" class="srch-more" onclick="srchFilter(\'' + k.id + '\')">Show all ' + hits.length + ' ' +
            esc(k.name.toLowerCase()) + ' →</button>' : '');
      });
    } else {
      const k = kindById(filter), hits = by[filter];
      if (hits.length) {
        group(k, hits.slice(0, IN_ONE), hits.length > IN_ONE
          ? '<p class="srch-note">Showing ' + IN_ONE + ' of ' + hits.length + ' — type more to narrow it down.</p>' : '');
      } else {
        html += '<p class="srch-none">Nothing in ' + esc(k.name.toLowerCase()) + ' matches.' +
          (total ? ' <button type="button" class="link-btn" onclick="srchFilter(\'all\')">See the ' + total +
            ' found elsewhere</button>' : '') + '</p>';
      }
    }
    if (!total) {
      html = '<p class="srch-none">Nothing matches “' + esc(box.value.trim()) + '”.</p>' +
        '<p class="srch-note">Every word typed has to be found. Try fewer words, or part of a name, a job number or a phone number.</p>';
    }
    html += notLoadedHtml();
    list.innerHTML = html;
    if (sel >= shown.length) sel = shown.length - 1;
    markSel();
  }

  // Supplies are read on a crew phone only once Supplies is opened (a long
  // list, kept off phones that never need it); until then there is nothing
  // here to search, and saying so beats "nothing matches".
  function notLoadedHtml() {
    if (!SOURCES.supplies.allowed() || (filter !== 'all' && filter !== 'supplies')) return '';
    const cat = window.YDSupplies.catalog() || {};
    if (Object.keys(cat.items || {}).length || Object.keys(cat.vendors || {}).length) return '';
    return '<p class="srch-note">Supplies are not on this device yet. ' +
      '<button type="button" class="link-btn" onclick="srchGoSupplies()">Open Supplies</button> once, and they can be searched from here.</p>';
  }

  function emptyHtml() {
    const recent = recents();
    const kinds = allowedKinds();
    return (recent.length
      ? '<div class="srch-group" role="presentation"><span>Recent searches</span>' +
          '<button type="button" class="link-btn srch-clear" onclick="srchClearRecent()">Clear</button></div>' +
        recent.map((q, i) => '<button type="button" class="srch-recent" onclick="srchRecent(' + i + ')">' +
          '<span aria-hidden="true">🕘</span> ' + esc(q) + '</button>').join('')
      : '') +
      '<div class="srch-what"><b>Type to search ' + (kinds.length > 2 ? 'everything you can see in Job Hub' : 'Job Hub') + '.</b>' +
        ' Capitals, accents and punctuation don’t matter, and every word typed has to be found.' +
        '<ul>' + kinds.map(k => '<li><span aria-hidden="true">' + k.icon + '</span> ' + esc(SOURCES[k.id].about()) + '</li>').join('') + '</ul>' +
        (isPhone() ? '' : '<p class="srch-note">Press <kbd>/</kbd> anywhere to search, <kbd>↑</kbd> <kbd>↓</kbd> to pick, ' +
          '<kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close.</p>') +
        '<button type="button" class="btn btn-sm srch-settings" onclick="closeSearch(); openSettings()">⚙ All settings</button>' +
      '</div>';
  }

  function markSel() {
    const box = input();
    (panel.querySelectorAll('.srch-row') || []).forEach(r => {
      const on = r.id === 'srchR' + sel;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const row = sel >= 0 ? el('srchR' + sel) : null;
    if (row) { box.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
    else box.removeAttribute('aria-activedescendant');
  }

  function onKey(e) {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return;
      e.preventDefault();
      sel = e.key === 'ArrowDown' ? Math.min(shown.length - 1, sel + 1) : Math.max(0, sel - 1);
      markSel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(typeTimer);
      // Enter straight after typing: the results for every letter typed.
      draw(true);
      if (shown.length) srchOpenAt(sel >= 0 ? sel : 0);
    }
  }

  function srchOpenAt(i) {
    const e = shown[i];
    if (!e || typeof e.open !== 'function') return;
    remember(input().value);
    closeSearch();
    try { e.open(); }
    catch (err) { console.warn('[search] could not open it:', err); if (fn('showToast')) showToast('That could not be opened just now'); }
  }

  // ------------------------------------------------------------ recent searches
  //
  // Kept on this device only, with the other ydjobhub_ keys -- signing out
  // wipes them, so the next person to sign in never sees what was looked for.

  function recents() {
    try {
      const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, RECENT_MAX) : [];
    } catch (e) { return []; }
  }
  function remember(q) {
    q = String(q || '').trim().slice(0, 80);
    if (q.length < 2) return;
    const list = [q].concat(recents().filter(x => fold(x) !== fold(q))).slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* private window: just not kept */ }
  }

  // ------------------------------------------------------------ the header and keys

  // "/" anywhere that is not a box being typed in, as on most sites. Left
  // alone while a window is open: the search would open behind it.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.modal-overlay.active, .sheet-overlay.active')) return;
    const gate = el('authGate');
    if (gate && !gate.hidden) return;
    const b = el('srchOpen');
    if (!b || b.hidden || !b.offsetParent) return;
    e.preventDefault();
    openSearch();
  });
  // Escape closes the search before anything behind it (app.js closes the
  // window in front on Escape, and leaves alone a key already handled).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isOpen || e.isComposing) return;
    e.preventDefault();
    closeSearch(true);
  }, true);
  // A press outside the panel on a laptop closes it, as the ⋯ menu does.
  document.addEventListener('pointerdown', e => {
    if (!isOpen || isPhone() || !panel) return;
    if (panel.contains(e.target) || (el('srchOpen') && el('srchOpen').contains(e.target))) return;
    closeSearch();
  }, true);

  // Signing out or in, or access changed: nothing found for one person (or
  // under the old access) is kept. Signed out, the search closes.
  document.addEventListener('yd-auth', () => {
    cache = {};
    if (!signedIn() && !localOnly()) { shown = []; closeSearch(); closeSettings(); return; }
    if (isOpen) { if (input()) input().placeholder = placeholder(); draw(); }
    if (setOpen()) drawSettings();
  });

  // ------------------------------------------------------------ All settings

  let setBoards = [];        // the boards on the window now (setBoard)
  const setOpen = () => !!(el('setHubModal') && el('setHubModal').classList.contains('active'));

  function openSettings() {
    let m = el('setHubModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'setHubModal';
      // Nothing to type in here, so a tap beside it closes it.
      m.onclick = ev => { if (ev.target === m) closeSettings(); };
      m.innerHTML = '<div class="modal set-hub" role="dialog" aria-labelledby="setHubTitle">' +
        '<div class="modal-head"><h2 id="setHubTitle">⚙ All settings</h2>' +
        '<button class="modal-close" onclick="closeSettings()" aria-label="Close">&times;</button></div>' +
        '<div class="modal-body" id="setHubBody"></div></div>';
      document.body.appendChild(m);
    }
    closeSearch();
    drawSettings();
    m.classList.add('active');
  }
  function closeSettings() {
    const m = el('setHubModal');
    if (m) m.classList.remove('active');
  }

  function drawSettings() {
    const body = el('setHubBody');
    if (!body) return;
    const list = visibleSettings();
    setBoards = runBoards();
    let group = '';
    body.innerHTML = '<p class="hint set-hub-intro">Every setting in Job Hub that you can change, in one place. ' +
        'Each button goes straight to it.</p>' +
      list.map(s => {
        const i = SETTINGS.indexOf(s);
        const head = s.group !== group ? '<div class="set-group">' + esc(s.group) + '</div>' : '';
        group = s.group;
        return head + '<button type="button" class="set-row" onclick="setGo(' + i + ')">' +
            '<span class="set-icon" aria-hidden="true">' + s.icon + '</span>' +
            '<span class="set-main"><b>' + esc(s.name) + '</b><small>' + esc(s.hint) + '</small></span>' +
            '<span class="set-go" aria-hidden="true">›</span></button>' +
          (s.boards && setBoards.length
            ? '<div class="set-boards">' + setBoards.map((b, j) =>
                '<button type="button" class="set-board" onclick="setBoard(' + j + ')">⚙ ' + esc(b.name || 'Board') +
                  (b.ownerOnly ? ' 🔒' : '') + '</button>').join('') + '</div>'
            : '');
      }).join('');
  }

  function setGo(i) {
    const s = SETTINGS[i];
    if (!s || !s.show()) return;
    closeSettings();
    s.go();
  }
  function setBoard(j) {
    const b = setBoards[j];
    if (!b) return;
    closeSettings();
    switchTab('boards');
    call('showBoard', b.id);
    call('editBoard', b.id);
  }

  // ------------------------------------------------------------ globals

  window.openSearch = () => openSearch();
  window.closeSearch = closeSearch;
  window.srchOpenAt = srchOpenAt;
  window.srchFilter = function (k) {
    filter = k === 'all' || SOURCES[k] ? k : 'all';
    sel = -1;
    draw();
    const box = input();
    if (box && !isPhone()) box.focus();
  };
  window.srchRecent = function (i) {
    const q = recents()[i];
    if (q == null) return;
    const box = input();
    box.value = q;
    draw();
    box.focus();
  };
  window.srchClearRecent = function () {
    try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* nothing kept anyway */ }
    draw();
  };
  window.srchGoSupplies = function () { closeSearch(); switchTab('supplies'); };
  window.openSettings = openSettings;
  window.closeSettings = closeSettings;
  window.setGo = setGo;
  window.setBoard = setBoard;

  window.YDSearch = {
    open: text => openSearch(typeof text === 'string' ? text : undefined),
    close: () => closeSearch(),
    settings: openSettings,
    // Forget every list kept, so the next search reads the screens afresh.
    refresh: () => { cache = {}; if (isOpen) draw(true); },
  };
})();
