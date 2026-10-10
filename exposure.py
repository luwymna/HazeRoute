"""
Exposure estimation and route comparison.

Exposure = PM2.5 (µg/m³) × duration (minutes) × sensitivity factor.

The sensitivity factor accounts for how different people respond to the
same air quality. A PM2.5 reading that's fine for a healthy adult may be
harmful for an asthmatic.
"""


# Sensitivity multipliers — applied to the winner-check threshold
# and reported in the verdict message.
SENSITIVITY_FACTORS = {
    "adult":    1.0,   # baseline
    "child":    1.4,   # children breathe faster, more vulnerable
    "elderly":  1.3,
    "asthma":   1.8,   # pre-existing respiratory condition
    "pregnant": 1.2,
}

# Above this effective exposure, the verdict changes to "consider delaying"
# even if a lower-exposure route was found.
HIGH_EXPOSURE_THRESHOLD = 400


def exposure_score(pollution, duration_seconds):
    """Exposure = PM2.5 (µg/m³) × duration (minutes). Returns None if no data."""
    if not pollution:
        return None
    pm2_5 = pollution.get("pm2_5")
    if pm2_5 is None:
        return None
    return pm2_5 * (duration_seconds / 60)


def apply_sensitivity(exposure, profile):
    """Multiply exposure by the sensitivity factor for the given profile."""
    if exposure is None:
        return None
    factor = SENSITIVITY_FACTORS.get(profile, 1.0)
    return exposure * factor


def compare_all_routes(routes, profile="adult"):
    """
    Given 2–5 routes (each with 'name' and 'exposure'), pick the best.
    `profile` adjusts verdict language for sensitive groups.

    Returns dict with winner, message, confidence, best, worst, all_scores,
    plus profile metadata.
    """
    scored = [r for r in routes if r.get("exposure") is not None]

    if len(scored) < 2:
        return {
            "winner": None,
            "message": "Not enough pollution data to compare routes.",
            "confidence": "none",
            "profile": profile,
        }

    ranked = sorted(scored, key=lambda r: r["exposure"])
    best = ranked[0]
    worst = ranked[-1]

    # All-zero case: air is clean everywhere
    if worst["exposure"] == 0:
        return {
            "winner": None,
            "message": "Air quality is clean on all routes — comparable exposure.",
            "confidence": "low",
            "profile": profile,
            "all_scores": {r["name"]: r["exposure"] for r in scored},
        }

    diff = (worst["exposure"] - best["exposure"]) / worst["exposure"]

    # Routes are effectively tied
    if diff < 0.10:
        return {
            "winner": None,
            "message": f"All {len(scored)} routes have comparable estimated exposure.",
            "confidence": "low",
            "diff_pct": round(diff * 100, 1),
            "profile": profile,
            "all_scores": {r["name"]: r["exposure"] for r in scored},
        }

    # Find the route with the lowest carbon cost
    scored_with_co2 = [r for r in scored if r.get("co2_kg") is not None]
    lowest_co2 = min(scored_with_co2, key=lambda r: r["co2_kg"]) if scored_with_co2 else None
    same_as_best = lowest_co2 and lowest_co2["name"] == best["name"]

    # --- Winner exists. Tailor the message by profile. ---
    saving_pct = round(diff * 100)
    sensitivity = SENSITIVITY_FACTORS.get(profile, 1.0)
    effective_exposure = best["exposure"]  # already scaled by apply_sensitivity in app.py

    if effective_exposure > HIGH_EXPOSURE_THRESHOLD:
        # Even the cleanest route is above the safe threshold for this profile
        if profile in ("asthma", "child", "elderly"):
            message = (
                f"Route {best['name']} is the lowest-exposure option, "
                f"but estimated exposure is still high for your profile. "
                f"Consider delaying travel or avoiding outdoor exertion."
            )
        else:
            message = (
                f"Route {best['name']} has the lowest exposure, "
                f"but levels are elevated — about {saving_pct}% lower "
                f"than Route {worst['name']}."
            )
    elif same_as_best:
        # Best route for exposure is ALSO best for carbon
        message = (
            f"Route {best['name']} is best on both measures — lowest pollution "
            f"exposure ({best['exposure']:.0f}) and lowest carbon "
            f"({best['co2_kg']:.2f} kg CO₂)."
        )
    elif lowest_co2:
        # Two different routes win on the two measures — the interesting case
        message = (
            f"Route {best['name']} has the lowest pollution exposure "
            f"({best['exposure']:.0f}). "
            f"For the lowest carbon, choose Route {lowest_co2['name']} "
            f"({lowest_co2['co2_kg']:.2f} kg CO₂)."
        )
    else:
        # No carbon data available — fall back to plain exposure message
        message = (
            f"Route {best['name']} has the lowest estimated pollution exposure "
            f"— about {saving_pct}% lower than Route {worst['name']}."
        )

    return {
        "winner": best["name"],
        "co2_winner": lowest_co2["name"] if lowest_co2 else None,
        "same_winner": bool(same_as_best),
        "message": message,
        "confidence": "moderate" if diff > 0.25 else "low",
        "diff_pct": saving_pct,
        "best": best["name"],
        "worst": worst["name"],
        "profile": profile,
        "sensitivity_factor": sensitivity,
        "effective_exposure": round(effective_exposure, 1),
        "all_scores": {r["name"]: r["exposure"] for r in scored},
    }