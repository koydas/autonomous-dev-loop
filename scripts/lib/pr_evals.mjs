/**
 * Live eval of a PR's prompt change (ADR-0030, workflow pr-evals.yml).
 *
 * Three jobs, three trust levels:
 *   plan    — no secret. Checks the trigger (label set by a writer, dispatch from the default branch,
 *             PR head unchanged), lists the PR's changes with git and keeps prompts/** only. Refuses a
 *             PR that touches scripts/ or config/, or ships a prompt that is not a regular file.
 *             Writes plan.json with the PR's prompt contents (read as git blobs, never from a worktree).
 *   eval    — LLM secrets. Default-branch checkout; applyPlan() overwrites prompts/** from plan.json,
 *             then the default branch's run_evals.mjs runs. No PR code runs.
 *   comment — no LLM secret. Compares each results file with the last run published on the dashboard
 *             (eval_replay_ci.mjs readers and deltas) and posts the report.
 * Nothing is published to the dashboard: the run measures a PR, not the default branch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { summarize, checkThresholds } from './eval_harness.mjs';
import { diffDataset, metricDeltas, verdictChanges, classifyGate } from './eval_replay_ci.mjs';

export const RUN_EVALS_LABEL = 'run-evals';
export const PLAN_VERSION = 1;
// author_association is absent from `labeled` payloads: the labeler's repository permission is checked instead.
export const TRUSTED_PERMISSIONS = ['admin', 'maintain', 'write'];
export const ALLOWED_REPEATS = [1, 3];
// Changes to these would run with the secrets if they were taken from the PR; they never are, so the
// PR is refused rather than measured with code it does not contain.
export const REFUSED_PREFIXES = ['scripts/', 'config/'];
export const PROMPTS_PREFIX = 'prompts/';
// Prompt file name prefix → eval suite (eval_suites.mjs).
export const SUITE_PROMPT_PREFIXES = { validation: 'prompts/validation-', review: 'prompts/pr-review-' };
export const MAX_PROMPT_BYTES = 64 * 1024;
export const REPORT_MARKER = '<!-- adl-pr-evals -->';

const REGULAR_MODES = new Set(['100644', '100755']);
const MAX_CHANGED_ROWS = 50;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Inline code span for author-controlled text (PR file paths, logins): a newline or a backtick would
// close the span and inject Markdown (headings, links, mentions) into the bot comment; `|` breaks tables.
export const code = (s) => `\`${String(s).replace(/[\u0000-\u001f\u007f]/g, '\ufffd').replace(/`/g, "'").replace(/\|/g, '\\|').slice(0, 200)}\``;

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export const isTrustedPermission = (permission) => TRUSTED_PERMISSIONS.includes(String(permission ?? '').toLowerCase());

export function parseRepeats(value) {
  const n = Number(value === undefined || value === '' ? 1 : value);
  if (!ALLOWED_REPEATS.includes(n)) throw new Error(`repeats must be one of ${ALLOWED_REPEATS.join(', ')} (got "${value}")`);
  return n;
}

// → null when the run may proceed, else the refusal reason.
export function checkTrigger({ eventName, actor, permission, ref, defaultBranch, expectedSha, headSha }) {
  if (!['pull_request_target', 'workflow_dispatch'].includes(eventName)) return `unsupported event "${eventName}"`;
  if (!isTrustedPermission(permission)) return `${code(actor)} has ${code(permission || 'no')} permission on the repository; write access is required`;
  if (eventName === 'workflow_dispatch' && ref !== `refs/heads/${defaultBranch}`) return `dispatched from ${code(ref)}; dispatch from ${code(defaultBranch)}`;
  if (!expectedSha || !headSha) return 'PR head SHA unknown';
  if (expectedSha !== headSha) return `the PR head moved since the trigger (${code(expectedSha.slice(0, 12))} → ${code(headSha.slice(0, 12))}); set the label again`;
  return null;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

// `git diff --raw --no-renames -z` → [{ srcMode, dstMode, status, path }].
export function parseRawDiff(raw) {
  const tokens = String(raw ?? '').split('\0');
  const changes = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i].match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/);
    if (!meta) throw new Error(`Unexpected git diff --raw entry: ${JSON.stringify(tokens[i])}`);
    changes.push({ srcMode: meta[1], dstMode: meta[2], status: meta[3], path: tokens[i + 1] });
  }
  return changes;
}

export function isSafePromptPath(p) {
  return typeof p === 'string' && p.startsWith(PROMPTS_PREFIX) && path.posix.normalize(p) === p && !p.split('/').includes('..') && !p.includes('\\') && !CONTROL_CHARS.test(p);
}

export function suitesForPrompts(paths, prefixes = SUITE_PROMPT_PREFIXES) {
  const suites = Object.entries(prefixes).filter(([, prefix]) => paths.some((p) => p.startsWith(prefix))).map(([suite]) => suite);
  const unmeasured = paths.filter((p) => !Object.values(prefixes).some((prefix) => p.startsWith(prefix)));
  return { suites, unmeasured };
}

// Pure: changes + trigger verdict → plan (without prompt contents).
export function planPrEvals({ changes, triggerRefusal = null, pr = null, headSha = null, actor = null, repeats = 1, prefixes = SUITE_PROMPT_PREFIXES }) {
  const plan = { version: PLAN_VERSION, status: 'run', reason: null, pr, head_sha: headSha, actor, repeats, suites: [], prompts: [], unmeasured: [], ignored: [], refused: [] };
  const refuse = (reason) => Object.assign(plan, { status: 'refused', reason });
  if (triggerRefusal) return refuse(triggerRefusal);

  for (const c of changes) {
    if (REFUSED_PREFIXES.some((prefix) => c.path.startsWith(prefix))) {
      plan.refused.push({ path: c.path, reason: 'pipeline code or config: the run would not use it' });
    } else if (c.path.startsWith(PROMPTS_PREFIX)) {
      if (!isSafePromptPath(c.path)) plan.refused.push({ path: c.path, reason: 'unsafe path' });
      else if (c.status !== 'D' && !REGULAR_MODES.has(c.dstMode)) plan.refused.push({ path: c.path, reason: `not a regular file (mode ${c.dstMode})` });
      else if (!['A', 'M', 'D'].includes(c.status)) plan.refused.push({ path: c.path, reason: `unsupported change type ${c.status}` });
      else plan.prompts.push({ path: c.path, status: c.status });
    } else {
      plan.ignored.push(c.path);
    }
  }
  if (plan.refused.length) return refuse(`the PR changes files this run cannot take from it: ${plan.refused.map((r) => `${code(r.path)} (${r.reason})`).join(', ')}. Split the prompt change into its own PR`);
  if (plan.prompts.length === 0) return Object.assign(plan, { status: 'nothing', reason: 'the PR changes no file under `prompts/`' });

  const { suites, unmeasured } = suitesForPrompts(plan.prompts.map((p) => p.path), prefixes);
  Object.assign(plan, { suites, unmeasured });
  if (suites.length === 0) return Object.assign(plan, { status: 'nothing', reason: `no eval suite covers ${unmeasured.map(code).join(', ')}` });
  return plan;
}

const git = (exec, cwd, args, opts = {}) => exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, ...opts });

// Changes of `head` since its merge base with `base` (the files the PR touches), and the resolved head SHA.
export function collectPrChanges({ head, base = 'HEAD', cwd = process.cwd(), exec = execFileSync }) {
  const headSha = git(exec, cwd, ['rev-parse', '--verify', `${head}^{commit}`], { encoding: 'utf8' }).trim();
  const mergeBase = git(exec, cwd, ['merge-base', base, headSha], { encoding: 'utf8' }).trim();
  const raw = git(exec, cwd, ['diff', '--raw', '--no-renames', '-z', mergeBase, headSha], { encoding: 'utf8' });
  return { headSha, mergeBase, changes: parseRawDiff(raw) };
}

// Prompt contents read from git objects (`git show <sha>:<path>`), never from a checkout of the PR.
// A prompt over MAX_PROMPT_BYTES refuses the plan (reported in the comment), without any content.
export function readPromptContents(plan, { cwd = process.cwd(), exec = execFileSync } = {}) {
  const files = [];
  const oversize = [];
  for (const p of plan.prompts) {
    if (p.status === 'D') {
      files.push({ ...p, content: null });
      continue;
    }
    const buf = git(exec, cwd, ['show', `${plan.head_sha}:${p.path}`]);
    if (buf.length > MAX_PROMPT_BYTES) oversize.push({ path: p.path, reason: `${buf.length} bytes, over the ${MAX_PROMPT_BYTES}-byte limit` });
    else files.push({ ...p, content: buf.toString('utf8') });
  }
  if (oversize.length) {
    return {
      ...plan,
      status: 'refused',
      reason: `prompt too large: ${oversize.map((r) => `${code(r.path)} (${r.reason})`).join(', ')}`,
      prompts: plan.prompts.map(({ path: p, status }) => ({ path: p, status })),
      refused: oversize,
    };
  }
  return { ...plan, prompts: files };
}

// ---------------------------------------------------------------------------
// Apply (eval job)
// ---------------------------------------------------------------------------

export function validatePlanForApply(plan) {
  if (plan?.version !== PLAN_VERSION) throw new Error(`plan: unsupported version ${plan?.version}`);
  if (plan.status !== 'run') throw new Error(`plan: status is "${plan.status}", nothing to apply`);
  if (!Array.isArray(plan.prompts) || plan.prompts.length === 0) throw new Error('plan: no prompt to apply');
  for (const p of plan.prompts) {
    if (!isSafePromptPath(p?.path)) throw new Error(`plan: unsafe prompt path ${JSON.stringify(p?.path)}`);
    if (p.status === 'D') continue;
    if (!['A', 'M'].includes(p.status)) throw new Error(`plan: ${p.path}: unsupported change type ${p.status}`);
    if (typeof p.content !== 'string') throw new Error(`plan: ${p.path}: missing content`);
    if (Buffer.byteLength(p.content) > MAX_PROMPT_BYTES) throw new Error(`plan: ${p.path}: content exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  return plan;
}

// Writes the PR's prompts over the default-branch checkout at `root`. Returns the applied paths.
export function applyPlan(plan, { root = process.cwd(), fsImpl = fs } = {}) {
  validatePlanForApply(plan);
  const promptsDir = path.resolve(root, PROMPTS_PREFIX);
  const applied = [];
  for (const p of plan.prompts) {
    const target = path.resolve(root, p.path);
    if (!target.startsWith(promptsDir + path.sep)) throw new Error(`plan: ${p.path} resolves outside prompts/`);
    // Never write through a link that a default-branch prompt could be.
    if (fsImpl.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${p.path}: refusing to write through a symlink`);
    if (p.status === 'D') {
      fsImpl.rmSync(target, { force: true });
    } else {
      fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      fsImpl.writeFileSync(target, p.content);
    }
    applied.push(`${p.status} ${p.path}`);
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Comparison (comment job)
// ---------------------------------------------------------------------------

const caseIds = (results) => [...new Set(results.map((r) => r.case_id))].map((id) => ({ id }));

// One suite: the PR's live results file vs the last published run (loadPublishedRuns entry).
export function compareSuite({ suite, results, published }) {
  if (!results) return { suite: suite.name, status: 'error', reason: 'no results file (the eval step crashed or was cancelled)' };
  const prFailures = checkThresholds(results.summary, suite.thresholds);
  const base = { suite: suite.name, run: results.meta, summary: results.summary, prFailures };
  if (!published?.recorded) {
    return { ...base, status: 'warn', reason: published?.missing ?? 'no published run', deltas: metricDeltas(null, results.summary), changes: [], gate: { blocking: [], preexisting: [], advisory: prFailures }, notes: [] };
  }
  const { recorded } = published;
  const dataset = diffDataset({ recorded, cases: caseIds(results.results), currentSha: results.meta?.dataset_sha256 ?? null });
  if (results.meta?.dataset_sha256 == null) dataset.status = 'unknown';
  const same = dataset.status === 'same';
  // Same dataset: the published numbers as they are. Otherwise both sides on the common cases.
  const baseline = same ? recorded.summary : summarize(recorded.results.filter((r) => dataset.common.has(r.case_id)));
  const current = same ? results.summary : summarize(results.results.filter((r) => dataset.common.has(r.case_id)));
  const gate = classifyGate({
    replayFailures: prFailures,
    baselineFailures: same ? checkThresholds(recorded.summary, suite.thresholds) : [],
    datasetStatus: dataset.status,
  });
  const notes = [];
  if (!same) notes.push(`dataset ${dataset.status === 'changed' ? 'changed since the published run' : 'hash missing on one side'}: Δ over the ${dataset.common.size} common case(s), thresholds advisory`);
  if ((recorded.meta?.model ?? null) !== (results.meta?.model ?? null)) notes.push(`model differs (main ${code(recorded.meta?.model ?? '?')}, PR ${code(results.meta?.model ?? '?')}): the Δ mixes prompt and model`);
  if ((recorded.meta?.repeats ?? 1) !== (results.meta?.repeats ?? 1)) notes.push(`repeats differ (main ${recorded.meta?.repeats ?? 1}, PR ${results.meta?.repeats ?? 1}): consistency is not comparable; case changes are matched on (case, repeat)`);
  const status = gate.blocking.length ? 'fail' : gate.preexisting.length || gate.advisory.length || notes.length ? 'warn' : 'pass';
  return {
    ...base,
    status,
    published: recorded.meta,
    dataset,
    deltas: metricDeltas(baseline, current),
    changes: verdictChanges(recorded.results, results.results),
    gate,
    notes,
  };
}

const RANK = { pass: 0, warn: 1, fail: 2, error: 3 };
export const overallPrStatus = (reports) => reports.reduce((worst, r) => (RANK[r.status] > RANK[worst] ? r.status : worst), 'pass');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ICON = { pass: '✅', warn: '⚠️', fail: '❌', error: '❌' };
const fmt = (v) => (v == null ? '—' : String(v));
const signed = (d) => (d == null ? '—' : d === 0 ? '=' : d > 0 ? `▲ ${d}` : `▼ ${Math.abs(d)}`);
// Model-derived text: no table break, no mention, no HTML comment.
export const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').replace(/@/g, '@​').replace(/</g, '&lt;').slice(0, 160);

export const PR_EVAL_DISCLAIMER = [
  '> **What this measures.** The suites ran live with this PR\'s `prompts/**` on top of the default branch\'s scripts, harness, config and datasets.',
  '> The baseline is the last live run published on the eval dashboard. This run is **not** published. With 1 repeat, one flipped case moves',
  '> `verdict_match` by 1/cases and the review stage samples at temperature > 0: treat a Δ of one case as noise, re-run with `repeats: 3`.',
].join('\n');

function formatSuite(r, siteUrl) {
  const lines = [`## ${ICON[r.status]} ${code(r.suite)}`, ''];
  if (r.status === 'error') return [...lines, `Not measured: ${r.reason}.`, ''];
  const site = siteUrl ? siteUrl.replace(/\/+$/, '') : null;
  const baseline = r.published
    ? `${site ? `[${r.published.run_id}](${site}/runs/${encodeURIComponent(r.published.run_id)}.html)` : code(r.published.run_id)} · ${fmt(r.published.ts)} · ${code(fmt(r.published.model))} · repeats ${fmt(r.published.repeats)}`
    : `none (${r.reason})`;
  lines.push(`PR run: ${code(fmt(r.run?.model))} · repeats ${fmt(r.run?.repeats)} — baseline: ${baseline}`, '');
  for (const n of r.notes) lines.push(`- ⚠️ ${n}`);
  if (r.notes.length) lines.push('');

  lines.push('| Metric | main (published) | PR | Δ |', '|---|---|---|---|');
  for (const m of r.deltas) lines.push(`| ${code(m.metric)} | ${fmt(m.before)} | ${fmt(m.after)} | ${signed(m.delta)} |`);
  lines.push('');

  const { blocking, preexisting, advisory } = r.gate;
  if (blocking.length) lines.push('**❌ Thresholds missed with the PR prompts (met on main)**', '', ...blocking.map((f) => `- ${code(f.metric)}: ${f.reason}`), '');
  if (preexisting.length) lines.push('**⚠️ Already failing in the published run**', '', ...preexisting.map((f) => `- ${code(f.metric)}: ${f.reason}`), '');
  if (advisory.length) lines.push(`**⚠️ Threshold failures (advisory${r.published ? ', dataset differs' : ', no baseline'})**`, '', ...advisory.map((f) => `- ${code(f.metric)}: ${f.reason}`), '');
  if (!blocking.length && !preexisting.length && !advisory.length) lines.push('All thresholds met.', '');

  if (!r.published) return lines;
  if (r.changes.length === 0) {
    lines.push('No case changes verdict.', '');
  } else {
    lines.push(`**${r.changes.length} case run(s) change verdict**`, '', '| case | repeat | expected | main | PR | error |', '|---|---|---|---|---|---|');
    for (const c of r.changes.slice(0, MAX_CHANGED_ROWS)) lines.push(`| ${code(c.case_id)} | ${c.repeat} | ${fmt(c.expected)} | ${c.before} | ${c.after} | ${cell(c.error)} |`);
    if (r.changes.length > MAX_CHANGED_ROWS) lines.push('', `…and ${r.changes.length - MAX_CHANGED_ROWS} more.`);
    lines.push('');
  }
  return lines;
}

const footer = (runUrl) => (runUrl ? ['', `[Workflow run](${runUrl})`] : []);

export function formatPrEvalReport({ plan, reports = [], siteUrl, runUrl, warnings = [] }) {
  if (!plan) {
    return [REPORT_MARKER, '# ❌ Live eval failed before planning', '', 'No plan was produced; see the workflow run. The `run-evals` label was removed.', ...footer(runUrl)].join('\n');
  }
  if (plan.status === 'refused') {
    const lines = [REPORT_MARKER, '# ⛔ Live eval refused', '', `Reason: ${plan.reason}.`, ''];
    if (plan.refused.length) lines.push('| File | Why |', '|---|---|', ...plan.refused.map((r) => `| ${code(r.path)} | ${r.reason} |`), '');
    lines.push('The secrets-holding job runs the default branch\'s scripts and config and takes only `prompts/**` from the PR (ADR-0030). The `run-evals` label was removed.');
    return [...lines, ...footer(runUrl)].join('\n');
  }
  if (plan.status === 'nothing') {
    return [REPORT_MARKER, '# ⚪ Live eval: nothing to run', '', `Reason: ${plan.reason}. Suites are picked from the changed prompts: \`prompts/validation-*\` → \`validation\`, \`prompts/pr-review-*\` → \`review\`.`, ...footer(runUrl)].join('\n');
  }
  const lines = [REPORT_MARKER, `# ${ICON[overallPrStatus(reports)]} Live eval of this PR's prompts`, '', PR_EVAL_DISCLAIMER, ''];
  lines.push(`Prompts from ${code(String(plan.head_sha).slice(0, 12))}: ${plan.prompts.map((p) => `${code(p.path)} (${p.status})`).join(', ')} · suites ${plan.suites.map(code).join(', ')} · repeats ${plan.repeats} · triggered by ${code(plan.actor)}`, '');
  if (plan.unmeasured.length) lines.push(`- ⚠️ No eval suite covers ${plan.unmeasured.map(code).join(', ')}`);
  if (plan.ignored.length) lines.push(`- Other changed files are not used (default-branch version instead): ${plan.ignored.slice(0, 20).map(code).join(', ')}${plan.ignored.length > 20 ? ', …' : ''}`);
  for (const w of warnings) lines.push(`- ⚠️ ${w}`);
  if (plan.unmeasured.length || plan.ignored.length || warnings.length) lines.push('');
  for (const r of reports) lines.push(...formatSuite(r, siteUrl));
  return [...lines, ...footer(runUrl)].join('\n');
}

// Entry used by scripts/report_pr_evals.mjs. resultsBySuite: { [suite]: results file | undefined }.
// loadPublished(names) → loadPublishedRuns() result.
export async function buildPrEvalReport({ plan, suites, resultsBySuite = {}, loadPublished, siteUrl, runUrl }) {
  if (!plan || plan.status !== 'run') return { status: plan ? plan.status : 'error', markdown: formatPrEvalReport({ plan, runUrl }), reports: [] };
  const selected = plan.suites.map((name) => {
    if (!suites[name]) throw new Error(`plan names unknown suite "${name}"`);
    return suites[name];
  });
  const published = await loadPublished(plan.suites);
  const warnings = published.available ? published.warnings : [`eval dashboard unreachable (${published.reason}): no baseline`];
  const reports = selected.map((suite) => compareSuite({
    suite,
    results: resultsBySuite[suite.name],
    published: published.available ? published.suites[suite.name] : { missing: 'dashboard unreachable' },
  }));
  return { status: overallPrStatus(reports), markdown: formatPrEvalReport({ plan, reports, siteUrl, runUrl, warnings }), reports };
}
