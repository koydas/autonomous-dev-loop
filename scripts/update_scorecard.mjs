#!/usr/bin/env node

/**
 * Record live eval results on the committed scorecard.
 *
 *   node scripts/update_scorecard.mjs evals/results/<suite>-<runId>.json [...more]
 *   node scripts/update_scorecard.mjs            # no file: regenerate the views only
 *
 * Updates evals/scorecard.json, regenerates evals/SCORECARD.md and the README scorecard block.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRuns } from './lib/eval_scorecard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SCORECARD_PATHS = {
  scorecardFile: path.join(REPO_ROOT, 'evals', 'scorecard.json'),
  markdownFile: path.join(REPO_ROOT, 'evals', 'SCORECARD.md'),
  readmeFile: path.join(REPO_ROOT, 'README.md'),
};

async function main() {
  const files = process.argv.slice(2);
  const resultsList = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))));
  const scorecard = await recordRuns(resultsList, SCORECARD_PATHS);
  for (const [suite, { runs }] of Object.entries(scorecard.suites)) {
    console.log(`${suite}: ${runs.length} run(s) recorded, latest ${runs[0].run_id} (${runs[0].passed ? 'pass' : 'fail'})`);
  }
  console.log('Updated evals/scorecard.json, evals/SCORECARD.md, README.md');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
