#!/usr/bin/env node

import { requireEnv, loadLabelsConfig } from './lib/config.mjs';
import { log, error as logError } from './lib/logger.mjs';

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  process.exit(1);
});

const issueLabels = loadLabelsConfig('issue');
const LABELS = [issueLabels.valid, issueLabels.invalid];

function getHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

const githubApiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').trim();

async function ghRequest(path, { method = 'GET', token, body } = {}) {
  return fetch(`${githubApiBase}${path}`, {
    method,
    headers: getHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function upsertLabel(owner, repo, token, label) {
  const createRes = await ghRequest(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    token,
    body: label,
  });
  if (createRes.status === 201) return;
  if (createRes.status !== 422) {
    throw new Error(`Label create failed for "${label.name}": ${createRes.status}`);
  }
  const updateRes = await ghRequest(
    `/repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`,
    { method: 'PATCH', token, body: label },
  );
  if (!updateRes.ok) {
    throw new Error(`Label update failed for "${label.name}": ${updateRes.status}`);
  }
}

async function addLabel(owner, repo, token, issueNumber, labelName) {
  // Check if label already exists on issue
  const existingRes = await ghRequest(
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    { method: 'GET', token }
  );
  
  if (!existingRes.ok) {
    throw new Error(`Failed to fetch existing labels: ${existingRes.status}`);
  }
  
  const existingLabels = await existingRes.json();
  if (existingLabels.includes(labelName)) return;

  const res = await ghRequest(
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    {
      method: 'POST',
      token,
      body: { labels: [labelName] }
    }
  );
  
  if (!res.ok) {
    if (res.status === 422) return;
    throw new Error(`Add label "${labelName}" failed: ${res.status}`);
  }
}

async function removeLabel(owner, repo, token, issueNumber, labelName) {
