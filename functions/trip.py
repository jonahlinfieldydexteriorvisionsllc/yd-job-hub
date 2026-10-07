"""Miles to a job, and this week's fuel prices -- for the fuel on an estimate.

Fuel is priced on every estimate from the road miles between the shop and the
job (both trucks there and back every day on site) and the price of gas and
diesel (pricing.js does the sums). Both are plain lookups, so no Claude:

  * miles: the job's address and the shop's become map points (OpenStreetMap,
    kept so each address is looked up once -- digest.py's jobGeo), and the
    public OSRM router gives the driving distance between them;
  * fuel: the US Energy Information Administration's weekly retail averages
    for the Midwest, regular gasoline and diesel, read from its public table
    at most once a week and kept in pricing/fuel. An estimate can use a
    different price; this is the default.
"""

import datetime
import re

import requests

import digest as dg

EIA_URL = "https://www.eia.gov/dnav/pet/pet_pri_gnd_dcus_r20_w.htm"   # Midwest (PADD 2), weekly
GAS_SERIES = "EMM_EPMR_PTE_R20_DPG"        # regular gasoline, all formulations
DIESEL_SERIES = "EMD_EPD2D_PTE_R20_DPG"    # No. 2 diesel, on-highway
FUEL_DAYS = 7                              # a new figure comes out every week
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/%.6f,%.6f;%.6f,%.6f"
METERS_PER_MILE = 1609.344


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


# ------------------------------------------------------------------- fuel

def _latest(page, series):
    """The newest weekly figure in the row whose history link names `series`."""
    i = page.find("s=" + series + "&")
    if i < 0:
        return None
    row = page[page.rfind('<tr class="DataRow">', 0, i):i]
    m = re.search(r'class="Current2">\s*([0-9]+\.[0-9]+)\s*<', row)
    return float(m.group(1)) if m else None


def fuel_prices(force=False):
    """pricing/fuel as it stands, refreshed first if it is a week old."""
    ref = dg._db().collection("pricing").document("fuel")
    snap = ref.get()
    cur = (snap.to_dict() or {}) if snap.exists else {}
    try:
        fetched = datetime.datetime.fromisoformat(cur.get("fetchedAt") or "")
    except ValueError:
        fetched = None
    if not force and fetched and _now() - fetched < datetime.timedelta(days=FUEL_DAYS):
        return cur
    try:
        r = requests.get(EIA_URL, timeout=20, headers={"User-Agent": dg.UA})
        r.raise_for_status()
        page = r.text
        gas, diesel = _latest(page, GAS_SERIES), _latest(page, DIESEL_SERIES)
        weeks = re.findall(r'class="Series5"[^>]*>\s*([0-9]{2})/([0-9]{2})/([0-9]{2})', page)
        if gas is None or diesel is None:
            print("trip: fuel prices not found on the EIA page")
            return cur
        mo, day, yy = weeks[-1] if weeks else ("", "", "")
        out = {"gasCents": round(gas * 100, 1), "dieselCents": round(diesel * 100, 1),
               "asOf": ("20%s-%s-%s" % (yy, mo, day)) if yy else "",
               "source": "US EIA weekly Midwest average", "fetchedAt": _now().isoformat()}
        ref.set(out)
        return out
    except Exception as e:              # noqa: BLE001
        # An old price is better than none; the estimate shows its date.
        print("trip: fuel prices failed:", e)
        return cur


# ------------------------------------------------------------------ miles

def _split(address):
    """'W5883 Loveland Rd, Monticello, WI 53570' -> street, town, zip."""
    parts = [p.strip() for p in str(address or "").split(",") if p.strip()]
    z = re.search(r"\b(\d{5})\b", address or "")
    street = parts[0] if parts else ""
    town = parts[1] if len(parts) > 1 else ""
    town = re.sub(r"\b(WI|Wisconsin)\b.*$", "", town, flags=re.I).strip()
    return street, town, z.group(1) if z else ""


def _town_point(town, zip_):
    """The middle of a town, when a rural address cannot be found."""
    q = ", ".join(x for x in [town, "WI", zip_] if x)
    if not q.strip(", "):
        return None
    try:
        r = requests.get("https://nominatim.openstreetmap.org/search", timeout=15,
                         headers={"User-Agent": dg.UA},
                         params={"q": q, "country": "USA", "format": "json", "limit": 1})
        hit = r.json()
        return (float(hit[0]["lat"]), float(hit[0]["lon"])) if hit else None
    except Exception as e:              # noqa: BLE001
        print("trip: town lookup failed:", e)
        return None


def _shop_point():
    """The shop, from the address on the Pricing rules screen; kept with it."""
    ref = dg._db().collection("pricing").document("rules")
    rules = ref.get().to_dict() or {}
    shop = rules.get("shop") or {}
    address = str(shop.get("address") or "").strip()
    if not address:
        return None, "the shop address is not set in Pricing rules"
    if shop.get("key") == address and shop.get("lat") is not None:
        return (shop["lat"], shop["lng"]), None
    street, town, zip_ = _split(address)
    point = dg._job_point("shop", {"address": street, "city": town, "zip": zip_}) or _town_point(town, zip_)
    if not point:
        return None, "the shop address could not be found on the map"
    ref.set({"shop": {"address": address, "key": address, "lat": point[0], "lng": point[1]}}, merge=True)
    return point, None


def trip(d):
    """{jobId, address, city, state, zip} -> {miles, approx, fuel} or {error}."""
    street = str(d.get("address") or "").strip()
    town = str(d.get("city") or "").strip()
    zip_ = str(d.get("zip") or "").strip()
    job_id = str(d.get("jobId") or "").strip()
    fuel = fuel_prices()
    if not street and not town:
        return {"error": "The job has no address", "fuel": fuel}
    shop, why = _shop_point()
    if not shop:
        return {"error": "Can't work out miles: " + why, "fuel": fuel}
    point, approx = None, False
    if street and job_id and "/" not in job_id:
        point = dg._job_point(job_id, {"address": street, "city": town, "zip": zip_})
    if not point:
        point, approx = _town_point(town, zip_), True
    if not point:
        return {"error": "That address could not be found on the map", "fuel": fuel}
    try:
        r = requests.get(OSRM_URL % (shop[1], shop[0], point[1], point[0]), timeout=20,
                         headers={"User-Agent": dg.UA}, params={"overview": "false"})
        route = (r.json().get("routes") or [None])[0]
    except Exception as e:              # noqa: BLE001
        print("trip: route failed:", e)
        return {"error": "The road distance could not be worked out just now", "fuel": fuel}
    if not route:
        return {"error": "No road route was found to that address", "fuel": fuel}
    out = {"miles": round(route["distance"] / METERS_PER_MILE, 1), "approx": approx, "fuel": fuel}
    # Where the job is, when the street was found (not the middle of town):
    # the estimate picks a town's MDS delivery zone from it (Madison is
    # priced west / central / east).
    if not approx:
        out["point"] = [round(point[0], 5), round(point[1], 5)]
    return out
