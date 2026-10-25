import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hunkCharBudget, formatHunks, parseResolutions, resolveFile } from '../lib/conflict_resolver.mjs';

const FILE = '- base entry\n<<<<<<< HEAD\n- ours entry\n||||||| base\n=======\n- theirs entry\n>>>>>>> sha\n- last\n';
const answer = (resolutions) => JSON.stringify({ resolutions });

test('hunkCharBudget: four characters per token left after the fixed prompt, never negative', () => {
  assert.equal(hunkCharBudget({ maxInputTokens: 2500, fixedTokens: 500 }), 8000);
  assert.equal(hunkCharBudget({ maxInputTokens: 100 }), 400);
  assert.equal(hunkCharBudget({ maxInputTokens: 100, fixedTokens: 500 }), 0);
});

test('formatHunks: numbered, three sides, no trailing blank lines', () => {
  const text = formatHunks([{ ours: 'a\n', base: 'b\n', theirs: 'c\n' }, { ours: 'd\n', base: '', theirs: 'e\n' }]);
  assert.match(text, /### Hunk 0\n<<<<<<< ours \(the pull request\)\na\n\|\|\|\|\|\|\| common ancestor\nb\n=======\nc\n>>>>>>> theirs/);
  assert.match(text, /### Hunk 1\n/);
});

test('parseResolutions: a complete, ordered answer; fenced JSON accepted; indexes may come in any order', () => {
  assert.deepEqual(parseResolutions(answer([{ index: 0, content: 'x' }, { index: 1, content: 'y' }]), 2), ['x', 'y']);
  assert.deepEqual(parseResolutions(answer([{ index: 1, content: 'y' }, { index: 0, content: 'x' }]), 2), ['x', 'y']);
  assert.deepEqual(parseResolutions('```json\n' + answer([{ index: 0, content: 'x' }]) + '\n```', 1), ['x']);
});

test('parseResolutions: every malformed answer is a reason-coded error', () => {
  const reason = (raw, count = 1) => { try { parseResolutions(raw, count); } catch (e) { return e.reason; } return null; };
  assert.equal(reason('not json at all'), 'parse_failed');
  assert.equal(reason('{"resolutions": "x"}'), 'model_rejected');
  assert.equal(reason('{}'), 'model_rejected');
  assert.equal(reason(answer([])), 'model_rejected', 'the model declined (blocked_reason): an escalation');
  assert.equal(reason(answer([{ index: 0, content: 'x' }]), 2), 'model_rejected', 'a hunk is missing');
  assert.equal(reason(answer([{ index: 0, content: 'x' }, { index: 0, content: 'y' }]), 2), 'model_rejected', 'a duplicated index');
  assert.equal(reason(answer([{ index: 5, content: 'x' }])), 'model_rejected', 'out of range');
  assert.equal(reason(answer([{ index: '0', content: 'x' }])), 'model_rejected', 'index must be an integer');
  assert.equal(reason(answer([{ index: 0, content: 7 }])), 'model_rejected', 'content must be a string');
  assert.equal(reason(answer([null])), 'model_rejected');
});

test('resolveFile: splices the model hunks, leaves the rest of the file untouched, passes the context to the model', async () => {
  let seen;
  const res = await resolveFile({
    path: 'CHANGELOG.md', resolver: 'changelog', content: FILE, title: 'T'.repeat(500), budgetChars: 10_000,
    callModel: async (input) => { seen = input; return answer([{ index: 0, content: '- theirs entry\n- ours entry\n' }]); },
  });
  assert.deepEqual(res, { ok: true, content: '- base entry\n- theirs entry\n- ours entry\n- last\n', hunks: 1 });
  assert.equal(seen.path, 'CHANGELOG.md');
  assert.equal(seen.resolver, 'changelog');
  assert.equal(seen.title.length, 200, 'the PR title is bounded');
  assert.match(seen.hunks, /### Hunk 0/);
});

test('resolveFile: refusals carry a reason and never call the model when the input is unusable', async () => {
  const never = async () => { throw new Error('model must not be called'); };
  assert.deepEqual(await resolveFile({ path: 'a', resolver: 'generic', content: 'no markers', budgetChars: 99, callModel: never }), { ok: false, reason: 'parse_failed' });
  assert.deepEqual(await resolveFile({ path: 'a', resolver: 'generic', content: '<<<<<<< HEAD\nx\n', budgetChars: 99, callModel: never }), { ok: false, reason: 'parse_failed' });
  assert.deepEqual(await resolveFile({ path: 'a', resolver: 'generic', content: FILE, budgetChars: 10, callModel: never }), { ok: false, reason: 'too_large' });
});

test('resolveFile: a bad answer, a failed post-check or a leftover marker is model_rejected with its rules', async () => {
  const run = (callModel, resolver = 'changelog') => resolveFile({ path: 'CHANGELOG.md', resolver, content: FILE, budgetChars: 10_000, callModel });
  assert.deepEqual(await run(async () => 'garbage'), { ok: false, reason: 'parse_failed' });
  assert.deepEqual(await run(async () => answer([])), { ok: false, reason: 'model_rejected' });
  assert.deepEqual(await run(async () => answer([{ index: 0, content: '- theirs entry\n' }])), { ok: false, reason: 'model_rejected', rules: ['entry_dropped'] });
  assert.deepEqual(await run(async () => answer([{ index: 0, content: '- ours entry\n- theirs entry\n- made up\n' }])), { ok: false, reason: 'model_rejected', rules: ['invented_content'] });
});

test('resolveFile: an error of the model call itself propagates (a provider failure is not an escalation reason)', async () => {
  await assert.rejects(resolveFile({ path: 'a', resolver: 'generic', content: FILE, budgetChars: 10_000, callModel: async () => { throw new Error('All providers failed'); } }), /All providers failed/);
});

test('resolveFile: a marker left in the spliced file is caught even when the hunk looked clean', async () => {
  // The splice leaves the text around the hunks as is: a second block the parser did not see as a conflict cannot exist,
  // but a marker-like line in the context of an unrelated block is still refused.
  const content = 'ok\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n';
  const res = await resolveFile({ path: 'a.txt', resolver: 'generic', content, budgetChars: 999, callModel: async () => answer([{ index: 0, content: 'a\n>>>>>>> still here\n' }]) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'model_rejected');
  assert.ok(res.rules.includes('marker_left'));
});
