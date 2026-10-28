// Supplies: what we buy, who we buy it from, where it is once you get there --
// and, for Jonah only, what it costs.
//
// The question this answers for the crew is the one asked from the truck:
// "where do I get seed?" -- and the answer they need is not just "MDS" but
// "MDS, the front building, ask at the counter". So every item says which
// supplier, and where at that supplier; every supplier carries its address
// (one tap to directions), phone (one tap to call) and hours.
//
// Three collections, because Firestore cannot hide one field of a document
// from the crew -- the same split as the snow accounts:
//   vendors/{id}       name, address, phone, hours, notes, email,     everyone
//                      website, buyWays [online|shipped|phone|far], leadTime
//   supplies/{id}      name, also, vendorId, sku, where, unit, notes, everyone
//                      link (the product's own page)
//   supplyPrices/{id}  (same id as the item) cents, per, year, asOf,
//                      priceNotes, history [{year, cents, per, asOf}] owner only
//
// Estimates are priced from these (pricing.js). For that an item also says
// what kind of material it is (category -- which carries the default markup
// and waste), how a takeoff becomes a purchase (a roll of fabric "covers" 750
// sq ft: takeoffUnit 'sq ft', coverage 750), whether it comes on a pallet
// (a delivery surcharge) and whether it is a special order (non-returnable).
// Its price record may carry its own markupPct / wastePct, and clientCents
// for the odd thing sold to the customer at a fixed price each.
//
// Prices go up every year. A price entered for a NEW year moves the old one
// into the history, so "up 6% on last year" can be shown; a price changed
// within the same year is a correction and simply replaces it. The whole
// list goes out and comes back as a spreadsheet: download it, change the
// prices and the year, paste it back. A downloaded list carries each item's
// id, so every row comes back to exactly the item it left.

(function () {
  'use strict';

  let items = {};
  let vendors = {};
  let prices = {};
  let pricesReady = false;  // the server has answered, not just this device's cache
  let unsubs = [];
  let search = '';
  let shown = '';           // supplier filter: '' everyone, '-' no supplier, else a vendor id
  let editing = null;       // { kind: 'item' | 'vendor', id, priceShown }
  let plan = null;          // a checked import waiting for "Save these changes"
  let planVendor = null;    // the supplier a price list is for, when opened from its card

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  // Prices: the owner, or an admin given Supplies. Adding and editing:
  // Supplies "change". Everyone signed in sees what we use and where.
  const seesPrices = () => ydCan('supplies', 'see');
  const edits = () => ydCan('supplies', 'change');
  const signedIn = () => !!(window.YDAuth && window.YDAuth.user && window.YDDb);
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const norm = s => String(s || '').toLowerCase();
  // For matching names typed slightly differently: "M.D.S.", "M D S" and
  // "mds" are one supplier; "Pavers - Holland" and "Pavers — Holland" one item.
  const key = s => norm(s).replace(/[^a-z0-9]+/g, '');
  // One collator, made once: localeCompare makes one per comparison, and a
  // sort of 900 items is ~9,000 comparisons. Numbers in a name sort as
  // numbers (15 Oct 2026): #8 stone before #57, a 6x9 paver before a 12x12.
  const collate = new Intl.Collator(undefined, { numeric: true }).compare;
  const byName = (a, b) => collate(String(a.name || ''), String(b.name || ''));
  const thisYear = () => new Date().getFullYear();
  const two = n => (n < 10 ? '0' : '') + n;
  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, ''); }

  // ------------------------------------------------------------------ money

  // "$1,234.50", "45", " 89.99 " -> cents. Empty -> null (no price given);
  // anything else -> NaN, so a typo is refused instead of saved as $0.
  function parseCents(s) {
    const t = String(s == null ? '' : s).replace(/[$,\s]/g, '');
    if (!t) return null;
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
    return Math.round(parseFloat(t) * 100);
  }
  function fmtCents(c) {
    if (typeof c !== 'number' || !isFinite(c)) return '';
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function validYear(s) {
    const y = parseInt(s, 10);
    return y >= 2000 && y <= 2100 ? y : null;
  }
  // Percentage change, or null when there is nothing fair to compare with.
  function change(now, before) {
    if (typeof now !== 'number' || typeof before !== 'number' || !(before > 0)) return null;
    return (now - before) / before * 100;
  }
  function changeHtml(p) {
    if (p == null) return '';
    const r = Math.round(p * 10) / 10;
    if (r === 0) return '<span class="sup-chg same">same as last year</span>';
    return '<span class="sup-chg ' + (r > 0 ? 'up' : 'down') + '">' + (r > 0 ? '▲ ' : '▼ ') +
      Math.abs(r).toFixed(1) + '%</span>';
  }
  // The price this one replaced: the newest year in the history.
  const lastYears = p => (p && Array.isArray(p.history) && p.history.length ? p.history[0] : null);

  // What a price record becomes when a price for `e.year` arrives.
  //   e.cents: a number, null (price removed), or undefined (not given)
  // A newer year pushes the current price into the history; the same year
  // overwrites it (a correction); an OLDER year only fills in the history.
  // Every field is always written -- Firestore refuses a write containing
  // undefined anywhere.
  // The estimate's numbers on a price record ride along untouched unless e
  // gives them (null clears one).
  // A rental's other rates -- half day, weekend, week, month (Jonah, 13 Oct
  // 2026: "different rates for rentals like a price per day and a price per
  // week") -- ride along the same way; its day rate is the price itself (per
  // day). Estimates take the cheapest mix of them for the days needed
  // (pricing.js rentalCents).
  const PRICING_KEYS = ['markupPct', 'wastePct', 'clientCents', 'halfDayCents', 'weekendCents', 'weekCents', 'monthCents'];
  const RENTAL_RATES = [['halfDayCents', 'Half day', 'halfDay'], ['weekendCents', 'Weekend', 'weekend'],
                        ['weekCents', 'Week', 'week'], ['monthCents', 'Month (4 weeks)', 'month']];
  function applyPrice(old, e) {
    const cur = Object.assign({ cents: null, per: '', year: null, asOf: '', priceNotes: '' }, old || {});
    const extra = {};
    PRICING_KEYS.forEach(k => {
      const v = e[k] !== undefined ? e[k] : cur[k];
      extra[k] = typeof v === 'number' && isFinite(v) ? v : null;
    });
    let history = Array.isArray(cur.history) ? cur.history.slice() : [];
    const file = h => {
      history = history.filter(x => x.year !== h.year);
      if (typeof h.cents === 'number') history.push(h);
    };
    const today = localToday();
    if (e.cents !== undefined) {
      if (cur.cents != null && cur.year && e.year < cur.year) {
        file({ year: e.year, cents: e.cents, per: e.per || cur.per || '', asOf: today });
      } else {
        if (cur.cents != null && cur.year && e.year > cur.year) {
          file({ year: cur.year, cents: cur.cents, per: cur.per || '', asOf: cur.asOf || '' });
        }
        // This year's price is the current one, never also a history row.
        history = history.filter(x => x.year !== e.year);
        cur.cents = e.cents;
        cur.year = e.year;
        cur.asOf = today;
        if (e.per != null) cur.per = e.per;
      }
    } else if (e.per != null) {
      cur.per = e.per;
    }
    if (e.priceNotes != null) cur.priceNotes = e.priceNotes;
    return Object.assign(extra, {
      cents: typeof cur.cents === 'number' ? cur.cents : null,
      per: cur.per || '',
      year: cur.year || e.year || thisYear(),
      asOf: cur.asOf || '',
      priceNotes: cur.priceNotes || '',
      history: history.sort((a, b) => b.year - a.year).slice(0, 15)
        .map(h => ({ year: h.year, cents: h.cents, per: h.per || '', asOf: h.asOf || '' })),
      updatedAt: new Date().toISOString(),
    });
  }

  // Who changed what (changelog.js): each part of an item's price that a
  // change touched, as its own line in the change history -- "MDS — Grey
  // pavers · Price: $3.10 per sq ft → $3.25 per sq ft". Worked out from the
  // record before and after, so every way in (the price box, a price list,
  // a receipt, an estimate's Source it) is told the same way. Notes and the
  // year alone are not price changes and are left out.
  const LOGGED = [['markupPct', 'Markup', 'pct'], ['wastePct', 'Waste', 'pct'], ['clientCents', 'Customer price each', 'cents'],
                  ['halfDayCents', 'Half-day rate', 'cents'], ['weekendCents', 'Weekend rate', 'cents'],
                  ['weekCents', 'Week rate', 'cents'], ['monthCents', 'Month rate', 'cents']];
  function priceChanges(id, old, next, via) {
    const C = window.YDChangeLog;
    if (!C || !next) return [];
    const o = old || {}, n = next;
    const numOf = x => (typeof x === 'number' && isFinite(x) ? x : null);
    const it = items[id] || {};
    const v = vendors[it.vendorId];
    const base = { area: 'price', access: 'supplies', what: (v ? v.name + ' — ' : '') + (it.name || 'An item'),
                   kind: it.category || 'material', ref: { path: 'supplyPrices', id: id }, via: via || null };
    const out = [];
    // A device that has not heard the prices yet cannot say what it was.
    const unknown = !old && !pricesReady;
    const shownPrice = p => (p === o && unknown ? 'not known' : numOf(p.cents) == null ? 'no price' : C.money(p.cents) + (p.per ? ' per ' + p.per : ''));
    if (numOf(o.cents) !== numOf(n.cents) || (numOf(n.cents) != null && (o.per || '') !== (n.per || ''))) {
      out.push(Object.assign({}, base, { field: 'Price', before: shownPrice(o), after: shownPrice(n) }));
    }
    LOGGED.forEach(([k, label, how]) => {
      const a = numOf(o[k]), b = numOf(n[k]);
      if (a === b) return;
      const say = x => (x == null ? (how === 'pct' ? 'the kind’s usual' : 'none') : how === 'pct' ? x + '%' : C.money(x));
      out.push(Object.assign({}, base, { field: label, before: say(a), after: say(b) }));
    });
    return out;
  }
  const logPrices = list => { if (list.length && window.YDChangeLog) window.YDChangeLog.add(list); };

  // The estimate fields, typed: '' -> null (use the category's), else a number.
  // NaN for something that is not a number, so it can be refused.
  function parsePct(s) {
    const t = String(s == null ? '' : s).replace(/[%\s]/g, '');
    if (!t) return null;
    return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
  }
  // Every kind of material: the app's list and the ones Jonah added (pricing.js).
  const categories = () => (window.YDPricing ? (window.YDPricing.allKinds ? window.YDPricing.allKinds() : window.YDPricing.CATEGORIES) : []);
  // "Pavers", "pavers", "PAVERS" and the id all name the same category; a
  // name that is none of them is a new kind of his own.
  function categoryId(s) {
    if (!key(s)) return null;
    if (window.YDPricing && window.YDPricing.kindFor) return window.YDPricing.kindFor(s) || null;
    const hit = categories().find(([id, name]) => key(id) === key(s) || key(name) === key(s));
    return hit ? hit[0] : undefined;
  }
  function yesNo(s) {
    const t = norm(s).trim();
    if (!t) return null;
    if (/^(y|yes|true|1|x|✓)$/.test(t)) return true;
    if (/^(n|no|false|0)$/.test(t)) return false;
    return undefined;
  }

  // ---------------------------------------------------------------- render

  // Tags: what a material is used for (Jonah, 12 Oct 2026: "a central hub of
  // all supplies that I can search in and is organized by what the material
  // is used for"; "tags i can add like drainage, snow removal so i can sort
  // all the materials by what their for"). The starter tags below are worked
  // out from each item's kind and name; his own (typed on an item, or on a
  // whole search at once) sit beside them, stored by name. An item's own
  // `usedFor` -- starter ids and his tags -- wins over the worked-out ones.
  // (Tags, and the search index below, are worked out again after any change
  // to Supplies: tagsChanged.)
  // One item can carry several: base gravel goes under a patio and behind a wall.
  // `also` are the words that, typed as a tag, mean this starter one.
  const USES = [
    { id: 'patios', icon: '🏡', name: 'Patios & walkways', kinds: ['pavers', 'stone', 'hardscape', 'adhesive', 'edging'],
      also: ['patio', 'walkway', 'walkways', 'pavers', 'hardscape', 'hardscaping'] },
    { id: 'walls', icon: '🧱', name: 'Retaining walls & steps', kinds: ['wall', 'stone', 'hardscape', 'adhesive'],
      also: ['wall', 'retaining wall', 'retaining walls', 'steps'] },
    { id: 'natural', icon: '⛰', name: 'Natural stone & boulders', kinds: ['natural'], also: ['natural stone', 'boulders', 'flagstone'] },
    { id: 'living', icon: '🔥', name: 'Fire pits, fireplaces & kitchens', kinds: ['firepit', 'fireplace', 'kitchen'],
      also: ['fire pit', 'firepit', 'fire pits', 'fireplace', 'fireplaces', 'outdoor kitchen', 'kitchen', 'grill', 'outdoor living'] },
    { id: 'beds', icon: '🌷', name: 'Beds & planting', kinds: ['mulch', 'soil', 'plant', 'planting', 'edging', 'decorative'],
      words: /\b(river rock|decorative|landscape rock|mulch)\b/, also: ['beds', 'planting', 'plants', 'landscaping'] },
    { id: 'lawn', icon: '🌱', name: 'Lawn & seed', kinds: ['seed', 'soil'], also: ['lawn', 'seed', 'grass', 'erosion', 'sod'] },
    { id: 'grading', icon: '🚜', name: 'Grading & base', kinds: ['fill', 'stone', 'soil'], also: ['grading', 'fill', 'base'] },
    { id: 'drainage', icon: '💧', name: 'Drainage & concrete', kinds: ['drainage'], also: ['drainage', 'concrete'] },
    { id: 'snow', icon: '❄️', name: 'Snow removal', kinds: [],
      words: /\b(salt|ice ?melt|de-?icer|calcium chloride|magnesium chloride)\b/,
      also: ['snow', 'snow & ice', 'snow and ice', 'ice', 'salt', 'snow plowing', 'plowing'] },
    { id: 'tools', icon: '🔧', name: 'Tools & hardware', kinds: ['tools', 'hardware'], also: ['tools', 'hardware', 'equipment'] },
    { id: 'rentals', icon: '🚛', name: 'Rentals & dumpsters', kinds: ['rental', 'dumpster'], also: ['rental', 'rentals', 'dumpster', 'dumpsters'] },
    { id: 'other', icon: '📦', name: 'Everything else', kinds: ['bagged', 'other'], also: ['other', 'misc'] },
  ];
  const USE_BY_ID = {};
  USES.forEach(u => { USE_BY_ID[u.id] = u; });
  const sameSet = (a, b) => a.slice().sort().join('|') === b.slice().sort().join('|');
  function usesFromKind(category, name, also) {
    const words = norm([name, also].join(' '));
    // Everything else is only for what nothing else claims (bagged salt is snow removal).
    const out = USES.filter(u => u.id !== 'other' && (u.kinds.indexOf(category) !== -1 || (u.words && u.words.test(words)))).map(u => u.id);
    return out.length ? out : ['other'];
  }
  const cleanTag = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 40);
  // His own tags, spelt the way each was first typed ("snow Removal" on one
  // item and "Snow removal" on another are one tag). Rebuilt whenever the
  // items change (tagsChanged).
  let tagCache = null;
  function canonTags() {
    if (tagCache) return tagCache;
    tagCache = {};
    Object.values(items).forEach(it => (Array.isArray(it.usedFor) ? it.usedFor : []).forEach(t => {
      t = cleanTag(t);
      if (t && !USE_BY_ID[t] && !tagCache[key(t)]) tagCache[key(t)] = t;
    }));
    return tagCache;
  }
  const tagsChanged = () => { tagCache = null; index = null; };
  const customTags = () => Object.values(canonTags()).sort((a, b) => a.localeCompare(b));
  function usesOf(it) {
    const own = (Array.isArray(it.usedFor) ? it.usedFor : []).map(cleanTag).filter(Boolean)
      .map(t => (USE_BY_ID[t] ? t : canonTags()[key(t)] || t)).filter((t, i, a) => a.indexOf(t) === i);
    return own.length ? own : usesFromKind(it.category, it.name, it.also);
  }
  // A tag as typed -> the tag it is: a starter one ("drainage", "snow"), one
  // already in use however it was capitalised, or a new one as typed.
  function tagFor(text) {
    const t = cleanTag(text), k = key(t);
    if (!k) return '';
    const hit = USES.find(u => key(u.id) === k || key(u.name) === k || u.also.some(a => key(a) === k));
    if (hit) return hit.id;
    return customTags().find(c => key(c) === k) || t;
  }
  const tagInfo = t => USE_BY_ID[t] || { id: t, icon: '🔖', name: t, custom: true };
  const isTag = t => !!t && (!!USE_BY_ID[t] || customTags().indexOf(t) !== -1);
  const kindName = it => (it.category ? (window.YDPricing && window.YDPricing.kindName ? window.YDPricing.kindName(it.category)
    : ((categories().find(c => c[0] === it.category) || [])[1]) || it.category) : '') || 'No kind set';

  // Every word typed has to appear somewhere in the item: its name, the other
  // names it goes by, the supplier, the item number, the where, its kind or
  // what it is used for. "grass seed" finds "Seed -- sun & shade mix" listed
  // with "grass" as another name; "snow" finds the salt.
  function hayOf(it) {
    const v = vendors[it.vendorId] || {};
    return norm([it.name, it.also, it.sku, v.name, it.where, it.notes, kindName(it)]
      .concat(usesOf(it).map(t => tagInfo(t).name)).join(' '));
  }
  // What each item is searched by, and every item in name order: worked out
  // once after Supplies changes, not again at every key typed in the search.
  let index = null;           // { sorted: [items by name], hay: { id: text } }
  function searchIndex() {
    if (index) return index;
    const sorted = Object.values(items).sort(byName), hay = {};
    sorted.forEach(it => { hay[it.id] = hayOf(it); });
    index = { sorted: sorted, hay: hay };
    return index;
  }
  function matches(it, words) {
    const h = searchIndex().hay[it.id];
    const hay = h != null ? h : hayOf(it);
    return words.every(w => hay.indexOf(w) !== -1);
  }

  // Two ways in (Jonah, 12 Oct 2026: "I want to be able to scroll through the
  // vendors without seeing every single item ... click on a vendor then it
  // shows me their items"): the suppliers, one line each, opened one at a
  // time; and every supply in one place, by what it is for. Kept per device.
  const VIEW_KEY = 'ydjobhub_supView';
  let view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'hub' ? 'hub' : 'vendors'; } catch (e) { return 'vendors'; } })();
  let use = '';              // the use opened in All supplies, '' for the list of uses
  const SHOW_MAX = 100;      // a search that matches more shows this many...
  let showAll = false;       // ...until "Show all" is pressed (for this search only)
  const cap = () => (showAll ? Infinity : SHOW_MAX);
  const FOLD_OVER = 25;      // a list longer than this is folded by kind
  const openFolds = new Set();
  let foldLists = {};        // fold key -> { list, withVendor }, from the last draw

  // Items as cards, or (on a computer) as a table of rows -- name, item #,
  // price, year, kind, tags, Edit -- so a supplier's 20, 30 items fit on one
  // screen instead of five (15 Oct 2026). Kept per device. A phone always
  // has the cards: a table that wide does not fit it.
  const LAYOUT_KEY = 'ydjobhub_supLayout';
  let layout = (() => { try { return localStorage.getItem(LAYOUT_KEY) === 'table' ? 'table' : 'cards'; } catch (e) { return 'cards'; } })();
  const narrow = () => !!(window.matchMedia && window.matchMedia('(max-width:720px)').matches);
  const asTable = () => layout === 'table' && !narrow();
  if (window.matchMedia) {
    const mq = window.matchMedia('(max-width:720px)');
    const flip = () => { if (layout === 'table' && el('supResults')) renderResults(true); };
    if (mq.addEventListener) mq.addEventListener('change', flip); else if (mq.addListener) mq.addListener(flip);
  }
  function layoutHtml() {
    const b = (k, label) => '<button type="button" class="sup-lay' + (layout === k ? ' on' : '') + '" aria-pressed="' + (layout === k) + '"' +
      ' onclick="supLayout(\'' + k + '\')">' + label + '</button>';
    return '<div class="sup-layout" role="group" aria-label="Show the items as">' + b('table', '▦ Table') + b('cards', '▤ Cards') + '</div>';
  }
  window.supLayout = function (which) {
    layout = which === 'table' ? 'table' : 'cards';
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch (e) { /* private window */ }
    renderResults(true);
  };
  // Items as table rows. The kind column is left out inside a fold that is
  // already one kind. Prices only for whoever may see them, as on the cards.
  function tableHtml(list, withVendor, showKind) {
    const sp = seesPrices(), ed = edits();
    return '<div class="sup-grid-wrap"><table class="sup-grid"><thead><tr><th>Name</th>' + (withVendor ? '<th>Supplier</th>' : '') +
      '<th>Item #</th>' + (sp ? '<th>Price</th><th>Year</th>' : '') + (showKind ? '<th>Kind</th>' : '') + '<th>Tags</th>' +
      (ed ? '<th aria-label="Edit"></th>' : '') + '</tr></thead><tbody>' +
      list.map(it => rowHtml(it, withVendor, showKind, sp, ed)).join('') + '</tbody></table></div>';
  }
  function rowHtml(it, withVendor, showKind, sp, ed) {
    const v = vendors[it.vendorId] || null, p = prices[it.id];
    const priced = !!(p && typeof p.cents === 'number');
    const prev = priced ? lastYears(p) : null;
    // Where it is at the supplier, and its notes, on hover: the row stays one line.
    const tip = [it.where ? 'Where: ' + it.where : '', it.notes && String(it.notes).trim() !== sharedOf(it).notes ? it.notes : ''].filter(Boolean).join(' — ');
    return '<tr>' +
      '<td class="sup-g-name"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(it.name) + '</td>' +
      (withVendor ? '<td class="sup-g-v">' + esc(v ? v.name : 'No supplier set') + '</td>' : '') +
      '<td class="sup-g-sku">' + esc(it.sku || '') + '</td>' +
      (sp ? '<td class="sup-g-price">' + (priced ? '<b>' + fmtCents(p.cents) + '</b>' + (p.per ? ' <span class="sup-per">/ ' + esc(p.per) + '</span>' : '')
          : '<span class="sup-g-none">No price yet</span>') + '</td>' +
        '<td class="sup-g-year">' + (priced && p.year ? p.year + (prev ? ' ' + changeHtml(change(p.cents, prev.cents)) : '') : '') + '</td>' : '') +
      (showKind ? '<td class="sup-g-kind">' + esc(kindName(it)) + '</td>' : '') +
      '<td class="sup-g-tags">' + usesOf(it).map(t => '<button class="sup-tag"' + tagAttr(t) + '>' +
        tagInfo(t).icon + ' ' + esc(tagInfo(t).name) + '</button>').join('') + '</td>' +
      (ed ? '<td class="sup-g-edit"><button class="btn btn-sm sup-edit" onclick="supEdit(\'item\', \'' + safeId(it.id) + '\')">Edit</button></td>' : '') +
    '</tr>';
  }

  function render() {
    const wrap = el('suppliesWrap');
    if (!wrap) return;
    if (!signedIn()) {
      wrap.innerHTML = '<p class="empty-msg">Loading…</p>';
      return;
    }
    if (!started && authKey) start();  // the crew's first look (see start)
    // The search box is drawn once and kept; only the results are redrawn, so
    // the box never loses focus (or the keyboard) mid-word.
    if (!el('supSearch')) {
      wrap.innerHTML =
        '<div class="sup-views" role="tablist">' +
          '<button id="supViewVendors" class="sup-view" role="tab" onclick="supView(\'vendors\')">🏪 Suppliers</button>' +
          '<button id="supViewHub" class="sup-view" role="tab" onclick="supView(\'hub\')">📦 All supplies</button>' +
        '</div>' +
        '<input id="supSearch" class="sup-search" type="search" oninput="supSearch(this.value)" autocomplete="off">' +
        // With one supplier open, its own card has these two for that
        // supplier (renderResults hides the ones here).
        (edits() ? '<div class="field-actions sup-actions">' +
          '<button class="btn btn-sm btn-filled" id="supTopAdd" onclick="supEdit(\'item\', \'\')">+ Add an item</button>' +
          '<button class="btn btn-sm" onclick="supEdit(\'vendor\', \'\')">+ Add a supplier</button>' +
          '<button class="btn btn-sm" id="supTopPrices" onclick="supPriceList()">💲 Price list</button>' +
        '</div>' : '') +
        '<div id="supResults"></div>';
      el('supSearch').value = search;
    }
    renderResults();
  }

  // Rentals (Jonah, 5 Oct 2026): "a rental section within the supplies with
  // the locations and phone numbers for where we pick up certain rental
  // items". A rental is an item of the Rentals kind (or a dumpster), found
  // under Rentals & dumpsters in All supplies; the rental place is a supplier
  // like any other.
  const isRental = it => it.category === 'rental' || it.category === 'dumpster';

  // A note on many of one supplier's items -- a rental sheet entered with
  // the same "rates for 2026, delivery extra" on every line -- is said once,
  // with the supplier, and left off those items (15 Oct 2026: one supplier's
  // note showed 43 times down its list). The same for a shared price note.
  // Worked out afresh at each drawing: vendor id -> { notes, priceNotes },
  // each the shared text or ''.
  let shared = {};
  const SHARED_MIN = 3;       // on at least this many of its items, and at least half of them
  function sharedNotes() {
    const by = {}, out = {};
    Object.values(items).forEach(it => {
      if (!vendors[it.vendorId]) return;
      const b = by[it.vendorId] = by[it.vendorId] || { n: 0, notes: {}, priceNotes: {} };
      b.n++;
      const t = String(it.notes || '').trim();
      if (t) b.notes[t] = (b.notes[t] || 0) + 1;
      const pn = String((prices[it.id] || {}).priceNotes || '').trim();
      if (pn) b.priceNotes[pn] = (b.priceNotes[pn] || 0) + 1;
    });
    const most = (counts, n) => {
      let best = '', c = 0;
      Object.keys(counts).forEach(k => { if (counts[k] > c) { best = k; c = counts[k]; } });
      return c >= SHARED_MIN && c * 2 >= n ? best : '';
    };
    Object.keys(by).forEach(vid => {
      const s = { notes: most(by[vid].notes, by[vid].n), priceNotes: most(by[vid].priceNotes, by[vid].n) };
      if (s.notes || s.priceNotes) out[vid] = s;
    });
    return out;
  }
  const sharedOf = it => (it && shared[it.vendorId]) || {};
  // The shared notes, said once: on the supplier's card, and above a list of
  // items from several suppliers (All supplies) for each one in it.
  function sharedHtml(vid) {
    const s = shared[vid];
    if (!s) return '';
    return (s.notes ? '<div class="sup-notes sup-shared"><b>On their items:</b> ' + esc(s.notes) + '</div>' : '') +
      (s.priceNotes && seesPrices() ? '<div class="sup-pnotes sup-shared"><b>Their prices:</b> ' + esc(s.priceNotes) + '</div>' : '');
  }
  function sharedListHtml(list) {
    const seen = {};
    list.forEach(it => { if (shared[it.vendorId] && vendors[it.vendorId]) seen[it.vendorId] = true; });
    return Object.keys(seen).map(vid => {
      const inner = sharedHtml(vid);
      return inner ? '<div class="sup-shared-for"><span class="sup-shared-v">' + esc(vendors[vid].name) + '</span>' + inner + '</div>' : '';
    }).join('');
  }

  // searchOnly: only the search words changed, so the tags and the search
  // index worked out for the last drawing still hold. Every other drawing
  // starts from Supplies as it is now.
  function renderResults(searchOnly) {
    const box = el('supResults');
    if (!box) return;
    if (searchOnly !== true) tagsChanged();
    if (shown && shown !== '-' && !vendors[shown]) shown = '';
    if (use && !isTag(use)) use = '';
    const vBtn = el('supViewVendors'), hBtn = el('supViewHub'), sBox = el('supSearch');
    if (vBtn) vBtn.classList.toggle('on', view === 'vendors');
    if (hBtn) hBtn.classList.toggle('on', view === 'hub');
    const v = view === 'vendors' && shown && shown !== '-' ? vendors[shown] : null;
    if (sBox) sBox.placeholder = view === 'hub'
      ? (use ? 'Search ' + tagInfo(use).name.toLowerCase() : 'What do you need? e.g. seed, pavers, salt')
      : v ? 'Search what ' + v.name + ' sells' : shown === '-' ? 'Search these items' : 'Find a supplier — or something they sell';
    const topAdd = el('supTopAdd'), topPrices = el('supTopPrices');
    if (topAdd) topAdd.hidden = !!v;
    if (topPrices) topPrices.hidden = !!v;
    foldLists = {};
    shared = sharedNotes();

    if (!Object.keys(items).length && !Object.keys(vendors).length) {
      // Nothing has answered yet (a crew phone opening the tab for the first time).
      if (!heard) { box.innerHTML = '<p class="empty-msg">Loading…</p>'; return; }
      box.innerHTML = '<p class="empty-msg">' + (edits()
        ? 'Nothing here yet. Add your suppliers first, then the things you buy from each — ' +
          'and where they are once you get there. Or paste a whole price list in at once with “💲 Price list”.'
        : 'Nothing has been added here yet.') + '</p>';
      return;
    }
    const words = norm(search).split(/\s+/).filter(Boolean);
    box.innerHTML = (edits() && !words.length && !shown ? checksHtml() : '') +
      (view === 'hub' ? hubHtml(words) : shown ? oneVendorHtml(v, words) : vendorListHtml(words));
  }

  // ---- Prices to check: a receipt said a different price (receipts.js
  // checkPrices). Jonah, 26 Oct 2026: "when numbers dont line up they should
  // be submitted for review so i can ensure there wasnt a mistake made".
  // Each waits on its item's price (supplyPrices `check`) until he takes the
  // receipt's price or keeps his own -- estimates never use it before that.
  let checksOpen = false;
  function checksList() {
    return Object.keys(prices).filter(id => prices[id] && prices[id].check && items[id])
      .map(id => ({ id: id, it: items[id], pr: prices[id], c: prices[id].check }))
      .sort((a, b) => String(b.c.date || '').localeCompare(String(a.c.date || '')));
  }
  function checksHtml() {
    const list = checksList();
    if (!list.length) return '';
    const cash = c => typeof c === 'number' ? fmtMoney(c / 100) : 'no price';
    const row = x => {
      const v = vendors[x.it.vendorId];
      const per = x.c.per ? '/' + esc(x.c.per) : '';
      const mine = typeof x.pr.cents === 'number' ? x.pr.cents : null;
      const day = /^\d{4}-\d{2}-\d{2}$/.test(x.c.date || '')
        ? new Date(x.c.date + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      return '<div class="sup-check">' +
        '<div><b>' + esc(x.it.name) + '</b>' + (v ? ' <span class="muted">· ' + esc(v.name) + '</span>' : '') + '</div>' +
        '<div>Receipt: <b>' + cash(x.c.cents) + per + '</b>' +
          (x.c.unsure ? ' <span class="warn-text">(it doesn’t say per what — check)</span>' : '') +
          ' · price list: ' + cash(mine) + (x.pr.per ? '/' + esc(x.pr.per) : '') +
          (x.pr.asOf ? ' <span class="muted">(set ' + esc(x.pr.asOf) + ')</span>' : '') + '</div>' +
        '<div class="muted">' + esc([x.c.vendor, x.c.orderNo ? '#' + x.c.orderNo : '', day, x.c.where].filter(Boolean).join(' · ')) +
          (x.c.link ? ' · <a class="link-btn" href="' + esc(x.c.link) + '" target="_blank" rel="noopener">the email</a>' : '') + '</div>' +
        '<div class="sup-check-acts"><button class="btn btn-sm btn-filled" onclick="supCheckUse(\'' + safeId(x.id) + '\')">Use ' +
          cash(x.c.cents) + per + '</button> <button class="btn btn-sm" onclick="supCheckKeep(\'' + safeId(x.id) + '\')">Keep ' +
          cash(mine) + '</button></div></div>';
    };
    return '<details class="sup-checks"' + (checksOpen ? ' open' : '') + ' ontoggle="supChecksOpen(this.open)">' +
      '<summary>💲 <b>Prices to check (' + list.length + ')</b> — a receipt said a different price</summary>' +
      '<p class="hint">Estimates are priced from the price list. Use the receipt’s price if it is right; keep yours if that ' +
        'receipt was a one-off or was read wrong.</p>' + list.map(row).join('') + '</details>';
  }
  window.supChecksOpen = open => { checksOpen = !!open; };
  // Its check done with: gone here at once, and on the server (not awaited).
  function clearCheck(id) {
    if (prices[id]) prices[id] = Object.assign({}, prices[id], { check: null });
    Promise.resolve(window.YDDb.put('supplyPrices', id, { check: null }))
      .catch(e => console.warn('[supplies] price check not cleared yet:', (e && e.code) || e));
  }
  window.supCheckUse = function (id) {
    const x = prices[id], c = x && x.check;
    if (!c || !edits() || typeof c.cents !== 'number') return;
    setPrice(id, c.cents, c.year, 'Receipt').catch(e => showToast(e && e.code === 'permission-denied'
      ? 'Price not changed — not allowed' : 'Price change not on the server yet'));
    clearCheck(id);
    showToast((items[id] ? items[id].name + ': ' : '') + fmtMoney(c.cents / 100) + (c.per ? '/' + c.per : '') + ' on the price list');
    renderResults();
  };
  window.supCheckKeep = function (id) {
    if (!prices[id] || !prices[id].check || !edits()) return;
    clearCheck(id);
    showToast('Kept your price');
    renderResults();
  };

  // ---- Suppliers: one line each; tap one for its card and what it sells.

  function vendorListHtml(words) {
    const count = {}, hits = {};
    Object.values(items).forEach(it => {
      const k = vendors[it.vendorId] ? it.vendorId : '-';
      count[k] = (count[k] || 0) + 1;
      if (words.length && matches(it, words)) hits[k] = (hits[k] || 0) + 1;
    });
    // A search finds a supplier by its own name and address, or by what it sells.
    const own = vd => words.every(w => norm([vd.name, vd.address, vd.notes, vd.website].join(' ')).indexOf(w) !== -1);
    const list = Object.values(vendors).sort(byName).filter(vd => !words.length || own(vd) || hits[vd.id]);
    const row = (id, name, n, sub, ways, hit) =>
      '<button class="sup-vrow" onclick="supFilter(\'' + safeId(id) + '\')">' +
        '<span class="sup-vrow-main">' +
          '<span class="sup-vrow-top"><span class="sup-vrow-name">' + esc(name) + '</span>' +
            '<span class="sup-unit">' + n + ' item' + (n === 1 ? '' : 's') + '</span>' +
            (hit ? '<span class="sup-unit sup-hit">' + hit + ' match' + (hit === 1 ? '' : 'es') + '</span>' : '') +
          '</span>' +
          (ways ? '<span class="sup-ways">' + ways + '</span>' : '') +
          (sub ? '<span class="sup-vrow-sub">' + esc(sub) + '</span>' : '') +
        '</span><span class="sup-vrow-go" aria-hidden="true">›</span></button>';
    let html = list.map(vd => row(vd.id, vd.name, count[vd.id] || 0,
      [vd.address, vd.hours].filter(Boolean).join(' · '), waysSpans(vd), hits[vd.id] || 0)).join('');
    if (count['-'] && (!words.length || hits['-'])) html += row('-', 'No supplier set', count['-'], '', '', hits['-'] || 0);
    if (!html) {
      return '<p class="empty-msg">No supplier matches “' + esc(search) + '”, and nobody sells anything by that name.' +
        (edits() ? ' Add it with “+ Add a supplier” or “+ Add an item”.' : ' Ask Jonah, and he can add it here.') + '</p>';
    }
    return '<div class="sup-vlist">' + html + '</div>';
  }

  function oneVendorHtml(v, words) {
    const mine = searchIndex().sorted.filter(it => (v ? it.vendorId === v.id : !vendors[it.vendorId]));
    const list = words.length ? mine.filter(it => matches(it, words)) : mine;
    let html = '<button class="link-btn sup-back" onclick="supFilter(\'\')">← All suppliers</button>';
    html += v ? vendorCardHtml(v, mine.length)
      : '<div class="sup-h">No supplier set</div><div class="hint">Pick each one’s supplier with its Edit button.</div>';
    if (!list.length) {
      return html + '<p class="empty-msg">' + (words.length
        ? 'Nothing ' + (v ? 'at ' + esc(v.name) + ' ' : '') + 'matches “' + esc(search) + '”.'
        : 'Nothing listed for ' + esc(v ? v.name : 'here') + ' yet.' + (edits() ? ' Add things with “+ Add an item here”.' : '')) + '</p>';
    }
    return html + (words.length ? bulkBarHtml(list, '') : '') + itemsHtml('v:' + (v ? v.id : '-'), list, false, !!words.length);
  }

  // ---- All supplies: every item, by what it is used for.

  // Every tag, the starter ones first. A tag goes in an onclick through
  // data-t, never inside the quotes: his own tags have spaces and apostrophes.
  const allTags = () => USES.map(u => u.id).concat(customTags());
  const tagAttr = t => ' data-t="' + esc(t) + '" onclick="supUse(this.dataset.t)"';

  function hubHtml(words) {
    const all = searchIndex().sorted;
    if (use) {
      const u = tagInfo(use);
      const mine = all.filter(it => usesOf(it).indexOf(use) !== -1);
      const list = words.length ? mine.filter(it => matches(it, words)) : mine;
      return '<button class="link-btn sup-back" onclick="supUse(\'\')">← Every tag</button>' +
        '<div class="sup-h">' + u.icon + ' ' + esc(u.name) + ' <span class="sup-group-count">' + mine.length + '</span></div>' +
        (use === 'rentals' ? '<div class="hint">What we rent and where to get it. Add one with “+ Add an item” and pick ' +
          '“Rentals” as its kind; the rental place is a supplier like any other.</div>' : '') +
        bulkBarHtml(list, use) + sharedListHtml(list) +
        (list.length ? itemsHtml('u:' + use, list, true, !!words.length)
          : '<p class="empty-msg">' + (words.length ? 'Nothing here matches “' + esc(search) + '”.' : 'Nothing here yet.') + '</p>');
    }
    if (words.length) {
      // A search across everything, under the first tag each one carries.
      const list = all.filter(it => matches(it, words));
      if (!list.length) {
        return '<p class="empty-msg">Nothing matches “' + esc(search) + '”.' +
          (edits() ? ' Add it with “+ Add an item”.' : ' Ask Jonah where to get it, and he can add it here.') + '</p>';
      }
      const byUse = {};
      list.slice(0, cap()).forEach(it => { const k = usesOf(it)[0]; (byUse[k] = byUse[k] || []).push(it); });
      return bulkBarHtml(list, '') + sharedListHtml(list.slice(0, cap())) + layoutHtml() + allTags().filter(t => byUse[t]).map(t =>
        '<div class="sup-group"><button class="sup-group-name"' + tagAttr(t) + '>' + tagInfo(t).icon + ' ' + esc(tagInfo(t).name) + '</button>' +
          '<span class="sup-group-count">' + byUse[t].length + '</span></div>' +
        (asTable() ? tableHtml(byUse[t], true, true) : byUse[t].map(it => itemHtml(it, true)).join(''))).join('') + moreHtml(list.length);
    }
    // The tags, as tiles to open -- not every item at once.
    const count = {};
    all.forEach(it => usesOf(it).forEach(k => { count[k] = (count[k] || 0) + 1; }));
    return '<div class="sup-tiles">' + allTags().filter(t => count[t]).map(t =>
      '<button class="sup-tile"' + tagAttr(t) + '><span class="sup-tile-icon" aria-hidden="true">' + tagInfo(t).icon + '</span>' +
        '<b>' + esc(tagInfo(t).name) + '</b><small>' + count[t] + ' item' + (count[t] === 1 ? '' : 's') + '</small></button>').join('') +
      '</div>' +
      // How to add tags -- only for whoever can (the crew have no Edit).
      (edits() ? '<div class="hint">Tags start from each item’s kind. Add your own on an item (Edit → Used for), ' +
        'or search, then “🔖 Tag these” to tag everything found at once.</div>' : '');
  }

  // Tagging many at once: everything a search (or a tag's page) shows.
  let bulkList = [];
  function bulkBarHtml(list, tag) {
    bulkList = list;
    if (!edits() || !list.length || (!tag && !norm(search).trim())) return '';
    const n = list.length + ' item' + (list.length === 1 ? '' : 's');
    return '<div class="sup-bulk">' +
      '<button class="btn btn-sm" onclick="supTagAll()">🔖 Tag these ' + n + '…</button>' +
      (tag ? '<button class="btn btn-sm" onclick="supUntagAll()">✕ Take “' + esc(tagInfo(tag).name) + '” off these ' + n + '</button>' : '') +
      (tag && tagInfo(tag).custom ? '<button class="btn btn-sm" onclick="supRenameTag()">✎ Rename this tag</button>' : '') +
    '</div>';
  }
  // Each item's tags as `fn` makes them; saved as the item's own unless they
  // come out the same as its kind would give.
  function retag(list, fn) {
    const now = new Date().toISOString(), writes = [];
    list.forEach(it => {
      const before = usesOf(it), next = fn(before.slice()).filter((t, i, a) => t && a.indexOf(t) === i);
      if (sameSet(before, next)) return;
      const usedFor = sameSet(next, usesFromKind(it.category, it.name, it.also)) ? null : next;
      it.usedFor = usedFor;
      writes.push(['supplies', it.id, { usedFor: usedFor, updatedAt: now }]);
      tagsChanged();
    });
    if (writes.length) {
      Promise.resolve(window.YDDb.putMany(writes)).catch(e => {
        if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
        else console.warn('[supplies] tags not yet on the server:', (e && e.code) || e);
      });
    }
    return writes.length;
  }
  const bigAsk = async n => n <= 50 || ydConfirm('That changes ' + n + ' items at once.', { title: 'Go ahead?', ok: 'Change them' });
  window.supTagAll = async function () {
    if (!edits() || !bulkList.length) return;
    const list = bulkList.slice();
    const t = tagFor(await ydPrompt('', '', { title: 'Tag all ' + list.length + ' with…', placeholder: 'e.g. Snow removal, Drainage', ok: 'Tag them' }) || '');
    if (!t || !(await bigAsk(list.length))) return;
    const n = retag(list, tags => tags.concat(t));
    showToast(n ? n + ' tagged “' + tagInfo(t).name + '”' : 'They already have that tag');
    renderResults();
  };
  window.supUntagAll = async function () {
    if (!edits() || !use || !bulkList.length) return;
    const t = use, list = bulkList.slice();
    if (!(await bigAsk(list.length))) return;
    // An item left with no tag at all goes under Everything else rather than
    // springing back to the ones its kind gives.
    const n = retag(list, tags => { const left = tags.filter(x => x !== t); return left.length ? left : ['other']; });
    showToast(n + ' untagged');
    renderResults();
  };
  window.supRenameTag = async function () {
    if (!edits() || !use || !tagInfo(use).custom) return;
    const was = use, typed = await ydPrompt('', was, { title: 'Rename “' + tagInfo(was).name + '”', ok: 'Rename', required: true }) || '';
    let to = tagFor(typed);
    if (to === was && cleanTag(typed) !== was) to = cleanTag(typed);   // only the capitals changed
    if (!to || to === was) return;
    const n = retag(Object.values(items).filter(it => usesOf(it).indexOf(was) !== -1), tags => tags.map(x => (key(x) === key(was) ? to : x)));
    use = to;
    showToast(n + ' item' + (n === 1 ? '' : 's') + ' moved to “' + tagInfo(to).name + '”');
    renderResults();
  };

  // A list of items: as it is when short or searched, else folded by kind so
  // a supplier with 800 things opens as a dozen headings, not a wall.
  function itemsHtml(scope, list, withVendor, searched) {
    if (searched || list.length <= FOLD_OVER) {
      const shown = list.slice(0, cap());
      return layoutHtml() + (asTable() ? tableHtml(shown, withVendor, true) : shown.map(it => itemHtml(it, withVendor)).join('')) + moreHtml(list.length);
    }
    const byKind = {};
    list.forEach(it => { const k = kindName(it); (byKind[k] = byKind[k] || []).push(it); });
    return layoutHtml() + Object.keys(byKind).sort((a, b) => (a === 'No kind set') - (b === 'No kind set') || a.localeCompare(b)).map(k => {
      const fk = scope + '|' + k, open = openFolds.has(fk);
      foldLists[fk] = { list: byKind[k], withVendor: withVendor };
      return '<details class="sup-fold" data-k="' + esc(fk) + '"' + (open ? ' open' : '') + ' ontoggle="supFold(this)">' +
        '<summary><span class="sup-fold-name">' + esc(k) + '</span><span class="sup-group-count">' + byKind[k].length + '</span></summary>' +
        '<div class="sup-fold-body">' + (open ? foldBody(byKind[k], withVendor) : '') + '</div></details>';
    }).join('');
  }
  // A fold is all one kind: its table needs no kind column.
  const foldBody = (list, withVendor) => (asTable() ? tableHtml(list, withVendor, false) : list.map(it => itemHtml(it, withVendor)).join(''));
  const moreHtml = n => (n > cap() ? '<p class="hint">Showing ' + SHOW_MAX + ' of ' + n + ' — type more to narrow it down, or ' +
    '<button class="link-btn" onclick="supShowAll()">show all ' + n + '</button>.</p>' : '');
  window.supShowAll = function () { showAll = true; renderResults(true); };

  // A fold is filled the first time it opens, so a closed one costs nothing.
  window.supFold = function (d) {
    const k = d.getAttribute('data-k');
    if (d.open) openFolds.add(k); else openFolds.delete(k);
    const body = d.querySelector('.sup-fold-body'), f = foldLists[k];
    if (d.open && body && !body.childElementCount && f) body.innerHTML = foldBody(f.list, f.withVendor);
  };
  window.supView = function (which) {
    view = which === 'hub' ? 'hub' : 'vendors';
    showAll = false;
    try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* private window */ }
    renderResults();
  };
  window.supUse = function (id) {
    view = 'hub';
    use = isTag(id) ? id : '';
    showAll = false;
    renderResults();
    toTop();
  };
  // Back at the top of the list after opening or leaving something further down.
  function toTop() {
    const w = el('suppliesWrap');
    if (w && w.getBoundingClientRect().top < 0) w.scrollIntoView({ block: 'start' });
  }

  // How a supplier that isn't down the road is bought from (Jonah, 12 Oct
  // 2026: "mark vendors as online order only or shipping only etc for vendors
  // i use that arent local"). Any number may be ticked; none ticked is a
  // local yard you drive to.
  const BUY_WAYS = [
    { id: 'online', chip: '🌐 Online only', label: 'Online orders only — no counter to walk up to' },
    { id: 'shipped', chip: '📦 Ships to us', label: 'Ships to us — nobody drives there to pick up' },
    { id: 'phone', chip: '📞 Phone/email orders', label: 'Orders by phone or email only' },
    { id: 'far', chip: '🗺 Not local', label: 'Not local — a long way off, plan ahead' },
  ];
  const waysOf = v => (v && Array.isArray(v.buyWays) ? v.buyWays : []).filter(w => BUY_WAYS.some(b => b.id === w));

  // Delivered or picked up (Jonah, 22 Oct 2026): this item always one way,
  // or as his rules on Pricing rules say (pricing.js wayOf -- shown, worked
  // out from the item as it is saved). An estimate or order line can still
  // go the other way for one job.
  function wayFieldHtml(it, p) {
    const P = window.YDPricing;
    let now = '';
    if (P && P.wayOf && it.name) {
      const v = it.vendorId ? vendors[it.vendorId] : null;
      const vr = ((P.rules().vendors || {})[it.vendorId]) || {};
      const w = P.wayOf({ name: it.name, also: it.also, category: it.category, per: (p && p.per) || it.unit, pallet: !!it.pallet,
        cityDelivery: !!vr.cityDelivery, buyWays: v && v.buyWays, vendorName: v && v.name });
      now = ' — now ' + (w.way === 'pickup' ? 'picked up' : 'delivered') + ' (' + w.why + ')';
    }
    const opt = (k, n) => '<option value="' + k + '"' + ((it.getWay || '') === k ? ' selected' : '') + '>' + esc(n) + '</option>';
    return '<div class="field"><span class="label">How we get it</span><select id="siWay">' +
      opt('', 'By my rules (Pricing rules → Delivered or picked up)' + now) + opt('delivered', '🚚 Always delivered') +
      opt('pickup', '🏪 Always picked up') + '</select>' +
      '<div class="hint">Picked up, an estimate charges no delivery for it. One job that goes the other way: switch it on that estimate’s or order’s line.</div></div>';
  }
  // Only a real web address becomes a link: http(s) only, and a bare
  // "theirsite.com" gets https:// in front.
  function websiteUrl(v) {
    let s = String((v && v.website) || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    try {
      const u = new URL(s);
      return /^https?:$/.test(u.protocol) && u.hostname.indexOf('.') > 0 ? u.href : '';
    } catch (e) { return ''; }
  }
  // The chips under a supplier's name: how it is bought, and how long it takes.
  function waysSpans(v) {
    const w = waysOf(v);
    return BUY_WAYS.filter(b => w.indexOf(b.id) !== -1).map(b => '<span class="sup-way">' + b.chip + '</span>').join('') +
      (v.leadTime ? '<span class="sup-way">⏱ ' + esc(v.leadTime) + '</span>' : '');
  }
  function waysHtml(v) {
    const s = waysSpans(v);
    return s ? '<div class="sup-ways">' + s + '</div>' : '';
  }

  function linksHtml(v) {
    // A supplier that only ships, or only takes orders online, has nowhere to
    // drive to, whatever address it has on file.
    const map = v.address && waysOf(v).indexOf('shipped') === -1 && waysOf(v).indexOf('online') === -1
      ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.address) : '';
    const tel = v.phone ? 'tel:' + String(v.phone).replace(/[^0-9+]/g, '') : '';
    const mail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email || '') ? 'mailto:' + v.email : '';
    const site = websiteUrl(v);
    return (site ? '<a class="btn btn-sm" href="' + esc(site) + '" target="_blank" rel="noopener">🌐 Website</a>' : '') +
      (map ? '<a class="btn btn-sm" href="' + map + '" target="_blank" rel="noopener">📍 Directions</a>' : '') +
      (tel ? '<a class="btn btn-sm" href="' + esc(tel) + '">📞 Call</a>' : '') +
      (mail ? '<a class="btn btn-sm" href="' + esc(mail) + '">✉️ Email</a>' : '');
  }

  function vendorCardHtml(v, n) {
    return '<div class="sup-vcard">' +
      '<div class="sup-top"><span class="sup-vname">' + esc(v.name) + '</span>' +
        '<span class="sup-unit">' + n + ' item' + (n === 1 ? '' : 's') + '</span>' +
        (edits() ? '<button class="btn btn-sm sup-edit" onclick="supEdit(\'vendor\', \'' + safeId(v.id) + '\')">Edit supplier</button>' : '') +
      '</div>' +
      waysHtml(v) +
      ([v.address, v.hours].filter(Boolean).length
        ? '<div class="sup-where">' + esc([v.address, v.hours].filter(Boolean).join(' · ')) + '</div>' : '') +
      (v.notes ? '<div class="sup-notes">' + esc(v.notes) + '</div>' : '') +
      sharedHtml(v.id) +
      '<div class="sup-links">' + linksHtml(v) +
        (edits() ? '<button class="btn btn-sm btn-filled" onclick="supEdit(\'item\', \'\', \'' + safeId(v.id) + '\')">+ Add an item to ' + esc(v.name) + '</button>' : '') +
        // Their own price sheet, as it comes: an Excel file or a CSV, with no
        // Supplier column needed.
        (edits() ? '<button class="btn btn-sm btn-accent" onclick="supPriceList(\'' + safeId(v.id) + '\')">💲 ' + esc(v.name) + '’s price list</button>' : '') +
      '</div>' +
    '</div>';
  }

  function priceHtml(id) {
    if (!seesPrices()) return '';
    const p = prices[id];
    if (!p || typeof p.cents !== 'number') return '<div class="sup-price none">No price yet</div>';
    const prev = lastYears(p);
    const rates = RENTAL_RATES.filter(r => typeof p[r[0]] === 'number')
      .map(r => r[1].replace(/ \(.*\)$/, '').toLowerCase() + ' ' + fmtCents(p[r[0]]));
    return '<div class="sup-price"><b>' + fmtCents(p.cents) + '</b>' +
      (p.per ? ' <span class="sup-per">/ ' + esc(p.per) + '</span>' : '') +
      (rates.length ? ' <span class="sup-per">· ' + rates.join(' · ') + '</span>' : '') +
      (p.year ? ' <span class="sup-year">' + p.year + ' price</span>' : '') +
      (prev ? ' ' + changeHtml(change(p.cents, prev.cents)) : '') +
      (p.priceNotes && String(p.priceNotes).trim() !== sharedOf(items[id]).priceNotes ? '<div class="sup-pnotes">' + esc(p.priceNotes) + '</div>' : '') +
    '</div>';
  }

  function itemHtml(it, withVendor) {
    const v = vendors[it.vendorId] || null;
    // The id lets search (search.js) land on exactly this item.
    return '<div class="sup-item" id="si-' + String(it.id || '').replace(/[^A-Za-z0-9_-]/g, '') + '">' +
      '<div class="sup-top">' +
        '<span class="sup-name">' + esc(it.name) + '</span>' +
        (it.unit ? '<span class="sup-unit">' + esc(it.unit) + '</span>' : '') +
        (it.sku ? '<span class="sup-unit">#' + esc(it.sku) + '</span>' : '') +
        (edits() ? '<button class="btn btn-sm sup-edit" onclick="supEdit(\'item\', \'' + safeId(it.id) + '\')">Edit</button>' : '') +
      '</div>' +
      (withVendor || it.where
        ? '<div class="sup-where">' + (withVendor ? '<b>' + esc(v ? v.name : 'No supplier set') + '</b>' : '') +
            (it.where ? (withVendor ? ' — ' : '') + esc(it.where) : '') + '</div>'
        : '') +
      // So nobody drives to a supplier that only ships.
      (withVendor && v ? waysHtml(v) : '') +
      // A note its supplier's items all share is said with the supplier instead.
      (it.notes && String(it.notes).trim() !== sharedOf(it).notes ? '<div class="sup-notes">' + esc(it.notes) + '</div>' : '') +
      // Its tags; one tap opens everything else with that tag.
      '<div class="sup-tags">' + usesOf(it).map(t => '<button class="sup-tag"' + tagAttr(t) + '>' +
        tagInfo(t).icon + ' ' + esc(tagInfo(t).name) + '</button>').join('') + '</div>' +
      priceHtml(it.id) +
      itemLinksHtml(it, withVendor ? v : null) +
    '</div>';
  }

  // The item's own page first, then (in a list of every supplier's items)
  // how to reach the supplier.
  function itemLinksHtml(it, v) {
    const page = websiteUrl({ website: it.link });
    const own = page ? '<a class="btn btn-sm btn-accent" href="' + esc(page) + '" target="_blank" rel="noopener">🔗 See it online</a>' : '';
    const theirs = v && (v.address || v.phone || websiteUrl(v))
      ? linksHtml(v) + (v.hours ? '<span class="sup-hours">' + esc(v.hours) + '</span>' : '') : '';
    return own || theirs ? '<div class="sup-links">' + own + theirs + '</div>' : '';
  }

  // Drawn once the typing pauses, not at every key: each drawing went
  // through all ~900 supplies.
  let searchTimer = null;
  window.supSearch = function (q) {
    search = q;
    showAll = false;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderResults(true), 150);
  };
  // Open one supplier ('-' the items with none), or '' back to the list.
  window.supFilter = function (id) {
    view = 'vendors';
    shown = id || '';
    showAll = false;
    renderResults();
    toTop();
  };

  // ----------------------------------------------------------------- editing

  window.supEdit = function (kind, id, vendorId) {
    if (!edits()) return;
    editing = { kind: kind, id: id };
    if (kind === 'vendor') {
      const v = id ? vendors[id] || {} : {};
      openModal(id ? 'Edit supplier' : 'Add a supplier',
        field('Name', 'svName', v.name, 'e.g. Example Stone Yard') +
        // In its parts (addr.js); the one line is kept for directions.
        (window.YDAddr ? YDAddr.fieldsHtml('svA', v, { streetHint: 'e.g. 123 Industrial Dr — used for directions' })
          : field('Address', 'svAddr', v.address, 'Street, town — used for directions')) +
        '<div class="grid g2">' +
          field('Phone', 'svPhone', v.phone, '608-…') +
          field('Hours', 'svHours', v.hours, 'e.g. Mon–Sat 7–5') +
        '</div>' +
        // Where an order goes: Materials to Order writes the email (app.js).
        field('Email for orders', 'svEmail', v.email, 'orders@…') +
        field('Website', 'svWeb', v.website, 'e.g. theirsite.com — where to look things up or order') +
        '<div class="field"><span class="label">Not a local yard?</span>' +
          BUY_WAYS.map(b => '<label class="chk"><input type="checkbox" class="svWay" value="' + b.id + '"' +
            (waysOf(v).indexOf(b.id) !== -1 ? ' checked' : '') + '> ' + b.chip.split(' ')[0] + ' ' + esc(b.label) + '</label>').join('') +
          '<div class="hint">Leave all unticked for a supplier you drive to. Shown to the crew under the supplier and its items.</div>' +
        '</div>' +
        field('Usually takes', 'svLead', v.leadTime, 'e.g. 3–5 business days to arrive') +
        '<div class="field"><span class="label">Notes</span><textarea id="svNotes" rows="2" ' +
          'placeholder="Which account we buy under, who to ask for, which gate the yard is through">' + esc(v.notes || '') + '</textarea></div>' +
        actions(id ? 'supRemove(\'vendor\', \'' + safeId(id) + '\')' : ''));
    } else {
      const it = id ? items[id] || {} : {};
      const p = (id && prices[id]) || {};
      const pick = it.vendorId || vendorId || (view === 'vendors' && shown && shown !== '-' ? shown : '');
      const vs = Object.values(vendors).sort(byName);
      // Used for: the item's own ticks, else worked out from its kind. A new
      // item added from inside a use starts in that use.
      const fromUse = !id && view === 'hub' && use;
      const usesShown = id ? usesOf(it) : fromUse ? [use] : [];
      editing.usesShown = usesShown;
      editing.usesAuto = !fromUse && !(Array.isArray(it.usedFor) && it.usedFor.length);
      const show = v => (typeof v === 'number' ? String(v) : '');
      const priceShown = {
        price: typeof p.cents === 'number' ? (p.cents / 100).toFixed(2) : '',
        per: p.per || '', year: String(p.year || thisYear()), notes: p.priceNotes || '',
        markup: show(p.markupPct), waste: show(p.wastePct),
        client: typeof p.clientCents === 'number' ? (p.clientCents / 100).toFixed(2) : '',
      };
      RENTAL_RATES.forEach(([k, , f]) => { priceShown[f] = typeof p[k] === 'number' ? (p[k] / 100).toFixed(2) : ''; });
      const catRule = ((window.YDPricing && window.YDPricing.rules().categories) || {})[it.category] || {};
      editing.priceShown = priceShown;
      const hist = Array.isArray(p.history) ? p.history : [];
      // The price first (15 Oct 2026: changing one meant scrolling past the
      // whole item): what it costs, per what, for which year, under its name
      // -- then the rest. The markup, waste and rental rates go with the kind
      // of material, which comes before the tags that start from it.
      const priceBox = '<fieldset class="sup-pricebox sup-pricefirst"><legend>Price — only you see this</legend>' +
          '<div class="grid g3">' +
            field('Price ($)', 'spPrice', priceShown.price, 'e.g. 12.50', 'decimal') +
            field('Per', 'spPer', priceShown.per, it.unit || 'bag, yard, each') +
            field('For year', 'spYear', priceShown.year, String(thisYear()), 'numeric') +
          '</div>' +
          '<div class="field"><span class="label">Price notes</span><textarea id="spNotes" rows="2" ' +
            'placeholder="e.g. contractor price; less by the pallet; delivery extra">' + esc(priceShown.notes) + '</textarea></div>' +
          (hist.length ? '<div class="sup-hist">Earlier: ' + hist.map(h =>
            '<span>' + h.year + ' ' + fmtCents(h.cents) + '</span>').join('') + '</div>' : '') +
          '<div class="hint">A price for a new year keeps the old one as history, so the change shows. ' +
            'Fixing a price within the same year just replaces it.</div>' +
          // Every change to this price, who made it and when (changelog.js).
          (id && window.YDChangeLog ? '<button type="button" class="link-btn" onclick="openChangeLog(\'' + safeId(id) + '\', ' +
            esc(JSON.stringify(((vendors[it.vendorId] || {}).name ? vendors[it.vendorId].name + ' — ' : '') + (it.name || ''))) +
            ')">🕘 Who changed this price</button>' : '') +
        '</fieldset>';
      const priceFirst = seesPrices();
      openModal(id ? 'Edit item' : 'Add an item',
        field('What it is', 'siName', it.name, 'e.g. Grass seed — sun & shade') +
        (priceFirst ? priceBox : '') +
        '<div class="field"><span class="label">Supplier</span><select id="siVendor">' +
          '<option value="">— pick one —</option>' +
          vs.map(v => '<option value="' + esc(v.id) + '"' + (v.id === pick ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('') +
        '</select>' + (vs.length ? '' : '<div class="hint">Add a supplier first, with “+ Add a supplier”.</div>') + '</div>' +
        // Jonah (12 Oct 2026): for the suppliers ordered from online, a link
        // to the product's own page.
        field('Link to it online', 'siLink', it.link, 'Paste the product’s page — e.g. theirsite.com/item/123') +
        '<div class="grid g2">' +
          field('Comes in', 'siUnit', it.unit, 'e.g. 50 lb bag, pallet, yard') +
          field('Supplier’s item #', 'siSku', it.sku, 'optional') +
        '</div>' +
        field('Where at the supplier', 'siWhere', it.where, 'e.g. front building, by the counter') +
        field('Also called (helps the search)', 'siAlso', it.also, 'e.g. seed, lawn seed, overseed') +
        '<div class="field"><span class="label">Notes for the crew</span><textarea id="siNotes" rows="2" ' +
          'placeholder="Which one to get, how much per job, anything to watch for">' + esc(it.notes || '') + '</textarea></div>' +
        '<fieldset class="sup-pricebox"><legend>For estimates</legend>' +
          '<div class="field"><span class="label">Kind of material</span><select id="siCat" onchange="supCatPicked(this.value)">' +
            '<option value="">— pick one —</option>' +
            categories().map(([cid, cname]) => '<option value="' + esc(cid) + '"' + (cid === it.category ? ' selected' : '') + '>' + esc(cname) + '</option>').join('') +
            // Jonah (12 Oct 2026): "i need to be able to add kinds of materials".
            '<option value="__new">＋ A new kind…</option>' +
          '</select><div class="hint" id="siCatHint" hidden></div></div>' +
          '<div class="grid g2">' +
            field('One of these covers', 'siCover', show(it.coverage), 'e.g. 750 — blank if bought as measured', 'decimal') +
            field('…of what (the takeoff unit)', 'siTakeoff', it.takeoffUnit, 'e.g. sq ft, LF, plants') +
          '</div>' +
          // A bag sold by weight and used a bit at a time (Jonah, 15 Oct 2026:
          // "we always buy the biggest bag of grass seed so pricing should be
          // based off of the cost per lb of that bag"). The weight is read off
          // the name ("… 50 lb") unless typed here; seed is charged by the
          // part used unless the tick says otherwise.
          '<div class="grid g2">' +
            field('Bag weight (lb)', 'siPackLb', show(it.packLb),
              packHint(it), 'decimal') +
            '<label class="chk"><input type="checkbox" id="siPartUse"' + (partUseOn(it) ? ' checked' : '') + '> ' +
              'Price by the part we use (we keep the rest) — e.g. 3 lb of a 50 lb bag is charged as 3 lb</label>' +
          '</div>' +
          '<label class="chk"><input type="checkbox" id="siPallet"' + (it.pallet ? ' checked' : '') + '> Comes on a pallet (forklift delivery surcharge)</label>' +
          wayFieldHtml(it, p) +
          '<label class="chk"><input type="checkbox" id="siSpecial"' + (it.specialOrder ? ' checked' : '') + '> Special order (non-returnable — the estimate says so)</label>' +
          '<div class="grid g3">' +
            field('Markup %', 'spMarkup', priceShown.markup, catRule.markupPct != null ? catRule.markupPct + ' (its kind)' : 'its kind’s', 'decimal') +
            field('Waste %', 'spWaste', priceShown.waste, catRule.wastePct != null ? catRule.wastePct + ' (its kind)' : 'its kind’s', 'decimal') +
            field('Or: customer price each ($)', 'spClient', priceShown.client, 'only for fixed-price items', 'decimal') +
          '</div>' +
          // A rental: the price above is the day rate ("Per: day"); these are
          // its other rates, any of them left blank if they don't offer it.
          '<div id="spRentalRow"' + (isRental(it) ? '' : ' hidden') + '>' +
            '<div class="hint">A rental: the price above is the <b>day</b> rate. Their other rates below — an estimate ' +
              'uses whichever mix is cheapest for the days needed (5 days can be a week rate). A weekend rate is shown, ' +
              'not used by itself, since it depends on the days.</div>' +
            '<div class="grid g4">' +
              RENTAL_RATES.map(([, label, f]) => field(label + ' ($)', 'spR' + f, priceShown[f], 'optional', 'decimal')).join('') +
            '</div>' +
          '</div>' +
        '</fieldset>' +
        '<div class="field"><span class="label">Used for — tags</span><div class="sup-uses" id="siUses">' +
          allTags().map(t => tagBoxHtml(t, usesShown.indexOf(t) !== -1)).join('') + '</div>' +
          '<div class="sup-tag-add"><input id="siNewTag" placeholder="Add a tag — e.g. Snow removal" ' +
            'onkeydown="if (event.key === \'Enter\') { event.preventDefault(); supAddTag(); }">' +
            '<button class="btn btn-sm" onclick="supAddTag()">+ Add tag</button></div>' +
          '<div class="hint">Where it shows in 📦 All supplies. Left alone, the tags follow the kind of material above; ' +
          'untick everything to go back to that.</div></div>' +
        (priceFirst ? '' : priceBox) +
        actions(id ? 'supRemove(\'item\', \'' + safeId(id) + '\')' : ''));
    }
    const first = el(kind === 'vendor' ? 'svName' : 'siName');
    if (first && !id) first.focus();
    // An item opened to change: the price is what is usually being changed,
    // so it is ready to type over (not on a phone or iPad, where that would
    // throw the keyboard up over the form).
    const pr = kind !== 'vendor' && id ? el('spPrice') : null;
    if (pr && window.matchMedia && matchMedia('(pointer: fine)').matches) { pr.focus(); pr.select(); }
  };

  // Picking Rentals (or Dumpsters) as the kind shows the half-day and week
  // rates, and a blank "Per" becomes "day".
  window.supCatPicked = async function (cat) {
    const sel = el('siCat');
    if (cat === '__new' && sel) {
      // Typed in: one already on the list is just picked; a new one is added.
      cat = categoryId(await ydPrompt('', '', { title: 'A new kind of material', placeholder: 'e.g. Lighting, Irrigation', ok: 'Add it' }) || '') || '';
      if (sel !== el('siCat')) return;         // the form was closed meanwhile
      if (cat && !Array.from(sel.options).some(o => o.value === cat)) {
        const o = document.createElement('option');
        o.value = cat; o.textContent = cat;
        sel.insertBefore(o, sel.querySelector('option[value="__new"]'));
      }
      sel.value = cat;
      const r = window.YDPricing && window.YDPricing.rules ? (window.YDPricing.rules().categories || {})[cat] : null;
      const hint = el('siCatHint');
      if (hint) {
        hint.hidden = !cat || !!(r && r.markupPct != null);
        hint.textContent = 'New kind. Set its markup and waste on ⋯ → Pricing rules (or this item’s own below), ' +
          'or estimates will say it has no markup.';
      }
    }
    const rental = isRental({ category: cat });
    const row = el('spRentalRow'); if (row) row.hidden = !rental;
    const per = el('spPer'); if (rental && per && !per.value.trim() && cat === 'rental') per.value = 'day';
  };

  // The bag weight read off the name, as the box's placeholder.
  function packHint(it) {
    const lb = window.YDMatch && YDMatch.packFromName ? YDMatch.packFromName(it.name) : null;
    return lb ? lb + ' — from its name' : 'e.g. 50 — for a bag sold by weight';
  }
  // Ticked as he left it; untouched, on for seed (supplymatch.js pack).
  function partUseOn(it) {
    if (typeof it.partUse === 'boolean') return it.partUse;
    return !!(window.YDMatch && YDMatch.pack && YDMatch.pack(it, prices[it.id]).part);
  }

  function field(label, id, value, ph, mode) {
    return '<div class="field"><span class="label">' + label + '</span>' +
      '<input id="' + id + '" value="' + esc(value || '') + '" placeholder="' + esc(ph || '') + '"' +
      (mode ? ' inputmode="' + mode + '"' : '') + '></div>';
  }
  function actions(removeCall) {
    return '<div class="field-actions">' +
      '<button class="btn btn-filled" onclick="supSave()">Save</button>' +
      '<button class="btn btn-sm" onclick="closeSupModal()">Cancel</button>' +
      (removeCall ? '<button class="btn btn-sm sup-delete" onclick="' + removeCall + '">Delete</button>' : '') +
    '</div>';
  }

  window.supSave = function () {
    if (!edits() || !editing) return;
    const now = new Date().toISOString();
    if (editing.kind === 'vendor') {
      const name = val('svName');
      if (!name) { showToast('Give the supplier a name'); return; }
      const typedSite = val('svWeb');
      const website = websiteUrl({ website: typedSite });
      if (typedSite && !website) { showToast('That website doesn’t look right — e.g. theirsite.com'); return; }
      const id = editing.id || newId('v');
      const a = window.YDAddr && el('svAStreet') ? YDAddr.read('svA') : { address: val('svAddr'), street: '', city: '', state: '', zip: '' };
      const rec = { name: name, address: a.address, street: a.street, city: a.city, state: a.state, zip: a.zip,
                    phone: val('svPhone'), hours: val('svHours'),
                    email: val('svEmail').toLowerCase(), website: website,
                    buyWays: Array.from(document.querySelectorAll('.svWay:checked')).map(i => i.value),
                    leadTime: val('svLead').slice(0, 80),
                    notes: (el('svNotes').value || '').trim(), updatedAt: now };
      vendors[id] = Object.assign({ id: id }, rec);
      write('vendors', id, rec);
      showToast(name + ' saved');
      closeSupModal(); renderResults();
      return;
    }

    const name = val('siName');
    if (!name) { showToast('Say what the item is'); return; }
    // The price is checked before anything is saved, so a typo in it does not
    // leave the item saved and the price silently dropped.
    const s = editing.priceShown || {};
    const typed = { price: val('spPrice'), per: val('spPer'), year: val('spYear'), notes: (el('spNotes').value || '').trim(),
                    markup: val('spMarkup'), waste: val('spWaste'), client: val('spClient') };
    RENTAL_RATES.forEach(([, , f]) => { typed[f] = val('spR' + f); });
    const pricingTouched = typed.markup !== s.markup || typed.waste !== s.waste || typed.client !== s.client ||
      RENTAL_RATES.some(([, , f]) => typed[f] !== (s[f] || ''));
    const priceTouched = typed.price !== s.price || typed.per !== s.per || typed.year !== s.year || typed.notes !== s.notes || pricingTouched;
    const cents = parseCents(typed.price);
    if (priceTouched && Number.isNaN(cents)) { showToast('The price should look like 89.99'); return; }
    const year = validYear(typed.year);
    if (priceTouched && !year) { showToast('The year should look like ' + thisYear()); return; }
    const markupPct = parsePct(typed.markup), wastePct = parsePct(typed.waste), clientCents = parseCents(typed.client);
    const rentalRates = {};
    RENTAL_RATES.forEach(([k, , f]) => { rentalRates[k] = parseCents(typed[f]); });
    if ([markupPct, wastePct, clientCents].concat(Object.values(rentalRates)).some(n => Number.isNaN(n))) {
      showToast('Markup, waste, customer price and rental rates should be numbers'); return;
    }
    const coverage = parsePct(val('siCover'));
    if (Number.isNaN(coverage) || coverage !== null && !(coverage > 0)) { showToast('“Covers” should be a number above 0, or blank'); return; }
    const packTyped = parsePct(val('siPackLb'));
    if (Number.isNaN(packTyped) || packTyped !== null && !(packTyped > 0)) { showToast('The bag weight should be a number of pounds above 0, or blank'); return; }
    const link = websiteUrl({ website: val('siLink') });
    if (val('siLink') && !link) { showToast('That link doesn’t look right — paste the page’s address'); return; }

    const id = editing.id || newId('s');
    const rec = { name: name, also: val('siAlso'), vendorId: val('siVendor') || null, sku: val('siSku'),
                  where: val('siWhere'), unit: val('siUnit'), notes: (el('siNotes').value || '').trim(), link: link,
                  category: val('siCat') || null, coverage: coverage, takeoffUnit: val('siTakeoff'),
                  pallet: !!(el('siPallet') && el('siPallet').checked),
                  specialOrder: !!(el('siSpecial') && el('siSpecial').checked),
                  // null: his rules say (pricing.js wayOf).
                  getWay: ['delivered', 'pickup'].indexOf(val('siWay')) !== -1 ? val('siWay') : null,
                  usedFor: usedForFromForm(name), updatedAt: now };
    // Kept only where he set something other than what the app works out by
    // itself, so a renamed bag ("… 40 lb") or a change of kind still counts.
    const fromName = window.YDMatch && YDMatch.packFromName ? YDMatch.packFromName(name) : null;
    rec.packLb = packTyped !== null && packTyped !== fromName ? packTyped : null;
    const partTick = el('siPartUse') ? !!el('siPartUse').checked : null;
    const partAuto = !!(window.YDMatch && YDMatch.pack &&
      YDMatch.pack(Object.assign({}, rec, { partUse: null }), { per: typed.per || (prices[editing.id] || {}).per }).part);
    rec.partUse = partTick === null || partTick === partAuto ? null : partTick;
    items[id] = Object.assign({ id: id }, rec);
    write('supplies', id, rec);
    // Written only when the price box was actually changed. If this device
    // had not received the prices yet, an untouched (blank-looking) box must
    // not wipe the real price.
    if (priceTouched) {
      const next = applyPrice(prices[id], Object.assign({
        cents: typed.price !== s.price || typed.year !== s.year ? cents : undefined,
        per: typed.per, year: year, priceNotes: typed.notes,
      }, pricingTouched ? Object.assign({ markupPct: markupPct, wastePct: wastePct, clientCents: clientCents },
                                        rentalRates) : {}));
      logPrices(priceChanges(id, prices[id], next));
      prices[id] = next;
      write('supplyPrices', id, next);
    }
    showToast(name + ' saved');
    closeSupModal(); renderResults();
  };

  function tagBoxHtml(t, on) {
    const u = tagInfo(t);
    return '<label class="sup-tagchk"><input type="checkbox" class="siUse" value="' + esc(t) + '"' + (on ? ' checked' : '') + '> ' +
      u.icon + ' ' + esc(u.name) + '</label>';
  }
  // A tag typed on the item: ticks the one it means, or adds it as new.
  window.supAddTag = function () {
    const inp = el('siNewTag'), box = el('siUses');
    const t = tagFor(inp ? inp.value : '');
    if (!t || !box) return;
    const have = Array.from(box.querySelectorAll('.siUse')).find(i => i.value === t);
    if (have) have.checked = true;
    else box.insertAdjacentHTML('beforeend', tagBoxHtml(t, true));
    inp.value = '';
    inp.focus();
  };

  // The Used for ticks as saved: null (follow the kind) unless they were
  // changed to something the kind would not give -- so an item left alone
  // still moves when its kind is changed.
  function usedForFromForm(name) {
    const ticked = Array.from(document.querySelectorAll('.siUse:checked')).map(i => cleanTag(i.value)).filter(Boolean);
    const same = (a, b) => a.slice().sort().join() === b.slice().sort().join();
    if (!ticked.length || (editing.usesAuto && same(ticked, editing.usesShown || []))) return null;
    return same(ticked, usesFromKind(val('siCat'), name, val('siAlso'))) ? null : ticked;
  }

  window.supRemove = async function (kind, id) {
    if (kind === 'vendor') {
      const v = vendors[id];
      const using = Object.values(items).filter(it => it.vendorId === id).length;
      if (!v || !(await ydConfirm(using ? using + ' item(s) will show “No supplier set” until you pick another.' : '',
        { title: 'Delete ' + v.name + '?', ok: 'Delete', danger: true }))) return;
      if (!vendors[id]) return;
      delete vendors[id];
      if (shown === id) shown = '';
      remove([['vendors', id]]);
    } else {
      const it = items[id];
      if (!it || !(await ydConfirm('Its price goes with it.', { title: 'Delete ' + it.name + '?', ok: 'Delete', danger: true }))) return;
      if (!items[id]) return;
      delete items[id];
      delete prices[id];
      // The item and its price go together, or a price would be left behind
      // for an item nobody can see.
      remove([['supplies', id], ['supplyPrices', id]]);
    }
    closeSupModal(); renderResults();
  };

  // -------------------------------------------------------------- price list

  // Columns a pasted sheet may use. Matching ignores case and punctuation,
  // so "Item #", "item#" and "ITEM #" are all the item number.
  // Suppliers' own sheets name their columns every which way, so the common
  // ones are all here.
  const COLUMNS = {
    id: ['id'],
    vendor: ['supplier', 'vendor', 'store', 'bought from'],
    name: ['item', 'name', 'what it is', 'product', 'description', 'material', 'item description',
           'product description', 'item name', 'product name', 'desc'],
    sku: ['item #', 'item#', 'item no', 'item number', 'sku', 'part #', 'part#', 'part number', 'product #', 'code',
          'item code', 'product code', 'part', 'part no', 'catalog #', 'cat #', 'model', 'model #', 'style', 'style #'],
    unit: ['comes in', 'unit', 'size', 'uom', 'pack', 'u m', 'unit of measure', 'pkg', 'package'],
    price: ['price', 'cost', 'unit price', 'price each', 'each', 'new price', 'list price', 'net price', 'your price',
            'contractor price', 'dealer price', 'sale price', 'unit cost', 'cost each', 'price ea', 'price unit',
            'price per unit', 'retail', 'retail price'],
    per: ['per', 'price per', 'price is per'],
    year: ['year', 'price year', 'for year'],
    notes: ['notes', 'crew notes', 'notes for the crew'],
    priceNotes: ['price notes', 'pricing notes', 'owner notes'],
    where: ['where', 'where at the supplier', 'location', 'aisle'],
    also: ['also called', 'also', 'other names', 'aka'],
    link: ['link', 'url', 'web link', 'product link', 'product url', 'product page', 'web address', 'link to it online'],
    usedFor: ['used for', 'tags', 'tag', 'used for tags'],
    // For estimates (pricing.js). Names as they read once "%" and the like
    // are taken out of the header.
    category: ['category', 'kind of material'],
    coverage: ['covers', 'one covers', 'coverage'],
    takeoffUnit: ['takeoff unit', 'covers what', 'of what'],
    pallet: ['pallet', 'on a pallet', 'palletized', 'comes on a pallet'],
    specialOrder: ['special order'],
    getWay: ['how we get it', 'delivered or picked up', 'delivery or pickup', 'pickup or delivery'],
    markupPct: ['markup', 'markup pct'],
    wastePct: ['waste', 'waste pct'],
    clientEach: ['customer price each', 'customer price', 'client price each'],
    // A rental's rates, as a rental house's sheet heads them. "Day" is the
    // price itself (per day) when the sheet has no Price column.
    day: ['day', 'daily', 'day rate', 'per day', '1 day'],
    halfDay: ['half day', 'half day rate', '4 hour', '4 hours', '4 hr'],
    weekend: ['weekend', 'wknd', 'weekend rate'],
    week: ['week', 'weekly', 'week rate', 'per week', '1 week'],
    month: ['month', 'monthly', 'month rate', 'per month', '4 week', '4 weeks', '28 day', '28 days'],
  };
  function headerKey(h) {
    // "½ Day" and "1/2 Day" lose the half to the cleaning below.
    if (/½|\b1\s*\/\s*2\b/.test(String(h || ''))) return 'halfDay';
    const t = norm(h).replace(/[^a-z0-9#]+/g, ' ').trim();
    for (const k in COLUMNS) if (COLUMNS[k].indexOf(t) !== -1) return k;
    return null;
  }

  // CSV from a file or Excel/Sheets, or tab-separated text pasted straight out
  // of a spreadsheet. Quoted cells may hold commas, quotes and line breaks.
  function parseTable(text) {
    text = String(text || '').replace(/^﻿/, '');
    // Judged on the first thirty lines, not the first: a supplier's sheet
    // opens with a title line that has no separators in it at all.
    const sample = text.split(/\r?\n/, 30).join('\n');
    const count = ch => sample.split(ch).length - 1;
    const delim = count('\t') ? '\t' : (count(';') > count(',') ? ';' : ',');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += c;
      } else if (c === '"' && cell === '') {
        quoted = true;
      } else if (c === delim) {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // A downloaded list guards text that starts with = + - @ with an
    // apostrophe, so a spreadsheet cannot run it as a formula; take it off.
    return rows
      .map(r => r.map(c => c.trim().replace(/^'(?=[=+\-@])/, '')))
      .filter(r => r.some(c => c !== ''));
  }

  // A supplier's sheet often opens with its name, address and "Prices
  // effective…" before the column names. The line with the column names is
  // the first that has an item (or item number) column -- preferably one with
  // a price column too -- within the first 25.
  function findHeader(table) {
    let firstNamed = -1;
    for (let i = 0; i < Math.min(table.length, 25); i++) {
      const keys = table[i].map(headerKey);
      const named = keys.indexOf('name') !== -1 || keys.indexOf('id') !== -1 || keys.indexOf('sku') !== -1;
      if (named && keys.indexOf('price') !== -1) return i;
      if (named && firstNamed < 0) firstNamed = i;
    }
    return firstNamed < 0 ? 0 : firstNamed;
  }

  // Work out what an import would do, without doing any of it. With a
  // supplier given (the price list opened from its card), every row is that
  // supplier's: no Supplier column is needed, and rows are matched only
  // against what is already bought there.
  function buildPlan(table, defaultYear, forcedVendor) {
    // Line numbers in messages are the sheet's own, title lines included.
    const skippedLines = findHeader(table);
    table = table.slice(skippedLines);
    if (table.length < 2) return { error: 'Paste the column names on the first line and at least one item below them.' };
    const head = table[0].map(headerKey);
    if (head.indexOf('name') === -1 && head.indexOf('id') === -1 && !(forcedVendor && head.indexOf('sku') !== -1)) {
      return { error: 'No line with an “Item” (or “Description”) column was found. ' +
        'The first line reads: ' + table[0].slice(0, 6).join(', ') };
    }
    const vendorByKey = {};
    Object.values(vendors).forEach(v => { vendorByKey[key(v.name)] = v.id; });
    const itemByKey = {};
    const remember = (id, vendorId, name, sku) => {
      if (name) itemByKey[(vendorId || '') + '|' + key(name)] = id;
      if (sku) itemByKey[(vendorId || '') + '#' + key(sku)] = id;
    };
    Object.values(items).forEach(it => remember(it.id, it.vendorId, it.name, it.sku));

    const out = { rows: [], newVendors: [], skipped: [], dupes: 0, defaultYear: defaultYear };
    const newVendors = {};
    const rowAt = {};
    for (let r = 1; r < table.length; r++) {
      const line = r + 1 + skippedLines;
      const c = {};
      head.forEach((k, i) => { if (k && c[k] == null) c[k] = table[r][i] || ''; });
      // On a supplier's sheet "Unit" is what the price is per ("sq ft",
      // "bag"), unless the sheet says that separately.
      if (forcedVendor && !c.per && c.unit) c.per = c.unit;

      const existingById = c.id && items[c.id] ? items[c.id] : null;
      let vendorId = existingById ? existingById.vendorId || null : null;
      if (forcedVendor) {
        // A row from our own downloaded list that belongs to someone else
        // is not this supplier's to change.
        if (existingById && existingById.vendorId && existingById.vendorId !== forcedVendor) {
          out.skipped.push('Line ' + line + ': “' + existingById.name + '” is bought from ' +
            ((vendors[existingById.vendorId] || {}).name || 'another supplier'));
          continue;
        }
        vendorId = forcedVendor;
      } else if (c.vendor) {
        const vk = key(c.vendor);
        vendorId = vendorByKey[vk] || null;
        if (!vendorId) {
          if (!newVendors[vk]) newVendors[vk] = { id: newId('v'), name: c.vendor };
          vendorId = newVendors[vk].id;
        }
      }
      // A rental sheet's Day column is the price, per day.
      if (!c.price && c.day && !/^\s*(n\/?a|-+|—)\s*$/i.test(c.day)) { c.price = c.day; if (!c.per) c.per = 'day'; }
      let id = existingById ? c.id : null;
      const byId = !!id;
      if (!id && c.sku) id = itemByKey[(vendorId || '') + '#' + key(c.sku)] || null;
      if (!id && c.name) id = itemByKey[(vendorId || '') + '|' + key(c.name)] || null;
      const isNew = !id;
      // A sheet's section headings ("PAVERS") and filler rows carry no price.
      // On a supplier's own sheet a line we do not know with no price is not
      // an item to add -- there is nothing on it worth saving.
      if (isNew && forcedVendor && !c.price) continue;
      if (isNew && !c.name) { out.skipped.push('Line ' + line + ': no item name'); continue; }

      const cents = parseCents(c.price);
      if (Number.isNaN(cents)) { out.skipped.push('Line ' + line + ': the price “' + c.price + '” is not a number'); continue; }
      if (c.year && !validYear(c.year)) { out.skipped.push('Line ' + line + ': the year “' + c.year + '” is not a year'); continue; }
      const year = validYear(c.year) || defaultYear;
      // The estimate columns: blank leaves a value as it is.
      const extra = {}, pricing = {};
      let bad = null;
      if (c.category) { const cat = categoryId(c.category); if (cat === undefined) bad = 'the kind “' + c.category + '” is not one Job Hub knows'; else extra.category = cat; }
      if (c.coverage) { const n = parsePct(c.coverage); if (!(n > 0)) bad = '“covers” should be a number above 0'; else extra.coverage = n; }
      if (c.takeoffUnit) extra.takeoffUnit = c.takeoffUnit;
      if (c.link) { const page = websiteUrl({ website: c.link }); if (!page) bad = 'the link “' + c.link + '” is not a web address'; else extra.link = page; }
      // Tags, split on ; or , -- kept as the item's own only when they are not
      // just what its kind gives.
      if (c.usedFor) {
        const tags = c.usedFor.split(/[;,]/).map(tagFor).filter((t, i, a) => t && a.indexOf(t) === i);
        const was = existingById || (id ? items[id] : null) || {};
        const auto = usesFromKind(extra.category !== undefined ? extra.category : was.category, c.name || was.name, c.also || was.also);
        extra.usedFor = !tags.length || sameSet(tags, auto) ? null : tags;
      }
      [['pallet', 'pallet'], ['specialOrder', 'special order']].forEach(([k, label]) => {
        if (!c[k]) return;
        const yn = yesNo(c[k]);
        if (yn === undefined) bad = label + ' should be yes or no'; else extra[k] = yn;
      });
      // Delivered, picked up, or "rules" (his rules say: Pricing rules).
      if (c.getWay) {
        const w = String(c.getWay).toLowerCase();
        if (/deliver/.test(w)) extra.getWay = 'delivered';
        else if (/pick/.test(w)) extra.getWay = 'pickup';
        else if (/rule/.test(w)) extra.getWay = null;
        else bad = '“how we get it” should be delivered, picked up or rules';
      }
      [['markupPct', 'markup'], ['wastePct', 'waste']].forEach(([k, label]) => {
        if (!c[k]) return;
        const n = parsePct(c[k]);
        if (Number.isNaN(n)) bad = 'the ' + label + ' “' + c[k] + '” is not a number'; else pricing[k] = n;
      });
      if (c.clientEach) {
        const n = parseCents(c.clientEach);
        if (Number.isNaN(n)) bad = 'the customer price “' + c.clientEach + '” is not a number'; else pricing.clientCents = n;
      }
      // Rental rates; "N/A" or "-" is a rate they don't offer.
      RENTAL_RATES.forEach(([k, label, f]) => {
        const raw = c[f];
        if (!raw) return;
        if (/^\s*(n\/?a|-+|—)\s*$/i.test(raw)) { pricing[k] = null; return; }
        const n = parseCents(raw);
        if (Number.isNaN(n)) bad = 'the ' + label.toLowerCase() + ' rate “' + raw + '” is not a number'; else pricing[k] = n;
      });
      if (bad) { out.skipped.push('Line ' + line + ': ' + bad); continue; }

      if (isNew) {
        id = newId('s');
        remember(id, vendorId, c.name, c.sku);   // a second row for it updates this one
      }
      const old = prices[id] || null;
      const oldCents = old && typeof old.cents === 'number' ? old.cents : null;
      const row = {
        line: line, id: id, isNew: isNew, byId: byId, vendorId: vendorId, cells: c, cents: cents, year: year,
        extra: extra, pricing: pricing,
        oldCents: oldCents, oldYear: old ? old.year || null : null,
        kind: cents == null ? 'noprice' : oldCents == null ? 'first'
          : cents > oldCents ? 'up' : cents < oldCents ? 'down' : 'same',
      };
      if (rowAt[id] != null) { out.rows[rowAt[id]] = row; out.dupes++; }
      else { rowAt[id] = out.rows.length; out.rows.push(row); }
    }
    out.newVendors = Object.values(newVendors);
    // What this supplier sells that the sheet left out -- discontinued, or
    // just on another page. Their prices stay as they are.
    if (forcedVendor) {
      const inSheet = new Set(out.rows.map(r => r.id));
      out.missing = Object.values(items).filter(it => it.vendorId === forcedVendor && !inSheet.has(it.id))
        .sort(byName);
    }
    return out;
  }

  window.supPriceList = function (vendorId) {
    if (!edits()) return;
    plan = null;
    const v = vendorId && vendors[vendorId] ? vendors[vendorId] : null;
    planVendor = v ? v.id : null;
    if (v) { vendorPriceList(v); return; }
    const priced = Object.keys(items).filter(id => prices[id] && typeof prices[id].cents === 'number');
    const years = {};
    priced.forEach(id => { years[prices[id].year] = (years[prices[id].year] || 0) + 1; });
    const moves = priced.map(id => {
      const p = prices[id], prev = lastYears(p);
      return prev ? change(p.cents, prev.cents) : null;
    }).filter(x => x != null);
    const avg = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
    openModal('Price list',
      '<div class="sup-stat">' +
        '<b>' + priced.length + '</b> of ' + Object.keys(items).length + ' items have a price' +
        (Object.keys(years).length ? ' (' + Object.keys(years).sort().map(y => years[y] + ' from ' + y).join(', ') + ')' : '') + '.' +
        (avg != null ? '<br>Compared with the year before: ' + changeHtml(avg) + ' on average, across ' + moves.length + ' items.' : '') +
      '</div>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="supExportCsv()">⬇ Download the price list</button></div>' +
      '<div class="hint">For one supplier’s own price sheet, open that supplier and use its 💲 Price list button — no Supplier column needed.</div>' +
      '<h3 class="sup-h">Update prices</h3>' +
      '<div class="hint">Paste a spreadsheet below: copied straight out of Excel or Google Sheets, or a CSV file. ' +
        'The first line must be the column names. Understood: <b>Supplier, Item, Price</b>, and optionally ' +
        'Per, Year, Comes in, Item #, Where, Also called, Notes, Price notes, id — and for estimates ' +
        'Category, Covers, Takeoff unit, Pallet, Special order, Markup %, Waste %, Customer price each — ' +
        'and for rentals Day, Half day, Weekend, Week, Month (“N/A” for a rate they don’t offer). ' +
        'Only the columns you include change; blank cells leave things as they are. ' +
        'A downloaded list keeps its id column, so each row goes back to exactly the item it came from.</div>' +
      '<div class="grid g2">' +
        field('These prices are for year (a Year column wins)', 'supImpYear', String(thisYear()), String(thisYear()), 'numeric') +
        '<div class="field"><span class="label">Or open a file</span>' +
          '<input type="file" id="supFile" accept="' + FILE_TYPES + '" onchange="supLoadFile(this)"></div>' +
      '</div>' +
      '<textarea id="supCsv" class="sup-csv" rows="7" spellcheck="false" ' +
        'placeholder="Supplier,Item,Price,Per&#10;Example Stone Yard,Grass seed — sun &amp; shade,12.50,bag"></textarea>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="supCheckImport()">Check it</button>' +
        '<button class="btn btn-sm" onclick="closeSupModal()">Close</button>' +
      '</div>' +
      '<div id="supPreview"></div>');
  };

  const FILE_TYPES = '.csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods,text/csv,text/plain,' +
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,' +
    '.pdf,application/pdf,image/*';

  // A PDF quote or a photo of a price sheet: Claude reads it on the server
  // (sheets.py) into rows, which land in the box below as if pasted, to be
  // checked like any sheet. Photos are shrunk first -- a phone photo is
  // bigger than Claude takes, and the words read just as well at 2000 px.
  function shrinkPhoto(file) {
    return new Promise((ok, fail) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok({ mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.88).split(',')[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('That photo could not be opened')); };
      img.src = url;
    });
  }
  function asBase64(file) {
    return new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok({ mediaType: 'application/pdf', data: String(r.result || '').split(',')[1] || '' });
      r.onerror = () => fail(new Error('That file could not be read'));
      r.readAsDataURL(file);
    });
  }
  let reading = false;
  async function readSheet(f) {
    if (reading) return;
    if (!window.YDClaude || !window.YDClaude.available()) { showToast('Reading a PDF or photo needs a connection and sign-in'); return; }
    if (f.size > 20 * 1024 * 1024) { showToast('That file is over 20 MB — send fewer pages'); return; }
    const box = el('supPreview');
    const v = planVendor ? vendors[planVendor] : null;
    // Whose prices they are has to be known: a supplier's own Price list.
    if (!v) { showToast('Open the supplier on Supplies and use its own 💲 Price list to read a PDF or photo'); return; }
    reading = true;
    if (box) box.innerHTML = '<p class="empty-msg">Claude is reading “' + esc(f.name) + '” — a page takes about a minute…</p>';
    try {
      const file = /^image\//.test(f.type) ? await shrinkPhoto(f) : await asBase64(f);
      const known = Object.values(items).filter(it => it.vendorId === v.id).map(it => it.name);
      const r = await window.YDClaude.post('/supplies/read-sheet', Object.assign({ vendor: v.name, known: known, fileName: f.name }, file));
      if (planVendor !== v.id) return;      // the window was closed or moved on meanwhile
      const cell = s => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
      const head = ['Item #', 'Item', 'Comes in', 'Price', 'Per', 'Category', 'Notes', 'Price notes'];
      const rows = (r.rows || []).map(x => [cell(x.itemNo), cell(x.item), cell(x.comesIn),
        String(x.price), cell(x.per), cell(x.category), cell(x.notes), cell(x.priceNotes)].join('\t'));
      const t = el('supCsv'); if (t) t.value = [head.join('\t')].concat(rows).join('\n');
      if (box) box.innerHTML = '<div class="sup-stat">Claude read <b>' + rows.length + '</b> priced row' + (rows.length === 1 ? '' : 's') +
        ' from “' + esc(f.name) + '”. Look them over in the box above, then press <b>Check it</b> — nothing is saved until you do.' +
        (r.notes ? '<br><span class="muted">' + esc(r.notes) + '</span>' : '') +
        ((r.unreadable || []).length ? '<br><b>Could not read:</b> ' + r.unreadable.map(esc).join('; ') : '') + '</div>';
    } catch (e) {
      if (box) box.innerHTML = '<p class="empty-msg">' + esc(e.message || String(e)) + '</p>';
    } finally {
      reading = false;
    }
  }

  // One supplier's own price sheet, from that supplier's card.
  function vendorPriceList(v) {
    const mine = Object.values(items).filter(it => it.vendorId === v.id);
    const priced = mine.filter(it => prices[it.id] && typeof prices[it.id].cents === 'number');
    openModal('Price list — ' + v.name,
      '<div class="sup-stat"><b>' + priced.length + '</b> of ' + mine.length + ' ' + esc(v.name) +
        ' item' + (mine.length === 1 ? '' : 's') + ' have a price.</div>' +
      '<div class="hint">Upload ' + esc(v.name) + '’s price sheet as it comes — their Excel file or a CSV, or a PDF quote ' +
        'or a photo of a price sheet (Claude reads those, a few pages at a time) — or ' +
        'paste it straight out of a spreadsheet. No Supplier column needed: everything in it is taken as ' +
        esc(v.name) + '’s. Title lines at the top are skipped; the line with the column names is found by itself ' +
        '(an Item or Description column, and Price — optionally Item #, Per, Comes in, Year). ' +
        'Rows are matched to what you already buy here by item number, then by name; anything new is listed ' +
        'before anything is saved.</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Their file</span>' +
          '<input type="file" id="supFile" accept="' + FILE_TYPES + '" onchange="supLoadFile(this)"></div>' +
        field('These prices are for year (a Year column wins)', 'supImpYear', String(thisYear()), String(thisYear()), 'numeric') +
      '</div>' +
      '<textarea id="supCsv" class="sup-csv" rows="7" spellcheck="false" ' +
        'placeholder="Item #,Description,Price,Unit&#10;EX-100,Example paver 60mm grey,1.00,sq ft"></textarea>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="supCheckImport()">Check it</button>' +
        '<button class="btn btn-sm" onclick="supExportCsv(\'' + safeId(v.id) + '\')">⬇ Download ' + esc(v.name) + '’s list</button>' +
        '<button class="btn btn-sm" onclick="closeSupModal()">Close</button>' +
      '</div>' +
      '<div id="supPreview"></div>');
  }

  // Excel files are read with SheetJS, fetched only when one is opened. The
  // copy is pinned to one version and checked against the hash cdnjs
  // publishes for it, so a changed file is refused rather than run.
  const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const XLSX_SRI = 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==';
  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = XLSX_SRC;
      s.integrity = XLSX_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.XLSX ? ok(window.XLSX) : fail(new Error('not loaded')));
      s.onerror = () => { xlsxLoading = null; fail(new Error('could not load')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  window.supLoadFile = function (input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    const put = text => { const t = el('supCsv'); if (t) t.value = text; };
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf' || /^image\//.test(f.type)) {
      readSheet(f);
      return;
    }
    if (/\.(xlsx|xlsm|xls|ods)$/i.test(f.name)) {
      showToast('Reading ' + f.name + '…');
      const r = new FileReader();
      r.onerror = () => showToast('That file could not be read');
      r.onload = () => {
        loadXlsx().then(XLSX => {
          const wb = XLSX.read(new Uint8Array(r.result), { type: 'array' });
          // The sheet with the most rows is the price list; a workbook often
          // has a cover sheet or a notes sheet besides.
          let best = null, bestRows = -1;
          wb.SheetNames.forEach(n => {
            const ws = wb.Sheets[n];
            const rows = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).e.r + 1 : 0;
            if (rows > bestRows) { best = n; bestRows = rows; }
          });
          // Tab-separated, so commas inside names and prices stay put.
          put(XLSX.utils.sheet_to_csv(wb.Sheets[best], { FS: '\t', blankrows: false }));
          showToast('Read “' + best + '”' + (wb.SheetNames.length > 1 ? ' (the biggest of ' + wb.SheetNames.length + ' sheets)' : '') +
            ' — now press Check it');
        }).catch(() => showToast('Excel files need a connection the first time — or save it as CSV and open that'));
      };
      r.readAsArrayBuffer(f);
      return;
    }
    const r = new FileReader();
    r.onload = () => put(String(r.result || ''));
    r.onerror = () => showToast('That file could not be read');
    r.readAsText(f);
  };

  window.supCheckImport = function () {
    const box = el('supPreview');
    if (!box) return;
    // History is built from the prices already saved. Working from a device
    // that has not heard from the server yet could file last year's price
    // under the wrong year -- or drop it.
    if (!pricesReady) {
      box.innerHTML = '<p class="empty-msg">Still loading the current prices from the cloud — try again in a moment. ' +
        '(This needs a connection.)</p>';
      return;
    }
    const year = validYear(val('supImpYear'));
    if (!year) { showToast('The year should look like ' + thisYear()); return; }
    plan = buildPlan(parseTable(el('supCsv').value), year, planVendor);
    if (plan.error) { box.innerHTML = '<p class="empty-msg">' + esc(plan.error) + '</p>'; plan = null; return; }

    const n = k => plan.rows.filter(r => r.kind === k).length;
    const added = plan.rows.filter(r => r.isNew).length;
    const nameOf = r => r.cells.name || (items[r.id] || {}).name || '';
    const vendorName = r => (vendors[r.vendorId] || plan.newVendors.find(v => v.id === r.vendorId) || {}).name || '—';
    const listed = plan.rows.filter(r => r.kind !== 'same' && r.kind !== 'noprice' || r.isNew)
      .sort((a, b) => vendorName(a).localeCompare(vendorName(b)) || nameOf(a).localeCompare(nameOf(b)));
    const same = plan.rows.length - listed.length;
    box.innerHTML =
      '<div class="sup-plan">' +
        [[n('up'), 'going up', 'up'], [n('down'), 'going down', 'down'], [n('same'), 'unchanged', ''],
         [n('first'), 'first price', ''], [added, 'new items', ''], [plan.newVendors.length, 'new suppliers', ''],
         [plan.skipped.length, 'skipped', 'warn']]
          .filter(x => x[0]).map(x => '<span class="sup-pill ' + x[2] + '"><b>' + x[0] + '</b> ' + x[1] + '</span>').join('') +
      '</div>' +
      (plan.newVendors.length ? '<div class="hint">New suppliers will be added: ' +
        plan.newVendors.map(v => '<b>' + esc(v.name) + '</b>').join(', ') +
        '. If one is a supplier you already have under another name, change the name in the sheet to match and check again.</div>' : '') +
      (plan.skipped.length ? '<div class="sup-skip">' + plan.skipped.map(esc).join('<br>') + '</div>' : '') +
      (plan.dupes ? '<div class="hint">' + plan.dupes + ' item(s) appear twice; the lower line wins.</div>' : '') +
      (plan.missing && plan.missing.length
        ? '<details class="sup-missing"><summary>' + plan.missing.length + ' of your ' +
            esc((vendors[planVendor] || {}).name || '') + ' items ' + (plan.missing.length === 1 ? 'is' : 'are') +
            ' not in this sheet — ' + (plan.missing.length === 1 ? 'its price stays' : 'their prices stay') +
            ' as ' + (plan.missing.length === 1 ? 'it is' : 'they are') + '</summary>' +
            plan.missing.map(it => esc(it.name) + (it.sku ? ' <small>#' + esc(it.sku) + '</small>' : '')).join('<br>') +
          '</details>' : '') +
      (listed.length ? '<div class="sup-table-wrap"><table class="sup-table"><thead><tr>' +
          '<th>Supplier</th><th>Item</th><th>Was</th><th>Now</th><th></th></tr></thead><tbody>' +
          listed.slice(0, 400).map(r => '<tr>' +
            '<td>' + esc(vendorName(r)) + '</td>' +
            '<td>' + esc(nameOf(r)) + (r.isNew ? ' <span class="sup-new">new</span>' : '') + '</td>' +
            '<td>' + (r.oldCents != null ? fmtCents(r.oldCents) + (r.oldYear && r.oldYear !== r.year ? ' <small>' + r.oldYear + '</small>' : '') : '—') + '</td>' +
            '<td>' + (r.cents != null ? '<b>' + fmtCents(r.cents) + '</b> <small>' + r.year + '</small>' : '—') + '</td>' +
            '<td>' + (r.kind === 'up' || r.kind === 'down' ? changeHtml(change(r.cents, r.oldCents)) : '') + '</td>' +
          '</tr>').join('') +
        '</tbody></table></div>' +
        (listed.length > 400 ? '<div class="hint">…and ' + (listed.length - 400) + ' more.</div>' : '') : '') +
      (same ? '<div class="hint">' + same + ' row(s) with no price change are not listed (any other details in them are still saved).</div>' : '') +
      (plan.rows.length
        ? '<div class="field-actions"><button class="btn btn-filled" onclick="supApplyImport()">Save these changes</button>' +
          '<button class="btn btn-sm" onclick="supPriceList(\'' + safeId(planVendor || '') + '\')">Start over</button></div>'
        : '<p class="empty-msg">Nothing to save.</p>');
  };

  window.supApplyImport = function () {
    if (!edits() || !plan || !plan.rows.length) return;
    const now = new Date().toISOString();
    const writes = [];
    const logged = [];
    let changedItems = 0;
    plan.newVendors.forEach(v => {
      const rec = { name: v.name, address: '', phone: '', hours: '', notes: '', updatedAt: now };
      vendors[v.id] = Object.assign({ id: v.id }, rec);
      writes.push(['vendors', v.id, rec]);
    });
    plan.rows.forEach(r => {
      const c = r.cells;
      // Only what the sheet fills in changes, so a sheet of just names and
      // prices leaves every location, note and item number alone.
      const rec = {};
      ['name', 'also', 'sku', 'where', 'unit', 'notes'].forEach(k => { if (c[k]) rec[k] = c[k]; });
      // A supplier's own sheet spells things its own way ("Pavers - Holland"
      // for "Pavers — Holland"). Matching by name must not rename the item
      // every year; only our own downloaded list (matched by id) renames.
      if (!r.isNew && !r.byId) delete rec.name;
      if (c.vendor && r.vendorId) rec.vendorId = r.vendorId;
      Object.assign(rec, r.extra || {});
      if (r.isNew) {
        ['name', 'also', 'sku', 'where', 'unit', 'notes'].forEach(k => { if (rec[k] == null) rec[k] = ''; });
        if (rec.vendorId == null) rec.vendorId = r.vendorId || null;
      }
      if (Object.keys(rec).length) {
        rec.updatedAt = now;
        items[r.id] = Object.assign({ id: r.id }, items[r.id] || {}, rec);
        writes.push(['supplies', r.id, rec]);
      }
      const pricing = r.pricing || {};
      if (r.cents != null || c.per || c.priceNotes || Object.keys(pricing).length) {
        const next = applyPrice(prices[r.id], Object.assign({
          cents: r.cents != null ? r.cents : undefined,
          per: c.per || null, year: r.year, priceNotes: c.priceNotes || null,
        }, pricing));
        const said = priceChanges(r.id, prices[r.id], next, 'Price list');
        if (said.length) { changedItems++; said.forEach(x => logged.push(x)); }
        prices[r.id] = next;
        writes.push(['supplyPrices', r.id, next]);
      }
    });
    const count = plan.rows.length;
    const forVendor = planVendor && vendors[planVendor] ? vendors[planVendor].name : '';
    plan = null;
    Promise.resolve(window.YDDb.putMany(writes)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[supplies] import not yet on the server:', (e && e.code) || e);
    });
    // Each item's change, and one line for the import as a whole -- so a
    // year's new price sheet is one thing to find in the history.
    if (changedItems) {
      logged.push({ area: 'price', access: 'supplies', kind: 'import', via: 'Price list',
                    what: 'Price list' + (forVendor ? ' — ' + forVendor : ''), field: 'Prices changed',
                    before: null, after: changedItems + ' item' + (changedItems === 1 ? '' : 's') });
    }
    logPrices(logged);
    showToast(count + ' item' + (count === 1 ? '' : 's') + ' updated');
    closeSupModal(); renderResults();
  };

  // The whole list as a spreadsheet, one row per item, with the id that
  // brings each row back to its item when the sheet is pasted in again.
  window.supExportCsv = function (vendorId) {
    if (!seesPrices()) return;
    const only = vendorId && vendors[vendorId] ? vendors[vendorId] : null;
    const cell = (s, isText) => {
      let t = s == null ? '' : String(s);
      if (isText && /^[=+\-@]/.test(t)) t = "'" + t;   // never a formula in Excel
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const head = ['id', 'Supplier', 'Item', 'Item #', 'Comes in', 'Price', 'Per', 'Year',
                  'Previous price', 'Previous year', 'Change', 'Where', 'Also called', 'Notes', 'Price notes',
                  'Category', 'Covers', 'Takeoff unit', 'Pallet', 'Special order', 'How we get it', 'Markup %', 'Waste %', 'Customer price each', 'Link', 'Used for',
                  'Half day', 'Weekend', 'Week', 'Month'];
    const catName = id => (id ? ((categories().find(c => c[0] === id) || [])[1]) || id : '');
    const yn = b => (b ? 'yes' : '');
    const n = v => (typeof v === 'number' ? String(v) : '');
    const vName = it => (vendors[it.vendorId] || {}).name || '';
    const rows = Object.values(items)
      .filter(it => !only || it.vendorId === only.id)
      .sort((a, b) => vName(a).localeCompare(vName(b)) || byName(a, b))
      .map(it => {
        const p = prices[it.id] || {};
        const prev = lastYears(p);
        const pct = prev ? change(p.cents, prev.cents) : null;
        return [cell(it.id), cell(vName(it), true), cell(it.name, true), cell(it.sku, true), cell(it.unit, true),
          typeof p.cents === 'number' ? (p.cents / 100).toFixed(2) : '', cell(p.per, true), p.year || '',
          prev ? (prev.cents / 100).toFixed(2) : '', prev ? prev.year : '',
          pct != null ? (pct > 0 ? '+' : '') + pct.toFixed(1) + '%' : '',
          cell(it.where, true), cell(it.also, true), cell(it.notes, true), cell(p.priceNotes, true),
          cell(catName(it.category), true), n(it.coverage), cell(it.takeoffUnit, true), yn(it.pallet), yn(it.specialOrder),
          it.getWay === 'delivered' ? 'delivered' : it.getWay === 'pickup' ? 'picked up' : '',
          n(p.markupPct), n(p.wastePct), typeof p.clientCents === 'number' ? (p.clientCents / 100).toFixed(2) : '',
          cell(it.link, true), cell(usesOf(it).map(t => tagInfo(t).name).join('; '), true)]
          .concat(RENTAL_RATES.map(([k]) => (typeof p[k] === 'number' ? (p[k] / 100).toFixed(2) : ''))).join(',');
      });
    // A byte-order mark and CRLF line endings, so Excel opens it with the
    // dashes and accents intact.
    const blob = new Blob(['﻿' + [head.join(',')].concat(rows).join('\r\n') + '\r\n'],
      { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (only ? only.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' price list ' : 'YD supplies price list ') +
      localToday() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Some browsers have not started the download when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast(rows.length + ' items downloaded');
  };

  // ---------------------------------------------------------------- plumbing

  function openModal(title, html) {
    const m = el('supModal'), t = el('supModalTitle'), b = el('supModalBody');
    if (!m || !b) return;
    if (t) t.textContent = title;
    b.innerHTML = html;
    m.classList.add('active');
    b.scrollTop = 0;
  }
  window.closeSupModal = function () {
    const m = el('supModal');
    if (m) m.classList.remove('active');
    editing = null;
    plan = null;
  };

  // Not awaited -- see the note in boards.js.
  function write(path, id, data) {
    Promise.resolve(window.YDDb.put(path, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[supplies] not yet on the server:', (e && e.code) || e);
    });
  }
  function remove(entries) {
    Promise.resolve(window.YDDb.removeMany(entries)).catch(e => console.warn('[supplies] not removed:', (e && e.code) || e));
  }

  // At most once a frame: the first load is a burst of snapshots from three
  // collections, each of which used to redraw all ~900 supplies.
  let drawQueued = 0;
  function redrawIfVisible() {
    const p = el('panel-supplies');
    if (!p || !p.classList.contains('active') || drawQueued) return;
    drawQueued = requestAnimationFrame(() => { drawQueued = 0; renderResults(); });
  }

  // Estimates re-price when Supplies changes; a burst of snapshots (the
  // first load) is told once.
  let announceTimer = null;
  function announce() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => document.dispatchEvent(new CustomEvent('yd-supplies')), 150);
  }

  // started: listening for this sign-in. The office (anyone who sees jobs --
  // estimates, pricing, orders all read Supplies) starts at sign-in; the
  // crew only when they first open the tab (render), so a phone that never
  // looks at Supplies never downloads its ~900 items.
  let started = false;
  let heard = false;          // the supplies list has answered (cache or server)
  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; items = {}; vendors = {}; prices = {}; pricesReady = false; shown = '';
    started = false; heard = false;
    tagsChanged();
  }
  function start() {
    stop();
    started = true;
    const take = (store, withId) => (changes, meta) => {
      if (store === items) heard = true;
      changes.forEach(c => {
        if (c.type === 'removed') delete store[c.id];
        else store[c.id] = withId ? Object.assign({ id: c.id }, c.data) : c.data;
      });
      if (store === prices && meta && meta.fromCache === false) pricesReady = true;
      // A supplier's name is searched by too.
      if (store !== prices) tagsChanged();
      redrawIfVisible();
      announce();
    };
    unsubs.push(window.YDDb.watch('supplies', take(items, true), () => { heard = true; redrawIfVisible(); }));
    unsubs.push(window.YDDb.watch('vendors', take(vendors, true), () => redrawIfVisible()));
    // Crew are refused the prices outright, so they never ask.
    if (seesPrices()) unsubs.push(window.YDDb.watch('supplyPrices', take(prices, false), () => redrawIfVisible()));
  }

  // parseTable is shared with the estimate price book (estimate.js), which
  // takes the same pasted-from-Excel sheets. catalog() is what estimates are
  // priced from (pricing.js); 'yd-supplies' says it changed.
  // A receipt's supplier among ours: the same name, one name inside the
  // other ("The Home Depot"), or the initials ("Midwest Decorative Stone" is
  // MDS). Then its item: by the supplier's item number, else by name (or an
  // "also called" name), punctuation ignored. With no known supplier nothing
  // is matched -- a name alone is too loose to price by. (receipts.js)
  function vendorFor(name) {
    const k = key(name);
    if (!k) return null;
    const words = norm(name).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
      .filter(w => w && ['the', 'inc', 'llc', 'co', 'company', 'corp'].indexOf(w) === -1);
    const initials = words.map(w => w[0]).join('');
    const vs = Object.values(vendors);
    return vs.find(v => key(v.name) === k) ||
      vs.find(v => { const vk = key(v.name); return vk.length >= 4 && (k.indexOf(vk) !== -1 || vk.indexOf(k) !== -1); }) ||
      (initials.length >= 2 ? vs.find(v => key(v.name) === initials) : null) || null;
  }
  function findSupply(vendorName, sku, name) {
    const v = vendorFor(vendorName);
    if (!v) return null;
    const list = Object.values(items).filter(it => it.vendorId === v.id);
    const names = it => [it.name].concat(String(it.also || '').split(/[;,]/)).map(key).filter(Boolean);
    return (sku && list.find(it => it.sku && key(it.sku) === key(sku))) ||
      (name && list.find(it => names(it).indexOf(key(name)) !== -1)) || null;
  }
  // An item's supplier item number or product page, typed where it is missing
  // (app.js, the order lists). link: kept only as a web address. -> saved.
  function setItemInfo(id, f) {
    const it = items[id];
    if (!it || !edits()) return false;
    const patch = { updatedAt: new Date().toISOString() };
    if ('sku' in f) patch.sku = String(f.sku || '').trim().slice(0, 40);
    if ('link' in f) {
      const link = String(f.link || '').trim() ? websiteUrl({ website: f.link }) : '';
      if (String(f.link || '').trim() && !link) return false;
      patch.link = link;
    }
    Object.assign(it, patch);
    Promise.resolve(window.YDDb.put('supplies', id, patch)).catch(e => {
      showToast(e && e.code === 'permission-denied' ? 'Not saved — not allowed' : 'Not on the server yet — will retry');
    });
    announce();
    return true;
  }
  // A new price for one item, filed the way the price list files it (a
  // newer year moves the old price into its history). Not awaited.
  // via: what the change came from, for the change history ("Receipt").
  function setPrice(id, cents, year, via) {
    const rec = applyPrice(prices[id], { cents: cents, year: year || thisYear() });
    logPrices(priceChanges(id, prices[id], rec, via || null));
    prices[id] = rec;
    announce();
    return Promise.resolve(window.YDDb.put('supplyPrices', id, rec));
  }

  // A material from an estimate -- a price found for it ("Source it") or an
  // item typed onto a bid ("Add typed-in items to Supplies"), estimate.js:
  // the item under its supplier -- the one already here, or added -- with
  // its price (when there is one) and where it came from in its price notes,
  // so the next bid finds it in Supplies. Returns the item's id. Not awaited.
  // One unit however it is written ("sq. ft" = "sf", "Tons" = "ton"), so a
  // price per box is never filed on an item bought by the piece.
  function unitWord(u) {
    const s = norm(u).replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const table = [[/^(each|ea|pc|pcs|piece|pieces|unit|units)$/, 'each'], [/^(sq ?ft|sf|square f(ee|oo)t)$/, 'sqft'],
      [/^(lf|lin ?ft|linear f(ee|oo)t|ft|feet|foot)$/, 'lf'], [/^(tons?|t)$/, 'ton'],
      [/^(yards?|yds?|cu ?yds?|cubic yards?)$/, 'yd'], [/^(cu ?ft|cubic f(ee|oo)t)$/, 'cuft'], [/^(gal|gallons?)$/, 'gal'],
      [/^(days?|daily|per day|day rate)$/, 'day']];
    const hit = table.find(([re]) => re.test(s));
    return hit ? hit[1] : s.replace(/s$/, '');
  }
  // A supplier by its name, strictly: the same name, or one name inside the
  // other ("Home Depot" / "The Home Depot") -- never by initials, which could
  // file a new supplier's items under the wrong one.
  function vendorNamed(name) {
    const k = key(name);
    if (!k) return null;
    const vs = Object.values(vendors);
    return vs.find(v => key(v.name) === k) ||
      vs.find(v => { const vk = key(v.name); return vk.length >= 4 && k.length >= 4 && (k.indexOf(vk) !== -1 || vk.indexOf(k) !== -1); }) || null;
  }
  function addSourced(o) {
    if (!edits() || !o || !String(o.vendor || '').trim() || !String(o.name || '').trim()) return null;
    if (o.cents != null && !(o.cents > 0)) return null;
    const now = new Date().toISOString(), writes = [];
    let v = (o.vendorId && vendors[o.vendorId]) || vendorNamed(o.vendor);
    if (!v) {
      const id = newId('v');
      // The shop's own site, from the page the price came from.
      const site = websiteUrl({ website: o.url });
      const rec = { name: String(o.vendor).trim().slice(0, 80), address: '', phone: '', hours: '',
                    website: site ? new URL(site).origin : '',
                    notes: 'Added when sourcing an estimate', updatedAt: now };
      vendors[id] = Object.assign({ id: id }, rec);
      v = vendors[id];
      writes.push(['vendors', id, rec]);
    }
    // The line's own item, when the price is from its supplier (an MDS item
    // with no price, priced from MDS's page) -- not a second copy of it.
    const inVendor = (sku, name) => {
      const list = Object.values(items).filter(x => x.vendorId === v.id);
      const names = x => [x.name].concat(String(x.also || '').split(/[;,]/)).map(key).filter(Boolean);
      return (sku && list.find(x => x.sku && key(x.sku) === key(sku))) || list.find(x => names(x).indexOf(key(name)) !== -1) || null;
    };
    const per = String(o.per || '').trim();
    // An item already here takes the price only when it is sold the same way;
    // "Fabric" at $90 a roll is not re-priced at 12 cents a sq ft. Otherwise
    // the product goes in as its own item, named with how it is sold.
    const fits = x => { const was = (prices[x.id] || {}).per || x.unit; return !per || !was || unitWord(was) === unitWord(per); };
    let it = o.into && items[o.into] && items[o.into].vendorId === v.id ? items[o.into] : inVendor(o.sku || '', o.name);
    let name = String(o.name).trim();
    if (it && !fits(it)) {
      name = name + ' (per ' + per + ')';
      it = inVendor('', name);
    }
    // Sold by the bag/roll/box but measured in sq ft (or LF...): how much
    // one covers, so the estimate orders whole packages.
    const covers = Number(o.coverage) > 0 && String(o.takeoffUnit || '').trim();
    // The product's own page, where the price came from -- kept on an item
    // that has no link yet, never over one typed in by hand.
    const link = websiteUrl({ website: o.url });
    // Its item number too, on one that has none.
    const sku = String(o.sku || '').trim().slice(0, 40);
    if (it && ((covers && !(Number(it.coverage) > 0)) || (link && !it.link) || (sku && !it.sku))) {
      const patch = { updatedAt: now };
      if (covers && !(Number(it.coverage) > 0)) Object.assign(patch, { coverage: Number(o.coverage), takeoffUnit: String(o.takeoffUnit).trim().slice(0, 30) });
      if (link && !it.link) patch.link = link;
      if (sku && !it.sku) patch.sku = sku;
      Object.assign(it, patch);
      writes.push(['supplies', it.id, patch]);
    }
    if (!it) {
      const id = newId('s');
      const rec = { name: name.slice(0, 120), also: '', sku: String(o.sku || '').trim().slice(0, 40),
                    where: '', notes: String(o.notes || '').trim().slice(0, 300),
                    unit: String(o.per || o.unit || '').trim().slice(0, 30), vendorId: v.id,
                    category: categoryId(o.category) || null,
                    coverage: covers ? Number(o.coverage) : null,
                    takeoffUnit: covers ? String(o.takeoffUnit).trim().slice(0, 30) : '', link: link, updatedAt: now };
      items[id] = Object.assign({ id: id }, rec);
      it = items[id];
      writes.push(['supplies', id, rec]);
    }
    if (o.cents > 0) {
      const next = applyPrice(prices[it.id], { cents: Math.round(o.cents), per: per || null,
                                               year: thisYear(), priceNotes: String(o.note || '').slice(0, 300) || null });
      logPrices(priceChanges(it.id, prices[it.id], next, 'Estimate'));
      prices[it.id] = next;
      writes.push(['supplyPrices', it.id, next]);
    }
    if (!writes.length) return it.id;
    Promise.resolve(window.YDDb.putMany(writes)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[supplies] sourced price not yet on the server:', (e && e.code) || e);
    });
    announce();
    return it.id;
  }

  // One of Jonah's kinds renamed (Pricing rules → ✎ Rename): every item of
  // that kind moves to the new name. Returns how many.
  function renameKind(was, to) {
    if (!edits() || !was || !to || was === to) return 0;
    const now = new Date().toISOString(), writes = [];
    Object.values(items).forEach(it => {
      // "lighting" on one item and "Lighting" on another are the same kind.
      if (!it.category || key(it.category) !== key(was) || it.category === to) return;
      it.category = to;
      writes.push(['supplies', it.id, { category: to, updatedAt: now }]);
    });
    if (writes.length) {
      Promise.resolve(window.YDDb.putMany(writes)).catch(e => {
        if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
        else console.warn('[supplies] kind rename not yet on the server:', (e && e.code) || e);
      });
      tagsChanged();
      redrawIfVisible();
    }
    return writes.length;
  }

  window.YDSupplies = {
    render: render, parseTable: parseTable, parseCents: parseCents,
    catalog: () => ({ items: items, prices: prices, vendors: vendors, pricesReady: pricesReady }),
    findSupply: findSupply, setPrice: setPrice, addSourced: addSourced, setItemInfo: setItemInfo,
    shrinkPhoto: shrinkPhoto,     // receipts.js, for a receipt photo
    websiteUrl: websiteUrl,       // app.js, Materials to Order
    renameKind: renameKind,       // pricing.js, Pricing rules
    // services.js, "Your other lists": his own tags with how many items carry
    // each, and one tag moved onto another (or taken off every item: to '').
    tagList: () => customTags().map(t => ({ name: t,
      count: Object.values(items).filter(it => usesOf(it).indexOf(t) !== -1).length })),
    tagTargets: () => USES.map(u => ({ id: u.id, name: u.name })).concat(customTags().map(t => ({ id: t, name: t }))),
    tagFor: t => tagFor(t),
    moveTag: (was, to) => {
      if (!edits() || !was || was === to) return 0;
      const n = retag(Object.values(items).filter(it => usesOf(it).indexOf(was) !== -1),
        // By key: once the first item is retagged, another item's "winter Stuff"
        // is no longer spelt like the first one's "Winter stuff".
        tags => (to ? tags.map(x => (key(x) === key(was) ? to : x)) : tags.filter(x => key(x) !== key(was))));
      redrawIfVisible();
      return n;
    },
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const tab = el('tabSupplies');
    if (tab) tab.hidden = !on;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) {
      authKey = k;
      stop();
      if (on && window.YDDb && ydCan('jobs', 'see')) start();
      // The owner's buttons differ from the crew's, so redraw from scratch.
      const w = el('suppliesWrap'); if (w) w.innerHTML = '';
    }
    // Drawn now only when on screen: drawing starts the crew's listeners.
    const p = el('panel-supplies');
    if (!on || (p && p.classList.contains('active'))) render();
  });
})();
