import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, findingCitedFiles, findUnreviewedCodeFiles, formatUnreviewedCodeNote, formatUnseenFindingsNote, orderDiffForReview, parseReviewVerdict, withholdOnUnreviewedCode } from '../lib/review_prompt.mjs';
import { cutDiffAtBoundary } from '../lib/file_filters.mjs';
import { assessEvidence } from '../lib/review_evidence.mjs';
import { estimateTokens } from '../lib/metrics.mjs';

const TEMPLATE = 'Title: {{issueTitle}}\nBody:\n{{issueBody}}\nDiff:\n{{diff}}';
const SYSTEM = 'system';
const MISSING = assessEvidence({ ok: false, reason: 'no evidence file' });

const fileDiff = (file, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}\n`;
const build = (overrides = {}) => buildReviewPrompt({
  systemPrompt: SYSTEM, userPromptTemplate: TEMPLATE, rawDiff: fileDiff('src/a.js', '+x'), prTitle: 'T', prBody: 'B', maxInputTokens: 6300, evidence: MISSING, ...overrides,
});

test('buildReviewPrompt renders the template then the classification, automation, dependency and evidence contexts in order', () => {
  const { userPrompt, diffTruncated, bodyTruncated } = build({ rawDiff: fileDiff('scripts/a.mjs', '+x'), dependencyManifestContext: '\n\nDEPS' });
  assert.match(userPrompt, /^Title: T\nBody:\nB\nDiff:\ndiff --git a\/scripts\/a\.mjs/);
  const order = ['Change classification context:', 'Automation gates context:', 'DEPS', '## Tool evidence'].map((s) => userPrompt.indexOf(s));
  assert.ok(order.every((i) => i > 0), `missing context: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.deepEqual([diffTruncated, bodyTruncated], [false, false]);
});

test('buildReviewPrompt filters lock files and node_modules out of the diff but classifies from the raw diff', () => {
  const raw = fileDiff('src/a.js', '+x') + fileDiff('package-lock.json', '+"lock": 1');
  const { userPrompt } = build({ rawDiff: raw });
  assert.doesNotMatch(userPrompt, /"lock": 1/);
  assert.match(userPrompt, /detected_categories: dependency_update/);
});

test('buildReviewPrompt shrinks the diff to the Groq budget and flags it', () => {
  const raw = fileDiff('src/a.js', '+x'.repeat(40000));
  const { userPrompt, diffTruncated } = build({ rawDiff: raw, maxInputTokens: 3000 });
  assert.equal(diffTruncated, true);
  assert.ok(estimateTokens(SYSTEM + userPrompt) <= 3000);
  assert.match(userPrompt, /- diff_truncated: true/);
});

test('buildReviewPrompt without a budget (Anthropic) caps the diff at 12,000 chars on a line boundary and flags it', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `+line ${String(i).padStart(4, '0')}`);
  const raw = fileDiff('src/a.js', lines.join('\n'));
  const { userPrompt, diffTruncated, unreviewedCodeFiles } = build({ rawDiff: raw, maxInputTokens: null });
  assert.equal(diffTruncated, true);
  const shown = userPrompt.slice(userPrompt.indexOf('diff --git'), userPrompt.indexOf(']', userPrompt.indexOf('… [diff cut: ')) + 1);
  assert.ok(shown.length <= 12000, `${shown.length} chars`);
  const kept = shown.split('\n').slice(0, -1);
  assert.ok(raw.startsWith(`${kept.join('\n')}\n`), 'the shown diff is a prefix of whole lines');
  assert.match(kept.at(-1), /^\+line \d{4}$/);
  assert.match(shown.split('\n').at(-1), new RegExp(`^… \\[diff cut: ${2004 - kept.length} more lines not shown, in src/a\\.js \\(partly shown\\)\\]$`));
  assert.deepEqual(unreviewedCodeFiles, ['src/a.js']);
});

test('buildReviewPrompt throws, without a prompt, when the fixed part alone is over budget', () => {
  assert.throws(() => build({ systemPrompt: 's'.repeat(40000), maxInputTokens: 1000 }), /review prompt is ~\d+ estimated input tokens/);
});

test('parseReviewVerdict accepts the heading, bold heading and inline forms, case-insensitive', () => {
  assert.equal(parseReviewVerdict('### 🚀 Verdict\nAPPROVED').verdict, 'APPROVED');
  assert.equal(parseReviewVerdict('**🚀 Verdict**\n\n**REQUEST_CHANGES**').verdict, 'REQUEST_CHANGES');
  assert.equal(parseReviewVerdict('**Verdict:** approved').verdict, 'APPROVED');
});

test('parseReviewVerdict strips <think> blocks before matching and trims the review', () => {
  const { cleanReview, verdict } = parseReviewVerdict('<think>Verdict: APPROVED?</think>\n  ### 🚀 Verdict\nREQUEST_CHANGES  ');
  assert.equal(verdict, 'REQUEST_CHANGES');
  assert.equal(cleanReview, '### 🚀 Verdict\nREQUEST_CHANGES');
});

test('parseReviewVerdict returns a null verdict when there is no verdict line', () => {
  assert.equal(parseReviewVerdict('### ⚠️ Issues Found\nNone.\n\n### 🚀').verdict, null);
  assert.equal(parseReviewVerdict('<think>Verdict: APPROVED</think>').verdict, null);
  assert.deepEqual(parseReviewVerdict(undefined), { cleanReview: '', verdict: null });
});

test('buildReviewPrompt does not report diff_truncated when only long context lines were shortened', () => {
  const ctx = ` ${'c'.repeat(3000)}`;
  const raw = Array.from({ length: 5 }, (_, i) => fileDiff(`docs/f${i}.md`, `${ctx}\n+x${i}`)).join('');
  assert.ok(raw.length > 12000);
  const { userPrompt, diffTruncated } = build({ rawDiff: raw, maxInputTokens: null });
  assert.equal(diffTruncated, false);
  assert.match(userPrompt, /diff_truncated: false/);
  assert.match(userPrompt, /…\[\+2801 chars\]/);
  assert.match(userPrompt, /\+x4/);
});

// ADR-0035 / ADR-0036: stale references and related ADRs in the review prompt

const ADRS = ['0031', '0030', '0029', '0028'].map((n) => ({ id: `ADR-${n}`, title: `Title ${n}`, status: 'Accepted', decisionExcerpt: `Decision ${n}.` }));

test('buildReviewPrompt adds the stale-reference context before the tool evidence', () => {
  const { userPrompt } = build({ rawDiff: fileDiff('scripts/a.mjs', '+x'), staleRefsContext: '\n\n## Stale references (deterministic text search)\n- hit' });
  const order = ['Automation gates context:', '## Stale references', '## Tool evidence'].map((s) => userPrompt.indexOf(s));
  assert.ok(order.every((i) => i > 0), `missing context: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('buildReviewPrompt shows up to 3 related ADRs without a token budget (Anthropic)', () => {
  const { userPrompt, adrCount } = build({ maxInputTokens: null, relatedAdrs: ADRS });
  assert.equal(adrCount, 3);
  assert.match(userPrompt, /## Related ADRs[\s\S]*ADR-0031[\s\S]*ADR-0030[\s\S]*ADR-0029/);
  assert.doesNotMatch(userPrompt, /ADR-0028/);
  assert.ok(userPrompt.indexOf('## Related ADRs') < userPrompt.indexOf('## Tool evidence'));
});

test('buildReviewPrompt shows one related ADR on the Groq budget when it fits with the diff uncut', () => {
  const { userPrompt, adrCount, diffTruncated, bodyTruncated } = build({ relatedAdrs: ADRS });
  assert.equal(adrCount, 1);
  assert.match(userPrompt, /ADR-0031: Title 0031 \(Accepted\) — Decision: Decision 0031\./);
  assert.doesNotMatch(userPrompt, /ADR-0030/);
  assert.deepEqual([diffTruncated, bodyTruncated], [false, false]);
});

test('buildReviewPrompt drops the related-ADR block first when the budget is tight, keeping the diff whole', () => {
  // Without ADRs the prompt fits exactly with the full diff; the ADR block would force a diff cut.
  const rawDiff = fileDiff('src/a.js', `+${'y'.repeat(4000)}`);
  const base = build({ rawDiff, maxInputTokens: null });
  const exact = estimateTokens(SYSTEM + base.userPrompt);
  const relatedAdrs = [{ ...ADRS[0], decisionExcerpt: 'z'.repeat(400) }];
  const { userPrompt, adrCount, diffTruncated, bodyTruncated } = build({ rawDiff, maxInputTokens: exact, relatedAdrs });
  assert.equal(adrCount, 0);
  assert.doesNotMatch(userPrompt, /## Related ADRs/);
  assert.match(userPrompt, /y{4000}/);
  assert.deepEqual([diffTruncated, bodyTruncated], [false, false]);
});

test('buildReviewPrompt drops the related-ADR block when its fixed part alone would be over budget', () => {
  const base = build({ maxInputTokens: null });
  const exact = estimateTokens(SYSTEM + base.userPrompt);
  const relatedAdrs = [{ ...ADRS[0], decisionExcerpt: 'z'.repeat(exact * 8) }];
  const { adrCount, userPrompt } = build({ maxInputTokens: exact, relatedAdrs });
  assert.equal(adrCount, 0);
  assert.doesNotMatch(userPrompt, /z{100}/);
});

test('buildReviewPrompt has no related-ADR block when nothing matched', () => {
  for (const maxInputTokens of [null, 6300]) {
    const { userPrompt, adrCount } = build({ maxInputTokens });
    assert.equal(adrCount, 0);
    assert.doesNotMatch(userPrompt, /## Related ADRs/);
  }
});

// --- Diff order for review (ADR-0034) ---

const filesOf = (diff) => [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);

test('orderDiffForReview puts code first, then tests, then docs, keeping git order within each tier', () => {
  const raw = ['CHANGELOG.md', 'scripts/tests/b.test.mjs', 'scripts/b.mjs', 'docs/evals.md', '.github/workflows/x.yml', 'scripts/tests/a.test.mjs']
    .map((f) => fileDiff(f, `+${f}`)).join('');
  assert.deepEqual(filesOf(orderDiffForReview(raw)), [
    'scripts/b.mjs', '.github/workflows/x.yml', 'scripts/tests/b.test.mjs', 'scripts/tests/a.test.mjs', 'CHANGELOG.md', 'docs/evals.md',
  ]);
});

test('orderDiffForReview keeps prompts and docs/code-generation.md with the code (automation scope)', () => {
  const raw = ['README.md', 'docs/code-generation.md', 'prompts/pr-review-system.md'].map((f) => fileDiff(f, '+x')).join('');
  assert.deepEqual(filesOf(orderDiffForReview(raw)), ['docs/code-generation.md', 'prompts/pr-review-system.md', 'README.md']);
});

test('orderDiffForReview keeps every hunk, a leading preamble, and the trailing newline (or its absence)', () => {
  const raw = `preamble\n${fileDiff('docs/a.md', '+doc')}${fileDiff('src/a.js', '+code')}`;
  const ordered = orderDiffForReview(raw);
  assert.ok(ordered.startsWith('preamble\ndiff --git a/src/a.js'));
  assert.equal(ordered.length, raw.length);
  assert.ok(ordered.endsWith('+doc\n'));
  assert.equal(orderDiffForReview(raw.trimEnd()).endsWith('+doc'), true);
});

test('orderDiffForReview returns the input unchanged for one file, an empty diff and a nullish one', () => {
  const one = fileDiff('src/a.js', '+x');
  assert.equal(orderDiffForReview(one), one);
  assert.equal(orderDiffForReview(''), '');
  assert.equal(orderDiffForReview(undefined), '');
});

test('buildReviewPrompt cut to the budget drops the docs before the code and its tests', () => {
  const raw = fileDiff('docs/evals.md', '+'.padEnd(12000, 'd')) + fileDiff('scripts/a.mjs', '+code') + fileDiff('scripts/tests/a.test.mjs', '+test');
  const { userPrompt, diffTruncated } = build({ rawDiff: raw, maxInputTokens: 2000 });
  assert.equal(diffTruncated, true);
  assert.match(userPrompt, /\+code/);
  assert.match(userPrompt, /\+test/);
  assert.ok(userPrompt.indexOf('scripts/a.mjs') < userPrompt.indexOf('scripts/tests/a.test.mjs'));
  assert.ok(userPrompt.indexOf('scripts/tests/a.test.mjs') < userPrompt.indexOf('docs/evals.md'));
});

// --- ADR-0038: code the reviewer did not see withholds an approval ---

test('findUnreviewedCodeFiles lists the code files cut in part or in full, not the tests or docs', () => {
  const full = fileDiff('scripts/a.mjs', '+a') + fileDiff('scripts/b.mjs', '+b') + fileDiff('scripts/tests/a.test.mjs', '+t') + fileDiff('docs/x.md', '+d');
  const bStart = full.indexOf('diff --git a/scripts/b.mjs');
  assert.deepEqual(findUnreviewedCodeFiles(full, full.slice(0, bStart + 20)), ['scripts/b.mjs']);
  assert.deepEqual(findUnreviewedCodeFiles(full, full.slice(0, 10)), ['scripts/a.mjs', 'scripts/b.mjs']);
  assert.deepEqual(findUnreviewedCodeFiles(full, full.slice(0, bStart - 1)), ['scripts/b.mjs'], 'a.mjs is complete without its separator newline');
});

test('findUnreviewedCodeFiles returns [] when only tests or docs were cut, nothing was cut, or there is no diff', () => {
  const full = fileDiff('scripts/a.mjs', '+a') + fileDiff('scripts/tests/a.test.mjs', '+t') + fileDiff('docs/x.md', '+d');
  assert.deepEqual(findUnreviewedCodeFiles(full, full.slice(0, full.indexOf('diff --git a/scripts/tests') + 5)), []);
  assert.deepEqual(findUnreviewedCodeFiles(full, full), []);
  assert.deepEqual(findUnreviewedCodeFiles(full, full.replace(/\n$/, '')), [], 'a missing trailing newline is not a cut');
  assert.deepEqual(findUnreviewedCodeFiles('', ''), []);
  assert.deepEqual(findUnreviewedCodeFiles(undefined, undefined), []);
  assert.deepEqual(findUnreviewedCodeFiles('preamble without a file header', ''), [], 'a chunk without a header is not a file');
});

test('withholdOnUnreviewedCode withholds an APPROVE when code was cut, naming the files', () => {
  assert.deepEqual(
    withholdOnUnreviewedCode({ verdict: 'APPROVE', reason: null }, ['scripts/a.mjs', 'scripts/b.mjs']),
    { verdict: 'WITHHELD', reason: 'code cut from the reviewed diff: scripts/a.mjs, scripts/b.mjs' },
  );
});

test('withholdOnUnreviewedCode passes any other decision, or an approval of a complete diff, through unchanged', () => {
  const approve = { verdict: 'APPROVE', reason: null };
  assert.equal(withholdOnUnreviewedCode(approve, []), approve);
  assert.equal(withholdOnUnreviewedCode(approve), approve);
  const changes = { verdict: 'REQUEST_CHANGES', reason: 'failing checks: tests' };
  assert.equal(withholdOnUnreviewedCode(changes, ['scripts/a.mjs']), changes);
  const withheld = { verdict: 'WITHHELD', reason: 'evidence stale: head moved' };
  assert.equal(withholdOnUnreviewedCode(withheld, ['scripts/a.mjs']), withheld, 'the evidence reason is kept');
});

test('formatUnreviewedCodeNote names each file and says auto-fix is not triggered', () => {
  const note = formatUnreviewedCodeNote(['scripts/a.mjs', 'config/models.yaml']);
  assert.match(note, /^\n> \*\*Approval withheld\*\* — the diff was cut to the token budget/);
  assert.match(note, /`scripts\/a\.mjs`, `config\/models\.yaml`/);
  assert.match(note, /auto-fix is not triggered/);
});

test('buildReviewPrompt reports the code files cut to the Groq budget, and none when only docs were cut', () => {
  const codeCut = build({ rawDiff: fileDiff('scripts/a.mjs', '+'.padEnd(40000, 'x')) + fileDiff('scripts/b.mjs', '+b'), maxInputTokens: 3000 });
  assert.deepEqual(codeCut.unreviewedCodeFiles, ['scripts/a.mjs', 'scripts/b.mjs']);
  const docsCut = build({ rawDiff: fileDiff('docs/evals.md', '+'.padEnd(40000, 'd')) + fileDiff('scripts/a.mjs', '+code'), maxInputTokens: 3000 });
  assert.equal(docsCut.diffTruncated, true);
  assert.deepEqual(docsCut.unreviewedCodeFiles, []);
  assert.deepEqual(build().unreviewedCodeFiles, []);
});

test('buildReviewPrompt without a budget (Anthropic) reports the code files past the 12,000-char cap', () => {
  const { diffTruncated, unreviewedCodeFiles } = build({ rawDiff: fileDiff('scripts/a.mjs', '+'.padEnd(20000, 'y')), maxInputTokens: null });
  assert.equal(diffTruncated, true);
  assert.deepEqual(unreviewedCodeFiles, ['scripts/a.mjs']);
});

// --- #219: cut on boundaries, partly shown files, REQUEST_CHANGES on unseen code (ADR-0038 amendment) ---

test('findUnreviewedCodeFiles reads a boundary cut with its marker: a file with only some hunks shown is unreviewed', () => {
  const twoHunks = `diff --git a/scripts/a.mjs b/scripts/a.mjs\n--- a/scripts/a.mjs\n+++ b/scripts/a.mjs\n@@ -1 +1 @@\n-a\n+b\n@@ -40 +40 @@\n-c\n+${'d'.repeat(200)}\n`;
  const full = twoHunks + fileDiff('scripts/tests/a.test.mjs', '+t');
  const shown = cutDiffAtBoundary(full, full.indexOf('\n@@ -40') + 120);
  assert.match(shown, /\n\+b\n… \[diff cut: .*scripts\/a\.mjs \(partly shown\)/);
  assert.deepEqual(findUnreviewedCodeFiles(full, shown), ['scripts/a.mjs']);
  const fileBoundary = cutDiffAtBoundary(full, full.indexOf('diff --git a/scripts/tests') + 80);
  assert.deepEqual(findUnreviewedCodeFiles(full, fileBoundary), [], 'a.mjs shown in full, only the test file cut');
  assert.deepEqual(findUnreviewedCodeFiles(full, cutDiffAtBoundary(full, 60)), ['scripts/a.mjs'], 'marker only: nothing shown');
});

test('buildReviewPrompt on Groq: the #219 step-name line is shown whole or not at all, and test.yml counts as unreviewed', () => {
  const steps = Array.from({ length: 300 }, (_, i) => `+      - name: Check module_${i} coverage (≥80%)\n+        run: npx c8 node --test m${i}.test.mjs`).join('\n');
  const raw = fileDiff('.github/workflows/test.yml', steps) + fileDiff('scripts/lib/m.mjs', '+export const m = 1;');
  const { userPrompt, unreviewedCodeFiles } = build({ rawDiff: raw, maxInputTokens: 2500 });
  const diffPart = userPrompt.slice(userPrompt.indexOf('diff --git'), userPrompt.indexOf('\n', userPrompt.indexOf('… [diff cut: ')));
  for (const line of diffPart.split('\n').slice(0, -1)) assert.ok(raw.split('\n').includes(line), `partial line: ${line}`);
  assert.match(diffPart.split('\n').at(-1), /^… \[diff cut: \d+ more lines not shown, in \.github\/workflows\/test\.yml \(partly shown\), scripts\/lib\/m\.mjs\]$/);
  assert.deepEqual(unreviewedCodeFiles, ['.github/workflows/test.yml', 'scripts/lib/m.mjs']);
});

const review = (...findings) => ['## 🔍 Automated Code Review', '', '**✅ Summary**', '- Adds `scripts/lib/visible.mjs`.', '', '**⚠️ Issues Found**', ...findings, '', '**🚀 Verdict**', '**REQUEST_CHANGES**'].join('\n');
const STRAY = '- **High** Broken workflow syntax — File: `.github/workflows/test.yml` Lines: 280‑281 Root cause: the added line "`- n`" is an incomplete YAML list item. Fix: remove it.';
const MISSING_STEP = '- **Medium** Missing coverage — File: `.github/workflows/test.yml`\n  `scripts/lib/span_export.mjs` is added without a c8 step.';
const VISIBLE = '- [High] Off-by-one — File: scripts/lib/visible.mjs:12 Root cause: `<=`. Fix: `<`.';
const RC = { verdict: 'REQUEST_CHANGES', reason: null };
const CUT = ['.github/workflows/test.yml', 'scripts/lib/span_export.mjs'];

test('findingCitedFiles reads the files cited by each Issues Found bullet, continuation lines included', () => {
  assert.deepEqual(findingCitedFiles(review(STRAY, MISSING_STEP, VISIBLE)), [
    ['.github/workflows/test.yml'],
    ['.github/workflows/test.yml', 'scripts/lib/span_export.mjs'],
    ['scripts/lib/visible.mjs'],
  ]);
  assert.deepEqual(findingCitedFiles(review('1. **Low** Verify `test.yml:12`.')), [['test.yml']], 'numbered bullet, bare file name');
  assert.deepEqual(findingCitedFiles(review('- **Medium** Missing tests for the new export.')), [[]], 'a finding with no file');
  assert.deepEqual(findingCitedFiles(review('None.')), [], 'no finding bullet');
  assert.deepEqual(findingCitedFiles('### ⚠️ Issues Found\n- [High] a in `x.mjs`\n### 🚀 Verdict\n- [High] not a finding in `y.mjs`'), [['x.mjs']], 'the Verdict section ends it');
  assert.deepEqual(findingCitedFiles(undefined), []);
});

test('withholdOnUnreviewedCode withholds a REQUEST_CHANGES whose findings all cite only cut code files (#219)', () => {
  for (const text of [review(STRAY), review(MISSING_STEP), review(STRAY, MISSING_STEP), review('- **High** stray line in `test.yml`')]) {
    assert.deepEqual(withholdOnUnreviewedCode(RC, CUT, text), {
      verdict: 'WITHHELD', reason: 'every finding cites only code cut from the reviewed diff: .github/workflows/test.yml, scripts/lib/span_export.mjs',
    });
  }
});

test('withholdOnUnreviewedCode keeps the REQUEST_CHANGES when any finding cites a shown file, cites no file, or there is none', () => {
  assert.equal(withholdOnUnreviewedCode(RC, CUT, review(STRAY, VISIBLE)), RC, 'one finding on a shown file');
  assert.equal(withholdOnUnreviewedCode(RC, CUT, review('- **High** `.github/workflows/test.yml` breaks `scripts/lib/visible.mjs`')), RC, 'one finding citing a shown file too');
  assert.equal(withholdOnUnreviewedCode(RC, CUT, review('- **Medium** Missing tests for the new export.')), RC, 'no citation');
  assert.equal(withholdOnUnreviewedCode(RC, CUT, review('None.')), RC, 'no finding (e.g. a gate verdict)');
  assert.equal(withholdOnUnreviewedCode(RC, CUT), RC, 'no review text');
  assert.equal(withholdOnUnreviewedCode(RC, [], review(STRAY)), RC, 'nothing was cut');
  const failing = { verdict: 'REQUEST_CHANGES', reason: 'failing checks: tests' };
  assert.equal(withholdOnUnreviewedCode(failing, CUT, review(STRAY)), failing, 'a failing check is never withheld');
});

test('formatUnseenFindingsNote names the cut files and says auto-fix is not triggered', () => {
  const note = formatUnseenFindingsNote(CUT);
  assert.match(note, /^\n> \*\*Changes not requested\*\* — the diff was cut to the token budget/);
  assert.match(note, /`\.github\/workflows\/test\.yml`, `scripts\/lib\/span_export\.mjs`/);
  assert.match(note, /Auto-fix is not triggered/);
});

// #220 review: failing checks, ambiguous bare file names, a finding bullet that does not start with its severity.

test('withholdOnUnreviewedCode never withholds a model REQUEST_CHANGES when a check failed', () => {
  const failFinding = review('- **High** `npm test` FAIL: TypeError in scripts/lib/span_export.mjs:12');
  assert.equal(withholdOnUnreviewedCode(RC, CUT, failFinding, { checksFailed: true }), RC);
  assert.equal(withholdOnUnreviewedCode(RC, CUT, failFinding).verdict, 'WITHHELD', 'without failing checks the same review is withheld');
});

test('withholdOnUnreviewedCode keeps a REQUEST_CHANGES whose bare file name also names a shown file', () => {
  const bare = review('- **High** off-by-one in `utils.mjs:4`');
  assert.equal(withholdOnUnreviewedCode(RC, ['scripts/lib/utils.mjs'], bare, { shownFiles: ['scripts/utils.mjs'] }), RC);
  assert.equal(withholdOnUnreviewedCode(RC, ['scripts/lib/utils.mjs'], bare, { shownFiles: ['scripts/other.mjs'] }).verdict, 'WITHHELD');
  const full = review('- **High** off-by-one in `scripts/lib/utils.mjs:4`');
  assert.equal(withholdOnUnreviewedCode(RC, ['scripts/lib/utils.mjs'], full, { shownFiles: ['scripts/utils.mjs'] }).verdict, 'WITHHELD', 'a full path is not ambiguous');
});

test('findingCitedFiles counts every top-level bullet as a finding, whatever comes first', () => {
  const pathFirst = review('- `scripts/lib/visible.mjs:12` — **High** off-by-one', STRAY);
  assert.deepEqual(findingCitedFiles(pathFirst), [['scripts/lib/visible.mjs'], ['.github/workflows/test.yml']]);
  assert.equal(withholdOnUnreviewedCode(RC, CUT, pathFirst), RC, 'the shown-file finding is not dropped');
  assert.deepEqual(findingCitedFiles(review(STRAY, '  - sub-point on `scripts/lib/span_export.mjs`')), [['.github/workflows/test.yml', 'scripts/lib/span_export.mjs']], 'a sub-bullet continues its finding');
});

test('buildReviewPrompt returns the files not cut as shownFiles', () => {
  const raw = fileDiff('scripts/a.mjs', '+a') + fileDiff('scripts/b.mjs', '+'.padEnd(40000, 'b'));
  const { unreviewedCodeFiles, shownFiles } = build({ rawDiff: raw, maxInputTokens: 3000 });
  assert.deepEqual([unreviewedCodeFiles, shownFiles], [['scripts/b.mjs'], ['scripts/a.mjs']]);
  assert.deepEqual(build().shownFiles, ['src/a.js']);
});
