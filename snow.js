// Snow — accounts, and the groundwork the storm workflow sits on.
//
// Two collections, deliberately separate (see firestore.rules):
//
//   snowAccounts/{id}            name, address, lat/lng, trigger inches,
//                                service window, area notes  -> crew CAN read
//   snowAccounts/{id}/private/*  tier rates, labour rate, salt, phone, email
//                                                            -> owner only
//
// Firestore grants access per document and never per field, so the only way to
// let crew see the route without seeing the money is to keep them apart. The
// app mirrors that split rather than merging them and hoping the UI hides the
// right things.

(function () {
  'use strict';

  const PRICING_DOC = 'rates';          // snowAccounts/{id}/private/rates

  let accounts = {};                    // id -> public record
  let pricing = {};                     // id -> private record (owner only)
  let unsubAccounts = null;
  let loaded = false;

  // ---------------------------------------------------------------- money

  function cents(c) {
    if (typeof c !== 'number' || !isFinite(c)) return '—';
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // A blank tier inherits the next lower one, per the build spec: an account
  // priced only at 1-3 and 4-6 bills the 4-6 rate for anything deeper.
  //
  // An 'inherit' tier never carries a price of its own, even if the stored
  // record still has one. Saves are merged into the stored record, so clearing
  // the 1-3" price used to leave the old figure sitting beside 'inherit' --
  // and with nothing below 1-3 to inherit from, that stale figure was what got
  // billed while the form showed the field blank.
  function resolveTier(tiers, label) {
    const all = tiers || {};
    const seen = new Set();
    let node = all[label];
    while (node && node.mode === 'inherit' && node.from && !seen.has(label)) {
      seen.add(label);
      label = node.from;
      node = all[label];
    }
    if (!node || node.mode === 'inherit') return { mode: 'unset' };
    return node;
  }

  // The price typed against one tier, or null when it inherits -- what the
  // form shows, so it matches what resolveTier will bill.
  function ownCents(node) {
    return node && node.mode !== 'inherit' && node.cents != null ? node.cents : null;
  }

  // What one visit bills. The single place this is worked out -- storm billing,
  // the route screen and the reports all call this, so they cannot disagree.
  function priceVisit(id, inches, minutesOnSite, crewSize) {
    const p = pricing[id];
    if (!p || !p.pricing) return null;
    const pr = p.pricing;

    let base = 0;
    if (pr.mode === 'tieredPlusPerInch' && pr.perInch && inches > pr.perInch.aboveInches) {
      const first = resolveTier(pr.tiers, '1-3');
      // Rounded to whole cents: depths come in half inches, and $12.25 an inch
      // over half an inch is 612.5 cents -- a total no invoice line can show,
      // so the printed lines stopped adding up to the stored total.
      base = (first.cents || 0) +
             Math.round((pr.perInch.cents || 0) * (inches - pr.perInch.aboveInches));
    } else {
      const label = inches <= 3 ? '1-3' : inches <= 6 ? '4-6' : inches <= 9 ? '6+' : '9+';
      base = resolveTier(pr.tiers, label).cents || 0;
    }

    // Salt is carved OUT of the base, not added to it: for these accounts the
    // agreed rate already includes it. Showing it separately is what lets salt
    // revenue be seen at all.
    const salt = pr.salt && pr.salt.included ? (pr.salt.portionCents || 0) : 0;

    // Labour is per man-hour, so crew size multiplies it. Accounts with no
    // labour rate bill the flat tier however long the night takes.
    //
    // The hours are rounded to two decimals BEFORE being multiplied, because
    // that rounded figure is what gets printed on the customer's invoice. Work
    // it out the other way and the line does not add up on its face: 95 minutes
    // with two crew shows as 3.17 hours at $25, which a customer reads as
    // $79.25, while the exact arithmetic gives $79.17. The eight pence does not
    // matter; an invoice whose own multiplication is wrong does.
    //
    // The multiplying is done in whole hundredths of an hour. 0.57 x 2550 in
    // floating point is 1453.4999..., which rounded to $14.53 where the
    // invoice's own 0.57 hours at $25.50 reads $14.54; 57 x 2550 / 100 is
    // exactly 1453.5 and rounds the way the printed line does.
    const hundredths = p.laborRateCents
      ? Math.round((minutesOnSite || 0) / 60 * (crewSize || 1) * 100)
      : 0;
    const manHours = hundredths / 100;
    const labor = p.laborRateCents ? Math.round(hundredths * p.laborRateCents / 100) : 0;

    return { plowCents: base - salt, saltCents: salt, laborCents: labor,
             manHours: manHours, totalCents: base + labor };
  }

  // ---------------------------------------------------------------- render

  function priceSummary(id) {
    const p = pricing[id];
    if (!p || !p.pricing) return '';
    const pr = p.pricing;
    const first = resolveTier(pr.tiers, '1-3');
    let s = cents(first.cents);
    // An imported record can say per-inch with no per-inch amount; one such
    // record used to stop the whole account list drawing.
    if (pr.mode === 'tieredPlusPerInch' && pr.perInch) {
      s += ' + ' + cents(pr.perInch.cents) + '/in over ' + pr.perInch.aboveInches + '"';
    } else {
      const second = resolveTier(pr.tiers, '4-6');
      if (second.cents && second.cents !== first.cents) s += ' / ' + cents(second.cents);
    }
    s += p.laborRateCents ? ' + ' + cents(p.laborRateCents) + '/man-hr' : ' · no hourly';
    return s;
  }

  // What one clear brings in across every active account, for a 1-3" storm
  // and a 4-6" one (Jonah, 7 Oct 2026: "total income per clear for 1-3 &
  // total income for a 4-6"). Worked out by priceVisit, as storm billing is,
  // so the two cannot disagree. An account counts only if a storm that deep
  // takes it (its trigger depth). Per-inch accounts bill 4" and 6" differently,
  // so 4-6 can be a range; hourly labour is on top of these and only noted.
  function clearTotals() {
    const ids = Object.keys(accounts).filter(id => accounts[id].active !== false);
    const at = inches => {
      let sum = 0, n = 0;
      ids.forEach(id => {
        if ((accounts[id].minTriggerInches || 1) > inches) return;
        const p = priceVisit(id, inches, 0, 1);
        if (p && p.totalCents > 0) { sum += p.totalCents; n++; }
      });
      return { sum: sum, n: n };
    };
    return {
      low: at(3), four: at(4), six: at(6),
      hourly: ids.filter(id => pricing[id] && pricing[id].laborRateCents).length,
      unpriced: ids.filter(id => !(pricing[id] && pricing[id].pricing)).length,
    };
  }
  function totalsHtml() {
    const t = clearTotals();
    if (!t.low.n && !t.six.n) return '';
    const card = (label, value, sub) => '<div class="summary-card accent-top"><div class="summary-label">' + label + '</div>' +
      '<div class="summary-value">' + value + '</div><div class="snow-tot-sub">' + sub + '</div></div>';
    const deep = t.four.sum === t.six.sum ? cents(t.six.sum) : cents(Math.min(t.four.sum, t.six.sum)) + '–' + cents(Math.max(t.four.sum, t.six.sum));
    const notes = [];
    if (t.hourly) notes.push('+ hourly labour on ' + t.hourly + ' account' + (t.hourly === 1 ? '' : 's') + ' (billed by time on site)');
    if (t.unpriced) notes.push(t.unpriced + ' active account' + (t.unpriced === 1 ? ' has' : 's have') + ' no price yet');
    return '<div class="dash-totals snow-totals">' +
        card('Every 1–3" clear', cents(t.low.sum), t.low.n + ' account' + (t.low.n === 1 ? '' : 's')) +
        card('Every 4–6" clear', deep, t.six.n + ' account' + (t.six.n === 1 ? '' : 's') + (t.four.sum !== t.six.sum ? ' · 4" to 6"' : '')) +
      '</div>' +
      (notes.length ? '<div class="hint snow-tot-note">' + esc(notes.join(' · ')) + '</div>' : '');
  }

  function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, ''); }

  // Customer prices and contact details: Snow, or Billing -- a storm cannot
  // be billed without the prices. The rules allow exactly the same.
  const seesSnowPrices = () => ydCan('snow', 'see') || ydCan('billing', 'see');

  function mapsLink(a) {
    const q = encodeURIComponent(
      (a.lat && a.lng) ? (a.lat + ',' + a.lng) : a.street ? a.address : (a.address + ', ' + (a.town || '') + ' WI'));
    return 'https://maps.google.com/?q=' + q;
  }

  function render() {
    const wrap = document.getElementById('snowAccountsWrap');
    if (!wrap) return;
    const ids = Object.keys(accounts).sort((x, y) =>
      (accounts[x].name || '').localeCompare(accounts[y].name || ''));

    const badge = document.getElementById('snowCountBadge');
    if (badge) badge.textContent = ids.length ? ids.length + ' accounts' : '';

    if (!ids.length) {
      wrap.innerHTML = loaded
        ? '<p class="empty-msg">No snow accounts yet.</p>'
        : '<p class="empty-msg">Loading…</p>';
      return;
    }

    // Prices are for whoever may see Snow (or bill it); editing is Snow: change.
    const seesPrices = seesSnowPrices();
    const edits = ydCan('snow', 'change');

    wrap.innerHTML = (seesPrices ? totalsHtml() : '') + ids.map(id => {
      const a = accounts[id];
      const held = Array.isArray(a.vacationHolds) && a.vacationHolds.length;
      return '<div class="snow-card' + (a.active === false ? ' inactive' : '') + '">' +
        '<div class="snow-card-head">' +
          '<span class="snow-name">' + esc(a.name) + '</span>' +
          (a.type === 'commercial' ? '<span class="snow-tag commercial">commercial</span>' : '') +
          (a.saltApplies ? '<span class="snow-tag salt">salt</span>' : '') +
          (a.minTriggerInches > 1 ? '<span class="snow-tag trigger">' + a.minTriggerInches + '"+ only</span>' : '') +
          (a.lat == null ? '<span class="snow-tag nolocation" title="Not found on the map yet, so it goes at the end of the route">no location</span>' : '') +
          (held ? '<span class="snow-tag hold">on hold</span>' : '') +
          // There was no way to change an account once it was added.
          (edits ? '<button class="btn btn-sm snow-edit" onclick="editSnowAccount(\'' + safeId(id) + '\')">Edit</button>' : '') +
        '</div>' +
        '<a class="snow-addr" href="' + mapsLink(a) + '" target="_blank" rel="noopener">' +
          // An address typed in its parts already ends with its town.
          esc(a.address) + (a.town && !a.street ? ', ' + esc(a.town) : '') +
          '<span class="snow-go">open in maps</span>' +
        '</a>' +
        (a.areaNotes ? '<div class="snow-notes">' + esc(a.areaNotes) + '</div>' : '') +
        (seesPrices ? '<div class="snow-price">' + esc(priceSummary(id)) + '</div>' : '') +
        (a.driveSqFt ? '<div class="snow-sq">' + a.driveSqFt + ' sq ft drive' +
          (a.walkSqFt ? ' · ' + a.walkSqFt + ' sq ft walks' : '') + '</div>' : '') +
      '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------- loading

  async function start() {
    if (unsubAccounts) return;
    const db = window.YDDb;
    if (!db || !db.watch) return;

    unsubAccounts = db.watch('snowAccounts', (changes, meta) => {
      changes.forEach(c => {
        if (c.type === 'removed') delete accounts[c.id];
        else accounts[c.id] = c.data;
      });
      loaded = true;
      render();
      loadPricing();          // only the owner will get anything back
      // Only once the server's copy is in: a stale cached one might list as
      // unlocated an account another device has already found.
      if (meta && meta.fromCache === false) setTimeout(locateMissing, 1500);
    }, () => { loaded = true; render(); });
  }

  // Pricing lives in a subcollection per account, so it is fetched per account
  // rather than watched. Crew are refused by the rules and simply see no
  // prices -- which is the intended outcome, not an error.
  async function loadPricing() {
    if (!seesSnowPrices()) return;
    const ids = Object.keys(accounts).filter(id => !pricing[id]);
    if (!ids.length) return;
    for (const id of ids) {
      try {
        const d = await window.YDDb.get('snowAccounts/' + id + '/private', PRICING_DOC);
        if (d) pricing[id] = d;
      } catch (e) { /* not permitted, or offline -- leave prices blank */ }
    }
    render();
  }

  // ---------------------------------------------------------------- exports

  // Fetch these accounts' pricing again, fresh. Closing a storm calls this so
  // the bill is worked out from the prices as they stand now -- not from
  // whatever happened to be loaded when the app opened, which might be
  // nothing yet, or a price since changed on another device. A read (unlike a
  // write) settles from the local cache when there is no signal.
  async function refreshPricing(ids) {
    if (!seesSnowPrices() || !window.YDDb) return;
    await Promise.all(ids.map(async id => {
      try {
        const d = await window.YDDb.get('snowAccounts/' + id + '/private', PRICING_DOC);
        if (d) pricing[id] = d;
      } catch (e) { /* offline with nothing cached -- reported by the caller */ }
    }));
  }

  window.YDSnow = {
    accounts: () => accounts,
    pricing: () => pricing,
    refreshPricing,
    priceVisit,
    resolveTier,
    render,

    // Used once, by the import. Writes the public and private halves together
    // so an account cannot exist with an address but no pricing.
    async importAccounts(pub, priv) {
      const entries = [];
      Object.keys(pub).forEach(id => {
        entries.push(['snowAccounts', id, pub[id]]);
        if (priv[id]) entries.push(['snowAccounts/' + id + '/private', PRICING_DOC, priv[id]]);
      });
      await window.YDDb.putMany(entries);
      return Object.keys(pub).length;
    },
  };

  // ---------------------------------------------------------------- adding

  // The address is the only thing typed that the app can turn into more: the
  // town, the map position, which weather area it falls in, and its place in
  // the driving order all come from geocoding it. So it is looked up on save
  // rather than asking anyone to type coordinates.
  //
  // OpenStreetMap's geocoder is used because it can be called from the browser.
  // The Census one is more precise for US addresses but refuses browser calls;
  // checked against it on four real addresses, this agreed to within 8 metres
  // on three and 46 on the fourth -- far inside what routing and weather need.
  // Street types get abbreviated on a spreadsheet and the geocoder does not
  // always understand them. "123 Oak Tr" can find nothing where "…Trail"
  // finds it immediately, and Jonah's own sheet writes street types short,
  // so without this an address typed the way he writes it saves with no
  // location and then quietly never appears on a route.
  const STREET_TYPES = {
    tr: 'Trail', trl: 'Trail', trail: 'Trail', cir: 'Circle', crcl: 'Circle', circle: 'Circle',
    rd: 'Road', road: 'Road', dr: 'Drive', drive: 'Drive', st: 'Street', street: 'Street',
    ave: 'Avenue', av: 'Avenue', avenue: 'Avenue', ln: 'Lane', lane: 'Lane',
    ct: 'Court', court: 'Court', blvd: 'Boulevard', boulevard: 'Boulevard',
    pl: 'Place', place: 'Place', ter: 'Terrace', terr: 'Terrace', terrace: 'Terrace',
    pkwy: 'Parkway', pky: 'Parkway', parkway: 'Parkway', hwy: 'Highway', highway: 'Highway',
    sq: 'Square', cres: 'Crescent', pt: 'Point', hts: 'Heights', way: 'Way', pass: 'Pass',
    run: 'Run', path: 'Path', xing: 'Crossing', cv: 'Cove', loop: 'Loop',
  };
  const streetType = w => STREET_TYPES[String(w || '').replace(/\.$/, '').toLowerCase()] || null;

  // Towns around Madison and Monroe, longest first so "Sun Prairie" is
  // matched whole. Used to spot a town typed straight after the street with
  // no comma.
  const AREA_TOWNS = ['Shorewood Hills', 'Cottage Grove', 'Maple Bluff', 'Cross Plains', 'Mount Horeb',
    'Mt Horeb', 'New Glarus', 'Black Earth', 'Sun Prairie', 'Belleville', 'Evansville', 'Mazomanie',
    'Monticello', 'Middleton', 'Fitchburg', 'Stoughton', 'McFarland', 'Deerfield', 'Waunakee',
    'Brodhead', 'Brooklyn', 'DeForest', 'Madison', 'Marshall', 'Windsor', 'Monona', 'Oregon',
    'Verona', 'Albany', 'Monroe', 'Paoli', 'Juda'];

  // Splits a typed address into street, town and ZIP. People type them every
  // which way. A real one typed as "123 Oak Tr Madison, WI  53713" (no comma
  // between the street and the town) was saved with no location, because all
  // of "Oak Tr Madison" was searched for as the street name.
  function splitAddress(input) {
    let s = String(input || '').replace(/\s+/g, ' ').trim();
    let zip = null;
    const z = s.match(/\b(\d{5})(?:-\d{4})?\s*$/);
    if (z) { zip = z[1]; s = s.slice(0, z.index); }
    s = s.replace(/[,\s]*\b(WI|Wis|Wisc|Wisconsin)\.?[,\s]*$/i, '').replace(/[,\s]+$/, '');
    // An apartment or unit number only confuses the map search.
    s = s.replace(/[,\s]+(apt|unit|ste|suite|#)\.?\s*[\w-]+/i, '');

    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    let street = parts[0] || '';
    let town = parts.length > 1 ? parts[parts.length - 1] : null;
    if (!town) {
      // A known town on the end -- as long as what is left still looks like
      // a street ("N1234 County Rd X Monroe" yes; "456 W Monroe" is a street).
      const low = street.toLowerCase();
      const known = AREA_TOWNS.find(t => low.endsWith(' ' + t.toLowerCase()));
      const left = known ? street.slice(0, street.length - known.length).trim() : '';
      const leftWords = left.split(' ');
      if (known && (leftWords.length >= 3 || (leftWords.length === 2 && streetType(leftWords[1])))) {
        town = known;
        street = left;
      }
    }
    if (!town) {
      // Otherwise the town is whatever follows the last street type: in
      // "123 Main St Lodi", everything after "St". Never when what follows
      // holds a number or another street type ("123 Ridge Rd"), or starts
      // with a county highway letter ("N1234 County Rd PB").
      const words = street.split(' ');
      for (let i = words.length - 2; i >= 1; i--) {
        const rest = words.slice(i + 1);
        if (streetType(words[i]) && !/^[A-Z]{1,2}$/.test(rest[0]) &&
            !rest.some(w => /\d/.test(w) || streetType(w))) {
          street = words.slice(0, i + 1).join(' ');
          town = rest.join(' ');
          break;
        }
      }
    }
    return { street: street, town: town, zip: zip };
  }

  // Only a TRAILING abbreviation is expanded: "45 St Marys Dr" must keep
  // its "St" as Saint rather than becoming "Street Annes Drive".
  function expandStreetType(s) {
    const words = s.trim().split(/\s+/);
    if (words.length < 2) return null;
    const last = words[words.length - 1];
    const full = streetType(last);
    if (!full || full.toLowerCase() === last.toLowerCase()) return null;
    return words.slice(0, -1).join(' ') + ' ' + full;
  }

  const WORK_TOWNS = ['Madison', 'Middleton', 'Verona', 'Fitchburg', 'Waunakee', 'Monroe'];

  // Returns { geo, reached }: geo is null when nothing matched, and reached
  // says whether the map service answered at all -- "no signal" and "no such
  // address" need different words on the form.
  async function locate(input, townHint) {
    const a = splitAddress(input);
    const hint = townHint || a.town;
    const expanded = expandStreetType(a.street);
    // Spelled out first: the geocoder knows "Trail" far better than "Tr".
    const spellings = expanded ? [expanded, a.street] : [a.street];

    // The ZIP first -- it is on every mailing address and, unlike the town,
    // does not trip over a "Madison" mailing address that sits in Fitchburg.
    // Then any town given. Only with no ZIP is it worth guessing among the
    // towns YD actually works, and then only the spelled-out street: each
    // try costs a second, and a miss used to take twenty.
    const places = [];
    if (a.zip) places.push({ postalcode: a.zip });
    if (hint) places.push({ city: hint });
    if (!a.zip) {
      WORK_TOWNS.filter(t => !hint || t.toLowerCase() !== hint.toLowerCase())
        .forEach(t => places.push({ city: t, guess: true }));
    }

    let reached = false;
    let first = true;
    for (const p of places) {
      const where = Object.assign({}, p);
      delete where.guess;
      for (const spelling of (p.guess ? spellings.slice(0, 1) : spellings)) {
        if (!first) await new Promise(r => setTimeout(r, 1100));   // their policy: 1 request/sec
        first = false;
        const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams(Object.assign({
          street: spelling, state: 'WI', country: 'USA', format: 'json', limit: '1', addressdetails: '1',
        }, where));
        try {
          const j = await fetch(url).then(r => r.json());
          reached = true;
          if (j && j.length) {
            const ad = j[0].address || {};
            return { reached: true, geo: {
              lat: +j[0].lat, lng: +j[0].lon,
              town: ad.city || ad.town || ad.village || ad.hamlet || where.city || hint || null,
              matched: j[0].display_name,
            } };
          }
        } catch (e) { /* try the next spelling or town */ }
      }
    }
    // Last, the whole thing as one line of text, the way a person would
    // type it into a map -- it copes with a few things the itemised search
    // does not, such as a town the map files under another name.
    if (reached) {
      await new Promise(r => setTimeout(r, 1100));
      const line = [spellings[0], hint, 'WI ' + (a.zip || '')].filter(Boolean).join(', ').trim();
      try {
        const j = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
          q: line, countrycodes: 'us', format: 'json', limit: '1', addressdetails: '1',
        })).then(r => r.json());
        const ad = (j && j[0] && j[0].address) || {};
        if (j && j.length && /wisconsin/i.test(ad.state || '')) {
          return { reached: true, geo: {
            lat: +j[0].lat, lng: +j[0].lon,
            town: ad.city || ad.town || ad.village || ad.hamlet || hint || null,
            matched: j[0].display_name,
          } };
        }
      } catch (e) { /* nothing more to try */ }
    }
    return { reached: reached, geo: null };
  }

  // A contact turned into a snow account (prospects.js): the form filled from
  // a name and a one-line address, split into the boxes.
  window.fillSnowFormFrom = function (p) {
    const set = (f, v) => { const n = document.getElementById(f); if (n && v) n.value = v; };
    const nm = (p.firstName || p.lastName || p.business) ? { first: p.firstName, last: p.lastName, business: p.business } : splitName(p.name);
    set('sfFirst', nm.first); set('sfLast', nm.last); set('sfBusiness', nm.business);
    const ad = partsOf({ address: p.address || '' });
    set('sfStreet', ad.street); set('sfCity', ad.city); set('sfZip', ad.zip);
    set('sfPhone', p.phone); set('sfEmail', p.email); set('sfNotes', p.note);
  };

  // An address typed in its parts. The server looks it up (geo.py): the US
  // Census geocoder there finds Wisconsin's rural fire numbers -- "W5883
  // County Rd X" -- that OpenStreetMap has only the road for, and it cannot
  // be asked from a browser. With no answer from the server (no signal, or
  // signed out of it) the browser's own OpenStreetMap search is the fallback.
  async function locateParts(p) {
    const line = oneLine(p);
    if (window.YDClaude && window.YDClaude.available && window.YDClaude.available() && navigator.onLine) {
      try {
        const r = await window.YDClaude.post('/geo/find', { street: p.street, city: p.city, state: p.state, zip: p.zip });
        if (r && r.found && r.geo) {
          return { reached: true, geo: { lat: r.geo.lat, lng: r.geo.lng, town: p.city || r.geo.town || null,
                                         matched: r.geo.matched || line } };
        }
        if (r && r.found === false) return { reached: true, geo: null };
      } catch (e) { /* fall back to the browser's own search */ }
    }
    return locate(line, p.city || null);
  }

  // "123 Oak St, Madison, WI 53711" from its parts.
  function oneLine(p) {
    const tail = [p.state, p.zip].filter(Boolean).join(' ');
    return [p.street, p.city, tail].map(s => String(s || '').trim()).filter(Boolean).join(', ');
  }

  // Accounts saved before the address and name had boxes of their own are
  // split when opened, so editing one fills the boxes rather than starting
  // them blank.
  function partsOf(a) {
    if (!a) return { street: '', city: '', state: 'WI', zip: '' };
    if (a.street) return { street: a.street, city: a.city || a.town || '', state: a.state || 'WI', zip: a.zip || '' };
    const s = splitAddress(a.address || '');
    return { street: s.street || '', city: s.town || a.town || '', state: 'WI', zip: s.zip || '' };
  }
  // A one-line address in its boxes, for whatever else is filled from one
  // (a contact started as a bid, prospects.js).
  window.addressParts = line => partsOf({ address: line || '' });
  function namesOf(a) {
    if (!a) return { first: '', last: '', business: '' };
    if (a.firstName || a.lastName || a.business) return { first: a.firstName || '', last: a.lastName || '', business: a.business || '' };
    // A commercial account is a business; otherwise app.js splitName decides
    // (two or three words read as a person's name).
    if (a.type === 'commercial') return { first: '', last: '', business: String(a.name || '') };
    return splitName(a.name);
  }

  const val = id => (document.getElementById(id) || {}).value || '';
  const checked = id => !!(document.getElementById(id) || {}).checked;
  const money = id => {
    const n = parseFloat(String(val(id)).replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : Math.round(n * 100);
  };

  let editingId = null;
  // The address the form last failed to find. Pressing Save again with the
  // same address keeps it without a location; changing it looks again.
  let unfound = null;
  // Goes up every time the form opens or closes, so a save still waiting on
  // the address lookup can tell it is no longer the form on screen.
  let formSeq = 0;
  // An address as words, punctuation and the state aside, for "has it moved?"
  const placeKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(w => w && w !== 'wi' && w !== 'wisconsin').join(' ');
  const GEO_HINT = 'The town and map location are worked out for you when you save.';

  // Shared: an address typed as one line, looked up the way accounts are --
  // the server's Census lookup first (rural fire numbers), then the browser's
  // own OpenStreetMap search. The route's starting yard uses it (storm.js).
  window.YDSnowGeocode = async function (line, townHint) {
    const p = partsOf({ address: line || '' });
    if (!p.city && townHint) p.city = townHint;
    return (await locateParts(p)).geo;
  };

  window.openSnowForm = function (id) {
    formSeq++;
    editingId = id || null;
    unfound = null;
    const a = id ? accounts[id] : null;
    const p = id ? pricing[id] : null;
    document.getElementById('snowFormTitle').textContent = a ? 'Edit Snow Account' : 'Add Snow Account';
    const hint = document.getElementById('sfGeoHint');
    hint.classList.remove('bad');
    hint.textContent = a && a.lat == null
      ? 'This address has not been found on the map yet. Check the street name and house number, then save.'
      : (a && a.geocodedAs ? 'On the map as: ' + a.geocodedAs : GEO_HINT);
    const btn = document.getElementById('sfSaveBtn');
    btn.disabled = false;
    btn.textContent = 'Save account';

    const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = v == null ? '' : v; };
    const tick = (el, v) => { const n = document.getElementById(el); if (n) n.checked = !!v; };
    const dollars = c => (c == null ? '' : (c / 100).toString());

    const nm = namesOf(a), ad = partsOf(a);
    set('sfFirst', nm.first); set('sfLast', nm.last); set('sfBusiness', nm.business);
    set('sfStreet', ad.street); set('sfCity', ad.city); set('sfState', ad.state || 'WI'); set('sfZip', ad.zip);
    set('sfType', (a && a.type) || 'residential');
    set('sfPhone', p && p.phone); set('sfEmail', p && p.email);
    set('sfNotes', a && a.areaNotes);
    set('sfTrigger', String((a && a.minTriggerInches) || 1));
    set('sfWindow', (a && a.serviceWindow) || 'standard');
    set('sfDrive', a && a.driveSqFt); set('sfWalk', a && a.walkSqFt);

    const pr = p && p.pricing;
    const t = pr && pr.tiers;
    set('sfT13', t && dollars(ownCents(t['1-3'])));
    set('sfT46', t && dollars(ownCents(t['4-6'])));
    set('sfT6',  t && dollars(ownCents(t['6+'])));
    set('sfT9',  t && dollars(ownCents(t['9+'])));
    tick('sfPerInchOn', pr && pr.mode === 'tieredPlusPerInch');
    set('sfPerInchAmt', pr && pr.perInch && dollars(pr.perInch.cents));
    set('sfPerInchAbove', pr && pr.perInch && pr.perInch.aboveInches);
    set('sfLabor', p && dollars(p.laborRateCents));
    tick('sfNoLabor', !!(p && p.laborRateCents === null));
    tick('sfSaltOn', !!(pr && pr.salt && pr.salt.included));
    set('sfSaltAmt', pr && pr.salt && dollars(pr.salt.portionCents));

    snowFormToggle();
    document.getElementById('snowFormModal').classList.add('active');
  };

  // The prices are fetched apart from the account, and saving writes whatever
  // the form's price boxes hold. Opened before they arrived, a save would
  // blank the customer's prices -- so they are fetched first, and with no
  // copy to be had (no signal, nothing cached) the form is not opened.
  window.editSnowAccount = async function (id) {
    if (!accounts[id]) return;
    if (!pricing[id]) {
      try {
        const d = await window.YDDb.get('snowAccounts/' + id + '/private', PRICING_DOC);
        if (d) pricing[id] = d;      // none at all: the form starts blank, nothing to lose
      } catch (e) {
        showToast('This account\'s prices have not loaded yet — try again with signal');
        return;
      }
    }
    openSnowForm(id);
  };

  window.closeSnowForm = function () {
    formSeq++;
    document.getElementById('snowFormModal').classList.remove('active');
    editingId = null;
  };

  window.snowFormToggle = function () {
    document.getElementById('sfPerInchRow').hidden = !checked('sfPerInchOn');
    document.getElementById('sfSaltRow').hidden = !checked('sfSaltOn');
    const noLabor = checked('sfNoLabor');
    document.getElementById('sfLabor').disabled = noLabor;
    document.getElementById('sfNoLaborHint').hidden = !noLabor;
  };

  window.saveSnowForm = async function () {
    const btn = document.getElementById('sfSaveBtn');
    const firstName = val('sfFirst').trim(), lastName = val('sfLast').trim(), business = val('sfBusiness').trim();
    // The name shown everywhere: the business, or the person.
    const name = business || [firstName, lastName].filter(Boolean).join(' ');
    const parts = { street: val('sfStreet').trim(), city: val('sfCity').trim(),
                    state: (val('sfState').trim() || 'WI').toUpperCase(), zip: val('sfZip').trim() };
    const address = oneLine(parts);
    if (!name)    { showToast('Give the customer a first and last name, or a business name'); return; }
    if (!parts.street) { showToast('A street address is needed — the route and weather depend on it'); return; }
    if (!parts.city && !parts.zip) { showToast('Add the city or the ZIP so the address can be found'); return; }

    // Everything else on the form is read now, before the address lookup:
    // the lookup can take ten seconds, and the form can be closed -- or
    // opened on another account -- in the meantime (see formSeq below).
    const form = {
      type: val('sfType'), trigger: parseInt(val('sfTrigger'), 10) || 1, window: val('sfWindow'),
      notes: val('sfNotes').trim(), drive: parseInt(val('sfDrive'), 10) || null, walk: parseInt(val('sfWalk'), 10) || null,
      saltOn: checked('sfSaltOn'), phone: val('sfPhone').trim(), email: val('sfEmail').trim().toLowerCase(),
      labor: checked('sfNoLabor') ? null : money('sfLabor'), perInchOn: checked('sfPerInchOn'),
      t13: money('sfT13'), t46: money('sfT46'), t6: money('sfT6'), t9: money('sfT9'),
      perInchAmt: money('sfPerInchAmt'), perInchAbove: parseInt(val('sfPerInchAbove'), 10) || 3, saltAmt: money('sfSaltAmt'),
    };
    const mySeq = formSeq;

    btn.disabled = true;
    btn.textContent = 'Finding the address…';

    // Two accounts named the same thing produced the same id, and the second
    // silently replaced the first. Jonah's own sheet has one customer with two
    // properties at different addresses, so this is not hypothetical -- adding the second
    // would have erased the first with no warning at all.
    let id = editingId;
    if (!id) {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'account';
      // Before the accounts have loaded (an offline cold start) there is no
      // telling whether the name is taken, and a merge onto a same-named
      // customer would overwrite their address and prices: a unique tail then.
      id = loaded ? base : base + '-' + Date.now().toString(36);
      let n = 2;
      while (accounts[id]) id = base + '-' + (n++);
      if (id !== base) console.info('[snow] "' + name + '" already exists; saving as ' + id);
    }
    const existing = editingId ? accounts[editingId] : null;

    // Only look the address up when it is new or has changed -- no point
    // hitting the geocoder to re-confirm something already known. Compared
    // word by word: an account saved before the address had boxes reads
    // "123 Oak Tr Madison, WI 53713" and comes back from the boxes as
    // "123 Oak Tr, Madison, WI 53713" -- the same place, and treating it as a
    // move threw away its map position whenever the lookup then failed.
    const moved = !existing || placeKey(existing.address) !== placeKey(address);
    let geo = null;
    if ((moved || existing.lat == null) && unfound !== address) {
      const found = await locateParts(parts);
      if (formSeq !== mySeq) {
        showToast('Not saved — the form was closed while the address was being looked up');
        return;
      }
      geo = found.geo;
      if (!geo) {
        // The form used to close at once and say only "saved", so the warning
        // written here was never seen -- the first anyone knew was a "no
        // location" tag on the card. Stay open and say what happened.
        unfound = address;
        const hint = document.getElementById('sfGeoHint');
        hint.classList.add('bad');
        hint.textContent = found.reached
          ? 'That address could not be found on the map. Check the street name and house number. ' +
            'Press Save again to keep it anyway — it will not appear on a route until it is found.'
          : 'No signal, so the address could not be looked up. Press Save again to keep it for now — ' +
            'it is looked up again the next time the app is open with signal.';
        btn.disabled = false;
        btn.textContent = 'Save without a location';
        return;
      }
    }

    btn.textContent = 'Saving…';

    // A changed address that could not be found must not keep the OLD
    // address's map position: the route would send the crew to the old house.
    const kept = k => (!moved && existing[k] != null ? existing[k] : null);
    const pub = {
      name: name,
      firstName: firstName, lastName: lastName, business: business,
      address: address,
      street: parts.street, city: parts.city, state: parts.state, zip: parts.zip,
      town: geo ? geo.town : (parts.city || kept('town')),
      lat: geo ? geo.lat : kept('lat'),
      lng: geo ? geo.lng : kept('lng'),
      geocodedAs: geo ? geo.matched : kept('geocodedAs'),
      type: form.type,
      active: existing ? existing.active !== false : true,
      season: (existing && existing.season) || seasonNow(),
      minTriggerInches: form.trigger,
      serviceWindow: form.window,
      areaNotes: form.notes,
      vacationHolds: (existing && existing.vacationHolds) || [],
      driveSqFt: form.drive,
      walkSqFt: form.walk,
      saltApplies: form.saltOn,
    };

    // cents is written as null on an inheriting tier, not left out: the save
    // is merged into the stored record, so leaving it out kept the old price.
    const tierOrInherit = (c, below) =>
      c === null ? { mode: 'inherit', from: below, cents: null } : { mode: 'flat', cents: c };
    const priv = {
      phone: form.phone,
      email: form.email,
      laborRateCents: form.labor,
      pricing: {
        mode: form.perInchOn ? 'tieredPlusPerInch' : 'tiered',
        tiers: {
          '1-3': tierOrInherit(form.t13, null),
          '4-6': tierOrInherit(form.t46, '1-3'),
          '6+':  tierOrInherit(form.t6, '4-6'),
          '9+':  tierOrInherit(form.t9, '6+'),
        },
        perInch: form.perInchOn ? { cents: form.perInchAmt || 0, aboveInches: form.perInchAbove } : null,
        salt: {
          included: form.saltOn,
          portionCents: form.saltOn ? (form.saltAmt || 0) : 0,
          perBagCents: null,
        },
      },
    };

    // Both halves together: an account with an address but no pricing would
    // quietly bill nothing. Not awaited -- the write lands locally at once and
    // reaches the server when there is signal, so saving never hangs.
    Promise.resolve(window.YDDb.putMany([
      ['snowAccounts', id, pub],
      ['snowAccounts/' + id + '/private', PRICING_DOC, priv],
    ])).catch(e => console.warn('[snow] account not yet on the server:', e.code || e.message));
    pricing[id] = priv;
    accounts[id] = pub;
    render();
    closeSnowForm();
    showToast(geo ? (name + ' saved — on the map in ' + (geo.town || 'Wisconsin'))
      : (pub.lat == null ? name + ' saved without a location' : name + ' saved'));
    btn.disabled = false;
    btn.textContent = 'Save account';
  };

  // A snow season runs through the winter, so it is named for both years:
  // from July on it is this year's, before July last year's.
  function seasonNow() {
    const d = new Date();
    const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
    return y + '-' + String(y + 1).slice(2);
  }

  // An account saved with no location -- no signal at the time, or an address
  // the map could not read -- is looked up again when the owner has the app
  // open, so it finds its way onto the route without anyone remembering to.
  // Each address is tried once per visit; no signal leaves it for next time.
  const triedAddress = {};
  let locating = false;
  async function locateMissing() {
    if (locating || !ydCan('snow', 'change') || !window.YDDb) return;
    const todo = Object.keys(accounts).filter(id =>
      accounts[id].lat == null && accounts[id].address && triedAddress[id] !== accounts[id].address);
    if (!todo.length) return;
    locating = true;
    try {
      for (const id of todo) {
        const address = accounts[id].address;
        triedAddress[id] = address;
        // Through the server's Census lookup, which finds what OpenStreetMap
        // could not when these were first saved.
        const found = await locateParts(partsOf(accounts[id]));
        if (!found.reached) { delete triedAddress[id]; break; }
        // Edited while it was being looked up: the new address is its own job.
        if (found.geo && accounts[id] && accounts[id].address === address && accounts[id].lat == null) {
          const fix = { town: found.geo.town, lat: found.geo.lat, lng: found.geo.lng, geocodedAs: found.geo.matched };
          Object.assign(accounts[id], fix);
          Promise.resolve(window.YDDb.put('snowAccounts', id, fix))
            .catch(e => console.warn('[snow] location not yet on the server:', e.code || e.message));
          render();
        }
        await new Promise(r => setTimeout(r, 1100));
      }
    } finally {
      locating = false;
    }
  }
  window.addEventListener('online', () => setTimeout(locateMissing, 2000));

  // Signing out does not reload the page. Without dropping the watch and the
  // data, the next person to sign in on the same phone would never get a
  // fresh listener -- and would still have the owner's pricing in memory.
  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const key = a.mode === 'cloud' && a.user ? (a.key || a.user.uid + ':' + a.role) : null;
    if (key !== authKey) {
      if (unsubAccounts) { try { unsubAccounts(); } catch (err) {} unsubAccounts = null; }
      accounts = {}; pricing = {}; loaded = false;
      authKey = key;
    }
    if (key) start(); else render();
    const add = document.getElementById('snowAddBtn');
    if (add) add.hidden = !ydCan('snow', 'change');
  });
})();
