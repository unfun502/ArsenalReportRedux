-- Migration 002 — Drop legacy columns (run ONLY after the new code is deployed)
-- Prerequisite: migration 001 applied, Worker + admin pages deployed and verified.
--   cd ~/feedback && docker compose exec -T db psql -U feedback_admin -d arsenal_report < 002-drop-legacy-columns.sql
--   docker compose restart arsenal-api
--
-- What this does:
--   1. Drops players.salary_pw_raw / salary_py_raw / contract_yrs
--      (current salary now lives in salary_history at app_settings.current_season;
--       weekly salary and contract years are computed in the squad view)
--   2. Drops formation_slots.player_names (replaced by player_ids)
--   3. Revokes anon read on the players base table and salary_history —
--      the public app reads only the squad view (active players, current season)
--      and formation_slots. Admin access is unaffected (arsenal_admin role).

BEGIN;

ALTER TABLE arsenal_report.players
  DROP COLUMN IF EXISTS salary_pw_raw,
  DROP COLUMN IF EXISTS salary_py_raw,
  DROP COLUMN IF EXISTS contract_yrs;

ALTER TABLE arsenal_report.formation_slots
  DROP COLUMN IF EXISTS player_names;

REVOKE SELECT ON arsenal_report.players FROM anon;
REVOKE SELECT ON arsenal_report.salary_history FROM anon;

-- Stop auto-granting anon read on future tables; anon grants are explicit now
ALTER DEFAULT PRIVILEGES IN SCHEMA arsenal_report
  REVOKE SELECT ON TABLES FROM anon;

COMMIT;

-- Sanity checks:
--   SELECT * FROM arsenal_report.squad LIMIT 3;                       -- view still works
--   SET ROLE anon; SELECT count(*) FROM arsenal_report.players;       -- should fail (permission denied)
--   RESET ROLE;
