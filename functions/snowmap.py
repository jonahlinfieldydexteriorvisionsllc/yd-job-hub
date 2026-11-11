"""A first draft of a snow property's map, from the satellite photo.

Jonah (9 Nov 2026): "long term for snow removal i want birds eye maps of
propeties we clear with marked out areas anything that gives the crew mor
info and makes their job easier." Asked who draws them (11 Nov): "claudes
draft plus my fix and then ill get in person measurements for each
residential property."

So this only DRAFTS: it fetches the satellite picture around the account's
map pin, asks Claude to mark what to plow, shovel and salt, where the snow
goes and anything to watch for, and hands the marks back in map points. It
saves nothing -- the app puts the draft on the map (snowmap.js), Jonah drags
the corners where they belong and saves it, and in-person measurements go in
by hand. The picture is Esri's World Imagery, the same one the app's map
shows; its squares are stitched into one picture with the pin in the middle and a light
grid drawn on it, so Claude can say where each corner is in plain numbers
(0-1000 across and down), which are turned back into map points exactly
(Web Mercator, the projection the picture is in).
"""

import base64
import io
import json
import math

import requests

MODEL = "claude-sonnet-5-5"
TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TILE = 256
ZOOM = 19
MOST_TILES = 49
PX = 1024
# Ground shown either side of the pin: a house and its drive fit in 45 m; a
# business lot needs more.
HALF_M = {"residential": 45, "commercial": 110}
R = 6378137.0
GRID = 1000
KINDS = {
    "plow": "area", "shovel": "area", "salt": "area", "pile": "area",
    "push": "line", "hazard": "point", "start": "point",
}
MOST_MARKS = 20
MOST_POINTS = 30
WAIT_S = 120

SYSTEM = """You draw the first draft of a snow removal map for a landscaping company's crew.
You are shown a satellite photo looking straight down, with a light grid numbered 0-1000 across (x, left to right) and down (y, top to bottom). The red cross in the middle is the map pin for the customer's property: the property is the house and lot around the cross, not the neighbours.
Mark what the crew needs, as shapes in grid numbers:
- plow: paved areas the truck plows (driveway, parking lot, apron to the street). Polygon.
- shovel: walks, stoops and steps done by hand (front walk, side door path). Polygon; a narrow walk is a thin polygon along it.
- salt: areas that get salt, if the notes say salt (usually the walks and the drive's slope). Polygon. Leave it out when the notes say no salt.
- pile: where plowed snow goes (lawn edge beside the drive, end of the lot, never onto the street, the sidewalk or a neighbour's lot). Polygon.
- push: the way to push snow, as an arrow from start to end. Exactly 2 points.
- hazard: something to watch for under snow you can see or that the notes name (curb, drain grate, landscape bed edge, boulder, low wall, step, mailbox, gate). One point, with a short label.
- start: where the crew starts, if it is clear (the apron at the street). One point.
Rules: use only what you can see in the photo or what the notes say. Corners in order around the shape. Keep each polygon to the paved surface; trees can hide part of a drive, follow its likely line. 3 to 20 corners a polygon. Labels are 1 to 5 plain words for the crew (e.g. "Hidden curb", "Front walk"). If the photo is unclear (snow, shadow, trees), mark less and say so in note. note: one or two plain sentences for the owner about what to check."""

SCHEMA = {
    "type": "object",
    "properties": {
        "marks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "label": {"type": "string"},
                    "points": {"type": "array", "items": {
                        "type": "array", "items": {"type": "number"}}},
                },
                "required": ["kind", "label", "points"],
                "additionalProperties": False,
            },
        },
        "note": {"type": "string"},
    },
    "required": ["marks", "note"],
    "additionalProperties": False,
}


def merc(lat, lng):
    """Map point -> Web Mercator metres."""
    lat = max(-85.0, min(85.0, lat))
    return (R * math.radians(lng),
            R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def unmerc(x, y):
    """Web Mercator metres -> map point."""
    return (math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2),
            math.degrees(x / R))


def box_of(lat, lng, half_m):
    """The picture's corners in Mercator metres: half_m of ground either side
    (Mercator stretches distances by 1/cos(latitude), so that is undone)."""
    cx, cy = merc(lat, lng)
    h = half_m / math.cos(math.radians(lat))
    return (cx - h, cy - h, cx + h, cy + h)


def to_point(box, gx, gy):
    """Grid numbers (0-1000, y down) -> [lat, lng], six places."""
    x0, y0, x1, y1 = box
    x = x0 + (x1 - x0) * gx / GRID
    y = y1 - (y1 - y0) * gy / GRID
    lat, lng = unmerc(x, y)
    return [round(lat, 6), round(lng, 6)]


def picture(box):
    """The satellite picture for the box, JPEG bytes, or raise. Esri's
    one-picture export is switched off for this imagery (it answers 500), so
    the map's own squares at ZOOM are fetched and stitched, cut to the box
    exactly and sized to PX."""
    from PIL import Image
    world = TILE * 2 ** ZOOM
    span = 2 * math.pi * R

    def px(x, y):
        return ((x + math.pi * R) / span * world, (math.pi * R - y) / span * world)

    left, top = px(box[0], box[3])
    right, bottom = px(box[2], box[1])
    tx0, ty0 = int(left // TILE), int(top // TILE)
    tx1, ty1 = int(right // TILE), int(bottom // TILE)
    if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MOST_TILES:
        raise RuntimeError("That area is too big for one map")
    sheet = Image.new("RGB", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE))
    got = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            try:
                r = requests.get(TILES.format(z=ZOOM, y=ty, x=tx), timeout=8)
            except requests.RequestException:
                continue
            if r.status_code != 200 or not r.headers.get("Content-Type", "").startswith("image"):
                continue
            sheet.paste(Image.open(io.BytesIO(r.content)).convert("RGB"), ((tx - tx0) * TILE, (ty - ty0) * TILE))
            got += 1
    if not got:
        raise RuntimeError("The satellite picture couldn't be fetched just now")
    ox, oy = tx0 * TILE, ty0 * TILE
    cut = sheet.crop((round(left - ox), round(top - oy), round(right - ox), round(bottom - oy)))
    cut = cut.resize((PX, PX), Image.LANCZOS)
    out = io.BytesIO()
    cut.save(out, "JPEG", quality=88)
    return out.getvalue()


def with_grid(raw):
    """The picture with a light numbered grid and a red cross at the pin, so
    Claude can name places in numbers. Plain picture if Pillow can't."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return raw
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    d = ImageDraw.Draw(im, "RGBA")
    step = PX / 10
    for i in range(1, 10):
        p = round(i * step)
        d.line([(p, 0), (p, PX)], fill=(255, 255, 255, 70), width=1)
        d.line([(0, p), (PX, p)], fill=(255, 255, 255, 70), width=1)
        d.text((p + 3, 3), str(i * 100), fill=(255, 255, 0, 220))
        d.text((3, p + 3), str(i * 100), fill=(255, 255, 0, 220))
    c = PX / 2
    d.line([(c - 14, c), (c + 14, c)], fill=(255, 0, 0, 255), width=3)
    d.line([(c, c - 14), (c, c + 14)], fill=(255, 0, 0, 255), width=3)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=85)
    return out.getvalue()


def facts(a):
    """What the crew's notes already say about the place, for Claude."""
    lines = ["Kind of property: %s" % ("business" if a.get("type") == "commercial" else "home")]
    salt = a.get("saltKind")
    if salt:
        lines.append("Salt: %s" % {"none": "NO salt here", "paw": "paw-friendly salt", "regular": "salt every visit"}.get(salt, salt))
    if a.get("driveSqFt"):
        lines.append("Drive about %s sq ft" % a.get("driveSqFt"))
    if a.get("walkSqFt"):
        lines.append("Walks about %s sq ft" % a.get("walkSqFt"))
    notes = str(a.get("areaNotes") or "").strip()
    if notes:
        lines.append("Crew notes: " + notes[:1500])
    return "\n".join(lines)


def clean(got, box):
    """Claude's answer -> marks the app can draw, or [] for nothing usable.
    Shapes with the wrong number of points, or points off the picture, are
    dropped rather than guessed at."""
    marks = []
    for m in (got or {}).get("marks") or []:
        if not isinstance(m, dict) or m.get("kind") not in KINDS:
            continue
        shape = KINDS[m["kind"]]
        pts = []
        for p in (m.get("points") or [])[:MOST_POINTS]:
            if (isinstance(p, list) and len(p) == 2
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in p)
                    and 0 <= p[0] <= GRID and 0 <= p[1] <= GRID):
                pts.append(to_point(box, p[0], p[1]))
        need = {"area": 3, "line": 2, "point": 1}[shape]
        if len(pts) < need:
            continue
        if shape == "line":
            pts = [pts[0], pts[-1]]
        elif shape == "point":
            pts = pts[:1]
        marks.append({"kind": m["kind"], "label": str(m.get("label") or "")[:60], "pts": pts})
        if len(marks) >= MOST_MARKS:
            break
    return marks


def draft(client, db, account_id):
    """({"marks", "note", "box"}, usage) for one snow account, or raise
    ValueError with words for the owner."""
    snap = db.collection("snowAccounts").document(str(account_id or "")).get()
    if not snap.exists:
        raise ValueError("That snow account wasn't found")
    a = snap.to_dict() or {}
    if a.get("lat") is None or a.get("lng") is None:
        raise ValueError("Place its map pin first: the draft starts from the pin")
    half = HALF_M["commercial" if a.get("type") == "commercial" else "residential"]
    box = box_of(float(a["lat"]), float(a["lng"]), half)
    raw = with_grid(picture(box))
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=4000, system=SYSTEM,
        messages=[{"role": "user", "content": [
            {"type": "text", "text": facts(a)},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.b64encode(raw).decode("ascii")}},
            {"type": "text", "text": "Draw the map for this property."},
        ]}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default", timeout=WAIT_S,
    )
    if resp.stop_reason == "refusal":
        raise ValueError("Claude wouldn't draw this one: draw it by hand")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        got = None
    marks = clean(got, box)
    if not marks:
        return {"marks": [], "note": "Claude couldn't make out the property in the photo: draw it by hand.",
                "box": box}, resp.usage
    return {"marks": marks, "note": str((got or {}).get("note") or "")[:400], "box": box}, resp.usage
