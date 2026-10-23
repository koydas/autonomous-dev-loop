import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ORACLE_FAILURES as F, MODEL_OUTPUT_SCHEMA_VERSION, MAX_CHANGES, MAX_CONTENT_CHARS,
  digestTree, validateModelOutput, checkPatchPaths, isAllowedCommand, oracleEnv, evaluatePatch,
  applyPatchToCopy, restoreOracleFiles, runOracleChecks, sha256,
} from '../lib/eval_oracle.mjs';

let root;
let fixtureDir;
let oracleDir;
let base;

const write = async (dir, rel, content) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
};

const BUGGY = 'export function find(list, id) {\n  return list.find((c) => c.id === id).name;\n}\n';
const FIXED = 'export function find(list, id) {\n  return list.find((c) => c.id === id)?.name ?? null;\n}\n';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-test-'));
  fixtureDir = path.join(root, 'fixture');
  oracleDir = path.join(root, 'oracle');
  await write(fixtureDir, 'package.json', '{"type":"module"}\n');
  await write(fixtureDir, 'src/customers.mjs', BUGGY);
  await write(fixtureDir, 'test/existing.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { find } from '../src/customers.mjs';\ntest('finds', () => assert.equal(find([{ id: 1, name: 'a' }], 1), 'a'));\n");
  await write(oracleDir, 'test/hidden.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { find } from '../src/customers.mjs';\ntest('unknown customer is null', () => assert.equal(find([], 9), null));\ntest('no secret reaches the oracle', () => { for (const k of ['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PR_TOKEN', 'GITHUB_TOKEN']) assert.equal(process.env[k], undefined); });\n");
  process.env.GROQ_API_KEY = 'secret-groq';
  process.env.GITHUB_TOKEN = 'secret-gh';
  base = {
    fixtureDir,
    fixtureSha256: await digestTree(fixtureDir),
    oracleDir,
    oracleSha256: await digestTree(oracleDir),
    oracle: { existing_tests: 'node --test test/existing.test.mjs', hidden_tests: 'node --test test/hidden.test.mjs' },
    allowedPaths: ['src/customers.mjs'],
    mustNotChange: ['package.json', '.github/'],
    hiddenFiles: ['test/hidden.test.mjs'],
  };
});

after(async () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.GITHUB_TOKEN;
  await fs.rm(root, { recursive: true, force: true });
});

const output = (changes) => ({ schema_version: MODEL_OUTPUT_SCHEMA_VERSION, changes });
const patch = (targetPath, content) => output([{ targetPath, content }]);

test('digestTree is stable, and changes with a content, a name or a symlink target', async () => {
  const d = await fs.mkdtemp(path.join(root, 'd-'));
  await write(d, 'a.txt', 'x');
  const first = await digestTree(d);
  assert.equal(await digestTree(d), first);
  await write(d, 'a.txt', 'y');
  assert.notEqual(await digestTree(d), first);
  await fs.rename(path.join(d, 'a.txt'), path.join(d, 'b.txt'));
  const renamed = await digestTree(d);
  await fs.symlink('b.txt', path.join(d, 'l'));
  assert.notEqual(await digestTree(d), renamed);
});

test('validateModelOutput accepts the schema and rejects every malformed shape with a closed code', () => {
  assert.deepEqual(validateModelOutput(patch('./src/a.mjs', 'x')).changes, [{ targetPath: 'src/a.mjs', content: 'x' }]);
  for (const bad of [null, [], 'x', {}, { schema_version: 2, changes: [] }, { schema_version: 1 }, { schema_version: 1, changes: [{ targetPath: '', content: 'x' }] },
    { schema_version: 1, changes: [{ targetPath: 'a', content: 1 }] }, { schema_version: 1, changes: [{ targetPath: 'a', content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }] },
    { schema_version: 1, changes: Array.from({ length: MAX_CHANGES + 1 }, (_, i) => ({ targetPath: `f${i}`, content: '' })) }]) {
    const r = validateModelOutput(bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, F.schema);
  }
});

test('checkPatchPaths: escape, absolute, duplicate, protected, existing test, not allowed', () => {
  const opts = { allowedPaths: ['src/a.mjs', 'test/t.test.mjs'], mustNotChange: ['package.json', 'ci/'], oracleFiles: ['test/h.test.mjs'], existingTestFiles: ['test/t.test.mjs'] };
  const one = (p) => checkPatchPaths([{ targetPath: p, content: '' }], opts);
  assert.equal(one('src/a.mjs').ok, true);
  for (const p of ['../x', '/etc/passwd', 'C:/x', '..']) assert.equal(one(p).reason, F.pathEscape, p);
  assert.equal(one('package.json').reason, F.protectedPath);
  assert.equal(one('ci/run.sh').reason, F.protectedPath);
  assert.equal(one('test/h.test.mjs').reason, F.protectedPath);
  assert.equal(one('test/t.test.mjs').reason, F.protectedPath);
  assert.equal(one('src/new.mjs').reason, F.notAllowed);
  assert.equal(checkPatchPaths([{ targetPath: 'src/a.mjs', content: '' }, { targetPath: 'src/a.mjs', content: '' }], opts).reason, F.schema);
});

test('isAllowedCommand accepts node --test <paths> only', () => {
  assert.equal(isAllowedCommand('node --test test/a.test.mjs'), true);
  for (const c of ['npm test', 'node --test', 'node --test ../x', 'node --test a; rm -rf /', 'node --test $(id)', 'bash -c x', null]) assert.equal(isAllowedCommand(c), false, String(c));
});

test('oracleEnv is an allowlist: no secret of the parent can be in it', () => {
  const env = oracleEnv('/tmp/h');
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR']);
  assert.ok(!JSON.stringify(env).includes('secret'));
});

test('evaluatePatch: the fix passes both suites', async () => {
  const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', FIXED) });
  assert.equal(r.outcome, 'PASS', JSON.stringify(r));
  assert.deepEqual(r.checks.map((c) => c.status), ['pass', 'pass']);
});

test('evaluatePatch: an incomplete fix fails the hidden tests, not the existing ones', async () => {
  const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', BUGGY) });
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.failure, F.hiddenTests);
  assert.equal(r.checks[0].status, 'pass');
});

test('evaluatePatch: breaking the existing behavior fails the existing tests first', async () => {
  const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', 'export const find = () => null;\n') });
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.failure, F.existingTests);
});

test('evaluatePatch: tampering with the manifest, an existing test or the hidden tests is ORACLE_TAMPERING and nothing runs', async () => {
  for (const p of ['package.json', 'test/existing.test.mjs', 'test/hidden.test.mjs']) {
    const r = await evaluatePatch({ ...base, allowedPaths: [...base.allowedPaths, p], output: patch(p, 'x') });
    assert.equal(r.outcome, 'FAIL', p);
    assert.equal(r.failure, F.tampering, p);
    assert.equal(r.path, p);
    assert.deepEqual(r.checks, []);
  }
});

test('evaluatePatch: path escape and unlisted paths fail deterministically', async () => {
  assert.equal((await evaluatePatch({ ...base, output: patch('../escape.mjs', 'x') })).failure, F.pathEscape);
  assert.equal((await evaluatePatch({ ...base, output: patch('src/other.mjs', 'x') })).failure, F.notAllowed);
});

test('evaluatePatch: a malformed artifact, or a drifted fixture or oracle, is ERROR', async () => {
  assert.deepEqual([(await evaluatePatch({ ...base, output: { schema_version: 9 } })).outcome, (await evaluatePatch({ ...base, output: { schema_version: 9 } })).failure], ['ERROR', F.schema]);
  const drift = await evaluatePatch({ ...base, fixtureSha256: sha256('x'), output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([drift.outcome, drift.failure], ['ERROR', F.fixtureDigest]);
  const oracleDrift = await evaluatePatch({ ...base, oracleSha256: sha256('x'), output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([oracleDrift.outcome, oracleDrift.failure], ['ERROR', F.oracleDigest]);
});

test('evaluatePatch: a command outside the allowed shape is a configuration ERROR', async () => {
  const r = await evaluatePatch({ ...base, oracle: { ...base.oracle, hidden_tests: 'npm test' }, output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([r.outcome, r.failure], ['ERROR', F.oracleError]);
});

test('evaluatePatch: a hanging test is a TIMEOUT error, never a success', async () => {
  const slow = await fs.mkdtemp(path.join(root, 'slow-'));
  await write(slow, 'test/hidden.test.mjs', "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  const r = await evaluatePatch({ ...base, oracleDir: slow, oracleSha256: await digestTree(slow), output: patch('src/customers.mjs', FIXED) }, { timeoutMs: 700 });
  assert.deepEqual([r.outcome, r.failure], ['ERROR', F.timeout]);
});

test('evaluatePatch: a symlink in the fixture is refused', async () => {
  const linked = await fs.mkdtemp(path.join(root, 'linked-'));
  await write(linked, 'src/customers.mjs', BUGGY);
  await fs.symlink('/etc/passwd', path.join(linked, 'src/link'));
  const r = await evaluatePatch({ ...base, fixtureDir: linked, fixtureSha256: await digestTree(linked), output: patch('src/customers.mjs', FIXED) });
  assert.equal(r.failure, F.symlink);
});

test('applyPatchToCopy leaves the fixture untouched, and a planted symlink target is refused', async () => {
  const before = await digestTree(fixtureDir);
  const work = await applyPatchToCopy(fixtureDir, [{ targetPath: 'src/customers.mjs', content: FIXED }]);
  assert.equal(await fs.readFile(path.join(work, 'src/customers.mjs'), 'utf8'), FIXED);
  assert.equal(await digestTree(fixtureDir), before);
  await fs.rm(work, { recursive: true, force: true });
  const planted = await fs.mkdtemp(path.join(root, 'planted-'));
  await write(planted, 'a.txt', 'x');
  // The check runs on the copy, so plant the link in the copy source after validation would have passed: simulate by a fixture link.
  await fs.symlink(path.join(root, 'outside.txt'), path.join(planted, 'b.txt'));
  await assert.rejects(applyPatchToCopy(planted, [{ targetPath: 'b.txt', content: 'pwn' }]), (e) => e.code === F.symlink);
  await assert.rejects(fs.access(path.join(root, 'outside.txt')));
});

test('restoreOracleFiles overwrites what the patch wrote at a hidden path', async () => {
  const work = await applyPatchToCopy(fixtureDir, []);
  await write(work, 'test/hidden.test.mjs', 'tampered');
  await restoreOracleFiles(work, oracleDir, ['test/hidden.test.mjs']);
  assert.equal(await fs.readFile(path.join(work, 'test/hidden.test.mjs'), 'utf8'), await fs.readFile(path.join(oracleDir, 'test/hidden.test.mjs'), 'utf8'));
  await fs.rm(work, { recursive: true, force: true });
});

test('runOracleChecks: spawn errors and failing runs map to their status through an injected runner', async () => {
  const calls = [];
  const run = async (check, opts) => { calls.push({ name: check.name, env: opts.env }); return { status: check.name === 'existing_tests' ? 'pass' : 'error', exit_code: null }; };
  const r = await runOracleChecks(root, base.oracle, { run });
  assert.equal(r.failure, F.oracleError);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(calls[0].env).includes('secret'));
});
