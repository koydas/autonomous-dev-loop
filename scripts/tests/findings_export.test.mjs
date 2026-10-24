import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFindingsExport, findingsExportJson, FINDINGS_SCHEMA_VERSION } from '../lib/findings_export.mjs';
import { diagnose } from '../lib/pipeline_diagnostics.mjs';
import { leverFor } from '../lib/meta_levers.mjs';
import { consoleContext, diagnosticsBody, requirementLabel } from '../lib/console_views.mjs';
import { journeys } from '../lib/pipeline_journey.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { escapeHtml } from '../lib/eval_site.mjs';
import { emptyScorecard } from '../lib/eval_scorecard.mjs';
import { assembleSite } from '../build_eval_site.mjs';
import { recordPath } from '../lib/run_record.mjs';
import { makeRecord, asFiles, indexesOf, HOSTILE } from './fixtures/pipeline/records.mjs';

const DAY = 86400000;
const T = Date.parse('2026-10-20T12:00:00Z');
let n = 0;
const run = ({ stage = 'review', outcome = 'success', runOutcome = 'partial', t = T, events = [], pr = 9, sha = 'a'.repeat(40), trigger = 'pull_request', llm = [], duration = 10000 } = {}) => ({
  run_id: `${++n}-1`, workflow: 'PR Review', event_name: trigger, started_at: t, outcome: runOutcome, pr_number: pr, head_sha: sha, llm, trace_id: null,
  stages: stage ? [{ stage, outcome, duration_ms: duration }] : [], events: events.map((e) => ({ stage, level: 'info', ts: t, meta: {}, ...e })),
  events_overflow: { count: 0 }, spans_overflow: { count: 0, events: 0 },
});
const verdict = (v, meta = {}, pr = 9) => ({ event: 'review.verdict', meta: { verdict: v, prNumber: pr, ...meta } });
const sha = (c) => String(c).repeat(40).slice(0, 40);

// One model on which every rule of pipeline_diagnostics.mjs fires, built from synthetic runs and one real
// record (the escalation needs a journey).
function everyRule() {
  const cut = { event: 'review.prompt_truncated', meta: { diff_truncated: true, unreviewed_code_files: 4, max_input_tokens: 6300, prNumber: 9 } };
  const fb = { event: 'llm_fallback', meta: { from: 'groq', to: 'anthropic', status: 429, error_type: 'rate_limit_exceeded' } };
  const wait = { event: 'retry.wait', meta: { status: 429, wait_ms: 30000 } };
  const attempt = () => run({ stage: 'autofix', events: [{ event: 'autofix.start', meta: { prNumber: 9 } }, { event: 'autofix.skipped', meta: { reason: 'no_changes' } }] });
  const gen = (blocked) => run({ stage: 'code_gen', events: [{ event: 'code_gen.start' }, blocked ? { event: 'code_gen.skipped', meta: { reason: 'blocked', source: 'model' } } : { event: 'code_gen.complete' }] });
  const slow = [1, 2, 3].map((i) => run({ t: T - i * 1000, sha: sha(i + 3), pr: 30 + i }));
  const fast = [1, 2, 3].map((i) => run({ t: T - 8 * DAY - i, duration: 4000, sha: sha(i + 6), pr: 40 + i }));
  const t0 = Date.parse('2026-10-16T10:00:00Z');
  const records = [makeRecord({ runId: '700', start: t0, workflow: 'Auto-Fix PR', stage: 'autofix', prNumber: 40, events: [{ event: 'autofix.escalated', meta: { reason: 'no_changes', prNumber: 40, url: 'https://github.com/koydas/autonomous-dev-loop/pull/40#c' } }] })];
  const real = buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });
  const synthetic = [
    run({ runOutcome: 'failed', outcome: 'failed', pr: 50, sha: sha('b'), events: [{ event: 'review.error', level: 'error', meta: { error: 'boom' } }] }),
    run({ outcome: 'failed', pr: 51, sha: sha('c') }),
    ...[1, 2, 3].map((i) => run({ sha: sha(i), pr: 9, events: [cut, verdict('WITHHELD', { withheld_from: 'REQUEST_CHANGES', unreviewed_code_files: 4 })] })),
    run({ trigger: 'push', sha: sha(1), pr: 9, events: [verdict('REQUEST_CHANGES')] }),
    ...[1, 2, 3].map((i) => run({ t: T + i, sha: sha(`d${i}`), pr: 77, events: [verdict('REQUEST_CHANGES', {}, 77)] })),
    attempt(), attempt(), attempt(),
    gen(true), gen(true), gen(false),
    run({ events: [fb, fb, wait, wait], llm: [{}, {}] }),
    ...slow, ...fast,
  ];
  const model = { ...real, runs: [...synthetic, ...real.runs], months: ['2026-10'], skippedMonths: [], warnings: [] };
  return { model, journeys: journeys(real) };
}

const RULE_IDS = ['runs-failed', 'stage-failures-review', 'escalations', 'review-withheld', 'review-coverage', 'review-duplicates', 'review-stuck', 'autofix-ineffective', 'codegen-blocked', 'llm-fallbacks', 'rate-limit-waits', 'duration-review'];

test('every rule yields a finding with its own key (the key is the public identity of a finding)', () => {
  const { model, journeys: j } = everyRule();
  const diagnosis = diagnose({ model, journeys: j });
  const exported = buildFindingsExport({ diagnosis, window: {}, generatedAt: 'T' });
  const keys = exported.findings.map((f) => f.key);
  assert.deepEqual([...keys].sort(), [...RULE_IDS].sort(), 'a rule added without a decision here is a red test, not a silent key');
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(exported.findings.map((f) => f.id), diagnosis.findings.map((f) => f.id), 'most severe first, as the page');
});

test('a key collision is numbered in order; keys that do not collide are the rule id', () => {
  const f = (id) => ({ id, category: 'C', title: id, severity: 'warning', fact: 'x', impact: 'i', frequency: 'f', evidence: [] });
  const keys = buildFindingsExport({ diagnosis: { status: 'warning', findings: [f('a'), f('b'), f('a'), f('a')], gaps: [] } }).findings.map((x) => x.key);
  assert.deepEqual(keys, ['a', 'b', 'a:2', 'a:3']);
});

test('export ⊆ page: every string of the export appears in the Diagnostics page data', () => {
  const { model, journeys: j } = everyRule();
  const ctx = consoleContext(model);
  ctx.journeys = j;
  ctx.diagnosis = diagnose({ model, journeys: j });
  const page = diagnosticsBody(ctx, '');
  const exported = buildFindingsExport({ diagnosis: ctx.diagnosis, window: ctx.overview.window, generatedAt: 'T' });
  assert.ok(exported.findings.length >= RULE_IDS.length);
  const missing = [];
  const onPage = (label, s) => { if (typeof s === 'string' && s !== '' && !page.includes(escapeHtml(s))) missing.push(`${label}: ${s}`); };
  for (const f of exported.findings) {
    for (const k of ['id', 'category', 'title', 'severity', 'status', 'fact', 'hypothesis', 'impact', 'frequency']) onPage(`${f.key}.${k}`, f[k]);
    for (const ev of f.evidence) for (const k of ['run_id', 'summary', 'url']) onPage(`${f.key}.evidence.${k}`, ev[k]);
  }
  for (const g of exported.gaps) for (const k of ['title', 'detail']) onPage(`gap ${g.id}.${k}`, g[k]);
  // The lever (ADR-0047 §3) is shown on the card: its text is on the page as well.
  const levers = exported.findings.filter((f) => f.lever);
  assert.ok(levers.length >= 3, 'the fixture has several mapped warnings');
  for (const f of levers) {
    onPage(`${f.key}.lever.summary`, f.lever.summary);
    onPage(`${f.key}.lever.stage`, f.lever.stage);
    // The page says what a target requires in words (requirementLabel); the contract tokens are the export's.
    for (const t of f.lever.targets) { onPage(`${f.key}.lever.target`, t.ref); onPage(`${f.key}.lever.requires`, requirementLabel(t)); }
    for (const a of f.lever.adr) onPage(`${f.key}.lever.adr`, `ADR-${a}`);
    // The root requires is the union of the targets' requirements plus docs-and-tests; each is on the page.
    assert.deepEqual(f.lever.requires, [...new Set(f.lever.targets.map((t) => t.requires)), 'docs-and-tests'], `${f.key}: root requires`);
    for (const r of f.lever.requires) {
      if (r === 'docs-and-tests') onPage(`${f.key}.lever.requires`, r);
      else assert.ok(f.lever.targets.some((t) => t.requires === r), `${f.key}: ${r} is the requirement of a target shown above`);
    }
    // The command on the card takes the finding's key from the export: it is what /loop-insights accepts.
    onPage(`${f.key}.lever.command`, `/ai-dev-tools:loop-insights --finding ${f.key}`);
  }
  assert.deepEqual(missing, []);
  assert.ok(exported.gaps.length > 0);
});

test('lever in the export is leverFor(finding): only active warning / critical findings of a mapped rule have one', () => {
  const { model, journeys: j } = everyRule();
  const diagnosis = diagnose({ model, journeys: j });
  const exported = buildFindingsExport({ diagnosis, window: {}, generatedAt: 'T' });
  assert.deepEqual(exported.findings.map((f) => f.lever), diagnosis.findings.map((f) => leverFor(f)));
  for (const f of exported.findings) {
    if (f.lever) { assert.ok(f.status === 'active' && f.severity !== 'info', f.key); assert.equal(f.lever.verified, false); }
  }
  for (const key of ['runs-failed', 'review-stuck', 'escalations', 'review-duplicates']) assert.equal(exported.findings.find((f) => f.key === key).lever, null, key);
  assert.deepEqual(exported.findings.filter((f) => f.lever).map((f) => f.key).sort(), ['autofix-ineffective', 'codegen-blocked', 'llm-fallbacks', 'review-withheld']);
  // review-coverage is mapped, but here every cut diff was WITHHELD (the ADR-0038 guardrail): info, so no lever.
  const coverage = exported.findings.find((f) => f.key === 'review-coverage');
  assert.deepEqual([coverage.severity, coverage.lever], ['info', null]);
});

test('the export copies a fixed list of fields: a field added to a finding is not published', () => {
  const finding = { id: 'x', category: 'C', title: 'T', severity: 'warning', status: 'active', fact: 'F', impact: 'I', frequency: 'N', secret: 'journal-only', runs: ['1-1'], items: [1], link: 'a.html',
    evidence: [{ run_id: '1-1', ts: 5, event: 'e', summary: 's', pr: 3, url: 'https://github.com/x', meta: { token: 'z' } }] };
  const out = buildFindingsExport({ diagnosis: { status: 'warning', findings: [finding], gaps: [{ id: 'g', title: 't', detail: 'd', runs: ['1-1'] }] } });
  assert.deepEqual(Object.keys(out.findings[0]).sort(), ['category', 'clean_since', 'evidence', 'fact', 'first_seen', 'frequency', 'hypothesis', 'id', 'impact', 'key', 'last_seen', 'lever', 'severity', 'status', 'title']);
  assert.deepEqual(Object.keys(out.findings[0].evidence[0]).sort(), ['event', 'pr', 'run_id', 'summary', 'ts', 'url']);
  assert.deepEqual(Object.keys(out.gaps[0]).sort(), ['detail', 'id', 'title']);
  assert.ok(!JSON.stringify(out).includes('journal-only') && !JSON.stringify(out).includes('"z"'));
  assert.equal(out.findings[0].lever, null);
});

test('envelope: schema version, build time, window, status; missing values are null, never a default', () => {
  const out = buildFindingsExport({ diagnosis: { status: 'warning', findings: [{ id: 'x', category: 'C', title: 'T', severity: 'info', fact: 'F', impact: 'I', frequency: 'N', first_seen: 10, last_seen: Number.NaN, clean_since: undefined }], gaps: [] }, window: { from: 1, to: 2, runs: 3 }, generatedAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(out.schema_version, FINDINGS_SCHEMA_VERSION);
  assert.equal(FINDINGS_SCHEMA_VERSION, 1);
  assert.equal(out.generated_at, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(out.window, { from: 1, to: 2, runs: 3 });
  assert.equal(out.status, 'warning');
  const [f] = out.findings;
  assert.deepEqual([f.first_seen, f.last_seen, f.clean_since, f.hypothesis, f.status], [10, null, null, null, 'active']);
  // Evidence with holes keeps the same shape.
  const [ev] = buildFindingsExport({ diagnosis: { findings: [{ id: 'x', evidence: [{ run_id: '1-1' }] }] } }).findings[0].evidence;
  assert.deepEqual(ev, { run_id: '1-1', ts: null, event: null, summary: '', pr: null, url: null });
});

test('no data is not health: no runs → status no_data, empty findings, gaps kept; no argument at all is still valid', () => {
  const out = buildFindingsExport({ diagnosis: diagnose({ model: { runs: [], traces: [], months: [], skippedMonths: [], warnings: [] } }), window: { from: null, to: null, runs: 0 } });
  assert.equal(out.status, 'no_data');
  assert.deepEqual(out.findings, []);
  assert.ok(out.gaps.length > 0);
  assert.deepEqual(out.window, { from: null, to: null, runs: 0 });
  const none = buildFindingsExport();
  assert.deepEqual([none.status, none.findings, none.gaps, none.generated_at, none.window], ['no_data', [], [], null, { from: null, to: null, runs: 0 }]);
});

test('hostile record text survives as data: valid JSON, verbatim, nothing interpreted', () => {
  const finding = { id: 'x', category: 'C', title: HOSTILE, severity: 'warning', fact: HOSTILE, hypothesis: HOSTILE, impact: HOSTILE, frequency: HOSTILE, evidence: [{ run_id: '1-1', summary: HOSTILE }] };
  const text = findingsExportJson({ diagnosis: { status: 'warning', findings: [finding], gaps: [] }, generatedAt: 'T' });
  assert.ok(text.endsWith('\n'));
  const back = JSON.parse(text);
  assert.equal(back.findings[0].fact, HOSTILE);
  assert.equal(back.findings[0].evidence[0].summary, HOSTILE);
  assert.deepEqual(back, buildFindingsExport({ diagnosis: { status: 'warning', findings: [finding], gaps: [] }, generatedAt: 'T' }));
});

// ---------------------------------------------------------------------------
// assembleSite: the file is published with the pipeline half and with nothing else
// ---------------------------------------------------------------------------

const GEN = '2026-10-22T00:00:00.000Z';
const pipelineOf = (records) => ({ records: records.map((r) => ({ path: recordPath(r), text: JSON.stringify(r) })), traces: indexesOf(records), runsJsonl: '' });
const failedRecord = () => makeRecord({ runId: '800', start: Date.parse('2026-10-16T10:00:00Z'), outcome: 'failure' });

test('assembleSite publishes findings.json at the site root, built from the same diagnosis as the page', () => {
  const records = [makeRecord({ runId: '700', events: [{ event: 'review.verdict', meta: { verdict: 'APPROVE', prNumber: 7 } }] }), failedRecord()];
  const { files } = assembleSite({ previous: { scorecard: emptyScorecard(), details: {} }, resultsList: [], pipeline: pipelineOf(records), generatedAt: GEN });
  const out = JSON.parse(files['findings.json']);
  assert.equal(out.schema_version, 1);
  assert.equal(out.generated_at, GEN);
  assert.equal(out.window.runs, 2);
  assert.ok(Number.isFinite(out.window.from) && out.window.from <= out.window.to);
  assert.ok(['ok', 'warning', 'critical'].includes(out.status));
  assert.ok(files['pipeline/diagnostics.html']);
  for (const f of out.findings) assert.ok(files['pipeline/diagnostics.html'].includes(`id="${f.id}"`), `${f.key} is on the page`);
  // The Diagnostics badge counts what the page counts: serious findings only.
  assert.equal(out.findings.filter((f) => f.severity !== 'info').length > 0, />[1-9]\d*<\/span>/.test(files['pipeline/diagnostics.html']));
});

test('an eval-only site (no pipeline half) publishes no findings.json: an absent file is not an empty list', () => {
  const { files } = assembleSite({ previous: { scorecard: emptyScorecard(), details: {} }, resultsList: [], generatedAt: GEN });
  assert.equal(files['findings.json'], undefined);
});

test('status.json: diagnostic status, raised to warn by a failing eval gate, a headline without finding text', async () => {
  const { buildStatus, statusJson, STATUS_SCHEMA_VERSION } = await import('../lib/findings_export.mjs');
  const f = (severity, status = 'active') => ({ id: 'x', severity, status, title: '<secret title>' });
  const sc = (...passed) => ({ suites: Object.fromEntries(passed.map((p, i) => [`s${i}`, { runs: [{ passed: p }] }])) });
  assert.deepEqual(buildStatus({ diagnosis: { status: 'warning', findings: [f('warning'), f('info'), f('critical', 'resolved')] }, scorecard: sc(true), generatedAt: 'G' }),
    { schema_version: STATUS_SCHEMA_VERSION, app: 'autonomous-dev-loop', generated_at: 'G', status: 'warn', headline: '1 problem(s)' });
  assert.equal(buildStatus({ diagnosis: { status: 'critical', findings: [f('critical')] }, scorecard: sc(false) }).headline, '1 problem(s) · 1 eval gate(s) failing');
  assert.equal(buildStatus({ diagnosis: { status: 'critical', findings: [f('critical')] } }).status, 'bad');
  const ok = buildStatus({ diagnosis: { status: 'ok', findings: [] }, scorecard: sc(true, false) });
  assert.deepEqual([ok.status, ok.headline], ['warn', 'no problem detected · 1 eval gate(s) failing']);
  assert.deepEqual([buildStatus({ diagnosis: { status: 'ok', findings: [] }, scorecard: { suites: { e: { runs: [] } } } }).status], ['ok'], 'a suite without runs is no failing gate');
  const none = buildStatus({});
  assert.deepEqual([none.status, none.headline, none.generated_at], ['no_data', 'no pipeline run recorded', null]);
  assert.equal(buildStatus({ diagnosis: { status: 'odd' } }).status, 'no_data');
  assert.doesNotMatch(statusJson({ diagnosis: { status: 'warning', findings: [f('warning')] } }), /secret/);
  assert.match(statusJson({}), /\n$/);
});
