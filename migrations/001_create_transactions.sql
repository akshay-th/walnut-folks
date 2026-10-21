-- The transactions table doubles as a durable job queue: a row is written
-- before the webhook is acknowledged, and workers lease rows to process them.
CREATE TABLE transactions (
  transaction_id      TEXT PRIMARY KEY,
  source_account      TEXT NOT NULL,
  destination_account TEXT NOT NULL,
  amount              NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
  currency            TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status              TEXT NOT NULL DEFAULT 'PROCESSING'
                      CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),

  -- Queue / retry bookkeeping
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error          TEXT,
  lease_token         UUID,          -- fencing token: only the current holder may finish the job
  locked_by           TEXT,          -- worker id, for observability
  locked_until        TIMESTAMPTZ,   -- lease expiry; expired leases are re-claimed (crash recovery)

  -- Webhook delivery bookkeeping
  delivery_count      INTEGER NOT NULL DEFAULT 1,
  last_delivered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload         JSON NOT NULL, -- JSON (not JSONB) keeps the body verbatim, incl. \u0000

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,

  CONSTRAINT processed_at_matches_status CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL))
);

-- Workers only ever scan rows that still need work.
CREATE INDEX transactions_due_idx ON transactions (next_attempt_at) WHERE status = 'PROCESSING';
