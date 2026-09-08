-- Record how an intent was started so the review and step-up screens can
-- explain a QR-origin payment without trusting client-side navigation state.
-- This is descriptive provenance, not part of the money-moving intent.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK (origin IN ('MANUAL', 'QR'));
