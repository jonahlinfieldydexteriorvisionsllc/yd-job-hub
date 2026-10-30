// Storm watch on Home: what the server last saw coming (functions/
// stormwatch.py, every three hours October to April) -- plowable snow at
// the snow accounts, or freezing rain. Jonah's routine 3 of 14: a push, and
// a "Start storm" card on Home with a short pre-storm list (home.js
// stormWatchHtml draws it from YDStormWatch.outlook()).
//
// settings/stormWatch is one document, readable by everyone who works here
// (firestore.rules); a crew phone cannot watch the settings collection, so
// it is read when Job Hub opens, when it comes back on screen and every
// EVERY_MS -- the server only changes it every three hours.
(function () {
  'use strict';

  const EVERY_MS = 15 * 60 * 1000;
  // An outlook older than this is not shown: the server has stopped
  // checking (out of season, or not running), and a "snow coming" from
  // yesterday would be wrong.
  const STALE_MS = 8 * 3600 * 1000;

  let saved = null;           // settings/stormWatch.outlook as last read
  let who = null;
  let timer = null;

  async function load() {
    if (!who || !window.YDDb) return;
    try {
      const d = await window.YDDb.get('settings', 'stormWatch');
      saved = (d && d.outlook) || null;
    } catch (e) {
      // Offline, or not allowed yet: the last one read stands.
      return;
    }
    document.dispatchEvent(new CustomEvent('yd-stormwatch'));
  }

  const ms = s => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };

  // The snow (or ice) still to come, from a check recent enough to trust.
  function outlook() {
    const o = saved;
    if (!o || !o.coming) return null;
    const now = Date.now();
    if (now - ms(o.at) > STALE_MS) return null;
    const end = Math.max(ms(o.end), ms(o.iceEnd));
    if (end && end < now) return null;
    return o;
  }

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid : null;
    if (k === who) return;
    who = k;
    saved = null;
    if (timer) { clearInterval(timer); timer = null; }
    if (!k) { document.dispatchEvent(new CustomEvent('yd-stormwatch')); return; }
    load();
    timer = setInterval(load, EVERY_MS);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });

  window.YDStormWatch = { outlook: outlook, load: load };
})();
