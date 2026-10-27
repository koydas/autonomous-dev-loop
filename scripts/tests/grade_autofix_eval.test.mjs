import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, readModelResults, MAX_RESULTS_FILE_BYTES } from '../grade_autofix_eval.mjs';
import { PIPELINE_ROOT } from '../lib/roots.mjs';

const SCRIPT = fileURLToPath(new URL('../grade_autofix_eval.mjs', import.meta.url));
let tmp;
let reference;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grade-autofix-'));
  reference = JSON.parse(await fs.readFile(path.join(PIPELINE_ROOT, 'evals/graders/autofix/fix-page-offset/reference.json'), 'utf8'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const run = (args, cwd = tmp) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp } });
const write = async (name, content) => {
  const file = path.join(tmp, name);
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

test('parseCliArgs: --results is required, --out defaults next to the results directory of the workflow', () => {
  assert.deepEqual(parseCliArgs(['--results', 'r.json']), { results: 'r.json', out: 'evals/grader-results.json' });
  assert.deepEqual(parseCliArgs(['--results', 'r.json', '--out', 'o.json']), { results: 'r.json', out: 'o.json' });
  assert.throws(() => parseCliArgs([]), /--results is required/);
});

test('readModelResults: parses a file, refuses invalid JSON, a missing file and one over the size bound without reading it', async () => {
  assert.deepEqual(await readModelResults(await write('ok.json', { results: [] })), { results: [] });
  await assert.rejects(readModelResults(await write('bad.json', '{ nope')), /bad\.json is not valid JSON/);
  await assert.rejects(readModelResults(path.join(tmp, 'missing.json')), /ENOENT/);
  const huge = path.join(tmp, 'huge.json');
  const handle = await fs.open(huge, 'w');
  await handle.truncate(MAX_RESULTS_FILE_BYTES + 1); // sparse: nothing is written
  await handle.close();
  await assert.rejects(readModelResults(huge), /over the \d+ bound/);
});

test('the script grades a results file and writes one verdict per run, exiting 0 whatever the verdicts', async () => {
  const results = await write('model.json', { results: [
    { case_id: 'fix-page-offset', repeat: 0, error: null, output: { status: 'PATCH', ...reference } },
    { case_id: 'fix-page-offset', repeat: 1, error: null, output: { status: 'PATCH', schema_version: 1, changes: [] } },
    { case_id: 'refuse-protected-docs-only', repeat: 0, error: null, output: { status: 'NO_CHANGES' } },
  ] });
  const out = path.join(tmp, 'nested', 'grader.json');
  const r = run(['--results', results, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Graded 2 of 3 runs \(1 passed, 0 errored\)/);
  const written = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual(written.results.map((x) => [x.case_id, x.repeat, x.graded, x.outcome ?? x.reason, x.failure ?? null]), [
    ['fix-page-offset', 0, true, 'PASS', null],
    ['fix-page-offset', 1, true, 'FAIL', 'HIDDEN_TESTS_FAILED'],
    ['refuse-protected-docs-only', 0, false, 'NO_PATCH', null],
  ]);
});

test('the script exits 1 with the reason when it cannot produce verdicts: no --results, bad JSON, a malformed run', async () => {
  assert.match(run([]).stderr, /--results is required/);
  assert.equal(run([]).status, 1);
  const bad = run(['--results', await write('bad2.json', 'not json'), '--out', path.join(tmp, 'never.json')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not valid JSON/);
  const malformed = run(['--results', await write('mal.json', { results: [{ repeat: 0 }] }), '--out', path.join(tmp, 'never.json')]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /results\[0\]\.case_id must be a non-empty string/);
  await assert.rejects(fs.access(path.join(tmp, 'never.json')), 'no verdict file is left behind');
});

test('the script runs with an environment of PATH and HOME only: it needs no key, token or variable', () => {
  const r = run(['--results', path.join(tmp, 'ok.json'), '--out', path.join(tmp, 'noenv.json')]);
  assert.equal(r.status, 0, r.stderr);
});

// The grader job holds no secret; the code it loads must not be able to use one either. Whatever imports the script
// reaches, transitively, may not include the provider client nor the module that reads credentials from the environment.
function importClosure(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) visit(path.resolve(path.dirname(file), m[1]));
  };
  visit(entry);
  return [...seen].map((f) => path.relative(path.join(PIPELINE_ROOT, 'scripts'), f).split(path.sep).join('/'));
}

test('the script\'s imports never reach the provider client or the credential reader (ADR-0052: the grader job holds no secret)', () => {
  const closure = importClosure(SCRIPT);
  assert.ok(closure.includes('lib/eval_grader.mjs') && closure.includes('lib/autofix_dataset.mjs'), 'the crawl found the grader');
  for (const forbidden of ['lib/llm_client.mjs', 'lib/config.mjs']) assert.ok(!closure.includes(forbidden), `${forbidden} is reachable from the grader job`);
});
