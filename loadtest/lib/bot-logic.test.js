// Run with: node --test loadtest/lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSlot, answerDelayMs, playAgainDelays, botName } from './bot-logic.js';

test('pickSlot can pick every slot 0..timelineLength', () => {
  assert.equal(pickSlot(3, () => 0), 0);
  assert.equal(pickSlot(1, () => 0.999), 1); // after the only card
  assert.equal(pickSlot(3, () => 0.999), 3);
});

test('answerDelayMs answers between 1 s and 2 s before the answer time runs out', () => {
  assert.equal(answerDelayMs(15, () => 0), 1000);
  assert.equal(answerDelayMs(15, () => 0.999999), 13000 - 1); // floor of just under 13 000
  assert.ok(answerDelayMs(15, () => 0.999999) < 13000);
});

test('playAgainDelays backs off, has jitter room, and gives up after at most 20 tries', () => {
  const delays = playAgainDelays(() => 0);

  assert.ok(delays.length >= 10 && delays.length <= 20);
  assert.equal(delays[0], 500);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]));
  assert.ok(delays.reduce((a, b) => a + b, 0) >= 15000); // the lobby has at least ~15 s to reopen
  assert.ok(playAgainDelays(() => 0.99)[0] > 500);         // jitter spreads the bots out
});

test('botName gives every bot of every VU its own valid user name', () => {
  assert.equal(botName(1, 0, 4), 'loadbot_1');
  assert.equal(botName(2, 0, 4), 'loadbot_5');
  assert.equal(botName(2, 3, 4), 'loadbot_8');
  assert.match(botName(9999, 7, 8), /^[A-Za-z0-9_]{3,20}$/);
});
