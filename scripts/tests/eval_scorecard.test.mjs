import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_RUNS,
  PRICES_USD_PER_MTOK,
  baseModel,
  SCORECARD_START,
  SCORECARD_END,
  emptyScorecard,
  readScorecard,
  toScorecardRun,
  addRun,
  formatDelta,
  formatReadmeBlock,
  formatScorecard,
  replaceReadmeBlock,
  recordRuns,
  partitionPublishable,
  partitionByPublishedModel,
  rebaselineScorecard,
  runCost,
  reviewCoverage,
  formatCost,
  formatCoverage,
} from '../lib/eval_scorecard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function results({ runId = 'r1', ts = '2026-10-01T10:00:00.000Z', model = 'groq:m', verdict = 0.9, recall = 0.8, failures = [] } = {}) {
  return {
    meta: { suite: 'validation', run_id: runId, ts, model, repeats: 3, dataset: 'evals/datasets/validation.jsonl' },
    summary: {
      n_cases: 16,
      n_runs: 48,
      error_rate: 0,
      scores: { verdict_match: { mean: verdict, n: 48 }, score_in_range: { mean: 1, n: 30 } },
      consistency: 0.9375,
      per_class: { invalid: { precision: 1, recall, f1: 0.8889, support: 30 } },
      latency_ms: { p50: 900, p95: 2100 },
      tokens_est: { in: 1000, out: 200 },
    },
    failures,
  };
}

async function tmpFiles(readme = `# R\n\n${SCORECARD_START}\nold\n${SCORECARD_END}\n\ntail\n`) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scorecard-'));
  const paths = {
    scorecardFile: path.join(dir, 'scorecard.json'),
    markdownFile: path.join(dir, 'SCORECARD.md'),
    readmeFile: path.join(dir, 'README.md'),
  };
  await fs.writeFile(paths.readmeFile, readme);
  return paths;
}

// ---------------------------------------------------------------------------
// readScorecard
// ---------------------------------------------------------------------------

test('readScorecard returns an empty scorecard when the file does not exist', async () => {
  assert.deepEqual(await readScorecard(path.join(os.tmpdir(), 'nope-scorecard.json')), emptyScorecard());
});

test('readScorecard rejects an unsupported format', async () => {
  const { scorecardFile } = await tmpFiles();
  await fs.writeFile(scorecardFile, JSON.stringify({ version: 2, suites: {} }));
  await assert.rejects(readScorecard(scorecardFile), /unsupported scorecard format/);
  await fs.writeFile(scorecardFile, JSON.stringify({ version: 1, suites: null }));
  await assert.rejects(readScorecard(scorecardFile), /unsupported scorecard format/);
});

test('readScorecard propagates invalid JSON', async () => {
  const { scorecardFile } = await tmpFiles();
  await fs.writeFile(scorecardFile, '{');
  await assert.rejects(readScorecard(scorecardFile), SyntaxError);
});

// ---------------------------------------------------------------------------
// toScorecardRun / addRun
// ---------------------------------------------------------------------------

test('toScorecardRun keeps scorer means, per-class metrics and gate outcome', () => {
  const run = toScorecardRun(results({ failures: [{ metric: 'error_rate' }] }));
  assert.equal(run.run_id, 'r1');
  assert.deepEqual(run.scores, { verdict_match: 0.9, score_in_range: 1 });
  assert.equal(run.per_class.invalid.recall, 0.8);
  assert.equal(run.passed, false);
  assert.deepEqual(run.failures, ['error_rate']);
  assert.equal(run.latency_p95_ms, 2100);
});

test('toScorecardRun applies defaults for optional fields', () => {
  const run = toScorecardRun({ meta: { suite: 's', run_id: 'x' }, summary: { n_cases: 1, n_runs: 1, error_rate: 0 } });
  assert.equal(run.model, 'unknown');
  assert.equal(run.repeats, 1);
  assert.equal(run.passed, true);
  assert.deepEqual(run.scores, {});
  assert.equal(run.consistency, null);
  assert.ok(run.ts);
});

test('toScorecardRun records the known-gap block next to the gated metrics, only when the run has one (ADR-0031 §7)', () => {
  const summary = { n_cases: 3, n_runs: 3, error_rate: 0, scores: { v: { mean: 1, n: 2 } }, known_gap: { n_cases: 1, n_runs: 1, error_rate: 0, scores: { v: { mean: 0, n: 1 } }, per_class: {} } };
  const run = toScorecardRun({ meta: { suite: 's', run_id: 'x' }, summary });
  assert.deepEqual([run.n_cases, run.scores], [3, { v: 1 }]);
  assert.deepEqual(run.known_gap, { n_cases: 1, n_runs: 1, error_rate: 0, scores: { v: 0 } });
  assert.deepEqual(toScorecardRun({ meta: { suite: 's', run_id: 'x' }, summary: { ...summary, known_gap: { n_cases: 1, n_runs: 1, error_rate: 1 } } }).known_gap.scores, {});
  assert.equal('known_gap' in toScorecardRun({ meta: { suite: 's', run_id: 'x' }, summary: { n_cases: 1, n_runs: 1, error_rate: 0 } }), false);
});

test('toScorecardRun rejects incomplete results and replay runs', () => {
  assert.throws(() => toScorecardRun({ meta: { run_id: 'x' }, summary: {} }), /missing meta\.suite/);
  assert.throws(() => toScorecardRun({ meta: { suite: 's', run_id: 'x' } }), /missing meta\.suite, meta\.run_id or summary/);
  assert.throws(() => toScorecardRun(results({ model: 'replay:groq:m' })), /is a replay/);
});

test('addRun orders newest first, replaces a duplicate run_id and caps history', () => {
  let sc = emptyScorecard();
  sc = addRun(sc, 'v', toScorecardRun(results({ runId: 'a', ts: '2026-10-01T00:00:00Z' })));
  sc = addRun(sc, 'v', toScorecardRun(results({ runId: 'b', ts: '2026-10-02T00:00:00Z' })));
  sc = addRun(sc, 'v', toScorecardRun(results({ runId: 'a', ts: '2026-10-01T00:00:00Z', verdict: 0.5 })));
  assert.deepEqual(sc.suites.v.runs.map((r) => r.run_id), ['b', 'a']);
  assert.equal(sc.suites.v.runs[1].scores.verdict_match, 0.5);
  for (let i = 0; i < MAX_RUNS + 3; i++) {
    sc = addRun(sc, 'v', toScorecardRun(results({ runId: `n${i}`, ts: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z` })));
  }
  assert.equal(sc.suites.v.runs.length, MAX_RUNS);
  assert.equal(sc.suites.v.runs[0].run_id, `n${MAX_RUNS + 2}`);
});

test('addRun does not mutate the input scorecard', () => {
  const sc = emptyScorecard();
  addRun(sc, 'v', toScorecardRun(results()));
  assert.deepEqual(sc.suites, {});
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('formatDelta shows up, down, equal and nothing when a side is missing', () => {
  assert.equal(formatDelta(0.9, 0.8), ' (▲ 0.1)');
  assert.equal(formatDelta(0.7, 0.8), ' (▼ 0.1)');
  assert.equal(formatDelta(0.8, 0.8), ' (=)');
  assert.equal(formatDelta(0.8, null), '');
  assert.equal(formatDelta(null, 0.8), '');
});

test('formatReadmeBlock shows a placeholder when nothing is recorded', () => {
  assert.match(formatReadmeBlock(emptyScorecard()), /No live eval run recorded yet/);
});

test('formatReadmeBlock shows the latest run per suite with its gate', () => {
  let sc = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'old', ts: '2026-09-01T00:00:00Z' })));
  sc = addRun(sc, 'validation', toScorecardRun(results({ runId: 'new', failures: [{ metric: 'error_rate' }] })));
  const block = formatReadmeBlock(sc);
  assert.match(block, /\| `validation` \| 2026-10-01 \| `groq:m` \| verdict_match 0\.9 · score_in_range 1 \| 0 \| ❌ fail \(error_rate\) \|/);
  assert.doesNotMatch(block, /2026-09-01/);
  assert.match(block, /evals\/SCORECARD\.md/);
});

test('formatScorecard shows placeholder and how to record when empty', () => {
  const md = formatScorecard(emptyScorecard());
  assert.match(md, /# Eval scorecard/);
  assert.match(md, /No live eval run recorded yet/);
  assert.match(md, /## Record a run/);
});

test('formatScorecard shows latest metrics with deltas and the history', () => {
  let sc = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'old', ts: '2026-09-01T00:00:00Z', verdict: 0.8, recall: 0.7 })));
  sc = addRun(sc, 'validation', toScorecardRun(results({ runId: 'new', verdict: 0.9, recall: 0.8 })));
  const md = formatScorecard(sc);
  assert.match(md, /## `validation`/);
  assert.match(md, /run `new` · 16 cases × 3 repeats · ✅ pass/);
  assert.match(md, /\| verdict_match \| 0\.9 \(▲ 0\.1\) \|/);
  assert.match(md, /\| `invalid` precision \/ recall \/ F1 \| 1 \/ 0\.8 \(▲ 0\.1\) \/ 0\.8889 \(support 30\) \|/);
  assert.match(md, /\| consistency \| 0\.9375 \|/);
  assert.match(md, /\| tokens in \/ out \(est\.\) \| 1000 \/ 200 \|/);
  assert.match(md, /\| Date \| Model \| Run \| verdict_match \| score_in_range \| error_rate \| consistency \| Gate \|/);
  assert.ok(md.indexOf('`new`') < md.indexOf('| 2026-09-01'), 'history is newest first');
});

test('replaceReadmeBlock replaces only the content between markers', () => {
  const out = replaceReadmeBlock(`a\n${SCORECARD_START}\nold\n${SCORECARD_END}\nb`, 'NEW');
  assert.equal(out, `a\n${SCORECARD_START}\nNEW\n${SCORECARD_END}\nb`);
});

test('replaceReadmeBlock throws when markers are missing or reversed', () => {
  assert.throws(() => replaceReadmeBlock('no markers', 'x'), /missing the .* markers/);
  assert.throws(() => replaceReadmeBlock(`${SCORECARD_END}${SCORECARD_START}`, 'x'), /missing the .* markers/);
});

// ---------------------------------------------------------------------------
// recordRuns
// ---------------------------------------------------------------------------

test('recordRuns writes the scorecard JSON, the Markdown view and the README block', async () => {
  const paths = await tmpFiles();
  const sc = await recordRuns([results()], paths);
  assert.equal(sc.suites.validation.runs.length, 1);
  assert.equal(JSON.parse(await fs.readFile(paths.scorecardFile, 'utf8')).suites.validation.runs[0].run_id, 'r1');
  assert.match(await fs.readFile(paths.markdownFile, 'utf8'), /## `validation`/);
  const readme = await fs.readFile(paths.readmeFile, 'utf8');
  assert.match(readme, /\| `validation` \| 2026-10-01 /);
  assert.doesNotMatch(readme, /\nold\n/);
  assert.match(readme, /tail\n$/);
});

test('recordRuns with no results regenerates the views from the existing scorecard', async () => {
  const paths = await tmpFiles();
  await recordRuns([results()], paths);
  await fs.writeFile(paths.markdownFile, 'stale');
  await recordRuns([], paths);
  assert.match(await fs.readFile(paths.markdownFile, 'utf8'), /## `validation`/);
});

test('recordRuns rejects a replay and leaves the files untouched', async () => {
  const paths = await tmpFiles();
  await assert.rejects(recordRuns([results({ model: 'replay:x' })], paths), /is a replay/);
  await assert.rejects(fs.access(paths.scorecardFile));
});

// ---------------------------------------------------------------------------
// The eval dashboard on GitHub Pages is the only published scorecard
// ---------------------------------------------------------------------------

test('README links the eval dashboard and badge, and no committed scorecard view remains', async () => {
  const readme = await fs.readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /https:\/\/koydas\.github\.io\/autonomous-dev-loop\//, 'README must link the eval dashboard');
  assert.match(readme, /img\.shields\.io\/endpoint\?url=https:\/\/koydas\.github\.io\/autonomous-dev-loop\/badges\/validation\.json/);
  assert.ok(!readme.includes(SCORECARD_START), 'the README scorecard block is replaced by the dashboard');
  await assert.rejects(fs.access(path.join(REPO_ROOT, 'evals', 'SCORECARD.md')));
  assert.deepEqual(await readScorecard(path.join(REPO_ROOT, 'evals', 'scorecard.json')), emptyScorecard());
});

test('partitionPublishable skips runs that failed on error_rate and keeps metric failures', () => {
  const outage = results({ runId: 'outage', failures: [{ metric: 'error_rate' }, { metric: 'scores.verdict_match.mean' }] });
  outage.summary.error_rate = 1;
  const regression = results({ runId: 'regression', failures: [{ metric: 'scores.verdict_match.mean' }] });
  const { publishable, skipped } = partitionPublishable([outage, regression, results({ runId: 'ok' })]);
  assert.deepEqual(publishable.map((r) => r.meta.run_id), ['regression', 'ok']);
  assert.deepEqual(skipped, [{ run_id: 'outage', reason: 'error_rate 1 above threshold' }]);
});

test('partitionPublishable tolerates results without failures or meta', () => {
  const { publishable, skipped } = partitionPublishable([{ summary: {} }, { failures: [{ metric: 'error_rate' }] }]);
  assert.equal(publishable.length, 1);
  assert.deepEqual(skipped, [{ run_id: null, reason: 'error_rate undefined above threshold' }]);
});

test('formatScorecard hides Δ when the dataset changed and shows the dataset hash', () => {
  const old = results({ runId: 'old', ts: '2026-09-01T00:00:00Z', verdict: 0.8 });
  old.meta.dataset_sha256 = 'a'.repeat(64);
  const cur = results({ runId: 'new', verdict: 0.9 });
  cur.meta.dataset_sha256 = 'b'.repeat(64);
  let sc = addRun(emptyScorecard(), 'validation', toScorecardRun(old));
  sc = addRun(sc, 'validation', toScorecardRun(cur));
  const md = formatScorecard(sc);
  assert.match(md, /dataset `bbbbbbbbbbbb`/);
  assert.match(md, /Δ not shown: the dataset changed since the previous run/);
  assert.match(md, /\| verdict_match \| 0\.9 \|/);
  assert.doesNotMatch(md, /▲/);
});

test('formatScorecard keeps Δ when the dataset hash is unchanged', () => {
  const old = results({ runId: 'old', ts: '2026-09-01T00:00:00Z', verdict: 0.8 });
  const cur = results({ runId: 'new', verdict: 0.9 });
  old.meta.dataset_sha256 = cur.meta.dataset_sha256 = 'c'.repeat(64);
  let sc = addRun(emptyScorecard(), 'validation', toScorecardRun(old));
  sc = addRun(sc, 'validation', toScorecardRun(cur));
  const md = formatScorecard(sc);
  assert.match(md, /\| verdict_match \| 0\.9 \(▲ 0\.1\) \|/);
  assert.doesNotMatch(md, /dataset changed/);
});

// Pinned live evals (ADR-0032 amendment): every call must have been answered by meta.model.
const withCalls = (r, calls) => ({ ...r, results: [{ case_id: 'a', repeat: 0, calls }] });

test('partitionPublishable refuses a run whose calls were answered by another model than meta.model', () => {
  const mixed = withCalls(results({ runId: 'mixed', model: 'groq:m' }), [
    { raw: 'x', provider: 'groq', model: 'm' },
    { raw: 'y', provider: 'anthropic', model: 'claude-opus-5-5' },
  ]);
  const { publishable, skipped } = partitionPublishable([mixed]);
  assert.equal(publishable.length, 0);
  assert.equal(skipped[0].run_id, 'mixed');
  assert.match(skipped[0].reason, /answered by anthropic:claude-opus-5-5, not meta\.model groq:m/);
});

test('partitionPublishable publishes a pinned run, a replay of it, and results recorded without provider evidence', () => {
  const pinned = withCalls(results({ runId: 'pinned', model: 'groq:m' }), [{ raw: 'x', provider: 'groq', model: 'm' }]);
  const replay = withCalls(results({ runId: 'replay', model: 'replay:groq:m' }), [{ raw: 'x', provider: 'groq', model: 'm' }]);
  const legacy = withCalls(results({ runId: 'legacy', model: 'groq:m' }), [{ raw: 'x' }]);
  const { publishable, skipped } = partitionPublishable([pinned, replay, legacy, results({ runId: 'no-results' })]);
  assert.deepEqual(publishable.map((r) => r.meta.run_id), ['pinned', 'replay', 'legacy', 'no-results']);
  assert.deepEqual(skipped, []);
});

test('partitionPublishable refuses provider evidence when meta.model is missing', () => {
  const run = { ...withCalls(results({ runId: 'x' }), [{ raw: 'x', provider: 'groq', model: 'm' }]), meta: undefined };
  const { publishable, skipped } = partitionPublishable([run]);
  assert.equal(publishable.length, 0);
  assert.equal(skipped[0].run_id, null);
  assert.match(skipped[0].reason, /not meta\.model unset/);
});

// ---------------------------------------------------------------------------
// Issue #199: history per suite and model, cost line, review coverage
// ---------------------------------------------------------------------------

test('partitionByPublishedModel keeps runs of the suite\'s published model and skips another model', () => {
  const scorecard = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'g1', model: 'groq:m' })));
  const same = results({ runId: 'g2', model: 'groq:m' });
  const other = results({ runId: 'a1', model: 'anthropic:claude-opus-5-5' });
  const { publishable, skipped } = partitionByPublishedModel(scorecard, [same, other]);
  assert.deepEqual(publishable, [same]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].run_id, 'a1');
  assert.equal(skipped[0].kind, 'model_mismatch');
  assert.match(skipped[0].reason, /anthropic:claude-opus-5-5 is not the validation history's model groq:m/);
});

test('partitionByPublishedModel: the first run of an empty suite sets its model for the rest of the batch', () => {
  const first = results({ runId: 'a1', model: 'anthropic:x' });
  const second = results({ runId: 'g1', model: 'groq:m' });
  const { publishable, skipped } = partitionByPublishedModel(emptyScorecard(), [first, second]);
  assert.deepEqual(publishable, [first]);
  assert.deepEqual(skipped.map((s) => s.run_id), ['g1']);
});

test('partitionByPublishedModel: suites are independent, and a run without meta is reported with run_id null', () => {
  const scorecard = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ model: 'groq:m' })));
  const review = { ...results({ runId: 'rv', model: 'anthropic:x' }), meta: { ...results().meta, suite: 'review', run_id: 'rv', model: 'anthropic:x' } };
  assert.deepEqual(partitionByPublishedModel(scorecard, [review]).publishable, [review]);
  const { skipped } = partitionByPublishedModel(scorecard, [{ meta: { suite: 'validation' } }]);
  assert.equal(skipped[0].run_id, null);
  assert.match(skipped[0].reason, /model unset/);
});

test('runCost prices a known model on the chars/4 estimate, per run and per call', () => {
  const cost = runCost({ meta: { model: 'anthropic:claude-opus-5-5' }, summary: { tokens_est: { in: 1_000_000, out: 100_000 }, llm_calls: 4 } });
  assert.deepEqual(cost, { usd: 6, per_call_usd: 1.5, source: 'chars/4 estimate, thinking tokens excluded' });
});

test('runCost is null on the Groq free tier or a summary without tokens; per call null without calls', () => {
  assert.equal(runCost({ meta: { model: 'groq:openai/gpt-oss-120b' }, summary: { tokens_est: { in: 1, out: 1 }, llm_calls: 1 } }), null);
  assert.equal(runCost({ meta: { model: 'anthropic:claude-opus-5-5' }, summary: {} }), null);
  assert.equal(runCost({}), null);
  assert.equal(runCost({ meta: { model: 'anthropic:claude-opus-5-5' }, summary: { tokens_est: { in: 0, out: 0 } } }).per_call_usd, null);
});

test('reviewCoverage: shares of runs with the diff cut, code files cut and a WITHHELD verdict', () => {
  const out = (o) => ({ output: { verdict: 'APPROVE', diff_truncated: false, unreviewed_code_files: [], ...o } });
  const coverage = reviewCoverage([
    out({ diff_truncated: true, unreviewed_code_files: ['a.mjs'], verdict: 'WITHHELD' }),
    out({ diff_truncated: true }),
    out({}),
    out({}),
    { output: null, error: 'boom' },
  ]);
  assert.deepEqual(coverage, { n: 4, diff_truncated: 0.5, code_cut: 0.25, withheld: 0.25 });
});

test('reviewCoverage is null for a suite without diff_truncated; code_cut null before ADR-0038', () => {
  assert.equal(reviewCoverage([{ output: { verdict: 'valid' } }]), null);
  assert.equal(reviewCoverage(undefined), null);
  assert.deepEqual(reviewCoverage([{ output: { verdict: 'APPROVE', diff_truncated: true } }]), { n: 1, diff_truncated: 1, code_cut: null, withheld: 0 });
});

test('toScorecardRun records cost and coverage; formatScorecard shows them, labelled as estimates', () => {
  const r = results({ model: 'anthropic:claude-opus-5-5' });
  r.summary.llm_calls = 2;
  r.results = [{ output: { verdict: 'WITHHELD', diff_truncated: true, unreviewed_code_files: ['x.mjs'] } }];
  const run = toScorecardRun(r);
  assert.deepEqual(run.cost_est, { usd: 0.008, per_call_usd: 0.004, source: 'chars/4 estimate, thinking tokens excluded' });
  assert.deepEqual(run.coverage, { n: 1, diff_truncated: 1, code_cut: 1, withheld: 1 });
  const md = formatScorecard(addRun(emptyScorecard(), 'review', run));
  assert.match(md, /\| cost \(chars\/4 estimate, thinking tokens excluded\) \| \$0\.008 \(\$0\.004 per call\) \|/);
  assert.match(md, /\| diff cut \/ code cut \/ withheld \| 100% \/ 100% \/ 100% \(n=1\) \|/);
  const groq = formatScorecard(addRun(emptyScorecard(), 'validation', toScorecardRun(results())));
  assert.doesNotMatch(groq, /cost \(|diff cut/);
});

test('formatCost and formatCoverage render a dash for null', () => {
  assert.equal(formatCost(null), '—');
  assert.equal(formatCoverage(null), '—');
  assert.equal(formatCoverage({ n: 3, diff_truncated: null, code_cut: 0, withheld: 1 }), '— / 0% / 100% (n=3)');
});

test('runCost marks a model missing from the price table as unpriced, never as free', () => {
  const cost = runCost({ meta: { model: 'anthropic:claude-opus-5-5-snapshot' }, summary: { tokens_est: { in: 1, out: 1 }, llm_calls: 1 } });
  assert.deepEqual(cost, { usd: null, per_call_usd: null, unpriced: 'anthropic:claude-opus-5-5-snapshot', source: 'chars/4 estimate, thinking tokens excluded' });
  assert.equal(formatCost(cost), 'unpriced (`anthropic:claude-opus-5-5-snapshot` not in PRICES_USD_PER_MTOK)');
});

// One price table (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per MTok up to a 100K prompt).
test('runCost prices Sonnet 5.5 and Haiku 5.5 from PRICES_USD_PER_MTOK', () => {
  const summary = { tokens_est: { in: 1_000_000, out: 100_000 }, llm_calls: 100 };
  assert.deepEqual(runCost({ meta: { model: 'anthropic:claude-sonnet-5-5' }, summary }), { usd: 3, per_call_usd: 0.03, source: 'chars/4 estimate, thinking tokens excluded' });
  assert.deepEqual(runCost({ meta: { model: 'anthropic:claude-haiku-5-5' }, summary }), { usd: 0.15, per_call_usd: 0.0015, source: 'chars/4 estimate, thinking tokens excluded' });
  assert.deepEqual(Object.keys(PRICES_USD_PER_MTOK).sort(), ['anthropic:claude-haiku-5-5', 'anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5']);
});

test('runCost leaves Haiku 5.5 unpriced above its 100K-token prompt price tier', () => {
  const cost = runCost({ meta: { model: 'anthropic:claude-haiku-5-5' }, summary: { tokens_est: { in: 200_001, out: 10 }, llm_calls: 2 } });
  assert.deepEqual(cost, { usd: null, per_call_usd: null, unpriced: 'anthropic:claude-haiku-5-5', over_prompt_limit: 100000, source: 'chars/4 estimate, thinking tokens excluded' });
  assert.equal(formatCost(cost), 'unpriced (`anthropic:claude-haiku-5-5` list price holds up to 100000 prompt tokens per call)');
  assert.equal(runCost({ meta: { model: 'anthropic:claude-haiku-5-5' }, summary: { tokens_est: { in: 200_000, out: 0 }, llm_calls: 2 } }).usd, 0.02, 'at the limit: priced');
});

test('runCost and the mixed-model check read the model under an eval effort tag', () => {
  assert.equal(baseModel('anthropic:claude-opus-5-5+effort=xhigh'), 'anthropic:claude-opus-5-5');
  assert.equal(baseModel('groq:openai/gpt-oss-120b'), 'groq:openai/gpt-oss-120b');
  assert.equal(runCost({ meta: { model: 'anthropic:claude-opus-5-5+effort=low' }, summary: { tokens_est: { in: 1_000_000, out: 0 }, llm_calls: 1 } }).usd, 4);
  const tagged = { meta: { model: 'anthropic:claude-opus-5-5+effort=low', run_id: 'r' }, results: [{ calls: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] }] };
  assert.deepEqual(partitionPublishable([tagged]).publishable, [tagged]);
  const other = { ...tagged, results: [{ calls: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }] }] };
  assert.match(partitionPublishable([other]).skipped[0].reason, /calls answered by anthropic:claude-sonnet-5-5/);
});

test('formatCost omits the per-call part when there is no call', () => {
  assert.equal(formatCost({ usd: 0, per_call_usd: null, source: 'chars/4 estimate, thinking tokens excluded' }), '$0');
  assert.equal(formatCost({ usd: 2, per_call_usd: 1, source: 'chars/4 estimate, thinking tokens excluded' }), '$2 ($1 per call)');
});

// #209: re-baseline. The suite gate (thresholds as registered, full dataset) is the caller's `gate`.
const answered = (model, n = 2) => Array.from({ length: n }, (_, i) => ({ case_id: `c${i}`, calls: [{ provider: model.split(':')[0], model: model.split(':').slice(1).join(':') }] }));
const pinnedRun = (opts) => ({ ...results(opts), results: answered(opts.model) });

test('rebaselineScorecard replaces only the suite of an eligible run on another model and reports the displaced runs', () => {
  let scorecard = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'a1', model: 'anthropic:x' })));
  scorecard = addRun(scorecard, 'validation', toScorecardRun(results({ runId: 'a2', model: 'anthropic:x', ts: '2026-10-02T00:00:00Z' })));
  scorecard = addRun(scorecard, 'review', toScorecardRun({ ...results({ runId: 'r0' }), meta: { ...results().meta, suite: 'review', run_id: 'r0' } }));
  const run = pinnedRun({ runId: 'g1', model: 'groq:m', ts: '2026-10-05T00:00:00Z' });
  const gateCalls = [];
  const out = rebaselineScorecard(scorecard, [run], { gate: (r) => { gateCalls.push(r.meta.run_id); return []; } });
  assert.deepEqual(out.scorecard.suites.validation.runs.map((r) => r.run_id), ['g1']);
  assert.deepEqual(out.scorecard.suites.review, scorecard.suites.review);
  assert.deepEqual(out.rebaselined, [{ suite: 'validation', run_id: 'g1', old_model: 'anthropic:x', new_model: 'groq:m', displaced_run_ids: ['a2', 'a1'] }]);
  assert.deepEqual(out.noops, [{ suite: 'review', run_id: null, reason: 'no review run in this build' }]);
  assert.deepEqual(gateCalls, ['g1']);
  assert.equal(scorecard.suites.validation.runs.length, 2, 'input not mutated');
});

test('rebaselineScorecard: same model, empty suite and missing meta are no-ops; the gate is not consulted', () => {
  const scorecard = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'g0' })));
  const gate = () => assert.fail('gate called on a no-op');
  const out = rebaselineScorecard(scorecard, [pinnedRun({ runId: 'g1', model: 'groq:m' }), {}], { gate });
  assert.deepEqual(out.scorecard, scorecard);
  assert.deepEqual(out.noops, [
    { suite: 'validation', run_id: 'g1', reason: 'same model groq:m as the published series' },
    { suite: null, run_id: null, reason: 'no published (unset suite) series to replace' },
  ]);
  assert.deepEqual(rebaselineScorecard(undefined, []).noops, []);
});

test('rebaselineScorecard refuses on its own checks and on the caller gate, keeping the history', () => {
  const scorecard = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'a1', model: 'anthropic:x' })));
  const variants = {
    'failed thresholds: per_class.invalid.recall': (r) => { r.failures = [{ metric: 'per_class.invalid.recall' }]; },
    'provider errors (error_rate 0.1, 0 errored or skipped run(s))': (r) => { r.summary.error_rate = 0.1; },
    'provider errors (error_rate unset, 0 errored or skipped run(s))': (r) => { delete r.summary; },
    'provider errors (error_rate 0, 1 errored or skipped run(s))': (r) => { r.results[0].skipped = true; },
    'mixed models: calls answered by anthropic:x': (r) => { r.results[0].calls = [{ provider: 'anthropic', model: 'x' }]; },
    'calls without a recorded provider: single model not proven': (r) => { r.results[0].calls = [{ model: 'm' }]; },
    'no answered call': (r) => { r.results = r.results.map((x) => ({ ...x, calls: [{ error: 'boom' }] })); },
    'meta.model unset': (r) => { delete r.meta.model; },
    'replay run': (r) => { r.meta.model = 'replay:groq:m'; },
    'gate says no': () => {},
  };
  for (const [reason, mutate] of Object.entries(variants)) {
    const run = pinnedRun({ runId: 'g1', model: 'groq:m' });
    mutate(run);
    const gate = () => (reason === 'gate says no' ? ['gate says no'] : []);
    const out = rebaselineScorecard(scorecard, [run], { gate });
    assert.equal(out.refused.length, 1, reason);
    assert.ok(out.refused[0].reasons.includes(reason), `${reason}: ${out.refused[0].reasons}`);
    assert.equal(out.refused[0].current, 'anthropic:x');
    assert.deepEqual(out.scorecard, scorecard, reason);
  }
});

test('rebaselineScorecard: one new series per suite per build; a later run on yet another model is refused', () => {
  const scorecard = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'a1', model: 'anthropic:x' })));
  const out = rebaselineScorecard(scorecard, [pinnedRun({ runId: 'g1', model: 'groq:m' }), pinnedRun({ runId: 'h1', model: 'groq:n' })]);
  assert.deepEqual(out.rebaselined.map((r) => r.run_id), ['g1']);
  assert.deepEqual(out.refused.map((r) => [r.run_id, r.current, r.reasons]), [['h1', 'groq:m', ['validation already re-baselined by run g1 in this build']]]);
});
