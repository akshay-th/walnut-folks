/**
 * Webhook payload validation. Returns every problem at once (not just the
 * first) so a misconfigured sender can fix its payload in one round trip.
 */

// Letters, digits and _ . : - ; must start with a letter or digit; 1-128 chars.
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Keeps every amount exactly representable as a JS number and inside NUMERIC(20,4).
export const MAX_AMOUNT = 1_000_000_000_000;

const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const minorUnitCache = new Map();

/** ISO 4217 minor units: INR/USD -> 2, JPY -> 0, KWD -> 3. */
export function currencyMinorUnits(currency) {
  let digits = minorUnitCache.get(currency);
  if (digits === undefined) {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits;
    minorUnitCache.set(currency, digits);
  }
  return digits;
}

/** Number of digits after the decimal point in the shortest representation of n. */
export function decimalPlaces(n) {
  const [mantissa, exponent] = String(n).toLowerCase().split('e');
  const fraction = (mantissa.split('.')[1] || '').length;
  return Math.max(0, fraction - Number(exponent || 0));
}

function validateId(body, field, errors) {
  const value = body[field];
  if (value === undefined || value === null) {
    errors.push({ field, message: 'is required' });
  } else if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string' });
  } else if (!ID_PATTERN.test(value)) {
    errors.push({
      field,
      message: 'must be 1-128 characters of letters, digits, "_", ".", ":" or "-", starting with a letter or digit',
    });
  } else {
    return value;
  }
  return undefined;
}

function validateCurrency(body, errors) {
  const value = body.currency;
  if (value === undefined || value === null) {
    errors.push({ field: 'currency', message: 'is required' });
    return undefined;
  }
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    errors.push({ field: 'currency', message: 'must be a 3-letter ISO 4217 currency code' });
    return undefined;
  }
  const currency = value.toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    errors.push({ field: 'currency', message: `"${value}" is not a recognised ISO 4217 currency code` });
    return undefined;
  }
  return currency;
}

function validateAmount(body, currency, errors) {
  const value = body.amount;
  if (value === undefined || value === null) {
    errors.push({ field: 'amount', message: 'is required' });
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field: 'amount', message: 'must be a JSON number' });
  } else if (value <= 0) {
    errors.push({ field: 'amount', message: 'must be greater than 0' });
  } else if (value > MAX_AMOUNT) {
    errors.push({ field: 'amount', message: `must not exceed ${MAX_AMOUNT}` });
  } else if (currency && decimalPlaces(value) > currencyMinorUnits(currency)) {
    const units = currencyMinorUnits(currency);
    errors.push({
      field: 'amount',
      message: `must have at most ${units} decimal place${units === 1 ? '' : 's'} for ${currency}`,
    });
  } else {
    return value;
  }
  return undefined;
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, errors: {field: string, message: string}[] }}
 */
export function validateWebhookPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ field: 'body', message: 'must be a JSON object' }] };
  }

  const errors = [];
  const transactionId = validateId(body, 'transaction_id', errors);
  const sourceAccount = validateId(body, 'source_account', errors);
  const destinationAccount = validateId(body, 'destination_account', errors);
  const currency = validateCurrency(body, errors);
  const amount = validateAmount(body, currency, errors);

  if (sourceAccount && destinationAccount && sourceAccount === destinationAccount) {
    errors.push({ field: 'destination_account', message: 'must differ from source_account' });
  }

  if (errors.length > 0) return { ok: false, errors };

  // Unknown fields are ignored (senders add fields over time) but are kept in
  // the stored raw payload for auditing.
  return {
    ok: true,
    value: {
      transaction_id: transactionId,
      source_account: sourceAccount,
      destination_account: destinationAccount,
      amount,
      currency,
    },
  };
}
