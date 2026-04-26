#!/usr/bin/env node

import { requireEnv } from './lib/config.mjs';
import { log, error as logError } from './lib/logger.mjs';

const LABELS = [
  {
    name: 'ready-for-dev',
    color: '0075ca',
    description: 'Issue validated and ready for automated implementation',
  },
  {
    name: 'needs-refinement',
    color: 'e4e669',
    description: 'Issue requires clearer acceptance criteria before automation',
  },
];

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
    { method: 'DELETE', token },
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

  const apply = isValid ? 'ready-for-dev' : 'needs-refinement';
  const remove = isValid ? 'needs-refinement' : 'ready-for-dev';

  await addLabel(owner, name, token, issueNumber, apply);
  await removeLabel(owner, name, token, issueNumber, remove);
  log('Labels applied', { issueNumber, added: apply, removed: remove });
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
