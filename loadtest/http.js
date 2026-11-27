// SCRUM-198: k6 HTTP load against the read-heavy endpoints, so the HPA scales up (SCRUM-196).
//
//   k6 run -e BOT_PASSWORD=... loadtest/http.js
//
// The game bots (bots.js, SCRUM-197) play real games but give too little CPU load to make the HPA react
// quickly. This script sends a fixed number of requests per second (ramping-arrival-rate), whatever the
// response time, so the result can be put in numbers: "at 60 requests/s p95 stayed under 500 ms while
// statisticservice went from 2 to 5 pods".
//
// Each test user logs in once in setup() and the token is reused: calls without a token count per IP at
// the edge (100 / 10 s), so logins cannot be the load. With a token the edge counts per user (100 / 10 s),
// with a ceiling of 1000 / 10 s per IP for everything from one machine, the game bots included.
//
// Env: BASE_URL (https://quiz.munkcloud.dk), BOT_PASSWORD (required, at least 8 characters),
//      USERS (20), RATE (60 requests/s), RAMP_UP (1m), DURATION (5m). See README.md.

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { ENDPOINTS, RAMP_DOWN, pickEndpoint, httpUserName, validateOptions, formatSummary } from './lib/http-logic.js';

const BASE_URL = (__ENV.BASE_URL || 'https://quiz.munkcloud.dk').replace(/\/$/, '');
const PASSWORD = __ENV.BOT_PASSWORD || '';
const USERS = Number(__ENV.USERS || 20);
const RATE = Number(__ENV.RATE || 60);
const RAMP_UP = __ENV.RAMP_UP || '1m';
const DURATION = __ENV.DURATION || '5m';
const INVALID = validateOptions({ users: USERS, rate: RATE, rampUp: RAMP_UP, duration: DURATION });

const thresholds = {
  http_req_failed: ['rate<0.01'],   // under 1 % errors
  rate_limited: ['count==0'],       // a 429 means we measured the edge's limit, not the services
};
for (const e of ENDPOINTS) thresholds[`http_req_duration{endpoint:${e.name}}`] = ['p(95)<500'];

export const options = {
  scenarios: {
    http: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Sane numbers even when the options are invalid: setup() aborts before any load is sent.
      preAllocatedVUs: INVALID ? 1 : Math.min(RATE, 50),
      maxVUs: INVALID ? 1 : RATE * 2,
      stages: INVALID ? [{ duration: '1s', target: 0 }] : [
        { duration: RAMP_UP, target: RATE },
        { duration: DURATION, target: RATE },
        { duration: RAMP_DOWN, target: 0 },
      ],
    },
  },
  thresholds,
  setupTimeout: '3m', // logins are spread out to stay under the edge's per-IP limit
};

const rateLimited = new Counter('rate_limited');

export function setup() {
  if (PASSWORD.length < 8)
    exec.test.abort('Set BOT_PASSWORD (at least 8 characters), e.g. k6 run -e BOT_PASSWORD=... http.js');
  if (INVALID) exec.test.abort(INVALID);
  console.log(`${RATE} requests/s with ${USERS} users against ${BASE_URL} (ramp-up ${RAMP_UP}, ${DURATION})`);

  const tokens = [];
  for (let i = 0; i < USERS; i++) {
    const userName = httpUserName(i);
    const body = { userName, password: PASSWORD };
    const created = post('/api/userservice/users', body);
    if (created.status !== 201 && created.status !== 409) // 409 = exists from an earlier run
      exec.test.abort(`create ${userName}: HTTP ${created.status} ${String(created.body).slice(0, 200)}`);
    const login = post('/api/userservice/auth/login', body);
    if (login.status !== 200)
      exec.test.abort(`login ${userName}: HTTP ${login.status} ${String(login.body).slice(0, 200)}`);
    tokens.push(login.json().accessToken);
  }
  return { tokens };
}

// Unauthenticated calls count per IP at the edge; when the game bots log in at the same time we can get
// 429, so wait for the next 10-second window and try again.
function post(path, body) {
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = http.post(BASE_URL + path, JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: path, phase: 'setup' },
    });
    if (res.status !== 429) return res;
    sleep(10);
  }
  return res;
}

// One iteration = one GET with one of the tokens, round-robin, on an endpoint chosen by weight.
export default function (data) {
  const token = data.tokens[exec.scenario.iterationInTest % data.tokens.length];
  const endpoint = pickEndpoint();
  const res = http.get(BASE_URL + endpoint.path, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: endpoint.path, endpoint: endpoint.name },
  });
  if (res.status === 429) rateLimited.add(1);
  check(res, { [`${endpoint.name} 200`]: (r) => r.status === 200 });
}

export function handleSummary(data) {
  const text = formatSummary(data, { baseUrl: BASE_URL, rate: RATE, users: USERS, rampUp: RAMP_UP, duration: DURATION });
  if (!data.metrics.iterations) return { stdout: text }; // aborted before any load: nothing worth keeping
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-') + 'Z'; // UTC
  return {
    stdout: text,
    [`loadtest/results/http-${stamp}.txt`]: text,
    [`loadtest/results/http-${stamp}.json`]: JSON.stringify(data, null, 2),
  };
}
