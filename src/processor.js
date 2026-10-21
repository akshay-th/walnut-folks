import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Stand-in for the external API call(s) a real processor would make (fraud
 * check, ledger posting, ...). It waits `delayMs`, honours cancellation, and
 * can fail at a configurable rate so the retry path can be exercised.
 *
 * In production the transaction_id would be forwarded as the idempotency key
 * to the downstream API, which makes a re-run after a crash harmless.
 */
export function createSimulatedProcessor({ delayMs, failureRate = 0, random = Math.random }) {
  return async function processTransaction(transaction, { signal }) {
    await sleep(delayMs, undefined, { signal });
    if (failureRate > 0 && random() < failureRate) {
      throw new Error('Simulated external API failure');
    }
  };
}
