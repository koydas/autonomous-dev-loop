import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPipelineSite, formatDuration, waterfall, hbars, tokenChart, criticalPathChart, renderRunPage, renderTracePage, renderFeedIndex,
  renderHealth, renderModels, FEED_CAP, MONTH_FEED_CAP,
} from '../lib/pipeline_site.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { computeHealth, modelUsage } from '../lib/pipeline_health.mjs';
import { escapeHtml, modelAnchor } from '../lib/eval_site.mjs';
import { makeRecord, asFiles, indexesOf, HOSTILE, RAW_MARKERS, V1_REVIEW, V2_REVIEW, TRACE_PR_220 } from './fixtures/pipeline/records.mjs';

const T0 = Date.parse('2026-10-14T10:00:00Z');

function site(records, { traces, runsJsonl = '', scorecard = null, extraRecords = [] } = {}) {
  const model = buildPipelineModel({ records: [...asFiles(records), ...extraRecords], traces: traces ?? indexesOf(records), runsJsonl });
  return { model, files: buildPipelineSite({ model, health: computeHealth({ model, scorecard }), models: modelUsage(model.runs, scorecard), generatedAt: '2026-10-17T00:00:00Z' }) };
}

const assertNoRaw = (files) => {
  for (const [p, html] of Object.entries(files)) {
    for (const raw of RAW_MARKERS) assert.ok(!html.includes(raw), `${p} contains raw ${raw}`);
  }
};

test('formatDuration covers ms, s, min, h and d; junk → —', () => {
  assert.deepEqual([850, 4200, 185000, 8040000, 270000000].map(formatDuration), ['850 ms', '4.2 s', '3 min 05 s', '2 h 14 min', '3 d 3 h']);
  for (const bad of [null, -1, NaN, 'x']) assert.equal(formatDuration(bad), '—');
});

test('a hostile string in every rendered field is escaped on every page', () => {
  const hostileEvents = [
    { event: 'review.verdict', meta: { verdict: HOSTILE, reason: HOSTILE, prNumber: 7, url: HOSTILE } },
    { event: 'review.comment_posted', meta: { prNumber: 7, action: HOSTILE, url: 'https://github.com/o/r/pull/7#c' } },
    { event: HOSTILE, stage: HOSTILE, level: 'error', meta: { error: HOSTILE } },
    { event: 'autofix.skipped', meta: { reason: 'guardrail_rejected', rules: [HOSTILE] } },
  ];
  const records = [makeRecord({ runId: '300', start: T0, hostile: true, events: hostileEvents }), makeRecord({ runId: '301', start: T0 + 60000, hostile: true, events: hostileEvents })];
  const traces = indexesOf(records).map(({ path, text }) => {
    const idx = JSON.parse(text);
    for (const r of idx.runs) Object.assign(r, { workflow: HOSTILE, event_name: HOSTILE, outcome: HOSTILE });
    idx.item.key = HOSTILE;
    return { path, text: JSON.stringify(idx) };
  });
  const scorecard = { version: 1, suites: { [HOSTILE]: { runs: [{ run_id: HOSTILE, model: HOSTILE, ts: '2026-10-14T07:00:00Z', tokens_est: { in: 10, out: 1 }, passed: true }] } } };
  const { files, model } = site(records, { traces, scorecard, runsJsonl: JSON.stringify({ type: 'autofix_skip', run_id: '9-1-autofix-skip', reason: 'guardrail_rejected', rules: [HOSTILE] }) });
  assert.equal(model.runs.length, 2);
  assert.equal(model.traces.length, 1);
  assertNoRaw(files);
  // The escaped text is shown, i.e. the field is rendered, not dropped.
  const escaped = escapeHtml(HOSTILE.slice(0, 30));
  for (const p of ['pipeline/index.html', 'pipeline/runs/300-1.html', `pipeline/traces/${model.traces[0].trace_id}.html`, 'pipeline/models.html', 'pipeline/health.html']) {
    assert.ok(files[p].includes(escaped), `${p} renders the hostile text escaped`);
  }
  // A hostile meta url is never a link; an https one is.
  for (const html of Object.values(files)) assert.doesNotMatch(html, /href="(&lt;|<|javascript:|[^"]*&quot;)/);
  // The model anchor is a slug: letters, digits and dashes only.
  assert.match(files['pipeline/runs/300-1.html'], /href="\.\.\/models\.html#model-[a-z0-9-]+"/);
  assert.match(files['pipeline/index.html'], /<a href="https:\/\/github\.com\/o\/r\/pull\/7#c">link<\/a>/);
});

test('empty states: no record, no trace, no LLM call', () => {
  const { files } = site([]);
  assert.deepEqual(Object.keys(files).sort(), ['pipeline/console.css', 'pipeline/diagnostics.html', 'pipeline/flows.html', 'pipeline/health.html', 'pipeline/index.html', 'pipeline/levers.html', 'pipeline/models.html', 'pipeline/traces/index.html']);
  // No data is said, never shown as healthy.
  assert.match(files['pipeline/diagnostics.html'], /No pipeline run recorded yet/);
  assert.doesNotMatch(files['pipeline/diagnostics.html'], /No problem detected/);
  assert.match(files['pipeline/diagnostics.html'], /Merge is journaled only from item-closed\.yml on/);
  assert.match(files['pipeline/index.html'], /No run record on the <code>metrics<\/code> branch yet/);
  assert.match(files['pipeline/index.html'], /No pipeline action recorded in this period/);
  assert.match(files['pipeline/traces/index.html'], /No trace index on the metrics branch yet/);
  assert.match(files['pipeline/health.html'], /No Groq LLM call recorded in the window/);
  assert.match(files['pipeline/health.html'], /No work-item trace with a lead time yet/);
  assert.match(files['pipeline/health.html'], /No stage span recorded/);
  assert.match(files['pipeline/models.html'], /No LLM call or eval run recorded yet/);
});

test('v1-only data renders flat run pages and the feed without breaking', () => {
  const extraRecords = [{ path: 'metrics/runs/2026-10/38848221354-1.json', text: V1_REVIEW() }];
  const { files } = site([], { extraRecords, traces: [] });
  const html = files['pipeline/runs/38848221354-1.html'];
  assert.match(html, /Schema 1 record \(ADR-0040\): no span tree/);
  assert.match(html, /review\.skipped/);
  assert.match(html, /already_reviewed/);
  assert.match(html, /no trace index for this work item/);
  assert.match(files['pipeline/index.html'], /review\.skipped/);
  assert.match(files['pipeline/feed/2026-10.html'], /review\.skipped/);
});

test('a malformed record is skipped with a warning shown on the activity page', () => {
  const extraRecords = [{ path: 'metrics/runs/2026-10/1-1.json', text: '{broken' }];
  const { files, model } = site([makeRecord({ runId: '310', start: T0 })], { extraRecords });
  assert.equal(model.runs.length, 1);
  assert.match(files['pipeline/index.html'], /1 input warning\(s\)/);
  assert.match(files['pipeline/index.html'], /metrics\/runs\/2026-10\/1-1\.json skipped: not a readable run record/);
});

test('an index naming a missing record keeps the run as a row and says so', () => {
  const extraRecords = [{ path: 'metrics/runs/2026-10/38992537605-1.json', text: V2_REVIEW() }];
  const { files } = site([], { extraRecords, traces: [{ path: 'metrics/traces/48c0763e8e6261b16939887b4abf414c.json', text: TRACE_PR_220() }] });
  const html = files['pipeline/traces/48c0763e8e6261b16939887b4abf414c.html'];
  assert.match(html, /PR Review · 38990364970-1 \(record not loaded\)/);
  assert.match(html, /2 run\(s\) listed by the index have no loaded record/);
  assert.match(html, /<a href="\.\.\/runs\/38992537605-1\.html">PR Review · 38992537605-1<\/a>/);
  assert.match(html, /Lead time \(first start → last end\)<\/div><div class="value">30 min 53 s/);
  assert.match(html, /llm_call/);
  assert.match(html, /groq:openai\/gpt-oss-120b/);
  assert.match(html, /6\.3k → 126 <span class="muted">est\.<\/span>/);
  assert.match(files['pipeline/runs/38992537605-1.html'], /work-item trace \(PR #220\)/);
});

test('runs_overflow, spans_overflow, events_overflow and dropped index entries are shown', () => {
  const rec = makeRecord({ runId: '320', start: T0 });
  rec.spans_overflow = { count: 3, events: 4 };
  rec.events_overflow = { count: 5, bytes: 100 };
  const [idx] = indexesOf([rec]);
  const index = JSON.parse(idx.text);
  index.runs_overflow = 7;
  index.runs.push({ run_id: 'bad id' });
  const { files, model } = site([rec], { traces: [{ path: idx.path, text: JSON.stringify(index) }] });
  const trace = files[`pipeline/traces/${model.traces[0].trace_id}.html`];
  assert.match(trace, /7 more run\(s\) of this item are not listed \(runs_overflow/);
  assert.match(trace, /1 index entr\(y\/ies\) with a malformed run id ignored/);
  assert.match(trace, /Run 320-1: 3 span\(s\), 4 span event\(s\) over the cap \(spans_overflow\)/);
  const run = files['pipeline/runs/320-1.html'];
  assert.match(run, /5 event\(s\) over the journal or record cap/);
  assert.match(run, /3 span\(s\) and 4 span event\(s\) over the cap/);
});

test('the feed caps the index page and the month pages; filters list the distinct values', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ event: `review.e${i}`, level: i % 2 ? 'warn' : 'info' }));
  const records = Array.from({ length: Math.ceil((MONTH_FEED_CAP + 10) / 40) }, (_, i) => makeRecord({ runId: String(400 + i), start: T0 + i * 1000, events }));
  const { files } = site(records);
  const rows = (html) => (html.match(/<tr data-stage=/g) ?? []).length;
  assert.equal(rows(files['pipeline/index.html']), FEED_CAP);
  assert.match(files['pipeline/index.html'], new RegExp(`The newest ${FEED_CAP} of \\d+ actions`));
  assert.equal(rows(files['pipeline/feed/2026-10.html']), MONTH_FEED_CAP);
  assert.match(files['pipeline/feed/2026-10.html'], /The newest 2000 of \d+ actions this month/);
  assert.match(files['pipeline/index.html'], /<select data-filter="level"><option value="">all<\/option><option value="info">info<\/option><option value="warn">warn<\/option><\/select>/);
  assert.match(files['pipeline/index.html'], /data-filter="issue"/);
  assert.match(files['pipeline/index.html'], /data-filter="pr"/);
  assert.match(files['pipeline/index.html'], /data-filter="outcome"/);
  assert.match(files['pipeline/index.html'], /data-filter="stage"/);
  assert.doesNotMatch(files['pipeline/index.html'], /<script src=/, 'no external script');
});

test('waterfall positions bars on the shared axis; untimed spans and no spans', () => {
  const html = waterfall([
    { label: 'a', depth: 0, kind: 'run', start: 0, end: 1000, status: 'ok', links: [] },
    { label: 'b', depth: 3, kind: 'llm', start: 250, end: 750, status: 'error', provider: 'groq', model: 'm', tokens: { in: 1500, out: 20, estimated: false }, links: ['https://github.com/x'] },
    { label: 'c', depth: 1, kind: 'mystery', start: null, end: null, status: 'unset', outcome: 'partial', links: [] },
  ], { t0: 0, t1: 1000 });
  assert.match(html, /left:0\.000%;width:100\.000%/);
  assert.match(html, /left:25\.000%;width:50\.000%/);
  assert.match(html, /padding-left:56px/);
  assert.match(html, /no timing/);
  assert.match(html, /✕ error/);
  assert.match(html, /status-warning">partial/);
  assert.match(html, /1\.5k → 20<\/td>/);
  assert.match(html, new RegExp(`models\\.html#${modelAnchor('m')}`));
  assert.match(html, /<a href="https:\/\/github\.com\/x">link<\/a>/);
  // One instant span on a zero-length axis: a marker, no division by zero.
  assert.match(waterfall([{ label: 'x', depth: 0, kind: 'run', start: 5, end: 5 }]), /left:0;width:0/);
  assert.match(waterfall([]), /No span recorded/);
});

test('charts: one-series bars with a not-recorded row, token columns with the TPD line, critical-path shares', () => {
  const bars = hbars([{ label: 'A', value: 4 }, { label: 'B', value: 0 }, { label: 'Merged', value: null, note: 'not recorded' }], { label: 'T' });
  assert.match(bars, /<title>A: 4<\/title>/);
  assert.match(bars, /not recorded/);
  assert.match(bars, /aria-label="T; values in the table"/);
  assert.match(hbars([]), /No data/);
  const days = Array.from({ length: 8 }, (_, i) => ({ day: `2026-10-0${i + 1}`, total: i === 7 ? 30000 : 0, series: { 'PR Review': i === 7 ? 20000 : 0, 'Auto-Fix PR': i === 7 ? 10000 : 0, Evals: 0, Other: 0 }, workflows: i === 7 ? { 'PR Review': 20000, 'Auto-Fix PR': 10000 } : {}, crons: i === 4 ? ['review'] : [] }));
  const chart = tokenChart({ days, workflows: ['Auto-Fix PR', 'PR Review'], limit: 200000 });
  assert.match(chart, /200\.0k TPD \(Groq free tier\)/);
  assert.match(chart, /▲ R/);
  assert.match(chart, /<title>2026-10-08: 30000 tokens \(est\.\), PR Review 20000, Auto-Fix PR 10000<\/title>/);
  assert.equal((chart.match(/<path d="M/g) ?? []).length, 2, 'one segment per non-zero series');
  const cp = criticalPathChart([{ item: { kind: 'issue', number: 3 }, lead_time_ms: 100000, running_ms: 25000, waiting_ms: 75000 }, { item: null, lead_time_ms: 0, running_ms: 0, waiting_ms: 0 }]);
  assert.match(cp, /issue #3: lead 1 min 40 s, running 25\.0 s, waiting 1 min 15 s/);
  assert.match(cp, /no work item/);
});

test('health, models and run pages link to each other; the eval run pages are cross-linked by model', () => {
  const records = [makeRecord({ runId: '500', start: T0, events: [{ event: 'review.verdict', meta: { verdict: 'WITHHELD', withheld_from: 'REQUEST_CHANGES', prNumber: 7 } }] })];
  const scorecard = { suites: { review: { runs: [{ run_id: '38000-review', model: 'openai/gpt-oss-120b', passed: false, ts: '2026-10-14T07:00:00Z', tokens_est: { in: 1, out: 1 } }] } } };
  const { files, model } = site(records, { scorecard });
  const health = files['pipeline/health.html'];
  assert.match(health, /REQUEST_CHANGES → WITHHELD \(#220\)<\/div><div class="value">1</);
  assert.match(health, /Merged.*not recorded/s);
  assert.match(health, /Circuit-breaker trips<\/div><div class="value">not recorded/);
  assert.match(health, new RegExp(`<a href="traces/${model.traces[0].trace_id}\\.html">PR #7</a>`));
  const models = files['pipeline/models.html'];
  assert.match(models, new RegExp(`<section id="${modelAnchor('openai/gpt-oss-120b')}">`));
  assert.match(models, /<a href="runs\/500-1\.html">500-1<\/a>/);
  assert.match(models, /<a href="\.\.\/runs\/38000-review\.html">review 38000-review<\/a> <span class="ko">✕<\/span>/);
  assert.match(files['pipeline/runs/500-1.html'], /href="\.\.\/models\.html#model-openai-gpt-oss-120b"/);
  assert.match(files['pipeline/runs/500-1.html'], /<a href="\.\.\/\.\.\/evals\.html">/);
  // Metrics heads with the windowed trends (the former home body); Pipelines with the full waiting list.
  assert.match(health, /<section class="console" id="trends"[\s\S]*data-kpi="executions"[\s\S]*id="def-executions"/);
  assert.match(files['pipeline/flows.html'], /<section class="panel waiting-panel" id="waiting">/);
  // Direct renderer calls with the minimal model shape.
  assert.match(renderFeedIndex({ ...model, skippedMonths: ['2025-01'] }), /older months stay on the <code>metrics<\/code> branch: 2025-01/);
  assert.match(renderRunPage(model.runs[0], { ...model, tracesById: new Map() }), /no trace index for this work item/);
  assert.match(renderTracePage(model.traces[0], model), /Waterfall/);
  assert.match(renderHealth(computeHealth({ model }), model), /Pipeline health/);
  // Two models sharing an anchor: the first keeps the id.
  assert.equal((renderModels([{ key: 'a:m', model: 'm', calls: 0, failed: 0, fallback: 0, tokens: 0, runs: [], evals: [] }, { key: 'b:m', model: 'm', calls: 0, failed: 0, fallback: 0, tokens: 0, runs: [], evals: [] }], model).match(/id="model-m"/g) ?? []).length, 1);
});

test('flow map is generated with shared navigation, retained evidence and live merge enhancement', () => {
  const { files } = site([makeRecord({ runId: '921' })]);
  const html = files['pipeline/flows.html'];
  assert.match(html, /<a href="\.\.\/pipeline\/flows\.html"><svg class="nav-icon"[^>]*>.*?<\/svg>Pipelines<\/a>/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/pipeline\/console\.css">/);
  assert.match(html, /data-facet="state"/, 'the sidebar carries the pipeline facets');
  assert.match(html, /<h1>Pipelines<\/h1>/);
  assert.match(html, /data-flow-dashboard/);
  assert.match(html, /runs\/921-1.html/);
  assert.match(html, /data-merge-node/);
  assert.match(html, /api.github.com\/repos\/koydas\/autonomous-dev-loop\/pulls/);
});

// LLM cost on the run, trace, feed, health and models pages.
test('cost: run page per call, waterfall column, trace per stage and run, feed tile, health panel, models tile', () => {
  const issue = { kind: 'issue', number: 70, source: 'branch' };
  const records = [
    makeRecord({ runId: '600', workflow: 'Code Generation', stage: 'code_gen', prNumber: null, issueNumber: 70, item: issue, start: T0, provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 100_000, tokensOut: 10_000, usage: { cacheRead: 90_000, cacheWrite: 1000 } }),
    makeRecord({ runId: '601', item: issue, start: T0 + 60000, tokensIn: 5000, tokensOut: 500 }),
    makeRecord({ runId: '602', item: issue, start: T0 + 120000, provider: 'anthropic', model: 'claude-unknown' }),
  ];
  const { files } = site(records);
  const run = files['pipeline/runs/600-1.html'];
  // 9k uncached × $4 + 90k read × $0.20 + 1k write × $5 + 10k out × $20 = $0.259
  assert.match(run, /LLM cost · tokens &amp; USD per call|LLM cost · tokens & USD per call/);
  assert.match(run, /\$0\.2590/);
  assert.match(run, /<td class="num">90\.0k<\/td><td class="num">1\.0k<\/td>/, 'cache reads and writes per call');
  assert.match(run, /provider-measured tokens/);
  assert.match(run, /<th class="num">Cost<\/th>/, 'waterfall cost column');
  assert.match(run, /90\.0k cached/);
  assert.match(files['pipeline/runs/601-1.html'], /free tier/);
  assert.match(files['pipeline/runs/602-1.html'], /unpriced/);
  const trace = Object.entries(files).find(([p, html]) => /^pipeline\/traces\/[0-9a-f]{32}\.html$/.test(p) && html.includes('issue #70'))[1];
  assert.match(trace, /LLM cost · per stage &amp; per run|LLM cost · per stage & per run/);
  assert.match(trace, /<code>code_gen<\/code>/);
  assert.match(trace, /<code>code_gen<\/code><\/td><td class="num">1<\/td>.*?<td>\$0\.2590 USD<\/td>/);
  assert.match(trace, /<code>review<\/code><\/td><td class="num">2<\/td>.*?\$0\.0000 USD \+ 1 unpriced call\(s\) \(1 Groq free-tier call\(s\) at no cost\)/);
  assert.match(trace, /LLM cost<\/div><div class="value">\$0\.2590/, 'trace tile');
  assert.match(files['pipeline/index.html'], /Operational LLM cost \(window\)<\/div><div class="value">\$0\.2590/);
  assert.match(files['pipeline/index.html'], /LLM \$0\.2590 · 1 call\(s\)/, 'execution card');
  const health = files['pipeline/health.html'];
  assert.match(health, /LLM cost · per stage, run &amp; work item|LLM cost · per stage, run & work item/);
  assert.match(health, /aria-label="LLM cost in USD per pipeline stage/);
  assert.match(health, /Most expensive runs/);
  assert.match(health, /href="runs\/600-1\.html"/);
  assert.match(health, /Mean per work item<\/div><div class="value">≥ \$0\.2590/, 'one call of the item is unpriced: a lower bound');
  assert.match(health, /provider-measured tokens \(prompt cache priced apart/);
  assert.match(files['pipeline/models.html'], /LLM cost<\/div><div class="value">\$0\.2590/);
  assert.match(files['pipeline/models.html'], /1 unpriced call\(s\)/);
  assert.match(files['pipeline/models.html'], /LLM cost<\/div><div class="value">free tier/);
});

test('cost: no LLM call → empty cost states', () => {
  const rec = makeRecord({ runId: '610', start: T0 });
  rec.otlp.resourceSpans[0].scopeSpans[0].spans = rec.otlp.resourceSpans[0].scopeSpans[0].spans.filter((s) => s.name !== 'llm_call');
  rec.envelope.llm_calls = [];
  rec.events = [];
  const { files } = site([rec]);
  assert.match(files['pipeline/runs/610-1.html'], /No LLM call in this run/);
  assert.match(files['pipeline/health.html'], /No LLM call recorded in the window/);
  assert.match(files['pipeline/index.html'], /Operational LLM cost \(window\)<\/div><div class="value">—/);
});

test('cost: a window of unpriced calls only reads unpriced on the activity tile, execution cards, health and models', () => {
  const { files } = site([makeRecord({ runId: '620', start: T0, provider: 'anthropic', model: 'claude-unknown' })]);
  assert.match(files['pipeline/index.html'], /Operational LLM cost \(window\)<\/div><div class="value">unpriced/);
  assert.match(files['pipeline/index.html'], /<span>LLM unpriced · 1 call\(s\)<\/span>/);
  assert.match(files['pipeline/runs/620-1.html'], /LLM cost<\/div><div class="value">unpriced/);
  assert.match(files['pipeline/health.html'], /Mean per run<\/div><div class="value">—/);
  assert.match(files['pipeline/models.html'], /LLM cost<\/div><div class="value">unpriced/);
  assert.doesNotMatch(files['pipeline/index.html'], /\$0\.0000/);
});

test('cost: health separates the operational cost from the eval cost; evals never enter the pipeline total', () => {
  const run = (run_id, model, cost_est) => ({ run_id, model, ts: '2026-10-14T00:00:00Z', passed: true, cost_est, tokens_est: { in: 1000, out: 100 } });
  const scorecard = { suites: { review: { runs: [run('e1', 'claude-opus-5-5', { usd: 1.5 }), run('e2', 'openai/gpt-oss-120b', null), run('e3', 'claude-unknown', { usd: null, unpriced: 'claude-unknown' })] } } };
  const records = [makeRecord({ runId: '640', start: T0, provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 1000 })];
  const health = site(records, { scorecard }).files['pipeline/health.html'];
  assert.match(health, /Operational LLM cost · per stage, run &amp; work item|Operational LLM cost · per stage, run & work item/);
  assert.match(health, /id="cost-evals"/);
  assert.match(health, /Eval cost<\/div><div class="value">\$1\.5000 \+ 1 unpriced/);
  assert.match(health, /<code>review<\/code><\/td><td class="num">3<\/td>.*?<td>\$1\.5000 \+ 1 unpriced<\/td>/);
  assert.match(health, /<td>e1<\/td><td>claude-opus-5-5<\/td><td>\$1\.5000<\/td>/);
  assert.doesNotMatch(health.split('id="cost-evals"')[0], /\$1\.5000/, 'eval cost absent from the operational panel');
  assert.match(site(records).files['pipeline/health.html'], /No eval run on the scorecard/);
});

test('models: a model seen only in the eval scorecard has no pipeline cost (—), never free or $0', () => {
  const scorecard = { suites: { review: { runs: [{ run_id: 'r1', model: 'claude-opus-5-5', ts: '2026-10-14T00:00:00Z', passed: true }, { run_id: 'r2', model: 'openai/gpt-oss-120b', ts: '2026-10-14T00:00:00Z', passed: true }] } } };
  const model = buildPipelineModel({ records: [], traces: [] });
  const html = renderModels(modelUsage(model.runs, scorecard), model);
  assert.equal((html.match(/LLM cost<\/div><div class="value">—/g) ?? []).length, 2);
  assert.doesNotMatch(html, /free tier|\$0\.0000/);
});

test('health: a stage or workflow with no priced call shows no $0 per-run mean', () => {
  const { files } = site([makeRecord({ runId: '630', start: T0 })]);
  const health = files['pipeline/health.html'];
  assert.match(health, /<code>review<\/code><\/td><td class="num">1<\/td>.*?<td class="num">free tier<\/td><\/tr>/);
  const unpriced = site([makeRecord({ runId: '631', start: T0, provider: 'anthropic', model: 'claude-unknown' })]).files['pipeline/health.html'];
  assert.match(unpriced, /<code>review<\/code><\/td><td class="num">1<\/td>.*?<td class="num">—<\/td><\/tr>/);
  assert.doesNotMatch(health.slice(health.indexOf('Per stage')), /<td class="num">\$0\.0000<\/td>/);
});

test('health: means over a window with unpriced calls are marked as lower bounds', () => {
  const { files } = site([
    makeRecord({ runId: '640', start: T0, provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 1000 }),
    makeRecord({ runId: '641', start: T0 + 1000, provider: 'anthropic', model: 'claude-unknown' }),
  ]);
  const health = files['pipeline/health.html'];
  assert.match(health, /Mean per run<\/div><div class="value">≥ \$0\.0120/);
  assert.match(health, /Mean per work item<\/div><div class="value">≥ \$0\.0240/, 'both runs belong to PR #7: one item');
  assert.match(health, /<td class="num">≥ \$0\.0120<\/td>/, 'per-run column of the stage / workflow rows');
});

test('token chart: tooltips say measured, est. (all estimated) or the estimated share per day', () => {
  const days = (measured, est) => ({ days: [{ day: '2026-10-14', total: measured + est, estimated: est, series: { 'PR Review': measured + est, 'Auto-Fix PR': 0, Evals: 0, Other: 0 }, workflows: {}, crons: [] }], workflows: [], limit: 200000 });
  assert.match(tokenChart(days(500, 0)), /2026-10-14: 500 tokens \(measured\)/);
  assert.match(tokenChart(days(0, 400)), /2026-10-14: 400 tokens \(est\.\)/);
  assert.match(tokenChart(days(500, 400)), /2026-10-14: 900 tokens \(400 est\.\)/);
  assert.match(tokenChart(days(1, 0)), /provider-measured where recorded, chars\/4 estimates otherwise/);
});

test('cost: a usage-less LLM span reads unpriced in the waterfall; unpriced runs listed apart; sub-dollar bars scale to the max', () => {
  const rec = makeRecord({ runId: '650', start: T0, provider: 'anthropic', model: 'claude-opus-5-5', llmStatus: 'error' });
  const llm = rec.otlp.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name === 'llm_call');
  llm.attributes = llm.attributes.filter((a) => !a.key.startsWith('gen_ai.usage.') && a.key !== 'adl.usage.estimated');
  const { files } = site([rec, makeRecord({ runId: '651', prNumber: 8, start: T0, provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 1000 })]);
  const wf = files['pipeline/runs/650-1.html'];
  assert.match(wf.slice(wf.indexOf('<table class="wf">')), /<td class="num"><span class="muted">unpriced<\/span><\/td>/);
  const health = files['pipeline/health.html'];
  assert.match(health, /Runs with unpriced calls · cost incomplete, not ranked/);
  assert.match(health, /Work items with unpriced calls · cost incomplete, not ranked/);
  const bars = hbars([{ label: 'a', value: 0.01 }, { label: 'b', value: 0.02 }], { format: (v) => String(v), minScale: 1e-6 });
  const widths = [...bars.matchAll(/<path d="M260,\d+H([\d.]+)/g)].map((m) => Number(m[1]) - 260);
  // Path end = width − 4 (rounded corner): the largest value fills the 316 px plot, half of it half.
  assert.ok(widths[1] + 4 === 316 && Math.abs((widths[0] + 4) * 2 - (widths[1] + 4)) < 2, `bars scale to the largest value: ${widths}`);
});

test('trace page: header with state and GitHub link, six tabs (overview, timeline, LLM calls, events, Actions runs, traces)', () => {
  const { files, model } = site([makeRecord({ runId: '930', events: [{ event: 'review.verdict', meta: { verdict: 'WITHHELD', prNumber: 7, unreviewed_code_files: 2 } }] })]);
  const html = files[`pipeline/traces/${model.traces[0].trace_id}.html`];
  assert.match(html, /<h1>Work-item trace · PR #7 <span class="pill tone-warn">/);
  assert.match(html, /<a class="button-link" href="https:\/\/github\.com\/koydas\/autonomous-dev-loop\/pull\/7">View on GitHub →<\/a>/);
  const tabs = [...html.matchAll(/<section data-tab="([^"]+)" id="(tab-[a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['Overview', 'Timeline', 'LLM calls', 'Events', 'GitHub Actions', 'Traces']);
  assert.match(html, /<dl class="key-info">/);
  assert.match(html, /href="\.\.\/runs\/930-1\.html#ev-\d"><code>review\.verdict<\/code>/, 'key events link to the run journal');
  assert.match(html, /<a href="https:\/\/github\.com\/koydas\/autonomous-dev-loop\/actions\/runs\/930\/attempts\/1">workflow run<\/a>/);
  assert.match(html, /<h2>Waterfall<\/h2>/);
  assert.match(html, /role', 'tablist'/);
});

test('the Diagnostics page of the pipeline site links to findings.json with the build time', () => {
  const { files } = site([makeRecord({ runId: '1', start: T0 })]);
  assert.match(files['pipeline/diagnostics.html'], /<a href="\.\.\/findings\.json">findings\.json<\/a>[^]*generated <time datetime="2026-10-17T00:00:00Z">/);
});

test('the Rules and levers page is part of every pipeline site and linked from the pipeline navigation', () => {
  const { files } = site([makeRecord({ runId: '1', start: T0 })]);
  assert.match(files['pipeline/levers.html'], /<h1>Rules and levers<\/h1>/);
  assert.match(files['pipeline/levers.html'], /<tr id="rule-review-withheld">/);
  for (const p of ['pipeline/diagnostics.html', 'pipeline/flows.html', 'pipeline/health.html', 'pipeline/levers.html']) {
    assert.match(files[p], /<a href="levers\.html">Rules &amp; levers<\/a>|<a href="levers\.html">Rules & levers<\/a>/, p);
  }
});
