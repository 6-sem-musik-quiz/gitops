// Run with: node --test loadtest/lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, pickEndpoint, httpUserName, durationMs, validateOptions } from './http-logic.js';

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

test('validateOptions accepts the defaults and rejects what would break the test', () => {
  const ok = { users: 20, rate: 60, rampUp: '1m', duration: '5m' };
  assert.equal(validateOptions(ok), null);
  assert.match(validateOptions({ ...ok, rate: 200 }), /RATE/);        // over 9 per user per second
  assert.match(validateOptions({ ...ok, users: 0 }), /USERS/);
  assert.match(validateOptions({ ...ok, rate: NaN }), /RATE/);
  assert.match(validateOptions({ ...ok, rampUp: '10m' }), /14 min/);  // tokens live 15 min
  assert.match(validateOptions({ ...ok, duration: '5 min' }), /DURATION/);
});
