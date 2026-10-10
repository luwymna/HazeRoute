import os
import math
import json
import base64
import time
import requests
from requests.exceptions import ConnectionError, Timeout

MAX_ROUTES = 3  # cap for display

MODE_PROFILES = {
    "drive": "driving-car",
    "car": "driving-car",
    "bike": "cycling-regular",
    "cycle": "cycling-regular",
    "walk": "foot-walking",
}


def _get_api_key():
    raw = (os.getenv("ORS_API_KEY") or "").strip()
    if raw.startswith("eyJ"):
        try:
            padded = raw + "=" * (-len(raw) % 4)
            decoded = json.loads(base64.b64decode(padded).decode("utf-8"))
            if "org" in decoded and "id" in decoded:
                return f"{decoded['org']}{decoded['id']}"
        except Exception:
            pass
    return raw


def _call_ors(coords, profile="driving-car", alternatives=True):
    url = f"https://api.heigit.org/openrouteservice/v2/directions/{profile}/geojson"
    raw_key = (os.getenv("ORS_API_KEY") or "").strip()
    key = _get_api_key()

    body = {"coordinates": coords, "units": "m"}
    if alternatives and len(coords) == 2 and profile.startswith("driving"):
        body["alternative_routes"] = {
            "target_count": 3,
            "weight_factor": 2.0,   # allow more deviation to find alternatives
            "share_factor": 0.6,    # max overlap between alternatives (lower = more distinct)
        }

    keys_to_try = [key]
    if raw_key and raw_key != key:
        keys_to_try.append(raw_key)

    last_resp = None
    for k in keys_to_try:
        headers = {
            "Authorization": k,
            "Content-Type": "application/json",
        }
        r = None
        last_net_err = None
        for attempt in range(3):
            try:
                r = requests.post(url, json=body, headers=headers, timeout=30)
                break
            except (ConnectionError, Timeout) as net_err:
                last_net_err = net_err
                if attempt < 2:
                    time.sleep(1.5 ** attempt)  # 1s, then 1.5s
                continue

        if r is None:
            raise RuntimeError(f"Could not connect to OpenRouteService: {last_net_err}")

        if r.status_code in (401, 403) and len(keys_to_try) > 1 and k == keys_to_try[0]:
            last_resp = r
            continue

        if not r.ok:
            try:
                err_data = r.json()
                msg = err_data.get("error", {}).get("message") or err_data.get("message") or r.text
            except Exception:
                msg = r.text
            raise RuntimeError(f"OpenRouteService ({r.status_code}): {msg}")

        return r.json()["features"]

    if last_resp is not None:
        try:
            msg = last_resp.json().get("error", {}).get("message") or last_resp.text
        except Exception:
            msg = last_resp.text
        raise RuntimeError(f"OpenRouteService ({last_resp.status_code}): {msg}")

    return []


def _to_route(feature):
    summary = feature["properties"]["summary"]
    return {
        "duration_s": summary["duration"],
        "distance_m": summary["distance"],
        "coords": feature["geometry"]["coordinates"],
    }


def _offset_point(start, end, fraction, side):
    """
    Build a waypoint at `fraction` along the straight line start→end,
    pushed perpendicular by ~15% of the line length. side = +1 or -1.
    """
    mx = start[0] + (end[0] - start[0]) * fraction
    my = start[1] + (end[1] - start[1]) * fraction
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy) or 1e-6
    # Perpendicular unit vector
    px = -dy / length
    py = dx / length
    push = length * 0.15 * side
    return [mx + px * push, my + py * push]


def _dedupe(routes, tolerance=0.03):
    """Remove routes whose duration AND distance are both within tolerance."""
    unique = []
    for r in routes:
        dup = False
        for u in unique:
            d_dur = abs(r["duration_s"] - u["duration_s"]) / max(u["duration_s"], 1)
            d_dist = abs(r["distance_m"] - u["distance_m"]) / max(u["distance_m"], 1)
            if d_dur < tolerance and d_dist < tolerance:
                dup = True
                break
        if not dup:
            unique.append(r)
    return unique


def get_routes(start, end, mode="drive"):
    """
    Returns up to MAX_ROUTES route dicts, ordered by duration ascending.
    Each: {duration_s, distance_m, coords}
    """
    profile = MODE_PROFILES.get(mode, "driving-car")
    routes = []
    last_err = None

    # 1. Ask ORS for alternatives
    try:
        features = _call_ors([list(start), list(end)], profile=profile, alternatives=True)
        routes = [_to_route(f) for f in features]
    except Exception as e:
        last_err = e
        # Retry without alternatives flag (some ORS plans don't allow it)
        try:
            features = _call_ors([list(start), list(end)], profile=profile, alternatives=False)
            routes = [_to_route(f) for f in features]
        except Exception as e2:
            last_err = e2
            routes = []

    if not routes and last_err:
        raise last_err

    # 2. If we have fewer than MAX_ROUTES, generate detour variants
    detour_specs = [
        (0.5, +1),   # midpoint pushed left
        (0.5, -1),   # midpoint pushed right
        (0.3, +1),
        (0.7, -1),
    ]
    for frac, side in detour_specs:
        if len(routes) >= MAX_ROUTES:
            break
        try:
            wp = _offset_point(start, end, frac, side)
            feats = _call_ors([list(start), wp, list(end)], profile=profile, alternatives=False)
            if feats:
                routes.append(_to_route(feats[0]))
        except Exception:
            continue

    # 3. Dedupe & sort by duration
    routes = _dedupe(routes)
    routes.sort(key=lambda r: r["duration_s"])
    return routes[:MAX_ROUTES]