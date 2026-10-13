import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, orderDiffForReview, parseReviewVerdict } from '../lib/review_prompt.mjs';
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

test('buildReviewPrompt without a budget (Anthropic) caps the diff at 12,000 chars and flags it', () => {
  const raw = fileDiff('src/a.js', '+'.padEnd(20000, 'y'));
  const { userPrompt, diffTruncated } = build({ rawDiff: raw, maxInputTokens: null });
  assert.equal(diffTruncated, true);
  assert.ok(userPrompt.includes(raw.slice(0, 12000)));
  assert.ok(!userPrompt.includes(raw.slice(0, 12001)));
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
