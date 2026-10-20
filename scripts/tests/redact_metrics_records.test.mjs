// ADR-0040 amendment (audit F01/F06/F20): one-shot re-redaction of a `metrics` branch checkout.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findRecordFiles, redactRecordText, redactRunsJsonlText, redactMetricsDir, parseArgs, main } from '../redact_metrics_records.mjs';
import { redactTrace, BODY_OMITTED } from '../lib/run_record.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'redact_metrics_records.mjs');
const ORG_ID = 'org_01kp6a0jx3fq2v8w9z7y6t5r4s';
const BODY = `{"error":{"message":"Rate limit reached in organization \`${ORG_ID}\` service tier \`on_demand\`","code":"rate_limit_exceeded"}}`;
const MESSAGE = `groq: Groq API HTTP error 429: ${BODY}`;

// A record as stored before the amendment: llm_fallback.error and code_gen.skipped.detail published.
function legacyRecord(runId = '39193212735') {
  const record = redactTrace({
    schema_version: 1,
    envelope: { run_id: runId, run_attempt: 1, repository: 'owner/repo', issue_number: 7 },
    started_at: '2026-10-12T08:00:00.000Z',
    events: [
      { ts: '2026-10-12T08:00:01.000Z', stage: 'code_gen', event: 'llm_fallback', level: 'warn', meta: { from: 'groq', to: 'anthropic', error_type: 'TRANSIENT' } },
      { ts: '2026-10-12T08:00:02.000Z', stage: 'code_gen', event: 'code_gen.skipped', level: 'warn', meta: { reason: 'generation_blocked', source: 'model' } },
    ],
  });
  record.events[0].meta.error = MESSAGE.slice(0, 200);
  record.events[1].meta.detail = 'model blocked_reason';
  return record;
}
const cleanRecord = (runId = '1') => redactTrace({ schema_version: 1, envelope: { run_id: runId, run_attempt: 1, repository: 'owner/repo' }, events: [] });

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'metrics-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function put(rel, content) {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

test('findRecordFiles lists metrics/runs/**/*.json, sorted, and [] without a runs dir', () => {
  assert.deepEqual(findRecordFiles(dir), []);
  put('metrics/runs/2026-10/b-1.json', '{}');
  put('metrics/runs/2026-09/a-1.json', '{}');
  put('metrics/runs/2026-10/notes.txt', 'x');
  put('metrics/traces/t.json', '{}');
  assert.deepEqual(findRecordFiles(dir), ['metrics/runs/2026-09/a-1.json', 'metrics/runs/2026-10/b-1.json']);
});

test('findRecordFiles rethrows a read error other than ENOENT', () => {
  put('metrics/runs', 'a file, not a directory');
  assert.throws(() => findRecordFiles(dir), /ENOTDIR/);
});

test('redactRecordText drops the provider body and the model detail, and keeps a clean record as is', () => {
  const { content, redacted } = redactRecordText(`${JSON.stringify(legacyRecord())}\n`);
  assert.ok(!content.includes('org_01kp6a0j') && !content.includes('on_demand') && !content.includes('model blocked_reason'));
  assert.equal(redacted, 2);
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed.events[0].meta, { from: 'groq', to: 'anthropic', error_type: 'TRANSIENT' });
  const clean = JSON.stringify(cleanRecord(), null, 2);
  assert.deepEqual(redactRecordText(clean), { content: clean, redacted: 0 }, 'formatting kept when nothing changes');
});

test('redactRecordText throws on invalid JSON and on JSON that is not a run record', () => {
  assert.throws(() => redactRecordText('{nope'), SyntaxError);
  assert.throws(() => redactRecordText('{"schema_version":9}'), /not a run record/);
});

test('redactRunsJsonlText sanitizes error strings, keeps clean, blank and non-JSON lines byte for byte', () => {
  const clean = '{"type":"issue","run_id":"1-1","score":80}';
  const dirty = JSON.stringify({ type: 'issue', run_id: '2-1', error: MESSAGE });
  const text = `${clean}\n${dirty}\n\nnot json\n`;
  const { content, redacted, invalid } = redactRunsJsonlText(text);
  assert.equal(invalid, 1);
  assert.equal(redacted, 1);
  const lines = content.split('\n');
  assert.equal(lines[0], clean);
  assert.deepEqual(JSON.parse(lines[1]), { type: 'issue', run_id: '2-1', error: `groq: Groq API HTTP error 429 ${BODY_OMITTED}` });
  assert.deepEqual(lines.slice(2), ['', 'not json', '']);
  assert.deepEqual(redactRunsJsonlText(`${clean}\n`), { content: `${clean}\n`, redacted: 0, invalid: 0 });
});

test('redactMetricsDir is a dry run by default: reports, never writes', () => {
  const dirtyFile = put('metrics/runs/2026-10/39193212735-1.json', `${JSON.stringify(legacyRecord())}\n`);
  put('metrics/runs/2026-10/1-1.json', `${JSON.stringify(cleanRecord())}\n`);
  const jsonl = put('metrics/runs.jsonl', `${JSON.stringify({ run_id: '3-1', error: MESSAGE })}\n`);
  const before = [readFileSync(dirtyFile, 'utf8'), readFileSync(jsonl, 'utf8')];
  const report = redactMetricsDir(dir);
  assert.deepEqual(report.changed, [{ path: 'metrics/runs/2026-10/39193212735-1.json', redacted: 2 }, { path: 'metrics/runs.jsonl', redacted: 1 }]);
  assert.equal(report.scanned, 3);
  assert.equal(report.redacted, 3);
  assert.deepEqual(report.unreadable, []);
  assert.deepEqual([readFileSync(dirtyFile, 'utf8'), readFileSync(jsonl, 'utf8')], before);
});

test('redactMetricsDir --write rewrites only the changed files, and a second pass finds nothing', () => {
  const dirtyFile = put('metrics/runs/2026-10/38848182099-1.json', `${JSON.stringify(legacyRecord('38848182099'))}\n`);
  const cleanText = `${JSON.stringify(cleanRecord())}\n`;
  const cleanFile = put('metrics/runs/2026-10/1-1.json', cleanText);
  redactMetricsDir(dir, { write: true });
  assert.ok(!readFileSync(dirtyFile, 'utf8').includes(ORG_ID));
  assert.equal(readFileSync(cleanFile, 'utf8'), cleanText);
  assert.deepEqual(redactMetricsDir(dir, { write: true }).changed, []);
});

test('redactMetricsDir skips and lists invalid JSON, non-records, symlinks and unreadable files; a missing runs.jsonl is fine', () => {
  put('metrics/runs/2026-10/bad.json', '{oops');
  put('metrics/runs/2026-10/other.json', '{"schema_version":42}');
  const target = put('outside.json', `${JSON.stringify(legacyRecord())}\n`);
  symlinkSync(target, path.join(dir, 'metrics/runs/2026-10/link.json'));
  mkdirSync(path.join(dir, 'metrics/runs/2026-10/dir.json'));
  const locked = put('metrics/runs/2026-10/locked.json', '{}');
  chmodSync(locked, 0o000);
  const report = redactMetricsDir(dir, { write: true });
  const reasons = Object.fromEntries(report.unreadable.map((u) => [path.basename(u.path), u.reason]));
  assert.equal(reasons['bad.json'], 'invalid JSON');
  assert.match(reasons['other.json'], /not a run record/);
  assert.equal(reasons['link.json'], 'symlink');
  assert.equal(reasons['dir.json'], 'not a regular file');
  // root reads any file: the EACCES branch only applies to an unprivileged runner.
  if (process.getuid?.() !== 0) assert.equal(reasons['locked.json'], 'EACCES');
  assert.ok(readFileSync(target, 'utf8').includes(ORG_ID), 'a symlink target is never rewritten');
  assert.deepEqual(report.changed, []);
});

test('redactMetricsDir never reads or writes through a symlinked directory: under metrics/runs, metrics/runs itself, or metrics/', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
  try {
    const legacy = `${JSON.stringify(legacyRecord())}\n`;
    mkdirSync(path.join(outside, 'runs', '2026-10'), { recursive: true });
    writeFileSync(path.join(outside, 'runs', '2026-10', 'x-1.json'), legacy);
    writeFileSync(path.join(outside, 'runs.jsonl'), `${JSON.stringify({ run_id: '3-1', error: MESSAGE })}\n`);
    // 1. A month directory that links out of the checkout.
    mkdirSync(path.join(dir, 'metrics/runs'), { recursive: true });
    symlinkSync(path.join(outside, 'runs', '2026-10'), path.join(dir, 'metrics/runs/2026-10'));
    let report = redactMetricsDir(dir, { write: true });
    assert.deepEqual(report.unreadable, [{ path: 'metrics/runs/2026-10/x-1.json', reason: 'symlink in path' }]);
    assert.deepEqual(report.changed, []);
    // 2. metrics/ itself linked out: runs/ and runs.jsonl both reached through it.
    rmSync(path.join(dir, 'metrics'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'metrics'));
    report = redactMetricsDir(dir, { write: true });
    assert.deepEqual(report.unreadable.map((u) => u.reason), ['symlink in path', 'symlink in path']);
    assert.deepEqual(report.changed, []);
    assert.equal(readFileSync(path.join(outside, 'runs', '2026-10', 'x-1.json'), 'utf8'), legacy, 'the outside file is untouched');
    assert.ok(readFileSync(path.join(outside, 'runs.jsonl'), 'utf8').includes(ORG_ID));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('redactMetricsDir works when the checkout path itself goes through a symlink', () => {
  put('metrics/runs/2026-10/39193212735-1.json', `${JSON.stringify(legacyRecord())}\n`);
  const alias = `${dir}-alias`;
  symlinkSync(dir, alias);
  try {
    assert.deepEqual(redactMetricsDir(alias).changed, [{ path: 'metrics/runs/2026-10/39193212735-1.json', redacted: 2 }]);
  } finally {
    rmSync(alias);
  }
});

test('redactMetricsDir lists a runs.jsonl that is not a regular file', () => {
  mkdirSync(path.join(dir, 'metrics/runs.jsonl'), { recursive: true });
  assert.deepEqual(redactMetricsDir(dir).unreadable, [{ path: 'metrics/runs.jsonl', reason: 'not a regular file' }]);
});

test('parseArgs: one directory, optional --write, usage error otherwise', () => {
  assert.deepEqual(parseArgs(['d']), { dir: 'd', write: false });
  assert.deepEqual(parseArgs(['--write', 'd']), { dir: 'd', write: true });
  for (const bad of [[], ['a', 'b'], ['--dry']]) assert.throws(() => parseArgs(bad), /Usage: node scripts\/redact_metrics_records\.mjs/);
});

test('main prints paths, counts and skips, never the redacted content', () => {
  put('metrics/runs/2026-10/39193212735-1.json', `${JSON.stringify(legacyRecord())}\n`);
  put('metrics/runs/2026-10/bad.json', '{oops');
  put('metrics/runs.jsonl', `{"run_id":"1-1"}\nnot json\n`);
  const out = [];
  main([dir], (l) => out.push(l));
  assert.deepEqual(out, [
    'would rewrite metrics/runs/2026-10/39193212735-1.json (2 redacted string(s))',
    'skipped metrics/runs/2026-10/bad.json (invalid JSON)',
    'metrics/runs.jsonl: 1 line(s) not JSON, kept as is',
    '3 file(s) scanned, 1 to rewrite, 2 redacted string(s) (dry run: pass --write to rewrite).',
  ]);
  const written = [];
  main([dir, '--write'], (l) => written.push(l));
  assert.equal(written[0], 'rewritten metrics/runs/2026-10/39193212735-1.json (2 redacted string(s))');
  assert.match(written.at(-1), /1 rewritten, 2 redacted string\(s\)\.$/);
  assert.ok(!out.concat(written).join('\n').includes('org_') && !out.concat(written).join('\n').includes('Rate limit'));
});

test('CLI: dry run exits 0 with the report; a usage error exits 1 on stderr', () => {
  put('metrics/runs/2026-10/39193212735-1.json', `${JSON.stringify(legacyRecord())}\n`);
  const ok = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /would rewrite metrics\/runs\/2026-10\/39193212735-1\.json/);
  assert.ok(!ok.stdout.includes(ORG_ID));
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage:/);
});
