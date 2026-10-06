import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  RUN_EVALS_LABEL, TRUSTED_PERMISSIONS, REPORT_MARKER, MAX_PROMPT_BYTES, PR_EVAL_DISCLAIMER,
  isTrustedPermission, parseRepeats, checkTrigger, parseRawDiff, isSafePromptPath, suitesForPrompts,
  planPrEvals, collectPrChanges, readPromptContents, validatePlanForApply, applyPlan, compareSuite,
  overallPrStatus, cell, formatPrEvalReport, buildPrEvalReport,
} from '../lib/pr_evals.mjs';
import { summarize } from '../lib/eval_harness.mjs';
import { sha256 } from '../lib/eval_replay_ci.mjs';
import { parseCliArgs as parsePlanArgs, makePlan } from '../plan_pr_evals.mjs';
import { parseCliArgs as parseReportArgs, readPlan, readResults } from '../report_pr_evals.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-evals-'));

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

test('constants: the label and the trusted permissions', () => {
  assert.equal(RUN_EVALS_LABEL, 'run-evals');
  assert.deepEqual(TRUSTED_PERMISSIONS, ['admin', 'maintain', 'write']);
});

test('isTrustedPermission accepts write and above only', () => {
  for (const p of ['admin', 'maintain', 'write', 'WRITE']) assert.equal(isTrustedPermission(p), true, p);
  for (const p of ['triage', 'read', 'none', 'unknown', '', undefined, null]) assert.equal(isTrustedPermission(p), false, String(p));
});

test('parseRepeats defaults to 1 and accepts 1 or 3 only', () => {
  assert.equal(parseRepeats(undefined), 1);
  assert.equal(parseRepeats(''), 1);
  assert.equal(parseRepeats('3'), 3);
  assert.throws(() => parseRepeats('2'), /repeats must be one of 1, 3/);
  assert.throws(() => parseRepeats('x'), /repeats must be one of/);
});

const SHA = 'a'.repeat(40);
const trigger = (over = {}) => checkTrigger({
  eventName: 'pull_request_target', actor: 'alice', permission: 'write', ref: 'refs/heads/main',
  defaultBranch: 'main', expectedSha: SHA, headSha: SHA, ...over,
});

test('checkTrigger passes a writer label on the head it was set on', () => {
  assert.equal(trigger(), null);
  assert.equal(trigger({ eventName: 'workflow_dispatch' }), null);
});

test('checkTrigger refuses an untrusted event, labeler or dispatch ref', () => {
  assert.match(trigger({ eventName: 'pull_request' }), /unsupported event "pull_request"/);
  assert.match(trigger({ permission: 'triage' }), /`alice` has `triage` permission/);
  assert.match(trigger({ permission: '' }), /has `no` permission/);
  assert.match(trigger({ eventName: 'workflow_dispatch', ref: 'refs/heads/feature' }), /dispatched from `refs\/heads\/feature`/);
  // A label event's ref is the base branch: not checked.
  assert.equal(trigger({ ref: 'refs/heads/feature' }), null);
});

test('checkTrigger refuses an unknown or moved PR head', () => {
  assert.match(trigger({ expectedSha: '' }), /PR head SHA unknown/);
  assert.match(trigger({ headSha: null }), /PR head SHA unknown/);
  assert.match(trigger({ headSha: 'b'.repeat(40) }), /head moved since the trigger \(`aaaaaaaaaaaa` → `bbbbbbbbbbbb`\)/);
});

// ---------------------------------------------------------------------------
// Changes and plan
// ---------------------------------------------------------------------------

const rawEntry = (src, dst, status, p) => `:${src} ${dst} ${'1'.repeat(7)} ${'2'.repeat(7)} ${status}\0${p}\0`;

test('parseRawDiff reads modes, status and path of -z output', () => {
  const raw = rawEntry('100644', '100644', 'M', 'prompts/pr-review-system.md') + rawEntry('000000', '120000', 'A', 'prompts/x y.md') + rawEntry('100644', '000000', 'D', 'docs/a.md');
  assert.deepEqual(parseRawDiff(raw), [
    { srcMode: '100644', dstMode: '100644', status: 'M', path: 'prompts/pr-review-system.md' },
    { srcMode: '000000', dstMode: '120000', status: 'A', path: 'prompts/x y.md' },
    { srcMode: '100644', dstMode: '000000', status: 'D', path: 'docs/a.md' },
  ]);
  assert.deepEqual(parseRawDiff(''), []);
  assert.deepEqual(parseRawDiff(undefined), []);
  assert.throws(() => parseRawDiff('garbage\0path\0'), /Unexpected git diff --raw entry/);
});

test('isSafePromptPath keeps normalized paths under prompts/', () => {
  assert.equal(isSafePromptPath('prompts/a.md'), true);
  assert.equal(isSafePromptPath('prompts/sub/a.md'), true);
  for (const p of ['prompts/../scripts/x.mjs', 'prompts//a.md', 'prompts/./a.md', 'prompts\\a.md', 'scripts/a.md', '/prompts/a.md', 42]) {
    assert.equal(isSafePromptPath(p), false, String(p));
  }
});

test('suitesForPrompts maps validation-* and pr-review-* and lists the rest', () => {
  assert.deepEqual(suitesForPrompts(['prompts/pr-review-user.md', 'prompts/auto-fix-system.md']), { suites: ['review'], unmeasured: ['prompts/auto-fix-system.md'] });
  assert.deepEqual(suitesForPrompts(['prompts/validation-user.md', 'prompts/pr-review-system.md']).suites, ['validation', 'review']);
  assert.deepEqual(suitesForPrompts([]), { suites: [], unmeasured: [] });
});

const change = (p, status = 'M', dstMode = '100644') => ({ srcMode: '100644', dstMode, status, path: p });

test('planPrEvals runs the suites of the changed prompts and lists ignored and unmeasured files', () => {
  const plan = planPrEvals({
    changes: [change('prompts/pr-review-system.md'), change('prompts/validation-user.md', 'A'), change('prompts/auto-fix-user.md', 'D', '000000'), change('docs/evals.md'), change('evals/datasets/review.jsonl')],
    pr: 7, headSha: SHA, actor: 'alice', repeats: 3,
  });
  assert.equal(plan.status, 'run');
  assert.equal(plan.reason, null);
  assert.deepEqual(plan.suites, ['validation', 'review']);
  assert.deepEqual(plan.prompts.map((p) => `${p.status} ${p.path}`), ['M prompts/pr-review-system.md', 'A prompts/validation-user.md', 'D prompts/auto-fix-user.md']);
  assert.deepEqual(plan.unmeasured, ['prompts/auto-fix-user.md']);
  assert.deepEqual(plan.ignored, ['docs/evals.md', 'evals/datasets/review.jsonl']);
  assert.deepEqual([plan.pr, plan.head_sha, plan.actor, plan.repeats, plan.version], [7, SHA, 'alice', 3, 1]);
});

test('planPrEvals refuses a PR touching scripts/ or config/', () => {
  const plan = planPrEvals({ changes: [change('prompts/pr-review-system.md'), change('scripts/lib/review_prompt.mjs'), change('config/models.yaml')] });
  assert.equal(plan.status, 'refused');
  assert.deepEqual(plan.refused.map((r) => r.path), ['scripts/lib/review_prompt.mjs', 'config/models.yaml']);
  assert.match(plan.reason, /`scripts\/lib\/review_prompt\.mjs` \(pipeline code or config/);
  assert.match(plan.reason, /Split the prompt change into its own PR/);
});

test('planPrEvals refuses symlinks, submodules, unsafe paths and type changes under prompts/', () => {
  const cases = [
    [change('prompts/pr-review-system.md', 'M', '120000'), /not a regular file \(mode 120000\)/],
    [change('prompts/sub', 'A', '160000'), /not a regular file \(mode 160000\)/],
    [change('prompts/a/../pr-review-system.md'), /unsafe path/],
    [change('prompts/pr-review-system.md', 'T'), /unsupported change type T/],
  ];
  for (const [c, reason] of cases) {
    const plan = planPrEvals({ changes: [c] });
    assert.equal(plan.status, 'refused', c.path);
    assert.match(plan.refused[0].reason, reason);
  }
  // An executable prompt file is still a regular file.
  assert.equal(planPrEvals({ changes: [change('prompts/pr-review-system.md', 'M', '100755')] }).status, 'run');
});

test('planPrEvals with a trigger refusal refuses before looking at the changes', () => {
  const plan = planPrEvals({ changes: [change('prompts/pr-review-system.md')], triggerRefusal: 'nope' });
  assert.deepEqual([plan.status, plan.reason, plan.prompts], ['refused', 'nope', []]);
});

test('planPrEvals has nothing to run without a prompt change or a covering suite', () => {
  const none = planPrEvals({ changes: [change('docs/evals.md')] });
  assert.deepEqual([none.status, none.reason], ['nothing', 'the PR changes no file under `prompts/`']);
  const uncovered = planPrEvals({ changes: [change('prompts/generation-system.md')] });
  assert.equal(uncovered.status, 'nothing');
  assert.match(uncovered.reason, /no eval suite covers `prompts\/generation-system\.md`/);
});

// A real repository: main with two prompts, a PR branch changing one, adding one and a symlink variant.
function gitRepo() {
  const dir = tmp();
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'prompts'));
  fs.writeFileSync(path.join(dir, 'prompts/pr-review-system.md'), 'main review\n');
  fs.writeFileSync(path.join(dir, 'prompts/validation-system.md'), 'main validation\n');
  g('add', '.');
  g('commit', '-q', '-m', 'main');
  g('checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(dir, 'prompts/pr-review-system.md'), 'PR review\n');
  fs.writeFileSync(path.join(dir, 'prompts/pr-review-user.md'), 'PR user\n');
  fs.rmSync(path.join(dir, 'prompts/validation-system.md'));
  g('add', '-A');
  g('commit', '-q', '-m', 'pr');
  g('checkout', '-q', 'main');
  // main moves on after the branch point: not a PR change.
  fs.writeFileSync(path.join(dir, 'README.md'), 'later\n');
  g('add', '.');
  g('commit', '-q', '-m', 'main later');
  return { dir, g, prSha: g('rev-parse', 'pr').trim() };
}

test('collectPrChanges diffs the PR head against its merge base, and readPromptContents reads blobs', () => {
  const { dir, prSha } = gitRepo();
  const { headSha, changes } = collectPrChanges({ head: 'pr', cwd: dir });
  assert.equal(headSha, prSha);
  assert.deepEqual(changes.map((c) => `${c.status} ${c.path}`), ['M prompts/pr-review-system.md', 'A prompts/pr-review-user.md', 'D prompts/validation-system.md']);
  const plan = readPromptContents(planPrEvals({ changes, headSha }), { cwd: dir });
  assert.deepEqual(plan.prompts.map((p) => p.content), ['PR review\n', 'PR user\n', null]);
  assert.deepEqual(plan.suites, ['validation', 'review']);
});

test('readPromptContents rejects a prompt over the size cap', () => {
  const exec = () => Buffer.alloc(MAX_PROMPT_BYTES + 1);
  assert.throws(() => readPromptContents({ head_sha: SHA, prompts: [{ path: 'prompts/a.md', status: 'M' }] }, { exec }), /exceeds 65536/);
});

test('makePlan wires trigger, changes and contents (plan_pr_evals.mjs)', () => {
  const { dir, prSha } = gitRepo();
  const opts = { head: 'pr', expectSha: prSha, event: 'pull_request_target', actor: 'alice', permission: 'admin', ref: 'refs/heads/main', defaultBranch: 'main', pr: 3, repeats: 1 };
  const plan = makePlan(opts, { cwd: dir });
  assert.equal(plan.status, 'run');
  assert.equal(plan.prompts[0].content, 'PR review\n');
  const refused = makePlan({ ...opts, permission: 'read' }, { cwd: dir });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.prompts.length, 0, 'a refused plan carries no content');
});

test('collectPrChanges fails on an unknown head', () => {
  const { dir } = gitRepo();
  assert.throws(() => collectPrChanges({ head: 'nope', cwd: dir }), /nope/);
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const runPlan = (prompts) => ({ version: 1, status: 'run', prompts });

test('validatePlanForApply rejects anything but a well-formed run plan', () => {
  const ok = runPlan([{ path: 'prompts/a.md', status: 'M', content: 'x' }, { path: 'prompts/b.md', status: 'D', content: null }]);
  assert.equal(validatePlanForApply(ok), ok);
  const bad = [
    [{ ...ok, version: 2 }, /unsupported version 2/],
    [null, /unsupported version undefined/],
    [{ ...ok, status: 'refused' }, /status is "refused"/],
    [runPlan([]), /no prompt to apply/],
    [runPlan('x'), /no prompt to apply/],
    [runPlan([{ path: 'scripts/x.mjs', status: 'M', content: 'x' }]), /unsafe prompt path "scripts\/x\.mjs"/],
    [runPlan([null]), /unsafe prompt path undefined/],
    [runPlan([{ path: 'prompts/a.md', status: 'R', content: 'x' }]), /unsupported change type R/],
    [runPlan([{ path: 'prompts/a.md', status: 'A' }]), /missing content/],
    [runPlan([{ path: 'prompts/a.md', status: 'A', content: 'x'.repeat(MAX_PROMPT_BYTES + 1) }]), /content exceeds/],
  ];
  for (const [plan, re] of bad) assert.throws(() => validatePlanForApply(plan), re);
});

test('applyPlan writes, creates and deletes prompts under root', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'prompts/a.md'), 'main a');
  fs.writeFileSync(path.join(root, 'prompts/gone.md'), 'main gone');
  const applied = applyPlan(runPlan([
    { path: 'prompts/a.md', status: 'M', content: 'PR a' },
    { path: 'prompts/sub/new.md', status: 'A', content: 'PR new' },
    { path: 'prompts/gone.md', status: 'D', content: null },
    { path: 'prompts/never-existed.md', status: 'D', content: null },
  ]), { root });
  assert.deepEqual(applied, ['M prompts/a.md', 'A prompts/sub/new.md', 'D prompts/gone.md', 'D prompts/never-existed.md']);
  assert.equal(fs.readFileSync(path.join(root, 'prompts/a.md'), 'utf8'), 'PR a');
  assert.equal(fs.readFileSync(path.join(root, 'prompts/sub/new.md'), 'utf8'), 'PR new');
  assert.equal(fs.existsSync(path.join(root, 'prompts/gone.md')), false);
});

test('applyPlan never writes through a symlink in the checkout', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'keep');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'prompts/a.md'));
  assert.throws(() => applyPlan(runPlan([{ path: 'prompts/a.md', status: 'M', content: 'x' }]), { root }), /refusing to write through a symlink/);
  assert.equal(fs.readFileSync(path.join(root, 'secret.txt'), 'utf8'), 'keep');
});

test('applyPlan re-checks the resolved path', () => {
  // isSafePromptPath already rejects it; a stubbed validator would still be caught by the resolve check.
  const fsImpl = { lstatSync: () => undefined };
  assert.throws(() => applyPlan(runPlan([{ path: 'prompts/../x.md', status: 'M', content: 'x' }]), { root: tmp(), fsImpl }), /unsafe prompt path/);
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const toySuite = { name: 'toy', thresholds: { 'scores.ok.mean': { min: 0.8 }, consistency: { min: 0.9, optional: true }, error_rate: { max: 0.05 } } };
const r = (case_id, ok, { repeat = 0, error = null } = {}) => ({
  case_id, repeat, error, label: error ? null : ok ? 'a' : 'b', expected_label: 'a', scores: { ok: error ? 0 : ok ? 1 : 0 }, duration_ms: 1, calls: [],
});
const resultsFile = (results, meta = {}) => ({ meta: { run_id: 'pr-1', model: 'groq:m', repeats: 1, dataset_sha256: 'h1', suite: 'toy', ...meta }, summary: summarize(results), results });
const published = (results, meta = {}) => ({ recorded: { ...resultsFile(results, { run_id: '100', ts: '2026-10-05T10:00:00Z', ...meta }) } });
const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
const allOk = () => ids.map((id) => r(id, true));

test('compareSuite: no results file is an error', () => {
  assert.deepEqual(compareSuite({ suite: toySuite, results: undefined, published: {} }), { suite: 'toy', status: 'error', reason: 'no results file (the eval step crashed or was cancelled)' });
});

test('compareSuite: same dataset and all thresholds met passes', () => {
  const rep = compareSuite({ suite: toySuite, results: resultsFile(allOk()), published: published(allOk()) });
  assert.equal(rep.status, 'pass');
  assert.deepEqual(rep.notes, []);
  assert.deepEqual(rep.changes, []);
  assert.equal(rep.deltas.find((d) => d.metric === 'scores.ok.mean').delta, 0);
});

test('compareSuite: a threshold met on main and missed with the PR prompts fails, with the flipped cases', () => {
  const pr = [r('c1', false), r('c2', false), ...ids.slice(2).map((id) => r(id, true))];
  const rep = compareSuite({ suite: toySuite, results: resultsFile(pr), published: published(allOk()) });
  assert.equal(rep.status, 'fail');
  assert.deepEqual(rep.gate.blocking.map((f) => f.metric), ['scores.ok.mean']);
  assert.deepEqual(rep.changes.map((c) => [c.case_id, c.before, c.after]), [['c1', 'a', 'b'], ['c2', 'a', 'b']]);
  assert.equal(rep.deltas.find((d) => d.metric === 'scores.ok.mean').delta, -0.4);
});

test('compareSuite: a threshold already missed on main is pre-existing (warn)', () => {
  const bad = [r('c1', false), r('c2', false), ...ids.slice(2).map((id) => r(id, true))];
  const rep = compareSuite({ suite: toySuite, results: resultsFile(bad), published: published(bad) });
  assert.equal(rep.status, 'warn');
  assert.deepEqual(rep.gate.preexisting.map((f) => f.metric), ['scores.ok.mean']);
});

test('compareSuite: a changed dataset compares the common cases and makes thresholds advisory', () => {
  const main = [...allOk(), r('old', true)];
  const pr = [r('c1', false), ...ids.slice(1).map((id) => r(id, true)), r('new', false)];
  const rep = compareSuite({ suite: toySuite, results: resultsFile(pr, { dataset_sha256: 'h2' }), published: published(main) });
  assert.equal(rep.status, 'warn');
  assert.equal(rep.dataset.status, 'changed');
  assert.deepEqual([...rep.dataset.common].sort(), ids);
  assert.match(rep.notes[0], /dataset changed since the published run: Δ over the 5 common case\(s\)/);
  assert.deepEqual(rep.gate.blocking, []);
  assert.deepEqual(rep.gate.advisory.map((f) => f.metric), ['scores.ok.mean']);
  assert.equal(rep.deltas.find((d) => d.metric === 'scores.ok.mean').after, 0.8);
});

test('compareSuite: a missing dataset hash on the PR side is "unknown"', () => {
  const rep = compareSuite({ suite: toySuite, results: resultsFile(allOk(), { dataset_sha256: null }), published: published(allOk()) });
  assert.equal(rep.dataset.status, 'unknown');
  assert.match(rep.notes[0], /hash missing on one side/);
});

test('compareSuite: a different model or repeat count is noted', () => {
  const rep = compareSuite({ suite: toySuite, results: resultsFile(allOk(), { model: 'groq:new' }), published: published([...allOk(), ...ids.map((id) => r(id, true, { repeat: 1 }))], { repeats: 2 }) });
  assert.equal(rep.status, 'warn');
  assert.match(rep.notes.join('\n'), /model differs \(main `groq:m`, PR `groq:new`\)/);
  assert.match(rep.notes.join('\n'), /repeats differ \(main 2, PR 1\)/);
  const noMeta = compareSuite({ suite: toySuite, results: { ...resultsFile(allOk()), meta: undefined }, published: { recorded: { ...published(allOk()).recorded, meta: undefined } } });
  assert.equal(noMeta.dataset.status, 'unknown');
  assert.deepEqual(noMeta.notes.length, 1, 'same (missing) model and repeats on both sides');
});

test('compareSuite: no published run still reports the PR numbers', () => {
  const rep = compareSuite({ suite: toySuite, results: resultsFile([r('c1', false)]), published: { missing: 'no live run published for this suite' } });
  assert.equal(rep.status, 'warn');
  assert.equal(rep.reason, 'no live run published for this suite');
  assert.deepEqual(rep.gate.advisory.map((f) => f.metric), ['scores.ok.mean']);
  assert.equal(rep.deltas.find((d) => d.metric === 'scores.ok.mean').before, null);
  assert.equal(compareSuite({ suite: toySuite, results: resultsFile(allOk()), published: undefined }).reason, 'no published run');
});

test('overallPrStatus keeps the worst', () => {
  assert.equal(overallPrStatus([]), 'pass');
  assert.equal(overallPrStatus([{ status: 'pass' }, { status: 'warn' }]), 'warn');
  assert.equal(overallPrStatus([{ status: 'fail' }, { status: 'warn' }]), 'fail');
  assert.equal(overallPrStatus([{ status: 'fail' }, { status: 'error' }, { status: 'pass' }]), 'error');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

test('cell neutralizes table breaks, mentions and HTML in model-derived text', () => {
  assert.equal(cell('a|b\nc @admin <!-- x -->'), 'a\\|b c @​admin &lt;!-- x -->');
  assert.equal(cell(null), '');
  assert.equal(cell('x'.repeat(500)).length, 160);
});

const okPlan = (over = {}) => ({
  version: 1, status: 'run', reason: null, pr: 7, head_sha: SHA, actor: 'alice', repeats: 1, suites: ['toy'],
  prompts: [{ path: 'prompts/pr-review-system.md', status: 'M', content: 'x' }], unmeasured: [], ignored: [], refused: [], ...over,
});

test('formatPrEvalReport: missing, refused and empty plans', () => {
  const missing = formatPrEvalReport({ plan: null, runUrl: 'https://run' });
  assert.ok(missing.startsWith(REPORT_MARKER));
  assert.match(missing, /failed before planning[\s\S]*\[Workflow run\]\(https:\/\/run\)/);
  const refused = formatPrEvalReport({ plan: planPrEvals({ changes: [change('scripts/x.mjs')] }) });
  assert.match(refused, /# ⛔ Live eval refused/);
  assert.match(refused, /\| `scripts\/x\.mjs` \| pipeline code or config/);
  assert.match(refused, /label was removed/);
  assert.doesNotMatch(refused, /Workflow run/);
  const triggerRefused = formatPrEvalReport({ plan: planPrEvals({ changes: [], triggerRefusal: 'untrusted' }) });
  assert.doesNotMatch(triggerRefused, /\| File \|/);
  const nothing = formatPrEvalReport({ plan: planPrEvals({ changes: [change('docs/a.md')] }), runUrl: 'u' });
  assert.match(nothing, /# ⚪ Live eval: nothing to run/);
  assert.match(nothing, /`prompts\/validation-\*` → `validation`/);
});

test('formatPrEvalReport: per-suite sections with baseline link, Δ, gates and verdict changes', () => {
  const failing = [r('c1', false, { error: 'bad | output\n@x' }), ...ids.slice(1).map((id) => r(id, true))];
  const reports = [
    compareSuite({ suite: toySuite, results: resultsFile(failing), published: published(allOk()) }),
    compareSuite({ suite: { ...toySuite, name: 'nobase' }, results: resultsFile(allOk()), published: { missing: 'never run' } }),
    compareSuite({ suite: { ...toySuite, name: 'crashed' }, results: undefined }),
  ];
  const md = formatPrEvalReport({
    plan: okPlan({ unmeasured: ['prompts/auto-fix-user.md'], ignored: Array.from({ length: 21 }, (_, i) => `docs/${i}.md`) }),
    reports, siteUrl: 'https://o.github.io/r/', runUrl: 'https://run', warnings: ['careful'],
  });
  assert.match(md, /^<!-- adl-pr-evals -->\n# ❌ Live eval of this PR's prompts/);
  assert.ok(md.includes(PR_EVAL_DISCLAIMER));
  assert.match(md, /Prompts from `aaaaaaaaaaaa`: `prompts\/pr-review-system\.md` \(M\) · suites `toy` · repeats 1 · triggered by `alice`/);
  assert.match(md, /No eval suite covers `prompts\/auto-fix-user\.md`/);
  assert.match(md, /`docs\/19\.md`, …/);
  assert.match(md, /- ⚠️ careful/);
  assert.match(md, /baseline: \[100\]\(https:\/\/o\.github\.io\/r\/runs\/100\.html\)/);
  assert.match(md, /\| `scores\.ok\.mean` \| 1 \| 0\.8 \| ▼ 0\.2 \|/);
  assert.match(md, /\*\*❌ Thresholds missed with the PR prompts \(met on main\)\*\*/);
  assert.match(md, /\| `c1` \| 0 \| a \| a \| error \| bad \\\| output @​x \|/);
  assert.match(md, /## ⚠️ `nobase`[\s\S]*baseline: none \(never run\)[\s\S]*All thresholds met\./);
  assert.match(md, /## ❌ `crashed`\n\nNot measured: no results file/);
  assert.match(md, /\[Workflow run\]\(https:\/\/run\)$/);
});

test('formatPrEvalReport: no site URL, preexisting and advisory gates, no change, many changes', () => {
  const bad = [r('c1', false), r('c2', false), ...ids.slice(2).map((id) => r(id, true))];
  const pre = compareSuite({ suite: toySuite, results: resultsFile(bad), published: published(bad) });
  const md = formatPrEvalReport({ plan: okPlan(), reports: [pre] });
  assert.match(md, /baseline: `100`/);
  assert.match(md, /Already failing in the published run/);
  assert.match(md, /No case changes verdict\./);
  assert.doesNotMatch(md, /Workflow run/);

  const many = Array.from({ length: 60 }, (_, i) => `k${i}`);
  const flips = compareSuite({ suite: { ...toySuite, thresholds: {} }, results: resultsFile(many.map((id) => r(id, false))), published: published(many.map((id) => r(id, true))) });
  assert.match(formatPrEvalReport({ plan: okPlan(), reports: [flips] }), /\*\*60 case run\(s\) change verdict\*\*[\s\S]*…and 10 more\./);

  const changed = compareSuite({ suite: toySuite, results: resultsFile(bad, { dataset_sha256: 'h2' }), published: published(allOk()) });
  assert.match(formatPrEvalReport({ plan: okPlan(), reports: [changed] }), /Threshold failures \(advisory, dataset differs\)/);
  const noBase = compareSuite({ suite: toySuite, results: resultsFile(bad), published: {} });
  assert.match(formatPrEvalReport({ plan: okPlan(), reports: [noBase] }), /Threshold failures \(advisory, no baseline\)/);
});

test('buildPrEvalReport: a non-run plan makes no site read', async () => {
  const loadPublished = () => assert.fail('must not read the site');
  assert.equal((await buildPrEvalReport({ plan: null, loadPublished })).status, 'error');
  const refused = await buildPrEvalReport({ plan: planPrEvals({ changes: [change('config/x.yaml')] }), loadPublished });
  assert.equal(refused.status, 'refused');
  assert.match(refused.markdown, /refused/);
});

test('buildPrEvalReport: compares each planned suite with the published runs', async () => {
  const pub = published(allOk());
  let asked;
  const out = await buildPrEvalReport({
    plan: okPlan(), suites: { toy: toySuite }, resultsBySuite: { toy: resultsFile(allOk()) },
    loadPublished: async (names) => { asked = names; return { available: true, suites: { toy: pub }, warnings: ['w1'] }; },
  });
  assert.deepEqual(asked, ['toy']);
  assert.equal(out.status, 'pass');
  assert.match(out.markdown, /- ⚠️ w1/);
});

test('buildPrEvalReport: an unreachable dashboard reports the PR numbers without a baseline', async () => {
  const out = await buildPrEvalReport({
    plan: okPlan(), suites: { toy: toySuite }, resultsBySuite: { toy: resultsFile(allOk()) },
    loadPublished: async () => ({ available: false, reason: 'scorecard.json: HTTP 404' }),
  });
  assert.equal(out.status, 'warn');
  assert.match(out.markdown, /eval dashboard unreachable \(scorecard\.json: HTTP 404\): no baseline/);
  assert.match(out.markdown, /baseline: none \(dashboard unreachable\)/);
});

test('buildPrEvalReport: a plan naming an unknown suite fails', async () => {
  await assert.rejects(buildPrEvalReport({ plan: okPlan({ suites: ['ghost'] }), suites: {}, loadPublished: async () => ({}) }), /unknown suite "ghost"/);
});

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

test('plan_pr_evals.mjs parseCliArgs: plan and apply modes', () => {
  const base = ['plan', '--pr', '7', '--head', 'refs/remotes/pr/head', '--event', 'pull_request_target', '--default-branch', 'main', '--out', 'p.json'];
  const opts = parsePlanArgs([...base, '--repeats', '3', '--actor', 'alice']);
  assert.deepEqual([opts.mode, opts.pr, opts.repeats, opts.actor, opts.expectSha, opts.permission], ['plan', 7, 3, 'alice', '', '']);
  assert.equal(parsePlanArgs(base).repeats, 1);
  assert.throws(() => parsePlanArgs(base.filter((a) => a !== '--out' && a !== 'p.json')), /--out is required/);
  assert.throws(() => parsePlanArgs([...base.slice(0, 2), 'x', ...base.slice(3)]), /--pr must be a PR number/);
  assert.throws(() => parsePlanArgs([...base, '--repeats', '5']), /repeats must be one of/);
  assert.deepEqual(parsePlanArgs(['apply', '--plan', 'p.json']), { mode: 'apply', plan: 'p.json' });
  assert.throws(() => parsePlanArgs(['apply']), /--plan is required/);
  assert.throws(() => parsePlanArgs([]), /Usage/);
});

test('report_pr_evals.mjs parseCliArgs, readPlan and readResults', async () => {
  const base = ['--plan', 'p.json', '--results-dir', 'r', '--out', 'o.md'];
  assert.equal(parseReportArgs([...base, '--site-url', 'https://x']).siteUrl, 'https://x');
  assert.throws(() => parseReportArgs(base), /exactly one of --site-url or --site-dir/);
  assert.throws(() => parseReportArgs(['--plan', 'p.json']), /--results-dir is required/);

  const dir = tmp();
  assert.equal(await readPlan(path.join(dir, 'none.json')), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  await assert.rejects(readPlan(path.join(dir, 'bad.json')), SyntaxError);

  assert.deepEqual(await readResults(path.join(dir, 'missing'), ['toy']), {});
  fs.mkdirSync(path.join(dir, 'res/nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'res/nested/toy-1.json'), JSON.stringify({ n: 1 }));
  fs.writeFileSync(path.join(dir, 'res/toy-2.json'), JSON.stringify({ n: 2 }));
  fs.writeFileSync(path.join(dir, 'res/other-1.json'), '{}');
  assert.deepEqual(await readResults(path.join(dir, 'res'), ['toy', 'review']), { toy: { n: 2 } });
  await assert.rejects(readResults(path.join(dir, 'bad.json'), ['toy']), /ENOTDIR/);
});

test('report_pr_evals.mjs end to end over a local site copy', async () => {
  const dir = tmp();
  const results = resultsFile(allOk(), { suite: 'validation' });
  const site = path.join(dir, 'site');
  fs.mkdirSync(path.join(site, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(site, 'scorecard.json'), JSON.stringify({ version: 1, suites: { validation: { runs: [{ run_id: '100' }] } } }));
  fs.writeFileSync(path.join(site, 'runs/100.json'), JSON.stringify({ ...published(allOk(), { suite: 'validation' }).recorded }));
  fs.mkdirSync(path.join(dir, 'results'));
  fs.writeFileSync(path.join(dir, 'results/validation-pr-1.json'), JSON.stringify(results));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(okPlan({ suites: ['validation'] })));
  const out = path.join(dir, 'out/report.md');
  await promisify(execFile)(process.execPath, [
    path.join(REPO_ROOT, 'scripts/report_pr_evals.mjs'), '--plan', path.join(dir, 'plan.json'), '--results-dir', path.join(dir, 'results'),
    '--site-dir', site, '--out', out,
  ], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_RUN_ID: 'test' } });
  const md = await fsp.readFile(out, 'utf8');
  assert.match(md, /## (✅|⚠️) `validation`/);
  assert.match(md, /baseline: `100`/);
  assert.equal(sha256('x').length, 64);
});

test('plan_pr_evals.mjs end to end: plan then apply', async () => {
  const { dir, prSha } = gitRepo();
  const planFile = path.join(dir, 'tmp/plan.json');
  const outputFile = path.join(dir, 'gh-output');
  fs.writeFileSync(outputFile, '');
  const run = (args) => promisify(execFile)(process.execPath, [path.join(REPO_ROOT, 'scripts/plan_pr_evals.mjs'), ...args], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_RUN_ID: 'test' } });
  await run(['plan', '--pr', '3', '--head', 'pr', '--expect-sha', prSha, '--event', 'workflow_dispatch', '--actor', 'alice', '--permission', 'write', '--ref', 'refs/heads/main', '--default-branch', 'main', '--repeats', '3', '--out', planFile]);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'status=run\nsuites=validation review\nrepeats=3\n');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  assert.equal(plan.prompts[0].content, 'PR review\n');
  // apply writes into the repository holding the script; exercised with a plan that cannot pass validation.
  fs.writeFileSync(planFile, JSON.stringify({ ...plan, status: 'refused' }));
  await assert.rejects(run(['apply', '--plan', planFile]), /status is "refused"/);
});

test('every registered eval suite has a prompt prefix, and every prefix names a registered suite', async () => {
  const { SUITES } = await import('../lib/eval_suites.mjs');
  const { SUITE_PROMPT_PREFIXES } = await import('../lib/pr_evals.mjs');
  assert.deepEqual(Object.keys(SUITE_PROMPT_PREFIXES).sort(), Object.keys(SUITES).sort());
  for (const prefix of Object.values(SUITE_PROMPT_PREFIXES)) {
    assert.ok(fs.readdirSync(path.join(REPO_ROOT, 'prompts')).some((f) => `prompts/${f}`.startsWith(prefix)), `no prompt matches ${prefix}`);
  }
});
