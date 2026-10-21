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
  // The approval ended the earlier round: only the trailing streak is counted.
  assert.match(f.fact, /#9 \(3\)/);
  assert.match(f.impact, /^3 review run\(s\)/);
  assert.equal(f.runs.length, 3);
  assert.ok(!f.runs.includes(runs[0].run_id));
  assert.equal(f.evidence.length, RULES.reviewStreak);
});

test('cut-diff rate: a cut review that errored before its verdict stays out of the numerator', () => {
  const cut = { event: 'review.prompt_truncated', meta: { diff_truncated: true, unreviewed_code_files: 3, prNumber: 9 } };
  const runs = [
    ...[1, 2, 3].map((i) => run({ sha: String(i).repeat(40), events: [cut, verdict('WITHHELD', { unreviewed_code_files: 3 })] })),
    run({ runOutcome: 'failed', outcome: 'failed', sha: 'd'.repeat(40), events: [cut, { event: 'review.error', level: 'error', meta: { error: 'boom' } }] }),
    run({ runOutcome: 'failed', outcome: 'failed', sha: 'e'.repeat(40), events: [cut, { event: 'review.error', level: 'error', meta: { error: 'boom' } }] }),
  ];
  const c = find(diagnose({ model: model(runs) }), 'review-coverage');
  assert.match(c.fact, /^3 of 3 reviews saw a truncated diff/);
  assert.equal(c.runs.length, 3);
});

test('auto-fix that rarely pushes, with a hypothesis only for no_changes', () => {
  const attempt = (reason) => run({ stage: 'autofix', events: [{ event: 'autofix.start', meta: { prNumber: 9 } }, ...(reason ? [{ event: 'autofix.skipped', meta: { reason } }] : [{ event: 'autofix.push' }])] });
  const d = diagnose({ model: model([attempt('no_changes'), attempt('guardrail_rejected'), attempt(null)]) });
  const f = find(d, 'autofix-ineffective');
  assert.match(f.fact, /1 delivered push\(es\) for 3 attempt\(s\); skip reasons: no_changes 1, guardrail_rejected 1/);
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

test('two reviews of one head are a duplicate even below the rate sample floor (PR #242 review)', () => {
  const d = diagnose({ model: model([run({ trigger: 'pull_request', events: [verdict('APPROVE')] }), run({ trigger: 'push', events: [verdict('APPROVE')] })]) });
  assert.ok(RULES.minVerdicts > 2);
  assert.deepEqual(ids(d), ['review-duplicates']);
  assert.equal(d.status, 'warning');
  // The rate rules still wait for their floor.
  assert.ok(!ids(d).includes('review-withheld'));
});

test('rejected issues are not repeated stage failures; errored validations are (PR #242 review)', () => {
  const rejected = () => run({ stage: 'issue_validation', outcome: 'failed', events: [{ event: 'issue_validation.fail', level: 'warn', meta: { score: 40, blockers_count: 2 } }] });
  const errored = () => run({ stage: 'issue_validation', outcome: 'failed', events: [{ event: 'issue_validation.fail', level: 'error', meta: { error: 'x' } }] });
  const d = diagnose({ model: model([rejected(), rejected()]) });
  assert.ok(!ids(d).includes('stage-failures-issue_validation'));
  assert.notEqual(d.status, 'critical');
  const e = diagnose({ model: model([errored(), errored(), rejected()]) });
  assert.match(find(e, 'stage-failures-issue_validation').fact, /2 of 3 issue_validation span\(s\) closed as failed without a decision explaining it/);
});

test('over the evidence cap the oldest occurrence is kept, so "since" is the true start (PR #242 review)', () => {
  // model.runs is newest first: the oldest occurrence is the last one.
  const runs = Array.from({ length: 40 }, (_, i) => run({ t: T - i * 60000, sha: String(i).padStart(40, '0'), events: [verdict('WITHHELD')] }));
  const f = find(diagnose({ model: model(runs) }), 'review-withheld');
  assert.equal(f.evidence.length, 25);
  assert.equal(Math.min(...f.evidence.map((x) => x.ts)), T - 39 * 60000);
  assert.equal(f.evidence[0].ts, T, 'the newest occurrences still lead');
});

test('auto-fix push rate counts delivered pushes only; stuck reviews link by step; unconfirmed PR creation is a gap (PR #242 review)', () => {
  const attempt = (events) => run({ stage: 'autofix', events: [{ event: 'autofix.start' }, ...events] });
  const failed = () => attempt([{ event: 'autofix.push' }, { event: 'workflow.push', stage: 'workflow', meta: { outcome: 'failure' } }]);
  const f = find(diagnose({ model: model([failed(), failed(), attempt([{ event: 'autofix.push' }])]) }), 'autofix-ineffective');
  assert.match(f.fact, /^1 delivered push\(es\) for 3 attempt\(s\), 2 whose git push failed/);
  // Stuck PRs link to the review step, whatever their last verdict.
  const runs = [1, 2, 3].map((i) => run({ t: T + i, sha: String(i).repeat(40), events: [verdict('REQUEST_CHANGES')] }));
  assert.equal(find(diagnose({ model: model(runs) }), 'review-stuck').link, 'flows.html?problem=review');
  // A prepared change without a recorded PR operation.
  const prepared = run({ stage: 'pr_prepare', outcome: 'success', events: [{ event: 'pr_prepare.complete' }] });
  const created = run({ stage: 'pr_prepare', outcome: 'success', events: [{ event: 'workflow.pr_operation', meta: { operation: 'created' } }] });
  const gap = diagnose({ model: model([prepared, created]) }).gaps.find((g) => g.id === 'pr-operation-unrecorded');
  assert.match(gap.detail, /^1 run\(s\) prepared a change but recorded no PR operation/);
  assert.deepEqual(gap.runs, [prepared.run_id]);
});

// Withheld verdicts: guardrail vs anomaly. Each WITHHELD verdict below is on its own head.
const cutTo = (budget) => ({ event: 'review.prompt_truncated', meta: { diff_truncated: true, unreviewed_code_files: 3, max_input_tokens: budget, prNumber: 9 } });
const groq = [{ provider: 'groq', pipeline_stage: 'review', fallback: false, failed: false }];
const fellBack = [{ provider: 'groq', pipeline_stage: 'review', fallback: false, failed: true }, { provider: 'anthropic', pipeline_stage: 'review', fallback: true, failed: false }];
const withheldRuns = (metas, { llm = groq, budget = 6300, pr = (i) => 9 + (i % 2) } = {}) => metas.map((meta, i) => run({
  sha: String(i).repeat(40).slice(0, 40), pr: pr(i), llm, events: [cutTo(budget), verdict('WITHHELD', { unreviewed_code_files: 3, ...meta }, pr(i))],
}));

test('withheld guardrail (code cut, ADR-0038): info with heads, PRs, provider and budget, volume kept', () => {
  const runs = [
    ...withheldRuns([{ withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }, {}]),
    // A second review of the first head (push + pull_request): a verdict, not a new head.
    run({ sha: '0'.repeat(40), pr: 9, llm: groq, events: [cutTo(6300), verdict('WITHHELD', { withheld_from: 'APPROVE', unreviewed_code_files: 3 })] }),
    run({ sha: 'f'.repeat(40), pr: 11, events: [verdict('APPROVE', {}, 11)] }),
  ];
  const w = find(diagnose({ model: model(runs) }), 'review-withheld');
  assert.equal(w.severity, 'info');
  assert.equal(w.title, 'Reviews withhold their verdict by design (ADR-0038)');
  assert.match(w.fact, /^4 of 5 verdicts are WITHHELD \(80 %\)/);
  assert.match(w.fact, /They cover 3 PR head\(s\) on 2 PR\(s\)\. Guardrail: 4 \(code cut, ADR-0038: 4; CI evidence, ADR-0026: 0\); anomaly: 0 /);
  assert.match(w.fact, /Answered by: groq 4; input budget 6300 tokens\.$/);
  assert.equal(w.frequency, '4 verdict(s) on 3 head(s) of 2 PR(s)');
  assert.match(w.hypothesis, /worked as designed.*provider or its input budget/);
  assert.equal(w.runs.length, 4, 'the volume is not hidden');
  // One commit heading two PRs is two PR heads.
  const shared = [9, 10, 10].map((pr) => run({ sha: 'd'.repeat(40), pr, events: [cutTo(6300), verdict('WITHHELD', { withheld_from: 'APPROVE', unreviewed_code_files: 3 }, pr)] }));
  assert.equal(find(diagnose({ model: model(shared) }), 'review-withheld').frequency, '3 verdict(s) on 2 head(s) of 2 PR(s)');
  // Missing CI evidence is a guardrail too (ADR-0026); no budget hypothesis without a cut majority.
  const ev = find(diagnose({ model: model([0, 1, 2].map((i) => run({ sha: String(i).repeat(40), events: [verdict('WITHHELD', { evidence_state: i ? 'stale' : 'missing' })] }))) }), 'review-withheld');
  assert.equal(ev.severity, 'info');
  assert.equal(ev.title, 'Reviews withhold their verdict by design (ADR-0026)', 'the title names the guardrail observed');
  assert.match(ev.fact, /CI evidence, ADR-0026: 3\); anomaly: 0 .*Answered by: not recorded 3\.$/);
  assert.equal(ev.hypothesis, null);
});

test('withheld anomaly: REQUEST_CHANGES withheld on unseen code over withheldShare is a warning', () => {
  const runs = withheldRuns([{ withheld_from: 'REQUEST_CHANGES' }, { withheld_from: 'REQUEST_CHANGES' }, { withheld_from: 'APPROVE' }]);
  const w = find(diagnose({ model: model(runs) }), 'review-withheld');
  assert.equal(w.severity, 'warning');
  assert.equal(w.title, 'Reviews withhold their verdict');
  assert.match(w.fact, /anomaly: 2 \(REQUEST_CHANGES on unseen code: 2; unknown cause: 0; fallback answered a prompt cut to the primary's budget: 0\)/);
  assert.equal(w.hypothesis, null);
  // The threshold applies to the anomaly share: 1 anomaly in 5 verdicts (20 %) stays info, whatever the total.
  const below = [...withheldRuns([{ withheld_from: 'REQUEST_CHANGES' }, { withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }]), run({ sha: 'e'.repeat(40), events: [verdict('APPROVE')] })];
  const b = find(diagnose({ model: model(below) }), 'review-withheld');
  assert.equal(b.severity, 'info');
  assert.match(b.fact, /^4 of 5 verdicts are WITHHELD.*anomaly: 1 /);
});

test('withheld with an unknown cause (no cut, no evidence state, withheld_from null) is an anomaly', () => {
  const runs = [0, 1, 2].map((i) => run({ sha: String(i).repeat(40), events: [verdict('WITHHELD', { withheld_from: null, unreviewed_code_files: 0 })] }));
  const w = find(diagnose({ model: model(runs) }), 'review-withheld');
  assert.equal(w.severity, 'warning');
  assert.match(w.fact, /Guardrail: 0 .*unknown cause: 3;/);
});

test('withheld answered by the fallback on a prompt cut to the primary budget is an anomaly (#242)', () => {
  const runs = withheldRuns([{ withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }], { llm: fellBack });
  const w = find(diagnose({ model: model(runs) }), 'review-withheld');
  assert.equal(w.severity, 'warning');
  assert.match(w.fact, /Guardrail: 0 \(code cut, ADR-0038: 0; .*fallback answered a prompt cut to the primary's budget: 3\)/);
  assert.match(w.fact, /Answered by: anthropic \(fallback\) 3; input budget 6300 tokens/);
  assert.match(w.hypothesis, /fallback provider answered a prompt already cut/);
  // The same fallback without a budget (Anthropic primary sets none) is not capped: a guardrail.
  // Missing CI evidence withholds whatever the fallback said: it stays an ADR-0026 guardrail.
  const evidence = withheldRuns([{ withheld_from: null, evidence_state: 'missing' }, { withheld_from: null, evidence_state: 'stale' }, { withheld_from: null, evidence_state: 'missing' }], { llm: fellBack });
  const ev = find(diagnose({ model: model(evidence) }), 'review-withheld');
  assert.equal(ev.severity, 'info');
  assert.match(ev.fact, /CI evidence, ADR-0026: 3\); anomaly: 0 /);
  const unbudgeted = withheldRuns([{ withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }], { llm: fellBack, budget: null });
  assert.equal(find(diagnose({ model: model(unbudgeted) }), 'review-withheld').severity, 'info');
  // Calls without a review stage still name the responder (v1 records).
  const v1 = withheldRuns([{ withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }, { withheld_from: 'APPROVE' }], { llm: [{ provider: 'anthropic', pipeline_stage: null, fallback: true, failed: false }] });
  assert.equal(find(diagnose({ model: model(v1) }), 'review-withheld').severity, 'warning');
});

test('auto-fix blocked by design: protected/unshown targets, files withheld by budget; approved / attempt-limit runs are not attempts', () => {
  const attempt = (events) => run({ stage: 'autofix', events: [{ event: 'autofix.start', meta: { prNumber: 9 } }, ...events] });
  const budget = (hidden) => ({ event: 'autofix.prompt_budget', meta: { input_budget: 2308, shown_files: ['a.md'], hidden_files: hidden } });
  const runs = [
    attempt([budget(['docs/x.md']), { event: 'autofix.skipped', meta: { reason: 'guardrail_rejected', rules: ['protected_path'] } }]),
    attempt([budget(['CHANGELOG.md']), { event: 'autofix.skipped', meta: { reason: 'no_changes' } }]),
    attempt([budget(['CHANGELOG.md']), { event: 'autofix.skipped', meta: { reason: 'no_changes' } }]),
    attempt([{ event: 'autofix.skipped', meta: { reason: 'guardrail_rejected', rules: ['unshown_file', 'withheld_file'] } }]),
    // As auto_fix_pr.mjs emits them: an approved head or the attempt limit exits before autofix.start.
    run({ stage: 'autofix', events: [{ event: 'autofix.skipped', meta: { reason: 'approved' } }] }),
    run({ stage: 'autofix', events: [{ event: 'autofix.max_attempts_reached' }] }),
  ];
  const f = find(diagnose({ model: model(runs) }), 'autofix-ineffective');
  assert.equal(f.severity, 'info');
  assert.match(f.title, /by design \(ADR-0021, ADR-0029\)/);
  assert.match(f.fact, /^0 delivered push\(es\) for 4 attempt\(s\)/);
  assert.match(f.fact, /Blocked by design: 4 \(protected or unshown target 2, files withheld by budget 2\); anomaly: 0\.$/);
  assert.match(f.hypothesis, /worked as designed/);
  assert.equal(f.frequency, '4 of 4 attempt(s)', 'the volume is not hidden');
  assert.equal(f.runs.length, 4, 'runs without autofix.start are not attempts');
  assert.match(f.fact, /skip reasons: guardrail_rejected 2, no_changes 2\./, 'skips of non-attempts are not listed');
  assert.equal(f.evidence.length, 4);
});

test('auto-fix anomaly: no_changes with every file shown, or a rule outside the design set, is a warning', () => {
  const attempt = (events) => run({ stage: 'autofix', events: [{ event: 'autofix.start', meta: { prNumber: 9 } }, ...events] });
  const runs = [
    attempt([{ event: 'autofix.prompt_budget', meta: { hidden_files: [] } }, { event: 'autofix.skipped', meta: { reason: 'no_changes' } }]),
    attempt([{ event: 'autofix.skipped', meta: { reason: 'guardrail_rejected', rules: ['protected_path', 'mass_deletion'] } }]),
    attempt([{ event: 'autofix.skipped', meta: { reason: 'guardrail_rejected', rules: ['protected_path'] } }]),
  ];
  const f = find(diagnose({ model: model(runs) }), 'autofix-ineffective');
  assert.equal(f.severity, 'warning');
  assert.equal(f.title, 'Auto-fix rarely pushes a fix');
  assert.match(f.fact, /Blocked by design: 1 \(protected or unshown target 1\); anomaly: 2\.$/);
  assert.match(f.hypothesis, /does not prove a fix was needed/);
  // One anomaly in three attempts (33 %) is under autofixNoPushShare: info, the card stays.
  const mostly = [runs[0], runs[2], attempt([{ event: 'autofix.skipped', meta: { reason: 'guardrail_rejected', rules: ['unshown_file'] } }])];
  assert.equal(find(diagnose({ model: model(mostly) }), 'autofix-ineffective').severity, 'info');
});

// Lifecycle: active / resolved over the last RULES.activeWindow eligible runs of a rule.
const cutRun = (i, v = 'WITHHELD', cut = true) => run({ t: T + i * 60000, sha: String(i % 10).repeat(39) + String.fromCharCode(97 + (i % 26)), events: [
  ...(cut ? [{ event: 'review.prompt_truncated', meta: { diff_truncated: true, unreviewed_code_files: 3, prNumber: 9 } }] : []),
  verdict(v, v === 'WITHHELD' ? { withheld_from: 'APPROVE', unreviewed_code_files: 3 } : {}),
] });
const cutThenClean = (cutN, cleanN) => [...Array.from({ length: cutN }, (_, i) => cutRun(i)), ...Array.from({ length: cleanN }, (_, i) => cutRun(cutN + i, 'APPROVE', false))];

test('lifecycle: a rule with an occurrence in its last N eligible runs stays active, with first_seen and last_seen', () => {
  const runs = cutThenClean(8, 2);
  const c = find(diagnose({ model: model(runs) }), 'review-coverage');
  assert.equal(RULES.activeWindow, 10);
  assert.equal(c.status, 'active');
  assert.equal(c.clean_since, null);
  assert.equal(c.first_seen, T);
  assert.equal(c.last_seen, T + 7 * 60000);
  assert.equal(c.title, 'Review diffs are cut by design (ADR-0038)', 'cut + WITHHELD only: guardrail, not an anomaly');
  assert.equal(c.severity, 'info');
});

test('lifecycle: no occurrence in the last N eligible runs resolves the finding; history stays in fact and evidence', () => {
  const runs = cutThenClean(30, 10);
  const d = diagnose({ model: model(runs) });
  const c = find(d, 'review-coverage');
  assert.equal(c.status, 'resolved');
  assert.equal(c.severity, 'info');
  assert.equal(c.title, 'Review diffs are cut — resolved since 2026-10-20');
  assert.equal(c.clean_since, T + 30 * 60000, 'the first run after the last occurrence');
  assert.equal(c.last_seen, T + 29 * 60000);
  assert.match(c.fact, /^30 of 40 reviews saw a truncated diff/);
  assert.equal(c.runs.length, 30);
  assert.ok(c.evidence.length > 0);
  assert.equal(d.status, 'ok', 'a resolved finding does not raise the status');
});

test('lifecycle: an occurrence after a clean streak makes the finding active again; first_seen stays', () => {
  const runs = [...cutThenClean(30, 10), cutRun(40), cutRun(41)];
  const c = find(diagnose({ model: model(runs) }), 'review-coverage');
  assert.equal(c.status, 'active');
  assert.equal(c.first_seen, T);
  assert.equal(c.last_seen, T + 41 * 60000);
  assert.equal(c.clean_since, null);
  assert.doesNotMatch(c.title, /resolved/);
});

test('lifecycle: a window shorter than N judges the runs it has', () => {
  // 6 eligible runs < N: every occurrence is within the "last N", so a clean tail does not resolve it yet.
  const c = find(diagnose({ model: model(cutThenClean(3, 3)) }), 'review-coverage');
  assert.equal(c.status, 'active');
  assert.equal(c.last_seen, T + 2 * 60000);
  assert.equal(c.first_seen, T);
});

test('review-coverage: APPROVE on a cut diff is critical; REQUEST_CHANGES is an anomaly; resolved once clean', () => {
  const approve = find(diagnose({ model: model([cutRun(0), cutRun(1), cutRun(2, 'APPROVE')]) }), 'review-coverage');
  assert.equal(approve.severity, 'critical');
  assert.equal(approve.status, 'active');
  assert.match(approve.fact, /Guardrail \(WITHHELD, ADR-0038\): 2; anomaly: 1 \(APPROVE on a cut diff, impossible since ADR-0038: 1/);
  const rc = find(diagnose({ model: model([cutRun(0), cutRun(1), cutRun(2, 'REQUEST_CHANGES')]) }), 'review-coverage');
  assert.equal(rc.severity, 'warning');
  assert.equal(rc.title, 'Review diffs are cut');
  const old = find(diagnose({ model: model([cutRun(0, 'APPROVE'), ...Array.from({ length: 30 }, (_, i) => cutRun(1 + i)), ...Array.from({ length: 10 }, (_, i) => cutRun(31 + i, 'APPROVE', false))]) }), 'review-coverage');
  assert.equal(old.status, 'resolved', 'an old impossible APPROVE does not stay critical');
  assert.equal(old.severity, 'info');
});

test('review-duplicates: after WITHHELD or a manual re-run is by design; two runs claiming one head is the anomaly', () => {
  const sha = 'd'.repeat(40);
  const at = (i, v, extra = {}) => ({ ...run({ t: T + i * 1000, sha, events: [verdict(v)] }), ...extra });
  const guardrail = find(diagnose({ model: model([at(0, 'WITHHELD'), at(1, 'WITHHELD')]) }), 'review-duplicates');
  assert.equal(guardrail.severity, 'info');
  assert.equal(guardrail.title, 'Same PR head reviewed again by design (ADR-0028)');
  assert.match(guardrail.fact, /Guardrail: 1 \(after a WITHHELD verdict, ADR-0028: 1; manual re-run: 0\); anomaly: 0/);
  const after = find(diagnose({ model: model([at(0, 'WITHHELD'), at(1, 'APPROVE')]) }), 'review-duplicates');
  assert.equal(after.severity, 'info', 'WITHHELD never deduplicates');
  const manual = find(diagnose({ model: model([at(0, 'APPROVE'), at(1, 'APPROVE', { run_id: '77-2' })]) }), 'review-duplicates');
  assert.equal(manual.severity, 'info', 'run attempt 2 bypasses the marker');
  const race = find(diagnose({ model: model([at(0, 'APPROVE', { event_name: 'push' }), at(1, 'APPROVE')]) }), 'review-duplicates');
  assert.equal(race.severity, 'warning');
  assert.equal(race.title, 'Same PR head reviewed more than once');
  assert.match(race.fact, /anomaly: 1 \(two runs on one head, none skipped by the marker\)/);
  assert.match(race.hypothesis, /push and the pull_request trigger/);
});

test('review-duplicates: resolved once later reviews, skipped by the marker, are clean', () => {
  const race = [run({ t: T, trigger: 'push', events: [verdict('APPROVE')] }), run({ t: T + 1000, events: [verdict('APPROVE')] })];
  const skipped = Array.from({ length: 10 }, (_, i) => run({ t: T + 10000 + i * 1000, sha: String(i).repeat(40), events: [{ event: 'review.skipped', meta: { reason: 'already_reviewed' } }] }));
  const f = find(diagnose({ model: model([...race, ...skipped]) }), 'review-duplicates');
  assert.equal(f.status, 'resolved');
  assert.equal(f.severity, 'info');
  assert.match(f.title, / — resolved since 2026-10-20$/);
  assert.equal(f.first_seen, T);
  assert.match(f.fact, /1 PR head\(s\) got 1 extra review run/);
});

test('lifecycle (review PR #252): old anomalies do not keep a finding a warning when the active window holds only guardrails', () => {
  const guard = (i) => cutRun(i);
  const other = (i) => run({ t: T + i * 60000, sha: String(i % 10).repeat(39) + String.fromCharCode(97 + (i % 26)), events: [verdict('WITHHELD')] });
  // 6 unknown-cause WITHHELD, then 12 cut-diff guardrails.
  const w = find(diagnose({ model: model([...Array.from({ length: 6 }, (_, i) => other(i)), ...Array.from({ length: 12 }, (_, i) => guard(6 + i))]) }), 'review-withheld');
  assert.equal(w.status, 'active');
  assert.equal(w.severity, 'info');
  assert.match(w.title, /by design \(ADR-0038\)/);
  // The same anomalies inside the window keep the warning.
  const recent = find(diagnose({ model: model([...Array.from({ length: 12 }, (_, i) => guard(i)), ...Array.from({ length: 6 }, (_, i) => other(12 + i))]) }), 'review-withheld');
  assert.equal(recent.severity, 'warning');
});

test('lifecycle (review PR #252): auto-fix with only by-design attempts in the window is info', () => {
  const attempt = (i, reason, rules) => run({ t: T + i * 1000, stage: 'autofix', events: [{ event: 'autofix.start', meta: { prNumber: 9 } }, { event: 'autofix.skipped', meta: { reason, rules } }] });
  const anomalous = (i) => attempt(i, 'no_changes');
  const designed = (i) => attempt(i, 'guardrail_rejected', ['protected_path']);
  const f = find(diagnose({ model: model([...Array.from({ length: 6 }, (_, i) => anomalous(i)), ...Array.from({ length: 12 }, (_, i) => designed(6 + i))]) }), 'autofix-ineffective');
  assert.equal(f.status, 'active');
  assert.equal(f.severity, 'info');
  assert.equal(f.title, 'Auto-fix blocked by design (ADR-0021, ADR-0029)');
  const recent = find(diagnose({ model: model([...Array.from({ length: 12 }, (_, i) => designed(i)), ...Array.from({ length: 12 }, (_, i) => anomalous(12 + i))]) }), 'autofix-ineffective');
  assert.equal(recent.severity, 'warning');
});

test('lifecycle (review PR #252): provider findings resolve only on runs that attempted an LLM call', () => {
  const fb = (i) => run({ t: T + i * 1000, llm: [{ provider: 'groq', failed: false }], events: [{ event: 'llm_fallback', meta: { from: 'groq', to: 'anthropic', error_type: 'RATE_LIMIT', status: 429 } }] });
  const idle = (i) => run({ t: T + i * 1000, sha: String(i).padStart(40, '0'), events: [{ event: 'review.skipped', meta: { reason: 'already_reviewed' } }] });
  const skipped = find(diagnose({ model: model([fb(0), fb(1), ...Array.from({ length: 12 }, (_, i) => idle(2 + i))]) }), 'llm-fallbacks');
  assert.equal(skipped.status, 'active', 'no provider attempt since: nothing shows recovery');
  const ok = (i) => run({ t: T + i * 1000, llm: [{ provider: 'groq', failed: false }], events: [verdict('APPROVE')] });
  const recovered = find(diagnose({ model: model([fb(0), fb(1), ...Array.from({ length: 10 }, (_, i) => ok(2 + i))]) }), 'llm-fallbacks');
  assert.equal(recovered.status, 'resolved');
});

test('review-duplicates (review PR #252): a WITHHELD emitted after the later run started does not excuse it', () => {
  const sha = 'e'.repeat(40);
  const first = run({ t: T, sha, trigger: 'push', events: [{ ...verdict('WITHHELD'), ts: T + 5000 }] });
  const lateStart = { ...run({ t: T + 1000, sha, events: [{ ...verdict('APPROVE'), ts: T + 9000 }] }) };
  const raced = find(diagnose({ model: model([first, lateStart]) }), 'review-duplicates');
  assert.equal(raced.severity, 'warning', 'started before the WITHHELD existed: still the race');
  const after = { ...run({ t: T + 6000, sha, events: [{ ...verdict('APPROVE'), ts: T + 9000 }] }) };
  assert.equal(find(diagnose({ model: model([first, after]) }), 'review-duplicates').severity, 'info');
});

test('a finding is computed over the whole window: it leaves the list once its historical share falls under the threshold', () => {
  assert.ok(find(diagnose({ model: model(cutThenClean(30, 10)) }), 'review-coverage'), '30 of 40 cut');
  assert.equal(find(diagnose({ model: model(cutThenClean(30, 40)) }), 'review-coverage'), undefined, '30 of 70 cut: below truncatedShare, no card');
});

test('lifecycle (review PR #252): rate-rule severity follows the active window, promoting recent anomalies', () => {
  const attempt = (i, reason, rules) => run({ t: T + i * 1000, stage: 'autofix', events: [{ event: 'autofix.start', meta: { prNumber: 9 } }, { event: 'autofix.skipped', meta: { reason, rules } }] });
  const designed = (i) => attempt(i, 'guardrail_rejected', ['protected_path']);
  // 100 attempts blocked by design, then 5 anomalies: 5 of the last 10 attempts, whatever the 5/105 history says.
  const runs = [...Array.from({ length: 100 }, (_, i) => designed(i)), ...Array.from({ length: 5 }, (_, i) => attempt(100 + i, 'no_changes'))];
  const f = find(diagnose({ model: model(runs) }), 'autofix-ineffective');
  assert.equal(f.status, 'active');
  assert.equal(f.severity, 'warning');
  assert.equal(f.title, 'Auto-fix rarely pushes a fix');
  // The same on the withheld rule: 12 cut-diff guardrails, then 4 unknown-cause WITHHELD (4 of the last 10).
  const guard = (i) => cutRun(i);
  const other = (i) => run({ t: T + i * 60000, sha: String(i % 10).repeat(39) + String.fromCharCode(97 + (i % 26)), events: [verdict('WITHHELD')] });
  const w = find(diagnose({ model: model([...Array.from({ length: 40 }, (_, i) => guard(i)), ...Array.from({ length: 4 }, (_, i) => other(40 + i))]) }), 'review-withheld');
  assert.equal(w.severity, 'warning');
  assert.equal(w.title, 'Reviews withhold their verdict');
});
