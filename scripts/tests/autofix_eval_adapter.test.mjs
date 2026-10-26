import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AUTOFIX_STATUS, runAutofixModelPhase } from '../lib/autofix_eval_adapter.mjs';
import { validateModelOutput, MODEL_OUTPUT_SCHEMA_VERSION } from '../lib/eval_grader.mjs';
import { loadPrompt } from '../lib/prompts.mjs';

let root;

const write = async (rel, content) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
};
const fileDiff = (f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`;
const LONG = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
const CODE = ['export const p1 = 1;', 'export const p2 = 2;', 'export const p3 = 3;', 'export const p4 = 4;', 'export const p5 = 5;'];
const PADDED = `${CODE.join('\n')}\n${'\n'.repeat(35)}`;
const CONFIG = { provider: 'groq', model: 'openai/gpt-oss-120b', maxTokens: 4096, maxInputTokens: 6000 };
const answer = (changes, extra = {}) => JSON.stringify({ summary: 'Fixes the lookup', changes, ...extra });
const change = (target_path, file_content) => ({ target_path, file_content });
const FEEDBACK = 'The lookup throws on an unknown id in src/a.mjs.';
const run = (raw, over = {}) => {
  const calls = [];
  const llm = async (call) => { calls.push(call); return typeof raw === 'function' ? raw(call) : raw; };
  return runAutofixModelPhase({ input: { feedback: FEEDBACK, diff: fileDiff('src/a.mjs') }, root, llm, config: CONFIG, ...over })
    .then((output) => Object.assign(output, { calls }));
};

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-adapter-'));
  await write('package.json', '{"type":"module","dependencies":{}}\n');
  await write('src/a.mjs', 'export const a = 1;\n');
  await write('src/b.mjs', 'export const b = 2;\n');
  await write('src/long.mjs', LONG);
  await write('src/padded.mjs', PADDED);
  await write('src/big.mjs', `export const big = '${'x'.repeat(9000)}';\n`);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('a valid patch is PATCH, in the shape the grader validates, and the production prompts and feedback reach the model', async () => {
  const out = await run(answer([change('src/a.mjs', 'export const a = 2;\n')]));
  assert.equal(out.status, AUTOFIX_STATUS.PATCH);
  assert.equal(out.schema_version, MODEL_OUTPUT_SCHEMA_VERSION);
  assert.deepEqual(out.changes, [{ targetPath: 'src/a.mjs', content: 'export const a = 2;\n' }]);
  assert.equal(out.summary, 'Fixes the lookup');
  assert.deepEqual(out.rules, []);
  const graded = validateModelOutput(out);
  assert.equal(graded.ok, true, 'the artifact passes the grader schema check');
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].systemPrompt, loadPrompt('auto-fix-system'));
  assert.match(out.calls[0].prompt, new RegExp(FEEDBACK.replace(/[.]/g, '\\.')));
  assert.match(out.calls[0].prompt, /### Current file: src\/a\.mjs/);
  assert.deepEqual(out.shown_paths, ['src/a.mjs']);
  assert.ok(out.input_tokens_est > 0);
});

test('the model phase never writes: the fixture is unchanged after a PATCH', async () => {
  await run(answer([change('src/a.mjs', 'export const a = 99;\n')]));
  assert.equal(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8'), 'export const a = 1;\n');
});

test('feedback may be one string or a list; blank parts are dropped and no feedback gives the placeholder', async () => {
  const list = await run(answer([]), { input: { feedback: ['first finding', '  ', 'second finding'], diff: fileDiff('src/a.mjs') } });
  assert.match(list.calls[0].prompt, /first finding\n\n---\n\nsecond finding/);
  const none = await run(answer([]), { input: { feedback: ['', '   '], diff: fileDiff('src/a.mjs') } });
  assert.match(none.calls[0].prompt, /\(No specific review feedback provided\)/);
});

test('an answer that is not JSON, or JSON that is not an object, is UNPARSEABLE with its kind', async () => {
  const text = await run('I cannot help with that.');
  assert.deepEqual([text.status, text.reason], [AUTOFIX_STATUS.UNPARSEABLE, 'json']);
  const array = await run('[]');
  assert.deepEqual([array.status, array.reason], [AUTOFIX_STATUS.UNPARSEABLE, 'shape']);
  assert.deepEqual(text.changes, []);
});

test('`changes: []` is NO_CHANGES with the model\'s reason on one line, bounded to 500 characters', async () => {
  const declined = await run(JSON.stringify({ summary: 's', changes: [], blocked_reason: 'protected\n  path\tonly' }));
  assert.equal(declined.status, AUTOFIX_STATUS.NO_CHANGES);
  assert.equal(declined.blocked_reason, 'protected path only');
  const summaryOnly = await run(JSON.stringify({ summary: 'nothing to do', changes: [] }));
  assert.equal(summaryOnly.blocked_reason, 'nothing to do');
  const bare = await run(JSON.stringify({ changes: [] }));
  assert.equal(bare.blocked_reason, '(no summary)');
  const long = await run(JSON.stringify({ summary: 's', changes: [], blocked_reason: 'y'.repeat(900) }));
  assert.equal(long.blocked_reason.length, 500);
  assert.deepEqual(long.changes, []);
});

test('an answer without a summary, with a missing changes list, or with a duplicate path is INVALID_ANSWER', async () => {
  for (const raw of [
    JSON.stringify({ changes: [change('src/a.mjs', 'x')] }),
    JSON.stringify({ summary: 's' }),
    answer([change('src/a.mjs', 'x'), change('src/a.mjs', 'y')]),
  ]) {
    const out = await run(raw);
    assert.equal(out.status, AUTOFIX_STATUS.INVALID_ANSWER, raw);
    assert.ok(out.reason.length > 0);
    assert.deepEqual(out.changes, []);
  }
});

test('a protected target path is GUARD_REJECTED with the protected_path rule', async () => {
  const out = await run(answer([change('scripts/evil.mjs', 'export const x = 1;\n')]));
  assert.equal(out.status, AUTOFIX_STATUS.GUARD_REJECTED);
  assert.deepEqual(out.rules, ['protected_path']);
  assert.match(out.violations[0].reason, /protected path/);
  assert.deepEqual(out.changes, []);
});

test('a file the model was not shown, or one withheld, is GUARD_REJECTED (ADR-0029)', async () => {
  const unshown = await run(answer([change('src/b.mjs', 'export const b = 3;\n')]));
  assert.equal(unshown.status, AUTOFIX_STATUS.GUARD_REJECTED);
  assert.deepEqual(unshown.violations.map((v) => `${v.targetPath}:${v.rule}`), ['src/b.mjs:unshown_file']);
  const withheld = await run(answer([change('src/big.mjs', 'export const big = 1;\n')]), { input: { feedback: FEEDBACK, diff: fileDiff('src/big.mjs') } });
  assert.deepEqual(withheld.hidden_paths, ['src/big.mjs']);
  assert.deepEqual(withheld.violations.map((v) => v.rule), ['withheld_file']);
});

test('a rewrite that only drops blank lines of a shown file is caught by the shrink guard (ADR-0009), without writing', async () => {
  const out = await run(answer([change('src/padded.mjs', `${CODE.join('\n')}\n`)]), { input: { feedback: FEEDBACK, diff: fileDiff('src/padded.mjs') } });
  assert.equal(out.status, AUTOFIX_STATUS.GUARD_REJECTED);
  assert.deepEqual(out.rules, ['destructive_shrink']);
  assert.match(out.violations[0].reason, /would shrink from 41 to 6 lines.*rewrite rejected \(ADR-0009\)/);
  assert.equal(await fs.readFile(path.join(root, 'src/padded.mjs'), 'utf8'), PADDED);
});

test('the static rules speak first, as in production: a mass deletion is reported alone, not with the shrink guard', async () => {
  const out = await run(answer([change('src/long.mjs', 'export const v0 = 0;\n')]), { input: { feedback: FEEDBACK, diff: fileDiff('src/long.mjs') } });
  assert.equal(out.status, AUTOFIX_STATUS.GUARD_REJECTED);
  assert.deepEqual(out.rules, ['mass_deletion']);
  assert.equal(await fs.readFile(path.join(root, 'src/long.mjs'), 'utf8'), LONG);
});

test('a small rewrite of a long shown file is not a shrink', async () => {
  const out = await run(answer([change('src/long.mjs', LONG.replace('v0 = 0', 'v0 = 100'))]), { input: { feedback: FEEDBACK, diff: fileDiff('src/long.mjs') } });
  assert.equal(out.status, AUTOFIX_STATUS.PATCH);
});

test('a diff over the budget is cut and the cut is reported', async () => {
  const hugeDiff = `${fileDiff('src/a.mjs')}+${'z'.repeat(60_000)}\n`;
  const out = await run(answer([]), { input: { feedback: FEEDBACK, diff: hugeDiff }, config: { ...CONFIG, maxInputTokens: 3000 } });
  assert.equal(out.budget_cuts.diff_truncated, true);
});

test('a bad budget configuration fails before any model call', async () => {
  const calls = [];
  await assert.rejects(
    runAutofixModelPhase({ input: { feedback: FEEDBACK, diff: fileDiff('src/a.mjs') }, root, llm: async (c) => { calls.push(c); return '{}'; }, config: { ...CONFIG, diffRatio: 0.6, feedbackRatio: 0.5 } }),
    /Token budget config error: autofix_diff_ratio \(0\.6\) \+ autofix_feedback_ratio \(0\.5\) must sum to less than 1\.0/,
  );
  assert.deepEqual(calls, []);
});

test('an input without a string diff is rejected with its field path, and a failing model call is an errored run, not a status', async () => {
  await assert.rejects(runAutofixModelPhase({ input: { feedback: 'f' }, root, llm: async () => '{}', config: CONFIG }), /input\.diff must be a string/);
  await assert.rejects(runAutofixModelPhase({ input: null, root, llm: async () => '{}', config: CONFIG }), /input\.diff must be a string/);
  await assert.rejects(run(() => { throw new Error('provider 529'); }), /provider 529/);
});

test('explicit prompts replace the production ones', async () => {
  const out = await run(answer([]), { prompts: { system: 'SYSTEM', user: 'USER {{reviewFeedback}}' } });
  assert.equal(out.calls[0].systemPrompt, 'SYSTEM');
  assert.match(out.calls[0].prompt, /^USER The lookup throws/);
});
