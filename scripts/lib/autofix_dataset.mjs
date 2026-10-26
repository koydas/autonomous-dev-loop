// The golden set of the `autofix` eval suite (EV-03, ADR-0052): loading, shape check, pins and the two inputs a case
// feeds the phases. A case is a mini pull request: the review's feedback and the diff (`input`, what the stage receives),
// the PR tree the model reads (`fixture`) and, where a patch is expected, the independent check that scores it
// (`grader`: hidden tests the model never sees, applied after the patch). Fixture and grader are pinned by SHA-256
// (`digestTree`): a drift is an errored case, never a pass (eval_grader).

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDataset } from './eval_harness.mjs';
import { digestTree, isAllowedCommand } from './eval_grader.mjs';
import { PIPELINE_ROOT } from './roots.mjs';

export const AUTOFIX_DATASET_PATH = 'evals/datasets/autofix.jsonl';
export const FIXTURES_DIR = 'evals/fixtures/';
export const GRADERS_DIR = 'evals/graders/';
/** PATCH: the answer must be a patch that makes the hidden tests pass. NO_CHANGES: `changes: []` naming `must_name`. */
export const EXPECTED_STATUSES = Object.freeze(['PATCH', 'NO_CHANGES']);

const SHA256 = /^[0-9a-f]{64}$/;

function fail(source, field, message) {
  throw new Error(`${source}: ${field} ${message}`);
}

const isNonEmptyStrings = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');

function checkDir(source, field, dir, prefix) {
  if (typeof dir !== 'string' || !dir.startsWith(prefix) || dir.includes('..') || dir.includes('\\') || dir.includes('//') || dir.endsWith('/')) {
    fail(source, field, `must be a relative path under ${prefix} with forward slashes, no "..", no trailing slash`);
  }
}

function checkTests(source, field, tests) {
  if (!tests || !isAllowedCommand(tests.command)) fail(source, `${field}.command`, 'must be a `node --test <paths>` command');
  if (!isNonEmptyStrings(tests.expected)) fail(source, `${field}.expected`, 'must be a non-empty list of test names');
}

/** Field-path errors for a case the harness would otherwise fail on deep inside a run. Returns the case. */
export function validateAutofixCase(c, source = c?.id ?? 'case') {
  const input = c.input;
  if (!input || typeof input.diff !== 'string' || input.diff === '') fail(source, 'input.diff', 'must be a non-empty string');
  const feedback = input.feedback;
  if (!(typeof feedback === 'string' && feedback.trim()) && !isNonEmptyStrings(feedback)) fail(source, 'input.feedback', 'must be a non-empty string or list of strings');
  const status = c.expected?.status;
  if (!EXPECTED_STATUSES.includes(status)) fail(source, 'expected.status', `must be one of ${EXPECTED_STATUSES.join(', ')}`);
  checkDir(source, 'fixture.dir', c.fixture?.dir, FIXTURES_DIR);
  if (!SHA256.test(c.fixture?.sha256 ?? '')) fail(source, 'fixture.sha256', 'must be a 64-character lowercase hex digest');

  if (status === 'NO_CHANGES') {
    if (!isNonEmptyStrings(c.expected.must_name)) fail(source, 'expected.must_name', 'must name the protected or withheld paths the reason has to mention');
    if (c.grader !== undefined) fail(source, 'grader', 'must be absent: no patch is expected, nothing is run');
    return c;
  }
  const g = c.grader;
  if (!g || typeof g !== 'object') fail(source, 'grader', 'is required where a patch is expected');
  checkDir(source, 'grader.dir', g.dir, GRADERS_DIR);
  if (!SHA256.test(g.sha256 ?? '')) fail(source, 'grader.sha256', 'must be a 64-character lowercase hex digest');
  checkTests(source, 'grader.existing_tests', g.existing_tests);
  checkTests(source, 'grader.hidden_tests', g.hidden_tests);
  for (const key of ['hidden_files', 'allowed_paths', 'must_not_change']) {
    if (!isNonEmptyStrings(g[key])) fail(source, `grader.${key}`, 'must be a non-empty list of paths');
  }
  return c;
}

/** The cases of the golden set under `root` (this repository by default), checked field by field. */
export async function loadAutofixCases({ root = PIPELINE_ROOT, file = AUTOFIX_DATASET_PATH } = {}) {
  const source = file;
  const cases = parseDataset(await fs.readFile(path.join(root, file), 'utf8'), source);
  return cases.map((c) => validateAutofixCase(c, `${source}:${c.id}`));
}

/** The tree the model phase reads for a case: `runAutofixModelPhase({ input: c.input, root: fixtureRoot(c) })`. */
export const fixtureRoot = (c, root = PIPELINE_ROOT) => path.join(root, c.fixture.dir);

/** The digests a case should carry, from the trees on disk. `grader` is null for a case without a patch to score. */
export async function computePins(c, root = PIPELINE_ROOT) {
  return {
    fixture: await digestTree(fixtureRoot(c, root)),
    grader: c.grader ? await digestTree(path.join(root, c.grader.dir)) : null,
  };
}

/**
 * The input `evaluatePatch` takes for a PATCH case and the model phase's artifact. The paths are the case's own: a
 * patch may only write `allowed_paths`, never `must_not_change`, the existing tests or the hidden files.
 */
export function graderInputFor(c, output, root = PIPELINE_ROOT) {
  const g = c.grader;
  if (!g) throw new Error(`${c.id}: has no grader (expected.status ${c.expected?.status})`);
  return {
    output,
    fixtureDir: fixtureRoot(c, root),
    fixtureSha256: c.fixture.sha256,
    graderDir: path.join(root, g.dir),
    graderSha256: g.sha256,
    grader: { existing_tests: g.existing_tests, hidden_tests: g.hidden_tests },
    allowedPaths: g.allowed_paths,
    mustNotChange: g.must_not_change,
    hiddenFiles: g.hidden_files,
  };
}
