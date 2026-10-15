// ═══════════════════════════════════════════════════════════
// CONFIG & STATE
// ═══════════════════════════════════════════════════════════
const LABOR_RATE = 25;            // $/hr used for internal labor cost in financials
const STORAGE_PREFIX = 'ydjobhub_';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const MATERIAL_CATEGORIES = [
  { name: 'Screened Topsoil', unit: 'yd', keywords: ['screened topsoil','topsoil'] },
  { name: 'Fill Dirt', unit: 'yd', keywords: ['fill dirt','clean fill','fill'] },
  { name: 'Mulch', unit: 'yd', keywords: ['mulch','hardwood','cedar mulch','dyed mulch','brown mulch','black mulch','red mulch'] },
  { name: 'Road Gravel', unit: 'ton', keywords: ['road gravel','crushed gravel','gravel','3/4 gravel'] },
  { name: 'Limestone Screenings', unit: 'ton', keywords: ['limestone screening','screenings','stone screening'] },
  { name: 'Wash Sand', unit: 'ton', keywords: ['wash sand','washed sand','play sand','mason sand'] },
  { name: 'Decorative Stone', unit: 'ton', keywords: ['decorative stone','river rock','pea gravel','pea stone','landscape rock','rainbow rock'] },
  { name: 'Grass Seed', unit: 'bag', keywords: ['seed','grass seed','pennington','contractor mix','contractors mix'] },
  { name: 'Straw Matting', unit: 'ea', keywords: ['straw matting','erosion blanket','erosion mat','straw blanket','mds blanket'] },
  { name: 'French Drain', unit: 'ft', keywords: ['french drain','filter sock','drain pipe','perforated pipe'] },
  { name: 'Dumpster', unit: 'ea', keywords: ['dumpster','roll-off','roll off'] },
  { name: 'Permits', unit: 'ea', keywords: ['permit','street permit','engineering'] },
  { name: 'Retaining Wall Block', unit: 'ea', keywords: ['versa-lok','versalok','rcp','rockwood','wall block','retaining block','beveled','classic 6'] },
  { name: 'Pavers', unit: 'ea', keywords: ['paver','unilock','techo-bloc','techo bloc'] },
  { name: 'Flagstone', unit: 'ton', keywords: ['flagstone','bluestone','stepper'] },
  { name: 'Boulders', unit: 'ea', keywords: ['boulder','fond du lac','lannon'] },
  { name: 'Geogrid', unit: 'ft', keywords: ['geogrid','grid'] },
  { name: 'Landscape Fabric', unit: 'roll', keywords: ['landscape fabric','weed barrier','fabric'] },
  { name: 'Poly Edging', unit: 'ft', keywords: ['poly edging','edging','poly edge','edge stakes'] },
  { name: 'Cedar Lumber', unit: 'ea', keywords: ['cedar','4x4 post','cedar board','cedar lattice'] },
  { name: 'Synthetic Turf', unit: 'sqft', keywords: ['turf','synthetic turf','artificial turf','infill','turf glue','turf seam tape'] },
  { name: 'Plants', unit: 'ea', keywords: ['plant','hydrangea','shrub','tree','perennial','annual'] },
  { name: 'Fuel', unit: 'gal', keywords: ['fuel','gas','diesel','gasoline'] },
];

let currentJobId = null;
let labor = [];
let materials = [];
let orderItems = [];
let proposals = [];
let payments = [];
let additionalCosts = [];
let serviceTypes = [];
let jobStatus = 'quoting';

// The four stages a job goes through. 'active' was the old single status for
// everything between a won bid and a finished job; it is read as Booked or In
// progress by where the job sat on the Jobs board, so nothing has to be
// re-entered and old copies on other devices still show correctly.
const JOB_STATUS = { quoting: 'Bid', booked: 'Booked', inprogress: 'In progress', complete: 'Complete' };
function normStatus(s, d) {
  if (s === 'active') {
    const stage = d && d.workStage;
    return stage === 'inProgress' || stage === 'punchList' ? 'inprogress' : 'booked';
  }
  return JOB_STATUS[s] ? s : 'quoting';
}
function statusLabel(s) { return JOB_STATUS[s] || (s === 'active' ? 'Booked' : 'Bid'); }
// A bid is not a job (Jonah, 6 Oct 2026: "i only want the job list to track
// jobs actually picked up"). Until it is booked it lives on the Bids board and
// under Bids in the job list -- never in the job list itself, All Jobs or the
// crew's clock.
const isBidStatus = s => normStatus(s) === 'quoting';
function statusPill(s) { return '<span class="pill ' + s + '">' + statusLabel(s) + '</span>'; }
// Where the job sits on the Bids and Jobs boards. The form does not edit these,
// but it must carry them: getJobData() rebuilds the record from scratch, so a
// field it does not know about would be silently dropped by the next save, and
// a card dragged on the board would jump back.
// cardColor is the colour its card is given on the Bids and Jobs boards
// ('' for none, never null -- a null is left out of the save, and the cloud
// copy, which merges, would keep the old colour).
// followUps (the follow-up emails drafted for a bid) is written from the Bids
// board the same way, and qbEstimate (what QuickBooks holds of the estimate)
// by the server and estimate.js, so both ride along with the form too. So does
// acceptedSeenAt: when the estimate was first seen accepted (sync.js
// bookIfAccepted measures a later move of the bid from it). costByHand (the
// figures typed in by hand on Estimate vs actual, jobcosts.js) is written
// through patchJob too, from Tracking or from All Jobs.
// The plant-care email (plantcare.js): completedAt (when the job was last
// marked Complete, from wherever), careDone (he sent it himself, or it isn't
// needed -- set from the board too) and hasPlants (the answer saved last
// time, kept while Supplies is still loading).
// From QuickBooks (quickbooks.py): fromQuickBooks (brought in from an
// estimate made there), qbFilled (its estimate read in full) and snowChecked
// (looked at as a snow contract) -- the server writes them once and must not
// see them vanish at the next save, or it reads the job again every hour.
// removeWhy / replacedBy / removeNote: a job marked to be taken off -- a
// duplicate, or a snow contract now on the Snow route (My Jobs: Delete these).
const BOARD_FIELDS = ['bidStage', 'bidStageAt', 'workStage', 'workStageAt', 'cardColor', 'followUps', 'qbEstimate', 'qbInvoiceRef', 'careEmail', 'acceptedSeenAt',
  'costByHand', 'completedAt', 'careDone', 'hasPlants', 'fromQuickBooks', 'qbFilled', 'snowChecked', 'removeWhy', 'replacedBy', 'removeNote'];
let boardFields = {};
let manualJobPrice = false;
let baseJobPrice = 0;
let dirty = false;
let collapsedMonths = {};
let dashSort = { col: 'name', asc: true };
// The date field shows M/D with no year, so saving re-stamps it with the
// CURRENT year. Opening a December 2025 job in 2026 and saving it silently
// moved the job a year forward. Keeping the stored date lets an untouched
// field stay exactly as it was.
let loadedQuoteDate = '';

const uid = () => Math.random().toString(36).slice(2, 9);

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function entryHours(e) {
  if (e == null) return 0;
  if (e.minutes !== undefined && e.minutes !== null && e.minutes !== '') {
    const h = parseFloat(e.hours) || 0, m = parseFloat(e.minutes) || 0;
    const t = h + m/60; return t > 0 ? t : 0;
  }
  if (e.hours !== undefined && e.hours !== null && e.hours !== '') {
    const h = parseFloat(e.hours); return isNaN(h) || h < 0 ? 0 : h;
  }
  return 0;
}
function fmtHrsMin(d) { if (!d || d <= 0) return '0h 0m'; const h = Math.floor(d); let m = Math.round((d-h)*60); if (m===60) return (h+1)+'h 0m'; return h+'h '+m+'m'; }
// The minus goes in front of the dollar sign: an overpaid balance used to
// read "$-50.00". A value that rounds to nothing stays "$0.00", never "-$0.00".
function fmtMoney(v) {
  const n = parseFloat(v);
  if (isNaN(n) || n === 0) return '$0.00';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 && s !== '0.00' ? '-$' : '$') + s;
}
function parseMoney(s) { return parseFloat(String(s).replace(/[$,]/g,'')) || 0; }
function round2(n) { return Math.round(((parseFloat(n)||0) + Number.EPSILON) * 100) / 100; }
// Safe for text AND for quoted attribute values. The old version (textContent
// -> innerHTML) left quotes alone, so a card titled `6" drain pipe` came back
// into its edit box as `6`, and a name containing a quote could break out of
// an attribute and run script. A lookup table is also far cheaper than making
// a DOM element for every string on every redraw.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, c => ESC_MAP[c]); }

// ---- Dates: user types M/D, app supplies the current year ----
function currentYear() { return new Date().getFullYear(); }
function todayMD() { const d = new Date(); return (d.getMonth()+1) + '/' + d.getDate(); }
function parseMD(str) {
  if (!str) return '';
  str = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0,10);        // already ISO
  str = str.replace(/[.\-]/g, '/');
  const parts = str.split('/').map(s => s.trim()).filter(Boolean);
  let mo, day;
  if (parts.length >= 2) { mo = parseInt(parts[0],10); day = parseInt(parts[1],10); }
  else if (parts.length === 1) { mo = new Date().getMonth()+1; day = parseInt(parts[0],10); }
  else return '';
  if (isNaN(mo)||isNaN(day)||mo<1||mo>12||day<1||day>31) return '';
  return currentYear() + '-' + String(mo).padStart(2,'0') + '-' + String(day).padStart(2,'0');
}
function fmtDateMD(iso) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return parseInt(m[2],10) + '/' + parseInt(m[3],10);
  return iso;
}
// M/D/YYYY, for anything that leaves the app. On screen the year goes without
// saying; in a spreadsheet opened next spring it does not.
function fmtDateMDY(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? parseInt(m[2], 10) + '/' + parseInt(m[3], 10) + '/' + m[1] : String(iso || '');
}
// A calendar date (today, if none is given) as YYYY-MM-DD from LOCAL date
// parts. toISOString() gives the UTC date, which after 7 pm in Wisconsin is
// already tomorrow.
function localYMD(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function readMD(id) { return parseMD(document.getElementById(id).value); }
function resetDateInputs() { ['matDate','addCostDate','payDate'].forEach(id => { const el = document.getElementById(id); if (el) el.value = todayMD(); }); }



// ---- Auth failsafe ----------------------------------------------------------
// If firebase-init.js never reports in, the user must not be stranded behind
// the sign-in overlay staring at a spinner. But the first version of this gave
// Firebase only 8 seconds and then declared the app offline -- fine on a
// desktop, far too short on a phone downloading the SDK over cell service for
// the first time, which made a perfectly healthy app claim it had no signal.
//
// So: wait properly, say so while waiting, and give up early ONLY when the
// module genuinely failed to load (index.html sets YDModuleFailed for that).
(function () {
  const startedAt = Date.now();
  const GIVE_UP_AFTER = 30000;   // generous: a cold phone on cell service
  const SAY_SO_AFTER  = 6000;

  function goLocalOnly(why) {
    console.warn('[auth] falling back to local-only:', why);
    const g = document.getElementById('authGate');
    if (g) g.hidden = true;
    const b = document.getElementById('localOnlyBanner');
    if (b) {
      b.hidden = false;
      const t = document.getElementById('localOnlyText');
      if (t) t.textContent = 'Not connected \u2014 saving to this device only. Tap to retry.';
      b.style.cursor = 'pointer';
      b.onclick = () => location.reload();
    }
  }

  function check() {
    if (window.YDAuth) return;                       // the module reported in
    const g = document.getElementById('authGate');
    // A gate showing a real message is the truth; never hide it.
    if (g && ['signin', 'pending', 'denied', 'error'].includes(g.dataset.state)) return;

    if (window.YDModuleFailed) return goLocalOnly('module failed to load');
    if (Date.now() - startedAt > GIVE_UP_AFTER) return goLocalOnly('timed out');

    // Still loading. Reassure rather than showing a silent spinner.
    if (Date.now() - startedAt > SAY_SO_AFTER) {
      const m = document.getElementById('gateMsg');
      if (m) m.textContent = 'Still connecting\u2026 this can take a moment on a phone.';
    }
    setTimeout(check, 1500);
  }

  setTimeout(check, 3000);
})();

function hideLocalOnlyBanner() {
  const b = document.getElementById('localOnlyBanner');
  if (!b || b.hidden) return;
  b.hidden = true;
  b.onclick = null;
  b.style.cursor = '';
}



// ---- Night mode -------------------------------------------------------------
// Remembered per device: the phone that rides in the truck should stay dark
// without being asked every storm, while the desktop stays light.
//
// Three choices, each device its own: Light, Dark, or Automatic (whatever the
// phone or computer itself is set to, switching when it does).
const THEME_KEY = STORAGE_PREFIX + 'theme';
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function themeChoice() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark' || t === 'auto') return t;
    // Devices that only ever had the old Night button keep what they had.
    return localStorage.getItem(STORAGE_PREFIX + 'night') ? 'dark' : 'light';
  } catch (e) { return 'light'; }
}
function applyNight(on) {
  const r = document.documentElement;
  if (on) r.setAttribute('data-night', ''); else r.removeAttribute('data-night');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = on ? '#0c0a0e' : '#472c64';
  const btn = document.getElementById('nightBtn');
  if (btn) btn.textContent = on ? '◐ Day' : '◑ Night';
}
function applyTheme() {
  const t = themeChoice();
  applyNight(t === 'dark' || (t === 'auto' && !!(darkQuery && darkQuery.matches)));
}
function setTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  applyTheme();
  const m = document.getElementById('themeModal');
  if (m && m.classList.contains('active')) openAppearance();
}
// The Night button on the Snow screen still works: one tap for dark or light.
function toggleNight() {
  setTheme(document.documentElement.hasAttribute('data-night') ? 'light' : 'dark');
}
if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);
applyTheme();

// The Appearance picker, opened from More (phone) or the menu (laptop).
function openAppearance() {
  let m = document.getElementById('themeModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal-overlay';
    m.id = 'themeModal';
    m.onclick = e => { if (e.target === m) m.classList.remove('active'); };
    document.body.appendChild(m);
  }
  const t = themeChoice();
  const opt = (id, icon, label, hint) =>
    '<button class="theme-opt' + (t === id ? ' on' : '') + '" onclick="setTheme(\'' + id + '\')">' +
      '<span class="theme-icon">' + icon + '</span><span><b>' + label + '</b><small>' + hint + '</small></span></button>';
  m.innerHTML = '<div class="modal" style="max-width:440px"><div class="modal-head"><h2>Appearance</h2>' +
    '<button class="modal-close" onclick="document.getElementById(\'themeModal\').classList.remove(\'active\')">&times;</button></div>' +
    '<div class="modal-body">' +
      opt('light', '☀️', 'Light', 'Bright, for daytime and the office') +
      opt('dark', '🌙', 'Dark', 'Easy on the eyes at night and in the truck') +
      opt('auto', '🌓', 'Automatic', 'Follows this ' + (/iPhone|Android/.test(navigator.userAgent) ? 'phone' : 'computer') + '’s own setting') +
      '<div class="hint">Each phone and computer remembers its own choice.</div>' +
    '</div></div>';
  m.classList.add('active');
}

// ---- Account: who is signed in, and signing out ----------------------------
// Signing out deliberately clears this device's cached jobs. Firestore holds
// the real copy, so nothing is lost -- but a crew member handing back a shared
// phone must not leave client names and prices sitting in it.
async function ydSignOut() {
  if (typeof dirty !== 'undefined' && dirty
      && !confirm('You have unsaved changes on this job.\n\nSign out anyway?')) return;
  if (!confirm('Sign out of YD Job Hub?\n\nYour jobs stay safe in the cloud. '
             + 'This device will need to sign in again.')) return;

  closeHeaderMenu();
  // The full sign-out can stop to ask about changes that have not reached
  // the cloud yet; if the answer is "stay", nothing below may happen.
  if (window.YDSignOut && !(await window.YDSignOut())) return;
  try {
    // Light or dark is how this phone looks, not whose it is -- keep it.
    Object.keys(localStorage)
      .filter(k => k.indexOf(STORAGE_PREFIX) === 0 && k !== THEME_KEY)
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { console.warn('could not clear local cache', e); }

  // Already confirmed above; without this the browser's own "leave site?"
  // prompt asked the same question a second time.
  if (typeof dirty !== 'undefined') dirty = false;
  location.reload();
}

// Fill the menu in once we know who is signed in. Stays hidden entirely when
// running without Firebase, where there is no account to show.
document.addEventListener('yd-auth', e => {
  const a = e.detail || {};
  // The failsafe above gives up after 30 seconds and puts up "Not connected".
  // A slow phone can still finish connecting after that, and the banner then
  // sat there for the rest of the session contradicting a working app. Only
  // a cloud answer clears it: firebase-init's own local-only mode sets the
  // banner itself, with mode 'local', and that one is true.
  if (a.mode === 'cloud') hideLocalOnlyBanner();
  const who = document.getElementById('menuWho');
  const out = document.getElementById('menuSignOut');
  const sep = document.getElementById('menuAccountSep');
  const on = !!(a.user && a.mode === 'cloud');
  if (who) {
    who.hidden = !on;
    if (on) who.textContent = ({ owner: 'Owner · ', admin: 'Admin · ' }[a.role] || 'Crew · ') + a.user.email;
  }
  if (out) out.hidden = !on;
  if (sep) sep.hidden = !on;
  const people = document.getElementById('menuPeople');
  if (people) people.hidden = !(on && a.isOwner);
  const pricing = document.getElementById('menuPricing');
  if (pricing) pricing.hidden = !(on && a.isOwner);
  // Backup, Restore and Print work on the jobs saved on this device, which
  // a crew phone never has: for the crew they only did nothing.
  ['menuBackup', 'menuRestore', 'menuPrint'].forEach(id => {
    const it = document.getElementById(id);
    if (it) it.hidden = on && a.role === 'crew';
  });

  // The job screens -- Job, Tracking, All Jobs, and the materials half of
  // Supplies -- are for whoever may see jobs: the owner, and an admin given
  // Jobs. Crew get the screens built for them instead (the clock, the snow
  // route, the calendar, boards and supplies). The job screens read prices
  // and client details the rules deny them outright, so showing them would
  // hand over screens that load empty and look broken. This is presentation
  // only; the rules are the enforcement.
  const noJobs = on && !ydCan('jobs', 'see');
  ['tabJob', 'tabTracking', 'tabDashboard', 'matSeasonSection'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.hidden = noJobs;
  });

  // Save and New change jobs; My Jobs opens them. The context bar names
  // whichever client's job is open, which has no business on a crew phone.
  const b = id => document.getElementById(id) || {};
  b('btnMyJobs').hidden = noJobs;
  b('btnSave').hidden = b('btnNew').hidden = on && !ydCan('jobs', 'change');
  const ctx = document.getElementById('ctxBar');
  if (ctx) ctx.style.display = noJobs ? 'none' : '';
  // An admin who may look at jobs but not change them gets the form locked.
  applyJobsReadOnly();

  // The attribute tells the stylesheet this is somebody without the job
  // screens (crew, mostly).
  document.documentElement.toggleAttribute('data-crew', noJobs);
  const more = document.getElementById('tabMore');
  // Crew get More too now: it holds their notification settings.
  if (more) more.hidden = false;
  // Left on a job screen they may no longer see: Home, which everybody has.
  if (noJobs) {
    const openTab = document.querySelector('.tab-panel.active');
    if (!openTab || ['panel-job', 'panel-tracking', 'panel-dashboard']
        .indexOf(openTab.id) !== -1) switchTab('home');
  }
});

// Your Crew lives on the Clock tab, below the clock and the approvals --
// easy to miss. This goes straight to it: renaming, letting people in,
// making an admin.
function openPeople() {
  switchTab('clock');
  const sec = document.getElementById('clockCrewSection');
  if (sec && !sec.hidden) setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

// What the signed-in person may do in one area of the business: 'see' or
// 'change'. Always true for the owner and false for crew; an admin has what
// the owner gave them on Your Crew. Not security -- firestore.rules is.
function ydCan(area, level) {
  const a = window.YDAuth;
  return !!(a && typeof a.can === 'function' && a.can(area, level || 'see'));
}

// Someone who may see jobs but not change them: every field on the Job and
// Tracking screens is locked, and nothing is saved. Without this they could
// type into a job, have it "save" on their phone, and never learn that the
// server refused it.
function jobsReadOnly() {
  const a = window.YDAuth;
  return !!(a && a.mode === 'cloud' && a.user && ydCan('jobs', 'see') && !ydCan('jobs', 'change'));
}
// The stylesheet makes the two screens untouchable (rows added later
// included); persistJob refuses to save as the backstop.
function applyJobsReadOnly() {
  document.documentElement.toggleAttribute('data-jobs-readonly', jobsReadOnly());
}

// ---- The More sheet ----
//
// Built each time it opens rather than written into the markup, so it lists
// exactly the screens this person is allowed to see. Crew get More too: their
// screens all fit on the bar, but it is where Notifications and Appearance
// live.
function openMore() {
  const wrap = document.getElementById('moreItems');
  const sheet = document.getElementById('moreSheet');
  if (!wrap || !sheet) return;
  const hidden = TABS.filter(n => PHONE_TABS.indexOf(n) === -1)
    .filter(n => {
      const b = document.getElementById(tabButtonId(n));
      return b && !b.hidden;
    });
  // Settings that are not screens of their own live here too, so they are
  // found where everything else is rather than up in the header.
  const signedIn = !!(window.YDAuth && window.YDAuth.user && window.YDAuth.mode === 'cloud');
  const notesN = window.YDCrewNotes ? YDCrewNotes.unread() : 0;
  const crew = crewView();
  const hints = crew ? TAB_HINT_CREW : TAB_HINT;
  const extras = ((window.YDAuth && window.YDAuth.isOwner)
    ? [{ label: '👥 People & names', hint: 'Rename people, let them in, make an admin',
         call: 'closeMore(); openPeople()' },
       { label: '📝 Notes from the crew' + (notesN ? ' (' + notesN + ')' : ''), hint: 'What the crew wrote you',
         call: 'closeMore(); openCrewNotes()' }]
    : signedIn
    ? [{ label: '📝 Leave a note for Jonah', hint: 'He gets it as a notification',
         call: 'closeMore(); openNoteForJonah()' },
       { label: '📝 Your notes', hint: 'The notes you have sent', call: 'closeMore(); openCrewNotes()' }]
    : []).concat((window.YDAuth && window.YDAuth.user)
    ? [{ label: '📰 Past summaries', hint: crew ? 'Your morning and evening updates from the last two weeks'
           : 'This morning’s and last night’s summary, and the two weeks before',
         call: 'closeMore(); openSummaries()' },
       { label: '🔔 Notification settings', hint: crew ? 'Reminders and updates on this phone'
           : 'Daily updates by email and on your phone',
         call: 'closeMore(); openNotifications()' }]
    : []).concat(signedIn && typeof window.openSettings === 'function'
    ? [{ label: '⚙ All settings', hint: 'Every setting in one place',
         call: 'closeMore(); if (typeof openSettings === \'function\') openSettings()' }]
    : []).concat([{ label: '🌓 Appearance', hint: 'Light, dark, or match this phone',
         call: 'closeMore(); openAppearance()' }]);
  // Search (search.js) first: on a phone the header has no room for its own
  // button on the job screens, so this is the way to it there.
  const search = signedIn && typeof window.openSearch === 'function'
    ? '<button class="sheet-item" onclick="closeMore(); if (typeof openSearch === \'function\') openSearch()">' +
        '<span class="sheet-item-name">🔍 Search</span>' +
        '<span class="sheet-item-hint">Find anything in Job Hub</span></button>'
    : '';
  wrap.innerHTML = (hidden.length || extras.length)
    ? search + hidden.map(n => '<button class="sheet-item" onclick="switchTab(\'' + n + '\')">' +
        '<span class="sheet-item-name">' + TAB_LABEL[n] + '</span>' +
        (hints[n] ? '<span class="sheet-item-hint">' + hints[n] + '</span>' : '') +
      '</button>').join('') +
      extras.map(x => '<button class="sheet-item" onclick="' + x.call + '">' +
        '<span class="sheet-item-name">' + x.label + '</span>' +
        '<span class="sheet-item-hint">' + x.hint + '</span></button>').join('')
    : '<p class="empty-msg">Nothing else here.</p>';
  sheet.classList.add('active');
}
function closeMore() {
  const s = document.getElementById('moreSheet');
  if (s) s.classList.remove('active');
}
function tabButtonId(name) {
  return { home: 'tabHome', crewjobs: 'tabCrewJobs', job: 'tabJob', snow: 'tabSnow', clock: 'tabClock', tracking: 'tabTracking',
    dashboard: 'tabDashboard', contacts: 'tabContacts',
    equipment: 'tabEquipment', calendar: 'tabCalendar', boards: 'tabBoards',
    supplies: 'tabSupplies', matdash: 'tabSupplies', receipts: 'tabReceipts' }[name] || '';
}
// The materials half of Supplies, hidden from crew.
function matSectionHidden() {
  const m = document.getElementById('matSeasonSection');
  return !m || m.hidden;
}

// ---- Header overflow menu (⋯) ----
// Search and All settings first, then groups -- Business, Inbox, App, Data,
// Help -- under small headings. Which items show is decided by each item's
// own file on sign-in (and by the stylesheet: on a phone Notification
// settings and Appearance live in More instead), so a heading is only known
// to be empty once the menu is about to show: one with nothing under it is
// hidden then.
function toggleHeaderMenu() {
  const m = document.getElementById('headerMenu');
  if (!m) return;
  if (m.hidden) tidyHeaderMenu(m);
  m.hidden = !m.hidden;
}
function tidyHeaderMenu(m) {
  // Search and All settings come from search.js, when it is there.
  const signedIn = !!(window.YDAuth && window.YDAuth.user);
  const search = document.getElementById('menuSearch');
  if (search) search.hidden = !(signedIn && typeof window.openSearch === 'function');
  const all = document.getElementById('menuSettings');
  if (all) all.hidden = !(signedIn && typeof window.openSettings === 'function');
  // A button's own computed display says whether it shows, whatever its
  // group or the closed menu around it are doing.
  m.querySelectorAll('.menu-group').forEach(g => {
    g.hidden = !Array.prototype.some.call(g.querySelectorAll('button'),
      b => !b.hidden && getComputedStyle(b).display !== 'none');
  });
}
function closeHeaderMenu() {
  const m = document.getElementById('headerMenu');
  if (m) m.hidden = true;
}
// A click anywhere outside the menu closes it. Clicks on the toggle itself are
// inside .menu-wrap, so they fall through to toggleHeaderMenu() instead.
document.addEventListener('click', e => {
  if (!e.target.closest('.menu-wrap')) closeHeaderMenu();
});
// Escape closes whatever is in front: the header menu if it is open,
// otherwise the top-most modal or the More sheet. It presses that window's
// own close button rather than hiding it directly, so whatever the window
// does on closing -- a redraw, a question about unsaved changes -- still runs.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
  const menu = document.getElementById('headerMenu');
  if (menu && !menu.hidden) { closeHeaderMenu(); return; }
  const top = topOverlay();
  const close = top && top.querySelector('.modal-close, .sheet-close');
  if (close) close.click();
});

// The open modal or sheet that is actually in front. Several can be open at
// once (a worker's page over the clock, say), and which one shows is decided
// by the stylesheet's stacking, not by the order they were opened in -- so
// ask the page what sits at the middle of the screen. Every overlay covers
// the whole screen, so the one in front is the one found there.
const OPEN_OVERLAY = '.modal-overlay.active, .sheet-overlay.active';
function topOverlay() {
  const open = document.querySelectorAll(OPEN_OVERLAY);
  if (!open.length) return null;
  const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  if (!hit) return open[open.length - 1];
  // Something that is not an overlay in front of them all -- the sign-in
  // screen -- means none of them is what the person is looking at.
  return hit.closest(OPEN_OVERLAY);
}

// Windows that only show things can close with a tap outside them. Ones with
// fields to fill in cannot: a stray tap beside a half-finished form would
// throw away everything typed into it. The press has to start on the backdrop
// as well as end there, so dragging to select text in a list and letting go
// outside it does not count as a tap outside.
const TAP_OUTSIDE_CLOSES = ['managerModal', 'problemsModal', 'stormDetailModal'];
function closeOnTapOutside(id) {
  const m = document.getElementById(id);
  if (!m) return;
  // A browser too old for pointer events just closes on the click itself.
  let pressedOutside = !window.PointerEvent;
  m.addEventListener('pointerdown', e => { pressedOutside = e.target === m; });
  m.addEventListener('click', e => {
    if (e.target !== m || !pressedOutside) return;
    const close = m.querySelector('.modal-close');
    if (close) close.click();
  });
}

// ═══════════════════════════════════════════════════════════
// TABS + CONTEXT BAR
// ═══════════════════════════════════════════════════════════
// The bar on a phone holds only what gets used in the field. The rest is one
// tap away behind More, which is what stops every new screen making the bar
// more crowded than the last.
// In the order they sit on the bar, as Jonah laid it out: Job, then Tracking
// and Supplies beside it, All Jobs on the far right. Materials used to be a
// tab of its own; it is now the second half of Supplies, beside the suppliers
// it is bought from.
// Home comes first and is where the app opens (Jonah, 14 Oct 2026: "make
// home page for the job hub with overviews of things") -- home.js.
const TABS = ['home', 'crewjobs', 'job', 'tracking', 'supplies', 'receipts', 'snow', 'clock', 'calendar', 'boards', 'equipment', 'contacts', 'dashboard'];
// crewjobs: the crew's Jobs tab (crewjobs.js) -- shown only to whoever cannot see the Job tab.
// Five on a phone's bar for anybody: Home took All Jobs' place on the
// owner's (Home has the jobs on the go and the ones to invoice; the full
// table is a laptop screen), and Boards and Supplies' on the crew's (their
// cards and crew tasks for the day are on Home). All three are in More.
const PHONE_TABS = ['home', 'crewjobs', 'job', 'snow', 'clock', 'calendar'];
const TAB_LABEL = { home: '🏠 Home', crewjobs: '🧰 Jobs', job: '📋 Job', snow: '❄️ Snow', clock: '⏱️ Clock',
  calendar: '📅 Calendar', boards: '📌 Boards', supplies: '🛒 Supplies', receipts: '🧾 Receipts',
  equipment: '🚜 Equipment', tracking: '🔨 Tracking',
  dashboard: '📊 All Jobs', contacts: '📇 Contacts' };
const TAB_HINT = { boards: 'Bids, jobs, to-dos and crew task lists',
  supplies: 'What we use, where to buy it, and what the season has cost',
  receipts: 'Purchases from your email — put each on its job',
  equipment: 'What each machine and truck is due for',
  tracking: 'Hours and materials on the job you have open',
  dashboard: 'Every job with its price and what it made',
  contacts: 'People to ring later' };
// The same screens as the crew see them: without prices, bids or what the
// season cost, so the words should not promise them.
const TAB_HINT_CREW = { boards: 'Crew tasks and the boards shared with you',
  supplies: 'What we use and where to get it',
  receipts: 'Add a receipt for something you bought',
  equipment: 'What each machine and truck is due for',
  calendar: 'Your day and the crew’s',
  contacts: 'People to ring later' };
// Somebody without the job screens (crew, mostly) -- the same test the
// stylesheet uses (data-crew, set on sign-in).
function crewView() { return document.documentElement.hasAttribute('data-crew'); }

function switchTab(name) {
  // An old notification link, or a habit, may still ask for Materials: it
  // lives at the foot of Supplies now.
  const toMaterials = name === 'matdash';
  if (toMaterials) name = 'supplies';
  closeMore();
  // Which screen was showing: a new one opens at its top. Without this a tab
  // opened wherever the last one had been scrolled to -- halfway down an
  // empty page, or past the part that matters. The same tab tapped again
  // stays where it is.
  const was = document.querySelector('.tab-panel.active');
  const changed = !was || was.id !== 'panel-' + name;
  // The stylesheet uses this to show the job controls only on job screens.
  document.documentElement.dataset.tab = name;
  // Matched by id, not by position: the buttons are not in the same order as
  // TABS, and matching by position lit up the wrong button on a laptop.
  const activeBtn = tabButtonId(name);
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.id === activeBtn);
  });
  // On a phone, a screen reached through More has no button of its own, so
  // More itself carries the highlight -- otherwise nothing on the bar would
  // look selected and the app would seem to have lost its place.
  // Lit only when the screen has no button of its own showing on the bar.
  // Going by the list of phone tabs was wrong on a crew phone, where Boards
  // and Supplies are on the bar: tapping one lit up that button AND More.
  const more = document.getElementById('tabMore');
  const own = document.getElementById(activeBtn);
  const ownShowing = !!(own && !own.hidden && getComputedStyle(own).display !== 'none');
  if (more) more.classList.toggle('active', !ownShowing);
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  if (changed) window.scrollTo(0, 0);
  if (name === 'dashboard') renderDashboard();
  // Labour is not redrawn while Tracking is hidden, so catch up on arrival.
  if (name === 'tracking' && typeof renderLabor === 'function') renderLabor();
  if (name === 'supplies' && !matSectionHidden()) renderMatDash();
  if (toMaterials) {
    const m = document.getElementById('matSeasonSection');
    if (m && !m.hidden) m.scrollIntoView({ block: 'start' });
  }
  if (name === 'snow' && window.YDSnow) YDSnow.render();
  if (name === 'contacts' && window.YDProspects) YDProspects.render();
  if (name === 'clock' && window.YDClock) YDClock.render();
  if (name === 'clock' && window.YDWorkLog) YDWorkLog.render();
  if (name === 'equipment' && window.YDEquipment) YDEquipment.render();
  if (name === 'calendar' && window.YDCalendar) YDCalendar.render();
  if (name === 'boards' && window.YDBoards) YDBoards.render();
  if (name === 'supplies' && window.YDSupplies) YDSupplies.render();
  if (name === 'receipts' && window.YDReceipts) YDReceipts.render();
  if (name === 'dashboard' && window.YDSubs) YDSubs.render();
  if (name === 'crewjobs' && window.YDCrewJobs) YDCrewJobs.render();
  if (name === 'home' && window.YDHome) YDHome.render();
}

// A notification tapped while Job Hub is already open. The service worker
// used to reload the open window at the notification's address, which threw
// away whatever was on screen with no "leave page?" question. Now it brings
// the window forward and passes the address here instead.
//
// notify.js only reads the address's #tab when sign-in completes, so a
// window that is already signed in is moved to that screen directly; one
// still at the sign-in screen gets the #tab put in its address, for notify.js
// to act on once sign-in finishes.
// A daily summary (#summary) and a note from the crew (#notes) open their own
// windows rather than a tab. Those too are kept in the address while sign-in
// is still going on -- the summary one used to be dropped there, so a tapped
// summary opened nothing.
const NOTIFICATION_WINDOWS = { summary: 'openSummaries', notes: 'openCrewNotes' };
function openFromNotification(url) {
  let want = '';
  try { want = new URL(url, location.href).hash.slice(1); } catch (e) { return; }
  const opener = NOTIFICATION_WINDOWS[want];
  if (!opener && TABS.indexOf(want) === -1) return;
  if (!(window.YDAuth && window.YDAuth.user)) {
    history.replaceState(null, '', location.pathname + location.search + '#' + want);
    return;
  }
  if (opener) { if (typeof window[opener] === 'function') window[opener](); return; }
  const btn = document.getElementById(tabButtonId(want));
  if (btn && !btn.hidden) switchTab(want);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'yd-notification-open') openFromNotification(d.url);
  });
}
function updateCtxBar() {
  const name = (document.getElementById('customerName').value || '').trim();
  // Invoiced: the box ticked by hand, or an invoice QuickBooks holds for it.
  const invoiced = (document.getElementById('qbInvoiced') && document.getElementById('qbInvoiced').checked) ||
    !!(boardFields.qbInvoiceRef && boardFields.qbInvoiceRef.id);
  // The name in a span of its own: on a phone a long name is cut short with
  // "…", and the chip after it must not be cut off with it.
  document.getElementById('ctxName').innerHTML = '<span class="ctx-name-text">' + esc(name || (currentJobId ? 'Untitled Job' : 'New Job')) + '</span>' +
    (invoiced ? '<span class="qb-chip">QB Invoiced</span>' : '');
  const st = document.getElementById('ctxStatus');
  st.textContent = statusLabel(jobStatus); st.className = 'pill ' + jobStatus;
  const dot = document.getElementById('ctxDot');
  dot.classList.remove('unsaved', 'error');
  if (storageBroken) { dot.classList.add('error'); document.getElementById('ctxDotText').textContent = 'Save failed'; }
  else if (dirty) { dot.classList.add('unsaved'); document.getElementById('ctxDotText').textContent = 'Saving…'; }
  else { document.getElementById('ctxDotText').textContent = 'Saved'; }
  // An invoice QuickBooks has just made arrives through here too (estimate.js
  // afterInvoice), so its line on the Job tab follows.
  showJobQbFields(false);
}

// ═══════════════════════════════════════════════════════════
// SERVICE TYPES
// ═══════════════════════════════════════════════════════════
function addServiceType() {
  const sel = document.getElementById('serviceTypeSelect');
  let val = sel.value;
  if (!val) return;
  if (val === '__custom') { val = prompt('Custom service type:'); if (!val || !val.trim()) { sel.value = ''; return; } val = val.trim(); }
  sel.value = '';
  rememberService(val);
  // Only a real change marks the job unsaved -- a cancelled custom type or a
  // type already on the job used to trigger an autosave of nothing.
  if (serviceTypes.includes(val)) return;
  serviceTypes.push(val);
  renderServiceTypes();
  markDirty();
}

// Services typed in by hand are kept for good (Jonah, 12 Oct 2026: "the
// service i add then adds the list and is there permanently for me to reuse
// on other clients/jobs/bids"), in settings/services as
// { custom: { key: name } } -- a map, so two devices adding at the same
// moment both keep theirs. The Job tab's list and the Contacts tags offer
// them after the built-in ones; "✎ Edit the list" adds or takes one off by
// hand.
const savedServices = {};   // key -> name
const svcKey = n => String(n || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
function builtInServices() {
  return Array.prototype.filter.call(document.getElementById('serviceTypeSelect').options,
    o => o.value && o.value !== '__custom' && !o.dataset.saved && !o.dataset.typed).map(o => o.value);
}
function isKnownService(name) {
  const k = svcKey(name);
  return !k || !!savedServices[k] || builtInServices().some(b => svcKey(b) === k);
}
// The saved ones go in just before "Custom…", in A–Z order.
function fillServiceOptions() {
  const sel = document.getElementById('serviceTypeSelect');
  if (!sel) return;
  Array.prototype.slice.call(sel.options).forEach(o => { if (o.dataset.saved) o.remove(); });
  const built = builtInServices().map(svcKey);
  const before = Array.prototype.find.call(sel.options, o => o.value === '__custom') || null;
  Object.values(savedServices).filter(n => built.indexOf(svcKey(n)) === -1)
    .sort((a, b) => a.localeCompare(b)).forEach(n => {
      const o = new Option(n, n);
      o.dataset.saved = '1';
      sel.insertBefore(o, before);
    });
  document.dispatchEvent(new CustomEvent('yd-services'));
}
function saveServices(patch, what) {
  if (!window.YDDb || !window.YDAuth || window.YDAuth.mode !== 'cloud') return;
  Promise.resolve(window.YDDb.put('settings', 'services', { custom: patch, updatedAt: new Date().toISOString() }))
    .catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved to the list — not allowed');
      else console.warn('[services] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
}
function rememberService(name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name || isKnownService(name)) return;
  savedServices[svcKey(name)] = name;
  saveServices({ [svcKey(name)]: name }, 'adding ' + name);
  fillServiceOptions();
}
window.rememberService = rememberService;
function loadServices() {
  if (!window.YDDb || !window.YDAuth || !window.YDAuth.user) return;
  Promise.resolve(window.YDDb.get('settings', 'services')).then(d => {
    Object.keys(savedServices).forEach(k => delete savedServices[k]);
    Object.entries((d && d.custom) || {}).forEach(([k, n]) => { if (n) savedServices[k] = n; });
    fillServiceOptions();
  }).catch(() => {});
}
document.addEventListener('yd-auth', e => { if (e.detail && e.detail.user) loadServices(); });

// "✎ Edit the list": the saved services, each with ✕, and a box to add one.
// The built-in ones are listed too, but stay.
function openServicesEditor() {
  let m = document.getElementById('svcListModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal-overlay';
    m.id = 'svcListModal';
    m.onclick = ev => { if (ev.target === m) closeServicesEditor(); };
    m.innerHTML = '<div class="modal" style="max-width:520px"><div class="modal-head"><h2>Your services</h2>' +
      '<button class="modal-close" onclick="closeServicesEditor()">&times;</button></div>' +
      '<div class="modal-body" id="svcListBody"></div></div>';
    document.body.appendChild(m);
  }
  m.classList.add('active');
  renderServicesEditor();
}
window.openServicesEditor = openServicesEditor;
window.closeServicesEditor = function () { const m = document.getElementById('svcListModal'); if (m) m.classList.remove('active'); };
function renderServicesEditor() {
  const body = document.getElementById('svcListBody');
  if (!body) return;
  const saved = Object.entries(savedServices).sort((a, b) => a[1].localeCompare(b[1]));
  body.innerHTML =
    '<div class="field"><span class="label">Added by you</span>' +
      (saved.length ? '<div class="svc-list">' + saved.map(([k, n]) => '<span class="svc-tag">' + esc(n) +
        '<button onclick="forgetService(\'' + k.replace(/[^a-z0-9-]/g, '') + '\')" title="Take it off the list">×</button></span>').join('') + '</div>'
        : '<div class="hint">None yet. Anything you type in on a job, bid or contact is kept here.</div>') +
    '</div>' +
    '<div class="field"><span class="label">Add one</span><div class="sub-svc-add">' +
      '<input id="svcListNew" placeholder="e.g. Gutter cleaning" onkeydown="if(event.key===\'Enter\'){event.preventDefault();addServiceToList()}">' +
      '<button class="btn btn-sm btn-filled" onclick="addServiceToList()">+ Add</button></div></div>' +
    '<div class="field"><span class="label">Always on the list</span><div class="hint">' + esc(builtInServices().join(' · ')) + '</div></div>' +
    '<div class="hint">Taking one off the list leaves it on the jobs and contacts that already have it.</div>';
}
window.addServiceToList = function () {
  const box = document.getElementById('svcListNew');
  const name = box ? box.value.trim() : '';
  if (!name) return;
  if (isKnownService(name)) { showToast('Already on the list'); box.value = ''; return; }
  rememberService(name);
  renderServicesEditor();
  const again = document.getElementById('svcListNew'); if (again) again.focus();
};
window.forgetService = function (key) {
  const name = savedServices[key];
  if (!name) return;
  delete savedServices[key];
  saveServices({ [key]: null }, 'taking ' + name + ' off');
  fillServiceOptions();
  renderServicesEditor();
};
function removeServiceType(idx) { serviceTypes.splice(idx, 1); renderServiceTypes(); markDirty(); }
function renderServiceTypes() {
  const wrap = document.getElementById('serviceTypeTags');
  if (!serviceTypes.length) { wrap.innerHTML = '<span style="color:#a096ad;font-size:12px;padding:4px">No service types</span>'; return; }
  wrap.innerHTML = serviceTypes.map((s, i) => '<span class="svc-tag">' + esc(s) + '<button onclick="removeServiceType(' + i + ')">×</button></span>').join('');
}

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════
// Changing the status in the form moves the job's card on the Jobs board to
// match -- Booked to Scheduled, In progress to In progress -- so the two never
// disagree. A job already in Punch list stays there when set to In progress.
function onStatusChange() {
  const was = jobStatus;
  jobStatus = document.getElementById('jobStatusSelect').value;
  const at = new Date().toISOString();
  if (jobStatus === 'booked' && was !== 'booked') { boardFields.workStage = 'scheduled'; boardFields.workStageAt = at; }
  // Booked here rather than from the board: the order list fills the same way.
  if (jobStatus === 'booked' && isBidStatus(was) && !orderItems.some(it => it.fromEstimate)) fillOrderFromEstimate(true);
  // When it was finished: a job with plants owes its care email from then
  // (plantcare.js), as when it is finished from the board (sync.js patchJob).
  if (jobStatus === 'complete' && was !== 'complete') boardFields.completedAt = at;
  // Finished here: the card goes to Ready to invoice -- or Invoiced / Paid
  // when QuickBooks already has the invoice (the deposit invoice is often
  // made at acceptance). It used to stay wherever it was, so the Jobs board
  // said "In progress" for a job the form called Complete. One rule with the
  // board and the server (sync.js finishedStage). Set before the save below.
  if (jobStatus === 'complete' && was !== 'complete' && window.YDSync && window.YDSync.finishedStage) {
    const inv = document.getElementById('qbInvoiced');
    boardFields.workStage = window.YDSync.finishedStage({ workStage: boardFields.workStage,
      qbInvoiceRef: boardFields.qbInvoiceRef, qbInvoiced: !!(inv && inv.checked) });
    boardFields.workStageAt = at;
  }
  // Finished here: the plant-care email, as from the board (estimate.js).
  // Saved first, so what goes to the server has the status (and an email
  // address typed a moment ago) in it.
  if (jobStatus === 'complete' && was !== 'complete' && window.YDEstimate && window.YDEstimate.jobCompleted) {
    autosave();
    if (currentJobId) window.YDEstimate.jobCompleted(currentJobId, getJobData());
  }
  if (jobStatus === 'inprogress' && boardFields.workStage !== 'punchList' && was !== 'inprogress') {
    boardFields.workStage = 'inProgress'; boardFields.workStageAt = at;
  }
  showBidBanner();
  updateCtxBar();
  if (window.YDPlants) window.YDPlants.refresh();
}
function syncStatusSelect() { document.getElementById('jobStatusSelect').value = jobStatus; showBidBanner(); }
function showBidBanner() {
  const b = document.getElementById('bidBanner');
  if (b) b.hidden = !isBidStatus(jobStatus);
  // A lost bid is off the Bids board (Jonah, 9 Oct 2026) -- it can be put
  // back, or booked if they ring after all.
  const lost = isBidStatus(jobStatus) && boardFields.bidStage === 'lost';
  const t = document.getElementById('bidBannerText'), r = document.getElementById('bidReopenBtn');
  if (t) t.innerHTML = lost ? '<b>This bid was lost.</b> It is off the Bids board and the customer is on Contacts for next season.'
    : '<b>This is a bid.</b> It is on the Bids board, not in your job list, until you book it.';
  if (r) r.hidden = !lost;
  // Called whenever a job loads or its status changes: the invoice boxes
  // follow whether it is a bid.
  showJobQbFields(true);
}

// The job's QuickBooks invoice (made from its estimate, quickbooks.py), or
// null. One made in the other QuickBooks company -- the test one, before the
// switch to the real books -- is not this job's; estimate.js ignores it the
// same way.
function jobQbInvoice() {
  const r = boardFields.qbInvoiceRef, q = boardFields.qbEstimate;
  if (!r || !r.id) return null;
  return r.env && q && q.env && r.env !== q.env ? null : r;
}
// The invoice boxes on the Job tab. A bid has no invoice yet, so "QuickBooks
// Invoice #" and "Invoiced in QuickBooks" are put away on one -- unless
// something is already in them. Once QuickBooks holds the invoice, a line
// says its number and what is still owed, and the boxes go: the number box
// only when it is empty or says the same number (one typed in by hand for
// another invoice stays), the tick always (the invoice is the answer).
// Only hidden, never removed -- getJobData() still reads both.
// Which boxes show is worked out again only when the job, its status or its
// invoice changes (`again`, or a new key), never on a keystroke: clearing
// the number on a bid must not make the box vanish under the cursor.
let jobQbShownFor = null;
function showJobQbFields(again) {
  const box = document.getElementById('qbInvoice'), tick = document.getElementById('qbInvoiced');
  const field = document.getElementById('qbInvoiceField'), row = document.getElementById('qbInvoicedRow');
  const line = document.getElementById('jobQbLine');
  if (!box || !tick || !field || !row || !line) return;
  const inv = jobQbInvoice(), bid = isBidStatus(jobStatus);
  if (inv) {
    const owed = inv.balance == null || inv.balance === '' ? NaN : Number(inv.balance);
    const total = inv.total == null || inv.total === '' ? NaN : Number(inv.total);
    const what = isFinite(owed) ? (owed <= 0 ? 'paid in full' : fmtMoney(owed) + ' owed')
      : isFinite(total) ? fmtMoney(total) : '';
    const link = /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(String(inv.link || ''))
      ? ' <a class="link-btn" href="' + esc(inv.link) + '" target="_blank" rel="noopener">Open it</a>' : '';
    line.innerHTML = '<span class="job-qb-what">QuickBooks: invoice' + (inv.docNumber ? ' #' + esc(inv.docNumber) : ' made') +
      (what ? ' · <b' + (isFinite(owed) && owed <= 0 ? ' class="job-qb-paid"' : '') + '>' + esc(what) + '</b>' : '') + '</span>' + link;
  }
  line.hidden = !inv;
  const key = [currentJobId, bid ? 'bid' : 'job', inv ? inv.id + '|' + (inv.env || '') : ''].join(':');
  if (!again && key === jobQbShownFor) return;
  jobQbShownFor = key;
  const typed = box.value.trim();
  const fieldOff = inv ? (!typed || typed === String(inv.docNumber == null ? '' : inv.docNumber)) : (bid && !typed);
  const rowOff = inv ? true : (bid && !tick.checked);
  // Never hide a box while it is being typed in.
  const active = document.activeElement;
  if (!(fieldOff && field.contains(active))) field.hidden = fieldOff;
  if (!(rowOff && row.contains(active))) row.hidden = rowOff;
}
// A lost bid back on the board, in Follow up -- they called back.
function reopenBid(id) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  id = id || currentJobId;
  if (!id || !window.YDSync) return;
  if (!window.YDSync.patchJob(id, { bidStage: 'followUp', bidStageAt: new Date().toISOString(), jobStatus: 'quoting' })) {
    showToast('Could not put that bid back');
    return;
  }
  if (id === currentJobId) showBidBanner();
  showToast('Back on the Bids board, under Follow up');
  if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
}
// Booking a bid: it becomes a job -- on the Jobs board, in the job list, on
// the crew's clock -- and the bid is marked Won, the same as moving it there.
function makeItAJob(id) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  id = id || currentJobId;
  if (!id && typeof autosave === 'function') { autosave(); id = currentJobId; }
  if (!id || !window.YDSync) return;
  const at = new Date().toISOString();
  if (!window.YDSync.patchJob(id, { jobStatus: 'booked', bidStage: 'won', bidStageAt: at, workStage: 'scheduled', workStageAt: at })) {
    showToast('Could not make that a job');
    return;
  }
  if (id === currentJobId) { jobStatus = 'booked'; syncStatusSelect(); updateCtxBar(); }
  showToast('Booked — it is a job now, on the Jobs board and in your job list');
  if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
}
function updateJobHeadBadge() {
  const e = document.getElementById('estimateNumber').value.trim();
  document.getElementById('jobHeadBadge').textContent = e ? 'Est #' + e : '';
}

// ═══════════════════════════════════════════════════════════
// PROPOSAL IMPORT (canonical schema + lenient fallback)
// ═══════════════════════════════════════════════════════════
function loadProposalFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      const est = data.estimateNumber ? String(data.estimateNumber) : '';

      // De-dupe: if a proposal with this estimate # is already loaded, offer to replace it
      if (est) {
        const existing = proposals.find(p => String(p.data.estimateNumber || '') === est);
        if (existing) {
          if (confirm('Estimate #' + est + ' is already imported.\n\nOK = replace it with this file · Cancel = keep both')) {
            proposals = proposals.filter(p => p.id !== existing.id);
            orderItems = orderItems.filter(m => m.proposalId !== existing.id);
          }
        }
      }

      const propId = uid();
      const label = data.projectName || data.title || data.serviceType || ('Proposal ' + (proposals.length + 1));
      const isFirst = proposals.length === 0;
      proposals.push({ id: propId, label, data });

      let matCount = 0;
      if (Array.isArray(data.materials)) {
        data.materials.forEach(m => {
          orderItems.push({ id: uid(), proposalId: propId,
            name: typeof m === 'string' ? m : (m.name || m.item || m.description || JSON.stringify(m)),
            quantity: (m && m.quantity) ? m.quantity : '', ordered: false });
          matCount++;
        });
      }

      if (isFirst) applyClientBlock(data);
      else {
        if (data.serviceType && !serviceTypes.includes(data.serviceType)) { serviceTypes.push(data.serviceType); renderServiceTypes(); }
        const cur = document.getElementById('estimateNumber').value.trim();
        if (data.estimateNumber && cur && !cur.includes(String(data.estimateNumber))) { document.getElementById('estimateNumber').value = cur + ' / ' + data.estimateNumber; updateJobHeadBadge(); }
        else if (data.estimateNumber && !cur) { document.getElementById('estimateNumber').value = data.estimateNumber; updateJobHeadBadge(); }
      }

      syncJobPriceFromProposals();
      renderProposal(); renderOrderList(); markDirty(); updateCtxBar();
      event.target.value = '';

      // Import summary + missing-price warning
      const total = getProposalTotal(data);
      const who = (data.client && data.client.name) || data.clientName || document.getElementById('customerName').value.trim() || 'client';
      let summary = 'Imported ' + who + ' · ' + matCount + ' material' + (matCount !== 1 ? 's' : '');
      summary += total > 0 ? ' · ' + fmtMoney(total) : ' · ⚠ no price in file';
      showToast(summary);
    } catch (err) { showToast('Could not read that JSON — check the file'); console.error(err); }
  };
  reader.readAsText(file);
}

// The customer's name in parts (Jonah, 6 Oct 2026: "clients should have a
// field for a first and a last name"). customerName stays the name the rest
// of the app reads -- boards, QuickBooks, summaries: the business if there is
// one, otherwise "First Last" -- kept in step with the boxes here.
function customerNameFromParts() {
  const v = id => ((document.getElementById(id) || {}).value || '').trim();
  document.getElementById('customerName').value = v('business') || [v('firstName'), v('lastName')].filter(Boolean).join(' ');
}
function onCustomerNamePart() { customerNameFromParts(); markDirty(); updateCtxBar(); }
// Jobs saved before the boxes existed, imports and contacts turned into jobs
// carry one name: it is split into the boxes. Two or three words read as a
// person's name; anything else is a business name.
function splitName(full) {
  full = String(full || '').trim();
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 3 && !/[&\d,]|\b(llc|inc|co|company|corp|apartments?|church|school|resort|hoa|association|services?|landscaping|properties|management)\b/i.test(full)) {
    return { first: words[0], last: words.slice(1).join(' '), business: '' };
  }
  return { first: '', last: '', business: full };
}
function namePartsFromCustomer() {
  const f = document.getElementById('firstName'), l = document.getElementById('lastName'), b = document.getElementById('business');
  if (!f || f.value.trim() || l.value.trim() || b.value.trim()) return;
  const full = (document.getElementById('customerName').value || '').trim();
  if (!full) return;
  const s = splitName(full);
  f.value = s.first; l.value = s.last; b.value = s.business;
}

function applyClientBlock(data) {
  const c = data.client || {};
  const setIf = (id, val) => { const el = document.getElementById(id); if (el && val && !el.value.trim()) el.value = val; };
  setIf('customerName', c.name || data.clientName);
  namePartsFromCustomer();
  setIf('address', c.address);
  setIf('city', c.city);
  setIf('state', c.state);
  setIf('zip', c.zip);
  setIf('phone', c.phone);
  setIf('email', c.email);
  if (!c.address && data.address) {
    const parts = data.address.split(',').map(s => s.trim());
    if (parts.length && !document.getElementById('address').value.trim()) {
      document.getElementById('address').value = parts[0];
      const rest = parts.slice(1).join(',').trim();
      const m = rest.match(/^(.+?),?\s+([A-Za-z]{2})\s+(\d{5}(-\d{4})?)$/);
      if (m) {
        if (!document.getElementById('city').value.trim()) document.getElementById('city').value = m[1].trim();
        if (!document.getElementById('state').value.trim()) document.getElementById('state').value = m[2].trim();
        if (!document.getElementById('zip').value.trim())  document.getElementById('zip').value  = m[3].trim();
      } else if (rest && !document.getElementById('city').value.trim()) { document.getElementById('city').value = rest; }
    }
  }
  if (data.serviceType && !serviceTypes.length) { serviceTypes.push(data.serviceType); renderServiceTypes(); }
  if (data.estimateNumber && !document.getElementById('estimateNumber').value.trim()) { document.getElementById('estimateNumber').value = data.estimateNumber; updateJobHeadBadge(); }
  if (data.date && !document.getElementById('quoteDate').value) document.getElementById('quoteDate').value = fmtDateMD(parseMD(data.date));
}

function getProposalTotal(d) { return parseMoney(d.totalPrice || d.total || d.jobPrice || 0); }
function getCombinedProposalTotal() { return proposals.reduce((s, p) => s + getProposalTotal(p.data), 0); }
// An estimate built in Job Hub sets the price when it has lines; an imported
// proposal does otherwise.
const hasEstimate = () => !!(window.YDEstimate && window.YDEstimate.hasLines());
function syncJobPriceFromProposals() {
  if (manualJobPrice) return;
  const total = hasEstimate() ? window.YDEstimate.totalDollars() : getCombinedProposalTotal();
  if (total > 0) { baseJobPrice = total; document.getElementById('jobPrice').value = (baseJobPrice + getAdditionalCostsTotal()).toFixed(2); updateJobPriceSourceTag(); updateSummary(); }
}
function onJobPriceManualEdit() { manualJobPrice = true; baseJobPrice = parseMoney(document.getElementById('jobPrice').value) - getAdditionalCostsTotal(); updateJobPriceSourceTag(); }
function updateJobPriceSourceTag() {
  const tag = document.getElementById('jobPriceSourceTag');
  if (manualJobPrice) { tag.textContent = '(manual)'; tag.style.color = 'var(--accent-dark)'; }
  else if (proposals.length || hasEstimate()) { tag.textContent = hasEstimate() ? '(from estimate)' : '(auto)'; tag.style.color = 'var(--pos)'; }
  else tag.textContent = '';
}
function resetJobPriceToAuto() { if (!proposals.length && !hasEstimate()) return; manualJobPrice = false; syncJobPriceFromProposals(); markDirty(); }
// The price box keeps the plain number -- it is saved as typed, and every
// screen reads it through parseMoney -- so "6237.66" is never rewritten.
// While nobody is typing in it, the same figure shows OVER the box as money
// ("$6,237.66", styles.css .price-wrap); tapping it shows the number to edit.
// Only a box holding nothing but a number is dressed up: "TBD" or "6200 +
// tax" show exactly as typed. updateSummary() calls this, and every change
// to the box (typed, from the estimate, from add-ons, a job loaded) ends
// there.
function showJobPrice() {
  const box = document.getElementById('jobPrice'), wrap = document.getElementById('jobPriceWrap');
  const shown = document.getElementById('jobPriceShown');
  if (!box || !wrap || !shown) return;
  const raw = box.value.trim(), bare = raw.replace(/[$,\s]/g, '');
  const isNumber = /^-?(\d+(\.\d*)?|\.\d+)$/.test(bare);
  const text = isNumber ? fmtMoney(parseFloat(bare)) : '';
  shown.textContent = text;
  wrap.classList.toggle('formatted', isNumber && text !== raw);
}
function removeProposal(propId) {
  if (!confirm('Remove this proposal? Its imported order items will also be removed.')) return;
  proposals = proposals.filter(p => p.id !== propId);
  orderItems = orderItems.filter(m => m.proposalId !== propId);
  syncJobPriceFromProposals(); renderProposal(); renderOrderList(); markDirty();
}
function editProposalLabel(propId) {
  const p = proposals.find(p => p.id === propId); if (!p) return;
  const nl = prompt('Edit proposal label:', p.label);
  if (nl && nl.trim()) { p.label = nl.trim(); renderProposal(); markDirty(); }
}
function renderProposal() {
  const content = document.getElementById('proposalContent');
  const status = document.getElementById('proposalStatus');
  // A job estimated in Job Hub has no use for the old proposal import: the
  // box goes, and Materials to Order takes the whole width.
  const sec = content.closest('.section'), pair = sec && sec.parentElement;
  const unused = !proposals.length && hasEstimate();
  if (sec) sec.hidden = unused;
  if (pair) pair.classList.toggle('single', unused);
  if (!proposals.length) {
    content.innerHTML = '<div class="upload-zone" onclick="document.getElementById(\'proposalFileInput\').click()">' +
      '<div class="uz-icon">📄</div><div class="uz-text">Import Proposal JSON</div>' +
      '<div class="uz-sub">Loads client info, price, and the material list</div></div>';
    status.textContent = ''; updateJobPriceSourceTag(); return;
  }
  let html = '';
  proposals.forEach(p => {
    const d = p.data, total = getProposalTotal(d);
    const cnt = orderItems.filter(m => m.proposalId === p.id).length;
    html += '<div class="prop-card"><div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><strong style="font-size:15px">' + esc(p.label) + '</strong>' +
        '<button class="dup-btn" onclick="editProposalLabel(\'' + p.id + '\')">EDIT</button></div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:4px">' + (total > 0 ? '<strong>' + fmtMoney(total) + '</strong>' : 'No total') +
        ' · ' + cnt + ' material' + (cnt !== 1 ? 's' : '') + '</div></div>' +
      '<button class="btn btn-sm btn-danger" onclick="removeProposal(\'' + p.id + '\')">Remove</button></div>';
  });
  html += '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
    '<button class="btn btn-filled btn-sm" onclick="document.getElementById(\'proposalFileInput\').click()">+ Add Another</button>' +
    (manualJobPrice ? '<button class="btn btn-sm" onclick="resetJobPriceToAuto()">↺ Job Price to Auto</button>' : '') + '</div>';
  content.innerHTML = html;
  status.textContent = proposals.length + ' proposal' + (proposals.length > 1 ? 's' : '');
  updateJobPriceSourceTag();
}

// ═══════════════════════════════════════════════════════════
// MATERIALS TO ORDER (checklist + progress)
// ═══════════════════════════════════════════════════════════
function addOrderItem() {
  const name = document.getElementById('orderItemName').value.trim();
  if (!name) return;
  orderItems.push({ id: uid(), proposalId: null, name, quantity: document.getElementById('orderItemQty').value.trim(), ordered: false });
  document.getElementById('orderItemName').value = ''; document.getElementById('orderItemQty').value = '';
  renderOrderList(); markDirty();
}
function toggleOrderItem(id) { const it = orderItems.find(m => m.id === id); if (it) { it.ordered = !it.ordered; renderOrderList(); markDirty(); } }
function rmOrderItem(id) {
  const at = orderItems.findIndex(m => m.id === id), row = orderItems[at];
  orderItems = orderItems.filter(m => m.id !== id); renderOrderList(); markDirty();
  offerPutBack('“' + ((row && row.name) || 'Item') + '” taken off the order', row, at, () => orderItems, renderOrderList);
}
// A row taken off one of the job's lists (Tracking, Materials to Order), with
// Undo on the toast: it goes back where it was, as it was. Only onto the same
// job -- another job opened since has rows of its own. `list` reads the list
// as it is at the time (each list is replaced, not changed, when a row goes or
// a job is loaded), so a new job not saved yet counts as the same while its
// list is the one the row came off.
function offerPutBack(msg, row, at, list, redraw) {
  if (!row) return;
  const job = currentJobId, after = list();
  const putBack = () => {
    if (jobsReadOnly()) return;
    const same = job ? currentJobId === job : list() === after;
    if (!same) { showToast('Another job is open — nothing put back'); return; }
    const now = list();
    if (now.some(x => x.id === row.id)) return;
    now.splice(Math.min(at, now.length), 0, row);
    redraw(); markDirty();
  };
  if (typeof showUndo === 'function') showUndo(msg, putBack); else showToast(msg);
}

// ── From the estimate ──
// A bid becoming a job brings its estimate's takeoff onto Materials to Order
// -- what to buy, how much of it, from whom -- so nothing is typed twice.
// Lines that came from the estimate (fromEstimate) follow it while they are
// not yet ordered; anything added by hand is never touched.
function orderFields(l) {
  return { name: l.name, quantity: window.YDPricing.qtyText(l.orderQty, l.per), qty: l.orderQty, per: l.per || '',
           supplyId: l.supplyId || null, vendorId: l.vendorId || null, specialOrder: !!l.specialOrder };
}
function orderFromEstimate(list, lines) {
  const keyOf = x => x.supplyId ? 's:' + x.supplyId : 'n:' + String(x.name || '').toLowerCase().trim();
  const want = {};
  lines.forEach(l => { want[keyOf(l)] = l; });
  const seen = {}, out = [];
  list.forEach(it => {
    if (!it.fromEstimate) { out.push(it); return; }
    const k = keyOf(it);
    if (it.ordered) { out.push(it); seen[k] = 1; return; }   // bought already: left as it was
    if (!want[k]) return;                                    // no longer on the estimate
    seen[k] = 1;
    out.push(Object.assign({}, it, orderFields(want[k])));
  });
  lines.forEach(l => {
    if (!seen[keyOf(l)]) out.push(Object.assign({ id: uid(), proposalId: null, ordered: false, fromEstimate: true }, orderFields(l)));
  });
  return out;
}
// Order quantities need the pricing rules (waste) and Supplies (what one of
// a thing covers, what it is sold by). Booked straight after the app opens,
// before they have arrived, the list would come out in takeoff units -- so it
// waits for them (orderPending), and fills when they come.
// With no signal the copy on this device is the best there is, and waiting
// for the server would mean waiting for ever.
function orderReady() {
  const c = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : null;
  return !!(window.YDPricing && window.YDPricing.ready() && c && Object.keys(c.items).length &&
    (c.pricesReady || !navigator.onLine || !(typeof ydCan === 'function' && ydCan('supplies', 'see'))));
}
// Kept on the device: a bid booked from the board in the first seconds and
// the app then closed still gets its order list next time (review, 7 Oct).
const ORDER_PENDING_KEY = 'ydjobhub_orderPending';
const orderPending = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(ORDER_PENDING_KEY) || '[]')); }
  catch (e) { return new Set(); }
})();
function saveOrderPending() {
  try {
    if (orderPending.size) localStorage.setItem(ORDER_PENDING_KEY, JSON.stringify([...orderPending]));
    else localStorage.removeItem(ORDER_PENDING_KEY);
  } catch (e) { /* full storage: it waits in memory instead */ }
}
function waitForOrder(id) { orderPending.add(id); saveOrderPending(); }
function fillPendingOrders() {
  if (!orderPending.size || !orderReady() || !window.YDEstimate) return;
  const ids = [...orderPending];
  orderPending.clear(); saveOrderPending();
  ids.forEach(id => {
    let d = null;
    try { d = JSON.parse(readJobBlob(id) || 'null'); } catch (e) {}
    if (!d || isBidStatus(d.jobStatus)) return;
    if (id === currentJobId) {
      if (!orderItems.some(it => it.fromEstimate)) fillOrderFromEstimate(true);
      return;
    }
    if ((d.orderItems || []).some(it => it.fromEstimate)) return;
    const lines = window.YDEstimate.orderLines(d.estimate || null, d.city || '');
    if (lines.length && window.YDSync) window.YDSync.patchJob(id, { orderItems: orderFromEstimate(d.orderItems || [], lines) });
  });
}
document.addEventListener('yd-supplies', fillPendingOrders);
document.addEventListener('yd-pricing', fillPendingOrders);

function fillOrderFromEstimate(quiet) {
  if (jobsReadOnly() || !window.YDEstimate || !window.YDPricing) return;
  if (!orderReady()) {
    if (quiet && currentJobId) waitForOrder(currentJobId);
    else showToast('Prices are still loading — try again in a moment');
    return;
  }
  const lines = window.YDEstimate.orderLines();
  if (!lines.length) { if (!quiet) showToast('The estimate has no materials yet'); return; }
  orderItems = orderFromEstimate(orderItems, lines);
  renderOrderList(); markDirty();
  if (!quiet) showToast('Materials to Order now matches the estimate');
}
// sync.js patchJob asks this when a bid is booked from anywhere -- the Bids
// board, "Make it a job", QuickBooks saying the customer accepted. Only the
// first time: after that the list is Jonah's, and the button brings it up to
// date with the estimate when he wants.
function bookedOrderItems(id, data) {
  if (!window.YDEstimate || !window.YDPricing) return null;
  if (!orderReady()) { waitForOrder(id); return null; }
  const open = id === currentJobId;
  const list = open ? orderItems : (data.orderItems || []);
  if (list.some(it => it.fromEstimate)) return null;
  const lines = open ? window.YDEstimate.orderLines() : window.YDEstimate.orderLines(data.estimate || null, data.city || '');
  if (!lines.length) return null;
  const out = orderFromEstimate(list, lines);
  if (open) { orderItems = out; renderOrderList(); }
  return out;
}

// A job brought in from QuickBooks (quickbooks.py) carries its estimate's
// lines, the materials by name as they were written there. On the owner's
// device, once Supplies are here, each material is joined to the Supplies
// item it clearly names (estimate.js linkFromQb) and Materials to Order is
// filled from the list -- once (estimate.fromQb.linkedAt), through patchJob
// like a move on the board. One open with typing in it waits for the next
// look, so nothing typed is lost.
const qbFilling = new Set(), qbWaiting = new Set();
let qbScanned = false;
function fillFromQb(id, data) {
  const e = data && data.estimate;
  if (!e || !e.fromQb || e.fromQb.linkedAt || qbFilling.has(id)) return;
  if (!window.YDAuth || !window.YDAuth.isOwner || !ydCan('jobs', 'change') || !window.YDEstimate || !window.YDEstimate.linkFromQb) return;
  if (!orderReady() || (id === currentJobId && dirty)) { qbWaiting.add(id); return; }
  qbFilling.add(id);
  setTimeout(() => {
    try {
      const linked = window.YDEstimate.linkFromQb(e);
      if (!linked) return;
      const patch = { estimate: linked };
      if (!(data.orderItems || []).length && !isBidStatus(data.jobStatus)) {
        const lines = window.YDEstimate.orderLines(linked, data.city || '');
        if (lines.length) patch.orderItems = orderFromEstimate([], lines);
      }
      if (window.YDSync) window.YDSync.patchJob(id, patch);
    } finally { qbFilling.delete(id); }
  }, 0);
}
// Supplies arriving (or a form saved) lets the ones waiting go; the first
// time, every job on this device is looked at -- one brought in while the
// app was closed came with the first download, before Supplies.
function fillWaitingFromQb() {
  if (!orderReady()) return;
  const ids = qbScanned ? [...qbWaiting] : getJobIndex().map(j => j.id);
  qbScanned = true;
  qbWaiting.clear();
  ids.forEach(id => {
    let d = null;
    try { d = JSON.parse(readJobBlob(id) || 'null'); } catch (e) {}
    if (d) fillFromQb(id, d);
  });
}
document.addEventListener('yd-supplies', fillWaitingFromQb);
document.addEventListener('yd-pricing', fillWaitingFromQb);

// ── What it costs (owner, and admins with Supplies) ──
// From the Supplies price list: an item from the estimate knows its supply; a
// line typed by hand is matched by its name, or linked by hand. Last year's
// price is used, and says so. Never counted in the job's numbers -- it is the
// cost of the order, to check against the receipts.
let linkingOrder = null;     // the order line whose supply is being picked
// Names from an imported proposal carry notes -- "Screened Topsoil (1") --
// finish grading -- 1,235 sq ft" -- so the name is also tried without what
// follows a dash and without anything in brackets. Exact matches only: a
// near miss would price the wrong thing.
function orderSupply(it, cat) {
  if (it.supplyId) return cat.items[it.supplyId] ? it.supplyId : null;
  const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const full = String(it.name || '');
  const short = full.split(/\s[—–-]\s/)[0].replace(/\([^)]*\)/g, ' ');
  const want = [key(full), key(short)].filter(Boolean);
  if (!want.length) return null;
  if (!cat._byKey || cat._byKey.n !== Object.keys(cat.items).length) {
    // The supplies by name, built once per catalogue rather than once per line.
    const m = {};
    Object.keys(cat.items).forEach(id => { const k = key(cat.items[id].name); if (k && !m[k]) m[k] = id; });
    cat._byKey = { n: Object.keys(cat.items).length, map: m };
  }
  for (const k of want) if (cat._byKey.map[k]) return cat._byKey.map[k];
  return null;
}
function orderQtyOf(it) {
  if (typeof it.qty === 'number' && isFinite(it.qty)) return it.qty;
  const m = String(it.quantity || '').replace(/,/g, '').match(/\d+(\.\d+)?|\.\d+/);
  return m ? parseFloat(m[0]) : null;
}
function orderCost(it, cat) {
  const sid = orderSupply(it, cat);
  const pr = sid ? cat.prices[sid] : null;
  if (!pr || typeof pr.cents !== 'number') return { sid: sid, cents: null };
  const q = orderQtyOf(it);
  const per = String(pr.per || cat.items[sid].unit || '').trim();
  // A unit typed by hand that is not the one the price is per ("2 pallets"
  // of something priced by the sq ft) would make a wrong number: say so.
  // Word by word, plurals and full stops aside: "approx. 1.10 tons" is in tons.
  const words = s => ' ' + String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')
    .map(w => /(x|ch|sh|ss)es$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) ? w.slice(0, -1) : w).join(' ') + ' ';
  const typed = words(it.quantity);
  const unitOff = !it.fromEstimate && typed.trim() !== '' && per !== '' && typed.indexOf(words(per)) === -1;
  return { sid: sid, each: pr.cents, per: per, year: pr.year || null, unitOff: unitOff,
           cents: q === null || unitOff ? null : Math.round(q * pr.cents) };
}
function linkOrderItem(id, sid) {
  const it = orderItems.find(m => m.id === id);
  linkingOrder = null;
  if (it && sid) { it.supplyId = sid; markDirty(); }
  renderOrderList();
}
// One supplier's part of the order as text, to paste into an email or a text.
function supplierOrder(vid) {
  const cat = window.YDSupplies ? window.YDSupplies.catalog() : { items: {}, vendors: {} };
  const lines = orderItems.filter(it => !it.ordered && orderVendor(it, cat) === vid)
    .map(it => (it.quantity ? it.quantity + ' — ' : '') + it.name + (it.specialOrder ? ' (special order)' : ''));
  const v = (cat.vendors || {})[vid] || {};
  const f = id => ((document.getElementById(id) || {}).value || '').trim();
  const where = [f('address'), [f('city'), f('state')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
  return { lines: lines, vendor: v, where: where };
}
function copySupplierOrder(vid) {
  const o = supplierOrder(vid);
  if (!o.lines.length) { showToast('Nothing left to order there'); return; }
  const text = 'Order' + (o.vendor.name ? ' for ' + o.vendor.name : '') + (o.where ? ' — job at ' + o.where : '') + '\n' + o.lines.join('\n');
  const done = () => showToast('Copied — paste it into an email or a text');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => prompt('Copy this:', text));
  else prompt('Copy this:', text);
}
// The order as an email to the supplier's order address (Supplies → Edit
// supplier), opened in the phone's or computer's mail app to read and send.
// Plain code: nothing for Claude to do here.
function emailSupplierOrder(vid) {
  const o = supplierOrder(vid);
  if (!o.lines.length) { showToast('Nothing left to order there'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.vendor.email || '')) { showToast('Add their order email first: Supplies → the supplier → Edit supplier'); return; }
  const subject = 'Order' + (o.where ? ' — ' + o.where : '') + ' — YD Exterior Visions';
  const body = 'Hi,\n\nI’d like to order the following' + (o.where ? ' for a job at ' + o.where : '') + ':\n\n' +
    o.lines.map(l => '• ' + l).join('\n') + '\n\nPlease let me know the total and when it can be ' +
    'delivered or picked up.\n\nThanks,\nJonah\nYD Exterior Visions';
  location.href = 'mailto:' + encodeURIComponent(o.vendor.email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}
function orderVendor(it, cat) {
  if (it.vendorId) return it.vendorId;
  const sid = orderSupply(it, cat);
  return sid ? cat.items[sid].vendorId || '' : '';
}

function renderOrderList() {
  const wrap = document.getElementById('orderListWrap');
  const prog = document.getElementById('orderProgress');
  const fromEst = document.getElementById('orderFromEstimate');
  const estHasMats = !!(window.YDEstimate && window.YDEstimate.hasMaterials && window.YDEstimate.hasMaterials());
  if (fromEst) {
    fromEst.hidden = !estHasMats || jobsReadOnly();
    fromEst.textContent = orderItems.some(it => it.fromEstimate) ? '↻ Update from the estimate' : '⬇ Fill from the estimate';
  }
  if (!orderItems.length) {
    wrap.innerHTML = '<p class="empty-msg">' + (estHasMats ? 'Nothing yet — fills from the estimate when the bid is booked, or press “Fill from the estimate”.'
      : 'No items yet — import a proposal or add manually.') + '</p>';
    prog.innerHTML = ''; document.getElementById('orderBadge').textContent = ''; return;
  }
  const ordered = orderItems.filter(m => m.ordered).length, total = orderItems.length;
  const pct = Math.round(ordered / total * 100);
  prog.innerHTML = '<div class="progress-label"><span>Ordered</span><span>' + ordered + ' / ' + total + '</span></div>' +
    '<div class="progress"><div class="progress-fill" style="width:' + pct + '%"></div></div>';

  const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {}, prices: {}, vendors: {} };
  const prices = typeof ydCan === 'function' && ydCan('supplies', 'see') && Object.keys(cat.items).length > 0;
  const thisYear = new Date().getFullYear();
  let sum = 0, unpriced = 0;
  const row = it => {
    const c = prices ? orderCost(it, cat) : null;
    if (c && !it.ordered) { if (c.cents !== null) sum += c.cents; else unpriced++; }
    const costLine = !c ? '' : c.cents !== null
      ? '<span class="cr-cost">' + fmtMoney(c.each / 100) + '/' + esc(c.per || 'each') + ' = <b>' + fmtMoney(c.cents / 100) + '</b>' +
        (c.year && c.year < thisYear ? ' <span class="warn-text">' + esc(c.year) + ' price</span>' : '') + '</span>'
      : c.unitOff ? '<span class="cr-cost warn-text">priced per ' + esc(c.per) + ' — check the quantity</span>'
      : c.sid ? '<span class="cr-cost muted">no price in Supplies</span>'
      : linkingOrder === it.id ? ''
      : '<span class="cr-cost"><button class="link-btn" onclick="linkingOrder=\'' + it.id + '\'; renderOrderList()">no price — link to Supplies</button></span>';
    const picker = linkingOrder === it.id
      ? '<div class="cr-link"><select class="searchable" onchange="linkOrderItem(\'' + it.id + '\', this.value)"><option value="">Which supply is it?</option>' +
          Object.values(cat.items).sort((a, b) => String(a.name).localeCompare(String(b.name)))
            .map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('') +
        '</select> <button class="link-btn" onclick="linkingOrder=null; renderOrderList()">Cancel</button></div>' : '';
    // The product's own page, from Supplies, for what is ordered online.
    const sid = !it.ordered ? orderSupply(it, cat) : null;
    const page = sid && window.YDSupplies && window.YDSupplies.websiteUrl ? window.YDSupplies.websiteUrl({ website: cat.items[sid].link }) : '';
    return '<div class="check-row' + (it.ordered ? ' done' : '') + '">' +
      '<input type="checkbox"' + (it.ordered ? ' checked' : '') + ' onchange="toggleOrderItem(\'' + it.id + '\')">' +
      '<span class="cr-name">' + esc(it.name) +
        (it.specialOrder ? ' <span class="cr-special">special order</span>' : '') +
        (page ? ' <a class="link-btn" href="' + esc(page) + '" target="_blank" rel="noopener">🔗 order page</a>' : '') +
        // Ticked by a receipt sorted onto this job: which order it was.
        (it.ordered && it.orderNo ? ' <span class="muted">· ' + esc(it.orderedFrom || '') + ' #' + esc(it.orderNo) + '</span>' : '') +
        (costLine ? '<br>' + costLine : '') + picker +
      '</span>' +
      (it.quantity ? '<span class="cr-qty">' + esc(String(it.quantity)) + '</span>' : '') +
      '<button class="remove-btn" onclick="rmOrderItem(\'' + it.id + '\')">×</button></div>';
  };

  // By supplier, so each call or email covers one place.
  const groups = {};
  orderItems.forEach(it => { const v = orderVendor(it, cat); (groups[v] = groups[v] || []).push(it); });
  const vname = v => v ? ((cat.vendors[v] || {}).name || 'Supplier') : '';
  const keys = Object.keys(groups).sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || vname(a).localeCompare(vname(b)));
  const grouped = keys.length > 1 || keys[0] !== '';
  // A supplier ordered from online: its site, and how long it takes to come.
  const siteOf = v => (window.YDSupplies && window.YDSupplies.websiteUrl ? window.YDSupplies.websiteUrl(cat.vendors[v]) : '');
  wrap.innerHTML = keys.map(v => {
    const list = groups[v];
    const left = list.filter(it => !it.ordered).length;
    const lead = v ? (cat.vendors[v] || {}).leadTime : '';
    return (grouped ? '<div class="order-vendor"><b>' + esc(v ? vname(v) : 'Other') + '</b>' +
        '<span class="muted">' + left + ' to order' + (lead && left ? ' · takes ' + esc(lead) : '') + '</span>' +
        (v && left ? '<button class="link-btn" onclick="copySupplierOrder(\'' + esc(v) + '\')">📋 Copy the order</button>' +
          ((cat.vendors[v] || {}).email ? '<button class="link-btn" onclick="emailSupplierOrder(\'' + esc(v) + '\')">✉️ Email the order</button>' : '') +
          (siteOf(v) ? '<a class="link-btn" href="' + esc(siteOf(v)) + '" target="_blank" rel="noopener">🌐 Their website</a>' : '') : '') +
        '</div>' : '') +
      list.map(row).join('');
  }).join('') +
    (prices && (sum || unpriced) ? '<div class="order-cost">Still to order comes to about <b>' + fmtMoney(sum / 100) + '</b> before tax' +
      (unpriced ? ' · ' + unpriced + ' line' + (unpriced === 1 ? '' : 's') + ' without a price' : '') +
      '<div class="muted">Your cost from Supplies — only you see this, and it isn’t in the job’s numbers.</div></div>' : '');
  wrap.querySelectorAll('select.searchable').forEach(s => { if (typeof makeSearchable === 'function') makeSearchable(s); });
  document.getElementById('orderBadge').textContent = ordered + '/' + total + ' ordered';
}

// ═══════════════════════════════════════════════════════════
// LABOR  (worker · hours · minutes — total per worker, no date)
// ═══════════════════════════════════════════════════════════
// The Tracking forms (labour, purchases, extra costs, payments) are folded
// behind their "+ Add ..." buttons: all four always open made the screen
// nearly 6,000px tall on a phone, the figures lost between them. Opened, a
// form takes the button's place and the cursor goes into its first box; it
// stays open after each entry for the next one, until Close or Esc. What
// was typed in a closed form waits there for the next time it is opened.
function addFormParts(id) {
  const area = document.getElementById(id);
  const opener = area ? document.getElementById(area.dataset.opener) : null;
  return { area: area, opener: opener, row: opener ? opener.closest('.add-open-row') : null };
}
function openAddForm(id) {
  const p = addFormParts(id);
  if (!p.area) return;
  p.area.hidden = false;
  if (p.row) p.row.hidden = true;
  if (p.opener) p.opener.setAttribute('aria-expanded', 'true');
  const first = document.getElementById(p.area.dataset.first);
  if (first) first.focus();
}
function closeAddForm(id) {
  const p = addFormParts(id);
  if (!p.area || p.area.hidden) return;
  const hadFocus = p.area.contains(document.activeElement);
  p.area.hidden = true;
  if (p.row) p.row.hidden = false;
  if (p.opener) {
    p.opener.setAttribute('aria-expanded', 'false');
    // Back to the button it came from, so the keyboard does not lose its place.
    if (hadFocus) p.opener.focus();
  }
}
// Esc inside an open form folds it. Heard before the app-wide Escape (which
// closes the window or menu in front): with one of those open, Esc is theirs.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
  const area = e.target && e.target.closest ? e.target.closest('.add-area[data-opener]') : null;
  if (!area || area.hidden) return;
  const menu = document.getElementById('headerMenu');
  if ((menu && !menu.hidden) || topOverlay()) return;
  e.preventDefault();
  closeAddForm(area.id);
}, true);

// Job Financials keeps its quick figures; where Estimate vs actual is on the
// same screen (jobcosts.js shows it to whoever may see it), one line says
// the fuller comparison is below it. It follows that section's hidden flag.
function goToEva() {
  const s = document.getElementById('evaSection');
  // A jump rather than a glide: it lands the same in every browser, and the
  // section is straight below.
  if (s && !s.hidden) s.scrollIntoView({ block: 'start' });
}
(function followEva() {
  const sec = document.getElementById('evaSection'), ptr = document.getElementById('finEvaPointer');
  if (!sec || !ptr) return;
  const sync = () => { ptr.hidden = sec.hidden; };
  if (window.MutationObserver) new MutationObserver(sync).observe(sec, { attributes: true, attributeFilter: ['hidden'] });
  sync();
})();

// How many distinct people worked this job, counting both the rows typed in
// by hand and the crew who clocked into it.
function laborWorkerCount() {
  const names = {};
  labor.forEach(e => { if (e.worker) names[e.worker.trim().toLowerCase()] = 1; });
  Object.keys(clockedLabor().byWorker).forEach(n => { names[n.trim().toLowerCase()] = 1; });
  return Object.keys(names).length || labor.length;
}

// The old caption read "8.0 hrs x $25", which stops being true the moment any
// of those hours came from a clocked shift approved at a different rate.
function laborCostSub(totalHrs) {
  const c = clockedLabor();
  if (!c.paidHours) return totalHrs.toFixed(1) + ' hrs × $' + LABOR_RATE;
  if (!manualLaborHours()) return totalHrs.toFixed(1) + ' hrs from the clock';
  return totalHrs.toFixed(1) + ' hrs · ' + c.paidHours.toFixed(1) + ' from the clock';
}

// Hours the crew clocked into this job, shown above the hand-entered rows.
// Pending shifts appear here too, marked, so they are not invisible while they
// wait -- but they are not in any total that touches money.
function clockedLaborHtml() {
  const c = clockedLabor();
  const names = Object.keys(c.byWorker);
  if (!names.length && !c.pendingHours) return '';

  // Shifts from before last year are loaded on demand (timeclock.js): says
  // so while they are, or if they could not be read.
  const older = window.YDClock && YDClock.oldLabourNote ? YDClock.oldLabourNote() : '';
  let h = '<div class="clocked-block"><div class="clocked-head">From the time clock</div>' + (older || '');
  if (names.length) {
    h += '<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Paid</th><th>Billable</th></tr></thead><tbody>';
    names.sort().forEach(n => {
      const w = c.byWorker[n];
      h += '<tr><td class="bold">' + esc(n) + '</td><td>' + fmtHrsMin(w.paid) +
           '</td><td>' + fmtHrsMin(w.billable) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="clocked-note">Billable leaves out paused time — fuel, salt, driving. ' +
         'Paid is what the work cost you: ' + fmtMoney(c.costCents / 100) + '.</div>';
  }
  if (c.pendingHours) {
    h += '<div class="clocked-pending">' + fmtHrsMin(c.pendingHours) +
         ' waiting for your approval on the Clock tab. Not counted above.</div>';
  }
  return h + '</div>';
}

function renderLabor() {
  const w = document.getElementById('laborTableWrap');
  const clocked = clockedLaborHtml();
  if (!labor.length) {
    w.innerHTML = clocked +
      '<p class="empty-msg">' + (clocked ? 'No hand-entered hours.' : 'No workers logged yet.') + '</p>';
  }
  else {
    let h = '<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Time</th><th></th></tr></thead><tbody>';
    labor.forEach(e => {
      h += '<tr><td class="bold">' + esc(e.worker || '') + '</td><td>' + fmtHrsMin(entryHours(e)) + '</td>' +
        '<td><button class="remove-btn" onclick="rmLabor(\'' + e.id + '\')">×</button></td></tr>';
    });
    const totH = labor.reduce((s, e) => s + entryHours(e), 0);
    h += '</tbody><tfoot><tr style="font-weight:700"><td style="text-align:right">Total:</td><td>' + fmtHrsMin(totH) + '</td><td></td></tr></tfoot></table></div>';
    w.innerHTML = clocked + h;
  }
  updateBadges(); updateSummary();
}
function addLabor() {
  const worker = document.getElementById('labWorker').value.trim();
  const hours = document.getElementById('labHours').value;
  const minutes = document.getElementById('labMinutes').value;
  if (!worker && !hours && !minutes) return;
  labor.push({ id: uid(), worker, hours, minutes });
  ['labWorker','labHours','labMinutes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('labWorker').focus();
  renderLabor(); markDirty();
}
function rmLabor(id) {
  const at = labor.findIndex(e => e.id === id), row = labor[at];
  labor = labor.filter(e => e.id !== id); renderLabor(); markDirty();
  offerPutBack('Hours for ' + ((row && row.worker) || 'that worker') + ' removed', row, at, () => labor, renderLabor);
}

// ═══════════════════════════════════════════════════════════
// MATERIALS / PURCHASES
// ═══════════════════════════════════════════════════════════
function isChangeOrder(itemName) {
  if (!orderItems.length) return false;
  const lower = (itemName || '').toLowerCase().trim();
  return !orderItems.some(qm => { const q = (qm.name || '').toLowerCase().trim(); return q && (q.includes(lower) || lower.includes(q) || sameMaterial(q, lower)); });
}
// Whether two names are the same material written two ways: most of the
// first's words (3+ letters) are in the second, plurals included -- "Holland
// pavers charcoal" is "Holland paver 6x9 charcoal". A receipt's wording never
// matches the quote's exactly, and it was flagging bought items "not quoted?".
function sameMaterial(a, b) {
  const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 3);
  const want = words(a), have = words(b);
  if (!want.length || !have.length) return false;
  const hits = want.filter(w => have.some(h => h === w || h.startsWith(w) || w.startsWith(h))).length;
  return hits / want.length >= 0.6;
}
function renderMaterials() {
  const w = document.getElementById('matTableWrap');
  if (!materials.length) { w.innerHTML = '<p class="empty-msg">No purchases yet.</p>'; }
  else {
    let h = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Item</th><th>Qty</th><th>From</th><th>Price</th><th></th></tr></thead><tbody>';
    materials.forEach(e => {
      const co = isChangeOrder(e.item);
      // Lines that came from a receipt carry its details: the supplier's item
      // number, the unit price, and a way back to the email.
      const mail = /^https:\/\/mail\.google\.com\//.test(String(e.link || '')) ? e.link : '';
      h += '<tr' + (co ? ' class="row-unquoted"' : '') + '><td>' + fmtDateMD(e.date) + '</td>' +
        '<td class="bold">' + esc(e.item) + (co ? '<span class="change-tag" title="Advisory — this purchase didn\'t match a quoted item. Verify before treating as a change order.">not quoted?</span>' : '') +
          (e.itemNo ? ' <span class="muted mat-itemno">#' + esc(e.itemNo) + '</span>' : '') + '</td>' +
        '<td>' + (e.qty ? esc(String(e.qty)) + (e.unit ? ' ' + esc(e.unit) : '') : '—') +
          (e.unitPrice ? ' <span class="muted">@ ' + fmtMoney(e.unitPrice) + '</span>' : '') + '</td>' +
        '<td>' + esc(e.location || '—') +
          (mail ? ' <a class="mat-mail" href="' + esc(mail) + '" target="_blank" rel="noopener" title="Open the receipt email">✉️</a>' : '') + '</td>' +
        '<td class="bold">' + (e.price ? fmtMoney(e.price) : '—') + '</td>' +
        '<td><button class="remove-btn" onclick="rmMaterial(\'' + e.id + '\')">×</button></td></tr>';
    });
    h += '</tbody></table></div>';
    w.innerHTML = h;
  }
  updateBadges(); updateSummary();
}
function addMaterial() {
  const item = document.getElementById('matItem').value.trim();
  if (!item) return;
  materials.push({ id: uid(), item, date: readMD('matDate'),
    location: document.getElementById('matLoc').value.trim(),
    price: document.getElementById('matPrice').value,
    qty: document.getElementById('matQty').value, unit: document.getElementById('matUnit').value });
  ['matItem','matLoc','matPrice','matQty'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('matUnit').value = ''; document.getElementById('matDate').value = todayMD();
  renderMaterials(); markDirty();
}
function rmMaterial(id) {
  const at = materials.findIndex(e => e.id === id), row = materials[at];
  // A line put here from a receipt: the receipt keeps saying it went on this
  // job (receipts.js), and only its own Undo takes it back off both -- so
  // taking just the line off here is asked about first.
  if (row && row.receiptId && !confirm('“' + (row.item || 'This line') + '” came from a receipt' +
      (row.location ? ' (' + row.location + ')' : '') + '. Taken off here, the receipt still says it went on this job — ' +
      'to take the receipt off the job, use Undo on it under Receipts.\n\nTake just this line off?')) return;
  materials = materials.filter(e => e.id !== id); renderMaterials(); markDirty();
  offerPutBack('“' + ((row && row.item) || 'Purchase') + '” removed', row, at, () => materials, renderMaterials);
}

// ═══════════════════════════════════════════════════════════
// ADDITIONAL COSTS  (now with From / Vendor)
// ═══════════════════════════════════════════════════════════
function renderAdditionalCosts() {
  const w = document.getElementById('addCostTableWrap');
  if (!additionalCosts.length) { w.innerHTML = '<p class="empty-msg">No additional costs yet.</p>'; }
  else {
    let h = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>From</th><th>Mat</th><th>Labor</th><th>Total</th><th></th></tr></thead><tbody>';
    let matSum = 0, labSum = 0;
    additionalCosts.forEach(e => {
      const mat = parseFloat(e.materialCost) || 0, lab = parseFloat(e.laborCost) || 0;
      matSum += mat; labSum += lab;
      h += '<tr><td>' + fmtDateMD(e.date) + '</td><td class="bold">' + esc(e.name || '') + '</td>' +
        '<td>' + esc(e.from || '—') + '</td>' +
        '<td>' + (mat ? fmtMoney(mat) : '—') + '</td><td>' + (lab ? fmtMoney(lab) : '—') + '</td>' +
        '<td class="bold">' + fmtMoney(mat + lab) + '</td>' +
        '<td><button class="remove-btn" onclick="rmAdditionalCost(\'' + e.id + '\')">×</button></td></tr>';
    });
    h += '</tbody><tfoot><tr style="font-weight:700"><td colspan="3" style="text-align:right">Totals:</td>' +
      '<td>' + fmtMoney(matSum) + '</td><td>' + fmtMoney(labSum) + '</td><td>' + fmtMoney(matSum + labSum) + '</td><td></td></tr></tfoot></table></div>';
    w.innerHTML = h;
  }
  syncJobPriceWithAdditionalCosts(); updateBadges(); updateSummary();
}
function addAdditionalCost() {
  const name = document.getElementById('addCostName').value.trim();
  if (!name) return;
  additionalCosts.push({ id: uid(), date: readMD('addCostDate'), name,
    from: document.getElementById('addCostFrom').value.trim(),
    materialCost: document.getElementById('addCostMaterial').value,
    laborCost: document.getElementById('addCostLabor').value,
    notes: document.getElementById('addCostNotes').value.trim() });
  ['addCostName','addCostFrom','addCostMaterial','addCostLabor','addCostNotes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('addCostDate').value = todayMD();
  renderAdditionalCosts(); markDirty();
}
function rmAdditionalCost(id) {
  const at = additionalCosts.findIndex(e => e.id === id), row = additionalCosts[at];
  additionalCosts = additionalCosts.filter(e => e.id !== id); renderAdditionalCosts(); markDirty();
  offerPutBack('“' + ((row && row.name) || 'Add-on') + '” removed', row, at, () => additionalCosts, renderAdditionalCosts);
}
function getAdditionalCostsTotal() { return additionalCosts.reduce((s, e) => s + (parseFloat(e.materialCost) || 0) + (parseFloat(e.laborCost) || 0), 0); }
function syncJobPriceWithAdditionalCosts() {
  const newTotal = (parseFloat(baseJobPrice) || 0) + getAdditionalCostsTotal();
  const el = document.getElementById('jobPrice');
  const newStr = newTotal > 0 ? newTotal.toFixed(2) : '';
  if (el.value !== newStr) { el.value = newStr; updateJobPriceSourceTag(); }
}

// ═══════════════════════════════════════════════════════════
// PAYMENTS RECEIVED
// ═══════════════════════════════════════════════════════════
function renderPayments() {
  const w = document.getElementById('paymentsTableWrap');
  const jobPrice = parseMoney(document.getElementById('jobPrice').value);
  const taxable = document.getElementById('taxable').checked;
  const tax = taxable ? round2(jobPrice * 0.055) : 0;
  const invoiceTotal = round2(jobPrice + tax);
  if (!payments.length) { w.innerHTML = '<p class="empty-msg">No payments logged yet.</p>'; }
  else {
    let h = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Label</th><th>Amount</th><th>Notes</th><th></th></tr></thead><tbody>';
    let recv = 0;
    payments.forEach(p => {
      const amt = parseFloat(p.amount) || 0; recv += amt;
      const how = [p.method, p.notes].filter(Boolean).join(' · ');
      h += '<tr><td>' + fmtDateMD(p.date) + '</td><td class="bold">' + esc(p.label || '') + '</td>' +
        '<td class="bold">' + fmtMoney(amt) + '</td><td>' + esc(how || '—') + payQbHtml(p) + '</td>' +
        '<td><button class="remove-btn" onclick="rmPayment(\'' + p.id + '\')">×</button></td></tr>';
    });
    recv = round2(recv);
    const bal = round2(invoiceTotal - recv), paid = bal <= 0 && invoiceTotal > 0;
    let foot = '';
    if (taxable) {
      foot += '<tr><td colspan="2" style="text-align:right">Subtotal:</td><td>' + fmtMoney(jobPrice) + '</td><td colspan="2"></td></tr>';
      foot += '<tr><td colspan="2" style="text-align:right">WI Tax 5.5%:</td><td>' + fmtMoney(tax) + '</td><td colspan="2"></td></tr>';
      foot += '<tr style="font-weight:700"><td colspan="2" style="text-align:right">Invoice Total:</td><td>' + fmtMoney(invoiceTotal) + '</td><td colspan="2" class="muted" style="font-weight:500">matches QuickBooks</td></tr>';
    }
    foot += '<tr style="font-weight:700"><td colspan="2" style="text-align:right">Received:</td><td>' + fmtMoney(recv) + '</td><td colspan="2"></td></tr>';
    foot += '<tr style="font-weight:700"><td colspan="2" style="text-align:right">Balance Due:</td>' +
      '<td style="color:' + (paid ? 'var(--pos)' : 'var(--neg)') + '">' + fmtMoney(bal) + '</td>' +
      '<td colspan="2">' + (paid ? '<span class="paid-chip">Paid in full</span>' : '') + '</td></tr>';
    h += '</tbody><tfoot>' + foot + '</tfoot></table></div>';
    w.innerHTML = h;
  }
  const recvTotal = round2(payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0));
  const bal = round2(invoiceTotal - recvTotal);
  const badge = document.getElementById('paymentsBadge');
  if (bal <= 0 && invoiceTotal > 0) { badge.textContent = 'Paid'; badge.className = 'section-badge accent'; }
  else { badge.textContent = recvTotal > 0 ? fmtMoney(recvTotal) + ' in' : ''; badge.className = 'section-badge'; }
}
// Payments and QuickBooks, both ways (Jonah, 15 Oct 2026): one logged here on
// a job with a QuickBooks invoice goes on that invoice by itself, and ones
// paid in QuickBooks (a card, a check entered there) come onto the job --
// functions/quickbooks.py sync_payments, tied by qbPaymentId so nothing is
// counted twice. Payments logged before PAYMENTS_FROM were already entered
// in QuickBooks by hand and are only tied, never sent.
const PAYMENTS_FROM = '2026-10-15T19:00:00.000Z';
function jobQbInvoice(id) {
  if (boardFields.qbInvoiceRef && boardFields.qbInvoiceRef.id && id === currentJobId) return true;
  const all = window.YDInvoices && YDInvoices.all ? YDInvoices.all() : {};
  return Object.values(all).some(i => i && i.jobId === id && !i.deletedAt);
}
function payQbHtml(p) {
  if (p.qbPaymentId) return ' <span class="pay-qb ok" title="In QuickBooks">✓ ' + (p.fromQb ? 'from QuickBooks' : 'in QuickBooks') + '</span>';
  if (p.qbError) return ' <span class="pay-qb bad">⚠ ' + esc(p.qbError) + '</span>';
  if (String(p.createdAt || '') >= PAYMENTS_FROM) {
    return jobQbInvoice(currentJobId) ? ' <span class="pay-qb wait">⏳ going to QuickBooks</span>'
      : ' <span class="pay-qb">not in QuickBooks — this job has no invoice there yet</span>';
  }
  return '';
}
function addPayment() {
  const amt = document.getElementById('payAmount').value;
  if (!amt) return;
  const me = window.YDAuth && YDAuth.user ? (YDAuth.user.displayName || YDAuth.user.email || '') : '';
  payments.push({ id: uid(), date: readMD('payDate'), amount: amt, label: document.getElementById('payLabel').value,
    method: document.getElementById('payMethod').value, notes: document.getElementById('payNotes').value.trim(),
    createdAt: new Date().toISOString(), by: me });
  ['payAmount','payNotes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('payDate').value = todayMD();
  renderPayments(); markDirty();
  sendPaymentSoon(currentJobId);
}
// Sent once the job has saved and reached the server, rather than at the
// next hourly look. Whoever may not change billing waits for that look.
let paySendTimer = 0;
function sendPaymentSoon(jobId) {
  if (!jobId || !jobQbInvoice(jobId) || !(typeof ydCan === 'function' && ydCan('billing', 'change')) || !window.YDClaude) return;
  clearTimeout(paySendTimer);
  paySendTimer = setTimeout(async () => {
    try {
      if (dirty && jobId === currentJobId) autosave();
      if (window.YDSync && YDSync.sendNow) await YDSync.sendNow(jobId);
      await window.YDClaude.post('/qb/payments-now', { jobId });
    } catch (e) {
      showToast('Payment saved — it goes to QuickBooks at the next hourly check', 5000);
    }
  }, 2500);
}
function rmPayment(id) {
  const at = payments.findIndex(p => p.id === id), row = payments[at];
  // QuickBooks holds the money record: one taken off here would come
  // straight back from there at the next check.
  if (row && row.qbPaymentId) {
    showToast('This payment is in QuickBooks — delete it there and it goes from here too', 6000);
    return;
  }
  payments = payments.filter(p => p.id !== id); renderPayments(); markDirty();
  offerPutBack('Payment' + (row && row.amount ? ' of ' + fmtMoney(parseFloat(row.amount) || 0) : '') + ' removed', row, at, () => payments, renderPayments);
}
// What the server wrote onto a job's payments (quickbooks.py sync_payments) --
// the QuickBooks payment each is tied to, why one couldn't be sent, and those
// that came from QuickBooks -- carried into a copy with unsaved edits, or its
// next save would undo them.
function mergePayments(local, server) {
  const out = (local || []).map(p => ({ ...p }));
  let changed = false;
  (Array.isArray(server) ? server : []).forEach(s => {
    if (!s) return;
    const mine = out.find(p => p.id === s.id) || (s.qbPaymentId && out.find(p => p.qbPaymentId === s.qbPaymentId));
    if (mine) {
      ['qbPaymentId', 'qbError', 'qbSyncedAt'].forEach(k => {
        if (s[k] === mine[k]) return;
        if (s[k] == null) { if (k === 'qbError' && mine[k] != null) { delete mine[k]; changed = true; } return; }
        mine[k] = s[k]; changed = true;
      });
    } else if (s.fromQb) { out.push({ ...s }); changed = true; }
  });
  return { list: out, changed };
}
function mergeOpenPayments(server) {
  const m = mergePayments(payments, server);
  if (m.changed) { payments = m.list; renderPayments(); }
  return m.changed;
}

// ═══════════════════════════════════════════════════════════
// BADGES + FINANCIAL SUMMARY
// ═══════════════════════════════════════════════════════════
// Labour on a job now comes from two places: rows typed in by hand, and shifts
// the crew clocked and the owner approved. Both are real hours and both must
// count, so every screen asks through here rather than summing `labor` itself.
//
// Only APPROVED clock time is included. Pending time is shown on the Labor
// Hours panel, clearly marked, but kept out of every number that touches money
// -- otherwise a job's profit would move on its own when a shift is later
// rejected, and the figures would stop being worth trusting.
function manualLaborHours() {
  return labor.reduce((s, e) => s + entryHours(e), 0);
}
// Scans every shift on record, and the summary asks for it several times per
// redraw -- about two dozen full scans each time a job opened, and more on
// every keystroke in the price box. Kept until the job or the shifts change.
let _clockedCache = null;
function clockedLabor() {
  if (!(window.YDClock && currentJobId)) {
    return { byWorker: {}, paidHours: 0, billableHours: 0, costCents: 0, pendingHours: 0 };
  }
  if (_clockedCache && _clockedCache.job === currentJobId) return _clockedCache.value;
  _clockedCache = { job: currentJobId, value: YDClock.forJob(currentJobId) };
  return _clockedCache.value;
}
document.addEventListener('yd-clock-changed', () => {
  _clockedCache = null;
  // All Jobs counts clock time too, so an approved shift moves its figures.
  const dash = document.getElementById('panel-dashboard');
  if (dash && dash.classList.contains('active')) renderDashboard();
});
// The same labour sums for ANY job, not just the one open in the form: the
// hand-entered rows at the standing rate, plus approved clock time at the rate
// it was approved at. All Jobs used to count only the hand-entered rows, so a
// job worked entirely on the clock showed its whole price as profit.
function jobLabour(jobId, laborRows) {
  const manual = (laborRows || []).reduce((s, e) => s + entryHours(e), 0);
  const c = (jobId && window.YDClock && typeof YDClock.forJob === 'function') ? YDClock.forJob(jobId) : null;
  const clockHours = c && isFinite(c.paidHours) ? c.paidHours : 0;
  const clockCents = c && isFinite(c.costCents) ? c.costCents : 0;
  return { hours: round2(manual + clockHours), cost: round2(manual * LABOR_RATE + clockCents / 100) };
}
function totalLaborHours() {
  return round2(manualLaborHours() + clockedLabor().paidHours);
}
// Manual rows are costed at the standing rate; clocked shifts carry the rate
// they were approved at, which is why they are not simply hours times a number.
function totalLaborCost() {
  return round2(manualLaborHours() * LABOR_RATE + clockedLabor().costCents / 100);
}
// Called by the clock when a shift is approved, so the open job updates without
// being reloaded.
function refreshJobLabour() {
  _clockedCache = null;
  // Only worth redrawing while the job's labour is on screen; switching to
  // Tracking redraws it anyway. (This used to look for the Job tab, but the
  // labour table and the financials live on Tracking, so an approval never
  // showed until something else happened to redraw them.)
  const p = document.getElementById('panel-tracking');
  if (p && p.classList.contains('active') && document.getElementById('laborTableWrap')) renderLabor();
}

function updateBadges() {
  const th = totalLaborHours();
  const tm = materials.reduce((s, e) => s + (parseFloat(e.price) || 0), 0);
  const tac = getAdditionalCostsTotal();
  document.getElementById('laborBadge').textContent = th > 0 ? fmtHrsMin(th) + ' total' : '';
  document.getElementById('matBadge').textContent = tm > 0 ? fmtMoney(tm) + ' total' : '';
  document.getElementById('addCostBadge').textContent = tac > 0 ? fmtMoney(tac) + ' total' : '';
}
function updateSummary() {
  showJobPrice();
  const totalHrs = totalLaborHours();
  const totalMat = materials.reduce((s, e) => s + (parseFloat(e.price) || 0), 0);
  const totalAddCost = getAdditionalCostsTotal();
  const jobPrice = parseMoney(document.getElementById('jobPrice').value);
  const est = document.getElementById('estimateNumber').value.trim();
  const coTotal = materials.filter(e => isChangeOrder(e.item)).reduce((s, e) => s + (parseFloat(e.price) || 0), 0);

  document.getElementById('summaryGrid').innerHTML = [
    { label: 'Total Labor', value: fmtHrsMin(totalHrs), sub: laborWorkerCount() + ' worker' + (laborWorkerCount() !== 1 ? 's' : ''), cls: '' },
    { label: 'Total Materials', value: fmtMoney(totalMat), sub: coTotal > 0 ? fmtMoney(coTotal) + ' unquoted' : materials.length + ' purchases', cls: '' },
    { label: 'Add-ons Billed', value: fmtMoney(totalAddCost), sub: additionalCosts.length + ' line' + (additionalCosts.length !== 1 ? 's' : ''), cls: '' },
    { label: 'Job Price', value: jobPrice > 0 ? fmtMoney(jobPrice) : '—', sub: est ? 'Est #' + est : 'No estimate #', cls: 'accent-top' },
  ].map(c => '<div class="summary-card ' + c.cls + '"><div class="summary-label">' + c.label + '</div><div class="summary-value">' + c.value + '</div><div class="summary-sub">' + c.sub + '</div></div>').join('');

  const laborCost = totalLaborCost();
  const overhead = round2(laborCost + totalMat);
  const net = round2(jobPrice - overhead);
  const perHr = totalHrs > 0 ? net / totalHrs : 0;
  const hasPrice = jobPrice > 0, hasHrs = totalHrs > 0;
  // Nothing spent on it yet (no labor, no purchases): its profit is not the
  // whole price at a 100% margin, it is not known yet.
  const hasCosts = overhead > 0;

  document.getElementById('financialsGrid').innerHTML = [
    { label: 'Labor Cost', value: fmtMoney(laborCost), cls: '', top: '', sub: laborCostSub(totalHrs) },
    { label: 'Total Cost', value: fmtMoney(overhead), cls: '', top: '', sub: 'Labor + Materials' },
    hasCosts
      ? { label: 'Net Profit', value: (net < 0 ? '-' : '') + fmtMoney(Math.abs(net)), cls: hasPrice ? (net >= 0 ? 'positive' : 'negative') : '', top: hasPrice ? (net >= 0 ? 'pos-top' : 'neg-top') : '', sub: hasPrice ? (net / jobPrice * 100).toFixed(1) + '% margin' : 'Set job price' }
      : { label: 'Net Profit', value: '—', cls: '', top: '', sub: 'No costs logged yet' },
    { label: 'Profit / Hr', value: hasHrs ? ((perHr < 0 ? '-' : '') + fmtMoney(Math.abs(perHr))) : '—', cls: hasHrs ? (perHr >= 0 ? 'positive' : 'negative') : '', top: '', sub: hasHrs ? 'Per labor hour' : 'Add labor' },
  ].map(c => '<div class="fin-card ' + c.top + '"><div class="fin-label">' + c.label + '</div><div class="fin-value ' + c.cls + '">' + c.value + '</div><div style="font-size:11px;color:var(--muted);margin-top:3px">' + c.sub + '</div></div>').join('');

  renderPayments();
  // Estimate vs actual reads the same figures (jobcosts.js); it redraws
  // once the changes pause, and only while Tracking is on screen.
  if (window.YDJobCosts) window.YDJobCosts.jobChanged();
}

// ═══════════════════════════════════════════════════════════
// SAVE / LOAD
// ═══════════════════════════════════════════════════════════
// plants: Jonah's own Yes / No on whether the job has plants ('' = worked
// out, plantcare.js).
// crewWhat: what the job is in a few words, typed by hand (jobWhat).
const FIELDS = ['customerName','firstName','lastName','business','address','city','state','zip','phone','email','jobPrice','estimateNumber','referral','notes','qbInvoice','plants','crewWhat'];

// A few words on what the job is, beside the customer's name wherever the
// crew pick or see a job (Jonah, 15 Oct 2026: "so my crew doesn't have to
// memorize every client name"): what was typed for it on the Job tab, else
// the estimate's first line or two of work, else its services.
const WHAT_MAX = 40;
function autoWhat(d) {
  d = d || {};
  // A QuickBooks line's "(10 × $50.00)" says how it was priced, not what it is.
  const work = (((d.estimate || {}).work) || []).map(w => String((w && w.title) || '').replace(/\s*\([^)]*×[^)]*\)\s*$/, '').trim())
    .filter(Boolean);
  const pick = work.length ? work : (d.serviceTypes || []).map(s => String(s || '').trim()).filter(Boolean);
  if (!pick.length) return '';
  let out = pick[0];
  if (pick[1] && pick[1] !== pick[0] && (out + ' & ' + pick[1]).length <= WHAT_MAX) out += ' & ' + pick[1];
  return out.length > WHAT_MAX ? out.slice(0, WHAT_MAX - 1).trim() + '…' : out;
}
function jobWhat(d) {
  const typed = String((d && d.crewWhat) || '').trim();
  return typed ? typed.slice(0, WHAT_MAX) : autoWhat(d);
}
// "Pat Smith · Paver patio".
function jobLabel(name, what) { return what ? name + ' · ' + what : name; }
// The box on the Job tab shows what goes there when it is left blank.
function crewWhatHint() {
  const box = document.getElementById('crewWhat');
  if (!box) return;
  const auto = autoWhat({ estimate: window.YDEstimate ? window.YDEstimate.get() : null, serviceTypes: serviceTypes });
  box.placeholder = auto ? auto + ' (from the ' + (window.YDEstimate && window.YDEstimate.hasLines() ? 'estimate' : 'services') + ')'
    : 'e.g. Paver patio, Fall cleanup';
}

function getJobData() {
  const d = {};
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) d[f] = el.value; });
  // If the field still reads exactly as the stored date did, nothing was
  // edited -- so keep the stored value, year and all.
  const shownDate = (document.getElementById('quoteDate').value || '').trim();
  d.quoteDate = (loadedQuoteDate && shownDate === fmtDateMD(loadedQuoteDate))
    ? loadedQuoteDate
    : readMD('quoteDate');
  d.qbInvoiced = document.getElementById('qbInvoiced').checked;
  d.taxable = document.getElementById('taxable').checked;
  // Kept off the crew's Jobs tab even while booked (crewjobs.js).
  d.crewHidden = !!(document.getElementById('crewHidden') || {}).checked;
  d.serviceTypes = serviceTypes.slice();
  d.labor = labor; d.materials = materials; d.orderItems = orderItems;
  d.proposals = proposals; d.payments = payments; d.additionalCosts = additionalCosts;
  d.manualJobPrice = manualJobPrice; d.baseJobPrice = baseJobPrice; d.jobStatus = jobStatus;
  BOARD_FIELDS.forEach(f => { if (boardFields[f] != null) d[f] = boardFields[f]; });
  // The estimate being built on this job (estimate.js), kept with it like the materials.
  if (window.YDEstimate) d.estimate = window.YDEstimate.get();
  // Whether it has plants, worked out again from all of the above, so the
  // server's summary can read it (plantcare.js).
  if (window.YDPlants) d.hasPlants = window.YDPlants.has(d);
  d.lastModified = new Date().toISOString();
  return d;
}
function loadJobData(d) {
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = d[f] || ''; });
  namePartsFromCustomer();
  loadedQuoteDate = d.quoteDate || '';
  document.getElementById('quoteDate').value = d.quoteDate ? fmtDateMD(d.quoteDate) : todayMD();
  document.getElementById('qbInvoiced').checked = !!d.qbInvoiced;
  document.getElementById('taxable').checked = !!d.taxable;
  const ch = document.getElementById('crewHidden'); if (ch) ch.checked = !!d.crewHidden;
  serviceTypes = Array.isArray(d.serviceTypes) ? d.serviceTypes.slice() : (d.serviceType ? [d.serviceType] : []);
  renderServiceTypes();
  labor = (d.labor || []).map(e => ({ ...e, id: e.id || uid() }));
  materials = (d.materials || []).map(e => ({ ...e, id: e.id || uid() }));
  const rawOrder = d.orderItems || d.quotedMaterials || [];
  // Kept whole: a receipt that ticked an item notes which order it was on it.
  orderItems = rawOrder.map(e => ({ ...e, id: e.id || uid(), proposalId: e.proposalId || null, name: e.name || '', quantity: e.quantity || '', ordered: !!e.ordered }));
  proposals = Array.isArray(d.proposals) ? d.proposals
            : (d.proposalData ? [{ id: uid(), label: d.proposalData.projectName || d.proposalData.title || 'Proposal', data: d.proposalData }] : []);
  payments = (d.payments || []).map(p => ({ ...p, id: p.id || uid() }));
  additionalCosts = (d.additionalCosts || []).map(e => ({ ...e, id: e.id || uid() }));
  manualJobPrice = !!d.manualJobPrice;
  const addOns = additionalCosts.reduce((s, e) => s + (parseFloat(e.materialCost) || 0) + (parseFloat(e.laborCost) || 0), 0);
  if (d.baseJobPrice !== undefined && d.baseJobPrice !== null && d.baseJobPrice !== '') baseJobPrice = parseFloat(d.baseJobPrice) || 0;
  else baseJobPrice = parseMoney(d.jobPrice || '') - addOns;
  // The saved price is the one every other screen shows. Something that set
  // it without the base (the estimate saved on a job not open, a QuickBooks
  // update, a patch from another device) left the base behind -- and the
  // field, rebuilt from base + add-ons, then showed the old price and the
  // next save wrote it back (15 Oct 2026). So the saved price wins.
  const savedPrice = parseMoney(d.jobPrice || '');
  if (savedPrice > 0 && Math.abs(baseJobPrice + addOns - savedPrice) > 0.005) baseJobPrice = savedPrice - addOns;
  jobStatus = normStatus(d.jobStatus, d);
  boardFields = {};
  BOARD_FIELDS.forEach(f => { if (d[f] != null) boardFields[f] = d[f]; });
  if (window.YDEstimate) window.YDEstimate.load(d.estimate || null);
  crewWhatHint();

  syncStatusSelect(); updateJobHeadBadge();
  renderLabor(); renderMaterials(); renderAdditionalCosts(); renderPayments();
  renderProposal(); renderOrderList(); updateSummary();
  dirty = false; updateCtxBar();
  if (window.YDPlants) window.YDPlants.refresh();
}

function getJobIndex() { try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'index') || '[]'); } catch { return []; } }
function saveJobIndex(idx) { localStorage.setItem(STORAGE_PREFIX + 'index', JSON.stringify(idx)); }

// Read a job blob, falling back to the legacy key scheme (older versions stored
// the job under the raw id, e.g. "ydjob_abc", with no "ydjobhub_" prefix).
function readJobBlob(id) {
  let raw = localStorage.getItem(STORAGE_PREFIX + id);
  if (raw == null) raw = localStorage.getItem(id);
  return raw;
}

// One-time (idempotent) migration: rebuild index entries from the actual job
// blobs so prices, cities, services, and status show correctly for jobs saved
// by an older version. Does not move or delete any job data.
//
// Run once per device for each INDEX_VERSION, not at every launch: it reads
// and parses every stored job, and every save since keeps the index right by
// itself (buildIndexEntry). Raise INDEX_VERSION whenever the index gains a
// field, so devices fill it in for jobs saved before.
const INDEX_VERSION = 2;     // 2 (15 Oct 2026): date, and invoiced from QuickBooks too
const INDEX_VERSION_KEY = STORAGE_PREFIX + 'indexVersion';
function migrateJobIndex() {
  try { if (localStorage.getItem(INDEX_VERSION_KEY) === String(INDEX_VERSION)) return; } catch (e) {}
  rebuildJobIndex();
  try { localStorage.setItem(INDEX_VERSION_KEY, String(INDEX_VERSION)); } catch (e) {}
}
function rebuildJobIndex() {
  let idx = getJobIndex();
  if (!idx.length) return;
  let changed = false;
  idx = idx.map(entry => {
    const raw = readJobBlob(entry.id);
    if (!raw) return entry;
    let data; try { data = JSON.parse(raw); } catch { return entry; }
    const svc = Array.isArray(data.serviceTypes) ? data.serviceTypes.join(', ')
              : (data.serviceType || entry.services || entry.serviceType || '');
    const fresh = {
      id: entry.id,
      name: data.customerName || entry.name || 'Untitled',
      city: [data.city, data.state].filter(Boolean).join(', '),
      status: data.jobStatus || entry.status || entry.jobStatus || 'quoting',
      price: parseMoney(data.jobPrice || ''),
      services: svc,
      est: String(data.estimateNumber || '').trim(),
      lost: isBidStatus(data.jobStatus || entry.status) && data.bidStage === 'lost',
      date: String(data.quoteDate || '').slice(0, 10),
      invoiced: isInvoiced(data),
      lastModified: data.lastModified || entry.lastModified || ''
    };
    if (fresh.price !== entry.price || fresh.city !== entry.city || fresh.services !== entry.services || fresh.status !== entry.status || fresh.name !== entry.name || fresh.est !== entry.est || fresh.lost !== entry.lost ||
        fresh.date !== entry.date || fresh.invoiced !== entry.invoiced) changed = true;
    return fresh;
  });
  if (changed) { saveJobIndex(idx); invalidateJobsCache(); }
}

// ---- Jobs cache (dashboards re-read all jobs; cache the parse) ----
let _jobsCache = null;
function invalidateJobsCache() { _jobsCache = null; }

// ---- Autosave state ----
let autosaveTimer = null;
let loadingJob = false;      // suppress autosave while a job loads in
let storageBroken = false;   // set true once a write fails
let storageWarned = false;   // ensures the storage-full toast shows once, not on every retry

function buildIndexEntry(id, data) {
  return { id, name: data.customerName || 'Untitled',
    city: [data.city, data.state].filter(Boolean).join(', '),
    status: data.jobStatus, price: parseMoney(data.jobPrice),
    services: (data.serviceTypes || []).join(', '),
    // The job's number, shown beside the name wherever jobs are listed.
    est: String(data.estimateNumber || '').trim(),
    // A lost bid: still listed under Bids, marked Lost (Jonah, 9 Oct 2026).
    lost: isBidStatus(data.jobStatus) && data.bidStage === 'lost',
    // The job's own date (the form's Date, YYYY-MM-DD): My Jobs files it by
    // this month. lastModified moves with every QuickBooks check the server
    // makes, so jobs used to jump into this month on their own.
    date: String(data.quoteDate || '').slice(0, 10),
    invoiced: isInvoiced(data), lastModified: data.lastModified };
}
// Invoiced: the box ticked by hand, or an invoice made in QuickBooks
// (qbInvoiceRef) -- the QB chip on All Jobs showed only the first.
function isInvoiced(data) {
  return !!(data && (data.qbInvoiced || (data.qbInvoiceRef && data.qbInvoiceRef.id)));
}
// "Smith #1042": the name with the job's number beside it, escaped for HTML.
function jobNameHtml(name, est) {
  return esc(name || 'Untitled') + (est ? ' <span class="job-num">#' + esc(est) + '</span>' : '');
}

// Shared writer. Returns true on success, false on failure.
function persistJob(announce) {
  if (jobsReadOnly()) { if (announce) showToast('You can look at jobs but not change them'); return false; }
  const data = getJobData();
  if (!currentJobId) { currentJobId = uid(); jobOnScreen(); }
  const before = localStorage.getItem(STORAGE_PREFIX + currentJobId);
  try {
    localStorage.setItem(STORAGE_PREFIX + currentJobId, JSON.stringify(data));
    let idx = getJobIndex().filter(j => j.id !== currentJobId);
    idx.unshift(buildIndexEntry(currentJobId, data));
    saveJobIndex(idx);
  } catch (err) {
    console.error('Save failed:', err);
    // The job and its index entry must never disagree: sync skips a job
    // whose index says it already holds the cloud's copy, so a newer job
    // behind an older index entry would never be sent.
    try {
      if (before === null) localStorage.removeItem(STORAGE_PREFIX + currentJobId);
      else localStorage.setItem(STORAGE_PREFIX + currentJobId, before);
    } catch (e) { /* nothing more to try */ }
    storageBroken = true;
    updateCtxBar();
    return false;
  }
  storageBroken = false;
  storageWarned = false;
  // If this job also existed under the legacy raw key, drop it now that it's
  // saved under the new scheme (natural, one-at-a-time migration).
  if (STORAGE_PREFIX + currentJobId !== currentJobId && localStorage.getItem(currentJobId) !== null) {
    try { localStorage.removeItem(currentJobId); } catch {}
  }
  invalidateJobsCache();
  if (announce) showToast('Job saved');
  return true;
}

// Is this form genuinely blank? Used to stop a brand-new record being created
// with nothing in it. The Save button used to do exactly that, which is where
// stray "Untitled" jobs in the list came from.
function jobIsEmpty() {
  const val = id => (document.getElementById(id) || {}).value || '';
  return !val('customerName').trim()
      && !val('address').trim()
      && !val('estimateNumber').trim()
      && !val('notes').trim()
      && !parseMoney(val('jobPrice'))
      && !serviceTypes.length && !proposals.length && !labor.length
      && !materials.length && !orderItems.length
      && !additionalCosts.length && !payments.length;
}

function saveJob() {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  if (!currentJobId && jobIsEmpty()) {
    showToast('Nothing to save yet — add a customer name first');
    return;
  }
  if (persistJob(true)) { dirty = false; updateCtxBar(); } else showStorageError();
}

// Debounced silent autosave — fires shortly after any change.
function scheduleAutosave() {
  if (loadingJob) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 900);
}
function autosave() {
  if (jobsReadOnly()) return;
  // Don't create a phantom job from an empty form
  if (!currentJobId && jobIsEmpty()) return;
  if (persistJob(false)) { dirty = false; updateCtxBar(); }
  else if (!storageWarned) { storageWarned = true; showStorageError(); }  // warn once, then rely on the red dot
}
function showStorageError() {
  showToast('⚠ Save failed — storage may be full. Export a backup, then delete old jobs.');
}

// `quiet` refreshes the form in place without moving the person anywhere. Sync
// and the boards use it: a change arriving from another device, or a card
// moved on the Bids board, used to yank whoever was looking at Boards or All
// Jobs back to the Job tab.
// What lives beside the form rather than in it (the job's photos) follows
// whichever job is on the Job tab.
function jobOnScreen() {
  if (window.YDJobPhotos) window.YDJobPhotos.jobShown(currentJobId);
}
function loadJob(id, quiet) {
  const raw = readJobBlob(id);
  if (!raw) return;
  currentJobId = id;
  loadingJob = true;
  try { loadJobData(JSON.parse(raw)); } catch (e) { console.error(e); showToast('Could not load job'); }
  loadingJob = false;
  jobOnScreen();
  if (!quiet) { closeManager(); switchTab('job'); }
}
// sure: already asked (Delete these N, below).
function deleteJob(id, sure) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  if (!sure && !confirm('Delete this job permanently?')) return;
  localStorage.removeItem(STORAGE_PREFIX + id);
  localStorage.removeItem(id);   // also drop legacy-key copy if present
  saveJobIndex(getJobIndex().filter(j => j.id !== id));
  invalidateJobsCache();
  // Not newJob(): its "unsaved changes will be lost?" question, answered
  // Cancel, left the deleted job in the form, and the next autosave quietly
  // brought it back to life.
  if (currentJobId === id) clearJobForm();
  renderJobList(); showToast('Job deleted');
}
function duplicateJob(id) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  const raw = readJobBlob(id);
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch (e) { showToast('Could not copy that job'); return; }
  data.customerName = (data.customerName || 'Untitled') + ' (copy)';
  // A copy is new work: nothing invoiced, nothing paid, not yet won. Carrying
  // those over put a second "Paid in full" job on the books, and a second
  // card at the original's place on the Bids and Jobs boards.
  data.qbInvoice = ''; data.qbInvoiced = false;
  data.payments = [];
  data.jobStatus = 'quoting';
  BOARD_FIELDS.forEach(f => { delete data[f]; });
  // Nor has the copy's estimate been sent: no versions "as it went to
  // QuickBooks" (Estimate vs actual reads them), and the fuel prices kept
  // when the original went out follow this week's again.
  if (data.estimate && typeof data.estimate === 'object') {
    const est = Object.assign({}, data.estimate);
    if ((est.sent || []).length) est.fuel = Object.assign({}, est.fuel, { gasCents: null, dieselCents: null });
    est.sent = [];
    data.estimate = est;
  }
  const newId = uid(); data.lastModified = new Date().toISOString();
  try { localStorage.setItem(STORAGE_PREFIX + newId, JSON.stringify(data)); }
  catch (err) { showStorageError(); return; }
  const idx = getJobIndex();
  idx.unshift(buildIndexEntry(newId, data));
  saveJobIndex(idx); invalidateJobsCache(); renderJobList(); showToast('Job duplicated');
}
// A job made without the form -- "+ Add a bid" on the Bids board. Written the
// way a save from the form writes it (this device's copy and the index);
// sync.js sends it up. Returns the new job's id, or null.
function createJobRecord(fields) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return null; }
  const id = uid();
  const data = Object.assign({
    customerName: '', serviceTypes: [], labor: [], materials: [], orderItems: [], proposals: [],
    payments: [], additionalCosts: [], jobStatus: 'quoting', quoteDate: parseMD(todayMD()),
  }, fields, { lastModified: new Date().toISOString() });
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(data)); }
  catch (err) { showStorageError(); return null; }
  const idx = getJobIndex();
  idx.unshift(buildIndexEntry(id, data));
  saveJobIndex(idx); invalidateJobsCache();
  return id;
}
function newJob() {
  if (dirty && !confirm('Start a new job? Unsaved changes will be lost.')) return;
  clearJobForm();
  switchTab('job'); showToast('New job started');
}
// Empties the form without asking anything or moving anyone. newJob() puts
// the unsaved-changes question in front of it; a delete does not need that
// question (the person has just confirmed the delete), and sync uses it when
// the job on screen was deleted on another device.
function clearJobForm() {
  currentJobId = null;
  jobOnScreen();
  labor = []; materials = []; orderItems = []; proposals = []; payments = []; additionalCosts = [];
  serviceTypes = []; jobStatus = 'quoting'; boardFields = {}; manualJobPrice = false; baseJobPrice = 0;
  storageBroken = false; storageWarned = false;
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  document.getElementById('qbInvoiced').checked = false;
  document.getElementById('taxable').checked = false;
  loadedQuoteDate = '';
  document.getElementById('quoteDate').value = todayMD();
  if (window.YDEstimate) window.YDEstimate.load(null);
  crewWhatHint();
  syncStatusSelect(); updateJobHeadBadge();
  renderServiceTypes(); renderLabor(); renderMaterials(); renderAdditionalCosts(); renderPayments();
  renderProposal(); renderOrderList(); updateSummary();
  dirty = false; updateCtxBar();
  if (window.YDPlants) window.YDPlants.refresh();
}
function markDirty() { dirty = true; updateCtxBar(); scheduleAutosave(); }

// ═══════════════════════════════════════════════════════════
// JOB MANAGER MODAL
// ═══════════════════════════════════════════════════════════
function openManager() { populateServiceFilter(); renderJobList(); document.getElementById('managerModal').classList.add('active'); }
function closeManager() { document.getElementById('managerModal').classList.remove('active'); }
function toggleMonth(key) { collapsedMonths[key] = !collapsedMonths[key]; renderJobList(); }
function populateServiceFilter() {
  const set = new Set();
  getJobIndex().forEach(j => (j.services || '').split(',').map(s => s.trim()).filter(Boolean).forEach(s => set.add(s)));
  const sel = document.getElementById('filterService');
  sel.innerHTML = '<option value="">All Services</option>' + [...set].sort().map(s => '<option>' + esc(s) + '</option>').join('');
}
let jobListBids = false;
function showJobListBids(on) { jobListBids = !!on; renderJobList(); }
// The day a job is filed under in My Jobs: its own date; a job with none
// (very old ones) keeps the day this device first listed it, remembered
// here, so it does not drift with every save as lastModified does.
const JOB_SEEN_KEY = STORAGE_PREFIX + 'jobFirstSeen';
let jobSeen = null;
function jobListDay(j) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(j.date || '')) return j.date;
  if (!jobSeen) { try { jobSeen = JSON.parse(localStorage.getItem(JOB_SEEN_KEY) || '{}') || {}; } catch (e) { jobSeen = {}; } }
  if (!jobSeen[j.id]) {
    const t = j.lastModified ? new Date(j.lastModified) : new Date();
    jobSeen[j.id] = localYMD(isNaN(t) ? new Date() : t);
    try { localStorage.setItem(JOB_SEEN_KEY, JSON.stringify(jobSeen)); } catch (e) {}
  }
  return jobSeen[j.id];
}
// Jobs marked to be taken off (removeWhy): a second copy of a job -- the
// estimate sent again to be e-signed, or typed in by hand before QuickBooks
// brought it in -- and snow contracts now on the Snow route (quickbooks.py
// snow_from_jobs). Listed at the top of My Jobs for whoever may change jobs,
// with one Delete for them all; Keep takes one off the list.
function markedJobs() {
  return loadAllJobs().filter(d => d.removeWhy).sort((a, b) => String(a.customerName || '').localeCompare(String(b.customerName || '')));
}
function removeBoxHtml() {
  if (jobsReadOnly()) return '';
  const list = markedJobs();
  if (!list.length) return '';
  return '<div class="jl-remove"><div class="jl-remove-head"><b>To take off (' + list.length + ')</b>' +
      '<span class="muted"> — copies of a job that is staying, and snow contracts now on the Snow route</span></div>' +
    '<ul>' + list.map(d => '<li>' + jobNameHtml(d.customerName || 'Job', d.estimateNumber) +
      ' <span class="muted">— ' + esc(d.removeNote || (d.removeWhy === 'snow' ? 'Snow contract — on the Snow route' : 'A copy of another job')) + '</span>' +
      ' <button class="link-btn" onclick="keepMarkedJob(\'' + String(d._id).replace(/[^A-Za-z0-9_-]/g, '') + '\')">Keep it</button></li>').join('') + '</ul>' +
    '<button class="btn btn-sm jl-remove-go" onclick="deleteMarkedJobs()">🗑 Delete these ' + list.length + '</button></div>';
}
function deleteMarkedJobs() {
  if (jobsReadOnly()) return;
  const list = markedJobs();
  if (!list.length || !confirm('Delete these ' + list.length + ' jobs for good?\n\n' +
      list.map(d => '• ' + (d.customerName || 'Job') + (d.estimateNumber ? ' #' + d.estimateNumber : '')).join('\n'))) return;
  list.forEach(d => window.deleteJob(d._id, true));
  showToast(list.length + ' job' + (list.length === 1 ? '' : 's') + ' deleted');
}
function keepMarkedJob(id) {
  if (jobsReadOnly() || !window.YDSync) return;
  window.YDSync.patchJob(id, { removeWhy: null, replacedBy: null, removeNote: null });
  renderJobList();
}
function renderJobList() {
  const body = document.getElementById('jobListBody');
  const fSvc = document.getElementById('filterService').value;
  const fSearch = (document.getElementById('filterSearch').value || '').toLowerCase().trim();
  const all = getJobIndex();
  const bidCount = all.filter(j => isBidStatus(j.status)).length;
  let idx = all.filter(j => isBidStatus(j.status) === jobListBids);
  const switcher = '<div class="jl-switch">' +
    '<button class="' + (jobListBids ? '' : 'on') + '" onclick="showJobListBids(false)">Jobs (' + (all.length - bidCount) + ')</button>' +
    '<button class="' + (jobListBids ? 'on' : '') + '" onclick="showJobListBids(true)">Bids (' + bidCount + ')</button></div>';
  if (fSvc) idx = idx.filter(j => (j.services || '').includes(fSvc));
  if (fSearch) idx = idx.filter(j => (j.name + ' ' + (j.city || '') + ' ' + (j.services || '') + ' ' + (j.est || '')).toLowerCase().includes(fSearch));
  if (!idx.length) { body.innerHTML = removeBoxHtml() + switcher + '<p class="empty-msg">' + (jobListBids ? 'No bids.' : 'No jobs found.') + '</p>'; return; }

  // Filed by the job's own date, newest first within a month -- not by
  // lastModified, which the server moves on every QuickBooks check.
  const groups = {};
  idx.map(j => ({ j, day: jobListDay(j) })).sort((a, b) => b.day.localeCompare(a.day) || String(a.j.name || '').localeCompare(String(b.j.name || '')))
    .forEach(({ j, day }) => {
      const dt = new Date(day + 'T00:00:00');
      const key = MONTHS[dt.getMonth()] + ' ' + dt.getFullYear();
      (groups[key] = groups[key] || []).push(j);
    });
  const keys = Object.keys(groups).sort((a, b) => { const [ma, ya] = a.split(' '), [mb, yb] = b.split(' '); return yb - ya || MONTHS.indexOf(mb) - MONTHS.indexOf(ma); });
  // 🌱 on a job with plants, and the care email it still owes (plantcare.js)
  // -- from the whole job, which the index does not carry.
  const full = {};
  if (window.YDPlants) loadAllJobs().forEach(d => { full[d._id] = d; });
  const plantBits = j => full[j.id] ? window.YDPlants.badge(full[j.id]) + window.YDPlants.owedChip(full[j.id]) : '';
  body.innerHTML = removeBoxHtml() + switcher + keys.map(key => {
    const shut = collapsedMonths[key];
    const rows = groups[key].map(j =>
      '<div class="job-row"><div class="job-row-main" onclick="loadJob(\'' + j.id + '\')">' +
        '<div class="job-row-name">' + jobNameHtml(j.name, j.est) + ' ' +
          (j.lost ? '<span class="pill lost">Lost</span>' : statusPill(normStatus(j.status))) + plantBits(j) + '</div>' +
        '<div class="job-row-sub">' + (j.city ? esc(j.city) + ' · ' : '') + (j.services ? esc(j.services) + ' · ' : '') +
          // A bid with no price yet said "$0.00", which read as a free job.
          (j.price ? fmtMoney(j.price) : '<span class="muted">no price yet</span>') + '</div></div>' +
      '<div class="jl-acts">' +
      (jobListBids && j.lost && !jobsReadOnly() ? '<button class="dup-btn" onclick="reopenBid(\'' + j.id + '\')">BACK ON THE BOARD</button>' : '') +
      (jobListBids && !jobsReadOnly() ? '<button class="dup-btn" onclick="makeItAJob(\'' + j.id + '\')">MAKE IT A JOB</button>' : '') +
      // "DUP" meant nothing to anyone; and Delete sat right against it.
      '<button class="dup-btn" onclick="duplicateJob(\'' + j.id + '\')" title="Make a copy of this ' + (jobListBids ? 'bid' : 'job') + '">COPY</button>' +
      '<button class="remove-btn jl-del" onclick="deleteJob(\'' + j.id + '\')" title="Delete this ' + (jobListBids ? 'bid' : 'job') +
        '" aria-label="Delete ' + esc(j.name || 'this job') + '">🗑 Delete</button></div></div>'
    ).join('');
    return '<div class="month-group"><div class="month-head" onclick="toggleMonth(\'' + key + '\')">' +
      '<span class="month-arrow' + (shut ? ' shut' : '') + '">▼</span> ' + key + ' (' + groups[key].length + ')</div>' + (shut ? '' : rows) + '</div>';
  }).join('');
}

// ═══════════════════════════════════════════════════════════
// ALL JOBS DASHBOARD
// ═══════════════════════════════════════════════════════════
function loadAllJobs() {
  if (_jobsCache) return _jobsCache;
  _jobsCache = getJobIndex().map(j => { try { return { ...JSON.parse(readJobBlob(j.id)), _id: j.id }; } catch { return null; } }).filter(Boolean);
  return _jobsCache;
}
function sortDash(col) { if (dashSort.col === col) dashSort.asc = !dashSort.asc; else { dashSort.col = col; dashSort.asc = true; } renderDashboard(); }
// The search box redraws once typing pauses, not at every letter: each
// redraw works out every job's figures, clocked shifts included, and a fast
// typist queued a dozen of them back to back.
let dashSearchTimer = null;
function renderDashboardSoon() {
  clearTimeout(dashSearchTimer);
  dashSearchTimer = setTimeout(renderDashboard, 180);
}
// All Jobs: the filters added since the page was written (index.html keeps
// the first five) are put in once, here: where a job is on its board --
// Ready to invoice, money still owed, lost bids -- and which year.
function ensureDashFilters() {
  const st = document.getElementById('dashStatus');
  if (st && !st.querySelector('option[value="toInvoice"]')) {
    st.insertAdjacentHTML('beforeend', '<option value="toInvoice">Ready to invoice</option>' +
      '<option value="owed">Owed money</option><option value="lost">Lost bids</option>');
  }
  if (!document.getElementById('dashYear') && st) {
    const sel = document.createElement('select');
    sel.id = 'dashYear';
    sel.setAttribute('aria-label', 'Which year');
    sel.onchange = renderDashboard;
    st.insertAdjacentElement('afterend', sel);
  }
}
// The year a job belongs to on All Jobs: a finished one, the year it was
// finished (its date when that was never noted); one booked or under way is
// this year's work whatever year it was quoted; a bid, the year of its date.
function dashYearOf(d, status) {
  const now = new Date().getFullYear();
  if (status === 'booked' || status === 'inprogress') return now;
  const when = (status === 'complete' && d.completedAt) || d.quoteDate || d.lastModified || '';
  const y = parseInt(String(when).slice(0, 4), 10);
  return y > 1990 ? y : now;
}
// The year list: this year (the default), every year a job is in, and all.
function fillDashYears(years) {
  const sel = document.getElementById('dashYear');
  if (!sel) return '';
  const now = new Date().getFullYear();
  const prev = sel.dataset.filled ? sel.value : String(now);
  const list = Array.from(new Set([now].concat(years))).sort((a, b) => b - a);
  sel.innerHTML = list.map(y => '<option value="' + y + '">' + (y === now ? 'This year (' + y + ')' : y) + '</option>').join('') +
    '<option value="all">Every year</option>';
  sel.value = list.indexOf(+prev) !== -1 || prev === 'all' ? prev : String(now);
  sel.dataset.filled = '1';
  return sel.value;
}
// Where the job is on its board, in the board's words -- shown beside the
// status, and left out where it only repeats it (Booked is Scheduled).
function dashStage(d, status) {
  if (isBidStatus(d.jobStatus) && d.bidStage === 'lost') return { id: 'lost', name: 'Lost' };
  const st = window.YDBoards && YDBoards.stageOf ? YDBoards.stageOf(d) : null;
  if (st) return st;
  // Paid a while ago: off the Jobs board, but still paid.
  if (status === 'complete' && window.YDSync && YDSync.finishedStage && window.YDBoards && YDBoards.jobColumnName) {
    const id = YDSync.finishedStage(d);
    return { id: id, name: YDBoards.jobColumnName(id) };
  }
  return null;
}
const DASH_SAME_AS_STATUS = { scheduled: 1, inProgress: 1, won: 1 };
// What the job makes. Real costs (materials bought, labour clocked or
// entered) once there are any; until then what the estimate planned -- the
// price less what its materials, delivery, fuel and crew-days cost
// (pricing.js profit) -- marked as planned. With neither: unknown, never the
// whole price shown as profit.
function dashPlannedNet(d, price) {
  const e = d.estimate;
  if (!price || !e || !((e.work || []).length || (e.materials || []).length) || !window.YDEstimate || !YDEstimate.priceSaved) return null;
  try {
    const r = YDEstimate.priceSaved(e, d.city || '');
    if (!r || !r.profit || !r.profit.complete) return null;
    return round2(price - r.profit.costCents / 100);
  } catch (err) { return null; }
}
// Money still owed on the job's QuickBooks invoice; null with no invoice.
function dashOwed(d) {
  const r = d.qbInvoiceRef;
  if (!r || !r.id || r.balance == null || r.balance === '') return null;
  const n = Number(r.balance);
  return isFinite(n) ? n : null;
}
function renderDashboard() {
  // The job-by-job Estimate vs actual below the table (jobcosts.js) has its
  // own filters; it redraws whenever this does, once things settle.
  if (window.YDJobCosts) window.YDJobCosts.listChanged();
  ensureDashFilters();
  const svcSel = document.getElementById('dashFilter');
  const jobsAll = loadAllJobs();
  // Rebuild the service filter every render so newly-added service types appear (keep current pick)
  const prevSvc = svcSel.value;
  const set = new Set(); jobsAll.forEach(j => (j.serviceTypes || []).forEach(s => set.add(s)));
  svcSel.innerHTML = '<option value="">All Services</option>' + [...set].sort().map(s => '<option>' + esc(s) + '</option>').join('');
  svcSel.value = prevSvc;
  const fSvc = svcSel.value, fStatus = document.getElementById('dashStatus').value, fSearch = (document.getElementById('dashSearch').value || '').toLowerCase().trim();
  let rows = jobsAll.map(d => {
    // Clocked shifts included, exactly as the job's own Tracking figures do.
    const lab = jobLabour(d._id, d.labor);
    const hrs = lab.hours;
    const matCost = (d.materials || []).reduce((s, e) => s + (parseFloat(e.price) || 0), 0);
    const price = parseMoney(d.jobPrice || '');
    const status = normStatus(d.jobStatus, d);
    const real = lab.cost + matCost > 0;
    const net = real ? round2(price - (lab.cost + matCost)) : dashPlannedNet(d, price);
    const stage = dashStage(d, status);
    return { id: d._id, name: d.customerName || 'Untitled', est: String(d.estimateNumber || '').trim(), city: [d.city, d.state].filter(Boolean).join(', '), services: (d.serviceTypes || []).join(', '), status, price, hrs, matCost, net, planned: !real && net != null,
      invoiced: isInvoiced(d), owed: dashOwed(d), stage, lost: isBidStatus(d.jobStatus) && d.bidStage === 'lost', year: dashYearOf(d, status),
      plantBits: window.YDPlants ? window.YDPlants.badge(d) + window.YDPlants.owedChip(d) : '' };
  });
  const fYear = fillDashYears(Array.from(new Set(rows.map(r => r.year))));
  if (fYear && fYear !== 'all') rows = rows.filter(r => String(r.year) === fYear);
  if (fSvc) rows = rows.filter(r => r.services.includes(fSvc));
  // Bids show only when Bids (or Lost bids) is picked: the totals are for
  // work actually booked.
  rows = rows.filter(r => fStatus === 'lost' ? r.lost
    : fStatus === 'toInvoice' ? !!r.stage && r.stage.id === 'toInvoice'
    : fStatus === 'owed' ? r.owed > 0
    : fStatus ? r.status === fStatus : r.status !== 'quoting');
  if (fSearch) rows = rows.filter(r => (r.name + ' ' + r.city + ' ' + r.services + ' ' + r.est).toLowerCase().includes(fSearch));
  // Unknown figures (no profit worked out, no invoice) sort below every
  // known one, whichever way round.
  const sortVal = (r, c) => c === 'owed' ? (r.owed == null ? null : r.owed) : r[c];
  rows.sort((a, b) => {
    let va = sortVal(a, dashSort.col), vb = sortVal(b, dashSort.col);
    if (va == null || vb == null) return (va == null) - (vb == null);
    if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb || '').toLowerCase(); }
    if (va < vb) return dashSort.asc ? -1 : 1; if (va > vb) return dashSort.asc ? 1 : -1; return 0;
  });

  document.getElementById('dashCount').textContent = rows.length + ' job' + (rows.length !== 1 ? 's' : '');
  const known = rows.filter(r => r.net != null);
  const totPrice = rows.reduce((s, r) => s + r.price, 0), totNet = known.reduce((s, r) => s + r.net, 0), totHrs = rows.reduce((s, r) => s + r.hrs, 0);
  const totOwed = rows.reduce((s, r) => s + (r.owed > 0 ? r.owed : 0), 0);
  const plannedN = known.filter(r => r.planned).length, unknownN = rows.length - known.length;
  document.getElementById('dashTotals').innerHTML = [
    { l: 'Jobs', v: rows.length, cls: '' }, { l: 'Total Booked', v: fmtMoney(totPrice), cls: 'accent-top' },
    { l: 'Est. Net Profit', v: fmtMoney(totNet), cls: 'pos-top',
      sub: [plannedN ? plannedN + ' planned, not yet costed' : '', unknownN ? unknownN + ' not known' : ''].filter(Boolean).join(' · ') },
    { l: 'Total Labor', v: fmtHrsMin(totHrs), cls: '' },
  ].concat(totOwed > 0 ? [{ l: 'Owed to you', v: fmtMoney(totOwed), cls: 'neg-top' }] : [])
    .map(c => '<div class="summary-card ' + c.cls + '"><div class="summary-label">' + c.l + '</div><div class="summary-value">' + c.v + '</div>' +
      (c.sub ? '<div class="dash-sub">' + esc(c.sub) + '</div>' : '') + '</div>').join('');

  const w = document.getElementById('dashTableWrap');
  // Finished jobs with plants still owing their care email, whatever the
  // filters show (plantcare.js).
  const careNote = window.YDPlants ? window.YDPlants.owedNoteHtml(jobsAll) : '';
  if (!rows.length) { w.innerHTML = careNote + '<p class="empty-msg">No jobs match.</p>'; return; }
  const arrow = c => dashSort.col === c ? (dashSort.asc ? ' ▲' : ' ▼') : '';
  // Old jobs' clocked labour waiting on shifts from before last year.
  const older = window.YDClock && YDClock.oldLabourNote ? YDClock.oldLabourNote() : '';
  const stageHtml = r => r.stage && !DASH_SAME_AS_STATUS[r.stage.id] ? '<span class="dash-stage">' + esc(r.stage.name) + '</span>' : '';
  const statusHtml = r => (r.lost ? '<span class="pill lost">Lost</span>' : statusPill(r.status) + stageHtml(r)) +
    (r.invoiced ? '<span class="qb-chip">QB</span>' : '') + r.plantBits;
  const netHtml = r => r.net == null ? '<span class="muted" title="No costs recorded and no costed estimate yet">—</span>'
    : '<span style="color:' + (r.net >= 0 ? 'var(--pos)' : 'var(--neg)') + '"' +
      (r.planned ? ' class="dash-planned" title="Planned, from the estimate — no real costs recorded yet"' : '') + '>' +
      (r.net < 0 ? '-' : '') + fmtMoney(Math.abs(r.net)) + (r.planned ? '<small> plan</small>' : '') + '</span>';
  const owedHtml = r => r.owed == null ? '<span class="muted">—</span>'
    : r.owed > 0 ? '<span class="dash-owed">' + fmtMoney(r.owed) + '</span>' : '<span class="muted">Paid</span>';
  let h = careNote + (older || '') + '<table class="dash-table"><thead><tr>' +
    '<th style="cursor:pointer" onclick="sortDash(\'name\')">Customer' + arrow('name') + '</th>' +
    '<th style="cursor:pointer" onclick="sortDash(\'city\')">Location' + arrow('city') + '</th>' +
    '<th>Services</th><th style="cursor:pointer" onclick="sortDash(\'status\')">Status' + arrow('status') + '</th>' +
    '<th style="cursor:pointer" onclick="sortDash(\'price\')">Price' + arrow('price') + '</th>' +
    '<th style="cursor:pointer" onclick="sortDash(\'owed\')" title="Still owed on the QuickBooks invoice">Owed' + arrow('owed') + '</th>' +
    '<th style="cursor:pointer" onclick="sortDash(\'net\')" title="Real costs once there are any; until then what the estimate planned">Est. Net' + arrow('net') + '</th></tr></thead><tbody>';
  // The same jobs as cards, for a phone (styles.css shows one or the other
  // at 720px): the seven-column table was wider than the screen.
  let cardsHtml = '<div class="dash-cards">';
  rows.forEach(r => {
    h += '<tr style="cursor:pointer" onclick="loadJob(\'' + r.id + '\')"><td class="bold">' + jobNameHtml(r.name, r.est) + '</td>' +
      '<td>' + esc(r.city || '—') + '</td><td>' + esc(r.services || '—') + '</td>' +
      '<td>' + statusHtml(r) + '</td>' +
      '<td class="bold">' + (r.price ? fmtMoney(r.price) : '<span class="muted">—</span>') + '</td>' +
      '<td class="bold">' + owedHtml(r) + '</td>' +
      '<td class="bold">' + netHtml(r) + '</td></tr>';
    cardsHtml += '<button type="button" class="dash-card" onclick="loadJob(\'' + r.id + '\')">' +
      '<span class="dash-card-top"><span class="dash-card-name">' + jobNameHtml(r.name, r.est) + '</span>' +
        '<span class="dash-card-price">' + (r.price ? fmtMoney(r.price) : '<span class="muted">no price yet</span>') + '</span></span>' +
      '<span class="dash-card-status">' + statusHtml(r) + '</span>' +
      ((r.city || r.services) ? '<span class="dash-card-sub">' + esc([r.city, r.services].filter(Boolean).join(' · ')) + '</span>' : '') +
      '<span class="dash-card-nums"><span>Net ' + netHtml(r) + '</span>' +
        (r.owed != null ? '<span>Owed ' + owedHtml(r) + '</span>' : '') + '</span>' +
    '</button>';
  });
  h += '</tbody></table>';
  w.innerHTML = h + cardsHtml + '</div>';
}

// ═══════════════════════════════════════════════════════════
// MATERIALS DASHBOARD
// ═══════════════════════════════════════════════════════════
function categorizeMaterialItem(desc) { const l = (desc || '').toLowerCase(); for (const cat of MATERIAL_CATEGORIES) if (cat.keywords.some(k => l.includes(k))) return cat.name; return 'Other'; }
function getCategoryUnit(name) { const c = MATERIAL_CATEGORIES.find(c => c.name === name); return c ? c.unit : 'ea'; }
// The window a Materials range covers: { start, end }, with `end` the first
// moment NOT included (null = up to now). null for All Time.
function getDateRange(range) {
  const now = new Date();
  if (range === 'month') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
  if (range === 'year') return { start: new Date(now.getFullYear(), 0, 1), end: null };
  if (range === 'season') return seasonRange(now);
  if (range === '30') return { start: new Date(now.getTime() - 30 * 864e5), end: null };
  if (range === '90') return { start: new Date(now.getTime() - 90 * 864e5), end: null };
  return null;
}
// The landscaping season is 1 April to 31 October. From January to March the
// season that means anything is the one that ended last autumn: the old
// version started at April of THIS year, so all winter the screen was empty,
// and in November and December it carried on counting off-season purchases.
function seasonRange(now) {
  const y = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return { start: new Date(y, 3, 1), end: new Date(y, 10, 1) };
}
function renderMatDash() {
  const range = document.getElementById('matDashRange').value;
  const search = (document.getElementById('matDashSearch').value || '').toLowerCase().trim();
  const win = getDateRange(range);
  const jobs = loadAllJobs();
  const cats = {}; let grandTotal = 0, purchaseCount = 0;
  jobs.forEach(d => {
    (d.materials || []).forEach(m => {
      if (win && m.date) {
        const md = new Date(m.date + 'T00:00:00');
        if (md < win.start || (win.end && md >= win.end)) return;
      }
      const price = parseFloat(m.price) || 0, qty = parseFloat(m.qty) || 0;
      const cat = categorizeMaterialItem(m.item);
      const c = cats[cat] = cats[cat] || { name: cat, unit: getCategoryUnit(cat), total: 0, qty: 0, count: 0, items: [] };
      c.total += price; c.qty += qty; c.count++;
      c.items.push({ job: d.customerName || 'Untitled', item: m.item, qty, unit: m.unit, price, from: m.location });
      grandTotal += price; purchaseCount++;
    });
  });
  let filtered = Object.values(cats);
  if (search) filtered = filtered.filter(c => c.name.toLowerCase().includes(search));
  filtered.sort((a, b) => b.total - a.total);

  document.getElementById('matDashBadge').textContent = fmtMoney(grandTotal) + ' total';
  document.getElementById('matDashTotals').innerHTML = [
    { l: 'Total Spend', v: fmtMoney(grandTotal), cls: 'accent-top' }, { l: 'Purchases', v: purchaseCount, cls: '' }, { l: 'Categories', v: filtered.length, cls: '' },
  ].map(c => '<div class="summary-card ' + c.cls + '"><div class="summary-label">' + c.l + '</div><div class="summary-value">' + c.v + '</div></div>').join('');

  const wrap = document.getElementById('matDashCategoriesWrap');
  if (!filtered.length) { wrap.innerHTML = '<p class="empty-msg">No purchases in this range.</p>'; return; }
  wrap.innerHTML = filtered.map((c, i) => {
    const expId = 'cat_' + i;
    const rows = c.items.map(it =>
      '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f2eef7;font-size:13px">' +
        '<span>' + esc(it.item) + ' <span class="muted">— ' + esc(it.job) + (it.from ? ' · ' + esc(it.from) : '') + '</span></span>' +
        '<span class="bold">' + (it.qty ? it.qty + (it.unit ? ' ' + it.unit : '') + ' · ' : '') + fmtMoney(it.price) + '</span></div>'
    ).join('');
    return '<div class="cat-head" onclick="toggleMatCat(\'' + expId + '\')"><span class="cat-name">' + esc(c.name) + '</span>' +
      '<span class="cat-sub">' + (c.qty > 0 ? c.qty.toFixed(1) + ' ' + c.unit + ' · ' : '') + c.count + ' buy' + (c.count !== 1 ? 's' : '') + ' · <strong>' + fmtMoney(c.total) + '</strong></span></div>' +
      '<div class="cat-body shut" id="' + expId + '">' + rows + '</div>';
  }).join('');
}
function toggleMatCat(id) { document.getElementById(id).classList.toggle('shut'); }

// ═══════════════════════════════════════════════════════════
// BACKUP / RESTORE
// ═══════════════════════════════════════════════════════════
function exportAllJobs() {
  const idx = getJobIndex(); const jobs = {};
  idx.forEach(j => { const raw = readJobBlob(j.id); if (raw) jobs[j.id] = JSON.parse(raw); });
  const backup = { app: 'yd-job-hub', version: 2, exported: new Date().toISOString(), index: idx, jobs };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'yd-job-hub-backup-' + localYMD() + '.json'; a.click(); URL.revokeObjectURL(url);
  localStorage.setItem(STORAGE_PREFIX + 'lastBackup', new Date().toISOString());
  showToast('Backup downloaded (' + idx.length + ' jobs)');
}
function importAllJobs(event) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.jobs || !backup.index) throw new Error('bad file');
      if (!confirm('Restore ' + backup.index.length + ' jobs? This merges into your current jobs.')) { event.target.value = ''; return; }
      // A real merge: a job is taken from the backup only if this device does
      // not have it, or has an OLDER copy. Restoring a week-old backup used to
      // overwrite this week's edits, and sync then sent the old copies to
      // every other device too.
      const byId = {};
      getJobIndex().forEach(j => { byId[j.id] = j; });
      const taken = [];
      for (const id of Object.keys(backup.jobs)) {
        const theirs = backup.jobs[id];
        let ours = null;
        try { ours = JSON.parse(readJobBlob(id) || 'null'); } catch (err) {}
        if (ours && String(ours.lastModified || '') >= String(theirs.lastModified || '')) continue;
        try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(theirs)); }
        catch (err) { showToast('This device ran out of room — restored ' + taken.length + ' jobs'); break; }
        byId[id] = buildIndexEntry(id, theirs);
        taken.push(id);
      }
      saveJobIndex(Object.values(byId));
      invalidateJobsCache();
      event.target.value = '';
      showToast(taken.length ? 'Restored ' + taken.length + ' job' + (taken.length === 1 ? '' : 's') +
        (taken.length < Object.keys(backup.jobs).length ? ' — the rest were already up to date here' : '')
        : 'Nothing to restore — every job here is already as new as the backup');
      renderDashboard();
      document.dispatchEvent(new CustomEvent('yd-jobs-restored', { detail: taken }));
    } catch (err) { showToast('Not a valid backup file'); console.error(err); }
  };
  reader.readAsText(file);
}

// ═══════════════════════════════════════════════════════════
// QUICKBOOKS HANDOFF
// ═══════════════════════════════════════════════════════════
function copyCostSummary() {
  const name = document.getElementById('customerName').value.trim() || 'Untitled';
  const est = document.getElementById('estimateNumber').value.trim();
  const qb = document.getElementById('qbInvoice').value.trim();
  const totalHrs = totalLaborHours();
  const laborCost = totalLaborCost();
  const totalMat = round2(materials.reduce((s, e) => s + (parseFloat(e.price) || 0), 0));
  const addCost = round2(getAdditionalCostsTotal());
  const jobPrice = parseMoney(document.getElementById('jobPrice').value);
  const taxable = document.getElementById('taxable').checked;
  const tax = taxable ? round2(jobPrice * 0.055) : 0;
  const net = round2(jobPrice - (laborCost + totalMat));
  const lines = [
    'YD Exterior Visions — Job Cost Summary',
    'Customer: ' + name,
    est ? 'Estimate #: ' + est : null,
    qb ? 'QB Invoice #: ' + qb : null,
    '',
    'Job Price (subtotal): ' + fmtMoney(jobPrice),
    taxable ? 'WI Tax 5.5%: ' + fmtMoney(tax) : null,
    taxable ? 'Invoice Total: ' + fmtMoney(jobPrice + tax) : null,
    '',
    'Materials purchased: ' + fmtMoney(totalMat),
    'Labor cost: ' + fmtMoney(laborCost) + ' (' + totalHrs.toFixed(1) + ' hrs)',
    'Additional costs: ' + fmtMoney(addCost),
    'Est. net profit: ' + fmtMoney(net),
  ].filter(l => l !== null).join('\n');
  const done = () => showToast('Cost summary copied — paste into QuickBooks');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(lines).then(done).catch(() => fallbackCopy(lines, done));
  else fallbackCopy(lines, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { showToast('Copy not supported — long-press to copy'); }
  document.body.removeChild(ta);
}
function exportPurchasesCsv() {
  if (!materials.length) { showToast('No purchases to export'); return; }
  const name = (document.getElementById('customerName').value.trim() || 'job').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  // Quoted, with line breaks flattened, as the snow billing export does: a
  // vendor typed with a comma or a new line would otherwise split the row.
  const cell = s => '"' + String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/"/g, '""') + '"';
  const rows = ['Date,Item,Quantity,Unit,Vendor,Price'];
  materials.forEach(m => {
    rows.push([cell(fmtDateMDY(m.date)), cell(m.item), cell(m.qty || ''), cell(m.unit || ''),
      cell(m.location || ''), (parseFloat(m.price) || 0).toFixed(2)].join(','));
  });
  // The same two details as the snow billing export. The byte-order mark tells
  // Excel the file is UTF-8 (without it a dash or an accent in a vendor's name
  // arrives as rubbish), and CRLF is what the CSV convention specifies.
  const blob = new Blob([String.fromCharCode(0xFEFF) + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'purchases-' + name + '.csv'; a.click(); URL.revokeObjectURL(url);
  showToast('Purchases CSV downloaded');
}

// ═══════════════════════════════════════════════════════════
// TOAST + INIT
// ═══════════════════════════════════════════════════════════
// One hide-timer for the toast, restarted by every message. Each call used to
// start its own, so a second message arriving while the first was showing was
// hidden by the FIRST one's timer, sometimes after a fraction of a second.
let toastTimer = null;
// `ms`: how long it stays -- longer for something that must not be missed.
// On a phone it stays longer by default: two seconds was gone before a
// glance down from the road (or up from a shovel) reached it.
// (A function, not a constant: it is safe to call from anywhere, however early.)
function phoneScreen() { return !!(window.matchMedia && window.matchMedia('(max-width:720px)').matches); }
function showToast(msg, ms) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--brand);color:#fff;padding:13px 22px;font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;z-index:2000;opacity:0;transition:opacity .3s;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; }, ms || (phoneScreen() ? 3500 : 2000));
}

// ---- "Done -- Undo" ----
// showUndo('Card deleted', () => putItBack()) shows the message with an Undo
// button for a few seconds (7 by default): a quicker, kinder answer to a
// slip than "Are you sure?" before every tap. One at a time -- a new one
// simply replaces the last (whose Undo is then gone). Only the bar itself
// takes taps; nothing else on the screen is covered. Returns a function
// that takes the bar away early (say, when the thing is undone some other
// way). Other files call it as:
//   if (typeof showUndo === 'function') showUndo(msg, fn); else showToast(msg);
let undoShown = null;        // the dismiss function of the bar on screen
function showUndo(message, onUndo, ms) {
  let bar = document.getElementById('undoBar');
  if (!bar) {
    // One bar, kept: a screen reader announces changes to a live region it
    // already knows, not one that has just appeared.
    bar = document.createElement('div');
    bar.id = 'undoBar';
    bar.className = 'undo-bar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.innerHTML = '<span class="undo-msg"></span><button type="button" class="undo-btn">Undo</button>';
    document.body.appendChild(bar);
  }
  if (undoShown) undoShown();
  let gone = false, timer = null;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    if (undoShown === dismiss) {
      undoShown = null;
      bar.classList.remove('on');
      document.documentElement.removeAttribute('data-undo');
    }
  };
  bar.querySelector('.undo-msg').textContent = String(message || 'Done');
  bar.querySelector('.undo-btn').onclick = () => {
    if (gone) return;
    dismiss();
    try { if (typeof onUndo === 'function') onUndo(); }
    catch (e) { console.error('[undo]', e); showToast('Could not undo that'); }
  };
  undoShown = dismiss;
  bar.classList.add('on');
  // Tells the stylesheet to lift the toast above the bar on a phone.
  document.documentElement.setAttribute('data-undo', '');
  timer = setTimeout(dismiss, ms > 0 ? ms : 7000);
  return dismiss;
}

// ---- No signal / still sending ----
// Nothing used to tell the crew their taps were waiting for signal: every
// change saves on the phone at once and goes when it can, which is right --
// but with no word of it, a clock-out in a dead spot looked lost, or got
// tapped again. A small pill says so (above the tab bar on a phone, at the
// top on a laptop). It never takes a tap or covers anything that does.
//   No signal at all: "No signal -- saved on this phone ..." (+ how many wait)
//   Signal, but a change still unsent after 4 seconds: "Sending N changes..."
// firebase-init.js counts the changes on their way (YDDb.pending) and says
// whenever that changes (the 'yd-pending' event).
(function signalPill() {
  const SLOW_MS = 4000;
  let pending = 0, oldest = 0, slowTimer = null;
  function pill() {
    let p = document.getElementById('netPill');
    if (!p) {
      p = document.createElement('div');
      p.id = 'netPill';
      p.className = 'net-pill';
      p.setAttribute('role', 'status');
      p.setAttribute('aria-live', 'polite');
      p.hidden = true;
      document.body.appendChild(p);
    }
    return p;
  }
  // Running with no cloud at all (no Firebase), nothing is ever sent, so
  // "it sends when there's signal" would not be true.
  const cloud = () => !(window.YDAuth && window.YDAuth.mode === 'local');
  function draw() {
    if (!document.body) return;
    const p = pill();
    const n = pending;
    let text = '', kind = '';
    if (cloud() && navigator.onLine === false) {
      text = 'No signal — saved on this ' + (phoneScreen() ? 'phone' : 'device') +
        ', it sends when there’s signal' + (n > 0 ? ' · ' + n + ' waiting' : '');
      kind = 'off';
    } else if (cloud() && n > 0 && oldest && Date.now() - oldest >= SLOW_MS) {
      text = 'Sending ' + n + (n === 1 ? ' change…' : ' changes…');
      kind = 'sending';
    }
    if (p.textContent !== text) p.textContent = text;
    p.className = 'net-pill' + (kind ? ' ' + kind : '');
    p.hidden = !text;
    // Lets the stylesheet lift the toast and the Undo bar above it.
    document.documentElement.toggleAttribute('data-netpill', !!text);
  }
  document.addEventListener('yd-pending', e => {
    const d = e.detail || {};
    pending = typeof d.n === 'number' ? d.n : 0;
    oldest = pending > 0 ? (d.oldest || Date.now()) : 0;
    clearTimeout(slowTimer);
    // Look again when the oldest change has been waiting long enough.
    if (oldest) slowTimer = setTimeout(draw, Math.max(0, oldest + SLOW_MS - Date.now()) + 50);
    draw();
  });
  window.addEventListener('online', draw);
  window.addEventListener('offline', draw);
  document.addEventListener('yd-auth', draw);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
})();

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('quoteDate').value = todayMD();
  resetDateInputs();
  document.getElementById('laborRateBadge').textContent = '@ $' + LABOR_RATE + '/hr';
  renderServiceTypes(); renderLabor(); renderMaterials(); renderAdditionalCosts(); renderPayments();
  syncStatusSelect(); renderProposal(); renderOrderList(); updateSummary(); updateCtxBar();
  TAP_OUTSIDE_CLOSES.forEach(closeOnTapOutside);

  migrateJobIndex();   // repair index entries from older versions (prices, fields, key scheme)

  // The last job worked on is put in the form, ready on the Job tab -- but
  // quietly: the app opens on Home now, not on the job.
  const idx = getJobIndex();
  if (idx.length) { idx.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || '')); loadJob(idx[0].id, true); }

  // Ask the browser to keep our data (reduces iOS/Safari eviction)
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }

  // Register the service worker so the app works offline once hosted (GitHub Pages, etc.)
  //
  // Not on localhost. The worker's whole job is to serve files from a cache,
  // which during development means serving the version of a file from before
  // the last edit -- and it does that silently, so a fix appears not to have
  // worked. Hours were lost to exactly that. Offline behaviour is still
  // testable on the deployed site, and Firestore's own offline persistence,
  // which is what actually protects a storm with no signal, runs either way.
  const LOCAL_DEV = ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) !== -1
    || /\.localhost$/.test(location.hostname);
  if ('serviceWorker' in navigator && !LOCAL_DEV) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => keepUpToDate(reg))
        .catch(err => console.log('SW registration skipped:', err.message));
    });
  }
  // A page left open all day kept running the old code: Jonah, 15 Oct 2026,
  // still saw a box ticked an hour after the fix went live ("explain why
  // this isnt fixed"). The browser only looks for a new version when a page
  // loads, so it is asked every 10 minutes and whenever the app comes back
  // into view. Once the new one has taken over, the page reloads itself at a
  // safe moment -- when it is out of view, or straight away if it is and
  // nothing typed would be lost -- and otherwise says so, with a Reload button.
  function keepUpToDate(reg) {
    const hadController = !!navigator.serviceWorker.controller;   // the very first install is not an update
    const ask = () => { reg.update().catch(() => {}); };
    setInterval(ask, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) ask(); });
    let waiting = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || waiting) return;
      waiting = true;
      if (document.hidden && safeToReload()) { location.reload(); return; }
      showUpdateBar();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && safeToReload()) location.reload();
      });
    });
  }
  // Nothing typed and unsaved, no window open, nothing still to send.
  function safeToReload() {
    if (typeof dirty !== 'undefined' && dirty) return false;
    if (document.querySelector('.modal-overlay.active')) return false;
    try { if (window.YDDb && YDDb.pending && YDDb.pending() > 0) return false; } catch (e) { /* treat as fine */ }
    return true;
  }
  function showUpdateBar() {
    if (document.getElementById('updBar')) return;
    const bar = document.createElement('div');
    bar.id = 'updBar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>Job Hub has been updated.</span> <button type="button" class="btn btn-sm btn-filled" onclick="reloadForUpdate()">Reload</button>';
    document.body.appendChild(bar);
  }
  window.reloadForUpdate = function () {
    if (!safeToReload() && !confirm('Something here isn’t saved yet. Reload anyway?')) return;
    location.reload();
  };
  // Clear out a worker registered by an earlier visit, or it keeps serving the
  // cache long after registration stopped.
  if ('serviceWorker' in navigator && LOCAL_DEV) {
    navigator.serviceWorker.getRegistrations()
      .then(rs => rs.forEach(r => r.unregister()))
      .then(() => caches && caches.keys().then(ks => ks.forEach(k => caches.delete(k))))
      .catch(() => {});
  }

  // Gentle backup reminder if it's been a while (or never) -- only for a
  // device saving jobs to itself alone. Signed in to the cloud, every job
  // is kept there already, and the tip was just noise on every launch.
  const backupTip = () => {
    if (!getJobIndex().length) return;
    let last = null;
    try { last = localStorage.getItem(STORAGE_PREFIX + 'lastBackup'); } catch (e) {}
    const stale = !last || (Date.now() - new Date(last).getTime()) > 30 * 864e5;
    if (stale) showToast('Tip: tap Backup to save a copy of your jobs');
  };
  setTimeout(() => {
    const a = window.YDAuth;
    if (a) { if (a.mode !== 'cloud') backupTip(); return; }
    // Sign-in has not finished on a slow phone: decide once it has.
    document.addEventListener('yd-auth', function once(e) {
      document.removeEventListener('yd-auth', once);
      if ((e.detail || {}).mode !== 'cloud') backupTip();
    });
  }, 3500);
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---- Rows that scroll sideways keep their place through a redraw ----
//
// Most screens are drawn whole again on every change (a card moved, a price
// saved, another phone's update), and a row scrolled along -- the board's
// columns, the weather hours, the snow route, a wide table -- came back at
// its start each time: swipe over, and it snapped back before the tap
// (Jonah, 15 Oct 2026). So each row's place is noted as it scrolls and put
// back on the row that takes its spot. A row is known by its data-keep
// (set where one row is drawn for many things, e.g. one per board, so a
// different board starts at its own start), else its id, else the nearest
// id above it + its classes + which one of those it is.
(function keepSidewaysPlace() {
  const ROWS = '[data-keep], .bd-cols, .rt-strip, .wxp-hours, .sum-pick, .srch-chips, .pr-index-links, ' +
    '.est-jump, .eq-filters, .sup-grid-wrap, .table-wrap';
  const places = new Map();
  function keyOf(row) {
    if (row.dataset.keep) return 'k:' + row.dataset.keep;
    if (row.id) return '#' + row.id;
    const home = row.parentElement && row.parentElement.closest('[id]');
    const cls = String(row.className || '').trim();
    if (!home || !cls) return '';
    return home.id + ' ' + cls + ' ' + Array.prototype.indexOf.call(home.getElementsByClassName(cls), row);
  }
  let slidAt = 0, pressed = false;
  document.addEventListener('scroll', e => {
    const row = e.target;
    if (!row || row.nodeType !== 1 || !row.matches(ROWS)) return;
    slidAt = Date.now();
    const key = keyOf(row);
    if (key) places.set(key, row.scrollLeft);
  }, true);
  // Someone sliding a row along right now: a finger or the mouse is down in
  // one, or it moved a moment ago (a flick keeps going after the finger
  // lifts). A screen that redraws by itself waits while this is so -- new
  // rows put in under the finger stop the slide dead and it jumps back to
  // where the last scroll said (Jonah, 15 Oct: the boards "cut back when
  // you try to slide over to the right").
  document.addEventListener('pointerdown', e => { pressed = !!(e.target.closest && e.target.closest(ROWS)); }, true);
  ['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, () => { pressed = false; }, true));
  window.ydSliding = () => pressed || Date.now() - slidAt < 500;
  function putBack(row) {
    const at = places.get(keyOf(row));
    if (at && !row.scrollLeft) row.scrollLeft = at;
  }
  new MutationObserver(changes => {
    if (!places.size) return;
    changes.forEach(c => c.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.matches(ROWS)) putBack(n);
      if (n.firstElementChild) n.querySelectorAll(ROWS).forEach(putBack);
    }));
  }).observe(document.body, { childList: true, subtree: true });
})();

// ---- Windows with something typed in them do not close on a stray tap ----
//
// Most windows close when the dark backdrop around them is tapped, which is
// handy for ones that only show things -- and costly for a half-filled form:
// a thumb landing just beside it threw away everything typed. Dragging to
// select text in a box and letting go outside the window did the same,
// because the browser counts that as a tap on the backdrop.
//
// So, for every window: a tap on the backdrop is ignored once anything has
// been typed in it since it opened, or when the press began inside the
// window. The × and Escape still close it, deliberately.
// ---- A time box opens its scrolling list of times when clicked ----------
//
// On a computer the browser only opens the list of hours and minutes from
// the small clock at the end of the box; a click anywhere else in it starts
// typing. Jonah (15 Oct 2026): "i dont want to have to type in the time ...
// i liked clicking it and having a scroll of the times come up". So a click
// anywhere in a time box opens the list. Phones already open their wheel.
document.addEventListener('click', e => {
  const box = e.target;
  if (!box || box.tagName !== 'INPUT' || box.type !== 'time' || box.disabled || box.readOnly) return;
  if (typeof box.showPicker !== 'function') return;
  try { box.showPicker(); } catch (err) { /* already open, or not allowed here: the box still works */ }
});

(function guardWindows() {
  let pressedOn = null;
  document.addEventListener('pointerdown', e => { pressedOn = e.target; }, true);
  document.addEventListener('input', e => {
    const o = e.target && e.target.closest && e.target.closest('.modal-overlay');
    if (o) o.dataset.typed = '1';
  }, true);
  // Captured on the way down, so it runs before the backdrop's own handler
  // and can stop it.
  document.addEventListener('click', e => {
    const o = e.target;
    if (!o || !o.classList || !o.classList.contains('modal-overlay')) return;
    const startedInside = pressedOn && pressedOn !== o && o.contains(pressedOn);
    if (!o.dataset.typed && !startedInside) return;
    e.stopPropagation();
    e.preventDefault();
    if (o.dataset.typed && !startedInside) showToast('Still open — Save, or close it with ×');
  }, true);
  // Each time a window opens it starts untouched.
  //
  // Watched across the whole page, not window by window: the windows made
  // later by a screen (a note for Jonah, a crew job, the notes list...) were
  // never watched, so once something had been typed in one it kept refusing
  // a tap outside on every later opening, with nothing typed at all.
  const opened = o => o.classList && o.classList.contains('modal-overlay') && o.classList.contains('active');
  const fresh = new MutationObserver(list => list.forEach(m => {
    const o = m.target;
    if (opened(o) && !/(^|\s)active(\s|$)/.test(String(m.oldValue || ''))) delete o.dataset.typed;
  }));
  function watch() {
    fresh.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();

// ═══════════════════════════════════════════════════════════
// SEARCHABLE DROPDOWNS
// ═══════════════════════════════════════════════════════════
// Long lists -- the services, the jobs -- had to be scrolled through. Any
// <select class="searchable"> gets a box in front of it to type into: every
// word typed must appear in an option, so "ret wall" finds Retaining Wall.
//
// The real <select> stays in the page, hidden, with its id, value and
// onchange. Picking sets its value and fires its own change event, so every
// handler that already reads it carries on unchanged.
function makeSearchable(sel) {
  if (!sel || sel.dataset.ssel) return;
  sel.dataset.ssel = '1';
  const wrap = document.createElement('div');
  wrap.className = 'ssel';
  // A margin set on the select belongs to the whole control now.
  if (sel.getAttribute('style')) wrap.setAttribute('style', sel.getAttribute('style'));
  if (sel.className) wrap.className += ' ' + sel.className.replace(/\bsearchable\b/, '').trim();
  const box = document.createElement('input');
  box.type = 'text';
  box.className = 'ssel-box';
  box.autocomplete = 'off';
  box.setAttribute('role', 'combobox');
  box.setAttribute('aria-expanded', 'false');
  if (sel.title) box.title = sel.title;
  const list = document.createElement('div');
  list.className = 'ssel-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(box);
  wrap.appendChild(list);
  wrap.appendChild(sel);
  sel.classList.add('ssel-native');
  sel.tabIndex = -1;

  let shown = [];     // [{ opt, typed }] on screen, in order
  let at = -1;        // the one the arrow keys are on
  const label = o => (o ? o.textContent.trim() : '');
  // An empty first option ("+ Add service type…", "All Services") is the
  // placeholder: it is what the empty box says, and in a filter it is the
  // way back to everything.
  const blank = () => { const o = sel.options[0]; return o && o.value === '' ? o : null; };
  // "Custom…" means "something not on the list": typing it straight into the
  // box is quicker than picking Custom and typing it again into a prompt.
  const custom = () => Array.prototype.find.call(sel.options, o => o.value === '__custom') || null;

  function sync() {
    const o = sel.options[sel.selectedIndex];
    box.value = o && o.value !== '' ? label(o) : '';
    box.placeholder = blank() ? label(blank()) : 'Search…';
    box.disabled = sel.disabled;
  }

  // At most SHOWN_MAX matches are drawn. The Supplies list (~900 items) drew
  // a row for every one at each key pressed, and nobody scrolls that far --
  // they type another word. The one already chosen is always kept, in its
  // place in the list, so it can be seen and picked again.
  const SHOWN_MAX = 50;
  function open(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const chosen = sel.options[sel.selectedIndex] || null;
    const matches = Array.prototype.filter.call(sel.options, o => !o.disabled && o.value !== '__custom' &&
      words.every(w => label(o).toLowerCase().indexOf(w) !== -1));
    shown = matches.filter((o, i) => i < SHOWN_MAX || o === chosen).map(o => ({ opt: o }));
    const more = matches.length - shown.length;
    const typed = String(q || '').trim();
    // Checked against every match, not only those drawn: a name further down
    // the list is not new.
    if (typed && custom() && !matches.some(o => label(o).toLowerCase() === typed.toLowerCase())) {
      shown.push({ typed: typed });
    } else if (!typed && custom()) {
      shown.push({ opt: custom() });
    }
    at = shown.findIndex(s => s.typed || s.opt.value !== '');
    if (at < 0) at = 0;
    list.innerHTML = shown.length
      ? shown.map((s, i) => '<div class="ssel-item' + (i === at ? ' on' : '') +
          (s.opt && s.opt.value === '' ? ' ssel-none' : '') + (s.typed ? ' ssel-new' : '') +
          '" role="option" data-i="' + i + '">' +
          (s.typed ? '+ Add “' + esc(s.typed) + '”' : esc(label(s.opt))) + '</div>').join('') +
        (more > 0 ? '<div class="ssel-more">Keep typing to narrow it down (' + more + ' more)</div>' : '')
      : '<div class="ssel-empty">Nothing matches “' + esc(typed) + '”</div>';
    list.hidden = false;
    box.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.hidden = true;
    box.setAttribute('aria-expanded', 'false');
    sync();
  }

  function pick(s) {
    if (!s) return;
    let temp = null;
    if (s.typed) {
      // Put the typed name in as an option for the moment, so the handler
      // reads it exactly as if it had been on the list all along.
      temp = new Option(s.typed, s.typed);
      temp.dataset.typed = '1';     // not one of the list's own (builtInServices)
      sel.appendChild(temp);
      sel.value = s.typed;
    } else {
      sel.value = s.opt.value;
    }
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    if (temp && temp.parentNode) temp.parentNode.removeChild(temp);
    close();
  }

  box.addEventListener('focus', () => { box.select(); open(''); });
  box.addEventListener('click', () => { if (list.hidden) open(''); });
  box.addEventListener('input', () => open(box.value));
  box.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { open(box.value); return; }
      if (!shown.length) return;
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      list.querySelectorAll('.ssel-item').forEach((n, i) => {
        n.classList.toggle('on', i === at);
        if (i === at) n.scrollIntoView({ block: 'nearest' });
      });
    } else if (e.key === 'Enter') {
      if (list.hidden) return;
      e.preventDefault();
      pick(shown[at]);
    } else if (e.key === 'Escape' && !list.hidden) {
      // Closes the list only, not the window it sits in.
      e.preventDefault();
      close();
    }
  });
  box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) close(); }, 0));
  // Pressing an item must not take the focus away from the box first.
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => {
    const n = e.target.closest('.ssel-item');
    if (n) pick(shown[+n.dataset.i]);
  });
  // Handlers often put the select back to its placeholder once they have
  // read it (adding a service), and filters rebuild their options.
  sel.addEventListener('change', () => setTimeout(sync, 0));
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  sync();
}

// Every searchable dropdown, including those drawn later by a screen.
(function () {
  function all(root) {
    if (root.matches && root.matches('select.searchable')) makeSearchable(root);
    if (root.querySelectorAll) root.querySelectorAll('select.searchable').forEach(makeSearchable);
  }
  function go() {
    all(document);
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1) all(n);
    }))).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
