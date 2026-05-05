import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { log, error, setLogContext, logStart, logEnd, logSummary } from '../lib/logger.mjs';

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

test('log with number payload preserves value under data key', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('number', 42);

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.data, 42);
});

test('log with null payload preserves null under data key', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('null', null);

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.data, null);
});

test('log with string payload preserves value under data key', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('string', 'hello');

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.data, 'hello');
});

test('log output is valid JSON', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  log('msg with "quotes" and special chars: <>&');

  assert.doesNotThrow(() => JSON.parse(captured[0]));
});

test('log does not throw on circular reference data', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  const circ = {};
  circ.self = circ;

  assert.doesNotThrow(() => log('circular', circ));
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'circular');
  assert.equal(parsed.self.self, '[Circular]');
});

test('error does not throw on circular reference data', (t) => {
  const captured = [];
  t.mock.method(console, 'error', (s) => captured.push(s));

  const circ = {};
  circ.self = circ;

  assert.doesNotThrow(() => error('circular', circ));
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.msg, 'circular');
  assert.equal(parsed.self.self, '[Circular]');
});

test('setLogContext propagates fields into log output', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  setLogContext({ run_id: 'abc123', step: 'auto-fix' });
  log('test message');
  setLogContext({});

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.run_id, 'abc123');
  assert.equal(parsed.step, 'auto-fix');
  assert.equal(parsed.msg, 'test message');
});

test('setLogContext propagates fields into error output', (t) => {
  const captured = [];
  t.mock.method(console, 'error', (s) => captured.push(s));

  setLogContext({ run_id: 'xyz789' });
  error('something bad');
  setLogContext({});

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.run_id, 'xyz789');
  assert.equal(parsed.level, 'error');
});

test('log call data overrides context field with same key', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  setLogContext({ step: 'from-context' });
  log('msg', { step: 'from-call' });
  setLogContext({});

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.step, 'from-call');
});

test('logSummary emits level info with msg run_summary', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  logSummary({ success: true, stepsCompleted: ['diff', 'llm'], errors: [] });

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'run_summary');
});

test('logSummary includes success, stepsCompleted, and errors fields', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  logSummary({ success: false, stepsCompleted: ['labels'], errors: ['network timeout'] });

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.stepsCompleted, ['labels']);
  assert.deepEqual(parsed.errors, ['network timeout']);
});

test('logEnd emits step_end with measured duration', (t) => {
  const captured = [];
  t.mock.method(console, 'log', (s) => captured.push(s));

  logStart('fetch');
  logEnd('fetch', 'ok');

  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.msg, 'step_end');
  assert.equal(parsed.step, 'fetch');
  assert.equal(parsed.result, 'ok');
  assert.ok(typeof parsed.durationMs === 'number', 'durationMs should be a number');
  assert.ok(parsed.durationMs >= 0);
});
