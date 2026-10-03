import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, validationSuite } from '../lib/eval_suites.mjs';
import { loadDataset, runSuite, summarize } from '../lib/eval_harness.mjs';
import { VALIDATION_SYSTEM_PROMPT } from '../lib/issue_validator.mjs';
import { parseCliArgs } from '../run_evals.mjs';

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
    const { stdout } = await promisify(execFile)(process.execPath, [RUN_EVALS, ...args], { cwd, env });
    return { code: 0, stdout };
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
