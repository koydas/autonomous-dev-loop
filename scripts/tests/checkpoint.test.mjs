import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeCheckpoint, readCheckpoint } from '../lib/checkpoint.mjs';

test('writeCheckpoint creates directory scoped to runId', async (t) => {
  const dirs = [];
  t.mock.method(fs, 'mkdir', async (p) => { dirs.push(p); });
  t.mock.method(fs, 'writeFile', async () => {});

  await writeCheckpoint('issue-42', 'validate', {});

  assert.ok(dirs.some((d) => d.includes('issue-42')));
});

test('writeCheckpoint writes step JSON to <runId>/<step>.json', async (t) => {
  let writtenPath, writtenContent;
  t.mock.method(fs, 'mkdir', async () => {});
  t.mock.method(fs, 'writeFile', async (p, c) => { writtenPath = p; writtenContent = c; });

  await writeCheckpoint('run-1', 'validate', { valid: true, score: 9 });

  assert.ok(writtenPath.includes('run-1'));
  assert.ok(writtenPath.endsWith('validate.json'));
  const parsed = JSON.parse(writtenContent);
  assert.equal(parsed.step, 'validate');
  assert.deepEqual(parsed.data, { valid: true, score: 9 });
});

test('writeCheckpoint includes ISO timestamp in written JSON', async (t) => {
  let writtenContent;
  t.mock.method(fs, 'mkdir', async () => {});
  t.mock.method(fs, 'writeFile', async (_, c) => { writtenContent = c; });

  const before = new Date().toISOString();
  await writeCheckpoint('run-1', 'generate', { outputPaths: ['a.js'] });
  const after = new Date().toISOString();

  const parsed = JSON.parse(writtenContent);
  assert.ok(typeof parsed.timestamp === 'string');
  assert.ok(parsed.timestamp >= before && parsed.timestamp <= after);
});

test('writeCheckpoint converts numeric runId to string in path', async (t) => {
  let writtenPath;
  t.mock.method(fs, 'mkdir', async () => {});
  t.mock.method(fs, 'writeFile', async (p) => { writtenPath = p; });

  await writeCheckpoint(42, 'review', {});

  assert.ok(writtenPath.includes('42'));
});

test('writeCheckpoint propagates mkdir errors', async (t) => {
  const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  t.mock.method(fs, 'mkdir', async () => { throw err; });

  await assert.rejects(() => writeCheckpoint('run-1', 'validate', {}), { code: 'ENOSPC' });
});

test('readCheckpoint returns parsed JSON on success', async (t) => {
  const stored = { step: 'validate', timestamp: '2025-01-01T00:00:00.000Z', data: { valid: true } };
  t.mock.method(fs, 'readFile', async () => JSON.stringify(stored));

  const result = await readCheckpoint('run-1', 'validate');
  assert.deepEqual(result, stored);
});

test('readCheckpoint returns null when file does not exist', async (t) => {
  const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  t.mock.method(fs, 'readFile', async () => { throw err; });

  const result = await readCheckpoint('run-1', 'missing');
  assert.equal(result, null);
});

test('readCheckpoint rethrows non-ENOENT errors', async (t) => {
  const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readFile', async () => { throw err; });

  await assert.rejects(() => readCheckpoint('run-1', 'validate'), { code: 'EACCES' });
});

test('readCheckpoint reads path scoped to runId and step', async (t) => {
  let readPath;
  t.mock.method(fs, 'readFile', async (p) => { readPath = p; return '{}'; });

  await readCheckpoint('pr-7', 'review');

  assert.ok(readPath.includes('pr-7'));
  assert.ok(readPath.endsWith('review.json'));
});
