import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GRADER_FAILURES as F, MODEL_OUTPUT_SCHEMA_VERSION, MAX_CHANGES, MAX_CONTENT_CHARS,
  digestTree, validateModelOutput, checkPatchPaths, isAllowedCommand, graderEnv, evaluatePatch,
  applyPatchToCopy, restoreGraderFiles, runGraderChecks, digestFiles, verifyTestRun, sha256,
} from '../lib/eval_grader.mjs';

let root;
let fixtureDir;
let graderDir;
let base;

const write = async (dir, rel, content) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
};

const BUGGY = 'export function find(list, id) {\n  return list.find((c) => c.id === id).name;\n}\n';
const FIXED = 'export function find(list, id) {\n  return list.find((c) => c.id === id)?.name ?? null;\n}\n';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'grader-test-'));
  fixtureDir = path.join(root, 'fixture');
  graderDir = path.join(root, 'grader');
  await write(fixtureDir, 'package.json', '{"type":"module"}\n');
  await write(fixtureDir, 'src/customers.mjs', BUGGY);
  await write(fixtureDir, 'test/existing.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { find } from '../src/customers.mjs';\ntest('finds', () => assert.equal(find([{ id: 1, name: 'a' }], 1), 'a'));\n");
  await write(graderDir, 'test/hidden.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { find } from '../src/customers.mjs';\ntest('unknown customer is null', () => assert.equal(find([], 9), null));\ntest('no secret reaches the grader', () => { for (const k of ['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PR_TOKEN', 'GITHUB_TOKEN']) assert.equal(process.env[k], undefined); });\n");
  process.env.GROQ_API_KEY = 'secret-groq';
  process.env.GITHUB_TOKEN = 'secret-gh';
  base = {
    fixtureDir,
    fixtureSha256: await digestTree(fixtureDir),
    graderDir,
    graderSha256: await digestTree(graderDir),
    grader: {
      existing_tests: { command: 'node --test test/existing.test.mjs', expected: ['finds'] },
      hidden_tests: { command: 'node --test test/hidden.test.mjs', expected: ['unknown customer is null', 'no secret reaches the grader'] },
    },
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

// What `node --test --test-reporter=tap` prints for passing top-level tests.
const tap = (names, { extra = '' } = {}) => ['TAP version 13', ...names.flatMap((n, i) => [`# Subtest: ${n}`, `ok ${i + 1} - ${n}`, '  ---', '  type: \'test\'', '  ...']), `1..${names.length}`, `# tests ${names.length}`, '# suites 0', `# pass ${names.length}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', extra].join('\n');

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
  const opts = { allowedPaths: ['src/a.mjs', 'test/t.test.mjs'], mustNotChange: ['package.json', 'ci/'], graderFiles: ['test/h.test.mjs'], existingTestFiles: ['test/t.test.mjs'] };
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

test('graderEnv is an allowlist: no secret of the parent can be in it', () => {
  const env = graderEnv('/tmp/h');
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

test('evaluatePatch: tampering with the manifest, an existing test or the hidden tests is GRADER_TAMPERING and nothing runs', async () => {
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

test('evaluatePatch: a malformed artifact, or a drifted fixture or grader, is ERROR', async () => {
  assert.deepEqual([(await evaluatePatch({ ...base, output: { schema_version: 9 } })).outcome, (await evaluatePatch({ ...base, output: { schema_version: 9 } })).failure], ['ERROR', F.schema]);
  const drift = await evaluatePatch({ ...base, fixtureSha256: sha256('x'), output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([drift.outcome, drift.failure], ['ERROR', F.fixtureDigest]);
  const graderDrift = await evaluatePatch({ ...base, graderSha256: sha256('x'), output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([graderDrift.outcome, graderDrift.failure], ['ERROR', F.graderDigest]);
});

test('evaluatePatch: a command outside the allowed shape is a configuration ERROR', async () => {
  const r = await evaluatePatch({ ...base, grader: { ...base.grader, hidden_tests: { command: 'npm test', expected: ['x'] } }, output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([r.outcome, r.failure], ['ERROR', F.graderError]);
});

test('evaluatePatch: a hanging test is a TIMEOUT error, never a success', async () => {
  const slow = await fs.mkdtemp(path.join(root, 'slow-'));
  await write(slow, 'test/hidden.test.mjs', "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  const r = await evaluatePatch({ ...base, graderDir: slow, graderSha256: await digestTree(slow), output: patch('src/customers.mjs', FIXED) }, { timeoutMs: 700 });
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

test('restoreGraderFiles overwrites what the patch wrote at a hidden path', async () => {
  const work = await applyPatchToCopy(fixtureDir, []);
  await write(work, 'test/hidden.test.mjs', 'tampered');
  await restoreGraderFiles(work, graderDir, ['test/hidden.test.mjs']);
  assert.equal(await fs.readFile(path.join(work, 'test/hidden.test.mjs'), 'utf8'), await fs.readFile(path.join(graderDir, 'test/hidden.test.mjs'), 'utf8'));
  await fs.rm(work, { recursive: true, force: true });
});

test('runGraderChecks: spawn errors map to their status through an injected runner, and every copy is cleaned up', async () => {
  const calls = [];
  let cleaned = 0;
  const prepare = async () => ({ workDir: root, protectedFiles: [], cleanup: async () => { cleaned += 1; } });
  const run = async (check, opts) => { calls.push({ name: check.name, env: opts.env }); return check.name === 'existing_tests' ? { status: 'pass', exit_code: 0, output_tail: tap(['finds']) } : { status: 'error', exit_code: null }; };
  const r = await runGraderChecks(prepare, base.grader, { run });
  assert.equal(r.failure, F.graderError);
  assert.equal(calls.length, 2);
  assert.equal(cleaned, 2);
  assert.ok(!JSON.stringify(calls[0].env).includes('secret'));
});

test('runGraderChecks: a command outside the allowed shape stops before any copy is made', async () => {
  let prepared = 0;
  const r = await runGraderChecks(async () => { prepared += 1; return { workDir: root }; }, { existing_tests: { command: 'npm test', expected: ['x'] }, hidden_tests: { command: 'x', expected: ['x'] } });
  assert.equal(r.failure, F.graderError);
  assert.equal(prepared, 0);
});

test('digestFiles: content, deletion and order are distinguished', async () => {
  const d = await fs.mkdtemp(path.join(root, 'df-'));
  await write(d, 'a', '1');
  await write(d, 'b', '2');
  const both = await digestFiles(d, ['a', 'b']);
  assert.equal(await digestFiles(d, ['b', 'a']), both);
  await write(d, 'b', '3');
  assert.notEqual(await digestFiles(d, ['a', 'b']), both);
  await fs.rm(path.join(d, 'b'));
  assert.notEqual(await digestFiles(d, ['a', 'b']), both);
  assert.notEqual(await digestFiles(d, ['a', 'b']), await digestFiles(d, ['a']));
});

const SELF_MODIFYING = (body) => `import fs from 'node:fs';\n${body}\n${FIXED}`;

test('evaluatePatch: code that rewrites the hidden tests while the existing tests import it is GRADER_TAMPERING, not a pass', async () => {
  const wrong = "import fs from 'node:fs';\nfs.writeFileSync(new URL('../test/hidden.test.mjs', import.meta.url), '');\nexport const find = () => 1;\n";
  const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', wrong) });
  assert.deepEqual([r.outcome, r.failure], ['FAIL', F.tampering]);
});

test('evaluatePatch: deleting or rewriting an existing test at runtime is GRADER_TAMPERING', async () => {
  for (const body of ["fs.rmSync(new URL('../test/existing.test.mjs', import.meta.url));", "fs.writeFileSync(new URL('../test/existing.test.mjs', import.meta.url), '// weakened');"]) {
    const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', SELF_MODIFYING(body)) });
    assert.deepEqual([r.outcome, r.failure], ['FAIL', F.tampering], body);
  }
});

test('evaluatePatch: each command runs in a fresh copy, so state left by the first run does not reach the second', async () => {
  const stateful = SELF_MODIFYING("if (fs.existsSync('.flag')) throw new Error('state leaked'); fs.writeFileSync('.flag', '1');");
  const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', stateful) });
  assert.equal(r.outcome, 'PASS', JSON.stringify(r));
});

test('digestTree: framing is unambiguous, a file holding the next entry cannot collide with two files', async () => {
  const one = await fs.mkdtemp(path.join(root, 'c1-'));
  const two = await fs.mkdtemp(path.join(root, 'c2-'));
  await write(one, 'a.txt', 'x\0b.txt\0y');
  await write(two, 'a.txt', 'x');
  await write(two, 'b.txt', 'y');
  assert.notEqual(await digestTree(one), await digestTree(two));
  // A symlink and a file with the same name and payload are different entries.
  const file = await fs.mkdtemp(path.join(root, 'c3-'));
  const link = await fs.mkdtemp(path.join(root, 'c4-'));
  await write(file, 'l', 'target');
  await fs.symlink('target', path.join(link, 'l'));
  assert.notEqual(await digestTree(file), await digestTree(link));
});

test('evaluatePatch: a missing fixture or grader directory is a classified ERROR, not a throw', async () => {
  const missing = path.join(root, 'does-not-exist');
  for (const patchInput of [{ fixtureDir: missing }, { graderDir: missing }]) {
    const r = await evaluatePatch({ ...base, ...patchInput, output: patch('src/customers.mjs', FIXED) });
    assert.deepEqual([r.outcome, r.failure], ['ERROR', F.graderError]);
  }
});

test('evaluatePatch: an input without an artifact or a directory is an ERROR too', async () => {
  assert.equal((await evaluatePatch(undefined)).outcome, 'ERROR');
  assert.equal((await evaluatePatch({ ...base, output: undefined })).failure, F.schema);
  const unreadable = await evaluatePatch({ ...base, fixtureDir: undefined, output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([unreadable.outcome, unreadable.failure], ['ERROR', F.graderError]);
});

test('applyPatchToCopy removes its temporary directory when it throws', async () => {
  const tmpCopies = async () => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('eval-grader-')).sort();
  const before = await tmpCopies();
  const linked = await fs.mkdtemp(path.join(root, 'leak-'));
  await write(linked, 'a.txt', 'x');
  await fs.symlink('a.txt', path.join(linked, 'l'));
  await assert.rejects(applyPatchToCopy(linked, []), (e) => e.code === F.symlink);
  await assert.rejects(applyPatchToCopy(fixtureDir, [{ targetPath: '../escape.txt', content: 'x' }]), (e) => e.code === F.pathEscape);
  await assert.rejects(applyPatchToCopy(path.join(root, 'does-not-exist'), []));
  assert.deepEqual(await tmpCopies(), before);
});

test('evaluatePatch: a hidden file the grader directory does not hold is an ERROR and leaves no copy behind', async () => {
  const tmpCopies = async () => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('eval-grader-')).sort();
  const before = await tmpCopies();
  const r = await evaluatePatch({ ...base, hiddenFiles: ['test/missing.test.mjs'], output: patch('src/customers.mjs', FIXED) });
  assert.deepEqual([r.outcome, r.failure], ['ERROR', F.graderError]);
  assert.deepEqual(await tmpCopies(), before);
});

test('verifyTestRun: complete runs pass; missing summary, wrong counts, skipped, cancelled, missing names and forged lines do not', () => {
  const names = ['a', 'b.c (d)'];
  assert.deepEqual(verifyTestRun(tap(names), names), { ok: true, reason: null });
  assert.equal(verifyTestRun('', names).ok, false);
  assert.equal(verifyTestRun(undefined, names).ok, false);
  assert.equal(verifyTestRun(tap(['a']), names).ok, false);
  assert.equal(verifyTestRun(tap(names).replace('# pass 2', '# pass 1'), names).ok, false);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(verifyTestRun(tap(names).replace(`# ${key} 0`, `# ${key} 1`), names).ok, false, key);
  assert.equal(verifyTestRun(tap(['a', 'other']), names).ok, false);
  // The runner prefixes anything the tested code prints with "# ", so forged results never match a result line.
  assert.equal(verifyTestRun(['TAP version 13', '# ok 1 - a', '# ok 2 - b.c (d)', '# # tests 2', '# # pass 2', 'ok 1 - test/t.test.mjs', '1..1', '# tests 1', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n'), names).ok, false);
  // Only the closing summary counts: an earlier line cannot stand in for it.
  assert.equal(verifyTestRun(`# tests 2\n# pass 2\n${tap(['a'])}`, names).ok, false);
});

test('evaluatePatch: process.exit(0) while the tests load is TESTS_INCOMPLETE, not a pass', async () => {
  const premature = 'process.exit(0);\nexport const find = () => null;\n';
  const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', premature) });
  assert.deepEqual([r.outcome, r.failure], ['FAIL', F.incomplete]);
  assert.equal(r.checks[0].name, 'existing_tests');
});

test('evaluatePatch: the hidden tests must complete too, even when the existing ones do', async () => {
  // Exits only once the hidden suite is running (it is the one that reads the flag it was given).
  const sneaky = SELF_MODIFYING("if (process.argv.some((a) => a.endsWith('hidden.test.mjs'))) process.exit(0);");
  const r = await evaluatePatch({ ...base, output: patch('src/customers.mjs', sneaky) });
  assert.deepEqual([r.outcome, r.failure], ['FAIL', F.incomplete], JSON.stringify(r));
  assert.deepEqual(r.checks.map((c) => c.name), ['existing_tests', 'hidden_tests']);
});

test('runGraderChecks: expected tests missing or malformed in the grader is a configuration ERROR before any copy', async () => {
  for (const bad of [undefined, [], [''], [1], 'x']) {
    let prepared = 0;
    const r = await runGraderChecks(async () => { prepared += 1; return { workDir: root }; }, { existing_tests: { command: 'node --test t.mjs', expected: bad }, hidden_tests: base.grader.hidden_tests });
    assert.equal(r.failure, F.graderError, String(bad));
    assert.equal(prepared, 0);
  }
});
