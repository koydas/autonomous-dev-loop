// Deterministic diagnostics of the pipeline (dashboard Diagnostics view, ADR-0043): fixed rules over the
// recorded runs and journeys, no LLM. Each finding separates what was observed (`fact`, computed from the
// records) from what it may mean (`hypothesis`, always labelled as such), and lists its evidence: the runs,
// events and work items it was computed from. Gaps in the telemetry are findings of their own (`gaps`):
// missing data is never read as the absence of a problem. Pure.
import { eventSummary, safeUrl } from './pipeline_model.mjs';
import { percentile, withheldCause } from './pipeline_health.mjs';
import { attemptOf, stepDecision, isLifecycleRun } from './pipeline_journey.mjs';
import { DESIGN_RULES, waitingOnYou } from './pipeline_waiting.mjs';

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
  activeWindow: 10, // a finding is active while it occurs in the last N eligible runs of its rule; else resolved
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
// Rate gate of a rule: the share of occurrences among `items` up to and including the last occurrence, with the
// size of that prefix. A clean tail dilutes the whole-window rate; a finding that fired must reach its lifecycle
// (and show as resolved) instead of vanishing once clean runs push the rate under its threshold. A rule fires on
// the whole-window rate or on this one, each over its own sample floor.
const at = ({ run, e }) => e?.ts ?? run.started_at ?? 0;
function rateAtLastOccurrence(items, isOccurrence) {
  const ordered = items.map((x, i) => [x, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([x]) => x);
  const last = ordered.findLastIndex(isOccurrence);
  const prefix = ordered.slice(0, last + 1);
  return { n: prefix.length, share: prefix.length ? prefix.filter(isOccurrence).length / prefix.length : 0 };
}
const runIds = (list) => [...new Set(list.map(({ run }) => run.run_id))];
const prOf = ({ run, e }) => (Number.isSafeInteger(e?.meta?.prNumber) && e.meta.prNumber > 0 ? e.meta.prNumber : run.pr_number);

// `eligible`: the runs the rule could have fired on (its population); null when the rule reads a current state
// (a trailing streak, journeys), which is active by construction. `occ`: the eligible runs where the pattern
// occurs (default `runs`). `anomaly` / `critical`: run ids whose occurrence is an anomaly / impossible by design;
// without an anomaly in the active window a finding is a guardrail doing its job (info). `share`: for a rate rule,
// the anomaly share of the active window from which the finding is a warning.
function finding(f) {
  return { hypothesis: null, items: [], runs: [], evidence: [], link: null, eligible: null, occ: null, anomaly: null, critical: null, titleByDesign: null, share: null, ...f };
}

const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const withStage = (runs, stage) => runs.filter((r) => r.stages.some((s) => s.stage === stage));
const withEvent = (runs, ...names) => runs.filter((r) => r.events.some((e) => names.includes(e.event)));

// first_seen / last_seen / status over the finding's own population, then severity from the active window:
// `resolved` (no occurrence in the last RULES.activeWindow eligible runs) is info and says since when the rule
// has been clean; the historical numbers stay in fact and evidence. Pure.
function withLifecycle(f) {
  const { eligible, occ, anomaly, critical, titleByDesign, share, ...rest } = f;
  const occurrences = new Set(occ ?? f.runs);
  const at = (r) => (Number.isFinite(r.started_at) ? r.started_at : null);
  const ordered = (eligible ?? []).map((r, i) => [r, i]).sort((a, b) => (at(a[0]) ?? 0) - (at(b[0]) ?? 0) || a[1] - b[1]).map(([r]) => r);
  const seen = ordered.filter((r) => occurrences.has(r.run_id)).map(at).filter((t) => t !== null);
  const stamps = seen.length ? seen : f.evidence.map((x) => x.ts).filter(Number.isFinite);
  const base = { ...rest, first_seen: stamps.length ? Math.min(...stamps) : null, last_seen: stamps.length ? Math.max(...stamps) : null, status: 'active', clean_since: null };
  if (!eligible) return base;
  const tail = ordered.slice(-RULES.activeWindow);
  const inTail = (ids) => ids?.some((id) => tail.some((r) => r.run_id === id));
  if (!tail.some((r) => occurrences.has(r.run_id))) {
    const last = ordered.findLastIndex((r) => occurrences.has(r.run_id));
    const clean = at(ordered[last + 1] ?? {}) ?? null;
    return { ...base, severity: 'info', status: 'resolved', clean_since: clean, title: `${f.title}${clean !== null ? ` — resolved since ${day(clean)}` : ' — resolved'}` };
  }
  if (inTail(critical)) return { ...base, severity: 'critical' };
  // Rate rules: the severity is judged on the active window, so recent anomalies promote and recent
  // guardrails demote whatever the retained history says.
  if (anomaly && share != null) {
    const anomalous = tail.filter((r) => anomaly.includes(r.run_id)).length;
    return anomalous / tail.length >= share ? { ...base, severity: 'warning' } : { ...base, severity: 'info', title: titleByDesign ?? f.title };
  }
  if (anomaly && !inTail(anomaly)) return { ...base, severity: 'info', title: titleByDesign ?? f.title };
  return base;
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
      eligible: runs, runs: failedRuns.map((r) => r.run_id), evidence: evidenceOf(failedRuns.map((run) => ({ run, e: run.events.filter((e) => e.level === 'error').at(-1) ?? null }))),
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
      eligible: withStage(runs, stage), runs: list.map((r) => r.run_id), evidence: evidenceOf(list.map((run) => ({ run, e: run.events.filter((e) => e.stage === stage && e.level !== 'info').at(-1) ?? null }))),
      link: 'index.html?result=failed#executions',
    }));
  }
  return out;
}

// A WITHHELD verdict: its cause (withheldCause, pipeline_health.mjs), the provider whose answer it is (the run's
// last non-failed review call) and the input budget its prompt was cut to. Anomalies: a fallback answering a
// prompt cut to the primary's budget (a number: only a budgeted provider sets it), REQUEST_CHANGES withheld on
// unseen code, an unknown cause. A code cut or missing CI evidence is a guardrail doing its job (ADR-0038, ADR-0026).
const ANOMALY_CAUSES = new Set(['rc_unseen', 'other']);
function withheldClass({ run, e }) {
  const calls = run.llm.filter((c) => !c.failed);
  const reviewCalls = calls.filter((c) => c.pipeline_stage === 'review');
  const responder = (reviewCalls.length ? reviewCalls : calls).at(-1) ?? null;
  const budget = run.events.filter((x) => x.event === 'review.prompt_truncated').map((x) => x.meta.max_input_tokens).find((n) => typeof n === 'number') ?? null;
  const cause = withheldCause(e.meta);
  // Missing / stale CI evidence withholds whatever the model said (decideVerdict, ADR-0026): the fallback did not cause it.
  const evidence = cause === 'evidence_missing' || cause === 'evidence_stale';
  const key = responder?.fallback === true && budget != null && !evidence ? 'fallback_capped' : cause;
  return { key, anomaly: key === 'fallback_capped' || ANOMALY_CAUSES.has(cause), responder, budget };
}

function reviewFindings(runs) {
  const out = [];
  const verdicts = events(runs, 'review.verdict');
  if (!verdicts.length) return out;
  // The sample floor guards the rate rules only; duplicate heads and stuck PRs are counts.
  const rated = verdicts.length >= RULES.minVerdicts;
  const withheld = verdicts.filter(({ e }) => e.meta.verdict === 'WITHHELD');
  const withheldRate = rateAtLastOccurrence(verdicts, ({ e }) => e.meta.verdict === 'WITHHELD');
  if (rated && withheld.length && (withheld.length / verdicts.length >= RULES.withheldShare || (withheldRate.n >= RULES.minVerdicts && withheldRate.share >= RULES.withheldShare))) {
    const fromApprove = withheld.filter(({ e }) => e.meta.withheld_from === 'APPROVE').length;
    const cut = withheld.filter(({ e }) => typeof e.meta.unreviewed_code_files === 'number' && e.meta.unreviewed_code_files > 0).length;
    const classes = withheld.map(withheldClass);
    const count = (k) => classes.filter((c) => c.key === k).length;
    const anomalies = classes.filter((c) => c.anomaly).length;
    // Keyed by PR and SHA, as the duplicate-review grouping: one commit can head two PRs.
    const heads = new Set(withheld.filter((v) => v.run.head_sha).map((v) => `${prOf(v)}@${v.run.head_sha}`)).size;
    const prs = new Set(withheld.map(prOf).filter(Boolean)).size;
    const tally = (list) => Object.entries(list.reduce((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
    const answered = tally(classes.map((c) => (c.responder ? `${c.responder.provider ?? 'unknown'}${c.responder.fallback ? ' (fallback)' : ''}` : 'not recorded')));
    const budgets = [...new Set(classes.map((c) => c.budget).filter((n) => n != null))];
    const warning = anomalies / verdicts.length >= RULES.withheldShare;
    const guardrailCut = count('approve_cut') + count('cut_unknown');
    const guardrailEvidence = count('evidence_missing') + count('evidence_stale');
    const adrs = [guardrailCut ? 'ADR-0038' : null, guardrailEvidence ? 'ADR-0026' : null].filter(Boolean).join(', ');
    out.push(finding({
      id: 'review-withheld', severity: warning ? 'warning' : 'info', category: 'Review',
      title: 'Reviews withhold their verdict', share: RULES.withheldShare,
      titleByDesign: adrs ? `Reviews withhold their verdict by design (${adrs})` : null,
      anomaly: runIds(withheld.filter((_, i) => classes[i].anomaly)),
      fact: `${withheld.length} of ${verdicts.length} verdicts are WITHHELD (${pct(withheld.length / verdicts.length)}); ${cut} of them had code files not reviewed, ${fromApprove} would have been APPROVE (withheld_from). `
        + `They cover ${heads} PR head(s) on ${prs} PR(s). Guardrail: ${withheld.length - anomalies} (code cut, ADR-0038: ${guardrailCut}; CI evidence, ADR-0026: ${guardrailEvidence}); `
        + `anomaly: ${anomalies} (REQUEST_CHANGES on unseen code: ${count('rc_unseen')}; unknown cause: ${count('other')}; fallback answered a prompt cut to the primary's budget: ${count('fallback_capped')}). `
        + `Answered by: ${answered}${budgets.length ? `; input budget ${budgets.join(' / ')} tokens` : ''}.`,
      hypothesis: warning
        ? (count('fallback_capped') * 2 >= anomalies ? 'The fallback provider answered a prompt already cut to the primary\'s input budget: it saw no more code than the primary would have, so the cut, not the model, withheld the verdict.' : null)
        : guardrailCut > withheld.length / 2 ? 'The guardrail worked as designed: approval is withheld on code the review did not see (ADR-0038). The lever is the provider or its input budget (review_max_input_tokens, ADR-0025), not the review rule.' : null,
      impact: `${withheld.length} review(s) ended without a usable verdict; a person has to review`, frequency: `${withheld.length} verdict(s) on ${heads} head(s) of ${prs} PR(s)`,
      items: [...new Set(withheld.map(prOf).filter(Boolean))], eligible: withEvent(runs, 'review.verdict'), runs: runIds(withheld), evidence: evidenceOf(withheld), link: 'health.html#reviews',
    }));
  }
  // Same population as the denominator: a cut review that errored before its verdict is not counted.
  const verdictRuns = new Set(verdicts.map(({ run }) => run.run_id));
  const truncated = events(runs, 'review.prompt_truncated').filter(({ run, e }) => e.meta.diff_truncated === true && verdictRuns.has(run.run_id));
  const truncatedRuns = new Set(runIds(truncated));
  const coverageRate = rateAtLastOccurrence(verdicts, ({ run }) => truncatedRuns.has(run.run_id));
  if (rated && truncated.length && (truncated.length / verdicts.length >= RULES.truncatedShare || (coverageRate.n >= RULES.minVerdicts && coverageRate.share >= RULES.truncatedShare))) {
    const unseen = truncated.map(({ e }) => e.meta.unreviewed_code_files).filter((n) => typeof n === 'number');
    const budgets = [...new Set(truncated.map(({ e }) => e.meta.max_input_tokens).filter((n) => typeof n === 'number'))];
    // A cut diff and its verdict (the run's last): WITHHELD is the ADR-0038 guardrail; APPROVE on unseen code is
    // impossible since ADR-0038 (critical); anything else (REQUEST_CHANGES on a cut diff) is an anomaly.
    const lastVerdict = new Map(verdicts.map((v) => [v.run, v.e.meta.verdict]));
    const verdictOf = (run) => lastVerdict.get(run);
    const cutClass = ({ run }) => (verdictOf(run) === 'WITHHELD' ? 'guardrail' : verdictOf(run) === 'APPROVE' ? 'approve' : 'anomaly');
    const idsOf = (k) => runIds(truncated.filter((t) => cutClass(t) === k));
    const guardrail = idsOf('guardrail'), approved = idsOf('approve'), other = idsOf('anomaly');
    out.push(finding({
      id: 'review-coverage', severity: 'warning', category: 'Review', title: 'Review diffs are cut', titleByDesign: 'Review diffs are cut by design (ADR-0038)',
      fact: `${truncated.length} of ${verdicts.length} reviews saw a truncated diff; median ${percentile(unseen, 50) ?? '?'} code file(s) not reviewed${budgets.length ? `, input budget ${budgets.join(' / ')} tokens` : ''}. `
        + `Guardrail (WITHHELD, ADR-0038): ${guardrail.length}; anomaly: ${approved.length + other.length} (APPROVE on a cut diff, impossible since ADR-0038: ${approved.length}; other verdict: ${other.length}).`,
      hypothesis: approved.length ? 'An APPROVE on a diff the review did not fully see contradicts the ADR-0038 backstop: either it did not apply or the record is wrong.'
        : other.length ? 'Approvals on these PRs cannot be trusted to cover the whole change; raising the budget or batching the review would reduce WITHHELD verdicts (quota permitting).'
          : 'The guardrail worked as designed: approval is withheld on code the review did not see (ADR-0038). The lever is the provider or its input budget (review_max_input_tokens, ADR-0025).',
      impact: `${pct(truncated.length / verdicts.length)} of reviews are incomplete`, frequency: `${truncated.length} review(s)`,
      items: [...new Set(truncated.map(prOf).filter(Boolean))], eligible: withEvent(runs, 'review.verdict'), runs: runIds(truncated), anomaly: [...approved, ...other], critical: approved,
      evidence: evidenceOf(truncated), link: 'health.html#reviews',
    }));
  }
  // The same PR head reviewed more than once: duplicate triggers or a re-run, each a model call.
  const byHead = new Map();
  for (const v of verdicts) {
    if (!v.run.head_sha || !prOf(v)) continue;
    const k = `${prOf(v)}@${v.run.head_sha}`;
    byHead.set(k, [...(byHead.get(k) ?? []), v]);
  }
  const dup = [...byHead.values()].filter((l) => l.length > 1).map((l) => [...l].sort((a, b) => (a.e.ts ?? a.run.started_at ?? 0) - (b.e.ts ?? b.run.started_at ?? 0)));
  if (dup.length) {
    const extra = dup.reduce((n, l) => n + l.length - 1, 0);
    const triggers = [...new Set(dup.flatMap((l) => l.map(({ run }) => run.event_name ?? 'unknown')))].sort();
    const flips = dup.filter((l) => new Set(l.map(({ e }) => e.meta.verdict)).size > 1);
    // A second run is by design after a WITHHELD verdict (never deduplicated, ADR-0028) or as a manual re-run
    // (run attempt > 1); otherwise the marker should have skipped it: two runs claimed one head (push /
    // pull_request race).
    // run_id is `<workflow run id>-<run attempt>` (run_record.mjs envelope), so the suffix is the attempt.
    const rerun = ({ run }) => Number(/-(\d+)$/.exec(run.run_id)?.[1]) > 1;
    // The WITHHELD must predate the later run's start: a run already started when it was emitted raced with it.
    const sawWithheld = (prev, v) => prev.e.meta.verdict === 'WITHHELD' && !(Number.isFinite(prev.e.ts) && Number.isFinite(v.run.started_at) && prev.e.ts > v.run.started_at);
    const extras = dup.flatMap((l) => l.slice(1).map((v, i) => ({ v, by: sawWithheld(l[i], v) ? 'withheld' : rerun(v) ? 'rerun' : 'race' })));
    const count = (k) => extras.filter((x) => x.by === k).length;
    const race = extras.filter((x) => x.by === 'race').map((x) => x.v.run.run_id);
    out.push(finding({
      id: 'review-duplicates', severity: 'warning', category: 'Review', title: 'Same PR head reviewed more than once', titleByDesign: 'Same PR head reviewed again by design (ADR-0028)',
      fact: `${dup.length} PR head(s) got ${extra} extra review run(s) (triggers: ${triggers.join(', ')})${flips.length ? `; ${flips.length} of them got different verdicts on the same code` : ''}. `
        + `Guardrail: ${count('withheld') + count('rerun')} (after a WITHHELD verdict, ADR-0028: ${count('withheld')}; manual re-run: ${count('rerun')}); anomaly: ${race.length} (two runs on one head, none skipped by the marker).`,
      hypothesis: race.length && triggers.includes('push') && triggers.includes('pull_request') ? 'Both the push and the pull_request trigger start a review of one head; the per-SHA marker does not claim the work atomically (docs/dashboard-partial-diagnosis.md, item 4).' : null,
      impact: `${extra} redundant review run(s) and their LLM calls`, frequency: `${dup.length} head(s)`,
      items: [...new Set(dup.map((l) => prOf(l[0])))], eligible: withEvent(runs, 'review.verdict', 'review.skipped'), runs: runIds(dup.flat()), anomaly: race,
      evidence: evidenceOf(dup.flat()), link: 'index.html#executions',
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

// An auto-fix attempt blocked by design: every rejected target protected, unshown or withheld (ADR-0021,
// ADR-0029); no change proposed while the budget withheld files from the prompt (ADR-0029: the records do
// not name the files the fix needed, so this is the closest observable cause). Anything else that did not
// push is an anomaly. An approved head (ADR-0028) or the attempt limit (ADR-0034) exits before autofix.start:
// such a run is not an attempt, so it never counts here.
function blockedByDesign(run) {
  const d = stepDecision(run, 'autofix');
  const skip = run.events.filter((e) => e.event === 'autofix.skipped').at(-1);
  if (d?.key === 'guardrail_rejected' && Array.isArray(skip?.meta.rules) && skip.meta.rules.length && skip.meta.rules.every((r) => DESIGN_RULES.has(r))) return 'protected or unshown target';
  if (d?.key === 'no_changes' && run.events.some((e) => e.event === 'autofix.prompt_budget' && Array.isArray(e.meta.hidden_files) && e.meta.hidden_files.length)) return 'files withheld by budget';
  return null;
}

function autofixFindings(runs) {
  const attempts = events(runs, 'autofix.start');
  if (attempts.length < RULES.autofixMinAttempts) return [];
  // A push counts only when delivered: autofix.push followed by a failed workflow git push is "Push failed".
  const decided = runs.filter((r) => r.events.some((e) => e.event === 'autofix.push')).map((r) => stepDecision(r, 'autofix')?.key);
  const pushes = decided.filter((k) => k === 'pushed');
  const failedPushes = decided.filter((k) => k === 'push_failed').length;
  const noPush = attempts.length - pushes.length;
  const pushRate = rateAtLastOccurrence(attempts, ({ run }) => stepDecision(run, 'autofix')?.key !== 'pushed');
  if (!noPush || (noPush / attempts.length < RULES.autofixNoPushShare && (pushRate.n < RULES.autofixMinAttempts || pushRate.share < RULES.autofixNoPushShare))) return [];
  // Skip details from the attempts only: an approved head or the attempt limit skips before autofix.start.
  const attemptRuns = new Set(runIds(attempts));
  const skips = events(runs.filter((r) => attemptRuns.has(r.run_id)), 'autofix.skipped');
  const reasons = {};
  for (const { e } of skips) reasons[e.meta.reason ?? 'unspecified'] = (reasons[e.meta.reason ?? 'unspecified'] ?? 0) + 1;
  const noChanges = reasons.no_changes ?? 0;
  const designed = {};
  for (const { run } of attempts) { const why = blockedByDesign(run); if (why) designed[why] = (designed[why] ?? 0) + 1; }
  const blocked = Object.values(designed).reduce((t, n) => t + n, 0);
  const anomalies = noPush - blocked;
  const warning = anomalies / attempts.length >= RULES.autofixNoPushShare;
  return [finding({
    id: 'autofix-ineffective', severity: warning ? 'warning' : 'info', category: 'Auto-fix',
    title: 'Auto-fix rarely pushes a fix', share: RULES.autofixNoPushShare,
    fact: `${pushes.length} delivered push(es) for ${attempts.length} attempt(s)${failedPushes ? `, ${failedPushes} whose git push failed` : ''}; skip reasons: ${Object.entries(reasons).map(([k, n]) => `${k} ${n}`).join(', ') || 'none recorded'}. `
      + `Blocked by design: ${blocked}${blocked ? ` (${Object.entries(designed).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}; anomaly: ${anomalies}.`,
    hypothesis: warning
      ? (noChanges ? '`no_changes` alone does not prove a fix was needed: the finding may be false, or the context given to the model did not include the files to change (docs/dashboard-partial-diagnosis.md, item 3).' : null)
      : 'The guardrails worked as designed: the attempts stopped on a protected or unshown target, or on files the budget withheld from the prompt. The lever is the input budget (autofix_max_input_tokens, ADR-0017) or a human fix, not the guardrail.',
    impact: `${noPush} attempt(s) ended without a change, usually escalated to a human`, frequency: `${noPush} of ${attempts.length} attempt(s)`,
    items: [...new Set(attempts.map(prOf).filter(Boolean))], eligible: withEvent(runs, 'autofix.start'), runs: runIds(attempts),
    occ: attempts.filter(({ run }) => stepDecision(run, 'autofix')?.key !== 'pushed').map(({ run }) => run.run_id),
    anomaly: attempts.filter(({ run }) => stepDecision(run, 'autofix')?.key !== 'pushed' && !blockedByDesign(run)).map(({ run }) => run.run_id), titleByDesign: 'Auto-fix blocked by design (ADR-0021, ADR-0029)', evidence: evidenceOf(skips.length ? skips : attempts), link: 'health.html#autofix',
  })];
}

// A generation run blocked by design: the patch was rejected only on protected, unshown or withheld targets
// (ADR-0021, ADR-0029, same rule set as auto-fix), or the deterministic check found every path the issue needs
// protected or withheld (`reason: blocked`, `source: denylist`, ADR-0029 amendment). A `source: model` block
// records no cause the records can verify, so it stays an anomaly.
function codegenByDesign(e) {
  if (e.meta.reason === 'blocked') return e.meta.source === 'denylist';
  return e.meta.reason === 'guardrail_rejected' && Array.isArray(e.meta.rules) && e.meta.rules.length > 0 && e.meta.rules.every((r) => DESIGN_RULES.has(r));
}

function generationFindings(runs) {
  const starts = events(runs, 'code_gen.start');
  const blocked = events(runs, 'code_gen.skipped');
  const blockedRuns = new Set(runIds(blocked));
  const genRate = rateAtLastOccurrence(starts, ({ run }) => blockedRuns.has(run.run_id));
  if (!starts.length || blocked.length < 2 || (blocked.length / starts.length < 0.5 && (genRate.n < RULES.minVerdicts || genRate.share < 0.5))) return [];
  const sources = {};
  for (const { e } of blocked) sources[e.meta.source ?? 'unspecified'] = (sources[e.meta.source ?? 'unspecified'] ?? 0) + 1;
  const designed = blocked.filter(({ e }) => codegenByDesign(e));
  const anomalies = blocked.filter(({ e }) => !codegenByDesign(e));
  const sourceText = Object.entries(sources).map(([k, n]) => `${k} ${n}`).join(', ');
  return [finding({
    id: 'codegen-blocked', severity: 'warning', category: 'Code generation', title: 'Code generation is mostly blocked', share: 0.5,
    titleByDesign: 'Code generation blocked by design (ADR-0021, ADR-0029)',
    fact: `${blocked.length} of ${starts.length} generation run(s) produced no patch${sourceText ? ` (source: ${sourceText})` : ''}; ${events(runs, 'code_gen.complete').length} completed. `
      + `Blocked by design (protected or withheld targets): ${designed.length}; anomaly: ${anomalies.length} (the model blocked the issue, or the rejection is not a design rule).`,
    hypothesis: anomalies.length ? 'A model-sourced block usually means the files to change were withheld from its context (size or protected paths); the escalation comment on the issue says which.'
      : 'The guardrails worked as designed: the issues need protected or withheld targets (ADR-0021, ADR-0029). The lever is a human change on those paths, not the guardrail.',
    impact: `${blocked.length} issue(s) escalated instead of getting a PR`, frequency: `${blocked.length} run(s)`,
    eligible: withEvent(runs, 'code_gen.start'), runs: runIds(blocked), anomaly: runIds(anomalies), evidence: evidenceOf(blocked), link: 'flows.html?state=escalated',
  })];
}

function providerFindings(runs) {
  const out = [];
  // Runs that attempted an LLM call: a run that never reached a provider says nothing about its recovery.
  const attemptedLlm = runs.filter((r) => r.llm.length || r.events.some((e) => e.event === 'llm_fallback' || e.event === 'retry.wait'));
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
      eligible: attemptedLlm, runs: runIds(fallbacks), evidence: evidenceOf(fallbacks), link: 'models.html',
    }));
  }
  const waits = events(runs, 'retry.wait').filter(({ e }) => e.meta.status === 429);
  if (waits.length >= RULES.fallbackMin) {
    const ms = waits.reduce((t, { e }) => t + (Number.isFinite(e.meta.wait_ms) ? e.meta.wait_ms : 0), 0);
    out.push(finding({
      id: 'rate-limit-waits', severity: 'info', category: 'LLM provider', title: 'Time lost waiting on rate limits',
      fact: `${waits.length} retry wait(s) on HTTP 429, totalling ${minutes(ms)} across ${runIds(waits).length} run(s).`,
      impact: `${minutes(ms)} of run time spent waiting`, frequency: `${waits.length} wait(s)`,
      eligible: attemptedLlm, runs: runIds(waits), evidence: evidenceOf(waits), link: 'health.html#providers',
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
        eligible: withStage(dated, stage), runs: cur.map((x) => x.run.run_id), evidence: evidenceOf(cur.map((x) => ({ run: x.run, e: null }))), link: 'health.html#performance',
      }));
    }
  }
  const gaps = thin.length ? [{ id: 'duration-thin', title: 'Duration trend not computable', detail: `Fewer than ${RULES.durationMinRuns} runs in one of the two latest 7-day periods for: ${thin.join(', ')}. No degradation is reported for them — that is not the same as no degradation.` }] : [];
  return { findings, gaps };
}

// An open work item escalated to a human is the gate working (ADR-0001): it is listed in "Waiting on you"
// (pipeline_waiting.mjs), not here. A finding is raised only for an escalation the design does not explain
// (ADR-0043 amendment 2026-10-21): no change proposed although a modifiable file was shown, a patch rejected
// for its content, an error of the stage, or a reason the record does not give. A closed or merged item is
// not open (pipeline_journey.mjs), so it never counts.
function interventions(waiting) {
  const open = waiting.filter((w) => !w.by_design);
  if (!open.length) return [];
  const label = (w) => `${w.item?.kind ?? 'item'} #${w.item?.number ?? '?'}`;
  return [finding({
    id: 'escalations', severity: 'warning', category: 'Interventions', title: 'Escalations the design does not explain',
    fact: `${open.length} of ${waiting.length} open work item(s) waiting on a person were escalated for a reason the guardrails do not explain: ${open.map((w) => `${label(w)} (${w.step}: ${w.reason})`).join('; ')}.`,
    impact: `${open.length} item(s) wait on a person and the escalation looks avoidable`, frequency: `${open.length} item(s)`,
    items: open.map((w) => w.item?.number).filter(Boolean),
    runs: [...new Set(open.map((w) => w.run_id))],
    evidence: open.map((w) => ({ run_id: w.run_id, ts: w.since, event: null, summary: w.reason, pr: w.prs.at(-1) ?? null, url: w.url })),
    link: 'index.html#waiting',
  })];
}

// What the records cannot tell: listed as gaps, never as "no problem".
function telemetryGaps(model, journeys) {
  const gaps = [
    { id: 'merge-not-journaled', title: 'Merge is journaled only from item-closed.yml on', detail: 'A merge or a closing is recorded (item.closed) only for items closed after item-closed.yml existed, and only in this repository; the Pipelines page asks GitHub for merged_at in the browser for the rest.' },
    { id: 'closure-before-journal', title: 'Closings before the closing journal are not recorded', detail: 'Only items closed or merged after item-closed.yml was merged have an item.closed event. An item closed before it that last escalated still reads as escalated: the dashboard does not infer a closing from GitHub or from silence. The Pipelines page re-checks pull requests live.' },
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
export function diagnose({ model, journeys = [], protectedPaths } = {}) {
  // Runs that only journal the end of an item executed no step: the rules below judge executions.
  const runs = (model?.runs ?? []).filter((r) => !isLifecycleRun(r));
  if (!runs.length) return { status: 'no_data', findings: [], gaps: model ? telemetryGaps(model, journeys) : [] };
  const durations = durationFindings(runs);
  const findings = [
    ...executionFailures(runs), ...interventions(waitingOnYou({ model, journeys, protectedPaths })), ...reviewFindings(runs), ...autofixFindings(runs),
    ...generationFindings(runs), ...providerFindings(runs), ...durations.findings,
  ].map(withLifecycle).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const status = findings.some((f) => f.severity === 'critical') ? 'critical' : findings.some((f) => f.severity === 'warning') ? 'warning' : 'ok';
  return { status, findings, gaps: [...telemetryGaps(model, journeys), ...durations.gaps] };
}
