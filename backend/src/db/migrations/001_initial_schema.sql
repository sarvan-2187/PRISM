-- ============================================================
-- Migration 001: PRISM Core Schema
-- Run via: npm run db:migrate
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUM Types
-- ============================================================

CREATE TYPE transaction_status AS ENUM (
  'PENDING',
  'APPROVED',
  'BLOCKED',
  'STEP_UP_REQUIRED',
  'EXPIRED',
  'SETTLED'
);

CREATE TYPE ledger_status AS ENUM (
  'SUCCESS',
  'FAILED',
  'REVERTED'
);

-- ============================================================
-- Users
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL UNIQUE,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- WebAuthn Credentials (device-bound)
-- ============================================================

CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT        PRIMARY KEY,              -- WebAuthn credential ID (base64url)
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BYTEA       NOT NULL,
  webauthn_id   TEXT        NOT NULL UNIQUE,          -- Internal ID from @simplewebauthn/server
  counter       BIGINT      NOT NULL DEFAULT 0,
  device_type   TEXT        NOT NULL,
  backed_up     BOOLEAN     NOT NULL DEFAULT FALSE,
  transports    TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON credentials(user_id);

-- ============================================================
-- Transactions (Intent-Locked)
-- ============================================================

CREATE TABLE IF NOT EXISTS transactions (
  id           UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID               NOT NULL REFERENCES users(id),
  recipient_id TEXT               NOT NULL,
  amount       NUMERIC(12, 2)     NOT NULL CHECK (amount > 0),
  currency     TEXT               NOT NULL DEFAULT 'USD',
  intent_hash  TEXT               NOT NULL UNIQUE, -- SHA-256 of (userId|recipientId|amount|currency|nonce|expiry)
  nonce        TEXT               NOT NULL UNIQUE, -- Single-use; also stored in Redis
  expires_at   TIMESTAMPTZ        NOT NULL,
  status       transaction_status NOT NULL DEFAULT 'PENDING',
  risk_score   FLOAT,
  created_at   TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status  ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_expires ON transactions(expires_at);

-- ============================================================
-- Ledger (ACID settlement records)
-- ============================================================

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID          NOT NULL UNIQUE REFERENCES transactions(id),
  amount         NUMERIC(12,2) NOT NULL,
  status         ledger_status NOT NULL,
  settled_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Audit Logs (immutable event store)
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        REFERENCES transactions(id),
  event_type     TEXT        NOT NULL,  -- e.g. INTENT_LOCKED, WEBAUTHN_VERIFIED, RISK_BLOCKED
  event_data     JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_transaction ON audit_logs(transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_type  ON audit_logs(event_type);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
