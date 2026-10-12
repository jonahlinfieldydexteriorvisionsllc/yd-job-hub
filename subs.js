// Subcontracted work -- mowing (or anything else) YD sells and someone else
// does. Jonah (5 Oct 2026): "I sub out mowing services ... we need somewhere
// in the hub that tracks that." His answers (6 Oct): build it for any
// subcontractor; their bills go into QuickBooks as bills against those
// clients once QuickBooks is connected (that part is not built yet).
//
// On the All Jobs tab, for the owner. Kept in settings/subcontractors, which
// only the owner reads or writes -- what YD pays a subcontractor and charges
// the client, side by side, is nobody else's business, and a settings
// document needs no new security rules:
//   subs: { subId: { name, match, phone, email, notes, createdAt,
//                    props: { propId: { jobId, client, address, every,
//                                       everyText, perMonth, services[],
//                                       theirCents, theirPer, ourCents,
//                                       ourPer, from, to, off,
//                                       doneOn, doneWhy } } } }
//   paid: { receiptId: 'YYYY-MM-DD' }     bills marked paid here
// every: weekly | biweekly | monthly | other (everyText written in, perMonth
// visits a month for the totals). *Per: visit | month. from/to: the season
// as MM-DD. doneOn: the day its Done box was ticked; doneWhy: season (back
// next season) | ended (for good). A key written null is a deleted one
// (writes merge).
//
// Their bills are receipts the email reader already files (receipts.js): a
// receipt whose store has a subcontractor's "match" words in it is theirs.
// The owner's device takes those out of "Receipts to sort" by itself (set
// aside as "Subcontractor bill") and they are listed here: owed, paid, due.

(function () {
  'use strict';

  const EVERY = { weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Once a month', other: 'Something else…' };
  // How often, in words: one of the above, or what was written in for it.
  const everyWords = p => p.every === 'other' ? (p.everyText || 'Written in') : (EVERY[p.every] || '');
  const DONE_WHY = { season: 'Done for the season', ended: 'Service ended' };
  const PER = { visit: 'a visit', month: 'a month' };
  const SEASON = { from: '04-15', to: '10-31' };    // mowing, by default
  // What a subcontractor does at a property (Jonah, 12 Oct 2026: "i need to
  // be able to select the service(s) total guard is doing for each client").
  // Kept on the property as `services: [names]`; one typed in by hand joins
  // the list for every property after.
  const SERVICES = ['Mowing', 'Trimming', 'Edging', 'Blowing', 'Fertilizing', 'Weed control', 'Aeration',
                    'Overseeding', 'Spring cleanup', 'Fall cleanup', 'Leaf removal', 'Shrub trimming',
                    'Mulching', 'Snow removal'];
  const DUE_SOON_DAYS = 5;

  let data = { subs: {}, paid: {}, filed: {}, visitFix: {}, handVisits: {}, svcProp: {} };
  let visitsDoc = { visits: {}, scannedAt: '' };   // settings/subVisits (functions/subvisits.py)
  let checking = false;       // "Check their email now" is waiting on the server
  let addingVisit = '';       // subId while its "add a visit by hand" form is open
  let fresh = false;          // from the server, not just this device's copy
  let unsub = null;
  let open = {};              // subId -> its details are open
  let form = null;            // { kind: 'sub'|'prop', subId, propId }

  const el = id => document.getElementById(id);
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const two = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const sid = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const money = c => (typeof c === 'number' && isFinite(c) ? fmtMoney(c / 100) : '—');
  const cents = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : Math.round(n * 100); };
  const live = o => Object.keys(o || {}).filter(k => o[k]).map(k => Object.assign({ id: k }, o[k]));
  const subsList = () => live(data.subs).sort((a, b) => String(a.name || '').localeCompare(b.name || ''));
  const propsOf = s => live(s.props).sort((a, b) => String(a.client || '').localeCompare(b.client || ''));

  function save(patch, what) {
    if (!window.YDDb || !owner()) return;
    Promise.resolve(window.YDDb.put('settings', 'subcontractors', patch)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[subs] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }
  // Applied here the way the database merges, so the screen shows it at once.
  function applyLocal(patch) {
    const merge = (into, from) => {
      Object.keys(from).forEach(k => {
        const v = from[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k], v);
        else into[k] = v;
      });
    };
    merge(data, JSON.parse(JSON.stringify(patch)));
  }
  function put(patch, what) { applyLocal(patch); save(patch, what); render(); }

  // ------------------------------------------------------------- the money

  const dayNum = mmdd => { const m = /^(\d{2})-(\d{2})$/.exec(mmdd || ''); return m ? +m[1] * 100 + +m[2] : null; };
  // Which season a day belongs to, named by the year it starts in: a season
  // that runs over New Year (snow, Nov to Mar) started the year before for
  // its January days.
  function seasonOf(p, y, k) {
    const from = dayNum(p.from || SEASON.from), to = dayNum(p.to || SEASON.to);
    return from != null && to != null && from > to && k <= to ? y - 1 : y;
  }
  // Ticked done (doneOn, Jonah 12 Oct 2026): nothing counts from the next day
  // on -- for the rest of that season if it was done for the season, for
  // good if the service ended.
  function stoppedOn(p, y, k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.doneOn || '')) return false;
    const day = y + '-' + String(k).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1-$2');
    if (day <= p.doneOn) return false;
    if (p.doneWhy === 'ended') return true;
    const dy = +p.doneOn.slice(0, 4), dk = dayNum(p.doneOn.slice(5));
    return seasonOf(p, y, k) === seasonOf(p, dy, dk);
  }
  // Whether its Done box is ticked now: ended for good, or done in the
  // season we are in.
  function doneNow(p) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.doneOn || '')) return false;
    if (p.doneWhy === 'ended') return true;
    const t = new Date();
    return seasonOf(p, t.getFullYear(), (t.getMonth() + 1) * 100 + t.getDate()) ===
      seasonOf(p, +p.doneOn.slice(0, 4), dayNum(p.doneOn.slice(5)));
  }
  // The days of a month that fall in a property's season (and before it was
  // ticked done).
  function seasonDays(p, y, m) {
    const from = dayNum(p.from || SEASON.from), to = dayNum(p.to || SEASON.to);
    const last = new Date(y, m + 1, 0).getDate();
    let n = 0;
    for (let d = 1; d <= last; d++) {
      const k = (m + 1) * 100 + d;
      if ((from == null || to == null || (from <= to ? k >= from && k <= to : k >= from || k <= to)) && !stoppedOn(p, y, k)) n++;
    }
    return { n: n, of: last };
  }
  // What a property comes to in a month: about how many visits, what the
  // subcontractor charges for them and what YD charges the client. A monthly
  // price is shared by the days of the month in season, so a half month at
  // the start of the season counts half.
  function monthOf(p, y, m) {
    const s = seasonDays(p, y, m);
    if (!s.n || p.off) return { visits: 0, their: 0, ours: 0 };
    const part = s.n / s.of;
    // Written in by hand ("every 10 days", "as needed"): as many visits a
    // month as were given for it, none if none were.
    const visits = p.every === 'other' ? (+p.perMonth || 0) * part
      : p.every === 'monthly' ? 1 : s.n / (p.every === 'biweekly' ? 14 : 7);
    const cost = (c, per) => (typeof c === 'number' ? Math.round(per === 'month' ? c * part : c * visits) : 0);
    return { visits: visits, their: cost(p.theirCents, p.theirPer), ours: cost(p.ourCents, p.ourPer) };
  }
  function totals(s, y, m) {
    return propsOf(s).reduce((t, p) => {
      const x = monthOf(p, y, m);
      t.visits += x.visits; t.their += x.their; t.ours += x.ours;
      return t;
    }, { visits: 0, their: 0, ours: 0 });
  }
  function seasonTotals(s, y) {
    const t = { their: 0, ours: 0 };
    for (let m = 0; m < 12; m++) { const x = totals(s, y, m); t.their += x.their; t.ours += x.ours; }
    return t;
  }
  const marginText = t => {
    const m = t.ours - t.their;
    return money(m) + (t.ours > 0 ? ' (' + Math.round(m / t.ours * 100) + '%)' : '');
  };

  // ------------------------------------------------------------- the bills

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // The words that name a company, without "LLC", "Inc", "Co" and the like --
  // the same company's bills come as "X Yard Care LLC" one month and "X Yard
  // Care" the next.
  const FILLER = ['llc', 'inc', 'ltd', 'corp', 'co', 'company', 'the', 'and', 'of'];
  const words = s => norm(s).split(' ').filter(w => w.length > 1 && FILLER.indexOf(w) === -1);
  const matchOf = name => words(name).join(' ');
  function receiptsAll() { return window.YDReceipts && YDReceipts.all ? YDReceipts.all() : {}; }
  // Whose bill a receipt is: the subcontractor whose "match" words are all in
  // the store's name.
  function subFor(r) {
    const have = words(r.vendor);
    if (!have.length) return null;
    return subsList().find(s => {
      const want = words(s.match || s.name);
      return want.length && want.every(w => have.indexOf(w) !== -1);
    }) || null;
  }
  function billsOf(s) {
    const all = receiptsAll();
    return Object.keys(all).map(id => Object.assign({ id: id }, all[id]))
      .filter(r => subFor(r) && subFor(r).id === s.id)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  const isPayment = r => r.docType === 'receipt' || r.docType === 'person_payment';
  const isBill = r => r.docType === 'invoice';
  // Invoices a later payment of the same amount paid. The email reader puts a
  // payment with its bill only while the bill is still waiting to be sorted,
  // and theirs are filed here at once -- so a payment can arrive as a
  // receipt of its own.
  function paidByPayment(bills) {
    const done = new Set(), used = new Set();
    const pays = bills.filter(isPayment);
    bills.filter(r => isBill(r) && !r.paid).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .forEach(inv => {
        const p = pays.find(x => !used.has(x.id) && x.totalCents === inv.totalCents && String(x.date || '') >= String(inv.date || ''));
        if (p) { used.add(p.id); done.add(inv.id); }
      });
    return done;
  }
  const isPaid = (r, matched) => !!(r.paid || (data.paid || {})[r.id] || (matched && matched.has(r.id)));
  function owed(s) {
    const t = ymd(new Date());
    const bills = billsOf(s), matched = paidByPayment(bills);
    const list = bills.filter(r => isBill(r) && !isPaid(r, matched));
    const soon = ymd(new Date(Date.now() + DUE_SOON_DAYS * 864e5));
    return {
      cents: list.reduce((n, r) => n + (r.totalCents || 0), 0),
      count: list.length,
      late: list.filter(r => r.dueDate && r.dueDate < t),
      soon: list.filter(r => r.dueDate && r.dueDate >= t && r.dueDate <= soon),
    };
  }

  // Their bills leave "Receipts to sort" by themselves -- only on the
  // owner's device, and only once both lists have come from the server.
  // Only what the reader called a subcontractor's bill: a subcontractor who
  // also sells materials keeps those receipts in To sort, for the jobs. Each
  // one is filed once (kept in `filed`), so "Put back" in Receipts sticks.
  function fileBills() {
    if (!owner() || !fresh || !window.YDReceipts || !YDReceipts.loaded || !YDReceipts.loaded() || !window.YDDb) return;
    const all = receiptsAll(), filed = data.filed || {}, now = {};
    Object.keys(all).forEach(id => {
      const r = all[id];
      if (r.status !== 'new' || (r.splits || []).length || filed[id] || r.kind !== 'subcontractor' || !subFor(r)) return;
      const patch = { status: 'skipped', skipWhy: 'subcontractor', skippedBy: 'Job Hub', updatedAt: new Date().toISOString() };
      Object.assign(r, patch);
      now[id] = true;
      Promise.resolve(window.YDDb.put('receipts', id, patch))
        .catch(e => console.warn('[subs] bill not yet filed:', (e && e.code) || e));
    });
    if (Object.keys(now).length) { applyLocal({ filed: now }); save({ filed: now }, 'noting filed bills'); }
  }

  // Stores the email reader called subcontractors that are not set up here.
  function suggestions() {
    const seen = {};
    Object.values(receiptsAll()).forEach(r => {
      if (r.kind !== 'subcontractor' || !r.vendor || subFor(r)) return;
      const k = matchOf(r.vendor);
      if (k && !seen[k]) seen[k] = r.vendor;
    });
    return Object.values(seen).slice(0, 5);
  }

  // ---------------------------------------------------------------- drawing

  // ------------------------------------------------------------- the visits
  //
  // Jonah (12 Oct 2026): count the mows at each client "by pulling receipts
  // from my email" -- and be able to set any of it by hand ("always having a
  // manual thing built in avoids issues down the line"). The server reads
  // each subcontractor's invoice emails into settings/subVisits (functions/
  // subvisits.py): one visit per invoice {sub, date, service, address,
  // cents}. Here each is put with a client -- by the address on it, else the
  // client a visit of that service was last put with by hand -- and counted
  // as mows: one for a visit, a month's worth (from how often) for a monthly
  // bill (≈, a guess until set), none for other work. What Jonah sets by hand
  // is kept beside them in settings/subcontractors and always wins:
  //   visitFix:   { key: { prop, mows, skip } }
  //   handVisits: { id: { sub, prop, date, service, mows } }
  //   svcProp:    { subId: { serviceKey: propId } }    learned from his picks
  // and a property's own mowsByHand {season, n} replaces its whole count.
  const MOWING = /mow|lawn/i;
  const ABBR = { saint: 'st', street: 'st', drive: 'dr', avenue: 'ave', road: 'rd', lane: 'ln', court: 'ct',
                 circle: 'cir', boulevard: 'blvd', place: 'pl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter',
                 trail: 'trl', north: 'n', south: 's', east: 'e', west: 'w' };
  const svcKeyOf = s => norm(s).replace(/ /g, '-').slice(0, 60);
  // An address as house number + street name, the way two spellings of it
  // agree ("4858 Saint Annes Dr" is "4858 St Annes Drive"). A rural fire
  // number (W5883) counts as the number.
  function addrKey(a) {
    const t = norm(a).split(' ').filter(Boolean).map(w => ABBR[w] || w);
    const i = t.findIndex(w => /^[nsew]?\d+$/.test(w));
    if (i === -1) return '';
    let rest = t.slice(i + 1).filter(w => !/^[nsew]$/.test(w));
    if (rest[0] === 'st' && rest.length > 1) rest = rest.slice(1);   // "St Annes", "Saint Annes"
    return rest.length ? t[i] + ' ' + rest[0] : '';
  }
  function propForVisit(s, v) {
    const fix = (data.visitFix || {})[v.key];
    if (fix && 'prop' in fix) return fix.prop && (s.props || {})[fix.prop] ? fix.prop : null;
    const k = addrKey(v.address);
    if (k) {
      const p = propsOf(s).find(x => addrKey(x.address) === k);
      if (p) return p.id;
    }
    const learned = ((data.svcProp || {})[s.id] || {})[svcKeyOf(v.service)];
    return learned && (s.props || {})[learned] ? learned : null;
  }
  // Mows a visit is worth when nobody has said: one, a month's worth for a
  // monthly bill, none for work that is not mowing.
  function defaultMows(v, p) {
    if (!MOWING.test(v.service || '')) return 0;
    if (!/month/i.test(v.service || '')) return 1;
    if (!p) return 4;
    return p.every === 'biweekly' ? 2 : p.every === 'monthly' ? 1
      : p.every === 'other' ? Math.max(1, Math.round(+p.perMonth || 1)) : 4;
  }
  function visitsOf(s) {
    const auto = Object.keys(visitsDoc.visits || {}).filter(k => (visitsDoc.visits[k] || {}).sub === s.id)
      .map(k => Object.assign({ key: k }, visitsDoc.visits[k]));
    const hand = Object.keys(data.handVisits || {}).filter(k => (data.handVisits[k] || {}).sub === s.id)
      .map(k => Object.assign({ key: k, hand: true }, data.handVisits[k]));
    return auto.concat(hand).map(v => {
      const fix = v.hand ? {} : ((data.visitFix || {})[v.key] || {});
      const prop = v.hand ? ((s.props || {})[v.prop] ? v.prop : null) : propForVisit(s, v);
      const setMows = v.hand || typeof fix.mows === 'number';
      const mows = v.hand ? (+v.mows || 0) : setMows ? fix.mows : defaultMows(v, prop ? s.props[prop] : null);
      return Object.assign(v, { prop: prop, mows: mows, setMows: setMows, skip: !!fix.skip,
        guess: !setMows && /month/i.test(v.service || '') && MOWING.test(v.service || '') });
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  const seasonNow = p => { const t = new Date(); return seasonOf(p, t.getFullYear(), (t.getMonth() + 1) * 100 + t.getDate()); };
  // This season's mows at one property, and the last one.
  function mowsFor(s, p, list) {
    const cur = seasonNow(p);
    let n = 0, last = '';
    (list || visitsOf(s)).forEach(v => {
      if (v.skip || v.prop !== p.id || !/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) return;
      if (seasonOf(p, +v.date.slice(0, 4), dayNum(v.date.slice(5))) !== cur) return;
      n += v.mows;
      if (v.mows && v.date > last) last = v.date;
    });
    const byHand = p.mowsByHand && p.mowsByHand.season === cur && typeof p.mowsByHand.n === 'number';
    return { n: byHand ? p.mowsByHand.n : n, counted: n, last: last, byHand: byHand };
  }

  function render() {
    const sec = el('subsSection'), wrap = el('subsWrap');
    if (!sec || !wrap) return;
    sec.hidden = !owner();
    if (!owner()) return;
    if (form && document.activeElement && wrap.contains(document.activeElement) &&
        /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;     // not under someone typing
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    const list = subsList();
    const sugg = suggestions();
    wrap.innerHTML =
      (list.length ? '' : '<p class="empty-msg" style="margin-top:0">Work you sell and someone else does — the mowing, say. ' +
        'Add the company, then each property they look after: what they charge you and what you charge the client. ' +
        'Their bills come off Receipts to sort and are kept here.</p>') +
      (sugg.length ? '<div class="sub-sugg">Bills found from ' + sugg.map(v =>
        '<button class="link-btn" onclick="subAddNamed(this.dataset.v)" data-v="' + esc(v) + '">' + esc(v) + '</button>').join(', ') +
        ' — add as a subcontractor?</div>' : '') +
      list.map(s => subHtml(s, y, m)).join('') +
      (form && form.kind === 'sub' && !form.subId ? subFormHtml({}) :
        '<button class="btn btn-sm btn-accent" onclick="subEdit(\'\')">+ Add a subcontractor</button>');
  }

  function subHtml(s, y, m) {
    const t = totals(s, y, m), st = seasonTotals(s, y), o = owed(s);
    const props = propsOf(s), bills = billsOf(s);
    const monthName = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long' });
    return '<div class="sub-card">' +
      '<div class="sub-head"><b>' + esc(s.name || 'Subcontractor') + '</b>' +
        (s.phone ? ' <a class="link-btn" href="tel:' + esc(s.phone) + '">' + esc(s.phone) + '</a>' : '') +
        (s.email ? ' <a class="link-btn" href="mailto:' + esc(s.email) + '">Email</a>' : '') +
        '<button class="link-btn" onclick="subEdit(\'' + sid(s.id) + '\')">Edit</button></div>' +
      (form && form.kind === 'sub' && form.subId === s.id ? subFormHtml(s) : '') +
      '<div class="sub-figs">' +
        fig(monthName, props.length ? money(t.their) + ' to them · ' + money(t.ours) + ' from clients' : 'no properties yet') +
        fig('Margin this month', props.length ? marginText(t) : '—') +
        fig('This season', props.length ? marginText(st) : '—') +
        fig('Owed to them', o.count ? money(o.cents) + ' · ' + o.count + ' bill' + (o.count === 1 ? '' : 's') : 'nothing') +
      '</div>' +
      (o.late.length ? '<div class="sub-warn late">⚠️ Past due: ' + o.late.map(r => money(r.totalCents) + ' (due ' + fmtDateMD(r.dueDate) + ')').join(', ') + '</div>'
        : o.soon.length ? '<div class="sub-warn">Due soon: ' + o.soon.map(r => money(r.totalCents) + ' by ' + fmtDateMD(r.dueDate)).join(', ') + '</div>' : '') +
      '<details class="sub-more"' + (open[s.id] ? ' open' : '') + ' ontoggle="subToggle(\'' + sid(s.id) + '\', this.open)">' +
        '<summary>Properties (' + props.length + '), visits and bills (' + bills.length + ')</summary>' +
        propsHtml(s, props, y, m) +
        visitsHtml(s, props) +
        billsHtml(bills) +
      '</details>' +
    '</div>';
  }
  const fig = (label, value) => '<div class="sub-fig"><span class="sub-fig-l">' + esc(label) + '</span><span class="sub-fig-v">' + value + '</span></div>';

  function propsHtml(s, props, y, m) {
    // The property being edited gets its form under the table, not inside
    // it: the table scrolls sideways on a phone, and a form in it did too.
    const editing = form && form.kind === 'prop' && form.subId === s.id && form.propId
      ? props.find(p => p.id === form.propId) : null;
    const list = visitsOf(s);
    const rows = props.map(p => {
      const x = monthOf(p, y, m);
      const mw = mowsFor(s, p, list);
      // Ticked done this season (or ended for good): checked, with the date.
      // A done-for-the-season tick from an earlier season is history, not
      // this year's -- the box is clear again.
      const done = doneNow(p);
      return (editing === p ? '<tr class="sub-editing"><td colspan="9"><b>' + esc(p.client || 'Client') + '</b> — editing below</td></tr>' :
        '<tr class="' + (p.off ? 'sub-off' : '') + (done ? ' sub-done' : '') + '">' +
        '<td class="sub-done-cell"><label title="' + (done ? esc(DONE_WHY[p.doneWhy] || DONE_WHY.season) : 'Tick when done for the season or the service ended') + '">' +
          '<input type="checkbox"' + (done ? ' checked' : '') + ' onchange="subPropDone(\'' + sid(s.id) + '\', \'' + sid(p.id) + '\', this.checked)">' +
          (done ? '<span>' + esc(fmtDateMD(p.doneOn)) + (p.doneWhy === 'ended' ? '<br>ended' : '') + '</span>' : '') + '</label></td>' +
        '<td><b>' + esc(p.client || 'Client') + '</b>' + (p.address ? '<div class="muted">' + esc(p.address) + '</div>' : '') + '</td>' +
        '<td>' + ((p.services || []).length ? esc(p.services.join(', ')) : '<span class="muted">—</span>') + '</td>' +
        '<td class="sub-mows"><b>' + mw.n + '</b>' + (mw.byHand ? ' <span class="muted" title="Set by hand on the property (' + mw.counted +
          ' from their invoices)">✎</span>' : '') + (mw.last ? '<div class="muted">last ' + esc(fmtDateMD(mw.last)) + '</div>' : '') + '</td>' +
        '<td>' + esc(everyWords(p)) + '<div class="muted">' + esc((p.from || SEASON.from) + ' to ' + (p.to || SEASON.to)) + '</div></td>' +
        '<td>' + money(p.theirCents) + ' ' + esc(PER[p.theirPer] || '') + '</td>' +
        '<td>' + money(p.ourCents) + ' ' + esc(PER[p.ourPer] || '') + '</td>' +
        '<td>' + (x.their || x.ours ? marginText(x) : '—') + '</td>' +
        '<td><button class="link-btn" onclick="subProp(\'' + sid(s.id) + '\', \'' + sid(p.id) + '\')">Edit</button></td></tr>');
    }).join('');
    return '<div class="table-wrap"><table class="sub-table"><thead><tr><th>Done</th><th>Client</th><th>What they do</th>' +
        '<th title="This season, from their invoices (and what you set by hand)">Mows</th><th>How often</th><th>They charge</th>' +
        '<th>You charge</th><th>Margin this month</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="9" class="muted">No properties yet.</td></tr>') + '</tbody></table></div>' +
      (editing ? propFormHtml(s, editing)
        : form && form.kind === 'prop' && form.subId === s.id && !form.propId ? propFormHtml(s, {})
        : '<button class="btn btn-sm" onclick="subProp(\'' + sid(s.id) + '\', \'\')">+ Add a property</button>');
  }

  // Every visit their invoices show (and any added by hand), newest first:
  // which client, how many mows, whether it counts -- each settable here.
  const VISITS_SHOWN = 60;
  function visitsHtml(s, props) {
    const list = visitsOf(s);
    const loose = list.filter(v => !v.prop && !v.skip && v.mows);
    const pickProp = v => '<select onchange="subVisitProp(\'' + sid(s.id) + '\', \'' + sid(v.key) + '\', this.value, ' + !!v.hand + ')">' +
      '<option value="">— which client? —</option>' + props.map(p => '<option value="' + sid(p.id) + '"' +
        (p.id === v.prop ? ' selected' : '') + '>' + esc(p.client || 'Client') + '</option>').join('') + '</select>';
    const row = v => '<tr class="' + (v.skip ? 'sub-off' : '') + (!v.prop && !v.skip && v.mows ? ' sub-loose' : '') + '">' +
      '<td>' + esc(String(v.date || '').slice(0, 4) === String(new Date().getFullYear()) ? fmtDateMD(v.date) : fmtDateMDY(v.date)) + '</td>' +
      '<td>' + esc(v.service || '') + (v.hand ? ' <span class="rc-tag">by hand</span>' : '') +
        (v.address ? '<div class="muted">' + esc(v.address) + '</div>' : '') + '</td>' +
      '<td>' + (typeof v.cents === 'number' ? money(v.cents) : '') + '</td>' +
      '<td>' + pickProp(v) + '</td>' +
      '<td><input class="sub-mow-in" type="number" min="0" step="1" inputmode="numeric" value="' + v.mows + '"' +
        ' title="' + (v.setMows ? 'Set by hand' : v.guess ? 'A guess from how often — set it' : 'From the invoice') + '"' +
        ' onchange="subVisitMows(\'' + sid(s.id) + '\', \'' + sid(v.key) + '\', this.value, ' + !!v.hand + ')">' +
        (v.guess ? '<span class="muted" title="A month\'s worth, guessed from how often — set it to the real number">≈</span>' : '') + '</td>' +
      '<td>' + (v.hand
        ? '<button class="link-btn" onclick="subVisitRemove(\'' + sid(v.key) + '\')">Remove</button>'
        : '<label class="sub-count"><input type="checkbox"' + (v.skip ? '' : ' checked') +
          ' onchange="subVisitSkip(\'' + sid(v.key) + '\', !this.checked)"> Count</label>') + '</td></tr>';
    const today = ymd(new Date());
    const form = addingVisit === s.id
      ? '<div class="add-area sub-form"><div class="grid g4">' +
          '<div class="field"><span class="label">Date</span><input type="date" id="svDate" value="' + today + '"></div>' +
          '<div class="field"><span class="label">Client</span><select id="svProp">' + props.map(p => '<option value="' + sid(p.id) + '">' +
            esc(p.client || 'Client') + '</option>').join('') + '</select></div>' +
          '<div class="field"><span class="label">What</span><input id="svService" value="Mow"></div>' +
          '<div class="field"><span class="label">Mows</span><input id="svMows" type="number" min="0" step="1" value="1"></div>' +
        '</div><div class="field-actions"><button class="btn btn-filled btn-sm" onclick="subVisitSave(\'' + sid(s.id) + '\')">Add it</button>' +
          '<button class="btn btn-sm" onclick="subVisitCancel()">Cancel</button></div></div>'
      : '';
    return '<div class="sub-visits"><div class="sub-bills-h">Visits from their invoices' +
        (visitsDoc.scannedAt ? ' <span class="muted">· email checked ' + esc(fmtDateMD(visitsDoc.scannedAt.slice(0, 10))) + '</span>' : '') +
        '<span class="sub-visit-acts"><button class="link-btn" onclick="subCheckEmail()"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Checking…' : '📧 Check their email now') + '</button>' +
        (props.length ? '<button class="link-btn" onclick="subVisitAdd(\'' + sid(s.id) + '\')">+ Add a visit by hand</button>' : '') +
        '</span></div>' + form +
      (loose.length ? '<div class="sub-warn">' + loose.length + ' visit' + (loose.length === 1 ? '' : 's') +
        ' not matched to a client yet — pick who each was for and it counts (the next bill like it goes there by itself).</div>' : '') +
      (list.length
        ? '<div class="table-wrap"><table class="sub-table sub-visit-table"><thead><tr><th>Date</th><th>What</th><th>Bill</th>' +
            '<th>Client</th><th>Mows</th><th></th></tr></thead><tbody>' + list.slice(0, VISITS_SHOWN).map(row).join('') +
            '</tbody></table></div>' + (list.length > VISITS_SHOWN ? '<p class="muted">The ' + VISITS_SHOWN + ' latest of ' + list.length + '.</p>' : '')
        : '<p class="muted" style="margin:8px 0 0">' + (visitsDoc.scannedAt
            ? 'No invoices from them found in your email this year.'
            : 'Their invoices have not been read from your email yet — press Check their email now.') + '</p>') +
    '</div>';
  }

  function billsHtml(bills) {
    if (!bills.length) return '<p class="muted" style="margin:12px 0 0">No bills from them in Receipts yet.</p>';
    const t = ymd(new Date()), matched = paidByPayment(bills);
    return '<div class="sub-bills"><div class="sub-bills-h">Their bills</div>' + bills.slice(0, 24).map(r => {
      const pay = isPayment(r), bill = isBill(r), paid = isPaid(r, matched);
      const state = pay ? '<span class="rc-tag">Receipt</span>'
        : !bill ? '<span class="rc-tag">' + esc(String(r.docType || 'other').replace(/_/g, ' ')) + '</span>'
        : paid ? '<span class="rc-tag">Paid</span>'
        : r.dueDate && r.dueDate < t ? '<span class="rc-tag rc-owed">Past due</span>'
        : '<span class="rc-tag rc-owed">Owed' + (r.dueDate ? ' · due ' + fmtDateMD(r.dueDate) : '') + '</span>';
      return '<div class="sub-bill"><span>' + fmtDateMD(r.date) + ' · ' + esc(r.summary || r.orderNo || r.vendor || '') + '</span>' +
        '<span><b>' + money(r.totalCents) + '</b> ' + state +
        (bill && !(matched.has(r.id) || r.paid) ? ' <button class="link-btn" onclick="subPaid(\'' + sid(r.id) + '\', ' + (paid ? 'false' : 'true') + ')">' + (paid ? 'Not paid' : 'Mark paid') + '</button>' : '') +
        (r.link ? ' <a class="link-btn" href="' + esc(r.link) + '" target="_blank" rel="noopener">Email</a>' : '') + '</span></div>';
    }).join('') + '</div>';
  }

  function subFormHtml(s) {
    return '<div class="add-area sub-form">' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Company</span><input id="sbName" value="' + esc(s.name || '') + '"></div>' +
        '<div class="field"><span class="label">Words in their bills’ store name</span><input id="sbMatch" value="' + esc(s.match || '') + '" placeholder="Usually just their name"></div>' +
        '<div class="field"><span class="label">Phone</span><input id="sbPhone" inputmode="tel" value="' + esc(s.phone || '') + '"></div>' +
        '<div class="field"><span class="label">Email</span><input id="sbEmail" inputmode="email" value="' + esc(s.email || '') + '"></div>' +
      '</div>' +
      '<div class="field"><span class="label">Notes</span><input id="sbNotes" value="' + esc(s.notes || '') + '" placeholder="Terms, late fee, who to call"></div>' +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="subSave(\'' + sid(s.id || '') + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="subCancel()">Cancel</button>' +
        (s.id ? '<button class="btn btn-sm btn-danger" onclick="subRemove(\'' + sid(s.id) + '\')">Remove</button>' : '') + '</div>' +
    '</div>';
  }

  // The services to pick from: the usual ones, then any typed in on any
  // property, so a one-off name only has to be typed once.
  function serviceChoices(p) {
    const seen = SERVICES.slice();
    Object.values(data.subs || {}).forEach(s => propsOf(s).forEach(x => (x.services || []).forEach(n => {
      if (n && seen.indexOf(n) === -1) seen.push(n);
    })));
    (p.services || []).forEach(n => { if (n && seen.indexOf(n) === -1) seen.push(n); });
    return seen;
  }
  const svcPill = (name, on) => '<label class="bd-pick-item"><input type="checkbox" class="spSvc" value="' + esc(name) + '"' +
    (on ? ' checked' : '') + '><span>' + esc(name) + '</span></label>';

  function propFormHtml(s, p) {
    const jobs = (typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id).sort((a, b) => String(a.customerName || '').localeCompare(b.customerName || ''));
    const opt = (map, v) => Object.keys(map).map(k => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + map[k] + '</option>').join('');
    return '<div class="add-area sub-form">' +
      '<div class="field"><span class="label">Client’s job</span><select id="spJob" class="searchable" onchange="subJobPicked()">' +
        '<option value="">— not linked to a job —</option>' +
        jobs.map(j => '<option value="' + sid(j._id) + '"' + (j._id === p.jobId ? ' selected' : '') + '>' + esc(j.customerName || 'Untitled job') +
          (j.address ? ' — ' + esc(j.address) : '') + '</option>').join('') + '</select></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Client</span><input id="spClient" value="' + esc(p.client || '') + '"></div>' +
        '<div class="field"><span class="label">Address</span><input id="spAddr" value="' + esc(p.address || '') + '"></div>' +
        '<div class="field"><span class="label">How often</span><select id="spEvery" onchange="subEveryPicked()">' + opt(EVERY, p.every || 'weekly') + '</select>' +
          // Jonah (12 Oct 2026): "i want to be able to write in something if
          // the ofteness doesnt fit the options".
          '<div class="sub-every-other"' + (p.every === 'other' ? '' : ' hidden') + ' id="spEveryOther">' +
            '<input id="spEveryText" value="' + esc(p.everyText || '') + '" placeholder="e.g. Every 10 days, as needed">' +
            '<input id="spPerMonth" inputmode="decimal" value="' + (p.perMonth != null ? esc(String(p.perMonth)) : '') + '" ' +
              'placeholder="Visits a month" title="About how many visits a month — for the totals">' +
          '</div></div>' +
        '<div class="field"><span class="label">Season (month-day)</span><div class="sub-season">' +
          '<input id="spFrom" value="' + esc(p.from || SEASON.from) + '" placeholder="04-15"> to ' +
          '<input id="spTo" value="' + esc(p.to || SEASON.to) + '" placeholder="10-31"></div></div>' +
        '<div class="field"><span class="label">They charge you</span><div class="sub-price">$<input id="spTheir" inputmode="decimal" value="' +
          (typeof p.theirCents === 'number' ? (p.theirCents / 100).toFixed(2) : '') + '"><select id="spTheirPer">' + opt(PER, p.theirPer || 'visit') + '</select></div></div>' +
        '<div class="field"><span class="label">You charge the client</span><div class="sub-price">$<input id="spOurs" inputmode="decimal" value="' +
          (typeof p.ourCents === 'number' ? (p.ourCents / 100).toFixed(2) : '') + '"><select id="spOurPer">' + opt(PER, p.ourPer || 'visit') + '</select></div></div>' +
      '</div>' +
      '<div class="field"><span class="label">What they do here</span>' +
        '<div class="bd-pick" id="spSvcs">' + serviceChoices(p).map(n => svcPill(n, (p.services || []).indexOf(n) !== -1)).join('') + '</div>' +
        '<div class="sub-svc-add"><input id="spSvcNew" placeholder="Something else they do" ' +
          'onkeydown="if(event.key===\'Enter\'){event.preventDefault();subSvcAdd()}">' +
          '<button class="btn btn-sm" onclick="subSvcAdd()">+ Add</button></div></div>' +
      '<div class="field"><span class="label">Mows this season, by hand (blank: count them from their invoices)</span>' +
        '<input id="spMowsHand" type="number" min="0" step="1" inputmode="numeric" value="' +
          (p.mowsByHand && p.mowsByHand.season === seasonNow(p) && typeof p.mowsByHand.n === 'number' ? p.mowsByHand.n : '') + '"></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Done on (blank: still going)</span>' +
          '<input type="date" id="spDoneOn" value="' + esc(p.doneOn || '') + '"></div>' +
        '<div class="field"><span class="label">Done how</span><select id="spDoneWhy">' + opt(DONE_WHY, p.doneWhy || 'season') + '</select></div>' +
      '</div>' +
      '<label class="chk"><input type="checkbox" id="spOff"' + (p.off ? ' checked' : '') + '> Not this season (kept for the record)</label>' +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="subPropSave(\'' + sid(s.id) + '\', \'' + sid(p.id || '') + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="subCancel()">Cancel</button>' +
        (p.id ? '<button class="btn btn-sm btn-danger" onclick="subPropRemove(\'' + sid(s.id) + '\', \'' + sid(p.id) + '\')">Remove</button>' : '') + '</div>' +
    '</div>';
  }

  // ---------------------------------------------------------------- actions

  const v = id => ((el(id) || {}).value || '').trim();
  window.subToggle = function (id, isOpen) { open[id] = isOpen; };
  window.subEdit = function (id) { form = { kind: 'sub', subId: id || '' }; render(); };
  window.subAddNamed = function (name) {
    form = { kind: 'sub', subId: '' }; render();
    const n = el('sbName');
    if (n) { n.value = name || ''; el('sbMatch').value = matchOf(name); }
  };
  window.subCancel = function () { form = null; render(); };
  window.subSave = function (id) {
    const name = v('sbName');
    if (!name) { showToast('Give the company a name'); return; }
    const subId = id || newId('sb');
    const rec = { name: name, match: v('sbMatch') || matchOf(name), phone: v('sbPhone'), email: v('sbEmail'), notes: v('sbNotes'),
                  updatedAt: new Date().toISOString() };
    if (!id) { rec.createdAt = rec.updatedAt; rec.props = {}; }
    form = null;
    open[subId] = true;
    put({ subs: { [subId]: rec } }, 'saving ' + name);
    fileBills();
    showToast('Saved — ' + name);
  };
  window.subRemove = function (id) {
    const s = (data.subs || {})[id];
    if (!s || !confirm('Remove ' + (s.name || 'this subcontractor') + ' and its properties? Their bills stay in Receipts.')) return;
    form = null;
    put({ subs: { [id]: null } }, 'removing');
  };
  window.subProp = function (subId, propId) { form = { kind: 'prop', subId: subId, propId: propId || '' }; open[subId] = true; render(); };
  window.subJobPicked = function () {
    const id = v('spJob');
    const j = id && (loadAllJobs() || []).find(x => x._id === id);
    if (!j) return;
    if (!v('spClient')) el('spClient').value = j.customerName || '';
    if (!v('spAddr')) el('spAddr').value = [j.address, j.city].filter(Boolean).join(', ');
  };
  window.subPropSave = function (subId, propId) {
    const s = (data.subs || {})[subId];
    if (!s) return;
    const client = v('spClient');
    if (!client) { showToast('Who is the client?'); return; }
    const from = v('spFrom') || SEASON.from, to = v('spTo') || SEASON.to;
    if (dayNum(from) == null || dayNum(to) == null) { showToast('Season dates as month-day, like 04-15'); return; }
    if (v('spEvery') === 'other' && !v('spEveryText')) { showToast('Write in how often'); return; }
    const pid = propId || newId('sp');
    const rec = {
      jobId: v('spJob') || null, client: client, address: v('spAddr'), every: v('spEvery') || 'weekly',
      everyText: v('spEvery') === 'other' ? v('spEveryText') : null,
      perMonth: v('spEvery') === 'other' && v('spPerMonth') && isFinite(+v('spPerMonth')) ? +v('spPerMonth') : null,
      doneOn: /^\d{4}-\d{2}-\d{2}$/.test(v('spDoneOn')) ? v('spDoneOn') : null,
      doneWhy: /^\d{4}-\d{2}-\d{2}$/.test(v('spDoneOn')) ? (v('spDoneWhy') || 'season') : null,
      theirCents: cents(v('spTheir')), theirPer: v('spTheirPer') || 'visit',
      ourCents: cents(v('spOurs')), ourPer: v('spOurPer') || 'visit',
      services: Array.from(document.querySelectorAll('.spSvc:checked')).map(i => i.value),
      // Replaces this season's count (blank: counted from the invoices).
      mowsByHand: v('spMowsHand') !== '' && isFinite(+v('spMowsHand'))
        ? { season: seasonNow({ from: v('spFrom') || SEASON.from, to: v('spTo') || SEASON.to }), n: Math.max(0, Math.round(+v('spMowsHand'))) }
        : null,
      from: from, to: to, off: !!(el('spOff') && el('spOff').checked), updatedAt: new Date().toISOString(),
    };
    form = null;
    put({ subs: { [subId]: { props: { [pid]: rec } } } }, 'saving a property');
    showToast('Saved — ' + client);
  };
  // ------------------------------------------------- visits, set by hand
  window.subVisitProp = function (subId, key, propId, hand) {
    const s = (data.subs || {})[subId];
    if (!s) return;
    propId = propId && (s.props || {})[propId] ? propId : '';
    if (hand) { put({ handVisits: { [key]: { prop: propId || null } } }, 'moving a visit'); return; }
    const patch = { visitFix: { [key]: { prop: propId } } };
    // A bill with no address (a monthly one): the next bill for the same
    // service goes to the same client by itself.
    const v = (visitsDoc.visits || {})[key];
    if (v && !addrKey(v.address) && propId) patch.svcProp = { [subId]: { [svcKeyOf(v.service)]: propId } };
    put(patch, 'matching a visit');
  };
  window.subVisitMows = function (subId, key, value, hand) {
    const n = String(value).trim() === '' ? null : Math.max(0, Math.round(+value));
    if (n != null && !isFinite(n)) { showToast('Mows as a number'); render(); return; }
    if (hand) put({ handVisits: { [key]: { mows: n == null ? 0 : n } } }, 'setting mows');
    // Cleared: back to what the invoice says.
    else put({ visitFix: { [key]: { mows: n } } }, 'setting mows');
  };
  window.subVisitSkip = function (key, skip) { put({ visitFix: { [key]: { skip: !!skip } } }, skip ? 'not counting a visit' : 'counting a visit'); };
  window.subVisitRemove = function (key) {
    const v = (data.handVisits || {})[key];
    if (!v || !confirm('Remove this visit you added?')) return;
    put({ handVisits: { [key]: null } }, 'removing a visit');
  };
  window.subVisitAdd = function (subId) { addingVisit = subId; open[subId] = true; render(); };
  window.subVisitCancel = function () { addingVisit = ''; render(); };
  window.subVisitSave = function (subId) {
    const date = v('svDate'), prop = v('svProp'), mows = Math.max(0, Math.round(+v('svMows') || 0));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast('Pick the date'); return; }
    if (!prop) { showToast('Which client?'); return; }
    addingVisit = '';
    put({ handVisits: { [newId('hv')]: { sub: subId, prop: prop, date: date, service: v('svService') || 'Mow', mows: mows,
      at: new Date().toISOString() } } }, 'adding a visit');
    showToast('Added — ' + mows + ' mow' + (mows === 1 ? '' : 's'));
  };
  // Reads their invoice emails now rather than at the next half-hourly look
  // (functions/subvisits.py). The first time, the whole year.
  window.subCheckEmail = async function () {
    if (checking || !window.YDClaude) return;
    checking = true; render();
    try {
      const r = await YDClaude.post('/subs/scan', { full: !visitsDoc.scannedAt });
      const n = ((r && r.report) || {}).new || 0;
      showToast(n ? n + ' new visit' + (n === 1 ? '' : 's') + ' from their invoices' : 'Nothing new in their email');
    } catch (e) {
      showToast(e.message || 'Their email could not be read just now');
    } finally {
      checking = false; render();
    }
  };

  window.subEveryPicked = function () {
    const box = el('spEveryOther');
    if (box) box.hidden = v('spEvery') !== 'other';
    if (v('spEvery') === 'other' && el('spEveryText')) el('spEveryText').focus();
  };
  // The Done box on a property's row: ticked with today's date (done for the
  // season unless it was already marked ended), unticked clears it.
  window.subPropDone = function (subId, propId, on) {
    const p = (((data.subs || {})[subId] || {}).props || {})[propId];
    if (!p) return;
    put({ subs: { [subId]: { props: { [propId]: {
      doneOn: on ? ymd(new Date()) : null,
      doneWhy: on ? (p.doneWhy === 'ended' ? 'ended' : 'season') : null,
      updatedAt: new Date().toISOString(),
    } } } } }, on ? 'ticking done' : 'unticking done');
    showToast(on ? (p.client || 'It') + ' — done ' + fmtDateMD(ymd(new Date())) : (p.client || 'It') + ' — not done');
  };
  // Something not on the list: added ticked, without redrawing the form
  // (what is typed elsewhere in it stays).
  window.subSvcAdd = function () {
    const box = el('spSvcNew'), wrap = el('spSvcs');
    const name = box ? box.value.trim().slice(0, 40) : '';
    if (!name || !wrap) return;
    const have = Array.from(wrap.querySelectorAll('.spSvc')).find(i => i.value.toLowerCase() === name.toLowerCase());
    if (have) have.checked = true;
    else wrap.insertAdjacentHTML('beforeend', svcPill(name, true));
    box.value = '';
    box.focus();
  };
  window.subPropRemove = function (subId, propId) {
    const p = (((data.subs || {})[subId] || {}).props || {})[propId];
    if (!p || !confirm('Remove ' + (p.client || 'this property') + '?')) return;
    form = null;
    put({ subs: { [subId]: { props: { [propId]: null } } } }, 'removing a property');
  };
  window.subPaid = function (receiptId, paid) {
    put({ paid: { [receiptId]: paid ? ymd(new Date()) : null } }, 'marking a bill');
  };

  // ---------------------------------------------------------------- loading

  function stop() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null; fresh = false; form = null; addingVisit = '';
    data = { subs: {}, paid: {}, filed: {}, visitFix: {}, handVisits: {}, svcProp: {} };
    visitsDoc = { visits: {}, scannedAt: '' };
  }
  function start() {
    stop();
    if (!owner() || !window.YDDb) { render(); return; }
    unsub = window.YDDb.watch('settings', (changes, meta) => {
      changes.forEach(c => {
        const d = c.type === 'removed' ? {} : (c.data || {});
        if (c.id === 'subVisits') { visitsDoc = { visits: d.visits || {}, scannedAt: d.scannedAt || '' }; return; }
        if (c.id !== 'subcontractors') return;
        data = { subs: d.subs || {}, paid: d.paid || {}, filed: d.filed || {},
                 visitFix: d.visitFix || {}, handVisits: d.handVisits || {}, svcProp: d.svcProp || {} };
      });
      if (meta && meta.fromCache === false) fresh = true;
      fileBills();
      const p = el('panel-dashboard');
      if (p && p.classList.contains('active')) render();
    }, () => {});
  }
  document.addEventListener('yd-receipts', () => {
    fileBills();
    const p = el('panel-dashboard');
    if (p && p.classList.contains('active')) render();
  });

  window.YDSubs = { render: render, data: () => data, subFor: r => subFor(r) };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; if (k) start(); else stop(); }
    render();
  });
})();
