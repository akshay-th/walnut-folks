import pg from 'pg';
import { withDeadline } from './utils.js';

// pg lets SSL settings in the URL override an explicit `ssl` option, so they
// are removed whenever we supply our own CA.
const URL_SSL_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

/**
 * Connection options shared by every pool and client. With a CA certificate
 * the server's certificate and hostname are verified against it (the
 * equivalent of sslmode=verify-full); otherwise the URL's own settings apply.
 */
export function connectionOptions({ databaseUrl, databaseCaCert }) {
  if (!databaseCaCert) return { connectionString: databaseUrl };
  const url = new URL(databaseUrl);
  for (const param of URL_SSL_PARAMS) url.searchParams.delete(param);
  return { connectionString: url.toString(), ssl: { ca: databaseCaCert, rejectUnauthorized: true } };
}

/**
 * Create a connection pool. The API and the background worker get separate
 * pools so that background load can never starve webhook ingestion of
 * connections.
 */
export function createPool({ connectionString, ssl, name, max, min = 0, statementTimeoutMs = 30_000, logger }) {
  const pool = new pg.Pool({
    connectionString,
    ssl,
    max,
    // Connections up to `min` are never closed for being idle. Opening one costs
    // TLS + auth (about 1s to a remote pooler), and pg-pool makes the request that
    // triggered it wait for it, so a cold pool would blow the webhook deadline.
    min,
    keepAlive: true,
    idleTimeoutMillis: 5 * 60_000,
    connectionTimeoutMillis: 5_000,
    // Session settings are applied with SET rather than as startup parameters,
    // which connection poolers (Supavisor, PgBouncer) may refuse. pg-pool awaits
    // this before handing the connection out; if it fails, the connection is
    // discarded and the caller gets the error.
    onConnect: (client) =>
      client.query(
        `SELECT set_config('statement_timeout', $1, false),
                set_config('idle_in_transaction_session_timeout', $2, false),
                set_config('application_name', $3, false)`,
        [
          String(statementTimeoutMs), // a stuck query cannot hold a connection forever
          '10000', // nor can a transaction left open by a bug (it would also hold its locks)
          `txn-webhooks:${name}`,
        ],
      ),
  });

  // An idle client can be dropped by the server or a proxy. Without this
  // listener that error would crash the process; the pool replaces the client.
  pool.on('error', (err) => logger?.warn({ err, pool: name }, 'idle database client error'));

  return pool;
}

/**
 * Run `fn(client)` on a pooled connection within `deadlineMs` in total.
 *
 * If the deadline passes while still waiting for a connection, the work is
 * abandoned: the connection is handed straight back when it arrives instead of
 * running a statement whose caller has already given up. Without this, work
 * from timed-out requests piles up behind new requests under load, so every
 * later request waits longer and a short spike becomes an outage.
 *
 * If the deadline passes after the statement was sent, it is allowed to finish
 * (it cannot be recalled), and the connection returns to the pool only then.
 */
export async function withConnection(pool, deadlineMs, fn) {
  const started = Date.now();
  const acquiring = pool.connect();
  let client;
  try {
    client = await withDeadline(acquiring, deadlineMs);
  } catch (err) {
    acquiring.then((late) => late.release(), () => {});
    throw err;
  }
  const work = Promise.resolve().then(() => fn(client));
  work.then(
    () => client.release(),
    // Keep the connection after a data error; discard it after anything else.
    (err) => client.release(isDataError(err) ? undefined : err),
  );
  return withDeadline(work, Math.max(1, deadlineMs - (Date.now() - started)));
}

/** Open `count` connections up front so the first webhooks are fast. */
export async function warmPool(pool, count) {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
  for (const client of clients) client.release();
}

/** PostgreSQL SQLSTATE classes caused by bad input rather than infrastructure. */
export function isDataError(err) {
  return typeof err?.code === 'string' && /^(22|23)/.test(err.code);
}
