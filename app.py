import os
import requests
import math 
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv

from services.geocode import geocode
from services.routing import get_routes
from services.air_quality import (
    sample_route,
    sample_route_forecast_with_margin,
    get_pollution,
)
from exposure import (
    exposure_score,
    compare_all_routes,
    apply_sensitivity,
    SENSITIVITY_FACTORS,
)

from flask import send_from_directory

load_dotenv()
app = Flask(__name__)
@app.route("/sw.js")
def service_worker():
    resp = send_from_directory("static", "sw.js", mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    return resp

# kg CO2 per passenger-km — fuel only (transit is an average bus/rail estimate)
CARBON_FACTORS = {
    "drive":   0.162,
    "bike":    0.016,
    "cycle":   0.016,
    "walk":    0.0,
    "transit": 0.089,
}

# Breathing-rate / exposure multipliers
MODE_FACTORS = {
    "drive":   1.0,
    "bike":    2.5,
    "cycle":   2.5,
    "walk":    2.0,
    "transit": 1.2,   # mostly in-vehicle, plus walking and waiting at stops
}

# Transit is estimated from the road route
TRANSIT_SPEED_FACTOR = 1.4   # stops and slower average speed
TRANSIT_WAIT_S = 300         # ~5 min average wait


# ============================================================
# Pages
# ============================================================
@app.route("/")
def index():
    return render_template("index.html")


# ============================================================
# IPU NUMBER
# ============================================================
@app.route("/api/malaysia-stations")
def malaysia_stations():
    """Fetch AQICN stations across Malaysia via the map bounds endpoint."""
    token = os.getenv("AQICN_TOKEN")
    if not token:
        return jsonify({"error": "AQICN token not configured"}), 500

    # AQICN's map/bounds endpoint returns all stations in a lat/lng box.
    # Bounding box covers peninsular + Borneo Malaysia.
    url = f"https://api.waqi.info/map/bounds/?latlng=0.5,99.0,7.5,120.0&token={token}"

    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "ok":
            return jsonify({"error": "AQICN returned an error"}), 502
        return jsonify(data.get("data", []))
    except Exception as e:
        return jsonify({"error": str(e)}), 502


# ============================================================
# API: geocode a single query
# ============================================================
@app.route("/api/geocode", methods=["POST"])
def api_geocode():
    q = (request.json or {}).get("q", "").strip()
    if not q:
        return jsonify({"error": "Empty query"}), 400
    result = geocode(q)
    if not result:
        return jsonify({"error": f"Could not find '{q}'"}), 404
    lon, lat, name = result
    return jsonify({"lon": lon, "lat": lat, "name": name})


# ============================================================
# API: compare routes
# ============================================================
@app.route("/api/compare", methods=["POST"])
def compare():
    import time

    data = request.json or {}
    start_q = (data.get("start") or "").strip()
    end_q = (data.get("end") or "").strip()
    mode = data.get("mode", "drive")
    profile = data.get("profile", "adult")

    if not start_q or not end_q:
        return jsonify({"error": "Please fill in both start and end."}), 400

    start = geocode(start_q)
    end = geocode(end_q)

    if not start:
        return jsonify({"error": f"Could not locate start: '{start_q}'"}), 400
    if not end:
        return jsonify({"error": f"Could not locate end: '{end_q}'"}), 400

    # Transit has no routing profile — use the road route and estimate from it
    route_mode = "drive" if mode == "transit" else mode

    try:
        raw_routes = get_routes((start[0], start[1]), (end[0], end[1]), mode=route_mode)
    except Exception as e:
        return jsonify({"error": f"Routing failed: {e}"}), 502

    if not raw_routes:
        return jsonify({"error": "No route found between those points."}), 404

    departure_ts = int(time.time())

    mode_factor = MODE_FACTORS.get(mode, 1.0)
    carbon_factor = CARBON_FACTORS.get(mode, 0.162)

    results = []
    for i, r in enumerate(raw_routes):
        # --- Effective duration (transit = slower + wait) ---
        duration_s = r["duration_s"]
        if mode == "transit":
            duration_s = duration_s * TRANSIT_SPEED_FACTOR + TRANSIT_WAIT_S

        # --- Current pollution + exposure ---
        pollution = sample_route(r["coords"])
        exposure = exposure_score(pollution, duration_s)
        if exposure is not None:
            exposure *= mode_factor
            exposure = apply_sensitivity(exposure, profile)

        # --- Forecast pollution at arrival ---
        arrival_ts = departure_ts + int(duration_s)
        forecast_pm25, forecast_margin = sample_route_forecast_with_margin(r["coords"], arrival_ts)
        forecast_exposure = None
        forecast_exposure_margin = None
        if forecast_pm25 is not None:
            forecast_exposure = forecast_pm25 * (duration_s / 60) * mode_factor
            forecast_exposure = apply_sensitivity(forecast_exposure, profile)
            if forecast_margin is not None:
                forecast_exposure_margin = forecast_margin * (duration_s / 60) * mode_factor
                forecast_exposure_margin = apply_sensitivity(forecast_exposure_margin, profile)

        # --- Carbon (independent of pollution) ---
        co2_kg = (r["distance_m"] / 1000) * carbon_factor

        # --- Per-route reasoning (plain language) ---
        reasoning_why = []

        minutes = round(duration_s / 60)
        km = round(r["distance_m"] / 1000, 1)
        reasoning_why.append(f"Takes about {minutes} min over {km} km.")

        if pollution and pollution.get("pm2_5") is not None:
            reasoning_why.append(
                f"Current PM2.5 along the route: {pollution['pm2_5']:.1f} µg/m³."
            )

        if forecast_pm25 is not None:
            reasoning_why.append(
                f"Forecast PM2.5 at arrival: {forecast_pm25:.1f} µg/m³."
            )

        if pollution and forecast_pm25 is not None:
            now_pm = pollution.get("pm2_5", 0)
            delta_pm = forecast_pm25 - now_pm
            if abs(delta_pm) >= 1.5:
                direction = "higher" if delta_pm > 0 else "lower"
                reasoning_why.append(
                    f"Air is forecast to be {direction} at arrival "
                    f"({now_pm:.1f} → {forecast_pm25:.1f} µg/m³)."
                )

        if mode in ("bike", "cycle"):
            reasoning_why.append("Cycling multiplies exposure ×2.5 due to breathing rate.")
        elif mode == "walk":
            reasoning_why.append("Walking multiplies exposure ×2.0 due to breathing rate.")
        elif mode == "transit":
            reasoning_why.append(
                "Transit is estimated from the road route (about +40% time plus a 5 min wait); "
                "exposure ×1.2 for walking and waiting at stops."
            )

        if profile != "adult":
            factor = SENSITIVITY_FACTORS.get(profile, 1.0)
            reasoning_why.append(
                f"Sensitivity factor ×{factor} applied for '{profile}' profile."
            )

        # Confidence in this route's forecast
        if forecast_pm25 is None:
            reasoning_conf = "Low — using current readings only"
        elif pollution and abs(forecast_pm25 - pollution.get("pm2_5", forecast_pm25)) < 1.5:
            reasoning_conf = "High — forecast and current readings agree"
        else:
            reasoning_conf = "Moderate — forecast and current readings differ"

        reasoning = {
            "why": reasoning_why,
            "confidence": reasoning_conf,
        }

        results.append({
            "name": chr(65 + i),
            "duration_s": round(duration_s),
            "distance_m": round(r["distance_m"]),
            "pollution": pollution,
            "exposure": round(exposure, 1) if exposure is not None else None,
            "forecast_pm25": round(forecast_pm25, 1) if forecast_pm25 is not None else None,
            "forecast_margin": round(forecast_margin, 1) if forecast_margin is not None else None,
            "forecast_exposure": round(forecast_exposure, 1) if forecast_exposure is not None else None,
            "forecast_exposure_margin": round(forecast_exposure_margin, 1) if forecast_exposure_margin is not None else None,
            "arrival_ts": arrival_ts,
            "co2_kg": round(co2_kg, 2),
            "coords": r["coords"],
            "start_name": start[2],
            "end_name": end[2],
            "reasoning": reasoning,
        })

    verdict = compare_all_routes(results, profile=profile)

    return jsonify({
        "routes": results,
        "verdict": verdict,
        "departure_ts": departure_ts,
        "start": {"lon": start[0], "lat": start[1], "name": start[2]},
        "end": {"lon": end[0], "lat": end[1], "name": end[2]},
        "mode": mode,
        "profile": profile,
    })

# ============================================================
# API: Nearest AQI Stations (For iOS Widget)
# ============================================================
@app.route("/api/nearest-stations")
def nearest_stations():
    user_lat = request.args.get("lat", type=float)
    user_lon = request.args.get("lon", type=float)
    
    if not user_lat or not user_lon:
        return jsonify({"error": "Missing lat/lon parameters"}), 400

    # Re-use the AQICN fetch logic
    token = os.getenv("AQICN_TOKEN")
    if not token:
        return jsonify({"error": "AQICN token not configured"}), 500

    url = f"https://api.waqi.info/map/bounds/?latlng=0.5,99.0,7.5,120.0&token={token}"
    
    try:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        data = r.json()
        stations = data.get("data", [])
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    # Calculate distance for each station
    valid_stations = []
    for s in stations:
        try:
            aqi_str = s.get("aqi", "-1")
            # AQICN sometimes returns "-" for offline stations
            if aqi_str == "-": continue
            aqi = int(aqi_str)
            if aqi < 0: continue
            
            # Haversine distance
            lat2, lon2 = s["lat"], s["lon"]
            R = 6371.0 # Earth radius in km
            dLat = math.radians(lat2 - user_lat)
            dLon = math.radians(lon2 - user_lon)
            a = math.sin(dLat/2)**2 + math.cos(math.radians(user_lat)) * math.cos(math.radians(lat2)) * math.sin(dLon/2)**2
            c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
            dist_km = round(R * c, 1)
            
            valid_stations.append({
                "name": s["station"]["name"],
                "aqi": aqi,
                "dist_km": dist_km
            })
        except Exception:
            continue

    # Sort by distance (closest first) and get top 3
    valid_stations.sort(key=lambda x: x["dist_km"])
    top_3 = valid_stations[:3]

    return jsonify(top_3)


# ============================================================
# Run
# ============================================================
if __name__ == "__main__":
    app.run(debug=True, port=5000)