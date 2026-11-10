"""Photos from iCloud onto the right job in Job Hub (the PC half).

Jonah (10 Nov 2026), after seeing his phone's GPS put a photo about 60 ft off:
"lets try it because you can be uploading these images yourself. and context
clues will also help like if its a photo of a wall and theres a job nearby for
a wall and another nearby for drainage you should know which one its for."

iCloud for Windows keeps his photo library in ICLOUD (the originals, with the
time and GPS spot the phone wrote). This script does the parts plain code can:

  scan   finds photos added since the last look, reads when and where each was
         taken, leaves out what can never go on a job (videos, screenshots,
         saved pictures, selfies, photos with no location) and shrinks the rest
         the way Job Hub does (1600 px + 360 px JPEG, no camera data inside:
         the spot is kept on the record, not in the file). Prints them as JSON.
  mark   records what became of a photo (put on a job, waiting for a bid,
         not work), so it is never looked at or added twice.
  status prints what is waiting.

Which job a photo is for is decided in the Job Hub page (page.js: the jobs
and leads near the spot) and by Claude looking at the photo (what's in it
against each job's work); Claude in Chrome then hands the shrunk files to that
page, which uploads them with the owner's own sign-in. Nothing here talks to
the internet.

Data lives in reports/photo-sort/ (state.json, queue/): inside this folder so
the routine's Chrome file upload may read it (it only reads the session's own
folder), and git-ignored, so photos of customers' yards never go in git.
"""
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time

import math

ICLOUD = os.path.join(os.path.expanduser("~"), "iCloudPhotos", "Photos")   # iCloud for Windows' folder
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "reports", "photo-sort"))
QUEUE = os.path.join(DATA, "queue")
STATE = os.path.join(DATA, "state.json")

# His iPhone only started writing a location on 9 Nov 2026 (about 3:54 pm),
# so the first look starts that morning: nothing older can be placed.
FIRST_SINCE = "2026-11-09T00:00:00-06:00"

FULL_PX, THUMB_PX = 1600, 360               # jobphotos.js FULL_PX / THUMB_PX
FULL_Q, THUMB_Q = 82, 70
PHOTO_EXT = {".heic", ".heif", ".jpg", ".jpeg"}
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".avi"}
# Photos looked at in one run at most; the rest wait for the next run.
SCAN_MAX = 40
# Settled photos are remembered by name + when made; this many days of them are
# kept (older ones can't come back: the first look only reads newer files).
KEEP_DAYS = 400
# A held photo (a lead with no bid yet, or a job Claude couldn't pick) waits
# this long for its bid, then is let go.
HOLD_DAYS = 60
# A file that won't open (iCloud still downloading it, a cut-off copy) is
# tried again next run, this many runs in all, before it is given up on.
READ_TRIES = 3

STATUSES = {"uploaded", "held", "not-work", "not-at-a-job"}


class Unfit(Exception):
    """This PC can't do the job at all (no HEIC reader): stop the run before
    anything is marked, so nothing is given up on."""


# ------------------------------------------------------------------ state

def load():
    try:
        with open(STATE, encoding="utf-8") as f:
            s = json.load(f)
    except FileNotFoundError:
        s = {}
    s.setdefault("since", FIRST_SINCE)
    s.setdefault("seen", {})        # key -> {status, at, id?, why?, job?, lead?}
    s.setdefault("photos", {})      # id -> photo waiting (queued or held)
    s.setdefault("tries", {})       # key -> times a file wouldn't open
    # Places whose photos are never a job's, kept here and not in the code
    # (the repo is public): [{name, lat, lng, feet}] -- his home and shop.
    s.setdefault("exclude", [])
    return s


def save(s):
    os.makedirs(DATA, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, STATE)          # never a half-written state file


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def key_of(name, born):
    # Name + when the file was made (iCloud gives it the photo's own time). Not
    # the size: an edit on the phone changes the size, and it is still the same
    # photo, already on its job.
    return "%s|%d" % (name, int(born))


def id_of(key):
    # The same photo always gets the same record id, so putting it on a job
    # twice writes the same record instead of a second copy. jobPhotos ids
    # must read jp[a-z0-9]+ (storage.rules); hex is.
    return "jp" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def parse_iso(s):
    return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))


# ------------------------------------------------------- reading a photo

def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _deg(parts, ref):
    try:
        d, m, s = (_num(x) for x in parts)
    except (TypeError, ValueError):
        return None
    if d is None or m is None or s is None:
        return None
    v = d + m / 60.0 + s / 3600.0
    return -v if str(ref or "").upper() in ("S", "W") else v


def _taken_at(exif_ifd):
    """When the shutter fired, as UTC ISO, or None. iPhones write the time
    with its offset from UTC; one without an offset is read as this PC's
    local time (the business is in one time zone)."""
    raw = exif_ifd.get(0x9003) or exif_ifd.get(0x9004)
    if not raw:
        return None
    try:
        local = dt.datetime.strptime(str(raw).strip("\x00 ")[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    off = str(exif_ifd.get(0x9011) or exif_ifd.get(0x9012) or "").strip("\x00 ")
    m = re.match(r"^([+-])(\d\d):(\d\d)$", off)
    if m:
        sign = 1 if m.group(1) == "+" else -1
        tz = dt.timezone(sign * dt.timedelta(hours=int(m.group(2)), minutes=int(m.group(3))))
        at = local.replace(tzinfo=tz)
    else:
        at = dt.datetime.fromtimestamp(time.mktime(local.timetuple())).astimezone()
    return at.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_photo(path):
    """{img, at, lat, lng, acc, model, lens} from a photo file. Opening a
    cloud-only file makes iCloud download it."""
    from PIL import Image, ImageOps
    if os.path.splitext(path)[1].lower() in (".heic", ".heif"):
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except ImportError:
            # Every iPhone photo is HEIC: without the reader all would fail.
            raise Unfit("pillow-heif is not installed: run  python -m pip install --user pillow-heif")
    img = Image.open(path)
    img.load()                       # the whole picture now, so a cut-off file fails here
    exif = img.getexif()
    eifd = exif.get_ifd(0x8769)
    gps = exif.get_ifd(0x8825)
    lat = _deg(gps.get(2), gps.get(1)) if gps.get(2) else None
    lng = _deg(gps.get(4), gps.get(3)) if gps.get(4) else None
    if (lat is None or lng is None or not math.isfinite(lat) or not math.isfinite(lng)
            or abs(lat) > 90 or abs(lng) > 180 or (abs(lat) < 1e-6 and abs(lng) < 1e-6)):
        lat = lng = None
    acc = _num(gps.get(31)) if lat is not None else None
    if acc is not None and not math.isfinite(acc):
        acc = None
    img = ImageOps.exif_transpose(img)
    return {
        "img": img, "at": _taken_at(eifd), "lat": lat, "lng": lng,
        "acc": round(acc, 1) if acc is not None else None,
        "make": str(exif.get(0x010F) or "").strip("\x00 "),
        "model": str(exif.get(0x0110) or "").strip("\x00 "),
        "lens": str(eifd.get(0xA434) or "").strip("\x00 "),
    }


def shrink(img, max_px, quality, out):
    from PIL import Image
    im = img.convert("RGB") if img.mode != "RGB" else img
    k = min(1.0, float(max_px) / max(im.width, im.height))
    if k < 1:
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    im.save(out, "JPEG", quality=quality, optimize=True)   # no exif= : nothing of the camera's goes along
    return im.width, im.height


# ----------------------------------------------------------------- scan

def what_it_is(name):
    ext = os.path.splitext(name)[1].lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext not in PHOTO_EXT:
        return "not-photo"          # screenshots (PNG), saved pictures (WEBP, GIF)
    return "photo"


def feet_apart(a_lat, a_lng, b_lat, b_lng):
    r = math.radians
    h = (math.sin(r(b_lat - a_lat) / 2) ** 2
         + math.cos(r(a_lat)) * math.cos(r(b_lat)) * math.sin(r(b_lng - a_lng) / 2) ** 2)
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(h))) * 3.28084


def excluded(s, lat, lng):
    """The name of a never-a-job place the spot is inside (home, shop), or ''."""
    for x in s.get("exclude") or []:
        try:
            if feet_apart(lat, lng, float(x["lat"]), float(x["lng"])) <= float(x.get("feet") or 500):
                return str(x.get("name") or "excluded")
        except (KeyError, TypeError, ValueError):
            continue
    return ""


def mend_queue(s):
    """A waiting photo whose shrunk files are gone (deleted, a crash part way)
    is made again from the iCloud original; with that gone too, let go."""
    for pid, p in list(s["photos"].items()):
        files = [os.path.join(QUEUE, pid + ".jpg"), os.path.join(QUEUE, pid + "_t.jpg")]
        if all(os.path.isfile(f) for f in files):
            continue
        src = os.path.join(ICLOUD, p["file"])
        tk = "mend|" + pid
        try:
            img = read_photo(src)["img"]
            shrink(img, FULL_PX, FULL_Q, files[0])
            shrink(img, THUMB_PX, THUMB_Q, files[1])
            s["tries"].pop(tk, None)
        except Unfit:
            raise
        except Exception:                    # noqa: BLE001 - iCloud may still be downloading it
            s["tries"][tk] = s["tries"].get(tk, 0) + 1
            if not os.path.exists(src) or s["tries"][tk] >= READ_TRIES:
                s["tries"].pop(tk, None)
                mark(s, pid, "not-at-a-job", why="its files are gone and its iCloud original won't open")


def scan(s, limit=SCAN_MAX):
    since = parse_iso(s["since"]).timestamp()
    found, skipped, errors = [], {}, []
    os.makedirs(QUEUE, exist_ok=True)
    mend_queue(s)
    # The same photo under a new key (its file made again by iCloud): same
    # name, same moment taken. Never a second copy on a job.
    known = {(v.get("file"), v.get("taken")) for v in s["seen"].values() if v.get("file") and v.get("taken")}
    entries = []
    with os.scandir(ICLOUD) as it:
        for e in it:
            if not e.is_file():
                continue
            st = e.stat()
            # A file iCloud put here before the first look can't be new. The
            # time iCloud wrote it (mtime) is when it reached this PC.
            if st.st_mtime < since:
                continue
            key = key_of(e.name, getattr(st, "st_birthtime", st.st_ctime))
            if key in s["seen"]:
                continue
            entries.append((st.st_mtime, e.name, e.path, key))
    entries.sort()                           # oldest first, so a cut-off run resumes in order
    left = max(0, len(entries) - limit)
    for _mtime, name, path, key in entries[:limit]:
        kind = what_it_is(name)
        if kind != "photo":
            s["seen"][key] = {"status": kind, "at": now_iso()}
            skipped[kind] = skipped.get(kind, 0) + 1
            continue
        try:
            p = read_photo(path)
        except Unfit:
            raise
        except Exception as ex:              # noqa: BLE001 - one odd file never stops the rest
            n = s["tries"][key] = s["tries"].get(key, 0) + 1
            errors.append({"file": name, "error": str(ex)[:200], "tries": n})
            if n >= READ_TRIES:              # else tried again next run
                s["seen"][key] = {"status": "unreadable", "at": now_iso(), "why": str(ex)[:200]}
                s["tries"].pop(key, None)
            continue
        s["tries"].pop(key, None)
        if (name, p["at"]) in known:
            s["seen"][key] = {"status": "same-as-before", "at": now_iso(), "file": name, "taken": p["at"]}
            skipped["same-as-before"] = skipped.get("same-as-before", 0) + 1
            continue
        if "front" in p["lens"].lower():
            why = "selfie"                   # the front camera: never a job photo
        elif p["at"] and parse_iso(p["at"]).timestamp() < since:
            # An old photo whose file iCloud wrote again (it downloads a
            # cloud-only file when anything opens it, and that gives it a new
            # date): taken before the sorter started, so it could only land on
            # today's bid for a house that was a job years ago.
            why = "taken-before-start"
        elif p["lat"] is None:
            why = "no-location"
        elif p["make"] and p["make"].lower() not in ("apple", "samsung", "google"):
            why = "not-a-phone"              # a picture saved from somewhere else
        else:
            place = excluded(s, p["lat"], p["lng"])
            why = ("at-" + place) if place else None   # home or shop: never read further
        if why:
            s["seen"][key] = {"status": why, "at": now_iso(), "file": name, "taken": p["at"]}
            skipped[why] = skipped.get(why, 0) + 1
            continue
        pid = id_of(key)
        try:
            w, h = shrink(p["img"], FULL_PX, FULL_Q, os.path.join(QUEUE, pid + ".jpg"))
            shrink(p["img"], THUMB_PX, THUMB_Q, os.path.join(QUEUE, pid + "_t.jpg"))
        except Exception as ex:              # noqa: BLE001 - tried again next run
            errors.append({"file": name, "error": "shrinking: " + str(ex)[:180]})
            continue
        photo = {"id": pid, "key": key, "file": name, "at": p["at"], "lat": round(p["lat"], 7),
                 "lng": round(p["lng"], 7), "acc": p["acc"], "model": p["model"], "w": w, "h": h,
                 "status": "queued", "found": now_iso()}
        s["photos"][pid] = photo
        s["seen"][key] = {"status": "queued", "at": now_iso(), "id": pid, "file": name, "taken": p["at"]}
        known.add((name, p["at"]))
        found.append(photo)
    return {"new": found, "skipped": skipped, "errors": errors, "notYetLooked": left}


def waiting(s):
    """Photos still to settle: new ones and held ones, oldest first, each with
    the two files to hand to the Job Hub page (small copy first)."""
    out = []
    for p in sorted(s["photos"].values(), key=lambda p: p.get("at") or p.get("found") or ""):
        files = [os.path.join(QUEUE, p["id"] + "_t.jpg"), os.path.join(QUEUE, p["id"] + ".jpg")]
        out.append(dict(p, files=files, filesThere=all(os.path.isfile(f) for f in files)))
    return out


def tidy(s):
    """Lets go of photos held past HOLD_DAYS and forgets settled names past
    KEEP_DAYS (their files are older than any look can reach)."""
    cut = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=HOLD_DAYS)
    for pid, p in list(s["photos"].items()):
        if p.get("status") == "held" and parse_iso(p.get("heldAt") or p["found"]) < cut:
            mark(s, pid, "not-at-a-job", why="held %d days, no bid came" % HOLD_DAYS)
    old = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=KEEP_DAYS)
    for k, v in list(s["seen"].items()):
        if v.get("status") != "queued" and v.get("status") != "held" and parse_iso(v.get("at") or now_iso()) < old:
            del s["seen"][k]


def mark(s, pid, status, job=None, stage=None, lead=None, why=None):
    if status not in STATUSES:
        raise SystemExit("status must be one of " + ", ".join(sorted(STATUSES)))
    p = s["photos"].get(pid)
    if not p:
        raise SystemExit("no photo waiting with id " + pid)
    rec = {"status": status, "at": now_iso(), "id": pid, "file": p.get("file"), "taken": p.get("at")}
    for k, v in (("job", job), ("stage", stage), ("lead", lead), ("why", why)):
        if v:
            rec[k] = v
    s["seen"][p["key"]] = rec
    if status == "held":
        p.update({"status": "held", "heldAt": p.get("heldAt") or now_iso(), "lead": lead or p.get("lead"),
                  "why": why or p.get("why")})
        return
    del s["photos"][pid]
    for suffix in (".jpg", "_t.jpg"):
        try:
            os.remove(os.path.join(QUEUE, pid + suffix))
        except FileNotFoundError:
            pass


# ----------------------------------------------------------------- main

def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    cmd = argv[0]
    if cmd == "scan":
        s = load()
        try:
            out = scan(s)
        except Unfit as ex:                  # nothing saved: nothing given up on
            print(json.dumps({"error": str(ex), "waiting": []}))
            raise SystemExit(2)
        tidy(s)
        save(s)
        out["waiting"] = waiting(s)
        print(json.dumps(out, indent=1))
    elif cmd == "status":
        s = load()
        print(json.dumps({"since": s["since"], "seen": len(s["seen"]), "waiting": waiting(s)}, indent=1))
    elif cmd == "mark":
        # mark <id> <status> [job=…] [stage=…] [lead=…] [why=…]
        s = load()
        opts = dict(a.split("=", 1) for a in argv[3:] if "=" in a)
        mark(s, argv[1], argv[2], opts.get("job"), opts.get("stage"), opts.get("lead"), opts.get("why"))
        save(s)
        print("ok", argv[1], argv[2])
    else:
        raise SystemExit("unknown command " + cmd)


if __name__ == "__main__":
    main(sys.argv[1:])
