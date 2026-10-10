import os
import time
import requests

OW_URL = "https://api.openweathermap.org/data/2.5/air_pollution"
CACHE_TTL = 900  # 15 minutes
_cache = {}  # key: (round(lat,2), round(lon,2)) -> (timestamp, data)

def _cache_key(lat, lon):
    return (round(lat, 2), round(lon, 2))

def get_pollution(lat, lon):
    key = _cache_key(lat, lon)
    now = time.time()
    if key in _cache and now - _cache[key][0] < CACHE_TTL:
        return _cache[key][1]

    params = {"lat": lat, "lon": lon, "appid": os.getenv("OPENWEATHER_API_KEY")}
    try:
        r = requests.get(OW_URL, params=params, timeout=10)
        r.raise_for_status()
        c = r.json()["list"][0]["components"]
        result = {
            "pm2_5": c.get("pm2_5", 0) or 0,
            "pm10": c.get("pm10", 0) or 0,
            "no2": c.get("no2", 0) or 0,
            "o3": c.get("o3", 0) or 0,
        }
    except Exception:
        result = None

    _cache[key] = (now, result)
    return result

def sample_route(coords, n=5):
    """
    Average pollution across up to n evenly-spaced points spanning from start to destination.
    Returns dict of pollutants or None if all samples failed.
    """
    if not coords:
        return None
    if len(coords) < 2:
        return get_pollution(coords[0][1], coords[0][0])

    if len(coords) <= n:
        samples = coords
    else:
        indices = [round(i * (len(coords) - 1) / (n - 1)) for i in range(n)]
        samples = [coords[i] for i in indices]

    readings = [get_pollution(lat, lon) for lon, lat in samples]
    readings = [r for r in readings if r]

    if not readings:
        return None

    keys = readings[0].keys()
    return {k: round(sum(r[k] for r in readings) / len(readings), 2) for k in keys}