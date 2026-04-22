import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { log, error } from '../lib/logger.mjs';

test('log writes JSON with level info to stdout', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('test message');

  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'test message');
});

test('log includes extra data fields', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('event', { issueNumber: '42', model: 'llama' });

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'event');
  assert.equal(parsed.issueNumber, '42');
  assert.equal(parsed.model, 'llama');
});

test('log with no extra data produces only level and msg', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('simple');

  const parsed = JSON.parse(captured[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ['level', 'msg']);
});

test('error writes JSON with level error to stderr', (t) => {
  const captured = [];
  t.mock.method(console, 'error', (s) => captured.push(s));

  error('something failed');

  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.msg, 'something failed');
});

test('error includes extra data fields', (t) => {
  const captured = [];
  t.mock.method(console, 'error', (s) => captured.push(s));

  error('request failed', { status: 500 });

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.status, 500);
});

test('log output is valid JSON', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('msg with "quotes" and special chars: <>&');

  assert.doesNotThrow(() => JSON.parse(captured[0]));
});
