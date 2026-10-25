#!/usr/bin/env node
/**
 * conflicts-fix (ADR-0059): brings a conflicting PR up to date with its base by merging the base into the head.
 * Runs in a checkout of the PR head (the PR tree is data, ADR-0023) with the pipeline from the default branch:
 *   fetch base → mergeForward (L0 merge, L1 lockfile, L2 model hunks, mechanical ADR renumber, guards) → push
 * or, on any refusal, abort the merge, label `needs-human` and say which file stopped it and why.
 * Env: GITHUB_TOKEN (the PAT: a GITHUB_TOKEN push triggers no workflow), GITHUB_REPOSITORY, PR_NUMBER,
 *   CONFLICTS_MANUAL (workflow_dispatch: bypasses the attempt cap and the breaker for this run),
 *   GITHUB_SERVER_URL, GITHUB_API_URL, GITHUB_RUN_ID, GITHUB_OUTPUT, and the provider keys of the `conflicts` stage.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLLMConfig } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';
import { loadLabelsConfigAll } from './lib/layered_config.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { prWorkItemHint } from './lib/trace_context.mjs';
import { appendOutputs } from './lib/github_output.mjs';
import { estimateTokens } from './lib/metrics.mjs';
import {
  classifyMergeability, canPushToHead, decideConflictRun, formatConflictMarker, latestConflictMarker, nextConflictStreak,
} from './lib/conflicts.mjs';
import { createRequest, paginate, addLabel, removeLabel, postComment, conflictLabels } from './lib/conflicts_github.mjs';
import { mergeForward, cleanEnv } from './lib/conflicts_engine.mjs';
import { hunkCharBudget } from './lib/conflict_resolver.mjs';
import { readPr } from './detect_conflicts.mjs';

const STAGE = 'conflicts';
const SAFE_REF = /^[A-Za-z0-9._/@+-]+$/;
const BASE_REMOTE_REF = 'refs/adl/base';

const HEADINGS = {
  resolved: '✅ Merge conflicts resolved',
  escalated: '🛡️ Merge conflicts: a human needs to decide',
};
const REASON_TEXT = {
  protected_path: 'a conflicted file is on the protected list (ADR-0021) and no resolver is allowed to write it',
  unsupported_conflict: 'the conflict is not a content conflict on a regular file (deleted, renamed, symlink or submodule)',
  binary_file: 'a conflicted file is binary',
  too_large: 'a conflicted file or its hunks exceed what one model call accepts',
  too_many_files: 'more conflicted files than the model resolves in one run',
  parse_failed: 'the model answer or the conflict markers could not be read',
  model_rejected: 'the model resolution failed a post-check',
  guard_rejected: 'the resolution was rejected by the write guard (ADR-0029)',
  syntax_error: 'a resolved file does not parse',
  lockfile_failed: 'the lockfile could not be regenerated',
  lockfile_unsafe: 'the pull request changes the registry configuration, so the lockfile is not regenerated',
  push_failed: 'the merge commit could not be pushed',
  workflow_scope: 'the merge brings changes to `.github/workflows/`, which the pipeline token cannot push',
  fork_not_writable: 'the head branch is a fork that does not allow maintainer edits',
};

// Names go into a comment: no markdown or line-break injection from a branch's file names.
const shown = (p) => `\`${String(p).replace(/[`\r\n]/g, '')}\``;

/** git with the token in the environment (never in argv, where `ps` shows it) for one network call. */
export function gitNetwork(args, { cwd, token, serverUrl = 'https://github.com' }) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const host = new URL(serverUrl).origin;
  const env = cleanEnv({
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${host}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
  const res = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
  return { ok: res.status === 0, stderr: (res.stderr ?? '').replace(basic, '***') };
}

function escalationBody({ reason, blocked = [], rules = [], attempt, max, sig, headSha, streak }) {
  return [
    `## ${HEADINGS.escalated}`,
    '',
    `Attempt ${attempt}/${max}: ${REASON_TEXT[reason] ?? reason}. Nothing was pushed; a human needs to decide (\`needs-human\`).`,
    '',
    blocked.length ? `**Files:** ${blocked.map(shown).join(', ')}` : '',
    rules.length ? `**Rules:** ${rules.join(', ')}` : '',
    '',
    'Merge the base branch into this branch by hand, or fix the cause and re-run the *Conflicts fix* workflow with this PR number (a manual run bypasses the attempt cap).',
    '',
    formatConflictMarker({ sha: headSha, outcome: 'escalated', sig, streak }),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

function resolvedBody({ result, baseRef, newSha }) {
  return [
    `## ${HEADINGS.resolved}`,
    '',
    `Merged \`${baseRef}\` into this branch (${result.rung}${result.hunks ? `, ${result.hunks} hunk(s) resolved by the model` : ''}): ${result.files.length ? result.files.map(shown).join(', ') : 'no conflict'}.`,
    result.renumbered.length ? `ADR renumbered: ${result.renumbered.map((r) => `${r.from} → ${r.to}`).join(', ')} (the base kept its number).` : '',
    '',
    'The merge commit changes the head, so the review runs again on it. Review the merge commit before merging: the guards bound the size and shape of a resolution, not its meaning.',
    '',
    formatConflictMarker({ sha: newSha, outcome: 'resolved' }),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/**
 * The whole run for one PR, with its side effects injected so the tests drive it end to end.
 * @returns {Promise<{ outcome: string, reason?: string }>}
 */
export async function runConflictsFix({ request, repository, prNumber, labels, cwd, manual = false, token, serverUrl, fetchBase = gitNetwork, push = gitNetwork, merge = mergeForward, readOptions = {}, makeCallModel = null }) {
  const { conflicting, attempts, needsHuman } = conflictLabels(labels);
  const pr = await readPr(request, prNumber, readOptions);
  obsLog({ stage: STAGE, event: 'trace.work_item', level: 'info', meta: prWorkItemHint(pr) });
  const skip = (reason, extra = {}) => {
    obsLog({ stage: STAGE, event: 'conflicts.skipped', level: 'info', meta: { prNumber, reason, ...extra } });
    return { outcome: 'skipped', reason };
  };

  const state = classifyMergeability(pr);
  if (state !== 'conflicting') return skip(state);
  if (!canPushToHead(pr, repository)) return skip('fork_not_writable');
  const headRef = pr.head.ref;
  const baseRef = pr.base.ref;
  if (!SAFE_REF.test(headRef) || !SAFE_REF.test(baseRef)) return skip('unsafe_ref');

  const has = new Set((pr.labels ?? []).map((l) => l.name));
  const attemptCount = attempts.filter((a) => has.has(a.name)).length;
  const comments = await paginate(request, `/issues/${prNumber}/comments`);
  const previous = latestConflictMarker(comments);
  const capped = decideConflictRun({ attempts: attemptCount, previous, sig: null, manual });
  if (!capped.run) return skip(capped.reason, { attempt: attemptCount });
  const attempt = manual ? Math.min(attemptCount + 1, attempts.length) : attemptCount + 1;
  obsLog({ stage: STAGE, event: 'conflicts.start', level: 'info', meta: { prNumber, attempt } });

  const fetchedFrom = new URL(`/${repository}.git`, serverUrl).href;
  const fetched = fetchBase(['fetch', '--no-tags', fetchedFrom, `+refs/heads/${baseRef}:${BASE_REMOTE_REF}`], { cwd, token, serverUrl });
  if (!fetched.ok) throw new Error('Fetching the base branch failed');
  const baseSha = spawnSync('git', ['rev-parse', BASE_REMOTE_REF], { cwd, env: cleanEnv(), encoding: 'utf8' }).stdout.trim();

  const cfg = makeCallModel ? makeCallModel() : null;
  const result = await merge({
    cwd, baseSha, baseRef, title: pr.title ?? '', prNumber,
    budgetChars: cfg?.budgetChars ?? 0, callModel: cfg?.callModel ?? null,
    beforeResolve: ({ sig }) => {
      const decision = decideConflictRun({ attempts: attemptCount, previous, sig, manual });
      return decision.run ? null : decision.reason;
    },
  });
  const sig = result.sig;
  const headSha = result.headSha;

  if (result.outcome === 'noop') return skip('up_to_date');

  if (result.outcome === 'escalated' && (result.reason === 'circuit_open')) return skip('circuit_open', { sig });

  if (result.outcome === 'resolved') {
    const pushed = push(['push', new URL(`/${pr.head.repo.full_name}.git`, serverUrl).href, `HEAD:refs/heads/${headRef}`], { cwd, token, serverUrl });
    if (!pushed.ok) {
      const reason = /workflow/i.test(pushed.stderr) ? 'workflow_scope' : 'push_failed';
      return escalate({ ...result, outcome: 'escalated', reason, files: [], blocked: [] });
    }
    const newSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, env: cleanEnv(), encoding: 'utf8' }).stdout.trim();
    obsLog({ stage: STAGE, event: 'conflicts.push', level: 'info', meta: { prNumber, attempt, head_sha: newSha, files_count: result.files.length } });
    await addLabel(request, prNumber, attempts[attempt - 1]);
    await removeLabel(request, prNumber, conflicting.name);
    const url = await postComment(request, prNumber, resolvedBody({ result, baseRef, newSha }));
    obsLog({ stage: STAGE, event: 'conflicts.resolved', level: 'info', meta: { prNumber, attempt, rung: result.rung, files_count: result.files.length, hunks: result.hunks, renumbered: result.renumbered.length, url } });
    return { outcome: 'resolved' };
  }
  return escalate(result);

  async function escalate(r) {
    const streak = nextConflictStreak(previous, r.sig ?? sig);
    await addLabel(request, prNumber, attempts[attempt - 1]);
    await addLabel(request, prNumber, needsHuman);
    const url = await postComment(request, prNumber, escalationBody({ reason: r.reason, blocked: r.blocked, rules: r.rules, attempt, max: attempts.length, sig: r.sig ?? sig, headSha, streak }));
    obsLog({ stage: STAGE, event: 'conflicts.escalated', level: 'warn', meta: { prNumber, attempt, reason: r.reason, rules: r.rules ?? [], labels_added: [attempts[attempt - 1].name, needsHuman.name], url } });
    return { outcome: 'escalated', reason: r.reason };
  }
}

/** The model call of the `conflicts` stage, or null when no provider key is set (the run then escalates, it does not fail). */
export function modelFor() {
  let cfg;
  try { cfg = loadLLMConfig('conflicts'); } catch (err) {
    obsLog({ stage: STAGE, event: 'conflicts.model_unavailable', level: 'warn', meta: { error: err.message } });
    return null;
  }
  const systemPrompt = loadPrompt('conflicts-system');
  const userTemplate = loadPrompt('conflicts-user');
  const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(userTemplate.replace(/\{\{[^}]+\}\}/g, ''));
  return {
    budgetChars: hunkCharBudget({ maxInputTokens: cfg.maxInputTokens ?? 60000, fixedTokens }),
    async callModel({ hunks, path: file, resolver, title }) {
      const prompt = interpolatePrompt(userTemplate, { path: file, resolver, title, hunks });
      obsLog({ stage: STAGE, event: 'conflicts.llm_request', level: 'info', meta: { model: cfg.model, input_tokens_est: estimateTokens(systemPrompt + prompt) } });
      const raw = await callLLM({
        stage: 'conflicts', prompt, systemPrompt, apiKey: cfg.apiKey, model: cfg.model, apiUrl: cfg.apiUrl,
        temperature: cfg.temperature, maxTokens: cfg.maxTokens ?? 4096, responseFormat: null, reasoningEffort: cfg.reasoningEffort,
      });
      obsLog({ stage: STAGE, event: 'conflicts.llm_response', level: 'info', meta: { output_tokens_est: estimateTokens(raw) } });
      return raw;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const startMs = Date.now();
  const env = process.env;
  const tracer = createTracer({ runId: env.GITHUB_RUN_ID ?? `local-${Date.now()}`, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  const prNumber = Number.parseInt(env.PR_NUMBER ?? '', 10);
  try {
    if (!Number.isInteger(prNumber) || prNumber <= 0 || !env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) {
      throw new Error('PR_NUMBER (positive integer), GITHUB_REPOSITORY and GITHUB_TOKEN are required');
    }
    tracer.startSpan(STAGE, { prNumber });
    const outcome = await runConflictsFix({
      request: createRequest({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY, apiBase: env.GITHUB_API_URL || undefined }),
      repository: env.GITHUB_REPOSITORY, prNumber, labels: loadLabelsConfigAll(env), cwd: process.cwd(),
      manual: env.CONFLICTS_MANUAL === 'true', token: env.GITHUB_TOKEN, serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
      makeCallModel: modelFor,
    });
    appendOutputs([['outcome', outcome.outcome], ['reason', outcome.reason ?? '']]);
    obsLog({ stage: STAGE, event: 'conflicts.complete', level: 'info', duration_ms: Date.now() - startMs, meta: { prNumber, outcome: outcome.outcome } });
    tracer.endSpan(STAGE, { outcome: outcome.outcome === 'escalated' ? 'skipped' : 'success', meta: { prNumber } });
    await tracer.finalize('success');
  } catch (err) {
    obsLog({ stage: STAGE, event: 'conflicts.error', level: 'error', duration_ms: Date.now() - startMs, meta: { prNumber, error: err.message } });
    tracer.endSpan(STAGE, { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
