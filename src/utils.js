/** Small shared helpers with no dependencies. */

export class HttpError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class DeadlineExceededError extends Error {
  constructor(ms) {
    super(`Operation exceeded deadline of ${ms}ms`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Resolve with `promise` or reject once `ms` elapses, whichever comes first.
 * The underlying operation is not cancelled; callers must make sure that a
 * late completion is harmless (it is here, because writes are idempotent).
 */
export function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(ms)), ms);
  });
  // Avoid an unhandled rejection if the operation fails after the deadline won.
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Reject as soon as `signal` aborts, even if `promise` ignores the signal.
 * Guarantees a hung external call cannot block a worker slot forever.
 */
export function raceWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => {});
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** ISO-8601 UTC timestamp without milliseconds, e.g. 2024-01-15T10:30:00Z. */
export function toIsoSeconds(value) {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Exponential backoff with "equal jitter": half fixed, half random. */
export function retryDelayMs(attempt, baseMs, maxMs, random = Math.random) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
