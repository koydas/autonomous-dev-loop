import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUITES, validationSuite, blockerCodes, reviewSuite, findingSeverities, matchesFlag, reviewInputBudget, reviewDiffLimits, requiresCutLimits } from '../lib/eval_suites.mjs';
import { filterCases, loadDataset, runSuite, summarize, checkThresholds } from '../lib/eval_harness.mjs';
import { VALIDATION_SYSTEM_PROMPT } from '../lib/issue_validator.mjs';
import { loadPrompt } from '../lib/prompts.mjs';
import { loadReviewSystemPrompt } from '../lib/review_prompt.mjs';
import { buildChangeClassificationContext } from '../lib/change_classifier.mjs';
import { parseEvidence } from '../lib/review_evidence.mjs';
import { GROQ_MODEL_DEFAULTS, loadLLMConfig, reviewMaxDiffChars } from '../lib/config.mjs';
import { estimateTokens } from '../lib/metrics.mjs';
import { validateExpectedFindings, parseFindings } from '../lib/review_findings.mjs';
import { parseDiffChanges } from '../lib/guardrail_review.mjs';
import { parseCliArgs, resolveReplayRepeats, circuitBreakerMessage, liveCallArgs, createLiveLLM, buildLLM, applyEvalOverrides, liveModelId } from '../run_evals.mjs';
import { partitionPublishable, partitionByPublishedModel, runCost } from '../lib/eval_scorecard.mjs';

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

// The adversarial analysis production requires before an approval (ADR-0049): two axes name a risk. `analysis: false` omits it.
const ADVERSARIAL = ['### 🔬 Adversarial Analysis', '- **Robustness** — x.js:1 an empty value is not handled', '- **Side effects** — x.js:1 callers are not in the diff', '- **Type integrity** — none, checked the return shape', '- **Issue fit** — none, the diff matches the issue', ''];
const reviewText = ({ verdict, issues = [], summary = 'Changes X.', analysis = true }) => [
  '## 🔍 Automated Code Review', '', '### 🏷️ Change Classification', 'Type: feature | Tests expected: yes — code changes', '',
  '### ✅ Summary', summary, '', ...(analysis ? ADVERSARIAL : []), '### ⚠️ Issues Found', issues.length ? issues.map((i) => `- ${i}`).join('\n') : 'None.', '',
  '### 🚀 Verdict', verdict,
].join('\n');

// Oracle reviewer: approves the clean cases (one Low finding per must_advise entry), requests changes with every
// must_flag keyword otherwise.
// For an evidence case the LLM verdict differs from the final one (WITHHELD comes from an approval).
// A reviewer cites the files of the diff (a finding about outside code needs quoted evidence, RV-04a).
const firstDiffFile = (c) => parseDiffChanges(c.input.diff)[0]?.after ?? 'x';
// A finding points at lines of the diff (RV-05): the first line of the first hunk.
const firstHunkLine = (c) => c.input.diff.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m)?.[1] ?? '1';
const oracleReview = (c) => (c.expected.verdict === 'REQUEST_CHANGES'
  ? reviewText({
    verdict: 'REQUEST_CHANGES',
    summary: ['Changes X.', ...(c.expected.must_note ?? []).map((n) => `Note: ${n.split('|')[0]}.`)].join('\n'),
    issues: c.expected.findings
      ? c.expected.findings.map((f) => `[${f.severity[0].toUpperCase()}${f.severity.slice(1)}] ${f.match?.split('|')[0] ?? 'defect'} — File: ${f.path} Lines: ${f.lines?.[0] ?? 'unknown'} Root cause: r Fix: f`)
      : (c.expected.must_flag ?? ['bug']).map((f) => `[High] ${f.split('|')[0]} — File: ${firstDiffFile(c)} Lines: ${firstHunkLine(c)} Root cause: r Fix: f`),
  })
  : reviewText({ verdict: 'APPROVED', issues: (c.expected.must_advise ?? []).map((a) => `[Low] ${a.split('|')[0]}: x — File: x Lines: 1`) }));

// Runs reviewSuite.run with a stub LLM; returns the output (or error) and the captured request.
async function runReview(input, raw = reviewText({ verdict: 'APPROVED' }), testCase = undefined) {
  let request;
  try {
    const output = await reviewSuite.run(input, { llm: async (args) => { request = args; return raw; }, testCase });
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

test('review dataset: expected.findings are well formed and only on cases that must be rejected (RV-01)', async () => {
  const cases = await loadReviewCases();
  const withFindings = cases.filter((c) => c.expected.findings !== undefined);
  assert.ok(withFindings.length >= 4, `only ${withFindings.length} cases list their defects`);
  for (const c of withFindings) {
    assert.deepEqual(validateExpectedFindings(c.expected.findings), [], c.id);
    assert.equal(c.expected.verdict, 'REQUEST_CHANGES', `${c.id}: a case that lists defects must be rejected`);
    assert.ok(c.tags.includes('findings'), `${c.id}: tag findings`);
    // A defect points at a file the diff shows, unless it needs context: a file outside the diff, or a repository rule
    // the review is not given, which the diff does not show.
    const shown = new Set([...c.input.diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]));
    for (const f of c.expected.findings.filter((x) => x.needs !== 'context')) assert.ok(shown.has(f.path), `${c.id}/${f.id}: ${f.path} is not in the diff but the defect does not need context`);
  }
  for (const c of cases.filter((x) => x.expected.acceptable_findings !== undefined)) {
    assert.ok(Array.isArray(c.expected.acceptable_findings) && c.expected.acceptable_findings.every((a) => a.path || a.match), `${c.id}: acceptable_findings`);
  }
  // The pinned expectation of the reduced #283 case: six independent defects, each told apart by where and what.
  const grader = withFindings.find((c) => c.id === 'incident-grader-first-push');
  assert.equal(grader.expected.findings.length, 6);
});

test('review dataset: the lines of an expected defect point inside the new file of the diff (RV-01)', async () => {
  for (const c of (await loadReviewCases()).filter((x) => x.expected.findings !== undefined)) {
    for (const f of c.expected.findings.filter((x) => x.lines)) {
      const file = c.input.diff.split(/^diff --git /m).find((part) => part.startsWith(`a/${f.path} `));
      assert.ok(file, `${c.id}/${f.id}: ${f.path} not in the diff`);
      const added = [...file.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].flatMap((m) => [Number(m[1]), Number(m[1]) + Number(m[2] ?? 1) - 1]);
      assert.ok(f.lines[0] >= Math.min(...added) && (f.lines[1] ?? f.lines[0]) <= Math.max(...added), `${c.id}/${f.id}: lines ${f.lines} outside the hunks ${added}`);
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

test('review dataset: only truncated / budget-cut cases overflow the production budget, every prompt fits one 8K TPM window', async () => {
  const cases = await loadReviewCases();
  const budget = parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10);
  const maxTokens = parseInt(GROQ_MODEL_DEFAULTS.review_max_tokens, 10);
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    for (const c of cases) {
      const { output, request } = await runReview(c.input);
      assert.equal(output.diff_truncated, c.tags.includes('truncated') || c.tags.includes('budget-cut'), `${c.id}: diff_truncated`);
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

test('review dataset: incident cases name their source PR and reproduce its shape', async () => {
  const cases = await loadReviewCases();
  const incidents = filterCases(cases, { tags: ['incident'] });
  assert.ok(incidents.length >= 5, `only ${incidents.length} incident cases`);
  for (const c of cases) assert.equal(c.tags.includes('incident'), c.source !== undefined, `${c.id}: source iff incident`);
  for (const c of incidents) assert.match(c.source, /^PR #\d+$/, `${c.id}: source`);
  const byId = Object.fromEntries(incidents.map((c) => [c.id, c]));
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    // #191/#196: documentation only, so tests are not expected: the finding must come from the issue, not gate (a).
    assert.match(buildChangeClassificationContext(byId['incident-note-instead-of-fix'].input.diff), /- tests_expected: false/);
    // #207: the stale-reference hits and the prompt budget reach the prompt; nothing is cut.
    const stale = await runReview(byId['incident-stale-refs-shared-phrasing'].input);
    assert.match(stale.request.prompt, /## Stale references[\s\S]*## Prompt budget impact[\s\S]*## Related ADRs/);
    assert.equal(stale.output.diff_truncated, false);
    // #187: the workflow is shown in full, the test file is cut mid-way, the docs are not shown.
    const cut = await runReview(byId['incident-finding-on-cut-hunks'].input);
    assert.deepEqual(cut.output.unreviewed_code_files, []);
    assert.match(cut.request.prompt, /include: \$\{\{ github\.event_name == 'schedule'/);
    assert.match(cut.request.prompt, /\+test\('nightly\.yml: the ingest job/);
    assert.doesNotMatch(cut.request.prompt, /a manual run of digest|docs\/maintenance\.md b\//);
    // #206: an approval of the clean change is withheld for the cut code file (ADR-0038).
    const code = await runReview(byId['incident-clean-code-cut'].input);
    assert.deepEqual([code.output.verdict, code.output.unreviewed_code_files], ['WITHHELD', ['src/http/status_class.mjs']]);
    // #219: the old character cut ended these diffs mid-line in test.yml (`- nam`, then before the second
    // c8 step). The cut now ends on a hunk boundary before test.yml and the marker names it as not shown.
    for (const id of ['incident-cut-mid-step-name', 'incident-missing-step-in-cut']) {
      const run = await runReview(byId[id].input);
      assert.equal(run.output.diff_truncated, true, id);
      assert.ok(run.output.unreviewed_code_files.includes('.github/workflows/test.yml'), id);
      assert.match(run.request.prompt, /\n… \[diff cut: \d+ more lines not shown, in [^\n]*\.github\/workflows\/test\.yml(?! \(partly)[^\n]*\]\n/, id);
      assert.doesNotMatch(run.request.prompt, /^\+ +- nam?$|Check \w+ coverage/m, id);
      // The hunks of reset-auto-fix.yml before the cut are shown. Where the cut falls depends on the prompt size: with the
      // adversarial protocol (ADR-0049, +~280 tokens) it ends inside that file, before its `Upload run trace` step.
      assert.match(run.request.prompt, /diff --git a\/\.github\/workflows\/reset-auto-fix\.yml[^\n]*\n[\s\S]*?\n@@ [^\n]*\n[\s\S]*\n… \[diff cut: /, `${id}: the reset-auto-fix hunks before the cut are shown`);
    }
  });
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
  assert.equal(request.systemPrompt, loadReviewSystemPrompt({ self: true }));
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

test('reviewSuite.run follows the provider limits: Groq truncates to review_max_input_tokens, Anthropic caps at anthropic_review_max_diff_chars', async () => {
  const padding = (n) => Array.from({ length: n }, (_, i) => `+export const value${i} = ${i} * 2; // padding line`).join('\n');
  const diffOf = (n) => `diff --git a/src/big.js b/src/big.js\n--- /dev/null\n+++ b/src/big.js\n@@ -0,0 +1,${n} @@\n${padding(n)}\n`;
  const big = diffOf(900);
  const input = { title: 'T', body: 'B', diff: big };
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    const { output, request } = await runReview(input);
    assert.equal(output.diff_truncated, true);
    assert.ok(estimateTokens(request.systemPrompt + request.prompt) <= parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10));
  });
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: 'test-key', GROQ_API_KEY: undefined }, async () => {
    // ≈ 45k chars: cut at 12,000 before the amendment, shown whole now.
    const { output, request } = await runReview(input);
    assert.equal(output.diff_truncated, false);
    assert.ok(request.prompt.includes(big.trimEnd()));
    // Past the configured cap (≈ 300k chars > 200,000): boundary cut with the marker, code withheld (ADR-0038).
    const cap = reviewMaxDiffChars('anthropic');
    const huge = diffOf(6000);
    assert.ok(huge.length > cap);
    const cut = await runReview({ title: 'T', body: 'B', diff: huge });
    assert.equal(cut.output.diff_truncated, true);
    assert.ok(cut.request.prompt.includes(huge.slice(0, cap - 1000)));
    assert.ok(!cut.request.prompt.includes(huge.slice(0, cap + 1)));
    assert.match(cut.request.prompt, /\n… \[diff cut: \d+ more lines not shown, in src\/big\.js \(partly shown\)\]\n/);
    assert.deepEqual([cut.output.verdict, cut.output.unreviewed_code_files], ['WITHHELD', ['src/big.js']]);
  });
});

test('reviewSuite.run withholds an approval when code was cut from the reviewed diff, like production (ADR-0038)', async () => {
  const big = `diff --git a/src/big.js b/src/big.js\n--- /dev/null\n+++ b/src/big.js\n@@ -0,0 +1,900 @@\n${Array.from({ length: 900 }, (_, i) => `+export const value${i} = ${i} * 2; // padding line`).join('\n')}\n`;
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    const { output } = await runReview({ title: 'T', body: 'B', diff: big });
    assert.equal(output.llm_verdict, 'APPROVED');
    assert.equal(output.verdict, 'WITHHELD');
    assert.deepEqual(output.unreviewed_code_files, ['src/big.js']);
    assert.match(output.reason, /code cut from the reviewed diff: src\/big\.js/);
    const small = await runReview({ title: 'T', body: 'B', diff: SMALL_DIFF });
    assert.deepEqual(small.output.unreviewed_code_files, []);
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

test('advisory scores must_advise entries raised by a Low finding of Issues Found, at any verdict (#199)', () => {
  const { advisory } = reviewSuite.scorers;
  const low = '[Low] Untested claim: a symlinked month directory is skipped — File: src/x.mjs Lines: 8';
  const approved = { llm_verdict: 'APPROVED', review: reviewText({ verdict: 'APPROVED', issues: [low] }) };
  // Absent or empty field: not applicable.
  assert.equal(advisory({ verdict: 'APPROVE' }, approved), null);
  assert.equal(advisory({ verdict: 'APPROVE', must_advise: [] }, approved), null);
  // Match, any alternative, case-insensitive; no match; a share over several entries.
  assert.equal(advisory({ must_advise: ['untested claim|not exercised'] }, approved), 1);
  assert.equal(advisory({ must_advise: ['no test covers|NOT EXERCISED'] }, approved), 0);
  assert.equal(advisory({ must_advise: ['untested claim', 'retry count'] }, approved), 0.5);
  // Any verdict: the same Low finding in a rejection counts too.
  const rejected = { llm_verdict: 'REQUEST_CHANGES', review: reviewText({ verdict: 'REQUEST_CHANGES', issues: ['[High] null header', low] }) };
  assert.equal(advisory({ must_advise: ['untested claim'] }, rejected), 1);
  // A High or Medium finding with the keyword is no advisory; the keyword in Summary or classification neither.
  for (const severity of ['High', 'Medium']) {
    const review = reviewText({ verdict: 'REQUEST_CHANGES', issues: [`[${severity}] Untested claim: x`] });
    assert.equal(advisory({ must_advise: ['untested claim'] }, { llm_verdict: 'REQUEST_CHANGES', review }), 0, severity);
  }
  const inSummary = reviewText({ verdict: 'APPROVED', summary: 'Untested claim: none here.', issues: ['[Low] nit'] });
  assert.equal(advisory({ must_advise: ['untested claim'] }, { llm_verdict: 'APPROVED', review: inSummary }), 0);
  // The finding's continuation lines belong to it; a bold Low finding is read too.
  const multi = ['### ⚠️ Issues Found', '- **[Low]** Untested claim', '  not exercised by test/x.test.mjs', '- [Medium] other', '### 🚀 Verdict', 'APPROVED'].join('\n');
  assert.equal(advisory({ must_advise: ['not exercised'] }, { llm_verdict: 'APPROVED', review: multi }), 1);
  assert.equal(advisory({ must_advise: ['untested claim'] }, null), 0);
});

test('no_spurious_flag: no must_not_flag entry in Issues Found, at any severity and verdict (#199)', () => {
  const { no_spurious_flag } = reviewSuite.scorers;
  const clean = { llm_verdict: 'APPROVED', review: reviewText({ verdict: 'APPROVED', summary: 'No untested claim here.' }) };
  assert.equal(no_spurious_flag({ verdict: 'APPROVE' }, clean), null);
  assert.equal(no_spurious_flag({ verdict: 'APPROVE', must_not_flag: [] }, clean), null);
  // No match (the Summary does not count) / match at Low, at High, on an approval and on a rejection.
  assert.equal(no_spurious_flag({ must_not_flag: ['untested claim'] }, clean), true);
  for (const [verdict, llm] of [['APPROVED', 'APPROVED'], ['REQUEST_CHANGES', 'REQUEST_CHANGES']]) {
    for (const severity of ['Low', 'High']) {
      const review = reviewText({ verdict, issues: [`[${severity}] Untested claim: x`] });
      assert.equal(no_spurious_flag({ must_not_flag: ['untested claim'] }, { llm_verdict: llm, review }), false, `${verdict} ${severity}`);
    }
  }
  assert.equal(no_spurious_flag({ must_not_flag: ['retry|untested claim'] }, { llm_verdict: 'APPROVED', review: reviewText({ verdict: 'APPROVED', issues: ['[Low] retry wording'] }) }), false);
  assert.equal(no_spurious_flag({ must_not_flag: ['untested claim'] }, null), false);
});

test('review dataset: untested-claim cases reject every variant the positive case accepts, which must name its claim (#199 review)', async () => {
  const cases = filterCases(await loadReviewCases(), { tags: ['untested-claim'] });
  const positive = cases.filter((c) => c.expected.must_advise);
  assert.deepEqual(positive.map((c) => c.id), ['incident-untested-claim-symlink-dir']);
  const [phrase, claim] = positive[0].expected.must_advise;
  // A generic "Untested claim" about the already-tested file claim does not satisfy the claim entry.
  assert.equal(matchesFlag('[Low] Untested claim: a symlinked .csv file is skipped', claim), false);
  assert.equal(matchesFlag('[Low] Untested claim: a symlinked month directory is skipped', claim), true);
  for (const c of cases.filter((x) => !x.expected.must_advise)) {
    assert.deepEqual(c.expected.must_not_flag, [phrase], c.id);
  }
});

test('review dataset: the PR #282 case is a comment-only edit of config/models.yaml, every mapping kept (#284)', async () => {
  const [c] = (await loadReviewCases()).filter((x) => x.id === 'incident-comment-only-config-withheld');
  assert.ok(c, 'incident-comment-only-config-withheld is missing');
  assert.deepEqual([c.source, c.expected, 'requires_cut' in c], ['PR #282', { verdict: 'APPROVE', must_not_flag: ['syntax|parse|yaml error'] }, false]);
  for (const tag of ['approve', 'clean', 'incident', 'config']) assert.ok(c.tags.includes(tag), tag);
  const lines = c.input.diff.split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('diff --git ')), ['diff --git a/config/models.yaml b/config/models.yaml']);
  assert.equal(lines.filter((l) => l.startsWith('@@')).length, 1);
  const body = lines.slice(lines.findIndex((l) => l.startsWith('@@')) + 1).filter(Boolean);
  const removed = body.filter((l) => l.startsWith('-'));
  const added = body.filter((l) => l.startsWith('+'));
  assert.deepEqual([removed.length, added.length], [2, 4]);
  for (const l of [...removed, ...added]) assert.ok(l.slice(1).trim().startsWith('#'), `not a comment: ${l}`);
  // Every YAML mapping is unchanged context, as it reads in the real file.
  const config = (await fs.readFile(path.join(REPO_ROOT, 'config', 'models.yaml'), 'utf8')).split('\n');
  const mappings = body.filter((l) => l.startsWith(' ') && !l.slice(1).trim().startsWith('#') && l.trim());
  assert.ok(mappings.some((l) => l.startsWith(' anthropic_validation:')), 'anthropic_validation is not in the context');
  for (const l of mappings) assert.ok(config.includes(l.slice(1)), `context line not in config/models.yaml: ${l}`);
});

test('advisory and no_spurious_flag leave the existing scorers unchanged on the same outputs (#199)', () => {
  const { flags_issue, no_false_alarm } = reviewSuite.scorers;
  const review = reviewText({ verdict: 'APPROVED', issues: ['[Low] Untested claim: x'] });
  const out = { llm_verdict: 'APPROVED', review };
  const expected = { verdict: 'APPROVE', must_advise: ['untested claim'], must_not_flag: ['other'] };
  assert.equal(flags_issue(expected, out), null);
  assert.equal(no_false_alarm(expected, out), true);
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

test('reviewInputBudget follows the review stage provider (AI_PROVIDER_REVIEW over AI_PROVIDER)', async () => {
  await withEnv({ AI_PROVIDER: 'groq', AI_PROVIDER_REVIEW: 'anthropic', GROQ_API_KEY: 'gk', ANTHROPIC_API_KEY: 'ak' }, () => assert.equal(reviewInputBudget(), null));
  await withEnv({ AI_PROVIDER: 'anthropic', AI_PROVIDER_REVIEW: 'groq', GROQ_API_KEY: 'gk', ANTHROPIC_API_KEY: 'ak' }, () =>
    assert.equal(reviewInputBudget(), parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10)));
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
  assert.equal(summary.scores.advisory.mean, 1);
  assert.equal(summary.scores.no_spurious_flag.mean, 1);
  assert.deepEqual(checkThresholds(summary, reviewSuite.thresholds), []);
  // An oracle that reports exactly the listed defects finds them all and invents none (known-gap cases: their own block).
  const gap = summary.known_gap.scores;
  assert.deepEqual([gap.finding_recall.mean, gap.finding_precision.mean, gap.critical_recall.mean], [1, 1, 1]);
});

const UNTESTED_CLAIM_CASES = ['incident-untested-claim-symlink-dir', 'incident-tested-claim-symlink-dir', 'clean-empty-body-no-claim', 'docs-only-behavior-sentence', 'truncated-claim-tests-past-cut'];

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
  // Incident cases: an approval of a clean diff whose code was cut is withheld (ADR-0038); the known-gap
  // TOCTOU case is missed, as on Groq, and stays out of the gated metrics (ADR-0031 §7).
  assert.equal(byId['incident-clean-code-cut'].label, 'withheld');
  assert.equal(byId['incident-note-instead-of-fix'].scores.flags_issue, 1);
  assert.equal(byId['incident-stale-refs-shared-phrasing'].scores.no_false_alarm, 1);
  // PR #311: a clean change whose review is readable and approved (the format regression it came from is an errored run).
  assert.deepEqual([byId['incident-unreadable-verdict-clean-change'].label, byId['incident-unreadable-verdict-clean-change'].scores.no_false_alarm], ['approve', 1]);
  assert.equal(byId['incident-toctou-untested-claim'].label, 'approve');
  // PR #282 (known-gap): the recorded approval of a comment-only change names one risk axis, so the protocol withholds it (ADR-0049).
  assert.deepEqual([byId['incident-comment-only-config-withheld'].output.llm_verdict, byId['incident-comment-only-config-withheld'].label, byId['incident-comment-only-config-withheld'].scores.no_spurious_flag], ['APPROVED', 'withheld', 1]);
  assert.match(byId['incident-comment-only-config-withheld'].output.reason, /^adversarial protocol not met \(1 of 2 critical points listed\)/);
  // #219: the recorded false REQUEST_CHANGES cite only code files the cut hid, so the verdict is withheld
  // (ADR-0038 amendment); the High / Medium finding itself still counts as a false alarm.
  for (const id of ['incident-cut-mid-step-name', 'incident-missing-step-in-cut']) {
    assert.deepEqual([byId[id].output.llm_verdict, byId[id].label, byId[id].scores.no_false_alarm], ['REQUEST_CHANGES', 'withheld', 0], id);
    assert.match(byId[id].output.reason, /^every finding cites only code cut from the reviewed diff: .*\.github\/workflows\/test\.yml/);
  }
  // #199 untested-claim cases: one Low advisory where no visible test exercises the claim, none elsewhere
  // (supported claim, empty body, docs-only, tests past the cut).
  assert.deepEqual([byId['incident-untested-claim-symlink-dir'].label, byId['incident-untested-claim-symlink-dir'].scores.advisory], ['approve', 1]);
  for (const id of ['incident-tested-claim-symlink-dir', 'clean-empty-body-no-claim', 'docs-only-behavior-sentence', 'truncated-claim-tests-past-cut']) {
    assert.deepEqual([byId[id].label, byId[id].scores.no_spurious_flag, byId[id].scores.no_false_alarm], ['approve', 1, 1], id);
  }
  assert.equal(byId['truncated-claim-tests-past-cut'].output.diff_truncated, true);
  const { summary } = saved;
  // 42 cases run, 36 gated: the six known-gap cases are counted only in summary.known_gap.
  assert.deepEqual(
    [summary.n_cases, summary.error_rate, summary.scores.verdict_match.mean, summary.scores.flags_issue.mean, summary.scores.no_false_alarm.mean],
    [42, 0.0278, 0.9167, 0.8667, 0.8],
  );
  // Finding level (RV-01): the four incident cases that list their defects are known-gap, so the gated metrics
  // above are unchanged and the finding metrics live in summary.known_gap. Recorded answers: a miss (approved), a
  // hit, a miss, and 2 of 6 defects with one invented High finding.
  const r4 = (x) => (x == null ? x : Math.round(x * 1e4) / 1e4); // per-case scores are exact, the summary rounds to 4 decimals
  const fx = (id) => Object.fromEntries(Object.entries(byId[id].scores).map(([k, v]) => [k, r4(v)]));
  // RV-03: the recorded answer approves, the guardrail check finds the removed case in code: the verdict and the finding are the published ones.
  assert.deepEqual([fx('incident-removed-test-case').finding_recall, fx('incident-removed-test-case').finding_precision, fx('incident-removed-test-case').critical_recall], [1, 1, 1]);
  assert.deepEqual([byId['incident-removed-test-case'].output.llm_verdict, byId['incident-removed-test-case'].output.verdict, byId['incident-removed-test-case'].output.guardrail_findings], ['APPROVED', 'REQUEST_CHANGES', [{ rule: 'test_count_drop', path: 'scripts/tests/gate_list.test.mjs' }]]);
  assert.deepEqual([fx('incident-low-continuation-axes').finding_recall, fx('incident-low-continuation-axes').finding_precision, fx('incident-low-continuation-axes').critical_recall], [1, 1, null]);
  assert.deepEqual([fx('incident-docs-contradict-new-behavior').finding_recall, fx('incident-docs-contradict-new-behavior').finding_precision], [0, null]);
  assert.deepEqual([fx('incident-grader-first-push').finding_recall, fx('incident-grader-first-push').finding_precision, fx('incident-grader-first-push').critical_recall], [0.3333, 0.6667, 0]);
  // Why the others were missed is in the results file: each missed defect carries what it takes to see it.
  assert.deepEqual(byId['incident-grader-first-push'].output.finding_analysis, {
    detected: 3,
    matched: ['BUG-3', 'BUG-5'],
    missed: [{ id: 'BUG-1', needs: 'reasoning' }, { id: 'BUG-2', needs: 'reasoning' }, { id: 'BUG-4', needs: 'reasoning' }, { id: 'BUG-6', needs: 'reasoning' }],
    false_positives: 1,
  });
  assert.deepEqual(byId['incident-removed-test-case'].output.finding_analysis.missed, []);
  assert.equal(byId['bug-off-by-one-chunk'].output.finding_analysis, undefined, 'a case without expected.findings has no analysis');
  assert.equal(byId['bug-off-by-one-chunk'].scores.finding_recall, null);
  const gap = summary.known_gap.scores;
  assert.deepEqual([summary.known_gap.n_cases, gap.finding_recall.mean, gap.finding_precision.mean, gap.critical_recall.mean], [6, 0.5833, 0.8889, 0.5]);
  assert.deepEqual([summary.scores.advisory.mean, summary.scores.no_spurious_flag.mean], [1, 1]);
  assert.deepEqual([summary.per_class.request_changes.recall, summary.per_class.approve.recall], [0.9375, 0.875]);
  // The 30 cases before #199 keep their pinned metrics: the new cases and scorers change no existing score.
  const FINDING_CASES = ['incident-removed-test-case', 'incident-low-continuation-axes', 'incident-docs-contradict-new-behavior', 'incident-grader-first-push', 'impact-caller-misses-new-parameter']; // RV-01 / RV-02, known-gap
  // PR #311's case is newer than those 30: it moves the gated aggregates above, not these; PR #282's is newer still (known-gap).
  const before = summarize(saved.results.filter((r) => !UNTESTED_CLAIM_CASES.includes(r.case_id) && !FINDING_CASES.includes(r.case_id) && !['incident-unreadable-verdict-clean-change', 'incident-comment-only-config-withheld'].includes(r.case_id)));
  assert.deepEqual(
    [before.n_cases, before.error_rate, before.scores.verdict_match.mean, before.scores.flags_issue.mean, before.scores.no_false_alarm.mean],
    [30, 0.0345, 0.8966, 0.8667, 0.7143],
  );
  assert.deepEqual([before.per_class.request_changes.recall, before.per_class.approve.recall], [0.9333, 0.8]);
  assert.deepEqual([before.scores.advisory.n, before.scores.no_spurious_flag.n], [0, 0]);
  assert.deepEqual(
    [summary.known_gap.n_cases, summary.known_gap.error_rate, summary.known_gap.scores.verdict_match.mean, summary.known_gap.per_class.request_changes.recall],
    // The #194 case is missed, as on Groq; of the three RV-01 cases left (the fourth is solved in code, RV-03) the recorded answers reject two and approve one; the RV-02 case is rejected; the #282 case is withheld.
    [6, 0, 0.5, 0.6],
  );
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
// The validation dataset only grows (ADR-0031): counts below follow it instead of a frozen number.
const validationCaseCount = async () => (await loadDataset(path.join(REPO_ROOT, validationSuite.dataset))).length;

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
  const n = await validationCaseCount();
  assert.match(stderr, new RegExp(`2/${n} runs executed, ${n - 2} skipped`));
  const events = eventsOf(stderr).map((e) => e.event);
  assert.ok(events.includes('eval.error') && !events.includes('eval.complete'));
  assert.match(stdout, /## ⛔ Circuit breaker: provider quota exhausted/);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.summary.error_rate, 1);
  assert.equal(saved.summary.circuit_breaker.skipped_runs, n - 2);
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
  const n = await validationCaseCount();
  assert.deepEqual([start.meta.cases, start.meta.tokens_est, start.meta.tokens_est_per_run, start.meta.tokens_est_source], [n, n * 3 * 2700, 2700, 'static']);
  assert.match(stderr, new RegExp(`Eval validation refused before any LLM call: estimated ${n * 3 * 2700} tokens \\(2700/run, static\\) exceeds EVAL_TOKEN_BUDGET=200000`));
  await assert.rejects(fs.access(path.join(dir, 'validation-test-run.json')), 'no results file: nothing ran');
});

test('run_evals estimates from the last error-free run in EVAL_HISTORY_FILE and rejects an invalid budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  await fs.writeFile(path.join(dir, 'history.jsonl'), 'not json\n' + JSON.stringify({ suite: 'validation', run_id: 'prev', model: 'groq:m', summary: { n_runs: 35, error_rate: 0, tokens_est: { in: 140000, out: 0 } } }) + '\n');
  const over = await runEvals(['--suite', 'validation', '--out-dir', dir], dir, { EVAL_TOKEN_BUDGET: '1000' });
  assert.equal(over.code, 1);
  assert.match(over.stderr, new RegExp(`estimated ${(await validationCaseCount()) * 4000} tokens \\(4000/run, history:prev\\) exceeds EVAL_TOKEN_BUDGET=1000`));
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

// ---------------------------------------------------------------------------
// run_evals.mjs — live runs are pinned to the primary provider (ADR-0032 amendment)
// ---------------------------------------------------------------------------

// Preloaded into the run_evals child: Groq answers `groqStatus`, Anthropic always answers; every
// Anthropic request is appended to anthropic-calls.log so the test can prove it never happened.
async function writeFetchMock(dir, groqStatus) {
  const file = path.join(dir, 'fetch-mock.mjs');
  const log = JSON.stringify(path.join(dir, 'anthropic-calls.log'));
  await fs.writeFile(file, `
import fs from 'node:fs';
const response = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url) => {
  if (String(url).includes('anthropic')) {
    fs.appendFileSync(${log}, 'call\\n');
    return response(200, { content: [{ type: 'text', text: ${JSON.stringify(llmResponse({ valid: true }))} }] });
  }
  return ${groqStatus} === 200
    ? response(200, { choices: [{ message: { content: ${JSON.stringify(llmResponse({ valid: true }))} } }] })
    : response(${groqStatus}, { error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199900, Requested 2984. Please try again in 13m47.28s.' } });
};
`);
  return file;
}

const liveEnv = (dir, mock) => ({
  GROQ_API_KEY: 'groq-key', ANTHROPIC_API_KEY: 'sk-ant-key', AI_PROVIDER: 'groq', GROQ_MAX_RETRIES: '0',
  EVAL_TOKEN_BUDGET: '', NODE_OPTIONS: `--import ${pathToFileURL(mock).href}`,
});

test('run_evals live: a Groq TPD 429 trips the circuit breaker instead of falling back to Anthropic', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const mock = await writeFetchMock(dir, 429);
  const { code, stderr } = await runEvals(['--suite', 'validation', '--limit', '3', '--out-dir', dir], dir, liveEnv(dir, mock));
  assert.equal(code, 1);
  await assert.rejects(fs.readFile(path.join(dir, 'anthropic-calls.log')), { code: 'ENOENT' }, 'the fallback provider is never called');
  const events = eventsOf(stderr);
  assert.ok(events.some((e) => e.event === 'llm_fallback_disabled'));
  assert.ok(!events.some((e) => e.event === 'llm_fallback'));
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.summary.error_rate, 1);
  assert.equal(saved.summary.circuit_breaker.provider, 'groq');
  assert.equal(saved.summary.circuit_breaker.skipped_runs, 2);
});

test('run_evals live: every call records the provider and model that answered, matching meta.model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const mock = await writeFetchMock(dir, 200);
  const { code, stderr } = await runEvals(['--suite', 'validation', '--limit', '2', '--out-dir', dir], dir, liveEnv(dir, mock));
  assert.equal(code, 0, stderr);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.meta.model, `groq:${GROQ_MODEL_DEFAULTS.validation}`);
  const calls = saved.results.flatMap((r) => r.calls);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((c) => `${c.provider}:${c.model}` === saved.meta.model));
});

// ---------------------------------------------------------------------------
// run_evals.mjs — Anthropic model / effort override for one run (evals.yml inputs, ADR-0032 amendment)
// ---------------------------------------------------------------------------

test('applyEvalOverrides maps EVAL_ANTHROPIC_MODEL / EVAL_ANTHROPIC_EFFORT onto the production variables', () => {
  const env = { EVAL_ANTHROPIC_MODEL: ' claude-opus-5-5 ', EVAL_ANTHROPIC_EFFORT: 'HIGH', ANTHROPIC_MODEL: 'repo-var' };
  assert.deepEqual(applyEvalOverrides(env), { model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(env.ANTHROPIC_MODEL, 'claude-opus-5-5');
  assert.equal(env.ANTHROPIC_EFFORT, 'high');
  const untouched = { EVAL_ANTHROPIC_MODEL: '', ANTHROPIC_MODEL: 'repo-var' };
  assert.deepEqual(applyEvalOverrides(untouched), { model: null, effort: null });
  assert.deepEqual(untouched, { EVAL_ANTHROPIC_MODEL: '', ANTHROPIC_MODEL: 'repo-var' }, 'empty input: models.yaml / repo variables apply');
});

test('liveModelId tags an effort override only', () => {
  const config = { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'low' };
  assert.equal(liveModelId(config), 'anthropic:claude-sonnet-5-5');
  assert.equal(liveModelId(config, { model: 'claude-sonnet-5-5', effort: null }), 'anthropic:claude-sonnet-5-5');
  assert.equal(liveModelId(config, { effort: 'low' }), 'anthropic:claude-sonnet-5-5+effort=low');
  assert.equal(liveModelId({ ...config, reasoningEffort: undefined }, { effort: 'off' }), 'anthropic:claude-sonnet-5-5+effort=off');
});

// Every Anthropic request body is appended to anthropic-payloads.jsonl.
async function writeAnthropicPayloadMock(dir) {
  const file = path.join(dir, 'anthropic-mock.mjs');
  const log = JSON.stringify(path.join(dir, 'anthropic-payloads.jsonl'));
  await fs.writeFile(file, `
import fs from 'node:fs';
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('anthropic')) throw new Error('unexpected provider: ' + url);
  fs.appendFileSync(${log}, opts.body + '\\n');
  return { ok: true, status: 200, text: async () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ${JSON.stringify(llmResponse({ valid: true }))} }] }) };
};
`);
  return file;
}

const overrideEnv = (mock, extra) => ({
  ANTHROPIC_API_KEY: 'sk-ant-key', GROQ_API_KEY: '', AI_PROVIDER: 'anthropic', AI_PROVIDER_VALIDATION: '', ANTHROPIC_MODEL: '', ANTHROPIC_EFFORT: '',
  EVAL_ANTHROPIC_MODEL: '', EVAL_ANTHROPIC_EFFORT: '', EVAL_TOKEN_BUDGET: '', NODE_OPTIONS: `--import ${pathToFileURL(mock).href}`, ...extra,
});
const readPayloads = async (dir) => (await fs.readFile(path.join(dir, 'anthropic-payloads.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('run_evals live: an Anthropic model + effort override reaches the payload and meta.model, never the published history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const mock = await writeAnthropicPayloadMock(dir);
  const { code, stderr } = await runEvals(['--suite', 'validation', '--limit', '2', '--out-dir', dir], dir,
    overrideEnv(mock, { EVAL_ANTHROPIC_MODEL: 'claude-opus-5-5', EVAL_ANTHROPIC_EFFORT: 'high' }));
  assert.equal(code, 0, stderr);
  const payloads = await readPayloads(dir);
  assert.equal(payloads.length, 2);
  for (const p of payloads) {
    assert.equal(p.model, 'claude-opus-5-5');
    assert.deepEqual(p.output_config, { effort: 'high' });
    assert.equal('temperature' in p, false);
    assert.equal('thinking' in p, false);
  }
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.meta.model, 'anthropic:claude-opus-5-5+effort=high');
  assert.ok(saved.results.flatMap((r) => r.calls).every((c) => `${c.provider}:${c.model}` === 'anthropic:claude-opus-5-5'));
  // Not mixed models (the calls match meta.model's model), but never appended to a history of another meta.model:
  // neither the Groq baseline nor the same model at its models.yaml effort.
  assert.deepEqual(partitionPublishable([saved]).skipped, []);
  for (const baseline of [`groq:${GROQ_MODEL_DEFAULTS.validation}`, 'anthropic:claude-opus-5-5']) {
    const scorecard = { version: 1, suites: { validation: { runs: [{ run_id: 'base', model: baseline }] } } };
    const { publishable, skipped } = partitionByPublishedModel(scorecard, [saved]);
    assert.deepEqual(publishable, [], baseline);
    assert.equal(skipped[0].kind, 'model_mismatch');
  }
  assert.equal(runCost({ meta: saved.meta, summary: saved.summary }).unpriced, undefined, 'priced on the base model');
});

test('run_evals live: a model-only override sends the model at the stage effort; meta.model names it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const mock = await writeAnthropicPayloadMock(dir);
  const { code, stderr } = await runEvals(['--suite', 'validation', '--limit', '1', '--out-dir', dir], dir,
    overrideEnv(mock, { EVAL_ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_MODEL: 'claude-opus-5-5' }));
  assert.equal(code, 0, stderr);
  const [payload] = await readPayloads(dir);
  assert.equal(payload.model, 'claude-sonnet-5-5', 'the run input wins over vars.ANTHROPIC_MODEL');
  assert.deepEqual(payload.output_config, { effort: GROQ_MODEL_DEFAULTS.anthropic_validation_effort });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'validation-test-run.json'), 'utf8'));
  assert.equal(saved.meta.model, 'anthropic:claude-sonnet-5-5');
});

test('run_evals live: an Anthropic override on a stage that runs on Groq fails before any call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const mock = await writeAnthropicPayloadMock(dir);
  const { code, stderr } = await runEvals(['--suite', 'validation', '--limit', '1', '--out-dir', dir], dir,
    overrideEnv(mock, { AI_PROVIDER: 'groq', GROQ_API_KEY: 'groq-key', EVAL_ANTHROPIC_EFFORT: 'low' }));
  assert.equal(code, 1);
  assert.match(stderr, /EVAL_ANTHROPIC_MODEL \/ EVAL_ANTHROPIC_EFFORT set, but the validation stage runs on groq: dispatch with provider anthropic/);
  await assert.rejects(fs.readFile(path.join(dir, 'anthropic-payloads.jsonl')), { code: 'ENOENT' });
});

test('run_evals live: an effort override of off on a thinking-always-on model fails fast', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-evals-'));
  const mock = await writeAnthropicPayloadMock(dir);
  const { code, stderr } = await runEvals(['--suite', 'validation', '--limit', '1', '--out-dir', dir], dir,
    overrideEnv(mock, { EVAL_ANTHROPIC_MODEL: 'claude-sonnet-5-5', EVAL_ANTHROPIC_EFFORT: 'off' }));
  assert.equal(code, 1);
  assert.match(stderr, /ANTHROPIC_EFFORT=off is not supported by claude-sonnet-5-5/);
  await assert.rejects(fs.readFile(path.join(dir, 'anthropic-payloads.jsonl')), { code: 'ENOENT' });
});

// #178: only a top-level section heading ends a section.
const subHeadingReview = (groupLine, verdict = 'APPROVED') => ['### ✅ Summary', 'Changes X.', '', '### ⚠️ Issues Found', groupLine, '- [High] crash on empty input', '', '### 🚀 Verdict', verdict].join('\n');

test('findingSeverities reads past a #### sub-heading and a bold line that only contains a section word (#178)', () => {
  assert.deepEqual(findingSeverities('### ⚠️ Issues Found\n#### scripts/foo.mjs\n- [High] crash\n\n### 🚀 Verdict\nAPPROVED'), ['high']);
  assert.deepEqual(findingSeverities('### ⚠️ Issues Found\n**Summary of risks**\n- [High] crash\n\n### 🚀 Verdict\nAPPROVED'), ['high']);
  assert.deepEqual(findingSeverities('### ⚠️ Issues Found\n##### deep\n**Verdict rationale:**\n- [Medium] x\n### 🚀 Verdict\nAPPROVED'), ['medium']);
});

test('no_false_alarm is false for a clean case whose High finding sits under a sub-heading (#178)', () => {
  const { no_false_alarm } = reviewSuite.scorers;
  for (const line of ['#### scripts/foo.mjs', '**Summary of risks**']) {
    assert.equal(no_false_alarm({ verdict: 'APPROVE' }, { llm_verdict: 'APPROVED', review: subHeadingReview(line) }), false, line);
    assert.equal(no_false_alarm({ verdict: 'WITHHELD' }, { llm_verdict: 'APPROVED', review: subHeadingReview(line) }), false, line);
  }
});

test('flags_issue finds a must_flag keyword under a #### sub-heading inside Issues Found (#178)', () => {
  const { flags_issue } = reviewSuite.scorers;
  const out = { llm_verdict: 'REQUEST_CHANGES', review: subHeadingReview('#### scripts/foo.mjs', 'REQUEST_CHANGES') };
  assert.equal(flags_issue({ must_flag: ['empty input'] }, out), 1);
  const bold = { llm_verdict: 'REQUEST_CHANGES', review: subHeadingReview('**Summary of risks**', 'REQUEST_CHANGES') };
  assert.equal(flags_issue({ must_flag: ['empty input'] }, bold), 1);
});

test('section titles still end a section: # to ### headings and bold-only titles, emoji and ":" aside (#178)', () => {
  const after = (heading) => findingSeverities(['### ⚠️ Issues Found', '- [Low] kept', heading, '- [High] outside'].join('\n'));
  for (const heading of ['### ✅ Summary', '## Notes', '# Review', '**🚀 Verdict**', '**Verdict:**', '**Verdict**:', '  **✅ Summary**  ', '**🏷️ Change Classification**']) {
    assert.deepEqual(after(heading), ['low'], heading);
  }
  for (const line of ['#### Verdict', '**scripts/foo.mjs**', '**Summary of risks**', '**🚀 Verdict: APPROVED**', '**Issues Found in tests**', '**Fix:**']) {
    assert.deepEqual(after(line), ['low', 'high'], line);
  }
  // A bold-only "Issues Found" title opens the section like a heading does.
  assert.deepEqual(findingSeverities('**✅ Summary**\n- [High] no\n**⚠️ Issues Found:**\n- [Medium] yes'), ['medium']);
});

test('neither suite swallows an LLM error: the stage rethrows it to the harness', async () => {
  const llm = async () => { throw new Error('Groq API HTTP error 500'); };
  await assert.rejects(validationSuite.run({ title: '[FEATURE] Add login endpoint', body: 'Body' }, { llm }), /Groq API HTTP error 500/);
  await withEnv({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    await assert.rejects(reviewSuite.run({ title: 'T', body: 'B', diff: SMALL_DIFF }, { llm }), /Groq API HTTP error 500/);
  });
});

// ---------------------------------------------------------------------------
// Live eval call ↔ production call site parity (run 38561304861: review sent json_object, Groq 400)
// ---------------------------------------------------------------------------

// Index of the last character of the string, template literal or comment starting at i; i when none does.
function literalEnd(src, i) {
  const ch = src[i];
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1;
    for (; j < src.length && src[j] !== ch; j++) if (src[j] === '\\') j++;
    return j;
  }
  if (ch === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); return j === -1 ? src.length - 1 : j - 1; }
  if (ch === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); return j === -1 ? src.length - 1 : j + 1; }
  return i;
}

// Source without its // and /* */ comments; strings and template literals kept as they are.
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const end = literalEnd(src, i);
    out += src[i] === '/' && end !== i ? ' ' : src.slice(i, end + 1);
    i = end;
  }
  return out;
}

// Text between the bracket at `open` and its match (strings, template literals and comments skipped).
function balanced(src, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const end = literalEnd(src, i);
    if (end !== i) i = end;
    else if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack.at(-1) && (stack.pop(), stack.length === 0)) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

// Top-level "key: value" / "key" entries of an object literal body.
function entries(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') { for (i++; i < body.length && body[i] !== ch; i++) if (body[i] === '\\') i++; continue; }
    if ('{(['.includes(ch)) depth++;
    else if ('})]'.includes(ch)) depth--;
    else if ((ch === ',' && depth === 0) || i === body.length) {
      const entry = body.slice(start, i).trim();
      if (entry) {
        const m = entry.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]+))?$/);
        if (!m) throw new Error(`unparsable entry: ${entry}`);
        out.push([m[1], (m[2] ?? m[1]).trim()]);
      }
      start = i + 1;
    }
  }
  return out;
}

// Production call: { stage, configKeys, options } from the stage's loadLLMConfig destructuring and its
// single callLLM({ … }) literal. A value that is neither a config binding, a call input nor a literal fails.
async function productionCall(file) {
  const src = await fs.readFile(path.join(REPO_ROOT, file), 'utf8');
  const destructure = src.match(/const\s*\{([^}]+)\}\s*=\s*loadLLMConfig\(\s*'(\w+)'\s*\)/);
  assert.ok(destructure, `${file}: no loadLLMConfig('<stage>') destructuring`);
  const configBinding = new Map(entries(destructure[1]).map(([key, local]) => [local, key]));
  const calls = [...src.matchAll(/\bcallLLM\(\s*\{/g)];
  assert.equal(calls.length, 1, `${file}: expected one callLLM({ … }) call site`);
  const callInputs = new Set(['prompt', 'systemPrompt']);
  const call = { stage: null, configKeys: [], options: {} };
  for (const [key, value] of entries(stripComments(balanced(src, calls[0].index + calls[0][0].length - 1)))) {
    if (key === 'stage') call.stage = JSON.parse(value.replace(/'/g, '"'));
    else if (callInputs.has(key)) continue;
    else if (configBinding.get(value) === key) call.configKeys.push(key);
    else {
      // Literal option (null, boolean, number, string, { type: 'json_object' }).
      const json = value.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
      try { call.options[key] = JSON.parse(json); } catch { assert.fail(`${file}: callLLM option ${key}: ${value} is not a config field nor a literal`); }
    }
  }
  return { ...call, configStage: destructure[2] };
}

const PRODUCTION_CALL_SITES = { validation: 'scripts/validate_issue.mjs', review: 'scripts/pr_review.mjs' };

test('every suite mirrors its production stage call site: same config fields, same literal callLLM options', async () => {
  assert.deepEqual(Object.keys(PRODUCTION_CALL_SITES).sort(), Object.keys(SUITES).sort(), 'a new suite needs its production call site here');
  for (const [name, file] of Object.entries(PRODUCTION_CALL_SITES)) {
    const suite = SUITES[name];
    const prod = await productionCall(file);
    assert.equal(prod.stage, suite.stage, `${name}: callLLM stage`);
    assert.equal(prod.configStage, suite.stage, `${name}: loadLLMConfig stage`);
    assert.deepEqual([...suite.llmCall.configKeys].sort(), prod.configKeys.sort(), `${name}: config fields forwarded to callLLM`);
    assert.deepEqual(suite.llmCall.options, prod.options, `${name}: callLLM options (responseFormat, …)`);
  }
});

test('review mirrors responseFormat null; validation keeps the json_object default (no responseFormat)', () => {
  assert.deepEqual(reviewSuite.llmCall.options, { responseFormat: null });
  assert.equal('responseFormat' in validationSuite.llmCall.options, false);
});

test('parity parser: a responseFormat drift or an extra config field is caught', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-'));
  const file = path.join(tmp, 'stage.mjs');
  try {
    await fs.writeFile(file, "const { apiKey: k, model, maxInputTokens } = loadLLMConfig('review');\nawait callLLM({ stage: 'review', prompt, systemPrompt: SYS, apiKey: k, model, maxInputTokens, responseFormat: { type: 'json_object' } });\n");
    const prod = await productionCall(path.relative(REPO_ROOT, file));
    assert.deepEqual(prod, { stage: 'review', configStage: 'review', configKeys: ['apiKey', 'model', 'maxInputTokens'], options: { responseFormat: { type: 'json_object' } } });
    assert.notDeepEqual(reviewSuite.llmCall.options, prod.options);
    assert.notDeepEqual([...reviewSuite.llmCall.configKeys].sort(), prod.configKeys.sort());
    await fs.writeFile(file, "const { model } = loadLLMConfig('review');\nawait callLLM({ stage: 'review', prompt, model, responseFormat: pick() });\n");
    await assert.rejects(productionCall(path.relative(REPO_ROOT, file)), /responseFormat: pick\(\) is not a config field nor a literal/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('parity parser: comments in the call site (apostrophe, braces, block) are skipped', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-'));
  const file = path.join(tmp, 'stage.mjs');
  try {
    await fs.writeFile(file, [
      "const { model, maxTokens } = loadLLMConfig('review');",
      'await callLLM({',
      "  stage: 'review', // don't send json_object: the review is Markdown {",
      '  prompt,',
      '  /* budget: ) fitted upstream */ model,',
      '  maxTokens,',
      '  responseFormat: null, // last',
      '});',
      '',
    ].join('\n'));
    assert.deepEqual(await productionCall(path.relative(REPO_ROOT, file)), { stage: 'review', configStage: 'review', configKeys: ['model', 'maxTokens'], options: { responseFormat: null } });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Review prompt context parity: every field pr_review.mjs passes to buildReviewPrompt, the suite passes too,
// through the same formatter when production wraps the value in one (ADR-0035/0036/0037 contexts, #217 follow-up).
async function buildReviewPromptFields(file) {
  const src = await fs.readFile(path.join(REPO_ROOT, file), 'utf8');
  const calls = [...src.matchAll(/\bbuildReviewPrompt\(\s*\{/g)];
  assert.equal(calls.length, 1, `${file}: expected one buildReviewPrompt({ … }) call site`);
  return new Map(entries(stripComments(balanced(src, calls[0].index + calls[0][0].length - 1)))
    .map(([key, value]) => [key, value.match(/^([A-Za-z_$][\w$]*)\(/)?.[1] ?? null]));
}

// Fields of `prod` the suite does not pass, or passes without production's formatter.
function reviewPromptDrift(prod, suite) {
  const drift = [];
  for (const [key, formatter] of prod) {
    if (!suite.has(key)) drift.push(`${key}: not passed by the suite`);
    else if (formatter && suite.get(key) !== formatter) drift.push(`${key}: production formats it with ${formatter}(), the suite with ${suite.get(key) ?? 'no call'}`);
  }
  return drift;
}

test('review suite passes buildReviewPrompt every field pr_review.mjs passes, through the same formatter', async () => {
  const prod = await buildReviewPromptFields('scripts/pr_review.mjs');
  const suite = await buildReviewPromptFields('scripts/lib/eval_suites.mjs');
  for (const key of ['staleRefsContext', 'relatedAdrs', 'promptBudgetContext']) assert.ok(prod.has(key), `pr_review.mjs no longer passes ${key}: update this test`);
  assert.deepEqual(reviewPromptDrift(prod, suite), []);
});

test('review prompt parity: a production field the suite lacks, or another formatter, is caught', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-'));
  const file = path.join(tmp, 'stage.mjs');
  try {
    await fs.writeFile(file, 'const r = buildReviewPrompt({ systemPrompt, rawDiff, staleRefsContext: formatStaleRefsContext(hits), relatedAdrs, newContext: formatNew(x) /* ) */ });\n');
    const prod = await buildReviewPromptFields(path.relative(REPO_ROOT, file));
    assert.deepEqual([...prod], [['systemPrompt', null], ['rawDiff', null], ['staleRefsContext', 'formatStaleRefsContext'], ['relatedAdrs', null], ['newContext', 'formatNew']]);
    const suite = new Map([['systemPrompt', null], ['rawDiff', null], ['staleRefsContext', 'quote'], ['relatedAdrs', null]]);
    assert.deepEqual(reviewPromptDrift(prod, suite), [
      'staleRefsContext: production formats it with formatStaleRefsContext(), the suite with quote',
      'newContext: not passed by the suite',
    ]);
    await fs.writeFile(file, 'buildReviewPrompt({ a });\nbuildReviewPrompt({ b });\n');
    await assert.rejects(buildReviewPromptFields(path.relative(REPO_ROOT, file)), /expected one buildReviewPrompt/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('reviewSuite.run renders the precomputed stale_refs, related_adrs and prompt_budget contexts like production', async () => {
  const input = {
    title: 'T', body: 'B', diff: SMALL_DIFF,
    stale_refs: [{ removedText: 'old rule text', file: 'prompts/x.md', line: 4, foundIn: [{ path: 'docs/y.md', line: 9 }] }],
    related_adrs: [{ id: 'ADR-0042', title: 'Some decision', status: 'Accepted', decisionExcerpt: 'Do the thing.' }],
    prompt_budget: [{ prompt: 'prompts/x.md', stage: 'review', budget: 'input', deltaTokens: -5, headTokens: 100, maxInputTokens: 6300, headroomTokens: 4000, lowHeadroom: false }],
  };
  const { request } = await runReview(input);
  assert.match(request.prompt, /## Stale references \(deterministic text search\)\n[\s\S]*- Removed from prompts\/x\.md:4 — "old rule text" — still referenced in: docs\/y\.md:9/);
  assert.match(request.prompt, /## Related ADRs\n[\s\S]*- ADR-0042: Some decision \(Accepted\) — Decision: Do the thing\./);
  assert.match(request.prompt, /## Prompt budget impact[\s\S]*- prompts\/x\.md: -5 tokens \(now 100\)/);
  const bare = await runReview({ title: 'T', body: 'B', diff: SMALL_DIFF });
  assert.doesNotMatch(bare.request.prompt, /Stale references|Related ADRs|Prompt budget impact/);
});

// RV-04b: the document lines of a case's doc_mentions reach the prompt like production and are the only text a finding can quote besides the Impact analysis.
test('reviewSuite.run renders doc_mentions and checks a finding about a document against its lines', async () => {
  const doc = 'The suite scores with `scoreReview` only.';
  const input = {
    title: 'T', body: 'B', diff: SMALL_DIFF,
    doc_mentions: { terms: [{ kind: 'export', name: 'scoreReview', file: 'src/a.js', status: 'changed', refs: [{ path: 'docs/guide.md', line: 3, text: doc }], refFiles: 1, generic: false }], scanned: 1, truncated: false },
  };
  const finding = (evidence) => reviewText({ verdict: 'REQUEST_CHANGES', issues: [`[High] A document is now false — File: docs/guide.md Lines: 3 Root cause: r. ${evidence}Fix: f`] });
  const proven = await runReview(input, finding(`Evidence: docs/guide.md:3 "${doc}" `));
  assert.match(proven.request.prompt, /## Documents that mention what this diff changes[\s\S]*docs\/guide\.md:3: The suite scores with `scoreReview` only\./);
  assert.deepEqual([proven.output.verdict, proven.output.evidence_check.verified, proven.output.evidence_check.unproven], ['REQUEST_CHANGES', 1, 0]);
  for (const evidence of ['', 'Evidence: docs/guide.md:3 "The suite also scores the adversarial protocol." ']) {
    const unproven = await runReview(input, finding(evidence));
    assert.deepEqual([unproven.output.verdict, unproven.output.withheld_for, unproven.output.evidence_check.unproven], ['WITHHELD', 'unproven_findings', 1], evidence);
  }
  const without = await runReview({ ...input, doc_mentions: undefined }, finding(`Evidence: docs/guide.md:3 "${doc}" `));
  assert.equal(without.output.verdict, 'WITHHELD', 'without the lines, the same quote is not found');
  assert.doesNotMatch(without.request.prompt, /## Documents that mention/);
});

// RV-05: a finding that points at lines the diff does not show is unverified, whatever file it names.
test('reviewSuite.run withholds a REQUEST_CHANGES whose only blocking finding points at lines the diff does not show, and keeps one that points at the diff', async () => {
  const at = (lines) => reviewText({ verdict: 'REQUEST_CHANGES', issues: [`[High] The constant changed — File: src/a.js Lines: ${lines} Root cause: r. Fix: f.`] });
  const far = await runReview({ title: 'T', body: 'B', diff: SMALL_DIFF }, at('400-410'));
  assert.deepEqual([far.output.verdict, far.output.withheld_for, far.output.evidence_check.unverified, far.output.evidence_check.supported], ['WITHHELD', 'unproven_findings', 1, 0]);
  const near = await runReview({ title: 'T', body: 'B', diff: SMALL_DIFF }, at('1'));
  assert.deepEqual([near.output.verdict, near.output.evidence_check.supported, near.output.evidence_check.unproven], ['REQUEST_CHANGES', 1, 0]);
});

test('liveCallArgs: only the suite config fields + options, pinned to the primary', () => {
  const config = { provider: 'groq', apiKey: 'k', model: 'm', apiUrl: 'u', temperature: 0.6, maxTokens: 1024, maxInputTokens: 6300, diffRatio: undefined, feedbackRatio: undefined, reasoningEffort: 'low' };
  assert.deepEqual(liveCallArgs(reviewSuite, config, { prompt: 'p', systemPrompt: 's' }), {
    apiKey: 'k', model: 'm', apiUrl: 'u', temperature: 0.6, maxTokens: 1024, reasoningEffort: 'low', responseFormat: null, stage: 'review', prompt: 'p', systemPrompt: 's', fallback: false,
  });
  assert.deepEqual(liveCallArgs(validationSuite, config, { prompt: 'p', systemPrompt: 's' }), {
    apiKey: 'k', model: 'm', apiUrl: 'u', temperature: 0.6, maxTokens: 1024, maxInputTokens: 6300, reasoningEffort: 'low', stage: 'validation', prompt: 'p', systemPrompt: 's', fallback: false,
  });
  // Anthropic config has no temperature nor input budget: absent fields are not sent as undefined.
  assert.deepEqual(Object.keys(liveCallArgs(reviewSuite, { provider: 'anthropic', apiKey: 'k', model: 'm', maxTokens: 16000 }, { prompt: 'p', systemPrompt: 's' })).sort(),
    ['apiKey', 'fallback', 'maxTokens', 'model', 'prompt', 'responseFormat', 'stage', 'systemPrompt']);
});

// Groq-only env, fetch mocked: the payload the live eval LLM sends for one case of a suite.
async function liveGroqPayload(suite, input, content, expected) {
  const savedFetch = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, opts) => {
    payloads.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    return await withEnv({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'gk', ANTHROPIC_API_KEY: undefined, GROQ_MODEL: undefined, GROQ_API_URL: undefined, GROQ_MAX_RETRIES: '0' }, async () => {
      const live = createLiveLLM(suite, loadLLMConfig(suite.stage));
      const [result] = await runSuite({ suite, cases: [{ id: 'c1', input, expected }], llmFor: () => live });
      return { result, payloads };
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

test('live review eval call reaches groq_client without response_format', async () => {
  const review = '### ✅ Summary\nFine.\n\n### 🚀 Verdict\nAPPROVED';
  const { result, payloads } = await liveGroqPayload(reviewSuite, { title: 'T', body: 'B', diff: SMALL_DIFF }, review, { verdict: 'APPROVE' });
  assert.equal(payloads.length, 1);
  assert.equal('response_format' in payloads[0], false);
  assert.equal(result.error, null);
  assert.equal(result.output.llm_verdict, 'APPROVED');
});

test('live validation eval call still sends response_format json_object', async () => {
  const { result, payloads } = await liveGroqPayload(validationSuite, { title: '[FEATURE] Add login endpoint', body: 'Body' }, llmResponse({ valid: true }), { valid: true });
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].response_format, { type: 'json_object' });
  assert.equal(result.error, null);
  assert.equal(result.output.valid, true);
});

test('replay is unaffected: recorded answers, no provider call, no API key needed', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-'));
  const file = path.join(tmp, 'review.json');
  await fs.writeFile(file, JSON.stringify({ meta: { model: 'groq:x' }, results: [{ case_id: 'c1', repeat: 0, calls: [{ raw: 'recorded' }] }] }));
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('replay must not call a provider'); };
  try {
    await withEnv({ AI_PROVIDER: undefined, GROQ_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      const { llmFor, model } = await buildLLM(reviewSuite, file);
      assert.equal(model, 'replay:groq:x');
      assert.equal(await llmFor('c1#0')({ prompt: 'p', systemPrompt: 's' }), 'recorded');
    });
  } finally {
    globalThis.fetch = savedFetch;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

for (const provider of ['groq', 'anthropic']) {
  test(`buildLLM records effective temperature for ${provider}`, async () => {
    await withEnv({ AI_PROVIDER: provider, AI_PROVIDER_REVIEW: provider, GROQ_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, async () => {
      const built = await buildLLM(reviewSuite);
      assert.equal(built.temperature, provider === 'groq' ? 0 : null);
    });
  });
}

for (const temperature of [0, 0.6, null, undefined]) {
  test(`buildLLM replay preserves recorded temperature ${temperature}`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-temperature-'));
    const file = path.join(tmp, 'review.json');
    try {
      await fs.writeFile(file, JSON.stringify({ meta: { model: 'groq:x', temperature }, results: [] }));
      assert.equal((await buildLLM(reviewSuite, file)).temperature, temperature);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Provider-independent review cases (ADR-0038 amendment): requires_cut
// ---------------------------------------------------------------------------

const GROQ_ENV = { AI_PROVIDER: 'groq', AI_PROVIDER_REVIEW: undefined, GROQ_API_KEY: 'gk', ANTHROPIC_API_KEY: undefined };
const ANTHROPIC_ENV = { AI_PROVIDER: 'anthropic', AI_PROVIDER_REVIEW: undefined, GROQ_API_KEY: undefined, ANTHROPIC_API_KEY: 'ak' };
const CUT_TAGS = ['truncated', 'budget-cut'];

test('requiresCutLimits reads review_eval_cut_<provider>_max_input_tokens or _max_diff_chars, one of the two', () => {
  assert.deepEqual(requiresCutLimits('groq'), { maxInputTokens: Number(GROQ_MODEL_DEFAULTS.review_eval_cut_groq_max_input_tokens), maxDiffChars: null });
  assert.deepEqual(requiresCutLimits('anthropic'), { maxInputTokens: Number(GROQ_MODEL_DEFAULTS.review_eval_cut_anthropic_max_input_tokens), maxDiffChars: null });
  assert.deepEqual(requiresCutLimits('anthropic', { review_eval_cut_anthropic_max_diff_chars: '12000' }), { maxInputTokens: null, maxDiffChars: 12000 });
  assert.equal(requiresCutLimits('anthropic', {}), null);
  assert.equal(requiresCutLimits('anthropic', { review_eval_cut_groq_max_input_tokens: '6300' }), null, 'another provider\'s key is not read');
  assert.throws(() => requiresCutLimits('groq', { review_eval_cut_groq_max_input_tokens: '6300', review_eval_cut_groq_max_diff_chars: '9000' }), /Set one of review_eval_cut_groq_max_input_tokens and review_eval_cut_groq_max_diff_chars, not both/);
  for (const bad of ['abc', '0', '-1', '2.5', '']) {
    assert.throws(() => requiresCutLimits('anthropic', { review_eval_cut_anthropic_max_diff_chars: bad }), /Invalid review_eval_cut_anthropic_max_diff_chars/);
  }
});

test('reviewDiffLimits: production limits by default; requires_cut takes the stage provider\'s configured cut, else production\'s', async () => {
  const budget = parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10);
  await withEnv(GROQ_ENV, () => {
    assert.deepEqual(reviewDiffLimits(undefined), { maxInputTokens: budget, maxDiffChars: null });
    assert.deepEqual(reviewDiffLimits({ id: 'c' }), { maxInputTokens: budget, maxDiffChars: null });
    assert.deepEqual(reviewDiffLimits({ id: 'c', requires_cut: true }), requiresCutLimits('groq'));
    assert.deepEqual(reviewDiffLimits({ id: 'c', requires_cut: true }, { review_max_input_tokens: '6300', review_eval_cut_groq_max_input_tokens: '4000' }), { maxInputTokens: 4000, maxDiffChars: null });
  });
  await withEnv(ANTHROPIC_ENV, () => {
    assert.deepEqual(reviewDiffLimits({ id: 'c' }), { maxInputTokens: null, maxDiffChars: reviewMaxDiffChars('anthropic') });
    assert.deepEqual(reviewDiffLimits({ id: 'c', requires_cut: true }), requiresCutLimits('anthropic'));
    assert.deepEqual(reviewDiffLimits({ id: 'c', requires_cut: true }, { review_eval_cut_anthropic_max_diff_chars: '12000' }), { maxInputTokens: null, maxDiffChars: 12000 });
    // No key for the provider: its production limits (the run errors if they leave the case uncut).
    assert.deepEqual(reviewDiffLimits({ id: 'c', requires_cut: true }, { anthropic_review_max_diff_chars: '30000' }), { maxInputTokens: null, maxDiffChars: 30000 });
    assert.deepEqual(reviewDiffLimits({ id: 'c' }, { anthropic_review_max_diff_chars: '30000', review_eval_cut_anthropic_max_diff_chars: '100' }), { maxInputTokens: null, maxDiffChars: 30000 }, 'never applied without requires_cut');
  });
  for (const bad of [false, 'yes', 1, null]) {
    assert.throws(() => reviewDiffLimits({ id: 'c', requires_cut: bad }), /c: requires_cut must be true or absent/);
  }
});

test('reviewSuite.run errors a requires_cut case its provider\'s limits leave whole, before any LLM call', async () => {
  const c = (await loadReviewCases()).find((x) => x.id === 'incident-clean-code-cut');
  const key = 'review_eval_cut_anthropic_max_input_tokens';
  const saved = GROQ_MODEL_DEFAULTS[key];
  delete GROQ_MODEL_DEFAULTS[key];
  try {
    await withEnv(ANTHROPIC_ENV, async () => {
      const { error, request } = await runReview(c.input, undefined, c);
      assert.match(error.message, /incident-clean-code-cut: requires_cut but not cut on anthropic: set review_eval_cut_anthropic_max_input_tokens or _max_diff_chars/);
      assert.equal(request, undefined, 'no LLM call');
    });
  } finally {
    GROQ_MODEL_DEFAULTS[key] = saved;
  }
});

test('review dataset: requires_cut is declared exactly on the cases whose expectation needs the cut (truncated / budget-cut)', async () => {
  const cases = await loadReviewCases();
  const declared = cases.filter((c) => c.requires_cut !== undefined);
  for (const c of declared) assert.equal(c.requires_cut, true, `${c.id}: requires_cut`);
  assert.deepEqual(declared.map((c) => c.id).sort(), cases.filter((c) => CUT_TAGS.some((t) => c.tags.includes(t))).map((c) => c.id).sort());
  assert.ok(declared.length >= 5);
});

test('review dataset with the shipped config: a requires_cut case gets the same cut on Groq and Anthropic, any other case is never cut', async () => {
  const cases = await loadReviewCases();
  const runAll = (env) => withEnv(env, async () => Promise.all(cases.map(async (c) => [c.id, await runReview(c.input, undefined, c)])));
  const groq = new Map(await runAll(GROQ_ENV));
  const anthropic = new Map(await runAll(ANTHROPIC_ENV));
  for (const c of cases) {
    const [g, a] = [groq.get(c.id), anthropic.get(c.id)];
    assert.equal(g.error, undefined, `${c.id}: ${g.error?.message}`);
    assert.equal(a.error, undefined, `${c.id}: ${a.error?.message}`);
    if (c.requires_cut) {
      assert.equal(a.output.diff_truncated, true, `${c.id}: cut on Anthropic`);
      assert.equal(a.request.prompt, g.request.prompt, `${c.id}: same prompt on both providers`);
      assert.deepEqual(a.output.unreviewed_code_files, g.output.unreviewed_code_files, c.id);
    } else {
      assert.deepEqual([g.output.diff_truncated, a.output.diff_truncated, a.output.body_truncated], [false, false, false], `${c.id}: never cut`);
      assert.deepEqual(a.output.unreviewed_code_files, [], c.id);
    }
  }
});

test('review dataset: the #187 and #219 incident shapes hold on Anthropic too (they did not under the 12,000-char cap)', async () => {
  const byId = Object.fromEntries((await loadReviewCases()).map((c) => [c.id, c]));
  await withEnv(ANTHROPIC_ENV, async () => {
    const hunks = byId['incident-finding-on-cut-hunks'];
    const cut = await runReview(hunks.input, undefined, hunks);
    assert.deepEqual(cut.output.unreviewed_code_files, []);
    assert.match(cut.request.prompt, /\+test\('nightly\.yml: the ingest job/);
    assert.doesNotMatch(cut.request.prompt, /a manual run of digest|docs\/maintenance\.md b\//);
    const code = byId['incident-clean-code-cut'];
    const withheld = await runReview(code.input, undefined, code);
    assert.deepEqual([withheld.output.verdict, withheld.output.unreviewed_code_files], ['WITHHELD', ['src/http/status_class.mjs']]);
    for (const id of ['incident-cut-mid-step-name', 'incident-missing-step-in-cut']) {
      const run = await runReview(byId[id].input, undefined, byId[id]);
      assert.ok(run.output.unreviewed_code_files.includes('.github/workflows/test.yml'), id);
      assert.match(run.request.prompt, /\n… \[diff cut: \d+ more lines not shown, in [^\n]*\.github\/workflows\/test\.yml(?! \(partly)[^\n]*\]\n/, id);
      assert.doesNotMatch(run.request.prompt, /Check \w+ coverage/, id);
      // Without requires_cut, Anthropic shows test.yml and its c8 steps: the incident does not reproduce.
      const uncapped = await runReview(byId[id].input);
      assert.equal(uncapped.output.diff_truncated, false, `${id}: whole diff under the Anthropic cap`);
      assert.match(uncapped.request.prompt, /Check \w+ coverage/, id);
    }
    const truncated = byId['truncated-diff-visible-bug'];
    const visible = await runReview(truncated.input, undefined, truncated);
    assert.match(visible.request.prompt, /- diff_truncated: true/);
    assert.match(visible.request.prompt, /headers\.get\('retry-after'\)\.trim\(\)/);
  });
});

test('review limits parity: without requires_cut the suite uses the limits pr_review.mjs derives from loadLLMConfig, on each provider', async () => {
  for (const env of [GROQ_ENV, ANTHROPIC_ENV]) {
    await withEnv(env, () => {
      const config = loadLLMConfig('review');
      assert.deepEqual(reviewDiffLimits({ id: 'c' }), { maxInputTokens: config.maxInputTokens ?? null, maxDiffChars: reviewMaxDiffChars(config.provider) }, config.provider);
    });
  }
  // pr_review.mjs derives maxDiffChars from the provider of its loadLLMConfig('review') and passes it to buildReviewPrompt.
  const src = await fs.readFile(path.join(REPO_ROOT, 'scripts/pr_review.mjs'), 'utf8');
  assert.match(src, /const \{ provider: llmProvider,[^}]*\} = loadLLMConfig\('review'\);/);
  assert.match(src, /const maxDiffChars = reviewMaxDiffChars\(llmProvider\);/);
  assert.ok((await buildReviewPromptFields('scripts/pr_review.mjs')).has('maxDiffChars'));
  assert.ok((await buildReviewPromptFields('scripts/lib/eval_suites.mjs')).has('maxDiffChars'));
});
