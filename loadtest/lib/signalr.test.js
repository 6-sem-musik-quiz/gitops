// Run with: node --test loadtest/lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RS, MessageType, handshake, invocation, parseFrames, ping } from './signalr.js';

test('handshake asks for the JSON protocol, version 1', () => {
  assert.equal(handshake(), '{"protocol":"json","version":1}\x1e');
});

test('invocation ends with the record separator and carries target, arguments and id', () => {
  const frame = invocation('SubmitAnswer', ['g', 3, 2], '7');

  assert.ok(frame.endsWith(RS));
  assert.deepEqual(JSON.parse(frame.slice(0, -1)), {
    type: 1, invocationId: '7', target: 'SubmitAnswer', arguments: ['g', 3, 2],
  });
});

test('invocation without an id is fire-and-forget (no invocationId)', () => {
  const message = JSON.parse(invocation('Ready', ['g', 1]).slice(0, -1));

  assert.equal('invocationId' in message, false);
});

test('parseFrames splits several messages in one WebSocket frame and drops the empty tail', () => {
  const messages = parseFrames('{"type":6}\x1e{"type":1,"target":"RoundStarted","arguments":[{}]}\x1e');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, MessageType.Ping);
  assert.equal(messages[1].type, MessageType.Invocation);
  assert.equal(messages[1].target, 'RoundStarted');
});

test('parseFrames reads the empty handshake reply as an object without a type', () => {
  assert.deepEqual(parseFrames('{}\x1e'), [{}]);
});

test('ping is a type 6 message', () => {
  assert.deepEqual(JSON.parse(ping().slice(0, -1)), { type: 6 });
});
