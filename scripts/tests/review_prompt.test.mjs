import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, parseReviewVerdict } from '../lib/review_prompt.mjs';
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

// ADR-0034 / ADR-0035: stale references and related ADRs in the review prompt

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
