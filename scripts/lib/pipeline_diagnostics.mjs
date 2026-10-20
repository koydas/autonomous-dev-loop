// Deterministic diagnostics of the pipeline (dashboard Diagnostics view, ADR-0043): fixed rules over the
// recorded runs and journeys, no LLM. Each finding separates what was observed (`fact`, computed from the
// records) from what it may mean (`hypothesis`, always labelled as such), and lists its evidence: the runs,
// events and work items it was computed from. Gaps in the telemetry are findings of their own (`gaps`):
// missing data is never read as the absence of a problem. Pure.
import { eventSummary, safeUrl } from './pipeline_model.mjs';
import { percentile } from './pipeline_health.mjs';
import { attemptOf, stepDecision } from './pipeline_journey.mjs';

// Rule thresholds: below them a pattern is not reported (too few cases to separate it from noise).
export const RULES = Object.freeze({
  minVerdicts: 3, // withheld / coverage rules need this many reviews
  withheldShare: 0.25, // WITHHELD share of verdicts that is reported
  truncatedShare: 0.5, // share of reviews with a cut diff that is reported
  reviewStreak: 3, // consecutive non-APPROVE verdicts on one PR
  autofixMinAttempts: 2, // auto-fix attempts before its push rate is judged
  autofixNoPushShare: 0.5,
  fallbackMin: 2, // provider fallbacks or errors of one kind
  durationMinRuns: 3, // runs per 7-day period to compare stage durations
  durationRatio: 1.5, // p50 growth reported as a degradation
  stageFailures: 2, // failed spans of one stage
});

export const SEVERITY_ORDER = Object.freeze(['critical', 'warning', 'info']);
const EVIDENCE_CAP = 25;
const DAY_MS = 86400000;
const pct = (v) => `${Math.round(v * 100)} %`;
const minutes = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
const events = (runs, name) => runs.flatMap((run) => run.events.filter((e) => e.event === name).map((e) => ({ run, e })));
// Capped evidence; over the cap, the oldest occurrence takes the last slot so "since" stays the true start.
const capped = (list) => {
  if (list.length <= EVIDENCE_CAP) return list;
  const at = ({ run, e }) => e?.ts ?? run.started_at ?? Infinity;
  const oldest = list.reduce((a, b) => (at(b) < at(a) ? b : a));
  const head = list.filter((x) => x !== oldest).slice(0, EVIDENCE_CAP - 1);
  return [...head, oldest];
};
const evidenceOf = (list) => capped(list).map(({ run, e }) => ({
  run_id: run.run_id, ts: e?.ts ?? run.started_at, event: e?.event ?? null, summary: e ? eventSummary(e.meta) : run.workflow ?? '',
  pr: run.pr_number ?? (Number.isSafeInteger(e?.meta?.prNumber) ? e.meta.prNumber : null), url: safeUrl(e?.meta?.url),
}));
const runIds = (list) => [...new Set(list.map(({ run }) => run.run_id))];
const prOf = ({ run, e }) => (Number.isSafeInteger(e?.meta?.prNumber) && e.meta.prNumber > 0 ? e.meta.prNumber : run.pr_number);

function finding(f) {
  return { hypothesis: null, items: [], runs: [], evidence: [], link: null, ...f };
}

// Execution failures: runs recorded as failed and failed stage spans without a decision explaining them.
function executionFailures(runs) {
  const out = [];
  const failedRuns = runs.filter((r) => r.outcome === 'failed');
  if (failedRuns.length) {
    out.push(finding({
      id: 'runs-failed', severity: 'critical', category: 'Execution', title: 'Runs ended in failure',
      fact: `${failedRuns.length} of ${runs.length} run(s) recorded the outcome failed.`,
      impact: `${failedRuns.length} run(s) stopped before completing their stage`, frequency: `${failedRuns.length} run(s)`,
      runs: failedRuns.map((r) => r.run_id), evidence: evidenceOf(failedRuns.map((run) => ({ run, e: run.events.filter((e) => e.level === 'error').at(-1) ?? null }))),
      link: 'index.html?result=failed#executions',
    }));
  }
  // A failed span explained by an adverse decision (a rejected issue) is a business outcome, not an execution
  // failure: only spans without a decision, or with an error decision, count (as runClass() does).
  const byStage = new Map();
  for (const run of runs) {
    for (const s of run.stages) {
      if (s.outcome !== 'failed' || !s.stage) continue;
      const { decision } = attemptOf(run, s.stage);
      if (decision && decision.tone !== 'bad') continue;
      byStage.set(s.stage, [...(byStage.get(s.stage) ?? []), run]);
    }
  }
  for (const [stage, list] of byStage) {
    if (list.length < RULES.stageFailures) continue;
    const total = runs.filter((r) => r.stages.some((s) => s.stage === stage)).length;
    out.push(finding({
      id: `stage-failures-${stage}`, severity: 'critical', category: 'Execution', title: `Repeated failures at ${stage}`,
      fact: `${list.length} of ${total} ${stage} span(s) closed as failed without a decision explaining it.`,
      impact: `${pct(list.length / total)} of ${stage} executions failed`, frequency: `${list.length} failure(s)`,
      runs: list.map((r) => r.run_id), evidence: evidenceOf(list.map((run) => ({ run, e: run.events.filter((e) => e.stage === stage && e.level !== 'info').at(-1) ?? null }))),
      link: 'index.html?result=failed#executions',
    }));
  }
  return out;
}

function reviewFindings(runs) {
  const out = [];
  const verdicts = events(runs, 'review.verdict');
  if (!verdicts.length) return out;
  // The sample floor guards the rate rules only; duplicate heads and stuck PRs are counts.
  const rated = verdicts.length >= RULES.minVerdicts;
  const withheld = verdicts.filter(({ e }) => e.meta.verdict === 'WITHHELD');
  if (rated && withheld.length / verdicts.length >= RULES.withheldShare) {
    const fromApprove = withheld.filter(({ e }) => e.meta.withheld_from === 'APPROVE').length;
    const cut = withheld.filter(({ e }) => typeof e.meta.unreviewed_code_files === 'number' && e.meta.unreviewed_code_files > 0).length;
    out.push(finding({
      id: 'review-withheld', severity: 'warning', category: 'Review', title: 'Reviews withhold their verdict',
      fact: `${withheld.length} of ${verdicts.length} verdicts are WITHHELD (${pct(withheld.length / verdicts.length)}); ${cut} of them had code files not reviewed, ${fromApprove} would have been APPROVE (withheld_from).`,
      hypothesis: cut > withheld.length / 2 ? 'Most withheld verdicts follow a cut diff: the review input budget looks too small for these PRs (ADR-0038 keeps approval withheld on unseen code, by design).' : null,
      impact: `${withheld.length} review(s) ended without a usable verdict; a person has to review`, frequency: `${withheld.length} verdict(s) on ${new Set(withheld.map(prOf)).size} PR(s)`,
      items: [...new Set(withheld.map(prOf).filter(Boolean))], runs: runIds(withheld), evidence: evidenceOf(withheld), link: 'health.html#reviews',
    }));
  }
  // Same population as the denominator: a cut review that errored before its verdict is not counted.
  const verdictRuns = new Set(verdicts.map(({ run }) => run.run_id));
  const truncated = events(runs, 'review.prompt_truncated').filter(({ run, e }) => e.meta.diff_truncated === true && verdictRuns.has(run.run_id));
  if (rated && truncated.length / verdicts.length >= RULES.truncatedShare) {
    const unseen = truncated.map(({ e }) => e.meta.unreviewed_code_files).filter((n) => typeof n === 'number');
    const budgets = [...new Set(truncated.map(({ e }) => e.meta.max_input_tokens).filter((n) => typeof n === 'number'))];
    out.push(finding({
      id: 'review-coverage', severity: 'warning', category: 'Review', title: 'Review diffs are cut',
      fact: `${truncated.length} of ${verdicts.length} reviews saw a truncated diff; median ${percentile(unseen, 50) ?? '?'} code file(s) not reviewed${budgets.length ? `, input budget ${budgets.join(' / ')} tokens` : ''}.`,
      hypothesis: 'Approvals on these PRs cannot be trusted to cover the whole change; raising the budget or batching the review would reduce WITHHELD verdicts (quota permitting).',
      impact: `${pct(truncated.length / verdicts.length)} of reviews are incomplete`, frequency: `${truncated.length} review(s)`,
      items: [...new Set(truncated.map(prOf).filter(Boolean))], runs: runIds(truncated), evidence: evidenceOf(truncated), link: 'health.html#reviews',
    }));
  }
  // The same PR head reviewed more than once: duplicate triggers or a re-run, each a model call.
  const byHead = new Map();
  for (const v of verdicts) {
    if (!v.run.head_sha || !prOf(v)) continue;
    const k = `${prOf(v)}@${v.run.head_sha}`;
    byHead.set(k, [...(byHead.get(k) ?? []), v]);
  }
  const dup = [...byHead.values()].filter((l) => l.length > 1);
  if (dup.length) {
    const extra = dup.reduce((n, l) => n + l.length - 1, 0);
    const triggers = [...new Set(dup.flatMap((l) => l.map(({ run }) => run.event_name ?? 'unknown')))].sort();
    const flips = dup.filter((l) => new Set(l.map(({ e }) => e.meta.verdict)).size > 1);
    out.push(finding({
      id: 'review-duplicates', severity: 'warning', category: 'Review', title: 'Same PR head reviewed more than once',
      fact: `${dup.length} PR head(s) got ${extra} extra review run(s) (triggers: ${triggers.join(', ')})${flips.length ? `; ${flips.length} of them got different verdicts on the same code` : ''}.`,
      hypothesis: triggers.includes('push') && triggers.includes('pull_request') ? 'Both the push and the pull_request trigger start a review of one head; the per-SHA marker does not claim the work atomically (docs/dashboard-partial-diagnosis.md, item 4).' : null,
      impact: `${extra} redundant review run(s) and their LLM calls`, frequency: `${dup.length} head(s)`,
      items: [...new Set(dup.map((l) => prOf(l[0])))], runs: runIds(dup.flat()), evidence: evidenceOf(dup.flat()), link: 'index.html#executions',
    }));
  }
  // A PR whose last N verdicts are all non-APPROVE. An APPROVE ends a fix round (ADR-0034):
  // only the trailing streak after the latest approval counts.
  const byPr = new Map();
  for (const v of [...verdicts].sort((a, b) => (a.e.ts ?? 0) - (b.e.ts ?? 0))) {
    if (!prOf(v)) continue;
    const l = v.e.meta.verdict === 'APPROVE' ? [] : [...(byPr.get(prOf(v)) ?? []), v];
    byPr.set(prOf(v), l);
  }
  const stuck = [...byPr.entries()].filter(([, l]) => l.length >= RULES.reviewStreak);
  if (stuck.length) {
    out.push(finding({
      id: 'review-stuck', severity: 'warning', category: 'Review', title: 'PRs not approved after several reviews',
      fact: `${stuck.length} PR(s) have their last ${RULES.reviewStreak}+ verdicts without an APPROVE: ${stuck.map(([pr, l]) => `#${pr} (${l.length})`).join(', ')}.`,
      impact: `${stuck.reduce((n, [, l]) => n + l.length, 0)} review run(s) without converging`, frequency: `${stuck.length} PR(s)`,
      items: stuck.map(([pr]) => pr), runs: runIds(stuck.flatMap(([, l]) => l)), evidence: evidenceOf(stuck.flatMap(([, l]) => l.slice(-RULES.reviewStreak))), link: 'flows.html?problem=review',
    }));
  }
  return out;
}

function autofixFindings(runs) {
  const attempts = events(runs, 'autofix.start');
  if (attempts.length < RULES.autofixMinAttempts) return [];
  // A push counts only when delivered: autofix.push followed by a failed workflow git push is "Push failed".
  const decided = runs.filter((r) => r.events.some((e) => e.event === 'autofix.push')).map((r) => stepDecision(r, 'autofix')?.key);
  const pushes = decided.filter((k) => k === 'pushed');
  const failedPushes = decided.filter((k) => k === 'push_failed').length;
  const noPush = attempts.length - pushes.length;
  if (noPush / attempts.length < RULES.autofixNoPushShare) return [];
  const skips = events(runs, 'autofix.skipped');
  const reasons = {};
  for (const { e } of skips) reasons[e.meta.reason ?? 'unspecified'] = (reasons[e.meta.reason ?? 'unspecified'] ?? 0) + 1;
  const noChanges = reasons.no_changes ?? 0;
  return [finding({
    id: 'autofix-ineffective', severity: 'warning', category: 'Auto-fix', title: 'Auto-fix rarely pushes a fix',
    fact: `${pushes.length} delivered push(es) for ${attempts.length} attempt(s)${failedPushes ? `, ${failedPushes} whose git push failed` : ''}; skip reasons: ${Object.entries(reasons).map(([k, n]) => `${k} ${n}`).join(', ') || 'none recorded'}.`,
    hypothesis: noChanges ? '`no_changes` alone does not prove a fix was needed: the finding may be false, or the context given to the model did not include the files to change (docs/dashboard-partial-diagnosis.md, item 3).' : null,
    impact: `${noPush} attempt(s) ended without a change, usually escalated to a human`, frequency: `${noPush} of ${attempts.length} attempt(s)`,
    items: [...new Set(attempts.map(prOf).filter(Boolean))], runs: runIds(attempts), evidence: evidenceOf(skips.length ? skips : attempts), link: 'health.html#autofix',
  })];
}

function generationFindings(runs) {
  const starts = events(runs, 'code_gen.start');
  const blocked = events(runs, 'code_gen.skipped');
  if (!starts.length || blocked.length < 2 || blocked.length / starts.length < 0.5) return [];
  const sources = {};
  for (const { e } of blocked) sources[e.meta.source ?? 'unspecified'] = (sources[e.meta.source ?? 'unspecified'] ?? 0) + 1;
  return [finding({
    id: 'codegen-blocked', severity: 'warning', category: 'Code generation', title: 'Code generation is mostly blocked',
    fact: `${blocked.length} of ${starts.length} generation run(s) produced no patch (source: ${Object.entries(sources).map(([k, n]) => `${k} ${n}`).join(', ')}); ${events(runs, 'code_gen.complete').length} completed.`,
    hypothesis: 'A model-sourced block usually means the files to change were withheld from its context (size or protected paths); the escalation comment on the issue says which.',
    impact: `${blocked.length} issue(s) escalated instead of getting a PR`, frequency: `${blocked.length} run(s)`,
    runs: runIds(blocked), evidence: evidenceOf(blocked), link: 'flows.html?state=escalated',
  })];
}

function providerFindings(runs) {
  const out = [];
  const fallbacks = events(runs, 'llm_fallback');
  const calls = runs.reduce((n, r) => n + r.llm.length, 0);
  if (fallbacks.length >= RULES.fallbackMin) {
    const kinds = {};
    for (const { e } of fallbacks) { const k = `${e.meta.from ?? '?'} → ${e.meta.to ?? '?'} (${e.meta.error_type ?? 'unknown'})`; kinds[k] = (kinds[k] ?? 0) + 1; }
    const limited = fallbacks.filter(({ e }) => e.meta.status === 429).length;
    const unclassified = fallbacks.filter(({ e }) => !e.meta.error_type || e.meta.error_type === 'UNKNOWN').length;
    out.push(finding({
      id: 'llm-fallbacks', severity: 'warning', category: 'LLM provider', title: 'Frequent provider fallbacks',
      fact: `${fallbacks.length} fallback(s) for ${calls} LLM call(s): ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ')}.${unclassified ? ` ${unclassified} of them carry no classified error type: their cause is not recorded.` : ''}`,
      hypothesis: limited * 2 >= fallbacks.length ? 'The primary provider rate-limits the pipeline (429): the free-tier tokens-per-minute limit is the binding one (ADR-0025).' : null,
      impact: 'Answers come from the fallback model, at its price', frequency: `${fallbacks.length} fallback(s)`,
      runs: runIds(fallbacks), evidence: evidenceOf(fallbacks), link: 'models.html',
    }));
  }
  const waits = events(runs, 'retry.wait').filter(({ e }) => e.meta.status === 429);
  if (waits.length >= RULES.fallbackMin) {
    const ms = waits.reduce((t, { e }) => t + (Number.isFinite(e.meta.wait_ms) ? e.meta.wait_ms : 0), 0);
    out.push(finding({
      id: 'rate-limit-waits', severity: 'info', category: 'LLM provider', title: 'Time lost waiting on rate limits',
      fact: `${waits.length} retry wait(s) on HTTP 429, totalling ${minutes(ms)} across ${runIds(waits).length} run(s).`,
      impact: `${minutes(ms)} of run time spent waiting`, frequency: `${waits.length} wait(s)`,
      runs: runIds(waits), evidence: evidenceOf(waits), link: 'health.html#providers',
    }));
  }
  return out;
}

// Stage p50 duration over the latest 7 days of records against the 7 before.
function durationFindings(runs) {
  const dated = runs.filter((r) => r.started_at != null);
  if (!dated.length) return { findings: [], gaps: [] };
  const end = Math.max(...dated.map((r) => r.started_at));
  const findings = [];
  const thin = [];
  for (const stage of [...new Set(dated.flatMap((r) => r.stages.map((s) => s.stage)).filter(Boolean))].sort()) {
    const span = (from, to) => dated.filter((r) => r.started_at > from && r.started_at <= to).flatMap((r) => r.stages.filter((s) => s.stage === stage && typeof s.duration_ms === 'number').map((s) => ({ run: r, ms: s.duration_ms })));
    const cur = span(end - 7 * DAY_MS, end);
    const prev = span(end - 14 * DAY_MS, end - 7 * DAY_MS);
    if (cur.length < RULES.durationMinRuns || prev.length < RULES.durationMinRuns) { thin.push(stage); continue; }
    const a = percentile(cur.map((x) => x.ms), 50);
    const b = percentile(prev.map((x) => x.ms), 50);
    if (b > 0 && a / b >= RULES.durationRatio) {
      findings.push(finding({
        id: `duration-${stage}`, severity: 'warning', category: 'Performance', title: `${stage} got slower`,
        fact: `Median ${stage} span ${minutes(a)} over the latest 7 days (n=${cur.length}) vs ${minutes(b)} the 7 days before (n=${prev.length}).`,
        impact: `×${(a / b).toFixed(1)} median duration`, frequency: `${cur.length} run(s)`,
        runs: cur.map((x) => x.run.run_id), evidence: evidenceOf(cur.map((x) => ({ run: x.run, e: null }))), link: 'health.html#performance',
      }));
    }
  }
  const gaps = thin.length ? [{ id: 'duration-thin', title: 'Duration trend not computable', detail: `Fewer than ${RULES.durationMinRuns} runs in one of the two latest 7-day periods for: ${thin.join(', ')}. No degradation is reported for them — that is not the same as no degradation.` }] : [];
  return { findings, gaps };
}

function interventions(journeys) {
  const escalated = journeys.filter((j) => j.state === 'escalated');
  if (!escalated.length) return [];
  return [finding({
    id: 'escalations', severity: 'warning', category: 'Interventions', title: 'Work items escalated to a human',
    fact: `${escalated.length} work item(s) whose last recorded event is an escalation (needs-human): ${escalated.map((j) => `${j.item?.kind ?? 'item'} #${j.item?.number ?? '?'}`).join(', ')}.`,
    impact: `${escalated.length} item(s) wait on a person`, frequency: `${escalated.length} item(s)`,
    items: escalated.map((j) => j.item?.number).filter(Boolean),
    runs: [...new Set(escalated.flatMap((j) => j.escalations.map((x) => x.run_id)))],
    evidence: escalated.map((j) => j.escalations.at(-1)).map((x) => ({ run_id: x.run_id, ts: x.ts, event: x.event, summary: x.reason ? `reason=${x.reason}` : '', pr: null, url: x.url })),
    link: 'flows.html?state=escalated',
  })];
}

// What the records cannot tell: listed as gaps, never as "no problem".
function telemetryGaps(model, journeys) {
  const gaps = [
    { id: 'merge-not-journaled', title: 'Merge is not journaled', detail: 'No workflow records a merge: the Pipelines page asks GitHub for merged_at in the browser; without it, merge stays unknown.' },
    { id: 'running-not-observable', title: 'Running state is not observable', detail: 'A record is written when its run completes, so a run in progress never appears; the latest state of an item can be older than GitHub.' },
  ];
  const missing = journeys.reduce((n, j) => n + j.missing_runs, 0);
  if (missing) gaps.push({ id: 'missing-records', title: 'Runs listed without a record', detail: `${missing} run(s) listed by trace indexes have no loaded record (crashed before the tracer, malformed, or older than the window).` });
  const overflow = model.runs.filter((r) => r.events_overflow.count || r.spans_overflow.count || r.spans_overflow.events);
  if (overflow.length) gaps.push({ id: 'overflow', title: 'Truncated journals', detail: `${overflow.length} run(s) dropped events or spans over the record caps (events_overflow / spans_overflow).`, runs: overflow.map((r) => r.run_id) });
  const untraced = model.runs.filter((r) => !r.trace_id || !model.tracesById?.has(r.trace_id)).length;
  if (untraced) gaps.push({ id: 'untraced', title: 'Runs outside any work-item trace', detail: `${untraced} run(s) have no trace index: they appear in Investigation but not in Pipelines.` });
  // The workflow records workflow.pr_operation only when its PR action succeeded: a prepared change without it
  // may have no PR (failed action) or come from an older record; the records cannot tell which.
  const unconfirmed = model.runs.filter((r) => r.stages.some((s) => s.stage === 'pr_prepare' && s.outcome === 'success') && !r.events.some((e) => e.event === 'workflow.pr_operation'));
  if (unconfirmed.length) gaps.push({ id: 'pr-operation-unrecorded', title: 'PR creation not confirmed', detail: `${unconfirmed.length} run(s) prepared a change but recorded no PR operation: the PR action may have failed after the trace was written. Check the workflow run.`, runs: unconfirmed.map((r) => r.run_id) });
  const calls = model.runs.flatMap((r) => r.llm);
  const estimated = calls.filter((c) => c.estimated !== false).length;
  if (estimated) gaps.push({ id: 'estimated-tokens', title: 'Token counts are estimates', detail: `${estimated} of ${calls.length} LLM call(s) carry chars/4 estimates, not provider-measured usage: their cost excludes thinking and prompt cache.` });
  if (model.warnings?.length) gaps.push({ id: 'input-warnings', title: 'Unreadable inputs', detail: `${model.warnings.length} record(s) or index(es) were skipped while building (see Investigation → input warnings).` });
  if (model.skippedMonths?.length) gaps.push({ id: 'window', title: 'History beyond the window', detail: `Months ${model.skippedMonths.join(', ')} stay on the metrics branch only: retained history is not the complete history.` });
  return gaps;
}

/**
 * Every finding of a model and its journeys, most severe first, plus the telemetry gaps and the overall
 * status: `critical` / `warning` with a finding of that severity, `ok` with none, `no_data` without runs.
 */
export function diagnose({ model, journeys = [] } = {}) {
  const runs = model?.runs ?? [];
  if (!runs.length) return { status: 'no_data', findings: [], gaps: model ? telemetryGaps(model, journeys) : [] };
  const durations = durationFindings(runs);
  const findings = [
    ...executionFailures(runs), ...interventions(journeys), ...reviewFindings(runs), ...autofixFindings(runs),
    ...generationFindings(runs), ...providerFindings(runs), ...durations.findings,
  ].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const status = findings.some((f) => f.severity === 'critical') ? 'critical' : findings.some((f) => f.severity === 'warning') ? 'warning' : 'ok';
  return { status, findings, gaps: [...telemetryGaps(model, journeys), ...durations.gaps] };
}
