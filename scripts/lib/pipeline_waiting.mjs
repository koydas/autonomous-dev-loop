// "Waiting on you" (dashboard Overview, ADR-0043 amendment 2026-10-21): the work items that are open and
// whose last recorded state is an escalation to a human, each with the step, the reason in plain words, the
// files the reason names, the escalation comment and since when. An escalation is the human gate working
// (ADR-0001): the queue carries no severity. Whether the escalation is explained by design (protected or
// withheld target, attempt limit) or not is a separate question, `by_design`, which only the Diagnostics
// finding reads. Pure: records in, rows out; every string comes from a record and is escaped by the renderer.
import { STEPS } from './pipeline_journey.mjs';
import { PROTECTED_FLOOR, entryMatches } from './protected_paths.mjs';
import { safeUrl } from './pipeline_model.mjs';

// Rules of the write guard that stop a patch because of where it points, not because of what it contains
// (ADR-0021, ADR-0029): a guardrail doing its job.
export const DESIGN_RULES = new Set(['protected_path', 'unshown_file', 'withheld_file']);
// Conflicts-fix escalations (ADR-0059) that a structural limit explains: a protected file, a file kind or size the
// model is not given, a registry the PR chose, a token scope. The rest (a post-check, a guard, a parse, npm, a push)
// is a failure of the stage itself.
export const CONFLICT_DESIGN_REASONS = new Set(['protected_path', 'unsupported_conflict', 'binary_file', 'too_large', 'too_many_files', 'lockfile_unsafe', 'workflow_scope']);
const CONFLICT_REASON_TEXT = {
  protected_path: 'a conflicted file is on the protected list (ADR-0021)',
  unsupported_conflict: 'the conflict is a deleted, renamed, symlinked or submodule file',
  binary_file: 'a conflicted file is binary',
  too_large: 'a conflicted file or its hunks exceed the model input budget',
  too_many_files: 'more conflicted files than one run resolves',
  lockfile_unsafe: 'the PR changes the registry configuration, so the lockfile is not regenerated',
  workflow_scope: 'the merge brings workflow changes the token cannot push',
  model_rejected: 'the model resolution failed a post-check', guard_rejected: 'the resolution was rejected by the write guard',
  parse_failed: 'the model answer or the conflict markers could not be read', syntax_error: 'a resolved file does not parse',
  lockfile_failed: 'the lockfile could not be regenerated', push_failed: 'the merge commit could not be pushed',
};
const RULE_TEXT = { protected_path: 'a target file is protected', unshown_file: 'a target file was not shown to the model', withheld_file: 'a target file was withheld from the model' };
const MAX_NAMES = 5;
const MAX_NAME_CHARS = 120;

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, MAX_NAME_CHARS)) : []);
const named = (list) => `${list.slice(0, MAX_NAMES).join(', ')}${list.length > MAX_NAMES ? `, +${list.length - MAX_NAMES} more` : ''}`;
const normalize = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const isProtected = (path, entries) => entries.some((entry) => entryMatches(entry, normalize(path)));

/**
 * Why one escalation happened: `{ kind, by_design, reason, files }`. `esc` is an entry of a journey's
 * `escalations`, `run` the run record it came from (null when not loaded), `protectedPaths` the effective
 * denylist (the hard floor when the repository's own list is unknown to the caller).
 * by_design is false only for what the design does not explain: no change proposed although a modifiable
 * file was shown, a patch rejected for its content, an error of the stage, or a reason the record does not give.
 */
export function explainEscalation(esc, run, protectedPaths = PROTECTED_FLOOR) {
  const events = run?.events ?? [];
  const metaOf = (name) => events.filter((e) => e.event === name).at(-1)?.meta ?? null;
  const meta = events.find((e) => e.event === esc.event && e.ts === esc.ts)?.meta ?? metaOf(esc.event) ?? {};
  const unknown = (reason) => ({ kind: 'unknown', by_design: false, reason, files: [] });

  if (events.some((e) => e.level === 'error' && e.stage === esc.stage && !/\.escalated$/.test(e.event))) {
    return { kind: 'error', by_design: false, reason: `The ${esc.stage ?? 'stage'} recorded an error (LLM call or parsing) before escalating`, files: [] };
  }
  if (esc.event === 'review.escalated') {
    return { kind: 'circuit_breaker', by_design: true, reason: `The same review failure repeated on ${Number.isInteger(meta.streak) ? meta.streak : 'several'} consecutive reviews: the circuit breaker stopped the loop (ADR-0050)`, files: [] };
  }
  if (esc.event === 'conflicts.escalated') {
    const text = CONFLICT_REASON_TEXT[meta.reason];
    if (!text) return unknown('The escalation of conflicts-fix gives no known reason');
    return { kind: `conflicts_${meta.reason}`, by_design: CONFLICT_DESIGN_REASONS.has(meta.reason), reason: `Merge conflicts not resolved by the pipeline: ${text}`, files: [] };
  }
  if (esc.event === 'autofix.max_attempts_reached') {
    return { kind: 'attempt_limit', by_design: true, reason: 'Auto-fix used its attempts without converging: a person has to decide', files: [] };
  }

  const rejected = (rules, files) => {
    if (rules.length && rules.every((r) => DESIGN_RULES.has(r))) {
      return { kind: 'guard_target', by_design: true, reason: `Patch rejected by the write guard: ${[...new Set(rules.map((r) => RULE_TEXT[r]))].join('; ')}${files.length ? ` (${named(files)})` : ''}`, files };
    }
    return { kind: 'guard_content', by_design: false, reason: `Patch rejected by the write guard${rules.length ? ` (${rules.join(', ')})` : ''}: the model's output broke a rule`, files: [] };
  };

  if (esc.event === 'code_gen.escalated') {
    const hidden = strings(metaOf('code_gen.context_built')?.hidden_files);
    if (meta.reason === 'guardrail_rejected') return rejected(strings(meta.rules), hidden);
    if (meta.reason === 'blocked') {
      if (meta.source === 'denylist') return { kind: 'blocked_denylist', by_design: true, reason: `Code generation blocked: every file the issue needs is protected or too large${hidden.length ? ` (${named(hidden)})` : ''}`, files: hidden };
      if (meta.source === 'model' && hidden.length) return { kind: 'blocked_model_hidden', by_design: true, reason: `The model could not implement the issue; files withheld from its context: ${named(hidden)}`, files: hidden };
      if (meta.source === 'model') return { kind: 'blocked_model', by_design: true, reason: 'The model declared the issue blocked although nothing was withheld from it: a person has to decide', files: [] };
      if (meta.source === 'notes_only') return { kind: 'blocked_notes_only', by_design: true, reason: 'The patch only added Markdown notes, not an implementation', files: [] };
    }
    return unknown('The escalation of code generation gives no known reason');
  }

  if (esc.event === 'autofix.escalated') {
    if (meta.reason === 'guardrail_rejected') {
      const withheld = events.filter((e) => e.event === 'autofix.file_withheld').flatMap((e) => strings([e.meta?.path]));
      return rejected(strings(metaOf('autofix.skipped')?.rules), [...new Set(withheld)]);
    }
    if (meta.reason === 'no_changes') {
      const budget = metaOf('autofix.prompt_budget');
      if (!budget) return unknown('No change proposed, and the files shown to the model were not recorded');
      const shown = strings(budget.shown_files);
      const hidden = strings(budget.hidden_files);
      const modifiable = shown.filter((p) => !isProtected(p, protectedPaths));
      if (modifiable.length) return { kind: 'no_changes_modifiable', by_design: false, reason: `No change proposed although ${modifiable.length} modifiable file(s) were shown: ${named(modifiable)}`, files: modifiable };
      if (!shown.length && !hidden.length) return unknown('No change proposed, and no target file was shown or withheld');
      const parts = [hidden.length ? `files withheld by the budget (${named(hidden)})` : null, shown.length ? `only protected files shown (${named(shown)})` : null].filter(Boolean);
      return { kind: 'no_changes_by_design', by_design: true, reason: `No change proposed: ${parts.join('; ')}`, files: [...hidden, ...shown] };
    }
    return unknown('The escalation of auto-fix gives no known reason');
  }
  return unknown('The escalation event is not one the dashboard can explain');
}

const stepName = (stage) => STEPS.find((s) => s.key === stage)?.name ?? stage ?? 'Not recorded';

/**
 * The queue: open work items whose last recorded state is `escalated` (a closed or merged item left it,
 * pipeline_journey.mjs), oldest first. Row: `{ trace_id, item, prs, step, kind, by_design, reason, files, url, run_id, since }`;
 * `url` is the escalation comment when the record has one (https only). Age is rendered from `since`.
 */
export function waitingOnYou({ model, journeys = [], protectedPaths = PROTECTED_FLOOR } = {}) {
  const runs = new Map((model?.runs ?? []).map((r) => [r.run_id, r]));
  return journeys.filter((j) => j.state === 'escalated' && j.escalations.length).map((j) => {
    const esc = j.escalations.at(-1);
    return {
      trace_id: j.trace_id, item: j.item, prs: j.prs, step: stepName(esc.stage), ...explainEscalation(esc, runs.get(esc.run_id) ?? null, protectedPaths),
      url: safeUrl(esc.url), run_id: esc.run_id, since: Number.isFinite(esc.ts) ? esc.ts : null,
    };
  }).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}
