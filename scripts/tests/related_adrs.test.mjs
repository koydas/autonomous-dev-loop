import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAdr, findRelatedAdrs, formatRelatedAdrsContext, DEFAULT_EXCERPT_CHARS } from '../lib/related_adrs.mjs';

const adr = ({ title = 'A decision', status = 'Accepted', decision = 'We decided X.', body = '' } = {}) =>
  `# ADR-0000: ${title}\n\n- **Date:** 2026-01-01\n- **Status:** ${status}\n\n## Context\n\n${body}\n\n## Decision\n\n${decision}\n\n## Consequences\n\n- ✅ ok\n`;
const fileDiff = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
const repo = (files) => ({ listFiles: () => Object.keys(files), readFile: (p) => files[p] });
const silent = () => {};
const run = (rawDiff, files, extra = {}) => findRelatedAdrs({ rawDiff, ...repo(files), logFn: silent, ...extra });
const ids = (r) => r.map((a) => a.id);

// parseAdr

test('parseAdr reads id, title, status and the start of the Decision section', () => {
  const parsed = parseAdr('docs/adr/0012-x.md', adr({ title: 'Scoped coverage', decision: 'Line one.\n\n> quoted   rule' }));
  assert.deepEqual(parsed, {
    id: 'ADR-0012', number: '0012', path: 'docs/adr/0012-x.md', title: 'Scoped coverage', status: 'Accepted', supersededBy: null,
    decisionExcerpt: 'Line one. > quoted rule',
  });
});

test('parseAdr cuts the excerpt to N chars with an ellipsis, and reads a Decision that ends the file', () => {
  const long = 'word '.repeat(200);
  assert.equal(parseAdr('docs/adr/0001-x.md', adr({ decision: long }), 20).decisionExcerpt, `${long.slice(0, 20).trimEnd()}…`);
  assert.equal(parseAdr('docs/adr/0001-x.md', adr({ decision: long })).decisionExcerpt.length, DEFAULT_EXCERPT_CHARS);
  assert.equal(parseAdr('docs/adr/0001-x.md', '# ADR-0001: T\n\n## Decision\n\nLast section.\n').decisionExcerpt, 'Last section.');
});

test('parseAdr tolerates a missing title, status and Decision section', () => {
  const parsed = parseAdr('docs/adr/0002-x.md', 'no structure');
  assert.deepEqual([parsed.title, parsed.status, parsed.supersededBy, parsed.decisionExcerpt], ['', '', null, '']);
});

test('parseAdr reads the superseding ADR of a Superseded status only', () => {
  assert.equal(parseAdr('docs/adr/0005-x.md', adr({ status: 'Superseded by [ADR-0025](./0025-y.md)' })).supersededBy, '0025');
  assert.equal(parseAdr('docs/adr/0005-x.md', adr({ status: 'Accepted — amended by [ADR-0022](./0022-y.md)' })).supersededBy, null);
});

// findRelatedAdrs

test('findRelatedAdrs returns the ADR citing a changed path, with id, title, status and excerpt', () => {
  const files = {
    'prompts/review.md': '',
    'docs/adr/0012-cov.md': adr({ title: 'Coverage', body: 'Changes `prompts/review.md`.', decision: 'Gate (c) policy.' }),
    'docs/adr/0013-other.md': adr({ body: 'Unrelated.' }),
  };
  assert.deepEqual(run(fileDiff('prompts/review.md'), files), [{ id: 'ADR-0012', title: 'Coverage', status: 'Accepted', decisionExcerpt: 'Gate (c) policy.' }]);
});

test('findRelatedAdrs matches a basename only when it is unique in the repo, as a whole token', () => {
  const files = {
    'scripts/lib/review.mjs': '',
    'scripts/lib/pr_review.mjs': '',
    'docs/README.md': '',
    'README.md': '',
    'docs/adr/0001-a.md': adr({ body: 'See review.mjs.' }),
    'docs/adr/0002-b.md': adr({ body: 'See pr_review.mjs only.' }),
    'docs/adr/0003-c.md': adr({ body: 'See README.md.' }),
  };
  assert.deepEqual(ids(run(fileDiff('scripts/lib/review.mjs') + fileDiff('docs/README.md'), files)), ['ADR-0001']);
});

test('findRelatedAdrs returns [] when no ADR cites a changed path, or the diff has no file', () => {
  const files = { 'src/a.js': '', 'docs/adr/0001-a.md': adr({ body: 'Mentions src/b.js.' }) };
  assert.deepEqual(run(fileDiff('src/a.js'), files), []);
  const failing = () => { throw new Error('must not be called'); };
  assert.deepEqual(findRelatedAdrs({ rawDiff: '', listFiles: failing, readFile: failing }), []);
});

test('findRelatedAdrs skips a Superseded or Deprecated ADR, and includes the ADR that supersedes it', () => {
  const files = {
    'config/models.yaml': '',
    'docs/adr/0005-old.md': adr({ status: 'Superseded by [ADR-0025](./0025-new.md)', body: 'Sets config/models.yaml.' }),
    'docs/adr/0006-dep.md': adr({ status: 'Deprecated', body: 'Also config/models.yaml.' }),
    'docs/adr/0025-new.md': adr({ title: 'New model', body: 'Nothing about the file.' }),
  };
  assert.deepEqual(ids(run(fileDiff('config/models.yaml'), files)), ['ADR-0025']);
});

test('findRelatedAdrs drops a superseded ADR whose successor is missing, inactive or changed by the diff', () => {
  const base = { 'config/models.yaml': '', 'docs/adr/0005-old.md': adr({ status: 'Superseded by ADR-0009', body: 'config/models.yaml' }) };
  assert.deepEqual(run(fileDiff('config/models.yaml'), base), []);
  const deprecated = { ...base, 'docs/adr/0009-x.md': adr({ status: 'Deprecated' }) };
  assert.deepEqual(run(fileDiff('config/models.yaml'), deprecated), []);
  const changed = { ...base, 'docs/adr/0009-x.md': adr() };
  assert.deepEqual(run(fileDiff('config/models.yaml') + fileDiff('docs/adr/0009-x.md'), changed), []);
});

test('findRelatedAdrs ranks by changed paths cited, then exact paths, then most recent', () => {
  const files = {
    'scripts/lib/a.mjs': '',
    'scripts/lib/b.mjs': '',
    'docs/adr/0001-both.md': adr({ body: 'scripts/lib/a.mjs and scripts/lib/b.mjs' }),
    'docs/adr/0002-basename.md': adr({ body: 'a.mjs' }),
    'docs/adr/0003-exact-old.md': adr({ body: 'scripts/lib/a.mjs' }),
    'docs/adr/0004-exact-new.md': adr({ body: 'scripts/lib/b.mjs' }),
  };
  assert.deepEqual(ids(run(fileDiff('scripts/lib/a.mjs') + fileDiff('scripts/lib/b.mjs'), files)), ['ADR-0001', 'ADR-0004', 'ADR-0003', 'ADR-0002']);
});

test('findRelatedAdrs ranks behavior-file citations above test-file citations, and ignores CHANGELOG.md', () => {
  const files = {
    'prompts/review.md': '',
    'scripts/tests/gates.test.mjs': '',
    'CHANGELOG.md': '',
    'docs/adr/0001-policy.md': adr({ body: 'prompts/review.md' }),
    'docs/adr/0002-tests.md': adr({ body: 'scripts/tests/gates.test.mjs' }),
    'docs/adr/0003-changelog.md': adr({ body: 'CHANGELOG.md' }),
  };
  const diff = fileDiff('prompts/review.md') + fileDiff('scripts/tests/gates.test.mjs') + fileDiff('CHANGELOG.md');
  assert.deepEqual(ids(run(diff, files)), ['ADR-0001', 'ADR-0002']);
});

test('findRelatedAdrs keeps the best rank when a successor is reached from several ADRs, and skips ADRs the diff changes', () => {
  const files = {
    'src/a.js': '',
    'src/b.js': '',
    'docs/adr/0001-old.md': adr({ status: 'Superseded by ADR-0003', body: 'src/a.js src/b.js' }),
    'docs/adr/0002-old.md': adr({ status: 'Superseded by ADR-0003', body: 'src/a.js' }),
    'docs/adr/0003-new.md': adr(),
    'docs/adr/0004-mid.md': adr({ body: 'src/b.js' }),
    'docs/adr/0005-edited.md': adr({ body: 'src/a.js src/b.js' }),
  };
  const diff = fileDiff('src/a.js') + fileDiff('src/b.js') + fileDiff('docs/adr/0005-edited.md');
  assert.deepEqual(ids(run(diff, files)), ['ADR-0003', 'ADR-0004']);
});

test('findRelatedAdrs passes the excerpt length through', () => {
  const files = { 'src/a.js': '', 'docs/adr/0001-a.md': adr({ body: 'src/a.js', decision: 'x'.repeat(50) }) };
  assert.equal(run(fileDiff('src/a.js'), files, { excerptChars: 10 })[0].decisionExcerpt, `${'x'.repeat(10)}…`);
});

test('findRelatedAdrs returns [] and logs a warn event when an ADR cannot be read', () => {
  const events = [];
  const result = findRelatedAdrs({
    rawDiff: fileDiff('src/a.js'),
    listFiles: () => ['src/a.js', 'docs/adr/0001-a.md'],
    readFile: () => { throw new Error('EIO'); },
    logFn: (e) => events.push(e),
  });
  assert.deepEqual(result, []);
  assert.deepEqual(events, [{ stage: 'review', event: 'review.related_adrs_error', level: 'warn', meta: { error: 'EIO' } }]);
});

test('findRelatedAdrs logs through observability by default when the listing fails', () => {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    assert.deepEqual(findRelatedAdrs({ rawDiff: fileDiff('src/a.js'), listFiles: () => { throw new Error('no git'); }, readFile: () => '' }), []);
  } finally {
    process.stderr.write = original;
  }
  assert.match(writes.join(''), /"event":"review\.related_adrs_error".*"level":"warn"/);
});

// formatRelatedAdrsContext

test('formatRelatedAdrsContext lists up to max ADRs and is empty when none or max is 0', () => {
  const adrs = ['0003', '0002', '0001'].map((n) => ({ id: `ADR-${n}`, title: `T${n}`, status: 'Accepted', decisionExcerpt: `D${n}` }));
  const ctx = formatRelatedAdrsContext(adrs, 2);
  assert.match(ctx, /^\n\n## Related ADRs\n/);
  assert.match(ctx, /- ADR-0003: T0003 \(Accepted\) — Decision: D0003\n- ADR-0002: T0002 \(Accepted\) — Decision: D0002$/);
  assert.equal(formatRelatedAdrsContext(adrs, 0), '');
  assert.equal(formatRelatedAdrsContext([], 3), '');
  assert.equal(formatRelatedAdrsContext(undefined, 3), '');
});

// Repository invariant: findRelatedAdrs() keys ADRs by number, so two files sharing a number would
// shadow each other in the review prompt (two concurrent PRs both taking the next free number).
test('every docs/adr/NNNN-*.md file has a distinct number', () => {
  const adrDir = fileURLToPath(new URL('../../docs/adr/', import.meta.url));
  const numbers = fs.readdirSync(adrDir).map((name) => name.match(/^(\d{4})-.+\.md$/)?.[1]).filter(Boolean);
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  assert.ok(numbers.length > 0);
  assert.deepEqual(duplicates, [], `duplicate ADR numbers: ${[...new Set(duplicates)].join(', ')}`);
});
