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
  let fixing = null;         // the departed stop whose figures are being put right
  // The last closed storm, for the crew's "ask for a change" (see below).
  let lastId = null, lastStops = {}, unsubLast = null, askingStop = null;
  const askedHere = {};      // 'stormId/stopId' -> asked from this phone (before the request comes back)
  let lastLoaded = false;    // the last storm's stops have answered (an empty list is not "loading")

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
    // The crew see where the route starts; only someone who can change Snow
    // gets the button that changes it.
    const btn = el && el.parentElement && el.parentElement.querySelector('button');
    if (btn) btn.hidden = !ydCan('snow', 'change');
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
    const onMap = id => accounts[id].lat != null && accounts[id].lng != null;
    [deadline, rest].forEach(group => {
      // An account the map has not found still gets plowed, but it cannot be
      // measured from: it goes at the end of its group, and the next leg is
      // still measured from the last place that is on the map.
      const pool = group.filter(onMap);
      const lost = group.filter(id => !onMap(id));
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
      lost.forEach(id => ordered.push({ accountId: id, driveMiles: null }));
    });
    return ordered;
  }

  function onHold(a) {
    if (!Array.isArray(a.vacationHolds) || !a.vacationHolds.length) return false;
    // The LOCAL date. toISOString() is UTC, which in Wisconsin rolls over to
    // tomorrow at 6 or 7 pm -- exactly when storms start -- so a hold ending
    // today was ignored and one starting tomorrow already skipped tonight.
    const n = new Date();
    const today = n.getFullYear() + '-' + two(n.getMonth() + 1) + '-' + two(n.getDate());
    return a.vacationHolds.some(h => h.from <= today && today <= h.to);
  }

  // ---------------------------------------------------------------- helpers

  function two(n) { return String(n).padStart(2, '0'); }
  // Ids go into onclick handlers, and stop ids are written from crew phones.
  // Only the characters our own ids use get through.
  function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, ''); }
  // A figure from a stop record, or the fallback. Stops are written from crew
  // phones, so 'inches' or 'miles' is whatever was sent -- and this screen and
  // the bill print them. Text in a number's place was drawn as HTML on the
  // owner's screen, where it could run as the owner. Only a real number gets
  // through.
  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
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
    renderLast();

    // Running storms is Snow; closing one and working out the bills is
    // Billing. The owner has both; an admin has whichever they were given.
    const runs = ydCan('snow', 'change');
    // Closing works out the bill, which takes each crew member's pauses off
    // the time on site -- so it needs everyone's hours as well as Billing.
    const bills = ydCan('billing', 'change') && ydCan('hours', 'see');
    if (startBtn) startBtn.hidden = !runs || !!storm;

    if (!storm) {
      wrap.innerHTML = '';
      wrap.hidden = true;
      if (accountsWrap) accountsWrap.closest('.section').hidden = false;
      return;
    }

    wrap.hidden = false;
    if (accountsWrap) accountsWrap.closest('.section').hidden = true;
    // Whoever is typing in a box keeps their place through the redraw.
    const typing = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.id : null;

    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const done = list.filter(s => s.departedAt || s.skipped).length;
    const openStop = list.find(s => s.arrivedAt && !s.departedAt);

    wrap.innerHTML =
      '<div class="section">' +
        '<div class="section-head">' +
          '<span class="section-title">' + esc(storm.label || 'Storm') + '</span>' +
          '<span style="display:flex;align-items:center;gap:10px">' +
            '<span class="section-badge accent">' + done + ' / ' + list.length + ' done</span>' +
            // Night mode lives on the accounts section, which is hidden while a
            // storm is open -- the one time it is wanted most.
            '<button class="btn btn-sm" onclick="toggleNight()" title="Night mode">◑ Night</button>' +
          '</span>' +
        '</div>' +
        '<div class="section-body">' +
          '<div class="storm-meta">' +
            '<span><strong>' + storm.accumulationInches + '"</strong> expected</span>' +
            '<span><strong>' + storm.crewSize + '</strong> crew' +
              (storm.crewNames ? ' · ' + esc(storm.crewNames) : '') + '</span>' +
            (openStop ? '<span class="storm-onsite">on site at ' + esc(accountFor(openStop).name) + '</span>' : '') +
          '</div>' +
          list.map(renderStop).join('') +
          (runs || bills ? '<div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">' +
            (runs && done === list.length && list.length
              ? '<button class="btn btn-accent" onclick="anotherRound()">Run the route again</button>' : '') +
            (bills ? '<button class="btn btn-filled" onclick="closeStorm()">Close storm &amp; work out billing</button>' : '') +
            (runs ? '<button class="btn btn-danger btn-sm" onclick="abandonStorm()">Abandon</button>' : '') +
            '</div>' : '') +
        '</div>' +
      '</div>';
    if (typing) {
      const el = document.getElementById(typing);
      if (el && el.tagName === 'INPUT') { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} }
    }
  }

  // A number that can be nudged or typed. The buttons are for gloves; the
  // field is for the times a stepper would take ten taps.
  //
  // What has been stepped or typed is kept here until Depart. The list is
  // redrawn whenever any stop changes -- another phone departing, this
  // phone's own location arriving a few seconds after Arrive -- and the boxes
  // used to go back to the storm's expected depth each time, so a stop could
  // be billed at the wrong tier.
  const drafts = {};          // input id -> what is in the box
  function stepper(stopId, kind, label, value, step) {
    const inputId = 'st-' + kind + '-' + stopId;
    const shown = drafts[inputId] != null ? drafts[inputId] : value;
    return '<div class="stepper">' +
      '<span class="stepper-label">' + label + '</span>' +
      '<button class="stepper-btn" onclick="nudge(\'' + inputId + '\',' + (-step) + ')">&minus;</button>' +
      '<input class="stepper-input" id="' + inputId + '" inputmode="decimal" value="' + esc(shown) + '" ' +
        'oninput="stepperTyped(this)">' +
      '<button class="stepper-btn" onclick="nudge(\'' + inputId + '\',' + step + ')">+</button>' +
    '</div>';
  }

  window.stepperTyped = function (el) { drafts[el.id] = el.value; };
  window.nudge = function (inputId, by) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const n = (parseFloat(el.value) || 0) + by;
    el.value = Math.max(0, Math.round(n * 10) / 10);
    drafts[inputId] = el.value;
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
      actions = '<button class="btn btn-sm" onclick="unskipStop(\'' + safeId(s.id) + '\')">Undo skip</button>';
    } else if (!s.arrivedAt) {
      actions = '<button class="btn-stop arrive" onclick="arriveStop(\'' + safeId(s.id) + '\')">Arrive</button>' +
                '<button class="btn btn-sm" onclick="skipStop(\'' + safeId(s.id) + '\')">Skip</button>';
    } else if (!s.departedAt) {
      // Numbers are captured here, on the card, at the moment they are known --
      // steppers for gloved hands, and the field itself accepts typing for
      // anything the steppers make slow (13.5 inches, 11 bags).
      actions =
        stepper(safeId(s.id), 'inches', 'Inches cleared',
                num(s.inchesCleared, storm.accumulationInches), 0.5) +
        (a.saltApplies ? stepper(safeId(s.id), 'salt', 'Salt bags', num(s.saltBags, 0), 1) : '') +
        '<button class="btn-stop depart" onclick="departStop(\'' + safeId(s.id) + '\')">Depart</button>';
    } else if (fixing === s.id) {
      // Departed with the wrong number in a box: put right while the storm
      // is still open (once it is closed, the bill is the office's).
      actions =
        stepper(safeId(s.id), 'inches', 'Inches cleared', num(s.inchesCleared, storm.accumulationInches), 0.5) +
        (a.saltApplies ? stepper(safeId(s.id), 'salt', 'Salt bags', num(s.saltBags, 0), 1) : '') +
        '<button class="btn btn-filled btn-sm" onclick="saveFix(\'' + safeId(s.id) + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="cancelFix()">Cancel</button>';
    } else {
      actions = '<button class="btn btn-sm" onclick="secondPass(\'' + safeId(s.id) + '\')">Another pass here</button>' +
        '<button class="btn btn-sm" onclick="fixStop(\'' + safeId(s.id) + '\')">✏️ Fix the numbers</button>';
    }

    const miles = num(s.driveMiles, null);
    const pass = num(s.pass, 1);

    return '<div class="stop ' + state + '">' +
      '<div class="stop-head">' +
        '<span class="stop-num">' + (num(s.order, 0) + 1) + '</span>' +
        (!s.arrivedAt && !s.skipped
          ? '<span class="stop-move">' +
              '<button onclick="moveStop(\'' + safeId(s.id) + '\',-1)" title="Earlier">&#9650;</button>' +
              '<button onclick="moveStop(\'' + safeId(s.id) + '\',1)" title="Later">&#9660;</button>' +
            '</span>' : '') +
        '<span class="stop-name">' + esc(a.name || s.accountId) + '</span>' +
        (pass > 1 ? '<span class="snow-tag trigger">pass ' + pass + '</span>' : '') +
        (a.serviceWindow === 'morning' ? '<span class="snow-tag hold">by morning</span>' : '') +
        (a.saltApplies ? '<span class="snow-tag salt">salt</span>' : '') +
      '</div>' +
      '<a class="snow-addr" href="https://maps.google.com/?q=' +
        encodeURIComponent(a.lat ? a.lat + ',' + a.lng : (a.address || '')) +
        '" target="_blank" rel="noopener">' + esc(a.address || '') +
        (miles != null ? ' · ' + miles + ' mi' : '') +
        '<span class="snow-go">maps</span></a>' +
      (a.areaNotes ? '<div class="stop-notes">' + esc(a.areaNotes) + '</div>' : '') +
      (s.arrivedAt ? '<div class="stop-times">in ' + clockTime(s.arrivedAt) +
        (s.departedAt ? ' · out ' + clockTime(s.departedAt) + ' · <strong>' + mins + ' min</strong>' +
          // What went on the record, so a wrong one can be seen and fixed.
          (num(s.inchesCleared, null) != null ? ' · ' + num(s.inchesCleared, 0) + '"' : '') +
          (a.saltApplies && num(s.saltBags, null) != null ? ' · ' + num(s.saltBags, 0) + ' bag' + (num(s.saltBags, 0) === 1 ? '' : 's') : '') +
          (s.fixedAt ? ' · fixed' : '') : '') +
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
    Promise.resolve(promise).catch(e => {
      // Refused is not the same as "not sent yet". The usual case is a crew
      // member departing a stop after the owner has already closed the storm:
      // the phone showed the stop as done while the server kept the old one.
      if (e && e.code === 'permission-denied') {
        showToast('Not saved — this storm has been closed');
        console.error('[storm] ' + what + ' refused by the rules');
      } else {
        console.warn('[storm] ' + what + ' not yet on the server:', (e && (e.code || e.message)));
      }
    });
  }

  // ---------------------------------------------------------------- actions

  async function writeStop(id, patch) {
    // A location fix can land seconds after the storm was closed or changed.
    if (!storm || !stops[id]) return;
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
    const inches = readStepper(id, 'inches', storm.accumulationInches);
    const salt = a.saltApplies ? readStepper(id, 'salt', 0) : null;
    delete drafts['st-inches-' + id]; delete drafts['st-salt-' + id];
    writeStop(id, { departedAt: new Date().toISOString(), inchesCleared: inches, saltBags: salt });
    locate(id, 'depart');
  };

  // Fixing a departed stop's figures (the storm still open). The rules let
  // the crew write numbers to a stop until the storm is closed.
  window.fixStop = function (id) { fixing = id; render(); };
  window.cancelFix = function () {
    if (fixing) { delete drafts['st-inches-' + fixing]; delete drafts['st-salt-' + fixing]; }
    fixing = null; render();
  };
  window.saveFix = function (id) {
    const s = stops[id];
    if (!s || !storm) { fixing = null; render(); return; }
    const a = accountFor(s);
    const inches = readStepper(id, 'inches', num(s.inchesCleared, storm.accumulationInches));
    const salt = a.saltApplies ? readStepper(id, 'salt', num(s.saltBags, 0)) : num(s.saltBags, null);
    delete drafts['st-inches-' + id]; delete drafts['st-salt-' + id];
    fixing = null;
    const me = (window.YDAuth && window.YDAuth.user) || {};
    writeStop(id, { inchesCleared: inches, saltBags: salt, fixedAt: new Date().toISOString(), fixedBy: me.uid || '' });
    showToast('Fixed — ' + inches + '"' + (a.saltApplies ? ', ' + salt + ' bags' : ''));
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
    if (!ydCan('snow', 'change')) return;
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
        accountId: s.accountId, order: order++, pass: next, driveMiles: num(s.driveMiles, null),
        arrivedAt: null, departedAt: null, inchesCleared: null, saltBags: null, skipped: false,
      }]);
    });
    writeSoon(window.YDDb.putMany(writes), 'extra round');
    showToast('Route added again — ' + writes.length + ' more stops');
  };

  // A single stop can also be run again on its own.
  window.secondPass = async function (id) {
    const s = stops[id];
    if (!s) return;
    // The next pass for this customer is one past the HIGHEST pass they have,
    // not one past the card that was tapped. Tapping it on a pass-1 card after
    // "Run the route again" had already made pass 2 used to write a blank
    // visit over that pass 2 -- erasing a finished, billable visit.
    let pass = 1;
    Object.values(stops).forEach(x => {
      if (x.accountId === s.accountId) pass = Math.max(pass, x.pass || 1);
    });
    pass += 1;
    while (stops[s.accountId + '-p' + pass]) pass += 1;
    const newId = s.accountId + '-p' + pass;
    const rec = {
      accountId: s.accountId,
      order: Object.keys(stops).length,
      pass: pass,
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
    const sid = storm && storm.id;
    navigator.geolocation.getCurrentPosition(
      pos => {
        // Only onto the storm it was asked for.
        if (!storm || storm.id !== sid) return;
        writeStop(id, { [which + 'Lat']: pos.coords.latitude, [which + 'Lng']: pos.coords.longitude });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  // ---------------------------------------------------------------- lifecycle

  window.startStorm = async function () {
    if (!ydCan('snow', 'change')) return;
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
    // One form rather than three questions in a row: big buttons for gloves,
    // and the crew picked by tapping their names (the clock's people), so
    // the names match the time clock and the count is never mistyped.
    startForm = { inches: '', picked: {}, others: '', size: '2' };
    renderStormStart();
    const m = document.getElementById('stormStartModal');
    if (m) m.classList.add('active');
  };

  let startForm = null;
  function crewChoices() {
    const ppl = window.YDClock && YDClock.people ? YDClock.people() : {};
    return Object.keys(ppl).filter(uid => ppl[uid] && ppl[uid].active !== false &&
        ['owner', 'admin', 'crew'].indexOf(ppl[uid].role) !== -1)
      .map(uid => ({ uid: uid, name: ppl[uid].name || ppl[uid].email || 'Worker' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const othersOf = f => String(f.others || '').split(',').map(s => s.trim()).filter(Boolean);
  function crewOf(f, people) {
    const names = people.filter(p => f.picked[p.uid]).map(p => p.name).concat(othersOf(f));
    // At least one: a typed "-2" made every labour line negative.
    const size = people.length ? names.length : Math.max(1, parseInt(f.size, 10) || 1);
    return { size: Math.max(1, size), names: names.join(', ') };
  }
  function renderStormStart() {
    const body = document.getElementById('stormStartBody');
    if (!body || !startForm) return;
    const f = startForm, people = crewChoices(), crew = crewOf(f, people);
    body.innerHTML =
      '<div class="stepper"><span class="stepper-label">Snow expected (inches)</span>' +
        '<button class="stepper-btn" onclick="ssNudge(-1)">&minus;</button>' +
        '<input class="stepper-input" id="ssInches" inputmode="decimal" value="' + esc(f.inches) + '" placeholder="4" oninput="ssSet(\'inches\', this.value)">' +
        '<button class="stepper-btn" onclick="ssNudge(1)">+</button></div>' +
      (people.length
        ? '<div class="ss-label">Who is working? <span class="muted">(tap)</span></div>' +
          '<div class="ss-crew">' + people.map(p => '<button class="ss-person' + (f.picked[p.uid] ? ' on' : '') + '" ' +
            'onclick="ssPick(\'' + safeId(p.uid) + '\')">' + (f.picked[p.uid] ? '✓ ' : '') + esc(p.name) + '</button>').join('') + '</div>' +
          '<label class="ss-label">Anyone else <span class="muted">(names, comma between)</span>' +
            '<input value="' + esc(f.others) + '" oninput="ssSet(\'others\', this.value)" onchange="renderStormStartCount()"></label>'
        : '<div class="stepper"><span class="stepper-label">How many people are working?</span>' +
            '<input class="stepper-input" inputmode="numeric" value="' + esc(f.size) + '" oninput="ssSet(\'size\', this.value)"></div>' +
          '<label class="ss-label">Who <span class="muted">(optional)</span><input value="' + esc(f.others) + '" oninput="ssSet(\'others\', this.value)"></label>') +
      '<div class="ss-count" id="ssCount">' + crew.size + ' working' + (crew.names ? ' — ' + esc(crew.names) : '') + '</div>' +
      '<div class="field-actions"><button class="btn btn-filled clock-big" onclick="beginStorm()">❄ Start the storm</button>' +
        '<button class="btn" onclick="closeStormStart()">Cancel</button></div>';
  }
  window.renderStormStartCount = function () {
    const c = document.getElementById('ssCount');
    if (!c || !startForm) return;
    const crew = crewOf(startForm, crewChoices());
    c.textContent = crew.size + ' working' + (crew.names ? ' — ' + crew.names : '');
  };
  window.ssSet = function (k, v) { if (startForm) { startForm[k] = v; if (k !== 'inches') renderStormStartCount(); } };
  window.ssNudge = function (by) {
    if (!startForm) return;
    const n = Math.max(0, (parseFloat(startForm.inches) || 0) + by);
    startForm.inches = String(n);
    const box = document.getElementById('ssInches'); if (box) box.value = startForm.inches;
  };
  window.ssPick = function (uid) {
    if (!startForm) return;
    const id = crewChoices().map(p => p.uid).find(u => safeId(u) === uid);
    if (!id) return;
    if (startForm.picked[id]) delete startForm.picked[id]; else startForm.picked[id] = true;
    renderStormStart();
  };
  window.closeStormStart = function () {
    startForm = null;
    const m = document.getElementById('stormStartModal');
    if (m) m.classList.remove('active');
  };

  window.beginStorm = function () {
    if (!startForm || !ydCan('snow', 'change')) return;
    if (storm) { closeStormStart(); showToast('A storm is already running — close it before starting another'); return; }
    const inches = parseFloat(startForm.inches);
    if (isNaN(inches) || inches <= 0) { showToast('How many inches are expected?'); const b = document.getElementById('ssInches'); if (b) b.focus(); return; }
    const crew = crewOf(startForm, crewChoices());
    const crewSize = crew.size, crewNames = crew.names;
    const accounts = window.YDSnow ? YDSnow.accounts() : {};

    const start = startPoint;
    const route = buildRoute(accounts, inches, start);
    if (!route.length) {
      showToast('No accounts trigger at ' + inches + '" — nothing to do tonight');
      return;
    }
    closeStormStart();

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
      // The year is part of the label. Two Januarys from now a storm called
      // 'Thu, Jan 14' with no year is ambiguous in every list it appears in,
      // and these records are what invoices are raised from.
      label: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short',
                                               day: 'numeric', year: 'numeric' }) +
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
    if (!ydCan('snow', 'change')) return;
    if (!storm) return;
    if (!confirm('Abandon this storm?\n\nThe record stays, but it will not be billed.')) return;
    writeSoon(window.YDDb.put('storms', storm.id, { status: 'abandoned', closedAt: new Date().toISOString() }), 'abandon');
  };

  window.closeStorm = async function () {
    if (!ydCan('billing', 'change') || !ydCan('hours', 'see')) return;
    if (!storm) return;
    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const openOnes = list.filter(s => s.arrivedAt && !s.departedAt);
    if (openOnes.length && !confirm(openOnes.length + ' stop(s) are still open — nobody has departed.\n\nClose the storm anyway?')) return;

    // Every customer visited must have a price before the bill is frozen. A
    // visit with no pricing loaded used to be left off the bill without a
    // word -- and closing is final, so that customer was simply never charged.
    const worked = list.filter(s => !s.skipped && s.departedAt);
    await YDSnow.refreshPricing(Array.from(new Set(worked.map(s => s.accountId))));
    // A pricing record with every box blank counts as no price: it would
    // bill $0 -- unless the account is charged by the hour alone.
    const noPrice = s => {
      const p = YDSnow.priceVisit(s.accountId, num(s.inchesCleared, storm.accumulationInches), 0, storm.crewSize);
      const hourly = ((YDSnow.pricing()[s.accountId] || {}).laborRateCents || 0) > 0;
      return !p || (!(p.plowCents + p.saltCents > 0) && !hourly);
    };
    const unpriced = Array.from(new Set(worked.filter(noPrice).map(s => (accountFor(s).name || s.accountId))));
    if (unpriced.length && !confirm('No price could be found for:\n\n' + unpriced.join('\n') +
        '\n\nThey would be left off this storm’s bill. Close anyway?\n\n' +
        '(Cancel, check their pricing on the Snow tab, then close again.)')) return;

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

      // Numbers only, as on the stop card: these are frozen into the bill, and
      // the billing screens print them.
      const inches = num(s.inchesCleared, storm.accumulationInches);
      const p = YDSnow.priceVisit(s.accountId, inches, mins, storm.crewSize);
      // Left off, as the question before closing said: no $0 lines on a bill.
      if (!p || !(p.totalCents > 0)) return;
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
        laborRateCents: ((YDSnow.pricing()[s.accountId] || {}).laborRateCents) != null
          ? YDSnow.pricing()[s.accountId].laborRateCents : null,
        saltBags: num(s.saltBags, null), plowCents: p.plowCents, saltCents: p.saltCents,
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
    alert('Storm closed.\n\n' +
      lines.length + ' billable visits\n' +
      'Revenue: $' + (revenue / 100).toFixed(2) + '\n' +
      (salt ? 'of which salt: $' + (salt / 100).toFixed(2) + '\n' : '') +
      'Crew hours: ' + billing.crewHours + '\n' +
      'Per crew-hour: $' + (billing.revenuePerCrewHourCents / 100).toFixed(2));
  };

  // ---------------------------------------------------------------- watching

  function watchStops(stormId) {
    if (unsubStops) { unsubStops(); unsubStops = null; }
    stops = {};
    // What was typed belongs to this storm: stop ids are the account ids, so
    // a depth left in a box would otherwise open the next storm's card.
    Object.keys(drafts).forEach(k => { delete drafts[k]; });
    unsubStops = window.YDDb.watch('storms/' + stormId + '/stops', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete stops[c.id];
        else stops[c.id] = Object.assign({ id: c.id }, c.data);
        // Departed (here or on another phone): its boxes are done with.
        // (Not the one whose figures are being fixed this minute.)
        if (c.type === 'removed' || (c.data && c.data.departedAt && c.id !== fixing)) {
          delete drafts['st-inches-' + safeId(c.id)]; delete drafts['st-salt-' + safeId(c.id)];
        }
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
      // A stop being fixed belongs to the storm it was on (stop ids repeat
      // from storm to storm).
      if (changedStorm) fixing = null;
      if (storm && changedStorm) watchStops(storm.id);
      if (!storm && unsubStops) { unsubStops(); unsubStops = null; stops = {}; }
      render();
    });
  }

  window.setStartPoint = async function () {
    if (!ydCan('snow', 'change')) { showToast('Changing this needs Snow access'); return; }
    const addr = prompt('Where does the route start from?\n\n(your yard or wherever the truck leaves)',
                        startPoint.label === 'Madison (yard not set)' ? '' : startPoint.label);
    if (addr === null || !addr.trim()) return;
    showToast('Finding that address…');
    const geo = await window.YDSnowGeocode(addr.trim());
    if (!geo) { showToast('Could not find that address'); return; }
    // Not awaited, like every other write here: the promise waits for the
    // server, so on a weak signal the screen sat on "Finding that address…"
    // long after the address had been found.
    Promise.resolve(window.YDDb.put('settings', 'snow', {
      startAddress: addr.trim(), startLat: geo.lat, startLng: geo.lng, startTown: geo.town,
    })).catch(e => {
      console.warn('[storm] route start not yet on the server:', e && (e.code || e.message));
      if (e && e.code === 'permission-denied') showToast('Not saved — only the owner can set this');
    });
    startPoint = { lat: geo.lat, lng: geo.lng, label: addr.trim() };
    const el = document.getElementById('snowStartPoint');
    if (el) el.textContent = 'Route starts from ' + startPoint.label;
    showToast('Route will start from ' + (geo.town || addr.trim()));
  };

  // ------------------------------------------- after the storm is closed
  //
  // Closing a storm freezes its bill, so a crew member who spots a wrong
  // figure afterwards asks the office (Jonah, 6 Oct: crew can ask for changes
  // to storm stop figures). The last storm closed in the past two weeks is
  // listed on their Snow tab, each visit with "Ask for a change"; the office
  // approves it under Waiting for You, which fixes the stop and works that
  // customer's bill out again (billing.js fixVisit).
  function lastClosed() {
    const cutoff = Date.now() - 14 * 864e5;
    return Object.values(known).filter(s => s.status === 'closed' && s.closedAt && Date.parse(s.closedAt) > cutoff)
      .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))[0] || null;
  }
  const stormDay = s => {
    const d = new Date(s.startedAt || s.closedAt);
    return isNaN(d) ? 'storm' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  function dropLast() {
    if (unsubLast) { try { unsubLast(); } catch (e) {} }
    unsubLast = null; lastId = null; lastStops = {}; askingStop = null; lastLoaded = false;
  }
  function renderLast(force) {
    const wrap = document.getElementById('lastStormWrap');
    if (!wrap) return;
    // For whoever cannot put a closed storm's bill right themselves.
    const s = !storm && window.YDDb && !ydCan('billing', 'change') ? lastClosed() : null;
    if (!s) { wrap.hidden = true; wrap.innerHTML = ''; dropLast(); return; }
    if (s.id !== lastId) {
      dropLast();
      lastId = s.id;
      unsubLast = window.YDDb.watch('storms/' + s.id + '/stops', (changes, meta) => {
        changes.forEach(c => {
          if (c.type === 'removed') delete lastStops[c.id];
          else lastStops[c.id] = Object.assign({ id: c.id }, c.data);
        });
        if (!meta || meta.fromCache === false || changes.length) lastLoaded = true;
        renderLast();
      }, () => { lastLoaded = true; renderLast(); });
    }
    // Typing in the form is not interrupted by a redraw.
    if (!force && askingStop && document.activeElement && wrap.contains(document.activeElement)) return;
    const list = Object.values(lastStops).filter(x => x.departedAt && !x.skipped)
      .sort((a, b) => num(a.order, 0) - num(b.order, 0));
    wrap.hidden = false;
    wrap.innerHTML = '<div class="section"><div class="section-head">' +
        '<span class="section-title">Last storm — ' + esc(stormDay(s)) + '</span></div>' +
      '<div class="section-body">' +
        '<p class="hint" style="margin-top:0">Closed and billed. If a number is wrong, ask for a change — the office checks it.</p>' +
        (list.length ? list.map(x => lastRow(s, x)).join('')
          : '<p class="empty-msg">' + (lastLoaded ? 'No visits were recorded on it.' : 'Loading…') + '</p>') +
      '</div></div>';
  }
  function latestRequest(stormId, stopId) {
    const reqs = window.YDClock && YDClock.requests ? YDClock.requests() : {};
    return Object.values(reqs).filter(r => r.type === 'stopFigures' && r.stormId === stormId && r.targetId === stopId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  }
  function lastRow(s, x) {
    const a = accountFor(x);
    const inches = num(x.inchesCleared, null), salt = num(x.saltBags, null);
    const r = latestRequest(s.id, x.id);
    const asked = !!askedHere[s.id + '/' + x.id];
    const status = r && r.status === 'pending' || (!r && asked) ? '<span class="muted">change asked</span>'
      : r && r.status === 'approved' ? '<span class="muted">changed ✔</span>'
      : r && r.status === 'rejected' ? '<span class="muted">turned down' + (r.decidedReason ? ' — ' + esc(r.decidedReason) : '') + '</span>' : '';
    const canAsk = !(r && r.status === 'pending') && !(!r && asked);
    return '<div class="ls-row">' +
      '<div class="ls-main"><b>' + esc(a.name || x.accountId) + '</b>' + (num(x.pass, 1) > 1 ? ' <span class="muted">pass ' + num(x.pass, 1) + '</span>' : '') +
        '<div class="muted">' + (inches != null ? inches + '"' : 'no depth') + (a.saltApplies ? ' · ' + (salt != null ? salt : 0) + ' bags' : '') +
        (status ? ' · ' + status : '') + '</div></div>' +
      (askingStop === x.id
        ? '<div class="ls-ask">' +
            '<div class="grid g2">' +
              '<div class="field"><span class="label">Inches it should be</span><input id="lsIn" inputmode="decimal" value="' + (inches != null ? inches : '') + '"></div>' +
              (a.saltApplies ? '<div class="field"><span class="label">Salt bags it should be</span><input id="lsSalt" inputmode="decimal" value="' + (salt != null ? salt : '') + '"></div>' : '') +
            '</div>' +
            '<div class="field"><span class="label">Why</span><input id="lsWhy" placeholder="e.g. typed 3, it was 5 by the garage"></div>' +
            '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="sendStopAsk(\'' + safeId(x.id) + '\')">Send to the office</button>' +
              '<button class="btn btn-sm" onclick="askStop(\'\')">Cancel</button></div>' +
          '</div>'
        : canAsk ? '<button class="link-btn" onclick="askStop(\'' + safeId(x.id) + '\')">Ask for a change</button>' : '') +
    '</div>';
  }
  window.askStop = function (id) { askingStop = id || null; renderLast(true); };
  window.sendStopAsk = function (id) {
    const s = lastClosed(), x = lastStops[id], u = (window.YDAuth && window.YDAuth.user) || null;
    if (!s || !x || !u) return;
    const a = accountFor(x);
    const read = (elId, cap) => {
      const el = document.getElementById(elId);
      if (!el || el.value.trim() === '') return null;
      const n = parseFloat(el.value);
      return isNaN(n) ? NaN : Math.max(0, Math.min(cap, Math.round(n * 10) / 10));
    };
    const inches = read('lsIn', 60);
    const salt = a.saltApplies ? read('lsSalt', 200) : num(x.saltBags, null);
    const why = ((document.getElementById('lsWhy') || {}).value || '').trim();
    if (inches == null || Number.isNaN(inches) || Number.isNaN(salt)) { showToast('Put in the numbers it should be'); return; }
    if (!why) { showToast('Say why, so the office knows'); return; }
    if (inches === num(x.inchesCleared, null) && salt === num(x.saltBags, null)) { showToast('Those are the numbers it has now'); return; }
    const rid = 'cr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = {
      type: 'stopFigures', stormId: s.id, targetId: x.id, targetPath: 'storms/' + s.id + '/stops/' + x.id,
      accountId: x.accountId || '', accountName: a.name || '',
      requestedBy: u.uid, requestedByName: u.displayName || u.email || '', reason: why.slice(0, 300), status: 'pending',
      before: { inchesCleared: num(x.inchesCleared, null), saltBags: num(x.saltBags, null) },
      after: { inchesCleared: inches, saltBags: salt == null ? null : salt },
      createdAt: new Date().toISOString(),
    };
    askedHere[s.id + '/' + x.id] = true;
    askingStop = null;
    Promise.resolve(window.YDDb.put('changeRequests', rid, rec)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not sent — not allowed');
      else console.warn('[storm] change request not yet on the server:', (e && e.code) || e);
    });
    renderLast(true);
    showToast('Sent — the office will look at it');
  };
  // A request decided (or arriving back) redraws the list.
  document.addEventListener('yd-requests', () => renderLast());

  window.YDStorm = { current: () => storm, stops: () => stops, buildRoute, render,
                     startPoint: () => startPoint };

  // Signing out does not reload the page, so the watches and the data are
  // dropped here; otherwise the next person on the same phone would never get
  // fresh ones and would be looking at the last person's storm.
  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const key = a.mode === 'cloud' && a.user ? (a.key || a.user.uid + ':' + a.role) : null;
    if (key !== authKey) {
      [unsubStorms, unsubStops].forEach(u => { if (u) { try { u(); } catch (err) {} } });
      unsubStorms = unsubStops = null;
      storm = null; stops = {};
      Object.keys(known).forEach(k => delete known[k]);
      dropLast();
      Object.keys(askedHere).forEach(k => delete askedHere[k]);
      authKey = key;
    }
    if (key) start(); else render();
  });
})();
