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
function fmtMoney(v) { const n = parseFloat(v); return isNaN(n)||n===0 ? '$0.00' : '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function parseMoney(s) { return parseFloat(String(s).replace(/[$,]/g,'')) || 0; }
function round2(n) { return Math.round(((parseFloat(n)||0) + Number.EPSILON) * 100) / 100; }
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

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



// ---- Night mode -------------------------------------------------------------
// Remembered per device: the phone that rides in the truck should stay dark
// without being asked every storm, while the desktop stays light.
function applyNight(on) {
  const r = document.documentElement;
  if (on) r.setAttribute('data-night', ''); else r.removeAttribute('data-night');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = on ? '#0c0a0e' : '#472c64';
  const btn = document.getElementById('nightBtn');
  if (btn) btn.textContent = on ? '◐ Day' : '◑ Night';
  try { localStorage.setItem(STORAGE_PREFIX + 'night', on ? '1' : ''); } catch (e) {}
}
function toggleNight() {
  applyNight(!document.documentElement.hasAttribute('data-night'));
}
try { if (localStorage.getItem(STORAGE_PREFIX + 'night')) applyNight(true); } catch (e) {}

// ---- Account: who is signed in, and signing out ----------------------------
// Signing out deliberately clears this device's cached jobs. Firestore holds
// the real copy, so nothing is lost -- but a crew member handing back a shared
// phone must not leave client names and prices sitting in it.
function ydSignOut() {
  if (typeof dirty !== 'undefined' && dirty
      && !confirm('You have unsaved changes on this job.\n\nSign out anyway?')) return;
  if (!confirm('Sign out of YD Job Hub?\n\nYour jobs stay safe in the cloud. '
             + 'This device will need to sign in again.')) return;

  closeHeaderMenu();
  try {
    Object.keys(localStorage)
      .filter(k => k.indexOf(STORAGE_PREFIX) === 0)
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { console.warn('could not clear local cache', e); }

  if (window.YDSignOut) window.YDSignOut();
  setTimeout(() => location.reload(), 400);
}

// Fill the menu in once we know who is signed in. Stays hidden entirely when
// running without Firebase, where there is no account to show.
document.addEventListener('yd-auth', e => {
  const a = e.detail || {};
  const who = document.getElementById('menuWho');
  const out = document.getElementById('menuSignOut');
  const sep = document.getElementById('menuAccountSep');
  const on = !!(a.user && a.mode === 'cloud');
  if (who) {
    who.hidden = !on;
    if (on) who.textContent = (a.role === 'owner' ? 'Owner · ' : 'Crew · ') + a.user.email;
  }
  if (out) out.hidden = !on;
  if (sep) sep.hidden = !on;

  // Crew get the clock and the snow route, and nothing else. Every other tab
  // reads jobs, prices or client details, which the rules deny them outright --
  // so leaving the tabs visible would hand them a row of screens that load
  // empty and look broken. This is presentation only; the rules are the
  // enforcement.
  const crewOnly = on && a.role === 'crew';
  ['tabJob', 'tabTracking', 'tabDashboard', 'tabMatdash'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.hidden = crewOnly;
  });

  // Save, New and My Jobs all act on jobs, which the rules deny crew -- the
  // buttons could only ever produce an error. The context bar goes too: it
  // names whichever client's job happens to be open, and a client's name has
  // no business on a crew phone.
  ['btnSave', 'btnNew', 'btnMyJobs'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.hidden = crewOnly;
  });
  const ctx = document.getElementById('ctxBar');
  if (ctx) ctx.style.display = crewOnly ? 'none' : '';

  // Crew see both their screens on the bar, so More would open on nothing.
  const more = document.getElementById('tabMore');
  if (more) more.hidden = crewOnly;
  if (crewOnly) {
    const openTab = document.querySelector('.tab-panel.active');
    if (!openTab || ['panel-job', 'panel-tracking', 'panel-dashboard', 'panel-matdash']
        .indexOf(openTab.id) !== -1) switchTab('clock');
  }
});

// ---- The More sheet ----
//
// Built each time it opens rather than written into the markup, so it lists
// exactly the screens this person is allowed to see. A crew member has no
// hidden screens at all, which is why they never get a More button.
function openMore() {
  const wrap = document.getElementById('moreItems');
  const sheet = document.getElementById('moreSheet');
  if (!wrap || !sheet) return;
  const hidden = TABS.filter(n => PHONE_TABS.indexOf(n) === -1)
    .filter(n => {
      const b = document.getElementById(tabButtonId(n));
      return b && !b.hidden;
    });
  wrap.innerHTML = hidden.length
    ? hidden.map(n => '<button class="sheet-item" onclick="switchTab(\'' + n + '\')">' +
        '<span class="sheet-item-name">' + TAB_LABEL[n] + '</span>' +
        (TAB_HINT[n] ? '<span class="sheet-item-hint">' + TAB_HINT[n] + '</span>' : '') +
      '</button>').join('')
    : '<p class="empty-msg">Nothing else here.</p>';
  sheet.classList.add('active');
}
function closeMore() {
  const s = document.getElementById('moreSheet');
  if (s) s.classList.remove('active');
}
function tabButtonId(name) {
  return { job: 'tabJob', snow: 'tabSnow', clock: 'tabClock', tracking: 'tabTracking',
    dashboard: 'tabDashboard', matdash: 'tabMatdash', contacts: 'tabContacts',
    equipment: 'tabEquipment' }[name] || '';
}

// ---- Header overflow menu (Backup / Restore / Print) ----
function toggleHeaderMenu() {
  const m = document.getElementById('headerMenu');
  if (m) m.hidden = !m.hidden;
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
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeHeaderMenu();
});

// ═══════════════════════════════════════════════════════════
// TABS + CONTEXT BAR
// ═══════════════════════════════════════════════════════════
// The bar on a phone holds only what gets used in the field. The rest is one
// tap away behind More, which is what stops every new screen making the bar
// more crowded than the last.
const TABS = ['job', 'snow', 'clock', 'equipment', 'tracking', 'dashboard', 'matdash', 'contacts'];
const PHONE_TABS = ['job', 'snow', 'clock', 'dashboard'];
const TAB_LABEL = { job: '📋 Job', snow: '❄️ Snow', clock: '⏱️ Clock',
  equipment: '🚜 Equipment', tracking: '🔨 Tracking',
  dashboard: '📊 All Jobs', matdash: '📦 Materials',
  contacts: '📇 Contacts' };
const TAB_HINT = { equipment: 'What each machine and truck is due for',
  tracking: 'Hours and materials on the job you have open',
  matdash: 'What you have bought across every job',
  contacts: 'People to ring later' };

function switchTab(name) {
  closeMore();
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', TABS[i] === name);
  });
  // On a phone, a screen reached through More has no button of its own, so
  // More itself carries the highlight -- otherwise nothing on the bar would
  // look selected and the app would seem to have lost its place.
  const more = document.getElementById('tabMore');
  if (more) more.classList.toggle('active', PHONE_TABS.indexOf(name) === -1);
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  if (name === 'dashboard') renderDashboard();
  if (name === 'matdash') renderMatDash();
  if (name === 'snow' && window.YDSnow) YDSnow.render();
  if (name === 'contacts' && window.YDProspects) YDProspects.render();
  if (name === 'clock' && window.YDClock) YDClock.render();
  if (name === 'equipment' && window.YDEquipment) YDEquipment.render();
}
function updateCtxBar() {
  const name = (document.getElementById('customerName').value || '').trim();
  const invoiced = document.getElementById('qbInvoiced') && document.getElementById('qbInvoiced').checked;
  document.getElementById('ctxName').innerHTML = esc(name || (currentJobId ? 'Untitled Job' : 'New Job')) + (invoiced ? '<span class="qb-chip">QB Invoiced</span>' : '');
  const st = document.getElementById('ctxStatus');
  st.textContent = jobStatus; st.className = 'pill ' + jobStatus;
  const dot = document.getElementById('ctxDot');
  dot.classList.remove('unsaved', 'error');
  if (storageBroken) { dot.classList.add('error'); document.getElementById('ctxDotText').textContent = 'Save failed'; }
  else if (dirty) { dot.classList.add('unsaved'); document.getElementById('ctxDotText').textContent = 'Saving…'; }
  else { document.getElementById('ctxDotText').textContent = 'Saved'; }
}

// ═══════════════════════════════════════════════════════════
// SERVICE TYPES
// ═══════════════════════════════════════════════════════════
function addServiceType() {
  const sel = document.getElementById('serviceTypeSelect');
  let val = sel.value;
  if (!val) return;
  if (val === '__custom') { val = prompt('Custom service type:'); if (!val || !val.trim()) { sel.value = ''; return; } val = val.trim(); }
  if (!serviceTypes.includes(val)) serviceTypes.push(val);
  sel.value = '';
  renderServiceTypes();
}
function removeServiceType(idx) { serviceTypes.splice(idx, 1); renderServiceTypes(); markDirty(); }
function renderServiceTypes() {
  const wrap = document.getElementById('serviceTypeTags');
  if (!serviceTypes.length) { wrap.innerHTML = '<span style="color:#a096ad;font-size:12px;padding:4px">No service types</span>'; return; }
  wrap.innerHTML = serviceTypes.map((s, i) => '<span class="svc-tag">' + esc(s) + '<button onclick="removeServiceType(' + i + ')">×</button></span>').join('');
}

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════
function onStatusChange() { jobStatus = document.getElementById('jobStatusSelect').value; updateCtxBar(); }
function syncStatusSelect() { document.getElementById('jobStatusSelect').value = jobStatus; }
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

function applyClientBlock(data) {
  const c = data.client || {};
  const setIf = (id, val) => { const el = document.getElementById(id); if (el && val && !el.value.trim()) el.value = val; };
  setIf('customerName', c.name || data.clientName);
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
function syncJobPriceFromProposals() {
  if (manualJobPrice) return;
  const total = getCombinedProposalTotal();
  if (total > 0) { baseJobPrice = total; document.getElementById('jobPrice').value = (baseJobPrice + getAdditionalCostsTotal()).toFixed(2); updateJobPriceSourceTag(); updateSummary(); }
}
function onJobPriceManualEdit() { manualJobPrice = true; baseJobPrice = parseMoney(document.getElementById('jobPrice').value) - getAdditionalCostsTotal(); updateJobPriceSourceTag(); }
function updateJobPriceSourceTag() {
  const tag = document.getElementById('jobPriceSourceTag');
  if (manualJobPrice) { tag.textContent = '(manual)'; tag.style.color = 'var(--accent-dark)'; }
  else if (proposals.length) { tag.textContent = '(auto)'; tag.style.color = 'var(--pos)'; }
  else tag.textContent = '';
}
function resetJobPriceToAuto() { if (!proposals.length) return; manualJobPrice = false; syncJobPriceFromProposals(); markDirty(); }
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
function rmOrderItem(id) { orderItems = orderItems.filter(m => m.id !== id); renderOrderList(); markDirty(); }
function renderOrderList() {
  const wrap = document.getElementById('orderListWrap');
  const prog = document.getElementById('orderProgress');
  if (!orderItems.length) {
    wrap.innerHTML = '<p class="empty-msg">No items yet — import a proposal or add manually.</p>';
    prog.innerHTML = ''; document.getElementById('orderBadge').textContent = ''; return;
  }
  const ordered = orderItems.filter(m => m.ordered).length, total = orderItems.length;
  const pct = Math.round(ordered / total * 100);
  prog.innerHTML = '<div class="progress-label"><span>Ordered</span><span>' + ordered + ' / ' + total + '</span></div>' +
    '<div class="progress"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
  wrap.innerHTML = orderItems.map(it =>
    '<div class="check-row' + (it.ordered ? ' done' : '') + '">' +
      '<input type="checkbox"' + (it.ordered ? ' checked' : '') + ' onchange="toggleOrderItem(\'' + it.id + '\')">' +
      '<span class="cr-name">' + esc(it.name) + '</span>' +
      (it.quantity ? '<span class="cr-qty">' + esc(String(it.quantity)) + '</span>' : '') +
      '<button class="remove-btn" onclick="rmOrderItem(\'' + it.id + '\')">×</button></div>'
  ).join('');
  document.getElementById('orderBadge').textContent = ordered + '/' + total + ' ordered';
}

// ═══════════════════════════════════════════════════════════
// LABOR  (worker · hours · minutes — total per worker, no date)
// ═══════════════════════════════════════════════════════════
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

  let h = '<div class="clocked-block"><div class="clocked-head">From the time clock</div>';
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
function rmLabor(id) { labor = labor.filter(e => e.id !== id); renderLabor(); markDirty(); }

// ═══════════════════════════════════════════════════════════
// MATERIALS / PURCHASES
// ═══════════════════════════════════════════════════════════
function isChangeOrder(itemName) {
  if (!orderItems.length) return false;
  const lower = (itemName || '').toLowerCase().trim();
  return !orderItems.some(qm => { const q = (qm.name || '').toLowerCase().trim(); return q && (q.includes(lower) || lower.includes(q)); });
}
function renderMaterials() {
  const w = document.getElementById('matTableWrap');
  if (!materials.length) { w.innerHTML = '<p class="empty-msg">No purchases yet.</p>'; }
  else {
    let h = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Item</th><th>Qty</th><th>From</th><th>Price</th><th></th></tr></thead><tbody>';
    materials.forEach(e => {
      const co = isChangeOrder(e.item);
      h += '<tr' + (co ? ' style="background:#fdf3ea"' : '') + '><td>' + fmtDateMD(e.date) + '</td>' +
        '<td class="bold">' + esc(e.item) + (co ? '<span class="change-tag" title="Advisory — this purchase didn\'t match a quoted item. Verify before treating as a change order.">not quoted?</span>' : '') + '</td>' +
        '<td>' + (e.qty ? esc(String(e.qty)) + (e.unit ? ' ' + esc(e.unit) : '') : '—') + '</td>' +
        '<td>' + esc(e.location || '—') + '</td>' +
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
function rmMaterial(id) { materials = materials.filter(e => e.id !== id); renderMaterials(); markDirty(); }

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
function rmAdditionalCost(id) { additionalCosts = additionalCosts.filter(e => e.id !== id); renderAdditionalCosts(); markDirty(); }
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
      h += '<tr><td>' + fmtDateMD(p.date) + '</td><td class="bold">' + esc(p.label || '') + '</td>' +
        '<td class="bold">' + fmtMoney(amt) + '</td><td>' + esc(p.notes || '—') + '</td>' +
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
function addPayment() {
  const amt = document.getElementById('payAmount').value;
  if (!amt) return;
  payments.push({ id: uid(), date: readMD('payDate'), amount: amt, label: document.getElementById('payLabel').value, notes: document.getElementById('payNotes').value.trim() });
  ['payAmount','payNotes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('payDate').value = todayMD();
  renderPayments(); markDirty();
}
function rmPayment(id) { payments = payments.filter(p => p.id !== id); renderPayments(); markDirty(); }

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
function clockedLabor() {
  return (window.YDClock && currentJobId)
    ? YDClock.forJob(currentJobId)
    : { byWorker: {}, paidHours: 0, billableHours: 0, costCents: 0, pendingHours: 0 };
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
  if (document.getElementById('laborTableWrap')) renderLabor();
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

  document.getElementById('financialsGrid').innerHTML = [
    { label: 'Labor Cost', value: fmtMoney(laborCost), cls: '', top: '', sub: laborCostSub(totalHrs) },
    { label: 'Total Cost', value: fmtMoney(overhead), cls: '', top: '', sub: 'Labor + Materials' },
    { label: 'Net Profit', value: (net < 0 ? '-' : '') + fmtMoney(Math.abs(net)), cls: hasPrice ? (net >= 0 ? 'positive' : 'negative') : '', top: hasPrice ? (net >= 0 ? 'pos-top' : 'neg-top') : '', sub: hasPrice ? (net / jobPrice * 100).toFixed(1) + '% margin' : 'Set job price' },
    { label: 'Profit / Hr', value: hasHrs ? ((perHr < 0 ? '-' : '') + fmtMoney(Math.abs(perHr))) : '—', cls: hasHrs ? (perHr >= 0 ? 'positive' : 'negative') : '', top: '', sub: hasHrs ? 'Per labor hour' : 'Add labor' },
  ].map(c => '<div class="fin-card ' + c.top + '"><div class="fin-label">' + c.label + '</div><div class="fin-value ' + c.cls + '">' + c.value + '</div><div style="font-size:11px;color:var(--muted);margin-top:3px">' + c.sub + '</div></div>').join('');

  renderPayments();
}

// ═══════════════════════════════════════════════════════════
// SAVE / LOAD
// ═══════════════════════════════════════════════════════════
const FIELDS = ['customerName','address','city','state','zip','phone','email','jobPrice','estimateNumber','referral','notes','qbInvoice'];

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
  d.serviceTypes = serviceTypes.slice();
  d.labor = labor; d.materials = materials; d.orderItems = orderItems;
  d.proposals = proposals; d.payments = payments; d.additionalCosts = additionalCosts;
  d.manualJobPrice = manualJobPrice; d.baseJobPrice = baseJobPrice; d.jobStatus = jobStatus;
  d.lastModified = new Date().toISOString();
  return d;
}
function loadJobData(d) {
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = d[f] || ''; });
  loadedQuoteDate = d.quoteDate || '';
  document.getElementById('quoteDate').value = d.quoteDate ? fmtDateMD(d.quoteDate) : todayMD();
  document.getElementById('qbInvoiced').checked = !!d.qbInvoiced;
  document.getElementById('taxable').checked = !!d.taxable;
  serviceTypes = Array.isArray(d.serviceTypes) ? d.serviceTypes.slice() : (d.serviceType ? [d.serviceType] : []);
  renderServiceTypes();
  labor = (d.labor || []).map(e => ({ ...e, id: e.id || uid() }));
  materials = (d.materials || []).map(e => ({ ...e, id: e.id || uid() }));
  const rawOrder = d.orderItems || d.quotedMaterials || [];
  orderItems = rawOrder.map(e => ({ id: e.id || uid(), proposalId: e.proposalId || null, name: e.name || '', quantity: e.quantity || '', ordered: !!e.ordered }));
  proposals = Array.isArray(d.proposals) ? d.proposals
            : (d.proposalData ? [{ id: uid(), label: d.proposalData.projectName || d.proposalData.title || 'Proposal', data: d.proposalData }] : []);
  payments = (d.payments || []).map(p => ({ ...p, id: p.id || uid() }));
  additionalCosts = (d.additionalCosts || []).map(e => ({ ...e, id: e.id || uid() }));
  manualJobPrice = !!d.manualJobPrice;
  if (d.baseJobPrice !== undefined && d.baseJobPrice !== null && d.baseJobPrice !== '') baseJobPrice = parseFloat(d.baseJobPrice) || 0;
  else baseJobPrice = parseMoney(d.jobPrice || '') - additionalCosts.reduce((s, e) => s + (parseFloat(e.materialCost) || 0) + (parseFloat(e.laborCost) || 0), 0);
  jobStatus = d.jobStatus || 'quoting';

  syncStatusSelect(); updateJobHeadBadge();
  renderLabor(); renderMaterials(); renderAdditionalCosts(); renderPayments();
  renderProposal(); renderOrderList(); updateSummary();
  dirty = false; updateCtxBar();
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
function migrateJobIndex() {
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
      invoiced: !!data.qbInvoiced,
      lastModified: data.lastModified || entry.lastModified || ''
    };
    if (fresh.price !== entry.price || fresh.city !== entry.city || fresh.services !== entry.services || fresh.status !== entry.status || fresh.name !== entry.name) changed = true;
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
    invoiced: !!data.qbInvoiced, lastModified: data.lastModified };
}

// Shared writer. Returns true on success, false on failure.
function persistJob(announce) {
  const data = getJobData();
  if (!currentJobId) currentJobId = uid();
  try {
    localStorage.setItem(STORAGE_PREFIX + currentJobId, JSON.stringify(data));
    let idx = getJobIndex().filter(j => j.id !== currentJobId);
    idx.unshift(buildIndexEntry(currentJobId, data));
    saveJobIndex(idx);
  } catch (err) {
    console.error('Save failed:', err);
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
  // Don't create a phantom job from an empty form
  if (!currentJobId && jobIsEmpty()) return;
  if (persistJob(false)) { dirty = false; updateCtxBar(); }
  else if (!storageWarned) { storageWarned = true; showStorageError(); }  // warn once, then rely on the red dot
}
function showStorageError() {
  showToast('⚠ Save failed — storage may be full. Export a backup, then delete old jobs.');
}

function loadJob(id) {
  const raw = readJobBlob(id);
  if (!raw) return;
  currentJobId = id;
  loadingJob = true;
  try { loadJobData(JSON.parse(raw)); } catch (e) { console.error(e); showToast('Could not load job'); }
  loadingJob = false;
  closeManager(); switchTab('job');
}
function deleteJob(id) {
  if (!confirm('Delete this job permanently?')) return;
  localStorage.removeItem(STORAGE_PREFIX + id);
  localStorage.removeItem(id);   // also drop legacy-key copy if present
  saveJobIndex(getJobIndex().filter(j => j.id !== id));
  invalidateJobsCache();
  if (currentJobId === id) newJob();
  renderJobList(); showToast('Job deleted');
}
function duplicateJob(id) {
  const raw = readJobBlob(id);
  if (!raw) return;
  const data = JSON.parse(raw);
  data.customerName = (data.customerName || 'Untitled') + ' (copy)';
  data.qbInvoice = ''; data.qbInvoiced = false;   // a copy hasn't been invoiced
  const newId = uid(); data.lastModified = new Date().toISOString();
  try { localStorage.setItem(STORAGE_PREFIX + newId, JSON.stringify(data)); }
  catch (err) { showStorageError(); return; }
  const idx = getJobIndex();
  idx.unshift(buildIndexEntry(newId, data));
  saveJobIndex(idx); invalidateJobsCache(); renderJobList(); showToast('Job duplicated');
}
function newJob() {
  if (dirty && !confirm('Start a new job? Unsaved changes will be lost.')) return;
  currentJobId = null;
  labor = []; materials = []; orderItems = []; proposals = []; payments = []; additionalCosts = [];
  serviceTypes = []; jobStatus = 'quoting'; manualJobPrice = false; baseJobPrice = 0;
  storageBroken = false; storageWarned = false;
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  document.getElementById('qbInvoiced').checked = false;
  document.getElementById('taxable').checked = false;
  loadedQuoteDate = '';
  document.getElementById('quoteDate').value = todayMD();
  syncStatusSelect(); updateJobHeadBadge();
  renderServiceTypes(); renderLabor(); renderMaterials(); renderAdditionalCosts(); renderPayments();
  renderProposal(); renderOrderList(); updateSummary();
  dirty = false; updateCtxBar(); switchTab('job'); showToast('New job started');
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
function renderJobList() {
  const body = document.getElementById('jobListBody');
  const fSvc = document.getElementById('filterService').value;
  const fSearch = (document.getElementById('filterSearch').value || '').toLowerCase().trim();
  let idx = getJobIndex();
  if (fSvc) idx = idx.filter(j => (j.services || '').includes(fSvc));
  if (fSearch) idx = idx.filter(j => (j.name + ' ' + (j.city || '') + ' ' + (j.services || '')).toLowerCase().includes(fSearch));
  if (!idx.length) { body.innerHTML = '<p class="empty-msg">No jobs found. Import a proposal or start a new job.</p>'; return; }

  const groups = {};
  idx.forEach(j => { const dt = j.lastModified ? new Date(j.lastModified) : new Date(); const key = MONTHS[dt.getMonth()] + ' ' + dt.getFullYear(); (groups[key] = groups[key] || []).push(j); });
  const keys = Object.keys(groups).sort((a, b) => { const [ma, ya] = a.split(' '), [mb, yb] = b.split(' '); return yb - ya || MONTHS.indexOf(mb) - MONTHS.indexOf(ma); });
  body.innerHTML = keys.map(key => {
    const shut = collapsedMonths[key];
    const rows = groups[key].map(j =>
      '<div class="job-row"><div class="job-row-main" onclick="loadJob(\'' + j.id + '\')">' +
        '<div class="job-row-name">' + esc(j.name) + ' <span class="pill ' + (j.status || 'quoting') + '">' + (j.status || 'quoting') + '</span></div>' +
        '<div class="job-row-sub">' + (j.city ? esc(j.city) + ' · ' : '') + (j.services ? esc(j.services) + ' · ' : '') + fmtMoney(j.price) + '</div></div>' +
      '<div style="display:flex;gap:4px"><button class="dup-btn" onclick="duplicateJob(\'' + j.id + '\')">DUP</button>' +
      '<button class="remove-btn" onclick="deleteJob(\'' + j.id + '\')">×</button></div></div>'
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
function renderDashboard() {
  const svcSel = document.getElementById('dashFilter');
  const jobsAll = loadAllJobs();
  // Rebuild the service filter every render so newly-added service types appear (keep current pick)
  const prevSvc = svcSel.value;
  const set = new Set(); jobsAll.forEach(j => (j.serviceTypes || []).forEach(s => set.add(s)));
  svcSel.innerHTML = '<option value="">All Services</option>' + [...set].sort().map(s => '<option>' + esc(s) + '</option>').join('');
  svcSel.value = prevSvc;
  const fSvc = svcSel.value, fStatus = document.getElementById('dashStatus').value, fSearch = (document.getElementById('dashSearch').value || '').toLowerCase().trim();
  let rows = jobsAll.map(d => {
    const hrs = (d.labor || []).reduce((s, e) => s + entryHours(e), 0);
    const matCost = (d.materials || []).reduce((s, e) => s + (parseFloat(e.price) || 0), 0);
    const price = parseMoney(d.jobPrice || '');
    const net = round2(price - (hrs * LABOR_RATE + matCost));
    return { id: d._id, name: d.customerName || 'Untitled', city: [d.city, d.state].filter(Boolean).join(', '), services: (d.serviceTypes || []).join(', '), status: d.jobStatus || 'quoting', price, hrs, matCost, net, invoiced: !!d.qbInvoiced };
  });
  if (fSvc) rows = rows.filter(r => r.services.includes(fSvc));
  if (fStatus) rows = rows.filter(r => r.status === fStatus);
  if (fSearch) rows = rows.filter(r => (r.name + ' ' + r.city + ' ' + r.services).toLowerCase().includes(fSearch));
  rows.sort((a, b) => { let va = a[dashSort.col], vb = b[dashSort.col]; if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); } if (va < vb) return dashSort.asc ? -1 : 1; if (va > vb) return dashSort.asc ? 1 : -1; return 0; });

  document.getElementById('dashCount').textContent = rows.length + ' job' + (rows.length !== 1 ? 's' : '');
  const totPrice = rows.reduce((s, r) => s + r.price, 0), totNet = rows.reduce((s, r) => s + r.net, 0), totHrs = rows.reduce((s, r) => s + r.hrs, 0);
  document.getElementById('dashTotals').innerHTML = [
    { l: 'Jobs', v: rows.length, cls: '' }, { l: 'Total Booked', v: fmtMoney(totPrice), cls: 'accent-top' },
    { l: 'Est. Net Profit', v: fmtMoney(totNet), cls: 'pos-top' }, { l: 'Total Labor', v: fmtHrsMin(totHrs), cls: '' },
  ].map(c => '<div class="summary-card ' + c.cls + '"><div class="summary-label">' + c.l + '</div><div class="summary-value">' + c.v + '</div></div>').join('');

  const w = document.getElementById('dashTableWrap');
  if (!rows.length) { w.innerHTML = '<p class="empty-msg">No jobs match.</p>'; return; }
  const arrow = c => dashSort.col === c ? (dashSort.asc ? ' ▲' : ' ▼') : '';
  let h = '<table><thead><tr>' +
    '<th style="cursor:pointer" onclick="sortDash(\'name\')">Customer' + arrow('name') + '</th>' +
    '<th style="cursor:pointer" onclick="sortDash(\'city\')">Location' + arrow('city') + '</th>' +
    '<th>Services</th><th style="cursor:pointer" onclick="sortDash(\'status\')">Status' + arrow('status') + '</th>' +
    '<th style="cursor:pointer" onclick="sortDash(\'price\')">Price' + arrow('price') + '</th>' +
    '<th style="cursor:pointer" onclick="sortDash(\'net\')">Est. Net' + arrow('net') + '</th></tr></thead><tbody>';
  rows.forEach(r => {
    h += '<tr style="cursor:pointer" onclick="loadJob(\'' + r.id + '\')"><td class="bold">' + esc(r.name) + '</td>' +
      '<td>' + esc(r.city || '—') + '</td><td>' + esc(r.services || '—') + '</td>' +
      '<td><span class="pill ' + r.status + '">' + r.status + '</span>' + (r.invoiced ? '<span class="qb-chip">QB</span>' : '') + '</td>' +
      '<td class="bold">' + fmtMoney(r.price) + '</td>' +
      '<td class="bold" style="color:' + (r.net >= 0 ? 'var(--pos)' : 'var(--neg)') + '">' + (r.net < 0 ? '-' : '') + fmtMoney(Math.abs(r.net)) + '</td></tr>';
  });
  h += '</tbody></table>';
  w.innerHTML = h;
}

// ═══════════════════════════════════════════════════════════
// MATERIALS DASHBOARD
// ═══════════════════════════════════════════════════════════
function categorizeMaterialItem(desc) { const l = (desc || '').toLowerCase(); for (const cat of MATERIAL_CATEGORIES) if (cat.keywords.some(k => l.includes(k))) return cat.name; return 'Other'; }
function getCategoryUnit(name) { const c = MATERIAL_CATEGORIES.find(c => c.name === name); return c ? c.unit : 'ea'; }
function getDateRangeStart(range) {
  const now = new Date();
  if (range === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (range === 'year') return new Date(now.getFullYear(), 0, 1);
  if (range === 'season') return new Date(now.getFullYear(), 3, 1);
  if (range === '30') return new Date(now.getTime() - 30 * 864e5);
  if (range === '90') return new Date(now.getTime() - 90 * 864e5);
  return null;
}
function renderMatDash() {
  const range = document.getElementById('matDashRange').value;
  const search = (document.getElementById('matDashSearch').value || '').toLowerCase().trim();
  const start = getDateRangeStart(range);
  const jobs = loadAllJobs();
  const cats = {}; let grandTotal = 0, purchaseCount = 0;
  jobs.forEach(d => {
    (d.materials || []).forEach(m => {
      if (start && m.date) { const md = new Date(m.date + 'T00:00:00'); if (md < start) return; }
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
  a.href = url; a.download = 'yd-job-hub-backup-' + new Date().toISOString().split('T')[0] + '.json'; a.click(); URL.revokeObjectURL(url);
  localStorage.setItem(STORAGE_PREFIX + 'lastBackup', new Date().toISOString());
  showToast('Backup downloaded (' + idx.length + ' jobs)');
}
function importAllJobs(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.jobs || !backup.index) throw new Error('bad file');
      if (!confirm('Restore ' + backup.index.length + ' jobs? This merges into your current jobs.')) { event.target.value = ''; return; }
      Object.keys(backup.jobs).forEach(id => localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(backup.jobs[id])));
      const existing = getJobIndex(); const byId = {};
      [...existing, ...backup.index].forEach(j => { byId[j.id] = j; });
      saveJobIndex(Object.values(byId));
      invalidateJobsCache();
      event.target.value = ''; showToast('Restored ' + backup.index.length + ' jobs'); renderDashboard();
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
  const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  let csv = 'Date,Item,Quantity,Unit,Vendor,Price\n';
  materials.forEach(m => {
    csv += [fmtDateMD(m.date), esc(m.item), m.qty || '', m.unit || '', esc(m.location || ''), (parseFloat(m.price) || 0).toFixed(2)].map(String).join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'purchases-' + name + '.csv'; a.click(); URL.revokeObjectURL(url);
  showToast('Purchases CSV downloaded');
}

// ═══════════════════════════════════════════════════════════
// TOAST + INIT
// ═══════════════════════════════════════════════════════════
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--brand);color:#fff;padding:13px 22px;font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;z-index:2000;opacity:0;transition:opacity .3s;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = '1';
  setTimeout(() => t.style.opacity = '0', 2000);
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('quoteDate').value = todayMD();
  resetDateInputs();
  document.getElementById('laborRateBadge').textContent = '@ $' + LABOR_RATE + '/hr';
  renderServiceTypes(); renderLabor(); renderMaterials(); renderAdditionalCosts(); renderPayments();
  syncStatusSelect(); renderProposal(); renderOrderList(); updateSummary(); updateCtxBar();

  migrateJobIndex();   // repair index entries from older versions (prices, fields, key scheme)

  const idx = getJobIndex();
  if (idx.length) { idx.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || '')); loadJob(idx[0].id); }

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
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration skipped:', err.message)); });
  }
  // Clear out a worker registered by an earlier visit, or it keeps serving the
  // cache long after registration stopped.
  if ('serviceWorker' in navigator && LOCAL_DEV) {
    navigator.serviceWorker.getRegistrations()
      .then(rs => rs.forEach(r => r.unregister()))
      .then(() => caches && caches.keys().then(ks => ks.forEach(k => caches.delete(k))))
      .catch(() => {});
  }

  // Gentle backup reminder if it's been a while (or never)
  setTimeout(() => {
    if (!getJobIndex().length) return;
    const last = localStorage.getItem(STORAGE_PREFIX + 'lastBackup');
    const stale = !last || (Date.now() - new Date(last).getTime()) > 30 * 864e5;
    if (stale) showToast('Tip: tap Backup to save a copy of your jobs');
  }, 3500);
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
