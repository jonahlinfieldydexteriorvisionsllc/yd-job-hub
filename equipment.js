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

  // ------------------------------------------------------------ the groups
  //
  // Jonah, 16 Oct 2026: "equipment should have these categories: vehicles,
  // machines, trailers, small engines, & electric tools. electric tools will
  // include our milwaukee battery powered tools and wetsaws etc. small
  // engines will have all of our chainsaws, compactor etc." Exactly these
  // five, in this order, and every piece of equipment is in one of them.
  //
  // Kept in the machine's own `kind` -- the field that always said what a
  // machine is ('machine' / 'vehicle' are stored as they always were), the
  // one the crew's list (settings/public.equipmentList), Receipts and the
  // search already read -- so nothing anywhere can hold a second answer to
  // the same question. Types typed in before (a `kind` of "Trailer",
  // "Attachment"...) are folded into the five once, on the owner's device
  // (sortIntoGroups below); what it was is kept beside it in `kindBefore`.
  // `kindHow` says how the group was chosen: 'words' (from its name),
  // 'kind' (its old type), 'check' (the words could not tell -- listed
  // under "Check these" until someone taps a group) or 'hand'.
  const CATEGORIES = [
    { id: 'vehicle', one: 'Vehicle', many: 'Vehicles', icon: '🚚' },
    { id: 'machine', one: 'Machine', many: 'Machines', icon: '🚜' },
    // No emoji is a trailer: the hitch it hangs on.
    { id: 'trailer', one: 'Trailer', many: 'Trailers', icon: '🔗' },
    { id: 'engine', one: 'Small engine', many: 'Small engines', icon: '⛽' },
    { id: 'electric', one: 'Electric tool', many: 'Electric tools', icon: '🔋' },
  ];
  const CAT_IDS = CATEGORIES.map(c => c.id);
  const isCatId = k => CAT_IDS.indexOf(String(k || '')) !== -1;
  const catById = id => CATEGORIES.find(c => c.id === id) || CATEGORIES[1];

  // What a name says it is, from the words in it -- or null when it says
  // nothing. In this order: a trailer is a trailer whatever pulls it ("ATV
  // trailer"); battery / Milwaukee / M18 / electric / wet saw make it an
  // electric tool even where a small engine's word is there too ("battery
  // blower") -- Jonah's rule; then the big machines (a zero-turn or riding
  // mower is a machine you sit on, not a small engine); then the small
  // engines; the vehicles; and last the words that are mostly corded or
  // battery tools (a drill, a grinder) but say less. Punctuation is read
  // as a space, so "F-150", "F150" and "MT-100" are all found.
  const WORDS = [
    ['trailer', /\btrailers?\b/],
    ['electric', /\b(battery|batteries|cordless|corded|electric|plug in|milwaukee|m18|m12|dewalt|makita|ego|wet ?saw|tile saw|\d{2} ?v|\d{2} volt)\b/],
    ['machine', /\b(skid ?steer|skidsteer|bobcat|mt ?\d{2,3}|excavator|mini ex|loader|tractor|backhoe|dozer|bulldozer|forklift|telehandler|atv|utv|side by side|rado|dingo|gator|kubota|mule|polaris|can am|rzr|zero turn|riding mower|rider|ride on)\b/],
    ['engine', /\b(chain ?saw|chainsaw|compactor|tamper|rammer|jumping jack|blower|blowers|trimmer|weed ?eater|weedeater|weed ?wh?acker|edger|mower|auger|post hole|generator|light tower|tiller|rototiller|sod cutter|brush ?cutter|power washer|pressure washer|stihl|echo|husqvarna|honda|kohler|briggs|cut ?off saw|concrete saw|demo saw|quick ?cut|quickie|pole saw|aerator|dethatcher|power rake|seeder|overseeder|trencher|stump grinder|snow ?blower|snowblower|log splitter|splitter|water pump|trash pump|power broom|small engines?)\b/],
    ['vehicle', /\b(truck|trucks|pickup|pick up|van|car|suv|f ?\d50|ram|silverado|sierra|tacoma|tundra|ranger|ford|chevy|chevrolet|gmc|dodge|toyota|jeep|vehicle|vehicles)\b/],
    ['electric', /\b(drill|drills|impact|driver|grinder|circular saw|circ saw|sawzall|reciprocating saw|recip saw|jig ?saw|miter saw|mitre saw|table saw|band saw|rotary hammer|hammer drill|heat gun|multi ?tool|oscillating|vacuum|shop vac|work light|radio|charger|laser|polisher|router|planer|nailer|compressor|power tools?|saw|saws)\b/],
  ];
  function wordsSay(text) {
    const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    const hit = WORDS.find(w => w[1].test(t));
    return hit ? hit[0] : null;
  }
  // The group the sort gives a machine that has none of the five yet:
  // { id, how }. Its old type was Machine or Vehicle, a type he typed, or
  // nothing. A Vehicle stays a Vehicle unless its name says trailer: the
  // one choice that still means the same -- a name saying otherwise (an
  // ATV kept as a vehicle, say) puts it on "Check these" instead of moving
  // it behind his back. A Machine was the only other choice there was, so
  // its name decides.
  function sortOne(g) {
    const old = String(g.kind || '').trim(), oldKey = old.toLowerCase();
    const said = wordsSay([g.name, isCatId(oldKey) ? '' : old, g.make, g.model].join(' '));
    if (oldKey === 'vehicle') {
      if (said === 'trailer') return { id: 'trailer', how: 'words' };
      return { id: 'vehicle', how: !said ? 'kind' : said === 'vehicle' ? 'words' : 'check' };
    }
    if (said) return { id: said, how: 'words' };
    if (isCatId(oldKey) && oldKey !== 'machine') return { id: oldKey, how: 'kind' };
    return { id: 'machine', how: 'check' };
  }
  // The group a machine is in -- a record, or a {name, kind} entry of the
  // crew's list. One not sorted yet (a type typed on a phone still on the
  // old code) shows where the sort would put it.
  function catOf(g) {
    if (!g) return 'machine';
    const k = String(g.kind || '').trim().toLowerCase();
    if (isCatId(k)) return k;
    return sortOne(g).id;
  }
  const kindName = k => catById(isCatId(k) ? k : catOf({ kind: k })).one;
  // Items in the five groups, in their order, each group keeping the items'
  // own order; empty groups left out. `recOf` gives an item's record (or
  // {name, kind}) when the items are not records themselves.
  function byCategory(items, recOf) {
    const of = recOf || (x => x);
    return CATEGORIES.map(c => ({ cat: c, items: (items || []).filter(x => catOf(of(x)) === c.id) }))
      .filter(gr => gr.items.length);
  }

  // Which meters a group goes by (Jonah's own split: hours for machines and
  // small engines, miles for vehicles, dates for every one). Trailers go by
  // date -- bearings, tires, registration -- and most battery tools by date
  // or nothing. Only which boxes are shown: a reading or interval already on
  // a machine is always shown and kept, whatever its group.
  const METERS = { vehicle: ['miles'], machine: ['hours'], engine: ['hours'], trailer: [], electric: [] };
  const usesMeter = (g, m) => METERS[catOf(g)].indexOf(m) !== -1 ||
    (m === 'hours' ? (g.hours != null || g.intervalHours != null || g.dueHours != null)
                   : (g.miles != null || g.intervalMiles != null || g.dueMiles != null));
  const METER_HINT = {
    vehicle: 'A truck goes by miles and months — set either or both.',
    machine: 'A machine goes by its hour meter and by months — set either or both.',
    engine: 'A small engine goes by running hours (if it has a meter) and by months.',
    trailer: 'A trailer goes by date — bearings, tires, registration.',
    electric: 'Most electric tools go by date, or need nothing at all.',
  };

  // Serviced by the mile: a vehicle, or anything with miles on it and no
  // hour meter, or a miles interval.
  const countsMiles = g => !!g && (g.kind === 'vehicle' || g.intervalMiles != null || (g.miles != null && g.hours == null));

  // How close to due counts as "coming up". Different units, same idea.
  const SOON = { days: 30, hours: 10, miles: 500 };

  // How urgent a noted problem is, most urgent first. Worded the way it gets
  // said in the yard, because the point is that anyone picking up the keys
  // knows at a glance whether they can use the thing.
  // The app's one scale for how soon (styles.css --st-*, Jonah 15 Oct
  // 2026): red, orange, yellow, grey. `was`: the colour before then, so the
  // Maintenance board's urgency labels still wearing it are brought over
  // (one the owner recoloured himself is left alone).
  const URGENCY = [
    { id: 'down', label: 'Out of service', hint: 'do not use it until it is fixed', color: '#c8492b', was: '#d64545' },
    { id: 'before', label: 'Before next use', hint: 'fix it before it goes out again', color: '#e8801f', was: '#e07b24' },
    { id: 'soon', label: 'Soon', hint: 'this week', color: '#f2c230', was: '#e0a526' },
    { id: 'whenever', label: 'When you have time', hint: 'not holding anything up', color: '#8a8f98', was: '#6b7a8f' },
  ];
  const urgencyOf = id => URGENCY.find(u => u.id === id) || URGENCY[URGENCY.length - 1];
  // A problem's urgency as the boards' own card urgency (boards.js URGENCY),
  // so a machine out of service sorts to the top of Maintenance, shows under
  // "🟠 Urgent & this week" and pings the owner like any urgent card
  // (functions/reminders.py _urgent_cards). Matched by colour on the one
  // scale: "Before next use" (orange) is 🟠 Today, as out of service is --
  // it said "🟡 This week" on its card, for a machine that may be wanted
  // tomorrow (regression pass, 16 Oct 2026) -- and "Soon" (yellow, "this
  // week") is 🟡 This week.
  const CARD_URGENCY = { down: 'urgent', before: 'urgent', soon: 'high', whenever: 'low' };
  const rankOf = id => { const i = URGENCY.findIndex(u => u.id === id); return i === -1 ? URGENCY.length : i; };
  // On the Maintenance board, a problem whose part has arrived says so --
  // and one whose part is on its way.
  const PART_LABEL = { id: 'part-at-shop', name: 'Part at shop', color: '#2f8f5b' };
  const ORDERED_LABEL = { id: 'part-ordered', name: 'Part ordered', color: '#56647a' };
  // A machine's service card someone moved to Done with no service logged
  // behind it (crew cannot log one; a form closed unsaved).
  const LOG_LABEL = { id: 'log-it', name: 'Log the service', color: '#3b7dd8' };

  // Problems are kept on the machine's record beside its service history, for
  // the same reason: a machine has a handful, and one document means one read
  // and a history that cannot half-load.
  //
  // Each has ONE status (Jonah, 15 Oct 2026: one status per record, not a
  // pile of yes/no boxes): Open -> Part ordered -> Part at the shop -> Fixed,
  // and back to Open when it was not fixed after all. stages.js says which
  // (YDStages.issue) and what a move writes (issuePatch): `status` beside
  // the old doneAt / partAtShop, kept in step for the board sync, the server
  // and any phone still on the old code.
  const stageOf = i => window.YDStages.issueId(i);
  const isFixed = i => stageOf(i) === 'fixed';
  const meWho = () => ({ uid: ((window.YDAuth && window.YDAuth.user) || {}).uid || '', name: whoAmI() });
  const openIssues = g => (g.issues || []).filter(i => !isFixed(i))
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
    // Repairs and the recurring tasks (a car wash) never move the next service.
    const service = (all || []).filter(e => e.kind !== 'repair' && e.kind !== 'task');
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

  // Equipment is the shop's screen (Jonah, 15 Oct 2026: "a board for
  // equipment where people add cards and there's a search bar to find the
  // piece of equipment ... in the same tab as equipment so it's like an
  // overview -- when people are working in the shop they check the equipment
  // tab and the board shows urgency levels and what needs to be done"). A
  // search over everything, then the shop board -- the Maintenance board,
  // the same one as on Boards: every machine's problems and services, most
  // urgent first, cards added from here -- or the machines themselves. The
  // crew cannot read the machines' records (costs, receipts), so they get
  // the board; it is shared with them.
  const VIEW_KEY = 'ydjobhub_eqView';
  let eqView = (() => { try { return localStorage.getItem(VIEW_KEY) === 'machines' ? 'machines' : 'board'; } catch (e) { return 'board'; } })();
  let eqSearch = '';
  let addingCard = false;
  const seesGear = () => typeof ydCan === 'function' && ydCan('equipment', 'see');
  const maintBoard = () => (window.YDBoards && YDBoards.boards ? YDBoards.boards()[MAINT] : null) || null;
  const viewNow = () => (seesGear() ? eqView : 'board');
  const searchWords = () => String(eqSearch || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (text, words) => { const t = String(text || '').toLowerCase(); return words.every(w => t.indexOf(w) !== -1); };

  // The machines by name, for the search and the + Add a card picker: their
  // own records for whoever sees them, else the names the office publishes
  // for the crew (settings/public.equipmentList, publishNames below).
  let publicNames = null;
  function loadPublicNames() {
    if (publicNames || seesGear() || !window.YDDb) return;
    publicNames = {};
    Promise.resolve(window.YDDb.get('settings', 'public')).then(p => {
      publicNames = ((p && p.equipmentList) || {});
      if (addingCard) renderAdd();
    }).catch(() => { publicNames = null; });
  }
  // In name order; `kind` is its group (one of the five).
  function machineList() {
    const src = seesGear() ? gear : (publicNames || {});
    const byName = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' }).compare;
    return Object.keys(src).filter(id => src[id]).map(id => ({ id: id, name: String(src[id].name || 'Machine'), kind: catOf(src[id]) }))
      .sort((a, b) => byName(a.name, b.name));
  }
  // The words a machine is found by: its name and its group, both ways
  // ("trailer", "small engines").
  const groupWords = k => { const c = catById(k); return c.one + ' ' + c.many; };
  const machineName = id => ((machineList().find(m => m.id === id) || {}).name || '');

  window.renderEquipment = function () {
    const wrap = el('eqWrap');
    if (!wrap) return;
    // Three parts, each redrawn on its own: the search box keeps its typing
    // and the add form its words while the board below changes.
    // Not "eqBody": that is the machine window's body (index.html), and a
    // second element of the same id here sent a machine's page into the tab
    // and left its window empty (16 Oct 2026).
    if (!el('eqTop')) wrap.innerHTML = '<div id="eqTop"></div><div id="eqAdd"></div><div id="eqList"></div>';
    renderBadge();
    renderTop();
    renderBody();
  };

  function renderTop() {
    const top = el('eqTop');
    if (!top) return;
    const view = viewNow(), sig = view + '|' + seesGear();
    if (top.dataset.sig === sig) return;
    top.dataset.sig = sig;
    const box = el('eqFind');
    const typed = box ? box.value : eqSearch;
    top.innerHTML =
      '<div class="eq-find"><input id="eqFind" type="search" autocomplete="off" enterkeyhint="search" ' +
        'placeholder="Find a machine, truck or trailer…" value="' + esc(typed) + '" oninput="eqFind(this.value)"></div>' +
      (seesGear() ? '<div class="eq-views" role="tablist">' +
        '<button type="button" role="tab" aria-selected="' + (view === 'board') + '" class="' + (view === 'board' ? 'on' : '') + '" onclick="eqShow(\'board\')">📋 Shop board</button>' +
        '<button type="button" role="tab" aria-selected="' + (view === 'machines') + '" class="' + (view === 'machines' ? 'on' : '') + '" onclick="eqShow(\'machines\')">🚜 Machines</button>' +
      '</div>' : '');
  }
  window.eqFind = function (v) { eqSearch = String(v || ''); renderBody(); };
  window.eqShow = function (v) {
    eqView = v === 'machines' ? 'machines' : 'board';
    try { localStorage.setItem(VIEW_KEY, eqView); } catch (e) { /* private window */ }
    renderTop(); renderBody();
  };

  function renderBody() {
    const body = el('eqList');
    if (!body) return;
    body.innerHTML = viewNow() === 'board' ? boardHtml() : machinesHtml();
  }

  // What a card is about, for the search: its words and its machine's name.
  function cardText(k) {
    const m = k.equipmentId ? machineList().find(x => x.id === k.equipmentId) : null;
    return [k.title, k.notes, m && m.name, m && groupWords(m.kind)].join(' ');
  }
  const canAddCard = () => (seesGear() && ydCan('equipment', 'change')) ||
    !!(window.YDBoards && YDBoards.editsBoard && YDBoards.editsBoard(MAINT));

  function boardHtml() {
    const b = maintBoard();
    if (!b) {
      return '<p class="empty-msg">' + (window.YDBoards && YDBoards.ready && YDBoards.ready()
        ? 'The Maintenance board isn’t shared with you yet — ask Jonah.' : 'Loading the board…') + '</p>';
    }
    const words = searchWords();
    // The machines the search names, a tap from their page.
    const found = words.length && seesGear() ? machineList().filter(m => hits(m.name + ' ' + groupWords(m.kind), words)).slice(0, 6) : [];
    const unsure = checkList();
    return '<div class="eq-bd-head"><span class="muted">' + (words.length
        ? 'The cards for “' + esc(eqSearch.trim()) + '”.'
        : 'What needs doing on every machine, the most urgent first — the Maintenance board, the same as on Boards.') + '</span>' +
        (canAddCard() && !addingCard ? '<button class="btn btn-sm btn-filled" onclick="eqAddCard()">+ Add a card</button>' : '') + '</div>' +
      // The machines the sort could not place wait on the Machines side; a
      // line here so they are not missed by someone who lives on the board.
      (unsure.length && !words.length ? '<button type="button" class="eq-check-nudge" onclick="eqShow(\'machines\')">⚠ ' +
        unsure.length + ' machine' + (unsure.length === 1 ? '' : 's') + ' to put in a group — check ' +
        (unsure.length === 1 ? 'it' : 'them') + ' ›</button>' : '') +
      (found.length ? '<div class="eq-found">' + found.map(m => '<button class="btn btn-sm" onclick="openEquipment(\'' + safeId(m.id) + '\')">' +
        catById(m.kind).icon + ' ' + esc(m.name) + '</button>').join('') + '</div>' : '') +
      YDBoards.columnsFor(MAINT, words.length ? k => hits(cardText(k), words) : null, waitingCards());
  }

  // Problems noted on a machine whose card is not on the board yet. Their
  // cards are made by the device of whoever runs both the machines and the
  // boards (syncMaintenance) -- so an admin who may change the machines but
  // only look at the boards added one here and the board said "Nothing
  // here" until Jonah's Job Hub was next open (office testing, 16 Oct 2026).
  // Drawn from the machine's own record until then, marked as on their way,
  // and never written from here: the card is that device's to make. Only
  // once the board's cards have come from the server -- before that, every
  // problem would look card-less.
  function waitingCards() {
    if (!seesGear() || !window.YDBoards || !YDBoards.cardsReady || !YDBoards.cardsReady(MAINT)) return [];
    const have = (YDBoards.cards()[MAINT]) || {};
    const out = [];
    Object.values(gear).forEach(g => (g.issues || []).forEach(i => {
      // A fixed one never gets a card made again (its card may have been
      // deleted with the board's done cards).
      if (!i || !i.id || i.doneAt || have['eqi-' + g.id + '-' + i.id]) return;
      // From a shop card still being put on its machine: that card shows.
      if (String(i.id).indexOf('is') === 0 && have['eqc' + String(i.id).slice(2)]) return;
      const u = urgencyOf(i.urgency);
      out.push({
        waiting: true, id: 'eqw-' + g.id + '-' + i.id, equipmentId: g.id,
        title: (g.name || 'Machine') + ' — ' + i.what, notes: i.note || '',
        labels: ['u-' + u.id], urgency: CARD_URGENCY[u.id] || 'normal',
        // Where its card will start (a shop card's column), last of its urgency.
        column: i.boardColumn || '', order: Date.parse(i.at || '') || Date.now(),
      });
    }));
    return out;
  }

  // + Add a card: which machine (or the shop), what, how urgent. Put on the
  // machine itself by whoever may change the machines -- its card follows
  // (syncMaintenance) and its history keeps it; by anyone else as a card
  // (eqc-…), which the office's device then puts on the machine the same way.
  window.eqAddCard = function () {
    if (!canAddCard()) return;
    addingCard = true;
    loadPublicNames();
    renderAdd(); renderBody();
    const f = el('ecWhat');
    if (f && el('ecMachine') && el('ecMachine').value) f.focus();
  };
  window.eqCancelCard = function () { addingCard = false; renderAdd(); renderBody(); };
  function renderAdd() {
    const box = el('eqAdd');
    if (!box) return;
    if (!addingCard) { box.innerHTML = ''; return; }
    const list = machineList();
    // The search names one machine: it is the one picked.
    const words = searchWords();
    const only = words.length ? list.filter(m => hits(m.name + ' ' + groupWords(m.kind), words)) : [];
    const pre = only.length === 1 ? only[0].id : '';
    // In the five groups, each its own block (and its icon and name on each
    // line, which is what the type-to-search list shows -- "trailer" finds
    // every trailer).
    box.innerHTML = '<div class="eq-addcard">' +
      '<div class="field"><span class="label">Which machine</span><select id="ecMachine" class="searchable">' +
        '<option value="">— Pick the machine —</option><option value="__shop">The shop — not one machine</option>' +
        byCategory(list, m => ({ kind: m.kind })).map(gr => '<optgroup label="' + esc(gr.cat.icon + ' ' + gr.cat.many) + '">' +
          gr.items.map(m => '<option value="' + esc(m.id) + '"' + (m.id === pre ? ' selected' : '') + '>' +
            esc(gr.cat.icon + ' ' + m.name + ' (' + gr.cat.one + ')') + '</option>').join('') + '</optgroup>').join('') +
        '</select></div>' +
      '<div class="field"><span class="label">What needs doing</span><input id="ecWhat" autocomplete="off" placeholder="e.g. Hydraulic leak at the bucket cylinder"></div>' +
      '<div class="field"><span class="label">How urgent</span><div class="eq-urg-pick">' +
        URGENCY.map(u => '<label class="eq-urg-opt" style="--c:' + u.color + '"><input type="radio" name="ecUrg" value="' + u.id + '"' +
          (u.id === 'soon' ? ' checked' : '') + '><span><b>' + esc(u.label) + '</b><small>' + esc(u.hint) + '</small></span></label>').join('') +
      '</div></div>' +
      '<div class="field"><span class="label">Notes <span class="muted">(optional)</span></span><textarea id="ecNote" rows="2"></textarea></div>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="eqSaveCard()">Add it</button>' +
        '<button class="btn btn-sm" onclick="eqCancelCard()">Cancel</button></div>' +
    '</div>';
    box.querySelectorAll('select.searchable').forEach(s => { if (typeof makeSearchable === 'function') makeSearchable(s); });
  }
  window.eqSaveCard = function () {
    const mid = val('ecMachine'), what = val('ecWhat'), note = val('ecNote');
    if (!mid) { showToast('Pick the machine — or The shop'); return; }
    if (!what) { showToast('Say what needs doing'); return; }
    const pick = document.querySelector('input[name="ecUrg"]:checked');
    const u = urgencyOf(pick ? pick.value : 'soon');
    const g = mid !== '__shop' ? gear[mid] : null;
    const now = new Date().toISOString();
    if (g && ydCan('equipment', 'change')) {
      const issue = { id: 'is' + Date.now().toString(36), what: what, urgency: u.id, note: note, partAtShop: false,
                      status: 'open', statusChange: window.YDStages.stamp('open', meWho()),
                      at: now, by: whoAmI(), doneAt: null };
      g.issues = (g.issues || []).concat([issue]);
      write(g.id, { issues: g.issues }, 'noting a problem');
      scheduleMaintSync();
    } else if (window.YDBoards && YDBoards.editsBoard && YDBoards.editsBoard(MAINT)) {
      const b = maintBoard();
      const name = mid === '__shop' ? '' : machineName(mid);
      const id = 'eqc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const card = {
        title: (name ? name + ' — ' : '') + what,
        notes: u.label + ' (' + u.hint + ').' + (note ? '\n\n' + note : ''),
        labels: ['u-' + u.id], urgency: CARD_URGENCY[u.id] || 'normal',
        equipmentId: mid === '__shop' ? null : mid, eqUrgency: u.id, what: what, eqNote: note,
        column: b.columns[0].id, order: Date.now(), checklist: [],
        createdAt: now, createdBy: whoAmI(), updatedAt: now, updatedBy: whoAmI(),
      };
      Promise.resolve(window.YDDb.put('boards/' + MAINT + '/cards', id, card))
        .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed to add cards to the Maintenance board — ask Jonah' : 'Saved on this phone — it goes up with signal'));
    } else {
      showToast('Ask Jonah to let you add cards to the Maintenance board');
      return;
    }
    addingCard = false;
    renderAdd(); renderBody();
    showToast(u.label + ' — ' + what);
  };

  // The count beside the heading, whichever view is showing.
  function renderBadge() {
    const all = Object.values(gear);
    const overdue = all.filter(g => due(g).state === 'overdue');
    const soon = all.filter(g => due(g).state === 'soon');
    const down = all.filter(g => (worstIssue(g) || {}).urgency === 'down');
    const badge = el('eqBadge');
    if (badge) {
      badge.textContent = down.length ? down.length + ' out of service'
        : overdue.length ? overdue.length + ' overdue'
        : soon.length ? soon.length + ' coming up' : '';
      // Out of service or overdue is the "act now" colour (styles.css
      // .eq-alert), not the gold every other section's count wears.
      badge.className = 'section-badge' + (down.length || overdue.length ? ' eq-alert' : soon.length ? ' eq-soon' : '');
    }
  }

  function machinesHtml() {
    // The search: a machine's name, type, make, model, number, or what is
    // wrong with it.
    const words = searchWords();
    const matches = g => !words.length ||
      hits([g.name, groupWords(catOf(g)), g.make, g.model, g.year, g.serial, g.plate, g.notes]
        .concat(openIssues(g).map(i => i.what)).join(' '), words);
    const all = Object.values(gear).filter(matches);
    // Anything but the five, Everything and the warranty list (an old saved
    // type filter): back to everything.
    if (filter !== 'all' && filter !== 'warranty' && !isCatId(filter)) filter = 'all';
    // Within its group, the machines that must not go out -- out of
    // service, to be fixed before it is used, or past its service -- come
    // first; then a service coming up or any other problem; then the rest,
    // each lot in name order, so a machine keeps its place while its meter
    // creeps up.
    const groupOf = g => {
      const w = worstIssue(g), state = due(g).state;
      if ((w && (w.urgency === 'down' || w.urgency === 'before')) || state === 'overdue') return 0;
      return w || state === 'soon' ? 1 : 2;
    };
    // Within a group the most pressing first (a problem's urgency, then a
    // service due), then by name.
    const rank = g => {
      const w = worstIssue(g);
      const u = w ? URGENCY.findIndex(x => x.id === w.urgency) : -1;
      return (u < 0 ? URGENCY.length : u) * 2 + (due(g).state === 'overdue' || due(g).state === 'soon' ? 0 : 1);
    };
    const byName = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' }).compare;
    const list = all
      .filter(g => filter === 'all' || catOf(g) === filter)
      .map(g => ({ g, group: groupOf(g), rank: rank(g) }))
      .sort((a, b) => a.group - b.group || a.rank - b.rank || byName(String(a.g.name || ''), String(b.g.name || '')) ||
        String(a.g.id).localeCompare(String(b.g.id)));
    // Under the five groups' headings (Jonah, 16 Oct 2026), each with how
    // many it holds -- and, in the "act now" colour, how many of them must
    // not go out as they are.
    const cards = byCategory(list, x => x.g).map(gr => {
      const now = gr.items.filter(x => x.group === 0).length;
      return '<div class="eq-cat-h" data-cat="' + gr.cat.id + '"><span class="eq-cat-name">' + gr.cat.icon + ' ' + esc(gr.cat.many) + '</span>' +
          '<span class="eq-cat-n">' + gr.items.length + '</span>' +
          (now ? '<span class="eq-cat-now">' + now + ' need' + (now === 1 ? 's' : '') + ' attention now</span>' : '') + '</div>' +
        gr.items.map(x => card(x.g)).join('');
    }).join('');
    // How many each group holds, for its button (the search left out: the
    // buttons say what is in the yard).
    const counts = {};
    Object.values(gear).forEach(g => { const c = catOf(g); counts[c] = (counts[c] || 0) + 1; });
    const total = Object.keys(gear).length;
    const n = k => '<span class="eq-chip-n">' + (k || 0) + '</span>';

    // + Add first, then the groups as buttons, all in sight -- three to a
    // row on a phone, never a row to swipe along.
    return '<div class="eq-tools">' +
        '<button class="btn btn-sm btn-accent eq-add" onclick="editEquipment(\'\')">+ Add</button>' +
        '<div class="filter-bar eq-filters">' +
          ['all'].concat(CAT_IDS, ['warranty']).map(f =>
            '<button class="btn btn-sm' + (filter === f ? ' btn-filled' : '') +
            '" onclick="filterEquipment(' + esc(JSON.stringify(f)) + ')">' +
            (f === 'all' ? 'Everything ' + n(total) : f === 'warranty' ? '🛡 Under warranty'
              : catById(f).icon + ' ' + esc(catById(f).many) + ' ' + n(counts[f])) + '</button>').join('') +
        '</div>' +
      '</div>' +
      (filter === 'warranty' ? '' : checkHtml(matches)) +
      (filter === 'warranty' ? warrantyHtml()
        : list.length
        ? cards
        : words.length ? '<p class="empty-msg">No machine matches “' + esc(eqSearch.trim()) + '”' +
            (filter !== 'all' ? ' in ' + esc(catById(filter).many) : '') + '.</p>'
        : filter !== 'all' ? '<p class="empty-msg">No ' + esc(catById(filter).many.toLowerCase()) + ' yet.</p>'
        : '<p class="empty-msg">Nothing here yet. Add a machine or a truck and start ' +
          'writing down what gets done to it.</p>');
  }

  window.filterEquipment = function (f) { filter = f; renderEquipment(); };

  // ---------------------------------------------------- "Check these"
  //
  // What the sort could not place from the words in its name (or a Vehicle
  // whose name says otherwise), each with the five groups as buttons: one
  // tap puts it in a group for good. Only for whoever may change the
  // machines; the rest see each one where it was put.
  function checkList() {
    if (!seesGear() || !ydCan('equipment', 'change')) return [];
    const byName = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' }).compare;
    return Object.values(gear).filter(g => g.kindHow === 'check')
      .sort((a, b) => byName(String(a.name || ''), String(b.name || '')));
  }
  function catButtons(g, small) {
    const cur = catOf(g), said = g.kindHow === 'check' ? wordsSay([g.name, g.make, g.model].join(' ')) : null;
    return '<div class="eq-cat-pick' + (small ? ' eq-cat-pick-sm' : '') + '" role="group" aria-label="Which group">' +
      CATEGORIES.map(c => '<button type="button" class="eq-cat-btn' + (c.id === cur ? ' on' : '') +
        (said && said === c.id && said !== cur ? ' said' : '') + '"' + (c.id === cur ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        ' onclick="eqSetCat(\'' + safeId(g.id) + '\',\'' + c.id + '\')">' + c.icon + ' ' + esc(c.one) + '</button>').join('') +
    '</div>';
  }
  function checkHtml(matches) {
    const rows = checkList().filter(matches || (() => true));
    if (!rows.length) return '';
    return '<div class="eq-check"><div class="eq-check-h">⚠ Check these ' + rows.length + '</div>' +
      '<p class="hint">Job Hub could not tell from ' + (rows.length === 1 ? 'its name which group this is' : 'their names which group each is') +
        ' in. Tap the right one — the lit one if it is already right.</p>' +
      rows.map(g => {
        const was = String(g.kindBefore || '').trim();
        const said = wordsSay([g.name, g.make, g.model].join(' '));
        return '<div class="eq-check-row"><div class="eq-check-name">' +
            '<button type="button" class="link-btn" onclick="openEquipment(\'' + safeId(g.id) + '\')"><b>' + esc(g.name || 'Machine') + '</b></button>' +
            (was && was.toLowerCase() !== catOf(g) ? ' <span class="muted">— was “' + esc(was) + '”</span>' : '') +
            (said && said !== catOf(g) ? ' <span class="muted">· its name says ' + esc(catById(said).one) + '</span>' : '') +
          '</div>' + catButtons(g, true) + '</div>';
      }).join('') + '</div>';
  }

  // A machine put in a group by hand: on the "Check these" list, its own
  // page, or the edit form. A tap on the group it is already in is the
  // "yes, that's right" that takes it off the list.
  window.eqSetCat = function (id, cat) {
    const g = gear[id];
    if (!g || !isCatId(cat)) return;
    if (!ydCan('equipment', 'change')) { showToast('You can look at the machines but not change them'); return; }
    const was = catOf(g);
    if (was === cat && g.kindHow !== 'check' && isCatId(String(g.kind || ''))) return;
    const patch = { kind: cat, kindHow: 'hand' };
    // A type typed before the five, kept the once (the sort keeps it the same way).
    if (g.kindBefore === undefined && !isCatId(String(g.kind || '').toLowerCase())) patch.kindBefore = String(g.kind || '');
    Object.assign(g, patch);
    write(g.id, patch, 'putting it in a group');
    if (openId === id && !editingId) {
      // Not over a service or problem being typed on its page: only the
      // group buttons and the line under the name change.
      if (!notingIssue && !el('svWhat')) renderDetail();
      else {
        const pick = el('eqCatHere'); if (pick) pick.innerHTML = catButtons(g);
        const sub = el('eqSubCat'); if (sub) sub.textContent = catById(cat).one;
      }
    }
    renderEquipment();
    scheduleMaintSync();      // the crew's list of names and groups (publishNames)
    showToast((g.name || 'Machine') + (was === cat ? ' — stays in ' : ' → ') + catById(cat).many);
  };

  // "Marked done on the board" -- the service card sits in Done but nothing
  // was logged, so the machine still counts toward its old due point.
  function markedLine(g) {
    const k = window.YDBoards && YDBoards.cards ? ((YDBoards.cards()['maintenance'] || {})['eq-' + g.id]) : null;
    if (!k || !k.markedDoneBy) return '';
    return '<div class="eq-marked">✔ ' + esc(k.markedDoneBy) + ' marked the service done' +
      (k.markedDoneAt ? ' ' + shortDate(k.markedDoneAt) : '') + ' — log it so the next one counts from it</div>';
  }

  // The whole card opens the machine -- by a tap, or by Tab then Enter (or
  // Space) for a keyboard, as the service history's rows do. Its group is
  // the heading it sits under, so the card does not say it again.
  function card(g) {
    const d = due(g);
    const l = last(g);
    const id = safeId(g.id);
    return '<div class="eq eq-' + d.state + '" role="button" tabindex="0" onclick="openEquipment(\'' + id + '\')" ' +
        'onkeydown="if(event.target===this&&(event.key===\'Enter\'||event.key===\' \')){event.preventDefault();openEquipment(\'' + id + '\')}">' +
      '<div class="eq-top">' +
        '<span class="eq-name">' + esc(g.name) + '</span>' +
        '<span class="eq-due ' + d.state + '">' + d.text + '</span>' +
      '</div>' +
      (g.make || g.model || g.year
        ? '<div class="eq-what">' + esc([g.year, g.make, g.model].filter(Boolean).join(' ')) + '</div>'
        : '') +
      issueLine(g) +
      markedLine(g) +
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
    // Its status, once it is past Open: the part on order, or at the shop.
    const st = window.YDStages.issue(open[0]);
    return '<div class="eq-issue" style="--c:' + u.color + '">' +
      '<span class="eq-urg u-' + esc(u.id) + '">' + esc(u.label) + '</span> ' + esc(open[0].what) +
      (st.id !== 'open' ? ' ' + window.YDStages.chip(st, { when: false }) : '') +
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

    const cat = catById(catOf(g));
    body.innerHTML =
      '<div class="eq-head">' +
        '<div>' +
          '<div class="eq-sub">' + cat.icon + ' <span id="eqSubCat">' + esc(cat.one) + '</span>' +
            (g.year || g.make || g.model
              ? ' · ' + esc([g.year, g.make, g.model].filter(Boolean).join(' ')) : '') +
          '</div>' +
          // Trailers carry a VIN too.
          (g.serial ? '<div class="eq-serial">' +
            (cat.id === 'vehicle' || cat.id === 'trailer' ? 'VIN ' : 'Serial ') + esc(g.serial) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-sm" onclick="editEquipment(\'' + g.id + '\')">Edit</button>' +
      '</div>' +
      // Its group, one tap to move it to another (only for whoever may
      // change the machines; the rest read it above).
      (ydCan('equipment', 'change') ? '<div class="eq-cat-here"><span class="eq-cat-here-l">Group</span><div id="eqCatHere">' +
        catButtons(g) + '</div></div>' : '') +

      // Only the meters it goes by (its group's, or one it already has a
      // reading for): a trailer or a battery drill has neither.
      '<div class="eq-cards">' +
        eqCard('Next service', d.text, d.state) +
        (usesMeter(g, 'hours') ? eqCard('Hours', g.hours != null ? round1(g.hours) : '—', '') : '') +
        (usesMeter(g, 'miles') ? eqCard('Miles', g.miles != null ? fmtNum(g.miles) : '—', '') : '') +
        eqCard('Spent on it', spent ? money(spent) : '—', '') +
      '</div>' +

      (g.notes ? '<div class="eq-notes">' + esc(g.notes) + '</div>' : '') +

      issuesHtml(g) +
      repairTimeHtml(g) +
      receiptsHtml(g) +

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
                (e.kind === 'task' ? ' <span class="eq-repair">recurring</span>' : '') +
                '<span class="eq-log-sub">' + [reading, e.by ? esc(e.by) : ''].filter(Boolean).join(' · ') + '</span>' +
                ((e.parts || []).length ? '<span class="eq-log-sub">Parts: ' + e.parts.map(p => esc(p.name) +
                  (p.warranty ? ' 🛡 ' + esc(warrantyLeft(g, e, p).text) : '')).join(' · ') + '</span>' : '') +
              '</span>' +
              '<span class="eq-log-cost">' + (e.costCents ? money(e.costCents) : '') + '</span>' +
              '<span class="eq-log-edit">Edit ›</span>' +
              '<button class="remove-btn" onclick="event.stopPropagation();removeService(\'' + safeId(e.id) + '\')" ' +
                'title="Remove">&times;</button>' +
            '</div>';
          }).join('') + '</div>'
        : '<p class="empty-msg">Nothing logged yet.</p>');
  }

  // Receipts sorted to this vehicle or machine on the Receipts tab (Jonah,
  // 9 Oct 2026; receipts.js, a split with to 'vehicle'): fuel, parts,
  // repairs. Read from the receipts, never copied here -- and kept apart from
  // "Spent on it", which is what was logged with services, so the same
  // repair is never counted twice.
  function receiptsHtml(g) {
    if (!window.YDReceipts || !ydCan('jobs', 'see')) return '';
    const rows = [];
    Object.values(YDReceipts.all() || {}).forEach(r => (r.splits || []).forEach(s => {
      if (s.to === 'vehicle' && s.equipmentId === g.id) rows.push({ r, s });
    }));
    if (!rows.length) return '';
    rows.sort((a, b) => String(b.r.date || '').localeCompare(String(a.r.date || '')));
    const year = String(new Date().getFullYear());
    const cents = x => (x.s.cents || 0) + (x.s.taxCents || 0);
    const thisYear = rows.filter(x => String(x.r.date || '').slice(0, 4) === year).reduce((t, x) => t + cents(x), 0);
    return '<div class="eq-loghead">🧾 Receipts <span class="muted">' + money(thisYear) + ' this year</span></div>' +
      '<div class="eq-log">' + rows.slice(0, 15).map(x => '<div class="eq-log-row eq-rc-row">' +
        '<span class="eq-log-when">' + shortDate(x.r.date) + '</span>' +
        '<span class="eq-log-what"><b>' + esc(x.r.vendor || 'Receipt') + '</b>' +
          (x.r.summary ? '<span class="eq-log-sub">' + esc(x.r.summary) + '</span>' : '') + '</span>' +
        '<span class="eq-log-cost">' + money(cents(x)) + '</span>' +
        (x.r.link && /^https:\/\/mail\.google\.com\//.test(x.r.link)
          ? '<a class="btn btn-sm" href="' + esc(x.r.link) + '" target="_blank" rel="noopener">Email</a>' : '') +
      '</div>').join('') + '</div>' +
      (rows.length > 15 ? '<div class="hint">The newest 15 — the rest are on the Receipts tab (🚚 Vehicles).</div>' : '');
  }
  // A receipt sorted while the machine is open shows at once -- but not over
  // a form being filled in on it (the same guard as a change to the machine
  // from another device): receipts arrive whenever the mail is read, and a
  // redraw then wiped a half-typed service or problem.
  document.addEventListener('yd-receipts', () => {
    if (openId && gear[openId] && !editingId && !notingIssue && !el('svWhat')) renderDetail();
  });

  // Time clocked on this machine as Equipment repair (timeclock.js, Jonah
  // 15 Oct 2026: "in a couple years we'll have accurate time info on how
  // long it takes to do every bit of maintenance"). Read from the shifts,
  // never copied here. Only for whoever sees everyone's hours -- crew never
  // see other people's hours. Settled shifts make the totals; ones still
  // waiting for approval, or running now, are listed and marked.
  const fmtHours = msec => {
    const h = Math.round(msec / 360000) / 10;
    return (h % 1 ? h.toFixed(1) : String(h)) + ' h';
  };
  function repairTimeHtml(g) {
    if (!window.YDClock || !YDClock.repairsOn || !ydCan('hours', 'see')) return '';
    const rows = YDClock.repairsOn(g.id);
    if (!rows.length) return '';
    const year = new Date().getFullYear();
    const settled = rows.filter(r => r.settled);
    const all = settled.reduce((t, r) => t + r.ms, 0);
    const thisYear = settled.filter(r => new Date(r.at).getFullYear() === year).reduce((t, r) => t + r.ms, 0);
    const waiting = rows.length - settled.length;
    return '<div class="eq-loghead">🔧 Repair time <span class="muted">' + fmtHours(thisYear) + ' this year · ' +
        fmtHours(all) + ' in all' + (waiting ? ' · ' + waiting + ' not approved yet' : '') + '</span></div>' +
      '<div class="eq-log">' + rows.slice(0, 20).map(r => '<div class="eq-log-row eq-rp-row">' +
        '<span class="eq-log-when">' + shortDate(r.at) + '</span>' +
        '<span class="eq-log-what"><b>' + esc(r.who) + '</b>' +
          (r.what ? '<span class="eq-log-sub">' + esc(r.what) + '</span>' : '') +
          (r.running ? '<span class="eq-log-sub">On the clock now</span>'
            : !r.settled ? '<span class="eq-log-sub">Waiting for approval</span>' : '') + '</span>' +
        '<span class="eq-log-cost">' + (YDClock.fmtDur ? YDClock.fmtDur(r.ms) : fmtHours(r.ms)) + '</span>' +
      '</div>').join('') + '</div>' +
      (rows.length > 20 ? '<div class="hint">The newest 20 — every one is in the Work Log on the Clock tab.</div>' : '');
  }
  // A shift clocked while the machine is open shows on it -- not over a form
  // being filled in (the same guard as for receipts).
  document.addEventListener('yd-clock-changed', () => {
    if (openId && gear[openId] && !editingId && !notingIssue && !el('svWhat')) renderDetail();
  });

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

  // A problem's status as a row of tap buttons (wrapping on a phone): Open,
  // Part ordered (so nobody orders it twice), Part at the shop (so the job
  // can be booked in), Fixed -- which opens the service log, so the repair
  // goes into the history (fixIssue). `onclick` gives each button's handler:
  // an open problem's (issueStage), or the new-problem form's (isStagePick),
  // which has no Fixed and calls Open "No part on order".
  function stageStepsHtml(cur, onclick, withFixed) {
    return '<div class="stage-steps eq-stage-steps">' + window.YDStages.ISSUE_STAGES
      .filter(s => withFixed || s.id !== 'fixed')
      .map(s => '<button type="button" class="stage-step' + (s.id === cur ? ' on' : '') + '" data-st="' + s.id + '"' +
        (s.id === cur ? ' aria-current="step"' : '') + ' onclick="' + onclick(s.id) + '">' +
        esc(s.id === 'open' && !withFixed ? 'No part on order' : s.name) + '</button>').join('') + '</div>';
  }

  function issuesHtml(g) {
    const open = openIssues(g);
    const fixed = (g.issues || []).filter(isFixed)
      .sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 5);
    const S = window.YDStages;
    return '<div class="eq-loghead">Needs doing' +
        (notingIssue ? '' : '<button class="btn btn-sm btn-accent" onclick="noteIssue()">+ Note a part or service</button>') +
      '</div>' +
      (notingIssue ? issueFormHtml() : '') +
      (open.length
        ? '<div class="eq-issues">' + open.map(i => {
            const u = urgencyOf(i.urgency);
            const st = S.issue(i);
            const iid = safeId(i.id);
            return '<div class="eq-issue-row" style="--c:' + u.color + '">' +
              '<div class="eq-issue-main">' +
                '<span class="eq-urg u-' + esc(u.id) + '">' + esc(u.label) + '</span>' +
                '<div class="eq-issue-what">' + esc(i.what) + '</div>' +
                (i.note ? '<div class="eq-issue-note">' + esc(i.note) + '</div>' : '') +
                '<div class="eq-issue-meta">Noted ' + shortDate(i.at) + (i.by ? ' by ' + esc(i.by) : '') + '</div>' +
                // Where it stands, once it is past Open: since when, and who said.
                (st.id !== 'open' ? '<div class="eq-stage-line">' + S.chip(st) + '</div>' : '') +
                stageStepsHtml(st.id, id => "issueStage('" + iid + "','" + id + "')", true) +
              '</div>' +
              '<div class="eq-issue-act">' +
                '<button class="remove-btn" onclick="removeIssue(\'' + iid + '\')" title="Delete">&times;</button>' +
              '</div>' +
            '</div>';
          }).join('') + '</div>'
        : (notingIssue ? '' : '<p class="empty-msg">Nothing noted. If something is wrong with it, note it here so it does not get forgotten.</p>')) +
      (fixed.length
        ? '<div class="eq-fixed">Fixed recently: ' + fixed.map(i =>
            esc(i.what) + ' ' + S.chip(S.issue(i)) +
            ' <button class="link-btn" onclick="reopenIssue(\'' + safeId(i.id) + '\')" title="It was not actually fixed">Not fixed</button>').join(' · ') + '</div>'
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
      '<div class="field" id="isStage"><span class="label">The part</span>' +
        stageStepsHtml('open', id => "isStagePick(this)", false) + '</div>' +
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
    // Where it starts: nothing on order yet, the part ordered, or already here.
    const on = document.querySelector('#isStage .stage-step.on');
    const stage = on && ['ordered', 'atshop'].indexOf(on.dataset.st) !== -1 ? on.dataset.st : 'open';
    const issue = {
      id: 'is' + Date.now().toString(36),
      what: what,
      urgency: pick ? pick.value : 'soon',
      note: val('isNote'),
      partAtShop: stage === 'atshop',
      status: stage,
      statusChange: window.YDStages.stamp(stage, meWho()),
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
  // The new-problem form's part buttons: one lit at a time.
  window.isStagePick = function (btn) {
    if (!btn || !btn.parentNode) return;
    btn.parentNode.querySelectorAll('.stage-step').forEach(b => {
      b.classList.toggle('on', b === btn);
      if (b === btn) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
  };

  // One problem moved to another status: `status` and the old fields together
  // (stages.js issuePatch). Reopening stamps reopenedAt, so a card left in
  // Done from before is not read as a fresh "fixed" (syncMaintenance).
  function setIssueStage(g, issueId, to) {
    g.issues = (g.issues || []).map(i => i.id === issueId
      ? Object.assign({}, i, window.YDStages.issuePatch(i, to, meWho())) : i);
    write(g.id, { issues: g.issues }, to === 'fixed' ? 'marking a problem fixed' : 'moving a problem to ' + to);
  }
  // Fixed, or back to Open -- the board sync's two moves.
  function setIssueDone(g, issueId, done) { setIssueStage(g, issueId, done ? 'fixed' : 'open'); }

  // Ticked "Fixed" by mistake: back on the list, and its Maintenance card
  // back out of Done.
  window.reopenIssue = function (issueId) {
    const g = gear[openId];
    if (!g || !(g.issues || []).some(i => i.id === issueId)) return;
    setIssueDone(g, issueId, false);
    renderDetail(); renderEquipment();
    showToast('Back on the list');
  };

  // A status button on an open problem. Fixed goes through the service log
  // (fixIssue); the rest are one tap -- and the old "Part at shop" tick is
  // the "Part at the shop" button now.
  window.issueStage = function (issueId, to) {
    const g = gear[openId];
    const i = g && (g.issues || []).find(x => x.id === issueId);
    if (!i || ['open', 'ordered', 'atshop', 'fixed'].indexOf(to) === -1) return;
    if (!ydCan('equipment', 'change')) { showToast('You can look at the machines but not change them'); return; }
    if (to === 'fixed') { window.fixIssue(issueId); return; }
    if (stageOf(i) === to) return;
    setIssueStage(g, issueId, to);
    renderDetail(); renderEquipment();
    showToast({ open: 'Open — no part on order', ordered: 'Part ordered', atshop: 'Part at the shop' }[to]);
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

  window.removeIssue = async function (issueId) {
    let g = gear[openId];
    if (!g) return;
    const i = (g.issues || []).find(x => x.id === issueId);
    if (!i || !(await ydConfirm('Use Fixed instead if it was done — that keeps a record.', { title: 'Delete "' + i.what + '"?', ok: 'Delete', danger: true }))) return;
    g = gear[g.id];
    if (!g || !(g.issues || []).some(x => x.id === issueId)) return;
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
    // The reading boxes its group goes by (or that this entry or machine
    // already has); the others behind "+ Hours or miles" -- a trailer's
    // bearings or a battery saw's blade want neither.
    const showH = usesMeter(g, 'hours') || !!(e && e.hours != null);
    const showM = usesMeter(g, 'miles') || !!(e && e.miles != null);

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
          '<div class="field eq-m' + (showH ? '' : ' eq-m-off') + '"><span class="label">' + (e ? 'Hours then' : 'Hours now') +
            (!e && readingWanted(g) === 'hours' ? ' <b class="eq-need">*</b>' : '') + '</span>' +
            '<input id="svHours" inputmode="decimal" value="' + (e ? has(e.hours) : '') + '" placeholder="' +
            (g.hours != null ? 'last ' + round1(g.hours) : 'optional') + '"></div>' +
          '<div class="field eq-m' + (showM ? '' : ' eq-m-off') + '"><span class="label">' + (e ? 'Miles then' : 'Miles now') +
            (!e && readingWanted(g) === 'miles' ? ' <b class="eq-need">*</b>' : '') + '</span>' +
            '<input id="svMiles" inputmode="numeric" value="' + (e ? has(e.miles) : '') + '" placeholder="' +
            (g.miles != null ? 'last ' + fmtNum(g.miles) : 'optional') + '"></div>' +
          '<div class="field"><span class="label">Who did it</span>' +
            '<input id="svBy" placeholder="you, or the shop" value="' + (e ? has(e.by) : '') + '"></div>' +
        '</div>' +
        (showH || showM
          ? '<div class="hint">Putting the ' + (showH && showM ? 'hours or miles' : showH ? 'hours' : 'miles') +
              ' in is what lets the next service be worked out. Leave ' + (showH && showM ? 'them' : 'it') +
              ' blank if this one goes by date.</div>'
          : '<div class="hint">' + esc(catById(catOf(g)).many) + ' go by date — no hours or miles needed.</div>') +
        (!showH || !showM ? '<button type="button" class="link-btn eq-m-more" onclick="eqShowMeters(this)">+ ' +
          (!showH && !showM ? 'Hours or miles' : !showH ? 'Hours' : 'Miles') + ' too</button>' : '') +
        '<div class="eq-parts-head">Parts <span class="muted">— list any with a warranty, so it can be found when one fails</span></div>' +
        '<div id="svParts"></div>' +
        '<button class="btn btn-sm" type="button" onclick="addPartRow()">+ Add a part</button>' +
        '<div class="field-actions">' +
          '<button class="btn btn-filled" onclick="saveService()">' +
            (e ? 'Save changes' : fixing ? 'Save — mark it fixed' : 'Save') + '</button>' +
          '<button class="btn btn-sm" onclick="renderDetail2()">Cancel</button>' +
        '</div>' +
      '</div>');
    formParts = (e && Array.isArray(e.parts) ? e.parts : []).map(p => ({
      id: p.id, name: p.name || '', vendor: p.vendor || '',
      cost: p.costCents != null ? String(p.costCents / 100) : '',
      months: p.warranty && p.warranty.months != null ? String(p.warranty.months) : '',
      miles: p.warranty && p.warranty.miles != null ? String(p.warranty.miles) : '',
    }));
    renderPartRows();
    const form = el('eqServiceForm');
    if (form && form.scrollIntoView) form.scrollIntoView({ block: 'nearest' });
    const w = el('svWhat'); if (w) w.focus();
  }

  // ------------------------------------------------------- parts & warranty
  //
  // Jonah (5 Oct 2026): "a warrantee checkbox for parts purchased for vehicle
  // with a tag and to input the warrantee time so i can easily find what can
  // be warranteed." A service lists its parts; one with a warranty -- months
  // and/or miles, whichever runs out first -- shows 🛡 and is in the Under
  // warranty view until it runs out.
  let formParts = [];
  function readPartRows() {
    formParts = formParts.map((p, i) => ({
      id: p.id, name: val('svpName' + i), vendor: val('svpVendor' + i), cost: val('svpCost' + i),
      months: val('svpMonths' + i), miles: val('svpMiles' + i),
    }));
  }
  function renderPartRows() {
    const box = el('svParts');
    if (!box) return;
    const has = v => esc(String(v == null ? '' : v));
    box.innerHTML = formParts.map((p, i) => '<div class="eq-part-row">' +
      '<input id="svpName' + i + '" placeholder="Part, e.g. alternator" value="' + has(p.name) + '">' +
      '<input id="svpVendor' + i + '" placeholder="Bought at" value="' + has(p.vendor) + '">' +
      '<input id="svpCost' + i + '" inputmode="decimal" placeholder="$" value="' + has(p.cost) + '">' +
      '<label>🛡 <input id="svpMonths' + i + '" inputmode="numeric" placeholder="months" value="' + has(p.months) + '"></label>' +
      '<label><input id="svpMiles' + i + '" inputmode="numeric" placeholder="miles" value="' + has(p.miles) + '"></label>' +
      '<button class="remove-btn" type="button" onclick="removePartRow(' + i + ')" title="Remove">&times;</button>' +
    '</div>').join('');
  }
  window.addPartRow = function () {
    readPartRows();
    formParts.push({ id: 'pt' + Date.now().toString(36), name: '', vendor: '', cost: '', months: '', miles: '' });
    renderPartRows();
    const n = el('svpName' + (formParts.length - 1)); if (n) n.focus();
  };
  window.removePartRow = function (i) { readPartRows(); formParts.splice(i, 1); renderPartRows(); };
  // The parts as saved on the entry; rows with no name are dropped.
  function partsFromForm() {
    readPartRows();
    const n = s => { const x = parseFloat(String(s || '').replace(/[$,\s]/g, '')); return isFinite(x) && x > 0 ? x : null; };
    return formParts.filter(p => p.name.trim()).map(p => {
      const months = n(p.months), miles = n(p.miles), cost = n(p.cost);
      return { id: p.id, name: p.name.trim(), vendor: p.vendor.trim(), costCents: cost != null ? Math.round(cost * 100) : null,
               warranty: months != null || miles != null ? { months: months != null ? Math.round(months) : null,
                                                              miles: miles != null ? Math.round(miles) : null } : null };
    });
  }

  // What is left of one part's warranty: {active, text}. Time from the day
  // of the service; miles from the reading then against the machine's now.
  function warrantyLeft(g, e, p) {
    const w = p.warranty;
    if (!w) return { active: false, text: '' };
    const bits = [];
    let active = true;
    if (w.months != null) {
      const end = new Date((e.at || '') + 'T00:00:00');
      end.setMonth(end.getMonth() + w.months);
      const days = Math.ceil((end - new Date()) / 864e5);
      if (!(days > 0)) active = false;
      else bits.push(days >= 60 ? Math.round(days / 30.44) + ' months' : days + ' days');
    }
    if (w.miles != null) {
      const from = e.miles != null ? e.miles : null;
      if (from == null || g.miles == null) bits.push(fmtNum(w.miles) + ' miles from the reading then');
      else {
        const left = from + w.miles - g.miles;
        if (!(left > 0)) active = false;
        else bits.push(fmtNum(left) + ' miles');
      }
    }
    return { active: active, text: active ? bits.join(' / ') + ' left' : 'ran out' };
  }
  function warrantyParts() {
    const out = [];
    Object.values(gear).forEach(g => (g.service || []).forEach(e => (e.parts || []).forEach(p => {
      if (!p.warranty) return;
      const left = warrantyLeft(g, e, p);
      if (left.active) out.push({ g: g, e: e, p: p, left: left });
    })));
    return out.sort((a, b) => String(b.e.at || '').localeCompare(String(a.e.at || '')));
  }
  function warrantyHtml() {
    const list = warrantyParts();
    if (!list.length) return '<p class="empty-msg">Nothing under warranty. When you log a service, list its parts and ' +
      'put in how long the warranty runs.</p>';
    return '<div class="eq-warranty">' + list.map(x => '<div class="eq-war-row" role="button" tabindex="0" onclick="openEquipment(\'' + safeId(x.g.id) + '\')">' +
      '<div><b>🛡 ' + esc(x.p.name) + '</b> — ' + esc(x.g.name || 'Machine') + '</div>' +
      '<div class="muted">Bought ' + shortDate(x.e.at) + (x.p.vendor ? ' at ' + esc(x.p.vendor) : '') +
        (x.p.costCents ? ' · ' + money(x.p.costCents) : '') + ' · <b>' + esc(x.left.text) + '</b></div>' +
    '</div>').join('') + '</div>';
  }

  window.renderDetail2 = function () { editingEntry = null; fixingIssue = null; renderDetail(); };

  // The reading a new service should come with: miles for a vehicle, hours
  // for a machine on an hours interval. Jonah wants the count every time a
  // service is entered -- it is what keeps "next service" right.
  function readingWanted(g) {
    if (countsMiles(g)) return 'miles';
    if (g.intervalHours || g.hours != null) return 'hours';
    return '';
  }

  window.saveService = async function () {
    const g = gear[openId];
    if (!g) return;
    const what = val('svWhat');
    if (!what) { showToast('Say what was done'); return; }
    if (editingEntry) { saveServiceChange(g, what); return; }
    const want = readingWanted(g);
    const box = want === 'miles' ? 'svMiles' : want === 'hours' ? 'svHours' : '';
    if (box && num(box) == null) {
      const was = openId;
      if (!(await ydConfirm('The next service is worked out from the ' + want + '.',
          { title: 'No ' + want + ' reading this time?', ok: 'Save without it', cancel: 'Type it in' }))) {
        const b = el(box); if (b) b.focus();
        return;
      }
      // The form closed, or another machine opened, while it was asked.
      if (openId !== was || !el('svWhat') || !gear[openId]) return;
    }

    const entry = {
      id: 'sv' + Date.now().toString(36),
      at: val('svAt') || localDay(),   // the LOCAL date; toISOString() is tomorrow after 7 pm
      what: what,
      costCents: num('svCost') != null ? Math.round(num('svCost') * 100) : null,
      hours: num('svHours'),
      miles: num('svMiles'),
      by: val('svBy'),
      parts: partsFromForm(),
    };
    const fixed = fixingIssue ? (g.issues || []).find(i => i.id === fixingIssue) : null;
    fixingIssue = null;
    if (fixed) { entry.kind = 'repair'; entry.issueId = fixed.id; }

    const service = (g.service || []).concat([entry]);
    const patch = { service: service };
    if (fixed) {
      // Fixed on the day the repair was done, which may be before today.
      const doneAt = entry.at === localDay() ? new Date().toISOString() : entry.at + 'T12:00:00';
      // Its status goes to Fixed with it (stages.js), said to be by whoever
      // did the repair.
      patch.issues = (g.issues || []).map(i => i.id === fixed.id
        ? Object.assign({}, i, window.YDStages.issuePatch(i, 'fixed', { uid: meWho().uid, name: entry.by || whoAmI() }, doneAt),
            { doneAt: doneAt, doneBy: entry.by || whoAmI(), serviceId: entry.id }) : i);
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
      parts: partsFromForm(),
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

  window.removeService = async function (entryId) {
    let g = gear[openId];
    if (!g) return;
    const entry = (g.service || []).find(e => e.id === entryId);
    if (!entry || !(await ydConfirm('', { title: 'Remove "' + entry.what + '" from the history?', ok: 'Remove', danger: true }))) return;
    g = gear[g.id];
    if (!g || !(g.service || []).some(e => e.id === entryId)) return;
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

    metersAll = false;
    const cur = id ? catOf(g) : '';
    body.innerHTML =
      '<div class="field"><span class="label">Name</span>' +
        '<input id="eqName" value="' + esc(g.name || '') + '" placeholder="e.g. Toro 60\" or the F-250"></div>' +
      // The five groups as buttons, one of them picked (Jonah's five; a new
      // machine starts with none, so nothing lands in a group unasked).
      '<div class="field" id="eqKindField"><span class="label">What is it</span>' +
        '<div class="eq-cat-pick eq-cat-form" role="radiogroup" aria-label="What is it">' +
        CATEGORIES.map(c => '<label class="eq-cat-btn eq-cat-opt' + (c.id === cur ? ' on' : '') + '">' +
          '<input type="radio" name="eqKind" value="' + c.id + '"' + (c.id === cur ? ' checked' : '') + ' onchange="eqKindPicked()">' +
          '<span>' + c.icon + ' ' + esc(c.one) + '</span></label>').join('') +
        '</div></div>' +
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

      // Each meter's reading beside its interval, shown for the groups that
      // go by it (eqMeterBoxes) -- or whenever it already has a number in
      // it, so nothing stored is ever out of sight.
      '<div class="eq-loghead">How often it needs servicing</div>' +
      '<div id="eqMeterBox">' +
        '<div class="grid g2 eq-m" data-m="hours">' +
          '<div class="field"><span class="label">Hours now</span><input id="eqHours" inputmode="decimal" value="' +
            (g.hours != null ? g.hours : '') + '" placeholder="leave blank if it has no hour meter"></div>' +
          '<div class="field"><span class="label">Every X hours</span><input id="eqIntHours" inputmode="decimal" value="' +
            (g.intervalHours != null ? g.intervalHours : '') + '" placeholder="e.g. 50"></div>' +
        '</div>' +
        '<div class="grid g2 eq-m" data-m="miles">' +
          '<div class="field"><span class="label">Miles now</span><input id="eqMiles" inputmode="numeric" value="' +
            (g.miles != null ? g.miles : '') + '" placeholder="what the odometer says"></div>' +
          '<div class="field"><span class="label">Every X miles</span><input id="eqIntMiles" inputmode="numeric" value="' +
            (g.intervalMiles != null ? g.intervalMiles : '') + '" placeholder="e.g. 5000"></div>' +
        '</div>' +
        '<div class="grid g2">' +
          '<div class="field"><span class="label">Every X days</span><input id="eqIntDays" inputmode="numeric" value="' +
            (g.intervalDays != null ? g.intervalDays : '') + '" placeholder="e.g. 180"></div>' +
        '</div>' +
        '<div class="hint" id="eqMeterHint"></div>' +
        '<button type="button" class="link-btn eq-m-more" id="eqMeterMore" onclick="eqShowMeters(this)"></button>' +
      '</div>' +

      '<div class="field"><span class="label">Notes</span>' +
        '<textarea id="eqNotes" rows="2" placeholder="anything worth remembering about it">' +
        esc(g.notes || '') + '</textarea></div>' +

      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveEquipment()">Save</button>' +
        '<button class="btn btn-sm" onclick="cancelEquipmentEdit()">Cancel</button>' +
        (id ? '<button class="btn btn-sm" onclick="removeEquipment(\'' + id + '\')">Remove</button>' : '') +
      '</div>';
    eqMeterBoxes();
    const n = el('eqName'); if (n) n.focus();
  };

  // The group picked on the form, '' while none is.
  const pickedKind = () => { const r = document.querySelector('input[name="eqKind"]:checked'); return r && isCatId(r.value) ? r.value : ''; };
  let metersAll = false;      // "+ Hours or miles too" pressed on the open form
  // A group picked: lit, and the meter boxes that fit it shown. Nothing typed
  // is cleared or hidden -- a box with a number in it always shows.
  window.eqKindPicked = function () {
    const k = pickedKind();
    document.querySelectorAll('#eqKindField .eq-cat-opt').forEach(l => {
      const r = l.querySelector('input');
      l.classList.toggle('on', !!(r && r.checked));
    });
    const f = el('eqKindField'); if (f && k) f.classList.remove('cl-missing');
    eqMeterBoxes();
  };
  window.eqMeterBoxes = function () {
    const box = el('eqMeterBox');
    if (!box) return;
    const k = pickedKind();
    const filled = ids => ids.some(i => val(i) !== '');
    const show = {
      hours: metersAll || !k || METERS[k].indexOf('hours') !== -1 || filled(['eqHours', 'eqIntHours']),
      miles: metersAll || !k || METERS[k].indexOf('miles') !== -1 || filled(['eqMiles', 'eqIntMiles']),
    };
    box.querySelectorAll('.eq-m[data-m]').forEach(r => r.classList.toggle('eq-m-off', !show[r.dataset.m]));
    const hint = el('eqMeterHint');
    if (hint) {
      hint.textContent = k ? METER_HINT[k] + ' The next service works itself out each time you log one.'
        : 'Fill in whichever fits. A mower wears by hours, a truck by miles, a filter by months — ' +
          'the next service works itself out each time you log one.';
    }
    const more = el('eqMeterMore');
    if (more) {
      more.hidden = show.hours && show.miles;
      more.textContent = '+ ' + (!show.hours && !show.miles ? 'Hours or miles' : !show.hours ? 'Hours' : 'Miles') + ' too';
    }
  };
  // The meter boxes a group does not go by, shown after all (an ATV kept
  // with the machines that has an odometer, say).
  window.eqShowMeters = function (btn) {
    const box = (btn && btn.closest && btn.closest('.add-area, #eqMeterBox')) || document;
    if (box.id === 'eqMeterBox') { metersAll = true; window.eqMeterBoxes(); return; }
    box.querySelectorAll('.eq-m-off').forEach(n => n.classList.remove('eq-m-off'));
    if (btn) btn.remove();
  };

  window.cancelEquipmentEdit = function () {
    editingId = null;
    if (openId && gear[openId]) renderDetail();
    else closeEquipment();
  };

  window.saveEquipment = function () {
    const name = val('eqName');
    if (!name) { showToast('Give it a name'); return; }
    // Every machine is in one of the five: the form says which, never a default.
    const kind = pickedKind();
    if (!kind) {
      const f = el('eqKindField'); if (f) { f.classList.add('cl-missing'); if (f.scrollIntoView) f.scrollIntoView({ block: 'nearest' }); }
      showToast('Pick what it is — ' + CATEGORIES.map(c => c.one).join(', '));
      return;
    }
    const id = editingId || ('eq' + Date.now().toString(36));
    const was = gear[id] || {};

    const rec = {
      name: name,
      kind: kind,
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
    // Picked by a person: a new machine, or a group changed here. Saved
    // with the group it already had, it keeps how that was chosen -- the
    // button lit on its own is not someone saying "yes" to a sort they
    // never looked at ("Check these" asks for that tap).
    if (!editingId || catOf(was) !== kind || !isCatId(String(was.kind || ''))) {
      rec.kindHow = 'hand';
      if (editingId && was.kindBefore === undefined && !isCatId(String(was.kind || '').toLowerCase())) rec.kindBefore = String(was.kind || '');
    }

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

    // Merged over what was there, as the database does (put merges): the
    // fields this form never shows (problems, the sort's kindBefore) stay.
    gear[id] = Object.assign({ id: id }, was, rec);
    editingId = null; openId = id;
    renderDetail(); renderEquipment();
    write(id, rec, 'saving ' + name);
    showToast(name + ' saved');
  };

  window.removeEquipment = async function (id) {
    if (!ydCan('equipment', 'change')) return;
    const g = gear[id];
    if (!g || !(await ydConfirm('This cannot be undone.', { title: 'Remove ' + g.name + ' and its whole service history?', ok: 'Remove', danger: true }))) return;
    if (!gear[id]) return;
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
      sortIntoGroups();
      renderEquipment();
      // Home lists what needs a look (needs(), below).
      document.dispatchEvent(new CustomEvent('yd-equipment-changed'));
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

  // The crew cannot read the machines (their records carry costs and
  // receipts), but the Equipment tab's search and + Add a card need their
  // names: kept in settings/public, names and types only, by whoever may
  // change the machines. Written only when something changed; a machine
  // taken away is written as null (the save merges).
  let namesSig = null;
  function publishNames() {
    if (!ydCan('equipment', 'change') || !gearLoaded || !window.YDDb) return;
    const list = {};
    // `kind` is its group, always one of the five (catOf), so the crew's
    // pickers group them the same way.
    Object.values(gear).forEach(g => { list[g.id] = { name: String(g.name || 'Machine'), kind: catOf(g) }; });
    const sigOf = l => JSON.stringify(Object.keys(l || {}).filter(id => l[id]).sort().map(id => [id, l[id].name, l[id].kind]));
    const sig = sigOf(list);
    if (sig === namesSig) return;
    namesSig = sig;
    Promise.resolve(window.YDDb.get('settings', 'public')).then(p => {
      const had = (p && p.equipmentList) || {};
      if (sigOf(had) === sig) return;
      Object.keys(had).forEach(id => { if (!list[id]) list[id] = null; });
      return window.YDDb.put('settings', 'public', { equipmentList: list, equipmentListAt: new Date().toISOString() });
    }).catch(e => { namesSig = null; console.warn('[equipment] names for the crew not yet saved:', e && (e.code || e.message)); });
  }

  // ------------------------------------------- sorting into the five groups
  //
  // Once, on the owner's device, after the machines have come from the
  // server: every machine not yet in a group is given one (sortOne), what
  // it was kept in `kindBefore`, how in `kindHow`, all as one batch; then
  // settings/equipment.categoriesAt says it is done. Safe twice: a machine
  // with a `kindHow` is never sorted again. After that, only a machine whose
  // `kind` is none of the five (a type typed on a phone still on the old
  // code) is folded in -- a Machine or Vehicle added since was someone's
  // choice and is left as it is.
  let sortTried = false;
  function sortIntoGroups() {
    if (sortTried || !isOwner() || !gearLoaded || !ydCan('equipment', 'change') || !window.YDDb || !window.YDDb.getFresh) return;
    sortTried = true;
    Promise.resolve(window.YDDb.getFresh('settings', 'equipment')).then(s => {
      const done = !!(s && s.categoriesAt);
      const entries = [];
      let unsure = 0;
      Object.values(gear).forEach(g => {
        if (g.kindHow) return;
        if (done && isCatId(String(g.kind || ''))) return;
        const r = sortOne(g);
        const patch = { kind: r.id, kindBefore: String(g.kind == null ? '' : g.kind), kindHow: r.how };
        if (r.how === 'check') unsure++;
        Object.assign(g, patch);
        entries.push(['equipment', g.id, patch]);
      });
      if (!entries.length && done) return;
      if (entries.length) {
        renderEquipment();
        scheduleMaintSync();      // the crew's list carries the groups
        if (!done) showToast('Your ' + entries.length + ' machine' + (entries.length === 1 ? ' is' : 's are') +
          ' sorted into Vehicles, Machines, Trailers, Small engines and Electric tools' +
          (unsure ? ' — ' + unsure + ' to check (Equipment → Machines)' : ''), 7000);
      }
      // The flag only once the machines have gone up: a sort half-sent is
      // finished next time (those with a kindHow are skipped).
      return Promise.resolve(entries.length ? window.YDDb.putMany(entries) : null).then(() => {
        if (done) return;
        return window.YDDb.put('settings', 'equipment', { categoriesAt: new Date().toISOString(),
          categoriesSorted: entries.length, categoriesToCheck: unsure });
      });
    }).catch(e => {
      // No signal (getFresh needs the server) or refused: tried again on the
      // next load from the server.
      sortTried = false;
      console.warn('[equipment] groups not sorted yet:', e && (e.code || e.message));
    });
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
        name: 'Maintenance', color: '#8a6d3b', order: 3, visibleTo: [], ownerOnly: false,
        columns: [{ id: 'm0', name: 'Due' }, { id: 'm1', name: 'Booked in' }, { id: 'm2', name: 'Done' }], doneColumn: 'm2',
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
    const lastCol = YDBoards.doneCol ? YDBoards.doneCol(board) : board.columns[board.columns.length - 1].id;
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
      .concat(labelIds.has(PART_LABEL.id) ? [] : [PART_LABEL])
      .concat(labelIds.has(ORDERED_LABEL.id) ? [] : [ORDERED_LABEL])
      .concat(labelIds.has(LOG_LABEL.id) ? [] : [LOG_LABEL]);
    let recoloured = false;
    const labels = (board.labels || []).map(l => {
      const u = URGENCY.find(x => 'u-' + x.id === l.id);
      if (!u || String(l.color || '').toLowerCase() !== u.was) return l;
      recoloured = true;
      return Object.assign({}, l, { color: u.color });
    });
    if (missing.length || recoloured) {
      board.labels = labels.concat(missing);
      Promise.resolve(window.YDDb.put('boards', MAINT, { labels: board.labels }))
        .catch(e => console.warn('[equipment] labels not yet saved:', e.code || e.message));
    }

    // Every crew member sees the Maintenance board (Jonah, 6 Oct 2026): it is
    // shared with each active crew member and admin, a newcomer added here the
    // next time this runs -- once, and only from the owner's device: who sees
    // a board is his to say (12 Oct 2026), so someone he takes off stays off
    // (autoShared remembers who was already added).
    const ppl = YDBoards.people ? YDBoards.people() : {};
    if (Object.keys(ppl).length && window.YDAuth && YDAuth.isOwner) {
      const crew = Object.keys(ppl).filter(uid => ppl[uid].active && ['crew', 'admin'].indexOf(ppl[uid].role) !== -1);
      const vis = Array.isArray(board.visibleTo) ? board.visibleTo : [];
      const once = Array.isArray(board.autoShared) ? board.autoShared : vis.slice();
      const add = crew.filter(uid => vis.indexOf(uid) === -1 && once.indexOf(uid) === -1);
      const remember = Array.from(new Set(once.concat(add, vis)));
      if (add.length || !Array.isArray(board.autoShared) || remember.length !== once.length) {
        board.visibleTo = vis.concat(add);
        board.autoShared = remember;
        Promise.resolve(window.YDDb.put('boards', MAINT, { visibleTo: board.visibleTo, autoShared: remember }))
          .catch(e => console.warn('[equipment] sharing not yet saved:', e.code || e.message));
      }
      // And may add cards to it (Jonah, 15 Oct 2026: "a board for equipment
      // where people add cards"): each is made an editor of it once, the same
      // way, so someone he takes off stays off.
      const eds = Array.isArray(board.editors) ? board.editors : [];
      const onceEd = Array.isArray(board.autoEditors) ? board.autoEditors : eds.slice();
      const addEd = crew.filter(uid => eds.indexOf(uid) === -1 && onceEd.indexOf(uid) === -1);
      const rememberEd = Array.from(new Set(onceEd.concat(addEd, eds)));
      if (addEd.length || !Array.isArray(board.autoEditors) || rememberEd.length !== onceEd.length) {
        board.editors = eds.concat(addEd);
        board.autoEditors = rememberEd;
        Promise.resolve(window.YDDb.put('boards', MAINT, { editors: board.editors, autoEditors: rememberEd }))
          .catch(e => console.warn('[equipment] editors not yet saved:', e.code || e.message));
      }
    }
    publishNames();

    // Cards added in the shop by someone who cannot write to the machines
    // (eqc…, the Equipment tab's + Add a card): put on their machine as a
    // problem, so its history has it, and replaced by the problem's own card
    // in the column it had got to. The same card id always makes the same
    // problem, so two devices doing it at once agree.
    const nowIso = new Date().toISOString();
    const converted = [];
    if (ydCan('equipment', 'change')) {
      Object.keys(have).forEach(cid => {
        if (cid.indexOf('eqc') !== 0) return;
        const k = have[cid], g = k.equipmentId ? gear[k.equipmentId] : null;
        if (!g) return;
        const issueId = 'is' + cid.slice(3);
        if (!(g.issues || []).some(i => i.id === issueId)) {
          const done = k.column === lastCol;
          g.issues = (g.issues || []).concat([{
            id: issueId, what: k.what || String(k.title || '').replace(/^.*? — /, '') || 'See the card',
            urgency: k.eqUrgency || 'soon', note: k.eqNote || '', partAtShop: false, status: done ? 'fixed' : 'open',
            at: k.createdAt || nowIso, by: k.createdBy || '', doneAt: done ? (k.doneAt || nowIso) : null,
            boardColumn: k.column || first,
          }]);
          write(g.id, { issues: g.issues }, 'putting a shop card on its machine');
        }
        converted.push(cid);
      });
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
        // Only a PERSON's move counts, and only one made after the problem was
        // last reopened: a card this sync itself put in Done, or one still
        // sitting there when the problem is reopened on the machine, is not
        // someone saying "fixed" -- taking it as that re-marked a reopened
        // problem fixed straight away, for ever.
        if (k && !i.doneAt && k.column === lastCol && k.doneAt && k.updatedBy !== 'Equipment' &&
            String(k.updatedAt || '') > String(i.reopenedAt || '')) {
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
        // Fixed, and its card gone -- deleted with "Delete all done" on the
        // board (Jonah, 13 Oct). The machine keeps the record; the card is
        // not made again.
        if (!k && i.doneAt) return;
        const u = urgencyOf(i.urgency);
        // The part, as the card says it: at the shop (as it always said),
        // or on order (status 'ordered', stages.js).
        const ordered = !i.partAtShop && stageOf(i) === 'ordered';
        const want = {
          title: (g.name || 'Machine') + ' — ' + i.what,
          due: null,
          notes: u.label + ' (' + u.hint + ').' + (i.partAtShop ? ' The part is at the shop.' : ordered ? ' The part is on order.' : '') +
            (i.note ? '\n\n' + i.note : '') +
            '\n\nNoted ' + shortDate(i.at) + (i.by ? ' by ' + i.by : '') + '.',
          labels: ['u-' + u.id].concat(i.partAtShop ? [PART_LABEL.id] : ordered ? [ORDERED_LABEL.id] : []),
          urgency: CARD_URGENCY[u.id] || 'normal',
          equipmentId: g.id, issueId: i.id, auto: true,
        };
        const doneNow = !!i.doneAt;
        const same = k && k.title === want.title && k.notes === want.notes &&
          JSON.stringify(k.labels || []) === JSON.stringify(want.labels) && k.urgency === want.urgency &&
          (doneNow ? k.column === lastCol : k.column !== lastCol);
        if (same) return;
        const patch = Object.assign({}, want, { updatedAt: new Date().toISOString(), updatedBy: 'Equipment' });
        // Who noted the problem made the card: an urgent one pings the owner
        // unless he noted it himself (reminders.py compares createdBy with
        // his name). Given once, to a card that has none.
        if (!k || !k.createdBy) patch.createdBy = i.by || null;
        // A problem that came from a card added in the shop starts in the
        // column that card had reached.
        const startCol = i.boardColumn && board.columns.some(c => c.id === i.boardColumn) ? i.boardColumn : first;
        if (!k) { patch.createdAt = new Date().toISOString(); patch.column = doneNow ? lastCol : startCol; }
        if (doneNow && (!k || k.column !== lastCol)) { patch.column = lastCol; patch.doneAt = i.doneAt; }
        // Reopened on the machine: back out of Done.
        if (!doneNow && k && k.column === lastCol) { patch.column = first; patch.doneAt = null; }
        Promise.resolve(window.YDDb.put(path, id, placed(k, patch)))
          .catch(e => console.warn('[equipment] card not yet saved:', e.code || e.message));
      });
    });
    // The shop's cards now on their machines: their problems' cards replace them.
    if (converted.length) {
      Promise.resolve(window.YDDb.removeMany(converted.map(cid => [path, cid])))
        .catch(e => console.warn('[equipment] shop cards not yet replaced:', e.code || e.message));
    }
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
      const newCycle = !k || k.dueKey !== dueKey(g);
      // Moved to Done by a person while the machine's due point stayed put:
      // the work was done but never logged -- a crew member cannot log one,
      // or the service form was closed unsaved. Taken as nothing, the board
      // said "done" while the machine stayed overdue (review, 7 Oct). The
      // card stays in Done and says who marked it, on the board and on the
      // Equipment tab, until the service is logged (a new cycle clears it)
      // or someone moves it back out.
      const inDone = !!k && !newCycle && k.column === lastCol;
      const markedBy = !inDone ? null
        : k.markedDoneBy || (k.updatedBy && k.updatedBy !== 'Equipment' ? k.updatedBy : null);
      // The title says how close it is, as the Equipment tab does (due()):
      // every machine with a next service has a card, and one thousands of
      // miles off was titled "service due" while Equipment said "due in
      // 4,000 miles" -- the two seemed to disagree. Absolute words for one
      // still far off, so the card is rewritten only when the state changes.
      const want = {
        title: (g.name || 'Machine') + (state === 'overdue' ? ' — service overdue'
          : state === 'soon' ? ' — service due soon' : ' — next service ' + dueWords(g)),
        due: g.dueDate || null,
        notes: (markedBy ? 'Marked done by ' + markedBy + ' — log the service on the Equipment tab ' +
                  '(with its hours or miles) so the next one counts from it.\n\n' : '') +
          'Next service ' + dueWords(g) + '.' +
          (g.notes ? '\n\n' + g.notes : '') +
          '\n\nLog the service on the Equipment tab and this card resets itself for the next one.',
        labels: (state === 'overdue' ? ['overdue'] : state === 'soon' ? ['soon'] : [])
          .concat(markedBy ? [LOG_LABEL.id] : []),
        equipmentId: g.id,
        dueKey: dueKey(g),
        markedDoneBy: markedBy,
        markedDoneAt: markedBy ? (k.markedDoneAt || k.doneAt || new Date().toISOString()) : null,
        auto: true,
      };
      const same = k && !newCycle && k.title === want.title && k.due === want.due &&
        k.notes === want.notes && JSON.stringify(k.labels || []) === JSON.stringify(want.labels) &&
        (k.markedDoneBy || null) === want.markedDoneBy;
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

  // The tab is there for whoever sees the machines -- or the Maintenance
  // board, which is shared with the crew (the shop board).
  function showTab() {
    const tab = el('tabEquipment');
    const on = !!(window.YDAuth && window.YDAuth.user && window.YDAuth.mode === 'cloud');
    if (tab) tab.hidden = !(on && (seesGear() || maintBoard()));
  }
  const equipmentShowing = () => { const p = el('panel-equipment'); return !!(p && p.classList.contains('active')); };
  document.addEventListener('yd-boards-ready', () => {
    scheduleMaintSync();
    showTab();
    if (equipmentShowing()) renderEquipment();
  });
  document.addEventListener('yd-boards-changed', () => { showTab(); if (equipmentShowing()) renderEquipment(); });
  // A column folded on a phone (boards.js bdToggleCol).
  document.addEventListener('yd-board-redraw', () => { if (equipmentShowing()) renderBody(); });
  // The Maintenance cards themselves arrive a moment after the boards do;
  // checking again then is what lets a removed machine's card be cleared.
  document.addEventListener('yd-cards-changed', () => {
    if (YDBoards.boards()[MAINT]) scheduleMaintSync();
    // The shop board, and the machine list's "marked the service done", are
    // drawn from these cards -- once nobody is sliding its columns along
    // (app.js ydSliding).
    redrawWhenStill();
  });
  let stillTimer = 0;
  function redrawWhenStill() {
    if (stillTimer) return;
    if (window.ydSliding && ydSliding()) {
      stillTimer = setTimeout(() => { stillTimer = 0; redrawWhenStill(); }, 250);
      return;
    }
    if (equipmentShowing()) renderEquipment();
  }

  window.YDEquipment = {
    all: () => gear,
    countsMiles: countsMiles,
    // The five groups, for every list of machines (the clock's repair
    // picker, the recurring tasks, the search): [{id, one, many, icon}] in
    // their order; the group of a machine record or a crew-list {name,
    // kind} entry; a group by id (Machine for anything else); the singular
    // name of a stored kind; and items grouped (empty groups left out).
    categories: () => CATEGORIES.map(c => Object.assign({}, c)),
    categoryOf: catOf,
    category: id => Object.assign({}, catById(id)),
    kindName: kindName,
    byCategory: byCategory,
    // services.js, "Your other lists": the groups with how many machines
    // each holds -- all five are Jonah's fixed ones (builtIn), so there are
    // none of his own to rename there any more -- and every machine of one
    // group moved to another.
    types: () => CATEGORIES.map(c => ({ id: c.id, name: c.one, builtIn: true,
      count: Object.values(gear).filter(g => catOf(g) === c.id).length })),
    retype: (was, to) => {
      if (!ydCan('equipment', 'change') || !isCatId(to) || !was || was === to) return 0;
      let n = 0;
      Object.values(gear).forEach(g => {
        if (catOf(g) !== was && String(g.kind || '').trim().toLowerCase() !== String(was).toLowerCase()) return;
        const patch = { kind: to, kindHow: 'hand' };
        if (g.kindBefore === undefined && !isCatId(String(g.kind || '').toLowerCase())) patch.kindBefore = String(g.kind || '');
        Object.assign(g, patch);
        write(g.id, patch, 'changing its group');
        n++;
      });
      if (n) { renderEquipment(); scheduleMaintSync(); }
      return n;
    },
    // A recurring task confirmed done (recurring.js): in the history as a
    // task, with the miles if given -- it does not move the next service.
    logTask: (id, what, miles, by) => {
      const g = gear[id];
      if (!g || !ydCan('equipment', 'change')) return;
      const entry = { id: 'sv' + Date.now().toString(36), at: localDay(), what: what, costCents: null,
                      hours: null, miles: miles != null ? miles : null, by: by || '', kind: 'task', parts: [] };
      const patch = { service: (g.service || []).concat([entry]) };
      if (miles != null && (g.miles == null || miles > g.miles)) patch.miles = miles;
      Object.assign(g, patch);
      write(g.id, patch, 'logging a task');
      renderEquipment();
    },
    overdue: () => Object.values(gear).filter(g => due(g).state === 'overdue'),
    // Home (home.js): every machine that wants a look, most pressing first
    // -- the order the Equipment tab sorts them in. Out of service, then
    // fix-before-use, then service overdue, then the rest that are close.
    needs: () => {
      const order = { overdue: 0, soon: 1, ok: 2, none: 3 };
      return Object.values(gear).map(g => {
        const d = due(g), w = worstIssue(g), n = openIssues(g).length;
        const u = w ? urgencyOf(w.urgency) : null;
        return { id: g.id, name: g.name || 'Machine', due: d, issueRank: w ? rankOf(w.urgency) : URGENCY.length,
                 issue: w ? { label: u.label, color: u.color, what: w.what || '', more: n - 1, urgency: w.urgency } : null };
      }).filter(x => x.issueRank <= 2 || x.due.state === 'overdue' || x.due.state === 'soon')
        .sort((a, b) => Math.min(a.issueRank, 2) - Math.min(b.issueRank, 2) ||
          order[a.due.state] - order[b.due.state] || String(a.name).localeCompare(b.name));
    },
    render: () => renderEquipment(),
    // The Maintenance board's machine card moved to Done (boards.js): the
    // machine opens with its service form, the hours or miles asked for as on
    // the Equipment tab. Saving it starts the next cycle, which puts the card
    // back in Due with its new due point.
    serviceFromBoard: id => {
      // Crew cannot read the machines at all, so this comes before the
      // lookup -- they were left with no word that anything happened.
      if (!ydCan('equipment', 'change')) { showToast('Marked done — the office logs the service'); return; }
      if (!gear[id]) return;
      if (typeof switchTab === 'function') switchTab('equipment');
      window.openEquipment(id);
      setTimeout(() => window.addService(), 50);
      showToast('Log the service for ' + (gear[id].name || 'the machine') + ' — with its ' + (readingWanted(gear[id]) || 'reading'));
    },
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const sees = on && ydCan('equipment', 'see');
    showTab();
    publicNames = null;
    const top = el('eqTop'); if (top) top.dataset.sig = '';
    // Looking without changing: every editing control is hidden.
    document.documentElement.toggleAttribute('data-equipment-readonly', sees && !ydCan('equipment', 'change'));
    if (sees) start();
    else if (unsub) {
      // Access taken away (or signed out): stop listening, and nothing of
      // the machines stays on this device's screen.
      try { unsub(); } catch (err) {}
      unsub = null; gear = {}; gearLoaded = false; sortTried = false;
      renderEquipment();
    }
  });

  function boot() { renderEquipment(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
