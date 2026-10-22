// What kind of thing a calendar entry or a board card is, and when it buzzes
// the phone without anybody setting a reminder on it.
//
// Jonah (12 Oct 2026): "i want all of my things on the calendar to auto send
// notifications to my phone", "every card thats mine" too -- and to pick what
// each one is, "a quote appointment or a material pickup, because some stuff
// on the calendar just needs to be done that day but not at a specific time".
// Bids ping an hour before AND half an hour before. Each kind has its own
// colour ("blue should be crew tasks ie: things not for jonah to handle",
// pink personal, yellow doctors, green quotes).
//
// The usual reminder (functions/reminders.py _usual sends it, by the same
// rules):
//   - anything at a set time: 30 minutes before; a bid appointment 1 hour
//     and 30 minutes before;
//   - anything for no particular time (all day, a pickup, a to-do): one list
//     at 7 am of all of that day's -- the calendar's "any time today"
//     checklist, on the phone -- headed by any task from an earlier day that
//     was never ticked off (isTask);
//   - to whoever it is theirs (isMine): the people on it; with nobody on it,
//     a crew task goes to every crew member and anything else to whoever
//     made it (the owner, mostly).
// A thing's own Remind box overrides the usual one for the people it
// reminds, and "No reminder" switches it off for everyone. Ticked off,
// nothing.
//
// Who gets the usual reminders: everyone with "Remind me of everything" on
// (Notifications & summaries -- on unless they switch it off; Jonah, 12 Oct:
// "make it so crew members can get notifications"), for every calendar
// entry and card that is theirs, and the owner for each machine due.

(function () {
  'use strict';

  // `timed`: whether it usually happens at a set time -- a hint only; the
  // entry's own "Any time that day" box (or a card's Time) decides, and
  // picking a kind never changes it (Jonah, 15 Oct 2026). `color`: each kind has its own on the calendar. Jonah
  // (15 Oct 2026): "i just want tags and assigned colors for different
  // things" -- quote appointments green and marked "QP" ("to save lettering
  // on the screen"), crew tasks blue, doctor's appointments yellow, the rest
  // of Personal pink; the others ours to pick, as far apart as we could.
  // Kinds never use the urgency colours' meaning (styles.css --st-*): late
  // red, today orange, coming up yellow, whenever grey -- the doctor's
  // yellow is his pick, and lives only on Personal. `ink`: dark writing on
  // a light colour.
  // `appointment`: it simply happens at its time -- nobody ticks it off
  // (isTask below).
  // These are the tags every calendar's own list is made from (CAL_TAGS
  // below); `calOnly`: not offered for a board card (boards.js).
  const TYPES = [
    { id: 'bid', icon: 'QP', name: 'Quote appointment', timed: true, color: '#2f8f5b', appointment: true },
    { id: 'appt', icon: '🕑', name: 'Appointment', timed: true, color: '#7a4fd1', appointment: true },
    // Jonah (22 Oct 2026): "add a phone call tag for calendar items" -- and
    // "calls dont always have set times tho they can be something to do at
    // any time during a day or can be scheduled". So no usual time either
    // way (`timed` null): one at a set time buzzes before it as an
    // appointment does; one for any time that day is in the 7 am list. Either
    // way it is a call to MAKE ("Call in ... material orders", "Call <a
    // customer>"): ticked off when made, carried to the next days when not,
    // as those entries were as to-dos before the tag existed. Orchid: as far
    // from every other tag's colour and the urgency colours as there was
    // room for; white writing reads on it.
    { id: 'phone', icon: '📞', name: 'Phone call', timed: null, color: '#c026d3' },
    // Jonah (22 Oct 2026): "make material pickup tag option for the
    // calendar". It was always a material pickup in his words ("a quote
    // appointment or a material pickup", 12 Oct; a store's "ready for
    // pickup" order) and the Crew schedule called it that, while My work and
    // board cards said only "Pickup" -- one tag under two names. One name
    // now, everywhere; the id stays 'pickup', so every entry and card
    // already tagged keeps its tag.
    { id: 'pickup', icon: '🚚', name: 'Material pickup', timed: false, color: '#8b5a2b' },
    // And then (22 Oct): "pickups are a thing we do often. So there should
    // be material, rental, parts, check, and equipment (as in our
    // equipment)". Each its own tag, on My work and the Crew schedule,
    // after the material one. 🚜 is our own equipment everywhere in Job Hub
    // (the Equipment tab), so a rental is the 🔑; 💵 is money coming in, as
    // on Home and Invoices. Colours: the free places left among every other
    // tag's and the urgency colours (ΔE ≥ 15 from all of them; deep rust,
    // salmon, kraft tan, dark olive brown); dark writing on the two light
    // ones.
    { id: 'rental', icon: '🔑', name: 'Rental pickup', timed: false, color: '#702018' },
    { id: 'parts', icon: '🔩', name: 'Parts pickup', timed: false, color: '#f09888', ink: '#3a1a10' },
    { id: 'check', icon: '💵', name: 'Check pickup', timed: false, color: '#c8a880', ink: '#2b1d0e' },
    { id: 'equipment', icon: '🚜', name: 'Equipment pickup', timed: false, color: '#504028' },
    { id: 'delivery', icon: '🚛', name: 'Delivery', timed: false, color: '#2a3d8f' },
    { id: 'email', icon: '✉️', name: 'Email to send', timed: false, color: '#13a7c4', ink: '#04313b' },
    { id: 'todo', icon: '✅', name: 'To do that day', timed: false, color: '#8ab81e', ink: '#1d2600' },
    // The Crew schedule's own (Jonah, 16 Oct 2026: "The crew calendar should
    // have tags and set colors for material pickups etc."), in the clock-in
    // choices' words (timeclock.js: Shop / yard work, Equipment repair,
    // Pickups + errands). Colours of their own, clear of every other tag's
    // and of the urgency colours: deep teal, moss green, magenta.
    { id: 'repair', icon: '🔧', name: 'Equipment repair', timed: false, color: '#0f766e', crew: true, calOnly: true },
    { id: 'shop', icon: '🛠️', name: 'Shop / yard work', timed: false, color: '#4d6b1a', crew: true, calOnly: true },
    // The bank, the post office, something to drop off (a check to collect
    // is a Check pickup).
    { id: 'errand', icon:'🧾', name: 'Errand', timed: false, color: '#a3369b', crew: true, calOnly: true },
    // "Things not for Jonah to handle": on his calendar so he sees them all,
    // but they buzz only the people on them.
    { id: 'crew', icon: '👷', name: 'Crew task', timed: false, color: '#2f6fd6', crew: true },
    // A day of work on a job -- who is working where: everything on the Job
    // schedule (Jonah, 16 Oct 2026: "the job calendar will be solely for
    // where the crew is working each day"). No tick box (15 Oct: "schedules
    // job days on calendar dont need a check mark for done"; the job is
    // finished on the job itself), only on a calendar (`calOnly`), and drawn
    // in its job's colour (calendar.js jobColorOf): it has none of its own.
    { id: 'jobday', icon: '🔨', name: 'Job day', timed: null, color: '', calOnly: true },
    { id: 'doctor', icon: '🩺', name: 'Doctor’s appointment', timed: true, color: '#f2c230', ink: '#2b2200', appointment: true,
      personal: true },
    { id: 'personal', icon: '🏠', name: 'Personal', timed: null, color: '#d94f8a', personal: true },
  ];

  // ------------------------------------------------- each calendar's tags
  //
  // Jonah (16 Oct 2026): "within the calendars I want tags ... I want the
  // separate calendars and within them have tags." Each calendar has its own
  // list -- what an entry on it can be, each with its colour -- and an entry
  // carries one of them (`type`, its id). These are the lists a calendar
  // starts with, by its kind; the owner changes any calendar's in ⚙ Manage
  // calendars → Edit (rename, recolour, add, take off), stored on the
  // calendar as `tags` [{id, name, icon, color, appointment}] only once
  // edited. [id, the name it goes by there when not its own].
  const CAL_TAGS = {
    work: [['bid'], ['appt'], ['phone'], ['pickup'], ['rental'], ['parts'], ['check'], ['equipment'], ['delivery'], ['email'], ['todo']],
    crew: [['pickup'], ['rental'], ['parts'], ['check'], ['equipment'], ['delivery'], ['repair'], ['shop'], ['errand'], ['crew']],
    // The Job schedule: job days only -- no list to pick from.
    jobs: [['jobday']],
    personal: [['doctor'], ['phone'], ['personal']],
  };
  // A calendar the owner made has My work's list to start with.
  CAL_TAGS.custom = CAL_TAGS.work;
  // Built-in tags put on a kind's starting list after 16 Oct 2026, when the
  // owner could first make a calendar's list his own. A list he saved
  // before one of these existed never offered it -- it was not taken off --
  // so it joins his list (tagsOf) until he saves the list again having
  // seen it: the calendar's `tagsSeen` says which built-ins his editor
  // offered (calendar.js calSaveCal); one missing from a list saved after
  // that was taken off. A new built-in on a starting list: add its id here.
  const ADDED_LATER = ['phone', 'rental', 'parts', 'check', 'equipment'];
  // Every kind of pickup: one with no date is ready now -- on the day's list
  // every day until it is picked up (boards.js pickupsWaiting).
  const PICKUPS = ['pickup', 'rental', 'parts', 'check', 'equipment'];
  // What an entry is when nothing better is known, on each kind.
  const FALLBACK = { work: 'todo', custom: 'todo', crew: 'crew', jobs: 'jobday', personal: 'personal' };
  const kindOfCal = cal => (cal && cal.kind) || '';
  const startList = kind => CAL_TAGS[kind] || CAL_TAGS.work;
  const isColor = c => /^#[0-9a-fA-F]{6}$/.test(String(c || ''));
  // Whether the owner has made this calendar's list his own.
  const edited = cal => !!cal && Array.isArray(cal.tags) && cal.tags.some(t => t && typeof t.id === 'string' && t.id);
  // What a tag means on its calendar, whatever it is called there: on the
  // Crew schedule everything is the crew's (eventIsMine says the same) --
  // a pickup there is a crew pickup; on Personal everything is his own.
  // The built-in Personal tag is his life, not a job to tick off: nothing
  // to tick (`appointment`) unless he says otherwise in its settings.
  function decorate(t, cal) {
    const kind = kindOfCal(cal);
    const out = Object.assign({}, t);
    out.crew = kind === 'crew' || !!t.crew;
    out.personal = kind === 'personal' || !!t.personal;
    out.jobDay = t.id === 'jobday';
    if (typeof out.appointment !== 'boolean') out.appointment = !!t.appointment || t.id === 'personal';
    return out;
  }
  // One tag as the owner left it: his name, icon, colour and "nothing to
  // tick off", over the built-in one of the same id. A built-in's dark
  // writing goes with its own colour only (a new colour gets its own, by
  // app.js inkOn, where it is drawn).
  function fromStored(t, cal) {
    const b = typeById(t.id);
    const color = isColor(t.color) ? t.color : (b ? b.color : '#6b7a8f');
    return decorate({
      id: t.id,
      name: String(t.name || (b && b.name) || 'Tag').slice(0, 40),
      icon: String(t.icon != null ? t.icon : (b ? b.icon : '')).slice(0, 4),
      color: color, ink: b && b.ink && b.color === color ? b.ink : '',
      appointment: typeof t.appointment === 'boolean' ? t.appointment : undefined,
      timed: b ? b.timed : null,
      custom: !b,
    }, cal);
  }
  // The built-ins of its kind's starting list his own list was made
  // without: each goes in after the one before it on the starting list
  // (or first, when his list has none of those). `seen`: the calendar's
  // tagsSeen, or null for a list saved before there was such a thing.
  function addLater(list, kind, seen, cal) {
    const start = startList(kind);
    start.forEach(([id, name], i) => {
      if (list.some(t => t.id === id)) return;
      if (seen ? seen.indexOf(id) !== -1 : ADDED_LATER.indexOf(id) === -1) return;
      const b = typeById(id);
      if (!b) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = list.findIndex(t => t.id === start[j][0]);
        if (k !== -1) { at = k + 1; break; }
      }
      list.splice(at, 0, decorate(Object.assign({}, b, name ? { name: name } : {}), cal));
    });
    return list;
  }
  // A calendar's tags, in its order: the owner's (with any built-in added
  // since he made it), else the list its kind starts with. The Job
  // schedule's is always the one Job day. Worked out
  // once per calendar record (the calendar draws every entry through it;
  // a changed calendar arrives as a new record), and never changed by the
  // caller.
  const tagsMemo = new WeakMap();
  function tagsOf(cal) {
    const kind = kindOfCal(cal);
    const memo = cal && typeof cal === 'object' ? tagsMemo.get(cal) : null;
    if (memo && memo.kind === kind && memo.tags === cal.tags && memo.seen === cal.tagsSeen) return memo.list;
    let list;
    if (kind !== 'jobs' && edited(cal)) {
      const seen = {};
      list = addLater(cal.tags.filter(t => t && typeof t.id === 'string' && t.id && !seen[t.id] && (seen[t.id] = true))
        .map(t => fromStored(t, cal)), kind, Array.isArray(cal.tagsSeen) ? cal.tagsSeen : null, cal);
    } else {
      list = startList(kind).map(([id, name]) => decorate(Object.assign({}, typeById(id), name ? { name: name } : {}), cal));
    }
    if (cal && typeof cal === 'object') tagsMemo.set(cal, { kind: kind, tags: cal.tags, seen: cal.tagsSeen, list: list });
    return list;
  }
  // Whether an entry's stored tag still means something on this calendar:
  // one of its own; or a built-in of another calendar's (an entry moved
  // here, or given a kind before each calendar had its own list), which
  // keeps what it is -- unless the owner took that one off this calendar's
  // list. A tag taken off (or one of another calendar's own making) reads
  // as whatever the calendar makes of the entry's title.
  function knownOn(cal, type) {
    if (!type) return false;
    if (!cal) return !!typeById(type);
    if (kindOfCal(cal) === 'jobs') return type === 'jobday';
    if (tagsOf(cal).some(t => t.id === type)) return true;
    if (!typeById(type)) return false;
    return !(edited(cal) && startList(kindOfCal(cal)).some(x => x[0] === type));
  }
  // Everything about one tag as it is on this calendar ({id, name, icon,
  // color, ink, appointment, crew, personal, jobDay}), or null. Everything
  // that decides how an entry behaves -- a task or not, a job's day, whose
  // it is, its colour, the usual reminder -- reads its tag through here, so
  // a tag the owner made works everywhere a built-in one does.
  // functions/reminders.py _tag_of: the same.
  function tagOf(type, cal) {
    if (!cal) return typeById(type);
    if (kindOfCal(cal) === 'jobs') return tagsOf(cal)[0];
    const hit = tagsOf(cal).find(t => t.id === type);
    if (hit) return hit;
    return knownOn(cal, type) ? decorate(typeById(type), cal) : null;
  }
  // A guess at an entry's tag, as one this calendar has: its own of that
  // id, else its usual one, else its first.
  function onCalendar(cal, id) {
    if (!id || !edited(cal)) return id;
    const list = tagsOf(cal);
    if (list.some(t => t.id === id)) return id;
    const fb = FALLBACK[kindOfCal(cal)];
    if (fb && list.some(t => t.id === fb)) return fb;
    return list.length ? list[0].id : id;
  }
  const TIMED_LEADS = [30];
  const LEADS = { bid: [60, 30] };

  // Picking one's own reminder: the usual one, none at all, or a set time.
  const CHOICES = [
    ['', 'Usual'], ['none', 'No reminder'], ['0', 'At the time'], ['10', '10 minutes before'],
    ['30', '30 minutes before'], ['60', '1 hour before'], ['120', '2 hours before'],
    ['1440', 'The day before'], ['2880', 'Two days before'],
  ];

  let autoOn = null;        // this person's "Remind me of everything" (null: not read yet)

  const typeById = id => TYPES.find(t => t.id === id) || null;

  // What a thing is: the tag picked for it (one this calendar knows --
  // knownOn), else a guess by where it is and its title. Jonah keeps four
  // calendars (16 Oct 2026), each with its own tags:
  //   - the Job schedule: every entry a job's day, whatever it says;
  //   - the Crew schedule: the title says a pickup (which kind: pickupOf),
  //     an errand (the bank, a drop-off), a delivery, an equipment repair,
  //     or shop or yard work -- in that order of asking, so "Pickup check
  //     from ..." is a check pickup, "Pick up the mower from repair" one of
  //     our machines and "Pick up pavers at the yard" a material pickup --
  //     and anything else is a crew task;
  //   - Personal ("anything i do not to do with the business"): a phone
  //     call when the title says so ("Call the dentist" is a call to make,
  //     not the dentist), else a doctor's appointment when it says so, else
  //     personal;
  //   - My work, and any calendar he makes: the title tells a phone call, a
  //     pickup (which kind: pickupOf), an email or a delivery, and anything
  //     else is a to-do. A title STARTING "Call ..." / "Phone ..." is a call
  //     whatever else it says ("Call the yard about the delivery"); one
  //     that only mentions a call further on ("<a business> call", "Pat --
  //     call back") is one when it says nothing else ("Send the bid, then
  //     call" is an email). A pickup at the bank is none of the pickups:
  //     the Crew schedule calls that an errand, and My work, with no errand
  //     tag, a to-do.
  // A card on Pickups -- made from a store's "ready for pickup" email -- is
  // a pickup, and one on Crew tasks or tagged 👷 Crew a crew task. (Site
  // visits and the Work schedule were calendars before 15 Oct; kept so
  // nothing old reads as nothing.) functions/reminders.py _type_of: the same.
  const BY_CALENDAR = { visits: 'bid', work: 'todo', custom: 'todo' };
  // "Call ...", "Calling ...", "Callback ...", "Phone ..." -- not "Phone
  // bill", "Phone plan" and the like, which are not calls.
  const PHONE_FIRST = /^\s*(?:call(?:s|ing|ed)?|call\s?-?\s?backs?|phone(?:d|\s?-?\s?calls?)?)\b(?!\s+(?:bills?|plans?|cases?|chargers?|payments?|repairs?|upgrades?|numbers?)\b)/i;
  // "Phone call with ...", "Zoom call", "call back", "return ...'s call",
  // and a title ending in "call".
  const PHONE_ANY = /\b(?:phone|zoom|video|conference|facetime)\s?-?\s?calls?\b|\bcall\s?-?\s?backs?\b|\breturn(?:ed)?\b.{0,40}\bcalls?\b|\bcalls?\s*[.!?]?\s*$/i;
  // "Pick up", "Pickup", "Pick-up" -- not a pickup truck.
  const PICKUP_WORDS = /\bpick\s?-?\s?up\b(?!\s+trucks?\b)/i;
  // The bank, the post office, a drop-off.
  const ERRAND_WORDS = /\berrands?\b|\bbank\b|\bpost office\b|\bdrop(?:ped|ping)?\s?-?\s?off\b|\bdeposit\b/i;
  // A check to collect says so without "pick up": "Check from Pat", "Get
  // Pat's check", "Collect the payment".
  const CHECK_WORDS = /\bchecks?\s+from\b|\b(?:pick\s?-?\s?up|get|grab|collect)\s+(?:(?:the|a|his|her|their|my|our)\s+)?(?:\S+['’]s\s+)?(?:checks?|cheques?|payments?)\b(?!-)|\bcheques?\b/i;
  // Said to be a pickup: a rental, parts, or one of our own machines (from
  // the repair shop, a job) -- asked in that order, so "Pick up blades for
  // the mower" is parts and "Pick up the rented mower" a rental -- else
  // materials.
  const PICKUP_KINDS = [
    ['rental', /\brent(?:al|als|ed|ing)?\b/i],
    ['parts', /\bparts?\b|\bfilters?\b|\bblades?\b|\bbelts?\b|\bhoses?\b|\btires?\b|\bbatter(?:y|ies)\b|\bspark\s?plugs?\b|\bbearings?\b/i],
    ['equipment', /\bequipment\b|\bmachines?\b|\bmowers?\b|\btrailers?\b|\btrucks?\b|\bskid\s?-?\s?steers?\b|\bloaders?\b|\bexcavators?\b|\bmini\s?-?\s?ex\b|\btractors?\b|\bblowers?\b|\btrimmers?\b|\bsalters?\b|\bspreaders?\b|\baerators?\b|\bfrom\s+(?:the\s+)?(?:repair|shop|dealer)\b/i],
  ];
  // Which pickup a title tells (PICKUPS), or '' -- none, or one at the bank
  // or the post office, which is no pickup of ours.
  function pickupOf(title) {
    if (CHECK_WORDS.test(title)) return 'check';
    if (!PICKUP_WORDS.test(title)) return '';
    const hit = PICKUP_KINDS.find(k => k[1].test(title));
    return hit ? hit[0] : ERRAND_WORDS.test(title) ? '' : 'pickup';
  }
  // [tag, the words that say it -- or a function telling which tag] --
  // asked in this order, the first that fits.
  const WORDS = [
    ['phone', PHONE_FIRST],
    ['pickup', pickupOf],
    ['email', /^\s*send\b|\be-?mail\b/i],
    ['delivery', /\bdeliver(y|ies|ed)?\b/i],
    ['phone', PHONE_ANY],
  ];
  const isCall = title => PHONE_FIRST.test(title || '') || PHONE_ANY.test(title || '');
  const CREW_WORDS = [
    ['pickup', pickupOf],
    ['errand', ERRAND_WORDS],
    ['delivery', /\bdeliver(y|ies|ed)?\b/i],
    ['repair', /\b(?:repair\w*|fix(?:ed|ing)?|service|oil change|tires?|broken|brakes?|grease)\b/i],
    ['shop', /\b(?:shop|yard work|the yard)\b/i],
  ];
  const DOCTOR_WORDS = /\b(doctor|dentist|dental|clinic|chiropract\w*|orthodont\w*|optometr\w*|dermatolog\w*|physical therapy|check-?up|physical)\b|\bdr\.\s/i;
  function byWords(title, list) {
    title = title || '';
    for (const [id, how] of list || WORDS) {
      const got = typeof how === 'function' ? how(title) : how.test(title) ? id : '';
      if (got) return got;
    }
    return '';
  }
  // `where`: { cal (the calendar itself: its own tags count), or calKind,
  // or boardId (a card) }.
  function typeOf(item, where) {
    where = where || {};
    const cal = where.cal || (where.calKind ? { kind: where.calKind } : null);
    const kind = kindOfCal(cal);
    if (kind === 'jobs') return 'jobday';
    const stored = item && item.type;
    if (stored && (cal ? knownOn(cal, stored) : !!typeById(stored))) return stored;
    const title = (item && item.title) || '';
    if (kind === 'schedule') return 'crew';             // the old Work schedule
    if (!cal) {
      if (where.boardId === 'pickups') return 'pickup';
      if (where.boardId === 'crew' || (item && (item.labels || []).indexOf('crew') !== -1)) return 'crew';
      return byWords(title);
    }
    const guess = kind === 'personal' ? (isCall(title) ? 'phone' : DOCTOR_WORDS.test(title) ? 'doctor' : 'personal')
      : kind === 'crew' ? byWords(title, CREW_WORDS) || 'crew'
      : byWords(title) || BY_CALENDAR[kind] || '';
    return onCalendar(cal, guess);
  }
  // Whether a thing has to be ticked off as done. Jonah (14 Oct 2026): "make
  // tasks on the calendar have to be marked done or they get included in the
  // end day summary. This goes for all tasks. Appointments are different."
  // A bid, an appointment or the doctor just happens at its time; a Personal
  // entry is his own life (a birthday is not a job to tick). Everything else
  // is a task: a pickup, a delivery, a to-do, a crew task -- and when nobody
  // said what it is, any card (a card is a thing to do), anything on
  // Follow-ups (calls to make, things to chase), and any entry for no set
  // time ("just needs to be done that day"); an entry at a set time is taken
  // for an appointment. A task not ticked off on its day is in that evening's
  // summary as not done, and carried to the top of the next days' lists
  // (calendar.js todayHtml, functions/reminders.py open_tasks -- the same
  // rules) until it is ticked or deleted. `where`: { card, calKind }.
  // A day of a job on the Work schedule is not one either (Jonah, 15 Oct 2026:
  // "schedules job days on calendar dont need a check mark for done") -- it
  // says who is working where, and the job is finished on the job itself.
  // A job's day is the kind picked as one ("Job day" in the What is it box),
  // never guessed from the entry being tied to a job: Jonah, 16 Oct 2026,
  // "i have two items i marked at to do today yet the home page says I have
  // 1 thing" -- a to-do tied to a customer's job ("take pictures at ...")
  // showed ✅ To do that day in its box while it was counted as the job's
  // day, and so was every other entry tied to a job (a pickup for one, a
  // check to collect).
  // What the box says is what it is. (Anything not given a kind on the old
  // Work schedule, kind `schedule`, stays a job's day for old copies.)
  // From 16 Oct 2026 job days have a calendar of their own, the Job
  // schedule: everything on it is one.
  // `where.typed`: a kind was picked, not taken from the calendar.
  function isJobDay(type, where) {
    where = where || {};
    const kind = where.calKind || kindOfCal(where.cal);
    if (type === 'jobday' || kind === 'jobs') return true;
    return !where.typed && kind === 'schedule';
  }
  // `where.cal`: the calendar, whose own tags decide (a tag the owner made,
  // or one he set to "nothing to tick off").
  function isTask(type, timed, where) {
    where = where || {};
    if (isJobDay(type, where)) return false;
    if (where.card) { const c = typeById(type); return c ? !c.appointment : true; }
    const cal = where.cal || (where.calKind ? { kind: where.calKind } : null);
    const t = cal ? tagOf(type, cal) : typeById(type);
    if (t) return !t.appointment && (cal ? true : t.id !== 'personal');
    return where.calKind === 'followups' || kindOfCal(cal) === 'followups' || !timed;
  }
  // How far back a task not ticked off is carried forward: a fortnight, so
  // something forgotten does not pile up for ever (the card stays on its
  // board, the entry on its calendar). Never before the day this began --
  // nothing earlier was ever asked to be ticked, and the first evening would
  // otherwise have listed two weeks of the work schedule as not done.
  const CARRY_DAYS = 14;
  const TICK_FROM = '2026-10-14';

  function icon(type) { const t = typeById(type); return t ? t.icon : ''; }
  function color(type) { const t = typeById(type); return t ? t.color : ''; }
  function ink(type) { const t = typeById(type); return (t && t.ink) || ''; }

  function minutesWords(m) {
    if (m >= 60 && m % 60 === 0) return m === 60 ? '1 hour' : (m / 60) + ' hours';
    return m + ' minutes';
  }
  // When the usual reminder comes, in words: "1 hour and 30 minutes before".
  function usualWords(type, timed) {
    if (!timed) return 'in the day’s list at 7 am';
    return (LEADS[type] || TIMED_LEADS).map(minutesWords).join(' and ') + ' before';
  }

  // A reminder set on the thing itself, in words: "30 minutes before".
  function setWords(mins) {
    const hit = CHOICES.find(c => c[0] === String(mins));
    return hit ? hit[1] : minutesWords(Number(mins)) + ' before';
  }
  // The reminder line for the details window, '' when there is none for
  // this person. `mine`: the thing is theirs (isMine).
  function line(item, type, timed, mine) {
    if (!item) return '';
    if (item.noReminder) return '🔕 No reminder';
    if (item.hasReminder && item.remindMins != null) return '🔔 Reminder: ' + setWords(item.remindMins).toLowerCase();
    return usualFor(item) && mine ? '🔔 Reminder: ' + usualWords(type, timed) : '';
  }

  // The Remind box's value for a saved entry or card.
  function choiceOf(item) {
    if (!item) return '';
    if (item.noReminder) return 'none';
    return item.hasReminder && item.remindMins != null ? String(item.remindMins) : '';
  }
  function optionsHtml(item) {
    const on = choiceOf(item);
    // A set time that is not one of the choices (an imported entry) stays
    // as it is rather than turning into "Usual" on the next save.
    const list = CHOICES.some(c => c[0] === on) ? CHOICES
      : CHOICES.concat([[on, minutesWords(Number(on)) + ' before']]);
    return list.map(([v, words]) => '<option value="' + v + '"' + (v === on ? ' selected' : '') + '>' +
      words + '</option>').join('');
  }
  // What the box says, as the fields saved. Whoever set a reminder before
  // keeps theirs when someone else edits it.
  function fromChoice(v, was, uid) {
    if (v === 'none') return { hasReminder: false, remindMins: null, remindUids: [], noReminder: true };
    if (v === '') return { hasReminder: false, remindMins: null, remindUids: [], noReminder: false };
    return { hasReminder: true, remindMins: parseInt(v, 10), noReminder: false,
             remindUids: Array.from(new Set(((was && was.remindUids) || []).concat(uid ? [uid] : []))) };
  }
  // The line under the Remind box: what "Usual" means for this one. The
  // ⋯ menu item is "Notification settings" (it was "Notifications &
  // summaries" once; the words here had not followed).
  // `cal`: the calendar it is on (on the Crew schedule every tag is the crew's).
  function usualHint(type, timed, cal) {
    const when = usualWords(type, timed);
    if (((cal ? tagOf(type, cal) : typeById(type)) || {}).crew) {
      return 'Usual: ' + when + ', to the people on it — or, with nobody on it, to every crew member.';
    }
    if (autoOn === false) {
      return 'Usual: nothing — your automatic reminders are off (⋯ → Notification settings).';
    }
    return 'Usual: ' + when + '. Phones need notifications switched on: ⋯ → Notification settings.';
  }

  // Who counts as crew (Jonah, 12 Oct 2026: "mark profiles in the app as
  // crew members"): ticked on Your Crew. A crew account is unless unticked,
  // an admin only when ticked, the owner never.
  function isCrewMember(u) {
    if (!u || u.role === 'owner') return false;
    return u.crewMember === true || (u.role === 'crew' && u.crewMember !== false);
  }

  // Whose a thing is. Jonah (12 Oct 2026): "my cards are cards i dont select
  // anyone else on or ones i select myself on." So it is theirs when they are
  // on it; with nobody on it, a crew task is every crew member's and
  // anything else is whoever made it's -- the owner's when that is nobody we
  // know (made from his email, an import, a machine's own card). The 👤 Mine
  // filters, My day and the reminders (functions/reminders.py _is_mine) all
  // read it this way. `who` = { uid, owner, crew (a crew member),
  // makerOf(createdBy) -> uid or '' }.
  function isMine(onUids, type, maker, who) {
    if (!who || !who.uid) return false;
    if (onUids.indexOf(who.uid) !== -1) return true;
    if (onUids.length) return false;
    if ((typeById(type) || {}).crew) return !!who.crew;
    if (maker) return maker === who.uid;
    return !!who.owner;
  }
  // A card keeps the NAME of whoever made it; makerOf turns that into them.
  function cardIsMine(card, board, who) {
    if (!card || !who) return false;
    const on = (card.assignees || []).map(a => a && a.uid).filter(Boolean);
    const maker = who.makerOf ? who.makerOf(card.createdBy) : '';
    return isMine(on, typeOf(card, { boardId: board && board.id }), maker, who);
  }
  // A calendar entry keeps the uid of whoever made it (from 12 Oct 2026; the
  // ones before are the owner's).
  // Anything on the Crew schedule is the crew's -- with nobody on it, every
  // crew member's, whatever it is (a pickup there is a crew pickup). Crew
  // testing, 16 Oct 2026: "Pick up pavers at the yard" on the Crew schedule
  // with nobody on it reached no crew member's day at all. A day on the Job
  // schedule with nobody on it is the whole crew's too: they are all there.
  function eventIsMine(ev, cal, who) {
    if (!ev || !who) return false;
    const on = (ev.crew || []).map(c => c && c.uid).filter(Boolean);
    const kind = kindOfCal(cal);
    const type = kind === 'crew' || kind === 'jobs' ? 'crew' : typeOf(ev, { cal: cal });
    return isMine(on, type, ev.createdBy || '', who);
  }
  // This person, as isMine wants them. `people`: uid -> user record, where
  // this device has them (the owner's and an admin's do; a crew phone knows
  // only its own, and a card's maker it cannot name is not its anyway).
  function who(people) {
    const a = window.YDAuth || {};
    if (!a.user) return null;
    const byName = {};
    const key = n => String(n || '').trim().toLowerCase();
    Object.keys(people || {}).forEach(uid => {
      const p = people[uid] || {};
      [p.name, p.email].forEach(n => { const k = key(n); if (k) byName[k] = uid; });
    });
    // A crew phone has no list of people, but a card it made carries its own
    // name (boards.js myName) -- without this, a card a crew member made with
    // nobody on it was not "mine" on their phone while the server reminded
    // them of it (functions/reminders.py names every user record).
    [meRec && meRec.name, meRec && meRec.email, a.user.email].forEach(n => {
      const k = key(n);
      if (k && !byName[k]) byName[k] = a.user.uid;
    });
    const mine = meRec || { role: a.role };
    return { uid: a.user.uid, owner: !!a.isOwner, crew: isCrewMember(mine),
             makerOf: by => byName[String(by || '').trim().toLowerCase()] || '' };
  }

  // Whether this one will buzz this person by the usual rule -- for the 🔔
  // beside it. Its own reminder is shown by the screen itself.
  function usualFor(item) {
    return autoOn === true && !!item && !item.noReminder && !item.hasReminder;
  }

  // On for everyone unless they switched it off (notify.js DEFAULTS).
  let meRec = null;         // this person's own user record (crewMember)
  function readPrefs(a) {
    autoOn = null; meRec = null;
    if (!a || a.mode !== 'cloud' || !a.user || !window.YDDb) return;
    Promise.resolve(window.YDDb.get('digestPrefs', a.user.uid)).then(p => {
      autoOn = p && typeof p.autoRemind === 'boolean' ? p.autoRemind : true;
    }).catch(() => { autoOn = true; });
    Promise.resolve(window.YDDb.get('users', a.user.uid)).then(u => {
      meRec = u ? Object.assign({ uid: a.user.uid }, u) : null;
      document.dispatchEvent(new CustomEvent('yd-remind-me'));
    }).catch(() => {});
  }
  document.addEventListener('yd-auth', e => readPrefs(e.detail || {}));

  window.YDRemind = {
    TYPES: TYPES,
    // Each calendar's tags (16 Oct 2026).
    CAL_TAGS: CAL_TAGS,
    // The built-ins a calendar of this kind starts with: what the tag editor
    // offered, saved as its tagsSeen (ADDED_LATER).
    startIds: kind => startList(kind).map(x => x[0]),
    // Every kind of pickup (22 Oct 2026): one with no date is ready now.
    isPickup: id => PICKUPS.indexOf(id) !== -1,
    tagsOf: tagsOf,
    tagOf: tagOf,
    knownOn: knownOn,
    isJobDay: isJobDay,
    typeById: typeById,
    typeOf: typeOf,
    isTask: isTask,
    CARRY_DAYS: CARRY_DAYS,
    TICK_FROM: TICK_FROM,
    icon: icon,
    color: color,
    ink: ink,
    isCrewMember: isCrewMember,
    cardIsMine: cardIsMine,
    eventIsMine: eventIsMine,
    who: who,
    me: () => meRec,
    usualWords: usualWords,
    usualHint: usualHint,
    setWords: setWords,
    line: line,
    optionsHtml: optionsHtml,
    fromChoice: fromChoice,
    usualFor: usualFor,
    // notify.js tells this when the person flips the switch.
    setAuto: on => { autoOn = !!on; },
    autoOn: () => autoOn,
  };
})();
