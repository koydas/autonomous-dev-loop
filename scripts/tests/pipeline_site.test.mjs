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
  assert.deepEqual(Object.keys(files).sort(), ['pipeline/flows.html', 'pipeline/health.html', 'pipeline/index.html', 'pipeline/models.html', 'pipeline/traces/index.html']);
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
  assert.match(files['pipeline/runs/500-1.html'], /<a href="\.\.\/\.\.\/index\.html">Eval dashboard<\/a> · <a href="\.\.\/\.\.\/pipeline\/index\.html">Pipeline<\/a>/);
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
  assert.match(html, /Flow map<\/a>/);
  assert.match(html, /data-flow-dashboard/);
  assert.match(html, /runs\/921-1.html/);
  assert.match(html, /data-merge-node/);
  assert.match(html, /api.github.com\/repos\/koydas\/autonomous-dev-loop\/pulls/);
});
