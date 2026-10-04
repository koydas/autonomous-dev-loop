#!/usr/bin/env node

/**
 * Build the eval dashboard (GitHub Pages) from live eval results.
 *
 *   node scripts/build_eval_site.mjs --out <dir> [--site-url <deployed site>] [--previous-dir <dir>] [results.json ...]
 *
 * History is read back from the deployed site (--site-url: scorecard.json + runs/<id>.json) or
 * from a local build (--previous-dir). A missing previous site (404 / no file) starts empty;
 * any other read error aborts, so a transient failure never deploys a site without history.
 * Runs that failed on error_rate (provider outage) and replays are left out.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { emptyScorecard, toScorecardRun, addRun, partitionPublishable } from './lib/eval_scorecard.mjs';
import { buildSite } from './lib/eval_site.mjs';
import { SUITES } from './lib/eval_suites.mjs';

function retainedRunIds(scorecard) {
  return Object.values(scorecard.suites).flatMap((s) => (s.runs ?? []).map((r) => r.run_id));
}

function validateScorecard(scorecard, source) {
  if (scorecard?.version !== 1 || typeof scorecard.suites !== 'object' || scorecard.suites === null) {
    throw new Error(`${source}: unsupported scorecard format`);
  }
  return scorecard;
}

export async function fetchPreviousSite(siteUrl, fetchImpl = fetch) {
  const base = siteUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/scorecard.json`);
  if (res.status === 404) return { scorecard: emptyScorecard(), details: {} };
  if (!res.ok) throw new Error(`Cannot read the previous scorecard (${base}/scorecard.json): HTTP ${res.status}`);
  const scorecard = validateScorecard(await res.json(), `${base}/scorecard.json`);
  const details = {};
  for (const runId of retainedRunIds(scorecard)) {
    const r = await fetchImpl(`${base}/runs/${encodeURIComponent(runId)}.json`);
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`Cannot read run ${runId} from the previous site: HTTP ${r.status}`);
    details[runId] = await r.json();
  }
  return { scorecard, details };
}

export async function readPreviousSiteDir(dir) {
  let raw;
  try {
    raw = await fs.readFile(path.join(dir, 'scorecard.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { scorecard: emptyScorecard(), details: {} };
    throw err;
  }
  const scorecard = validateScorecard(JSON.parse(raw), path.join(dir, 'scorecard.json'));
  const details = {};
  for (const runId of retainedRunIds(scorecard)) {
    try {
      details[runId] = JSON.parse(await fs.readFile(path.join(dir, 'runs', `${encodeURIComponent(runId)}.json`), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return { scorecard, details };
}

// Pure: previous site state + new results → files to deploy.
export function assembleSite({ previous, resultsList, generatedAt = new Date().toISOString() }) {
  const { publishable, skipped } = partitionPublishable(resultsList);
  let scorecard = previous.scorecard;
  const details = { ...previous.details };
  for (const results of publishable) {
    scorecard = addRun(scorecard, results.meta.suite, toScorecardRun(results));
    details[results.meta.run_id] = results;
  }
  const retained = new Set(retainedRunIds(scorecard));
  for (const id of Object.keys(details)) if (!retained.has(id)) delete details[id];
  const thresholds = Object.fromEntries(Object.entries(SUITES).map(([name, s]) => [name, s.thresholds ?? {}]));
  return { files: buildSite({ scorecard, details, thresholds, generatedAt }), scorecard, skipped };
}

export async function writeSite(files, outDir) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(outDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

export async function buildEvalSite({ outDir, siteUrl, previousDir, resultFiles, fetchImpl, log = console.log }) {
  const previous = siteUrl
    ? await fetchPreviousSite(siteUrl, fetchImpl)
    : previousDir ? await readPreviousSiteDir(previousDir) : { scorecard: emptyScorecard(), details: {} };
  const resultsList = await Promise.all(resultFiles.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))));
  const { files, scorecard, skipped } = assembleSite({ previous, resultsList });
  for (const s of skipped) {
    const msg = `run ${s.run_id} not recorded (${s.reason}): provider failure, not a model result`;
    log(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${msg}` : `Warning: ${msg}`);
  }
  await writeSite(files, outDir);
  for (const [suite, { runs }] of Object.entries(scorecard.suites)) {
    log(`${suite}: ${runs.length} run(s) on the dashboard, latest ${runs[0]?.run_id} (${runs[0]?.passed ? 'pass' : 'fail'})`);
  }
  log(`Eval dashboard written to ${outDir} (${Object.keys(files).length} files)`);
  return { files, scorecard, skipped };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { out: { type: 'string' }, 'site-url': { type: 'string' }, 'previous-dir': { type: 'string' } },
  });
  if (!values.out) throw new Error('--out <dir> is required');
  await buildEvalSite({ outDir: values.out, siteUrl: values['site-url'], previousDir: values['previous-dir'], resultFiles: positionals });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
