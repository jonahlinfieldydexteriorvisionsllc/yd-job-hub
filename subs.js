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
//                    props: { propId: { jobId, customerId, client, address,
//                                       every, everyText, perMonth,
//                                       services[], theirCents, theirPer,
//                                       ourCents, ourPer, from, to, off,
//                                       doneOn, doneWhy } } } }
//   paid: { receiptId: 'YYYY-MM-DD' }     bills marked paid here
//   visitFix / rcFix / handVisits          each bill's client, mows, Count
//                                          (see "every bill, and its client")
//   invFix: { qbInvoiceId: {skip, at} }    a client's invoice counted or not,
//                                          by hand (see "what the client paid")
//   subs[id].qbPayees: [{type, id, name}]  who they are in QuickBooks, by hand
//                                          (null: found by their name)
// customerId: the client in the customer list (customers.js) -- their
// name on a bill finds them, and what they owe is shown.
// every: weekly | biweekly | monthly | other (everyText written in, perMonth
// visits a month for the totals). *Per: visit | month. from/to: the season
// as MM-DD. doneOn: the day its Done box was ticked; doneWhy: season (back
// next season) | ended (for good). A key written null is a deleted one
// (writes merge).
//
// Their bills are receipts the email reader already files (receipts.js): a
// receipt sorted to them in Receipts (a split `to: 'sub'` with their
// `subId`), or whose store has a subcontractor's "match" words in it, is
// theirs. The owner's device takes those out of "Receipts to sort" by itself
// -- sorted whole to Subcontractors, their own place in Receipts since 13
// Oct 2026 (before that, set aside as "Subcontractor bill", which still
// reads as theirs) -- and they are listed here: owed, paid, due.

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

  const EMPTY = () => ({ subs: {}, paid: {}, filed: {}, visitFix: {}, handVisits: {}, svcProp: {}, rcFix: {}, invFix: {}, billTodos: {}, billTodosFrom: '' });
  let data = EMPTY();
  let visitsDoc = { visits: {}, payments: {}, scannedAt: '' };   // settings/subVisits (functions/subvisits.py)
  // settings/subClients (functions/subclients.py): each property's client in
  // QuickBooks -- invoices and payments -- and the money paid to each
  // subcontractor, read every hour.
  const NO_CLIENTS = () => ({ customers: {}, payees: {}, paidOut: {}, readAt: '' });
  let clientsDoc = NO_CLIENTS();
  let checking = false;       // "Check their email now" is waiting on the server
  let addingVisit = '';       // subId while its "add a visit by hand" form is open
  let fresh = false;          // from the server, not just this device's copy
  let unsub = null;
  let open = {};              // subId -> its details are open
  let form = null;            // { kind: 'sub'|'prop', subId, propId }
  // The bills (each one's client, below): what is open on the screen.
  let openBills = {};         // subId -> the property whose bills show under the table
  let changing = {};          // bill key -> its client buttons are open (Change)
  let allProps = {};          // bill key -> every property offered, not only the likeliest
  let finding = {};           // bill key -> "Another client…" is open
  let findQ = {};             // bill key -> what is typed in it
  let matchAll = {};          // subId -> every bill to match listed
  let billsAll = {};          // subId -> every bill listed
  let memo = { at: 0, bySub: {} };     // each subcontractor's bills, worked out

  const el = id => document.getElementById(id);
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const two = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const sid = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const money = c => (typeof c === 'number' && isFinite(c) ? fmtMoney(c / 100) : '—');
  const cents = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : Math.round(n * 100); };
  // The key is the id, whatever the record says: a record carrying an `id` of
  // its own used to win, and a bill filed under that id then found nobody.
  const live = o => Object.keys(o || {}).filter(k => o[k]).map(k => Object.assign({}, o[k], { id: k }));
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
  function put(patch, what) { applyLocal(patch); forget(); save(patch, what); render(); }

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
  // What a property comes to in a month: how many visits, what the
  // subcontractor charges for them and what YD charges the client.
  //
  // WHOLE visits on real dates (Jonah, 13 Oct 2026, of the old figures
  // "how ... do you mess that simple of math up"): they used to be "days in
  // season / 7" -- 4.43 mows in October, $199.29 of margin. Now a weekly
  // property is mowed on its day of the week (the day of its latest visit on
  // their invoices, else the season's first day) and every such date in the
  // season counts once; every other week counts every second one from that
  // day; once a month is one visit. A month-priced property counts a month in
  // full when at least half of it is in season. upTo (a day of the month)
  // counts only the visits so far.
  function inSeason(p, y, m, d) {
    const from = dayNum(p.from || SEASON.from), to = dayNum(p.to || SEASON.to), k = (m + 1) * 100 + d;
    return (from == null || to == null || (from <= to ? k >= from && k <= to : k >= from || k <= to)) && !stoppedOn(p, y, k);
  }
  function anchorOf(p, y, anchor) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) return Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7) - 1, +anchor.slice(8, 10));
    const from = /^(\d{2})-(\d{2})$/.exec(p.from || SEASON.from) || [0, '04', '15'];
    return Date.UTC(y, +from[1] - 1, +from[2]);
  }
  function monthOf(p, y, m, anchor, upTo) {
    const s = seasonDays(p, y, m);
    if (!s.n || p.off) return { visits: 0, their: 0, ours: 0 };
    const last = new Date(y, m + 1, 0).getDate(), end = Math.min(last, upTo || last);
    const fullMonth = s.n * 2 >= s.of;                  // at least half the month in season
    let visits = 0;
    if (p.every === 'monthly') {
      visits = fullMonth && (!upTo || [...Array(end).keys()].some(i => inSeason(p, y, m, i + 1))) ? 1 : 0;
    } else if (p.every === 'other') {
      // Written in by hand ("every 10 days", "as needed"): as many visits a
      // month as were given for it, in whole visits, none if none were.
      visits = Math.round((+p.perMonth || 0) * (s.n / s.of) * (upTo ? end / last : 1));
    } else {
      const step = p.every === 'biweekly' ? 14 : 7, a = anchorOf(p, y, anchor);
      for (let d = 1; d <= end; d++) {
        const diff = Math.round((Date.UTC(y, m, d) - a) / 864e5);
        if (((diff % step) + step) % step === 0 && inSeason(p, y, m, d)) visits++;
      }
    }
    const monthsShare = fullMonth && (!upTo || end >= 1) ? 1 : 0;
    const cost = (c, per) => (typeof c === 'number' ? Math.round(per === 'month' ? c * monthsShare : c * visits) : 0);
    return { visits: visits, their: cost(p.theirCents, p.theirPer), ours: cost(p.ourCents, p.ourPer) };
  }
  // Each property's day for the schedule: its latest visit on their invoices.
  function anchorsOf(s) {
    const out = {};
    visitsOf(s).forEach(v => {
      if (v.prop && !v.skip && v.mows && /^\d{4}-\d{2}-\d{2}$/.test(v.date || '') && (!out[v.prop] || v.date > out[v.prop])) out[v.prop] = v.date;
    });
    return out;
  }
  function totals(s, y, m, upTo) {
    const anchors = anchorsOf(s);
    return propsOf(s).reduce((t, p) => {
      const x = monthOf(p, y, m, anchors[p.id], upTo);
      t.visits += x.visits; t.their += x.their; t.ours += x.ours;
      return t;
    }, { visits: 0, their: 0, ours: 0 });
  }
  // The season by its months; soFar stops at today.
  function seasonTotals(s, y, soFar) {
    const t = { visits: 0, their: 0, ours: 0 }, now = new Date();
    for (let m = 0; m < 12; m++) {
      if (soFar && (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth()))) break;
      const x = totals(s, y, m, soFar && y === now.getFullYear() && m === now.getMonth() ? now.getDate() : 0);
      t.visits += x.visits; t.their += x.their; t.ours += x.ours;
    }
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
  // Whether a name (its words, `want`) is in a store's name (`have`): every
  // word of it -- or, run together, the same letters on whole words, the way
  // the server matches their invoice emails (subvisits.names_match): "Green
  // Acre" is "GreenAcre Lawn Care", and "GreenAcre" is "Green Acre Mowing".
  // Whole words only, so "Art" is never found in "Smartlawn".
  function nameIn(want, have) {
    if (!want.length || !have.length) return false;
    if (want.every(w => have.indexOf(w) !== -1)) return true;
    const joined = want.join(''), all = have.join('');
    const starts = {}, ends = {};
    let at = 0;
    have.forEach(w => { starts[at] = true; at += w.length; ends[at] = true; });
    for (let i = all.indexOf(joined); i !== -1; i = all.indexOf(joined, i + 1)) {
      if (starts[i] && ends[i + joined.length]) return true;
    }
    return false;
  }
  // The names a bill goes by: the store the email reader wrote down, and --
  // for a bill sent through Jobber or the like, where that can come out as
  // the billing service's name -- who the email was from and the company in
  // an "Invoice from <company> - ..." subject.
  function billNames(r) {
    const out = [r.vendor];
    (Array.isArray(r.mail) ? r.mail : []).forEach(m => {
      if (!m) return;
      const from = String(m.from || '').replace(/<[^>]*>/g, ' ').replace(/["']/g, ' ');
      if (from.trim()) out.push(from);
      const subj = /^\s*(?:(?:re|fwd?|fw)\s*:\s*)*invoice from\s+(.+?)\s+[-–—]\s/i.exec(String(m.subject || ''));
      if (subj) out.push(subj[1]);
    });
    return out.map(words).filter(w => w.length);
  }
  // Whose bill a receipt is: the subcontractor whose "match" words -- or
  // whose name, should the match words have been typed another way -- are in
  // one of the bill's names (case, punctuation and "LLC"/"Inc" never count).
  // It used to read the match words alone against the store alone, so a
  // subcontractor set up under exactly the store's name was still "not set
  // up" when the match words were spaced differently from the bill.
  function subFor(r) {
    const names = billNames(r || {});
    if (!names.length) return null;
    const fits = text => { const want = words(text); return names.some(have => nameIn(want, have)); };
    const subs = subsList();
    // The match words first: they are what was set up to pick the bills out.
    return subs.find(s => s.match && fits(s.match)) || subs.find(s => fits(s.name)) || null;
  }
  // Whose bill it is, sorted or not: the subcontractor it was put to in
  // Receipts when that names one set up here, else by the store's name.
  function subOf(r) {
    const sp = (r.splits || []).find(x => x && x.to === 'sub' && x.subId && (data.subs || {})[x.subId]);
    return sp ? Object.assign({ id: sp.subId }, data.subs[sp.subId]) : subFor(r);
  }
  // One set aside in Receipts counts for nothing here either -- a second copy
  // of a bill set aside as a duplicate is not money owed twice. (An old bill
  // set aside "subcontractor" is filed to them: YDStages says so.)
  const setAside = r => !!(window.YDStages && YDStages.receipt(r).id === 'aside');
  function billsOf(s) {
    const all = receiptsAll();
    return Object.keys(all).map(id => Object.assign({ id: id }, all[id]))
      .filter(r => { if (setAside(r)) return false; const w = subOf(r); return w && w.id === s.id; })
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  const isPayment = r => r.docType === 'receipt' || r.docType === 'person_payment';
  const isBill = r => r.docType === 'invoice';
  // Invoices a later payment of the same amount paid. The email reader puts a
  // payment with its bill only while the bill is still waiting to be sorted,
  // and theirs are filed here at once -- so a payment can arrive as a
  // receipt of its own.
  // `by` says which payment paid which bill; `used`, the payments that did.
  function pairPayments(bills) {
    const done = new Set(), used = new Set(), by = {};
    const pays = bills.filter(isPayment);
    bills.filter(r => isBill(r) && !r.paid).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .forEach(inv => {
        const p = pays.find(x => !used.has(x.id) && x.totalCents === inv.totalCents && String(x.date || '') >= String(inv.date || ''));
        if (p) { used.add(p.id); done.add(inv.id); by[inv.id] = p.id; }
      });
    return { paid: done, used: used, by: by };
  }
  const paidByPayment = bills => pairPayments(bills).paid;
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
  // one is filed once (kept in `filed`), so Undo in Receipts sticks.
  //
  // Filed the way Receipts sorts one to Subcontractors by hand: done, every
  // line (and the tax) in one split to them. A receipt's own fields are only
  // splits/status/statusChange/updatedAt/updatedBy here -- what the rules let
  // a sorter change. Its status goes to Filed, said to be by Job Hub
  // (stages.js), so All receipts does not name whoever's device it was.
  function fileBills() {
    if (!owner() || !fresh || !window.YDReceipts || !YDReceipts.loaded || !YDReceipts.loaded() || !window.YDDb) return;
    const all = receiptsAll(), filed = data.filed || {}, now = {};
    const at = new Date().toISOString(), by = ((window.YDAuth && YDAuth.user) || {}).uid || '';
    Object.keys(all).forEach((id, n) => {
      const r = all[id];
      const s = window.YDStages.receipt(r).id === 'tosort' && !(r.splits || []).length && !filed[id] && r.kind === 'subcontractor' ? subFor(r) : null;
      if (!s) return;
      const lines = r.lines || [];
      const lineCents = lines.reduce((t, l) => t + (l.cents || 0), 0);
      const split = { id: 'sp' + Date.now().toString(36) + n.toString(36) + Math.random().toString(36).slice(2, 5),
        to: 'sub', subId: s.id, name: s.name || r.vendor || 'Subcontractor', lines: lines.map((_, i) => i),
        cents: lines.length ? lineCents : Math.max(0, (r.totalCents || 0) - (r.taxCents || 0)),
        taxCents: r.taxCents || 0, at: at, by: 'Job Hub' };
      const patch = { status: 'done', splits: [split], updatedAt: at, updatedBy: by };
      const stamp = window.YDStages.stamp('done', { uid: '', name: 'Job Hub' });
      Object.assign(r, patch, { statusChange: stamp });
      now[id] = true;
      Promise.resolve(window.YDDb.put('receipts', id, patch))
        .catch(e => console.warn('[subs] bill not yet filed:', (e && e.code) || e));
      // Apart, as receipts.js does: a refused stamp never unfiles the bill.
      Promise.resolve(window.YDDb.put('receipts', id, { statusChange: stamp }))
        .catch(e => console.warn('[subs] who filed it not saved:', (e && e.code) || e));
    });
    if (Object.keys(now).length) { applyLocal({ filed: now }); save({ filed: now }, 'noting filed bills'); }
  }

  // ------------------------------------------- a to-do to bill the client
  //
  // Jonah (21 Oct 2026): "whenever [his mowing] subcontractor payment
  // receipt comes in for mowing make to do item to bill the client it was
  // for." Each new bill of a subcontractor's -- their invoice email for a
  // visit, a bill in Receipts, or a payment to them with no bill -- once it
  // is put with a client (its address, the client's name, his pick, their
  // price: computeBills) puts one card on My to-dos (boards/todo), due today:
  // "💵 Bill <client>". A client charged by the month gets one card a month,
  // not one a visit. Made once: billTodos {key: {card, at}} remembers it, so
  // a card he finished or deleted never comes back. Only bills from when this
  // was first switched on (billTodosFrom, written the first time) -- the
  // season's earlier ones were billed already. A bill no client could be told
  // from waits in "Bills to match"; its card is made once he picks the client.
  // Plain code, on the owner's device (the one place the matching lives).
  const BILL_LATE_DAYS = 7;       // their email can come a few days after the visit
  const BILL_TODOS_MAX = 20;      // cards made at one go
  let todoBusy = false;
  async function billTodos() {
    if (todoBusy || !owner() || !fresh || !window.YDReceipts || !YDReceipts.loaded || !YDReceipts.loaded() || !window.YDDb) return;
    if (!data.billTodosFrom) {
      const from = { billTodosFrom: new Date().toISOString() };
      applyLocal(from); save(from, 'starting bill to-dos');
      return;
    }
    const start = Date.parse(data.billTodosFrom);
    if (isNaN(start)) return;
    // A bill dated from then on -- or a visit dated a little before whose
    // email only came after (Jobber can send it days later).
    const startDay = ymd(new Date(start)), lateDay = ymd(new Date(start - BILL_LATE_DAYS * 864e5));
    const isNew = b => b.date >= startDay || (b.date >= lateDay && b.visitKey &&
      Date.parse(((visitsDoc.visits || {})[b.visitKey] || {}).foundAt || '') >= start);
    const made = data.billTodos || {}, want = [], keys = {};
    subsList().forEach(s => {
      billsFor(s).bills.forEach(b => {
        if (b.hand || !b.counts || !b.prop || !isDay(b.date) || !isNew(b)) return;
        const p = (s.props || {})[b.prop];
        if (!p) return;
        const monthly = p.ourPer === 'month';
        const key = (sid(s.id) + '_' + (monthly ? 'm' + sid(b.prop) + '_' + b.date.slice(0, 7) : sid(b.key))).slice(0, 120);
        if (made[key] || keys[key]) return;
        keys[key] = true;
        want.push({ key: key, s: s, b: b, p: p, monthly: monthly });
      });
    });
    if (!want.length) return;
    todoBusy = true;
    try {
      const board = await window.YDDb.getFresh('boards', 'todo');
      const cols = ((board && board.columns) || []).filter(c => c && c.id);
      if (!cols.length) return;
      const col = (cols.find(c => String(c.name || '').trim().toLowerCase() === 'today') || cols[0]).id;
      const at = new Date().toISOString(), today = ymd(new Date()), note = {};
      want.slice(0, BILL_TODOS_MAX).forEach((w, i) => {
        const id = 'sb' + Date.now().toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 5);
        const card = billCard(w, col, at, today, i);
        Promise.resolve(window.YDDb.put('boards/todo/cards', id, card))
          .catch(e => console.warn('[subs] bill to-do not yet on the server:', (e && e.code) || e));
        note[w.key] = { card: id, at: at };
      });
      applyLocal({ billTodos: note });
      save({ billTodos: note }, 'noting bill to-dos');
    } catch (e) {
      console.warn('[subs] bill to-dos not made:', (e && e.code) || e);
    } finally {
      todoBusy = false;
    }
  }
  const shortDay = d => { const t = new Date(d + 'T12:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  const monthName = d => { const t = new Date(d + 'T12:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'long' }); };
  function billCard(w, col, at, today, i) {
    const s = w.s, b = w.b, p = w.p;
    const client = String(p.client || '').trim() || 'the client';
    const what = String(b.service || '').trim() || ((p.services || [])[0]) || 'mowing';
    const where = String(b.address || p.address || '').trim();
    const theirs = typeof b.cents === 'number' ? ' — their bill ' + money(b.cents) : '';
    const ours = typeof p.ourCents === 'number' ? 'You charge ' + money(p.ourCents) + ' ' + (PER[p.ourPer] || '') + '.' : 'No price of yours is set for this property (All Jobs → Subcontractors).';
    const title = w.monthly
      ? '💵 Bill ' + client + ' for ' + monthName(b.date) + ' — ' + what
      : '💵 Bill ' + client + ' — ' + what + ' ' + shortDay(b.date);
    const notes = (s.name || 'The subcontractor') + ' did ' + what + (where ? ' at ' + where : '') + ' on ' + shortDay(b.date) + theirs + '.\n' +
      ours + '\n' + (w.monthly ? 'They are billed by the month: bill ' + client + ' for ' + monthName(b.date) + ' in QuickBooks.'
        : 'Bill ' + client + ' for it in QuickBooks.') +
      (b.how && b.how !== 'hand' ? '\n\n(Put with ' + client + ' by ' + ({ address: 'the address', name: 'their name', learned: 'your earlier picks', price: 'their price' }[b.how] || b.how) +
        ' — if that’s wrong, change it under All Jobs → Subcontractors.)' : '');
    return {
      title: title.slice(0, 200), notes: notes.slice(0, 5000), checklist: [], column: col, order: Date.now() + i,
      due: today, dueTime: null, remindMins: null, hasReminder: false, remindUids: [], noReminder: false,
      type: null, urgency: 'normal', labels: [], color: null, assignees: [],
      jobId: p.jobId || null, jobName: client, jobNum: null,
      // His to-do, not one for Claude's card runs (cards.py).
      noClaude: true, subBill: { sub: s.id, prop: b.prop, bill: b.key },
      doneAt: null, createdAt: at, createdBy: 'Job Hub', updatedAt: at, updatedBy: 'Job Hub',
    };
  }

  // Stores the email reader called subcontractors that are not set up here.
  function suggestions() {
    const seen = {};
    Object.values(receiptsAll()).forEach(r => {
      if (r.kind !== 'subcontractor' || !r.vendor || subOf(r)) return;
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
  // cents, msgIds}. Each bill (below: a visit, a receipt, or both) is put
  // with a client and counted as mows: one for a visit, a month's worth (from
  // how often) for a monthly bill (≈, a guess until set), none for other
  // work. What Jonah sets by hand is kept beside them in
  // settings/subcontractors and always wins:
  //   visitFix:   { visitKey: { prop, none, mows, skip, at } }
  //   rcFix:      { receiptId: { prop, none, mows, skip, at } }
  //   handVisits: { id: { sub, prop, date, service, mows } }
  // and a property's own mowsByHand {season, n} replaces its whole count.
  // (svcProp -- the client a service last went to, kept before 16 Oct -- is
  // no longer read: his picks themselves teach now, below.)
  const MOWING = /mow|lawn/i;
  const ABBR = { saint: 'st', street: 'st', drive: 'dr', avenue: 'ave', road: 'rd', lane: 'ln', court: 'ct',
                 circle: 'cir', boulevard: 'blvd', place: 'pl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter',
                 trail: 'trl', north: 'n', south: 's', east: 'e', west: 'w' };
  const svcKeyOf = s => norm(s).replace(/ /g, '-').slice(0, 60);
  // Every address in a piece of text, each as house number + street name,
  // the way two spellings of one agree ("120 Saint Marys Dr" is "120 St
  // Marys Drive"). A rural fire number (N1234) counts as the number.
  function addrKeysIn(text) {
    const t = norm(text).split(' ').filter(Boolean).map(w => ABBR[w] || w);
    const out = [];
    t.forEach((w, i) => {
      if (!/^[nsew]?\d+$/.test(w)) return;
      let rest = t.slice(i + 1, i + 6).filter(x => !/^[nsew]$/.test(x));
      if (rest[0] === 'st' && rest.length > 1) rest = rest.slice(1);   // "St Marys", "Saint Marys"
      if (rest[0] && !/^\d+$/.test(rest[0]) && out.indexOf(w + ' ' + rest[0]) === -1) out.push(w + ' ' + rest[0]);
    });
    return out;
  }

  // ------------------------------------------------- every bill, and its client
  //
  // Jonah (16 Oct 2026), of his mowing subcontractor: "all bills from
  // [them] get matched with the client the bill is for or if cant be
  // matched once theyre sorted to [that] subcontractor then i select which
  // client it was for. this needs to be done."
  //
  // ONE BILL, ONCE. A subcontractor's bill reaches Job Hub two ways, mostly
  // both: the email reader keeps it as a receipt (filed to them, above), and
  // their invoice emails are read for the visits (subvisits.py). The same
  // email is then a receipt AND a visit. They are one bill when they came
  // from the same email (a receipt's mail ids, a visit's msgIds) -- else the
  // same amount read within PAIR_DAYS at an address that does not disagree.
  // A reminder read as a second receipt joins the first by its invoice
  // number (or: same amount, same due day, same subject); a payment goes
  // with the bill it paid, and is never a cost of its own while they send
  // bills at all (one payment for four bills would count them twice). A
  // receipt Jonah sorted somewhere else in Receipts (a job, the shop) takes
  // its visit with it: not theirs to put with a client.
  //
  // WHICH CLIENT, in this order:
  //   1. by hand -- what Jonah picked always wins (visitFix / rcFix: {prop},
  //      or {none: true} for "Not for a client");
  //   2. the address -- the house number and street on the bill are one
  //      property's (its own address, else its job's or its customer's); or
  //      an address he put with one client before;
  //   3. the name -- one property's client (or their customer / job name) is
  //      named on the bill;
  //   4. learned -- on a bill with no address, the same work for the same
  //      amount went to one client when he picked;
  //   5. their price -- on a bill with no address, the amount is what one
  //      property is priced at by them (22 Oct 2026).
  // Only ONE property is a match: two that fit are no answer, and the bill
  // waits under "Bills to match" with a button for each property. Nothing of
  // this is stored: it is worked out again from the bills, the properties
  // and his picks every time, so changing a pick un-teaches it, and the
  // bills filed before this were matched the same way the moment it came in.
  const PAY_DOCS = ['receipt', 'person_payment'];
  const COST_DOCS = ['invoice', 'other', 'order_confirmation'];
  const PAIR_DAYS = 3;                      // a receipt and a visit of one bill
  const PAY_BEFORE_DAYS = 10, PAY_AFTER_DAYS = 120;   // a payment, around the bill it paid
  // A payment can be the bill plus tax or a card fee (a bill paid with the
  // sales tax added at the bank): up to this share more is still that bill.
  const PAY_EXTRA = 0.1;
  // The same money told twice -- their payment receipt email and the bank's
  // line in QuickBooks a day or two later.
  const SAME_PAY_DAYS = 5;
  const MATCH_SHOWN = 6, PROPS_SHOWN = 9, BILLS_SHOWN = 40;
  const HOW = { hand: '✋ you picked it', address: '📍 by the address', name: '👤 by the name on it', learned: '🔁 like one you picked',
                price: '💲 by their price' };
  // Words in a client's name that are not their name.
  const NAME_SKIP = ['residence', 'home', 'house', 'property', 'family', 'rental', 'mr', 'mrs', 'ms', 'dr', 'jr', 'sr'].concat(FILLER);
  const nameWords = n => norm(n).split(' ').filter(w => w.length > 1 && !/^\d+$/.test(w) && NAME_SKIP.indexOf(w) === -1);
  const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const dayMs = d => (isDay(String(d || '').slice(0, 10)) ? Date.parse(String(d).slice(0, 10)) : NaN);
  const apart = (a, b) => { const x = dayMs(a), y = dayMs(b); return isNaN(x) || isNaN(y) ? Infinity : Math.abs(x - y) / 864e5; };
  const dayWords = d => (isDay(d) ? (d.slice(0, 4) === String(new Date().getFullYear()) ? fmtDateMD(d) : fmtDateMDY(d)) : '');

  // "Invoice from <company> - <the work> - <the address>": Jobber's subject,
  // read the way the server reads it (subvisits.parse).
  function subjectParts(subject) {
    const m = /^\s*(?:(?:re|fwd?|fw)\s*:\s*)*invoice(?:\s+#?\S+)?\s+from\s+(.+)$/i.exec(String(subject || ''));
    if (!m) return null;
    const parts = m[1].split(/\s+[-–—]\s+/).map(x => x.trim()).filter(Boolean);
    return { service: parts[1] || '', address: parts.slice(2).join(' - ') };
  }
  const firstSubject = r => ((r.mail || []).find(x => x && subjectParts(x.subject)) || (r.mail || [])[0] || {}).subject || '';
  // What a receipt says that can name a client or a place.
  const receiptText = r => [r.jobHint, r.deliverTo, r.summary, r.po].concat((r.lines || []).map(l => l && l.name),
    (r.mail || []).map(x => x && x.subject)).filter(Boolean).join(' ; ');
  // A receipt of theirs: a bill or a payment; sorted somewhere else in
  // Receipts (not theirs to match); or still to sort and not even called a
  // subcontractor's (it may yet go on a job -- a sub who sells materials).
  function roleOf(r) {
    const sp = Array.isArray(r.splits) ? r.splits.filter(Boolean) : [];
    return {
      kind: PAY_DOCS.indexOf(r.docType) !== -1 ? 'payment' : COST_DOCS.indexOf(r.docType || 'other') !== -1 ? 'bill' : 'other',
      elsewhere: sp.length > 0 && !sp.some(x => x.to === 'sub'),
      pending: !sp.length && !!window.YDStages && YDStages.receipt(r).id === 'tosort' && r.kind !== 'subcontractor',
    };
  }
  // What it cost them: the part filed to this subcontractor (with its tax),
  // else the whole receipt.
  function receiptCents(r, s) {
    const sp = (r.splits || []).filter(x => x && x.to === 'sub' && (!x.subId || x.subId === s.id));
    if (sp.length) return sp.reduce((t, x) => t + (x.cents || 0) + (x.taxCents || 0), 0);
    return typeof r.totalCents === 'number' ? r.totalCents : null;
  }
  // An invoice number however it is written ("A-77" is "a77"), or ''.
  const noOf = n => norm(n).replace(/ /g, '');
  // Whether a payment could be this bill: the same amount, or the bill with
  // tax or a fee on top (PAY_EXTRA).
  const withExtra = (bill, paid) => typeof bill === 'number' && typeof paid === 'number' && paid >= bill &&
    paid <= Math.round(bill * (1 + PAY_EXTRA));

  // Every payment to them, each once. A payment is told in up to three
  // places: a payment receipt the email reader kept in Receipts, their
  // payment receipt email read for the visits (subvisits.py), and the money
  // out in QuickBooks (subclients.py -- the bank's line, a day or two
  // later). The email read both ways is the receipt (the same message); a
  // QuickBooks line for the same amount within SAME_PAY_DAYS of one already
  // here is that one. Receipts already put with their bill (pairPayments)
  // are not handed back -- but still stand for their QuickBooks line.
  function paymentsOf(s, rs, pay) {
    const out = [], told = [], mail = new Set();
    rs.forEach(r => (r.mail || []).forEach(m => { if (m && m.id) mail.add(m.id); }));
    rs.filter(r => r.role.kind === 'payment' && !r.role.elsewhere).forEach(r => {
      const p = { key: r.id, r: r, date: r.date || '', cents: receiptCents(r, s), invoiceNo: noOf(r.orderNo),
        link: r.link || '', what: 'Payment', src: 'receipt' };
      told.push(p);
      if (!pay.used.has(r.id)) out.push(p);
    });
    Object.keys(visitsDoc.payments || {}).forEach(k => {
      const v = visitsDoc.payments[k];
      if (!v || v.sub !== s.id || (v.msgIds || []).some(id => mail.has(id))) return;
      const p = { key: k, date: v.date || v.sent || '', cents: typeof v.cents === 'number' ? v.cents : null,
        invoiceNo: noOf(v.invoiceNo), what: 'Payment' + (v.invoiceNo ? ' for their invoice #' + v.invoiceNo : ''),
        text: v.subject || '', src: 'email' };
      told.push(p); out.push(p);
    });
    ((clientsDoc.paidOut || {})[s.id] || []).forEach(q => {
      if (!q || typeof q.cents !== 'number' || q.cents <= 0) return;
      const same = told.find(p => !p.qb && p.cents === q.cents && apart(p.date, q.date) <= SAME_PAY_DAYS);
      if (same) { same.qb = q; return; }
      const p = { key: 'q' + sid(q.id), qb: q, date: q.date || '', cents: q.cents, invoiceNo: '',
        what: 'Paid — ' + (q.type || 'in QuickBooks') + (q.account ? ', ' + q.account : ''), text: q.memo || '', src: 'qb' };
      told.push(p); out.push(p);
    });
    return out.sort((a, c) => String(a.date).localeCompare(String(c.date)) || String(a.key).localeCompare(String(c.key)));
  }

  // Jobs and customers, read once for each working-out.
  function lookups() {
    const jobs = {};
    let custs = {};
    try { (typeof loadAllJobs === 'function' ? loadAllJobs() || [] : []).forEach(j => { if (j && j._id) jobs[j._id] = j; }); } catch (e) { /* not ready */ }
    try { custs = (window.YDCustomers && YDCustomers.all && YDCustomers.all()) || {}; } catch (e) { /* not ready */ }
    return { jobs: jobs, custs: custs, keys: {} };
  }
  const jobOf = (p, L) => (p.jobId && L.jobs[p.jobId]) || null;
  const custOf = (p, L) => (p.customerId && L.custs[p.customerId]) ||
    ((jobOf(p, L) || {}).customerId && L.custs[jobOf(p, L).customerId]) || null;
  // Where a property is: its own address; with none, its job's or its
  // customer's (where the work is first).
  function propKeys(p, L) {
    const own = addrKeysIn([p.address, p.street].filter(Boolean).join(' ; '));
    if (own.length) return own;
    const j = jobOf(p, L), c = custOf(p, L), ship = (c && c.ship) || {};
    return addrKeysIn([j && j.address, ship.address || ship.street, c && (c.address || c.street)].filter(Boolean).join(' ; '));
  }
  // Where it is, in words (the first part of the address it goes by).
  const placeOf = (p, L) => {
    const j = jobOf(p, L), c = custOf(p, L), ship = (c && c.ship) || {};
    return String(p.address || (j && j.address) || ship.address || (c && c.address) || '').split(',')[0];
  };
  const propNames = (p, L) => { const j = jobOf(p, L), c = custOf(p, L); return [p.client, c && c.name, c && c.business, j && j.customerName].filter(Boolean); };
  // A client is named on a bill when every word of their name is on it --
  // two words at least, or one of four letters or more ("Doe" alone is not
  // enough to tell).
  const namedOn = (p, b, L) => propNames(p, L).some(n => {
    const w = nameWords(n);
    return (w.length > 1 || (w.length === 1 && w[0].length >= 4)) && w.every(x => b.words.has(x));
  });

  function newBill(key, f) {
    return Object.assign({ key: key, visitKey: '', handKey: '', rids: [], receipts: [], rcBill: null, paidBy: null, payOnly: false,
      hand: false, date: '', sent: '', cents: null, service: '', address: '', text: '', link: '',
      prop: null, none: false, how: '', from: '', elsewhere: false, skip: false, mows: 0, setMows: false, guess: false, counts: false }, f);
  }
  function addReceipt(b, r, s) {
    b.rids.push(r.id); b.receipts.push(r);
    if (r.role.elsewhere) b.elsewhere = true;
    else if (!r.role.pending && r.role.kind === 'bill' && !b.rcBill) {
      b.rcBill = r;
      const c = receiptCents(r, s);
      if (typeof c === 'number') b.cents = c;      // what the books hold
    }
    const sp = subjectParts(firstSubject(r)) || {};
    if (!b.service) b.service = sp.service || ((r.lines || [])[0] || {}).name || r.summary || '';
    if (!b.address) b.address = sp.address || '';
    if (!b.date) b.date = r.date || '';
    if (!b.link && r.link) b.link = r.link;
    b.text += ' ; ' + receiptText(r);
  }
  // A bill's picks: on its visit, and on each of its receipts. The newest
  // pick wins; mows and Count are read from the visit first.
  function fixOf(b) {
    const list = (b.visitKey ? [(data.visitFix || {})[b.visitKey]] : []).concat(b.rids.map(id => (data.rcFix || {})[id])).filter(Boolean);
    const pick = list.filter(f => f.none === true || (typeof f.prop === 'string' && f.prop))
      .sort((a, c) => String(c.at || '').localeCompare(String(a.at || '')))[0] || null;
    const field = k => { const f = list.find(x => x[k] != null); return f ? f[k] : null; };
    return { pick: pick, mows: field('mows'), skip: field('skip') };
  }

  function computeBills(s) {
    const L = lookups(), props = propsOf(s), propIds = s.props || {};
    props.forEach(p => { L.keys[p.id] = propKeys(p, L); });
    const rs = billsOf(s);
    rs.forEach(r => { r.role = roleOf(r); });
    const pay = pairPayments(rs);
    const bills = [], byMsg = {}, info = [];
    // Their invoice emails: one visit each.
    Object.keys(visitsDoc.visits || {}).forEach(k => {
      const v = visitsDoc.visits[k];
      if (!v || v.sub !== s.id) return;
      const b = newBill('v-' + k, { visitKey: k, date: v.date || v.sent || '', sent: v.sent || '',
        cents: typeof v.cents === 'number' ? v.cents : null, service: v.service || '', address: v.address || '',
        text: [v.subject, v.service, v.address].filter(Boolean).join(' ; ') });
      (v.msgIds || []).forEach(id => { byMsg[id] = b; });
      bills.push(b);
    });
    // Receipts: with the visit read from the same email; else with the
    // other receipts of the same bill; else with a visit of the same amount
    // a few days apart; else a bill of their own.
    const loose = [];
    rs.forEach(r => {
      if (r.role.kind === 'payment') return;
      const b = (r.mail || []).map(x => x && byMsg[x.id]).find(Boolean);
      if (b) { addReceipt(b, r, s); return; }
      if (r.role.elsewhere || r.role.pending) return;
      if (r.role.kind === 'bill') loose.push(r); else info.push(r);
    });
    const groups = {};
    loose.forEach(r => {
      const subj = norm(String(firstSubject(r)).replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, ''));
      // (The number however it is written: "A-77" is "A77".)
      const g = norm(r.orderNo) ? 'o' + norm(r.orderNo).replace(/ /g, '')
        : r.dueDate && subj && typeof r.totalCents === 'number' ? 'd' + r.dueDate + '|' + r.totalCents + '|' + subj : 'r' + r.id;
      (groups[g] = groups[g] || []).push(r);
    });
    Object.keys(groups).forEach(g => {
      const list = groups[g].sort((a, c) => String(a.date || '').localeCompare(String(c.date || '')) || String(a.id).localeCompare(String(c.id)));
      const r = list[0], cents = receiptCents(r, s);
      const keys = addrKeysIn((subjectParts(firstSubject(r)) || {}).address || '');
      const near = b => Math.min(apart(b.date, r.date), apart(b.sent, r.date));
      const fits = b => { const k = addrKeysIn(b.address); return !keys.length || !k.length || keys.some(x => k.indexOf(x) !== -1); };
      const twin = typeof cents === 'number'
        ? bills.filter(b => b.visitKey && !b.rids.length && b.cents === cents && near(b) <= PAIR_DAYS && fits(b)).sort((a, c) => near(a) - near(c))[0]
        : null;
      const b = twin || newBill('r-' + r.id, {});
      if (!twin) bills.push(b);
      list.forEach(x => addReceipt(b, x, s));
    });
    // Payments: with the bill they paid.
    const ofRid = {};
    bills.forEach(b => b.rids.forEach(id => { ofRid[id] = b; }));
    Object.keys(pay.by).forEach(inv => {
      const b = ofRid[inv], p = rs.find(r => r.id === pay.by[inv]);
      if (b && p && !p.role.elsewhere) { b.paidBy = p; ofRid[p.id] = b; }
    });
    // The rest -- a payment receipt in Receipts, a payment receipt email of
    // theirs (subvisits.py), money paid to them in QuickBooks (subclients.py),
    // each payment once (paymentsOf) -- with the bill of the same amount
    // (or that amount with tax or a card fee on top), from a little before
    // the bill to a few months after it; the bill its invoice number names
    // first, and never a bill with another number.
    const ref = b => b.sent || b.date;
    const billNo = b => noOf((b.receipts.find(r => noOf(r.orderNo)) || {}).orderNo);
    paymentsOf(s, rs, pay).forEach(p => {
      const t = dayMs(p.date);
      const fits = x => !x.paidBy && !x.payOnly && !x.hand && !x.elsewhere && typeof x.cents === 'number' &&
        !(x.rcBill && isPaid(x.rcBill, pay.paid)) && withExtra(x.cents, p.cents) &&
        !(p.invoiceNo && billNo(x) && billNo(x) !== p.invoiceNo) &&
        t >= dayMs(ref(x)) - PAY_BEFORE_DAYS * 864e5 && t <= dayMs(ref(x)) + PAY_AFTER_DAYS * 864e5;
      const cand = isNaN(t) || typeof p.cents !== 'number' ? [] : bills.filter(fits)
        .sort((a, c) => (a.cents === p.cents ? 0 : 1) - (c.cents === p.cents ? 0 : 1) || String(ref(a)).localeCompare(String(ref(c))));
      const b = (p.invoiceNo && cand.find(x => billNo(x) === p.invoiceNo)) || cand[0];
      if (b) { b.paidBy = p; if (p.r) ofRid[p.r.id] = b; if (!b.link && p.link) b.link = p.link; return; }
      if (p.r && p.r.role.pending) { info.push(p.r); return; }
      // No bill of theirs for it (paid on the spot, or the bill's email is
      // gone): money paid to them is a cost all the same -- the payment is
      // the bill, put with a client like any other. A payment in Receipts
      // keeps its picks on the receipt; the others on their own key.
      const nb = newBill('p-' + p.key, { payOnly: true, visitKey: p.r ? '' : p.key, date: p.date, cents: p.cents,
        service: p.r ? '' : p.what, link: p.link || '', text: p.text || '', paidBy: p });
      if (p.r) { addReceipt(nb, p.r, s); nb.cents = p.cents; ofRid[p.r.id] = nb; }
      bills.push(nb);
    });
    // Visits added by hand: a client and mows, no bill.
    Object.keys(data.handVisits || {}).forEach(k => {
      const v = data.handVisits[k];
      if (!v || v.sub !== s.id) return;
      bills.push(newBill('h-' + k, { hand: true, handKey: k, date: v.date || '', service: v.service || 'Mow',
        prop: propIds[v.prop] ? v.prop : null, how: 'hand', mows: +v.mows || 0, setMows: true }));
    });

    // What each says: its own address (the one in its subject), any other
    // address in it, and its words -- not their own company's.
    const own = new Set(words(s.name).concat(words(s.match)));
    bills.forEach(b => {
      b.siteKeys = addrKeysIn(b.address);
      b.textKeys = b.siteKeys.length ? [] : addrKeysIn(b.text);
      b.words = new Set(norm(b.text).split(' ').filter(w => w && !own.has(w)));
    });
    // 1. His picks.
    bills.forEach(b => {
      if (b.hand) return;
      b.fix = fixOf(b);
      b.skip = !!b.fix.skip;
      const pk = b.fix.pick;
      if (!pk || b.elsewhere) return;
      if (pk.none) { b.none = true; b.how = 'hand'; }
      else if (propIds[pk.prop]) { b.prop = pk.prop; b.how = 'hand'; }
    });
    // What his picks teach: an address, or (with none on the bill) the work
    // and its amount, went to one client -- or to none.
    const learnAddr = {}, learnSvc = {}, svcPicks = {};
    const svcKey = b => svcKeyOf(b.service) + '|' + (b.cents == null ? '' : b.cents);
    bills.forEach(b => {
      if (b.hand || b.how !== 'hand' || b.elsewhere) return;
      const to = b.none ? 'none' : b.prop;
      const teach = (map, k) => { const m = map[k] = map[k] || {}; if (!(to in m) || String(b.date) > m[to]) m[to] = String(b.date || ''); };
      if (b.siteKeys.length) b.siteKeys.forEach(k => teach(learnAddr, k));
      else teach(learnSvc, svcKey(b));
      if (!b.none) (svcPicks[svcKeyOf(b.service)] = svcPicks[svcKeyOf(b.service)] || {})[b.prop] = true;
    });
    const sure = maps => {
      const m = {};
      maps.filter(Boolean).forEach(x => Object.keys(x).forEach(k => {
        if ((k === 'none' || propIds[k]) && (!(k in m) || x[k] > m[k])) m[k] = x[k];
      }));
      const ks = Object.keys(m);
      return ks.length === 1 ? { to: ks[0], from: m[ks[0]] } : null;
    };
    const hits = keys => props.filter(p => (L.keys[p.id] || []).some(k => keys.indexOf(k) !== -1));
    const auto = b => {
      if (b.siteKeys.length) {
        let c = hits(b.siteKeys);
        if (c.length > 1) c = c.filter(p => namedOn(p, b, L));
        if (c.length === 1) return { to: c[0].id, how: 'address' };
        const l = sure(b.siteKeys.map(k => learnAddr[k]));
        if (l) return { to: l.to, how: 'learned', from: l.from };
      } else if (b.textKeys.length) {
        const c = hits(b.textKeys);
        if (c.length === 1) return { to: c[0].id, how: 'address' };
      }
      const n = props.filter(p => namedOn(p, b, L));
      if (n.length === 1) return { to: n[0].id, how: 'name' };
      if (!b.siteKeys.length) {
        const l = sure([learnSvc[svcKey(b)]]);
        if (l) return { to: l.to, how: 'learned', from: l.from };
        // 5. Their price: a bill (or a payment with no bill) for exactly what
        // ONE property is priced at by them -- a visit, or a month on a bill
        // for a month's work. Never over the bill's own address (its
        // subject's) when that is no property's: that one is somewhere new.
        const priced = typeof b.cents === 'number' ? props.filter(p => !p.off && p.theirCents === b.cents &&
          (p.theirPer !== 'month' || /month/i.test(b.service || ''))) : [];
        if (priced.length === 1) return { to: priced[0].id, how: 'price' };
      }
      return null;
    };
    // 2-4. The rest, by themselves.
    bills.forEach(b => {
      if (b.hand || b.how || b.elsewhere) return;
      const m = auto(b);
      if (!m) return;
      if (m.to === 'none') b.none = true; else b.prop = m.to;
      b.how = m.how; b.from = m.from || '';
    });
    bills.forEach(b => {
      if (b.hand) return;
      const p = b.prop ? propIds[b.prop] : null;
      b.setMows = typeof b.fix.mows === 'number';
      b.mows = b.setMows ? b.fix.mows : defaultMows(b, p);
      b.guess = !b.setMows && /month/i.test(b.service || '') && MOWING.test(b.service || '');
      // A cost of theirs, to count: not set aside here (Count), not
      // "Not for a client", not sorted somewhere else in Receipts.
      b.counts = !b.skip && !b.none && !b.elsewhere;
    });
    bills.sort((a, c) => String(c.date || '').localeCompare(String(a.date || '')) || String(a.key).localeCompare(String(c.key)));
    return {
      bills: bills, info: info, pay: pay, svcPicks: svcPicks, L: L, rcIndex: ofRid,
      toMatch: bills.filter(b => !b.hand && b.counts && !b.prop),
    };
  }
  // Worked out once for a moment's drawing (the cards ask many times), and
  // again whenever anything changes.
  function billsFor(s) {
    if (Date.now() - memo.at > 1500) memo = { at: Date.now(), bySub: {} };
    return memo.bySub[s.id] || (memo.bySub[s.id] = computeBills(s));
  }
  function forget() { memo = { at: 0, bySub: {} }; }
  const subById = id => subsList().find(x => x.id === id) || null;
  function billByKey(subId, key) {
    const s = subById(subId);
    const b = s ? billsFor(s).bills.find(x => x.key === key) : null;
    return b ? { s: s, b: b } : null;
  }
  // Whether a bill falls in the season we are in (its client's season, or
  // the usual one).
  function billThisSeason(s, b) {
    const p = (b.prop && (s.props || {})[b.prop]) || {};
    return isDay(b.date) && seasonOf(p, +b.date.slice(0, 4), dayNum(b.date.slice(5))) === seasonNow(p);
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
  // Every bill and visit of theirs, newest first, each with its client and
  // mows (what the mows and the schedule below count).
  const visitsOf = s => billsFor(s).bills;
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
    forget();
    // "Another client…" keeps its box (and what is in it) through a redraw:
    // a receipt arriving must not take the words from under the fingers.
    const act = document.activeElement;
    const keepFind = act && act.id && /^sbFind-/.test(act.id) && wrap.contains(act) ? act.id : '';
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
    if (keepFind) {
      const n = el(keepFind);
      if (n) { n.focus(); try { n.setSelectionRange(n.value.length, n.value.length); } catch (e) { /* not a text box */ } }
    }
  }

  function subHtml(s, y, m) {
    const t = totals(s, y, m), st = seasonTotals(s, y), sf = seasonTotals(s, y, true), o = owed(s);
    const props = propsOf(s), B = billsFor(s);
    const monthName = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long' });
    const nVisits = n => n + ' visit' + (n === 1 ? '' : 's');
    // What their bills came to this season, each counted once.
    const cur = B.bills.filter(b => !b.hand && b.counts && billThisSeason(s, b));
    const centsOf = list => list.reduce((n, b) => n + (typeof b.cents === 'number' ? b.cents : 0), 0);
    const billed = centsOf(cur);
    const unpaid = cur.filter(b => !billPaid(b, B)), paidOut = billed - centsOf(unpaid);
    const nBills = B.bills.filter(b => !b.hand).length;
    // What the clients paid YD this season (QuickBooks), every property.
    const anchors = anchorsOf(s);
    const pf = props.map(p => propFigures(s, p, B, anchors)).filter(f => f.qb);
    const clientsPaid = pf.reduce((n, f) => n + f.qb.paid, 0), clientsOwe = pf.reduce((n, f) => n + f.qb.owes, 0);
    return '<div class="sub-card">' +
      '<div class="sub-head"><b>' + esc(s.name || 'Subcontractor') + '</b>' +
        (s.phone ? ' <a class="link-btn" href="tel:' + esc(s.phone) + '">' + esc(s.phone) + '</a>' : '') +
        (s.email ? ' <a class="link-btn" href="mailto:' + esc(s.email) + '">Email</a>' : '') +
        '<button class="link-btn" onclick="subEdit(\'' + sid(s.id) + '\')">Edit</button></div>' +
      (form && form.kind === 'sub' && form.subId === s.id ? subFormHtml(s) : '') +
      '<div class="sub-figs">' +
        fig(monthName, props.length ? nVisits(t.visits) + ' · ' + money(t.their) + ' to them · ' + money(t.ours) + ' from clients' : 'no properties yet') +
        fig('Margin this month', props.length ? marginText(t) : '—') +
        fig('Season so far', props.length ? marginText(sf) + ' · ' + nVisits(sf.visits) : '—') +
        fig('Whole season', props.length ? marginText(st) + ' · ' + nVisits(st.visits) : '—') +
        fig('Their bills this season', cur.length ? money(billed) + ' · ' + cur.length + ' bill' + (cur.length === 1 ? '' : 's') : 'none yet') +
        fig('You paid them this season', cur.length ? money(paidOut) : '—') +
        // This season's bills no payment went with (and not marked paid) --
        // their emails and QuickBooks tell the payments now, not only
        // Receipts.
        fig('Owed to them', unpaid.length ? money(centsOf(unpaid)) + ' · ' + unpaid.length + ' bill' + (unpaid.length === 1 ? '' : 's') : 'nothing') +
        (pf.length ? fig('Clients paid you this season', money(clientsPaid) + (clientsOwe > 0 ? ' · ' + money(clientsOwe) + ' owed' : '')) : '') +
      '</div>' +
      payeesHtml(s) +
      (o.late.length ? '<div class="sub-warn late">⚠️ Past due: ' + o.late.map(r => money(r.totalCents) + ' (due ' + fmtDateMD(r.dueDate) + ')').join(', ') + '</div>'
        : o.soon.length ? '<div class="sub-warn">Due soon: ' + o.soon.map(r => money(r.totalCents) + ' by ' + fmtDateMD(r.dueDate)).join(', ') + '</div>' : '') +
      toMatchHtml(s, props, B) +
      '<details class="sub-more"' + (open[s.id] ? ' open' : '') + ' ontoggle="subToggle(\'' + sid(s.id) + '\', this.open)">' +
        '<summary>Properties (' + props.length + ') and their bills (' + nBills + ')</summary>' +
        propsHtml(s, props, y, m, B) +
        allBillsHtml(s, props, B) +
      '</details>' +
    '</div>';
  }
  const fig = (label, value) => '<div class="sub-fig"><span class="sub-fig-l">' + esc(label) + '</span><span class="sub-fig-v">' + value + '</span></div>';

  // ------------------------------------------------- a property's season
  //
  // From the start of its season to today, month by month, what its prices
  // say (whole visits on real dates, as the cards count them).
  function expectedSoFar(p, anchor) {
    const t = new Date();
    const from = /^(\d{2})-(\d{2})$/.exec(p.from || SEASON.from) || [0, '04', '15'];
    let y = seasonNow(p), m = +from[1] - 1;
    const out = { visits: 0, their: 0, ours: 0 };
    for (let i = 0; i < 13; i++) {
      if (y > t.getFullYear() || (y === t.getFullYear() && m > t.getMonth())) break;
      const x = monthOf(p, y, m, anchor, y === t.getFullYear() && m === t.getMonth() ? t.getDate() : 0);
      out.visits += x.visits; out.their += x.their; out.ours += x.ours;
      if (++m > 11) { m = 0; y++; }
    }
    return out;
  }
  // What the client owes YD: their open QuickBooks invoices (invoices.js),
  // found by the customer the property is tied to, or its job. null when it
  // is tied to neither (nothing to go by).
  function clientOwes(p, L) {
    if (!window.YDInvoices || !YDInvoices.all) return null;
    const c = custOf(p, L);
    const qb = c && c.qbCustomerId ? String(c.qbCustomerId) : '';
    if (!qb && !p.jobId) return null;
    const list = Object.values(YDInvoices.all() || {}).filter(inv => inv && !inv.paidAt && !inv.deletedAt && inv.open !== false &&
      Number(inv.balance) > 0 && ((qb && String(inv.customerId || '') === qb) || (p.jobId && inv.jobId === p.jobId)));
    return { cents: Math.round(list.reduce((n, inv) => n + (Number(inv.balance) || 0), 0) * 100), n: list.length };
  }
  // ------------------------------------------------- what the client paid
  //
  // Jonah (22 Oct 2026): "pull the rest of [the client's] payments from qb".
  // settings/subClients (functions/subclients.py) holds every invoice and
  // payment of each property's customer in QuickBooks -- found by the
  // customer's QuickBooks id, never by name -- brought up to date every
  // hour. Of a client's invoices this season, the ones for the
  // subcontractor's work count here: a line naming what they do at the
  // property (its services), or, with none ticked, lawn work. A snow invoice
  // to the same client is YD's own work, not theirs. Each invoice's Count box
  // says otherwise by hand (invFix {invoiceId: {skip}}).
  function qbCustOf(p, L) {
    const all = clientsDoc.customers || {}, c = custOf(p, L);
    // (A customer from QuickBooks is kept under its QuickBooks id: with the
    // customer list not read yet, the tie itself still finds them.)
    const id = c && c.qbCustomerId ? String(c.qbCustomerId) : all[p.customerId] ? String(p.customerId) : '';
    return id && all[id] ? { id: id, c: all[id] } : null;
  }
  function isWorkLine(ln, p) {
    const text = norm((ln.item || '') + ' ' + (ln.desc || ''));
    const svc = (p.services || []).map(norm).filter(Boolean);
    return svc.length ? svc.some(w => text.indexOf(w) !== -1) : MOWING.test(text);
  }
  // A customer with two of their properties: an invoice is the one whose
  // address it names, else the first one's.
  function invoiceIsFor(s, p, q, inv, L) {
    const twins = propsOf(s).filter(x => x.id !== p.id && (qbCustOf(x, L) || {}).id === q.id);
    if (!twins.length) return true;
    const all = [p].concat(twins).sort((a, c) => String(a.id).localeCompare(String(c.id)));
    const keys = addrKeysIn((inv.lines || []).map(l => l.desc).join(' ; '));
    const at = all.filter(x => (L.keys[x.id] || propKeys(x, L)).some(k => keys.indexOf(k) !== -1));
    return (at[0] || all[0]).id === p.id;
  }
  function clientFigures(s, p, L) {
    const q = qbCustOf(p, L);
    if (!q) return null;
    const cur = seasonNow(p), fix = data.invFix || {};
    const list = (q.c.invoices || []).filter(inv => inv && isDay(inv.date) &&
        seasonOf(p, +inv.date.slice(0, 4), dayNum(inv.date.slice(5))) === cur && invoiceIsFor(s, p, q, inv, L))
      .map(inv => {
        const work = (inv.lines || []).filter(ln => isWorkLine(ln, p));
        const f = fix[inv.id] || {}, auto = work.length > 0;
        // Counted by hand with none of its lines their work: all of it is.
        const lines = work.length ? work : inv.lines || [];
        return { inv: inv, work: work, auto: auto, byHand: typeof f.skip === 'boolean',
          counts: typeof f.skip === 'boolean' ? !f.skip : auto, workCents: lines.reduce((n, ln) => n + (ln.cents || 0), 0) };
      }).sort((a, c) => String(c.inv.date).localeCompare(String(a.inv.date)));
    const on = list.filter(x => x.counts), ids = {};
    on.forEach(x => { ids[x.inv.id] = true; });
    const sum = f => on.reduce((n, x) => n + f(x), 0);
    // The payments on the invoices counted, each with what it paid on them.
    const pays = (q.c.payments || []).map(pm => Object.assign({}, pm, {
      here: (pm.on || []).filter(o => ids[o.inv]).reduce((n, o) => n + (o.cents || 0), 0) })).filter(pm => pm.here > 0);
    return { qbId: q.id, name: q.c.name || '', list: list, on: on, pays: pays,
      charged: sum(x => x.workCents), total: sum(x => x.inv.total || 0),
      paid: sum(x => Math.max(0, (x.inv.total || 0) - (x.inv.balance || 0))), owes: sum(x => x.inv.balance || 0),
      open: on.filter(x => (x.inv.balance || 0) > 0).length };
  }
  // Paid to them: a bill a payment went with, a payment that is the bill,
  // or one marked paid here.
  const billPaid = (b, B) => !!(b.paidBy || b.payOnly || (b.rcBill && isPaid(b.rcBill, B.pay.paid)) ||
    (b.visitKey && (data.paid || {})[b.visitKey]));

  // A property this season: its bills and what they came to, what its
  // prices say they should come to, what YD charged the client, and the
  // margin -- their bills when there are any (else their price), against
  // what the client was billed for the work in QuickBooks when that is
  // known (else YD's price).
  function propFigures(s, p, B, anchors) {
    const mine = B.bills.filter(b => b.prop === p.id);
    const now = mine.filter(b => !b.hand && b.counts && billThisSeason(s, b));
    const billed = now.reduce((n, b) => n + (typeof b.cents === 'number' ? b.cents : 0), 0);
    const paidOut = now.filter(b => billPaid(b, B)).reduce((n, b) => n + (typeof b.cents === 'number' ? b.cents : 0), 0);
    const exp = expectedSoFar(p, anchors[p.id]);
    const theirSet = typeof p.theirCents === 'number', oursSet = typeof p.ourCents === 'number';
    const cost = now.length ? billed : exp.their;
    // A difference worth a look: a dollar, or a tenth of what was expected.
    const diff = theirSet && now.length && Math.abs(billed - exp.their) >= Math.max(100, Math.round(exp.their / 10)) ? billed - exp.their : null;
    const qb = clientFigures(s, p, B.L), byQb = !!(qb && qb.on.length);
    const ours = byQb ? qb.charged : exp.ours;
    return { mine: mine, now: now, billed: billed, paidOut: paidOut, noAmount: now.filter(b => typeof b.cents !== 'number').length,
      exp: exp, theirSet: theirSet, oursSet: oursSet, cost: cost, diff: diff, qb: qb, byQb: byQb, ours: ours,
      margin: byQb || oursSet ? ours - cost : null,
      owes: qb ? { cents: qb.owes, n: qb.open } : clientOwes(p, B.L) };
  }
  const diffWords = (f, short) => (f.diff == null ? '' : '⚠️ ' + money(Math.abs(f.diff)) + (f.diff > 0 ? ' more' : ' less') +
    (short ? '' : ' than their price says (' + money(f.exp.their) + ' for ' + f.exp.visits + ' visit' + (f.exp.visits === 1 ? '' : 's') + ')'));
  // How the margin was worked out, in a few words.
  const marginHow = f => (f.byQb ? (f.now.length ? '' : ' (their side by price)') : f.now.length ? ' (your side by price)' : ' (by price)');
  function seasonCellHtml(s, p, f) {
    return '<button class="link-btn sb-bills-btn" onclick="subPropBills(\'' + sid(s.id) + '\', \'' + sid(p.id) + '\')">' +
        (f.now.length ? money(f.billed) + ' · ' + f.now.length + ' bill' + (f.now.length === 1 ? '' : 's') : 'No bills yet') + '</button>' +
      (f.theirSet ? '<div class="muted">their price: ' + money(f.exp.their) + '</div>' : '') +
      (f.diff != null ? '<div class="sb-diff">' + diffWords(f, true) + '</div>' : '') +
      (f.byQb ? '<div class="sb-paid">client paid ' + money(f.qb.paid) + '</div>' : '') +
      (f.margin != null ? '<div class="muted">margin ' + marginText({ ours: f.ours, their: f.cost }) + marginHow(f) + '</div>' : '') +
      (f.owes && f.owes.cents > 0 ? '<div class="sb-owes">client owes ' + money(f.owes.cents) + '</div>' : '');
  }

  function propsHtml(s, props, y, m, B) {
    // The property being edited gets its form under the table, not inside
    // it (and on a phone each property is a card, not a sideways table).
    const editing = form && form.kind === 'prop' && form.subId === s.id && form.propId
      ? props.find(p => p.id === form.propId) : null;
    const list = visitsOf(s);
    const anchors = anchorsOf(s);
    const S = sid(s.id);
    const shown = openBills[s.id] && props.find(p => p.id === openBills[s.id]);
    const rows = props.map(p => {
      const x = monthOf(p, y, m, anchors[p.id]);
      const P = sid(p.id);
      // A visit-priced property also shows what one visit makes.
      const each = p.theirPer !== 'month' && p.ourPer !== 'month' && typeof p.theirCents === 'number' && typeof p.ourCents === 'number'
        ? '<div class="muted">' + money(p.ourCents - p.theirCents) + ' a visit · ' + x.visits + ' this month</div>'
        : '<div class="muted">' + x.visits + ' visit' + (x.visits === 1 ? '' : 's') + ' this month</div>';
      const mw = mowsFor(s, p, list);
      // Ticked done this season (or ended for good): checked, with the date.
      // A done-for-the-season tick from an earlier season is history, not
      // this year's -- the box is clear again.
      const done = doneNow(p);
      return (editing === p ? '<tr class="sub-editing"><td colspan="10"><b>' + esc(p.client || 'Client') + '</b> — editing below</td></tr>' :
        '<tr class="' + (p.off ? 'sub-off' : '') + (done ? ' sub-done' : '') + (shown === p ? ' sb-open' : '') + '">' +
        '<td class="sub-done-cell" data-l="Done"><label title="' + (done ? esc(DONE_WHY[p.doneWhy] || DONE_WHY.season) : 'Tick when done for the season or the service ended') + '">' +
          '<input type="checkbox"' + (done ? ' checked' : '') + ' onchange="subPropDone(\'' + S + '\', \'' + P + '\', this.checked)">' +
          (done ? '<span>' + esc(fmtDateMD(p.doneOn)) + (p.doneWhy === 'ended' ? '<br>ended' : '') + '</span>' : '') + '</label></td>' +
        '<td class="sub-client" data-l="Client"><b>' + esc(p.client || 'Client') + '</b>' + (p.address ? '<div class="muted">' + esc(p.address) + '</div>' : '') + '</td>' +
        '<td data-l="What they do">' + ((p.services || []).length ? esc(p.services.join(', ')) : '<span class="muted">—</span>') + '</td>' +
        '<td class="sub-mows" data-l="Mows"><b>' + mw.n + '</b>' + (mw.byHand ? ' <span class="muted" title="Set by hand on the property (' + mw.counted +
          ' from their invoices)">✎</span>' : '') + (mw.last ? '<div class="muted">last ' + esc(fmtDateMD(mw.last)) + '</div>' : '') + '</td>' +
        '<td data-l="How often">' + esc(everyWords(p)) + '<div class="muted">' + esc((p.from || SEASON.from) + ' to ' + (p.to || SEASON.to)) + '</div></td>' +
        '<td data-l="They charge">' + money(p.theirCents) + ' ' + esc(PER[p.theirPer] || '') + '</td>' +
        '<td data-l="You charge">' + money(p.ourCents) + ' ' + esc(PER[p.ourPer] || '') + '</td>' +
        '<td data-l="Margin this month">' + (x.their || x.ours ? marginText(x) : '—') + each + '</td>' +
        '<td class="sub-season-cell" data-l="Season so far — their bills">' + seasonCellHtml(s, p, propFigures(s, p, B, anchors)) + '</td>' +
        '<td class="sub-edit-cell"><button class="link-btn" onclick="subProp(\'' + S + '\', \'' + P + '\')">Edit</button></td></tr>');
    }).join('');
    return '<div class="table-wrap"><table class="sub-table sub-props"><thead><tr><th>Done</th><th>Client</th><th>What they do</th>' +
        '<th title="This season, from their invoices (and what you set by hand)">Mows</th><th>How often</th><th>They charge</th>' +
        '<th>You charge</th><th>Margin this month</th><th title="This season: what their bills came to, beside what their price says">Season so far</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="10" class="muted">No properties yet.</td></tr>') + '</tbody></table></div>' +
      (shown && editing !== shown ? propPanelHtml(s, shown, B, anchors) : '') +
      (editing ? propFormHtml(s, editing)
        : form && form.kind === 'prop' && form.subId === s.id && !form.propId ? propFormHtml(s, {})
        : '<button class="btn btn-sm" onclick="subProp(\'' + S + '\', \'\')">+ Add a property</button>');
  }

  // One property's bills: this season's with the figures, earlier ones
  // folded. Each says how it was matched; a wrong one is changed right here.
  function propPanelHtml(s, p, B, anchors) {
    const f = propFigures(s, p, B, anchors);
    const S = sid(s.id), P = sid(p.id), props = propsOf(s);
    const cur = f.mine.filter(b => billThisSeason(s, b)), old = f.mine.filter(b => !billThisSeason(s, b));
    const tieWords = '<span class="muted">' + (custOf(p, B.L) || p.customerId
      ? 'not read from QuickBooks yet — it is read every hour' : 'tie them to your customer list (Edit) to see it') + '</span>';
    const owes = f.owes == null ? tieWords
      : f.owes.cents > 0 ? money(f.owes.cents) + ' · ' + f.owes.n + ' open invoice' + (f.owes.n === 1 ? '' : 's') : 'nothing open';
    const q = f.qb, nInv = q ? q.on.length : 0;
    const stillOwed = f.billed - f.paidOut;
    return '<div class="sb-panel" id="sbP-' + S + '-' + P + '">' +
      '<div class="sb-panel-h"><b>' + esc(p.client || 'Client') + '</b> — this season' +
        '<button class="link-btn" onclick="subPropBills(\'' + S + '\', \'\')">Close</button></div>' +
      '<div class="sub-figs">' +
        fig('Margin so far', f.margin != null ? marginText({ ours: f.ours, their: f.cost }) + esc(marginHow(f)) : '—') +
        fig('Client paid you', q ? money(q.paid) + (nInv ? ' of ' + money(q.total) : '') : tieWords) +
        fig('Client owes', owes) +
        fig('You billed them for the work', q && nInv ? money(q.charged) + ' · ' + nInv + ' invoice' + (nInv === 1 ? '' : 's') + ' · before tax'
          : f.oursSet ? money(f.exp.ours) + ' by your price' : 'no price set') +
        fig('Their bills this season', f.now.length ? money(f.billed) + ' · ' + f.now.length + ' bill' + (f.now.length === 1 ? '' : 's') +
          (f.noAmount ? ' · ' + f.noAmount + ' with no amount' : '') : 'none yet') +
        fig('You paid them', f.now.length ? money(f.paidOut) + (stillOwed > 0 ? ' · ' + money(stillOwed) + ' not paid yet' : '') : '—') +
        fig('By their price', f.theirSet ? money(f.exp.their) + ' · ' + f.exp.visits + ' visit' + (f.exp.visits === 1 ? '' : 's') : 'no price set') +
      '</div>' +
      (f.diff != null ? '<div class="sub-warn">' + diffWords(f) + '</div>' : '') +
      '<div class="sb-sec-h">Their bills</div>' +
      (cur.length ? cur.map(b => billRowHtml(s, b, props, B, 'list')).join('')
        : '<p class="muted" style="margin:6px 0 0">No bills for them this season yet.</p>') +
      (old.length ? '<details class="sb-old"><summary>Earlier seasons (' + old.length + ')</summary>' +
        old.map(b => billRowHtml(s, b, props, B, 'list')).join('') + '</details>' : '') +
      (q ? clientInvoicesHtml(s, p, q) : '') +
    '</div>';
  }
  // The client's invoices this season, from QuickBooks: what each was, paid
  // or owed, and whether it counts as the subcontractor's work (by hand).
  function clientInvoicesHtml(s, p, q) {
    const today = ymd(new Date());
    const payOf = {};
    q.pays.forEach(pm => (pm.on || []).forEach(o => { (payOf[o.inv] = payOf[o.inv] || []).push(pm); }));
    const row = x => {
      const inv = x.inv, bal = inv.balance || 0;
      const what = (x.work.length ? x.work : inv.lines || []).map(l => String(l.item || '').split(':').pop() || 'Line')
        .filter((n, i, a) => a.indexOf(n) === i).join(', ');
      const state = bal <= 0 ? '<span class="rc-tag">Paid</span>'
        : '<span class="rc-tag rc-owed">' + (inv.due && inv.due < today ? 'Past due' : 'Owes') + ' ' + money(bal) + '</span>';
      const paidWords = (payOf[inv.id] || []).map(pm => 'paid ' + esc(dayWords(pm.date)) + (pm.method ? ' · ' + esc(pm.method) : '')).join('; ');
      return '<div class="sb-row' + (x.counts ? '' : ' sb-off') + '">' +
        '<div class="sb-line"><span class="sb-date">' + esc(dayWords(inv.date)) + '</span>' +
          '<span class="sb-what"><b>#' + esc(inv.doc || inv.id) + '</b> <span class="muted">' + esc(what) + '</span></span>' +
          '<span class="sb-amt">' + money(inv.total) + '</span></div>' +
        '<div class="sb-meta">' + state + (paidWords ? '<span class="muted">' + paidWords + '</span>' : '') +
          (x.counts && x.workCents !== inv.total ? '<span class="muted">' + money(x.workCents) + ' for the work</span>' : '') +
          '<label class="sub-count" title="' + (x.byHand ? 'Set by hand' : x.auto ? 'Their kind of work is on it' : 'None of its lines is their kind of work') + '">' +
            '<input type="checkbox"' + (x.counts ? ' checked' : '') + ' onchange="subInvCount(\'' + sid(inv.id) + '\', this.checked, ' + x.auto + ')"> Count</label>' +
          (inv.link ? '<a class="link-btn" href="' + esc(inv.link) + '" target="_blank" rel="noopener">QuickBooks</a>' : '') + '</div>' +
      '</div>';
    };
    return '<div class="sb-sec-h">Your invoices to them <span class="muted">· QuickBooks' +
        (clientsDoc.readAt ? ', read ' + esc(fmtDateMD(clientsDoc.readAt.slice(0, 10))) + ' ' +
          esc(new Date(clientsDoc.readAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : '') + '</span></div>' +
      (q.list.length ? q.list.map(row).join('')
        : '<p class="muted" style="margin:6px 0 0">No invoices to them this season in QuickBooks.</p>');
  }

  // ------------------------------------------------- the bills, drawn
  //
  // Bills no client could be told from: at the top of the card, out of the
  // fold, each with a button for every property (the likeliest first).
  function toMatchHtml(s, props, B) {
    const list = B.toMatch;
    if (!list.length) return '';
    const shown = matchAll[s.id] ? list : list.slice(0, MATCH_SHOWN);
    return '<div class="sb-match" id="sbMatch-' + sid(s.id) + '">' +
      '<div class="sb-match-h">🧾 Bills to match (' + list.length + ')</div>' +
      '<div class="sb-hint">No client could be told from ' + (list.length === 1 ? 'this bill' : 'these') +
        '. Tap the client each was for — the next bill like it goes there by itself.</div>' +
      shown.map(b => billRowHtml(s, b, props, B, 'match')).join('') +
      (list.length > shown.length ? '<button class="btn btn-sm sb-more" onclick="subMatchMore(\'' + sid(s.id) + '\')">Show the other ' +
        (list.length - shown.length) + '</button>' : '') +
    '</div>';
  }

  const howWords = b => (b.how === 'learned' ? '🔁 like the one of ' + dayWords(b.from) : HOW[b.how] || '');
  // Owed or paid: on a bill that came as an invoice receipt, as "Owed to
  // them" counts it (Mark paid as before); a bill a payment went with is paid.
  // The day a payment went with it, when one did.
  const paidOn = b => (b.paidBy && isDay(String(b.paidBy.date || '').slice(0, 10)) ? ' ' + esc(fmtDateMD(String(b.paidBy.date).slice(0, 10))) : '');
  function stateHtml(b, B) {
    const r = b.rcBill;
    if (r && isBill(r)) {
      const t = ymd(new Date()), paid = isPaid(r, B.pay.paid) || !!b.paidBy;
      const byPayment = B.pay.paid.has(r.id) || r.paid || !!b.paidBy;
      return (paid ? '<span class="rc-tag">Paid' + paidOn(b) + '</span>'
          : r.dueDate && r.dueDate < t ? '<span class="rc-tag rc-owed">Past due</span>'
          : '<span class="rc-tag rc-owed">Owed' + (r.dueDate ? ' · due ' + fmtDateMD(r.dueDate) : '') + '</span>') +
        (byPayment ? '' : '<button class="link-btn" onclick="subPaid(\'' + sid(r.id) + '\', ' + (paid ? 'false' : 'true') + ')">' + (paid ? 'Not paid' : 'Mark paid') + '</button>');
    }
    if (b.paidBy || b.payOnly) return '<span class="rc-tag">Paid' + paidOn(b) + '</span>';
    // A bill from their invoice email: paid when a payment went with it, or
    // marked paid here (by hand -- a payment none of the three told).
    if (!b.visitKey || b.hand) return '';
    const byHand = !!(data.paid || {})[b.visitKey];
    return (byHand ? '<span class="rc-tag">Paid</span>' : '<span class="rc-tag rc-owed">Not paid yet</span>') +
      '<button class="link-btn" onclick="subPaid(\'' + sid(b.visitKey) + '\', ' + (byHand ? 'false' : 'true') + ')">' + (byHand ? 'Not paid' : 'Mark paid') + '</button>';
  }
  function mowsHtml(s, b) {
    if (b.none || b.elsewhere) return '';
    const S = sid(s.id), K = sid(b.key);
    return '<label class="sb-mows">Mows <input class="sub-mow-in" type="number" min="0" step="1" inputmode="numeric" value="' + b.mows + '"' +
        ' title="' + (b.setMows ? 'Set by hand' : b.guess ? 'A guess from how often — set it' : 'From the bill') + '"' +
        ' onchange="subBillMows(\'' + S + '\', \'' + K + '\', this.value)">' +
        (b.guess ? '<span class="muted" title="A month\'s worth, guessed from how often — set it to the real number">≈</span>' : '') + '</label>' +
      (b.hand ? '' : '<label class="sub-count"><input type="checkbox"' + (b.skip ? '' : ' checked') +
        ' onchange="subBillSkip(\'' + S + '\', \'' + K + '\', !this.checked)"> Count</label>');
  }
  // One bill: when, what, where, how much -- whose it is and how that was
  // told -- and, while it is being picked, a button for each client.
  function billRowHtml(s, b, props, B, mode) {
    const S = sid(s.id), K = sid(b.key);
    const p = b.prop ? (s.props || {})[b.prop] : null;
    const picking = !b.hand && !b.elsewhere && (mode === 'match' || !!changing[b.key]);
    const who = b.elsewhere ? '<span class="muted">Sorted somewhere else in Receipts — not theirs to match</span>'
      : b.hand ? 'For <b>' + esc(p ? p.client || 'Client' : '—') + '</b> <span class="sb-how">✋ a visit you added</span>'
      : b.none ? '<b>Not for a client</b> <span class="sb-how">' + esc(howWords(b)) + '</span>'
      : p ? 'For <b>' + esc(p.client || 'Client') + '</b> <span class="sb-how">' + esc(howWords(b)) + '</span>'
      : mode === 'match' ? '' : '<b class="sb-which">Which client?</b>';
    const change = b.hand || b.elsewhere || mode === 'match' ? ''
      : '<button class="link-btn" onclick="subBillChange(\'' + S + '\', \'' + K + '\')">' +
        (changing[b.key] ? 'Close' : b.prop || b.none ? 'Change' : 'Pick the client') + '</button>';
    const amount = typeof b.cents === 'number' ? money(b.cents) : '<span class="muted">no amount</span>';
    return '<div class="sb-row' + (b.skip || b.elsewhere ? ' sb-off' : '') + (!b.hand && b.counts && !b.prop ? ' sb-loose' : '') + '">' +
      '<div class="sb-line"><span class="sb-date">' + esc(dayWords(b.date)) + '</span>' +
        '<span class="sb-what"><b>' + esc(b.service || (b.payOnly ? 'Payment' : 'Bill')) + '</b>' +
          (b.address ? ' <span class="muted">' + esc(b.address) + '</span>' : '') + '</span>' +
        '<span class="sb-amt">' + (b.hand ? '' : amount) + '</span></div>' +
      '<div class="sb-meta">' + (who ? '<span class="sb-who">' + who + '</span>' : '') + change + stateHtml(b, B) +
        (mode === 'match' ? '' : mowsHtml(s, b)) +
        (b.link ? '<a class="link-btn" href="' + esc(b.link) + '" target="_blank" rel="noopener">Email</a>' : '') +
        (b.hand ? '<button class="link-btn" onclick="subVisitRemove(\'' + sid(b.handKey) + '\')">Remove</button>' : '') + '</div>' +
      (picking ? picksHtml(s, b, props, B) : '') +
    '</div>';
  }
  // The properties, the likeliest first: on the same street, named on the
  // bill, given this work before, billed lately; done or off ones last.
  function rankProps(s, b, props, B) {
    const L = B.L, street = k => k.split(' ').slice(1).join(' ');
    const streets = {};
    b.siteKeys.concat(b.textKeys).forEach(k => { streets[street(k)] = true; });
    const svc = B.svcPicks[svcKeyOf(b.service)] || {};
    const lately = {};
    B.bills.forEach(x => { if (x.prop && x.counts && apart(x.date, b.date) <= 45) lately[x.prop] = (lately[x.prop] || 0) + 1; });
    return props.map(p => {
      let score = 0, why = '';
      if ((L.keys[p.id] || []).some(k => streets[street(k)])) { score += 40; why = 'same street'; }
      if (propNames(p, L).some(n => nameWords(n).some(w => w.length >= 3 && b.words.has(w)))) { score += 30; why = why || 'name on the bill'; }
      if (svc[p.id]) { score += 20; why = why || 'had this work before'; }
      score += Math.min(lately[p.id] || 0, 4) * 2;
      if (p.off || doneNow(p)) score -= 25;
      return { p: p, score: score, why: why };
    }).sort((a, c) => c.score - a.score || String(a.p.client || '').localeCompare(String(c.p.client || '')));
  }
  function picksHtml(s, b, props, B) {
    const S = sid(s.id), K = sid(b.key);
    const ranked = rankProps(s, b, props, B);
    const many = ranked.length > PROPS_SHOWN && !allProps[b.key];
    const shown = many ? ranked.slice(0, PROPS_SHOWN - 1) : ranked;
    const chip = (to, inner, on, cls) => '<button type="button" class="sb-chip' + (on ? ' on' : '') + (cls ? ' ' + cls : '') +
      '" onclick="subBillPick(\'' + S + '\', \'' + K + '\', \'' + sid(to) + '\')">' + inner + '</button>';
    return '<div class="sb-picks">' +
      shown.map(x => chip(x.p.id, esc(x.p.client || 'Client') + '<small>' +
        esc([x.why, placeOf(x.p, B.L)].filter(Boolean).join(' · ') || (x.p.services || []).join(', ') || ' ') + '</small>', b.prop === x.p.id)).join('') +
      (many ? '<button type="button" class="sb-chip sb-alt" onclick="subBillAllProps(\'' + K + '\')">All ' + ranked.length + ' clients…' +
        '<small>of ' + esc(s.name || 'theirs') + '</small></button>' : '') +
      '<button type="button" class="sb-chip sb-alt' + (finding[b.key] ? ' on' : '') + '" onclick="subBillFind(\'' + S + '\', \'' + K + '\')">🔎 Another client…' +
        '<small>From your customer list</small></button>' +
      chip('none', 'Not for a client<small>The shop, or other work</small>', b.none, 'sb-alt') +
      (b.how === 'hand' ? chip('auto', '↺ Let Job Hub match it<small>By the address or the name</small>', false, 'sb-alt') : '') +
    '</div>' + (finding[b.key] ? finderHtml(s, b) : '');
  }
  // "Another client…": the customer list, searched by name or street. One
  // picked becomes a property of theirs (the same one again if it already is).
  function finderHtml(s, b) {
    const S = sid(s.id), K = sid(b.key);
    return '<div class="sb-find"><input type="search" id="sbFind-' + K + '" value="' + esc(findQ[b.key] || '') + '"' +
        ' placeholder="A customer’s name or street" autocomplete="off" oninput="subBillFindType(\'' + S + '\', \'' + K + '\', this.value)">' +
      '<div class="sb-picks" id="sbFindRes-' + K + '">' + findResultsHtml(s, b, findQ[b.key] || '') + '</div></div>';
  }
  const FIND_SHOWN = 8;
  function findResultsHtml(s, b, q) {
    const S = sid(s.id), K = sid(b.key);
    const want = norm(q).split(' ').filter(Boolean);
    if (!want.length) return '<div class="sb-hint">Type a name or a street.</div>';
    let custs = {};
    try { custs = (window.YDCustomers && YDCustomers.all && YDCustomers.all()) || {}; } catch (e) { /* not ready */ }
    const hits = Object.keys(custs).map(id => ({ id: id, c: custs[id] })).filter(x => x.c).filter(x => {
      const ship = x.c.ship || {};
      const hay = ' ' + norm([x.c.name, x.c.business, x.c.address, x.c.street, ship.address, ship.street].join(' ')) + ' ';
      return want.every(w => hay.indexOf(' ' + w) !== -1);
    }).sort((a, c) => String(a.c.name || '').localeCompare(String(c.c.name || ''))).slice(0, FIND_SHOWN);
    const mine = {};
    propsOf(s).forEach(p => { if (p.customerId) mine[p.customerId] = true; });
    return hits.map(x => '<button type="button" class="sb-chip" onclick="subBillNewProp(\'' + S + '\', \'' + K + '\', \'' + sid(x.id) + '\')">' +
        esc(x.c.name || x.c.business || 'Customer') + '<small>' +
        esc(mine[x.id] ? 'already one of theirs' : String((x.c.ship || {}).address || x.c.address || '').split(',')[0] || ' ') + '</small></button>').join('') +
      '<button type="button" class="sb-chip sb-alt" onclick="subBillNewProp(\'' + S + '\', \'' + K + '\', \'\')">＋ A new client: “' +
        esc(String(q).trim().slice(0, 60)) + '”<small>Not in your customer list</small></button>';
  }

  // Every bill of theirs (and visit added by hand), newest first: which
  // client, how many mows, whether it counts -- each settable here.
  function allBillsHtml(s, props, B) {
    const S = sid(s.id);
    const list = B.bills;
    const shown = billsAll[s.id] ? list : list.slice(0, BILLS_SHOWN);
    const today = ymd(new Date());
    const addForm = addingVisit === s.id
      ? '<div class="add-area sub-form"><div class="grid g4">' +
          '<div class="field"><span class="label">Date</span><input type="date" id="svDate" value="' + today + '"></div>' +
          '<div class="field"><span class="label">Client</span><select id="svProp">' + props.map(p => '<option value="' + sid(p.id) + '">' +
            esc(p.client || 'Client') + '</option>').join('') + '</select></div>' +
          '<div class="field"><span class="label">What</span><input id="svService" value="Mow"></div>' +
          '<div class="field"><span class="label">Mows</span><input id="svMows" type="number" min="0" step="1" value="1"></div>' +
        '</div><div class="field-actions"><button class="btn btn-filled btn-sm" onclick="subVisitSave(\'' + S + '\')">Add it</button>' +
          '<button class="btn btn-sm" onclick="subVisitCancel()">Cancel</button></div></div>'
      : '';
    const docWord = r => (isPayment(r) ? 'payment' : String(r.docType || 'other').replace(/_/g, ' '));
    return '<div class="sub-visits"><div class="sub-bills-h">Every bill from them' +
        (visitsDoc.scannedAt ? ' <span class="muted">· email checked ' + esc(fmtDateMD(visitsDoc.scannedAt.slice(0, 10))) + '</span>' : '') +
        '<span class="sub-visit-acts"><button class="link-btn" onclick="subCheckEmail()"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Checking…' : '📧 Check their email now') + '</button>' +
        (props.length ? '<button class="link-btn" onclick="subVisitAdd(\'' + S + '\')">+ Add a visit by hand</button>' : '') +
        '</span></div>' + addForm +
      (list.length
        ? shown.map(b => billRowHtml(s, b, props, B, 'list')).join('') +
          (list.length > shown.length ? '<button class="btn btn-sm sb-more" onclick="subBillsMore(\'' + S + '\')">Show all ' + list.length + '</button>' : '')
        : '<p class="muted" style="margin:8px 0 0">' + (visitsDoc.scannedAt
            ? 'No bills from them yet — in Receipts or in your email this year.'
            : 'Their invoices have not been read from your email yet — press Check their email now.') + '</p>') +
      // A payment no bill could be found for, a refund, and the like: listed,
      // counted nowhere.
      (B.info.length ? '<div class="sb-info"><b>Also from them in Receipts</b> (not counted): ' + B.info.slice(0, 12).map(r =>
        esc(dayWords(r.date)) + ' ' + esc(docWord(r)) + ' ' + money(r.totalCents) +
        (r.link ? ' <a class="link-btn" href="' + esc(r.link) + '" target="_blank" rel="noopener">Email</a>' : '')).join(' · ') + '</div>' : '') +
    '</div>';
  }

  // Who they are in QuickBooks, for the money paid to them
  // (functions/subclients.py): found by their name among the vendors and
  // customers -- the bank feed books their withdrawals to whichever name it
  // was given -- or kept by hand (qbPayees). Under the card's figures.
  function payeesHtml(s) {
    if (!clientsDoc.readAt) return '';
    const got = ((clientsDoc.payees || {})[s.id] || {}).list || [];
    const n = ((clientsDoc.paidOut || {})[s.id] || []).length;
    return '<div class="sub-payees">💵 Money paid to them, from QuickBooks: ' + (got.length
      ? got.map(x => esc(x.name || x.id) + ' <span class="muted">(' + (x.type === 'Vendor' ? 'vendor' : 'customer') + ')</span>').join(', ') +
        ' · ' + n + ' payment' + (n === 1 ? '' : 's') + ' since ' + esc(String(clientsDoc.from || '').slice(0, 4) || 'last year')
      : '<span class="muted">no vendor or customer there by their name (the words in Edit)</span>') + '</div>';
  }
  // In Edit: a tick for each of those names; one unticked is never read for
  // them again (kept by hand), and "by their name again" lets them be found.
  function payeePicksHtml(s) {
    if (!s.id) return '';
    const found = ((clientsDoc.payees || {})[s.id] || {}).list || [];
    const hand = Array.isArray(s.qbPayees) ? s.qbPayees : null;
    const all = found.concat((hand || []).filter(h => !found.some(f => f.type === h.type && String(f.id) === String(h.id))));
    if (!all.length && !hand) return '';
    const on = x => !hand || hand.some(h => h.type === x.type && String(h.id) === String(x.id));
    return '<div class="field"><span class="label">Money paid to them in QuickBooks — under these names</span><div class="bd-pick" id="sbPayees">' +
      all.map(x => '<label class="bd-pick-item"><input type="checkbox" class="sbPayee" data-type="' + esc(x.type) + '" data-id="' + esc(String(x.id)) +
        '" data-name="' + esc(x.name || '') + '"' + (on(x) ? ' checked' : '') + '><span>' + esc(x.name || x.id) + ' (' +
        (x.type === 'Vendor' ? 'vendor' : 'customer') + ')</span></label>').join('') + '</div>' +
      (hand ? '<button class="link-btn" onclick="subPayeesAuto(\'' + sid(s.id) + '\')">↺ Find them by their name again</button>' : '') + '</div>';
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
      payeePicksHtml(s) +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="subSave(\'' + sid(s.id || '') + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="subCancel()">Cancel</button>' +
        (s.id ? '<button class="btn btn-sm btn-danger" onclick="subRemove(\'' + sid(s.id) + '\')">Remove</button>' : '') + '</div>' +
    '</div>';
  }

  // The services to pick from: the one services list (services.js) -- the
  // same list as jobs and contacts -- then any typed in on any property, so a
  // one-off name only has to be typed once. Until that list has been read,
  // the usual ones here.
  function serviceChoices(p) {
    const shared = window.YDServices && window.YDServices.names();
    const seen = shared && shared.length ? shared.slice() : SERVICES.slice();
    // (A name on the list but hidden, or an old spelling, is not offered again.)
    const offered = n => !shared || !shared.length || !window.YDServices.known(n);
    Object.values(data.subs || {}).forEach(s => propsOf(s).forEach(x => (x.services || []).forEach(n => {
      if (n && seen.indexOf(n) === -1 && offered(n)) seen.push(n);
    })));
    (p.services || []).forEach(n => { if (n && seen.indexOf(n) === -1) seen.push(n); });
    return seen;
  }
  const svcPill = (name, on) => '<label class="bd-pick-item"><input type="checkbox" class="spSvc" value="' + esc(name) + '"' +
    (on ? ' checked' : '') + '><span>' + esc(name) + '</span></label>';

  // The client in the customer list (customers.js), when it is on: their
  // name on a bill finds the property, and what they owe shows beside it.
  function custFieldHtml(p) {
    let custs = {};
    try { custs = (window.YDCustomers && YDCustomers.all && YDCustomers.all()) || {}; } catch (e) { /* not ready */ }
    const ids = Object.keys(custs).filter(id => custs[id]).sort((a, b) => String(custs[a].name || '').localeCompare(String(custs[b].name || '')));
    if (!ids.length && !p.customerId) return '';
    return '<div class="field"><span class="label">Client in your customer list</span><select id="spCust" class="searchable" onchange="subCustPicked()">' +
      '<option value="">— not tied to a customer —</option>' +
      (p.customerId && !custs[p.customerId] ? '<option value="' + sid(p.customerId) + '" selected>(a customer not in the list now)</option>' : '') +
      ids.map(id => { const c = custs[id]; return '<option value="' + sid(id) + '"' + (id === p.customerId ? ' selected' : '') + '>' +
        esc(c.name || c.business || 'Customer') + (c.address ? ' — ' + esc(String(c.address).split(',')[0]) : '') + '</option>'; }).join('') +
      '</select></div>';
  }

  function propFormHtml(s, p) {
    const jobs =(typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id).sort((a, b) => String(a.customerName || '').localeCompare(b.customerName || ''));
    const opt = (map, v) => Object.keys(map).map(k => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + map[k] + '</option>').join('');
    return '<div class="add-area sub-form">' +
      '<div class="field"><span class="label">Client’s job</span><select id="spJob" class="searchable" onchange="subJobPicked()">' +
        '<option value="">— not linked to a job —</option>' +
        jobs.map(j => '<option value="' + sid(j._id) + '"' + (j._id === p.jobId ? ' selected' : '') + '>' + esc(j.customerName || 'Untitled job') +
          (j.address ? ' — ' + esc(j.address) : '') + '</option>').join('') + '</select></div>' +
      custFieldHtml(p) +
      '<div class="field"><span class="label">Client</span><input id="spClient" value="' + esc(p.client || '') + '"></div>' +
      // In its parts (addr.js); the one line is still what the bill
      // matching reads (addrKeysIn).
      (window.YDAddr ? YDAddr.fieldsHtml('spA', p)
        : '<div class="field"><span class="label">Address</span><input id="spAddr" value="' + esc(p.address || '') + '"></div>') +
      '<div class="grid g2">' +
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
    // The QuickBooks names: kept by hand once one is unticked (or they were
    // by hand already); all ticked as found leaves them found by name.
    const boxes = Array.from(document.querySelectorAll('.sbPayee'));
    const ticked = boxes.filter(b => b.checked).map(b => ({ type: b.dataset.type, id: b.dataset.id, name: b.dataset.name || '' }));
    if (boxes.length && (ticked.length < boxes.length || Array.isArray(((data.subs || {})[id] || {}).qbPayees))) rec.qbPayees = ticked;
    form = null;
    open[subId] = true;
    put({ subs: { [subId]: rec } }, 'saving ' + name);
    fileBills();
    showToast('Saved — ' + name);
  };
  window.subRemove = async function (id) {
    const s = (data.subs || {})[id];
    if (!s || !(await ydConfirm('Their bills stay in Receipts.', { title: 'Remove ' + (s.name || 'this subcontractor') + ' and its properties?',
      ok: 'Remove', danger: true }))) return;
    if (!(data.subs || {})[id]) return;
    form = null;
    put({ subs: { [id]: null } }, 'removing');
  };
  window.subProp = function (subId, propId) { form = { kind: 'prop', subId: subId, propId: propId || '' }; open[subId] = true; render(); };
  window.subJobPicked = function () {
    const id = v('spJob');
    const j = id && (loadAllJobs() || []).find(x => x._id === id);
    if (!j) return;
    if (!v('spClient')) el('spClient').value = j.customerName || '';
    if (window.YDAddr && el('spAStreet')) {
      if (!v('spAStreet')) YDAddr.fill('spA', { street: j.address, city: j.city, state: j.state, zip: j.zip });
    } else if (el('spAddr') && !v('spAddr')) el('spAddr').value = [j.address, j.city].filter(Boolean).join(', ');
    // The job's customer, when none is picked yet (only filled, never changed).
    const cs = el('spCust');
    if (cs && !cs.value && j.customerId && Array.prototype.some.call(cs.options, o => o.value === j.customerId)) {
      cs.value = j.customerId;
      cs.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  // A customer picked: their name and address fill the boxes still empty --
  // where the work is (QuickBooks' ship-to) before where the bills go.
  window.subCustPicked = function () {
    const id = v('spCust');
    let custs = {};
    try { custs = (window.YDCustomers && YDCustomers.all && YDCustomers.all()) || {}; } catch (e) { /* not ready */ }
    const c = id && custs[id];
    if (!c) return;
    if (!v('spClient')) el('spClient').value = c.name || c.business || '';
    const at = c.ship && (c.ship.street || c.ship.address) ? c.ship : c;
    if (window.YDAddr && el('spAStreet')) {
      if (!v('spAStreet')) YDAddr.fill('spA', { street: at.street || at.address, city: at.city, state: at.state, zip: at.zip });
    } else if (el('spAddr') && !v('spAddr')) el('spAddr').value = at.address || [at.street, at.city].filter(Boolean).join(', ');
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
    const a = window.YDAddr && el('spAStreet') ? YDAddr.read('spA') : { address: v('spAddr'), street: '', city: '', state: '', zip: '' };
    const rec = {
      jobId: v('spJob') || null, client: client, address: a.address,
      street: a.street, city: a.city, state: a.state, zip: a.zip, every: v('spEvery') || 'weekly',
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
    // Only when the box was there: with the customer list off, a tie made
    // before is kept, not cleared.
    if (el('spCust')) rec.customerId = v('spCust') || null;
    form = null;
    put({ subs: { [subId]: { props: { [pid]: rec } } } }, 'saving a property');
    showToast('Saved — ' + client);
  };

  // ------------------------------------------------- a bill's client, by hand
  //
  // A pick is kept on the bill's visit and on each of its receipts (one of
  // them may come in later, or go): visitFix / rcFix {prop, none, at}.
  function fixPatch(b, fields) {
    const patch = {};
    if (b.visitKey) patch.visitFix = { [b.visitKey]: fields };
    if (b.rids.length) { patch.rcFix = {}; b.rids.forEach(id => { patch.rcFix[id] = fields; }); }
    return patch;
  }
  // What a change replaces, for Undo.
  function fixWas(b, keys) {
    const was = o => { const out = {}; keys.forEach(k => { out[k] = o && o[k] != null ? o[k] : null; }); return out; };
    const patch = {};
    if (b.visitKey) patch.visitFix = { [b.visitKey]: was((data.visitFix || {})[b.visitKey]) };
    if (b.rids.length) { patch.rcFix = {}; b.rids.forEach(id => { patch.rcFix[id] = was((data.rcFix || {})[id]); }); }
    return patch;
  }
  const closePicks = key => { delete changing[key]; delete finding[key]; delete findQ[key]; delete allProps[key]; };
  // to: a property, 'none' (Not for a client) or 'auto' (back to matching
  // by itself). No question first: Undo puts it back.
  window.subBillPick = function (subId, key, to) {
    const x = billByKey(subId, key);
    if (!x || x.b.hand || x.b.elsewhere) return;
    const p = (x.s.props || {})[to];
    if (to !== 'none' && to !== 'auto' && !p) return;
    const was = fixWas(x.b, ['prop', 'none', 'at']), at = new Date().toISOString();
    const fields = to === 'auto' ? { prop: null, none: null, at: null } : to === 'none' ? { prop: '', none: true, at: at } : { prop: to, none: null, at: at };
    closePicks(key);
    put(fixPatch(x.b, fields), 'matching a bill');
    const said = to === 'none' ? 'Not for a client' : to === 'auto' ? 'Matched by Job Hub again' : 'For ' + (p.client || 'the client');
    if (typeof showUndo === 'function') showUndo(said, () => put(was, 'putting a match back'));
    else showToast(said);
  };
  window.subBillChange = function (subId, key) {
    if (changing[key]) closePicks(key); else changing[key] = true;
    render();
  };
  window.subBillAllProps = function (key) { allProps[key] = true; render(); };
  window.subBillFind = function (subId, key) {
    finding[key] = !finding[key];
    render();
    const n = el('sbFind-' + key);
    if (n) n.focus();
  };
  // Typing in "Another client…": only its answers are drawn again.
  window.subBillFindType = function (subId, key, value) {
    findQ[key] = String(value || '');
    const x = billByKey(subId, key), box = el('sbFindRes-' + key);
    if (x && box) box.innerHTML = findResultsHtml(x.s, x.b, findQ[key]);
  };
  // A client from the customer list (or a new name typed in) becomes one of
  // the subcontractor's properties, with the bill on it. Its address is the
  // bill's own when it has one -- so the next bill there finds it -- else the
  // customer's. How often and the prices are left for Jonah (Edit): nothing
  // is guessed, so no visits are expected of it until he sets them.
  window.subBillNewProp = function (subId, key, custId) {
    const x = billByKey(subId, key);
    if (!x || x.b.hand || x.b.elsewhere) return;
    const s = x.s, b = x.b;
    let custs = {};
    try { custs = (window.YDCustomers && YDCustomers.all && YDCustomers.all()) || {}; } catch (e) { /* not ready */ }
    const c = custId ? custs[custId] : null;
    if (custId && !c) return;
    const have = c && propsOf(s).find(p => p.customerId === custId);
    if (have) { window.subBillPick(subId, key, have.id); return; }
    const name = c ? (c.name || c.business || '') : String(findQ[key] || '').trim().slice(0, 80);
    if (!name) { showToast('Type the client’s name'); return; }
    const pid = newId('sp'), at = new Date().toISOString();
    const where = c ? (c.ship && (c.ship.street || c.ship.address) ? c.ship : c) : {};
    const theirs = addrKeysIn([where.address, where.street].filter(Boolean).join(' ; '));
    const useBill = !!b.address && !b.siteKeys.some(k => theirs.indexOf(k) !== -1);
    const rec = {
      jobId: null, customerId: c ? custId : null, client: name,
      address: useBill ? b.address : (where.address || [where.street, where.city].filter(Boolean).join(', ') || ''),
      street: useBill ? b.address : (where.street || ''), city: useBill ? '' : (where.city || ''),
      state: useBill ? '' : (where.state || ''), zip: useBill ? '' : (where.zip || ''),
      every: 'other', everyText: 'Not set yet', perMonth: null,
      theirCents: null, theirPer: 'visit', ourCents: null, ourPer: 'visit',
      services: MOWING.test(b.service || '') ? ['Mowing'] : [],
      from: SEASON.from, to: SEASON.to, off: false, fromBill: key, createdAt: at, updatedAt: at,
    };
    const was = fixWas(b, ['prop', 'none', 'at']);
    const patch = fixPatch(b, { prop: pid, none: null, at: at });
    patch.subs = { [subId]: { props: { [pid]: rec } } };
    closePicks(key);
    put(patch, 'adding a client from a bill');
    const said = name + ' added to ' + (s.name || 'their') + ' clients — Edit it for the prices';
    if (typeof showUndo === 'function') {
      showUndo(said, () => put(Object.assign(was, { subs: { [subId]: { props: { [pid]: null } } } }), 'taking the client back off'));
    } else showToast(said);
  };
  window.subBillMows = function (subId, key, value) {
    const x = billByKey(subId, key);
    if (!x) return;
    const n = String(value).trim() === '' ? null : Math.max(0, Math.round(+value));
    if (n != null && !isFinite(n)) { showToast('Mows as a number'); render(); return; }
    if (x.b.hand) put({ handVisits: { [x.b.handKey]: { mows: n == null ? 0 : n } } }, 'setting mows');
    // Cleared: back to what the bill says.
    else put(fixPatch(x.b, { mows: n }), 'setting mows');
  };
  window.subBillSkip = function (subId, key, skip) {
    const x = billByKey(subId, key);
    if (!x || x.b.hand) return;
    put(fixPatch(x.b, { skip: !!skip }), skip ? 'not counting a bill' : 'counting a bill');
  };
  window.subPropBills = function (subId, propId) {
    openBills[subId] = propId && openBills[subId] !== propId ? propId : '';
    open[subId] = true;
    render();
    const n = propId && el('sbP-' + sid(subId) + '-' + sid(propId));
    if (n && n.scrollIntoView) n.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  window.subMatchMore = function (subId) { matchAll[subId] = true; render(); };
  window.subBillsMore = function (subId) { billsAll[subId] = true; render(); };
  // From Home's "Waiting on you": the subcontractor's bills to match.
  window.openSubBills = function (subId) {
    if (typeof switchTab === 'function') switchTab('dashboard');
    render();
    setTimeout(() => {
      const n = (subId && el('sbMatch-' + sid(subId))) || document.querySelector('.sb-match') || el('subsSection');
      if (n && n.scrollIntoView) n.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  };

  // ------------------------------------------------- visits, set by hand
  // No question first: Undo puts it back.
  window.subVisitRemove = function (key) {
    const v = (data.handVisits || {})[key];
    if (!v) return;
    put({ handVisits: { [key]: null } }, 'removing a visit');
    if (typeof showUndo === 'function') showUndo('Visit removed', () => put({ handVisits: { [key]: v } }, 'putting a visit back'));
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
      const rep = (r && r.report) || {}, n = rep.new || 0, np = rep.payments || 0;
      const news = [n ? n + ' new bill' + (n === 1 ? '' : 's') : '', np ? np + ' new payment' + (np === 1 ? '' : 's') : ''].filter(Boolean);
      // (Their clients were read from QuickBooks on the same press.)
      showToast((news.length ? news.join(' and ') + ' from their emails' : 'Nothing new in their email') +
        (rep.clientsError ? ' — ' + rep.clientsError : ''));
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
    let name = box ? box.value.trim().slice(0, 40) : '';
    if (!name || !wrap) return;
    // An old spelling of one on the list is that one (services.js).
    if (window.YDServices) { name = window.YDServices.canon(name); window.YDServices.remember(name); }
    const have = Array.from(wrap.querySelectorAll('.spSvc')).find(i => i.value.toLowerCase() === name.toLowerCase());
    if (have) have.checked = true;
    else wrap.insertAdjacentHTML('beforeend', svcPill(name, true));
    box.value = '';
    box.focus();
  };
  window.subPropRemove = async function (subId, propId) {
    const p = (((data.subs || {})[subId] || {}).props || {})[propId];
    if (!p || !(await ydConfirm('', { title: 'Remove ' + (p.client || 'this property') + '?', ok: 'Remove', danger: true }))) return;
    form = null;
    put({ subs: { [subId]: { props: { [propId]: null } } } }, 'removing a property');
  };
  window.subPaid = function (receiptId, paid) {
    put({ paid: { [receiptId]: paid ? ymd(new Date()) : null } }, 'marking a bill');
  };
  window.subPayeesAuto = function (subId) {
    if (!(data.subs || {})[subId]) return;
    form = null;
    put({ subs: { [subId]: { qbPayees: null, updatedAt: new Date().toISOString() } } }, 'finding them by name');
    showToast('Found by their name at the next QuickBooks look (within the hour)');
  };
  // A client's invoice counted as the subcontractor's work, or not. The
  // same as Job Hub would say by itself is no say at all (back to automatic).
  window.subInvCount = function (invId, on, auto) {
    put({ invFix: { [invId]: on === auto ? null : { skip: !on, at: new Date().toISOString() } } },
      on ? 'counting an invoice' : 'not counting an invoice');
  };

  // ---------------------------------------------------------------- loading

  function stop() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null; fresh = false; form = null; addingVisit = '';
    data = EMPTY();
    visitsDoc = { visits: {}, payments: {}, scannedAt: '' };
    clientsDoc = NO_CLIENTS();
    openBills = {}; changing = {}; allProps = {}; finding = {}; findQ = {}; matchAll = {}; billsAll = {};
    forget();
  }
  function start() {
    stop();
    if (!owner() || !window.YDDb) { render(); return; }
    unsub = window.YDDb.watch('settings', (changes, meta) => {
      // Every settings record comes through here -- the email reader writes
      // settings/receipts every half hour -- and only three are ours. Anything
      // else changing is no reason to file bills or redraw, unless this is
      // the first word from the server (what `fresh` waits for).
      const ours = changes.some(c => c.id === 'subcontractors' || c.id === 'subVisits' || c.id === 'subClients');
      const first = !fresh && !!meta && meta.fromCache === false;
      if (!ours && !first) return;
      changes.forEach(c => {
        const d = c.type === 'removed' ? {} : (c.data || {});
        if (c.id === 'subVisits') { visitsDoc = { visits: d.visits || {}, payments: d.payments || {}, scannedAt: d.scannedAt || '' }; return; }
        if (c.id === 'subClients') {
          clientsDoc = { customers: d.customers || {}, payees: d.payees || {}, paidOut: d.paidOut || {}, from: d.from || '', readAt: d.readAt || '' };
          return;
        }
        if (c.id !== 'subcontractors') return;
        data = { subs: d.subs || {}, paid: d.paid || {}, filed: d.filed || {}, visitFix: d.visitFix || {},
                 handVisits: d.handVisits || {}, svcProp: d.svcProp || {}, rcFix: d.rcFix || {}, invFix: d.invFix || {},
                 billTodos: d.billTodos || {}, billTodosFrom: d.billTodosFrom || '' };
      });
      if (meta && meta.fromCache === false) fresh = true;
      forget();
      fileBills();
      billTodos();
      quietRender();
      // A job's subcontractor costs (forJob) may have moved, and Home's
      // count of bills to match.
      document.dispatchEvent(new CustomEvent('yd-subs'));
    }, () => {});
  }
  // Drawn again for news from elsewhere only while All Jobs is in front, and
  // not under someone typing in it (a mows box, "Another client…"): the
  // next news, or their own change, draws it.
  function quietRender() {
    const p = el('panel-dashboard'), wrap = el('subsWrap'), a = document.activeElement;
    if (!p || !p.classList.contains('active')) return;
    if (wrap && a && wrap.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
    render();
  }
  document.addEventListener('yd-receipts', () => { forget(); fileBills(); billTodos(); quietRender(); });
  // A customer's or a job's name and address find bills too, and what a
  // client owes comes from the invoices.
  ['yd-customers', 'yd-jobs-changed', 'yd-invoices'].forEach(ev => document.addEventListener(ev, () => { forget(); quietRender(); }));

  // What subcontractors have charged on one job this season so far: every
  // property here linked to that job, counted the way the cards above count
  // them (whole visits on real dates, their price). For Estimate vs actual
  // (jobcosts.js). null when no property is linked to the job -- or for
  // anyone but the owner, who alone has the list. billed / bills: what
  // their bills for those properties came to this season, each once.
  function forJob(jobId) {
    if (!jobId || !owner()) return null;
    const now = new Date(), y = now.getFullYear();
    const out = { cents: 0, ours: 0, visits: 0, subs: [], billed: 0, bills: 0 };
    let linked = false;
    subsList().forEach(s => {
      const anchors = anchorsOf(s), B = billsFor(s);
      propsOf(s).filter(p => p.jobId === jobId).forEach(p => {
        linked = true;
        for (let m = 0; m <= now.getMonth(); m++) {
          const x = monthOf(p, y, m, anchors[p.id], m === now.getMonth() ? now.getDate() : 0);
          out.visits += x.visits; out.cents += x.their; out.ours += x.ours;
        }
        const f = propFigures(s, p, B, anchors);
        out.billed += f.billed; out.bills += f.now.length;
        const name = s.name || 'Subcontractor';
        if (out.subs.indexOf(name) === -1) out.subs.push(name);
      });
    });
    return linked ? out : null;
  }

  // Bills no client could be told from, by subcontractor -- for Home's
  // "Waiting on you". Only once their bills and Receipts have come from the
  // server (a half-read list would count bills its receipt would have told).
  function toMatch() {
    if (!owner() || !fresh || !(window.YDReceipts && YDReceipts.loaded && YDReceipts.loaded())) return [];
    return subsList().map(s => {
      const list = billsFor(s).toMatch;
      return { id: s.id, name: s.name || 'Subcontractor', n: list.length,
        cents: list.reduce((n, b) => n + (typeof b.cents === 'number' ? b.cents : 0), 0) };
    }).filter(x => x.n);
  }
  // Whose bill a receipt is, in words, for its chip in Receipts: "for <the
  // client>", "not for a client", "client to pick" -- or '' (not a
  // subcontractor's bill, or not the owner's to see).
  function clientOf(r) {
    if (!owner() || !r || !r.id) return '';
    const w = subOf(r), s = w && subById(w.id);
    const b = s && billsFor(s).rcIndex[r.id];
    if (!b || b.elsewhere || b.hand) return '';
    if (b.none) return 'not for a client';
    if (b.prop) return 'for ' + (((s.props || {})[b.prop] || {}).client || 'a client');
    return b.counts ? 'client to pick' : '';
  }

  // Whose bill a receipt is, for a screen that acts on it (a to-do to bill
  // the client, say): the subcontractor, the property, its customer and how
  // that was told -- matched the way the Subcontractors section matches it
  // (address, name, his picks, their price). null when it is no
  // subcontractor's bill, or no client could be told yet.
  function billClient(r) {
    if (!owner() || !r || !r.id) return null;
    const w = subOf(r), s = w && subById(w.id);
    const B = s && billsFor(s), b = B && B.rcIndex[r.id];
    if (!b || b.elsewhere || b.hand || b.none || !b.prop) return null;
    const p = Object.assign({ id: b.prop }, (s.props || {})[b.prop] || {}), c = custOf(p, B.L);
    return { subId: s.id, subName: s.name || '', propId: b.prop, client: p.client || '', address: p.address || '',
      customerId: p.customerId || ((jobOf(p, B.L) || {}).customerId) || null, qbCustomerId: (c && c.qbCustomerId) || null,
      jobId: p.jobId || null, how: b.how, cents: b.cents, date: b.date, service: b.service, billKey: b.key };
  }

  // list: the subcontractors set up here, for Receipts' Subcontractor picker
  // (empty for anyone but the owner, who alone reads them).
  window.YDSubs = { render: render, data: () => data, subFor: r => subFor(r), subOf: r => subOf(r),
    list: () => subsList().map(s => ({ id: s.id, name: s.name || '' })), forJob: forJob,
    toMatch: toMatch, clientOf: clientOf, billClient: billClient,
    // Every bill of one subcontractor, each once, with its client and how
    // that was told (for a screen that wants them; and for testing).
    bills: subId => { const s = owner() && subById(subId); return s ? billsFor(s).bills : []; },
    // The usual ones, for the first fill of the one services list (services.js).
    services: () => SERVICES.slice() };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; if (k) start(); else stop(); }
    render();
  });
})();
