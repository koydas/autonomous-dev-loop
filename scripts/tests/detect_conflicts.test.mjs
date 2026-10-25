import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectConflicts, readPr, MAX_PRS } from '../detect_conflicts.mjs';
import { loadLabelsConfigAll } from '../lib/layered_config.mjs';
import { formatConflictMarker } from '../lib/conflicts.mjs';

const LABELS = loadLabelsConfigAll({});
const REPO = 'koydas/app';
const SHA = 'a'.repeat(40);

function pr(number, extra = {}) {
  return {
    number, state: 'open', mergeable: true, mergeable_state: 'clean', labels: [], maintainer_can_modify: false,
    head: { ref: `feature-${number}`, sha: SHA, repo: { full_name: REPO } }, base: { ref: 'main' }, ...extra,
  };
}

/** A GitHub in memory: the PRs, their comments, and a call log. `mergeableAfter` makes mergeable null for N reads. */
function github(prs, { comments = {}, mergeableAfter = {}, failOn = null } = {}) {
  const calls = [];
  const reads = {};
  const request = async (method, path, body) => {
    calls.push([method, path, body]);
    if (failOn && `${method} ${path}`.startsWith(failOn)) return { status: 500, ok: false, json: null };
    let m;
    if (method === 'GET' && path.startsWith('/pulls?')) return { status: 200, ok: true, json: /&page=1$/.test(path) ? prs : [] };
    if (method === 'GET' && (m = path.match(/^\/pulls\/(\d+)$/))) {
      const found = prs.find((p) => p.number === Number(m[1]));
      if (!found) return { status: 404, ok: false, json: null };
      reads[found.number] = (reads[found.number] ?? 0) + 1;
      return { status: 200, ok: true, json: reads[found.number] <= (mergeableAfter[found.number] ?? 0) ? { ...found, mergeable: null, mergeable_state: 'unknown' } : found };
    }
    if (method === 'GET' && (m = path.match(/^\/issues\/(\d+)\/comments\?/))) return { status: 200, ok: true, json: /&page=1$/.test(path) ? (comments[m[1]] ?? []) : [] };
    if (method === 'POST' && path === '/labels') return { status: 201, ok: true, json: {} };
    if (method === 'POST' && path.endsWith('/labels')) return { status: 200, ok: true, json: {} };
    if (method === 'DELETE') return { status: calls.filter((c) => c[0] === 'DELETE' && c[1] === path).length > 1 ? 404 : 200, ok: true, json: null };
    if (method === 'POST' && path.endsWith('/comments')) return { status: 201, ok: true, json: { html_url: 'https://x/c/1' } };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request, calls, did: (method, path) => calls.filter((c) => c[0] === method && c[1] === path) };
}
const fast = { attempts: 3, delayMs: 0, sleep: async () => {} };
const run = (gh, extra = {}) => detectConflicts({ request: gh.request, repository: REPO, labels: LABELS, readOptions: fast, ...extra });

test('a conflicting PR is labelled and handed to the fix job; a clean one is not', async () => {
  const gh = github([pr(1, { mergeable: false, mergeable_state: 'dirty' }), pr(2)]);
  const res = await run(gh);
  assert.equal(res.checked, 2);
  assert.equal(res.conflicting, 1);
  assert.deepEqual(res.matrix, [{ number: 1, head_ref: 'feature-1', head_sha: SHA, head_repo: REPO, base_ref: 'main' }]);
  assert.equal(gh.did('POST', '/issues/1/labels')[0][2].labels[0], 'merge-conflict');
  assert.equal(gh.did('POST', '/issues/2/labels').length, 0);
});

test('a PR already labelled merge-conflict is not labelled again', async () => {
  const gh = github([pr(1, { mergeable: false, mergeable_state: 'dirty', labels: [{ name: 'merge-conflict' }] })]);
  assert.equal((await run(gh)).matrix.length, 1);
  assert.equal(gh.did('POST', '/issues/1/labels').length, 0);
});

test('a PR that is clean again loses merge-conflict and its attempt labels; absent labels are not touched', async () => {
  const gh = github([pr(1, { labels: [{ name: 'merge-conflict' }, { name: 'conflict-fix-attempt-1' }, { name: 'needs-human' }, { name: 'bug' }] }), pr(2, { labels: [{ name: 'bug' }] })]);
  const res = await run(gh);
  assert.equal(res.matrix.length, 0);
  assert.deepEqual(gh.calls.filter((c) => c[0] === 'DELETE').map((c) => c[1]), ['/issues/1/labels/merge-conflict', '/issues/1/labels/conflict-fix-attempt-1'], 'needs-human is a human\'s to clear');
});

test('mergeable is re-read until GitHub has computed it; a PR still unknown is left for the next run', async () => {
  const slow = github([pr(1, { mergeable: false, mergeable_state: 'dirty' })], { mergeableAfter: { 1: 2 } });
  assert.equal((await run(slow)).matrix.length, 1, 'known on the third read');
  assert.equal(slow.did('GET', '/pulls/1').length, 3);
  const never = github([pr(1, { mergeable: false, mergeable_state: 'dirty' })], { mergeableAfter: { 1: 99 } });
  const res = await run(never);
  assert.deepEqual([res.matrix.length, res.skipped], [0, [{ number: 1, reason: 'unknown' }]]);
  assert.equal(never.did('POST', '/issues/1/labels').length, 0, 'unknown is neither conflicting nor clean');
});

test('closed PRs are skipped; a single PR_NUMBER reads that PR only', async () => {
  const gh = github([pr(1, { state: 'closed' }), pr(2, { mergeable: false, mergeable_state: 'dirty' })]);
  assert.deepEqual((await run(gh)).skipped, [{ number: 1, reason: 'closed' }]);
  const one = github([pr(1, { mergeable: false, mergeable_state: 'dirty' }), pr(2, { mergeable: false, mergeable_state: 'dirty' })]);
  const res = await run(one, { prNumber: 2 });
  assert.deepEqual([res.checked, res.matrix.map((m) => m.number)], [1, [2]]);
  assert.equal(one.calls.some(([, p]) => p.startsWith('/pulls?')), false, 'no listing for one PR');
});

test('a fork without maintainer edits is labelled and told once per head; with them it is fixable', async () => {
  const fork = (extra = {}) => pr(1, { mergeable: false, mergeable_state: 'dirty', head: { ref: 'f', sha: SHA, repo: { full_name: 'someone/app' } }, ...extra });
  const gh = github([fork()]);
  const res = await run(gh);
  assert.deepEqual([res.matrix.length, res.skipped], [0, [{ number: 1, reason: 'fork_not_writable' }]]);
  assert.equal(gh.did('POST', '/issues/1/labels').length, 1, 'still labelled');
  const comment = gh.did('POST', '/issues/1/comments')[0][2].body;
  assert.match(comment, /Merge conflict/);
  assert.match(comment, new RegExp(`<!-- adl-conflicts head=${SHA} outcome=detected -->\\s*$`));
  const told = github([fork()], { comments: { 1: [{ user: { login: 'github-actions[bot]' }, body: formatConflictMarker({ sha: SHA, outcome: 'detected' }) }] } });
  await run(told);
  assert.equal(told.did('POST', '/issues/1/comments').length, 0, 'same head: not told twice');
  const moved = github([fork({ head: { ref: 'f', sha: 'b'.repeat(40), repo: { full_name: 'someone/app' } } })], { comments: { 1: [{ user: { login: 'github-actions[bot]' }, body: formatConflictMarker({ sha: SHA, outcome: 'detected' }) }] } });
  await run(moved);
  assert.equal(moved.did('POST', '/issues/1/comments').length, 1, 'a new head is told again');
  const allowed = github([fork({ maintainer_can_modify: true })]);
  assert.equal((await run(allowed)).matrix[0].head_repo, 'someone/app');
});

test('a branch name that could reach a shell, a checkout or a group key unquoted is left to a human', async () => {
  const gh = github([pr(1, { mergeable: false, mergeable_state: 'dirty', head: { ref: 'x";rm -rf', sha: SHA, repo: { full_name: REPO } } })]);
  const res = await run(gh);
  assert.deepEqual([res.matrix.length, res.skipped], [0, [{ number: 1, reason: 'unsafe_ref' }]]);
});

test('API failures are errors, not silence: a listing, a PR read, a label write', async () => {
  await assert.rejects(run(github([], { failOn: 'GET /pulls?' })), /GET \/pulls\?state=open \(page 1\) → 500/);
  await assert.rejects(readPr(github([]).request, 5, fast), /GET \/pulls\/5 → 404/);
  await assert.rejects(run(github([pr(1, { mergeable: false, mergeable_state: 'dirty' })], { failOn: 'POST /issues/1/labels' })), /Add label "merge-conflict" failed: 500/);
});

test('at most MAX_PRS pull requests are read in one pass', async () => {
  const many = Array.from({ length: MAX_PRS + 5 }, (_, i) => pr(i + 1));
  const res = await run(github(many));
  assert.equal(res.checked, MAX_PRS);
});
