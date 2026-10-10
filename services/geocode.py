import re
import requests

NOMINATIM = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "HazeRoute-Prototype/1.0"}

_geocode_cache = {}

def parse_coords(text):
    """Return (lon, lat) if text is 'lat,lon' (standard) or 'lon,lat'. Else None."""
    if not text:
        return None
    nums = re.findall(r"-?\d+\.?\d*", text)
    if len(nums) != 2:
        return None
    try:
        a, b = float(nums[0]), float(nums[1])
    except ValueError:
        return None

    # If first number exceeds 90, it must be longitude: (lon, lat)
    if abs(a) > 90 and abs(b) <= 90:
        return (a, b)
    # Standard format: lat, lon (Google Maps, Apple Maps, OSM) -> returns (lon, lat)
    if abs(a) <= 90 and abs(b) <= 180:
        return (b, a)
    return None

def geocode(place):
    """Return (lon, lat, display_name) or None."""
    if not place:
        return None
    place = place.strip()
    coords = parse_coords(place)
    if coords:
        return (coords[0], coords[1], f"{coords[1]:.4f}, {coords[0]:.4f}")

    cache_key = place.lower()
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    try:
        r = requests.get(
            NOMINATIM,
            params={"q": place, "format": "json", "limit": 1},
            headers=HEADERS,
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        if not data:
            return None
        res = (float(data[0]["lon"]), float(data[0]["lat"]), data[0]["display_name"])
        _geocode_cache[cache_key] = res
        return res
    except Exception:
        return None