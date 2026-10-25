import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMatrix, dispatchFixes } from '../dispatch_conflicts.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dispatch_conflicts.mjs');

test('parseMatrix: the PR numbers of the detect matrix, deduplicated; anything else is refused', () => {
  assert.deepEqual(parseMatrix('[{"number":3,"head_ref":"a"},{"number":5},{"number":3}]'), [3, 5]);
  assert.deepEqual(parseMatrix(''), []);
  assert.deepEqual(parseMatrix(undefined), []);
  assert.deepEqual(parseMatrix('[]'), []);
  assert.throws(() => parseMatrix('{not json'), /PRS is not valid JSON/);
  assert.throws(() => parseMatrix('{"number":1}'), /PRS must be a JSON array/);
  for (const bad of ['[{"number":0}]', '[{"number":"7"}]', '[{"number":1.5}]', '[{}]', '[null]']) assert.throws(() => parseMatrix(bad), /positive integer number/, bad);
});

test('dispatchFixes: one dispatch per PR with the sweep flag; a refusal does not stop the others', async () => {
  const calls = [];
  const request = async (method, p, body) => { calls.push([method, p, body]); return body.inputs.pr_number === '4' ? { ok: false, status: 422 } : { ok: true, status: 204, json: null }; };
  const res = await dispatchFixes({ request, workflowFile: 'conflicts-fix.yml', ref: 'main', numbers: [3, 4, 5] });
  assert.deepEqual(res, { dispatched: [3, 5], failed: [{ number: 4, status: 422 }] });
  assert.deepEqual(calls[0], ['POST', '/actions/workflows/conflicts-fix.yml/dispatches', { ref: 'main', inputs: { pr_number: '3', sweep: 'true' } }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(await dispatchFixes({ request, workflowFile: 'conflicts-fix.yml', ref: 'main', numbers: [] }), { dispatched: [], failed: [] });
});

test('dispatchFixes: the workflow file and the ref are validated before anything is sent', async () => {
  const request = async () => { throw new Error('nothing may be sent'); };
  for (const workflowFile of [undefined, '', '../x.yml', 'a/b.yml', 'x.txt', 'x y.yml']) await assert.rejects(dispatchFixes({ request, workflowFile, ref: 'main', numbers: [1] }), /CALLER_WORKFLOW_FILE/, String(workflowFile));
  for (const ref of [undefined, '', 'a b', 'x;rm']) await assert.rejects(dispatchFixes({ request, workflowFile: 'c.yml', ref, numbers: [1] }), /DEFAULT_BRANCH/, String(ref));
});

function runScript(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env }, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('dispatch_conflicts.mjs: startup validation, then a run against a GitHub mock (refusals fail the step)', async () => {
  for (const [env, pattern] of [[{}, /GITHUB_TOKEN and GITHUB_REPOSITORY are required/], [{ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PRS: '{' }, /PRS is not valid JSON/]]) {
    const res = await runScript(env);
    assert.equal(res.code, 1);
    assert.match(res.out + res.err, pattern);
    assert.match(res.err, /"event":"conflicts_detect\.error"/);
  }
  const seen = [];
  let refuse = false;
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { seen.push([req.method, req.url, JSON.parse(b)]); res.writeHead(refuse ? 403 : 204); res.end(); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, PRS: '[{"number":3},{"number":8}]', CALLER_WORKFLOW_FILE: 'conflicts-fix.yml', DEFAULT_BRANCH: 'main' };
  try {
    const ok = await runScript(env);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Dispatched 2 fix run\(s\)\./);
    assert.deepEqual(seen.map((c) => [c[1], c[2].inputs.pr_number]), [['/repos/o/r/actions/workflows/conflicts-fix.yml/dispatches', '3'], ['/repos/o/r/actions/workflows/conflicts-fix.yml/dispatches', '8']]);
    assert.match(ok.err, /"event":"conflicts_detect\.dispatched"/);
    refuse = true;
    const bad = await runScript(env);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /2 refused \(#3: 403, #8: 403\)/);
    assert.match(bad.err, /"event":"conflicts_detect\.dispatch_complete".*"failed":2/);
  } finally { server.close(); }
});
