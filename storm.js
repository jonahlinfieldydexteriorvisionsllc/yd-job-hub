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

  // Finding your place at 3am (15 Oct 2026). A finished stop folds to one
  // line, so the list is mostly the stops still to do; `opened` holds the
  // finished ones tapped open on this phone. `skipping` is the stop whose
  // reasons are on screen. `scrollWanted` brings this person's stop on
  // screen at the next drawing -- set when a storm is first drawn and after
  // THIS phone's own Arrive or Depart, never for another phone's change, so
  // the page never jumps under somebody's thumb. (A stop id in place of
  // `true` names the card to bring up: the one just arrived at.)
  const opened = {};
  let skipping = null;
  let scrollWanted = false;
  // The storm whose stops are being put in a new order on this phone
  // (stopReorder), or null. The arrows show only then, so the rest of the
  // time a customer's name has the card's whole width (Jonah, 15 Oct 2026:
  // on a phone the arrows squeezed the names onto three lines).
  let reordering = null;
  // How long the "Undo" after Arrive / Depart / Skip stays up.
  const UNDO_MS = 8000;
  // Salt chips for gloves: the usual amounts, one tap each.
  const SALT_CHIPS = [0, 100, 200, 300, 500];
  // Picked as big buttons rather than typed. "Other…" asks for the words.
  const SKIP_REASONS = ['Under trigger', 'Car in the way', 'Cancelled by customer', 'Can’t get in'];
  // accountId -> { lbs, at }: the salt put down there on the last few storms,
  // for "Same as last time". Read once per storm (see loadPastSalt).
  let pastSalt = {}, pastSaltFor = null;
  // The storm-shift clock-out, held while an Undo is up (see checkDone).
  let fromServer = false, holdDoneUntil = 0, doneTimer = null;

  // Where the truck sets out from -- the first leg of every route is measured
  // from here, so it changes the whole order. Read from settings; the middle
  // of Madison is the fallback so a storm can always be started.
  const FALLBACK_START = { lat: 43.0731, lng: -89.4012, label: 'Madison (yard not set)' };
  let startPoint = FALLBACK_START;
  // The order set by hand on the Snow tab's route bar (snowroute.js), kept in
  // settings/snow.routeOrder: a list of account ids. Empty: worked out.
  let routeOrder = [];

  async function loadStartPoint() {
    try {
      const s = await window.YDDb.get('settings', 'snow');
      if (s && s.startLat != null) {
        startPoint = { lat: s.startLat, lng: s.startLng, label: s.startAddress || 'yard' };
      }
      routeOrder = s && Array.isArray(s.routeOrder) ? s.routeOrder.filter(x => typeof x === 'string') : [];
      document.dispatchEvent(new CustomEvent('yd-route-order'));
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
  //
  // An order set by hand (`order`, the route bar's) is followed as it is:
  // what is in it goes first, in its order, and anything added since goes
  // after, nearest first.
  function buildRoute(accounts, accumulation, start, order) {
    const eligible = Object.keys(accounts).filter(id => {
      const a = accounts[id];
      if (a.active === false) return false;
      if (onHold(a)) return false;
      return (a.minTriggerInches || 1) <= accumulation;
    });
    if (Array.isArray(order) && order.length) {
      const set = order.filter(id => eligible.indexOf(id) !== -1);
      const rest = buildRoute(Object.assign({}, ...eligible.filter(id => set.indexOf(id) === -1).map(id => ({ [id]: accounts[id] }))),
        accumulation, set.length ? accounts[set[set.length - 1]] : start);
      let here = start;
      return set.map(id => {
        const d = milesBetween(here, accounts[id]);
        if (accounts[id].lat != null) here = accounts[id];
        return { accountId: id, driveMiles: isFinite(d) ? Math.round(d * 10) / 10 : null };
      }).concat(rest);
    }

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
  const nameOf = s => accountFor(s).name || s.accountId || 'this stop';
  const myUid = () => (window.YDAuth && window.YDAuth.user && window.YDAuth.user.uid) || '';
  const sortedStops = () => Object.values(stops).sort((a, b) => a.order - b.order);

  // "Undo" beside the news where the app has it (app.js showUndo), else the
  // plain message.
  function undoOr(msg, onUndo) {
    if (typeof showUndo === 'function') showUndo(msg, onUndo, UNDO_MS);
    else showToast(msg);
  }

  // Google Maps driving directions to the stop, the way the crew job page
  // does it (crewjobs.js mapUrl): to the address, which is what Maps shows
  // the driver; the map point only when there is no address.
  function directionsUrl(a) {
    // With its town (unless it already has it) and the state, as snow.js's
    // own map link sends it.
    const line = window.YDSnow && YDSnow.addressShown ? YDSnow.addressShown(a) : String(a.address || '');
    const where = line
      ? (a.street || /\b(WI|Wisconsin)\b/i.test(line) ? line : line + ', WI')
      : (a.lat != null && a.lng != null ? a.lat + ',' + a.lng : '');
    return where ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(where) : '';
  }

  // The stop this phone should be looking at: the one this person is on
  // site at, else the next one nobody has started, else anybody's on site.
  function currentStop(list) {
    const me = myUid();
    const onSite = s => s.arrivedAt && !s.departedAt && !s.skipped;
    // Of this person's own, the one arrived at last.
    const mine = list.filter(s => onSite(s) && me && s.arrivedBy === me)
      .sort((a, b) => String(b.arrivedAt).localeCompare(String(a.arrivedAt)))[0];
    return mine || list.find(s => !s.arrivedAt && !s.skipped) || list.find(onSite) || null;
  }

  // Bring that stop on screen (or the one just arrived at, when
  // `scrollWanted` names it). Only while the Snow tab is showing (a hidden
  // card cannot be scrolled to); otherwise it waits for the tab to open.
  function showCurrent(list) {
    const panel = document.getElementById('panel-snow');
    if (!panel || !panel.classList.contains('active') || !list.length) return;
    const named = typeof scrollWanted === 'string' ? list.find(s => s.id === scrollWanted) : null;
    scrollWanted = false;
    const s = named || currentStop(list);
    if (!s) return;
    // The first stop: the storm's heading too, so the count stays in view.
    const el = s === list[0] ? document.getElementById('stormWrap')
      : document.getElementById('stop-' + safeId(s.id));
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }
  function watchSnowTab() {
    const p = document.getElementById('panel-snow');
    if (!p || typeof MutationObserver !== 'function') return;
    new MutationObserver(() => { if (scrollWanted && storm) showCurrent(sortedStops()); })
      .observe(p, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchSnowTab);
  else watchSnowTab();

  // The salt put down at each account on the last three storms closed, for
  // the "Same as last time" chip. A few small reads, once per storm, never
  // waited on: the chip just appears when they answer (from the phone's
  // copy with no signal).
  function loadPastSalt() {
    if (!storm || pastSaltFor === storm.id || !window.YDDb || !window.YDDb.list) return;
    const forId = pastSaltFor = storm.id;
    pastSalt = {};
    Object.values(known).filter(x => x.id !== forId && window.YDStages.storm(x).id === 'closed')
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
      .slice(0, 3)
      .forEach(p => {
        Promise.resolve(window.YDDb.list('storms/' + p.id + '/stops')).then(rows => {
          if (pastSaltFor !== forId) return;
          let added = false;
          Object.values(rows || {}).forEach(x => {
            const lbs = num(x.saltLbs, null);
            if (lbs == null || !x.departedAt || x.skipped || !x.accountId) return;
            const was = pastSalt[x.accountId];
            if (!was || String(x.departedAt) > was.at) { pastSalt[x.accountId] = { lbs: lbs, at: String(x.departedAt) }; added = true; }
          });
          // Redrawn only where a salt box is showing.
          if (added && storm && storm.id === forId &&
              (fixing || Object.values(stops).some(s => s.arrivedAt && !s.departedAt && !s.skipped))) render();
        }).catch(() => { /* no chip, that is all */ });
      });
  }
  // This account's last salt: an earlier visit tonight first (a second
  // pass), then the last storms'. Null when nothing is known.
  function lastSaltOf(s) {
    let best = null;
    Object.values(stops).forEach(x => {
      if (x.id === s.id || x.accountId !== s.accountId || !x.departedAt || x.skipped) return;
      const lbs = num(x.saltLbs, null);
      if (lbs != null && (!best || String(x.departedAt) > best.at)) best = { lbs: lbs, at: String(x.departedAt) };
    });
    if (best) return best.lbs;
    const p = pastSalt[s.accountId];
    return p ? p.lbs : null;
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
    if (startBtn) startBtn.hidden = !startsStorms() || !!storm;
    // Where the NEXT storm's route starts is beside the point during one.
    const startRow = document.getElementById('snowStartRow');
    if (startRow) startRow.hidden = !!storm;

    if (!storm) {
      wrap.innerHTML = '';
      wrap.hidden = true;
      if (accountsWrap) accountsWrap.closest('.section').hidden = false;
      return;
    }

    wrap.hidden = false;
    if (accountsWrap) accountsWrap.closest('.section').hidden = true;
    loadPastSalt();
    // Whoever is typing in a box keeps their place through the redraw.
    const typing = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.id : null;

    const list = sortedStops();
    const done = list.filter(s => s.departedAt || s.skipped).length;
    const openStop = list.find(s => s.arrivedAt && !s.departedAt && !s.skipped);
    const next = list.find(s => !s.arrivedAt && !s.skipped);
    // Reordering ends with its storm, or once fewer than two stops can move.
    const movable = list.filter(movesFree).length;
    if (reordering && (reordering !== storm.id || movable < 2)) reordering = null;
    const ordering = !!reordering;

    wrap.innerHTML =
      '<div class="section">' +
        '<div class="section-head">' +
          '<span class="section-title">' + esc(storm.label || 'Storm') + '</span>' +
          '<span style="display:flex;align-items:center;gap:10px">' +
            '<span class="section-badge accent">' + done + ' / ' + list.length + ' done</span>' +
            // Night mode lives on the accounts section, which is hidden while a
            // storm is open -- the one time it is wanted most.
            // Says which way it goes, and is drawn again when tapped.
            '<button class="btn btn-sm" onclick="toggleNight(); YDStorm.render()" title="Night mode">◑ ' +
              (document.documentElement.hasAttribute('data-night') ? 'Day' : 'Night') + '</button>' +
          '</span>' +
        '</div>' +
        '<div class="section-body">' +
          '<div class="storm-meta">' +
            (num(storm.accumulationInches, null) != null
              ? '<span><strong>' + storm.accumulationInches + '"</strong> expected</span>' : '') +
            '<span><strong>' + storm.crewSize + '</strong> crew' +
              (storm.crewNames ? ' · ' + esc(storm.crewNames) : '') + '</span>' +
            (openStop ? '<span class="storm-onsite">on site at ' + esc(accountFor(openStop).name) + '</span>' : '') +
          '</div>' +
          orderBarHtml(movable, ordering) +
          (ordering
            ? list.map((s, i) => reorderRow(s, list[i - 1], list[i + 1])).join('') +
              // A Done at the foot as well: a long route is scrolled through.
              '<div class="stop-order stop-order-end"><button type="button" class="btn btn-filled stop-order-btn" onclick="stopReorder(false)">✓ Done reordering</button></div>'
            : list.map(s => renderStop(s, next && next.id)).join('')) +
          // The end of the night, well apart from the last stop's buttons and
          // each on its own row: a thumb reaching for that stop's Depart must
          // not land on Close.
          (runs || bills ? '<div class="storm-end">' +
            (runs && done === list.length && list.length
              ? '<div class="storm-end-row"><button class="btn btn-accent storm-end-btn" onclick="anotherRound()">Run the route again</button></div>' : '') +
            (runs ? '<div class="storm-end-row"><button class="btn btn-sm" onclick="addStormStop()">+ Add a stop</button></div>' : '') +
            (bills ? '<div class="storm-end-row"><button class="btn btn-filled storm-end-btn" onclick="closeStorm()">Close storm &amp; work out billing</button></div>' : '') +
            (runs ? '<div class="storm-end-row"><button class="btn btn-danger btn-sm" onclick="abandonStorm()">Abandon</button></div>' : '') +
            '</div>' : '') +
        '</div>' +
      '</div>';
    if (typing) {
      const el = document.getElementById(typing);
      if (el && el.tagName === 'INPUT') { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} }
    }
    if (scrollWanted) showCurrent(list);
  }

  // Another phone's change while a box here is being typed in: the list is
  // redrawn once the box is left, not under it -- rebuilt, the box got its
  // text back but an iPhone dropped the keyboard mid-number.
  let renderWaiting = false;
  const typingHere = () => {
    const wrap = document.getElementById('stormWrap'), a = document.activeElement;
    return !!(wrap && a && a.tagName === 'INPUT' && wrap.contains(a));
  };
  function renderSoon() {
    if (typingHere()) { renderWaiting = true; return; }
    render();
  }
  document.addEventListener('focusout', () => {
    if (!renderWaiting) return;
    setTimeout(() => { if (renderWaiting && !typingHere()) { renderWaiting = false; render(); } }, 300);
  });

  // A number that can be nudged or typed. The buttons are for gloves; the
  // field is for the times a stepper would take ten taps.
  //
  // What has been stepped or typed is kept here until Depart. The list is
  // redrawn whenever any stop changes -- another phone departing, this
  // phone's own location arriving a few seconds after Arrive -- and the boxes
  // used to go back to the storm's expected depth each time, so a stop could
  // be billed at the wrong tier.
  const drafts = {};          // input id -> what is in the box
  // The inches box starts EMPTY, like the salt box, and Depart waits for a
  // number (Jonah, 15 Oct 2026). It used to start on the storm's expected
  // depth, and an untouched box was billed at a forecast nobody measured.
  function stepper(stopId, kind, label, value, step) {
    const inputId = 'st-' + kind + '-' + stopId;
    const shown = drafts[inputId] != null ? drafts[inputId] : value;
    return '<div class="stepper">' +
      '<span class="stepper-label">' + label + '</span>' +
      '<button class="stepper-btn" onclick="nudge(\'' + inputId + '\',' + (-step) + ')" aria-label="Less">&minus;</button>' +
      '<input class="stepper-input" id="' + inputId + '" inputmode="decimal" value="' + esc(shown) + '" ' +
        'aria-label="' + esc(label) + '" oninput="stepperTyped(this)">' +
      '<button class="stepper-btn" onclick="nudge(\'' + inputId + '\',' + step + ')" aria-label="More">+</button>' +
    '</div>';
  }

  // The salt amounts as chips under the salt box, and "Same as last time"
  // when this account's last salt is known. A tap fills the box; Depart
  // still reads the box, so typing and the stepper work as before.
  function saltChips(stopId, s) {
    const inputId = 'st-lbs-' + stopId;
    const cur = drafts[inputId] != null ? drafts[inputId] : (num(s.saltLbs, null) != null ? String(s.saltLbs) : '');
    const v = String(cur).trim() === '' ? NaN : parseFloat(cur);
    const chip = (n, label) => '<button type="button" class="salt-chip' + (n === v ? ' on' : '') + '" data-lbs="' + n + '" ' +
      'aria-pressed="' + (n === v) + '" onclick="saltPick(\'' + inputId + '\',' + n + ')">' + label + '</button>';
    const same = lastSaltOf(s);
    return '<div class="salt-chips" data-chips-for="' + inputId + '" role="group" aria-label="Salt used">' +
      SALT_CHIPS.map(n => chip(n, n + ' lb')).join('') +
      (same != null ? chip(same, 'Same as last time · ' + same + ' lb') : '') +
    '</div>';
  }
  function markChips(inputId) {
    const el = document.getElementById(inputId);
    const group = document.querySelector('[data-chips-for="' + inputId + '"]');
    if (!el || !group) return;
    const v = el.value.trim() === '' ? NaN : parseFloat(el.value);
    group.querySelectorAll('.salt-chip').forEach(b => {
      const on = parseFloat(b.getAttribute('data-lbs')) === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  // The chips follow what is in the salt box, without redrawing the card.
  function touched(el) {
    if (el && /^st-lbs-/.test(el.id)) markChips(el.id);
  }

  window.stepperTyped = function (el) { drafts[el.id] = el.value; touched(el); };
  window.nudge = function (inputId, by) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const n = (parseFloat(el.value) || 0) + by;
    el.value = Math.max(0, Math.round(n * 10) / 10);
    drafts[inputId] = el.value;
    touched(el);
  };
  window.saltPick = function (inputId, n) {
    const el = document.getElementById(inputId);
    if (!el || typeof n !== 'number' || !isFinite(n)) return;
    el.value = n;
    drafts[inputId] = el.value;
    touched(el);
  };

  function readStepper(stopId, kind, fallback) {
    const el = document.getElementById('st-' + kind + '-' + stopId);
    if (!el) return fallback;
    const n = parseFloat(el.value);
    if (isNaN(n)) return fallback;
    // The field accepts typing, which means it accepts nonsense. Negative snow
    // does not exist, and a mistyped 1e9 would bill a fortune -- clamp rather
    // than trust, since these numbers go straight onto an invoice.
    const cap = kind === 'inches' ? 60 : kind === 'lbs' ? SALT_LBS_MAX : 200;
    return Math.max(0, Math.min(cap, n));
  }

  // Salt in pounds at every stop (Jonah, 12 Oct 2026: "for each property i
  // want whoevers filling out the storm to have to enter the quantity of salt
  // used in pounds"): a box that starts empty, so Depart waits until a number
  // -- 0 for none -- has been put in. Storms before this counted bags
  // (saltBags), which still read as bags wherever they show.
  const SALT_LBS_MAX = 20000;
  const SALT_STEP = 50;                 // a bag
  function saltWords(x) {
    const lbs = num(x.saltLbs, null), bags = num(x.saltBags, null);
    return lbs != null ? lbs + ' lb salt' : bags != null ? bags + ' bag' + (bags === 1 ? '' : 's') : '';
  }

  // A finished stop's one line: what went on the record, and when.
  function rowFigures(s) {
    if (s.skipped) return 'skipped — ' + (s.skipReason || 'no reason given');
    const inches = num(s.inchesCleared, null);
    const lbs = num(s.saltLbs, null), bags = num(s.saltBags, null);
    return [inches != null ? inches + '"' : '',
      lbs != null ? lbs + ' lb' : bags != null ? bags + ' bag' + (bags === 1 ? '' : 's') : '',
      s.departedAt ? clockTime(s.departedAt) : '',
      s.fixedAt ? 'fixed' : ''].filter(Boolean).join(' · ');
  }

  // The skip reasons, as big buttons in place of Arrive / Skip.
  function skipChoices(sid) {
    return '<div class="skip-why" role="group" aria-label="Why is it being skipped?">' +
      '<div class="skip-why-q">Why skip it?</div>' +
      SKIP_REASONS.map((r, i) => '<button type="button" class="btn skip-why-btn" onclick="skipWhy(\'' + sid + '\',' + i + ')">' +
        esc(r) + '</button>').join('') +
      '<button type="button" class="btn skip-why-btn" onclick="skipWhy(\'' + sid + '\',-1)">Other…</button>' +
      '<button type="button" class="btn skip-why-cancel" onclick="skipCancel()">Cancel — don’t skip</button>' +
    '</div>';
  }

  // ---------------------------------------------------------- reordering
  //
  // Only a stop nobody has started can move (see moveStop).
  const movesFree = s => !!s && !s.arrivedAt && !s.skipped;

  // "↕ Reorder stops" above the list, or -- while reordering -- what to do
  // and Done. Offered only with two or more stops that can still move.
  function orderBarHtml(movable, on) {
    if (on) {
      return '<div class="stop-order on" role="group" aria-label="Reorder stops">' +
        '<span class="stop-order-say">Tap ▲ ▼ to move a stop. Ones already started stay where they are.</span>' +
        '<button type="button" class="btn btn-filled btn-sm stop-order-btn" onclick="stopReorder(false)">✓ Done</button>' +
      '</div>';
    }
    return movable >= 2
      ? '<div class="stop-order"><button type="button" class="btn btn-sm stop-order-btn" onclick="stopReorder(true)">↕ Reorder stops</button></div>'
      : '';
  }

  // A stop while reordering: one line -- its number, name and address (or
  // how it went), and the arrows for one that can still move. `before` and
  // `after` are its neighbours in the list. Crew testing, 16 Oct 2026: ▼ on
  // the last stop did nothing at all, and ▲ into a stop being worked said
  // "That stop is already done". So an arrow with nowhere to go (the first
  // stop's ▲, the last one's ▼) is not there -- its place kept, so the other
  // lines up -- and one that would swap with a started stop is greyed, and
  // says why when it is tapped (moveStop), rather than nothing.
  function reorderRow(s, before, after) {
    const a = accountFor(s), sid = safeId(s.id);
    const state = s.skipped ? 'skipped' : s.departedAt ? 'done' : s.arrivedAt ? 'onsite' : 'todo';
    const name = a.name || s.accountId;
    const pass = num(s.pass, 1);
    const moves = movesFree(s);
    const sub = moves ? (a.address || '') : state === 'onsite' ? 'on site now' : rowFigures(s);
    const arrow = (delta, next, sign, word) => !next
      ? '<span class="stop-move-none" aria-hidden="true"></span>'
      : '<button type="button" data-move="' + delta + '" ' +
        'onclick="moveStop(\'' + sid + '\',' + delta + ')" aria-label="Move ' + esc(name) + ' ' + word + '"' +
        (movesFree(next) ? '' : ' class="stop-move-held" aria-disabled="true" title="' + esc(heldWords(next)) + '"') +
        '>' + sign + '</button>';
    return '<div class="stop ' + state + ' stop-ro" id="stop-' + sid + '">' +
      '<span class="stop-num">' + (num(s.order, 0) + 1) + '</span>' +
      '<span class="stop-ro-main"><span class="stop-ro-name">' + esc(name) +
          (pass > 1 ? ' <small>pass ' + pass + '</small>' : '') + '</span>' +
        (sub ? '<span class="stop-ro-sub">' + esc(sub) + '</span>' : '') + '</span>' +
      (moves ? '<span class="stop-move">' +
          arrow(-1, before, '&#9650;', 'earlier') +
          arrow(1, after, '&#9660;', 'later') +
        '</span>' : '') +
    '</div>';
  }
  // Why a stop cannot be moved past: in its own words, for the stop it is.
  function heldWords(s) {
    return s.skipped ? 'That stop was skipped — it stays where it is'
      : s.departedAt ? 'That stop is done — it stays where it is'
      : 'That stop is being worked — it stays where it is';
  }

  window.stopReorder = function (on) {
    reordering = on && storm ? storm.id : null;
    skipping = null;              // a skip question left open is put away
    // Back from it: to the stop being worked, as when the storm opens.
    if (!reordering) scrollWanted = true;
    render();
  };

  function renderStop(s, nextId) {
    const a = accountFor(s);
    const sid = safeId(s.id);
    const state = s.skipped ? 'skipped' : s.departedAt ? 'done' : s.arrivedAt ? 'onsite' : 'todo';
    const finished = state === 'done' || state === 'skipped';
    const mins = minutesBetween(s.arrivedAt, s.departedAt);
    const miles = num(s.driveMiles, null);
    const pass = num(s.pass, 1);
    const num1 = '<span class="stop-num">' + (num(s.order, 0) + 1) + '</span>';
    // Every stop carries id "stop-<stop id>", folded or not, so other
    // screens (Home) can point at one.
    const elId = 'stop-' + sid;

    // Finished and not opened: one line, tap to open.
    if (finished && !opened[s.id] && fixing !== s.id) {
      return '<div class="stop ' + state + ' folded" id="' + elId + '">' +
        '<button type="button" class="stop-row" onclick="stopOpen(\'' + sid + '\')" aria-expanded="false">' +
          num1 +
          '<span class="stop-row-main"><span class="stop-row-name">' + esc(a.name || s.accountId) +
            (pass > 1 ? ' <small>pass ' + pass + '</small>' : '') + '</span>' +
            '<span class="stop-row-figs">' + esc(rowFigures(s)) + '</span></span>' +
          '<span class="stop-chev" aria-hidden="true">›</span>' +
        '</button></div>';
    }

    let actions;
    if (s.skipped) {
      actions = '<button class="btn btn-sm" onclick="unskipStop(\'' + sid + '\')">Undo skip</button>';
    } else if (!s.arrivedAt) {
      actions = skipping === s.id ? skipChoices(sid)
        : '<button class="btn-stop arrive" onclick="arriveStop(\'' + sid + '\')">Arrive</button>' +
          '<button class="btn btn-sm stop-skip" onclick="skipStop(\'' + sid + '\')">Skip</button>';
    } else if (!s.departedAt) {
      // Numbers are captured here, on the card, at the moment they are known --
      // steppers for gloved hands, and the field itself accepts typing for
      // anything the steppers make slow (13.5 inches, 11 bags).
      actions =
        stepper(sid, 'inches', 'Inches cleared', num(s.inchesCleared, ''), 0.5) +
        stepper(sid, 'lbs', 'Salt used (lbs)', num(s.saltLbs, ''), SALT_STEP) +
        saltChips(sid, s) +
        '<button class="btn-stop depart" onclick="departStop(\'' + sid + '\')">Depart</button>' +
        // Arrive tapped on the wrong card, or too soon: taken back, not
        // left to bill a visit that never happened.
        '<div class="stop-undo-row"><button class="btn btn-sm stop-not-here" onclick="notHere(\'' + sid + '\')">Not here — undo arrive</button></div>';
    } else if (fixing === s.id) {
      // Departed with the wrong number in a box: put right while the storm
      // is still open (once it is closed, the bill is the office's).
      actions =
        stepper(sid, 'inches', 'Inches cleared', num(s.inchesCleared, ''), 0.5) +
        stepper(sid, 'lbs', 'Salt used (lbs)', num(s.saltLbs, ''), SALT_STEP) +
        saltChips(sid, s) +
        '<button class="btn btn-filled btn-sm" onclick="saveFix(\'' + sid + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="cancelFix()">Cancel</button>';
    } else {
      actions = '<button class="btn btn-sm" onclick="secondPass(\'' + sid + '\')">Another pass here</button>' +
        '<button class="btn btn-sm" onclick="fixStop(\'' + sid + '\')">✏️ Fix the numbers</button>';
    }

    const headInner = num1 +
      '<span class="stop-name">' + esc(a.name || s.accountId) + '</span>' +
      (pass > 1 ? '<span class="snow-tag trigger">pass ' + pass + '</span>' : '') +
      (a.serviceWindow === 'morning' ? '<span class="snow-tag hold">by morning</span>' : '') +
      (a.saltApplies ? '<span class="snow-tag salt">salt</span>' : '');
    // A finished stop opened from its line folds back from its heading.
    const head = finished && fixing !== s.id
      ? '<button type="button" class="stop-head stop-head-btn" onclick="stopOpen(\'' + sid + '\')" aria-expanded="true">' +
          headInner + '<span class="stop-chev open" aria-hidden="true">›</span></button>'
      // No arrows here: they are in Reorder (reorderRow), so the name has
      // the width.
      : '<div class="stop-head">' + headInner + '</div>';
    // The big Directions button on the stop being worked and the next one.
    // The address is words, not a link: the little "maps" link that was on
    // every card did what Directions does, and a glove brushing the address
    // threw the driver out to the map mid-storm.
    const dirUrl = (state === 'onsite' || s.id === nextId) ? directionsUrl(a) : '';
    const addr = [a.address || '', miles != null ? miles + ' mi' : ''].filter(Boolean).join(' · ');

    return '<div class="stop ' + state + (s.id === nextId ? ' next' : '') + '" id="' + elId + '">' +
      head +
      (addr ? '<div class="stop-addr">' + esc(addr) + '</div>' : '') +
      (dirUrl ? '<a class="stop-dir" href="' + esc(dirUrl) + '" target="_blank" rel="noopener">🧭 Directions</a>' : '') +
      (a.areaNotes ? '<div class="stop-notes">' + esc(a.areaNotes) + '</div>' : '') +
      (s.arrivedAt ? '<div class="stop-times">in ' + clockTime(s.arrivedAt) +
        (s.departedAt ? ' · out ' + clockTime(s.departedAt) + ' · <strong>' + mins + ' min</strong>' +
          // What went on the record, so a wrong one can be seen and fixed.
          (num(s.inchesCleared, null) != null ? ' · ' + num(s.inchesCleared, 0) + '"' : '') +
          (saltWords(s) ? ' · ' + saltWords(s) : '') +
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
  // `onRefused`: what to do instead when the rules refuse it (a Depart on a
  // storm closed meanwhile: sent to the office as a visit to add).
  function writeSoon(promise, what, onRefused) {
    Promise.resolve(promise).catch(e => {
      // Refused is not the same as "not sent yet". The usual case is a crew
      // member departing a stop after the owner has already closed the storm:
      // the phone showed the stop as done while the server kept the old one.
      if (e && e.code === 'permission-denied') {
        console.error('[storm] ' + what + ' refused by the rules');
        if (onRefused) onRefused();
        else showToast('Not saved — this storm has been closed');
      } else {
        console.warn('[storm] ' + what + ' not yet on the server:', (e && (e.code || e.message)));
      }
    });
  }

  // ---------------------------------------------------------------- actions

  // `quiet`: nothing on screen changes (a location fix -- the position is
  // kept as evidence and never shown), so the list is not redrawn under a
  // gloved thumb for it.
  async function writeStop(id, patch, quiet) {
    // A location fix can land seconds after the storm was closed or changed.
    if (!storm || !stops[id]) return;
    Object.assign(stops[id], patch);              // show it immediately
    if (!quiet) render();
    const stormId = storm.id, s = Object.assign({}, stops[id]);
    writeSoon(window.YDDb.put('storms/' + stormId + '/stops', id, patch), 'stop update',
      patch.departedAt ? () => missedVisit(stormId, s, patch) : null);
  }
  // A Depart that reached the server only after the storm was closed (made
  // with no signal, the owner closing meanwhile): refused, the visit was
  // left off the bill and its figures lost. Sent to the office instead as
  // a change to the visit -- approving it adds it to the bill (billing.js
  // fixVisit puts in a visit the bill does not have).
  function missedVisit(stormId, s, p) {
    const u = (window.YDAuth && window.YDAuth.user) || null;
    if (!u) return;
    const rid = 'cr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = {
      type: 'stopFigures', stormId: stormId, targetId: s.id, targetPath: 'storms/' + stormId + '/stops/' + s.id,
      accountId: s.accountId || '', accountName: accountFor(s).name || '',
      requestedBy: u.uid, requestedByName: u.displayName || u.email || '',
      reason: ('Departed ' + clockTime(p.departedAt) + ' — the storm was closed before it got through, so this visit is not on its bill').slice(0, 300),
      status: 'pending',
      before: { inchesCleared: null, saltLbs: null },
      after: { inchesCleared: num(p.inchesCleared, 0), saltLbs: num(p.saltLbs, 0) },
      createdAt: new Date().toISOString(),
    };
    Promise.resolve(window.YDDb.put('changeRequests', rid, rec)).catch(e =>
      console.warn('[storm] missed visit not sent:', (e && e.code) || e));
    showToast('The storm was closed before this Depart got through — sent to the office to add to the bill', 8000);
  }

  // Who tapped Arrive and Depart is saved with the time (arrivedBy /
  // departedBy, the uid): it tells this phone which stop is its own, and
  // the office who was there.
  window.arriveStop = async function (id) {
    let s = stops[id];
    if (!storm || !s || s.arrivedAt || s.skipped) return;
    const me = myUid();
    // Still on site somewhere else: nearly always a forgotten Depart, or
    // Arrive tapped on the wrong card.
    const here = me && Object.values(stops).find(x => x.id !== id && x.arrivedAt && !x.departedAt && !x.skipped && x.arrivedBy === me);
    if (here) {
      if (!(await ydConfirm('You are still on site at ' + nameOf(here) + ' — nobody has departed it.',
          { title: 'Arrive at ' + nameOf(s) + ' as well?', ok: 'Arrive here too', cancel: 'Not yet' }))) return;
      s = stops[id];
      if (!storm || !s || s.arrivedAt || s.skipped) return;
    }
    const at = new Date().toISOString();
    if (skipping === id) skipping = null;
    scrollWanted = id;                     // this card, now its boxes are open
    writeStop(id, { arrivedAt: at, arrivedBy: me || null });
    locate(id, 'arrive', at);
    undoOr('Arrived at ' + nameOf(s) + ' · ' + clockTime(at), () => {
      const x = stops[id];
      if (!x || x.arrivedAt !== at || x.departedAt) return;
      takeBackArrival(id);
    });
  };

  function takeBackArrival(id) {
    delete drafts['st-inches-' + id]; delete drafts['st-lbs-' + id];
    writeStop(id, { arrivedAt: null, arrivedBy: null, arriveLat: null, arriveLng: null });
  }

  // "Not here — undo arrive": the arrival taken back. With Undo after it
  // where the app has one, else asked first -- the time would be lost.
  window.notHere = function (id) {
    const s = stops[id];
    if (!storm || !s || !s.arrivedAt || s.departedAt) return;
    // Never undefined in a write: a field that was missing comes back as null.
    const was = { arrivedAt: s.arrivedAt, arrivedBy: s.arrivedBy || null,
                  arriveLat: num(s.arriveLat, null), arriveLng: num(s.arriveLng, null) };
    takeBackArrival(id);
    undoOr('Arrival at ' + nameOf(s) + ' taken back', () => {
      const x = stops[id];
      if (!x || x.arrivedAt || x.skipped) return;
      writeStop(id, was);
    });
  };

  // Both boxes must hold a number before a stop is saved: what is in them is
  // what the customer is billed. Says which one is missing and puts the
  // cursor in it.
  function boxesFilled(id) {
    const empty = el => !el || el.value.trim() === '' || isNaN(parseFloat(el.value));
    const inBox = document.getElementById('st-inches-' + id);
    if (empty(inBox)) {
      showToast('Put in the inches cleared here');
      if (inBox) inBox.focus();
      return false;
    }
    const box = document.getElementById('st-lbs-' + id);
    if (empty(box)) {
      showToast('Put in the salt used, in pounds — 0 if none');
      if (box) box.focus();
      return false;
    }
    return true;
  }

  window.departStop = function (id) {
    if (!boxesFilled(id)) return;
    const s = stops[id];
    if (!storm || !s || s.departedAt) return;
    const inches = readStepper(id, 'inches', 0);
    const lbs = readStepper(id, 'lbs', 0);
    delete drafts['st-inches-' + id]; delete drafts['st-lbs-' + id];
    const at = new Date().toISOString();
    scrollWanted = true;
    holdDone();
    writeStop(id, { departedAt: at, departedBy: myUid() || null, inchesCleared: inches, saltLbs: lbs });
    locate(id, 'depart', at);
    undoOr('Departed ' + nameOf(s) + ' — ' + inches + '", ' + lbs + ' lb salt', () => {
      const x = stops[id];
      if (!x || x.departedAt !== at) return;
      // Back on site, with what was typed still in the boxes.
      drafts['st-inches-' + id] = String(inches); drafts['st-lbs-' + id] = String(lbs);
      scrollWanted = id;
      writeStop(id, { departedAt: null, departedBy: null, inchesCleared: null, saltLbs: null,
                      departLat: null, departLng: null });
    });
  };

  // A finished stop's line opened or folded again (this phone only).
  window.stopOpen = function (id) {
    if (!stops[id]) return;
    if (opened[id]) delete opened[id]; else opened[id] = true;
    render();
  };

  // Fixing a departed stop's figures (the storm still open). The rules let
  // the crew write numbers to a stop until the storm is closed.
  window.fixStop = function (id) { fixing = id; opened[id] = true; render(); };
  window.cancelFix = function () {
    if (fixing) { delete drafts['st-inches-' + fixing]; delete drafts['st-lbs-' + fixing]; }
    fixing = null; render();
  };
  window.saveFix = function (id) {
    const s = stops[id];
    if (!s || !storm) { fixing = null; render(); return; }
    if (!boxesFilled(id)) return;
    const inches = readStepper(id, 'inches', num(s.inchesCleared, 0));
    const lbs = readStepper(id, 'lbs', num(s.saltLbs, 0));
    delete drafts['st-inches-' + id]; delete drafts['st-lbs-' + id];
    fixing = null;
    delete opened[id];          // back to its line, which shows the new figures
    const me = (window.YDAuth && window.YDAuth.user) || {};
    writeStop(id, { inchesCleared: inches, saltLbs: lbs, fixedAt: new Date().toISOString(), fixedBy: me.uid || '' });
    showToast('Fixed — ' + inches + '", ' + lbs + ' lb salt');
  };

  // Skip shows the reasons as buttons on the card; one more tap says why.
  window.skipStop = function (id) {
    if (!stops[id]) return;
    skipping = id;
    render();
  };
  window.skipCancel = function () { skipping = null; render(); };
  window.skipWhy = async function (id, i) {
    let s = stops[id];
    if (!storm || !s || s.arrivedAt) { skipping = null; render(); return; }
    let why = SKIP_REASONS[i];
    const skippedAt = new Date().toISOString();
    if (i === -1) {
      const typed = await ydPrompt('', '', { title: 'Why is ' + nameOf(s) + ' being skipped?', placeholder: 'In a few words', ok: 'Skip it' });
      if (typed === null) return;
      why = typed.trim().slice(0, 200) || 'Other';
      s = stops[id];
      if (!storm || !s || s.arrivedAt) { skipping = null; render(); return; }
    }
    if (!why) return;
    skipping = null;
    holdDone();
    // When: the last property skipped after driving there ends the night
    // there, not at the departure before it (doneAtMs, autoclock.py).
    writeStop(id, { skipped: true, skipReason: why, skippedAt: skippedAt });
    undoOr('Skipped ' + nameOf(s) + ' — ' + why, () => {
      const x = stops[id];
      if (!x || !x.skipped || x.skipReason !== why) return;
      writeStop(id, { skipped: false, skipReason: null, skippedAt: null });
    });
  };

  window.unskipStop = function (id) {
    writeStop(id, { skipped: false, skipReason: null, skippedAt: null });
  };

  // Reordering uses arrows rather than dragging. The spec said drag, and on a
  // desktop drag is nicer -- but this list is worked on a phone, one-handed,
  // with gloves, and a drag that needs a precise press-hold-move is the wrong
  // gesture for that. Two taps always work.
  //
  // Only stops not yet started can move. Once someone has arrived, the order
  // is a record of what happened rather than a plan.
  //
  // The arrows are shown only in Reorder (stopReorder), where the stop just
  // moved is kept under the thumb that moved it: the list scrolls with it,
  // so ▲ tapped again moves the same stop again -- not the one it swapped
  // places with, which would otherwise now be under the thumb.
  window.moveStop = async function (id, delta) {
    if (!storm) return;
    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const i = list.findIndex(s => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    // Started since the list was drawn (someone arrived), or the one it
    // would swap with has been: said so, in the words for what it is.
    if (!movesFree(list[i])) { showToast(heldWords(list[i]).replace('That stop', 'This stop')); return; }
    if (!movesFree(list[j])) { showToast(heldWords(list[j])); return; }

    const rowTop = () => {
      const n = document.getElementById('stop-' + safeId(id));
      return n ? n.getBoundingClientRect().top : null;
    };
    const was = rowTop();
    const a = list[i], b = list[j];
    const ao = a.order, bo = b.order;
    a.order = bo; b.order = ao;                      // show it at once
    render();
    const now = rowTop();
    if (was != null && now != null && now !== was) window.scrollBy({ top: now - was, left: 0, behavior: 'instant' });
    // A keyboard's place goes with it too.
    const again = document.querySelector('#stop-' + safeId(id) + ' [data-move="' + delta + '"]');
    if (again && !again.disabled && again.focus) again.focus({ preventScroll: true });
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
    const first = Object.values(stops).filter(s => s.departedAt && !s.skipped).length;
    if (!first) { showToast('Nothing to run again yet'); return; }
    // Every property is done, so the crew's storm shifts have ended at the
    // last departure: said, so the next pass is worked on the clock.
    if (!(await ydConfirm('This adds another billed visit for each of the ' + first + ' stops done so far.\n\n' +
        'Everyone was clocked out at the last stop — each of the crew clocks in to the storm again for this pass.',
        { title: 'Run the route again?', ok: 'Run it again' }))) return;
    if (!storm) return;

    // Worked out now, not before the question: another device may have
    // started the next pass while it was open, and its stops are kept.
    const list = Object.values(stops).sort((a, b) => a.order - b.order);
    const worked = list.filter(s => s.departedAt && !s.skipped);
    const seen = {};
    list.forEach(s => { seen[s.accountId] = Math.max(seen[s.accountId] || 0, s.pass || 1); });

    let order = list.length;
    const writes = [];
    worked.forEach(s => {
      if ((s.pass || 1) !== seen[s.accountId]) return;     // only the latest pass spawns the next
      const next = seen[s.accountId] + 1;
      const id = s.accountId + '-p' + next;
      if (stops[id]) return;
      // Only what a new stop needs. Blank figures in the write (it merges)
      // wiped a pass another phone had already started or finished.
      writes.push(['storms/' + storm.id + '/stops', id, {
        accountId: s.accountId, order: order++, pass: next, driveMiles: num(s.driveMiles, null),
      }]);
    });
    if (!writes.length) { showToast('That pass has already been added'); return; }
    writeSoon(window.YDDb.putMany(writes), 'extra round');
    showToast('Route added again — ' + writes.length + ' more stops');
  };

  // An account that is not on tonight's route -- left off by the expected
  // depth (it snowed more than said), on hold when the storm began, or
  // added or switched back on since -- put on it, at the end. There was no
  // way to, short of abandoning the storm and starting again.
  window.addStormStop = async function () {
    if (!ydCan('snow', 'change') || !storm) return;
    const accounts = window.YDSnow ? YDSnow.accounts() : {};
    const on = {};
    Object.values(stops).forEach(s => { on[s.accountId] = true; });
    const left = Object.keys(accounts).filter(id => !on[id] && accounts[id] && accounts[id].active !== false)
      .sort((a, b) => String(accounts[a].name || '').localeCompare(String(accounts[b].name || '')));
    if (!left.length) { showToast('Every active account is on this storm already'); return; }
    const pick = await ydChoose('Not on tonight’s route — left off by the expected depth, on hold, or added since. ' +
      'It goes at the end of the list.',
      left.map(id => ({ id: id, label: accounts[id].name || id,
        hint: onHold(accounts[id]) ? 'on hold today' : accounts[id].minTriggerInches > 1 ? 'takes ' + accounts[id].minTriggerInches + '" or more' : '' })),
      { title: 'Add a stop to this storm' });
    if (!pick || !storm) return;
    const id = left.find(x => x === pick.id);
    if (!id) return;
    if (stops[id]) { showToast('That one is on the route now'); return; }
    const order = Object.values(stops).reduce((m, s) => Math.max(m, num(s.order, 0)), -1) + 1;
    const rec = { accountId: id, order: order, pass: 1, driveMiles: null };
    stops[id] = Object.assign({ id: id }, rec);
    render();
    writeSoon(window.YDDb.put('storms/' + storm.id + '/stops', id, rec), 'added stop');
    showToast((accounts[id].name || 'That account') + ' added at the end of the route');
  };

  // A single stop can also be run again on its own.
  window.secondPass = async function (id) {
    const s = stops[id];
    if (!s) return;
    // Every pass is billed, so a stray tap here would charge the customer
    // for a visit nobody made.
    if (!(await ydConfirm('It goes at the end of the list.', { title: 'Add another billed visit to ' + nameOf(s) + '?', ok: 'Add a visit' }))) return;
    if (!storm || !stops[id]) return;
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
    // Only what a new stop needs: the write merges, and blank figures would
    // wipe a pass another phone made under the same id meanwhile.
    const rec = {
      accountId: s.accountId,
      order: Object.keys(stops).length,
      pass: pass,
      driveMiles: null,
    };
    stops[newId] = Object.assign({ id: newId }, rec);
    render();
    writeSoon(window.YDDb.put('storms/' + storm.id + '/stops', newId, rec), 'second pass');
    showToast('Second pass added for ' + (accountFor(s).name || ''));
  };

  // Position is recorded where the browser allows it, and simply skipped where
  // it does not. It is evidence for a billing dispute, not a requirement.
  // `at`: the arrive / depart time it belongs to. An Arrive or Depart taken
  // back (Undo) before the position answers must not get one.
  function locate(id, which, at) {
    if (!navigator.geolocation) return;
    const sid = storm && storm.id;
    navigator.geolocation.getCurrentPosition(
      pos => {
        // Only onto the storm it was asked for.
        if (!storm || storm.id !== sid) return;
        const s = stops[id];
        if (at && (!s || s[which === 'arrive' ? 'arrivedAt' : 'departedAt'] !== at)) return;
        writeStop(id, { [which + 'Lat']: pos.coords.latitude, [which + 'Lng']: pos.coords.longitude }, true);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  // ---------------------------------------------------------------- lifecycle

  // Who may start a storm: whoever can change Snow, and every admin whatever
  // their Snow access (Jonah, 15 Oct 2026: "allow all admins to start
  // storms"). Starting writes only the storm and its stops -- no prices, no
  // billing -- so it gives an admin nothing they could not already see.
  // Running the route again, abandoning and changing the route stay Snow
  // change; closing stays Billing.
  function startsStorms() {
    const a = window.YDAuth || {};
    return ydCan('snow', 'change') || (a.mode === 'cloud' && !!a.user && (a.isAdmin || a.role === 'admin'));
  }

  window.startStorm = async function () {
    if (!startsStorms()) return;
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
    // The yard and the hand-set route order read again while the form is
    // filled in (they were read once a sign-in: a phone left open for days
    // started the storm on an old order). Not waited for -- no signal, and
    // the last ones read stand.
    loadStartPoint();
    // One form rather than three questions in a row: big buttons for gloves,
    // and the crew picked by tapping their names (the clock's people), so
    // the names match the time clock and the count is never mistyped.
    startForm = { inches: '', picked: {}, others: '', size: '2' };
    // Whoever starts the storm is working it (crew testing, 16 Oct 2026: the
    // form said "1 working" with nobody ticked, and saved no names) -- ticked
    // to begin with, and untapped if they are only starting it for the crew.
    const me = window.YDAuth && YDAuth.user && YDAuth.user.uid;
    if (me && crewChoices().some(p => p.uid === me)) startForm.picked[me] = true;
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
  // Under the names: who is counted. With nobody tapped the storm is still
  // started for one -- "1 working" read as if someone had been picked
  // (office test, 16 Oct 2026), so it says so.
  function countWords(crew) {
    if (!crew.names && crewChoices().length) return 'Nobody tapped yet — counted as 1 working';
    return crew.size + ' working' + (crew.names ? ' — ' + crew.names : '');
  }
  function renderStormStart() {
    const body = document.getElementById('stormStartBody');
    if (!body || !startForm) return;
    const f = startForm, people = crewChoices(), crew = crewOf(f, people);
    body.innerHTML =
      '<div class="stepper"><span class="stepper-label">Snow expected (inches) <span class="muted">— optional</span></span>' +
        '<button class="stepper-btn" onclick="ssNudge(-1)">&minus;</button>' +
        '<input class="stepper-input" id="ssInches" inputmode="decimal" value="' + esc(f.inches) + '" oninput="ssSet(\'inches\', this.value)">' +
        '<button class="stepper-btn" onclick="ssNudge(1)">+</button></div>' +
      '<p class="hint">Empty puts every account on the route. A number leaves off the accounts that only ' +
        'take bigger storms. Each stop’s inches are put in at the stop.</p>' +
      forecastLine() +
      (people.length
        ? '<div class="ss-label">Who is working? <span class="muted">(tap)</span></div>' +
          '<div class="ss-crew">' + people.map(p => '<button class="ss-person' + (f.picked[p.uid] ? ' on' : '') + '" ' +
            'onclick="ssPick(\'' + safeId(p.uid) + '\')">' + (f.picked[p.uid] ? '✓ ' : '') + esc(p.name) + '</button>').join('') + '</div>' +
          '<label class="ss-label">Anyone else <span class="muted">(names, comma between)</span>' +
            '<input value="' + esc(f.others) + '" oninput="ssSet(\'others\', this.value)" onchange="renderStormStartCount()"></label>'
        : '<div class="stepper"><span class="stepper-label">How many people are working?</span>' +
            '<input class="stepper-input" inputmode="numeric" value="' + esc(f.size) + '" oninput="ssSet(\'size\', this.value)"></div>' +
          '<label class="ss-label">Who <span class="muted">(optional)</span><input value="' + esc(f.others) + '" oninput="ssSet(\'others\', this.value)"></label>') +
      '<div class="ss-count" id="ssCount">' + esc(countWords(crew)) + '</div>' +
      '<div class="field-actions"><button class="btn btn-filled clock-big" onclick="beginStorm()">❄ Start the storm</button>' +
        '<button class="btn" onclick="closeStormStart()">Cancel</button></div>';
  }
  // What the weather cards on the Snow tab last said, as information beside
  // the box -- never put into it, nor into any stop: the depth billed is the
  // one measured at each property.
  function forecastLine() {
    const f = window.YDWeather && YDWeather.snowForecast ? YDWeather.snowForecast() : [];
    const shown = f.filter(x => typeof x.snow24 === 'number' && isFinite(x.snow24));
    if (!shown.length) return '';
    const inch = n => (n >= 0.05 ? n.toFixed(1) : '0') + '"';
    return '<p class="hint">Forecast, next 24 h: ' + shown.map(x => esc(x.county) + ' ' + inch(x.snow24) +
        (typeof x.snow48 === 'number' && x.snow48 >= x.snow24 + 0.05 ? ' (' + inch(x.snow48) + ' over 48 h)' : '')).join(' · ') +
      (shown[0].age ? ' <span class="muted">— ' + esc(shown[0].age) + '</span>' : '') + '</p>';
  }
  window.renderStormStartCount = function () {
    const c = document.getElementById('ssCount');
    if (!c || !startForm) return;
    const crew = crewOf(startForm, crewChoices());
    c.textContent = countWords(crew);
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
    if (!startForm || !startsStorms()) return;
    if (storm) { closeStormStart(); showToast('A storm is already running — close it before starting another'); return; }
    // Expected depth is optional: empty puts every account on the route (one
    // under its trigger is skipped at the stop, "Under trigger"). Typed, it
    // must be a real depth.
    const typed = String(startForm.inches == null ? '' : startForm.inches).trim();
    const inches = typed === '' ? null : parseFloat(typed);
    if (inches !== null && (isNaN(inches) || inches <= 0)) {
      showToast('Expected inches: a number above 0, or leave it empty');
      const b = document.getElementById('ssInches'); if (b) b.focus();
      return;
    }
    const crew = crewOf(startForm, crewChoices());
    const crewSize = crew.size, crewNames = crew.names;
    const accounts = window.YDSnow ? YDSnow.accounts() : {};

    const start = startPoint;
    const route = buildRoute(accounts, inches === null ? Infinity : inches, start, routeOrder);
    if (!route.length) {
      showToast(inches === null ? 'No active snow accounts — nothing to do tonight'
        : 'No accounts trigger at ' + inches + '" — nothing to do tonight');
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
             (inches !== null ? ' · ' + inches + '"' : ''),
      startedAt: now.toISOString(),
      accumulationInches: inches,
      crewSize: crewSize,
      crewNames: crewNames,
      status: 'open',
      // Its one status (stages.js): Open -> Closed or Abandoned, each move
      // saying who and when.
      statusChange: window.YDStages.stamp('open'),
      startedBy: (window.YDAuth && window.YDAuth.user && window.YDAuth.user.email) || '',
      startPoint: start,
      stopCount: route.length,
    };

    const writes = [['storms', id, rec]];
    route.forEach((r, i) => {
      writes.push(['storms/' + id + '/stops', r.accountId, {
        accountId: r.accountId, order: i, pass: 1, driveMiles: r.driveMiles,
        arrivedAt: null, departedAt: null, inchesCleared: null, saltBags: null, saltLbs: null,
        skipped: false,
      }]);
    });

    writeSoon(window.YDDb.putMany(writes), 'storm start');
    showToast('Storm started — ' + route.length + ' stops');
  };

  window.abandonStorm = async function () {
    if (!ydCan('snow', 'change')) return;
    if (!storm) return;
    if (!(await ydConfirm('The record stays, but it will not be billed.', { title: 'Abandon this storm?', ok: 'Abandon it', danger: true }))) return;
    if (!storm) return;
    // closedAt as before (autoclock.py and the summaries read it), and who.
    const stamp = window.YDStages.stamp('abandoned');
    writeSoon(window.YDDb.put('storms', storm.id, { status: 'abandoned', closedAt: stamp.at, statusChange: stamp }), 'abandon');
  };

  window.closeStorm = async function () {
    if (!ydCan('billing', 'change') || !ydCan('hours', 'see')) return;
    if (!storm) return;
    let list = sortedStops();
    // Always asked, with where the route stands: closing is final (the crew
    // can no longer change a number) and the button is one tap away.
    const doneN = list.filter(s => s.departedAt && !s.skipped).length;
    const skippedN = list.filter(s => s.skipped).length;
    const onSiteN = list.filter(s => s.arrivedAt && !s.departedAt && !s.skipped).length;
    const openN = list.length - doneN - skippedN;
    // Skipped on one phone and worked on another: left off the bill, as a
    // skip is -- said, so a real visit is not lost without a word.
    const bothN = list.filter(s => s.skipped && s.departedAt).length;
    const closing = storm.id;
    if (!(await ydConfirm(doneN + ' done · ' + skippedN + ' skipped · ' + openN + ' still open' +
        (onSiteN ? ' (' + onSiteN + ' on site — nobody has departed)' : '') + '\n\n' +
        (openN ? 'Stops still open are left off the bill. ' : '') +
        (onSiteN ? 'A phone with no signal may still be sending its Depart — if so, it comes to you as a visit to add. ' : '') +
        (bothN ? bothN + ' skipped stop' + (bothN === 1 ? ' also has' : 's also have') +
          ' a Depart — un-skip ' + (bothN === 1 ? 'it' : 'them') + ' first if the visit was made, or it is left off. ' : '') +
        'Once it is closed, the crew can no longer change its numbers.',
        { title: 'Close this storm and work out the billing?', ok: 'Close the storm' }))) return;
    // The storm on screen may have changed while the question was open.
    if (!storm || storm.id !== closing) return;
    list = sortedStops();       // a stop departed while it was asked is billed too

    // Every customer visited must have a price before the bill is frozen. A
    // visit with no pricing loaded used to be left off the bill without a
    // word -- and closing is final, so that customer was simply never charged.
    const worked = list.filter(s => !s.skipped && s.departedAt);
    // The depth billed is the one put in at the stop. Depart has always
    // asked for one, but a storm can now start with no expected depth, so a
    // visit with no inches has nothing to fall back on: it is put right
    // (✏️ Fix the numbers) before anything is billed, never guessed.
    const noDepth = worked.filter(s => num(s.inchesCleared, num(storm.accumulationInches, null)) == null);
    if (noDepth.length) {
      ydAlert(noDepth.map(s => accountFor(s).name || s.accountId).join('\n') +
        '\n\nOpen each one, tap ✏️ Fix the numbers, put in the inches, then close the storm.', { title: 'No inches were put in for…' });
      return;
    }
    await YDSnow.refreshPricing(Array.from(new Set(worked.map(s => s.accountId))));
    // A pricing record with every box blank counts as no price: it would
    // bill $0 -- unless the account is charged by the hour alone.
    const noPrice = s => {
      const p = YDSnow.priceVisit(s.accountId, num(s.inchesCleared, storm.accumulationInches), 0, storm.crewSize);
      const hourly = ((YDSnow.pricing()[s.accountId] || {}).laborRateCents || 0) > 0;
      return !p || (!(p.plowCents + p.saltCents > 0) && !hourly);
    };
    const unpriced = Array.from(new Set(worked.filter(noPrice).map(s => (accountFor(s).name || s.accountId))));
    if (unpriced.length && !(await ydConfirm(unpriced.join('\n') +
        '\n\nThey would be left off this storm’s bill. Or go back, check their pricing on the Snow tab, then close again.',
        { title: 'No price could be found for…', ok: 'Close anyway', cancel: 'Go back', danger: true }))) return;
    if (!storm || storm.id !== closing) return;

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
        saltBags: num(s.saltBags, null), saltLbs: num(s.saltLbs, null), plowCents: p.plowCents, saltCents: p.saltCents,
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
      ['storms', storm.id, (stamp => ({ status: 'closed', closedAt: stamp.at, statusChange: stamp }))(window.YDStages.stamp('closed'))],
    ]), 'storm close');
    ydAlert(lines.length + ' billable visit' + (lines.length === 1 ? '' : 's') + '\n' +
      'Revenue: $' + (revenue / 100).toFixed(2) + '\n' +
      (salt ? 'of which salt: $' + (salt / 100).toFixed(2) + '\n' : '') +
      'Crew hours: ' + billing.crewHours + '\n' +
      'Per crew-hour: $' + (billing.revenuePerCrewHourCents / 100).toFixed(2), { title: 'Storm closed' });
  };

  // ---------------------------------------------------------------- watching

  function watchStops(stormId) {
    if (unsubStops) { unsubStops(); unsubStops = null; }
    stops = {};
    // What was typed belongs to this storm: stop ids are the account ids, so
    // a depth left in a box would otherwise open the next storm's card.
    // So do the lines opened and the skip question.
    Object.keys(drafts).forEach(k => { delete drafts[k]; });
    Object.keys(opened).forEach(k => { delete opened[k]; });
    skipping = null;
    clearTimeout(doneTimer); doneTimer = null; holdDoneUntil = 0;
    unsubStops = window.YDDb.watch('storms/' + stormId + '/stops', (changes, meta) => {
      let shown = false;      // anything that changes what the list shows
      changes.forEach(c => {
        if (!locationOnly(c)) shown = true;
        if (c.type === 'removed') delete stops[c.id];
        else stops[c.id] = Object.assign({ id: c.id }, c.data);
        // Departed (here or on another phone): its boxes are done with.
        // (Not the one whose figures are being fixed this minute.)
        if (c.type === 'removed' || (c.data && c.data.departedAt && c.id !== fixing)) {
          delete drafts['st-inches-' + safeId(c.id)]; delete drafts['st-lbs-' + safeId(c.id)];
        }
      });
      // A phone's position landing a few seconds after Arrive or Depart is
      // not on screen, and redrawing every phone's list for it moved the
      // buttons under whoever was tapping. So is this phone's own write
      // coming back, already drawn when it was made.
      if (shown) { renderSoon(); stormNews(); }
      // Every property done: this phone's storm shift ends at the last
      // departure (timeclock.js stormDone). Only from a list the server has
      // given -- a part-filled cache could look finished when it is not.
      fromServer = !(meta && meta.fromCache);
      checkDone(stormId);
    });
  }
  // The last Depart or Skip from this phone can still be undone for a few
  // seconds; the shift is not ended under it until that has passed (an
  // undone last Depart used to leave the person clocked out mid-storm).
  function holdDone() { holdDoneUntil = Date.now() + UNDO_MS + 1000; }
  function checkDone(stormId) {
    clearTimeout(doneTimer); doneTimer = null;
    if (!fromServer || !storm || storm.id !== stormId) return;
    const wait = holdDoneUntil - Date.now();
    if (wait > 0) { doneTimer = setTimeout(() => checkDone(stormId), wait); return; }
    const at = doneAtMs();
    if (at && window.YDClock && YDClock.stormDone) YDClock.stormDone(stormId, at);
  }
  // When the storm's work was done: every property departed or skipped (at
  // least one departed) -> the last departure, else null. The same as the
  // server's (functions/autoclock.py storm_done_ms).
  function doneAtMs() {
    const list = Object.values(stops);
    if (!list.length) return null;
    let last = null;
    for (const s of list) {
      if (!s.departedAt && !s.skipped) return null;
      // A property skipped after driving there counts to the skip.
      const t = s.departedAt ? Date.parse(s.departedAt) : s.skippedAt ? Date.parse(s.skippedAt) : NaN;
      if (isFinite(t) && (last === null || t > last)) last = t;
    }
    return last;
  }
  // Home shows the storm under way and how far along it is (home.js).
  function stormNews() { document.dispatchEvent(new CustomEvent('yd-storm-changed')); }

  // A stop change that leaves what the list shows as it was: only the
  // recorded position moved (arriveLat/Lng, departLat/Lng), or nothing did.
  const LOCATION_KEY = /^(arrive|depart)(Lat|Lng)$/;
  function locationOnly(c) {
    if (c.type !== 'modified' || !stops[c.id] || !c.data) return false;
    const was = stops[c.id], now = c.data;
    const keys = new Set(Object.keys(was).concat(Object.keys(now)));
    keys.delete('id');
    for (const k of keys) {
      if (LOCATION_KEY.test(k)) continue;
      if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) return false;
    }
    return true;
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
      const open = Object.values(known).filter(window.YDStages.stormOpen)
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
      if (open.length > 1) {
        console.warn('[storm] %d storms are open at once', open.length);
        showToast(open.length + ' storms are open — working the most recent');
      }
      const openOne = open[0] || null;
      const changedStorm = (openOne && openOne.id) !== (storm && storm.id);
      storm = openOne;
      // A storm going: the Snow tab is on a phone's bar again (Jonah, 26 Oct
      // 2026: "snow tab doesnt need to be on main nav on mobile" -- only
      // while there is one to work; styles.css, app.js phoneBar).
      document.documentElement.toggleAttribute('data-storm-on', !!storm);
      // A stop being fixed belongs to the storm it was on (stop ids repeat
      // from storm to storm).
      if (changedStorm) fixing = null;
      // A storm newly on this phone: its current stop is brought on screen
      // once the stops are in (and the Snow tab is showing).
      if (storm && changedStorm) { scrollWanted = true; watchStops(storm.id); }
      if (!storm) scrollWanted = false;
      if (!storm && unsubStops) { unsubStops(); unsubStops = null; stops = {}; }
      render();
      stormNews();
    });
  }

  window.setStartPoint = async function () {
    if (!ydCan('snow', 'change')) { showToast('Changing this needs Snow access'); return; }
    const addr = await ydPrompt('Your yard, or wherever the truck leaves from.',
                        startPoint.label === 'Madison (yard not set)' ? '' : startPoint.label,
                        { title: 'Where does the route start from?', placeholder: 'Street, town', ok: 'Save' });
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
    return Object.values(known).filter(s => window.YDStages.storm(s).id === 'closed' && s.closedAt && Date.parse(s.closedAt) > cutoff)
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
    const inches = num(x.inchesCleared, null), lbs = num(x.saltLbs, null);
    const r = latestRequest(s.id, x.id);
    const asked = !!askedHere[s.id + '/' + x.id];
    // The last change asked for on this visit, by its one status (stages.js):
    // Waiting, Approved, Turned down (and why), with when. Sent from this
    // phone and not back yet: Waiting too. Withdrawn says nothing here.
    const S = window.YDStages;
    const st = r ? S.request(r) : asked ? S.request({ status: 'pending' }) : null;
    const status = st && st.id !== 'withdrawn'
      ? S.chip(st, { detail: st.why || '', nameOf: uid => uid === ((window.YDAuth && YDAuth.user) || {}).uid ? 'you' : '' }) : '';
    const canAsk = !(st && st.id === 'waiting');
    return '<div class="ls-row">' +
      '<div class="ls-main"><b>' + esc(a.name || x.accountId) + '</b>' + (num(x.pass, 1) > 1 ? ' <span class="muted">pass ' + num(x.pass, 1) + '</span>' : '') +
        '<div class="muted">' + (inches != null ? inches + '"' : 'no depth') + (saltWords(x) ? ' · ' + saltWords(x) : '') +
        (status ? ' · ' + status : '') + '</div></div>' +
      (askingStop === x.id
        ? '<div class="ls-ask">' +
            '<div class="grid g2">' +
              '<div class="field"><span class="label">Inches it should be</span><input id="lsIn" inputmode="decimal" value="' + (inches != null ? inches : '') + '"></div>' +
              '<div class="field"><span class="label">Salt (lbs) it should be</span><input id="lsSalt" inputmode="decimal" value="' + (lbs != null ? lbs : '') + '"></div>' +
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
    const lbs = read('lsSalt', SALT_LBS_MAX);
    const why = ((document.getElementById('lsWhy') || {}).value || '').trim();
    if (inches == null || Number.isNaN(inches) || lbs == null || Number.isNaN(lbs)) { showToast('Put in the numbers it should be'); return; }
    if (!why) { showToast('Say why, so the office knows'); return; }
    if (inches === num(x.inchesCleared, null) && lbs === num(x.saltLbs, null)) { showToast('Those are the numbers it has now'); return; }
    const rid = 'cr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = {
      type: 'stopFigures', stormId: s.id, targetId: x.id, targetPath: 'storms/' + s.id + '/stops/' + x.id,
      accountId: x.accountId || '', accountName: a.name || '',
      requestedBy: u.uid, requestedByName: u.displayName || u.email || '', reason: why.slice(0, 300), status: 'pending',
      before: { inchesCleared: num(x.inchesCleared, null), saltLbs: num(x.saltLbs, null) },
      after: { inchesCleared: inches, saltLbs: lbs },
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

  // Another screen pointing at a stop (Home): the Snow tab opened on it,
  // a finished one opened from its line.
  function focusStop(id) {
    const s = stops[id];
    if (!storm || !s) return false;
    if (s.departedAt || s.skipped) opened[id] = true;
    scrollWanted = false;
    if (typeof switchTab === 'function') switchTab('snow');
    render();
    const el = document.getElementById('stop-' + safeId(id));
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return true;
  }

  window.YDStorm = { current: () => storm, stops: () => stops, buildRoute, render,
                     // The stop this person is on, else the next to do (or null).
                     currentStop: () => (storm ? currentStop(sortedStops()) : null),
                     focusStop: focusStop,
                     startPoint: () => startPoint, routeOrder: () => routeOrder.slice(),
                     // The route bar's order, set by hand (null: worked out again).
                     setRouteOrder: ids => {
                       if (!ydCan('snow', 'change')) { showToast('Changing the route needs Snow access'); return false; }
                       routeOrder = Array.isArray(ids) ? ids.slice() : [];
                       Promise.resolve(window.YDDb.put('settings', 'snow', { routeOrder: routeOrder }))
                         .catch(e => console.warn('[storm] route order not yet on the server:', e && (e.code || e.message)));
                       document.dispatchEvent(new CustomEvent('yd-route-order'));
                       return true;
                     } };

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
      Object.keys(opened).forEach(k => delete opened[k]);
      skipping = null; scrollWanted = false; fixing = null;
      pastSalt = {}; pastSaltFor = null;
      clearTimeout(doneTimer); doneTimer = null; holdDoneUntil = 0; fromServer = false;
      authKey = key;
    }
    if (key) start(); else render();
  });
})();
