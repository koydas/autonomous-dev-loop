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
    Authorization: `Bearer ${token}`,
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
  const res = await ghRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    token,
    body: { labels: [labelName] },
  });
  if (!res.ok) throw new Error(`Add label "${labelName}" failed: ${res.status}`);
}

async function removeLabel(owner, repo, token, issueNumber, labelName) {
  const res = await ghRequest(
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`,
    { method: 'DELETE', token }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Remove label "${labelName}" failed: ${res.status}`);
  }
}

async function main() {
  log('Starting label management...');
  try {
    const { GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN } = requireEnv(['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN']);
    // Label management logic here
  } catch (err) {
    logError('Initialization error', { error: err.message });
    process.exit(1);
  }
}

main().catch((err) => {
  logError('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});