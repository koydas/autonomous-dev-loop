import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, RULES, SEVERITY_ORDER } from '../lib/pipeline_diagnostics.mjs';
import { journeys } from '../lib/pipeline_journey.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf } from './fixtures/pipeline/records.mjs';

const DAY = 86400000;
const T = Date.parse('2026-10-20T12:00:00Z');
let n = 0;
const run = ({ stage = 'review', outcome = 'success', runOutcome = 'partial', t = T, events = [], pr = 9, sha = 'a'.repeat(40), trigger = 'pull_request', llm = [], duration = 900 } = {}) => ({
  run_id: `${++n}-1`, workflow: 'PR Review', event_name: trigger, started_at: t, outcome: runOutcome, pr_number: pr, head_sha: sha, llm, trace_id: null,
  stages: stage ? [{ stage, outcome, duration_ms: duration }] : [], events: events.map((e) => ({ stage, level: 'info', ts: t, meta: {}, ...e })),
  events_overflow: { count: 0 }, spans_overflow: { count: 0, events: 0 },
});
const model = (runs, extra = {}) => ({ runs, traces: [], tracesById: new Map(), months: ['2026-10'], skippedMonths: [], warnings: [], ...extra });
const ids = (d) => d.findings.map((f) => f.id);
const find = (d, id) => d.findings.find((f) => f.id === id);
const verdict = (v, meta = {}, pr = 9) => ({ event: 'review.verdict', meta: { verdict: v, prNumber: pr, ...meta } });

test('no run: no_data, never ok; gaps are still listed', () => {
  const d = diagnose({ model: model([]) });
  assert.equal(d.status, 'no_data');
  assert.deepEqual(d.findings, []);
  assert.ok(d.gaps.some((g) => g.id === 'merge-not-journaled'));
  assert.deepEqual(diagnose(), { status: 'no_data', findings: [], gaps: [] });
});

test('healthy runs: ok, no finding, and the gaps that limit that conclusion', () => {
  const runs = [1, 2, 3].map((i) => run({ runOutcome: 'success', pr: i, sha: String(i).repeat(40), events: [verdict('APPROVE', {}, i)] }));
  const d = diagnose({ model: model(runs) });
  assert.equal(d.status, 'ok');
  assert.deepEqual(d.findings, []);
  assert.ok(d.gaps.some((g) => g.id === 'running-not-observable'));
  assert.ok(d.gaps.some((g) => g.id === 'untraced'));
});

test('execution failures: failed runs and repeated stage failures are critical and sorted first', () => {
  const runs = [run({ runOutcome: 'failed', outcome: 'failed', events: [{ event: 'review.error', level: 'error', meta: { error: 'boom' } }] }), run({ outcome: 'failed' }), run({ events: [verdict('APPROVE')] })];
  const d = diagnose({ model: model(runs) });
  assert.equal(d.status, 'critical');
  assert.deepEqual(ids(d).slice(0, 2), ['runs-failed', 'stage-failures-review']);
  assert.match(find(d, 'runs-failed').fact, /1 of 3 run\(s\)/);
  assert.equal(find(d, 'runs-failed').evidence[0].event, 'review.error');
  assert.match(find(d, 'stage-failures-review').fact, /2 of 3 review span/);
  // One failed span is below the threshold.
  assert.ok(!ids(diagnose({ model: model([run({ outcome: 'failed' }), run()]) })).includes('stage-failures-review'));
  assert.deepEqual(SEVERITY_ORDER, ['critical', 'warning', 'info']);
});

test('withheld reviews and cut diffs: fact, cause split, and a labelled hypothesis only when the cut dominates', () => {
  const cut = { event: 'review.prompt_truncated', meta: { diff_truncated: true, unreviewed_code_files: 4, max_input_tokens: 6300, prNumber: 9 } };
  const runs = [
    run({ events: [cut, verdict('WITHHELD', { withheld_from: 'APPROVE', unreviewed_code_files: 4 })] }),
    run({ events: [cut, verdict('WITHHELD', { unreviewed_code_files: 2 })], sha: 'b'.repeat(40) }),
    run({ events: [verdict('APPROVE')], sha: 'c'.repeat(40), pr: 10 }),
  ];
  const d = diagnose({ model: model(runs) });
  const w = find(d, 'review-withheld');
  assert.match(w.fact, /2 of 3 verdicts are WITHHELD \(67 %\); 2 of them had code files not reviewed, 1 would have been APPROVE/);
  assert.match(w.hypothesis, /input budget/);
  assert.deepEqual(w.items, [9]);
  const c = find(d, 'review-coverage');
  assert.match(c.fact, /2 of 3 reviews saw a truncated diff; median 4 code file\(s\) not reviewed, input budget 6300 tokens/);
  // Withheld on evidence, not on a cut: no budget hypothesis.
  const evidence = diagnose({ model: model([1, 2, 3].map((i) => run({ sha: String(i).repeat(40), events: [verdict('WITHHELD', { evidence_state: 'missing' })] })) ) });
  assert.equal(find(evidence, 'review-withheld').hypothesis, null);
  assert.ok(!ids(evidence).includes('review-coverage'));
  // Fewer than RULES.minVerdicts verdicts: nothing is judged.
  assert.deepEqual(ids(diagnose({ model: model([run({ events: [verdict('WITHHELD')] })]) })), []);
  assert.equal(RULES.minVerdicts, 3);
});

test('the same head reviewed twice: duplicate triggers, extra runs, and verdict flips on identical code', () => {
  const runs = [
    run({ trigger: 'pull_request', events: [verdict('REQUEST_CHANGES')] }),
    run({ trigger: 'push', events: [verdict('WITHHELD')] }),
    run({ trigger: 'push', sha: 'b'.repeat(40), events: [verdict('APPROVE')] }),
    run({ sha: null, events: [verdict('APPROVE')] }),
  ];
  const f = find(diagnose({ model: model(runs) }), 'review-duplicates');
  assert.match(f.fact, /1 PR head\(s\) got 1 extra review run\(s\) \(triggers: pull_request, push\); 1 of them got different verdicts on the same code/);
  assert.match(f.hypothesis, /push and the pull_request trigger/);
  assert.equal(f.runs.length, 2);
  // One trigger kind only (a manual re-run): no trigger hypothesis.
  const rerun = find(diagnose({ model: model([run({ events: [verdict('APPROVE')] }), run({ events: [verdict('APPROVE')] }), run({ sha: 'c'.repeat(40), events: [verdict('APPROVE')] })]) }), 'review-duplicates');
  assert.equal(rerun.hypothesis, null);
  assert.doesNotMatch(rerun.fact, /different verdicts/);
});

test('PRs stuck without approval after RULES.reviewStreak reviews', () => {
  const runs = [1, 2, 3].map((i) => run({ t: T + i, sha: String(i).repeat(40), events: [verdict(i === 1 ? 'APPROVE' : 'WITHHELD')] }));
  assert.ok(!ids(diagnose({ model: model(runs) })).includes('review-stuck'), 'an approval among the last three');
  runs.push(run({ t: T + 9, sha: 'f'.repeat(40), events: [verdict('REQUEST_CHANGES')] }));
  const f = find(diagnose({ model: model(runs) }), 'review-stuck');
  assert.match(f.fact, /#9 \(4\)/);
  assert.equal(f.evidence.length, RULES.reviewStreak);
});

test('auto-fix that rarely pushes, with a hypothesis only for no_changes', () => {
  const attempt = (reason) => run({ stage: 'autofix', events: [{ event: 'autofix.start', meta: { prNumber: 9 } }, ...(reason ? [{ event: 'autofix.skipped', meta: { reason } }] : [{ event: 'autofix.push' }])] });
  const d = diagnose({ model: model([attempt('no_changes'), attempt('guardrail_rejected'), attempt(null)]) });
  const f = find(d, 'autofix-ineffective');
  assert.match(f.fact, /1 push\(es\) for 3 attempt\(s\); skip reasons: no_changes 1, guardrail_rejected 1/);
  assert.match(f.hypothesis, /does not prove a fix was needed/);
  assert.equal(find(diagnose({ model: model([attempt('guardrail_rejected'), attempt('guardrail_rejected')]) }), 'autofix-ineffective').hypothesis, null);
  assert.ok(!ids(diagnose({ model: model([attempt(null), attempt(null), attempt('no_changes')]) })).includes('autofix-ineffective'), 'most attempts pushed');
  assert.ok(!ids(diagnose({ model: model([attempt('no_changes')]) })).includes('autofix-ineffective'), 'one attempt is not judged');
  assert.match(find(diagnose({ model: model([run({ stage: 'autofix', events: [{ event: 'autofix.start' }, { event: 'autofix.skipped' }] }), run({ stage: 'autofix', events: [{ event: 'autofix.start' }] })]) }), 'autofix-ineffective').fact, /unspecified 1/);
});

test('code generation mostly blocked', () => {
  const gen = (blocked) => run({ stage: 'code_gen', events: [{ event: 'code_gen.start' }, blocked ? { event: 'code_gen.skipped', meta: { reason: 'blocked', source: 'model' } } : { event: 'code_gen.complete' }] });
  assert.match(find(diagnose({ model: model([gen(true), gen(true), gen(false)]) }), 'codegen-blocked').fact, /2 of 3 generation run\(s\) produced no patch \(source: model 2\); 1 completed/);
  assert.ok(!ids(diagnose({ model: model([gen(true), gen(false), gen(false)]) })).includes('codegen-blocked'));
  assert.match(find(diagnose({ model: model([run({ stage: 'code_gen', events: [{ event: 'code_gen.start' }, { event: 'code_gen.skipped' }] }), run({ stage: 'code_gen', events: [{ event: 'code_gen.skipped' }] })]) }), 'codegen-blocked').fact, /unspecified 2/);
});

test('provider fallbacks: unclassified causes are said, the rate-limit hypothesis needs a 429 majority', () => {
  const fb = (status, error_type) => ({ event: 'llm_fallback', meta: { from: 'groq', to: 'anthropic', status, error_type } });
  const mostlyUnknown = find(diagnose({ model: model([run({ events: [fb(429, 'rate_limit_exceeded'), fb(null, 'UNKNOWN'), fb(null, undefined)], llm: [{}, {}] })]) }), 'llm-fallbacks');
  assert.match(mostlyUnknown.fact, /3 fallback\(s\) for 2 LLM call\(s\)/);
  assert.match(mostlyUnknown.fact, /2 of them carry no classified error type/);
  assert.equal(mostlyUnknown.hypothesis, null);
  const limited = find(diagnose({ model: model([run({ events: [fb(429, 'rate_limit_exceeded'), fb(429, 'rate_limit_exceeded')] })]) }), 'llm-fallbacks');
  assert.match(limited.hypothesis, /429/);
  assert.doesNotMatch(limited.fact, /no classified/);
  assert.ok(!ids(diagnose({ model: model([run({ events: [fb(429, 'x')] })]) })).includes('llm-fallbacks'));
  // 429 waits: time lost, other statuses ignored.
  const waits = find(diagnose({ model: model([run({ events: [{ event: 'retry.wait', meta: { status: 429, wait_ms: 90000 } }, { event: 'retry.wait', meta: { status: 429, wait_ms: 30000 } }, { event: 'retry.wait', meta: { status: 500, wait_ms: 1 } }] })]) }), 'rate-limit-waits');
  assert.match(waits.fact, /2 retry wait\(s\) on HTTP 429, totalling 2\.0 min across 1 run/);
  assert.equal(waits.severity, 'info');
  assert.match(find(diagnose({ model: model([run({ events: [{ event: 'retry.wait', meta: { status: 429, wait_ms: 3000 } }, { event: 'retry.wait', meta: { status: 429 } }] })]) }), 'rate-limit-waits').fact, /3 s/);
});

test('stage durations: a degradation over two 7-day periods, otherwise an explicit gap', () => {
  const slow = [1, 2, 3].map((i) => run({ t: T - i * 1000, duration: 10000, events: [verdict('APPROVE')], sha: String(i).repeat(40) }));
  const fast = [1, 2, 3].map((i) => run({ t: T - 8 * DAY - i, duration: 4000, events: [verdict('APPROVE')], sha: String(i + 3).repeat(40) }));
  const d = diagnose({ model: model([...slow, ...fast]) });
  assert.match(find(d, 'duration-review').fact, /Median review span 10 s over the latest 7 days \(n=3\) vs 4 s the 7 days before \(n=3\)/);
  assert.ok(!d.gaps.some((g) => g.id === 'duration-thin'));
  const steady = diagnose({ model: model([...slow, ...fast.map((r) => ({ ...r, stages: [{ ...r.stages[0], duration_ms: 9000 }] }))]) });
  assert.ok(!ids(steady).includes('duration-review'));
  const thin = diagnose({ model: model(slow) });
  assert.match(thin.gaps.find((g) => g.id === 'duration-thin').detail, /review.*not the same as no degradation/);
  assert.match(find(diagnose({ model: model([...slow.map((r) => ({ ...r, stages: [{ ...r.stages[0], duration_ms: 600000 }] })), ...fast]) }), 'duration-review').fact, /10\.0 min/);
  assert.ok(!diagnose({ model: model([run({ t: null })]) }).gaps.some((g) => g.id === 'duration-thin'), 'undated runs: no trend to compute');
});

test('escalated work items and telemetry gaps from a real model', () => {
  const t0 = Date.parse('2026-10-16T10:00:00Z');
  const records = [makeRecord({ runId: '700', start: t0, workflow: 'Auto-Fix PR', stage: 'autofix', prNumber: 40, events: [{ event: 'autofix.escalated', meta: { reason: 'no_changes', prNumber: 40, url: 'https://github.com/koydas/autonomous-dev-loop/pull/40#c' } }] })];
  const m = buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });
  const d = diagnose({ model: m, journeys: journeys(m) });
  const f = find(d, 'escalations');
  assert.match(f.fact, /1 work item\(s\).*pr #40/);
  assert.equal(f.evidence[0].url, 'https://github.com/koydas/autonomous-dev-loop/pull/40#c');
  assert.ok(d.gaps.some((g) => g.id === 'estimated-tokens'));
  assert.ok(!d.gaps.some((g) => g.id === 'untraced'));
  const gappy = diagnose({ model: { ...m, warnings: ['x'], skippedMonths: ['2025-01'], runs: m.runs.map((r) => ({ ...r, events_overflow: { count: 2 } })) }, journeys: [{ ...journeys(m)[0], missing_runs: 3 }] });
  for (const id of ['missing-records', 'overflow', 'input-warnings', 'window']) assert.ok(gappy.gaps.some((g) => g.id === id), id);
});

test('evidence is capped and keeps run, event, summary, PR and an https source link', () => {
  const runs = Array.from({ length: 40 }, (_, i) => run({ sha: String(i).padStart(40, '0'), events: [verdict('WITHHELD', { url: 'https://github.com/x' })] }));
  const f = find(diagnose({ model: model(runs) }), 'review-withheld');
  assert.equal(f.evidence.length, 25);
  assert.equal(f.runs.length, 40);
  assert.deepEqual(Object.keys(f.evidence[0]).sort(), ['event', 'pr', 'run_id', 'summary', 'ts', 'url']);
  assert.match(f.evidence[0].summary, /verdict=WITHHELD/);
});
