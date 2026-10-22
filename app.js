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
// The last job worked on, put in the form the first time a job screen is
// shown (switchTab) rather than at launch: the app opens on Home, and
// building the whole job form and its estimate there was work nobody saw.
let launchJobId = null;
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
// 'complete' reads "Finished": the stage line below calls it that, and the
// two must never use different words for the same thing.
const JOB_STATUS = { quoting: 'Bid', booked: 'Booked', inprogress: 'In progress', complete: 'Finished' };
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

// ═══════════════════════════════════════════════════════════
// ONE STAGE PER JOB
// ═══════════════════════════════════════════════════════════
// Jonah, 15 Oct 2026: "One status per record, moving forward through fixed
// stages, instead of piles of yes/no boxes." A job used to say where it was
// in four places that could disagree -- its status, the Jobs board column,
// an "Invoiced in QuickBooks" tick and QuickBooks itself (the tick could say
// yes with no invoice there, or no with one). Now there is ONE answer, worked
// out here from what the job already holds, and every screen asks here:
//
//   Bid -> Booked -> In progress -> Finished -> Invoiced -> Paid   (or Lost, for a bid)
//
// - Bid / Lost / Booked / In progress / Finished come from jobStatus (and
//   bidStage 'lost'), as they always did.
// - Invoiced and Paid: when QuickBooks holds the job's invoice (qbInvoiceRef,
//   from the same QuickBooks company as its estimate), QuickBooks decides --
//   anything still owed is Invoiced, nothing owed is Paid. With no QuickBooks
//   invoice they are set by hand: the Jobs board column (workStage
//   'invoiced' / 'paid'), or the old tick (qbInvoiced) on jobs from before.
// - Only a finished job is Invoiced or Paid. The invoice is often made when
//   the estimate is accepted, for the deposit -- the job stays Booked or In
//   progress until the work is done.
//
// Nothing is rewritten: old jobs read the same fields they always had. The
// server works it out the same way (functions/stages.py stage_of) -- change
// both together.
const JOB_STAGES = [
  { id: 'bid', name: 'Bid' }, { id: 'booked', name: 'Booked' }, { id: 'inprogress', name: 'In progress' },
  { id: 'finished', name: 'Finished' }, { id: 'invoiced', name: 'Invoiced' }, { id: 'paid', name: 'Paid' },
];
const STAGE_NAMES = { bid: 'Bid', lost: 'Lost', booked: 'Booked', inprogress: 'In progress', finished: 'Finished', invoiced: 'Invoiced', paid: 'Paid' };
// The Jobs board's last three columns, for a finished job's stage.
const STAGE_COLUMN = { finished: 'toInvoice', invoiced: 'invoiced', paid: 'paid' };
// The job's QuickBooks invoice, or null. One made in the other QuickBooks
// company -- the test one, before the switch to the real books -- is not
// this job's (estimate.js and home.js ignore it the same way).
function qbInvoiceOf(d) {
  const r = d && d.qbInvoiceRef, q = d && d.qbEstimate;
  if (!r || !r.id) return null;
  return r.env && q && q.env && r.env !== q.env ? null : r;
}
// What QuickBooks says is still owed on it; NaN when it has not said.
function qbOwed(inv) {
  const b = inv && inv.balance;
  return b == null || b === '' ? NaN : Number(b);
}
// { id, name, qb (the QuickBooks invoice deciding Invoiced/Paid, or null),
//   byHand (a finished job's stage picked by hand) }.
function jobStage(d) {
  d = d || {};
  const st = normStatus(d.jobStatus, d);
  const one = (id, qb, byHand) => ({ id: id, name: STAGE_NAMES[id], qb: qb || null, byHand: !!byHand });
  if (st === 'quoting') return one(d.bidStage === 'lost' ? 'lost' : 'bid');
  if (st !== 'complete') return one(st);
  const inv = qbInvoiceOf(d);
  if (inv) {
    const owed = qbOwed(inv);
    return one(isFinite(owed) && owed <= 0.004 ? 'paid' : 'invoiced', inv);
  }
  const ws = d.workStage;
  if (ws === 'paid') return one('paid', null, true);
  if (ws === 'invoiced' || d.qbInvoiced) return one('invoiced', null, true);
  return one('finished');
}
// The stage as a coloured pill. A bid keeps its old colour class (quoting).
function stagePill(stageId) {
  const cls = stageId === 'bid' ? 'quoting' : stageId === 'finished' ? 'complete' : stageId;
  return '<span class="pill ' + esc(cls) + '">' + esc(STAGE_NAMES[stageId] || STAGE_NAMES.bid) + '</span>';
}

// What the customer is billed, and the tax on it -- for Balance Due on
// Tracking and the cost summary. The job's own "Taxable — WI 5.5%" box is
// retired (it added 5.5% to the whole job and disagreed with the estimate's
// own tax). The tax is the one QuickBooks or the estimate works out:
// - a QuickBooks invoice: its total, tax and all (what the customer owes);
// - else the estimate's sales tax (pricing.js), as sent to QuickBooks
//   (est.sent), as brought in from it (est.fromQb), or as priced now;
// - else an old job with the box ticked keeps its 5.5% -- its total does not
//   change by itself -- with a line saying so and a button to stop it.
// d: { jobPrice (number), estimate, city, qbInvoiceRef, qbEstimate, taxable }.
const OLD_TAX_PCT = 5.5;    // what the retired box always added
function estimateTaxCents(est, city) {
  if (!est) return 0;
  const sent = Array.isArray(est.sent) && est.sent.length ? est.sent[est.sent.length - 1] : null;
  if (sent && isFinite(Number(sent.taxCents))) return Math.max(0, Math.round(Number(sent.taxCents)));
  if (est.fromQb && isFinite(Number(est.fromQb.taxCents)) && !est.reprice) return Math.max(0, Math.round(Number(est.fromQb.taxCents)));
  if (!((est.work || []).length || (est.materials || []).length) || !window.YDEstimate || !YDEstimate.priceSaved) return 0;
  try {
    const r = YDEstimate.priceSaved(est, city || '');
    return r && r.tax && r.tax.cents > 0 ? Math.round(r.tax.cents) : 0;
  } catch (e) { return 0; }
}
function jobBill(d) {
  const price = round2(Number(d.jobPrice) || 0);
  const inv = qbInvoiceOf(d);
  const total = inv ? Number(inv.total) : NaN;
  if (inv && isFinite(total)) return { subtotal: price, tax: 0, total: round2(total), from: 'qb', inv: inv, oldBox: !!d.taxable };
  const estTax = round2(estimateTaxCents(d.estimate, d.city) / 100);
  if (estTax > 0) return { subtotal: price, tax: estTax, total: round2(price + estTax), from: 'estimate', inv: null, oldBox: !!d.taxable };
  if (d.taxable) {
    const tax = round2(price * OLD_TAX_PCT / 100);
    return { subtotal: price, tax: tax, total: round2(price + tax), from: 'oldBox', inv: null, oldBox: true };
  }
  return { subtotal: price, tax: 0, total: price, from: '', inv: null, oldBox: false };
}
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
// lostReason / lostReasonText / lostAt: why a bid was lost, picked when it
// was marked lost (askLostReason). deletedAt / deletedBy / deletedByName: a
// job moved to Recently deleted (deleteJob) -- a form save must not bring it
// back to life by leaving them out.
// customerId / customerBy: the customer the job is for (customers.js) -- tied
// by id, never by the spelling of a name; 'hand' when Jonah picked it.
const BOARD_FIELDS = ['bidStage', 'bidStageAt', 'workStage', 'workStageAt', 'cardColor', 'followUps', 'qbEstimate', 'qbInvoiceRef', 'careEmail', 'acceptedSeenAt',
  'costByHand', 'completedAt', 'careDone', 'hasPlants', 'fromQuickBooks', 'qbFilled', 'snowChecked', 'removeWhy', 'replacedBy', 'removeNote',
  'lostReason', 'lostReasonText', 'lostAt', 'deletedAt', 'deletedBy', 'deletedByName',
  'customerId', 'customerBy'];
let boardFields = {};
// Two retired boxes, kept on the job as they were (no data lost, and a
// device still on the old code keeps reading them): qbInvoiced, the old
// "Invoiced in QuickBooks" tick (jobStage still reads it on a job with no
// QuickBooks invoice), and taxable, the old "Taxable — WI 5.5%" box (jobBill).
let qbInvoicedFlag = false;
let oldTaxable = false;
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
  // Older jobs hold rows typed as a day with a start and an end ("08:15" to
  // "11:30"). Those used to count as nothing at all, so a job typed in that
  // way showed no labour and its whole price as profit.
  const from = typedClock(e.start), to = typedClock(e.end);
  if (from != null && to != null && to > from) return (to - from) / 60;
  return 0;
}
// A time as typed on a labour row -- "08:15", "8:15 pm" -- as minutes after
// midnight; null when it is not a time.
function typedClock(t) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?\.?\s*$/i.exec(String(t == null ? '' : t));
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  if (m[3]) { if (h === 12) h = 0; if (/p/i.test(m[3])) h += 12; }
  return h < 24 && min < 60 ? h * 60 + min : null;
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

// The writing on a filled colour (a calendar block, a board label): white,
// unless the colour is too light for white to read -- the doctor's yellow,
// the to-do lime -- when it is near-black. Worked out from the colour, so a
// colour picked later never comes out unreadable.
function inkOn(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#fff';
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
  const lin = i => { const v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return 1.05 / (L + 0.05) >= 3.2 ? '#fff' : '#1d1a14';
}

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
      && !(await ydConfirm('You have unsaved changes on this job.\n\nSign out anyway?',
        { title: 'Unsaved changes', ok: 'Sign out anyway', cancel: 'Stay', danger: true }))) return;
  // Signing out is not clocking out: a shift left running keeps running (the
  // clock stops it only at its hour limit), so whoever is on the clock is
  // told -- signing out at the end of the day looked like the same thing.
  const mine = window.YDClock && YDClock.mine && !(window.YDAuth || {}).isOwner ? YDClock.mine() : null;
  const onClock = mine && mine.shift && !mine.shift.leaving ? mine.shift : null;
  const said = onClock
    ? 'You are still on the clock (' + (onClock.where || 'working') + '). Signing out does not clock you out — the clock keeps running.\n\nThis device will need to sign in again.'
    : crewView() ? 'Everything is kept in the cloud. This device will need to sign in again.'
    : 'Your jobs stay safe in the cloud. This device will need to sign in again.';
  if (!(await ydConfirm(said, { title: 'Sign out of YD Job Hub?', ok: 'Sign out', danger: !!onClock }))) return;

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
  ['tabJob', 'tabTracking', 'tabDashboard', 'matSeasonSection', 'ordersSection'].forEach(id => {
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
// The stylesheet stops taps, but not a keyboard: on a computer, or an iPad
// with one, Tab still walked into the fields and typing changed them on
// screen, the bar saying "Saving…" for ever while persistJob refused (office
// test, 16 Oct 2026). So nothing there keeps the focus either -- except the
// buttons that only show or copy something, which the stylesheet lets
// through (.ro-ok: What the customer sees, Show my numbers, Copy cost
// summary, the estimate's section links...; jobcosts.js's .eva-view-btn).
// A button marked so must write nothing: it is all a look-only admin has.
function lockedJobControl(t) {
  return !!(document.documentElement.hasAttribute('data-jobs-readonly') && t && t.closest && t.matches &&
    t.closest('#panel-job, #panel-tracking') && t.matches('input, select, textarea, button') && !t.matches('.eva-view-btn, .ro-ok'));
}
document.addEventListener('focusin', e => { if (lockedJobControl(e.target)) e.target.blur(); }, true);
// And should one still have the focus (a browser that was in the
// background when it was given it tells no one), typing, pasting or a drop
// into it changes nothing.
document.addEventListener('beforeinput', e => { if (lockedJobControl(e.target)) e.preventDefault(); }, true);

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
    : []).concat(signedIn && typeof window.openServices === 'function'
    ? [(window.YDAuth.isOwner
        ? { label: '🧰 Services', hint: 'The services list, by kind of work, and what to tell a homeowner' }
        : { label: '🧰 What we do', hint: 'Each service in a line, and what it includes — for talking to a homeowner' })]
        .map(x => Object.assign(x, { call: 'closeMore(); openServices()' }))
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
  if (!m.hidden) fitHeaderMenu(m);
}
// Crew testing, 16 Oct 2026: at about 768px tall the owner's menu had to be
// scrolled to reach Problems and Sign out. Where one column would not fit
// the screen and there is room across, the groups go in two (styles.css
// .menu-two) -- a short menu, the crew's, stays one column. A phone keeps
// one column, scrolled, with Sign out held at its foot.
function fitHeaderMenu(m) {
  m.classList.remove('menu-two');
  if (!window.matchMedia('(min-width:721px)').matches) return;
  if (m.scrollHeight > m.clientHeight + 1) m.classList.add('menu-two');
}
window.addEventListener('resize', () => {
  const m = document.getElementById('headerMenu');
  if (m && !m.hidden) fitHeaderMenu(m);
});
function tidyHeaderMenu(m) {
  // Search and All settings come from search.js, when it is there.
  const signedIn = !!(window.YDAuth && window.YDAuth.user);
  const search = document.getElementById('menuSearch');
  if (search) search.hidden = !(signedIn && typeof window.openSearch === 'function');
  const all = document.getElementById('menuSettings');
  if (all) all.hidden = !(signedIn && typeof window.openSettings === 'function');
  // The sidebar preview: only where it can show (a laptop-wide window).
  const side = document.getElementById('menuSidebar');
  if (side) {
    side.hidden = !sidebarFits();
    side.textContent = sidebarStored(SIDEBAR_KEY) ? '▤ Back to the tab bar' : '🧭 Try the new sidebar (preview)';
  }
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
  if (!close) return;
  // Something typed in it (guardWindows marks that): one Esc pressed out of
  // habit threw a half-written card or account away without a word (16 Oct
  // 2026). The first press says so; a second within a few seconds closes.
  // Not the app's own one-line questions (ydAsk): Esc there is "no", as it
  // was on the browser's boxes.
  if (top.dataset.typed && !top.classList.contains('ask-overlay') && !(escArmed === top && Date.now() - escArmedAt < 4000)) {
    escArmed = top; escArmedAt = Date.now();
    showToast('Something is typed in here — press Esc again to close without saving');
    return;
  }
  escArmed = null;
  close.click();
});
let escArmed = null, escArmedAt = 0;

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
  // First time on a job screen: the last job worked on goes in the form.
  if (launchJobId && ['job', 'tracking', 'dashboard'].indexOf(name) !== -1) {
    const id = launchJobId;
    launchJobId = null;
    if (!currentJobId) loadJob(id, true);
  }
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
  if (name === 'supplies') renderOrdersOverview();
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
  // The name in a span of its own: on a phone a long name is cut short with
  // "…", and the pill after it must not be cut off with it. The pill is the
  // job's one stage (jobStage) -- it used to be the status plus a separate
  // "QB Invoiced" chip that could disagree with it.
  document.getElementById('ctxName').innerHTML = '<span class="ctx-name-text">' + esc(name || (currentJobId ? 'Untitled Job' : 'New Job')) + '</span>';
  const stage = jobStage(formStageData());
  const st = document.getElementById('ctxStatus');
  st.textContent = stage.name; st.className = 'pill ' + (stage.id === 'bid' ? 'quoting' : stage.id === 'finished' ? 'complete' : stage.id);
  renderStageSteps();
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
async function addServiceType() {
  const sel = document.getElementById('serviceTypeSelect');
  let val = sel.value;
  if (!val) return;
  if (val === '__custom') {
    sel.value = '';
    val = await ydPrompt('The service, in a word or two:', '', { title: 'Add a service', placeholder: 'e.g. Gutter cleaning', ok: 'Add' });
    if (!val || !val.trim()) return;
    val = val.trim();
  }
  sel.value = '';
  if (window.YDServices) val = window.YDServices.canon(val);
  if (window.rememberService) rememberService(val);
  // Only a real change marks the job unsaved -- a cancelled custom type or a
  // type already on the job used to trigger an autosave of nothing.
  if (serviceTypes.includes(val)) return;
  serviceTypes.push(val);
  renderServiceTypes();
  markDirty();
}

// The list itself -- what is offered here, on Contacts, Customers and the
// subcontractors' properties, its kinds of work and what to tell a homeowner
// about each -- lives in services.js (settings/serviceList). A service typed
// in here joins it (rememberService); an old spelling becomes the name it
// was merged into (YDServices.canon).
function removeServiceType(idx) { serviceTypes.splice(idx, 1); renderServiceTypes(); markDirty(); }
function renderServiceTypes() {
  const wrap = document.getElementById('serviceTypeTags');
  if (!serviceTypes.length) { wrap.innerHTML = '<span class="tag-none">No service types</span>'; scheduleJobTools(); return; }
  wrap.innerHTML = serviceTypes.map((s, i) => '<span class="svc-tag">' + esc(s) + '<button onclick="removeServiceType(' + i + ')">×</button></span>').join('');
  scheduleJobTools();
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
    boardFields.workStage = window.YDSync.finishedStage(Object.assign(formStageData(), { workStage: boardFields.workStage }));
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
  const why = lost ? lostWhy(boardFields) : '';
  const edits = !jobsReadOnly();
  if (t) t.innerHTML = lost ? '<b>This bid was lost' + (why ? ' — ' + esc(why) : '') + '.</b> It is off the Bids board and the customer is on Contacts for next season.' +
      (edits ? ' <button type="button" class="link-btn" onclick="changeLostReason()">' + (why ? 'Change why' : 'Say why') + '</button>' : '')
    : '<b>This is a bid.</b> It is on the Bids board, not in your job list, until you book it.';
  if (r) r.hidden = !lost;
  const l = document.getElementById('bidLostBtn');
  if (l) l.hidden = lost || !edits;
  // Called whenever a job loads or its status changes: the invoice boxes
  // follow whether it is a bid.
  showJobQbFields(true);
}

// The job's QuickBooks invoice (made from its estimate, quickbooks.py), or
// null -- qbInvoiceOf, on the job open in the form.
function formQbInvoice() { return qbInvoiceOf(boardFields); }
// The open job, as much of it as its stage is worked out from (jobStage).
function formStageData() {
  return { jobStatus: jobStatus, bidStage: boardFields.bidStage, workStage: boardFields.workStage,
    qbInvoiceRef: boardFields.qbInvoiceRef, qbEstimate: boardFields.qbEstimate, qbInvoiced: qbInvoicedFlag };
}
// The invoice number box on the Job tab. A bid has no invoice yet, so
// "QuickBooks Invoice #" is put away on one -- unless something is already
// in it. Once QuickBooks holds the invoice, a line says its number and what
// is still owed, and the box goes when it is empty or says the same number
// (one typed in by hand for another invoice stays). Only hidden, never
// removed -- getJobData() still reads it. The old "Invoiced in QuickBooks"
// tick is gone: the stage line above says it (renderStageSteps).
// Which boxes show is worked out again only when the job, its status or its
// invoice changes (`again`, or a new key), never on a keystroke: clearing
// the number on a bid must not make the box vanish under the cursor.
let jobQbShownFor = null;
function showJobQbFields(again) {
  const box = document.getElementById('qbInvoice');
  const field = document.getElementById('qbInvoiceField');
  const line = document.getElementById('jobQbLine');
  if (!box || !field || !line) return;
  const inv = formQbInvoice(), bid = isBidStatus(jobStatus);
  if (inv) {
    const owed = qbOwed(inv);
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
  // Never hide a box while it is being typed in.
  if (!(fieldOff && field.contains(document.activeElement))) field.hidden = fieldOff;
}

// The stage line on the Job tab, in place of the Status list and the
// "Invoiced in QuickBooks" tick: Bid -> Booked -> In progress -> Finished ->
// Invoiced -> Paid, one tap button each (they wrap on a phone -- never a
// sideways-scroll row), the job's own stage lit, the ones it has passed
// ticked. Lost sits beside Bid while the job is a bid. Invoiced and Paid are
// QuickBooks' to say when it holds the invoice; tappable only when it does
// not (cash, a check, a job invoiced some other way).
function renderStageSteps() {
  const wrap = document.getElementById('jobStageSteps');
  if (!wrap) return;
  const cur = jobStage(formStageData());
  const ro = jobsReadOnly();
  const at = cur.id === 'lost' ? 0 : JOB_STAGES.findIndex(s => s.id === cur.id);
  const inv = formQbInvoice();
  const qbSays = id => !!inv && (id === 'invoiced' || id === 'paid' || (id === 'finished' && !!cur.qb));
  const btn = (s, i) => {
    const on = s.id === cur.id;
    const past = cur.id !== 'lost' && i >= 0 && i < at;
    const locked = !on && (ro || qbSays(s.id));
    return '<button type="button" class="stage-step' + (on ? ' on' : '') + (past ? ' past' : '') + (s.id === 'lost' ? ' lost' : '') + '"' +
      (on ? ' aria-current="step"' : '') + (locked ? ' disabled' : '') +
      ' onclick="pickStage(\'' + s.id + '\')">' + (past ? '✓ ' : '') + esc(s.name) + '</button>';
  };
  const bidish = cur.id === 'bid' || cur.id === 'lost';
  wrap.innerHTML = bidish
    ? btn(JOB_STAGES[0], 0) + btn({ id: 'lost', name: 'Lost' }, -1) + JOB_STAGES.slice(1).map((s, i) => btn(s, i + 1)).join('')
    : JOB_STAGES.map(btn).join('');
  // One line under it, only when it has something to say.
  const note = document.getElementById('jobStageNote');
  if (!note) return;
  let say = '';
  if (cur.qb) {
    const owed = qbOwed(cur.qb);
    say = (cur.id === 'paid' ? 'Paid' : 'Invoiced') + ' — from QuickBooks invoice' + (cur.qb.docNumber ? ' #' + esc(cur.qb.docNumber) : '') +
      (isFinite(owed) && owed > 0 ? ' (' + fmtMoney(owed) + ' still owed — it moves to Paid once that is paid)' : '') + '.';
  } else if (inv && !bidish) {
    // The deposit invoice, made before the work is done.
    say = 'QuickBooks has invoice' + (inv.docNumber ? ' #' + esc(inv.docNumber) : '') +
      ' for this job — once it is Finished, Invoiced and Paid follow it.';
  } else if (cur.byHand) {
    say = esc(cur.name) + ' set by hand — QuickBooks has no invoice for this job.';
  }
  note.innerHTML = say;
  note.hidden = !say;
}
// A stage button tapped. Moving between Bid, Booked, In progress and Finished
// is the old Status list (onStatusChange, so the boards, the order list and
// the plant-care email follow exactly as before); Invoiced / Paid by hand
// set the finished job's Jobs board column.
function pickStage(id) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  const cur = jobStage(formStageData());
  if (id === cur.id) return;
  // Lost is a bid's end: the button shows only on a bid.
  if (id === 'lost') { if (cur.id === 'bid') markBidLost(); return; }
  // A lost bid back on the Bids board: they called back.
  if (id === 'bid' && cur.id === 'lost') {
    if (currentJobId) reopenBid();
    else { boardFields.bidStage = 'followUp'; updateCtxBar(); }
    return;
  }
  const inv = formQbInvoice();
  if ((id === 'invoiced' || id === 'paid' || id === 'finished') && cur.qb) {
    showToast('QuickBooks decides this one — invoice' + (cur.qb.docNumber ? ' #' + cur.qb.docNumber : '') +
      '. Log the payment (Tracking → Payments) and it moves to Paid.', 6000);
    return;
  }
  if ((id === 'invoiced' || id === 'paid') && inv) {
    showToast('Tap Finished — QuickBooks has the invoice' + (inv.docNumber ? ' (#' + inv.docNumber + ')' : '') +
      ', so Invoiced and Paid follow it.', 6000);
    return;
  }
  const status = id === 'bid' ? 'quoting' : id === 'booked' ? 'booked' : id === 'inprogress' ? 'inprogress' : 'complete';
  const at = new Date().toISOString();
  // From a bid (or a lost one) to a job: it was won, as "Make it a job" does.
  if (status !== 'quoting' && isBidStatus(jobStatus)) { boardFields.bidStage = 'won'; boardFields.bidStageAt = at; }
  if (status !== jobStatus) {
    document.getElementById('jobStatusSelect').value = status;
    onStatusChange();
  }
  // A finished job's stage by hand (no QuickBooks invoice): its Jobs board
  // column. Back to Finished also takes off the old tick, which would
  // otherwise keep it Invoiced.
  if (status === 'complete' && !inv) {
    const col = STAGE_COLUMN[id];
    if (boardFields.workStage !== col) { boardFields.workStage = col; boardFields.workStageAt = at; }
    if (id === 'finished') qbInvoicedFlag = false;
  }
  markDirty();
  updateCtxBar();
}
// A lost bid back on the board, in Follow up -- they called back.
function reopenBid(id) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  id = id || currentJobId;
  if (!id || !window.YDSync) return;
  // No longer lost, so no reason for it either (the counts on All Jobs).
  if (!window.YDSync.patchJob(id, { bidStage: 'followUp', bidStageAt: new Date().toISOString(), jobStatus: 'quoting',
      lostReason: null, lostReasonText: null, lostAt: null })) {
    showToast('Could not put that bid back');
    return;
  }
  if (id === currentJobId) showBidBanner();
  showToast('Back on the Bids board, under Follow up');
  if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
}
// ---- Why a bid was lost ------------------------------------------------------
// Jonah (15 Oct 2026): "A reason when a bid is lost ... so you can see why you
// lose bids." Asked with tap buttons every time a bid is marked lost -- on the
// Bids board (dragged to Lost, or Mark lost on a card QuickBooks says was
// turned down), from the Job tab and from My Jobs -- and changeable later from
// the same places. Cancel leaves the bid as it was. Kept on the job:
// lostReason (one of these ids), lostReasonText (the words for Other) and
// lostAt. The words, never a price, also go on the customer's contact.
const LOST_REASONS = [
  { id: 'price', name: 'Price' },
  { id: 'timing', name: 'Timing' },
  { id: 'competitor', name: 'Went with someone else' },
  { id: 'diy', name: 'Doing it themselves' },
  { id: 'noReply', name: 'No reply' },
  { id: 'dropped', name: 'Project dropped' },
  { id: 'qb', name: 'Turned down in QuickBooks' },
  { id: 'other', name: 'Other' },
];
function lostReasonName(id) { const r = LOST_REASONS.find(x => x.id === id); return r ? r.name : ''; }
// The reason in words -- "Price", "Other: moving out of state" -- or '' for a
// bid lost before reasons were asked.
function lostWhy(d) {
  if (!d || !d.lostReason) return '';
  const text = String(d.lostReasonText || '').trim();
  if (d.lostReason === 'other') return text ? 'Other: ' + text : 'Other';
  return lostReasonName(d.lostReason) || '';
}
function lostChipHtml(d) {
  const w = lostWhy(d);
  return w ? '<span class="lost-why" title="Why it was lost">' + esc(w) + '</span>' : '';
}
// The question, in a window of its own: a button per reason, one tap and it
// is done; Other opens a short box for the words. `opts`: name (whose bid),
// preset (a reason already known -- QuickBooks says turned down -- shown
// picked), text (Other's words so far), ok / cancel (button words).
let lostAsking = null;     // { done } while the window is open
function askLostReason(opts, done) {
  opts = opts || {};
  let m = document.getElementById('lostModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal-overlay';
    m.id = 'lostModal';
    m.onclick = e => { if (e.target === m) closeLostReason(); };
    document.body.appendChild(m);
  }
  lostAsking = { done: done };
  const pre = LOST_REASONS.some(r => r.id === opts.preset) ? opts.preset : '';
  m.innerHTML = '<div class="modal lost-modal" style="max-width:480px"><div class="modal-head"><h2>' + esc(opts.title || 'Why was the bid lost?') + '</h2>' +
      '<button class="modal-close" onclick="closeLostReason()" aria-label="Cancel">&times;</button></div>' +
    '<div class="modal-body">' +
      (opts.name ? '<div class="lost-name">' + esc(opts.name) + '</div>' : '') +
      '<div class="lost-opts">' + LOST_REASONS.map(r =>
        '<button type="button" class="lost-opt' + (pre === r.id ? ' on' : '') + '" data-why="' + r.id + '" onclick="pickLostReason(\'' + r.id + '\')">' +
          esc(r.name) + '</button>').join('') + '</div>' +
      '<div class="lost-other" id="lostOtherRow"' + (pre === 'other' ? '' : ' hidden') + '>' +
        '<input id="lostOtherText" maxlength="200" placeholder="Why, in a few words" value="' + esc(opts.text || '') + '" ' +
          'onkeydown="if(event.key===\'Enter\'){event.preventDefault();saveLostOther()}">' +
        '<button type="button" class="btn btn-sm btn-filled" onclick="saveLostOther()">' + esc(opts.ok || 'Mark lost') + '</button></div>' +
      (pre && pre !== 'other' ? '<div class="hint" id="lostPreHint">' + esc(lostReasonName(pre)) + ' is picked already — tap it to keep it, or tap another.</div>' : '') +
      '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="closeLostReason()">' + esc(opts.cancel || 'Cancel — not lost') + '</button></div>' +
    '</div></div>';
  m.classList.add('active');
}
function closeLostReason() {
  lostAsking = null;
  const m = document.getElementById('lostModal');
  if (m) m.classList.remove('active');
}
function pickLostReason(id) {
  if (id === 'other') {
    const row = document.getElementById('lostOtherRow');
    document.querySelectorAll('#lostModal .lost-opt').forEach(b => b.classList.toggle('on', b.dataset.why === 'other'));
    const hint = document.getElementById('lostPreHint');
    if (hint) hint.hidden = true;
    if (row) { row.hidden = false; const box = document.getElementById('lostOtherText'); if (box) box.focus(); }
    return;
  }
  finishLostReason(id, null);
}
function saveLostOther() {
  const box = document.getElementById('lostOtherText');
  const text = box ? box.value.trim() : '';
  if (!text) { showToast('Say why in a few words'); if (box) box.focus(); return; }
  finishLostReason('other', text.slice(0, 200));
}
function finishLostReason(id, text) {
  const ask = lostAsking;
  closeLostReason();
  if (ask && ask.done) ask.done({ lostReason: id, lostReasonText: text || null });
}
// Mark lost from the Job tab or My Jobs: the same move as dragging the card
// to Lost on the Bids board (boards.js), which asks why, puts the customer on
// Contacts and says so.
function markBidLost(id) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  id = id || currentJobId;
  if (!id && typeof autosave === 'function') { autosave(); id = currentJobId; }
  if (!id) return;
  if (id === currentJobId && dirty) autosave();
  if (window.bdMarkLost) window.bdMarkLost(id);
  else showToast('Could not mark that bid lost');
}
// The reason changed afterwards. When it was lost stays as it was.
function changeLostReason(id) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  id = id || currentJobId;
  let d = null;
  try { d = JSON.parse(readJobBlob(id) || 'null'); } catch (e) {}
  if (!d) return;
  if (id === currentJobId && dirty) autosave();
  askLostReason({ title: 'Why was the bid lost?', name: d.customerName || '', preset: d.lostReason, text: d.lostReasonText,
    ok: 'Save', cancel: 'Cancel' }, why => {
    const patch = Object.assign({}, why, d.lostAt ? {} : { lostAt: d.bidStageAt || new Date().toISOString() });
    if (!patchJobAnywhere(id, patch)) { showToast('Could not change that'); return; }
    invalidateJobsCache();
    if (id === currentJobId) showBidBanner();
    if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
    showToast('Why it was lost: ' + lostWhy(Object.assign({}, d, why)));
  });
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
  reader.onload = async function(e) {
    try {
      const data = JSON.parse(e.target.result);
      const est = data.estimateNumber ? String(data.estimateNumber) : '';

      // De-dupe: if a proposal with this estimate # is already loaded, offer to replace it
      if (est) {
        const existing = proposals.find(p => String(p.data.estimateNumber || '') === est);
        if (existing) {
          if (await ydConfirm('Estimate #' + est + ' is already imported. Replace it with this file, or keep both?',
                { title: 'Already imported', ok: 'Replace it', cancel: 'Keep both' })) {
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
  if (manualJobPrice) { tag.textContent = '(manual)'; tag.style.color = 'var(--accent-ink)'; }
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
async function removeProposal(propId) {
  if (!(await ydConfirm('Its imported order items are taken off too.', { title: 'Remove this proposal?', ok: 'Remove', danger: true }))) return;
  proposals = proposals.filter(p => p.id !== propId);
  orderItems = orderItems.filter(m => m.proposalId !== propId);
  syncJobPriceFromProposals(); renderProposal(); renderOrderList(); markDirty();
}
async function editProposalLabel(propId) {
  const p = proposals.find(p => p.id === propId); if (!p) return;
  const nl = await ydPrompt('', p.label, { title: 'Proposal label', ok: 'Save' });
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
  // The job's tools sit beside the materials when the proposal box goes.
  if (pair) pair.classList.toggle('single', unused && !document.getElementById('jobToolsSection'));
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
        '<button class="dup-btn" onclick="editProposalLabel(\'' + ordId(p.id) + '\')">EDIT</button></div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:4px">' + (total > 0 ? '<strong>' + fmtMoney(total) + '</strong>' : 'No total') +
        ' · ' + cnt + ' material' + (cnt !== 1 ? 's' : '') + '</div></div>' +
      '<button class="btn btn-sm btn-danger" onclick="removeProposal(\'' + ordId(p.id) + '\')">Remove</button></div>';
  });
  html += '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
    '<button class="btn btn-filled btn-sm" onclick="document.getElementById(\'proposalFileInput\').click()">+ Add Another</button>' +
    (manualJobPrice ? '<button class="btn btn-sm" onclick="resetJobPriceToAuto()">↺ Job Price to Auto</button>' : '') + '</div>';
  content.innerHTML = html;
  status.textContent = proposals.length + ' proposal' + (proposals.length > 1 ? 's' : '');
  updateJobPriceSourceTag();
}

// ═══════════════════════════════════════════════════════════
// TOOLS FOR THIS JOB (beside Materials to Order)
// ═══════════════════════════════════════════════════════════
// Jonah (16 Oct 2026): "have jobs auto compile a tool list based on what
// services the job has and make that list viewable by the crew on the front
// page of the job ... i want tool list right by the material list." The list
// is put together from the job's services (and the estimate's lines of
// work) by services.js toolsFor -- each service's tools are picked once in
// ⋯ → Services. Only what is changed by hand on THIS job is kept on it:
// job.tools = { added: [{ eq, name, kind } | { name, qty }], dropped: [key] }.
// The crew see the result on their page of the job (crewjobs.js).
let jobToolsOwn = { added: [], dropped: [] };
function jobToolsFrom(t) {
  t = t && typeof t === 'object' ? t : {};
  return { added: Array.isArray(t.added) ? t.added.filter(x => x && (x.eq || x.name)).map(x => Object.assign({}, x)) : [],
           dropped: Array.isArray(t.dropped) ? t.dropped.map(String) : [] };
}
function jobToolsNow() {
  if (!window.YDServices || !window.YDServices.toolsFor) return null;
  return window.YDServices.toolsFor({ serviceTypes: serviceTypes, tools: jobToolsOwn,
    estimate: window.YDEstimate ? window.YDEstimate.get() : null });
}
let jobToolsTimer = null;
function scheduleJobTools() { clearTimeout(jobToolsTimer); jobToolsTimer = setTimeout(renderJobTools, 250); }
function renderJobTools() {
  const wrap = document.getElementById('jobToolsWrap');
  if (!wrap) return;
  const r = jobToolsNow();
  const badge = document.getElementById('jobToolsBadge');
  if (!r) { wrap.innerHTML = ''; return; }
  const owner = !!(window.YDAuth && window.YDAuth.isOwner);
  const groups = [], at = {};
  r.tools.forEach(t => {
    const g = t.eq ? t.kindName : 'Hand tools';
    if (!(g in at)) { at[g] = groups.length; groups.push({ name: g, list: [] }); }
    groups[at[g]].list.push(t);
  });
  const chip = t => '<span class="jt-chip' + (t.eq ? ' jt-eq' : '') + (t.byHand ? ' jt-hand' : '') + (t.sug ? ' jt-sug' : '') + '" title="' +
      esc(t.byHand ? 'Added on this job' : (t.sug ? 'Suggested for ' : 'From ') + t.from.join(', ')) + '">' +
      esc((t.qty ? t.qty + ' × ' : '') + t.name) + (t.byHand ? ' <small>added here</small>' : '') +
      '<button type="button" data-k="' + esc(t.key) + '" onclick="jobToolOff(this.dataset.k)" aria-label="Not needed on this job">×</button></span>';
  const none = r.services.filter(v => !v.has);
  const pick = v => owner ? '<button type="button" class="link-btn" data-n="' + esc(v.name) + '" onclick="openServiceTools(this.dataset.n)">' + esc(v.name) + ' ✎</button>'
    : esc(v.name);
  const html =
    (r.tools.length ? groups.map(g => '<div class="jt-sub">' + esc(g.name === 'Hand tools' ? g.name : (/s$/i.test(g.name) || /\s/.test(g.name) ? g.name : g.name + 's')) +
        '</div><div class="jt-chips">' + g.list.map(chip).join('') + '</div>').join('')
      : '<p class="empty-msg">' + (serviceTypes.length || r.services.length ? 'No tools yet for this job’s services.' :
        'Add the job’s services above — the tools each one takes show here.') + '</p>') +
    // Those services list their suggested tools (dashed) until he picks.
    (none.length ? '<div class="hint jt-none">No tools picked yet for: ' + none.map(pick).join(', ') +
        ' — the dashed ones are suggested until ' + (owner ? 'you pick your own' : 'Jonah picks (⋯ → Services)') + '</div>' : '') +
    (r.dropped.length ? '<div class="hint jt-dropped">Not needed on this job: ' + r.dropped.map(t => '<button type="button" class="link-btn" data-k="' +
        esc(t.key) + '" onclick="jobToolBack(this.dataset.k)">' + esc(t.name) + ' ↺</button>').join(', ') + '</div>' : '') +
    '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="jobToolAdd()">+ Add a tool</button>' +
      (r.services.some(v => v.has) && owner ? '<span class="hint">Each service’s tools: ⋯ → Services → 🧰 Tools</span>' : '') + '</div>';
  if (wrap.innerHTML !== html) wrap.innerHTML = html;
  if (badge) badge.textContent = r.tools.length ? r.tools.length + ' tool' + (r.tools.length === 1 ? '' : 's') : '';
}
// ✕ on one: off this job only (a service's own list is left as it is).
function jobToolOff(key) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  const r = jobToolsNow(), t = r && r.tools.find(x => x.key === key);
  if (!t) return;
  const was = jobToolsFrom(jobToolsOwn);
  jobToolsOwn.added = jobToolsOwn.added.filter(x => window.YDServices.toolKey(x) !== key);
  if (t.from.length && jobToolsOwn.dropped.indexOf(key) === -1) jobToolsOwn.dropped.push(key);
  renderJobTools(); markDirty();
  const job = currentJobId;
  showUndo('“' + t.name + '” taken off this job', () => {
    if (currentJobId !== job || jobsReadOnly()) return;
    jobToolsOwn = was; renderJobTools(); markDirty();
  });
}
function jobToolBack(key) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  jobToolsOwn.dropped = jobToolsOwn.dropped.filter(k => k !== key);
  renderJobTools(); markDirty();
}
// + Add a tool: one of his machines (by type), or a tool typed in.
async function jobToolAdd() {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  const S = window.YDServices;
  if (!S || !S.machines) return;
  const r = jobToolsNow() || { tools: [] };
  const on = new Set(r.tools.map(t => t.key));
  const eqs = Object.values(S.machines()).filter(m => !on.has('eq:' + m.id))
    .sort((a, b) => S.kindName(a.kind).localeCompare(S.kindName(b.kind)) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  const choices = [{ id: '_typed', label: '✏️ Type one in', hint: 'a hand tool, or anything else', ask: 'e.g. 4 ft level, 2 wheelbarrows' }]
    .concat(eqs.map(m => ({ id: m.id, label: m.name, hint: S.kindName(m.kind) })));
  const pick = await ydChoose(eqs.length ? 'One of your machines, or type a tool in.' : 'Type the tool in.', choices, { title: 'Add a tool to this job', ok: 'Add' });
  if (!pick) return;
  let t;
  if (pick.id === '_typed') {
    t = S.parseTool(pick.text);
    if (!t.name) return;
    const m = Object.values(S.machines()).find(x => x.name.toLowerCase() === t.name.toLowerCase());
    if (m) t = { eq: m.id, name: m.name, kind: m.kind };
  } else {
    const m = S.machines()[pick.id];
    if (!m) return;
    t = { eq: m.id, name: m.name, kind: m.kind };
  }
  if (!t.eq && t.qty == null) delete t.qty;
  const key = S.toolKey(t);
  jobToolsOwn.dropped = jobToolsOwn.dropped.filter(k => k !== key);
  jobToolsOwn.added = jobToolsOwn.added.filter(x => S.toolKey(x) !== key).concat([t]);
  renderJobTools(); markDirty();
}
['yd-services', 'yd-tools', 'yd-equipment-changed'].forEach(ev => document.addEventListener(ev, scheduleJobTools));

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
           supplyId: l.supplyId || null, vendorId: l.vendorId || null, specialOrder: !!l.specialOrder,
           // A whole bag bought, part of it used (grass seed): "1 bag (uses 3 lb)".
           usesLb: typeof l.usedLb === 'number' && l.usedLb > 0 ? l.usedLb : null };
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
// A line made from the estimate before its material was joined to Supplies
// is in the estimate's words and units, with no supplier: a QuickBooks job's
// "215 square feet" of "4.5oz barrier fabric" (the list was filled two
// minutes before the join, 15 Oct 2026) came to $19,608 at the roll price.
// Once the material is joined -- or moved to another item -- its line, not
// yet ordered, is made again from the estimate: the item, its supplier, and
// how many to buy in what it is sold by. Lines typed by hand and lines
// already ordered are left as they are. picks: [{name, sid, was}], the
// materials just joined (was: the item it had before). null = nothing moved.
function rejoinOrderLines(list, lines, picks) {
  const fresh = {};
  lines.forEach(l => { if (l.supplyId) fresh[l.supplyId] = l; });
  const still = sid => lines.some(l => l.supplyId === sid);
  const have = {};
  list.forEach(it => { if (it && it.fromEstimate && it.supplyId) have[it.supplyId] = true; });
  const pickFor = it => it && it.fromEstimate && !it.ordered ? picks.find(p => fresh[p.sid] && p.sid !== it.supplyId &&
    (it.supplyId ? !!p.was && it.supplyId === p.was && !still(p.was)
      : String(it.name || '').toLowerCase().trim() === String(p.name || '').toLowerCase().trim())) : null;
  let moved = false;
  const out = [];
  list.forEach(it => {
    const p = pickFor(it);
    if (!p) { out.push(it); return; }
    moved = true;
    if (have[p.sid]) return;                 // already on the list under its item
    have[p.sid] = true;
    out.push(Object.assign({}, it, orderFields(fresh[p.sid])));
  });
  return moved ? out : null;
}
// A material joined on the open job's estimate (estimate.js): its line here follows.
function ydOrderJoined(name, sid, was) {
  if (!orderItems.length || jobsReadOnly() || !window.YDEstimate || !orderReady()) return;
  const out = rejoinOrderLines(orderItems, window.YDEstimate.orderLines(), [{ name: name, sid: sid, was: was || null }]);
  if (!out) return;
  orderItems = out;
  renderOrderList(); markDirty();
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
  // Not one in Recently deleted: nothing of it should change while it waits.
  if (!e || !e.fromQb || e.fromQb.linkedAt || qbFilling.has(id) || data.deletedAt) return;
  if (!window.YDAuth || !window.YDAuth.isOwner || !ydCan('jobs', 'change') || !window.YDEstimate || !window.YDEstimate.linkFromQb) return;
  if (!orderReady() || (id === currentJobId && dirty)) { qbWaiting.add(id); return; }
  qbFilling.add(id);
  setTimeout(() => {
    try {
      const linked = window.YDEstimate.linkFromQb(e);
      if (!linked) return;
      const patch = { estimate: linked };
      // An order list of bare names -- no amount, no supply, nothing ticked
      // (one typed in before the estimate came in, Oct 2026) -- holds
      // nothing the estimate doesn't: it is made again from the estimate.
      const bareOrder = (data.orderItems || []).every(o => o && !o.ordered && !o.supplyId && !o.fromEstimate &&
        !String(o.quantity || '').trim() && !(typeof o.qty === 'number'));
      if (!isBidStatus(data.jobStatus)) {
        const lines = window.YDEstimate.orderLines(linked, data.city || '');
        if (bareOrder && lines.length) patch.orderItems = orderFromEstimate([], lines);
        else if (lines.length) {
          // A list already filled from the estimate before the join: the
          // lines just joined are made again in what they are sold by.
          // linkFromQb keeps the materials in their places: the same index is the same line.
          const picks = (linked.materials || []).filter((m, i) => m && m.supplyId && !((e.materials || [])[i] || {}).supplyId)
            .map(m => ({ name: m.name, sid: m.supplyId }));
          const out = picks.length ? rejoinOrderLines(data.orderItems || [], lines, picks) : null;
          if (out) patch.orderItems = out;
        }
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
// A Supplies item picked for some words (supplymatch.js): the order list takes it.
document.addEventListener('yd-supply-aliases', () => { if (document.getElementById('orderListWrap') && orderItems.length) renderOrderList(); });
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
  // Not the same name: an item he picked for these words before, or the one
  // item with all of them (supplymatch.js) -- never a guess between several.
  if (window.YDMatch) {
    const skip = (window.YDPricing && YDPricing.NOT_FOR_ESTIMATES) || [];
    const got = YDMatch.match({ name: full, unit: '' }, cat, skip, { anyUnit: true });
    if (got.sure) return got.sure.id;
  }
  return null;
}
// The items an unjoined order line most likely is, as buttons.
function orderOptions(it, cat) {
  if (!window.YDMatch) return [];
  const skip = (window.YDPricing && YDPricing.NOT_FOR_ESTIMATES) || [];
  return YDMatch.match({ name: String(it.name || ''), unit: '' }, cat, skip, { anyUnit: true }).options;
}
// How many, typed on the line: "4" or "4 yards".
function setOrderQty(id, v) {
  const it = orderItems.find(m => m.id === id);
  if (!it) return;
  it.quantity = String(v || '').trim();
  const n = parseFloat(String(v || '').replace(/,/g, ''));
  it.qty = isFinite(n) ? n : null;
  markDirty();
  renderOrderList();
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
  // A rental priced "per day" or "daily" is in days, as "3 days" typed on the line is.
  const rawPer = String(pr.per || cat.items[sid].unit || '').trim();
  const per = isDayUnit(rawPer) ? 'day' : rawPer;
  // A unit typed by hand that is not the one the price is per ("2 pallets"
  // of something priced by the sq ft) would make a wrong number: say so.
  // Word by word, plurals and full stops aside: "approx. 1.10 tons" is in tons.
  const words = s => ' ' + String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')
    .map(w => /(x|ch|sh|ss)es$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) ? w.slice(0, -1) : w).join(' ') + ' ';
  const typed = words(it.quantity);
  // Pounds of something sold by the bag of a known weight ("Grass seed 3 lb"
  // off QuickBooks): whole bags to buy -- 3 lb of a 50 lb bag is one bag.
  const pk = window.YDMatch && YDMatch.pack ? YDMatch.pack(cat.items[sid], pr) : null;
  if (!it.fromEstimate && pk && pk.lb && q !== null && / lb | pound /.test(typed) && typed.indexOf(words(per)) === -1) {
    const bags = Math.ceil(q / pk.lb - 1e-9);
    return { sid: sid, each: pr.cents, per: per, year: pr.year || null, unitOff: false, bags: bags, usesLb: q,
             cents: Math.round(bags * pr.cents) };
  }
  // A line made from the estimate says its own unit (`per`): the price's,
  // unless the line was made before its material was joined to Supplies.
  const U = window.YDMatch ? YDMatch.unitKey : (s => String(s || '').toLowerCase().trim());
  const lineUnit = it.fromEstimate ? String(it.per || '').trim() : orderUnitWords(it.quantity);
  const item = cat.items[sid];
  const cov = Number(item.coverage) > 0 ? Number(item.coverage) : null;
  // A bare number of something sold in packs of a count -- "81" fabric pins,
  // sold by the box of 500 -- could be pins or boxes: it is asked, not
  // taken as 81 boxes (one job's came to $5,265, 21 Oct 2026). A bare
  // number of rolls or strips (covering an area or a length) is still rolls.
  const MEASURES = ['sqft', 'lf', 'yd', 'ton', 'cuft', 'gal', 'lb', 'day'];
  const packOfCount = !!(cov && cov > 1 && item.takeoffUnit && MEASURES.indexOf(U(item.takeoffUnit)) === -1);
  const unitOff = per !== '' && (it.fromEstimate
    ? lineUnit !== '' && U(lineUnit) !== U(per) && !(isDayUnit(lineUnit) && per === 'day')
    : typed.trim() !== '' ? typed.indexOf(words(per)) === -1 && U(lineUnit) !== U(per) : packOfCount && U(per) !== U(item.takeoffUnit));
  // In what one of it covers -- square feet of fabric sold by the roll, feet
  // of edging sold in 20' strips: how many to buy, the way the estimate
  // rounds them. Any other unit that is not the price's is said, never
  // multiplied (21 Oct 2026: 215 sq ft × $91.20 a roll = $19,608).
  if (unitOff && cov && q !== null && q > 0 && lineUnit && U(lineUnit) === U(item.takeoffUnit)) {
    const buy = window.YDPricing ? YDPricing.roundUp(q / cov, per) : Math.ceil(q / cov - 1e-9);
    return { sid: sid, each: pr.cents, per: per, year: pr.year || null, unitOff: false, buy: buy,
             cents: Math.round(buy * pr.cents) };
  }
  return { sid: sid, each: pr.cents, per: per, year: pr.year || null, unitOff: unitOff,
           cents: q === null || unitOff ? null : Math.round(q * pr.cents) };
}
// What bringing the lines still to order costs us, by supplier: the
// estimate's own delivery sums (estimate.js orderDelivery) on the order --
// a truck per bulk or pallet material from a supplier that delivers by town
// (MDS). Jonah, 21 Oct 2026: "none of the materials contain delivery fees".
// saved: the job's estimate when it is not the open one.
// -> { vendorId: {cents, loads, names, problems} }
function orderDeliveries(items, cat, saved, city) {
  if (!window.YDEstimate || !window.YDEstimate.orderDelivery) return {};
  const lines = items.filter(it => it && !it.ordered).map(it => {
    const c = orderCost(it, cat);
    return { supplyId: c.sid, qty: c.buy || c.bags || (c.unitOff ? null : orderQtyOf(it)) };
  }).filter(l => l.supplyId && l.qty > 0);
  const d = lines.length ? window.YDEstimate.orderDelivery(lines, saved, city) : null;
  if (!d) return {};
  // Only what stops a delivery being priced (no town, a zone to pick).
  const problems = d.problems.filter(p => /town|rate|zone/.test(p));
  const out = {};
  d.lines.forEach(l => {
    const v = (cat.items[l.supplyId] || {}).vendorId || '';
    const o = out[v] = out[v] || { cents: 0, loads: 0, names: [], problems: problems };
    o.cents += l.costCents || 0;
    o.loads += l.loads;
    o.names.push(l.name + (l.loads > 1 ? ' ×' + l.loads : '') + (l.pallet ? ' + pallet' : ''));
  });
  return out;
}
// Opening the job looks up where it is (estimate.js autoTrip), which finds a
// Madison zone by itself; the problem says what else would.
function orderDeliveryRow(dv) {
  if (!dv || !dv.loads) return '';
  const stuck = dv.problems.length > 0;
  return '<div class="check-row ord-delivery"><span class="cr-name">🚚 Delivery — ' + dv.loads + ' load' + (dv.loads === 1 ? '' : 's') +
    ': ' + esc(dv.names.join(', ')) + '<br>' +
    (stuck ? '<span class="cr-cost warn-text">Not priced yet: ' + esc(dv.problems.join(' · ')) + '</span>'
      : '<span class="cr-cost">their delivery charge = <b>' + fmtMoney(dv.cents / 100) + '</b></span>') + '</span></div>';
}
// The unit a quantity typed by hand is in: "632 sq ft" -> "sq ft",
// "approx. 1.10 tons" -> "tons", "376 sq ft (4 pallets)" -> "sq ft".
function orderUnitWords(s) {
  return String(s || '').toLowerCase().replace(/^\s*(approx\.?|about|~)?\s*[\d.,\/]+\s*/, '').replace(/\(.*$/, '').trim();
}
// How much of a line to ask the supplier for: what to buy when the line is
// in what the item covers ("1 roll (for 215 square feet)"), else as typed.
function orderAmountText(it, cat) {
  const c = cat && cat.prices && Object.keys(cat.prices).length ? orderCost(it, cat) : null;
  if (c && c.buy && window.YDPricing) return YDPricing.qtyText(c.buy, c.per) + ' (for ' + String(it.quantity || '').trim() + ')';
  return String(it.quantity || '');
}
function linkOrderItem(id, sid) {
  const it = orderItems.find(m => m.id === id);
  linkingOrder = null;
  if (it && sid) {
    it.supplyId = sid;
    // Kept for these words, on every job from now on (supplymatch.js).
    if (window.YDMatch) YDMatch.remember(it.name, sid);
    markDirty();
  }
  renderOrderList();
}
// One supplier's part of the order as text, to paste into an email or a text.
function supplierOrder(vid) {
  const cat = window.YDSupplies ? window.YDSupplies.catalog() : { items: {}, vendors: {} };
  const lines = orderItems.filter(it => !it.ordered && orderVendor(it, cat) === vid).map(it => orderLineText(it, cat));
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
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => ydShowCopy(text));
  else ydShowCopy(text);
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
    // Joined but with no quantity yet: its price, and a box for how many --
    // it said "no price in Supplies" for an item priced at $21.60 a ton
    // (15 Oct 2026).
    const askQty = c && c.sid && c.cents === null && !c.unitOff && typeof c.each === 'number' && !it.ordered;
    const opts = c && !c.sid && !it.ordered && linkingOrder !== it.id ? orderOptions(it, cat) : [];
    const costLine = !c ? '' : c.cents !== null
      ? '<span class="cr-cost">' + (c.bags ? esc(window.YDPricing ? YDPricing.qtyText(c.bags, c.per || 'bag') : c.bags + ' ' + (c.per || 'bag')) +
          ' to buy (uses ' + esc(String(c.usesLb)) + ' lb) × ' : '') +
        (c.buy ? esc(YDPricing.qtyText(c.buy, c.per)) + ' to buy for ' + esc(String(it.quantity || '').trim()) + ' × ' : '') +
        fmtMoney(c.each / 100) + '/' + esc(c.per || 'each') + ' = <b>' + fmtMoney(c.cents / 100) + '</b>' +
        (c.year && c.year < thisYear ? ' <span class="warn-text">' + esc(c.year) + ' price</span>' : '') + '</span>'
      : c.unitOff ? '<span class="cr-cost warn-text">priced per ' + esc(c.per) + ' — check the quantity</span>'
      : askQty ? '<span class="cr-cost">' + esc(cat.items[c.sid].name) + ' · ' + fmtMoney(c.each / 100) + '/' + esc(c.per || 'each') +
          ' — how many? <input class="cr-qty-in" inputmode="decimal" placeholder="' + esc(c.per || 'each') + '" ' +
          'onchange="setOrderQty(\'' + ordId(it.id) + '\', this.value)"></span>'
      : c.sid ? '<span class="cr-cost muted">no price in Supplies</span>'
      : linkingOrder === it.id ? ''
      : opts.length ? '<span class="cr-cost"><span class="muted">Which Supplies item is it?</span> ' + opts.map(sid =>
          '<button class="btn btn-sm cr-opt" onclick="linkOrderItem(\'' + ordId(it.id) + '\', \'' + ordId(sid) + '\')">' + esc(cat.items[sid].name) +
          (cat.prices[sid] && typeof cat.prices[sid].cents === 'number' ? ' · ' + fmtMoney(cat.prices[sid].cents / 100) +
            (cat.prices[sid].per ? '/' + esc(cat.prices[sid].per) : '') : '') + '</button>').join(' ') +
          ' <button class="link-btn" onclick="linkingOrder=\'' + ordId(it.id) + '\'; renderOrderList()">Something else…</button></span>'
      : '<span class="cr-cost"><span class="muted">Not in Supplies.</span> <button class="link-btn" onclick="linkingOrder=\'' + ordId(it.id) + '\'; renderOrderList()">Pick it from Supplies</button></span>';
    const picker = linkingOrder === it.id
      ? '<div class="cr-link"><select class="searchable" onchange="linkOrderItem(\'' + ordId(it.id) + '\', this.value)"><option value="">Which supply is it?</option>' +
          Object.values(cat.items).sort((a, b) => String(a.name).localeCompare(String(b.name)))
            .map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('') +
        '</select> <button class="link-btn" onclick="linkingOrder=null; renderOrderList()">Cancel</button></div>' : '';
    // The product's own page, from Supplies, for what is ordered online.
    const sid = !it.ordered ? orderSupply(it, cat) : null;
    const page = sid && window.YDSupplies && window.YDSupplies.websiteUrl ? window.YDSupplies.websiteUrl({ website: cat.items[sid].link }) : '';
    return '<div class="check-row' + (it.ordered ? ' done' : '') + '">' +
      '<input type="checkbox"' + (it.ordered ? ' checked' : '') + ' onchange="toggleOrderItem(\'' + ordId(it.id) + '\')">' +
      '<span class="cr-name">' + esc(it.name) +
        (it.specialOrder ? ' <span class="cr-special">special order</span>' : '') +
        (page ? ' <a class="link-btn" href="' + esc(page) + '" target="_blank" rel="noopener">🔗 order page</a>' : '') +
        // Ticked by a receipt sorted onto this job: which order it was.
        (it.ordered && it.orderNo ? ' <span class="muted">· ' + esc(it.orderedFrom || '') + ' #' + esc(it.orderNo) + '</span>' : '') +
        (costLine ? '<br>' + costLine : '') + picker +
      '</span>' +
      (it.quantity ? '<span class="cr-qty">' + esc(String(it.quantity)) +
        (it.usesLb > 0 && it.fromEstimate ? ' <span class="muted">(uses ' + esc(String(it.usesLb)) + ' lb)</span>' : '') + '</span>' : '') +
      '<button class="remove-btn" onclick="rmOrderItem(\'' + ordId(it.id) + '\')">×</button></div>';
  };

  // By supplier, so each call or email covers one place.
  const groups = {};
  orderItems.forEach(it => { const v = orderVendor(it, cat); (groups[v] = groups[v] || []).push(it); });
  const vname = v => v ? ((cat.vendors[v] || {}).name || 'Supplier') : '';
  const keys = Object.keys(groups).sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || vname(a).localeCompare(vname(b)));
  const grouped = keys.length > 1 || keys[0] !== '';
  // A supplier ordered from online: its site, and how long it takes to come.
  const siteOf = v => (window.YDSupplies && window.YDSupplies.websiteUrl ? window.YDSupplies.websiteUrl(cat.vendors[v]) : '');
  // What the supplier charges to bring what is still to order.
  const dels = prices ? orderDeliveries(orderItems, cat) : {};
  let delSum = 0;
  wrap.innerHTML = keys.map(v => {
    const list = groups[v];
    const left = list.filter(it => !it.ordered).length;
    const lead = v ? (cat.vendors[v] || {}).leadTime : '';
    if (dels[v]) delSum += dels[v].cents;
    return (grouped ? '<div class="order-vendor"><b>' + esc(v ? vname(v) : 'Other') + '</b>' +
        '<span class="muted">' + left + ' to order' + (lead && left ? ' · takes ' + esc(lead) : '') + '</span>' +
        (v && left ? '<button class="link-btn ro-ok" onclick="copySupplierOrder(\'' + ordId(v) + '\')">📋 Copy the order</button>' +
          ((cat.vendors[v] || {}).email ? '<button class="link-btn" onclick="emailSupplierOrder(\'' + ordId(v) + '\')">✉️ Email the order</button>' : '') +
          (siteOf(v) ? '<a class="link-btn" href="' + esc(siteOf(v)) + '" target="_blank" rel="noopener">🌐 Their website</a>' : '') : '') +
        '</div>' : '') +
      list.map(row).join('') + orderDeliveryRow(dels[v]);
  }).join('') +
    (prices && (sum || unpriced) ? '<div class="order-cost">Still to order comes to about <b>' + fmtMoney((sum + delSum) / 100) + '</b> before tax' +
      (delSum ? ', with ' + fmtMoney(delSum / 100) + ' of delivery' : '') +
      (unpriced ? ' · ' + unpriced + ' line' + (unpriced === 1 ? '' : 's') + ' without a price' : '') +
      '<div class="muted">Your cost from Supplies — only you see this, and it isn’t in the job’s numbers.</div></div>' : '');
  wrap.querySelectorAll('select.searchable').forEach(s => { if (typeof makeSearchable === 'function') makeSearchable(s); });
  document.getElementById('orderBadge').textContent = ordered + '/' + total + ' ordered';
}

// ═══════════════════════════════════════════════════════════
// ORDERS TO PLACE  (every job's Materials to Order, by supplier)
// ═══════════════════════════════════════════════════════════
// Jonah (Oct 2026): "One order list across booked jobs: Grouped by supplier,
// so ordering for the week is one screen. however, orders of the same
// material still need to be separated." So: one block per supplier, and in
// it each job's lines under that job's name -- two jobs wanting road gravel
// are two lines, never one added-up line, because they go to two places.
// It is the per-job list read across jobs: the same supplier, cost and
// order-page lookups (orderVendor, orderCost, orderSupply), and a tick here
// is the same `ordered` on the same line as the tick on the job.
const ORDERS_VIEW_KEY = 'ydjobhub_ordersView';
// An id as it may sit in an onclick (letters, digits, - and _ only).
const ordId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
// Which line a tick means: its id, or -- an old line saved before lines had
// ids -- its place on the job's list.
const ordLineKey = (it, i) => it.id ? ordId(it.id) : 'ord-ix-' + i;
let ordersView = (() => { try { return localStorage.getItem(ORDERS_VIEW_KEY) === 'week' ? 'week' : 'all'; } catch (e) { return 'all'; } })();
function setOrdersView(v) {
  ordersView = v === 'week' ? 'week' : 'all';
  try { localStorage.setItem(ORDERS_VIEW_KEY, ordersView); } catch (e) { /* remembered for this visit only */ }
  renderOrdersOverview();
}
// Booked and running jobs with something still to order. The job open in the
// form is read from the form (what was just typed onto its list counts);
// every other one from its saved copy. Bids are not ordered for, and a job
// marked to take off (a duplicate) is not either.
function ordersJobs() {
  const next = window.YDCalendar && YDCalendar.nextForJobs ? YDCalendar.nextForJobs(60) : {};
  const weekEnd = localYMD(new Date(Date.now() + 7 * 864e5));
  return loadAllJobs().filter(d => {
    const st = normStatus(d.jobStatus, d);
    return (st === 'booked' || st === 'inprogress') && !d.removeWhy;
  }).map(d => {
    const open = d._id === currentJobId;
    const items = (open ? orderItems : (Array.isArray(d.orderItems) ? d.orderItems : []))
      .map((it, i) => it && typeof it === 'object' ? Object.assign({}, it, { _key: ordLineKey(it, i) }) : null)
      .filter(it => it && !it.ordered && String(it.name || '').trim());
    const when = next[d._id] || null;
    const running = normStatus(d.jobStatus, d) === 'inprogress';
    return { id: d._id, d: d, items: items, when: when, running: running,
             // This week: under way now, or on a calendar within 7 days.
             soon: running || !!(when && when.day <= weekEnd) };
  }).filter(j => j.items.length)
    .sort((a, b) => (a.when ? a.when.day : '9999') .localeCompare(b.when ? b.when.day : '9999') ||
      String(a.d.customerName || '').localeCompare(String(b.d.customerName || '')));
}
function orderJobWhere(d) {
  return [d.address, [d.city, d.state].filter(Boolean).join(', ')].map(s => String(s || '').trim()).filter(Boolean).join(', ');
}
function orderJobTitle(j) {
  return (j.d.customerName || 'Untitled') + (String(j.d.estimateNumber || '').trim() ? ' #' + String(j.d.estimateNumber).trim() : '');
}
// One line as an order reads it: "3 tons — Road gravel (special order)";
// "1 roll (for 215 square feet) — …" when the line is in what it covers.
function orderLineText(it, cat) {
  const amt = orderAmountText(it, cat);
  return (amt ? amt + ' — ' : '') + it.name + (it.specialOrder ? ' (special order)' : '');
}
// The blocks: supplier id ('' = no supplier yet) -> [{ job, lines }], in
// the jobs' order (soonest first).
function ordersBySupplier(jobs, cat) {
  const groups = {};
  jobs.forEach(j => {
    const mine = {};
    j.items.forEach(it => { const v = orderVendor(it, cat); (mine[v] = mine[v] || []).push(it); });
    Object.keys(mine).forEach(v => { (groups[v] = groups[v] || []).push({ job: j, lines: mine[v] }); });
  });
  return groups;
}
function renderOrdersOverview() {
  const wrap = document.getElementById('ordersWrap');
  const sec = document.getElementById('ordersSection');
  if (!wrap || !sec || sec.hidden) return;
  const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {}, prices: {}, vendors: {} };
  const prices = typeof ydCan === 'function' && ydCan('supplies', 'see') && Object.keys(cat.items).length > 0;
  const canTick = !jobsReadOnly();
  const thisYear = new Date().getFullYear();
  const all = ordersJobs();
  const soonCount = all.filter(j => j.soon).length;
  const jobs = ordersView === 'week' ? all.filter(j => j.soon) : all;
  const lineCount = list => list.reduce((n, j) => n + j.items.length, 0);
  document.getElementById('ordersBadge').textContent = lineCount(all) ? lineCount(all) + ' to order' : '';
  // Two tap buttons, not a dropdown or a sideways row (phones).
  const pick = (v, label) => '<button type="button" class="btn btn-sm' + (ordersView === v ? ' btn-filled' : '') +
    '" aria-pressed="' + (ordersView === v) + '" onclick="setOrdersView(\'' + v + '\')">' + label + '</button>';
  const head = '<div class="orders-pick">' + pick('week', 'This week (' + soonCount + ' job' + (soonCount === 1 ? '' : 's') + ')') +
    pick('all', 'All booked jobs (' + all.length + ')') + '</div>';
  if (!jobs.length) {
    wrap.innerHTML = head + '<p class="empty-msg">' + (all.length
      ? 'Nothing to order for jobs under way or on the calendar in the next 7 days. “All booked jobs” shows the rest.'
      : 'Nothing left to order on any booked job. A job’s list is on its Job tab, under Materials to Order.') + '</p>';
    return;
  }
  const groups = ordersBySupplier(jobs, cat);
  const vname = v => v ? ((cat.vendors[v] || {}).name || 'Supplier') : '';
  const keys = Object.keys(groups).sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || vname(a).localeCompare(vname(b)));
  const siteOf = v => (window.YDSupplies && window.YDSupplies.websiteUrl ? window.YDSupplies.websiteUrl(cat.vendors[v]) : '');
  // The same material on more than one job at a supplier: said beside each,
  // so it can go on one call -- but as two lines, for two places.
  const sameKey = it => orderSupply(it, cat) || (window.YDMatch ? YDMatch.keyOf(it.name) : String(it.name).toLowerCase().trim());
  let grand = 0, grandUnpriced = 0;
  // Each job's delivery from each supplier (the open job's from the form).
  const dels = {};
  if (prices) jobs.forEach(j => {
    dels[j.id] = orderDeliveries(j.items, cat, j.id === currentJobId ? undefined : (j.d.estimate || null), j.id === currentJobId ? undefined : j.d.city);
  });
  const html = keys.map(v => {
    const blocks = groups[v];
    const onJobs = {};
    blocks.forEach(b => b.lines.forEach(it => { const k = sameKey(it); if (k) (onJobs[k] = onJobs[k] || []).push(b.job); }));
    let sum = 0, unpriced = 0, lines = 0;
    const body = blocks.map(b => {
      const j = b.job;
      const what = typeof jobWhat === 'function' ? jobWhat(j.d) : '';
      const when = j.when ? (j.running ? 'under way · ' : '') + 'on the calendar ' + fmtDateMD(j.when.day) : j.running ? 'under way' : '';
      const rows = b.lines.map(it => {
        lines++;
        const c = prices ? orderCost(it, cat) : null;
        if (c) { if (c.cents !== null) sum += c.cents; else unpriced++; }
        const cost = !c ? '' : c.cents !== null
          ? '<span class="cr-cost">' + (c.buy ? esc(YDPricing.qtyText(c.buy, c.per)) + ' to buy × ' : '') +
            fmtMoney(c.each / 100) + '/' + esc(c.per || 'each') + ' = <b>' + fmtMoney(c.cents / 100) + '</b>' +
            (c.year && c.year < thisYear ? ' <span class="warn-text">' + esc(c.year) + ' price</span>' : '') + '</span>'
          : c.unitOff ? '<span class="cr-cost warn-text">priced per ' + esc(c.per) + ' — check the quantity on the job</span>'
          : c.sid && typeof c.each === 'number' ? '<span class="cr-cost">' + fmtMoney(c.each / 100) + '/' + esc(c.per || 'each') + ' — how many? (on the job)</span>'
          : c.sid ? '<span class="cr-cost muted">no price in Supplies</span>'
          : '<span class="cr-cost muted">not joined to a Supplies item — on the job</span>';
        const sid = orderSupply(it, cat);
        const page = sid && window.YDSupplies && window.YDSupplies.websiteUrl ? window.YDSupplies.websiteUrl({ website: cat.items[sid].link }) : '';
        const others = (onJobs[sameKey(it)] || []).filter(o => o.id !== j.id);
        const also = others.length ? ' <span class="muted ord-also">· also on ' +
          others.filter((o, i, a) => a.indexOf(o) === i).map(o => esc(orderJobTitle(o))).join(', ') + '</span>' : '';
        return '<div class="check-row">' +
          '<input type="checkbox" aria-label="Ordered"' + (canTick ? '' : ' disabled') +
            ' onchange="ordersTick(\'' + ordId(j.id) + '\', \'' + it._key + '\')">' +
          '<span class="cr-name">' + esc(it.name) +
            (it.specialOrder ? ' <span class="cr-special">special order</span>' : '') +
            (page ? ' <a class="link-btn" href="' + esc(page) + '" target="_blank" rel="noopener">🔗 order page</a>' : '') + also +
            (cost ? '<br>' + cost : '') + '</span>' +
          (it.quantity ? '<span class="cr-qty">' + esc(String(it.quantity)) + '</span>' : '<span class="cr-qty muted">no amount</span>') +
          '</div>';
      }).join('');
      const dv = (dels[j.id] || {})[v];
      if (dv) sum += dv.cents;
      return '<div class="ord-job"><button type="button" class="link-btn ord-job-name" onclick="ordersOpenJob(\'' + ordId(j.id) + '\')">' +
          jobNameHtml(j.d.customerName, String(j.d.estimateNumber || '').trim()) + '</button>' +
          (what ? ' <span class="muted">· ' + esc(what) + '</span>' : '') +
          (when ? ' <span class="ord-when">' + esc(when) + '</span>' : '') + '</div>' + rows +
        orderDeliveryRow(dv);
    }).join('');
    grand += sum; grandUnpriced += unpriced;
    const lead = v ? (cat.vendors[v] || {}).leadTime : '';
    const vEsc = ordId(v);
    return '<div class="ord-supplier">' +
      '<div class="order-vendor"><b>' + esc(v ? vname(v) : 'No supplier yet') + '</b>' +
        '<span class="muted">' + lines + ' line' + (lines === 1 ? '' : 's') + ' · ' + blocks.length + ' job' + (blocks.length === 1 ? '' : 's') +
          (lead ? ' · takes ' + esc(lead) : '') + (prices && sum ? ' · about ' + fmtMoney(sum / 100) : '') + '</span>' +
        (v ? '<button class="link-btn" onclick="copyOrdersFor(\'' + vEsc + '\')">📋 Copy this supplier’s order</button>' +
          ((cat.vendors[v] || {}).email ? '<button class="link-btn" onclick="emailOrdersFor(\'' + vEsc + '\')">✉️ Email the order</button>' : '') +
          (siteOf(v) ? '<a class="link-btn" href="' + esc(siteOf(v)) + '" target="_blank" rel="noopener">🌐 Their website</a>' : '')
          : '<span class="muted">pick each one’s Supplies item on its job</span>') +
      '</div>' + body + '</div>';
  }).join('');
  // The suppliers side by side, as many as the screen holds (styles.css
  // .ord-grid) -- he scrolled past every order to reach the next (16 Oct 2026).
  wrap.innerHTML = head + '<div class="ord-grid">' + html + '</div>' +
    (prices && (grand || grandUnpriced) ? '<div class="order-cost">All of this comes to about <b>' + fmtMoney(grand / 100) + '</b> before tax' +
      (grandUnpriced ? ' · ' + grandUnpriced + ' line' + (grandUnpriced === 1 ? '' : 's') + ' without a price' : '') +
      '<div class="muted">Your cost from Supplies, and what the suppliers charge to deliver — not in any job’s numbers.</div></div>' : '');
}
// Ticked here = ticked on the job. The job open in the form is ticked in the
// form (its autosave writes it, and nothing typed there is lost); any other
// through patchJob, the path a move on the board takes -- this device, the
// cloud, the crew's copy.
function ordersTick(jobId, itemId) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  const flip = on => {
    if (currentJobId && ordId(currentJobId) === jobId) {
      const it = orderItems.find((m, i) => ordLineKey(m, i) === itemId);
      if (it && !!it.ordered !== on) toggleOrderItem(it.id);
    } else {
      const id = (getJobIndex().find(x => ordId(x.id) === jobId) || {}).id;
      let d = null;
      try { d = JSON.parse(readJobBlob(id) || 'null'); } catch (e) {}
      if (!d || !window.YDSync) return;
      const list = (d.orderItems || []).map((o, i) => o && ordLineKey(o, i) === itemId ? Object.assign({}, o, { ordered: on }) : o);
      window.YDSync.patchJob(id, { orderItems: list });
    }
    renderOrdersOverview();
  };
  flip(true);
  if (typeof showUndo === 'function') showUndo('Marked ordered', () => flip(false));
}
async function ordersOpenJob(key) {
  const jobId = (getJobIndex().find(x => ordId(x.id) === key) || {}).id;
  if (!jobId) return;
  if (currentJobId === jobId) { switchTab('job'); return; }
  if (!(await ydLeaveUnsavedJob())) return;
  loadJob(jobId);
  switchTab('job');
  const o = document.getElementById('orderListWrap');
  if (o) setTimeout(() => o.scrollIntoView({ block: 'center' }), 50);
}
// One supplier's order across the jobs shown, job by job: each job's lines
// under its name and address, so whoever takes it knows where each goes.
function ordersTextFor(vid) {
  const cat = window.YDSupplies ? window.YDSupplies.catalog() : { items: {}, vendors: {} };
  const all = ordersJobs();
  const jobs = ordersView === 'week' ? all.filter(j => j.soon) : all;
  const groups = ordersBySupplier(jobs, cat);
  const v = Object.keys(groups).find(k => k && ordId(k) === vid);
  const blocks = v ? groups[v] : [];
  return { vendor: (cat.vendors || {})[v] || {}, blocks: blocks,
    text: blocks.map(b => {
      const where = orderJobWhere(b.job.d);
      return orderJobTitle(b.job) + (where ? ' — ' + where : '') + '\n' + b.lines.map(it => '• ' + orderLineText(it, cat)).join('\n');
    }).join('\n\n') };
}
function copyOrdersFor(vid) {
  const o = ordersTextFor(vid);
  if (!o.blocks.length) { showToast('Nothing left to order there'); return; }
  const text = 'Order' + (o.vendor.name ? ' for ' + o.vendor.name : '') + '\n\n' + o.text;
  const done = () => showToast('Copied — paste it into an email or a text');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => ydShowCopy(text));
  else ydShowCopy(text);
}
function emailOrdersFor(vid) {
  const o = ordersTextFor(vid);
  if (!o.blocks.length) { showToast('Nothing left to order there'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.vendor.email || '')) { showToast('Add their order email first: Supplies → the supplier → Edit supplier'); return; }
  const subject = 'Order for ' + o.blocks.length + ' job' + (o.blocks.length === 1 ? '' : 's') + ' — YD Exterior Visions';
  const body = 'Hi,\n\nI’d like to order the following, kept apart by job:\n\n' + o.text +
    '\n\nPlease let me know the total and when each can be delivered or picked up.\n\nThanks,\nJonah\nYD Exterior Visions';
  location.href = 'mailto:' + encodeURIComponent(o.vendor.email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}
// Drawn when Supplies is opened (switchTab) and whenever the jobs, Supplies
// or the calendars change while it is on screen.
function ordersOnScreen() {
  const p = document.getElementById('panel-supplies');
  if (p && p.classList.contains('active')) renderOrdersOverview();
}
['yd-jobs-changed', 'yd-supplies', 'yd-supply-aliases'].forEach(ev => document.addEventListener(ev, ordersOnScreen));

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
// by hand and the crew who clocked into it -- the people the labour table
// lists, so "marco" typed in and Marco on the clock under his full name are one.
function laborWorkerCount() {
  return labourByPerson(currentJobId, labor).length || labor.length;
}

// Who worked on a job and for how long: approved clock time (forJob's sums,
// the same as everywhere else) and the rows typed in by hand, one line a
// person, with the days they were there. Jonah (16 Oct 2026): "an overall
// labor hours count with a quantity for each person who worked on it".
// A typed row names people as they were typed -- "marco", or "Marco, Sam,
// Lee" for one row -- so a name that is the first name of exactly
// one person on the clock is that person; a row for several people at once
// cannot be split between them and stays a line of its own.
function labourByPerson(jobId, rows) {
  const clock = jobId && window.YDClock ? YDClock.forJob(jobId) : null;
  const shifts = labourShifts(jobId);
  const people = {};
  const person = name => people[name] = people[name] ||
    { name: name, hours: 0, billable: 0, typed: 0, days: new Set() };
  const byWorker = (clock && clock.byWorker) || {};
  Object.keys(byWorker).forEach(n => { const p = person(n); p.hours += byWorker[n].paid; p.billable += byWorker[n].billable; });
  shifts.forEach(s => { if (s.counted) person(s.who).days.add(s.day); });
  const onClock = Object.keys(people);
  (rows || []).forEach(r => {
    const h = entryHours(r), p = person(typedPerson(r.worker, onClock));
    p.hours += h; p.billable += h; p.typed += h;
    if (r.date && h > 0) p.days.add(r.date);
  });
  return Object.values(people).filter(p => p.hours > 0.004)
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
}
function labourShifts(jobId) {
  return jobId && window.YDClock && YDClock.jobShifts ? YDClock.jobShifts(jobId) : [];
}
// The name a typed row is shown under: the one person on the clock whose
// name, or first name, it is; otherwise as it was typed, capitalised.
function typedPerson(typed, onClock) {
  const t = String(typed || '').trim();
  if (!t) return 'Not named';
  const low = t.toLowerCase();
  const same = (onClock || []).filter(n => n.toLowerCase() === low || n.trim().split(/\s+/)[0].toLowerCase() === low);
  return same.length === 1 ? same[0] : t.charAt(0).toUpperCase() + t.slice(1);
}

// The old caption read "8.0 hrs x $25", which stops being true the moment any
// of those hours came from a clocked shift approved at a different rate.
function laborCostSub(totalHrs) {
  const c = clockedLabor();
  if (!c.paidHours) return totalHrs.toFixed(1) + ' hrs × $' + LABOR_RATE;
  if (!manualLaborHours()) return totalHrs.toFixed(1) + ' hrs from the clock';
  return totalHrs.toFixed(1) + ' hrs · ' + c.paidHours.toFixed(1) + ' from the clock';
}

// The job's labour at the top of Labor Hours: the whole, then each person's
// hours and days, the clock (Connecteam's shifts included) and the rows
// typed in below together. A name, or Day by day, opens every day and every
// shift behind the figures. Shifts still waiting for approval are said under
// it but not counted -- they are not in any total that touches money.
let labPeople = [];         // the people as last drawn; their buttons open labPeople[i]
function labourSummaryHtml() {
  const c = clockedLabor();
  const list = labPeople = labourByPerson(currentJobId, labor);
  if (!list.length && !c.pendingHours) return '';

  // Shifts from before last year are loaded on demand (timeclock.js): says
  // so while they are, or if they could not be read.
  const older = window.YDClock && YDClock.oldLabourNote ? YDClock.oldLabourNote() : '';
  let h = '<div class="clocked-block"><div class="clocked-head">Who worked on it</div>' + (older || '');
  if (list.length) {
    const days = new Set();
    list.forEach(p => p.days.forEach(d => days.add(d)));
    const total = list.reduce((s, p) => s + p.hours, 0);
    const typed = list.reduce((s, p) => s + p.typed, 0);
    // Billable is only worth a column when the clock paused somebody.
    const paused = list.some(p => p.hours - p.billable > 0.01);
    h += '<div class="lab-sum"><span class="lab-sum-total"><b>' + fmtHrsMin(total) + '</b> in all · ' +
      list.length + (list.length === 1 ? ' person' : ' people') +
      (days.size ? ' · ' + days.size + (days.size === 1 ? ' day' : ' days') : '') + '</span>' +
      '<button type="button" class="btn btn-sm" onclick="openLabourDays()">📅 Day by day</button></div>';
    h += '<div class="table-wrap"><table class="lab-people"><thead><tr><th>Person</th><th>Hours</th><th>Days</th>' +
      (paused ? '<th>Billable</th>' : '') + '</tr></thead><tbody>';
    list.forEach((p, i) => {
      h += '<tr><td class="bold"><button type="button" class="linkish" onclick="openLabourDays(' + i + ')">' +
        esc(p.name) + '</button></td><td>' + fmtHrsMin(p.hours) + '</td><td>' + (p.days.size || '—') + '</td>' +
        (paused ? '<td>' + fmtHrsMin(p.billable) + '</td>' : '') + '</tr>';
    });
    h += '</tbody></table></div>';
    const bits = [];
    if (c.paidHours) bits.push(fmtHrsMin(c.paidHours) + ' from the clock, wages ' + fmtMoney(c.costCents / 100));
    if (typed > 0) bits.push(fmtHrsMin(typed) + ' typed in below');
    if (paused) bits.push('billable leaves out paused time — fuel, salt, driving');
    if (bits.length) h += '<div class="clocked-note">' + bits.join(' · ') + '.</div>';
  }
  if (c.pendingHours) {
    h += '<div class="clocked-pending">' + fmtHrsMin(c.pendingHours) +
         ' waiting for your approval on the Clock tab. Not counted above.</div>';
  }
  return h + '</div>';
}

function renderLabor() {
  const w = document.getElementById('laborTableWrap');
  const summary = labourSummaryHtml();
  if (!labor.length) {
    w.innerHTML = summary +
      '<p class="empty-msg">' + (summary ? 'No hours typed in by hand.' : 'No workers logged yet.') + '</p>';
  }
  else {
    // The day, and the times, on rows that have them (older jobs' rows do).
    const dated = labor.some(e => e.date || e.start);
    let h = '<div class="lab-typed-head">Typed in by hand</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Worker</th>' + (dated ? '<th>Day</th>' : '') +
      '<th>Time</th><th></th></tr></thead><tbody>';
    labor.forEach(e => {
      h += '<tr><td class="bold">' + esc(e.worker || '') + '</td>' +
        (dated ? '<td>' + esc(typedDayText(e)) + '</td>' : '') +
        '<td>' + fmtHrsMin(entryHours(e)) + '</td>' +
        '<td><button class="remove-btn" onclick="rmLabor(\'' + ordId(e.id) + '\')">×</button></td></tr>';
    });
    const totH = labor.reduce((s, e) => s + entryHours(e), 0);
    h += '</tbody><tfoot><tr style="font-weight:700"><td style="text-align:right"' + (dated ? ' colspan="2"' : '') +
      '>Total:</td><td>' + fmtHrsMin(totH) + '</td><td></td></tr></tfoot></table></div>';
    w.innerHTML = summary + h;
  }
  updateBadges(); updateSummary();
  renderLabourDays();
}

// "Wed, Mar 25 · 8:56 am – 11:00 am": a typed row's day and times, as much of
// it as the row has.
function typedDayText(e) {
  const day = e.date ? labDayWords(e.date) : '';
  const a = typedClock(e.start), b = typedClock(e.end);
  const times = a != null && b != null ? labMinutesWords(a) + ' – ' + labMinutesWords(b) : '';
  return [day, times].filter(Boolean).join(' · ');
}
// 'YYYY-MM-DD' as "Wed, Mar 25" (the year too when it is not this one).
function labDayWords(ymd) {
  const p = String(ymd || '').split('-').map(Number);
  if (p.length !== 3 || !p[0]) return String(ymd || '');
  const d = new Date(p[0], p[1] - 1, p[2]);
  const o = { weekday: 'short', month: 'short', day: 'numeric' };
  if (p[0] !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('en-US', o);
}
function labMinutesWords(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' am' : ' pm');
}
function labClockWords(ms) {
  const d = new Date(ms);
  return labMinutesWords(d.getHours() * 60 + d.getMinutes());
}

// ── A job's labour day by day ──
// Every day the job was worked, who was there, from when to when, and how
// long. Jonah (16 Oct 2026): "click into a jobs labor hours and see the
// exact break down per day per person". The clock's shifts and the typed
// rows that carry a day; typed rows with no day close the list. Shifts still
// waiting for approval are shown, marked, and not added in -- the same rule
// as the job's totals, so the days add up to them.
let labDaysWho = null;      // one person's name, or null for everyone
function openLabourDays(i) {
  labDaysWho = i != null && labPeople[i] ? labPeople[i].name : null;
  const m = document.getElementById('labDaysModal');
  if (!m) return;
  m.classList.add('active');
  renderLabourDays();
}
function closeLabourDays() {
  const m = document.getElementById('labDaysModal');
  if (m) m.classList.remove('active');
}
function labourDaysFor(i) {
  labDaysWho = i != null && i >= 0 && labPeople[i] ? labPeople[i].name : null;
  renderLabourDays();
}
function renderLabourDays() {
  const m = document.getElementById('labDaysModal'), body = document.getElementById('labDaysBody');
  if (!m || !body || !m.classList.contains('active')) return;
  const people = labPeople = labourByPerson(currentJobId, labor);
  if (labDaysWho && !people.some(p => p.name === labDaysWho)) labDaysWho = null;
  const nameEl = document.getElementById('customerName');
  const title = document.getElementById('labDaysTitle');
  if (title) title.textContent = 'Labor day by day' + (nameEl && nameEl.value ? ' — ' + nameEl.value : '');

  // Shifts from before the cutoff are read once, the first time they are
  // looked for (timeclock.js); said while they come.
  const state = window.YDClock && YDClock.olderFor ? YDClock.olderFor(0) : 'ready';
  const shifts = labourShifts(currentJobId);
  const onClock = [...new Set(people.map(p => p.name).concat(shifts.map(s => s.who)))];
  const days = {}, undated = {};
  const put = (day, who, item) => {
    const d = days[day] = days[day] || {};
    (d[who] = d[who] || []).push(item);
  };
  shifts.forEach(s => put(s.day, s.who, { at: s.startMs, times: labClockWords(s.startMs) + ' – ' + (s.endMs ? labClockWords(s.endMs) : 'now'),
    hours: s.paid, counted: s.counted, note: s.note }));
  labor.forEach(r => {
    const who = typedPerson(r.worker, onClock), hours = entryHours(r);
    if (!(hours > 0)) return;
    const a = typedClock(r.start), b = typedClock(r.end);
    if (r.date) put(r.date, who, { at: a != null ? a : 0, typed: true, hours: hours, counted: true, note: r.desc || '',
      times: a != null && b != null ? labMinutesWords(a) + ' – ' + labMinutesWords(b) : '' });
    else undated[who] = (undated[who] || 0) + hours;
  });

  const want = who => !labDaysWho || who === labDaysWho;
  let h = '<div class="ld-pick">' +
    '<button type="button" class="btn btn-sm' + (labDaysWho ? '' : ' btn-filled') + '" onclick="labourDaysFor(-1)">Everyone</button>' +
    people.map((p, i) => '<button type="button" class="btn btn-sm' + (p.name === labDaysWho ? ' btn-filled' : '') +
      '" onclick="labourDaysFor(' + i + ')">' + esc(p.name) + '</button>').join('') + '</div>';
  if (window.YDClock && YDClock.olderNote) h += YDClock.olderNote(state);

  let all = 0, dayCount = 0;
  const sum = (list, counted) => list.reduce((s, x) => s + (x.counted === counted ? x.hours : 0), 0);
  Object.keys(days).sort().forEach(day => {
    const who = Object.keys(days[day]).filter(want).sort();
    if (!who.length) return;
    const dayTotal = who.reduce((s, w) => s + sum(days[day][w], true), 0);
    const dayWait = who.reduce((s, w) => s + sum(days[day][w], false), 0);
    all += dayTotal;
    if (dayTotal > 0) dayCount++;
    h += '<div class="ld-day"><div class="ld-day-head"><b>' + esc(labDayWords(day)) + '</b><span>' +
      (dayTotal > 0 || !dayWait ? fmtHrsMin(dayTotal) : '') +
      (dayWait ? (dayTotal > 0 ? ' + ' : '') + fmtHrsMin(dayWait) + ' waiting' : '') +
      (labDaysWho ? '' : ' · ' + who.length + (who.length === 1 ? ' person' : ' people')) + '</span></div>';
    who.forEach(w => {
      const items = days[day][w].slice().sort((x, y) => x.at - y.at);
      const done = sum(items, true), wait = sum(items, false);
      const tags = (items.some(x => x.typed) ? '<span class="wl-tag">typed in</span>' : '') +
        (wait ? '<span class="wl-tag wait">' + fmtHrsMin(wait) + ' waiting</span>' : '');
      const notes = items.map(x => x.note).filter(Boolean);
      h += '<div class="ld-row"><span class="ld-who">' + esc(w) + tags + '</span><span class="ld-hrs">' + (done > 0 ? fmtHrsMin(done) : '—') + '</span>' +
        '<span class="ld-times">' + esc(items.map(x => x.times).filter(Boolean).join(' · ')) + '</span>' +
        (notes.length ? '<span class="ld-note">' + esc(notes.join(' · ')) + '</span>' : '') + '</div>';
    });
    h += '</div>';
  });
  const loose = Object.keys(undated).filter(want).sort();
  if (loose.length) {
    const t = loose.reduce((s, w) => s + undated[w], 0);
    all += t;
    h += '<div class="ld-day"><div class="ld-day-head"><b>No day given</b><span>' + fmtHrsMin(t) + ' · typed in</span></div>' +
      loose.map(w => '<div class="ld-row"><span class="ld-who">' + esc(w) + '</span><span class="ld-hrs">' + fmtHrsMin(undated[w]) + '</span></div>').join('') +
      '</div>';
  }
  if (!dayCount && !loose.length) h += '<p class="empty-msg">No hours on this job yet.</p>';
  else h += '<div class="ld-foot">' + (labDaysWho ? esc(labDaysWho) + ': ' : 'In all: ') + '<b>' + fmtHrsMin(all) + '</b>' +
    (dayCount ? ' over ' + dayCount + (dayCount === 1 ? ' day' : ' days') : '') + '</div>';
  body.innerHTML = h;
}
document.addEventListener('yd-clock-changed', renderLabourDays);
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
// Days as a quantity (Jonah, Oct 2026: "add days as a quantity option for
// tracking materials in jobs") -- a skid steer for 3 days. Stored as 'day',
// the word Supplies prices rentals per, so the two read the same.
function isDayUnit(u) { return /^(days?|daily|per day)$/i.test(String(u || '').trim()); }
// "3 days", "1 day", "4 ton": how a purchase's quantity reads.
function qtyUnitText(qty, unit) {
  const q = String(qty == null ? '' : qty).trim();
  if (!q) return '';
  if (isDayUnit(unit)) return q + ' ' + (parseFloat(q) === 1 ? 'day' : 'days');
  return q + (unit ? ' ' + unit : '');
}
// The Price on a purchase is what was paid in all; for days, what that comes
// to a day as well, to check against the rental's day rate in Supplies.
function perDayHtml(e) {
  const q = parseFloat(e.qty), p = parseFloat(e.price);
  if (!isDayUnit(e.unit) || !(q > 0) || !(p > 0)) return '';
  return ' <span class="muted">@ ' + fmtMoney(Math.round(p / q * 100) / 100) + '/day</span>';
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
        '<td>' + (e.qty ? esc(qtyUnitText(e.qty, e.unit)) : '—') +
          (e.unitPrice ? ' <span class="muted">@ ' + fmtMoney(e.unitPrice) + '</span>' : perDayHtml(e)) + '</td>' +
        '<td>' + esc(e.location || '—') +
          (mail ? ' <a class="mat-mail" href="' + esc(mail) + '" target="_blank" rel="noopener" title="Open the receipt email">✉️</a>' : '') + '</td>' +
        '<td class="bold">' + (e.price ? fmtMoney(e.price) : '—') + '</td>' +
        '<td><button class="remove-btn" onclick="rmMaterial(\'' + ordId(e.id) + '\')">×</button></td></tr>';
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
async function rmMaterial(id) {
  const at = materials.findIndex(e => e.id === id), row = materials[at];
  // A line put here from a receipt: the receipt keeps saying it went on this
  // job (receipts.js), and only its own Undo takes it back off both -- so
  // taking just the line off here is asked about first.
  if (row && row.receiptId && !(await ydConfirm('“' + (row.item || 'This line') + '” came from a receipt' +
      (row.location ? ' (' + row.location + ')' : '') + '. Taken off here, the receipt still says it went on this job — ' +
      'to take the receipt off the job, use Undo on it under Receipts.', { title: 'Take just this line off?', ok: 'Take it off' }))) return;
  // The list may have changed while the question was open.
  if (!materials.some(e => e.id === id)) return;
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
        '<td><button class="remove-btn" onclick="rmAdditionalCost(\'' + ordId(e.id) + '\')">×</button></td></tr>';
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
// What the open job bills (jobBill), from the form.
function formBill() {
  return jobBill({ jobPrice: parseMoney(document.getElementById('jobPrice').value),
    estimate: window.YDEstimate ? window.YDEstimate.get() : null, city: (document.getElementById('city') || {}).value || '',
    qbInvoiceRef: boardFields.qbInvoiceRef, qbEstimate: boardFields.qbEstimate, taxable: oldTaxable });
}
// The retired "Taxable — WI 5.5%" box, still ticked on this job: one line
// saying what it does now, and a button to be done with it. Its total is
// never changed behind his back.
function billNoteHtml(bill) {
  if (!bill.oldBox) return '';
  const edits = !jobsReadOnly();
  const say = bill.from === 'oldBox'
    ? 'This job has the old “Taxable — WI ' + OLD_TAX_PCT + '%” box ticked, so ' + OLD_TAX_PCT + '% is still added to its total. ' +
      'That box is retired: the estimate or the QuickBooks invoice holds the tax now.'
    : 'This job had the old “Taxable — WI ' + OLD_TAX_PCT + '%” box ticked. It is not used any more — the ' +
      (bill.from === 'qb' ? 'QuickBooks invoice' : 'estimate') + '’s tax is.';
  return '<div class="old-tax-note" role="note">' + say +
    (edits ? ' <button type="button" class="link-btn" onclick="dropOldTaxBox()">' + (bill.from === 'oldBox' ? 'Stop adding it' : 'OK, clear it') + '</button>' : '') + '</div>';
}
function dropOldTaxBox() {
  if (jobsReadOnly()) return;
  oldTaxable = false;
  markDirty();
  updateSummary();
}
function renderPayments() {
  const w = document.getElementById('paymentsTableWrap');
  const bill = formBill();
  const jobPrice = bill.subtotal, tax = bill.tax;
  const invoiceTotal = bill.total;
  const billNote = billNoteHtml(bill);
  if (!payments.length) { w.innerHTML = billNote + '<p class="empty-msg">No payments logged yet.</p>'; }
  else {
    let h = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Label</th><th>Amount</th><th>Notes</th><th></th></tr></thead><tbody>';
    let recv = 0;
    payments.forEach(p => {
      const amt = parseFloat(p.amount) || 0; recv += amt;
      const how = [p.method, p.notes].filter(Boolean).join(' · ');
      h += '<tr><td>' + fmtDateMD(p.date) + '</td><td class="bold">' + esc(p.label || '') + '</td>' +
        '<td class="bold">' + fmtMoney(amt) + '</td><td>' + esc(how || '—') + payQbHtml(p) + '</td>' +
        '<td><button class="remove-btn" onclick="rmPayment(\'' + ordId(p.id) + '\')">×</button></td></tr>';
    });
    recv = round2(recv);
    const bal = round2(invoiceTotal - recv), paid = bal <= 0 && invoiceTotal > 0;
    let foot = '';
    if (bill.from === 'qb') {
      foot += '<tr style="font-weight:700"><td colspan="2" style="text-align:right">Invoice Total:</td><td>' + fmtMoney(invoiceTotal) + '</td><td colspan="2" class="muted" style="font-weight:500">QuickBooks' +
        (bill.inv.docNumber ? ' #' + esc(bill.inv.docNumber) : '') + ', tax included</td></tr>';
    } else if (tax > 0) {
      foot += '<tr><td colspan="2" style="text-align:right">Subtotal:</td><td>' + fmtMoney(jobPrice) + '</td><td colspan="2"></td></tr>';
      foot += '<tr><td colspan="2" style="text-align:right">Sales tax:</td><td>' + fmtMoney(tax) + '</td><td colspan="2" class="muted">' +
        (bill.from === 'estimate' ? 'from the estimate' : 'the old ' + OLD_TAX_PCT + '% box') + '</td></tr>';
      foot += '<tr style="font-weight:700"><td colspan="2" style="text-align:right">Invoice Total:</td><td>' + fmtMoney(invoiceTotal) + '</td><td colspan="2"></td></tr>';
    }
    foot += '<tr style="font-weight:700"><td colspan="2" style="text-align:right">Received:</td><td>' + fmtMoney(recv) + '</td><td colspan="2"></td></tr>';
    foot += '<tr style="font-weight:700"><td colspan="2" style="text-align:right">Balance Due:</td>' +
      '<td style="color:' + (paid ? 'var(--pos)' : 'var(--neg)') + '">' + fmtMoney(bal) + '</td>' +
      '<td colspan="2">' + (paid ? '<span class="paid-chip">Paid in full</span>' : '') + '</td></tr>';
    h += '</tbody><tfoot>' + foot + '</tfoot></table></div>';
    w.innerHTML = billNote + h;
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
// Its own name: it was called jobQbInvoice too, and being declared later in
// this classic script it replaced the Job tab's one of that name, so the
// "QuickBooks: invoice #… · $… owed" line never showed (16 Oct 2026).
function jobHasQbInvoice(id) {
  if (boardFields.qbInvoiceRef && boardFields.qbInvoiceRef.id && id === currentJobId) return true;
  const all = window.YDInvoices && YDInvoices.all ? YDInvoices.all() : {};
  return Object.values(all).some(i => i && i.jobId === id && !i.deletedAt);
}
function payQbHtml(p) {
  if (p.qbPaymentId) return ' <span class="pay-qb ok" title="In QuickBooks">✓ ' + (p.fromQb ? 'from QuickBooks' : 'in QuickBooks') + '</span>';
  if (p.qbError) return ' <span class="pay-qb bad">⚠ ' + esc(p.qbError) + '</span>';
  if (String(p.createdAt || '') >= PAYMENTS_FROM) {
    return jobHasQbInvoice(currentJobId) ? ' <span class="pay-qb wait">⏳ going to QuickBooks</span>'
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
  if (!jobId || !jobHasQbInvoice(jobId) || !(typeof ydCan === 'function' && ydCan('billing', 'change')) || !window.YDClaude) return;
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
  // The two retired boxes, kept as they were (see qbInvoicedFlag).
  d.qbInvoiced = !!qbInvoicedFlag;
  d.taxable = !!oldTaxable;
  // Kept off the crew's Jobs tab even while booked (crewjobs.js).
  d.crewHidden = !!(document.getElementById('crewHidden') || {}).checked;
  d.serviceTypes = serviceTypes.slice();
  d.labor = labor; d.materials = materials; d.orderItems = orderItems;
  // What was changed by hand in the job's tool list (the list itself is worked out).
  d.tools = jobToolsFrom(jobToolsOwn);
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
  qbInvoicedFlag = !!d.qbInvoiced;
  oldTaxable = !!d.taxable;
  const ch = document.getElementById('crewHidden'); if (ch) ch.checked = !!d.crewHidden;
  serviceTypes = Array.isArray(d.serviceTypes) ? d.serviceTypes.slice() : (d.serviceType ? [d.serviceType] : []);
  renderServiceTypes();
  labor = (d.labor || []).map(e => ({ ...e, id: e.id || uid() }));
  materials = (d.materials || []).map(e => ({ ...e, id: e.id || uid() }));
  const rawOrder = d.orderItems || d.quotedMaterials || [];
  // Kept whole: a receipt that ticked an item notes which order it was on it.
  orderItems = rawOrder.map(e => ({ ...e, id: e.id || uid(), proposalId: e.proposalId || null, name: e.name || '', quantity: e.quantity || '', ordered: !!e.ordered }));
  jobToolsOwn = jobToolsFrom(d.tools);
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
  renderProposal(); renderOrderList(); renderJobTools(); updateSummary();
  dirty = false; updateCtxBar();
  if (window.YDPlants) window.YDPlants.refresh();
}

// The job index holds every job on this device, those in Recently deleted
// too (`deleted` on the entry): sync needs them all to know which copies it
// already holds. getJobIndex() is the jobs that are really there -- what
// every list, board, total and search reads -- so a deleted job drops out of
// all of them at once without each having to remember to skip it.
// getJobIndexAll() is the whole thing, for sync, backups and Recently deleted.
function getJobIndexAll() { try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'index') || '[]'); } catch { return []; } }
function getJobIndex() { return getJobIndexAll().filter(j => !j.deleted); }
// Most callers read getJobIndex(), change it and save it back, so deleted
// entries they never saw are kept -- while their job is still stored here.
// A job deleted for good has had its copy removed first, so it goes.
function saveJobIndex(idx) {
  const have = new Set(idx.map(j => j.id));
  const kept = getJobIndexAll().filter(j => j.deleted && !have.has(j.id) && readJobBlob(j.id) != null);
  localStorage.setItem(STORAGE_PREFIX + 'index', JSON.stringify(idx.concat(kept)));
}

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
  let idx = getJobIndexAll();
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
      stage: jobStage(data).id,
      deleted: !!data.deletedAt,
      lastModified: data.lastModified || entry.lastModified || ''
    };
    if (fresh.price !== entry.price || fresh.city !== entry.city || fresh.services !== entry.services || fresh.status !== entry.status || fresh.name !== entry.name || fresh.est !== entry.est || fresh.lost !== entry.lost ||
        fresh.date !== entry.date || fresh.invoiced !== entry.invoiced || fresh.stage !== entry.stage || fresh.deleted !== !!entry.deleted) changed = true;
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
    invoiced: isInvoiced(data),
    // Its one stage (jobStage), for the pill in My Jobs.
    stage: jobStage(data).id,
    // In Recently deleted (deleteJob): kept, but left out of getJobIndex().
    deleted: !!data.deletedAt,
    lastModified: data.lastModified };
}
// QuickBooks holds an invoice for it (the QB chip on All Jobs). Whether the
// job counts as Invoiced is its stage (jobStage) -- a deposit invoice on a
// job still being worked does not make it Invoiced.
function isInvoiced(data) {
  return !!qbInvoiceOf(data);
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
  const json = JSON.stringify(data);
  try {
    localStorage.setItem(STORAGE_PREFIX + currentJobId, json);
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
  // A status or stage changed on the form: into the change history
  // (changelog.js). A brand-new job has no "before" and is not a move.
  if (before !== null && window.YDChangeLog) {
    let was = null;
    try { was = JSON.parse(before); } catch (e) {}
    if (was) window.YDChangeLog.jobMoved(currentJobId, was, data);
  }
  // If this job also existed under the legacy raw key, drop it now that it's
  // saved under the new scheme (natural, one-at-a-time migration).
  if (STORAGE_PREFIX + currentJobId !== currentJobId && localStorage.getItem(currentJobId) !== null) {
    try { localStorage.removeItem(currentJobId); } catch {}
  }
  cacheSavedJob(currentJobId, json, data);
  if (announce) showToast('Job saved');
  return true;
}
// The job just saved swapped into the list every screen reads (loadAllJobs),
// in its place at the top as the index has it -- in a NEW list, since some
// screens (calendar.js jobById) rebuild their lookups only when the list
// itself is a different one. Throwing the whole list away instead made the
// next screen to draw re-read and re-parse every job after each pause in
// typing. Its own parsed copy, so later typing in the form never shows in
// the list before it is saved.
function cacheSavedJob(id, json, data) {
  if (!_jobsCache || data.deletedAt) { invalidateJobsCache(); return; }
  let copy;
  try { copy = Object.assign(JSON.parse(json), { _id: id }); } catch (e) { invalidateJobsCache(); return; }
  _jobsCache = [copy].concat(_jobsCache.filter(j => j._id !== id));
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
  if (window.YDSignatures) window.YDSignatures.jobShown(currentJobId);
}
function loadJob(id, quiet) {
  const raw = readJobBlob(id);
  if (!raw) return;
  // One in Recently deleted is not opened (an edit would bring it back
  // without anyone meaning to): Restore it first.
  let gone = false;
  try { gone = !!JSON.parse(raw).deletedAt; } catch (e) {}
  if (gone) {
    if (currentJobId === id) clearJobForm();
    if (!quiet) showToast('That job is in Recently deleted — restore it from the foot of My Jobs first');
    return;
  }
  currentJobId = id;
  loadingJob = true;
  try { loadJobData(JSON.parse(raw)); } catch (e) { console.error(e); showToast('Could not load job'); }
  loadingJob = false;
  jobOnScreen();
  if (!quiet) { closeManager(); switchTab('job'); }
}
// Deleting a job moves it to Recently deleted (Jonah, 15 Oct 2026: "The ×
// in My Jobs deletes for good. Move it to an archive with 'Recently
// deleted' instead"). The job is kept whole, marked deletedAt, and leaves
// every list, board, the crew's clock and the summaries; Restore puts it
// back as it was. The owner can delete it for good from there, and the
// server does so by itself 30 days on (functions/tidy.py purge_jobs).
// Written through patchJob, like a board move, so every device and the
// crew's copies follow. `quiet`: no Undo bar (Delete these N says it once).
const DELETED_KEEP_DAYS = 30;     // the same in functions/tidy.py
function deleteJob(id, quiet) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return false; }
  const raw = readJobBlob(id);
  if (!raw) return false;
  let data; try { data = JSON.parse(raw); } catch (e) { return false; }
  // Typing not yet saved goes in first: it is part of what Restore gives back.
  if (id === currentJobId && dirty) autosave();
  const a = window.YDAuth || {}, u = a.user || {};
  const patch = { deletedAt: new Date().toISOString(), deletedBy: u.uid || null,
    deletedByName: u.displayName || u.email || null };
  if (!patchJobAnywhere(id, patch)) { showToast('Could not delete that job'); return false; }
  // Not newJob(): its "unsaved changes will be lost?" question, answered
  // Cancel, left the deleted job in the form, and the next autosave quietly
  // brought it back to life.
  if (currentJobId === id) clearJobForm();
  invalidateJobsCache();
  if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
  if (!quiet) {
    const name = (data.customerName || 'Job').trim();
    const msg = name + ' moved to Recently deleted (foot of My Jobs)';
    if (typeof showUndo === 'function') showUndo(msg, () => restoreJob(id, true)); else showToast(msg);
  }
  return true;
}
// A job back from Recently deleted, as it was.
function restoreJob(id, quiet) {
  if (jobsReadOnly()) { showToast('You can look at jobs but not change them'); return; }
  if (!patchJobAnywhere(id, { deletedAt: null, deletedBy: null, deletedByName: null })) {
    showToast('Could not bring that job back');
    return;
  }
  invalidateJobsCache();
  if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
  if (!quiet) {
    let name = 'The job';
    try { name = (JSON.parse(readJobBlob(id) || '{}').customerName || name).trim(); } catch (e) {}
    showToast(name + ' is back');
  }
}
// The same change through sync.js when it is running (cloud, crew board,
// crew copy), else on this device only -- a device not signed in keeps its
// jobs to itself.
function patchJobAnywhere(id, patch) {
  if (window.YDSync && window.YDSync.patchJob) return window.YDSync.patchJob(id, patch);
  try {
    const d = JSON.parse(readJobBlob(id) || 'null');
    if (!d) return false;
    Object.assign(d, patch, { lastModified: new Date().toISOString() });
    localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(d));
    saveJobIndex(getJobIndexAll().filter(j => j.id !== id).concat([buildIndexEntry(id, d)]));
    invalidateJobsCache();
    return true;
  } catch (e) { return false; }
}
// Deleted for good: the owner only, from Recently deleted, asked first. The
// cloud's copy goes too (sync.js wraps this). Its photos are cleared by the
// server's morning tidy (functions/tidy.py), which removes photos whose job
// is gone.
async function purgeJob(id, sure) {
  const a = window.YDAuth || {};
  if (a.mode === 'cloud' && !a.isOwner) { showToast('Only the owner can delete a job for good'); return; }
  let name = 'this job';
  try { name = (JSON.parse(readJobBlob(id) || '{}').customerName || name).trim(); } catch (e) {}
  if (!sure && !(await ydConfirm('It cannot be brought back after this.', { title: 'Delete ' + name + ' for good?', ok: 'Delete for good', danger: true }))) return;
  localStorage.removeItem(STORAGE_PREFIX + id);
  localStorage.removeItem(id);   // also drop legacy-key copy if present
  saveJobIndex(getJobIndexAll().filter(j => j.id !== id));
  invalidateJobsCache();
  if (currentJobId === id) clearJobForm();
  renderJobList(); showToast(name + ' deleted for good');
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
  // The retired Taxable box is not carried onto a new job.
  data.qbInvoice = ''; data.qbInvoiced = false; data.taxable = false;
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
// True when a new job was started (false: the person kept the one open).
async function newJob() {
  if (dirty && !(await ydConfirm('Unsaved changes on the job open now will be lost.',
      { title: 'Start a new job?', ok: 'Start a new one', cancel: 'Keep this one', danger: true }))) return false;
  clearJobForm();
  switchTab('job'); showToast('New job started');
  return true;
}
// Empties the form without asking anything or moving anyone. newJob() puts
// the unsaved-changes question in front of it; a delete does not need that
// question (the person has just confirmed the delete), and sync uses it when
// the job on screen was deleted on another device.
function clearJobForm() {
  currentJobId = null;
  launchJobId = null;     // a new job was asked for: not the last one
  jobOnScreen();
  labor = []; materials = []; orderItems = []; proposals = []; payments = []; additionalCosts = [];
  jobToolsOwn = { added: [], dropped: [] };
  serviceTypes = []; jobStatus = 'quoting'; boardFields = {}; manualJobPrice = false; baseJobPrice = 0;
  storageBroken = false; storageWarned = false;
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  qbInvoicedFlag = false;
  oldTaxable = false;
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
function markDirty() { dirty = true; updateCtxBar(); scheduleAutosave(); scheduleJobTools(); }

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
async function deleteMarkedJobs() {
  if (jobsReadOnly()) return;
  const list = markedJobs();
  if (!list.length || !(await ydConfirm(
      list.map(d => '• ' + (d.customerName || 'Job') + (d.estimateNumber ? ' #' + d.estimateNumber : '')).join('\n') +
      '\n\nThey can be brought back from the foot of My Jobs for ' + DELETED_KEEP_DAYS + ' days.',
      { title: 'Move these ' + list.length + ' to Recently deleted?', ok: 'Move them' }))) return;
  const ids = list.map(d => d._id).filter(id => window.deleteJob(id, true));
  const msg = ids.length + ' job' + (ids.length === 1 ? '' : 's') + ' moved to Recently deleted';
  if (typeof showUndo === 'function') showUndo(msg, () => ids.forEach(id => restoreJob(id, true))); else showToast(msg);
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
  if (!idx.length) { body.innerHTML = removeBoxHtml() + switcher + '<p class="empty-msg">' + (jobListBids ? 'No bids.' : 'No jobs found.') + '</p>' + deletedBoxHtml(); return; }

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
  // Why a lost bid was lost, from the bid itself (the index does not carry
  // it); tapped, it can be changed -- or given, on one lost before reasons
  // were asked.
  const lostBits = j => {
    if (!j.lost) return '';
    let d = null;
    try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (e) {}
    const why = lostWhy(d);
    if (jobsReadOnly()) return why ? ' ' + lostChipHtml(d) : '';
    return ' <button type="button" class="lost-why' + (why ? '' : ' none') + '" title="Change why it was lost" ' +
      'onclick="event.stopPropagation(); changeLostReason(\'' + ordId(j.id) + '\')">' + esc(why || 'Say why') + ' ✎</button>';
  };
  body.innerHTML = removeBoxHtml() + switcher + keys.map(key => {
    const shut = collapsedMonths[key];
    const rows = groups[key].map(j =>
      '<div class="job-row"><div class="job-row-main" onclick="loadJob(\'' + ordId(j.id) + '\')">' +
        '<div class="job-row-name">' + jobNameHtml(j.name, j.est) + ' ' +
          (j.lost ? '<span class="pill lost">Lost</span>' + lostBits(j) : j.stage ? stagePill(j.stage) : statusPill(normStatus(j.status))) + plantBits(j) + '</div>' +
        '<div class="job-row-sub">' + (j.city ? esc(j.city) + ' · ' : '') + (j.services ? esc(j.services) + ' · ' : '') +
          // A bid with no price yet said "$0.00", which read as a free job.
          (j.price ? fmtMoney(j.price) : esc(perPushOfJob(j.id)) || '<span class="muted">no price yet</span>') + '</div></div>' +
      '<div class="jl-acts">' +
      (jobListBids && j.lost && !jobsReadOnly() ? '<button class="dup-btn" onclick="reopenBid(\'' + ordId(j.id) + '\')">BACK ON THE BOARD</button>' : '') +
      (jobListBids && !jobsReadOnly() ? '<button class="dup-btn" onclick="makeItAJob(\'' + ordId(j.id) + '\')">MAKE IT A JOB</button>' : '') +
      (jobListBids && !j.lost && !jobsReadOnly() ? '<button class="dup-btn" onclick="markBidLost(\'' + ordId(j.id) + '\')">MARK LOST</button>' : '') +
      // "DUP" meant nothing to anyone; and Delete sat right against it.
      '<button class="dup-btn" onclick="duplicateJob(\'' + ordId(j.id) + '\')" title="Make a copy of this ' + (jobListBids ? 'bid' : 'job') + '">COPY</button>' +
      '<button class="remove-btn jl-del" onclick="deleteJob(\'' + ordId(j.id) + '\')" title="Move this ' + (jobListBids ? 'bid' : 'job') + ' to Recently deleted' +
        '" aria-label="Delete ' + esc(j.name || 'this job') + '">🗑 Delete</button></div></div>'
    ).join('');
    return '<div class="month-group"><div class="month-head" onclick="toggleMonth(\'' + key + '\')">' +
      '<span class="month-arrow' + (shut ? ' shut' : '') + '">▼</span> ' + key + ' (' + groups[key].length + ')</div>' + (shut ? '' : rows) + '</div>';
  }).join('') + deletedBoxHtml();
}
// Recently deleted, at the foot of My Jobs (deleteJob): newest first, with
// how long each has before it goes for good. Restore for whoever may change
// jobs; Delete for good for the owner only.
let deletedOpen = false;
function toggleDeletedJobs() { deletedOpen = !deletedOpen; renderJobList(); }
function deletedJobs() {
  return getJobIndexAll().filter(j => j.deleted).map(j => {
    let d = null;
    try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (e) {}
    return d && d.deletedAt ? Object.assign({}, d, { _id: j.id }) : null;
  }).filter(Boolean).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}
function deletedBoxHtml() {
  const list = deletedJobs();
  if (!list.length) return '';
  const a = window.YDAuth || {};
  const owner = a.mode !== 'cloud' || !!a.isOwner, edits = !jobsReadOnly();
  const safe = id => String(id).replace(/[^A-Za-z0-9_-]/g, '');
  const left = d => {
    const t = new Date(d.deletedAt);
    if (isNaN(t)) return '';
    const n = DELETED_KEEP_DAYS - Math.floor((Date.now() - t.getTime()) / 864e5);
    return n <= 0 ? 'goes for good at the next morning tidy' : n === 1 ? '1 day left' : n + ' days left';
  };
  const when = d => { const t = new Date(d.deletedAt); return isNaN(t) ? '' : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  return '<div class="jl-deleted">' +
    '<button type="button" class="jl-deleted-head" onclick="toggleDeletedJobs()" aria-expanded="' + deletedOpen + '">' +
      '<span class="month-arrow' + (deletedOpen ? '' : ' shut') + '">▼</span> 🗑 Recently deleted (' + list.length + ')</button>' +
    (deletedOpen ? '<div class="hint">Kept ' + DELETED_KEEP_DAYS + ' days, then deleted for good by itself. Off every list, board and the crew\'s clock meanwhile.</div>' +
      list.map(d => '<div class="job-row jl-deleted-row"><div class="job-row-main">' +
          '<div class="job-row-name">' + jobNameHtml(d.customerName || 'Untitled', String(d.estimateNumber || '').trim()) +
            ' <span class="muted">' + (isBidStatus(d.jobStatus) ? 'bid' : 'job') + '</span></div>' +
          '<div class="job-row-sub">Deleted ' + esc(when(d)) + (d.deletedByName ? ' by ' + esc(d.deletedByName) : '') + ' · ' + esc(left(d)) + '</div></div>' +
        '<div class="jl-acts">' +
          (edits ? '<button class="dup-btn" onclick="restoreJob(\'' + safe(d._id) + '\')">RESTORE</button>' : '') +
          (owner && edits ? '<button class="remove-btn jl-del" onclick="purgeJob(\'' + safe(d._id) + '\')">Delete for good</button>' : '') +
        '</div></div>').join('') : '') +
  '</div>';
}

// ═══════════════════════════════════════════════════════════
// ALL JOBS DASHBOARD
// ═══════════════════════════════════════════════════════════
// A snow bid has no whole-job price: it is priced per push (estimate.js),
// its jobPrice is left empty so no total ever counts it, and its 1–3"
// price per visit is shown where its price would be.
function perPushText(d) {
  const c = d && window.YDEstimate && YDEstimate.perPushCents ? YDEstimate.perPushCents(d) : null;
  return c ? fmtMoney(c / 100) + ' per push' : '';
}
function perPushOfJob(id) {
  try { return perPushText(JSON.parse(readJobBlob(id) || 'null')); } catch (e) { return ''; }
}
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
// "Owed to you" is the Invoices list's figure: drawn again when that list
// arrives or changes, if All Jobs is on screen.
document.addEventListener('yd-invoices', () => {
  const dash = document.getElementById('panel-dashboard');
  if (dash && dash.classList.contains('active')) renderDashboardSoon();
});
// All Jobs: the filters added since the page was written (index.html keeps
// the first five) are put in once, here: where a job is on its board --
// Ready to invoice, money still owed, lost bids -- and which year.
function ensureDashFilters() {
  const st = document.getElementById('dashStatus');
  if (st && !st.querySelector('option[value="toInvoice"]')) {
    st.insertAdjacentHTML('beforeend', '<option value="toInvoice">Finished — not invoiced yet</option>' +
      '<option value="invoiced">Invoiced</option><option value="paid">Paid</option>' +
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
// A finished job's column is its stage (Finished / Invoiced / Paid, shown
// as the pill), so only the columns that add something are named: a bid's
// place on the Bids board, Punch list.
function dashStage(d, status) {
  if (isBidStatus(d.jobStatus) && d.bidStage === 'lost') return { id: 'lost', name: 'Lost' };
  if (status === 'complete') return null;
  const st = window.YDBoards && YDBoards.stageOf ? YDBoards.stageOf(d) : null;
  return st || null;
}
const DASH_SAME_AS_STATUS = { scheduled: 1, inProgress: 1, won: 1, toInvoice: 1, invoiced: 1, paid: 1 };
// What the job makes. Real costs (materials bought, labour clocked or
// entered) once there are any; until then what the estimate planned -- the
// price less what its materials, delivery, fuel and crew-days cost
// (pricing.js profit) -- marked as planned. With neither: unknown, never the
// whole price shown as profit.
function dashPlannedNet(d, price) {
  const e = d.estimate;
  if (!price || !e || !((e.work || []).length || (e.materials || []).length) || !window.YDEstimate || !YDEstimate.priceSaved) return null;
  try {
    const r = YDEstimate.priceSaved(e, d.city || '', d._id);
    if (!r || !r.profit || !r.profit.complete) return null;
    return round2(price - r.profit.costCents / 100);
  } catch (err) { return null; }
}
// The same, kept per job until the job, its price or town changes -- or the
// rules, Supplies' prices or the fuel prices do (the events below): pricing
// a whole estimate for every job at each All Jobs redraw was most of its time.
const dashNetKept = new Map();
function dashPlannedNetKept(d, price) {
  const key = (d.lastModified || '') + '|' + price + '|' + (d.city || '');
  const k = dashNetKept.get(d._id);
  if (k && k.key === key) return k.v;
  const v = dashPlannedNet(d, price);
  dashNetKept.set(d._id, { key: key, v: v });
  return v;
}
['yd-pricing', 'yd-supplies'].forEach(ev => document.addEventListener(ev, () => dashNetKept.clear()));
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
  // What the filters look at first, for every job; the figures that cost
  // something to work out (clocked labour, the estimate priced by the
  // rules) only for the jobs left showing. Every job used to be priced in
  // full and then most of them filtered away.
  let rows = jobsAll.map(d => {
    const status = normStatus(d.jobStatus, d);
    const jstage = jobStage(d);
    return { d: d, id: d._id, jstage: jstage.id, qbStage: !!jstage.qb, name: d.customerName || 'Untitled', est: String(d.estimateNumber || '').trim(), city: [d.city, d.state].filter(Boolean).join(', '), services: (d.serviceTypes || []).join(', '), status, price: parseMoney(d.jobPrice || ''),
      invoiced: isInvoiced(d), owed: dashOwed(d), lost: isBidStatus(d.jobStatus) && d.bidStage === 'lost', year: dashYearOf(d, status) };
  });
  const fYear = fillDashYears(Array.from(new Set(rows.map(r => r.year))));
  if (fYear && fYear !== 'all') rows = rows.filter(r => String(r.year) === fYear);
  if (fSvc) rows = rows.filter(r => r.services.includes(fSvc));
  // Bids show only when Bids (or Lost bids) is picked: the totals are for
  // work actually booked.
  rows = rows.filter(r => fStatus === 'lost' ? r.lost
    : fStatus === 'toInvoice' ? r.jstage === 'finished'
    : fStatus === 'invoiced' || fStatus === 'paid' ? r.jstage === fStatus
    : fStatus === 'owed' ? r.owed > 0
    : fStatus ? r.status === fStatus : r.status !== 'quoting');
  if (fSearch) rows = rows.filter(r => (r.name + ' ' + r.city + ' ' + r.services + ' ' + r.est).toLowerCase().includes(fSearch));
  rows.forEach(r => {
    const d = r.d;
    // Clocked shifts included, exactly as the job's own Tracking figures do.
    const lab = jobLabour(d._id, d.labor);
    r.hrs = lab.hours;
    r.matCost = (d.materials || []).reduce((s, e) => s + (parseFloat(e.price) || 0), 0);
    const real = lab.cost + r.matCost > 0;
    r.net = real ? round2(r.price - (lab.cost + r.matCost)) : dashPlannedNetKept(d, r.price);
    r.planned = !real && r.net != null;
    r.push = r.price ? '' : perPushText(d);
    r.stage = dashStage(d, r.status);
    r.why = lostWhy(d);
    r.plantBits = window.YDPlants ? window.YDPlants.badge(d) + window.YDPlants.owedChip(d) : '';
    delete r.d;
  });
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
  // What is owed: the same figure as Home's tile -- every unpaid QuickBooks
  // invoice on the Invoices list (ones tied to a job by hand, or not yet
  // copied onto one, too), whatever the table is filtered to (the year filter
  // is on by default, and last year's unpaid bill is still owed). Office
  // testing, 16 Oct 2026: All Jobs said $6,752 while Home said $7,392. With a
  // filter on, what the jobs shown owe is the line under it.
  const rowOwed = rows.reduce((s, r) => s + (r.owed > 0 ? r.owed : 0), 0);
  const filtered = !!(fSvc || fStatus || fSearch || (fYear && fYear !== 'all'));
  const invOpen = typeof ydCan === 'function' && ydCan('billing', 'see') && window.YDInvoices
    ? Object.values(YDInvoices.all() || {}).filter(i => i.open && Number(i.balance) > 0) : [];
  const totOwed = invOpen.length ? Math.round(invOpen.reduce((s, i) => s + Number(i.balance), 0) * 100) / 100 : rowOwed;
  const owedSub = filtered && invOpen.length && Math.abs(rowOwed - totOwed) >= 0.01 ? fmtMoney(rowOwed) + ' on the jobs shown' : '';
  const plannedN = known.filter(r => r.planned).length, unknownN = rows.length - known.length;
  document.getElementById('dashTotals').innerHTML = [
    { l: 'Jobs', v: rows.length, cls: '' }, { l: 'Total Booked', v: fmtMoney(totPrice), cls: 'accent-top' },
    { l: 'Est. Net Profit', v: fmtMoney(totNet), cls: 'pos-top',
      sub: [plannedN ? plannedN + ' planned, not yet costed' : '', unknownN ? unknownN + ' not known' : ''].filter(Boolean).join(' · ') },
    { l: 'Total Labor', v: fmtHrsMin(totHrs), cls: '' },
  ].concat(totOwed > 0 ? [{ l: 'Owed to you', v: fmtMoney(totOwed), cls: 'neg-top', sub: owedSub }] : [])
    .map(c => '<div class="summary-card ' + c.cls + '"><div class="summary-label">' + c.l + '</div><div class="summary-value">' + c.v + '</div>' +
      (c.sub ? '<div class="dash-sub">' + esc(c.sub) + '</div>' : '') + '</div>').join('');

  const w = document.getElementById('dashTableWrap');
  // Finished jobs with plants still owing their care email, whatever the
  // filters show (plantcare.js).
  const careNote = window.YDPlants ? window.YDPlants.owedNoteHtml(jobsAll) : '';
  // Why bids were lost, this year and last -- open when Lost bids is picked.
  const lostSum = lostReasonsHtml(jobsAll, fStatus === 'lost');
  if (!rows.length) { w.innerHTML = careNote + lostSum + '<p class="empty-msg">No jobs match.</p>'; return; }
  const arrow = c => dashSort.col === c ? (dashSort.asc ? ' ▲' : ' ▼') : '';
  // Old jobs' clocked labour waiting on shifts from before last year.
  const older = window.YDClock && YDClock.oldLabourNote ? YDClock.oldLabourNote() : '';
  const stageHtml = r => r.stage && !DASH_SAME_AS_STATUS[r.stage.id] ? '<span class="dash-stage">' + esc(r.stage.name) + '</span>' : '';
  const statusHtml = r => (r.lost ? '<span class="pill lost">Lost</span>' + (r.why ? ' <span class="lost-why">' + esc(r.why) + '</span>' : '')
      : stagePill(r.jstage) + stageHtml(r)) +
    // QuickBooks has an invoice for it -- said by the pill once it is
    // Invoiced or Paid; before that (a deposit invoice) by the chip.
    (r.invoiced && !r.qbStage ? '<span class="qb-chip" title="QuickBooks has an invoice for it">QB</span>' : '') + r.plantBits;
  const netHtml = r => r.net == null ? '<span class="muted" title="No costs recorded and no costed estimate yet">—</span>'
    : '<span style="color:' + (r.net >= 0 ? 'var(--pos)' : 'var(--neg)') + '"' +
      (r.planned ? ' class="dash-planned" title="Planned, from the estimate — no real costs recorded yet"' : '') + '>' +
      (r.net < 0 ? '-' : '') + fmtMoney(Math.abs(r.net)) + (r.planned ? '<small> plan</small>' : '') + '</span>';
  const owedHtml = r => r.owed == null ? '<span class="muted">—</span>'
    : r.owed > 0 ? '<span class="dash-owed">' + fmtMoney(r.owed) + '</span>' : '<span class="muted">Paid</span>';
  let h = careNote + lostSum + (older || '') + '<table class="dash-table"><thead><tr>' +
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
    h += '<tr style="cursor:pointer" onclick="loadJob(\'' + ordId(r.id) + '\')"><td class="bold">' + jobNameHtml(r.name, r.est) + '</td>' +
      '<td>' + esc(r.city || '—') + '</td><td>' + esc(r.services || '—') + '</td>' +
      '<td>' + statusHtml(r) + '</td>' +
      '<td class="bold">' + (r.price ? fmtMoney(r.price) : r.push ? esc(r.push) : '<span class="muted">—</span>') + '</td>' +
      '<td class="bold">' + owedHtml(r) + '</td>' +
      '<td class="bold">' + netHtml(r) + '</td></tr>';
    cardsHtml += '<button type="button" class="dash-card" onclick="loadJob(\'' + ordId(r.id) + '\')">' +
      '<span class="dash-card-top"><span class="dash-card-name">' + jobNameHtml(r.name, r.est) + '</span>' +
        '<span class="dash-card-price">' + (r.price ? fmtMoney(r.price) : r.push ? esc(r.push) : '<span class="muted">no price yet</span>') + '</span></span>' +
      '<span class="dash-card-status">' + statusHtml(r) + '</span>' +
      ((r.city || r.services) ? '<span class="dash-card-sub">' + esc([r.city, r.services].filter(Boolean).join(' · ')) + '</span>' : '') +
      '<span class="dash-card-nums"><span>Net ' + netHtml(r) + '</span>' +
        (r.owed != null ? '<span>Owed ' + owedHtml(r) + '</span>' : '') + '</span>' +
    '</button>';
  });
  h += '</tbody></table>';
  w.innerHTML = h + cardsHtml + '</div>';
}

// Why bids were lost (askLostReason): how many bids each reason cost this
// year and last, by the year each was marked lost, with what they were worth
// for whoever sees the money side (the owner, or an admin with Billing). A
// bid lost before reasons were asked counts as "Not said". Folded unless
// Lost bids is picked; once opened or closed by hand it stays that way.
let lostSumOpen = null;
function lostReasonsHtml(jobs, pickedLost) {
  const lost = (jobs || []).filter(d => isBidStatus(d.jobStatus) && d.bidStage === 'lost');
  if (!lost.length) return '';
  const a = window.YDAuth || {};
  const money = a.mode !== 'cloud' || !!a.isOwner || ydCan('billing', 'see');
  const y = new Date().getFullYear();
  const years = [y, y - 1];
  const yearOf = d => {
    const t = new Date(d.lostAt || d.bidStageAt || d.lastModified || '');
    return isNaN(t) ? null : t.getFullYear();
  };
  const tally = {};                 // reason id ('' = not said) -> year -> {n, cents}
  lost.forEach(d => {
    const yr = yearOf(d);
    if (years.indexOf(yr) === -1) return;
    const id = LOST_REASONS.some(r => r.id === d.lostReason) ? d.lostReason : '';
    const t = (tally[id] = tally[id] || {});
    const c = (t[yr] = t[yr] || { n: 0, cents: 0 });
    c.n += 1;
    c.cents += Math.round((parseMoney(d.jobPrice || '') || 0) * 100);
  });
  const ids = LOST_REASONS.map(r => r.id).concat(['']).filter(id => tally[id]);
  const count = yr => ids.reduce((s, id) => s + ((tally[id][yr] || {}).n || 0), 0);
  const thisYear = count(y);
  if (!ids.length) return '';
  ids.sort((p, q) => ((tally[q][y] || {}).n || 0) - ((tally[p][y] || {}).n || 0) ||
    ((tally[q][y - 1] || {}).n || 0) - ((tally[p][y - 1] || {}).n || 0));
  const cell = c => !c ? '<span class="muted">—</span>'
    : '<b>' + c.n + '</b>' + (money && c.cents ? ' <span class="muted">· ' + fmtMoney(c.cents / 100) + '</span>' : '');
  const open = lostSumOpen == null ? pickedLost : lostSumOpen;
  return '<details class="lost-sum"' + (open ? ' open' : '') + ' ontoggle="lostSumOpen = this.open">' +
    '<summary>📉 Why bids were lost — ' + thisYear + ' this year, ' + count(y - 1) + ' last year</summary>' +
    '<table class="lost-sum-table"><thead><tr><th>Why</th><th>' + y + '</th><th>' + (y - 1) + '</th></tr></thead><tbody>' +
    ids.map(id => '<tr><td>' + esc(id ? lostReasonName(id) : 'Not said') + '</td><td>' + cell(tally[id][y]) + '</td><td>' + cell(tally[id][y - 1]) + '</td></tr>').join('') +
    '</tbody></table>' +
    (money ? '<div class="hint">The figure beside each count is what those bids were worth.</div>' : '') +
  '</details>';
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
      // Something had for days is a rental, whatever its name: its days never
      // add into a pile of tons or yards.
      const days = isDayUnit(m.unit);
      const cat = days ? 'Rentals' : categorizeMaterialItem(m.item);
      const c = cats[cat] = cats[cat] || { name: cat, unit: days ? 'days' : getCategoryUnit(cat), total: 0, qty: 0, count: 0, items: [] };
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
        '<span class="bold">' + (it.qty ? esc(qtyUnitText(it.qty, it.unit)) + ' · ' : '') + fmtMoney(it.price) + '</span></div>'
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
  // Every job, those in Recently deleted too: a backup is the last copy.
  const idx = getJobIndexAll(); const jobs = {};
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
  reader.onload = async function(e) {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.jobs || !backup.index) throw new Error('bad file');
      if (!(await ydConfirm('They are merged into your jobs: a job is taken from the backup only where this device has none, or an older copy.',
            { title: 'Restore ' + backup.index.length + ' jobs?', ok: 'Restore' }))) { event.target.value = ''; return; }
      // A real merge: a job is taken from the backup only if this device does
      // not have it, or has an OLDER copy. Restoring a week-old backup used to
      // overwrite this week's edits, and sync then sent the old copies to
      // every other device too.
      const byId = {};
      getJobIndexAll().forEach(j => { byId[j.id] = j; });
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
  // The tax as QuickBooks or the estimate has it (jobBill) -- not the
  // retired 5.5% box, unless an old job still has it ticked.
  const bill = formBill();
  const jobPrice = bill.subtotal;
  const net = round2(jobPrice - (laborCost + totalMat));
  const lines = [
    'YD Exterior Visions — Job Cost Summary',
    'Customer: ' + name,
    est ? 'Estimate #: ' + est : null,
    qb ? 'QB Invoice #: ' + qb : null,
    '',
    'Job Price (subtotal): ' + fmtMoney(jobPrice),
    bill.tax > 0 ? 'Sales tax: ' + fmtMoney(bill.tax) : null,
    bill.total !== jobPrice ? 'Invoice Total: ' + fmtMoney(bill.total) + (bill.from === 'qb' ? ' (QuickBooks, tax included)' : '') : null,
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
    // Days written out ("days"), so the sheet doesn't read "3 day".
    const unit = isDayUnit(m.unit) ? qtyUnitText(m.qty || 0, m.unit).replace(/^\S+\s/, '') : (m.unit || '');
    rows.push([cell(fmtDateMDY(m.date)), cell(m.item), cell(m.qty || ''), cell(unit),
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

// ---- Questions in a window of the app's own ----------------------------
//
// The browser's own prompt() / confirm() / alert() boxes were used all over
// the app. Some phone in-app browsers (the one a link in a text opens, say)
// block them outright -- the button then does nothing at all -- and where
// they do work they are tiny on a phone, cannot show a button per choice and
// cannot say "that isn't a number" without losing what was typed. So every
// question goes through one window here instead, styled like the rest of
// the app, light or dark, with 44 px buttons.
//
// Each returns a Promise, so a caller waits for the answer with await:
//   if (!(await ydConfirm('Delete it?', { ok: 'Delete', danger: true }))) return;
//   const name = await ydPrompt('Name the new type', '');      // text, or null
//   const pick = await ydChoose('How?', [{ id: 'call', label: 'Called' },
//                  { id: 'other', label: 'Other', ask: 'How, in a few words' }]);
//                                                  // { id, text } or null
//   await ydAlert('Storm closed.\n\n...');
// Escape, the ×, Cancel and a tap on the dark backdrop all answer "no"
// (false / null) -- the same as Cancel on the old boxes, so nothing happens
// by accident. A backdrop tap is ignored once something is typed (the
// guardWindows rule below). Several can be open at once: the newest is in
// front and answered first.
//
// opts for all of them: title, ok (button words), cancel (button words, or
// false for no Cancel), danger (the OK button is red and Cancel has the
// focus, so Enter does not delete).
// ydPrompt also: placeholder, type ('text' | 'number' | 'email' ...),
// multiline, required (an empty answer is refused, not returned), check
// (v => '' when fine, else the words to show under the box), select (start
// with the text picked, for a copy box).
// ydForm(text, fields, opts) asks several things at once -- a town and its
// rate -- each field { id, label, value, placeholder, type, multiline,
// required, check, hint }, and answers { id: typed, ... } or null.
let askSeq = 0;
function ydAsk(opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const id = 'ydAsk' + (++askSeq);
    const was = document.activeElement;
    const make = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    };
    const m = make('div', 'modal-overlay ask-overlay active');
    m.id = id;
    const box = make('div', 'modal ask-modal');
    const asksWords = !!(opts.input || opts.fields);
    box.setAttribute('role', asksWords || opts.choices ? 'dialog' : 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const head = make('div', 'modal-head');
    const h = make('h2', '', opts.title || (asksWords ? 'Type it in' : opts.choices ? 'Pick one' : opts.okOnly ? 'Job Hub' : 'Are you sure?'));
    h.id = id + 'T';
    box.setAttribute('aria-labelledby', h.id);
    const x = make('button', 'modal-close');
    x.type = 'button';
    x.setAttribute('aria-label', 'Cancel');
    x.innerHTML = '&times;';
    head.appendChild(h); head.appendChild(x);
    const body = make('div', 'modal-body');
    // Newlines in the words are kept by the stylesheet.
    if (opts.text) body.appendChild(make('div', 'ask-text', opts.text));

    const okBtn = make('button', 'btn btn-filled' + (opts.danger ? ' btn-danger' : ''), opts.ok || (opts.choices ? 'Save' : 'OK'));
    okBtn.type = 'button';
    const cancelBtn = make('button', 'btn', opts.cancel || 'Cancel');
    cancelBtn.type = 'button';

    // The boxes to type in: one for ydPrompt, several for ydForm, and for
    // ydChoose one kept hidden until a choice that needs words is tapped.
    const specs = opts.fields ? opts.fields
      : opts.input ? [{ id: '_', value: opts.value, placeholder: opts.placeholder, type: opts.type, multiline: opts.multiline,
                         required: opts.required, check: opts.check }]
      : opts.choices ? [{ id: '_', required: true }] : [];
    const boxes = specs.map((f, i) => {
      const wrap = make('div', 'ask-field');
      const input = make(f.multiline ? 'textarea' : 'input', 'ask-input');
      input.id = id + 'F' + i;
      // A number is asked in a plain box with the phone's number keys: a
      // real number box quietly empties "$12" or "12 tons", and the answer
      // would come back blank instead of being read or questioned.
      if (!f.multiline) input.type = f.type && f.type !== 'number' ? f.type : 'text';
      if (f.type === 'number') input.inputMode = 'decimal';
      if (f.multiline) input.rows = 4;
      input.value = f.value != null ? String(f.value) : '';
      input.placeholder = f.placeholder || '';
      if (f.label) {
        const l = make('label', 'label', f.label);
        l.htmlFor = input.id;
        wrap.appendChild(l);
      } else input.setAttribute('aria-labelledby', h.id);
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(make('div', 'hint', f.hint));
      const err = make('div', 'ask-error');
      err.setAttribute('role', 'alert');
      wrap.appendChild(err);
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || f.multiline || e.isComposing) return;
        e.preventDefault();
        // Enter moves to the next box, and answers from the last one.
        const next = boxes[i + 1];
        if (next) next.input.focus(); else okBtn.click();
      });
      input.addEventListener('input', () => { err.textContent = ''; });
      return { spec: f, wrap: wrap, input: input, err: err };
    });

    let picked = null;
    if (opts.choices) {
      const grid = make('div', 'ask-choices');
      const other = boxes[0].wrap;
      other.classList.add('ask-other');
      other.hidden = true;
      opts.choices.forEach(c => {
        const b = make('button', 'ask-choice' + (c.id === opts.value ? ' on' : ''), c.label);
        b.type = 'button';
        if (c.hint) b.appendChild(make('small', '', c.hint));
        b.onclick = () => {
          // A choice that needs words ("Other") opens a box under the
          // buttons; the rest answer with the one tap.
          if (!c.ask) { finish({ id: c.id, text: null }); return; }
          picked = c;
          grid.querySelectorAll('.ask-choice').forEach(o => o.classList.toggle('on', o === b));
          other.hidden = false;
          boxes[0].input.placeholder = c.ask;
          okBtn.hidden = false;
          boxes[0].input.focus();
        };
        grid.appendChild(b);
      });
      body.appendChild(grid);
      // OK only shows once a choice needs words.
      okBtn.hidden = true;
    }
    boxes.forEach(b => body.appendChild(b.wrap));

    const acts = make('div', 'ask-actions');
    if (opts.cancel !== false && !opts.okOnly) acts.appendChild(cancelBtn);
    acts.appendChild(okBtn);
    body.appendChild(acts);
    box.appendChild(head); box.appendChild(body);
    m.appendChild(box);

    let done = false;
    function finish(answer) {
      if (done) return;
      done = true;
      m.remove();
      // Back to where the person was, so a keyboard user carries on.
      if (was && was.focus && document.contains(was)) { try { was.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
      resolve(answer);
    }
    const no = () => finish(opts.okOnly ? undefined : asksWords || opts.choices ? null : false);
    okBtn.onclick = () => {
      if (opts.okOnly) { finish(undefined); return; }
      if (!boxes.length) { finish(true); return; }
      // Every box checked; the first with a problem gets the cursor.
      let firstBad = null;
      boxes.forEach(b => {
        const v = b.input.value;
        const f = b.spec;
        const bad = f.required && !v.trim() ? (opts.choices ? 'Say it in a few words' : 'Type something in first')
          : typeof f.check === 'function' ? f.check(v) : '';
        b.err.textContent = bad || '';
        if (bad && !firstBad) firstBad = b;
      });
      if (firstBad) { firstBad.input.focus(); return; }
      if (opts.choices) { finish({ id: picked.id, text: boxes[0].input.value.trim().slice(0, 500) }); return; }
      if (opts.input) { finish(boxes[0].input.value); return; }
      const out = {};
      boxes.forEach(b => { out[b.spec.id] = b.input.value; });
      finish(out);
    };
    cancelBtn.onclick = no;
    x.onclick = no;
    // A tap on the backdrop is "no" -- unless something was typed, which
    // guardWindows catches first and keeps.
    let pressedOut = !window.PointerEvent;
    m.addEventListener('pointerdown', e => { pressedOut = e.target === m; });
    m.addEventListener('click', e => { if (e.target === m && pressedOut) no(); });
    document.body.appendChild(m);
    const first = boxes.length && !opts.choices ? boxes[0].input
      : opts.danger && !opts.okOnly && opts.cancel !== false ? cancelBtn : okBtn.hidden ? null : okBtn;
    setTimeout(() => {
      if (!first || done) return;
      try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
      if (first.select && first.value && (opts.select || opts.input)) first.select();
    }, 30);
  });
}
function ydConfirm(text, opts) { return ydAsk(Object.assign({}, opts, { text: text })); }
function ydForm(text, fields, opts) { return ydAsk(Object.assign({}, opts, { text: text, fields: fields })); }
function ydPrompt(text, value, opts) {
  return ydAsk(Object.assign({}, opts, { text: text, input: true, value: value == null ? '' : value }));
}
function ydChoose(text, choices, opts) { return ydAsk(Object.assign({}, opts, { text: text, choices: choices })); }
function ydAlert(text, opts) { return ydAsk(Object.assign({ ok: 'OK' }, opts, { text: text, okOnly: true })); }
// Text to copy by hand when the phone will not copy it for us: shown picked
// in a box, ready for the phone's own Copy.
function ydShowCopy(text, title) {
  return ydAsk({ title: title || 'Copy this', text: 'Press and hold in the box, then Copy.', input: true, multiline: true,
    value: text, select: true, ok: 'Done', cancel: false });
}
// The same question asked from a dozen places before opening another job.
// True when it is fine to carry on: nothing unsaved, or the person said so.
async function ydLeaveUnsavedJob() {
  if (typeof dirty === 'undefined' || !dirty) return true;
  return ydConfirm('The job open now has unsaved changes. Open this one anyway?',
    { title: 'Unsaved changes', ok: 'Open it anyway', cancel: 'Stay here' });
}
window.ydAsk = ydAsk; window.ydConfirm = ydConfirm; window.ydPrompt = ydPrompt;
window.ydChoose = ydChoose; window.ydAlert = ydAlert; window.ydShowCopy = ydShowCopy; window.ydForm = ydForm;
window.ydLeaveUnsavedJob = ydLeaveUnsavedJob;

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
  // only when a job screen is first shown (switchTab, launchJobId): the app
  // opens on Home, and building the form there at every launch slowed the
  // start on the iPad (and asked QuickBooks about that job each time).
  const idx = getJobIndex();
  if (idx.length) {
    idx.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
    launchJobId = idx[0].id;
    const onScreen = document.querySelector('.tab-panel.active');
    if (onScreen && ['panel-job', 'panel-tracking', 'panel-dashboard'].indexOf(onScreen.id) !== -1) { launchJobId = null; loadJob(idx[0].id, true); }
  }

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
  // Nothing typed and unsaved, no window open, nothing still to send, and no
  // answer still coming from Claude or QuickBooks (a reload would lose it).
  function safeToReload() {
    if (typeof dirty !== 'undefined' && dirty) return false;
    if (document.querySelector('.modal-overlay.active')) return false;
    try { if (window.YDDb && YDDb.pending && YDDb.pending() > 0) return false; } catch (e) { /* treat as fine */ }
    try { if (window.YDClaude && YDClaude.busy && YDClaude.busy()) return false; } catch (e) { /* treat as fine */ }
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
  window.reloadForUpdate = async function () {
    if (!safeToReload() && !(await ydConfirm('Something here isn’t saved yet.', { title: 'Reload anyway?', ok: 'Reload', cancel: 'Not yet', danger: true }))) return;
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
// window. The × still closes it, deliberately; Escape asks for a second
// press first (the Escape handler above).
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
    if (!o) return;
    // A window that saves each change itself (data-autosave: Pricing rules,
    // Notification settings) saved a tick or a pick the moment it was made.
    // Marking it made Esc say "press Esc again to close without saving" and
    // a tap outside say "Save, or close it with ×" in a window with nothing
    // unsaved and no Save button (office test, 16 Oct 2026).
    if (o.hasAttribute('data-autosave') && typeof e.target.onchange === 'function' &&
        /^(checkbox|radio|select-one|select-multiple)$/.test(e.target.type || '')) return;
    o.dataset.typed = '1';
  }, true);
  // ...and a box there that saves itself is saved as it is left (its own
  // onchange): nothing typed is waiting any more. A box that only fills in
  // something to add (Pricing rules' "e.g. 750" beside + Add) has no
  // onchange, so what is typed in it still counts.
  document.addEventListener('change', e => {
    const o = e.target && e.target.closest && e.target.closest('.modal-overlay[data-autosave]');
    if (o && typeof e.target.onchange === 'function') delete o.dataset.typed;
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

// The phone's Back (Android's button, an iPhone's swipe) closes the window in
// front, not the whole app (crew testing, 16 Oct 2026: Back from a card or a
// job page threw the person out of Job Hub). Each window that opens leaves a
// step in the browser's history; Back takes that step and presses the
// window's own close button, as Esc does -- so its closing work (a redraw, a
// question about unsaved changes) still runs. A window closed any other way
// (×, Save) takes its step back out quietly, so the next Back is the next
// window's, or leaves the app as before.
(function backClosesWindows() {
  const isWin = o => o && o.classList && (o.classList.contains('modal-overlay') || o.classList.contains('sheet-overlay'));
  const isOpen = o => isWin(o) && o.classList.contains('active');
  // The ⋯ menu, the search and the week's weather float over the screen
  // rather than being windows -- shown and hidden, with no × -- but on a
  // phone they cover it just the same, and Back from one left the app
  // (regression pass, 16 Oct 2026). Each gets a step too, closed its own way.
  // In the order Esc takes them: the menu, the search, then a window, and
  // the weather last (it gives way to a window in front of it).
  const FLOATERS = {
    headerMenu: () => closeHeaderMenu(),
    srchPanel: () => { if (typeof closeSearch === 'function') closeSearch(); },
    wxPanel: () => { if (typeof closeWeek === 'function') closeWeek(); },
  };
  const floating = id => { const f = document.getElementById(id); return f && !f.hidden ? f : null; };
  function inFront() {
    const first = ['headerMenu', 'srchPanel'].find(floating);
    if (first) return { el: floating(first), close: FLOATERS[first] };
    const top = typeof topOverlay === 'function' ? topOverlay() : null;
    const x = top && top.querySelector('.modal-close, .sheet-close');
    if (x) return { el: top, win: true, close: () => x.click() };
    if (floating('wxPanel')) return { el: floating('wxPanel'), close: FLOATERS.wxPanel };
    return null;
  }
  let steps = 0;          // history steps this page added for open windows
  let quietPops = 0;      // our own steps back, not the person's Back
  let held = 0;           // steps waiting for one of those to land
  let goes = 0;           // how many steps back of our own have been taken
  let byBack = 0;         // windows being closed by Back right now
  let armed = null, armedAt = 0;
  // Every window opened or closed in one moment is weighed together. One
  // closed as another opens (a row of All settings opening its screen) keeps
  // the step between them: a step back with a step added straight after it
  // landed the browser on the page's own first entry -- the step back is
  // aimed before the new one is added -- so the next Back left the app
  // (regression test, 16 Oct 2026).
  const seen = new MutationObserver(list => {
    let opened = 0, closed = 0;
    list.forEach(m => {
      const o = m.target;
      let was, now;
      if (m.attributeName === 'hidden') {
        if (!o || !FLOATERS[o.id]) return;
        // No hidden attribute before means it was showing.
        was = m.oldValue === null; now = !o.hidden;
      } else {
        if (!isWin(o)) return;
        was = /(^|\s)active(\s|$)/.test(String(m.oldValue || '')); now = isOpen(o);
      }
      if (now && !was) opened++;
      else if (!now && was) {
        if (byBack > 0) { byBack--; return; }
        if (steps - closed > 0) closed++;
      }
    });
    const kept = Math.min(opened, closed);
    opened -= kept; closed -= kept;
    if (closed > 0) {
      steps -= closed;
      quietPops++;
      const mine = ++goes;
      history.go(-closed);
      // Should that step back never be heard of, what waits on it goes anyway.
      setTimeout(() => { if (mine === goes && quietPops > 0) { quietPops = 0; addSteps(0); } }, 1500);
    }
    if (opened > 0) addSteps(opened);
  });
  // A step for each window opened -- held while one of our own steps back is
  // still on its way, which would otherwise take the new one with it.
  function addSteps(n) {
    held += n;
    if (quietPops > 0) return;
    for (; held > 0; held--) {
      try { history.pushState({ ydWin: true }, ''); steps++; } catch (e) { held = 0; /* a sandboxed page: Back as before */ }
    }
  }
  window.addEventListener('popstate', () => {
    if (quietPops > 0) { quietPops--; addSteps(0); return; }
    if (steps <= 0) return;
    steps--;
    const front = inFront();
    if (!front) return;
    const top = front.el;
    // Something typed in it: the first Back says so and stays (the step is
    // put back); a second one within a few seconds closes, as Esc does.
    if (front.win && top.dataset.typed && !top.classList.contains('ask-overlay') && !(armed === top && Date.now() - armedAt < 4000)) {
      armed = top; armedAt = Date.now();
      addSteps(1);
      showToast('Something is typed in here — press Back again to close without saving');
      return;
    }
    armed = null;
    byBack++;
    front.close();
    // A close button that only asks first (unsaved changes) leaves the window
    // open: it no longer has a step, so the next Back would leave the app --
    // give it one back.
    setTimeout(() => {
      if (front.win ? isOpen(top) : !top.hidden) { byBack = Math.max(0, byBack - 1); addSteps(1); }
    }, 400);
  });
  function watch() {
    seen.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], attributeOldValue: true });
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

// ═══════════════════════════════════════════════════════════
// SIDEBAR (PREVIEW)
// ═══════════════════════════════════════════════════════════
// Jonah, 15 Oct 2026: "Thirteen tabs is past what anyone scans, group them
// ... make this and let me view it prior to implementing." So it is a
// preview, switched on per computer from the ⋯ menu, and it changes nothing
// for anyone who has not switched it on.
//
// It is a second way to look at the SAME tab bar, not a second set of tabs:
// each entry calls switchTab() like the bar does, and shows or hides itself,
// lights up and carries its count by copying the matching bar button. Every
// module that hides a tab from somebody keeps doing it on the bar's button,
// so the sidebar can never show a screen the bar would not. The bar itself is
// only hidden by the stylesheet while the sidebar is up.
//
// Only on a laptop-wide window: a phone keeps its five tabs and More, and a
// narrow window goes back to the bar by itself.
const SIDEBAR_KEY = 'ydjobhub_sidebarPreview';
const SIDEBAR_SMALL_KEY = 'ydjobhub_sidebarSmall';
const SIDEBAR_MIN_WIDTH = 1024;
// The groups, in the order they sit. Contacts has a group of its own --
// People -- because the customer list (every QuickBooks customer, past ones
// too) is coming and belongs beside it, not among the jobs.
const SIDEBAR_GROUPS = [
  { name: 'Today', tabs: ['home', 'calendar'] },
  { name: 'Sales + jobs', tabs: ['job', 'tracking', 'dashboard', 'boards'] },
  { name: 'Snow', tabs: ['snow'] },
  { name: 'Crew', tabs: ['clock', 'crewjobs'] },
  { name: 'Stuff', tabs: ['supplies', 'receipts', 'equipment'] },
  { name: 'People', tabs: ['contacts'] }
];

function sidebarStored(key) {
  try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
}
function sidebarStore(key, on) {
  try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch (e) { /* private window: just this visit */ }
}
function sidebarFits() {
  return !!(window.matchMedia && window.matchMedia('(min-width:' + SIDEBAR_MIN_WIDTH + 'px)').matches);
}

// The ⋯ menu entry and the sidebar's own "Back to the tab bar" both land here.
function toggleSidebarPreview(on) {
  if (typeof on !== 'boolean') on = !sidebarStored(SIDEBAR_KEY);
  sidebarStore(SIDEBAR_KEY, on);
  applySidebar();
  if (typeof showToast === 'function') {
    showToast(on ? 'Sidebar preview on — only on this computer. "Back to the tab bar" is at the foot of it.'
      : 'Back to the tab bar.');
  }
}
function toggleSidebarSmall() {
  sidebarStore(SIDEBAR_SMALL_KEY, !sidebarStored(SIDEBAR_SMALL_KEY));
  applySidebar();
}

(function () {
  let built = false, watcher = null, queued = false;

  // A bar button's words without its icon or its count ("Receipts", not
  // "🧾Receipts3").
  function labelOf(b) {
    let t = '';
    b.childNodes.forEach(n => { if (n.nodeType === 3) t += n.textContent; });
    return t.trim();
  }
  function iconOf(b) {
    const i = b.querySelector('.tab-icon');
    return i ? i.textContent : '';
  }
  // Showing on the bar = not hidden by its module, and not hidden by the
  // stylesheet either (a button's own display, not its parent's).
  function barShows(b) {
    return !!(b && !b.hidden && getComputedStyle(b).display !== 'none');
  }

  function build(nav) {
    let html = '<div class="sb-top"><span class="sb-title">Screens</span>' +
      '<button type="button" class="sb-small" onclick="toggleSidebarSmall()"></button></div>' +
      '<div class="sb-list">';
    SIDEBAR_GROUPS.forEach((g, gi) => {
      html += '<div class="sb-group" role="group" aria-labelledby="sbHead' + gi + '">' +
        '<div class="sb-head" id="sbHead' + gi + '">' + esc(g.name) + '</div>';
      g.tabs.forEach(t => {
        const b = document.getElementById(tabButtonId(t));
        if (!b) return;
        html += '<button type="button" class="sb-item" data-tab="' + t + '" onclick="switchTab(\'' + t + '\')">' +
          '<span class="sb-icon" aria-hidden="true">' + esc(iconOf(b)) + '</span>' +
          '<span class="sb-label">' + esc(labelOf(b)) + '</span>' +
          '<span class="sb-count"></span></button>';
      });
      html += '</div>';
    });
    html += '</div><div class="sb-foot">' +
      '<button type="button" class="sb-back" onclick="toggleSidebarPreview(false)" title="Back to the tab bar">' +
      '<span class="sb-icon" aria-hidden="true">↩</span><span class="sb-label">Back to the tab bar</span></button>' +
      '<div class="sb-note">Preview — only on this computer</div></div>';
    nav.innerHTML = html;
    // Up and down arrows walk the screens, as in any list of choices.
    nav.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.prototype.filter.call(nav.querySelectorAll('.sb-item, .sb-back'), x => x.offsetParent !== null);
      const at = items.indexOf(document.activeElement);
      if (at === -1) return;
      e.preventDefault();
      const next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
      if (next) next.focus();
    });
    built = true;
  }

  // Copy the bar onto the sidebar: which screens show, which is open, the
  // counts, and the words More would say under each.
  function sync() {
    queued = false;
    const nav = document.getElementById('sideNav');
    if (!nav || !built) return;
    const hints = crewView() ? TAB_HINT_CREW : TAB_HINT;
    nav.querySelectorAll('.sb-item').forEach(item => {
      const t = item.dataset.tab, b = document.getElementById(tabButtonId(t));
      item.hidden = !barShows(b);
      if (!b) return;
      const on = b.classList.contains('active');
      item.classList.toggle('active', on);
      if (on) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      const label = labelOf(b);
      const lab = item.querySelector('.sb-label');
      if (lab && lab.textContent !== label) lab.textContent = label;
      const c = b.querySelector('.tab-count');
      const n = c ? c.textContent : '';
      const count = item.querySelector('.sb-count');
      if (count && count.textContent !== n) count.textContent = n;
      // The hint on hover; narrowed to icons, the name has to be there too.
      item.title = label + (hints[t] ? ' — ' + hints[t] : '') + (n ? ' (' + n + ')' : '');
    });
    // A heading with nothing under it for this person goes too.
    nav.querySelectorAll('.sb-group').forEach(g => {
      g.hidden = !g.querySelector('.sb-item:not([hidden])');
    });
    const small = document.documentElement.hasAttribute('data-sidebar-small');
    const sm = nav.querySelector('.sb-small');
    if (sm) {
      sm.textContent = small ? '»' : '«';
      sm.title = small ? 'Show the names' : 'Narrow it to icons';
      sm.setAttribute('aria-label', sm.title);
      sm.setAttribute('aria-expanded', small ? 'false' : 'true');
    }
  }
  function later() {
    if (queued) return;
    queued = true;
    setTimeout(sync, 0);
  }

  window.applySidebar = function () {
    const nav = document.getElementById('sideNav');
    const bar = document.querySelector('.tab-bar');
    if (!nav || !bar) return;
    const on = sidebarStored(SIDEBAR_KEY) && sidebarFits();
    const root = document.documentElement;
    root.toggleAttribute('data-sidebar', on);
    root.toggleAttribute('data-sidebar-small', on && sidebarStored(SIDEBAR_SMALL_KEY));
    nav.hidden = !on;
    if (on) {
      if (!built) build(nav);
      if (!watcher) {
        // Any module showing, hiding, lighting up or counting on a bar
        // button; and sign-in deciding crew or owner (the stylesheet hides
        // some buttons by that).
        watcher = new MutationObserver(later);
        watcher.observe(bar, { subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ['hidden', 'class'] });
        watcher.observe(root, { attributes: true, attributeFilter: ['data-crew'] });
      }
      sync();
    } else if (watcher) {
      watcher.disconnect();
      watcher = null;
    }
  };

  function start() {
    applySidebar();
    // Made narrower than a laptop (or wider again): back to the bar, and back.
    if (window.matchMedia) {
      const mq = window.matchMedia('(min-width:' + SIDEBAR_MIN_WIDTH + 'px)');
      if (mq.addEventListener) mq.addEventListener('change', applySidebar);
      else if (mq.addListener) mq.addListener(applySidebar);
    }
    // Belt and braces: not every browser tells a media query's change (a
    // window resized while in the background), so a resize checks too --
    // only acting when the answer has actually changed.
    window.addEventListener('resize', () => {
      const want = sidebarStored(SIDEBAR_KEY) && sidebarFits();
      if (want !== document.documentElement.hasAttribute('data-sidebar')) applySidebar();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// An iPad held upright lays the tabs out in two rows (styles.css). Seven to a
// row left a crew phone's eighth tab, Equipment, alone across the whole
// second row. Half each instead: the bar is told how many tabs are showing,
// and the stylesheet sizes them to fill two even rows (only between phone
// and laptop widths).
(function () {
  let queued = false;
  function count() {
    queued = false;
    const bar = document.querySelector('.tab-bar');
    if (!bar) return;
    const n = Array.from(bar.querySelectorAll('.tab-btn'))
      .filter(b => !b.hidden && getComputedStyle(b).display !== 'none').length;
    const perRow = n > 7 ? Math.ceil(n / 2) : Math.max(n, 1);
    if (bar.style.getPropertyValue('--tabs-per-row') !== String(perRow)) bar.style.setProperty('--tabs-per-row', perRow);
  }
  function later() { if (!queued) { queued = true; setTimeout(count, 0); } }
  function start() {
    const bar = document.querySelector('.tab-bar');
    if (!bar) return;
    // Any module showing or hiding a tab, and sign-in deciding crew or owner
    // (the stylesheet hides some tabs by that).
    new MutationObserver(later).observe(bar, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['data-crew'] });
    window.addEventListener('resize', later);
    count();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
