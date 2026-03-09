-- Arsenal Report Database Schema
-- Run against: arsenal_report database on VPS Postgres
-- Owner/superuser: feedback_admin
-- Roles anon + authenticator already exist cluster-wide — do NOT recreate them
-- Safe to re-run (idempotent)

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
-- PLAYERS TABLE
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
  transfer_date    TEXT,                -- "Jun 2023" (month/year only)
  signed           DATE,                -- contract start date
  expiration       DATE,                -- contract end date
  year_signed      INTEGER,             -- end-of-year convention (e.g. 2023 for Jun 2023 signing)
  fbref_id         TEXT,
  fbref_url        TEXT,
  salary_pw_raw    INTEGER,             -- current weekly salary in EUR (raw)
  salary_py_raw    INTEGER,             -- current annual salary in EUR (raw, 25/26 season)
  contract_yrs     INTEGER,             -- years remaining on contract
  img_url          TEXT,                -- cdn.devlab502.net/arsenal-report/...
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SALARY HISTORY TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS arsenal_report.salary_history (
  id            SERIAL PRIMARY KEY,
  player_id     INTEGER NOT NULL REFERENCES arsenal_report.players(id) ON DELETE CASCADE,
  season        TEXT NOT NULL,          -- "21/22", "22/23", "23/24", "24/25", "25/26" etc.
  salary_py_raw INTEGER NOT NULL,       -- annual salary in EUR for that season
  UNIQUE (player_id, season)
);

-- ============================================================
-- FORMATION SLOTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS arsenal_report.formation_slots (
  id           SERIAL PRIMARY KEY,
  row_name     TEXT NOT NULL,           -- "Attack", "Midfield", "Defence", "Goalkeeper"
  row_order    INTEGER NOT NULL,        -- display order of rows (1=Attack, 4=GK)
  pos          TEXT NOT NULL,           -- "LW", "CF", "RW", "LCM", "GK", etc.
  slot_order   INTEGER NOT NULL,        -- order within row (left to right)
  player_names TEXT[] NOT NULL DEFAULT '{}',  -- ordered: [starter, backup1, backup2]
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AMORTIZATION SCHEDULE VIEW
-- Generates 10-year amort schedule for transfer players.
-- year_signed uses end-of-year convention (2023 = signed in 22/23 season).
-- Seasons 1-5: fee / 5 per year. Seasons 6-10: 0.
-- ============================================================
CREATE OR REPLACE VIEW arsenal_report.amortization_schedule AS
SELECT
  p.id                                          AS player_id,
  p.name                                        AS player_name,
  p.transfer_fee_raw,
  p.year_signed,
  gs.season_offset,
  LPAD(((p.year_signed + gs.season_offset - 1) % 100)::TEXT, 2, '0')
    || '/'
    || LPAD(((p.year_signed + gs.season_offset) % 100)::TEXT, 2, '0')
                                                AS season_label,
  CASE
    WHEN gs.season_offset <= 5
      THEN ROUND((p.transfer_fee_raw * 1000000 / 5))::INTEGER
    ELSE 0
  END                                           AS amort_raw,
  CASE
    WHEN gs.season_offset <= 5
      THEN '€' || ROUND(p.transfer_fee_raw / 5, 1)::TEXT || 'm'
    ELSE '—'
  END                                           AS amort_display
FROM arsenal_report.players p
CROSS JOIN generate_series(1, 10) AS gs(season_offset)
WHERE p.transfer_type = 'Transfer'
  AND p.transfer_fee_raw IS NOT NULL
  AND p.year_signed IS NOT NULL;

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

-- ============================================================
-- GRANTS — arsenal_admin (full access)
-- ============================================================
GRANT ALL ON ALL TABLES IN SCHEMA arsenal_report TO arsenal_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA arsenal_report TO arsenal_admin;
GRANT SELECT ON arsenal_report.amortization_schedule TO arsenal_admin;

-- ============================================================
-- GRANTS — anon (read-only; active filter enforced by app)
-- ============================================================
GRANT SELECT ON arsenal_report.players TO anon;
GRANT SELECT ON arsenal_report.salary_history TO anon;
GRANT SELECT ON arsenal_report.formation_slots TO anon;
GRANT SELECT ON arsenal_report.amortization_schedule TO anon;

-- Future tables also get these grants
ALTER DEFAULT PRIVILEGES IN SCHEMA arsenal_report
  GRANT ALL ON TABLES TO arsenal_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA arsenal_report
  GRANT ALL ON SEQUENCES TO arsenal_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA arsenal_report
  GRANT SELECT ON TABLES TO anon;
