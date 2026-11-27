// Run with: node --test loadtest/lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, pickEndpoint, httpUserName, durationMs, validateOptions, formatSummary } from './http-logic.js';

test('the weights add up to 100', () => {
  assert.equal(ENDPOINTS.reduce((sum, e) => sum + e.weight, 0), 100);
});

test('pickEndpoint follows the weights 40/25/20/15', () => {
  assert.equal(pickEndpoint(() => 0).name, 'weekly');
  assert.equal(pickEndpoint(() => 0.39).name, 'weekly');
  assert.equal(pickEndpoint(() => 0.40).name, 'my_stats');
  assert.equal(pickEndpoint(() => 0.65).name, 'my_user');
  assert.equal(pickEndpoint(() => 0.85).name, 'playlists');
  assert.equal(pickEndpoint(() => 0.999999).name, 'playlists'); // never undefined
});

test('every endpoint goes through the edge', () => {
  for (const e of ENDPOINTS) assert.match(e.path, /^\/api\/(statisticservice|userservice|musicservice)\//);
});

test('httpUserName gives loadbot_h1.. that the user regex and cleanup prefix accept', () => {
  assert.equal(httpUserName(0), 'loadbot_h1');
  assert.match(httpUserName(999), /^[A-Za-z0-9_]{3,20}$/);
  assert.ok(httpUserName(999).startsWith('loadbot_'));
});

test('durationMs reads k6 durations in m and s', () => {
  assert.equal(durationMs('90s'), 90_000);
  assert.equal(durationMs('1m'), 60_000);
  assert.equal(durationMs('2m30s'), 150_000);
  assert.throws(() => durationMs('abc'));
  assert.throws(() => durationMs(''));
});

test('formatSummary shows the settings, p95 per endpoint and whether the thresholds held', () => {
  const data = {
    metrics: {
      http_reqs: { values: { count: 1200, rate: 59.8 } },
      http_req_failed: { values: { rate: 0.002 }, thresholds: { 'rate<0.01': { ok: true } } },
      'http_req_duration{endpoint:weekly}': { values: { avg: 41.2, 'p(95)': 120.4, max: 300 }, thresholds: { 'p(95)<500': { ok: true } } },
      'http_req_duration{endpoint:my_user}': { values: { avg: 80, 'p(95)': 612.9, max: 900 }, thresholds: { 'p(95)<500': { ok: false } } },
      rate_limited: { values: { count: 0 }, thresholds: { 'count==0': { ok: true } } },
    },
  };
  const text = formatSummary(data, { baseUrl: 'https://x', rate: 60, users: 20, rampUp: '1m', duration: '5m' });
  assert.match(text, /RATE 60\/s/);
  assert.match(text, /weekly\s+avg\s+41 ms\s+p95\s+120 ms\s+OK/);
  assert.match(text, /my_user\s+avg\s+80 ms\s+p95\s+613 ms\s+FAILED/);
  assert.match(text, /1200 requests \(59\.8\/s\)/);
  assert.match(text, /failed 0\.20 %/);
  assert.match(text, /Thresholds: FAILED/);
});

test('validateOptions accepts the defaults and rejects what would break the test', () => {
  const ok = { users: 20, rate: 60, rampUp: '1m', duration: '5m' };
  assert.equal(validateOptions(ok), null);
  assert.match(validateOptions({ ...ok, rate: 200 }), /RATE/);        // over 9 per user per second
  assert.match(validateOptions({ ...ok, users: 0 }), /USERS/);
  assert.match(validateOptions({ ...ok, rate: NaN }), /RATE/);
  assert.match(validateOptions({ ...ok, rampUp: '10m' }), /14 min/);  // tokens live 15 min
  assert.match(validateOptions({ ...ok, duration: '5 min' }), /DURATION/);
});
