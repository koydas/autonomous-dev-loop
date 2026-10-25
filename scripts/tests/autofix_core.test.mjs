import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_FILES,
  MAX_FILE_SIZE,
  TOKEN_SAFETY_MARGIN,
  MODEL_CONTEXT_WINDOW,
  truncateToTokenBudget,
  fitAutofixBudget,
  listChangedFiles,
  buildAutofixContext,
  parseAutofixResponse,
  findAutofixViolations,
} from '../lib/autofix_core.mjs';

let root;

const write = async (rel, content) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
};
const fileDiff = (f, body = '+x') => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n${body}\n`;
const TEMPLATE = 'FEEDBACK:\n{{reviewFeedback}}\nDIFF:\n{{diff}}\nFILES:\n{{fileContents}}';
const ROOMY = { diffBudget: 1000, feedbackBudget: 1000, fileBudget: 1000 };

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-core-'));
  await write('package.json', '{"type":"module","dependencies":{"left-pad":"1.0.0"}}\n');
  await write('src/a.mjs', 'export const a = 1;\n');
  await write('src/b.mjs', 'export const b = 2;\n');
  await write('src/big.mjs', `export const big = '${'x'.repeat(MAX_FILE_SIZE + 10)}';\n`);
  await fs.symlink('/etc/hostname', path.join(root, 'src/link.mjs'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// --- truncateToTokenBudget ---

test('truncateToTokenBudget: a budget of zero or less gives an empty string, a text within budget is untouched, a longer one is cut at budget × 4 characters', () => {
  assert.equal(truncateToTokenBudget('abc', 0), '');
  assert.equal(truncateToTokenBudget('abc', -5), '');
  assert.equal(truncateToTokenBudget('abcd', 1), 'abcd');
  assert.equal(truncateToTokenBudget('abcdefgh', 1), 'abcd');
});

// --- fitAutofixBudget ---

const fit = (over = {}) => fitAutofixBudget({ provider: 'groq', model: 'openai/gpt-oss-120b', systemTokens: 1000, userWrapperTokens: 100, maxOutputBudget: 4096, maxInputTokens: null, diffRatio: 0.15, feedbackRatio: 0.25, ...over });

test('fitAutofixBudget: a known model uses its window, minus the margin, the system prompt and the output cap, then the wrapper', () => {
  const b = fit();
  assert.equal(b.contextWindow, 131072);
  assert.equal(b.inputBudget, 131072 - TOKEN_SAFETY_MARGIN - 1000 - 4096 - 100);
  assert.equal(b.diffBudget, Math.floor(b.inputBudget * 0.15));
  assert.equal(b.feedbackBudget, Math.floor(b.inputBudget * 0.25));
  assert.equal(b.fileBudget, b.inputBudget - b.diffBudget - b.feedbackBudget);
});

test('fitAutofixBudget: a model missing from the table falls back to 32,768 on Groq and 200,000 elsewhere', () => {
  assert.equal(fit({ model: 'unknown/groq-model' }).contextWindow, 32768);
  assert.equal(fit({ provider: 'anthropic', model: 'claude-opus-5-5' }).contextWindow, 200000);
  assert.equal(MODEL_CONTEXT_WINDOW['claude-opus-5-5'], undefined, 'the 5.x ids take the fallback until a window is verified');
});

test('fitAutofixBudget: the configured input cap can only lower the budget', () => {
  assert.equal(fit({ maxInputTokens: 2500 }).inputBudget, 2500 - 100);
  assert.equal(fit({ maxInputTokens: 10_000_000 }).inputBudget, fit().inputBudget);
});

test('fitAutofixBudget: a prompt larger than the window leaves a zero budget, never a negative one', () => {
  const b = fit({ model: 'unknown/groq-model', systemTokens: 40_000 });
  assert.deepEqual([b.inputBudget, b.diffBudget, b.feedbackBudget, b.fileBudget], [0, 0, 0, 0]);
});

// --- listChangedFiles ---

test('listChangedFiles: paths once each, in diff order; none for an empty diff', () => {
  const raw = fileDiff('src/a.mjs') + fileDiff('src/b.mjs') + fileDiff('src/a.mjs');
  assert.deepEqual(listChangedFiles(raw), ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(listChangedFiles(''), []);
});

// --- buildAutofixContext ---

const build = (over = {}) => buildAutofixContext({ root, userPromptTemplate: TEMPLATE, feedbackParts: ['fix a'], rawDiff: fileDiff('src/a.mjs'), budgets: ROOMY, ...over });

test('buildAutofixContext: a changed file is shown whole, the prompt carries feedback, diff and file, dependencies are the manifest\'s', async () => {
  const ctx = await build();
  assert.deepEqual([...ctx.shownPaths], ['src/a.mjs']);
  assert.equal(ctx.hiddenPaths.size, 0);
  assert.match(ctx.userPrompt, /FEEDBACK:\nfix a\nDIFF:\ndiff --git a\/src\/a\.mjs/);
  assert.match(ctx.userPrompt, /### Current file: src\/a\.mjs\n```\nexport const a = 1;\n\n```/);
  assert.ok(ctx.dependencies, 'dependency snapshot taken');
  assert.deepEqual(ctx.budgetCuts, { hidden_files: [], skipped_files: 0, diff_truncated: false, feedback_truncated: false });
});

test('buildAutofixContext: no feedback gives the placeholder text, no readable file gives the no-files text', async () => {
  const ctx = await build({ feedbackParts: [], rawDiff: fileDiff('src/deleted.mjs') });
  assert.match(ctx.userPrompt, /\(No specific review feedback provided\)/);
  assert.match(ctx.fileContents, /^No existing files identified as relevant to this review\.$/);
  assert.equal(ctx.shownPaths.size, 0);
});

test('buildAutofixContext: a file over the size bound is withheld with a marker the model must not target', async () => {
  const ctx = await build({ rawDiff: fileDiff('src/big.mjs') });
  assert.deepEqual([...ctx.hiddenPaths], ['src/big.mjs']);
  assert.match(ctx.fileContents, /### File withheld \(too large for the context budget\): src\/big\.mjs — do NOT target this file/);
  assert.deepEqual(ctx.budgetCuts.hidden_files, ['src/big.mjs']);
});

test('buildAutofixContext: a file that does not fit the remaining file budget is withheld, not cut', async () => {
  const ctx = await build({ rawDiff: fileDiff('src/a.mjs'), budgets: { ...ROOMY, fileBudget: 1 } });
  assert.deepEqual([...ctx.hiddenPaths], ['src/a.mjs']);
  assert.doesNotMatch(ctx.fileContents, /export const a/);
});

test('buildAutofixContext: a symlink is never followed, is withheld as not a regular file and reported through onWithheld', async () => {
  const seen = [];
  const ctx = await build({ rawDiff: fileDiff('src/link.mjs'), onWithheld: (e) => seen.push(e) });
  assert.deepEqual(seen, [{ path: 'src/link.mjs', reason: 'symlink' }]);
  assert.deepEqual([...ctx.hiddenPaths], ['src/link.mjs']);
  assert.match(ctx.fileContents, /not a regular file in the PR tree\): src\/link\.mjs/);
  assert.doesNotMatch(ctx.fileContents, /localhost|etc/);
});

test('buildAutofixContext: only MAX_FILES files are read, the rest is counted as skipped', async () => {
  const names = Array.from({ length: MAX_FILES + 2 }, (_, i) => `src/gone${i}.mjs`);
  const ctx = await build({ rawDiff: names.map((n) => fileDiff(n)).join('') });
  assert.equal(ctx.budgetCuts.skipped_files, 2);
});

test('buildAutofixContext: a diff and a feedback over their budget are cut and flagged', async () => {
  const ctx = await build({ feedbackParts: ['y'.repeat(400)], rawDiff: fileDiff('src/a.mjs', `+${'z'.repeat(2000)}`), budgets: { diffBudget: 10, feedbackBudget: 10, fileBudget: 1000 } });
  assert.equal(ctx.budgetCuts.diff_truncated, true);
  assert.equal(ctx.budgetCuts.feedback_truncated, true);
  assert.equal(ctx.reviewFeedback.length, 40);
});

test('buildAutofixContext: files excluded from review context (lock files) are not shown', async () => {
  const ctx = await build({ rawDiff: fileDiff('package-lock.json') });
  assert.equal(ctx.shownPaths.size, 0);
  assert.equal(ctx.budgetCuts.skipped_files, 0);
});

// --- parseAutofixResponse ---

test('parseAutofixResponse: an object is returned', () => {
  assert.deepEqual(parseAutofixResponse('{"summary":"s","changes":[]}'), { summary: 's', changes: [] });
});

test('parseAutofixResponse: text that is not JSON fails with kind json and the parser\'s error as cause', () => {
  assert.throws(() => parseAutofixResponse('not json at all'), (err) => err.kind === 'json' && err.cause instanceof Error);
});

test('parseAutofixResponse: valid JSON that is not an object fails with kind shape (array, null, scalar)', () => {
  for (const raw of ['[]', 'null', '42']) {
    assert.throws(() => parseAutofixResponse(raw), (err) => err.kind === 'shape' && /must be an object/.test(err.message), raw);
  }
});

// --- findAutofixViolations ---

const ctxOf = async (rawDiff) => build({ rawDiff });
const patch = (targetPath, fileContent) => ({ targetPath, fileContent });

test('findAutofixViolations: a shown file rewritten safely has no violation', async () => {
  const context = await ctxOf(fileDiff('src/a.mjs'));
  assert.deepEqual(findAutofixViolations({ changes: [patch('src/a.mjs', 'export const a = 2;\n')], context, root, mentionText: 'fix a' }), []);
});

test('findAutofixViolations: a file never shown is rejected as unshown, one withheld as withheld', async () => {
  const context = await ctxOf(fileDiff('src/big.mjs'));
  const rules = findAutofixViolations({ changes: [patch('src/b.mjs', 'export const b = 3;\n'), patch('src/big.mjs', 'export const big = 1;\n')], context, root, mentionText: '' }).map((v) => `${v.targetPath}:${v.rule}`);
  assert.deepEqual(rules, ['src/b.mjs:unshown_file', 'src/big.mjs:withheld_file']);
});

test('findAutofixViolations: a symlink target is a non_regular_target violation and is not read through', async () => {
  const context = await ctxOf(fileDiff('src/a.mjs'));
  const violations = findAutofixViolations({ changes: [patch('src/link.mjs', 'export const x = 1;\n')], context, root, mentionText: '' });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'non_regular_target');
  assert.match(violations[0].reason, /symlink/);
});

test('findAutofixViolations: a new import of a package missing from the manifest is rejected, a declared one is accepted', async () => {
  const context = await ctxOf(fileDiff('src/a.mjs'));
  const bad = findAutofixViolations({ changes: [patch('src/a.mjs', "import x from 'not-declared';\nexport const a = x;\n")], context, root, mentionText: '' });
  assert.deepEqual(bad.map((v) => v.rule), ['unresolved_import']);
  const ok = findAutofixViolations({ changes: [patch('src/a.mjs', "import x from 'left-pad';\nexport const a = x;\n")], context, root, mentionText: '' });
  assert.deepEqual(ok, []);
});

test('buildAutofixContext: onWithheld is optional, a symlink without a callback is still withheld', async () => {
  const ctx = await buildAutofixContext({ root, userPromptTemplate: TEMPLATE, feedbackParts: ['f'], rawDiff: fileDiff('src/link.mjs'), budgets: ROOMY });
  assert.deepEqual([...ctx.hiddenPaths], ['src/link.mjs']);
});

test('findAutofixViolations: a new relative import must resolve to a file on disk or in the same patch', async () => {
  const context = await ctxOf(fileDiff('src/a.mjs'));
  const missing = findAutofixViolations({ changes: [patch('src/a.mjs', "import { nope } from './nope.mjs';\nexport const a = nope;\n")], context, root, mentionText: '' });
  assert.deepEqual(missing.map((v) => v.rule), ['unresolved_import']);
  const onDisk = findAutofixViolations({ changes: [patch('src/a.mjs', "import { b } from './b.mjs';\nexport const a = b;\n")], context, root, mentionText: '' });
  assert.deepEqual(onDisk, []);
  const inPatch = findAutofixViolations({ changes: [patch('src/a.mjs', "import { c } from './c.mjs';\nexport const a = c;\n"), patch('src/c.mjs', 'export const c = 3;\n')], context, root, mentionText: '' });
  assert.ok(!inPatch.some((v) => v.targetPath === 'src/a.mjs'), 'a.mjs resolves its import through the patch');
});
