"""
AgriVision backend — Flask + SQLite.

Replaces the old frontend-only (localStorage) auth/analysis in app.js with
a real API + database:

  Auth               POST /api/auth/register
                      POST /api/auth/login
                      GET  /api/auth/me

  Reference data      GET  /api/states
                      GET  /api/crops
                      GET  /api/soil/<state>
                      GET  /api/weather/<state>?year=YYYY
                      GET  /api/yield-stats?crop=&state=&season=

  Analysis            POST /api/analyze          (auth optional)

  History             GET    /api/history        (auth required)
                      DELETE /api/history/<id>    (auth required)

Run:
    python init_db.py      # one-time (or after CSVs change)
    python app.py           # starts on http://localhost:5000
"""

import os
import sqlite3
import datetime
import jwt

from flask import Flask, request, jsonify, g
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agrivision.db")

JWT_SECRET = os.environ.get("AGRIVISION_JWT_SECRET", "dev-secret-change-me")
JWT_ALGO = "HS256"
JWT_EXPIRY_HOURS = 24 * 7

app = Flask(__name__)

# ---------------------------------------------------------------------------
# CORS (hand-rolled — no external dependency needed)
# ---------------------------------------------------------------------------
@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def cors_preflight(_any):
    return ("", 204)


# ---------------------------------------------------------------------------
# DB HELPERS
# ---------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def row_to_dict(row):
    return dict(row) if row is not None else None


# ---------------------------------------------------------------------------
# AUTH HELPERS
# ---------------------------------------------------------------------------
def make_token(user_id, email):
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.datetime.utcnow(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def decode_token(token):
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        return None


def get_current_user_id():
    """Returns user_id if a valid Bearer token is present, else None.
    Auth is OPTIONAL on /api/analyze (anonymous scans allowed) and
    REQUIRED on /api/history (enforced via @login_required)."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    payload = decode_token(auth[7:])
    return payload["sub"] if payload else None


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({"error": "Authentication required"}), 401
        g.user_id = user_id
        return fn(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# AUTH ROUTES
# ---------------------------------------------------------------------------
@app.post("/api/auth/register")
def register():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    if not name or not email or not password:
        return jsonify({"error": "name, email, and password are all required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        return jsonify({"error": "An account with this email already exists"}), 409

    pw_hash = generate_password_hash(password)
    cur = db.execute(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
        (name, email, pw_hash),
    )
    db.commit()
    user_id = cur.lastrowid
    token = make_token(user_id, email)
    return jsonify({"token": token, "user": {"id": user_id, "name": name, "email": email}}), 201


@app.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid email or password"}), 401

    token = make_token(user["id"], user["email"])
    return jsonify({
        "token": token,
        "user": {"id": user["id"], "name": user["name"], "email": user["email"]},
    })


@app.get("/api/auth/me")
@login_required
def me():
    db = get_db()
    user = db.execute("SELECT id, name, email, created_at FROM users WHERE id = ?",
                       (g.user_id,)).fetchone()
    return jsonify(row_to_dict(user))


# ---------------------------------------------------------------------------
# REFERENCE DATA ROUTES
# ---------------------------------------------------------------------------
@app.get("/api/states")
def list_states():
    db = get_db()
    rows = db.execute("SELECT DISTINCT state FROM state_soil ORDER BY state").fetchall()
    return jsonify([r["state"] for r in rows])


@app.get("/api/crops")
def list_crops():
    db = get_db()
    rows = db.execute("SELECT DISTINCT crop FROM crop_yield ORDER BY crop").fetchall()
    return jsonify([r["crop"] for r in rows])


@app.get("/api/soil/<state>")
def soil_for_state(state):
    db = get_db()
    row = db.execute("SELECT * FROM state_soil WHERE state = ? COLLATE NOCASE",
                      (state,)).fetchone()
    if not row:
        return jsonify({"error": f"No soil data for state '{state}'"}), 404
    return jsonify(row_to_dict(row))


@app.get("/api/weather/<state>")
def weather_for_state(state):
    """?year=YYYY returns that year's record; otherwise returns the most
    recent year on file plus a trailing-5-year average."""
    db = get_db()
    year = request.args.get("year", type=int)

    if year:
        row = db.execute(
            "SELECT * FROM state_weather WHERE state = ? COLLATE NOCASE AND year = ?",
            (state, year),
        ).fetchone()
        if not row:
            return jsonify({"error": f"No weather data for {state} in {year}"}), 404
        return jsonify(row_to_dict(row))

    latest = db.execute(
        "SELECT * FROM state_weather WHERE state = ? COLLATE NOCASE ORDER BY year DESC LIMIT 1",
        (state,),
    ).fetchone()
    if not latest:
        return jsonify({"error": f"No weather data for state '{state}'"}), 404

    avg5 = db.execute(
        """SELECT AVG(avg_temp_c) AS avg_temp_c,
                  AVG(total_rainfall_mm) AS total_rainfall_mm,
                  AVG(avg_humidity_percent) AS avg_humidity_percent
           FROM state_weather
           WHERE state = ? COLLATE NOCASE
           ORDER BY year DESC LIMIT 5""",
        (state,),
    ).fetchone()

    return jsonify({
        "latest": row_to_dict(latest),
        "trailing_5yr_avg": row_to_dict(avg5),
    })


@app.get("/api/yield-stats")
def yield_stats():
    """Aggregated historical stats for a crop (optionally scoped to a state
    and/or season) — the real numbers behind the yield forecast."""
    crop = request.args.get("crop")
    state = request.args.get("state")
    season = request.args.get("season")

    if not crop:
        return jsonify({"error": "crop is required"}), 400

    where = ["crop = ? COLLATE NOCASE"]
    params = [crop]
    if state:
        where.append("state = ? COLLATE NOCASE")
        params.append(state)
    if season:
        where.append("season = ? COLLATE NOCASE")
        params.append(season)

    db = get_db()
    row = db.execute(
        f"""SELECT COUNT(*) AS records,
                   AVG(yield_val) AS avg_yield,
                   MIN(yield_val) AS min_yield,
                   MAX(yield_val) AS max_yield,
                   AVG(fertilizer / NULLIF(area, 0)) AS avg_fertilizer_per_area,
                   AVG(pesticide / NULLIF(area, 0)) AS avg_pesticide_per_area,
                   MIN(year) AS earliest_year,
                   MAX(year) AS latest_year
            FROM crop_yield
            WHERE {' AND '.join(where)}""",
        params,
    ).fetchone()

    result = row_to_dict(row)
    if not result or not result["records"]:
        msg = f"No yield records found for crop='{crop}'"
        if state:
            msg += f", state='{state}'"
        return jsonify({"error": msg}), 404
    return jsonify(result)


# ---------------------------------------------------------------------------
# ANALYSIS — the core endpoint, driven by the real datasets
# ---------------------------------------------------------------------------
SOIL_RETENTION_MULTIPLIER = {
    "Alluvial Soil": 1.05,
    "Black Soil": 1.10,
    "Cinder Soil": 0.85,
    "Red Soil": 0.95,
}
SOIL_OPTIMAL_MOISTURE = {
    "Alluvial Soil": 55,
    "Black Soil": 60,
    "Cinder Soil": 35,
    "Red Soil": 40,
}


def fetch_soil_row(db, state):
    return db.execute("SELECT * FROM state_soil WHERE state = ? COLLATE NOCASE",
                       (state,)).fetchone()


def fetch_weather_avg(db, state):
    return db.execute(
        """SELECT AVG(avg_temp_c) AS avg_temp_c,
                  AVG(total_rainfall_mm) AS total_rainfall_mm,
                  AVG(avg_humidity_percent) AS avg_humidity_percent
           FROM state_weather
           WHERE state = ? COLLATE NOCASE
           ORDER BY year DESC LIMIT 5""",
        (state,),
    ).fetchone()


def fetch_yield_baseline(db, crop, state):
    """Historical average yield (tons/hectare-equivalent, per the source
    dataset's 'yield' column) for this crop in this state; falls back to
    the national average for the crop if the state has no records."""
    row = db.execute(
        """SELECT AVG(yield_val) AS avg_yield, COUNT(*) AS n
           FROM crop_yield WHERE crop = ? COLLATE NOCASE AND state = ? COLLATE NOCASE""",
        (crop, state),
    ).fetchone()
    if row and row["n"]:
        return row["avg_yield"], "state"

    row = db.execute(
        """SELECT AVG(yield_val) AS avg_yield, COUNT(*) AS n
           FROM crop_yield WHERE crop = ? COLLATE NOCASE""",
        (crop,),
    ).fetchone()
    if row and row["n"]:
        return row["avg_yield"], "national"

    return None, "none"


@app.post("/api/analyze")
def analyze():
    body = request.get_json(silent=True) or {}

    crop = (body.get("crop") or "Wheat").strip()
    state = (body.get("state") or "").strip()
    country = (body.get("country") or "India").strip()
    city = (body.get("city") or "").strip()
    soil_type = body.get("soilType") or "Alluvial Soil"
    ph = float(body.get("ph") or 6.5)
    manual_moisture = float(body.get("moisture") or 50)
    farm_size = float(body.get("farmSize") or 1)

    # Optional — the client can still pass the leaf-image pixel pre-scan
    # result (diagnosis/confidence). The backend never guesses a diagnosis
    # it can't support; it just folds a supplied one into the health score.
    diagnosis = body.get("diagnosis") or "Healthy Crop"
    confidence = float(body.get("confidence") or 90)
    is_healthy = bool(body.get("isHealthy", True))

    db = get_db()
    data_basis = []

    # --- soil: blend the user-entered pH with the state's on-file pH ---
    soil_row = fetch_soil_row(db, state) if state else None
    if soil_row:
        ref_ph = soil_row["ph"]
        blended_ph = round((ph + ref_ph) / 2, 2)
        data_basis.append(f"soil reference for {state} (N {soil_row['n']}, "
                           f"P {soil_row['p']}, K {soil_row['k']}, pH {ref_ph})")
    else:
        blended_ph = ph

    # --- weather: trailing 5-yr average informs effective moisture ---
    weather_row = fetch_weather_avg(db, state) if state else None
    optimal_moisture = SOIL_OPTIMAL_MOISTURE.get(soil_type, 50)
    if weather_row and weather_row["avg_humidity_percent"] is not None:
        # nudge the manually entered moisture toward the region's average
        # humidity, rather than overriding it outright
        effective_moisture = round((manual_moisture * 0.7) + (weather_row["avg_humidity_percent"] * 0.3), 1)
        data_basis.append(
            f"5yr weather avg for {state} ({round(weather_row['avg_temp_c'], 1)}°C, "
            f"{round(weather_row['total_rainfall_mm'])}mm rain/yr, "
            f"{round(weather_row['avg_humidity_percent'], 1)}% humidity)"
        )
    else:
        effective_moisture = manual_moisture

    # --- health score (pH fit + moisture fit + disease signal) ---
    ph_score = max(0, 100 - abs(blended_ph - 6.5) * 18)
    moisture_score = max(0, 100 - abs(effective_moisture - optimal_moisture) * 1.6)
    disease_score = 95 if is_healthy else max(10, 100 - confidence)
    health_score = round(min(max(
        ph_score * 0.3 + moisture_score * 0.35 + disease_score * 0.35, 0), 100), 1)

    # --- yield forecast: real historical average for this crop/state,
    #     scaled by how this scan's health score compares to a 70-point
    #     baseline, then adjusted for soil retention ---
    baseline_yield, basis = fetch_yield_baseline(db, crop, state)
    retention_mult = SOIL_RETENTION_MULTIPLIER.get(soil_type, 1.0)

    if baseline_yield is not None:
        health_adjustment = 0.75 + (health_score / 100) * 0.5  # 0.75x - 1.25x
        yield_forecast = round(baseline_yield * health_adjustment * retention_mult, 3)
        data_basis.append(
            f"{basis} historical average yield for {crop}"
            f"{f' in {state}' if basis == 'state' else ''}: {round(baseline_yield, 3)}"
        )
    else:
        # No historical record at all for this crop — fall back to the
        # original generic formula so the endpoint still returns a number.
        yield_forecast = round((3.0 + (health_score / 100) * 2.5) * retention_mult, 2)
        data_basis.append("no historical yield records found — used generic estimate")

    total_yield_forecast = round(yield_forecast * farm_size, 3)

    recommendations = [
        f"Apply nitrogen fertilizer suited for pH {blended_ph}"
        + (f" (state soil reference pH {soil_row['ph']})" if soil_row else "") + ".",
        f"Schedule irrigation based on {effective_moisture}% effective soil moisture "
        f"({soil_type}, target ~{optimal_moisture}%).",
    ]
    if soil_row:
        recommendations.append(
            f"State soil profile — N {soil_row['n']}, P {soil_row['p']}, K {soil_row['k']}: "
            "balance fertilizer dosing against these baseline levels."
        )
    if not soil_row:
        recommendations.append(f"No on-file soil reference for '{state}' — used entered values only.")
    if basis == "none":
        recommendations.append(f"No historical yield data on file for '{crop}' — forecast is a generic estimate.")

    result = {
        "crop": crop,
        "country": country,
        "state": state,
        "city": city,
        "soilType": soil_type,
        "ph": blended_ph,
        "moisture": effective_moisture,
        "healthScore": health_score,
        "diagnosis": diagnosis,
        "confidence": confidence,
        "yieldForecast": yield_forecast,
        "farmSize": farm_size,
        "totalYieldForecast": total_yield_forecast,
        "dataBasis": data_basis,
        "recommendations": recommendations,
    }

    # Save to history if the caller is authenticated; anonymous scans are
    # simply not persisted (mirrors the old "guest mode" behavior).
    user_id = get_current_user_id()
    if user_id:
        db.execute(
            """INSERT INTO scan_history
               (user_id, crop, country, state, city, soil_type, ph, moisture,
                health_score, diagnosis, confidence, yield_forecast, farm_size,
                total_yield_forecast, data_basis)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (user_id, crop, country, state, city, soil_type, blended_ph, effective_moisture,
             health_score, diagnosis, confidence, yield_forecast, farm_size,
             total_yield_forecast, "; ".join(data_basis)),
        )
        db.commit()
        result["saved"] = True
    else:
        result["saved"] = False

    return jsonify(result)


# ---------------------------------------------------------------------------
# HISTORY ROUTES
# ---------------------------------------------------------------------------
@app.get("/api/history")
@login_required
def get_history():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM scan_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
        (g.user_id,),
    ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.delete("/api/history/<int:scan_id>")
@login_required
def delete_history(scan_id):
    db = get_db()
    row = db.execute("SELECT id FROM scan_history WHERE id = ? AND user_id = ?",
                      (scan_id, g.user_id)).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404
    db.execute("DELETE FROM scan_history WHERE id = ?", (scan_id,))
    db.commit()
    return jsonify({"deleted": scan_id})


# ---------------------------------------------------------------------------
@app.get("/api/health")
def health_check():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    if not os.path.exists(DB_PATH):
        print("No database found — run `python init_db.py` first.")
    app.run(host="0.0.0.0", port=5000, debug=True)
