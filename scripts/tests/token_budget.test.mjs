import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROQ_TPM_LIMIT, TOKEN_ESTIMATE_MARGIN, fitsTpmWindow, assertInputBudget, fitReviewPrompt } from '../lib/token_budget.mjs';
import { estimateTokens } from '../lib/metrics.mjs';

const SYSTEM = 's'.repeat(400); // 100 tokens
const build = ({ diff, prBody, diffTruncated }) => `BODY:${prBody}\nDIFF:${diff}\ntruncated:${diffTruncated}`;

test('fitsTpmWindow applies the 10% estimate margin before adding max_tokens', () => {
  assert.equal(GROQ_TPM_LIMIT, 8000);
  assert.equal(TOKEN_ESTIMATE_MARGIN, 1.1);
  assert.equal(fitsTpmWindow(6300, 1024), true);
  assert.equal(fitsTpmWindow(6400, 1024), false, '6400 × 1.10 + 1024 = 8064');
  assert.equal(fitsTpmWindow(7283, 1024), false, 'run 37174238930: the old review prompt');
  assert.equal(fitsTpmWindow(890 + 3000, 4096), false, 'the former autofix budget had no margin');
});

test('assertInputBudget passes under the budget and without a budget (Anthropic)', () => {
  assert.doesNotThrow(() => assertInputBudget('validation', 6300, 6300));
  assert.doesNotThrow(() => assertInputBudget('validation', 99999, undefined));
});

test('assertInputBudget throws an explicit error naming the stage key when over budget', () => {
  assert.throws(() => assertInputBudget('generation', 3501, 3500), /generation prompt is ~3501 estimated input tokens, over generation_max_input_tokens \(3500\).*413/);
});

test('fitReviewPrompt returns the prompt unchanged when it fits', () => {
  const r = fitReviewPrompt({ systemPrompt: SYSTEM, buildUserPrompt: build, diff: 'd'.repeat(40), prBody: 'body', maxInputTokens: 1000 });
  assert.equal(r.diff, 'd'.repeat(40));
  assert.equal(r.prBody, 'body');
  assert.equal(r.diffTruncated, false);
  assert.equal(r.bodyTruncated, false);
  assert.equal(r.userPrompt, build({ diff: 'd'.repeat(40), prBody: 'body', diffTruncated: false }));
});

test('fitReviewPrompt passes through without a budget (Anthropic) and keeps an upstream truncation flag', () => {
  const r = fitReviewPrompt({ systemPrompt: SYSTEM, buildUserPrompt: build, diff: 'd'.repeat(100000), prBody: 'b', maxInputTokens: undefined, diffTruncated: true });
  assert.equal(r.diff.length, 100000);
  assert.equal(r.diffTruncated, true);
  assert.equal(r.bodyTruncated, false);
});

test('fitReviewPrompt shrinks the diff first, flags diffTruncated and fits the budget', () => {
  const r = fitReviewPrompt({ systemPrompt: SYSTEM, buildUserPrompt: build, diff: 'd'.repeat(40000), prBody: 'b'.repeat(400), maxInputTokens: 1000 });
  assert.ok(estimateTokens(SYSTEM + r.userPrompt) <= 1000);
  assert.ok(r.diff.length > 0 && r.diff.length < 40000);
  assert.equal(r.diffTruncated, true);
  assert.match(r.userPrompt, /truncated:true/);
  assert.equal(r.prBody, 'b'.repeat(400), 'the body is untouched while the diff can absorb the overflow');
  assert.equal(r.bodyTruncated, false);
});

test('fitReviewPrompt drops the whole diff, then truncates a huge PR body with a note', () => {
  const r = fitReviewPrompt({ systemPrompt: SYSTEM, buildUserPrompt: build, diff: 'd'.repeat(800), prBody: 'b'.repeat(40000), maxInputTokens: 1000 });
  assert.ok(estimateTokens(SYSTEM + r.userPrompt) <= 1000);
  assert.equal(r.diff, '');
  assert.equal(r.diffTruncated, true);
  assert.equal(r.bodyTruncated, true);
  assert.match(r.prBody, /^b+\n\n…\(PR description truncated to fit the token budget\)$/);
});

test('fitReviewPrompt throws without building an over-budget prompt when the fixed part alone is too big', () => {
  const fixed = ({ diff, prBody }) => `${'x'.repeat(8000)}${prBody}${diff}`;
  assert.throws(
    () => fitReviewPrompt({ systemPrompt: SYSTEM, buildUserPrompt: fixed, diff: 'd'.repeat(100), prBody: 'b'.repeat(100), maxInputTokens: 1000 }),
    /review prompt is ~\d+ estimated input tokens with no diff and no PR description left, over review_max_input_tokens \(1000\)/,
  );
});
