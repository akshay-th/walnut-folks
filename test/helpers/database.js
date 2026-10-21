import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../../src/migrate.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Provide a migrated, empty PostgreSQL database for one test file.
 * Uses TEST_DATABASE_URL when set (a throwaway database is created on that
 * server); otherwise boots a real Postgres via the embedded-postgres package,
 * so no Docker or local install is needed.
 *
 * @param {object} [options]
 * @param {string[]} [options.postgresFlags]  extra server flags (embedded server only)
 */
export async function startTestDatabase({ postgresFlags = [] } = {}) {
  if (process.env.TEST_DATABASE_URL) {
    const name = `txn_test_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    await migrate(url.toString());
    return {
      url: url.toString(),
      async stop() {
        const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
        await client.connect();
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await client.end();
      },
    };
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const databaseDir = await mkdtemp(join(tmpdir(), 'txn-test-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    postgresFlags,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('test');
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/test`;
  await migrate(url);
  return {
    url,
    port,
    embedded: true,
    async stop() {
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}
