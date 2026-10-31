// The line of booked jobs: the first customer to say yes is first in line.
//
// Jonah (26 Oct 2026): "organize accepted job in order of acceptance so i can
// schedule properly. crew lead needs to always know what jobs are coming up."
//
// A job in line is booked and not started yet (in progress and finished jobs
// have left it; a copy or a snow contract marked to come off, or one in
// Recently deleted, was never in it). Each stands by when the yes came:
//   - said yes in QuickBooks: QuickBooks' own accepted date
//     (qbEstimate.acceptedDate), at the time Job Hub first saw it
//     (acceptedSeenAt) when that was the same day; acceptedSeenAt alone when
//     QuickBooks gave no date;
//   - booked by hand in Job Hub (Make it a job, moved to Won): when it was
//     booked (bidStageAt) --
//   whichever came first: a yes on the phone, booked that day, counts from
//   then though the customer ticked Accept in QuickBooks days later; and a
//   QuickBooks yes the app booked by itself later counts from the yes.
//   - neither (booked from the job form's status, or a job from before the
//     stages): when it went into Scheduled (workStageAt), else its own date.
// Never lastModified or qbEstimate.syncedAt: the server moves those on every
// check it makes.
//
// HIS ORDER WINS (memory: manual-override-always). A job he moves by hand
// carries jobLine { key, at, by }: `key` is where it now stands, written as
// the moment it would have had to be accepted to stand there -- the same
// scale as the acceptance times (milliseconds) -- so a move writes the one
// job moved, the rest keep their places, and a job accepted afterwards still
// joins the back of the line. `key` null is "back to the order accepted":
// the record is kept rather than deleted, so a form open with typing in it on
// another device takes the change too (sync.js SERVER_FIELDS, newest `at`
// wins). On the job rather than in a settings document: jobs/* already lets
// whoever may change jobs write it (no new security rule), it travels with
// the job's own sync, and app.js BOARD_FIELDS keeps it through form saves.
//
// Read by the Jobs board's Scheduled column (boards.js), My Jobs (app.js),
// Home (home.js), and the crew's copy of each job (crewjobs.js crewEntry:
// its place and accepted day, so the crew lead's list matches his).

(function () {
  'use strict';

  const HOUR = 3600000, MINUTE = 60000;
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  const inLine = d => !!d && statusOf(d) === 'booked' && !d.removeWhy && !d.deletedAt;
  const msOf = s => { const t = s ? Date.parse(s) : NaN; return isFinite(t) ? t : NaN; };
  const two = n => String(n).padStart(2, '0');
  const dayOf = t => { const d = new Date(t); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); };
  // A 'YYYY-MM-DD' day, as noon that day here: a date with no time on it.
  function noonOf(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : NaN;
  }

  // When the customer said yes: { ms, day 'YYYY-MM-DD', how 'qb' | 'booked'
  // | 'date' | '' }. ms is NaN when nothing says (such a job stands last).
  function acceptedOf(d) {
    d = d || {};
    const q = d.qbEstimate || {};
    const found = [];
    if (window.YDSync && YDSync.qbAccepted && YDSync.qbAccepted(q)) {
      const day = String(q.acceptedDate || '').slice(0, 10);
      const seen = msOf(d.acceptedSeenAt);
      let t = NaN;
      if (isFinite(noonOf(day))) t = isFinite(seen) && dayOf(seen) === day ? seen : noonOf(day);
      else if (isFinite(seen)) t = seen;
      if (isFinite(t)) found.push({ ms: t, day: isFinite(noonOf(day)) ? day : dayOf(t), how: 'qb' });
    }
    if (d.bidStage === 'won') {
      const t = msOf(d.bidStageAt);
      if (isFinite(t)) found.push({ ms: t, day: dayOf(t), how: 'booked' });
    }
    if (found.length) return found.sort((a, b) => a.ms - b.ms)[0];
    const w = msOf(d.workStageAt);
    if (isFinite(w) && (!d.workStage || d.workStage === 'scheduled')) return { ms: w, day: dayOf(w), how: 'booked' };
    const own = String(d.quoteDate || '').slice(0, 10);
    if (isFinite(noonOf(own))) return { ms: noonOf(own), day: own, how: 'date' };
    return { ms: NaN, day: '', how: '' };
  }
  // His own place for it, when he moved it by hand.
  function handKey(d) {
    const k = d && d.jobLine && d.jobLine.key;
    return typeof k === 'number' && isFinite(k) ? k : null;
  }

  // "Oct 14" (with the year when it is not this one).
  function shortDay(day) {
    const t = noonOf(day);
    if (!isFinite(t)) return '';
    const d = new Date(t);
    return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // What the accepted date is, in the same words everywhere it shows -- the
  // board, My Jobs, Home and the crew's list.
  function acceptedWords(acc) {
    acc = acc || {};
    const day = shortDay(acc.day);
    if (!day) return 'Date of the yes not known';
    return (acc.how === 'qb' ? 'Accepted ' : acc.how === 'booked' ? 'Booked ' : 'Job date ') + day;
  }

  // A place in line as words: "1st", "2nd", "11th", "23rd". Not "#1": the
  // job's own number is written "#1042" right beside its name.
  function nth(n) {
    const t = n % 100, o = n % 10;
    return n + (t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th');
  }

  // Finite keys first, smaller first; then the acceptance itself, the name
  // and the id, so two jobs with the same day always stand the same way.
  const num = (a, b) => (isFinite(a) ? 0 : 1) - (isFinite(b) ? 0 : 1) || (isFinite(a) && isFinite(b) ? a - b : 0);
  function cmp(a, b) {
    return num(a.key, b.key) || num(a.acc.ms, b.acc.ms) ||
      String(a.d.customerName || '').localeCompare(String(b.d.customerName || '')) || String(a.id).localeCompare(String(b.id));
  }

  // The line, first in line first: [{ id, d, acc, hand, key, place }].
  // Worked out once per list of jobs (app.js loadAllJobs hands out a new
  // list whenever a job changes).
  let lastList = null, lastRows = [];
  function line() {
    const all = typeof loadAllJobs === 'function' ? loadAllJobs() || [] : [];
    if (all === lastList) return lastRows;
    const rows = all.filter(d => d && d._id && inLine(d)).map(d => {
      const acc = acceptedOf(d), hand = handKey(d);
      return { id: d._id, d: d, acc: acc, hand: hand != null, key: hand != null ? hand : acc.ms };
    }).sort(cmp);
    rows.forEach((r, i) => { r.place = i + 1; });
    lastList = all; lastRows = rows;
    return rows;
  }
  function spotOf(id) { return line().find(r => r.id === id) || null; }

  // ------------------------------------------------------------ moving by hand

  const canMove = () => typeof ydCan === 'function' && ydCan('jobs', 'change') && !!window.YDSync && !!YDSync.patchJob;
  const who = () => {
    const a = window.YDAuth || {};
    const u = a.user || {};
    const own = window.YDRemind && YDRemind.me && YDRemind.me();
    return (own && own.name) || u.displayName || u.email || '';
  };
  // The keys to write so the line reads `order`, with `moved` the job put
  // in its new place: it gets a key between its new neighbours; every other
  // job keeps its own unless there is no room (two jobs on the same day, or
  // keys too close), when it is nudged a minute past the one before it.
  function keysFor(order, moved) {
    const out = {};
    let prev = -Infinity;
    order.forEach((r, i) => {
      let k;
      if (r === moved) {
        const next = order[i + 1];
        const nk = next && isFinite(next.key) ? next.key : NaN;
        if (i === 0) k = isFinite(nk) ? nk - HOUR : Date.now();
        // At the back: as if the yes came now, so one that comes later still
        // stands behind it.
        else if (!isFinite(nk)) k = Math.max(Date.now(), prev + MINUTE);
        else k = (prev + nk) / 2;
        if (!(k > prev)) k = prev + MINUTE;
        out[r.id] = k;
      } else if (isFinite(r.key) && r.key > prev) {
        k = r.key;
      } else {
        k = (isFinite(prev) ? prev : Date.now()) + MINUTE;
        out[r.id] = k;
      }
      prev = k;
    });
    return out;
  }
  function write(keys) {
    const at = new Date().toISOString(), by = who();
    let ok = 0;
    Object.keys(keys).forEach(id => {
      if (YDSync.patchJob(id, { jobLine: { key: keys[id], at: at, by: by } })) ok++;
    });
    return ok;
  }
  // Puts a job at a place in line (0 = first), counting without it.
  function moveTo(id, idx) {
    if (!canMove()) return false;
    const rows = line();
    const me = rows.find(r => r.id === id);
    if (!me) return false;
    const rest = rows.filter(r => r !== me);
    idx = Math.max(0, Math.min(rest.length, idx));
    if (rows.indexOf(me) === idx) return false;
    const order = rest.slice(0, idx).concat([me], rest.slice(idx));
    return write(keysFor(order, me)) > 0;
  }
  // One place up (-1) or down (+1).
  function move(id, step) {
    const rows = line();
    const i = rows.findIndex(r => r.id === id);
    return i !== -1 && moveTo(id, i + (step < 0 ? -1 : 1));
  }
  // Dropped above another job in line (a drag on the Jobs board), or at the
  // back (beforeId null / not in line).
  // Dropped before a card that is not in the line (one taken off the jobs, on
  // the board still): left where it is, not sent to the back.
  function moveBefore(id, beforeId) {
    const rest = line().filter(r => r.id !== id);
    const i = beforeId ? rest.findIndex(r => r.id === beforeId) : -1;
    if (beforeId && i === -1) return false;
    return moveTo(id, i === -1 ? rest.length : i);
  }
  // Back to the order the customers said yes in: every hand place cleared.
  // Says how many were moved, and gives back what they were (for Undo).
  function reset() {
    if (!canMove()) return null;
    const moved = line().filter(r => r.hand);
    if (!moved.length) return null;
    const was = {};
    moved.forEach(r => { was[r.id] = r.d.jobLine; });
    const at = new Date().toISOString(), by = who();
    moved.forEach(r => YDSync.patchJob(r.id, { jobLine: { key: null, at: at, by: by } }));
    return was;
  }
  function putBack(was) {
    if (!canMove() || !was) return;
    const at = new Date().toISOString(), by = who();
    Object.keys(was).forEach(id => {
      const k = was[id] && was[id].key;
      if (typeof k === 'number') YDSync.patchJob(id, { jobLine: { key: k, at: at, by: by } });
    });
  }

  // The buttons the screens put on a job (onclick handlers are globals).
  window.jobLineMove = function (id, step) {
    if (!move(id, step)) return;
    const r = spotOf(id);
    if (r && typeof showToast === 'function') showToast((String(r.d.customerName || 'Job').trim() || 'Job') + ' is ' + nth(r.place) + ' in line now');
  };
  window.jobLineReset = function () {
    const was = reset();
    if (!was) return;
    const n = Object.keys(was).length;
    const say = 'Back to the order they said yes in — ' + (n === 1 ? '1 job' : n + ' jobs') + ' moved back';
    if (typeof showUndo === 'function') showUndo(say, () => putBack(was), 10000);
    else if (typeof showToast === 'function') showToast(say);
  };

  window.YDJobLine = {
    line: line,
    spotOf: spotOf,
    inLine: inLine,
    acceptedOf: acceptedOf,
    words: acceptedWords,
    shortDay: shortDay,
    nth: nth,
    // Whether anything in line stands where he put it rather than by its yes.
    anyByHand: () => line().some(r => r.hand),
    move: move, moveTo: moveTo, moveBefore: moveBefore, reset: reset,
    canMove: canMove,
  };
})();
