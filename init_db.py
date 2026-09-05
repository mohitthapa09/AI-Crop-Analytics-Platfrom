"""
init_db.py — creates agrivision.db (SQLite) and loads the three source
datasets (crop_yield.csv, state_soil_data.csv, state_weather_data_1997_2020.csv)
into normalized tables, plus the app's own tables (users, scan_history).

Run once before starting the server:
    python init_db.py
Safe to re-run — it drops and recreates the data tables each time (so the
CSVs stay the single source of truth), but PRESERVES users/scan_history
unless --reset-all is passed.
"""

import sqlite3
import pandas as pd
import os
import sys
import argparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agrivision.db")
DATA_DIR = os.path.join(BASE_DIR, "data")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scan_history (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER REFERENCES users(id) ON DELETE CASCADE,
    crop                 TEXT,
    country              TEXT,
    state                TEXT,
    city                 TEXT,
    soil_type            TEXT,
    ph                   REAL,
    moisture             REAL,
    health_score         REAL,
    diagnosis            TEXT,
    confidence           REAL,
    yield_forecast        REAL,
    farm_size            REAL,
    total_yield_forecast  REAL,
    data_basis           TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scan_history_user ON scan_history(user_id);

CREATE TABLE IF NOT EXISTS crop_yield (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    crop        TEXT NOT NULL,
    year        INTEGER NOT NULL,
    season      TEXT,
    state       TEXT NOT NULL,
    area        REAL,
    production  REAL,
    fertilizer  REAL,
    pesticide   REAL,
    yield_val   REAL
);

CREATE INDEX IF NOT EXISTS idx_crop_yield_crop_state ON crop_yield(crop, state);
CREATE INDEX IF NOT EXISTS idx_crop_yield_state_year ON crop_yield(state, year);

CREATE TABLE IF NOT EXISTS state_soil (
    state TEXT PRIMARY KEY,
    n     REAL,
    p     REAL,
    k     REAL,
    ph    REAL
);

CREATE TABLE IF NOT EXISTS state_weather (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    state                 TEXT NOT NULL,
    year                  INTEGER NOT NULL,
    avg_temp_c            REAL,
    total_rainfall_mm     REAL,
    avg_humidity_percent  REAL
);

CREATE INDEX IF NOT EXISTS idx_state_weather_state_year ON state_weather(state, year);
"""


def load_crop_yield(conn):
    path = os.path.join(DATA_DIR, "crop_yield.csv")
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    # normalize whitespace in text columns (source CSV has trailing spaces,
    # e.g. "Kharif     ")
    for col in ["crop", "season", "state"]:
        df[col] = df[col].astype(str).str.strip()
    df = df.rename(columns={"yield": "yield_val"})
    df = df[["crop", "year", "season", "state", "area", "production",
              "fertilizer", "pesticide", "yield_val"]]
    df.to_sql("crop_yield", conn, if_exists="append", index=False)
    return len(df)


def load_state_soil(conn):
    path = os.path.join(DATA_DIR, "state_soil_data.csv")
    df = pd.read_csv(path, encoding="utf-8-sig")  # handles the BOM in the file
    df.columns = [c.strip().lower() for c in df.columns]
    df["state"] = df["state"].astype(str).str.strip()
    df.to_sql("state_soil", conn, if_exists="append", index=False)
    return len(df)


def load_state_weather(conn):
    path = os.path.join(DATA_DIR, "state_weather_data_1997_2020.csv")
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    df["state"] = df["state"].astype(str).str.strip()
    df.to_sql("state_weather", conn, if_exists="append", index=False)
    return len(df)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset-all", action="store_true",
                         help="Also wipe users & scan_history (full reset)")
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)

    if args.reset_all:
        conn.execute("DELETE FROM users")
        conn.execute("DELETE FROM scan_history")

    # Reference/data tables always get rebuilt fresh from the CSVs.
    conn.execute("DELETE FROM crop_yield")
    conn.execute("DELETE FROM state_soil")
    conn.execute("DELETE FROM state_weather")
    conn.commit()

    n1 = load_crop_yield(conn)
    n2 = load_state_soil(conn)
    n3 = load_state_weather(conn)
    conn.commit()
    conn.close()

    print(f"Database ready at {DB_PATH}")
    print(f"  crop_yield rows loaded:    {n1}")
    print(f"  state_soil rows loaded:    {n2}")
    print(f"  state_weather rows loaded: {n3}")


if __name__ == "__main__":
    sys.exit(main())
