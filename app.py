from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv

from services.geocode import geocode
from services.routing import get_routes
from services.air_quality import sample_route, get_pollution
from exposure import exposure_score, compare_all_routes, apply_sensitivity

load_dotenv()
app = Flask(__name__)

# kg CO2 per km — fuel-burned only
CARBON_FACTORS = {
    "drive":  0.162,
    "cycle":  0.016,
    "walk":   0.0,
}


# ============================================================
# Pages
# ============================================================
@app.route("/")
def index():
    return render_template("index.html")


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

    try:
        raw_routes = get_routes((start[0], start[1]), (end[0], end[1]), mode=mode)
    except Exception as e:
        return jsonify({"error": f"Routing failed: {e}"}), 502

    if not raw_routes:
        return jsonify({"error": "No route found between those points."}), 404

    # Breathing factor by transport mode
    mode_factor = {
        "drive": 1.0,
        "bike": 2.5,
        "cycle": 2.5,
        "walk": 2.0,
    }.get(mode, 1.0)
    carbon_factor = CARBON_FACTORS.get(mode, 0.162)

    results = []
    for i, r in enumerate(raw_routes):
        pollution = sample_route(r["coords"])
        exposure = exposure_score(pollution, r["duration_s"])
        if exposure is not None:
            exposure *= mode_factor
            exposure = apply_sensitivity(exposure, profile)

            co2_kg = (r["distance_m"] / 1000) * carbon_factor

        results.append({
            "name": chr(65 + i),  # A, B, C, D, E
            "duration_s": round(r["duration_s"]),
            "distance_m": round(r["distance_m"]),
            "pollution": pollution,
            "exposure": round(exposure, 1) if exposure is not None else None,
            "co2_kg": round(co2_kg, 2),
            "coords": r["coords"],
            "start_name": start[2],
            "end_name": end[2],
        })

    verdict = compare_all_routes(results, profile=profile)

    return jsonify({
        "routes": results,
        "verdict": verdict,
        "start": {"lon": start[0], "lat": start[1], "name": start[2]},
        "end": {"lon": end[0], "lat": end[1], "name": end[2]},
        "mode": mode,
    })


# ============================================================
# API: Malaysia air quality — top 10 by current API reading
# ============================================================
@app.route("/api/my-air-quality")
def my_air_quality():
    locations = [
        {"name": "Pasir Gudang, Johor",       "lat": 1.4724, "lon": 103.9089},
        {"name": "Batu Pahat, Johor",         "lat": 1.8548, "lon": 102.9320},
        {"name": "Segamat, Johor",            "lat": 2.5147, "lon": 102.8156},
        {"name": "Seremban, Negeri Sembilan", "lat": 2.7259, "lon": 101.9378},
        {"name": "Cheras, Kuala Lumpur",      "lat": 3.0387, "lon": 101.7448},
        {"name": "Shah Alam, Selangor",       "lat": 3.0733, "lon": 101.5185},
        {"name": "Bukit Rambai, Melaka",      "lat": 2.2778, "lon": 102.1772},
        {"name": "Tasek Ipoh, Perak",         "lat": 4.6116, "lon": 101.0917},
        {"name": "Putrajaya",                 "lat": 2.9264, "lon": 101.6964},
        {"name": "Kuantan, Pahang",           "lat": 3.8077, "lon": 103.3260},
        {"name": "Kota Kinabalu, Sabah",      "lat": 5.9804, "lon": 116.0735},
        {"name": "Kuching, Sarawak",          "lat": 1.5533, "lon": 110.3592},
    ]

    def fetch_api(loc):
        p = get_pollution(loc["lat"], loc["lon"])
        api = None
        if p and p.get("pm2_5") is not None:
            pm = p["pm2_5"]
            if pm <= 12:
                api = round(pm * 4)
            elif pm <= 35:
                api = round(50 + (pm - 12) * 2)
            elif pm <= 55:
                api = round(100 + (pm - 35) * 2)
            elif pm <= 150:
                api = round(150 + (pm - 55) * 0.5)
            else:
                api = round(200 + (pm - 150) * 0.3)
        return {**loc, "api": api}

    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(fetch_api, locations))

    return jsonify(results)


# ============================================================
# Run
# ============================================================
if __name__ == "__main__":
    app.run(debug=True, port=5000)