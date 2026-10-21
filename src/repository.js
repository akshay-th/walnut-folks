/**
 * All SQL lives here. Every function takes a `db` with a pg-compatible
 * `query()` so callers choose the pool (API vs worker).
 *
 * Correctness rests on three database guarantees:
 *  - PRIMARY KEY + ON CONFLICT: one row per transaction_id, even under races.
 *  - FOR UPDATE SKIP LOCKED: concurrent workers never claim the same row.
 *  - lease_token fencing: only the worker holding the current lease can move
 *    a row out of PROCESSING, so a transaction is marked PROCESSED once.
 * All timestamps use the database clock, so instances never disagree on time.
 */

const COLUMNS = `
  transaction_id, source_account, destination_account, amount, currency, status,
  attempts, next_attempt_at, last_error, lease_token, locked_by, locked_until,
  delivery_count, last_delivered_at, created_at, updated_at, processed_at`;

// Same list, qualified for the UPDATE ... FROM in claimDueTransactions.
const CLAIM_COLUMNS = COLUMNS.split(',').map((column) => `t.${column.trim()}`).join(', ');

/**
 * Insert a new transaction, or record an identical redelivery of an existing
 * one, in a single round trip. Returns:
 *   { inserted: true,  row }  first delivery, queued for processing
 *   { inserted: false, row }  identical redelivery, nothing queued
 *   { conflict: true }        transaction_id already used with different details
 */
export async function recordWebhook(db, txn, rawPayload) {
  const { rows } = await db.query(
    `INSERT INTO transactions
       (transaction_id, source_account, destination_account, amount, currency, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (transaction_id) DO UPDATE
       SET delivery_count = transactions.delivery_count + 1,
           last_delivered_at = now()
       WHERE transactions.source_account      = EXCLUDED.source_account
         AND transactions.destination_account = EXCLUDED.destination_account
         AND transactions.amount              = EXCLUDED.amount
         AND transactions.currency            = EXCLUDED.currency
     RETURNING ${COLUMNS}, (delivery_count = 1) AS inserted`,
    [
      txn.transaction_id,
      txn.source_account,
      txn.destination_account,
      String(txn.amount),
      txn.currency,
      rawPayload,
    ],
  );
  // ON CONFLICT ... WHERE false returns no row: the payload did not match.
  if (rows.length === 0) return { conflict: true };
  const { inserted, ...row } = rows[0];
  return { inserted, conflict: false, row };
}

export async function findTransaction(db, transactionId) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM transactions WHERE transaction_id = $1`, [
    transactionId,
  ]);
  return rows[0] ?? null;
}

/**
 * Lease up to `limit` due transactions. A row is due when it is still
 * PROCESSING, its retry time has come, and nobody holds a live lease on it
 * (an expired lease means its worker died, so the job is recovered).
 */
export async function claimDueTransactions(db, { workerId, limit, leaseMs }) {
  const { rows } = await db.query(
    `UPDATE transactions AS t
        SET lease_token  = gen_random_uuid(),
            locked_by    = $1,
            locked_until = now() + ($2::bigint * interval '1 millisecond'),
            attempts     = t.attempts + 1,
            updated_at   = now()
       FROM (
         SELECT transaction_id
           FROM transactions
          WHERE status = 'PROCESSING'
            AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until <= now())
          ORDER BY next_attempt_at, created_at
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       ) AS due
      WHERE t.transaction_id = due.transaction_id
  RETURNING ${CLAIM_COLUMNS}`,
    [workerId, leaseMs, limit],
  );
  return rows;
}

const RELEASE_LEASE = `lease_token = NULL, locked_by = NULL, locked_until = NULL, updated_at = now()`;

/** @returns {Promise<boolean>} false if the lease was lost to another worker. */
export async function markProcessed(db, { transactionId, leaseToken }) {
  const { rowCount } = await db.query(
    `UPDATE transactions
        SET status = 'PROCESSED', processed_at = now(), last_error = NULL, ${RELEASE_LEASE}
      WHERE transaction_id = $1 AND lease_token = $2 AND status = 'PROCESSING'`,
    [transactionId, leaseToken],
  );
  return rowCount === 1;
}

export async function scheduleRetry(db, { transactionId, leaseToken, error, delayMs }) {
  const { rowCount } = await db.query(
    `UPDATE transactions
        SET last_error = $3,
            next_attempt_at = now() + ($4::bigint * interval '1 millisecond'),
            ${RELEASE_LEASE}
      WHERE transaction_id = $1 AND lease_token = $2 AND status = 'PROCESSING'`,
    [transactionId, leaseToken, error, delayMs],
  );
  return rowCount === 1;
}

export async function markFailed(db, { transactionId, leaseToken, error }) {
  const { rowCount } = await db.query(
    `UPDATE transactions
        SET status = 'FAILED', last_error = $3, ${RELEASE_LEASE}
      WHERE transaction_id = $1 AND lease_token = $2 AND status = 'PROCESSING'`,
    [transactionId, leaseToken, error],
  );
  return rowCount === 1;
}

/**
 * Hand interrupted jobs back to the queue immediately (graceful shutdown) and
 * refund the attempt, since the interruption was not the job's fault.
 */
export async function releaseLeases(db, leaseTokens) {
  if (leaseTokens.length === 0) return 0;
  const { rowCount } = await db.query(
    `UPDATE transactions
        SET attempts = GREATEST(attempts - 1, 0), next_attempt_at = now(), ${RELEASE_LEASE}
      WHERE lease_token = ANY($1::uuid[]) AND status = 'PROCESSING'`,
    [leaseTokens],
  );
  return rowCount;
}
