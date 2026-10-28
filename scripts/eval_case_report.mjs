#!/usr/bin/env node

/**
 * Case-level repeat diagnostics of a recorded eval run (#325): per case, each repeat's verdict and
 * blocker codes, wrong repeats, verdict flips, and whether the case is inconsistent or consistently wrong.
 * Reads the results file only: no LLM call, same input → same output.
 *
 *   node scripts/eval_case_report.mjs evals/results/validation-<runId>.json [--dataset <jsonl>] [--all] [--json]
 *
 * --dataset  expected blocker codes per case (default: the run's meta.dataset, when the file exists)
 * --all      list every case, stable and correct ones included
 * --json     print the report object instead of Markdown
 */

import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDataset } from './lib/eval_harness.mjs';
import { buildCaseReport, formatCaseReport } from './lib/eval_case_report.mjs';

export function caseReportFromFiles(argv, { read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dataset: { type: 'string' }, all: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  });
  if (positionals.length !== 1) throw new Error('usage: eval_case_report.mjs <results.json> [--dataset <jsonl>] [--all] [--json]');
  const file = positionals[0];
  let run;
  try {
    run = JSON.parse(read(file));
  } catch (err) {
    throw new Error(`${file}: cannot read results (${err.message})`);
  }
  if (!Array.isArray(run?.results)) throw new Error(`${file}: no results[] array`);

  const datasetPath = values.dataset ?? run.meta?.dataset;
  const expectedBlockers = {};
  if (datasetPath && (values.dataset || exists(datasetPath))) {
    for (const c of parseDataset(read(datasetPath), datasetPath)) {
      if (Array.isArray(c.expected?.blockers)) expectedBlockers[c.id] = [...c.expected.blockers].sort();
    }
  }
  const report = buildCaseReport(run.results, { expectedBlockers });
  return values.json ? `${JSON.stringify(report, null, 2)}\n` : formatCaseReport(report, { all: values.all });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(caseReportFromFiles(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
