#!/usr/bin/env node
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { requireEnv, loadLLMConfig, loadLabelsConfig } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { filterDiff, shouldIncludeFile } from './lib/file_filters.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles, GuardrailError } from './lib/output_writer.mjs';
import { log, error as logError, setLogContext, logStart, logEnd, logSummary } from './lib/logger.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { retryWithBackoff, transientHttpError, isRetrySafeGitHubRequest } from './lib/retry.mjs';
import { writeCheckpoint, readCheckpoint } from './lib/checkpoint.mjs';
import { appendMetric, estimateTokens } from './lib/metrics.mjs';
import { findUnsafeChanges, normalizeRepoPath } from './lib/autofix_guard.mjs';
import { parseReviewMarker, decideAutofixRun, hasNoProposedChanges, isCommitSha, findReviewComment } from './lib/review_marker.mjs';
import { randomUUID } from 'node:crypto';

let tracer;

process.on('unhandledRejection', async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  logSummary({ success: false, stepsCompleted: [], errors: [err.message] });
  obsLog({ stage: 'autofix', event: 'autofix.error', level: 'error', meta: { error: err.message } });
  tracer?.endSpan('autofix', { outcome: 'failed', meta: { error: err.message } });
  await tracer?.finalize('failed');
  process.exit(1);
});

const MAX_ATTEMPTS = 3;
const MAX_FILE_SIZE = 8000;
const MAX_FILES = 5;
const ATTEMPT_LABEL_PREFIX = 'auto-fix-attempt-';
const TOKEN_SAFETY_MARGIN = 200;

const MODEL_CONTEXT_WINDOW = {
  'qwen/qwen3-32b': 32768, // retired by Groq 2026-07-17 (ADR-0025)
  'llama-3.1-8b-instant': 32768,
  'llama-3.3-70b-versatile': 131072, // retired by Groq 2026-08-16 (ADR-0025)
  'openai/gpt-oss-120b': 131072,
  'claude-opus-4-7': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5-20251001': 200000,
};

function truncateToTokenBudget(text, tokenBudget) {
  if (tokenBudget <= 0) return '';
  const maxChars = tokenBudget * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

const TRUSTED_COMMENT_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

function isManualRerunRequested(eventPayload) {
  const action = eventPayload?.action;
  const body = eventPayload?.comment?.body || '';
  if (!['created', 'edited'].includes(action) || typeof body !== 'string') return false;
  // Defense in depth: do not rely on the workflow `if:` filter alone.
  if (!TRUSTED_COMMENT_ASSOCIATIONS.includes(eventPayload?.comment?.author_association)) return false;
  return /-\s*\[x\]\s*(relancer\s+auto\s*fixer|rerun\s+auto\s*-?\s*fix(er)?)/i.test(body);
}

const CHECKPOINT_DIR = path.resolve('./checkpoints');

// Layout matches lib/checkpoint.mjs: checkpoints/<runId>/<step>.json. Only the
// `autofix` step is reset; `review.json` is a workflow prerequisite and must survive.
async function cleanupCheckpointFiles(checkpointRunId) {
  const autofixFile = path.join(CHECKPOINT_DIR, String(checkpointRunId), 'autofix.json');
  try {
    await fsPromises.unlink(autofixFile);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return [path.relative(CHECKPOINT_DIR, autofixFile)];
}

const githubToken = requireEnv('GITHUB_TOKEN');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');
const { provider: llmProvider, apiKey: llmApiKey, model, apiUrl, temperature: llmTemperature, maxTokens: llmMaxTokens, maxInputTokens: cfgMaxInputTokens, diffRatio: cfgDiffRatio, feedbackRatio: cfgFeedbackRatio, reasoningEffort } = loadLLMConfig('autofix');
const systemPrompt = loadPrompt('auto-fix-system');
const userPromptTemplate = loadPrompt('auto-fix-user');

let event;
try {
  event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`, { cause: err });
}
if (!event || typeof event !== 'object') throw new Error('GitHub event payload is not a valid object');

const prNumber = event.pull_request?.number ?? event.issue?.number;
if (!prNumber) throw new Error('Missing GitHub payload field: expected pull_request.number or issue.number');

// Defense in depth: the workflow `if:` already filters issue_comment events, but the
// script must not run the LLM loop for any comment that is not a trusted rerun request.
if (event.issue && event.comment && !isManualRerunRequested(event)) {
  log('Ignoring issue_comment event: not a trusted manual rerun request', {
    prNumber,
    authorAssociation: event.comment.author_association ?? null,
  });
  process.exit(0);
}

const reviewBody = (event.review?.body || '').trim();
const reviewId = event.review?.id;

const [owner, repo] = repository.split('/');
const githubApiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').trim();

const githubHeaders = {
  Authorization: `Bearer ${githubToken}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function ghFetch(endpoint, options = {}) {
  // 429/5xx are retried (ADR-0022); every other status is returned unchanged so callers
  // keep checking .ok. When retries are exhausted, the last 429/5xx Response is returned.
  // Non-retry-safe POSTs (comments) are not replayed after a 5xx or network error.
  const retrySafe = isRetrySafeGitHubRequest(options.method, endpoint);
  let lastTransientRes = null;
  try {
    return await retryWithBackoff(async () => {
      lastTransientRes = null;
      let res;
      try {
        res = await fetch(`${githubApiBase}${endpoint}`, {
          ...options,
          headers: { ...githubHeaders, ...(options.headers || {}) },
        });
      } catch (fetchErr) {
        if (!retrySafe) fetchErr.retryable = false;
        throw fetchErr;
      }
      const transientErr = transientHttpError(res, `GitHub API (${endpoint})`, { retrySafe });
      if (transientErr) {
        lastTransientRes = res;
        throw transientErr;
      }
      return res;
    });
  } catch (err) {
    if (lastTransientRes) return lastTransientRes;
    throw new Error(`Network error calling GitHub API (${endpoint}): ${err.message}`, { cause: err });
  }
}

// GET /issues/{n}/comments lists oldest first and ignores sort/direction: read every page,
// then keep the most recent comment by a trusted author (review_marker.mjs).
async function loadLatestAutomatedReviewComment() {
  const comments = [];
  for (let page = 1; ; page++) {
    const commentsRes = await ghFetch(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!commentsRes.ok) {
      logError('Automated review comment fallback fetch failed', { prNumber, statusCode: commentsRes.status, page });
      return null;
    }

    const batch = await commentsRes.json();
    if (!Array.isArray(batch)) break;
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return findReviewComment(comments, '## \u{1F50D} Automated Code Review')?.body ?? null;
}

const runId = process.env.GITHUB_RUN_ID ?? randomUUID();
const traceDir = path.join(process.cwd(), 'observability', 'traces');
tracer = createTracer({ runId, issueNumber: null, traceDir });
tracer.startSpan('autofix', { prNumber });

let nextAttempt = null;
let autofixStartMs = Date.now();

async function applyAttemptLabel(attempt) {
  const attemptLabelName = `${ATTEMPT_LABEL_PREFIX}${attempt}`;
  const createLabelRes = await ghFetch(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: attemptLabelName,
      color: 'fbca04',
      description: `Auto-fix iteration ${attempt}`,
    }),
  });
  if (!createLabelRes.ok && createLabelRes.status !== 422) {
    throw new Error(`Auto-fix label create failed: ${createLabelRes.status}`);
  }

  const applyLabelRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [attemptLabelName] }),
  });
  if (!applyLabelRes.ok) {
    throw new Error(`Auto-fix label apply failed: ${applyLabelRes.status}`);
  }
}

// No-op exit (ADR-0028): no push, no failed check.
async function skipAutofix(reason, meta = {}, level = 'info') {
  log('Auto-fix skipped', { prNumber, reason, ...meta });
  obsLog({ stage: 'autofix', event: 'autofix.skipped', level, duration_ms: Date.now() - autofixStartMs, meta: { reason, attempt: nextAttempt, prNumber, ...meta } });
  tracer.endSpan('autofix', { outcome: 'skipped', meta: { reason } });
  await tracer.finalize('partial');
  process.exit(0);
}

try {
// A changes-requested label can outlive its review: when the latest automated review
// approved the current head, there is nothing to fix and no LLM call is made. An explicit
// checkbox rerun by a trusted human still runs.
const prMetaRes = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`);
if (!prMetaRes.ok) throw new Error(`PR metadata fetch failed: ${prMetaRes.status}`);
const prMeta = await prMetaRes.json();
const headSha = isCommitSha(prMeta?.head?.sha) ? prMeta.head.sha : null;
const latestReviewCommentBody = await loadLatestAutomatedReviewComment();
const autofixDecision = decideAutofixRun({ headSha, previous: parseReviewMarker(latestReviewCommentBody), manualRerun: isManualRerunRequested(event) });
if (!autofixDecision.run) await skipAutofix(autofixDecision.reason, { headSha });

const labelsRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`);
if (!labelsRes.ok) throw new Error(`Label list failed: ${labelsRes.status}`);
const prLabels = await labelsRes.json();

const manualRerunRequested = isManualRerunRequested(event);
if (manualRerunRequested) {
  const attemptLabels = prLabels
    .map((l) => l.name)
    .filter((name) => name.startsWith(ATTEMPT_LABEL_PREFIX));
  for (const labelName of attemptLabels) {
    const removeRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(labelName)}`, { method: 'DELETE' });
    if (!removeRes.ok && removeRes.status !== 404) {
      throw new Error(`Failed to remove label ${labelName}: ${removeRes.status}`);
    }
  }
  const removedCheckpointFiles = await cleanupCheckpointFiles(process.env.CHECKPOINT_RUN_ID ?? `pr-${prNumber}`);
  if (process.env.GITHUB_OUTPUT) {
    await fsPromises.appendFile(
      process.env.GITHUB_OUTPUT,
      `attempt_number=1\nsummary<<EOF\nManual auto-fix reset triggered via checkbox.\nEOF\n`,
      'utf8',
    );
  }
  log('Manual auto-fix rerun requested via comment checkbox', { prNumber, removedLabels: attemptLabels.length, removedCheckpointFiles: removedCheckpointFiles.length });
}

const refreshedLabelsRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`);
if (!refreshedLabelsRes.ok) throw new Error(`Label list failed after reset: ${refreshedLabelsRes.status}`);
const refreshedLabels = await refreshedLabelsRes.json();
const attemptCount = refreshedLabels.filter((l) => l.name.startsWith(ATTEMPT_LABEL_PREFIX)).length;

if (attemptCount >= MAX_ATTEMPTS) {
  const exhaustedBody = `## \u{1F92A} Auto-Fix Exhausted\n\nMaximum auto-fix attempts (${MAX_ATTEMPTS}) reached on this PR. Please review the remaining issues manually.`;
  await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: exhaustedBody }),
  });
  log('Max auto-fix attempts reached', { prNumber, attemptCount });
  obsLog({ stage: 'autofix', event: 'autofix.max_attempts_reached', level: 'warn', meta: { attempt: MAX_ATTEMPTS, prNumber } });
  tracer.startSpan('autofix', { prNumber, attempt: MAX_ATTEMPTS });
  tracer.endSpan('autofix', { outcome: 'skipped', meta: { reason: 'max_attempts_reached' } });
  await tracer.finalize('partial');

  const exhaustedRunId = process.env.CHECKPOINT_RUN_ID ?? `pr-${prNumber}`;
  const exhaustedMetricsCheckpoint = await readCheckpoint(exhaustedRunId, 'pr_metrics');
  if (exhaustedMetricsCheckpoint?.data) {
    const m = exhaustedMetricsCheckpoint.data;
    await appendMetric({
      type: 'pr',
      run_id: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}` : `local-${Date.now()}`,
      pr_number: prNumber,
      issue_number: m.issue_number,
      final_verdict: 'MANUAL',
      review_cycles: m.review_cycles,
      request_changes_count: m.request_changes_count,
      auto_fix_pushes: m.auto_fix_pushes,
      started_at: m.started_at,
      ended_at: new Date().toISOString(),
      total_input_tokens_est: m.total_input_tokens_est,
      total_output_tokens_est: m.total_output_tokens_est,
    });
    log('PR metrics recorded', { prNumber, verdict: 'MANUAL' });
  }

  process.exit(0);
}

nextAttempt = attemptCount + 1;
autofixStartMs = Date.now();

log('Starting auto-fix', { prNumber, attempt: nextAttempt });
obsLog({ stage: 'autofix', event: 'autofix.start', level: 'info', meta: { attempt: nextAttempt, prNumber } });
tracer.startSpan('autofix', { prNumber, attempt: nextAttempt });

setLogContext({ run_id: runId, step: 'auto-fix', attempt: nextAttempt });

const feedbackParts = [];
if (reviewBody) feedbackParts.push(reviewBody);

if (reviewId) {
  const inlineRes = await ghFetch(
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
  );
  if (!inlineRes.ok) {
    throw new Error(`Review inline comments fetch failed: ${inlineRes.status}`);
  }
  const inlineComments = await inlineRes.json();
  for (const c of inlineComments) {
    feedbackParts.push(`**${c.path}** (line ${c.original_line || c.line || '?'}):\n${c.body}`);
  }
}

if (!feedbackParts.length) {
  if (latestReviewCommentBody) {
    feedbackParts.push(latestReviewCommentBody);
    log('Using latest automated review comment as feedback fallback', { prNumber });
  }
}

const effectiveDiffRatio = cfgDiffRatio ?? 0.15;
const effectiveFeedbackRatio = cfgFeedbackRatio ?? 0.25;
if (effectiveDiffRatio + effectiveFeedbackRatio >= 1) {
  throw new Error(`Token budget config error: autofix_diff_ratio (${effectiveDiffRatio}) + autofix_feedback_ratio (${effectiveFeedbackRatio}) must sum to less than 1.0; adjust config/models.yaml`);
}

const systemTokens = estimateTokens(systemPrompt);
const userWrapperTokens = estimateTokens(userPromptTemplate.replace(/\{\{[^}]+\}\}/g, ''));
const contextWindow = MODEL_CONTEXT_WINDOW[model] ?? (llmProvider === 'groq' ? 32768 : 200000);
const maxOutputBudget = llmMaxTokens ?? 4096;
const contextWindowBudget = Math.max(0, contextWindow - TOKEN_SAFETY_MARGIN - systemTokens - maxOutputBudget);
const rawInputBudget = cfgMaxInputTokens != null ? Math.min(contextWindowBudget, cfgMaxInputTokens) : contextWindowBudget;
const inputBudget = Math.max(0, rawInputBudget - userWrapperTokens);
const diffBudget = Math.floor(inputBudget * effectiveDiffRatio);
const feedbackBudget = Math.floor(inputBudget * effectiveFeedbackRatio);
const fileBudget = Math.max(0, inputBudget - diffBudget - feedbackBudget);

const reviewFeedback = truncateToTokenBudget(
  feedbackParts.join('\n\n---\n\n') || '(No specific review feedback provided)',
  feedbackBudget,
);

const diffRes = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  headers: { Accept: 'application/vnd.github.v3.diff' },
});
if (!diffRes.ok) throw new Error(`Diff fetch failed: ${diffRes.status}`);
const rawDiff = await diffRes.text();
const diff = truncateToTokenBudget(filterDiff(rawDiff, diffBudget * 4), diffBudget);

const allChangedFiles = [...new Set([...rawDiff.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]))];

const SELF_PATH = 'scripts/auto_fix_pr.mjs';
if (allChangedFiles.includes(SELF_PATH)) {
  await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body: `## 🤖 Auto-Fix Skipped\n\nThis PR modifies \`${SELF_PATH}\`. Automated self-modification is disabled to prevent feedback loops. Please review and merge this PR manually.`,
    }),
  });
  log('Auto-fix skipped: PR modifies auto_fix_pr.mjs itself', { prNumber });
  tracer.endSpan('autofix', { outcome: 'skipped', meta: { reason: 'self_modification' } });
  await tracer.finalize('partial');
  process.exit(0);
}

const changedFiles = allChangedFiles.filter(shouldIncludeFile);

const repoRoot = path.resolve(process.cwd());
// A file is either shown in full or withheld with an explicit marker — never cut silently:
// the model returns whole files, so a truncated view becomes deleted content (ADR-0029).
const fileContentParts = [];
const shownPaths = new Set();
const hiddenPaths = new Set();
let fileCharsLeft = fileBudget * 4;
for (const filePath of changedFiles.slice(0, MAX_FILES)) {
  const absPath = path.resolve(repoRoot, filePath);
  if (!absPath.startsWith(repoRoot + path.sep)) continue;
  let content;
  try {
    content = await fsPromises.readFile(absPath, 'utf8');
  } catch {
    continue; // File deleted or unreadable — skip
  }
  const part = `### Current file: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
  if (content.length <= MAX_FILE_SIZE && part.length <= fileCharsLeft) {
    fileContentParts.push(part);
    shownPaths.add(normalizeRepoPath(filePath));
    fileCharsLeft -= part.length + 2;
  } else {
    const marker = `### File withheld (too large for the context budget): ${filePath} — do NOT target this file`;
    fileContentParts.push(marker);
    hiddenPaths.add(normalizeRepoPath(filePath));
    fileCharsLeft -= marker.length + 2;
  }
}
const fileContents =
  fileContentParts.length > 0
    ? fileContentParts.join('\n\n')
    : 'No existing files identified as relevant to this review.';

const userPrompt = interpolatePrompt(userPromptTemplate, {
  reviewFeedback,
  diff,
  fileContents,
});

log('token_estimate', {
  system: systemTokens,
  wrapper: userWrapperTokens,
  diff: estimateTokens(diff),
  feedback: estimateTokens(reviewFeedback),
  files: estimateTokens(fileContents),
  max_tokens: maxOutputBudget,
  budget: { input: inputBudget, diff: diffBudget, feedback: feedbackBudget, files: fileBudget },
  total: systemTokens + userWrapperTokens + estimateTokens(diff) + estimateTokens(reviewFeedback) + estimateTokens(fileContents) + maxOutputBudget,
});

const inputTokensEst = estimateTokens(systemPrompt + userPrompt);
obsLog({ stage: 'autofix', event: 'autofix.llm_request', level: 'info', meta: { model, input_tokens_est: inputTokensEst, attempt: nextAttempt, prNumber } });

const raw = await callLLM({
  prompt: userPrompt,
  systemPrompt,
  apiKey: llmApiKey,
  model,
  apiUrl,
  temperature: llmTemperature,
  maxTokens: maxOutputBudget,
  responseFormat: null,
  reasoningEffort,
});

obsLog({ stage: 'autofix', event: 'autofix.llm_response', level: 'info', meta: { output_tokens_est: estimateTokens(raw), attempt: nextAttempt, prNumber } });

let aiOutput;
try {
  aiOutput = parseJsonResponse(raw);
} catch (parseErr) {
  logError('AI response was not valid JSON', { preview: raw.slice(0, 500) });
  obsLog({ stage: 'autofix', event: 'autofix.error', level: 'error', duration_ms: Date.now() - autofixStartMs, meta: { error: 'JSON parse failed', attempt: nextAttempt, prNumber } });
  tracer.endSpan('autofix', { outcome: 'failed', meta: { error: 'JSON parse failed' } });
  await tracer.finalize('failed');
  throw new Error(`AI response was not valid JSON: ${parseErr.message}`, { cause: parseErr });
}
if (!aiOutput || typeof aiOutput !== 'object' || Array.isArray(aiOutput)) {
  obsLog({ stage: 'autofix', event: 'autofix.error', level: 'error', duration_ms: Date.now() - autofixStartMs, meta: { error: 'invalid JSON shape', attempt: nextAttempt, prNumber } });
  tracer.endSpan('autofix', { outcome: 'failed', meta: { error: 'invalid JSON shape' } });
  await tracer.finalize('failed');
  throw new Error('AI response JSON must be an object');
}

// Surface the run to a human and count the attempt so re-triggers stay capped. Exits 0 without a push.
async function escalateToHuman(reason, heading, explanation, details) {
  await applyAttemptLabel(nextAttempt);
  const needsHuman = loadLabelsConfig('autofix').needs_human;
  const createNeedsHumanRes = await ghFetch(`/repos/${owner}/${repo}/labels`, { method: 'POST', body: JSON.stringify(needsHuman) });
  if (!createNeedsHumanRes.ok && createNeedsHumanRes.status !== 422) {
    throw new Error(`Label create failed for "${needsHuman.name}": ${createNeedsHumanRes.status}`);
  }
  const applyNeedsHumanRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, { method: 'POST', body: JSON.stringify({ labels: [needsHuman.name] }) });
  if (!applyNeedsHumanRes.ok) throw new Error(`Add label "${needsHuman.name}" failed: ${applyNeedsHumanRes.status}`);
  const escalationRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body: `## ${heading}\n\nAttempt ${nextAttempt}/${MAX_ATTEMPTS}: ${explanation} A human needs to decide (\`${needsHuman.name}\`).\n\n${details}`,
    }),
  });
  if (!escalationRes.ok) throw new Error(`Escalation comment failed (${reason}): ${escalationRes.status}`);
  await appendMetric({
    type: 'autofix_skip',
    run_id: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}-autofix-skip` : `local-${Date.now()}`,
    pr_number: prNumber,
    attempt: nextAttempt,
    reason,
    ts: new Date().toISOString(),
  });
  await skipAutofix(reason, {}, 'warn');
}

// Reviewer and fixer disagree, or the model declined with a blocked_reason.
if (hasNoProposedChanges(aiOutput)) {
  // Model text lands in a PR comment: one line, bounded.
  const modelSummary = String(aiOutput.blocked_reason || aiOutput.summary || '(no summary)').replace(/\s+/g, ' ').trim().slice(0, 500);
  await escalateToHuman(
    'no_changes',
    '\u{1F914} Auto-Fix: No Changes Proposed',
    'the model proposed no change for the review feedback, so the reviewer and the fixer disagree.',
    `**Model summary:** ${modelSummary}`,
  );
}

// The write guard (ADR-0029), the write denylist and the shrink guard (ADR-0021, ADR-0009)
// reject the patch before any write.
let summary;
let outputPaths;
try {
  const validated = validateAiOutput(aiOutput);
  summary = validated.summary;
  const existing = new Map();
  for (const { targetPath } of validated.changes) {
    const key = normalizeRepoPath(targetPath);
    try {
      existing.set(key, await fsPromises.readFile(path.resolve(repoRoot, key), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      existing.set(key, null);
    }
  }
  const violations = findUnsafeChanges(validated.changes, { existing, shownPaths, hiddenPaths });
  if (violations.length) throw new GuardrailError(violations.map((v) => `\`${v.targetPath}\`: ${v.reason}`).join('; '));
  outputPaths = await writeGeneratedFiles(validated.changes);
} catch (rejection) {
  if (!(rejection instanceof GuardrailError)) throw rejection;
  await escalateToHuman(
    'guardrail_rejected',
    '\u{1F6E1}\u{FE0F} Auto-Fix: Patch Rejected',
    'the proposed patch was rejected by the output guardrails, so nothing was written or pushed.',
    `**Reason:** ${String(rejection.message).slice(0, 2000)}`,
  );
}

obsLog({ stage: 'autofix', event: 'autofix.push', level: 'info', duration_ms: Date.now() - autofixStartMs, meta: { paths: outputPaths, attempt: nextAttempt, prNumber } });

await applyAttemptLabel(nextAttempt);

if (process.env.GITHUB_OUTPUT) {
  await fsPromises.appendFile(
    process.env.GITHUB_OUTPUT,
    `fixed_paths<<EOF\n${outputPaths.join('\n')}\nEOF\nattempt_number=${nextAttempt}\nsummary<<EOF\n${summary}\nEOF\n`,
    'utf8',
  );
}

const checkpointRunId = process.env.CHECKPOINT_RUN_ID ?? `pr-${prNumber}`;
await writeCheckpoint(checkpointRunId, 'autofix', { prNumber, attempt: nextAttempt, outputPaths });
log('Checkpoint written', { runId: checkpointRunId, step: 'autofix' });

const prMetricsCheckpoint = await readCheckpoint(checkpointRunId, 'pr_metrics');
const prMetrics = prMetricsCheckpoint?.data ?? {
  pr_number: prNumber,
  issue_number: null,
  started_at: new Date().toISOString(),
  request_changes_count: 0,
  auto_fix_pushes: 0,
  review_cycles: 0,
  total_input_tokens_est: 0,
  total_output_tokens_est: 0,
};
await writeCheckpoint(checkpointRunId, 'pr_metrics', {
  ...prMetrics,
  auto_fix_pushes: prMetrics.auto_fix_pushes + 1,
  total_input_tokens_est: prMetrics.total_input_tokens_est + estimateTokens(systemPrompt + userPrompt),
  total_output_tokens_est: prMetrics.total_output_tokens_est + estimateTokens(raw),
});
log('PR metrics checkpoint updated', { prNumber, auto_fix_pushes: prMetrics.auto_fix_pushes + 1 });

tracer.endSpan('autofix', { outcome: 'success', meta: { attempt: nextAttempt, paths: outputPaths } });
await tracer.finalize('partial');

log('Auto-fix complete', { prNumber, attempt: nextAttempt, paths: outputPaths.join(', ') });
} catch (err) {
  obsLog({ stage: 'autofix', event: 'autofix.error', level: 'error', duration_ms: Date.now() - autofixStartMs, meta: { error: err.message, attempt: nextAttempt, prNumber } });
  tracer.endSpan('autofix', { outcome: 'failed', meta: { error: err.message } });
  await tracer.finalize('failed');
  throw err;
}
