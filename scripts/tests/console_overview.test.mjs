import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { consoleContext, statusBanner } from '../lib/console_views.mjs';
import { consoleOverview, kpiRow, delta, sparkline, statusBadge, durationChart, providerList, issueCards } from '../lib/console_overview.mjs';
import { DEFINITIONS } from '../lib/pipeline_kpis.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf, HOSTILE, RAW_MARKERS } from './fixtures/pipeline/records.mjs';

const T = Date.parse('2026-10-16T10:00:00Z');
const modelOf = (records) => buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const noRaw = (html) => { for (const raw of RAW_MARKERS) assert.ok(!html.includes(raw), `raw ${raw}`); };

const withheld = (runId, t, pr = 50) => makeRecord({ runId, start: t, prNumber: pr, events: [
  { event: 'review.prompt_truncated', level: 'warn', meta: { diff_truncated: true, unreviewed_code_files: 5, prNumber: pr } },
  { event: 'review.verdict', meta: { verdict: 'WITHHELD', withheld_from: 'APPROVE', unreviewed_code_files: 5, prNumber: pr } },
] });

test('overview: status badge, windowed indicators with drill-down links, charts, problems, recent pipelines, definitions', () => {
  const ctx = consoleContext(modelOf([withheld('800', T), withheld('801', T + 60000, 51), withheld('802', T + 120000, 52)]));
  const html = consoleOverview(ctx, 'pipeline/');
  assert.match(html, /<h1>System overview<\/h1>/);
  assert.match(html, /<a class="status-badge tone-warn" href="pipeline\/diagnostics\.html">.*Running with issues/);
  // One block per window; the first shows, the others wait for the range select.
  assert.match(html, /<div data-window="7">/);
  assert.match(html, /<div data-window="14" hidden>/);
  assert.match(html, /<div data-window="30" hidden>/);
  assert.match(html, /<select data-range><option value="7">Last 7 days<\/option>/);
  // Each indicator links to what explains it.
  assert.match(html, /<a class="kpi2 tone-neutral" href="pipeline\/index\.html#executions" data-kpi="executions">/);
  assert.match(html, /href="pipeline\/diagnostics\.html#review-withheld" data-kpi="approve_rate"/);
  assert.match(html, /href="pipeline\/health\.html#performance" data-kpi="run_duration"/);
  assert.match(html, /href="pipeline\/health\.html#cost" data-kpi="llm_cost"/);
  assert.match(html, /<strong class="kpi-value">0 %<\/strong>/);
  assert.match(html, /0 of 3 verdicts · 3 withheld/);
  assert.match(html, /no prior 7 d data/, 'no previous window: no invented change');
  assert.match(html, /Pipeline results.*Duration trend.*LLM providers \(cost\)/s);
  assert.match(html, /Waiting on a person<\/span><strong>3 \/ 3/);
  assert.match(html, /Issues requiring attention/);
  assert.match(html, /href="pipeline\/diagnostics\.html#review-withheld"><span class="issue-head">/);
  assert.match(html, /<h2>Recent pipelines<\/h2>/);
  assert.equal((html.match(/<article class="flow-card/g) ?? []).length, 3);
  assert.match(html, /href="pipeline\/runs\/800-1\.html"/, 'row details link to run pages under pipeline/');
  assert.match(html, /href="pipeline\/traces\/[0-9a-f]{32}\.html">Full chronological flow/);
  for (const id of Object.keys(DEFINITIONS)) assert.ok(html.includes(`id="def-${id}"`), id);
  for (const src of scripts(html)) new Script(src);
});

test('overview on an empty model: no data is said, nothing looks healthy', () => {
  const html = consoleOverview(consoleContext(buildPipelineModel({})), '');
  assert.match(html, /<a class="status-badge tone-unknown"[^>]*>.*No data.*no pipeline run recorded yet/s);
  assert.match(html, /No pipeline run recorded yet: no indicator to compute/);
  assert.doesNotMatch(html.replace(/<script>[\s\S]*?<\/script>/g, ''), /tone-good/);
  assert.match(html, /No rule fired on the recorded data/);
  assert.match(html, /No recorded flows yet/);
  assert.match(html, /Waiting on a person<\/span><strong>0 \/ 0/);
});

test('indicators: change against the previous window, sparklines, providers; ok and critical statuses', () => {
  const ctx = consoleContext(modelOf([makeRecord({ runId: '810', start: T, events: [{ event: 'review.verdict', meta: { verdict: 'APPROVE', prNumber: 7 } }] })]));
  assert.equal(ctx.diagnosis.status, 'ok');
  assert.match(statusBanner(ctx.diagnosis, ctx.overview, ''), /No problem detected by the rules.*no finding is not proof of health/s);
  assert.match(statusBadge(ctx.diagnosis, ''), /No problem detected.*not proof of health/s);
  const kpis = kpiRow(ctx.windows[7], '', false);
  assert.match(kpis, /class="kpi2 tone-good" href="health\.html#reviews" data-kpi="approve_rate"/);
  // Changes: direction, tone and the window; a rate compares in points; a zero base is no base.
  assert.deepEqual(delta(12, 10, { better: 'down' }), { text: '+20 % vs prior 7 d', tone: 'bad', arrow: '↑' });
  assert.deepEqual(delta(0.5, 0.25, { better: 'up', points: true, days: 14 }), { text: '+25 pts vs prior 14 d', tone: 'good', arrow: '↑' });
  assert.deepEqual(delta(8, 10), { text: '-20 % vs prior 7 d', tone: 'neutral', arrow: '↓' });
  assert.equal(delta(10, 10).text, '= vs prior 7 d');
  for (const [cur, prev] of [[1, null], [null, 1], [1, 0]]) assert.equal(delta(cur, prev).tone, 'unknown');
  assert.equal(delta(0.5, 0, { points: true }).tone, 'neutral', 'a 0 % rate is a base for points');
  // Sparklines: gaps for nulls, flat dashed line without two points.
  // A null is a gap: two isolated points, no line bridging them.
  const gap = sparkline([1, null, 3], { label: 'x' });
  assert.doesNotMatch(gap, /<polyline/);
  assert.equal((gap.match(/<circle /g) ?? []).length, 2);
  const split = sparkline([1, 2, null, 3, 4], { label: 'x' });
  assert.equal((split.match(/<polyline /g) ?? []).length, 2, 'one line per contiguous run');
  assert.equal((split.match(/<polygon /g) ?? []).length, 2, 'one area per contiguous run');
  assert.match(sparkline([null, 2], { label: 'x' }), /not enough data for a trend/);
  assert.match(sparkline([0, 0], { label: 'x' }), /polyline/);
  // Duration and providers.
  assert.match(durationChart([{ day: '2026-10-01', avg_ms: 1000, p95_ms: 2000 }]), /<tr><td>2026-10-01<\/td><td class="num">1\.0 s<\/td><td class="num">2\.0 s<\/td><\/tr>/);
  assert.equal(durationChart([{ day: 'd', avg_ms: null, p95_ms: null }]), '<p class="muted">No timed run in the window.</p>');
  const prov = providerList([{ provider: 'anthropic', calls: 1, usd: 0.5, measured: 1, estimated: 0, free: 0, usd_share: 1, call_share: 0.25 }, { provider: 'groq', calls: 3, usd: 0, measured: 0, estimated: 0, free: 3, usd_share: 0, call_share: 0.75 }, { provider: 'x', calls: 1, usd: 0, measured: 0, estimated: 0, free: 0, usd_share: null, call_share: 0.1 }]);
  assert.match(prov, /anthropic<\/span><span class="pcost">\$0\.5000<\/span><span class="pshare">100 %/);
  // Some calls unpriced: the amount is a lower bound.
  assert.match(providerList([{ provider: 'anthropic', calls: 2, usd: 0.5, measured: 1, estimated: 0, free: 0, unpriced: 1, usd_share: null, call_share: 1 }]), /<span class="pcost">≥ \$0\.5000<\/span><span class="pshare">—/);
  assert.match(prov, /groq<\/span><span class="pcost">free tier<\/span>.*75 % of calls/s);
  assert.match(prov, /x<\/span><span class="pcost">unpriced<\/span><span class="pshare">—/);
  assert.equal(providerList([]), '<p class="muted">No LLM call in the window.</p>');
  // Critical status counts critical findings; issue cards say how many runs and since when.
  const failed = consoleContext(modelOf([makeRecord({ runId: '830', start: T, outcome: 'failed' })]));
  assert.match(statusBanner(failed.diagnosis, failed.overview, ''), /Attention needed: 1 critical problem/);
  assert.match(statusBadge(failed.diagnosis, ''), /tone-bad.*Attention needed.*1 critical problem/s);
  assert.match(issueCards(failed.diagnosis, ''), /Affects 1 run\(s\)<\/span><span>Since: <span data-ts="\d+">/);
});


test('LLM cost change: never against a side with unpriced calls, and an all-unpriced window is not "free tier" (PR #242 review)', () => {
  const sum = (o) => ({ usd: 0, calls: 0, measured: 0, estimated: 0, free: 0, unpriced: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, ...o });
  const win = (cur, prev) => ({ days: 7, series: [], current: { runs: 1, failed: 0, adverse: 0, progressed: 1, neutral: 0, verdicts: 0, approve: 0, withheld: 0, request_changes: 0, approve_rate: null, duration: { n: 0, mean: null, p95: null }, cost: cur }, previous: { runs: 1, verdicts: 0, duration: { mean: null }, cost: prev } });
  const card = (html) => html.slice(html.indexOf('data-kpi="llm_cost"'));
  // Only unpriced calls now, priced calls before: no -100 % "improvement".
  const unpriced = card(kpiRow(win(sum({ calls: 2, unpriced: 2 }), sum({ calls: 1, estimated: 1, usd: 0.5 })), '', false));
  assert.match(unpriced, /<strong class="kpi-value">unpriced<\/strong>/);
  assert.match(unpriced, /no change: unpriced calls make a side incomplete/);
  assert.doesNotMatch(unpriced, /-100 %|free tier only/);
  assert.match(unpriced, /2 call\(s\) · no priced call · 2 unpriced, not counted/);
  // Mixed now (a lower bound): no change either.
  assert.match(card(kpiRow(win(sum({ calls: 2, estimated: 1, unpriced: 1, usd: 0.1 }), sum({ calls: 1, estimated: 1, usd: 0.5 })), '', false)), /no change: unpriced calls make a side incomplete/);
  // Fully priced on both sides: the change is shown; free tier only is named as such.
  assert.match(card(kpiRow(win(sum({ calls: 1, estimated: 1, usd: 0.25 }), sum({ calls: 1, estimated: 1, usd: 0.5 })), '', false)), /↓ -50 % vs prior 7 d/);
  assert.match(card(kpiRow(win(sum({ calls: 3, free: 3 }), sum({ calls: 3, free: 3 })), '', false)), /3 call\(s\) · free tier only · list price/);
  assert.match(card(kpiRow(win(sum({ calls: 1, estimated: 1, usd: 0.25 }), sum({})), '', false)), /no prior 7 d data/);
  // A free-tier-only previous window is a real $0, not missing data (PR #242 review).
  assert.match(card(kpiRow(win(sum({ calls: 1, estimated: 1, usd: 0.25 }), sum({ calls: 3, free: 3 })), '', false)), /↑ up from 0 vs prior 7 d/);
  assert.match(card(kpiRow(win(sum({ calls: 3, free: 3 }), sum({ calls: 3, free: 3 })), '', false)), /= vs prior 7 d/);
});

test('delta with a populated zero base: equal, up or down from 0, never a percentage', () => {
  assert.deepEqual(delta(0, 0, { zeroBase: true }), { text: '= vs prior 7 d', tone: 'neutral', arrow: '' });
  assert.deepEqual(delta(2, 0, { zeroBase: true, better: 'down', days: 14 }), { text: 'up from 0 vs prior 14 d', tone: 'bad', arrow: '↑' });
  assert.deepEqual(delta(2, 0, { zeroBase: true }), { text: 'up from 0 vs prior 7 d', tone: 'neutral', arrow: '↑' });
  assert.deepEqual(delta(-1, 0, { zeroBase: true, better: 'down' }), { text: 'down from 0 vs prior 7 d', tone: 'good', arrow: '↓' });
  assert.equal(delta(null, 0, { zeroBase: true }).tone, 'unknown');
  assert.equal(delta(1, 0).tone, 'unknown', 'without zeroBase a 0 base is still missing data');
});

test('duration chart: a day without a timed run is a gap in both lines (PR #242 review)', () => {
  const day = (d, avg, p95) => ({ day: `2026-10-0${d}`, avg_ms: avg, p95_ms: p95 });
  const html = durationChart([day(1, 1000, 2000), day(2, 1500, 2500), day(3, null, null), day(4, 1200, 2200), day(5, 900, 1900)]);
  assert.equal((html.match(/<polyline /g) ?? []).length, 4, 'average and p95, two segments each');
  // Isolated values keep their dot but draw no line.
  const lone = durationChart([day(1, 1000, 2000), day(2, null, null), day(3, 1200, 2200)]);
  assert.equal((lone.match(/<polyline /g) ?? []).length, 0);
  assert.equal((lone.match(/<circle /g) ?? []).length, 4, 'average and p95 dots for each isolated day');
  assert.equal((lone.match(/class="dot-p95"/g) ?? []).length, 2);
});
