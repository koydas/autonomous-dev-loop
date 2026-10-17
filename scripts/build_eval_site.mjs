#!/usr/bin/env node

/**
 * Build the eval dashboard (GitHub Pages) from live eval results.
 *
 *   node scripts/build_eval_site.mjs --out <dir> [--site-url <deployed site> [--allow-empty]] [--previous-dir <dir>] [--pipeline-dir <metrics checkout>] [--fail-on-model-change] [results.json ...]
 *   node scripts/build_eval_site.mjs --report [--site-url <deployed site>] results.json ...
 *
 * History is read back from the deployed site (--site-url: scorecard.json + runs/<id>.json) or
 * from a local build or a backup artifact (--previous-dir). A 404 on the deployed scorecard aborts
 * unless --allow-empty is passed (first deploy only), and so does any other read error: a
 * transient failure or a wrong URL never deploys a site without its history.
 * Runs that failed on error_rate (provider outage) and replays are left out, and so is a run whose model
 * is not the suite's published model (history per suite and model, ADR-0032 amendment).
 * --pipeline-dir: a checkout of the `metrics` branch (its metrics/ directory); the pipeline views
 * (pipeline/: activity feed, work-item traces, runs, health, models) are rebuilt from it on every build,
 * never read back from the site. Pages hosts one site: the eval publish and the pipeline publish both run
 * this one build, so each deploy carries both halves (ADR-0027 amendment, 2026-10-17).
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
import { buildPipelineModel, MONTH_RE } from './lib/pipeline_model.mjs';
import { computeHealth, modelUsage } from './lib/pipeline_health.mjs';
import { buildPipelineSite } from './lib/pipeline_site.mjs';

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

// Regular files only: a symlink on the branch is never followed (ADR-0021).
async function readRegular(file, log) {
  const st = await fs.lstat(file);
  if (!st.isFile()) {
    log(`Warning: ${file} is not a regular file; skipped`);
    return null;
  }
  return fs.readFile(file, 'utf8');
}

async function listJson(dir) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The pipeline inputs of a `metrics` branch checkout: `{ records, traces, runsJsonl }` with paths
 * relative to the checkout (metrics/runs/<YYYY-MM>/<run>.json, metrics/traces/<id>.json). A checkout
 * without metrics/ aborts: the build would deploy a site without its pipeline half.
 */
export async function readPipelineDir(dir, { log = console.log } = {}) {
  const root = path.join(dir, 'metrics');
  let st;
  try {
    st = await fs.lstat(root);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No metrics/ directory in ${dir}: check out the metrics branch there (--pipeline-dir)`);
    throw err;
  }
  if (!st.isDirectory()) throw new Error(`${root} is not a directory`);
  const records = [];
  let months = [];
  try {
    months = (await fs.readdir(path.join(root, 'runs'))).filter((m) => MONTH_RE.test(m)).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const month of months) {
    for (const f of await listJson(path.join(root, 'runs', month))) {
      const text = await readRegular(path.join(root, 'runs', month, f), log);
      if (text != null) records.push({ path: `metrics/runs/${month}/${f}`, text });
    }
  }
  const traces = [];
  for (const f of await listJson(path.join(root, 'traces'))) {
    const text = await readRegular(path.join(root, 'traces', f), log);
    if (text != null) traces.push({ path: `metrics/traces/${f}`, text });
  }
  let runsJsonl = '';
  try {
    runsJsonl = (await readRegular(path.join(root, 'runs.jsonl'), log)) ?? '';
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { records, traces, runsJsonl };
}

// Pure: pipeline inputs + the scorecard being deployed → the pipeline/ pages.
export function assemblePipeline({ pipeline, scorecard, generatedAt = null, log = () => {} }) {
  const model = buildPipelineModel({ ...pipeline, log });
  const files = buildPipelineSite({ model, health: computeHealth({ model, scorecard }), models: modelUsage(model.runs, scorecard), generatedAt });
  return { files, model };
}

const siteBytes = (files) => Object.values(files).reduce((n, c) => n + Buffer.byteLength(c, 'utf8'), 0);

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
// pipeline: readPipelineDir() output, or null for an eval-only site (local preview, tests).
export function assembleSite({ previous, resultsList, pipeline = null, generatedAt = new Date().toISOString(), log = () => {} }) {
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
  const files = buildSite({ scorecard, details, thresholds, generatedAt, pipeline: pipeline != null });
  const pipelineFiles = pipeline ? assemblePipeline({ pipeline, scorecard, generatedAt, log }).files : {};
  return { files: { ...files, ...pipelineFiles }, scorecard, skipped, pipelineFiles };
}

export async function writeSite(files, outDir) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(outDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

// failOnModelChange: the run used the repo's configured provider (schedule, provider repo-variable), so a
// model mismatch is drift (GROQ_MODEL bump, model retirement), not a measurement: fail instead of freezing
// the history behind a notice. Re-baselining is #209.
export async function buildEvalSite({ outDir, siteUrl, previousDir, pipelineDir, resultFiles, fetchImpl, allowEmpty = false, failOnModelChange = false, log = console.log, generatedAt }) {
  const previous = siteUrl
    ? await fetchPreviousSite(siteUrl, fetchImpl, { allowEmpty, log })
    : previousDir ? await readPreviousSiteDir(previousDir) : { scorecard: emptyScorecard(), details: {} };
  const resultsList = await Promise.all(resultFiles.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))));
  const pipeline = pipelineDir ? await readPipelineDir(pipelineDir, { log }) : null;
  const { files, scorecard, skipped, pipelineFiles } = assembleSite({ previous, resultsList, pipeline, log, ...(generatedAt && { generatedAt }) });
  const actions = process.env.GITHUB_ACTIONS === 'true';
  for (const s of skipped) {
    if (s.kind === 'model_mismatch') {
      const msg = `run ${s.run_id} not recorded: ${s.reason}`;
      if (failOnModelChange) log(actions ? `::error::${msg}` : `Error: ${msg}`);
      else log(actions ? `::notice::${msg}` : `Notice: ${msg}`);
      continue;
    }
    const msg = `run ${s.run_id} not recorded (${s.reason}): provider failure, not a model result`;
    log(actions ? `::warning::${msg}` : `Warning: ${msg}`);
  }
  const drift = failOnModelChange ? skipped.filter((s) => s.kind === 'model_mismatch') : [];
  if (drift.length) {
    throw new Error(`model changed on the configured provider (${drift.map((s) => s.run_id).join(', ')}): the history is per suite and model, so nothing is published. Re-baseline the suite (#209) or restore the previous model`);
  }
  await writeSite(files, outDir);
  for (const [suite, { runs }] of Object.entries(scorecard.suites)) {
    log(`${suite}: ${runs.length} run(s) on the dashboard, latest ${runs[0]?.run_id} (${runs[0]?.passed ? 'pass' : 'fail'})`);
  }
  if (pipeline) log(`Pipeline views: ${pipeline.records.length} record(s), ${pipeline.traces.length} trace index(es), ${Object.keys(pipelineFiles).length} page(s), ${(siteBytes(pipelineFiles) / 1e6).toFixed(2)} MB`);
  else log('No --pipeline-dir: eval pages only (the pipeline views are not built)');
  log(`Eval dashboard written to ${outDir} (${Object.keys(files).length} files, ${(siteBytes(files) / 1e6).toFixed(2)} MB)`);
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
    const run = toScorecardRun(results); // throws on a malformed file before any request
    const suite = results.meta.suite;
    const baseline = siteUrl ? await fetchPublishedBaseline(siteUrl, suite, fetchImpl) : undefined;
    entries.push({ suite, run, baseline });
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
      'pipeline-dir': { type: 'string' },
      'allow-empty': { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
      'fail-on-model-change': { type: 'boolean', default: false },
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
    pipelineDir: values['pipeline-dir'],
    allowEmpty: values['allow-empty'],
    failOnModelChange: values['fail-on-model-change'],
    resultFiles: positionals,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
