/**
 * Centralised, validated configuration. Every tunable comes from the
 * environment so the same build runs locally, in tests and in the cloud.
 * Invalid configuration fails fast at boot instead of misbehaving later.
 */
import { readFileSync } from 'node:fs';

export class ConfigError extends Error {}

/**
 * CA certificate used to verify the database's TLS certificate (Supabase
 * signs with its own root CA). Accepts the PEM text itself, optionally with
 * literal "\n" escapes so it fits on one line of an env file, or a file path.
 */
function readCaCert(env) {
  const raw = env.DATABASE_CA_CERT;
  if (!raw) return null;
  let pem;
  if (raw.includes('-----BEGIN')) {
    pem = raw.replace(/\\n/g, '\n');
  } else {
    try {
      pem = readFileSync(raw, 'utf8');
    } catch (err) {
      throw new ConfigError(`DATABASE_CA_CERT: cannot read file "${raw}" (${err.code ?? err.message})`);
    }
  }
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new ConfigError('DATABASE_CA_CERT must be a PEM certificate or the path to one');
  }
  return pem;
}

function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function readFloat(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${name} must be a boolean (got "${raw}")`);
}

export function loadConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)');
  }
  if (!URL.canParse(databaseUrl) || !/^postgres(ql)?:$/.test(new URL(databaseUrl).protocol)) {
    throw new ConfigError(
      'DATABASE_URL must be a postgres:// or postgresql:// URL (percent-encode special characters in the password)',
    );
  }

  const config = {
    port: readInt(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    logLevel: env.LOG_LEVEL || 'info',
    databaseUrl,
    databaseCaCert: readCaCert(env),

    // Optional HMAC-SHA256 signature check (Razorpay style). Disabled when unset.
    webhookSecret: env.WEBHOOK_SECRET || null,
    bodyLimitBytes: readInt(env, 'BODY_LIMIT_BYTES', 64 * 1024, { min: 1024 }),

    // Upper bound on how long the webhook handler waits for the database before
    // answering 503 (so the sender retries). Keeps responses inside the 500ms SLA.
    webhookDbTimeoutMs: readInt(env, 'WEBHOOK_DB_TIMEOUT_MS', 450, { min: 50 }),
    readDbTimeoutMs: readInt(env, 'READ_DB_TIMEOUT_MS', 2000, { min: 50 }),
    // Kept small on purpose: API + worker pools together must stay below the
    // pooler's pool size (Supabase session mode queues clients beyond it).
    apiPoolSize: readInt(env, 'API_POOL_SIZE', 10, { min: 1 }),

    worker: {
      enabled: readBool(env, 'WORKER_ENABLED', true),
      poolSize: readInt(env, 'WORKER_POOL_SIZE', 3, { min: 1 }),
      // Jobs are I/O bound (they wait on an "external API"), so many can run at once.
      concurrency: readInt(env, 'WORKER_CONCURRENCY', 100, { min: 1 }),
      pollIntervalMs: readInt(env, 'WORKER_POLL_INTERVAL_MS', 1000, { min: 10 }),
      processingDelayMs: readInt(env, 'PROCESSING_DELAY_MS', 30_000, { min: 0 }),
      processingTimeoutMs: readInt(env, 'PROCESSING_TIMEOUT_MS', 60_000, { min: 1 }),
      leaseMs: readInt(env, 'LEASE_MS', 120_000, { min: 1 }),
      maxAttempts: readInt(env, 'MAX_ATTEMPTS', 5, { min: 1 }),
      retryBaseMs: readInt(env, 'RETRY_BASE_MS', 5_000, { min: 0 }),
      retryMaxMs: readInt(env, 'RETRY_MAX_MS', 5 * 60_000, { min: 0 }),
      simulatedFailureRate: readFloat(env, 'SIMULATED_FAILURE_RATE', 0, { min: 0, max: 1 }),
    },

    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 20_000, { min: 1000 }),
  };

  // A lease must outlive the longest possible attempt, otherwise a second
  // worker could pick up a job that is still legitimately running.
  if (config.worker.leaseMs <= config.worker.processingTimeoutMs) {
    throw new ConfigError(
      `LEASE_MS (${config.worker.leaseMs}) must be greater than PROCESSING_TIMEOUT_MS (${config.worker.processingTimeoutMs})`,
    );
  }
  if (config.worker.retryMaxMs < config.worker.retryBaseMs) {
    throw new ConfigError('RETRY_MAX_MS must be >= RETRY_BASE_MS');
  }

  return config;
}
