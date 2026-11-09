// Placing a map pin by hand, for an address no map knows.
//
// Jonah (9 Nov 2026): "addresses being too new needs to give me a
// notification to place a pin or something or notification to have you do
// it". The server (functions/pins.py) finds them -- a snow account with no
// point, an open job whose address came back "not found" -- and puts a card
// on his My to-dos with one push. That card, Home's row for it, the push, the
// snow account and the estimate's miles all open this: a map to tap where the
// house is (satellite first, since a street too new for the maps is often
// already in the photos), "I'm here now" for a phone standing in the drive, or
// a Google Maps link pasted in (Google knows new streets the others don't).
// Saving goes to the server (/geo/pin), which checks the spot is in
// Wisconsin and near the address's ZIP or town (far: "Save it anyway"),
// writes it and closes the card. "Have Claude do it" moves the card to the
// wish board's Overnight column with the steps on it, for the night run; one
// it hasn't placed by morning comes back to his to-dos (functions/pins.py).
//
// Leaflet is loaded the first time a map is opened (cdnjs), not with the app:
// placing a pin needs a signal anyway, and every other screen stays as light.
(function () {
  const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  const MADISON = [43.0731, -89.4012];
  const el = id => document.getElementById(id);
  let loading = null, map = null, marker = null, at = null, picked = null, layers = null, saving = false;
  // The server asks about a pin far from the address's ZIP or town (a stray
  // tap, "I'm here now" from somewhere else): a second press saves it anyway.
  let sure = false;
  // "I'm here now" only on a phone or tablet: a laptop's location is the
  // office, never the customer's drive.
  const touchDevice = () => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (loading) return loading;
    loading = new Promise((ok, no) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET + 'leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LEAFLET + 'leaflet.js';
      s.onload = () => (window.L ? ok(window.L) : no(new Error('no map')));
      s.onerror = () => { loading = null; no(new Error('no map')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // Two numbers, or the spot in a full Google Maps address, read here; a short
  // shared link (maps.app.goo.gl) has to be followed, which the server does.
  // The same patterns as functions/pins.py COORDS: keep the two the same.
  const COORDS = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|center|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i,
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /^\s*\(?(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\)?\s*$/,
  ];
  function coordsIn(text) {
    const t = String(text || '').trim();
    for (const rx of COORDS) {
      const m = t.match(rx);
      if (m) return [+m[1], +m[2]];
    }
    return null;
  }
  const inWisconsin = p => p && p[0] >= 42.4 && p[0] <= 47.4 && p[1] >= -92.95 && p[1] <= -86.2;

  function modal() {
    let m = el('pinModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'pinModal';
      m.innerHTML = '<div class="modal pin-modal"><div class="modal-head"><h2 id="pinTitle">📍 Place the pin</h2>' +
        '<button class="modal-close" aria-label="Close">&times;</button></div><div class="modal-body" id="pinBody"></div></div>';
      m.querySelector('.modal-close').onclick = close;
      document.body.appendChild(m);
    }
    m.classList.add('active');
    return m;
  }
  function close() {
    const m = el('pinModal');
    if (m) m.classList.remove('active');
    if (map) { try { map.remove(); } catch (e) { /* gone already */ } }
    map = marker = layers = null;
    at = picked = null;
  }

  function say(words, bad) {
    const n = el('pinSay');
    if (n) { n.textContent = words || ''; n.classList.toggle('bad', !!bad); }
  }
  function drawSave() {
    const b = el('pinSave');
    if (b) {
      b.disabled = !picked || saving;
      b.textContent = saving ? 'Saving…' : !picked ? 'Tap the map first' : sure ? 'Save it anyway' : 'Save the pin';
    }
  }
  function put(p, centre) {
    picked = [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
    sure = false;
    if (map) {
      if (!marker) {
        marker = window.L.marker(picked, { draggable: true, icon: window.L.divIcon({ className: 'pin-mark', html: '📍', iconSize: [36, 36], iconAnchor: [18, 34] }) }).addTo(map);
        marker.on('dragend', () => { const ll = marker.getLatLng(); picked = [ll.lat, ll.lng]; sure = false; say('Pin moved.'); drawSave(); });
      } else marker.setLatLng(picked);
      if (centre) map.setView(picked, Math.max(map.getZoom(), 18));
    }
    say('Pin placed. Drag it onto the house if it’s off.');
    drawSave();
  }

  // Where to start looking: the record's own point, else the middle of its
  // ZIP or town (asked of OpenStreetMap, which finds those fine), else Madison.
  async function startAt(p) {
    if (p.lat != null && p.lng != null && inWisconsin([+p.lat, +p.lng])) return { centre: [+p.lat, +p.lng], zoom: 18 };
    for (const q of [p.zip && p.zip + ', WI', p.city && p.city + ', WI'].filter(Boolean)) {
      try {
        const j = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: q, countrycodes: 'us', format: 'json', limit: '1' }))
          .then(r => r.json());
        if (j && j.length && inWisconsin([+j[0].lat, +j[0].lon])) return { centre: [+j[0].lat, +j[0].lon], zoom: 15 };
      } catch (e) { /* the next, or Madison */ }
    }
    return { centre: MADISON, zoom: 11 };
  }

  // pin: { kind 'snow'|'job', id, name, address, street, city, zip, lat?, lng? }
  async function open(pin) {
    if (!pin || !pin.kind || !pin.id) return;
    const can = typeof ydCan === 'function' && ydCan(pin.kind === 'snow' ? 'snow' : 'jobs', 'change');
    if (!can) { showToast('Placing this pin needs ' + (pin.kind === 'snow' ? 'Snow' : 'Jobs') + ' access'); return; }
    if (map) close();
    at = pin; picked = null; saving = false; sure = false;
    modal();
    el('pinTitle').textContent = '📍 Place the pin: ' + (pin.name || 'this address');
    const gmaps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(pin.address || '');
    el('pinBody').innerHTML =
      '<p class="pin-addr"><b>' + esc(pin.address || '') + '</b></p>' +
      '<p class="hint">No map service knows this address. Tap where the house is, then drag the pin to fine-tune.</p>' +
      '<div class="pin-tools">' +
        '<button type="button" class="btn btn-sm pin-layer btn-filled" data-layer="photo" onclick="pinLayer(\'photo\')">🛰️ Satellite</button>' +
        '<button type="button" class="btn btn-sm pin-layer" data-layer="map" onclick="pinLayer(\'map\')">🗺️ Map</button>' +
        (navigator.geolocation && touchDevice() ? '<button type="button" class="btn btn-sm" onclick="pinHere()">📱 I’m here now</button>' : '') +
        '<a class="btn btn-sm" href="' + esc(gmaps) + '" target="_blank" rel="noopener">Look in Google Maps ↗</a>' +
      '</div>' +
      '<div id="pinMap" class="pin-map"><div class="pin-map-wait">Loading the map…</div></div>' +
      '<div class="pin-paste"><label class="field"><span class="label">Or paste a Google Maps link, or the two numbers</span>' +
        '<span class="pin-paste-row"><input id="pinLink" type="text" inputmode="url" autocomplete="off" placeholder="https://maps.app.goo.gl/… or 43.07, -89.40">' +
        '<button type="button" class="btn btn-sm" onclick="pinUseLink()">Use it</button></span></label></div>' +
      '<p class="pin-say" id="pinSay" role="status"></p>' +
      '<div class="field-actions pin-actions">' +
        '<button type="button" class="btn btn-filled" id="pinSave" disabled onclick="pinSave()">Tap the map first</button>' +
        '<button type="button" class="btn" onclick="pinClose()">Cancel</button></div>';
    let L;
    try { L = await loadLeaflet(); } catch (e) {
      const w = el('pinMap');
      if (w) w.innerHTML = '<div class="pin-map-wait">The map couldn’t load (no signal?). A Google Maps link pasted below still works.</div>';
      return;
    }
    if (at !== pin || !el('pinMap')) return;     // closed or another opened meanwhile
    const start = await startAt(pin);
    if (at !== pin || !el('pinMap')) return;
    el('pinMap').innerHTML = '';
    map = L.map('pinMap', { zoomControl: true, attributionControl: true }).setView(start.centre, start.zoom);
    layers = {
      photo: L.layerGroup([
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri' }),
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 20, maxNativeZoom: 19 }),
      ]),
      map: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' }),
    };
    layers.photo.addTo(map);
    map.on('click', e => put([e.latlng.lat, e.latlng.lng], false));
    if (pin.lat != null && pin.lng != null && inWisconsin([+pin.lat, +pin.lng])) put([+pin.lat, +pin.lng], false);
    // The window was drawn while the map was hidden: measure again once shown.
    setTimeout(() => { if (map) map.invalidateSize(); }, 60);
  }

  window.pinLayer = function (which) {
    if (!map || !layers || !layers[which]) return;
    Object.keys(layers).forEach(k => { if (map.hasLayer(layers[k])) map.removeLayer(layers[k]); });
    layers[which].addTo(map);
    document.querySelectorAll('#pinModal .pin-layer').forEach(b => b.classList.toggle('btn-filled', b.dataset.layer === which));
  };
  window.pinHere = function () {
    if (!navigator.geolocation) return;
    say('Finding where you are…');
    navigator.geolocation.getCurrentPosition(pos => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      if (!inWisconsin(p)) { say('Your phone puts you outside Wisconsin. Tap the map instead.', true); return; }
      put(p, true);
      if (pos.coords.accuracy > 60) say('Pin placed where your phone thinks you are (within about ' + Math.round(pos.coords.accuracy) + ' m). Drag it onto the house.');
    }, () => say('Your phone wouldn’t say where you are. Tap the map instead.', true),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
  window.pinUseLink = async function () {
    const t = (el('pinLink') || {}).value || '';
    if (!t.trim()) { say('Paste a link or two numbers first.', true); return; }
    let p = coordsIn(t);
    if (!p) {
      if (!/^https?:\/\//i.test(t.trim())) { say('No spot found in that. Copy the link from Google Maps, or type the two numbers.', true); return; }
      say('Opening the link…');
      try {
        const r = await window.YDClaude.post('/geo/link', { text: t.trim() });
        p = [r.lat, r.lng];
      } catch (e) { say(e.message || 'That link couldn’t be read.', true); return; }
    }
    if (!inWisconsin(p)) { say('That spot isn’t in Wisconsin. Check the link.', true); return; }
    put(p, true);
  };
  window.pinSave = async function () {
    if (!at || !picked || saving) return;
    const pin = at, spot = picked.slice();
    saving = true; drawSave(); say('');
    try {
      await window.YDClaude.post('/geo/pin', { kind: pin.kind, id: pin.id, lat: spot[0], lng: spot[1], sure: sure });
    } catch (e) {
      if (at !== pin) return;               // closed, or another opened, meanwhile
      saving = false;
      const words = e.message || 'The pin couldn’t be saved. Try again.';
      // Far from the address: asked once, then "Save it anyway".
      if (/miles from/.test(words) && picked && picked[0] === spot[0] && picked[1] === spot[1]) sure = true;
      drawSave();
      say(words, true);
      return;
    }
    saving = false;
    if (at === pin) close();
    showToast('📍 Pin placed — ' + (pin.name || 'it') + (pin.kind === 'snow' ? ' is on the snow route' : '’s miles are worked out again'));
    // A job's estimate works its miles out again from the pin (estimate.js).
    if (pin.kind === 'job' && window.YDEstimate && YDEstimate.retrip) YDEstimate.retrip(pin.id);
  };
  window.pinClose = close;

  // The card sent to the night run: the wish board's Overnight column, with
  // what to do written on it (boards.js does the move, with Undo).
  function toClaude(boardId, cardId) {
    if (!window.YDBoards || !YDBoards.sendToClaude) { showToast('Boards are still loading — try again in a moment'); return; }
    YDBoards.sendToClaude(boardId, cardId);
  }

  // From the push (#pins): the waiting pin straight away when there is one on
  // his to-dos (ones handed to Claude aren't his to place now), else Home,
  // where the cards are. A tap at launch waits a few seconds for the boards.
  window.openPins = async function () {
    const mine = () => (window.YDBoards && YDBoards.pinCards ? YDBoards.pinCards() : []).filter(x => x.boardId === 'todo');
    let list = mine();
    for (let i = 0; i < 10 && !list.length; i++) {
      await new Promise(r => setTimeout(r, 600));
      list = mine();
    }
    if (list.length === 1) { open(list[0].pinFor); return; }
    if (typeof switchTab === 'function') switchTab('home');
    if (!list.length) showToast('No addresses are waiting for a pin — it may be placed already');
  };

  window.YDPin = { open: open, toClaude: toClaude, coordsIn: coordsIn };
})();
