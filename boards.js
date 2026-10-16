// Boards: cards in columns, the way Trello does it, but inside Job Hub.
//
// There are two very different kinds of board here, and keeping them apart is
// the whole design.
//
// BIDS AND JOBS ARE NOT STORED AS CARDS. They are a live view of the jobs
// themselves, grouped by where each job has got to. Dragging a card does not
// move a card -- it changes the job (its bidStage / workStage, and its status
// where that follows). Storing them as separate cards would mean every job
// existing twice, and the two copies would drift the first time someone
// changed a status in the job form instead of on the board. These two are
// owner-only: a job carries its price, and crew cannot read jobs at all.
//
// EVERYTHING ELSE IS A STORED BOARD -- boards/{id} with its cards in
// boards/{id}/cards. To-do lists and crew task lists. Each board carries a
// visibleTo list of crew uids; the security rules let a crew member read a
// board only when they are on it, and let them move a card and tick its
// checklist but not rewrite it. That is what makes "the boards I share with
// specific guys" enforceable rather than cosmetic.

(function () {
  'use strict';

  // --------------------------------------------------------------- constants

  const BIDS = {
    id: 'bids', virtual: true, name: 'Bids', color: '#2f6fd6',
    columns: [
      { id: 'siteVisit', name: 'Site visit' },
      { id: 'toSend', name: 'Bid to send' },
      { id: 'sent', name: 'Sent — waiting' },
      { id: 'followUp', name: 'Follow up' },
      { id: 'won', name: 'Won' },
      { id: 'lost', name: 'Lost' },
    ],
  };
  const JOBS = {
    id: 'jobs', virtual: true, name: 'Jobs', color: '#2f8f5b',
    columns: [
      { id: 'scheduled', name: 'Scheduled' },
      { id: 'inProgress', name: 'In progress' },
      { id: 'punchList', name: 'Punch list' },
      { id: 'toInvoice', name: 'Ready to invoice' },
      { id: 'invoiced', name: 'Invoiced' },
      { id: 'paid', name: 'Paid' },
    ],
  };
  const QUOTING_STAGES = ['siteVisit', 'toSend', 'sent', 'followUp'];
  const ACTIVE_STAGES = ['scheduled', 'inProgress', 'punchList'];
  const COMPLETE_STAGES = ['toInvoice', 'invoiced', 'paid'];

  // Won and paid cards would pile up forever. They stay on the board long
  // enough to be seen, then drop off -- the job itself is untouched. A lost
  // bid leaves at once (Jonah, 9 Oct 2026): it stays under Bids in My Jobs,
  // marked Lost, and the customer goes on Contacts for next season.
  const SHOW_WON_DAYS = 30, SHOW_PAID_DAYS = 30;

  // Templates for new stored boards.
  const TEMPLATES = {
    crew: { label: 'Crew task list', columns: ['To do', 'Doing', 'Done'] },
    admin: { label: 'To-do list', columns: ['This week', 'Recurring', 'Waiting on', 'Done'] },
    blank: { label: 'Blank', columns: ['To do', 'Done'] },
    // Jonah (9 Oct 2026): "something to track things i want to purchase".
    // Bought is the done column, so a bought thing leaves the board next day.
    tobuy: { label: 'To-buy list', columns: ['Want', 'Researching', 'Ready to buy', 'Bought'] },
  };

  // Colours a board or a label can be. Picked to be told apart at a glance in
  // daylight and in the dark theme, including by the colour-blind -- no two
  // that differ only by red/green.
  const PALETTE = ['#2f6fd6', '#1a9c8c', '#2f8f5b', '#8bb22a', '#e0a526',
                   '#e07b24', '#d64545', '#d94f8a', '#8e5bc7', '#66418f', '#6b7a8f'];
  // Each colour's name, said by a screen reader and shown on hover: a row of
  // unnamed dots tells nobody which is which.
  const COLOR_NAMES = { '#2f6fd6': 'Blue', '#1a9c8c': 'Teal', '#2f8f5b': 'Green', '#8bb22a': 'Lime',
    '#e0a526': 'Yellow', '#e07b24': 'Orange', '#d64545': 'Red', '#d94f8a': 'Pink', '#8e5bc7': 'Purple',
    '#66418f': 'Plum', '#6b7a8f': 'Grey' };
  const colorName = c => COLOR_NAMES[String(c || '').toLowerCase()] || 'Colour';

  // The labels a new board starts with. No "Urgent" label any more: how
  // urgent a card is has its own picker (urgency), which sorts, filters and
  // pings -- a label of the same name did none of that and only confused.
  // Boards that already have it keep it.
  const DEFAULT_LABELS = [
    { id: 'waiting', name: 'Waiting', color: '#e0a526' },
    { id: 'materials', name: 'Materials', color: '#e07b24' },
    { id: 'equipment', name: 'Equipment', color: '#2f6fd6' },
    { id: 'office', name: 'Office', color: '#8e5bc7' },
    { id: 'rainday', name: '☔ Rain day', color: '#3b82c4' },
  ];

  // ------------------------------------------------------------------- state

  let boards = {};          // stored boards, id -> board
  let cards = {};           // boardId -> { cardId -> card }
  let people = {};          // owner only: uid -> user record
  let current = null;       // the board on screen
  let openCard = null;      // { boardId, cardId } of the card being viewed
  let editingBoard = null;  // board id being edited, '' for a new one
  let unsubBoards = null, unsubPeople = null;
  let cardUnsubs = {};
  // Boards whose cards have arrived from the server at least once. The first
  // answer can come from the local cache, and on a fresh phone that is empty:
  // anything deciding "this card does not exist" has to wait for this.
  let cardsLoaded = {};
  let seeded = false;
  let ready = false;        // boards have arrived from the server at least once
  let dragging = null;      // { boardId, cardId } while a card is dragged
  let drawFrame = 0;        // a redraw waiting for the next frame (redrawIfVisible)
  let drawLater = 0;        // one waiting for a slide along the columns to end
  let cardsNews = 0;        // "cards changed" waiting to be told (cardsChanged)

  // The Maintenance board is made and kept in step by equipment.js, one card
  // per machine and per problem noted on it. Deleting it would only see it
  // made again the next time Job Hub opened, so it cannot be deleted.
  const MAINTENANCE = 'maintenance';
  const CREW_BOARD = 'crew';         // Crew tasks: where the recurring crew tasks go (recurring.js)
  const PICKUPS_BOARD = 'pickups';   // made by the server from "ready for pickup" emails (receipts.py)

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  // The Bids and Jobs boards are the jobs themselves, so they follow Jobs.
  const seesJobs = () => ydCan('jobs', 'see');
  const movesJobs = () => ydCan('jobs', 'change');
  // Every stored board, not only the ones shared with you; and running them.
  const seesAllBoards = () => ydCan('boards', 'see');
  const editsBoards = () => ydCan('boards', 'change');
  // Adding, editing and deleting the cards on ONE board: the owner; an admin
  // who may change boards, on a board not marked private; and anyone the
  // owner ticked under "Who can add & change" on it (`editors`; Jonah, 12 Oct
  // 2026: "select specific calendars and boards that the guys can change").
  const editsBoard = b => !!b && !b.virtual && (isOwner() || (editsBoards() && b.ownerOnly !== true) ||
    (!!me() && (b.editors || []).indexOf(me().uid) !== -1));
  // The board itself -- its settings, deleting it: the owner, or an admin
  // who may change boards on one marked not private (firestore.rules ask for
  // ownerOnly == false itself). A private board shared with an admin by name
  // showed them Board settings and Delete, which the rules then refused.
  const runsBoard = b => !!b && !b.virtual && (isOwner() || (editsBoards() && b.ownerOnly === false));
  // Who sees a board and who may change its cards: the owner, or an admin he
  // gave Board sharing on Your Crew → Access (Jonah, 12 Oct 2026: "it needs
  // to be an admin access option") -- never on a private board, and Private
  // itself stays his (firestore.rules hold both).
  const setsSharing = b => isOwner() ||
    (editsBoards() && ydCan('boardSharing', 'change') && !(b && b.ownerOnly === true));
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const two = n => String(n).padStart(2, '0');
  const nowIso = () => new Date().toISOString();
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function localDay(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  function daysSince(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return isFinite(t) ? Math.floor((Date.now() - t) / 864e5) : null;
  }
  function shortDay(day) {
    if (!day) return '';
    const d = new Date(day + 'T00:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(w => w[0].toUpperCase()).join('') || '?';
  }
  function myName() {
    const u = me();
    if (!u) return '';
    // A crew phone has no list of people, but knows its own record -- the
    // name the owner gave them, which is what the owner's phone is told
    // (functions/reminders.py _activity), not their Google name.
    const own = window.YDRemind && YDRemind.me();
    return (people[u.uid] && people[u.uid].name) || (own && own.name) || u.displayName || u.email || '';
  }
  // Whether a card is mine: I am on it, or nobody is and I made it (a crew
  // task with nobody on it: every crew member's) -- remind.js. The 👤 Mine
  // filter, My day and the reminders agree on it. Who "I" am is worked out
  // once for a whole draw (`whoNow`, set by render), not again for each card.
  let whoNow = null;
  function isMineCard(board, k) {
    return YDRemind.cardIsMine(k, board, whoNow || YDRemind.who(people));
  }
  const cardType = (board, k) => YDRemind.typeOf(k, { boardId: board.id });
  // A card with no column shows in the first one, so everything that works
  // out where a card sits has to read it the same way.
  function colOf(board, k) {
    return k.column || (board && board.columns && board.columns[0] ? board.columns[0].id : '');
  }
  // The column that means "done": the one called Done, when a board has one
  // -- Crew tasks keeps an "Equipment Maintenance" column after its Done --
  // otherwise the last column, as it always was.
  // The column that means done. A board says which in its settings
  // (doneColumn: a column's id, or '' for none) -- Jonah, 15 Oct 2026:
  // deleting the To buy board's "Bought" column made the next one along,
  // "Vehicles", the last -- and so "done" -- and every card in it was
  // crossed off. A board not saved since: the column called Done, else one
  // whose name says finished (Bought, Picked up, Built…) -- never just the
  // last column.
  const FINISHED_NAME = /^\s*(done|bought|built|finished|complete|completed|paid|picked up|fixed|closed|sold|delivered)\s*$/i;
  function doneColOf(board) {
    const cols = (board && board.columns) || [];
    if (board && typeof board.doneColumn === 'string') return cols.some(c => c.id === board.doneColumn) ? board.doneColumn : '';
    const named = cols.find(c => /^\s*done\s*$/i.test(String(c.name || '')));
    if (named) return named.id;
    const finished = cols.filter(c => FINISHED_NAME.test(String(c.name || '')));
    return finished.length ? finished[finished.length - 1].id : '';
  }
  // Phones and tablets do not drag reliably, so there a card is moved from
  // the sheet that opens when it is tapped -- and the screen should say so.
  function touchScreen() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  // ------------------------------------------------------------ job columns

  function jobsList() {
    return (typeof loadAllJobs === 'function' ? loadAllJobs() : []).filter(j => j && j._id);
  }

  function bidColumn(j) {
    const stage = j.bidStage;
    const quoting = (j.jobStatus || 'quoting') === 'quoting';
    // Won and Lost only count while the job's status agrees. A lost bid whose
    // customer rang back and was set Active in the form used to sit in Lost on
    // this board AND in Scheduled on the Jobs board.
    if (stage === 'won' && !quoting) return (daysSince(j.bidStageAt) || 0) <= SHOW_WON_DAYS ? 'won' : null;
    if (stage === 'lost' && quoting) return null;
    if (!quoting) return null;
    return QUOTING_STAGES.indexOf(stage) !== -1 ? stage : 'toSend';
  }

  // A stage only counts if it agrees with the job's status. If someone changes
  // the status in the job form, the board follows the form rather than showing
  // a complete job sitting in "In progress".
  function workColumn(j) {
    const st = typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : j.jobStatus;
    const stage = j.workStage;
    // Booked jobs are Scheduled; In progress jobs are In progress or on the
    // Punch list. A stage that disagrees with the status follows the status.
    if (st === 'booked') return 'scheduled';
    if (st === 'inprogress') return stage === 'punchList' ? 'punchList' : 'inProgress';
    if (st === 'complete') {
      // A finished job sits where its one stage says (app.js jobStage, via
      // sync.js finishedStage): with a QuickBooks invoice, where QuickBooks
      // says; without one, the column it was put in by hand.
      const col = window.YDSync && YDSync.finishedStage ? YDSync.finishedStage(j)
        : COMPLETE_STAGES.indexOf(stage) !== -1 ? stage : 'toInvoice';
      if (col === 'paid' && (daysSince(j.workStageAt) || 0) > SHOW_PAID_DAYS) return null;
      return col;
    }
    return null;
  }

  function jobCards(board) {
    const out = {};
    board.columns.forEach(c => { out[c.id] = []; });
    jobsList().forEach(j => {
      const col = board.id === 'bids' ? bidColumn(j) : workColumn(j);
      if (col && out[col]) out[col].push(j);
    });
    const since = j => board.id === 'bids' ? (j.bidStageAt || j.lastModified) : (j.workStageAt || j.lastModified);
    Object.keys(out).forEach(k => out[k].sort((a, b) =>
      String(since(a) || '').localeCompare(String(since(b) || ''))));
    return out;
  }

  // Moving a job card changes the job. The status follows where it makes sense:
  // a bid marked Won becomes an active job and appears on the Jobs board.
  // `why`: the reason a bid was lost ({lostReason, lostReasonText}), asked
  // first whenever a bid goes to Lost (app.js askLostReason) -- Cancel and
  // it stays where it was.
  function moveJob(jobId, boardId, col, why) {
    const j = jobsList().find(x => x._id === jobId);
    if (!j) return;
    // A card dropped back where it was (a drag that changed its mind) is not
    // a move. Treating it as one restamped the job, which reset its age and
    // cleared the "untouched for a fortnight" warning on a bid going cold.
    if ((boardId === 'bids' ? bidColumn(j) : workColumn(j)) === col) return;
    if (boardId === 'bids' && col === 'lost' && !why && typeof askLostReason === 'function') {
      // The card goes back to its place while the question is open; the
      // answer moves it.
      render();
      askLostReason({ name: (j.customerName || '').trim(), preset: turnedDown(j) ? 'qb' : '' },
        w => moveJob(jobId, boardId, col, w));
      return;
    }
    const at = nowIso();
    let patch;
    if (boardId === 'bids') {
      if (col === 'won') {
        patch = { bidStage: 'won', bidStageAt: at };
        if ((j.jobStatus || 'quoting') === 'quoting') {
          patch.jobStatus = 'booked'; patch.workStage = 'scheduled'; patch.workStageAt = at;
        }
      } else if (col === 'lost') {
        patch = { bidStage: 'lost', bidStageAt: at, jobStatus: 'quoting', lostAt: at,
                  lostReason: (why && why.lostReason) || null, lostReasonText: (why && why.lostReasonText) || null };
      } else {
        patch = { bidStage: col, bidStageAt: at, jobStatus: 'quoting' };
      }
    } else {
      // QuickBooks holds this job's invoice, so it decides Invoiced or Paid
      // (app.js jobStage). A finished job dragged between those columns
      // would only jump back -- say why instead. One not finished yet may be
      // dropped on any of them: it is finished, and lands where QuickBooks says.
      const inv = typeof qbInvoiceOf === 'function' ? qbInvoiceOf(j) : null;
      if (inv && COMPLETE_STAGES.indexOf(col) !== -1) {
        const lands = window.YDSync && YDSync.finishedStage ? YDSync.finishedStage(j) : col;
        const owed = typeof qbOwed === 'function' ? qbOwed(inv) : NaN;
        const said = 'QuickBooks has invoice' + (inv.docNumber ? ' #' + inv.docNumber : '') +
          (isFinite(owed) ? (owed > 0 ? ' with ' + fmtMoney(owed) + ' still owed' : ', paid in full') : '');
        if (normStatusOf(j) === 'complete') {
          render();
          showToast(said + ' — it decides Invoiced or Paid. Log a payment on the job to move it on.', 6000);
          return;
        }
        if (lands !== col) {
          showToast(said + ' — so it goes to ' + ((JOBS.columns.find(c => c.id === lands) || {}).name || lands) + '.', 5000);
          col = lands;
        }
      }
      patch = { workStage: col, workStageAt: at,
                jobStatus: col === 'scheduled' ? 'booked' : ACTIVE_STAGES.indexOf(col) !== -1 ? 'inprogress' : 'complete' };
    }
    if (!window.YDSync || !window.YDSync.patchJob(jobId, patch)) {
      showToast('Could not move that job');
      return;
    }
    const name = (j.customerName || 'Job').trim();
    if (boardId === 'bids' && col === 'lost') {
      // Off the board; the customer onto Contacts, tagged with what they
      // turned down, to call next season (prospects.js).
      const contact = window.YDProspects && window.YDProspects.fromLostBid
        ? window.YDProspects.fromLostBid(jobId, Object.assign({}, j, patch)) : null;
      const said = typeof lostWhy === 'function' ? lostWhy(patch) : '';
      showToast(name + ' marked lost' + (said ? ' (' + said + ')' : '') + ' — kept under Bids in My Jobs' +
        (contact ? (contact.added ? ', and added to Contacts for next season' : ', and noted on their contact') : ''), 5000);
      render();
      return;
    }
    const colName = (boardId === 'bids' ? BIDS : JOBS).columns.find(c => c.id === col).name;
    showToast(name + ' → ' + colName + (col === 'won' && patch.jobStatus === 'booked'
      ? ' (now on the Jobs board)' : ''));
    render();
  }

  // ------------------------------------------------------------ board lists

  function visibleBoards() {
    // A board the crew only see Crew-tagged cards of (loadCrewBoards) is not
    // one of theirs to open: those cards show on Crew tasks.
    const stored = Object.values(boards).filter(b => !b.crewOnly).sort((a, b) =>
      (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(b.name || ''));
    return seesJobs() ? [BIDS, JOBS].concat(stored) : stored;
  }
  function boardById(id) {
    if (id === 'bids') return seesJobs() ? BIDS : null;
    if (id === 'jobs') return seesJobs() ? JOBS : null;
    return boards[id] || null;
  }

  // ---------------------------------------------------------------- render

  function render() {
    // Drawn now: a redraw already waiting for the next frame has nothing
    // left to do.
    if (drawFrame) { cancelAnimationFrame(drawFrame); drawFrame = 0; }
    if (drawLater) { clearTimeout(drawLater); drawLater = 0; }
    whoNow = window.YDRemind ? YDRemind.who(people) : null;
    try { draw(); } finally { whoNow = null; }
  }

  function draw() {
    const wrap = el('boardsWrap');
    if (!wrap) return;
    const list = visibleBoards();

    if (!me() || !window.YDDb) {
      const local = window.YDAuth && window.YDAuth.mode === 'local';
      wrap.innerHTML = '<p class="empty-msg">' + (local
        ? 'Boards need a connection. They will appear once Job Hub can reach the internet.'
        : 'Loading…') + '</p>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML = '<p class="empty-msg">' + (editsBoards()
        ? 'No boards yet.' : 'No boards have been shared with you yet.') + '</p>';
      return;
    }
    if (!current || !boardById(current)) current = rememberedBoard(list);
    const board = boardById(current);
    refreshComputer();

    wrap.innerHTML =
      computerLine() +
      '<div class="bd-picker">' +
        list.map(b => '<button class="bd-chip' + (b.id === current ? ' on' : '') +
          '" style="--c:' + safeColor(b.color) + '" onclick="showBoard(\'' + b.id + '\')">' +
          '<span class="bd-dot"></span><span class="bd-name">' + esc(b.name || 'Board') + '</span>' +
          (b.ownerOnly ? ' <span title="Private — only you">🔒</span>' : '') +
          (b.visibleTo && b.visibleTo.length && editsBoards()
            ? '<span class="bd-shared" title="Shared with crew">👥 ' + b.visibleTo.length + '</span>' : '') +
          '</button>').join('') +
        (editsBoards() ? '<button class="bd-chip bd-add" onclick="editBoard(\'\')">+ New board</button>' : '') +
      '</div>' +
      '<div class="bd-head" style="--c:' + safeColor(board.color) + '">' +
        '<div class="bd-title">' + esc(board.name) + '</div>' +
        '<div class="bd-sub">' + boardSubtitle(board) + '</div>' +
        '<div class="bd-actions">' +
          (runsBoard(board)
            ? '<button class="btn btn-sm" onclick="editBoard(\'' + board.id + '\')">Board settings</button>' : '') +
          (editsBoard(board)
            ? '<button class="btn btn-sm btn-filled" onclick="addCard(\'' + board.id + '\', \'' +
              board.columns[0].id + '\')">+ Add card</button>' : '') +
          // The recurring crew tasks land here, on Crew tasks (recurring.js).
          // Named as the calendar's layer of them is, "Recurring crew tasks":
          // one thing, one name.
          (board.id === CREW_BOARD && isOwner() && typeof openRecurring === 'function'
            ? '<button class="btn btn-sm" onclick="openRecurring()">🔁 Recurring crew tasks</button>' : '') +
          (board.virtual && movesJobs()
            ? '<button class="btn btn-sm btn-filled" onclick="addJobCard(\'' + board.id + '\', \'' +
              board.columns[0].id + '\')">' + (board.id === 'bids' ? '+ New bid' : '+ New job') + '</button>' : '') +
        '</div>' +
      '</div>' +
      (board.id === 'bids' ? followUpHtml() : '') +
      filterBarHtml(board) +
      (cardFilter === 'rain' && !board.virtual
        ? '<div class="bd-rain">' + rainHtml() + '</div>'
        : '<div class="bd-cols" data-keep="bd-' + esc(board.id) + '">' + columnsHtml(board) + '</div>' + (board.id === CREW_BOARD ? crewLaneHtml() : ''));
  }

  // ------------------------------------------------------------- follow up
  //
  // Bids waiting on an answer long enough to chase, oldest first, at the top
  // of the Bids board. THE CHASE RULE -- the same in the summaries
  // (functions/digest.py CHASE_AFTER_DAYS / WRITE_AFTER_DAYS / _bids), so the
  // board, Home and the morning email never disagree:
  //   - chase: in "Sent — waiting" 5 days or more, or moved to Follow up (at once);
  //   - write: in "Bid to send" 2 days or more is a bid still to write (its
  //     age chip turns red here; the summaries list it under "Bids to write");
  //   - never: a bid the customer accepted or turned down in QuickBooks --
  //     the first is booked, the second is asked "mark lost?" on its card.
  // "Write the email" has Claude draft a follow-up from the job into Gmail
  // Drafts -- never sent -- and the draft is noted on the job (followUps) so
  // the list says when the last one was.
  const CHASE_AFTER_DAYS = { sent: 5, followUp: 0 };
  const WRITE_AFTER_DAYS = 2;
  const drafting = {};      // job id -> true while its email is being written

  // How long a bid has sat in its column, in whole days.
  const bidDays = j => daysSince(j.bidStageAt || j.lastModified) || 0;
  function toChase() {
    return jobsList().map(j => ({ j, col: bidColumn(j), days: bidDays(j) }))
      .filter(b => b.col in CHASE_AFTER_DAYS && b.days >= CHASE_AFTER_DAYS[b.col] &&
        !acceptedToBook(b.j) && !turnedDown(b.j))
      .sort((a, b) => b.days - a.days);
  }
  // Bids sat in "Bid to send" long enough that writing them is late.
  const lateToWrite = j => bidColumn(j) === 'toSend' && bidDays(j) >= WRITE_AFTER_DAYS && !turnedDown(j);
  function toWrite() {
    return jobsList().filter(lateToWrite).map(j => ({ j, col: 'toSend', days: bidDays(j) }))
      .sort((a, b) => b.days - a.days);
  }

  const looksLikeEmail = s => /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(s || '').trim());
  const agoText = d => d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';

  function followUpHtml() {
    if (!movesJobs()) return '';
    const list = toChase();
    if (!list.length) return '';
    // Not called "Follow up": that is also a column's name, and a bid listed
    // here while sitting in "Sent — waiting" looked like the column and the
    // list disagreed. Each row says which column the bid is in.
    return '<div class="bd-chase">' +
      '<div class="bd-chase-head">📨 Time to chase <span class="bd-count">' + list.length + '</span>' +
        '<span class="bd-chase-sub">Sent ' + CHASE_AFTER_DAYS.sent + ' or more days ago with no answer, or moved to Follow up — oldest first. ' +
        'The email is saved in Gmail Drafts for you to read and send.</span></div>' +
      list.map(({ j, col, days }) => {
        const price = parseMoney(j.jobPrice);
        const ups = (Array.isArray(j.followUps) ? j.followUps : []).filter(f => f && f.at);
        const last = ups[ups.length - 1];
        const lastDays = last ? daysSince(last.at) : null;
        const busy = !!drafting[j._id];
        const email = looksLikeEmail(j.email);
        return '<div class="bd-chase-row">' +
          '<div class="bd-chase-main" onclick="openJobCard(\'bids\', \'' + safeId(j._id) + '\')">' +
            '<div class="bd-chase-name">' + esc((j.customerName || 'Untitled job').trim()) +
              (j.estimateNumber ? ' <span class="job-num">#' + esc(j.estimateNumber) + '</span>' : '') +
              (price ? ' · <span class="bd-money">' + fmtMoney(price) + '</span>' : '') + '</div>' +
            '<div class="bd-chase-line">' + (col === 'followUp' ? 'In Follow up since ' : 'In Sent — waiting since ') +
              (days === 0 ? 'today' : days === 1 ? 'yesterday' : (j.bidStageAt ? shortDay(localDay(new Date(j.bidStageAt))) : agoText(days)) +
                ' (' + days + ' days)') +
              (last ? ' · follow-up drafted ' + agoText(lastDays || 0) +
                (ups.length > 1 ? ' (' + ups.length + ' so far)' : '') : '') + '</div>' +
          '</div>' +
          '<div class="bd-chase-act">' +
            (last && /^https:\/\/mail\.google\.com\//.test(String(last.link || ''))
              ? '<a class="btn btn-sm" href="' + esc(last.link) + '" target="_blank" rel="noopener">Open draft</a>' : '') +
            (email
              ? '<button class="btn btn-sm btn-filled" ' + (busy ? 'disabled' : '') +
                ' onclick="writeFollowUp(\'' + safeId(j._id) + '\')">' +
                (busy ? 'Writing…' : last ? 'Write another' : 'Write the email') + '</button>'
              : '<span class="bd-chase-none" title="Add the customer’s email on the job first">No email on the job</span>') +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  window.writeFollowUp = async function (jobId) {
    if (!movesJobs() || drafting[jobId]) return;
    const j = jobsList().find(x => x._id === jobId);
    const user = me();
    const base = ((window.YD_CONFIG || {}).claudeEndpoint || '').replace(/\/+$/, '');
    if (!j || !user) return;
    if (!base) { showToast('The server address is not configured'); return; }
    drafting[jobId] = true;
    render();
    try {
      const res = await fetch(base + '/followup/draft', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + await user.getIdToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || ('failed (' + res.status + ')'));
      // Read the job again: it may have changed while Claude was writing.
      const now = jobsList().find(x => x._id === jobId) || j;
      const ups = (Array.isArray(now.followUps) ? now.followUps : []).concat([{
        at: nowIso(), draftId: data.draftId || null, link: data.link || null,
        subject: data.subject || '', by: myName() || null,
      }]);
      if (!window.YDSync || !window.YDSync.patchJob(jobId, { followUps: ups })) {
        showToast('Draft saved in Gmail, but this device could not note it on the job');
      } else {
        showToast('Follow-up saved in Gmail Drafts — read it and send it from there');
      }
    } catch (e) {
      showToast('Could not write the email: ' + e.message);
    } finally {
      delete drafting[jobId];
      render();
    }
  };

  function boardSubtitle(b) {
    const touch = touchScreen();
    if (b.id === 'bids') return 'Every bid, from site visit to won or lost. ' +
      (touch ? 'Tap a card to move the job along.' : 'Drag a card, or tap it, to move the job along.');
    if (b.id === 'jobs') return 'Every job you have won, until it is paid. Moving a card changes the job’s status.' +
      (touch ? ' Tap a card to move it.' : '');
    const shared = (b.visibleTo || []).map(uid => personName(uid)).filter(Boolean);
    // Admins with Boards access see every board that is not private, so
    // "only you" is said of a private one alone.
    return (runsBoard(b)
      ? (b.ownerOnly ? '🔒 Private — ' + (shared.length ? 'you and ' + shared.map(esc).join(', ') : 'only you')
        : shared.length ? 'Shared with ' + shared.map(esc).join(', ') : 'Not shared with the crew')
      : editsBoard(b) ? 'Shared with you — you can add and change cards' : 'Shared with you') +
      (touch && canMove(b.id) ? '. Tap a card to move it.' : '');
  }

  // ------------------------------------------------- urgency & the filter
  //
  // Jonah (5 Oct 2026): "a tag and urgency system for cards" and "a rain day
  // board or a rain day tag ... so on rain days the crew can filter and figure
  // out what they can be getting done." Urgency is picked on the card (the
  // owner or an admin -- crew cannot change what a card says); cards sort by
  // it, then as they were dragged. The filter bar narrows a board to what is urgent or
  // what is yours; ☔ Rain day shows the rain-day cards from every board you
  // can see, grouped by board (WISHLIST #1).
  // One colour scale for how soon, everywhere (styles.css --st-*; Jonah,
  // 15 Oct 2026: "a spectrum of yellows/orange/&red" plus "a gray for 'can
  // be done whenever'"): red is late, orange today, yellow this week, grey
  // whenever. Red is kept for late -- a due date gone by -- so an urgent card
  // is orange until its day has passed.
  const URGENCY = [['urgent', '🟠 Urgent', 'today'], ['high', '🟡 High', 'this week'],
                   ['normal', 'Normal', ''], ['low', '⚪ Low', 'whenever']];
  // On the card itself urgency is said in words as well as the coloured
  // stripe -- a stripe alone means nothing to someone who never opened the
  // picker, or cannot tell red from orange. Normal says nothing.
  const URGENCY_CHIP = { urgent: '🟠 Today', high: '🟡 This week', low: '⚪ Whenever' };
  // A machine's problem already says how urgent it is, in its own words, on
  // its label ("Before next use" -- equipment.js URGENCY); its card's urgency
  // only sorts it. A second chip in the boards' words beside that label
  // ("🟠 Today") said the same thing differently (Jonah, 16 Oct 2026: "why
  // have a label and then label it something different").
  const MACHINE_URGENCY = /^u-(down|before|soon|whenever)$/;
  const urgencyLabel = (board, k) => {
    const id = (k.labels || []).find(x => MACHINE_URGENCY.test(x));
    return (id && board && (board.labels || []).find(l => l.id === id)) || null;
  };
  function urgChipHtml(k, board) {
    if (urgencyLabel(board, k)) return '';
    const w = URGENCY_CHIP[k.urgency];
    return w ? '<span class="bd-urg urg-' + k.urgency + '" title="How urgent">' + w + '</span>' : '';
  }
  // Who finished a card, and when: written by whoever may change the card
  // (doneBy / doneByName, moveCard); a crew member's move is allowed to
  // write only who moved it (firestore.rules), so theirs falls back to that.
  function doneWho(k) {
    const named = k.doneByName && k.doneByAt === k.doneAt ? k.doneByName : '';
    const who = k.doneAt ? (named || k.updatedBy || '') : '';
    // equipment.js signs the moves it makes itself 'Equipment'.
    return who === 'Equipment' ? 'the Equipment tab' : who;
  }
  function doneLine(k) {
    const who = doneWho(k);
    const t = k.doneAt ? new Date(k.doneAt) : null;
    if (!t || isNaN(t)) return who ? 'Done by ' + who : '';
    const when = localDay(t) === localDay() ? t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return (who ? 'Done by ' + who + ' · ' : 'Done · ') + when;
  }
  // A card's due time and reminder (Jonah, 9 Oct 2026: "make cards and set a
  // date on them and then they go on my calendar" -- with a time, at that
  // hour). The same choices as a calendar entry's reminder: remind.js.
  // Whether it buzzes this person's phone: its own reminder, or the usual
  // one when the card is theirs.
  const buzzes = (board, k) => !!k.due && (k.hasReminder || (YDRemind.usualFor(k) && isMineCard(board, k)));
  function clockText(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!m) return '';
    const h = +m[1];
    return (h % 12 || 12) + ':' + m[2] + (h < 12 ? ' AM' : ' PM');
  }
  const dueText = k => shortDay(k.due) + (k.dueTime ? ', ' + clockText(k.dueTime) : '');
  const urgRank = k => { const i = URGENCY.findIndex(u => u[0] === (k.urgency || 'normal')); return i === -1 ? 2 : i; };
  // A column's order: by urgency, then where people dragged them. (Due date
  // as a second key made dragging do nothing on a board with due dates --
  // the drop was worked out from a different order than the one on screen.)
  const byPlace = (a, b) => urgRank(a) - urgRank(b) || (a.order || 0) - (b.order || 0);
  const RAIN = { id: 'rainday', name: '☔ Rain day', color: '#3b82c4' };
  // Tagged for the crew: the same label id on every board (the server's
  // Pickups board uses it too), so the crew can find these cards on boards
  // they are not on -- the security rules let them read a card whose labels
  // hold 'crew'.
  const CREW_LABEL = { id: 'crew', name: '👷 Crew', color: '#c9922f' };
  const isCrewCard = k => (k.labels || []).indexOf(CREW_LABEL.id) !== -1;
  const isRainy = (board, k) => (k.labels || []).some(id => {
    const l = (board.labels || []).find(x => x.id === id);
    return id === RAIN.id || (l && /rain/i.test(l.name || ''));
  });
  let cardFilter = '';       // '' | 'urgent' | 'mine' | 'rain'
  window.setCardFilter = function (f) { cardFilter = cardFilter === f ? '' : f; render(); };
  function shows(board, k) {
    if (cardFilter === 'urgent') return ['urgent', 'high'].indexOf(k.urgency) !== -1;
    if (cardFilter === 'mine') return isMineCard(board, k);
    return true;
  }
  function filterBarHtml(board) {
    if (board.virtual) return '';
    const chip = (f, label) => '<button class="bd-filter' + (cardFilter === f ? ' on' : '') + '" onclick="setCardFilter(\'' + f + '\')">' + label + '</button>';
    return '<div class="bd-filters">' + chip('urgent', '🟠 Urgent & this week') + chip('mine', '👤 Mine') + chip('rain', '☔ Rain day') + '</div>';
  }
  // Rain-day cards from every stored board this person can see, by board.
  function rainHtml() {
    const out = Object.values(boards).filter(b => !b.virtual).sort((a, b) => (a.order || 0) - (b.order || 0)).map(b => {
      const last = doneColOf(b);
      const list = Object.values(cards[b.id] || {}).filter(k => isRainy(b, k) && colOf(b, k) !== last)
        .sort((x, y) => urgRank(x) - urgRank(y) || String(x.due || '9999').localeCompare(String(y.due || '9999')));
      return list.length ? '<div class="bd-rain-group"><div class="bd-rain-head" style="--c:' + safeColor(b.color) + '">' + esc(b.name) +
        ' <span class="bd-count">' + list.length + '</span></div><div class="bd-rain-cards">' +
        list.map(k => storedCardHtml(b, k, false)).join('') + '</div></div>' : '';
    }).join('');
    return out || '<p class="empty-msg">Nothing tagged ☔ Rain day yet. Give a card the Rain day label and it shows up here on a wet day.</p>';
  }
  // On Crew tasks: every open card tagged 👷 Crew on any other board (Jonah,
  // 6 Oct). The crew get the ones on boards they are not on through
  // loadCrewBoards below.
  function crewLaneHtml() {
    const groups = Object.values(boards).filter(b => !b.virtual && b.id !== CREW_BOARD)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(b.name || '')).map(b => {
        const last = doneColOf(b);
        const list = Object.values(cards[b.id] || {}).filter(k => isCrewCard(k) && colOf(b, k) !== last && shows(b, k))
          .sort((x, y) => urgRank(x) - urgRank(y) || String(x.due || '9999').localeCompare(String(y.due || '9999')));
        return list.length ? '<div class="bd-rain-group"><div class="bd-rain-head" style="--c:' + safeColor(b.color) + '">' + esc(b.name) +
          ' <span class="bd-count">' + list.length + '</span></div><div class="bd-rain-cards">' +
          list.map(k => storedCardHtml(b, k, false)).join('') + '</div></div>' : '';
      }).join('');
    return groups ? '<div class="bd-crew-lane"><div class="bd-crew-head">👷 Tagged Crew on other boards</div><div class="bd-rain">' +
      groups + '</div></div>' : '';
  }

  // Done cards go away (Jonah, 9 Oct 2026). A card finished today stays in
  // Done, so the day's work can be seen and a slip of the finger put back;
  // from the next day it is off the board. A card that still wants somebody
  // stays put: a recurring task waiting for its OK, a machine marked serviced
  // but not logged yet, Claude's work waiting for "Put it live".
  //
  // And they are deleted for good with "Delete all done" (Jonah, 13 Oct:
  // "i want to be able to fully delete all done cards on boards ... i dont
  // want them sitting there taking up space"). Not a card that still wants
  // somebody, not a machine's service card (it is the machine's NEXT
  // service, reset when one is logged -- not a finished job), and not this
  // period's recurring card (recurring.js would make it again, not done).
  function stillWanted(k) {
    return !!((k.recurring && !k.confirmedAt) || k.markedDoneBy ||
      (k.claude && k.claude.status === 'waiting_ok' && !k.claude.approvedAt));
  }
  function finishedToday(k) {
    const t = k.doneAt ? new Date(k.doneAt) : null;
    return !!t && !isNaN(t) && localDay(t) === localDay();
  }
  const onBoardWhenDone = k => finishedToday(k) || stillWanted(k);
  function clearable(board, k) {
    if (stillWanted(k)) return false;
    if (board.id === MAINTENANCE && String(k.id || '').indexOf('eq-') === 0) return false;
    if (k.recurring && String(k.due || '') >= localDay()) return false;
    return true;
  }
  const doneToClear = board => Object.values(cards[board.id] || {})
    .filter(k => shows(board, k) && colOf(board, k) === doneColOf(board) && clearable(board, k));

  window.deleteDoneCards = async function (boardId) {
    const board = boards[boardId];
    if (!board || board.virtual || !runsBoard(board)) return;
    const gone = doneToClear(board);
    if (!gone.length) { showToast('Nothing finished to delete'); return; }
    // Most of them are usually off the board already (finished before
    // today), so the question says how many of each -- "delete all 40" next
    // to "Nothing finished today" read as deleting things never seen.
    const today = gone.filter(onBoardWhenDone).length, before = gone.length - today;
    if (!(await ydConfirm((today ? today + ' finished today' + (before ? ', ' : '.') : '') +
                 (before ? before + ' finished before today' + (showOldDone[board.id] ? '.' : ' (not shown on the board — "Show the finished earlier" lists them).') : '') +
                 '\n\nThis cannot be undone.',
                 { title: (gone.length === 1 ? 'Delete the finished card' : 'Delete all ' + gone.length + ' finished cards') + ' on "' + board.name + '" for good?',
                   ok: gone.length === 1 ? 'Delete it' : 'Delete them', danger: true }))) return;
    if (!boards[boardId]) return;
    deleteCards(board, gone.map(k => k.id));
    showToast(gone.length + ' finished card' + (gone.length === 1 ? '' : 's') + ' deleted');
  };

  // Cards deleted for good, by "Delete all done" or a card's own 🗑. Pickup
  // cards are made by the server from store emails: the order is remembered
  // as cleared on the board, so a "still waiting" reminder for an order
  // already picked up does not put its card back (receipts.py; tidy.py does
  // the same). Kept a couple of months -- reminders come within days.
  function deleteCards(board, ids) {
    ids.forEach(id => { if (cards[board.id]) delete cards[board.id][id]; });
    Promise.resolve(window.YDDb.removeMany(ids.map(id => ['boards/' + board.id + '/cards', id])))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed to delete that' : 'Not deleted yet — will retry'));
    if (board.id === PICKUPS_BOARD && runsBoard(board)) {
      const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const keep = (board.cleared || []).filter(s => String(s).split('|')[1] >= cutoff);
      const today = localDay();
      board.cleared = keep.concat(ids.map(id => id + '|' + today));
      Promise.resolve(window.YDDb.put('boards', board.id, { cleared: board.cleared }))
        .catch(e => console.warn('[boards] cleared pickups not noted:', (e && e.code) || e));
    }
    cardsChanged();
    render();
  }

  // A card's own 🗑, right on the board (Jonah, 13 Oct: "all cards should
  // have a delete button visible without actually clicking edit"). Not on a
  // card the app would only make again: a machine's service card, a problem
  // still open on a machine (both follow the Equipment tab), or a recurring
  // task's card for the period that is still running.
  function cardDeletable(board, k, inDone) {
    const id = String(k.id || '');
    if (board.id === MAINTENANCE && (id.indexOf('eq-') === 0 || (id.indexOf('eqi-') === 0 && !inDone))) return false;
    if (k.recurring && String(k.due || '') >= localDay()) return false;
    return true;
  }
  window.bdDeleteCard = async function (boardId, cardId) {
    const board = boards[boardId];
    const k = board && (cards[boardId] || {})[cardId];
    if (!k || board.virtual || !editsBoard(board)) return;
    if (!(await ydConfirm('This cannot be undone.', { title: 'Delete "' + (k.title || 'this card') + '"?', ok: 'Delete', danger: true }))) return;
    if (!boards[boardId] || !(cards[boardId] || {})[cardId]) return;
    deleteCards(board, [cardId]);
    showToast('Card deleted');
  };

  // Done cards finished before today, shown again on asking ("Show the N
  // finished earlier"), per board, until the app is reloaded.
  const showOldDone = {};
  window.toggleOldDone = function (boardId) { showOldDone[boardId] = !showOldDone[boardId]; render(); };

  // pick: which cards to draw -- the Boards tab's filter, unless another
  // screen narrows them its own way (the Equipment tab's search).
  // waiting: things that will be cards but are not yet (the Equipment tab's
  // problems whose card the office's device has still to make), drawn among
  // the cards by urgency, in the column they will start in.
  function columnsHtml(board, pick, waiting) {
    pick = pick || (k => shows(board, k));
    if (board.virtual) {
      const grouped = jobCards(board);
      return board.columns.map(c => {
        // What the column is worth (Jonah sees the money on these two boards).
        const sum = grouped[c.id].reduce((s, j) => s + (parseMoney(j.jobPrice) || 0), 0);
        const owed = board.id === 'jobs' && c.id === 'invoiced'
          ? grouped[c.id].reduce((s, j) => s + Math.max(0, owedOf(j) || 0), 0) : 0;
        return column(board, c, grouped[c.id].map(j => jobCardHtml(board, j)), {
          empty: c.id === 'lost' ? 'Drop a lost bid here. It leaves the board, stays under Bids in My Jobs, and goes on Contacts for next season.' : '',
          total: sum ? fmtMoney(sum) + (owed ? ' · ' + fmtMoney(owed) + ' owed' : '') : '',
        });
      }).join('');
    }
    const mine = Object.values(cards[board.id] || {}).filter(pick);
    const doneId = doneColOf(board);
    // Never in the done column: what is waiting is not finished.
    const openCols = board.columns.filter(c => c.id !== doneId);
    const waitCol = k => (openCols.some(c => c.id === k.column) ? k.column : (openCols[0] || {}).id);
    const toCome = (waiting || []).filter(pick).map(k => Object.assign({}, k, { column: waitCol(k) }));
    return board.columns.map(c => {
      const inCol = mine.filter(k => colOf(board, k) === c.id).sort(byPlace);
      if (c.id !== doneId) {
        return column(board, c, inCol.concat(toCome.filter(k => k.column === c.id)).sort(byPlace)
          .map(k => (k.waiting ? waitingCardHtml(board, k) : storedCardHtml(board, k, false))));
      }
      const recent = inCol.filter(onBoardWhenDone);
      const earlier = inCol.filter(k => !onBoardWhenDone(k));
      const showing = showOldDone[board.id] && earlier.length;
      const listed = showing ? recent.concat(earlier) : recent;
      const clear = runsBoard(board) ? inCol.filter(k => clearable(board, k)).length : 0;
      return column(board, c, listed.map(k => storedCardHtml(board, k, true)), {
        count: listed.length,
        empty: earlier.length ? 'Nothing finished today' : '',
        foot: (earlier.length ? '<button class="bd-add-card bd-old-done" onclick="toggleOldDone(\'' + board.id + '\')">' +
            (showing ? 'Hide the ' + earlier.length + ' finished earlier' : 'Show the ' + earlier.length + ' finished earlier') + '</button>' : '') +
          // "Delete all 1 done" read oddly: one card is "the 1 done".
          (clear ? '<button class="bd-add-card bd-del-done" onclick="deleteDoneCards(\'' + board.id + '\')">🗑 Delete ' +
            (clear === 1 ? 'the 1' : 'all ' + clear) + ' done' + (earlier.length && !showing ? ' (incl. ' + earlier.length + ' not shown)' : '') + '</button>' : ''),
      });
    }).join('');
  }

  // Phones stack the columns one above another (≤720px, as styles.css lays
  // them out) rather than one column per screen width -- an empty first
  // column filled the whole screen. Each folds; empty ones start folded.
  const colOpen = {};       // 'board|col' -> true/false once tapped
  const phoneWide = () => !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
  // `from`: the heading tapped -- the same board can be drawn on two tabs
  // (Maintenance on the Equipment tab too), so the column is read off the
  // copy that was tapped.
  window.bdToggleCol = function (boardId, colId, from) {
    if (!phoneWide()) return;
    const key = boardId + '|' + colId;
    const head = (from && from.closest && from.closest('.bd-col')) ||
      document.querySelector('.bd-col[data-board="' + boardId + '"][data-col="' + colId + '"]');
    colOpen[key] = head ? head.classList.contains('shut') : !colOpen[key];
    render();
    document.dispatchEvent(new CustomEvent('yd-board-redraw'));
  };
  if (window.matchMedia) {
    const mq = window.matchMedia('(max-width: 720px)');
    const again = () => redrawIfVisible();
    if (mq.addEventListener) mq.addEventListener('change', again); else if (mq.addListener) mq.addListener(again);
  }

  // `more`: the count when the list holds more than cards (Done on a stored
  // board), the empty-column words, a line under the cards, and the money
  // in the column (Bids and Jobs).
  function column(board, c, cardHtml, more) {
    more = more || {};
    const n = more.count != null ? more.count : cardHtml.length;
    const key = board.id + '|' + c.id;
    const shut = phoneWide() && (key in colOpen ? !colOpen[key] : n === 0);
    return '<div class="bd-col' + (shut ? ' shut' : '') + '" data-board="' + board.id + '" data-col="' + c.id + '" ' +
        'ondragover="bdDragOver(event)" ondragleave="bdDragLeave(event)" ondrop="bdDrop(event)">' +
      '<div class="bd-col-head" onclick="bdToggleCol(\'' + safeId(board.id) + '\', \'' + safeId(c.id) + '\', this)">' +
        '<span><span class="bd-fold" aria-hidden="true">' + (shut ? '▸' : '▾') + '</span>' + esc(c.name) + '</span>' +
        '<span class="bd-count">' + n + '</span></div>' +
      (more.total ? '<div class="bd-col-total" title="What the jobs in this column are worth">' + esc(more.total) + '</div>' : '') +
      '<div class="bd-col-body">' +
        (cardHtml.join('') || '<div class="bd-empty">' + (more.empty || 'Nothing here') + '</div>') +
        (more.foot || '') +
        (editsBoard(board)
          ? '<button class="bd-add-card" onclick="addCard(\'' + board.id + '\', \'' + c.id + '\')">+ Add a card</button>' : '') +
        // Won, Lost and Paid are where jobs end up, not where they start.
        (board.virtual && movesJobs() && ['won', 'lost', 'paid'].indexOf(c.id) === -1
          ? '<button class="bd-add-card" onclick="addJobCard(\'' + board.id + '\', \'' + c.id + '\')">' +
            (board.id === 'bids' ? '+ Add a bid' : '+ Add a job') + '</button>' : '') +
      '</div>' +
    '</div>';
  }

  function hasDraft(j) {
    const e = j.estimate;
    return !!(e && ((e.work || []).length || (e.materials || []).length) && !(j.qbEstimate && j.qbEstimate.id) &&
      ['siteVisit', 'toSend'].indexOf(bidColumn(j)) !== -1);
  }
  // The customer said yes in QuickBooks (seen by the hourly check,
  // quickbooks.sweep) -- or said yes and it was already turned into an
  // invoice there -- and the bid is not booked yet.
  // (The reading is sync.js qbAccepted, shared with Home and the summaries.)
  function acceptedToBook(j) {
    return !!(window.YDSync && YDSync.qbAccepted && j.qbEstimate && YDSync.qbAccepted(j.qbEstimate)) &&
      bidColumn(j) !== 'won' && bidColumn(j) !== null;
  }
  // The customer turned the estimate down in QuickBooks (Rejected), and the
  // bid is still open here: its card asks "mark lost?", and it is never
  // chased (toChase, digest.py _bids, followup.py refuse it too).
  function turnedDown(j) {
    const c = bidColumn(j);
    return !!(window.YDSync && YDSync.qbTurnedDown && YDSync.qbTurnedDown(j.qbEstimate)) && c !== null && c !== 'won';
  }
  window.bdMarkLost = function (jobId) {
    if (!movesJobs()) return;
    moveJob(jobId, 'bids', 'lost');
  };
  // A one-tap move from a button on a job's card.
  window.bdMoveJob = function (jobId, boardId, col) {
    if (!movesJobs() || (boardId !== 'bids' && boardId !== 'jobs')) return;
    moveJob(jobId, boardId, col);
  };
  // How long a card has sat in its column, said in words, with what it means
  // on hover ("6d" alone puzzled people).
  function ageHtml(board, j, col, days, late) {
    if (days == null) return '';
    const colName = (board.columns.find(c => c.id === col) || {}).name || 'this column';
    const words = days === 0 ? 'today' : days === 1 ? '1 day' : days + ' days';
    const cold = board.id === 'bids' && late && ['sent', 'followUp'].indexOf(col) !== -1;
    return '<span class="bd-age' + (late ? ' late' : '') + '" title="' +
      esc((days === 0 ? 'Moved to ' + colName + ' today' : 'In ' + colName + ' for ' + words) +
        (cold ? ' — no answer in a fortnight, going cold' : late ? ' — late to write' : '')) + '">' +
      (cold ? '🥶 cold · ' : '') + '🕑 ' + words + '</span>';
  }
  // What a finished job's invoice says, from QuickBooks (qbInvoiceRef).
  function owedOf(j) {
    const r = j.qbInvoiceRef;
    if (!r || !r.id || r.balance == null || r.balance === '') return null;
    const n = Number(r.balance);
    return isFinite(n) ? n : null;
  }
  function jobCardHtml(board, j) {
    const since = board.id === 'bids' ? (j.bidStageAt || j.lastModified) : (j.workStageAt || j.lastModified);
    const days = daysSince(since);
    const col = board.id === 'bids' ? bidColumn(j) : workColumn(j);
    const price = parseMoney(j.jobPrice);
    const name = String(j.customerName || '').trim();
    // The address under the name -- but not the name again: a job with no
    // street, whose "address" was the customer's name, showed it twice.
    const where = [j.address, j.city].filter(Boolean).join(', ');
    const showWhere = where && where.trim().toLowerCase() !== name.toLowerCase() &&
      String(j.address || '').trim().toLowerCase() !== name.toLowerCase();
    const services = (j.serviceTypes || []).join(', ');
    // A bid nobody has touched in a fortnight is the one about to be lost;
    // one sat in "Bid to send" two days is late to write (the chase rule).
    // (Not one the customer has already answered no to in QuickBooks.)
    const late = board.id === 'bids' && !turnedDown(j) &&
      ((['sent', 'followUp'].indexOf(col) !== -1 && days >= 14) || lateToWrite(j));
    const owed = board.id === 'jobs' && col === 'invoiced' ? owedOf(j) : null;
    const inv = j.qbInvoiceRef && j.qbInvoiceRef.id ? j.qbInvoiceRef : null;
    const paidUp = owedOf(j) !== null && owedOf(j) <= 0;
    const stop = 'event.stopPropagation(); ';
    return '<div class="bd-card' + coverClass(j.cardColor) + '" draggable="true" data-board="' + board.id + '" data-card="' + j._id + '" ' +
        coverStyle(j.cardColor) +
        'ondragstart="bdDragStart(event)" ondragend="bdDragEnd(event)" ' +
        'onclick="openJobCard(\'' + board.id + '\', \'' + j._id + '\')">' +
      '<div class="bd-card-title">' + esc(j.customerName || 'Untitled job') +
        (j.estimateNumber ? ' <span class="job-num">#' + esc(j.estimateNumber) + '</span>' : '') +
        // 🌱 a job with plants (plantcare.js)
        (window.YDPlants ? YDPlants.badge(j) : '') + '</div>' +
      (showWhere ? '<div class="bd-card-line">' + esc(where) + '</div>' : '') +
      (services ? '<div class="bd-card-line muted">' + esc(services) + '</div>' : '') +
      // Finished, with plants, and the care email not done yet.
      (window.YDPlants && YDPlants.owed(j) ? '<div class="bd-card-line bd-care">🌱 Care email owed</div>' : '') +
      // Claude's draft is waiting to be checked and sent (estimate.js).
      (board.id === 'bids' && hasDraft(j) ? '<div class="bd-card-line bd-draft">✨ Estimate drafted — check it & send</div>' : '') +
      (board.id === 'bids' && acceptedToBook(j)
        ? '<div class="bd-card-line bd-draft">✅ Accepted in QuickBooks — book it</div>' : '') +
      (board.id === 'bids' && turnedDown(j)
        ? '<div class="bd-card-line bd-said-no">✖ Turned down in QuickBooks — mark lost?' +
          (movesJobs() ? ' <button type="button" class="bd-card-act" draggable="false" onclick="' + stop +
            'bdMarkLost(\'' + safeId(j._id) + '\')">Mark lost</button>' : '') + '</div>' : '') +
      // Ready to invoice: the invoice is made from the job's estimate on the
      // Job tab -- or, made already (in QuickBooks, or before the stage was
      // kept), the card belongs under Invoiced.
      (board.id === 'jobs' && col === 'toInvoice' && movesJobs()
        ? (inv ? '<div class="bd-card-line">🧾 Invoice' + (inv.docNumber ? ' #' + esc(inv.docNumber) : '') + ' is already in QuickBooks ' +
              '<button type="button" class="bd-card-act" draggable="false" onclick="' + stop +
              'bdMoveJob(\'' + safeId(j._id) + '\', \'jobs\', \'' + (paidUp ? 'paid' : 'invoiced') + '\')">' +
              (paidUp ? 'Paid off — move to Paid' : 'Move to Invoiced') + '</button></div>'
          : '<div class="bd-card-line"><button type="button" class="bd-card-act strong" draggable="false" onclick="' + stop +
              'openJobFromBoard(\'' + safeId(j._id) + '\')">🧾 Make the invoice ›</button></div>') : '') +
      (owed != null
        ? '<div class="bd-card-line bd-owed' + (owed > 0 ? '' : ' paid') + '">' + (owed > 0
            ? '🧾 ' + fmtMoney(owed) + ' still owed' + (inv && inv.docNumber ? ' on #' + esc(inv.docNumber) : '')
            : '✓ Paid in full in QuickBooks') + '</div>' : '') +
      '<div class="bd-card-foot">' +
        (price ? '<span class="bd-money">' + fmtMoney(price) + '</span>' : '') +
        ageHtml(board, j, col, days, late) +
      '</div>' +
    '</div>';
  }

  // The linked job's number. Saved on the card since 2 Oct; older cards get it
  // from the job itself, which only the owner's device has.
  function jobNumOf(k) {
    if (k.jobNum) return k.jobNum;
    if (!k.jobId || !seesJobs()) return '';
    const j = jobsList().find(x => x._id === k.jobId);
    return j ? String(j.estimateNumber || '').trim() : '';
  }

  function storedCardHtml(board, k, inLastColumn) {
    const labels = (k.labels || []).map(id => (board.labels || []).find(l => l.id === id)).filter(Boolean);
    const list = k.checklist || [];
    const done = list.filter(i => i.done).length;
    const today = localDay();
    const dueState = !k.due || inLastColumn ? '' : k.due < today ? ' late' : k.due === today ? ' today' : '';
    // The due chip says it in words too: "Late", "Today" -- not only a colour.
    const dueLabel = dueState === ' today' ? 'Today' + (k.dueTime ? ', ' + clockText(k.dueTime) : '')
      : (dueState === ' late' ? 'Late · ' : '') + dueText(k);
    const urg = ['urgent', 'high', 'low'].indexOf(k.urgency) !== -1 ? ' urg-' + k.urgency : '';
    // A card's own colour, else its kind's (remind.js): crew tasks blue,
    // bid appointments green...
    const cover = k.color || YDRemind.color(cardType(board, k)) || null;
    return '<div class="bd-card' + (inLastColumn ? ' done' : '') + urg + coverClass(cover) + '" draggable="true" ' +
        coverStyle(cover) +
        'data-board="' + board.id + '" data-card="' + k.id + '" ' +
        'ondragstart="bdDragStart(event)" ondragend="bdDragEnd(event)" ' +
        'onclick="openCardDetail(\'' + board.id + '\', \'' + k.id + '\')">' +
      (labels.length ? '<div class="bd-labels">' + labels.map(l =>
        '<span class="bd-label" style="--c:' + safeColor(l.color) + ';color:' + inkOn(safeColor(l.color)) + '">' + esc(l.name) + '</span>').join('') + '</div>' : '') +
      '<div class="bd-card-title">' + (YDRemind.icon(cardType(board, k)) ? YDRemind.icon(cardType(board, k)) + ' ' : '') +
        esc(k.title || 'Untitled') + '</div>' +
      (k.jobName ? '<div class="bd-card-line">📋 ' + esc(k.jobName) +
        (jobNumOf(k) ? ' <span class="job-num">#' + esc(jobNumOf(k)) + '</span>' : '') + '</div>' : '') +
      // Finished: said with a tick, not by striking the title through -- a
      // struck grey title in Done (or Built) was hard to read at all.
      (inLastColumn ? '<div class="bd-card-line bd-done-by"><span class="bd-done-tick">✓</span> ' +
        esc(doneLine(k) || 'Done') + '</div>' : '') +
      '<div class="bd-card-foot">' +
        (inLastColumn ? '' : urgChipHtml(k, board)) +
        (k.due ? '<span class="bd-due' + dueState + '">📅 ' + dueLabel + (buzzes(board, k) && !inLastColumn ? ' 🔔' : '') + '</span>' : '') +
        (list.length ? '<span class="bd-check' + (done === list.length ? ' all' : '') + '">☑ ' +
          done + '/' + list.length + '</span>' : '') +
        (k.notes ? '<span class="bd-note" title="Has notes">≡</span>' : '') +
        (k.recurring && typeof recurringBadge === 'function' ? recurringBadge(k, inLastColumn) : '') +
        (isOwner() && askedAgain(k) ? '<span class="bd-claude" title="Sent back to Claude with your notes">🔁</span>'
          : (isOwner() && k.claude && k.claude.status === 'done' ? '<span class="bd-claude" title="Claude did this — check it">🤖</span>' : '') +
            (isOwner() && k.claude && k.claude.status === 'needs_info' ? '<span class="bd-claude ask" title="Claude needs something from you">🤖?</span>' : '')) +
        (isOwner() && k.claude && k.claude.status === 'working' ? '<span class="bd-claude" title="Claude at home is working on this">🖥…</span>' : '') +
        (isOwner() && k.claude && k.claude.status === 'waiting_ok' && !k.claude.approvedAt ? '<span class="bd-claude ask" title="Built — waiting for your OK">🖥 OK?</span>' : '') +
        '<span class="bd-people">' + (k.assignees || []).map(a =>
          '<span class="bd-face" title="' + esc(nameOn(a)) + '">' + esc(initials(nameOn(a))) + '</span>').join('') + '</span>' +
        (editsBoard(board) && cardDeletable(board, k, inLastColumn)
          ? '<button type="button" class="bd-card-del" title="Delete this card" aria-label="Delete this card" draggable="false" ' +
            'onclick="event.stopPropagation(); bdDeleteCard(\'' + board.id + '\', \'' + k.id + '\')">🗑</button>' : '') +
      '</div>' +
    '</div>';
  }

  // Something that is not a card yet (columnsHtml's `waiting`): it looks
  // like the card it will be -- labels, title, urgency -- but says it is on
  // its way, and has nothing to drag, open or delete: there is no card to
  // move. A tap opens its machine, where it was noted.
  function waitingCardHtml(board, k) {
    const labels = (k.labels || []).map(id => (board.labels || []).find(l => l.id === id)).filter(Boolean);
    const urg = ['urgent', 'high', 'low'].indexOf(k.urgency) !== -1 ? ' urg-' + k.urgency : '';
    const go = k.equipmentId ? 'if (window.openEquipment) openEquipment(\'' + safeId(k.equipmentId) + '\')' : '';
    return '<div class="bd-card bd-waiting' + urg + '"' +
        (go ? ' role="button" tabindex="0" onclick="' + go + '" onkeydown="if (event.key === \'Enter\') { ' + go + ' }"' : '') +
        ' title="Saved on the machine. Its card is made on the board by Jonah’s Job Hub the next time it is open — until then it shows here.">' +
      (labels.length ? '<div class="bd-labels">' + labels.map(l =>
        '<span class="bd-label" style="--c:' + safeColor(l.color) + ';color:' + inkOn(safeColor(l.color)) + '">' + esc(l.name) + '</span>').join('') + '</div>' : '') +
      '<div class="bd-card-title">' + esc(k.title || 'Untitled') + '</div>' +
      '<div class="bd-card-line bd-wait-line">⏳ Saved on the machine — its card is on its way</div>' +
      '<div class="bd-card-foot">' + urgChipHtml(k, board) + (k.notes ? '<span class="bd-note" title="Has notes">≡</span>' : '') + '</div>' +
    '</div>';
  }

  function personName(uid) {
    const p = people[uid];
    return p ? (p.name || p.email || 'Worker') : '';
  }
  // The name someone goes by now. A card keeps the name it was given when
  // they were put on it, which is only the fallback (a crew phone cannot read
  // other people's records) -- so a rename on Your Crew shows on every card.
  const nameOn = a => personName(a.uid) || a.name || 'Worker';

  // Colours come from a fixed palette, but they are also read back out of the
  // database and dropped into a style attribute -- so anything that is not a
  // plain hex colour is refused rather than trusted.
  function safeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#6b7a8f';
  }

  // A card can be colour-coded: a band of colour across its top, the way
  // Trello does it, so a list can be read by colour at a glance.
  const hasCover = c => /^#[0-9a-fA-F]{3,8}$/.test(String(c || ''));
  const coverClass = c => (hasCover(c) ? ' covered' : '');
  const coverStyle = c => (hasCover(c) ? 'style="--cover:' + c + '" ' : '');

  // The colour choice in the card editor and on a job's card: none, or one of
  // the board palette.
  function colorPickHtml(name, current) {
    return '<div class="bd-swatches">' +
      '<label class="bd-swatch none" title="No colour"><input type="radio" name="' + name + '" value=""' +
        ' aria-label="No colour"' + (hasCover(current) ? '' : ' checked') + '><span></span></label>' +
      PALETTE.map(c => '<label class="bd-swatch" style="--c:' + c + '" title="' + colorName(c) + '"><input type="radio" name="' + name +
        '" value="' + c + '" aria-label="' + colorName(c) + '"' + (current === c ? ' checked' : '') + '><span></span></label>').join('') +
    '</div>';
  }
  function pickedColor(name) {
    const r = document.querySelector('input[name="' + name + '"]:checked');
    return r && hasCover(r.value) ? r.value : '';
  }

  // Each device remembers which board it was last looking at.
  function rememberedBoard(list) {
    let id = null;
    try { id = localStorage.getItem('ydjobhub_board'); } catch (e) {}
    return (id && list.some(b => b.id === id)) ? id : list[0].id;
  }
  window.showBoard = function (id) {
    current = id;
    try { localStorage.setItem('ydjobhub_board', id); } catch (e) {}
    render();
  };

  // ---------------------------------------------------------- drag and drop
  //
  // Mouse dragging on a laptop. Phones do not fire these events reliably, so
  // every card can also be moved from the sheet that opens when it is tapped --
  // which is the better way on a small screen anyway.

  window.bdDragStart = function (e) {
    const c = e.currentTarget;
    dragging = { boardId: c.dataset.board, cardId: c.dataset.card };
    c.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', dragging.cardId); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
  };
  window.bdDragEnd = function (e) {
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.bd-col.over').forEach(c => c.classList.remove('over'));
    dragging = null;
  };
  window.bdDragOver = function (e) {
    if (!dragging || dragging.boardId !== e.currentTarget.dataset.board) return;
    if (!canMove(dragging.boardId)) return;
    e.preventDefault();
    e.currentTarget.classList.add('over');
  };
  window.bdDragLeave = function (e) {
    if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('over');
  };
  window.bdDrop = function (e) {
    e.preventDefault();
    const col = e.currentTarget;
    col.classList.remove('over');
    if (!dragging || dragging.boardId !== col.dataset.board) return;
    const { boardId, cardId } = dragging;
    dragging = null;
    // Work out which card it was dropped above, so the order sticks.
    // (Not one still on its way -- it is not a card to drop beside.)
    const siblings = Array.from(col.querySelectorAll('.bd-card:not(.bd-waiting)')).filter(c => c.dataset.card !== cardId);
    const before = siblings.find(c => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    moveByHand(boardId, cardId, col.dataset.col, before ? before.dataset.card : null);
  };

  function canMove(boardId) {
    if (boardId === 'bids' || boardId === 'jobs') return movesJobs();
    // Anyone a board is shared with moves its cards. Seeing every board (an
    // admin's "Boards: see") is not the same as being on one.
    const b = boards[boardId], mine = (me() || {}).uid;
    return editsBoards() || !!(b && (b.visibleTo || []).indexOf(mine) !== -1);
  }

  // Who finished a card (the card says "Done by <name> · 3:12 PM"): set
  // when it reaches Done, cleared when it leaves. Only by someone allowed to
  // change the card -- a crew member on a shared board may move a card but
  // write nothing else (firestore.rules), and a refused write would lose the
  // move itself. Their name is still the card's updatedBy (doneWho).
  // `wasDone` / `nowDone`: in the done column before and after; `doneAt`:
  // the finish time the same write gives the card. doneByAt ties the name to
  // that finish -- a crew member who cannot clear the name may move the card
  // out and back in, and a name left from the time before must not show.
  function doneByPatch(board, k, wasDone, nowDone, doneAt) {
    if (!editsBoard(board) || wasDone === nowDone) return {};
    if (nowDone) return { doneBy: (me() || {}).uid || null, doneByName: myName() || null, doneByAt: doneAt || null };
    return k.doneBy || k.doneByName ? { doneBy: null, doneByName: null, doneByAt: null } : {};
  }

  // Moves a card, and says what happened: { toDone (it has just reached
  // the done column), more (a window was opened to finish it off: a
  // machine's service form, a recurring task's OK) }, or null when it did
  // not move. A person's move goes through moveByHand below.
  function moveCard(boardId, cardId, col, beforeId) {
    if (boardId === 'bids' || boardId === 'jobs') { moveJob(cardId, boardId, col); return null; }
    const set = cards[boardId] || {};
    const k = set[cardId];
    const board = boards[boardId];
    if (!k || !board) return null;
    // Cards with no column sit in the first one on screen, so they count
    // there too -- otherwise a card dropped among them was placed as if the
    // column were empty.
    // A column is drawn by urgency, then by this order -- so a card is placed
    // among the cards of its own urgency. Dropped among less urgent ones it
    // goes last of its own; among more urgent ones, first.
    const rank = urgRank(k);
    const inCol = Object.values(set)
      .filter(x => x.id !== cardId && colOf(board, x) === col && urgRank(x) === rank).sort(byPlace);
    const target = beforeId ? set[beforeId] : null;
    let order;
    const idx = !target || colOf(board, target) !== col ? -1
      : urgRank(target) === rank ? inCol.indexOf(target)
      : urgRank(target) > rank ? -1 : 0;
    if (idx === -1 || !inCol.length) order = inCol.length ? (inCol[inCol.length - 1].order || 0) + 1000 : 1000;
    else if (idx === 0) order = (inCol[0].order || 0) - 1000;
    else order = ((inCol[idx - 1].order || 0) + (inCol[idx].order || 0)) / 2;
    if (k.column === col && k.order === order) return null;

    const last = doneColOf(board);
    const patch = { column: col, order: order, updatedAt: nowIso(), updatedBy: myName() };
    // Reaching the Done column is "done"; leaving it is "not done any more".
    const toDone = col === last && k.column !== last;
    patch.doneAt = col === last ? (k.doneAt || nowIso()) : null;
    Object.assign(patch, doneByPatch(board, k, colOf(board, k) === last, col === last, patch.doneAt));
    Object.assign(k, patch);
    render();
    if (openCard && openCard.cardId === cardId) renderCardDetail();
    writeCard(boardId, cardId, patch);
    // The calendar and Home show cards too: told now, not only when the
    // write comes back from the database.
    cardsChanged();
    let more = false;
    // A machine's "service due" card moved to Done: the service is logged on
    // the machine, with its hours or miles, so nothing is typed twice
    // (WISHLIST #2). Problem cards record themselves (equipment.js).
    // Only a service card (eq-<machine>): a problem or a card added in the
    // shop (eqc-) for that machine is not its service.
    if (toDone && boardId === MAINTENANCE && String(cardId).indexOf('eq-') === 0 && k.equipmentId && !k.issueId &&
        window.YDEquipment && YDEquipment.serviceFromBoard) {
      YDEquipment.serviceFromBoard(k.equipmentId);
      more = true;
    }
    // A recurring task moved to Done by someone who confirms them (the owner,
    // an admin) is confirmed there and then -- otherwise it sat in Done
    // waiting for an OK from the very person who moved it, and was in every
    // summary as not confirmed (recurring.js).
    if (toDone && k.recurring && !k.confirmedAt && editsBoards() &&
        typeof window.confirmRecurring === 'function') {
      window.confirmRecurring(cardId, boardId);
      more = true;
    }
    return { toDone: toDone, more: more };
  }

  // ------------------------------------------------- moved by a person
  //
  // A drag, the card window's "Move to", a tick on the calendar or on Home
  // -- never the app keeping boards in step, which calls moveCard itself.
  // Two things only a person's move gets:
  //   - a card going to Done with its checklist not all ticked asks first
  //     (crew testing, 16 Oct 2026: "☑ 0/2" went to Done without a word);
  //   - a card that goes off the screen as it is done -- one in "Tagged Crew
  //     on other boards" on Crew tasks, one in the Rain day view -- leaves
  //     an Undo behind. It lives on another board, one a crew member may not
  //     even see, and once the card window closed there was no way back to
  //     it. A card that stays in sight in Done needs none: it is put back
  //     the way it went. Nor one whose move opened a window to finish it
  //     (a machine's service form, a recurring task's OK).
  // Resolves true when it moved (or was handed on to be moved).
  async function moveByHand(boardId, cardId, col, beforeId) {
    if (boardId === 'bids' || boardId === 'jobs') { moveCard(boardId, cardId, col, beforeId); return true; }
    let board = boards[boardId], k = (cards[boardId] || {})[cardId];
    if (!board || !k) return false;
    const last = doneColOf(board);
    const doneName = (board.columns.find(c => c.id === last) || {}).name || 'Done';
    if (last && col === last && colOf(board, k) !== last && !(await checklistOk(k, doneName))) return false;
    // As it is now: it may have changed, or gone, while that was asked.
    board = boards[boardId]; k = (cards[boardId] || {})[cardId];
    if (!board || !k) return false;
    const was = { column: colOf(board, k), order: k.order };
    const seen = onScreen(boardId, cardId);
    const r = moveCard(boardId, cardId, col, beforeId);
    if (r && r.toDone && !r.more && seen && !onScreen(boardId, cardId)) {
      const say = '“' + shortTitle(k.title) + '” moved to ' + doneName + ' on ' + (board.name || 'its board');
      if (typeof showUndo === 'function') showUndo(say, () => undoDone(boardId, cardId, was), 9000);
      else showToast(say);
    }
    return true;
  }
  const shortTitle = t => { t = String(t || '').trim() || 'The card'; return t.length > 40 ? t.slice(0, 38) + '…' : t; };
  // Whether the card is drawn on the screen in front -- the Boards tab, or
  // the Equipment tab's shop board.
  function onScreen(boardId, cardId) {
    return Array.from(document.querySelectorAll('.bd-card')).some(n =>
      n.dataset.board === boardId && n.dataset.card === cardId && !!n.closest('.tab-panel.active'));
  }
  // Asked once, as the card goes to Done (the board's own done column,
  // `doneName`: Done, Bought, Picked up...), when its checklist is not all
  // ticked: "2 of 2 checklist items aren't ticked". True to go ahead.
  async function checklistOk(k, doneName) {
    const list = (Array.isArray(k.checklist) ? k.checklist : []).filter(Boolean);
    const open = list.filter(i => !i.done).length;
    if (!open) return true;
    return !!(await ydConfirm(open + ' of ' + list.length + ' checklist item' + (list.length === 1 ? '' : 's') +
        ' on “' + shortTitle(k.title) + '” ' + (open === 1 ? 'isn’t' : 'aren’t') + ' ticked.',
      { title: 'Move it to ' + (doneName || 'Done') + ' anyway?', ok: 'Move it', cancel: 'Not yet' }));
  }
  // The Undo: back to the column it came from, where it was in it, not done
  // -- unless it has been moved on (or deleted) since.
  function undoDone(boardId, cardId, was) {
    const board = boards[boardId], k = board && (cards[boardId] || {})[cardId];
    if (!k) { showToast('That card is not there any more'); return; }
    if (colOf(board, k) !== doneColOf(board)) return;
    const patch = { column: was.column, doneAt: null, updatedAt: nowIso(), updatedBy: myName() };
    // A card never placed had no order; the one it was given stays.
    if (typeof was.order === 'number' && isFinite(was.order)) patch.order = was.order;
    Object.assign(patch, doneByPatch(board, k, true, false, null));
    Object.assign(k, patch);
    render();
    if (openCard && openCard.cardId === cardId) renderCardDetail();
    writeCard(boardId, cardId, patch);
    cardsChanged();
    showToast('Put back in ' + ((board.columns.find(c => c.id === was.column) || {}).name || 'its column'));
  }

  // ------------------------------------------------------------- job cards

  window.openJobCard = function (boardId, jobId) {
    const board = boardById(boardId);
    const j = jobsList().find(x => x._id === jobId);
    if (!board || !j) return;
    const col = boardId === 'bids' ? bidColumn(j) : workColumn(j);
    const reach = [j.phone ? '<a href="tel:' + esc(String(j.phone).replace(/[^0-9+]/g, '')) + '">' + esc(j.phone) + '</a>' : '',
                   looksLikeEmail(j.email) ? '<a href="mailto:' + esc(j.email) + '">' + esc(j.email) + '</a>' : ''].filter(Boolean);
    openModal(esc(j.customerName || 'Job'),
      '<div class="bd-detail-sub">' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</div>' +
      (reach.length ? '<div class="bd-detail-line">' + reach.join(' · ') + '</div>' : '') +
      ((j.serviceTypes || []).length ? '<div class="bd-detail-line">' + esc(j.serviceTypes.join(', ')) + '</div>' : '') +
      (parseMoney(j.jobPrice) ? '<div class="bd-detail-line bold">' + fmtMoney(parseMoney(j.jobPrice)) + '</div>' : '') +
      // Its plants and the care email they owe, with the buttons that settle it.
      (window.YDPlants ? YDPlants.sheetHtml(jobId, j) : '') +
      '<div class="bd-move-label">Move to</div>' +
      '<div class="bd-move">' + board.columns.map(c =>
        '<button class="bd-move-btn' + (c.id === col ? ' on' : '') + '" style="--c:' + safeColor(board.color) + '" ' +
        (c.id === col ? 'disabled' : 'onclick="moveJobFromSheet(\'' + jobId + '\', \'' + boardId + '\', \'' + c.id + '\')"') +
        '>' + esc(c.name) + '</button>').join('') + '</div>' +
      '<div class="bd-move-label">Card colour</div>' +
      '<div onchange="setJobCardColor(\'' + safeId(jobId) + '\')">' + colorPickHtml('jcColor', j.cardColor) + '</div>' +
      '<div class="field-actions">' +
        (movesJobs() ? '<button class="btn btn-filled" onclick="editJobCard(\'' + boardId + '\', \'' + safeId(jobId) + '\')">Edit</button>' : '') +
        '<button class="btn' + (movesJobs() ? ' btn-sm' : ' btn-filled') + '" onclick="openJobFromBoard(\'' + jobId + '\')">' +
          (boardId === 'bids' ? 'Open the bid' : 'Open the job') + '</button>' +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Close</button>' +
      '</div>');
  };

  // Editing a bid or job from its card (Jonah, 9 Oct 2026: "bid cards need
  // to be editable"): who, where, how to reach them, what work, the notes --
  // and on a bid the site-visit notes Claude builds the estimate from. Saved
  // to the job itself through patchJob, like a move, so every device and the
  // Job tab follow. The estimate and the money stay on the Job tab.
  let jobEdit = null;       // { boardId, jobId, services } while the editor is open
  function serviceChoices() {
    const sel = el('serviceTypeSelect');
    return sel ? Array.prototype.filter.call(sel.options, o => o.value && o.value !== '__custom').map(o => o.value) : [];
  }
  function jobEditTags() {
    const w = el('jeTags');
    if (!w) return;
    w.innerHTML = jobEdit.services.length
      ? jobEdit.services.map((s, i) => '<span class="svc-tag">' + esc(s) +
          '<button onclick="jobEditTagOff(' + i + ')" title="Remove">&times;</button></span>').join('')
      : '<span class="tag-none">No services yet</span>';
  }
  window.editJobCard = function (boardId, jobId) {
    const j = jobsList().find(x => x._id === jobId);
    if (!j || !movesJobs()) return;
    // The site-visit notes as they were when this opened: saving compares
    // with these, so notes changed meanwhile on the Job tab (or Claude's
    // estimate run) are not written over by an untouched box here.
    jobEdit = { boardId: boardId, jobId: jobId, services: (j.serviceTypes || []).slice(),
                siteWas: String(((j.estimate || {}).notes) || '').trim() };
    const nm = (j.firstName || j.lastName || j.business) ? { first: j.firstName, last: j.lastName, business: j.business }
      : (typeof splitName === 'function' ? splitName(j.customerName) : { first: '', last: '', business: j.customerName });
    const box = (id, label, v, attrs) => '<div class="field"><span class="label">' + label + '</span>' +
      '<input id="' + id + '" value="' + esc(v || '') + '"' + (attrs || '') + '></div>';
    const bid = boardId === 'bids';
    openModal(bid ? 'Edit the bid' : 'Edit the job',
      '<div class="grid g2">' + box('jeFirst', 'First name', nm.first, ' autocomplete="off"') +
        box('jeLast', 'Last name', nm.last, ' autocomplete="off"') + '</div>' +
      box('jeBusiness', 'Business name (if a business)', nm.business, ' autocomplete="off"') +
      box('jeStreet', 'Street address', j.address, ' autocomplete="off"') +
      '<div class="grid g3">' + box('jeCity', 'City', j.city) + box('jeState', 'State', j.state) +
        box('jeZip', 'ZIP', j.zip, ' inputmode="numeric"') + '</div>' +
      '<div class="grid g2">' + box('jePhone', 'Phone', j.phone, ' type="tel"') +
        box('jeEmail', 'Email', j.email, ' type="email" autocapitalize="off"') + '</div>' +
      '<div class="field"><span class="label">Services</span><div class="tag-box" id="jeTags"></div>' +
        '<select id="jeTagPick" onchange="jobEditTagOn(this)" style="margin-top:6px"><option value="">+ Add a service…</option>' +
          serviceChoices().map(s => '<option>' + esc(s) + '</option>').join('') +
          '<option value="__custom">Something else…</option></select></div>' +
      (bid ? '<div class="field"><span class="label">Site-visit notes</span>' +
        '<textarea id="jeSite" rows="5" placeholder="What you saw, measured and talked about — Claude builds the estimate from these">' +
        esc(((j.estimate || {}).notes) || '') + '</textarea></div>' : '') +
      '<div class="field"><span class="label">Notes</span><textarea id="jeNotes" rows="3">' + esc(j.notes || '') + '</textarea></div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveJobCard()">Save</button>' +
        '<button class="btn btn-sm" onclick="openJobCard(\'' + boardId + '\', \'' + safeId(jobId) + '\')">Cancel</button>' +
      '</div>');
    jobEditTags();
  };
  window.jobEditTagOn = async function (sel) {
    let v = sel.value;
    sel.value = '';
    if (!v || !jobEdit) return;
    if (v === '__custom') {
      const was = jobEdit;
      v = (await ydPrompt('The service, in a word or two:', '', { title: 'Add a service', placeholder: 'e.g. Gutter cleaning', ok: 'Add' }) || '').trim();
      if (!v || jobEdit !== was) return;
    }
    if (jobEdit.services.indexOf(v) === -1) jobEdit.services.push(v);
    jobEditTags();
  };
  window.jobEditTagOff = function (i) { if (jobEdit) { jobEdit.services.splice(i, 1); jobEditTags(); } };
  window.saveJobCard = function () {
    if (!jobEdit || !movesJobs() || !window.YDSync) return;
    const { boardId, jobId, siteWas } = jobEdit;
    const first = val('jeFirst'), last = val('jeLast'), business = val('jeBusiness');
    const name = business || [first, last].filter(Boolean).join(' ');
    if (!name) { showToast('Give it the customer’s name'); return; }
    // The same job open on the Job tab with typing not yet saved: saved
    // first, so this lands on top of it -- otherwise the form's next save
    // would write the old name and address straight back.
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId &&
        typeof dirty !== 'undefined' && dirty && typeof autosave === 'function') autosave();
    const j = jobsList().find(x => x._id === jobId);
    if (!j) return;
    const patch = {
      customerName: name, firstName: first, lastName: last, business: business,
      address: val('jeStreet'), city: val('jeCity'), state: val('jeState'), zip: val('jeZip'),
      phone: val('jePhone'), email: val('jeEmail'),
      serviceTypes: jobEdit.services.slice(), notes: (el('jeNotes').value || '').trim(),
    };
    const site = el('jeSite');
    if (site && site.value.trim() !== siteWas) {
      // Only the notes change, on the estimate as it is now. A bid with no
      // estimate yet gets one in the current shape (estimate.js fromSaved, v 2).
      patch.estimate = j.estimate ? Object.assign({}, j.estimate, { notes: site.value.trim() })
        : { v: 2, notes: site.value.trim() };
    }
    if (!window.YDSync.patchJob(jobId, patch)) { showToast('Could not save that'); return; }
    jobEdit = null;
    render();
    window.openJobCard(boardId, jobId);
    showToast(name + ' saved');
  };
  // Kept on the job itself, through the same path as a move, so the colour
  // shows on every device and survives the next save of the job form.
  window.setJobCardColor = function (jobId) {
    if (!movesJobs() || !window.YDSync) return;
    if (!window.YDSync.patchJob(jobId, { cardColor: pickedColor('jcColor') })) {
      showToast('Could not change that card');
      return;
    }
    render();
  };
  window.moveJobFromSheet = function (jobId, boardId, col) {
    closeBoardModal();
    moveJob(jobId, boardId, col);
  };
  window.openJobFromBoard = async function (jobId) {
    closeBoardModal();
    // Already the job in the form: just go to it. Loading it again would read
    // the saved copy over whatever has been typed and not yet saved.
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId) { switchTab('job'); return; }
    if (!(await ydLeaveUnsavedJob())) return;
    if (typeof loadJob === 'function') loadJob(jobId);
    switchTab('job');
  };

  // A card on Bids or Jobs IS a job, so adding one makes the job: the
  // customer's name, in the column it was added to, then its editor for the
  // rest. The estimate is built on the Job tab ("Open the bid").
  window.addJobCard = async function (boardId, col) {
    const board = boardById(boardId);
    if (!board || !board.virtual || !movesJobs() || typeof createJobRecord !== 'function') return;
    const name = await ydPrompt('The customer’s name — the rest comes next.', '',
      { title: boardId === 'bids' ? 'Who is the bid for?' : 'Who is the job for?', placeholder: 'Customer name', ok: 'Add' });
    if (!name || !name.trim()) return;
    const at = nowIso();
    const fields = { customerName: name.trim() };
    if (boardId === 'bids') {
      Object.assign(fields, { bidStage: col, bidStageAt: at, jobStatus: 'quoting' });
    } else {
      Object.assign(fields, { workStage: col, workStageAt: at,
        jobStatus: col === 'scheduled' ? 'booked' : ACTIVE_STAGES.indexOf(col) !== -1 ? 'inprogress' : 'complete' });
      // Added already finished: when, for a care email if it turns out to
      // have plants (plantcare.js).
      if (fields.jobStatus === 'complete') fields.completedAt = at;
    }
    const id = createJobRecord(fields);
    if (!id) return;
    render();
    showToast(name.trim() + ' added to ' + board.columns.find(c => c.id === col).name);
    // Straight into its details: address, phone, the work, site-visit notes.
    window.editJobCard(boardId, id);
  };

  // ----------------------------------------------------------- stored cards

  window.addCard = function (boardId, col) {
    if (!editsBoard(boards[boardId])) return;
    openCard = { boardId: boardId, cardId: '', column: col };
    renderCardEditor();
  };

  window.openCardDetail = function (boardId, cardId) {
    openCard = { boardId: boardId, cardId: cardId };
    renderCardDetail();
  };

  function renderCardDetail() {
    const board = boards[openCard.boardId];
    const k = board && (cards[board.id] || {})[openCard.cardId];
    if (!k) { closeBoardModal(); return; }
    const labels = (k.labels || []).map(id => (board.labels || []).find(l => l.id === id)).filter(Boolean);
    const list = k.checklist || [];
    const here = colOf(board, k);
    const type = YDRemind.typeById(cardType(board, k));
    // The usual reminder only for a card that is this person's (remind.js).
    const remind = !k.due ? '' : YDRemind.line(k, type ? type.id : '', !!k.dueTime, isMineCard(board, k));
    // Jonah (12 Oct 2026): a button that makes it a crew task, "so every
    // profile marked as a crew member can view it" -- the 👷 Crew tag, which
    // the crew can read from any board that is not private.
    const crewTask = !!(type && type.crew);
    const crewBtn = !editsBoard(board) || board.id === CREW_BOARD ? ''
      : '<button class="btn btn-sm" onclick="cardCrewTask(' + (crewTask ? 'false' : 'true') + ')">' +
          (crewTask ? 'Not a crew task' : '👷 Make it a crew task') + '</button>';
    const inDone = here === doneColOf(board);
    openModal(esc(k.title || 'Card'),
      // Whoever may change the card opens it mostly to change it: Edit is
      // the first thing in the window, and big -- it sat at the foot, under
      // the checklist, the columns and Claude. Moving it, ticking the
      // checklist and the rest stay below, a tap each, as before.
      (editsBoard(board) ? '<div class="bd-detail-top">' +
        '<button class="btn btn-filled bd-edit-big" onclick="editCard()">✏️ Edit this card</button>' + crewBtn + '</div>' : '') +
      (labels.length ? '<div class="bd-labels big">' + labels.map(l =>
        '<span class="bd-label" style="--c:' + safeColor(l.color) + ';color:' + inkOn(safeColor(l.color)) + '">' + esc(l.name) + '</span>').join('') + '</div>' : '') +
      '<div class="bd-detail-meta">' +
        '<span>📌 ' + esc(board.name) + '</span>' +
        (type ? '<span>' + type.icon + ' ' + esc(type.name) + '</span>' : '') +
        (k.due ? '<span>📅 ' + dueText(k) + (remind ? ' · ' + esc(remind.replace('Reminder: ', '')) : '') + '</span>' : '') +
        ((k.assignees || []).length ? '<span>👤 ' + k.assignees.map(a => esc(nameOn(a))).join(', ') + '</span>' : '') +
        (k.jobName ? '<span>📋 ' + esc(k.jobName) + (jobNumOf(k) ? ' #' + esc(jobNumOf(k)) : '') + '</span>' : '') +
      '</div>' +
      (k.notes ? '<div class="bd-notes">' + esc(k.notes) + '</div>' : '') +
      (list.length ? '<div class="bd-move-label">Checklist</div><div class="bd-checklist">' +
        list.map(i => '<label class="chk bd-chk"><input type="checkbox"' + (i.done ? ' checked' : '') +
          ' onchange="toggleCheck(\'' + i.id + '\', this.checked)"><span' + (i.done ? ' class="struck"' : '') + '>' +
          esc(i.text) + '</span></label>').join('') + '</div>' : '') +
      '<div class="bd-move-label">Move to</div>' +
      '<div class="bd-move">' + board.columns.map(c =>
        '<button class="bd-move-btn' + (c.id === here ? ' on' : '') + '" style="--c:' + safeColor(board.color) + '" ' +
        (c.id === here ? 'disabled' : 'onclick="moveCardFromSheet(\'' + c.id + '\')"') +
        '>' + esc(c.name) + '</button>').join('') + '</div>' +
      (inDone && doneLine(k) ? '<div class="hint">' + esc(doneLine(k)) + '</div>'
        : k.updatedBy ? '<div class="hint">Last moved by ' + esc(k.updatedBy) + '</div>' : '') +
      (k.recurring && typeof recurringDetail === 'function'
        ? recurringDetail(k, inDone, board.id) : '') +
      claudeHtml(board, k) +
      '<div class="field-actions">' +
        claudeAskHtml(board, k) +
        // Delete here too, beside Close: the card's own 🗑 on the board is
        // small, and this is where a card is looked at. Not on a card the
        // app would only make again (cardDeletable).
        (editsBoard(board) && cardDeletable(board, k, inDone)
          ? '<button class="btn btn-sm" onclick="bdDeleteOpen()">🗑 Delete</button>' : '') +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Close</button>' +
      '</div>');
  }
  // The card open in the window, deleted (with the same question as its 🗑).
  window.bdDeleteOpen = async function () {
    if (!openCard) return;
    const b = openCard.boardId, c = openCard.cardId;
    await bdDeleteCard(b, c);
    if (!(cards[b] || {})[c]) closeBoardModal();
  };

  // Making a card a crew task tags it 👷 Crew (every crew member can read a
  // card with that tag on a board that is not private) and drops any other
  // kind it was given; undoing takes both off.
  window.cardCrewTask = function (on) {
    const board = openCard && boards[openCard.boardId];
    const k = board && (cards[board.id] || {})[openCard.cardId];
    if (!k || !editsBoard(board)) return;
    if (on && board.ownerOnly === true) {
      showToast(board.name + ' is private, so the crew cannot see it — move the card to another board first');
      return;
    }
    const labels = (k.labels || []).filter(id => id !== CREW_LABEL.id);
    if (on) labels.push(CREW_LABEL.id);
    const type = on ? null : (k.type === 'crew' ? null : (k.type || null));
    const patch = { labels: labels, type: type, updatedAt: nowIso(), updatedBy: myName() };
    Object.assign(k, patch);
    render(); renderCardDetail();
    writeCard(board.id, k.id, patch);
    showToast(on ? 'A crew task now — every crew member can see it' : 'Not a crew task any more');
  };

  // ------------------------------------------------- Claude on the cards
  //
  // Two Claudes work the cards. The server does it at 7 am and 7 pm
  // (research, writing, emails left in Gmail Drafts -- never sent). When
  // the owner leaves the computer at home on, Claude there checks every 20
  // minutes instead and can do more: websites, documents, and changes to Job
  // Hub itself -- which it builds and then waits for "Put it live". The
  // computer says it is awake in settings/homeComputer; while it is, the
  // server leaves the cards to it. What either did is kept on the card as
  // `claude` (`by: 'computer'` for the one at home). Only the owner sees this
  // and steers it: the work can name customers and prices.
  //
  // Both are switched off for now (Jonah, 9 Oct: not enough on the boards
  // yet, more useful next year): the server works cards by itself only while
  // settings/claude.cardRuns is true (Pricing rules -> Claude), and the
  // computer's 20-minute task is paused. "Ask Claude now" still works.
  const COMPUTER_AWAKE_MIN = 45;

  // When the computer at home last checked in, and whether the card runs
  // are on. Read now and then rather than watched: only the owner's screen
  // shows them.
  let homeComputer = null, homeComputerAt = 0, cardRuns = false;
  function computerAwake() {
    const t = homeComputer && Date.parse(homeComputer.lastSeenAt || '');
    return !!t && Date.now() - t < COMPUTER_AWAKE_MIN * 60000;
  }
  function refreshComputer() {
    if (!isOwner() || !window.YDDb || Date.now() - homeComputerAt < 60000) return;
    homeComputerAt = Date.now();
    Promise.all([window.YDDb.get('settings', 'homeComputer'), window.YDDb.get('settings', 'claude')])
      .then(([d, c]) => { homeComputer = d; cardRuns = !!(c && c.cardRuns === true); redrawIfVisible(); })
      .catch(() => {});
  }
  function computerLine() {
    // With the card runs off, "the computer is off" is no news.
    if (!isOwner() || !homeComputer || !homeComputer.lastSeenAt || (!cardRuns && !computerAwake())) return '';
    const t = new Date(homeComputer.lastSeenAt);
    const when = t.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return '<div class="bd-computer' + (computerAwake() ? ' on' : '') + '">🖥 ' +
      (computerAwake() ? 'Computer at home is on — last checked the cards ' : 'Computer at home is off — last on ') +
      esc(when) + '</div>';
  }

  // The Claude part of a card shows while Claude works the cards by itself
  // (the runs switched on, or the computer at home checking in), or once
  // Claude has done something on this card. With the runs off -- as they are
  // (Jonah, 9 Oct) -- a box on every card explaining that was only clutter:
  // what is left is one small "Ask Claude" beside Close (claudeAskHtml),
  // which works as it always did.
  const claudeOwns = (board, k) => isOwner() && !board.virtual && board.id !== MAINTENANCE && !k.auto;
  // The wish board is worked by Claude on the computer at home at the night
  // run (the nightly-wishes task, midnight after each weekday): what is on it
  // are changes to Job Hub itself, which the server never builds (cards.py
  // SKIP_BOARDS). Every other board is the server's, which answers "Ask
  // Claude now" at once.
  const NIGHT_BOARD = 'wishes';
  const atNight = board => !!board && board.id === NIGHT_BOARD;
  const claudeShown = (board, k) => atNight(board) || cardRuns || computerAwake() || !!k.claude ||
    (k.claudeTalk || []).length > 0;
  function claudeAskHtml(board, k) {
    if (!claudeOwns(board, k) || claudeShown(board, k) || k.noClaude || colOf(board, k) === doneColOf(board)) return '';
    return '<button class="btn btn-sm" onclick="claudeNow()">🤖 Ask Claude to do it</button>';
  }

  // The conversation on a card. Jonah, 16 Oct 2026: "after you do them i can
  // add notes and then ask you to do again so you can see what you did last
  // time, the notes you gave me, and my new notes." `claudeTalk` keeps every
  // round Claude finished and every note he sent it, oldest first; whoever
  // works the card next (cards.py, the nightly task) reads all of it and adds
  // its own round. "Send" here adds his note and asks again (claudeAskedAt).
  // "Ask Claude again" used to clear what Claude did; nothing is cleared now.
  const TALK_KEEP = 30;              // entries kept on a card, the newest
  const TALK_SHOWN = 3;              // shown before "Show the N earlier"
  const timeOf = s => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
  function talkOf(k) {
    const talk = Array.isArray(k.claudeTalk) ? k.claudeTalk.filter(t => t && t.from) : [];
    const c = k.claude;
    // A round written before the conversation was kept (or by a runner that
    // writes only `claude`) is still Claude's latest word: it shows, and the
    // first note sent keeps it in the conversation.
    if (c && c.status && c.status !== 'working' && (c.result || c.summary) &&
        !talk.some(t => t.from === 'claude' && timeOf(t.at) === timeOf(c.at))) {
      talk.push({ id: 'cl' + timeOf(c.at).toString(36), from: 'claude', by: c.by || '', at: c.at || '',
                  status: c.status, summary: c.summary || '', result: c.result || '' });
    }
    // Times come from phones ('…Z') and from the server ('…-05:00'): compared
    // as times, not as text.
    return talk.sort((a, b) => timeOf(a.at) - timeOf(b.at));
  }
  // Asked again and not answered yet: the ask is newer than Claude's last word.
  const askedAgain = k => !!k.claudeAskedAt && (!k.claude || !k.claude.at || timeOf(k.claudeAskedAt) > timeOf(k.claude.at));
  const ROUND_WORDS = { done: 'did it', needs_info: 'needs something from you',
                        waiting_ok: 'built it — waiting for your OK', not_mine: 'says it is not one it can do' };
  function whenText(s) {
    const t = timeOf(s);
    return t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  }
  function talkHtml(t) {
    const when = whenText(t.at);
    const at = when ? ' <span class="muted">· ' + esc(when) + '</span>' : '';
    if (t.from === 'owner') {
      return '<div class="cl-msg me"><div class="cl-msg-h">📝 ' + esc(t.by || 'You') + at + '</div>' +
        '<div class="cl-msg-text">' + esc(t.text || '') + '</div></div>';
    }
    return '<div class="cl-msg claude ' + esc(t.status || '') + '"><div class="cl-msg-h">' +
      (t.by === 'computer' || t.by === 'nightly' ? '🖥 Claude at home' : '🤖 Claude') +
      (ROUND_WORDS[t.status] ? ' ' + esc(ROUND_WORDS[t.status]) : '') + at + '</div>' +
      (t.summary ? '<div class="cl-summary">' + esc(t.summary) + '</div>' : '') +
      (t.result ? '<div class="cl-result">' + esc(t.result) + '</div>' : '') + '</div>';
  }
  // Which cards show their earlier rounds, and what is typed in each card's
  // notes box: kept through the redraws a change to the card brings (this
  // visit only).
  const talkOpen = {}, talkDrafts = {};
  const talkKey = () => openCard ? openCard.boardId + '/' + openCard.cardId : '';
  window.toggleTalk = function () { const key = talkKey(); if (!key) return; talkOpen[key] = !talkOpen[key]; renderCardDetail(); };
  window.clNoteTyped = function (v) { const key = talkKey(); if (key) talkDrafts[key] = v; };
  function talkListHtml(board, k) {
    const talk = talkOf(k);
    if (!talk.length) return '';
    const key = board.id + '/' + k.id;
    const hidden = talkOpen[key] ? 0 : Math.max(0, talk.length - TALK_SHOWN);
    return '<div class="cl-talk">' +
      (hidden ? '<button class="link-btn cl-earlier" onclick="toggleTalk()">Show the ' + hidden + ' earlier</button>'
        : talk.length > TALK_SHOWN ? '<button class="link-btn cl-earlier" onclick="toggleTalk()">Show only the latest</button>' : '') +
      talk.slice(hidden).map(talkHtml).join('') + '</div>';
  }
  function noteBoxHtml(board, k) {
    const c = k.claude || {};
    const answer = c.status === 'needs_info' && !askedAgain(k);
    return '<div class="field cl-compose"><span class="label">' + (answer ? 'Your answer for Claude' : 'Your notes for Claude') +
      '</span><textarea id="clNote" rows="3" oninput="clNoteTyped(this.value)" placeholder="' +
      (answer ? 'What it asked for' : 'What to change or add — Claude sees what it did before, its notes and yours') + '">' +
      esc(talkDrafts[board.id + '/' + k.id] || '') + '</textarea></div>';
  }
  const sendLabel = board => atNight(board) ? '🌙 Send — Claude does it tonight' : '📨 Send — Claude does it now';

  function claudeHtml(board, k) {
    if (!claudeOwns(board, k) || !claudeShown(board, k)) return '';
    const c = k.claude || null;
    const last = doneColOf(board);
    const finished = colOf(board, k) === last;
    const night = atNight(board);
    const head = '<div class="bd-move-label">Claude</div>';
    if (k.noClaude) {
      return head + '<div class="cl-box muted">Claude leaves this card alone.' +
        '<div class="field-actions"><button class="btn btn-sm" onclick="claudeAllow(true)">Let Claude look at it</button></div></div>';
    }
    const talk = talkListHtml(board, k);
    if (!c && !talk) {
      return head + '<div class="cl-box muted">' + (finished ? 'Done — Claude does not look at finished cards.'
        : night ? 'Claude builds new wishes at the night run (midnight, Monday to Friday nights).'
        : computerAwake() ? 'Claude on the computer at home looks at new cards every 20 minutes and does the ones it can.'
        : cardRuns ? 'Claude looks at new cards at 7 am and 7 pm and does the ones it can by itself.'
        : 'Claude does a card only when you ask (switched on or off in Pricing rules → Claude).') +
        '<div class="field-actions">' +
          (finished || night ? '' : '<button class="btn btn-sm btn-filled" onclick="claudeNow()">🤖 Ask Claude now</button>') +
          '<button class="btn btn-sm" onclick="claudeAllow(false)">Not for Claude</button>' +
        '</div></div>';
    }
    const cc = c || {};
    const when = cc.at ? new Date(cc.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const who = cc.by === 'computer' || cc.by === 'nightly' ? '🖥 Claude at home' : '🤖 Claude';
    if (cc.status === 'working') {
      return head + '<div class="cl-box working"><div class="cl-title">' + who + ' is working on this' +
        (when ? ' <span class="muted">· since ' + esc(when) + '</span>' : '') + '</div>' + talk +
        '<div class="hint">What it does shows here when it has finished; add notes then.</div></div>';
    }
    const again = askedAgain(k);
    // Sent on a server board: its answer comes within a minute or two, from
    // the call already made -- a second Send then would run it twice. On the
    // wish board the night is hours off, so more notes can still go in.
    const waiting = again && !night;
    const title = again ? (night ? '🌙 Sent — Claude does it again at the night run' : '📨 Sent — Claude is doing it again')
      : cc.status === 'done' ? who + ' did this — check it'
      : cc.status === 'needs_info' ? who + ' needs something from you'
      : cc.status === 'waiting_ok' ? (cc.approvedAt ? '🖥 Going live on the next check (within 20 minutes)'
        : '🖥 Built — waiting for your OK to put it live')
      : cc.status === 'not_mine' ? '🤖 Not one Claude can do'
      : '🤖 Claude';
    return head + '<div class="cl-box ' + esc(again ? 'again' : cc.status || '') + '">' +
      // Each round below carries its own time.
      '<div class="cl-title">' + title + (when && !again && !talk ? ' <span class="muted">· ' + esc(when) + '</span>' : '') + '</div>' +
      talk +
      ((cc.drafts || []).length ? '<div class="cl-drafts">' + cc.drafts.map(d =>
        '<a class="btn btn-sm" href="' + esc(safeLink(d.link)) + '" target="_blank" rel="noopener">✉️ Draft to ' +
        esc(d.to || '') + '</a>').join('') + '</div>' : '') +
      (waiting ? '<div class="hint">Its answer shows here in a minute or two. Nothing yet? Ask again below.</div>'
        : noteBoxHtml(board, k)) +
      (cc.status === 'needs_info' && !again ? '<div class="hint">Type what it needs above and press Send — ' +
        (night ? 'Claude picks it up at the night run.' : 'Claude does it straight away.') + '</div>' : '') +
      '<div class="field-actions">' +
        (cc.status === 'waiting_ok' && !cc.approvedAt && !again
          ? '<button class="btn btn-sm btn-filled" onclick="claudeApprove()">✅ Put it live</button>' : '') +
        (waiting ? '<button class="btn btn-sm" onclick="claudeNow()">🤖 Ask Claude now</button>'
          : '<button class="btn btn-sm' + (cc.status === 'waiting_ok' && !cc.approvedAt && !again ? '' : ' btn-filled') +
            '" onclick="claudeSend()">' + (again ? 'Add this note too' : sendLabel(board)) + '</button>') +
        '<button class="btn btn-sm" onclick="claudeAllow(false)">Not for Claude</button>' +
      '</div></div>';
  }

  // Only links into Gmail are drawn as links -- the text comes from the server,
  // but a link is where a stray address would do harm.
  function safeLink(u) {
    return /^https:\/\/mail\.google\.com\//.test(String(u || '')) ? u : 'https://mail.google.com/mail/#drafts';
  }

  function claudePatch(patch) {
    const k = openCard && (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k || !isOwner()) return null;
    Object.assign(k, patch);
    render(); renderCardDetail();
    writeCard(openCard.boardId, openCard.cardId, patch);
    return k;
  }
  // A change Claude at home built goes live only on the owner's say-so. The
  // whole record is written back, approval added: the save merges, and a
  // record written in pieces could keep a stale field.
  window.claudeApprove = async function () {
    const k0 = openCard && (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k0 || !k0.claude || k0.claude.status !== 'waiting_ok') return;
    const asked = openCard.boardId + '/' + openCard.cardId;
    if (!(await ydConfirm('', { title: 'Put this change live for everyone using Job Hub?', ok: 'Put it live' }))) return;
    // The same card still open and still waiting.
    const k = openCard && openCard.boardId + '/' + openCard.cardId === asked && (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k || !k.claude || k.claude.status !== 'waiting_ok') return;
    claudePatch({ claude: Object.assign({}, k.claude, { approvedAt: nowIso(), approvedBy: myName() }) });
    showToast('It goes live on the next check — within 20 minutes');
  };
  window.claudeAllow = function (yes) {
    claudePatch({ noClaude: !yes });
    showToast(yes ? 'Claude will look at this card' : 'Claude will leave this card alone');
  };
  // Jonah's note (if he typed one) goes into the conversation and Claude is
  // asked again: what it did before stays, so it starts from all of it.
  window.claudeSend = async function () {
    const board = openCard && boards[openCard.boardId];
    const k = board && (cards[board.id] || {})[openCard.cardId];
    if (!k || !claudeOwns(board, k) || !window.YDDb) return;
    if (k.claude && k.claude.status === 'working') { showToast('Claude is working on it — add notes once it has finished'); return; }
    const key = board.id + '/' + k.id;
    const box = el('clNote');
    const text = String(box ? box.value : (talkDrafts[key] || '')).trim().slice(0, 4000);
    const now = nowIso();
    // talkOf carries Claude's latest round along when the card has no
    // conversation yet, so that round is kept from here on.
    const talk = talkOf(k);
    if (text) talk.push({ id: 'tk' + Date.now().toString(36), from: 'owner', by: myName() || 'Jonah', at: now, text: text });
    const patch = { claudeTalk: talk.slice(-TALK_KEEP), claudeAskedAt: now, updatedAt: now, updatedBy: myName() };
    // A finished card is one Claude leaves alone -- and the morning tidy
    // deletes it a week after it was done -- so it goes back on the list.
    const done = doneColOf(board);
    if (done && colOf(board, k) === done) {
      const back = (board.columns || []).find(col => col.id !== done);
      if (back) Object.assign(patch, { column: back.id, order: Date.now() });
      Object.assign(patch, { doneAt: null }, doneByPatch(board, k, true, false, null));
    }
    Object.assign(k, patch);
    delete talkDrafts[key];
    render(); renderCardDetail();
    const saved = Promise.resolve(window.YDDb.put('boards/' + board.id + '/cards', k.id, patch));
    saved.catch(e => showToast(e && e.code === 'permission-denied' ? 'Not saved — not allowed'
      : 'Saved on this device — it goes to Claude when there is signal'));
    if (atNight(board)) {
      showToast(patch.column ? 'Sent — back on the list; Claude does it at the night run' : 'Sent — Claude does it at the night run');
      return;
    }
    // The server reads the card from the database, so the note has to be
    // there before it is asked (a few seconds at most, not forever).
    showToast('Sent — Claude is on it');
    await Promise.race([saved.catch(() => {}), new Promise(r => setTimeout(r, 15000))]);
    claudeNow({ boardId: board.id, cardId: k.id });
  };
  window.claudeNow = async function (given) {
    if (!isOwner() || !window.YDClaude) return;
    const ids = given && given.boardId ? given : openCard && { boardId: openCard.boardId, cardId: openCard.cardId };
    if (!ids) return;
    showToast('Claude is on it — this can take a minute');
    try {
      const r = await window.YDClaude.post('/cards/now', ids);
      const got = (r.report || [])[0] || {};
      showToast(got.status === 'done' ? 'Claude did it — have a look'
        : got.status === 'needs_info' ? 'Claude needs something from you'
        : got.status === 'not_mine' ? 'Not one Claude can do'
        : got.skipped ? 'Not now — ' + got.skipped : 'Claude could not finish this one');
    } catch (e) {
      showToast(e.message || 'Claude could not be reached');
    }
  };

  window.moveCardFromSheet = function (col) {
    if (!openCard) return;
    moveByHand(openCard.boardId, openCard.cardId, col, null);
  };

  window.toggleCheck = function (itemId, done) {
    const k = (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k) return;
    const checklist = (k.checklist || []).map(i => i.id === itemId
      ? Object.assign({}, i, { done: !!done, doneBy: done ? myName() : null }) : i);
    const patch = { checklist: checklist, updatedAt: nowIso(), updatedBy: myName() };
    Object.assign(k, patch);
    render(); renderCardDetail();
    writeCard(openCard.boardId, openCard.cardId, patch);
  };

  window.editCard = function () {
    if (!openCard || !editsBoard(boards[openCard.boardId])) return;
    renderCardEditor();
  };

  function renderCardEditor() {
    const board = boards[openCard.boardId];
    if (!board) return;
    const k = openCard.cardId ? (cards[board.id] || {})[openCard.cardId] : {};
    const crew = crewPeople();
    pickJobs = jobsList();
    const linked = k.jobId ? pickJobs.find(j => j._id === k.jobId) : null;
    const chosen = new Set((k.assignees || []).map(a => a.uid));
    const labelsOn = new Set(k.labels || []);

    // The boxes come in four groups, each headed with what it is for. Kind,
    // labels, urgency and colour all looked like ways of marking a card and
    // sat in one run, so it was not clear which did what: the kind decides
    // its colour and when it buzzes, the people who it is for; urgency sorts
    // it and labels are for finding it; the colour is only the band on top.
    // Every box is the one it was (same ids): saving reads them the same.
    const group = (title, sub, body) => '<div class="bd-ed-group"><div class="bd-ed-head">' + title + '</div>' +
      (sub ? '<div class="bd-ed-sub">' + sub + '</div>' : '') + body + '</div>';
    openModal(openCard.cardId ? 'Edit card' : 'New card on ' + esc(board.name),
      '<div class="field"><span class="label">What needs doing</span>' +
        '<input id="cdTitle" value="' + esc(k.title || '') + '" placeholder="e.g. Pick up 3 pallets of pavers"></div>' +
      group('What it is &amp; who is on it', 'The kind gives the card its colour. ' +
          '👷 A crew task can be seen by every crew member, from any board that is not private.',
        // What it is gives the card its colour; whether it has a time is the
        // Time box's alone (Jonah, 15 Oct 2026).
        '<div class="field"><span class="label">What is it</span><select id="cdType" onchange="cardTypeChanged()">' +
          '<option value="">—</option>' +
          YDRemind.TYPES.map(t => '<option value="' + t.id + '"' + (t.id === cardType(board, k) ? ' selected' : '') + '>' +
            esc(cardTypeLabel(t)) + '</option>').join('') +
        '</select></div>' +
        (crew.length ? '<div class="field"><span class="label">Who is on it</span><div class="bd-pick">' +
          crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="cdWho" value="' + p.uid + '"' +
            (chosen.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') +
          '</div>' +
          (board.visibleTo && board.visibleTo.length ? '' :
            '<div class="hint">This board is not shared with anyone yet, so the people you pick ' +
            'here will not see it until you share it in Board settings.</div>') +
        '</div>' : '')) +
      group('When', 'Where it sits on the board, the day it is due, and the buzz on the phone.',
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Column</span><select id="cdCol">' +
          board.columns.map(c => '<option value="' + c.id + '"' +
            (c.id === (k.column || openCard.column || board.columns[0].id) ? ' selected' : '') + '>' +
            esc(c.name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><span class="label">Due</span>' +
          '<input type="date" id="cdDue" value="' + esc(k.due || '') + '"></div>' +
      '</div>' +
      // A time puts the card at that hour on the calendar, not just on the
      // day; the reminder buzzes the phone (functions/reminders.py).
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Time (if it has one)</span>' +
          '<input type="time" id="cdTime" value="' + esc(k.dueTime || '') + '" onchange="cardRemindHint()"></div>' +
        '<div class="field"><span class="label">Reminder</span><select id="cdRemind" onchange="cardRemindHint()">' +
          YDRemind.optionsHtml(k) + '</select></div>' +
      '</div>' +
      '<div class="hint" id="cdRemindHint"></div>') +
      group('Sorting &amp; look', 'Urgency puts it higher in its column (and in “🟠 Urgent &amp; this week”); labels are for ' +
          'finding it (☔ Rain day…); the colour is only the band across the top — with none, it takes its kind’s.',
        // A machine's problem: how urgent is the problem's own (its label),
        // set on the machine -- a picker here in the boards' words was a
        // second name for it, and the machine put its own back anyway.
        (urgencyLabel(board, k)
          ? '<div class="field"><span class="label">How urgent</span><div class="bd-urg-machine">' +
              '<span class="bd-label" style="--c:' + safeColor(urgencyLabel(board, k).color) + ';color:' +
                inkOn(safeColor(urgencyLabel(board, k).color)) + '">' + esc(urgencyLabel(board, k).name) + '</span>' +
              ' <small>— change it on the machine (Equipment tab)</small></div></div>'
          : '<div class="field"><span class="label">How urgent</span><div class="bd-urg-pick">' +
          URGENCY.map(([u, name, hint]) => '<label class="bd-urg-opt urg-' + u + '"><input type="radio" name="cdUrg" value="' + u + '"' +
            ((k.urgency || 'normal') === u ? ' checked' : '') + '><span>' + esc(name) + (hint ? ' <small>' + esc(hint) + '</small>' : '') +
            '</span></label>').join('') +
        '</div></div>') +
        '<div class="field"><span class="label">Labels</span><div class="bd-pick">' +
          (board.labels || []).map(l => '<label class="bd-pick-item" style="--c:' + safeColor(l.color) + '">' +
            '<input type="checkbox" class="cdLabel" value="' + l.id + '"' + (labelsOn.has(l.id) ? ' checked' : '') + '>' +
            '<span class="bd-label">' + esc(l.name) + '</span></label>').join('') +
        '</div></div>' +
        '<div class="field"><span class="label">Card colour</span>' + colorPickHtml('cdColor', k.color) + '</div>') +
      group('Details', '',
      // A search box rather than a list of every customer's name, which grew
      // too long to scroll. A job not on this device keeps its link as it was.
      // Someone without Jobs has no jobs to pick from; whatever is linked stays.
      (!seesJobs() ? '<input type="hidden" id="cdJob" value="' + esc(k.jobId || '') + '">' :
      '<div class="field"><span class="label">Linked job</span>' +
        '<input type="hidden" id="cdJob" value="' + esc(k.jobId || '') + '">' +
        '<div class="jobpick">' +
          '<input id="cdJobSearch" autocomplete="off" placeholder="Search by name, address, town or estimate #" ' +
            'value="' + esc(linked ? jobLine(linked) : (k.jobName || '')) + '" ' +
            'oninput="cardJobFilter()" onfocus="cardJobFilter(true)" onkeydown="cardJobKey(event)" onblur="cardJobBlur()">' +
          '<button type="button" class="jobpick-clear" onclick="cardJobPick(\'\')" ' +
            'title="Unlink the job" aria-label="Unlink the job">&times;</button>' +
        '</div>' +
        '<div class="jobpick-list" id="cdJobList" role="listbox" hidden></div>' +
        '<div class="hint">Crew see only the job’s name, never its price.</div></div>') +
      '<div class="field"><span class="label">Notes</span>' +
        '<textarea id="cdNotes" rows="3" placeholder="Details, measurements, where to find things">' +
        esc(k.notes || '') + '</textarea></div>' +
      '<div class="field"><span class="label">Checklist — one item per line</span>' +
        '<textarea id="cdList" rows="4" placeholder="e.g.\n4 bags polymeric sand\nedge restraint">' +
        esc((k.checklist || []).map(i => (i.done ? '[x] ' : '') + i.text).join('\n')) + '</textarea>' +
        '<div class="hint">Start a line with [x] to mark it already done.</div></div>') +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveCard()">Save</button>' +
        '<button class="btn btn-sm" onclick="' + (openCard.cardId ? 'renderCardDetail2()' : 'closeBoardModal()') + '">Cancel</button>' +
        // The same delete as the card's own 🗑 (and its question); not on a
        // card the app would only make again (cardDeletable).
        (openCard.cardId && cardDeletable(board, k, colOf(board, k) === doneColOf(board))
          ? '<button class="btn btn-sm" onclick="bdDeleteOpen()">🗑 Delete card</button>' : '') +
      '</div>');
    cardRemindHint();
    const t = el('cdTitle'); if (t) t.focus();
  }
  window.renderCardDetail2 = function () { renderCardDetail(); };
  // Just its name (as on the calendar's editor, calendar.js typeLabel).
  const cardTypeLabel = t => t.icon + ' ' + t.name;

  // A crew task is the crew's: picking it tags the card 👷 Crew, so the crew
  // can see it from any board and it is listed on Crew tasks with the rest.
  // Picking what it is never clears a time.
  window.cardTypeChanged = function () {
    const t = YDRemind.typeById(val('cdType'));
    if (t && t.crew) {
      const box = document.querySelector('.cdLabel[value="' + CREW_LABEL.id + '"]');
      if (box) box.checked = true;
    }
    cardRemindHint();
  };
  window.cardRemindHint = function () {
    const hint = el('cdRemindHint');
    const board = openCard && boards[openCard.boardId];
    if (!hint || !board) return;
    const box = el('cdType'), timed = /^\d{2}:\d{2}$/.test(val('cdTime'));
    if (box) Array.prototype.forEach.call(box.options, o => {
      const t = YDRemind.typeById(o.value);
      if (t) o.textContent = cardTypeLabel(t, timed);
    });
    const choice = val('cdRemind');
    const type = val('cdType') || YDRemind.typeOf({ labels: Array.from(document.querySelectorAll('.cdLabel:checked')).map(i => i.value) },
      { boardId: board.id });
    hint.innerHTML = choice === 'none' ? 'Nobody gets a reminder for this card.'
      : choice === '' ? YDRemind.usualHint(type, /^\d{2}:\d{2}$/.test(val('cdTime'))) +
          ((YDRemind.typeById(type) || {}).crew ? '' : ' Only for a card that is yours: you are on it, or you made it and nobody else is.')
      : 'To you and the people on it.';
  };

  // ---------------------------------------------------- the linked-job search

  let pickJobs = [];     // every job on this device, read when the editor opens
  let pickShown = [];    // the matches on screen, in order
  let pickAt = -1;       // the one the arrow keys are on

  // How a job is named in the box: who, and where -- two jobs for the same
  // customer are told apart by the address.
  function jobLine(j) {
    return (j.customerName || 'Untitled job') + (j.estimateNumber ? ' #' + j.estimateNumber : '') +
      (j.address ? ' — ' + j.address : '');
  }
  const isDone = j => normStatusOf(j) === 'complete';
  function normStatusOf(j) {
    return typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : (j.jobStatus || 'quoting');
  }

  // Every word typed must appear somewhere in the job: "smith oak" finds the
  // Smith job on Oak Street; an estimate number or a ZIP works on its own.
  function jobMatches(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return pickJobs.filter(j => {
      if (!words.length) return true;
      const hay = [j.customerName, j.address, j.city, j.zip, j.estimateNumber,
        (j.serviceTypes || []).join(' ')].join(' ').toLowerCase();
      return words.every(w => hay.indexOf(w) !== -1);
    }).sort((a, b) => (isDone(a) - isDone(b)) ||
      String(a.customerName || '').localeCompare(String(b.customerName || '')));
  }

  // On focus the whole list shows, open jobs first; typing narrows it. The
  // box still holding the linked job's name is not a search for it.
  window.cardJobFilter = function (focusing) {
    const box = el('cdJobSearch'), list = el('cdJobList');
    if (!box || !list) return;
    const linked = pickJobs.find(j => j._id === val('cdJob'));
    const q = focusing && linked && box.value === jobLine(linked) ? '' : box.value;
    const all = jobMatches(q);
    pickShown = all.slice(0, 40);
    pickAt = pickShown.length ? 0 : -1;
    list.innerHTML = pickShown.length
      ? pickShown.map((j, i) => {
          const st = normStatusOf(j);
          return '<button type="button" class="jobpick-item' + (i === pickAt ? ' on' : '') + '" role="option" ' +
            'onmousedown="event.preventDefault()" onclick="cardJobPick(\'' + safeId(j._id) + '\')">' +
            '<span class="jobpick-name">' + esc(j.customerName || 'Untitled job') +
              (j.estimateNumber ? ' <span class="job-num">#' + esc(j.estimateNumber) + '</span>' : '') + '</span>' +
            '<span class="jobpick-where">' + esc([j.address, j.city].filter(Boolean).join(', ') || '—') + '</span>' +
            (typeof statusPill === 'function' ? statusPill(st) : '') +
          '</button>';
        }).join('') +
        (all.length > pickShown.length ? '<div class="jobpick-more">' + (all.length - pickShown.length) +
          ' more — keep typing to narrow it down</div>' : '')
      : '<div class="jobpick-more">No job matches “' + esc(q) + '”</div>';
    list.hidden = false;
  };

  window.cardJobPick = function (id) {
    const j = id ? pickJobs.find(x => x._id === id) : null;
    el('cdJob').value = j ? j._id : '';
    el('cdJobSearch').value = j ? jobLine(j) : '';
    el('cdJobList').hidden = true;
    if (!j) el('cdJobSearch').focus();
  };

  window.cardJobKey = function (e) {
    const list = el('cdJobList');
    if (!list || list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pickShown.length) return;
      pickAt = (pickAt + (e.key === 'ArrowDown' ? 1 : -1) + pickShown.length) % pickShown.length;
      list.querySelectorAll('.jobpick-item').forEach((b, i) => {
        b.classList.toggle('on', i === pickAt);
        if (i === pickAt) b.scrollIntoView({ block: 'nearest' });
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (pickShown[pickAt]) cardJobPick(pickShown[pickAt]._id);
    } else if (e.key === 'Escape') {
      // Closes the list only, not the whole card editor behind it.
      e.preventDefault();
      cardJobBlur();
    }
  };

  // Leaving the box without picking puts back what is actually linked, so
  // half-typed words never look like a link that is not there.
  window.cardJobBlur = function () {
    const list = el('cdJobList'), box = el('cdJobSearch');
    if (list) list.hidden = true;
    if (!box) return;
    const id = val('cdJob');
    const j = pickJobs.find(x => x._id === id);
    const k = openCard && openCard.cardId ? (cards[openCard.boardId] || {})[openCard.cardId] : null;
    box.value = j ? jobLine(j) : (id && k && k.jobId === id ? (k.jobName || '') : '');
  };

  window.saveCard = function () {
    if (!openCard || !editsBoard(boards[openCard.boardId])) return;
    const board = boards[openCard.boardId];
    const title = val('cdTitle');
    if (!title) { showToast('Say what needs doing'); return; }
    const id = openCard.cardId || newId('cd');
    const was = (cards[board.id] || {})[id] || {};

    // A copy, used up as lines are matched, so two lines that both say
    // "Sweep" keep two different ids and ticking one does not tick both.
    const oldList = (was.checklist || []).slice();
    const checklist = (el('cdList').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .map((line, i) => {
        const done = /^\[x\]\s*/i.test(line);
        const text = line.replace(/^\[x\]\s*/i, '');
        // Keep an item's id (and who ticked it) if the same line was there before.
        const at = oldList.findIndex(o => o.text === text);
        const prev = at === -1 ? null : oldList.splice(at, 1)[0];
        return { id: prev ? prev.id : 'ck' + i + Date.now().toString(36), text: text, done: done,
                 doneBy: done ? ((prev && prev.doneBy) || myName()) : null };
      });

    const crew = crewPeople();
    const assignees = Array.from(document.querySelectorAll('.cdWho:checked'))
      .map(i => crew.find(p => p.uid === i.value)).filter(Boolean)
      .map(p => ({ uid: p.uid, name: p.name }));
    const jobId = val('cdJob');
    const job = jobId ? jobsList().find(j => j._id === jobId) : null;
    // Linked to a job this device does not have: leave the link as it was.
    const keepLink = !job && jobId && jobId === was.jobId;
    const col = val('cdCol') || board.columns[0].id;
    const last = doneColOf(board);
    const due = val('cdDue') || null;
    const dueTime = /^\d{2}:\d{2}$/.test(val('cdTime')) ? val('cdTime') : null;
    const choice = val('cdRemind');
    if ((dueTime || (choice !== '' && choice !== 'none')) && !due) { showToast('Pick the day it is due first'); return; }
    // The usual reminder, none, or a set time -- which goes to whoever set
    // it and the people on the card.
    const remind = YDRemind.fromChoice(choice, was, me() && me().uid);
    const picked = YDRemind.typeById(val('cdType')) ? val('cdType') : null;
    const labels = Array.from(document.querySelectorAll('.cdLabel:checked')).map(i => i.value);
    if (picked === 'crew' && labels.indexOf(CREW_LABEL.id) === -1) labels.push(CREW_LABEL.id);
    // Kept only when it is not what the board and labels make it anyway (a
    // card on Pickups is a pickup, one tagged 👷 Crew a crew task).
    const type = picked && picked !== YDRemind.typeOf({ labels: labels }, { boardId: board.id }) ? picked : null;

    const rec = {
      title: title,
      column: col,
      order: was.column === col && was.order != null ? was.order : endOrder(board.id, col),
      due: due,
      dueTime: dueTime,
      remindMins: remind.remindMins, hasReminder: remind.hasReminder, remindUids: remind.remindUids,
      noReminder: remind.noReminder,
      type: type,
      // No picker on a machine's problem: it keeps the urgency it has.
      urgency: ((document.querySelector('input[name="cdUrg"]:checked') || {}).value) || was.urgency || 'normal',
      labels: labels,
      color: pickedColor('cdColor'),
      assignees: assignees,
      jobId: job ? job._id : (keepLink ? was.jobId : null),
      jobName: job ? (job.customerName || 'Untitled job') : (keepLink ? (was.jobName || null) : null),
      jobNum: job ? (String(job.estimateNumber || '').trim() || null) : (keepLink ? (was.jobNum || null) : null),
      notes: el('cdNotes').value.trim(),
      checklist: checklist,
      doneAt: col === last ? (was.doneAt || nowIso()) : null,
      createdAt: was.createdAt || nowIso(),
      createdBy: was.createdBy || myName(),
      updatedAt: nowIso(),
      updatedBy: myName(),
    };
    Object.assign(rec, doneByPatch(board, was, !!openCard.cardId && colOf(board, was) === last, col === last, rec.doneAt));
    cards[board.id] = cards[board.id] || {};
    cards[board.id][id] = Object.assign({ id: id }, rec);
    openCard.cardId = id;
    render(); renderCardDetail();
    writeCard(board.id, id, rec);
  };

  function endOrder(boardId, col) {
    const board = boards[boardId];
    const inCol = Object.values(cards[boardId] || {}).filter(k => board ? colOf(board, k) === col : k.column === col);
    return inCol.length ? Math.max.apply(null, inCol.map(k => k.order || 0)) + 1000 : 1000;
  }

  function crewPeople() {
    return Object.keys(people)
      .filter(uid => people[uid].active && ['crew', 'admin', 'owner'].indexOf(people[uid].role) !== -1)
      .map(uid => ({ uid: uid, name: people[uid].name || people[uid].email || 'Worker', role: people[uid].role }))
      .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------- board settings

  // The columns and labels being edited, kept here while the form is open so
  // adding, removing and reordering can redraw the lists without losing what
  // has been typed. Each keeps its id from when it was made: renaming a column
  // keeps its cards, and deleting the middle one moves only ITS cards.
  let draftCols = [], draftLabels = [];

  window.editBoard = function (id) {
    if (!editsBoards() || (id && !runsBoard(boards[id]))) return;
    editingBoard = id;
    const b = id ? boards[id] : {};
    const crew = crewPeople().filter(p => p.role !== 'owner');
    const shared = new Set(b.visibleTo || []);
    const editors = new Set(b.editors || []);
    const color = b.color || PALETTE[Object.keys(boards).length % PALETTE.length];
    const doneNow = id ? doneColOf(b) : null;
    draftCols = (b.columns || TEMPLATES.crew.columns.map(n => ({ name: n })))
      .map(c => ({ id: c.id || null, name: c.name, done: id ? c.id === doneNow : false }));
    if (!id) markDraftDone();
    draftLabels = (b.labels || DEFAULT_LABELS).map(l => ({ id: l.id, name: l.name, color: l.color }));

    openModal(id ? 'Board settings' : 'New board',
      '<div class="field"><span class="label">Name</span>' +
        '<input id="bdName" value="' + esc(b.name || '') + '" placeholder="e.g. Crew — this week"></div>' +
      '<div class="field"><span class="label">Colour</span><div class="bd-swatches">' +
        PALETTE.map(c => '<label class="bd-swatch" style="--c:' + c + '" title="' + colorName(c) + '"><input type="radio" name="bdColor" value="' + c + '"' +
          ' aria-label="' + colorName(c) + '"' + (c === color ? ' checked' : '') + '><span></span></label>').join('') + '</div></div>' +
      (id ? '' :
        '<div class="field"><span class="label">Start from</span><select id="bdTemplate" onchange="bdTemplateChanged()">' +
          Object.keys(TEMPLATES).map(t => '<option value="' + t + '"' + (t === 'crew' ? ' selected' : '') + '>' +
            TEMPLATES[t].label + '</option>').join('') +
        '</select></div>') +
      '<div class="field"><span class="label">Columns, left to right</span>' +
        '<div id="bdColList" class="bd-edit-list"></div>' +
        '<button class="btn btn-sm" onclick="bdColAdd()">+ Add a column</button>' +
        '<label class="bd-done-none"><input type="radio" name="bdDone" onchange="bdDonePick(-1)"' +
          (draftCols.some(c => c.done) ? '' : ' checked') + '> No column counts as done</label>' +
        '<div class="hint">The column ticked ✓ Done counts as done: a card moved there is crossed off, stays ' +
          'until the end of the day, then leaves the board (and is deleted a week later). Cards in a column you ' +
          'delete move to the first column.</div>' +
      '</div>' +
      '<div class="field"><span class="label">Labels</span>' +
        '<div id="bdLabelList" class="bd-edit-list"></div>' +
        '<button class="btn btn-sm" onclick="bdLabelAdd()">+ Add a label</button>' +
      '</div>' +
      // Who sees a board and who may change it: the owner's, or an admin's
      // with Board sharing (setsSharing; firestore.rules refuse anyone else).
      // Any other admin sees who it is shared with, and the rest of the
      // settings.
      (!setsSharing(b) ? sharingSummary(b) :
      '<div class="field"><span class="label">Who can see it</span>' +
        // Private: the owner's alone (firestore.rules). Only the owner sets
        // it -- an admin cannot hide a board from the person who runs it.
        (isOwner() && id !== MAINTENANCE && id !== CREW_BOARD
          ? '<label class="chk"><input type="checkbox" id="bdPrivate"' + (b.ownerOnly ? ' checked' : '') + '> ' +
            '🔒 Private — only you (admins don’t see it unless you tick them below)</label>' : '') +
        (crew.length
          ? '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="bdShare" value="' +
              esc(p.uid) + '"' + (shared.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') + '</div>' +
            '<div class="hint">Anyone ticked sees this board and its cards, can move cards and tick ' +
            'checklists. Leave everyone unticked to keep it to ' + (isOwner() ? 'yourself' : 'the office') + '.</div>'
          : '<div class="hint">No crew accounts yet. Once someone signs in and ' + (isOwner() ? 'you approve' : 'the owner approves') +
            ' them, they appear here.</div>') +
      '</div>' +
      (crew.length ? '<div class="field"><span class="label">Who can add &amp; change</span>' +
        '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="bdEdit" value="' +
            esc(p.uid) + '"' + (editors.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') + '</div>' +
        '<div class="hint">Anyone ticked here adds, edits and deletes cards on this board only (and sees it). ' +
          'An admin whose Boards access is “change” can do that on every board not marked private' +
          (isOwner() ? ' — for hand-picking, set theirs to “see” on Your Crew and tick them here.' : '.') + '</div></div>' : '')) +
      (id === MAINTENANCE
        ? '<div class="hint">This board is kept in step with the Equipment tab — a card for every machine ' +
          'with a service coming up and every problem noted on one — so it cannot be deleted. ' +
          'Rename it, recolour it or share it as you like.</div>'
        : id === CREW_BOARD
        ? '<div class="hint">This board holds the recurring crew tasks (🔁), so it cannot be deleted. ' +
          'Rename it, recolour it or share it as you like.</div>'
        : '') +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveBoard()">Save</button>' +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Cancel</button>' +
        (id && id !== MAINTENANCE && id !== CREW_BOARD ? '<button class="btn btn-sm" onclick="removeBoard(\'' + id + '\')">Delete board</button>' : '') +
      '</div>');
    drawDrafts();
    const n = el('bdName'); if (n && !id) n.focus();
  };

  // What an admin is shown in place of the sharing controls.
  function sharingSummary(b) {
    const names = ids => (ids || []).map(uid => personName(uid)).filter(Boolean);
    const sees = names(b.visibleTo), changes = names(b.editors);
    return '<div class="field"><span class="label">Who can see it</span>' +
      '<div class="hint">' + (b.id ? (sees.length ? 'Shared with ' + esc(sees.join(', ')) : 'Not shared with the crew') +
        (changes.length ? ' · ' + esc(changes.join(', ')) + ' can add and change cards' : '') + '.' : 'A new board starts shared with nobody.') +
      (b.ownerOnly === true ? ' Only the owner sets who sees a private board.'
        : ' Only the owner, or an admin he gives Board sharing to, sets who sees a board and who can change it.') + '</div></div>';
  }

  // Read whatever has been typed back into the drafts before a redraw.
  function readDrafts() {
    document.querySelectorAll('.bdColName').forEach((inp, i) => { if (draftCols[i]) draftCols[i].name = inp.value; });
    document.querySelectorAll('.bdLabelName').forEach((inp, i) => { if (draftLabels[i]) draftLabels[i].name = inp.value; });
  }

  // A new board's done column: the one called Done, else the last if its
  // name says finished (doneColOf's own rule).
  function markDraftDone() {
    const id = doneColOf({ columns: draftCols.map((c, i) => ({ id: 'd' + i, name: c.name })) });
    draftCols.forEach((c, i) => { c.done = id === 'd' + i; });
  }
  window.bdDonePick = function (i) {
    readDrafts();
    draftCols.forEach((c, j) => { c.done = j === i; });
    drawDrafts();
    const none = document.querySelector('.bd-done-none input');
    if (none) none.checked = i === -1;
  };

  function drawDrafts() {
    const cl = el('bdColList'), ll = el('bdLabelList');
    if (cl) cl.innerHTML = draftCols.map((c, i) =>
      '<div class="bd-edit-row">' +
        '<span class="bd-edit-num">' + (i + 1) + '</span>' +
        '<input class="bdColName" value="' + esc(c.name) + '" placeholder="Column name" aria-label="Column ' + (i + 1) + '">' +
        '<label class="bd-done-pick" title="Cards in this column count as done"><input type="radio" name="bdDone"' +
          (c.done ? ' checked' : '') + ' onchange="bdDonePick(' + i + ')"> ✓ Done</label>' +
        '<button class="bd-edit-btn" onclick="bdColMove(' + i + ', -1)"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move earlier">↑</button>' +
        '<button class="bd-edit-btn" onclick="bdColMove(' + i + ', 1)"' + (i === draftCols.length - 1 ? ' disabled' : '') + ' aria-label="Move later">↓</button>' +
        '<button class="bd-edit-btn del" onclick="bdColRemove(' + i + ')"' + (draftCols.length === 1 ? ' disabled' : '') + ' aria-label="Delete column">✕</button>' +
      '</div>').join('');
    if (ll) ll.innerHTML = draftLabels.length ? draftLabels.map((l, i) =>
      '<div class="bd-edit-label">' +
        '<div class="bd-edit-row">' +
          '<span class="bd-label" style="--c:' + safeColor(l.color) + ';color:' + inkOn(safeColor(l.color)) + '">' + esc(l.name || 'Label') + '</span>' +
          '<input class="bdLabelName" value="' + esc(l.name) + '" placeholder="Label name" ' +
            'oninput="this.previousElementSibling.textContent = this.value || \'Label\'" aria-label="Label name">' +
          '<button class="bd-edit-btn del" onclick="bdLabelRemove(' + i + ')" aria-label="Delete label">✕</button>' +
        '</div>' +
        '<div class="bd-swatches small">' + PALETTE.map(c =>
          '<button class="bd-dotpick' + (c === l.color ? ' on' : '') + '" style="--c:' + c + '" ' +
          'onclick="bdLabelColor(' + i + ', \'' + c + '\')" title="' + colorName(c) + '" aria-label="' + colorName(c) +
          (c === l.color ? ' (picked)' : '') + '"></button>').join('') + '</div>' +
      '</div>').join('') : '<div class="hint">No labels.</div>';
    // The done column deleted: none is done now (the board then has no done
    // column until one is ticked -- nothing else is crossed off instead).
    const none = document.querySelector('.bd-done-none input');
    if (none) none.checked = !draftCols.some(c => c.done);
  }

  window.bdColAdd = function () {
    readDrafts();
    // New columns go in just before the last (done) column, which is nearly
    // always where a new step belongs.
    draftCols.splice(Math.max(0, draftCols.length - 1), 0, { id: null, name: '' });
    drawDrafts();
    const inputs = document.querySelectorAll('.bdColName');
    const box = inputs[Math.max(0, draftCols.length - 2)];
    if (box) box.focus();
  };
  window.bdColMove = function (i, d) {
    readDrafts();
    const j = i + d;
    if (j < 0 || j >= draftCols.length) return;
    const t = draftCols[i]; draftCols[i] = draftCols[j]; draftCols[j] = t;
    drawDrafts();
  };
  window.bdColRemove = function (i) {
    readDrafts();
    if (draftCols.length <= 1) return;
    draftCols.splice(i, 1);
    drawDrafts();
  };
  window.bdLabelAdd = function () {
    readDrafts();
    draftLabels.push({ id: null, name: '', color: PALETTE[draftLabels.length % PALETTE.length] });
    drawDrafts();
    const inputs = document.querySelectorAll('.bdLabelName');
    if (inputs.length) inputs[inputs.length - 1].focus();
  };
  window.bdLabelRemove = function (i) { readDrafts(); draftLabels.splice(i, 1); drawDrafts(); };
  window.bdLabelColor = function (i, c) {
    readDrafts();
    if (draftLabels[i] && /^#[0-9a-fA-F]{6}$/.test(c)) draftLabels[i].color = c;
    drawDrafts();
  };

  window.bdTemplateChanged = function () {
    const t = TEMPLATES[val('bdTemplate')] || TEMPLATES.blank;
    draftCols = t.columns.map(n => ({ id: null, name: n }));
    markDraftDone();
    drawDrafts();
  };

  window.saveBoard = function () {
    if (!editsBoards() || (editingBoard && !runsBoard(boards[editingBoard]))) return;
    readDrafts();
    const name = val('bdName');
    if (!name) { showToast('Give the board a name'); return; }
    const cols = draftCols.map(c => ({ id: c.id, name: String(c.name || '').trim() })).filter(c => c.name);
    if (!cols.length) { showToast('A board needs at least one column'); return; }
    const id = editingBoard || newId('bd');
    const was = boards[id] || {};
    const stamp = Date.now().toString(36);
    const columns = cols.map((c, i) => ({ id: c.id || 'col' + i + stamp, name: c.name }));
    const doneDraft = draftCols.filter(c => String(c.name || '').trim()).findIndex(c => c.done);
    const doneColumn = doneDraft === -1 ? '' : columns[doneDraft].id;
    const labels = draftLabels.filter(l => String(l.name || '').trim()).map((l, i) => ({
      id: l.id || 'lb' + i + stamp, name: String(l.name).trim(), color: safeColor(l.color),
    }));
    const colorInput = document.querySelector('input[name="bdColor"]:checked');

    const rec = {
      name: name,
      color: colorInput ? colorInput.value : PALETTE[0],
      columns: columns,
      doneColumn: doneColumn,
      labels: labels,
      order: was.order != null ? was.order : Object.keys(boards).length + 1,
      createdAt: was.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    if (setsSharing(was)) {
      // Whoever may change it sees it too.
      rec.editors = Array.from(document.querySelectorAll('.bdEdit:checked')).map(i => i.value);
      rec.visibleTo = Array.from(new Set(Array.from(document.querySelectorAll('.bdShare:checked'))
        .concat(Array.from(document.querySelectorAll('.bdEdit:checked'))).map(i => i.value)));
    } else if (!editingBoard) {
      // An admin's new board without Board sharing starts shared with
      // nobody; an existing one keeps its sharing (nothing about it is sent).
      Object.assign(rec, { editors: [], visibleTo: [] });
    }
    // Private is the owner's alone. Always on a new board: admins ask for
    // ownerOnly == false (start()).
    if (isOwner()) rec.ownerOnly = !!(el('bdPrivate') && el('bdPrivate').checked);
    else if (!editingBoard) rec.ownerOnly = false;
    boards[id] = Object.assign({ id: id }, was, rec);
    write('boards', id, rec, 'saving the board');

    // Cards in a column that no longer exists go to the first column rather
    // than vanishing from view. And "done" follows the last column wherever
    // it now is: reordering can make a different column last, and the cards
    // in it are done from now on, while those left behind in the old last
    // column are not done any more.
    const live = new Set(columns.map(c => c.id));
    const lastId = doneColumn;
    Object.values(cards[id] || {}).forEach(k => {
      const patch = {};
      if (!live.has(k.column)) patch.column = columns[0].id;
      // Except the Equipment tab's own cards: whether a machine's problem is
      // fixed is on the machine, and Equipment files those cards by it.
      // Stamping them done here would record every open problem that ended
      // up in the new last column as fixed, when nobody had touched it.
      if (!k.auto) {
        const done = (patch.column || k.column) === lastId;
        if (done && !k.doneAt) patch.doneAt = nowIso();
        if (!done && k.doneAt) patch.doneAt = null;
      }
      if (!Object.keys(patch).length) return;
      patch.updatedAt = nowIso();
      patch.updatedBy = myName();
      Object.assign(k, patch);
      writeCard(id, k.id, patch);
    });

    if (!cardUnsubs[id]) watchCards(id);
    closeBoardModal();
    current = id;
    render();
    showToast(name + ' saved');
  };

  window.removeBoard = async function (id) {
    const b = boards[id];
    // Maintenance follows the Equipment tab; Crew tasks holds the recurring
    // task list (recurring.js) -- deleting either would lose it.
    if (!b || !runsBoard(b) || id === MAINTENANCE || id === CREW_BOARD) return;
    const n = Object.keys(cards[id] || {}).length;
    if (!(await ydConfirm('This cannot be undone.', { title: 'Delete the board "' + b.name + '"' + (n ? ' and its ' + n + ' card' + (n === 1 ? '' : 's') : '') + '?',
                 ok: 'Delete the board', danger: true }))) return;
    if (!boards[id]) return;
    const ids = Object.keys(cards[id] || {});
    if (cardUnsubs[id]) { cardUnsubs[id](); delete cardUnsubs[id]; }
    delete boards[id]; delete cards[id]; delete cardsLoaded[id];
    current = null;
    closeBoardModal(); render();
    // Cards first: a card left behind under a deleted board would be
    // unreachable, since the rules check the board to decide who may read it.
    Promise.resolve(window.YDDb.removeMany(
      ids.map(cid => ['boards/' + id + '/cards', cid]).concat([['boards', id]])
    )).catch(e => console.warn('[boards] board not yet removed:', e.code || e.message));
  };

  // ---------------------------------------------------------------- modal

  function openModal(title, html) {
    const m = el('boardModal');
    const t = el('boardModalTitle');
    const b = el('boardModalBody');
    if (!m || !b) return;
    if (t) t.innerHTML = title;
    b.innerHTML = html;
    m.classList.add('active');
  }
  window.closeBoardModal = function () {
    const m = el('boardModal');
    if (m) m.classList.remove('active');
    openCard = null; editingBoard = null;
  };

  // ---------------------------------------------------------------- writes

  // Never awaited: a Firestore write only settles when the server answers, and
  // waiting for that in a truck with no signal would freeze the screen. The
  // local copy is already updated; Firestore sends the write when it can.
  function write(path, id, data, what) {
    if (!window.YDDb) { showToast('Not saved — still connecting'); return; }
    Promise.resolve(window.YDDb.put(path, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[boards] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }
  function writeCard(boardId, cardId, data) {
    write('boards/' + boardId + '/cards', cardId, data, 'card ' + cardId);
  }

  // --------------------------------------------------------------- loading

  function watchCards(boardId) {
    if (cardUnsubs[boardId] || !window.YDDb) return;
    cardUnsubs[boardId] = window.YDDb.watch('boards/' + boardId + '/cards', (changes, meta) => {
      const set = cards[boardId] = cards[boardId] || {};
      changes.forEach(c => {
        if (c.type === 'removed') delete set[c.id];
        else set[c.id] = Object.assign({ id: c.id }, c.data);
      });
      // Set before the event below goes out, so whoever is listening sees it.
      if (meta && !meta.fromCache) cardsLoaded[boardId] = true;
      redrawIfVisible();
      // The calendar shows cards with due dates.
      cardsChanged();
      if (openCard && openCard.boardId === boardId && openCard.cardId && !document.getElementById('cdTitle')) {
        renderCardDetail();
      }
    });
  }

  // ------------------------------------------------ Crew cards, any board
  //
  // The crew can read a card tagged 👷 Crew on any board (firestore.rules),
  // but not the boards they are not on -- so they cannot know those boards'
  // names and columns. The owner's device publishes them in
  // settings/public.crewBoards (names and columns only, nothing else of the
  // board); a crew phone reads that and watches each such board for its
  // Crew-tagged cards. Those boards sit in `boards` marked crewOnly: never in
  // the picker, their cards shown on Crew tasks, moved like any other card.
  // Only the owner's: he sees every board in one answer, where an admin's
  // list is put together from two (start), and one written from half of it
  // would take the other half's boards away from the crew.
  const crewWatch = {};              // boardId -> unsubscribe, on a crew phone
  let crewPublished = null;          // what this device last wrote
  function publishCrewBoards() {
    if (!isOwner() || !window.YDDb) return;
    const out = {};
    // A private board's name and columns are not the crew's business either.
    Object.values(boards).filter(b => !b.virtual && !b.crewOnly && !b.ownerOnly).forEach(b => {
      out[b.id] = { name: String(b.name || 'Board').slice(0, 80), color: b.color || null,
                    columns: (b.columns || []).map(c => ({ id: c.id, name: String(c.name || '').slice(0, 60) })) };
    });
    const json = JSON.stringify(out);
    if (json === crewPublished) return;
    crewPublished = json;
    Promise.resolve(window.YDDb.get('settings', 'public')).then(pub => {
      const was = (pub && pub.crewBoards) || {};
      if (JSON.stringify(was) === json) return;
      // put() merges map keys: a board deleted since is cleared by name.
      const patch = Object.assign({}, out);
      Object.keys(was).forEach(id => { if (!out[id]) patch[id] = null; });
      write('settings', 'public', { crewBoards: patch, crewBoardsAt: new Date().toISOString() }, 'the board list for the crew');
    }).catch(e => console.warn('[boards] crew board list not read:', (e && e.code) || e));
  }
  function dropCrewBoard(id) {
    if (crewWatch[id]) { crewWatch[id](); delete crewWatch[id]; }
    if (boards[id] && boards[id].crewOnly) { delete boards[id]; delete cards[id]; }
  }
  let crewLoading = false;
  function loadCrewBoards() {
    if (seesAllBoards() || !window.YDDb || !me() || crewLoading) return;
    crewLoading = true;
    Promise.resolve(window.YDDb.get('settings', 'public')).then(pub => {
      const list = (pub && pub.crewBoards) || {};
      Object.keys(list).forEach(id => {
        const info = list[id];
        if (!info || (boards[id] && !boards[id].crewOnly)) return;      // gone, or a board they are on
        const meta = { name: info.name || 'Board', color: info.color || null, columns: info.columns || [] };
        if (crewWatch[id]) { Object.assign(boards[id], meta); return; }
        if (!meta.columns.length) return;
        boards[id] = Object.assign({ id: id, crewOnly: true }, meta);
        crewWatch[id] = window.YDDb.watchContains('boards/' + id + '/cards', 'labels', CREW_LABEL.id, changes => {
          const set = cards[id] = cards[id] || {};
          changes.forEach(c => {
            if (c.type === 'removed') delete set[c.id];
            else set[c.id] = Object.assign({ id: c.id }, c.data);
          });
          redrawIfVisible();
          cardsChanged();
          if (openCard && openCard.boardId === id && openCard.cardId && !document.getElementById('cdTitle')) renderCardDetail();
        }, () => { dropCrewBoard(id); redrawIfVisible(); });   // not allowed yet (rules not published): nothing shown
      });
      Object.keys(crewWatch).forEach(id => { if (!list[id]) dropCrewBoard(id); });
      redrawIfVisible();
    }).catch(() => {}).then(() => { crewLoading = false; });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadCrewBoards(); });

  function onBoards(changes, meta) {
    changes.forEach(c => {
      if (c.type === 'removed') {
        delete boards[c.id];
        if (cardUnsubs[c.id]) { cardUnsubs[c.id](); delete cardUnsubs[c.id]; }
        delete cards[c.id]; delete cardsLoaded[c.id];
      } else {
        // Shared with them now: the whole board replaces its Crew cards.
        if (boards[c.id] && boards[c.id].crewOnly) dropCrewBoard(c.id);
        boards[c.id] = Object.assign({ id: c.id }, c.data);
        watchCards(c.id);
      }
    });
    // Only seed once the server has actually answered. An empty answer from the
    // local cache on a fresh phone would otherwise create the starter boards a
    // second time.
    // The first answer from the server, as opposed to the local cache: only
    // now is "this board does not exist" actually true.
    if (meta && !meta.fromCache && !ready) {
      ready = true;
      document.dispatchEvent(new CustomEvent('yd-boards-ready'));
    }
    if (isOwner() && !seeded && meta && !meta.fromCache) {
      seeded = true;
      if (!Object.keys(boards).length) seedOnce();
      if (!boards[WISHES]) wishesOnce();
      // Every board gets the ☔ Rain day label, so any card can be tagged for
      // a wet day (boards made before it existed included).
      Object.values(boards).forEach(b => {
        if (b.virtual || (b.labels || []).some(l => l.id === RAIN.id || /rain/i.test(l.name || ''))) return;
        b.labels = (b.labels || []).concat([RAIN]);
        write('boards', b.id, { labels: b.labels }, 'rain day label');
      });
      // And the 👷 Crew label, with the one id the crew's reading rule knows.
      Object.values(boards).forEach(b => {
        if (b.virtual || b.crewOnly || (b.labels || []).some(l => l.id === CREW_LABEL.id)) return;
        b.labels = (b.labels || []).concat([CREW_LABEL]);
        write('boards', b.id, { labels: b.labels }, 'crew label');
      });
      // Boards made before private ones existed say nothing either way. Each
      // is marked not private once, or an admin -- who asks for
      // "ownerOnly == false" -- would never see it.
      Object.values(boards).forEach(b => {
        if (b.virtual || b.crewOnly || typeof b.ownerOnly === 'boolean') return;
        b.ownerOnly = false;
        write('boards', b.id, { ownerOnly: false }, 'not private');
      });
    }
    if (meta && !meta.fromCache) publishCrewBoards();
    loadCrewBoards();
    redrawIfVisible();
    // A board itself changed (its sharing, its recurring tasks): recurring.js
    // and the calendar follow.
    if (changes.length) document.dispatchEvent(new CustomEvent('yd-boards-changed'));
  }

  // "Job Hub wishes" (Jonah, 6 Oct 2026): a card from his phone whenever he
  // thinks of something for the app. "Work on the wish list" starts by
  // copying new cards into WISHLIST.md; Claude's hourly card run leaves this
  // board alone (cards.py SKIP_BOARDS). Made once -- deleted, it stays gone.
  const WISHES = 'wishes';
  async function wishesOnce() {
    let flags = null;
    try { flags = await window.YDDb.get('settings', 'seeds'); } catch (e) { return; }
    if ((flags && flags.wishes) || boards[WISHES]) return;
    const b = {
      name: 'Job Hub wishes', color: '#2a9d8f', order: 90, visibleTo: [], ownerOnly: false,
      columns: [{ id: 'w0', name: 'New wishes' }, { id: 'w1', name: 'On the wish list' }, { id: 'w2', name: 'Built' }],
      labels: DEFAULT_LABELS, createdAt: nowIso(), updatedAt: nowIso(),
    };
    boards[WISHES] = Object.assign({ id: WISHES }, b);
    write('boards', WISHES, b, 'wishes board');
    write('settings', 'seeds', { wishes: true }, 'seed marker');
    watchCards(WISHES);
    redrawIfVisible();
  }

  // Two boards to start with, so the screen is not empty on day one. Fixed ids
  // mean two devices seeding at once write the same two boards, not four.
  // Only ever once. Seeding whenever there were no boards brought the two
  // starters back every time the owner deleted them.
  async function seedOnce() {
    let flags = null;
    try { flags = await window.YDDb.get('settings', 'seeds'); } catch (e) { return; }
    if (flags && flags.boards) return;
    if (Object.keys(boards).length) return;
    seedBoards();
    write('settings', 'seeds', { boards: true }, 'seed marker');
    redrawIfVisible();
  }

  function seedBoards() {
    const mk = (id, name, color, tpl, order) => ({
      name: name, color: color, order: order, visibleTo: [], ownerOnly: false,
      columns: TEMPLATES[tpl].columns.map((n, i) => ({ id: tpl + i, name: n })),
      labels: DEFAULT_LABELS, createdAt: nowIso(), updatedAt: nowIso(),
    });
    const todo = mk('todo', 'My to-dos', '#8e5bc7', 'admin', 1);
    const crew = mk('crew', 'Crew tasks', '#e07b24', 'crew', 2);
    boards.todo = Object.assign({ id: 'todo' }, todo);
    boards.crew = Object.assign({ id: 'crew' }, crew);
    write('boards', 'todo', todo, 'seeding');
    write('boards', 'crew', crew, 'seeding');
    watchCards('todo'); watchCards('crew');
  }

  // Everything that changes asks for a redraw, and at start-up that is every
  // board's cards, from the cache and again from the server, plus the jobs
  // and the people -- dozens in a second, each a whole new board. So the
  // asks in one moment share a single draw at the next frame (a hidden tab
  // gets none until it is looked at, when switchTab draws it anyway).
  // Not while the columns are being slid along (app.js ydSliding): drawn the
  // moment they are still.
  function redrawIfVisible() {
    if (drawFrame || drawLater) return;
    if (window.ydSliding && ydSliding()) {
      drawLater = setTimeout(() => { drawLater = 0; redrawIfVisible(); }, 250);
      return;
    }
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      const p = el('panel-boards');
      if (p && p.classList.contains('active')) render();
    });
  }
  // The same for everyone listening for card changes -- the calendar, the
  // recurring tasks, Equipment: told once for a burst, not once per board.
  // A timer rather than a frame, so the recurring cards and the Maintenance
  // board are kept in step while the app sits in a background tab too.
  function cardsChanged() {
    if (cardsNews) return;
    cardsNews = setTimeout(() => {
      cardsNews = 0;
      document.dispatchEvent(new CustomEvent('yd-cards-changed'));
    }, 50);
  }

  function stop() {
    if (unsubBoards) { unsubBoards(); unsubBoards = null; }
    if (unsubPeople) { unsubPeople(); unsubPeople = null; }
    Object.values(cardUnsubs).forEach(u => u());
    Object.keys(crewWatch).forEach(id => { crewWatch[id](); delete crewWatch[id]; });
    crewPublished = null;
    cardUnsubs = {}; cardsLoaded = {}; boards = {}; cards = {}; people = {}; seeded = false; current = null; ready = false;
  }

  function start(a) {
    stop();
    if (!window.YDDb || !a.user) return;
    if (a.isOwner) {
      unsubBoards = window.YDDb.watch('boards', onBoards);
    } else if (seesAllBoards()) {
      // An admin never asks for the whole collection: the rules refuse a
      // question whose answer could include a private board of the owner's.
      // Two questions instead -- every board not kept private, and any shared
      // with them by name -- and a board goes only when neither returns it
      // (as calendar.js does for private calendars).
      const from = {};
      const answered = {};       // which questions the server has answered
      const tagged = name => (changes, meta) => {
        const pass = [];
        changes.forEach(c => {
          const s = from[c.id] || (from[c.id] = new Set());
          if (c.type === 'removed') {
            s.delete(name);
            if (!s.size) { delete from[c.id]; pass.push(c); }
          } else { s.add(name); pass.push(c); }
        });
        if (meta && !meta.fromCache) answered[name] = true;
        // The list is only whole once the server has answered BOTH: until
        // then a board missing from it may be one the other question has not
        // returned yet. Marked ready on the first answer, a missing
        // Maintenance board was made again by Equipment over the real one
        // (its sharing wiped), so until then it counts as from the cache.
        const whole = !!(answered.open && answered.mine);
        if (pass.length || meta) onBoards(pass, meta && Object.assign({}, meta, { fromCache: !!meta.fromCache || !whole }));
      };
      const open = window.YDDb.watchWhere('boards', 'ownerOnly', false, tagged('open'), () => redrawIfVisible());
      const mine = window.YDDb.watchContains('boards', 'visibleTo', a.user.uid, tagged('mine'), () => redrawIfVisible());
      unsubBoards = () => { open(); mine(); };
    } else {
      // Crew may only ask for the boards that list them.
      unsubBoards = window.YDDb.watchContains('boards', 'visibleTo', a.user.uid, onBoards,
        () => redrawIfVisible());
    }
    // Names for the people on cards, and who a board can be shared with.
    if (a.isOwner || a.isAdmin) {
      unsubPeople = window.YDDb.watch('users', changes => {
        changes.forEach(c => {
          if (c.type === 'removed') delete people[c.id];
          else people[c.id] = c.data;
        });
        redrawIfVisible();
      }, () => {});
    }
  }

  window.YDBoards = {
    doneCol: doneColOf,
    render: render,
    // One board's columns drawn on another tab -- the Maintenance board on
    // the Equipment tab (equipment.js): the same cards, drag and card window
    // as here, the cards narrowed by `match` (its search) instead of this
    // tab's filters. Empty when the board is not one this person sees.
    // `waiting`: card-shaped things with no card yet ({ waiting: true, title,
    // labels, urgency, column, order, equipmentId }), drawn among them.
    columnsFor: (boardId, match, waiting) => {
      const b = boards[boardId];
      if (!b) return '';
      whoNow = window.YDRemind ? YDRemind.who(people) : null;
      try {
        return '<div class="bd-cols" data-keep="eqbd-' + esc(b.id) + '">' +
          columnsHtml(b, k => !match || match(k), (waiting || []).filter(k => k && k.waiting)) + '</div>';
      } finally { whoNow = null; }
    },
    editsBoard: id => !!boards[id] && editsBoard(boards[id]),
    // Where a job sits on the Bids and Jobs boards, and the bids to chase --
    // Home (home.js) lists them by the same rules, so the two never disagree.
    bidColumn: bidColumn,
    workColumn: workColumn,
    toChase: () => toChase(),
    toWrite: () => toWrite(),
    hasDraft: hasDraft,
    acceptedToBook: acceptedToBook,
    turnedDown: turnedDown,
    // The column a job sits in, named as on its board -- All Jobs shows it
    // beside the status (app.js renderDashboard). null: on neither board (a
    // lost bid, a job paid over a month ago).
    stageOf: j => {
      const bid = typeof isBidStatus === 'function' ? isBidStatus(j.jobStatus) : (j.jobStatus || 'quoting') === 'quoting';
      const board = bid ? BIDS : JOBS;
      const id = bid ? bidColumn(j) : workColumn(j);
      const c = id && board.columns.find(x => x.id === id);
      return c ? { board: board.id, id: c.id, name: c.name } : null;
    },
    // Paid jobs leave the Jobs board after a while, but still were paid.
    jobColumnName: id => ((JOBS.columns.find(c => c.id === id) || {}).name || ''),
    ready: () => ready,
    // Whether a board's cards have come from the server, not just the cache.
    cardsReady: id => !!cardsLoaded[id],
    boards: () => boards,
    cards: () => cards,
    people: () => people,
    isMine: (card, board) => isMineCard(board, card),
    // The calendar's "any time today" list ticks a card off: to Done (as a
    // drag there would), or back to the first column.
    setDone: (boardId, cardId, done) => {
      const b = boards[boardId];
      if (!b || !(cards[boardId] || {})[cardId]) return false;
      // A board with no done column has nowhere to tick a card off to.
      if (done && !doneColOf(b)) return false;
      // A person's tick: a checklist not all ticked is asked about first,
      // and the card moves (and the calendar is told) once they say so.
      moveByHand(boardId, cardId, done ? doneColOf(b) : b.columns[0].id, null);
      return true;
    },
    // For the calendar: every stored card with a due date, with its board.
    dueCards: () => {
      const out = [];
      Object.keys(cards).forEach(bid => {
        const b = boards[bid];
        if (!b) return;
        const last = doneColOf(b);
        Object.values(cards[bid]).forEach(k => {
          if (k.due) out.push({ board: b, card: k, done: colOf(b, k) === last });
        });
      });
      return out;
    },
    // Material pickups with no date, not picked up yet (Jonah, 14 Oct 2026:
    // "material pickups dont have to be scheduled for a specific time"). An
    // order the store says is ready (receipts.py makes the card, with a date
    // only when the email gives a "pick up by") is ready now: the calendar
    // lists it on today's "any time" list every day until it is picked up --
    // for a fortnight at most (remind.js CARRY_DAYS) after the card was made,
    // as functions/reminders.py open_tasks does. One picked up today stays
    // on today's list, ticked, so a slip of the finger can be put back.
    pickupsWaiting: () => {
      const out = [];
      const since = Date.now() - YDRemind.CARRY_DAYS * 864e5;
      Object.keys(cards).forEach(bid => {
        const b = boards[bid];
        if (!b || b.virtual) return;
        const last = doneColOf(b);
        Object.values(cards[bid]).forEach(k => {
          if (k.due || cardType(b, k) !== 'pickup') return;
          const done = colOf(b, k) === last;
          if (done && !finishedToday(k)) return;
          const made = k.createdAt ? new Date(k.createdAt).getTime() : NaN;
          if (isFinite(made) && made < since) return;
          out.push({ board: b, card: k, done: done });
        });
      });
      return out;
    },
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const tab = el('tabBoards');
    const on = a.mode === 'cloud' && !!a.user;
    if (tab) tab.hidden = !on;
    if (on) start(a); else stop();
    render();
  });
  document.addEventListener('yd-jobs-changed', redrawIfVisible);
  // This person's own record has come in (remind.js): which cards are theirs
  // can change with it -- on a crew phone it is how their own cards are known.
  document.addEventListener('yd-remind-me', redrawIfVisible);

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
