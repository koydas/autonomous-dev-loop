import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, validationSuite, blockerCodes } from '../lib/eval_suites.mjs';
import { filterCases, loadDataset, runSuite, summarize } from '../lib/eval_harness.mjs';
import { VALIDATION_SYSTEM_PROMPT } from '../lib/issue_validator.mjs';
import { parseCliArgs, resolveReplayRepeats } from '../run_evals.mjs';

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

async function runEvals(args, cwd) {
  const env = { ...process.env, GITHUB_RUN_ID: 'test-run', EVAL_HISTORY_FILE: path.join(cwd, 'history.jsonl') };
  delete env.GITHUB_STEP_SUMMARY;
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
