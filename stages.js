// One status per record -- receipts, equipment problems, crew change
// requests and storms. The server works each out the same way
// (functions/stages.py) -- change both together.
//
// Jonah, 15 Oct 2026 ("one status per record, moving forward through fixed
// stages, instead of piles of yes/no boxes"). Jobs went first (app.js
// jobStage). The same idea for the rest:
//
//   Receipt:    To sort -> Filed (to a job, a vehicle, the shop, the office,
//               the property, a subcontractor, or Personal) -- or Set
//               aside, with the reason. Before it: To pay (a bill not paid
//               yet, until it is). Apart: Not a receipt (marked so, and put
//               back to what it was when that was wrong)
//   Problem:    Open -> Part ordered -> Part at the shop -> Fixed (and back
//               to Open when it was not fixed after all)
//   Change ask: Waiting -> Approved or Turned down (or Withdrawn by whoever
//               asked)
//   Storm:      Open -> Closed, or Abandoned
//
// Each function below takes the record as it is stored and hands back ONE
// answer: { id, name, tone, ... , at, uid, name of who }. Every screen asks
// here rather than reading the fields itself, so two screens can never
// disagree about where a record is.
//
// Old records are read as they are -- nothing is rewritten. Receipts, change
// requests and storms already kept one stored `status`, and keep its words
// ('new' / 'done' / 'skipped'; 'pending' / 'approved' / 'rejected' /
// 'withdrawn'; 'open' / 'closed' / 'abandoned'): the server's queries, the
// security rules and every phone still on the old code ask for exactly those.
// What they did not say is who moved it there and when; from now on each
// change of status also writes `statusChange` {to, at, by, name} beside it.
// It is only believed while `to` is still the record's status -- a phone on
// the old code moving it on without one leaves a stamp about the step before,
// which is then ignored for the record's own dates.
//
// Equipment problems had no status at all, only yes/no fields (doneAt for
// fixed, partAtShop for the part). They now carry `status` too, but the old
// fields are still written alongside and still WIN where the two disagree:
// a phone on the old code, the Maintenance board sync and the server all read
// and write doneAt and partAtShop, so they stay the truth for Fixed and Part
// at the shop. `status` adds only what had no field: Part ordered.

(function () {
  'use strict';

  // The tones are the app's one scale of what a state means (styles.css
  // --st-*): 'now' red (late, needs doing now), 'due' orange (today),
  // 'soon' yellow (coming up), 'later' grey (whenever; over -- lost,
  // turned down), 'info' slate, 'done' an outline and a check, 'wait' a
  // dashed slate (waiting on someone else).
  const TONES = ['now', 'due', 'soon', 'later', 'info', 'done', 'wait'];

  // The last change of status, if it still describes the record's status.
  function stampOf(rec, to) {
    const c = rec && rec.statusChange;
    if (!c || typeof c !== 'object' || c.to !== to) return null;
    return { at: c.at || '', uid: c.by || '', name: c.name || '' };
  }
  const one = (id, name, tone, extra) => Object.assign({ id: id, name: name, tone: tone, at: '', uid: '', who: '' }, extra || {});
  // The stamp when there is one, else what the record's own fields say.
  function dated(st, rec, to, at, uid, who) {
    const s = stampOf(rec, to);
    st.at = (s && s.at) || at || '';
    st.uid = (s && s.uid) || uid || '';
    st.who = (s && s.name) || who || '';
    return st;
  }

  // ---------------------------------------------------------------- receipts
  //
  // Stored status: 'new' (to sort -- some lines may already be filed, the
  // rest waiting), 'done' (every line filed), 'skipped' (set aside). Three
  // old set-aside reasons were really places (receipts.js): 'overhead'
  // (before 9 Oct) is the shop, 'subcontractor' (before 13 Oct) a
  // subcontractor, and 'personal' (before 21 Oct, when Personal became a
  // place a receipt is kept in rather than a reason to drop it) Personal --
  // those read as Filed. A receipt with no status, or one this code does
  // not know, is still to sort.
  const RECEIPT_LEGACY_PLACE = { overhead: 'shop', subcontractor: 'sub', personal: 'personal' };
  // Places that are not a cost of the business (Jonah, 21 Oct 2026:
  // "personal receipts dont get deleted"): a receipt filed only there is
  // kept, but counted in none of the business's totals and never sent on to
  // QuickBooks (`offBooks` below; stages.py receipt_off_books).
  const RECEIPT_OFF_BOOKS = ['personal'];
  // Places QuickBooks must never get as an expense (`noQb` below;
  // stages.py receipt_not_to_qb): everything off the books, and a loan
  // payment (Jonah, 22 Oct 2026: "add loan payments as a tag for
  // receipts"). A loan payment is the business's money and is counted --
  // under its own name -- but most of it is paying back what was borrowed,
  // which is not a cost; QuickBooks has it from the bank, where the
  // principal and the interest are split.
  const RECEIPT_NOT_TO_QB = ['personal', 'loan'];
  // The old set-aside pick list's words, read back as the reason.
  const RECEIPT_WHY = { overhead: 'Shop overhead', personal: 'Personal', notPurchase: 'Not a purchase',
    alreadyEntered: 'Already entered', subcontractor: 'Subcontractor bill' };
  // Two stored words of their own (Jonah, 26 Oct 2026: "It isnt a receipt if
  // its an invoice that hasnt been paid yet that should go into something
  // that says 'invoices to pay'", and "add a 'not receipt' tag"): 'topay', a
  // bill the email reader found that is not paid yet -- To pay until its
  // payment email comes or Paid is tapped, then To sort; 'notreceipt', one
  // marked Not a receipt (receipts.js), which teaches the reader. Neither is
  // a cost: counted nowhere, never to sort, never sent on to QuickBooks
  // (receiptCounts below; stages.py receipt_counts). Keep the words the same as
  // stages.py and firestore.rules.
  const RECEIPT_TO_PAY = 'topay', RECEIPT_NOT = 'notreceipt';
  const RECEIPT_STAGES = [{ id: 'topay', name: 'To pay' }, { id: 'tosort', name: 'To sort' }, { id: 'filed', name: 'Filed' },
    { id: 'aside', name: 'Set aside' }, { id: 'notreceipt', name: 'Not a receipt' }];
  // "2026-10-26" today, where the business is.
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  function receipt(r) {
    r = r || {};
    const splits = Array.isArray(r.splits) ? r.splits : [];
    const places = splits.map(s => (s && s.to) || 'job');
    if (r.status === RECEIPT_TO_PAY) {
      // Late (red) once its due date has gone by, due (orange) on the day.
      const due = /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate || '') ? r.dueDate : '', t = today();
      return dated(one('topay', 'To pay', due && due < t ? 'now' : due === t ? 'due' : 'soon',
        { due: due, late: !!due && due < t, places: [] }), r, RECEIPT_TO_PAY, r.createdAt, '', '');
    }
    if (r.status === RECEIPT_NOT) {
      const n = r.notReceipt || {};
      return dated(one('notreceipt', 'Not a receipt', 'later', { was: n.was || 'new', places: [] }),
        r, RECEIPT_NOT, n.at, n.by, '');
    }
    const legacy = r.status === 'skipped' ? (RECEIPT_LEGACY_PLACE[r.skipWhy] || '') : '';
    if (r.status === 'done' || legacy) {
      if (legacy) places.push(legacy);
      const where = unique(places);
      const offBooks = where.length > 0 && where.every(p => RECEIPT_OFF_BOOKS.indexOf(p) !== -1);
      const noQb = where.length > 0 && where.every(p => RECEIPT_NOT_TO_QB.indexOf(p) !== -1);
      // When it was filed: the last line put somewhere, if nothing better.
      const last = splits.slice().sort((a, b) => String((b || {}).at || '').localeCompare(String((a || {}).at || '')))[0] || {};
      return dated(one('filed', 'Filed', 'done', { places: where, legacy: legacy, offBooks: offBooks, noQb: noQb }),
        r, r.status, last.at, last.by && last.by !== 'Job Hub' ? last.by : '', last.by === 'Job Hub' ? 'Job Hub' : '');
    }
    if (r.status === 'skipped') {
      const why = r.skippedBy === 'claude' ? 'Personal (Claude)' : (RECEIPT_WHY[r.skipWhy] || String(r.skipWhy || ''));
      return dated(one('aside', 'Set aside', 'later', { why: why, places: unique(places) }),
        r, 'skipped', '', r.skippedBy && r.skippedBy !== 'claude' ? r.skippedBy : '', r.skippedBy === 'claude' ? 'Claude' : '');
    }
    return dated(one('tosort', 'To sort', 'due', { part: splits.length > 0, places: unique(places) }),
      r, r.status === 'new' ? 'new' : '__none', r.createdAt, '', '');
  }
  function unique(list) { return list.filter((x, i, a) => x && a.indexOf(x) === i); }
  // False for a bill still to pay and for one marked not a receipt: no cost
  // of the business, in any total (stages.py receipt_counts).
  const receiptCounts = r => { const id = receipt(r).id; return id !== 'topay' && id !== 'notreceipt'; };

  // ------------------------------------------------------- equipment problems
  //
  // A problem on a machine (equipment.js issues[]). doneAt and partAtShop
  // decide Fixed and Part at the shop, whatever `status` says (see the top);
  // `status` 'ordered' is Part ordered; anything else is Open.
  const ISSUE_STAGES = [{ id: 'open', name: 'Open' }, { id: 'ordered', name: 'Part ordered' },
    { id: 'atshop', name: 'Part at the shop' }, { id: 'fixed', name: 'Fixed' }];
  const ISSUE_TONE = { open: 'info', ordered: 'wait', atshop: 'soon', fixed: 'done' };
  const ISSUE_NAME = { open: 'Open', ordered: 'Part ordered', atshop: 'Part at the shop', fixed: 'Fixed' };
  function issueId(i) {
    i = i || {};
    return i.doneAt ? 'fixed' : i.partAtShop ? 'atshop' : i.status === 'ordered' ? 'ordered' : 'open';
  }
  function issue(i) {
    i = i || {};
    const id = issueId(i);
    const st = one(id, ISSUE_NAME[id], ISSUE_TONE[id]);
    if (id === 'fixed') return dated(st, i, id, i.doneAt, '', i.doneBy || '');
    if (id === 'open') return dated(st, i, id, i.reopenedAt || i.at, '', i.reopenedAt ? '' : (i.by || ''));
    return dated(st, i, id, '', '', '');
  }
  // What one move writes on the problem: the status, and the old fields kept
  // in step (Fixed is doneAt; Part at the shop is partAtShop; reopening
  // stamps reopenedAt, which the Maintenance board sync measures from).
  // `who` = { uid, name }; `at` = when (ISO), now if left out.
  function issuePatch(i, to, who, at) {
    i = i || {};
    const now = at || new Date().toISOString();
    const was = issueId(i);
    const p = { status: to, statusChange: { to: to, at: now, by: (who && who.uid) || '', name: (who && who.name) || '' } };
    if (to === 'fixed') {
      if (!i.doneAt) { p.doneAt = now; p.doneBy = (who && who.name) || null; }
    } else {
      p.partAtShop = to === 'atshop';
      if (i.doneAt) { p.doneAt = null; p.doneBy = null; }
      if (was === 'fixed') p.reopenedAt = now;
    }
    return p;
  }

  // ------------------------------------------------------ crew change requests
  //
  // changeRequests (timeclock.js, storm.js): stored 'pending' / 'approved' /
  // 'rejected' / 'withdrawn' (firestore.rules checks those words). Who
  // decided and when were decidedBy / decidedAt; a withdrawal said neither.
  const REQUEST_STAGES = [{ id: 'waiting', name: 'Waiting' }, { id: 'approved', name: 'Approved' },
    { id: 'turneddown', name: 'Turned down' }, { id: 'withdrawn', name: 'Withdrawn' }];
  function request(r) {
    r = r || {};
    if (r.status === 'approved') return dated(one('approved', 'Approved', 'done'), r, 'approved', r.decidedAt, r.decidedBy, '');
    if (r.status === 'rejected') {
      return dated(one('turneddown', 'Turned down', 'later', { why: String(r.decidedReason || '') }), r, 'rejected', r.decidedAt, r.decidedBy, '');
    }
    if (r.status === 'withdrawn') return dated(one('withdrawn', 'Withdrawn', 'later'), r, 'withdrawn', '', r.requestedBy, r.requestedByName);
    // Filed and not yet decided -- a crew member can only ever file one so.
    return dated(one('waiting', 'Waiting', 'wait'), r, 'pending', r.createdAt, r.requestedBy, r.requestedByName);
  }
  const waiting = r => request(r).id === 'waiting';

  // ------------------------------------------------------------------ storms
  //
  // storms/{id}.status 'open' / 'closed' / 'abandoned' -- crew may work only
  // a storm whose STORED status is 'open' (firestore.rules), so nothing but
  // that word is ever read as open. Anything else unknown is not worked and
  // not billed: read as abandoned.
  const STORM_STAGES = [{ id: 'open', name: 'Open' }, { id: 'closed', name: 'Closed' }, { id: 'abandoned', name: 'Abandoned' }];
  function storm(s) {
    s = s || {};
    if (s.status === 'open') return dated(one('open', 'Open', 'due'), s, 'open', s.startedAt, '', s.startedBy || '');
    if (s.status === 'closed') return dated(one('closed', 'Closed', 'done'), s, 'closed', s.closedAt, '', '');
    return dated(one('abandoned', 'Abandoned', 'later'), s, s.status === 'abandoned' ? 'abandoned' : '__none', s.closedAt, '', '');
  }
  const stormOpen = s => !!s && storm(s).id === 'open';

  // ------------------------------------------------------------ writing one

  // The stamp a change of status writes beside it: to what, when, by whom.
  function stamp(to, who) {
    const u = (window.YDAuth && window.YDAuth.user) || {};
    return {
      to: to, at: new Date().toISOString(),
      by: who && who.uid != null ? who.uid : (u.uid || ''),
      name: who && who.name != null ? who.name : (u.displayName || u.email || ''),
    };
  }

  // -------------------------------------------------------------- showing one

  const escape = s => (typeof esc === 'function' ? esc(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  // "10/14" this year, "10/14/25" another.
  function shortDay(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    const md = (d.getMonth() + 1) + '/' + d.getDate();
    return d.getFullYear() === new Date().getFullYear() ? md : md + '/' + String(d.getFullYear()).slice(2);
  }
  // A uid's name: the people the clock knows (Your Crew), or this person
  // themselves. A crew phone knows only its own record -- '' for the rest.
  function nameOfUid(uid) {
    const u = (window.YDAuth && window.YDAuth.user) || {};
    if (uid && uid === u.uid) return u.displayName || u.email || '';
    const ppl = window.YDClock && window.YDClock.people ? (window.YDClock.people() || {}) : {};
    const p = ppl[uid];
    return (p && (p.name || p.email)) || '';
  }
  // "10/14 · Jonah": when, and who. A screen's own nameOf(uid) comes first
  // when it has an answer (a crew member's own list says "you"), then the
  // name the record carries, then nameOfUid.
  function whenWho(st, nameOf) {
    if (!st) return '';
    let who = (st.uid && typeof nameOf === 'function' && nameOf(st.uid)) || st.who || '';
    if (!who && st.uid) who = nameOfUid(st.uid) || '';
    // An email is shown as the part before the @ -- a name more often than not.
    if (/@/.test(who)) who = who.split('@')[0];
    return [shortDay(st.at), who].filter(Boolean).join(' · ');
  }
  // The one chip: "✓ Filed", "Part ordered", "Waiting". o.detail adds words
  // after the name; o.when (default true) adds the date and who; o.nameOf
  // turns a uid into a name.
  function chip(st, o) {
    if (!st) return '';
    o = o || {};
    const tone = TONES.indexOf(st.tone) !== -1 ? st.tone : 'info';
    const detail = o.detail != null ? o.detail : '';
    const when = o.when === false ? '' : whenWho(st, o.nameOf);
    return '<span class="stc stc-' + tone + '"' + (when ? ' title="' + escape(st.name + ' ' + when) + '"' : '') + '>' +
      (tone === 'done' ? '✓ ' : '') + escape(st.name) + (detail ? ' · ' + escape(detail) : '') +
      (when ? ' <span class="stc-when">' + escape(when) + '</span>' : '') + '</span>';
  }

  window.YDStages = {
    receipt: receipt, issue: issue, issueId: issueId, issuePatch: issuePatch, request: request, waiting: waiting,
    storm: storm, stormOpen: stormOpen, stamp: stamp, chip: chip, whenWho: whenWho,
    RECEIPT_STAGES: RECEIPT_STAGES, RECEIPT_WHY: RECEIPT_WHY, RECEIPT_LEGACY_PLACE: RECEIPT_LEGACY_PLACE,
    RECEIPT_OFF_BOOKS: RECEIPT_OFF_BOOKS, RECEIPT_NOT_TO_QB: RECEIPT_NOT_TO_QB,
    RECEIPT_TO_PAY: RECEIPT_TO_PAY, RECEIPT_NOT: RECEIPT_NOT, receiptCounts: receiptCounts,
    ISSUE_STAGES: ISSUE_STAGES, REQUEST_STAGES: REQUEST_STAGES, STORM_STAGES: STORM_STAGES,
  };
})();
