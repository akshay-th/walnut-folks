import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pino from 'pino';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createSimulatedProcessor } from '../src/processor.js';
import { signPayload } from '../src/signature.js';
import { TransactionWorker } from '../src/worker.js';
import { startTestDatabase } from './helpers/database.js';

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const WEBHOOK = '/v1/webhooks/transactions';

let database;
let pool;
let counter = 0;

function payload(overrides = {}) {
  counter += 1;
  return {
    transaction_id: `txn_api_${Date.now()}_${counter}`,
    source_account: 'acc_user_789',
    destination_account: 'acc_merchant_456',
    amount: 1500,
    currency: 'INR',
    ...overrides,
  };
}

function makeConfig(env = {}) {
  return loadConfig({ DATABASE_URL: database.url, ...env });
}

function makeApp({ env, dbPool = pool, worker } = {}) {
  const notifier = worker ?? { notified: 0, notify() { this.notified++; } };
  const app = buildApp({ config: makeConfig(env), pool: dbPool, worker: notifier });
  return { app, notifier };
}

function post(app, body, headers = {}) {
  return app.inject({
    method: 'POST',
    url: WEBHOOK,
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}

async function rowCount(id) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE transaction_id = $1', [id]);
  return rows[0].n;
}

before(async () => {
  database = await startTestDatabase();
  pool = createPool({ connectionString: database.url, name: 'test-api', max: 20, statementTimeoutMs: 5000 });
});

after(async () => {
  await pool?.end();
  await database?.stop();
});

describe('GET / (health)', () => {
  it('reports HEALTHY with the current time', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'HEALTHY');
    assert.match(body.current_time, ISO_SECONDS);
    assert.ok(Math.abs(Date.parse(body.current_time) - Date.now()) < 5000);
  });

  it('reports UNHEALTHY with 503 when the database is unreachable', async () => {
    const deadPool = createPool({ connectionString: 'postgres://x:y@127.0.0.1:1/none', name: 'dead', max: 1 });
    const { app } = makeApp({ dbPool: deadPool });
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().status, 'UNHEALTHY');
    await deadPool.end();
  });
});

describe('POST /v1/webhooks/transactions', () => {
  let app;
  let notifier;
  beforeEach(() => {
    ({ app, notifier } = makeApp());
  });

  it('accepts a webhook with 202, stores it as PROCESSING and wakes the worker', async () => {
    const body = payload();
    const res = await post(app, body);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { message: 'Webhook accepted', transaction_id: body.transaction_id, duplicate: false });
    assert.equal(notifier.notified, 1);

    const get = await app.inject({ method: 'GET', url: `/v1/transactions/${body.transaction_id}` });
    assert.equal(get.statusCode, 200);
    const [txn] = get.json();
    assert.deepEqual(Object.keys(txn), [
      'transaction_id', 'source_account', 'destination_account', 'amount',
      'currency', 'status', 'created_at', 'processed_at',
    ]);
    assert.equal(txn.status, 'PROCESSING');
    assert.equal(txn.amount, 1500);
    assert.equal(txn.processed_at, null);
    assert.match(txn.created_at, ISO_SECONDS);
  });

  it('keeps decimal amounts exact', async () => {
    const body = payload({ amount: 150.5, currency: 'USD' });
    assert.equal((await post(app, body)).statusCode, 202);
    const [txn] = (await app.inject({ method: 'GET', url: `/v1/transactions/${body.transaction_id}` })).json();
    assert.equal(txn.amount, 150.5);
    assert.equal(txn.currency, 'USD');
  });

  it('treats repeated deliveries as duplicates: 202 every time, one row, worker woken once', async () => {
    const body = payload();
    const responses = [];
    for (let i = 0; i < 5; i++) responses.push(await post(app, body));
    assert.deepEqual(responses.map((r) => r.statusCode), [202, 202, 202, 202, 202]);
    assert.deepEqual(responses.map((r) => r.json().duplicate), [false, true, true, true, true]);
    assert.equal(await rowCount(body.transaction_id), 1);
    assert.equal(notifier.notified, 1);

    const [txn] = (await app.inject({ method: 'GET', url: `/v1/transactions/${body.transaction_id}?verbose=true` })).json();
    assert.equal(txn.delivery_count, 5);
  });

  it('handles a burst of concurrent identical deliveries without errors', async () => {
    const body = payload();
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(app, body)));
    assert.ok(responses.every((r) => r.statusCode === 202));
    assert.equal(responses.filter((r) => r.json().duplicate === false).length, 1);
    assert.equal(await rowCount(body.transaction_id), 1);
  });

  it('treats equivalent payloads (currency case, key order, extra fields) as the same delivery', async () => {
    const body = payload();
    await post(app, body);
    const reordered = {
      currency: 'inr',
      amount: 1500.0,
      destination_account: body.destination_account,
      source_account: body.source_account,
      transaction_id: body.transaction_id,
      event: 'payment.captured',
    };
    const res = await post(app, reordered);
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().duplicate, true);
  });

  it('rejects reuse of a transaction_id with different details (409) and keeps the original', async () => {
    const body = payload();
    await post(app, body);
    for (const change of [{ amount: 1501 }, { currency: 'USD' }, { destination_account: 'acc_other' }]) {
      const res = await post(app, { ...body, ...change });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'IDEMPOTENCY_CONFLICT');
    }
    const [txn] = (await app.inject({ method: 'GET', url: `/v1/transactions/${body.transaction_id}?verbose=1` })).json();
    assert.equal(txn.amount, 1500);
    assert.equal(txn.delivery_count, 1);
  });

  it('returns 422 with per-field details for invalid payloads and stores nothing', async () => {
    const body = payload({ amount: -5, currency: 'XYZ' });
    const res = await post(app, body);
    assert.equal(res.statusCode, 422);
    const { error } = res.json();
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.deepEqual(error.details.map((d) => d.field).sort(), ['amount', 'currency']);
    assert.equal(await rowCount(body.transaction_id), 0);
  });

  it('rejects malformed requests with clear status codes', async () => {
    const cases = [
      { name: 'invalid JSON', res: await post(app, '{"transaction_id": '), status: 400, code: 'INVALID_JSON' },
      { name: 'empty body', res: await post(app, ''), status: 400, code: 'EMPTY_BODY' },
      { name: 'whitespace body', res: await post(app, '   '), status: 400, code: 'EMPTY_BODY' },
      { name: 'JSON array', res: await post(app, [payload()]), status: 422, code: 'VALIDATION_ERROR' },
      { name: 'JSON null', res: await post(app, 'null'), status: 422, code: 'VALIDATION_ERROR' },
      {
        name: 'no body at all',
        res: await app.inject({ method: 'POST', url: WEBHOOK }),
        status: 400,
        code: 'EMPTY_BODY',
      },
      {
        name: 'wrong content type',
        res: await post(app, JSON.stringify(payload()), { 'content-type': 'text/plain' }),
        status: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
      },
      {
        name: 'oversized body',
        res: await post(app, payload({ padding: 'x'.repeat(70 * 1024) })),
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
      },
    ];
    for (const { name, res, status, code } of cases) {
      assert.equal(res.statusCode, status, name);
      assert.equal(res.json().error.code, code, name);
    }
  });

  it('accepts charset parameters, a UTF-8 BOM and characters that JSONB cannot store', async () => {
    const charset = payload();
    assert.equal((await post(app, charset, { 'content-type': 'application/json; charset=utf-8' })).statusCode, 202);

    const bom = payload();
    assert.equal((await post(app, `﻿${JSON.stringify(bom)}`)).statusCode, 202);

    const nul = payload({ note: 'a\u0000b', emoji: '💸' });
    assert.equal((await post(app, nul)).statusCode, 202);
    const { rows } = await pool.query('SELECT raw_payload::text AS raw FROM transactions WHERE transaction_id = $1', [
      nul.transaction_id,
    ]);
    assert.equal(JSON.parse(rows[0].raw).emoji, '💸');
  });

  it('accepts a trailing slash and echoes the request id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${WEBHOOK}/`,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-123' },
      payload: JSON.stringify(payload()),
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.headers['x-request-id'], 'req-123');
  });

  it('answers 405 with an Allow header for other methods', async () => {
    const res = await app.inject({ method: 'PUT', url: WEBHOOK });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
  });
});

describe('database trouble while receiving a webhook', () => {
  it('answers 503 + Retry-After within the deadline when no connection can be obtained', async () => {
    const hangingPool = { connect: () => new Promise(() => {}) };
    const { app } = makeApp({ dbPool: hangingPool, env: { WEBHOOK_DB_TIMEOUT_MS: '200' } });
    const started = performance.now();
    const res = await post(app, payload());
    const elapsed = performance.now() - started;
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '5');
    assert.equal(res.json().error.code, 'SERVICE_UNAVAILABLE');
    assert.ok(elapsed < 400, `took ${elapsed}ms`);
  });

  it('answers 503 within the deadline when a query hangs', async () => {
    let released = false;
    const client = { query: () => new Promise(() => {}), release: () => { released = true; } };
    const { app } = makeApp({ dbPool: { connect: async () => client }, env: { WEBHOOK_DB_TIMEOUT_MS: '200' } });
    const res = await post(app, payload());
    assert.equal(res.statusCode, 503);
    assert.equal(released, false, 'a connection with a statement in flight must not go back to the pool');
  });

  it('answers 503 when the database is down, and the retry succeeds once it is back', async () => {
    const deadPool = createPool({ connectionString: 'postgres://x:y@127.0.0.1:1/none', name: 'dead', max: 1 });
    const body = payload();
    const down = await post(makeApp({ dbPool: deadPool }).app, body);
    assert.equal(down.statusCode, 503);
    await deadPool.end();

    const retry = await post(makeApp().app, body);
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.json().duplicate, false);
  });

  it('a late write after a timeout turns the sender retry into a harmless duplicate', async () => {
    const body = payload();
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const slowPool = {
      connect: async () => {
        const client = await pool.connect();
        return { query: async (...args) => { await gate; return client.query(...args); }, release: (err) => client.release(err) };
      },
    };

    const timedOut = await post(makeApp({ dbPool: slowPool, env: { WEBHOOK_DB_TIMEOUT_MS: '100' } }).app, body);
    assert.equal(timedOut.statusCode, 503);
    open(); // the original insert now lands after we already answered 503
    await new Promise((resolve) => setTimeout(resolve, 100));

    const retry = await post(makeApp().app, body);
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.json().duplicate, true);
    assert.equal(await rowCount(body.transaction_id), 1);
  });

  it('drops work that timed out while waiting for a connection instead of running it late', async () => {
    const tinyPool = createPool({ connectionString: database.url, name: 'tiny', max: 1 });
    const busy = await tinyPool.connect(); // the only connection is taken
    const body = payload();
    const res = await post(makeApp({ dbPool: tinyPool, env: { WEBHOOK_DB_TIMEOUT_MS: '100' } }).app, body);
    assert.equal(res.statusCode, 503);

    busy.release(); // the connection frees up after the caller has already given up
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await rowCount(body.transaction_id), 0, 'stale work must not run');
    assert.equal(tinyPool.idleCount, 1, 'the connection went straight back to the pool');
    await tinyPool.end();
  });

  it('recovers right after a burst that overloads the pool (no backlog of stale work)', async () => {
    // Every statement costs a fixed 50ms, like a round trip to a distant database.
    const smallPool = createPool({ connectionString: database.url, name: 'small', max: 2 });
    const slowPool = {
      connect: async () => {
        const client = await smallPool.connect();
        return {
          query: async (...args) => { await new Promise((r) => setTimeout(r, 50)); return client.query(...args); },
          release: (err) => client.release(err),
        };
      },
    };
    const { app } = makeApp({ dbPool: slowPool, env: { WEBHOOK_DB_TIMEOUT_MS: '200' } });

    // 100 requests on 2 connections: only ~8 fit in the 200ms budget.
    const burst = await Promise.all(Array.from({ length: 100 }, () => post(app, payload())));
    assert.ok(burst.filter((r) => r.statusCode === 503).length > 50);
    assert.ok(burst.every((r) => r.statusCode === 202 || r.statusCode === 503));

    // Had the ~90 abandoned inserts stayed queued, this request would wait
    // behind ~2s of stale work and miss its deadline too.
    const after = await post(app, payload());
    assert.equal(after.statusCode, 202);
    await smallPool.end();
  });
});

describe('webhook signatures (WEBHOOK_SECRET set)', () => {
  const secret = 'whsec_test_secret';

  it('requires a valid HMAC-SHA256 signature of the raw body', async () => {
    const { app } = makeApp({ env: { WEBHOOK_SECRET: secret } });
    const raw = JSON.stringify(payload());

    assert.equal((await post(app, raw)).statusCode, 401);
    assert.equal((await post(app, raw, { 'x-webhook-signature': 'deadbeef' })).statusCode, 401);
    assert.equal((await post(app, raw, { 'x-webhook-signature': signPayload(`${raw} `, secret) })).statusCode, 401);
    assert.equal((await post(app, raw, { 'x-webhook-signature': signPayload(raw, secret) })).statusCode, 202);
  });

  it("also accepts Razorpay's X-Razorpay-Signature header", async () => {
    const { app } = makeApp({ env: { WEBHOOK_SECRET: secret } });
    const raw = JSON.stringify(payload());
    const res = await post(app, raw, { 'x-razorpay-signature': signPayload(raw, secret) });
    assert.equal(res.statusCode, 202);
  });
});

describe('GET /v1/transactions/:transaction_id', () => {
  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const { app } = makeApp();
    const missing = await app.inject({ method: 'GET', url: '/v1/transactions/txn_does_not_exist' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'TRANSACTION_NOT_FOUND');

    const malformed = await app.inject({ method: 'GET', url: `/v1/transactions/${encodeURIComponent('bad id!')}` });
    assert.equal(malformed.statusCode, 400);
    const tooLong = await app.inject({ method: 'GET', url: `/v1/transactions/${'x'.repeat(129)}` });
    assert.equal(tooLong.statusCode, 400);
  });

  it('includes processing metadata only when verbose=true', async () => {
    const { app } = makeApp();
    const body = payload();
    await post(app, body);
    const [plain] = (await app.inject({ method: 'GET', url: `/v1/transactions/${body.transaction_id}` })).json();
    assert.equal('attempts' in plain, false);
    const [verbose] = (await app.inject({ method: 'GET', url: `/v1/transactions/${body.transaction_id}?verbose=true` })).json();
    assert.equal(verbose.attempts, 0);
    assert.equal(verbose.delivery_count, 1);
    assert.equal(verbose.last_error, null);
  });
});

describe('performance under processing load', () => {
  it('keeps webhook latency far below 500ms while 100 jobs are being processed', async () => {
    const workerPool = createPool({ connectionString: database.url, name: 'test-load-worker', max: 5 });
    const worker = new TransactionWorker({
      pool: workerPool,
      config: { ...makeConfig().worker, concurrency: 100, pollIntervalMs: 50 },
      logger: pino({ level: 'silent' }),
      processTransaction: createSimulatedProcessor({ delayMs: 60_000 }),
    });
    const { app } = makeApp({ worker });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    worker.start();

    const send = async (body) => {
      const started = performance.now();
      const res = await fetch(`${base}${WEBHOOK}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await res.arrayBuffer();
      return { status: res.status, ms: performance.now() - started };
    };

    try {
      // Fill every worker slot with long-running jobs.
      await Promise.all(Array.from({ length: 100 }, () => send(payload())));
      const deadline = Date.now() + 5000;
      while (worker.inFlightCount < 100 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(worker.inFlightCount, 100);

      // Then measure 300 more webhooks (new + duplicates), 25 at a time.
      const bodies = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 && i > 0 ? null : payload()));
      const results = [];
      for (let i = 0; i < bodies.length; i += 25) {
        const batch = bodies.slice(i, i + 25).map((b, j) => b ?? bodies[i + j - 1] ?? payload());
        results.push(...(await Promise.all(batch.map(send))));
      }
      const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
      const p99 = latencies[Math.floor(latencies.length * 0.99)];
      assert.ok(results.every((r) => r.status === 202));
      assert.ok(p99 < 500, `p99 ${p99.toFixed(1)}ms`);
      assert.ok(latencies.at(-1) < 500, `max ${latencies.at(-1).toFixed(1)}ms`);
    } finally {
      await worker.stop();
      await app.close();
      await workerPool.end();
    }
  });
});
