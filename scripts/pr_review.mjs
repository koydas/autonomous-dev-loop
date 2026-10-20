#!/usr/bin/env node

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { requireEnv, loadLLMConfig, loadLabelsConfig, GROQ_MODEL_DEFAULTS, reviewMaxDiffChars } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadPrompt } from './lib/prompts.mjs';
import { buildReviewPrompt, loadReviewSystemPrompt, formatUnreviewedCodeNote, formatUnseenFindingsNote, parseReviewVerdict, withholdOnUnreviewedCode } from './lib/review_prompt.mjs';
import { log, error as logError } from './lib/logger.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { prWorkItemHint } from './lib/trace_context.mjs';
import { retryWithBackoff, transientHttpError, isRetrySafeGitHubRequest } from './lib/retry.mjs';
import { buildDependencyManifestContext } from './lib/dependency_manifest.mjs';
import { lstatPrTreePath, readPrTreeFile, PR_TREE_MAX_BYTES } from './lib/pr_tree_reader.mjs';
import { writeCheckpoint, readCheckpoint } from './lib/checkpoint.mjs';
import { appendMetric, estimateTokens } from './lib/metrics.mjs';
import { parseReviewMarker, formatReviewMarker, eventHeadSha, decideReviewRun, isCommitSha, findReviewComment, stripReviewMarkers } from './lib/review_marker.mjs';
import { findStaleReferences, formatStaleRefsContext, formatStaleRefsSection } from './lib/stale_refs.mjs';
import { findRelatedAdrs } from './lib/related_adrs.mjs';
import { computePromptBudgetImpact, formatPromptBudgetContext, formatPromptBudgetSection } from './lib/prompt_budget.mjs';
import { modelsFromContent, loadReviewGuidelines } from './lib/layered_config.mjs';
import { repoConfigFile, configRelPath, isSelfTarget } from './lib/roots.mjs';
import { parseEvidence, assessEvidence, findTouchedEvidencePaths, formatEvidenceSection, decideVerdict, formatWithheldNote } from './lib/review_evidence.mjs';

const _reviewStartedAt = new Date().toISOString();
const _reviewStartMs = Date.now();

function extractIssueNumber(text) {
  const m = (text ?? '').match(/[Cc]loses?\s+#(\d+)/);
  return m ? Number(m[1]) : null;
}

const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
const traceDir = path.join(process.cwd(), 'observability', 'traces');
let tracer;

process.on('unhandledRejection', async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  obsLog({ stage: 'review', event: 'review.error', level: 'error', duration_ms: Date.now() - _reviewStartMs, meta: { error: err.message } });
  tracer?.endSpan('review', { outcome: 'failed', meta: { error: err.message } });
  await tracer?.finalize('failed');
  process.exit(1);
});

const githubToken = requireEnv('GITHUB_TOKEN');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');
const { provider: llmProvider, apiKey: llmApiKey, model, apiUrl, temperature, maxTokens: llmMaxTokens, maxInputTokens, reasoningEffort } = loadLLMConfig('review');
// ADR-0038 amendment: Anthropic has no input budget, its diff is capped at anthropic_review_max_diff_chars instead.
const maxDiffChars = reviewMaxDiffChars(llmProvider);
// ADR-0045: the rules, gates and budget impact written for this repository apply to this repository only.
const selfTarget = isSelfTarget();
const systemPrompt = loadReviewSystemPrompt({ self: selfTarget, guidelines: selfTarget ? '' : loadReviewGuidelines() });
const userPromptTemplate = loadPrompt('pr-review-user');

let event;
try {
  event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`, { cause: err });
}
if (!event || typeof event !== 'object') throw new Error('GitHub event payload is not a valid object');

const [owner, repo] = repository.split('/');

const githubApiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').trim();

const githubHeaders = {
  Authorization: `Bearer ${githubToken}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const reviewLabels = loadLabelsConfig('review');
const PR_REVIEW_LABELS = [reviewLabels.approved, reviewLabels.changes, reviewLabels.withheld];
// ADR-0034: an APPROVE closes the fix loop, so the auto-fix state it leaves behind (needs-human,
// auto-fix-attempt-N) is cleared and the next red head starts with the full attempt budget.
const AUTOFIX_LABELS_CLEARED_ON_APPROVE = Object.values(loadLabelsConfig('autofix')).map((label) => label.name);
const HEADING = '## 🔍 Automated Code Review';

let prNumber = event.pull_request?.number;
if (!prNumber) {
  const branch = event.pull_request?.head?.ref || event.ref?.replace('refs/heads/', '');
  if (!branch) {
    throw new Error('Missing GitHub payload field: expected pull_request.number or one of pull_request.head.ref / ref');
  }
  const prsRes = await ghFetch(`/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`);
  if (!prsRes.ok) throw new Error(`PR lookup failed: ${prsRes.status}`);
  const prs = await prsRes.json();
  if (!prs.length) {
    log('No open PR found for branch, skipping review');
    writeSkippedOutput();
    process.exit(0);
  }
  prNumber = prs[0].number;
}

tracer = createTracer({ runId, issueNumber: null, traceDir });
obsLog({ stage: 'review', event: 'review.start', level: 'info', meta: { prNumber, model } });
tracer.startSpan('review', { prNumber, model });

// pr-review.yml skips the checkpoint upload for a run that reviewed nothing, so it cannot
// replace the newest checkpoints-pr-<N> artifact with an older copy.
function writeSkippedOutput() {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skipped=true\n', 'utf8');
}

async function ghFetch(path, options = {}) {
  // 429/5xx are retried (ADR-0022); every other status is returned unchanged so callers
  // keep checking .ok. When retries are exhausted, the last 429/5xx Response is returned.
  // Non-retry-safe POSTs (comments, reviews) are not replayed after a 5xx or network error.
  const retrySafe = isRetrySafeGitHubRequest(options.method, path);
  let lastTransientRes = null;
  try {
    return await retryWithBackoff(async () => {
      lastTransientRes = null;
      let res;
      try {
        res = await fetch(`${githubApiBase}${path}`, {
          ...options,
          headers: { ...githubHeaders, ...(options.headers || {}) },
        });
      } catch (err) {
        throw Object.assign(
          new Error(`Network error calling GitHub API (${path}): ${err.message}`, { cause: err }),
          retrySafe ? {} : { retryable: false },
        );
      }
      const transientErr = transientHttpError(res, `GitHub API (${path})`, { retrySafe });
      if (transientErr) {
        lastTransientRes = res;
        throw transientErr;
      }
      return res;
    });
  } catch (err) {
    if (lastTransientRes) return lastTransientRes;
    throw err;
  }
}

// ADR-0040: the html_url GitHub returns for a created/updated object, for the run journal; never throws.
const htmlUrlOf = (res) => Promise.resolve().then(() => res.json()).then((o) => o?.html_url ?? null, () => null);

async function upsertLabel(label) {
  const createRes = await ghFetch(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify(label),
  });
  if (createRes.status === 201) return;
  if (createRes.status !== 422) {
    throw new Error(`Label create failed for "${label.name}": ${createRes.status}`);
  }
  const updateRes = await ghFetch(
    `/repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`,
    { method: 'PATCH', body: JSON.stringify(label) },
  );
  if (!updateRes.ok) {
    throw new Error(`Label update failed for "${label.name}": ${updateRes.status}`);
  }
}

async function addLabel(labelName) {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [labelName] }),
  });
  if (!res.ok) throw new Error(`Add label "${labelName}" failed: ${res.status}`);
}

async function removeLabel(labelName) {
  const res = await ghFetch(
    `/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(labelName)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Remove label "${labelName}" failed: ${res.status}`);
  }
}

async function hasActiveAutoFixRun(branchName) {
  const encodedBranch = encodeURIComponent(branchName);
  // `pending` = waiting on the per-PR concurrency group (ADR-0020).
  for (const status of ['in_progress', 'queued', 'pending']) {
    let runsRes;
    try {
      runsRes = await ghFetch(
        `/repos/${owner}/${repo}/actions/workflows/auto-fix-pr.yml/runs?branch=${encodedBranch}&event=pull_request&status=${status}&per_page=20`,
      );
    } catch (err) {
      logError('Auto-fix run status check failed; defaulting to skip re-pulse', { prNumber, status, error: err.message });
      return true;
    }
    if (!runsRes.ok) {
      logError('Auto-fix run status check failed; defaulting to skip re-pulse', {
        prNumber,
        statusCode: runsRes.status,
        status,
      });
      return true;
    }
    const payload = await runsRes.json();
    const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    const hasMatch = runs.some((run) => run?.head_branch === branchName);
    if (hasMatch) return true;
  }
  return false;
}

try {
const [prMetaRes, diffRes] = await Promise.all([
  ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`),
  ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
  }),
]);
if (!prMetaRes.ok) throw new Error(`PR metadata fetch failed: ${prMetaRes.status}`);
if (!diffRes.ok) throw new Error(`Diff fetch failed: ${diffRes.status}`);

const prMeta = await prMetaRes.json();
// ADR-0041: a push-triggered review has no PR body or head ref in its payload; the work item of the
// trace (branch ai/issue-<n>, else the first issue the body closes) comes from the PR itself. Numbers only.
obsLog({ stage: 'review', event: 'trace.work_item', level: 'info', meta: prWorkItemHint(prMeta) });
const rawDiff = await diffRes.text();

// ADR-0028: one LLM review per head SHA. Read before the LLM call; the upsert below reuses it.
const comments = [];
for (let page = 1; ; page++) {
  const commentsRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
  if (!commentsRes.ok) throw new Error(`Comment list failed: ${commentsRes.status}`);
  const batch = await commentsRes.json();
  if (!Array.isArray(batch)) break;
  comments.push(...batch);
  if (batch.length < 100) break;
}
const existing = findReviewComment(comments, HEADING);
const headSha = isCommitSha(prMeta?.head?.sha) ? prMeta.head.sha : null;
const runDecision = decideReviewRun({
  eventSha: eventHeadSha(event),
  headSha,
  previous: parseReviewMarker(existing?.body),
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? 1,
});
if (!runDecision.run) {
  log('Skipping review: no LLM call for this run', { prNumber, reason: runDecision.reason, eventSha: eventHeadSha(event), headSha });
  obsLog({ stage: 'review', event: 'review.skipped', level: 'info', duration_ms: Date.now() - _reviewStartMs, meta: { reason: runDecision.reason, prNumber, headSha } });
  tracer.endSpan('review', { outcome: 'skipped', meta: { reason: runDecision.reason } });
  await tracer.finalize('partial');
  writeSkippedOutput();
  process.exit(0);
}

const prTitle = prMeta.title || '';
const prBody = prMeta.body || '(no description provided)';

const dependencyManifestContext = await buildDependencyManifestContext(process.cwd());
// ADR-0035 / ADR-0036: text searches over the PR tree (the working directory, data only per ADR-0023).
// A listing or read error is logged as a warn event and yields no result; it never aborts the review.
// The PR tree is untrusted: a symlink (to /dev/zero, or out of the tree) is never listed nor followed,
// and no file over PR_TREE_MAX_BYTES is read (shared reader, scripts/lib/pr_tree_reader.mjs; F22).
// An oversized file is skipped like a non-regular one, with one review.file_skipped warn event.
const repoRoot = process.cwd();
const skippedLarge = new Set();
const skipLarge = (p, size) => {
  if (skippedLarge.has(p)) return;
  skippedLarge.add(p);
  obsLog({ stage: 'review', event: 'review.file_skipped', level: 'warn', meta: { path: p, reason: 'too_large', size, max_bytes: PR_TREE_MAX_BYTES } });
};
const isRegularFile = (p) => {
  try {
    const kind = lstatPrTreePath(repoRoot, p);
    if (kind.kind === 'file' && kind.size > PR_TREE_MAX_BYTES) {
      skipLarge(p, kind.size);
      return false;
    }
    return kind.kind === 'file';
  } catch {
    return false;
  }
};
const repoFiles = {
  listFiles: () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter((p) => p && isRegularFile(p)),
  readFile: (p) => {
    const read = readPrTreeFile(repoRoot, p, { maxBytes: PR_TREE_MAX_BYTES });
    if (read.kind === 'file') return read.content;
    if (read.kind === 'missing') throw Object.assign(new Error(`${p} does not exist`), { code: 'ENOENT' });
    if (read.kind === 'too_large') {
      skipLarge(p, read.size);
      throw Object.assign(new Error(`${p} is over ${PR_TREE_MAX_BYTES} bytes`), { code: 'EFBIG' });
    }
    throw Object.assign(new Error(`${p} is not a regular file`), { code: 'ENOTREG' });
  },
};
const staleRefs = findStaleReferences({ rawDiff, ...repoFiles });
const relatedAdrs = findRelatedAdrs({ rawDiff, ...repoFiles });
log('Review context searched', { prNumber, staleRefs: staleRefs.length, relatedAdrs: relatedAdrs.map((a) => a.id) });
// ADR-0037: token cost of changed prompts/*.md. Base side at the merge base (the .diff is base...head),
// head side and config/models.yaml from the PR tree (trusted defaults when the PR tree has none).
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const baseSha = isCommitSha(prMeta?.base?.sha) ? prMeta.base.sha : null;
let mergeBase = baseSha;
if (baseSha && headSha) {
  try {
    mergeBase = git(['merge-base', baseSha, headSha]).trim();
  } catch {
    mergeBase = baseSha;
  }
}
const readHeadOrNull = (p) => {
  try {
    return repoFiles.readFile(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};
// A non-regular or unreadable config/models.yaml (symlink, FIFO, …) is treated as missing: trusted
// defaults, one warn event, never followed and never an abort.
const readPrModels = () => {
  try {
    return readHeadOrNull(`${configRelPath()}/models.yaml`);
  } catch (err) {
    obsLog({ stage: 'review', event: 'review.models_config_ignored', level: 'warn', meta: { path: `${configRelPath()}/models.yaml`, error: err.message } });
    return null;
  }
};
const prModels = readPrModels();
// The PR's models file, on top of the pipeline defaults for a target repository (ADR-0045); a file the
// layering rejects (unknown key) is ignored with one warn event, like an unreadable one.
const prModelsOrDefaults = (content) => {
  try {
    return modelsFromContent(content);
  } catch (err) {
    obsLog({ stage: 'review', event: 'review.models_config_ignored', level: 'warn', meta: { path: `${configRelPath()}/models.yaml`, error: err.message } });
    return GROQ_MODEL_DEFAULTS;
  }
};
const promptBudget = !selfTarget ? [] : computePromptBudgetImpact({
  rawDiff,
  readBase: (p) => {
    if (!mergeBase) throw new Error('PR base SHA unknown');
    return git(['show', `${mergeBase}:${p}`]);
  },
  readHead: readHeadOrNull,
  models: prModels == null ? GROQ_MODEL_DEFAULTS : prModelsOrDefaults(prModels),
});
if (promptBudget.length) log('Prompt budget impact', { prNumber, promptBudget });
const evidencePath = process.env.REVIEW_EVIDENCE_PATH ?? path.join('evidence', 'review-evidence.json');
const evidenceParse = fs.existsSync(evidencePath)
  ? parseEvidence(fs.readFileSync(evidencePath, 'utf8'))
  : { ok: false, reason: `no evidence file at ${evidencePath}` };
const evidence = assessEvidence(evidenceParse, {
  prHeadSha: prMeta?.head?.sha ?? null,
  touchedPaths: findTouchedEvidencePaths(rawDiff),
});
log('Review evidence assessed', { prNumber, state: evidence.state, reason: evidence.reason, failing: evidence.failing, unverified: evidence.unverified });
obsLog({ stage: 'review', event: 'review.evidence_assessed', level: 'info', meta: { prNumber, state: evidence.state, reason: evidence.reason ?? null, failing: evidence.failing, unverified: evidence.unverified } });
// ADR-0028: input × 1.10 + review_max_tokens must fit one 8K TPM window, else Groq answers 413.
// Shrinks the diff, then the PR body; throws (no LLM call) when the fixed part alone is over.
// ADR-0036: the related-ADR block is dropped before the diff or the body is shrunk.
const { userPrompt, diffTruncated, bodyTruncated, adrCount, unreviewedCodeFiles, shownFiles } = buildReviewPrompt({
  systemPrompt, userPromptTemplate, rawDiff, prTitle, prBody, maxInputTokens, maxDiffChars, evidence, dependencyManifestContext,
  staleRefsContext: formatStaleRefsContext(staleRefs), relatedAdrs, promptBudgetContext: formatPromptBudgetContext(promptBudget),
  automationGates: selfTarget,
});
if (diffTruncated || bodyTruncated) log('Review prompt truncated to fit the token budget', { prNumber, diffTruncated, bodyTruncated, maxInputTokens, maxDiffChars, unreviewedCodeFiles });
if (adrCount < relatedAdrs.length) log('Related ADRs left out of the review prompt', { prNumber, shown: adrCount, found: relatedAdrs.length, maxInputTokens });
if (diffTruncated || bodyTruncated || adrCount < relatedAdrs.length) {
  obsLog({ stage: 'review', event: 'review.prompt_truncated', level: 'warn', meta: { prNumber, diff_truncated: diffTruncated, body_truncated: bodyTruncated, unreviewed_code_files: unreviewedCodeFiles.length, adrs_shown: adrCount, adrs_found: relatedAdrs.length, max_input_tokens: maxInputTokens } });
}

obsLog({ stage: 'review', event: 'review.llm_request', level: 'info', meta: { model, input_tokens_est: estimateTokens(systemPrompt + userPrompt), prNumber } });

const rawReview = await callLLM({
  stage: 'review',
  prompt: userPrompt,
  systemPrompt,
  apiKey: llmApiKey,
  model,
  apiUrl,
  temperature,
  maxTokens: llmMaxTokens,
  responseFormat: null,
  reasoningEffort,
});

obsLog({ stage: 'review', event: 'review.llm_response', level: 'info', meta: { output_tokens_est: estimateTokens(rawReview), prNumber } });

// No verdict line (e.g. a truncated review) fails closed: not approved.
const { cleanReview, verdict: llmVerdict } = parseReviewVerdict(rawReview);
const llmApproved = llmVerdict === 'APPROVED';
// ADR-0024: a failing check blocks APPROVE in code, whatever the LLM concluded.
// ADR-0026: evidence that is missing, stale or unverified withholds APPROVE without requesting changes.
// Same resolution as run_review_evidence.mjs: without a config the repo has not opted in to evidence.
const evidenceConfigPath = process.env.REVIEW_EVIDENCE_CONFIG ?? repoConfigFile('review-evidence.yaml');
const evidenceDecision = decideVerdict(llmApproved, evidence, { evidenceRequired: fs.existsSync(evidenceConfigPath) });
// ADR-0038: an approval of a diff whose code was cut to the budget is withheld; a human reviews the rest.
// So is a REQUEST_CHANGES whose findings all cite only cut code files (#219), unless a check failed.
const { verdict, reason: verdictReason } = withholdOnUnreviewedCode(evidenceDecision, unreviewedCodeFiles, cleanReview, { checksFailed: evidence.failing.length > 0, shownFiles });
const withheldForUnreviewedCode = evidenceDecision.verdict === 'APPROVE' && verdict === 'WITHHELD';
const withheldForUnseenFindings = evidenceDecision.verdict === 'REQUEST_CHANGES' && verdict === 'WITHHELD';
const evidenceOverride = llmApproved && verdict === 'REQUEST_CHANGES';
const isApproved = verdict === 'APPROVE';
const isWithheld = verdict === 'WITHHELD';
const reviewEvent = isApproved ? 'APPROVE' : isWithheld ? 'COMMENT' : 'REQUEST_CHANGES';

const reviewText = cleanReview.includes(HEADING) ? cleanReview : `${HEADING}\n\n${cleanReview}`;
// ADR-0035 / ADR-0037: stale references and prompt budget impact are informational; they never change the verdict above.
const evidenceSection = formatEvidenceSection(evidence, { overridden: evidenceOverride }) + formatStaleRefsSection(staleRefs) + formatPromptBudgetSection(promptBudget) + (isWithheld ? (withheldForUnreviewedCode ? formatUnreviewedCodeNote(unreviewedCodeFiles) : withheldForUnseenFindings ? formatUnseenFindingsNote(unreviewedCodeFiles) : formatWithheldNote(verdictReason)) : '');
// Auto-fix truncates its feedback from the end: when a check failed, its output goes right after the heading.
const reviewMarker = headSha ? `\n\n${formatReviewMarker({ sha: headSha, verdict })}` : '';
const body = stripReviewMarkers(evidence.failing.length > 0
  ? `${HEADING}\n${evidenceSection}\n\n${reviewText.replace(HEADING, '').trim()}`
  : `${reviewText}\n${evidenceSection}`) + reviewMarker;

const commentUrl = existing
  ? `/repos/${owner}/${repo}/issues/comments/${existing.id}`
  : `/repos/${owner}/${repo}/issues/${prNumber}/comments`;
const commentMethod = existing ? 'PATCH' : 'POST';

const postRes = await ghFetch(commentUrl, {
  method: commentMethod,
  body: JSON.stringify({ body }),
});
if (!postRes.ok) throw new Error(`Comment upsert failed: ${postRes.status} ${await postRes.text()}`);

log(`PR review comment ${existing ? 'updated' : 'posted'}`, { prNumber });
obsLog({ stage: 'review', event: 'review.comment_posted', level: 'info', meta: { prNumber, action: existing ? 'updated' : 'created', headSha, url: await htmlUrlOf(postRes) } });

const shortReviewBody = isApproved
  ? 'Automated review passed. See the review comment for details.'
  : isWithheld
    ? (withheldForUnreviewedCode
      ? 'Approval withheld: code was cut from the reviewed diff. See the review comment for details.'
      : withheldForUnseenFindings
        ? 'Changes not requested: every finding cites only code cut from the reviewed diff. See the review comment for details.'
        : 'Approval withheld: the tool evidence is unverified. See the review comment for details.')
    : 'Changes required. See the automated review comment above for details.';

function isOwnPullRequestApprovalFailure(status, detail) {
  if (status !== 422) return false;
  const ownPrPattern = /can not (?:approve|request changes on) your own pull request/i;
  if (ownPrPattern.test(detail)) return true;
  try {
    const parsed = JSON.parse(detail);
    const errors = Array.isArray(parsed?.errors) ? parsed.errors.map(String) : [];
    return errors.some((entry) => ownPrPattern.test(entry));
  } catch {
    return false;
  }
}

const reviewRes = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
  method: 'POST',
  // Same marker as the comment: tools reading PR feedback tell this review from a human one
  // posted with the same token (AI_PR_TOKEN). Informational: verdicts are read from the comment only.
  body: JSON.stringify({
    body: shortReviewBody + reviewMarker,
    event: reviewEvent,
  }),
});
if (!reviewRes.ok) {
  const detail = await reviewRes.text();
  const permissionLikeFailure =
    reviewRes.status === 422 ||
    reviewRes.status === 403 ||
    (reviewRes.status === 401 && /permission|not permitted|resource not accessible/i.test(detail));
  const ownPrApprovalFailure = isOwnPullRequestApprovalFailure(reviewRes.status, detail);
  if (ownPrApprovalFailure) {
    logError('PR review submit skipped: GitHub rejected the review because the actor opened the pull request. Continuing with review comment and labels.', {
      prNumber,
      status: reviewRes.status,
    });
    obsLog({ stage: 'review', event: 'review.review_submitted', level: 'warn', meta: { prNumber, review_event: reviewEvent, skipped: 'own_pull_request', url: null } });
  } else if (permissionLikeFailure) {
    throw new Error(
      `Review submit failed due to permission/configuration issue: ${reviewRes.status} ${detail}`,
    );
  } else {
    throw new Error(`Review submit failed: ${reviewRes.status} ${detail}`);
  }
} else {
  log('PR review submitted', { prNumber, event: reviewEvent });
  obsLog({ stage: 'review', event: 'review.review_submitted', level: 'info', meta: { prNumber, review_event: reviewEvent, url: await htmlUrlOf(reviewRes) } });
}

for (const label of PR_REVIEW_LABELS) {
  await upsertLabel(label);
  log('Label upserted', { label: label.name });
}

if (isWithheld) {
  // review-approved would be wrong and changes-requested would start auto-fix (ADR-0026);
  // review-withheld keeps the PR findable in the label state machine.
  await removeLabel(reviewLabels.approved.name);
  await removeLabel(reviewLabels.changes.name);
  await addLabel(reviewLabels.withheld.name);
  log('PR review labels applied: approval withheld', { prNumber, added: reviewLabels.withheld.name, reason: verdictReason });
  obsLog({ stage: 'review', event: 'review.labels_applied', level: 'info', meta: { prNumber, added: [reviewLabels.withheld.name], removed: [reviewLabels.approved.name, reviewLabels.changes.name] } });
} else {
  const apply = isApproved ? reviewLabels.approved.name : reviewLabels.changes.name;
  const remove = isApproved ? reviewLabels.changes.name : reviewLabels.approved.name;

  let autoFixAlreadyRunning = false;
  if (!isApproved) {
    const branchName = prMeta?.head?.ref;
    autoFixAlreadyRunning = branchName ? await hasActiveAutoFixRun(branchName) : false;
    if (autoFixAlreadyRunning) {
      log('Skipping changes-requested re-pulse because auto-fix is already running', {
        prNumber,
        branchName,
      });
    } else {
      // Re-pulse the changes-requested label on every iteration so auto-fix
      // reliably receives a new `pull_request:labeled` trigger.
      await removeLabel(apply);
    }
  }

  await addLabel(apply);
  await removeLabel(remove);
  await removeLabel(reviewLabels.withheld.name);
  if (isApproved) {
    for (const name of AUTOFIX_LABELS_CLEARED_ON_APPROVE) await removeLabel(name);
  }
  log('PR review labels applied', { prNumber, added: apply, removed: remove, ...(isApproved ? { cleared: AUTOFIX_LABELS_CLEARED_ON_APPROVE } : {}) });
  obsLog({ stage: 'review', event: 'review.labels_applied', level: 'info', meta: { prNumber, added: [apply], removed: [remove, reviewLabels.withheld.name, ...(isApproved ? AUTOFIX_LABELS_CLEARED_ON_APPROVE : [])], repulse_skipped: !isApproved && autoFixAlreadyRunning } });
}

const checkpointRunId = process.env.CHECKPOINT_RUN_ID ?? `pr-${prNumber}`;
await writeCheckpoint(checkpointRunId, 'review', { isApproved, prNumber });
log('Checkpoint written', { runId: checkpointRunId, step: 'review' });

const prMetricsCheckpoint = await readCheckpoint(checkpointRunId, 'pr_metrics');
const prMetrics = prMetricsCheckpoint?.data ?? {
  pr_number: prNumber,
  issue_number: extractIssueNumber(prBody),
  started_at: _reviewStartedAt,
  request_changes_count: 0,
  auto_fix_pushes: 0,
  review_cycles: 0,
  total_input_tokens_est: 0,
  total_output_tokens_est: 0,
};

const updatedPrMetrics = {
  ...prMetrics,
  review_cycles: prMetrics.review_cycles + 1,
  request_changes_count: prMetrics.request_changes_count + (verdict === 'REQUEST_CHANGES' ? 1 : 0),
  total_input_tokens_est: prMetrics.total_input_tokens_est + estimateTokens(systemPrompt + userPrompt),
  total_output_tokens_est: prMetrics.total_output_tokens_est + estimateTokens(cleanReview),
};

await writeCheckpoint(checkpointRunId, 'pr_metrics', updatedPrMetrics);
log('PR metrics checkpoint updated', { prNumber, review_cycles: updatedPrMetrics.review_cycles });

const reviewDurationMs = Date.now() - _reviewStartMs;
obsLog({
  stage: 'review',
  event: 'review.verdict',
  level: 'info',
  duration_ms: reviewDurationMs,
  // withheld_from: the verdict the unseen-code backstop turned into WITHHELD (ADR-0038, #219), else null.
  meta: { verdict, attempt: updatedPrMetrics.review_cycles, prNumber, evidence_state: evidence.state, evidence_override: evidenceOverride, unreviewed_code_files: unreviewedCodeFiles.length, withheld_from: withheldForUnreviewedCode ? 'APPROVE' : withheldForUnseenFindings ? 'REQUEST_CHANGES' : null },
});
tracer.endSpan('review', { outcome: 'success', meta: { verdict, attempt: updatedPrMetrics.review_cycles } });
await tracer.finalize(isApproved ? 'success' : 'partial');

if (isApproved) {
  await appendMetric({
    type: 'pr',
    run_id: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}` : `local-${Date.now()}`,
    pr_number: prNumber,
    issue_number: updatedPrMetrics.issue_number,
    final_verdict: 'APPROVE',
    review_cycles: updatedPrMetrics.review_cycles,
    request_changes_count: updatedPrMetrics.request_changes_count,
    auto_fix_pushes: updatedPrMetrics.auto_fix_pushes,
    started_at: updatedPrMetrics.started_at,
    ended_at: new Date().toISOString(),
    total_input_tokens_est: updatedPrMetrics.total_input_tokens_est,
    total_output_tokens_est: updatedPrMetrics.total_output_tokens_est,
  });
  log('PR metrics recorded', { prNumber, verdict: 'APPROVE' });
}
} catch (err) {
  obsLog({ stage: 'review', event: 'review.error', level: 'error', duration_ms: Date.now() - _reviewStartMs, meta: { error: err.message } });
  tracer.endSpan('review', { outcome: 'failed', meta: { error: err.message } });
  await tracer.finalize('failed');
  throw err;
}
