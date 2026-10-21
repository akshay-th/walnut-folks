/**
 * Run a local PostgreSQL for development without Docker or a system install.
 * Data persists in ./.local-pg between runs. Stop with Ctrl+C.
 *
 *   npm run db:local
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/transactions npm run dev
 */
import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.LOCAL_PG_PORT || 5433);
const databaseDir = new URL('../.local-pg/', import.meta.url).pathname;
const firstRun = !existsSync(databaseDir);

const server = new EmbeddedPostgres({
  databaseDir,
  port,
  user: 'postgres',
  password: 'postgres',
  persistent: true,
  onLog: () => {},
});

if (firstRun) await server.initialise();
await server.start();
if (firstRun) await server.createDatabase('transactions');

// embedded-postgres registers its own exit hook that stops the server on Ctrl+C.
console.log(`PostgreSQL running. Use:\n  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/transactions`);
