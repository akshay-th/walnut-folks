import pino from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connectionOptions, createPool, warmPool } from './db.js';
import { migrateWithRetry } from './migrate.js';
import { createSimulatedProcessor } from './processor.js';
import { TransactionWorker } from './worker.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let config;
try {
  config = loadConfig();
} catch (err) {
  logger.fatal(err.message);
  process.exit(1);
}

const connection = connectionOptions(config);

try {
  await migrateWithRetry(connection, logger);
} catch (err) {
  logger.fatal({ err }, 'could not apply database migrations');
  process.exit(1);
}

const apiPool = createPool({
  ...connection,
  name: 'api',
  max: config.apiPoolSize,
  min: config.apiPoolSize, // keep every API connection open and warm
  statementTimeoutMs: 5_000,
  logger,
});
await warmPool(apiPool, config.apiPoolSize).catch((err) =>
  logger.warn({ err }, 'could not pre-warm database pool'),
);

let workerPool = null;
let worker = null;
if (config.worker.enabled) {
  workerPool = createPool({
    ...connection,
    name: 'worker',
    max: config.worker.poolSize,
    statementTimeoutMs: 30_000,
    logger,
  });
  worker = new TransactionWorker({
    pool: workerPool,
    config: config.worker,
    logger: logger.child({ component: 'worker' }),
    processTransaction: createSimulatedProcessor({
      delayMs: config.worker.processingDelayMs,
      failureRate: config.worker.simulatedFailureRate,
    }),
  });
}

const app = buildApp({ config, pool: apiPool, worker, logger });

let shuttingDown = false;
async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    // Finish in-flight HTTP requests (new ones get 503) and hand interrupted
    // jobs back to the queue so another instance resumes them immediately.
    await Promise.all([app.close(), worker?.stop()]);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    exitCode = 1;
  }
  await Promise.allSettled([apiPool.end(), workerPool?.end()]);
  logger.info('shutdown complete');
  process.exit(exitCode);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'unhandled promise rejection');
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  shutdown('uncaughtException', 1);
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  logger.fatal({ err }, 'could not start HTTP server');
  await shutdown('listen failed', 1);
}
worker?.start();
