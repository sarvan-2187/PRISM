-- ============================================================
-- Migration 002: Attack Simulation Dashboard
--
-- Persists real attack runs launched from the Attack Simulation Dashboard
-- against the real PRISM API (see backend/src/modules/attacks/). Every row
-- here is written at the moment a real HTTP call resolves or a real DB read
-- happens during a run — never backfilled or fabricated.
--
-- Migrations are append-only after 001 — see its header. Do not edit that
-- file; add 003_*.sql for further changes.
-- ============================================================

CREATE TABLE attack_runs (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id            TEXT        NOT NULL,
  attacker_label         TEXT        NOT NULL,
  target_user_id         UUID        REFERENCES users(id),
  target_transaction_id  UUID        REFERENCES transactions(id),
  status                 TEXT        NOT NULL DEFAULT 'RUNNING', -- RUNNING | COMPLETE | ERROR
  outcome                TEXT,        -- SIMULATED | DETECTED | BLOCKED | PARTIALLY_MITIGATED
                                       -- | SUCCEEDED | PROTECTION_UNAVAILABLE
  summary                TEXT,
  error_message          TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at            TIMESTAMPTZ
);

CREATE INDEX idx_attack_runs_started ON attack_runs(started_at DESC);

CREATE TABLE attack_run_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID        NOT NULL REFERENCES attack_runs(id) ON DELETE CASCADE,
  seq          INTEGER     NOT NULL,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor        TEXT        NOT NULL, -- ATTACKER | LEGITIMATE | PRISM | SYSTEM
  prism_layer  TEXT,                 -- IDENTITY | INTENT | CONTEXT | RISK | SEMANTIC
                                      -- | AUTHORIZATION | LEDGER | NETWORK | NONE
  message      TEXT        NOT NULL,
  detail       JSONB       NOT NULL DEFAULT '{}',
  UNIQUE (run_id, seq)
);

CREATE INDEX idx_attack_run_events_run ON attack_run_events(run_id, seq);
