import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8080';
// Unique per run so the hot/burst clients' buckets always start full.
const RUN_ID = __ENV.RUN_ID || 'local';
// Target request rate for the throughput scenario (req/s).
const RATE = parseInt(__ENV.RATE || '500', 10);

// Must match the limiter's defaults (RateLimiterService): capacity 5, refill 1/s.
const CAPACITY = 5;
const REFILL_PER_SEC = 1;

// A rate limiter answering 429 is doing its job, not failing. Only treat
// other statuses (5xx, timeouts) as failed requests.
http.setResponseCallback(http.expectedStatuses(200, 429));

// ---------------------------------------------------------------------------
// Metrics. Latency is recorded per scenario so the numbers aren't blended
// across very different workloads (and so warm-up traffic is excluded).
// ---------------------------------------------------------------------------
const spreadLatency = new Trend('spread_latency', true);
const hotLatency = new Trend('hot_latency', true);
const spreadOk = new Counter('spread_allowed');
const spreadLimited = new Counter('spread_rejected');
const hotOk = new Counter('hot_allowed');
const hotLimited = new Counter('hot_rejected');
const burstOk = new Counter('burst_allowed');
const burstLimited = new Counter('burst_rejected');
// Wall-clock time (ms) of each ALLOWED hot/burst request. min/max of these
// give the real observation window, so the token-bucket invariant
//   allowed <= capacity + refill_rate * window
// can be checked exactly instead of eyeballing "about 35".
const hotAllowedTs = new Trend('hot_allowed_ts');
const burstAllowedTs = new Trend('burst_allowed_ts');

export const options = {
  summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    // Phase 0: ramp traffic up so the JVM (JIT), connection pools, the Redis
    // client and the ingress are warm before anything is measured. Cold-start
    // behaviour is real, but it's a different question from steady-state
    // latency and shouldn't be averaged into it. Warm-up requests are not
    // recorded in any of the custom metrics below.
    warmup: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      stages: [{ target: RATE, duration: '20s' }],
      preAllocatedVUs: 50,
      maxVUs: 300,
      exec: 'warmup',
    },
    // Phase 1: throughput/latency. RATE req/s spread over 2000 client ids, so
    // each client averages RATE/2000 req/s and stays under its refill rate.
    spread_load: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 100,
      maxVUs: 300,
      startTime: '25s',
      exec: 'spread',
    },
    // Phase 2: correctness under sustained contention. 50 concurrent users
    // hammer ONE client for 30s. Ceiling = capacity + 30s * refill = ~35.
    hot_client: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
      startTime: '60s',
      exec: 'hot',
    },
    // Phase 3: correctness under a pure burst. 500 requests from 50 VUs at a
    // fresh client, as fast as possible. Only the initial bucket (5) plus a
    // sliver of refill may get through -- no timing window to argue about.
    burst: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: 500,
      maxDuration: '15s',
      startTime: '95s',
      exec: 'burst',
    },
  },
  thresholds: {
    // Only 5xx / timeouts count as failures (429s are expected, see above).
    http_req_failed: ['rate<0.001'],
    // Throughput phase must actually sustain the target rate (<1% dropped).
    'dropped_iterations{scenario:spread_load}': [`count<${Math.ceil(RATE * 30 * 0.01)}`],
    // 5 initial tokens + 30s of refill = 35; +1 of slack for network jitter.
    hot_allowed: [`count<=${CAPACITY + 30 * REFILL_PER_SEC + 1}`],
    // 5 initial tokens, plus at most one refilled token if the burst takes >1s.
    burst_allowed: [`count>=${CAPACITY}`, `count<=${CAPACITY + 1}`],
  },
};

function call(clientId) {
  return http.get(`${BASE}/api/resource`, {
    headers: { 'X-Client-Id': clientId },
  });
}

export function warmup() {
  call(`warm-${Math.floor(Math.random() * 2000)}`);
}

export function spread() {
  const res = call(`client-${Math.floor(Math.random() * 2000)}`);
  spreadLatency.add(res.timings.duration);
  if (res.status === 200) spreadOk.add(1);
  else spreadLimited.add(1);
}

export function hot() {
  const res = call(`hot-${RUN_ID}`);
  hotLatency.add(res.timings.duration);
  if (res.status === 200) {
    hotOk.add(1);
    hotAllowedTs.add(Date.now());
  } else {
    hotLimited.add(1);
  }
}

export function burst() {
  const res = call(`burst-${RUN_ID}`);
  if (res.status === 200) {
    burstOk.add(1);
    burstAllowedTs.add(Date.now());
  } else {
    burstLimited.add(1);
  }
}

// ---------------------------------------------------------------------------
// End-of-test report: only the numbers worth quoting, with the invariant
// checks spelled out. (Replaces k6's default summary, so thresholds are
// printed here too; the exit code still reflects them.)
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const m = data.metrics;
  const v = (name, key) =>
    m[name] && m[name].values && m[name].values[key] !== undefined ? m[name].values[key] : 0;
  const ms = (x) => `${x.toFixed(1)}ms`;
  const latency = (name) =>
    `p50 ${ms(v(name, 'med'))}   p95 ${ms(v(name, 'p(95)'))}   p99 ${ms(v(name, 'p(99)'))}   max ${ms(v(name, 'max'))}`;

  const spreadCount = v('spread_allowed', 'count') + v('spread_rejected', 'count');
  const hotCount = v('hot_allowed', 'count') + v('hot_rejected', 'count');
  const dropped = m['dropped_iterations'] ? v('dropped_iterations', 'count') : 0;

  // Observation window of allowed requests, from client-side timestamps.
  const window = (tsMetric) => (v(tsMetric, 'max') - v(tsMetric, 'min')) / 1000;
  const check = (label, allowed, win) => {
    const ceiling = Math.floor(CAPACITY + REFILL_PER_SEC * win) + 1; // +1 jitter slack
    const ok = allowed <= ceiling;
    return `${label}: allowed ${allowed}, observation window ${win.toFixed(2)}s -> ceiling ${ceiling}  [${ok ? 'PASS' : 'FAIL'}]`;
  };

  const lines = [];
  lines.push('');
  lines.push(`=== Rate limiter load test  (target ${BASE}, RUN_ID ${RUN_ID}) ===`);
  lines.push('');
  lines.push(`Throughput scenario  (${RATE} req/s target, 2000 clients, 30s, after warm-up)`);
  lines.push(`  achieved:  ${(spreadCount / 30).toFixed(0)} req/s   (${spreadCount} completed, ${dropped} dropped)`);
  lines.push(`  latency:   ${latency('spread_latency')}`);
  lines.push('');
  lines.push('Hot-client scenario  (50 concurrent VUs, ONE client, 30s)');
  lines.push(`  achieved:  ${(hotCount / 30).toFixed(0)} req/s   (each request runs the atomic Lua check)`);
  lines.push(`  latency:   ${latency('hot_latency')}`);
  lines.push(`  ${check('correctness', v('hot_allowed', 'count'), window('hot_allowed_ts'))}`);
  lines.push('');
  lines.push('Burst scenario  (500 requests, 50 VUs, one fresh client)');
  lines.push(`  ${check('correctness', v('burst_allowed', 'count'), window('burst_allowed_ts'))}`);
  lines.push('');
  lines.push('Thresholds');
  for (const [name, metric] of Object.entries(m)) {
    if (!metric.thresholds) continue;
    for (const [expr, res] of Object.entries(metric.thresholds)) {
      const ok = typeof res === 'object' ? res.ok : !res;
      lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${expr}`);
    }
  }
  lines.push('');
  return { stdout: lines.join('\n') };
}