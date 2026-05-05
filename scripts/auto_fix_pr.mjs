import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { requireEnv, loadLLMConfig } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { filterDiff, shouldIncludeFile } from './lib/file_filters.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';
import { log, error as logError, setLogContext, logStart, logEnd, logSummary } from './lib/logger.mjs';
import { retryWithBackoff } from './lib/retry.mjs';

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  logSummary({ success: false, stepsCompleted: [], errors: [err.message] });
  process.exit(1);
});

const MAX_ATTEMPTS = 3;
const MAX_FILE_SIZE = 8000;
const MAX_FILES = 5;
const ATTEMPT_LABEL_PREFIX = 'auto-fix-attempt-';
const TOKEN_SAFETY_MARGIN = 200;

const MODEL_CONTEXT_WINDOW = {
  'qwen/qwen3-32b': 32768,
  'llama-3.1-8b-instant': 32768,
  'llama-3.3-70b-versatile': 131072,
  'claude-opus-4-7': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5-20251001': 200000,
};

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(text, tokenBudget) {
  if (tokenBudget <= 0) return '';
  const maxChars = tokenBudget * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function isManualRerunRequested(eventPayload) {
  const action = eventPayload?.action;
  const body = eventPayload?.comment?.body || '';
  if (!['created', 'edited'].includes(action) || typeof body !== 'string') return false;
  return /-\s*\[x\]\s*(relancer\s+auto\s*fixer|rerun\s+auto\s*-?\s*fix(er)?)/i.test(body);
}

const WORKSPACE_ROOT = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const CHECKPOINT_DIR = path.join(WORKSPACE_ROOT, '.github', 'checkpoints');

async function cleanupCheckpointFiles() {
  let entries;
  try {
    entries = await fsPromises.readdir(CHECKPOINT_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^checkpoint-attempt-\d+\.json$/.test(entry.name)) continue;
    await fsPromises.unlink(path.join(CHECKPOINT_DIR, entry.name));
    removed.push(entry.name);
  }
  return removed;
}

const githubToken = requireEnv('GITHUB_TOKEN');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');
const { provider: llmProvider, apiKey: llmApiKey, model, apiUrl, temperature: llmTemperature, maxTokens: llmMaxTokens } = loadLLMConfig('autofix');
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
    return await retryWithBackoff(async () => {
      return await fetch(`${githubApiBase}${endpoint}`, {
        ...options,
        headers: { ...githubHeaders, ...(options.headers || {}) },
      });
    });
  } catch (err) {
    throw new Error(`Network error calling GitHub API (${endpoint}): ${err.message}`, { cause: err });
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
      (c) => typeof c.body === 'string' && c.body.includes('## \u{1F50D} Automated Code Review'),
    );
    if (automatedReviewComment?.body) return automatedReviewComment.body;

    if (comments.length < 100) return null;
    page += 1;
  }
}

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
  const removedCheckpointFiles = await cleanupCheckpointFiles();
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
  process.exit(0);
}

const nextAttempt = attemptCount + 1;

log('Starting auto-fix', { prNumber, attempt: nextAttempt });

setLogContext({ run_id: process.env.GITHUB_RUN_ID ?? crypto.randomUUID(), step: 'auto-fix', attempt: nextAttempt });

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
  const automatedReviewCommentBody = await loadLatestAutomatedReviewComment();
  if (automatedReviewCommentBody) {
    feedbackParts.push(automatedReviewCommentBody);
    log('Using latest automated review comment as feedback fallback', { prNumber });
  }
}

const systemTokens = estimateTokens(systemPrompt);
const contextWindow = MODEL_CONTEXT_WINDOW[model] ?? (llmProvider === 'groq' ? 32768 : 200000);
