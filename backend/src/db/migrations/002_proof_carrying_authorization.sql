-- ============================================================
-- Migration 002: Proof-carrying payment authorization
--
-- Today the authorization pipeline's correctness rests entirely on the
-- statement order inside one Express handler, and none of its decisions
-- survive in a tamper-evident form. The WebAuthn assertion in particular is
-- verified once, in memory, and then discarded -- so the system cannot prove,
-- after the fact, that the user ever signed anything.
--
-- This migration adds the durable, keyed, hash-chained record that settlement
-- is made to depend on. Skipping a control stops being a code-review miss and
-- becomes a database constraint violation.
--
-- Additive only. 001 is never edited. No existing row is modified.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL 12+ provided the
-- new value is not USED in the same transaction. Nothing below inserts a row
-- carrying these statuses, so the standard migrate.ts BEGIN/COMMIT is fine.
-- ============================================================

ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'SUPERSEDED';
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'DURESS_HELD';
-- 'AUTHORIZED' already exists in 001 and has never been written. It is revived
-- here as the durable "chain complete, money not yet moved" state, so a crash
-- between authorization and settlement is recoverable rather than invisible.

-- ============================================================
-- The authorization chain.
--
-- One row per completed security stage. Rows are append-only, hash-linked via
-- prev_hash, and MAC'd with a server key so a row cannot be forged by anyone
-- who has write access to the database but not the key.
--
-- The chain root (attempt 1, seq 0) is transactions.intent_hash, which binds
-- every decision to the exact locked intent. Attempt N's seq 0 links to the
-- tip of attempt N-1, so the whole history is one unbroken chain.
-- ============================================================

CREATE TYPE authorization_stage AS ENUM (
  'INTENT_LOCKED',
  'WEBAUTHN_APPROVED',
  'CONTEXT_VERIFIED',
  'POLICY_EVALUATED',
  'RISK_APPROVED',
  'SEMANTIC_VERIFIED',
  'SETTLEMENT_AUTHORIZED'
);

CREATE TABLE authorization_steps (
  id             UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID                NOT NULL REFERENCES transactions(id),
  attempt        INTEGER             NOT NULL CHECK (attempt >= 1),
  seq            INTEGER             NOT NULL CHECK (seq >= 0),
  stage          authorization_stage NOT NULL,
  -- The decision, its evidence, and a disabled_controls stamp. The stamp is
  -- what stops a control that was switched off from producing evidence
  -- indistinguishable from a control that ran and passed.
  payload        JSONB               NOT NULL,
  prev_hash      TEXT                NOT NULL,
  row_hash       TEXT                NOT NULL,
  mac            TEXT                NOT NULL,
  recorded_at    TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

  -- Ordering and no-duplicates, enforced by the database rather than by the
  -- handler that happens to be calling.
  UNIQUE (transaction_id, attempt, seq),
  UNIQUE (transaction_id, attempt, stage),
  -- A chain link is unique by construction; a collision means a replayed row.
  UNIQUE (row_hash)
);

CREATE INDEX idx_steps_tx ON authorization_steps(transaction_id, attempt, seq);

-- ============================================================
-- Settlement capability.
--
-- Minted only when every stage the policy marked mandatory is present in a
-- valid chain. settle() consumes it inside the same transaction as the ledger
-- write, so "was this payment actually authorized" is answered from durable
-- state at the moment the money moves, not by trusting the caller.
-- ============================================================

CREATE TABLE settlement_capabilities (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID        NOT NULL REFERENCES transactions(id),
  attempt         INTEGER     NOT NULL,
  intent_hash     TEXT        NOT NULL,
  chain_tip_hash  TEXT        NOT NULL,
  required_stages TEXT[]      NOT NULL,
  mode            TEXT        NOT NULL DEFAULT 'NORMAL',  -- NORMAL | DURESS
  mac             TEXT        NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  CONSTRAINT capability_mode CHECK (mode IN ('NORMAL', 'DURESS'))
);

CREATE INDEX idx_cap_tx ON settlement_capabilities(transaction_id, attempt);

-- ============================================================
-- Decision columns on transactions.
--
-- risk_reasons already exists but holds English prose, so editing a reason
-- string silently rewrites history. The machine-readable rule ids and the
-- decision itself lived only in an audit row; both are recorded here now.
-- ============================================================

ALTER TABLE transactions
  ADD COLUMN amended_from   UUID REFERENCES transactions(id),
  ADD COLUMN risk_decision  TEXT,
  ADD COLUMN fired_rule_ids TEXT[],
  ADD COLUMN policy_version INTEGER;

CREATE INDEX idx_transactions_amended_from ON transactions(amended_from);

-- ============================================================
-- Duress.
--
-- A second passkey the user enrols while safe. Signing with it is
-- indistinguishable to anyone watching the screen -- the WebAuthn prompt is
-- identical -- but the server routes the payment to quarantine and raises an
-- alert instead of paying the payee.
-- ============================================================

ALTER TABLE credentials
  ADD COLUMN is_duress BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE duress_alerts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        NOT NULL UNIQUE REFERENCES transactions(id),
  user_id        UUID        NOT NULL REFERENCES users(id),
  raised_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at    TIMESTAMPTZ,
  release_note   TEXT
);

CREATE INDEX idx_duress_alerts_open ON duress_alerts(raised_at DESC)
  WHERE released_at IS NULL;

-- ============================================================
-- Opening balances, so the ledger actually reconciles.
--
-- The seed inserts 20 settled transactions and 40 ledger entries but sets
-- balances to fixed constants, so SUM(ledger_entries) has never reconciled
-- against accounts.balance_minor. An account legitimately has money that
-- predates its transaction history; that float needs somewhere to live.
--
-- Invariant after this: balance_minor = opening_balance_minor
--                                     + SUM(CREDIT) - SUM(DEBIT).
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN opening_balance_minor BIGINT NOT NULL DEFAULT 0;

-- Backfill: whatever the ledger does not already account for is opening float.
UPDATE accounts a
   SET opening_balance_minor = a.balance_minor - COALESCE((
         SELECT SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor
                         ELSE -le.amount_minor END)
           FROM ledger_entries le
          WHERE le.account_id = a.id), 0);

-- ============================================================
-- Quarantine account: where duress-held funds sit until released.
-- Internal (not is_external) and owned by no user, so nobody can spend from it
-- through the ordinary payment path.
-- ============================================================

INSERT INTO accounts (user_id, display_name, handle, balance_minor, opening_balance_minor, is_external)
VALUES (NULL, 'PRISM Quarantine', 'quarantine@prism', 0, 0, FALSE)
ON CONFLICT (handle) DO NOTHING;
