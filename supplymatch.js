// Which Supplies item a material written in words is -- "Road gravel: 2.25
// Tons" off a QuickBooks estimate, "Contours pavers" on an order list.
//
// Jonah (15 Oct 2026), on a job brought in from QuickBooks: "a fuckload of materials on his
// list that are literally in the supplies list it says 'no price' add to
// supplies". Names were matched only when every word was spelled the same
// and the unit was the item's own, or (on the order list) only when the
// whole name was identical. So:
//   - words are compared as words: plurals, punctuation, a one-letter typo
//     ("Countours") and the notes after a dash or in brackets don't matter;
//   - every item he picks for a name is remembered (settings/supplyAliases),
//     so his words ("leveling sand" -> Torpedo sand) find it by themselves
//     from then on, on every job;
//   - an item is joined by itself only when it is the ONE that fits (all the
//     words, a unit it is sold or measured in). When several fit (Contours
//     6cm or XL; three grass seed mixes) or only some of the words do, the
//     likely ones are offered as buttons -- "add to Supplies" is only for a
//     material nothing in Supplies is close to.
// Plain code: no Claude call.
(function () {
  'use strict';

  const STOP = ['the', 'a', 'an', 'and', 'of', 'for', 'with', 'in', 'x', 'per', 'or', 'to', 'approx', 'approximately', 'about'];
  // What a quantity is written in -- never a word of the name.
  const UNIT_WORDS = ['ton', 'tons', 'yard', 'yards', 'yd', 'yds', 'cu', 'cubic', 'sq', 'ft', 'square', 'feet', 'foot', 'lf',
    'linear', 'lb', 'lbs', 'pound', 'pounds', 'bag', 'bags', 'pc', 'pcs', 'piece', 'pieces', 'each', 'ea', 'roll', 'rolls',
    'pallet', 'pallets', 'gal', 'gallon', 'gallons', 'box', 'boxes', 'bundle', 'bundles'];

  function words(s) {
    return String(s || '').toLowerCase()
      .replace(/[”″"]/g, ' in ').replace(/[^a-z0-9.]+/g, ' ').split(' ')
      .map(w => w.replace(/\.+$/, '').replace(/^\.+/, ''))
      .filter(w => w && STOP.indexOf(w) === -1 && UNIT_WORDS.indexOf(w) === -1 && !/^\d+(\.\d+)?$/.test(w))
      .map(w => (w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w)) ? w.slice(0, -1) : w);
  }
  // The name without its notes: "Screened topsoil (1") — finish grading".
  const bare = name => String(name || '').replace(/\s+[—–-]\s.*$/, '').replace(/\([^)]*\)/g, ' ').replace(/:.*$/, '');
  const keyOf = name => words(bare(name)).join(' ');

  // Two words are the same word: equal, or (5+ letters) one letter added,
  // dropped, changed or swapped -- "countours" is "contours".
  function near(a, b) {
    if (a === b) return true;
    if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;                       // changed
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);   // swapped
    }
    const [l, s] = a.length > b.length ? [a, b] : [b, a];
    return l.slice(i + 1) === s.slice(i);                                       // added / dropped
  }

  // One unit, however it is written: "sq. ft" = "sf", "Tons" = "ton".
  function unitKey(u) {
    const s = String(u || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const table = [[/^(each|ea|pc|pcs|piece|pieces|unit|units)$/, 'each'], [/^(sq ?ft|sf|square f(ee|oo)t)$/, 'sqft'],
      [/^(lf|lin ?ft|linear f(ee|oo)t|ft|feet|foot)$/, 'lf'], [/^(tons?|t)$/, 'ton'],
      [/^(yards?|yds?|cu ?yds?|cubic yards?)$/, 'yd'], [/^(cu ?ft|cubic f(ee|oo)t)$/, 'cuft'], [/^(gal|gallons?)$/, 'gal'],
      [/^(lbs?|pounds?)$/, 'lb'], [/^(bags?)$/, 'bag'], [/^(rolls?)$/, 'roll']];
    const hit = table.find(([re]) => re.test(s));
    return hit ? hit[1] : s.replace(/s$/, '');
  }
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  // A material's quantity in what the item is measured in for estimates (its
  // takeoff unit when it covers an area, else what it is sold by): as it is,
  // or -- given in what the item is sold by -- times what one covers. Null
  // when the units don't meet ("100 lb" of something sold by the bag).
  function fitQty(m, it, pr) {
    const cov = num(it.coverage) > 0 ? num(it.coverage) : null;
    const sold = unitKey((pr && pr.per) || it.unit);
    const measured = cov ? unitKey(it.takeoffUnit) : sold;
    const u = unitKey(m.unit), q = num(m.qty);
    const unit = cov ? String(it.takeoffUnit || '') : String((pr && pr.per) || it.unit || '');
    if (u === measured || (!u && measured === 'each')) return { qty: q, unit: unit };
    if (cov && (u === sold || (!u && sold === 'each'))) return { qty: q === null ? null : Math.round(q * cov * 1000) / 1000, unit: unit };
    return null;
  }

  // The word is what the item IS, not what it goes with: "fabric" in
  // "Needle punch fabric 4.5 oz" (nothing but a size after it), not in
  // "Fabric pin" (a pin) -- so asked about fabric, the roll comes first.
  function isHeadOf(name, head) {
    const toks = String(name || '').toLowerCase().replace(/[”″"']/g, ' ').split(/[^a-z0-9.]+/).filter(Boolean)
      .map(w => (w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w)) ? w.slice(0, -1) : w);
    for (let i = 0; i < toks.length; i++) {
      if (!near(toks[i], head)) continue;
      const next = toks[i + 1];
      if (!next || /^\d/.test(next) || UNIT_WORDS.indexOf(next) !== -1 || /^(oz|in|mm|cm)$/.test(next)) return true;
    }
    return false;
  }

  let aliases = {};           // key (keyOf) -> supply id, his picks

  // { sure: {id, qty, unit, by} | null, options: [id, ...] } for a material
  // {name, qty, unit}. cat: YDSupplies.catalog(). skip: kinds never offered
  // (tools). Priced items only where prices can be seen.
  // opts.anyUnit: the order list, where a line's unit is only words in its
  // quantity -- the one item with all the words is it, whatever the unit.
  function match(m, cat, skip, opts) {
    const out = { sure: null, options: [] };
    if (!cat || !cat.items) return out;
    skip = skip || [];
    const seesPrices = cat.prices && Object.keys(cat.prices).length > 0;
    const usable = it => it && skip.indexOf(it.category) === -1 &&
      (!seesPrices || (cat.prices[it.id] && num(cat.prices[it.id].cents) > 0));
    const key = keyOf(m.name);
    const want = key ? key.split(' ') : [];
    if (!want.length) return out;
    const mine = aliases[key];
    if (mine && usable(cat.items[mine])) {
      const f = fitQty(m, cat.items[mine], cat.prices && cat.prices[mine]);
      out.sure = { id: mine, qty: f ? f.qty : null, unit: f ? f.unit : '', by: 'yours', unitOff: !f };
      return out;
    }
    const head = want[want.length - 1];          // what it is: sand, mulch, fabric, paver
    const scored = [];
    Object.values(cat.items).forEach(it => {
      if (!usable(it)) return;
      const have = words(it.name + ' ' + (it.also || ''));
      const hits = want.filter(w => have.some(h => near(w, h))).length;
      if (!hits) return;
      const score = hits / want.length;
      const sharesHead = have.some(h => near(head, h));
      if (score < 0.5 && !sharesHead) return;
      scored.push({ it: it, full: hits === want.length, score: score + (sharesHead ? 0.1 : 0) + (isHeadOf(it.name, head) ? 0.2 : 0),
                    extra: have.length - hits });
    });
    scored.sort((a, b) => (b.full - a.full) || (b.score - a.score) || (a.extra - b.extra) ||
      String(a.it.name).length - String(b.it.name).length);
    const full = scored.filter(x => x.full);
    if (full.length === 1) {
      const it = full[0].it, f = fitQty(m, it, cat.prices && cat.prices[it.id]);
      if (f) { out.sure = { id: it.id, qty: f.qty, unit: f.unit, by: 'name' }; return out; }
      if (opts && opts.anyUnit) { out.sure = { id: it.id, qty: null, unit: '', by: 'name', unitOff: true }; return out; }
    }
    out.options = scored.slice(0, 4).map(x => x.it.id);
    return out;
  }

  // His pick, kept for the next time these words come up.
  function remember(name, supplyId) {
    const key = keyOf(name);
    if (!key || !supplyId) return;
    if (aliases[key] === supplyId) return;
    aliases[key] = supplyId;
    // Every list showing these words takes the pick at once (app.js order list).
    document.dispatchEvent(new CustomEvent('yd-supply-aliases'));
    if (!window.YDDb || !(typeof ydCan === 'function' && ydCan('supplies', 'change'))) return;
    const patch = { map: {}, updatedAt: new Date().toISOString() };
    patch.map[key] = supplyId;
    Promise.resolve(window.YDDb.put('settings', 'supplyAliases', patch))
      .catch(e => console.warn('[match] pick not kept on the server:', e && (e.code || e.message)));
  }

  function load() {
    if (!window.YDDb || !(typeof ydCan === 'function' && ydCan('supplies', 'see'))) return;
    Promise.resolve(window.YDDb.get('settings', 'supplyAliases')).then(d => {
      aliases = Object.assign({}, (d && d.map) || {}, aliases);
      document.dispatchEvent(new CustomEvent('yd-supply-aliases'));
    }).catch(() => {});
  }
  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k === authKey) return;
    authKey = k;
    aliases = {};
    if (on) load();
  });

  window.YDMatch = { match: match, remember: remember, keyOf: keyOf, fitQty: fitQty, unitKey: unitKey, near: near };
})();
