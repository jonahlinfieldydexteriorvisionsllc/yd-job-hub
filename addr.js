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

  // ------------------------------------------------ filled in as you type
  //
  // Jonah (21 Oct 2026): "link google maps so when typing in an address it
  // can be autofilled". Typing a street (five letters or more) brings up to
  // five addresses near Madison under the box (the server's /geo/suggest,
  // functions/geo.py) -- one tap fills the street, city, state and ZIP.
  // Typing on by hand is never in the way: the list only offers, and goes
  // with Escape, a tap elsewhere, or no signal. Every street box of the
  // address forms (`${prefix}Street`) and the Job tab's (#address, #city,
  // #state, #zip).
  const boxesOf = input => {
    if (!input || input.tagName !== 'INPUT') return null;
    if (input.id === 'address' && el('city') && el('zip')) return { street: input, city: el('city'), state: el('state'), zip: el('zip') };
    const m = /^(.+)Street$/.exec(input.id || '');
    return m && el(m[1] + 'City') ? { street: input, city: el(m[1] + 'City'), state: el(m[1] + 'State'), zip: el(m[1] + 'Zip') } : null;
  };
  const asked = {};           // what was typed -> its suggestions (this session)
  let sugTimer = 0, sugFor = null, sugBox = null;
  function closeSug() {
    clearTimeout(sugTimer);
    if (sugBox) sugBox.remove();
    sugBox = null; sugFor = null;
  }
  function showSug(b, hits) {
    closeSug();
    if (!hits.length || document.activeElement !== b.street) return;
    sugFor = b;
    sugBox = document.createElement('div');
    sugBox.className = 'addr-sug';
    sugBox.setAttribute('role', 'listbox');
    const e = typeof esc === 'function' ? esc : (s => String(s));
    sugBox.innerHTML = hits.map((h, i) => '<button type="button" class="addr-sug-btn" data-i="' + i + '"><b>' + e(h.street) + '</b>' +
      '<span>' + e([h.city, [h.state, h.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')) + '</span></button>').join('');
    // Picked before the box loses its focus (a tap's mousedown), so the pick is never lost.
    sugBox.addEventListener('mousedown', ev => ev.preventDefault());
    sugBox.addEventListener('click', ev => {
      const btn = ev.target.closest('.addr-sug-btn');
      if (btn) pick(b, hits[+btn.dataset.i]);
    });
    const field = b.street.closest('.field') || b.street.parentNode;
    field.parentNode.insertBefore(sugBox, field.nextSibling);
  }
  // The pick fills the boxes as typing would (their own oninput runs: the
  // Job tab's "unsaved" mark, a form's checks).
  function pick(b, h) {
    closeSug();
    if (!h) return;
    [['street', h.street], ['city', h.city], ['state', h.state], ['zip', h.zip]].forEach(([k, v]) => {
      const box = b[k];
      if (!box || !v) return;
      box.value = v;
      box.dataset.addrFilled = '1';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      delete box.dataset.addrFilled;
    });
  }
  async function ask(b, q) {
    if (asked[q]) { showSug(b, asked[q]); return; }
    let r = null;
    try { r = await window.YDClaude.post('/geo/suggest', { q: q }); } catch (e) { return; }
    asked[q] = (r && r.hits) || [];
    if (b.street.value.trim() === q) showSug(b, asked[q]);
  }
  document.addEventListener('input', ev => {
    const b = boxesOf(ev.target);
    if (!b || ev.target.dataset.addrFilled) return;
    clearTimeout(sugTimer);
    const q = b.street.value.replace(/\s+/g, ' ').trim();
    if (q.length < 5 || !/[a-z]/i.test(q) || !navigator.onLine || !window.YDClaude || !window.YDClaude.available ||
        !window.YDClaude.available()) { closeSug(); return; }
    sugTimer = setTimeout(() => ask(b, q), 400);
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && sugBox) closeSug(); }, true);
  document.addEventListener('focusout', ev => {
    if (sugFor && ev.target === sugFor.street) setTimeout(() => { if (sugFor && document.activeElement !== sugFor.street) closeSug(); }, 150);
  });

  window.YDAddr = { split: split, partsOf: partsOf, lineOf: lineOf, fieldsHtml: fieldsHtml, read: read, fill: fill };
})();
