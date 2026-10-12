import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIncludeFile, filterDiff, truncateContextLines } from '../lib/file_filters.mjs';

// shouldIncludeFile

test('shouldIncludeFile accepts normal source files', () => {
  assert.ok(shouldIncludeFile('src/index.js'));
  assert.ok(shouldIncludeFile('scripts/lib/config.mjs'));
  assert.ok(shouldIncludeFile('README.md'));
});

test('shouldIncludeFile rejects node_modules paths', () => {
  assert.equal(shouldIncludeFile('node_modules/lodash/index.js'), false);
  assert.equal(shouldIncludeFile('packages/foo/node_modules/bar/index.js'), false);
});

test('shouldIncludeFile rejects dist paths', () => {
  assert.equal(shouldIncludeFile('dist/bundle.js'), false);
  assert.equal(shouldIncludeFile('packages/app/dist/main.js'), false);
});

test('shouldIncludeFile rejects lock files', () => {
  assert.equal(shouldIncludeFile('package-lock.json'), false);
  assert.equal(shouldIncludeFile('yarn.lock'), false);
  assert.equal(shouldIncludeFile('pnpm-lock.yaml'), false);
  assert.equal(shouldIncludeFile('Cargo.lock'), false);
});

test('shouldIncludeFile rejects empty string', () => {
  assert.equal(shouldIncludeFile(''), false);
});

// filterDiff

const DIFF_SRC = `diff --git a/src/index.js b/src/index.js
--- a/src/index.js
+++ b/src/index.js
@@ -1 +1 @@
-old
+new`;

const DIFF_NODE_MODULES = `diff --git a/node_modules/foo/index.js b/node_modules/foo/index.js
--- a/node_modules/foo/index.js
+++ b/node_modules/foo/index.js
@@ -1 +1 @@
-a
+b`;

const DIFF_LOCK = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{}
+{"x":1}`;

test('filterDiff keeps normal source files', () => {
  const result = filterDiff(DIFF_SRC);
  assert.ok(result.includes('src/index.js'));
});

test('filterDiff removes node_modules chunks', () => {
  const combined = DIFF_SRC + '\n' + DIFF_NODE_MODULES;
  const result = filterDiff(combined);
  assert.ok(result.includes('src/index.js'));
  assert.equal(result.includes('node_modules/foo'), false);
});

test('filterDiff removes lock file chunks', () => {
  const combined = DIFF_SRC + '\n' + DIFF_LOCK;
  const result = filterDiff(combined);
  assert.ok(result.includes('src/index.js'));
  assert.equal(result.includes('package-lock.json'), false);
});

test('filterDiff falls back to rawDiff when all chunks are filtered', () => {
  const result = filterDiff(DIFF_NODE_MODULES);
  assert.ok(result.includes('node_modules/foo'));
});

test('filterDiff truncates to maxChars', () => {
  const big = 'x'.repeat(5000);
  const result = filterDiff(big, 100);
  assert.equal(result.length, 100);
});

// truncateContextLines / context-line cut in filterDiff

const hunk = (file, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}`;
const plusMinus = (diff) => diff.split('\n').filter((l) => /^[+-]/.test(l));

test('filterDiff cuts a long context line to 200 chars with a visible marker', () => {
  const ctx = ` ${'c'.repeat(1499)}`;
  const result = filterDiff(hunk('CHANGELOG.md', `${ctx}\n+added`));
  assert.ok(result.includes(`${ctx.slice(0, 200)} …[+1300 chars]\n+added`));
  assert.equal(result.includes(ctx), false);
});

test('filterDiff leaves a short context line unchanged', () => {
  const diff = hunk('a.js', ' short context\n+added');
  assert.equal(filterDiff(diff), diff);
});

test('filterDiff never cuts long + or - lines', () => {
  const added = `+${'a'.repeat(2000)}`;
  const removed = `-${'r'.repeat(2000)}`;
  const diff = hunk('a.js', `${removed}\n${added}`);
  assert.equal(filterDiff(diff, Infinity), diff);
});

test('filterDiff never cuts headers, even when longer than the context limit', () => {
  const file = `dir/${'p'.repeat(300)}.js`;
  const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@ ${'h'.repeat(300)}\n-x\n+y`;
  assert.equal(filterDiff(diff, Infinity), diff);
});

test('filterDiff leaves a diff without context lines unchanged', () => {
  const diff = hunk('a.js', `-${'o'.repeat(500)}\n+${'n'.repeat(500)}`);
  assert.equal(filterDiff(diff, Infinity), diff);
});

test('filterDiff does not touch space-prefixed lines outside a hunk', () => {
  const text = ` ${'x'.repeat(500)}`;
  assert.equal(filterDiff(text, Infinity), text);
});

test('filterDiff honours a custom context line limit and skips cuts that would not shorten the line', () => {
  const long = ` ${'d'.repeat(209)}`;
  const nearLimit = ` ${'c'.repeat(59)}`; // 60 chars: 50 + marker would be longer than the original
  const result = filterDiff(hunk('a.js', `${long}\n${nearLimit}`), Infinity, 50);
  assert.ok(result.includes(`${long.slice(0, 50)} …[+160 chars]\n`));
  assert.ok(result.endsWith(`\n${nearLimit}`));
});

test('filterDiff cuts context before the maxChars cap (#186-shaped diff is no longer truncated)', () => {
  // #186: 14 changed lines, CHANGELOG context entries of 1–2k chars, the test file hunk last.
  const entry = (n) => ` - **Entry ${n}:** ${'Long changelog prose. '.repeat(70)}`;
  const raw = [
    hunk('CHANGELOG.md', [entry(1), entry(2), entry(3), '+- **New:** short entry', entry(4), entry(5), entry(6)].join('\n')),
    hunk('docs/code-generation.md', [entry(7), '+- new doc bullet', entry(8)].join('\n')),
    hunk('prompts/pr-review-system.md', ' context\n-old rule\n+new rule\n context'),
    hunk('scripts/tests/workflow_gates.test.mjs', [' ', "+test('gate', () => {", '+  assert.ok(true);', '+});'].join('\n')),
  ].join('\n');
  assert.ok(raw.length > 12000, `fixture too small: ${raw.length}`);
  const capped = filterDiff(raw);
  assert.ok(capped.length < 12000, `filtered diff too large: ${capped.length}`);
  assert.equal(capped, filterDiff(raw, Infinity), 'nothing cut by the cap → diff_truncated stays false');
  assert.deepEqual(plusMinus(capped), plusMinus(raw));
  assert.ok(capped.endsWith('+});'));
});
