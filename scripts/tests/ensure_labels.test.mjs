import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelDefinitions, ensureLabels } from '../ensure_labels.mjs';
import { loadLabelsConfigAll } from '../lib/layered_config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const def = (name, color = '0075ca', description = 'd') => ({ name, color, description });
const cfg = (labels) => Object.fromEntries(Object.entries(labels).map(([g, s]) => [g, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v]))]));

test('labelDefinitions lists every label of the real config, colors lower-cased', () => {
  const defs = labelDefinitions(loadLabelsConfigAll({}));
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(names, ['auto-fix-attempt-1', 'auto-fix-attempt-2', 'auto-fix-attempt-3', 'changes-requested', 'needs-human', 'needs-refinement', 'ready-for-dev', 'review-approved', 'review-withheld']);
  for (const d of defs) assert.match(d.color, /^[0-9a-f]{6}$/);
});

test('labelDefinitions rejects an empty name, a bad color, a missing or long description, with the config path', () => {
  const ok = { name: 'a', color: '00ff00', description: 'x' };
  assert.throws(() => labelDefinitions(cfg({ g: { s: { ...ok, name: '  ' } } })), /g\.s\.name must not be empty/);
  assert.throws(() => labelDefinitions(cfg({ g: { s: { ...ok, name: undefined } } })), /g\.s\.name must not be empty/);
  for (const color of ['#00ff00', '0f0', 'gggggg', undefined, '']) {
    assert.throws(() => labelDefinitions(cfg({ g: { s: { ...ok, color } } })), /g\.s\.color must be six hex digits/, String(color));
  }
  assert.throws(() => labelDefinitions(cfg({ g: { s: { ...ok, description: undefined } } })), /g\.s\.description is missing/);
  assert.throws(() => labelDefinitions(cfg({ g: { s: { ...ok, description: 'x'.repeat(101) } } })), /101 characters, GitHub allows 100/);
  assert.equal(labelDefinitions(cfg({ g: { s: { ...ok, description: 'x'.repeat(100) } } })).length, 1);
});

test('labelDefinitions rejects two entries naming the same label, in any letter case', () => {
  const a = { name: 'Ready', color: '00ff00', description: 'x' };
  assert.throws(() => labelDefinitions(cfg({ g: { s: a, t: { ...a, name: 'ready' } } })), /g\.t and g\.s both name the label "ready"/);
});

// An in-memory repository behind the request function the script uses.
function fakeRepo(initial = [], { postStatus = 201, listStatus = 200, patchStatus = 200 } = {}) {
  const labels = initial.map((l) => ({ ...l }));
  const calls = [];
  const request = async (method, apiPath, body) => {
    calls.push([method, apiPath, body]);
    if (method === 'GET') {
      if (listStatus !== 200) return { status: listStatus, ok: false, json: null };
      const page = Number(/[?&]page=(\d+)/.exec(apiPath)[1]);
      return { status: 200, ok: true, json: labels.slice((page - 1) * 100, page * 100) };
    }
    if (method === 'POST') {
      if (postStatus === 201) labels.push({ ...body });
      return { status: postStatus, ok: postStatus < 300, json: null };
    }
    if (method === 'PATCH') {
      const found = labels.find((l) => `/labels/${encodeURIComponent(l.name)}` === apiPath);
      if (patchStatus === 200 && found) Object.assign(found, body);
      return { status: patchStatus, ok: patchStatus < 300, json: null };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, labels, calls, writes: () => calls.filter(([m]) => m !== 'GET') };
}

test('ensureLabels creates the missing labels and leaves the others alone', async () => {
  const repo = fakeRepo([def('b')]);
  const result = await ensureLabels({ request: repo.request, definitions: [def('a'), def('b')] });
  assert.deepEqual(result, { created: ['a'], existing: ['b'], updated: [], drift: [] });
  assert.deepEqual(repo.writes().map(([m, p, b]) => [m, p, b.name]), [['POST', '/labels', 'a']]);
});

test('ensureLabels is idempotent: a second run writes nothing', async () => {
  const repo = fakeRepo();
  const definitions = [def('a'), def('b', 'ff0000', 'other')];
  await ensureLabels({ request: repo.request, definitions });
  const before = repo.writes().length;
  const second = await ensureLabels({ request: repo.request, definitions });
  assert.equal(repo.writes().length, before);
  assert.deepEqual(second, { created: [], existing: ['a', 'b'], updated: [], drift: [] });
});

test('ensureLabels matches existing names without regard to letter case, and compares colors the same way', async () => {
  const repo = fakeRepo([{ name: 'READY-for-dev', color: '0075CA', description: 'd' }]);
  const result = await ensureLabels({ request: repo.request, definitions: [def('ready-for-dev')] });
  assert.deepEqual(result, { created: [], existing: ['ready-for-dev'], updated: [], drift: [] });
  assert.equal(repo.writes().length, 0);
});

test('ensureLabels reads every page of the existing labels', async () => {
  const many = Array.from({ length: 230 }, (_, i) => def(`l${i}`));
  const repo = fakeRepo(many);
  const result = await ensureLabels({ request: repo.request, definitions: [def('l229'), def('missing')] });
  assert.deepEqual(result.created, ['missing']);
  assert.deepEqual(result.existing, ['l229']);
  assert.equal(repo.calls.filter(([m]) => m === 'GET').length, 3);
});

test('ensureLabels reports a color or description that differs, and only --update changes it', async () => {
  const repo = fakeRepo([def('a', 'ff0000', 'old')]);
  const reported = await ensureLabels({ request: repo.request, definitions: [def('a')] });
  assert.deepEqual(reported, { created: [], existing: ['a'], updated: [], drift: ['a'] });
  assert.equal(repo.writes().length, 0, 'drift alone writes nothing');
  const updated = await ensureLabels({ request: repo.request, definitions: [def('a')], update: true });
  assert.deepEqual(updated.updated, ['a']);
  assert.deepEqual(repo.writes(), [['PATCH', '/labels/a', { color: '0075ca', description: 'd' }]]);
  assert.deepEqual(repo.labels[0], { name: 'a', color: '0075ca', description: 'd' });
});

test('ensureLabels with dryRun lists what it would create and update, and writes nothing', async () => {
  const repo = fakeRepo([def('a', 'ff0000', 'old')]);
  const result = await ensureLabels({ request: repo.request, definitions: [def('a'), def('new')], update: true, dryRun: true });
  assert.deepEqual(result, { created: ['new'], existing: ['a'], updated: [], drift: ['a'] });
  assert.equal(repo.writes().length, 0);
});

test('ensureLabels treats a label created in between (422) as existing, and fails on any other error', async () => {
  const race = fakeRepo([], { postStatus: 422 });
  assert.deepEqual(await ensureLabels({ request: race.request, definitions: [def('a')] }), { created: [], existing: ['a'], updated: [], drift: [] });
  await assert.rejects(ensureLabels({ request: fakeRepo([], { postStatus: 403 }).request, definitions: [def('a')] }), /POST \/labels \(a\) → 403/);
  await assert.rejects(ensureLabels({ request: fakeRepo([], { listStatus: 500 }).request, definitions: [def('a')] }), /GET \/labels \(page 1\) → 500/);
  await assert.rejects(ensureLabels({ request: fakeRepo([def('a', 'ff0000')], { patchStatus: 404 }).request, definitions: [def('a')], update: true }), /PATCH \/labels\/a → 404/);
});

test('ensureLabels percent-encodes a label name in the PATCH path', async () => {
  const repo = fakeRepo([def('needs work', 'ff0000')]);
  await ensureLabels({ request: repo.request, definitions: [def('needs work')], update: true });
  assert.equal(repo.writes()[0][1], '/labels/needs%20work');
});

// ---- the CLI, against a local API ----
function startApi({ existing = [], listStatus = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') { res.writeHead(listStatus); return res.end(listStatus === 200 ? JSON.stringify(existing) : '{}'); }
      res.writeHead(201);
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'scripts', 'ensure_labels.mjs'), ...args], {
      cwd: REPO, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('ensure_labels creates every label of the config in an empty repository, then reports a second run as a no-op', async () => {
  const api = await startApi();
  try {
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app', GITHUB_API_URL: `http://127.0.0.1:${api.port}` };
    const first = await runCli([], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^acme\/app: created 9, already present 0 \(created: ready-for-dev, /);
    assert.equal(api.requests.filter((r) => r.method === 'POST').length, 9);
    assert.ok(api.requests.every((r) => r.url.startsWith('/repos/acme/app/labels')));
    assert.match(first.stderr, /"event":"labels_install\.start"/);
    assert.match(first.stderr, /"event":"labels_install\.complete".*"duration_ms":\d+/);
  } finally {
    api.server.close();
  }
});

test('ensure_labels --dry-run writes nothing; --update says what it brings back', async () => {
  const api = await startApi({ existing: [{ name: 'ready-for-dev', color: 'ffffff', description: 'old' }] });
  try {
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app', GITHUB_API_URL: `http://127.0.0.1:${api.port}` };
    const dry = await runCli(['--dry-run'], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would create 8, already present 1/);
    assert.match(dry.stdout, /1 label\(s\) differ from the config in color or description: ready-for-dev — run with --update to bring them back/);
    assert.equal(api.requests.filter((r) => r.method !== 'GET').length, 0);
    const dryUpdate = await runCli(['--dry-run', '--update'], env);
    assert.match(dryUpdate.stdout, /ready-for-dev — would update/);
  } finally {
    api.server.close();
  }
});

test('ensure_labels fails with a message: missing environment, unknown option, API error', async () => {
  const noEnv = await runCli([], {});
  assert.equal(noEnv.code, 1);
  assert.match(noEnv.stderr, /::error::GITHUB_REPOSITORY and GITHUB_TOKEN \(or GH_TOKEN\) are required/);
  assert.match(noEnv.stderr, /"event":"labels_install\.error"/);
  const bad = await runCli(['--force'], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown option --force \(expected --update, --dry-run\)/);
  const api = await startApi({ listStatus: 403 });
  try {
    const res = await runCli([], { GH_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app', GITHUB_API_URL: `http://127.0.0.1:${api.port}` });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /GET \/labels \(page 1\) → 403/);
  } finally {
    api.server.close();
  }
});
