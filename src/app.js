import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { isDataError, withConnection } from './db.js';
import { findTransaction, recordWebhook } from './repository.js';
import { SIGNATURE_HEADERS, verifySignature } from './signature.js';
import { HttpError, toIsoSeconds } from './utils.js';
import { ID_PATTERN, validateWebhookPayload } from './validation.js';

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Friendlier codes for errors raised by Fastify itself.
const FRAMEWORK_ERROR_CODES = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'INVALID_CONTENT_LENGTH',
};

function errorBody(code, message, details) {
  return { error: details ? { code, message, details } : { code, message } };
}

export function serializeTransaction(row, { verbose = false } = {}) {
  const body = {
    transaction_id: row.transaction_id,
    source_account: row.source_account,
    destination_account: row.destination_account,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    created_at: toIsoSeconds(row.created_at),
    processed_at: toIsoSeconds(row.processed_at),
  };
  if (verbose) {
    Object.assign(body, {
      attempts: row.attempts,
      delivery_count: row.delivery_count,
      last_error: row.last_error,
      next_attempt_at: row.status === 'PROCESSING' ? toIsoSeconds(row.next_attempt_at) : null,
      updated_at: toIsoSeconds(row.updated_at),
    });
  }
  return body;
}

/**
 * @param {object} deps
 * @param {object} deps.config  see config.js
 * @param {{query: Function}} deps.pool  database pool reserved for API traffic
 * @param {{notify: Function} | null} [deps.worker]  nudged when new work arrives
 * @param {object} [deps.logger]  pino instance; omit to disable logging
 */
export function buildApp({ config, pool, worker = null, logger }) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: true,
    requestTimeout: 10_000, // drop slow-loris style clients
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 256 },
  });

  // Parse JSON ourselves so the exact raw text is available for signature
  // checks and auditing. Only application/json is accepted (415 otherwise).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body;
    const text = body.toString('utf8').replace(/^﻿/, '');
    if (text.trim() === '') return done(new HttpError(400, 'EMPTY_BODY', 'Request body is empty'));
    try {
      request.rawText = text;
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON'));
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (err.statusCode >= 400 && err.statusCode < 500) {
      const code = FRAMEWORK_ERROR_CODES[err.code] ?? 'BAD_REQUEST';
      return reply.code(err.statusCode).send(errorBody(code, err.message));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found`));
  });

  function allowOnly(url, allowed) {
    app.route({
      method: ALL_METHODS.filter((method) => !allowed.includes(method)),
      url,
      handler: async (request, reply) => {
        reply.header('allow', allowed.join(', '));
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${request.method} is not allowed on ${url}`);
      },
    });
  }

  function unavailable(reply, message) {
    reply.header('retry-after', '5');
    return new HttpError(503, 'SERVICE_UNAVAILABLE', message);
  }

  // ---------------------------------------------------------------- health
  app.get('/', async (request, reply) => {
    const current_time = toIsoSeconds(new Date());
    try {
      await withConnection(pool, config.readDbTimeoutMs, (client) => client.query('SELECT 1'));
      return { status: 'HEALTHY', current_time };
    } catch (err) {
      request.log.warn({ err }, 'health check failed: database unreachable');
      return reply.code(503).send({ status: 'UNHEALTHY', current_time });
    }
  });
  allowOnly('/', ['GET']);

  // --------------------------------------------------------------- webhook
  app.post('/v1/webhooks/transactions', async (request, reply) => {
    if (config.webhookSecret) {
      const signature = SIGNATURE_HEADERS.map((name) => request.headers[name]).find(Boolean);
      if (!verifySignature(request.rawBody ?? Buffer.alloc(0), signature, config.webhookSecret)) {
        throw new HttpError(401, 'INVALID_SIGNATURE', 'Missing or invalid webhook signature');
      }
    }
    if (request.body === undefined) {
      throw new HttpError(400, 'EMPTY_BODY', 'Request body is required');
    }

    const result = validateWebhookPayload(request.body);
    if (!result.ok) {
      throw new HttpError(422, 'VALIDATION_ERROR', 'Webhook payload is invalid', result.errors);
    }
    const txn = result.value;
    const log = request.log.child({ transaction_id: txn.transaction_id });

    // The webhook is only acknowledged once it is durably stored, so a 202 can
    // never be lost. If storage is slow or down we answer 503 within the
    // deadline and the sender retries. Retries are safe because the write is
    // idempotent: a write that still lands late turns the retry into a duplicate.
    let outcome;
    try {
      outcome = await withConnection(pool, config.webhookDbTimeoutMs, (client) =>
        recordWebhook(client, txn, request.rawText),
      );
    } catch (err) {
      if (isDataError(err)) {
        log.warn({ err }, 'payload rejected by database constraints');
        throw new HttpError(422, 'UNPROCESSABLE_PAYLOAD', 'Webhook payload could not be stored');
      }
      log.error({ err }, 'could not persist webhook');
      throw unavailable(reply, 'Webhook could not be recorded right now; please retry');
    }

    if (outcome.conflict) {
      // Same id, different money movement: never silently accept or overwrite.
      log.warn({ received: txn }, 'transaction_id reused with a different payload');
      throw new HttpError(
        409,
        'IDEMPOTENCY_CONFLICT',
        `transaction_id "${txn.transaction_id}" was already received with a different payload`,
      );
    }
    if (outcome.inserted) {
      log.info('webhook accepted');
      worker?.notify();
    } else {
      const { delivery_count: deliveries, status } = outcome.row;
      log.info({ deliveries, status }, 'duplicate webhook acknowledged');
    }

    return reply.code(202).send({
      message: 'Webhook accepted',
      transaction_id: txn.transaction_id,
      duplicate: !outcome.inserted,
    });
  });
  allowOnly('/v1/webhooks/transactions', ['POST']);

  // ----------------------------------------------------------------- query
  app.get('/v1/transactions/:transaction_id', async (request, reply) => {
    const { transaction_id: transactionId } = request.params;
    if (!ID_PATTERN.test(transactionId)) {
      throw new HttpError(400, 'INVALID_TRANSACTION_ID', 'transaction_id has an invalid format');
    }

    let row;
    try {
      row = await withConnection(pool, config.readDbTimeoutMs, (client) => findTransaction(client, transactionId));
    } catch (err) {
      request.log.error({ err }, 'could not load transaction');
      throw unavailable(reply, 'Transaction could not be loaded right now; please retry');
    }
    if (!row) {
      throw new HttpError(404, 'TRANSACTION_NOT_FOUND', `No transaction with id "${transactionId}"`);
    }

    const verbose = /^(1|true)$/i.test(String(request.query.verbose ?? ''));
    reply.header('cache-control', 'no-store');
    return [serializeTransaction(row, { verbose })];
  });
  allowOnly('/v1/transactions/:transaction_id', ['GET']);

  return app;
}
