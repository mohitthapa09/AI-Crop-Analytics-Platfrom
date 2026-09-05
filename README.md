# AgriVision Backend

A real backend + database for the AI Crop Analytics frontend, replacing the
old `localStorage`-only version of `app.js`. Built with **Flask** and
**SQLite** so it runs anywhere with just Python — no external database
server, and no npm packages to install.

## What it does

- **Auth**: real user accounts (hashed passwords, JWT tokens) instead of
  users saved in the browser's localStorage.
- **Database**: your three CSVs (`crop_yield.csv`, `state_soil_data.csv`,
  `state_weather_data_1997_2020.csv`) are loaded into SQLite tables and
  actually queried — the yield forecast is a real historical average for
  that crop/state, not a made-up number.
- **Scan history**: saved server-side per user, in the database, instead of
  the last 20 entries in localStorage.

## Setup

```bash
cd backend
python -m venv venv && source venv/bin/activate   # optional but recommended
pip install -r requirements.txt
python init_db.py     # builds agrivision.db from the CSVs in data/
python app.py          # starts the API on http://localhost:5000
```

Re-run `python init_db.py` any time you replace the CSVs in `data/` — it
rebuilds the reference tables from scratch while leaving your `users` and
`scan_history` tables alone. Pass `--reset-all` to wipe those too.

## Database schema

| Table            | Purpose                                                        |
|------------------|------------------------------------------------------------------|
| `users`          | id, name, email (unique), password_hash, created_at             |
| `scan_history`   | one row per saved analysis, linked to `users.id`                |
| `crop_yield`     | imported from `crop_yield.csv` — crop/year/season/state/area/production/fertilizer/pesticide/yield |
| `state_soil`     | imported from `state_soil_data.csv` — N, P, K, pH per state      |
| `state_weather`  | imported from `state_weather_data_1997_2020.csv` — temp/rainfall/humidity per state/year |

## API

All responses are JSON. Authenticated routes expect
`Authorization: Bearer <token>`.

### Auth
- `POST /api/auth/register` — `{ name, email, password }` → `{ token, user }`
- `POST /api/auth/login` — `{ email, password }` → `{ token, user }`
- `GET /api/auth/me` — current user (auth required)

### Reference data (from the imported CSVs)
- `GET /api/states` — list of states with soil data on file
- `GET /api/crops` — list of distinct crops on file
- `GET /api/soil/<state>` — N/P/K/pH for a state
- `GET /api/weather/<state>` — latest year + trailing 5-year average
  (or `?year=YYYY` for a specific year)
- `GET /api/yield-stats?crop=&state=&season=` — historical avg/min/max
  yield and fertilizer/pesticide-per-area for a crop (state/season optional)

### Analysis
- `POST /api/analyze` — auth optional (saves to history only if logged in)

  Body:
  ```json
  {
    "crop": "Rice", "state": "Assam", "country": "India", "city": "Guwahati",
    "soilType": "Alluvial Soil", "ph": 6.2, "moisture": 52, "farmSize": 2,
    "diagnosis": "Likely Healthy (pixel pre-scan)", "confidence": 72, "isHealthy": true
  }
  ```
  `diagnosis`/`confidence`/`isHealthy` are optional — pass through whatever
  the client-side leaf-image pixel pre-scan produced; the backend never
  invents a disease diagnosis on its own, it only folds a supplied one into
  the health score.

  The response's `dataBasis` field lists exactly which real records (soil
  reference, weather average, historical yield) fed into the numbers, so
  it's clear when a figure is a genuine historical average vs. a fallback
  estimate (used only when a crop/state has no records at all).

### History (auth required)
- `GET /api/history` — the logged-in user's last 50 scans
- `DELETE /api/history/<id>` — delete one of their scans

## Wiring up the existing frontend

`app.js` currently does auth and analysis entirely client-side
(`getLocalUsers`, `generateLiveResults`, etc.). To point it at this backend,
the main changes are:
1. Replace the `localStorage`-based `handleLogin`/`handleRegister`/`handleLogout`
   with `fetch()` calls to `/api/auth/*`, storing the returned `token`
   (e.g. in `localStorage` under a new key, just for the token — not the
   user database itself) and sending it as `Authorization: Bearer <token>`
   on later requests.
2. Replace `generateLiveResults()`'s local formula with a `fetch('/api/analyze', {...})`
   call, still doing the pixel-scan/geolocation bits client-side and passing
   their results in the request body.
3. Replace `getLocalScanHistory()`/`addLocalScanHistory()` with
   `GET /api/history` calls.

Happy to make those edits to `app.js` directly if you'd like — just say the
word.
