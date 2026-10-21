import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import pino from 'pino';
import { createPool } from '../src/db.js';
import { createSimulatedProcessor } from '../src/processor.js';
import {
  claimDueTransactions,
  findTransaction,
  markProcessed,
  recordWebhook,
} from '../src/repository.js';
import { TransactionWorker } from '../src/worker.js';
import { startTestDatabase } from './helpers/database.js';

const silent = pino({ level: 'silent' });

let database;
let pool;
let counter = 0;
const workers = [];

function workerConfig(overrides = {}) {
  return {
    concurrency: 10,
    pollIntervalMs: 50,
    processingDelayMs: 0,
    processingTimeoutMs: 2000,
    leaseMs: 5000,
    maxAttempts: 3,
    retryBaseMs: 20,
    retryMaxMs: 100,
    ...overrides,
  };
}

function startWorker({ processTransaction, ...overrides } = {}) {
  const worker = new TransactionWorker({
    pool,
    config: workerConfig(overrides),
    logger: silent,
    processTransaction: processTransaction ?? createSimulatedProcessor({ delayMs: 0 }),
  });
  workers.push(worker);
  worker.start();
  return worker;
}

/** Processor that records every call so tests can assert "processed exactly once". */
function countingProcessor(impl = async () => {}) {
  const calls = new Map();
  const fn = async (txn, ctx) => {
    calls.set(txn.transaction_id, (calls.get(txn.transaction_id) ?? 0) + 1);
    return impl(txn, ctx);
  };
  fn.calls = calls;
  return fn;
}

async function insertTransaction(overrides = {}) {
  counter += 1;
  const txn = {
    transaction_id: `txn_worker_${Date.now()}_${counter}`,
    source_account: 'acc_a',
    destination_account: 'acc_b',
    amount: 100,
    currency: 'INR',
    ...overrides,
  };
  await recordWebhook(pool, txn, JSON.stringify(txn));
  return txn.transaction_id;
}

async function waitForStatus(id, status, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await findTransaction(pool, id);
    if (row?.status === status) return row;
    if (Date.now() > deadline) assert.fail(`${id} is ${row?.status}, expected ${status}`);
    await sleep(20);
  }
}

before(async () => {
  database = await startTestDatabase();
  pool = createPool({ connectionString: database.url, name: 'test-worker', max: 10, statementTimeoutMs: 5000 });
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  // Leave no runnable work behind for the next test.
  await pool.query(`UPDATE transactions SET status = 'FAILED' WHERE status = 'PROCESSING'`);
});

after(async () => {
  await pool?.end();
  await database?.stop();
});

describe('TransactionWorker', () => {
  it('processes a transaction after the configured delay and records the timing', async () => {
    const delayMs = 400;
    startWorker({ processTransaction: createSimulatedProcessor({ delayMs }) });
    const id = await insertTransaction();

    const processing = await findTransaction(pool, id);
    assert.equal(processing.status, 'PROCESSING');
    assert.equal(processing.processed_at, null);

    const row = await waitForStatus(id, 'PROCESSED');
    const elapsed = row.processed_at - row.created_at;
    assert.ok(elapsed >= delayMs, `processed after ${elapsed}ms`);
    assert.ok(elapsed < delayMs + 1500, `processed after ${elapsed}ms`);
    assert.equal(row.attempts, 1);
    assert.equal(row.lease_token, null);
  });

  it('starts promptly when notified instead of waiting for the next poll', async () => {
    const worker = startWorker({ pollIntervalMs: 10_000 });
    await sleep(50); // let the first (empty) poll finish so the loop is sleeping
    const id = await insertTransaction();
    worker.notify();
    await waitForStatus(id, 'PROCESSED', 1000);
  });

  it('never reprocesses a transaction that receives duplicate webhooks', async () => {
    const processor = countingProcessor(() => sleep(200));
    startWorker({ processTransaction: processor });
    const txn = { transaction_id: `txn_dupes_${Date.now()}`, source_account: 'a1', destination_account: 'b1', amount: 5, currency: 'INR' };
    await recordWebhook(pool, txn, '{}');
    for (let i = 0; i < 5; i++) await recordWebhook(pool, txn, '{}'); // while processing
    await waitForStatus(txn.transaction_id, 'PROCESSED');
    for (let i = 0; i < 5; i++) await recordWebhook(pool, txn, '{}'); // after processing
    await sleep(200);
    assert.equal(processor.calls.get(txn.transaction_id), 1);
    assert.equal((await findTransaction(pool, txn.transaction_id)).status, 'PROCESSED');
  });

  it('processes each transaction exactly once with several competing workers', async () => {
    const processor = countingProcessor(() => sleep(30));
    for (let i = 0; i < 4; i++) startWorker({ processTransaction: processor, concurrency: 5 });
    const ids = await Promise.all(Array.from({ length: 40 }, () => insertTransaction()));
    for (const id of ids) await waitForStatus(id, 'PROCESSED', 10_000);
    assert.equal(processor.calls.size, 40);
    assert.ok([...processor.calls.values()].every((n) => n === 1));
  });

  it('never runs more jobs at once than its concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    startWorker({
      concurrency: 3,
      processTransaction: async () => {
        peak = Math.max(peak, ++running);
        await sleep(100);
        running--;
      },
    });
    const ids = await Promise.all(Array.from({ length: 9 }, () => insertTransaction()));
    for (const id of ids) await waitForStatus(id, 'PROCESSED');
    assert.equal(peak, 3);
  });

  it('retries failed attempts with backoff and succeeds', async () => {
    let failuresLeft = 2;
    const processor = countingProcessor(async () => {
      if (failuresLeft-- > 0) throw new Error('external API returned 502');
    });
    startWorker({ processTransaction: processor });
    const id = await insertTransaction();
    const row = await waitForStatus(id, 'PROCESSED');
    assert.equal(row.attempts, 3);
    assert.equal(row.last_error, null);
    assert.equal(processor.calls.get(id), 3);
  });

  it('marks a transaction FAILED once attempts are exhausted, keeping the last error', async () => {
    const processor = countingProcessor(async () => {
      throw new Error('card network unavailable');
    });
    startWorker({ processTransaction: processor, maxAttempts: 3 });
    const id = await insertTransaction();
    const row = await waitForStatus(id, 'FAILED');
    assert.equal(row.attempts, 3);
    assert.equal(row.last_error, 'card network unavailable');
    assert.equal(row.processed_at, null);
    assert.equal(processor.calls.get(id), 3);
  });

  it('times out a hung external call even if it ignores the abort signal', async () => {
    startWorker({
      processingTimeoutMs: 100,
      maxAttempts: 1,
      processTransaction: () => new Promise(() => {}),
    });
    const id = await insertTransaction();
    const row = await waitForStatus(id, 'FAILED');
    assert.match(row.last_error, /timed out after 100ms/);
  });

  it('survives a processor that throws synchronously', async () => {
    startWorker({
      maxAttempts: 1,
      processTransaction: () => {
        throw new TypeError('boom');
      },
    });
    const id = await insertTransaction();
    assert.equal((await waitForStatus(id, 'FAILED')).last_error, 'boom');
  });

  it('recovers a job whose worker crashed once the lease expires', async () => {
    const id = await insertTransaction();
    // A worker claims the job and then dies without finishing it.
    const [claimed] = await claimDueTransactions(pool, { workerId: 'crashed-worker', limit: 1, leaseMs: 300 });
    assert.equal(claimed.transaction_id, id);

    const processor = countingProcessor();
    startWorker({ processTransaction: processor });
    await sleep(150);
    assert.equal(processor.calls.size, 0, 'must not steal a live lease');

    const row = await waitForStatus(id, 'PROCESSED');
    assert.equal(row.attempts, 2);
    assert.equal(processor.calls.get(id), 1);
  });

  it('gives up on a job that keeps crashing its workers (poison pill)', async () => {
    const id = await insertTransaction();
    await pool.query(`UPDATE transactions SET attempts = 3 WHERE transaction_id = $1`, [id]);
    const processor = countingProcessor();
    startWorker({ processTransaction: processor, maxAttempts: 3 });
    const row = await waitForStatus(id, 'FAILED');
    assert.match(row.last_error, /Gave up after 3 attempts/);
    assert.equal(processor.calls.size, 0);
  });

  it('fences off a worker that lost its lease, so a result is saved only once', async () => {
    const id = await insertTransaction();
    const [first] = await claimDueTransactions(pool, { workerId: 'slow', limit: 1, leaseMs: 1 });
    await sleep(10);
    const [second] = await claimDueTransactions(pool, { workerId: 'fast', limit: 1, leaseMs: 5000 });
    assert.equal(second.transaction_id, id);

    const ids = (claim) => ({ transactionId: id, leaseToken: claim.lease_token });
    assert.equal(await markProcessed(pool, ids(second)), true);
    assert.equal(await markProcessed(pool, ids(first)), false); // stale lease holder
    assert.equal(await markProcessed(pool, ids(second)), false); // already processed
  });

  it('hands in-flight jobs back on graceful shutdown so another worker resumes them', async () => {
    const first = startWorker({ processTransaction: createSimulatedProcessor({ delayMs: 60_000 }) });
    const id = await insertTransaction();
    for (let i = 0; i < 100 && first.inFlightCount === 0; i++) await sleep(10);
    assert.equal(first.inFlightCount, 1);

    const stopStarted = Date.now();
    await first.stop();
    assert.ok(Date.now() - stopStarted < 1000, 'stop() must not wait for the 60s job');

    const released = await findTransaction(pool, id);
    assert.equal(released.status, 'PROCESSING');
    assert.equal(released.lease_token, null);
    assert.equal(released.attempts, 0, 'an interrupted attempt is refunded');

    startWorker();
    await waitForStatus(id, 'PROCESSED');
  });

  it('keeps running through a database outage and stops promptly', async () => {
    const deadPool = createPool({ connectionString: 'postgres://x:y@127.0.0.1:1/none', name: 'dead', max: 1 });
    const worker = new TransactionWorker({
      pool: deadPool,
      config: workerConfig({ pollIntervalMs: 20 }),
      logger: silent,
      processTransaction: async () => {},
    });
    worker.start();
    await sleep(200);
    const started = Date.now();
    await worker.stop();
    assert.ok(Date.now() - started < 500);
    await deadPool.end();
  });
});
