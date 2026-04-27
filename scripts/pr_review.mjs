#!/usr/bin/env node

import fs from 'node:fs';
import { requireEnv, loadLLMConfig, loadLabelsConfig } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { filterDiff } from './lib/file_filters.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';
import { log } from './lib/logger.mjs';

const githubToken = requireEnv('GITHUB_TOKEN');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');
const { apiKey: llmApiKey, model, apiUrl } = loadLLMConfig('review');

let event;
try {
  event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`);
}
if (!event || typeof event !== 'object') throw new Error('GitHub event payload is not a valid object');

const prNumber = event.pull_request?.number;
if (!prNumber) throw new Error('Missing pull_request.number in event payload');

const [owner, repo] = repository.split('/');

const githubApiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').trim();

const githubHeaders = {
  Authorization: `Bearer ${githubToken}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const reviewLabels = loadLabelsConfig('review');
const PR_REVIEW_LABELS = [reviewLabels.approved, reviewLabels.changes];

async function ghFetch(path, options = {}) {
  try {
    return await fetch(`${githubApiBase}${path}`, {
      ...options,
      headers: { ...githubHeaders, ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error(`Network error calling GitHub API (${path}): ${err.message}`);
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

const diffRes = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  headers: { Accept: 'application/vnd.github.v3.diff' },
});
if (!diffRes.ok) throw new Error(`Diff fetch failed: ${diffRes.status}`);
const rawDiff = await diffRes.text();

const diff = filterDiff(rawDiff);

const systemPrompt = loadPrompt('pr-review-system');
const userPrompt = interpolatePrompt(loadPrompt('pr-review-user'), { diff });

const rawReview = await callLLM({
  prompt: userPrompt,
  systemPrompt,
  apiKey: llmApiKey,
  model,
  apiUrl,
  temperature: 0.2,
  responseFormat: null,
});

const HEADING = '## 🔍 Automated Code Review';
const review = rawReview.trim();
const body = review.includes(HEADING) ? review : `${HEADING}\n\n${review}`;

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

log(`PR review ${existing ? 'updated' : 'posted'}`, { prNumber });

const verdictMatch = rawReview.match(/verdict(?::\s*|\s*\n+\s*)(APPROVED|REQUEST_CHANGES)/i);
const isApproved = verdictMatch?.[1]?.toUpperCase() === 'APPROVED';

for (const label of PR_REVIEW_LABELS) {
  await upsertLabel(label);
  log('Label upserted', { label: label.name });
}

const apply = isApproved ? reviewLabels.approved.name : reviewLabels.changes.name;
const remove = isApproved ? reviewLabels.changes.name : reviewLabels.approved.name;

await addLabel(apply);
await removeLabel(remove);
log('PR review labels applied', { prNumber, added: apply, removed: remove });
