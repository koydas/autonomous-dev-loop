import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIncludeFile, filterDiff, truncateContextLines, cutDiffAtBoundary, stripDiffCutMarker, DIFF_CUT_MARKER_PREFIX } from '../lib/file_filters.mjs';

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

test('filterDiff truncates to maxChars, never inside a line', () => {
  const big = 'x'.repeat(5000);
  const result = filterDiff(big, 100);
  assert.ok(result.length <= 100);
  assert.equal(result, '… [diff cut: 1 more line not shown]', 'a single line over the cap is left out whole');
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

// cutDiffAtBoundary — #219: a cut ends on a whole line, preferably a hunk, with a marker naming what is left out

const file = (path, ...hunks) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`;
const TWO_FILES = `${file('.github/workflows/test.yml',
  '@@ -280,2 +280,6 @@ jobs:\n             node --test a.test.mjs\n \n+      - name: Check trace_context coverage (≥80%)\n+        run: npx c8 node --test b.test.mjs',
  '@@ -300,1 +304,2 @@ jobs:\n       - uses: actions/checkout@v4\n+      - run: npm run lint')}\n${file('scripts/lib/b.mjs', '@@ -0,0 +1,2 @@\n+export const b = 1;\n+export const c = 2;')}\n`;
const kept = (out) => out.split('\n').slice(0, -1).join('\n');
const markerOf = (out) => out.split('\n').at(-1);

test('cutDiffAtBoundary returns the diff unchanged when it fits, cut or not on an exact boundary', () => {
  assert.equal(cutDiffAtBoundary(TWO_FILES, TWO_FILES.length), TWO_FILES);
  assert.equal(cutDiffAtBoundary(TWO_FILES, Infinity), TWO_FILES);
  assert.equal(cutDiffAtBoundary('', 0), '');
  assert.equal(cutDiffAtBoundary(undefined, 10), '');
});

test('cutDiffAtBoundary never ends inside a line: the kept part is a prefix of whole lines, within maxChars', () => {
  for (let max = 0; max < TWO_FILES.length; max++) {
    const out = cutDiffAtBoundary(TWO_FILES, max);
    assert.ok(out.length <= max, `max ${max}: ${out.length} chars`);
    if (!out) continue;
    assert.ok(markerOf(out).startsWith(DIFF_CUT_MARKER_PREFIX), `max ${max}: no marker`);
    const prefix = kept(out);
    assert.ok(prefix === '' || TWO_FILES.startsWith(`${prefix}\n`), `max ${max}: not a whole-line prefix`);
    const last = prefix.split('\n').at(-1);
    assert.ok(prefix === '' || /^[+\- ]/.test(last) && !/^(\+\+\+|---) [ab]\//.test(last), `max ${max}: ends on a header line "${last}"`);
    assert.doesNotMatch(out, /\n\+ +- n\n/, `max ${max}: the step name of #219 is never cut`);
  }
});

test('cutDiffAtBoundary prefers the hunk boundary and names the partly shown and the unseen files', () => {
  const firstHunkEnd = TWO_FILES.indexOf('\n@@ -300');
  const marker = '… [diff cut: 10 more lines not shown, in .github/workflows/test.yml (partly shown), scripts/lib/b.mjs]';
  // Room for the first hunk, the marker and a few chars of the second hunk: the cut is on the hunk boundary.
  const out = cutDiffAtBoundary(TWO_FILES, firstHunkEnd + 1 + marker.length + 30);
  assert.equal(kept(out), TWO_FILES.slice(0, firstHunkEnd));
  assert.equal(markerOf(out), marker);
  const onFileBoundary = TWO_FILES.indexOf('\ndiff --git a/scripts/lib/b.mjs');
  const second = cutDiffAtBoundary(TWO_FILES, onFileBoundary + 80);
  assert.equal(kept(second), TWO_FILES.slice(0, onFileBoundary), 'a cut exactly on a file boundary keeps the whole first file');
  assert.equal(markerOf(second), '… [diff cut: 7 more lines not shown, in scripts/lib/b.mjs]');
});

test('cutDiffAtBoundary falls back to a line boundary inside one huge hunk, never on its header', () => {
  const body = Array.from({ length: 400 }, (_, i) => `+const v${i} = ${i};`).join('\n');
  const big = file('src/big.js', `@@ -0,0 +1,400 @@\n${body}`);
  const out = cutDiffAtBoundary(big, 3000);
  assert.ok(out.length <= 3000);
  assert.match(kept(out), /\n\+const v\d+ = \d+;$/, 'cut between two lines of the hunk');
  assert.match(markerOf(out), /^… \[diff cut: \d+ more lines not shown, in src\/big\.js \(partly shown\)\]$/);
  const shownLines = kept(out).split('\n').length;
  assert.equal(markerOf(out), `… [diff cut: ${big.split('\n').length - shownLines} more lines not shown, in src/big.js (partly shown)]`);
  // Too small for the header and one line: only the marker, never a header without a line under it.
  const tiny = cutDiffAtBoundary(big, 140);
  assert.equal(tiny, '… [diff cut: 405 more lines not shown, in src/big.js]');
});

test('cutDiffAtBoundary drops a single line too long for the budget whole, and returns "" when not even the marker fits', () => {
  const huge = file('src/min.js', `@@ -0,0 +1 @@\n+${'x'.repeat(20000)}`);
  assert.equal(cutDiffAtBoundary(huge, 12000), '… [diff cut: 6 more lines not shown, in src/min.js]');
  assert.equal(cutDiffAtBoundary(huge, 20), '');
});

test('cutDiffAtBoundary counts UTF-16 units and never splits a multi-byte character', () => {
  const diff = file('docs/a.md', `@@ -1 +1,3 @@\n+≥80% 🚀 ${'é'.repeat(50)}\n+🚀🚀🚀🚀🚀\n+fin`);
  for (let max = 60; max < diff.length; max++) {
    const out = cutDiffAtBoundary(diff, max);
    assert.ok(out.length <= max);
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `max ${max}: lone surrogate`);
    if (out) assert.ok(kept(out) === '' || diff.startsWith(`${kept(out)}\n`));
  }
});

test('cutDiffAtBoundary may end after a hunk-less header block (binary file, rename)', () => {
  const bin = 'diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nBinary files a/img.png and b/img.png differ';
  const diff = `${bin}\n${file('src/a.js', '@@ -1 +1 @@\n-a\n+b')}`;
  assert.equal(kept(cutDiffAtBoundary(diff, bin.length + 60)), bin);
});

test('cutDiffAtBoundary lists at most 5 files in the marker, then counts the rest', () => {
  const many = Array.from({ length: 8 }, (_, i) => file(`src/f${i}.js`, '@@ -1 +1 @@\n-a\n+b')).join('\n');
  const out = cutDiffAtBoundary(many, 300);
  assert.match(markerOf(out), /, in src\/f1\.js, src\/f2\.js, src\/f3\.js, src\/f4\.js, src\/f5\.js, 2 more files\]$/);
});

test('filterDiff cuts on a line boundary, with the marker, as cutDiffAtBoundary does', () => {
  const diff = file('src/a.js', `@@ -0,0 +1,2000 @@\n${Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join('\n')}`);
  const out = filterDiff(diff, 5000);
  assert.equal(out, cutDiffAtBoundary(diff, 5000));
  assert.match(markerOf(out), /in src\/a\.js \(partly shown\)\]$/);
});

test('stripDiffCutMarker removes only a trailing marker line', () => {
  const out = cutDiffAtBoundary(TWO_FILES, 200);
  assert.equal(stripDiffCutMarker(out), kept(out));
  assert.equal(stripDiffCutMarker('… [diff cut: 3 more lines not shown]'), '');
  assert.equal(stripDiffCutMarker(TWO_FILES), TWO_FILES, 'no marker');
  const quoted = '+const note = "… [diff cut: 1 more line not shown]";';
  assert.equal(stripDiffCutMarker(quoted), quoted, 'a marker quoted inside a diff line is content');
  const notLast = `x\n${DIFF_CUT_MARKER_PREFIX}1 more line not shown]\n+y`;
  assert.equal(stripDiffCutMarker(notLast), notLast, 'a marker line not at the end is content');
  assert.equal(stripDiffCutMarker(undefined), '');
});
