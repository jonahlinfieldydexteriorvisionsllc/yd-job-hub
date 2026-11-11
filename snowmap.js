// A snow property's map: the satellite photo with what to plow, shovel and
// salt marked on it, where the snow goes, the way to push it, and anything
// to watch for under the snow.
//
// Jonah (9 Nov 2026): "long term for snow removal i want birds eye maps of
// propeties we clear with marked out areas anything that gives the crew mor
// info and makes their job easier." Who draws them (11 Nov): "claudes draft
// plus my fix and then ill get in person measurements for each residential
// property." So: "🤖 Claude's first draft" asks the server (functions/
// snowmap.py) to mark the satellite photo; the draft lands on the map unsaved,
// he drags corners where they belong, deletes or draws more, and saves. Each
// area shows the size worked out from the map, with a box beside it for the
// size measured on site, which wins wherever a size is shown.
//
// Stored on the account's public record (crew read it; Snow change writes
// it): snowAccounts/{id}.siteMap {marks:[{id, kind, pts:[[lat,lng]], label,
// measured}], draft (Claude's, not yet saved by a person), at, by}. No
// prices are in it, so it is safe beside the address.
//
// Leaflet is loaded the first time a map opens (as pinplace.js does).
(function () {
  const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  // shape: area (polygon), line (an arrow, 2 points), point (1 point).
  const KINDS = {
    plow:   { name: 'Plow',          icon: '🚜', shape: 'area',  color: '#2f6fd6' },
    shovel: { name: 'Shovel',        icon: '🧹', shape: 'area',  color: '#2f8f5b' },
    salt:   { name: 'Salt',          icon: '🧂', shape: 'area',  color: '#e07b1a' },
    pile:   { name: 'Snow goes here', icon: '❄️', shape: 'area', color: '#e8eef5' },
    push:   { name: 'Push this way', icon: '➡️', shape: 'line',  color: '#f2c230' },
    hazard: { name: 'Watch for',     icon: '⚠️', shape: 'point', color: '#d32f2f' },
    start:  { name: 'Start here',    icon: '🏁', shape: 'point', color: '#7a4fd1' },
  };
  const ORDER = ['plow', 'shovel', 'salt', 'pile', 'push', 'hazard', 'start'];
  const MOST_MARKS = 40;

  let loading = null;
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

  // ---------------------------------------------------------------- sizes

  // Square feet of an area and feet of a line, from map points. A yard is
  // small enough to treat the ground as flat around its middle.
  function flat(pts) {
    const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    return pts.map(p => [p[1] * kx, p[0] * ky]);
  }
  function sqFt(pts) {
    if (!pts || pts.length < 3) return 0;
    const q = flat(pts);
    let s = 0;
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.round(Math.abs(s) / 2 * 10.7639);
  }
  function feet(pts) {
    if (!pts || pts.length < 2) return 0;
    const q = flat(pts);
    let s = 0;
    for (let i = 1; i < q.length; i++) s += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
    return Math.round(s * 3.28084);
  }
  const shapeOf = m => (KINDS[m.kind] || {}).shape;
  // The size shown for a mark: measured on site wins over the map's.
  function sizeWords(m) {
    const shape = shapeOf(m);
    if (shape === 'point') return '';
    const unit = shape === 'area' ? 'sq ft' : 'ft';
    const n = Number(m.measured);
    if (shape === 'area' && m.measured != null && m.measured !== '' && isFinite(n) && n > 0) return n.toLocaleString() + ' ' + unit + ' measured';
    const est = shape === 'area' ? sqFt(m.pts) : feet(m.pts);
    return est ? 'about ' + est.toLocaleString() + ' ' + unit + ' from the map' : '';
  }

  const account = id => (window.YDSnow && YDSnow.accounts && YDSnow.accounts()[id]) || null;
  // Firestore takes no list inside a list, so each corner is stored as
  // {lat, lng} and worked on here as [lat, lng]. A mark that isn't a known
  // kind with enough corners is left out, so one bad record can't break the
  // Snow tab or a storm stop.
  const ptOf = p => Array.isArray(p) ? [+p[0], +p[1]] : p && typeof p === 'object' ? [+p.lat, +p.lng] : null;
  function marksOf(a) {
    const list = a && a.siteMap && Array.isArray(a.siteMap.marks) ? a.siteMap.marks : [];
    return list.filter(m => m && KINDS[m.kind] && Array.isArray(m.pts)).map(m => ({
      id: String(m.id || ''), kind: m.kind, label: String(m.label || ''),
      measured: m.measured == null ? null : +m.measured,
      pts: m.pts.map(ptOf).filter(p => p && isFinite(p[0]) && isFinite(p[1])),
    })).filter(m => m.pts.length >= ({ area: 3, line: 2, point: 1 })[KINDS[m.kind].shape]);
  }
  const toStore = marks => marks.map(m => ({ id: m.id || newId(), kind: m.kind, label: String(m.label || '').slice(0, 60),
    measured: m.measured == null ? null : m.measured, pts: m.pts.map(p => ({ lat: p[0], lng: p[1] })) }));
  const newId = () => 'mk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const canEdit = () => typeof ydCan === 'function' && ydCan('snow', 'change');

  // One line for a stop or a card: what is marked, and the hazards by name
  // (readable with no signal, when the map itself won't load).
  function summary(a) {
    const marks = marksOf(a);
    if (!marks.length) return '';
    const count = {};
    marks.forEach(m => { count[m.kind] = (count[m.kind] || 0) + 1; });
    const bits = ORDER.filter(k => count[k] && k !== 'hazard' && k !== 'start' && k !== 'push')
      .map(k => KINDS[k].icon + ' ' + count[k] + ' ' + KINDS[k].name.toLowerCase());
    return bits.join(' · ');
  }
  function hazards(a) {
    return marksOf(a).filter(m => m.kind === 'hazard').map(m => m.label || 'Hazard');
  }

  // ---------------------------------------------------------------- the window

  // state: { id, edit, marks (working copy), dirty, draft, note, map, L,
  //          layer (drawn marks), drawing {kind, pts}, picked (mark id) }
  let st = null;

  function modal() {
    let m = el('smModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'smModal';
      m.innerHTML = '<div class="modal sm-modal"><div class="modal-head"><h2 id="smTitle">🗺️ Property map</h2>' +
        '<button class="modal-close" aria-label="Close" onclick="smClose()">&times;</button></div>' +
        '<div class="modal-body" id="smBody"></div></div>';
      document.body.appendChild(m);
    }
    m.classList.add('active');
    return m;
  }

  async function open(id, edit) {
    const a = account(id);
    if (!a) { showToast('That snow account isn’t loaded yet'); return; }
    if (a.lat == null || a.lng == null) { showToast('Place its map pin first: the map starts from the pin'); return; }
    if (st && st.map) { try { st.map.remove(); } catch (e) { /* gone */ } }
    edit = !!edit && canEdit();
    st = { id: id, edit: edit, marks: marksOf(a), dirty: false,
      draft: !!(a.siteMap && a.siteMap.draft), note: String((a.siteMap && a.siteMap.draft && a.siteMap.note) || ''), map: null, L: null, layer: null, drawing: null, picked: null, busy: false };
    modal();
    el('smTitle').textContent = '🗺️ ' + (a.name || 'Property map');
    el('smBody').innerHTML =
      '<p class="sm-addr">' + esc((window.YDSnow && YDSnow.addressShown ? YDSnow.addressShown(a) : a.address) || '') + '</p>' +
      (edit ? '<div class="sm-tools" id="smTools"></div>' : '') +
      '<div id="smMap" class="sm-map"><div class="pin-map-wait">Loading the map…</div></div>' +
      '<p class="sm-say" id="smSay" role="status"></p>' +
      '<div id="smKey" class="sm-key"></div>' +
      '<div id="smList" class="sm-list"></div>' +
      '<div class="field-actions sm-actions" id="smActions"></div>';
    drawTools(); drawList(); drawActions(); drawKey();
    const mine = st;
    let L;
    try { L = await loadLeaflet(); } catch (e) {
      if (st !== mine) return;
      const w = el('smMap');
      if (w) w.innerHTML = '<div class="pin-map-wait">The map couldn’t load (no signal?).' + (hazards(a).length ? ' Watch for: ' + esc(hazards(a).join(', ')) + '.' : '') + '</div>';
      return;
    }
    if (st !== mine || !el('smMap')) return;
    st.L = L;
    el('smMap').innerHTML = '';
    st.map = L.map('smMap', { zoomControl: true, attributionControl: true, tap: true }).setView([+a.lat, +a.lng], a.type === 'commercial' ? 19 : 20);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' }).addTo(st.map);
    st.layer = L.layerGroup().addTo(st.map);
    st.map.on('click', onMapClick);
    redraw(true);
    setTimeout(() => { if (st && st.map) st.map.invalidateSize(); }, 60);
  }

  function say(words, bad) {
    const n = el('smSay');
    if (n) { n.textContent = words || ''; n.classList.toggle('bad', !!bad); }
  }

  function drawTools() {
    const t = el('smTools');
    if (!t || !st) return;
    if (st.drawing) {
      const k = KINDS[st.drawing.kind];
      const n = st.drawing.pts.length;
      t.innerHTML = '<span class="sm-drawing">' + k.icon + ' Drawing: ' + esc(k.name) + ' · ' + n + ' corner' + (n === 1 ? '' : 's') + '</span>' +
        (k.shape === 'area' ? '<button type="button" class="btn btn-sm btn-filled" onclick="smFinish()"' + (n < 3 ? ' disabled' : '') + '>✓ Done</button>' : '') +
        '<button type="button" class="btn btn-sm" onclick="smUndoPoint()"' + (n ? '' : ' disabled') + '>↶ Undo corner</button>' +
        '<button type="button" class="btn btn-sm" onclick="smStopDrawing()">Cancel</button>';
      return;
    }
    t.innerHTML = '<span class="sm-tools-label">Draw:</span>' + ORDER.map(k =>
      '<button type="button" class="btn btn-sm sm-tool" style="--sm:' + KINDS[k].color + '" onclick="smDraw(\'' + k + '\')">' +
        KINDS[k].icon + ' ' + esc(KINDS[k].name) + '</button>').join('');
  }

  function drawActions() {
    const w = el('smActions');
    if (!w || !st) return;
    if (!st.edit) {
      w.innerHTML = (canEdit() ? '<button type="button" class="btn" onclick="smEditNow()">✏️ Change it</button>' : '') +
        '<button type="button" class="btn" onclick="smPrint()">🖨️ Print</button>' +
        '<button type="button" class="btn btn-filled" onclick="smClose()">Close</button>';
      return;
    }
    w.innerHTML =
      '<button type="button" class="btn" onclick="smDraft()"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? '🤖 Drawing…' : '🤖 Claude’s first draft') + '</button>' +
      '<button type="button" class="btn btn-filled" onclick="smSave()"' + (st.dirty || st.draft ? '' : ' disabled') + '>Save the map</button>' +
      '<button type="button" class="btn" onclick="smClose()">Close</button>';
  }

  function drawKey() {
    const w = el('smKey');
    if (!w || !st) return;
    const used = ORDER.filter(k => st.marks.some(m => m.kind === k));
    w.innerHTML = used.map(k => '<span class="sm-key-item"><i style="background:' + KINDS[k].color + '"></i>' + KINDS[k].icon + ' ' + esc(KINDS[k].name) + '</span>').join('');
  }

  function drawList() {
    const w = el('smList');
    if (!w || !st) return;
    if (!st.marks.length) {
      w.innerHTML = '<p class="hint">' + (st.edit
        ? 'Nothing marked yet. Press <b>🤖 Claude’s first draft</b>, or pick a kind above and tap its corners on the map.'
        : 'Nothing is marked on this map yet.') + '</p>';
      return;
    }
    const rows = ORDER.flatMap(k => st.marks.filter(m => m.kind === k)).map(m => {
      const k = KINDS[m.kind];
      const shape = k.shape;
      const sid = safeId(m.id);
      const size = sizeWords(m);
      if (!st.edit) {
        return '<div class="sm-row"><span class="sm-chip" style="--sm:' + k.color + '">' + k.icon + ' ' + esc(k.name) + '</span>' +
          '<span class="sm-row-label">' + esc(m.label || '') + '</span>' +
          (size ? '<span class="sm-size">' + esc(size) + '</span>' : '') + '</div>';
      }
      return '<div class="sm-row' + (st.picked === m.id ? ' picked' : '') + '" id="smRow_' + sid + '">' +
        '<button type="button" class="sm-chip" style="--sm:' + k.color + '" onclick="smPick(\'' + sid + '\')" title="Show its corners to drag">' + k.icon + ' ' + esc(k.name) + '</button>' +
        '<input type="text" class="sm-label-in" maxlength="60" placeholder="' + (m.kind === 'hazard' ? 'What is it? e.g. Hidden curb' : 'Name (optional)') + '" value="' + esc(m.label || '') + '" oninput="smLabel(\'' + sid + '\', this.value)">' +
        (shape !== 'area' ? (shape === 'line' ? '<span class="sm-size" id="smSize_' + sid + '">' + esc(size) + '</span>' : '') :
          '<span class="sm-size" id="smSize_' + sid + '">' + esc(size) + '</span>' +
          '<label class="sm-measure">Measured<input type="number" inputmode="decimal" min="0" step="any" value="' + esc(m.measured != null ? String(m.measured) : '') + '" oninput="smMeasure(\'' + sid + '\', this.value)">' +
          'sq ft</label>') +
        '<button type="button" class="btn btn-sm sm-del" onclick="smDelete(\'' + sid + '\')" aria-label="Delete this mark">🗑</button>' +
        '</div>';
    });
    w.innerHTML = (st.edit && st.draft ? '<p class="sm-draft-note">🤖 Claude’s draft: check every shape, drag corners onto the real edges (tap a kind in the list to show its corners), then Save.' + (st.note ? ' ' + esc(st.note) : '') + '</p>' : '') + rows.join('');
  }

  // Every mark drawn again (cheap: a handful of shapes).
  function redraw(fit) {
    if (!st || !st.map || !st.L) return;
    const L = st.L;
    st.layer.clearLayers();
    const all = [];
    st.marks.forEach(m => {
      const k = KINDS[m.kind];
      if (!k || !m.pts || !m.pts.length) return;
      all.push.apply(all, m.pts);
      const picked = st.picked === m.id;
      let shape;
      if (k.shape === 'area') {
        shape = L.polygon(m.pts, { color: m.kind === 'pile' ? '#5b6b7d' : k.color, weight: picked ? 4 : 2, fillColor: k.color, fillOpacity: m.kind === 'pile' ? 0.55 : 0.35, dashArray: m.kind === 'pile' ? '6 4' : null });
      } else if (k.shape === 'line') {
        shape = L.polyline(m.pts, { color: k.color, weight: picked ? 7 : 5 });
        arrowHead(m);
      } else {
        shape = L.marker(m.pts[0], { icon: L.divIcon({ className: 'sm-pt sm-pt-' + m.kind, html: k.icon, iconSize: [30, 30], iconAnchor: [15, 15] }) });
      }
      if (m.label) shape.bindTooltip(esc(m.label), { permanent: m.kind === 'hazard' || m.kind === 'start', direction: 'top', className: 'sm-tip' });
      if (st.edit) shape.on('click', ev => { if (st.drawing) return; L.DomEvent.stopPropagation(ev); pick(m.id); });
      shape.addTo(st.layer);
      if (picked && st.edit) handles(m);
    });
    if (st.drawing) {
      const k = KINDS[st.drawing.kind];
      const pts = st.drawing.pts;
      if (pts.length > 1) L.polyline(pts, { color: k.color, weight: 3, dashArray: '5 5' }).addTo(st.layer);
      pts.forEach((p, i) => L.circleMarker(p, { radius: i === 0 ? 8 : 6, color: '#fff', weight: 2, fillColor: k.color, fillOpacity: 1 })
        .on('click', ev => { L.DomEvent.stopPropagation(ev); if (i === 0 && pts.length >= 3) finish(); })
        .addTo(st.layer));
    }
    if (fit && all.length) {
      try { st.map.fitBounds(L.latLngBounds(all).pad(0.25), { maxZoom: 20 }); } catch (e) { /* keep the view */ }
    }
  }
  // The arrow's point at the end of a push line, turned the way it goes on
  // screen.
  function arrowHead(m) {
    const L = st.L;
    const a = st.map.latLngToLayerPoint(m.pts[0]), b = st.map.latLngToLayerPoint(m.pts[m.pts.length - 1]);
    const deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    L.marker(m.pts[m.pts.length - 1], { interactive: false, icon: L.divIcon({ className: 'sm-arrow',
      html: '<span style="transform:rotate(' + deg.toFixed(0) + 'deg)">➤</span>', iconSize: [28, 28], iconAnchor: [14, 14] }) }).addTo(st.layer);
  }
  // Drag a picked mark's corners to fix it.
  function handles(m) {
    const L = st.L;
    m.pts.forEach((p, i) => {
      const h = L.marker(p, { draggable: true, icon: L.divIcon({ className: 'sm-handle', iconSize: [22, 22], iconAnchor: [11, 11] }) });
      h.on('drag', () => {
        const ll = h.getLatLng();
        m.pts[i] = [Math.round(ll.lat * 1e6) / 1e6, Math.round(ll.lng * 1e6) / 1e6];
      });
      h.on('dragend', () => { changed(); setTimeout(() => redraw(false), 0); });
      h.addTo(st.layer);
    });
  }
  function pick(id) {
    if (!st) return;
    st.picked = st.picked === id ? null : id;
    redraw(false); drawList();
    const m = st.marks.find(x => x.id === st.picked);
    if (m) say(shapeOf(m) === 'point' ? 'Drag it where it belongs.' : 'Drag the white corners onto the real edges.');
    else say('');
  }
  function changed() {
    if (!st) return;
    st.dirty = true;
    drawActions(); drawKey();
    // The sizes follow a corner dragged, without redrawing the boxes (the
    // cursor may be in one).
    st.marks.forEach(m => { const s = el('smSize_' + safeId(m.id)); if (s) s.textContent = sizeWords(m); });
  }

  function onMapClick(e) {
    if (!st || !st.edit || !st.drawing) return;
    const p = [Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6];
    const shape = KINDS[st.drawing.kind].shape;
    st.drawing.pts.push(p);
    if (shape === 'point' || (shape === 'line' && st.drawing.pts.length === 2)) { finish(); return; }
    drawTools(); redraw(false);
    say(shape === 'line' ? 'Now tap where the snow should end up.' : 'Keep tapping corners. Tap the first corner, or ✓ Done, to close it.');
  }
  function finish() {
    if (!st || !st.drawing) return;
    const d = st.drawing;
    const need = { area: 3, line: 2, point: 1 }[KINDS[d.kind].shape];
    if (d.pts.length < need) return;
    if (st.marks.length >= MOST_MARKS) { say('That’s as many marks as one map holds.', true); st.drawing = null; drawTools(); redraw(false); return; }
    const m = { id: newId(), kind: d.kind, pts: d.pts.slice(), label: '', measured: null };
    st.marks.push(m);
    st.drawing = null;
    changed(); drawTools(); redraw(false); drawList();
    say(m.kind === 'hazard' ? 'Say what it is in the box below.' : 'Added. Draw another, or Save the map.');
    if (m.kind === 'hazard') { const r = el('smRow_' + safeId(m.id)); const i = r && r.querySelector('input'); if (i) i.focus(); }
  }

  async function close() {
    if (st && st.edit && st.dirty) {
      const ok = await ydConfirm('Close without saving the changes to this map?', { ok: 'Close without saving', title: 'Not saved' });
      if (!ok) return;
    }
    const m = el('smModal');
    if (m) m.classList.remove('active');
    document.body.classList.remove('sm-print');
    if (st && st.map) { try { st.map.remove(); } catch (e) { /* gone */ } }
    st = null;
  }

  // ---------------------------------------------------------------- buttons

  window.smDraw = function (kind) {
    if (!st || !st.edit || !KINDS[kind]) return;
    st.picked = null;
    st.drawing = { kind: kind, pts: [] };
    drawTools(); redraw(false);
    const shape = KINDS[kind].shape;
    say(shape === 'point' ? 'Tap the map where it is.' : shape === 'line' ? 'Tap where the push starts.' : 'Tap each corner on the map, in order around it.');
  };
  window.smFinish = finish;
  window.smUndoPoint = function () { if (st && st.drawing) { st.drawing.pts.pop(); drawTools(); redraw(false); } };
  window.smStopDrawing = function () { if (st) { st.drawing = null; drawTools(); redraw(false); say(''); } };
  window.smPick = pick;
  window.smLabel = function (id, v) {
    const m = st && st.marks.find(x => safeId(x.id) === id);
    if (!m) return;
    m.label = String(v || '').slice(0, 60);
    st.dirty = true; drawActions();
    clearTimeout(st.labelTimer);
    st.labelTimer = setTimeout(() => redraw(false), 600);
  };
  window.smMeasure = function (id, v) {
    const m = st && st.marks.find(x => safeId(x.id) === id);
    if (!m) return;
    const n = parseFloat(v);
    m.measured = v === '' || !isFinite(n) || n <= 0 ? null : Math.round(n * 10) / 10;
    changed();
  };
  window.smDelete = function (id) {
    if (!st) return;
    const i = st.marks.findIndex(x => safeId(x.id) === id);
    if (i < 0) return;
    const gone = st.marks.splice(i, 1)[0];
    if (st.picked === gone.id) st.picked = null;
    changed(); redraw(false); drawList();
    const s = st;
    showUndo('Mark taken off', () => {
      if (st !== s) return;
      st.marks.splice(i, 0, gone);
      changed(); redraw(false); drawList();
    });
  };
  window.smEditNow = function () { if (st) open(st.id, true); };
  window.smClose = close;
  window.smPrint = function () {
    document.body.classList.add('sm-print');
    setTimeout(() => { window.print(); setTimeout(() => document.body.classList.remove('sm-print'), 500); }, 300);
  };

  window.smDraft = async function () {
    if (!st || !st.edit || st.busy) return;
    const s = st;
    if (s.marks.length) {
      const ok = await ydConfirm('Replace what is on this map with Claude’s draft? Nothing is saved until you press Save.', { ok: 'Replace it', title: 'Claude’s first draft' });
      if (!ok || st !== s) return;
    }
    s.busy = true; drawActions(); say('Claude is looking at the satellite photo… (about half a minute)');
    let r;
    try {
      r = await window.YDClaude.post('/geo/map-draft', { id: s.id });
    } catch (e) {
      if (st !== s) return;
      s.busy = false; drawActions(); say(e.message || 'Claude couldn’t draft it. Draw it by hand.', true);
      return;
    }
    if (st !== s) return;
    s.busy = false;
    s.marks = (r.marks || []).map(m => ({ id: newId(), kind: m.kind, pts: m.pts, label: m.label || '', measured: null }));
    s.draft = true; s.note = r.note || ''; s.picked = null; s.drawing = null; s.dirty = true;
    drawTools();
    drawActions(); drawKey(); drawList(); redraw(true);
    say(s.marks.length ? 'Claude’s draft is on the map. Fix it, then Save.' : (r.note || 'Nothing could be made out. Draw it by hand.'), !s.marks.length);
  };

  window.smSave = function () {
    if (!st || !st.edit) return;
    const s = st;
    const who = (window.YDAuth && YDAuth.user) || {};
    const rec = { siteMap: { marks: toStore(s.marks), draft: false, note: null, at: new Date().toISOString(), by: who.uid || null } };
    // Offline first: the write is queued on this device and sent when there
    // is a signal (never awaited).
    Promise.resolve(window.YDDb.put('snowAccounts', s.id, rec)).catch(e => showToast('The map didn’t save: ' + (e.message || e)));
    // The account list on this device follows at once.
    const a = account(s.id);
    if (a) a.siteMap = rec.siteMap;
    s.dirty = false; s.draft = false;
    showToast('🗺️ Map saved — the crew see it on the storm stop');
    open(s.id, false);
    if (window.YDSnow && YDSnow.render) YDSnow.render();
  };

  // Claude's first draft for every placed account with no map yet, one after
  // another, each saved as a draft (marked "Claude's draft — check it") for
  // him to fix. His tap starts it; it stops on the first refusal (the day's
  // limit, the spending cap).
  window.smDraftAll = async function () {
    if (!canEdit() || !window.YDSnow) return;
    const list = Object.entries(YDSnow.accounts()).filter(([, a]) => a.active !== false && a.lat != null && !marksOf(a).length);
    if (!list.length) { showToast('Every placed account has a map'); return; }
    const ok = await ydConfirm('Have Claude draw a first draft for ' + list.length + ' propert' + (list.length === 1 ? 'y' : 'ies') + '? Each is saved as “Claude’s draft — check it” for you to fix. About 2¢ each.', { ok: 'Draft them', title: 'Property maps' });
    if (!ok) return;
    let done = 0;
    for (const [id] of list) {
      showToast('🤖 Drafting map ' + (done + 1) + ' of ' + list.length + '…');
      try {
        const r = await window.YDClaude.post('/geo/map-draft', { id: id });
        if (!(r.marks || []).length) continue;
        const rec = { siteMap: { marks: toStore(r.marks.map(m => ({ kind: m.kind, pts: m.pts, label: m.label || '', measured: null }))),
          draft: true, note: r.note || '', at: new Date().toISOString(), by: 'claude' } };
        Promise.resolve(window.YDDb.put('snowAccounts', id, rec)).catch(e => showToast('A map draft didn’t save: ' + (e.message || e)));
        const a = account(id); if (a) a.siteMap = rec.siteMap;
        done++;
      } catch (e) {
        showToast('Stopped after ' + done + ': ' + (e.message || 'Claude couldn’t be reached'));
        if (YDSnow.render) YDSnow.render();
        return;
      }
    }
    showToast('🗺️ ' + done + ' map draft' + (done === 1 ? '' : 's') + ' ready to check');
    if (YDSnow.render) YDSnow.render();
  };

  // What the Snow card and a storm stop show for an account's map.
  function cardLine(id, a) {
    const marks = marksOf(a);
    const sid = safeId(id);
    if (!marks.length) {
      return canEdit() && a.lat != null
        ? '<button type="button" class="btn btn-sm sm-open" onclick="smOpen(\'' + sid + '\', true)">🗺️ Draw its map</button>' : '';
    }
    const draft = a.siteMap && a.siteMap.draft;
    // Claude's guess isn't the crew's to follow until Jonah has checked it.
    if (draft && !canEdit()) return '';
    return '<div class="sm-line">' +
      '<button type="button" class="btn btn-sm sm-open" onclick="smOpen(\'' + sid + '\', ' + (draft && canEdit() ? 'true' : 'false') + ')">🗺️ Property map</button>' +
      (draft ? '<span class="snow-tag hold">Claude’s draft — check it</span>' : '') +
      '<span class="sm-line-words">' + esc(summary(a)) + '</span>' +
      (hazards(a).length ? '<span class="sm-line-haz">⚠️ ' + esc(hazards(a).join(' · ')) + '</span>' : '') +
      '</div>';
  }
  function draftAllLine() {
    if (!canEdit() || !window.YDSnow) return '';
    const n = Object.values(YDSnow.accounts()).filter(a => a.active !== false && a.lat != null && !marksOf(a).length).length;
    if (!n) return '';
    return '<div class="sm-all">🗺️ ' + n + ' propert' + (n === 1 ? 'y has' : 'ies have') + ' no map yet.' +
      ' <button type="button" class="btn btn-sm" onclick="smDraftAll()">🤖 Have Claude draft them</button></div>';
  }

  window.smOpen = function (id, edit) { open(id, edit); };
  window.YDSnowMap = { open: open, cardLine: cardLine, draftAllLine: draftAllLine, summary: summary, hazards: hazards, sqFt: sqFt, feet: feet, KINDS: KINDS };
})();
