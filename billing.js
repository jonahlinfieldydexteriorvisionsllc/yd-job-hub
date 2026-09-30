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

  async function invoicing() {
    if (invoiceSettings) return invoiceSettings;
    try {
      invoiceSettings = (await window.YDDb.get('settings', INVOICE_DOC)) || {};
    } catch (e) { invoiceSettings = {}; }
    return invoiceSettings;
  }

  // Returns { accountId: 'number' } for this storm, assigning and saving any
  // that have not been given out yet.
  async function invoiceNumbersFor(id, b, accountIds) {
    const existing = Object.assign({}, b.invoiceNos || {});
    const missing = accountIds.filter(a => !existing[a]);
    if (!missing.length) return existing;

    const cfg = await invoicing();
    // No starting point set yet: fall back to a storm-based reference, which
    // is unique but does not pretend to continue anybody's sequence.
    if (cfg.nextInvoiceNo == null) {
      const d = stormStart(storms[id]);
      const stamp = String(d.getFullYear()).slice(2) +
        two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
      missing.forEach((a, i) => { existing[a] = 'SNOW-' + stamp + '-' + two(i + 1); });
      return existing;
    }

    let next = parseInt(cfg.nextInvoiceNo, 10) || 1;
    const prefix = cfg.invoicePrefix || '';
    missing.forEach(a => { existing[a] = prefix + next; next++; });

    // Written before the file is handed over, so a number is never given out
    // twice even if the download itself goes wrong.
    invoiceSettings = Object.assign({}, cfg, { nextInvoiceNo: next });
    try {
      await window.YDDb.put('settings', INVOICE_DOC, { nextInvoiceNo: next });
      await window.YDDb.put('storms/' + id + '/private', 'billing', { invoiceNos: existing });
      b.invoiceNos = existing;
    } catch (e) {
      console.warn('[billing] invoice numbers not saved:', e.code || e.message);
    }
    return existing;
  }

  const two = n => String(n).padStart(2, '0');

  // Set from the season report, so the sequence can be pointed at whatever
  // QuickBooks is actually up to.
  window.setInvoiceStart = async function () {
    const cfg = await invoicing();
    const v = prompt('What is the next invoice number in QuickBooks?\n\n' +
      'Each exported invoice takes the next number from here, so they carry on ' +
      'in order. Storms already exported keep the numbers they were given.',
      cfg.nextInvoiceNo != null ? String(cfg.nextInvoiceNo) : '');
    if (v === null) return;
    const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    if (!(n > 0)) { showToast('That is not a number'); return; }
    invoiceSettings = Object.assign({}, cfg, { nextInvoiceNo: n });
    try {
      await window.YDDb.put('settings', INVOICE_DOC, { nextInvoiceNo: n });
      showToast('Next invoice will be ' + n);
      renderSeason();
    } catch (e) { showToast('Could not save that'); }
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

    let seasonTotal = 0, seasonVisits = 0, seasonHours = 0;
    ids.forEach(id => {
      const b = billingCache[id];
      if (!b) return;
      seasonTotal += b.totalCents; seasonVisits += b.lines.length; seasonHours += b.crewHours;
    });

    wrap.innerHTML =
      '<div class="dash-totals" style="margin-bottom:16px">' +
        card('Storms', ids.length) +
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
            '<button class="btn btn-sm btn-accent" onclick="exportStormCsv(\'' + id + '\')">QuickBooks CSV</button>' +
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

    const rows = Object.keys(byAccount).sort((x, y) => accountName(x).localeCompare(accountName(y)))
      .map(aid => {
        const ls = byAccount[aid];
        const total = ls.reduce((t, l) => t + l.totalCents, 0);
        return '<tr><td class="bold">' + esc(accountName(aid)) + '</td>' +
          '<td>' + ls.length + '</td>' +
          '<td>' + ls.map(l => l.inches + '"').join(', ') + '</td>' +
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
        '<button class="btn" onclick="copyStormSummary(\'' + id + '\')">Copy summary</button>' +
      '</div>';
    document.getElementById('stormDetailModal').classList.add('active');
  };

  window.closeStormDetail = function () {
    document.getElementById('stormDetailModal').classList.remove('active');
  };

  // ---------------------------------------------------------------- export

  // One invoice per account per storm, with a line per visit. Rows sharing an
  // invoice number become one invoice on import, which is why the number
  // repeats down the file.
  //
  // QuickBooks' import columns have varied between versions, so this is
  // deliberately plain and readable: check one invoice after the first import
  // rather than trusting a whole night blind.
  window.exportStormCsv = async function (id) {
    const s = storms[id], b = await billingFor(id);
    if (!b) { showToast('No billing recorded for that storm'); return; }

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

    const order = Object.keys(byAccount)
      .sort((x, y) => accountName(x).localeCompare(accountName(y)));
    const numbers = await invoiceNumbersFor(id, b, order);

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
          const rateCents = ((window.YDSnow && YDSnow.pricing()[l.accountId]) || {}).laborRateCents;
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
    URL.revokeObjectURL(url);
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
        a.bags += l.saltBags || 0;
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

  window.showSeason = function (s) { shownSeason = s; renderSeason(); };

  window.renderSeason = function () {
    const wrap = document.getElementById('seasonWrap');
    if (!wrap) return;

    const seasons = seasonsWithStorms();
    const section = wrap.closest('.section');
    if (!seasons.length) { if (section) section.hidden = true; wrap.innerHTML = ''; return; }
    if (section) section.hidden = false;
    if (!shownSeason || seasons.indexOf(shownSeason) === -1) shownSeason = seasons[0];

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
      '<button class="btn btn-sm" onclick="setInvoiceStart()">' +
        (nextNo != null ? 'Change' : 'Set it') + '</button>' +
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

  window.YDBilling = { storms: () => storms, render, seasonByAccount };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode === 'cloud' && a.user && a.isOwner) start();
  });
})();
