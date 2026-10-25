import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, paginate, addLabel, removeLabel, postComment, conflictLabels } from '../lib/conflicts_github.mjs';
import { loadLabelsConfigAll } from '../lib/layered_config.mjs';

const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => { if (body === undefined) throw new Error('empty'); return body; } });

test('createRequest: base URL, auth, JSON body, parsed result; an empty body is null', async () => {
  const seen = [];
  const request = createRequest({ token: 'tok', repository: 'o/r', apiBase: 'https://api.example.com/', fetchImpl: async (url, init) => { seen.push([url, init]); return res(200, undefined); } });
  const out = await request('POST', '/issues/1/labels', { labels: ['x'] });
  assert.deepEqual(out, { status: 200, ok: true, json: null });
  assert.equal(seen[0][0], 'https://api.example.com/repos/o/r/issues/1/labels');
  assert.equal(seen[0][1].headers.Authorization, 'Bearer tok');
  assert.equal(seen[0][1].body, '{"labels":["x"]}');
  await request('GET', '/pulls/1');
  assert.equal(seen[1][1].body, undefined);
});

test('createRequest: 429 and 5xx are retried, other statuses are returned as they are, exhausted retries return the last response', async () => {
  let calls = 0;
  const flaky = createRequest({ token: 't', repository: 'o/r', fetchImpl: async () => (++calls < 2 ? res(503, {}, { 'retry-after': '0' }) : res(200, { ok: 1 })) });
  assert.deepEqual(await flaky('GET', '/x'), { status: 200, ok: true, json: { ok: 1 } });
  assert.equal(calls, 2);
  const notFound = createRequest({ token: 't', repository: 'o/r', fetchImpl: async () => res(404, { message: 'nope' }) });
  assert.deepEqual(await notFound('GET', '/x'), { status: 404, ok: false, json: { message: 'nope' } });
  let n = 0;
  const down = createRequest({ token: 't', repository: 'o/r', fetchImpl: async () => { n++; return res(500, { e: 1 }, { 'retry-after': '0' }); } });
  assert.deepEqual((await down('GET', '/x')).status, 500);
  assert.ok(n > 1, 'retried before giving up');
});

test('createRequest: a comment POST is not replayed after a 5xx or a network error; a network error is wrapped', async () => {
  let posts = 0;
  const failing = createRequest({ token: 't', repository: 'o/r', fetchImpl: async () => { posts++; return res(502, {}); } });
  assert.equal((await failing('POST', '/issues/1/comments', { body: 'x' })).status, 502);
  assert.equal(posts, 1, 'a comment POST is not retry-safe');
  const broken = createRequest({ token: 't', repository: 'o/r', fetchImpl: async () => { throw new Error('socket hang up'); } });
  await assert.rejects(broken('POST', '/issues/1/comments', {}), /Network error calling GitHub API \(\/issues\/1\/comments\): socket hang up/);
});

test('paginate: reads every page and stops on the short one; a failing page throws', async () => {
  const pages = { 1: Array.from({ length: 100 }, (_, i) => i), 2: [100, 101] };
  const request = async (_m, p) => ({ ok: true, status: 200, json: pages[Number(p.match(/&page=(\d+)$/)[1])] });
  assert.equal((await paginate(request, '/pulls?state=open')).length, 102);
  assert.equal((await paginate(request, '/issues/1/comments')).length, 102, 'the first parameter gets a ?');
  assert.deepEqual(await paginate(async () => ({ ok: true, status: 200, json: null }), '/x'), [], 'a non-array page is empty');
  await assert.rejects(paginate(async () => ({ ok: false, status: 500, json: null }), '/x'), /GET \/x \(page 1\) → 500/);
});

test('addLabel: creates the label (422 = exists) then applies it; either failing throws', async () => {
  const label = { name: 'merge-conflict', color: 'e11d21', description: 'd' };
  const log = [];
  const request = (statuses) => async (m, p, b) => { log.push([m, p, b]); return { ok: statuses[log.length - 1] < 300, status: statuses[log.length - 1] }; };
  await addLabel(request([201, 200]), 5, label);
  assert.deepEqual(log.map((c) => c[1]), ['/labels', '/issues/5/labels']);
  await addLabel(request([0, 0, 422, 200]), 5, label);
  await assert.rejects(addLabel(async () => ({ ok: false, status: 500 }), 5, label), /Label create failed for "merge-conflict": 500/);
  let call = 0;
  await assert.rejects(addLabel(async () => (++call === 1 ? { ok: true, status: 201 } : { ok: false, status: 403 }), 5, label), /Add label "merge-conflict" failed: 403/);
});

test('removeLabel: true when removed, false when it was not there, throws on any other failure; the name is URL-encoded', async () => {
  let path;
  assert.equal(await removeLabel(async (_m, p) => { path = p; return { ok: true, status: 200 }; }, 5, 'a b'), true);
  assert.equal(path, '/issues/5/labels/a%20b');
  assert.equal(await removeLabel(async () => ({ ok: false, status: 404 }), 5, 'x'), false);
  await assert.rejects(removeLabel(async () => ({ ok: false, status: 500 }), 5, 'x'), /Remove label "x" failed: 500/);
});

test('postComment: returns the html_url (null when absent); a failure throws', async () => {
  assert.equal(await postComment(async () => ({ ok: true, status: 201, json: { html_url: 'https://x/c' } }), 5, 'b'), 'https://x/c');
  assert.equal(await postComment(async () => ({ ok: true, status: 201, json: {} }), 5, 'b'), null);
  assert.equal(await postComment(async () => ({ ok: true, status: 201, json: null }), 5, 'b'), null);
  await assert.rejects(postComment(async () => ({ ok: false, status: 403 }), 5, 'b'), /Comment failed: 403/);
});

test('conflictLabels: the three conflict labels and needs-human from the config; an incomplete config throws', () => {
  const labels = loadLabelsConfigAll({});
  const found = conflictLabels(labels);
  assert.equal(found.conflicting.name, 'merge-conflict');
  assert.deepEqual(found.attempts.map((a) => a.name), ['conflict-fix-attempt-1', 'conflict-fix-attempt-2']);
  assert.equal(found.needsHuman.name, 'needs-human');
  assert.throws(() => conflictLabels({ autofix: labels.autofix }), /conflicts\.\{conflicting,attempt1,attempt2\} is missing/);
  assert.throws(() => conflictLabels({ ...labels, conflicts: { conflicting: labels.conflicts.conflicting } }), /is missing/);
});
