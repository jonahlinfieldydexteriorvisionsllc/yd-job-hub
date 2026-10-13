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

  window.YDAddr = { split: split, partsOf: partsOf, lineOf: lineOf, fieldsHtml: fieldsHtml, read: read, fill: fill };
})();
