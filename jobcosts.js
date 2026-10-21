// Estimate vs actual -- where each job made or lost money against what it
// was bid at (Jonah, 14 Oct 2026: "estimate vs actual page").
//
// Two places: on Tracking, the open job side by side -- crew-days and what
// they cost, materials, delivery, dumpsters and rentals, fuel, subcontractors,
// the total cost, the price, the profit, the margin and the profit per
// crew-day, each with its difference coloured over or under; and on All
// Jobs, every booked, in-progress and finished job in one table, worst
// first, so the ones that went over stand out.
//
// THE ESTIMATE SIDE is never worked out here. It is the bid as it went to
// QuickBooks (estimate.js keeps what each version sent cost us -- costSnapshot
// -- because pricing the estimate again later would follow Supplies' prices,
// which receipts move to what was really paid, and the difference would
// quietly vanish), or, before anything was sent, the job's estimate priced
// now by the same pricing.js price() the Job tab uses. A job with no
// estimate in Job Hub (bid before there was one) has its price, and
// whatever he types in for the rest.
//
// THE ACTUAL SIDE is what the app already holds about the job:
//   labour     approved clock shifts on it and hours typed in on Tracking
//              (YDClock.forJob -- the same figures as Labor Hours), turned
//              into crew-days by pricing/rules.crewDayHours (his to set;
//              nothing assumed) and costed at the crew-day rate the job was
//              bid with, so a job done in the time it was bid for shows no
//              labour difference. What the crew were actually paid (pay
//              rates) is shown beside it.
//   purchases  the job's Materials & Purchases -- receipt lines and lines
//              typed in -- sorted into materials, delivery, dumpsters &
//              rentals, fuel, subcontractors and other by what the receipt
//              was (its kind) and the words on the line (bucketOfLine).
//   subs       what linked subcontractor properties have charged this season
//              (subs.js forJob, owner only).
//   price      the Job Price (with any add-ons); the QuickBooks invoice and
//              the payments logged are shown with it.
// Every one of those can be set by hand instead (Jonah: everything automatic
// gets a by-hand way) -- on either side -- kept on the job as
//   costByHand: { est: { key: entry }, act: { key: entry } }
//   entry: { v, note, at, by }   v: crew-days, or cents for the rest
// and always shown as "by hand". keys: crewDays and the COSTS below.
//
// A cost not recorded yet is never a $0 that turns into profit: it is shown
// as "not recorded", and the totals count it at what the estimate said, with
// a mark saying so. A job with nothing recorded at all shows nothing yet.
//
// Who: the owner, and an admin given both Jobs and Crew hours & pay. Crew
// never. Setting a figure by hand also needs Jobs: Change.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const P = () => window.YDPricing;
  // A number, or null for "not given". Zero is a number.
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%\s]/g, ''));
    return isFinite(n) ? n : null;
  }
  const money = c => fmtMoney((Number(c) || 0) / 100);
  const toCents = v => { const n = num(v); return n === null ? null : Math.round(n * 100); };
  const fmtDays = d => String(Math.round(d * 100) / 100);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const shortDate = iso => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  };

  // The comparison is the job's money (Jobs) and what the crew's time cost
  // (Crew hours & pay -- without it the clock holds only their own shifts,
  // and the labour would be quietly wrong).
  const sees = () => typeof ydCan === 'function' && ydCan('jobs', 'see') && ydCan('hours', 'see');
  const changes = () => sees() && ydCan('jobs', 'change');
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);

  // The costs compared after labour, in the order shown. The first four are
  // what an estimate prices; the last two only ever come from what was
  // bought or typed in.
  const COSTS = [
    ['materials', 'Materials', 'tax in, as you pay it'],
    ['delivery', 'Delivery', ''],
    ['dumpsters', 'Dumpsters, dump fees & rentals', ''],
    ['fuel', 'Fuel', ''],
    ['subs', 'Subcontractors', ''],
    ['other', 'Other costs', 'tools, repairs, anything else'],
  ];
  const COST_NAME = {};
  COSTS.forEach(([k, n]) => { COST_NAME[k] = n; });
  const HAND_KEYS = ['crewDays'].concat(COSTS.map(c => c[0]));
  const ALWAYS_SHOWN = ['materials', 'delivery', 'dumpsters', 'fuel'];

  // ------------------------------------------------------------ purchases

  // What one line on the job's Materials & Purchases is. A line from a
  // receipt goes by what the email reader said the receipt was (its kind,
  // read with it -- no extra call), else by its words; a line typed in by
  // hand by its words alone. A delivery charge is a delivery whatever the
  // receipt was. Anything else is materials.
  const KIND_BUCKET = { fuel: 'fuel', rental: 'dumpsters', dump_and_disposal: 'dumpsters',
    subcontractor: 'subs', tools: 'other', equipment_and_repairs: 'other', vehicle: 'other' };
  const DELIVERY_WORDS = /\b(deliver(y|ies|ed)?|freight|shipping)\b/i;
  const DUMP_WORDS = /\b(dumpsters?|roll[- ]?offs?|dump (fee|fees|charge|charges|run|runs)|tipping fees?|disposal|rentals?)\b/i;
  const FUEL_WORDS = /\b(fuel|gasoline|unleaded|diesel)\b/i;
  const isTaxLine = m => /^\s*sales\s+tax\s*$/i.test(String(m.item || ''));
  function bucketOfLine(m, kind) {
    const words = String(m.item || '');
    if (DELIVERY_WORDS.test(words)) return 'delivery';
    if (KIND_BUCKET[kind]) return KIND_BUCKET[kind];
    // Had for so many days (the Unit "Day" on a purchase): a rental.
    if (/^(days?|daily|per day)$/i.test(String(m.unit || '').trim())) return 'dumpsters';
    if (DUMP_WORDS.test(words)) return 'dumpsters';
    if (FUEL_WORDS.test(words)) return 'fuel';
    return 'materials';
  }
  // Every purchase on the job with its cents and where it counts. The sales
  // tax line a receipt puts on a job goes with the rest of that receipt's
  // lines -- wherever most of its money went.
  function purchases(job) {
    const recs = window.YDReceipts && YDReceipts.all ? YDReceipts.all() || {} : {};
    const list = (Array.isArray(job.materials) ? job.materials : []).filter(m => m && typeof m === 'object')
      .map(m => ({ m: m, cents: toCents(m.price), kind: m.receiptId && recs[m.receiptId] ? String(recs[m.receiptId].kind || '') : '' }))
      .filter(p => p.cents !== null && p.cents !== 0);
    const bySplit = {};
    list.forEach(p => {
      if (isTaxLine(p.m)) return;
      p.bucket = bucketOfLine(p.m, p.kind);
      const k = p.m.splitId || p.m.receiptId;
      if (!k) return;
      const t = bySplit[k] = bySplit[k] || {};
      t[p.bucket] = (t[p.bucket] || 0) + p.cents;
    });
    list.forEach(p => {
      if (!isTaxLine(p.m)) return;
      const t = bySplit[p.m.splitId || p.m.receiptId] || {};
      p.bucket = Object.keys(t).sort((a, b) => t[b] - t[a])[0] || 'materials';
    });
    return list;
  }

  // -------------------------------------------------------- by hand

  // Only well-formed entries, so nothing odd on a job can break the sums.
  function handOf(job) {
    const h = (job && job.costByHand) || {}, out = { est: {}, act: {} };
    ['est', 'act'].forEach(side => {
      const s = h[side] || {};
      HAND_KEYS.forEach(k => {
        const e = s[k];
        if (e && typeof e === 'object' && typeof e.v === 'number' && isFinite(e.v) && e.v >= 0) {
          out[side][k] = { v: e.v, note: String(e.note || ''), at: String(e.at || ''), by: String(e.by || '') };
        }
      });
    });
    return out;
  }

  // ------------------------------------------------------- the estimate

  const hasLines = est => !!(est && ((Array.isArray(est.work) && est.work.length) || (Array.isArray(est.materials) && est.materials.length)));
  // The last version sent to QuickBooks that kept what it cost us (versions
  // sent before 14 Oct 2026 did not).
  function lastSent(est) {
    const list = (est && Array.isArray(est.sent) ? est.sent : [])
      .filter(v => v && v.cost && typeof v.cost.priceCents === 'number');
    return list.length ? list[list.length - 1] : null;
  }
  // The job's price before add-ons: what it was sold at (app.js baseJobPrice).
  function baseCents(job) {
    const b = num(job.baseJobPrice);
    if (b !== null && b > 0) return Math.round(b * 100);
    const price = toCents(parseMoney(job.jobPrice || ''));
    return price > 0 ? price - addOnsCents(job) : null;
  }
  function addOnsCents(job) {
    return (Array.isArray(job.additionalCosts) ? job.additionalCosts : [])
      .reduce((s, e) => s + (toCents(e && e.materialCost) || 0) + (toCents(e && e.laborCost) || 0), 0);
  }

  // wantNow: the estimate as it is now even when a version was sent.
  // ctx.lean: the All Jobs table, which never shows what a sent estimate
  // prices at today (only the job's own page does, in a hint) -- pricing every
  // job's estimate for that figure made each redraw cost a pricing run a job.
  function estimateSide(job, wantNow, ctx) {
    const rules = P() ? P().rules() : {};
    const est = job.estimate && typeof job.estimate === 'object' ? job.estimate : null;
    const out = { from: 'none', priceCents: null, crewDays: null, rateCents: num(rules.crewDayCents),
                  costs: {}, complete: true, problems: 0, sentAt: null, docNumber: null, nowCents: null, hand: {} };
    const sent = lastSent(est);
    const needNow = !(ctx && ctx.lean && sent && !wantNow);
    const r = needNow && hasLines(est) && window.YDEstimate && YDEstimate.priceSaved ? YDEstimate.priceSaved(est, job.city || '', job._id) : null;
    if (sent && !wantNow) {
      const c = sent.cost, byKind = c.byKind || {};
      const dumps = (num(byKind.dumpster) || 0) + (num(byKind.rental) || 0);
      out.from = 'sent'; out.sentAt = sent.at || null; out.docNumber = sent.docNumber || null;
      out.priceCents = c.priceCents;
      out.crewDays = num(c.crewDays) > 0 ? num(c.crewDays) : null;
      // The crew-day rate the job was bid with: a later change to the rate
      // is not this job's labour going over.
      if (num(c.crewDayCents) !== null) out.rateCents = num(c.crewDayCents);
      out.costs = { materials: Math.max(0, (num(c.materialCostCents) || 0) - dumps), dumpsters: dumps,
                    delivery: num(c.deliveryCostCents) || 0, fuel: num(c.fuelCostCents) || 0 };
      out.complete = !!c.complete;
      if (r) out.nowCents = r.totalCents;
    } else if (r) {
      out.from = 'now';
      out.priceCents = r.totalCents;
      out.crewDays = r.crewDays > 0 ? r.crewDays : null;
      let dumps = 0, mats = 0;
      r.takeoff.concat(r.added).forEach(l => {
        const c = l.costTotalCents || 0;
        if (l.category === 'dumpster' || l.category === 'rental') dumps += c; else mats += c;
      });
      out.costs = { materials: mats, dumpsters: dumps, delivery: r.profit.deliveryCostCents || 0, fuel: r.profit.fuelCostCents || 0 };
      out.complete = !!r.profit.complete;
      out.problems = r.problems.length;
    } else {
      out.priceCents = baseCents(job);
    }
    const hand = handOf(job).est;
    if (hand.crewDays) { out.crewDays = hand.crewDays.v; out.hand.crewDays = hand.crewDays; }
    COSTS.forEach(([k]) => { if (hand[k]) { out.costs[k] = hand[k].v; out.hand[k] = hand[k]; } });
    // Something to compare against: an estimate, or figures typed in.
    out.has = out.from !== 'none' || Object.keys(out.hand).length > 0;
    out.labourCents = out.crewDays !== null && out.rateCents !== null ? Math.round(out.crewDays * out.rateCents) : null;
    return out;
  }

  // --------------------------------------------------------- the actual

  // Shifts on the job from the clock, by the day: how many days the crew
  // were there. Only when every counted hour is among them (an old job's
  // hours can come from the summary of old shifts, which has no dates).
  // The shifts that count, by job -- worked out once a redraw (ctx) instead of
  // every job walking every shift on the books.
  function shiftsByJob(C, ctx) {
    if (ctx && ctx.byJob) return ctx.byJob;
    const by = {};
    Object.values(C.shifts() || {}).forEach(e => {
      if (!e || e.kind !== 'job' || !e.targetId || !C.counts(e)) return;
      (by[e.targetId] = by[e.targetId] || []).push(e);
    });
    if (ctx) ctx.byJob = by;
    return by;
  }
  function daysOnSite(id, paidHours, ctx) {
    const C = window.YDClock;
    if (!C || !C.shifts || !C.counts || !C.startMsOf || !(paidHours > 0)) return null;
    const seen = {};
    let h = 0, n = 0;
    (id ? shiftsByJob(C, ctx)[id] || [] : []).forEach(e => {
      const s = C.startMsOf(e);
      if (!s) return;
      seen[localYMD(new Date(s))] = true;
      h += e.paidHours != null ? Number(e.paidHours) || 0 : C.paidMs(e) / 3600000;
      n++;
    });
    const count = Object.keys(seen).length;
    return count && Math.abs(h - paidHours) <= 0.05 + n * 0.01 ? count : null;
  }

  function actualSide(job, id, est, ctx) {
    const rules = P() ? P().rules() : {};
    const dayHours = num(rules.crewDayHours) > 0 ? num(rules.crewDayHours) : null;
    const rate = est.rateCents;
    const hand = handOf(job).act;

    // Labour: the same sums as Labor Hours on Tracking -- approved clock
    // time at the rate each shift was approved at, hours typed in at the
    // standing rate. Pending shifts are not counted (they are listed).
    const c = id && window.YDClock && YDClock.forJob ? YDClock.forJob(id) : null;
    const typedHours = (Array.isArray(job.labor) ? job.labor : []).reduce((s, e) => s + entryHours(e), 0);
    const clockHours = c && isFinite(c.paidHours) ? c.paidHours : 0;
    const hours = Math.round((clockHours + typedHours) * 100) / 100;
    const rateHr = typeof LABOR_RATE === 'number' ? LABOR_RATE : 0;
    const wagesCents = Math.round((c && isFinite(c.costCents) ? c.costCents : 0) + typedHours * rateHr * 100);
    const lab = { source: 'none', days: null, cents: null, basis: null, hours: hours, typedHours: typedHours,
                  clockHours: clockHours, billable: c && isFinite(c.billableHours) ? c.billableHours : 0,
                  pending: c && isFinite(c.pendingHours) ? c.pendingHours : 0, wagesCents: wagesCents,
                  dayHours: dayHours, people: c ? Object.keys(c.byWorker || {}).length : 0, onSite: null, hand: null };
    if (hand.crewDays) {
      lab.source = 'hand'; lab.hand = hand.crewDays; lab.days = hand.crewDays.v; lab.basis = 'rate';
      lab.cents = rate !== null ? Math.round(lab.days * rate) : null;
    } else if (hours > 0) {
      lab.source = 'app';
      lab.days = dayHours ? hours / dayHours : null;
      if (lab.days !== null && rate !== null) { lab.cents = Math.round(lab.days * rate); lab.basis = 'rate'; }
      else { lab.cents = wagesCents; lab.basis = 'wages'; }
      lab.onSite = daysOnSite(id, clockHours, ctx);
    }

    // Purchases, then subcontractors, then what was typed in.
    const buys = purchases(job);
    const found = {}, lines = {};
    buys.forEach(p => {
      found[p.bucket] = (found[p.bucket] || 0) + p.cents;
      (lines[p.bucket] = lines[p.bucket] || []).push(p);
    });
    const sub = id && window.YDSubs && YDSubs.forJob ? YDSubs.forJob(id) : null;
    if (sub) found.subs = (found.subs || 0) + sub.cents;
    const costs = {};
    COSTS.forEach(([k]) => {
      if (hand[k]) costs[k] = { source: 'hand', cents: hand[k].v, hand: hand[k], found: found[k] != null ? found[k] : null };
      else if (found[k] != null) costs[k] = { source: 'app', cents: found[k] };
      else costs[k] = { source: 'none', cents: null };
    });

    const price = toCents(parseMoney(job.jobPrice || ''));
    return { labour: lab, costs: costs, lines: lines, sub: sub, priceCents: price > 0 ? price : null,
             addOnsCents: addOnsCents(job), buys: buys.length };
  }

  // --------------------------------------------------------- side by side

  function compare(job, id, wantNow, ctx) {
    const e = estimateSide(job, wantNow, ctx);
    const a = actualSide(job, id, e, ctx);
    const filled = [];          // costs counted at the estimate's figure
    let recorded = a.labour.source !== 'none';
    let actCost = 0, estCost = e.has ? 0 : null;

    // Labour: unknown cost (no crew-day rate) counts as nothing on either
    // side, and the job says so (incomplete).
    const estLab = e.labourCents;
    if (estCost !== null && estLab !== null) estCost += estLab;
    if (a.labour.source !== 'none' && a.labour.cents !== null) actCost += a.labour.cents;
    else if (estLab > 0) { actCost += estLab; filled.push('labour'); }

    COSTS.forEach(([k]) => {
      const ev = e.costs[k] != null ? e.costs[k] : null, av = a.costs[k];
      if (estCost !== null && ev !== null) estCost += ev;
      if (av.source !== 'none') { recorded = true; actCost += av.cents; }
      else if (ev > 0) { actCost += ev; filled.push(k); }
    });
    if (!recorded) actCost = null;

    const estPrice = e.priceCents, actPrice = a.priceCents;
    const estProfit = estPrice !== null && estCost !== null ? estPrice - estCost : null;
    const actProfit = actPrice !== null && actCost !== null ? actPrice - actCost : null;
    const marg = (p, pr) => p !== null && pr > 0 ? p / pr * 100 : null;
    const perDay = (p, d) => p !== null && d > 0 ? Math.round(p / d) : null;
    return {
      job: job, id: id, est: e, act: a, filled: filled, recorded: recorded,
      status: typeof normStatus === 'function' ? normStatus(job.jobStatus, job) : job.jobStatus,
      estCost: estCost, actCost: actCost, estPrice: estPrice, actPrice: actPrice,
      estProfit: estProfit, actProfit: actProfit,
      estMargin: marg(estProfit, estPrice), actMargin: marg(actProfit, actPrice),
      estPerDay: perDay(estProfit, e.crewDays), actPerDay: perDay(actProfit, a.labour.days),
      diff: estProfit !== null && actProfit !== null ? actProfit - estProfit : null,
      incomplete: !e.complete || (e.has && estLab === null),
    };
  }

  // ------------------------------------------------------------ drawing

  // The difference, coloured: a cost (or crew-days) over the estimate is
  // bad, a price or a profit over it is good. (An unfinished job's column
  // says "so far" once, in its heading.)
  function diffHtml(d, higherIsBetter, fmt) {
    if (d === null || d === undefined || !isFinite(d)) return '<span class="muted">—</span>';
    const zero = fmt === fmtDays ? Math.abs(d) < 0.005 : fmt === pts ? Math.abs(d) < 0.05 : Math.abs(d) < 1;
    if (zero) return '<span class="muted">same</span>';
    const good = higherIsBetter ? d > 0 : d < 0;
    const word = higherIsBetter ? (d > 0 ? 'more' : 'less') : (d > 0 ? 'over' : 'under');
    return '<span class="' + (good ? 'eva-good' : 'eva-bad') + '">' + (d > 0 ? '+' : '−') + fmt(Math.abs(d)) + ' ' + word + '</span>';
  }
  const pts = p => (Math.round(p * 10) / 10) + ' pts';
  const pct = p => p === null ? '—' : (Math.round(p * 10) / 10) + '%';
  const signed = c => c === null ? '—' : money(c);
  const dash = '<span class="muted">—</span>';
  const note = t => '<small>' + esc(t) + '</small>';

  const handTag = h => '<span class="eva-hand" title="' + esc('Typed in by hand' + (h.by ? ' by ' + h.by : '') +
    (h.at ? ' on ' + shortDate(h.at) : '') + (h.note ? ' — ' + h.note : '')) + '">by hand</span>';
  // A figure with the ✎ that sets it by hand, kept together on one line (a
  // phone's narrow column used to drop the ✎ onto a line of its own), then
  // "by hand" when it is.
  function fig(m, side, key, valueHtml, hand) {
    const p = changes() && m.id
      ? '<button class="eva-pen" title="Set by hand" aria-label="Set by hand" onclick="evaEdit(\'' + side + '\', \'' + key + '\')">✎</button>' : '';
    return '<span class="eva-v">' + valueHtml + p + '</span>' + (hand ? handTag(hand) : '');
  }

  let editing = null;          // { id, side, key } -- the by-hand box open
  const basisNow = {};         // job id -> true: compare with the estimate as it is now
  let detailsOpen = false;     // "What the actual figures are made of" opened
  window.evaDetails = function (open) { detailsOpen = !!open; };

  function estCell(m, key) {
    const e = m.est, h = e.hand[key] || null;
    if (key === 'crewDays') {
      return fig(m, 'est', key, e.crewDays !== null ? fmtDays(e.crewDays) : dash, h) +
        (e.crewDays === null && e.has ? note('no crew-days estimated — the profit leaves out labor') : '');
    }
    const v = e.costs[key];
    return fig(m, 'est', key, v == null ? dash : money(v), h);
  }

  function actCell(m, key) {
    const a = m.act.costs[key], ev = m.est.costs[key];
    if (a.source === 'hand') return fig(m, 'act', key, money(a.cents), a.hand) + (a.found != null ? note('the app found ' + money(a.found)) : '');
    if (a.source === 'app') {
      const n = (m.act.lines[key] || []).filter(p => !isTaxLine(p.m)).length;
      const from = key === 'subs' && m.act.sub
        ? plural(m.act.sub.visits, 'visit', 'visits') + ' this season' + (n ? ' + ' + plural(n, 'purchase', 'purchases') : '')
        : plural(n, 'purchase', 'purchases');
      return fig(m, 'act', key, money(a.cents)) + note(from);
    }
    if (ev > 0) return fig(m, 'act', key, '<span class="eva-none">not recorded</span>') + (m.recorded ? note('counted as estimated') : '');
    return fig(m, 'act', key, dash);
  }

  function labourRows(m) {
    const e = m.est, l = m.act.labour;
    // Crew-days
    let act;
    if (l.source === 'hand') act = fig(m, 'act', 'crewDays', fmtDays(l.days), l.hand) + (l.hours > 0 ? note('the clock has ' + fmtHrsMin(l.hours)) : '');
    else if (l.source === 'app') {
      act = l.days !== null ? fig(m, 'act', 'crewDays', fmtDays(l.days)) + note(fmtHrsMin(l.hours) + (l.onSite ? ' on ' + plural(l.onSite, 'day', 'days') : ''))
        : fig(m, 'act', 'crewDays', esc(fmtHrsMin(l.hours))) + note('set Hours in a crew-day to count crew-days');
    } else act = fig(m, 'act', 'crewDays', '<span class="eva-none">' + (m.status === 'booked' || m.status === 'quoting' ? 'not started' : 'no hours yet') + '</span>') +
      (e.labourCents > 0 && m.recorded ? note('counted as estimated') : '');
    const dayDiff = e.crewDays !== null && l.days !== null && l.source !== 'none' ? l.days - e.crewDays : null;
    let out = row('Crew-days', 'the time the job takes', estCell(m, 'crewDays'), act, diffHtml(dayDiff, false, fmtDays));

    // Labour cost
    const rateNote = e.rateCents !== null ? (e.crewDays !== null ? fmtDays(e.crewDays) + ' × ' + money(e.rateCents) : '') : 'no crew-day rate set';
    const estLab = e.labourCents !== null ? money(e.labourCents) + (rateNote ? note(rateNote) : '')
      : dash + (rateNote && e.has ? note(rateNote) : '');
    let actLab;
    if (l.source === 'none') actLab = e.labourCents > 0 ? '<span class="eva-none">not recorded</span>' + (m.recorded ? note('counted as estimated') : '') : dash;
    else if (l.cents === null) actLab = dash + note('no crew-day rate set');
    else if (l.basis === 'rate') actLab = money(l.cents) + note('at the crew-day rate' + (l.source === 'app' ? ' · wages paid ' + money(l.wagesCents) : ''));
    else actLab = money(l.cents) + note('wages paid (pay rates) — not like for like until Hours in a crew-day is set');
    const labDiff = e.labourCents !== null && l.source !== 'none' && l.cents !== null ? l.cents - e.labourCents : null;
    out += row('Labor cost', '', estLab, actLab, diffHtml(labDiff, false, money));
    return out;
  }

  function row(label, sub, estH, actH, diffH, cls) {
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td class="eva-l">' + esc(label) +
      (sub ? note(sub) : '') + '</td><td>' + estH + '</td><td>' + actH + '</td><td>' + diffH + '</td></tr>';
  }

  function tableHtml(m) {
    let h = labourRows(m);
    COSTS.forEach(([k, name, sub]) => {
      const a = m.act.costs[k], ev = m.est.costs[k];
      if (ALWAYS_SHOWN.indexOf(k) === -1 && a.source === 'none' && !(ev > 0) && !m.est.hand[k]) return;
      const d = a.source !== 'none' && ev != null ? a.cents - ev : null;
      h += row(name, sub, estCell(m, k), actCell(m, k), diffHtml(d, false, money));
    });
    const costDiff = m.estCost !== null && m.actCost !== null ? m.actCost - m.estCost : null;
    h += row('Total cost', '', m.estCost !== null ? money(m.estCost) : dash,
      m.actCost !== null ? money(m.actCost) + (m.filled.length ? note('* some counted as estimated') : '') : '<span class="eva-none">nothing recorded yet</span>',
      diffHtml(costDiff, false, money), 'eva-total');
    const a = m.act;
    const priceNote = a.addOnsCents > 0 ? note('includes ' + money(a.addOnsCents) + ' of add-ons') : note('the Job Price');
    const estPriceNote = m.est.from === 'none' && m.estPrice !== null ? note('the price it was sold at') : '';
    h += row('Price', 'before sales tax', m.estPrice !== null ? money(m.estPrice) + estPriceNote : dash,
      a.priceCents !== null ? money(a.priceCents) + priceNote : '<span class="eva-none">no price</span>',
      diffHtml(m.estPrice !== null && a.priceCents !== null ? a.priceCents - m.estPrice : null, true, money));
    h += row('Profit', '', signed(m.estProfit), m.actProfit !== null ? money(m.actProfit) + (m.filled.length ? ' *' : '') : dash,
      diffHtml(m.diff, true, money), 'eva-total eva-profit');
    h += row('Margin', '', pct(m.estMargin), pct(m.actMargin),
      diffHtml(m.estMargin !== null && m.actMargin !== null ? m.actMargin - m.estMargin : null, true, pts));
    h += row('Profit per crew-day', '', signed(m.estPerDay), signed(m.actPerDay),
      diffHtml(m.estPerDay !== null && m.actPerDay !== null ? m.actPerDay - m.estPerDay : null, true, money));
    return '<div class="table-wrap"><table class="eva-table"><thead><tr><th></th><th>Estimated</th><th>Actual' +
      (m.status === 'complete' ? '' : ' so far') + '</th><th>Difference</th></tr></thead><tbody>' + h + '</tbody></table></div>';
  }

  // Where the estimate side comes from, in a line.
  function basisHtml(m) {
    const e = m.est, id = safeId(m.id);
    if (e.from === 'sent') {
      return '<div class="eva-basis">Estimated: <b>the bid as it went to QuickBooks</b>' +
        (e.sentAt ? ' on ' + esc(shortDate(e.sentAt)) : '') + (e.docNumber ? ' (#' + esc(e.docNumber) + ')' : '') + '. ' +
        '<button class="link-btn eva-view-btn" onclick="evaBasis(\'' + id + '\', true)">Use the estimate as it is now</button>' +
        (e.nowCents !== null && Math.abs(e.nowCents - e.priceCents) > 100
          ? '<div class="hint">The estimate prices at ' + esc(money(e.nowCents)) + ' today — it was changed after it was sent, or Supplies’ prices have moved since.</div>' : '') +
        '</div>';
    }
    if (e.from === 'now') {
      const sent = lastSent(m.job.estimate);
      return '<div class="eva-basis">Estimated: <b>the job’s estimate, priced with today’s Supplies prices</b>' +
        (sent ? '. <button class="link-btn eva-view-btn" onclick="evaBasis(\'' + id + '\', false)">Use the bid as it went to QuickBooks</button>'
              : ' — nothing sent to QuickBooks from Job Hub yet' + ((m.job.estimate && (m.job.estimate.sent || []).length) ? ' that kept its costs' : '') + '.') +
        (!e.complete ? '<div class="hint">Not final: ' + (e.problems ? 'some lines aren’t priced yet' : e.crewDays === null ? 'no crew-days on the estimate' : 'the crew-day rate isn’t set') + '.</div>' : '') +
        '</div>';
    }
    return '<div class="eva-basis">' + (e.has ? 'Estimated: <b>the figures typed in by hand</b> (no estimate in Job Hub for this job).'
        : '<b>No estimate in Job Hub for this job.</b>') +
      ' The estimated price is what it was sold at.' + (changes() ? ' Type in what you estimated with ✎.' : '') + '</div>';
  }

  // Hours in a crew-day not set: say how to, with what this job suggests.
  function setupHtml(m) {
    const rules = P() ? P().rules() : {};
    if (num(rules.crewDayHours) > 0) return '';
    const l = m.act.labour, rate = m.est.rateCents;
    const avg = l.clockHours > 0 && l.wagesCents > 0 ? l.wagesCents / l.hours : null;
    const guess = avg && rate ? Math.round(rate / avg) : null;
    return '<div class="eva-setup">Set <b>Hours in a crew-day</b> in Pricing rules — the paid hours of the whole crew together ' +
      '(3 people × 8 hours = 24) — and the clock’s hours show here as crew-days, costed like the estimate.' +
      (guess ? ' At the ' + esc(money(Math.round(avg))) + ' an hour paid on this job, your ' + esc(money(rate)) + ' crew-day rate is about ' + guess + ' hours.' : '') +
      (isOwner() ? ' <button class="btn btn-sm" onclick="openPricingRules()">Open Pricing rules</button>' : '') + '</div>';
  }

  // The box for one figure by hand.
  function editHtml(m) {
    if (!editing || editing.id !== m.id || !changes()) return '';
    const side = editing.side, key = editing.key;
    const isDays = key === 'crewDays';
    // What is set by hand there now, if anything.
    const hand = side === 'est' ? m.est.hand[key] || null
      : isDays ? m.act.labour.hand : m.act.costs[key].hand || null;
    const what = (isDays ? 'Crew-days' : COST_NAME[key]) + ' — ' + (side === 'est' ? 'estimated' : 'actual') + ', by hand';
    let app = '';
    if (side === 'act' && isDays && m.act.labour.hours > 0) app = 'The clock and Labor Hours have ' + fmtHrsMin(m.act.labour.hours) + '.';
    else if (side === 'act' && !isDays && m.act.costs[key].source === 'app') app = 'Replaces the ' + money(m.act.costs[key].cents) + ' the app found.';
    else if (side === 'act' && !isDays && hand && m.act.costs[key].found != null) app = 'Replaces the ' + money(m.act.costs[key].found) + ' the app found.';
    else if (side === 'est' && m.est.from !== 'none') app = 'Replaces the estimate’s figure.';
    const val = hand ? (isDays ? String(hand.v) : (hand.v / 100).toFixed(2)) : '';
    return '<div class="eva-edit"><div class="eva-edit-h">' + esc(what) + '</div>' +
      (app ? '<div class="hint" style="flex-basis:100%;margin:0">' + esc(app) + '</div>' : '') +
      '<input id="evaHandVal" inputmode="decimal" value="' + esc(val) + '" placeholder="' + (isDays ? 'e.g. 2.5' : '$ e.g. 1250.00') + '" ' +
        'onkeydown="if (event.key === \'Enter\') evaHandSave()">' +
      '<input id="evaHandNote" value="' + esc(hand ? hand.note : '') + '" placeholder="Note (optional) — e.g. the supplier’s invoice #" maxlength="300" ' +
        'onkeydown="if (event.key === \'Enter\') evaHandSave()">' +
      '<button class="btn btn-sm btn-filled" onclick="evaHandSave()">Save</button>' +
      (hand ? '<button class="btn btn-sm" onclick="evaHandClear()">' + (side === 'est' && m.est.from === 'none' ? 'Take it off' : 'Back to the app’s figure') + '</button>' : '') +
      '<button class="btn btn-sm" onclick="evaHandCancel()">Cancel</button></div>';
  }

  // What the actual figures are made of, folded away.
  function detailsHtml(m) {
    const a = m.act, l = a.labour, parts = [];
    if (l.clockHours > 0) parts.push('<li><b>Clock:</b> ' + esc(fmtHrsMin(l.clockHours)) + ' paid, ' + esc(fmtHrsMin(l.billable)) + ' billable' +
      (l.people ? ' — ' + plural(l.people, 'person', 'people') : '') + '</li>');
    if (l.typedHours > 0) parts.push('<li><b>Typed in on Labor Hours:</b> ' + esc(fmtHrsMin(l.typedHours)) + '</li>');
    if (l.hours > 0) parts.push('<li><b>Wages paid</b> at each person’s pay rate: ' + esc(money(l.wagesCents)) + '</li>');
    if (l.pending > 0) parts.push('<li class="eva-warnline">' + esc(fmtHrsMin(l.pending)) + ' waiting for approval on the Clock tab — not counted.</li>');
    const older = window.YDClock && YDClock.oldLabourNote ? YDClock.oldLabourNote() : '';
    COSTS.forEach(([k, name]) => {
      const list = a.lines[k] || [];
      if (!list.length) return;
      const shown = list.slice(0, 25).map(p => esc(String(p.m.item || 'Item')) + (p.m.location ? ' <span class="muted">(' + esc(p.m.location) + ')</span>' : '') +
        ' ' + esc(money(p.cents))).join(' · ');
      parts.push('<li><b>' + esc(name) + ':</b> ' + shown + (list.length > 25 ? ' · and ' + (list.length - 25) + ' more' : '') + '</li>');
    });
    if (a.sub) parts.push('<li><b>Subcontractors</b> (' + esc(a.sub.subs.join(', ')) + '): ' + plural(a.sub.visits, 'visit', 'visits') +
      ' this season so far, ' + esc(money(a.sub.cents)) + ' to them, ' + esc(money(a.sub.ours)) + ' from the client</li>');
    // Everything typed in by hand, with its note.
    const hands = [];
    ['est', 'act'].forEach(side => {
      const h = handOf(m.job)[side];
      Object.keys(h).forEach(k => {
        const e = h[k];
        hands.push('<li><b>' + esc((k === 'crewDays' ? 'Crew-days' : COST_NAME[k]) + ', ' + (side === 'est' ? 'estimated' : 'actual')) + '</b> by hand: ' +
          esc(k === 'crewDays' ? fmtDays(e.v) : money(e.v)) + (e.by || e.at ? ' <span class="muted">— ' + esc([e.by, shortDate(e.at)].filter(Boolean).join(', ')) + '</span>' : '') +
          (e.note ? ' · ' + esc(e.note) : '') + '</li>');
      });
    });
    // The invoice from the estimate (one from the other QuickBooks company,
    // the test one, is not this job's).
    const inv = m.job.qbInvoiceRef, q = m.job.qbEstimate;
    const invOk = inv && !(inv.env && q && q.env && inv.env !== q.env);
    if (invOk && inv.total != null) parts.push('<li><b>QuickBooks invoice' + (inv.docNumber ? ' #' + esc(inv.docNumber) : '') + ':</b> ' +
      esc(fmtMoney(Number(inv.total) || 0)) + ' with tax' +
      (inv.balance != null ? ' · ' + (Number(inv.balance) > 0 ? esc(fmtMoney(Number(inv.balance))) + ' still owed' : 'paid in full') : '') + '</li>');
    const paid = (Array.isArray(m.job.payments) ? m.job.payments : []).reduce((s, p) => s + (toCents(p && p.amount) || 0), 0);
    if (paid) parts.push('<li><b>Payments logged</b> on Tracking: ' + esc(money(paid)) + '</li>');
    if (!parts.length && !hands.length && !older) return '';
    // Kept open across redraws (a shift approved, a receipt sorted) once opened.
    return '<details class="eva-more"' + (detailsOpen ? ' open' : '') + ' ontoggle="evaDetails(this.open)">' +
      '<summary>What the actual figures are made of</summary>' + (older || '') +
      '<ul>' + parts.join('') + hands.join('') + '</ul>' +
      '<p class="hint">Purchases come from Materials & Purchases above (receipts put on this job, and lines typed in). ' +
      'Each is sorted by what the receipt was and its words — delivery charges, dumpsters and rentals, fuel. ' +
      'Fuel goes on the trucks, not the job, so it is rarely recorded: set it with ✎ when you know it.</p></details>';
  }

  function badgeOf(m) {
    if (!m.recorded) return { text: m.est.has ? 'Nothing recorded yet' : '', cls: '' };
    if (m.diff === null) return { text: '', cls: '' };
    if (Math.abs(m.diff) < 100) return { text: 'On the estimate', cls: '' };
    return m.diff > 0 ? { text: '+' + money(m.diff) + ' vs estimate', cls: 'eva-badge-good' }
                      : { text: '−' + money(-m.diff) + ' vs estimate', cls: 'eva-badge-bad' };
  }

  // The open job, on Tracking.
  function renderJob() {
    jobTimer = null;
    const sec = el('evaSection'), wrap = el('evaWrap'), badge = el('evaBadge');
    if (!sec || !wrap) return;
    sec.hidden = !sees();
    if (!sees()) { wrap.innerHTML = ''; return; }
    // Never under someone typing in the by-hand box: Save or Cancel draws it.
    const a = document.activeElement;
    if (editing && a && wrap.contains(a) && a.tagName === 'INPUT') return;
    if (typeof currentJobId === 'undefined' || !currentJobId) {
      editing = null;
      if (badge) { badge.textContent = ''; badge.className = 'section-badge'; }
      wrap.innerHTML = '<p class="empty-msg">Open a job (My Jobs) to see its estimate against what it took.</p>';
      return;
    }
    if (editing && editing.id !== currentJobId) editing = null;
    const job = typeof getJobData === 'function' ? getJobData() : {};
    const m = compare(job, currentJobId, !!basisNow[currentJobId]);
    const b = badgeOf(m);
    if (badge) { badge.textContent = b.text; badge.className = 'section-badge' + (b.cls ? ' ' + b.cls : ''); }
    const lead = m.status === 'quoting' ? '<p class="hint" style="margin-top:0">This is still a bid — nothing should be spent on it yet.</p>'
      : m.status === 'booked' && !m.recorded ? '<p class="hint" style="margin-top:0">Booked, not started: the actual side fills in as the crew clock in and receipts are put on the job.</p>'
      : m.status === 'inprogress' ? '<p class="hint" style="margin-top:0">In progress — the actual side is so far.</p>' : '';
    wrap.innerHTML = lead + basisHtml(m) + setupHtml(m) + tableHtml(m) + editHtml(m) +
      (m.recorded && m.filled.length ? '<p class="hint">* Not recorded yet, so counted at the estimate’s figure: ' +
        esc(m.filled.map(k => k === 'labour' ? 'labor' : COST_NAME[k].toLowerCase()).join(', ')) +
        '. A cost left out would read as profit.</p>' : '') +
      detailsHtml(m);
    if (editing) { const box = el('evaHandVal'); if (box && document.activeElement !== box) box.focus(); }
  }

  // ------------------------------------------------------ job by job

  const ORDER = { booked: 1, inprogress: 0, complete: 2 };
  let listYear = 'this', listStatus = '';
  let listSort = { col: 'diff', asc: true };
  let noneOpen = false;       // the jobs with nothing to compare yet, opened out (this visit)
  // A job's year: when the crew first clocked into it, else its date on the
  // Job tab, else when it was last changed.
  function firstShifts() {
    const out = {}, C = window.YDClock;
    if (!C || !C.shifts || !C.startMsOf) return out;
    Object.values(C.shifts() || {}).forEach(e => {
      if (!e || e.kind !== 'job' || !e.targetId) return;
      const s = C.startMsOf(e);
      if (s && (!out[e.targetId] || s < out[e.targetId])) out[e.targetId] = s;
    });
    return out;
  }
  function yearOf(j, first) {
    if (first[j._id]) return new Date(first[j._id]).getFullYear();
    const d = /^\d{4}/.test(String(j.quoteDate || '')) ? j.quoteDate : j.lastModified;
    const y = parseInt(String(d || ''), 10);
    return isFinite(y) ? y : null;
  }

  function listModels() {
    const jobs = typeof loadAllJobs === 'function' ? loadAllJobs() : [];
    const first = firstShifts(), now = new Date().getFullYear();
    const want = listYear === 'this' ? now : listYear === 'last' ? now - 1 : null;
    const out = [], ctx = { lean: true, byJob: null };
    jobs.forEach(j => {
      if (!j || !j._id) return;
      const st = typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : j.jobStatus;
      if (ORDER[st] === undefined || (listStatus && st !== listStatus)) return;
      if (want !== null && yearOf(j, first) !== want) return;
      out.push(compare(j, j._id, !!basisNow[j._id], ctx));
    });
    return out;
  }
  const SORTS = {
    name: m => String(m.job.customerName || '').toLowerCase(),
    status: m => ORDER[m.status],
    // How far over (or under) the crew-days went: only with both sides known.
    days: m => m.act.labour.source !== 'none' && m.act.labour.days !== null && m.est.crewDays !== null
      ? m.act.labour.days - m.est.crewDays : null,
    estCost: m => m.estCost, actCost: m => m.actCost,
    estProfit: m => m.estProfit, actProfit: m => m.actProfit,
    diff: m => m.diff, margin: m => m.actMargin,
  };
  const SORT_NAMES = [['diff', 'furthest under the estimate'], ['actProfit', 'lowest profit'], ['margin', 'lowest margin'],
    ['days', 'most crew-days over'], ['actCost', 'highest cost'], ['name', 'name']];
  function sorted(list) {
    const f = SORTS[listSort.col] || SORTS.diff, dir = listSort.asc ? 1 : -1;
    // Unknowns always last, whichever way.
    return list.slice().sort((a, b) => {
      const va = f(a), vb = f(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }

  function renderList() {
    listTimer = null;
    const sec = el('evaListSection'), wrap = el('evaListWrap'), badge = el('evaListBadge');
    if (!sec || !wrap) return;
    sec.hidden = !sees();
    if (!sees()) { wrap.innerHTML = ''; return; }
    const list = sorted(listModels());
    const now = new Date().getFullYear();
    const both = list.filter(m => m.diff !== null);
    const over = both.filter(m => m.diff <= -100);
    const sumEst = both.reduce((s, m) => s + m.estProfit, 0), sumAct = both.reduce((s, m) => s + m.actProfit, 0);
    if (badge) badge.textContent = over.length ? plural(over.length, 'job', 'jobs') + ' under the estimate' : '';
    const sel = (v, cur) => v === cur ? ' selected' : '';
    const arrow = c => listSort.col === c ? (listSort.asc ? ' ▲' : ' ▼') : '';
    const th = (c, label) => '<th class="eva-sort" onclick="evaListSort(\'' + c + '\')">' + label + arrow(c) + '</th>';
    const card = (l, v, cls) => '<div class="summary-card' + (cls ? ' ' + cls : '') + '"><div class="summary-label">' + l + '</div><div class="summary-value">' + v + '</div></div>';
    let h = '<div class="filter-bar">' +
        '<select onchange="evaListFilter(\'year\', this.value)">' +
          '<option value="this"' + sel('this', listYear) + '>' + now + '</option>' +
          '<option value="last"' + sel('last', listYear) + '>' + (now - 1) + '</option>' +
          '<option value="all"' + sel('all', listYear) + '>Every year</option></select>' +
        '<select onchange="evaListFilter(\'status\', this.value)">' +
          '<option value=""' + sel('', listStatus) + '>Booked, in progress & complete</option>' +
          '<option value="booked"' + sel('booked', listStatus) + '>Booked</option>' +
          '<option value="inprogress"' + sel('inprogress', listStatus) + '>In progress</option>' +
          '<option value="complete"' + sel('complete', listStatus) + '>Complete</option></select>' +
        // A phone has no column headings to tap: sorting is picked here.
        '<select class="eva-sort-pick" onchange="evaListSortBy(this.value)">' + SORT_NAMES.map(([c, n]) =>
          '<option value="' + c + '"' + sel(c, listSort.col) + '>Sort: ' + n + '</option>').join('') + '</select>' +
      '</div>';
    if (!list.length) {
      wrap.innerHTML = h + '<p class="empty-msg">No booked, in-progress or finished jobs for this pick.</p>';
      return;
    }
    h += '<div class="dash-totals eva-totals">' +
        card('Jobs compared', both.length + ' <span class="eva-of">of ' + list.length + '</span>') +
        card('Estimated profit', both.length ? money(sumEst) : '—') +
        card('Actual profit', both.length ? '<span class="' + (sumAct < sumEst ? 'eva-bad' : 'eva-good') + '">' + money(sumAct) + '</span>' : '—', 'accent-top') +
        card('Under the estimate', over.length ? '<span class="eva-bad">' + over.length + '</span>' : '0') +
      '</div>';
    h += '<div class="table-wrap"><table class="eva-list"><thead><tr>' +
      th('name', 'Job') + th('status', 'Status') + th('days', 'Crew-days') +
      th('estCost', 'Est. cost') + th('actCost', 'Actual cost') + th('estProfit', 'Est. profit') +
      th('actProfit', 'Actual profit') + th('diff', 'Difference') + th('margin', 'Margin') +
      '</tr></thead><tbody>';
    const rowOf = m => {
      const e = m.est, l = m.act.labour, star = m.filled.length ? '<span class="eva-star" title="Not recorded yet, counted as estimated: ' +
        esc(m.filled.map(k => k === 'labour' ? 'labor' : COST_NAME[k].toLowerCase()).join(', ')) + '">*</span>' : '';
      const daysTxt = (e.crewDays !== null ? fmtDays(e.crewDays) : '—') + ' → ' +
        (l.source === 'none' ? '—' : l.days !== null ? fmtDays(l.days) : fmtHrsMin(l.hours));
      const daysCls = e.crewDays !== null && l.days !== null && l.source !== 'none' && l.days - e.crewDays > 0.005 ? ' class="eva-bad"' : '';
      const noEst = '<span class="muted">no estimate</span>', nothing = '<span class="muted">nothing yet</span>';
      // An estimate with unpriced lines or no crew-days: its profit is not the whole story.
      const shaky = m.incomplete ? '<span class="eva-star" title="The estimate isn’t complete — unpriced lines or no crew-days">?</span>' : '';
      return '<tr onclick="evaOpen(\'' + safeId(m.id) + '\')">' +
        '<td class="bold eva-job">' + jobNameHtml(m.job.customerName, String(m.job.estimateNumber || '').trim()) + '</td>' +
        '<td class="eva-st">' + statusPill(m.status) + '</td>' +
        '<td data-l="Crew-days"' + daysCls + '>' + esc(daysTxt) + '</td>' +
        '<td data-l="Est. cost">' + (m.estCost !== null ? money(m.estCost) : noEst) + '</td>' +
        '<td data-l="Actual cost">' + (m.actCost !== null ? money(m.actCost) + star : nothing) + '</td>' +
        '<td data-l="Est. profit">' + (m.estProfit !== null ? money(m.estProfit) + shaky : e.has ? '—' : noEst) + '</td>' +
        '<td data-l="Actual profit">' + (m.actProfit !== null ? money(m.actProfit) + star : m.recorded ? '—' : nothing) + '</td>' +
        '<td data-l="Difference">' + diffHtml(m.diff, true, money) + '</td>' +
        '<td data-l="Margin">' + pct(m.actMargin) + '</td></tr>';
    };
    // The jobs with nothing to compare yet -- no estimate to go by, or
    // nothing recorded against it -- fold into one line at the foot (15 Oct
    // 2026: a wall of "no estimate / nothing yet" rows under "0 of 14
    // compared"). Opened, they keep the order picked.
    const none = list.filter(m => m.diff === null);
    h += both.map(rowOf).join('') + '</tbody>';
    if (none.length) {
      h += '<tbody class="eva-none-fold"><tr class="eva-fold-row"><td colspan="9">' +
          '<button type="button" class="link-btn" onclick="evaNoneFold()" aria-expanded="' + (noneOpen ? 'true' : 'false') + '">' +
            plural(none.length, 'job', 'jobs') + ' with nothing to compare yet ' + (noneOpen ? '▴' : '▾') + '</button>' +
          '<span class="muted"> — no estimate to go by, or nothing recorded yet</span></td></tr></tbody>' +
        '<tbody class="eva-none-rows"' + (noneOpen ? '' : ' hidden') + '>' + none.map(rowOf).join('') + '</tbody>';
    }
    // What the ? means, said under the table: its tooltip never shows on a
    // phone or iPad.
    const anyShaky = list.some(m => m.incomplete && m.estProfit !== null);
    h += '</table></div>' +
      '<p class="hint">Tap a job for its side by side on Tracking. * a cost not recorded yet (no receipts, no hours), counted at the estimate’s figure so it never reads as profit. ' +
      (anyShaky ? '? after an estimated profit: that job’s estimate isn’t complete — some lines aren’t priced or it has no crew-days — so that profit isn’t the whole story. ' : '') +
      'In-progress jobs are so far. A job’s year is when the crew first clocked in, else its date.</p>';
    wrap.innerHTML = h;
  }

  // ------------------------------------------------------------ actions

  const who = () => { const u = (window.YDAuth && window.YDAuth.user) || {}; return String(u.displayName || u.email || '').slice(0, 80); };
  function jobOf(id) {
    if (id === currentJobId && typeof getJobData === 'function') return getJobData();
    try { return JSON.parse(readJobBlob(id) || 'null'); } catch (e) { return null; }
  }

  window.evaEdit = function (side, key) {
    if (!changes() || HAND_KEYS.indexOf(key) === -1 || (side !== 'est' && side !== 'act')) return;
    if (!currentJobId) return;
    editing = { id: currentJobId, side: side, key: key };
    renderJob();
    const box = el('evaHandVal');
    if (box) { box.focus(); box.select(); box.scrollIntoView({ block: 'nearest' }); }
  };
  window.evaHandCancel = function () { editing = null; renderJob(); };
  window.evaHandSave = function () {
    if (!editing || !changes()) return;
    const raw = String((el('evaHandVal') || {}).value || '').trim();
    const n = num(raw);
    if (n === null || n < 0) {
      showToast(editing.key === 'crewDays' ? 'Type the crew-days, like 2.5' : 'Type a dollar amount, like 1250');
      return;
    }
    const v = editing.key === 'crewDays' ? Math.round(n * 100) / 100 : Math.round(n * 100);
    const note = String((el('evaHandNote') || {}).value || '').trim().slice(0, 300);
    setHand(editing, { v: v, note: note, at: new Date().toISOString(), by: who() });
  };
  window.evaHandClear = function () {
    if (!editing || !changes()) return;
    setHand(editing, null);
  };
  // One figure by hand, kept on the job through patchJob -- the road a board
  // move takes -- so this device, the cloud and an open form all follow.
  function setHand(at, entry) {
    const job = jobOf(at.id);
    if (!job) { showToast('That job is not on this device'); return; }
    const h = handOf(job);
    if (entry) h[at.side][at.key] = entry; else delete h[at.side][at.key];
    // Only the sides with something on them; null rather than an empty map
    // when nothing is left (null is left out of the next save; never
    // undefined, which Firestore refuses whole).
    let value = {};
    ['est', 'act'].forEach(side => { if (Object.keys(h[side]).length) value[side] = h[side]; });
    if (!Object.keys(value).length) value = null;
    editing = null;
    const ok = window.YDSync && YDSync.patchJob(at.id, { costByHand: value });
    if (!ok) {
      // A job not saved yet on this device: carried in the form, saved with it.
      if (at.id === currentJobId && typeof boardFields !== 'undefined') {
        if (value) boardFields.costByHand = value; else delete boardFields.costByHand;
        if (typeof markDirty === 'function') markDirty();
      } else { showToast('Could not save that'); return; }
    }
    showToast(entry ? 'Saved — marked as by hand' : 'Back to the app’s figure');
    renderJob();
    if (shown('panel-dashboard')) renderList();
  }

  window.evaBasis = function (id, now) {
    if (now) basisNow[id] = true; else delete basisNow[id];
    renderJob();
  };
  window.evaOpen = function (id) {
    if (!id) return;
    // What is being typed into another job is saved before it is swapped out.
    if (typeof dirty !== 'undefined' && dirty && typeof autosave === 'function') autosave();
    if (id !== currentJobId && typeof loadJob === 'function') loadJob(id, true);
    switchTab('tracking');
    renderJob();
    const s = el('evaSection');
    if (s && !s.hidden) setTimeout(() => s.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30);
  };
  // A column picked for the first time sorts worst first: the lowest profit
  // and margin, the biggest overrun and cost (names A to Z).
  const LOW_FIRST = ['name', 'status', 'estProfit', 'actProfit', 'diff', 'margin'];
  window.evaListSort = function (col) {
    if (!SORTS[col]) return;
    if (listSort.col === col) listSort.asc = !listSort.asc;
    else listSort = { col: col, asc: LOW_FIRST.indexOf(col) !== -1 };
    renderList();
  };
  // The same from the phone's Sort picker: always worst first.
  window.evaListSortBy = function (col) {
    if (!SORTS[col]) return;
    listSort = { col: col, asc: LOW_FIRST.indexOf(col) !== -1 };
    renderList();
  };
  window.evaNoneFold = function () {
    noneOpen = !noneOpen;
    renderList();
  };
  window.evaListFilter = function (k, v) {
    if (k === 'year') listYear = ['this', 'last', 'all'].indexOf(v) !== -1 ? v : 'this';
    if (k === 'status') listStatus = ORDER[v] !== undefined ? v : '';
    renderList();
  };

  // ------------------------------------------------------- when to draw

  // Drawn only while on screen, once a burst of changes settles: the job's
  // figures change at every keystroke in its price, and All Jobs prices
  // every job's estimate.
  // Nothing is kept for a hidden screen: opening Tracking redraws its labour
  // and summary (app.js switchTab), and All Jobs its table, and both of those
  // ask for this again.
  const shown = id => { const p = el(id); return !!(p && p.classList.contains('active')); };
  let jobTimer = null, listTimer = null;
  function jobChanged() {
    if (!shown('panel-tracking')) return;
    clearTimeout(jobTimer);
    jobTimer = setTimeout(renderJob, 150);
  }
  function listChanged() {
    if (!shown('panel-dashboard')) return;
    clearTimeout(listTimer);
    listTimer = setTimeout(renderList, 200);
  }
  const both = () => { jobChanged(); listChanged(); };
  ['yd-clock-changed', 'yd-pricing', 'yd-supplies', 'yd-receipts', 'yd-subs', 'yd-jobs-changed'].forEach(ev =>
    document.addEventListener(ev, both));

  document.addEventListener('yd-auth', () => {
    editing = null;
    const on = sees();
    ['evaSection', 'evaListSection'].forEach(id => { const s = el(id); if (s) s.hidden = !on; });
    if (!on) { const w = el('evaWrap'), l = el('evaListWrap'); if (w) w.innerHTML = ''; if (l) l.innerHTML = ''; return; }
    both();
  });

  window.YDJobCosts = {
    jobChanged: jobChanged,
    listChanged: listChanged,
    render: renderJob,
    renderList: renderList,
    // For a test or another screen: one job, side by side.
    compare: (job, id) => compare(job || {}, id || null, false),
    bucketOfLine: bucketOfLine,
  };
})();
