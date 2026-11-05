// One part of a long screen at a time.
//
// Supplies ran to 25 phone screens with the supply list itself starting on the
// 21st, the Clock to 7, Snow to 5 and All Jobs was as long on a laptop (review
// of 4 Nov 2026; Jonah: "Yes, do that next"). Each now has tap buttons at the
// top, wrapping on a phone and never a row that scrolls sideways, and shows one
// part. Money and the Job tab do the same with their own files (money.js,
// jobview.js) because they decide more: here it is only which part shows.
//
// Nothing here knows what the parts hold. Each part is a place on its panel
// (index.html data-part), drawn by the file it always belonged to, which goes
// on drawing it exactly as before, hidden or not. A button says what is waiting
// in its part by reading that part's own badge, so the words can't disagree
// with the screen.
//
// A part shows as a button only while something in it is showing, so whoever
// has one part left (the crew, on Supplies and Snow) gets no buttons and the
// screen as it always was. The Clock's buttons are the owner's: anyone else's
// clock stays at the top of their screen with nothing above it. Snow has none
// while a storm is open.
//
// Supplies and All Jobs reopen on the part last used on this device. The Clock
// and Snow always open on the clock and the route: those are what every link
// to them wants, and on a storm night a screen left on last season's bills is
// the last thing anyone needs.
(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const said = id => String((el(id) || {}).textContent || '').trim();
  const KEY = 'ydjobhub_part_';

  function itemWords() {
    const cat = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : null;
    const n = cat ? Object.keys(cat.items || {}).length : 0;
    return n ? n.toLocaleString('en-US') + ' items' : 'Where to get it';
  }

  const SCREENS = {
    supplies: {
      remember: true,
      watch: ['ordersBadge', 'matDashBadge'],
      parts: [
        { id: 'orders', icon: '📦', name: 'Orders', words: () => said('ordersBadge') || 'Nothing to order' },
        { id: 'list', icon: '🛒', name: 'Supplies', words: itemWords },
        { id: 'bought', icon: '🧾', name: 'Bought', words: () => said('matDashBadge').replace(/\.\d\d /, ' ') || 'This season' },
      ],
    },
    dashboard: {
      remember: true,
      watch: ['dashCount', 'dblBadge', 'evaListBadge', 'crewIssuesBadge'],
      parts: [
        { id: 'jobs', icon: '📋', name: 'Jobs', words: () => said('dashCount') || 'Every job' },
        { id: 'eva', icon: '⚖️', name: 'Estimate vs actual',
          words: () => (said('dblBadge') ? said('dblBadge') + ' costs to check' : said('evaListBadge') || 'Job by job') },
        { id: 'time', icon: '⏱', name: 'How long', words: () => 'From the crew' },
        { id: 'issues', icon: '⚠️', name: 'Issues', words: () => said('crewIssuesBadge') || 'None open' },
      ],
    },
    clock: {
      only: () => !!(window.YDAuth && YDAuth.isOwner),
      watch: ['approveBadge', 'onNowBadge', 'clockBadge', 'crewBadge'],
      parts: [
        { id: 'clock', icon: '🕒', name: 'Clock', words: () => said('approveBadge') || said('onNowBadge') || said('clockBadge') || 'Nobody on' },
        { id: 'crew', icon: '👷', name: 'Crew', words: () => said('crewBadge') || 'Access & pay' },
        { id: 'log', icon: '📓', name: 'Work log', words: () => 'By day or job' },
      ],
    },
    snow: {
      // While a storm is open the screen stays whole, as it always was: the
      // stops, then the weather and the rest under them (storm.js takes the
      // accounts away for the length of it).
      only: () => !document.documentElement.hasAttribute('data-storm-on'),
      watch: ['snowCountBadge', 'seasonBadge'],
      parts: [
        { id: 'route', icon: '🚚', name: 'Route', words: () => said('snowCountBadge') || 'The accounts' },
        { id: 'storms', icon: '❄️', name: 'Storms', words: () => 'Closed & billable' },
        { id: 'season', icon: '📅', name: 'Season', words: () => said('seasonBadge') || 'By account' },
      ],
    },
  };

  const wrapOf = (name, id) => document.querySelector('#panel-' + name + ' [data-part="' + id + '"]');
  const panelOn = name => { const p = el('panel-' + name); return !!(p && p.classList.contains('active')); };
  const chosen = {};
  const drawn = {};
  const timers = {};

  function firstOf(name) {
    const cfg = SCREENS[name];
    if (cfg.remember && !(name in chosen)) {
      try { chosen[name] = localStorage.getItem(KEY + name) || ''; } catch (e) { chosen[name] = ''; }
    }
    return chosen[name] || cfg.parts[0].id;
  }
  // The parts with something showing in them, which each file decides for its
  // own sections (who may see it, whether there is anything to show).
  function partsNow(name) {
    return SCREENS[name].parts.filter(p => {
      const w = wrapOf(name, p.id);
      return !!(w && w.querySelector('.section:not([hidden])'));
    });
  }
  function current(name, list) {
    const want = firstOf(name);
    return list.some(p => p.id === want) ? want : (list[0] ? list[0].id : want);
  }

  function drawNow(name) {
    const cfg = SCREENS[name], bar = el(name + 'Parts');
    if (!bar) return;
    clearTimeout(timers[name]); timers[name] = 0;
    const list = partsNow(name);
    const on = list.length > 1 && (!cfg.only || cfg.only());
    const cur = current(name, list);
    cfg.parts.forEach(p => { const w = wrapOf(name, p.id); if (w) w.hidden = on && p.id !== cur; });
    bar.hidden = !on;
    if (!on) return;
    bar.className = 'jv-views jv-n' + list.length;
    const html = list.map(p => {
      let sub = '';
      try { sub = p.words() || ''; } catch (e) { sub = ''; }
      return '<button type="button" class="jv-btn' + (p.id === cur ? ' on' : '') + '"' + (p.id === cur ? ' aria-current="true"' : '') +
        ' onclick="YDParts.show(\'' + name + '\', \'' + p.id + '\')"><b><span class="jv-icon">' + p.icon + ' </span>' + esc(p.name) +
        '</b><small>' + esc(sub) + '</small></button>';
    }).join('');
    // Only when it has changed: a button redrawn under a finger loses the tap.
    if (html !== drawn[name]) { bar.innerHTML = html; drawn[name] = html; }
  }
  function drawSoon(name) {
    if (timers[name] || !panelOn(name)) return;
    timers[name] = setTimeout(() => drawNow(name), 120);
  }

  // A link into a part, or a tap on its button. After switchTab: arriving at a
  // screen that doesn't remember starts it from its first part.
  function show(name, id) {
    const cfg = SCREENS[name];
    if (!cfg || !cfg.parts.some(p => p.id === id)) return;
    chosen[name] = id;
    if (cfg.remember) { try { localStorage.setItem(KEY + name, id); } catch (e) { /* private window */ } }
    drawNow(name);
  }
  // fresh: from another screen, not the same tab tapped again.
  function arrived(name, fresh) {
    const cfg = SCREENS[name];
    if (!cfg) return;
    if (fresh && !cfg.remember) chosen[name] = cfg.parts[0].id;
    drawNow(name);
  }

  // What each file changes that these depend on.
  Object.keys(SCREENS).forEach(name => {
    if (typeof MutationObserver !== 'function') return;
    const seen = new MutationObserver(() => drawSoon(name));
    document.querySelectorAll('#panel-' + name + ' [data-part] .section').forEach(s => seen.observe(s, { attributes: true, attributeFilter: ['hidden'] }));
    (SCREENS[name].watch || []).forEach(id => { const b = el(id); if (b) seen.observe(b, { childList: true, characterData: true, subtree: true }); });
  });
  document.addEventListener('yd-supplies', () => drawSoon('supplies'));
  document.addEventListener('yd-storm-changed', () => drawSoon('snow'));
  // Whose screen it is changed: after each file has set its sections for them.
  document.addEventListener('yd-auth', () => setTimeout(() => Object.keys(SCREENS).forEach(drawSoon), 0));

  window.YDParts = { show: show, arrived: arrived, now: name => current(name, partsNow(name)) };
})();
