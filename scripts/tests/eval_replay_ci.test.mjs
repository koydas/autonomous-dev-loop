import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  REPLAY_DISCLAIMER, siteGetter, dirGetter, loadPublishedRuns, sha256, diffDataset, replayRecorded,
  metricPaths, metricDeltas, verdictChanges, classifyGate, evaluateSuite, overallStatus,
  formatReplayReport, annotations, runReplayCi, getWithRetry,
} from '../lib/eval_replay_ci.mjs';
import { loadDataset, runSuite, summarize, checkThresholds, createReplayLLM } from '../lib/eval_harness.mjs';
import { reviewSuite, validationSuite } from '../lib/eval_suites.mjs';
import { parseCliArgs } from '../replay_evals_ci.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'replay_evals_ci.mjs');
const REVIEW_FIXTURE = path.join(REPO_ROOT, 'scripts', 'tests', 'fixtures', 'review-replay.json');
const REVIEW_DATASET = path.join(REPO_ROOT, reviewSuite.dataset);

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// get() over an in-memory site: { 'scorecard.json': body | status | Error, ... }; anything else is a 404.
function memoryGetter(files) {
  return async (rel) => {
    const entry = files[rel];
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'number') return json(entry, null);
    return entry === undefined ? json(404, null) : json(200, entry);
  };
}

const scorecardOf = (suites) => ({ version: 1, suites: Object.fromEntries(Object.entries(suites).map(([s, ids]) => [s, { runs: ids.map((run_id) => ({ run_id })) }])) });

// A "published" live run: the hand-written review fixture scored by the current code, with the dataset hash.
async function publishedReview({ runId = '100', results } = {}) {
  const recorded = results ?? JSON.parse(await fs.readFile(REVIEW_FIXTURE, 'utf8')).results;
  const cases = await loadDataset(REVIEW_DATASET);
  const scored = await runSuite({ suite: reviewSuite, cases, llmFor: createReplayLLM(recorded) });
  const summary = summarize(scored);
  return {
    meta: { run_id: runId, ts: '2026-10-05T10:00:00Z', model: 'groq:test', repeats: 1, suite: 'review', dataset: reviewSuite.dataset, dataset_sha256: sha256(await fs.readFile(REVIEW_DATASET)) },
    summary,
    failures: checkThresholds(summary, reviewSuite.thresholds),
    results: scored,
  };
}

// Same responses, but the code under test no longer finds the verdict line (a parseReviewVerdict regression).
const brokenReviewSuite = {
  ...reviewSuite,
  async run(input, { llm }) {
    await llm({ prompt: 'p', systemPrompt: 's' });
    throw new Error('No verdict line in the review (expected APPROVED or REQUEST_CHANGES)');
  },
};

async function writeSite(dir, published) {
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'scorecard.json'), JSON.stringify(scorecardOf({ review: [published.meta.run_id] })));
  await fs.writeFile(path.join(dir, 'runs', `${published.meta.run_id}.json`), JSON.stringify(published));
}

// Temp repo root whose review dataset is edited: the first case removed, one new case appended.
async function driftedRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-root-'));
  const lines = (await fs.readFile(REVIEW_DATASET, 'utf8')).split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  const first = JSON.parse(lines[0]);
  const added = { ...first, id: 'new-case-added' };
  await fs.mkdir(path.join(root, 'evals', 'datasets'), { recursive: true });
  await fs.writeFile(path.join(root, reviewSuite.dataset), [...lines.slice(1), JSON.stringify(added)].join('\n') + '\n');
  return { root, removedId: first.id };
}

// ---------------------------------------------------------------------------
// Site access
// ---------------------------------------------------------------------------

test('siteGetter requests <site>/<rel> with a cache bust, no-store and a timeout signal', async () => {
  const seen = [];
  const get = siteGetter('https://x.github.io/repo/', async (url, init) => { seen.push({ url, init }); return json(200, {}); }, { cacheBust: 42 });
  await get('runs/a%20b.json');
  assert.equal(seen[0].url, 'https://x.github.io/repo/runs/a%20b.json?v=42');
  assert.equal(seen[0].init.cache, 'no-store');
  assert.ok(seen[0].init.signal instanceof AbortSignal);
});

test('dirGetter serves files of a local site, 404 for a missing one, rethrows other errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-site-'));
  await fs.mkdir(path.join(dir, 'runs', 'dir.json'), { recursive: true });
  await fs.writeFile(path.join(dir, 'runs', 'a b.json'), '{"x":1}');
  const get = dirGetter(dir);
  const ok = await get('runs/a%20b.json');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { x: 1 });
  const missing = await get('scorecard.json');
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  assert.equal(await missing.json(), null);
  await assert.rejects(get('runs/dir.json'), /EISDIR/);
});

test('loadPublishedRuns: an unreadable scorecard makes the whole site unavailable', async () => {
  assert.deepEqual(await loadPublishedRuns(memoryGetter({}), ['review']), { available: false, reason: 'scorecard.json: HTTP 404' });
  assert.deepEqual(await loadPublishedRuns(memoryGetter({ 'scorecard.json': 503 }), ['review']), { available: false, reason: 'scorecard.json: HTTP 503' });
  assert.deepEqual(await loadPublishedRuns(memoryGetter({ 'scorecard.json': new Error('fetch failed') }), ['review']), { available: false, reason: 'scorecard.json: fetch failed' });
  assert.deepEqual(await loadPublishedRuns(memoryGetter({ 'scorecard.json': { version: 2, suites: {} } }), ['review']), { available: false, reason: 'scorecard.json: unsupported format' });
  assert.equal((await loadPublishedRuns(memoryGetter({ 'scorecard.json': { version: 1, suites: null } }), ['review'])).available, false);
});

test('loadPublishedRuns takes the newest run with a detail page, warning about skipped ones', async () => {
  const recorded = { meta: { suite: 'review', run_id: '2' }, results: [] };
  const out = await loadPublishedRuns(memoryGetter({ 'scorecard.json': scorecardOf({ review: ['3', '2', '1'] }), 'runs/2.json': recorded }), ['review', 'validation']);
  assert.equal(out.available, true);
  assert.equal(out.suites.review.recorded, recorded);
  assert.deepEqual(out.warnings, ['review: run 3 has no detail page on the site; trying the previous one']);
  assert.deepEqual(out.suites.validation, { missing: 'no live run published for this suite' });
});

test('loadPublishedRuns marks a suite missing on detail errors instead of failing the site', async () => {
  const sc = { 'scorecard.json': scorecardOf({ review: ['9'] }) };
  const none = await loadPublishedRuns(memoryGetter(sc), ['review']);
  assert.deepEqual(none.suites.review, { missing: 'no published run has a detail page' });
  const http = await loadPublishedRuns(memoryGetter({ ...sc, 'runs/9.json': 500 }), ['review']);
  assert.deepEqual(http.suites.review, { missing: 'runs/9.json: HTTP 500' });
  const thrown = await loadPublishedRuns(memoryGetter({ ...sc, 'runs/9.json': new Error('timeout') }), ['review']);
  assert.deepEqual(thrown.suites.review, { missing: 'runs/9.json: timeout' });
  const wrong = await loadPublishedRuns(memoryGetter({ ...sc, 'runs/9.json': { meta: { suite: 'validation' }, results: [] } }), ['review']);
  assert.deepEqual(wrong.suites.review, { missing: 'runs/9.json: not a review results file' });
  const noResults = await loadPublishedRuns(memoryGetter({ ...sc, 'runs/9.json': { meta: { suite: 'review' } } }), ['review']);
  assert.match(noResults.suites.review.missing, /not a review results file/);
});

// ---------------------------------------------------------------------------
// Dataset drift
// ---------------------------------------------------------------------------

test('diffDataset: same hash, changed hash, no recorded hash; added, removed and relabelled cases', () => {
  const recorded = { meta: { dataset_sha256: 'aaa' }, results: [
    { case_id: 'a', repeat: 0, expected_label: 'valid' }, { case_id: 'a', repeat: 1, expected_label: 'valid' },
    { case_id: 'b', repeat: 0, expected_label: 'invalid' }, { case_id: 'gone', repeat: 0, expected_label: 'valid' },
  ] };
  const cases = [{ id: 'a', expected: { valid: true } }, { id: 'b', expected: { valid: true } }, { id: 'new', expected: { valid: false } }];
  const expectedLabel = validationSuite.expectedLabel;
  assert.equal(diffDataset({ recorded, cases, currentSha: 'aaa', expectedLabel }).status, 'same');
  const d = diffDataset({ recorded, cases, currentSha: 'bbb', expectedLabel });
  assert.equal(d.status, 'changed');
  assert.deepEqual(d.added, ['new']);
  assert.deepEqual(d.removed, ['gone']);
  assert.deepEqual([...d.common], ['a', 'b']);
  assert.deepEqual(d.relabelled, [{ case_id: 'b', before: 'invalid', after: 'valid' }]);
  assert.equal(diffDataset({ recorded: { results: recorded.results }, cases, currentSha: 'aaa' }).status, 'unknown');
  assert.deepEqual(diffDataset({ recorded, cases, currentSha: 'bbb' }).relabelled, [], 'no expectedLabel: nothing to compare');
  assert.match(sha256('x'), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

test('metricPaths lists quality metrics of both summaries, never latency or tokens', () => {
  const a = { scores: { verdict_match: { mean: 1 } }, consistency: null, per_class: { valid: {} } };
  const b = { scores: { other: { mean: 0 } }, consistency: 0.9, per_class: {} };
  assert.deepEqual(metricPaths(a, b), [
    'error_rate', 'scores.verdict_match.mean', 'per_class.valid.precision', 'per_class.valid.recall', 'per_class.valid.f1',
    'scores.other.mean', 'consistency',
  ]);
  assert.deepEqual(metricPaths(undefined), ['error_rate']);
});

test('metricDeltas rounds the difference and leaves it empty when a side is missing', () => {
  const rows = metricDeltas({ error_rate: 0.1, scores: { m: { mean: 0.9 } } }, { error_rate: 0.3, scores: {}, consistency: 0.5 });
  assert.deepEqual(rows, [
    { metric: 'error_rate', before: 0.1, after: 0.3, delta: 0.2 },
    { metric: 'scores.m.mean', before: 0.9, after: null, delta: null },
    { metric: 'consistency', before: null, after: 0.5, delta: null },
  ]);
});

test('verdictChanges reports label and error flips per case × repeat', () => {
  const before = [
    { case_id: 'a', repeat: 0, label: 'approve' }, { case_id: 'a', repeat: 1, label: 'approve' },
    { case_id: 'b', repeat: 0, label: null, error: 'boom' }, { case_id: 'c', repeat: 0, label: null },
  ];
  const after = [
    { case_id: 'a', repeat: 0, label: 'approve', expected_label: 'approve' },
    { case_id: 'a', repeat: 1, label: null, error: 'No verdict line', expected_label: 'approve' },
    { case_id: 'b', repeat: 0, label: 'request_changes', expected_label: 'request_changes' },
    { case_id: 'c', repeat: 0, label: null, expected_label: 'approve' },
    { case_id: 'unmatched', repeat: 0, label: 'approve' },
  ];
  assert.deepEqual(verdictChanges(before, after), [
    { case_id: 'a', repeat: 1, expected: 'approve', before: 'approve', after: 'error', error: 'No verdict line' },
    { case_id: 'b', repeat: 0, expected: 'request_changes', before: 'error', after: 'request_changes', error: undefined },
  ]);
});

test('classifyGate: new failures block, known ones warn, a changed dataset only advises', () => {
  const replayFailures = [{ metric: 'error_rate' }, { metric: 'consistency' }];
  assert.deepEqual(classifyGate({ replayFailures, baselineFailures: [{ metric: 'consistency' }], datasetStatus: 'same' }), {
    blocking: [{ metric: 'error_rate' }], preexisting: [{ metric: 'consistency' }], advisory: [],
  });
  for (const datasetStatus of ['changed', 'unknown']) {
    assert.deepEqual(classifyGate({ replayFailures, baselineFailures: [], datasetStatus }), { blocking: [], preexisting: [], advisory: replayFailures });
  }
});

test('replayRecorded serves the recorded responses for the common cases and repeats only', async () => {
  const suite = { name: 's', scorers: { ok: (e, o) => o === e }, label: (o) => o, expectedLabel: (e) => e, run: async (_, { llm }) => llm({}) };
  const cases = [{ id: 'a', input: {}, expected: 'x', tags: [] }, { id: 'b', input: {}, expected: 'y', tags: [] }];
  const recorded = { meta: { repeats: 2 }, results: [0, 1].flatMap((repeat) => [
    { case_id: 'a', repeat, calls: [{ raw: 'x' }] }, { case_id: 'b', repeat, calls: [{ raw: 'z' }] },
  ]) };
  const results = await replayRecorded({ suite, cases, recorded, common: new Set(['a']) });
  assert.deepEqual(results.map((r) => [r.case_id, r.repeat, r.label]), [['a', 0, 'x'], ['a', 1, 'x']]);
  const single = await replayRecorded({ suite, cases, recorded: { results: recorded.results }, common: new Set(['b']) });
  assert.equal(single.length, 1, 'repeats default to 1');
});

// ---------------------------------------------------------------------------
// evaluateSuite
// ---------------------------------------------------------------------------

test('evaluateSuite: no published run is neutral', async () => {
  assert.deepEqual(await evaluateSuite({ suite: reviewSuite, published: { missing: 'nope' } }), { suite: 'review', status: 'neutral', reason: 'nope' });
  assert.equal((await evaluateSuite({ suite: reviewSuite, published: undefined })).reason, 'no published run');
});

test('evaluateSuite: the same code on the same dataset passes with zero deltas and no verdict change', async () => {
  const published = await publishedReview();
  const r = await evaluateSuite({ suite: reviewSuite, published: { recorded: published } });
  assert.equal(r.status, 'pass');
  assert.equal(r.dataset.status, 'same');
  assert.deepEqual(r.changes, []);
  assert.ok(r.deltas.every((d) => d.delta === 0 || d.delta == null), JSON.stringify(r.deltas));
});

test('evaluateSuite: a parser regression breaks thresholds the published run met and lists every flipped case', async () => {
  const published = await publishedReview();
  const r = await evaluateSuite({ suite: brokenReviewSuite, published: { recorded: published } });
  assert.equal(r.status, 'fail');
  assert.ok(r.gate.blocking.some((f) => f.metric === 'error_rate'));
  assert.ok(r.gate.blocking.some((f) => f.metric === 'scores.verdict_match.mean'));
  assert.equal(r.changes.length, published.results.filter((x) => !x.error).length);
  assert.ok(r.changes.every((c) => c.after === 'error'));
  assert.equal(r.deltas.find((d) => d.metric === 'error_rate').after, 1);
});

test('evaluateSuite: a threshold the published numbers already miss under the PR thresholds only warns', async () => {
  const published = await publishedReview();
  // Published as passing under the thresholds of its day; the PR (or main since) tightened the rule.
  assert.deepEqual(published.failures, []);
  const strict = { ...reviewSuite, thresholds: { 'scores.verdict_match.mean': { min: 0.99 } } };
  const r = await evaluateSuite({ suite: strict, published: { recorded: published } });
  assert.equal(r.status, 'warn');
  assert.deepEqual(r.gate.blocking, []);
  assert.equal(r.gate.preexisting[0].metric, 'scores.verdict_match.mean');
});

test('evaluateSuite: a run without a dataset hash is replayed, with advisory thresholds', async () => {
  const published = await publishedReview();
  delete published.meta.dataset_sha256;
  const r = await evaluateSuite({ suite: brokenReviewSuite, published: { recorded: published } });
  assert.equal(r.status, 'warn');
  assert.equal(r.dataset.status, 'unknown');
  assert.deepEqual(r.gate.blocking, []);
  assert.ok(r.gate.advisory.length > 0);
});

test('evaluateSuite: a changed dataset replays the common cases, lists added/removed, never blocks', async () => {
  const { root, removedId } = await driftedRoot();
  const published = await publishedReview();
  const r = await evaluateSuite({ suite: brokenReviewSuite, published: { recorded: published }, repoRoot: root });
  assert.equal(r.status, 'warn');
  assert.equal(r.dataset.status, 'changed');
  assert.deepEqual(r.dataset.added, ['new-case-added']);
  assert.deepEqual(r.dataset.removed, [removedId]);
  assert.equal(r.summary.n_cases, published.summary.n_cases - 1);
  assert.deepEqual(r.gate.blocking, []);
  assert.ok(r.gate.advisory.some((f) => f.metric === 'error_rate'));
  // Baseline re-summarized on the common subset, not the published full-dataset numbers.
  const ok = await evaluateSuite({ suite: reviewSuite, published: { recorded: published }, repoRoot: root });
  assert.ok(ok.deltas.every((d) => d.delta === 0 || d.delta == null), JSON.stringify(ok.deltas));
  assert.equal(ok.status, 'warn', 'a changed dataset is a warning even when every threshold holds');
});

test('evaluateSuite: no case in common with the published run is neutral', async () => {
  const published = await publishedReview();
  published.results = published.results.map((x) => ({ ...x, case_id: `old-${x.case_id}` }));
  published.meta.dataset_sha256 = 'old';
  const r = await evaluateSuite({ suite: reviewSuite, published: { recorded: published } });
  assert.equal(r.status, 'neutral');
  assert.equal(r.reason, 'no case in common with the published run');
  assert.equal(r.dataset.removed.length, published.results.length);
});

test('overallStatus: fail wins, all-neutral (or nothing) is neutral, any warning or neutral among passes warns', () => {
  const s = (...statuses) => overallStatus(statuses.map((status) => ({ status })));
  assert.equal(s('pass', 'fail', 'neutral'), 'fail');
  assert.equal(s('neutral', 'neutral'), 'neutral');
  assert.equal(s(), 'neutral');
  assert.equal(s('pass', 'neutral'), 'warn');
  assert.equal(s('pass', 'warn'), 'warn');
  assert.equal(s('pass', 'pass'), 'pass');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

test('formatReplayReport opens with the prompt-not-measured disclaimer and renders each outcome', async () => {
  const published = await publishedReview({ runId: 'r 1' });
  const { root } = await driftedRoot();
  const reports = [
    { suite: 'validation', status: 'neutral', reason: 'no live run published for this suite' },
    await evaluateSuite({ suite: brokenReviewSuite, published: { recorded: published } }),
    await evaluateSuite({ suite: brokenReviewSuite, published: { recorded: published }, repoRoot: root }),
  ];
  const md = formatReplayReport({ reports, siteUrl: 'https://x.github.io/repo/', warnings: ['skipped run 3'] });
  assert.ok(md.startsWith('# ❌ Eval replay\n\n' + REPLAY_DISCLAIMER));
  assert.match(md, /A prompt change is not measured/);
  assert.match(md, /- ⚠️ skipped run 3/);
  assert.match(md, /## ⚪ `validation`\n\nNot replayed: no live run published for this suite\./);
  assert.match(md, /Published run \[r 1\]\(https:\/\/x\.github\.io\/repo\/runs\/r%201\.html\)/);
  assert.match(md, /\| `error_rate` \| [\d.]+ \| 1 \| ▲ [\d.]+ \|/);
  assert.match(md, /\*\*❌ Thresholds broken by this PR\*\*/);
  assert.match(md, /case run\(s\) change verdict/);
  assert.match(md, /\| request_changes \| error \| No verdict line/);
  assert.match(md, /\*\*Dataset changed since the run\*\* \(`[0-9a-f]{12}` → `[0-9a-f]{12}`\)/);
  assert.match(md, /- Added \(not replayed\): `new-case-added`/);
  assert.match(md, /- Removed \(recorded, no longer in the dataset\): `/);
  assert.match(md, /\*\*⚠️ Threshold failures \(advisory, dataset changed\)\*\*/);
});

test('formatReplayReport: pass, preexisting, unknown hash, relabelled, neutral with dataset, row cap, no site link', () => {
  const base = { run: { run_id: '7', ts: 't', model: 'm', repeats: 1 }, deltas: [{ metric: 'error_rate', before: 0, after: 0, delta: 0 }] };
  const same = { status: 'same', common: new Set(['a']), added: [], removed: [], relabelled: [] };
  const md = formatReplayReport({ reports: [
    { ...base, suite: 'a', status: 'pass', dataset: same, gate: { blocking: [], preexisting: [], advisory: [] }, changes: [] },
    { ...base, suite: 'b', status: 'warn', dataset: same, gate: { blocking: [], preexisting: [{ metric: 'consistency', reason: '0.5 < min 0.9' }], advisory: [] },
      changes: Array.from({ length: 52 }, (_, i) => ({ case_id: `c${i}`, repeat: 0, expected: 'x', before: 'x', after: 'y', error: 'a|b\nc' })) },
    { ...base, suite: 'c', status: 'warn', dataset: { status: 'unknown', common: new Set(['a']), added: [], removed: [], relabelled: [{ case_id: 'a', before: 'x', after: 'y' }] },
      gate: { blocking: [], preexisting: [], advisory: [] }, changes: [] },
    { ...base, suite: 'd', status: 'neutral', reason: 'no case in common with the published run',
      dataset: { status: 'changed', recordedSha: 'a'.repeat(64), currentSha: 'b'.repeat(64), common: new Set(), added: [], removed: ['z'], relabelled: [] } },
  ] });
  assert.match(md, /^# ⚠️ Eval replay/);
  assert.match(md, /Published run `7` · t · `m` · repeats 1/);
  assert.match(md, /All thresholds met\.\n\nNo case changes verdict\./);
  assert.match(md, /\*\*⚠️ Already failing in the published run\*\*\n\n- `consistency`: 0\.5 < min 0\.9/);
  assert.match(md, /\| a\\\|b c \|/, 'pipes and newlines escaped in table cells');
  assert.match(md, /…and 2 more\./);
  assert.match(md, /\*\*The run recorded no dataset hash\*\*/);
  assert.match(md, /- Relabelled: `a` x → y/);
  assert.match(md, /- Removed \(recorded, no longer in the dataset\): `z`\n\nNot replayed: no case in common with the published run\./);
});

test('formatReplayReport: an unreachable site is a neutral report', () => {
  const md = formatReplayReport({ reports: [], unavailable: 'scorecard.json: HTTP 404' });
  assert.match(md, /^# ⚪ Eval replay/);
  assert.match(md, /\*\*Eval dashboard unreachable\*\* \(scorecard\.json: HTTP 404\): nothing replayed, the check is neutral\./);
  assert.ok(md.includes(REPLAY_DISCLAIMER));
});

test('annotations: warnings for neutral, drift, preexisting and advisory; errors for broken thresholds', () => {
  assert.deepEqual(annotations({ reports: [], unavailable: 'down' }), ['::warning::Eval replay skipped: dashboard unreachable (down)']);
  const out = annotations({ warnings: ['w'], reports: [
    { suite: 'a', status: 'neutral', reason: 'none' },
    { suite: 'b', status: 'fail', dataset: { status: 'same' }, gate: { blocking: [{ metric: 'error_rate', reason: '1 > max 0.05' }], preexisting: [{ metric: 'consistency', reason: 'r' }], advisory: [] } },
    { suite: 'c', status: 'warn', dataset: { status: 'changed' }, gate: { blocking: [], preexisting: [], advisory: [{ metric: 'm', reason: 'r' }] } },
    { suite: 'd', status: 'warn', dataset: { status: 'unknown' }, gate: { blocking: [], preexisting: [], advisory: [] } },
    { suite: 'e', status: 'neutral', reason: 'no common', dataset: { status: 'changed' } },
  ] });
  assert.deepEqual(out, [
    '::warning::w',
    '::warning::Eval replay a: not replayed (none)',
    '::warning::Eval replay b: consistency already failing in the published run (r)',
    '::error::Eval replay b: error_rate 1 > max 0.05',
    '::warning::Eval replay c: dataset changed since the published run; thresholds are advisory',
    '::warning::Eval replay c: m r (advisory)',
    '::warning::Eval replay d: dataset hash not recorded by the published run; thresholds are advisory',
    '::warning::Eval replay e: not replayed (no common)',
  ]);
});

// ---------------------------------------------------------------------------
// runReplayCi and the CLI
// ---------------------------------------------------------------------------

test('runReplayCi: unreachable site → neutral with a warning annotation', async () => {
  const out = await runReplayCi({ get: memoryGetter({ 'scorecard.json': new Error('ENOTFOUND') }), suites: [reviewSuite] });
  assert.equal(out.status, 'neutral');
  assert.deepEqual(out.reports, []);
  assert.match(out.markdown, /Eval dashboard unreachable/);
  assert.deepEqual(out.annotations, ['::warning::Eval replay skipped: dashboard unreachable (scorecard.json: ENOTFOUND)']);
});

test('runReplayCi replays every requested suite from the published site', async () => {
  const published = await publishedReview();
  const get = memoryGetter({ 'scorecard.json': scorecardOf({ review: ['100'] }), 'runs/100.json': published });
  const pass = await runReplayCi({ get, suites: [validationSuite, reviewSuite], siteUrl: 'https://s' });
  assert.deepEqual(pass.reports.map((r) => [r.suite, r.status]), [['validation', 'neutral'], ['review', 'pass']]);
  assert.equal(pass.status, 'warn');
  const fail = await runReplayCi({ get, suites: [brokenReviewSuite] });
  assert.equal(fail.status, 'fail');
});

test('parseCliArgs requires exactly one site source and known suites', () => {
  assert.throws(() => parseCliArgs([]), /exactly one of --site-url or --site-dir/);
  assert.throws(() => parseCliArgs(['--site-url', 'u', '--site-dir', 'd']), /exactly one/);
  assert.throws(() => parseCliArgs(['--site-dir', 'd', '--suite', 'nope']), /Unknown suite "nope"/);
  assert.deepEqual(parseCliArgs(['--site-url', 'u']).suites.map((s) => s.name), ['validation', 'review']);
  const one = parseCliArgs(['--site-dir', 'd', '--suite', 'review']);
  assert.deepEqual([one.siteDir, one.siteUrl, one.suites.map((s) => s.name)], ['d', undefined, ['review']]);
});

async function runScript(args, cwd) {
  const summary = path.join(cwd, 'summary.md');
  const env = { ...process.env, GITHUB_RUN_ID: 'replay-test', GITHUB_STEP_SUMMARY: summary };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [SCRIPT, ...args], { cwd, env });
    return { code: 0, stdout, stderr, summary: await fs.readFile(summary, 'utf8') };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr, summary: await fs.readFile(summary, 'utf8').catch(() => '') };
  }
}

test('replay_evals_ci.mjs: published run replayed clean → exit 0, step summary, trace and events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-ci-'));
  await writeSite(path.join(dir, 'site'), await publishedReview());
  const { code, stdout, stderr, summary } = await runScript(['--site-dir', path.join(dir, 'site'), '--suite', 'review'], dir);
  assert.equal(code, 0, stdout + stderr);
  assert.match(summary, /# ✅ Eval replay/);
  assert.match(summary, /A prompt change is not measured/);
  assert.match(stderr, /"event":"eval_replay\.start"/);
  assert.match(stderr, /"event":"eval_replay\.complete"[^\n]*"duration_ms":\d+/);
  const trace = JSON.parse(await fs.readFile(path.join(dir, 'observability', 'traces', 'replay-test.json'), 'utf8'));
  assert.ok(JSON.stringify(trace).includes('eval_replay'));
});

test('replay_evals_ci.mjs: recorded responses the code can no longer parse → exit 1 with ::error::', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-ci-'));
  // Published as passing, but the recorded raws carry no verdict line any more: same effect as a parser regression.
  const published = await publishedReview();
  for (const r of published.results) for (const c of r.calls) c.raw = 'garbled review';
  await writeSite(path.join(dir, 'site'), published);
  const { code, stdout, summary } = await runScript(['--site-dir', path.join(dir, 'site'), '--suite', 'review'], dir);
  assert.equal(code, 1);
  assert.match(stdout, /::error::Eval replay review: error_rate/);
  assert.match(summary, /Thresholds broken by this PR/);
});

test('replay_evals_ci.mjs: empty or unreadable site → neutral, exit 0; bad arguments → exit 1', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-ci-'));
  const neutral = await runScript(['--site-dir', path.join(dir, 'nothing')], dir);
  assert.equal(neutral.code, 0, neutral.stderr);
  assert.match(neutral.stdout, /::warning::Eval replay skipped: dashboard unreachable \(scorecard\.json: HTTP 404\)/);
  assert.match(neutral.summary, /# ⚪ Eval replay/);
  const bad = await runScript(['--suite', 'review'], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /exactly one of --site-url or --site-dir/);
  // A scorecard that cannot be read (here a directory) is an unreachable site, not a crash.
  await fs.mkdir(path.join(dir, 'broken', 'scorecard.json'), { recursive: true });
  const crashed = await runScript(['--site-dir', path.join(dir, 'broken'), '--suite', 'review'], dir);
  assert.equal(crashed.code, 0, 'an unreadable scorecard is still a neutral outcome');
});

// ---------------------------------------------------------------------------
// Review follow-ups on #179: retry, malformed published files, PR thresholds on both sides,
// PR-side crash
// ---------------------------------------------------------------------------

// get() that answers from a script of outcomes per call: a status number, an Error, or a body.
function scriptedGetter(outcomes) {
  const calls = [];
  const get = async (rel) => {
    calls.push(rel);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'number' ? json(next, null) : json(200, next);
  };
  return { get, calls };
}

test('getWithRetry retries once on a network error or a 5xx, never on a 4xx', async () => {
  const thrown = scriptedGetter([new Error('ECONNRESET'), { ok: 1 }]);
  assert.equal((await getWithRetry(thrown.get, 'a')).status, 200);
  assert.deepEqual(thrown.calls, ['a', 'a']);
  const fivexx = scriptedGetter([502, { ok: 1 }]);
  assert.equal((await getWithRetry(fivexx.get, 'a')).status, 200);
  assert.equal(fivexx.calls.length, 2);
  const notFound = scriptedGetter([404]);
  assert.equal((await getWithRetry(notFound.get, 'a')).status, 404);
  assert.equal(notFound.calls.length, 1);
  const twice = scriptedGetter([new Error('down'), new Error('still down')]);
  await assert.rejects(getWithRetry(twice.get, 'a'), /still down/);
  const twice5xx = scriptedGetter([503, 503]);
  assert.equal((await getWithRetry(twice5xx.get, 'a')).status, 503);
});

test('loadPublishedRuns survives one transient failure on the scorecard and on the run detail', async () => {
  const recorded = { meta: { suite: 'review', run_id: '1' }, results: [{ case_id: 'a', repeat: 0 }] };
  const { get, calls } = scriptedGetter([new Error('ETIMEDOUT'), scorecardOf({ review: ['1'] }), 500, recorded]);
  const out = await loadPublishedRuns(get, ['review']);
  assert.equal(out.available, true);
  assert.equal(out.suites.review.recorded, recorded);
  assert.deepEqual(calls, ['scorecard.json', 'scorecard.json', 'runs/1.json', 'runs/1.json']);
});

test('loadPublishedRuns treats a published file with malformed results as a missing run, not a crash', async () => {
  const sc = { 'scorecard.json': scorecardOf({ review: ['9'] }) };
  for (const results of [[null], [{ case_id: 1, repeat: 0 }], [{ case_id: 'a' }], [{ case_id: 'a', repeat: '0' }]]) {
    const out = await loadPublishedRuns(memoryGetter({ ...sc, 'runs/9.json': { meta: { suite: 'review' }, results } }), ['review']);
    assert.deepEqual(out.suites.review, { missing: 'runs/9.json: not a review results file' }, JSON.stringify(results));
  }
});

test('evaluateSuite: the published failures list is ignored — a code regression blocks even if it was recorded as failing', async () => {
  const published = await publishedReview();
  // Recorded under some other threshold set as failing error_rate; under the PR thresholds the numbers pass it.
  published.failures = [{ metric: 'error_rate', reason: 'stale' }];
  const r = await evaluateSuite({ suite: brokenReviewSuite, published: { recorded: published } });
  assert.equal(r.status, 'fail');
  assert.ok(r.gate.blocking.some((f) => f.metric === 'error_rate'));
  assert.ok(!r.gate.preexisting.some((f) => f.metric === 'error_rate'));
});

test('evaluateSuite: a loosened threshold that the published numbers now meet can block a regression', async () => {
  const published = await publishedReview();
  const loose = { ...reviewSuite, thresholds: { error_rate: { max: 0.5 } } };
  const ok = await evaluateSuite({ suite: loose, published: { recorded: published } });
  assert.equal(ok.status, 'pass');
  const broken = await evaluateSuite({ suite: { ...brokenReviewSuite, thresholds: loose.thresholds }, published: { recorded: published } });
  assert.deepEqual(broken.gate.blocking.map((f) => f.metric), ['error_rate']);
});

test('runReplayCi rejects when the PR\'s dataset is malformed (the CLI exits 1 with eval_replay.error)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-root-'));
  await fs.mkdir(path.join(root, 'evals', 'datasets'), { recursive: true });
  await fs.writeFile(path.join(root, reviewSuite.dataset), '{"id": "a", "input": {}, "expected": {}}\n{not json}\n');
  const published = await publishedReview();
  const get = memoryGetter({ 'scorecard.json': scorecardOf({ review: ['100'] }), 'runs/100.json': published });
  await assert.rejects(runReplayCi({ get, suites: [reviewSuite], repoRoot: root }), /review\.jsonl:2: invalid JSON/);
});
