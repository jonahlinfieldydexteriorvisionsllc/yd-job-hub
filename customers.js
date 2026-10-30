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
// Jonah (30 Oct 2026): "i want all claude conversations about estimates and
// all estimates tied to proper customers so i can go to a customer and say
// 'he wants a separate bid for just ___' and then it can use info from other
// bids its made." A bid's conversation with Claude is saved on the bid, so a
// bid tied to its customer ties its conversation too. Bids are tied as they
// are made, and by themselves whenever they surely are someone's (see "Every
// bid tied to its customer"); a customer's page shows each bid's talk with
// Claude, and "Start a bid" there says what the new one is for and/or which
// lines of their other bids to carry over -- Claude is shown their other bids
// with every message about any of their bids (estimates.py).
//
// Nothing changes until the owner switches the list on (settings/customers
// .importOn): until then this tab is the Contacts screen, as it was.
//
// Who sees it follows the Contacts access area. Money -- prices, invoices,
// what they owe, payments -- only for whoever sees Billing. Crew never.
//
// Jonah (16 Oct 2026), three asks on this one screen:
//  * "call list in contacts shouldnt only show customers when its there time
//    to call i want to be able to view a full list of people im calling for
//    next season" -- the Call list now holds everyone with a time to call:
//    Call now, then Coming up month by month / season by season, then the
//    ones with no time set yet (leads, and customers he tagged or wrote a
//    note on), the ones reached and the not interested folded below.
//  * "the what for section for calling a client should have a search bar" --
//    the services on a customer's page are tap buttons found by typing.
//  * "customer list needs to be gone back over ... I need a list of the new
//    leads so i can enter there info. also make sure theres no duplicated.
//    also there should be one centralized list of all contacts too" -- the
//    Leads view adds a quick "+ Add a lead" and fills in what each lead is
//    missing one after another; "Check the list" counts what is off (the
//    same person twice, sub-customers, jobs whose name is not their
//    customer's, edits not yet in QuickBooks...), each line opening its fix;
//    and "Everyone" is the one list of every person and company: customers,
//    leads, old contacts, suppliers, subcontractors and the team.
//
// The same person twice. Two LEADS, or a lead and a customer: the lead goes
// onto the other one (its tags, notes and time to call carried across, the
// lead kept and marked mergedInto -- as the server does when a lead's first
// estimate makes their QuickBooks profile). Two QUICKBOOKS customers are
// never merged by Job Hub -- that is QuickBooks' own merge, his to do there:
// he picks the main one and the other is marked sameAs it, so Job Hub shows
// one row (the other's jobs, invoices and snow on the main one's page) and
// new estimates go to the main one. "Not the same" is remembered on both
// (notSame) and never asked again. Nothing is deleted, and each is undone
// with one tap (the main one's page: "Show as its own again").
//
// QuickBooks sub-customers ("Parent:Job" -- qbParentId) are not people of
// their own: they are shown on their parent's page, not as rows of their own,
// unless Jonah taps "Show as its own person" on one (showOwn). One with a
// time to call of its own still comes up on the Call list.

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
  let nb = null;                  // a new bid being started on a customer's page: { id, text, lines: {job: [line ids]}, mats: {job: [ids]}, own: {job: true} }
  const talkOpen = {};            // job id -> its conversation with Claude shown on the customer's page
  const sortPick = {};            // To sort: "kind:id" -> customer id picked (or 'lead' / 'skip')
  let ver = 0;                    // goes up with every change to the list (what the duplicates are worked out from)
  let tagPick = '';               // the "What for" filter on the lists ('' = any)
  let tagsOpen = false;           // its buttons are showing
  let everyKind = '';             // Everyone: '' all, or one kind of contact
  let checkPart = '';             // Check the list: the part opened
  let addOpen = false;            // Leads: the quick "+ Add a lead" form is open
  let addDraft = {};              // ... and what is typed in it
  let fill = null;                // filling in details one after another: { ids, at, from }
  const fillDraft = {};           // customer id -> { field: what is typed }
  const tagFind = {};             // a customer's page / the add form -> the service being searched for
  let tagAll = {};                // ... "Show all services" tapped
  const dupMain = {};             // a duplicates group -> the one picked as the main one
  let otherOpen = null;           // Everyone: a supplier / subcontractor / team member / old contact open { kind, id }
  let vendorsRead = null;         // the suppliers, read once here when Supplies is not watching them
  let prefill = null;             // a customer's page: details to fill into the form (a lead merged onto them)

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
  // The ones shown with them count too: work billed to a sub-customer (a job
  // under them in QuickBooks) or to their second profile is work for them.
  function lastActivity(c) {
    let best = '';
    [c].concat(family(c.id).map(id => customers[id]).filter(Boolean)).forEach(x => {
      const work = s(x.lastWorkAt).slice(0, 10), made = s(x.qbCreatedAt).slice(0, 10);
      if (work > best) best = work;
      if (made > best) best = made;
      jobsOf(x.id).forEach(j => {
        const d = s(j.quoteDate || j.completedAt || j.lastModified).slice(0, 10);
        if (d > best) best = d;
      });
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
  // shows someone from the window's first day until "✓ Reached out" is
  // tapped. Picked with tap buttons on the customer's page (his yes, 15 Oct
  // 2026): Spring / Summer / Fall / Winter with the year, a month, or "In
  // about 1–3 months" -- stored as when {from, to, label, how}, and the label
  // as contactWhen too, so the words read the same everywhere. Words typed
  // in still work (contactWhen, read by windowFromText), and so does every
  // time to call written before the buttons. functions/outreach.py counts
  // the morning summary's call list the same way -- change both.
  const two = n => String(n).padStart(2, '0');
  function ymd(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  const today = () => ymd(new Date());
  const lastDay = (y, m) => ymd(new Date(y, m, 0));        // m 1-12
  const SEASON = { spring: [3, 5], summer: [6, 8], fall: [9, 11], autumn: [9, 11], winter: [12, 2] };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;
  const SEASON_RE = /\b(spring|summer|fall|autumn|winter)\b/;
  const validDay = v => /^\d{4}-\d{2}-\d{2}$/.test(s(v));
  // The day, in the shop's own time, of something stored: a plain day stays
  // as it is; a timestamp (kept in UTC, so a note written after about 7 pm in
  // Wisconsin reads as TOMORROW if cut at 10 characters) is moved to the day
  // it happened here.
  function localDay(v) {
    v = s(v);
    if (!v) return '';
    if (validDay(v)) return v;
    const d = new Date(v);
    return isNaN(d) ? '' : ymd(d);
  }
  // Said the way people say it, with no date in it (crew testing, 16 Oct
  // 2026: "this month" was not understood): this / next week, this / next
  // month, this / next year, and "in 3 weeks", "in a couple of months" --
  // the week (Sunday to Saturday, as the calendar's weeks) or the month it
  // falls in. And "next" before a month or a season is the next one that
  // has not begun: "next fall" said in October is next year's (as the Fall
  // button is), where "fall" alone is this one.
  const REL_RE = /\b(this|next) (week|month|year)\b/;
  const IN_RE = /\bin (\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a )?couple(?: of)?|(?:a )?few) (weeks?|months?)\b/;
  const COUNT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  function countOf(w) {
    if (/^\d+$/.test(w)) return +w;
    if (/couple/.test(w)) return 2;
    if (/few/.test(w)) return 3;
    if (w === 'a' || w === 'an') return 1;
    return COUNT_WORDS.indexOf(w) + 1;
  }
  const nextBefore = (t, at) => /\bnext $/.test(t.slice(0, at));
  // The week (Sunday to Saturday) and the month a day is in.
  function weekOf(d) {
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
    return { from: ymd(a), to: ymd(new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6)) };
  }
  function monthOf(y, m) {                                 // m 1-12, may run past 12
    const a = new Date(y, m - 1, 1);
    return { from: ymd(a), to: lastDay(a.getFullYear(), a.getMonth() + 1) };
  }

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
    const named = !m && !!name;
    if (named) m = MONTHS.indexOf(name[1].slice(0, 3)) + 1;
    if (m) {
      // No year: the next time that month comes round (this one if we are
      // in it) -- or, "next October", the next one still to begin.
      if (!y) y = named && nextBefore(t, name.index) ? (m > thisMonth ? thisYear : thisYear + 1)
        : m >= thisMonth ? thisYear : thisYear + 1;
      return { from: y + '-' + two(m) + '-01', to: lastDay(y, m), label: s(text) };
    }
    if (season) {
      const [a, b] = SEASON[season[1]];
      // No year: this one if we are in it or before it, else next year's.
      // Winter runs Dec-Feb: January and February belong to last December's.
      // "Next spring": the next one still to begin.
      if (!y) {
        if (nextBefore(t, season.index)) y = thisMonth < a ? thisYear : thisYear + 1;
        else if (a <= b) y = thisMonth <= b ? thisYear : thisYear + 1;
        else y = thisMonth <= b ? thisYear - 1 : thisYear;
      }
      return { from: y + '-' + two(a) + '-01', to: a > b ? lastDay(y + 1, b) : lastDay(y, b), label: s(text) };
    }
    if (y) return { from: y + '-01-01', to: y + '-12-31', label: s(text) };
    const rel = t.match(REL_RE), inN = t.match(IN_RE);
    let w = null;
    if (rel) {
      const k = rel[1] === 'next' ? 1 : 0;
      if (rel[2] === 'week') w = weekOf(new Date(thisYear, thisMonth - 1, now.getDate() + 7 * k));
      else if (rel[2] === 'month') w = monthOf(thisYear, thisMonth + k);
      else w = { from: (thisYear + k) + '-01-01', to: (thisYear + k) + '-12-31' };
    } else if (inN) {
      const n = countOf(inN[1]);
      if (n >= 1 && n <= 60) {
        w = /^week/.test(inN[2]) ? weekOf(new Date(thisYear, thisMonth - 1, now.getDate() + 7 * n))
          : monthOf(thisYear, thisMonth + n);
      }
    }
    return w ? { from: w.from, to: w.to, label: s(text) } : null;
  }
  function windowOf(c) {
    const w = c.when;
    if (w && validDay(w.from) && validDay(w.to || w.from)) return { from: w.from, to: w.to || w.from, label: s(w.label) || s(c.contactWhen), how: s(w.how) };
    return windowFromText(c.contactWhen);
  }

  // ---- the buttons
  const SEASON_BTNS = [['spring', 'Spring', 3, 5], ['summer', 'Summer', 6, 8], ['fall', 'Fall', 9, 11], ['winter', 'Winter', 12, 2]];
  const MONTH_WORDS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // The year a season or month beginning in month `a` next begins: this
  // year while its first day is still to come, else next year -- and one
  // more with "A year later". A season we are in has begun: "Fall" tapped in
  // October is next fall (this one is "In about 1–3 months" or a month).
  function nextYear(a, later) {
    const y = new Date().getFullYear();
    return (y + '-' + two(a) + '-01' > today() ? y : y + 1) + (later ? 1 : 0);
  }
  function seasonWindow(key, later) {
    const b0 = SEASON_BTNS.find(x => x[0] === key);
    if (!b0) return null;
    const [, word, a, b] = b0, y = nextYear(a, later);
    return { from: y + '-' + two(a) + '-01', to: a > b ? lastDay(y + 1, b) : lastDay(y, b),
      label: word + ' ' + (a > b ? y + '–' + String(y + 1).slice(2) : y), how: 'season' };
  }
  function monthWindow(m, later) {
    if (!(m >= 1 && m <= 12)) return null;
    const y = nextYear(m, later);
    return { from: y + '-' + two(m) + '-01', to: lastDay(y, m), label: MONTH_WORDS[m - 1] + ' ' + y, how: 'month' };
  }
  // n months on from a day, kept inside the month (Jan 31 + 1 = Feb 28).
  function plusMonths(d, n) {
    const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    t.setDate(Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
    return t;
  }
  // 1 to 3 months from the day it was tapped.
  function soonWindow() {
    const now = new Date();
    return { from: ymd(plusMonths(now, 1)), to: ymd(plusMonths(now, 3)), label: 'In about 1–3 months', how: 'soon' };
  }
  // How a window reads in the lists: "In about 1–3 months" means nothing a
  // month later, so that one says when it starts.
  function whenText(w) {
    if (!w) return '';
    if (w.how === 'soon') return 'From ' + niceDay(w.from);
    return w.label || windowWords(w);
  }
  let whenLater = false;          // "A year later" picked on the open page
  let whenPicking = false;        // the buttons open on a customer who has a time already
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
    if (localDay(at) < w.from) return false;
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
  // A lead merged into someone is that someone -- followed a few steps (a
  // lead merged into a lead that later became a QuickBooks customer).
  function resolve(id) {
    let n = 0;
    while (id && merged[id] && n++ < 6) id = merged[id];
    return id;
  }
  // A QuickBooks customer marked the same person as another (sameAs) is
  // shown as that one. A loop (two marked as each other) shows both.
  function mainOf(id) {
    id = resolve(id);
    const seen = [id];
    let at = id;
    while (customers[at] && customers[at].sameAs) {
      const to = resolve(s(customers[at].sameAs));
      if (!customers[to]) return at;                  // the main one is not in the list
      if (seen.indexOf(to) !== -1) return id;         // a loop: each shown as itself
      seen.push(to);
      at = to;
    }
    return at;
  }
  const isTwin = c => !!(c && c.sameAs && mainOf(c.id) !== c.id);
  // A sub-customer's parent, when it is in the list (as the one it is shown as).
  function parentOf(c) {
    if (!c || !c.qbParentId) return null;
    const p = customers[mainOf(s(c.qbParentId))];
    return p && p.id !== c.id ? p : null;
  }
  const isFolded = c => !!(c && c.qbParentId && c.showOwn !== true && parentOf(c));
  // A row of its own in the people lists.
  const inLists = c => !isTwin(c) && !isFolded(c);
  // Customer id -> the ones shown on their page with them: their second
  // QuickBooks profiles and their folded sub-customers.
  let famMap = null;
  function family(id) {
    if (!famMap) {
      famMap = {};
      const add = (to, x) => { (famMap[to] = famMap[to] || []).push(x); };
      Object.values(customers).forEach(c => {
        if (isTwin(c)) add(mainOf(c.id), c.id);
        else if (isFolded(c)) add(parentOf(c).id, c.id);
      });
    }
    return famMap[id] || [];
  }
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
  // Their own jobs and the ones of everyone shown with them.
  const jobsFor = c => [c.id].concat(family(c.id)).reduce((all, id) => all.concat(jobsOf(id)), []);
  function invoicesOf(c, jobs) {
    if (!can('billing', 'see') || !window.YDInvoices) return [];
    const ids = {}, qbIds = {};
    (jobs || []).forEach(j => { ids[j._id] = true; });
    [c.id].concat(family(c.id)).forEach(id => { const x = customers[id]; if (x && x.qbCustomerId) qbIds[s(x.qbCustomerId)] = true; });
    return Object.values(YDInvoices.all() || {}).filter(inv =>
      (inv.customerId && qbIds[s(inv.customerId)]) || (inv.jobId && ids[inv.jobId]));
  }
  function snowOf(id) {
    if (!can('snow', 'see') || !window.YDSnow) return [];
    const acc = YDSnow.accounts() || {};
    const mine = {};
    [id].concat(family(id)).forEach(x => { mine[x] = true; });
    return Object.keys(acc).filter(k => acc[k] && mine[resolve(acc[k].customerId)]).map(k => Object.assign({ id: k }, acc[k]));
  }
  const money = n => (typeof fmtMoney === 'function' ? fmtMoney(n) : '$' + (Number(n) || 0).toFixed(2));

  // ------------------------------------------------------------ snow quotes
  //
  // Jonah (15 Oct 2026), instead of a spreadsheet: who was quoted for snow
  // this season or last and didn't take it. The server's daily look at the
  // estimates (functions/customers.py look_back) puts each snow quote on its
  // customer -- snow {quotes [{id, num, date, status, sold, season}],
  // accounts [Snow account ids that are theirs]}. No money on it.
  //
  // On the list: quoted for snow (a Snow Removal product on the estimate)
  // this season or last; none of those quotes taken (accepted, or made into
  // an invoice); no Snow account here that is theirs and switched on; not
  // marked Not interested. "✓ Called about snow" (snowCalledAt) moves them
  // under "Called this season" -- a new season brings them back.
  // A season is named by the year it starts in, from July on (snow.js
  // seasonNow, the Snow tab's "2026-27").
  const snowSeasonOf = d => { const y = +s(d).slice(0, 4), m = +s(d).slice(5, 7); return m >= 7 ? y : y - 1; };
  const seasonWord = y => y + '–' + String(y + 1).slice(2);
  const QUOTE_WORD = { Pending: 'no answer yet', Rejected: 'turned down', Closed: 'closed', Accepted: 'accepted', Converted: 'invoiced' };
  // Their Snow accounts, live when this person sees the Snow tab (an account
  // tied or untied by hand since the server's last look counts at once).
  function snowAccountsOf(c, fromServer) {
    if (!can('snow', 'see') || !window.YDSnow) return fromServer;
    const acc = YDSnow.accounts() || {};
    if (!Object.keys(acc).length) return fromServer;            // not read yet
    const live = fromServer.filter(id => acc[id] && acc[id].active !== false && (!acc[id].customerId || resolve(acc[id].customerId) === c.id));
    snowOf(c.id).forEach(a => { if (a.active !== false && live.indexOf(a.id) === -1) live.push(a.id); });
    return live;
  }
  function snowFacts(c) {
    const sn = c && c.snow;
    if (!sn || !Array.isArray(sn.quotes)) return null;
    const cur = snowSeasonOf(today());
    const quotes = sn.quotes.filter(q => q && validDay(q.date) && snowSeasonOf(q.date) >= cur - 1 && snowSeasonOf(q.date) <= cur)
      .sort((a, b) => s(b.date).localeCompare(s(a.date)));
    if (!quotes.length) return null;
    const sold = quotes.some(q => q.sold === true);
    const accounts = snowAccountsOf(c, Array.isArray(sn.accounts) ? sn.accounts : []);
    return { quotes: quotes, sold: sold, accounts: accounts, season: snowSeasonOf(quotes[0].date),
      onList: !sold && !accounts.length && !c.notInterested };
  }
  const snowCalled = c => !!c.snowCalledAt && localDay(c.snowCalledAt) >= snowSeasonOf(today()) + '-07-01';
  function quoteLine(q) {
    return (q.num ? '#' + esc(q.num) + ' · ' : '') + esc(niceDay(q.date)) + ' · ' + esc(QUOTE_WORD[q.status] || s(q.status).toLowerCase() || 'no answer yet');
  }

  // ------------------------------------------------------------ the list
  //
  // The screen is four stacked parts, so a redraw touches only what changed:
  //   #custViews  the view buttons and their counts
  //   #custFind   the search row -- built once and left alone while it reads
  //               the same (a rebuild every 150 ms of typing swallowed a
  //               trailing space, lowercased the box and threw the caret to
  //               the end: "mary a" came out "marya")
  //   #custTags   the "What for" buttons
  //   #custList   the list itself (typing in the search redraws only this)
  // The tab is drawn only while it is on screen: the five snapshot feeds that
  // arrive all day (jobs, invoices, contacts, snow, customers) used to redraw
  // five hundred customers on every one, whatever tab he was on. A change
  // that comes while it is hidden is remembered (`dirty`) and drawn on arrival.
  let searchText = '';            // the search box as typed -- spaces and capitals kept
  let findSig = '';               // the search row as last built
  let dirty = false;              // something changed while the tab was hidden
  let drawnDay = '';              // the day the list was last drawn (call lists change with the date)
  let panelWatched = false;       // the arrival of the tab is being watched
  const panelShown = () => {
    if (!panelWatched) return true;     // no way to know: draw, as before
    const p = el('panel-contacts');
    return !!p && p.classList.contains('active');
  };
  // The ones counted on the "Check the list" button -- worked out once for
  // the button and, in that view, again as the lines themselves (same figures).
  let countedMemo = null;
  function counted() {
    const jobsRef = can('jobs', 'see') ? allJobs() : null;
    if (countedMemo && countedMemo.ver === ver && countedMemo.jobs === jobsRef) return countedMemo.v;
    const people = Object.values(customers).filter(inLists);
    const v = {
      dups: dupGroups(),
      leadsMiss: people.filter(c => !isQb(c) && missingOf(c).length).length,
      qb: qbTrouble().length,
      names: jobsRef ? nameMismatches().length : 0,
    };
    countedMemo = { ver: ver, jobs: jobsRef, v: v };
    return v;
  }
  const checkCount = () => { const v = counted(); return v.dups.groups.length + v.leadsMiss + v.qb + v.names; };

  // The people lists: one row a person (a second QuickBooks profile and a
  // sub-customer are on their main one's page). The call list and the snow
  // quotes take a sub-customer too, under its parent's name -- a time to
  // call or a snow quote of its own is not to be lost.
  function peopleLists() {
    const all = Object.values(customers);
    return { people: all.filter(inLists), callable: all.filter(c => !isTwin(c)) };
  }
  // What is under the buttons for the view that is showing.
  function listBodyHtml(people, callable, checks) {
    if (view === 'sort') return sortHtml();
    if (view === 'check') return checkHtml(checks);
    const q = low(searchText), tag = view === 'everyone' ? '' : tagPick;
    return view === 'call' ? callHtml(callable, q, tag) : view === 'snow' ? snowHtml(callable, q, tag)
      : view === 'nextyear' ? nyHtml(q, tag)
      : view === 'everyone' ? everyoneHtml(people, q)
      : view === 'leads' ? leadsHtml(people.filter(c => kindOf(c) === 'lead'), q, tag)
      : listHtml(people.filter(c => kindOf(c) === { customers: 'customer', past: 'past' }[view]), q, tag);
  }
  // A snapshot arriving (quiet) while he is typing in the "Add a lead" or "Fill
  // in" form does not redraw the screen under his caret: it waits (`pendingQuiet`)
  // and is drawn when he leaves the form. (A form is only ever redrawn for
  // something he did -- a tap, a save -- never for something that came in.)
  let pendingQuiet = false;
  const inForm = () => {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('#custWrap .cu-add, #custWrap .cu-fill'));
  };
  function paintList(html) {
    const box = el('custList');
    if (box) box.innerHTML = html;
  }
  // Typing in the search box: only the list under it is drawn again.
  function renderListOnly() {
    if (!isOn() || !loaded || !el('custList') || !panelShown() || view === 'sort' || view === 'check') { render(); return; }
    const l = peopleLists();
    paintList(listBodyHtml(l.people, l.callable, []));
  }

  // `quiet`: something changed under the page (a snapshot) rather than
  // something being tapped -- a form being typed in is not rebuilt.
  function render(quiet) {
    jobMap = null; famMap = null; nyMemo = null;
    applyOn();
    const wrap = el('custWrap');
    if (!wrap) return;
    if (!isOn()) { wrap.innerHTML = ''; renderOff(); return; }
    renderOff();
    // A customer's page is a window of its own that can be open over any tab.
    if (!panelShown()) { dirty = true; if (openId) renderPage(); return; }
    if (quiet === true && inForm()) { pendingQuiet = true; return; }
    pendingQuiet = false;
    dirty = false; drawnDay = today();
    if (!loaded) { wrap.innerHTML = '<p class="empty-msg">Loading the customer list…</p>'; return; }
    if (!Object.values(customers).some(isQb)) {
      wrap.innerHTML = '<p class="empty-msg">Waiting for the first read of your customers from QuickBooks — it happens at the next hourly look. ' +
        'Your Contacts list is below until then.</p>';
      return;
    }
    // Something being typed (a note) keeps its place -- where its caret was.
    const act = document.activeElement;
    const typing = act && wrap.contains(act) ? act.id : null;
    let caret = null;
    try { if (typing) caret = [act.selectionStart, act.selectionEnd]; } catch (e) { /* not a text box */ }
    if (!el('custList')) {
      wrap.innerHTML = '<div id="custViews"></div><div id="custFind"></div><div id="custTags"></div><div id="custList"></div>';
      findSig = '';
    }
    const l = peopleLists(), people = l.people, callable = l.callable;
    const ch = can('contacts', 'change');
    const counts = { call: 0, nextyear: nyCount(), everyone: 0, customers: 0, leads: 0, past: 0, snow: 0, sort: sortCount(), check: 0 };
    let snowAny = 0;
    people.forEach(c => {
      const k = kindOf(c);
      if (k === 'lead') counts.leads++; else if (k === 'past') counts.past++; else counts.customers++;
    });
    // The chip counts everyone on the Call list (Jonah, 16 Oct 2026: "a full
    // list of people im calling for next season") -- due now, coming up and
    // no time set yet, as the list itself does; the tab's badge stays the ones
    // due now.
    let onCallList = 0;
    callable.forEach(c => {
      const st = callState(c);
      if (st.on) counts.call++;
      if (!c.notInterested && (st.on || st.soon || (st.none && wantsCall(c)))) onCallList++;
      const f = snowFacts(c);
      if (f && f.onList) { snowAny++; if (!snowCalled(c)) counts.snow++; }
    });
    counts.everyone = people.length + otherContacts().length;
    // Only the Check view needs the lines themselves; the button needs the
    // count of the ones that add up (worked out once, see counted()).
    counts.check = ch ? checkCount() : 0;
    const badge = el('custBadge');
    if (badge) badge.textContent = counts.call ? counts.call + ' to call' : '';
    const VIEWS = [['call', '📞 Call list'], ['nextyear', '📆 Contact in ' + nyYear()], ['everyone', '📇 Everyone'], ['customers', '👥 Customers'], ['leads', '🌱 Leads'], ['past', '🕰 Past']]
      .concat(snowAny ? [['snow', '❄️ Snow quotes']] : [])
      .concat(ch && counts.sort ? [['sort', '🧩 To sort']] : [])
      .concat(ch ? [['check', '🔍 Check the list']] : []);
    if (!VIEWS.some(v => v[0] === view)) view = 'call';
    el('custViews').innerHTML = '<div class="cu-views">' + VIEWS.map(([k, label]) =>
      '<button class="cu-view' + (view === k ? ' on' : '') + '" onclick="custView(\'' + k + '\')">' + label +
      '<span class="cu-n">' + (k === 'call' ? onCallList : counts[k]) + '</span></button>').join('') + '</div>';
    // The search row is left alone while it reads the same -- the text typed
    // in it is `searchText`, put back when the row has to be built again.
    const wantFind = view !== 'sort' && view !== 'check';
    const findHtml = !wantFind ? '' : '<div class="cu-find"><input id="custSearch" type="search" placeholder="' +
      (view === 'everyone' ? 'Search everyone — name, phone, email, street…' : 'Search name, phone, street, note…') +
      '" oninput="custSearchSoon()">' +
      (view !== 'everyone' ? '<button class="btn btn-sm cu-tagbtn' + (tagPick ? ' on' : '') + '" onclick="custTagsOpen()">' +
        (tagPick ? 'What for: ' + esc(tagPick) : 'What for: any') + ' ' + (tagsOpen ? '▴' : '▾') + '</button>' : '') +
      (ch ? '<button class="btn btn-sm btn-filled" onclick="custAddLead()">+ Add a lead</button>' : '') + '</div>';
    if (findHtml !== findSig || (wantFind && !el('custSearch'))) {
      el('custFind').innerHTML = findHtml;
      findSig = findHtml;
      const box = el('custSearch');
      if (box) box.value = searchText;
    }
    el('custTags').innerHTML = wantFind && tagsOpen && view !== 'everyone' ? tagFilterHtml(view === 'call' || view === 'snow' ? callable
      : view === 'nextyear' ? nyRows().filter(r => r.state === 'on' || r.state === 'chasing').map(r => ({ tags: r.services })) : people) : '';
    paintList(listBodyHtml(people, callable, view === 'check' ? checkLines() : []));
    // A box that was rebuilt gets its focus and caret back.
    const back = typing && el(typing);
    if (back && document.activeElement !== back) {
      back.focus();
      try { if (caret && caret[0] != null) back.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text box */ }
    }
    if (openId) renderPage();
  }

  // ---- the "What for" filter: the services in use, as buttons in sight
  function tagFilterHtml(list) {
    const n = {};
    list.forEach(c => (c.tags || []).forEach(t => { n[t] = (n[t] || 0) + 1; }));
    const tags = Object.keys(n).sort((a, b) => a.localeCompare(b));
    if (!tags.length) return '<div class="cu-tagfilter muted">Nobody here has a service picked yet — add them on each one’s page, under “What for”.</div>';
    return '<div class="cu-tagfilter">' +
      '<button class="cu-chip' + (!tagPick ? ' on' : '') + '" onclick="custTagFilter(\'\')">Any</button>' +
      tags.map(t => '<button class="cu-chip' + (t === tagPick ? ' on' : '') + '" data-t="' + esc(t) + '" onclick="custTagFilter(this.dataset.t)">' +
        esc(t) + '<small>' + n[t] + '</small></button>').join('') + '</div>';
  }
  window.custTagsOpen = function () { tagsOpen = !tagsOpen; render(); };
  window.custTagFilter = function (t) { tagPick = s(t); tagsOpen = false; showN = SHOW_STEP; render(); };

  // The name a row shows: a sub-customer with its parent's ("Parent › Job").
  function shownName(c) {
    if (isFolded(c)) return s(c.qbFullName).replace(/:/g, ' › ') || (parentOf(c).name + ' › ' + s(c.name));
    return s(c.name) || '(no name)';
  }
  function matches(c, q, tag) {
    if (tag && (c.tags || []).indexOf(tag) === -1) return false;
    if (!q) return true;
    // A main one is found by what is written on the ones shown with it too
    // (a sub-customer's street, a second profile's phone).
    const recs = [c].concat(family(c.id).map(id => customers[id]).filter(Boolean));
    const hay = recs.map(x => [x.name, x.qbFullName, x.business, x.firstName, x.lastName, x.phone, x.mobile, x.email, x.address,
      x.ship && x.ship.address, x.note, x.contactWhen, (x.tags || []).join(' '), (x.meetings || []).map(m => m.text).join(' ')].join(' ')).join(' ').toLowerCase();
    const qd = q.replace(/\D/g, '');
    return hay.indexOf(q) !== -1 || (qd.length >= 4 && recs.some(x => digits(x.phone).indexOf(qd) !== -1 || digits(x.mobile).indexOf(qd) !== -1));
  }
  const byName = (a, b) => s(a.name).localeCompare(s(b.name));

  // The Call list: everyone he is calling, not only the ones due today.
  //   Call now      -- their time has come and nobody has reached them since.
  //   Coming up     -- the rest with a time to call, a heading for each month
  //                    or season, soonest first ("next season" at a glance).
  //   No time yet   -- leads, and customers he picked a service for or wrote
  //                    about, with no time to call: a tap sets one.
  //   Reached, Not interested -- folded at the bottom.
  // A past customer with nothing on them is not on it (some five hundred).
  function wantsCall(c) {
    return kindOf(c) === 'lead' || (c.tags || []).length > 0 || !!s(c.note) || (c.meetings || []).length > 0 || (c.declined || []).length > 0;
  }
  function callHtml(all, q, tag) {
    const list = all.filter(c => matches(c, q, tag));
    const due = [], soon = [], noTime = [], reached = [], notInt = [];
    list.forEach(c => {
      if (c.notInterested) { if (wantsCall(c) || windowOf(c)) notInt.push(c); return; }
      const st = callState(c);
      if (st.on) due.push([c, st.w]);
      else if (st.soon) soon.push([c, st.w]);
      else if (st.done) reached.push([c, st.w]);
      else if (st.none && wantsCall(c)) noTime.push(c);
    });
    const byWhen = (a, b) => a[1].from.localeCompare(b[1].from) || a[1].to.localeCompare(b[1].to) || byName(a[0], b[0]);
    due.sort(byWhen); soon.sort(byWhen);
    let h = '<div class="cu-callsum">' + [due.length + ' to call now', soon.length + ' coming up', noTime.length + ' with no time set yet']
      .join(' · ') + '</div>';
    h += '<div class="cu-sub">📞 Call now (' + due.length + ')</div>';
    h += due.length ? due.slice(0, showN).map(([c, w]) => rowHtml(c, w, 'due')).join('') + more(due.length)
      : '<p class="empty-msg">Nobody’s time to call has come' + (q || tag ? ' among these' : '') + '. 🎉</p>';
    if (soon.length) {
      h += '<div class="cu-sub">📅 Coming up (' + soon.length + ')</div>';
      let last = null, shown = 0;
      soon.forEach(([c, w]) => {
        if (shown >= showN) return;
        const g = whenGroup(w);
        if (!last || last.key !== g.key) {
          const n = soon.filter(x => whenGroup(x[1]).key === g.key).length;
          h += '<div class="cu-when-h">' + esc(g.title) + ' <span class="muted">(' + n + ')</span></div>';
          last = g;
        }
        h += rowHtml(c, w, 'soon');
        shown++;
      });
      h += more(soon.length);
    }
    if (noTime.length) h += '<details class="cu-fold"' + (noTime.length <= 12 ? ' open' : '') + '><summary>🕳 No time to call set yet (' + noTime.length + ')</summary>' +
      '<div class="hint">Leads, and customers with a service picked or a note — tap “Set when” to put them on the list.</div>' +
      noTime.sort(byName).slice(0, showN).map(c => rowHtml(c, null, 'none')).join('') + more(noTime.length) + '</details>';
    if (reached.length) h += '<details class="cu-fold"><summary>✓ Reached this time round (' + reached.length + ')</summary>' +
      reached.sort(byWhen).map(([c, w]) => rowHtml(c, w, 'done')).join('') + '</details>';
    if (notInt.length) h += '<details class="cu-fold"><summary>✋ Not interested (' + notInt.length + ')</summary>' +
      notInt.sort(byName).map(c => rowHtml(c, windowOf(c), 'no')).join('') + '</details>';
    return h;
  }
  // The heading a time to call goes under: its season or month when it is
  // one ("Spring 2027", "March 2027"), a whole year, else the month it
  // starts in.
  function whenGroup(w) {
    const a = w.from, b = w.to;
    const y = +a.slice(0, 4), ma = +a.slice(5, 7), mb = +b.slice(5, 7);
    const wholeFrom = a.slice(8) === '01', wholeTo = b === lastDay(+b.slice(0, 4), mb);
    if (wholeFrom && wholeTo) {
      if (a.slice(0, 7) === b.slice(0, 7)) return { key: a.slice(0, 7), title: MONTH_WORDS[ma - 1] + ' ' + y };
      const sea = SEASON_BTNS.find(x => x[2] === ma && x[3] === mb);
      if (sea) return { key: 'S' + a + b, title: sea[1] + ' ' + (ma > mb ? y + '–' + String(y + 1).slice(2) : y) };
      if (ma === 1 && mb === 12 && b.slice(0, 4) === a.slice(0, 4)) return { key: 'Y' + y, title: 'Some time in ' + y };
    }
    return { key: 'F' + a.slice(0, 7), title: 'Starting in ' + MONTH_WORDS[ma - 1] + ' ' + y };
  }
  function listHtml(list, q, tag) {
    list = list.filter(c => matches(c, q, tag)).sort(byName);
    if (!list.length) return '<p class="empty-msg">' + (q || tag ? 'Nobody matches that.' : 'Nobody here yet.') + '</p>';
    return list.slice(0, showN).map(c => rowHtml(c, windowOf(c), '')).join('') + more(list.length);
  }
  // The Snow quotes list (snowFacts): this season's first, then last
  // season's; the ones called this season folded at the bottom.
  function snowHtml(all, q, tag) {
    const cur = snowSeasonOf(today());
    const list = all.filter(c => matches(c, q, tag)).map(c => [c, snowFacts(c)]).filter(x => x[1] && x[1].onList)
      .sort((a, b) => s(b[1].quotes[0].date).localeCompare(s(a[1].quotes[0].date)) || byName(a[0], b[0]));
    const open = list.filter(x => !snowCalled(x[0])), called = list.filter(x => snowCalled(x[0]));
    let h = '<div class="hint">Quoted for snow in ' + esc(seasonWord(cur)) + ' or ' + esc(seasonWord(cur - 1)) +
      ' and didn’t take it — turned down or never answered — with no Snow account here. From the Snow Removal products on their estimates.</div>';
    if (!list.length) return h + '<p class="empty-msg">' + (q || tag ? 'Nobody matches that.' : 'Nobody — every snow quote was taken. ❄️') + '</p>';
    [[cur, 'Quoted for ' + seasonWord(cur)], [cur - 1, 'Quoted for ' + seasonWord(cur - 1) + ' (last winter)']].forEach(([y, title]) => {
      const rows = open.filter(x => x[1].season === y);
      if (rows.length) h += '<div class="cu-sub">' + esc(title) + ' (' + rows.length + ')</div>' + rows.slice(0, showN).map(([c, f]) => snowRowHtml(c, f, false)).join('') + more(rows.length);
    });
    if (!open.length) h += '<p class="empty-msg">Everyone on it has been called this season. 🎉</p>';
    if (called.length) h += '<details class="cu-fold"><summary>Called about snow this season (' + called.length + ')</summary>' +
      called.map(([c, f]) => snowRowHtml(c, f, true)).join('') + '</details>';
    return h;
  }
  function snowRowHtml(c, f, called) {
    const k = kindOf(c), id = sid(c.id), phone = c.phone || c.mobile;
    return '<div class="cu-row">' +
      '<div class="cu-main">' +
        '<button class="cu-name" onclick="openCustomer(\'' + id + '\')">' + esc(shownName(c)) + '</button>' +
        (k !== 'customer' ? ' <span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span>' : '') +
        '<div class="cu-quotes">' + f.quotes.map(q => '<div>❄️ ' + quoteLine(q) + '</div>').join('') + '</div>' +
        '<div class="pp-contact">' + [c.address ? esc(c.address) : '',
          phone ? '<a href="tel:' + esc(telOf(phone)) + '">📞 ' + esc(phone) + '</a>' : ''].filter(Boolean).join(' &middot; ') + '</div>' +
      '</div>' +
      (can('contacts', 'change') ? '<div class="cu-act">' + (called
        ? '<span class="pp-out-did">✓ Called ' + esc(niceDay(localDay(c.snowCalledAt))) + '</span> <button class="btn btn-sm" onclick="custSnowCalled(\'' + id + '\', false)">Not yet</button>'
        : '<button class="btn btn-sm btn-filled" onclick="custSnowCalled(\'' + id + '\', true)">✓ Called about snow</button>') + '</div>' : '') +
    '</div>';
  }
  // ------------------------------------------------------------ contact next year
  //
  // Jonah (26 Oct 2026): "add all clients bid this year that didnt decline or
  // accept to call next year. have spot in customers thats just a list of
  // people to contact next year. note the service they were bid for."
  //
  // Worked out from the bids each time it is drawn -- nothing is written on
  // anyone until he taps. On it: everyone bid in the year whose bid neither
  // said yes (won, booked, accepted in QuickBooks) nor no (lost, turned down
  // in QuickBooks): sent with no answer -- and bids he marked lost for "No
  // reply", who never said no either. Snow bids too, marked snow. A bid still
  // inside its follow-up plan (boards.js CHASE_STEPS) sits under a heading
  // of its own until the plan has run its course: its emails are still going
  // out. A bid never sent got no price, so it is not on it (listed folded,
  // to put on by hand).
  //
  // One row a person: their bids are found by customer, the way everything
  // here is tied (a lead merged in, a second QuickBooks profile and a
  // sub-customer are them); a bid tied to nobody by the customer it surely
  // is (same email, phone or exact name -- as To sort says), else on its own.
  //
  // Which year: the bids of the season gone by, to call in the next one --
  // from July, this year's bids (called next year); before July, last
  // year's (the year he is calling them in). Buttons pick another year.
  // By hand, kept on the person per year they are called in (contactYears
  // {"2027": {on, at, by, doneAt, reachedWas}}): on false -- taken off the
  // list; on true -- put on it by hand; doneAt -- "Reached out" tapped here
  // (reachedWas: the reach before it). Reached in that year itself, from
  // anywhere (reachedAt), counts as reached too.
  const NY_FROM_MONTH = 7;
  const NY_SORT_KEY = 'ydjobhub_custNySort';
  let nySort = 'service';         // 'service' | 'date'
  try { nySort = localStorage.getItem(NY_SORT_KEY) === 'date' ? 'date' : 'service'; } catch (e) { /* private window */ }
  let nyPick = 0;                 // a bid year picked on its buttons (0: the usual one)
  let nyFinding = null;           // "+ Put someone on it": what is typed (null: closed)
  let nyMemo = null;
  function nyUsual() {
    const d = new Date();
    return d.getMonth() + 1 >= NY_FROM_MONTH ? d.getFullYear() : d.getFullYear() - 1;
  }
  const nyBidYear = () => nyPick || nyUsual();
  const nyYear = () => nyBidYear() + 1;                   // the year they are called in
  // A QuickBooks estimate in Intuit's test company is none a customer saw.
  const realQb = j => (j.qbEstimate && j.qbEstimate.env !== 'sandbox' ? j.qbEstimate : {});
  // What the customer said to a bid: 'yes', 'no', 'noReply' (marked lost,
  // "No reply"), 'open' (sent, no answer) or 'unsent' (it never went out).
  function bidAnswer(j) {
    if (j.removeWhy === 'snow') return 'yes';               // a snow bid said yes to: on the Snow route
    const bid = typeof isBidStatus === 'function' ? isBidStatus(j.jobStatus) : (j.jobStatus || 'quoting') === 'quoting';
    if (!bid || j.bidStage === 'won') return 'yes';
    const q = realQb(j), sync = window.YDSync || {};
    if (sync.qbAccepted ? sync.qbAccepted(q) : q.status === 'Accepted') return 'yes';
    if (j.bidStage === 'lost') return j.lostReason === 'noReply' ? 'noReply' : 'no';
    if (q.status === 'Rejected') return 'no';
    const sent = j.bidStage === 'sent' || j.bidStage === 'followUp' || !!q.sentAt || !!(q.deleted && q.deleted.sentAt);
    return sent ? 'open' : 'unsent';
  }
  // The day of the bid: its Bid date, else the day it was emailed or moved.
  function bidDay(j) {
    const q = realQb(j);
    return localDay(j.quoteDate) || localDay(q.sentAt) || localDay(j.bidStageAt) || localDay(j.lastModified);
  }
  // The person a bid is for, as the lists show them ('' for nobody here).
  // A bid untied by hand ("Not theirs") is never tied again by itself.
  function nyPersonOf(j, by) {
    let id = j.customerId ? resolve(s(j.customerId)) : '';
    if (!customers[id]) {
      const lead = resolve('ld' + s(j._id).toLowerCase().replace(/[^a-z0-9]/g, ''));      // newLeadFromJob's
      id = customers[lead] ? lead : '';
    }
    if (!id && !(j.customerBy === 'hand' && !j.customerId)) {
      const g = guess(by(), whoOfJob(j));
      if (g.sure && customers[resolve(g.sure)]) id = resolve(g.sure);
    }
    if (!id) return '';
    id = mainOf(id);
    const c = customers[id];
    return c && isFolded(c) ? parentOf(c).id : id;
  }
  // A bid tied to nobody: one row with any other bid of the same email,
  // phone or name.
  const looseKey = j => 'j_' + (low(j.email) || (digits(j.phone).length === 10 ? digits(j.phone) : '') ||
    low(j.customerName) || s(j._id)).replace(/[^a-z0-9]/g, '');
  // His picks for a year: on the person and on the ones shown with them;
  // the newest on / off wins.
  function nyPickFor(c, Y) {
    const out = {};
    [c].concat(family(c.id).map(id => customers[id]).filter(Boolean)).forEach(x => {
      const p = (x.contactYears || {})[Y];
      if (!p || typeof p !== 'object') return;
      if (typeof p.on === 'boolean' && s(p.at) >= s(out.at)) { out.on = p.on; out.at = p.at; }
      if (s(p.doneAt) > s(out.doneAt)) out.doneAt = p.doneAt;
    });
    return out;
  }
  const nySnow = j => !!(window.YDEstimate && YDEstimate.isSnowJob && YDEstimate.isSnowJob(j));
  const nyChase = j => (window.YDBoards && YDBoards.chaseState ? YDBoards.chaseState(j) : null);

  function nyRows() {
    const B = nyBidYear(), Y = String(B + 1), day = today();
    const jobsRef = allJobs();
    if (nyMemo && nyMemo.ver === ver && nyMemo.jobs === jobsRef && nyMemo.B === B && nyMemo.day === day) return nyMemo.rows;
    let idx = null;
    const by = () => idx || (idx = index());
    const rows = {}, yes = {};
    const rowOf = (key, c) => rows[key] || (rows[key] = { key: key, c: c || null, open: [], unsent: [] });
    jobsRef.forEach(j => {
      if (!j || !j._id || j.deletedAt || (j.removeWhy && j.removeWhy !== 'snow')) return;
      const d = bidDay(j);
      if (d.slice(0, 4) !== String(B)) return;
      const a = bidAnswer(j);
      if (a === 'no') return;
      const pid = nyPersonOf(j, by), key = pid || looseKey(j);
      if (a === 'yes') { yes[key] = (yes[key] || 0) + 1; return; }
      const r = rowOf(key, pid ? customers[pid] : null);
      if (a === 'unsent') r.unsent.push(j);
      else r.open.push({ j: j, answer: a, day: d, snow: nySnow(j), chase: a === 'open' ? nyChase(j) : null });
    });
    // Put on it by hand.
    Object.values(customers).forEach(c => {
      const p = (c.contactYears || {})[Y];
      if (!p || p.on !== true) return;
      let id = mainOf(c.id);
      const m = customers[id];
      if (m && isFolded(m)) id = parentOf(m).id;
      if (customers[id]) rowOf(id, customers[id]);
    });
    const yearFrom = Y + '-01-01';
    const out = Object.values(rows).map(r => {
      const c = r.c;
      r.pick = c ? nyPickFor(c, Y) : {};
      r.hand = r.pick.on === true;
      r.yes = yes[r.key] || 0;
      r.open.sort((a, b) => b.day.localeCompare(a.day));
      r.unsent.sort((a, b) => bidDay(b).localeCompare(bidDay(a)));
      // The services they were bid for (their newest bid's first); a bid
      // with none picked says what its estimate is for; someone put on by
      // hand, what they are tagged for.
      const svc = [];
      const add = t => { t = s(t); if (t && !svc.some(x => low(x) === low(t))) svc.push(t); };
      r.open.forEach(b => (b.j.serviceTypes || []).forEach(add));
      r.open.forEach(b => { if (!(b.j.serviceTypes || []).length && typeof jobWhat === 'function') add(jobWhat(b.j)); });
      if (!r.open.length) {
        if (c) (c.tags || []).forEach(add);
        r.unsent.forEach(j => (j.serviceTypes || []).forEach(add));
      }
      r.services = svc;
      r.snow = r.open.some(b => b.snow);
      r.chasing = r.open.some(b => b.chase && b.chase.on);
      r.lastDay = r.open.length ? r.open[0].day : '';
      r.reached = !c ? '' : s(r.pick.doneAt) || (localDay(c.reachedAt) >= yearFrom ? s(c.reachedAt) : '');
      r.state = r.pick.on === false ? 'off' : c && c.notInterested ? 'no' : r.reached ? 'done'
        : !r.open.length && !r.hand ? 'unsent' : r.chasing ? 'chasing' : 'on';
      return r;
    });
    nyMemo = { ver: ver, jobs: jobsRef, B: B, day: day, rows: out };
    return out;
  }
  // The ones to call (the count on its button): on it, chased or not.
  const nyCount = () => nyRows().filter(r => r.state === 'on' || r.state === 'chasing').length;
  function nyMatches(r, q, tag) {
    if (tag && !r.services.concat(r.c ? r.c.tags || [] : []).some(t => low(t) === low(tag))) return false;
    if (!q) return true;
    if (r.c && matches(r.c, q, '')) return true;
    const jobs = r.open.map(b => b.j).concat(r.unsent);
    const hay = jobs.map(j => [j.customerName, j.phone, j.email, j.address, j.city, j.estimateNumber].join(' ')).join(' ') + ' ' + r.services.join(' ');
    return low(hay).indexOf(q) !== -1;
  }
  function nyName(r) {
    if (r.c) return shownName(r.c);
    const j = (r.open[0] || {}).j || r.unsent[0] || {};
    return s(j.customerName) || '(no name)';
  }
  // A bid's price, for whoever sees Billing: a snow bid's is per push.
  function nyPrice(j) {
    if (!can('billing', 'see')) return '';
    if (nySnow(j)) return typeof perPushText === 'function' ? perPushText(j) : '';
    const n = parseFloat(String(j.jobPrice || '').replace(/[$,]/g, ''));
    return n > 0 ? money(n) : '';
  }
  // The season to call them in, for one tap: spring -- fall for snow -- of
  // the year they are called in, while it has not ended.
  function nySeason(r) {
    const Y = nyYear(), b0 = SEASON_BTNS.find(x => x[0] === (r.snow ? 'fall' : 'spring'));
    const w = { from: Y + '-' + two(b0[2]) + '-01', to: lastDay(Y, b0[3]), label: b0[1] + ' ' + Y, how: 'season' };
    return w.to >= today() ? w : null;
  }

  function nyHtml(q, tag) {
    const Y = nyYear(), B = nyBidYear(), ch = can('contacts', 'change');
    const groups = { on: [], chasing: [], done: [], no: [], off: [], unsent: [] };
    nyRows().filter(r => nyMatches(r, q, tag)).forEach(r => groups[r.state].push(r));
    let h = '';
    if (can('jobs', 'see')) {
      const ys = [];
      for (let y = nyUsual() - 1; y <= new Date().getFullYear(); y++) ys.push(y);
      h += '<div class="cu-ny-pick">' + ys.map(y => '<button class="cu-chip' + (y === B ? ' on' : '') + '" onclick="custNyYear(' + y + ')">Bid in ' + y +
        '<small>called in ' + (y + 1) + '</small></button>').join('') + '</div>';
      h += '<div class="hint">Everyone bid in ' + B + ' who hasn’t said yes or no — sent with no answer, or marked lost for “No reply”. ' +
        'Snow bids too. Nothing is saved on anyone until you tap a button.</div>';
    } else {
      h += '<div class="hint">The bids show for whoever sees Jobs. Here: the ones put on it by hand.</div>';
    }
    const n = groups.on.length + groups.chasing.length;
    h += '<div class="cu-callsum">' + [n + ' to call in ' + Y, groups.chasing.length ? groups.chasing.length + ' of them still being followed up' : '',
      groups.done.length ? groups.done.length + ' reached' : ''].filter(Boolean).join(' · ') + '</div>';
    if (ch) h += nyAddHtml();
    h += '<div class="cu-ny-pick cu-ny-sort">' + [['service', 'By service'], ['date', 'By bid date']].map(([k, w]) =>
      '<button class="cu-chip' + (nySort === k ? ' on' : '') + '" onclick="custNySort(\'' + k + '\')">' + w + '</button>').join('') + '</div>';
    h += '<div class="cu-sub">📆 To call in ' + Y + ' (' + groups.on.length + ')</div>';
    if (!groups.on.length) {
      h += '<p class="empty-msg">' + (q || tag ? 'Nobody matches that.' : groups.chasing.length
        ? 'Everyone is still in their follow-up plan — they come here when it ends.' : 'Nobody — every bid of ' + B + ' got an answer.') + '</p>';
    } else {
      // By service: under the first one they were bid for (the "What for"
      // button finds them by any). By bid date: oldest first, a month a heading.
      // (The ones with no bid date / no service last.)
      const head = nySort === 'date'
        ? r => (r.lastDay ? { key: r.lastDay.slice(0, 7), title: 'Bid in ' + MONTH_WORDS[+r.lastDay.slice(5, 7) - 1] + ' ' + r.lastDay.slice(0, 4) } : { key: '', last: 1, title: 'Put on by hand' })
        : r => (r.services[0] ? { key: low(r.services[0]), title: r.services[0] } : { key: '', last: 1, title: 'Service not noted' });
      const rows = groups.on.map(r => [head(r), r]).sort((a, b) => (a[0].last || 0) - (b[0].last || 0) || a[0].key.localeCompare(b[0].key) ||
        (nySort === 'date' ? a[1].lastDay.localeCompare(b[1].lastDay) : 0) || nyName(a[1]).localeCompare(nyName(b[1])));
      let last = null, shown = 0;
      rows.forEach(([g, r]) => {
        if (shown >= showN) return;
        if (last !== g.key) {
          h += '<div class="cu-when-h">' + esc(g.title) + ' <span class="muted">(' + rows.filter(x => x[0].key === g.key).length + ')</span></div>';
          last = g.key;
        }
        h += nyRowHtml(r);
        shown++;
      });
      h += more(rows.length);
    }
    if (groups.chasing.length) {
      h += '<div class="cu-sub">📨 Still being followed up (' + groups.chasing.length + ')</div>' +
        '<div class="hint">Their follow-up emails are still going out. Each comes up to the list above by itself when its plan ends.</div>' +
        groups.chasing.sort((a, b) => a.lastDay.localeCompare(b.lastDay) || nyName(a).localeCompare(nyName(b))).slice(0, showN).map(nyRowHtml).join('') + more(groups.chasing.length);
    }
    const fold = (rows, title, sortBy) => (rows.length ? '<details class="cu-fold"><summary>' + title + ' (' + rows.length + ')</summary>' +
      rows.sort(sortBy || ((a, b) => nyName(a).localeCompare(nyName(b)))).map(nyRowHtml).join('') + '</details>' : '');
    h += fold(groups.done, '✓ Reached', (a, b) => s(b.reached).localeCompare(s(a.reached)));
    h += fold(groups.no, '✋ Not interested');
    h += fold(groups.off, 'Taken off the list');
    if (groups.unsent.length) {
      h += '<details class="cu-fold"><summary>Bid never sent — no price went to them (' + groups.unsent.length + ')</summary>' +
        '<div class="hint">Site visits and bids of ' + B + ' that never went out. Put one on the list if you want to call them.</div>' +
        groups.unsent.sort((a, b) => nyName(a).localeCompare(nyName(b))).map(nyRowHtml).join('') + '</details>';
    }
    return h;
  }

  function nyRowHtml(r) {
    const c = r.c, k = sid(r.key), ch = can('contacts', 'change');
    const j0 = (r.open[0] || {}).j || r.unsent[0] || {};
    const kind = c ? kindOf(c) : '';
    const phone = (c && (s(c.phone) || s(c.mobile))) || s(j0.phone);
    const email = (c && s(c.email)) || s(j0.email);
    const addr = (c && s(c.address)) || [s(j0.address), s(j0.city)].filter(Boolean).join(', ');
    const tel = telOf(phone);
    // Their time to call, when it is now or still to come (the Call list).
    const cs = c ? callState(c) : {};
    const w = cs.on || cs.soon ? cs.w : null;
    const open = c ?'openCustomer(\'' + sid(c.id) + '\')' : 'custOpenJob(\'' + sid(j0._id) + '\')';
    const many = r.open.length > 1;
    const bidLine = b => {
      const j = b.j, num = s(j.estimateNumber) || s(realQb(j).docNumber), price = nyPrice(j);
      const st = b.answer === 'noReply' ? 'Marked lost — no reply'
        : b.chase && b.chase.on ? 'Being followed up — day ' + b.chase.day + ' of ' + b.chase.last : 'No answer';
      const heard = b.chase && b.chase.heard ? ' · 💬 wrote back ' + niceDay(localDay(b.chase.heard)) : '';
      const svc = (j.serviceTypes || []).join(', ');
      return '<div class="cu-ny-bid"><button class="link-btn" onclick="custOpenJob(\'' + sid(j._id) + '\')">' + (num ? 'Bid #' + esc(num) : 'The bid') + '</button>' +
        ' · ' + esc(niceDay(b.day)) + (price ? ' · <span class="cu-money">' + esc(price) + '</span>' : '') +
        ' · <span class="muted">' + esc(st + heard) + '</span>' + (many && svc ? ' <span class="muted">— ' + esc(svc) + '</span>' : '') + '</div>';
    };
    const btn = (label, fn, arg, filled) => '<button class="btn btn-sm' + (filled ? ' btn-filled' : '') + '" onclick="' + fn + '(\'' + k + '\'' +
      (arg === undefined ? '' : ', ' + arg) + ')">' + label + '</button>';
    let act = '';
    if (ch) {
      if (r.state === 'on' || r.state === 'chasing') {
        const sea = !w ? nySeason(r) : null;
        act = btn('✓ Reached out', 'custNyDone', true, true) + (sea ? btn('📅 ' + esc(sea.label), 'custNyWhen') : '') +
          btn('Not interested', 'custNyNot', true) + btn('Take off', 'custNyOff', true);
      } else if (r.state === 'done') {
        act = r.pick.doneAt ? btn('Not reached yet', 'custNyDone', false) : '';
      } else if (r.state === 'no') act = btn('Interested after all', 'custNyNot', false);
      else if (r.state === 'off') act = btn('Put back on', 'custNyOff', false);
      else if (r.state === 'unsent') act = btn('+ Put on the list', 'custNyOn');
    }
    const said = r.state === 'done' ? '✓ Reached ' + niceDay(localDay(r.reached))
      : r.state === 'off' && r.pick.at ? 'Taken off ' + niceDay(localDay(r.pick.at)) : '';
    return '<div class="cu-row">' +
      '<div class="cu-main">' +
        '<button class="cu-name" onclick="' + open + '">' + esc(nyName(r)) + '</button>' +
        (c && kind !== 'customer' ? ' <span class="cu-kind k-' + kind + '">' + KIND_WORD[kind] + '</span>' : '') +
        (!c ? ' <span class="cu-kind">Not tied to a customer</span>' : '') +
        (r.snow ? ' <span class="cu-kind k-snow">❄️ Snow</span>' : '') +
        (r.hand && !r.open.length ? ' <span class="cu-kind">Put on by hand</span>' : '') +
        (w ? ' <span class="pp-when">' + (cs.on ? '📞 Call list now' : '📅 ' + esc(whenText(w))) + '</span>' : '') +
        (r.services.length ? '<div class="pp-svc">' + r.services.map(t => '<span class="svc-tag">' + esc(t) + '</span>').join('') + '</div>'
          : '<div class="cu-ny-also">No service noted on the bid</div>') +
        r.open.map(bidLine).join('') +
        (!r.open.length ? r.unsent.map(j => '<div class="cu-ny-bid"><button class="link-btn" onclick="custOpenJob(\'' + sid(j._id) + '\')">' +
          (s(j.estimateNumber) ? 'Bid #' + esc(j.estimateNumber) : 'The bid') + '</button> · ' + esc(niceDay(bidDay(j))) + ' · <span class="muted">never sent</span></div>').join('') : '') +
        (r.yes ? '<div class="cu-ny-also">Said yes to ' + (r.yes === 1 ? 'another bid' : r.yes + ' other bids') + ' in ' + nyBidYear() + '</div>' : '') +
        (said ? '<div class="cu-ny-also">' + esc(said) + '</div>' : '') +
        (addr ? '<div class="pp-contact">' + esc(addr) + '</div>' : '') +
        (act ? '<div class="cu-ny-act">' + act + '</div>' : '') +
      '</div>' +
      '<div class="cu-reach">' +
        (tel ? '<a class="btn btn-sm" href="tel:' + esc(tel) + '" title="' + esc(phone) + '">📞 Call</a><a class="btn btn-sm" href="sms:' + esc(tel) + '">💬 Text</a>' : '') +
        (email ? '<a class="btn btn-sm" href="mailto:' + esc(email) + '" title="' + esc(email) + '">✉️ Email</a>' : '') +
        (!tel && !email ? '<span class="muted cu-noway">No phone or email</span>' : '') +
      '</div>' +
    '</div>';
  }

  // ---- putting someone on it by hand: found by name, phone, email or street
  function nyAddHtml() {
    if (nyFinding === null) {
      return '<div class="cu-btns"><button class="btn btn-sm" onclick="custNyFindOpen(true)">+ Put someone on it by hand</button></div>';
    }
    return '<div class="cu-add"><div class="cu-fill-h"><b>Put someone on the list for ' + nyYear() + '</b>' +
      '<button class="link-btn" onclick="custNyFindOpen(false)">Close</button></div>' +
      '<input id="cuNyFind" type="search" autocomplete="off" placeholder="Type a name, phone, email or street…" value="' + esc(nyFinding) +
      '" oninput="custNyFind(this.value)">' +
      '<div class="cu-picks" id="cuNyFound">' + nyFoundHtml() + '</div></div>';
  }
  function nyFoundHtml() {
    const q = low(nyFinding);
    if (q.length < 2) return '';
    const on = {};
    nyRows().forEach(r => { if (r.c && (r.state === 'on' || r.state === 'chasing')) on[r.c.id] = true; });
    const hits = Object.values(customers).filter(c => inLists(c) && matches(c, q, '')).sort(byName).slice(0, 8);
    if (!hits.length) return '<span class="muted">Nobody by that — add them as a lead first (Leads → + Add a lead).</span>';
    return hits.map(c => '<button class="cu-chip" onclick="custNyOn(\'' + sid(c.id) + '\')"' + (on[c.id] ? ' disabled' : '') + '>' +
      esc(shownName(c)) + '<small>' + esc(on[c.id] ? 'on the list already' : (c.address ? c.address.split(',')[0] : (c.phone || c.mobile || KIND_WORD[kindOf(c)]))) +
      '</small></button>').join('');
  }
  window.custNyFindOpen = function (on) {
    nyFinding = on ? '' : null;
    render();
    const n = on && el('cuNyFind');
    if (n) n.focus();
  };
  window.custNyFind = function (v) {
    nyFinding = v;
    const box = el('cuNyFound');
    if (box) box.innerHTML = nyFoundHtml();
  };
  window.custNyYear = function (y) { nyPick = +y === nyUsual() ? 0 : +y; showN = SHOW_STEP; nyMemo = null; render(); };
  window.custNySort = function (v) {
    nySort = v === 'date' ? 'date' : 'service';
    try { localStorage.setItem(NY_SORT_KEY, nySort); } catch (e) { /* private window */ }
    render();
  };

  // The person a row's button acts on. A row tied to nobody is tied first,
  // as a turned-down bid is (fromLostBid): the customer it surely is was
  // taken already, so a lead is made from the bid and its bids tied to it.
  function nyIdFor(k) {
    const r = (nyMemo ? nyMemo.rows : nyRows()).find(x => sid(x.key) === k);
    if (r && r.c) return r.c.id;
    if (!r) { const id = idOf(k); return customers[id] ? mainOf(id) : null; }
    if (!can('contacts', 'change')) return null;
    const jobs = r.open.map(b => b.j).concat(r.unsent);
    if (!jobs.length) return null;
    const id = newLeadFromJob(jobs[0]);
    if (can('jobs', 'change') && window.YDSync) jobs.forEach(j => YDSync.patchJob(j._id, { customerId: id, customerBy: 'auto' }));
    return id;
  }
  // This year's pick on someone changed -- the whole map written, so what
  // is on screen is what is saved -- and the way back.
  function nyPatch(id, change) {
    const c = customers[id], Y = String(nyYear());
    const was = (c.contactYears || {})[Y] || null;
    const next = Object.assign({}, was || {}, change);
    return { map: Object.assign({}, c.contactYears || {}, { [Y]: next }), Y: Y, was: was, next: next };
  }
  function nyBack(id, p, more) {
    return () => {
      const cur = Object.assign({}, (customers[id] || {}).contactYears || {});
      // A key added since is cleared (the save merges, so leaving it out
      // would keep it).
      let back = null;
      if (p.was) { back = {}; Object.keys(p.next).forEach(x => { back[x] = null; }); Object.assign(back, p.was); }
      cur[p.Y] = back;
      write(id, Object.assign({ contactYears: cur }, more || {}), 'the contact list');
      render();
    };
  }
  const meUid = () => (window.YDAuth && window.YDAuth.user && window.YDAuth.user.uid) || null;
  const nySay = (msg, undo) => { if (typeof showUndo === 'function') showUndo(msg, undo); else showToast(msg); };
  // "✓ Reached out": reached for this list, and for the call list as well.
  window.custNyDone = function (k, on) {
    const id = nyIdFor(k), c = id && customers[id];
    if (!c) return;
    const nowIso = new Date().toISOString();
    const was = (c.contactYears || {})[String(nyYear())] || {};
    // The reach before this tap is kept with it (reachedWas): "Not reached
    // yet" puts it back -- the reach the tap wrote would still count as
    // reached in the year otherwise.
    const p = nyPatch(id, on ? { doneAt: nowIso, reachedWas: c.reachedAt || null } : { doneAt: null, reachedWas: null });
    const data = { contactYears: p.map };
    if (on) data.reachedAt = nowIso;
    else if (was.doneAt && s(c.reachedAt) === s(was.doneAt)) data.reachedAt = was.reachedWas || null;
    const before = { reachedAt: c.reachedAt || null };
    write(id, data, 'the contact list');
    render();
    if (on) nySay('Reached ' + (c.name || ''), nyBack(id, p, before));
  };
  // Put on the Call list for the season (one tap, the window written then).
  window.custNyWhen = function (k) {
    const r = (nyMemo ? nyMemo.rows : nyRows()).find(x => sid(x.key) === k);
    const w = r && nySeason(r);
    const id = w && nyIdFor(k), c = id && customers[id];
    if (!c) return;
    const before = { when: c.when || null, contactWhen: c.contactWhen || '', whenSetAt: c.whenSetAt || null };
    write(id, { when: w, contactWhen: w.label, whenSetAt: new Date().toISOString() }, 'when to call');
    render();
    nySay('On the call list from ' + niceDay(w.from), () => { write(id, before, 'when to call'); render(); });
  };
  window.custNyNot = function (k, on) {
    const id = nyIdFor(k), c = id && customers[id];
    if (!c) return;
    const before = { notInterested: !!c.notInterested };
    write(id, { notInterested: !!on }, 'not interested');
    render();
    nySay(on ? (c.name || 'They') + ' — not interested' : (c.name || 'They') + ' back on the lists', () => { write(id, before, 'not interested'); render(); });
  };
  // Taken off this year's list -- or back on it (by hand when no bid puts
  // them there).
  window.custNyOff = function (k, off) {
    const r = (nyMemo ? nyMemo.rows : nyRows()).find(x => sid(x.key) === k);
    const id = nyIdFor(k), c = id && customers[id];
    if (!c) return;
    const p = nyPatch(id, { on: off ? false : (r && r.open.length ? null : true), at: new Date().toISOString(), by: meUid() });
    write(id, { contactYears: p.map }, 'the contact list');
    render();
    nySay(off ? (c.name || 'They') + ' taken off the ' + p.Y + ' list' : (c.name || 'They') + ' back on the ' + p.Y + ' list', nyBack(id, p));
  };
  window.custNyOn = function (k) {
    const id = nyIdFor(k), c = id && customers[id];
    if (!c) return;
    const p = nyPatch(id, { on: true, at: new Date().toISOString(), by: meUid() });
    write(id, { contactYears: p.map }, 'the contact list');
    if (nyFinding !== null) nyFinding = null;
    render();
    nySay((c.name || 'They') + ' put on the ' + p.Y + ' list', nyBack(id, p));
  };
  // On a customer's page: where they stand on the list, and the button.
  function nyPageHtml(c, ch) {
    if (isFolded(c)) return '';
    const Y = nyYear(), r = nyRows().find(x => x.c && x.c.id === c.id), k = sid(r ? r.key : c.id);
    const btn = (label, fn, arg) => '<button class="btn btn-sm" onclick="' + fn + '(\'' + k + '\'' + (arg === undefined ? '' : ', ' + arg) + ')">' + label + '</button>';
    let line, act = '';
    const st = r ? r.state : 'none';
    if (st === 'on' || st === 'chasing') {
      const nums = r.open.map(b => s(b.j.estimateNumber) ? '#' + s(b.j.estimateNumber) : '').filter(Boolean);
      line = 'On it — ' + (r.open.length ? 'bid' + (nums.length ? ' ' + nums.join(', ') : '') + (r.services.length ? ' for ' + r.services.join(', ') : '') +
        (st === 'chasing' ? ', still being followed up' : ', no answer') : 'put on by hand');
      act = btn('Take off', 'custNyOff', true);
    } else if (st === 'done') {
      line = '✓ Reached ' + niceDay(localDay(r.reached));
    } else if (st === 'off') {
      line = 'Taken off it' + (r.pick.at ? ' ' + niceDay(localDay(r.pick.at)) : '');
      act = btn('Put back on', 'custNyOff', false);
    } else if (st === 'no') {
      line = 'Not interested — off it';
    } else {
      line = 'Not on it' + (r && r.unsent.length ? ' — their bid never went out' : '');
      act = btn('+ Put them on it', 'custNyOn');
    }
    return '<div class="cu-sec"><div class="cu-sec-h">📆 Contact in ' + Y + '</div><div class="cu-line">' + esc(line) + '</div>' +
      (ch && act ? '<div class="cu-btns">' + act + '</div>' : '') + '</div>';
  }

  function more(n) {
    return n > showN ?'<button class="btn btn-sm cu-more" onclick="custMore()">Show ' + Math.min(SHOW_STEP, n - showN) + ' more of ' + (n - showN) + '</button>' : '';
  }
  function telOf(v) { return String(v || '').replace(/[^0-9+]/g, ''); }
  // When they were last talked to: "Reached out", or a dated note.
  function lastTalk(c) {
    let at = s(c.reachedAt);
    (c.meetings || []).forEach(m => { if (s(m && m.at) > at) at = s(m.at); });
    return localDay(at);
  }
  // mode: 'due' (Call now: "Reached out"), 'soon', 'done', 'no' (the call
  // list's other parts), 'none' (no time yet: "Set when"), '' (a plain list).
  function rowHtml(c, w, mode) {
    const k = kindOf(c), id = sid(c.id);
    const phone = c.phone || c.mobile;
    const calling = !!mode;
    const talked = calling ? lastTalk(c) : '';
    const ch = can('contacts', 'change');
    return '<div class="cu-row">' +
      '<div class="cu-main">' +
        '<button class="cu-name" onclick="openCustomer(\'' + id + '\')">' + esc(shownName(c)) + '</button>' +
        (k !== 'customer' ? ' <span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span>' : '') +
        (w ? ' <span class="pp-when">' + esc(whenText(w)) + '</span>' : '') +
        (c.qbConflict ? ' <span class="cu-kind k-warn">Check details</span>' : '') +
        ((c.tags || []).length ? '<div class="pp-svc">' + c.tags.map(t => '<span class="svc-tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
        '<div class="pp-contact">' + [c.address ? esc(c.address) : '',
          phone ? '<a href="tel:' + esc(telOf(phone)) + '">📞 ' + esc(phone) + '</a>' : ''].filter(Boolean).join(' &middot; ') + '</div>' +
        (calling ? '<div class="cu-talk">' + (talked ? 'Last talked to ' + esc(niceDay(talked)) : 'Not talked to yet') + '</div>' : '') +
      '</div>' +
      (mode === 'due' && ch ? '<div class="cu-act"><button class="btn btn-sm btn-filled" onclick="custReached(\'' + id + '\')">✓ Reached out</button></div>'
        : mode === 'none' && ch ? '<div class="cu-act"><button class="btn btn-sm" onclick="custSetWhen(\'' + id + '\')">Set when</button></div>' : '') +
    '</div>';
  }
  // "Set when" on the call list: their page, the time-to-call buttons open.
  window.custSetWhen = function (id) {
    window.openCustomer(id);
    if (openId) window.custWhenOpen(true);
  };

  window.custView = function (v) {
    view = v; showN = SHOW_STEP; tagsOpen = false;
    if (v === 'sort' || v === 'check') searchText = '';      // these have no search row to show it in
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* private window */ }
    render();
  };
  window.custMore = function () { showN += SHOW_STEP; render(); };
  let searchTimer = null;
  window.custRender = function () { showN = SHOW_STEP; renderListOnly(); };
  // What is typed is kept as typed (the box is not rebuilt); the list under it
  // is drawn again once typing pauses.
  window.custSearchSoon = function () {
    const box = el('custSearch');
    if (box) searchText = box.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(window.custRender, 150);
  };

  // ------------------------------------------------------------ leads
  //
  // Jonah (16 Oct 2026): "I need a list of the new leads so i can enter there
  // info." Every lead, with what each is missing; "Fill them in" goes through
  // them one after another in one box (no page to open and close for each),
  // and "+ Add a lead" is a short form right here. While a phone, email or
  // name is typed, anyone already in the list with the same one is named --
  // so the same person is not put in twice.
  const MISS_WORD = { phone: 'no phone', email: 'no email', address: 'no address' };
  function missingOf(c) {
    const out = [];
    if (!s(c.phone) && !s(c.mobile)) out.push('phone');
    if (!s(c.email)) out.push('email');
    if (!s(c.street) && !s(c.address)) out.push('address');
    return out;
  }
  function leadsHtml(list, q, tag) {
    const ch = can('contacts', 'change');
    let h = '';
    if (ch && addOpen) h += addHtml();
    if (ch && fill && fill.from === 'leads') h += fillHtml();
    list = list.filter(c => matches(c, q, tag)).sort(byName);
    const missing = list.filter(c => missingOf(c).length);
    if (ch && missing.length && !(fill && fill.from === 'leads')) {
      h += '<div class="cu-fillbar"><span><b>' + missing.length + ' of ' + list.length + '</b> missing a phone, email or address.</span>' +
        '<button class="btn btn-sm btn-filled" onclick="custFillStart(\'leads\')">✎ Fill them in, one after another</button></div>';
    }
    if (window.YDAuth && window.YDAuth.isOwner) h += leadMailBarHtml();
    if (!list.length) return h + '<p class="empty-msg">' + (q || tag ? 'No lead matches that.' : 'No leads yet — “+ Add a lead” puts one in.') + '</p>';
    // Leads from email, newest first, above the rest (by name).
    const mail = list.filter(c => c.fromEmail).sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
    list = mail.concat(list.filter(c => !c.fromEmail));
    return h + list.slice(0, showN).map(leadRowHtml).join('') + more(list.length);
  }

  // ---- leads from the inbox (functions/leads.py)
  //
  // Jonah (26 Oct 2026, AI idea #3 / routine #1): someone writing in for a
  // quote becomes a Lead here by itself within the hour, with a reply waiting
  // in his Gmail Drafts -- never sent for him. settings/leads: on (false =
  // off), never (addresses or @domains it must never touch).
  let leadConf = null;
  let leadConfAsked = false;
  function leadMailBarHtml() {
    if (!leadConfAsked) { leadConfAsked = true; loadLeadConf(); }
    const c = leadConf || {};
    const off = c.on === false;
    return '<div class="cu-fillbar"><span>📬 ' + (off ? 'Leads from your email are <b>switched off</b>.'
        : c.autoDraft === true ? 'People who email asking for work are added here by themselves, with a reply in your Gmail Drafts to read and send.'
        : 'People who email asking for work are added here by themselves. “✍️ Draft a reply” on one writes it the way you write, into your Gmail Drafts.') +
      '</span><button class="btn btn-sm" onclick="custLeadMailSettings()">⚙ Settings</button></div>';
  }
  function loadLeadConf() {
    if (!(window.YDAuth && window.YDAuth.isOwner) || !window.YDDb) return;
    Promise.resolve(window.YDDb.get('settings', 'leads')).then(d => { leadConf = d || {}; if (view === 'leads') render(); }).catch(() => {});
  }
  window.custLeadMailSettings = async function () {
    if (!(window.YDAuth && window.YDAuth.isOwner) || !window.YDDb) return;
    const now = (await Promise.resolve(window.YDDb.get('settings', 'leads')).catch(() => null)) || {};
    const never = (now.never || []).join(', ');
    const pick = await ydChoose('Every hour from 7 to 7, mail from someone not in Job Hub is read; anyone asking for work becomes a Lead ' +
      'here and a short reply goes into your Gmail Drafts (never sent for you). Your suppliers, crew, customers and mailing lists ' +
      'are never read.', [
      { id: 'on', label: '✅ On', hint: 'Catch new leads from my email' },
      { id: 'off', label: '🚫 Off', hint: 'Don’t read my email for leads' },
      { id: 'never', label: '✋ Never touch these senders', hint: never || 'Family, friends, anyone — add addresses or @domains' },
      now.autoDraft === true
        ? { id: 'nodraft', label: '✋ Stop drafting replies by themselves', hint: 'Only when I tap “Draft a reply” on a lead' }
        : { id: 'autodraft', label: '✍️ Draft a reply for each new lead by itself', hint: 'Now: only when you tap “Draft a reply”' },
    ], { title: 'Leads from your email', value: now.on === false ? 'off' : 'on', cancel: 'Close' });
    if (!pick) return;
    let patch;
    if (pick.id === 'never') {
      const got = await ydPrompt('Addresses or whole domains (like @mybank.com), separated by commas. Mail from them is never read for leads.',
        never, { title: 'Never touch these senders', placeholder: 'mom@gmail.com, @family.net' });
      if (got == null) return;
      patch = { never: String(got).split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(x => /^@?[^@\s]+(@[^@\s]+)?\.[a-z]{2,}$/.test(x)) };
    } else if (pick.id === 'autodraft' || pick.id === 'nodraft') patch = { autoDraft: pick.id === 'autodraft' };
    else patch = { on: pick.id === 'on' };
    leadConf = Object.assign({}, now, patch);
    render();
    Promise.resolve(window.YDDb.put('settings', 'leads', Object.assign(patch, { updatedAt: new Date().toISOString() })))
      .then(() => showToast('Saved'), e => showToast('Not saved: ' + ((e && e.code) || 'error')));
  };
  document.addEventListener('yd-auth', loadLeadConf);
  // The lead's email and the drafted reply, under its name.
  const gmailLink = u => /^https:\/\/mail\.google\.com\//.test(String(u || '')) ? String(u) : '';
  function leadMailHtml(c) {
    const f = c.fromEmail;
    if (!f) return '';
    const draft = f.draft && gmailLink(f.draft.link), mail = gmailLink(f.link);
    return '<div class="cu-mail">📬 ' + esc(f.summary || f.subject || 'Emailed in') +
      (f.timing ? ' <span class="muted">· ' + esc(f.timing) + '</span>' : '') +
      (draft ? ' <a class="btn btn-sm" href="' + esc(draft) + '" target="_blank" rel="noopener">✉️ Open the reply draft</a>'
        : window.YDAuth && window.YDAuth.isOwner && typeof ibDraftLead === 'function'
          ? ' <button class="btn btn-sm" onclick="ibDraftLead(\'' + sid(c.id) + '\')">✍️ Draft a reply</button>' : '') +
      (mail ? ' <a class="link-btn" href="' + esc(mail) + '" target="_blank" rel="noopener">Their email</a>' : '') + '</div>';
  }
  function contactBits(c) {
    const phone = c.phone || c.mobile;
    return [c.address ? esc(c.address) : '',
      phone ? '<a href="tel:' + esc(telOf(phone)) + '">📞 ' + esc(phone) + '</a>' : '',
      c.email ? '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>' : ''].filter(Boolean).join(' &middot; ');
  }
  function leadRowHtml(c) {
    const id = sid(c.id), miss = missingOf(c), w = windowOf(c);
    return '<div class="cu-row">' +
      '<div class="cu-main">' +
        '<button class="cu-name" onclick="openCustomer(\'' + id + '\')">' + esc(shownName(c)) + '</button>' +
        (w ? ' <span class="pp-when">' + esc(whenText(w)) + '</span>' : '') +
        ((c.tags || []).length ? '<div class="pp-svc">' + c.tags.map(t => '<span class="svc-tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
        '<div class="pp-contact">' + contactBits(c) + '</div>' + leadMailHtml(c) +
        (miss.length ? '<div class="cu-miss">' + miss.map(m => '<span class="cu-kind k-warn">' + MISS_WORD[m] + '</span>').join(' ') + '</div>' : '') +
      '</div>' +
      (miss.length && can('contacts', 'change') ? '<div class="cu-act"><button class="btn btn-sm" onclick="custFillOne(\'' + id + '\')">✎ Fill in</button></div>' : '') +
    '</div>';
  }

  // ---- filling in, one after another
  //
  // The leads missing something (or, from Check the list, the customers with
  // no phone and no email), in one box: Save goes on to the next. A customer
  // in QuickBooks is saved there too, as on their page.
  function fillQueue(from) {
    const people = Object.values(customers).filter(inLists);
    if (from === 'leads') return people.filter(c => !isQb(c) && missingOf(c).length).sort(byName).map(c => c.id);
    return noContact().map(c => c.id);
  }
  function fillCur() {
    while (fill && fill.at < fill.ids.length && !customers[fill.ids[fill.at]]) fill.at++;
    return fill && fill.at < fill.ids.length ? customers[fill.ids[fill.at]] : null;
  }
  const FILL_FOCUS = { phone: 'cuQ_phone', email: 'cuQ_email', address: 'cuQ_street' };
  function focusFill() {
    const c = fillCur();
    if (!c) return;
    const n = el(FILL_FOCUS[missingOf(c)[0]] || 'cuQ_phone');
    if (n) { n.focus(); try { n.scrollIntoView({ block: 'center' }); } catch (e) { /* old browser */ } }
  }
  window.custFillStart = function (from) {
    const ids = fillQueue(from);
    if (!ids.length) { showToast('Nothing missing'); return; }
    fill = { ids: ids, at: 0, from: from === 'leads' ? 'leads' : 'check' };
    if (from === 'leads') { view = 'leads'; try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* private window */ } }
    else { view = 'check'; checkPart = 'nocontact'; }
    render();
    focusFill();
  };
  // One picked from the list: it first, then the rest still missing something.
  window.custFillOne = function (id) {
    const from = view === 'check' ? 'check' : 'leads';
    const rest = fillQueue(from === 'leads' ? 'leads' : 'nocontact').filter(x => x !== id);
    fill = { ids: [id].concat(rest), at: 0, from: from };
    render();
    focusFill();
  };
  window.custFillStop = function () { fill = null; render(); };
  window.custFillNext = function () {
    if (!fill) return;
    fill.at++;
    if (!fillCur()) { fill = null; showToast('That’s all of them'); }
    render();
    focusFill();
  };
  window.custFillOpen = function () { const c = fillCur(); if (c) window.openCustomer(c.id); };
  window.custFillIn = function (k, v) {
    const c = fillCur();
    if (!c) return;
    (fillDraft[c.id] = fillDraft[c.id] || {})[k] = v;
    if (/^(phone|mobile|email|firstName|lastName|business)$/.test(k)) {
      const box = el('cuFillDup');
      if (box) box.innerHTML = dupWarnHtml(typedWho(c, fillDraft[c.id]), c.id, 'fill');
    }
  };
  window.custFillSave = function () {
    const c = fillCur();
    if (!c) return;
    const r = saveContact(c.id, typedWho(c, fillDraft[c.id] || {}));
    if (r === 'noname') { showToast('Give them a name first'); return; }
    delete fillDraft[c.id];
    window.custFillNext();
  };
  // The contact details as they stand with what is typed over them.
  function typedWho(c, d) {
    const now = {};
    EDIT_KEYS.forEach(k => { now[k] = d && k in d ? s(d[k]) : s(c[k]); });
    // A lead's name is worked out from the parts while nobody has written a
    // name of their own: changing the first name changes it.
    if (!isQb(c) && (!s(c.name) || s(c.name) === nameFrom(c))) now.name = nameFrom(now);
    return now;
  }
  const nameFrom = p => s(p.business) || [s(p.firstName), s(p.lastName)].filter(Boolean).join(' ');
  function fillHtml() {
    const c = fillCur();
    if (!c) return '';
    const d = fillDraft[c.id] || {};
    const val = k => (k in d ? d[k] : s(c[k]));
    const miss = missingOf(c);
    const want = k => miss.indexOf(k === 'street' ? 'address' : k === 'mobile' ? 'phone' : k) !== -1;
    const f = (k, label, type, extra) => '<div class="field' + (want(k) ? ' cu-want' : '') + '"><span class="label">' + label + '</span>' +
      '<input id="cuQ_' + k + '"' + (type ? ' type="' + type + '"' : '') + ' value="' + esc(val(k)) + '" oninput="custFillIn(\'' + k + '\', this.value)"' +
      ' onkeydown="if (event.key === \'Enter\') custFillSave()"' + (extra || '') + '></div>';
    const k = kindOf(c), last = fill.at + 1 >= fill.ids.length;
    return '<div class="cu-fill">' +
      '<div class="cu-fill-h"><span>Filling in — <b>' + (fill.at + 1) + ' of ' + fill.ids.length + '</b></span>' +
        '<button class="link-btn" onclick="custFillStop()">Done for now</button></div>' +
      '<div class="cu-fill-who"><b>' + esc(shownName(c)) + '</b> <span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span>' +
        (miss.length ? ' <span class="muted">— ' + miss.map(m => MISS_WORD[m]).join(', ') + '</span>' : ' <span class="muted">— nothing missing now</span>') + '</div>' +
      '<div class="grid g3">' + f('firstName', 'First name') + f('lastName', 'Last name') + f('business', 'Business') + '</div>' +
      '<div class="grid g3">' + f('phone', 'Phone', 'tel') + f('mobile', 'Mobile', 'tel') + f('email', 'Email', 'email') + '</div>' +
      f('street', 'Street', '', ' autocomplete="off"') +
      '<div class="grid sf-addr">' + f('city', 'City') + f('state', 'State', '', ' maxlength="2"') + f('zip', 'ZIP', '', ' inputmode="numeric" maxlength="10"') + '</div>' +
      '<div id="cuFillDup">' + dupWarnHtml(typedWho(c, d), c.id, 'fill') + '</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="custFillSave()">' + (isQb(c) ? 'Save — here and in QuickBooks' : 'Save') + (last ? '' : ' and next') + '</button>' +
        (last ? '' : '<button class="btn btn-sm" onclick="custFillNext()">Skip this one</button>') +
        '<button class="btn btn-sm" onclick="custFillOpen()">Open their page</button></div>' +
    '</div>';
  }

  // ---- "+ Add a lead", right on the list
  function addHtml() {
    const d = addDraft;
    const f = (k, label, type, extra) => '<div class="field"><span class="label">' + label + '</span><input id="cuA_' + k + '"' +
      (type ? ' type="' + type + '"' : '') + ' value="' + esc(d[k] || '') + '" oninput="custAddIn(\'' + k + '\', this.value)"' + (extra || '') + '></div>';
    const same = w => !!(d.when && w && d.when.from === w.from && d.when.to === w.to);
    const wins = SEASON_BTNS.map(x => seasonWindow(x[0], false)).concat([soonWindow()]);
    return '<div class="cu-add">' +
      '<div class="cu-fill-h"><b>Add a lead</b><button class="link-btn" onclick="custAddClose()">Close</button></div>' +
      '<div class="grid g3">' + f('firstName', 'First name', '', ' autocomplete="off"') + f('lastName', 'Last name', '', ' autocomplete="off"') +
        f('business', 'Business (if any)', '', ' autocomplete="off"') + '</div>' +
      '<div class="grid g2">' + f('phone', 'Phone', 'tel') + f('email', 'Email', 'email') + '</div>' +
      f('street', 'Street', '', ' autocomplete="off"') +
      '<div class="grid sf-addr">' + f('city', 'City') + f('state', 'State', '', ' maxlength="2"') + f('zip', 'ZIP', '', ' inputmode="numeric" maxlength="10"') + '</div>' +
      '<div id="cuAddDup">' + dupWarnHtml(typedWho({}, d), '', 'add') + '</div>' +
      '<div class="cu-add-part"><span class="label">What for</span>' +
        ((d.tags || []).length ? '<div class="pp-svc">' + d.tags.map(t => '<span class="svc-tag">' + esc(t) +
          '<button data-t="' + esc(t) + '" onclick="custTagTap(\'add\', this.dataset.t)" title="Take it off">&times;</button></span>').join('') + '</div>' : '') +
        tagPickerHtml('add') + '</div>' +
      '<div class="cu-add-part"><span class="label">When to call</span><div class="cu-when-grid cu-g3">' +
        wins.map((w, i) => '<button class="cu-chip' + (same(w) ? ' on' : '') + '" onclick="custAddWhen(' + i + ')">' +
          esc(w.how === 'soon' ? 'In 1–3 months' : w.label) + '<small>from ' + esc(niceDay(w.from)) + '</small></button>').join('') +
        '<button class="cu-chip' + (!d.when ? ' on' : '') + '" onclick="custAddWhen(-1)">No time yet<small>set it later</small></button></div></div>' +
      '<div class="field"><span class="label">Note</span><textarea id="cuA_note" rows="2" oninput="custAddIn(\'note\', this.value)" ' +
        'placeholder="What they want, how they heard of you…">' + esc(d.note || '') + '</textarea></div>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="custAddSave(false)">Save the lead</button>' +
        '<button class="btn btn-sm" onclick="custAddSave(true)">Save and add another</button></div>' +
      '<div class="hint">Only a name is needed. It’s on the call list once it has a time to call.</div>' +
    '</div>';
  }
  window.custAddLead = function () {
    view = 'leads';
    try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* private window */ }
    addOpen = true; showN = SHOW_STEP;
    render();
    const n = el('cuA_firstName');
    if (n) { n.focus(); try { n.scrollIntoView({ block: 'center' }); } catch (e) { /* old browser */ } }
  };
  window.custAddClose = function () { addOpen = false; render(); };
  window.custAddIn = function (k, v) {
    addDraft[k] = v;
    if (/^(phone|email|firstName|lastName|business)$/.test(k)) {
      const box = el('cuAddDup');
      if (box) box.innerHTML = dupWarnHtml(typedWho({}, addDraft), '', 'add');
    }
  };
  window.custAddWhen = function (i) {
    const wins = SEASON_BTNS.map(x => seasonWindow(x[0], false)).concat([soonWindow()]);
    addDraft.when = i >= 0 ? wins[i] || null : null;
    render();
  };
  window.custAddSave = function (again) {
    if (!can('contacts', 'change')) return;
    const d = addDraft, nowIso = new Date().toISOString();
    const rec = { firstName: s(d.firstName), lastName: s(d.lastName), business: s(d.business), phone: s(d.phone), mobile: '',
      email: s(d.email).toLowerCase(), street: s(d.street), city: s(d.city), state: s(d.state).toUpperCase(), zip: s(d.zip) };
    rec.name = nameFrom(rec);
    if (!rec.name) { showToast('Give them a name first'); const n = el('cuA_firstName'); if (n) n.focus(); return; }
    rec.address = lineOf(rec);
    rec.tags = (d.tags || []).slice();
    rec.note = s(d.note);
    if (d.when) {
      rec.when = d.when;
      rec.contactWhen = d.when.how === 'soon' ? d.when.label + ' (' + windowWords(d.when) + ')' : d.when.label;
      rec.whenSetAt = nowIso;
    }
    rec.source = 'hand';
    rec.addedAt = nowIso;
    const id = 'ld' + Date.now().toString(36);
    customers[id] = Object.assign({ id: id }, rec);
    write(id, rec, 'a lead');
    addDraft = {};
    delete tagFind.add; delete tagAll.add;
    addOpen = !!again;
    render();
    if (again) { const n = el('cuA_firstName'); if (n) n.focus(); }
    const undo = () => {
      delete customers[id];
      ver++;
      render();
      Promise.resolve(window.YDDb.remove('customers', id)).catch(e => showToast('Not taken off: ' + ((e && e.code) || 'error')));
    };
    if (typeof showUndo === 'function') showUndo('Added ' + rec.name + (rec.when ? ' — on the call list from ' + niceDay(rec.when.from) : ''), undo);
    else showToast('Added ' + rec.name);
  };

  // ---- someone already here with that phone, email or name
  function sameAsTyped(who, exceptId) {
    const ph = [digits(who.phone), digits(who.mobile)].filter(d => d.length === 10);
    const em = low(who.email);
    const nk = namesOf(who);
    const me = exceptId ? customers[exceptId] : null;
    const out = [];
    Object.values(customers).forEach(c => {
      if (c.id === exceptId || isTwin(c) || (me && notSameAs(c, me))) return;
      const why = [];
      if (ph.length && [digits(c.phone), digits(c.mobile)].some(x => x.length === 10 && ph.indexOf(x) !== -1)) why.push('same phone');
      if (em.indexOf('@') > 0 && low(c.email) === em) why.push('same email');
      if (nk.length && namesOf(c).some(x => nk.indexOf(x) !== -1)) why.push('same name');
      if (why.length) out.push([c, why]);
    });
    return out.sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  }
  function dupWarnHtml(who, exceptId, ctx) {
    const hits = sameAsTyped(who, exceptId);
    if (!hits.length) return '';
    const lead = exceptId && customers[exceptId] && !isQb(customers[exceptId]);
    return '<div class="cu-dupwarn"><b>⚠️ Already in your list?</b>' + hits.map(([c, why]) => {
      const k = kindOf(c);
      return '<div class="cu-dupwarn-one"><span><b>' + esc(shownName(c)) + '</b> <span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span> ' +
        '<span class="muted">' + esc(why.join(', ')) + '</span></span>' +
        '<span class="cu-btns"><button class="btn btn-sm" onclick="openCustomer(\'' + sid(c.id) + '\')">Open them</button>' +
        (ctx === 'fill' && lead ? '<button class="btn btn-sm btn-filled" onclick="custLeadOnto(\'' + sid(exceptId) + '\', \'' + sid(c.id) + '\')">Same person — put this lead onto them</button>' : '') +
        '</span></div>';
    }).join('') + (ctx === 'add' ? '<div class="muted">Someone else? Save it anyway.</div>' : '') + '</div>';
  }
  window.custLeadOnto = function (leadId, toId) {
    if (!customers[leadId] || !customers[resolve(toId)]) return;
    joinOnto(mainOf(toId), [leadId]);
  };

  // ------------------------------------------------------------ "What for": found by typing
  //
  // Jonah (16 Oct 2026): "the what for section for calling a client should
  // have a search bar." The one services list (services.js), as buttons:
  // typing narrows it (old spellings find the service they became), a tap
  // adds one or takes it off, and one not on the list is added to it with
  // "+ Add". With nothing typed: the ones used most, and "Show all".
  function serviceGroups() {
    const S = window.YDServices;
    const L = S && S.ready && S.ready() ? S.list() : null;
    if (L && L.groups && L.services) {
      const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || s(a.name).localeCompare(s(b.name));
      const groups = Object.keys(L.groups).map(id => Object.assign({ id: id }, L.groups[id])).filter(g => g.active !== false).sort(byOrder);
      const live = Object.keys(L.services).map(id => Object.assign({ id: id }, L.services[id])).filter(v => v && v.name && v.active !== false);
      const known = {};
      const out = groups.map(g => {
        const items = live.filter(v => v.group === g.id).sort(byOrder);
        items.forEach(v => { known[v.id] = true; });
        return { name: s(g.name), items: items.map(v => ({ name: s(v.name), also: (v.aliases || []).map(s) })) };
      });
      const rest = live.filter(v => !known[v.id]).sort(byOrder);
      if (rest.length) out.push({ name: 'Other', items: rest.map(v => ({ name: s(v.name), also: (v.aliases || []).map(s) })) });
      return out.filter(g => g.items.length);
    }
    // Not read yet: the Job tab's own list.
    const sel = el('serviceTypeSelect'), out = [];
    if (!sel) return out;
    Array.prototype.forEach.call(sel.children, n => {
      if (n.tagName === 'OPTGROUP') out.push({ name: n.label, items: Array.prototype.map.call(n.children, o => ({ name: s(o.value), also: [] })).filter(v => v.name) });
      else if (n.value && n.value !== '__custom' && !n.dataset.typed) {
        if (!out.length || out[out.length - 1].name !== '') out.push({ name: '', items: [] });
        out[out.length - 1].items.push({ name: s(n.value), also: [] });
      }
    });
    return out.filter(g => g.items.length);
  }
  // The services picked most often on customers, for one tap.
  function usualTags() {
    const n = {};
    Object.values(customers).forEach(c => (c.tags || []).forEach(t => { n[t] = (n[t] || 0) + 1; }));
    const top = Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b)).slice(0, 8);
    if (top.length < 6) serviceGroups().forEach(g => g.items.forEach(v => { if (top.length < 8 && top.indexOf(v.name) === -1) top.push(v.name); }));
    return top;
  }
  const tagsOf = ctx => (ctx === 'add' ? addDraft.tags || [] : ((customers[ctx] || {}).tags || []));
  function tagResHtml(ctx) {
    const chosen = tagsOf(ctx), on = {};
    chosen.forEach(t => { on[low(t)] = true; });
    const typed = s(tagFind[ctx]), q = low(typed);
    const c = sid(ctx);
    const chip = n => '<button class="cu-chip cu-tagchip' + (on[low(n)] ? ' on' : '') + '" data-t="' + esc(n) + '" onclick="custTagTap(\'' + c + '\', this.dataset.t)">' +
      (on[low(n)] ? '✓ ' : '') + esc(n) + '</button>';
    const groups = serviceGroups();
    if (q) {
      const hits = [];
      groups.forEach(g => g.items.forEach(v => {
        if (hits.indexOf(v.name) === -1 && (low(v.name).indexOf(q) !== -1 || v.also.some(a => low(a).indexOf(q) !== -1))) hits.push(v.name);
      }));
      let h = hits.slice(0, 30).map(chip).join('');
      if (!hits.some(x => low(x) === q)) {
        h += '<button class="cu-chip cu-tagnew" data-t="' + esc(typed) + '" onclick="custTagTap(\'' + c + '\', this.dataset.t)">+ Add “' + esc(typed) + '”' +
          '<small>' + (hits.length ? 'not one of these' : 'not on the list yet') + '</small></button>';
      }
      return h;
    }
    if (tagAll[ctx]) {
      return groups.map(g => (g.name ? '<div class="cu-tag-g">' + esc(g.name) + '</div>' : '') + g.items.map(v => chip(v.name)).join('')).join('') ||
        '<span class="muted">The services list has not loaded yet — type one in.</span>';
    }
    return usualTags().map(chip).join('') +
      '<button class="cu-chip cu-tagmore" onclick="custTagAll(\'' + c + '\')">Show all services…</button>';
  }
  function tagPickerHtml(ctx) {
    const c = sid(ctx);
    return '<input id="cuTag_' + c + '" class="cu-tagfind" type="search" autocomplete="off" placeholder="Find a service — e.g. patio, mulch, snow" value="' +
      esc(tagFind[ctx] || '') + '" oninput="custTagFind(\'' + c + '\', this.value)" onkeydown="custTagKey(event, \'' + c + '\')">' +
      '<div class="cu-tag-res" id="cuTagRes_' + c + '">' + tagResHtml(ctx) + '</div>';
  }
  const ctxOf = c => (c === 'add' ? 'add' : Object.keys(customers).find(id => sid(id) === c) || c);
  window.custTagFind = function (c, v) {
    const ctx = ctxOf(c);
    tagFind[ctx] = v;
    const box = el('cuTagRes_' + c);
    if (box) box.innerHTML = tagResHtml(ctx);
  };
  window.custTagAll = function (c) {
    const ctx = ctxOf(c);
    tagAll[ctx] = true;
    const box = el('cuTagRes_' + c);
    if (box) box.innerHTML = tagResHtml(ctx);
  };
  window.custTagKey = function (e, c) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.target.value = ''; window.custTagFind(c, ''); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const box = el('cuTagRes_' + c);
    const btns = box ? Array.prototype.slice.call(box.querySelectorAll('button[data-t]')) : [];
    const plain = btns.filter(b => !b.classList.contains('cu-tagnew'));
    // One service found: that one. None: the words typed, as a new one.
    const pick = plain.length === 1 ? plain[0] : !plain.length && btns.length ? btns[0] : null;
    if (pick) window.custTagTap(c, pick.dataset.t);
  };
  // A tap: on if it was off, off if it was on. A name the list has under an
  // old spelling is the name it became; one it does not have is added to it.
  window.custTagTap = function (c, name) {
    const ctx = ctxOf(c);
    let v = s(name).slice(0, 60);
    if (!v) return;
    const S = window.YDServices;
    if (S && S.canon) v = S.canon(v);
    if (!(S && S.known && S.known(v)) && window.rememberService) window.rememberService(v);
    tagFind[ctx] = '';
    if (ctx === 'add') {
      const tags = (addDraft.tags || []).slice(), i = tags.findIndex(t => low(t) === low(v));
      if (i === -1) tags.push(v); else tags.splice(i, 1);
      addDraft.tags = tags;
      render();
      return;
    }
    const cu = customers[ctx];
    if (!cu) return;
    // A phone keeps the search box focused through the tap (Safari never
    // focuses a button): the page is redrawn anyway, and the box focused
    // again for the next one.
    const typing = document.activeElement && document.activeElement.id === 'cuTag_' + c;
    const i = (cu.tags || []).findIndex(t => low(t) === low(v));
    if (i === -1) window.custTagOn(ctx, v); else window.custTagOff(ctx, i);
    if (openId === ctx) {
      renderPage(true);
      const box = typing && el('cuTag_' + c);
      if (box) box.focus();
    }
  };

  // ------------------------------------------------------------ Everyone
  //
  // Jonah (16 Oct 2026): "there should be one centralized list of all
  // contacts too". Every person and company in one list: customers (now and
  // past), leads, the old Contacts not yet sorted onto a customer, suppliers
  // (Supplies), subcontractors (the owner's) and the team (whoever reads the
  // people list: the owner and admins). Each with call / text / email and its
  // own page. No money on any of it.
  const OTHER_WORD = { contact: 'Old contact', vendor: 'Supplier', sub: 'Subcontractor', team: 'Team' };
  const EVERY_KINDS = [['', 'Everyone'], ['customer', 'Customers'], ['lead', 'Leads'], ['past', 'Past customers'],
    ['contact', 'Old contacts'], ['vendor', 'Suppliers'], ['sub', 'Subcontractors'], ['team', 'Team']];
  // The suppliers: Supplies' own copy when it is watching them (anyone who
  // sees Jobs), else read here once when Everyone is opened.
  function vendorsAll(fetch) {
    const cat = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : null;
    if (cat && cat.vendors && Object.keys(cat.vendors).length) return cat.vendors;
    if (fetch && vendorsRead === null && window.YDDb && window.YDDb.list) {
      vendorsRead = {};
      Promise.resolve(window.YDDb.list('vendors')).then(d => {
        vendorsRead = {};
        Object.keys(d || {}).forEach(id => { vendorsRead[id] = Object.assign({ id: id }, d[id]); });
        if (view === 'everyone') render();
      }).catch(() => { /* not allowed or no signal: none listed */ });
    }
    return vendorsRead || {};
  }
  const roleWord = u => (u.role === 'owner' ? 'Owner' : u.role === 'admin' ? 'Admin' : 'Crew');
  function otherContacts(fetch) {
    const out = [];
    prospectsToSort().forEach(p => out.push({ kind: 'contact', id: s(p.id), name: s(p.name) || '(no name)', phone: s(p.phone), email: s(p.email),
      address: s(p.address), line: [p.contactWhen, (p.services || []).join(', ')].filter(Boolean).join(' · '), rec: p }));
    const vs = vendorsAll(fetch);
    Object.keys(vs).forEach(id => {
      const v = vs[id] || {};
      if (!s(v.name)) return;
      out.push({ kind: 'vendor', id: id, name: s(v.name), phone: s(v.phone), email: s(v.email), address: s(v.address),
        web: s(v.website), line: s(v.hours), rec: v });
    });
    if (window.YDAuth && window.YDAuth.isOwner && window.YDSubs && YDSubs.data) {
      const subs = (YDSubs.data() || {}).subs || {};
      Object.keys(subs).forEach(id => {
        const x = subs[id] || {};
        if (!s(x.name)) return;
        const n = Object.keys(x.props || {}).length;
        out.push({ kind: 'sub', id: id, name: s(x.name), phone: s(x.phone), email: s(x.email), address: '',
          line: n ? n + ' propert' + (n === 1 ? 'y' : 'ies') : '', rec: x });
      });
    }
    if (window.YDAuth && (window.YDAuth.isOwner || window.YDAuth.isAdmin) && window.YDClock && YDClock.people) {
      const me = window.YDAuth.user && window.YDAuth.user.uid;
      const ppl = YDClock.people() || {};
      Object.keys(ppl).forEach(uid => {
        const u = ppl[uid] || {};
        if (uid === me || u.active === false || !(s(u.name) || s(u.email))) return;
        out.push({ kind: 'team', id: uid, name: s(u.name) || s(u.email), phone: s(u.phone), email: s(u.email), address: '',
          line: roleWord(u), rec: u });
      });
    }
    return out;
  }
  function everyoneHtml(people, q) {
    const rows = people.map(c => ({ kind: kindOf(c), id: c.id, name: shownName(c), phone: s(c.phone) || s(c.mobile), email: s(c.email),
      address: s(c.address), line: [c.business && c.business !== c.name ? c.business : '', (c.tags || []).join(', ')].filter(Boolean).join(' · '), cust: c }))
      .concat(otherContacts(true));
    const n = {};
    rows.forEach(r => { n[r.kind] = (n[r.kind] || 0) + 1; });
    if (everyKind && !n[everyKind]) everyKind = '';
    const qd = q.replace(/\D/g, '');
    const list = rows.filter(r => (!everyKind || r.kind === everyKind) && (!q ||
      (r.cust ? matches(r.cust, q, '') : [r.name, r.phone, r.email, r.address, r.line, r.web].join(' ').toLowerCase().indexOf(q) !== -1 ||
        (qd.length >= 4 && digits(r.phone).indexOf(qd) !== -1))))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    let h = '<div class="cu-every-kinds">' + EVERY_KINDS.filter(([k]) => !k || n[k]).map(([k, word]) =>
      '<button class="cu-chip' + (everyKind === k ? ' on' : '') + '" onclick="custEveryKind(\'' + k + '\')">' + esc(word) +
      '<small>' + (k ? n[k] : rows.length) + '</small></button>').join('') + '</div>';
    if (!list.length) return h + '<p class="empty-msg">' + (q ? 'Nobody matches that.' : 'Nobody here yet.') + '</p>';
    return h + list.slice(0, showN).map(everyRowHtml).join('') + more(list.length);
  }
  function everyRowHtml(r) {
    const word = r.cust ? KIND_WORD[r.kind] : OTHER_WORD[r.kind];
    const open = r.cust ? 'openCustomer(\'' + sid(r.id) + '\')' : 'custOpenOther(\'' + r.kind + '\', \'' + sid(r.id) + '\')';
    const tel = telOf(r.phone);
    return '<div class="cu-row cu-every">' +
      '<div class="cu-main">' +
        '<button class="cu-name" onclick="' + open + '">' + esc(r.name) + '</button> <span class="cu-kind k-' + r.kind + '">' + esc(word) + '</span>' +
        (r.line ? '<div class="cu-line muted">' + esc(r.line) + '</div>' : '') +
        (r.address ? '<div class="pp-contact">' + esc(r.address) + '</div>' : '') +
      '</div>' +
      '<div class="cu-reach">' +
        (tel ? '<a class="btn btn-sm" href="tel:' + esc(tel) + '" title="' + esc(r.phone) + '">📞 Call</a><a class="btn btn-sm" href="sms:' + esc(tel) + '">💬 Text</a>' : '') +
        (r.email ? '<a class="btn btn-sm" href="mailto:' + esc(r.email) + '" title="' + esc(r.email) + '">✉️ Email</a>' : '') +
        (!tel && !r.email ? '<span class="muted cu-noway">No phone or email</span>' : '') +
      '</div>' +
    '</div>';
  }
  window.custEveryKind = function (k) { everyKind = k || ''; showN = SHOW_STEP; render(); };

  // A supplier, subcontractor, team member or old contact: their details,
  // the ways to reach them, and the way to where they live in Job Hub.
  window.custOpenOther = function (kind, id) {
    const o = otherContacts(false).find(x => x.kind === kind && sid(x.id) === id);
    if (!o) return;
    ensureModal();
    openId = null; editing = false; otherOpen = { kind: kind, id: o.id };
    el('custTitle').textContent = o.name;
    const tel = telOf(o.phone), r = o.rec || {};
    const dir = o.address ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(o.address) : '';
    const web = o.web && window.YDSupplies && YDSupplies.websiteUrl ? YDSupplies.websiteUrl(r) : '';
    let h = '<div class="cu-head"><span class="cu-kind k-' + kind + '">' + esc(OTHER_WORD[kind]) + '</span>' +
      (o.line ? ' <span class="muted">' + esc(o.line) + '</span>' : '') + '</div>';
    h += '<div class="cu-sec"><div class="cu-contact">' +
      (tel ? '<a class="btn btn-sm" href="tel:' + esc(tel) + '">📞 ' + esc(o.phone) + '</a><a class="btn btn-sm" href="sms:' + esc(tel) + '">💬 Text</a>' : '') +
      (o.email ? '<a class="btn btn-sm" href="mailto:' + esc(o.email) + '">✉️ ' + esc(o.email) + '</a>' : '') +
      (web ? '<a class="btn btn-sm" target="_blank" rel="noopener" href="' + esc(web) + '">🌐 Website</a>' : '') +
      (dir ? '<a class="btn btn-sm" target="_blank" rel="noopener" href="' + esc(dir) + '">🧭 Directions</a>' : '') +
      '</div>' + (o.address ? '<div class="cu-line">' + esc(o.address) + '</div>' : '') +
      (!tel && !o.email ? '<div class="cu-line muted">No phone or email written down.</div>' : '') + '</div>';
    if (kind === 'contact') {
      h += '<div class="cu-sec">' + (r.contactWhen ? '<div class="cu-line"><span class="muted">When to call:</span> ' + esc(r.contactWhen) + '</div>' : '') +
        ((r.services || []).length ? '<div class="pp-svc">' + r.services.map(t => '<span class="svc-tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
        (r.note ? '<div class="pp-note">' + esc(r.note) + '</div>' : '') +
        (r.meetings || []).map(m => '<div class="pp-meet-item"><div class="pp-meet-when">' + esc(niceDay(localDay(m.at))) + '</div><div class="pp-meet-text">' + esc(m.text) + '</div></div>').join('') +
        '<div class="hint">From the old Contacts list, not yet put onto a customer or made a lead.</div>' +
        (can('contacts', 'change') ? '<div class="cu-btns"><button class="btn btn-sm btn-filled" onclick="custGoSort()">Sort it onto a customer</button></div>' : '') + '</div>';
    } else if (kind === 'vendor') {
      h += '<div class="cu-sec">' + (r.notes ? '<div class="pp-note">' + esc(r.notes) + '</div>' : '') +
        '<div class="cu-btns"><button class="btn btn-sm btn-filled" onclick="custGoVendor(\'' + sid(o.id) + '\')">Open in Supplies</button></div></div>';
    } else if (kind === 'sub') {
      h += '<div class="cu-sec">' + (r.notes ? '<div class="pp-note">' + esc(r.notes) + '</div>' : '') +
        '<div class="cu-btns"><button class="btn btn-sm btn-filled" onclick="custGoSub(\'' + sid(o.id) + '\')">Open in Subcontractors</button></div></div>';
    } else if (kind === 'team' && can('hours', 'see') && typeof window.openWorker === 'function') {
      h += '<div class="cu-sec"><div class="cu-btns"><button class="btn btn-sm btn-filled" onclick="custGoWorker(\'' + sid(o.id) + '\')">Their hours &amp; page</button></div></div>';
    }
    el('custBody').innerHTML = h;
    el('custModal').classList.add('active');
  };
  window.custGoSort = function () { window.closeCustomer(); window.custView('sort'); };
  window.custGoVendor = function (id) {
    window.closeCustomer();
    if (typeof switchTab === 'function') switchTab('supplies');
    if (typeof window.supFilter === 'function') window.supFilter(id);
  };
  window.custGoSub = function (id) {
    window.closeCustomer();
    if (typeof switchTab === 'function') switchTab('dashboard');
    if (typeof window.subToggle === 'function') window.subToggle(id, true);
    if (window.YDSubs && YDSubs.render) YDSubs.render();
    const sec = el('subsSection');
    if (sec) setTimeout(() => { try { sec.scrollIntoView({ block: 'start' }); } catch (e) { /* old browser */ } }, 50);
  };
  window.custGoWorker = function (uid) { window.closeCustomer(); window.openWorker(uid); };

  // ------------------------------------------------------------ Check the list
  //
  // Jonah (16 Oct 2026): "customer list needs to be gone back over seems
  // there are discrepencies". What code can see is off, counted, each line
  // opening its fix. The same person twice is the one that matters most;
  // the rest are lists to go through. (The counted ones add up on the
  // view's button; the others are there to look at.)
  function noContact() {
    const order = { customer: 0, past: 1, lead: 2 };
    return Object.values(customers).filter(c => inLists(c) && isQb(c) && !s(c.phone) && !s(c.mobile) && !s(c.email))
      .sort((a, b) => order[kindOf(a)] - order[kindOf(b)] || byName(a, b));
  }
  function qbTrouble() {
    return Object.values(customers).filter(c => isQb(c) && (c.qbPending || c.qbConflict || c.qbError)).sort(byName);
  }
  function subCustomers() {
    return Object.values(customers).filter(c => c.qbParentId && !isTwin(c)).sort((a, b) => s(a.qbFullName || a.name).localeCompare(s(b.qbFullName || b.name)));
  }
  // A job tied to a customer whose name has not one word in common with the
  // job's: tied to the wrong one, or one of the two renamed. ("Acme" and
  // "Acme - Back Patio" share one; "Smith, John" and "John Smith" are the
  // same words.) "The names are fine" is remembered on the customer.
  function nameMismatches() {
    if (!can('jobs', 'see')) return [];
    const out = [];
    allJobs().forEach(j => {
      if (!j.customerId || j.removeWhy) return;
      const c = customers[resolve(j.customerId)];
      if (!c || (c.namesOk || []).indexOf(j._id) !== -1) return;
      const jt = nameTokens(j.customerName || [j.firstName, j.lastName].join(' ') || j.business);
      if (!jt.length) return;
      const recs = [c, customers[mainOf(c.id)], parentOf(c)].filter(Boolean);
      const words = {};
      recs.forEach(x => [x.name, x.business, x.firstName, x.lastName, s(x.qbFullName).replace(/:/g, ' ')].forEach(t => nameTokens(t).forEach(w => { words[w] = true; })));
      if (jt.some(w => words[w])) return;
      out.push({ job: j, c: c });
    });
    return out.sort((a, b) => s(a.job.customerName).localeCompare(s(b.job.customerName)));
  }
  function checkLines() {
    const cnt = counted(), dups = cnt.dups;
    // word: [said of one, said of more]
    const lines = [
      { key: 'dups', icon: '👯', n: dups.groups.length, counts: true, word: ['person looks to be in the list twice', 'people look to be in the list twice'],
        none: 'Nobody looks to be in the list twice' },
      { key: 'leads', icon: '🌱', n: cnt.leadsMiss, counts: true, word: ['lead is missing a phone, email or address', 'leads are missing a phone, email or address'],
        none: 'Every lead has a phone, email and address' },
      { key: 'qb', icon: '🔄', n: cnt.qb, counts: true, word: ['change is not in QuickBooks yet — or was changed there too', 'changes are not in QuickBooks yet — or were changed there too'],
        none: 'Every change is in QuickBooks' },
    ];
    if (can('jobs', 'see')) lines.push({ key: 'names', icon: '🏷', n: cnt.names, counts: true,
      word: ['job’s name shares no word with its customer’s', 'jobs’ names share no word with their customer’s'], none: 'Every job’s name fits its customer' });
    lines.push(
      { key: 'nocontact', icon: '📵', n: noContact().length, counts: false, word: ['customer has no phone and no email', 'customers have no phone and no email'],
        none: 'Every customer has a phone or email' },
      { key: 'shared', icon: '☎️', n: dups.crowded.length, counts: false, word: ['phone or email is on more than six customers', 'phones or emails are on more than six customers'], none: '' },
      { key: 'subs', icon: '🗂', n: subCustomers().length, counts: false, word: ['sub-customer in QuickBooks — shown on its parent’s page', 'sub-customers in QuickBooks — shown on their parent’s page'], none: '' },
      { key: 'sort', icon: '🧩', n: sortCount(), counts: false, word: ['job, snow account or old contact to tie to its customer', 'jobs, snow accounts and old contacts to tie to their customer'],
        none: 'Everything is tied to its customer' },
      { key: 'off', icon: '🕰', n: Object.values(customers).filter(c => inLists(c) && c.qbActive === false).length, counts: false,
        word: ['is switched off in QuickBooks — shown under Past', 'are switched off in QuickBooks — shown under Past'], none: '' });
    return lines;
  }
  function checkHtml(lines) {
    let h = '<div class="hint">What looks off in the list. Tap a line to go through it.</div>';
    lines.forEach(x => {
      if (!x.n && !x.none) return;
      if (!x.n) { h += '<div class="cu-check ok">✓ ' + esc(x.none) + '</div>'; return; }
      const open = checkPart === x.key;
      h += '<button class="cu-check' + (open ? ' on' : '') + (x.counts ? ' warn' : '') + '" onclick="custCheck(\'' + x.key + '\')">' +
        '<span class="cu-check-i">' + x.icon + '</span><span class="cu-check-t"><b>' + x.n + '</b> ' + esc(x.word[x.n === 1 ? 0 : 1]) + '</span>' +
        '<span class="cu-check-go">' + (x.key === 'leads' || x.key === 'sort' ? '›' : open ? '▴' : '▾') + '</span></button>';
      if (open) h += '<div class="cu-check-part">' + checkPartHtml(x.key) + '</div>';
    });
    return h;
  }
  window.custCheck = function (key) {
    if (key === 'leads') { window.custFillStart('leads'); return; }
    if (key === 'sort') { window.custView('sort'); return; }
    if (key === 'off') { window.custView('past'); return; }
    checkPart = checkPart === key ? '' : key;
    showN = SHOW_STEP;
    render();
  };
  function checkPartHtml(key) {
    const ch = can('contacts', 'change');
    if (key === 'dups') return dupHtml(dupGroups().groups);
    if (key === 'nocontact') {
      const list = noContact();
      return (fill && fill.from === 'check' ? fillHtml()
        : ch ? '<div class="cu-fillbar"><span>Current customers first, then past ones.</span><button class="btn btn-sm btn-filled" onclick="custFillStart(\'nocontact\')">✎ Fill them in, one after another</button></div>' : '') +
        list.slice(0, showN).map(c => '<div class="cu-row"><div class="cu-main"><button class="cu-name" onclick="openCustomer(\'' + sid(c.id) + '\')">' + esc(shownName(c)) + '</button>' +
          (kindOf(c) !== 'customer' ? ' <span class="cu-kind k-' + kindOf(c) + '">' + KIND_WORD[kindOf(c)] + '</span>' : '') +
          (c.address ? '<div class="pp-contact">' + esc(c.address) + '</div>' : '') + '</div>' +
          (ch ? '<div class="cu-act"><button class="btn btn-sm" onclick="custFillOne(\'' + sid(c.id) + '\')">✎ Fill in</button></div>' : '') + '</div>').join('') + more(list.length);
    }
    if (key === 'qb') {
      return qbTrouble().map(c => '<div class="cu-row"><div class="cu-main"><button class="cu-name" onclick="openCustomer(\'' + sid(c.id) + '\')">' + esc(shownName(c)) + '</button>' +
        '<div class="cu-line ' + (c.qbConflict ? 'warn' : 'muted') + '">' + (c.qbConflict ? 'QuickBooks was changed too — pick which is right on their page'
          : c.qbError ? 'QuickBooks said: ' + esc((c.qbError && c.qbError.message) || 'no') : 'Waiting to go to QuickBooks (' + esc(((c.qbPending || {}).fields || []).map(k => FIELD_WORD[k] || k).join(', ')) + ')') + '</div></div>' +
        '<div class="cu-act"><button class="btn btn-sm" onclick="openCustomer(\'' + sid(c.id) + '\')">Open</button></div></div>').join('');
    }
    if (key === 'names') {
      const list = nameMismatches();
      return '<div class="hint">A job tied to the wrong customer, or one of them renamed. “Not theirs” sends the job back to To sort.</div>' +
        list.slice(0, showN).map(x => '<div class="cu-row"><div class="cu-main">' +
          '<div>Job: <b>' + (typeof jobNameHtml === 'function' ? jobNameHtml(x.job.customerName, x.job.estimateNumber) : esc(x.job.customerName)) + '</b> <span class="muted">' + esc(jobWord(x.job)) + '</span></div>' +
          '<div>Tied to: <button class="link-btn" onclick="openCustomer(\'' + sid(x.c.id) + '\')">' + esc(shownName(x.c)) + '</button></div></div>' +
          '<div class="cu-act cu-btns"><button class="btn btn-sm" onclick="custOpenJob(\'' + sid(x.job._id) + '\')">Open the job</button>' +
            (can('jobs', 'change') ? '<button class="btn btn-sm" onclick="custUnlinkJob(\'' + sid(x.job._id) + '\')">Not theirs</button>' : '') +
            (ch ? '<button class="btn btn-sm" onclick="custNamesOk(\'' + sid(x.c.id) + '\', \'' + sid(x.job._id) + '\')">The names are fine</button>' : '') +
          '</div></div>').join('') + more(list.length);
    }
    if (key === 'shared') {
      return '<div class="hint">Usually your own number or email, or an office line, typed on many customers. Fix any that are wrong on their pages.</div>' +
        dupGroups().crowded.map(x => '<div class="cu-sort"><b>' + esc(x.what === 'phone' ? x.value.replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') : x.value) + '</b> <span class="muted">on ' + x.ids.length + '</span>' +
          '<div class="cu-picks">' + x.ids.map(id => customers[id]).filter(Boolean).sort(byName).map(c => '<button class="cu-chip" onclick="openCustomer(\'' + sid(c.id) + '\')">' + esc(shownName(c)) + '</button>').join('') + '</div></div>').join('');
    }
    if (key === 'subs') {
      const list = subCustomers();
      return '<div class="hint">QuickBooks keeps some jobs or places as sub-customers (“Parent:Job”). Job Hub shows them on their parent’s page instead of as people of their own — tap “Show as its own person” for one that really is someone else.</div>' +
        list.slice(0, showN).map(c => {
          const p = parentOf(c);
          return '<div class="cu-row"><div class="cu-main"><button class="cu-name" onclick="openCustomer(\'' + sid(c.id) + '\')">' + esc(s(c.qbFullName || c.name).replace(/:/g, ' › ')) + '</button>' +
            (c.address ? '<div class="pp-contact">' + esc(c.address) + '</div>' : '') +
            '<div class="cu-line muted">' + (!p ? 'Its parent is not in the list — shown as its own' : c.showOwn ? 'Shown as its own person' : 'Shown on ' + esc(p.name) + '’s page') + '</div></div>' +
            (ch && p ? '<div class="cu-act"><button class="btn btn-sm" onclick="custShowOwn(\'' + sid(c.id) + '\', ' + (!c.showOwn) + ')">' + (c.showOwn ? 'Show it under ' + esc(p.name) : 'Show as its own person') + '</button></div>' : '') +
            '</div>';
        }).join('') + more(list.length);
    }
    return '';
  }
  window.custNamesOk = function (custId, jobId) {
    const c = customers[custId];
    if (!c) return;
    const before = { namesOk: c.namesOk || null };
    write(custId, { namesOk: (c.namesOk || []).concat([jobId]) }, 'the names');
    render();
    if (typeof showUndo === 'function') showUndo('Left as it is', () => { write(custId, before, 'the names'); render(); });
  };
  window.custShowOwn = function (id, on) {
    const c = customers[id];
    if (!c) return;
    write(id, { showOwn: on ? true : null }, 'how it is shown');
    render();
    if (openId) renderPage(true);
    showToast(on ? 'Shown as its own person' : 'Shown on its parent’s page');
  };

  // ------------------------------------------------------------ the same person twice
  //
  // Found by code (no Claude): the same phone, the same email, or the same
  // name written another way -- "Smith, John" is John Smith, "John Smith 2"
  // and "John A. Smith" are too, "LLC" and "(deleted)" left out --, a name
  // one letter off ("Jon Smith"), or one name inside the other ("Lisa Olson"
  // and "Mark & Lisa Olson"). Never a parent and its sub-customers, never two
  // marked "Not the same". A phone or email on more than six customers is an
  // office line or his own, not a duplicate: listed apart ("shared").
  const NAME_STOP = { the: 1, and: 1, llc: 1, inc: 1, co: 1, corp: 1, company: 1, of: 1, mr: 1, mrs: 1, ms: 1, dr: 1, deleted: 1 };
  function nameTokens(t) {
    let v = low(t).replace(/\(deleted\)/g, ' ');
    const comma = v.match(/^([^,]+),\s*([^,]+)$/);
    if (comma && !/\b(llc|inc|co|corp)\b/.test(comma[2])) v = comma[2] + ' ' + comma[1];
    return v.replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(w => w.length >= 2 && !NAME_STOP[w] && !/^\d+$/.test(w));
  }
  const nameKey = t => nameTokens(t).sort().join(' ');
  function namesOf(c) {
    const out = [];
    [c.name, c.business, [s(c.firstName), s(c.lastName)].join(' ')].forEach(t => { const k = nameKey(t); if (k && out.indexOf(k) === -1) out.push(k); });
    return out;
  }
  const notSameAs = (a, b) => (a.notSame || []).indexOf(b.id) !== -1 || (b.notSame || []).indexOf(a.id) !== -1;
  function related(a, b) {
    const pa = s(a.qbParentId), pb = s(b.qbParentId);
    return !!((pa && (pa === s(b.qbCustomerId) || pa === pb)) || (pb && pb === s(a.qbCustomerId)));
  }
  // Every word of one of a's names in one of b's (two words at least).
  function inside(a, b) {
    const ta = namesOf(a).map(k => k.split(' ')), tb = namesOf(b).map(k => k.split(' '));
    const sub = (x, y) => x.length >= 2 && x.length < y.length && x.every(w => y.indexOf(w) !== -1);
    return ta.some(x => tb.some(y => sub(x, y) || sub(y, x)));
  }
  const WHY = { ph: 'Same phone', em: 'Same email', nm: 'Same name', fz: 'Names one letter apart', pr: 'One name inside the other' };
  const WHY_RANK = ['Same phone', 'Same email', 'Same name', 'One name inside the other', 'Names one letter apart'];
  const CROWDED = 6;
  let dupCache = null;
  function dupGroups() {
    if (dupCache && dupCache.ver === ver) return dupCache;
    const list = Object.values(customers).filter(inLists);
    const byId = {};
    list.forEach(c => { byId[c.id] = c; });
    const buckets = {};
    const add = (k, id) => { const b = buckets[k] || (buckets[k] = []); if (b.indexOf(id) === -1) b.push(id); };
    list.forEach(c => {
      [digits(c.phone), digits(c.mobile)].forEach(d => { if (d.length === 10) add('ph:' + d, c.id); });
      const em = low(c.email);
      if (em.indexOf('@') > 0) add('em:' + em, c.id);
      namesOf(c).forEach(k => {
        add('nm:' + k, c.id);
        // One letter added, dropped or changed: both names with one letter
        // taken out meet.
        if (k.replace(/ /g, '').length >= 8) {
          add('fz:' + k, c.id);
          for (let i = 0; i < k.length; i++) if (k[i] !== ' ') add('fz:' + k.slice(0, i) + k.slice(i + 1), c.id);
        }
        const t = k.split(' ');
        if (t.length >= 2 && t.length <= 5) {
          for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) add('pr:' + t[i] + ' ' + t[j], c.id);
        }
      });
    });
    const pairs = {}, crowded = [];
    Object.keys(buckets).forEach(k => {
      const ids = buckets[k], kind = k.slice(0, 2);
      if (ids.length < 2) return;
      if (ids.length > CROWDED) {
        if (kind === 'ph' || kind === 'em') crowded.push({ what: kind === 'ph' ? 'phone' : 'email', value: k.slice(3), ids: ids });
        return;
      }
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = byId[ids[i]], b = byId[ids[j]];
        if (!a || !b || notSameAs(a, b) || related(a, b)) continue;
        if (kind === 'pr' && !inside(a, b)) continue;
        const pk = [a.id, b.id].sort().join('|');
        (pairs[pk] = pairs[pk] || {})[WHY[kind]] = true;
      }
    });
    // Pairs that share someone are one group (A and B the same phone, B and
    // C the same name: all three).
    const up = {};
    const find = x => { let r = x; while (up[r] && up[r] !== r) r = up[r]; return r; };
    Object.keys(pairs).forEach(pk => { const p = pk.split('|'), a = find(p[0]), b = find(p[1]); if (a !== b) up[a] = b; });
    const by = {};
    Object.keys(pairs).forEach(pk => {
      const p = pk.split('|'), g = by[find(p[0])] || (by[find(p[0])] = { ids: [], why: {} });
      p.forEach(x => { if (g.ids.indexOf(x) === -1) g.ids.push(x); });
      Object.keys(pairs[pk]).forEach(w => { g.why[w] = true; });
    });
    const groups = Object.values(by).map(g => {
      g.ids.sort();
      let why = Object.keys(g.why).sort((a, b) => WHY_RANK.indexOf(a) - WHY_RANK.indexOf(b));
      if (why.indexOf('Same name') !== -1) why = why.filter(w => w !== 'Names one letter apart');
      return { key: g.ids.join('_'), ids: g.ids, why: why };
    }).sort((a, b) => WHY_RANK.indexOf(a.why[0]) - WHY_RANK.indexOf(b.why[0]) ||
      s((customers[a.ids[0]] || {}).name).localeCompare(s((customers[b.ids[0]] || {}).name)));
    crowded.sort((a, b) => b.ids.length - a.ids.length);
    dupCache = { ver: ver, groups: groups, crowded: crowded };
    return dupCache;
  }
  const qbLink = c => 'https://qbo.intuit.com/app/customerdetail?nameId=' + encodeURIComponent(s(c.qbCustomerId));
  // The main one, unless picked: a QuickBooks customer before a lead, one
  // switched on in QuickBooks before one switched off, then the one worked
  // for or bid most lately, then the one with more jobs.
  function mainFor(g) {
    const recs = g.ids.map(id => customers[id]).filter(Boolean);
    const qbs = recs.filter(isQb);
    const picked = customers[dupMain[g.key]];
    if (picked && g.ids.indexOf(picked.id) !== -1 && (!qbs.length || isQb(picked))) return picked.id;
    const pool = qbs.length ? qbs : recs;
    return pool.slice().sort((a, b) => (b.qbActive !== false) - (a.qbActive !== false) ||
      lastActivity(b).localeCompare(lastActivity(a)) || jobsFor(b).length - jobsFor(a).length || s(a.id).localeCompare(s(b.id)))[0].id;
  }
  function dupHtml(groups) {
    if (!groups.length) return '<p class="empty-msg">Nobody looks like they’re in the list twice. ✓</p>';
    return '<div class="hint">Two leads, or a lead and a customer: the lead is merged in. Two QuickBooks customers: Job Hub shows them as one, ' +
      'under the main one — merging them for good is done in QuickBooks. “Not the same” is remembered and never asked again. Nothing is deleted.</div>' +
      groups.slice(0, showN).map(dupCardHtml).join('') + more(groups.length);
  }
  function dupCardHtml(g) {
    const recs = g.ids.map(id => customers[id]).filter(Boolean);
    if (recs.length < 2) return '';
    const qbs = recs.filter(isQb), main = mainFor(g), m = customers[main];
    const others = recs.filter(c => c.id !== main);
    const leads = others.filter(c => !isQb(c)), twins = others.filter(isQb);
    const ch = can('contacts', 'change');
    // What "Same person" will do, said before it is tapped.
    const what = [leads.length ? (leads.length === 1 ? 'The lead is' : 'The leads are') + ' merged into ' + s(m.name) + ' — notes, services and time to call carried across.' : '',
      twins.length ? twins.map(t => s(t.name)).join(', ') + ' stay' + (twins.length === 1 ? 's' : '') + ' in QuickBooks, shown as one with ' + s(m.name) + '.' : ''].filter(Boolean).join(' ');
    const facts = c => {
      const jobs = jobsFor(c).length, last = lastActivity(c);
      return [c.phone ? '📞 ' + esc(c.phone) : '', c.mobile && c.mobile !== c.phone ? '📱 ' + esc(c.mobile) : '', c.email ? esc(c.email) : '',
        c.address ? esc(c.address) : '', jobs ? jobs + ' job' + (jobs === 1 ? '' : 's') + ' or bid' + (jobs === 1 ? '' : 's') : '',
        last ? 'last work or bid ' + esc(niceDay(last)) : '',
        isQb(c) ? '<a href="' + esc(qbLink(c)) + '" target="_blank" rel="noopener">QuickBooks ↗</a>' : ''].filter(Boolean).join(' · ');
    };
    let h = '<div class="cu-dup"><div class="cu-dup-why">' + esc(g.why.join(' · ')) + '</div>';
    h += recs.map(c => {
      const isMain = c.id === main, k = kindOf(c);
      return '<div class="cu-dup-one' + (isMain ? ' main' : '') + '">' +
        '<div><button class="cu-name" onclick="openCustomer(\'' + sid(c.id) + '\')">' + esc(shownName(c)) + '</button> ' +
          '<span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span>' + (c.qbActive === false ? ' <span class="cu-kind">Off in QuickBooks</span>' : '') + '</div>' +
        '<div class="cu-dup-facts">' + (facts(c) || '<span class="muted">No phone, email or address</span>') + '</div>' +
        (ch ? '<div class="cu-btns">' +
          ((isQb(c) || !qbs.length) ? '<button class="cu-chip' + (isMain ? ' on' : '') + '" onclick="custDupMain(\'' + g.key + '\', \'' + sid(c.id) + '\')">' +
            (isMain ? '★ The main one' : 'Make it the main one') + '</button>' : '') +
          (recs.length > 2 ? '<button class="cu-chip" onclick="custDupNot(\'' + g.key + '\', \'' + sid(c.id) + '\')">Not the same as the others</button>' : '') +
          '</div>' : '') +
      '</div>';
    }).join('');
    if (ch) {
      const other = twins[0];
      h += '<div class="cu-dup-what">' + esc(what) + '</div>' +
        '<div class="cu-dup-acts"><button class="btn btn-filled" onclick="custDupSame(\'' + g.key + '\')">✓ Same person — keep ' + esc(m.name) + '</button>' +
        '<button class="btn" onclick="custDupNot(\'' + g.key + '\', \'\')">Not the same</button>' +
        (other ? '<a class="btn btn-sm" target="_blank" rel="noopener" href="' + esc(qbLink(other)) + '">Merge in QuickBooks yourself ↗</a>' : '') + '</div>' +
        (other ? '<div class="hint">For good, in QuickBooks: open ' + esc(other.name) + ', change its name to exactly “' + esc(m.name) +
          '” and say yes when QuickBooks asks to merge them. Until then Job Hub shows them as one; new estimates go to ' + esc(m.name) + '.</div>' : '');
    }
    return h + '</div>';
  }
  window.custDupMain = function (key, id) { dupMain[key] = Object.keys(customers).find(x => sid(x) === id) || id; render(); };
  window.custDupSame = function (key) {
    const g = dupGroups().groups.find(x => x.key === key);
    if (!g) return;
    const main = mainFor(g);
    joinOnto(main, g.ids.filter(id => id !== main && customers[id]));
  };
  // "Not the same": remembered on both (notSame), so they are never put
  // together again -- the whole group, or one of it apart from the others.
  window.custDupNot = function (key, only) {
    const g = dupGroups().groups.find(x => x.key === key);
    if (!g) return;
    const ids = g.ids.filter(id => customers[id]);
    const one = only ? ids.find(id => sid(id) === only) : null;
    const lists = {};
    const mark = (a, b) => {
      const la = lists[a] || (lists[a] = (customers[a].notSame || []).slice());
      if (la.indexOf(b) === -1) la.push(b);
    };
    ids.forEach(a => ids.forEach(b => {
      if (a === b) return;
      if (one && a !== one && b !== one) return;
      mark(a, b);
    }));
    const before = Object.keys(lists).map(id => [id, { notSame: customers[id].notSame || null }]);
    Object.keys(lists).forEach(id => write(id, { notSame: lists[id] }, 'not the same'));
    render();
    if (typeof showUndo === 'function') showUndo(one ? 'Kept apart from the others' : 'Kept apart — not asked again', () => {
      before.forEach(([id, p]) => write(id, p, 'not the same'));
      render();
    });
  };

  // What Job Hub alone knows about someone, carried onto the one they are
  // the same as -- as the server carries a lead onto its new QuickBooks
  // customer (customers.py estimate_made): lists joined, notes added, the
  // time to call (as one) and the rest only where the main one has none.
  const HUB_KEYS = ['tags', 'note', 'meetings', 'reachedAt', 'declined', 'notInterested', 'fromProspect', 'addedAt', 'contactYears'];
  function carryPatch(cur, x) {
    const p = {};
    const sig = o => JSON.stringify(o);
    HUB_KEYS.forEach(k => {
      const v = x[k];
      if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) return;
      if (Array.isArray(v)) {
        const have = cur[k] || [];
        const add = v.filter(o => !have.some(h => sig(h) === sig(o)));
        if (add.length) p[k] = have.concat(add);
      } else if (k === 'note') {
        if (s(cur.note).indexOf(s(v)) === -1) p.note = [s(cur.note), s(v)].filter(Boolean).join('\n');
      } else if (k === 'reachedAt') {
        if (s(v) > s(cur.reachedAt)) p.reachedAt = v;
      } else if (k === 'contactYears') {
        // "Contact in <year>" picks: a year the main one has none for.
        const have = cur.contactYears || {}, add = {};
        Object.keys(v || {}).forEach(y => { if (v[y] && !have[y]) add[y] = v[y]; });
        if (Object.keys(add).length) p.contactYears = Object.assign({}, have, add);
      } else if (!cur[k]) {
        p[k] = v;
      }
    });
    if (!windowOf(cur) && windowOf(x)) {
      p.when = x.when || null;
      p.contactWhen = s(x.contactWhen);
      p.whenSetAt = x.whenSetAt || new Date().toISOString();
    }
    return p;
  }
  // Two or more records that are one person, onto the main one:
  //   a lead -- its Job Hub notes carried, marked mergedInto the main one
  //     (kept, never deleted), its jobs and snow accounts tied to the main
  //     one; its phone, email and address fill what the main one is missing
  //     (a lead main one: saved; a QuickBooks one: put in its form to Save,
  //     so nothing goes to QuickBooks without a tap).
  //   a QuickBooks customer -- marked sameAs the main one; its notes carried.
  // One Undo puts every bit of it back.
  function joinOnto(mainId, otherIds) {
    if (!can('contacts', 'change')) return;
    const m = customers[mainId];
    if (!m || !otherIds.length) return;
    const nowIso = new Date().toISOString();
    const me = (window.YDAuth && window.YDAuth.user && window.YDAuth.user.uid) || null;
    let cur = Object.assign({}, m);
    const mainPatch = {};
    const fillIn = {};
    const undo = [];
    const jobsMoved = [], snowMoved = [];
    otherIds.forEach(id => {
      const x = customers[id];
      if (!x || id === mainId) return;
      const p = carryPatch(cur, x);
      Object.assign(mainPatch, p);
      cur = Object.assign(cur, p);
      if (!isQb(x)) {
        // The lead's way to reach them where the main one has none: a phone
        // (both boxes) when it has no phone at all, an email, the whole
        // address when it has none (never one street with another's town).
        // Names stay the main one's.
        const has = k => s(cur[k]) || s(fillIn[k]);
        if (!has('phone') && !has('mobile')) ['phone', 'mobile'].forEach(k => { if (s(x[k])) fillIn[k] = s(x[k]); });
        if (!has('email') && s(x.email)) fillIn.email = s(x.email);
        if (!has('street') && !has('city') && !s(cur.address) && (s(x.street) || s(x.city))) {
          ['street', 'city', 'state', 'zip'].forEach(k => { if (s(x[k])) fillIn[k] = s(x[k]); });
        }
        const copy = Object.assign({}, x);
        write(id, { mergedInto: mainId, mergedAt: nowIso }, 'merging');
        merged[id] = mainId;
        delete customers[id];
        undo.push(() => { customers[id] = copy; delete merged[id]; write(id, { mergedInto: null, mergedAt: null }, 'merging'); });
        if (can('jobs', 'change') && window.YDSync) {
          allJobs().forEach(j => { if (j.customerId === id) { YDSync.patchJob(j._id, { customerId: mainId }); jobsMoved.push([j._id, id]); } });
        }
        if (can('snow', 'change') && window.YDSnow) {
          const acc = YDSnow.accounts() || {};
          Object.keys(acc).forEach(a => {
            if (!acc[a] || acc[a].customerId !== id) return;
            acc[a].customerId = mainId;
            snowMoved.push([a, id]);
            Promise.resolve(window.YDDb.put('snowAccounts', a, { customerId: mainId })).catch(e => console.warn('[customers] snow account not moved:', e && e.code));
          });
        }
      } else {
        const was = { sameAs: x.sameAs || null, sameAsAt: x.sameAsAt || null, sameAsBy: x.sameAsBy || null };
        write(id, { sameAs: mainId, sameAsAt: nowIso, sameAsBy: me }, 'showing them as one');
        undo.push(() => write(id, was, 'showing them as one'));
      }
    });
    // A lead main one takes the details at once; a QuickBooks one has them
    // put in its form, to send with Save.
    let toForm = null;
    if (Object.keys(fillIn).length) {
      if (isQb(m)) toForm = fillIn;
      else {
        Object.assign(mainPatch, fillIn);
        const now = Object.assign({}, m, fillIn);
        if (['street', 'city', 'state', 'zip'].some(k => k in fillIn)) mainPatch.address = lineOf(now);
      }
    }
    if (Object.keys(mainPatch).length) {
      const before = {};
      Object.keys(mainPatch).forEach(k => { before[k] = k in m ? m[k] : null; });
      write(mainId, mainPatch, 'merging');
      undo.push(() => write(mainId, before, 'merging'));
    }
    jobsMoved.forEach(([jid, was]) => undo.push(() => YDSync.patchJob(jid, { customerId: was })));
    snowMoved.forEach(([a, was]) => undo.push(() => {
      const acc = (window.YDSnow && YDSnow.accounts()) || {};
      if (acc[a]) acc[a].customerId = was;
      Promise.resolve(window.YDDb.put('snowAccounts', a, { customerId: was })).catch(() => {});
    }));
    ver++;
    render();
    const nLeads = otherIds.filter(id => merged[id] === mainId).length, nTwins = otherIds.length - nLeads;
    const msg = [nLeads ? (nLeads === 1 ? 'Lead' : nLeads + ' leads') + ' merged into ' + s(m.name) : '',
      nTwins ? 'Shown as one under ' + s(m.name) : ''].filter(Boolean).join(' · ');
    const back = () => {
      undo.reverse().forEach(f => f());
      if (prefill && prefill.id === mainId) { prefill = null; editing = false; }
      ver++;
      render();
      if (openId) renderPage(true);
    };
    if (typeof showUndo === 'function') showUndo(msg, back); else showToast(msg);
    if (toForm) {
      // Their details are on the form, waiting for Save.
      window.openCustomer(mainId);
      prefill = { id: mainId, fields: toForm };
      editing = true;
      renderPage(true);
    }
  }

  // ------------------------------------------------------------ writing
  //
  // Not awaited: Firestore applies a write here at once and settles only when
  // the server answers -- awaiting would freeze the screen with no signal.
  function write(id, data, what) {
    if (!window.YDDb) { showToast('Not saved — the app has not finished connecting'); return; }
    if (!can('contacts', 'change')) { showToast('You can look at customers but not change them'); return; }
    data = Object.assign({}, data, { updatedAt: new Date().toISOString() });
    if (customers[id]) Object.assign(customers[id], data);
    ver++;
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

  window.custSnowCalled = function (id, on) {
    const c = customers[id];
    if (!c) return;
    const before = { snowCalledAt: c.snowCalledAt || null };
    write(id, { snowCalledAt: on ? new Date().toISOString() : null }, 'called about snow');
    render();
    if (on && typeof showUndo === 'function') showUndo('Called ' + (c.name || '') + ' about snow', () => { write(id, before, 'called about snow'); render(); });
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
    openId = id; editing = false; whenLater = false; whenPicking = false; otherOpen = null; prefill = null;
    delete tagFind[id]; delete tagAll[id];
    renderPage(true);
    el('custModal').classList.add('active');
  };
  window.closeCustomer = function () {
    const o = el('custModal');
    if (o) o.classList.remove('active');
    openId = null; editing = false; otherOpen = null; prefill = null;
  };

  function renderPage(force) {
    const c = customers[openId], body = el('custBody');
    if (!c || !body) return;
    // A note or a form being typed in keeps what is typed (the list redraws
    // under it whenever anyone changes anything) -- unless the redraw is
    // what was asked for (another customer opened, the form saved).
    const act = document.activeElement;
    if (!force && act && body.contains(act) && /^(cuF|cuWhen|cuNote|cuTag|cuNB)/.test(act.id || '')) return;
    const k = kindOf(c), ch = can('contacts', 'change');
    el('custTitle').textContent = c.name || '(no name)';
    const id = sid(c.id);
    const phone = c.phone, mob = c.mobile;
    const dir = c.address ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(c.address) : '';
    let h = '<div class="cu-head"><span class="cu-kind k-' + k + '">' + KIND_WORD[k] + '</span>' +
      (c.business && c.business !== c.name ? ' <span class="muted">' + esc(c.business) + '</span>' : '') +
      (c.qbParentId && c.qbFullName ? ' <span class="muted">' + esc(c.qbFullName.replace(/:/g, ' › ')) + '</span>' : '') +
      (isQb(c) && can('billing', 'see') ? ' <a class="cu-qblink" href="' + esc(qbLink(c)) + '" target="_blank" rel="noopener">QuickBooks ↗</a>' : '') + '</div>';
    h += placeHtml(c, ch);
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
    // A second profile: the calling is done on the main one's page.
    if (isTwin(c)) {
      const m = customers[mainOf(c.id)];
      h += '<div class="cu-sec muted">Its time to call, services and notes are on <button class="link-btn" onclick="openCustomer(\'' + sid(m.id) + '\')">' +
        esc(m.name) + '’s page</button>.</div>';
      h += workHtml(c);
      body.innerHTML = h;
      return;
    }
    // When to call
    h += whenHtml(c, ch);
    h += nyPageHtml(c, ch);
    // Tags: the ones picked, and a search box over the services list.
    h += '<div class="cu-sec"><div class="cu-sec-h">What for</div><div class="pp-svc">' +
      ((c.tags || []).length ? c.tags.map((t, i) => '<span class="svc-tag">' + esc(t) +
        (ch ? '<button onclick="custTagOff(\'' + id + '\', ' + i + ')" title="Remove">&times;</button>' : '') + '</span>').join('') : '<span class="tag-none">No services yet</span>') +
      '</div>' + (ch ? tagPickerHtml(c.id) : '') + '</div>';
    // Notes
    const meets = (c.meetings || []).slice().sort((a, b) => s(b.at).localeCompare(s(a.at)));
    h += '<div class="cu-sec"><div class="cu-sec-h">Notes</div>' +
      (c.note ? '<div class="pp-note">' + esc(c.note) + '</div>' : '') +
      (ch ? '<textarea id="cuNote_' + id + '" rows="3" placeholder="What you talked about, what they want…" oninput="custNoteDraft(\'' + id + '\', this.value)">' + esc(drafts[c.id] || '') + '</textarea>' +
        '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="custSaveNote(\'' + id + '\')">Save note</button></div>' : '') +
      meets.map(m => '<div class="pp-meet-item"><div class="pp-meet-when">' + esc(niceDay(localDay(m.at))) + '</div><div class="pp-meet-text">' + esc(m.text) + '</div></div>').join('') +
      '</div>';
    h += familyHtml(c, ch);
    h += workHtml(c);
    if (ch && k === 'lead') {
      h += '<div class="cu-sec"><button class="link-btn" onclick="custRemoveLead(\'' + id + '\')">🗑 Take this lead off the list</button></div>';
    }
    body.innerHTML = h;
  }

  // Where this one stands: a second QuickBooks profile shown as one with its
  // main one, or a sub-customer shown on its parent's page.
  function placeHtml(c, ch) {
    const id = sid(c.id);
    if (isTwin(c)) {
      const m = customers[mainOf(c.id)];
      return '<div class="cu-place">The same person as <b>' + esc(m.name) + '</b> — a second profile in QuickBooks, shown as one with it.' +
        '<div class="cu-btns"><button class="btn btn-sm" onclick="openCustomer(\'' + sid(m.id) + '\')">Open ' + esc(m.name) + '</button>' +
        (ch ? '<button class="btn btn-sm" onclick="custTwinMain(\'' + id + '\')">Make this the main one</button>' +
          '<button class="btn btn-sm" onclick="custTwinApart(\'' + id + '\')">Not the same person</button>' : '') + '</div></div>';
    }
    const p = parentOf(c);
    if (c.qbParentId && p) {
      return '<div class="cu-place">Under <b>' + esc(p.name) + '</b> in QuickBooks — ' +
        (c.showOwn ? 'shown as its own person too.' : 'shown on their page, not as a person of its own.') +
        '<div class="cu-btns"><button class="btn btn-sm" onclick="openCustomer(\'' + sid(p.id) + '\')">Open ' + esc(p.name) + '</button>' +
        (ch ? '<button class="btn btn-sm" onclick="custShowOwn(\'' + id + '\', ' + (!c.showOwn) + ')">' +
          (c.showOwn ? 'Show it under ' + esc(p.name) + ' only' : 'Show as its own person') + '</button>' : '') + '</div></div>';
    }
    return '';
  }
  // The ones shown on this page with them.
  function familyHtml(c, ch) {
    const all = Object.values(customers);
    const twins = all.filter(x => x.id !== c.id && isTwin(x) && mainOf(x.id) === c.id).sort(byName);
    const subs = all.filter(x => x.id !== c.id && x.qbParentId && !isTwin(x) && parentOf(x) && parentOf(x).id === c.id)
      .sort((a, b) => s(a.name).localeCompare(s(b.name)));
    let h = '';
    if (twins.length) {
      h += '<div class="cu-sec"><div class="cu-sec-h">Also in QuickBooks as</div>' +
        '<div class="hint">The same person. Their jobs, invoices and snow are on this page; new estimates go to ' + esc(c.name) + '.</div>' +
        twins.map(t => '<div class="cu-fam"><div><button class="link-btn" onclick="openCustomer(\'' + sid(t.id) + '\')">' + esc(t.name) + '</button>' +
          (t.qbActive === false ? ' <span class="cu-kind">Off in QuickBooks</span>' : '') +
          (can('billing', 'see') ? ' <a href="' + esc(qbLink(t)) + '" target="_blank" rel="noopener">QuickBooks ↗</a>' : '') + '</div>' +
          '<div class="pp-contact">' + contactBits(t) + '</div>' +
          (ch ? '<div class="cu-btns"><button class="btn btn-sm" onclick="custTwinMain(\'' + sid(t.id) + '\')">Make it the main one</button>' +
            '<button class="btn btn-sm" onclick="custTwinApart(\'' + sid(t.id) + '\')">Not the same person</button></div>' : '') +
          '</div>').join('') + '</div>';
    }
    if (subs.length) {
      h += '<div class="cu-sec"><div class="cu-sec-h">Under them in QuickBooks (' + subs.length + ')</div>' +
        '<div class="hint">Sub-customers — jobs or places QuickBooks keeps under them. Shown here, not as people of their own.</div>' +
        subs.map(x => '<div class="cu-fam"><div><button class="link-btn" onclick="openCustomer(\'' + sid(x.id) + '\')">' + esc(s(x.name)) + '</button>' +
          (x.showOwn ? ' <span class="cu-kind">Own row too</span>' : '') + (x.qbActive === false ? ' <span class="cu-kind">Off in QuickBooks</span>' : '') + '</div>' +
          (x.address || (x.ship && x.ship.address) ? '<div class="pp-contact">' + esc((x.ship && x.ship.address) || x.address) + '</div>' : '') +
          (ch ? '<div class="cu-btns"><button class="btn btn-sm" onclick="custShowOwn(\'' + sid(x.id) + '\', ' + (!x.showOwn) + ')">' +
            (x.showOwn ? 'Show it here only' : 'Show as its own person') + '</button></div>' : '') +
          '</div>').join('') + '</div>';
    }
    return h;
  }
  const idOf = v => Object.keys(customers).find(x => sid(x) === v) || v;
  // Another of them is to be the main one: everything shown as one with the
  // old main one is shown with this one, the old one too, and what Job Hub
  // knew on the old one is carried across.
  window.custTwinMain = function (v) {
    const id = idOf(v), t = customers[id];
    if (!t || !isTwin(t) || !can('contacts', 'change')) return;
    const oldMain = mainOf(id), m = customers[oldMain];
    const nowIso = new Date().toISOString(), me = (window.YDAuth && window.YDAuth.user && window.YDAuth.user.uid) || null;
    const undo = [];
    const keep = x => ({ sameAs: x.sameAs || null, sameAsAt: x.sameAsAt || null, sameAsBy: x.sameAsBy || null });
    Object.values(customers).filter(x => x.id !== id && x.id !== oldMain && isTwin(x) && mainOf(x.id) === oldMain).forEach(x => {
      const was = keep(x);
      write(x.id, { sameAs: id, sameAsAt: nowIso, sameAsBy: me }, 'showing them as one');
      undo.push(() => write(x.id, was, 'showing them as one'));
    });
    const tWas = keep(t), mWas = keep(m);
    const carry = carryPatch(t, m), carryWas = {};
    Object.keys(carry).forEach(k => { carryWas[k] = k in t ? t[k] : null; });
    write(id, Object.assign({ sameAs: null, sameAsAt: null, sameAsBy: null }, carry), 'showing them as one');
    write(oldMain, { sameAs: id, sameAsAt: nowIso, sameAsBy: me }, 'showing them as one');
    undo.push(() => write(id, Object.assign({}, tWas, carryWas), 'showing them as one'), () => write(oldMain, mWas, 'showing them as one'));
    render();
    window.openCustomer(id);
    if (typeof showUndo === 'function') showUndo(t.name + ' is the main one now', () => { undo.forEach(f => f()); render(); if (openId) renderPage(true); });
  };
  // Not the same person after all: shown on its own again, and kept apart
  // from the main one (notSame) so it is not put back as a duplicate.
  window.custTwinApart = function (v) {
    const id = idOf(v), t = customers[id];
    if (!t || !can('contacts', 'change')) return;
    const mainId = mainOf(id), m = customers[mainId];
    const tWas = { sameAs: t.sameAs || null, sameAsAt: t.sameAsAt || null, sameAsBy: t.sameAsBy || null, notSame: t.notSame || null };
    const mWas = { notSame: (m && m.notSame) || null };
    write(id, { sameAs: null, sameAsAt: null, sameAsBy: null, notSame: (t.notSame || []).concat(m && (t.notSame || []).indexOf(mainId) === -1 ? [mainId] : []) }, 'not the same');
    if (m && (m.notSame || []).indexOf(id) === -1) write(mainId, { notSame: (m.notSame || []).concat([id]) }, 'not the same');
    render();
    if (openId) renderPage(true);
    if (typeof showUndo === 'function') showUndo((t.name || 'It') + ' is shown on its own', () => {
      write(id, tWas, 'not the same');
      if (m) write(mainId, mWas, 'not the same');
      render();
      if (openId) renderPage(true);
    });
  };

  // The time to call: where it stands, and -- with nothing set yet, or
  // "Change when" tapped -- the buttons. Each button shows the window it
  // saves (the next spring, the next March...), "A year later" moving them
  // all a year on.
  function whenHtml(c, ch) {
    const st = callState(c), w = windowOf(c), id = sid(c.id);
    let h = '<div class="cu-sec"><div class="cu-sec-h">When to call</div>';
    const reached = st.done ? ' · ✓ reached ' + esc(niceDay(localDay(c.reachedAt))) : '';
    h += '<div class="cu-when-now">' + (c.notInterested ? 'Not interested — off the call list.'
      : w ? '<b>' + esc(w.how === 'soon' ? w.label : whenText(w)) + '</b> <span class="muted">— ' + (st.on ? 'on the call list now' : 'on the call list from ' + esc(niceDay(w.from))) + reached + '</span>'
      : c.contactWhen ? 'Can’t tell when from “' + esc(c.contactWhen) + '” — pick one below.' : '<span class="muted">No time to call set.</span>') + '</div>';
    if (!ch) return h + '</div>';
    const picking = (whenPicking || !w) && !c.notInterested;
    if (!picking) {
      return h + '<div class="cu-btns">' +
        (st.on ? '<button class="btn btn-sm btn-filled" onclick="custReached(\'' + id + '\')">✓ Reached out</button>' : '') +
        (!c.notInterested ? '<button class="btn btn-sm" onclick="custWhenOpen(true)">Change when</button>' : '') +
        '<button class="btn btn-sm" onclick="custNotInterested(\'' + id + '\', ' + (!c.notInterested) + ')">' + (c.notInterested ? 'Back on the call list' : 'Not interested') + '</button></div></div>';
    }
    const same = x => !!(w && x && x.from === w.from && x.to === w.to);
    const btn = (x, onclick, big, small) => '<button class="cu-chip' + (same(x) ? ' on' : '') + '" onclick="' + onclick + '">' + big +
      (small ? '<small>' + small + '</small>' : '') + '</button>';
    const later = whenLater;
    h += '<div class="cu-when-pick">' +
      '<div class="cu-when-years"><span class="muted">Which one:</span>' +
        '<button class="cu-chip' + (!later ? ' on' : '') + '" onclick="custWhenLater(false)">The next one</button>' +
        '<button class="cu-chip' + (later ? ' on' : '') + '" onclick="custWhenLater(true)">A year later</button></div>' +
      '<div class="cu-when-grid cu-g4">' + SEASON_BTNS.map(([k, word, a, b]) => {
        const x = seasonWindow(k, later);
        return btn(x, 'custWhenPick(\'' + id + '\', \'season\', \'' + k + '\')', esc(x.label), esc(MONTHS[a - 1].replace(/^./, m => m.toUpperCase()) + '–' + MONTHS[b - 1].replace(/^./, m => m.toUpperCase())));
      }).join('') + '</div>' +
      '<div class="cu-when-grid cu-g6">' + MONTH_WORDS.map((word, i) => {
        const x = monthWindow(i + 1, later);
        return btn(x, 'custWhenPick(\'' + id + '\', \'month\', ' + (i + 1) + ')', esc(word.slice(0, 3)), esc(x.from.slice(0, 4)));
      }).join('') + '</div>' +
      '<div class="cu-when-grid cu-g2">' +
        btn(w && w.how === 'soon' ? w : null, 'custWhenPick(\'' + id + '\', \'soon\', 0)', 'In about 1–3 months', esc('from ' + niceDay(soonWindow().from))) +
        (w ? '<button class="cu-chip" onclick="custWhenPick(\'' + id + '\', \'none\', 0)">No time to call<small>off the call list</small></button>' : '') +
      '</div>' +
      '<details class="cu-when-words"' + (c.contactWhen && !c.when ? ' open' : '') + '><summary>Or write it in words</summary>' +
        '<div class="cu-when"><input id="cuWhen" value="' + esc(c.contactWhen || '') + '" placeholder="e.g. next month, early summer 2027, in 3 weeks" onkeydown="if (event.key === \'Enter\') custSaveWhen(\'' + id + '\')">' +
        '<button class="btn btn-sm" onclick="custSaveWhen(\'' + id + '\')">Save</button></div></details>' +
      '<div class="cu-btns">' + (w && whenPicking ? '<button class="btn btn-sm" onclick="custWhenOpen(false)">Keep ' + esc(whenText(w)) + '</button>' : '') +
        '<button class="btn btn-sm" onclick="custNotInterested(\'' + id + '\', true)">Not interested</button></div>' +
      '</div>';
    return h + '</div>';
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

  // A job's status in words, the same on a customer's page and on To sort
  // (which showed the stored "inprogress" / "complete").
  function jobWord(j) {
    const bid = typeof isBidStatus === 'function' && isBidStatus(j.jobStatus);
    return bid ? (j.bidStage === 'lost' ? 'Lost bid' : 'Bid') : ({ booked: 'Booked', inprogress: 'In progress', complete: 'Done' }[j.jobStatus] || s(j.jobStatus));
  }
  function workHtml(c) {
    let h = '';
    // Theirs, and those of the ones shown with them (a second profile, a
    // sub-customer).
    const jobs = jobsFor(c).sort((a, b) => s(b.quoteDate || b.lastModified).localeCompare(s(a.quoteDate || a.lastModified)));
    const bills = can('billing', 'see');
    if (can('jobs', 'see')) {
      const starting = nb && nb.id === c.id;
      h += '<div class="cu-sec"><div class="cu-sec-h">Jobs &amp; bids' +
        (can('jobs', 'change') && !starting ? ' <button class="btn btn-sm" onclick="custStartBid(\'' + sid(c.id) + '\')">Start a bid</button>' : '') + '</div>' +
        (starting && can('jobs', 'change') ? newBidHtml(c, jobs) : '') +
        (jobs.length ? jobs.map(j => {
          const word = jobWord(j);
          const talk = talkOf(j).length;
          return '<div class="cu-job"><button class="link-btn" onclick="custOpenJob(\'' + sid(j._id) + '\')">' +
            (typeof jobNameHtml === 'function' ? jobNameHtml(j.customerName, j.estimateNumber) : esc(j.customerName)) + '</button> ' +
            '<span class="muted">' + esc(word) + (j.quoteDate ? ' · ' + esc(niceDay(s(j.quoteDate).slice(0, 10))) : '') + '</span>' +
            (bills && j.jobPrice ? ' <span class="cu-money">' + esc(money(parseFloat(String(j.jobPrice).replace(/[$,]/g, '')) || 0)) + '</span>' : '') +
            (talk ? ' <button class="link-btn" onclick="custTalk(\'' + sid(j._id) + '\')">💬 ' + talk + ' with Claude' + (talkOpen[j._id] ? ' ▴' : ' ▾') + '</button>' : '') +
            (can('jobs', 'change') ? ' <button class="link-btn cu-unlink" onclick="custUnlinkJob(\'' + sid(j._id) + '\')">Not theirs</button>' : '') +
            (talk && talkOpen[j._id] ? talkHtml(j) : '') +
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
      jobs.forEach(j => (j.payments || []).forEach(p => pays.push({ date: localDay(p.date || p.createdAt), amount: p.amount, label: p.label || p.method || '', job: j.customerName })));
      if (pays.length) {
        pays.sort((a, b) => b.date.localeCompare(a.date));
        h += '<div class="cu-sec"><div class="cu-sec-h">Payments</div>' + pays.map(p => '<div class="cu-job">' + esc(niceDay(p.date)) + ' · ' +
          esc(money(parseFloat(String(p.amount).replace(/[$,]/g, '')) || 0)) + (p.label ? ' <span class="muted">' + esc(p.label) + '</span>' : '') + '</div>').join('') + '</div>';
      }
    }
    // Snow: their accounts (Snow tab access), and their snow quotes of this
    // season and last (on the customer, no money -- whoever sees Contacts).
    const sf = snowFacts(c);
    if (can('snow', 'see') || sf) {
      h += '<div class="cu-sec"><div class="cu-sec-h">Snow</div>';
      if (can('snow', 'see')) {
        const snow = snowOf(c.id);
        h += snow.length
          ? snow.map(a => '<div class="cu-job">❄️ ' + esc(a.name || '') + (a.address ? ' <span class="muted">' + esc(a.address) + '</span>' : '') +
              (a.active === false ? ' <span class="cu-kind">Switched off</span>' : '') + '</div>').join('')
          : '<div class="muted">No snow account.</div>' + (can('snow', 'change') && typeof openSnowForm === 'function'
            ? '<button class="btn btn-sm" onclick="custToSnow(\'' + sid(c.id) + '\')">Make a snow account</button>' : '');
      }
      if (sf) {
        h += '<div class="cu-quotes"><span class="muted">Snow quotes:</span>' + sf.quotes.map(q => '<div>' + quoteLine(q) + '</div>').join('') + '</div>' +
          (sf.onList ? '<div class="cu-line muted">On the Snow quotes list — ' + (snowCalled(c) ? '✓ called ' + esc(niceDay(localDay(c.snowCalledAt))) : 'not called yet this season') + '.</div>' +
            (can('contacts', 'change') ? '<div class="cu-btns">' + (snowCalled(c)
              ? '<button class="btn btn-sm" onclick="custSnowCalled(\'' + sid(c.id) + '\', false)">Not called yet</button>'
              : '<button class="btn btn-sm btn-filled" onclick="custSnowCalled(\'' + sid(c.id) + '\', true)">✓ Called about snow</button>') + '</div>' : '') : '');
      }
      h += '</div>';
    }
    return h;
  }

  // ------------------------------------------------------------ changing contact details
  const FIELD_WORD = { name: 'Name in QuickBooks', firstName: 'First name', lastName: 'Last name', business: 'Business',
    phone: 'Phone', mobile: 'Mobile', email: 'Email', street: 'Street', city: 'City', state: 'State', zip: 'ZIP' };
  const EDIT_KEYS = Object.keys(FIELD_WORD);
  function editHtml(c) {
    // A lead merged onto them brought details they had none of: in the
    // boxes, marked, sent only with Save.
    const pre = prefill && prefill.id === c.id ? prefill.fields : {};
    const f = (k, type, extra) => '<div class="field' + (pre[k] ? ' cu-want' : '') + '"><span class="label">' + FIELD_WORD[k] + '</span><input id="cuF_' + k + '"' +
      (type ? ' type="' + type + '"' : '') + ' value="' + esc(pre[k] || c[k] || '') + '"' + (extra || '') + '></div>';
    return '<div class="cu-edit">' +
      (Object.keys(pre).length ? '<div class="cu-sync warn">From the lead merged in: ' + esc(Object.keys(pre).map(k => FIELD_WORD[k] || k).join(', ')) +
        ' filled in below' + (isQb(c) ? ' — Save sends ' + (Object.keys(pre).length === 1 ? 'it' : 'them') + ' to QuickBooks' : '') + '.</div>' : '') +
      '<div class="grid g3">' + f('firstName') + f('lastName') + f('business') + '</div>' +
      f('name', '', isQb(c) ? '' : ' placeholder="Worked out from the name or business"') +
      '<div class="grid g3">' + f('phone', 'tel') + f('mobile', 'tel') + f('email', 'email') + '</div>' +
      f('street', '', ' autocomplete="off"') +
      '<div class="grid sf-addr">' + f('city') + f('state', '', ' maxlength="2"') + f('zip', '', ' inputmode="numeric" maxlength="10"') + '</div>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="custSaveContact(\'' + sid(c.id) + '\')">Save' + (isQb(c) ? ' — here and in QuickBooks' : '') + '</button>' +
      '<button class="btn btn-sm" onclick="custEdit(false)">Cancel</button></div></div>';
  }
  window.custEdit = function (on) {
    editing = !!on;
    if (!on) prefill = null;
    renderPage(true);
    if (on && el('cuF_firstName')) el('cuF_firstName').focus();
  };
  const lineOf = p => [s(p.street), s(p.city), [s(p.state).toUpperCase(), s(p.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  window.custSaveContact = function (id) {
    const c = customers[id];
    if (!c) return;
    const now = {};
    EDIT_KEYS.forEach(k => { const n = el('cuF_' + k); now[k] = n ? s(n.value) : s(c[k]); });
    const r = saveContact(id, now);
    if (r === 'noname') { showToast('Give them a name first'); return; }
    editing = false;
    prefill = null;
    if (r === 'same') { renderPage(true); return; }
    render();
    renderPage(true);
  };
  // Their contact details as `now` says ({key: value} for every EDIT_KEYS
  // key): saved here, and -- a QuickBooks customer -- sent there. The
  // Contact form and the one-after-another box both save through here.
  // 'noname' (nothing to call them), 'same' (nothing changed) or 'saved'.
  function saveContact(id, now) {
    const c = customers[id];
    if (!c) return 'same';
    now = Object.assign({}, now);
    EDIT_KEYS.forEach(k => { now[k] = s(now[k]); });
    now.state = now.state.toUpperCase();
    if (!now.name) now.name = nameFrom(now);
    if (!now.name) return 'noname';
    const fields = {}, was = {};
    EDIT_KEYS.forEach(k => { if (now[k] !== s(c[k])) { fields[k] = now[k]; was[k] = s(c[k]); } });
    if (!Object.keys(fields).length) return 'same';
    const patch = Object.assign({}, fields);
    if (['street', 'city', 'state', 'zip'].some(k => k in fields)) patch.address = lineOf(now);
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
    if (isQb(c)) sendToQb(id, fields, patch.qbPending.was, false);
    else showToast('Saved');
    return 'saved';
  }

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
    const w = windowFromText(v);
    if (w) whenPicking = false;
    write(id, { contactWhen: v, whenSetAt: new Date().toISOString(), when: null }, 'when to call');
    render();
    showToast(!v ? 'Time to call taken off' : w ? 'On the call list from ' + niceDay(w.from) : 'Saved — but no month, season, year or “next month” in it, so it’s not on the call list');
  };
  // A button: the window it shows, saved. "none" takes the time off.
  window.custWhenPick = function (id, how, arg) {
    const c = customers[id];
    if (!c) return;
    const w = how === 'season' ? seasonWindow(arg, whenLater) : how === 'month' ? monthWindow(+arg, whenLater)
      : how === 'soon' ? soonWindow() : null;
    if (how !== 'none' && !w) return;
    const before = { when: c.when || null, contactWhen: c.contactWhen || '', whenSetAt: c.whenSetAt || null };
    const words = w ? (w.how === 'soon' ? w.label + ' (' + windowWords(w) + ')' : w.label) : '';
    whenPicking = false; whenLater = false;
    write(id, { when: w, contactWhen: words, whenSetAt: new Date().toISOString() }, 'when to call');
    render();
    renderPage(true);
    const say = w ? 'On the call list from ' + niceDay(w.from) : 'Time to call taken off';
    if (typeof showUndo === 'function') showUndo(say, () => { write(id, before, 'when to call'); render(); renderPage(true); });
    else showToast(say);
  };
  window.custWhenLater = function (on) { whenLater = !!on; renderPage(true); };
  window.custWhenOpen = function (on) { whenPicking = !!on; whenLater = false; renderPage(true); };
  window.custNotInterested = function (id, on) { write(id, { notInterested: !!on }, 'not interested'); render(); };
  window.custTagOn = function (id, v) {
    const c = customers[id];
    v = s(v);
    if (!c || !v) return;
    if (window.YDServices) v = window.YDServices.canon(v);    // an old spelling is the name it became
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
    if (openId === id) renderPage(true);
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
  window.custRemoveLead = async function (id) {
    const c = customers[id];
    if (!c || isQb(c) || !(await ydConfirm('This cannot be undone.', { title: 'Take ' + (c.name || 'this lead') + ' off the list?', ok: 'Take them off', danger: true }))) return;
    if (!customers[id]) return;
    delete customers[id];
    window.closeCustomer();
    render();
    Promise.resolve(window.YDDb.remove('customers', id)).catch(e => showToast('Not removed: ' + ((e && e.code) || 'error')));
  };

  // ------------------------------------------------------------ to a job / snow
  window.custOpenJob = function (jobId) {
    window.closeCustomer();
    if (typeof openJobFromBoard === 'function') openJobFromBoard(jobId);
  };
  window.custUnlinkJob = async function (jobId) {
    if (!window.YDSync || !(await ydConfirm('It goes back to “To sort” to be tied to the right customer.',
      { title: 'This job isn’t theirs?', ok: 'Not theirs' }))) return;
    // By hand: the automatic tie never puts it back.
    YDSync.patchJob(jobId, { customerId: null, customerBy: 'hand' });
    render();
  };
  // ------------------------------------------------------------ their talk with Claude
  //
  // Each bid's conversation with Claude, under it on the customer's page --
  // the newest messages; the whole of it is on the bid.
  const TALK_SHOW = 12;
  const talkOf = j => ((j && j.estimate && Array.isArray(j.estimate.chat)) ? j.estimate.chat : []).filter(m => m && s(m.text));
  function talkHtml(j) {
    const chat = talkOf(j);
    return '<div class="cu-talk">' +
      (chat.length > TALK_SHOW ? '<div class="muted">The ' + (chat.length - TALK_SHOW) + ' before these are on the bid.</div>' : '') +
      chat.slice(-TALK_SHOW).map(m => '<div class="cu-talk-m' + (m.role === 'assistant' ? ' claude' : '') + '"><b>' +
        (m.role === 'assistant' ? '✨ Claude' : 'You') + '</b>' + (m.at ? ' <span class="muted">' + esc(niceDay(localDay(m.at))) + '</span>' : '') +
        '<div class="cu-talk-t">' + esc(s(m.text).slice(0, 1500)) + (s(m.text).length > 1500 ? '…' : '') + '</div></div>').join('') +
      '<button class="link-btn" onclick="custOpenJob(\'' + sid(j._id) + '\')">Open it to talk to Claude about it</button></div>';
  }
  window.custTalk = function (jobId) {
    talkOpen[jobId] = !talkOpen[jobId];
    renderPage(true);
  };

  // ------------------------------------------------------------ a new bid for them
  //
  // "Start a bid" on a customer's page: what the bid is for, in his words --
  // it goes to Claude as the bid's first message, with every other bid of
  // theirs in front of it (estimates.py) -- and/or the lines of one of their
  // bids to carry over, ticked, copied word for word with their price and
  // crew-days (estimate.js carry). Their materials are ticked with them by the
  // crew page's guess of which line each is for, until he ticks them himself.
  // Nothing written and nothing ticked: a bid with their details and their
  // dated notes as its site notes, as before.
  const NB_SOURCES = 6;
  function nbSources(jobs) {
    if (!window.YDEstimate || !YDEstimate.linesOf) return [];
    return jobs.map(j => ({ j: j, l: YDEstimate.linesOf(j._id) })).filter(x => x.l && x.l.work.length).slice(0, NB_SOURCES);
  }
  function newBidHtml(c, jobs) {
    const id = sid(c.id), bills = can('billing', 'see');
    const srcs = nbSources(jobs);
    const days = n => n + ' crew-day' + (n === 1 ? '' : 's');
    let h = '<div class="cu-nb"><div class="cu-sub">A new bid for ' + esc(c.name || 'them') + '</div>' +
      '<textarea id="cuNB_' + id + '" rows="3" placeholder="What is it for? e.g. a separate bid for just the gravel top-up — line 3 on their last bid" ' +
        'oninput="custNBText(this.value)">' + esc(nb.text) + '</textarea>' +
      '<div class="hint">Claude gets this with ' + (srcs.length ? 'their other bids — the lines, materials, site notes and what was said about each — ' +
        'and builds the new bid from them.' : 'your notes on them, and builds the bid.') + '</div>';
    if (srcs.length) {
      h += '<div class="cu-sub">Or tick the lines to carry over yourself</div>';
      srcs.forEach(({ j, l }) => {
        const jid = sid(j._id), on = nb.lines[j._id] || [], mOn = nb.mats[j._id] || [];
        h += '<div class="cu-nb-src"><div><b>' + (s(j.estimateNumber) ? 'Bid #' + esc(j.estimateNumber) : esc(j.customerName || 'A bid')) + '</b> ' +
            '<span class="muted">' + esc(jobWord(j)) + (j.quoteDate ? ' · ' + esc(niceDay(s(j.quoteDate).slice(0, 10))) : '') + '</span></div>' +
          '<div class="cu-picks">' + l.work.map(w => '<button type="button" class="cu-chip' + (on.indexOf(w.id) !== -1 ? ' on' : '') + '" ' +
            'onclick="custNBLine(\'' + jid + '\', \'' + sid(w.id) + '\')">' + w.n + '. ' + esc(w.title) + '<small>' +
            esc([bills && w.cents ? money(w.cents / 100) : '', w.crewDays ? days(w.crewDays) : ''].filter(Boolean).join(' · ') || 'line ' + w.n) +
            '</small></button>').join('') + '</div>';
        if (on.length && l.materials.length) {
          const lineN = wid => (l.work.find(w => w.id === wid) || {}).n;
          h += '<div class="muted cu-nb-mh">Their materials — ticked: the ones that go with the lines ticked</div><div class="cu-picks">' +
            l.materials.map(m => '<button type="button" class="cu-chip' + (mOn.indexOf(m.id) !== -1 ? ' on' : '') + '" ' +
              'onclick="custNBMat(\'' + jid + '\', \'' + sid(m.id) + '\')">' + esc(m.name || 'A material') + '<small>' +
              esc([m.qty !== null ? m.qty + (m.unit ? ' ' + m.unit : '') : '', m.forWork && lineN(m.forWork) ? 'with line ' + lineN(m.forWork) : ''].filter(Boolean).join(' · ')) +
              '</small></button>').join('') + '</div>';
        }
        h += '</div>';
      });
      h += '<div class="hint">Lines ticked come over word for word, with their price and crew-days; their materials are priced again at today’s prices. ' +
        'Anything written above goes to Claude after them.</div>';
    }
    return h + '<div class="cu-btns"><button class="btn btn-filled" onclick="custNBGo(\'' + id + '\')">Start the bid</button>' +
      '<button class="btn btn-sm" onclick="custNBOff()">Cancel</button></div></div>';
  }
  window.custStartBid = function (id) {
    if (!customers[id] || !can('jobs', 'change')) return;
    nb = { id: id, text: '', lines: {}, mats: {}, own: {} };
    renderPage(true);
    const t = el('cuNB_' + sid(id));
    if (t) t.focus();
  };
  window.custNBText = function (v) { if (nb) nb.text = v; };
  window.custNBOff = function () { nb = null; renderPage(true); };
  // The ids come back through the page safe-id'd: looked up again here.
  const realId = (list, k) => (list || []).map(x => x.id).find(x => sid(x) === k) || k;
  const realJob = k => (allJobs().find(j => sid(j._id) === k) || {})._id || k;
  window.custNBLine = function (jk, wk) {
    if (!nb || !window.YDEstimate) return;
    const jid = realJob(jk), l = YDEstimate.linesOf(jid);
    if (!l) return;
    const wid = realId(l.work, wk);
    const on = (nb.lines[jid] || []).slice();
    const i = on.indexOf(wid);
    if (i === -1) on.push(wid); else on.splice(i, 1);
    const order = l.work.map(w => w.id);
    nb.lines[jid] = on.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (!nb.own[jid]) nb.mats[jid] = l.materials.filter(m => m.forWork && on.indexOf(m.forWork) !== -1).map(m => m.id);
    renderPage(true);
  };
  window.custNBMat = function (jk, mk) {
    if (!nb || !window.YDEstimate) return;
    const jid = realJob(jk), l = YDEstimate.linesOf(jid);
    if (!l) return;
    const mid = realId(l.materials, mk);
    const on = (nb.mats[jid] || []).slice();
    const i = on.indexOf(mid);
    if (i === -1) on.push(mid); else on.splice(i, 1);
    const order = l.materials.map(m => m.id);
    nb.mats[jid] = on.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    nb.own[jid] = true;
    renderPage(true);
  };
  window.custNBGo = async function (id) {
    const c = customers[id];
    if (!c || !nb || nb.id !== id || !can('jobs', 'change') || typeof createJobRecord !== 'function') return;
    // The job open on the Job tab keeps what was typed in it (asked first).
    if (typeof ydLeaveUnsavedJob === 'function' && !(await ydLeaveUnsavedJob())) return;
    if (!nb || nb.id !== id) return;
    const text = s(nb.text);
    const now = new Date().toISOString();
    const est = { v: 2, notes: '', work: [], materials: [], chat: [], flags: [] };
    const services = [], carried = [];
    Object.keys(nb.lines).filter(jid => nb.lines[jid].length).forEach(jid => {
      const got = YDEstimate.carry(jid, nb.lines[jid], nb.mats[jid] || []);
      est.work = est.work.concat(got.work);
      est.materials = est.materials.concat(got.materials);
      const src = allJobs().find(j => j._id === jid) || {};
      (src.serviceTypes || []).forEach(x => { if (services.indexOf(x) === -1) services.push(x); });
      carried.push((s(src.estimateNumber) ? 'bid #' + s(src.estimateNumber) : 'their bid of ' + niceDay(s(src.quoteDate).slice(0, 10))) + ': ' +
        got.work.map(w => w.title || 'a line').join(', ') +
        (got.materials.length ? ', with ' + got.materials.length + ' material' + (got.materials.length === 1 ? '' : 's') : ''));
    });
    if (carried.length) {
      const said = 'Carried over from ' + carried.join('; ') + ' — word for word, with the price and crew-days; the materials at today’s prices.';
      // Before his words, Claude reads where these lines came from; with
      // none, it is said under the estimate.
      if (text) est.chat.push({ role: 'user', text: '(' + said + ')', at: now, changed: false });
      else est.flags.push(said);
    } else if (!text) {
      // Nothing said, nothing carried: their dated notes as the site notes.
      est.notes = (c.meetings || []).slice().sort((a, b) => s(a.at).localeCompare(s(b.at)))
        .map(m => niceDay(localDay(m.at)) + ': ' + m.text).join('\n\n');
    }
    const site = c.ship && s(c.ship.street) ? c.ship : c;
    const fields = {
      customerName: s(c.name), firstName: s(c.firstName), lastName: s(c.lastName), business: s(c.business),
      address: s(site.street), city: s(site.city), state: s(site.state), zip: s(site.zip),
      phone: s(c.phone || c.mobile), email: s(c.email),
      serviceTypes: services.length ? services : (c.tags || []).filter(t => t !== 'Snow Removal'),
      customerId: c.id, customerBy: 'hand', jobStatus: 'quoting', bidStage: 'toSend', bidStageAt: now,
    };
    if (est.work.length || est.materials.length || est.chat.length || est.notes) fields.estimate = est;
    const jobId = createJobRecord(fields);
    if (!jobId) return;
    nb = null;
    window.closeCustomer();
    if (typeof loadJob === 'function') loadJob(jobId);
    if (typeof switchTab === 'function') switchTab('job');
    if (text && window.YDEstimate) YDEstimate.ask(text);
    // The job's price follows the lines carried over, and is saved with it.
    else if (window.YDEstimate && YDEstimate.repriced) YDEstimate.repriced();
    showToast('A new bid for ' + (c.name || 'them') + (text ? ' — Claude is building it' : carried.length ? ' — lines carried over' : ''));
  };

  // ------------------------------------------------------------ every bid tied to its customer
  //
  // A bid made by typing a name (the Bids board's "+ Add a bid", 29 Oct
  // 2026) was tied to nobody until someone sorted it. Now:
  //  * made from a board, it is tied as it is made when it surely is one
  //    customer's (tieFields) -- the same "sure" as To sort: that email or
  //    phone, QuickBooks' own id, or exactly that name with only one customer
  //    of it -- and their address, phone and email fill its empty boxes;
  //  * any bid or job saved tied to nobody is tied the same way by itself
  //    (tieSure), unless someone untied it by hand ("Not theirs");
  //  * the Job tab and a bid's card say whose it is, with the likeliest
  //    customers as buttons when it isn't sure (manual override always).
  //
  // The empty boxes of a job filled from its customer: the work address (or
  // theirs) when the job has no address, their phone and email when it has
  // none -- never over something typed.
  function fillFrom(c, j) {
    const out = {};
    const site = c.ship && s(c.ship.street) ? c.ship : c;
    if (!s(j.address) && !s(j.city) && s(site.street)) {
      out.address = s(site.street); out.city = s(site.city); out.state = s(site.state); out.zip = s(site.zip);
    }
    if (!s(j.phone) && s(c.phone || c.mobile)) out.phone = s(c.phone || c.mobile);
    if (!s(j.email) && s(c.email)) out.email = s(c.email);
    return out;
  }
  function sureOf(by, who) {
    const g = guess(by, who);
    const id = g.sure ? resolve(g.sure) : null;
    return id && customers[id] ? id : null;
  }
  function tieFields(name) {
    if (!isOn() || !loaded || !s(name)) return {};
    const id = sureOf(index(), { name: name, email: '', phone: '' });
    return id ? Object.assign({ customerId: id, customerBy: 'auto' }, fillFrom(customers[id], {})) : {};
  }
  const openJobId = () => (typeof currentJobId !== 'undefined' && currentJobId) || '';
  const formDirty = () => typeof dirty !== 'undefined' && !!dirty;
  // The job open on the Job tab: tied on the form, which saves it.
  function tieForm(cid, by) {
    const c = customers[cid];
    if (!c || typeof boardFields === 'undefined') return false;
    boardFields.customerId = cid;
    boardFields.customerBy = by;
    const now = {};
    ['address', 'city', 'phone', 'email'].forEach(f => { now[f] = el(f) ? el(f).value : ''; });
    const add = fillFrom(c, now);
    Object.keys(add).forEach(f => { const n = el(f); if (n && !s(n.value)) n.value = add[f]; });
    if (typeof markDirty === 'function') markDirty();
    drawTie();
    return true;
  }
  function tieJob(jobId, cid, by, j) {
    if (jobId === openJobId()) return tieForm(cid, by);
    const c = customers[cid];
    if (!c || !window.YDSync) return false;
    j = j || allJobs().find(x => x._id === jobId) || {};
    return !!YDSync.patchJob(jobId, Object.assign({ customerId: cid, customerBy: by }, fillFrom(c, j)));
  }
  let tieTimer = null;
  function tieSoon() { clearTimeout(tieTimer); tieTimer = setTimeout(tieSure, 1500); }
  function tieSure() {
    if (!isOn() || !loaded || !can('jobs', 'change') || !window.YDSync) return;
    let by = null, n = 0;
    allJobs().forEach(j => {
      if (j.customerId || j.customerBy === 'hand' || j.removeWhy || j.deletedAt) return;
      // The job on screen with typing not saved yet: once it is.
      if (j._id === openJobId() && formDirty()) return;
      by = by || index();
      const id = sureOf(by, whoOfJob(j));
      if (id && tieJob(j._id, id, 'auto', j)) n++;
    });
    if (n) render(true);
  }

  // Whose bid it is, with buttons to say (ctx 'job': the Job tab; 'card': a
  // bid's card being edited on a board).
  function tieHtml(ctx, jobId, tiedId, who, word) {
    const ch = can('jobs', 'change'), k = sid(ctx), jid = sid(jobId || '');
    const c = tiedId ? customers[mainOf(s(tiedId))] || customers[resolve(s(tiedId))] : null;
    if (c) {
      const where = s(c.address).split(',')[0];
      return '<div class="cu-tie">👤 <b>' + esc(c.name || '?') + '</b>' + (where ? ' <span class="muted">' + esc(where) + '</span>' : '') +
        ' <span class="cu-kind k-' + kindOf(c) + '">' + KIND_WORD[kindOf(c)] + '</span>' +
        ' <button type="button" class="link-btn ro-ok" onclick="custTieOpen(\'' + sid(c.id) + '\')">Their page</button>' +
        (ch ? ' <button type="button" class="link-btn" onclick="custTieOff(\'' + k + '\', \'' + jid + '\')">Not them</button>' : '') + '</div>';
    }
    if (!ch || !s(who.name)) return '';
    const g = guess(index(), who);
    const sure = g.sure ? resolve(g.sure) : null;
    const ids = Array.from(new Set([].concat(sure ? [sure] : [], g.options.map(resolve)))).filter(x => customers[x]).slice(0, 4);
    const chip = (v, label, sub) => '<button type="button" class="cu-chip" onclick="custTiePick(\'' + k + '\', \'' + jid + '\', \'' + sid(v) + '\')">' +
      label + '<small>' + sub + '</small></button>';
    return '<div class="cu-tie cu-tie-ask"><div>👤 <b>Whose ' + word + ' is this?</b> <span class="muted">Tied to the customer, their bids and ' +
        'Claude’s talk about them stay together.</span></div>' +
      '<div class="cu-picks">' + ids.map(x => {
        const o = customers[x];
        return chip(x, (x === sure ? '✓ ' : '') + esc(o.name || '?'),
          esc([s(o.address).split(',')[0], o.phone || o.mobile].filter(Boolean).join(' · ') || KIND_WORD[kindOf(o)]));
      }).join('') + chip('lead', 'Someone new', 'a lead — not a customer yet') + '</div>' +
      '<input class="cu-sort-find" id="cuTieFind_' + k + '" placeholder="Someone else? Type a name…" oninput="custTieFind(\'' + k + '\', \'' + jid + '\', this.value)">' +
      '<div class="cu-picks" id="cuTieFound_' + k + '"></div></div>';
  }
  const formWho = () => {
    const v = f => s(el(f) && el(f).value);
    const q = typeof boardFields !== 'undefined' && boardFields && boardFields.qbEstimate || {};
    return { name: v('customerName'), email: v('email'), phone: v('phone'), qbId: q.customerId && q.env === 'production' ? s(q.customerId) : '' };
  };
  const cardWho = j => {
    const v = f => s(el(f) && el(f).value);
    return Object.assign({}, whoOfJob(j || {}), { name: v('jeBusiness') || [v('jeFirst'), v('jeLast')].filter(Boolean).join(' '),
      email: v('jeEmail'), phone: v('jePhone') });
  };
  const bidWord = status => typeof isBidStatus === 'function' && isBidStatus(status) ? 'bid' : 'job';
  function drawTie() {
    const box = el('jobCustTie');
    if (!box) return;
    // Not while he is typing in it (a search for someone else).
    if (box.contains(document.activeElement)) return;
    const bf = typeof boardFields !== 'undefined' && boardFields ? boardFields : {};
    const html = isOn() && loaded && can('jobs', 'see')
      ? tieHtml('job', openJobId(), s(bf.customerId), formWho(), bidWord(typeof jobStatus !== 'undefined' ? jobStatus : '')) : '';
    box.innerHTML = html;
    box.hidden = !html;
  }
  let tieDrawTimer = null;
  function drawTieSoon() { clearTimeout(tieDrawTimer); tieDrawTimer = setTimeout(drawTie, 400); }
  function cardTieHtml(j) {
    return '<div id="jeCustTie">' + (isOn() && loaded ? tieHtml('card', j._id, s(j.customerId), whoOfJob(j), bidWord(j.jobStatus)) : '') + '</div>';
  }
  function redrawCardTie(jobId, tied) {
    const box = el('jeCustTie');
    const j = allJobs().find(x => x._id === jobId) || {};
    if (box) box.innerHTML = tieHtml('card', jobId, tied, cardWho(j), bidWord(j.jobStatus));
  }
  // A bid's card being edited: tied at once, and the customer's details put
  // in the boxes still empty there (its Save writes the boxes).
  const CARD_BOX = { address: 'jeStreet', city: 'jeCity', state: 'jeState', zip: 'jeZip', phone: 'jePhone', email: 'jeEmail' };
  function tieCard(jobId, cid, by) {
    const c = customers[cid];
    if (!c || !window.YDSync || !YDSync.patchJob(jobId, { customerId: cid, customerBy: by })) return;
    if (jobId === openJobId()) tieForm(cid, by);
    const now = {};
    Object.keys(CARD_BOX).forEach(f => { now[f] = el(CARD_BOX[f]) ? el(CARD_BOX[f]).value : ''; });
    const add = fillFrom(c, now);
    Object.keys(add).forEach(f => { const n = el(CARD_BOX[f]); if (n && !s(n.value)) n.value = add[f]; });
    redrawCardTie(jobId, cid);
  }
  window.custTieOpen = function (id) { window.openCustomer(id); };
  window.custTiePick = function (ctx, jk, v) {
    if (!can('jobs', 'change')) return;
    if (v === 'lead') { window.custTieNew(ctx, jk); return; }
    const cid = resolve(Object.keys(customers).find(x => sid(x) === v) || v);
    if (!customers[cid]) return;
    if (ctx === 'card') { tieCard(realJob(jk), cid, 'hand'); return; }
    // Another job opened since the buttons were drawn: nothing.
    if (sid(openJobId()) !== jk) return;
    tieForm(cid, 'hand');
  };
  window.custTieOff = function (ctx, jk) {
    if (!can('jobs', 'change')) return;
    // By hand: the automatic tie never puts it back.
    if (ctx === 'card') {
      const jobId = realJob(jk);
      if (!window.YDSync || !YDSync.patchJob(jobId, { customerId: null, customerBy: 'hand' })) return;
      if (jobId === openJobId() && typeof boardFields !== 'undefined') { boardFields.customerId = null; boardFields.customerBy = 'hand'; drawTie(); }
      redrawCardTie(jobId, '');
      return;
    }
    if (sid(openJobId()) !== jk || typeof boardFields === 'undefined') return;
    boardFields.customerId = null;
    boardFields.customerBy = 'hand';
    if (typeof markDirty === 'function') markDirty();
    drawTie();
  };
  // Someone new: a lead made from the bid's own details, and the bid tied
  // to it (as To sort's "New lead" does).
  window.custTieNew = function (ctx, jk) {
    if (!can('jobs', 'change') || !can('contacts', 'change')) { showToast('Adding someone new needs Customers change access'); return; }
    const v = f => s(el(f) && el(f).value);
    if (ctx === 'card') {
      const jobId = realJob(jk);
      const id = newLeadFromJob({ _id: jobId, customerName: v('jeBusiness') || [v('jeFirst'), v('jeLast')].filter(Boolean).join(' '),
        firstName: v('jeFirst'), lastName: v('jeLast'), business: v('jeBusiness'), phone: v('jePhone'), email: v('jeEmail'),
        address: v('jeStreet'), city: v('jeCity'), state: v('jeState'), zip: v('jeZip'), serviceTypes: [] });
      tieCard(jobId, id, 'hand');
      return;
    }
    // A new job not saved yet gets its id first (the lead is named after it).
    if (!openJobId() && typeof autosave === 'function') autosave();
    const jobId = openJobId();
    if (!jobId) { showToast('Give the job a name first'); return; }
    const id = newLeadFromJob({ _id: jobId, customerName: v('customerName'), firstName: v('firstName'), lastName: v('lastName'),
      business: v('business'), phone: v('phone'), email: v('email'), address: v('address'), city: v('city'), state: v('state'), zip: v('zip'),
      serviceTypes: typeof serviceTypes !== 'undefined' ? serviceTypes.slice() : [] });
    tieForm(id, 'hand');
  };
  window.custTieFind = function (ctx, jk, q) {
    const box = el('cuTieFound_' + ctx);
    if (!box) return;
    q = low(q);
    if (q.length < 2) { box.innerHTML = ''; return; }
    const hits = Object.values(customers).filter(c => inLists(c) && low([c.name, c.business, c.email, c.phone, c.address].join(' ')).indexOf(q) !== -1)
      .sort(byName).slice(0, 6);
    box.innerHTML = hits.map(c => '<button type="button" class="cu-chip" onclick="custTiePick(\'' + sid(ctx) + '\', \'' + sid(jk) + '\', \'' + sid(c.id) + '\')">' +
      esc(c.name || '?') + '<small>' + esc(c.address ? c.address.split(',')[0] : (c.phone || '')) + '</small></button>').join('') ||
      '<span class="muted">Nobody by that name</span>';
  };

  // The customer's other bids and jobs with something on them, newest first
  // -- theirs and those of the ones shown with them (a second QuickBooks
  // profile, a sub-customer) -- for Claude (estimate.js ask).
  function otherJobs(customerId, exceptId) {
    const main = mainOf(s(customerId));
    const ids = {};
    (customers[main] ? [main].concat(family(main)) : [resolve(s(customerId))]).forEach(x => { ids[x] = true; });
    return allJobs().filter(j => j._id !== exceptId && j.customerId && ids[resolve(s(j.customerId))] && !j.removeWhy && !j.deletedAt)
      .filter(j => { const e = j.estimate || {}; return (e.work || []).length || (e.materials || []).length || talkOf(j).length || s(e.notes); })
      .sort((a, b) => s(b.quoteDate || b.lastModified).localeCompare(s(a.quoteDate || a.lastModified)))
      .slice(0, 6).map(j => j._id);
  }
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
        line: [j.estimateNumber ? '#' + j.estimateNumber : '', j.address, jobWord(j)].filter(Boolean).join(' · '), canLead: true }))],
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
    // A second QuickBooks profile's bid goes on the one they are shown as.
    let id = j.customerId ? mainOf(j.customerId) : null;
    let added = false;
    if (!id || !customers[id]) {
      const g = guess(index(), { name: j.customerName, email: j.email, phone: j.phone });
      id = g.sure ? mainOf(g.sure) : null;
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
  // second QuickBooks customer because the name was typed differently. One
  // marked the same person as another goes to the main one he picked ("new
  // estimates go to ..." says so where he picks it). A sub-customer keeps
  // its own: it is a job of theirs in QuickBooks.
  function qbIdFor(customerId) {
    const c = customerId && customers[mainOf(customerId)];
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
  window.custSwitchOn = async function () {
    if (!(window.YDAuth && window.YDAuth.isOwner)) return;
    if (!(await ydConfirm('Nothing in QuickBooks is changed by this. Your Contacts list stays until you sort it onto them.',
      { title: 'Bring in every customer from your real QuickBooks (about 500), and keep them in step both ways from now on?', ok: 'Bring them in' }))) return;
    if (conf.importOn === true) return;
    conf.importOn = true;
    const saved = Promise.resolve(window.YDDb.put('settings', 'customers', { importOn: true, importOnAt: new Date().toISOString(),
      importOnBy: (window.YDAuth.user && window.YDAuth.user.uid) || null }));
    saved.catch(e => showToast('Not switched on: ' + ((e && e.code) || 'error')));
    start();
    render();
    if (!window.YDClaude || !navigator.onLine) { showToast('Switched on — they come in at the next hourly look'); return; }
    // The server reads the switch itself: asked only once it is saved there
    // (a write settles when the server has it), or it would find it still off.
    const later = () => showToast('Switched on — they come in at the next hourly look');
    Promise.race([saved.then(() => true), new Promise(r => setTimeout(() => r(false), 15000))]).then(ok => {
      if (!ok) { later(); return; }
      window.YDClaude.post('/qb/customers-now', {}).then(r => {
        const got = r && r.result;
        if (got && typeof got.read === 'number') showToast(got.read + ' customers read from QuickBooks');
        else later();
      }).catch(e => showToast('Switched on — QuickBooks: ' + ((e && e.message) || 'not reached') + '. They come in at the next hourly look.'));
    }, () => { /* not saved: said above */ });
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
        // A merge undone: a lead again.
        delete merged[ch.id];
        customers[ch.id] = rec;
      });
      ver++;
      if (!meta || meta.fromCache === false || Object.keys(customers).length) loaded = true;
      render(true);
      drawTie();
      tieSoon();
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
    ver++; fill = null; addOpen = false; addDraft = {}; vendorsRead = null; checkPart = ''; searchText = '';
  }

  window.YDCustomers = {
    on: isOn, all: () => customers, kindOf: kindOf, windowOf: windowOf, windowFromText: windowFromText, snowFacts: snowFacts,
    fromLostBid: fromLostBid, qbIdFor: qbIdFor, open: id => window.openCustomer(id), render: render,
    // The one a record is shown as (a lead merged in, a second QuickBooks
    // profile), and whether it has a row of its own in the lists.
    mainOf: id => mainOf(id), ownRow: c => !!c && inLists(c),
    // The customer's other bids and jobs, for Claude (estimate.js ask).
    otherJobs: (customerId, exceptId) => otherJobs(customerId, exceptId),
    // A bid or job about to be made from a name (boards.js addJobCard): tied
    // to its customer when it surely is theirs, their details in its boxes.
    tieFields: name => tieFields(name),
    // Whose bid it is, on the Job tab and on a bid's card.
    drawTie: () => drawTie(),
    drawTieSoon: () => drawTieSoon(),
    cardTieHtml: j => cardTieHtml(j),
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
  // Their jobs, invoices and snow accounts change under the page. The first
  // load sends all four in a burst: one redraw for the lot, and none at all
  // while the tab is not on screen (render() remembers it for when it is).
  let quietTimer = null;
  const renderQuietly = () => { clearTimeout(quietTimer); quietTimer = setTimeout(() => render(true), 80); };
  ['yd-jobs-changed', 'yd-invoices', 'yd-prospects', 'yd-snow-accounts'].forEach(ev => document.addEventListener(ev, () => { if (isOn()) renderQuietly(); }));
  // A bid or job saved tied to nobody: tied by itself when it surely is
  // someone's.
  document.addEventListener('yd-jobs-changed', () => { if (isOn()) tieSoon(); });
  // Everyone lists the suppliers and subcontractors; the services list feeds
  // the "What for" buttons.
  ['yd-supplies', 'yd-subs'].forEach(ev => document.addEventListener(ev, () => { if (isOn() && view === 'everyone') renderQuietly(); }));
  document.addEventListener('yd-services', () => {
    if (!isOn()) return;
    Object.keys(tagFind).concat(Object.keys(tagAll), openId ? [openId] : [], addOpen ? ['add'] : []).forEach(ctx => {
      const box = el('cuTagRes_' + sid(ctx));
      if (box) box.innerHTML = tagResHtml(ctx);
    });
  });
  // The tab coming on screen draws what changed while it was away (or the
  // day moved on: the call list depends on today's date).
  function watchPanel() {
    const p = el('panel-contacts');
    if (!p || typeof MutationObserver !== 'function') return;
    panelWatched = true;
    new MutationObserver(() => {
      if (panelShown() && (dirty || (drawnDay && drawnDay !== today()))) render();
    }).observe(p, { attributes: true, attributeFilter: ['class'] });
  }
  // Leaving a form draws what came in while he was typing in it.
  function watchForms() {
    const wrap = el('custWrap');
    if (!wrap) return;
    wrap.addEventListener('focusout', () => {
      if (!pendingQuiet) return;
      setTimeout(() => { if (pendingQuiet && !inForm()) render(true); }, 0);
    });
  }
  function boot() { watchPanel(); watchForms(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
