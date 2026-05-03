#!/usr/bin/env node

import fs from 'node:fs';
import { requireEnv, loadLLMConfig, loadLabelsConfig } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { filterDiff } from './lib/file_filters.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';
import { log, error as logError } from './lib/logger.mjs';

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  process.exit(1);
});

const githubToken = requireEnv('GITHUB_TOKEN');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');
const { apiKey: llmApiKey, model, apiUrl, temperature, maxTokens: llmMaxTokens } = loadLLMConfig('review');

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
const PR_REVIEW_LABELS = [reviewLabels.approved, reviewLabels.changes];

let prNumber = event.pull_request?.number;
if (!prNumber) {
  const branch = event.ref?.replace('refs/heads/', '');
  if (!branch) throw new Error('Could not determine branch from event payload');
  const prsRes = await ghFetch(`/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`);
  if (!prsRes.ok) throw new Error(`PR lookup failed: ${prsRes.status}`);
  const prs = await prsRes.json();
  if (!prs.length) {
    log('No open PR found for branch, skipping review');
    process.exit(0);
  }
  prNumber = prs[0].number;
}


function extractChangedFiles(rawDiffText) {
  const files = [];
  for (const line of rawDiffText.split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) files.push(match[1]);
  }
  return [...new Set(files)];
}

function isAutomationScopeFile(filePath) {
  return (
    filePath.startsWith('.github/workflows/') ||
    filePath.startsWith('scripts/') ||
    filePath.startsWith('prompts/') ||
    filePath === 'docs/code-generation.md'
  );
}

function buildAutomationGateContext(rawDiffText) {
  const changedFiles = extractChangedFiles(rawDiffText);
  const automationScope = changedFiles.some(isAutomationScopeFile);
  if (!automationScope) return '';

  const hasUnitTestChanges = changedFiles.some(
    (filePath) => filePath.startsWith('scripts/tests/') || /(^|\/)tests?\/.+\.test\.mjs$/.test(filePath),
  );
  const hasDocsUpdates = changedFiles.some((filePath) => filePath.startsWith('docs/'));
  const hasCoverageSignal = /coverage|min(?:imum)?\s+coverage|unit[-\s]?test coverage/i.test(rawDiffText);

  return `

Automation gates context:
- automation_scope: true
- changed_files: ${changedFiles.join(', ') || '(none)'}
- unit_test_updates_present: ${hasUnitTestChanges}
- docs_updates_present: ${hasDocsUpdates}
- coverage_signal_present: ${hasCoverageSignal}

Use this context while deciding whether to request changes.`;
}

async function ghFetch(path, options = {}) {
  try {
    return await fetch(`${githubApiBase}${path}`, {
      ...options,
      headers: { ...githubHeaders, ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error(`Network error calling GitHub API (${path}): ${err.message}`, { cause: err });
  }
}

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
  for (const status of ['in_progress', 'queued']) {
    const runsRes = await ghFetch(
      `/repos/${owner}/${repo}/actions/workflows/auto-fix-pr.yml/runs?branch=${encodedBranch}&event=pull_request&status=${status}&per_page=20`,
    );
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

const [prMetaRes, diffRes] = await Promise.all([
  ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`),
  ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
  }),
]);
if (!prMetaRes.ok) throw new Error(`PR metadata fetch failed: ${prMetaRes.status}`);
if (!diffRes.ok) throw new Error(`Diff fetch failed: ${diffRes.status}`);

const prMeta = await prMetaRes.json();
const rawDiff = await diffRes.text();

const prTitle = prMeta.title || '';
const prBody = prMeta.body || '(no description provided)';
const diff = filterDiff(rawDiff);

const systemPrompt = loadPrompt('pr-review-system');
const baseUserPrompt = interpolatePrompt(loadPrompt('pr-review-user'), { diff, issueTitle: prTitle, issueBody: prBody });
const userPrompt = `${baseUserPrompt}${buildAutomationGateContext(rawDiff)}`;

const rawReview = await callLLM({
  prompt: userPrompt,
  systemPrompt,
  apiKey: llmApiKey,
  model,
  apiUrl,
  temperature,
  maxTokens: llmMaxTokens,
  responseFormat: null,
});

const HEADING = '## 🔍 Automated Code Review';
const cleanReview = rawReview.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
const body = cleanReview.includes(HEADING) ? cleanReview : `${HEADING}\n\n${cleanReview}`;

const verdictMatch = cleanReview.match(/verdict(?::\s*|\s*\n+\s*)\**(APPROVED|REQUEST_CHANGES)/i);
const isApproved = verdictMatch?.[1]?.toUpperCase() === 'APPROVED';

const commentsRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
if (!commentsRes.ok) throw new Error(`Comment list failed: ${commentsRes.status}`);

const comments = await commentsRes.json();
const existing = comments.find((c) => c.body?.includes(HEADING));

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

const shortReviewBody = isApproved
  ? 'Automated review passed. See the review comment for details.'
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
  body: JSON.stringify({
    body: shortReviewBody,
    event: isApproved ? 'APPROVE' : 'REQUEST_CHANGES',
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
  } else if (permissionLikeFailure) {
    throw new Error(
      `Review submit failed due to permission/configuration issue: ${reviewRes.status} ${detail}`,
    );
  } else {
    throw new Error(`Review submit failed: ${reviewRes.status} ${detail}`);
  }
} else {
  log('PR review submitted', { prNumber, event: isApproved ? 'APPROVE' : 'REQUEST_CHANGES' });
}

for (const label of PR_REVIEW_LABELS) {
  await upsertLabel(label);
  log('Label upserted', { label: label.name });
}

const apply = isApproved ? reviewLabels.approved.name : reviewLabels.changes.name;
const remove = isApproved ? reviewLabels.changes.name : reviewLabels.approved.name;

if (!isApproved) {
  const branchName = prMeta?.head?.ref;
  const autoFixAlreadyRunning = branchName ? await hasActiveAutoFixRun(branchName) : false;
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
log('PR review labels applied', { prNumber, added: apply, removed: remove });
