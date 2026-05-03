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
  if (!res.ok) {
    if (res.status === 422) {
      // Label already exists, do nothing
      return;
    }
    throw new Error(`Add label "${labelName}" failed: ${res.status}`);
  }
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
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const isValid = requireEnv('IS_VALID') === 'true';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

  if (!token) throw new Error('Missing GH_TOKEN or GITHUB_TOKEN');

  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid GITHUB_REPOSITORY format: ${repo}`);

  for (const label of LABELS) {
    await upsertLabel(owner, name, token, label);
    log('Label upserted', { label: label.name });
  }

  const apply = isValid ? issueLabels.valid.name : issueLabels.invalid.name;
  const remove = isValid ? issueLabels.invalid.name : issueLabels.valid.name;

  await addLabel(owner, name, token, issueNumber, apply);
  await removeLabel(owner, name, token, issueNumber, remove);
  log('Labels applied', { issueNumber, added: apply, removed: remove });
}

main().catch((err) => {
  logError('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
