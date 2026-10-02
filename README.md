# Distributed Rate Limiter

A token-bucket rate limiter service: Spring Boot gateway endpoint, Redis for shared state, and an atomic Lua script so concurrent requests can never over-admit. Containerized, tested in CI, and deployed to Azure Container Apps.

**Live:** `https://rate-limiter-app.kindbeach-ca945a74.canadacentral.azurecontainerapps.io/api/resource` (send an `X-Client-Id` header; 200 when allowed, 429 when limited)

## How it works

- `GET /api/resource` identifies the caller by `X-Client-Id` and asks `RateLimiterService` for a token.
- Each client has a bucket in Redis (`ratelimit:{clientId}`, a hash of `tokens` + `timestamp`). Default: capacity 5, refill 1 token/s.
- The check-refill-consume step runs as a single Lua script (`src/main/resources/token_bucket.lua`), so it is atomic: no race between "read tokens" and "write tokens", even across app instances.
- The script reads the clock from Redis (`TIME`), not from the caller. See "A bug the load test found" below.
- Responses carry `X-RateLimit-Remaining`; limited requests get `429`.

## Stack

Java 21, Spring Boot 3, Redis 7 (Lua), JUnit 5 + JaCoCo, Docker (multi-stage), GitHub Actions, Azure Container Apps, k6.

## Testing and CI/CD

- Tests run against a real Redis (no mocks), including a 50-thread concurrency test asserting that exactly `capacity` requests are admitted from a single bucket.
- GitHub Actions (`.github/workflows/ci.yml`): `mvn verify` against a Redis service container, JaCoCo report uploaded as an artifact, then the image is built and pushed to GHCR on `main`.
- Deployment: `azure/containerapp.json` defines a two-container app (the service plus a Redis sidecar) in one replica.

## A bug the load test found

The first Azure load test admitted **72** requests for a single client whose bucket allows about **35** in the test window (5 initial tokens + 30 s at 1 token/s). Root cause: the refill timestamp was taken in Java and passed into the Lua script. Under load, requests reach Redis out of order; the script wrote the (older) timestamp back, so the same time interval was credited to the bucket twice. It only shows up when requests are delayed between "take timestamp" and "reach Redis" (a CPU-starved container), which is why it passed locally.

Reproduced against Redis 7 by injecting scheduling jitter: the old script admitted up to ~10x the ceiling; the fixed script stayed exactly at it. The fix moves the clock into the script (`redis.call("TIME")`), which also removes any dependence on clock skew between app instances. A JUnit concurrency test and an exact invariant check in the load test (`allowed <= capacity + refill * observed_window`) now guard against regressions.

## Load test

`loadtest/k6-load-test.js` runs four phases: a 20 s warm-up ramp (excluded from reported numbers), a throughput phase (500 req/s over 2,000 client IDs), a hot-client phase (50 concurrent VUs on one client), and a burst phase (500 requests at one fresh client). Latency is reported per phase. The correctness phases fail the run if the limiter ever admits more than the token-bucket bound.

```bash
docker run --rm -i \
  -e RUN_ID=$(date +%s) \
  -e BASE_URL=https://<your-app>.azurecontainerapps.io \
  grafana/k6 run - < loadtest/k6-load-test.js
```

### Results

Azure Container Apps, Canada Central, app container 1 vCPU / 2 GiB, Redis sidecar 0.25 vCPU / 0.5 GiB, one replica. k6 ran from a laptop over the public internet, so latencies include network round-trip.

| Phase | Result |
|---|---|
| Throughput (500 req/s target, 30 s, after 20 s warm-up) | 499 req/s sustained (14,968 completed, 33 dropped, 0 errors); p50 25.7 ms, p95 45.2 ms, p99 89.5 ms |
| Hot client (50 VUs on one client, 30 s) | ~1,230 req/s through the atomic Lua check; **34 admitted vs. a theoretical maximum of 34** (5 initial tokens + 29.0 s of refill); p95 64.2 ms |
| Burst (500 requests, 50 VUs, one fresh client) | **exactly 5 admitted** |

57,647 requests across all phases, 0 errors (anything other than 200/429). Single run; run-to-run variance is real (an earlier run started right after a deploy measured throughput-phase p95 of 106 ms).

## Known limitations

- Redis runs as an in-memory sidecar, so a container restart resets all buckets (clients briefly get fresh buckets).
- State is per replica (each replica has its own sidecar), so the app is pinned to one replica. Scaling out needs a shared Redis (e.g. Azure Cache for Redis); the Lua script already works unchanged against a shared instance.
- Client identity is an unauthenticated header; production would derive it from an API key or token.
- Requires Redis 5+ (the script calls `TIME` and then writes; Redis 7 is used).
