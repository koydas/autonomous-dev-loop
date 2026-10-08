import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, validationSuite, blockerCodes, reviewSuite, findingSeverities, matchesFlag, reviewInputBudget } from '../lib/eval_suites.mjs';
import { filterCases, loadDataset, runSuite, summarize, checkThresholds } from '../lib/eval_harness.mjs';
import { VALIDATION_SYSTEM_PROMPT } from '../lib/issue_validator.mjs';
import { loadPrompt } from '../lib/prompts.mjs';
import { buildChangeClassificationContext } from '../lib/change_classifier.mjs';
import { parseEvidence } from '../lib/review_evidence.mjs';
import { GROQ_MODEL_DEFAULTS } from '../lib/config.mjs';
import { estimateTokens } from '../lib/metrics.mjs';
import { parseCliArgs, resolveReplayRepeats, circuitBreakerMessage } from '../run_evals.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_EVALS = path.join(REPO_ROOT, 'scripts', 'run_evals.mjs');

const llmResponse = ({ valid, score = valid ? 90 : 40, ac = 3 }) => JSON.stringify({
  valid,
  score,
  blockers: valid ? [] : ['No acceptance criteria'],
  warnings: [],
  suggested_ac: Array.from({ length: ac }, (_, i) => `AC ${i}`),
});

// Oracle LLM: answers with each case's expected verdict, so every scorer should pass.
async function oracleLlmFor() {
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  const byId = new Map(cases.map((c) => [c.id, c]));
  return {
    cases,
    llmFor: (key) => async () => {
      const c = byId.get(key.split('#')[0]);
      const score = c.expected.valid ? 90 : Math.min(40, c.expected.score_max ?? 40);
      return llmResponse({ valid: c.expected.valid, score });
    },
  };
}

// ---------------------------------------------------------------------------
// Registry and dataset
// ---------------------------------------------------------------------------

test('SUITES registers every suite under its name with the required contract', () => {
  for (const [name, suite] of Object.entries(SUITES)) {
    assert.equal(suite.name, name);
    assert.equal(typeof suite.stage, 'string');
    assert.equal(typeof suite.dataset, 'string');
    assert.equal(typeof suite.run, 'function');
    assert.ok(Object.keys(suite.scorers).length > 0, `${name} has no scorers`);
  }
});

test('validation dataset parses and covers both verdicts', async () => {
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  assert.ok(cases.length >= 10);
  assert.ok(cases.some((c) => c.expected.valid === true));
  assert.ok(cases.some((c) => c.expected.valid === false));
  for (const c of cases) {
    assert.equal(typeof c.input.title, 'string', `${c.id}: input.title`);
    assert.equal(typeof c.input.body, 'string', `${c.id}: input.body`);
    assert.equal(typeof c.expected.valid, 'boolean', `${c.id}: expected.valid`);
  }
});

test('validation dataset labels agree with their tags and the score >= 70 rule', async () => {
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  for (const c of cases) {
    const label = c.expected.valid ? 'valid' : 'invalid';
    assert.ok(c.tags.includes(label), `${c.id}: missing "${label}" tag`);
    assert.ok(!c.tags.includes(c.expected.valid ? 'invalid' : 'valid'), `${c.id}: tagged with the opposite verdict`);
    if (c.expected.valid) assert.ok(c.expected.score_min == null || c.expected.score_min >= 70, `${c.id}: score_min < 70 on a valid case`);
    else assert.ok(c.expected.score_max == null || c.expected.score_max <= 69, `${c.id}: score_max >= 70 on an invalid case`);
  }
});

test('validation dataset keeps enough support per class and every edge-case tag selectable with --tags', async () => {
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  // Absolute support, not a share: per-class recall needs enough cases on each side.
  const nValid = cases.filter((c) => c.expected.valid).length;
  assert.ok(nValid >= 12, `only ${nValid} valid cases`);
  assert.ok(cases.length - nValid >= 12, `only ${cases.length - nValid} invalid cases`);
  for (const tag of ['partial-ac', 'role-scope', 'scope-pair', 'stub', 'short', 'fr', 'warnings-only', 'injection']) {
    assert.ok(filterCases(cases, { tags: [tag] }).length >= 2, `--tags ${tag} selects fewer than 2 cases`);
  }
  // Boundary pairs: both sides of B3 (scope) and B4 (stub/ticket) are present.
  for (const tag of ['scope-pair', 'stub']) {
    const pair = filterCases(cases, { tags: [tag] });
    assert.ok(pair.some((c) => c.expected.valid) && pair.some((c) => !c.expected.valid), `${tag} cases cover only one verdict`);
  }
});

test('validation dataset: each targeted case aims at exactly one rule, and expected.blockers matches it', async () => {
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  const ruleTags = (c) => c.tags.filter((t) => /^b[1-4]$/.test(t));
  for (const c of filterCases(cases, { tags: ['partial-ac', 'role-scope', 'scope-pair', 'stub'] })) {
    assert.equal(ruleTags(c).length, 1, `${c.id}: needs exactly one b1..b4 tag`);
    if (!c.expected.valid) assert.deepEqual(c.expected.blockers, [ruleTags(c)[0].toUpperCase()], `${c.id}: expected.blockers`);
  }
  for (const c of cases.filter((x) => x.expected.blockers !== undefined)) {
    assert.equal(c.expected.valid, false, `${c.id}: expected.blockers on a valid case`);
    for (const code of c.expected.blockers) assert.ok(c.tags.includes(code.toLowerCase()), `${c.id}: ${code} without its tag`);
  }
});

test('validation dataset keeps the 15 core cases and only invalid injection cases', async () => {
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  assert.equal(filterCases(cases, { tags: ['core'] }).length, 15);
  for (const c of filterCases(cases, { tags: ['injection'] })) assert.equal(c.expected.valid, false, `${c.id}: an injection must not pass the gate`);
  // An injection only discriminates when the issue would be rejected for one subtle reason without it.
  assert.ok(filterCases(cases, { tags: ['injection'] }).filter((c) => c.expected.blockers?.length === 1).length >= 2, 'fewer than 2 single-flaw injection cases');
});

// ---------------------------------------------------------------------------
// validationSuite
// ---------------------------------------------------------------------------

test('validationSuite.run sends the validation system prompt and the issue to the LLM', async () => {
  let seen;
  const output = await validationSuite.run(
    { title: '[FEATURE] Add X', body: 'Body text' },
    { llm: async (args) => { seen = args; return llmResponse({ valid: true }); } },
  );
  assert.equal(seen.systemPrompt, VALIDATION_SYSTEM_PROMPT);
  assert.match(seen.prompt, /Add X/);
  assert.match(seen.prompt, /Body text/);
  assert.equal(output.valid, true);
});

test('validationSuite.run short-circuits a tag-only title without calling the LLM', async () => {
  const output = await validationSuite.run({ title: '[FEATURE]', body: '' }, { llm: async () => assert.fail('LLM called') });
  assert.equal(output.valid, false);
  assert.equal(output.score, 0);
});

test('validationSuite.run throws on an unparseable LLM response', async () => {
  await assert.rejects(validationSuite.run({ title: '[FEATURE] X', body: '' }, { llm: async () => 'not json' }), /No JSON object/);
});

test('verdict_match compares valid flags', () => {
  const { verdict_match } = validationSuite.scorers;
  assert.equal(verdict_match({ valid: true }, { valid: true }), true);
  assert.equal(verdict_match({ valid: true }, { valid: false }), false);
  assert.equal(verdict_match({ valid: true }, null), false);
});

test('score_in_range is not applicable without bounds and checks min/max otherwise', () => {
  const { score_in_range } = validationSuite.scorers;
  assert.equal(score_in_range({ valid: true }, { score: 50 }), null);
  assert.equal(score_in_range({ score_min: 70 }, { score: 70 }), true);
  assert.equal(score_in_range({ score_min: 70 }, { score: 69 }), false);
  assert.equal(score_in_range({ score_max: 69 }, { score: 70 }), false);
  assert.equal(score_in_range({ score_max: 69 }, {}), false);
});

test('blockerCodes extracts B1–B4 prefixes, case-insensitive and deduplicated, ignoring unprefixed blockers', () => {
  assert.deepEqual(blockerCodes(['B2: "user-friendly" is subjective', '**B4** – notifier has no contract', 'b2: again']), ['B2', 'B4']);
  assert.deepEqual(blockerCodes(['No acceptance criteria', 'B5: not a rule', 'AB1: not a prefix']), []);
  assert.deepEqual(blockerCodes(), []);
});

test('blocker_match scores the Jaccard overlap of expected and returned blocker codes', () => {
  const { blocker_match } = validationSuite.scorers;
  assert.equal(blocker_match({ valid: false }, { blockers: ['B2: x'] }), null);
  assert.equal(blocker_match({ blockers: ['B2'] }, null), null);
  assert.equal(blocker_match({ blockers: ['B2'] }, { blockers: ['B2: x'] }), 1);
  assert.equal(blocker_match({ blockers: ['B2'] }, { blockers: ['B2: x', 'B4: y'] }), 0.5);
  assert.equal(blocker_match({ blockers: ['B2'] }, { blockers: ['B1: wrong rule'] }), 0);
  assert.equal(blocker_match({ blockers: ['B2'] }, { blockers: ['unprefixed'] }), 0);
  assert.equal(blocker_match({ blockers: [] }, { blockers: [] }), 1);
});

test('validation system prompt asks for the blocker code prefix that blocker_match reads', () => {
  assert.match(VALIDATION_SYSTEM_PROMPT, /prefixed with the code of the rule it breaks: "B1: …", "B2: …", "B3: …" or "B4: …"/);
});

test('validation prompt blocks a ticketed dependency without a stub, as invalid-b4-pair-ticket expects', async () => {
  assert.match(VALIDATION_SYSTEM_PROMPT, /A ticket, roadmap item or ETA alone does not resolve it/);
  assert.match(VALIDATION_SYSTEM_PROMPT, /an in-progress dependency with a ticket but no stub or mock is still BLOCKED/);
  assert.doesNotMatch(VALIDATION_SYSTEM_PROMPT, /in-progress \(with ticket\), or/);
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  const ticket = cases.find((c) => c.id === 'invalid-b4-pair-ticket');
  assert.equal(ticket?.expected.valid, false);
  assert.deepEqual(ticket.expected.blockers, ['B4']);
});

test('validationSuite gates over-strictness (valid recall) and consistency only when measured', () => {
  assert.deepEqual(validationSuite.thresholds['per_class.valid.recall'], { min: 0.8 });
  assert.deepEqual(validationSuite.thresholds.consistency, { min: 0.9, optional: true });
});

test('suggested_ac_count requires 3–5 AC only when the LLM was called', () => {
  const { suggested_ac_count } = validationSuite.scorers;
  assert.equal(suggested_ac_count({}, { suggested_ac: [] }, { calls: [] }), null);
  assert.equal(suggested_ac_count({}, { suggested_ac: ['a', 'b'] }, { calls: [{}] }), false);
  assert.equal(suggested_ac_count({}, { suggested_ac: ['a', 'b', 'c'] }, { calls: [{}] }), true);
  assert.equal(suggested_ac_count({}, { suggested_ac: Array(6).fill('a') }, { calls: [{}] }), false);
  assert.equal(suggested_ac_count({}, null, { calls: [{}] }), false);
});

test('validation suite end-to-end with an oracle LLM meets every threshold', async () => {
  const { cases, llmFor } = await oracleLlmFor();
  const results = await runSuite({ suite: validationSuite, cases, llmFor });
  const summary = summarize(results);
  assert.equal(summary.error_rate, 0);
  assert.equal(summary.scores.verdict_match.mean, 1);
  assert.equal(summary.scores.score_in_range.mean, 1);
  assert.equal(summary.scores.suggested_ac_count.mean, 1);
  assert.equal(summary.per_class.invalid.recall, 1);
});

test('validation suite: a response without suggested_ac keeps its verdict and scores suggested_ac_count 0, not an error', async () => {
  const { cases, llmFor } = await oracleLlmFor();
  const withoutAc = (key) => async () => {
    const { suggested_ac, ...rest } = JSON.parse(await llmFor(key)());
    return JSON.stringify(rest);
  };
  const results = await runSuite({ suite: validationSuite, cases, llmFor: withoutAc });
  const summary = summarize(results);
  assert.equal(summary.error_rate, 0);
  assert.equal(summary.scores.verdict_match.mean, 1);
  assert.equal(summary.scores.suggested_ac_count.mean, 0);
});

// ---------------------------------------------------------------------------
// run_evals.mjs
// ---------------------------------------------------------------------------

test('parseCliArgs applies defaults and parses options', () => {
  const opts = parseCliArgs(['--suite', 'validation']);
  assert.equal(opts.suite, validationSuite);
  assert.deepEqual([opts.repeats, opts.concurrency, opts.limit, opts.tags, opts.replay], [1, 1, 0, [], undefined]);
  const full = parseCliArgs(['--suite', 'validation', '--repeats', '3', '--tags', 'a, b', '--limit', '2', '--replay', 'f.json']);
  assert.deepEqual([full.repeats, full.tags, full.limit, full.replay], [3, ['a', 'b'], 2, 'f.json']);
});

test('parseCliArgs rejects a missing or unknown suite and bad integers', () => {
  assert.throws(() => parseCliArgs([]), /--suite is required, one of: validation/);
  assert.throws(() => parseCliArgs(['--suite', 'nope']), /--suite is required/);
  assert.throws(() => parseCliArgs(['--suite', 'validation', '--repeats', '0']), /--repeats must be an integer >= 1/);
  assert.throws(() => parseCliArgs(['--suite', 'validation', '--concurrency', 'x']), /--concurrency must be an integer >= 1/);
});

async function runEvals(args, cwd, extraEnv = {}) {
  const env = { ...process.env, GITHUB_RUN_ID: 'test-run', EVAL_HISTORY_FILE: path.join(cwd, 'history.jsonl'), ...extraEnv };
  delete env.GITHUB_STEP_SUMMARY;
  if (!('EVAL_RUN_ID' in extraEnv)) delete env.EVAL_RUN_ID;
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [RUN_EVALS, ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function writeRecording(dir, verdictFor) {
  const { cases } = await oracleLlmFor();
  const results = cases.map((c) => ({
    case_id: c.id,
    repeat: 0,
    calls: [{ raw: llmResponse({ valid: verdictFor(c), score: verdictFor(c) ? 90 : 40 }) }],
  }));
  const file = path.join(dir, 'recorded.json');
  await fs.writeFile(file, JSON.stringify({ meta: { model: 'groq:test' }, results }));
  return file;
}

test('run_evals --replay re-scores a recording, writes results and history, exits 0', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  const { code, stdout } = await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir);
  assert.equal(code, 0);
  assert.match(stdout, /## ✅ All thresholds met/);
  assert.match(stdout, /replay:groq:test/);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.summary.scores.verdict_match.mean, 1);
  const history = (await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(history.length, 1);
  assert.equal(history[0].passed, true);
});

test('run_evals exits 1 and lists failures when a threshold is missed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, () => true); // approves everything
  const { code, stdout } = await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir);
  assert.equal(code, 1);
  assert.match(stdout, /## ❌ Threshold failures/);
  assert.match(stdout, /per_class\.invalid\.recall/);
});

test('run_evals exits 1 on an unknown suite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const { code, stderr } = await runEvals(['--suite', 'nope'], dir);
  assert.equal(code, 1);
  assert.match(stderr, /--suite is required/);
});

test('parseCliArgs parses --scorecard and rejects it with --replay', () => {
  assert.equal(parseCliArgs(['--suite', 'validation']).scorecard, false);
  assert.equal(parseCliArgs(['--suite', 'validation', '--scorecard']).scorecard, true);
  assert.throws(
    () => parseCliArgs(['--suite', 'validation', '--scorecard', '--replay', 'f.json']),
    /--scorecard records live runs only/,
  );
});

test('run_evals results file carries the run timestamp', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.match(saved.meta.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.meta.suite, 'validation');
});

test('run_evals keys results by EVAL_RUN_ID and keeps the workflow run ID for the run link', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir, { EVAL_RUN_ID: 'test-run-validation' });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run-validation.json'), 'utf8'));
  assert.equal(saved.meta.run_id, 'test-run-validation');
  assert.equal(saved.meta.workflow_run_id, 'test-run');
});

test('run_evals falls back to GITHUB_RUN_ID when EVAL_RUN_ID is empty', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir, { EVAL_RUN_ID: '' });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.meta.run_id, 'test-run');
});

test('validation dataset only holds cases the LLM judges (no title-guard short-circuit)', async () => {
  const { isMeaningfulTitle } = await import('../lib/issue_validator.mjs');
  const cases = await loadDataset(path.join(REPO_ROOT, validationSuite.dataset));
  for (const c of cases) assert.ok(isMeaningfulTitle(c.input.title), `${c.id} never reaches the LLM`);
});

test('parseCliArgs marks filtered runs and rejects --scorecard on them', () => {
  assert.equal(parseCliArgs(['--suite', 'validation']).filtered, false);
  assert.equal(parseCliArgs(['--suite', 'validation', '--tags', 'b1']).filtered, true);
  assert.equal(parseCliArgs(['--suite', 'validation', '--limit', '3']).filtered, true);
  assert.equal(parseCliArgs(['--suite', 'validation', '--repeats', '2']).repeatsExplicit, true);
  assert.equal(parseCliArgs(['--suite', 'validation']).repeatsExplicit, false);
  assert.throws(() => parseCliArgs(['--suite', 'validation', '--scorecard', '--tags', 'b1']), /full-dataset runs only/);
  assert.throws(() => parseCliArgs(['--suite', 'validation', '--scorecard', '--limit', '2']), /full-dataset runs only/);
});

test('resolveReplayRepeats uses the recorded count and rejects an explicit mismatch', () => {
  assert.equal(resolveReplayRepeats({ repeats: 3 }, { repeats: 1, repeatsExplicit: false }), 3);
  assert.equal(resolveReplayRepeats({ repeats: 3 }, { repeats: 3, repeatsExplicit: true }), 3);
  assert.equal(resolveReplayRepeats(undefined, { repeats: 1, repeatsExplicit: false }), 1);
  assert.throws(() => resolveReplayRepeats({ repeats: 3 }, { repeats: 1, repeatsExplicit: true }), /does not match the recording \(3 repeats\)/);
});

test('run_evals --replay re-scores every recorded repeat without --repeats', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const { cases } = await oracleLlmFor();
  const results = cases.flatMap((c) => [0, 1].map((repeat) => ({
    case_id: c.id, repeat, calls: [{ raw: llmResponse({ valid: c.expected.valid, score: c.expected.valid ? 90 : 40 }) }],
  })));
  const recorded = path.join(dir, 'recorded.json');
  await fs.writeFile(recorded, JSON.stringify({ meta: { model: 'groq:test', repeats: 2 }, results }));
  const { code } = await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir);
  assert.equal(code, 0);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.summary.n_runs, cases.length * 2);
  assert.equal(saved.summary.consistency, 1);
});

test('run_evals on a filtered replay skips unavailable thresholds and warns about unused recordings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  const { code, stdout, stderr } = await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir, '--tags', 'valid'], dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /## ✅ All thresholds met/);
  assert.match(stderr, /threshold per_class\.invalid\.recall skipped on a filtered run/);
  assert.match(stderr, /recorded run\(s\) not replayed/);
});

test('run_evals records the dataset content hash in the results meta', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(await fs.readFile(path.join(REPO_ROOT, validationSuite.dataset))).digest('hex');
  assert.equal(saved.meta.dataset_sha256, expected);
});

// ---------------------------------------------------------------------------
// reviewSuite
// ---------------------------------------------------------------------------

const REVIEW_FIXTURE = path.join(REPO_ROOT, 'scripts', 'tests', 'fixtures', 'review-replay.json');
const REVIEW_VERDICTS = ['APPROVE', 'REQUEST_CHANGES', 'WITHHELD'];
const loadReviewCases = () => loadDataset(path.join(REPO_ROOT, reviewSuite.dataset));

const reviewText = ({ verdict, issues = [], summary = 'Changes X.' }) => [
  '## 🔍 Automated Code Review', '', '### 🏷️ Change Classification', 'Type: feature | Tests expected: yes — code changes', '',
  '### ✅ Summary', summary, '', '### ⚠️ Issues Found', issues.length ? issues.map((i) => `- ${i}`).join('\n') : 'None.', '',
  '### 🚀 Verdict', verdict,
].join('\n');

// Oracle reviewer: approves the clean cases, requests changes with every must_flag keyword otherwise.
// For an evidence case the LLM verdict differs from the final one (WITHHELD comes from an approval).
const oracleReview = (c) => (c.expected.verdict === 'REQUEST_CHANGES'
  ? reviewText({
    verdict: 'REQUEST_CHANGES',
    summary: ['Changes X.', ...(c.expected.must_note ?? []).map((n) => `Note: ${n.split('|')[0]}.`)].join('\n'),
    issues: (c.expected.must_flag ?? ['bug']).map((f) => `[High] ${f.split('|')[0]} — File: x Lines: 1 Root cause: r Fix: f`),
  })
  : reviewText({ verdict: 'APPROVED' }));

// Runs reviewSuite.run with a stub LLM; returns the output (or error) and the captured request.
async function runReview(input, raw = reviewText({ verdict: 'APPROVED' })) {
  let request;
  try {
    const output = await reviewSuite.run(input, { llm: async (args) => { request = args; return raw; } });
    return { output, request };
  } catch (error) {
    return { error, request };
  }
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const restore = () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  return Promise.resolve().then(fn).finally(restore);
}

const SMALL_DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
const passingEvidence = (status = 'pass', headSha = 'abc1234') => ({
  version: 1, head_sha: headSha, checks: [{ name: 'tests', command: 'npm test', status, exit_code: status === 'pass' ? 0 : 1, output_tail: status === 'fail' ? 'not ok 1 - boom' : '' }],
});

test('review dataset parses, labels every case with a pipeline verdict and its tag', async () => {
  const cases = await loadReviewCases();
  assert.ok(cases.length >= 20, `only ${cases.length} cases`);
  for (const c of cases) {
    for (const field of ['title', 'body', 'diff']) assert.equal(typeof c.input[field], 'string', `${c.id}: input.${field}`);
    assert.match(c.input.diff, /^diff --git a\//, `${c.id}: input.diff is not a unified diff`);
    assert.ok(REVIEW_VERDICTS.includes(c.expected.verdict), `${c.id}: expected.verdict`);
    const label = c.expected.verdict.toLowerCase();
    assert.ok(c.tags.includes(label), `${c.id}: missing "${label}" tag`);
    for (const other of REVIEW_VERDICTS.map((v) => v.toLowerCase()).filter((v) => v !== label)) assert.ok(!c.tags.includes(other), `${c.id}: tagged ${other}`);
    for (const key of ['must_flag', 'must_note']) {
      if (c.expected[key] === undefined) continue;
      assert.equal(c.expected.verdict, 'REQUEST_CHANGES', `${c.id}: ${key} on a case that should not raise findings`);
      assert.ok(Array.isArray(c.expected[key]) && c.expected[key].length > 0, `${c.id}: ${key}`);
      for (const entry of c.expected[key]) assert.ok(entry.split('|').every((k) => k.trim()), `${c.id}: empty keyword in "${entry}"`);
    }
  }
});

test('review dataset keeps support per class and covers every targeted defect and edge case', async () => {
  const cases = await loadReviewCases();
  const n = (v) => cases.filter((c) => c.expected.verdict === v).length;
  assert.ok(n('REQUEST_CHANGES') >= 12, `only ${n('REQUEST_CHANGES')} request_changes cases`);
  assert.ok(n('APPROVE') >= 7, `only ${n('APPROVE')} approve cases`);
  for (const tag of ['off-by-one', 'null', 'shell-injection', 'deleted-test', 'undeclared-import', 'missing-tests', 'truncated', 'test-only', 'automation']) {
    assert.ok(filterCases(cases, { tags: [tag] }).length >= 1, `--tags ${tag} selects no case`);
  }
  for (const tag of ['docs', 'injection', 'evidence', 'pair']) assert.ok(filterCases(cases, { tags: [tag] }).length >= 2, `--tags ${tag} selects fewer than 2 cases`);
  // Minimal pairs: same issue, one buggy and one clean diff.
  const pairs = filterCases(cases, { tags: ['pair'] });
  assert.ok(pairs.filter((c) => c.expected.verdict === 'APPROVE').length >= 3 && pairs.filter((c) => c.expected.verdict === 'REQUEST_CHANGES').length >= 3);
  for (const c of filterCases(cases, { tags: ['injection'] })) assert.equal(c.expected.verdict, 'REQUEST_CHANGES', `${c.id}: an injection must not be approved`);
  for (const c of filterCases(cases, { tags: ['docs'] }).filter((x) => x.expected.verdict === 'APPROVE')) {
    assert.ok(!c.tags.includes('bug'), `${c.id}: clean docs case tagged bug`);
  }
});

test('review dataset: docs-only and test-only cases are classified tests_expected: false (change_classifier)', async () => {
  const cases = await loadReviewCases();
  for (const c of filterCases(cases, { tags: ['docs', 'test-only'] })) {
    assert.match(buildChangeClassificationContext(c.input.diff), /- tests_expected: false/, c.id);
  }
  for (const c of filterCases(cases, { tags: ['missing-tests'] })) {
    const context = buildChangeClassificationContext(c.input.diff);
    assert.match(context, /- tests_expected: true/, c.id);
    assert.match(context, /- has_test_file_changes: false/, c.id);
  }
});

test('review dataset: only truncated cases overflow the production budget, every prompt fits one 8K TPM window', async () => {
  const cases = await loadReviewCases();
  const budget = parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10);
  const maxTokens = parseInt(GROQ_MODEL_DEFAULTS.review_max_tokens, 10);
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    for (const c of cases) {
      const { output, request } = await runReview(c.input);
      assert.equal(output.diff_truncated, c.tags.includes('truncated'), `${c.id}: diff_truncated`);
      const tokens = estimateTokens(request.systemPrompt + request.prompt);
      assert.ok(tokens <= budget && tokens * 1.1 + maxTokens <= 8000, `${c.id}: ~${tokens} input tokens`);
    }
  });
  // Truncation keeps the visible bug: the review can still be judged on it, and must say it saw a partial diff.
  for (const c of filterCases(cases, { tags: ['truncated'] })) {
    const { request } = await runReview(c.input);
    assert.match(request.prompt, /- diff_truncated: true/);
    assert.match(request.prompt, /headers\.get\('retry-after'\)\.trim\(\)/);
    assert.ok(c.expected.must_note?.some((f) => f.includes('truncat')), `${c.id}: must_note the truncation`);
  }
});

test('review dataset: evidence cases carry a valid evidence file for the case head SHA', async () => {
  const cases = await loadReviewCases();
  const withEvidence = cases.filter((c) => c.input.evidence !== undefined);
  assert.deepEqual(withEvidence.map((c) => c.id).sort(), filterCases(cases, { tags: ['evidence'] }).map((c) => c.id).sort());
  for (const c of withEvidence) {
    const parsed = parseEvidence(JSON.stringify(c.input.evidence));
    assert.ok(parsed.ok, `${c.id}: ${parsed.reason}`);
    assert.equal(parsed.evidence.head_sha, c.input.head_sha, `${c.id}: evidence is stale`);
  }
  assert.deepEqual([...new Set(withEvidence.map((c) => c.expected.verdict))].sort(), REVIEW_VERDICTS);
});

test('reviewSuite.run sends the production system prompt and a user prompt with every review context', async () => {
  const { output, request } = await runReview({
    title: 'Fix the counter', body: 'Counter starts at 2.', diff: SMALL_DIFF, dependencies: { ajv: '^8.0.0' }, evidence: passingEvidence(), head_sha: 'abc1234',
  });
  assert.equal(request.systemPrompt, loadPrompt('pr-review-system'));
  assert.match(request.prompt, /Title: Fix the counter/);
  assert.match(request.prompt, /Counter starts at 2\./);
  assert.match(request.prompt, /\+const a = 2;/);
  assert.match(request.prompt, /Change classification context:/);
  assert.match(request.prompt, /### Declared npm dependencies \(from package\.json\)\n- ajv/);
  assert.match(request.prompt, /## Tool evidence\nResults of executing/);
  assert.deepEqual(
    { verdict: output.verdict, llm_verdict: output.llm_verdict, evidence_state: output.evidence_state, diff_truncated: output.diff_truncated, body_truncated: output.body_truncated },
    { verdict: 'APPROVE', llm_verdict: 'APPROVED', evidence_state: 'available', diff_truncated: false, body_truncated: false },
  );
  assert.match(output.review, /### 🚀 Verdict/);
});

test('reviewSuite.run without evidence or body: missing evidence does not withhold approval, empty body gets the production placeholder', async () => {
  const { output, request } = await runReview({ title: 'T', body: '', diff: SMALL_DIFF });
  assert.match(request.prompt, /\(no description provided\)/);
  assert.match(request.prompt, /No usable tool evidence \(missing: no evidence file at evidence[/\\]review-evidence\.json\)/);
  assert.doesNotMatch(request.prompt, /Declared npm dependencies/);
  assert.equal(output.verdict, 'APPROVE');
  assert.equal(output.evidence_state, 'missing');
});

test('reviewSuite.run applies decideVerdict: failing check overrides an approval, unverified or stale evidence withholds it', async () => {
  const base = { title: 'T', body: 'B', diff: SMALL_DIFF, head_sha: 'abc1234' };
  const failing = await runReview({ ...base, evidence: passingEvidence('fail') });
  assert.equal(failing.output.verdict, 'REQUEST_CHANGES');
  assert.equal(failing.output.llm_verdict, 'APPROVED');
  assert.match(failing.output.reason, /failing checks: tests/);
  assert.match(failing.request.prompt, /Output tail of failing check `tests`/);

  const timeout = await runReview({ ...base, evidence: passingEvidence('timeout') });
  assert.equal(timeout.output.verdict, 'WITHHELD');
  assert.match(timeout.output.reason, /unverified checks/);

  const stale = await runReview({ ...base, evidence: passingEvidence('pass', 'def5678') });
  assert.equal(stale.output.verdict, 'WITHHELD');
  assert.equal(stale.output.evidence_state, 'stale');

  const invalid = await runReview({ ...base, evidence: { version: 2 } });
  assert.equal(invalid.output.verdict, 'WITHHELD');
  assert.match(invalid.output.reason, /unsupported evidence version/);

  const rejected = await runReview({ ...base, evidence: passingEvidence() }, reviewText({ verdict: 'REQUEST_CHANGES' }));
  assert.equal(rejected.output.verdict, 'REQUEST_CHANGES');
  assert.equal(rejected.output.reason, null);
});

test('reviewSuite.run throws on a review without a verdict line instead of failing closed', async () => {
  const { error } = await runReview({ title: 'T', body: 'B', diff: SMALL_DIFF }, '### ⚠️ Issues Found\nNone.\n\n### 🚀');
  assert.match(error.message, /No verdict line in the review/);
  const think = await runReview({ title: 'T', body: 'B', diff: SMALL_DIFF }, '<think>Verdict: APPROVED</think>\nno verdict here');
  assert.match(think.error.message, /No verdict line/);
});

test('reviewSuite.run propagates an LLM failure (errored run)', async () => {
  await assert.rejects(reviewSuite.run({ title: 'T', body: 'B', diff: SMALL_DIFF }, { llm: async () => { throw new Error('Groq 429'); } }), /Groq 429/);
});

test('reviewSuite.run follows the provider budget: Groq truncates to review_max_input_tokens, Anthropic keeps the 12,000-char cap', async () => {
  const big = `diff --git a/src/big.js b/src/big.js\n--- /dev/null\n+++ b/src/big.js\n@@ -0,0 +1,900 @@\n${Array.from({ length: 900 }, (_, i) => `+export const value${i} = ${i} * 2; // padding line`).join('\n')}\n`;
  const input = { title: 'T', body: 'B', diff: big };
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    const { output, request } = await runReview(input);
    assert.equal(output.diff_truncated, true);
    assert.ok(estimateTokens(request.systemPrompt + request.prompt) <= parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10));
  });
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: 'test-key', GROQ_API_KEY: undefined }, async () => {
    const { output, request } = await runReview(input);
    assert.equal(output.diff_truncated, true);
    assert.ok(request.prompt.includes(big.slice(0, 11000)));
    assert.ok(!request.prompt.includes(big.slice(0, 12001)));
  });
});

test('findingSeverities reads finding bullets from the Issues Found section only', () => {
  const review = [
    '### 🏷️ Change Classification', '- [High] not a finding (wrong section)',
    '### ⚠️ Issues Found', '- [High] a', '* **[Medium]** b', '- [Low] c', '- note without severity',
    '**🚀 Verdict**', 'REQUEST_CHANGES', '- [High] after the verdict',
  ].join('\n');
  assert.deepEqual(findingSeverities(review), ['high', 'medium', 'low']);
  assert.deepEqual(findingSeverities(reviewText({ verdict: 'APPROVED' })), []);
  assert.deepEqual(findingSeverities('no headings at all\n- [High] x'), []);
  assert.deepEqual(findingSeverities(undefined), []);
});

test('matchesFlag matches any "|" alternative, case-insensitive, ignoring empty alternatives', () => {
  assert.equal(matchesFlag('Uses execSync with a SHELL string', 'inject|shell'), true);
  assert.equal(matchesFlag('Off-by-one in the loop', 'off-by-one'), true);
  assert.equal(matchesFlag('looks fine', 'inject||shell'), false);
  assert.equal(matchesFlag(null, 'x'), false);
});

test('review verdict_match compares the final pipeline verdict', () => {
  const { verdict_match } = reviewSuite.scorers;
  assert.equal(verdict_match({ verdict: 'WITHHELD' }, { verdict: 'WITHHELD', llm_verdict: 'APPROVED' }), true);
  assert.equal(verdict_match({ verdict: 'APPROVE' }, { verdict: 'WITHHELD' }), false);
  assert.equal(verdict_match({ verdict: 'APPROVE' }, null), false);
});

test('flags_issue scores the share of must_flag entries the review mentions, outside the classification section', () => {
  const { flags_issue } = reviewSuite.scorers;
  const review = reviewText({ verdict: 'REQUEST_CHANGES', issues: ['[High] Shell injection via execSync'] });
  assert.equal(flags_issue({ verdict: 'APPROVE' }, { review }), null);
  assert.equal(flags_issue({ verdict: 'REQUEST_CHANGES', must_flag: [] }, { review }), null);
  const rc = { llm_verdict: 'REQUEST_CHANGES', review };
  assert.equal(flags_issue({ must_flag: ['inject|execfilesync'] }, rc), 1);
  assert.equal(flags_issue({ must_flag: ['inject', 'truncat|partial'] }, rc), 0.5);
  // "Tests expected: yes" in the classification section is not a test finding.
  assert.equal(flags_issue({ must_flag: ['test'] }, rc), 0);
  assert.equal(flags_issue({ must_flag: ['inject'] }, null), 0);
});

test('flags_issue ignores a Summary that only describes the diff, and an approving review (#177 review)', () => {
  const { flags_issue } = reviewSuite.scorers;
  const summary = 'Replaces the for loop with recipients.forEach(async …)';
  const approved = reviewText({ verdict: 'APPROVED', summary });
  assert.equal(flags_issue({ must_flag: ['foreach'] }, { llm_verdict: 'APPROVED', review: approved }), 0);
  // Same keyword in the Summary of a rejection for another reason: still not this finding.
  const other = reviewText({ verdict: 'REQUEST_CHANGES', summary, issues: ['[Medium] Missing docs'] });
  assert.equal(flags_issue({ must_flag: ['foreach'] }, { llm_verdict: 'REQUEST_CHANGES', review: other }), 0);
  const found = reviewText({ verdict: 'REQUEST_CHANGES', summary, issues: ['[High] forEach does not await the sends'] });
  assert.equal(flags_issue({ must_flag: ['foreach'] }, { llm_verdict: 'REQUEST_CHANGES', review: found }), 1);
});

test('flags_issue reads must_note outside the classification section, e.g. the truncation note under the summary', () => {
  const { flags_issue } = reviewSuite.scorers;
  const review = reviewText({ verdict: 'REQUEST_CHANGES', summary: 'Adds X.\nNote: the diff is truncated.', issues: ['[High] null header'] });
  const out = { llm_verdict: 'REQUEST_CHANGES', review };
  assert.equal(flags_issue({ must_flag: ['null'], must_note: ['truncat'] }, out), 1);
  assert.equal(flags_issue({ must_note: ['truncat|partial'] }, out), 1);
  assert.equal(flags_issue({ must_flag: ['truncat'] }, out), 0, 'a note is not a finding');
  assert.equal(flags_issue({ must_note: ['tests expected'] }, out), 0, 'the classification section never counts');
  assert.equal(flags_issue({ must_note: ['truncat'] }, { llm_verdict: 'APPROVED', review }), 0);
});

test('findingSeverities keeps reading Issues Found past a bold-only file group line (#177 review)', () => {
  const review = ['### ⚠️ Issues Found', '**scripts/foo.mjs**', '- [High] a', '**Fix:**', '- [Medium] b', '**🚀 Verdict**', 'REQUEST_CHANGES'].join('\n');
  assert.deepEqual(findingSeverities(review), ['high', 'medium']);
  const { no_false_alarm } = reviewSuite.scorers;
  assert.equal(no_false_alarm({ verdict: 'APPROVE' }, { llm_verdict: 'APPROVED', review }), false);
});

test('reviewInputBudget mirrors loadLLMConfig: stage key, then max_input_tokens, validated; none on Anthropic', async () => {
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined }, () => {
    assert.equal(reviewInputBudget(), parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10));
    assert.equal(reviewInputBudget({ review_max_input_tokens: '5000', max_input_tokens: '4000' }), 5000);
    assert.equal(reviewInputBudget({ max_input_tokens: '4000' }), 4000);
    assert.equal(reviewInputBudget({}), null);
    assert.throws(() => reviewInputBudget({ review_max_input_tokens: 'abc' }), /Invalid max_input_tokens for stage "review": abc/);
    assert.throws(() => reviewInputBudget({ review_max_input_tokens: '0' }), /must be a positive integer/);
  });
  await withEnv({ AI_PROVIDER: 'anthropic' }, () => assert.equal(reviewInputBudget({ review_max_input_tokens: 'abc' }), null));
});

test('no_false_alarm applies to clean cases: approved with no High or Medium finding', () => {
  const { no_false_alarm } = reviewSuite.scorers;
  assert.equal(no_false_alarm({ verdict: 'REQUEST_CHANGES' }, { llm_verdict: 'APPROVED', review: '' }), null);
  assert.equal(no_false_alarm({ verdict: 'APPROVE' }, { llm_verdict: 'APPROVED', review: reviewText({ verdict: 'APPROVED' }) }), true);
  assert.equal(no_false_alarm({ verdict: 'APPROVE' }, { llm_verdict: 'APPROVED', review: reviewText({ verdict: 'APPROVED', issues: ['[Low] nit'] }) }), true);
  assert.equal(no_false_alarm({ verdict: 'WITHHELD' }, { llm_verdict: 'APPROVED', review: reviewText({ verdict: 'APPROVED', issues: ['[Medium] x'] }) }), false);
  assert.equal(no_false_alarm({ verdict: 'APPROVE' }, { llm_verdict: 'REQUEST_CHANGES', review: reviewText({ verdict: 'REQUEST_CHANGES' }) }), false);
  assert.equal(no_false_alarm({ verdict: 'APPROVE' }, null), false);
});

test('reviewSuite labels are lowercase verdicts and the gate covers misses, over-severity and errors', () => {
  assert.equal(reviewSuite.label({ verdict: 'REQUEST_CHANGES' }), 'request_changes');
  assert.equal(reviewSuite.expectedLabel({ verdict: 'APPROVE' }), 'approve');
  assert.deepEqual(reviewSuite.thresholds, {
    'scores.verdict_match.mean': { min: 0.75 },
    'per_class.request_changes.recall': { min: 0.8 },
    'per_class.approve.recall': { min: 0.6 },
    consistency: { min: 0.8, optional: true },
    error_rate: { max: 0.05 },
  });
});

test('review suite end-to-end with an oracle reviewer meets every threshold', async () => {
  const cases = await loadReviewCases();
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = await runSuite({ suite: reviewSuite, cases, llmFor: (key) => async () => oracleReview(byId.get(key.split('#')[0])) });
  const summary = summarize(results);
  assert.equal(summary.error_rate, 0);
  assert.equal(summary.scores.verdict_match.mean, 1);
  assert.equal(summary.scores.flags_issue.mean, 1);
  assert.equal(summary.scores.no_false_alarm.mean, 1);
  assert.deepEqual(checkThresholds(summary, reviewSuite.thresholds), []);
});

test('run_evals --suite review --replay scores the hand-written fixture through the production parser', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const { code, stdout } = await runEvals(['--suite', 'review', '--replay', REVIEW_FIXTURE, '--out-dir', dir], dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /## ✅ All thresholds met/);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'review-test-run.json'), 'utf8'));
  assert.equal(saved.meta.suite, 'review');
  const byId = Object.fromEntries(saved.results.map((r) => [r.case_id, r]));
  // Planted failures: a truncated review (no verdict), a missed bug, an over-severe docs review, a wrong reason.
  assert.match(byId['clean-test-only'].error, /No verdict line/);
  assert.equal(byId['bug-async-foreach'].label, 'approve');
  assert.equal(byId['docs-only-runbook-fix'].label, 'request_changes');
  assert.equal(byId['docs-only-runbook-fix'].scores.no_false_alarm, 0);
  assert.equal(byId['bug-undeclared-import'].scores.verdict_match, 1);
  assert.equal(byId['bug-undeclared-import'].scores.flags_issue, 0);
  // Format variants the parser accepts: <think> block, bold heading, inline "**🚀 Verdict:** X".
  assert.equal(byId['bug-null-assignee'].label, 'request_changes');
  assert.equal(byId['clean-null-pair'].label, 'approve');
  assert.equal(byId['clean-execfilesync-pair'].label, 'approve');
  // decideVerdict on recorded output: an approval over a timed-out check is withheld.
  assert.equal(byId['evidence-unverified-timeout'].output.llm_verdict, 'APPROVED');
  assert.equal(byId['evidence-unverified-timeout'].label, 'withheld');
  const { summary } = saved;
  assert.deepEqual(
    [summary.n_cases, summary.error_rate, summary.scores.verdict_match.mean, summary.scores.flags_issue.mean, summary.scores.no_false_alarm.mean],
    [23, 0.0435, 0.8696, 0.8571, 0.7778],
  );
  assert.deepEqual([summary.per_class.request_changes.recall, summary.per_class.approve.recall], [0.9286, 0.75]);
});

test('run_evals --suite review exits 1 when the reviewer approves everything', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const cases = await loadReviewCases();
  const results = cases.map((c) => ({ case_id: c.id, repeat: 0, calls: [{ raw: reviewText({ verdict: 'APPROVED' }) }] }));
  const recorded = path.join(dir, 'recorded.json');
  await fs.writeFile(recorded, JSON.stringify({ meta: { model: 'groq:test' }, results }));
  const { code, stdout } = await runEvals(['--suite', 'review', '--replay', recorded, '--out-dir', dir], dir);
  assert.equal(code, 1);
  assert.match(stdout, /per_class\.request_changes\.recall/);
  assert.doesNotMatch(stdout, /per_class\.approve\.recall/);
});

test('parseCliArgs accepts --suite review', () => {
  assert.equal(parseCliArgs(['--suite', 'review']).suite, reviewSuite);
  assert.throws(() => parseCliArgs([]), /one of: validation, review/);
});

// ---------------------------------------------------------------------------
// run_evals.mjs — circuit breaker and token budget
// ---------------------------------------------------------------------------

const TPD_429 = 'All providers failed: groq: Groq API HTTP error 429: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 198931, Requested 2984. Please try again in 13m47.28s. Need more tokens?"}}, anthropic: Anthropic API HTTP error 401: {"error":{"message":"Invalid API Key"}}';
const eventsOf = (stderr) => stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

test('run_evals aborts on an exhausted daily quota: one ::error::, error_rate 1, skipped runs, exit 1', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  const rec = JSON.parse(await fs.readFile(recorded, 'utf8'));
  rec.results[1] = { ...rec.results[1], calls: [], error: TPD_429 };
  await fs.writeFile(recorded, JSON.stringify(rec));
  const { code, stdout, stderr } = await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir, { GITHUB_ACTIONS: 'true' });
  assert.equal(code, 1);
  assert.equal(stderr.split('\n').filter((l) => l.startsWith('::error')).length, 1, 'exactly one ::error:: annotation');
  assert.match(stderr, /::error::eval\/eval\.error: .*aborted by the circuit breaker: groq quota \\"tokens per day \(TPD\)\\" exhausted \(limit 200000, used 198931\); retry after 13m47\.28s/);
  assert.match(stderr, /2\/35 runs executed, 33 skipped/);
  const events = eventsOf(stderr).map((e) => e.event);
  assert.ok(events.includes('eval.error') && !events.includes('eval.complete'));
  assert.match(stdout, /## ⛔ Circuit breaker: provider quota exhausted/);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.summary.error_rate, 1);
  assert.equal(saved.summary.circuit_breaker.skipped_runs, 33);
  assert.ok(saved.failures.some((f) => f.metric === 'error_rate'), 'partitionPublishable skips it');
});

test('a breaker-cut run fails on error_rate whether or not the suite gates error_rate', async () => {
  const results = await runSuite({ suite: validationSuite, cases: (await oracleLlmFor()).cases.slice(0, 2), llmFor: () => async () => { throw new Error(TPD_429); } });
  const summary = summarize(results);
  assert.equal(summary.circuit_breaker.skipped_runs, 1);
  const { error_rate: _gate, ...ungated } = validationSuite.thresholds;
  assert.deepEqual(checkThresholds(summary, ungated).filter((f) => f.metric === 'error_rate'), [{ metric: 'error_rate', value: 1, reason: 'circuit breaker: provider quota exhausted' }]);
  assert.deepEqual(checkThresholds(summary, validationSuite.thresholds).filter((f) => f.metric === 'error_rate').map((f) => f.reason), ['1 > max 0.05'], 'no duplicate when the gate already failed');
});

test('circuitBreakerMessage names the quota, usage and retry-after, or says they are unknown', () => {
  assert.equal(
    circuitBreakerMessage({ provider: 'groq', quota: 'tokens per day (TPD)', limit: 200000, used: 198931, retry_after: '13m47.28s', skipped_runs: 8 }, { suite: 'review', nRuns: 10 }),
    'Eval review aborted by the circuit breaker: groq quota "tokens per day (TPD)" exhausted (limit 200000, used 198931); retry after 13m47.28s. 2/10 runs executed, 8 skipped. Provider failure: the run is not published.',
  );
  const bare = circuitBreakerMessage({ provider: 'groq+anthropic', quota: 'every provider refused', limit: null, used: null, retry_after: null, skipped_runs: 0 }, { suite: 's', nRuns: 1 });
  assert.match(bare, /quota "every provider refused" exhausted; retry after: not given by the provider\. 1\/1 runs executed, 0 skipped/);
  assert.match(circuitBreakerMessage({ provider: 'g', quota: 'q', limit: 5, used: null, retry_after: null, skipped_runs: 0 }, { suite: 's', nRuns: 1 }), /\(limit 5, used \?\)/);
});

test('run_evals logs the token estimate at eval.start and refuses a live run over EVAL_TOKEN_BUDGET', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const { code, stderr } = await runEvals(['--suite', 'validation', '--repeats', '3', '--out-dir', dir], dir, { EVAL_TOKEN_BUDGET: '200000', GROQ_API_KEY: '', ANTHROPIC_API_KEY: '' });
  assert.equal(code, 1);
  const start = eventsOf(stderr).find((e) => e.event === 'eval.start');
  assert.deepEqual([start.meta.cases, start.meta.tokens_est, start.meta.tokens_est_per_run, start.meta.tokens_est_source], [35, 283500, 2700, 'static']);
  assert.match(stderr, /Eval validation refused before any LLM call: estimated 283500 tokens \(2700\/run, static\) exceeds EVAL_TOKEN_BUDGET=200000/);
  await assert.rejects(fs.access(path.join(dir, 'validation-test-run.json')), 'no results file: nothing ran');
});

test('run_evals estimates from the last error-free run in EVAL_HISTORY_FILE and rejects an invalid budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  await fs.writeFile(path.join(dir, 'history.jsonl'), 'not json\n' + JSON.stringify({ suite: 'validation', run_id: 'prev', model: 'groq:m', summary: { n_runs: 35, error_rate: 0, tokens_est: { in: 140000, out: 0 } } }) + '\n');
  const over = await runEvals(['--suite', 'validation', '--out-dir', dir], dir, { EVAL_TOKEN_BUDGET: '1000' });
  assert.equal(over.code, 1);
  assert.match(over.stderr, /estimated 140000 tokens \(4000\/run, history:prev\) exceeds EVAL_TOKEN_BUDGET=1000/);
  const bad = await runEvals(['--suite', 'validation', '--out-dir', dir], dir, { EVAL_TOKEN_BUDGET: 'lots' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /EVAL_TOKEN_BUDGET must be a positive integer, got "lots"/);
});

test('run_evals --replay ignores EVAL_TOKEN_BUDGET (no provider call) and logs a zero estimate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const recorded = await writeRecording(dir, (c) => c.expected.valid);
  const { code, stderr } = await runEvals(['--suite', 'validation', '--replay', recorded, '--out-dir', dir], dir, { EVAL_TOKEN_BUDGET: '1' });
  assert.equal(code, 0);
  const start = eventsOf(stderr).find((e) => e.event === 'eval.start');
  assert.deepEqual([start.meta.tokens_est, start.meta.tokens_est_source], [0, 'replay']);
});

test('run_evals still logs eval.start before eval.error when the dataset cannot be read', async () => {
  // A copy of the scripts without evals/datasets/: the dataset read fails before the estimate.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-root-'));
  for (const dir of ['scripts', 'config', 'prompts']) await fs.cp(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const env = { ...process.env, GITHUB_RUN_ID: 'test-run', EVAL_HISTORY_FILE: path.join(root, 'history.jsonl') };
  delete env.GITHUB_STEP_SUMMARY;
  const { code, stderr } = await promisify(execFile)(process.execPath, [path.join(root, 'scripts', 'run_evals.mjs'), '--suite', 'validation'], { cwd: root, env })
    .then((r) => ({ code: 0, ...r }), (err) => ({ code: err.code, stderr: err.stderr }));
  assert.equal(code, 1);
  const events = eventsOf(stderr);
  assert.deepEqual(events.map((e) => e.event), ['eval.start', 'eval.error']);
  assert.deepEqual(events[0].meta, { suite: 'validation', repeats: 1, replay: false });
  assert.match(events[1].meta.error, /ENOENT/);
});
