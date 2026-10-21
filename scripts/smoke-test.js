/**
 * End-to-end check against a running instance (local or deployed), covering
 * the assessment's success criteria:
 *   1. single transaction is processed after ~30s
 *   2. duplicate webhooks produce one transaction
 *   3. webhook latency stays low under load
 *
 *   node scripts/smoke-test.js [BASE_URL] [--load=N] [--no-wait]
 *   e.g. node scripts/smoke-test.js https://my-service.onrender.com --load=100
 */
const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) ?? 'http://localhost:3000').replace(/\/$/, '');
const loadCount = Number(args.find((a) => a.startsWith('--load='))?.split('=')[1] ?? 50);
const wait = !args.includes('--no-wait');
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function webhook(id, overrides = {}) {
  return {
    transaction_id: id,
    source_account: 'acc_user_789',
    destination_account: 'acc_merchant_456',
    amount: 1500,
    currency: 'INR',
    ...overrides,
  };
}

async function send(body) {
  const started = performance.now();
  const res = await fetch(`${base}/v1/webhooks/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ms: performance.now() - started };
}

async function getTransaction(id) {
  const res = await fetch(`${base}/v1/transactions/${id}?verbose=true`);
  return { status: res.status, json: await res.json() };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const fmt = (ms) => `${ms.toFixed(0)}ms`;

console.log(`Target: ${base}\n`);

console.log('Health check');
const health = await fetch(`${base}/`);
const healthBody = await health.json();
check(health.status === 200 && healthBody.status === 'HEALTHY', 'GET / is HEALTHY', JSON.stringify(healthBody));

console.log('\n1. Single transaction');
const singleId = `txn_smoke_${runId}`;
const first = await send(webhook(singleId));
check(first.status === 202, 'webhook returns 202', `${first.status} in ${fmt(first.ms)}`);
check(first.ms < 500, 'webhook responds within 500ms', fmt(first.ms));
const initial = await getTransaction(singleId);
check(initial.json?.[0]?.status === 'PROCESSING', 'status is PROCESSING right after the webhook');

console.log('\n2. Duplicate prevention');
const sequential = [];
for (let i = 0; i < 3; i++) sequential.push(await send(webhook(singleId)));
const concurrent = await Promise.all(Array.from({ length: 10 }, () => send(webhook(singleId))));
const dupes = [...sequential, ...concurrent];
check(dupes.every((r) => r.status === 202 && r.json?.duplicate === true), '13 redeliveries all return 202 duplicate=true');
const conflict = await send(webhook(singleId, { amount: 9999 }));
check(conflict.status === 409, 'same id with a different amount is rejected', `${conflict.status}`);

console.log(`\n3. Performance: ${loadCount} distinct webhooks, 25 concurrent`);
const results = [];
const loadIds = Array.from({ length: loadCount }, (_, i) => `txn_load_${runId}_${i}`);
for (let i = 0; i < loadIds.length; i += 25) {
  results.push(...(await Promise.all(loadIds.slice(i, i + 25).map((id) => send(webhook(id, { amount: 10 + i }))))));
}
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
check(results.every((r) => r.status === 202), `all ${loadCount} accepted with 202`);
console.log(
  `        latency p50 ${fmt(percentile(latencies, 0.5))}, p95 ${fmt(percentile(latencies, 0.95))}, max ${fmt(latencies.at(-1))}`,
);
check(percentile(latencies, 0.95) < 500, 'p95 latency under 500ms (includes network round trip)');

if (wait) {
  console.log('\nWaiting for background processing (up to 120s)...');
  const deadline = Date.now() + 120_000;
  let txn;
  while (Date.now() < deadline) {
    txn = (await getTransaction(singleId)).json?.[0];
    if (txn?.status !== 'PROCESSING') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const took = (Date.parse(txn?.processed_at) - Date.parse(txn?.created_at)) / 1000;
  check(txn?.status === 'PROCESSED', 'single transaction PROCESSED', `after ${took}s`);
  check(took >= 29 && took <= 45, 'processing took ~30s', `${took}s`);
  check(txn?.attempts === 1, 'processed exactly once despite 14 deliveries', `attempts=${txn?.attempts}, deliveries=${txn?.delivery_count}`);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
