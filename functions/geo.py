"""Finding an address on the map.

The US Census geocoder first: it knows US street addresses -- Wisconsin's
rural fire numbers included ("W5883 Loveland Rd") -- far better than
OpenStreetMap, which often has the road but not the house, and it needs no
key. It cannot be called from a browser (no CORS), which is why the app asks
this server. OpenStreetMap's Nominatim is the fallback for anything the
Census does not know (a brand-new subdivision).

Plain lookups, no Claude.
"""

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
    r.raise_for_status()
    hits = ((r.json().get("result") or {}).get("addressMatches")) or []
    if not hits:
        return None
    h = hits[0]
    c = h.get("addressComponents") or {}
    return {"lat": float(h["coordinates"]["y"]), "lng": float(h["coordinates"]["x"]),
            "matched": h.get("matchedAddress") or "", "town": _title(c.get("city")) or _title(city) or None,
            "zip": c.get("zip") or zip_ or None, "source": "census"}


def _nominatim(street, city, state, zip_):
    tries = []
    for s in [_spelled_out(street), street]:
        if not s:
            continue
        if zip_:
            tries.append({"street": s, "postalcode": zip_})
        if city:
            tries.append({"street": s, "city": city})
    for i, where in enumerate(tries):
        if i:
            time.sleep(1.1)             # their policy: one request a second
        r = requests.get(NOMINATIM_URL, timeout=15, headers={"User-Agent": UA},
                         params=dict(where, state=state or "WI", country="USA", format="json", limit=1,
                                     addressdetails=1))
        hit = r.json()
        if hit:
            a = hit[0].get("address") or {}
            return {"lat": float(hit[0]["lat"]), "lng": float(hit[0]["lon"]), "matched": hit[0].get("display_name", ""),
                    "town": a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or city or None,
                    "zip": a.get("postcode") or zip_ or None, "source": "openstreetmap"}
    return None


def find(street, city="", state="WI", zip_=""):
    """{lat, lng, matched, town, zip, source} or None. Raises only when
    neither service could be reached (so "no signal" is not "not found")."""
    street, city, zip_ = str(street or "").strip(), str(city or "").strip(), str(zip_ or "").strip()
    if not street:
        return None
    reached = False
    for look in (_census, _nominatim):
        try:
            got = look(street, city, state, zip_)
            reached = True
            if got:
                return got
        except Exception as e:          # noqa: BLE001
            print("geo: %s failed: %s" % (look.__name__, e))
    if not reached:
        raise RuntimeError("The map services could not be reached")
    return None
