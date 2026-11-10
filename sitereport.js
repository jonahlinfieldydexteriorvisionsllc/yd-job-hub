/* The website's weekly report, in Media → Website (owner only).

   Jonah, 9 Nov 2026: "i want you tracking analytics for the website and using
   them for us to continually increase the website. I want weekly reports on
   keywords and stuff so we can constantly be improving SEO."

   The server works the report out every Monday after 7 am
   (functions/seoweekly.py) and keeps it in seoReports/{last day of the week};
   settings/seoWeekly lists the weeks and what was sent to Claude. This file
   only reads and draws them: the week's numbers, what to change next with
   Have Claude do it on each, the searches, kinds of work, towns and pages,
   Google Analytics once it is hooked up, and where each website form came
   from. socialposts.js draws the Media tab and calls html() for the view. */
(function () {
  'use strict';
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.user);
  const e = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
  let state = null;          // settings/seoWeekly
  const reports = {};        // week's last day -> report
  let pick = '';             // the week shown ('' = the newest)
  let busy = '';
  let asked = 0;             // when the server was last read (READ_AGAIN_MS)
  const READ_AGAIN_MS = 10 * 60000;
  const ROWS_FIRST = 10;     // searches shown before "Show all"
  let allSearches = false;

  function changed() { document.dispatchEvent(new CustomEvent('yd-site-report')); }

  async function load(force) {
    if (!isOwner() || !window.YDDb) return;
    if (!force && state && Date.now() - asked < READ_AGAIN_MS) return;
    asked = Date.now();
    try { state = (await window.YDDb.get('settings', 'seoWeekly')) || {}; }
    catch (err) { if (!state) state = {}; }
    const week = shownWeek();
    if (week && (force || !reports[week])) {
      try { reports[week] = (await window.YDDb.get('seoReports', week)) || null; } catch (err) { /* drawn as not read */ }
    }
    changed();
  }
  const weeks = () => (state && Array.isArray(state.weeks) ? state.weeks : []);
  const shownWeek = () => (pick && weeks().indexOf(pick) !== -1 ? pick : weeks()[0] || '');
  const report = () => reports[shownWeek()] || null;

  // ------------------------------------------------------------ words

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const place = p => (p == null ? '—' : '#' + Math.round(p));
  function was(now, before, lowerBetter) {
    if (before == null || now == null || now === before) return '';
    const up = now > before;
    const good = lowerBetter ? !up : up;
    return ' <span class="sr-move ' + (good ? 'good' : 'bad') + '" title="Last week ' + e(String(before)) + '">' +
      (up ? '▲' : '▼') + '</span>';
  }
  function shortDay(day) {
    const d = new Date(day + 'T12:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // The view button's small line.
  function words() {
    const r = report();
    if (!r) return state && state.error ? 'Couldn’t be worked out' : 'Comes Mondays';
    const t = r.total || {};
    return plural(t.clicks || 0, 'click') + ' · ' + (r.words || '');
  }

  // ------------------------------------------------------------ drawing

  function tile(label, value, before, lowerBetter, show) {
    return '<div class="sr-tile"><small>' + e(label) + '</small><b>' + (show || e(String(value))) +
      was(value, before, lowerBetter) + '</b><span>' +
      (before == null ? '&nbsp;' : 'Last week ' + e(lowerBetter ? place(before) : String(before))) + '</span></div>';
  }

  function ideaHtml(i, week) {
    const sent = ((state && state.sent) || {})[i.id];
    return '<div class="sr-idea"><b>' + e(i.title) + '</b><p>' + e(i.why) + '</p>' +
      (sent ? '<span class="sr-sent">✓ On the wish board for Claude' + (sent.at ? ', ' + e(shortDay(sent.at.slice(0, 10))) : '') + '</span>'
        : '<button type="button" class="btn btn-secondary sr-claude" onclick="srIdea(\'' + e(week) + '\',\'' + e(i.id) +
          '\')">🤖 Have Claude do it</button>') + '</div>';
  }

  function rows(list, line) {
    return '<div class="sr-rows">' + list.map(line).join('') + '</div>';
  }
  const stat = (x, posOnly) => plural(x.clicks || 0, 'click') + was(x.clicks, x.lastClicks) + ' · shown ' +
    (x.impressions || 0) + was(x.impressions, x.lastImpressions) + (posOnly === false ? '' : ' · ' + place(x.position) +
    was(x.position, x.lastPosition, true));

  function searchesHtml(r) {
    const q = r.queries || [];
    if (!q.length) return '<p class="empty-msg">Google showed no searches for the site this week.</p>';
    const shown = allSearches ? q : q.slice(0, ROWS_FIRST);
    return rows(shown, x => '<div class="sr-row"><b>' + e(x.q) +
      (x.new ? ' <span class="sr-tag new">New</span>' : '') + (x.ours ? ' <span class="sr-tag">Our name</span>' : '') +
      '</b><span>' + stat(x) + '</span></div>') +
      (q.length > ROWS_FIRST && !allSearches ? '<button type="button" class="link-btn" onclick="srAllSearches()">Show all ' +
        q.length + '</button>' : '');
  }

  function groupHtml(list) {
    return rows(list, x => '<div class="sr-row"><b>' + e(x.name) + '</b><span>' + stat(x) + '</span></div>');
  }

  function analyticsHtml(a) {
    if (!a) return '';
    if (a.error) {
      return '<p class="sr-note">' + (a.off
        ? 'Not hooked up yet. Two switches in Google turn it on; they’re on your to-do list. Until then the rest of the report still comes.'
        : 'Couldn’t be read this week. It tries again next Monday.') + '</p>';
    }
    const acts = (a.actions || []).map(x => '<div class="sr-row"><b>' + e(x.words.charAt(0).toUpperCase() + x.words.slice(1)) +
      '</b><span>' + x.count + (x.pages && x.pages.length ? ' · ' + x.pages.map(p => e(p.page) + ' ' + p.count).join(', ') : '') +
      '</span></div>').join('');
    return '<div class="sr-tiles">' +
      tile('People', a.visitors || 0, a.lastVisitors) + tile('Visits', a.visits || 0, a.lastVisits) +
      tile('Pages viewed', a.views || 0, a.lastViews) + '</div>' +
      (acts ? '<h4 class="sr-h">What they did</h4><div class="sr-rows">' + acts + '</div>' : '') +
      (a.channels && a.channels.length ? '<h4 class="sr-h">How they came</h4>' + rows(a.channels, x =>
        '<div class="sr-row"><b>' + e(x.name || 'Other') + '</b><span>' + plural(x.visits || 0, 'visit') + '</span></div>') : '') +
      (a.landing && a.landing.length ? '<h4 class="sr-h">Pages they landed on</h4>' + rows(a.landing, x =>
        '<div class="sr-row"><b>' + e(x.page) + '</b><span>' + plural(x.visits || 0, 'visit') + '</span></div>') : '');
  }

  function leadsHtml(l) {
    if (!l || l.error) return '<p class="sr-note">Couldn’t be counted this week.</p>';
    const forms = l.forms || [];
    return '<p>' + plural(l.website || 0, 'new lead') + ' from the website form, ' +
      plural(l.google || 0, 'Google Ads request') + '.</p>' +
      (forms.length ? rows(forms, f => '<div class="sr-row"><b>' + e(shortDay(f.day)) + (f.known ? ' · already a customer' : '') +
        '</b><span>' + e(f.source || 'Not known') + (f.landing ? ' → ' + e(f.landing) : '') +
        (f.campaign ? ' · ' + e(f.campaign) : '') + '</span></div>') : '');
  }

  function html() {
    if (!isOwner()) return '';
    load();
    const r = report();
    const week = shownWeek();
    const top = (busy ? '<div class="sp-busy">⏳ ' + e(busy) + '</div>' : '') +
      (state && state.error && (!r || (state.errorAt || '') > (r.at || ''))
        ? '<p class="sr-note bad">The last try at the report failed: ' + e(state.error) + '</p>' : '');
    if (!state) return top + '<p class="empty-msg">Loading…</p>';
    if (!r) {
      return top + '<p>The first report comes Monday after 7 am, emailed to you and here: the searches that found the ' +
        'website, where it shows on Google, the week’s leads and what to change next.</p>' +
        '<button type="button" class="btn btn-secondary" onclick="srRunNow()">Work it out now</button>';
    }
    const t = r.total || {}, l = r.totalLast || {};
    const picker = weeks().length > 1 ? '<label class="sr-pick">Week <select onchange="srWeek(this.value)">' +
      weeks().map(w => '<option value="' + e(w) + '"' + (w === week ? ' selected' : '') + '>' +
        e(reports[w] ? reports[w].words : shortDay(w).replace(/^\w+, /, 'to ')) + '</option>').join('') +
      '</select></label>' : '';
    const ideas = r.ideas || [];
    const ix = r.index || {};
    const ours = r.ours || {};
    return top +
      '<div class="sr-head"><span>Google search, <b>' + e(r.words || '') + '</b></span>' + picker + '</div>' +
      '<div class="sr-tiles">' +
        tile('Clicks from Google', t.clicks || 0, l.clicks) +
        tile('Times shown', t.impressions || 0, l.impressions) +
        tile('Average place', t.position, l.position, true, e(place(t.position))) +
        tile('Website leads', (r.leads || {}).website || 0, null) +
      '</div>' +
      '<p class="sr-note">' + (ours.clicks ? plural(ours.clicks, 'click') + ' came from people searching our name; ' +
        plural(Math.max(0, (t.clicks || 0) - ours.clicks), 'click') + ' from searches for the work. ' : '') +
        (ix.pages ? ix.on + ' of ' + ix.pages + ' pages are on Google.' : '') + '</p>' +
      '<h4 class="sr-h">What to change next</h4>' +
      (ideas.length ? ideas.map(i => ideaHtml(i, week)).join('') +
        '<p class="sr-note">Claude makes the change on a copy of the site and writes on the card what changed; the next reports show whether it moved.</p>'
        : '<p class="sr-note">Nothing with enough searches behind it this week. Ideas come once a search has been shown a few dozen times.</p>') +
      '<h4 class="sr-h">Searches that found us</h4>' + searchesHtml(r) +
      ((r.services || []).length ? '<h4 class="sr-h">Kinds of work people searched</h4>' + groupHtml(r.services) : '') +
      ((r.towns || []).length ? '<h4 class="sr-h">Towns people searched</h4>' + groupHtml(r.towns) : '') +
      ((r.pages || []).length ? '<h4 class="sr-h">Pages Google sent people to</h4>' + rows(r.pages, x =>
        '<div class="sr-row"><b>' + e(x.page) + '</b><span>' + stat(x) + '</span></div>') : '') +
      '<h4 class="sr-h">Leads this week</h4>' + leadsHtml(r.leads) +
      '<h4 class="sr-h">Visitors (Google Analytics)</h4>' + analyticsHtml(r.analytics) +
      '<p class="sr-foot">Worked out ' + e(new Date(r.at).toLocaleString()) + '. Google counts searches two or three days behind, ' +
        'so a week ends a few days before the report. <button type="button" class="link-btn" onclick="srRunNow()">Work it out again now</button></p>';
  }

  // ------------------------------------------------------------ taps

  window.srWeek = async w => {
    pick = w;
    allSearches = false;
    if (!reports[w]) {
      busy = 'Reading that week…';
      changed();
      try { reports[w] = (await window.YDDb.get('seoReports', w)) || null; } catch (err) { showToast('That week couldn’t be read'); }
      busy = '';
    }
    changed();
  };
  window.srAllSearches = () => { allSearches = true; changed(); };
  window.srIdea = async (week, id) => {
    if (busy) return;
    busy = 'Putting it on the wish board…';
    changed();
    try {
      const r = await window.YDClaude.post('/digest/seo-idea', { week: week, id: id });
      if (r && r.error) throw new Error(r.error);
      state = state || {};
      state.sent = Object.assign({}, state.sent, { [id]: { at: new Date().toISOString(), card: r && r.card } });
      showToast(r && r.already ? 'It’s already on the wish board' : 'On the wish board — Claude works it at night');
    } catch (err) { showToast(err.message || 'Couldn’t send it'); }
    busy = '';
    changed();
  };
  window.srRunNow = async () => {
    if (busy) return;
    busy = 'Asking Google for the week’s numbers…';
    changed();
    try {
      const r = await window.YDClaude.post('/digest/seo-report', {});
      if (r && r.error) throw new Error(r.error);
      pick = '';
      busy = '';
      await load(true);
      showToast('Report worked out' + (r && r.headline ? ': ' + r.headline : ''));
    } catch (err) { busy = ''; showToast(err.message || 'Couldn’t work it out'); changed(); }
  };
  // The Monday push and the email's link (#website): Media, at Website.
  window.openSiteReport = () => {
    if (window.spView) window.spView('site');
    if (window.openPosts) window.openPosts();
  };
  document.addEventListener('yd-auth', () => {
    if (!isOwner()) { state = null; Object.keys(reports).forEach(k => delete reports[k]); pick = ''; }
  });

  window.YDSiteReport = { html: html, words: words, load: load };
})();
