-- Migration 003 — pending_updates review queue (ADDITIVE)
-- Holds squad changes detected by the daily Worker cron (squad sync vs
-- football-data.org). Nothing is applied to players automatically — the
-- admin approves or dismisses each item.
--   cd ~/feedback && docker compose exec -T db psql -U feedback_admin -d arsenal_report < 003-pending-updates.sql
--   docker compose restart arsenal-api

BEGIN;

CREATE TABLE IF NOT EXISTS arsenal_report.pending_updates (
  id          SERIAL PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'football-data.org',
  kind        TEXT NOT NULL CHECK (kind IN ('new_player', 'possible_departure', 'squad_num_change')),
  player_id   INTEGER REFERENCES arsenal_report.players(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,               -- player name as reported by the source
  old_value   TEXT,
  new_value   TEXT NOT NULL DEFAULT '',    -- '' for kinds without a value (part of the dedupe key)
  payload     JSONB,                       -- raw source data (position, dob, nationality, shirt number)
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  -- Dedupe: the same finding is never re-created, even after being dismissed.
  -- A genuinely new change (e.g. a different squad number) has a different
  -- new_value and creates a fresh row.
  UNIQUE (kind, subject, new_value)
);

-- Admin-only: the cron writes with ADMIN_JWT; anon gets nothing.
GRANT ALL ON arsenal_report.pending_updates TO arsenal_admin;
GRANT ALL ON SEQUENCE arsenal_report.pending_updates_id_seq TO arsenal_admin;

COMMIT;
