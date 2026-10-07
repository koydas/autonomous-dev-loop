import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  jsonForScript,
  headlineScore,
  formatBadge,
  describeThreshold,
  trendChart,
  renderIndex,
  renderRun,
  buildSite,
} from '../lib/eval_site.mjs';
import { emptyScorecard, addRun, toScorecardRun } from '../lib/eval_scorecard.mjs';

function results({ runId = 'r1', ts = '2026-10-03T10:00:00.000Z', verdict = 1, failures = [], sha = 'a'.repeat(64) } = {}) {
  return {
    meta: { suite: 'validation', run_id: runId, ts, model: 'groq:openai/gpt-oss-120b', repeats: 3, dataset: 'evals/datasets/validation.jsonl', dataset_sha256: sha },
    summary: {
      n_cases: 15, n_runs: 45, error_rate: 0,
      scores: { verdict_match: { mean: verdict, n: 45 }, suggested_ac_count: { mean: 0.98, n: 45 } },
      consistency: 1,
      confusion: { invalid: { invalid: 27 }, valid: { valid: 17, __error__: 1 } },
      per_class: { invalid: { precision: 1, recall: 1, f1: 1, support: 27 } },
      latency_ms: { p50: 3436, p95: 14808 }, llm_calls: 45, tokens_est: { in: 86058, out: 8941 },
    },
    failures,
    results: [
      { case_id: 'valid-api', tags: ['valid'], repeat: 0, duration_ms: 1200, error: null, output: { valid: true }, label: 'valid', expected_label: 'valid', scores: { verdict_match: 1, suggested_ac_count: 1 }, calls: [{ raw: '{"valid":true}', latency_ms: 1100, tokens_in_est: 2000, tokens_out_est: 200 }] },
      { case_id: 'invalid-<b>', tags: ['invalid'], repeat: 1, duration_ms: 900, error: 'boom <script>', output: null, label: null, expected_label: 'invalid', scores: { verdict_match: 0, suggested_ac_count: null }, calls: [] },
    ],
  };
}

const scorecardOf = (...list) => list.reduce((sc, r) => addRun(sc, r.meta.suite, toScorecardRun(r)), emptyScorecard());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('escapeHtml escapes markup characters and tolerates null', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
});

test('jsonForScript cannot close the script tag', () => {
  const out = jsonForScript({ s: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</'));
  assert.deepEqual(JSON.parse(out), { s: '</script><script>alert(1)</script>' });
});

test('headlineScore is the first scorer, or null without scores', () => {
  assert.deepEqual(headlineScore({ scores: { verdict_match: 0.9, x: 1 } }), { name: 'verdict_match', value: 0.9 });
  assert.equal(headlineScore({ scores: {} }), null);
  assert.equal(headlineScore({}), null);
});

test('formatBadge renders pass, fail and no-run badges for shields.io', () => {
  const [pass] = scorecardOf(results()).suites.validation.runs;
  assert.deepEqual(formatBadge('validation', pass), { schemaVersion: 1, label: 'eval validation', message: 'verdict match 1 · pass', color: 'brightgreen', cacheSeconds: 300 });
  const fail = { ...pass, passed: false };
  assert.equal(formatBadge('validation', fail).color, 'red');
  assert.match(formatBadge('validation', fail).message, /fail$/);
  assert.equal(formatBadge('validation', { passed: true, scores: {} }).message, 'pass');
  assert.deepEqual(formatBadge('validation', undefined), { schemaVersion: 1, label: 'eval validation', message: 'no run yet', color: 'lightgrey' });
});

test('describeThreshold renders min, max and both', () => {
  assert.equal(describeThreshold({ min: 0.8 }), '≥ 0.8');
  assert.equal(describeThreshold({ max: 0.05 }), '≤ 0.05');
  assert.equal(describeThreshold({ min: 0.1, max: 0.9 }), '≥ 0.1 and ≤ 0.9');
});

// ---------------------------------------------------------------------------
// Trend chart
// ---------------------------------------------------------------------------

test('trendChart needs at least two runs', () => {
  const sc = scorecardOf(results());
  assert.match(trendChart('t', sc.suites.validation.runs), /from the second recorded run/);
  assert.match(trendChart('t', [{ scores: {} }, { scores: {} }]), /from the second recorded run/);
});

test('trendChart plots each scorer with a legend, an accessible label and tooltip data', () => {
  const sc = scorecardOf(results({ runId: 'a', ts: '2026-10-01T00:00:00Z', verdict: 0.9 }), results({ runId: 'b', verdict: 1 }));
  const html = trendChart('trend-validation', sc.suites.validation.runs);
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
  assert.match(html, /<i style="background:var\(--s1\)"><\/i>verdict_match/);
  assert.match(html, /aria-label="Score trend over the last 2 runs/);
  const data = JSON.parse(html.match(/<script type="application\/json">(.+?)<\/script>/)[1]);
  assert.deepEqual(data.points.map((p) => p.run), ['a', 'b'], 'oldest run first');
  assert.deepEqual(data.points[0].values, [0.9, 0.98]);
  assert.match(html, /textContent/, 'tooltip text is set with textContent, not innerHTML');
  assert.match(html, />0\.8<\/text>/, 'the y domain zooms to the data (lowest value 0.9 → axis from 0.8)');
  assert.doesNotMatch(html, />0<\/text>/);
  assert.doesNotMatch(html, /innerHTML/);
});

test('trendChart skips missing values instead of plotting zero', () => {
  const runs = [{ run_id: 'b', ts: '2026-10-02', scores: { s: 1 } }, { run_id: 'a', ts: '2026-10-01', scores: { s: null } }];
  const html = trendChart('t', runs);
  assert.equal((html.match(/<circle /g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

test('renderIndex shows an empty state without runs', () => {
  assert.match(renderIndex(emptyScorecard()), /No live eval run recorded yet/);
});

test('renderIndex shows gate, tiles with Δ, thresholds, trend and history', () => {
  const sc = scorecardOf(results({ runId: 'old', ts: '2026-10-01T00:00:00Z', verdict: 0.9 }), results({ runId: 'new', verdict: 1 }));
  const html = renderIndex(sc, { thresholds: { validation: { 'scores.verdict_match.mean': { min: 0.8 }, error_rate: { max: 0.05 } } }, generatedAt: '2026-10-03T11:00:00Z' });
  assert.match(html, /<title>Eval dashboard<\/title>/);
  assert.match(html, /status-good">✓ Pass/);
  assert.match(html, /verdict_match<\/div><div class="value">1<span class="delta">▲ 0\.1<\/span>/);
  assert.match(html, /tokens in \/ out<\/div><div class="value">86\.1k \/ 8\.9k/);
  assert.match(html, /<code>scores\.verdict_match\.mean<\/code><\/td><td>≥ 0\.8<\/td><td class="num">1<\/td><td><span class="ok">✓ pass/);
  assert.match(html, /<code>error_rate<\/code><\/td><td>≤ 0\.05<\/td><td class="num">0<\/td>/);
  assert.match(html, /href="runs\/new\.html">new<\/a>/);
  assert.match(html, /latency p95<\/div><div class="value">14\.8 s/);
  assert.match(html, /Updated 2026-10-03T11:00:00Z/);
  assert.match(html, /prefers-color-scheme: dark/);
});

test('renderIndex hides Δ when the dataset changed and marks failed thresholds', () => {
  const failing = results({ runId: 'new', verdict: 0.5, sha: 'b'.repeat(64), failures: [{ metric: 'scores.verdict_match.mean', reason: '0.5 < min 0.8' }] });
  const sc = scorecardOf(results({ runId: 'old', ts: '2026-10-01T00:00:00Z' }), failing);
  const html = renderIndex(sc, { thresholds: { validation: { 'scores.verdict_match.mean': { min: 0.8 } } } });
  assert.match(html, /dataset changed since the previous run: no Δ shown/);
  assert.doesNotMatch(html, /▼/);
  assert.match(html, /status-critical">✕ Fail<\/span> <span class="muted">scores\.verdict_match\.mean/);
  assert.match(html, /<span class="ko">✕ fail<\/span>/);
});

test('renderIndex marks an optional threshold the run did not measure as not measured, not passed', () => {
  const r = results();
  r.summary.consistency = null;
  const html = renderIndex(scorecardOf(r), { thresholds: { validation: { consistency: { min: 0.9, optional: true } } } });
  assert.match(html, /<code>consistency<\/code><\/td><td>≥ 0\.9<\/td><td class="num">[^<]*<\/td><td><span class="muted">– not measured/);
  const measured = renderIndex(scorecardOf(results()), { thresholds: { validation: { consistency: { min: 0.9, optional: true } } } });
  assert.match(measured, /<code>consistency<\/code><\/td><td>≥ 0\.9<\/td><td class="num">1<\/td><td><span class="ok">✓ pass/);
});

test('renderRun shows metrics, confusion matrix, cases and escaped model output', () => {
  const html = renderRun(results({ failures: [{ metric: 'error_rate', reason: '0.1 > max 0.05' }] }));
  assert.match(html, /<title>Eval run r1<\/title>/);
  assert.match(html, /Threshold failures/);
  assert.match(html, /<code>error_rate<\/code>: 0\.1 &gt; max 0\.05/);
  assert.match(html, /expected ↓ \/ predicted →/);
  assert.match(html, /<th class="num">__error__<\/th>/);
  assert.match(html, /<code>invalid-&lt;b&gt;<\/code>/);
  assert.match(html, /boom &lt;script&gt;/);
  assert.match(html, /\{&quot;valid&quot;:true\}/);
  assert.match(html, /actions\/runs\/r1/);
  assert.match(html, /href="\.\.\/index\.html"/);
  assert.doesNotMatch(html, /<script>alert|<b>/);
});

test('renderRun tolerates a minimal results file', () => {
  const html = renderRun({ meta: { run_id: 'x', suite: 'validation' } });
  assert.match(html, /Run <code>x<\/code>/);
  assert.doesNotMatch(html, /Confusion matrix/);
});

test('buildSite writes index, scorecard, badges and per-run pages for runs with details', () => {
  const a = results({ runId: 'a', ts: '2026-10-01T00:00:00Z' });
  const b = results({ runId: 'b' });
  const sc = scorecardOf(a, b);
  const files = buildSite({ scorecard: sc, details: { b }, thresholds: {}, generatedAt: null });
  assert.deepEqual(Object.keys(files).sort(), ['.nojekyll', 'badges/validation.json', 'index.html', 'runs/b.html', 'runs/b.json', 'scorecard.json', 'scorecard.md']);
  assert.deepEqual(JSON.parse(files['scorecard.json']), sc);
  assert.equal(JSON.parse(files['badges/validation.json']).color, 'brightgreen');
  assert.match(files['scorecard.md'], /# Eval scorecard/);
  assert.deepEqual(JSON.parse(files['runs/b.json']).meta.run_id, 'b');
});

test('buildSite on an empty scorecard still produces a valid site', () => {
  const files = buildSite({ scorecard: emptyScorecard() });
  assert.deepEqual(Object.keys(files).sort(), ['.nojekyll', 'index.html', 'scorecard.json', 'scorecard.md']);
});

test('buildSite writes a "no run yet" badge for a registered suite with no published run', () => {
  const files = buildSite({ scorecard: scorecardOf(results({ runId: 'v1' })), thresholds: { validation: {}, review: {} } });
  const badge = JSON.parse(files['badges/review.json']);
  assert.equal(badge.message, 'no run yet');
  assert.equal(badge.color, 'lightgrey');
  assert.equal(JSON.parse(files['badges/validation.json']).color, 'brightgreen');
});

function reviewResults({ runId = 'rv1', ts = '2026-10-05T10:00:00.000Z' } = {}) {
  const r = results({ runId, ts });
  r.meta = { ...r.meta, suite: 'review', dataset: 'evals/datasets/review.jsonl' };
  r.summary = {
    ...r.summary,
    scores: { verdict_match: { mean: 0.87, n: 69 }, flags_issue: { mean: 0.86, n: 42 }, no_false_alarm: { mean: 0.78, n: 27 } },
    confusion: { request_changes: { request_changes: 39, approve: 3 }, approve: { approve: 18, request_changes: 6 }, withheld: { withheld: 3 } },
    per_class: {
      request_changes: { precision: 0.87, recall: 0.93, f1: 0.9, support: 42 },
      approve: { precision: 0.86, recall: 0.75, f1: 0.8, support: 24 },
      withheld: { precision: 1, recall: 1, f1: 1, support: 3 },
    },
  };
  return r;
}

test('renderIndex and buildSite show several suites, each with its own gate, tiles, trend and badge', () => {
  const sc = scorecardOf(results({ runId: 'v1' }), reviewResults({ runId: 'rv0', ts: '2026-10-04T10:00:00Z' }), reviewResults({ runId: 'rv1' }));
  const thresholds = {
    validation: { 'per_class.invalid.recall': { min: 0.8 } },
    review: { 'per_class.request_changes.recall': { min: 0.8 }, 'per_class.approve.recall': { min: 0.6 } },
  };
  const html = renderIndex(sc, { thresholds });
  assert.match(html, /<h2><code>validation<\/code>/);
  assert.match(html, /<h2><code>review<\/code>/);
  assert.ok(html.indexOf('<code>validation</code>') < html.indexOf('<code>review</code>'), 'suites keep registry/insertion order');
  assert.match(html, /<code>per_class\.request_changes\.recall<\/code><\/td><td>≥ 0\.8<\/td><td class="num">0\.93<\/td><td><span class="ok">✓ pass/);
  assert.match(html, /<code>per_class\.approve\.recall<\/code><\/td><td>≥ 0\.6<\/td><td class="num">0\.75<\/td>/);
  assert.match(html, /withheld recall<\/div>/);
  assert.match(html, /id="trend-review"/);
  // The validation section has a single run: no trend chart id clash and no review threshold leaks into it.
  const validationSection = html.slice(html.indexOf('<code>validation</code>'), html.indexOf('<h2><code>review</code>'));
  assert.doesNotMatch(validationSection, /request_changes/);

  const files = buildSite({ scorecard: sc, details: { v1: results({ runId: 'v1' }), rv1: reviewResults() }, thresholds });
  assert.equal(JSON.parse(files['badges/review.json']).label, 'eval review');
  assert.match(JSON.parse(files['badges/review.json']).message, /^verdict match 0\.87/);
  assert.ok(files['badges/validation.json']);
  assert.match(files['runs/rv1.html'], /<code>review<\/code>/);
  assert.match(files['runs/rv1.html'], /<th class="num">withheld<\/th>/);
  assert.ok(files['runs/v1.html']);
});
