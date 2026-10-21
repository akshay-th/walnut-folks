import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { connectionOptions } from '../src/db.js';
import { signPayload, verifySignature } from '../src/signature.js';
import {
  DeadlineExceededError,
  raceWithSignal,
  retryDelayMs,
  toIsoSeconds,
  withDeadline,
} from '../src/utils.js';
import { currencyMinorUnits, decimalPlaces, validateWebhookPayload } from '../src/validation.js';

const valid = {
  transaction_id: 'txn_abc123def456',
  source_account: 'acc_user_789',
  destination_account: 'acc_merchant_456',
  amount: 1500,
  currency: 'INR',
};

function fieldsWithErrors(body) {
  const result = validateWebhookPayload(body);
  assert.equal(result.ok, false, 'expected validation to fail');
  return result.errors.map((error) => error.field);
}

describe('validateWebhookPayload', () => {
  it('accepts the example payload from the spec', () => {
    assert.deepEqual(validateWebhookPayload(valid), { ok: true, value: valid });
  });

  it('accepts decimal amounts within the currency precision', () => {
    assert.equal(validateWebhookPayload({ ...valid, amount: 150.5, currency: 'USD' }).ok, true);
    assert.equal(validateWebhookPayload({ ...valid, amount: 0.01 }).ok, true);
    assert.equal(validateWebhookPayload({ ...valid, amount: 1.234, currency: 'KWD' }).ok, true);
  });

  it('normalises the currency code to upper case', () => {
    assert.equal(validateWebhookPayload({ ...valid, currency: 'inr' }).value.currency, 'INR');
  });

  it('ignores unknown fields', () => {
    const result = validateWebhookPayload({ ...valid, event: 'payment.captured', notes: { a: 1 } });
    assert.deepEqual(result.value, valid);
  });

  it('rejects bodies that are not JSON objects', () => {
    for (const body of [null, [], [valid], 'txn', 42, true]) {
      assert.deepEqual(fieldsWithErrors(body), ['body']);
    }
  });

  it('reports every missing field at once', () => {
    assert.deepEqual(fieldsWithErrors({}), [
      'transaction_id',
      'source_account',
      'destination_account',
      'currency',
      'amount',
    ]);
  });

  it('treats null like a missing field', () => {
    assert.deepEqual(fieldsWithErrors({ ...valid, transaction_id: null }), ['transaction_id']);
  });

  const invalidIds = ['', ' txn_1', 'txn_1 ', 'txn 1', '_txn', 'txn/1', 'txn?1', 'tx\u0000n', 'x'.repeat(129), 123, {}, []];
  for (const id of invalidIds) {
    it(`rejects transaction_id ${JSON.stringify(id)?.slice(0, 30)}`, () => {
      assert.deepEqual(fieldsWithErrors({ ...valid, transaction_id: id }), ['transaction_id']);
    });
  }

  it('accepts ids up to 128 characters', () => {
    assert.equal(validateWebhookPayload({ ...valid, transaction_id: 't'.repeat(128) }).ok, true);
  });

  const invalidAmounts = [0, -1, -0.01, '1500', '150.50', NaN, Infinity, 1e13, 1.001, 0.1 + 0.2, true, {}];
  for (const amount of invalidAmounts) {
    it(`rejects amount ${String(amount)} (${typeof amount})`, () => {
      assert.deepEqual(fieldsWithErrors({ ...valid, amount }), ['amount']);
    });
  }

  it('rejects fractional amounts for zero-decimal currencies', () => {
    assert.deepEqual(fieldsWithErrors({ ...valid, amount: 10.5, currency: 'JPY' }), ['amount']);
    assert.equal(validateWebhookPayload({ ...valid, amount: 10, currency: 'JPY' }).ok, true);
  });

  for (const currency of ['', 'IN', 'INRR', 'XYZ', 'I1R', 123, null]) {
    it(`rejects currency ${JSON.stringify(currency)}`, () => {
      assert.ok(fieldsWithErrors({ ...valid, currency }).includes('currency'));
    });
  }

  it('rejects a transfer to the same account', () => {
    assert.deepEqual(fieldsWithErrors({ ...valid, destination_account: valid.source_account }), [
      'destination_account',
    ]);
  });
});

describe('number helpers', () => {
  it('counts decimal places, including exponent notation', () => {
    assert.equal(decimalPlaces(1500), 0);
    assert.equal(decimalPlaces(150.5), 1);
    assert.equal(decimalPlaces(150.55), 2);
    assert.equal(decimalPlaces(1e-7), 7);
    assert.equal(decimalPlaces(1.5e-7), 8);
    assert.equal(decimalPlaces(1e21), 0);
  });

  it('knows ISO 4217 minor units', () => {
    assert.equal(currencyMinorUnits('INR'), 2);
    assert.equal(currencyMinorUnits('USD'), 2);
    assert.equal(currencyMinorUnits('JPY'), 0);
    assert.equal(currencyMinorUnits('KWD'), 3);
  });
});

describe('signatures', () => {
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify(valid));

  it('accepts a correct signature, with or without the sha256= prefix and in any case', () => {
    const signature = signPayload(body, secret);
    assert.equal(verifySignature(body, signature, secret), true);
    assert.equal(verifySignature(body, `sha256=${signature}`, secret), true);
    assert.equal(verifySignature(body, signature.toUpperCase(), secret), true);
  });

  it('rejects missing, malformed or wrong signatures', () => {
    const signature = signPayload(body, secret);
    assert.equal(verifySignature(body, undefined, secret), false);
    assert.equal(verifySignature(body, '', secret), false);
    assert.equal(verifySignature(body, 'abc', secret), false);
    assert.equal(verifySignature(body, signPayload(body, 'other'), secret), false);
    assert.equal(verifySignature(Buffer.from(`${body} `), signature, secret), false);
  });
});

describe('utils', () => {
  it('formats timestamps as ISO-8601 seconds in UTC', () => {
    assert.equal(toIsoSeconds(new Date('2024-01-15T10:30:00.987Z')), '2024-01-15T10:30:00Z');
    assert.equal(toIsoSeconds(null), null);
  });

  it('withDeadline resolves fast operations and rejects slow ones', async () => {
    assert.equal(await withDeadline(Promise.resolve(1), 50), 1);
    await assert.rejects(withDeadline(new Promise(() => {}), 20), DeadlineExceededError);
  });

  it('raceWithSignal rejects when the signal aborts even if the work ignores it', async () => {
    await assert.rejects(raceWithSignal(new Promise(() => {}), AbortSignal.timeout(10)), {
      name: 'TimeoutError',
    });
  });

  it('retry delays grow exponentially and are capped', () => {
    const fixed = () => 1; // upper bound of the jitter
    assert.equal(retryDelayMs(1, 1000, 60_000, fixed), 1000);
    assert.equal(retryDelayMs(2, 1000, 60_000, fixed), 2000);
    assert.equal(retryDelayMs(3, 1000, 60_000, fixed), 4000);
    assert.equal(retryDelayMs(20, 1000, 60_000, fixed), 60_000);
    assert.equal(retryDelayMs(3, 1000, 60_000, () => 0), 2000); // lower bound is half
  });
});

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgres://localhost/db' };

  it('applies defaults matching the spec', () => {
    const config = loadConfig(base);
    assert.equal(config.worker.processingDelayMs, 30_000);
    assert.equal(config.webhookDbTimeoutMs, 450);
    assert.equal(config.webhookSecret, null);
  });

  it('fails fast on missing or invalid settings', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, WORKER_CONCURRENCY: '0' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, WORKER_ENABLED: 'maybe' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SIMULATED_FAILURE_RATE: '2' }), ConfigError);
    assert.throws(() => loadConfig({ DATABASE_URL: 'not a url' }), /DATABASE_URL/);
    assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db' }), /DATABASE_URL/);
  });

  it('refuses a lease shorter than the processing timeout', () => {
    assert.throws(() => loadConfig({ ...base, LEASE_MS: '1000', PROCESSING_TIMEOUT_MS: '5000' }), /LEASE_MS/);
  });

  const pem = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

  it('reads DATABASE_CA_CERT as inline PEM, with or without escaped newlines', () => {
    assert.equal(loadConfig({ ...base, DATABASE_CA_CERT: pem }).databaseCaCert, pem);
    const oneLine = pem.replace(/\n/g, '\\n');
    assert.equal(loadConfig({ ...base, DATABASE_CA_CERT: oneLine }).databaseCaCert, pem);
  });

  it('reads DATABASE_CA_CERT from a file path', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ca-')), 'ca.crt');
    writeFileSync(file, pem);
    assert.equal(loadConfig({ ...base, DATABASE_CA_CERT: file }).databaseCaCert, pem);
  });

  it('rejects an unreadable or non-PEM DATABASE_CA_CERT', () => {
    assert.throws(() => loadConfig({ ...base, DATABASE_CA_CERT: '/nonexistent/ca.crt' }), /cannot read file/);
    const file = join(mkdtempSync(join(tmpdir(), 'ca-')), 'ca.crt');
    writeFileSync(file, 'not a certificate');
    assert.throws(() => loadConfig({ ...base, DATABASE_CA_CERT: file }), /PEM/);
  });
});

describe('connectionOptions', () => {
  const url = 'postgresql://postgres.abcd:p%40ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';

  it('passes the URL through untouched when no CA is configured', () => {
    assert.deepEqual(connectionOptions({ databaseUrl: `${url}?sslmode=require` }), {
      connectionString: `${url}?sslmode=require`,
    });
  });

  it('replaces URL SSL settings with CA verification when a CA is configured', () => {
    const options = connectionOptions({ databaseUrl: `${url}?sslmode=require&uselibpqcompat=true`, databaseCaCert: 'PEM' });
    assert.equal(options.connectionString, url); // password encoding preserved, ssl params removed
    assert.deepEqual(options.ssl, { ca: 'PEM', rejectUnauthorized: true });
  });
});
