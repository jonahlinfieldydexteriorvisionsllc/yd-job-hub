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

  // Where the truck sets out from -- the first leg of every route is measured
  // from here, so it changes the whole order. Read from settings; the middle
  // of Madison is the fallback so a storm can always be started.
  const FALLBACK_START = { lat: 43.0731, lng: -89.4012, label: 'Madison (yard not set)' };
  let startPoint = FALLBACK_START;

  async function loadStartPoint() {
    try {
      const s = await window.YDDb.get('settings', 'snow');
      if (s && s.startLat != null) {
        startPoint = { lat: s.startLat, lng: s.startLng, label: s.startAddress || 'yard' };
      }
    } catch (e) { /* keep the fallback */ }
    const el = document.getElementById('snowStartPoint');
    if (el) el.textContent = 'Route starts from ' + startPoint.label;
  }

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
            (done === list.length && list.length
              ? '<button class="btn btn-accent" onclick="anotherRound()">Run the route again</button>' : '') +
            '<button class="btn btn-filled" onclick="closeStorm()">Close storm &amp; work out billing</button>' +
            '<button class="btn btn-danger btn-sm" onclick="abandonStorm()">Abandon</button></div>' : '') +
        '</div>' +
      '</div>';
  }

  // A number that can be nudged or typed. The buttons are for gloves; the
  // field is for the times a stepper would take ten taps.
  function stepper(stopId, kind, label, value, step) {
    const inputId = 'st-' + kind + '-' + stopId;
    return '<div class="stepper">' +
      '<span class="stepper-label">' + label + '</span>' +
      '<button class="stepper-btn" onclick="nudge(\'' + inputId + '\',' + (-step) + ')">&minus;</button>' +
      '<input class="stepper-input" id="' + inputId + '" inputmode="decimal" value="' + value + '">' +
      '<button class="stepper-btn" onclick="nudge(\'' + inputId + '\',' + step + ')">+</button>' +
    '</div>';
  }

  window.nudge = function (inputId, by) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const n = (parseFloat(el.value) || 0) + by;
    el.value = Math.max(0, Math.round(n * 10) / 10);
  };

  function readStepper(stopId, kind, fallback) {
    const el = document.getElementById('st-' + kind + '-' + stopId);
    if (!el) return fallback;
    const n = parseFloat(el.value);
    if (isNaN(n)) return fallback;
    // The field accepts typing, which means it accepts nonsense. Negative snow
    // does not exist, and a mistyped 1e9 would bill a fortune -- clamp rather
    // than trust, since these numbers go straight onto an invoice.
    const cap = kind === 'inches' ? 60 : 200;
    return Math.max(0, Math.min(cap, n));
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
      // Numbers are captured here, on the card, at the moment they are known --
      // steppers for gloved hands, and the field itself accepts typing for
      // anything the steppers make slow (13.5 inches, 11 bags).
      actions =
        stepper(s.id, 'inches', 'Inches cleared',
                s.inchesCleared != null ? s.inchesCleared : storm.accumulationInches, 0.5) +
        (a.saltApplies ? stepper(s.id, 'salt', 'Salt bags', s.saltBags || 0, 1) : '') +
        '<button class="btn-stop depart" onclick="departStop(\'' + s.id + '\')">Depart</button>';
    } else {
      actions = '<button class="btn btn-sm" onclick="secondPass(\'' + s.id + '\')">Another pass here</button>';
    }

    return '<div class="stop ' + state + '">' +
      '<div class="stop-head">' +
        '<span class="stop-num">' + (s.order + 1) + '</span>' +
        (!s.arrivedAt && !s.skipped
          ? '<span class="stop-move">' +
              '<button onclick="moveStop(\'' + s.id + '\',-1)" title="Earlier">&#9650;</button>' +
              '<button onclick="moveStop(\'' + s.id + '\',1)" title="Later">&#9660;</button>' +
            '</span>' : '') +
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

  // Firestore applies a write to the local cache immediately, but the promise
  // it hands back only settles when the SERVER acknowledges it. Awaiting that
  // means the interface waits for signal -- so with no bars, Start Storm built
  // the route locally and then sat there looking broken until a connection
  // came back. On a snow night that is the whole app appearing dead.
  //
  // So: send the write, never block the interface on it, and let the local
  // listener redraw. The queued write reaches the server on its own later.
  function writeSoon(promise, what) {
    Promise.resolve(promise).catch(e =>
      console.warn('[storm] ' + what + ' not yet on the server:', e.code || e.message));
  }

  // ---------------------------------------------------------------- actions

  async function writeStop(id, patch) {
    Object.assign(stops[id], patch);              // show it immediately
    render();
    writeSoon(window.YDDb.put('storms/' + storm.id + '/stops', id, patch), 'stop update');
  }

  window.arriveStop = function (id) {
    writeStop(id, { arrivedAt: new Date().toISOString() });
    locate(id, 'arrive');
  };

  window.departStop = function (id) {
    const s = stops[id];
    const a = accountFor(s);
    writeStop(id, {
      departedAt: new Date().toISOString(),
      inchesCleared: readStepper(id, 'inches', storm.accumulationInches),
      saltBags: a.saltApplies ? readStepper(id, 'salt', 0) : null,
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

  // Reordering uses arrows rather than dragging. The spec said drag, and on a
  // desktop drag is nicer -- but this list is worked on a phone, one-handed,
  // with gloves, and a drag that needs a precise press-hold-move is the wrong
  // gesture for that. Two taps always work.
  //
  // Only stops not yet started can move. Once someone has arrived, the order
  // is a record of what happened rather than a plan.
  window.moveStop = async function (id, delta) {
    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const i = list.findIndex(s => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    if (list[j].arrivedAt || list[j].skipped) { showToast('That stop is already done'); return; }

    const a = list[i], b = list[j];
    const ao = a.order, bo = b.order;
    a.order = bo; b.order = ao;                      // show it at once
    render();
    writeSoon(window.YDDb.putMany([
      ['storms/' + storm.id + '/stops', a.id, { order: bo }],
      ['storms/' + storm.id + '/stops', b.id, { order: ao }],
    ]), 'reorder');
  };

  // Every pass is a separate billed visit -- that is how a long storm pays.
  // A 14-inch night is not one four-hour visit, it is the route run several
  // times, each one billed at the account's rate. So running the whole route
  // again is a first-class action, not a per-stop afterthought.
  window.anotherRound = async function () {
    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const worked = list.filter(s => s.departedAt && !s.skipped);
    if (!worked.length) { showToast('Nothing to run again yet'); return; }
    if (!confirm('Run the route again?\n\nThis adds another billed visit for each of the ' +
                 worked.length + ' stops done so far.')) return;

    const seen = {};
    list.forEach(s => { seen[s.accountId] = Math.max(seen[s.accountId] || 0, s.pass || 1); });

    let order = list.length;
    const writes = [];
    worked.forEach(s => {
      if ((s.pass || 1) !== seen[s.accountId]) return;     // only the latest pass spawns the next
      const next = seen[s.accountId] + 1;
      writes.push(['storms/' + storm.id + '/stops', s.accountId + '-p' + next, {
        accountId: s.accountId, order: order++, pass: next, driveMiles: s.driveMiles,
        arrivedAt: null, departedAt: null, inchesCleared: null, saltBags: null, skipped: false,
      }]);
    });
    writeSoon(window.YDDb.putMany(writes), 'extra round');
    showToast('Route added again — ' + writes.length + ' more stops');
  };

  // A single stop can also be run again on its own.
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
    writeSoon(window.YDDb.put('storms/' + storm.id + '/stops', newId, rec), 'second pass');
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
    // A second storm started while one is open orphans the first: it stays
    // open forever, its stops unreachable from the interface, and it is never
    // billed. The realistic way in is tapping Start Storm, seeing nothing
    // obvious happen, and tapping again.
    if (storm) {
      showToast('A storm is already running — close it before starting another');
      return;
    }
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

    const start = startPoint;
    const route = buildRoute(accounts, inches, start);
    if (!route.length) {
      showToast('No accounts trigger at ' + inches + '" — nothing to do tonight');
      return;
    }

    const now = new Date();
    // Seconds, not just hours and minutes. Two storms started in the same
    // minute produced the same id and the second silently overwrote the
    // first -- which is exactly how a night's billing would disappear
    // without anything appearing to go wrong.
    // Every part of this is LOCAL time. toISOString() is UTC, and Madison is
    // six hours behind it in winter -- so a storm started at 6pm on the 14th
    // came out as '2026-01-15-180000': tomorrow's date beside this evening's
    // time. Snow work is mostly done in the evening, so that was most storms.
    const id = now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate()) + '-' +
               two(now.getHours()) + two(now.getMinutes()) + two(now.getSeconds());
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

    writeSoon(window.YDDb.putMany(writes), 'storm start');
    showToast('Storm started — ' + route.length + ' stops');
  };

  window.abandonStorm = async function () {
    if (!storm) return;
    if (!confirm('Abandon this storm?\n\nThe record stays, but it will not be billed.')) return;
    writeSoon(window.YDDb.put('storms', storm.id, { status: 'abandoned', closedAt: new Date().toISOString() }), 'abandon');
  };

  window.closeStorm = async function () {
    if (!storm) return;
    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const openOnes = list.filter(s => s.arrivedAt && !s.departedAt);
    if (openOnes.length && !confirm(openOnes.length + ' stop(s) are still open — nobody has departed.\n\nClose the storm anyway?')) return;

    const lines = [];
    let revenue = 0, salt = 0, minutes = 0, pausedTotal = 0;
    list.forEach(s => {
      if (s.skipped || !s.departedAt) return;
      const onSite = minutesBetween(s.arrivedAt, s.departedAt) || 0;

      // Time the crew were paused while standing on this property comes off
      // this customer's labour line -- a run for fuel or salt is paid work but
      // is not this customer's service. A pause taken BETWEEN two properties
      // falls outside every stop's window and so comes off nobody's bill,
      // which is the correct answer for driving time.
      //
      // With no clock running this is zero and the figure is the arrive-to-
      // depart time exactly as before, so nothing changes for a storm worked
      // without the clock.
      const paused = window.YDClock
        ? YDClock.pausedMinutesAt(storm.id, s.arrivedAt, s.departedAt) : 0;
      const mins = Math.max(0, onSite - paused);

      const inches = s.inchesCleared != null ? s.inchesCleared : storm.accumulationInches;
      const p = YDSnow.priceVisit(s.accountId, inches, mins, storm.crewSize);
      if (!p) return;
      minutes += mins;
      pausedTotal += paused;
      revenue += p.totalCents;
      salt += p.saltCents;
      lines.push({
        accountId: s.accountId, pass: s.pass || 1, inches: inches, minutes: mins,
        onSiteMinutes: onSite, pausedMinutes: paused,
        // Stored rather than recomputed at invoice time, so the hours printed
        // on the customer's invoice are the ones the charge was worked out from.
        manHours: p.manHours,
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
      pausedMinutes: pausedTotal,
      crewHours: Math.round(crewHours * 100) / 100,
      revenuePerCrewHourCents: crewHours > 0 ? Math.round(revenue / crewHours) : 0,
      skipped: list.filter(s => s.skipped).map(s => ({ accountId: s.accountId, reason: s.skipReason })),
      computedAt: new Date().toISOString(),
    };

    writeSoon(window.YDDb.putMany([
      ['storms/' + storm.id + '/private', 'billing', billing],
      ['storms', storm.id, { status: 'closed', closedAt: new Date().toISOString() }],
    ]), 'storm close');
    {
      alert('Storm closed.\n\n' +
        lines.length + ' billable visits\n' +
        'Revenue: $' + (revenue / 100).toFixed(2) + '\n' +
        (salt ? 'of which salt: $' + (salt / 100).toFixed(2) + '\n' : '') +
        'Crew hours: ' + billing.crewHours + '\n' +
        'Per crew-hour: $' + (billing.revenuePerCrewHourCents / 100).toFixed(2));
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

  const known = {};        // every storm seen, so an orphan can be spotted

  function start() {
    if (unsubStorms || !window.YDDb) return;
    loadStartPoint();
    unsubStorms = window.YDDb.watch('storms', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete known[c.id];
        else known[c.id] = Object.assign({ id: c.id }, c.data);
      });
      // Pick the most recently started open storm rather than whichever
      // happened to arrive last, and say so if more than one is open -- an
      // orphan should be visible, not quietly ignored.
      const open = Object.values(known).filter(s => s.status === 'open')
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
      if (open.length > 1) {
        console.warn('[storm] %d storms are open at once', open.length);
        showToast(open.length + ' storms are open — working the most recent');
      }
      const openOne = open[0] || null;
      const changedStorm = (openOne && openOne.id) !== (storm && storm.id);
      storm = openOne;
      if (storm && changedStorm) watchStops(storm.id);
      if (!storm && unsubStops) { unsubStops(); unsubStops = null; stops = {}; }
      render();
    });
  }

  window.setStartPoint = async function () {
    const addr = prompt('Where does the route start from?\n\n(your yard or wherever the truck leaves)',
                        startPoint.label === 'Madison (yard not set)' ? '' : startPoint.label);
    if (addr === null || !addr.trim()) return;
    showToast('Finding that address…');
    const geo = await window.YDSnowGeocode(addr.trim());
    if (!geo) { showToast('Could not find that address'); return; }
    await window.YDDb.put('settings', 'snow', {
      startAddress: addr.trim(), startLat: geo.lat, startLng: geo.lng, startTown: geo.town,
    });
    startPoint = { lat: geo.lat, lng: geo.lng, label: addr.trim() };
    const el = document.getElementById('snowStartPoint');
    if (el) el.textContent = 'Route starts from ' + startPoint.label;
    showToast('Route will start from ' + geo.town);
  };

  window.YDStorm = { current: () => storm, stops: () => stops, buildRoute, render,
                     startPoint: () => startPoint };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode === 'cloud' && a.user) start();
  });
})();
