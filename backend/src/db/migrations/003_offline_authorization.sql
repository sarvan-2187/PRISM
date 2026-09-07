-- ============================================================
-- Migration 003: BLACKOUT (FC-01-A) — offline authorization
--
-- Future Card: the device goes fully offline mid-payment — no network, no
-- server reachable, no live check against anything. Authentication must
-- still complete locally and stay replay-proof when connectivity returns.
--
-- Two tables carry the design (see modules/offline/grant.ts and redeem.ts
-- for the full rationale):
--
--   offline_grants   The envelope PRISM hands the device before a blackout —
--                     a capped, payee-restricted set of single-use slots the
--                     device cannot widen, because every field is inside the
--                     grant's MAC.
--
--   offline_vouchers The replay defence. nonce is UNIQUE, so a captured
--                     voucher — the thing an attacker steals — can be
--                     redeemed exactly once. Enforced by the database, not
--                     a code path: "Skipping a control stops being a
--                     code-review miss and becomes a database constraint
--                     violation." (002's own words, and true again here.)
--
-- Additive only. 001 and 002 are never edited.
-- ============================================================

CREATE TABLE offline_grants (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id),
  -- The full signed grant body, exactly as issued — so a dispute over what
  -- was authorized can be settled by re-reading this row, not by trusting
  -- the device's copy.
  envelope   JSONB       NOT NULL,
  -- Denormalised copy of envelope.slots ([{txId, nonce}, ...]) for quick
  -- lookups without unpacking the envelope on every redemption.
  slots      JSONB       NOT NULL,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  not_after  TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_offline_grants_user ON offline_grants(user_id, issued_at DESC);

CREATE TABLE offline_vouchers (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id     UUID        NOT NULL REFERENCES offline_grants(id),
  -- The replay defence. A device holds a small number of pre-reserved
  -- nonces; each one may appear in this table exactly once, ever — the
  -- INSERT that violates this UNIQUE constraint IS the REPLAY_BLOCKED path.
  nonce        TEXT        NOT NULL UNIQUE,
  tx_id        UUID REFERENCES transactions(id),
  outcome      TEXT        NOT NULL DEFAULT 'PENDING',
  failure_code TEXT,
  redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT offline_voucher_outcome CHECK (outcome IN ('PENDING', 'SETTLED', 'FAILED'))
);

CREATE INDEX idx_offline_vouchers_grant ON offline_vouchers(grant_id);

-- So the timeline and the ledger view can tell an offline-approved payment
-- apart from an ordinary one without inferring it from other columns.
ALTER TABLE transactions
  ADD COLUMN authorized_offline BOOLEAN NOT NULL DEFAULT FALSE;
