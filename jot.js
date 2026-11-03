// What a note jotted on Home is for -- and doing it there and then.
//
// Jonah (2 Nov 2026): "i want jot a note to include the option to jot a note
// that is for someone. like if i write have cesar pickup blank itll auto add
// to calendar" -- and then "i want the jot a note to actively learn ... so
// that eventually it is capable of auto doing most things i jot into it".
//
// A note knows where it goes two ways, both plain code ("code over Claude":
// nothing here is sent anywhere):
//   - It says who it is for: "have Cesar pick up mulch", "tell Cesar to ...",
//     "Cesar: ...", "@Cesar". It goes on the Crew schedule with them on it,
//     on the day it names (today when none) at the time it names (any time
//     that day when none) -- by itself, as he asked, with Undo. "👤 For
//     someone" under the box does the same for a note that names nobody.
//   - It is like notes sorted before. Each note put somewhere (a tap on
//     where it goes, from the box or from Notes to sort) is kept as an
//     example of where notes with those words go -- on this person's own
//     inbox board (boards.js learnedNotes), so every device of theirs knows
//     it. A new note is weighed against them (naive Bayes over its words).
//     Once notes like it have gone to one place AUTO_AFTER times, and
//     nothing says otherwise, Add puts it there by itself, with Undo; an
//     Undo is kept as a "not there" for notes like it, so it goes back to
//     asking until more have been sorted there. Short of that, the place it
//     most likely goes is a one-tap button (and that tap teaches it too).
// Before anything is done the box says what Add will do, with "Just a note"
// to keep it a note to sort instead (home.js).

(function () {
  'use strict';

  const CREW_CAL = 'crewtasks';
  // Notes like this one put in the same place this many times: done by itself.
  const AUTO_AFTER = 3;
  // How sure the weighing must be to do it by itself, and to offer it.
  const AUTO_SURE = 0.85, OFFER_SURE = 0.6;
  // What is kept: the newest examples and "not there"s.
  const MAX_EXAMPLES = 400, MAX_NOS = 100;

  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const two = n => String(n).padStart(2, '0');
  const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return localYMD(d); }
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
  const canFor = () => !!(window.YDCalendar && YDCalendar.canAddTo && YDCalendar.canAddTo(CREW_CAL));

  // ------------------------------------------------- the day and the time
  //
  // Counted from the day the note was written: "tomorrow" in a note from
  // yesterday is today.
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  // A number followed by one of these is an amount, never a time or a date
  // ("1/2 yard", "at 3 tons").
  const UNIT = '(?:yds?|yards?|tons?|t\\b|bags?|pallets?|ft|feet|foot|in\\b|inch(?:es)?|lbs?|pounds?|gal(?:lons?)?|cu|sq|%|pcs?|pieces?|rolls?|boxes?|loads?)';
  const TODAY_RE = /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i;
  const TOMORROW_RE = /\b(?:tomorrow|tomorow|tommorow|tommorrow|tmrw|tmr|tmw)\b(?:\s+(?:morning|afternoon|evening|night))?/i;
  const NEXT_WEEK_RE = /\bnext week\b/i;
  // "friday", "on fri", "next tuesday", "thurs" -- not "Sun Prairie", and a
  // bare "sun" or "sat" is not a day.
  const WEEKDAY_RE = /\b(?:(on|this|next|by)\s+)?(sun(?:day)?|mon(?:day)?|tues?(?:day)?|weds?(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b(?:\s+(?:morning|afternoon|evening|night))?(?!\s+prairie)/i;
  const DATE_RE = new RegExp('(?:\\b(?:on|by|for|due)\\s+)?\\b(1[0-2]|0?[1-9])/(3[01]|[12]\\d|0?[1-9])(?:/(\\d{4}|\\d{2}))?\\b(?!\\s*' + UNIT + ')', 'i');
  const NOON_RE = /\b(?:at\s+|around\s+)?noon\b/i;
  const TIME_AMPM_RE = /(?:\b(?:at|around)\s+|@\s*)?\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/i;
  const TIME_AT_RE = new RegExp('(?:^|\\s)(?:at|@|around)\\s*(\\d{1,2})(?::([0-5]\\d))?(?![\\d:/])(?!\\s*' + UNIT + ')\\b', 'i');

  // "at 2" is the afternoon; "at 7" the morning.
  function hhmm(h, m, ap) {
    h = Number(h); m = Number(m || 0);
    ap = String(ap || '').toLowerCase().charAt(0);
    if (ap === 'p' && h < 12) h += 12;
    else if (ap === 'a' && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 6) h += 12;
    if (h > 23 || m > 59) return '';
    return two(h) + ':' + two(m);
  }
  function weekday(m, base) {
    const word = m[2].toLowerCase();
    if (!m[1] && (word === 'sun' || word === 'sat')) return '';
    const want = WEEKDAYS.indexOf(word.slice(0, 3));
    if (want < 0) return '';
    let ahead = (want - new Date(base + 'T12:00:00').getDay() + 7) % 7;
    if (ahead === 0 && /^next$/i.test(m[1] || '')) ahead = 7;
    return addDays(base, ahead);
  }
  function nextWeek(base) {
    return addDays(base, (1 - new Date(base + 'T12:00:00').getDay() + 7) % 7 || 7);
  }
  // "11/5": the next 5 Nov -- and only within two months, or it is more
  // likely an amount ("1/2 of the pile").
  function monthDay(m, base) {
    const y0 = Number(base.slice(0, 4));
    const y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : y0;
    let d = y + '-' + two(m[1]) + '-' + two(m[2]);
    if (!m[3] && d < base) d = (y0 + 1) + d.slice(4);
    if (!m[3] && daysBetween(base, d) > 60) return '';
    const t = new Date(d + 'T12:00:00');
    return isNaN(t) || localYMD(t) !== d ? '' : d;
  }
  // The day and time a line names, and its words with them taken out.
  function whenOf(line, base) {
    let s = ' ' + line + ' ';
    const take = (re, read) => {
      const m = re.exec(s);
      const got = m ? read(m) : '';
      if (got) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      return got;
    };
    const time = take(NOON_RE, () => '12:00') || take(TIME_AMPM_RE, m => hhmm(m[1], m[2], m[3])) ||
      take(TIME_AT_RE, m => hhmm(m[1], m[2], ''));
    const date = take(TODAY_RE, () => base) || take(TOMORROW_RE, () => addDays(base, 1)) ||
      take(NEXT_WEEK_RE, () => nextWeek(base)) || take(WEEKDAY_RE, m => weekday(m, base)) || take(DATE_RE, m => monthDay(m, base));
    return { date: date, time: time, rest: s };
  }

  // ------------------------------------------------------ who it is for
  //
  // The people a note can be for: whoever the calendar's editor lists --
  // not this person, and never the owner (a note of his is his already).
  // Each goes by their first name, or the whole name when two share it.
  function folks() {
    const list = window.YDCalendar && YDCalendar.people ? YDCalendar.people() : [];
    const mine = (me() || {}).uid;
    const out = list.filter(p => p.uid !== mine && p.role !== 'owner').map(p => {
      const words = String(p.name || '').toLowerCase().replace(/[^a-z' -]/g, ' ').trim().split(/\s+/).filter(Boolean);
      return { uid: p.uid, name: String(p.name || ''), first: words[0] || '', full: words.join(' ') };
    }).filter(p => p.first.length >= 2);
    const n = {};
    out.forEach(p => { n[p.first] = (n[p.first] || 0) + 1; });
    out.forEach(p => { p.calls = [p.full].concat(n[p.first] === 1 && p.full !== p.first ? [p.first] : []); });
    return out;
  }
  // Words after a name that make the note ABOUT them, not for them:
  // "Cesar said the Bobcat is leaking", "Cesar's check".
  const NOT_FOR = "said|says|told|tells|think|thinks|thought|wants|wanted|asked|asks|called|calls|texted|texts|mentioned|" +
    "noticed|saw|found|forgot|broke|quit|left|is|was|isn'?t|wasn'?t|has(?!\\s+to)|had|does|did|didn'?t|doesn'?t|got|gets";
  // Who a note says it is for, and its words without saying so -- or null.
  function forWhom(line, people) {
    if (!people.length) return null;
    const calls = [];
    people.forEach(p => p.calls.forEach(c => calls.push([c, p])));
    calls.sort((a, b) => b[0].length - a[0].length);
    const NAME = '(?:' + calls.map(c => reEsc(c[0]).replace(/ /g, '\\s+')).join('|') + ')';
    const LIST = NAME + '(?:\\s*(?:,|&|\\+|\\band\\b)\\s*' + NAME + ')*';
    const MINE = "(?!['’]s\\b)";
    const tries = [
      // "have Cesar pick up ...", "tell Cesar to ...", "remind Cesar ..."
      new RegExp('^\\s*(?:please\\s+)?(?:have|tell|ask|remind|let|need|want)\\s+(' + LIST + ')\\b' + MINE + '(?:\\s+to\\b)?', 'i'),
      // "get Cesar to ...", "send Cesar to ..." (not "get Cesar a shovel")
      new RegExp('^\\s*(?:please\\s+)?(?:get|send|make)\\s+(' + LIST + ')\\b' + MINE + '\\s+to\\b', 'i'),
      // "Cesar: ...", "Cesar - ...", "Cesar pick up ...", "for Cesar: ..."
      new RegExp('^\\s*(?:for\\s+)?(' + LIST + ')\\b' + MINE + '(?!\\s+(?:' + NOT_FOR + ')\\b)' +
        '(?:\\s*[:,\\-–—]+|\\s+(?:to|needs?\\s+to|should|can|could|has\\s+to|please)\\b)?', 'i'),
      // Further on: "tomorrow have Cesar ...", "... @Cesar"
      new RegExp('(?:^|\\s)(?:have|tell|ask|remind)\\s+(' + LIST + ')\\b' + MINE + '(?:\\s+to\\b)?', 'i'),
      new RegExp('@(' + LIST + ')\\b', 'i'),
    ];
    for (const re of tries) {
      const m = re.exec(line);
      if (!m) continue;
      const who = [];
      m[1].split(/\s*(?:,|&|\+|\band\b)\s*/i).forEach(x => {
        const hit = calls.find(c => c[0] === x.trim().toLowerCase().replace(/\s+/g, ' '));
        if (hit && who.indexOf(hit[1]) === -1) who.push(hit[1]);
      });
      if (who.length) return { who: who, rest: line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length) };
    }
    return null;
  }
  // What is left, as a title: no dangling "to", "at" or dashes, a capital
  // first letter.
  function tidyTitle(s) {
    s = String(s || '').replace(/\s+/g, ' ')
      .replace(/^[\s,:;.\-–—]+/, '').replace(/^(?:to|please|and)\s+/i, '')
      .replace(/\s+(?:at|on|by|for|around|@)\s*$/i, '').replace(/[\s,;:\-–—]+$/, '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  // ------------------------------------------------- what notes taught
  //
  // A note's words as an example: lower case, no small words, no numbers,
  // "pick up" one word, plurals as one, and anybody named as "@p" -- so
  // "have Cesar pick up mulch" and "have <anyone else> pick up stone" are
  // alike.
  const STOP = new Set(('a an the to of for and or on in at by with from up out it its is be are was this that these those ' +
    'my our your his her their me we us you he she they them have has had do does did get got go need needs want wants ' +
    'please make sure just also then about some any all can could should would will there here so if as but not no yes ' +
    'ok okay asap again more tell ask remind let').split(' '));
  function wordsOf(line, people) {
    let s = ' ' + String(line || '').toLowerCase().replace(/[’]/g, "'") + ' ';
    s = s.replace(/\bpick\s?-?\s?ups?\b/g, ' pickup ').replace(/\bdrop\s?-?\s?offs?\b/g, ' dropoff ');
    (people || []).forEach(p => p.calls.forEach(c => {
      s = s.replace(new RegExp('@?\\b' + reEsc(c).replace(/ /g, '\\s+') + "(?:'s)?\\b", 'g'), ' @p ');
    }));
    const out = [];
    s.replace(/[^a-z0-9@' ]+/g, ' ').split(/\s+/).forEach(w => {
      w = w.replace(/'s$/, '').replace(/'/g, '');
      if (w !== '@p' && (w.length < 3 || /\d/.test(w) || STOP.has(w))) return;
      w = w.length > 4 && /ies$/.test(w) ? w.slice(0, -3) + 'y' : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w;
      if (out.indexOf(w) === -1) out.push(w);
    });
    return out.slice(0, 16);
  }
  function lessons() {
    const L = window.YDBoards && YDBoards.learnedNotes ? YDBoards.learnedNotes() : null;
    return {
      ex: Array.isArray(L && L.ex) ? L.ex.filter(e => e && typeof e.w === 'string' && typeof e.to === 'string') : [],
      no: Array.isArray(L && L.no) ? L.no.filter(e => e && typeof e.w === 'string' && typeof e.not === 'string') : [],
    };
  }
  function keep(L) {
    return !!(window.YDBoards && YDBoards.learnFromNotes &&
      YDBoards.learnFromNotes({ ex: L.ex.slice(-MAX_EXAMPLES), no: L.no.slice(-MAX_NOS), v: 1 }));
  }
  // One more example; its id, for an Undo to take it back.
  function learn(words, to) {
    if (!words.length || !to) return '';
    const L = lessons();
    const id = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    L.ex.push({ w: words.join(' '), to: to, at: localYMD(), id: id });
    return keep(L) ? id : '';
  }
  // Undone: the example goes, and -- when it was done by itself from what
  // was learned (`no` true) -- notes like it are not done there by
  // themselves again until more are sorted there.
  function unlearn(id, words, to, no) {
    const L = lessons();
    L.ex = L.ex.filter(e => e.id !== id);
    if (no && words.length) L.no.push({ w: words.join(' '), not: to, at: localYMD() });
    keep(L);
  }
  // Two notes are alike when they share at least half the words of the
  // shorter.
  function alike(a, b) {
    const n = a.filter(w => b.indexOf(w) !== -1).length;
    return n > 0 && n * 2 >= Math.min(a.length, b.length);
  }
  // Where notes with these words have gone: the likeliest place, how sure
  // (0-1, among the places notes went), how many notes alike went there,
  // and whether an Undo said "not there" for one like it.
  function weigh(words, L) {
    if (!words.length || !L.ex.length) return null;
    const by = {}, vocab = new Set();
    L.ex.forEach(e => {
      const ws = e.w.split(' ').filter(Boolean);
      const d = by[e.to] = by[e.to] || { n: 0, count: {}, total: 0, like: 0 };
      d.n++;
      ws.forEach(w => { d.count[w] = (d.count[w] || 0) + 1; d.total++; vocab.add(w); });
      if (alike(words, ws)) d.like++;
    });
    const known = words.filter(w => vocab.has(w));
    if (!known.length) return null;
    const V = vocab.size + 1, N = L.ex.length;
    const scored = Object.keys(by).map(to => {
      const d = by[to];
      let s = Math.log(d.n / N);
      known.forEach(w => { s += Math.log(((d.count[w] || 0) + 1) / (d.total + V)); });
      return { to: to, s: s, d: d };
    }).sort((a, b) => b.s - a.s);
    const sum = scored.reduce((t, x) => t + Math.exp(x.s - scored[0].s), 0);
    const best = scored[0];
    return { to: best.to, p: 1 / sum, like: best.d.like,
             blocked: L.no.some(x => x.not === best.to && alike(words, x.w.split(' '))) };
  }

  // ----------------------------------------------------------- the places
  //
  // Where a note can go, as a key: 'c:<calendar>' -- an entry -- or
  // 'b:<board>' -- a card; its kind, job and people are the board's
  // reading of the note's words each time (boards.js), so every note sorted
  // to a board counts towards it, whatever kind each one was.
  function calPlan(calId, info) {
    const today = localYMD();
    return { how: 'cal', to: 'c:' + calId, calId: calId, title: info.title, notes: info.more,
             date: info.date && info.date > today ? info.date : today, time: info.time, crew: info.crew, info: info };
  }
  // A card from a note that named a day has it as its due date (its words
  // without it), the time too.
  function boardPlan(s, info) {
    const today = localYMD();
    const due = info.date ? (info.date > today ? info.date : today) : info.time ? today : '';
    return { how: 'board', to: 'b:' + s.boardId, s: s, info: info,
             due: due, dueTime: due ? info.time : '', title: due ? info.title : '' };
  }
  function planFor(to, info, text) {
    if (to.indexOf('c:') === 0) return YDCalendar.canAddTo(to.slice(2)) ? calPlan(to.slice(2), info) : null;
    if (to.indexOf('b:') !== 0 || !YDBoards.noteOnBoard) return null;
    const boardId = to.slice(2).split(':')[0];
    // The kind the board's own reading gives, when it picks this board too.
    const rule = YDBoards.noteSuggest ? YDBoards.noteSuggest(text) : null;
    const s = YDBoards.noteOnBoard(text, boardId, rule && rule.boardId === boardId ? rule.type : null);
    return s ? boardPlan(s, info) : null;
  }

  // What a note is for. `opts`: { base (the day it was written), pick {who
  // [uids] -- tapped under the box, [] = nobody -- and day}, plain (he
  // tapped "Just a note") }. Back: { auto (what Add does by itself, or
  // null), offer (a tap to put it there now, or null), forCan (whether it
  // can be put on someone), people } -- or null for no note.
  function read(text, opts) {
    opts = opts || {};
    if (!window.YDBoards || !window.YDCalendar || !window.YDRemind) return null;
    const lines = String(text || '').trim().split(/\r?\n/);
    const line = lines[0] || '';
    if (!line.trim()) return null;
    const today = localYMD();
    const base = opts.base && opts.base < today ? opts.base : today;
    const forCan = canFor();
    const people = forCan ? folks() : [];
    const when = whenOf(line, base);
    const named = forWhom(when.rest, people);
    const pick = opts.pick || {};
    const picked = Array.isArray(pick.who) ? people.filter(p => pick.who.indexOf(p.uid) !== -1) : null;
    const info = {
      line: line, more: lines.slice(1).join('\n').trim(),
      title: tidyTitle(named ? named.rest : when.rest) || line.trim(),
      date: pick.day || when.date, time: when.time,
      crew: (picked || (named ? named.who : [])).map(p => ({ uid: p.uid, name: p.name })),
      words: wordsOf(when.rest, people),
    };
    let auto = null, offer = null;
    if (opts.plain) {
      // Kept a note: nothing done, nothing offered.
    } else if (info.crew.length && forCan) {
      auto = calPlan(CREW_CAL, info);
      auto.why = picked ? 'picked' : 'named';
    } else {
      const w = weigh(info.words, lessons());
      const learned = w && w.p >= OFFER_SURE && w.like >= 1 ? planFor(w.to, info, text) : null;
      if (learned) {
        learned.why = 'learned'; learned.times = w.like;
        if (w.p >= AUTO_SURE && w.like >= AUTO_AFTER && !w.blocked) auto = learned; else offer = learned;
      } else {
        const s = YDBoards.noteSuggest ? YDBoards.noteSuggest(lines.join('\n')) : null;
        if (s) { offer = boardPlan(s, info); offer.why = 'guess'; }
      }
    }
    return { auto: auto, offer: offer, forCan: forCan && people.length > 0, people: people };
  }

  // ------------------------------------------------------------ the words
  const dayWords = ymd => {
    const t = localYMD();
    return ymd === t ? 'today' : ymd === addDays(t, 1) ? 'tomorrow'
      : new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const timeWords = t => { const h = Number(t.slice(0, 2)), m = t.slice(3); return (h % 12 || 12) + (m === '00' ? '' : ':' + m) + (h < 12 ? 'am' : 'pm'); };
  const firstNames = list => list.map(p => String(p.name || '').split(' ')[0]).join(' & ');
  // Where a plan puts the note, in words: "Cesar’s day · tomorrow 9am ·
  // 🧱 Material pickup" or "Pickups · 🧱 Material pickup · due Friday".
  function says(plan) {
    if (!plan) return '';
    if (plan.how === 'cal') {
      const cal = YDCalendar.cal(plan.calId);
      const tag = cal ? YDRemind.tagOf(YDRemind.typeOf({ title: plan.title }, { cal: cal }), cal) : null;
      return [plan.crew.length ? firstNames(plan.crew) + '’s day' : (cal ? cal.name : 'the calendar') + ' (anyone)',
        dayWords(plan.date) + (plan.time ? ' ' + timeWords(plan.time) : ''),
        tag ? (tag.icon ? tag.icon + ' ' : '') + tag.name : ''].filter(Boolean).join(' · ');
    }
    const s = plan.s;
    return [s.boardName || 'Board', s.kind ? s.kind.icon + ' ' + s.kind.name : '', s.job ? '📐 ' + s.job.name : '',
      s.people.length ? '👤 ' + s.people.map(p => p.name).join(', ') : '',
      plan.due ? 'due ' + dayWords(plan.due) + (plan.dueTime ? ' ' + timeWords(plan.dueTime) : '') : ''].filter(Boolean).join(' · ');
  }

  // ----------------------------------------------------------- doing it
  //
  // `cardId`: the note's card on the inbox, when it is sorted from there
  // (it leaves the inbox). Back: { said, undo } -- undo takes it back and
  // keeps the note as a note to sort -- or null when it could not be done
  // (then nothing was).
  function act(text, plan, cardId) {
    if (!plan) return null;
    const words = plan.info.words;
    const learnt = plan.why === 'learned';
    if (plan.how === 'cal') {
      const id = YDCalendar.addFromNote(plan.calId, { title: plan.title, date: plan.date, time: plan.time, crew: plan.crew, notes: plan.notes });
      if (!id) return null;
      if (cardId) YDBoards.dropNoteCard(YDBoards.inboxId(), cardId);
      const lesson = learn(words, plan.to);
      return { said: '📅 On ' + says(plan), undo: () => {
        YDCalendar.dropFromNote(plan.calId, id);
        unlearn(lesson, words, plan.to, learnt);
        YDBoards.inboxAdd(text);
      } };
    }
    const more = Object.assign({}, plan.s, plan.due ? { due: plan.due, dueTime: plan.dueTime, title: plan.title } : {});
    if (cardId) {
      if (!YDBoards.inboxSort(cardId, plan.s.boardId, more)) return null;
      learn(words, plan.to);
      return { said: 'Moved to ' + says(plan), undo: null };
    }
    const id = YDBoards.cardFromNote(plan.s.boardId, text, more);
    if (!id) return null;
    const lesson = learn(words, plan.to);
    return { said: 'On ' + says(plan), undo: () => {
      YDBoards.dropNoteCard(plan.s.boardId, id);
      unlearn(lesson, words, plan.to, learnt);
      YDBoards.inboxAdd(text);
    } };
  }
  // A note sorted by hand onto a board ("Somewhere else"): an example of
  // where notes like it go.
  function sorted(text, boardId) {
    const line = String(text || '').trim().split(/\r?\n/)[0] || '';
    const people = canFor() ? folks() : [];
    learn(wordsOf(whenOf(line, localYMD()).rest, people), 'b:' + boardId);
  }
  // How many notes it has learnt from (the box says so once it starts doing
  // things by itself).
  const learnt = () => lessons().ex.length;
  // A first name for the box's hint ("have Cesar pick up …"): someone on
  // the crew list, '' when nobody can be put on a day from here.
  const example = () => { const p = canFor() ? folks()[0] : null; return p ? p.name.split(' ')[0] : ''; };

  window.YDJot = { read: read, act: act, says: says, sorted: sorted, learnt: learnt, example: example, AUTO_AFTER: AUTO_AFTER,
    // For checking by hand in the console: what a line reads as.
    _whenOf: whenOf, _wordsOf: wordsOf };
})();
