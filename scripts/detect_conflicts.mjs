#!/usr/bin/env node
/**
 * conflicts-fix, detection (ADR-0058 §A): reads the mergeability of the open pull requests (or one, PR_NUMBER),
 * keeps the `merge-conflict` label in step with it, clears the attempt labels of a PR that is clean again, and
 * writes the PRs the pipeline can fix to the step output `prs` (a JSON matrix). A conflicting PR whose head
 * cannot be pushed to (fork without "allow edits from maintainers") is labelled and told once, never skipped silently.
 * `mergeable` is computed by GitHub on demand: a `null` is re-read a few times, then the PR is left for the next run.
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER (optional), GITHUB_API_URL (optional), GITHUB_RUN_ID, GITHUB_OUTPUT.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabelsConfigAll } from './lib/layered_config.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { appendOutputs } from './lib/github_output.mjs';
import { classifyMergeability, canPushToHead, formatConflictMarker, latestConflictMarker } from './lib/conflicts.mjs';
import { createRequest, paginate, addLabel, removeLabel, postComment, conflictLabels } from './lib/conflicts_github.mjs';

const STAGE = 'conflicts_detect';
export const MAX_PRS = 100;
const SAFE_REF = /^[A-Za-z0-9._/@+-]+$/;
const READ_ATTEMPTS = 4;
const READ_DELAY_MS = 3000;

/** A PR read until its mergeability is computed (bounded); the last read is returned either way. */
export async function readPr(request, number, { attempts = READ_ATTEMPTS, delayMs = READ_DELAY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let pr = null;
  for (let i = 0; i < attempts; i++) {
    const res = await request('GET', `/pulls/${number}`);
    if (!res.ok) throw new Error(`GitHub API GET /pulls/${number} → ${res.status}`);
    pr = res.json;
    if (classifyMergeability(pr) !== 'unknown') return pr;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return pr;
}

const detectedComment = (files) => [
  '## ⚠️ Merge conflict',
  '',
  'This pull request conflicts with its base branch, and the pipeline cannot push to its head branch (a fork without “Allow edits from maintainers”), so it cannot resolve the conflict for you.',
  files ? `\n${files}\n` : '',
  'Merge the base branch into the head branch, or enable “Allow edits from maintainers” and re-run the *Conflicts fix* workflow. The `merge-conflict` label is removed once the PR is mergeable again.',
].filter((l) => l !== '').join('\n');

/**
 * One detection pass. Returns `{ checked, conflicting, matrix, skipped }`; `matrix` is what the fix job takes.
 * @param {{ request: Function, repository: string, prNumber?: number | null, labels: object, readOptions?: object }} input
 */
export async function detectConflicts({ request, repository, prNumber = null, labels, readOptions = {} }) {
  const { conflicting, attempts } = conflictLabels(labels);
  const numbers = prNumber ? [prNumber] : (await paginate(request, '/pulls?state=open')).map((p) => p.number).slice(0, MAX_PRS);
  const matrix = [];
  const skipped = [];
  let conflictingCount = 0;
  for (const number of numbers) {
    const pr = await readPr(request, number, readOptions);
    const state = classifyMergeability(pr);
    obsLog({ stage: STAGE, event: 'conflicts_detect.classified', level: 'info', meta: { prNumber: number, state } });
    const has = new Set((pr.labels ?? []).map((l) => l.name));
    if (state === 'closed' || state === 'unknown') { skipped.push({ number, reason: state }); continue; }
    if (state === 'clean') {
      const removed = [];
      for (const name of [conflicting.name, ...attempts.map((a) => a.name)]) {
        if (has.has(name) && await removeLabel(request, number, name)) removed.push(name);
      }
      if (removed.length) obsLog({ stage: STAGE, event: 'conflicts_detect.labeled', level: 'info', meta: { prNumber: number, added: [], removed } });
      continue;
    }
    conflictingCount += 1;
    if (!has.has(conflicting.name)) {
      await addLabel(request, number, conflicting);
      obsLog({ stage: STAGE, event: 'conflicts_detect.labeled', level: 'info', meta: { prNumber: number, added: [conflicting.name], removed: [] } });
    }
    // The branch name reaches the fix job's checkout and concurrency group: an unusual one is left to a human.
    if (canPushToHead(pr, repository) && !SAFE_REF.test(`${pr.head.ref}${pr.base.ref}`)) { skipped.push({ number, reason: 'unsafe_ref' }); continue; }
    if (canPushToHead(pr, repository)) {
      matrix.push({ number, head_ref: pr.head.ref, head_sha: pr.head.sha, head_repo: pr.head.repo.full_name, base_ref: pr.base.ref });
      continue;
    }
    skipped.push({ number, reason: 'fork_not_writable' });
    const comments = await paginate(request, `/issues/${number}/comments`);
    const previous = latestConflictMarker(comments);
    if (previous?.sha === pr.head.sha) continue; // told once per head
    const url = await postComment(request, number, `${detectedComment('')}\n\n${formatConflictMarker({ sha: pr.head.sha, outcome: 'detected' })}`);
    obsLog({ stage: STAGE, event: 'conflicts_detect.comment_posted', level: 'info', meta: { prNumber: number, url } });
  }
  return { checked: numbers.length, conflicting: conflictingCount, matrix, skipped };
}

async function loadOptions(env = process.env) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = env;
  if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const raw = env.PR_NUMBER?.trim();
  const prNumber = raw ? Number.parseInt(raw, 10) : null;
  if (raw && !(Number.isInteger(prNumber) && prNumber > 0)) throw new Error('PR_NUMBER must be a positive integer');
  const request = createRequest({ token, repository, apiBase: env.GITHUB_API_URL || undefined });
  return { request, repository, prNumber, labels: loadLabelsConfigAll(env) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const startMs = Date.now();
  const tracer = createTracer({ runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  try {
    const opts = await loadOptions();
    obsLog({ stage: STAGE, event: 'conflicts_detect.start', level: 'info', meta: { prNumber: opts.prNumber } });
    tracer.startSpan(STAGE, { prNumber: opts.prNumber });
    const result = await detectConflicts(opts);
    appendOutputs([['prs', JSON.stringify(result.matrix)], ['count', result.matrix.length]]);
    console.log(`Checked ${result.checked} PR(s): ${result.conflicting} conflicting, ${result.matrix.length} fixable, ${result.skipped.length} left.`);
    obsLog({ stage: STAGE, event: 'conflicts_detect.complete', level: 'info', duration_ms: Date.now() - startMs, meta: { checked: result.checked, conflicting: result.conflicting, fixable: result.matrix.length } });
    tracer.endSpan(STAGE, { outcome: 'success', meta: {} });
    await tracer.finalize('success');
  } catch (err) {
    obsLog({ stage: STAGE, event: 'conflicts_detect.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan(STAGE, { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
