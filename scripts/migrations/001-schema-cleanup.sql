-- Migration 001 — Schema cleanup (ADDITIVE — safe to run while old code is live)
-- Run against: arsenal_report database on VPS Postgres
--   ssh -i ~/.ssh/vps_key daniel@107.172.92.103
--   cd ~/feedback && docker compose exec -T db psql -U feedback_admin -d arsenal_report < 001-schema-cleanup.sql
-- Then restart PostgREST so it picks up the new view/columns:
--   docker compose restart arsenal-api
--
-- What this does:
--   1. app_settings table with current_season (season rollover becomes data, not code)
--   2. players.amort_years — per-player amortization period (default 5)
--   3. players.transfer_date TEXT → DATE (all live values are already ISO)
--   4. formation_slots.player_ids — ID-based depth chart, backfilled from player_names
--   5. squad view — the public read model: active players + current-season salary
--      (from salary_history), computed weekly salary, contract years, year signed,
--      and this season's amortization charge
--   6. amortization_schedule view rewritten to use amort_years
--
-- Old columns (players.salary_pw_raw / salary_py_raw / contract_yrs,
-- formation_slots.player_names) are NOT touched here — they are dropped by
-- migration 002 after the new code is deployed.

BEGIN;

-- ============================================================
-- 1. APP SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS arsenal_report.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO arsenal_report.app_settings (key, value)
VALUES ('current_season', '25/26')
ON CONFLICT (key) DO NOTHING;

GRANT SELECT ON arsenal_report.app_settings TO anon;
GRANT ALL ON arsenal_report.app_settings TO arsenal_admin;

-- ============================================================
-- 2. AMORTIZATION PERIOD (initial contract length in years)
-- Default 5 matches the UEFA cap; override per player in the
-- admin when the initial deal was shorter (e.g. 2-year deals).
-- ============================================================
ALTER TABLE arsenal_report.players
  ADD COLUMN IF NOT EXISTS amort_years INTEGER NOT NULL DEFAULT 5
  CHECK (amort_years BETWEEN 1 AND 10);

-- ============================================================
-- 3. TRANSFER_DATE → DATE
-- Live values are all ISO 'YYYY-MM-DD' strings. PostgREST
-- serializes DATE identically, so old clients are unaffected.
-- ============================================================
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'arsenal_report' AND table_name = 'players'
      AND column_name = 'transfer_date' AND data_type = 'text'
  ) THEN
    ALTER TABLE arsenal_report.players
      ALTER COLUMN transfer_date TYPE DATE USING NULLIF(trim(transfer_date), '')::date;
  END IF;
END $$;

-- year_signed stays as a stored column, but is now only the source of truth
-- for Academy players (year they joined). For transfers the squad view
-- computes it from transfer_date (end-of-year convention).
COMMENT ON COLUMN arsenal_report.players.year_signed IS
  'Academy players: year joined (source data). Transfers: derived from transfer_date in the squad view; stored value is a legacy fallback.';

-- ============================================================
-- 4. FORMATION SLOTS BY PLAYER ID
-- ============================================================
ALTER TABLE arsenal_report.formation_slots
  ADD COLUMN IF NOT EXISTS player_ids INTEGER[] NOT NULL DEFAULT '{}';

-- Backfill: match each stored short name against the last space-separated
-- token of players.name ("Lewis-Skelly" → "Myles Lewis-Skelly").
UPDATE arsenal_report.formation_slots fs
SET player_ids = COALESCE((
  SELECT array_agg(p.id ORDER BY n.ord)
  FROM unnest(fs.player_names) WITH ORDINALITY AS n(name, ord)
  JOIN arsenal_report.players p
    ON lower((string_to_array(p.name, ' '))[array_length(string_to_array(p.name, ' '), 1)])
     = lower(trim(n.name))
), '{}')
WHERE cardinality(fs.player_names) > 0;

-- Abort if any name failed to resolve to a player id
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT id, pos, player_names, player_ids
    FROM arsenal_report.formation_slots
    WHERE cardinality(player_ids) <> cardinality(player_names)
  LOOP
    RAISE EXCEPTION 'formation_slots id=% (%): names % resolved to ids % — fix manually and re-run',
      bad.id, bad.pos, bad.player_names, bad.player_ids;
  END LOOP;
END $$;

-- ============================================================
-- 5. SQUAD VIEW — public read model
-- Deliberately references NONE of the legacy columns so
-- migration 002 can drop them without touching this view.
-- ============================================================
CREATE OR REPLACE VIEW arsenal_report.squad AS
WITH cfg AS (
  SELECT value                                        AS current_season,
         2000 + split_part(value, '/', 1)::int        AS season_start_year,
         2000 + split_part(value, '/', 2)::int        AS season_end_year
  FROM arsenal_report.app_settings
  WHERE key = 'current_season'
)
SELECT
  p.id,
  p.squad_num,
  p.name,
  p.pos,
  p.pos_group,
  p.dob,
  p.nationality,
  p.transfer_type,
  p.transfer_fee_raw,
  p.transfer_date,
  p.signed,
  p.expiration,
  p.fbref_id,
  p.fbref_url,
  p.img_url,
  p.amort_years,
  ys.year_signed,
  sh.salary_py_raw,
  ROUND(sh.salary_py_raw / 52.0)::int                 AS salary_pw_raw,
  CASE WHEN p.expiration IS NOT NULL
       THEN GREATEST(0, EXTRACT(YEAR FROM p.expiration)::int - cfg.season_start_year)
  END                                                 AS contract_yrs,
  CASE WHEN p.transfer_type = 'Transfer'
        AND p.transfer_fee_raw IS NOT NULL
        AND ys.year_signed IS NOT NULL
        AND (cfg.season_end_year - ys.year_signed + 1) BETWEEN 1 AND p.amort_years
       THEN ROUND(p.transfer_fee_raw * 1000000 / p.amort_years)::int
       ELSE 0
  END                                                 AS amort_raw,
  cfg.current_season
FROM arsenal_report.players p
CROSS JOIN cfg
CROSS JOIN LATERAL (
  -- year_signed, end-of-year convention: Jul-Dec signing → year+1
  SELECT COALESCE(
    CASE WHEN p.transfer_date IS NOT NULL THEN
      EXTRACT(YEAR FROM p.transfer_date)::int
      + CASE WHEN EXTRACT(MONTH FROM p.transfer_date) >= 7 THEN 1 ELSE 0 END
    END,
    p.year_signed
  ) AS year_signed
) ys
LEFT JOIN LATERAL (
  SELECT s.salary_py_raw
  FROM arsenal_report.salary_history s
  WHERE s.player_id = p.id AND s.season = cfg.current_season
) sh ON true
WHERE p.active = true;

GRANT SELECT ON arsenal_report.squad TO anon, arsenal_admin;

-- ============================================================
-- 6. AMORTIZATION SCHEDULE VIEW — now uses amort_years and the
-- same computed year_signed as the squad view
-- ============================================================
DROP VIEW IF EXISTS arsenal_report.amortization_schedule;
CREATE VIEW arsenal_report.amortization_schedule AS
SELECT
  p.id                                                AS player_id,
  p.name                                              AS player_name,
  p.transfer_fee_raw,
  ys.year_signed,
  p.amort_years,
  gs.season_offset,
  LPAD(((ys.year_signed + gs.season_offset - 1) % 100)::TEXT, 2, '0')
    || '/'
    || LPAD(((ys.year_signed + gs.season_offset) % 100)::TEXT, 2, '0')
                                                      AS season_label,
  CASE WHEN gs.season_offset <= p.amort_years
       THEN ROUND(p.transfer_fee_raw * 1000000 / p.amort_years)::INTEGER
       ELSE 0
  END                                                 AS amort_raw,
  CASE WHEN gs.season_offset <= p.amort_years
       THEN '€' || ROUND(p.transfer_fee_raw / p.amort_years, 1)::TEXT || 'm'
       ELSE '—'
  END                                                 AS amort_display
FROM arsenal_report.players p
CROSS JOIN LATERAL (
  SELECT COALESCE(
    CASE WHEN p.transfer_date IS NOT NULL THEN
      EXTRACT(YEAR FROM p.transfer_date)::int
      + CASE WHEN EXTRACT(MONTH FROM p.transfer_date) >= 7 THEN 1 ELSE 0 END
    END,
    p.year_signed
  ) AS year_signed
) ys
CROSS JOIN generate_series(1, 10) AS gs(season_offset)
WHERE p.transfer_type = 'Transfer'
  AND p.transfer_fee_raw IS NOT NULL
  AND ys.year_signed IS NOT NULL;

GRANT SELECT ON arsenal_report.amortization_schedule TO anon, arsenal_admin;

COMMIT;

-- Sanity checks (read-only, run after COMMIT):
--   SELECT name, salary_py_raw, salary_pw_raw, contract_yrs, year_signed, amort_raw FROM arsenal_report.squad ORDER BY salary_py_raw DESC NULLS LAST;
--   SELECT pos, player_names, player_ids FROM arsenal_report.formation_slots ORDER BY row_order, slot_order;
