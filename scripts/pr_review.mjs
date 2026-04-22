#!/usr/bin/env node

import fs from 'node:fs';
import { requireEnv, GROQ_MODEL_DEFAULTS, GROQ_API_URL_DEFAULT } from './lib/config.mjs';
import { callGroq } from './lib/groq_client.mjs';
import { filterDiff } from './lib/file_filters.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';

const githubToken = requireEnv('GITHUB_TOKEN');
const groqApiKey = requireEnv('GROQ_API_KEY');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');

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

const githubHeaders = {
  Authorization: `Bearer ${githubToken}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const ghFetch = (path, options = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...githubHeaders, ...(options.headers || {}) },
  }).catch((err) => {
    throw new Error(`Network error calling GitHub API (${path}): ${err.message}`);
  });

const diffRes = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  headers: { Accept: 'application/vnd.github.v3.diff' },
});
if (!diffRes.ok) throw new Error(`Diff fetch failed: ${diffRes.status}`);
const rawDiff = await diffRes.text();

const diff = filterDiff(rawDiff);

const model = (process.env.GROQ_MODEL || GROQ_MODEL_DEFAULTS.review).trim();
const apiUrl = (process.env.GROQ_API_URL || GROQ_API_URL_DEFAULT).trim();

const systemPrompt = loadPrompt('pr-review-system');
const userPrompt = interpolatePrompt(loadPrompt('pr-review-user'), { diff });

const rawReview = await callGroq({
  prompt: userPrompt,
  systemPrompt,
  apiKey: groqApiKey,
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

console.log(`[INFO] PR #${prNumber} review ${existing ? 'updated' : 'posted'}`);
