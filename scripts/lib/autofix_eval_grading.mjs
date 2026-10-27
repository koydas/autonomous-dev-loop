// The grader job of the `autofix` eval suite (EV-03, ADR-0052): from the results file of the model job to one verdict
// per run. The file is DATA: it holds model text, and only two things leave it, `status` and the patch (`schema_version`,
// `changes`, as eval_grader validates them). Nothing else of it is read, run or copied to the output. Only a run whose
// status is PATCH has tests to run, on a copy of its pinned fixture, with the hidden tests restored after the patch
// (eval_grader.evaluatePatch). This module holds no secret and calls no provider.

import { evaluatePatch, GRADER_FAILURES } from './eval_grader.mjs';
import { graderInputFor } from './autofix_dataset.mjs';
import { AUTOFIX_STATUS } from './autofix_eval_adapter.mjs';

export const GRADER_RESULTS_SCHEMA_VERSION = 1;
/** cases x repeats of one run: 6 cases x 3 repeats is 18, so this is a bound on a malformed file, not on the suite. */
export const MAX_RESULTS = 500;
/** Why a run was not graded; `graded: false` entries carry one of these and no outcome. */
export const NOT_GRADED = Object.freeze({
  runErrored: 'RUN_ERRORED', // the model job recorded an error or no output: there is nothing to apply
  noPatch: 'NO_PATCH', // the answer was not a patch (refusal, rejected, invalid, unparseable)
  noGrader: 'NO_GRADER', // a patch for a case that expects none (a refusal case): nothing to run it against
  unknownCase: 'UNKNOWN_CASE', // the case is not in the golden set of this checkout
});

const SAFE_PATH = /^[\w@.+/-]{1,200}$/;
// The offending path of a failed case is patch-controlled text: it leaves only when it looks like a path.
const safePath = (p) => (typeof p === 'string' && SAFE_PATH.test(p) ? p : null);

function checkEntries(modelResults) {
  const entries = modelResults?.results;
  if (!Array.isArray(entries)) throw new Error('model results: "results" must be an array');
  if (entries.length > MAX_RESULTS) throw new Error(`model results: "results" holds ${entries.length} runs, more than ${MAX_RESULTS}`);
  const seen = new Set();
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`model results: results[${i}] must be an object`);
    if (typeof entry.case_id !== 'string' || entry.case_id === '') throw new Error(`model results: results[${i}].case_id must be a non-empty string`);
    if (!Number.isInteger(entry.repeat) || entry.repeat < 0) throw new Error(`model results: results[${i}].repeat must be a non-negative integer`);
    const key = `${entry.case_id}#${entry.repeat}`;
    if (seen.has(key)) throw new Error(`model results: results[${i}] repeats ${key}`);
    seen.add(key);
  });
  return entries;
}

/**
 * @param {object} args
 * @param {{ results: { case_id: string, repeat: number, error?: string | null, output?: object | null }[] }} args.modelResults
 *   the model job's results file, parsed
 * @param {object[]} args.cases the golden set (`loadAutofixCases`)
 * @param {string} [args.root] repository root the case directories are under
 * @param {(input: object, options: object) => Promise<object>} [args.evaluate] `evaluatePatch`, injected by tests
 * @returns {Promise<{ schema_version: number, suite: string, runs: number, graded: number, results: object[] }>}
 *   one entry per run, in the file's order: `{ case_id, repeat, graded: true, outcome, failure, path, checks }` or
 *   `{ case_id, repeat, graded: false, reason }`
 */
export async function gradeModelResults({ modelResults, cases, root, evaluate = evaluatePatch, timeoutMs }) {
  const entries = checkEntries(modelResults);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = [];
  for (const entry of entries) {
    const base = { case_id: entry.case_id, repeat: entry.repeat };
    const notGraded = (reason) => results.push({ ...base, graded: false, reason });
    const testCase = byId.get(entry.case_id);
    if (!testCase) { notGraded(NOT_GRADED.unknownCase); continue; }
    const output = entry.output;
    if (entry.error || !output || typeof output !== 'object') { notGraded(NOT_GRADED.runErrored); continue; }
    if (output.status !== AUTOFIX_STATUS.PATCH) { notGraded(NOT_GRADED.noPatch); continue; }
    if (!testCase.grader) { notGraded(NOT_GRADED.noGrader); continue; }
    let verdict;
    try {
      verdict = await evaluate(graderInputFor(testCase, { schema_version: output.schema_version, changes: output.changes }, root), { timeoutMs });
    } catch {
      // evaluatePatch never throws; a crash around it is the grader's, never a pass and never the patch's fault.
      verdict = { outcome: 'ERROR', failure: GRADER_FAILURES.graderError, path: null, checks: [] };
    }
    results.push({
      ...base,
      graded: true,
      outcome: verdict.outcome,
      failure: verdict.failure ?? null,
      path: safePath(verdict.path),
      checks: (verdict.checks ?? []).map((c) => ({ name: c.name, status: c.status, exit_code: c.exit_code ?? null })),
    });
  }
  return {
    schema_version: GRADER_RESULTS_SCHEMA_VERSION,
    suite: 'autofix',
    runs: results.length,
    graded: results.filter((r) => r.graded).length,
    results,
  };
}

/** `{ "<case_id>#<repeat>": entry }`: what the scoring job looks a run's verdict up by. */
export function indexGraderResults(graderResults) {
  if (graderResults?.schema_version !== GRADER_RESULTS_SCHEMA_VERSION || graderResults?.suite !== 'autofix' || !Array.isArray(graderResults.results)) {
    throw new Error(`grader results: expected schema_version ${GRADER_RESULTS_SCHEMA_VERSION} for suite autofix with a "results" array`);
  }
  return Object.fromEntries(graderResults.results.map((r) => [`${r.case_id}#${r.repeat}`, r]));
}

/**
 * The model phase's output with the grader job's verdict for the same run, as the suite's scorers read it
 * (`output.grader`). Fails closed: a run without a verdict, a verdict the grader could not produce (`ERROR`) and a
 * verdict for a case the golden set does not know are errored runs, never a pass or a plain fail. A run that was
 * not graded because its answer was no patch (`NO_PATCH`) is a normal outcome and keeps `grader: { graded: false }`.
 */
export function attachVerdict(output, index, { caseId, repeat }) {
  const key = `${caseId}#${repeat}`;
  const verdict = index[key];
  if (!verdict) throw new Error(`grader results: no verdict for ${key}`);
  // The score job rebuilds the output from the recorded model answer: a verdict for another outcome means the two jobs
  // did not see the same run (config drift between them), and a score over that would be a score of nothing.
  if ((output.status === AUTOFIX_STATUS.PATCH) !== (verdict.graded === true)) {
    throw new Error(`grader results: ${key} is ${output.status} here but ${verdict.graded ? 'was graded as a patch' : `was not graded (${verdict.reason})`}`);
  }
  if (verdict.graded === false) {
    if (verdict.reason !== NOT_GRADED.noPatch) throw new Error(`grader results: ${key} was not graded (${verdict.reason})`);
    return { ...output, grader: { graded: false, reason: verdict.reason } };
  }
  if (verdict.outcome === 'ERROR') throw new Error(`grader results: ${key} could not be graded (${verdict.failure ?? 'ERROR'})`);
  return { ...output, grader: { graded: true, outcome: verdict.outcome, failure: verdict.failure, path: verdict.path, checks: verdict.checks } };
}
