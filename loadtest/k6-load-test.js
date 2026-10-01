import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8080';
// Unique per run so the hot client's bucket always starts full.
const RUN_ID = __ENV.RUN_ID || 'local';

const spreadOk = new Counter('spread_allowed');
const spreadLimited = new Counter('spread_rejected');
const hotOk = new Counter('hot_allowed');
const hotLimited = new Counter('hot_rejected');

export const options = {
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    // Scenario 1: 500 req/s spread over 2000 client IDs, so each client
    // averages 0.25 req/s and stays well under its 1 token/s refill.
    spread_load: {
      executor: 'constant-arrival-rate',
      rate: 500,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: 'spread',
    },
    // Scenario 2: 50 concurrent users all hitting ONE client for 30s.
    // Starts after scenario 1 finishes so the two don't compete.
    hot_client: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
      startTime: '35s',
      exec: 'hot',
    },
  },
};

export function spread() {
  const client = `client-${Math.floor(Math.random() * 2000)}`;
  const res = http.get(`${BASE}/api/resource`, {
    headers: { 'X-Client-Id': client },
    tags: { scenario_name: 'spread' },
  });
  if (res.status === 200) spreadOk.add(1);
  else spreadLimited.add(1);
}

export function hot() {
  const res = http.get(`${BASE}/api/resource`, {
    headers: { 'X-Client-Id': `hot-${RUN_ID}` },
    tags: { scenario_name: 'hot' },
  });
  if (res.status === 200) hotOk.add(1);
  else hotLimited.add(1);
}