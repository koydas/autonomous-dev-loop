import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReviewSystemPrompt, loadReviewSystemPrompt, buildReviewPrompt, findingCitedFiles, findUnreviewedCodeFiles, formatUnreviewedCodeNote, formatUnseenFindingsNote, orderDiffForReview, parseReviewVerdict, withholdOnUnreviewedCode } from '../lib/review_prompt.mjs';
import { cutDiffAtBoundary } from '../lib/file_filters.mjs';
import { assessEvidence } from '../lib/review_evidence.mjs';
import { estimateTokens } from '../lib/metrics.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlatYaml } from '../lib/yaml.mjs';
import { LOW_HEADROOM_RATIO, computePromptBudgetImpact, promptTokens } from '../lib/prompt_budget.mjs';

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

test('orderDiffForReview reviews agent-rule files as code, ahead of tests and docs (ADR-0038 amendment)', () => {
  const raw = ['README.md', 'scripts/tests/a.test.mjs', 'AGENTS.md', '.claude/skills/x/SKILL.md', 'svc/CLAUDE.md', 'scripts/b.mjs'].map((f) => fileDiff(f, '+x')).join('');
  assert.deepEqual(filesOf(orderDiffForReview(raw)), ['AGENTS.md', '.claude/skills/x/SKILL.md', 'svc/CLAUDE.md', 'scripts/b.mjs', 'scripts/tests/a.test.mjs', 'README.md']);
});

test('buildReviewPrompt counts a cut agent-rule file as unreviewed code, so its approval is withheld', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `+rule ${String(i).padStart(4, '0')}`);
  const { unreviewedCodeFiles } = build({ rawDiff: fileDiff('AGENTS.md', lines.join('\n')), maxInputTokens: null });
  assert.deepEqual(unreviewedCodeFiles, ['AGENTS.md']);
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

// --- ADR-0038 amendment: provider-aware diff cap (maxDiffChars on a provider with no input budget) ---

test('buildReviewPrompt without a budget caps the diff at maxDiffChars, with the boundary cut and marker', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `+line ${String(i).padStart(4, '0')}`);
  const raw = fileDiff('src/a.js', lines.join('\n'));
  // 36k chars: past the former 12,000 cap, under a 50,000 one: shown whole.
  const uncut = build({ rawDiff: raw, maxInputTokens: null, maxDiffChars: 50000 });
  assert.equal(uncut.diffTruncated, false);
  assert.deepEqual(uncut.unreviewedCodeFiles, []);
  assert.ok(uncut.userPrompt.includes(raw.trimEnd()));
  assert.doesNotMatch(uncut.userPrompt, /diff cut: /);
  // Over the cap: cut on a whole line, marker names the partly shown file, the file is unreviewed (ADR-0038).
  const cut = build({ rawDiff: raw, maxInputTokens: null, maxDiffChars: 20000 });
  assert.equal(cut.diffTruncated, true);
  const shown = cut.userPrompt.slice(cut.userPrompt.indexOf('diff --git'), cut.userPrompt.indexOf(']', cut.userPrompt.indexOf('… [diff cut: ')) + 1);
  assert.ok(shown.length <= 20000 && shown.length > 12000, `${shown.length} chars`);
  const kept = shown.split('\n').slice(0, -1);
  assert.ok(raw.startsWith(`${kept.join('\n')}\n`), 'the shown diff is a prefix of whole lines');
  assert.match(shown.split('\n').at(-1), new RegExp(`^… \\[diff cut: ${3004 - kept.length} more lines not shown, in src/a\\.js \\(partly shown\\)\\]$`));
  assert.deepEqual(cut.unreviewedCodeFiles, ['src/a.js']);
});

test('buildReviewPrompt ignores maxDiffChars on a budgeted provider (Groq): the token budget alone bounds the diff', () => {
  const raw = fileDiff('src/a.js', '+x'.repeat(40000));
  const withCap = build({ rawDiff: raw, maxInputTokens: 3000, maxDiffChars: 500 });
  const without = build({ rawDiff: raw, maxInputTokens: 3000 });
  assert.equal(withCap.userPrompt, without.userPrompt);
  const small = build({ rawDiff: fileDiff('src/a.js', '+'.padEnd(2000, 'y')), maxInputTokens: 6300, maxDiffChars: 500 });
  assert.equal(small.diffTruncated, false, 'a cap below the diff does not cut it when a budget is set');
});

test('buildReviewPrompt without a budget and without maxDiffChars keeps the 12,000-char cap', () => {
  const raw = fileDiff('scripts/a.mjs', '+'.padEnd(20000, 'y'));
  assert.equal(build({ rawDiff: raw, maxInputTokens: null }).userPrompt, build({ rawDiff: raw, maxInputTokens: null, maxDiffChars: 12000 }).userPrompt);
  assert.equal(build({ rawDiff: raw, maxInputTokens: null, maxDiffChars: null }).diffTruncated, true);
});

// #199: an untested PR-description claim is one Low advisory finding, never a REQUEST_CHANGES on its own, and
// never raised without a visible changed test, on an empty or claim-free body, docs-only or past the cut. The
// rule stays short (~120 tokens) and keeps the Groq review headroom above the ADR-0037 margin.
test('pr-review-system.md bounds the untested-claim rule to a Low advisory, within the review headroom', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const PROMPT = 'prompts/pr-review-system.md';
  const system = readFileSync(resolve(ROOT, PROMPT), 'utf8');
  const rule = system.split('\n').find((line) => line.startsWith('* Untested claim:'));
  assert.ok(rule, 'untested-claim rule missing');
  assert.match(rule, /PR-description sentence asserting changed runtime behavior/);
  assert.match(rule, /a changed test file is visible and no visible test exercises it: one Low finding per claim, "Untested claim: <claim>", citing the implementing file:lines/);
  assert.match(rule, /never above Low, never alone a REQUEST_CHANGES/);
  assert.match(rule, /None when a visible test covers it, no such claim is made, `tests_expected` is false, or the tests are cut \(use "Not verified"\)/);
  assert.ok(promptTokens(rule) <= 130, `rule is ~${promptTokens(rule)} tokens`);
  // Placed with the test-coverage rules, after the has_test_file_changes judgment it refines.
  assert.ok(system.indexOf(rule) > system.indexOf('`has_test_file_changes` is a coarse signal'));
  // The existing obligations are untouched: missing tests stay >= MEDIUM, unseen content stays a Low note.
  assert.match(system, /If `tests_expected` is true and `has_test_file_changes` is false, report at least MEDIUM severity/);
  assert.match(system, /"Not verified \(diff truncated\): …", at most a Low "verify" note, never Medium or High, and never let it make the verdict REQUEST_CHANGES/);
  const models = parseFlatYaml(readFileSync(resolve(ROOT, 'config/models.yaml'), 'utf8'));
  const [impact] = computePromptBudgetImpact({
    rawDiff: `diff --git a/${PROMPT} b/${PROMPT}\n--- a/${PROMPT}\n+++ b/${PROMPT}\n@@ -1 +1 @@\n-a\n+b\n`,
    readBase: () => system.replace(`${rule}\n`, ''), readHead: (p) => readFileSync(resolve(ROOT, p), 'utf8'), models, logFn: () => {},
  });
  assert.equal(impact.stage, 'review');
  assert.ok(impact.deltaTokens > 0 && impact.deltaTokens <= 130, `delta ${impact.deltaTokens}`);
  assert.ok(impact.headroomTokens >= Math.ceil(impact.maxInputTokens * LOW_HEADROOM_RATIO), `${impact.headroomTokens} of ${impact.maxInputTokens}`);
});

// ADR-0045: the review system prompt is a neutral core plus this repository's rules.
const CORE = 'Intro for {{repository_kind}}.\n* a\n{{repository_rules_1}}\n* stale lead. {{repository_rules_2}}\n{{repository_rules_3}}\n* z';
const RULES = 'R1 line one\n* R1 line two\n<!-- next -->\nR2 sentence.\n<!-- next -->\n* R3 bullet\n';

test('assembleReviewSystemPrompt puts the repository rules back in place for this repository', () => {
  assert.equal(
    assembleReviewSystemPrompt(CORE, RULES, { self: true }),
    'Intro for a Node.js automation repository.\n* a\nR1 line one\n* R1 line two\n* stale lead. R2 sentence.\n* R3 bullet\n* z',
  );
  // Guidelines are for other repositories only.
  assert.ok(!assembleReviewSystemPrompt(CORE, RULES, { self: true, guidelines: 'ignored' }).includes('ignored'));
});

test('assembleReviewSystemPrompt names a placeholder the rules file has no block for', () => {
  assert.throws(() => assembleReviewSystemPrompt('{{repository_rules_4}}', RULES, { self: true }), /references \{\{repository_rules_4\}\} but pr-review-repo-rules\.md has 3 block\(s\)/);
});

test('assembleReviewSystemPrompt gives another repository the neutral core, with no gap and no placeholder', () => {
  const out = assembleReviewSystemPrompt(CORE, '', { self: false });
  assert.equal(out, 'Intro for a software repository.\n* a\n* stale lead.\n* z');
  assert.ok(!out.includes('{{') && !out.includes('R1'));
});

test('assembleReviewSystemPrompt appends the guidelines of another repository, trimmed, and ignores blank ones', () => {
  const out = assembleReviewSystemPrompt(CORE, '', { self: false, guidelines: '\n* Keep the public API stable.\n' });
  assert.match(out, /\* z\n\nRepository review guidelines \(supplied by the repository from its trusted default-branch configuration;[^)]*\):\n\n\* Keep the public API stable\.$/);
  assert.equal(assembleReviewSystemPrompt(CORE, '', { self: false, guidelines: '  \n ' }), 'Intro for a software repository.\n* a\n* stale lead.\n* z');
});

test('the real prompts split cleanly: four placeholders in the core, four blocks in the rules, nothing left over', () => {
  const PROMPTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const core = readFileSync(resolve(PROMPTS_ROOT, 'prompts/pr-review-system.md'), 'utf8');
  const rules = readFileSync(resolve(PROMPTS_ROOT, 'prompts/pr-review-repo-rules.md'), 'utf8');
  assert.deepEqual([...core.matchAll(/\{\{repository_rules_(\d+)\}\}/g)].map((m) => m[1]), ['1', '2', '3', '4']);
  assert.equal([...core.matchAll(/\{\{repository_kind\}\}/g)].length, 1);
  assert.equal(rules.split('\n<!-- next -->\n').length, 4);
  const self = loadReviewSystemPrompt({ self: true });
  assert.ok(!self.includes('{{') && !self.includes('<!--'));
  for (const text of ['For PRs that modify generation/review/auto-fix automation', 'For gate (a),', 'For gate (b),', 'For gate (c), CI enforces', 'Named defect checks', 'Read-only property assignment', 'Unauthorized dependency', 'Non-persistent "ref" pattern', 'A hit alone is never a gate (b) finding; judge gate (b) from the diff as usual.']) {
    assert.ok(self.includes(text), `this repository's review prompt lost: ${text}`);
  }
  assert.ok(self.length > core.length, 'the rules are put back');
  assert.match(self, /^You are a senior engineer reviewing a pull request diff for a Node\.js automation repository\./);
});

test('another repository gets the review rules that hold anywhere, none of this repository\'s', () => {
  const target = loadReviewSystemPrompt({ self: false });
  assert.ok(!target.includes('{{') && !target.includes('<!--'));
  assert.match(target, /^You are a senior engineer reviewing a pull request diff for a software repository\./);
  for (const text of ['gate (a)', 'gate (b)', 'gate (c)', 'c8', 'docs/code-generation.md', 'scripts/lib/', 'Node.js', 'Named defect checks', 'Unauthorized dependency', 'useRef', 'AbortController']) {
    assert.ok(!target.includes(text), `the neutral prompt still mentions ${text}`);
  }
  for (const text of ['Review the code in the provided diff; do not infer or evaluate code outside changed hunks', 'Impact analysis', 'Allowed verdicts are only: APPROVED or REQUEST_CHANGES', 'Before flagging a step condition', 'Tool evidence:', 'Context-aware review:', 'Stale references']) {
    assert.ok(target.includes(text), `the neutral prompt lost: ${text}`);
  }
  assert.match(loadReviewSystemPrompt({ self: false, guidelines: '* Be kind.' }), /Repository review guidelines[\s\S]*\* Be kind\.$/);
});

test('buildReviewPrompt leaves the automation-gate context out for another repository', () => {
  const rawDiff = fileDiff('scripts/a.mjs', '+x');
  assert.match(build({ rawDiff }).userPrompt, /Automation gates context:/);
  assert.match(build({ rawDiff, automationGates: true }).userPrompt, /Automation gates context:/);
  const off = build({ rawDiff, automationGates: false }).userPrompt;
  assert.doesNotMatch(off, /Automation gates context:/);
  assert.match(off, /Change classification context:/);
});

// ── gated_files_changed (gate (c) names the changed gated files instead of listing every gated module) ──────────
test('loadGatedModules reads config/coverage-gates.json, and is null when it cannot be read', async () => {
  const { loadGatedModules } = await import('../lib/review_prompt.mjs');
  const modules = loadGatedModules();
  assert.ok(modules.includes('scripts/lib/review_prompt.mjs') && modules.includes('scripts/build_eval_site.mjs'));
  assert.equal(loadGatedModules('/nonexistent-root'), null);
});

test('the automation gates context names the changed files that are gated, none, or omits the line when the gates are unknown', async () => {
  const { buildAutomationGateContext } = await import('../lib/coverage_checker.mjs');
  const diff = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n+x\n`;
  const gated = ['scripts/lib/a.mjs'];
  assert.match(buildAutomationGateContext(diff('scripts/lib/a.mjs') + diff('scripts/lib/b.mjs'), gated), /- gated_files_changed: scripts\/lib\/a\.mjs\n/);
  assert.match(buildAutomationGateContext(diff('scripts/lib/b.mjs'), gated), /- gated_files_changed: none\n/);
  assert.doesNotMatch(buildAutomationGateContext(diff('scripts/lib/a.mjs')), /gated_files_changed/);
  assert.equal(buildAutomationGateContext(diff('src/x.js'), gated), '', 'outside the automation scope: no context at all');
});

const IMPACT = {
  symbols: [{ name: 'parseThing', file: 'src/a.js', status: 'changed', refs: [{ path: 'src/b.js', line: 4, text: 'parseThing(x)' }], refFiles: 1, generic: false }],
  tests: [], scanned: 2, truncated: false,
};

test('buildReviewPrompt places the impact analysis after the budget context and before the related ADRs and the evidence', () => {
  const { userPrompt, impactIncluded } = build({ maxInputTokens: null, impact: IMPACT, relatedAdrs: ADRS });
  assert.equal(impactIncluded, true);
  const order = ['## Impact analysis', '## Related ADRs', '## Tool evidence'].map((s) => userPrompt.indexOf(s));
  assert.ok(order.every((i) => i > 0), `missing block: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(userPrompt, /src\/b\.js:4/);
});

const DOC_MENTIONS = {
  terms: [{ kind: 'export', name: 'parseThing', file: 'src/a.js', status: 'changed', refs: [{ path: 'docs/a.md', line: 7, text: 'parseThing returns a list' }], refFiles: 1, generic: false }],
  scanned: 1, truncated: false,
};

test('buildReviewPrompt adds the documents that mention the change right after the impact analysis, and either alone counts as the block', () => {
  const both = build({ maxInputTokens: null, impact: IMPACT, docMentions: DOC_MENTIONS, relatedAdrs: ADRS });
  const order = ['## Impact analysis', '## Documents that mention what this diff changes', '## Related ADRs'].map((s) => both.userPrompt.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order.every((x, i) => i === 0 || x > order[i - 1]), `order: ${order}`);
  assert.match(both.userPrompt, /docs\/a\.md:7: parseThing returns a list/);
  const docsOnly = build({ maxInputTokens: null, docMentions: DOC_MENTIONS });
  assert.equal(docsOnly.impactIncluded, true);
  assert.doesNotMatch(docsOnly.userPrompt, /## Impact analysis/);
  for (const docMentions of [null, { terms: [], scanned: 3, truncated: false }]) {
    const none = build({ docMentions });
    assert.doesNotMatch(none.userPrompt, /## Documents that mention/);
    assert.equal(none.impactIncluded, false);
  }
});

test('buildReviewPrompt drops the document lines with the impact analysis, never the diff, when they do not fit', () => {
  const rawDiff = fileDiff('src/a.js', `+${'y'.repeat(4000)}`);
  const base = build({ rawDiff, maxInputTokens: null });
  const exact = estimateTokens(SYSTEM + base.userPrompt);
  const { userPrompt, impactIncluded, diffTruncated } = build({ rawDiff, maxInputTokens: exact, impact: IMPACT, docMentions: DOC_MENTIONS });
  assert.equal(impactIncluded, false);
  assert.doesNotMatch(userPrompt, /## Documents that mention|## Impact analysis/);
  assert.equal(diffTruncated, false);
});

test('buildReviewPrompt shows no impact block without impact, with an empty one, or reports it as not included', () => {
  for (const impact of [null, { symbols: [], tests: [], scanned: 0, truncated: false }]) {
    const { userPrompt, impactIncluded } = build({ impact });
    assert.doesNotMatch(userPrompt, /## Impact analysis/);
    assert.equal(impactIncluded, false);
  }
});

test('buildReviewPrompt drops the related ADRs before the impact analysis when the budget is tight', () => {
  const rawDiff = fileDiff('src/a.js', `+${'y'.repeat(4000)}`);
  const withImpact = build({ rawDiff, maxInputTokens: null, impact: IMPACT });
  const exact = estimateTokens(SYSTEM + withImpact.userPrompt);
  const relatedAdrs = [{ ...ADRS[0], decisionExcerpt: 'z'.repeat(400) }];
  const { userPrompt, adrCount, impactIncluded, diffTruncated } = build({ rawDiff, maxInputTokens: exact, impact: IMPACT, relatedAdrs });
  assert.equal(adrCount, 0);
  assert.equal(impactIncluded, true);
  assert.match(userPrompt, /## Impact analysis/);
  assert.doesNotMatch(userPrompt, /## Related ADRs/);
  assert.equal(diffTruncated, false);
});

test('buildReviewPrompt drops the impact analysis too, never the diff, when even it does not fit', () => {
  const rawDiff = fileDiff('src/a.js', `+${'y'.repeat(4000)}`);
  const base = build({ rawDiff, maxInputTokens: null });
  const exact = estimateTokens(SYSTEM + base.userPrompt);
  const { userPrompt, impactIncluded, diffTruncated } = build({ rawDiff, maxInputTokens: exact, impact: IMPACT });
  assert.equal(impactIncluded, false);
  assert.doesNotMatch(userPrompt, /## Impact analysis/);
  assert.match(userPrompt, /y{4000}/);
  assert.equal(diffTruncated, false);
});
