import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function runScript(scriptName, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, scriptName)], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function assertFails(result, pattern) {
  assert.notEqual(result.code, 0, `expected non-zero exit, got 0. stderr: ${result.stderr}`);
  if (pattern) assert.match(result.stderr + result.stdout, pattern);
}

// generate_issue_change.mjs

test('generate_issue_change exits 1 when GROQ_API_KEY is missing', async () => {
  assertFails(
    await runScript('generate_issue_change.mjs', { ISSUE_NUMBER: '1', ISSUE_TITLE: 'T' }),
    /GROQ_API_KEY/,
  );
});

test('generate_issue_change exits 1 when ISSUE_NUMBER is missing', async () => {
  assertFails(
    await runScript('generate_issue_change.mjs', { GROQ_API_KEY: 'key', ISSUE_TITLE: 'T' }),
    /ISSUE_NUMBER/,
  );
});

test('generate_issue_change exits 1 when ISSUE_TITLE is missing', async () => {
  assertFails(
    await runScript('generate_issue_change.mjs', { GROQ_API_KEY: 'key', ISSUE_NUMBER: '1' }),
    /ISSUE_TITLE/,
  );
});

// validate_issue.mjs

test('validate_issue exits 1 when GROQ_API_KEY is missing', async () => {
  assertFails(
    await runScript('validate_issue.mjs', { ISSUE_NUMBER: '1', ISSUE_TITLE: 'T' }),
    /GROQ_API_KEY/,
  );
});

test('validate_issue exits 1 when ISSUE_NUMBER is missing', async () => {
  assertFails(
    await runScript('validate_issue.mjs', { GROQ_API_KEY: 'key', ISSUE_TITLE: 'T' }),
    /ISSUE_NUMBER/,
  );
});

test('validate_issue exits 1 when ISSUE_TITLE is missing', async () => {
  assertFails(
    await runScript('validate_issue.mjs', { GROQ_API_KEY: 'key', ISSUE_NUMBER: '1' }),
    /ISSUE_TITLE/,
  );
});

// pr_review.mjs

test('pr_review exits 1 when GITHUB_TOKEN is missing', async () => {
  assertFails(
    await runScript('pr_review.mjs', {
      GROQ_API_KEY: 'key',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: '/tmp/event.json',
    }),
    /GITHUB_TOKEN/,
  );
});

test('pr_review exits 1 when GROQ_API_KEY is missing', async () => {
  assertFails(
    await runScript('pr_review.mjs', {
      GITHUB_TOKEN: 'token',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: '/tmp/event.json',
    }),
    /GROQ_API_KEY/,
  );
});

test('pr_review exits 1 when GITHUB_REPOSITORY is missing', async () => {
  assertFails(
    await runScript('pr_review.mjs', {
      GITHUB_TOKEN: 'token',
      GROQ_API_KEY: 'key',
      GITHUB_EVENT_PATH: '/tmp/event.json',
    }),
    /GITHUB_REPOSITORY/,
  );
});

test('pr_review exits 1 when GITHUB_EVENT_PATH is missing', async () => {
  assertFails(
    await runScript('pr_review.mjs', {
      GITHUB_TOKEN: 'token',
      GROQ_API_KEY: 'key',
      GITHUB_REPOSITORY: 'owner/repo',
    }),
    /GITHUB_EVENT_PATH/,
  );
});

test('pr_review exits 1 when event file does not exist', async () => {
  assertFails(
    await runScript('pr_review.mjs', {
      GITHUB_TOKEN: 'token',
      GROQ_API_KEY: 'key',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: '/nonexistent/path/event.json',
    }),
    /event payload/i,
  );
});

test('pr_review exits 1 when event file contains invalid JSON', async () => {
  const tmpFile = path.join(os.tmpdir(), 'pr-review-test-invalid.json');
  await fs.writeFile(tmpFile, 'not json');
  try {
    assertFails(
      await runScript('pr_review.mjs', {
        GITHUB_TOKEN: 'token',
        GROQ_API_KEY: 'key',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_EVENT_PATH: tmpFile,
      }),
      /event payload/i,
    );
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
});

test('pr_review exits 1 when event has no pull_request.number', async () => {
  const tmpFile = path.join(os.tmpdir(), 'pr-review-test-no-pr.json');
  await fs.writeFile(tmpFile, JSON.stringify({ action: 'opened' }));
  try {
    assertFails(
      await runScript('pr_review.mjs', {
        GITHUB_TOKEN: 'token',
        GROQ_API_KEY: 'key',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_EVENT_PATH: tmpFile,
      }),
      /pull_request\.number/,
    );
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
});

// upsert_issue_validation_comment.mjs

test('upsert_issue_validation_comment exits 1 when ISSUE_NUMBER is missing', async () => {
  assertFails(
    await runScript('upsert_issue_validation_comment.mjs', {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_TOKEN: 'token',
      COMMENT_BODY: 'body',
    }),
    /ISSUE_NUMBER/,
  );
});

test('upsert_issue_validation_comment exits 1 when GITHUB_REPOSITORY is missing', async () => {
  assertFails(
    await runScript('upsert_issue_validation_comment.mjs', {
      ISSUE_NUMBER: '1',
      GITHUB_TOKEN: 'token',
      COMMENT_BODY: 'body',
    }),
    /GITHUB_REPOSITORY/,
  );
});

test('upsert_issue_validation_comment exits 1 when COMMENT_BODY is missing', async () => {
  assertFails(
    await runScript('upsert_issue_validation_comment.mjs', {
      ISSUE_NUMBER: '1',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_TOKEN: 'token',
    }),
    /COMMENT_BODY/,
  );
});

test('upsert_issue_validation_comment exits 1 when both GH_TOKEN and GITHUB_TOKEN are missing', async () => {
  assertFails(
    await runScript('upsert_issue_validation_comment.mjs', {
      ISSUE_NUMBER: '1',
      GITHUB_REPOSITORY: 'owner/repo',
      COMMENT_BODY: 'body',
    }),
    /GH_TOKEN|GITHUB_TOKEN/,
  );
});

test('upsert_issue_validation_comment exits 1 when GITHUB_REPOSITORY has invalid format', async () => {
  assertFails(
    await runScript('upsert_issue_validation_comment.mjs', {
      ISSUE_NUMBER: '1',
      GITHUB_REPOSITORY: 'invalidrepo',
      GITHUB_TOKEN: 'token',
      COMMENT_BODY: 'body',
    }),
    /GITHUB_REPOSITORY/,
  );
});
