"""Which of a finished job's photos a post shows, and in what order.

Jonah, 6 Nov 2026, of one job's post: "should show before photos and more
angles you just wrote it with 4 photos from the same angle thats dumb." A post took
the job's newest After photos, and the crew finish a job with a burst from one
spot: those four were 14 seconds apart.

Now, in plain code (social.job_picks runs it):
  - Each photo's small thumbnail is cut down to a 16 x 16 grid of colours, and
    two grids are compared. Shots from one spot come out nearly the same; on
    real jobs (2026 folders) those read under ALIKE, other spots over it. A
    thumbnail that can't be read falls back on how far apart the two were taken.
  - The lead is the After photo most like the rest of its set: the view the
    crew kept coming back to. That is a stand-in for "the best one" only.
  - Then a Before photo, the one most like the lead. Colours alone can't
    really find the same spot, so this is a stand-in until Claude has looked.
    No Before on the job: the earliest During photo, as near to one as there is.
  - Then After photos from other spots, the most different first, and more
    Before and During ones, each only while it really is another view. So a
    job with three views gets three photos, not four with one repeated.

What code can't see is a hand in a corner, a child, a house number, or which
shot really looks best (one post went up with an arm in the corner). So for_look() sends the best few from that order, with several
stages among them, to Claude once per job (about 2 cents at LOOK_PX), which
leaves out what shouldn't be public and sets the final order; settle() holds it
to the rules above. When Claude can't be asked, the plain order stands and a
later plan() looks again (social.py). A post is planned 8 days ahead, so only
Claude being out for days can let one go up unlooked.
"""
import base64
import datetime
import hashlib
import io
import json

STAGES = ("after", "before", "during")
GRID = 16
# Under this, two photos are the same view. On a job of 21 After photos the 8
# from one spot read .07 to .13 against each other, other spots .14 to .23.
ALIKE = 0.125
TIME_APART_S = 600      # with no thumbnail: this far apart counts as wholly different
MOST_READ = 40          # thumbnails read per stage at most (evenly through the set)
LOOK = 8                # photos Claude sees
LOOK_MOST = {"after": 5, "before": 2, "during": 1}      # of them, before the rest fill any room
LOOK_PX = 1000          # on the long side: a corner has to be readable
LOOK_TRIES = 3          # a refused or unreadable answer: this many goes, then the plain order stands
LOOK_WAIT_S = 90

LOOK_SYSTEM = (
    "You check the photos for a landscaping company's social media post about one finished job. You get up to 8 "
    "photos of the job. Each is labelled with its number and stage: after = the finished job, before = the yard "
    "before the work, during = the work under way.\n\n"
    "Look at all four corners and every edge of each photo, not only the middle.\n\n"
    "Leave a photo out when it shows any of these: a hand, finger, arm, leg or foot coming in at the edge of the "
    "frame; the photographer's own shadow across the finished work; a child; a customer or neighbor who could be "
    "recognised; a close-up where someone's face fills the shot (the crew working in the distance on a before or "
    "during photo is fine); a readable house number, street sign, mailbox number "
    "or license plate; a fence, post or other thing close to the camera cutting across a corner; a bin, hose, tool, "
    "phone, bag or trash left in a finished shot; loose mulch or mess outside the finished edge; a blurred shot; a "
    "shot that is mostly sun glare; or anything that isn't a real photo of this yard, such as a screenshot or a "
    "drawing. A child counts even far off in the background. Say briefly why, naming where in the photo.\n\n"
    "Then choose the photos for the post, in order, no more than asked for:\n"
    "1. first, the after photo that best shows the whole finished job in good light;\n"
    "2. next, the before photo that best shows how this yard looked before the work, wide enough to see the yard, "
    "from about the same spot as the first if there is one; if no before shows that, a during photo of the ground "
    "being shaped, never a close-up of a machine;\n"
    "3. then after photos from other spots, so the post shows the job from different angles.\n"
    "Never put in two photos from about the same spot, even if that leaves the post with fewer. Only use the numbers "
    "you were given."
)
LOOK_SCHEMA = {
    "type": "object",
    "properties": {
        "photos": {"type": "array", "items": {"type": "integer"}},
        "left_out": {"type": "array", "items": {
            "type": "object",
            "properties": {"n": {"type": "integer"}, "why": {"type": "string"}},
            "required": ["n", "why"],
            "additionalProperties": False,
        }},
    },
    "required": ["photos", "left_out"],
    "additionalProperties": False,
}


def key_of(rows):
    """What a kept pick was made from: its photos and their stages. A photo
    added, taken away or moved to another stage means it is picked again."""
    text = "|".join(sorted("%s:%s" % (p["id"], p["stage"]) for p in rows))
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def signature(raw):
    """The photo cut down to a small grid of colours; None when it can't be read."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as im:
            return im.convert("RGB").resize((GRID, GRID), Image.BOX).tobytes()
    except Exception as e:              # noqa: BLE001 -- anything can be in a bad file
        print("photopick: thumbnail not read:", e)
        return None


def _seconds(p):
    try:
        return datetime.datetime.fromisoformat(str(p.get("at") or "").replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def apart(a, b):
    """How different two photos are, 0 (the same) to about .3 for a real
    yard. With no thumbnail for one, how far apart in time they were taken;
    with no time either they count as different, because a photo is better
    used than lost."""
    x, y = a.get("sig"), b.get("sig")
    if x and y and len(x) == len(y):
        return sum(abs(p - q) for p, q in zip(x, y)) / (255.0 * len(x))
    s, t = _seconds(a), _seconds(b)
    if s is None or t is None:
        return 1.0
    return min(1.0, abs(s - t) / TIME_APART_S)


def thin(rows):
    """At most MOST_READ of a stage's photos, spread evenly by when they were
    taken, so a job with hundreds isn't read one thumbnail at a time."""
    out = []
    for stage in STAGES:
        lst = sorted((p for p in rows if p["stage"] == stage), key=_when)
        if len(lst) > MOST_READ:
            step = len(lst) / float(MOST_READ)
            lst = [lst[int(i * step)] for i in range(MOST_READ)]
        out.extend(lst)
    return out


def _when(p):
    return str(p.get("at") or ""), str(p.get("id") or "")


def _add_apart(out, pool):
    """Photos from `pool` onto `out`, the most different from those of its
    stage first, while a photo really is another view."""
    stage = pool[0]["stage"] if pool else ""
    left = [p for p in pool if p not in out]
    while left:
        have = [q for q in out if q["stage"] == stage]
        if not have:
            best = min(left, key=_when)
            out.append(best)
            left.remove(best)
            continue
        scored = [(min(apart(p, q) for q in have), p) for p in left]
        far = max(s for s, _ in scored)
        if far < ALIKE:
            return
        best = min((p for s, p in scored if s == far), key=_when)
        out.append(best)
        left.remove(best)


def order(rows):
    """The job's photos in the order a post should use them, with repeats of a
    view left out. [] with no After photo: a job's post leads with the finished
    work. Each row needs id, stage and at; `sig` when its thumbnail was read."""
    after = sorted((p for p in rows if p["stage"] == "after"), key=_when)
    if not after:
        return []
    before = sorted((p for p in rows if p["stage"] == "before"), key=_when)
    during = sorted((p for p in rows if p["stage"] == "during"), key=_when)
    lead = min(after, key=lambda p: sum(apart(p, q) for q in after if q is not p))
    out = [lead]
    if before:
        out.append(min(before, key=lambda p: apart(p, lead)))
    elif during:
        out.append(during[0])
    _add_apart(out, after)
    _add_apart(out, before)
    _add_apart(out, during)
    return out


def for_look(plain):
    """What Claude sees out of the plain order: enough of each stage that the
    After photos can't crowd out a better Before."""
    room, first, rest = dict(LOOK_MOST), [], []
    for p in plain:
        if room[p["stage"]] > 0:
            room[p["stage"]] -= 1
            first.append(p)
        else:
            rest.append(p)
    return (first + rest)[:LOOK]


def look(client, model, shots, n):
    """Claude looks at `shots` ([(row, jpeg bytes)]) and picks up to n. Returns
    ({"photos": [row ids], "leftOut": [{"id", "why"}]}, usage), or (None, usage)
    when it gave no answer that can be used."""
    content = [{"type": "text", "text": "Choose up to %d photos for the post. There are %d." % (n, len(shots))}]
    for i, (row, raw) in enumerate(shots, 1):
        content.append({"type": "text", "text": "Photo %d (%s)" % (i, row["stage"])})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                    "data": base64.b64encode(raw).decode("ascii")}})
    resp = client.beta.messages.create(
        model=model, max_tokens=2000, system=LOOK_SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": LOOK_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default", timeout=LOOK_WAIT_S,
    )
    if resp.stop_reason == "refusal":
        return None, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return None, resp.usage
    if not isinstance(got, dict):
        return None, resp.usage
    ids = [row["id"] for row, _ in shots]

    def of(x):
        # Claude's number, as the row it was shown; None for one it wasn't.
        ok = isinstance(x, int) and not isinstance(x, bool) and 1 <= x <= len(ids)
        return ids[x - 1] if ok else None

    left = []
    for x in got.get("left_out") or []:
        rid = of((x or {}).get("n")) if isinstance(x, dict) else None
        if rid:
            left.append({"id": rid, "why": str(x.get("why") or "")[:200]})
    return {"photos": [r for r in (of(x) for x in got.get("photos") or []) if r], "leftOut": left}, resp.usage


def settle(plain, got, n):
    """The post's photos from Claude's answer (`got`, as look() gives it) and
    the plain order, as rows. Whatever it said: a photo it left out stays out,
    an After photo leads, and a Before goes in when the job has one fit to
    use and Claude chose neither a Before nor a During in its place. [] when
    no After photo fit to use is left."""
    bad = {x["id"] for x in got.get("leftOut") or []}
    fit = [p for p in plain if p["id"] not in bad]
    by_id = {p["id"]: p for p in fit}
    picked, seen = [], set()
    for rid in got.get("photos") or []:
        if rid in by_id and rid not in seen:
            seen.add(rid)
            picked.append(by_id[rid])
    after = next((p for p in picked if p["stage"] == "after"), None) or \
        next((p for p in fit if p["stage"] == "after"), None)
    if after is None:
        return []
    picked = [after] + [p for p in picked if p is not after]
    if not any(p["stage"] != "after" for p in picked):
        one = next((p for p in fit if p["stage"] == "before"), None)
        if one is not None:
            picked.insert(1, one)
    return picked[:n]
