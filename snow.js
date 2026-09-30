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
    if (c === null || c === undefined) return '—';
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // A blank tier inherits the next lower one, per the build spec: an account
  // priced only at 1-3 and 4-6 bills the 4-6 rate for anything deeper.
  function resolveTier(tiers, label) {
    const seen = new Set();
    let node = tiers[label];
    while (node && node.mode === 'inherit' && node.from && !seen.has(label)) {
      seen.add(label);
      label = node.from;
      node = tiers[label];
    }
    return node || { mode: 'unset' };
  }

  // What one visit bills. The single place this is worked out -- storm billing,
  // the route screen and the reports all call this, so they cannot disagree.
  function priceVisit(id, inches, minutesOnSite, crewSize) {
    const p = pricing[id];
    if (!p || !p.pricing) return null;
    const pr = p.pricing;

    let base = 0;
    if (pr.mode === 'tieredPlusPerInch' && inches > pr.perInch.aboveInches) {
      const first = resolveTier(pr.tiers, '1-3');
      base = (first.cents || 0) + pr.perInch.cents * (inches - pr.perInch.aboveInches);
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
    const labor = p.laborRateCents
      ? Math.round((minutesOnSite || 0) / 60 * p.laborRateCents * (crewSize || 1))
      : 0;

    return { plowCents: base - salt, saltCents: salt, laborCents: labor, totalCents: base + labor };
  }

  // ---------------------------------------------------------------- render

  function priceSummary(id) {
    const p = pricing[id];
    if (!p || !p.pricing) return '';
    const pr = p.pricing;
    const first = resolveTier(pr.tiers, '1-3');
    let s = cents(first.cents);
    if (pr.mode === 'tieredPlusPerInch') {
      s += ' + ' + cents(pr.perInch.cents) + '/in over ' + pr.perInch.aboveInches + '"';
    } else {
      const second = resolveTier(pr.tiers, '4-6');
      if (second.cents && second.cents !== first.cents) s += ' / ' + cents(second.cents);
    }
    s += p.laborRateCents ? ' + ' + cents(p.laborRateCents) + '/man-hr' : ' · no hourly';
    return s;
  }

  function mapsLink(a) {
    const q = encodeURIComponent(
      (a.lat && a.lng) ? (a.lat + ',' + a.lng) : (a.address + ', ' + (a.town || '') + ' WI'));
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

    const isOwner = !!(window.YDAuth && window.YDAuth.isOwner);

    wrap.innerHTML = ids.map(id => {
      const a = accounts[id];
      const held = Array.isArray(a.vacationHolds) && a.vacationHolds.length;
      return '<div class="snow-card' + (a.active === false ? ' inactive' : '') + '">' +
        '<div class="snow-card-head">' +
          '<span class="snow-name">' + esc(a.name) + '</span>' +
          (a.type === 'commercial' ? '<span class="snow-tag commercial">commercial</span>' : '') +
          (a.saltApplies ? '<span class="snow-tag salt">salt</span>' : '') +
          (a.minTriggerInches > 1 ? '<span class="snow-tag trigger">' + a.minTriggerInches + '"+ only</span>' : '') +
          (held ? '<span class="snow-tag hold">on hold</span>' : '') +
        '</div>' +
        '<a class="snow-addr" href="' + mapsLink(a) + '" target="_blank" rel="noopener">' +
          esc(a.address) + (a.town ? ', ' + esc(a.town) : '') +
          '<span class="snow-go">open in maps</span>' +
        '</a>' +
        (a.areaNotes ? '<div class="snow-notes">' + esc(a.areaNotes) + '</div>' : '') +
        (isOwner ? '<div class="snow-price">' + esc(priceSummary(id)) + '</div>' : '') +
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

    unsubAccounts = db.watch('snowAccounts', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete accounts[c.id];
        else accounts[c.id] = c.data;
      });
      loaded = true;
      render();
      loadPricing();          // only the owner will get anything back
    }, () => { loaded = true; render(); });
  }

  // Pricing lives in a subcollection per account, so it is fetched per account
  // rather than watched. Crew are refused by the rules and simply see no
  // prices -- which is the intended outcome, not an error.
  async function loadPricing() {
    if (!window.YDAuth || !window.YDAuth.isOwner) return;
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

  window.YDSnow = {
    accounts: () => accounts,
    pricing: () => pricing,
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

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode === 'cloud' && a.user) start();
  });
})();
