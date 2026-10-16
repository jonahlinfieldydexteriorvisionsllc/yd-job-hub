// People to contact -- a list that survives the off-season.
//
// Three things shape this file.
//
// It has to be quick to write into. The moment it gets used is standing in a
// driveway thinking "call them about a patio in March", and a form asking for
// eight fields then will simply not get used. Name is the only thing required.
//
// Everyone here gets tagged with the work they are being contacted about,
// because it is one list for the whole business, not a snow list. The tags come
// from the SAME dropdown the Job tab uses -- read out of the DOM rather than
// copied -- so the two cannot drift apart, and a service added there shows up
// here for free.
//
// And nothing is imported from anywhere. This list is typed in by hand on
// purpose; the snow accounts are a separate thing and stay separate.
//
// A prospect that says yes converts into a job or a snow account carrying what
// is already known, so nobody retypes a name and address. That is also why this
// is its own collection with a status rather than a free-text scratchpad -- it
// becomes the lead pipeline later without the data having to be moved.

(function () {
  'use strict';

  const STATUSES = {
    'to-contact': 'To contact',
    'contacted': 'Contacted',
    'quoted': 'Quoted',
    'won': 'Won',
    'no': 'Not interested',
  };
  const CLOSED = ['won', 'no'];

  let people = {};
  let tags = [];          // tags on the form as it is being filled in
  let editingId = null;   // set while an existing person is being edited
  let unsub = null;

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isClosed = p => CLOSED.indexOf(p.status) !== -1;

  // ------------------------------------------------------- when to contact
  //
  // "When" is free text on purpose: half of these are "call in September" and
  // the other half are "sometime next spring", and a date picker would force a
  // precision nobody has. The cost is that sorting the raw text puts "September
  // 2026" after "March 2027", which makes the list look broken.
  //
  // So the text is read for a year and a month -- written any way it comes out,
  // including a season word -- and the list is ordered by that. Anything
  // unreadable, or blank, sorts to the bottom rather than the top, where it
  // would bury the people actually coming due.

  const NO_DATE = 99999999;   // sorts last, and subtracts without NaN

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const SEASONS = { spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12 };
  // Whole words only. Looked for anywhere in the text, "maybe" read as May,
  // "decide" as December and "after the first snowfall" as autumn.
  const MONTH_WORD = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;
  const SEASON_WORD = /\b(spring|summer|fall|autumn|winter)\b/;

  function whenKey(text) {
    const s = (text || '').toLowerCase();
    if (!s.trim()) return NO_DATE;

    const year = (s.match(/\b(19|20)\d{2}\b/) || [])[0];
    if (!year) return NO_DATE;

    let month = 0;
    // 2027-04, 2027/4, 2027-04-15
    const iso = s.match(/\b(?:19|20)\d{2}[-\/](\d{1,2})\b/);
    // 4/2027, and a whole date written 4/15/2027 -- the month comes first.
    // Without the day allowed for, "9/15/2026" read as month 15 and sank to
    // the end of the year.
    const slash = s.match(/\b(\d{1,2})[-\/](?:\d{1,2}[-\/])?(?:19|20)\d{2}\b/);
    if (iso) month = +iso[1];
    else if (slash) month = +slash[1];
    else {
      const name = s.match(MONTH_WORD);
      const season = s.match(SEASON_WORD);
      if (name) month = MONTHS.indexOf(name[1].slice(0, 3)) + 1;
      else if (season) month = SEASONS[season[1]];
    }
    // A year with no month sorts to the end of that year, not the start, so
    // "2027" does not jump ahead of "March 2027".
    return +year * 100 + (month > 0 && month < 13 ? month : 13);
  }

  // ------------------------------------------------- next season's outreach
  //
  // Jonah (14 Oct 2026): "set up date to start reaching out to clients for
  // jobs for next season." One date, the owner's (settings/outreach
  // .startDate, YYYY-MM-DD). From that morning, everyone still open on this
  // list whose time to call has come -- or who has none, or one nobody can
  // read -- and who has not been reached since, is listed at the top under
  // "Time to reach out". The morning summary says so on the day and counts
  // what is left after that (functions/outreach.py, the same reading of the
  // list), and the day is on the calendar (calendar.js, from the same date).
  //
  // "Reached" is reachedAt: stamped by ✓ Reached out, by a meeting note, and
  // by setting them Contacted or Quoted (To contact clears it). It counts
  // from the season's first day, and only if it came after their time to
  // call was last changed (whenSetAt) -- "call me in the fall", written after
  // the call, is a new time to call, and they come up again then.
  let outreach = { startDate: '' };
  let outreachLoaded = false;
  let outreachEditing = false;
  const justReached = {};     // contact id -> what it was before ✓ Reached out (Undo, this visit only)

  const two = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  const todayYmd = () => ymd(new Date());
  const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00'));
  function niceDate(s) {
    return validDay(s) ? new Date(s + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  // The suggestion: the first weekday of February still to come.
  function firstWeekdayOfFeb(year) {
    const d = new Date(year, 1, 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return ymd(d);
  }
  function suggestedStart() {
    const t = todayYmd(), y = new Date().getFullYear();
    const thisYear = firstWeekdayOfFeb(y);
    return t <= thisYear ? thisYear : firstWeekdayOfFeb(y + 1);
  }
  // The first day of the month their time to call names (a year alone is
  // that January), or '' for none.
  function whenDay(text) {
    const k = whenKey(text);
    if (k === NO_DATE) return '';
    const m = k % 100;
    return Math.floor(k / 100) + '-' + two(m > 12 ? 1 : m) + '-01';
  }
  function reachedSince(p, start) {
    const at = String(p.reachedAt || '');
    if (!at || isNaN(new Date(at))) return false;
    if (new Date(at) < new Date(start + 'T00:00:00')) return false;
    return !(p.whenSetAt && String(p.whenSetAt) > at);
  }
  // The day someone comes up: the season's start, or their own time to call
  // when that is later.
  function dueFrom(p, start) {
    const w = whenDay(p.contactWhen);
    return w && w > start ? w : start;
  }
  function isDue(p, start, day) {
    if (!validDay(start) || isClosed(p) || day < start) return false;
    return day >= dueFrom(p, start) && !reachedSince(p, start);
  }
  function dueList(day) {
    const start = outreach.startDate;
    return Object.keys(people).map(k => people[k]).filter(p => isDue(p, start, day || todayYmd()))
      .sort((a, b) => whenKey(a.contactWhen) - whenKey(b.contactWhen) || (a.name || '').localeCompare(b.name || ''));
  }
  const ownsOutreach = () => !!(window.YDAuth && window.YDAuth.isOwner);

  function outreachHtml() {
    const start = outreach.startDate;
    const today = todayYmd();
    const sug = suggestedStart();
    const editor = '<div class="pp-out-edit">' +
        '<input type="date" id="ppOutDate" value="' + esc(validDay(start) && !(start < today && outreachEditing === 'next') ? start : sug) + '">' +
        '<button class="btn btn-sm btn-filled" onclick="saveOutreachDate()">Save this date</button>' +
        (validDay(start) ? '<button class="btn btn-sm" onclick="editOutreachDate(false)">Cancel</button>' : '') +
        (validDay(start) ? '<button class="link-btn" onclick="clearOutreachDate()">No start date</button>' : '') +
      '</div>' +
      '<div class="hint">Suggested: ' + esc(niceDate(sug)) + ' — the first weekday of February. ' +
        'Pick any day; it can be changed whenever you like.</div>';
    if (!validDay(start)) {
      return '<div class="pp-out-q">When do you want to start reaching out to people for next season’s work? ' +
        'From that day, everyone on the list whose time to call has come is listed here, in your morning summary and on the calendar.</div>' + editor;
    }
    // Set, and not here yet: one line, out of the list's way (15 Oct 2026).
    if (today < start && !outreachEditing) {
      const will = dueList(start).length;
      return '<div class="pp-out-line">📅 Outreach starts <b>' + esc(niceDate(start)) + '</b>' +
        '<span class="muted"> · ' + (will ? will + (will === 1 ? ' person' : ' people') + ' due that day' : 'nobody due that day yet') + '</span>' +
        ' <button class="link-btn" onclick="editOutreachDate(true)">Change</button></div>';
    }
    const head = '<div class="pp-out-when">' + (today < start ? 'Outreach starts ' : 'Outreach started ') + '<b>' + esc(niceDate(start)) + '</b>' +
      (outreachEditing ? '' : ' <button class="link-btn" onclick="editOutreachDate(true)">Change</button>' +
        (start < today && sug > start && sug.slice(0, 4) > start.slice(0, 4)
          ? ' · <button class="link-btn" onclick="editOutreachDate(\'next\')">Set next season’s date</button>' : '')) +
      '</div>' + (outreachEditing ? editor : '');
    if (today < start) {
      const will = dueList(start).length;
      return head + '<div class="muted pp-out-soon">' + (will
        ? will + (will === 1 ? ' person is' : ' people are') + ' due to be reached that day, by the list as it stands now.'
        : 'Nobody on the list would be due that day yet.') + '</div>';
    }
    const due = dueList(today);
    const done = Object.keys(justReached).filter(id => people[id] && due.indexOf(people[id]) === -1).map(id => people[id]);
    return head +
      (due.length || done.length ? due.concat(done).map(p => outreachRow(p, due.indexOf(p) === -1)).join('')
        : '<p class="empty-msg">Everyone due has been reached. 🎉</p>');
  }

  function outreachRow(p, done) {
    const id = safeIdOf(p.id);
    const tel = String(p.phone || '').replace(/[^0-9+]/g, '');
    return '<div class="pp-out-row' + (done ? ' done' : '') + '">' +
      '<div class="pp-out-main">' +
        '<button class="pp-out-name" onclick="findProspect(\'' + id + '\')">' + esc(p.name || '(no name)') + '</button>' +
        (p.contactWhen ? ' <span class="pp-when">' + esc(p.contactWhen) + '</span>' : '') +
        declinedBadge(p) +
        ((p.services || []).length ? '<div class="pp-svc">' + p.services.map(s => '<span class="svc-tag">' + esc(s) + '</span>').join('') + '</div>' : '') +
        (p.note ? '<div class="pp-out-note">' + esc(String(p.note).split('\n')[0].slice(0, 160)) + '</div>' : '') +
        '<div class="pp-contact">' +
          [tel ? '<a href="tel:' + esc(tel) + '">📞 ' + esc(p.phone) + '</a>' : '',
           p.email ? '<a href="mailto:' + esc(p.email) + '">✉️ ' + esc(p.email) + '</a>' : ''].filter(Boolean).join(' &middot; ') +
        '</div>' +
      '</div>' +
      '<div class="pp-out-act">' + (done
        ? '<span class="pp-out-did">✓ Reached</span><button class="link-btn" onclick="prospectReachedUndo(\'' + id + '\')">Undo</button>'
        : '<button class="btn btn-sm btn-filled" onclick="prospectReached(\'' + id + '\')">✓ Reached out</button>') +
      '</div>' +
    '</div>';
  }
  const safeIdOf = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');

  function renderOutreach() {
    const sec = el('ppOutSection'), wrap = el('ppOutWrap');
    if (!sec || !wrap) return;
    const show = ownsOutreach() && outreachLoaded;
    sec.hidden = !show;
    if (!show) return;
    // A date being picked keeps its place when the list redraws.
    const picking = document.activeElement && document.activeElement.id === 'ppOutDate' ? el('ppOutDate').value : null;
    const start = outreach.startDate, today = todayYmd();
    const active = validDay(start) && today >= start;
    const n = active ? dueList(today).length : 0;
    const title = el('ppOutTitle');
    if (title) title.textContent = active ? '📞 Time to reach out' : '📅 Next season outreach';
    const badge = el('ppOutBadge');
    if (badge) badge.textContent = active && n ? n + ' to reach' : '';
    // The one-line card has no heading bar of its own (outreachHtml).
    sec.classList.toggle('pp-out-compact', validDay(start) && today < start && !outreachEditing);
    wrap.innerHTML = outreachHtml();
    if (picking !== null && el('ppOutDate')) { el('ppOutDate').value = picking; el('ppOutDate').focus(); }
  }

  window.editOutreachDate = function (on) { outreachEditing = on; renderOutreach(); };
  window.saveOutreachDate = function () {
    const v = ((el('ppOutDate') || {}).value || '').trim();
    if (!validDay(v)) { showToast('Pick a date first'); return; }
    saveOutreach(v);
    showToast('Outreach starts ' + niceDate(v));
  };
  window.clearOutreachDate = async function () {
    if (!(await ydConfirm('Nobody is listed as due, and the summary and calendar say nothing, until a date is set again.',
      { title: 'Take the start date off?', ok: 'Take it off' }))) return;
    saveOutreach(null);
  };
  function saveOutreach(day) {
    if (!ownsOutreach() || !window.YDDb) return;
    outreach = Object.assign({}, outreach, { startDate: day || '' });
    outreachSeq++;
    outreachEditing = false;
    renderOutreach();
    tellOutreach();
    const me = window.YDAuth && window.YDAuth.user;
    Promise.resolve(window.YDDb.put('settings', 'outreach', { startDate: day || null, setAt: new Date().toISOString(),
      setBy: (me && me.uid) || null })).catch(e => failed('the outreach start date', e));
  }
  // The calendar draws the day from this (calendar.js).
  function tellOutreach() { document.dispatchEvent(new CustomEvent('yd-outreach')); }

  window.prospectReached = function (id) {
    const p = people[id];
    if (!p || !ydCan('contacts', 'change')) return;
    justReached[id] = { reachedAt: p.reachedAt || null, status: p.status || 'to-contact' };
    const patch = { reachedAt: new Date().toISOString() };
    if ((p.status || 'to-contact') === 'to-contact') patch.status = 'contacted';
    Object.assign(p, patch);
    render();
    write(id, patch, 'reached out to ' + p.name);
  };
  window.prospectReachedUndo = function (id) {
    const p = people[id], was = justReached[id];
    if (!p || !was) return;
    delete justReached[id];
    const patch = { reachedAt: was.reachedAt, status: was.status };
    Object.assign(p, patch);
    render();
    write(id, patch, 'undoing reached out for ' + p.name);
  };
  // From the outreach list to their card below: the list is searched for
  // them (and shows everyone), so the card is there whatever was filtered.
  window.findProspect = function (id) {
    const p = people[id];
    if (!p) return;
    const s = el('ppSearch'), st = el('ppFilterStatus'), sv = el('ppFilterSvc');
    if (s) s.value = p.name || '';
    if (st) st.value = '';
    if (sv) sv.value = '';
    notesOpen[id] = true;
    render();
    const card = el('ppCard_' + safeIdOf(id));
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  // ------------------------------------------------------------ the tag field
  //
  // Same shape as the Job tab's service tags, and deliberately the same list.

  function renderTags() {
    const wrap = el('ppTags');
    if (!wrap) return;
    wrap.innerHTML = tags.length
      ? tags.map((s, i) => '<span class="svc-tag">' + esc(s) +
          '<button onclick="removeProspectTag(' + i + ')" title="Remove">&times;</button></span>').join('')
      : '<span class="tag-none">No services yet</span>';
  }

  // The options are cloned from the Job tab's dropdown, so the service list is
  // never maintained in two places -- and cloned again whenever that list
  // changes (a service typed in anywhere is kept for good: app.js
  // rememberService).
  function fillTagOptions() {
    const src = el('serviceTypeSelect'), dst = el('ppTagSelect');
    if (!src || !dst) return;
    while (dst.options.length > 1) dst.remove(1);
    Array.prototype.forEach.call(src.options, o => {
      if (o.value === '' || o.dataset.typed) return;
      dst.appendChild(new Option(o.textContent, o.value));
    });
  }
  document.addEventListener('yd-services', fillTagOptions);

  window.addProspectTag = async function () {
    const sel = el('ppTagSelect');
    let v = sel.value;
    if (!v) return;
    if (v === '__custom') {
      sel.value = '';
      v = await ydPrompt('The service, in a word or two:', '', { title: 'Add a service', placeholder: 'e.g. Gutter cleaning', ok: 'Add' });
      if (!v || !v.trim()) return;
      v = v.trim();
    }
    if (window.YDServices) v = window.YDServices.canon(v);    // an old spelling is the name it became
    if (window.rememberService) rememberService(v);
    if (tags.indexOf(v) === -1) tags.push(v);
    sel.value = '';
    renderTags();
  };

  window.removeProspectTag = function (i) { tags.splice(i, 1); renderTags(); };

  // ------------------------------------------------------------------ the list

  function render() {
    renderOutreach();
    // The calendar's outreach day says how many are due (calendar.js).
    if (outreachLoaded && validDay(outreach.startDate)) tellOutreach();
    const wrap = el('ppWrap');
    if (!wrap) return;

    const all = Object.keys(people).map(k => people[k]);
    const open = all.filter(p => !isClosed(p));

    const badge = el('ppBadge');
    if (badge) badge.textContent = open.length ? open.length + ' to contact' : '';

    // Only services actually in use, so the filter never offers empty choices.
    const used = {};
    all.forEach(p => (p.services || []).forEach(s => { used[s] = true; }));
    const filt = el('ppFilterSvc');
    if (filt) {
      const keep = filt.value;
      filt.innerHTML = '<option value="">Any service</option>' +
        Object.keys(used).sort().map(s =>
          '<option' + (s === keep ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
    }

    const wantSvc = (filt && filt.value) || '';
    const wantStat = val('ppFilterStatus');
    const q = ((el('ppSearch') || {}).value || '').trim().toLowerCase();

    const list = all.filter(p => {
      if (wantStat === 'declined') { if (!(p.declined || []).length) return false; }
      else if (wantStat === 'open' ? isClosed(p) : wantStat && p.status !== wantStat) return false;
      if (wantSvc && (p.services || []).indexOf(wantSvc) === -1) return false;
      if (q) {
        const hay = [p.name, p.note, p.address, p.phone, p.email,
                     (p.services || []).join(' '), p.contactWhen,
                     (p.meetings || []).map(m => m.text).join(' ')].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort((a, b) =>
      whenKey(a.contactWhen) - whenKey(b.contactWhen) ||
      (a.name || '').localeCompare(b.name || ''));

    // A note being written keeps its place when the list redraws.
    const typing = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.id : null;
    wrap.innerHTML = list.length
      ? list.map(card).join('')
      : '<p class="empty-msg">' + (all.length
          ? 'Nobody matches that.'
          : 'Nobody on the list yet — add the first person with “+ Add a contact”.') + '</p>';
    const back = typing && el(typing);
    if (back) { back.focus(); try { back.setSelectionRange(back.value.length, back.value.length); } catch (e) {} }
  }

  function card(p) {
    const svc = p.services || [];
    // Anything with a status this version does not know about is drawn as not
    // yet contacted, rather than printing the word "undefined" at someone.
    const status = STATUSES[p.status] ? p.status : 'to-contact';
    return '<div class="pp' + (isClosed(p) ? ' pp-closed' : '') + '" id="ppCard_' + safeIdOf(p.id) + '">' +
      '<div class="pp-top">' +
        '<span class="pp-name">' + esc(p.name || '(no name)') + '</span>' +
        (p.contactWhen ? '<span class="pp-when">' + esc(p.contactWhen) + '</span>' : '') +
        '<span class="pp-stat s-' + status + '">' + STATUSES[status] + '</span>' +
        declinedBadge(p) +
      '</div>' +
      (svc.length
        ? '<div class="pp-svc">' + svc.map(s => '<span class="svc-tag">' + esc(s) + '</span>').join('') + '</div>'
        : '') +
      (p.note ? '<div class="pp-note">' + esc(p.note) + '</div>' : '') +
      (p.reachedAt && !isNaN(new Date(p.reachedAt))
        ? '<div class="pp-reached">✓ Last reached ' + esc(new Date(p.reachedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) + '</div>' : '') +
      contactLine(p) +
      meetingsHtml(p) +
      '<div class="pp-act">' +
        '<button class="btn btn-sm" onclick="toggleProspectNotes(\'' + p.id + '\')">📝 Notes' +
          ((p.meetings || []).length ? ' (' + p.meetings.length + ')' : '') + '</button>' +
        '<select onchange="setProspectStatus(\'' + p.id + '\', this.value)" title="Where this stands">' +
          Object.keys(STATUSES).map(s =>
            '<option value="' + s + '"' + (status === s ? ' selected' : '') + '>' +
            STATUSES[s] + '</option>').join('') +
        '</select>' +
        '<button class="btn btn-sm" onclick="editProspect(\'' + p.id + '\')">Edit</button>' +
        (ydCan('jobs', 'change')
          ? '<button class="btn btn-sm" onclick="prospectToJob(\'' + p.id + '\')">Start a bid</button>' : '') +
        (svc.indexOf('Snow Removal') !== -1
          ? '<button class="btn btn-sm btn-accent" onclick="prospectToSnow(\'' + p.id + '\')">Snow account</button>'
          : '') +
        '<button class="remove-btn" onclick="removeProspect(\'' + p.id + '\')" title="Take off the list">&times;</button>' +
      '</div>' +
    '</div>';
  }

  function declinedBadge(p) {
    const list = p.declined || [];
    if (!list.length) return '';
    const last = new Date(list[list.length - 1].at);
    return '<span class="pp-declined">Declined a bid' +
      (isNaN(last) ? '' : ' · ' + last.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })) + '</span>';
  }

  // ------------------------------------------------------- a bid they declined
  //
  // Jonah (9 Oct 2026): a bid marked lost puts the customer on this list for
  // next season -- "customers who declined bids with a note of what service
  // they declined and tagged for what service so I can sort". So: tagged with
  // the bid's services (the service filter finds them), a dated note saying
  // what they turned down, "when" set to next spring, and a `declined` entry
  // per bid (the "Declined a bid" filter). Someone already here -- the bid
  // may have started from this list -- is brought up to date, not added
  // twice: matched by the bid, then email, then phone, then the same name.
  // No price in the note: Contacts can be shared with an admin who has no
  // business seeing what a job was bid at.
  const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
  function nextSpring(d) { return 'Spring ' + (d.getFullYear() + (d.getMonth() >= 2 ? 1 : 0)); }
  function fromLostBid(jobId, j) {
    // The customer list switched on (customers.js): the bid's own customer.
    if (window.YDCustomers && window.YDCustomers.on()) return window.YDCustomers.fromLostBid(jobId, j);
    if (!j || !window.YDDb || !ydCan('contacts', 'change')) return null;
    const name = String(j.customerName || '').trim() ||
      String(j.business || '').trim() || [j.firstName, j.lastName].filter(Boolean).join(' ').trim();
    if (!name) return null;
    const email = String(j.email || '').trim().toLowerCase();
    const phone = digits(j.phone);
    const all = Object.keys(people).map(k => people[k]);
    const match = all.find(p => (p.declined || []).some(d => d.jobId === jobId)) ||
      (email && all.find(p => String(p.email || '').trim().toLowerCase() === email)) ||
      (phone.length === 10 && all.find(p => digits(p.phone) === phone)) ||
      all.find(p => String(p.name || '').trim().toLowerCase() === name.toLowerCase());

    const now = new Date();
    const services = (Array.isArray(j.serviceTypes) ? j.serviceTypes : []).map(s => String(s).trim()).filter(Boolean);
    const est = String(j.estimateNumber || '').trim();
    // Why, in the words picked when it was marked lost (app.js lostWhy).
    const why = (typeof lostWhy === 'function' ? lostWhy(j) : '').replace(/^Other: /, '');
    const line = 'Declined our bid' + (est ? ' #' + est : '') + (services.length ? ' for ' + services.join(', ') : '') +
      ' on ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      (why ? ' — why: ' + why : '') + '.';
    const entry = { at: now.toISOString(), jobId: jobId, est: est || null, services: services, reason: j.lostReason || null };
    const address = [String(j.address || '').trim(),
      [j.city, [j.state, j.zip].filter(Boolean).join(' ')].map(s => String(s || '').trim()).filter(Boolean).join(', ')]
      .filter(Boolean).join(', ');

    let id, patch;
    if (match) {
      id = match.id;
      const before = match.declined || [];
      const again = before.some(d => d.jobId === jobId);
      patch = {
        services: (match.services || []).concat(services.filter(s => (match.services || []).indexOf(s) === -1)),
        declined: again ? before : before.concat([entry]),
      };
      if (!again) patch.note = [String(match.note || '').trim(), line].filter(Boolean).join('\n');
      // Someone who said "not interested" stays that way; anyone else is to call.
      if (match.status !== 'no') patch.status = 'to-contact';
      if (!String(match.contactWhen || '').trim()) { patch.contactWhen = nextSpring(now); patch.whenSetAt = now.toISOString(); }
      // Fill in what the contact was missing; never overwrite what is there.
      [['phone', String(j.phone || '').trim()], ['email', email], ['address', address]].forEach(([k, v]) => {
        if (v && !String(match[k] || '').trim()) patch[k] = v;
      });
    } else {
      id = 'p' + Date.now().toString(36);
      const nm = (j.firstName || j.lastName || j.business) ? { first: j.firstName || '', last: j.lastName || '', business: j.business || '' }
        : (typeof splitName === 'function' ? splitName(name) : { first: '', last: '', business: name });
      patch = {
        name: name, firstName: nm.first || '', lastName: nm.last || '', business: nm.business || '',
        services: services, contactWhen: nextSpring(now), whenSetAt: now.toISOString(), note: line, address: address,
        phone: String(j.phone || '').trim(), email: email, status: 'to-contact',
        addedAt: now.toISOString(), declined: [entry],
      };
    }
    people[id] = Object.assign({ id: id }, people[id] || {}, patch);
    render();
    write(id, patch, 'the declined bid for ' + name);
    return { id: id, added: !match };
  }

  // ------------------------------------------------------------ meeting notes
  //
  // Jonah (5 Oct 2026): notes from meeting a client go on the iPad now, not
  // paper. Each is dated, newest first; on an iPad the Pencil writes straight
  // into the box (Scribble). "Start a bid" takes them along as the bid's
  // site-visit notes, which Claude builds the estimate from.
  const notesOpen = {};       // contact id -> its notes are open on its card
  const drafts = {};          // contact id -> a note being written, not saved yet
  function meetingsHtml(p) {
    if (!notesOpen[p.id]) return '';
    const list = (p.meetings || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const edits = ydCan('contacts', 'change');
    return '<div class="pp-meet">' +
      (edits ? '<textarea rows="4" id="ppMeet_' + p.id + '" placeholder="What you talked about, what they want, what you measured…" ' +
          'oninput="prospectNoteDraft(\'' + p.id + '\', this.value)">' + esc(drafts[p.id] || '') + '</textarea>' +
        '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="saveProspectNote(\'' + p.id + '\')">Save note</button></div>' : '') +
      (list.length ? list.map((m, i) => '<div class="pp-meet-item"><div class="pp-meet-when">' + esc(niceDay(m.at)) +
          (edits ? ' <button class="link-btn" onclick="removeProspectNote(\'' + p.id + '\', \'' + esc(m.at) + '\')">remove</button>' : '') +
          '</div><div class="pp-meet-text">' + esc(m.text) + '</div></div>').join('')
        : '<div class="muted">No notes yet.</div>') +
    '</div>';
  }
  function niceDay(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  window.toggleProspectNotes = function (id) {
    notesOpen[id] = !notesOpen[id];
    render();
    const box = el('ppMeet_' + id);
    if (box && notesOpen[id]) box.focus();
  };
  window.prospectNoteDraft = function (id, v) { drafts[id] = v; };
  window.saveProspectNote = function (id) {
    const p = people[id];
    const text = String(drafts[id] || '').trim();
    if (!p || !text) { showToast('Write the note first'); return; }
    const meetings = (p.meetings || []).concat([{ at: new Date().toISOString(), text: text }]);
    p.meetings = meetings;
    delete drafts[id];
    // A note means they were talked to -- reached, for next season's outreach.
    const patch = { meetings: meetings, reachedAt: new Date().toISOString() };
    p.reachedAt = patch.reachedAt;
    if ((p.status || 'to-contact') === 'to-contact') { p.status = 'contacted'; patch.status = 'contacted'; }
    render();
    write(id, patch, 'a note for ' + p.name);
    showToast('Note saved');
  };
  // No "are you sure?": the note goes at once and Undo puts it back.
  window.removeProspectNote = function (id, at) {
    const p = people[id];
    if (!p) return;
    const gone = (p.meetings || []).find(m => m.at === at);
    if (!gone) return;
    p.meetings = (p.meetings || []).filter(m => m.at !== at);
    render();
    write(id, { meetings: p.meetings }, 'a note for ' + p.name);
    const putBack = () => {
      const q = people[id];
      if (!q || (q.meetings || []).some(m => m.at === at)) return;
      q.meetings = (q.meetings || []).concat([gone]).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      render();
      write(id, { meetings: q.meetings }, 'a note for ' + q.name);
    };
    if (typeof showUndo === 'function') showUndo('Note removed', putBack); else showToast('Note removed');
  };
  // The notes as the bid's site-visit notes: oldest first, each with its day.
  function notesForBid(p) {
    return (p.meetings || []).slice().sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
      .map(m => new Date(m.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ': ' + m.text).join('\n\n');
  }

  // Phone and email are tappable -- the point of the list is making the call.
  function contactLine(p) {
    const bits = [];
    if (p.address) bits.push(esc(p.address));
    if (p.phone) bits.push('<a href="tel:' + esc(p.phone.replace(/[^0-9+]/g, '')) + '">' + esc(p.phone) + '</a>');
    if (p.email) bits.push('<a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>');
    return bits.length ? '<div class="pp-contact">' + bits.join(' &middot; ') + '</div>' : '';
  }

  window.renderProspects = render;

  // ----------------------------------------------------------------- the form

  // The name in parts (Jonah, 6 Oct 2026); `name` -- the business, or
  // "First Last" -- is still what the list shows and searches.
  // The address too (Jonah, 13 Oct 2026: "fields for each part of the
  // address"); `address` -- one line -- is still saved, for the list, the
  // search and directions (addr.js).
  const FORM = ['ppFirst', 'ppLast', 'ppBusiness', 'ppWhen', 'ppNote', 'ppAStreet', 'ppACity', 'ppAState', 'ppAZip',
                'ppPhone', 'ppEmail'];

  function clearForm() {
    FORM.forEach(f => { const n = el(f); if (n) n.value = ''; });
    tags = []; editingId = null;
    renderTags();
    const b = el('ppSaveBtn'); if (b) b.textContent = 'Add to the list';
    const c = el('ppCancelBtn'); if (c) c.textContent = 'Close';
  }

  // The form is folded away behind "+ Add a contact" so the list comes first
  // (15 Oct 2026: the list sat under a form the height of the screen).
  function showForm(on) {
    const f = el('ppForm'), b = el('ppAddBtn');
    if (f) f.hidden = !on;
    if (b) b.hidden = on;
  }
  window.openProspectForm = function () {
    if (editingId) clearForm();
    showForm(true);
    const n = el('ppFirst');
    if (n) { n.focus(); n.scrollIntoView({ block: 'nearest' }); }
  };
  // Closed, and emptied -- asked first when a new person was half typed in.
  window.cancelProspectEdit = async function () {
    const typed = !editingId && (FORM.some(f => val(f)) || tags.length);
    if (typed && !(await ydConfirm('What is typed in for this new contact is thrown away.',
      { title: 'Throw it away?', ok: 'Throw it away', cancel: 'Keep typing', danger: true }))) return;
    clearForm();
    showForm(false);
  };

  window.saveProspect = function () {
    const firstName = val('ppFirst'), lastName = val('ppLast'), business = val('ppBusiness');
    const name = business || [firstName, lastName].filter(Boolean).join(' ');
    if (!name) { showToast('Give them a name first'); if (el('ppFirst')) el('ppFirst').focus(); return; }

    const id = editingId || 'p' + Date.now().toString(36);
    const was = people[id];
    const a = window.YDAddr ? YDAddr.read('ppA') : { address: '', street: '', city: '', state: '', zip: '' };
    const rec = {
      name: name,
      firstName: firstName, lastName: lastName, business: business,
      services: tags.slice(),
      contactWhen: val('ppWhen'),
      note: val('ppNote'),
      address: a.address, street: a.street, city: a.city, state: a.state, zip: a.zip,
      phone: val('ppPhone'),
      email: val('ppEmail').toLowerCase(),
      status: (was && was.status) || 'to-contact',
      addedAt: (was && was.addedAt) || new Date().toISOString(),
    };

    // A new time to call is a new reason to call: reached before it, they
    // come up again when it arrives (isDue).
    if (String((was && was.contactWhen) || '') !== rec.contactWhen) rec.whenSetAt = new Date().toISOString();

    const wasEdit = !!editingId;
    // Merged over what was there: the save only writes these fields, so a
    // contact's declined bids and notes stay, here as in the database.
    people[id] = Object.assign({ id: id }, was || {}, rec);
    clearForm();
    render();
    write(id, rec, 'saving ' + name);
    showToast(wasEdit ? name + ' updated' : name + ' added');
    // A change made: the form folds away and the card is in the list. One
    // added: the form stays for the next (several are often written in a
    // row), until Close.
    if (wasEdit) {
      showForm(false);
      const card = el('ppCard_' + safeIdOf(id));
      if (card) card.scrollIntoView({ block: 'nearest' });
    } else if (el('ppFirst')) el('ppFirst').focus();
  };

  window.editProspect = function (id) {
    const p = people[id];
    if (!p) return;
    editingId = id;
    const set = (f, v) => { const n = el(f); if (n) n.value = v || ''; };
    // Saved before the name had parts: split it into the boxes.
    const nm = (p.firstName || p.lastName || p.business) ? { first: p.firstName, last: p.lastName, business: p.business }
      : (typeof splitName === 'function' ? splitName(p.name) : { first: '', last: '', business: p.name });
    set('ppFirst', nm.first); set('ppLast', nm.last); set('ppBusiness', nm.business);
    set('ppWhen', p.contactWhen); set('ppNote', p.note);
    if (window.YDAddr) YDAddr.fill('ppA', p);
    set('ppPhone', p.phone); set('ppEmail', p.email);
    tags = (p.services || []).slice();
    renderTags();
    const b = el('ppSaveBtn'); if (b) b.textContent = 'Save changes';
    const c = el('ppCancelBtn'); if (c) c.textContent = 'Cancel';
    showForm(true);
    const n = el('ppFirst');
    if (n) { n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.focus(); }
  };

  window.setProspectStatus = function (id, status) {
    if (!people[id]) return;
    const patch = { status: status };
    // Contacted or Quoted: they were reached, so they come off "Time to
    // reach out"; To contact puts them back on it.
    if (status === 'contacted' || status === 'quoted') patch.reachedAt = new Date().toISOString();
    else if (status === 'to-contact') patch.reachedAt = null;
    Object.assign(people[id], patch);
    delete justReached[id];
    render();
    write(id, patch, 'status for ' + people[id].name);
  };

  window.removeProspect = async function (id) {
    if (!ydCan('contacts', 'change')) return;
    const p = people[id];
    if (!p) return;
    if (!(await ydConfirm('This cannot be undone.', { title: 'Take ' + p.name + ' off the list?', ok: 'Take them off', danger: true }))) return;
    if (!people[id]) return;           // gone while the question was open
    delete people[id];
    if (editingId === id) { clearForm(); showForm(false); }
    render();
    if (!window.YDDb) { warnNoDb(); return; }
    Promise.resolve(window.YDDb.remove('prospects', id)).catch(e => failed('removing ' + p.name, e));
  };

  // Writes are not awaited. Firestore applies them locally at once but settles
  // the promise only when the server acknowledges, so awaiting would leave the
  // form sitting there dead with no signal -- which is half of when a list like
  // this gets used.
  //
  // The YDDb check is not paranoia: this section only appears once the owner is
  // signed in, but if the database layer ever failed to load, reaching straight
  // for .put would throw out of the click handler and the person typing would
  // get no warning at all.
  function write(id, data, what) {
    if (!window.YDDb) { warnNoDb(); return; }
    if (!ydCan('contacts', 'change')) { showToast('You can look at contacts but not change them'); return; }
    Promise.resolve(window.YDDb.put('prospects', id, data)).catch(e => failed(what, e));
  }

  // No signal is normal and needs no fuss -- the write is already applied on
  // the phone and goes up later. Being refused is not: the record is on screen
  // but will be gone on the next reload, and saying nothing would let someone
  // type in a whole list and lose it.
  function failed(what, e) {
    const code = e && e.code;
    if (code === 'permission-denied') {
      console.error('[prospects] ' + what + ' was refused by the security rules');
      showToast('Not saved — this account is not allowed to write here');
    } else {
      console.warn('[prospects] ' + what + ' not yet on the server:', code || (e && e.message));
    }
  }

  function warnNoDb() {
    console.error('[prospects] no database layer -- change kept on screen only');
    showToast('Not saved — the app has not finished connecting');
  }

  // --------------------------------------------------------------- converting

  // They said yes. Carry across what is already written down rather than
  // typing the same details a second time.

  window.prospectToJob = async function (id) {
    const p = people[id];
    if (!p || typeof newJob !== 'function') return;

    // newJob() asks before throwing away an unsaved job and answers false if
    // the job on screen was kept -- filling in these fields then would
    // overwrite the very work that was just rescued. It clears `dirty` when
    // it actually starts a new job, so a dirty flag still set is a "kept" too.
    if (!(await newJob())) return;
    if (typeof dirty !== 'undefined' && dirty) return;

    const set = (f, v) => { const n = el(f); if (n && v) n.value = v; };
    set('customerName', p.name);
    set('firstName', p.firstName); set('lastName', p.lastName); set('business', p.business);
    if (typeof namePartsFromCustomer === 'function') namePartsFromCustomer();
    // The contact's address in its parts, box for box (addr.js splits one
    // saved before the parts existed).
    if (window.YDAddr && (p.address || p.street)) {
      const ad = YDAddr.partsOf(p);
      set('address', ad.street || p.address); set('city', ad.city); set('state', ad.state); set('zip', ad.zip);
    } else set('address', p.address);
    set('phone', p.phone);
    set('email', p.email);
    set('notes', p.note);
    // Snow is billed through the snow module, so it is not a job service type.
    const svc = (p.services || []).filter(s => s !== 'Snow Removal');
    if (svc.length && typeof serviceTypes !== 'undefined') {
      serviceTypes = svc.slice();
      if (typeof renderServiceTypes === 'function') renderServiceTypes();
    }
    if (typeof markDirty === 'function') markDirty();
    // The meeting notes become the bid's site-visit notes, and Claude starts
    // the estimate from them by itself (estimate.js, if switched on).
    const notes = notesForBid(p);
    if (notes && window.YDEstimate && window.YDEstimate.setNotes) window.YDEstimate.setNotes(notes, true);
    // A new job starts as a bid (app.js isBidStatus): on the Bids board, not
    // in the job list, until it is booked.
    showToast(p.name + ' started as a bid — ' + (notes ? 'your notes are on its estimate' : 'write your site-visit notes under Estimate') +
      '. Still on the contact list until you remove them');
  };

  window.prospectToSnow = function (id) {
    const p = people[id];
    if (!p || typeof openSnowForm !== 'function') return;
    openSnowForm();
    if (typeof fillSnowFormFrom === 'function') fillSnowFormFrom(p);
    showToast('Fill in the rates and save');
  };

  // ------------------------------------------------------------------ loading

  function start() {
    if (unsub || !window.YDDb) return;
    unsub = window.YDDb.watch('prospects', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') { delete people[c.id]; return; }
        // A record missing its status would render the word "undefined" and
        // land in no filter at all, so it is treated as not yet contacted.
        const rec = Object.assign({ id: c.id }, c.data);
        if (!STATUSES[rec.status]) rec.status = 'to-contact';
        people[c.id] = rec;
      });
      render();
      // Search (search.js) reads the list again when it changes.
      document.dispatchEvent(new CustomEvent('yd-prospects'));
    }, err => {
      render();
      if (err && err.code === 'permission-denied') {
        showToast('Contacts could not be loaded — security rules need publishing');
      }
    });
  }

  // The outreach date lives in settings/outreach, which only the owner
  // reads (the rules: every settings record but a few is the owner's).
  // Read as that one record: watching the whole settings collection sent this
  // device every other settings record at start-up and again at each change
  // to any of them, to use one. It is read when the owner signs in, when the
  // app comes back to the front, and when the Contacts tab opens (at most once
  // a minute); his own change here is applied at once, and a read that was
  // already on its way when he saved is thrown away.
  let outreachOn = false, outreachReadAt = 0, outreachSeq = 0;
  function readOutreach(soon) {
    if (!outreachOn || !window.YDDb || !ownsOutreach()) return;
    if (soon && Date.now() - outreachReadAt < 60000) return;
    outreachReadAt = Date.now();
    const seq = ++outreachSeq;
    Promise.resolve(window.YDDb.get('settings', 'outreach')).then(d => {
      if (!outreachOn || seq !== outreachSeq) return;
      const next = validDay(d && d.startDate) ? d.startDate : '';
      const first = !outreachLoaded;
      outreachLoaded = true;
      if (first || next !== outreach.startDate) {
        outreach = { startDate: next };
        renderOutreach(); tellOutreach();
      }
    }).catch(() => { outreachReadAt = 0; /* offline with nothing kept: asked again next time */ });
  }
  function startOutreach() {
    if (outreachOn || !window.YDDb || !ownsOutreach()) return;
    outreachOn = true;
    readOutreach();
  }
  function stopOutreach() {
    outreachOn = false; outreachSeq++; outreachReadAt = 0;
    outreach = { startDate: '' }; outreachLoaded = false; outreachEditing = false;
    renderOutreach(); tellOutreach();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') readOutreach(true); });

  window.YDProspects = { all: () => people, render: function () { render(); readOutreach(true); }, whenKey: whenKey, fromLostBid: fromLostBid,
    // For the calendar: the day outreach starts, and how many are due on a day.
    outreach: () => (ownsOutreach() && outreachLoaded && validDay(outreach.startDate)
      ? { start: outreach.startDate, due: day => dueList(day).length } : null) };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    // Client names, phone numbers and notes about people who are not customers
    // yet: the owner, and an admin given Contacts -- matching what the rules
    // enforce. The tab itself is hidden too, so crew are not left tapping an
    // empty panel.
    const owner = a.mode === 'cloud' && !!a.user && ydCan('contacts', 'see');
    document.documentElement.toggleAttribute('data-contacts-readonly', owner && !ydCan('contacts', 'change'));
    const sec = el('ppSection');
    if (sec) sec.hidden = !owner;
    const tab = el('tabContacts');
    if (tab) tab.hidden = !owner;

    // A crew member who was somehow left on this tab gets moved off it.
    if (!owner) {
      const panel = el('panel-contacts');
      if (panel && panel.classList.contains('active') && typeof switchTab === 'function') switchTab('home');
    }

    if (owner && ownsOutreach()) startOutreach(); else if (outreachOn) stopOutreach();
    if (owner) start();
    else if (unsub) {
      // Access taken away (or signed out): stop listening and drop the list.
      try { unsub(); } catch (err) {}
      unsub = null; people = {};
      render();
    }
  });

  function boot() { fillTagOptions(); renderTags(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
