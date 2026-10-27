// The `autofix` eval suite end to end (EV-03, ADR-0052): the suite in the registry, its scorers, and the two-phase flow
// the workflow runs (model phase -> grader job -> scored replay), against the real golden set. The model is a stub that
// answers each case with its reference patch (or a reasoned refusal); the grader runs the hidden tests for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autofixSuite, autofixPromptConfig, SUITES } from '../lib/eval_suites.mjs';
import { loadAutofixCases } from '../lib/autofix_dataset.mjs';
import { gradeModelResults } from '../lib/autofix_eval_grading.mjs';
import { createReplayLLM, runSuite, summarize } from '../lib/eval_harness.mjs';
import { parseCliArgs, withGraderResults, buildLLM, recordModelPhase } from '../run_evals.mjs';
import { PIPELINE_ROOT } from '../lib/roots.mjs';

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const out = fn();
    return out instanceof Promise ? out.finally(restore) : (restore(), out);
  } catch (err) {
    restore();
    throw err;
  }
}

const ANTHROPIC = { AI_PROVIDER: 'anthropic', AI_PROVIDER_AUTOFIX: undefined, ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined };

// What a model that gets every case right answers: the reference patch, or a refusal naming the protected paths.
async function oracleAnswers(cases) {
  const answers = {};
  for (const c of cases) {
    if (c.grader) {
      const ref = JSON.parse(await fs.readFile(path.join(PIPELINE_ROOT, c.grader.dir, 'reference.json'), 'utf8'));
      answers[c.id] = JSON.stringify({ summary: 'fix the reported defect', changes: ref.changes.map((x) => ({ target_path: x.targetPath, file_content: x.content })) });
    } else {
      answers[c.id] = JSON.stringify({ summary: 'nothing to fix here', changes: [], blocked_reason: `only ${c.expected.must_name.join(', ')} can fix this, and it is protected or withheld` });
    }
  }
  return answers;
}

const stubFor = (answers) => (key) => async () => answers[key.split('#')[0]];

test('autofix is registered as a two-phase suite on the golden set, mirroring the production call', () => {
  assert.equal(SUITES.autofix, autofixSuite);
  assert.equal(autofixSuite.twoPhase, true);
  assert.equal(autofixSuite.stage, 'autofix');
  assert.equal(autofixSuite.dataset, 'evals/datasets/autofix.jsonl');
  assert.deepEqual(autofixSuite.thresholds, {}, 'no gate before a baseline (ADR-0031)');
});

test('autofixPromptConfig: the prompt-shaping fields without an API key, which it neither returns nor leaves in the environment', () => {
  withEnv(ANTHROPIC, () => {
    const config = autofixPromptConfig();
    assert.equal(config.provider, 'anthropic');
    assert.ok(config.model);
    assert.ok(config.maxTokens > 0);
    assert.equal('apiKey' in config, false);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  });
  withEnv({ ...ANTHROPIC, GROQ_API_KEY: undefined, AI_PROVIDER: 'groq' }, () => {
    const config = autofixPromptConfig();
    assert.equal(config.provider, 'groq');
    assert.ok(config.maxInputTokens > 0, 'the Groq budget of config/models.yaml');
    assert.equal(process.env.GROQ_API_KEY, undefined);
  });
});

test('autofixPromptConfig leaves a real key alone', () => {
  withEnv({ ...ANTHROPIC, ANTHROPIC_API_KEY: 'sk-real' }, () => {
    autofixPromptConfig();
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-real');
  });
});

test('autofixPromptConfig restores the environment when the config is invalid', () => {
  withEnv({ ...ANTHROPIC, ANTHROPIC_EFFORT: 'sideways' }, () => {
    assert.throws(() => autofixPromptConfig(), /Invalid anthropic effort/);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  });
});

test('scorers: a patch case is resolved by a passing grader verdict only; a refusal case by a reasoned NO_CHANGES', () => {
  const { resolved, patch_passes: patchPasses, refusal_correct: refusalCorrect } = autofixSuite.scorers;
  const patchCase = { status: 'PATCH' };
  const refusalCase = { status: 'NO_CHANGES', must_name: ['docs/a.md', 'README.md'] };
  const passed = { status: 'PATCH', grader: { graded: true, outcome: 'PASS' } };
  assert.equal(resolved(patchCase, passed), true);
  assert.equal(resolved(patchCase, { status: 'PATCH', grader: { graded: true, outcome: 'FAIL', failure: 'HIDDEN_TESTS_FAILED' } }), false);
  assert.equal(resolved(patchCase, { status: 'NO_CHANGES', grader: { graded: false, reason: 'NO_PATCH' } }), false);
  assert.equal(resolved(patchCase, { status: 'PATCH' }), false, 'a patch without a verdict is never a pass');
  assert.equal(resolved(patchCase, null), false);
  assert.equal(patchPasses(patchCase, passed), true);
  assert.equal(patchPasses(refusalCase, passed), null);
  assert.equal(refusalCorrect(patchCase, passed), null);

  const refusal = (blocked_reason, status = 'NO_CHANGES') => ({ status, blocked_reason });
  assert.equal(resolved(refusalCase, refusal('DOCS/A.md and readme.md are protected')), true, 'case-insensitive');
  assert.equal(resolved(refusalCase, refusal('docs/a.md is protected')), false, 'every path must be named');
  assert.equal(resolved(refusalCase, refusal('docs/a.md README.md', 'GUARD_REJECTED')), false, 'only an explicit refusal counts');
  assert.equal(resolved(refusalCase, { status: 'NO_CHANGES' }), false, 'no reason names nothing');
  assert.equal(refusalCorrect(refusalCase, refusal('docs/a.md README.md')), true);
  assert.equal(refusalCorrect(patchCase, refusal('docs/a.md')), null);
});

test('label: a patch is `patch`, every other status applies nothing', () => {
  assert.equal(autofixSuite.label({ status: 'PATCH' }), 'patch');
  for (const status of ['NO_CHANGES', 'GUARD_REJECTED', 'INVALID_ANSWER', 'UNPARSEABLE']) assert.equal(autofixSuite.label({ status }), 'no_changes', status);
  assert.equal(autofixSuite.expectedLabel({ status: 'PATCH' }), 'patch');
  assert.equal(autofixSuite.expectedLabel({ status: 'NO_CHANGES' }), 'no_changes');
});

test('run refuses a case whose shape the suite cannot use, before any LLM call', async () => {
  await withEnv(ANTHROPIC, async () => {
    let called = false;
    await assert.rejects(
      autofixSuite.run({ feedback: 'x', diff: 'd' }, { llm: async () => { called = true; return '{}'; }, testCase: { id: 'bad', input: { feedback: 'x', diff: 'd' }, expected: { status: 'MAYBE' } } }),
      /expected\.status must be one of/,
    );
    assert.equal(called, false);
  });
});

test('two phases end to end: model answers -> grader job -> scored replay resolves every case of the golden set', async () => {
  const cases = await loadAutofixCases();
  const answers = await oracleAnswers(cases);
  await withEnv(ANTHROPIC, async () => {
    const modelRuns = await runSuite({ suite: autofixSuite, cases, llmFor: stubFor(answers), repeats: 2 });
    assert.ok(modelRuns.every((r) => !r.error), 'the model phase errors nowhere');
    assert.deepEqual(modelRuns.filter((r) => r.output.status === 'PATCH').length, cases.filter((c) => c.grader).length * 2);

    // The recording the model job uploads, then the grader job's output.
    const recording = { meta: { phase: 'model', model: 'anthropic:test-model', repeats: 2 }, results: modelRuns };
    const graderResults = await gradeModelResults({ modelResults: recording, cases });
    assert.equal(graderResults.graded, cases.filter((c) => c.grader).length * 2);
    assert.ok(graderResults.results.filter((r) => r.graded).every((r) => r.outcome === 'PASS'), JSON.stringify(graderResults.results.filter((r) => r.graded && r.outcome !== 'PASS')));

    const scored = await runSuite({ suite: withGraderResults(autofixSuite, graderResults), cases, llmFor: createReplayLLM(recording.results), repeats: 2 });
    assert.ok(scored.every((r) => !r.error), JSON.stringify(scored.filter((r) => r.error).map((r) => r.error)));
    const summary = summarize(scored);
    assert.equal(summary.scores.resolved.mean, 1);
    assert.equal(summary.scores.patch_passes.mean, 1);
    assert.equal(summary.scores.refusal_correct.mean, 1);
    assert.equal(summary.error_rate, 0);
    assert.equal(summary.per_class.patch.recall, 1);
    assert.equal(summary.per_class.no_changes.recall, 1);
  });
});

test('a model that answers every case with an empty patch resolves no patch case', async () => {
  const cases = await loadAutofixCases();
  const answers = Object.fromEntries(cases.map((c) => [c.id, JSON.stringify({ summary: 'nothing', changes: [], blocked_reason: 'cannot fix' })]));
  await withEnv(ANTHROPIC, async () => {
    const modelRuns = await runSuite({ suite: autofixSuite, cases, llmFor: stubFor(answers) });
    const recording = { meta: { phase: 'model', model: 'anthropic:test-model', repeats: 1 }, results: modelRuns };
    const graderResults = await gradeModelResults({ modelResults: recording, cases });
    assert.equal(graderResults.graded, 0);
    const scored = await runSuite({ suite: withGraderResults(autofixSuite, graderResults), cases, llmFor: createReplayLLM(recording.results) });
    const summary = summarize(scored);
    assert.equal(summary.scores.patch_passes.mean, 0);
    assert.equal(summary.error_rate, 0, 'a refusal is an answer, not an error');
  });
});

test('a grader error or a missing verdict makes the run errored, never a pass', async () => {
  const cases = (await loadAutofixCases()).filter((c) => c.id === 'fix-page-offset');
  const answers = await oracleAnswers(cases);
  await withEnv(ANTHROPIC, async () => {
    const modelRuns = await runSuite({ suite: autofixSuite, cases, llmFor: stubFor(answers) });
    const recording = { meta: { phase: 'model', model: 'anthropic:test-model', repeats: 1 }, results: modelRuns };
    const errored = { schema_version: 1, suite: 'autofix', runs: 1, graded: 1, results: [{ case_id: 'fix-page-offset', repeat: 0, graded: true, outcome: 'ERROR', failure: 'GRADER_ERROR', path: null, checks: [] }] };
    const missing = { schema_version: 1, suite: 'autofix', runs: 0, graded: 0, results: [] };
    for (const [graderResults, message] of [[errored, /could not be graded \(GRADER_ERROR\)/], [missing, /no verdict for fix-page-offset#0/]]) {
      const [run] = await runSuite({ suite: withGraderResults(autofixSuite, graderResults), cases, llmFor: createReplayLLM(recording.results) });
      assert.match(run.error, message);
      assert.equal(run.scores.resolved, 0);
    }
  });
});

test('parseCliArgs: a live run of a two-phase suite is --phase model; scoring needs --replay and --grader-results', () => {
  assert.throws(() => parseCliArgs(['--suite', 'autofix']), /two-phase: a live run is --phase model/);
  assert.throws(() => parseCliArgs(['--suite', 'autofix', '--replay', 'm.json']), /needs --grader-results/);
  assert.throws(() => parseCliArgs(['--suite', 'autofix', '--phase', 'model', '--replay', 'm.json']), /cannot be combined with --replay/);
  assert.throws(() => parseCliArgs(['--suite', 'autofix', '--phase', 'model', '--scorecard']), /scored runs only/);
  assert.throws(() => parseCliArgs(['--suite', 'autofix', '--phase', 'score']), /--phase must be "model"/);
  assert.throws(() => parseCliArgs(['--suite', 'autofix', '--grader-results', 'g.json', '--phase', 'model']), /needs --replay/);
  assert.equal(parseCliArgs(['--suite', 'autofix', '--phase', 'model']).phase, 'model');
  const scoring = parseCliArgs(['--suite', 'autofix', '--replay', 'm.json', '--grader-results', 'g.json']);
  assert.deepEqual([scoring.phase, scoring.graderResultsFile], [null, 'g.json']);
});

test('parseCliArgs: --phase and --grader-results are refused for a single-phase suite', () => {
  assert.throws(() => parseCliArgs(['--suite', 'review', '--phase', 'model']), /for two-phase suites; review is not one/);
  assert.throws(() => parseCliArgs(['--suite', 'review', '--replay', 'r.json', '--grader-results', 'g.json']), /for two-phase suites; review is not one/);
  assert.equal(parseCliArgs(['--suite', 'review']).phase, null);
});

test('buildLLM for a scoring replay reports the model that answered, and only accepts a model-phase recording', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-suite-'));
  try {
    const model = path.join(dir, 'model.json');
    const other = path.join(dir, 'other.json');
    await fs.writeFile(model, JSON.stringify({ meta: { phase: 'model', model: 'anthropic:m1', temperature: null }, results: [] }));
    await fs.writeFile(other, JSON.stringify({ meta: { model: 'anthropic:m1' }, results: [] }));
    assert.equal((await buildLLM(autofixSuite, model, { scoresRecording: true })).model, 'anthropic:m1');
    assert.equal((await buildLLM(autofixSuite, model)).model, 'replay:anthropic:m1', 'a plain re-score keeps the replay prefix');
    await assert.rejects(buildLLM(autofixSuite, other, { scoresRecording: true }), /is not the results of a --phase model run/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recordModelPhase writes the recording with meta.phase and no history, report or threshold', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-suite-'));
  const spans = [];
  const tracer = { endSpan: (name, attrs) => spans.push(['end', name, attrs.outcome]), finalize: async (outcome) => spans.push(['finalize', outcome]) };
  const logged = [];
  const origLog = console.log;
  console.log = (line) => logged.push(line);
  try {
    const results = [{ case_id: 'a', repeat: 0, error: null, output: { status: 'PATCH' }, scores: {}, calls: [] }, { case_id: 'b', repeat: 0, error: 'boom', output: null, scores: {}, calls: [] }];
    const meta = { run_id: 'r1', model: 'anthropic:m1', repeats: 1, dataset: autofixSuite.dataset };
    await recordModelPhase({ suite: autofixSuite, opts: { outDir: dir }, results, summary: summarize(results), meta, tracer, startMs: Date.now() });
    const written = JSON.parse(await fs.readFile(path.join(dir, 'autofix-r1.json'), 'utf8'));
    assert.equal(written.meta.phase, 'model');
    assert.equal(written.meta.suite, 'autofix');
    assert.deepEqual(written.failures, []);
    assert.equal(written.results.length, 2);
    assert.match(logged[0], /2 runs recorded .* 1 errored/);
    assert.deepEqual(spans, [['end', 'eval', 'success'], ['finalize', 'success']]);
    assert.deepEqual(await fs.readdir(dir), ['autofix-r1.json'], 'no history file next to it');
  } finally {
    console.log = origLog;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recordModelPhase fails the job on a provider quota, like a scored run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-suite-'));
  const spans = [];
  const tracer = { endSpan: (name, attrs) => spans.push(attrs.outcome), finalize: async (outcome) => spans.push(outcome) };
  const origLog = console.log;
  const origWrite = process.stderr.write;
  const origExit = process.exitCode;
  console.log = () => {};
  process.stderr.write = () => true;
  try {
    const results = [{ case_id: 'a', repeat: 0, error: 'quota', output: null, scores: {}, calls: [], circuit_breaker: { provider: 'anthropic', quota: 'rate', limit: 1, used: 1, retry_after: null } }];
    await recordModelPhase({ suite: autofixSuite, opts: { outDir: dir }, results, summary: summarize(results), meta: { run_id: 'r2', model: 'anthropic:m1', repeats: 1 }, tracer, startMs: Date.now() });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(spans, ['failed', 'failed']);
  } finally {
    console.log = origLog;
    process.stderr.write = origWrite;
    process.exitCode = origExit;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
