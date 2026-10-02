import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

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
// Anything other than 200/429 (5xx, resets, timeouts) is an ERROR, tracked per
// phase and never mixed into "rejected" or into latency.
const warmupErrors = new Counter('warmup_errors');
const spreadErrors = new Counter('spread_errors');
const hotErrors = new Counter('hot_errors');
const burstErrors = new Counter('burst_errors');
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
    // The measured phases must be error-free (no 5xx / resets / timeouts).
    // Warm-up errors are reported but don't fail the run: cold start is
    // expected to be rough, and it's excluded from the measured numbers.
    spread_errors: ['count==0'],
    hot_errors: ['count==0'],
    burst_errors: ['count==0'],
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

const isDecision = (res) => res.status === 200 || res.status === 429;

// Per-VU counter so we log only the first couple of unexpected responses per
// scenario (enough to see what's failing without flooding the terminal).
const logged = {};
function noteError(res, counter) {
  counter.add(1);
  const name = exec.scenario.name;
  logged[name] = (logged[name] || 0) + 1;
  if (logged[name] <= 2) {
    console.error(
      `[${name}] unexpected response: status=${res.status} error="${res.error || ''}" ` +
        `code=${res.error_code || ''} body="${String(res.body || '').slice(0, 80)}"`
    );
  }
}

export function warmup() {
  const res = call(`warm-${Math.floor(Math.random() * 2000)}`);
  if (!isDecision(res)) noteError(res, warmupErrors);
}

export function spread() {
  const res = call(`client-${Math.floor(Math.random() * 2000)}`);
  if (!isDecision(res)) return noteError(res, spreadErrors);
  spreadLatency.add(res.timings.duration);
  if (res.status === 200) spreadOk.add(1);
  else spreadLimited.add(1);
}

export function hot() {
  const res = call(`hot-${RUN_ID}`);
  if (!isDecision(res)) return noteError(res, hotErrors);
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
  if (!isDecision(res)) return noteError(res, burstErrors);
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
  // Spread-phase drops only (the built-in metric also counts warm-up drops).
  const dropped = v('dropped_iterations{scenario:spread_load}', 'count');

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
  lines.push(`  achieved:  ${(spreadCount / 30).toFixed(0)} req/s   (${spreadCount} completed, ${dropped} dropped, ${v('spread_errors', 'count')} errors)`);
  lines.push(`  latency:   ${latency('spread_latency')}`);
  lines.push('');
  lines.push('Hot-client scenario  (50 concurrent VUs, ONE client, 30s)');
  lines.push(`  achieved:  ${(hotCount / 30).toFixed(0)} req/s   (each request runs the atomic Lua check; ${v('hot_errors', 'count')} errors)`);
  lines.push(`  latency:   ${latency('hot_latency')}`);
  lines.push(`  ${check('correctness', v('hot_allowed', 'count'), window('hot_allowed_ts'))}`);
  lines.push('');
  lines.push(`Burst scenario  (500 requests, 50 VUs, one fresh client; ${v('burst_errors', 'count')} errors)`);
  lines.push(`  ${check('correctness', v('burst_allowed', 'count'), window('burst_allowed_ts'))}`);
  lines.push('');
  lines.push(
    `Errors (non-200/429) by phase: warm-up ${v('warmup_errors', 'count')}, throughput ${v('spread_errors', 'count')}, ` +
      `hot ${v('hot_errors', 'count')}, burst ${v('burst_errors', 'count')}   ` +
      `(all phases: ${v('http_req_failed', 'passes')} failed of ${v('http_reqs', 'count')} requests)`
  );
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