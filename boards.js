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

  // Won, lost and paid cards would pile up forever. They stay on the board
  // long enough to be seen, then drop off -- the job itself is untouched.
  const SHOW_WON_DAYS = 30, SHOW_LOST_DAYS = 45, SHOW_PAID_DAYS = 30;

  // Templates for new stored boards.
  const TEMPLATES = {
    crew: { label: 'Crew task list', columns: ['To do', 'Doing', 'Done'] },
    admin: { label: 'To-do list', columns: ['This week', 'Recurring', 'Waiting on', 'Done'] },
    blank: { label: 'Blank', columns: ['To do', 'Done'] },
  };

  // Colours a board or a label can be. Picked to be told apart at a glance in
  // daylight and in the dark theme, including by the colour-blind -- no two
  // that differ only by red/green.
  const PALETTE = ['#2f6fd6', '#1a9c8c', '#2f8f5b', '#8bb22a', '#e0a526',
                   '#e07b24', '#d64545', '#d94f8a', '#8e5bc7', '#66418f', '#6b7a8f'];

  const DEFAULT_LABELS = [
    { id: 'urgent', name: 'Urgent', color: '#d64545' },
    { id: 'waiting', name: 'Waiting', color: '#e0a526' },
    { id: 'materials', name: 'Materials', color: '#e07b24' },
    { id: 'equipment', name: 'Equipment', color: '#2f6fd6' },
    { id: 'office', name: 'Office', color: '#8e5bc7' },
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
  let seeded = false;
  let dragging = null;      // { boardId, cardId } while a card is dragged

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
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
    return (people[u.uid] && people[u.uid].name) || u.displayName || u.email || '';
  }

  // ------------------------------------------------------------ job columns

  function jobsList() {
    return (typeof loadAllJobs === 'function' ? loadAllJobs() : []).filter(j => j && j._id);
  }

  function bidColumn(j) {
    const stage = j.bidStage;
    if (stage === 'won') return (daysSince(j.bidStageAt) || 0) <= SHOW_WON_DAYS ? 'won' : null;
    if (stage === 'lost') return (daysSince(j.bidStageAt) || 0) <= SHOW_LOST_DAYS ? 'lost' : null;
    if ((j.jobStatus || 'quoting') !== 'quoting') return null;
    return QUOTING_STAGES.indexOf(stage) !== -1 ? stage : 'toSend';
  }

  // A stage only counts if it agrees with the job's status. If someone changes
  // the status in the job form, the board follows the form rather than showing
  // a complete job sitting in "In progress".
  function workColumn(j) {
    const st = j.jobStatus;
    const stage = j.workStage;
    if (st === 'active') return ACTIVE_STAGES.indexOf(stage) !== -1 ? stage : 'scheduled';
    if (st === 'complete') {
      const col = COMPLETE_STAGES.indexOf(stage) !== -1 ? stage
        : (j.qbInvoiced ? 'invoiced' : 'toInvoice');
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
  function moveJob(jobId, boardId, col) {
    const j = jobsList().find(x => x._id === jobId);
    if (!j) return;
    const at = nowIso();
    let patch;
    if (boardId === 'bids') {
      if (col === 'won') {
        patch = { bidStage: 'won', bidStageAt: at };
        if ((j.jobStatus || 'quoting') === 'quoting') {
          patch.jobStatus = 'active'; patch.workStage = 'scheduled'; patch.workStageAt = at;
        }
      } else if (col === 'lost') {
        patch = { bidStage: 'lost', bidStageAt: at, jobStatus: 'quoting' };
      } else {
        patch = { bidStage: col, bidStageAt: at, jobStatus: 'quoting' };
      }
    } else {
      patch = { workStage: col, workStageAt: at,
                jobStatus: ACTIVE_STAGES.indexOf(col) !== -1 ? 'active' : 'complete' };
    }
    if (!window.YDSync || !window.YDSync.patchJob(jobId, patch)) {
      showToast('Could not move that job');
      return;
    }
    const name = (j.customerName || 'Job').trim();
    const colName = (boardId === 'bids' ? BIDS : JOBS).columns.find(c => c.id === col).name;
    showToast(name + ' → ' + colName + (col === 'won' && patch.jobStatus === 'active'
      ? ' (now on the Jobs board)' : ''));
    render();
  }

  // ------------------------------------------------------------ board lists

  function visibleBoards() {
    const stored = Object.values(boards).sort((a, b) =>
      (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(b.name || ''));
    return isOwner() ? [BIDS, JOBS].concat(stored) : stored;
  }
  function boardById(id) {
    if (id === 'bids') return isOwner() ? BIDS : null;
    if (id === 'jobs') return isOwner() ? JOBS : null;
    return boards[id] || null;
  }

  // ---------------------------------------------------------------- render

  function render() {
    const wrap = el('boardsWrap');
    if (!wrap) return;
    const list = visibleBoards();

    if (!me() || !window.YDDb) {
      wrap.innerHTML = '<p class="empty-msg">Boards need you to be signed in.</p>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML = '<p class="empty-msg">' + (isOwner()
        ? 'No boards yet.' : 'No boards have been shared with you yet.') + '</p>';
      return;
    }
    if (!current || !boardById(current)) current = rememberedBoard(list);
    const board = boardById(current);

    wrap.innerHTML =
      '<div class="bd-picker">' +
        list.map(b => '<button class="bd-chip' + (b.id === current ? ' on' : '') +
          '" style="--c:' + safeColor(b.color) + '" onclick="showBoard(\'' + b.id + '\')">' +
          '<span class="bd-dot"></span>' + esc(b.name || 'Board') +
          (b.visibleTo && b.visibleTo.length && isOwner()
            ? '<span class="bd-shared" title="Shared with crew">👥 ' + b.visibleTo.length + '</span>' : '') +
          '</button>').join('') +
        (isOwner() ? '<button class="bd-chip bd-add" onclick="editBoard(\'\')">+ New board</button>' : '') +
      '</div>' +
      '<div class="bd-head" style="--c:' + safeColor(board.color) + '">' +
        '<div class="bd-title">' + esc(board.name) + '</div>' +
        '<div class="bd-sub">' + boardSubtitle(board) + '</div>' +
        '<div class="bd-actions">' +
          (!board.virtual && isOwner()
            ? '<button class="btn btn-sm" onclick="editBoard(\'' + board.id + '\')">Board settings</button>' : '') +
          (!board.virtual && isOwner()
            ? '<button class="btn btn-sm btn-filled" onclick="addCard(\'' + board.id + '\', \'' +
              board.columns[0].id + '\')">+ Add card</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="bd-cols">' + columnsHtml(board) + '</div>';
  }

  function boardSubtitle(b) {
    if (b.id === 'bids') return 'Every bid, from site visit to won or lost. Drag a card, or tap it, to move the job along.';
    if (b.id === 'jobs') return 'Every job you have won, until it is paid. Moving a card changes the job’s status.';
    const shared = (b.visibleTo || []).map(uid => personName(uid)).filter(Boolean);
    return isOwner()
      ? (shared.length ? 'Shared with ' + shared.map(esc).join(', ') : 'Only you can see this board')
      : 'Shared with you';
  }

  function columnsHtml(board) {
    if (board.virtual) {
      const grouped = jobCards(board);
      return board.columns.map(c => column(board, c, grouped[c.id].map(j => jobCardHtml(board, j)))).join('');
    }
    const mine = Object.values(cards[board.id] || {});
    return board.columns.map((c, i) => {
      const inCol = mine.filter(k => (k.column || board.columns[0].id) === c.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const last = i === board.columns.length - 1;
      return column(board, c, inCol.map(k => storedCardHtml(board, k, last)));
    }).join('');
  }

  function column(board, c, cardHtml) {
    return '<div class="bd-col" data-board="' + board.id + '" data-col="' + c.id + '" ' +
        'ondragover="bdDragOver(event)" ondragleave="bdDragLeave(event)" ondrop="bdDrop(event)">' +
      '<div class="bd-col-head"><span>' + esc(c.name) + '</span>' +
        '<span class="bd-count">' + cardHtml.length + '</span></div>' +
      '<div class="bd-col-body">' +
        (cardHtml.join('') || '<div class="bd-empty">Nothing here</div>') +
        (!board.virtual && isOwner()
          ? '<button class="bd-add-card" onclick="addCard(\'' + board.id + '\', \'' + c.id + '\')">+ Add a card</button>' : '') +
      '</div>' +
    '</div>';
  }

  function jobCardHtml(board, j) {
    const since = board.id === 'bids' ? (j.bidStageAt || j.lastModified) : (j.workStageAt || j.lastModified);
    const days = daysSince(since);
    const price = parseMoney(j.jobPrice);
    const where = [j.address, j.city].filter(Boolean).join(', ');
    const services = (j.serviceTypes || []).join(', ');
    // A bid nobody has touched in a fortnight is the one about to be lost.
    const stale = board.id === 'bids' && ['sent', 'followUp'].indexOf(bidColumn(j)) !== -1 && days >= 14;
    return '<div class="bd-card" draggable="true" data-board="' + board.id + '" data-card="' + j._id + '" ' +
        'ondragstart="bdDragStart(event)" ondragend="bdDragEnd(event)" ' +
        'onclick="openJobCard(\'' + board.id + '\', \'' + j._id + '\')">' +
      '<div class="bd-card-title">' + esc(j.customerName || 'Untitled job') + '</div>' +
      (where ? '<div class="bd-card-line">' + esc(where) + '</div>' : '') +
      (services ? '<div class="bd-card-line muted">' + esc(services) + '</div>' : '') +
      '<div class="bd-card-foot">' +
        (price ? '<span class="bd-money">' + fmtMoney(price) + '</span>' : '') +
        (days != null ? '<span class="bd-age' + (stale ? ' late' : '') + '">' +
          (days === 0 ? 'today' : days + 'd') + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  function storedCardHtml(board, k, inLastColumn) {
    const labels = (k.labels || []).map(id => (board.labels || []).find(l => l.id === id)).filter(Boolean);
    const list = k.checklist || [];
    const done = list.filter(i => i.done).length;
    const today = localDay();
    const dueState = !k.due || inLastColumn ? '' : k.due < today ? ' late' : k.due === today ? ' today' : '';
    return '<div class="bd-card' + (inLastColumn ? ' done' : '') + '" draggable="true" ' +
        'data-board="' + board.id + '" data-card="' + k.id + '" ' +
        'ondragstart="bdDragStart(event)" ondragend="bdDragEnd(event)" ' +
        'onclick="openCardDetail(\'' + board.id + '\', \'' + k.id + '\')">' +
      (labels.length ? '<div class="bd-labels">' + labels.map(l =>
        '<span class="bd-label" style="--c:' + safeColor(l.color) + '">' + esc(l.name) + '</span>').join('') + '</div>' : '') +
      '<div class="bd-card-title">' + esc(k.title || 'Untitled') + '</div>' +
      (k.jobName ? '<div class="bd-card-line">📋 ' + esc(k.jobName) + '</div>' : '') +
      '<div class="bd-card-foot">' +
        (k.due ? '<span class="bd-due' + dueState + '">📅 ' + shortDay(k.due) + '</span>' : '') +
        (list.length ? '<span class="bd-check' + (done === list.length ? ' all' : '') + '">☑ ' +
          done + '/' + list.length + '</span>' : '') +
        (k.notes ? '<span class="bd-note" title="Has notes">≡</span>' : '') +
        '<span class="bd-people">' + (k.assignees || []).map(a =>
          '<span class="bd-face" title="' + esc(a.name) + '">' + esc(initials(a.name)) + '</span>').join('') + '</span>' +
      '</div>' +
    '</div>';
  }

  function personName(uid) {
    const p = people[uid];
    return p ? (p.name || p.email || 'Worker') : '';
  }

  // Colours come from a fixed palette, but they are also read back out of the
  // database and dropped into a style attribute -- so anything that is not a
  // plain hex colour is refused rather than trusted.
  function safeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#6b7a8f';
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
    const siblings = Array.from(col.querySelectorAll('.bd-card')).filter(c => c.dataset.card !== cardId);
    const before = siblings.find(c => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    moveCard(boardId, cardId, col.dataset.col, before ? before.dataset.card : null);
  };

  function canMove(boardId) {
    if (boardId === 'bids' || boardId === 'jobs') return isOwner();
    return isOwner() || !!boards[boardId];
  }

  function moveCard(boardId, cardId, col, beforeId) {
    if (boardId === 'bids' || boardId === 'jobs') { moveJob(cardId, boardId, col); return; }
    const set = cards[boardId] || {};
    const k = set[cardId];
    if (!k) return;
    const inCol = Object.values(set).filter(x => x.id !== cardId && (x.column || '') === col)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    let order;
    const idx = beforeId ? inCol.findIndex(x => x.id === beforeId) : -1;
    if (idx === -1) order = inCol.length ? (inCol[inCol.length - 1].order || 0) + 1000 : 1000;
    else if (idx === 0) order = (inCol[0].order || 0) - 1000;
    else order = ((inCol[idx - 1].order || 0) + (inCol[idx].order || 0)) / 2;
    if (k.column === col && k.order === order) return;

    const board = boards[boardId];
    const last = board.columns[board.columns.length - 1].id;
    const patch = { column: col, order: order, updatedAt: nowIso(), updatedBy: myName() };
    // Reaching the last column is "done"; leaving it is "not done any more".
    patch.doneAt = col === last ? (k.doneAt || nowIso()) : null;
    Object.assign(k, patch);
    render();
    if (openCard && openCard.cardId === cardId) renderCardDetail();
    writeCard(boardId, cardId, patch);
  }

  // ------------------------------------------------------------- job cards

  window.openJobCard = function (boardId, jobId) {
    const board = boardById(boardId);
    const j = jobsList().find(x => x._id === jobId);
    if (!board || !j) return;
    const col = boardId === 'bids' ? bidColumn(j) : workColumn(j);
    openModal(esc(j.customerName || 'Job'),
      '<div class="bd-detail-sub">' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</div>' +
      ((j.serviceTypes || []).length ? '<div class="bd-detail-line">' + esc(j.serviceTypes.join(', ')) + '</div>' : '') +
      (parseMoney(j.jobPrice) ? '<div class="bd-detail-line bold">' + fmtMoney(parseMoney(j.jobPrice)) + '</div>' : '') +
      '<div class="bd-move-label">Move to</div>' +
      '<div class="bd-move">' + board.columns.map(c =>
        '<button class="bd-move-btn' + (c.id === col ? ' on' : '') + '" style="--c:' + safeColor(board.color) + '" ' +
        (c.id === col ? 'disabled' : 'onclick="moveJobFromSheet(\'' + jobId + '\', \'' + boardId + '\', \'' + c.id + '\')"') +
        '>' + esc(c.name) + '</button>').join('') + '</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="openJobFromBoard(\'' + jobId + '\')">Open the job</button>' +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Close</button>' +
      '</div>');
  };
  window.moveJobFromSheet = function (jobId, boardId, col) {
    closeBoardModal();
    moveJob(jobId, boardId, col);
  };
  window.openJobFromBoard = function (jobId) {
    closeBoardModal();
    if (typeof dirty !== 'undefined' && dirty && currentJobId !== jobId &&
        !confirm('The job open now has unsaved changes. Open this one anyway?')) return;
    if (typeof loadJob === 'function') loadJob(jobId);
    switchTab('job');
  };

  // ----------------------------------------------------------- stored cards

  window.addCard = function (boardId, col) {
    if (!isOwner()) return;
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
    openModal(esc(k.title || 'Card'),
      (labels.length ? '<div class="bd-labels big">' + labels.map(l =>
        '<span class="bd-label" style="--c:' + safeColor(l.color) + '">' + esc(l.name) + '</span>').join('') + '</div>' : '') +
      '<div class="bd-detail-meta">' +
        '<span>📌 ' + esc(board.name) + '</span>' +
        (k.due ? '<span>📅 ' + shortDay(k.due) + '</span>' : '') +
        ((k.assignees || []).length ? '<span>👤 ' + k.assignees.map(a => esc(a.name)).join(', ') + '</span>' : '') +
        (k.jobName ? '<span>📋 ' + esc(k.jobName) + '</span>' : '') +
      '</div>' +
      (k.notes ? '<div class="bd-notes">' + esc(k.notes) + '</div>' : '') +
      (list.length ? '<div class="bd-move-label">Checklist</div><div class="bd-checklist">' +
        list.map(i => '<label class="chk bd-chk"><input type="checkbox"' + (i.done ? ' checked' : '') +
          ' onchange="toggleCheck(\'' + i.id + '\', this.checked)"><span' + (i.done ? ' class="struck"' : '') + '>' +
          esc(i.text) + '</span></label>').join('') + '</div>' : '') +
      '<div class="bd-move-label">Move to</div>' +
      '<div class="bd-move">' + board.columns.map(c =>
        '<button class="bd-move-btn' + (c.id === k.column ? ' on' : '') + '" style="--c:' + safeColor(board.color) + '" ' +
        (c.id === k.column ? 'disabled' : 'onclick="moveCardFromSheet(\'' + c.id + '\')"') +
        '>' + esc(c.name) + '</button>').join('') + '</div>' +
      (k.updatedBy ? '<div class="hint">Last moved by ' + esc(k.updatedBy) + '</div>' : '') +
      '<div class="field-actions">' +
        (isOwner() ? '<button class="btn btn-filled" onclick="editCard()">Edit</button>' : '') +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Close</button>' +
      '</div>');
  }

  window.moveCardFromSheet = function (col) {
    if (!openCard) return;
    moveCard(openCard.boardId, openCard.cardId, col, null);
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
    if (!openCard || !isOwner()) return;
    renderCardEditor();
  };

  function renderCardEditor() {
    const board = boards[openCard.boardId];
    if (!board) return;
    const k = openCard.cardId ? (cards[board.id] || {})[openCard.cardId] : {};
    const crew = crewPeople();
    const jobs = jobsList().filter(j => (j.jobStatus || 'quoting') !== 'complete')
      .sort((a, b) => String(a.customerName || '').localeCompare(b.customerName || ''));
    const chosen = new Set((k.assignees || []).map(a => a.uid));
    const labelsOn = new Set(k.labels || []);

    openModal(openCard.cardId ? 'Edit card' : 'New card on ' + esc(board.name),
      '<div class="field"><span class="label">What needs doing</span>' +
        '<input id="cdTitle" value="' + esc(k.title || '') + '" placeholder="e.g. Pick up 3 pallets of pavers"></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Column</span><select id="cdCol">' +
          board.columns.map(c => '<option value="' + c.id + '"' +
            (c.id === (k.column || openCard.column || board.columns[0].id) ? ' selected' : '') + '>' +
            esc(c.name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><span class="label">Due</span>' +
          '<input type="date" id="cdDue" value="' + esc(k.due || '') + '"></div>' +
      '</div>' +
      '<div class="field"><span class="label">Labels</span><div class="bd-pick">' +
        (board.labels || []).map(l => '<label class="bd-pick-item" style="--c:' + safeColor(l.color) + '">' +
          '<input type="checkbox" class="cdLabel" value="' + l.id + '"' + (labelsOn.has(l.id) ? ' checked' : '') + '>' +
          '<span class="bd-label">' + esc(l.name) + '</span></label>').join('') +
      '</div></div>' +
      (crew.length ? '<div class="field"><span class="label">Who is on it</span><div class="bd-pick">' +
        crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="cdWho" value="' + p.uid + '"' +
          (chosen.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') +
        '</div>' +
        (board.visibleTo && board.visibleTo.length ? '' :
          '<div class="hint">This board is not shared with anyone yet, so the people you pick ' +
          'here will not see it until you share it in Board settings.</div>') +
      '</div>' : '') +
      '<div class="field"><span class="label">Linked job</span><select id="cdJob">' +
        '<option value="">— none —</option>' +
        jobs.map(j => '<option value="' + j._id + '"' + (j._id === k.jobId ? ' selected' : '') + '>' +
          esc(j.customerName || 'Untitled job') + '</option>').join('') +
      '</select><div class="hint">Crew see only the job’s name, never its price.</div></div>' +
      '<div class="field"><span class="label">Notes</span>' +
        '<textarea id="cdNotes" rows="3" placeholder="Details, measurements, where to find things">' +
        esc(k.notes || '') + '</textarea></div>' +
      '<div class="field"><span class="label">Checklist — one item per line</span>' +
        '<textarea id="cdList" rows="4" placeholder="e.g.\n4 bags polymeric sand\nedge restraint">' +
        esc((k.checklist || []).map(i => (i.done ? '[x] ' : '') + i.text).join('\n')) + '</textarea>' +
        '<div class="hint">Start a line with [x] to mark it already done.</div></div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveCard()">Save</button>' +
        '<button class="btn btn-sm" onclick="' + (openCard.cardId ? 'renderCardDetail2()' : 'closeBoardModal()') + '">Cancel</button>' +
        (openCard.cardId ? '<button class="btn btn-sm" onclick="removeCard()">Delete card</button>' : '') +
      '</div>');
    const t = el('cdTitle'); if (t) t.focus();
  }
  window.renderCardDetail2 = function () { renderCardDetail(); };

  window.saveCard = function () {
    if (!openCard || !isOwner()) return;
    const board = boards[openCard.boardId];
    const title = val('cdTitle');
    if (!title) { showToast('Say what needs doing'); return; }
    const id = openCard.cardId || newId('cd');
    const was = (cards[board.id] || {})[id] || {};

    const oldList = was.checklist || [];
    const checklist = (el('cdList').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .map((line, i) => {
        const done = /^\[x\]\s*/i.test(line);
        const text = line.replace(/^\[x\]\s*/i, '');
        // Keep an item's id (and who ticked it) if the same line was there before.
        const prev = oldList.find(o => o.text === text);
        return { id: prev ? prev.id : 'ck' + i + Date.now().toString(36), text: text, done: done,
                 doneBy: done ? ((prev && prev.doneBy) || myName()) : null };
      });

    const crew = crewPeople();
    const assignees = Array.from(document.querySelectorAll('.cdWho:checked'))
      .map(i => crew.find(p => p.uid === i.value)).filter(Boolean)
      .map(p => ({ uid: p.uid, name: p.name }));
    const jobId = val('cdJob');
    const job = jobId ? jobsList().find(j => j._id === jobId) : null;
    const col = val('cdCol') || board.columns[0].id;
    const last = board.columns[board.columns.length - 1].id;

    const rec = {
      title: title,
      column: col,
      order: was.column === col && was.order != null ? was.order : endOrder(board.id, col),
      due: val('cdDue') || null,
      labels: Array.from(document.querySelectorAll('.cdLabel:checked')).map(i => i.value),
      assignees: assignees,
      jobId: job ? job._id : null,
      jobName: job ? (job.customerName || 'Untitled job') : null,
      notes: el('cdNotes').value.trim(),
      checklist: checklist,
      doneAt: col === last ? (was.doneAt || nowIso()) : null,
      createdAt: was.createdAt || nowIso(),
      createdBy: was.createdBy || myName(),
      updatedAt: nowIso(),
      updatedBy: myName(),
    };
    cards[board.id] = cards[board.id] || {};
    cards[board.id][id] = Object.assign({ id: id }, rec);
    openCard.cardId = id;
    render(); renderCardDetail();
    writeCard(board.id, id, rec);
  };

  function endOrder(boardId, col) {
    const inCol = Object.values(cards[boardId] || {}).filter(k => k.column === col);
    return inCol.length ? Math.max.apply(null, inCol.map(k => k.order || 0)) + 1000 : 1000;
  }

  window.removeCard = function () {
    if (!openCard || !isOwner()) return;
    const k = (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k || !confirm('Delete "' + k.title + '"?')) return;
    delete cards[openCard.boardId][openCard.cardId];
    const where = 'boards/' + openCard.boardId + '/cards';
    const id = openCard.cardId;
    closeBoardModal(); render();
    Promise.resolve(window.YDDb.remove(where, id))
      .catch(e => console.warn('[boards] card not removed:', e.code || e.message));
  };

  function crewPeople() {
    return Object.keys(people)
      .filter(uid => people[uid].active && (people[uid].role === 'crew' || people[uid].role === 'owner'))
      .map(uid => ({ uid: uid, name: people[uid].name || people[uid].email || 'Worker', role: people[uid].role }))
      .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------- board settings

  window.editBoard = function (id) {
    if (!isOwner()) return;
    editingBoard = id;
    const b = id ? boards[id] : {};
    const crew = crewPeople().filter(p => p.role === 'crew');
    const shared = new Set(b.visibleTo || []);
    const color = b.color || PALETTE[Object.keys(boards).length % PALETTE.length];

    openModal(id ? 'Board settings' : 'New board',
      '<div class="field"><span class="label">Name</span>' +
        '<input id="bdName" value="' + esc(b.name || '') + '" placeholder="e.g. Crew — this week"></div>' +
      '<div class="field"><span class="label">Colour</span><div class="bd-swatches">' +
        PALETTE.map(c => '<label class="bd-swatch" style="--c:' + c + '"><input type="radio" name="bdColor" value="' + c + '"' +
          (c === color ? ' checked' : '') + '><span></span></label>').join('') + '</div></div>' +
      (id ? '' :
        '<div class="field"><span class="label">Start from</span><select id="bdTemplate" onchange="bdTemplateChanged()">' +
          Object.keys(TEMPLATES).map(t => '<option value="' + t + '">' + TEMPLATES[t].label + '</option>').join('') +
        '</select></div>') +
      '<div class="field"><span class="label">Columns — one per line, left to right</span>' +
        '<textarea id="bdCols" rows="4">' + esc((b.columns || TEMPLATES.crew.columns.map(n => ({ name: n })))
          .map(c => c.name).join('\n')) + '</textarea>' +
        '<div class="hint">The last column counts as done. Renaming a column keeps its cards; ' +
        'deleting one moves its cards to the first column.</div></div>' +
      '<div class="field"><span class="label">Labels — one per line, as Name #colour (colour optional)</span>' +
        '<textarea id="bdLabels" rows="4">' + esc((b.labels || DEFAULT_LABELS)
          .map(l => l.name + ' ' + l.color).join('\n')) + '</textarea></div>' +
      '<div class="field"><span class="label">Who can see it</span>' +
        (crew.length
          ? '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="bdShare" value="' +
              p.uid + '"' + (shared.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') + '</div>' +
            '<div class="hint">Anyone ticked sees this board and its cards, can move cards and tick ' +
            'checklists. They cannot add, edit or delete cards. Leave everyone unticked to keep it to yourself.</div>'
          : '<div class="hint">No crew accounts yet. Once someone signs in and you approve them, they appear here.</div>') +
      '</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveBoard()">Save</button>' +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Cancel</button>' +
        (id ? '<button class="btn btn-sm" onclick="removeBoard(\'' + id + '\')">Delete board</button>' : '') +
      '</div>');
    const n = el('bdName'); if (n) n.focus();
  };

  window.bdTemplateChanged = function () {
    const t = TEMPLATES[val('bdTemplate')] || TEMPLATES.blank;
    el('bdCols').value = t.columns.join('\n');
  };

  function parseLabels(text, old) {
    return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((line, i) => {
      const m = line.match(/^(.*?)\s*(#[0-9a-fA-F]{6})?$/);
      const name = (m ? m[1] : line).trim() || 'Label';
      const prev = (old || []).find(l => l.name.toLowerCase() === name.toLowerCase());
      return { id: prev ? prev.id : 'lb' + i + Date.now().toString(36),
               name: name, color: (m && m[2]) || (prev && prev.color) || PALETTE[i % PALETTE.length] };
    });
  }

  window.saveBoard = function () {
    if (!isOwner()) return;
    const name = val('bdName');
    if (!name) { showToast('Give the board a name'); return; }
    const id = editingBoard || newId('bd');
    const was = boards[id] || {};
    const oldCols = was.columns || [];
    const names = el('bdCols').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!names.length) { showToast('A board needs at least one column'); return; }
    // Columns keep their id by position, so renaming "Doing" to "In progress"
    // leaves its cards where they are.
    const columns = names.map((n, i) => ({ id: oldCols[i] ? oldCols[i].id : 'col' + i + Date.now().toString(36), name: n }));
    const colorInput = document.querySelector('input[name="bdColor"]:checked');

    const rec = {
      name: name,
      color: colorInput ? colorInput.value : PALETTE[0],
      columns: columns,
      labels: parseLabels(el('bdLabels').value, was.labels),
      visibleTo: Array.from(document.querySelectorAll('.bdShare:checked')).map(i => i.value),
      order: was.order != null ? was.order : Object.keys(boards).length + 1,
      createdAt: was.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    boards[id] = Object.assign({ id: id }, rec);
    write('boards', id, rec, 'saving the board');

    // Cards in a column that no longer exists go to the first column rather
    // than vanishing from view.
    const live = new Set(columns.map(c => c.id));
    Object.values(cards[id] || {}).forEach(k => {
      if (!live.has(k.column)) {
        k.column = columns[0].id;
        writeCard(id, k.id, { column: columns[0].id, updatedAt: nowIso(), updatedBy: myName() });
      }
    });

    if (!cardUnsubs[id]) watchCards(id);
    closeBoardModal();
    current = id;
    render();
    showToast(name + ' saved');
  };

  window.removeBoard = function (id) {
    const b = boards[id];
    if (!b) return;
    const n = Object.keys(cards[id] || {}).length;
    if (!confirm('Delete the board "' + b.name + '"' + (n ? ' and its ' + n + ' card' + (n === 1 ? '' : 's') : '') +
                 '? This cannot be undone.')) return;
    const ids = Object.keys(cards[id] || {});
    if (cardUnsubs[id]) { cardUnsubs[id](); delete cardUnsubs[id]; }
    delete boards[id]; delete cards[id];
    current = null;
    closeBoardModal(); render();
    // Cards first: a card left behind under a deleted board would be
    // unreachable, since the rules check the board to decide who may read it.
    Promise.all(ids.map(cid => window.YDDb.remove('boards/' + id + '/cards', cid)))
      .then(() => window.YDDb.remove('boards', id))
      .catch(e => console.warn('[boards] board not fully removed:', e.code || e.message));
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
    cardUnsubs[boardId] = window.YDDb.watch('boards/' + boardId + '/cards', changes => {
      const set = cards[boardId] = cards[boardId] || {};
      changes.forEach(c => {
        if (c.type === 'removed') delete set[c.id];
        else set[c.id] = Object.assign({ id: c.id }, c.data);
      });
      redrawIfVisible();
      // The calendar shows cards with due dates.
      document.dispatchEvent(new CustomEvent('yd-cards-changed'));
      if (openCard && openCard.boardId === boardId && openCard.cardId && !document.getElementById('cdTitle')) {
        renderCardDetail();
      }
    });
  }

  function onBoards(changes, meta) {
    changes.forEach(c => {
      if (c.type === 'removed') {
        delete boards[c.id];
        if (cardUnsubs[c.id]) { cardUnsubs[c.id](); delete cardUnsubs[c.id]; }
        delete cards[c.id];
      } else {
        boards[c.id] = Object.assign({ id: c.id }, c.data);
        watchCards(c.id);
      }
    });
    // Only seed once the server has actually answered. An empty answer from the
    // local cache on a fresh phone would otherwise create the starter boards a
    // second time.
    if (isOwner() && !seeded && meta && !meta.fromCache) {
      seeded = true;
      if (!Object.keys(boards).length) seedBoards();
    }
    redrawIfVisible();
  }

  // Two boards to start with, so the screen is not empty on day one. Fixed ids
  // mean two devices seeding at once write the same two boards, not four.
  function seedBoards() {
    const mk = (id, name, color, tpl, order) => ({
      name: name, color: color, order: order, visibleTo: [],
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

  function redrawIfVisible() {
    const p = el('panel-boards');
    if (p && p.classList.contains('active')) render();
  }

  function stop() {
    if (unsubBoards) { unsubBoards(); unsubBoards = null; }
    if (unsubPeople) { unsubPeople(); unsubPeople = null; }
    Object.values(cardUnsubs).forEach(u => u());
    cardUnsubs = {}; boards = {}; cards = {}; people = {}; seeded = false; current = null;
  }

  function start(a) {
    stop();
    if (!window.YDDb || !a.user) return;
    if (a.isOwner) {
      unsubBoards = window.YDDb.watch('boards', onBoards);
      unsubPeople = window.YDDb.watch('users', changes => {
        changes.forEach(c => {
          if (c.type === 'removed') delete people[c.id];
          else people[c.id] = c.data;
        });
        redrawIfVisible();
      });
    } else {
      // Crew may only ask for the boards that list them.
      unsubBoards = window.YDDb.watchContains('boards', 'visibleTo', a.user.uid, onBoards,
        () => redrawIfVisible());
    }
  }

  window.YDBoards = {
    render: render,
    boards: () => boards,
    cards: () => cards,
    people: () => people,
    // For the calendar: every stored card with a due date, with its board.
    dueCards: () => {
      const out = [];
      Object.keys(cards).forEach(bid => {
        const b = boards[bid];
        if (!b) return;
        const last = b.columns[b.columns.length - 1].id;
        Object.values(cards[bid]).forEach(k => {
          if (k.due) out.push({ board: b, card: k, done: k.column === last });
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
  });
  document.addEventListener('yd-jobs-changed', redrawIfVisible);

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
