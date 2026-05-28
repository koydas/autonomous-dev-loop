import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appendMetric, readMetrics, estimateTokens } from '../lib/metrics.mjs';

// --- estimateTokens ---

test('estimateTokens returns ceil(length/4) for a regular string', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('a'.repeat(12)), 3);
});

test('estimateTokens returns 0 for an empty string', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens treats null/undefined as empty string', () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

// --- appendMetric ---

test('appendMetric creates the metrics directory', async (t) => {
  const dirs = [];
  t.mock.method(fs, 'mkdir', async (p) => { dirs.push(p); });
  t.mock.method(fs, 'appendFile', async () => {});

  await appendMetric({ type: 'issue', issue_number: 1 });

  assert.ok(dirs.some((d) => d.endsWith('metrics')));
});

test('appendMetric writes a single JSON line followed by newline', async (t) => {
  t.mock.method(fs, 'mkdir', async () => {});
  let writtenContent;
  t.mock.method(fs, 'appendFile', async (_p, c) => { writtenContent = c; });

  const record = { type: 'issue', issue_number: 42, verdict: 'APPROVE' };
  await appendMetric(record);

  assert.ok(writtenContent.endsWith('\n'), 'line must end with newline');
  assert.deepEqual(JSON.parse(writtenContent.trim()), record);
});

test('appendMetric writes to a file named runs.jsonl inside the metrics dir', async (t) => {
  t.mock.method(fs, 'mkdir', async () => {});
  let writtenPath;
  t.mock.method(fs, 'appendFile', async (p) => { writtenPath = p; });

  await appendMetric({ type: 'pr' });

  assert.ok(String(writtenPath).endsWith('runs.jsonl'));
  assert.ok(String(writtenPath).includes('metrics'));
});

test('appendMetric propagates appendFile errors', async (t) => {
  t.mock.method(fs, 'mkdir', async () => {});
  const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  t.mock.method(fs, 'appendFile', async () => { throw err; });

  await assert.rejects(() => appendMetric({ type: 'issue' }), { code: 'ENOSPC' });
});

// --- readMetrics ---

test('readMetrics returns empty array when file does not exist', async (t) => {
  const notFound = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  t.mock.method(fs, 'readFile', async () => { throw notFound; });

  const result = await readMetrics();
  assert.deepEqual(result, []);
});

test('readMetrics parses every JSON line and returns them as objects', async (t) => {
  const r1 = { type: 'issue', issue_number: 1 };
  const r2 = { type: 'pr', pr_number: 5 };
  t.mock.method(fs, 'readFile', async () => `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);

  const result = await readMetrics();
  assert.deepEqual(result, [r1, r2]);
});

test('readMetrics skips blank lines', async (t) => {
  const r1 = { type: 'issue', issue_number: 3 };
  t.mock.method(fs, 'readFile', async () => `\n${JSON.stringify(r1)}\n\n`);

  const result = await readMetrics();
  assert.deepEqual(result, [r1]);
});

test('readMetrics rethrows non-ENOENT errors', async (t) => {
  const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readFile', async () => { throw err; });

  await assert.rejects(() => readMetrics(), { code: 'EACCES' });
});
