import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { dashboardHeader, evalOverview, suiteWidget, pipelineOverview, executionBrowser, workItemBrowser, flowSteps, DASHBOARD_STYLE, DASHBOARD_SCRIPT } from '../lib/dashboard_ui.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf, HOSTILE, RAW_MARKERS } from './fixtures/pipeline/records.mjs';

const modelOf = (...records) => buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });

test('summary counts all job outcomes independently and links directly to result filters', () => {
  const model = modelOf(...['success', 'failed', 'partial', 'skipped', 'unexpected'].map((outcome, i) => makeRecord({ runId: String(100 + i), outcome })));
  const before = JSON.stringify(model);
  const html = pipelineOverview(model, 'pipeline/');
  assert.match(html, /Successful executions<\/span><strong>1/);
  assert.match(html, /Failed executions<\/span><strong>1/);
  assert.match(html, /Other results<\/span><strong>3/);
  assert.match(html, /pipeline\/index\.html\?result=failed#executions/);
  assert.match(html, /pipeline\/index\.html\?result=success#executions/);
  assert.match(html, /does not imply an approved or merged PR/);
  assert.equal(JSON.stringify(model), before);
  assert.match(pipelineOverview({}), /Work-item flows<\/span><strong>0/);
});

test('evaluation overview uses only latest gates and keeps the history count', () => {
  const suites = [['review', { runs: [{ passed: false, n_cases: 23 }, { passed: true, n_cases: 20 }] }], ['validation', { runs: [{ passed: true, n_cases: 35 }] }]];
  const html = evalOverview(suites);
  assert.match(html, /Suites passing<\/span><strong>1/);
  assert.match(html, /Needs attention<\/span><strong>1/);
  assert.match(html, /Recorded evaluations<\/span><strong>3/);
  assert.match(html, /Cases in latest runs<\/span><strong>58/);
  assert.equal(evalOverview([]), '');
  assert.match(evalOverview([['empty', { runs: [{}] }]]), /Cases in latest runs<\/span><strong>0/);
});

test('suite cards keep gate failures separate from scores, and tolerate missing metrics or dates', () => {
  const html = suiteWidget('review', { run_id: 'run/1', passed: false, scores: { verdict_match: 0.89 }, failures: ['recall'], ts: '2026-10-18T12:00:00Z', n_cases: 23, repeats: 3 });
  assert.match(html, /89\.0%/);
  assert.match(html, /value="0.89"/);
  assert.match(html, /result-badge bad/);
  assert.match(html, /recall/);
  assert.match(html, /runs\/run%2F1\.html/);
  assert.match(html, /2026-10-18 12:00 UTC/);
  assert.match(suiteWidget('empty', { passed: true }), /All required quality thresholds met/);
  assert.match(suiteWidget('empty', { scores: { accuracy: null }, ts: 'bad-date' }), /Not recorded/);
  assert.doesNotMatch(suiteWidget('empty', { scores: { accuracy: null } }), /<meter/);
});

test('execution browser preserves every run, including ones without events, item, outcome or trace', () => {
  const model = modelOf(makeRecord({ runId: '400', outcome: 'failed' }), makeRecord({ runId: '401', outcome: 'skipped' }));
  model.runs[0] = { ...model.runs[0], item: null, workflow: null, event_name: null, outcome: null, started_at: null };
  const html = executionBrowser(model, '../');
  assert.equal((html.match(/data-entry /g) ?? []).length, 2);
  assert.match(html, /data-result="failed"/);
  assert.match(html, /data-result="unknown"/);
  assert.match(html, /Unlinked work/);
  assert.match(html, /0 actions/);
  assert.match(html, /\.\.\/runs\/400-1\.html/);
  assert.match(html, /Full flow/);
  assert.doesNotMatch(executionBrowser({ ...model, tracesById: new Map() }), /Full flow/);
  assert.match(executionBrowser({ runs: [] }), /No executions recorded yet/);
});

test('flow browser finds the newest run by time and distinguishes history from live issue status', () => {
  const model = modelOf(makeRecord({ runId: '500', issueNumber: 42, start: 100000, outcome: 'failed' }), makeRecord({ runId: '501', issueNumber: 42, start: 200000, outcome: 'success' }));
  model.traces[0].runs.reverse();
  model.traces[0].runs_overflow = 3;
  const html = workItemBrowser(model);
  assert.match(html, /data-result="success"/);
  assert.match(html, /data-issue-number="42"/);
  assert.match(html, /\(\+3 outside index\)/);
  assert.match(html, /not its current open\/closed status/);
  assert.match(html, /Open issues on GitHub/);
  assert.match(html, /data-issue-status role="status" aria-live="polite"/);
  assert.match(workItemBrowser({ traces: [] }), /No recorded flow yet/);
  assert.match(workItemBrowser({ traces: [{ trace_id: 'a', item: null, runs: [] }] }), /Not recorded/);
});

test('flow steps preserve missing records and sort runs chronologically without changing the input', () => {
  const trace = { runs: [
    { run_id: '2-1', workflow: 'Review', started_at: 2000, outcome: 'partial', run: null },
    { run_id: '1-1', workflow: 'Generate', started_at: 1000, outcome: 'success', run: { events: [{}] } },
  ] };
  const before = JSON.stringify(trace);
  const html = flowSteps(trace);
  assert.ok(html.indexOf('Generate') < html.indexOf('Review'));
  assert.match(html, /\.\.\/runs\/1-1\.html/);
  assert.match(html, /record not loaded/);
  assert.doesNotMatch(html, /href="[^\"]*2-1/);
  assert.match(html, /1 actions/);
  assert.equal(JSON.stringify(trace), before);
  assert.match(flowSteps({ runs: [] }), /<ol/);
});

test('all widget text and attributes escape hostile record content', () => {
  const model = modelOf(makeRecord({ runId: '600', hostile: true, events: [{ event: HOSTILE, level: 'error' }] }));
  const html = executionBrowser(model) + workItemBrowser(model) + flowSteps(model.traces[0]) + suiteWidget(HOSTILE, { run_id: HOSTILE, scores: { [HOSTILE]: 0.5 }, failures: [HOSTILE] });
  for (const raw of RAW_MARKERS) assert.ok(!html.includes(raw));
  assert.match(html, /&lt;script&gt;/);
});

test('shared navigation respects depth and the progressive enhancements need no external assets', () => {
  const header = dashboardHeader('../../', true);
  for (const [href, label] of [['index.html', 'Overview'], ['pipeline/diagnostics.html', 'Diagnostics'], ['pipeline/flows.html', 'Pipelines'], ['pipeline/index.html', 'Investigation'], ['pipeline/health.html', 'Metrics']]) {
    assert.ok(header.includes(`<a href="../../${href}">${label}</a>`), label);
  }
  assert.doesNotMatch(dashboardHeader('', false), /pipeline\//);
  assert.match(DASHBOARD_STYLE, /@media\(max-width:600px\)/);
  assert.match(DASHBOARD_STYLE, /prefers-reduced-motion/);
  assert.match(DASHBOARD_SCRIPT, /cell\.dataset\.label = heads\[i\]/);
  assert.doesNotMatch(DASHBOARD_SCRIPT, /innerHTML|document\.write|<script src/);
  assert.doesNotThrow(() => new Script(DASHBOARD_SCRIPT.replace(/^<script>\n|\n<\/script>$/g, '')));
});

test('partial review exposes verdict, coverage and evidence without inventing the original verdict', () => {
  const model = modelOf(makeRecord({ outcome: 'partial', events: [
    { event: 'review.prompt_truncated', meta: { diff_truncated: true, unreviewed_code_files: 3 } },
    { event: 'review.verdict', meta: { verdict: 'WITHHELD', evidence_state: 'available', unreviewed_code_files: 3 } },
  ] }));
  const html = executionBrowser(model);
  assert.match(html, /Recorded outcome: partial/);
  assert.match(html, /Review verdict: WITHHELD/);
  assert.match(html, /CI evidence: available/);
  assert.match(html, /Code files not fully reviewed: 3/);
  assert.match(html, /Review diff truncated/);
  assert.doesNotMatch(html, /Withheld from:/);
  assert.match(pipelineOverview(model), /partial does not imply a failed job/);
});

test('decision cards distinguish approvals, changes, skips and human escalations', () => {
  for (const verdict of ['APPROVE', 'REQUEST_CHANGES']) {
    assert.match(executionBrowser(modelOf(makeRecord({ events: [{ event: 'review.verdict', meta: { verdict, unreviewed_code_files: 0 } }] }))), new RegExp(`Review verdict: ${verdict}`));
  }
  const html = executionBrowser(modelOf(makeRecord({ outcome: 'partial', events: [
    { event: 'review.skipped', meta: { reason: 'already_reviewed' } },
    { event: 'autofix.skipped', meta: { reason: 'no_changes' } },
    { event: 'autofix.escalated', meta: { reason: 'no_changes' } },
  ] })));
  assert.match(html, /Review skipped: already_reviewed/);
  assert.match(html, /Auto-fix skipped: no_changes/);
  assert.match(html, /Human escalation: no_changes/);
  assert.match(executionBrowser(modelOf(makeRecord())), /Decision and cause: Not recorded/);
});

test('decision facts escape metadata and prefer the latest verdict over earlier events', () => {
  const html = executionBrowser(modelOf(makeRecord({ events: [
    { event: 'review.verdict', meta: { verdict: 'APPROVE' } },
    { event: 'review.verdict', meta: { verdict: HOSTILE, withheld_from: HOSTILE, evidence_state: HOSTILE } },
    { event: 'autofix.escalated', meta: { reason: HOSTILE } },
  ] })));
  assert.doesNotMatch(html, /Review verdict: APPROVE/);
  assert.match(html, /&lt;script&gt;/);
  for (const raw of RAW_MARKERS) assert.ok(!html.includes(raw));
});

test('execution cards and flow history show the LLM cost of a run with calls only', () => {
 const priced = makeRecord({ runId: '700', provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 1000 });
 const model = modelOf(priced);
 assert.match(executionBrowser(model), /<span>LLM \$0\.0240 · 1 call\(s\)<\/span>/);
 assert.match(flowSteps(model.traces[0]), / · LLM \$0\.0240<\/p>/);
 const none = modelOf(makeRecord({ runId: '701' }));
 none.runs[0].llm = [];
 assert.doesNotMatch(executionBrowser(none), /LLM \$/);
});
