import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { connectionOptions, createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { startTestDatabase } from './helpers/database.js';

/**
 * Database-level behaviour that matters on Supabase: verifying a TLS
 * certificate signed by a private CA, session settings applied without
 * startup parameters, and the REST-API lock-down migration.
 */

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A private root CA plus a server certificate for "localhost" only, like Supabase's own CA. */
function makeCertificates() {
  const dir = mkdtempSync(join(tmpdir(), 'txn-tls-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2',
    '-subj', '/CN=Test Root CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n');
  run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.crt', '-days', '2', '-extfile', 'ext.cnf');
  chmodSync(join(dir, 'server.key'), 0o600); // Postgres refuses group/world-readable keys
  return { dir, ca: readFileSync(join(dir, 'ca.crt'), 'utf8') };
}

const tlsSupported = !process.env.TEST_DATABASE_URL && hasOpenssl();
let certs;
let database;

before(async () => {
  const postgresFlags = [];
  if (tlsSupported) {
    certs = makeCertificates();
    postgresFlags.push('-c', 'ssl=on', '-c', `ssl_cert_file=${join(certs.dir, 'server.crt')}`,
      '-c', `ssl_key_file=${join(certs.dir, 'server.key')}`);
  }
  database = await startTestDatabase({ postgresFlags });
});

after(async () => {
  await database?.stop();
  if (certs) rmSync(certs.dir, { recursive: true, force: true });
});

async function queryOnce(options, sql) {
  const client = new pg.Client(options);
  await client.connect();
  try {
    return (await client.query(sql)).rows[0];
  } finally {
    await client.end();
  }
}

describe('TLS with a private CA (DATABASE_CA_CERT)', { skip: !tlsSupported && 'needs openssl and the embedded test server' }, () => {
  const url = (host) => `postgres://postgres:postgres@${host}:${database.port}/test?sslmode=require`;
  const SSL_IN_USE = 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()';

  it('connects over verified TLS when the CA is supplied, even if the URL says sslmode=require', async () => {
    const options = connectionOptions({ databaseUrl: url('localhost'), databaseCaCert: certs.ca });
    assert.deepEqual(await queryOnce(options, SSL_IN_USE), { ssl: true });
  });

  it('refuses the connection without the CA (on Supabase: "self-signed certificate in certificate chain")', async () => {
    const options = connectionOptions({ databaseUrl: url('localhost') });
    await assert.rejects(queryOnce(options, 'SELECT 1'), /certificate/);
  });

  it('still checks the hostname, so a valid CA alone is not enough (verify-full)', async () => {
    const options = connectionOptions({ databaseUrl: url('127.0.0.1'), databaseCaCert: certs.ca });
    await assert.rejects(queryOnce(options, 'SELECT 1'), /altnames|does not match/i);
  });

  it('runs migrations over the verified connection', async () => {
    await migrate(connectionOptions({ databaseUrl: url('localhost'), databaseCaCert: certs.ca }));
  });
});

describe('connection pools', () => {
  it('apply timeouts and application_name with SET, not startup parameters', async () => {
    const pool = createPool({ connectionString: database.url, name: 'probe', max: 1, statementTimeoutMs: 1234 });
    try {
      const { rows } = await pool.query(
        `SELECT current_setting('statement_timeout') AS timeout,
                current_setting('idle_in_transaction_session_timeout') AS idle_tx,
                current_setting('application_name') AS app`,
      );
      assert.deepEqual(rows[0], { timeout: '1234ms', idle_tx: '10s', app: 'txn-webhooks:probe' });
      await assert.rejects(pool.query('SELECT pg_sleep(2)'), /statement timeout/);
    } finally {
      await pool.end();
    }
  });
});

describe('migrations', () => {
  it('are idempotent and safe when several instances boot at once', async () => {
    await Promise.all(Array.from({ length: 5 }, () => migrate(database.url)));
    const rows = await queryOnce({ connectionString: database.url }, 'SELECT count(*)::int AS n FROM schema_migrations');
    assert.equal(rows.n, 2);
  });

  it('hide every row from roles other than the owner (Supabase anon / authenticated)', async () => {
    const role = `rls_probe_${process.pid}_${Date.now()}`; // roles are cluster-wide
    const owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    try {
      await owner.query(`INSERT INTO transactions (transaction_id, source_account, destination_account, amount, currency, raw_payload)
                         VALUES ('txn_rls_probe', 'a', 'b', 1, 'INR', '{}')`);
      // Simulate Supabase's default grants to its API roles, which RLS must override.
      await owner.query(`CREATE ROLE ${role} NOLOGIN`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON transactions TO ${role}`);

      await owner.query('BEGIN');
      await owner.query(`SET LOCAL ROLE ${role}`);
      const visible = await owner.query('SELECT count(*)::int AS n FROM transactions');
      assert.equal(visible.rows[0].n, 0);
      const deleted = await owner.query('DELETE FROM transactions');
      assert.equal(deleted.rowCount, 0);
      await assert.rejects(
        owner.query(`INSERT INTO transactions (transaction_id, source_account, destination_account, amount, currency, raw_payload)
                     VALUES ('txn_rls_forged', 'a', 'b', 1, 'INR', '{}')`),
        /row-level security/,
      );
      await owner.query('ROLLBACK');

      const ownerView = await owner.query(`SELECT count(*)::int AS n FROM transactions WHERE transaction_id = 'txn_rls_probe'`);
      assert.equal(ownerView.rows[0].n, 1, 'the service itself is unaffected');
    } finally {
      await owner.query('ROLLBACK').catch(() => {});
      await owner.query(`REVOKE ALL ON transactions FROM ${role}`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await owner.end();
    }
  });
});
