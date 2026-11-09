"""Finding an address on the map.

The US Census geocoder first: it knows US street addresses -- Wisconsin's
rural fire numbers included ("N1234 County Rd X") -- far better than
OpenStreetMap, which often has the road but not the house, and it needs no
key. It cannot be called from a browser (no CORS), which is why the app asks
this server. OpenStreetMap's Nominatim is the fallback for anything the
Census does not know (a brand-new subdivision).

Plain lookups, no Claude.
"""

import math
import re
import time

import requests

UA = "YD Job Hub (jonahlinfield@ydexteriorvisions.com)"
CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/address"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# The map knows "Trail" far better than "Tr" -- only a trailing street type
# is spelled out ("45 St Marys Dr" keeps its Saint).
STREET_TYPES = {"tr": "Trail", "trl": "Trail", "cir": "Circle", "rd": "Road", "dr": "Drive", "st": "Street",
                "ave": "Avenue", "av": "Avenue", "ln": "Lane", "ct": "Court", "blvd": "Boulevard", "pl": "Place",
                "ter": "Terrace", "pkwy": "Parkway", "hwy": "Highway", "pt": "Point", "cv": "Cove"}


def _spelled_out(street):
    words = (street or "").split()
    if len(words) < 2:
        return None
    full = STREET_TYPES.get(words[-1].rstrip(".").lower())
    return " ".join(words[:-1] + [full]) if full else None


def _title(s):
    return " ".join(w.capitalize() for w in str(s or "").split())


def _census(street, city, state, zip_):
    params = {"street": street, "city": city, "state": state or "WI", "zip": zip_,
              "benchmark": "Public_AR_Current", "format": "json"}
    r = requests.get(CENSUS_URL, params={k: v for k, v in params.items() if v}, timeout=20,
                     headers={"User-Agent": UA})
    # A 4xx is the Census refusing what it was given (a street with no town
    # or ZIP): it won't find it, which is "not found". Only its being down
    # (5xx, no answer) is "couldn't check" -- find() then says so.
    if 400 <= r.status_code < 500:
        return None
    r.raise_for_status()
    hits = ((r.json().get("result") or {}).get("addressMatches")) or []
    if not hits:
        return None
    h = hits[0]
    c = h.get("addressComponents") or {}
    return {"lat": float(h["coordinates"]["y"]), "lng": float(h["coordinates"]["x"]),
            "matched": h.get("matchedAddress") or "", "town": _title(c.get("city")) or _title(city) or None,
            "zip": c.get("zip") or zip_ or None, "source": "census"}


# OpenStreetMap answers a street it only half knows with the first road of
# that name anywhere in the state: a Fitchburg 53711 address on a street too
# new for either map (9 Nov 2026) came back as the road of that name in
# Green Bay, ZIP 54229, and put a snow customer 125 miles off the route. So a match is kept only when it is where the address says: its ZIP
# is the one asked; or its town is the one asked and no ZIP says otherwise
# (Wisconsin has more than one Springfield and Dunn); or it is within
# FAR_MILES of the middle of that ZIP or town. A different ZIP alone is not
# enough to refuse one: a "Madison" mailing address can sit in Fitchburg,
# and the map may file the road under the next ZIP over. 15 miles covers the
# big rural ZIPs (Mount Horeb's, Lodi's) and still refuses another part of
# the state. Anything else is "not found", which says so on the screen,
# where a wrong spot said nothing.
FAR_MILES = 15
PLACE_KEYS = ("city", "town", "village", "hamlet", "municipality", "suburb", "city_district")


def _five(z):
    m = re.search(r"\d{5}", str(z or ""))
    return m.group(0) if m else ""


def _fives(z):
    """Every ZIP in a postcode: OpenStreetMap writes a road in two as '53711;53713'."""
    return set(re.findall(r"\d{5}", str(z or "")))


def _place(s):
    """'Town of Dunn' and 'Dunn', 'Sun Prairie' and 'sun prairie' are one place."""
    s = re.sub(r"^\s*(city|town|village)\s+of\s+", "", str(s or "").lower())
    return re.sub(r"[^a-z]", "", s)


def _miles(a_lat, a_lng, b_lat, b_lng):
    rad = math.radians
    h = (math.sin(rad(b_lat - a_lat) / 2) ** 2 +
         math.cos(rad(a_lat)) * math.cos(rad(b_lat)) * math.sin(rad(b_lng - a_lng) / 2) ** 2)
    return 2 * 3958.8 * math.asin(math.sqrt(h))


def _middle(city, state, zip_):
    """The middle of the ZIP (or, with none, the town) the address names, or
    None. Nominatim's own ZIP search finds nothing; a line of text does."""
    for q in ([", ".join(x for x in (zip_, state or "WI") if x)] if zip_ else []) + \
             ([", ".join(x for x in (city, state or "WI") if x)] if city else []):
        time.sleep(1.1)                 # their policy: one request a second
        r = requests.get(NOMINATIM_URL, timeout=15, headers={"User-Agent": UA},
                         params={"q": q, "countrycodes": "us", "format": "json", "limit": 1})
        hit = r.json()
        if hit:
            return float(hit[0]["lat"]), float(hit[0]["lon"])
    return None


def _wrong_state(a, state):
    iso = str(a.get("ISO3166-2-lvl4") or "")
    want = str(state or "WI").strip()
    if len(want) == 2 and iso:
        return iso[-2:].upper() != want.upper()
    return bool(a.get("state")) and len(want) > 2 and _place(a.get("state")) != _place(want)


def _nominatim(street, city, state, zip_):
    tries = []
    for s in [_spelled_out(street), street]:
        if not s:
            continue
        if zip_:
            tries.append({"street": s, "postalcode": zip_})
        if city:
            tries.append({"street": s, "city": city})
    want_zip, want_town = _five(zip_), _place(city)
    middle = []                         # looked up once, only when a match needs it
    for i, where in enumerate(tries):
        if i:
            time.sleep(1.1)             # their policy: one request a second
        r = requests.get(NOMINATIM_URL, timeout=15, headers={"User-Agent": UA},
                         params=dict(where, state=state or "WI", country="USA", format="json", limit=5,
                                     addressdetails=1))
        for h in r.json() or []:
            a = h.get("address") or {}
            lat, lng = float(h["lat"]), float(h["lon"])
            if _wrong_state(a, state):
                continue
            zips = _fives(a.get("postcode"))
            fits = (want_zip and want_zip in zips) or \
                   (want_town and not (want_zip and zips) and
                    any(_place(a.get(k)) == want_town for k in PLACE_KEYS))
            if not fits:
                if not middle:
                    middle.append(_middle(city, state, want_zip))
                fits = bool(middle[0]) and _miles(lat, lng, *middle[0]) <= FAR_MILES
            if not fits:
                print("geo: passed over OpenStreetMap's %r for %r, %r %r: not in that town or ZIP"
                      % (h.get("display_name", ""), street, city, zip_))
                continue
            return {"lat": lat, "lng": lng, "matched": h.get("display_name", ""),
                    "town": a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or city or None,
                    "zip": a.get("postcode") or zip_ or None, "source": "openstreetmap"}
    return None


def find(street, city="", state="WI", zip_=""):
    """{lat, lng, matched, town, zip, source} or None. Raises only when
    neither service could be reached (so "no signal" is not "not found")."""
    street, city, zip_ = str(street or "").strip(), str(city or "").strip(), str(zip_ or "").strip()
    if not street:
        return None
    failed = False
    for look in (_census, _nominatim):
        try:
            got = look(street, city, state, zip_)
            if got:
                return got
        except Exception as e:          # noqa: BLE001
            failed = True
            print("geo: %s failed: %s" % (look.__name__, e))
    # One service saying "not there" while the other could not be asked is
    # not "not found": the caller tries again later (jobGeo keeps no answer,
    # the snow form says there was no signal) rather than writing it off.
    if failed:
        raise RuntimeError("The map services could not be reached")
    return None

# ------------------------------------------------------------ as you type
#
# Jonah (21 Oct 2026): "link google maps so when typing in an address it can
# be autofilled using google maps if possible." Google's needs a key with
# billing on his account; until he wants that, OpenStreetMap's data through
# Photon -- made for search-as-you-type, no key -- with what is near Madison
# first. It often knows the road but not the house, so the house number
# typed is kept on a road it finds.
PHOTON_URL = "https://photon.komoot.io/api/"
NEAR = {"lat": 43.07, "lon": -89.40}
# Only southern Wisconsin -- Dane, Green, Rock and the counties around them
# (minLon, minLat, maxLon, maxLat): a street of the same name in Orlando is
# never the one meant.
AREA = "-90.8,42.4,-88.4,43.9"
STATE_CODES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO",
    "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA",
    "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY"}
# "123 Main St...", "N1234 County Rd X": the house (or fire) number first.
HOUSE_NO = re.compile(r"^\s*([NSEW]?\d+[A-Za-z]?)\s+\S")


def suggest(q, limit=5):
    """[{street, city, state, zip, lat, lng}] that begin like `q`, nearest
    Madison first, in the US only. Raises when Photon cannot be reached."""
    q = re.sub(r"\s+", " ", str(q or "")).strip()[:120]
    if len(q) < 4:
        return []
    m = HOUSE_NO.match(q)
    typed_no = m.group(1) if m else ""
    r = requests.get(PHOTON_URL, timeout=6, headers={"User-Agent": UA},
                     params=dict(NEAR, q=q, limit=12, lang="en", bbox=AREA))
    r.raise_for_status()
    out, seen = [], set()
    for f in r.json().get("features") or []:
        p = f.get("properties") or {}
        if str(p.get("countrycode") or "").upper() != "US":
            continue
        road = p.get("street") or (p.get("name") if p.get("osm_key") == "highway" else "")
        if not road:
            continue
        # Another house on the street is not the one being typed.
        if typed_no and p.get("housenumber") and str(p["housenumber"]).lower() != typed_no.lower():
            continue
        no = str(p.get("housenumber") or typed_no or "").strip()
        city = p.get("city") or p.get("town") or p.get("village") or p.get("locality") or ""
        hit = {"street": (no + " " + road).strip(), "city": city, "state": STATE_CODES.get(p.get("state"), ""),
               "zip": str(p.get("postcode") or "")[:10]}
        key = (hit["street"].lower(), hit["city"].lower())
        if key in seen:
            continue
        seen.add(key)
        coords = ((f.get("geometry") or {}).get("coordinates") or [None, None])
        hit["lng"], hit["lat"] = coords[0], coords[1]
        out.append(hit)
        if len(out) >= limit:
            break
    return out

# ------------------------------------------------------- which town it is in
#
# Jonah (26 Oct 2026): "auto fill city state and zip everywhere applicable
# after typing in address". A street typed with no town yet: the Census
# street-and-town search above refuses it ("Specify ... City and State
# and/or ZIP Code"), but its one-line search takes the street and the state
# alone and answers with every match in the state. The ones inside the area,
# nearest Madison first, one per town and ZIP, are the answer: one fills the
# boxes (addr.js), more are offered as buttons to tap. Wisconsin's rural fire
# numbers included -- the map (Photon) rarely has those houses.
CENSUS_LINE_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
_WEST, _SOUTH, _EAST, _NORTH = (float(x) for x in AREA.split(","))
# Two towns the Census spells as two words.
TOWN_NAMES = {"Mc Farland": "McFarland", "De Forest": "DeForest"}


def _town(s):
    t = _title(s)
    return TOWN_NAMES.get(t, t)


def towns(street, state="WI", limit=4):
    """[{city, state, zip, matched, lat, lng}] where `street` (with no town)
    is, inside the area, nearest Madison first, one per town and ZIP. [] when
    there is none, or no house number to find. Raises when the Census cannot
    be reached."""
    street = re.sub(r"\s+", " ", str(street or "")).strip()[:120]
    state = re.sub(r"[^A-Za-z ]", "", str(state or "")).strip()[:20] or "WI"
    if len(street) < 4 or not re.search(r"\d", street):
        return []
    r = requests.get(CENSUS_LINE_URL, timeout=20, headers={"User-Agent": UA},
                     params={"address": street + ", " + state, "benchmark": "Public_AR_Current", "format": "json"})
    r.raise_for_status()
    found = []
    for h in ((r.json().get("result") or {}).get("addressMatches")) or []:
        try:
            lng, lat = float(h["coordinates"]["x"]), float(h["coordinates"]["y"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (_WEST <= lng <= _EAST and _SOUTH <= lat <= _NORTH):
            continue
        c = h.get("addressComponents") or {}
        # Near enough flat here: a degree east is 0.73 of a degree north.
        far = (lat - NEAR["lat"]) ** 2 + ((lng - NEAR["lon"]) * 0.73) ** 2
        found.append((far, {"city": _town(c.get("city")), "state": str(c.get("state") or "").upper()[:2],
                            "zip": str(c.get("zip") or "")[:10], "matched": h.get("matchedAddress") or "",
                            "lat": lat, "lng": lng}))
    found.sort(key=lambda x: x[0])
    out, seen = [], set()
    for _, t in found:
        key = (t["city"].lower(), t["zip"])
        if not t["city"] or key in seen:
            continue
        seen.add(key)
        out.append(t)
        if len(out) >= limit:
            break
    return out
