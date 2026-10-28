import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { consoleContext, statusBanner } from '../lib/console_views.mjs';
import { consoleOverview, overviewTrends, kpiRow, delta, sparkline, durationChart, providerList, activeProblems, shortAmount } from '../lib/console_overview.mjs';
import { DEFINITIONS } from '../lib/pipeline_kpis.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { makeRecord, makeClosingRecord, asFiles, indexesOf, HOSTILE, RAW_MARKERS } from './fixtures/pipeline/records.mjs';

const T = Date.parse('2026-10-16T10:00:00Z');
const modelOf = (records) => buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const noRaw = (html) => { for (const raw of RAW_MARKERS) assert.ok(!html.includes(raw), `raw ${raw}`); };

const withheld = (runId, t, pr = 50, from = 'APPROVE') => makeRecord({ runId, start: t, prNumber: pr, events: [
  { event: 'review.prompt_truncated', level: 'warn', meta: { diff_truncated: true, unreviewed_code_files: 5, prNumber: pr } },
  { event: 'review.verdict', meta: { verdict: 'WITHHELD', withheld_from: from, unreviewed_code_files: 5, prNumber: pr } },
] });

test('overview: status, indicators, stages, gates, waiting — one content at every width, each card a drill-down; trends on Metrics', () => {
  const ctx = consoleContext(modelOf([withheld('800', T), withheld('801', T + 60000, 51), withheld('802', T + 120000, 52, 'REQUEST_CHANGES')]));
  const html = consoleOverview(ctx, 'pipeline/');
  assert.match(html, /<h1>System overview<\/h1>/);
  // The status names the most severe active problem and opens its card.
  assert.match(html, /<a class="g-status status-banner tone-warn" href="pipeline\/diagnostics\.html#review-withheld">.*Running with issues.*\d+ problem\(s\) · /s);
  // Blocks in a fixed order (amendment 2026-10-28): hero, status, the four 7-day indicators, five stages, the eval
  // gates, Waiting on you. The phone lays out the same blocks (CSS): no second set of rows.
  const order = ['class="home-hero"', 'class="g-status', 'class="cockpit"', 'data-kpi="executions"', 'data-kpi="approve_rate"', 'data-kpi="run_duration"', 'data-kpi="llm_cost"', 'class="stage-strip', 'class="quality-panel', 'id="g-waiting"'].map((m) => html.indexOf(m));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), String(order));
  assert.doesNotMatch(html, /g-phone|id="g-(flows|cost|quality)"/, 'no phone-only rows');
  assert.equal(html.match(/id="g-waiting"/g).length, 1);
  // Cards open their page; the approval card goes to the withheld finding that explains it.
  assert.match(html, /<a class="kpi2 tone-neutral" href="pipeline\/index\.html#executions" data-kpi="executions">/);
  assert.match(html, /href="pipeline\/diagnostics\.html#review-withheld" data-kpi="approve_rate">.*0 of 3 verdicts · 3 withheld/s);
  assert.match(html, /href="pipeline\/health\.html#cost" data-kpi="llm_cost"/);
  assert.doesNotMatch(html, /state=failed/, 'no run-class count behind an item filter');
  assert.match(html, /id="g-waiting"><a class="g-head" href="pipeline\/flows\.html#waiting">/);
  assert.match(html, /<a href="pipeline\/health\.html#trends">Trends, 14 \/ 30 days and definitions →<\/a>/);
  // What the home does not carry: windows, charts, problem cards, recent pipelines, definitions.
  assert.doesNotMatch(html, /data-window=|Issues requiring attention|Recent pipelines|id="def-/);
  for (const [n, name, href] of [[1, 'Issue', 'pipeline/flows.html?kind=issue&amp;period=7'], [2, 'Code', 'pipeline/health.html#funnel'], [3, 'Review', 'pipeline/diagnostics.html#review-withheld'], [4, 'Auto-fix', 'pipeline/health.html#autofix'], [5, 'Merge', 'pipeline/flows.html?state=merged&amp;period=7']]) {
    assert.match(html, new RegExp(`<a class="stage-card st-[a-z]+" href="${href.replace(/[?.]/g, '\\$&')}">.*?<strong>${n}\\. ${name}</strong>`), name);
  }
  assert.match(html, /<strong>0 %<\/strong><span>approval rate<\/span><\/span><span class="stage-note">0 of 3 verdicts/);
  assert.match(html, /<strong>0<\/strong><span>merged<\/span>/);
  assert.match(html, /class="quality-panel panel"[^>]*>.*<a href="evals\.html">Evals →<\/a>.*No eval run published/s, 'quality links resolve from the site root');
  assert.match(html, /data-kpi="executions">.*?<strong class="kpi-value">3<\/strong><\/span>/s, 'no change on an empty previous window');
  // The trends block (Metrics): one block per window, indicators linked to what explains them, definitions.
  const trends = overviewTrends(ctx, 'pipeline/');
  assert.match(trends, /<div data-window="7">/);
  assert.match(trends, /<div data-window="14" hidden>/);
  assert.match(trends, /<div data-window="30" hidden>/);
  assert.match(trends, /<select data-range><option value="7">Last 7 days<\/option>/);
  assert.match(trends, /<a class="kpi2 tone-neutral" href="pipeline\/index\.html#executions" data-kpi="executions">/);
  assert.match(trends, /href="pipeline\/diagnostics\.html#review-withheld" data-kpi="approve_rate"/);
  assert.match(trends, /href="pipeline\/health\.html#performance" data-kpi="run_duration"/);
  assert.match(trends, /href="pipeline\/health\.html#cost" data-kpi="llm_cost"/);
  assert.match(trends, /<strong class="kpi-value">0 %<\/strong>/);
  assert.match(trends, /0 of 3 verdicts · 3 withheld/);
  assert.match(trends, /no prior 7 d data/, 'no previous window: no invented change');
  assert.match(trends, /Pipeline results.*Duration trend.*LLM providers \(cost\)/s);
  assert.match(trends, /Waiting on a person<\/span><strong>3 \/ 3/);
  for (const id of Object.keys(DEFINITIONS)) assert.ok(trends.includes(`id="def-${id}"`), id);
  for (const src of scripts(trends)) new Script(src);
});

test('overview on an empty model: no data is said, nothing looks healthy', () => {
  const ctx = consoleContext(buildPipelineModel({}));
  const html = consoleOverview(ctx, '');
  assert.match(html, /<a class="g-status status-banner tone-unknown"[^>]*>.*No data.*no pipeline run recorded yet/s);
  assert.match(html, /class="cockpit"><div class="panel"><p>No pipeline run recorded yet: no indicator to compute/);
  assert.doesNotMatch(html, /data-kpi=|stage-strip/, 'no indicator nor stage without a run');
  assert.match(html, /id="g-waiting">.*<strong class="g-value">0<\/strong>/s);
  assert.doesNotMatch(html, /tone-good/);
  const trends = overviewTrends(ctx, '');
  assert.match(trends, /No pipeline run recorded yet: no indicator to compute/);
  assert.doesNotMatch(trends.replace(/<script>[\s\S]*?<\/script>/g, ''), /tone-good/);
  assert.match(trends, /Waiting on a person<\/span><strong>0 \/ 0/);
});

test('indicators: change against the previous window, sparklines, providers; ok and critical statuses', () => {
  const ctx = consoleContext(modelOf([makeRecord({ runId: '810', start: T, events: [{ event: 'review.verdict', meta: { verdict: 'APPROVE', prNumber: 7 } }] })]));
  assert.equal(ctx.diagnosis.status, 'ok');
  assert.match(statusBanner(ctx.diagnosis, ctx.overview, ''), /No problem detected by the rules.*no finding is not proof of health/s);
  assert.match(consoleOverview(ctx, ''), /class="g-status status-banner tone-good" href="diagnostics\.html">.*No problem detected.*not proof of health/s);
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
  assert.match(consoleOverview(failed, ''), /class="g-status status-banner tone-bad"[^>]*>.*Attention needed.*1 problem\(s\) · /s);
  assert.match(consoleOverview(failed, ''), /<a class="kpi2 tone-bad" href="index\.html#executions" data-kpi="executions">.*1 failed/s);
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

test('problems named on the home: only active warning / critical findings; resolved and by-design ones stay on Diagnostics', () => {
  const f = (id, severity, status) => ({ id, severity, status, title: `T-${id}`, impact: 'i', runs: ['1-1'], evidence: [], category: 'Review' });
  const d = { status: 'warning', gaps: [], findings: [f('a', 'critical', 'active'), f('b', 'warning', 'active'), f('c', 'info', 'resolved'), f('d', 'info', 'active')] };
  assert.deepEqual(activeProblems(d).map((x) => x.id), ['a', 'b']);
  const ctx = consoleContext(buildPipelineModel({}));
  const html = consoleOverview({ ...ctx, diagnosis: d }, '');
  assert.match(html, /href="diagnostics\.html#a">.*2 problem\(s\) · T-a/s);
  assert.doesNotMatch(html, /T-b|T-c|T-d/, 'the most severe one only: the rest is on Diagnostics');
  const none = consoleOverview({ ...ctx, diagnosis: { ...d, status: 'ok', findings: [f('c', 'info', 'resolved')] } }, '');
  assert.match(none, /href="diagnostics\.html">.*No problem detected.*by the rules — not proof of health/s);
});

test('cost card and quality panel: short amounts, per-suite rows, a change only on a populated base', () => {
  const sum = (o) => ({ usd: 0, calls: 0, measured: 0, estimated: 0, free: 0, unpriced: 0, ...o });
  assert.equal(shortAmount(sum({})), '—');
  assert.equal(shortAmount(sum({ calls: 2, free: 2 })), 'free tier');
  assert.equal(shortAmount(sum({ calls: 2, unpriced: 2 })), 'unpriced');
  assert.equal(shortAmount(sum({ calls: 1, measured: 1, usd: 3.966 })), '$3.97');
  assert.equal(shortAmount(sum({ calls: 1, measured: 1, usd: 0.004 })), '< $0.01');
  assert.equal(shortAmount(sum({ calls: 2, measured: 1, unpriced: 1, usd: 0.5 })), '≥ $0.50');
  // A window with priced calls on two stages; the previous window is too small for a change.
  const opus = { provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 1000 };
  const ctx = consoleContext(modelOf([
    makeRecord({ runId: '870', start: T, events: [{ event: 'review.verdict', meta: { verdict: 'APPROVE', prNumber: 7 } }] }),
  ]));
  const w = ctx.windows[7];
  const priced = { ...w, current: { ...w.current, cost: sum({ calls: 3, measured: 3, usd: 1.5 }) }, previous: { ...w.previous, runs: 2, cost: sum({ calls: 1, measured: 1, usd: 0.01 }) }, stages: [{ stage: 'review', ...sum({ calls: 2, measured: 2, usd: 1.2 }) }, { stage: 'autofix', ...sum({ calls: 1, measured: 1, usd: 0.3 }) }] };
  const small = consoleOverview({ ...ctx, windows: { ...ctx.windows, 7: priced } }, '');
  assert.match(small, /data-kpi="llm_cost">.*<strong class="kpi-value">\$1\.50<\/strong><\/span>/s, 'no +14900 % on a 2-run base');
  assert.doesNotMatch(small, /review \$1\.20/, 'the cost per stage is on Metrics → cost, not on the home');
  const big = consoleOverview({ ...ctx, windows: { ...ctx.windows, 7: { ...priced, previous: { ...priced.previous, runs: 10, cost: sum({ calls: 9, measured: 9, usd: 3 }) } } } }, '');
  assert.match(big, /<strong class="kpi-value">\$1\.50<\/strong><span class="kpi-delta tone-good">↓ -50 % vs prior 7 d<\/span>/);
  // Quality: one row per suite — headline score, gate, trend on the same dataset — opening its panel on evals.html.
  const r = (id, ts, score, passed, dataset = 'd1', failures = []) => ({ run_id: id, ts, model: 'm', dataset_sha256: dataset, scores: { verdict_match: score }, passed, failures, n_cases: 4, repeats: 1 });
  const suites = [['review', { runs: [r('r2', '2026-10-20T00:00:00Z', 0.87, true), r('r1', '2026-10-18T00:00:00Z', 0.8, true)] }], ['validation', { runs: [r('v2', '2026-10-21T00:00:00Z', 0.6, false, 'd2', ['verdict_match']), r('v1', '2026-10-19T00:00:00Z', 0.9, true, 'd1')] }]];
  const q = consoleOverview(ctx, 'pipeline/', { suites });
  assert.match(q, /class="quality-panel panel"[^>]*>.*<a href="evals\.html">1 \/ 2 gates →<\/a>/s);
  assert.match(q, /<a class="tone-good" href="evals\.html#suite-review"><span class="q-name">review<\/span><strong class="q-value">87 % ↑<\/strong>/);
  assert.match(q, /<a class="tone-bad" href="evals\.html#suite-validation"><span class="q-name">validation<\/span><strong class="q-value">60 %<\/strong>.*gate failed · 2026-10-21/, 'a changed dataset shows no trend');
});

test('merge card: its count is the number of rows its Pipelines filter shows (PR #286 review)', async () => {
  const { flowDashboard } = await import('../lib/flow_dashboard.mjs');
  const { periodItems } = await import('../lib/console_overview.mjs');
  const verdict = (runId, t, pr, v) => makeRecord({ runId, start: t, prNumber: pr, events: [{ event: 'review.verdict', meta: { verdict: v, prNumber: pr } }] });
  const merge = (runId, t, pr) => makeRecord({ runId, start: t, prNumber: pr, events: [{ event: 'item.closed', meta: { merged: true } }] });
  // Two merged PRs, one inside the period and one 20 days old; other states are not merges.
  const model = modelOf([verdict('880', T, 60, 'REQUEST_CHANGES'), verdict('881', T + 1000, 61, 'APPROVE'), merge('882', T + 2000, 61), verdict('883', T - 20 * 86400000, 63, 'APPROVE'), merge('884', T - 20 * 86400000 + 1000, 63), verdict('885', T + 3000, 62, 'WITHHELD')]);
  const ctx = consoleContext(model);
  const html = consoleOverview(ctx, '');
  const page = flowDashboard(model);
  const ref = Number(/data-ref="(\d+)"/.exec(page)[1]);
  const rows = [...page.matchAll(/data-state="([^"]*)"[^>]*data-last="(\d*)"/g)].map((m) => ({ tokens: m[1].split(' '), last: Number(m[2]) || 0 }));
  const listed = rows.filter((r) => r.tokens.includes('merged') && ref - r.last <= 7 * 86400000).length;
  assert.equal(listed, 1, 'fixture: one merge in the period');
  assert.match(html, new RegExp(`href="flows\\.html\\?state=merged&amp;period=7">.*?<strong>${listed}</strong><span>merged</span>`, 's'));
  assert.equal(periodItems(ctx, 7).length, 3, 'the 20-day-old item is outside the period');
  assert.equal(periodItems({}, 7).length, 0);
  // A merge journaled after the latest execution (PR #320 review): counted and drawn, on the count's reference.
  const late = consoleContext(modelOf([verdict('890', T, 70, 'APPROVE'), makeClosingRecord({ runId: '891', start: T + 4 * 86400000, prNumber: 70, meta: { merged: true } })]));
  const lateHtml = consoleOverview(late, '');
  assert.match(lateHtml, /<strong>1<\/strong><span>merged<\/span>/);
  assert.match(lateHtml, /aria-label="Merges per day: 0, 0, 0, 0, 0, 0, 1"/);
});

test('home cockpit: eval gates, a change only on a populated base, 2-decimal cost, daily bars', async () => {
  const { qualityPanel, dayBars, stageStrip } = await import('../lib/console_overview.mjs');
  const r = (id, ts, score, passed, dataset = 'd1') => ({ run_id: id, ts, model: 'm', dataset_sha256: dataset, scores: { verdict_match: score }, passed, failures: passed ? [] : ['verdict_match'], n_cases: 4, repeats: 1 });
  const q = qualityPanel([['review', { runs: [r('r2', '2026-10-20T00:00:00Z', 0.87, true), r('r1', '2026-10-18T00:00:00Z', 0.8, true)] }], ['validation', { runs: [r('v1', '2026-10-21T00:00:00Z', 0.6, false)] }]], '');
  assert.match(q, /<a href="evals\.html">1 \/ 2 gates →<\/a>/);
  assert.match(q, /<a class="tone-good" href="evals\.html#suite-review">.*<strong class="q-value">87 % ↑<\/strong><span class="q-bar"><span style="width:87\.0%"><\/span><\/span><small>verdict_match · gate passed · 2026-10-20/);
  assert.match(q, /<a class="tone-bad" href="evals\.html#suite-validation">.*gate failed/);
  assert.match(qualityPanel([['x', { runs: [{ run_id: 'x', passed: true, scores: {} }] }]], ''), /<strong class="q-value">—<\/strong>.*width:0\.0%.*no score/, 'no headline score: no value invented');
  // Bars: scaled to the maximum, a zero day drawn as a baseline, values readable.
  const bars = dayBars([0, 2, 4], 'Merges');
  assert.match(bars, /aria-label="Merges per day: 0, 2, 4"/);
  assert.equal(bars.match(/class="zero"/g).length, 1);
  assert.match(bars, /height="32\.0"/);
  assert.equal(dayBars([0, 0], 'x').match(/class="zero"/g).length, 2, 'an all-zero series is flat');
  // A previous window under MIN_BASE runs shows no change on the home; the cost has 2 decimals there.
  const sum = (o) => ({ calls: 0, measured: 0, estimated: 0, free: 0, unpriced: 0, usd: 0, ...o });
  const slice = (runs, usd) => ({ runs, failed: 0, adverse: 0, progressed: runs, neutral: 0, verdicts: runs, approve: runs, withheld: 0, request_changes: 0, approve_rate: 1, duration: { n: runs, mean: 1000, p95: 1000 }, cost: sum({ calls: runs, measured: runs, usd }) });
  const act = Object.fromEntries(['issue_validation', 'code_gen', 'pr_prepare', 'review', 'autofix'].map((k) => [k, { decisions: 0, good: 0, by_key: {}, prs: 0, per_day: Array(7).fill(0), good_per_day: Array(7).fill(0) }]));
  const w = (prevRuns) => ({ days: 7, empty: false, from: T, to: T + 7 * 86400000, current: slice(12, 1.23456), previous: slice(prevRuns, 2), series: Array(7).fill({ verdicts: 0, approve_rate: null, avg_ms: null, usd: null }), providers: [], stages: [], activity: act, items: [] });
  const ctx = consoleContext(buildPipelineModel({}));
  const home = (win) => consoleOverview({ ...ctx, windows: { ...ctx.windows, 7: win } }, '');
  assert.doesNotMatch(home(w(9)).slice(home(w(9)).indexOf('class="cockpit"')), /vs prior 7 d/, '9 runs: no change shown');
  const big = home(w(10));
  assert.match(big, /data-kpi="executions">.*\+20 % vs prior 7 d/s);
  assert.match(big, /data-kpi="llm_cost">.*<strong class="kpi-value">\$1\.23<\/strong>.*-38 % vs prior 7 d/s);
  // Stages with no decision say so, and render no healthy tone.
  const strip = stageStrip(w(10), ctx, '', false);
  assert.match(strip, /No validation in the window/);
  assert.match(strip, /No auto-fix in the window/);
  assert.match(strip, /href="health\.html#reviews"/, 'no withheld finding: the review card opens the reviews section');
  assert.doesNotMatch(strip, /tone-/);
  // Merge: the merged items of the Pipelines period filter, per day of their journaled closing (unknown date: no bar).
  const at = T + 6.5 * 86400000;
  const merges = stageStrip(w(10), { traces: [{ runs: [{ completed_at: at }] }], journeys: [{ state: 'merged', last_activity: at, closing: { ts: at } }, { state: 'merged', last_activity: at, closing: { ts: null } }, { state: 'approved', last_activity: at }] }, '', false);
  assert.match(merges, /<strong>2<\/strong><span>merged<\/span>/);
  assert.match(merges, /aria-label="Merges per day: 0, 0, 0, 0, 0, 0, 1"/);
});
