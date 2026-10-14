import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchPreviousSite, readPreviousSiteDir, assembleSite, writeSite, buildEvalSite, fetchPublishedBaseline, formatRunReport, buildRunReport,
} from '../build_eval_site.mjs';
import { emptyScorecard, addRun, toScorecardRun, MAX_RUNS } from '../lib/eval_scorecard.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build_eval_site.mjs');

function results({ runId = 'r1', ts = '2026-10-03T10:00:00.000Z', failures = [], errorRate = 0 } = {}) {
  return {
    meta: { suite: 'validation', run_id: runId, ts, model: 'groq:m', repeats: 1, dataset_sha256: 'abc' },
    summary: { n_cases: 1, n_runs: 1, error_rate: errorRate, scores: { verdict_match: { mean: 1, n: 1 } }, per_class: {}, latency_ms: { p95: 1 } },
    failures,
    results: [],
  };
}

const empty = () => ({ scorecard: emptyScorecard(), details: {} });
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// Routes are keyed without the cache-busting query; calls record the bare URL, options too.
function stubFetch(routes) {
  const calls = [];
  const options = [];
  const impl = async (url, opts) => {
    const bare = url.replace(/\?v=\d+$/, '');
    calls.push(bare);
    options.push({ url, opts });
    return routes[bare] ?? json(404, null);
  };
  return { impl, calls, options };
}

// ---------------------------------------------------------------------------
// fetchPreviousSite
// ---------------------------------------------------------------------------

test('fetchPreviousSite starts empty on a 404 only when allowEmpty is set (first deploy)', async () => {
  const { impl } = stubFetch({});
  assert.deepEqual(await fetchPreviousSite('https://x.io/site/', impl, { allowEmpty: true }), empty());
  await assert.rejects(fetchPreviousSite('https://x.io/site/', impl), /No scorecard at https:\/\/x\.io\/site\/scorecard\.json \(HTTP 404\)\. Pass --allow-empty/);
});

test('fetchPreviousSite bypasses the CDN and fetch caches', async () => {
  const { impl, options } = stubFetch({});
  await fetchPreviousSite('https://x.io', impl, { allowEmpty: true, cacheBust: 42 });
  assert.deepEqual(options, [{ url: 'https://x.io/scorecard.json?v=42', opts: { cache: 'no-store' } }]);
});

test('fetchPreviousSite reads the scorecard and each retained run, skipping missing details', async () => {
  const sc = addRun(addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'a', ts: '2026-10-01' }))), 'validation', toScorecardRun(results({ runId: 'b' })));
  const { impl, calls } = stubFetch({
    'https://x.io/site/scorecard.json': json(200, sc),
    'https://x.io/site/runs/b.json': json(200, results({ runId: 'b' })),
  });
  const logs = [];
  const prev = await fetchPreviousSite('https://x.io/site/', impl, { log: (m) => logs.push(m) });
  assert.deepEqual(logs, ['Warning: run a has no detail page on the previous site; its history row is kept without one']);
  assert.deepEqual(prev.scorecard, sc);
  assert.deepEqual(Object.keys(prev.details), ['b']);
  assert.deepEqual(calls, ['https://x.io/site/scorecard.json', 'https://x.io/site/runs/b.json', 'https://x.io/site/runs/a.json']);
});

test('fetchPreviousSite aborts on a non-404 error so history is never wiped', async () => {
  await assert.rejects(fetchPreviousSite('https://x.io', stubFetch({ 'https://x.io/scorecard.json': json(503, null) }).impl), /HTTP 503/);
  const sc = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'a' })));
  const { impl } = stubFetch({ 'https://x.io/scorecard.json': json(200, sc), 'https://x.io/runs/a.json': json(500, null) });
  await assert.rejects(fetchPreviousSite('https://x.io', impl), /Cannot read run a .*HTTP 500/);
});

test('fetchPreviousSite rejects an unsupported scorecard format', async () => {
  const { impl } = stubFetch({ 'https://x.io/scorecard.json': json(200, { version: 2, suites: {} }) });
  await assert.rejects(fetchPreviousSite('https://x.io', impl), /unsupported scorecard format/);
});

// ---------------------------------------------------------------------------
// readPreviousSiteDir / writeSite
// ---------------------------------------------------------------------------

test('readPreviousSiteDir starts empty without a scorecard and reads a written site back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  assert.deepEqual(await readPreviousSiteDir(dir), empty());
  const { files } = assembleSite({ previous: empty(), resultsList: [results({ runId: 'a' })] });
  await writeSite(files, dir);
  const prev = await readPreviousSiteDir(dir);
  assert.equal(prev.scorecard.suites.validation.runs[0].run_id, 'a');
  assert.equal(prev.details.a.meta.run_id, 'a');
});

test('readPreviousSiteDir skips a missing run file and rethrows other read errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const sc = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'a' })));
  await fs.writeFile(path.join(dir, 'scorecard.json'), JSON.stringify(sc));
  assert.deepEqual((await readPreviousSiteDir(dir)).details, {});
  await fs.mkdir(path.join(dir, 'runs', 'a.json'), { recursive: true }); // a directory: EISDIR
  await assert.rejects(readPreviousSiteDir(dir), /EISDIR/);
  await fs.writeFile(path.join(dir, 'scorecard.json'), JSON.stringify({ version: 1, suites: null }));
  await assert.rejects(readPreviousSiteDir(dir), /unsupported scorecard format/);
});

test('readPreviousSiteDir rethrows non-ENOENT errors on the scorecard', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  await fs.mkdir(path.join(dir, 'scorecard.json'));
  await assert.rejects(readPreviousSiteDir(dir), /EISDIR/);
});

// ---------------------------------------------------------------------------
// assembleSite
// ---------------------------------------------------------------------------

test('assembleSite adds publishable runs, skips error_rate failures and keeps details', () => {
  const outage = results({ runId: 'outage', errorRate: 1, failures: [{ metric: 'error_rate' }] });
  const { files, scorecard, skipped } = assembleSite({ previous: empty(), resultsList: [results({ runId: 'a' }), outage], generatedAt: 'T' });
  assert.deepEqual(scorecard.suites.validation.runs.map((r) => r.run_id), ['a']);
  assert.deepEqual(skipped.map((s) => s.run_id), ['outage']);
  assert.ok(files['runs/a.html']);
  assert.ok(!files['runs/outage.html']);
  assert.match(files['index.html'], /Updated T/);
  assert.match(files['index.html'], /<code>scores\.verdict_match\.mean<\/code>/, 'suite thresholds come from the registry');
});

test('assembleSite prunes details of runs that fell out of the history window', () => {
  let previous = empty();
  for (let i = 0; i < MAX_RUNS; i++) {
    const r = results({ runId: `old${i}`, ts: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` });
    previous = { scorecard: addRun(previous.scorecard, 'validation', toScorecardRun(r)), details: { ...previous.details, [`old${i}`]: r } };
  }
  const { files, scorecard } = assembleSite({ previous, resultsList: [results({ runId: 'new', ts: '2026-10-03T00:00:00Z' })] });
  assert.equal(scorecard.suites.validation.runs.length, MAX_RUNS);
  assert.ok(!files['runs/old0.json'], 'the oldest run is dropped with its detail page');
  assert.ok(files['runs/old1.json']);
  assert.ok(files['runs/new.json']);
});

test('assembleSite refuses two suites under one run_id (their runs/<id>.json would collide)', () => {
  const review = results({ runId: 'same' });
  review.meta = { ...review.meta, suite: 'review' };
  assert.throws(() => assembleSite({ previous: empty(), resultsList: [results({ runId: 'same' }), review] }), /run_id same is used by suites validation and review/);
  // Against the history too: a new review run cannot take a published validation run's id.
  const previous = { scorecard: addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'old' }))), details: {} };
  const clash = results({ runId: 'old' });
  clash.meta = { ...clash.meta, suite: 'review' };
  assert.throws(() => assembleSite({ previous, resultsList: [clash] }), /run_id old is used by suites validation and review/);
  // The same suite re-publishing its run_id (a re-run) replaces it; a skipped outage is not checked.
  const outage = results({ runId: 'same', errorRate: 1, failures: [{ metric: 'error_rate' }] });
  outage.meta = { ...outage.meta, suite: 'review' };
  const { scorecard } = assembleSite({ previous, resultsList: [results({ runId: 'old' }), results({ runId: 'same' }), outage] });
  assert.deepEqual(scorecard.suites.validation.runs.map((r) => r.run_id).sort(), ['old', 'same']);
});

test('assembleSite leaves a results file without run_id to toScorecardRun', () => {
  const bad = results();
  delete bad.meta.run_id;
  assert.throws(() => assembleSite({ previous: empty(), resultsList: [bad] }), /missing meta\.suite, meta\.run_id or summary/);
});

test('assembleSite rejects a replay run', () => {
  const replay = results({ runId: 'r' });
  replay.meta.model = 'replay:groq:m';
  assert.throws(() => assembleSite({ previous: empty(), resultsList: [replay] }), /is a replay/);
});

// ---------------------------------------------------------------------------
// buildEvalSite / CLI
// ---------------------------------------------------------------------------

test('buildEvalSite reads results files, uses the deployed site as history and writes the site', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const resultsFile = path.join(dir, 'validation-b.json');
  await fs.writeFile(resultsFile, JSON.stringify(results({ runId: 'b' })));
  const prevSc = addRun(emptyScorecard(), 'validation', toScorecardRun(results({ runId: 'a', ts: '2026-10-01T00:00:00Z' })));
  const { impl } = stubFetch({ 'https://x.io/scorecard.json': json(200, prevSc), 'https://x.io/runs/a.json': json(200, results({ runId: 'a' })) });
  const logs = [];
  const out = path.join(dir, 'out');
  await buildEvalSite({ outDir: out, siteUrl: 'https://x.io', resultFiles: [resultsFile], fetchImpl: impl, log: (m) => logs.push(m) });
  const sc = JSON.parse(await fs.readFile(path.join(out, 'scorecard.json'), 'utf8'));
  assert.deepEqual(sc.suites.validation.runs.map((r) => r.run_id), ['b', 'a']);
  await fs.access(path.join(out, 'runs', 'a.html'));
  await fs.access(path.join(out, 'runs', 'b.html'));
  assert.match(logs.join('\n'), /validation: 2 run\(s\) on the dashboard, latest b \(pass\)/);
});

test('buildEvalSite warns about skipped runs and works from a local previous dir or from nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const outage = path.join(dir, 'outage.json');
  await fs.writeFile(outage, JSON.stringify(results({ runId: 'o', errorRate: 1, failures: [{ metric: 'error_rate' }] })));
  const logs = [];
  await buildEvalSite({ outDir: path.join(dir, 'a'), resultFiles: [outage], log: (m) => logs.push(m) });
  // GitHub Actions gets a ::warning:: annotation, a terminal a plain prefix.
  assert.match(logs[0], /^(::warning::|Warning: )run o not recorded \(error_rate 1 above threshold\)/);
  await buildEvalSite({ outDir: path.join(dir, 'b'), previousDir: path.join(dir, 'a'), resultFiles: [], log: () => {} });
  await fs.access(path.join(dir, 'b', 'index.html'));
});

test('build_eval_site CLI requires --out', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, [SCRIPT]), (err) => err.code === 1 && /--out <dir> is required/.test(err.stderr));
});

test('build_eval_site CLI builds a site from a results file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const file = path.join(dir, 'r.json');
  await fs.writeFile(file, JSON.stringify(results({ runId: 'cli' })));
  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, '--out', path.join(dir, 'out'), file], { env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.match(stdout, /latest cli \(pass\)/);
  await fs.access(path.join(dir, 'out', 'runs', 'cli.html'));
});

test('build_eval_site CLI restores from --previous-dir even when --site-url is given', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const backup = path.join(dir, 'backup');
  const { files } = assembleSite({ previous: empty(), resultsList: [results({ runId: 'kept', ts: '2026-10-01T00:00:00Z' })] });
  await writeSite(files, backup);
  const file = path.join(dir, 'r.json');
  await fs.writeFile(file, JSON.stringify(results({ runId: 'new' })));
  // An unreachable --site-url proves the backup, not the network, is the history source.
  await promisify(execFile)(process.execPath, [SCRIPT, '--out', path.join(dir, 'out'), '--site-url', 'http://127.0.0.1:9', '--previous-dir', backup, file]);
  const sc = JSON.parse(await fs.readFile(path.join(dir, 'out', 'scorecard.json'), 'utf8'));
  assert.deepEqual(sc.suites.validation.runs.map((r) => r.run_id), ['new', 'kept']);
});

test('build_eval_site CLI publishes several suites of one workflow run in one build', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const validation = results({ runId: '42-validation' });
  const review = results({ runId: '42-review' });
  review.meta = { ...review.meta, suite: 'review' };
  const outage = results({ runId: '42-other', errorRate: 1, failures: [{ metric: 'error_rate' }] });
  const files = ['validation-42-validation.json', 'review-42-review.json', 'validation-42-other.json'].map((f) => path.join(dir, f));
  await Promise.all([validation, review, outage].map((r, i) => fs.writeFile(files[i], JSON.stringify(r))));
  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, '--out', path.join(dir, 'out'), ...files], { env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.match(stdout, /Warning: run 42-other not recorded/);
  const sc = JSON.parse(await fs.readFile(path.join(dir, 'out', 'scorecard.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(sc.suites).map(([k, v]) => [k, v.runs.map((r) => r.run_id)])), { validation: ['42-validation'], review: ['42-review'] });
  for (const id of ['42-validation', '42-review']) assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'out', 'runs', `${id}.json`), 'utf8')).meta.run_id, id);
});

test('buildEvalSite passes allowEmpty through to the site read-back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const { impl } = stubFetch({});
  await assert.rejects(buildEvalSite({ outDir: dir, siteUrl: 'https://x.io', resultFiles: [], fetchImpl: impl, log: () => {} }), /HTTP 404/);
  await buildEvalSite({ outDir: dir, siteUrl: 'https://x.io', resultFiles: [], fetchImpl: impl, allowEmpty: true, log: () => {} });
  await fs.access(path.join(dir, 'index.html'));
});

test('assembleSite publishes runs of several suites with each suite\'s registry thresholds', () => {
  const review = results({ runId: 'rv' });
  review.meta = { ...review.meta, suite: 'review' };
  const { scorecard, files } = assembleSite({ previous: empty(), resultsList: [results({ runId: 'v' }), review], generatedAt: 'T' });
  assert.deepEqual(Object.keys(scorecard.suites), ['validation', 'review']);
  assert.ok(files['runs/v.html'] && files['runs/rv.html']);
  assert.ok(files['badges/validation.json'] && files['badges/review.json']);
  assert.match(files['index.html'], /<code>per_class\.invalid\.recall<\/code>/);
  assert.match(files['index.html'], /<code>per_class\.request_changes\.recall<\/code>/);
  assert.match(files['index.html'], /<code>per_class\.approve\.recall<\/code>/);
});

// ---------------------------------------------------------------------------
// Issue #199: history per suite and model, --report
// ---------------------------------------------------------------------------

const anthropicRun = (runId = 'anth') => {
  const r = results({ runId, ts: '2026-10-14T00:00:00Z' });
  r.meta = { ...r.meta, suite: 'review', model: 'anthropic:claude-opus-5-5' };
  r.summary = { ...r.summary, llm_calls: 1, tokens_est: { in: 10_000, out: 2_000 } };
  r.results = [{ output: { verdict: 'APPROVE', diff_truncated: false, unreviewed_code_files: [] } }];
  return r;
};
const groqReview = (runId = 'groq') => {
  const r = results({ runId, ts: '2026-10-08T00:00:00Z' });
  r.meta = { ...r.meta, suite: 'review' };
  r.results = [{ output: { verdict: 'WITHHELD', diff_truncated: true, unreviewed_code_files: ['a.mjs'] } }];
  return r;
};

test('assembleSite never appends a run whose model is not the suite\'s published model; history stays intact', () => {
  const previous = { scorecard: addRun(emptyScorecard(), 'review', toScorecardRun(groqReview())), details: { groq: groqReview() } };
  const { scorecard, skipped, files } = assembleSite({ previous, resultsList: [anthropicRun()] });
  assert.deepEqual(scorecard.suites.review.runs.map((r) => r.run_id), ['groq']);
  assert.equal(skipped[0].kind, 'model_mismatch');
  assert.equal(files['runs/anth.json'], undefined);
  assert.ok(files['runs/groq.json']);
});

test('buildEvalSite reports a model mismatch as a notice, not a provider-failure warning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const backup = path.join(dir, 'backup');
  await writeSite(assembleSite({ previous: empty(), resultsList: [groqReview()] }).files, backup);
  const file = path.join(dir, 'anth.json');
  await fs.writeFile(file, JSON.stringify(anthropicRun()));
  for (const [actions, prefix] of [['true', '::notice::'], ['', 'Notice: ']]) {
    const logs = [];
    const saved = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = actions;
    try {
      await buildEvalSite({ outDir: path.join(dir, `out${actions}`), previousDir: backup, resultFiles: [file], log: (m) => logs.push(m) });
    } finally {
      if (saved === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = saved;
    }
    assert.ok(logs[0].startsWith(`${prefix}run anth not recorded: model anthropic:claude-opus-5-5 is not the review history's model groq:m`), logs[0]);
    assert.doesNotMatch(logs[0], /provider failure/);
  }
});

test('fetchPublishedBaseline returns the latest published run, its coverage recomputed from the detail when absent', async () => {
  const sc = addRun(emptyScorecard(), 'review', { ...toScorecardRun(groqReview()), coverage: undefined });
  delete sc.suites.review.runs[0].coverage;
  const { impl, calls } = stubFetch({ 'https://x.io/scorecard.json': json(200, sc), 'https://x.io/runs/groq.json': json(200, groqReview()) });
  const { run } = await fetchPublishedBaseline('https://x.io/', 'review', impl);
  assert.deepEqual(run.coverage, { n: 1, diff_truncated: 1, code_cut: 1, withheld: 1 });
  assert.deepEqual(calls, ['https://x.io/scorecard.json', 'https://x.io/runs/groq.json']);
});

test('fetchPublishedBaseline uses the row as is when it has coverage, and keeps it when the detail is gone', async () => {
  const withCoverage = addRun(emptyScorecard(), 'review', toScorecardRun(groqReview()));
  const a = stubFetch({ 'https://x.io/scorecard.json': json(200, withCoverage) });
  assert.equal((await fetchPublishedBaseline('https://x.io', 'review', a.impl)).run.run_id, 'groq');
  assert.deepEqual(a.calls, ['https://x.io/scorecard.json']);
  const old = structuredClone(withCoverage);
  delete old.suites.review.runs[0].coverage;
  const b = stubFetch({ 'https://x.io/scorecard.json': json(200, old) });
  assert.equal((await fetchPublishedBaseline('https://x.io', 'review', b.impl)).run.coverage, undefined);
});

test('fetchPublishedBaseline never throws: HTTP error, unknown suite or network failure become a reason', async () => {
  assert.deepEqual(await fetchPublishedBaseline('https://x.io', 'review', stubFetch({}).impl), { missing: 'scorecard.json: HTTP 404' });
  const sc = stubFetch({ 'https://x.io/scorecard.json': json(200, emptyScorecard()) });
  assert.deepEqual(await fetchPublishedBaseline('https://x.io', 'review', sc.impl), { missing: 'no published review run' });
  assert.deepEqual(await fetchPublishedBaseline('https://x.io', 'review', async () => { throw new Error('ECONNREFUSED'); }), { missing: 'ECONNREFUSED' });
});

test('formatRunReport puts the run next to the published baseline, with cost, coverage and the model-mismatch note', () => {
  const md = formatRunReport([{ suite: 'review', run: toScorecardRun(anthropicRun()), baseline: { run: toScorecardRun(groqReview()) } }]);
  assert.match(md, /chars\/4 token estimate/);
  assert.match(md, /\| this run \| `anthropic:claude-opus-5-5` \| `anth` \| verdict_match 1 \| 0 \| \$0\.08 \(\$0\.08 per call\) \| 0% \/ 0% \/ 0% \(n=1\) \|/);
  assert.match(md, /\| published \| `groq:m` \| `groq` \| verdict_match 1 \| 0 \| — \| 100% \/ 100% \/ 100% \(n=1\) \|/);
  assert.match(md, /Different models: this run is not appended to the `review` history/);
  const withClass = toScorecardRun({ ...anthropicRun(), summary: { ...anthropicRun().summary, per_class: { request_changes: { recall: 0.75 } } } });
  assert.match(formatRunReport([{ suite: 'review', run: withClass }]), /verdict_match 1 · request_changes recall 0\.75 \|/);
});

test('formatRunReport: no baseline row without --site-url, a reason when unavailable, no note for the same model', () => {
  const run = toScorecardRun(groqReview());
  const none = formatRunReport([{ suite: 'review', run }]);
  assert.doesNotMatch(none, /\| published|unavailable/);
  assert.match(formatRunReport([{ suite: 'review', run, baseline: { missing: 'HTTP 503' } }]), /> Published baseline unavailable: HTTP 503/);
  assert.doesNotMatch(formatRunReport([{ suite: 'review', run, baseline: { run } }]), /Different models/);
});

test('buildRunReport reads results files; the CLI --report needs no --out and builds no site', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-'));
  const file = path.join(dir, 'review-anth.json');
  await fs.writeFile(file, JSON.stringify(anthropicRun()));
  const { impl } = stubFetch({ 'https://x.io/scorecard.json': json(200, addRun(emptyScorecard(), 'review', toScorecardRun(groqReview()))) });
  assert.match(await buildRunReport({ resultFiles: [file], siteUrl: 'https://x.io', fetchImpl: impl }), /\| published \| `groq:m`/);
  const summary = path.join(dir, 'summary.md');
  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, '--report', file], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.match(stdout, /\| this run \| `anthropic:claude-opus-5-5`/);
  assert.match(await fs.readFile(summary, 'utf8'), /Eval run vs published baseline/);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['review-anth.json', 'summary.md']);
});

test('buildEvalSite failOnModelChange: a model change is an ::error:: and nothing is written', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const backup = path.join(dir, 'backup');
  await writeSite(assembleSite({ previous: empty(), resultsList: [groqReview()] }).files, backup);
  const drifted = groqReview('g2');
  drifted.meta = { ...drifted.meta, model: 'groq:new-model', ts: '2026-10-15T00:00:00Z' };
  const file = path.join(dir, 'g2.json');
  await fs.writeFile(file, JSON.stringify(drifted));
  const logs = [];
  const out = path.join(dir, 'out');
  await assert.rejects(
    buildEvalSite({ outDir: out, previousDir: backup, resultFiles: [file], failOnModelChange: true, log: (m) => logs.push(m) }),
    /model changed on the configured provider \(g2\).*#209/,
  );
  assert.match(logs[0], /^(::error::|Error: )run g2 not recorded: model groq:new-model is not the review history's model groq:m/);
  await assert.rejects(fs.access(out));
  // Same model: unaffected by the flag.
  const same = path.join(dir, 'g3.json');
  await fs.writeFile(same, JSON.stringify({ ...groqReview('g3'), meta: { ...groqReview('g3').meta, ts: '2026-10-16T00:00:00Z' } }));
  await buildEvalSite({ outDir: out, previousDir: backup, resultFiles: [same], failOnModelChange: true, log: () => {} });
  await fs.access(path.join(out, 'runs', 'g3.json'));
});

test('build_eval_site CLI --fail-on-model-change exits 1 on drift', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-'));
  const backup = path.join(dir, 'backup');
  await writeSite(assembleSite({ previous: empty(), resultsList: [groqReview()] }).files, backup);
  const file = path.join(dir, 'anth.json');
  await fs.writeFile(file, JSON.stringify(anthropicRun()));
  await assert.rejects(
    promisify(execFile)(process.execPath, [SCRIPT, '--out', path.join(dir, 'out'), '--previous-dir', backup, '--fail-on-model-change', file]),
    (err) => err.code === 1 && /model changed on the configured provider/.test(err.stderr),
  );
});

test('buildRunReport fails fast on a results file without meta.suite, before any request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-'));
  const file = path.join(dir, 'bad.json');
  await fs.writeFile(file, JSON.stringify({ meta: { run_id: 'x' }, summary: {} }));
  const { impl, calls } = stubFetch({});
  await assert.rejects(buildRunReport({ resultFiles: [file], siteUrl: 'https://x.io', fetchImpl: impl }), /missing meta\.suite/);
  assert.deepEqual(calls, []);
});
