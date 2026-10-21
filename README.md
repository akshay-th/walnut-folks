# Transaction Webhook Service

A Node.js service that receives transaction webhooks from payment processors (Razorpay-style), acknowledges them in milliseconds, and processes them reliably in the background, exactly once per `transaction_id`.

**Live API:** [`http://35.76.124.52`](http://35.76.124.52/) (AWS EC2, Tokyo)

Stack: Node.js 22 + Fastify, PostgreSQL on **Supabase**, deployed on **AWS EC2** (Docker).

```bash
BASE=http://35.76.124.52   # or http://localhost:3000
curl -s $BASE/
curl -s -X POST $BASE/v1/webhooks/transactions -H 'content-type: application/json' \
  -d '{"transaction_id":"txn_abc123def456","source_account":"acc_user_789","destination_account":"acc_merchant_456","amount":1500,"currency":"INR"}'
curl -s $BASE/v1/transactions/txn_abc123def456          # PROCESSING now, PROCESSED after ~30s
node scripts/smoke-test.js $BASE                         # automated check of every success criterion
```

---

## How it works

```
 Payment processor                                   PostgreSQL (transactions table = durable queue)
        │  POST /v1/webhooks/transactions                     ▲                        ▲
        ▼                                                     │ 1 INSERT … ON CONFLICT │ 3 claim due rows
 ┌───────────────┐  validate ─► persist ─► 202 (≈5-20ms) ─────┘                        │   (FOR UPDATE SKIP LOCKED,
 │  Fastify API  │                    │                                                │    lease token + expiry)
 └───────────────┘                    │ 2 notify (in-process)                          │
                                      ▼                                                │ 5 mark PROCESSED
                             ┌──────────────────┐   4 simulated external call (30s,    │   (only if lease token
                             │ Background worker│─────  no DB connection held) ────────┘    still matches)
                             └──────────────────┘
```

1. **Ingest.** The webhook is validated, then written with a single `INSERT … ON CONFLICT (transaction_id) DO UPDATE … WHERE <payload matches>` statement. The `202` is sent only after that write commits, so an acknowledged webhook is never lost.
2. **Notify.** The in-process worker is woken immediately. A 1s poll covers other instances and restarts.
3. **Claim.** The worker leases due rows with `FOR UPDATE SKIP LOCKED`. Each claim stamps a fresh `lease_token` (fencing token) and a `locked_until` expiry. This is a short statement, and the connection goes straight back to the pool.
4. **Process.** The 30s "external API call" runs without holding a DB connection or transaction. Up to 100 jobs run concurrently per instance.
5. **Complete.** `UPDATE … SET status='PROCESSED' WHERE lease_token = $mine AND status='PROCESSING'`. A worker that lost its lease can't overwrite anything, so each transaction becomes `PROCESSED` exactly once.

The API and the worker use **separate connection pools**, so background load can't starve webhook ingestion.

## Edge cases covered

| Area | Situation | Behaviour |
|---|---|---|
| Idempotency | Same webhook sent again (sequentially or 50 at once) | `202`, `"duplicate": true`. One row, one processing run. The race is resolved by the primary key, not by app code. |
| | Redelivery after processing finished | `202` duplicate. The status stays `PROCESSED` and nothing is re-run. |
| | Same `transaction_id`, different amount/accounts/currency | `409 IDEMPOTENCY_CONFLICT`. The original record is kept unchanged and the attempt is logged. |
| | Equivalent payload (lower-case currency, `1500.0`, other key order, extra fields) | Treated as the same delivery. |
| Validation | Missing/null fields, wrong types, numeric strings for `amount` | `422` listing **every** invalid field |
| | `amount` ≤ 0, NaN/Infinity, > 1e12, too many decimals for the currency (JPY 0, INR 2, KWD 3), float noise like `0.30000000000000004` | `422` |
| | Unknown ISO 4217 currency, same source and destination account, IDs with spaces/slashes or over 128 chars | `422` |
| | Unknown extra fields | Accepted (senders add fields over time) and kept in `raw_payload` |
| Malformed requests | Invalid JSON / empty body / no body | `400 INVALID_JSON` / `400 EMPTY_BODY` |
| | Non-JSON content type; body > 64 KB | `415` / `413` |
| | UTF-8 BOM, `charset` parameter, `\u0000` or emoji in fields | Accepted. The raw body is stored in a `JSON` (not `JSONB`) column, so it's kept verbatim. |
| | Wrong HTTP method; trailing slash | `405` with an `Allow` header; trailing slash works |
| Latency (500ms SLA) | Heavy background load | The worker never holds DB connections while waiting, and the API has its own pool. Measured locally: p95 23ms, max 40ms over 200 webhooks sent 25 at a time while 100 jobs were in flight. |
| | Database slow or hung | `503` + `Retry-After` after at most `WEBHOOK_DB_TIMEOUT_MS` (450ms), so the sender retries. If the original write lands late anyway, the retry is just a duplicate. |
| | Overload (more requests than connections can serve in time) | A request that runs out of time while still waiting for a connection is dropped, not run late. Otherwise every abandoned insert would queue ahead of newer requests, and a short spike would leave a backlog that makes everything after it miss the deadline too. |
| | Database down | `503` (never a false `202`). Health check reports `UNHEALTHY`. |
| Reliability | External call fails | Retried with exponential backoff and jitter (5s → 5min), then `FAILED` after `MAX_ATTEMPTS`, keeping `last_error`. |
| | External call hangs (even if it ignores cancellation) | Hard timeout (`PROCESSING_TIMEOUT_MS`), then the retry path |
| | Process killed (`kill -9`, OOM, host failure) | The lease expires and any instance re-claims the job. Verified by killing an instance with 100 jobs in flight; a fresh instance finished all 100. |
| | Deploy/restart (`SIGTERM`) | Stops accepting requests, finishes in-flight ones, aborts running jobs and **releases their leases** (the attempt is refunded), so the next instance resumes them right away |
| | A job that keeps crashing its worker (poison pill) | Crash-induced re-claims count as attempts, so it ends as `FAILED` instead of looping forever |
| | DB error while saving a result | Retried 3×. If it still fails, lease expiry recovers the job. |
| | Several instances / workers | `SKIP LOCKED` + fencing tokens; tested with 4 competing workers, 40 jobs, each processed once |
| | Idle DB connection dropped by a proxy | Handled by the pool's `error` listener, so the process doesn't crash |
| | Clock skew between instances | All timing (`now()`, leases, retries) uses the database clock |
| | Concurrent migrations at boot | Applied in one transaction under a transaction-scoped advisory lock, so they're serialised and all-or-nothing. Boot retries while a paused or cold database wakes up. |
| | Connection pooler (Supabase Supavisor) | Session settings (`statement_timeout`, `application_name`) are applied with `SET`, not as startup parameters a pooler may reject. Migrations don't depend on session state. Default pool sizes fit the free plan's pooler. |
| | Bad `DATABASE_URL` / CA certificate | Rejected at boot with a clear message |
| Security | Spoofed webhooks | Optional HMAC-SHA256 verification of the raw body (`WEBHOOK_SECRET`) via `X-Webhook-Signature` or Razorpay's `X-Razorpay-Signature`, compared in constant time |
| | Supabase's auto-generated REST API (reachable with the public anon key) | Row level security is on with no policies, and privileges are revoked from `anon`/`authenticated`, so nothing can be read or written that way. The service connects as the table owner and is unaffected. |
| | Database TLS | With `DATABASE_CA_CERT`, the server certificate **and hostname** are verified against Supabase's CA (verify-full), and SSL options in the URL can't quietly weaken it |
| | Slow-loris clients | 10s request timeout |

## API

### `POST /v1/webhooks/transactions`

```json
{ "transaction_id": "txn_abc123def456", "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456", "amount": 1500, "currency": "INR" }
```

| Status | When | Body |
|---|---|---|
| `202` | New or duplicate delivery | `{"message":"Webhook accepted","transaction_id":"…","duplicate":false}` |
| `400` | Malformed / empty JSON | `{"error":{"code":"INVALID_JSON","message":"…"}}` |
| `401` | Bad signature (only when `WEBHOOK_SECRET` is set) | `INVALID_SIGNATURE` |
| `409` | `transaction_id` reused with different details | `IDEMPOTENCY_CONFLICT` |
| `413` / `415` | Body too large / not `application/json` | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| `422` | Schema violation | `VALIDATION_ERROR` with `details: [{field, message}]` |
| `503` | Could not store durably in time; retry | `SERVICE_UNAVAILABLE`, `Retry-After: 5` |

### `GET /v1/transactions/{transaction_id}`

`200` with the shape from the spec (an array with one element). `404 TRANSACTION_NOT_FOUND` for unknown IDs, `400` for malformed ones.

```json
[{ "transaction_id": "txn_abc123def456", "source_account": "acc_user_789",
   "destination_account": "acc_merchant_456", "amount": 1500, "currency": "INR",
   "status": "PROCESSED", "created_at": "2024-01-15T10:30:00Z", "processed_at": "2024-01-15T10:30:30Z" }]
```

`status` is `PROCESSING`, `PROCESSED`, or `FAILED` (after all retries are used up). Add `?verbose=true` to also get `attempts`, `delivery_count`, `last_error`, `next_attempt_at` and `updated_at`, which show how many duplicate deliveries came in versus how many times the job actually ran.

### `GET /`

`200 {"status":"HEALTHY","current_time":"2024-01-15T10:30:00Z"}`. The handler checks the database, and returns `503 {"status":"UNHEALTHY",…}` if it can't reach it.

## Running locally

Requires Node.js 20.12+ (22 LTS recommended). Fastify 5 needs Node 20 or newer, and Node 18 has been end-of-life since April 2025.

```bash
npm install

# Option A: no Docker needed. Starts a real PostgreSQL from the embedded-postgres package.
npm run db:local                       # terminal 1, leave running
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/transactions npm run dev   # terminal 2

# Option B: Docker
docker compose up --build

# Then, in another terminal:
node scripts/smoke-test.js http://localhost:3000
```

To run locally against Supabase instead, put `DATABASE_URL` and `DATABASE_CA_CERT` in `.env` (it's git-ignored) and run `node --env-file=.env src/server.js`.

Migrations run automatically at startup. Use `PROCESSING_DELAY_MS=3000` for faster manual testing and `SIMULATED_FAILURE_RATE=0.5` to watch retries.

## Tests

```bash
npm test     # 102 tests, about 10s. Boots a throwaway PostgreSQL automatically.
TEST_DATABASE_URL=postgres://… npm test    # or use your own server (a temporary DB is created and dropped)
```

- **`test/unit.test.js`**: validation rules, currency precision, signatures, backoff, config checks
- **`test/api.test.js`** (real Postgres): status codes, sequential and 50-way concurrent duplicates, conflicts, malformed input, DB hung/down/late-write behaviour, overload without a stale-work backlog, signatures, and a load test that asserts every webhook takes under 500ms while 100 jobs are in flight
- **`test/database.test.js`** (real Postgres with TLS on): verified TLS against a private CA (as Supabase uses), refusal without the CA, hostname checking, `SET`-based session settings, concurrent migrations, row level security hiding rows from non-owner roles
- **`test/worker.test.js`** (real Postgres): ~delay timing, exactly-once with duplicates and 4 competing workers, concurrency cap, retry→success, retry→`FAILED`, hung-call timeout, crash recovery via lease expiry, poison pills, lease fencing, graceful-shutdown hand-off, DB outage

`scripts/smoke-test.js` runs the assessment's success criteria against any URL. Local result with the real 30s delay:

```
webhook returns 202 (20ms) · 13 redeliveries → duplicate=true · conflict → 409
200 distinct webhooks, 25 concurrent: p50 7ms, p95 23ms, max 40ms
single transaction PROCESSED after 30s · attempts=1, deliveries=14
```

Against the real Supabase project (Tokyo), run from a laptop about 115ms away, all checks pass: 100 webhooks sent 25 at a time took 246ms at p50 and 400ms at p95, mostly network distance. Supabase's REST API, called with the publishable key, returns `401 permission denied` for reads and writes on both tables.

**Live on EC2** (`ap-northeast-1`, the same region as the database), all smoke-test checks pass. In the service's own request logs, webhooks took **6.1ms at p50 and 14ms at p95** over 114 requests; whatever a client measures beyond that is network distance. I also rebooted the instance while a job was running. The service was healthy again 23 seconds later. The interrupted job had been handed back during shutdown, was picked up again after boot, and finished, still counted as a single attempt.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL 13+ connection string (for Supabase, the Session pooler URI) |
| `DATABASE_CA_CERT` | unset | CA certificate to verify the DB's TLS certificate: a file path (relative to the working directory) or PEM text (`\n` escapes allowed). For Supabase: `certs/supabase-prod-ca-2021.crt`. |
| `PORT` | `3000` | HTTP port |
| `WEBHOOK_SECRET` | unset | Enables HMAC signature verification |
| `WEBHOOK_DB_TIMEOUT_MS` | `450` | Longest wait for the DB before replying `503` |
| `API_POOL_SIZE` / `WORKER_POOL_SIZE` | `10` / `3` | Separate DB connection pools for HTTP traffic and the worker. Their sum must stay below the pooler's pool size. |
| `PROCESSING_DELAY_MS` | `30000` | Simulated external call duration |
| `PROCESSING_TIMEOUT_MS` | `60000` | Hard timeout per attempt |
| `LEASE_MS` | `120000` | Time before a crashed worker's job is re-claimed. Must be greater than the timeout (checked at boot). |
| `MAX_ATTEMPTS` | `5` | Attempts before `FAILED` |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `5000` / `300000` | Backoff bounds |
| `WORKER_CONCURRENCY` | `100` | Jobs processed in parallel per instance |
| `WORKER_ENABLED` | `true` | Set `false` to run API-only instances |
| `SIMULATED_FAILURE_RATE` | `0` | 0–1, injects failures to demonstrate retries |

All values are validated at startup, and invalid config stops the boot with a clear message. See `.env.example`.

## Deployment: Supabase + AWS EC2

### 1. Database (Supabase)

1. Create a project in the region where the app will run. The live deployment uses *Northeast Asia (Tokyo)*, AWS `ap-northeast-1`, for both the database and EC2. Use a password of letters and digits, or percent-encode special characters when you put it in the URL.
2. Open **Connect** → **Session pooler** and copy the URI. This is `DATABASE_URL`. Copy the host exactly: each region has more than one pooler cluster (`aws-0-…`, `aws-1-…`), and the wrong one fails with `tenant/user … not found`.
   - Don't use the **direct connection**: `db.<ref>.supabase.co` is IPv6-only, and EC2's default network, Render and most home networks are IPv4.
   - Don't use the **transaction pooler** (port 6543). It's built for serverless functions, and this is a long-running server with its own connection pools.
3. Supabase signs its certificates with its own CA, so without that CA node-postgres refuses `sslmode=require` with "self-signed certificate in certificate chain". The repo ships it as [`certs/supabase-prod-ca-2021.crt`](certs/supabase-prod-ca-2021.crt). It's the public *Supabase Root 2021 CA*, the same file as **Database Settings → SSL Configuration → Download certificate**, with SHA-256 fingerprint `80:70:25:AD:…:72:E6:CA:FA`. Set `DATABASE_CA_CERT=certs/supabase-prod-ca-2021.crt`. To check it yourself: `openssl x509 -in certs/supabase-prod-ca-2021.crt -noout -fingerprint -sha256`.
4. There are no tables to create: migrations run at startup. The Project URL and API keys aren't needed either, because the service connects to Postgres directly (see [Technical choices](#technical-choices)).
5. Mind the pooler's session limit. On the free plan it's **15** sessions per project, and going over fails with `EMAXCONNSESSION max clients reached in session mode`. The service uses 13 (10 API + 3 worker), which leaves 2 for the dashboard and ad-hoc scripts. Stop the service before running anything that opens many connections, and keep `API_POOL_SIZE + WORKER_POOL_SIZE` below the pool size under **Database Settings → Connection pooling** if you change it.

Free projects pause after a week without activity. The worker queries the database every second, so the project stays awake as long as the service is running.

### 2. App (AWS EC2)

I chose EC2 because the worker has to run all the time to handle the 30s jobs, retries and crash recovery. A Docker container on a small always-on VM is the simplest thing that does that. Lambda and App Runner are request-driven, so continuous background work would need a redesign there (for example SQS plus a consumer).

1. In the EC2 console, **in the same region as the Supabase project** (`ap-northeast-1` here), choose **Launch instance**:
   - AMI: **Amazon Linux 2023**. Instance type: **t3.micro** (or the Arm-based t4g.micro). Create a key pair.
   - Security group: allow **HTTP (80)** from anywhere, and **SSH (22)** from *My IP* only.
2. Connect: `ssh -i key.pem ec2-user@<public-ip>`
3. On the instance:
   ```bash
   sudo dnf install -y git nano
   git clone https://github.com/akshay-th/walnut-folks.git app && cd app
   sudo bash deploy/aws/ec2-setup.sh       # installs Docker, creates /etc/transaction-webhook-service/app.env, then stops
   sudo nano /etc/transaction-webhook-service/app.env    # paste DATABASE_URL; DATABASE_CA_CERT is already set
   sudo bash deploy/aws/ec2-setup.sh       # builds the image, starts the container, waits until GET / is HEALTHY
   ```
4. From your laptop: `node scripts/smoke-test.js http://<public-ip>`

[`deploy/aws/ec2-setup.sh`](deploy/aws/ec2-setup.sh) keeps secrets in a root-only file outside the repo. The container restarts on crash and on reboot, and log files are rotated. On a redeploy (`git pull && sudo bash deploy/aws/ec2-setup.sh`) the old container is stopped with `SIGTERM`, so running jobs are handed back to the queue and the new container picks them up. Logs: `sudo docker logs -f transaction-webhook-service`.

**Cost:** roughly $12/month (t3.micro, public IPv4 address, 8 GB disk), paid from the Free plan credits. Set a budget alert. An Elastic IP keeps the address the same across stop/start.

**Not done yet: HTTPS.** Real payment processors only deliver webhooks to `https://` URLs. The next step is a domain with Caddy in front (automatic Let's Encrypt certificates), or an Application Load Balancer with an ACM certificate. Plain HTTP is fine for testing this assessment.

### Alternative: Render

New → Blueprint → select this repo ([`render.yaml`](render.yaml)), then set `DATABASE_URL` (the blueprint already points `DATABASE_CA_CERT` at the CA in the repo). Free instances sleep after 15 minutes without traffic. The first request after that takes about a minute, which breaks the 500ms requirement, and background processing pauses while the service sleeps. On the free plan, point an uptime monitor at `GET /` every 10 minutes, or use a paid instance.

## Technical choices

- **Node.js + Fastify.** Fastify has low per-request overhead, built-in pino structured logging, body limits and content-type handling. The workload is I/O-bound, which suits Node's event loop: 100 concurrent 30s jobs are 100 timers, not 100 threads.
- **Supabase through a plain Postgres connection (`pg`), not `supabase-js`.** `supabase-js` goes through Supabase's REST API (PostgREST). That API can't express `INSERT … ON CONFLICT … WHERE … RETURNING`, `FOR UPDATE SKIP LOCKED`, or a migration transaction, unless each one is wrapped in a database function and called over RPC. Those are exactly the features the idempotency and the queue depend on. A direct connection also keeps the service portable: the same code runs on RDS, Neon or local Postgres, which is what the tests use.
- **PostgreSQL as both the store and the queue** (no Redis/SQS). The webhook write and the job enqueue are the *same row*, so they can't diverge: there's no "saved but never queued" or "queued but not saved". `ON CONFLICT` gives race-free idempotency, and `SKIP LOCKED` with leases gives a safe multi-worker queue. With one fewer moving part, there's one fewer thing to fail or to keep consistent. At much higher volume I'd move the queue to SQS/Kafka with an outbox table.
- **Ack only after a durable write.** Responding before persisting would be faster but could lose transactions during a crash. The insert takes a few ms, and the deadline + `503` path keeps the 500ms promise even when the DB misbehaves.
- **Leases + fencing tokens** instead of long-held row locks or transactions. Nothing holds a connection for 30s. Crash recovery is automatic, and a slow or stale worker can't double-complete a job.
- **Delivery vs processing semantics.** Webhooks are deduplicated exactly once, and state transitions happen exactly once. The external side effect is at-least-once in the rare case where a worker dies mid-call. In production I'd send `transaction_id` as the idempotency key to the downstream API so that case is harmless too.
- **`NUMERIC(20,4)` for money** and currency-aware decimal validation, so no floating-point drift is ever stored.
- **No extra test frameworks.** Tests use `node:test` and run against real Postgres through `embedded-postgres`, so `npm test` works without Docker.

### Database design review

I checked the schema and SQL against Supabase's [Postgres best-practices rules](https://github.com/supabase/agent-skills). The code follows them for data types (`text`, `timestamptz`, `numeric`), atomic upserts, the `SKIP LOCKED` claim-and-update queue, short transactions with no lock held across the external call, a partial index on the status the worker scans, unnamed prepared statements, and statement and idle-in-transaction timeouts. Where it deliberately differs:

- **Natural primary key (`transaction_id TEXT`) instead of `bigint identity`.** Every lookup and the idempotency check go by `transaction_id`. A surrogate key would add a second index without speeding up any query.
- **No `FORCE ROW LEVEL SECURITY`.** The service connects as the table owner and the tables have no policies, so forcing RLS would lock the service out. RLS is there to shut out Supabase's API roles.
- **No `idle_session_timeout`.** The API pool is deliberately kept warm (10 connections, a fixed bound) so webhooks never wait for a new connection.
- **Next step: a least-privilege role.** The service currently connects as `postgres`. In production I'd run migrations as `postgres` and the service as its own login role with only `SELECT, INSERT, UPDATE` on `transactions`, so a leaked `DATABASE_URL` couldn't drop tables or read other schemas. It would also get its own session-pool quota.

## Project layout

```
src/
  server.js       boot, migrations, worker start, graceful shutdown
  app.js          Fastify routes, parsing, error mapping
  validation.js   payload rules
  repository.js   all SQL (idempotent insert, claim/lease, fenced completion)
  worker.js       background processor (concurrency, retries, timeouts, recovery)
  processor.js    simulated 30s external call
  migrate.js      versioned, atomic migrations
  db.js           pools, TLS options, session settings
  config.js · signature.js · utils.js
migrations/       001 schema, 002 Supabase REST API lock-down
certs/            Supabase's public root CA (verifies the database's TLS certificate)
deploy/aws/       ec2-setup.sh (install / redeploy on Amazon Linux 2023)
test/             unit + integration tests
scripts/          smoke-test.js, local-db.js
render.yaml       alternative deployment on Render
.mcp.json         Supabase MCP server for AI tools (sign-in via OAuth, no secrets)
```
