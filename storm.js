// A storm, start to finish.
//
// This is the part used one-handed, in a truck, in the dark, with gloves on.
// Every decision below bends toward that: big targets, the next stop obvious,
// nothing that needs typing while driving, and nothing lost if the signal
// drops — Firestore queues the writes and sends them when it comes back.
//
//   storms/{id}              date, accumulation, crew, status   -> crew CAN read
//   storms/{id}/stops/{id}   arrive, depart, inches, salt        -> crew CAN write
//   storms/{id}/private/*    billing totals                      -> owner only
//
// Crew may only write to a storm whose status is still 'open'. Closing it
// locks the billing, so the numbers an invoice was raised from cannot shift
// underneath it afterwards. A crew member who spots a mistake later files a
// changeRequest instead (see firestore.rules).

(function () {
  'use strict';

  let storm = null;          // the open storm, or null
  let stops = {};            // stopId -> stop record
  let unsubStorms = null;
  let unsubStops = null;

  // Where the truck sets out from. Used to order the route. Until it is set in
  // Settings this is the middle of Madison, which gets the order roughly right
  // and never blocks a storm from starting.
  const DEFAULT_START = { lat: 43.0731, lng: -89.4012, label: 'Madison (set your yard in Settings)' };

  // ---------------------------------------------------------------- geometry

  function milesBetween(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return Infinity;
    const R = 3958.8, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Straight-line nearest-neighbour. Not the shortest possible route -- that is
  // a hard problem and not worth solving for 8 stops -- but far better than
  // alphabetical, and it beats whatever order a tired person picks at 3am.
  // Accounts with a morning deadline go first regardless of distance, because
  // missing those costs a customer.
  function buildRoute(accounts, accumulation, start) {
    const eligible = Object.keys(accounts).filter(id => {
      const a = accounts[id];
      if (a.active === false) return false;
      if (onHold(a)) return false;
      return (a.minTriggerInches || 1) <= accumulation;
    });

    const deadline = eligible.filter(id => accounts[id].serviceWindow === 'morning');
    const rest = eligible.filter(id => accounts[id].serviceWindow !== 'morning');

    const ordered = [];
    let here = start;
    [deadline, rest].forEach(group => {
      const pool = group.slice();
      while (pool.length) {
        let best = 0, bestD = Infinity;
        pool.forEach((id, i) => {
          const d = milesBetween(here, accounts[id]);
          if (d < bestD) { bestD = d; best = i; }
        });
        const id = pool.splice(best, 1)[0];
        ordered.push({ accountId: id, driveMiles: isFinite(bestD) ? Math.round(bestD * 10) / 10 : null });
        here = accounts[id];
      }
    });
    return ordered;
  }

  function onHold(a) {
    if (!Array.isArray(a.vacationHolds) || !a.vacationHolds.length) return false;
    const today = new Date().toISOString().slice(0, 10);
    return a.vacationHolds.some(h => h.from <= today && today <= h.to);
  }

  // ---------------------------------------------------------------- helpers

  const two = n => String(n).padStart(2, '0');
  function clockTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    let h = d.getHours(); const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + two(d.getMinutes()) + ampm;
  }
  function minutesBetween(a, b) {
    if (!a || !b) return null;
    return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  }

  function accountFor(stop) {
    return (window.YDSnow && YDSnow.accounts()[stop.accountId]) || {};
  }

  // ---------------------------------------------------------------- render

  function render() {
    const wrap = document.getElementById('stormWrap');
    const accountsWrap = document.getElementById('snowAccountsWrap');
    const startBtn = document.getElementById('stormStartBtn');
    if (!wrap) return;

    const isOwner = !!(window.YDAuth && window.YDAuth.isOwner);
    if (startBtn) startBtn.hidden = !isOwner || !!storm;

    if (!storm) {
      wrap.innerHTML = '';
      wrap.hidden = true;
      if (accountsWrap) accountsWrap.closest('.section').hidden = false;
      return;
    }

    wrap.hidden = false;
    if (accountsWrap) accountsWrap.closest('.section').hidden = true;

    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const done = list.filter(s => s.departedAt || s.skipped).length;
    const openStop = list.find(s => s.arrivedAt && !s.departedAt);

    wrap.innerHTML =
      '<div class="section">' +
        '<div class="section-head">' +
          '<span class="section-title">' + esc(storm.label || 'Storm') + '</span>' +
          '<span class="section-badge accent">' + done + ' / ' + list.length + ' done</span>' +
        '</div>' +
        '<div class="section-body">' +
          '<div class="storm-meta">' +
            '<span><strong>' + storm.accumulationInches + '"</strong> expected</span>' +
            '<span><strong>' + storm.crewSize + '</strong> crew' +
              (storm.crewNames ? ' · ' + esc(storm.crewNames) : '') + '</span>' +
            (openStop ? '<span class="storm-onsite">on site at ' + esc(accountFor(openStop).name) + '</span>' : '') +
          '</div>' +
          list.map(renderStop).join('') +
          (isOwner ? '<div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn btn-filled" onclick="closeStorm()">Close storm &amp; work out billing</button>' +
            '<button class="btn btn-danger btn-sm" onclick="abandonStorm()">Abandon</button></div>' : '') +
        '</div>' +
      '</div>';
  }

  function renderStop(s) {
    const a = accountFor(s);
    const state = s.skipped ? 'skipped' : s.departedAt ? 'done' : s.arrivedAt ? 'onsite' : 'todo';
    const mins = minutesBetween(s.arrivedAt, s.departedAt);

    let actions;
    if (s.skipped) {
      actions = '<button class="btn btn-sm" onclick="unskipStop(\'' + s.id + '\')">Undo skip</button>';
    } else if (!s.arrivedAt) {
      actions = '<button class="btn-stop arrive" onclick="arriveStop(\'' + s.id + '\')">Arrive</button>' +
                '<button class="btn btn-sm" onclick="skipStop(\'' + s.id + '\')">Skip</button>';
    } else if (!s.departedAt) {
      actions = '<button class="btn-stop depart" onclick="departStop(\'' + s.id + '\')">Depart</button>';
    } else {
      actions = '<button class="btn btn-sm" onclick="secondPass(\'' + s.id + '\')">Second pass</button>';
    }

    return '<div class="stop ' + state + '">' +
      '<div class="stop-head">' +
        '<span class="stop-num">' + (s.order + 1) + '</span>' +
        '<span class="stop-name">' + esc(a.name || s.accountId) + '</span>' +
        (s.pass > 1 ? '<span class="snow-tag trigger">pass ' + s.pass + '</span>' : '') +
        (a.serviceWindow === 'morning' ? '<span class="snow-tag hold">by morning</span>' : '') +
        (a.saltApplies ? '<span class="snow-tag salt">salt</span>' : '') +
      '</div>' +
      '<a class="snow-addr" href="https://maps.google.com/?q=' +
        encodeURIComponent(a.lat ? a.lat + ',' + a.lng : (a.address || '')) +
        '" target="_blank" rel="noopener">' + esc(a.address || '') +
        (s.driveMiles != null ? ' · ' + s.driveMiles + ' mi' : '') +
        '<span class="snow-go">maps</span></a>' +
      (a.areaNotes ? '<div class="stop-notes">' + esc(a.areaNotes) + '</div>' : '') +
      (s.arrivedAt ? '<div class="stop-times">in ' + clockTime(s.arrivedAt) +
        (s.departedAt ? ' · out ' + clockTime(s.departedAt) + ' · <strong>' + mins + ' min</strong>' : '') +
        '</div>' : '') +
      (s.skipped ? '<div class="stop-times">skipped — ' + esc(s.skipReason || 'no reason given') + '</div>' : '') +
      '<div class="stop-actions">' + actions + '</div>' +
    '</div>';
  }

  // ---------------------------------------------------------------- actions

  async function writeStop(id, patch) {
    Object.assign(stops[id], patch);              // show it immediately
    render();
    try {
      await window.YDDb.put('storms/' + storm.id + '/stops', id, patch);
    } catch (e) {
      console.warn('[storm] stop write queued or failed', e.code || e.message);
    }
  }

  window.arriveStop = function (id) {
    writeStop(id, { arrivedAt: new Date().toISOString() });
    locate(id, 'arrive');
  };

  window.departStop = function (id) {
    const s = stops[id];
    const a = accountFor(s);
    // Asked once, at the moment it is known, rather than reconstructed later.
    let inches = prompt('Inches cleared at ' + (a.name || 'this stop') + '?\n\nLeave blank to use the storm total (' + storm.accumulationInches + '").');
    if (inches === null) return;                  // cancelled -- do not depart
    inches = inches.trim() === '' ? storm.accumulationInches : parseFloat(inches);
    if (isNaN(inches)) inches = storm.accumulationInches;

    let bags = null;
    if (a.saltApplies) {
      const b = prompt('Salt bags used at ' + (a.name || 'this stop') + '? (blank if none)');
      if (b !== null && b.trim() !== '') bags = parseFloat(b) || 0;
    }
    writeStop(id, {
      departedAt: new Date().toISOString(),
      inchesCleared: inches,
      saltBags: bags,
    });
    locate(id, 'depart');
  };

  window.skipStop = function (id) {
    const why = prompt('Why is this stop being skipped?\n\n(e.g. under trigger, on hold, could not access)');
    if (why === null) return;
    writeStop(id, { skipped: true, skipReason: why.trim() || 'no reason given' });
  };

  window.unskipStop = function (id) {
    writeStop(id, { skipped: false, skipReason: null });
  };

  // A second pass on the same storm is a separate billable visit, per the spec.
  window.secondPass = async function (id) {
    const s = stops[id];
    const newId = s.accountId + '-p' + ((s.pass || 1) + 1);
    const rec = {
      accountId: s.accountId,
      order: Object.keys(stops).length,
      pass: (s.pass || 1) + 1,
      driveMiles: null,
      arrivedAt: null, departedAt: null,
      inchesCleared: null, saltBags: null,
      skipped: false,
    };
    stops[newId] = Object.assign({ id: newId }, rec);
    render();
    await window.YDDb.put('storms/' + storm.id + '/stops', newId, rec);
    showToast('Second pass added for ' + (accountFor(s).name || ''));
  };

  // Position is recorded where the browser allows it, and simply skipped where
  // it does not. It is evidence for a billing dispute, not a requirement.
  function locate(id, which) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => writeStop(id, {
        [which + 'Lat']: pos.coords.latitude,
        [which + 'Lng']: pos.coords.longitude,
      }),
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  // ---------------------------------------------------------------- lifecycle

  window.startStorm = async function () {
    const accounts = window.YDSnow ? YDSnow.accounts() : {};
    if (!Object.keys(accounts).length) { showToast('No snow accounts yet'); return; }

    const inchesRaw = prompt('How much snow is expected, in inches?');
    if (inchesRaw === null) return;
    const inches = parseFloat(inchesRaw);
    if (isNaN(inches) || inches <= 0) { showToast('Enter a number of inches'); return; }

    const crewRaw = prompt('How many people are working?', '2');
    if (crewRaw === null) return;
    const crewSize = parseInt(crewRaw, 10) || 1;
    const crewNames = (prompt('Who is working? (optional)') || '').trim();

    const start = DEFAULT_START;
    const route = buildRoute(accounts, inches, start);
    if (!route.length) {
      showToast('No accounts trigger at ' + inches + '" — nothing to do tonight');
      return;
    }

    const now = new Date();
    const id = now.toISOString().slice(0, 10) + '-' + two(now.getHours()) + two(now.getMinutes());
    const rec = {
      id: id,
      label: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
             ' · ' + inches + '"',
      startedAt: now.toISOString(),
      accumulationInches: inches,
      crewSize: crewSize,
      crewNames: crewNames,
      status: 'open',
      startedBy: (window.YDAuth && window.YDAuth.user && window.YDAuth.user.email) || '',
      startPoint: start,
      stopCount: route.length,
    };

    const writes = [['storms', id, rec]];
    route.forEach((r, i) => {
      writes.push(['storms/' + id + '/stops', r.accountId, {
        accountId: r.accountId, order: i, pass: 1, driveMiles: r.driveMiles,
        arrivedAt: null, departedAt: null, inchesCleared: null, saltBags: null,
        skipped: false,
      }]);
    });

    try {
      await window.YDDb.putMany(writes);
      showToast('Storm started — ' + route.length + ' stops');
    } catch (e) {
      console.error('[storm] could not start', e);
      showToast('Could not start the storm: ' + (e.message || ''));
    }
  };

  window.abandonStorm = async function () {
    if (!storm) return;
    if (!confirm('Abandon this storm?\n\nThe record stays, but it will not be billed.')) return;
    await window.YDDb.put('storms', storm.id, { status: 'abandoned', closedAt: new Date().toISOString() });
  };

  window.closeStorm = async function () {
    if (!storm) return;
    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const openOnes = list.filter(s => s.arrivedAt && !s.departedAt);
    if (openOnes.length && !confirm(openOnes.length + ' stop(s) are still open — nobody has departed.\n\nClose the storm anyway?')) return;

    const lines = [];
    let revenue = 0, salt = 0, minutes = 0;
    list.forEach(s => {
      if (s.skipped || !s.departedAt) return;
      const mins = minutesBetween(s.arrivedAt, s.departedAt) || 0;
      const inches = s.inchesCleared != null ? s.inchesCleared : storm.accumulationInches;
      const p = YDSnow.priceVisit(s.accountId, inches, mins, storm.crewSize);
      if (!p) return;
      minutes += mins;
      revenue += p.totalCents;
      salt += p.saltCents;
      lines.push({
        accountId: s.accountId, pass: s.pass || 1, inches: inches, minutes: mins,
        saltBags: s.saltBags, plowCents: p.plowCents, saltCents: p.saltCents,
        laborCents: p.laborCents, totalCents: p.totalCents,
      });
    });

    const crewHours = (minutes * storm.crewSize) / 60;
    const billing = {
      lines: lines,
      totalCents: revenue,
      saltCents: salt,
      onSiteMinutes: minutes,
      crewHours: Math.round(crewHours * 100) / 100,
      revenuePerCrewHourCents: crewHours > 0 ? Math.round(revenue / crewHours) : 0,
      skipped: list.filter(s => s.skipped).map(s => ({ accountId: s.accountId, reason: s.skipReason })),
      computedAt: new Date().toISOString(),
    };

    try {
      await window.YDDb.putMany([
        ['storms/' + storm.id + '/private', 'billing', billing],
        ['storms', storm.id, { status: 'closed', closedAt: new Date().toISOString() }],
      ]);
      alert('Storm closed.\n\n' +
        lines.length + ' billable visits\n' +
        'Revenue: $' + (revenue / 100).toFixed(2) + '\n' +
        (salt ? 'of which salt: $' + (salt / 100).toFixed(2) + '\n' : '') +
        'Crew hours: ' + billing.crewHours + '\n' +
        'Per crew-hour: $' + (billing.revenuePerCrewHourCents / 100).toFixed(2));
    } catch (e) {
      console.error('[storm] close failed', e);
      showToast('Could not close the storm: ' + (e.message || ''));
    }
  };

  // ---------------------------------------------------------------- watching

  function watchStops(stormId) {
    if (unsubStops) { unsubStops(); unsubStops = null; }
    stops = {};
    unsubStops = window.YDDb.watch('storms/' + stormId + '/stops', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete stops[c.id];
        else stops[c.id] = Object.assign({ id: c.id }, c.data);
      });
      render();
    });
  }

  function start() {
    if (unsubStorms || !window.YDDb) return;
    unsubStorms = window.YDDb.watch('storms', changes => {
      let openOne = storm;
      changes.forEach(c => {
        if (c.type === 'removed') { if (openOne && openOne.id === c.id) openOne = null; return; }
        const rec = Object.assign({ id: c.id }, c.data);
        if (rec.status === 'open') openOne = rec;
        else if (openOne && openOne.id === rec.id) openOne = null;
      });
      const changedStorm = (openOne && openOne.id) !== (storm && storm.id);
      storm = openOne;
      if (storm && changedStorm) watchStops(storm.id);
      if (!storm && unsubStops) { unsubStops(); unsubStops = null; stops = {}; }
      render();
    });
  }

  window.YDStorm = { current: () => storm, stops: () => stops, buildRoute, render };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode === 'cloud' && a.user) start();
  });
})();
