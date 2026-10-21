import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  claimDueTransactions,
  markFailed,
  markProcessed,
  releaseLeases,
  scheduleRetry,
} from './repository.js';
import { raceWithSignal, retryDelayMs } from './utils.js';

const MAX_IDLE_BACKOFF_MS = 30_000;
const PERSIST_ATTEMPTS = 3;

function toTransaction(row) {
  return {
    transaction_id: row.transaction_id,
    source_account: row.source_account,
    destination_account: row.destination_account,
    amount: Number(row.amount),
    currency: row.currency,
    attempt: row.attempts,
  };
}

function describeError(err, timeoutMs) {
  if (err?.name === 'TimeoutError') return `Processing timed out after ${timeoutMs}ms`;
  return String(err?.message ?? err).slice(0, 1000);
}

/**
 * Background processor backed by the transactions table.
 *
 * The loop leases due rows (short UPDATE, connection released immediately),
 * then runs each one concurrently without holding a database connection or
 * transaction during the slow external call. Results are written back only
 * if the worker still holds the row's lease token.
 *
 * Failure handling:
 *  - processing error / timeout  -> retry with exponential backoff, then FAILED
 *  - process crash               -> lease expires, any instance re-claims it
 *  - graceful shutdown           -> in-flight jobs aborted, leases released
 *  - database error on save      -> retried; if still failing, lease expiry recovers it
 */
export class TransactionWorker {
  #pool;
  #config;
  #log;
  #process;
  #workerId;
  #running = false;
  #loopPromise = null;
  #inFlight = new Map(); // lease_token -> { controller, promise }
  #wake = null;
  #notified = false;
  #consecutiveErrors = 0;

  constructor({ pool, config, logger, processTransaction, workerId }) {
    this.#pool = pool;
    this.#config = config;
    this.#log = logger;
    this.#process = processTransaction;
    this.#workerId = workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  get workerId() {
    return this.#workerId;
  }

  get inFlightCount() {
    return this.#inFlight.size;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#loopPromise = this.#loop();
    this.#log.info({ workerId: this.#workerId, concurrency: this.#config.concurrency }, 'worker started');
  }

  /** Ask the loop to look for work now instead of waiting for the next poll. */
  notify() {
    this.#notified = true;
    this.#wake?.();
  }

  async stop() {
    if (!this.#loopPromise) return;
    this.#running = false;
    this.#wake?.();
    await this.#loopPromise;
    this.#loopPromise = null;

    const entries = [...this.#inFlight.values()];
    for (const entry of entries) entry.controller.abort(new Error('worker shutting down'));
    await Promise.allSettled(entries.map((entry) => entry.promise));
    this.#log.info({ interrupted: entries.length }, 'worker stopped');
  }

  async #loop() {
    while (this.#running) {
      this.#notified = false;
      const capacity = this.#config.concurrency - this.#inFlight.size;
      let delay = this.#config.pollIntervalMs;

      if (capacity > 0) {
        try {
          const jobs = await claimDueTransactions(this.#pool, {
            workerId: this.#workerId,
            limit: capacity,
            leaseMs: this.#config.leaseMs,
          });
          this.#consecutiveErrors = 0;
          for (const job of jobs) this.#startJob(job);
          // A full batch suggests more rows are waiting; look again straight away.
          if (jobs.length === capacity) delay = 0;
        } catch (err) {
          this.#consecutiveErrors++;
          const backoff = Math.min(this.#config.pollIntervalMs * 2 ** this.#consecutiveErrors, MAX_IDLE_BACKOFF_MS);
          this.#log.error({ err, retryInMs: backoff }, 'failed to claim transactions');
          await this.#idle(backoff, { interruptible: false });
          continue;
        }
      }

      if (delay > 0 && !this.#notified) await this.#idle(delay, { interruptible: true });
    }
  }

  #idle(ms, { interruptible }) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      // While backing off from a database error only stop() may cut the wait short.
      this.#wake = interruptible ? finish : () => !this.#running && finish();
    });
  }

  #startJob(job) {
    const entry = { controller: new AbortController(), promise: null };
    this.#inFlight.set(job.lease_token, entry);
    entry.promise = this.#runJob(job, entry.controller.signal)
      .catch((err) => this.#log.error({ err, transaction_id: job.transaction_id }, 'unexpected worker error'))
      .finally(() => {
        this.#inFlight.delete(job.lease_token);
        this.notify(); // a slot is free
      });
  }

  async #runJob(job, shutdownSignal) {
    const { maxAttempts, processingTimeoutMs, retryBaseMs, retryMaxMs } = this.#config;
    const log = this.#log.child({ transaction_id: job.transaction_id, attempt: job.attempts });
    const ids = { transactionId: job.transaction_id, leaseToken: job.lease_token };

    if (job.attempts > maxAttempts) {
      // Only reachable when earlier attempts died with their worker (lease expiry).
      const error = `Gave up after ${maxAttempts} attempts`;
      log.error({ error }, 'transaction failed permanently');
      await this.#persist(log, 'FAILED', () => markFailed(this.#pool, { ...ids, error }));
      return;
    }

    const startedAt = Date.now();
    try {
      log.info('processing transaction');
      const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(processingTimeoutMs)]);
      const work = Promise.resolve().then(() => this.#process(toTransaction(job), { signal }));
      await raceWithSignal(work, signal);
    } catch (err) {
      if (shutdownSignal.aborted) {
        await releaseLeases(this.#pool, [job.lease_token]).then(
          () => log.info('released transaction for another worker (shutdown)'),
          (releaseErr) => log.error({ err: releaseErr }, 'could not release lease; it will expire instead'),
        );
        return;
      }

      const error = describeError(err, processingTimeoutMs);
      if (job.attempts >= maxAttempts) {
        log.error({ error }, 'transaction failed permanently');
        await this.#persist(log, 'FAILED', () => markFailed(this.#pool, { ...ids, error }));
      } else {
        const delayMs = retryDelayMs(job.attempts, retryBaseMs, retryMaxMs);
        log.warn({ error, retryInMs: delayMs }, 'processing failed, will retry');
        await this.#persist(log, 'retry', () => scheduleRetry(this.#pool, { ...ids, error, delayMs }));
      }
      return;
    }

    const saved = await this.#persist(log, 'PROCESSED', () => markProcessed(this.#pool, ids));
    if (saved) log.info({ durationMs: Date.now() - startedAt }, 'transaction processed');
  }

  /** Write a job outcome, retrying transient database errors. */
  async #persist(log, outcome, write) {
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
      try {
        const applied = await write();
        if (!applied) log.warn({ outcome }, 'lease lost before the result was saved; another worker owns this transaction');
        return applied;
      } catch (err) {
        log.error({ err, outcome, attempt }, 'failed to save job outcome');
        if (attempt < PERSIST_ATTEMPTS) await sleep(250 * 2 ** attempt);
      }
    }
    // The row keeps its lease; once it expires the job is re-claimed and redone.
    return false;
  }
}
