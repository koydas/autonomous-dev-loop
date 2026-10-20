import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepDecision, attemptOf, stepJourney, workItemJourney, journeys, escalations, STEPS, STATES } from '../lib/pipeline_journey.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf } from './fixtures/pipeline/records.mjs';

// A normalized run (pipeline_model.mjs shape) with one stage span and its events.
const run = (id, stage, outcome, started_at, events = [], extra = {}) => ({
  run_id: id, workflow: 'PR Review', event_name: 'pull_request', started_at, duration_ms: 1000, outcome: 'success', pr_number: null, llm: [],
  stages: stage ? [{ stage, outcome, duration_ms: 900, meta: {} }] : [], events: events.map((e) => ({ stage, level: 'info', ts: started_at, meta: {}, ...e })), ...extra,
});
const ev = (event, meta = {}) => ({ event, meta });
const trace = (runs, item = { kind: 'issue', number: 7 }) => ({ trace_id: 'a'.repeat(32), item, runs: runs.map((r) => ({ run: r, run_id: r?.run_id, started_at: r?.started_at, completed_at: r?.started_at })), runs_overflow: 0, lead_time_ms: 5000, running_ms: 3000, waiting_ms: 2000 });

test('decisions per step: every recorded decision event, its tone and reason', () => {
  const d = (stage, events) => stepDecision(run('1', stage, 'success', 1, events), stage);
  assert.deepEqual([d('issue_validation', [ev('issue_validation.pass')]).key, d('issue_validation', [ev('issue_validation.pass')]).tone], ['pass', 'good']);
  assert.deepEqual(d('issue_validation', [ev('issue_validation.fail', { score: 70, blockers_count: 3 })]), { key: 'fail', label: 'Rejected', tone: 'warn', reason: 'score 70, 3 blocker(s)', url: null });
  assert.equal(d('issue_validation', [ev('issue_validation.fail')]).reason, null);
  assert.deepEqual(d('code_gen', [ev('code_gen.complete', { changes_count: 2 })]), { key: 'generated', label: 'Patch generated', tone: 'good', reason: '2 change(s)', url: null });
  assert.equal(d('code_gen', [ev('code_gen.complete')]).reason, null);
  assert.deepEqual(d('code_gen', [ev('code_gen.skipped', { reason: 'blocked', source: 'model' })]), { key: 'blocked', label: 'Blocked', tone: 'warn', reason: 'blocked, source model', url: null });
  assert.deepEqual(d('code_gen', [ev('code_gen.skipped')]), { key: 'skipped', label: 'Skipped', tone: 'warn', reason: null, url: null });
  assert.deepEqual(d('pr_prepare', [ev('workflow.pr_operation', { operation: 'created', prNumber: 9, url: 'https://x/9' })]), { key: 'created', label: 'PR created', tone: 'good', reason: 'PR #9', url: 'https://x/9' });
  assert.deepEqual(d('pr_prepare', [ev('workflow.pr_operation')]), { key: 'operation', label: 'PR operation', tone: 'good', reason: null, url: null });
  assert.equal(d('review', [ev('review.verdict', { verdict: 'APPROVE' })]).tone, 'good');
  assert.equal(d('review', [ev('review.verdict', { verdict: 'REQUEST_CHANGES' })]).tone, 'warn');
  assert.equal(d('review', [ev('review.verdict', { verdict: 'WITHHELD', withheld_from: 'APPROVE', unreviewed_code_files: 12 })]).reason, 'approval withheld: 12 code file(s) not reviewed');
  assert.equal(d('review', [ev('review.verdict', { verdict: 'WITHHELD', withheld_from: 'APPROVE' })]).reason, 'approval withheld: ? code file(s) not reviewed');
  assert.equal(d('review', [ev('review.verdict', { verdict: 'WITHHELD', withheld_from: 'REQUEST_CHANGES' })]).reason, 'findings cite only unseen code');
  assert.equal(d('review', [ev('review.verdict', { verdict: 'WITHHELD', evidence_state: 'stale' })]).reason, 'CI evidence stale');
  assert.equal(d('review', [ev('review.verdict', { verdict: 'WITHHELD', unreviewed_code_files: 3 })]).reason, '3 code file(s) not reviewed', 'older record: no withheld_from, never an invented original verdict');
  assert.equal(d('review', [ev('review.verdict', { verdict: 'WITHHELD' })]).reason, null);
  assert.deepEqual(d('review', [ev('review.verdict', { verdict: 'MAYBE' })]), { key: 'other', label: 'Verdict not recognised', tone: 'neutral', reason: null, url: null });
  assert.deepEqual(d('review', [ev('review.skipped', { reason: 'already_reviewed' })]), { key: 'skipped', label: 'Skipped', tone: 'neutral', reason: 'already reviewed', url: null });
  assert.equal(d('autofix', [ev('autofix.push')]).tone, 'good');
  assert.deepEqual(d('autofix', [ev('autofix.error', { error_type: 'TRANSIENT' })]), { key: 'error', label: 'Error', tone: 'bad', reason: 'TRANSIENT', url: null });
  assert.equal(d('autofix', [ev('autofix.max_attempts_reached')]).key, 'max_attempts');
  assert.equal(d('autofix', [ev('autofix.skipped', { reason: 'approved' })]).tone, 'neutral');
  assert.equal(d('autofix', [ev('autofix.skipped', { reason: 'no_changes' })]).label, 'No change produced');
  assert.equal(d('autofix', [ev('autofix.skipped', { reason: 'guardrail_rejected', rules: ['protected_path'] })]).reason, 'guardrail rejected (protected_path)');
  assert.equal(d('autofix', [ev('autofix.skipped', { reason: 'other' })]).label, 'Skipped');
  assert.equal(d('autofix', [ev('autofix.skipped')]).reason, 'reason not recorded');
  // No decision event, an unknown step, and a bare event without meta.
  for (const stage of ['issue_validation', 'code_gen', 'pr_prepare', 'review', 'autofix', 'unknown']) assert.equal(d(stage, []), null, stage);
  assert.equal(stepDecision({ events: [{ event: 'review.verdict' }] }, 'review').key, 'other');
});

test('the latest decision of a run wins: a skip after a verdict, a verdict after a skip', () => {
  assert.equal(stepDecision(run('1', 'review', 'success', 1, [ev('review.verdict', { verdict: 'APPROVE' }), ev('review.skipped')]), 'review').key, 'skipped');
});

test('an attempt keeps its execution status apart from its decision; unknown outcomes are not recorded', () => {
  const withheld = attemptOf(run('1', 'review', 'success', 1, [ev('review.verdict', { verdict: 'WITHHELD' })]), 'review');
  assert.equal(withheld.status, 'success');
  assert.equal(withheld.tone, 'warn');
  assert.equal(attemptOf(run('1', 'review', 'failed', 1, [ev('review.verdict', { verdict: 'APPROVE' })]), 'review').tone, 'bad', 'a failed span is bad whatever was decided');
  assert.equal(attemptOf(run('1', 'review', 'success', 1), 'review').tone, 'good');
  assert.equal(attemptOf(run('1', 'review', 'skipped', 1), 'review').tone, 'neutral');
  for (const outcome of [undefined, null, 'running', 'partial', '__proto__']) {
    const a = attemptOf(run('1', 'review', outcome, 1), 'review');
    assert.equal(a.status, 'not-recorded', String(outcome));
    assert.equal(a.tone, 'unknown');
  }
  // Matched by an event only: no span, no duration of its own.
  const eventOnly = attemptOf({ ...run('1', null, null, 1), events: [{ stage: 'review', event: 'x', meta: {} }] }, 'review');
  assert.equal(eventOnly.status, 'not-recorded');
  assert.equal(eventOnly.duration_ms, 1000);
});

test('Review failed, failed, success: final success, two failures shown, recovered', () => {
  const runs = [run('3', 'review', 'success', 3000), run('1', 'review', 'failed', 1000), run('2', 'review', 'failed', 2000)];
  const j = stepJourney(runs, 'review');
  assert.deepEqual(j.attempts.map((a) => a.run_id), ['1', '2', '3']);
  assert.equal(j.status, 'success');
  assert.equal(j.failures, 2);
  assert.equal(j.adverse, 0);
  assert.equal(j.recovered, true);
  // Adverse decisions are counted apart from failures, and also recover.
  const adverse = stepJourney([run('1', 'review', 'success', 1, [ev('review.verdict', { verdict: 'WITHHELD' })]), run('2', 'review', 'success', 2, [ev('review.verdict', { verdict: 'APPROVE' })])], 'review');
  assert.deepEqual([adverse.failures, adverse.adverse, adverse.recovered], [0, 1, true]);
  // Ending on a failure is not a recovery; a single success is not one either.
  assert.equal(stepJourney([run('1', 'review', 'success', 1), run('2', 'review', 'failed', 2)], 'review').recovered, false);
  assert.equal(stepJourney([run('1', 'review', 'success', 1)], 'review').recovered, false);
  // No attempt: nothing invented.
  assert.deepEqual(stepJourney([], 'review'), { attempts: [], final: null, status: 'not-recorded', failures: 0, adverse: 0, recovered: false });
});

test('ordering: undated runs never become the final attempt; ties keep the earlier run in trace order', () => {
  assert.equal(stepJourney([run('1', 'review', 'failed', 1000), run('9', 'review', 'success', null)], 'review').final.run_id, '1');
  assert.equal(stepJourney([run('1', 'review', 'failed', 5), run('2', 'review', 'success', 5)], 'review').final.run_id, '1');
});

test('escalations: *.escalated, the attempt limit, and any needs-human label', () => {
  const r = run('1', 'autofix', 'success', 1, [ev('autofix.escalated', { reason: 'no_changes', url: 'https://x' }), ev('autofix.max_attempts_reached'), ev('review.labels_applied', { labels_added: ['needs-human'] }), ev('review.labels_applied', { labels_added: ['other'] }), { event: 'bare' }]);
  const list = escalations(r);
  assert.deepEqual(list.map((x) => x.event), ['autofix.escalated', 'autofix.max_attempts_reached', 'review.labels_applied']);
  assert.equal(list[0].reason, 'no changes');
  assert.equal(list[0].url, 'https://x');
  assert.equal(list[1].url, null);
});

const verdictRun = (id, t, verdict) => run(id, 'review', 'success', t, [ev('review.verdict', { verdict, prNumber: 9 })], { pr_number: 9 });

test('last recorded state of a work item, for every state', () => {
  const state = (runs, item) => workItemJourney(trace(runs, item)).state;
  assert.equal(state([]), 'no_data');
  assert.equal(state([run('1', 'issue_validation', 'failed', 1, [ev('issue_validation.fail')])]), 'rejected', 'the decision explains the failed span');
  assert.equal(state([run('1', 'review', 'failed', 1)]), 'failed');
  assert.equal(state([{ ...run('1', null, null, 1), outcome: 'failed' }]), 'failed', 'a failed run without a stage');
  assert.equal(state([verdictRun('1', 1, 'APPROVE'), run('2', 'autofix', 'success', 2, [ev('autofix.escalated')])]), 'escalated');
  assert.equal(state([run('1', 'autofix', 'success', 1, [ev('autofix.escalated')]), verdictRun('2', 2, 'APPROVE')]), 'approved', 'an approval after the escalation settles it');
  assert.equal(state([verdictRun('1', 1, 'WITHHELD')]), 'withheld');
  assert.equal(state([verdictRun('1', 1, 'REQUEST_CHANGES')]), 'changes_requested');
  assert.equal(state([verdictRun('1', 1, 'WITHHELD'), verdictRun('2', 2, 'APPROVE'), run('3', 'review', 'success', 3, [ev('review.skipped')])]), 'approved', 'a later skip is not a decision');
  assert.equal(state([verdictRun('1', 1, 'MAYBE')]), 'in_progress');
  assert.equal(state([run('1', 'issue_validation', 'success', 1, [ev('issue_validation.pass')])]), 'in_progress');
  // A failed attempt later succeeded in the same step is not a failed item.
  assert.equal(state([run('1', 'review', 'failed', 1), verdictRun('2', 2, 'APPROVE')]), 'approved');
  for (const s of Object.values(STATES)) assert.ok(['good', 'bad', 'warn', 'neutral', 'unknown'].includes(s.tone));
});

test('work item: conditional steps, PR numbers, interventions, providers, missing runs', () => {
  const pr = workItemJourney(trace([verdictRun('1', 1, 'APPROVE')], { kind: 'pr', number: 9 }));
  assert.deepEqual(pr.steps.map((s) => s.key), STEPS.map((s) => s.key));
  assert.equal(pr.steps[0].note, 'No linked issue: not part of this flow');
  assert.equal(pr.steps[3].note, null);
  assert.equal(pr.steps[4].note, 'Not triggered: no REQUEST_CHANGES verdict recorded');
  assert.deepEqual(pr.prs, [9]);
  assert.equal(pr.issue, null);
  const issue = workItemJourney(trace([verdictRun('1', 1, 'REQUEST_CHANGES'), { ...run('2', 'autofix', 'success', 2, [ev('autofix.escalated')]), llm: [{ provider: 'groq', fallback: true }, { provider: 'anthropic' }] }, null]));
  assert.equal(issue.steps[0].note, 'Not recorded');
  assert.equal(issue.steps[4].note, null);
  assert.equal(issue.issue, 7);
  assert.equal(issue.state, 'escalated');
  assert.equal(issue.attention, true);
  assert.deepEqual(issue.problem_steps, ['review', 'autofix']);
  assert.deepEqual(issue.providers, ['anthropic', 'groq']);
  assert.equal(issue.fallbacks, 1);
  assert.equal(issue.missing_runs, 1);
  assert.equal(issue.last_activity, 2);
  // The PR item's own number is kept even when no run recorded it.
  assert.deepEqual(workItemJourney(trace([], { kind: 'pr', number: 5 })).prs, [5]);
  assert.equal(workItemJourney({ trace_id: 'x', item: null, runs: [] }).last_activity, null);
});

test('journeys of a real model: newest activity first, through the production redaction path', () => {
  const T = Date.parse('2026-10-16T10:00:00Z');
  const records = [
    makeRecord({ runId: '600', start: T, prNumber: 30, events: [{ event: 'review.verdict', meta: { verdict: 'WITHHELD', prNumber: 30 } }] }),
    makeRecord({ runId: '601', start: T + 60000, prNumber: 31, events: [{ event: 'review.verdict', meta: { verdict: 'APPROVE', prNumber: 31 } }] }),
  ];
  const model = buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });
  const list = journeys(model);
  assert.deepEqual(list.map((j) => [j.item.number, j.state]), [[31, 'approved'], [30, 'withheld']]);
  assert.deepEqual(journeys(null), []);
});

test('a validation that threw is an execution failure, not a rejection of the issue (PR #242 review)', () => {
  const errored = run('1', 'issue_validation', 'failed', 1, [{ event: 'issue_validation.fail', level: 'error', meta: { error: 'Groq API HTTP error 503', issueNumber: 7 } }], { outcome: 'failed' });
  assert.deepEqual(stepDecision(errored, 'issue_validation'), { key: 'error', label: 'Validation error', tone: 'bad', reason: 'no verdict: the validation did not complete', url: null });
  assert.equal(workItemJourney(trace([errored])).state, 'failed');
  // Without a span (the run died before closing it) the error still fails the item.
  const noSpan = { ...errored, stages: [] };
  assert.equal(workItemJourney(trace([noSpan])).state, 'failed');
  // An error event recorded at warn level but without a score is still no verdict.
  assert.equal(stepDecision(run('2', 'issue_validation', 'failed', 1, [{ event: 'issue_validation.fail', meta: { error: 'x' } }]), 'issue_validation').key, 'error');
  // A real rejection keeps its state.
  assert.equal(workItemJourney(trace([run('3', 'issue_validation', 'failed', 1, [{ event: 'issue_validation.fail', level: 'warn', meta: { score: 40, blockers_count: 2 } }])])).state, 'rejected');
});

test('a failed run superseded by a later success of the same step does not fail the item (PR #242 review)', () => {
  const failedReview = { ...run('1', 'review', 'failed', 1000), outcome: 'failed', pr_number: 9 };
  const j = workItemJourney(trace([failedReview, verdictRun('2', 2000, 'APPROVE')], { kind: 'pr', number: 9 }));
  assert.equal(j.state, 'approved');
  assert.equal(j.attention, false);
  assert.deepEqual(j.recovered_steps, ['review']);
  // The failed run is still the final attempt: the item stays failed.
  assert.equal(workItemJourney(trace([verdictRun('1', 1000, 'APPROVE'), { ...run('2', 'review', 'not-a-status', 2000), outcome: 'failed' }], { kind: 'pr', number: 9 })).state, 'failed');
  // A failed run that attempted no step fails the item.
  assert.equal(workItemJourney(trace([verdictRun('1', 1000, 'APPROVE'), { ...run('2', null, null, 2000), outcome: 'failed' }], { kind: 'pr', number: 9 })).state, 'failed');
});

test('PR preparation rejected or failed, and an auto-fix whose git push failed, are not progress (PR #242 review)', () => {
  const rejected = run('1', 'pr_prepare', 'skipped', 1, [{ event: 'pr_prepare.skipped', level: 'warn', meta: { reason: 'guardrail_rejected', rules: ['protected_path'] } }]);
  assert.deepEqual(stepDecision(rejected, 'pr_prepare'), { key: 'guardrail_rejected', label: 'Rejected by guardrail', tone: 'warn', reason: 'guardrail rejected (protected_path)', url: null });
  assert.equal(attemptOf(rejected, 'pr_prepare').tone, 'warn');
  assert.equal(stepDecision(run('2', 'pr_prepare', 'skipped', 1, [{ event: 'pr_prepare.skipped' }]), 'pr_prepare').label, 'Skipped');
  assert.equal(stepDecision(run('2', 'pr_prepare', 'skipped', 1, [{ event: 'pr_prepare.skipped' }]), 'pr_prepare').reason, 'reason not recorded');
  assert.deepEqual(stepDecision(run('3', 'pr_prepare', 'failed', 1, [{ event: 'pr_prepare.error', level: 'error', meta: { error: 'x' } }]), 'pr_prepare'), { key: 'error', label: 'Error', tone: 'bad', reason: null, url: null });
  const j = workItemJourney(trace([{ ...rejected, stages: [{ stage: 'code_gen', outcome: 'success' }, { stage: 'pr_prepare', outcome: 'skipped' }], events: [...rejected.events, { event: 'code_gen.complete', stage: 'code_gen', meta: {} }] }]));
  assert.ok(j.problem_steps.includes('pr_prepare'));
  // Auto-fix: files written (autofix.push) but the workflow's git push failed.
  const failedPush = run('4', 'autofix', 'success', 1, [{ event: 'autofix.push' }, { event: 'workflow.push', stage: 'workflow', meta: { outcome: 'failure' } }]);
  assert.deepEqual(stepDecision(failedPush, 'autofix'), { key: 'push_failed', label: 'Push failed', tone: 'bad', reason: 'the fix was written but the git push step failed', url: null });
  assert.equal(workItemJourney(trace([failedPush])).state, 'failed');
  assert.equal(stepDecision(run('5', 'autofix', 'success', 1, [{ event: 'autofix.push' }, { event: 'workflow.push', stage: 'workflow', meta: { outcome: 'success' } }]), 'autofix').key, 'pushed');
});

test('a later APPROVE supersedes an earlier failure of another step (PR #242 review)', () => {
  const failedPush = { ...run('1', 'autofix', 'success', 1000, [{ event: 'autofix.push' }, { event: 'workflow.push', stage: 'workflow', meta: { outcome: 'failure' } }]), pr_number: 9 };
  assert.equal(workItemJourney(trace([failedPush, verdictRun('2', 2000, 'APPROVE')], { kind: 'pr', number: 9 })).state, 'approved');
  // An approval before the failure does not clear it.
  assert.equal(workItemJourney(trace([verdictRun('1', 500, 'APPROVE'), { ...failedPush, run_id: '3', started_at: 1000 }], { kind: 'pr', number: 9 })).state, 'failed');
  // Same for a failed run without a step.
  assert.equal(workItemJourney(trace([{ ...run('4', null, null, 1000), outcome: 'failed' }, verdictRun('5', 2000, 'APPROVE')], { kind: 'pr', number: 9 })).state, 'approved');
});

test('overlapping attempts are ordered by their terminal event, not by start (PR #242 review)', () => {
  // Duplicate triggers: run 1 starts first but records APPROVE last; run 2 starts later and finishes first.
  const approve = { ...run('1', 'review', 'success', 1000, [{ event: 'review.verdict', ts: 5000, meta: { verdict: 'APPROVE' } }]), pr_number: 9 };
  const changes = { ...run('2', 'review', 'success', 2000, [{ event: 'review.verdict', ts: 3000, meta: { verdict: 'REQUEST_CHANGES' } }]), pr_number: 9 };
  const j = stepJourney([approve, changes], 'review');
  assert.deepEqual(j.attempts.map((a) => a.run_id), ['2', '1']);
  assert.equal(j.final.decision.key, 'APPROVE');
  assert.equal(j.final.ended_at, 5000);
  assert.equal(workItemJourney(trace([approve, changes], { kind: 'pr', number: 9 })).state, 'approved');
  // An approval that ended before a failure that started earlier but ended later does not clear it.
  const failedPush = { ...run('3', 'autofix', 'success', 1500, [{ event: 'autofix.push', ts: 6000 }, { event: 'workflow.push', stage: 'workflow', ts: 6000, meta: { outcome: 'failure' } }]), pr_number: 9 };
  assert.equal(workItemJourney(trace([approve, failedPush], { kind: 'pr', number: 9 })).state, 'failed');
  // Without a step event, the run's completion, then its start, is the end.
  assert.equal(attemptOf({ ...run('4', 'review', 'success', 100), completed_at: 900 }, 'review').ended_at, 900);
  assert.equal(attemptOf(run('5', 'review', 'success', 100), 'review').ended_at, 100);
  assert.equal(attemptOf(run('6', 'review', 'success', undefined), 'review').ended_at, null);
});
