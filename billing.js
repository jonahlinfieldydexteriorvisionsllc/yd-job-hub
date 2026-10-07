// Closed storms: what they earned, and getting them into QuickBooks.
//
// The point of this file is that a storm should never be typed up twice. The
// app was there when the work happened -- it knows who was visited, how many
// times, how deep it was, how long it took and what that bills. An invoice is
// a rearrangement of facts already recorded, not a fresh act of data entry.

(function () {
  'use strict';

  const DUE_DAYS = 30;

  let storms = {};          // closed storms, id -> record
  let billingCache = {};    // id -> billing record (owner only)
  let unsub = null;

  // A missing figure prints as a dash, never as "$NaN". This goes in front of
  // customers: a storm closed by an older version of the app, or a record that
  // only half arrived, should look incomplete rather than broken.
  const money = c => (typeof c === 'number' && isFinite(c))
    ? '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
  const accountName = id => ((window.YDSnow && YDSnow.accounts()[id]) || {}).name || id;
  // A count that came from a crew phone (salt bags, depth), or 0. Storms
  // closed before the stop figures were checked could hold text there, and
  // adding text to a total turns the total into text -- which this screen
  // then drew as HTML.
  const count = v => (typeof v === 'number' && isFinite(v)) ? v : 0;

  // ------------------------------------------------------- dates and seasons
  //
  // Always worked out from the storm's timestamp rather than read off its
  // stored label, so a storm recorded before the label carried a year still
  // shows one. Two Januarys from now, 'Thu, Jan 14' on an invoice line is
  // ambiguous, and these records are what invoices are raised from.

  const stormStart = s => new Date((s && (s.startedAt || s.closedAt)) || 0);

  function stormDay(s) {
    const d = stormStart(s);
    if (!d.getTime()) return '';
    return d.toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function stormTitle(s, id) {
    const day = stormDay(s);
    if (!day) return (s && s.label) || id;
    const inches = s.accumulationInches;
    return day + (inches != null ? ' · ' + inches + '"' : '');
  }

  // A snow season runs across the turn of the year, so the calendar year is
  // the wrong bucket: December and the January after it are one winter's work.
  // Anything from July onwards starts that year's season; anything before it
  // belongs to the season that began the previous year.
  function seasonOf(s) {
    const d = stormStart(s);
    if (!d.getTime()) return 'Undated';
    const y = d.getFullYear();
    const startYear = d.getMonth() >= 6 ? y : y - 1;
    return startYear + '–' + String(startYear + 1).slice(2);
  }

  function usDate(iso) {
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }
  function plusDays(iso, n) {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return usDate(d.toISOString());
  }

  // ------------------------------------------------------- invoice numbers
  //
  // QuickBooks keeps its own running number and expects the next invoice to
  // continue it. There is no connection to QuickBooks to read that number
  // from, so the owner tells the app once where the sequence is up to and the
  // app carries on from there.
  //
  // The important part is that a number, once given out, is WRITTEN DOWN
  // AGAINST THE STORM. Exporting the same storm a second time -- to redo a
  // failed import, or because a file was lost -- must produce the same numbers
  // it produced the first time. If it invented new ones, a re-import would
  // land as a second set of invoices for work already billed.
  //
  // Only a storm that has never been exported consumes new numbers.

  const INVOICE_DOC = 'invoicing';
  let invoiceSettings = null;

  // Read fresh every time rather than once per session: the laptop and the
  // phone each kept their own copy of "next number" and would both hand out
  // the same one. Falls back to the last known copy with no signal.
  async function invoicing() {
    try {
      invoiceSettings = (await window.YDDb.get('settings', INVOICE_DOC)) || invoiceSettings || {};
    } catch (e) { invoiceSettings = invoiceSettings || {}; }
    return invoiceSettings;
  }

  // Returns { accountId: 'number' } for this storm, assigning and saving any
  // that have not been given out yet. `b` must be the server's copy of the
  // storm's billing (see exportStormCsv).
  //
  // The "next number" and the storm's numbers are read and written in ONE
  // step on the server (YDDb.transact). Read separately -- even both from the
  // server -- two devices exporting at the same moment could each read the
  // same "next" and give out the same numbers (review B11, 6 Oct 2026); in a
  // transaction the second is run again on what the first wrote. With no
  // signal it fails, and nothing is numbered.
  async function invoiceNumbersFor(id, b, accountIds) {
    const known = Object.assign({}, b.invoiceNos || {});
    if (!accountIds.some(a => !known[a])) return known;

    let out = null, cfgOut = null;
    await window.YDDb.transact([['settings', INVOICE_DOC], ['storms/' + id + '/private', 'billing']], ([cfg, bill]) => {
      cfg = cfg || {};
      const existing = Object.assign({}, (bill && bill.invoiceNos) || {});
      const missing = accountIds.filter(a => !existing[a]);
      out = existing; cfgOut = cfg;
      if (!missing.length) return [null, null];       // another device has just numbered them
      // No starting point set yet: fall back to a storm-based reference, which
      // is unique but does not pretend to continue anybody's sequence.
      if (cfg.nextInvoiceNo == null) {
        const d = stormStart(storms[id]);
        const stamp = String(d.getFullYear()).slice(2) +
          two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
        const taken = Object.keys(existing).length;
        missing.forEach((a, i) => { existing[a] = 'SNOW-' + stamp + '-' + two(taken + i + 1); });
        // Written against the storm like a sequence number. These used to be
        // worked out afresh on every export, so once a starting number was set
        // the same storm came out with a second set -- and re-importing it
        // raised every invoice again.
        return [null, { invoiceNos: existing }];
      }
      let next = parseInt(cfg.nextInvoiceNo, 10) || 1;
      const prefix = cfg.invoicePrefix || '';
      missing.forEach(a => { existing[a] = prefix + next; next++; });
      cfgOut = Object.assign({}, cfg, { nextInvoiceNo: next });
      return [{ nextInvoiceNo: next }, { invoiceNos: existing }];
    });
    invoiceSettings = cfgOut;
    b.invoiceNos = out;
    return out;
  }

  const two = n => String(n).padStart(2, '0');

  // Numbering is done one storm at a time. Each export reads what the server
  // holds and then records what it handed out; two side by side -- a double
  // tap, or two storms exported in quick succession -- could both read before
  // either had recorded, and give out the same numbers twice.
  let numberingTurn = Promise.resolve();
  function oneAtATime(task) {
    const turn = numberingTurn.then(task);
    numberingTurn = turn.catch(() => {});
    return turn;
  }

  // The accounts on a storm's bill, in the order their invoices are numbered.
  function accountOrder(b) {
    const ids = {};
    b.lines.forEach(l => { ids[l.accountId] = true; });
    return Object.keys(ids).sort((x, y) => accountName(x).localeCompare(accountName(y)));
  }

  // Set from the season report, so the sequence can be pointed at whatever
  // QuickBooks is actually up to.
  window.setInvoiceStart = async function () {
    if (!ydCan('billing', 'change')) { showToast('Only someone who can change billing can set this'); return; }
    const cfg = await invoicing();
    const v = prompt('What is the next invoice number in QuickBooks?\n\n' +
      'Each exported invoice takes the next number from here, so they carry on ' +
      'in order. Storms already exported keep the numbers they were given.',
      cfg.nextInvoiceNo != null ? String(cfg.nextInvoiceNo) : '');
    if (v === null) return;
    const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    if (!(n > 0)) { showToast('That is not a number'); return; }
    invoiceSettings = Object.assign({}, cfg, { nextInvoiceNo: n });
    // Not awaited: the promise waits for the server, so with a weak signal the
    // screen hung here. The number is in place locally at once and the next
    // export's server read sees it; a refusal still says so.
    Promise.resolve(window.YDDb.put('settings', INVOICE_DOC, { nextInvoiceNo: n }))
      .catch(e => {
        console.warn('[billing] next invoice number not saved:', e.code || e.message);
        showToast('Could not save that');
      });
    showToast('Next invoice will be ' + n);
    renderSeason();
  };

  // ---------------------------------------------------------------- loading

  async function billingFor(id) {
    if (billingCache[id]) return billingCache[id];
    try {
      const b = await window.YDDb.get('storms/' + id + '/private', 'billing');
      if (b) billingCache[id] = b;
      return b;
    } catch (e) { return null; }
  }

  function start() {
    if (unsub || !window.YDDb) return;
    // The next invoice number, for the season screen: otherwise it said "not
    // following QuickBooks yet" after every load until something was exported.
    invoicing().then(() => { if (window.renderSeason) renderSeason(); });
    unsub = window.YDDb.watch('storms', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') { delete storms[c.id]; delete billingCache[c.id]; return; }
        if (c.data.status === 'closed') storms[c.id] = Object.assign({ id: c.id }, c.data);
        else delete storms[c.id];
      });
      render();
    });
  }

  // ---------------------------------------------------------------- render

  async function render() {
    const wrap = document.getElementById('stormHistoryWrap');
    if (!wrap) return;
    const ids = Object.keys(storms).sort().reverse();
    const section = wrap.closest('.section');
    if (section) section.hidden = !ids.length;
    if (!ids.length) { wrap.innerHTML = ''; return; }

    for (const id of ids) await billingFor(id);

    // The cards are for the season on screen (the newest by default), not
    // every storm ever closed -- by the second winter those were all-time
    // totals that disagreed with the season table below them.
    const season = shownSeason && seasonsWithStorms().indexOf(shownSeason) !== -1 ? shownSeason : seasonsWithStorms()[0];
    const inSeason = ids.filter(id => seasonOf(storms[id]) === season);
    let seasonTotal = 0, seasonVisits = 0, seasonHours = 0;
    inSeason.forEach(id => {
      const b = billingCache[id];
      if (!b) return;
      seasonTotal += b.totalCents; seasonVisits += b.lines.length; seasonHours += b.crewHours;
    });

    wrap.innerHTML =
      '<div class="dash-totals" style="margin-bottom:16px">' +
        card('Storms' + (season ? ' ' + esc(season) : ''), inSeason.length) +
        card('Billable visits', seasonVisits) +
        card('Season revenue', money(seasonTotal), 'accent-top') +
        card('Per crew-hour', seasonHours ? money(Math.round(seasonTotal / seasonHours)) : '—', 'pos-top') +
      '</div>' +
      ids.map(id => {
        const s = storms[id], b = billingCache[id];
        return '<div class="storm-row">' +
          '<div class="storm-row-main">' +
            '<div class="storm-row-name">' + esc(stormTitle(s, id)) + '</div>' +
            '<div class="storm-row-sub">' +
              (b ? b.lines.length + ' visits · ' + b.crewHours + ' crew hrs · ' +
                   money(b.totalCents) + (b.saltCents ? ' (salt ' + money(b.saltCents) + ')' : '')
                 : 'billing not available') +
              (b && b.skipped && b.skipped.length ? ' · ' + b.skipped.length + ' skipped' : '') +
            '</div>' +
          '</div>' +
          '<div class="storm-row-actions">' +
            '<button class="btn btn-sm" onclick="stormDetail(\'' + id + '\')">Detail</button>' +
            // Exporting hands out invoice numbers, so it is Billing "change".
            (ydCan('billing', 'change')
              ? '<button class="btn btn-sm btn-accent" onclick="exportStormCsv(\'' + id + '\')">QuickBooks CSV</button>' : '') +
            (window.YDQuickBooks && YDQuickBooks.connected() && ydCan('billing', 'change')
              ? '<button class="btn btn-sm btn-filled" onclick="sendStormToQuickBooks(\'' + id + '\')">Send to QuickBooks</button>'
              : '') +
          '</div>' +
        '</div>';
      }).join('');

    if (window.renderSeason) renderSeason();
  }

  function card(label, value, cls) {
    return '<div class="summary-card ' + (cls || '') + '">' +
      '<div class="summary-label">' + label + '</div>' +
      '<div class="summary-value">' + value + '</div></div>';
  }

  window.stormDetail = async function (id) {
    const s = storms[id], b = await billingFor(id);
    if (!b) { showToast('No billing recorded for that storm'); return; }

    // group the visits by account, since that is how an invoice reads
    const byAccount = {};
    b.lines.forEach(l => {
      (byAccount[l.accountId] = byAccount[l.accountId] || []).push(l);
    });
    const canFix = ydCan('billing', 'change');

    const rows = Object.keys(byAccount).sort((x, y) => accountName(x).localeCompare(accountName(y)))
      .map(aid => {
        const ls = byAccount[aid];
        const total = ls.reduce((t, l) => t + l.totalCents, 0);
        return '<tr><td class="bold">' + esc(accountName(aid)) + '</td>' +
          '<td>' + ls.length + '</td>' +
          // Escaped: depths come from crew phones (see count() above). Each
          // one opens the fix for that visit, for whoever may change bills.
          '<td>' + ls.map(l => (canFix
            ? '<button class="link-btn" title="Fix this visit" onclick="fixVisitForm(\'' + sid(id) + '\', \'' + sid(l.accountId) + '\', ' +
                (count(l.pass) || 1) + ')">' + esc(l.inches) + '"' + (l.fixedAt ? ' ✏️' : '') + '</button>'
            : esc(l.inches) + '"' + (l.fixedAt ? ' ✏️' : ''))).join(', ') + '</td>' +
          '<td>' + ls.reduce((t, l) => t + l.minutes, 0) + ' min</td>' +
          '<td>' + money(ls.reduce((t, l) => t + l.plowCents, 0)) + '</td>' +
          '<td>' + (ls.some(l => l.saltCents) ? money(ls.reduce((t, l) => t + l.saltCents, 0)) : '—') + '</td>' +
          '<td>' + (ls.some(l => l.laborCents) ? money(ls.reduce((t, l) => t + l.laborCents, 0)) : '—') + '</td>' +
          '<td class="bold">' + money(total) + '</td></tr>';
      }).join('');

    document.getElementById('stormDetailTitle').textContent = stormTitle(s, id);
    document.getElementById('stormDetailBody').innerHTML =
      '<div class="dash-totals" style="margin-bottom:16px">' +
        card('Revenue', money(b.totalCents), 'accent-top') +
        card('Crew hours', b.crewHours) +
        card('Per crew-hour', money(b.revenuePerCrewHourCents), 'pos-top') +
        card('On site', b.onSiteMinutes + ' min') +
      '</div>' +
      (canFix ? '<div class="hint" style="margin-bottom:8px">A depth wrong? Tap it to fix that visit.</div>' : '') +
      '<div id="stormFixArea"></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Account</th><th>Visits</th><th>Depth</th><th>On site</th>' +
        '<th>Plowing</th><th>Salt</th><th>Labour</th><th>Total</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (b.skipped && b.skipped.length
        ? '<div style="margin-top:14px"><span class="label">Skipped</span>' +
          b.skipped.map(s2 => '<div class="storm-row-sub">' + esc(accountName(s2.accountId)) +
            ' — ' + esc(s2.reason || 'no reason given') + '</div>').join('') + '</div>'
        : '') +
      '<div style="display:flex;gap:8px;margin-top:20px;flex-wrap:wrap">' +
        '<button class="btn btn-accent" onclick="exportStormCsv(\'' + id + '\')">Download QuickBooks CSV</button>' +
        (window.YDQuickBooks && YDQuickBooks.connected()
          ? '<button class="btn btn-filled" onclick="sendStormToQuickBooks(\'' + id + '\')">Send to QuickBooks</button>'
          : '') +
        '<button class="btn" onclick="copyStormSummary(\'' + id + '\')">Copy summary</button>' +
      '</div>';
    document.getElementById('stormDetailModal').classList.add('active');
  };

  window.closeStormDetail = function () {
    document.getElementById('stormDetailModal').classList.remove('active');
  };

  // ------------------------------------------------------------ fixing a visit
  //
  // A storm's bill is frozen when it closes. When a figure on it turns out to
  // be wrong -- a crew member asked (a change request, approved in Waiting for
  // You) or the office spotted it -- the visit is put right here: the stop
  // gets the right figures and that visit's line is worked out again from the
  // customer's pricing as it stands today; the storm's totals follow. An
  // invoice already in QuickBooks is not touched -- the screen says to change
  // it there too.
  const sid = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
  const minutesBetween = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : 0);
  // Stop ids are the account id, with "-p2" and so on for later passes.
  const stopIdOf = (accountId, pass) => (pass > 1 ? accountId + '-p' + pass : accountId);

  // `expect` (a crew request being approved): the customer it names and the
  // figures it says the stop has now. The request is the crew's own writing,
  // so it is checked against the stop itself -- a visit fixed by the office
  // since, or a request pointing at a different customer's stop, is refused.
  async function fixVisit(id, stopId, inches, saltBags, by, expect) {
    if (!ydCan('billing', 'change')) throw new Error('Changing a bill needs Billing access');
    const s = storms[id];
    if (!s) throw new Error('That storm is not closed');
    if (!(typeof inches === 'number' && isFinite(inches) && inches >= 0 && inches <= 60)) throw new Error('That depth is not a number the bill can use');
    if (saltBags != null && !(typeof saltBags === 'number' && isFinite(saltBags) && saltBags >= 0 && saltBags <= 200)) {
      throw new Error('That salt figure is not a number the bill can use');
    }
    const needSignal = () => new Error('This needs a signal — try again when there is one');
    // The customer's pricing is loaded first: the step on the server below
    // must work everything out from what it reads, without waiting on more.
    let first;
    try { first = await window.YDDb.getFresh('storms/' + id + '/stops', stopId); } catch (e) { throw needSignal(); }
    if (!first || !first.accountId) throw new Error('That visit is not on the storm');
    await YDSnow.refreshPricing([first.accountId]);

    // Read and written as ONE step on the server, so two devices fixing the
    // same storm cannot each put back the other's lines (YDDb.transact). It
    // may be run again on fresh data, so it only works things out.
    let result = null;
    const salt = saltBags == null ? null : saltBags;
    try {
      await window.YDDb.transact([['storms/' + id + '/private', 'billing'], ['storms/' + id + '/stops', stopId]], ([b, stop]) => {
        result = null;
        if (!b || !Array.isArray(b.lines)) throw new Error('No bill recorded for that storm');
        if (!stop || !stop.accountId) throw new Error('That visit is not on the storm');
        if (expect) {
          const bf = expect.before || {};
          const fig = v => (typeof v === 'number' && isFinite(v) ? v : null);
          if (expect.accountId && expect.accountId !== stop.accountId) {
            throw new Error('That request names a different customer than its stop — reject it');
          }
          if (fig(stop.inchesCleared) !== fig(bf.inchesCleared) || fig(stop.saltBags) !== fig(bf.saltBags)) {
            throw new Error('That visit has been changed since they asked — reject it, and they can ask again');
          }
        }
        const accountId = stop.accountId, pass = count(stop.pass) || 1;
        const lines = b.lines.slice();
        const i = lines.findIndex(l => l.accountId === accountId && (count(l.pass) || 1) === pass);
        const old = i === -1 ? null : lines[i];
        const at = new Date().toISOString();
        const was = old ? { inches: old.inches, saltBags: old.saltBags == null ? null : old.saltBags, totalCents: count(old.totalCents) } : null;
        let line;
        if (old && count(old.inches) === inches) {
          // Only the salt bags changed. A visit is not charged by them, so the
          // money stays as it was billed -- re-pricing would also move the
          // plowing to whatever the customer's price is today.
          line = Object.assign({}, old, { saltBags: salt, fixedAt: at, fixedBy: by || '', was: was });
        } else {
          // The time on site is the bill's own (pauses already taken off). A
          // visit that was left off the bill gets it worked out the way
          // closing does.
          const extra = {};
          let mins = old ? count(old.minutes) : null;
          if (mins == null) {
            const onSite = minutesBetween(stop.arrivedAt, stop.departedAt);
            const paused = window.YDClock ? YDClock.pausedMinutesAt(id, stop.arrivedAt, stop.departedAt) : 0;
            mins = Math.max(0, onSite - paused);
            Object.assign(extra, { accountId: accountId, pass: pass, minutes: mins, onSiteMinutes: onSite, pausedMinutes: paused });
          }
          const p = YDSnow.priceVisit(accountId, inches, mins, s.crewSize);
          if (!p) throw new Error('No price for ' + accountName(accountId) + ' — check their pricing on the Snow tab');
          // Worked out at the customer's price today, so the rate printed
          // beside the labour line is today's too.
          const rate = (YDSnow.pricing()[accountId] || {}).laborRateCents;
          line = Object.assign({}, old || extra, {
            inches: inches, saltBags: salt, laborRateCents: rate != null ? rate : null,
            manHours: p.manHours, plowCents: p.plowCents, saltCents: p.saltCents, laborCents: p.laborCents, totalCents: p.totalCents,
            fixedAt: at, fixedBy: by || '', was: was,
          });
        }
        // As when closing: no $0 lines on a bill.
        if (count(line.totalCents) > 0) { if (i === -1) lines.push(line); else lines[i] = line; }
        else if (i !== -1) lines.splice(i, 1);
        // The totals the way closing works them out.
        const totalCents = lines.reduce((t, l) => t + count(l.totalCents), 0);
        const minutes = lines.reduce((t, l) => t + count(l.minutes), 0);
        const crewHours = minutes * count(s.crewSize) / 60;
        // Through JSON, so a field missing on an old line cannot reach the
        // write as undefined (which would refuse the whole thing).
        const patch = JSON.parse(JSON.stringify({
          lines: lines, totalCents: totalCents,
          saltCents: lines.reduce((t, l) => t + count(l.saltCents), 0),
          onSiteMinutes: minutes,
          pausedMinutes: lines.reduce((t, l) => t + count(l.pausedMinutes), 0),
          crewHours: Math.round(crewHours * 100) / 100,
          revenuePerCrewHourCents: crewHours > 0 ? Math.round(totalCents / crewHours) : 0,
          fixes: (Array.isArray(b.fixes) ? b.fixes : []).concat([{ at: at, by: by || '', stopId: stopId, accountId: accountId,
            inches: inches, saltBags: salt, totalCents: count(line.totalCents), was: was }]),
        }));
        const sent = (b.quickbooks || {})[accountId];
        result = { bill: Object.assign({}, b, patch), name: accountName(accountId), totalCents: count(line.totalCents),
                   wasCents: was ? was.totalCents : 0, inQuickBooks: sent ? (sent.number || sent.id || 'yes') : null,
                   numbered: (b.invoiceNos || {})[accountId] || null };
        return [patch, { inchesCleared: inches, saltBags: salt, fixedAt: at, fixedBy: by || '' }];
      });
    } catch (e) {
      if (e && e.message && !e.code) throw e;          // our own refusal, said as it is
      console.warn('[billing] visit fix not saved:', (e && e.code) || e);
      if (e && e.code === 'permission-denied') throw new Error('Not saved — not allowed');
      throw needSignal();
    }
    billingCache[id] = result.bill;
    render();
    delete result.bill;
    return result;
  }

  // What the office is told after a fix: the new charge, and what still needs
  // doing by hand.
  function fixedWords(r) {
    return r.name + ': ' + money(r.wasCents) + ' → ' + money(r.totalCents) +
      (r.inQuickBooks ? ' — invoice ' + r.inQuickBooks + ' is already in QuickBooks: change it there too'
        : r.numbered ? ' — invoice ' + r.numbered + ' was already exported: export it again or change it in QuickBooks' : '');
  }

  window.fixVisitForm = function (id, accountId, pass) {
    const area = document.getElementById('stormFixArea');
    const b = billingCache[id];
    if (!area || !b) return;
    const l = b.lines.find(x => x.accountId === accountId && (count(x.pass) || 1) === pass) || {};
    const a = (window.YDSnow && YDSnow.accounts()[accountId]) || {};
    area.innerHTML = '<div class="add-area">' +
      '<div class="add-label">Fix ' + esc(accountName(accountId)) + (pass > 1 ? ' (pass ' + pass + ')' : '') + '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Inches</span><input id="fvIn" inputmode="decimal" value="' + count(l.inches) + '"></div>' +
        (a.saltApplies ? '<div class="field"><span class="label">Salt bags</span><input id="fvSalt" inputmode="decimal" value="' + count(l.saltBags) + '"></div>' : '') +
      '</div>' +
      '<div class="hint">The charge is worked out again from ' + esc(accountName(accountId)) + '’s pricing as it is today.</div>' +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="saveVisitFix(\'' + sid(id) + '\', \'' + sid(accountId) + '\', ' + pass + ')">Save</button>' +
        '<button class="btn btn-sm" onclick="document.getElementById(\'stormFixArea\').innerHTML=\'\'">Cancel</button></div>' +
    '</div>';
  };
  window.saveVisitFix = async function (id, accountId, pass) {
    const inches = parseFloat((document.getElementById('fvIn') || {}).value);
    const saltEl = document.getElementById('fvSalt');
    const salt = saltEl ? parseFloat(saltEl.value) : null;
    if (isNaN(inches) || (saltEl && isNaN(salt))) { showToast('Put in numbers'); return; }
    try {
      const me = (window.YDAuth && window.YDAuth.user) || {};
      const r = await fixVisit(id, stopIdOf(accountId, pass), Math.round(inches * 10) / 10,
                               salt == null ? null : Math.round(salt * 10) / 10, me.uid || '');
      await stormDetail(id);
      // Kept on screen, not only in a passing message: an invoice already in
      // QuickBooks has to be changed there by hand.
      const area = document.getElementById('stormFixArea');
      if (area) area.innerHTML = '<div class="hint fix-done">✔ ' + esc(fixedWords(r)) + '</div>';
      showToast(fixedWords(r), r.inQuickBooks || r.numbered ? 9000 : 3000);
    } catch (e) { showToast(e.message || String(e), 6000); }
  };

  // ---------------------------------------------------------------- export

  // One invoice per account per storm, with a line per visit. Rows sharing an
  // invoice number become one invoice on import, which is why the number
  // repeats down the file.
  //
  // QuickBooks' import columns have varied between versions, so this is
  // deliberately plain and readable: check one invoice after the first import
  // rather than trusting a whole night blind.
  // Exporting hands out invoice numbers, which is changing the billing --
  // someone who may only look at it would number invoices nobody records.
  window.exportStormCsv = async function (id) {
    if (!ydCan('billing', 'change')) { showToast('Exporting gives out invoice numbers — ask the owner'); return; }
    const s = storms[id];

    // The storm's billing is read from the SERVER here, never from the copy
    // cached when the app opened. A cached copy is stale the moment another
    // device exports: the laptop, still holding the version from the morning,
    // saw no numbers on a storm the phone had already numbered, handed out a
    // fresh set and wrote them over the first -- and re-importing billed every
    // customer twice. With no signal there is no knowing what has been handed
    // out, so nothing is numbered rather than guessed.
    let b = null, numbers = null;
    try {
      await oneAtATime(async () => {
        b = await window.YDDb.getFresh('storms/' + id + '/private', 'billing');
        if (b && Array.isArray(b.lines)) numbers = await invoiceNumbersFor(id, b, accountOrder(b));
      });
    } catch (e) {
      console.warn('[billing] could not number invoices from the server:', e && (e.code || e.message));
      showToast('Needs signal — invoice numbers are only given out from the server’s copy. Try again with a connection.');
      return;
    }
    if (!b || !Array.isArray(b.lines)) { showToast('No billing recorded for that storm'); return; }
    billingCache[id] = b;

    // The invoice is dated when the storm STARTED, not when it was closed.
    //
    // Those differ more often than they sound like they should. A storm begun
    // at 11pm and finished at 4am closes on the following date, so the invoice
    // disagreed with what the app itself calls that storm and with what the
    // customer remembers. Worse, a storm closed out days later -- because
    // closing it was forgotten -- was invoiced with the date it was finally
    // tidied up rather than the night the work happened.
    //
    // The start is when the service happened, and that is what a customer is
    // being billed for.
    const service = s.startedAt || s.closedAt;
    const date = usDate(service);
    const due = plusDays(service, DUE_DAYS);

    const d0 = new Date(service);
    // Only for naming the downloaded file; the invoice numbers themselves come
    // from the running sequence.
    const stamp = '' + d0.getFullYear() + two(d0.getMonth() + 1) + two(d0.getDate());

    // Quote for CSV, and flatten line breaks. A site note typed across two
    // lines would otherwise split the row in half and corrupt every invoice
    // after it in the file.
    const q = v => '"' + String(v == null ? '' : v)
      .replace(/[\r\n]+/g, ' ')
      .replace(/"/g, '""') + '"';
    const rows = [[
      'InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Item',
      'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount',
    ].join(',')];

    const byAccount = {};
    b.lines.forEach(l => { (byAccount[l.accountId] = byAccount[l.accountId] || []).push(l); });
    const order = accountOrder(b);

    order.forEach(aid => {
      const name = accountName(aid);
      const invoiceNo = numbers[aid];
      byAccount[aid].sort((a, c) => a.pass - c.pass).forEach(l => {
        // The date with its year, taken from the storm rather than its label,
        // and without the accumulation -- the depth cleared follows, and
        // printing both reads like a mistake.
        const day = stormDay(s);
        const visit = 'Snow removal ' + day + (l.pass > 1 ? ' (pass ' + l.pass + ')' : '') +
                      ' — ' + l.inches + '" cleared';
        // Plowing, salt and labour are separate lines because a customer
        // querying a bill asks about one of them, not the total.
        rows.push([invoiceNo, q(name), date, due, q('Snow Removal'), q(visit),
                   1, (l.plowCents / 100).toFixed(2), (l.plowCents / 100).toFixed(2)].join(','));
        if (l.saltCents) {
          rows.push([invoiceNo, q(name), date, due, q('Salt'),
                     q('Salt application' + (l.saltBags ? ' — ' + l.saltBags + ' bags' : '')),
                     1, (l.saltCents / 100).toFixed(2), (l.saltCents / 100).toFixed(2)].join(','));
        }
        if (l.laborCents) {
          // Quantity is MAN-hours, not elapsed hours. 21 minutes with 2 crew is
          // 0.7 man-hours at $25, not 0.35 hours at $50. Both arrive at the
          // same total, but only one matches the rate the customer agreed --
          // and the rate is what gets queried when a bill is questioned.
          const crew = (storms[id] && storms[id].crewSize) || 1;
          // The hours the charge was worked out from, so quantity times rate
          // equals the amount on the face of the invoice. Older storms, closed
          // before this was stored, fall back to the same calculation.
          const manHours = l.manHours != null
            ? l.manHours
            : Math.round((l.minutes / 60) * crew * 100) / 100;
          // Take the rate from the account rather than dividing the total by
          // rounded hours -- that produced $25.03 on a $25 rate, which looks
          // like a mistake on a customer's invoice even though the total was
          // right. The amount still carries the exact figure.
          // The rate stored when the storm closed, so an old storm still shows
          // the rate it was billed at after a price rise. Storms closed before
          // that was stored fall back to the account's current rate.
          const rateCents = l.laborRateCents != null ? l.laborRateCents
            : ((window.YDSnow && YDSnow.pricing()[l.accountId]) || {}).laborRateCents;
          const rate = rateCents != null ? (rateCents / 100) : ((l.laborCents / 100) / (manHours || 1));
          rows.push([invoiceNo, q(name), date, due, q('Labor'),
                     q('Labor — ' + l.minutes + ' min on site, ' + crew + ' crew'),
                     manHours, rate.toFixed(2),
                     (l.laborCents / 100).toFixed(2)].join(','));
        }
      });
    });

    // Two details that decide whether this imports cleanly anywhere else.
    //
    // The byte-order mark tells Excel and QuickBooks the file is UTF-8.
    // Without it they assume the local Windows encoding, and every dash in a
    // description arrives as mojibake. The invoice still imports; the
    // customer's description just reads as rubbish.
    //
    // CRLF is what the CSV convention specifies. Most things cope with bare
    // newlines, not everything does, and it costs nothing to be correct.
    const blob = new Blob(['﻿' + rows.join('\r\n') + '\r\n'],
      { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'snow-billing-' + stamp + '.csv';
    a.click();
    // Not at once: Safari on an iPhone can still be reading the file.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast(Object.keys(byAccount).length + ' invoices · ' + (rows.length - 1) + ' lines downloaded');
  };

  window.copyStormSummary = async function (id) {
    const s = storms[id], b = await billingFor(id);
    if (!b) return;
    const lines = ['YD Exterior Visions — ' + stormTitle(s, id), ''];
    const byAccount = {};
    b.lines.forEach(l => { (byAccount[l.accountId] = byAccount[l.accountId] || []).push(l); });
    Object.keys(byAccount).sort((x, y) => accountName(x).localeCompare(accountName(y))).forEach(aid => {
      const ls = byAccount[aid];
      lines.push(accountName(aid) + ' — ' + ls.length + ' visit' + (ls.length > 1 ? 's' : '') +
                 ' — ' + money(ls.reduce((t, l) => t + l.totalCents, 0)));
    });
    // Worked out here when it was not stored, rather than shown as a gap.
    const perHour = b.revenuePerCrewHourCents != null ? b.revenuePerCrewHourCents
      : (b.crewHours > 0 ? Math.round(b.totalCents / b.crewHours) : null);
    lines.push('', 'Total: ' + money(b.totalCents));
    if (b.crewHours) {
      lines.push('Crew hours: ' + b.crewHours, 'Per crew-hour: ' + money(perHour));
    }
    const text = lines.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showToast('Summary copied'));
    else showToast('Copy not supported here');
  };

  // ---------------------------------------------------------------- season

  // Which accounts actually earn. A big invoice is not the same as a good
  // account: a property that bills $815 and eats an hour of two people is
  // worth less per crew-hour than one that bills $95 in fourteen minutes.
  // That comparison is the reason this view exists.
  function seasonByAccount(season) {
    const acc = {};
    Object.keys(storms).forEach(id => {
      const b = billingCache[id];
      if (!b) return;
      // One winter at a time. Totalling every storm ever recorded together
      // would compare this season's accounts against last season's rates and
      // make both meaningless.
      if (season && seasonOf(storms[id]) !== season) return;
      const crew = storms[id].crewSize || 1;
      b.lines.forEach(l => {
        const a = acc[l.accountId] = acc[l.accountId] || {
          visits: 0, minutes: 0, crewMinutes: 0, plow: 0, salt: 0, labor: 0, total: 0,
          bags: 0, storms: {},
        };
        a.visits++;
        a.minutes += l.minutes;
        a.crewMinutes += l.minutes * crew;
        a.plow += l.plowCents; a.salt += l.saltCents;
        a.labor += l.laborCents; a.total += l.totalCents;
        a.bags += count(l.saltBags);
        a.storms[id] = true;
      });
      (b.skipped || []).forEach(s => {
        const a = acc[s.accountId] = acc[s.accountId] || {
          visits: 0, minutes: 0, crewMinutes: 0, plow: 0, salt: 0, labor: 0, total: 0,
          bags: 0, storms: {}, skips: 0,
        };
        a.skips = (a.skips || 0) + 1;
      });
    });
    return acc;
  }

  // Which season is on screen. Defaults to the most recent one with storms in
  // it, so opening the app mid-winter shows this winter.
  let shownSeason = null;

  function seasonsWithStorms() {
    const set = {};
    Object.keys(storms).forEach(id => { if (billingCache[id]) set[seasonOf(storms[id])] = true; });
    return Object.keys(set).sort().reverse();
  }

  // render() draws the season's cards as well, then the table.
  window.showSeason = function (s) { shownSeason = s; render(); };

  window.renderSeason = function () {
    const wrap = document.getElementById('seasonWrap');
    if (!wrap) return;

    const seasons = seasonsWithStorms();
    const section = wrap.closest('.section');
    if (!seasons.length) { if (section) section.hidden = true; wrap.innerHTML = ''; return; }
    if (section) section.hidden = false;
    if (!shownSeason || seasons.indexOf(shownSeason) === -1) shownSeason = seasons[0];
    const badge = document.getElementById('seasonBadge');
    if (badge) badge.textContent = shownSeason;

    const picker = seasons.length > 1
      ? '<div class="filter-bar season-pick">' + seasons.map(s =>
          '<button class="btn btn-sm' + (s === shownSeason ? ' btn-filled' : '') +
          '" onclick="showSeason(\'' + s + '\')">' + s + '</button>').join('') + '</div>'
      : '<div class="season-one">' + esc(shownSeason) + ' season</div>';

    const nextNo = invoiceSettings && invoiceSettings.nextInvoiceNo;
    const invoiceBar = '<div class="invoice-bar">' +
      '<span>' + (nextNo != null
        ? 'Next invoice number: <strong>' + nextNo + '</strong>'
        : 'Invoice numbers are not following QuickBooks yet') + '</span>' +
      (ydCan('billing', 'change') ? '<button class="btn btn-sm" onclick="setInvoiceStart()">' +
        (nextNo != null ? 'Change' : 'Set it') + '</button>' : '') +
    '</div>';

    const acc = seasonByAccount(shownSeason);
    const ids = Object.keys(acc);
    if (!ids.length) { wrap.innerHTML = picker + invoiceBar +
      '<p class="empty-msg">Nothing billed in this season yet.</p>'; return; }

    // Ordered by what each returns per crew-hour, worst last -- the question
    // being answered is "which of these is worth keeping".
    const perHour = id => acc[id].crewMinutes ? acc[id].total / (acc[id].crewMinutes / 60) : 0;
    ids.sort((x, y) => perHour(y) - perHour(x));

    const best = perHour(ids[0]);
    const rows = ids.map(id => {
      const a = acc[id];
      const ph = perHour(id);
      const weak = ph > 0 && ph < best * 0.5;      // less than half the best earner
      return '<tr' + (weak ? ' class="weak-earner"' : '') + '>' +
        '<td class="bold">' + esc(accountName(id)) + '</td>' +
        '<td>' + a.visits + (a.skips ? ' <span class="muted">(' + a.skips + ' skipped)</span>' : '') + '</td>' +
        '<td>' + Object.keys(a.storms).length + '</td>' +
        '<td>' + Math.round(a.minutes) + ' min</td>' +
        '<td>' + (a.crewMinutes / 60).toFixed(1) + '</td>' +
        '<td>' + money(a.plow) + '</td>' +
        '<td>' + (a.salt ? money(a.salt) + (a.bags ? ' <span class="muted">' + a.bags + ' bags</span>' : '') : '—') + '</td>' +
        '<td>' + (a.labor ? money(a.labor) : '—') + '</td>' +
        '<td class="bold">' + money(a.total) + '</td>' +
        '<td class="bold" style="color:' + (weak ? 'var(--neg)' : 'var(--pos)') + '">' +
          (ph ? money(Math.round(ph)) : '—') + '</td>' +
      '</tr>';
    }).join('');

    const totals = ids.reduce((t, id) => {
      const a = acc[id];
      t.visits += a.visits; t.crewMin += a.crewMinutes; t.total += a.total; t.salt += a.salt;
      return t;
    }, { visits: 0, crewMin: 0, total: 0, salt: 0 });

    wrap.innerHTML = picker + invoiceBar +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Account</th><th>Visits</th><th>Storms</th><th>On site</th><th>Crew hrs</th>' +
        '<th>Plowing</th><th>Salt</th><th>Labour</th><th>Billed</th><th>Per crew-hr</th>' +
      '</tr></thead><tbody>' + rows + '</tbody>' +
      '<tfoot><tr style="font-weight:700">' +
        '<td>All accounts</td><td>' + totals.visits + '</td><td></td><td></td>' +
        '<td>' + (totals.crewMin / 60).toFixed(1) + '</td><td></td>' +
        '<td>' + (totals.salt ? money(totals.salt) : '—') + '</td><td></td>' +
        '<td>' + money(totals.total) + '</td>' +
        '<td>' + (totals.crewMin ? money(Math.round(totals.total / (totals.crewMin / 60))) : '—') + '</td>' +
      '</tr></tfoot></table></div>' +
      '<div class="hint">Sorted by what each returns per crew-hour. Anything earning less than half ' +
      'the best is flagged — worth a look at the rate, not necessarily worth dropping.</div>';
  };

  window.YDBilling = { storms: () => storms, render, seasonByAccount, fixVisit, fixedWords };

  // Dropped on sign-out (the page does not reload), so the next person on the
  // same device neither inherits these figures nor misses a fresh watch.
  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const key = a.mode === 'cloud' && a.user && ydCan('billing', 'see') ? (a.key || a.user.uid) : null;
    if (key !== authKey) {
      if (unsub) { try { unsub(); } catch (err) {} unsub = null; }
      storms = {};
      authKey = key;
    }
    // No longer allowed: the bills on screen go too.
    if (key) start(); else render();
  });
})();
