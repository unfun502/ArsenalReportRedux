-- Arsenal Report Database Schema (fresh install)
-- Run against: arsenal_report database on VPS Postgres
-- Owner/superuser: feedback_admin
-- Roles anon + authenticator already exist cluster-wide — do NOT recreate them
-- Safe to re-run (idempotent)
--
-- Existing installs: do not run this — use scripts/migrations/ instead.

-- ============================================================
-- PRE-REQUISITES (run as feedback_admin before this script)
-- ============================================================
-- CREATE DATABASE arsenal_report OWNER feedback_admin;
-- \c arsenal_report

-- ============================================================
-- ROLES (cluster-wide — create if not already present)
-- ============================================================
DO $$ BEGIN
  CREATE ROLE arsenal_admin NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Allow PostgREST (via authenticator) to switch to arsenal_admin role
GRANT arsenal_admin TO authenticator;

-- ============================================================
-- SCHEMA
-- ============================================================
CREATE SCHEMA IF NOT EXISTS arsenal_report AUTHORIZATION feedback_admin;
GRANT USAGE ON SCHEMA arsenal_report TO anon, arsenal_admin;

-- ============================================================
-- APP SETTINGS
-- current_season drives the squad view (salary lookup, contract
-- years, amortization). Season rollover = insert new salary_history
-- rows, then update this one value.
-- ============================================================
CREATE TABLE IF NOT EXISTS arsenal_report.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO arsenal_report.app_settings (key, value)
VALUES ('current_season', '25/26')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- PLAYERS TABLE
-- Current salary is NOT stored here — it lives in salary_history
-- at the current season. Weekly salary, contract years remaining,
-- and amortization are computed in the squad view.
-- ============================================================
CREATE TABLE IF NOT EXISTS arsenal_report.players (
  id               SERIAL PRIMARY KEY,
  squad_num        INTEGER,
  name             TEXT NOT NULL,
  pos              TEXT NOT NULL,       -- "CF / CAM" (display format)
  pos_group        TEXT NOT NULL,       -- "Forward", "Midfielder", "Defender", "Goalkeeper"
  dob              DATE,
  nationality      TEXT NOT NULL,
  transfer_type    TEXT NOT NULL DEFAULT 'Transfer'
                   CHECK (transfer_type IN ('Transfer', 'Academy', 'Loan', 'Free')),
  transfer_fee_raw NUMERIC,             -- fee in millions (NULL if not a Transfer)
  transfer_date    DATE,                -- transfer completion date
  signed           DATE,                -- current contract start date
  expiration       DATE,                -- current contract end date
  year_signed      INTEGER,             -- Academy players: year joined. Transfers: derived
                                        -- from transfer_date in the squad view (end-of-year
                                        -- convention: Jul-Dec → year+1)
  amort_years      INTEGER NOT NULL DEFAULT 5
                   CHECK (amort_years BETWEEN 1 AND 10),
                                        -- initial contract length used for straight-line
                                        -- amortization (5 = UEFA cap / default assumption)
  fbref_id         TEXT,
  fbref_url        TEXT,
  img_url          TEXT,                -- cdn.devlab502.net/arsenal-report/...
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SALARY HISTORY TABLE — one row per player per season.
-- The current season's row IS the player's current salary.
-- ============================================================
CREATE TABLE IF NOT EXISTS arsenal_report.salary_history (
  id            SERIAL PRIMARY KEY,
  player_id     INTEGER NOT NULL REFERENCES arsenal_report.players(id) ON DELETE CASCADE,
  season        TEXT NOT NULL,          -- "21/22", "22/23", ... matches app_settings.current_season format
  salary_py_raw INTEGER NOT NULL,       -- annual salary in EUR for that season
  UNIQUE (player_id, season)
);

-- ============================================================
-- FORMATION SLOTS TABLE — depth chart references players by id
-- ============================================================
CREATE TABLE IF NOT EXISTS arsenal_report.formation_slots (
  id           SERIAL PRIMARY KEY,
  row_name     TEXT NOT NULL,           -- "Attack", "Midfield", "Defence", "Goalkeeper"
  row_order    INTEGER NOT NULL,        -- display order of rows (1=Attack, 4=GK)
  pos          TEXT NOT NULL,           -- "LW", "CF", "RW", "LCM", "GK", etc.
  slot_order   INTEGER NOT NULL,        -- order within row (left to right)
  player_ids   INTEGER[] NOT NULL DEFAULT '{}',  -- ordered: [starter, backup1, backup2]
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SQUAD VIEW — the public read model.
-- Active players joined with their current-season salary, plus
-- computed weekly salary, contract years, year signed, and this
-- season's straight-line amortization charge.
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

-- ============================================================
-- AMORTIZATION SCHEDULE VIEW
-- 10-season straight-line schedule per transfer player:
-- fee / amort_years for seasons 1..amort_years, then 0.
-- ============================================================
CREATE OR REPLACE VIEW arsenal_report.amortization_schedule AS
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

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION arsenal_report.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS players_updated_at ON arsenal_report.players;
CREATE TRIGGER players_updated_at
  BEFORE UPDATE ON arsenal_report.players
  FOR EACH ROW EXECUTE FUNCTION arsenal_report.set_updated_at();

DROP TRIGGER IF EXISTS formation_slots_updated_at ON arsenal_report.formation_slots;
CREATE TRIGGER formation_slots_updated_at
  BEFORE UPDATE ON arsenal_report.formation_slots
  FOR EACH ROW EXECUTE FUNCTION arsenal_report.set_updated_at();

DROP TRIGGER IF EXISTS app_settings_updated_at ON arsenal_report.app_settings;
CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON arsenal_report.app_settings
  FOR EACH ROW EXECUTE FUNCTION arsenal_report.set_updated_at();

-- ============================================================
-- GRANTS — arsenal_admin (full access)
-- ============================================================
GRANT ALL ON ALL TABLES IN SCHEMA arsenal_report TO arsenal_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA arsenal_report TO arsenal_admin;

-- ============================================================
-- GRANTS — anon (public read model only)
-- The players base table and salary_history are NOT readable by
-- anon: the public app reads the squad view (active players,
-- current season only), formation_slots, and app_settings.
-- ============================================================
GRANT SELECT ON arsenal_report.squad TO anon;
GRANT SELECT ON arsenal_report.formation_slots TO anon;
GRANT SELECT ON arsenal_report.app_settings TO anon;
GRANT SELECT ON arsenal_report.amortization_schedule TO anon;

-- Future tables get admin access automatically; anon grants stay explicit
ALTER DEFAULT PRIVILEGES IN SCHEMA arsenal_report
  GRANT ALL ON TABLES TO arsenal_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA arsenal_report
  GRANT ALL ON SEQUENCES TO arsenal_admin;
