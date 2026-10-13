import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEmittedEvents, extractDocumentedEvents, findUndocumentedEvents } from '../lib/event_docs.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'check_event_docs.mjs');

// --- extractEmittedEvents ---

test('extractEmittedEvents returns literal names in single, double or plain backtick quotes, once each', () => {
  const src = [
    "log({ stage: 'review', event: 'review.start', meta: {} });",
    'obsLog({ stage: "eval", event: "eval.complete" });',
    'log({ event: `trace_write_failed`, level: "warn" });',
    "log({ stage: 'review', event: 'review.start' });",
  ].join('\n');
  assert.deepEqual(extractEmittedEvents(src), ['review.start', 'eval.complete', 'trace_write_failed']);
});

test('extractEmittedEvents ignores dynamic names, non-literal values and non-event keys', () => {
  const src = [
    'obsLog({ stage, event: `${stage}.error` });',
    'body: JSON.stringify({ event: reviewEvent }),',
    "event: { type: 'string' },",
    "review_event: 'not.an_event',",
    "const x = { event: 'APPROVE' };",
  ].join('\n');
  assert.deepEqual(extractEmittedEvents(src), []);
});

test('extractEmittedEvents returns [] for empty or nullish source', () => {
  assert.deepEqual(extractEmittedEvents(''), []);
  assert.deepEqual(extractEmittedEvents(undefined), []);
});

// --- extractDocumentedEvents ---

test('extractDocumentedEvents reads the backticked first cell of table rows only', () => {
  const md = [
    '| Event | Level |',
    '|---|---|',
    '| `review.start`     | info |',
    '|`eval.error`| error |',
    'Prose mentioning `llm_fallback` is not a row.',
    '| info | `not.first_cell` |',
    '- `bullet.event` in a list',
  ].join('\n');
  assert.deepEqual([...extractDocumentedEvents(md)].sort(), ['eval.error', 'review.start']);
});

test('extractDocumentedEvents returns an empty set for empty or nullish markdown', () => {
  assert.equal(extractDocumentedEvents('').size, 0);
  assert.equal(extractDocumentedEvents(null).size, 0);
});

// --- findUndocumentedEvents ---

test('findUndocumentedEvents lists each missing event once, sorted, with every file that emits it', () => {
  const sources = [
    { path: 'scripts/b.mjs', content: "log({ event: 'zeta.start' }); log({ event: 'alpha.error' });" },
    { path: 'scripts/a.mjs', content: "log({ event: 'alpha.error' }); log({ event: 'documented.ok' });" },
  ];
  assert.deepEqual(findUndocumentedEvents(sources, '| `documented.ok` | info |'), [
    { event: 'alpha.error', files: ['scripts/b.mjs', 'scripts/a.mjs'] },
    { event: 'zeta.start', files: ['scripts/b.mjs'] },
  ]);
});

test('findUndocumentedEvents returns [] when every event is documented or nothing is emitted', () => {
  assert.deepEqual(findUndocumentedEvents([{ path: 'scripts/a.mjs', content: "log({ event: 'a.b' });" }], '| `a.b` | info |'), []);
  assert.deepEqual(findUndocumentedEvents([], ''), []);
  assert.deepEqual(findUndocumentedEvents([{ path: 'scripts/a.mjs', content: 'no events' }], ''), []);
});

// --- check_event_docs.mjs entrypoint ---

function makeRepo({ scripts = {}, doc }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-docs-'));
  for (const [p, content] of Object.entries(scripts)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), content);
  }
  if (doc !== undefined) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'observability.md'), doc);
  }
  return root;
}

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

test('check_event_docs passes when every emitted event has a row, ignoring scripts/tests and non-.mjs files', () => {
  const root = makeRepo({
    scripts: {
      'scripts/a.mjs': "log({ event: 'a.start' });",
      'scripts/lib/b.mjs': "log({ event: 'b.done' });",
      'scripts/tests/a.test.mjs': "log({ event: 'only_in_tests' });",
      'scripts/notes.md': "event: 'not.code'",
    },
    doc: '| `a.start` | info |\n| `b.done` | info |\n',
  });
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Event docs check passed \(2 scripts scanned\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check_event_docs fails and lists each undocumented event with the files that emit it', () => {
  const root = makeRepo({
    scripts: { 'scripts/a.mjs': "log({ event: 'a.start' }); log({ event: 'a.error' });", 'scripts/lib/b.mjs': "log({ event: 'a.error' });" },
    doc: '| `a.start` | info |\n',
  });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 event\(s\) emitted without a row in docs\/observability\.md/);
    assert.match(result.stderr, /- a\.error {2}\(scripts\/a\.mjs, scripts\/lib\/b\.mjs\)/);
    assert.doesNotMatch(result.stderr, /a\.start/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check_event_docs fails with a clear error when docs/observability.md is missing', () => {
  const root = makeRepo({ scripts: { 'scripts/a.mjs': "log({ event: 'a.start' });" } });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot read docs\/observability\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
