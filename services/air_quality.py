import os
import time
import requests
import time as _time

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


FORECAST_URL = "https://api.openweathermap.org/data/2.5/air_pollution/forecast"

def get_forecast(lat, lon):
    """
    Return list of {timestamp, pm2_5, pm10, no2, o3} for the next 24h.
    Cached for 30 minutes per grid cell.
    """
    key = ("fc", round(lat, 2), round(lon, 2))
    now = _time.time()
    if key in _cache and now - _cache[key][0] < 1800:
        return _cache[key][1]

    params = {"lat": lat, "lon": lon, "appid": os.getenv("OPENWEATHER_API_KEY")}
    try:
        r = requests.get(FORECAST_URL, params=params, timeout=10)
        r.raise_for_status()
        rows = r.json().get("list", [])
        result = []
        for row in rows:
            comp = row.get("components", {})
            result.append({
                "timestamp": row["dt"],
                "pm2_5": comp.get("pm2_5", 0) or 0,
                "pm10":  comp.get("pm10", 0) or 0,
                "no2":   comp.get("no2", 0) or 0,
                "o3":    comp.get("o3", 0) or 0,
            })
    except Exception:
        result = []

    _cache[key] = (now, result)
    return result


def pm25_at_time(forecast, target_ts):
    """Find PM2.5 closest to target_ts in the forecast list."""
    if not forecast:
        return None
    closest = min(forecast, key=lambda r: abs(r["timestamp"] - target_ts))
    return closest["pm2_5"]


def sample_route_forecast(coords, arrival_ts, n=5):
    """
    For each of n points along the route, predict PM2.5 at arrival_ts.
    Returns averaged forecast PM2.5 or None.
    """
    if not coords:
        return None
    if len(coords) < 2:
        fc = get_forecast(coords[0][1], coords[0][0])
        return pm25_at_time(fc, arrival_ts)

    step = max(1, len(coords) // n)
    samples = coords[::step][:n]

    values = []
    for lon, lat in samples:
        fc = get_forecast(lat, lon)
        v = pm25_at_time(fc, arrival_ts)
        if v is not None:
            values.append(v)

    if not values:
        return None
    return sum(values) / len(values)