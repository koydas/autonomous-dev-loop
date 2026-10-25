import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConflictsFix, gitNetwork, modelFor } from '../conflicts_fix.mjs';
import { loadLabelsConfigAll } from '../lib/layered_config.mjs';
import { formatConflictMarker, parseConflictMarker } from '../lib/conflicts.mjs';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABELS = loadLabelsConfigAll({});
const REPO = 'koydas/app';
const HEAD_SHA = 'a'.repeat(40);

/** A temporary git repository with one commit and refs/adl/base, so the script's `git rev-parse` calls are real. */
function workdir() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conflicts-fix-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'c');
  git('update-ref', 'refs/adl/base', 'HEAD');
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function prObject(extra = {}) {
  return {
    number: 7, state: 'open', mergeable: false, mergeable_state: 'dirty', title: 'My PR', body: '', labels: [], maintainer_can_modify: false,
    head: { ref: 'feature/x', sha: HEAD_SHA, repo: { full_name: REPO } }, base: { ref: 'main' }, ...extra,
  };
}

function github(pr, { comments = [] } = {}) {
  const calls = [];
  const request = async (method, p, body) => {
    calls.push([method, p, body]);
    if (method === 'GET' && p === '/pulls/7') return { status: 200, ok: true, json: pr };
    if (method === 'GET' && p.startsWith('/issues/7/comments?')) return { status: 200, ok: true, json: /&page=1$/.test(p) ? comments : [] };
    if (method === 'POST' && p === '/labels') return { status: 201, ok: true, json: {} };
    if (method === 'POST' && p === '/issues/7/labels') return { status: 200, ok: true, json: {} };
    if (method === 'DELETE') return { status: 200, ok: true, json: null };
    if (method === 'POST' && p === '/issues/7/comments') return { status: 201, ok: true, json: { html_url: 'https://github.com/c/1' } };
    throw new Error(`unexpected ${method} ${p}`);
  };
  return {
    request, calls,
    labelsAdded: () => calls.filter((c) => c[0] === 'POST' && c[1] === '/issues/7/labels').map((c) => c[2].labels[0]),
    removed: () => calls.filter((c) => c[0] === 'DELETE').map((c) => decodeURIComponent(c[1].split('/').pop())),
    comment: () => calls.find((c) => c[0] === 'POST' && c[1] === '/issues/7/comments')?.[2].body ?? null,
  };
}

const ok = { ok: true, stderr: '' };
function run(gh, w, extra = {}) {
  const pushed = [];
  return {
    pushed,
    go: () => runConflictsFix({
      request: gh.request, repository: REPO, prNumber: 7, labels: LABELS, cwd: w.cwd, token: 'tok', serverUrl: 'https://github.com',
      fetchBase: () => ok, push: (args) => { pushed.push(args); return ok; }, readOptions: { attempts: 1, delayMs: 0, sleep: async () => {} },
      merge: async () => ({ outcome: 'resolved', rung: 'L2', files: ['CHANGELOG.md'], conflicts: 1, hunks: 1, renumbered: [], sig: 'abcdef0123', headSha: HEAD_SHA }),
      ...extra,
    }),
  };
}

test('skips: a PR that is not conflicting, closed, in a fork it cannot push to, or with an unusual branch name', async () => {
  const w = workdir();
  try {
    for (const [pr, reason] of [
      [prObject({ mergeable: true, mergeable_state: 'clean' }), 'clean'],
      [prObject({ state: 'closed' }), 'closed'],
      [prObject({ mergeable: null, mergeable_state: 'unknown' }), 'unknown'],
      [prObject({ head: { ref: 'f', sha: HEAD_SHA, repo: { full_name: 'someone/app' } } }), 'fork_not_writable'],
      [prObject({ head: { ref: 'x y', sha: HEAD_SHA, repo: { full_name: REPO } } }), 'unsafe_ref'],
    ]) {
      const gh = github(pr);
      const r = run(gh, w);
      assert.deepEqual(await r.go(), { outcome: 'skipped', reason }, reason);
      assert.deepEqual(r.pushed, [], reason);
      assert.deepEqual(gh.labelsAdded(), [], reason);
    }
  } finally { w.cleanup(); }
});

test('skips: attempts exhausted, but a manual run goes on; the circuit breaker stops a repeated conflict before any model call', async () => {
  const w = workdir();
  try {
    const labelled = prObject({ labels: [{ name: 'conflict-fix-attempt-1' }, { name: 'conflict-fix-attempt-2' }] });
    assert.deepEqual(await run(github(labelled), w).go(), { outcome: 'skipped', reason: 'attempts_exhausted' });
    const manual = await run(github(labelled), w, { manual: true }).go();
    assert.equal(manual.outcome, 'resolved');
    const previous = { user: { login: 'github-actions[bot]' }, body: formatConflictMarker({ sha: HEAD_SHA, outcome: 'escalated', sig: 'abcdef0123', streak: 2 }) };
    const gh = github(prObject({ labels: [{ name: 'conflict-fix-attempt-1' }] }), { comments: [previous] });
    // The real hook is passed to the engine: a stub that applies it, as the engine does after its plan.
    const res = await run(gh, w, { merge: async (opts) => { const stop = await opts.beforeResolve({ sig: 'abcdef0123', files: ['x'] }); return { outcome: 'escalated', reason: stop, files: [], sig: 'abcdef0123', headSha: HEAD_SHA }; } }).go();
    assert.deepEqual(res, { outcome: 'skipped', reason: 'circuit_open' });
    assert.deepEqual(gh.labelsAdded(), [], 'no label, no comment: the escalation is already on the PR');
    assert.equal(gh.comment(), null);
  } finally { w.cleanup(); }
});

test('up to date: a stale dirty status is a skip, nothing is pushed or labelled', async () => {
  const w = workdir();
  try {
    const gh = github(prObject());
    const r = run(gh, w, { merge: async () => ({ outcome: 'noop', files: [], sig: null, headSha: HEAD_SHA }) });
    assert.deepEqual(await r.go(), { outcome: 'skipped', reason: 'up_to_date' });
    assert.deepEqual([r.pushed.length, gh.labelsAdded()], [0, []]);
  } finally { w.cleanup(); }
});

test('resolved: pushes HEAD to the head branch of the head repository, labels the attempt, clears merge-conflict, comments with the outcome marker', async () => {
  const w = workdir();
  try {
    const gh = github(prObject({ labels: [{ name: 'merge-conflict' }] }));
    const r = run(gh, w, { merge: async () => ({ outcome: 'resolved', rung: 'L2', files: ['CHANGELOG.md', 'docs/adr/0059-x.md'], conflicts: 1, hunks: 2, renumbered: [{ from: '0058', to: '0059' }], sig: 'abcdef0123', headSha: HEAD_SHA }) });
    assert.deepEqual(await r.go(), { outcome: 'resolved' });
    assert.deepEqual(r.pushed, [['push', 'https://github.com/koydas/app.git', 'HEAD:refs/heads/feature/x']]);
    assert.deepEqual(gh.labelsAdded(), ['conflict-fix-attempt-1']);
    assert.deepEqual(gh.removed(), ['merge-conflict']);
    const body = gh.comment();
    assert.match(body, /Merge conflicts resolved/);
    assert.match(body, /2 hunk\(s\) resolved by the model/);
    assert.match(body, /`CHANGELOG.md`, `docs\/adr\/0059-x.md`/);
    assert.match(body, /ADR renumbered: 0058 → 0059 \(the base kept its number\)/);
    assert.equal(parseConflictMarker(body).outcome, 'resolved');
  } finally { w.cleanup(); }
});

test('resolved with one attempt already spent uses the next attempt label; the model is built lazily and handed to the engine', async () => {
  const w = workdir();
  try {
    const gh = github(prObject({ labels: [{ name: 'conflict-fix-attempt-1' }] }));
    let seen;
    const r = run(gh, w, { makeCallModel: () => ({ budgetChars: 1234, callModel: async () => 'x' }), merge: async (opts) => { seen = opts; return { outcome: 'resolved', rung: 'L0', files: [], conflicts: 0, hunks: 0, renumbered: [], sig: null, headSha: HEAD_SHA }; } });
    await r.go();
    assert.deepEqual(gh.labelsAdded(), ['conflict-fix-attempt-2']);
    assert.equal(seen.budgetChars, 1234);
    assert.equal(typeof seen.callModel, 'function');
    assert.equal(seen.prNumber, 7);
    assert.equal(seen.title, 'My PR');
    assert.equal(seen.baseRef, 'main');
    assert.match(seen.baseSha, /^[0-9a-f]{40}$/);
    assert.match(gh.comment(), /merge commit/);
  } finally { w.cleanup(); }
});

test('a manual run past the cap reuses the last attempt label instead of inventing one', async () => {
  const w = workdir();
  try {
    const gh = github(prObject({ labels: [{ name: 'conflict-fix-attempt-1' }, { name: 'conflict-fix-attempt-2' }] }));
    await run(gh, w, { manual: true }).go();
    assert.deepEqual(gh.labelsAdded(), ['conflict-fix-attempt-2']);
  } finally { w.cleanup(); }
});

test('escalated: attempt label, needs-human, a comment naming the files and the reason, a marker with signature and streak; nothing pushed', async () => {
  const w = workdir();
  try {
    const gh = github(prObject());
    const r = run(gh, w, { merge: async () => ({ outcome: 'escalated', reason: 'protected_path', blocked: ['scripts/`x`.mjs'], rules: ['r1'], files: [], sig: 'abcdef0123', headSha: HEAD_SHA }) });
    assert.deepEqual(await r.go(), { outcome: 'escalated', reason: 'protected_path' });
    assert.deepEqual(r.pushed, []);
    assert.deepEqual(gh.labelsAdded(), ['conflict-fix-attempt-1', 'needs-human']);
    const body = gh.comment();
    assert.match(body, /a human needs to decide/);
    assert.match(body, /protected list \(ADR-0021\)/);
    assert.match(body, /\*\*Files:\*\* `scripts\/x.mjs`/, 'backticks and line breaks of a file name cannot break out of the code span');
    assert.match(body, /\*\*Rules:\*\* r1/);
    assert.deepEqual(parseConflictMarker(body), { sha: HEAD_SHA, outcome: 'escalated', sig: 'abcdef0123', streak: 1 });
  } finally { w.cleanup(); }
});

test('escalated twice with the same signature: the marker streak grows', async () => {
  const w = workdir();
  try {
    const previous = { user: { login: 'github-actions[bot]' }, body: formatConflictMarker({ sha: HEAD_SHA, outcome: 'escalated', sig: 'abcdef0123', streak: 1 }) };
    const gh = github(prObject({ labels: [{ name: 'conflict-fix-attempt-1' }] }), { comments: [previous] });
    await run(gh, w, { merge: async () => ({ outcome: 'escalated', reason: 'model_rejected', blocked: [], files: [], sig: 'abcdef0123', headSha: HEAD_SHA }) }).go();
    assert.equal(parseConflictMarker(gh.comment()).streak, 2);
    assert.deepEqual(gh.labelsAdded(), ['conflict-fix-attempt-2', 'needs-human']);
  } finally { w.cleanup(); }
});

test('a failed push is an escalation with its reason; a workflow-file refusal is named', async () => {
  const w = workdir();
  try {
    for (const [stderr, reason] of [['remote: rejected', 'push_failed'], ['refusing to allow a Personal Access Token to create or update workflow `.github/workflows/x.yml`', 'workflow_scope']]) {
      const gh = github(prObject());
      const res = await run(gh, w, { push: () => ({ ok: false, stderr }) }).go();
      assert.deepEqual(res, { outcome: 'escalated', reason });
      assert.deepEqual(gh.labelsAdded(), ['conflict-fix-attempt-1', 'needs-human']);
      assert.match(gh.comment(), reason === 'push_failed' ? /could not be pushed/ : /\.github\/workflows\//);
    }
  } finally { w.cleanup(); }
});

test('a failed fetch of the base is an error, not an escalation', async () => {
  const w = workdir();
  try {
    await assert.rejects(run(github(prObject()), w, { fetchBase: () => ({ ok: false, stderr: 'x' }) }).go(), /Fetching the base branch failed/);
  } finally { w.cleanup(); }
});

test('the fetch is made from the base repository into refs/adl/base, the push to the head repository of a fork', async () => {
  const w = workdir();
  try {
    const fetched = [];
    const fork = prObject({ maintainer_can_modify: true, head: { ref: 'fix', sha: HEAD_SHA, repo: { full_name: 'someone/app' } } });
    const r = run(github(fork), w, { fetchBase: (args) => { fetched.push(args); return ok; } });
    await r.go();
    assert.deepEqual(fetched, [['fetch', '--no-tags', 'https://github.com/koydas/app.git', '+refs/heads/main:refs/adl/base']]);
    assert.deepEqual(r.pushed, [['push', 'https://github.com/someone/app.git', 'HEAD:refs/heads/fix']]);
  } finally { w.cleanup(); }
});

// ── gitNetwork ────────────────────────────────────────────────────────────────────────────────────

test('gitNetwork: a real fetch works, the token travels in the environment and never in the error text', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'conflicts-src-'));
  const w = workdir();
  try {
    const g = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
    g(source, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(source, 'f'), '1\n');
    g(source, 'add', '-A'); g(source, 'commit', '-q', '-m', 'one');
    const res = gitNetwork(['fetch', '--no-tags', source, '+refs/heads/main:refs/adl/fetched'], { cwd: w.cwd, token: 'tok-secret' });
    assert.equal(res.ok, true);
    assert.equal(g(w.cwd, 'rev-parse', 'refs/adl/fetched').stdout.trim(), g(source, 'rev-parse', 'HEAD').stdout.trim());
    const bad = gitNetwork(['fetch', path.join(source, 'missing'), 'main'], { cwd: w.cwd, token: 'tok-secret', serverUrl: 'https://ghe.example.com' });
    assert.equal(bad.ok, false);
    assert.ok(!bad.stderr.includes(Buffer.from('x-access-token:tok-secret').toString('base64')));
  } finally { fs.rmSync(source, { recursive: true, force: true }); w.cleanup(); }
});

// ── the model of the stage ────────────────────────────────────────────────────────────────────────

test('modelFor: null (and a warning) without any provider key; with one, a call that reaches the provider', async () => {
  const keys = ['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_URL', 'AI_PROVIDER', 'AI_PROVIDER_CONFLICTS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const restore = () => keys.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { requests.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{"resolutions":[]}' } }] })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    keys.forEach((k) => delete process.env[k]);
    assert.equal(modelFor(), null);
    process.env.GROQ_API_KEY = 'k';
    process.env.GROQ_API_URL = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const model = modelFor();
    assert.ok(model.budgetChars > 0 && model.budgetChars <= 2500 * 4, 'bounded by conflicts_max_input_tokens');
    const raw = await model.callModel({ hunks: '### Hunk 0\n<<<<<<< ours', path: 'CHANGELOG.md', resolver: 'changelog', title: 'T' });
    assert.equal(raw, '{"resolutions":[]}');
    const sent = JSON.stringify(requests[0].messages);
    assert.match(sent, /CHANGELOG\.md/);
    assert.match(sent, /Hunk 0/);
    assert.match(sent, /resolve git merge conflicts/i);
    assert.equal(requests[0].max_tokens, 4096);
  } finally { restore(); server.close(); }
});

// ── entrypoints ───────────────────────────────────────────────────────────────────────────────────

function runScript(name, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, name)], { env: { PATH: process.env.PATH, METRICS_FILE: '/dev/null', ...env }, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('conflicts_fix.mjs fails with a message when PR_NUMBER, the repository or the token is missing or invalid', async () => {
  for (const env of [{}, { PR_NUMBER: '7' }, { PR_NUMBER: '7', GITHUB_REPOSITORY: REPO }, { PR_NUMBER: 'abc', GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 't' }, { PR_NUMBER: '0', GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 't' }]) {
    const res = await runScript('conflicts_fix.mjs', env);
    assert.equal(res.code, 1, JSON.stringify(env));
    assert.match(res.out + res.err, /PR_NUMBER \(positive integer\), GITHUB_REPOSITORY and GITHUB_TOKEN are required/);
    assert.match(res.err, /"event":"conflicts\.error"/);
  }
});

test('detect_conflicts.mjs fails with a message on a missing token or repository and on a bad PR_NUMBER', async () => {
  for (const [env, pattern] of [
    [{}, /GITHUB_TOKEN and GITHUB_REPOSITORY are required/],
    [{ GITHUB_TOKEN: 't' }, /GITHUB_TOKEN and GITHUB_REPOSITORY are required/],
    [{ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, PR_NUMBER: 'x' }, /PR_NUMBER must be a positive integer/],
    [{ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, PR_NUMBER: '-3' }, /PR_NUMBER must be a positive integer/],
  ]) {
    const res = await runScript('detect_conflicts.mjs', env);
    assert.equal(res.code, 1, JSON.stringify(env));
    assert.match(res.out + res.err, pattern);
    assert.match(res.err, /"event":"conflicts_detect\.error"/);
  }
});

test('detect_conflicts.mjs end to end against a GitHub mock: the matrix lands in GITHUB_OUTPUT', async () => {
  const prs = [prObject({ number: 3, head: { ref: 'feat', sha: HEAD_SHA, repo: { full_name: REPO } } })];
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url.startsWith('/repos/koydas/app/pulls?')) return send(200, /&page=1$/.test(req.url) ? prs : []);
    if (req.method === 'GET' && req.url === '/repos/koydas/app/pulls/3') return send(200, prs[0]);
    return send(200, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-out-')), 'out');
  fs.writeFileSync(outFile, '');
  try {
    const res = await runScript('detect_conflicts.mjs', { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: outFile });
    assert.equal(res.code, 0, res.err);
    const out = fs.readFileSync(outFile, 'utf8');
    assert.match(out, /^prs=\[\{"number":3,"head_ref":"feat"/m);
    assert.match(out, /^count=1$/m);
    assert.match(res.err, /"event":"conflicts_detect\.complete".*"fixable":1/);
  } finally { server.close(); fs.rmSync(path.dirname(outFile), { recursive: true, force: true }); }
});
