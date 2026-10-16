// One services list -- shared by jobs, contacts, customers and the
// subcontractors' properties -- sorted by kind of work, with what to tell a
// homeowner about each.
//
// Jonah (15 Oct 2026): "One services list: Shared by jobs, contacts and
// subcontractors, with merge and delete for your own kinds, tags and
// equipment types ... organized by kinds of work. Ill want detailed +
// summarized descriptions of each so the guys can easily describe to a
// homeowner."
//
// Where it lives: ONE record, settings/serviceList --
//   { groups:   { id: { name, order, active } },          the kinds of work
//     services: { id: { name, group, summary, details, aliases[], qbItemName,
//                       active, order, addedAt, addedBy } },
//     seededAt, updatedAt }
// One record rather than a collection: the whole list is a few dozen short
// entries, everyone reads all of it at once (a picker, the crew's page), and
// one read is one read. Maps keyed by id, so two devices changing different
// services at the same moment both keep theirs (writes merge).
//
// What the records keep: jobs (serviceTypes), contacts (services), customers
// (tags) and subcontractors' properties (services) still store the service's
// NAME, as they always have -- nothing is migrated. They pick from this list.
// Merging "Firepit" into "Fire pit" makes "Firepit" an old spelling of Fire
// pit: typed again anywhere it becomes Fire pit (canon), and the records that
// say "Firepit" are changed only when Jonah taps to, with the count shown.
// Hiding takes a service out of the pickers; records keep their words.
//
// Who: everyone signed in reads it (the crew's "What we do" page). The owner
// changes it. An admin who fills in jobs or contacts can only ADD a service
// (one typed in on a job) -- never change or hide one; the rules hold them to
// that. The descriptions are what the crew say to customers, so they are
// Jonah's words: this file never writes any, it only offers his own
// QuickBooks product wording to copy in.
//
// Also here, under "Your other lists": his own equipment types, supply tags
// and material kinds -- each with how much uses it, rename and merge (and for
// tags, take it off). Contacts' tags ARE this services list.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const s = v => String(v == null ? '' : v).trim();
  const DOC = 'serviceList';
  // The same key the old saved-services list used, so its names fold in as one.
  const keyOf = n => s(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const safeId = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
  const iso = () => new Date().toISOString();
  const can = (area, lvl) => typeof ydCan === 'function' && ydCan(area, lvl);
  const signedIn = () => !!(window.YDAuth && window.YDAuth.user && window.YDAuth.mode === 'cloud');
  const owner = () => signedIn() && !!window.YDAuth.isOwner;
  // An admin may add a service typed on a job or a contact (rules: add-only).
  const mayAdd = () => owner() || can('jobs', 'change') || can('contacts', 'change');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const wide = () => window.innerWidth > 720;

  // The kinds of work it starts with. Names, not business numbers; Jonah can
  // rename, add, reorder and hide them.
  const GROUPS = [
    ['hardscape', 'Hardscaping'], ['landscape', 'Landscaping & planting'], ['lawn', 'Lawn care'],
    ['drainage', 'Drainage'], ['seasonal', 'Seasonal & cleanup'], ['snow', 'Snow & ice'],
    ['trees', 'Trees'], ['other', 'Other'],
  ];
  // Which kind of work a name sounds like -- for the first fill and for one
  // typed in later. Plain words, first match wins; anything else is Other,
  // and he moves it with one tap. (Order matters: "Shrub trimming" is
  // planting before "trimming" makes it lawn care; "Stone Edging" is
  // hardscaping before "edging" makes it lawn care.)
  const GUESS = [
    ['snow', /snow|\bice\b|salt|plow/],
    ['trees', /\btrees?\b|stump/],
    ['drainage', /drain|grading|gutter|downspout|french/],
    ['seasonal', /clean ?-?up|\bleaf|leaves|haul/],
    ['hardscape', /patio|walkway|wall|paver|stone|fire ?pit|hardscap|cedar|pergola|structure|\bsteps?\b|concrete/],
    ['landscape', /shrub|plant|mulch|landscap|garden|\bbeds?\b/],
    ['lawn', /mow|trim|edging|blowing|fertili|weed|aerat|seed|lawn|\bsod\b|turf|restoration|maintenance/],
  ];
  function guessGroup(name) {
    const n = s(name).toLowerCase();
    const hit = GUESS.find(([, re]) => re.test(n));
    const g = hit ? hit[0] : 'other';
    return list && list.groups[g] ? g : (list ? firstGroup() : g);
  }

  // The services the page was written with (index.html's list), read once
  // before anything replaces them: the first fill, and what the pickers keep
  // offering until the list has been read.
  const PAGE_SERVICES = (() => {
    const sel = el('serviceTypeSelect');
    return sel ? Array.prototype.filter.call(sel.options, o => o.value && o.value !== '__custom').map(o => o.value) : [];
  })();

  let list = null;          // { groups, services } once read; null = not yet (pickers keep the page's own)
  let onServer = false;     // the record is there on the server (an admin may only add to one that is)
  let index = {};           // key of a name or old spelling -> service id
  let mode = 'manage';      // the window: 'manage' (owner) | 'read' (What we do)
  let editing = null;       // service id whose editor is open
  let draft = null;         // that editor's boxes, kept across redraws
  let focusId = null;       // What we do: the one asked about
  let search = '';
  const openGroups = {};    // group id -> folded open (this visit)
  let qb = null, qbAsking = false, qbErr = '';     // QuickBooks products, for their wording

  // ------------------------------------------------------------ reading it

  function tidyList(d) {
    const out = { groups: {}, services: {} };
    Object.entries((d && d.groups) || {}).forEach(([id, g]) => { if (g && g.name) out.groups[id] = g; });
    Object.entries((d && d.services) || {}).forEach(([id, v]) => { if (v && s(v.name)) out.services[id] = v; });
    if (!Object.keys(out.groups).length) GROUPS.forEach(([id, name], i) => { out.groups[id] = { name: name, order: i, active: true }; });
    return out;
  }
  function reindex() {
    index = {};
    // Names first, then old spellings, so a name always means itself.
    Object.entries(list.services).forEach(([id, v]) => { index[keyOf(v.name)] = id; });
    Object.entries(list.services).forEach(([id, v]) => (v.aliases || []).forEach(a => {
      const k = keyOf(a);
      if (k && !index[k]) index[k] = id;
    }));
  }
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(b.name);
  function groupsSorted(all) {
    return Object.entries(list.groups).map(([id, g]) => Object.assign({ id: id }, g))
      .filter(g => all || g.active !== false).sort(byOrder);
  }
  const firstGroup = () => (list.groups.other ? 'other' : (groupsSorted()[0] || { id: 'other' }).id);
  const groupOf = v => (list.groups[v.group] ? v.group : firstGroup());
  function servicesIn(gid, hidden) {
    return Object.entries(list.services).map(([id, v]) => Object.assign({ id: id }, v))
      .filter(v => groupOf(v) === gid && (hidden ? v.active === false : v.active !== false)).sort(byOrder);
  }
  function activeNames() {
    if (!list) return [];
    const out = [];
    groupsSorted(true).forEach(g => servicesIn(g.id).forEach(v => out.push(v.name)));
    return out;
  }
  // A name as typed -> the service it is on the list (its own name or an old
  // spelling, whatever the capitals), else as typed.
  function canon(name) {
    const n = s(name).slice(0, 60);
    if (!list) return n;
    const id = index[keyOf(n)];
    return id && list.services[id] ? list.services[id].name : n;
  }
  const known = name => !!(list && index[keyOf(name)]);

  function load(fresh) {
    if (!signedIn() || !window.YDDb) return Promise.resolve();
    const ask = fresh && window.YDDb.getFresh ? window.YDDb.getFresh('settings', DOC) : window.YDDb.get('settings', DOC);
    return Promise.resolve(ask).then(d => {
      // Only a server answer counts as "it is not there yet": an offline
      // read of nothing must not start a second first fill.
      if (fresh) onServer = !!d;
      else if (d) onServer = true;
      if (!d && fresh && owner()) return firstFill();
      if (!d) return;
      list = tidyList(d);
      reindex();
      if (owner() && fresh) foldTypedIn();
      changed(false);
    }).catch(e => {
      // No signal (a fresh read), or the rules not yet published: the cached
      // copy if there is one, else the pickers keep the page's own list.
      if (fresh) return load(false);
      console.warn('[services] list not read:', (e && e.code) || e);
    });
  }

  // The first time (the owner's device, the server having said there is no
  // list yet): every name the app knew -- the Job tab's, the subcontractors'
  // usual ones, and the ones typed in and kept (settings/services) -- each
  // put under the kind of work it sounds like. The ids come from the names,
  // so two devices doing this at once write the same thing.
  function firstFill() {
    return Promise.resolve(window.YDDb.get('settings', 'services')).catch(() => null).then(typed => {
      const subs = window.YDSubs && window.YDSubs.services ? window.YDSubs.services() : [];
      const names = PAGE_SERVICES.concat(subs, Object.values((typed && typed.custom) || {}).filter(Boolean));
      const groups = {}, services = {}, seen = {};
      GROUPS.forEach(([id, name], i) => { groups[id] = { name: name, order: i, active: true }; });
      list = { groups: groups, services: {} };
      names.forEach((n, i) => {
        n = s(n).slice(0, 60);
        const k = keyOf(n);
        if (!k || seen[k]) return;
        seen[k] = true;
        services['s_' + k] = blank(n, guessGroup(n), i);
      });
      list.services = services;
      reindex();
      write({ groups: groups, services: services, seededAt: iso() }, 'starting the list');
      onServer = true;
      changed(false);
    });
  }
  // Names typed in by an older copy of the app (settings/services) that the
  // list does not know yet join it -- on the owner's device, once per read.
  function foldTypedIn() {
    Promise.resolve(window.YDDb.get('settings', 'services')).then(typed => {
      if (!list) return;
      const add = {}, seen = {};
      let order = nextOrder();
      Object.values((typed && typed.custom) || {}).forEach(n => {
        n = s(n).slice(0, 60);
        if (!n || known(n) || seen[keyOf(n)]) return;
        seen[keyOf(n)] = true;
        add[newId(n)] = blank(n, guessGroup(n), order++);
      });
      if (Object.keys(add).length) write({ services: add }, 'adding typed-in services');
    }).catch(() => {});
  }
  function blank(name, group, order) {
    const who = window.YDAuth && window.YDAuth.user ? (window.YDAuth.user.email || '') : '';
    return { name: name, group: group, summary: '', details: '', aliases: [], qbItemName: '', active: true,
             order: order, addedAt: iso(), addedBy: who };
  }
  function newId(name) {
    let id = 's_' + keyOf(name);
    if (id === 's_') id = 's_x';
    // A merged-away service leaves its id behind (null on the server).
    while (list.services[id] || takenIds[id]) id = 's_' + keyOf(name) + '_' + Math.random().toString(36).slice(2, 6);
    takenIds[id] = true;
    return id;
  }
  const takenIds = {};
  const nextOrder = () => Object.values(list.services).reduce((m, v) => Math.max(m, v.order || 0), 0) + 1;

  // ------------------------------------------------------------ writing it

  // Applied here the way the database merges (maps key by key, lists whole,
  // null = gone), so the screen shows it at once; sent without waiting.
  function applyLocal(patch) {
    const merge = (into, from) => Object.keys(from).forEach(k => {
      const v = from[k];
      if (v === null) delete into[k];
      else if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k], v);
      else into[k] = JSON.parse(JSON.stringify(v));
    });
    merge(list, patch);
  }
  function write(patch, what) {
    patch = Object.assign({}, patch, { updatedAt: iso() });
    if (list) { applyLocal({ groups: patch.groups || {}, services: patch.services || {} }); reindex(); }
    if (!window.YDDb) return;
    Promise.resolve(window.YDDb.put('settings', DOC, patch)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved to the services list — not allowed');
      else console.warn('[services] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }
  const putService = (id, fields, what) => write({ services: { [id]: fields } }, what);

  // A service typed in on a job, contact, customer or property joins the list
  // (Jonah, 12 Oct: "the service i add then adds the list and is there
  // permanently"), under the kind of work it sounds like. Nothing happens for
  // a name already on it -- hidden ones and old spellings included.
  function remember(name) {
    name = s(name).slice(0, 60);
    if (!name || !list || known(name) || !mayAdd()) return;
    // An admin may only add to a list that is already on the server.
    if (!owner() && !onServer) return;
    putService(newId(name), blank(name, guessGroup(name), nextOrder()), 'adding ' + name);
    changed(true);
  }
  window.rememberService = remember;

  // ------------------------------------------------------------ the pickers

  // The Job tab's list, by kind of work; Contacts and Customers copy theirs
  // from it (prospects.js fillTagOptions, customers.js tagOptions), and the
  // subcontractors' form asks names().
  function fillPicker() {
    const sel = el('serviceTypeSelect');
    if (!sel || !list) return;
    const groups = groupsSorted(true).map(g => {
      const svs = servicesIn(g.id);
      return svs.length ? '<optgroup label="' + esc(g.name) + '">' +
        svs.map(v => '<option value="' + esc(v.name) + '">' + esc(v.name) + '</option>').join('') + '</optgroup>' : '';
    }).join('');
    sel.innerHTML = '<option value="">+ Add service type…</option>' + groups + '<option value="__custom">Custom…</option>';
    sel.value = '';
  }
  // Something about the list changed: pickers, and the window if it is up
  // (unless an editor there is being typed in -- its own buttons redraw).
  function changed(fromHere) {
    fillPicker();
    document.dispatchEvent(new CustomEvent('yd-services'));
    if (isOpen() && (fromHere || !editing)) render();
  }

  // ------------------------------------------------------------ who uses what

  // Every service name on a record, exactly as written, with the records:
  // jobs on this device, contacts, customers and subcontractors' properties.
  // The owner's device holds all of them. ("fire pit" and "Fire pit" are
  // kept apart here, so the odd capitals show up as an old name to change.)
  function usage() {
    const out = {};
    const add = (n, kind, ref) => {
      n = s(n);
      if (!keyOf(n)) return;
      const u = out[n] || (out[n] = { name: n, jobs: {}, contacts: {}, customers: {}, props: {} });
      u[kind][ref] = true;
    };
    const jobs = typeof loadAllJobs === 'function' ? loadAllJobs() : [];
    jobs.forEach(j => (Array.isArray(j.serviceTypes) ? j.serviceTypes : []).forEach(n => add(n, 'jobs', j._id)));
    const people = window.YDProspects ? window.YDProspects.all() || {} : {};
    Object.entries(people).forEach(([id, p]) => p && (Array.isArray(p.services) ? p.services : []).forEach(n => add(n, 'contacts', id)));
    const custs = window.YDCustomers && window.YDCustomers.all ? window.YDCustomers.all() || {} : {};
    Object.entries(custs).forEach(([id, c]) => c && (Array.isArray(c.tags) ? c.tags : []).forEach(n => add(n, 'customers', id)));
    const sd = window.YDSubs && window.YDSubs.data ? window.YDSubs.data() || {} : {};
    Object.entries(sd.subs || {}).forEach(([sid, sb]) => sb && Object.entries(sb.props || {}).forEach(([pid, p]) =>
      p && (Array.isArray(p.services) ? p.services : []).forEach(n => add(n, 'props', sid + '|' + pid))));
    return out;
  }
  const KIND_WORDS = { jobs: ['job', 'jobs'], contacts: ['contact', 'contacts'], customers: ['customer', 'customers'],
                       props: ['subcontractor property', 'subcontractor properties'] };
  // Several usage entries (a name and its old spellings) as one count.
  function tally(entries) {
    const t = { jobs: {}, contacts: {}, customers: {}, props: {} };
    entries.filter(Boolean).forEach(u => Object.keys(t).forEach(k => Object.assign(t[k], u[k])));
    const n = {};
    Object.keys(t).forEach(k => { n[k] = Object.keys(t[k]).length; });
    n.total = n.jobs + n.contacts + n.customers + n.props;
    n.text = Object.keys(KIND_WORDS).filter(k => n[k]).map(k => n[k] + ' ' + KIND_WORDS[k][n[k] === 1 ? 0 : 1]).join(', ');
    return n;
  }
  const namesOf = v => [v.name].concat(v.aliases || []);
  // The usage of any of these names, however capitalised.
  const entriesFor = (u, names) => {
    const keys = {};
    names.forEach(n => { keys[keyOf(n)] = true; });
    return Object.values(u).filter(e => keys[keyOf(e.name)]);
  };
  const useOf = (u, v) => tally(entriesFor(u, namesOf(v)));

  // The records that say any of `fromNames` changed to say `to` instead --
  // only ever on Jonah's tap, after he has seen the count. Through the app's
  // own paths: a job by patchJobAnywhere (its copy here, the cloud, the
  // crew's copies), the rest straight to their records. Returns the counts.
  function rewrite(fromNames, to) {
    if (!owner()) return tally([]);
    const keys = {};
    fromNames.forEach(n => { if (keyOf(n) !== keyOf(to) || s(n) !== s(to)) keys[keyOf(n)] = true; });
    const fix = arr => {
      let hit = false;
      const out = [];
      (Array.isArray(arr) ? arr : []).forEach(n => {
        let m = n;
        if (keys[keyOf(n)] && s(n) !== to) { m = to; hit = true; }
        if (out.indexOf(m) === -1) out.push(m); else hit = true;
      });
      return hit ? out : null;
    };
    const done = { jobs: {}, contacts: {}, customers: {}, props: {} };
    const jobs = typeof loadAllJobs === 'function' ? loadAllJobs() : [];
    jobs.forEach(j => {
      const next = fix(j.serviceTypes);
      if (!next) return;
      // The job open in the form, with typing in it: its list there too, or
      // the next save from the form would put the old name back.
      if (typeof currentJobId !== 'undefined' && j._id === currentJobId && typeof serviceTypes !== 'undefined') {
        const mine = fix(serviceTypes);
        if (mine) { serviceTypes.splice(0, serviceTypes.length, ...mine); if (typeof renderServiceTypes === 'function') renderServiceTypes(); }
      }
      if (typeof patchJobAnywhere === 'function' && patchJobAnywhere(j._id, { serviceTypes: next }) !== false) done.jobs[j._id] = true;
    });
    const writes = [];
    const people = window.YDProspects ? window.YDProspects.all() || {} : {};
    Object.entries(people).forEach(([id, p]) => {
      const next = p && fix(p.services);
      if (!next) return;
      p.services = next;
      writes.push(['prospects', id, { services: next }]);
      done.contacts[id] = true;
    });
    const custs = window.YDCustomers && window.YDCustomers.all ? window.YDCustomers.all() || {} : {};
    Object.entries(custs).forEach(([id, c]) => {
      const next = c && fix(c.tags);
      if (!next) return;
      c.tags = next;
      writes.push(['customers', id, { tags: next, updatedAt: iso() }]);
      done.customers[id] = true;
    });
    const sd = window.YDSubs && window.YDSubs.data ? window.YDSubs.data() || {} : {};
    const subPatch = {};
    Object.entries(sd.subs || {}).forEach(([sid, sb]) => sb && Object.entries(sb.props || {}).forEach(([pid, p]) => {
      const next = p && fix(p.services);
      if (!next) return;
      ((subPatch[sid] = subPatch[sid] || { props: {} }).props)[pid] = { services: next };
      done.props[sid + '|' + pid] = true;
    }));
    if (Object.keys(subPatch).length) writes.push(['settings', 'subcontractors', { subs: subPatch }]);
    if (writes.length && window.YDDb) {
      Promise.resolve(window.YDDb.putMany(writes)).catch(e => {
        if (e && e.code === 'permission-denied') showToast('Not all changed — not allowed');
        else console.warn('[services] records not yet on the server:', (e && e.code) || e);
      });
    }
    ['yd-prospects'].forEach(ev => document.dispatchEvent(new CustomEvent(ev)));
    return tally([done]);
  }
  // Asked with the count, then done. True when changed.
  async function offerRewrite(fromNames, to, title) {
    // Written exactly as `to` already: nothing to change on those.
    const hits = entriesFor(usage(), fromNames).filter(e => e.name !== to);
    const n = tally(hits);
    if (!n.total) return false;
    const yes = await ydConfirm('Change ' + n.text + ' from “' + hits.map(e => e.name).join('”, “') +
      '” to “' + to + '”? Left as they are, they keep the old words (listed under “Old names still on records”).',
      { title: title || 'Change the records too?', ok: 'Change ' + plural(n.total, 'record'), cancel: 'Leave them' });
    if (!yes) return false;
    const done = rewrite(fromNames, to);
    showToast(done.total ? 'Changed ' + done.text : 'Nothing to change');
    render();
    return true;
  }

  // ------------------------------------------------------------ the window

  const isOpen = () => { const m = el('svcModal'); return !!(m && m.classList.contains('active')); };
  function openWindow() {
    let m = el('svcModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'svcModal';
      m.onclick = ev => { if (ev.target === m) closeServices(); };
      m.innerHTML = '<div class="modal svc-modal"><div class="modal-head"><h2 id="svcTitle">Services</h2>' +
        '<button class="modal-close" onclick="closeServices()" aria-label="Close">&times;</button></div>' +
        '<div class="modal-body" id="svcBody"></div></div>';
      document.body.appendChild(m);
    }
    m.classList.add('active');
    render();
    // The newest copy (another device may have changed it), then drawn again.
    if (!editing) load(true);
  }
  // ⋯ → Services, and "✎ Edit the list" beside the service pickers: the
  // owner's screen; everyone else gets What we do.
  window.openServices = function () {
    mode = owner() ? 'manage' : 'read';
    focusId = null; search = '';
    openWindow();
  };
  window.openServicesEditor = window.openServices;
  // What we do, open at one service (a tap on a service on the crew's job page).
  window.openWhatWeDo = function (name) {
    mode = 'read';
    search = '';
    focusId = name && list ? index[keyOf(name)] || null : null;
    if (focusId && list.services[focusId]) openGroups[groupOf(list.services[focusId])] = true;
    openWindow();
    if (focusId) setTimeout(() => { const c = el('svcRead_' + safeId(focusId)); if (c) c.scrollIntoView({ block: 'center' }); }, 60);
  };
  window.closeServices = function () {
    const m = el('svcModal');
    if (m) m.classList.remove('active');
    editing = null; draft = null; focusId = null;
  };
  window.svcSearch = function (v) {
    search = String(v || '');
    const body = el('svcResults');
    if (body) body.innerHTML = mode === 'manage' ? manageGroupsHtml() : readGroupsHtml();
  };
  window.svcFold = function (d) { openGroups[d.dataset.g] = d.open; };
  window.svcMode = function (m) { mode = m === 'read' ? 'read' : owner() ? 'manage' : 'read'; editing = null; draft = null; render(); };

  function render() {
    const body = el('svcBody');
    if (!body) return;
    const title = el('svcTitle');
    if (title) title.textContent = mode === 'manage' ? '🧰 Services' : '🧰 What we do';
    if (!list) {
      body.innerHTML = '<p class="empty-msg">' + (signedIn() ? 'The services list has not come through yet — check the signal and open this again.'
        : 'Sign in to see the services list.') + '</p>';
      return;
    }
    body.innerHTML = mode === 'manage' ? manageHtml() : readHtml();
  }
  const matches = v => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = [v.name, v.summary, v.details].concat(v.aliases || []).join(' ').toLowerCase();
    return words.every(w => text.indexOf(w) !== -1);
  };
  const searchBox = ph => '<input class="svc-search" type="search" placeholder="' + ph + '" value="' + esc(search) +
    '" oninput="svcSearch(this.value)" autocomplete="off">';
  // A kind of work as a fold: shut on a phone unless opened (or searching),
  // open on a laptop.
  function foldHtml(g, inner, count, extra) {
    const open = search ? true : g.id in openGroups ? openGroups[g.id] : wide();
    return '<details class="svc-group" data-g="' + esc(g.id) + '"' + (open ? ' open' : '') + ' ontoggle="svcFold(this)">' +
      '<summary><span class="svc-group-name">' + esc(g.name) + '</span><span class="svc-count">' + count + '</span>' +
      (extra || '') + '</summary><div class="svc-group-body">' + inner + '</div></details>';
  }

  // ---- What we do (everyone): the summary to say, then the details.
  function readHtml() {
    return '<p class="hint">What each service is, in words to use with a homeowner. ' +
      'The first line is the short version; under it, what it includes.</p>' +
      (owner() ? '<div class="svc-acts"><button class="btn btn-sm" onclick="svcMode(\'manage\')">✎ Back to changing the list</button></div>' : '') +
      searchBox('Search the services') + '<div id="svcResults">' + readGroupsHtml() + '</div>';
  }
  function readGroupsHtml() {
    const out = groupsSorted().map(g => {
      const svs = servicesIn(g.id).filter(matches);
      if (!svs.length) return '';
      return foldHtml(g, svs.map(v => '<div class="svc-read' + (v.id === focusId ? ' svc-focus' : '') + '" id="svcRead_' + safeId(v.id) + '">' +
        '<div class="svc-name">' + esc(v.name) + '</div>' +
        (s(v.summary) ? '<div class="svc-summary">' + esc(v.summary) + '</div>' : '') +
        (s(v.details) ? '<div class="svc-details">' + esc(v.details) + '</div>' : '') +
        (!s(v.summary) && !s(v.details) ? '<div class="muted svc-none">No description yet — ask Jonah.</div>' : '') +
      '</div>').join(''), svs.length);
    }).join('');
    return out || '<p class="empty-msg">' + (search ? 'Nothing matches “' + esc(search) + '”.' : 'No services yet.') + '</p>';
  }

  // ---- The owner's screen.
  function manageHtml() {
    const all = Object.values(list.services).filter(v => v.active !== false);
    const noSummary = all.filter(v => !s(v.summary)).length;
    return '<p class="hint">One list for jobs, contacts, customers and subcontractors. The <b>summary</b> is the one line the crew ' +
        'say to a homeowner; the <b>details</b> are what it includes. The crew read them under 🧰 What we do.</p>' +
      '<div class="svc-stats"><span>' + plural(all.length, 'service') + '</span>' +
        (noSummary ? '<span class="svc-warn">' + noSummary + ' still without a summary</span>' : '<span class="svc-ok">✓ every one has a summary</span>') + '</div>' +
      '<div class="svc-acts">' +
        '<button class="btn btn-sm btn-filled" onclick="svcAdd()">+ Add a service</button>' +
        '<button class="btn btn-sm" onclick="svcMode(\'read\')">👀 What the crew see</button>' +
      '</div>' +
      searchBox('Search the services') + '<div id="svcResults">' + manageGroupsHtml() + '</div>' +
      offListHtml() + groupsEditorHtml() + otherListsHtml();
  }
  function manageGroupsHtml() {
    const u = usage();
    const groups = groupsSorted(true).map(g => {
      const svs = servicesIn(g.id).filter(matches);
      if (!svs.length && (search || g.active === false)) return '';
      const missing = svs.filter(v => !s(v.summary)).length;
      return foldHtml(g, (svs.length ? svs.map((v, i) => cardHtml(v, u, i, svs.length)).join('')
        : '<p class="empty-msg">None yet.</p>'), svs.length,
        missing ? '<span class="svc-warn svc-warn-sm">' + missing + ' without a summary</span>' : '');
    }).join('');
    const hidden = Object.entries(list.services).map(([id, v]) => Object.assign({ id: id }, v))
      .filter(v => v.active === false && matches(v)).sort((a, b) => a.name.localeCompare(b.name));
    return (groups || '<p class="empty-msg">Nothing matches “' + esc(search) + '”.</p>') +
      (hidden.length ? foldHtml({ id: '_hidden', name: 'Hidden — not offered on jobs or contacts' },
        hidden.map(v => cardHtml(v, u, 0, 1)).join(''), hidden.length) : '');
  }
  function cardHtml(v, u, i, n) {
    if (editing === v.id) return editorHtml(v);
    const id = safeId(v.id), used = useOf(u, v);
    const btn = (label, call, cls) => '<button class="btn btn-sm' + (cls ? ' ' + cls : '') + '" onclick="' + call + '">' + label + '</button>';
    return '<div class="svc-card' + (v.active === false ? ' svc-hidden' : '') + '" id="svcCard_' + id + '">' +
      '<div class="svc-card-h"><span class="svc-name">' + esc(v.name) + '</span>' +
        '<span class="muted svc-used">' + (used.total ? 'on ' + esc(used.text) : 'not on any record yet') + '</span></div>' +
      (s(v.summary) ? '<div class="svc-summary">' + esc(v.summary) + '</div>' : '<div class="svc-summary muted">No summary yet</div>') +
      (s(v.details) ? '<div class="svc-details">' + esc(v.details) + '</div>' : '') +
      ((v.aliases || []).length ? '<div class="muted svc-alias">Also written: ' + esc(v.aliases.join(', ')) + '</div>' : '') +
      (v.qbItemName ? '<div class="muted svc-alias">📗 QuickBooks: ' + esc(v.qbItemName) + '</div>' : '') +
      '<div class="svc-acts">' +
        btn('✎ Edit', 'svcEdit(\'' + id + '\')') +
        (v.active === false ? btn('Show again', 'svcShow(\'' + id + '\', true)')
          : btn('Merge into…', 'svcMerge(\'' + id + '\')') + btn('Hide', 'svcShow(\'' + id + '\', false)') +
            (i > 0 ? btn('▲', 'svcMove(\'' + id + '\', -1)', 'svc-arrow') : '') +
            (i < n - 1 ? btn('▼', 'svcMove(\'' + id + '\', 1)', 'svc-arrow') : '')) +
      '</div></div>';
  }

  // ---- One service being changed.
  function editorHtml(v) {
    const d = draft;
    const id = safeId(v.id);
    const opts = groupsSorted(true).map(g => '<option value="' + esc(g.id) + '"' + (g.id === d.group ? ' selected' : '') + '>' +
      esc(g.name) + '</option>').join('');
    return '<div class="svc-card svc-editing" id="svcCard_' + id + '">' +
      '<div class="field"><span class="label">Name</span><input id="svcEdName" value="' + esc(d.name) + '" maxlength="60" oninput="svcDraft(\'name\', this.value)"></div>' +
      '<div class="field"><span class="label">Kind of work</span><select id="svcEdGroup" onchange="svcDraft(\'group\', this.value)">' + opts + '</select></div>' +
      '<div class="field"><span class="label">Summary — one line the crew can say</span>' +
        '<input id="svcEdSummary" value="' + esc(d.summary) + '" maxlength="200" placeholder="One line the crew can say" oninput="svcDraft(\'summary\', this.value)"></div>' +
      '<div class="field"><span class="label">Details — what it includes, how we do it</span>' +
        '<textarea id="svcEdDetails" rows="5" maxlength="4000" placeholder="A few sentences: what is included, how we do it" oninput="svcDraft(\'details\', this.value)">' +
        esc(d.details) + '</textarea></div>' +
      qbFieldHtml(d) +
      '<div class="field"><span class="label">Other spellings (commas between) — typed anywhere, they become this one</span>' +
        '<input id="svcEdAliases" value="' + esc(d.aliases) + '" oninput="svcDraft(\'aliases\', this.value)"></div>' +
      '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="svcSave(\'' + id + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="svcCancel()">Cancel</button></div>' +
    '</div>';
  }
  // The QuickBooks product this service is sold as, and its wording: Jonah's
  // own text, copied in on his tap.
  function qbFieldHtml(d) {
    const head = '<div class="field svc-qb"><span class="label">📗 QuickBooks product</span>';
    if (!can('billing', 'change')) {
      return d.qbItemName ? head + '<div>' + esc(d.qbItemName) + '</div></div>' : '';
    }
    if (!qb) {
      return head + (d.qbItemName ? '<div>' + esc(d.qbItemName) + '</div>' : '') +
        (qbErr ? '<div class="hint">' + esc(qbErr) + '</div>' : '') +
        '<button class="btn btn-sm" onclick="svcLoadQb()"' + (qbAsking ? ' disabled' : '') + '>' +
          (qbAsking ? 'Asking QuickBooks…' : 'Pick it from QuickBooks') + '</button></div>';
    }
    const same = qb.filter(p => keyOf(p.name) === keyOf(d.name));
    const rest = qb.filter(p => same.indexOf(p) === -1).sort((a, b) => a.name.localeCompare(b.name));
    const opt = p => '<option value="' + esc(p.name) + '"' + (p.name === d.qbItemName ? ' selected' : '') + '>' + esc(p.name) +
      (same.indexOf(p) !== -1 ? ' (same name)' : '') + '</option>';
    const cur = qb.find(p => p.name === d.qbItemName);
    const missing = d.qbItemName && !cur ? '<option value="' + esc(d.qbItemName) + '" selected>' + esc(d.qbItemName) + ' (not in QuickBooks now)</option>' : '';
    return head + '<select id="svcEdQb" onchange="svcDraft(\'qbItemName\', this.value)">' +
        '<option value="">— not linked —</option>' + missing + same.map(opt).join('') + rest.map(opt).join('') + '</select>' +
      (cur ? (cur.text ? '<div class="svc-qbtext"><span class="muted">QuickBooks says:</span> ' + esc(cur.text.length > 300 ? cur.text.slice(0, 300) + '…' : cur.text) + '</div>' +
          '<button class="btn btn-sm" onclick="svcUseQb()">Use the QuickBooks wording</button>'
        : '<div class="hint">That product has no description in QuickBooks.</div>') : '') +
    '</div>';
  }
  window.svcLoadQb = function () {
    if (qb || qbAsking || !window.YDClaude) return;
    qbAsking = true; qbErr = '';
    rerenderEditor();
    Promise.resolve(window.YDClaude.post('/qb/items', {})).then(r => {
      qb = ((r && r.items) || []).filter(i => i && i.name && i.type !== 'Category')
        .map(i => ({ name: s(i.name), text: s(i.description) }));
    }).catch(e => {
      qbErr = 'Could not get the products from QuickBooks: ' + ((e && e.message) || 'try again');
    }).finally(() => { qbAsking = false; rerenderEditor(); });
  };
  window.svcUseQb = async function () {
    if (!draft || !qb) return;
    const p = qb.find(x => x.name === draft.qbItemName);
    if (!p || !p.text) return;
    if (s(draft.details) && s(draft.details) !== p.text &&
        !(await ydConfirm('The details written here are replaced by the QuickBooks product’s wording.', { title: 'Use the QuickBooks wording?', ok: 'Use it' }))) return;
    draft.details = p.text;
    rerenderEditor();
  };
  function rerenderEditor() {
    if (!editing || !list.services[editing]) { render(); return; }
    const card = el('svcCard_' + safeId(editing));
    if (!card) { render(); return; }
    card.outerHTML = editorHtml(Object.assign({ id: editing }, list.services[editing]));
  }
  window.svcDraft = function (k, v) { if (draft) draft[k] = v; };
  window.svcEdit = function (id) {
    const v = list && list.services[id];
    if (!v || !owner()) return;
    editing = id;
    draft = { name: v.name, group: groupOf(v), summary: v.summary || '', details: v.details || '',
              aliases: (v.aliases || []).join(', '), qbItemName: v.qbItemName || '' };
    openGroups[groupOf(v)] = true;
    render();
    const c = el('svcCard_' + safeId(id));
    if (c) { c.scrollIntoView({ block: 'nearest' }); const f = el('svcEdSummary'); if (f) f.focus({ preventScroll: true }); }
  };
  window.svcCancel = function () { editing = null; draft = null; render(); };
  window.svcSave = async function (id) {
    const v = list && list.services[id];
    if (!v || !draft || !owner()) return;
    const name = s(draft.name).replace(/\s+/g, ' ').slice(0, 60);
    if (!name) { showToast('Give it a name'); return; }
    const other = index[keyOf(name)];
    if (other && other !== id) {
      showToast('“' + list.services[other].name + '” is already on the list — use Merge into instead');
      return;
    }
    // Old spellings: each once, never this name, never another service's.
    const aliases = [], taken = [];
    String(draft.aliases || '').split(',').map(a => s(a).slice(0, 60)).forEach(a => {
      const k = keyOf(a);
      if (!k || k === keyOf(name) || aliases.some(x => keyOf(x) === k)) return;
      if (index[k] && index[k] !== id) { taken.push(a); return; }
      aliases.push(a);
    });
    // A rename keeps the old name as an old spelling, so records and typing
    // that say it still land here.
    const renamed = v.name !== name;
    if (renamed && keyOf(v.name) !== keyOf(name) && !aliases.some(x => keyOf(x) === keyOf(v.name))) aliases.push(v.name);
    const fields = { name: name, summary: s(draft.summary).slice(0, 200), details: String(draft.details || '').trim().slice(0, 4000),
                     aliases: aliases, qbItemName: s(draft.qbItemName), updatedAt: iso() };
    if (draft.group !== groupOf(v)) {
      fields.group = draft.group;
      fields.order = servicesIn(draft.group).reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
      openGroups[draft.group] = true;
    }
    const was = v.name;
    putService(id, fields, 'saving ' + name);
    editing = null; draft = null;
    changed(true);
    if (taken.length) showToast(taken.join(', ') + ' — already another service’s name or spelling, left off');
    else showToast('Saved');
    // The new name too: records with it in other capitals ("fire pit") come along.
    if (renamed) await offerRewrite([was, name], name, 'Renamed — change the records too?');
  };
  window.svcShow = function (id, on) {
    const v = list && list.services[id];
    if (!v || !owner()) return;
    putService(id, { active: !!on, updatedAt: iso() }, on ? 'showing ' + v.name : 'hiding ' + v.name);
    changed(true);
    showUndo(on ? '“' + v.name + '” is back on the pickers' : '“' + v.name + '” hidden — records keep it',
      () => { putService(id, { active: !on, updatedAt: iso() }, 'undo'); changed(true); });
  };
  window.svcMove = function (id, dir) {
    const v = list && list.services[id];
    if (!v || !owner()) return;
    const svs = servicesIn(groupOf(v));
    const i = svs.findIndex(x => x.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= svs.length) return;
    // Number the whole kind again, so equal or missing orders move too.
    const order = svs.map(x => x.id);
    order.splice(j, 0, order.splice(i, 1)[0]);
    const patch = {};
    order.forEach((sid, n) => { if ((list.services[sid].order || 0) !== n + 1) patch[sid] = { order: n + 1 }; });
    write({ services: patch }, 'reordering');
    changed(true);
  };
  window.svcAdd = async function () {
    if (!owner() || !list) return;
    const typed = await ydPrompt('', '', { title: 'Add a service', placeholder: 'e.g. Gutter cleaning', ok: 'Add', required: true });
    const name = s(typed).replace(/\s+/g, ' ').slice(0, 60);
    if (!name) return;
    if (known(name)) { showToast('“' + canon(name) + '” is already on the list'); return; }
    const id = newId(name);
    putService(id, blank(name, guessGroup(name), nextOrder()), 'adding ' + name);
    search = '';
    window.svcEdit(id);
  };

  // Merge: pick the one to keep. This one's name and old spellings become
  // that one's old spellings; its words fill any of that one's left empty;
  // then the records, on his tap with the count.
  function pickService(text, title, notId) {
    const choices = [];
    groupsSorted(true).forEach(g => servicesIn(g.id).forEach(v => {
      if (v.id !== notId) choices.push({ id: v.id, label: v.name, hint: g.name });
    }));
    return ydChoose(text, choices, { title: title });
  }
  window.svcMerge = async function (id) {
    const v = list && list.services[id];
    if (!v || !owner()) return;
    const pick = await pickService('The one to keep. “' + v.name + '” becomes another way of writing it.', 'Merge “' + v.name + '” into…', id);
    const to = pick && list.services[pick.id];
    if (!to) return;
    const aliases = (to.aliases || []).slice();
    namesOf(v).forEach(n => { if (keyOf(n) !== keyOf(to.name) && !aliases.some(a => keyOf(a) === keyOf(n))) aliases.push(n); });
    const fields = { aliases: aliases, updatedAt: iso() };
    ['summary', 'details', 'qbItemName'].forEach(k => { if (!s(to[k]) && s(v[k])) fields[k] = v[k]; });
    write({ services: { [pick.id]: fields, [id]: null } }, 'merging ' + v.name);
    if (editing === id) { editing = null; draft = null; }
    changed(true);
    showToast('“' + v.name + '” merged into “' + to.name + '”');
    await offerRewrite(namesOf(v), to.name, 'Merged — change the records too?');
  };

  // ---- Names on records that are not the list's own: ones it has never had
  // (add them, or merge into one it has), and old spellings still written.
  function offListHtml() {
    const u = usage();
    const unknown = [], old = [];
    Object.values(u).forEach(e => {
      const id = index[keyOf(e.name)];
      if (!id) { unknown.push(e); return; }
      const v = list.services[id];
      if (e.name !== v.name) old.push({ u: e, to: v });
    });
    if (!unknown.length && !old.length) return '';
    let h = '';
    if (unknown.length) {
      h += foldHtml({ id: '_unknown', name: 'On records but not on the list' }, '<p class="hint">Typed on a job, contact, customer or property ' +
        'before this list, or by someone who cannot add to it.</p>' +
        unknown.sort((a, b) => a.name.localeCompare(b.name)).map(x => '<div class="svc-card"><div class="svc-card-h"><span class="svc-name">' + esc(x.name) +
          '</span><span class="muted svc-used">on ' + esc(tally([x]).text) + '</span></div><div class="svc-acts">' +
          '<button class="btn btn-sm" data-n="' + esc(x.name) + '" onclick="svcAddName(this.dataset.n)">+ Add to the list</button>' +
          '<button class="btn btn-sm" data-n="' + esc(x.name) + '" onclick="svcMergeName(this.dataset.n)">Merge into…</button></div></div>').join(''),
        unknown.length);
    }
    if (old.length) {
      h += foldHtml({ id: '_old', name: 'Old names still on records' },
        old.sort((a, b) => a.u.name.localeCompare(b.u.name)).map(x => '<div class="svc-card"><div class="svc-card-h"><span class="svc-name">' +
          esc(x.u.name) + ' → ' + esc(x.to.name) + '</span><span class="muted svc-used">on ' + esc(tally([x.u]).text) + '</span></div>' +
          '<div class="svc-acts"><button class="btn btn-sm" data-n="' + esc(x.u.name) + '" onclick="svcFixName(this.dataset.n)">Change them to “' +
          esc(x.to.name) + '”</button></div></div>').join(''), old.length);
    }
    return h;
  }
  window.svcAddName = function (name) {
    if (!owner() || !list || known(name)) return;
    putService(newId(name), blank(s(name).slice(0, 60), guessGroup(name), nextOrder()), 'adding ' + name);
    changed(true);
    showToast('“' + name + '” added under ' + list.groups[guessGroup(name)].name + ' — move it with ✎ Edit');
  };
  window.svcMergeName = async function (name) {
    if (!owner() || !list) return;
    const pick = await pickService('“' + name + '” becomes another way of writing the one you pick.', 'Merge “' + name + '” into…', null);
    const to = pick && list.services[pick.id];
    if (!to) return;
    putService(pick.id, { aliases: (to.aliases || []).concat([s(name)]), updatedAt: iso() }, 'merging ' + name);
    changed(true);
    await offerRewrite([name], to.name, 'Merged — change the records too?');
  };
  window.svcFixName = async function (name) {
    const id = index[keyOf(name)];
    if (!owner() || !id) return;
    await offerRewrite([name], list.services[id].name, 'Change the records?');
  };

  // ---- The kinds of work themselves: rename, reorder, add, hide when empty.
  function groupsEditorHtml() {
    const gs = groupsSorted(true);
    const rows = gs.map((g, i) => {
      const n = servicesIn(g.id).length + servicesIn(g.id, true).length;
      const id = safeId(g.id);
      return '<div class="svc-grow' + (g.active === false ? ' svc-hidden' : '') + '">' +
        '<input value="' + esc(g.name) + '" maxlength="40" aria-label="Kind of work" onchange="svcGroupName(\'' + id + '\', this.value)">' +
        '<span class="muted">' + plural(n, 'service') + '</span>' +
        '<div class="svc-acts">' +
          (i > 0 ? '<button class="btn btn-sm svc-arrow" onclick="svcGroupMove(\'' + id + '\', -1)">▲</button>' : '') +
          (i < gs.length - 1 ? '<button class="btn btn-sm svc-arrow" onclick="svcGroupMove(\'' + id + '\', 1)">▼</button>' : '') +
          (g.active === false ? '<button class="btn btn-sm" onclick="svcGroupShow(\'' + id + '\', true)">Show again</button>'
            : !n ? '<button class="btn btn-sm" onclick="svcGroupShow(\'' + id + '\', false)">Hide</button>' : '') +
        '</div></div>';
    }).join('');
    return foldHtml({ id: '_groups', name: 'Kinds of work' }, '<p class="hint">The headings the services sit under. ' +
      'One with services in it cannot be hidden — move them first.</p>' + rows +
      '<div class="svc-acts"><button class="btn btn-sm" onclick="svcGroupAdd()">+ Add a kind of work</button></div>', gs.length);
  }
  window.svcGroupName = function (id, v) {
    const g = list && list.groups[id];
    const name = s(v).replace(/\s+/g, ' ').slice(0, 40);
    if (!g || !owner()) return;
    if (!name) { render(); return; }
    write({ groups: { [id]: { name: name } } }, 'renaming a kind of work');
    changed(true);
  };
  window.svcGroupMove = function (id, dir) {
    if (!owner()) return;
    const gs = groupsSorted(true).map(g => g.id);
    const i = gs.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= gs.length) return;
    gs.splice(j, 0, gs.splice(i, 1)[0]);
    const patch = {};
    gs.forEach((gid, n) => { patch[gid] = { order: n }; });
    write({ groups: patch }, 'reordering kinds of work');
    changed(true);
  };
  window.svcGroupShow = function (id, on) {
    const g = list && list.groups[id];
    if (!g || !owner()) return;
    if (!on && servicesIn(id).length + servicesIn(id, true).length) { showToast('Move its services to another kind first'); return; }
    write({ groups: { [id]: { active: !!on } } }, 'hiding a kind of work');
    changed(true);
  };
  window.svcGroupAdd = async function () {
    if (!owner() || !list) return;
    const name = s(await ydPrompt('', '', { title: 'Add a kind of work', placeholder: 'e.g. Irrigation', ok: 'Add', required: true })).slice(0, 40);
    if (!name) return;
    if (groupsSorted(true).some(g => keyOf(g.name) === keyOf(name))) { showToast('“' + name + '” is already there'); return; }
    let id = 'g_' + keyOf(name);
    while (list.groups[id]) id += '_';
    write({ groups: { [id]: { name: name, order: groupsSorted(true).length, active: true } } }, 'adding a kind of work');
    openGroups[id] = true; openGroups._groups = true;
    changed(true);
  };

  // ---- Your other lists: his own equipment types, supply tags and material
  // kinds, each with how much uses it. Merge = everything of it moves onto
  // another; rename = the same onto a new name. Always shown the count first.
  const OTHER = {
    equipment: {
      title: 'Equipment types', unit: ['machine', 'machines'],
      ok: () => !!window.YDEquipment && can('equipment', 'change'),
      rows: () => window.YDEquipment.types().filter(t => !t.builtIn),
      targets: () => window.YDEquipment.types().map(t => ({ id: t.id, label: t.name })),
      move: (was, to) => window.YDEquipment.retype(was, to),
      // A name typed that is already a type (any capitals, or "Vehicles") is that type.
      named: typed => {
        const k = s(typed).toLowerCase();
        const hit = window.YDEquipment.types().find(t => String(t.id).toLowerCase() === k || String(t.name).toLowerCase() === k);
        return hit ? hit.id : typed;
      },
      none: 'None of your own yet — add one on a machine (Equipment → ✎ → Type).',
    },
    tags: {
      title: 'Supply tags', unit: ['item', 'items'], drop: true,
      ok: () => !!(window.YDSupplies && window.YDSupplies.tagList) && can('supplies', 'change'),
      rows: () => window.YDSupplies.tagList().map(t => ({ id: t.name, name: t.name, count: t.count })),
      targets: () => window.YDSupplies.tagTargets().map(t => ({ id: t.id, label: t.name })),
      move: (was, to) => window.YDSupplies.moveTag(was, to),
      named: typed => window.YDSupplies.tagFor(typed),
      none: 'None of your own yet — tag items on Supplies.',
    },
    kinds: {
      title: 'Material kinds', unit: ['item', 'items'],
      ok: () => !!(window.YDPricing && window.YDPricing.mergeKind) && owner(),
      rows: () => {
        const items = window.YDSupplies && window.YDSupplies.catalog ? Object.values(window.YDSupplies.catalog().items || {}) : [];
        const k = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        return window.YDPricing.customKinds().map(n => ({ id: n, name: n, count: items.filter(it => k(it.category) === k(n)).length }));
      },
      targets: () => window.YDPricing.allKinds().map(([id, name]) => ({ id: id, label: name })),
      move: (was, to) => window.YDPricing.mergeKind(was, to),
      named: typed => window.YDPricing.kindFor(typed),
      none: 'None of your own yet — add one in Pricing rules or on a Supplies item.',
    },
  };
  function otherListsHtml() {
    const parts = Object.keys(OTHER).filter(k => OTHER[k].ok()).map(k => {
      const L = OTHER[k];
      let rows = [];
      try { rows = L.rows(); } catch (e) { rows = []; }
      const inner = rows.length ? rows.map(r => '<div class="svc-card"><div class="svc-card-h"><span class="svc-name">' + esc(r.name) + '</span>' +
          '<span class="muted svc-used">' + plural(r.count, L.unit[0], L.unit[1]) + '</span></div><div class="svc-acts">' +
          '<button class="btn btn-sm" data-l="' + k + '" data-n="' + esc(r.id) + '" onclick="svcOther(this.dataset.l, this.dataset.n, \'rename\')">✎ Rename</button>' +
          '<button class="btn btn-sm" data-l="' + k + '" data-n="' + esc(r.id) + '" onclick="svcOther(this.dataset.l, this.dataset.n, \'merge\')">Merge into…</button>' +
          (L.drop ? '<button class="btn btn-sm" data-l="' + k + '" data-n="' + esc(r.id) + '" onclick="svcOther(this.dataset.l, this.dataset.n, \'drop\')">Take it off</button>' : '') +
        '</div></div>').join('') : '<p class="empty-msg">' + esc(L.none) + '</p>';
      return foldHtml({ id: '_o_' + k, name: L.title }, inner, rows.length);
    });
    if (!parts.length) return '';
    return '<h3 class="svc-h3">Your other lists</h3><p class="hint">Your own types, tags and kinds. Contacts’ tags are the services above. ' +
      'A type, tag or kind is only there while something carries it, so merging one moves everything it is on.</p>' + parts.join('');
  }
  window.svcOther = async function (which, name, how) {
    const L = OTHER[which];
    if (!L || !L.ok()) return;
    const row = (L.rows() || []).find(r => r.id === name);
    if (!row) return;
    const n = plural(row.count, L.unit[0], L.unit[1]);
    let to = null;
    if (how === 'merge') {
      const pick = await ydChoose('Every ' + L.unit[0] + ' that is “' + row.name + '” moves to the one you pick.',
        L.targets().filter(t => String(t.id).toLowerCase() !== String(name).toLowerCase()), { title: 'Merge “' + row.name + '” into…' });
      if (!pick) return;
      to = pick.id;
    } else if (how === 'rename') {
      const typed = s(await ydPrompt('', row.name, { title: 'Rename “' + row.name + '”', ok: 'Next', required: true }));
      if (!typed || typed === row.name) return;
      to = L.named ? L.named(typed) : typed;
      // Only the capitals changed: the name as typed, not the one it matched.
      if (String(to).toLowerCase() === String(name).toLowerCase()) to = typed;
      to = String(to).replace(/\s+/g, ' ').slice(0, 40);
    } else if (how === 'drop') {
      to = '';
    }
    if (to == null || to === name) return;
    const target = to === '' ? null : (L.targets().find(t => t.id === to) || { label: to });
    const ok = await ydConfirm(to === '' ? 'Take “' + row.name + '” off ' + n + '?' : 'Move ' + n + ' from “' + row.name + '” to “' + target.label + '”?',
      { title: L.title, ok: row.count ? (to === '' ? 'Take it off ' : 'Change ') + n : 'Go ahead' });
    if (!ok) return;
    const done = L.move(name, to);
    showToast(to === '' ? 'Taken off ' + plural(done || 0, L.unit[0], L.unit[1]) : 'Moved ' + plural(done || 0, L.unit[0], L.unit[1]));
    setTimeout(render, 50);
  };

  // ------------------------------------------------------------ start

  window.YDServices = {
    names: activeNames, canon: canon, known: known, remember: remember,
    list: () => list, ready: () => !!list,
    // The one line and the details for a name, for whoever shows a service.
    about: name => { const id = list && index[keyOf(name)]; return id ? list.services[id] : null; },
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    const item = el('menuServices');
    if (item) {
      item.hidden = !on;
      item.textContent = a.isOwner ? '🧰 Services' : '🧰 What we do';
    }
    if (k === authKey) return;
    authKey = k;
    list = null; index = {}; onServer = false; editing = null; draft = null; qb = null; qbErr = '';
    if (on) load(true);
    else window.closeServices();
  });
})();
