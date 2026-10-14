#!/usr/bin/env node

/**
 * Build the eval dashboard (GitHub Pages) from live eval results.
 *
 *   node scripts/build_eval_site.mjs --out <dir> [--site-url <deployed site> [--allow-empty]] [--previous-dir <dir>] [results.json ...]
 *   node scripts/build_eval_site.mjs --report [--site-url <deployed site>] results.json ...
 *
 * History is read back from the deployed site (--site-url: scorecard.json + runs/<id>.json) or
 * from a local build or a backup artifact (--previous-dir). A 404 on the deployed scorecard aborts
 * unless --allow-empty is passed (first deploy only), and so does any other read error: a
 * transient failure or a wrong URL never deploys a site without its history.
 * Runs that failed on error_rate (provider outage) and replays are left out, and so is a run whose model
 * is not the suite's published model (history per suite and model, ADR-0032 amendment).
 * --report builds nothing: it prints, per results file, model, scores, cost and review coverage next to
 * the suite's latest published run (best effort), and appends it to GITHUB_STEP_SUMMARY.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  emptyScorecard, toScorecardRun, addRun, partitionPublishable, partitionByPublishedModel, formatCost, formatCoverage,
} from './lib/eval_scorecard.mjs';
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

// Pages sits behind a CDN (max-age=600): bypass both the fetch cache and the edge cache.
export async function fetchPreviousSite(siteUrl, fetchImpl = fetch, { allowEmpty = false, log = () => {}, cacheBust = Date.now() } = {}) {
  const base = siteUrl.replace(/\/+$/, '');
  const get = (rel) => fetchImpl(`${base}/${rel}?v=${cacheBust}`, { cache: 'no-store' });
  const res = await get('scorecard.json');
  if (res.status === 404) {
    if (allowEmpty) return { scorecard: emptyScorecard(), details: {} };
    throw new Error(`No scorecard at ${base}/scorecard.json (HTTP 404). Pass --allow-empty (workflow input init_site) only for the first deploy; otherwise check the site URL, or restore a backup with --previous-dir (workflow input restore_run_id)`);
  }
  if (!res.ok) throw new Error(`Cannot read the previous scorecard (${base}/scorecard.json): HTTP ${res.status}`);
  const scorecard = validateScorecard(await res.json(), `${base}/scorecard.json`);
  const details = {};
  for (const runId of retainedRunIds(scorecard)) {
    const r = await get(`runs/${encodeURIComponent(runId)}.json`);
    if (r.status === 404) {
      log(`Warning: run ${runId} has no detail page on the previous site; its history row is kept without one`);
      continue;
    }
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

// runs/<id>.json is keyed by run_id alone: two suites under one id would overwrite each other's detail.
function assertRunIdsPerSuite(scorecard, publishable) {
  const owner = new Map(Object.entries(scorecard.suites).flatMap(([suite, s]) => (s.runs ?? []).map((r) => [r.run_id, suite])));
  for (const { meta } of publishable) {
    if (!meta?.run_id) continue; // toScorecardRun reports it
    const other = owner.get(meta.run_id);
    if (other && other !== meta.suite) {
      throw new Error(`run_id ${meta.run_id} is used by suites ${other} and ${meta.suite}: each suite's run needs its own run_id (EVAL_RUN_ID)`);
    }
    owner.set(meta.run_id, meta.suite);
  }
}

// Pure: previous site state + new results → files to deploy.
export function assembleSite({ previous, resultsList, generatedAt = new Date().toISOString() }) {
  const valid = partitionPublishable(resultsList);
  const { publishable, skipped: foreignModel } = partitionByPublishedModel(previous.scorecard, valid.publishable);
  const skipped = [...valid.skipped, ...foreignModel];
  assertRunIdsPerSuite(previous.scorecard, publishable);
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

export async function buildEvalSite({ outDir, siteUrl, previousDir, resultFiles, fetchImpl, allowEmpty = false, log = console.log }) {
  const previous = siteUrl
    ? await fetchPreviousSite(siteUrl, fetchImpl, { allowEmpty, log })
    : previousDir ? await readPreviousSiteDir(previousDir) : { scorecard: emptyScorecard(), details: {} };
  const resultsList = await Promise.all(resultFiles.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))));
  const { files, scorecard, skipped } = assembleSite({ previous, resultsList });
  const actions = process.env.GITHUB_ACTIONS === 'true';
  for (const s of skipped) {
    if (s.kind === 'model_mismatch') {
      const msg = `run ${s.run_id} not recorded: ${s.reason}`;
      log(actions ? `::notice::${msg}` : `Notice: ${msg}`);
      continue;
    }
    const msg = `run ${s.run_id} not recorded (${s.reason}): provider failure, not a model result`;
    log(actions ? `::warning::${msg}` : `Warning: ${msg}`);
  }
  await writeSite(files, outDir);
  for (const [suite, { runs }] of Object.entries(scorecard.suites)) {
    log(`${suite}: ${runs.length} run(s) on the dashboard, latest ${runs[0]?.run_id} (${runs[0]?.passed ? 'pass' : 'fail'})`);
  }
  log(`Eval dashboard written to ${outDir} (${Object.keys(files).length} files)`);
  return { files, scorecard, skipped };
}

// ---------------------------------------------------------------------------
// --report: one run against the suite's published baseline (issue #199)
// ---------------------------------------------------------------------------

// The suite's latest published run, as a scorecard row (coverage recomputed from its detail when the row
// predates the field). Best effort: the report is informational, an unreachable site only drops the row.
export async function fetchPublishedBaseline(siteUrl, suite, fetchImpl = fetch, { cacheBust = Date.now() } = {}) {
  const base = siteUrl.replace(/\/+$/, '');
  const get = (rel) => fetchImpl(`${base}/${rel}?v=${cacheBust}`, { cache: 'no-store' });
  try {
    const res = await get('scorecard.json');
    if (!res.ok) return { missing: `scorecard.json: HTTP ${res.status}` };
    const run = (await res.json())?.suites?.[suite]?.runs?.[0];
    if (!run) return { missing: `no published ${suite} run` };
    if (run.coverage !== undefined) return { run };
    const detail = await get(`runs/${encodeURIComponent(run.run_id)}.json`);
    return { run: detail.ok ? toScorecardRun(await detail.json()) : run };
  } catch (err) {
    return { missing: err.message };
  }
}

const row = (label, r) => `| ${label} | \`${r.model}\` | \`${r.run_id}\` | ${[...Object.entries(r.scores ?? {}).map(([k, v]) => `${k} ${v}`), ...Object.entries(r.per_class ?? {}).map(([cls, m]) => `${cls} recall ${m.recall}`)].join(' · ')} | ${r.error_rate ?? '—'} | ${formatCost(r.cost_est)} | ${formatCoverage(r.coverage)} |`;

// Pure: scorecard rows → Markdown. baseline: { run } | { missing } | undefined (no --site-url).
export function formatRunReport(entries) {
  const lines = [
    '## Eval run vs published baseline', '',
    'Cost is priced on the chars/4 token estimate (prompt cache and thinking tokens not counted), not measured usage. Coverage: share of review runs whose diff was cut / with code files cut / WITHHELD (ADR-0038).', '',
  ];
  for (const { run, suite, baseline } of entries) {
    lines.push(`### \`${suite}\``, '', '| | Model | Run | Scores | error_rate | Cost | Diff cut / code cut / withheld |', '|---|---|---|---|---|---|---|');
    lines.push(row('this run', run));
    if (baseline?.run) lines.push(row('published', baseline.run));
    lines.push('');
    if (baseline?.missing) lines.push(`> Published baseline unavailable: ${baseline.missing}`, '');
    if (baseline?.run && baseline.run.model !== run.model) lines.push(`> Different models: this run is not appended to the \`${suite}\` history (results artifact only).`, '');
  }
  return lines.join('\n');
}

export async function buildRunReport({ resultFiles, siteUrl, fetchImpl }) {
  const entries = [];
  for (const file of resultFiles) {
    const results = JSON.parse(await fs.readFile(file, 'utf8'));
    const suite = results.meta?.suite;
    const baseline = siteUrl ? await fetchPublishedBaseline(siteUrl, suite, fetchImpl) : undefined;
    entries.push({ suite, run: toScorecardRun(results), baseline });
  }
  return formatRunReport(entries);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'site-url': { type: 'string' },
      'previous-dir': { type: 'string' },
      'allow-empty': { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
    },
  });
  if (values.report) {
    const markdown = await buildRunReport({ resultFiles: positionals, siteUrl: values['site-url'] });
    console.log(markdown);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
    return;
  }
  if (!values.out) throw new Error('--out <dir> is required');
  await buildEvalSite({
    outDir: values.out,
    siteUrl: values['previous-dir'] ? undefined : values['site-url'],
    previousDir: values['previous-dir'],
    allowEmpty: values['allow-empty'],
    resultFiles: positionals,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
