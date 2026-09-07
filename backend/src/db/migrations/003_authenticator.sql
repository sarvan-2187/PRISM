-- PRISM Authenticator: paired second-device codes.
--
-- Turns a high-risk outcome from a refusal into an escalation. Today a score
-- of 85+ dead-ends a genuine user with 403 RISK_BLOCKED; with a paired device
-- the same score becomes "prove it on the other device instead".
--
-- See docs/superpowers/specs/2026-09-07-prism-authenticator-design.md

CREATE TABLE IF NOT EXISTS authenticator_devices (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- HMAC key. Shown once at pairing and never transmitted from the phone:
  -- the LAN demo runs over plain HTTP, so a secret POSTed back would be on
  -- the wire in cleartext. Same shape as an otpauth:// enrolment URI.
  secret       BYTEA       NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  -- Pairing window only. NULL once the device is ACTIVE.
  expires_at   TIMESTAMPTZ
);

-- One active device per user, enforced by the database rather than by
-- application code, so a race between two pairing attempts cannot leave an
-- account with two live devices. Re-pairing REVOKEs the previous row, which
-- is also the lost-phone story.
CREATE UNIQUE INDEX IF NOT EXISTS idx_authenticator_active_per_user
  ON authenticator_devices (user_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_authenticator_user
  ON authenticator_devices (user_id, status);

-- Which challenge a stepped-up transaction is waiting on. NULL until the risk
-- engine decides one is needed.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS step_up_mode TEXT
  CHECK (step_up_mode IN ('SEMANTIC', 'AUTHENTICATOR'));
