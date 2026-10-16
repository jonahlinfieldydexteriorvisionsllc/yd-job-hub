// The Snow tab's route bar.
//
// Jonah (12 Oct 2026): "snow page should show total miles for full route &
// estimate drive time total. I want a bar on the snow page that shows the
// current optimal route with each address and then the drive time between &
// miles."
//
// The route is the one the next storm would take with every active account
// (storm.js buildRoute: nearest next stop from the yard, or the order set by
// hand). Each leg's road miles and driving time come from the free OSRM
// router (the one functions/trip.py uses for estimate mileage), in one
// request; it also offers a faster order when it finds one -- "Use this
// order" keeps it. Whoever may change Snow can also move any stop up or
// down by hand, and go back to the worked-out order. The order set is what
// the next storm starts with.
//
// Asked only while the Snow tab is open, and remembered on the phone for the
// same stops in the same order, so the router is not asked over and over.
// With no signal (or no answer) the straight-line miles are shown instead.

(function () {
  'use strict';

  const OSRM = 'https://router.project-osrm.org';
  const KEEP_KEY = 'ydjobhub_snowRoute';
  const KEEP_HOURS = 24;
  const BETTER_BY_SECONDS = 120;        // a "faster order" has to save two minutes
  // A leg this long is nearly always an address the map found in the wrong
  // place (a mistyped town puts a stop 200 miles off): said on the stop.
  const FAR_MILES = 40;
  let road = null;            // { sig, legs: [{m, s}], m, s } for the order on screen
  let better = null;          // { order: [ids], m, s } -- a faster order, if any
  let asked = '', busy = false, failed = false, runs = 0;
  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const onMap = a => !!a && a.lat != null && a.lng != null;
  const edits = () => typeof ydCan === 'function' && ydCan('snow', 'change');
  // The bar plans the NEXT storm. While one is being worked it is only in
  // the way of the stops (and its order no longer changes anything), so it
  // is put away and the router is not asked.
  const stormOn = () => {
    const s = window.YDStorm && YDStorm.current();
    return window.YDStages.stormOpen(s);
  };

  function plan() {
    if (!window.YDStorm || !window.YDSnow) return null;
    const accounts = YDSnow.accounts();
    const start = YDStorm.startPoint();
    // Every account any storm could take: the deepest snow.
    const route = YDStorm.buildRoute(accounts, 99, start, YDStorm.routeOrder());
    return { start: start, stops: route.map(r => ({ id: r.accountId, a: accounts[r.accountId], straight: r.driveMiles })) };
  }
  const coords = pts => pts.map(p => (+p.lng).toFixed(5) + ',' + (+p.lat).toFixed(5)).join(';');

  function fetchJson(url, ms) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), ms);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(r => {
      if (!r.ok) throw new Error('router ' + r.status);
      return r.json();
    }).finally(() => clearTimeout(timer));
  }

  function kept(sig) {
    try {
      const k = JSON.parse(localStorage.getItem(KEEP_KEY) || 'null');
      return k && k.sig === sig && Date.now() - k.at < KEEP_HOURS * 3600e3 ? k : null;
    } catch (e) { return null; }
  }
  function keep(sig) {
    try { localStorage.setItem(KEEP_KEY, JSON.stringify({ sig: sig, at: Date.now(), road: road, better: better })); } catch (e) {}
  }

  async function measure() {
    if (stormOn()) { render(); return; }
    const p = plan();
    if (!p || !p.stops.length) { road = better = null; render(); return; }
    const mapped = p.stops.filter(s => onMap(s.a));
    const pts = [p.start].concat(mapped.map(s => s.a));
    const sig = coords(pts) + '|' + mapped.map(s => s.id).join(',');
    if (sig === asked) { render(); return; }
    asked = sig;
    const k = kept(sig);
    if (k) { road = k.road; better = k.better; failed = false; render(); return; }
    if (pts.length < 2) { road = better = null; render(); return; }
    // Two moves in quick succession: only the answer for the last one counts.
    const mine = ++runs;
    busy = true; failed = false; render();
    try {
      const r = await fetchJson(OSRM + '/route/v1/driving/' + coords(pts) + '?overview=false', 15000);
      if (mine !== runs) return;
      const best = r && r.routes && r.routes[0];
      if (!best) throw new Error('no route');
      road = { sig: sig, legs: best.legs.map(l => ({ m: l.distance, s: l.duration })), m: best.distance, s: best.duration };
      better = null;
      // A faster order: from the yard, ending wherever is quickest.
      try {
        const t = await fetchJson(OSRM + '/trip/v1/driving/' + coords(pts) +
          '?source=first&roundtrip=false&destination=any&overview=false', 15000);
        if (mine !== runs) return;
        const trip = t && t.trips && t.trips[0];
        if (trip && trip.duration < road.s - BETTER_BY_SECONDS) {
          const order = mapped.map((s, i) => ({ id: s.id, at: t.waypoints[i + 1].waypoint_index }))
            .sort((a, b) => a.at - b.at).map(x => x.id);
          better = { order: order.concat(p.stops.filter(s => !onMap(s.a)).map(s => s.id)), m: trip.distance, s: trip.duration };
        }
      } catch (e) { /* the route itself is what matters */ }
      keep(sig);
    } catch (e) {
      if (mine !== runs) return;
      road = better = null;
      failed = true;
      asked = '';           // try again next time the tab is opened
    }
    busy = false;
    render();
  }

  const miles = m => (m / 1609.344).toFixed(1);
  function mins(s) {
    const m = Math.round(s / 60);
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
  }

  function render() {
    const wrap = el('snowRouteWrap');
    if (!wrap) return;
    wrap.hidden = stormOn();
    if (wrap.hidden) { wrap.innerHTML = ''; return; }
    const p = plan();
    if (!p || !p.stops.length) { wrap.innerHTML = ''; return; }
    const mapped = p.stops.filter(s => onMap(s.a));
    const lost = p.stops.filter(s => !onMap(s.a));
    const fits = road && road.legs.length === mapped.length;
    const straight = p.stops.reduce((t, s) => t + (s.straight || 0), 0);
    const byHand = window.YDStorm && YDStorm.routeOrder().length > 0;
    const head = fits
      ? '<b>' + miles(road.m) + ' mi</b> · about <b>' + mins(road.s) + '</b> driving'
      : busy ? 'Working out the drive…'
      : '≈ ' + straight.toFixed(1) + ' mi in a straight line' + (failed ? ' <span class="muted">(the road times could not be fetched — no signal?)</span>' : '');
    let i = 0;
    const stopsHtml = p.stops.map((s, n) => {
      const leg = onMap(s.a) && fits ? road.legs[i++] : null;
      const a = s.a || {};
      const far = leg ? leg.m / 1609.344 > FAR_MILES : (s.straight || 0) > FAR_MILES;
      return '<div class="rt-leg">' + (leg ? miles(leg.m) + ' mi<br>' + mins(leg.s) : onMap(s.a) ? (s.straight != null ? '≈ ' + s.straight + ' mi' : '') : 'not on<br>the map') + '</div>' +
        '<div class="rt-stop' + (onMap(s.a) ? '' : ' lost') + (far ? ' far' : '') + '"><span class="rt-n">' + (n + 1) + '</span>' +
          '<b>' + esc(a.name || s.id) + '</b><small>' + esc(a.address || '') + '</small>' +
          (far ? '<small class="rt-warn">⚠ far from the last stop — check this address</small>' : '') +
          (edits() ? '<span class="rt-move">' +
            (n > 0 ? '<button onclick="routeMove(\'' + safe(s.id) + '\', -1)" title="Earlier">◀</button>' : '') +
            (n < p.stops.length - 1 ? '<button onclick="routeMove(\'' + safe(s.id) + '\', 1)" title="Later">▶</button>' : '') +
          '</span>' : '') + '</div>';
    }).join('');
    wrap.innerHTML = '<div class="route-bar">' +
      '<div class="rt-head"><span>🚚 <b>Route</b> · ' + p.stops.length + ' stop' + (p.stops.length === 1 ? '' : 's') + '</span>' +
        '<span>' + head + '</span>' + (byHand ? '<span class="rc-tag">order set by hand</span>' : '') + '</div>' +
      '<div class="rt-strip"><div class="rt-stop start"><span class="rt-n">🏠</span><b>Start</b><small>' + esc(p.start.label || '') + '</small></div>' +
        stopsHtml + '</div>' +
      // Only for whoever can take it: to anyone else it is a suggestion
      // they can do nothing with.
      (better && edits() ? '<div class="rt-better">A faster order: <b>' + miles(better.m) + ' mi · ' + mins(better.s) + '</b> — saves about ' +
        mins(road.s - better.s) + '. <button class="btn btn-sm btn-filled" onclick="routeUseBetter()">Use this order</button></div>' : '') +
      (lost.length ? '<div class="hint">' + lost.length + ' account' + (lost.length === 1 ? ' is' : 's are') +
        ' not on the map, so ' + (lost.length === 1 ? 'it goes' : 'they go') + ' last and ' + (lost.length === 1 ? 'is' : 'are') + ' not measured.</div>' : '') +
      (byHand && edits() ? '<button class="link-btn" onclick="routeAuto()">Back to the worked-out order</button>' : '') +
    '</div>';
  }

  window.routeMove = function (id, by) {
    const p = plan();
    if (!p) return;
    const ids = p.stops.map(s => s.id);
    const i = ids.indexOf(id), j = i + by;
    if (i === -1 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    if (YDStorm.setRouteOrder(ids)) { render(); refresh(); }
  };
  window.routeUseBetter = function () {
    if (!better) return;
    if (YDStorm.setRouteOrder(better.order)) { showToast('The next storm takes this order'); better = null; refresh(); }
  };
  window.routeAuto = function () {
    if (YDStorm.setRouteOrder(null)) { showToast('Back to the worked-out order'); refresh(); }
  };

  // Only while the Snow tab is on screen.
  let timer = null;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const panel = el('panel-snow');
      if (panel && panel.classList.contains('active')) measure();
      else render();
    }, 300);
  }
  document.addEventListener('yd-route-order', refresh);
  // A storm opening or closing (storm.js says so on every change; only the
  // switch between the two matters here).
  let wasOn = null;
  document.addEventListener('yd-storm-changed', () => {
    const on = stormOn();
    if (on !== wasOn) { wasOn = on; refresh(); }
  });
  document.addEventListener('yd-auth', e => { if (!(e.detail && e.detail.user)) { road = better = null; asked = ''; } });

  window.YDSnowRoute = { refresh: refresh, render: render };
})();
