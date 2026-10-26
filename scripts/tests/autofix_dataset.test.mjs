import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AUTOFIX_DATASET_PATH,
  EXPECTED_STATUSES,
  validateAutofixCase,
  loadAutofixCases,
  fixtureRoot,
  computePins,
  graderInputFor,
} from '../lib/autofix_dataset.mjs';
import { evaluatePatch, GRADER_FAILURES as F, MODEL_OUTPUT_SCHEMA_VERSION, digestTree } from '../lib/eval_grader.mjs';
import { buildAutofixContext } from '../lib/autofix_core.mjs';
import { protectedPathEntry } from '../lib/output_writer.mjs';
import { PIPELINE_ROOT } from '../lib/roots.mjs';

const SHA = 'a'.repeat(64);
const good = () => ({
  id: 'c1',
  tags: [],
  input: { feedback: 'fix it', diff: 'diff --git a/x b/x\n' },
  expected: { status: 'PATCH' },
  fixture: { dir: 'evals/fixtures/autofix/c1', sha256: SHA },
  grader: {
    dir: 'evals/graders/autofix/c1',
    sha256: SHA,
    existing_tests: { command: 'node --test test/existing.check.mjs', expected: ['a'] },
    hidden_tests: { command: 'node --test test/hidden.check.mjs', expected: ['b'] },
    hidden_files: ['test/hidden.check.mjs'],
    allowed_paths: ['src/x.mjs'],
    must_not_change: ['package.json'],
  },
});
const refusal = () => ({ ...good(), expected: { status: 'NO_CHANGES', must_name: ['docs/g.md'] }, grader: undefined });
const mutate = (base, fn) => { const c = structuredClone(base()); fn(c); if (c.grader === undefined) delete c.grader; return c; };

// --- validateAutofixCase ---

test('validateAutofixCase: a complete PATCH case and a complete refusal case are accepted and returned', () => {
  const c = good();
  assert.equal(validateAutofixCase(c), c);
  const r = mutate(refusal, () => {});
  assert.equal(validateAutofixCase(r), r);
  assert.deepEqual([...EXPECTED_STATUSES], ['PATCH', 'NO_CHANGES']);
});

test('validateAutofixCase: every missing or malformed field is reported with its path', () => {
  const bad = [
    [good, (c) => { c.input.diff = ''; }, /input\.diff must be a non-empty string/],
    [good, (c) => { delete c.input; }, /input\.diff must be a non-empty string/],
    [good, (c) => { c.input.feedback = '  '; }, /input\.feedback must be a non-empty string or list of strings/],
    [good, (c) => { c.input.feedback = ['ok', 3]; }, /input\.feedback must be/],
    [good, (c) => { c.expected.status = 'PASS'; }, /expected\.status must be one of PATCH, NO_CHANGES/],
    [good, (c) => { c.fixture.dir = '/etc'; }, /fixture\.dir must be a relative path under evals\/fixtures\//],
    [good, (c) => { c.fixture.dir = 'evals/fixtures/../../scripts'; }, /fixture\.dir must be a relative path/],
    [good, (c) => { c.fixture.dir = 'evals/fixtures/autofix/c1/'; }, /fixture\.dir must be a relative path/],
    [good, (c) => { c.fixture.sha256 = 'XYZ'; }, /fixture\.sha256 must be a 64-character/],
    [good, (c) => { delete c.grader; }, /grader is required where a patch is expected/],
    [good, (c) => { c.grader.dir = 'evals/fixtures/autofix/c1'; }, /grader\.dir must be a relative path under evals\/graders\//],
    [good, (c) => { c.grader.sha256 = SHA.toUpperCase(); }, /grader\.sha256 must be a 64-character/],
    [good, (c) => { c.grader.hidden_tests.command = 'npm test'; }, /grader\.hidden_tests\.command must be a `node --test <paths>` command/],
    [good, (c) => { c.grader.existing_tests.command = 'node --test ../x'; }, /grader\.existing_tests\.command must be/],
    [good, (c) => { c.grader.existing_tests.expected = []; }, /grader\.existing_tests\.expected must be a non-empty list of test names/],
    [good, (c) => { c.grader.hidden_tests.expected = ['ok', '']; }, /grader\.hidden_tests\.expected must be/],
    [good, (c) => { c.grader.hidden_files = []; }, /grader\.hidden_files must be a non-empty list of paths/],
    [good, (c) => { c.grader.allowed_paths = 'src/x.mjs'; }, /grader\.allowed_paths must be a non-empty list/],
    [good, (c) => { delete c.grader.must_not_change; }, /grader\.must_not_change must be a non-empty list/],
    [refusal, (c) => { c.expected.must_name = []; }, /expected\.must_name must name the protected or withheld paths/],
    [refusal, (c) => { c.grader = good().grader; }, /grader must be absent/],
  ];
  for (const [base, edit, pattern] of bad) {
    assert.throws(() => validateAutofixCase(mutate(base, edit), 'ds:c1'), (err) => err.message.startsWith('ds:c1: ') && pattern.test(err.message), String(pattern));
  }
});

// --- loadAutofixCases / computePins / graderInputFor on a temporary root ---

let tmp;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-dataset-'));
  await fs.mkdir(path.join(tmp, 'evals/datasets'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'evals/fixtures/autofix/c1'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'evals/graders/autofix/c1'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'evals/fixtures/autofix/c1/a.txt'), 'fixture');
  await fs.writeFile(path.join(tmp, 'evals/graders/autofix/c1/b.txt'), 'grader');
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('loadAutofixCases: reads the dataset file under a root, skipping comment lines, and checks every case', async () => {
  await fs.writeFile(path.join(tmp, AUTOFIX_DATASET_PATH), `// comment\n${JSON.stringify(good())}\n`);
  const cases = await loadAutofixCases({ root: tmp });
  assert.deepEqual(cases.map((c) => c.id), ['c1']);
  await fs.writeFile(path.join(tmp, AUTOFIX_DATASET_PATH), `${JSON.stringify(mutate(good, (c) => { c.fixture.sha256 = 'no'; }))}\n`);
  await assert.rejects(loadAutofixCases({ root: tmp }), /evals\/datasets\/autofix\.jsonl:c1: fixture\.sha256 must be a 64-character/);
  await assert.rejects(loadAutofixCases({ root: tmp, file: 'evals/datasets/missing.jsonl' }), /ENOENT/);
});

test('computePins: digests of the fixture tree and of the grader tree, null grader for a refusal; graderInputFor carries the case\'s own paths', async () => {
  const c = good();
  const pins = await computePins(c, tmp);
  assert.equal(pins.fixture, await digestTree(path.join(tmp, c.fixture.dir)));
  assert.equal(pins.grader, await digestTree(path.join(tmp, c.grader.dir)));
  assert.deepEqual(await computePins(mutate(refusal, () => {}), tmp), { fixture: pins.fixture, grader: null });
  const output = { schema_version: MODEL_OUTPUT_SCHEMA_VERSION, changes: [] };
  const input = graderInputFor(c, output, tmp);
  assert.equal(input.output, output);
  assert.equal(input.fixtureDir, fixtureRoot(c, tmp));
  assert.equal(input.graderDir, path.join(tmp, c.grader.dir));
  assert.deepEqual([input.fixtureSha256, input.graderSha256], [SHA, SHA]);
  assert.deepEqual([input.allowedPaths, input.mustNotChange, input.hiddenFiles], [c.grader.allowed_paths, c.grader.must_not_change, c.grader.hidden_files]);
  assert.deepEqual(Object.keys(input.grader), ['existing_tests', 'hidden_tests']);
});

test('graderInputFor: a case without a grader has nothing to grade', () => {
  assert.throws(() => graderInputFor(mutate(refusal, () => {}), {}, tmp), /c1: has no grader \(expected\.status NO_CHANGES\)/);
});

// --- the committed golden set ---

let cases;
before(async () => {
  cases = await loadAutofixCases();
});

const dataset = () => cases;
const emptyPatch = { schema_version: MODEL_OUTPUT_SCHEMA_VERSION, changes: [] };
const referenceOf = async (c) => JSON.parse(await fs.readFile(path.join(PIPELINE_ROOT, c.grader.dir, 'reference.json'), 'utf8'));

test('golden set: it loads, ids are unique, and it holds both kinds of case', () => {
  assert.ok(dataset().length >= 6);
  assert.equal(new Set(dataset().map((c) => c.id)).size, dataset().length);
  assert.ok(dataset().some((c) => c.expected.status === 'PATCH'));
  assert.ok(dataset().some((c) => c.expected.status === 'NO_CHANGES'));
});

test('golden set: every pin matches its tree (the message gives the new values when a fixture or grader changed on purpose)', async () => {
  for (const c of dataset()) {
    const pins = await computePins(c);
    assert.equal(pins.fixture, c.fixture.sha256, `${c.id}: fixture is ${pins.fixture}`);
    if (c.grader) assert.equal(pins.grader, c.grader.sha256, `${c.id}: grader is ${pins.grader}`);
  }
});

test('golden set: the model can see what it must fix (the paths a patch may write are in the context the stage builds)', async () => {
  for (const c of dataset().filter((x) => x.expected.status === 'PATCH')) {
    const ctx = await buildAutofixContext({ root: fixtureRoot(c), userPromptTemplate: '{{reviewFeedback}}{{diff}}{{fileContents}}', feedbackParts: [c.input.feedback], rawDiff: c.input.diff, budgets: { diffBudget: 4000, feedbackBudget: 2000, fileBudget: 3000 } });
    for (const p of c.grader.allowed_paths) assert.ok(ctx.shownPaths.has(p), `${c.id}: ${p} must be shown`);
  }
});

test('golden set: nothing the model reads names a hidden test or the grader', async () => {
  for (const c of dataset().filter((x) => x.expected.status === 'PATCH')) {
    const fixtureText = [];
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(dir, e.name));
        else fixtureText.push(await fs.readFile(path.join(dir, e.name), 'utf8'));
      }
    };
    await walk(fixtureRoot(c));
    const seen = `${[].concat(c.input.feedback).join('\n')}\n${c.input.diff}\n${fixtureText.join('\n')}`;
    for (const name of c.grader.hidden_tests.expected) assert.ok(!seen.includes(name), `${c.id}: hidden test "${name}" appears in what the model reads`);
    for (const f of c.grader.hidden_files) assert.ok(!seen.includes(path.basename(f)), `${c.id}: ${f} is named in what the model reads`);
  }
});

test('golden set: the hidden tests discriminate: the unmodified fixture fails them, the reference patch passes everything', async () => {
  for (const c of dataset().filter((x) => x.expected.status === 'PATCH')) {
    const before = await evaluatePatch(graderInputFor(c, emptyPatch));
    assert.deepEqual([c.id, before.outcome, before.failure], [c.id, 'FAIL', F.hiddenTests], `${c.id}: an unfixed tree must fail the hidden tests, and only those`);
    assert.deepEqual(before.checks.map((k) => [k.name, k.status]), [['existing_tests', 'pass'], ['hidden_tests', 'fail']], `${c.id}: existing tests pass before the fix`);
    const reference = await referenceOf(c);
    for (const { targetPath } of reference.changes) assert.ok(c.grader.allowed_paths.includes(targetPath), `${c.id}: the reference writes ${targetPath}, not an allowed path`);
    const after = await evaluatePatch(graderInputFor(c, reference));
    assert.deepEqual([c.id, after.outcome, after.failure], [c.id, 'PASS', null]);
  }
});

test('golden set: a patch that edits an existing test or the manifest is tampering, not a pass', async () => {
  const c = dataset().find((x) => x.expected.status === 'PATCH');
  for (const targetPath of ['test/existing.check.mjs', 'package.json']) {
    const r = await evaluatePatch(graderInputFor(c, { schema_version: MODEL_OUTPUT_SCHEMA_VERSION, changes: [{ targetPath, content: 'x' }] }));
    assert.deepEqual([r.outcome, r.failure], ['FAIL', F.tampering], targetPath);
  }
});

test('golden set: the protected-path cases name paths this repository protects, the withheld case names a file the stage withholds', async () => {
  const mixed = dataset().filter((c) => c.tags.includes('protected'));
  assert.ok(mixed.length >= 2, 'one case where only a protected file is named, one where a protected and a fixable one are');
  for (const c of mixed) {
    // A refusal names the protected files themselves; a mixed case lists the protected directory it must leave alone.
    const probes = c.expected.status === 'NO_CHANGES' ? c.expected.must_name : c.grader.must_not_change.filter((p) => p.endsWith('/')).map((p) => `${p}x`);
    assert.ok(probes.length > 0 && probes.some((p) => protectedPathEntry(p)), `${c.id}: none of ${probes.join(', ')} is a protected path`);
  }
  const withheld = dataset().filter((c) => c.tags.includes('withheld'));
  assert.ok(withheld.length >= 1);
  for (const c of withheld) {
    const ctx = await buildAutofixContext({ root: fixtureRoot(c), userPromptTemplate: '{{reviewFeedback}}{{diff}}{{fileContents}}', feedbackParts: [c.input.feedback], rawDiff: c.input.diff, budgets: { diffBudget: 4000, feedbackBudget: 2000, fileBudget: 3000 } });
    for (const p of c.expected.must_name) assert.ok(ctx.hiddenPaths.has(p), `${c.id}: ${p} must be withheld from the model`);
  }
});

test('golden set: a refusal case has a fixture the answer cannot be graded on, and names each path in its feedback', () => {
  for (const c of dataset().filter((x) => x.expected.status === 'NO_CHANGES')) {
    assert.equal(c.grader, undefined);
    for (const p of c.expected.must_name) assert.ok(JSON.stringify(c.input).includes(p), `${c.id}: ${p} is not in the case's feedback or diff`);
  }
});

test('golden set: a hidden test loads its subject at run time, since src/ is not beside it in the repository (a static relative import would be an unresolved_import for the review, RV-03)', async () => {
  for (const c of dataset().filter((x) => x.expected.status === 'PATCH')) {
    for (const f of c.grader.hidden_files) {
      const source = await fs.readFile(path.join(PIPELINE_ROOT, c.grader.dir, f), 'utf8');
      assert.doesNotMatch(source, /^\s*import\b[^'"\n]*from\s+['"]\.{1,2}\//m, `${c.id}: ${f} has a static relative import`);
      assert.match(source, /await import\(new URL\('\.\.\/src\/[\w.-]+', import\.meta\.url\)\)/, `${c.id}: ${f} must load its subject with import(new URL(…))`);
    }
  }
});
