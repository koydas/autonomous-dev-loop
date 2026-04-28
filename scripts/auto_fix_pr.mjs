#!/usr/bin/env node

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { requireEnv, loadLLMConfig } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { filterDiff, shouldIncludeFile } from './lib/file_filters.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';
import { log, error as logError } from './lib/logger.mjs';

const MAX_ATTEMPTS = 3;
const MAX_FILE_SIZE = 8000;
const ATTEMPT_LABEL_PREFIX = 'auto-fix-attempt-';

const githubToken = requireEnv('GITHUB_TOKEN');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');
const { apiKey: llmApiKey, model, apiUrl } = loadLLMConfig('autofix');

let event;
try {
  event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`);
}
if (!event || typeof event !== 'object') throw new Error('GitHub event payload is not a valid object');

const prNumber = event.pull_request?.number;
if (!prNumber) throw new Error('Missing pull_request.number in event payload');

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
  try {
    return await fetch(`${githubApiBase}${endpoint}`, {
      ...options,
      headers: { ...githubHeaders, ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error(`Network error calling GitHub API (${endpoint}): ${err.message}`);
  }
}

async function loadLatestAutomatedReviewComment() {
  let page = 1;
  while (true) {
    const commentsRes = await ghFetch(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&sort=created&direction=desc&page=${page}`,
    );
    if (!commentsRes.ok) {
      logError('Automated review comment fallback fetch failed', { prNumber, statusCode: commentsRes.status, page });
      return null;
    }

    const comments = await commentsRes.json();
    if (!Array.isArray(comments) || comments.length === 0) return null;

    const automatedReviewComment = comments.find(
      (c) => typeof c.body === 'string' && c.body.includes('## 🔍 Automated Code Review'),
    );
    if (automatedReviewComment?.body) return automatedReviewComment.body;

    if (comments.length < 100) return null;
    page += 1;
  }
}

const labelsRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`);
if (!labelsRes.ok) throw new Error(`Label list failed: ${labelsRes.status}`);
const prLabels = await labelsRes.json();
const attemptCount = prLabels.filter((l) => l.name.startsWith(ATTEMPT_LABEL_PREFIX)).length;

if (attemptCount >= MAX_ATTEMPTS) {
  const exhaustedBody = `## 🤖 Auto-Fix Exhausted\n\nMaximum auto-fix attempts (${MAX_ATTEMPTS}) reached on this PR. Please review the remaining issues manually.`;
  await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: exhaustedBody }),
  });
  log('Max auto-fix attempts reached', { prNumber, attemptCount });
  process.exit(0);
}

const nextAttempt = attemptCount + 1;
log('Starting auto-fix', { prNumber, attempt: nextAttempt });

const feedbackParts = [];
if (reviewBody) feedbackParts.push(reviewBody);

if (reviewId) {
  const inlineRes = await ghFetch(
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
  );
  if (inlineRes.ok) {
    const inlineComments = await inlineRes.json();
    for (const c of inlineComments) {
      feedbackParts.push(`**${c.path}** (line ${c.original_line || c.line || '?'}):\n${c.body}`);
    }
  }
}

if (!feedbackParts.length) {
  const automatedReviewCommentBody = await loadLatestAutomatedReviewComment();
  if (automatedReviewCommentBody) {
    feedbackParts.push(automatedReviewCommentBody);
    log('Using latest automated review comment as feedback fallback', { prNumber });
  }
}

const reviewFeedback =
  feedbackParts.join('\n\n---\n\n') || '(No specific review feedback provided)';

const diffRes = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  headers: { Accept: 'application/vnd.github.v3.diff' },
});
if (!diffRes.ok) throw new Error(`Diff fetch failed: ${diffRes.status}`);
const rawDiff = await diffRes.text();
const diff = filterDiff(rawDiff);

const changedFiles = [
  ...new Set([...rawDiff.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1])),
].filter(shouldIncludeFile);

const repoRoot = path.resolve(process.cwd());
const fileContentParts = [];
for (const filePath of changedFiles.slice(0, 10)) {
  const absPath = path.resolve(repoRoot, filePath);
  if (!absPath.startsWith(repoRoot + path.sep)) continue;
  try {
    const content = await fsPromises.readFile(absPath, 'utf8');
    fileContentParts.push(
      `### Current file: ${filePath}\n\`\`\`\n${content.slice(0, MAX_FILE_SIZE)}\n\`\`\``,
    );
  } catch {
    // File deleted or unreadable — skip
  }
}
const fileContents =
  fileContentParts.length > 0
    ? fileContentParts.join('\n\n')
    : 'No existing files identified as relevant to this review.';

const systemPrompt = loadPrompt('auto-fix-system');
const userPrompt = interpolatePrompt(loadPrompt('auto-fix-user'), {
  reviewFeedback,
  diff,
  fileContents,
});

const raw = await callLLM({
  prompt: userPrompt,
  systemPrompt,
  apiKey: llmApiKey,
  model,
  apiUrl,
  temperature: 0.2,
});

let aiOutput;
try {
  aiOutput = parseJsonResponse(raw);
} catch (parseErr) {
  logError('AI response was not valid JSON', { preview: raw.slice(0, 500) });
  throw new Error(`AI response was not valid JSON: ${parseErr.message}`);
}
if (!aiOutput || typeof aiOutput !== 'object' || Array.isArray(aiOutput)) {
  throw new Error('AI response JSON must be an object');
}

const { summary, changes } = validateAiOutput(aiOutput);
const outputPaths = await writeGeneratedFiles(changes);

const attemptLabelName = `${ATTEMPT_LABEL_PREFIX}${nextAttempt}`;
const createLabelRes = await ghFetch(`/repos/${owner}/${repo}/labels`, {
  method: 'POST',
  body: JSON.stringify({
    name: attemptLabelName,
    color: 'fbca04',
    description: `Auto-fix iteration ${nextAttempt}`,
  }),
});
if (!createLabelRes.ok && createLabelRes.status !== 422) {
  logError(`Auto-fix label create failed: ${createLabelRes.status}`, { attemptLabelName });
}

const applyLabelRes = await ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
  method: 'POST',
  body: JSON.stringify({ labels: [attemptLabelName] }),
});
if (!applyLabelRes.ok) {
  logError(`Auto-fix label apply failed: ${applyLabelRes.status}`, { attemptLabelName });
}

if (process.env.GITHUB_OUTPUT) {
  await fsPromises.appendFile(
    process.env.GITHUB_OUTPUT,
    `fixed_paths<<EOF\n${outputPaths.join('\n')}\nEOF\nattempt_number=${nextAttempt}\nsummary<<EOF\n${summary}\nEOF\n`,
    'utf8',
  );
}

log('Auto-fix complete', { prNumber, attempt: nextAttempt, paths: outputPaths.join(', ') });
