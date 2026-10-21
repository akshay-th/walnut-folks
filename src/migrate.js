import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
// Arbitrary constant; serialises migrations when several instances boot at once.
const MIGRATION_LOCK_ID = 727_001;

class MigrationError extends Error {}

/**
 * Apply pending migrations. Everything runs in one transaction holding a
 * transaction-scoped advisory lock, so concurrent boots are serialised, a
 * failure leaves the schema untouched, and it also works through a
 * transaction-mode connection pooler (a session lock would not).
 *
 * @param {string | {connectionString: string, ssl?: object}} connection
 */
export async function migrate(connection, logger) {
  const options = typeof connection === 'string' ? { connectionString: connection } : connection;
  const client = new pg.Client(options);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, pathToFileURL(MIGRATIONS_DIR)), 'utf8');
      try {
        await client.query(sql);
      } catch (err) {
        throw new MigrationError(`Migration ${file} failed: ${err.message}`, { cause: err });
      }
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      logger?.info({ migration: file }, 'applied migration');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Retry `migrate` while the database is still coming up (e.g. a paused or cold DB). */
export async function migrateWithRetry(connection, logger, { attempts = 10, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await migrate(connection, logger);
    } catch (err) {
      if (attempt >= attempts || err instanceof MigrationError) throw err;
      logger?.warn({ err: err.message, attempt }, 'database not reachable yet, retrying migrations');
      await sleep(delayMs);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { connectionOptions } = await import('./db.js');
  const { loadConfig } = await import('./config.js');
  const config = loadConfig();
  await migrate(connectionOptions(config), { info: (meta, msg) => console.log(msg, meta) });
  console.log('migrations up to date');
}
