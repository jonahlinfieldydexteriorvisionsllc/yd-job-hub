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

  const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const accountName = id => ((window.YDSnow && YDSnow.accounts()[id]) || {}).name || id;

  function usDate(iso) {
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }
  function plusDays(iso, n) {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return usDate(d.toISOString());
  }

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
            '<div class="storm-row-name">' + esc(s.label || id) + '</div>' +
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

    document.getElementById('stormDetailTitle').textContent = s.label || id;
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
    const two = n => String(n).padStart(2, '0');
    const stamp = '' + d0.getFullYear() + two(d0.getMonth() + 1) + two(d0.getDate());
    // Two storms in one day is an ordinary Wisconsin week, and without the
    // time in it both would export the same invoice number for the same
    // customer -- which QuickBooks would treat as one invoice.
    const ref = stamp + '-' + two(d0.getHours()) + two(d0.getMinutes());

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

    Object.keys(byAccount).sort((x, y) => accountName(x).localeCompare(accountName(y))).forEach(aid => {
      const name = accountName(aid);
      const invoiceNo = 'SNOW-' + ref + '-' + aid.toUpperCase().slice(0, 12);
      byAccount[aid].sort((a, c) => a.pass - c.pass).forEach(l => {
        const visit = 'Snow removal ' + s.label + (l.pass > 1 ? ' (pass ' + l.pass + ')' : '') +
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
          const manHours = Math.round((l.minutes / 60) * crew * 100) / 100;
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

    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
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
    const lines = ['YD Exterior Visions — ' + (s.label || id), ''];
    const byAccount = {};
    b.lines.forEach(l => { (byAccount[l.accountId] = byAccount[l.accountId] || []).push(l); });
    Object.keys(byAccount).sort((x, y) => accountName(x).localeCompare(accountName(y))).forEach(aid => {
      const ls = byAccount[aid];
      lines.push(accountName(aid) + ' — ' + ls.length + ' visit' + (ls.length > 1 ? 's' : '') +
                 ' — ' + money(ls.reduce((t, l) => t + l.totalCents, 0)));
    });
    lines.push('', 'Total: ' + money(b.totalCents),
               'Crew hours: ' + b.crewHours,
               'Per crew-hour: ' + money(b.revenuePerCrewHourCents));
    const text = lines.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showToast('Summary copied'));
    else showToast('Copy not supported here');
  };

  // ---------------------------------------------------------------- season

  // Which accounts actually earn. A big invoice is not the same as a good
  // account: a property that bills $815 and eats an hour of two people is
  // worth less per crew-hour than one that bills $95 in fourteen minutes.
  // That comparison is the reason this view exists.
  function seasonByAccount() {
    const acc = {};
    Object.keys(storms).forEach(id => {
      const b = billingCache[id];
      if (!b) return;
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

  window.renderSeason = function () {
    const wrap = document.getElementById('seasonWrap');
    if (!wrap) return;
    const acc = seasonByAccount();
    const ids = Object.keys(acc);
    const section = wrap.closest('.section');
    if (section) section.hidden = !ids.length;
    if (!ids.length) { wrap.innerHTML = ''; return; }

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

    wrap.innerHTML =
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
