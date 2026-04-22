#!/usr/bin/env node

import { requireEnv } from './lib/config.mjs';
import { log, error as logError } from './lib/logger.mjs';

const COMMENT_MARKER = '<!-- issue-validation-report -->';

function getHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

const githubApiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').trim();

async function githubRequest({ method, path, token, body }) {
  const response = await fetch(`${githubApiBase}${path}`, {
    method,
    headers: getHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${payload}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function buildCommentBody(comment) {
  return comment.includes(COMMENT_MARKER) ? comment : `${COMMENT_MARKER}\n${comment}`;
}

async function main() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const commentBody = requireEnv('COMMENT_BODY');

  if (!token) {
    throw new Error('Missing GH_TOKEN or GITHUB_TOKEN');
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY format: ${repo}`);
  }

  const comments = await githubRequest({
    method: 'GET',
    path: `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=100`,
    token,
  });

  const existing = comments.find((comment) => String(comment.body || '').includes(COMMENT_MARKER));
  const body = buildCommentBody(commentBody);

  if (existing) {
    await githubRequest({
      method: 'PATCH',
      path: `/repos/${owner}/${name}/issues/comments/${existing.id}`,
      token,
      body: { body },
    });
    log('Updated validation comment', { commentId: existing.id, issueNumber });
    return;
  }

  await githubRequest({
    method: 'POST',
    path: `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
    token,
    body: { body },
  });
  log('Created validation comment', { issueNumber });
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
