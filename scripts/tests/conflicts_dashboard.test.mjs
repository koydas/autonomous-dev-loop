// Dashboard side of conflicts-fix (ADR-0059): the journey step, the "Waiting on you" explanation, the Diagnostics
// finding with its lever, the cost mapping and the flow card, which draws the optional step only when it ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepDecision, workItemJourney, STEPS, escalations } from '../lib/pipeline_journey.mjs';
import { explainEscalation, CONFLICT_DESIGN_REASONS } from '../lib/pipeline_waiting.mjs';
import { diagnose, RULES } from '../lib/pipeline_diagnostics.mjs';
import { leverFor, LEVERS } from '../lib/meta_levers.mjs';
import { pipelineStage } from '../lib/llm_cost.mjs';
import { flowDashboard } from '../lib/flow_dashboard.mjs';
import { CONFLICT_ESCALATION_REASONS } from '../lib/conflicts.mjs';

let n = 0;
const T = Date.parse('2026-10-25T10:00:00Z');
const run = ({ stage = 'conflicts', outcome = 'success', t = T, events = [], pr = 9, runOutcome = 'success' } = {}) => ({
  run_id: `c${++n}-1`, workflow: 'Conflicts Fix', event_name: 'push', started_at: t, completed_at: t + 1000, duration_ms: 1000, outcome: runOutcome, pr_number: pr, llm: [],
  stages: [{ stage, outcome, duration_ms: 900, meta: {} }], events: events.map((e) => ({ stage, level: 'info', ts: t + 500, meta: {}, ...e })),
  events_overflow: { count: 0 }, spans_overflow: { count: 0, events: 0 },
});
const ev = (event, meta = {}, extra = {}) => ({ event, meta, ...extra });
const decision = (events) => stepDecision(run({ events }), 'conflicts');
const traceOf = (runs) => ({ trace_id: 'a'.repeat(32), item: { kind: 'pr', number: 9 }, runs: runs.map((r) => ({ run: r, run_id: r.run_id, started_at: r.started_at, completed_at: r.completed_at })), running_ms: 1, waiting_ms: 1, runs_overflow: 0 });

test('the conflicts step is last, optional, and decided by its journal events', () => {
  assert.deepEqual(STEPS.at(-1), { key: 'conflicts', name: 'Conflicts fix', issueOnly: false, optional: true });
  assert.equal(STEPS.filter((s) => s.optional).length, 1, 'the other steps always show');
  assert.deepEqual(decision([ev('conflicts.resolved', { rung: 'L2', hunks: 2, renumbered: 1, url: 'https://github.com/c/1' })]),
    { key: 'resolved', label: 'Conflicts resolved', tone: 'good', reason: 'rung L2, 2 hunk(s) by the model, 1 ADR renumbered', url: 'https://github.com/c/1' });
  assert.equal(decision([ev('conflicts.resolved')]).reason, null);
  assert.deepEqual(decision([ev('conflicts.escalated', { reason: 'protected_path' })]), { key: 'escalated', label: 'Escalated to a human', tone: 'warn', reason: 'protected path', url: null });
  assert.equal(decision([ev('conflicts.error', { error: 'x' })]).tone, 'bad');
  assert.equal(decision([ev('conflicts.skipped', { reason: 'attempts_exhausted' })]).tone, 'warn');
  assert.equal(decision([ev('conflicts.skipped', { reason: 'circuit_open' })]).tone, 'warn');
  assert.deepEqual([decision([ev('conflicts.skipped', { reason: 'up_to_date' })]).tone, decision([ev('conflicts.skipped', { reason: 'up_to_date' })]).reason], ['neutral', 'up to date']);
  assert.equal(decision([ev('conflicts.skipped')]).key, 'skipped');
  assert.equal(decision([ev('conflicts.start')]), null, 'a start without a decision is not a decision');
  assert.equal(decision([ev('conflicts.resolved'), ev('conflicts.skipped', { reason: 'clean' })]).key, 'clean', 'the last decision of a run wins');
});

test('a conflicts-fix escalation is an escalation of the item, and a later merge settles it', () => {
  const escalated = run({ t: T, outcome: 'success', events: [ev('conflicts.escalated', { reason: 'model_rejected', prNumber: 9, labels_added: ['conflict-fix-attempt-1', 'needs-human'] })] });
  assert.equal(escalations(escalated).length, 1);
  const alone = workItemJourney(traceOf([escalated]));
  assert.equal(alone.state, 'escalated');
  assert.equal(alone.attention, true);
  const resolved = run({ t: T + 3600_000, events: [ev('conflicts.resolved', { rung: 'L0', prNumber: 9 })] });
  const settled = workItemJourney(traceOf([escalated, resolved]));
  assert.equal(settled.state, 'in_progress', 'the merge commit settles the escalation; the review that follows decides');
  const step = settled.steps.find((s) => s.key === 'conflicts');
  assert.equal(step.attempts.length, 2);
  assert.equal(step.recovered, true);
  const earlierResolved = workItemJourney(traceOf([run({ t: T, events: [ev('conflicts.resolved')] }), run({ t: T + 3600_000, events: [ev('conflicts.escalated', { reason: 'protected_path' })] })]));
  assert.equal(earlierResolved.state, 'escalated', 'an escalation after the merge stands');
});

test('an item that never conflicted says so, not "Not recorded"', () => {
  const review = run({ stage: 'review', events: [ev('review.verdict', { verdict: 'APPROVE' }, { stage: 'review' })] });
  const j = workItemJourney(traceOf([review]));
  assert.equal(j.steps.find((s) => s.key === 'conflicts').note, 'Not triggered: no merge conflict recorded');
});

test('explainEscalation: structural limits are by design, the stage\'s own failures are not, an unknown reason is unknown', () => {
  const explain = (reason) => explainEscalation({ event: 'conflicts.escalated', stage: 'conflicts', ts: T + 500 }, run({ events: [ev('conflicts.escalated', { reason })] }));
  for (const reason of CONFLICT_ESCALATION_REASONS.filter((r) => !['attempts_exhausted', 'circuit_open', 'fork_not_writable'].includes(r))) {
    const e = explain(reason);
    assert.equal(e.by_design, CONFLICT_DESIGN_REASONS.has(reason), reason);
    assert.match(e.reason, /^Merge conflicts not resolved by the pipeline: /, reason);
    assert.deepEqual(e.files, [], 'the record names no file');
  }
  assert.equal(explain('protected_path').kind, 'conflicts_protected_path');
  assert.deepEqual([explain('made_up').kind, explain('made_up').by_design], ['unknown', false]);
  assert.equal(explain(undefined).by_design, false);
  const errored = explainEscalation({ event: 'conflicts.escalated', stage: 'conflicts', ts: T }, run({ events: [ev('conflicts.error', {}, { level: 'error' }), ev('conflicts.escalated', { reason: 'protected_path' })] }));
  assert.deepEqual([errored.kind, errored.by_design], ['error', false], 'an error of the stage before the escalation is not a guardrail');
});

const attempt = (reason, pr = 9) => run({ pr, events: [ev('conflicts.start', { prNumber: pr, attempt: 1 }), ...(reason ? [ev('conflicts.escalated', { prNumber: pr, reason })] : [ev('conflicts.resolved', { prNumber: pr, rung: 'L2' })])] });
const model = (runs) => ({ runs, traces: [], tracesById: new Map(), months: ['2026-10'], skippedMonths: [], warnings: [] });
const find = (d, id) => d.findings.find((f) => f.id === id);

test('Diagnostics: conflicts-fix that rarely merges; by design is info, its own failures are a warning', () => {
  const byDesign = find(diagnose({ model: model([attempt('protected_path'), attempt('binary_file'), attempt(null)]) }), 'conflicts-unresolved');
  assert.equal(byDesign.severity, 'info');
  assert.match(byDesign.title, /left to a human by design/);
  assert.match(byDesign.fact, /1 conflict\(s\) merged for 3 attempt\(s\); reasons for the others: protected_path 1, binary_file 1\. Explained by a structural limit: 2; the stage's own: 0\./);
  assert.match(byDesign.hypothesis, /limits worked as designed/);
  const own = find(diagnose({ model: model([attempt('model_rejected'), attempt('guard_rejected'), attempt(null)]) }), 'conflicts-unresolved');
  assert.equal(own.severity, 'warning');
  assert.equal(own.title, 'Conflicts-fix rarely resolves a conflict');
  assert.match(own.hypothesis, /conflicts_max_input_tokens/);
  assert.deepEqual(own.items, [9]);
  assert.match(find(diagnose({ model: model([run({ events: [ev('conflicts.start', { attempt: 1 })] }), run({ events: [ev('conflicts.start', { attempt: 1 }), ev('conflicts.escalated', {})] })]) }), 'conflicts-unresolved').fact, /unspecified 2/);
});

test('Diagnostics: no finding when most conflicts merged, with one attempt, or for a start the script did not number', () => {
  const ids = (runs) => diagnose({ model: model(runs) }).findings.map((f) => f.id);
  assert.ok(!ids([attempt(null), attempt(null), attempt('model_rejected')]).includes('conflicts-unresolved'), 'most merged');
  assert.ok(!ids([attempt('model_rejected')]).includes('conflicts-unresolved'), `one attempt is not judged (floor ${RULES.conflictsMinAttempts})`);
  assert.ok(!ids([run({ events: [ev('conflicts.start', { attempt: null })] }), run({ events: [ev('conflicts.start', { attempt: null })] })]).includes('conflicts-unresolved'));
});

test('the finding has a lever whose targets are the stage\'s own knobs, and the llm cost maps the stage', () => {
  assert.equal(LEVERS['conflicts-unresolved'].stage, 'conflicts');
  const lever = leverFor({ id: 'conflicts-unresolved', status: 'active', severity: 'warning' });
  assert.deepEqual(lever.targets.map((t) => t.ref), ['config/models.yaml#conflicts_max_input_tokens', 'AI_PROVIDER_CONFLICTS', 'prompts/conflicts-system.md']);
  assert.equal(leverFor({ id: 'conflicts-unresolved', status: 'active', severity: 'info' }), null, 'a guardrail doing its job proposes nothing');
  assert.equal(pipelineStage('conflicts'), 'conflicts');
});

test('the flow card draws the conflicts step only when it ran', () => {
  const review = run({ stage: 'review', events: [ev('review.verdict', { verdict: 'APPROVE' }, { stage: 'review' })] });
  const plain = flowDashboard({ traces: [traceOf([review])] });
  assert.ok(!plain.includes('Conflicts fix: '), 'no icon on a card that never conflicted');
  const withConflict = flowDashboard({ traces: [traceOf([review, run({ events: [ev('conflicts.resolved', { rung: 'L0' })] })])] });
  assert.ok(withConflict.includes('Conflicts fix'));
  assert.match(withConflict, /data-stage="[^"]*conflicts/);
});
