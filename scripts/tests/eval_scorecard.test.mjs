import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_RUNS,
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
