// Journey of a work item through the canonical pipeline (dashboard Pipelines view, ADR-0043): every
// attempt of every step, its execution status (the stage span outcome) next to its decision (the journal
// event that records what the step decided), so a failed or adverse attempt is never hidden behind the
// latest one. Pure: the trace of pipeline_model.mjs in, plain data out. Merge is not journaled by any
// workflow: it is never inferred here (the browser asks GitHub for merged_at).

import { safeUrl } from './pipeline_model.mjs';

export const STEPS = Object.freeze([
  Object.freeze({ key: 'issue_validation', name: 'Validation', issueOnly: true }),
  Object.freeze({ key: 'code_gen', name: 'Code generation', issueOnly: true }),
  Object.freeze({ key: 'pr_prepare', name: 'PR preparation', issueOnly: true }),
  Object.freeze({ key: 'review', name: 'Review', issueOnly: false }),
  Object.freeze({ key: 'autofix', name: 'Auto-fix', issueOnly: false }),
]);

// Span outcomes a step can show; anything else (missing, unknown) is not recorded, never success. A record
// is written when its run completes, so a running step is not observable.
export const EXECUTION_STATUSES = Object.freeze(['success', 'failed', 'skipped']);

// Last recorded state of a work item: key → label, tone, and whether a person has to act on it.
export const STATES = Object.freeze({
  failed: { label: 'Execution failed', tone: 'bad', attention: true },
  escalated: { label: 'Escalated to a human', tone: 'warn', attention: true },
  withheld: { label: 'Approval withheld', tone: 'warn', attention: true },
  rejected: { label: 'Issue rejected by validation', tone: 'warn', attention: true },
  changes_requested: { label: 'Changes requested', tone: 'warn', attention: false },
  approved: { label: 'Approved by review', tone: 'good', attention: false },
  in_progress: { label: 'No decision recorded yet', tone: 'neutral', attention: false },
  no_data: { label: 'No run record loaded', tone: 'unknown', attention: false },
});

const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
// Decision events always carry meta in a normalized record; a bare one (hand-built) reads as empty.
const last = (run, names) => { const e = run.events.filter((x) => names.includes(x.event)).at(-1); return e ? { ...e, meta: e.meta ?? {} } : null; };
const reasonText = (v) => (typeof v === 'string' && v ? v.replace(/_/g, ' ') : null);

// WITHHELD cause, as pipeline_health.mjs classifies it (kept short for a step label).
function withheldReason(meta) {
  if (meta.withheld_from === 'APPROVE') return `approval withheld: ${meta.unreviewed_code_files ?? '?'} code file(s) not reviewed`;
  if (meta.withheld_from === 'REQUEST_CHANGES') return 'findings cite only unseen code';
  if (meta.evidence_state === 'missing' || meta.evidence_state === 'stale') return `CI evidence ${meta.evidence_state}`;
  if (typeof meta.unreviewed_code_files === 'number' && meta.unreviewed_code_files > 0) return `${meta.unreviewed_code_files} code file(s) not reviewed`;
  return null;
}

/**
 * What one run decided for one step, from its journal: `{ key, label, tone, reason, url }` or null when no
 * decision event is recorded. tone: good (the step moved the item forward), warn (an adverse decision:
 * the step completed but did not move it forward), bad (an error), neutral (an intentional skip).
 */
export function stepDecision(run, step) {
  if (step === 'issue_validation') {
    const e = last(run, ['issue_validation.pass', 'issue_validation.fail']);
    if (!e) return null;
    if (e.event === 'issue_validation.pass') return { key: 'pass', label: 'Validated', tone: 'good', reason: null, url: null };
    // validate_issue.mjs emits the same event at error level when validation throws (provider, parser): no verdict.
    if (e.level === 'error' || (e.meta.error != null && e.meta.score == null)) return { key: 'error', label: 'Validation error', tone: 'bad', reason: 'no verdict: the validation did not complete', url: null };
    const parts = [e.meta.score != null ? `score ${e.meta.score}` : null, e.meta.blockers_count != null ? `${e.meta.blockers_count} blocker(s)` : null].filter(Boolean);
    return { key: 'fail', label: 'Rejected', tone: 'warn', reason: parts.join(', ') || null, url: null };
  }
  if (step === 'code_gen') {
    const e = last(run, ['code_gen.complete', 'code_gen.skipped']);
    if (!e) return null;
    if (e.event === 'code_gen.complete') return { key: 'generated', label: 'Patch generated', tone: 'good', reason: e.meta.changes_count != null ? `${e.meta.changes_count} change(s)` : null, url: null };
    return { key: String(e.meta.reason ?? 'skipped'), label: e.meta.reason === 'blocked' ? 'Blocked' : 'Skipped', tone: 'warn', reason: [reasonText(e.meta.reason), e.meta.source ? `source ${e.meta.source}` : null].filter(Boolean).join(', ') || null, url: null };
  }
  if (step === 'pr_prepare') {
    const e = last(run, ['workflow.pr_operation', 'pr_prepare.skipped', 'pr_prepare.error']);
    if (!e) return null;
    // generate_issue_change.mjs: a guardrail rejection skips the stage; an error (incl. a failed escalation) fails it.
    if (e.event === 'pr_prepare.error') return { key: 'error', label: 'Error', tone: 'bad', reason: null, url: null };
    if (e.event === 'pr_prepare.skipped') {
      const rules = Array.isArray(e.meta.rules) && e.meta.rules.length ? ` (${e.meta.rules.join(', ')})` : '';
      return { key: String(e.meta.reason ?? 'skipped'), label: e.meta.reason === 'guardrail_rejected' ? 'Rejected by guardrail' : 'Skipped', tone: 'warn', reason: `${reasonText(e.meta.reason) ?? 'reason not recorded'}${rules}`, url: null };
    }
    return { key: String(e.meta.operation ?? 'operation'), label: `PR ${e.meta.operation ?? 'operation'}`, tone: 'good', reason: posInt(e.meta.prNumber) ? `PR #${e.meta.prNumber}` : null, url: safeUrl(e.meta.url) };
  }
  if (step === 'review') {
    const e = last(run, ['review.verdict', 'review.skipped']);
    if (!e) return null;
    if (e.event === 'review.skipped') return { key: 'skipped', label: 'Skipped', tone: 'neutral', reason: reasonText(e.meta.reason), url: null };
    const v = e.meta.verdict;
    if (v === 'APPROVE') return { key: 'APPROVE', label: 'Approved', tone: 'good', reason: null, url: null };
    if (v === 'REQUEST_CHANGES') return { key: 'REQUEST_CHANGES', label: 'Changes requested', tone: 'warn', reason: null, url: null };
    if (v === 'WITHHELD') return { key: 'WITHHELD', label: 'Withheld', tone: 'warn', reason: withheldReason(e.meta), url: null };
    return { key: 'other', label: 'Verdict not recognised', tone: 'neutral', reason: null, url: null };
  }
  if (step === 'autofix') {
    const e = last(run, ['autofix.push', 'autofix.skipped', 'autofix.max_attempts_reached', 'autofix.error']);
    if (!e) return null;
    if (e.event === 'autofix.push') {
      // autofix.push means the files were written; the workflow's git push is recorded later (workflow.push).
      const push = last(run, ['workflow.push']);
      if (push && push.meta.outcome === 'failure') return { key: 'push_failed', label: 'Push failed', tone: 'bad', reason: 'the fix was written but the git push step failed', url: null };
      return { key: 'pushed', label: 'Fix pushed', tone: 'good', reason: null, url: null };
    }
    if (e.event === 'autofix.error') return { key: 'error', label: 'Error', tone: 'bad', reason: reasonText(e.meta.error_type ?? e.meta.reason), url: null };
    if (e.event === 'autofix.max_attempts_reached') return { key: 'max_attempts', label: 'Attempt limit reached', tone: 'warn', reason: null, url: null };
    if (e.meta.reason === 'approved') return { key: 'approved', label: 'Skipped: head approved', tone: 'neutral', reason: null, url: null };
    const rules = Array.isArray(e.meta.rules) && e.meta.rules.length ? ` (${e.meta.rules.join(', ')})` : '';
    return { key: String(e.meta.reason ?? 'skipped'), label: e.meta.reason === 'no_changes' ? 'No change produced' : e.meta.reason === 'guardrail_rejected' ? 'Rejected by guardrail' : 'Skipped', tone: 'warn', reason: `${reasonText(e.meta.reason) ?? 'reason not recorded'}${rules}`, url: null };
  }
  return null;
}

/** Escalations a run recorded: `*.escalated`, an attempt limit, or any event adding the needs-human label. */
export function escalations(run) {
  return run.events.filter((e) => /\.escalated$/.test(e.event) || e.event === 'autofix.max_attempts_reached'
    || (Array.isArray(e.meta?.labels_added) && e.meta.labels_added.includes('needs-human')))
    .map((e) => ({ ts: e.ts, run_id: run.run_id, stage: e.stage, event: e.event, reason: reasonText(e.meta?.reason), url: safeUrl(e.meta?.url) }));
}

const runsOfStep = (runs, step) => runs.filter((r) => r.stages.some((s) => s.stage === step) || r.events.some((e) => e.stage === step));

/** One attempt: a run of the step, its execution status, its decision and the tone of both. */
export function attemptOf(run, step) {
  const span = run.stages.filter((s) => s.stage === step).at(-1);
  const status = EXECUTION_STATUSES.includes(span?.outcome) ? span.outcome : 'not-recorded';
  // A step that only recorded its escalation still decided not to move the item forward.
  const escalated = run.events.find((e) => e.event === `${step}.escalated`);
  const decision = stepDecision(run, step) ?? (escalated ? { key: 'escalated', label: 'Escalated to a human', tone: 'warn', reason: reasonText(escalated.meta?.reason), url: null } : null);
  const tone = status === 'failed' ? 'bad' : decision?.tone ?? (status === 'success' ? 'good' : status === 'skipped' ? 'neutral' : 'unknown');
  return {
    run_id: run.run_id, workflow: run.workflow, event_name: run.event_name, started_at: run.started_at,
    duration_ms: span?.duration_ms ?? run.duration_ms, status, decision, tone,
  };
}

/**
 * Every attempt of one step in chronological order, its final attempt and what the earlier ones hid.
 * Order: by start; an undated run ranks first (oldest), so it is never taken as the final attempt over a
 * dated one; on a tie the run earlier in trace order is the final one (as the collapsed card always did).
 */
export function stepJourney(runs, step) {
  const indexed = runsOfStep(runs, step).map((run, i) => ({ run, i }));
  indexed.sort((a, b) => (a.run.started_at ?? -Infinity) - (b.run.started_at ?? -Infinity) || b.i - a.i);
  const attempts = indexed.map(({ run }) => attemptOf(run, step));
  const final = attempts.at(-1) ?? null;
  const failures = attempts.filter((a) => a.status === 'failed').length;
  const adverse = attempts.filter((a) => a.status !== 'failed' && (a.tone === 'warn' || a.tone === 'bad')).length;
  const earlier = attempts.slice(0, -1);
  return {
    attempts,
    final,
    status: final?.status ?? 'not-recorded',
    failures,
    adverse,
    // Recovered: the final attempt moved the item forward after at least one failed or adverse attempt.
    recovered: final?.tone === 'good' && earlier.some((a) => a.tone === 'bad' || a.tone === 'warn'),
  };
}

// Last recorded state from the step journeys and escalations (see STATES).
function itemState(steps, escalated, runs) {
  if (!runs.length) return 'no_data';
  // A rejection is the validation's decision even when its span is closed as failed (the run is partial).
  const validation = steps.find((s) => s.key === 'issue_validation');
  if (validation.final?.decision?.key === 'fail' && steps.every((s) => s.key === 'issue_validation' || !s.attempts.length)) return 'rejected';
  // A failed run fails the item only while nothing superseded it: it attempted no step, or it is the final
  // attempt of one (a later successful attempt of the same step is a recovery, not a failure).
  const finalRuns = new Set(steps.map((s) => s.final?.run_id).filter(Boolean));
  const attempted = new Set(steps.flatMap((s) => s.attempts.map((a) => a.run_id)));
  // A later APPROVE ends the fix round (AGENTS.md, ADR-0034): a failure before it no longer fails the item.
  const review = steps.find((s) => s.key === 'review');
  const approvedAt = Math.max(-Infinity, ...review.attempts.filter((a) => a.decision?.key === 'APPROVE').map((a) => a.started_at ?? -Infinity));
  const standing = (t) => !(approvedAt > (t ?? -Infinity));
  const failedFinal = steps.some((s) => (s.final?.status === 'failed' || s.final?.decision?.tone === 'bad') && standing(s.final.started_at))
    || runs.some((r) => r.outcome === 'failed' && (!attempted.has(r.run_id) || finalRuns.has(r.run_id)) && standing(r.started_at));
  if (failedFinal) return 'failed';
  const decisions = review.attempts.filter((a) => a.decision && a.decision.key !== 'skipped');
  const lastReview = decisions.at(-1);
  const lastEscalation = escalated.at(-1);
  if (lastEscalation && !(lastReview?.decision.key === 'APPROVE' && (lastReview.started_at ?? 0) > (lastEscalation.ts ?? 0))) return 'escalated';
  if (lastReview) return { APPROVE: 'approved', WITHHELD: 'withheld', REQUEST_CHANGES: 'changes_requested' }[lastReview.decision.key] ?? 'in_progress';
  return 'in_progress';
}

/**
 * The journey of one work-item trace (normalizeTrace): steps (STEPS order) with their attempts, the last
 * recorded state, interventions (escalations), PR numbers, providers, attempt and timing totals.
 */
export function workItemJourney(trace) {
  const runs = trace.runs.map((r) => r.run).filter(Boolean);
  const issueItem = trace.item?.kind === 'issue';
  const reviewVerdicts = runs.flatMap((r) => r.events.filter((e) => e.event === 'review.verdict').map((e) => e.meta.verdict));
  const steps = STEPS.map((def) => {
    const j = stepJourney(runs, def.key);
    let note = null;
    if (!j.attempts.length) {
      if (def.issueOnly && !issueItem) note = 'No linked issue: not part of this flow';
      else if (def.key === 'autofix' && !reviewVerdicts.includes('REQUEST_CHANGES')) note = 'Not triggered: no REQUEST_CHANGES verdict recorded';
      else note = 'Not recorded';
    }
    return { key: def.key, name: def.name, ...j, note };
  });
  const escalated = runs.flatMap(escalations).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const state = itemState(steps, escalated, runs);
  const prs = [...new Set(runs.flatMap((r) => [r.pr_number, ...r.events.map((e) => e.meta?.prNumber)]).filter((n) => posInt(n)))];
  if (trace.item?.kind === 'pr' && !prs.includes(trace.item.number)) prs.push(trace.item.number);
  const calls = runs.flatMap((r) => r.llm);
  const lastActivity = Math.max(...trace.runs.map((r) => r.completed_at ?? r.started_at ?? -Infinity));
  return {
    trace_id: trace.trace_id,
    item: trace.item,
    prs: prs.sort((a, b) => a - b),
    issue: issueItem ? trace.item.number : null,
    steps,
    state,
    ...STATES[state],
    escalations: escalated,
    problem_steps: steps.filter((s) => s.failures || s.adverse).map((s) => s.key),
    failures: steps.reduce((n, s) => n + s.failures, 0),
    adverse: steps.reduce((n, s) => n + s.adverse, 0),
    recovered_steps: steps.filter((s) => s.recovered).map((s) => s.key),
    runs: trace.runs.length,
    missing_runs: trace.runs.filter((r) => !r.run).length,
    runs_overflow: trace.runs_overflow ?? 0,
    lead_time_ms: trace.lead_time_ms ?? null,
    running_ms: trace.running_ms ?? null,
    waiting_ms: trace.waiting_ms ?? null,
    last_activity: Number.isFinite(lastActivity) ? lastActivity : null,
    providers: [...new Set(calls.map((c) => c.provider).filter(Boolean))].sort(),
    fallbacks: calls.filter((c) => c.fallback).length,
    workflows: [...new Set(trace.runs.map((r) => r.workflow).filter(Boolean))].sort(),
  };
}

/** Journeys of every trace of the model, newest activity first. */
export function journeys(model) {
  return (model?.traces ?? []).map(workItemJourney).sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0) || a.trace_id.localeCompare(b.trace_id));
}
