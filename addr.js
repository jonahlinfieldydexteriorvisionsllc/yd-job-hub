// Addresses in their parts: street, city, state, ZIP (Jonah, 13 Oct 2026:
// "make addresses have fields for each part of the address"). One set of
// boxes for every form that takes an address -- suppliers, contacts,
// subcontracted properties -- laid out like the snow accounts' and the Job
// tab's, which already had them.
//
// The one-line `address` is still saved beside the parts: directions, the
// summaries, the server and every older screen read that, and a record saved
// before the parts existed is split into its boxes when it is opened.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const clean = s => String(s == null ? '' : s).trim();
  const ST = /^[A-Za-z]{2}$/, ZIP = /^\d{5}(-\d{4})?$/;

  // "123 Oak St, Madison, WI 53711" (or "…, Madison WI", "…, 53711") into
  // its parts. The last comma-part holds the state and/or ZIP; the one
  // before it is the town; the rest is the street.
  function split(line) {
    const bits = clean(line).split(',').map(clean).filter(Boolean);
    const out = { street: '', city: '', state: '', zip: '' };
    if (!bits.length) return out;
    let tail = bits.length > 1 ? bits[bits.length - 1] : '';
    const words = tail.split(/\s+/).filter(Boolean);
    if (tail && words.every(w => ST.test(w) || ZIP.test(w))) {
      words.forEach(w => { if (ZIP.test(w)) out.zip = w; else out.state = w.toUpperCase(); });
      bits.pop();
    } else {
      // "Madison WI 53711" with no comma before the state.
      const m = tail.match(/^(.*?)\s+([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
      if (m && m[1]) { bits[bits.length - 1] = m[1]; out.state = m[2].toUpperCase(); out.zip = m[3] || ''; }
    }
    if (bits.length > 1) out.city = bits.pop();
    out.street = bits.join(', ');
    return out;
  }

  // A record's parts: its own boxes when it has them, else its one line split.
  function partsOf(rec) {
    rec = rec || {};
    if (rec.street || rec.city || rec.zip) {
      return { street: clean(rec.street), city: clean(rec.city || rec.town), state: clean(rec.state).toUpperCase(), zip: clean(rec.zip) };
    }
    return split(rec.address);
  }

  // The one line everything else reads.
  function lineOf(p) {
    const tail = [clean(p.state).toUpperCase(), clean(p.zip)].filter(Boolean).join(' ');
    return [clean(p.street), clean(p.city), tail].filter(Boolean).join(', ');
  }

  // The boxes, ids `${prefix}Street` / City / State / Zip. The state starts
  // as WI on a blank address -- nearly everything is in Wisconsin.
  function fieldsHtml(prefix, rec, opts) {
    const p = partsOf(rec);
    const o = opts || {};
    const e = typeof esc === 'function' ? esc : (s => String(s));
    const box = (name, label, value, ph, extra) => '<div class="field"><span class="label">' + label + '</span>' +
      '<input id="' + prefix + name + '" value="' + e(value || '') + '" placeholder="' + e(ph) + '" autocomplete="off"' +
      (extra || '') + '></div>';
    return '<div class="addr-parts">' +
      box('Street', o.streetLabel || 'Street address', p.street, o.streetHint || 'e.g. 123 Oak St or N1234 County Rd X') +
      '<div class="grid sf-addr">' +
        box('City', 'City', p.city, 'Madison') +
        box('State', 'State', p.state || (p.street || p.city ? '' : 'WI'), 'WI', ' maxlength="2"') +
        box('Zip', 'ZIP', p.zip, '53711', ' inputmode="numeric" maxlength="10"') +
      '</div>' +
    '</div>';
  }

  // What the boxes hold: the parts and the line. A state left blank on an
  // address that has anything in it is Wisconsin.
  function read(prefix) {
    const v = name => clean((el(prefix + name) || {}).value);
    const p = { street: v('Street'), city: v('City'), state: v('State').toUpperCase(), zip: v('Zip') };
    if (!p.state && (p.street || p.city || p.zip)) p.state = 'WI';
    if (!p.street && !p.city && !p.zip) p.state = '';
    p.address = lineOf(p);
    return p;
  }

  // Fill boxes already on the page (index.html forms) from a record.
  function fill(prefix, rec) {
    const p = partsOf(rec);
    const set = (name, value) => { const i = el(prefix + name); if (i) i.value = value || ''; };
    set('Street', p.street); set('City', p.city);
    set('State', p.state || (p.street || p.city ? '' : 'WI')); set('Zip', p.zip);
  }

  // ------------------------------------------------ filled in for you
  //
  // Jonah (21 Oct 2026): "link google maps so when typing in an address it
  // can be autofilled"; (26 Oct 2026): "auto fill city state and zip
  // everywhere applicable after typing in address or give a dropdown to
  // select the address so it autofills".
  //
  // Every address typed in its boxes -- the Job tab's (#address, #city,
  // #state, #zip), every `${p}Street` / City / State / Zip set (contacts,
  // snow accounts, suppliers, sub properties, the bid/job card) and the
  // customer forms' `${p}street` / city / state / zip -- gets two helps, both
  // found by the boxes' ids (setOf), so a new form with boxes named that way
  // has them too:
  //  1. While the street is typed (four characters or more, with its
  //     number): up to five real addresses near Madison in a list under the
  //     box. A tap -- or the arrow keys and Enter -- fills the street, city,
  //     state and ZIP; Escape or a tap elsewhere closes it.
  //  2. Leaving a box typed in without picking one: the city, state and ZIP
  //     boxes still EMPTY are filled from the address. A box with anything in
  //     it is never changed (his typing wins), and Undo sits under the boxes.
  //     A street in more than one town nearby offers the towns as buttons.
  // A one-line address box marked data-addr="line" (a calendar entry, the
  // shop) gets the list; a pick puts the whole line in.
  //
  // Only the address being typed (and the area to look in) is sent anywhere.
  // The list comes straight from Photon -- OpenStreetMap's data, made for
  // search-as-you-type (Nominatim's own rules forbid that use) -- or the
  // server's copy of it (/geo/suggest) if the browser cannot reach it. The
  // town of an address comes from the server (geo.py): the US Census, which
  // knows the rural fire numbers OpenStreetMap misses and cannot be asked
  // from a browser; the map is the fallback. No signal: nothing shows, and
  // typing is never held up.
  const PHOTON = 'https://photon.komoot.io/api/';
  // Nearest Madison first, inside southern Wisconsin only (geo.py AREA): a
  // street of the same name in Orlando is never the one meant.
  const AREA_Q = '&lat=43.07&lon=-89.40&bbox=-90.8,42.4,-88.4,43.9&lang=en';
  const STATE_CODE = { wisconsin: 'WI', illinois: 'IL', iowa: 'IA', minnesota: 'MN', michigan: 'MI' };
  // "2 E Mai...", "N1234 County Rd X": the house (or fire) number first.
  const HOUSE_NO = /^\s*([NSEW]?\d+[A-Za-z]?)\s+\S/i;
  // The map says "2 East Main Street"; addresses are written "2 E Main St"
  // (QuickBooks, the Census, his own records).
  const SUFFIX = { street: 'St', avenue: 'Ave', drive: 'Dr', road: 'Rd', lane: 'Ln', court: 'Ct', circle: 'Cir',
    boulevard: 'Blvd', place: 'Pl', terrace: 'Ter', parkway: 'Pkwy', trail: 'Trl', highway: 'Hwy', crossing: 'Xing',
    square: 'Sq', point: 'Pt', cove: 'Cv', expressway: 'Expy', freeway: 'Fwy', crescent: 'Cres' };
  const DIRS = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };
  // Towns the map or the Census spell their own way.
  const TOWN_NAMES = { 'mc farland': 'McFarland', 'de forest': 'DeForest' };
  const WORD = { street: 'street', city: 'city', state: 'state', zip: 'ZIP' };
  // After a comma in the street box, a flat or unit is not a town.
  const UNIT = /^(apt|apartment|unit|ste|suite|lot|bldg|building|fl|floor|rm|room|#)/i;
  const escH = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'));

  function shortStreet(s) {
    const w = clean(s).replace(/\s+/g, ' ').split(' ').filter(Boolean);
    const at = w.length && /\d/.test(w[0]) ? 1 : 0;         // after the house number
    const dir = at < w.length ? DIRS[w[at].toLowerCase()] : '';
    // "East Main Street" -> E, but "North Street" is the street's name.
    if (dir && w.length - at >= 3) w[at] = dir;
    const last = w.length - 1, suf = last > at ? SUFFIX[w[last].toLowerCase()] : '';
    if (suf) w[last] = suf;
    return w.join(' ').replace(/\bCounty Road\b/g, 'County Rd').replace(/\bHighway\b/g, 'Hwy');
  }
  // "MADISON", "City of Madison" -> Madison.
  function tidyCity(s) {
    let t = clean(s).replace(/^(City|Village) of /i, '');
    if (t && t === t.toUpperCase()) t = t.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
    return TOWN_NAMES[t.toLowerCase()] || t;
  }
  const zip5 = z => (String(z || '').match(/\d{5}(?:-\d{4})?/) || [''])[0];
  const sameTown = (a, b) => tidyCity(a).toLowerCase() === tidyCity(b).toLowerCase();
  const plain = s => shortStreet(s).toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
  // The map's address is the one typed: the same, or the typed one with a
  // unit after it ("2 E Main St Apt 4"), or still being typed ("2 E Mai").
  function sameStreet(found, typed) {
    const f = plain(found), t = plain(typed);
    return !!t && (f === t || f.indexOf(t) === 0 || t.indexOf(f + ' ') === 0);
  }

  // The map's answer as addresses: in the US, on a road, the house typed (or
  // the road with the number typed kept on it, `exact` false), one each.
  function hitsOf(json, typed) {
    const m = HOUSE_NO.exec(typed || ''), no = m ? m[1] : '';
    const out = [], seen = {};
    ((json && json.features) || []).forEach(f => {
      const p = f.properties || {};
      if (String(p.countrycode || '').toUpperCase() !== 'US') return;
      const road = p.street || (p.osm_key === 'highway' ? p.name : '');
      if (!road) return;
      // Another house on the street is not the one being typed.
      if (no && p.housenumber && String(p.housenumber).toLowerCase() !== no.toLowerCase()) return;
      const h = { street: shortStreet(((p.housenumber || no) + ' ' + road).trim()),
                  city: tidyCity(p.city || p.town || p.village || p.locality),
                  state: STATE_CODE[String(p.state || '').toLowerCase()] || '', zip: zip5(p.postcode), exact: !!p.housenumber };
      const key = (h.street + '|' + h.city).toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push(h);
    });
    // The house itself before a road that only has the number typed on it.
    return out.filter(h => h.exact).concat(out.filter(h => !h.exact)).slice(0, 5);
  }

  // A fetch that a newer one in the same `slot` cancels, given up after `ms`.
  const slots = {};
  async function getJson(url, slot, ms) {
    if (slot && slots[slot]) slots[slot].abort();
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    if (slot) slots[slot] = ctl;
    const timer = ctl && ms ? setTimeout(() => ctl.abort(), ms) : 0;
    try {
      const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('The map said ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
      if (slot && slots[slot] === ctl) slots[slot] = null;
    }
  }
  const photonUrl = q => PHOTON + '?q=' + encodeURIComponent(q) + AREA_Q + '&limit=10';
  // The server is asked only by someone signed in to it, with signal.
  const serverOk = () => !!(navigator.onLine && window.YDClaude && window.YDClaude.post && window.YDAuth && window.YDAuth.user);

  // The boxes an address box belongs with, by their ids -- looked up afresh
  // each time: a form can be drawn again while an answer is on its way.
  function setOf(input) {
    if (!input || input.tagName !== 'INPUT' || !input.id) return null;
    const id = input.id;
    if (input.dataset && input.dataset.addr === 'line') return { key: id, line: id };
    if (['address', 'city', 'state', 'zip'].indexOf(id) !== -1 && el('address') && el('city') && el('zip')) {
      return { key: 'address', street: 'address', city: 'city', state: 'state', zip: 'zip' };
    }
    let m = /^(.+)(Street|City|State|Zip)$/.exec(id);
    if (m && el(m[1] + 'Street') && el(m[1] + 'City')) {
      return { key: m[1] + 'Street', street: m[1] + 'Street', city: m[1] + 'City', state: m[1] + 'State', zip: m[1] + 'Zip' };
    }
    m = /^(.+_)(street|city|state|zip)$/.exec(id);
    if (m && el(m[1] + 'street') && el(m[1] + 'city')) {
      return { key: m[1] + 'street', street: m[1] + 'street', city: m[1] + 'city', state: m[1] + 'state', zip: m[1] + 'zip' };
    }
    return null;
  }
  const box = (set, k) => (set[k] ? el(set[k]) : null);
  const valsOf = set => {
    const v = k => clean((box(set, k) || {}).value);
    return { street: v('street').replace(/\s+/g, ' '), city: v('city'), state: v('state').toUpperCase(), zip: v('zip') };
  };

  // ---- writing into the boxes, with Undo
  //
  // Each box is filled as typing would fill it: its own input (and change)
  // handlers run -- the Job tab's unsaved mark, a customer form's draft, the
  // estimate's trip. `filling` keeps our own listeners from taking that for
  // his typing.
  let filling = 0;
  const undos = {};            // set key -> { was, now, how } for the note shown
  function put(set, vals, how) {
    let rec = undos[set.key];
    if (!rec || !rec.live) rec = undos[set.key] = { was: {}, now: {}, live: true };
    filling++;
    try {
      Object.keys(vals).forEach(k => {
        const b = box(set, k), v = clean(vals[k]);
        if (!b || !v || clean(b.value) === v) return;
        if (!(k in rec.was)) rec.was[k] = b.value;
        rec.now[k] = v;
        b.value = v;
        b.dispatchEvent(new Event('input', { bubbles: true }));
        b.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } finally { filling--; }
    rec.how = how;
    if (!set.line && Object.keys(rec.now).length) showNote(set, rec);
  }
  function undo(set) {
    const rec = undos[set.key];
    runs[set.key] = (runs[set.key] || 0) + 1;          // an answer still coming is dropped
    clearNote(set);
    if (!rec) return;
    filling++;
    try {
      Object.keys(rec.now).forEach(k => {
        const b = box(set, k);
        if (!b || clean(b.value) !== rec.now[k]) return;   // changed since: his
        b.value = rec.was[k] || '';
        b.dispatchEvent(new Event('input', { bubbles: true }));
        b.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } finally { filling--; }
    ['street', 'city', 'state', 'zip'].forEach(k => { if (set[k]) typedIds[set[k]] = false; });
  }

  // ---- the line under the boxes: what was filled (Undo), or towns to pick
  function noteEl(set) {
    let n = el('addrNote_' + set.key);
    if (n) return n;
    const z = box(set, 'zip') || box(set, 'city');
    if (!z) return null;
    const after = z.closest('.grid') || z.closest('.field') || z;
    n = document.createElement('div');
    n.id = 'addrNote_' + set.key;
    n.className = 'addr-note';
    n.setAttribute('role', 'status');
    // Tapping Undo or a town keeps the box he is in (no focus moved, so no
    // second look-up starts from his leaving it).
    n.addEventListener('mousedown', ev => { if (ev.target.closest('button')) ev.preventDefault(); });
    after.insertAdjacentElement('afterend', n);
    return n;
  }
  function clearNote(set) {
    const n = el('addrNote_' + set.key);
    if (n) n.remove();
    if (undos[set.key]) undos[set.key].live = false;
  }
  function wordsFor(keys) {
    const w = ['street', 'city', 'state', 'zip'].filter(k => keys.indexOf(k) !== -1).map(k => WORD[k]);
    const s = w.length > 1 ? w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1] : (w[0] || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function showNote(set, rec) {
    const n = noteEl(set);
    if (!n) return;
    const keys = Object.keys(rec.now);
    const says = rec.how === 'road' ? 'Only the road is on the map — check the city and ZIP.'
      : wordsFor(keys) + ' filled in from ' + (rec.how === 'pick' ? 'the address picked.' : 'the address.');
    n.innerHTML = '<span>📍 ' + escH(says) + '</span><button type="button" class="link-btn addr-undo">Undo</button>';
    n.querySelector('.addr-undo').onclick = () => undo(set);
  }
  // More than one place the street could be: one button each.
  function showChoices(set, choices, cityKnown) {
    clearNote(set);
    const n = noteEl(set);
    if (!n) return;
    n.innerHTML = '<span>📍 ' + (cityKnown ? 'Which ZIP is it?' : 'Which town is it in?') + '</span>' +
      '<div class="addr-towns">' + choices.map((c, i) => '<button type="button" class="addr-town" data-i="' + i + '">' +
        (cityKnown ? '' : '<b>' + escH(c.city) + '</b> ') + escH(c.zip || '') + '</button>').join('') +
      '<button type="button" class="addr-town addr-none">None of these</button></div>';
    n.querySelectorAll('.addr-town[data-i]').forEach(b => {
      b.onclick = () => { clearNote(set); fillIn(set, choices[+b.dataset.i], 'found'); };
    });
    n.querySelector('.addr-none').onclick = () => clearNote(set);
  }

  // ---- 1. the list under the box as the street is typed
  const sugCache = {};          // what was typed -> its addresses (this visit)
  let sugTimer = 0, sugFor = '', sugBox = null, sugHits = [], sugAt = -1, sugSet = null;
  function closeSug() {
    clearTimeout(sugTimer);
    if (slots.sug) slots.sug.abort();
    const b = sugFor && el(sugFor);
    if (b) { b.removeAttribute('aria-expanded'); b.removeAttribute('aria-activedescendant'); }
    if (sugBox) sugBox.remove();
    sugBox = null; sugFor = ''; sugHits = []; sugAt = -1; sugSet = null;
  }
  function mark(i) {
    sugAt = i;
    if (!sugBox) return;
    sugBox.querySelectorAll('.addr-sug-btn').forEach((n, j) => n.classList.toggle('on', j === i));
    const b = el(sugFor);
    if (b) { if (i >= 0) b.setAttribute('aria-activedescendant', 'addrSug_' + i); else b.removeAttribute('aria-activedescendant'); }
  }
  function showSug(input, hits) {
    if (!hits.length || document.activeElement !== input) { closeSug(); return; }
    const fresh = !sugBox || sugFor !== input.id || !sugBox.isConnected;
    if (fresh) {
      closeSug();
      sugBox = document.createElement('div');
      sugBox.id = 'addrSug';
      sugBox.className = 'addr-sug';
      sugBox.setAttribute('role', 'listbox');
      // A tap's mousedown would take the focus from the box (and close the
      // list) before its click picked anything.
      sugBox.addEventListener('mousedown', ev => ev.preventDefault());
      sugBox.addEventListener('click', ev => {
        const btn = ev.target.closest('.addr-sug-btn');
        if (btn) pick(+btn.dataset.i);
      });
      const host = input.closest('.field, .pr-field') || input.parentNode;
      host.classList.add('addr-host');
      host.appendChild(sugBox);
      input.setAttribute('aria-controls', 'addrSug');
      input.setAttribute('aria-autocomplete', 'list');
    }
    sugFor = input.id; sugSet = setOf(input); sugHits = hits; sugAt = -1;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    sugBox.innerHTML = hits.map((h, i) => {
      const where = [h.city, [h.state, h.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return '<button type="button" class="addr-sug-btn" role="option" tabindex="-1" id="addrSug_' + i + '" data-i="' + i + '">' +
        '<b>' + escH(h.street) + '</b><span>' + escH(where) + (h.exact === false ? ' · the road — check the town' : '') + '</span></button>';
    }).join('');
    if (fresh) keepInSight(input);
  }
  // On a phone the keyboard covers the bottom half: the list is scrolled
  // into what can be seen, never so far that the box itself goes off the top.
  function keepInSight(input) {
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0, bottom = top + (vv ? vv.height : window.innerHeight);
    const r = sugBox.getBoundingClientRect(), ir = input.getBoundingClientRect();
    const by = Math.min(r.bottom - bottom + 8, ir.top - top - 8);
    if (by <= 0) return;
    const sc = input.closest('.modal-overlay');
    if (sc) sc.scrollTop += by; else window.scrollBy(0, by);
  }
  async function askSug(id, q) {
    let hits = null;
    try {
      hits = hitsOf(await getJson(photonUrl(q), 'sug', 8000), q);
    } catch (e) {
      if (e && e.name === 'AbortError') return;           // a newer one, or no answer in time
      // The browser could not reach the map: the server's copy of it.
      if (!serverOk()) return;
      try {
        const r = await window.YDClaude.post('/geo/suggest', { q: q });
        hits = ((r && r.hits) || []).map(h => ({ street: shortStreet(h.street), city: tidyCity(h.city),
                                                  state: h.state || '', zip: zip5(h.zip) }));
      } catch (e2) { return; }
    }
    sugCache[q] = hits;
    const b = el(id);
    if (b && document.activeElement === b && clean(b.value).replace(/\s+/g, ' ') === q) showSug(b, hits);
  }
  function queueSug(input) {
    clearTimeout(sugTimer);
    const q = clean(input.value).replace(/\s+/g, ' ');
    // Its number and a few letters: fewer is a guess at half the county.
    if (q.length < 4 || !/\d/.test(q) || !/[a-z]/i.test(q) || !navigator.onLine) { closeSug(); return; }
    if (sugCache[q]) { showSug(input, sugCache[q]); return; }
    const id = input.id;
    sugTimer = setTimeout(() => askSug(id, q), 350);
  }
  // A pick fills every box (he chose that address); a road the map has
  // without the house fills the street, and the town is then looked up for
  // the boxes still empty, the map's guess at it only when nothing is found.
  function pick(i) {
    const set = sugSet, h = sugHits[i];
    closeSug();
    if (!set || !h) return;
    if (set.line) { put(set, { line: lineOf(h) }, 'pick'); return; }
    if (set.street) typedIds[set.street] = false;
    if (h.exact === false) {
      put(set, { street: h.street }, 'pick');
      fillEmpty(set, h);
      return;
    }
    put(set, { street: h.street, city: h.city, state: h.state, zip: h.zip }, 'pick');
    if (!h.city || !h.zip) fillEmpty(set);
  }

  // ---- 2. leaving the boxes: the town, state and ZIP still empty
  const typedIds = {};          // box id -> typed in since it was entered
  const towns = {};             // look-up -> promise of [{city, state, zip}]
  const runs = {};              // set key -> the newest look-up (older answers dropped)
  async function lookTowns(v) {
    const state = v.state || 'WI';
    if (serverOk()) {
      try {
        if (v.city || v.zip) {
          // The Census with the town or ZIP typed: what is missing of the two.
          const r = await window.YDClaude.post('/geo/find', { street: v.street, city: v.city, state: state, zip: v.zip });
          if (r && r.found && r.geo) return [{ city: v.city ? '' : tidyCity(r.geo.town), state: state, zip: v.zip ? '' : zip5(r.geo.zip) }];
          if (r && r.found === false) return [];
        } else {
          const r = await window.YDClaude.post('/geo/towns', { street: v.street, state: state });
          const got = ((r && r.towns) || []).map(t => ({ city: tidyCity(t.city), state: t.state || state, zip: zip5(t.zip) }));
          if (got.length) return got;
          // None: a street too new for the Census may be on the map.
        }
      } catch (e) { /* signed out of the server, not allowed, or an older server: the map */ }
    }
    // Straight from the map: only the house itself, never a road's guess.
    const q = [v.street, v.city, [v.state, v.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const out = [], seen = {};
    hitsOf(await getJson(photonUrl(q), null, 8000), v.street).forEach(h => {
      if (!h.exact || !sameStreet(h.street, v.street) || !h.city) return;
      const c = { city: v.city ? '' : h.city, state: h.state || state, zip: v.zip ? '' : h.zip };
      const key = (c.city + '|' + c.zip).toLowerCase();
      if (seen[key] || (!c.city && !c.zip)) return;
      seen[key] = 1;
      out.push(c);
    });
    return out;
  }
  function townsOf(v) {
    const key = [v.street, v.city, v.zip, v.state].join('|').toLowerCase();
    if (!towns[key]) {
      // A failed look-up is not kept: the next one asks again.
      towns[key] = lookTowns(v).catch(() => null).then(r => { if (r === null) delete towns[key]; return r || []; });
    }
    return towns[key];
  }
  // An answer fits what is in the boxes now (he may have typed on meanwhile).
  const fits = (c, cur) => (!cur.city || !c.city || sameTown(cur.city, c.city)) &&
    (!cur.zip || !c.zip || cur.zip.slice(0, 5) === c.zip.slice(0, 5)) && (!cur.state || !c.state || cur.state === c.state);
  function fillIn(set, c, how) {
    const cur = valsOf(set), vals = {};
    ['city', 'state', 'zip'].forEach(k => { if (c[k] && !cur[k] && box(set, k)) vals[k] = c[k]; });
    if (Object.keys(vals).length) put(set, vals, how);
  }
  async function fillEmpty(set, road) {
    if (!box(set, 'street') || !box(set, 'city')) return;
    let v = valsOf(set);
    // A whole line typed in the street box: its town, state and ZIP go into
    // their own boxes -- only into empty ones, and only when none disagrees.
    if (v.street.indexOf(',') !== -1) {
      const p = split(v.street), moves = {};
      const unit = p.city && (/\d/.test(p.city) || UNIT.test(p.city));
      const clash = ['city', 'state', 'zip'].some(k => p[k] && v[k] && p[k].toLowerCase() !== v[k].toLowerCase());
      ['city', 'state', 'zip'].forEach(k => { if (p[k] && !v[k]) moves[k] = p[k]; });
      if (p.street && !unit && !clash && Object.keys(moves).length) {
        put(set, Object.assign({ street: p.street }, moves), 'found');
        v = valsOf(set);
      }
    }
    if (v.city && v.zip) return;
    if (v.street.length < 4 || !/\d/.test(v.street) || !navigator.onLine) {
      if (road) fillIn(set, road, 'road');
      return;
    }
    const run = runs[set.key] = (runs[set.key] || 0) + 1;
    const said = v.street;
    // "2 E Main St, Apt 4": the house is looked up without the flat.
    let found = await townsOf(Object.assign({}, v, { street: v.street.split(',')[0].trim() }));
    if (runs[set.key] !== run) return;
    const now = valsOf(set);
    if (!box(set, 'street') || now.street !== said) return;     // gone, or another address now
    found = found.filter(c => (c.city || c.zip) && fits(c, now));
    // A road picked from the list: the town it was near wins a tie.
    if (road && found.length > 1) {
      const near = found.filter(c => (c.zip && c.zip === road.zip) || (c.city && sameTown(c.city, road.city)));
      if (near.length === 1) found = near;
    }
    if (found.length === 1) fillIn(set, found[0], 'found');
    else if (found.length > 1) showChoices(set, found.slice(0, 4), !!now.city);
    else if (road) fillIn(set, road, 'road');
  }

  // ---- listening
  document.addEventListener('focusin', ev => { if (ev.target && ev.target.id) typedIds[ev.target.id] = false; });
  document.addEventListener('input', ev => {
    if (filling) return;
    const set = setOf(ev.target);
    if (!set) return;
    typedIds[ev.target.id] = true;
    // Typing in any of the boxes: what was said under them is old news.
    clearNote(set);
    if (ev.target.id === (set.line || set.street)) queueSug(ev.target);
  });
  document.addEventListener('focusout', ev => {
    const t = ev.target;
    if (sugFor && t && t.id === sugFor) setTimeout(() => { if (sugFor && document.activeElement !== el(sugFor)) closeSug(); }, 150);
    const set = setOf(t);
    if (!set || set.line || !typedIds[t.id]) return;
    typedIds[t.id] = false;
    fillEmpty(set);
  });
  // The list's keys, heard before the box's own (a form's Enter-to-save) and
  // the window's (Escape closes it): with the list open they are the list's.
  document.addEventListener('keydown', ev => {
    if (!sugBox || !sugFor || ev.isComposing || !ev.target || ev.target.id !== sugFor || !sugBox.isConnected) return;
    const n = sugHits.length;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      mark(ev.key === 'ArrowDown' ? (sugAt + 1 >= n ? 0 : sugAt + 1) : (sugAt <= 0 ? n - 1 : sugAt - 1));
    } else if (ev.key === 'Enter') {
      if (sugAt < 0) { closeSug(); return; }
      ev.preventDefault(); ev.stopPropagation();
      pick(sugAt);
    } else if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation();
      closeSug();
    } else if (ev.key === 'Tab') {
      closeSug();
    }
  }, true);

  window.YDAddr = { split: split, partsOf: partsOf, lineOf: lineOf, fieldsHtml: fieldsHtml, read: read, fill: fill,
                     shortStreet: shortStreet, setOf: setOf };
})();
