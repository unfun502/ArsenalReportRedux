-- Migration 004 — loaned-out players (ADDITIVE)
-- Players loaned out stay active (owned, contracts and amortization still on
-- the books) but are flagged on_loan and shown distinctly in the app.
--   cd ~/feedback && docker compose exec -T db psql -U feedback_admin -d arsenal_report < 004-loaned-players.sql
--   docker compose restart arsenal-api

BEGIN;

ALTER TABLE arsenal_report.players
  ADD COLUMN IF NOT EXISTS on_loan BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE arsenal_report.players
  ADD COLUMN IF NOT EXISTS loan_club TEXT;

-- Recreate the squad view with the loan columns appended
-- (CREATE OR REPLACE requires existing column order to be preserved)
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
  cfg.current_season,
  p.on_loan,
  p.loan_club
FROM arsenal_report.players p
CROSS JOIN cfg
CROSS JOIN LATERAL (
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

COMMIT;
