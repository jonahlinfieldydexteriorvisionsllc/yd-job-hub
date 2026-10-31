// Pricing: how a takeoff becomes a price -- Jonah's rules, worked out by code.
//
// The rules are his (the proposal build instructions he priced by with Claude
// before Job Hub could do it). This file is only their arithmetic, so every
// estimate is priced the same way and Claude never does sums:
//
//   order qty   = takeoff qty x (1 + waste %), rounded UP -- by the quarter
//                 ton for anything sold by the ton, to whole units otherwise
//   landed cost = supplier cost x (1 + sales tax %) x (1 + the supplier's
//                 processing fee %), to the cent, per unit
//   client $    = order qty x landed cost x (1 + markup %)
//
// plus what is added on every job by rule: one delivery per delivered
// material (by the job's town, a load per so many tons, a surcharge for
// pallets), fuel for both trucks and the loader for the days on site,
// dumpsters for the spoil, the planting package for every plant and tree, and
// the layout markers on paving, stone edging and non-boulder walls. Labour is crew-days x
// (the crew-day rate + the profit target for the day). The customer sees one
// materials total and the labour; never a markup, a crew-day or a cost.
//
// NONE OF THE NUMBERS ARE IN THIS FILE. The repository is public, and the
// markups, crew-day rate and profit targets are the business's own. They live
// in pricing/rules (readable by whoever may see jobs, changed by the owner),
// set on the Pricing rules screen below. Material costs live where they always
// have: Supplies (supplyPrices), each item with its own markup and waste
// when it differs from its category's.

(function () {
  'use strict';

  // ------------------------------------------------------------------ shape

  // Every material belongs to one category; the category carries the default
  // markup and waste. Ids are stored on supplies -- never rename one.
  const CATEGORIES = [
    ['soil', 'Soil (bulk)'], ['fill', 'Fill dirt'], ['mulch', 'Mulch'],
    ['stone', 'Stone, gravel & sand'], ['decorative', 'Decorative rock'], ['pavers', 'Pavers'], ['wall', 'Wall block & caps'],
    ['natural', 'Natural stone, flagstone & boulders'],
    // Jonah, 12 Oct 2026: decorative rock apart from the gravel and sand, fire
    // pits apart from fireplaces, the outdoor kitchen on its own -- so Claude
    // reads each only when a job calls for it (estimates.py KIND_WORDS).
    ['firepit', 'Firepits'], ['fireplace', 'Fireplaces'], ['kitchen', 'Outdoor kitchens'],
    ['edging', 'Edging'],
    ['hardscape', 'Fabric, restraint, geogrid & other hardscape'], ['adhesive', 'Adhesives & sealers'],
    ['drainage', 'Drainage & concrete'], ['seed', 'Seed & erosion control'], ['bagged', 'Bagged goods'],
    ['planting', 'Planting package'], ['plant', 'Plants'], ['dumpster', 'Dumpsters'],
    ['hardware', 'Hardware'], ['rental', 'Rentals'], ['tools', 'Tools & equipment'], ['other', 'Other'],
  ];
  // Things we buy to work with, not to install: kept in Supplies (where to
  // get one) but never on an estimate, and never in the list Claude reads.
  const NOT_FOR_ESTIMATES = ['tools'];
  // Priced on an estimate but never named to the customer (materialLine
  // `listed`): what is hired for the job, not part of what it leaves behind.
  const NOT_LISTED = ['rental'];
  // When every supplier's delivery started counting (abd5906): a bid first
  // sent before it kept the price it went out at (deliveries()).
  const OWN_DELIVERY_FROM = '2026-10-27T17:01:09Z';
  const CATEGORY_NAME = {};
  CATEGORIES.forEach(([id, name]) => { CATEGORY_NAME[id] = name; });

  // Kinds Jonah adds himself (12 Oct 2026: "i need to be able to add kinds of
  // materials"). A kind of his is kept as its name: on the items that are that
  // kind (Supplies, which everyone can read -- so the crew see the name too)
  // and, once it has a markup or waste, in pricing/rules.categories like any
  // other. The list is every such name in use.
  const kindKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // "lighting" on one item and "Lighting" on another are one kind: shown,
  // and priced, by the spelling first seen. Worked out at most once a second
  // (a list of 800 items asks for every one).
  let spelt = null, speltAt = 0;
  function spelling(id) {
    if (!spelt || Date.now() - speltAt > 1000) {
      spelt = {};
      customKinds().forEach(k => { spelt[kindKey(k)] = k; });
      speltAt = Date.now();
    }
    return spelt[kindKey(id)] || String(id || '');
  }
  const kindName = id => CATEGORY_NAME[id] || (id ? spelling(id) : '');
  // The markup and waste for a kind, his own found whatever its capitals.
  const catRuleOf = (r, cat) => (r.categories || {})[cat] || (CATEGORY_NAME[cat] ? null : (r.categories || {})[spelling(cat)]) || {};
  function customKinds() {
    const seen = {};
    const add = k => {
      k = String(k || '').trim();
      if (k && !CATEGORY_NAME[k] && !seen[kindKey(k)]) seen[kindKey(k)] = k;
    };
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {} };
    Object.values(cat.items || {}).forEach(it => add(it.category));
    Object.keys((rules && rules.categories) || {}).forEach(k => { if (rules.categories[k]) add(k); });
    return Object.values(seen).sort((a, b) => a.localeCompare(b));
  }
  const allKinds = () => CATEGORIES.concat(customKinds().map(k => [k, k]));
  // A kind as typed -> the kind it is: one of the list ("pavers", "Mulch"),
  // one of his already in use however it was capitalised, or a new one. No
  // dots or slashes: the name is also a key in pricing/rules.
  function kindFor(text) {
    const t = String(text || '').replace(/[.\/`[\]*~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const k = kindKey(t);
    if (!k) return '';
    const hit = CATEGORIES.find(([id, name]) => kindKey(id) === k || kindKey(name) === k);
    if (hit) return hit[0];
    return customKinds().find(c => kindKey(c) === k) || t;
  }
  // The layout markers go only on work that is laid out to a line -- Jonah,
  // 27 Oct 2026: "they should only be included for stone edging, retaining
  // walls that arent being build with boulders, and paving walkways/patios".
  // So: pavers; a wall line unless it is boulders; edging only when it is
  // stone (not steel or plastic); flagstone laid as a walk or patio.
  const BOULDER = /\bboulders?\b/i;
  const STONE_EDGING = /\b(stone|cobble|cobblestones?|belgian|block|granite|limestone|brick|paver|concrete|curb)\b/i;
  const FLAGSTONE = /\b(flag|flagstone|flagging|stepp?ing stones?|stepper)\b/i;
  function wantsMarkers(l) {
    const name = String(l.name || '');
    if (l.category === 'pavers') return true;
    if (l.category === 'wall') return !BOULDER.test(name);
    if (l.category === 'edging') return STONE_EDGING.test(name);
    if (l.category === 'natural') return FLAGSTONE.test(name);
    return false;
  }

  // ---------------------------------------------------------- sales tax
  //
  // Wisconsin (DOR Publication 210; Jonah, 13 Oct 2026: "set it up so the
  // job hub taxes everything properly"): landscaping and lawn care are taxed
  // to the customer, labour and materials both -- planting, sod, seeding,
  // mulch or rock around plants, fine grading for seed or sod, mowing,
  // fertilizing, trimming, cleanups. Building on the land is not: patios,
  // walls, steps, walks, drainage, rough grading, lighting, snow plowing (the
  // company pays tax on those materials when it buys them). A building job
  // whose taxable part is under 10% of its price is not taxed at all
  // (Wis. Stat. 77.54(60)). Every line can be set by hand on the estimate.
  //
  // A kind of material is taxed always, never, or as the job is (mostly
  // planting work, or mostly building) -- his own setting per kind wins.
  const KIND_TAX = {
    plant: 'always', planting: 'always', mulch: 'always', seed: 'always',
    fill: 'never', stone: 'never', pavers: 'never', wall: 'never', natural: 'never', firepit: 'never',
    fireplace: 'never', kitchen: 'never', hardscape: 'never', adhesive: 'never', drainage: 'never', tools: 'never',
  };
  const TAX_WAYS = [['job', 'As the job is'], ['always', 'Always'], ['never', 'Never']];
  const kindTax = (r, cat) => {
    const own = catRuleOf(r, cat).customerTax;
    return TAX_WAYS.some(([k]) => k === own) ? own : KIND_TAX[cat] || 'job';
  };
  // Labour by what it is: words of planting and lawn care, and none of
  // building. A line with both (a patio with a planting bed) is left untaxed
  // for him to decide.
  const TAXED_WORK = /\b(plant(s|ing|ed)?|trees?|shrubs?|perennials?|flowers?|annuals?|sod(ding)?|seed(ing)?|overseed(ing)?|mulch(ing)?|lawn|lawns|mow(s|ing)?|fertili[sz](e|er|ing|ation)|aerat(e|ion|ing)|dethatch(ing)?|weed(s|ing)?|prun(e|ing)|trim(s|ming)?|hedges?|garden|gardens|beds?|clean-?ups?|leaf|leaves|top-?dress(ing)?)\b/i;
  const BUILT_WORK = /\b(patios?|pavers?|walls?|retaining|steps?|walks?|walkways?|paths?|driveways?|fences?|fencing|drains?|drainage|trench(es|ing)?|french|downspouts?|grading|excavat\w*|gravel|pads?|concrete|fire ?pits?|fireplaces?|kitchens?|lighting|irrigation|snow|plow\w*|salt\w*|boulders?|pergolas?|decks?)\b/i;
  function workTaxable(w, ctx) {
    if (w.taxable === true || w.taxable === false) return w.taxable;
    const svc = w.priceId && ctx.book ? ctx.book[w.priceId] : null;
    const text = [w.title, w.qbItem, svc && svc.name].filter(Boolean).join(' ');
    return TAXED_WORK.test(text) && !BUILT_WORK.test(text);
  }

  // The three named profit targets of the first version. Kept only so the
  // amounts they held become the start of his own list (profitChoices), and
  // so a line saved with one of their names still prices by it.
  const PROFIT_TIERS = [['floor', 'Floor'], ['aim', 'Aim'], ['great', 'Great day']];

  // What an empty pricing/rules looks like. Everything a price needs is
  // missing until it is set, and an estimate says so rather than guessing.
  function blankRules() {
    return {
      taxPct: null,
      // Sales tax charged to the customer on taxable work (landscaping and
      // lawn care), as Job Hub shows it. QuickBooks works out the exact tax
      // from the job's address when the estimate goes in.
      customerTaxPct: null,
      crewDayCents: null,
      // How many paid hours -- the whole crew's together -- make one
      // crew-day: what turns the clock's hours into crew-days on Estimate vs
      // actual (jobcosts.js) and for the finished jobs Claude is shown
      // (functions/pastjobs.py). He counts it per person (Jonah, 27 Oct
      // 2026: "7hrs per crew member assuming a 1hr lunch" -- lunch is a
      // clock-out, so off the clock too), so he sets the people in a crew
      // and the hours each, and crewDayHours is their product, saved with
      // them (prCrewDay). Nothing is assumed until he sets both.
      crewPeople: null,
      crewPersonHours: null,
      crewDayHours: null,
      // Profit per crew-day: his own amounts, as many as he likes, and the
      // usual one (null until he sets them: then the old three are used).
      profitChoices: null,
      defaultProfitCents: null,
      profitCents: { floor: null, aim: null, great: null },
      defaultProfit: 'aim',
      categories: {},              // id -> { markupPct, wastePct }
      vendors: {},                 // vendor id -> { processingPct, cityDelivery }
      delivery: { rates: {}, palletCents: null, loadTons: null, markupPct: null },
      fuel: { mpg: [], bobcatGalPerDay: null, markupPct: null },
      // Soil, rock and debris: the dumpster company takes at most 10 cu yd of
      // those in a box (Jonah, 22 Oct 2026). Brush goes in it too, and only
      // brush may go in a bigger box (up to 20 yd: ruleLines); with
      // none set, brush rides in the soil boxes.
      dumpster: { supplyId: null, maxCuYd: null, brushSupplyId: null, brushMaxCuYd: null },
      // Which materials are delivered and which we pick up (wayOf): null
      // until he changes them on Pricing rules -- then STARTING_WAYS, the
      // list he gave, is what they are.
      getWays: null,
      markers: { supplyId: null, count: null },
      // His usual grass seed: what a line of plain "grass seed" is, and what
      // Claude uses unless he names another (supplymatch.js usualSeed) --
      // always in its biggest bag.
      seed: { supplyId: null },
      planting: { perPlant: [], perSingleTree: [], perMultiTree: [] },
      // minDepositPct: the smallest deposit (50 unless set);
      // depositCoversMaterials: the deposit is at least the Materials figure
      // (on unless switched off).
      payments: { splitAboveCents: null, twoText: '', threeText: '', warranty: '', minDepositPct: null, depositCoversMaterials: null },
      // The $0 lines every QuickBooks estimate ends with, in order: the
      // QuickBooks products whose descriptions hold the warranty and the
      // terms and conditions (written in QuickBooks, read when sending).
      // items: for homes; businessItems: for businesses (some notices are
      // for homes only).
      estimateEnd: { items: [], businessItems: [] },
      // A snow bid's words and QuickBooks products (estimate.js snowLines):
      // only what he changed is kept here -- blank is SNOW_BID's wording.
      snowBid: {},
      shop: { address: '', lat: null, lng: null },
      // Claude starts an estimate by itself when the site-visit notes are
      // written (estimate.js). On unless switched off.
      autoDraft: null,
      // ...and drafts the plant-care email when a job with plants is
      // marked Complete. On unless switched off.
      autoCare: null,
      // Claude is shown the finished jobs most like a bid, and what they
      // really took on the clock (functions/pastjobs.py). On unless
      // switched off.
      learnFromJobs: null,
    };
  }

  // ---------------------------------------------------------------- numbers

  // A number, or null for "not given" (blank, text, NaN). Zero is a number.
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%\s]/g, ''));
    return isFinite(n) ? n : null;
  }
  const first = (...vs) => { for (const v of vs) { const n = num(v); if (n !== null) return n; } return null; };
  const pct = p => (num(p) || 0) / 100;
  // Floating point makes 5 x 1.2 come out as 6.000000000000001, and a plain
  // ceil would then order 7. Trim to a millionth before rounding up.
  const trim = x => Math.round(x * 1e6) / 1e6;
  // "$2,345.10", for a problem worded with a figure in it.
  const fmtCents = c => '$' + (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isTon =unit => /^\s*(ton|tons|t)\s*$/i.test(String(unit || ''));
  // Sold loose by the ton or the yard -- the stuff a delivery truck dumps.
  const isBulk = unit => isTon(unit) || /^\s*(yard|yards|yd|yds|cu ?yd|cubic yards?)\s*$/i.test(String(unit || ''));

  // ---------------------------------------------- delivered or picked up
  //
  // Jonah (22 Oct 2026): "set assumed delivery vs pickup for specific
  // materials. All bulk rock/soil are delivered. All online items assume
  // delivery since we cannot pickup. Fabric is always picked up, chalkstones
  // are always picked up, grass seed is always picked up, poly edging is
  // always picked up. Boulders are always delivered. Allow me to specify if
  // theres a special occasion where we pickup a material that is typically
  // delivered. All turf and turf drain tiles are delivered."
  //
  // Every material is brought to the job (🚚 'delivered') or fetched by us
  // (🏪 'pickup') -- or, a small thing from a supplier whose truck is coming
  // to the job anyway, comes on that truck ('rides'). The first of these that
  // says decides:
  //   1. the line itself, set by hand (the estimate, the order list) -- the
  //      odd time a material goes the other way
  //   2. the item in Supplies (getWay)
  //   3. a supplier nobody can drive to (online only, ships to us): delivered
  //   4. words in its name ("fabric" picked up, "boulder" delivered)
  //   5. its kind of material
  //   6. sold loose by the ton or the yard: his bulk rule
  //   7. none of them: as before there were rules -- a bulk load or a pallet
  //      from a supplier who delivers by town is delivered, the rest picked up
  //      (and a small thing rides on that supplier's truck: settleWays).
  // Picked up, it costs nothing to bring; delivered, a bulk load or a pallet
  // from a supplier who delivers by town gets its truck (deliveries()).
  // 3 to 6 are his, on Pricing rules (rules.getWays); until he changes them,
  // they are the list he gave. Words are whole words, an s or es after them
  // allowed, a space also matching none or a dash: "chalk stone" finds
  // "Chalkstones", "turf" never finds "Turfstone".
  const STARTING_WAYS = {
    shipped: true,
    bulk: 'delivered',
    kinds: { seed: 'pickup', dumpster: 'delivered' },
    delivered: ['boulder', 'turf', 'air drain'],
    pickup: ['fabric', 'weed barrier', 'chalk stone', 'grass seed', 'poly edging'],
  };
  const WAYS = ['delivered', 'pickup'];
  const HAND_WAYS = ['delivered', 'pickup', 'rides'];
  const wayRules = r => (r && r.getWays && typeof r.getWays === 'object' ? r.getWays : STARTING_WAYS);
  const wordRes = {};
  function saysWord(text, word) {
    const w = String(word || '').toLowerCase().trim();
    if (!w) return false;
    const re = wordRes[w] || (wordRes[w] = new RegExp('(^|[^a-z0-9])' +
      w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]*') + '(s|es)?(?![a-z0-9])', 'i'));
    return re.test(String(text || ''));
  }
  // A dumpster is always dropped off at the job and hauled away -- before
  // anything else, a hand pick included (Jonah, 27 Oct 2026: "all dumpsters
  // get delivered they shouldnt be getting marked at we pick it up"). Lines
  // typed in or off QuickBooks are often not joined to the dumpster in
  // Supplies, so its words count as much as its kind. Bringing it is in its
  // price: it never carries a delivery of its own (deliveries()).
  const isDumpster = x => x.category === 'dumpster' || saysWord([x.name, x.also].filter(Boolean).join(' '), 'dumpster') ||
    saysWord([x.name, x.also].filter(Boolean).join(' '), 'roll off');
  // x: { name, also, category, per, pallet, cityDelivery, buyWays,
  // vendorName, itemWay (Supplies), hand (the line's own) } ->
  // { way, by: dumpster|hand|item|shipped|words|kind|bulk|usual, why (in words) }.
  function wayOf(x, r) {
    const g = wayRules(r);
    if (isDumpster(x)) return { way: 'delivered', by: 'dumpster', why: 'a dumpster — dropping it off and hauling it away are in its price' };
    if (HAND_WAYS.indexOf(x.hand) !== -1) return { way: x.hand, by: 'hand', why: 'set by hand on this line' };
    if (WAYS.indexOf(x.itemWay) !== -1) return { way: x.itemWay, by: 'item', why: 'set on the item in Supplies' };
    if (g.shipped !== false && (x.buyWays || []).some(w => w === 'online' || w === 'shipped')) {
      return { way: 'delivered', by: 'shipped', why: (x.vendorName || 'its supplier') + ' ships it — no counter to pick it up from' };
    }
    const text = [x.name, x.also].filter(Boolean).join(' ');
    let hit = null;
    WAYS.forEach(way => (Array.isArray(g[way]) ? g[way] : []).forEach(w => {
      if (saysWord(text, w) && (!hit || String(w).trim().length > hit.word.length)) hit = { way: way, word: String(w).trim() };
    }));
    if (hit) return { way: hit.way, by: 'words', why: 'your rule for “' + hit.word + '”' };
    const k = x.category && g.kinds ? g.kinds[x.category] : null;
    if (WAYS.indexOf(k) !== -1) return { way: k, by: 'kind', why: 'your rule for ' + kindName(x.category) };
    if (isBulk(x.per) && WAYS.indexOf(g.bulk) !== -1) {
      return { way: g.bulk, by: 'bulk', why: 'bulk — sold loose by the ' + (isTon(x.per) ? 'ton' : 'yard') };
    }
    if (x.cityDelivery && (isBulk(x.per) || x.pallet)) {
      return { way: 'delivered', by: 'usual', why: (x.pallet ? 'a pallet' : 'a bulk load') + ' from ' + (x.vendorName || 'a supplier who delivers') };
    }
    return { way: 'pickup', by: 'usual', why: 'no rule for it — picked up' };
  }
  const vendorsOf = ctx => ctx.vendors || (window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog().vendors || {} : {});
  // A priced line's way (the materialLine shape), from its item, its
  // supplier and the hand pick on the line ('auto' or none: the rules). A
  // rental has none: it has its own place on the crew's page, picked up at
  // the rental shop.
  function setWay(out, it, hand, ctx) {
    out.way = null; out.wayBy = null; out.wayWhy = '';
    if (out.category === 'rental') return out;
    const v = it && it.vendorId ? vendorsOf(ctx)[it.vendorId] || null : null;
    // Its words: the line's name (what the customer reads) and the item's own.
    const w = wayOf({ name: out.name, also: it ? [it.name, it.also].filter(Boolean).join(' ') : '', category: out.category, per: out.per, pallet: out.pallet,
      cityDelivery: out.cityDelivery, buyWays: v && v.buyWays, vendorName: v && v.name, itemWay: it && it.getWay, hand: hand }, ctx.rules);
    out.way = w.way; out.wayBy = w.by; out.wayWhy = w.why; out.vendorName = v ? String(v.name || '') : '';
    return out;
  }
  // What only the whole job shows. A bid sent before these rules keeps the
  // trucks it was priced with: the customer has that price (and QuickBooks
  // has the last word once it is sent) -- a delivered line can still be
  // switched by hand. And a small thing nothing decided, from a supplier
  // whose truck is coming to this job, comes on that truck.
  const truckable = l => !!l.cityDelivery && l.orderQty > 0 && !l.auto && (isBulk(l.per) || !!l.pallet);
  const sentBefore = est => !!est && Array.isArray(est.sent) && est.sent.length > 0 && est.ways !== 'rules';
  function settleWays(all, est) {
    if (sentBefore(est)) all.forEach(l => {
      if (l.way && l.way !== 'delivered' && l.wayBy !== 'hand' && truckable(l)) {
        l.way = 'delivered'; l.wayBy = 'sent'; l.wayWhy = 'priced with its delivery when the bid was sent';
      }
    });
    const trucks = {};
    all.forEach(l => { if (l.way === 'delivered' && l.vendorId && truckable(l)) trucks[l.vendorId] = true; });
    all.forEach(l => {
      if (l.wayBy === 'usual' && l.way === 'pickup' && l.vendorId && trucks[l.vendorId]) {
        l.way = 'rides'; l.wayWhy = 'comes on ' + (l.vendorName || 'the supplier') + '’s truck';
      }
    });
    return all;
  }
  // Delivered or not, for a line from before there were ways (a caller that
  // has not worked them out): as the hand pick said.
  const wayNow = l => l.way || (l.delivery === 'pickup' || l.delivery === 'rides' ? l.delivery : 'delivered');
  // The ways of lines that are not an estimate's priced lines -- the order
  // list's (estimate.js orderWays): [{id, supplyId, name, orderQty, per,
  // hand}] -> the same, each with way/wayBy/wayWhy.
  function waysFor(lines, est, ctx) {
    const vs = ctx.rules.vendors || {};
    const out = (lines || []).map(l => {
      const it = l.supplyId ? ctx.items[l.supplyId] || null : null;
      const pr = l.supplyId ? ctx.prices[l.supplyId] || null : null;
      const o = Object.assign({}, l, {
        name: l.name || (it && it.name) || '', category: (it && it.category) || l.category || 'other',
        per: String(l.per || (pr && pr.per) || (it && it.unit) || '').trim(), pallet: !!(it && it.pallet),
        vendorId: it ? it.vendorId || null : null, cityDelivery: !!(it && (vs[it.vendorId] || {}).cityDelivery), auto: null,
      });
      return setWay(o, it, l.hand, ctx);
    });
    return settleWays(out, est);
  }

  // Order quantities: by the quarter ton for tons, whole units otherwise.
  function roundUp(q, unit) {
    if (!(q > 0)) return 0;
    return isTon(unit) ? Math.ceil(trim(q * 4)) / 4 : Math.ceil(trim(q));
  }

  // "Madison — west" and "madison west" are the same place.
  const placeKey = s => String(s || '').toLowerCase().replace(/\btown of\b/g, 'town of').replace(/[^a-z0-9]+/g, ' ').trim();

  // MDS splits Madison into three delivery zones (book p.36: Madison -
  // Central / East / West) without saying where the lines are. Central is
  // taken as within about a mile and a half of the Capitol (downtown, the
  // isthmus, campus); the rest of the city is east or west of it -- the north
  // side counts as east, south Madison (toward the Fitchburg yard) as west.
  // The estimate shows which zone was picked, and another can be chosen.
  const ZONED = { madison: { lat: 43.0747, lng: -89.3843, centralMiles: 1.6 } };
  function zoneFor(town, rates, site) {
    const base = placeKey(town);
    const zones = Object.keys(rates).filter(k => num(rates[k]) !== null && placeKey(k).indexOf(base + ' ') === 0);
    if (!base || !zones.length) return null;
    const c = ZONED[base];
    if (!c || !site || typeof site.lat !== 'number' || typeof site.lng !== 'number') return { zones: zones };
    const rad = x => x * Math.PI / 180;
    const dLat = rad(site.lat - c.lat), dLng = rad(site.lng - c.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(c.lat)) * Math.cos(rad(site.lat)) * Math.sin(dLng / 2) ** 2;
    const miles = 2 * 3958.8 * Math.asin(Math.sqrt(h));
    const want = miles <= c.centralMiles ? 'central' : site.lng > c.lng ? 'east' : 'west';
    const key = zones.find(k => placeKey(k) === base + ' ' + want);
    return key ? { key: key, zones: zones } : { zones: zones };
  }

  // -------------------------------------------------------------- materials
  //
  // One line of the takeoff: {supplyId, name, qty, unit, plant, tree,
  // costCents (only for things not in Supplies -- plants mostly), markupPct /
  // wastePct (overrides), delivery: 'auto' | 'pickup' | 'rides'}.
  // ctx: {rules, items, prices} (items/prices from Supplies).

  // A rental by the day with its other rates (Supplies: half day, week,
  // month -- Jonah, 13 Oct 2026, "different rates for rentals like a price per
  // day and a price per week"): the cheapest way to have it for the days
  // needed. Five days at $200 a day or $800 a week is the week; nine days is
  // a week and two days, or two weeks if that is less. A month is four weeks,
  // as the rental houses count it. A weekend rate depends on which days, so
  // it is never picked by itself. Worked in half days. Returns
  // {cents, plan: "1 week + 2 days"}, or null with no day-type rates.
  const RENTAL_STEPS = [['halfDayCents', 1, 'half day', 'half days'], ['cents', 2, 'day', 'days'],
                        ['weekCents', 14, 'week', 'weeks'], ['monthCents', 56, 'month', 'months']];
  function rentalCents(pr, days) {
    const steps = RENTAL_STEPS.filter(s => pr && typeof pr[s[0]] === 'number' && pr[s[0]] >= 0);
    const n = Math.ceil(days * 2 - 1e-9);
    if (!steps.length || !(n > 0)) return null;
    // best[i]: the least for i half days (or more -- a rate may run over).
    const best = [0], how = [null];
    for (let i = 1; i <= n; i++) {
      best[i] = Infinity;
      steps.forEach((s, k) => {
        const c = best[Math.max(0, i - s[1])] + pr[s[0]];
        if (c < best[i]) { best[i] = c; how[i] = k; }
      });
    }
    const count = steps.map(() => 0);
    for (let i = n; i > 0; i = Math.max(0, i - steps[how[i]][1])) count[how[i]]++;
    const plan = steps.map((s, k) => count[k] ? count[k] + ' ' + (count[k] === 1 ? s[2] : s[3]) : '')
      .filter(Boolean).reverse().join(' + ');
    return { cents: best[n], plan: plan };
  }
  const isDayUnit = per => /^(day|days|daily|per day)$/i.test(String(per || '').trim());

  function materialLine(m, ctx) {
    const r = ctx.rules;
    const it = m.supplyId ? ctx.items[m.supplyId] || null : null;
    const pr = m.supplyId ? ctx.prices[m.supplyId] || null : null;
    const cat = m.plant ? 'plant' : (it && it.category) || m.category || 'other';
    const catRule = catRuleOf(r, cat);
    const per = String((pr && pr.per) || (it && it.unit) || m.unit || '').trim();
    const coverage = it && num(it.coverage) > 0 ? num(it.coverage) : null;
    // A bag sold by weight (grass seed): how many pounds one holds, and
    // whether the job pays only for the part of it used -- Jonah (15 Oct
    // 2026): "we always buy the biggest bag of grass seed so pricing should
    // be based off of the cost per lb of that bag". A line in pounds
    // ("Grass seed: 3 lb") is then worked out in bags from that weight.
    const pk = it && window.YDMatch && window.YDMatch.pack ? window.YDMatch.pack(it, pr) : { lb: null, part: false };
    const inLb = !!(pk.lb && /^(lbs?|pounds?|#)$/i.test(String(m.unit || '').trim()));
    const takeoffUnit = inLb ? 'lb' : coverage ? String(it.takeoffUnit || '').trim() : per;
    const markupPct = first(m.markupPct, pr && pr.markupPct, catRule.markupPct);
    const wastePct = m.plant ? 0 : first(m.wastePct, pr && pr.wastePct, catRule.wastePct, 0);
    const qty = Math.max(0, num(m.qty) || 0);
    const withWaste = qty * (1 + wastePct / 100);
    // A rental with more than a day rate: priced by rentalCents, in half
    // days when there is a half-day rate.
    const rental = !!(it && pr && isDayUnit(per) && typeof pr.cents === 'number' &&
      ['halfDayCents', 'weekCents', 'monthCents'].some(k => typeof pr[k] === 'number'));
    // What is used, in what it is sold by (a part of a bag, say); what is
    // bought is that rounded up.
    const used = inLb ? withWaste / pk.lb : coverage ? withWaste / coverage : withWaste;
    const orderQty = rental && typeof pr.halfDayCents === 'number'
      ? Math.ceil(withWaste * 2 - 1e-9) / 2
      : roundUp(used, per);

    const costCents = it ? (pr && typeof pr.cents === 'number' ? pr.cents : null) : num(m.costCents);
    const vendorRule = it && it.vendorId ? (r.vendors || {})[it.vendorId] || {} : {};
    const fixedEach = pr && num(pr.clientCents) > 0 ? num(pr.clientCents) : null;
    const out = {
      id: m.id, supplyId: m.supplyId || null, name: m.name || (it && it.name) || '', category: cat,
      qty: qty, takeoffUnit: takeoffUnit, orderQty: orderQty, per: per,
      wastePct: wastePct, markupPct: markupPct, costCents: costCents,
      landedEachCents: null, clientCents: 0, problems: [],
      vendorId: it ? it.vendorId || null : null, cityDelivery: !!vendorRule.cityDelivery,
      pallet: !!(it && it.pallet), specialOrder: !!(it && it.specialOrder),
      // `listed`: named in what the customer reads (materialsList -- the
      // customer's view and QuickBooks). A rental -- the mini-excavator, the
      // jumping jack -- never is (Jonah, 21 Oct 2026: "rental items dont go on
      // the estimate as visible to client"): what it costs stays in the
      // materials figure, as the layout markers' does.
      delivery: m.delivery || 'auto', listed: m.listed !== false && !NOT_LISTED.includes(cat), auto: m.auto || null,
      packLb: pk.lb, partUse: false, usedQty: null, usedLb: null,
      // The labour line whose all-in price already covers it (workLine).
      allInOf: m.allInOf || null,
    };
    // Delivered or picked up (wayOf); the whole job settles it (price()).
    setWay(out, it, m.delivery, ctx);
    if (m.supplyId && !it) out.problems.push('no longer in Supplies');
    if (!qty) return out;
    if (fixedEach !== null) {                   // priced to the customer per piece (the markers)
      out.clientCents = Math.round(orderQty * fixedEach);
      out.costTotalCents = costCents !== null ? Math.round(orderQty * costCents) : null;
      return out;
    }
    if (costCents === null) { out.problems.push(it ? 'no price in Supplies' : 'no cost'); return out; }
    if (num(r.taxPct) === null) { out.problems.push('sales tax % not set'); return out; }
    // What it costs us is known without a markup; only the customer's price
    // waits for one -- a kind he added and has not given a markup yet. A job
    // accepted in QuickBooks never needs it (price() leaves the problem out).
    const noMarkup = markupPct === null;
    if (noMarkup) { out.noMarkup = true; out.problems.push('no markup set for ' + kindName(cat) + ' (⋯ → Pricing rules)'); }
    const up = noMarkup ? 0 : 1 + markupPct / 100;
    // A category can be set as not taxed when bought (a rental, say). A cost
    // typed onto the line from a quote that already has the tax in it
    // (m.taxIn, Jonah 20 Oct 2026: "the prices for the turf and the airdrain
    // already include tax") is not taxed a second time.
    const tax = catRule.noTax || (!it && m.taxIn) ? 0 : pct(r.taxPct);
    const landing = (1 + tax) * (1 + pct(vendorRule.processingPct));
    const rent = rental ? rentalCents(pr, orderQty) : null;
    if (rent) {
      out.rentalPlan = rent.plan;
      out.landedEachCents = Math.round(rent.cents * landing / orderQty);
      out.costTotalCents = Math.round(rent.cents * landing);
      out.clientCents = Math.round(rent.cents * landing * up);
      return out;
    }
    out.landedEachCents = Math.round(costCents * landing);
    // Bought by the bag, charged by the part used: the rest of the bag stays
    // on the shelf for the next job. Still a whole bag to buy (orderQty).
    const charged = pk.part ? trim(used) : orderQty;
    if (pk.part) {
      out.partUse = true;
      out.usedQty = Math.round(used * 1000) / 1000;
      if (pk.lb) out.usedLb = Math.round(used * pk.lb * 100) / 100;
      out.perLbCents = pk.lb ? costCents / pk.lb : null;     // the supplier's price a pound
    }
    out.costTotalCents = Math.round(charged * out.landedEachCents);
    out.clientCents = Math.round(charged * out.landedEachCents * up);
    return out;
  }

  // -------------------------------------------------------- what the rules add

  // Lines added by rule, in the same shape as a takeoff line so they are
  // priced the same way: dumpsters for the spoil, the planting package, the
  // layout markers. `off` names any the estimate has switched off.
  function ruleLines(est, lines, ctx) {
    const r = ctx.rules, off = est.off || {}, out = [];
    const add = (supplyId, qty, auto, listed, tag) => {
      if (supplyId && qty > 0) out.push({ id: 'auto-' + auto + (tag || '') + '-' + supplyId, supplyId, qty, auto, listed });
    };
    // Dumpsters (Jonah, 22 Oct 2026: "10yd max for soil and rock"; "brush can
    // still go in the 10yds but we can only order larger sizes if its
    // strictly brush going in them"). Soil, rock and debris go in the usual
    // box. Brush fills their spare room first; the rest goes in the cheapest
    // mix of usual boxes and bigger brush-only ones. A dumpster put on the
    // takeoff by hand stands instead of all of them.
    const d = r.dumpster || {};
    const spoil = Math.max(0, num(est.spoilCuYd) || 0), brush = Math.max(0, num(est.brushCuYd) || 0);
    const boxOf = (id, max) => (id && num(max) > 0 ? { id: id, max: num(max), cents: ctx.prices[id] ? num(ctx.prices[id].cents) : null } : null);
    const usual = boxOf(d.supplyId, d.maxCuYd), big = boxOf(d.brushSupplyId, d.brushMaxCuYd);
    // (A hand-typed "Dumpster 10 yd" not joined to Supplies is one too.)
    if (!off.dumpsters && !lines.some(l => isDumpster(l)) && (spoil > 0 || brush > 0)) {
      const soilBoxes = usual && spoil > 0 ? Math.ceil(trim(spoil / usual.max)) : 0;
      const rest = Math.max(0, trim(brush - (usual ? soilBoxes * usual.max - spoil : 0)));
      let nUsual = 0, nBig = 0;
      if (rest > 0 && usual && big) {
        // With both prices known, the cheapest mix; without them, the fewest boxes.
        const known = usual.cents !== null && big.cents !== null;
        let best = null;
        for (let b = 0; b <= Math.ceil(trim(rest / big.max)); b++) {
          const u = Math.ceil(trim(Math.max(0, rest - b * big.max) / usual.max));
          const cost = known ? b * big.cents + u * usual.cents : b + u;
          if (!best || cost < best.cost) best = { cost: cost, b: b, u: u };
        }
        nBig = best.b; nUsual = best.u;
      } else if (rest > 0 && usual) nUsual = Math.ceil(trim(rest / usual.max));
      else if (rest > 0 && big) nBig = Math.ceil(trim(rest / big.max));
      if (usual) add(usual.id, soilBoxes + nUsual, 'dumpsters', true);
      if (big) add(big.id, nBig, 'dumpsters', true, '-brush');
    }
    // Planting package: so much per plant, a watering bag per single-trunk
    // tree, a ring per multi-trunk or evergreen.
    const plants = lines.filter(l => l.category === 'plant').reduce((s, l) => s + l.orderQty, 0);
    const singles = lines.filter(l => l.category === 'plant' && l.tree === 'single').reduce((s, l) => s + l.orderQty, 0);
    const multis = lines.filter(l => l.category === 'plant' && l.tree === 'multi').reduce((s, l) => s + l.orderQty, 0);
    const p = r.planting || {};
    if (!off.planting) {
      (p.perPlant || []).forEach(id => add(id, plants, 'planting', true));
      (p.perSingleTree || []).forEach(id => add(id, singles, 'planting', true));
      (p.perMultiTree || []).forEach(id => add(id, multis, 'planting', true));
    }
    // Layout markers on paving, stone edging and walls that are not
    // boulders (wantsMarkers). Not listed: a few dollars, there to be on hand.
    if (!off.markers && r.markers && r.markers.supplyId && num(r.markers.count) > 0 &&
        lines.some(wantsMarkers)) {
      add(r.markers.supplyId, num(r.markers.count), 'markers', false);
    }
    return out;
  }

  // One delivery per delivered material from a supplier who delivers by town
  // (MDS): a material is one truck however little of it there is, and
  // another truck for every so many tons of it. Any other supplier who
  // brings what it sells charges its own way, set on Pricing rules →
  // Suppliers: a set charge each time it delivers to a job, or nothing (free,
  // or in its prices) -- Jonah, 27 Oct 2026: "stuff marked to be delivered
  // but dont include a delivery fee ... it keeps happening". Something
  // delivered whose charge is not known is a problem, never a silent $0.
  // opts.order: an order list -- what bringing it will cost us, so a bid
  // already sent counts every supplier's charge too.
  // -> { lines: [{supplyId, supplyIds, vendorId, name, loads, pallet, free,
  //      charge, items, costCents, clientCents, parts}], clientCents,
  //      problems, problemsOf: {vendorId ('' = not joined): [text]},
  //      unset: {vendorId: [names delivered with no charge set]}, deliveryZone }
  function deliveries(lines, est, ctx, opts) {
    const r = ctx.rules, d = r.delivery || {}, out = { lines: [], clientCents: 0, problems: [], problemsOf: {}, unset: {}, check: {} };
    if ((est.off || {}).delivery) return out;
    const say = (p, vid) => { out.problems.push(p); (out.problemsOf[vid || ''] = out.problemsOf[vid || ''] || []).push(p); };
    // A delivery is a truck of bulk material or a pallet. Small things --
    // fabric, restraint, nails, a few bags of poly sand -- ride along or are
    // picked up and never carry a delivery of their own (Jonah, 6 Oct 2026),
    // and neither does what the rules add (markers, the planting package).
    // Nor does anything we pick up ourselves (wayOf), nor a dumpster.
    const want = lines.filter(l => truckable(l) && wayNow(l) === 'delivered' && l.wayBy !== 'dumpster');
    // Delivered, but not a town truck's load. Counted from 27 Oct 2026: a bid
    // sent before then keeps the price it went out at (QuickBooks has the
    // last word on it); its order list counts them. Sent before THEN, not
    // sent at all: one first sent since went out with these charges in it,
    // and must keep them (it lost them the moment it was put in QuickBooks).
    const firstSent = Array.isArray(est.sent) ? est.sent.map(v => String((v && v.at) || '')).sort()[0] : undefined;
    const sent = firstSent !== undefined && firstSent < OWN_DELIVERY_FROM;
    const own = !(opts && opts.order) && sent ? []
      : lines.filter(l => l.way === 'delivered' && l.wayBy !== 'dumpster' && l.orderQty > 0 && !l.auto && !truckable(l));
    // From a supplier who delivers by town, it comes on that supplier's
    // truck to the job -- or is that truck, when no other is coming (a
    // boulder sold each, say).
    const truckFrom = {};
    want.forEach(l => { truckFrom[l.vendorId] = true; });
    own.filter(l => l.cityDelivery).forEach(l => {
      if (!truckFrom[l.vendorId]) { truckFrom[l.vendorId] = true; want.push(l); }
    });
    if (want.length) townTrucks(want, est, ctx, out);
    // Everyone else's, by supplier: one delivery from each to the job.
    const vs = r.vendors || {}, names = vendorsOf(ctx);
    const by = {};
    own.filter(l => !l.cityDelivery).forEach(l => { const k = l.vendorId || ''; (by[k] = by[k] || []).push(l); });
    Object.keys(by).forEach(k => {
      const ls = by[k], vr = vs[k] || {};
      const items = ls.map(l => l.name || 'a material');
      if (!k) {
        say(items.join(', ') + (ls.length === 1 ? ' is' : ' are') + ' delivered but not joined to a Supplies item — no supplier to price the delivery', '');
        return;
      }
      const vname = String((names[k] && names[k].name) || ls[0].vendorName || 'the supplier');
      const base = { supplyId: ls[0].supplyId || null, supplyIds: ls.map(l => l.supplyId).filter(Boolean), vendorId: k,
                     pallet: false, items: items, parts: ls.map(l => ({ id: l.id, qty: l.orderQty })) };
      if (vr.deliveryFree) {
        out.lines.push(Object.assign(base, { name: vname, loads: 0, free: true, costCents: 0, clientCents: 0 }));
        return;
      }
      // A supplier whose charge changes every order (shipped by weight --
      // turf, drainage grid; Jonah, 28 Oct 2026: "Delivery charges vary so
      // well always need to double check that whenever ordering"): the
      // charge checked with them for this job (ctx.quotes, the job's
      // deliveryQuotes, typed on its order list or estimate), else it says so.
      let cost, checked = null;
      if (vr.deliveryEach) {
        const q = (ctx.quotes || {})[k];
        cost = q && typeof q === 'object' ? num(q.cents) : null;
        if (cost === null) { out.check[k] = items; say('delivery from ' + vname + ' changes every order — check it with them for this job', k); return; }
        checked = { cents: cost, at: q.at || '', by: q.by || '' };
      } else {
        cost = num(vr.deliveryCents);
        if (cost === null) { out.unset[k] = items; say('no delivery charge set for ' + vname + ' (Pricing rules → Suppliers)', k); return; }
      }
      const client = Math.round(cost * (1 + pct(d.markupPct)));
      out.lines.push(Object.assign(base, { name: vname + ' delivery', loads: 1, charge: true, each: !!vr.deliveryEach, checked: checked,
                                           costCents: cost, clientCents: client }));
      out.clientCents += client;
      if (cost > 0 && num(d.markupPct) === null && out.problems.indexOf('delivery markup % not set') === -1) say('delivery markup % not set', k);
    });
    return out;
  }
  // The trucks of a supplier who delivers by town (MDS), into out.
  function townTrucks(want, est, ctx, out) {
    const r = ctx.rules, d = r.delivery || {};
    const vids = want.map(l => l.vendorId || '').filter((v, i, a) => a.indexOf(v) === i);
    const sayAll = p => { out.problems.push(p); vids.forEach(v => { (out.problemsOf[v] = out.problemsOf[v] || []).push(p); }); };
    const town = est.deliveryTown || ctx.city || '';
    const rates = d.rates || {};
    // A town taken off the list is stored as null (saves merge, so a key
    // left out would stay).
    let key = Object.keys(rates).find(k => num(rates[k]) !== null && placeKey(k) === placeKey(town));
    // A town MDS prices by zone ("Madison — west / central / east" in the
    // book): the zone is picked from where the job is.
    let zone = null;
    if (!key && !est.deliveryTown) {
      zone = zoneFor(town, rates, est.site);
      if (zone && zone.key) { key = zone.key; out.deliveryZone = zone.key; }
    }
    if (!key) {
      // The map point is looked up by itself once the job has an address
      // (estimate.js autoTrip / tripsForAll); until it lands, or if the map
      // cannot find it, the zone can be picked by hand.
      sayAll(zone ? town + ' has ' + zone.zones.length + ' MDS delivery zones — waiting for the job’s map point (or pick the zone on the estimate)'
        : town ? 'no delivery rate for ' + town + ' — pick the town on the estimate, or get a quote'
        : 'no town on the job, so no delivery rate');
    }
    const rate = key ? num(rates[key]) : null;
    const byMaterial = {};
    want.forEach(l => {
      const k = l.supplyId || l.id;
      const m = byMaterial[k] = byMaterial[k] || { name: l.name, per: l.per, qty: 0, pallet: l.pallet, vendorId: l.vendorId || '', parts: [] };
      m.qty += l.orderQty;
      // Which lines ride on it, and how much of each: an all-in price covers
      // its own materials' share of the truck (allInParts).
      m.parts.push({ id: l.id, qty: l.orderQty });
    });
    Object.keys(byMaterial).forEach(k => {
      const m = byMaterial[k];
      const loads = isTon(m.per) && num(d.loadTons) > 0 ? Math.max(1, Math.ceil(trim(m.qty / num(d.loadTons)))) : 1;
      const cost = rate === null ? 0 : loads * (rate + (m.pallet ? num(d.palletCents) || 0 : 0));
      const client = Math.round(cost * (1 + pct(d.markupPct)));
      out.lines.push({ supplyId: k, supplyIds: [k], vendorId: m.vendorId, name: m.name, loads: loads, pallet: m.pallet,
                       items: [m.name], costCents: cost, clientCents: client, parts: m.parts });
      out.clientCents += client;
    });
    if (num(d.markupPct) === null) sayAll('delivery markup % not set');
  }

  // Fuel: both trucks there and back every day on site, the loader's diesel
  // for the days it runs, marked up. Miles are one way, by road, from the
  // shop (Pricing rules → shop address), looked up by themselves.
  // own: the job's own days stand in for crew-days (one accepted in
  // QuickBooks has none) -- what the problem says when there are none.
  function fuel(est, ctx, autoDays, own) {
    const r = ctx.rules, f = est.fuel || {}, rf = r.fuel || {}, prices = ctx.fuel || {};
    const out = { clientCents: 0, problems: [], miles: num(f.miles), days: first(f.jobDays, autoDays),
                  bobcatDays: null, gasCents: first(f.gasCents, prices.gasCents),
                  dieselCents: first(f.dieselCents, prices.dieselCents), gallonsPerDay: 0 };
    out.bobcatDays = first(f.bobcatDays, out.days);
    if ((est.off || {}).fuel) return out;
    if (out.miles === null) { out.problems.push('miles to the job not known yet'); return out; }
    if (!(out.days > 0)) {
      out.problems.push(own ? 'no days on the job yet (put it on the Job schedule, or type the days)' : 'no days on site yet (set the crew-days)');
      return out;
    }
    if (out.gasCents === null) { out.problems.push('no gas price'); return out; }
    const mpg = (rf.mpg || []).map(num).filter(n => n > 0);
    if (!mpg.length) { out.problems.push('truck mpg not set'); return out; }
    const rt = out.miles * 2;
    out.gallonsPerDay = mpg.reduce((s, m) => s + rt / m, 0);
    let cents = out.gallonsPerDay * out.gasCents * out.days;
    const bob = num(rf.bobcatGalPerDay);
    if (bob > 0 && out.bobcatDays > 0) {
      if (out.dieselCents === null) out.problems.push('no diesel price');
      else cents += bob * out.bobcatDays * out.dieselCents;
    }
    if (num(rf.markupPct) === null) out.problems.push('fuel markup % not set');
    out.costCents = Math.round(cents);
    out.clientCents = Math.round(cents * (1 + pct(rf.markupPct)));
    return out;
  }

  // ------------------------------------------------------------------ labour
  //
  // A work line is what the customer reads as one line of labour:
  //   crew:   crew-days x (crew-day rate + the profit per crew-day picked)
  //   flat:   qty x his price per unit (Prices by the unit -- turf by the
  //           sq ft, edging by the foot)
  //   amount: a figure typed in
  // Any of them may carry crew-days -- how long it takes -- and then says
  // what it makes per crew-day once the crew is paid (Jonah, 13 Oct 2026:
  // "some services arent priced per day like turf ... we make an amazing
  // profit off of. I dont wanna continue bidding at a goal profit per day
  // when some services can yield more").

  // Profit per crew-day (Jonah, 13 Oct 2026: "specific numbers of profit per
  // day not floor, aim, & great ... more than 3 options"): his own list of
  // amounts and the usual one; a line may carry any amount of its own.
  function profitChoices(r) {
    r = r || rules;
    const list = Array.isArray(r.profitChoices) ? r.profitChoices : PROFIT_TIERS.map(([id]) => (r.profitCents || {})[id]);
    return list.map(num).filter(n => n !== null && n >= 0)
      .filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
  }
  function defaultProfitCents(r) {
    r = r || rules;
    const d = num(r.defaultProfitCents);
    if (d !== null) return d;
    const old = num((r.profitCents || {})[r.defaultProfit || 'aim']);
    if (old !== null) return old;
    const c = profitChoices(r);
    return c.length ? c[Math.floor((c.length - 1) / 2)] : null;
  }
  // A line's profit per crew-day: its own amount, an old named target, or
  // the usual.
  function profitOf(w, r) {
    const p = w ? w.profit : null;
    if (typeof p === 'number' && isFinite(p)) return p;
    if (typeof p === 'string' && /^\d+(\.\d+)?$/.test(p)) return Number(p);
    if (typeof p === 'string' && num((r.profitCents || {})[p]) !== null) return num(r.profitCents[p]);
    return defaultProfitCents(r);
  }

  // What an all-in line's price covers besides its labour: the materials
  // marked as in it, at what the customer pays for them, and their share of
  // any delivery (by quantity, when a truck also brings material that is
  // not in it).
  function allInParts(w, all, del) {
    const inside = all.filter(l => l.allInOf && l.allInOf === w.id);
    const ids = {};
    inside.forEach(l => { ids[l.id] = true; });
    let deliveryCents = 0;
    del.lines.forEach(d => {
      const parts = d.parts || [];
      const total = parts.reduce((s, p) => s + p.qty, 0);
      const mine = parts.filter(p => ids[p.id]).reduce((s, p) => s + p.qty, 0);
      if (total > 0 && mine > 0) deliveryCents += Math.round(d.clientCents * mine / total);
    });
    return { materialsCents: inside.reduce((s, l) => s + l.clientCents, 0), deliveryCents: deliveryCents,
             count: inside.length, unpriced: inside.filter(l => l.problems.length).map(l => l.name || 'a material') };
  }

  function workLine(w, ctx, inside) {
    const r = ctx.rules, out = { id: w.id, cents: 0, problems: [], crewDays: null, costCents: null, profitPerDayCents: null };
    const days = num(w.crewDays), dayCost = num(r.crewDayCents);
    if (w.kind === 'allin') {
      // All in (Jonah, 21 Oct 2026: "i want the labor plus materials for the
      // paving to total 5616 ... calculate materials then minus that from 5616
      // and make that figure the price of labor"): his price for the work
      // WITH the materials marked as in it. The materials stay on the
      // materials line at their own price; this line is what is left, so the
      // two together come to his figure. More labour he wants on the same
      // line, outside that figure (the wall's labour on the patio's line), is
      // added on top. Its crew-days, if any, are how long it takes -- for his
      // profit per day and the fuel.
      const target = num(w.allInCents), add = Math.max(0, num(w.addCents) || 0);
      const p = inside || { materialsCents: 0, deliveryCents: 0, count: 0, unpriced: [] };
      const mats = p.materialsCents + p.deliveryCents;
      out.allIn = { cents: target, materialsCents: p.materialsCents, deliveryCents: p.deliveryCents,
                    count: p.count, addCents: add, labourCents: null };
      if (target === null) out.problems.push('needs its all-in price');
      else if (p.unpriced.length) out.problems.push('its all-in can’t be split until ' + p.unpriced.join(', ') + ' is priced');
      else if (mats > target) out.problems.push('the materials in its all-in come to ' + fmtCents(mats) +
        ' — more than the all-in ' + fmtCents(target));
      else {
        out.allIn.labourCents = Math.round(target - mats);
        out.cents = Math.round(target - mats + add);
      }
    } else if (w.kind === 'flat') {
      // By the unit, then his adjustments for this job (Services: "turf
      // pricing is all based on sq footage and then adjusted based on
      // factors") -- each a % of the price, so much more per unit, or a set
      // amount, copied onto the line when it was ticked -- then his minimum
      // charge for the service.
      const q = num(w.qty), rate = num(w.rateCents);
      if (q === null || rate === null) out.problems.push('needs a quantity and a rate');
      else {
        const adj = Array.isArray(w.adjust) ? w.adjust : [];
        const pctSum = adj.filter(a => a && a.how === 'pct').reduce((s, a) => s + (num(a.amount) || 0), 0);
        let c = q * rate * (1 + pctSum / 100);
        adj.forEach(a => {
          if (a && a.how === 'unit') c += q * (num(a.amount) || 0);
          else if (a && a.how === 'flat') c += num(a.amount) || 0;
        });
        const min = num(w.minimumCents);
        if (min !== null && c < min) { c = min; out.atMinimum = true; }
        out.cents = Math.max(0, Math.round(c));
      }
    } else if (w.kind === 'amount') {
      const a = num(w.amountCents);
      if (a === null) out.problems.push('needs an amount'); else out.cents = Math.round(a);
    } else if (w.sub) {
      // Crew-days price his own crew's time; someone else's work has a price
      // of its own.
      out.problems.push('done by someone else — give it a fixed price or an all-in price, not crew-days');
    } else {
      const target = profitOf(w, r);
      if (!(days > 0)) out.problems.push('how many crew-days?');
      else if (dayCost === null || target === null) out.problems.push('crew-day rate or profit per day not set (⋯ → Pricing rules)');
      else out.cents = Math.round(days * (dayCost + target));
    }
    if (w.sub) {
      // Done by someone else -- a subcontractor or an outside installer
      // (Jonah, 26 Oct 2026: the lighting on a patio bid is "done by the
      // lighting installer who picks the supplies", and "items on estimates
      // can be marked as subbed item and i can enter what the sub is charging
      // me and input who the sub is"). What they charge him is this line's
      // cost, in place of his crew's days: it takes no crew-days, so no days
      // of fuel, and his profit per crew-day is over his own crew's days
      // only. The customer's price is the line's as ever.
      const charge = num(w.sub.cents);
      out.sub = { by: String(w.sub.by || '').trim(), cents: charge };
      if (charge !== null) {
        out.costCents = Math.round(charge);
        out.subProfitCents = out.cents > 0 ? out.cents - out.costCents : null;
      }
      return out;
    }
    if (days > 0) {
      out.crewDays = days;
      if (dayCost !== null) {
        out.costCents = Math.round(days * dayCost);
        if (out.cents > 0) out.profitPerDayCents = Math.round((out.cents - out.costCents) / days);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- payments

  // The payment schedule (Jonah, 13 Oct 2026: "adjust deposit request fields
  // ... to be a certain percentage or to write the specific number in myself.
  // All job deposits require a minimum of 50% & must cover the entire
  // material cost"). A plan set on the estimate -- each payment a % of the
  // job or a dollar amount, the last always the rest -- or the usual: 50/50,
  // or 50/25/25 above the three-payment total. Whichever, the deposit is never
  // under his smallest deposit (payments.minDepositPct, 50 unless set) nor
  // under the whole Materials figure (unless he switches that off), and is
  // raised to it, saying why. Rounded up to the cent; the last takes the rest.
  function usualPlan(totalCents, rules) {
    const above = num(((rules || {}).payments || {}).splitAboveCents);
    return above !== null && totalCents > above
      ? [{ label: 'Deposit', how: 'pct', value: 50 }, { label: 'Progress', how: 'pct', value: 25 }, { label: 'Final', how: 'rest' }]
      : [{ label: 'Deposit', how: 'pct', value: 50 }, { label: 'On completion', how: 'rest' }];
  }
  function depositFloor(totalCents, rules, materialsCents) {
    const p = (rules || {}).payments || {};
    const minPct = num(p.minDepositPct) !== null ? num(p.minDepositPct) : 50;
    const byPct = Math.ceil(totalCents * minPct / 100);
    const byMat = p.depositCoversMaterials === false ? 0 : Math.min(totalCents, Math.ceil(num(materialsCents) || 0));
    return { cents: Math.max(byPct, byMat), minPct: minPct, why: byMat > byPct ? 'materials' : 'minimum' };
  }
  function payments(totalCents, rules, opts) {
    if (!(totalCents > 0)) return [];
    opts = opts || {};
    const plan = Array.isArray(opts.plan) && opts.plan.length ? opts.plan : usualPlan(totalCents, rules);
    const floor = depositFloor(totalCents, rules, opts.materialsCents);
    let left = totalCents;
    return plan.map((s, i) => {
      const last = i === plan.length - 1;
      let c = last || s.how === 'rest' ? left
        : s.how === 'amount' ? Math.round(num(s.value) || 0)
        : Math.ceil(totalCents * (num(s.value) || 0) / 100);
      let raised = null;
      if (i === 0 && !last && c < floor.cents) { c = floor.cents; raised = floor.why; }
      if (i === 0 && last) c = totalCents;               // one payment: the whole job up front
      const wanted = c;
      c = Math.max(0, Math.min(c, left));
      // Cut down because a raised deposit left less than its share: worded
      // as what it really is, so the message never adds up to over 100%.
      const cut = c < wanted && !last && s.how !== 'rest';
      left -= c;
      const pctNow = Math.round(c / totalCents * 100);
      const name = String(s.label || (i === 0 ? 'Deposit' : last ? 'Final' : 'Payment'));
      // How the payment is worded for the customer (see payWords): a share
      // of the total, an amount he typed, or the rest -- never a dollar
      // figure worked out from the total, which goes wrong the moment the
      // total is changed in QuickBooks by hand.
      const how = plan.length === 1 ? 'all'
        : last || s.how === 'rest' ? 'rest'
        : raised === 'materials' ? 'pct'
        : raised === 'minimum' ? 'pct'
        : cut ? 'pct'
        : s.how === 'amount' ? 'amount' : 'pct';
      const pct = how !== 'pct' ? null
        : cut ? Math.floor(c / totalCents * 1000 + 1e-6) / 10      // down to a tenth: never asks for more than is left
        : raised === 'minimum' ? floor.minPct
        : raised === 'materials' ? Math.ceil(c / totalCents * 1000 - 1e-6) / 10   // up to a tenth: still covers the materials
        : num(s.value) !== null ? num(s.value) : pctNow;
      return { label: name + ' (' + pctNow + '%)', name: name, how: how, pct: pct,
               cents: c, raised: raised, minPct: i === 0 ? floor.minPct : null };
    });
  }

  // --------------------------------------------------------------- the lot

  // est: the estimate on the job; ctx: {rules, items, prices, fuel, city}.
  // An estimate made in QuickBooks and accepted there (quickbooks.py
  // _hub_estimate): the customer said yes to QuickBooks' figures, so they
  // stand -- the materials as the one amount it had, its tax, and nothing
  // added on top (no delivery, fuel or rule lines; its list is the whole
  // list). The lines are still worked out at cost from Supplies, for what
  // the job makes and what to order -- and so are what MDS charges to bring
  // them (Jonah, 21 Oct 2026: "none of the materials contain delivery
  // fees") and the fuel, a drive from the shop and back each day of the job
  // (worked on the clock, or on the Job schedule: ctx.jobDays): counted in
  // what the job costs, never added to its price.
  // `reprice` = he chose to price it by his own rules instead.
  const asAccepted = est => !!(est && est.fromQb && typeof est.fromQb.materialsCents === 'number' && !est.fromQb.reprice);

  function price(est, ctx) {
    est = est || {};
    const fixed = asAccepted(est);
    const takeoff = (est.materials || []).map(m => Object.assign(materialLine(m, ctx), { tree: m.tree || null }));
    const added = fixed ? [] : ruleLines(est, takeoff, ctx).map(m => materialLine(m, ctx));
    const all = settleWays(takeoff.concat(added), est);
    const del = deliveries(all, est, ctx);
    // An all-in line is priced after its materials: it is what is left of
    // his figure once they are charged.
    const work = (est.work || []).map(w => workLine(w, ctx, w.kind === 'allin' ? allInParts(w, all, del) : null));
    // Every line's crew-days, however it is priced: they are the days on
    // site (fuel) and what the profit per day is counted over.
    const crewDays = work.reduce((s, w) => s + (w.crewDays || 0), 0);
    const crewTrips = crewDays > 0 ? Math.ceil(trim(crewDays)) : null;
    const fu = fixed ? fuel(est, ctx, num(ctx.jobDays) > 0 ? num(ctx.jobDays) : crewTrips, true) : fuel(est, ctx, crewTrips);
    const materialsCents = fixed ? est.fromQb.materialsCents
      : all.reduce((s, l) => s + l.clientCents, 0) + del.clientCents + fu.clientCents;
    const laborCents = work.reduce((s, w) => s + w.cents, 0);
    const totalCents = materialsCents + laborCents;
    const problems = [];
    // Accepted in QuickBooks, a material with no cost here leaves the price as
    // it is -- only what the job makes unknown -- so it is told apart.
    const noCost = [];
    // Accepted in QuickBooks, a missing markup leaves nothing unknown: the
    // price is QuickBooks' and the cost is known (materialLine).
    all.forEach(l => l.problems.forEach(p => {
      if (fixed && l.noMarkup && /^no markup set/.test(p)) return;
      (fixed ? noCost : problems).push((l.name || 'A material') + ': ' + p);
    }));
    (est.work || []).forEach((w, i) => work[i].problems.forEach(p => problems.push((w.title || 'Labor line') + ': ' + p)));
    del.problems.forEach(p => (fixed ? noCost : problems).push('Delivery: ' + p));
    fu.problems.forEach(p => (fixed ? noCost : problems).push('Fuel: ' + p));
    // What the job makes once everything is paid for: the materials at what
    // they cost landed, delivery and fuel at cost, the crew at the crew-day
    // rate -- and that per crew-day. Only Jonah sees it. Not exact until every
    // line is priced and every labour line has its crew-days.
    const dayCost = num(ctx.rules.crewDayCents);
    const materialCost = all.reduce((s, l) => s + (l.costTotalCents || 0), 0);
    const deliveryCost = del.lines.reduce((s, l) => s + (l.costCents || 0), 0);
    const fuelCost = fu.costCents || 0;
    const laborCost = dayCost !== null ? Math.round(crewDays * dayCost) : 0;
    // Lines done by someone else (workLine's `sub`): what they charge.
    const subs = (est.work || []).map((w, i) => work[i].sub ? Object.assign({ title: w.title || '' }, work[i].sub) : null).filter(Boolean);
    const subCost = subs.reduce((s, x) => s + (x.cents || 0), 0);
    const costCents = materialCost + deliveryCost + fuelCost + laborCost + subCost;
    const profit = {
      cents: totalCents - costCents, costCents: costCents, crewDays: crewDays,
      materialCostCents: materialCost, deliveryCostCents: deliveryCost, fuelCostCents: fuelCost, laborCostCents: laborCost,
      subCostCents: subCost, subs: subs,
      marginPct: totalCents > 0 ? (totalCents - costCents) / totalCents * 100 : null,
      perDayCents: crewDays > 0 ? Math.round((totalCents - costCents) / crewDays) : null,
      // Every line knows its cost: his crew's days, or what the one doing it charges.
      complete: !problems.length && !noCost.length && dayCost !== null &&
        work.every(w => (w.sub ? w.sub.cents !== null : w.crewDays > 0)),
    };
    // Sales tax to the customer (see KIND_TAX). totalCents stays the price
    // before tax -- the profit, the job's price and the dashboards are that;
    // grandCents is what the customer pays, and the payments are of it.
    const tax = salesTax(est, ctx, work, all, del, fu, totalCents);
    if (fixed) {
      // QuickBooks worked out the tax from the address; that is the tax.
      Object.assign(tax, { cents: Math.round(num(est.fromQb.taxCents) || 0), underTen: false, materialsTaxCents: 0,
        problems: [], fromQb: true });
    }
    tax.problems.forEach(p => problems.push('Sales tax: ' + p));
    const grandCents = totalCents + tax.cents;
    return {
      takeoff, added, work, delivery: del, fuel: fu, crewDays, profit,
      materialsCents, laborCents, totalCents, tax, grandCents,
      payments: payments(grandCents, ctx.rules, { plan: est.payments, materialsCents: materialsCents + tax.materialsTaxCents }),
      specialOrder: all.filter(l => l.specialOrder && l.orderQty > 0).map(l => l.name),
      problems, noCost, asAccepted: fixed,
    };
  }

  // What each piece of work on an estimate brings in and costs (Jonah, 21 Oct
  // 2026: "show me labor/materials for each service being done and i want to
  // see profit per service so i can start tracking what services bring in the
  // best profits"). The same price() result split by work line, never sums of
  // its own:
  //   - its labour: the line's price;
  //   - its materials: the ones the crew's page lists under it (workFor --
  //     picked on the material, its all-in line, else by the words), at the
  //     customer's price and at cost, with their share of each truck by
  //     quantity;
  //   - fuel (price and cost) shared by crew-days, the days it is there;
  //   - the crew at the crew-day rate for its own crew-days.
  // What no line takes (a material under none, fuel with no crew-days
  // anywhere, a cent of rounding) is `rest`, so the lines and rest always add
  // up to the job's price and profit. An estimate accepted in QuickBooks has
  // one materials figure: it is shared by what each line's materials cost.
  // r: price(est, ...). workFor(m, lines) -> work line id or ''.
  function byLine(est, r, rulesNow, workFor) {
    const dayCost = num((rulesNow || {}).crewDayCents);
    const ws = est.work || [];
    const lines = ws.map((w, i) => ({ id: w.id, title: w.title || '', w: w,
      laborCents: r.work[i] ? r.work[i].cents : 0, materialsCents: 0, materialCostCents: 0,
      deliveryCostCents: 0, fuelCostCents: 0, fuelCents: 0, laborCostCents: 0,
      crewDays: r.work[i] && r.work[i].crewDays > 0 ? r.work[i].crewDays : 0,
      sub: r.work[i] && r.work[i].sub ? r.work[i].sub : null,
      problems: r.work[i] ? r.work[i].problems.length : 0, count: 0 }));
    const byId = {};
    lines.forEach(l => { if (l.id) byId[l.id] = l; });
    const named = ws.filter(w => w && (w.title || w.scope));
    const owner = {};
    const mats = r.takeoff.concat(r.added);
    const src = {};
    (est.materials || []).forEach(m => { src[m.id] = m; });
    mats.forEach(l => {
      const wid = workFor ? workFor(src[l.id] || l, named) : '';
      const line = wid && byId[wid];
      if (!line) return;
      owner[l.id] = line;
      line.materialsCents += l.clientCents || 0;
      line.materialCostCents += l.costTotalCents || 0;
      line.problems += l.problems.length;
      line.count++;
    });
    ((r.delivery && r.delivery.lines) || []).forEach(d => {
      const parts = d.parts || [], all = parts.reduce((s, p) => s + p.qty, 0);
      if (!(all > 0)) return;
      parts.forEach(p => {
        const line = owner[p.id];
        if (!line) return;
        line.materialsCents += Math.round((d.clientCents || 0) * p.qty / all);
        line.deliveryCostCents += Math.round((d.costCents || 0) * p.qty / all);
      });
    });
    const days = lines.reduce((s, l) => s + l.crewDays, 0);
    if (days > 0) {
      lines.forEach(l => {
        l.fuelCents = Math.round((r.fuel.clientCents || 0) * l.crewDays / days);
        l.fuelCostCents = Math.round((r.fuel.costCents || 0) * l.crewDays / days);
      });
    }
    if (r.asAccepted) {
      // QuickBooks' one materials figure, shared by cost.
      const costAll = r.profit.materialCostCents + r.profit.deliveryCostCents;
      lines.forEach(l => {
        l.materialsCents = costAll > 0 ? Math.round(r.materialsCents * (l.materialCostCents + l.deliveryCostCents) / costAll) : 0;
        l.fuelCents = 0;
      });
    }
    const out = lines.map(l => {
      l.materialsCents += l.fuelCents;
      l.laborCostCents = dayCost !== null ? Math.round(l.crewDays * dayCost) : 0;
      // Done by someone else: what they charge is the line's labour cost.
      const subCents = l.sub && l.sub.cents !== null ? l.sub.cents : 0;
      const priceCents = l.laborCents + l.materialsCents;
      const costCents = l.materialCostCents + l.deliveryCostCents + l.fuelCostCents + l.laborCostCents + subCents;
      return { id: l.id, title: l.title, w: l.w, laborCents: l.laborCents, materialsCents: l.materialsCents,
        priceCents: priceCents, costCents: costCents, profitCents: priceCents - costCents,
        materialCostCents: l.materialCostCents, deliveryCostCents: l.deliveryCostCents,
        fuelCostCents: l.fuelCostCents, laborCostCents: l.laborCostCents, subCostCents: subCents, sub: l.sub,
        crewDays: l.crewDays, materials: l.count,
        marginPct: priceCents > 0 ? (priceCents - costCents) / priceCents * 100 : null,
        perDayCents: l.crewDays > 0 ? Math.round((priceCents - costCents) / l.crewDays) : null,
        complete: !l.problems && dayCost !== null && (l.sub ? l.sub.cents !== null : l.crewDays > 0) };
    });
    const sumP = out.reduce((s, l) => s + l.priceCents, 0), sumC = out.reduce((s, l) => s + l.costCents, 0);
    const restPrice = r.totalCents - sumP, restCost = r.profit.costCents - sumC;
    const rest = { priceCents: restPrice, costCents: restCost, profitCents: restPrice - restCost,
      materials: mats.filter(l => !owner[l.id] && ((l.clientCents || 0) > 0 || (l.costTotalCents || 0) > 0)).map(l => l.name || 'a material') };
    return { lines: out, rest: rest };
  }

  // Which lines are taxed, and the tax. Each work line and material line is
  // marked `taxed` (what goes to QuickBooks as taxable); the materials figure
  // splits into its taxed and untaxed parts, delivery going with its material
  // and fuel with the job.
  function salesTax(est, ctx, work, all, del, fu, totalCents) {
    const r = ctx.rules, out = { cents: 0, ratePct: num(r.customerTaxPct), taxableCents: 0, workCents: 0,
      materialsCents: 0, materialsTaxCents: 0, underTen: false, problems: [] };
    const ws = est.work || [], ms = est.materials || [];
    work.forEach((w, i) => { w.taxable = workTaxable(ws[i] || {}, ctx); });
    const taxedWork = work.filter(w => w.taxable).reduce((s, w) => s + w.cents, 0);
    const builtWork = work.filter(w => !w.taxable).reduce((s, w) => s + w.cents, 0);
    const own = {};
    ms.forEach(m => { if (m.taxable === true || m.taxable === false) own[m.id] = m.taxable; });
    // "As the job is": mostly planting work, or (no labour yet) planting
    // materials on it.
    const leans = work.length ? taxedWork > 0 && taxedWork >= builtWork
      : all.some(l => l.clientCents > 0 && kindTax(r, l.category) === 'always');
    all.forEach(l => {
      const way = kindTax(r, l.category);
      l.taxable = own[l.id] !== undefined ? own[l.id] : way === 'always' ? true : way === 'never' ? false : leans;
    });
    const bySupply = {};
    all.forEach(l => { if (l.taxable && l.supplyId) bySupply[l.supplyId] = true; });
    // A supplier's own delivery brings several things: taxed when any is.
    del.lines.forEach(d => { d.taxable = (d.supplyIds || [d.supplyId]).some(s => !!bySupply[s]); });
    fu.taxable = leans;
    let taxedMat = all.filter(l => l.taxable).reduce((s, l) => s + l.clientCents, 0) +
      del.lines.filter(d => d.taxable).reduce((s, d) => s + d.clientCents, 0) + (fu.taxable ? fu.clientCents || 0 : 0);
    let taxable = taxedWork + taxedMat;
    // A building job with a little planting: under 10% of the price, none of
    // it is taxed (77.54(60)) -- the company pays tax on all its materials.
    const building = builtWork > 0 || all.some(l => !l.taxable && l.clientCents > 0 && kindTax(r, l.category) === 'never');
    if (building && taxable > 0 && totalCents > 0 && taxable < totalCents * 0.1) {
      out.underTen = true;
      taxable = 0; taxedMat = 0;
    }
    work.forEach(w => { w.taxed = !!w.taxable && !out.underTen; });
    all.forEach(l => { l.taxed = !!l.taxable && !out.underTen; });
    del.lines.forEach(d => { d.taxed = !!d.taxable && !out.underTen; });
    fu.taxed = !!fu.taxable && !out.underTen;
    out.taxableCents = taxable;
    out.workCents = out.underTen ? 0 : taxedWork;
    out.materialsCents = taxedMat;
    if (taxable > 0) {
      if (out.ratePct === null) out.problems.push('the sales tax % for customers isn’t set (⋯ → Pricing rules)');
      else {
        out.cents = Math.round(taxable * out.ratePct / 100);
        out.materialsTaxCents = Math.round(taxedMat * out.ratePct / 100);
      }
    }
    return out;
  }

  // What the customer reads in the materials line: every listed material and
  // how much of it -- never a price.
  function fmtQty(q) { return String(Math.round(q * 100) / 100); }
  // "8 yards", "3.75 tons", "23 bags", "120 sq ft", "2" (each).
  function qtyText(q, unit) {
    const u = String(unit || '').trim(), n = fmtQty(q);
    if (!u || /^(each|ea)$/i.test(u)) return n;
    const plural = q !== 1 && /^[a-z]+$/i.test(u) && !/s$/i.test(u) && !/^(lb|ft|sf|lf|sq|cu|yd|gal|oz)$/i.test(u)
      ? u + (/(x|ch|sh)$/i.test(u) ? 'es' : 's') : u;
    return n + ' ' + plural;
  }
  // taxed: true -> only the materials taxed, false -> only those not, left
  // out -> all of them (the two QuickBooks materials lines, sales tax).
  // One product on two lines -- the edging inside the patio's all-in price
  // and the edging for the beds -- is one line for the customer, the two
  // amounts added together.
  function materialsList(result, taxed) {
    const rows = [], byName = {};
    result.takeoff.concat(result.added)
      .filter(l => l.listed && l.orderQty > 0 && (taxed === undefined || !!l.taxed === taxed))
      .forEach(l => {
        const lb = !!(l.partUse && l.usedLb);
        const q = lb ? l.usedLb : l.orderQty, unit = lb ? 'lb' : l.per;
        const key = String(l.name || '').trim().toLowerCase() + '|' + String(unit || '').trim().toLowerCase();
        if (byName[key]) { byName[key].q += q; return; }
        rows.push(byName[key] = { name: l.name, q: q, unit: unit });
      });
    return rows.map(x => x.name + ': ' + qtyText(trim(x.q), x.unit));
  }

  // The last lines of every QuickBooks estimate, in order: the QuickBooks
  // products holding the warranty and the terms and conditions. Customers
  // e-sign the estimate, so these travel on it as lines of their own, one
  // product each because one line holds 4000 characters. Their text is the
  // product's description in QuickBooks; the server reads it when sending.
  // Homes and businesses each have their own list (Wisconsin's home-
  // improvement notices are for homes).
  const END_LISTS = [['items', 'Homes'], ['businessItems', 'Businesses']];
  const endKey = which => (which === 'business' || which === 'businessItems' ? 'businessItems' : 'items');
  function endItems(r, which) {
    const seen = {};
    return ((r.estimateEnd || {})[endKey(which)] || []).map(n => String(n || '').trim())
      .filter(n => n && !seen[n.toLowerCase()] && (seen[n.toLowerCase()] = true));
  }

  // QuickBooks' products with their descriptions, asked for once a session
  // (the Pricing rules list and the estimate preview show the text).
  // A failed ask is not repeated by every redraw -- only by "Check again".
  let qbProducts = null, qbAsking = null, qbFailed = false;
  function loadQbProducts(again) {
    if (again) { qbProducts = null; qbFailed = false; }
    if (qbProducts || qbAsking || qbFailed || !window.YDClaude || !ydCan('billing', 'change')) return qbAsking;
    qbAsking = Promise.resolve(window.YDClaude.post('/qb/items', {})).then(r => {
      qbProducts = {};
      (r && r.items || []).forEach(i => {
        if (i.name && i.type !== 'Category') qbProducts[i.name.toLowerCase()] = { name: i.name, text: String(i.description || '') };
      });
    }).catch(() => { qbProducts = null; qbFailed = true; }).finally(() => { qbAsking = null; changed(); });
    return qbAsking;
  }
  // undefined: not known (yet); null: no such product in QuickBooks.
  const qbProduct = name => (qbProducts ? qbProducts[String(name || '').toLowerCase()] || null : undefined);

  // A snow bid in QuickBooks (estimate.js snowLines), worded as Jonah words
  // the snow estimates he makes there by hand (16 Oct 2026) until he words
  // it otherwise in Pricing rules → Snow bids. {areas} is what gets cleared.
  // The prices and the per-inch sentence are not here: the app writes those
  // (QuickBooks reads them back when the customer says yes). The products are
  // his own, by their full QuickBooks names; Job Hub never makes them.
  const SNOW_BID = {
    intro: 'Clearing of snow from {areas} at:',
    pricedNote: 'Priced per snowfall & subject to change based on snow quantity',
    stormNote: '(For storms our crews visit the home once for every 4-6 inches of snowfall to ensure you are able to get in and ' +
      'out of your home and billing is done for each visit)',
    // A business is not "your home": the same promise, in its words.
    stormNoteBusiness: '(For storms our crews visit once for every 4-6 inches of snowfall to keep your lot and entrances open ' +
      'and billing is done for each visit)',
    saltPaw: 'paw-friendly ice melt spread on drive/walkways',
    saltPlain: 'ice melt spread on drive/walkways',
    laborNote: '',
    items: {
      residential: 'Seasonal Services:Snow Removal:Residential Snow Removal',
      // There is no "Commercial Snow Removal" product in his QuickBooks (checked
      // 16 Oct 2026); the one he put a business lot's clearing on is this.
      commercial: 'Seasonal Services:Snow Removal:Snow Removal',
      salt: 'Seasonal Services:Snow Removal:Salt Application',
      labor: 'Labor',
    },
  };
  const SNOW_WORDS = [['intro', 'First line — what is cleared, then the address under it', '{areas} becomes what gets cleared'],
    ['pricedNote', 'Above the prices', ''], ['stormNote', 'Under the prices — a home', ''],
    ['stormNoteBusiness', 'Under the prices — a business', ''],
    ['saltPaw', 'Salt line — paw-friendly', ''], ['saltPlain', 'Salt line — ordinary ice melt', ''],
    ['laborNote', 'Under “Labor - $X/man hour”', 'optional']];
  const SNOW_ITEMS = [['residential', 'A home’s visit'], ['commercial', 'A business’s visit'], ['salt', 'Salt'], ['labor', 'Labor per man-hour']];
  // His words where he has set them, SNOW_BID's where not (blank = the usual).
  function snowBid(r) {
    const mine = (r && r.snowBid) || {}, items = mine.items || {};
    const out = { items: {} };
    Object.keys(SNOW_BID).forEach(k => {
      if (k !== 'items') out[k] = String(mine[k] == null ? '' : mine[k]).trim() || SNOW_BID[k];
    });
    Object.keys(SNOW_BID.items).forEach(k => { out.items[k] = String(items[k] || '').trim() || SNOW_BID.items[k]; });
    return out;
  }

  // ------------------------------------------------------------- the rules doc

  let rules = blankRules();
  let fuelPrices = {};            // pricing/fuel: {gasCents, dieselCents, asOf, source}
  let claudeText = null;          // pricing/claude: the owner's takeoff rules, as Claude reads them
  let ready = false;
  let unsubs = [];

  function merged(d) {
    const b = blankRules();
    if (!d || typeof d !== 'object') return b;
    Object.keys(b).forEach(k => {
      if (d[k] === undefined) return;
      b[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && d[k] && typeof d[k] === 'object')
        ? Object.assign(b[k], d[k]) : d[k];
    });
    return b;
  }

  function changed() {
    document.dispatchEvent(new CustomEvent('yd-pricing'));
    const m = document.getElementById('prModal');
    if (m && m.classList.contains('active') && !typingIn(m)) renderRules();
  }
  function typingIn(m) {
    const a = document.activeElement;
    return !!(a && m.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName));
  }

  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; rules = blankRules(); fuelPrices = {}; claudeText = null; ready = false;
    saved = null;
  }
  function start() {
    stop();
    if (!ydCan('jobs', 'see') || !window.YDDb) return;
    unsubs.push(window.YDDb.watch('pricing', list => {
      list.forEach(c => {
        if (c.id === 'rules') { rules = c.type === 'removed' ? blankRules() : merged(c.data); ready = true; }
        if (c.id === 'fuel') fuelPrices = c.type === 'removed' ? {} : (c.data || {});
        if (c.id === 'claude') claudeText = c.type === 'removed' ? '' : String((c.data || {}).text || '');
      });
      changed();
    }, () => {}));
  }

  // Not awaited: a write only settles when the server answers.
  function save(patch) {
    const was = rules;
    rules = merged(Object.assign({}, rules, patch));
    logRules(was, rules, patch);
    track(window.YDDb.put('pricing', 'rules', patch)).catch(e => {
      showToast(e && e.code === 'permission-denied' ? 'Only the owner changes the pricing rules' : 'Not saved yet — will retry');
    });
    changed();
  }

  // ------------------------------------------------- who changed what
  //
  // Every rule a save changed goes into the change history (changelog.js),
  // one line per setting, in the words this screen uses. Worked out by
  // comparing the rules before and after, so a new box on this screen is
  // recorded without anyone remembering to.
  //   path -> [what it is, how to show it, kind]
  //   how: money | pct | num | list (of numbers) | moneyList | item | text | onOff
  const RULE_WORDS = {
    taxPct: ['Sales tax we pay on materials', 'pct', 'tax'],
    customerTaxPct: ['Sales tax charged to customers', 'pct', 'tax'],
    crewDayCents: ['Crew-day rate (crew cost)', 'money', 'labor'],
    crewPeople: ['People in a crew', 'num', 'labor'],
    crewPersonHours: ['Paid hours each in a crew-day', 'num', 'labor'],
    crewDayHours: ['Paid hours in a crew-day', 'num', 'labor'],
    profitChoices: ['Profit per crew-day — the amounts', 'moneyList', 'labor'],
    defaultProfitCents: ['Profit per crew-day — the usual one', 'money', 'labor'],
    'profitCents.floor': ['Profit per crew-day — floor', 'money', 'labor'],
    'profitCents.aim': ['Profit per crew-day — aim', 'money', 'labor'],
    'profitCents.great': ['Profit per crew-day — great', 'money', 'labor'],
    defaultProfit: ['Profit per crew-day — usual tier', 'text', 'labor'],
    'delivery.palletCents': ['Pallet charge', 'money', 'delivery'],
    'delivery.loadTons': ['Tons in a delivery load', 'num', 'delivery'],
    'delivery.markupPct': ['Delivery markup', 'pct', 'delivery'],
    'fuel.mpg': ['Truck miles per gallon', 'list', 'fuel'],
    'fuel.bobcatGalPerDay': ['Loader gallons a day', 'num', 'fuel'],
    'fuel.markupPct': ['Fuel markup', 'pct', 'fuel'],
    'dumpster.supplyId': ['Dumpster item', 'item', 'dumpster'],
    'dumpster.maxCuYd': ['Dumpster holds (cu yd)', 'num', 'dumpster'],
    'dumpster.brushSupplyId': ['Brush dumpster item', 'item', 'dumpster'],
    'dumpster.brushMaxCuYd': ['Brush dumpster holds (cu yd)', 'num', 'dumpster'],
    'markers.supplyId': ['Marker item', 'item', 'markers'],
    'markers.count': ['Markers per job', 'num', 'markers'],
    'seed.supplyId': ['Usual grass seed', 'item', 'material'],
    'planting.perPlant': ['Planting package — per plant', 'items', 'planting'],
    'planting.perSingleTree': ['Planting package — per single-stem tree', 'items', 'planting'],
    'planting.perMultiTree': ['Planting package — per multi-stem tree', 'items', 'planting'],
    'payments.splitAboveCents': ['Three payments above', 'money', 'payments'],
    'payments.twoText': ['Two-payment wording', 'text', 'payments'],
    'payments.threeText': ['Three-payment wording', 'text', 'payments'],
    'payments.warranty': ['Warranty wording', 'text', 'payments'],
    'payments.minDepositPct': ['Smallest deposit', 'pct', 'payments'],
    'payments.depositCoversMaterials': ['Deposit covers materials', 'onOff', 'payments'],
    'estimateEnd.items': ['End lines — homes', 'textList', 'terms'],
    'estimateEnd.businessItems': ['End lines — businesses', 'textList', 'terms'],
    'shop.address': ['Shop address', 'text', 'other'],
    'snowBid.intro': ['Snow bid — first line', 'text', 'snow'],
    'snowBid.pricedNote': ['Snow bid — above the prices', 'text', 'snow'],
    'snowBid.stormNote': ['Snow bid — under the prices (a home)', 'text', 'snow'],
    'snowBid.stormNoteBusiness': ['Snow bid — under the prices (a business)', 'text', 'snow'],
    'snowBid.saltPaw': ['Snow bid — paw-friendly salt line', 'text', 'snow'],
    'snowBid.saltPlain': ['Snow bid — salt line', 'text', 'snow'],
    'snowBid.laborNote': ['Snow bid — under the labor rate', 'text', 'snow'],
    'snowBid.items.residential': ['Snow bid — QuickBooks product, a home', 'text', 'snow'],
    'snowBid.items.commercial': ['Snow bid — QuickBooks product, a business', 'text', 'snow'],
    'snowBid.items.salt': ['Snow bid — QuickBooks product, salt', 'text', 'snow'],
    'snowBid.items.labor': ['Snow bid — QuickBooks product, labor', 'text', 'snow'],
    // On while never set (null): said so, not "Off".
    autoDraft: ['Claude starts estimates by itself', 'onUsual', 'other'],
    autoCare: ['Plant-care email on Complete', 'onUsual', 'other'],
    learnFromJobs: ['Claude sees my finished jobs', 'onUsual', 'other'],
  };
  const CAT_WORDS = { markupPct: ['Markup', 'pct'], wastePct: ['Waste', 'pct'], noTax: ['No tax on it', 'onOff'],
                      customerTax: ['Tax to the customer', 'text'] };
  const VENDOR_WORDS = { processingPct: ['Processing charge', 'pct'], cityDelivery: ['Delivers in the city', 'onOff'],
                         deliveryCents: ['Delivery charge to a job', 'money'], deliveryFree: ['Delivery free or in their prices', 'onOff'],
                         deliveryEach: ['Delivery changes every order (checked when ordering)', 'onOff'] };
  function ruleText(v, how) {
    const C = window.YDChangeLog;
    const money = c => (C ? C.money(c) : String(c));
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) {
      return how === 'onOff' ? 'Off (usual)' : how === 'onUsual' ? 'On (usual)' : 'not set';
    }
    if (how === 'money') return typeof v === 'number' ? money(v) : String(v);
    if (how === 'pct') return v + '%';
    if (how === 'onOff' || how === 'onUsual') return v ? 'On' : 'Off';
    if (how === 'way') return v === 'delivered' ? 'Delivered' : v === 'pickup' ? 'Picked up' : String(v);
    if (how === 'moneyList') return [].concat(v).map(money).join(', ');
    if (how === 'item' || how === 'items') {
      const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog().items : {};
      return [].concat(v).map(id => (cat[id] && cat[id].name) || id).join(', ');
    }
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  // { 'delivery.rates.Madison': 5800, ... } -- arrays are one value each.
  function leaves(v, path, out) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.keys(v).forEach(k => leaves(v[k], path ? path + '.' + k : k, out));
    } else out[path] = v;
    return out;
  }
  function ruleLine(path, a, b) {
    const parts = path.split('.');
    let what, field, how, kind;
    if (parts[0] === 'categories' && parts.length >= 3) {
      const w = CAT_WORDS[parts[2]] || [parts[2], 'num'];
      what = 'Material kind — ' + kindName(parts[1]); field = w[0]; how = w[1]; kind = parts[1];
    } else if (parts[0] === 'vendors' && parts.length >= 3) {
      const vs = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog().vendors : {};
      const w = VENDOR_WORDS[parts[2]] || [parts[2], 'num'];
      what = 'Supplier — ' + ((vs[parts[1]] && vs[parts[1]].name) || parts[1]); field = w[0]; how = w[1]; kind = 'supplier';
    } else if (parts[0] === 'delivery' && parts[1] === 'rates' && parts.length >= 3) {
      what = 'Delivery — ' + parts.slice(2).join('.'); field = 'Rate per load'; how = 'money'; kind = 'delivery';
    } else if (parts[0] === 'getWays' && parts.length >= 2) {
      what = 'Delivered or picked up';
      field = parts[1] === 'kinds' ? kindName(parts.slice(2).join('.'))
        : ({ shipped: 'Online or shipped suppliers — delivered', bulk: 'Bulk (by the ton or yard)',
             delivered: 'Words — delivered', pickup: 'Words — picked up' })[parts[1]] || parts[1];
      how = parts[1] === 'shipped' ? 'onOff' : 'way'; kind = 'delivery';
    } else {
      const w = RULE_WORDS[path] || RULE_WORDS[parts[0]] || [path.replace(/\./g, ' — '), 'text', 'other'];
      what = 'Pricing rules'; field = w[0]; how = w[1]; kind = w[2];
    }
    return { area: 'rule', access: 'jobs', kind: kind, what: what, field: field,
             before: ruleText(a, how), after: ruleText(b, how), ref: { path: 'pricing', id: 'rules' } };
  }
  function logRules(was, now, patch) {
    if (!window.YDChangeLog || !ready) return;   // before the rules arrive there is no "before"
    const lines = [];
    Object.keys(patch || {}).forEach(k => {
      // The ways before he first changed them were the starting list.
      const a = leaves(k === 'getWays' ? wayRules(was) : was[k], k, {}), b = leaves(now[k], k, {});
      Object.keys(Object.assign({}, a, b)).forEach(p => {
        const x = a[p] == null || a[p] === '' ? null : a[p], y = b[p] == null || b[p] === '' ? null : b[p];
        if (JSON.stringify(x) === JSON.stringify(y)) return;
        lines.push(ruleLine(p, x, y));
      });
    });
    if (lines.length) window.YDChangeLog.add(lines.slice(0, 60));
  }

  // "Saved ✓ 3:42 pm" at the top of the screen after each change -- every
  // box saves as it is left, and nothing said so. A write is only answered
  // once it reaches the server: with no signal it waits on this device
  // (Firestore sends it when there is signal) and the screen says that
  // instead of pretending; one refused says so too.
  let saved = null;           // { state: 'saving'|'saved'|'waiting'|'failed', at, denied }
  let saveCount = 0;
  const WAIT_MS = 6000;       // longer than this unanswered: say so
  function track(write) {
    const n = ++saveCount;
    saved = { state: navigator.onLine === false ? 'waiting' : 'saving' };
    paintSaved();
    const slow = setTimeout(() => {
      if (n === saveCount && saved && saved.state === 'saving') { saved = { state: 'waiting' }; paintSaved(); }
    }, WAIT_MS);
    return Promise.resolve(write).then(() => {
      clearTimeout(slow);
      // Writes reach the server in order: the newest answered means all are.
      if (n === saveCount) { saved = { state: 'saved', at: new Date() }; paintSaved(); }
    }, e => {
      clearTimeout(slow);
      saved = { state: 'failed', denied: !!(e && e.code === 'permission-denied') };
      paintSaved();
      throw e;
    });
  }
  function savedWords() {
    if (!saved) return ['', ''];
    if (saved.state === 'saving') return ['Saving…', ''];
    if (saved.state === 'saved') {
      return ['Saved ✓ ' + saved.at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), 'Saved to the server'];
    }
    if (saved.state === 'waiting') {
      return ['Not saved yet — no signal?', 'Kept on this device: it goes to the server by itself when there is signal'];
    }
    return [saved.denied ? 'Not saved — only the owner can change these' : 'Not saved — no signal?',
      saved.denied ? '' : 'The server did not take it — change the box again to try again'];
  }
  function savedHtml() {
    const [text, title] = savedWords();
    return '<span class="pr-saved' + (saved ? ' ' + saved.state : '') + '" id="prSaved" role="status" aria-live="polite"' +
      (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
  }
  function paintSaved() {
    const b = el('prSaved');
    if (!b) return;
    const [text, title] = savedWords();
    b.className = 'pr-saved' + (saved ? ' ' + saved.state : '');
    b.textContent = text;
    if (title) b.title = title; else b.removeAttribute('title');
  }

  // ------------------------------------------------------- Pricing rules screen
  //
  // Owner only. Plain boxes for every number, saved as each one changes.

  const el = id => document.getElementById(id);
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const dollars = c => num(c) === null ? '' : (num(c) / 100).toFixed(2);
  const cents = v => { const n = num(v); return n === null ? null : Math.round(n * 100); };

  window.openPricingRules = function () {
    const m = el('prModal');
    if (!m) return;
    m.classList.add('active');
    renderRules();
    loadSpend();
  };

  // ------------------------------------------------- what Claude costs
  //
  // The server writes each day's Claude spend into claudeUsage/{day}
  // (costCents, byTaskCents -- functions/spend.py) and stops every Claude
  // feature at settings/claude.dailyCapCents for the day, or
  // settings/claude.monthlyCapCents for the month. Read when the
  // screen opens; the owner only (the rules say so too).
  let spend = null, claudeSet = {};
  const DEFAULT_CAP_CENTS = 200;       // the server's defaults (spend.py)
  const DEFAULT_MONTH_CAP_CENTS = 2000;
  const TASK_NAME = { estimate: 'Estimates', card: 'Board cards', receipt: 'Reading receipts',
    receiptTriage: 'Sorting email', receiptphoto: 'Receipt photos', care: 'Plant-care emails',
    followup: 'Follow-up emails', posts: 'Social posts', source: 'Finding prices', pricesheet: 'Price sheets', estimate_scope: 'Scopes of work',
    joblog: 'Daily job logs', lessons: 'Lessons from finished jobs' };
  // This month's days only (the screen shows the month and today): the
  // records are named by their UTC day, so asked for by name from the 1st.
  function loadSpend() {
    if (!owner() || !window.YDDb) return;
    const first = new Date().toISOString().slice(0, 7) + '-01';
    const days = window.YDDb.listWhere ? window.YDDb.listWhere('claudeUsage', '__name__', '>=', first) : window.YDDb.list('claudeUsage');
    Promise.all([days, window.YDDb.get('settings', 'claude')]).then(([u, s]) => {
      spend = u || {}; claudeSet = s || {};
      const b = el('prSpend'); if (b) b.innerHTML = spendHtml();
    }).catch(e => console.warn('[pricing] Claude spend not read:', (e && e.code) || e));
  }
  const usd = c => '$' + (Math.round(Number(c) || 0) / 100).toFixed(2);
  function spendHtml() {
    if (!owner()) return '';
    if (!spend) return '<p class="hint">Loading what Claude has cost…</p>';
    const now = new Date(), utcDay = now.toISOString().slice(0, 10), month = utcDay.slice(0, 7);
    const days = Object.keys(spend).filter(d => d.slice(0, 7) === month);
    const today = Number((spend[utcDay] || {}).costCents) || 0;
    let monthCents = 0; const byTask = {};
    days.forEach(d => {
      monthCents += Number(spend[d].costCents) || 0;
      Object.entries(spend[d].byTaskCents || {}).forEach(([t, c]) => { byTask[t] = (byTask[t] || 0) + (Number(c) || 0); });
    });
    const cap = typeof claudeSet.dailyCapCents === 'number' ? claudeSet.dailyCapCents : DEFAULT_CAP_CENTS;
    const monthCap = typeof claudeSet.monthlyCapCents === 'number' ? claudeSet.monthlyCapCents : DEFAULT_MONTH_CAP_CENTS;
    const model = claudeSet.estimateModel === 'opus' ? 'opus' : 'fable';
    const rows = Object.entries(byTask).sort((a, b) => b[1] - a[1]).map(([t, c]) =>
      '<li>' + esc(TASK_NAME[t] || t) + ' — ' + usd(c) + '</li>').join('');
    return '<div class="pr-spend-top"><b>This month ' + usd(monthCents) + '</b> of a ' + usd(monthCap) + ' monthly limit · ' +
        '<b>today ' + usd(today) + '</b> of ' + usd(cap) + ' a day</div>' +
      (rows ? '<ul class="pr-spend-list">' + rows + '</ul>' : '') +
      '<p class="hint">Counted in dollars since this was switched on in October 2026 (before that only word counts were kept). When the month’s or the day’s spending reaches its limit, ' +
        'every Claude feature stops until the next month or day (midnight UTC) — nothing else in the app is affected.</p>' +
      '<label class="pr-field"><span>Monthly limit ($)</span><input inputmode="decimal" value="' + (monthCap / 100).toFixed(2) + '"' +
        ' onchange="prClaudeSet(\'monthlyCapCents\', this.value)"></label>' +
      '<label class="pr-field"><span>Daily limit ($)</span><input inputmode="decimal" value="' + (cap / 100).toFixed(2) + '"' +
        ' onchange="prClaudeSet(\'dailyCapCents\', this.value)"></label>' +
      '<label class="pr-field"><span>Model for estimates</span><select onchange="prClaudeSet(\'estimateModel\', this.value)">' +
        '<option value="fable"' + (model === 'fable' ? ' selected' : '') + '>Fable 5.1 — the best, costs the most</option>' +
        '<option value="opus"' + (model === 'opus' ? ' selected' : '') + '>Opus 5.5 — about 40% of the cost</option></select></label>' +
      // Off since 9 Oct (Jonah: not enough on the boards yet). The server
      // reads the same field (main._card_hour); off unless it is true.
      '<label class="est-switch"><input type="checkbox"' + (claudeSet.cardRuns === true ? ' checked' : '') +
        ' onchange="prClaudeSet(\'cardRuns\', this.checked)"> Claude works the board cards by itself at 7 am and 7 pm</label>' +
      '<p class="hint">' + (claudeSet.cardRuns === true ? '' : 'Off: Claude only does a card when you press 🤖 Ask Claude now on it. ') +
        'Receipts, emails and price lookups use the lower-cost model.</p>';
  }
  window.prClaudeSet = function (k, v) {
    if (!owner()) return;
    let val = v;
    if (k === 'dailyCapCents' || k === 'monthlyCapCents') {
      const n = Number(String(v).replace(/[$,\s]/g, ''));
      if (!(n >= 0) || String(v).trim() === '') { showToast('The limit should be a dollar amount'); loadSpend(); return; }
      val = Math.round(n * 100);
    } else if (k === 'estimateModel') val = v === 'opus' ? 'opus' : 'fable';
    else if (k === 'cardRuns') val = v === true;
    claudeSet = Object.assign({}, claudeSet, { [k]: val });
    const b = el('prSpend'); if (b) b.innerHTML = spendHtml();
    track(window.YDDb.put('settings', 'claude', { [k]: val, updatedAt: new Date().toISOString() })).catch(e => {
      showToast(e && e.code === 'permission-denied' ? 'Only the owner changes this' : 'Not saved yet — will retry');
    });
    showToast('Saved');
  };
  window.closePricingRules = function () { const m = el('prModal'); if (m) m.classList.remove('active'); };

  // His profit-per-crew-day amounts, as chips: add, take off, pick the usual.
  const wholeDollars = c => '$' + Math.round(c / 100).toLocaleString('en-US') + (c % 100 ? '.' + String(Math.abs(c % 100)).padStart(2, '0') : '');
  function profitChoicesHtml(r, ro) {
    const list = profitChoices(r), usual = defaultProfitCents(r);
    return '<div class="pr-profit"><span class="pr-label">Profit per crew-day — the amounts you pick from on an estimate</span>' +
      '<div class="pr-chips">' + (list.length ? list.map(c =>
        '<span class="pr-chip' + (c === usual ? ' on' : '') + '">' + wholeDollars(c) + '/day' +
          (c === usual ? ' <b>· usual</b>'
            : ro ? '' : ' <button class="link-btn" onclick="prProfitUsual(' + c + ')">make usual</button>') +
          (ro ? '' : ' <button class="link-btn" onclick="prProfitRemove(' + c + ')" aria-label="Take off">✕</button>') +
        '</span>').join('') : '<span class="muted">None yet — add the amounts you price by.</span>') + '</div>' +
      (ro ? '' : '<div class="pr-add"><input id="prProfitNew" inputmode="decimal" placeholder="e.g. 750" ' +
        'onkeydown="if (event.key === \'Enter\') prProfitAdd()"> <button class="btn btn-sm" onclick="prProfitAdd()">+ Add an amount</button></div>') +
      '<p class="hint">As many as you like. A crew-day line on an estimate picks one (the usual unless you change it), or takes any amount of its own. ' +
        'Labor on a crew-day line = crew-days × (crew-day rate + this).</p>' +
    '</div>';
  }
  function saveProfit(list, usual) {
    list = list.filter((n, i, a) => n >= 0 && a.indexOf(n) === i).sort((a, b) => a - b);
    if (usual === null || list.indexOf(usual) === -1) usual = list.length ? list[Math.floor((list.length - 1) / 2)] : null;
    save({ profitChoices: list, defaultProfitCents: usual });
  }
  window.prProfitAdd = function () {
    if (!owner()) return;
    const i = el('prProfitNew');
    const c = cents(String((i && i.value) || '').replace(/[$,\s]/g, ''));
    if (c === null || c < 0) { showToast('Type an amount, like 750'); return; }
    saveProfit(profitChoices(rules).concat([c]), defaultProfitCents(rules));
    if (i) i.value = '';
  };
  window.prProfitRemove = function (c) {
    if (!owner()) return;
    saveProfit(profitChoices(rules).filter(x => x !== c), defaultProfitCents(rules) === c ? null : defaultProfitCents(rules));
  };
  window.prProfitUsual = function (c) {
    if (!owner()) return;
    saveProfit(profitChoices(rules), c);
  };

  function box(label, value, onchange, hint, attrs) {
    // A box that brings its own inputmode keeps it (the first of two
    // attributes wins, which left the shop address on a number pad).
    const mode = /inputmode=/.test(attrs || '') ? '' : ' inputmode="decimal"';
    return '<label class="pr-field"><span>' + esc(label) + '</span><input' + mode + ' value="' + esc(value == null ? '' : value) + '"' +
      (owner() ? '' : ' disabled') + ' onchange="' + onchange + '"' + (attrs || '') + '>' +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
  }

  // The products that end every estimate, in order, each with what QuickBooks
  // has for it: its text's length, or that it is missing or empty (an
  // estimate is refused then -- quickbooks._end_lines).
  function endListHtml(ro) {
    loadQbProducts();
    return END_LISTS.map(([key, label]) => '<div class="pr-end-list"><h4 class="pr-end-h">' + label +
      (key === 'businessItems' ? ' <small class="muted">— a job with a Business name; switch it on any estimate</small>' : '') + '</h4>' +
      oneEndList(key, ro) + '</div>').join('');
  }
  function oneEndList(key, ro) {
    const list = endItems(rules, key);
    const state = n => {
      const p = qbProduct(n);
      if (p === undefined) return '<span class="muted">' + (qbFailed ? 'couldn’t reach QuickBooks' : 'checking QuickBooks…') + '</span>';
      if (p === null) return '<span class="warn-text">not in QuickBooks yet — estimates stop until it is</span>';
      if (!p.text.trim()) return '<span class="warn-text">no text in QuickBooks yet</span>';
      return '✓ ' + p.text.trim().length.toLocaleString() + ' characters';
    };
    const k = "'" + key + "'";
    const rows = list.map((n, i) => '<div class="pr-end-row"><span class="pr-end-n">' + (i + 1) + '</span>' +
      '<b>' + esc(n) + '</b><small>' + state(n) + '</small>' +
      (ro ? '' : '<span class="pr-end-act">' +
        '<button class="btn btn-sm" title="Up"' + (i === 0 ? ' disabled' : '') + ' onclick="prEndMove(' + k + ', ' + i + ', -1)">▲</button>' +
        '<button class="btn btn-sm" title="Down"' + (i === list.length - 1 ? ' disabled' : '') + ' onclick="prEndMove(' + k + ', ' + i + ', 1)">▼</button>' +
        '<button class="btn btn-sm" title="Take it off" onclick="prEndRemove(' + k + ', ' + i + ')">✕</button></span>') +
      '</div>');
    const names = qbProducts ? Object.keys(qbProducts).map(q => qbProducts[q].name)
      .filter(n => list.every(x => x.toLowerCase() !== n.toLowerCase())).sort() : [];
    const other = END_LISTS.find(([x]) => x !== key);
    return '<div class="pr-end">' + (rows.join('') || '<p class="hint">Nothing yet — estimates end with the materials line.</p>') +
      (ro ? '' : '<div class="pr-end-add"><input id="prEndNew_' + key + '" list="prEndNames_' + key + '" inputmode="text" placeholder="QuickBooks product, e.g. Warranty">' +
        '<datalist id="prEndNames_' + key + '">' + names.map(n => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
        '<button class="btn btn-sm" onclick="prEndAdd(' + k + ')">+ Add to the end</button>' +
        (endItems(rules, other[0]).length ? '<button class="btn btn-sm" onclick="prEndCopy(' + k + ')">Same as ' + other[1].toLowerCase() + '</button>' : '') +
        '<button class="btn btn-sm" onclick="prEndRecheck()">Check QuickBooks again</button></div>') +
      '</div>';
  }
  function saveEnd(key, list) { save({ estimateEnd: Object.assign({}, rules.estimateEnd, { [endKey(key)]: list }) }); }
  window.prEndAdd = function (key) {
    if (!owner()) return;
    const box = el('prEndNew_' + endKey(key)), n = String(box && box.value || '').replace(/:/g, '-').replace(/\s+/g, ' ').trim();
    if (!n) return;
    const list = endItems(rules, key);
    if (list.some(x => x.toLowerCase() === n.toLowerCase())) { showToast('“' + n + '” is already on the list'); return; }
    const p = qbProduct(n);
    saveEnd(key, list.concat([p ? p.name : n]));
    if (p === null) showToast('Added — make “' + n + '” in QuickBooks with its text before the next estimate');
  };
  window.prEndMove = function (key, i, d) {
    if (!owner()) return;
    const list = endItems(rules, key), j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    saveEnd(key, list);
  };
  // No question first: Undo puts it back where it was.
  window.prEndRemove = function (key, i) {
    if (!owner()) return;
    const list = endItems(rules, key);
    const gone = list[i];
    if (gone == null) return;
    list.splice(i, 1);
    saveEnd(key, list);
    const putBack = () => {
      const now = endItems(rules, key);
      if (now.indexOf(gone) !== -1) return;
      now.splice(Math.min(i, now.length), 0, gone);
      saveEnd(key, now);
    };
    if (typeof showUndo === 'function') showUndo('“' + gone + '” taken off', putBack); else showToast('“' + gone + '” taken off');
  };
  // Start one list from the other (then take off what doesn't belong).
  window.prEndCopy = function (key) {
    if (!owner()) return;
    const other = END_LISTS.find(([x]) => x !== endKey(key))[0];
    // No question first: Undo puts the list back as it was.
    const before = endItems(rules, key).slice();
    saveEnd(key, endItems(rules, other));
    if (before.length && typeof showUndo === 'function') showUndo('List replaced', () => saveEnd(key, before));
  };
  window.prEndRecheck = function () { loadQbProducts(true); changed(); };

  // The Supplies pickers on this screen. Every supply, by name, is sorted
  // and drawn once and kept until Supplies changes (the yd-supplies
  // listener below), not four times over at every redraw; a picker with a
  // choice marks it in the kept string.
  const NO_SUPPLY = '<option value="">— none —</option>';
  const optionOf = i => '<option value="' + esc(i.id) + '">' + esc(i.name) + '</option>';
  let byName = null;          // { list: the supplies by name, html: an option each }
  function suppliesByName() {
    if (byName) return byName;
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {} };
    const cmp = new Intl.Collator().compare;
    const list = Object.values(cat.items).sort((a, b) => cmp(String(a.name), String(b.name)));
    byName = { list: list, html: list.map(optionOf).join('') };
    return byName;
  }
  function supplyOptions(selected, filter) {
    const all = suppliesByName();
    let html = filter ? all.list.filter(filter).map(optionOf).join('') : all.html;
    if (selected) {
      const opt = '<option value="' + esc(selected) + '">';
      html = html.replace(opt, () => '<option value="' + esc(selected) + '" selected>');
    }
    return NO_SUPPLY + html;
  }
  // The planting package is soil, fertiliser, watering bags and the like:
  // its pickers list those kinds of thing -- and any kind already on one of
  // its lists -- rather than every supply there is.
  const PLANTING_KINDS = ['planting', 'soil', 'mulch', 'bagged', 'hardware'];
  function plantingPick(r) {
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {} };
    const kinds = new Set(PLANTING_KINDS);
    ['perPlant', 'perSingleTree', 'perMultiTree'].forEach(k => (r.planting[k] || []).forEach(id => {
      const it = cat.items[id];
      if (it && it.category) kinds.add(it.category);
    }));
    return i => kinds.has(i.category);
  }
  // The usual grass seed's picker: each grass seed in Supplies once, in its
  // biggest bag (the one it is bought and priced by) -- and the one chosen.
  function seedPick(r, cat) {
    const M = window.YDMatch;
    if (!M || !M.isGrassSeed || !cat || !cat.items) return i => i.category === 'seed';
    return i => i.id === r.seed.supplyId || (M.isGrassSeed(i) && M.biggestBag(i.id, cat) === i.id);
  }
  function supplyName(id) {
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {} };
    return (cat.items[id] || {}).name || '(gone from Supplies)';
  }

  // The screen's sections, in order: [id, heading, its name in the index].
  // The index stays at the top of the window while it scrolls (styles.css,
  // ux-w1): the screen is a long one, and Claude's takeoff rules were a
  // long scroll from the labour rate.
  const SECTIONS = [
    ['labor', 'Labor', 'Labor'],
    ['materials', 'Materials & sales tax', 'Materials'],
    ['suppliers', 'Suppliers', 'Suppliers'],
    ['delivery', 'Delivery', 'Delivery'],
    ['getways', 'Delivered or picked up', 'Picked up?'],
    ['fuel', 'Fuel', 'Fuel'],
    ['rule', 'Added by rule', 'By rule'],
    ['payments', 'Payments & the message on the estimate', 'Payments'],
    ['end', 'The end of every QuickBooks estimate', 'Estimate end'],
    ['snow', 'Snow bids — priced per push', 'Snow bids'],
    ['claude', 'Claude', 'Claude'],
    ['takeoff', 'What Claude knows about takeoff', 'Takeoff'],
  ];
  const secHead = id => {
    const s = SECTIONS.find(x => x[0] === id) || [id, id];
    return '<h3 class="pr-h" id="prSec_' + s[0] + '">' + esc(s[1]) + '</h3>';
  };
  function indexHtml() {
    return '<nav class="pr-index" aria-label="Sections of the pricing rules">' +
      '<div class="pr-index-links">' + SECTIONS.map(([id, , short]) =>
        '<button type="button" onclick="prGoTo(\'' + id + '\')">' + esc(short) + '</button>').join('') + '</div>' +
      savedHtml() + '</nav>';
  }
  // The window itself scrolls (the dark backdrop round it); the section's
  // heading lands just under the index, which by then sits at the top --
  // where exactly depends on how many rows the index wraps to.
  window.prGoTo = function (id) {
    const t = el('prSec_' + String(id).replace(/[^a-z]/g, '')), m = el('prModal');
    if (!t || !m) return;
    const bar = m.querySelector('.pr-index');
    const stuckAt = (parseFloat(getComputedStyle(m).paddingTop) || 0) +
      (bar ? parseFloat(getComputedStyle(bar).top) || 0 : 0);
    const below = stuckAt + (bar ? bar.getBoundingClientRect().height : 0) + 10;
    const y = m.scrollTop + t.getBoundingClientRect().top - m.getBoundingClientRect().top - below;
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    m.scrollTo({ top: Math.max(0, y), behavior: still ? 'auto' : 'smooth' });
  };

  function renderRules() {
    const body = el('prBody');
    if (!body) return;
    // The index strip scrolls sideways on a phone: a redraw (every save is
    // one) keeps it where it was rather than snapping back to Labor.
    const strip = body.querySelector('.pr-index-links');
    const stripAt = strip ? strip.scrollLeft : 0;
    const r = rules, ro = !owner();
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { vendors: {} };
    const vendors = Object.values(cat.vendors || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const rates = r.delivery.rates || {};
    const towns = shownTowns = Object.keys(rates).filter(t => num(rates[t]) !== null).sort((a, b) => a.localeCompare(b));
    const fp = fuelPrices || {};
    const pick = (path, sel, filter) => '<select ' + (ro ? 'disabled ' : '') + 'onchange="prSet(\'' + path + '\', this.value, \'id\')">' + supplyOptions(sel, filter) + '</select>';
    const planting = ro ? null : supplyOptions('', plantingPick(r));
    const listPick = key => '<div class="pr-chips">' + ((r.planting[key] || []).map(id =>
        '<span class="pr-chip">' + esc(supplyName(id)) + (ro ? '' : ' <button class="link-btn" onclick="prListRemove(\'' + key + '\', \'' + esc(id) + '\')">✕</button>') + '</span>').join('') || '<span class="muted">none</span>') +
      (ro ? '' : ' <select onchange="prListAdd(\'' + key + '\', this.value)">' + planting + '</select>') + '</div>';

    body.innerHTML = indexHtml() +
      '<p class="hint">How every estimate is priced. Change a number here and every estimate worked out from now on uses it; estimates already sent keep their prices. ' +
        'Only you see this screen, and the customer never sees any of it.' + (ro ? ' <b>Only the owner can change these.</b>' : '') + '</p>' +

      secHead('labor') + '<div class="pr-grid">' +
        box('Crew-day rate ($)', dollars(r.crewDayCents), "prSet('crewDayCents', this.value, 'cents')", 'what a crew-day costs, for estimating') +
        box('People in a crew', r.crewPeople, "prCrewDay('crewPeople', this.value)", 'the people in one crew-day') +
        box('Hours each in a crew-day', r.crewPersonHours, "prCrewDay('crewPersonHours', this.value)",
          'paid hours a person works in a day, lunch left out' +
          (num(r.crewDayHours) > 0 ? ' — a crew-day is ' + num(r.crewDayHours) + ' paid hours. Turns clocked hours into crew-days'
            : '. With both set, clocked hours are turned into crew-days')) +
      '</div>' +
      profitChoicesHtml(r, ro) +
      // Services priced by the unit, with their adjustments and his notes on
      // how each is priced (estimate.js, Services).
      '<p class="hint">Services priced another way — turf by the sq ft, with what adjusts it — and your notes on how ' +
        'each service is priced: <button class="btn btn-sm" onclick="openPriceBook()">🧰 Services &amp; how they’re priced</button></p>' +

      secHead('materials') + '<div class="pr-grid">' +
        box('Sales tax on purchases (%)', r.taxPct, "prSet('taxPct', this.value, 'num')", 'added to every material cost before markup') +
        box('Sales tax charged to customers (%)', r.customerTaxPct, "prSet('customerTaxPct', this.value, 'num')",
          'on planting, sod, seed, mulch and lawn care — state + county where the job is') +
        '<label class="pr-field"><span>Grass seed when a job doesn’t name one (from Supplies)</span>' +
          pick('seed.supplyId', r.seed.supplyId, seedPick(r, cat)) +
          '<small>Priced by the pound from its biggest bag. Claude uses it unless you name another seed; ' +
          'any estimate line can be given another seed by hand.</small></label>' +
      '</div>' +
      '<p class="hint">Wisconsin taxes landscaping and lawn care to the customer (labor and materials); patios, walls, walks, ' +
        'drainage, grading and snow are not taxed (you pay the tax when you buy their materials). On an estimate, each line is ' +
        'taxed or not from what it is — set any line by hand there. “Taxed to customer” below: Always, Never, or As the job is ' +
        '(mostly planting work, or mostly building). “Not taxed when bought”: you don’t pay purchase tax on it (a rental; ' +
        'plants or mulch bought with a resale certificate).</p>' +
      '<table class="pr-table"><thead><tr><th>Category</th><th>Markup %</th><th>Waste %</th><th>Not taxed when bought</th><th>Taxed to customer</th></tr></thead><tbody>' +
        // A kind goes in an onchange through data-k: his own have spaces and apostrophes.
        allKinds().map(([id, name]) => {
          const c = r.categories[id] || {};
          const at = ' data-k="' + esc(id) + '"' + (ro ? ' disabled' : '');
          const cell = (k, v) => '<td><input inputmode="decimal" value="' + esc(v == null ? '' : v) + '"' + at +
            ' onchange="prCat(this.dataset.k, \'' + k + '\', this.value)"></td>';
          const mine = !CATEGORY_NAME[id];
          return '<tr><td>' + esc(name) + (mine ? ' <span class="muted">(yours)</span>' +
              (ro ? '' : ' <button class="link-btn"' + at + ' onclick="prKindRename(this.dataset.k)">✎ Rename</button>') : '') + '</td>' +
            cell('markupPct', c.markupPct) + cell('wastePct', c.wastePct) +
            '<td><input type="checkbox"' + (c.noTax ? ' checked' : '') + at +
            ' onchange="prCat(this.dataset.k, \'noTax\', this.checked)"></td>' +
            '<td><select' + at + ' onchange="prCat(this.dataset.k, \'customerTax\', this.value)">' +
              TAX_WAYS.map(([k, n]) => '<option value="' + k + '"' + (kindTax(r, id) === k ? ' selected' : '') + '>' + n + '</option>').join('') +
            '</select></td></tr>';
        }).join('') + '</tbody></table>' +
      (ro ? '' : '<div class="field-actions"><button class="btn btn-sm" onclick="prKindAdd()">+ Add a kind of material</button></div>') +
      '<p class="hint">An item in Supplies can have its own markup or waste; these are for everything else in the category. ' +
        '“No tax” leaves the sales tax off that kind of thing (a rental, say). A kind you add is picked on an item in Supplies ' +
        '(Edit → For estimates → Kind of material), where you can add one too.</p>' +

      secHead('suppliers') +
      (vendors.length ? '<table class="pr-table"><thead><tr><th>Supplier</th><th>Card/processing fee %</th><th>Delivery to a job</th></tr></thead><tbody>' +
        vendors.map(v => {
          const vr = r.vendors[v.id] || {};
          return '<tr><td>' + esc(v.name || '') + '</td><td><input inputmode="decimal" value="' + esc(vr.processingPct == null ? '' : vr.processingPct) + '"' +
            (ro ? ' disabled' : '') + ' onchange="prVendor(\'' + esc(v.id) + '\', \'processingPct\', this.value)"></td>' +
            '<td>' + vendorDeliveryHtml(v.id, vr, ro) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="hint">How each supplier charges to bring an order to a job. <b>By town</b>: the MDS book — one load per bulk material ' +
          'or pallet, at the town’s rate below. <b>A set charge</b>: what they charge each time they deliver to a job, whatever is on it. ' +
          '<b>Changes every order</b>: shipped by weight or by the order (turf, drainage grid) — each job’s order list asks for the charge ' +
          'once you’ve checked it with them, and says it isn’t checked until then. ' +
          '<b>Free or in their prices</b>: online stores that ship free, a dumpster company. Anything marked 🚚 Delivered from a supplier ' +
          'with none of these says so on the estimate and the order list instead of costing $0.</p>'
        : '<p class="muted">No suppliers in Supplies yet.</p>') +

      secHead('delivery') + '<div class="pr-grid">' +
        box('Pallet / boulder surcharge per load ($)', dollars(r.delivery.palletCents), "prSet('delivery.palletCents', this.value, 'cents')") +
        box('Most tons in one load', r.delivery.loadTons, "prSet('delivery.loadTons', this.value, 'num')") +
        box('Markup on delivery (%)', r.delivery.markupPct, "prSet('delivery.markupPct', this.value, 'num')") +
      '</div>' +
      '<details class="pr-towns"><summary>Delivery rate by town (' + towns.length + ')</summary>' +
        '<div class="pr-town-list">' + towns.map((t, i) => '<label><span>' + esc(t) + '</span><input inputmode="decimal" value="' + dollars(rates[t]) + '"' +
          (ro ? ' disabled' : '') + ' onchange="prTownAt(' + i + ', this.value)"></label>').join('') + '</div>' +
        (ro ? '' : '<div class="field-actions"><button class="btn btn-sm" onclick="prTownAdd()">+ Add a town</button></div>') +
      '</details>' +

      secHead('getways') + waysHtml(r, ro) +

      secHead('fuel') + '<div class="pr-grid">' +
        box('Truck mpg (each truck, comma between)', (r.fuel.mpg || []).join(', '), "prSet('fuel.mpg', this.value, 'list')", 'every truck makes the round trip every day') +
        box('Loader diesel (gallons a day)', r.fuel.bobcatGalPerDay, "prSet('fuel.bobcatGalPerDay', this.value, 'num')") +
        box('Markup on fuel (%)', r.fuel.markupPct, "prSet('fuel.markupPct', this.value, 'num')") +
        box('Shop address (where trips start)', r.shop.address || '', "prSet('shop.address', this.value, 'text')", '', ' id="prShopAddr" inputmode="text" data-addr="line" autocomplete="off"') +
      '</div>' +
      '<p class="hint">Gas ' + (num(fp.gasCents) !== null ? '$' + (num(fp.gasCents) / 100).toFixed(3) : '—') +
        ' · diesel ' + (num(fp.dieselCents) !== null ? '$' + (num(fp.dieselCents) / 100).toFixed(3) : '—') +
        (fp.asOf ? ' a gallon, week of ' + esc(fp.asOf) : '') + (fp.source ? ' (' + esc(fp.source) + ')' : '') +
        '. Fetched once a week; an estimate can use a different price.</p>' +

      secHead('rule') +
      '<div class="pr-grid">' +
        '<label class="pr-field"><span>Usual dumpster — soil, rock, debris, brush (from Supplies)</span>' + pick('dumpster.supplyId', r.dumpster.supplyId, i => i.category === 'dumpster') + '</label>' +
        box('Most cubic yards of soil or rock in one', r.dumpster.maxCuYd, "prSet('dumpster.maxCuYd', this.value, 'num')") +
        '<label class="pr-field"><span>Bigger dumpster, only ever filled with brush (from Supplies)</span>' + pick('dumpster.brushSupplyId', r.dumpster.brushSupplyId, i => i.category === 'dumpster') + '</label>' +
        box('Most cubic yards of brush in one', r.dumpster.brushMaxCuYd, "prSet('dumpster.brushMaxCuYd', this.value, 'num')") +
        '<label class="pr-field"><span>Layout markers (from Supplies)</span>' + pick('markers.supplyId', r.markers.supplyId) + '</label>' +
        box('Markers per paving, stone edging or (not boulder) wall job', r.markers.count, "prSet('markers.count', this.value, 'num')") +
      '</div>' +
      '<div class="pr-field wide"><span>Planting package — for every plant (set each item’s “covers” in Supplies, e.g. soil 0.5 plants a bag). ' +
        'The lists offer planting-package, soil, mulch, bagged and hardware items; to add something else, give it one of those kinds in Supplies.</span>' + listPick('perPlant') + '</div>' +
      '<div class="pr-field wide"><span>For every single-trunk tree</span>' + listPick('perSingleTree') + '</div>' +
      '<div class="pr-field wide"><span>For every multi-trunk or evergreen tree</span>' + listPick('perMultiTree') + '</div>' +

      secHead('payments') + '<div class="pr-grid">' +
        box('Three payments above ($)', dollars(r.payments.splitAboveCents), "prSet('payments.splitAboveCents', this.value, 'cents')", '50/50 up to this total; 50/25/25 above it') +
        box('Smallest deposit (% of the job)', num(r.payments.minDepositPct) !== null ? num(r.payments.minDepositPct) : 50,
          "prSet('payments.minDepositPct', this.value, 'num')", 'a deposit set lower on an estimate is raised to this') +
      '</div>' +
      '<label class="est-switch"><input type="checkbox"' + (r.payments.depositCoversMaterials !== false ? ' checked' : '') + (ro ? ' disabled' : '') +
        ' onchange="prSet(\'payments.depositCoversMaterials\', this.checked, \'bool\')"> The deposit always covers all the materials</label>' +
      '<p class="hint">Each estimate can set its own deposit and payments, as a % or a dollar amount — never below these.</p>' +
      ['twoText', 'threeText'].map(k => '<label class="pr-field wide"><span>' +
        ({ twoText: 'Payment terms — two payments', threeText: 'Payment terms — three payments' })[k] +
        '</span><textarea rows="3"' + (ro ? ' disabled' : '') + ' onchange="prSet(\'payments.' + k + '\', this.value, \'text\')">' +
        esc(r.payments[k] || '') + '</textarea></label>').join('') +

      secHead('end') +
      '<p class="hint">Customers e-sign the estimate itself, so the warranty and the terms and conditions go on it as its last lines ($0 each), ' +
        'in this order. Each is a product in QuickBooks: its text is the product’s description there (4,000 characters at most — ' +
        'split longer terms into more products). Change the wording in QuickBooks; the next estimate carries it.</p>' +
      endListHtml(ro) +

      secHead('snow') + snowBidHtml(r, ro) +

      secHead('claude') +
      '<div class="pr-spend" id="prSpend">' + spendHtml() + '</div>' +
      '<label class="est-switch"><input type="checkbox"' + (r.autoDraft !== false ? ' checked' : '') + (ro ? ' disabled' : '') +
        ' onchange="prSet(\'autoDraft\', this.checked, \'bool\')"> Start the estimate by itself when I finish my site-visit notes</label>' +
      '<p class="hint">Each estimate Claude builds costs money (see above). Off, it waits for “Build the estimate from my notes”.</p>' +
      '<label class="est-switch"><input type="checkbox"' + (r.autoCare !== false ? ' checked' : '') + (ro ? ' disabled' : '') +
        ' onchange="prSet(\'autoCare\', this.checked, \'bool\')"> Draft the plant-care email when a job with plants is marked Complete</label>' +
      '<p class="hint">It goes to your Gmail Drafts for you to read and send — never straight to the customer.</p>' +
      '<label class="est-switch"><input type="checkbox"' + (r.learnFromJobs !== false ? ' checked' : '') + (ro ? ' disabled' : '') +
        ' onchange="prSet(\'learnFromJobs\', this.checked, \'bool\')"> Show Claude my finished jobs most like each bid, and what they really took</label>' +
      '<p class="hint">With each estimate message Claude sees a few of your finished jobs most like the bid — their work, materials and ' +
        'price, the clock’s hours as crew-days, and what the crew noted — without names or addresses, as examples. For each kind of work ' +
        'on the bid with 3 or more finished jobs, what they were bid at against what they really took. Your rules above always win. ' +
        'About a cent more a message. Under each answer: “📚 Based on N of your finished jobs”.</p>' +
      secHead('takeoff') +
      '<p class="hint">Your rules for laying out an estimate — base depths, conversions, install standards, how a scope is written, the clauses every estimate carries. ' +
        'Claude reads all of this with every message about an estimate. Prices and markups don’t belong here; the app works those out.</p>' +
      '<textarea class="pr-claude" rows="18"' + (ro ? ' disabled' : '') + ' onchange="prClaude(this.value)">' + esc(claudeText || '') + '</textarea>';
    const again = body.querySelector('.pr-index-links');
    if (again && stripAt) again.scrollLeft = stripAt;
  }

  // Delivered or picked up (wayOf): which way each material is got, by his
  // rules, in the order they are tried.
  const WAY_PICK = [['', '— no rule'], ['delivered', '🚚 Delivered'], ['pickup', '🏪 Picked up']];
  function waysHtml(r, ro) {
    const g = wayRules(r), dis = ro ? ' disabled' : '';
    const sel = (cur, on, at) => '<select' + dis + (at || '') + ' onchange="' + on + '">' + WAY_PICK.map(([k, n]) =>
      '<option value="' + k + '"' + ((cur || '') === k ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>';
    const words = way => '<div class="pr-field wide"><span>' + (way === 'delivered' ? '🚚 Delivered' : '🏪 Picked up') +
        ' when its name says</span><div class="pr-chips">' +
      ((Array.isArray(g[way]) ? g[way] : []).map((w, i) => '<span class="pr-chip">' + esc(w) +
        (ro ? '' : ' <button class="link-btn" aria-label="Take off ' + esc(w) + '" onclick="prWayWordOff(\'' + way + '\', ' + i + ')">✕</button>') +
        '</span>').join('') || '<span class="muted">none</span>') +
      (ro ? '' : ' <input class="pr-way-add" inputmode="text" placeholder="+ add a word" onchange="prWayWordAdd(\'' + way + '\', this.value)">') +
      '</div></div>';
    return '<p class="hint">Whether each material is brought to the job (🚚) or we fetch it (🏪). Picked up, it carries no delivery charge; ' +
        'delivered, a bulk load or a pallet from a supplier who delivers by town gets its truck (Delivery, above). The first of these that ' +
        'fits a material decides: <b>the line itself</b> — 🚚 / 🏪 on the estimate or the order list, for the odd time it goes the other way; ' +
        '<b>the item</b> in Supplies (Edit → How we get it); then the rules below, top to bottom. Bids already sent keep the delivery they were priced with.</p>' +
      '<label class="est-switch"><input type="checkbox"' + (g.shipped !== false ? ' checked' : '') + dis +
        ' onchange="prWaySet(\'shipped\', this.checked)"> Anything from a supplier we can’t drive to (🌐 online only, 📦 ships to us — ' +
        'ticked on the supplier in Supplies) is delivered</label>' +
      words('delivered') + words('pickup') +
      '<details class="pr-towns"><summary>By kind of material (' + Object.keys(g.kinds || {}).filter(k => WAYS.indexOf(g.kinds[k]) !== -1).length + ' set)</summary>' +
        '<div class="pr-town-list">' + allKinds().filter(([id]) => id !== 'rental' && NOT_FOR_ESTIMATES.indexOf(id) === -1).map(([id, name]) =>
          '<label><span>' + esc(name) + '</span>' + sel((g.kinds || {})[id], 'prWayKind(this.dataset.k, this.value)', ' data-k="' + esc(id) + '"') + '</label>').join('') +
        '</div><p class="hint">Rentals are left out: the crew’s page has them on their own, with the shop to pick them up from.</p></details>' +
      '<div class="pr-grid"><label class="pr-field"><span>Sold loose by the ton or the yard (bulk rock, soil, mulch, sand)</span>' +
        sel(g.bulk, 'prWaySet(\'bulk\', this.value)') + '</label></div>' +
      '<p class="hint">Nothing above fits it: a bulk load or a pallet from a supplier who delivers by town is delivered; a small thing from ' +
        'a supplier whose truck is coming to the job anyway comes on that truck; anything else is picked up.</p>';
  }
  // Saved whole each time (the first change copies the starting list), a
  // kind with no rule as null: the server merges maps.
  function saveWays(change) {
    if (!owner()) return;
    const g = JSON.parse(JSON.stringify(wayRules(rules)));
    g.kinds = g.kinds || {};
    WAYS.forEach(w => { if (!Array.isArray(g[w])) g[w] = []; });
    change(g);
    save({ getWays: g });
  }
  window.prWaySet = function (k, v) {
    saveWays(g => { g[k] = k === 'shipped' ? !!v : (WAYS.indexOf(v) !== -1 ? v : null); });
  };
  window.prWayKind = function (kind, v) {
    if (!kind) return;
    saveWays(g => { g.kinds[kind] = WAYS.indexOf(v) !== -1 ? v : null; });
  };
  window.prWayWordAdd = function (way, v) {
    const w = String(v || '').replace(/[^\w\s'&-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
    if (WAYS.indexOf(way) === -1 || !w) return;
    // A word is in one list only: put under the other, it moves.
    saveWays(g => {
      WAYS.forEach(x => { g[x] = g[x].filter(y => String(y).toLowerCase() !== w); });
      g[way] = g[way].concat([w]);
    });
    renderRules();
  };
  window.prWayWordOff = function (way, i) {
    if (WAYS.indexOf(way) === -1) return;
    saveWays(g => { g[way] = g[way].filter((y, j) => j !== i); });
  };

  window.prClaude = function (v) {
    if (!owner()) return;
    const was = claudeText;
    claudeText = String(v || '');
    // The text is too long to keep twice: the history says it changed, and
    // how long it was and is.
    if (was !== null && was !== claudeText && window.YDChangeLog) {
      const size = t => (t ? t.length.toLocaleString('en-US') + ' characters' : 'empty');
      window.YDChangeLog.add({ area: 'rule', access: 'jobs', kind: 'claude', what: 'Claude’s takeoff rules',
                               field: 'Text', before: size(was), after: size(claudeText), ref: { path: 'pricing', id: 'claude' } });
    }
    track(window.YDDb.put('pricing', 'claude', { text: claudeText, updatedAt: new Date().toISOString() })).catch(e => {
      showToast(e && e.code === 'permission-denied' ? 'Only the owner changes the pricing rules' : 'Not saved yet — will retry');
    });
    showToast('Saved — Claude reads this from the next message');
  };

  // Snow bids: the words and the products (estimate.js snowLines). Each box
  // shows what goes on the bid now; emptied, it is back to the usual.
  function snowBidHtml(r, ro) {
    const w = snowBid(r);
    const dis = ro ? ' disabled' : '';
    return '<p class="hint">A bid whose services are snow work (or switched to a snow bid on the estimate) is a price per push — ' +
        'no miles, fuel, materials or crew-days. It goes to QuickBooks as you write snow estimates there: the first line says what is ' +
        'cleared and where, then the prices by depth; salt, extras and labor on lines of their own. No warranty, terms or lien notice. ' +
        'The prices and the per-inch sentence are written by the app. Empty a box to go back to the usual wording.</p>' +
      SNOW_WORDS.map(([k, label, hint]) => '<label class="pr-field wide"><span>' + esc(label) + (hint ? ' <small class="muted">— ' + esc(hint) + '</small>' : '') +
        '</span><textarea rows="' + (/^stormNote/.test(k) ? 3 : 2) + '"' + dis + ' onchange="prSnow(\'' + k + '\', this.value)">' +
        esc(w[k]) + '</textarea></label>').join('') +
      '<p class="hint">The QuickBooks products, by their full names (Category:Sub-category:Product). They must be in QuickBooks — ' +
        'Job Hub never makes them; a missing one stops the bid before anything is sent.</p>' +
      '<div class="pr-grid">' + SNOW_ITEMS.map(([k, label]) => '<label class="pr-field"><span>' + esc(label) + '</span>' +
        '<input value="' + esc(w.items[k]) + '"' + dis + ' onchange="prSnowItem(\'' + k + '\', this.value)"></label>').join('') + '</div>';
  }
  // Kept only when it differs from the usual, so a better usual reaches him.
  const ownWords = (v, usual) => { const t = String(v || '').trim(); return t === usual ? '' : t; };
  window.prSnow = function (k, v) {
    if (!owner() || !SNOW_WORDS.some(x => x[0] === k)) return;
    save({ snowBid: Object.assign({}, rules.snowBid, { [k]: ownWords(v, SNOW_BID[k]) }) });
  };
  window.prSnowItem = function (k, v) {
    if (!owner() || !(k in SNOW_BID.items)) return;
    const items = Object.assign({}, (rules.snowBid || {}).items, { [k]: ownWords(v, SNOW_BID.items[k]) });
    save({ snowBid: Object.assign({}, rules.snowBid, { items: items }) });
  };

  // path like 'delivery.markupPct'; kind: num | cents | text | id | list | bool
  window.prSet = function (path, v, kind) {
    if (!owner()) return;
    let val;
    if (kind === 'bool') val = !!v;
    else if (kind === 'cents') val = cents(v);
    else if (kind === 'num') val = num(v);
    else if (kind === 'list') val = String(v || '').split(/[,\s]+/).map(num).filter(n => n !== null);
    else if (kind === 'id') val = v || null;
    else val = String(v || '').trim();
    if ((kind === 'cents' || kind === 'num') && String(v).trim() !== '' && val === null) {
      showToast('That isn’t a number'); renderRules(); return;
    }
    const [head, sub] = path.split('.');
    if (sub) save({ [head]: Object.assign({}, rules[head], { [sub]: val }) });
    else save({ [head]: val });
  };
  // People in a crew or hours each: the crew-day's paid hours are saved with
  // them, so what reads crewDayHours (jobcosts.js, pastjobs.py) never
  // multiplies for itself. Either one emptied empties it.
  window.prCrewDay = function (k, v) {
    if (!owner() || (k !== 'crewPeople' && k !== 'crewPersonHours')) return;
    const n = num(v);
    if (String(v).trim() !== '' && !(n > 0)) { showToast('That isn’t a number'); renderRules(); return; }
    const parts = Object.assign({ crewPeople: rules.crewPeople, crewPersonHours: rules.crewPersonHours }, { [k]: n });
    const total = num(parts.crewPeople) > 0 && num(parts.crewPersonHours) > 0
      ? Math.round(num(parts.crewPeople) * num(parts.crewPersonHours) * 100) / 100 : null;
    save({ [k]: n, crewDayHours: total });
  };
  window.prCat = function (id, k, v) {
    if (!owner()) return;
    if (k === 'noTax') {
      const cats = Object.assign({}, rules.categories);
      cats[id] = Object.assign({}, cats[id], { noTax: !!v });
      save({ categories: cats });
      return;
    }
    if (k === 'customerTax') {
      const cats = Object.assign({}, rules.categories);
      cats[id] = Object.assign({}, cats[id], { customerTax: TAX_WAYS.some(([w]) => w === v) ? v : null });
      save({ categories: cats });
      return;
    }
    const n = num(v);
    if (String(v).trim() !== '' && n === null) { showToast('That isn’t a number'); renderRules(); return; }
    const cats = Object.assign({}, rules.categories);
    cats[id] = Object.assign({}, cats[id], { [k]: n });
    save({ categories: cats });
  };
  // A new kind is listed once it has a markup: ask for it straight away.
  // One window with all three questions, each checked as it is answered.
  window.prKindAdd = async function () {
    if (!owner()) return;
    const isNum = v => String(v).trim() === '' || num(v) !== null ? '' : 'That isn’t a number';
    const a = await ydForm('', [
      { id: 'name', label: 'The new kind of material', placeholder: 'e.g. Lighting, Irrigation', required: true,
        check: v => {
          const k = kindFor(v);
          if (!k) return 'Type a name';
          return CATEGORY_NAME[k] || (rules.categories[k] && rules.categories[k].markupPct != null)
            ? '“' + kindName(k) + '” is already on the list' : '';
        } },
      { id: 'markup', label: 'Markup %', type: 'number', placeholder: 'Blank to set it later', check: isNum },
      { id: 'waste', label: 'Waste %', type: 'number', placeholder: 'Blank for none', check: isNum },
    ], { title: 'Add a kind of material', ok: 'Add it' });
    if (!a) return;
    const id = kindFor(a.name);
    if (!id) return;
    const m = a.markup, w = a.waste;
    // The whole map: save() replaces it on this device (the server merges).
    save({ categories: Object.assign({}, rules.categories, { [id]: { markupPct: num(m), wastePct: num(w), noTax: false } }) });
    showToast('“' + id + '” added — pick it on items in Supplies');
    renderRules();
  };
  // One of his kinds moved onto another (renamed, or merged into one that is
  // already there -- services.js "Your other lists"): every item of it moves,
  // and its markup and waste go with it unless the kind it joins has its own.
  // A built-in kind keeps its own rule. Returns how many items moved.
  function mergeKind(was, to) {
    if (!owner() || !was || !to || was === to || CATEGORY_NAME[was]) return 0;
    const n = window.YDSupplies && window.YDSupplies.renameKind ? window.YDSupplies.renameKind(was, to) : 0;
    const cats = Object.assign({}, rules.categories);
    if (!CATEGORY_NAME[to]) cats[to] = rules.categories[to] || rules.categories[was] || null;
    cats[was] = null;                  // null, not left out: the server merges the map
    const patch = { categories: cats };
    // Its delivered-or-picked-up rule goes with it.
    const g = rules.getWays;
    if (g && g.kinds && WAYS.indexOf(g.kinds[was]) !== -1) {
      const kinds = Object.assign({}, g.kinds, { [was]: null });
      if (!CATEGORY_NAME[to] && WAYS.indexOf(kinds[to]) === -1) kinds[to] = g.kinds[was];
      patch.getWays = Object.assign({}, g, { kinds: kinds });
    }
    save(patch);
    return n;
  }
  // His own kind renamed everywhere: on every item that is that kind, and its
  // markup and waste moved across.
  window.prKindRename = async function (was) {
    if (!owner() || !was || CATEGORY_NAME[was]) return;
    const typed = await ydPrompt('Every item of this kind moves to the new name, with its markup and waste.', was,
      { title: 'Rename “' + was + '”', ok: 'Rename', required: true });
    if (typed == null) return;
    let to = kindFor(typed);
    if (to === was && String(typed).trim() !== was) to = String(typed).replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!to || to === was) return;
    const n = mergeKind(was, to);
    showToast('Renamed — ' + n + ' item' + (n === 1 ? '' : 's') + ' moved to “' + kindName(to) + '”');
    renderRules();
  };
  window.prVendor = function (id, k, v) {
    if (!owner()) return;
    const vs = Object.assign({}, rules.vendors);
    vs[id] = Object.assign({}, vs[id], { [k]: k === 'cityDelivery' ? !!v : num(v) });
    save({ vendors: vs });
  };
  // How a supplier charges to bring an order to a job (deliveries()): one of
  // by town (cityDelivery), a set charge each delivery (deliveryCents), free
  // or in their prices (deliveryFree), changes every order (deliveryEach:
  // checked with them per job) -- or not set. Also set from under an
  // order list's delivery that has no price (app.js), where the gap shows.
  const chargeOpen = {};      // supplier id -> "A set charge" picked, no amount typed yet
  function deliveryHow(vid, vr) {
    vr = vr || {};
    return vr.cityDelivery ? 'town' : vr.deliveryEach ? 'each' : vr.deliveryFree ? 'free' : num(vr.deliveryCents) !== null || chargeOpen[vid] ? 'charge' : '';
  }
  const DELIVERY_HOWS = [['', 'Not set yet'], ['town', 'By town (MDS book)'], ['charge', 'A set charge each delivery'],
                         ['each', 'Changes every order — check it'], ['free', 'Free, or in their prices']];
  function vendorDeliveryHtml(vid, vr, ro) {
    const how = deliveryHow(vid, vr), id = String(vid).replace(/[^A-Za-z0-9_-]/g, '');
    return '<span class="pr-del"><select' + (ro ? ' disabled' : '') + ' aria-label="How they charge to deliver" onchange="prDelivery(\'' + id + '\', this.value)">' +
        DELIVERY_HOWS.map(([k, n]) => '<option value="' + k + '"' + (k === how ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>' +
      (how === 'charge' ? ' <label class="pr-del-amt">$<input id="prDel_' + id + '" inputmode="decimal" placeholder="per delivery" value="' +
        dollars((vr || {}).deliveryCents) + '"' + (ro ? ' disabled' : '') + ' onchange="prDeliveryCents(\'' + id + '\', this.value)"></label>' : '') + '</span>';
  }
  function setVendorDelivery(vid, how, cents) {
    if (!owner() || !vid) return false;
    const vs = Object.assign({}, rules.vendors);
    const was = vs[vid] || {};
    chargeOpen[vid] = how === 'charge';
    // Each way clears the others (null: saves merge, so a key left out stays).
    vs[vid] = Object.assign({}, was, {
      cityDelivery: how === 'town',
      deliveryFree: how === 'free' ? true : null,
      deliveryEach: how === 'each' ? true : null,
      deliveryCents: how === 'charge' ? (cents !== undefined ? cents : num(was.deliveryCents)) : null,
    });
    save({ vendors: vs });
    return true;
  }
  window.prDelivery = function (vid, how) {
    if (!setVendorDelivery(vid, how)) return;
    renderRules();
    const box = how === 'charge' ? el('prDel_' + vid) : null;
    if (box && !box.value) box.focus();
  };
  window.prDeliveryCents = function (vid, v) {
    const c = cents(v);
    if (v !== '' && (c === null || c < 0)) { showToast('Type their delivery charge in dollars, like 75'); return; }
    setVendorDelivery(vid, 'charge', c);
  };
  // Blank takes the town off (null: see deliveries()).
  function setTown(town, v) {
    if (!owner()) return;
    const rates = Object.assign({}, rules.delivery.rates);
    rates[town] = String(v).trim() === '' ? null : cents(v);
    save({ delivery: Object.assign({}, rules.delivery, { rates }) });
  }
  let shownTowns = [];
  window.prTownAt = function (i, v) { if (shownTowns[i]) setTown(shownTowns[i], v); };
  window.prTownAdd = async function () {
    const a = await ydForm('', [
      { id: 'town', label: 'Town', placeholder: 'As the job’s city is written', required: true },
      { id: 'rate', label: 'Delivery rate per load ($)', type: 'number', required: true,
        check: v => num(v) === null ? 'That isn’t a number' : '' },
    ], { title: 'Add a delivery town', ok: 'Add it' });
    if (!a || !a.town.trim() || num(a.rate) === null) return;
    setTown(a.town.trim(), a.rate);
    renderRules();
  };
  window.prListAdd = function (key, id) {
    if (!owner() || !id) return;
    const p = Object.assign({}, rules.planting);
    p[key] = (p[key] || []).filter(x => x !== id).concat([id]);
    save({ planting: p });
  };
  window.prListRemove = function (key, id) {
    if (!owner()) return;
    const p = Object.assign({}, rules.planting);
    p[key] = (p[key] || []).filter(x => x !== id);
    save({ planting: p });
  };

  // ------------------------------------------------------------- start/stop

  window.YDPricing = {
    CATEGORIES, CATEGORY_NAME, PROFIT_TIERS, NOT_FOR_ESTIMATES, allKinds, kindName, kindFor,
    rules: () => rules, fuelPrices: () => fuelPrices, ready: () => ready,
    price, asAccepted, materialsList, qtyText, payments, roundUp, num, placeKey, isBulk, rentalCents,
    // Each work line's price, cost and profit (estimate.js, jobcosts.js).
    byLine: (est, r, workFor) => byLine(est, r, rules, workFor),
    // What bringing a job's order costs (estimate.js orderDelivery): the same sums.
    deliveries,
    // Delivered or picked up: one material's way by the rules (Supplies
    // shows it), and lines that are not an estimate's (the order list).
    wayOf: x => wayOf(x, rules), waysFor,
    // How a supplier charges to deliver, set from an order list's delivery
    // that has no price (app.js). setVendorDelivery: owner only.
    deliveryHow: vid => deliveryHow(vid, (rules.vendors || {})[vid]),
    setVendorDelivery,
    profitChoices: () => profitChoices(rules), defaultProfitCents: () => defaultProfitCents(rules),
    usualPlan: total => usualPlan(total, rules),
    profitOf: w => profitOf(w, rules),
    endItems: which => endItems(rules, which), qbProduct, loadQbProducts,
    // A snow bid's words and products (estimate.js).
    snowBid: () => snowBid(rules),
    // services.js, "Your other lists".
    customKinds: () => customKinds(), mergeKind: mergeKind,
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; byName = null; if (on) start(); else stop(); }
  });
  // The rules screen names suppliers and items; redraw it when they arrive.
  document.addEventListener('yd-supplies', () => {
    byName = null;
    const m = el('prModal');
    if (m && m.classList.contains('active') && !typingIn(m)) renderRules();
  });
})();
