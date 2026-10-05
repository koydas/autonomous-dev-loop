/**
 * Eval replay gate for pull requests (ADR-0027 amendment, workflow eval-replay.yml).
 *
 * For each registered suite, the last live run published on the eval dashboard (scorecard.json,
 * then runs/<id>.json) is replayed against the checked-out code: the recorded LLM responses are
 * served again (createReplayLLM), so parsing, decideVerdict and the scorers run, but the model
 * does not. A prompt change is therefore NOT measured: the responses stay those of the recorded
 * prompt.
 *
 * Gate, per suite:
 *   - blocking  — a threshold that the published run met and the replay misses;
 *   - preexisting — a threshold the published run already missed (warning);
 *   - advisory  — every replay failure when the dataset changed since the run, or when the run
 *                 recorded no dataset hash (warning). Only the cases common to both are replayed.
 * A site that cannot be read, or a suite without a published run, is neutral (warning, exit 0).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDataset, runSuite, summarize, checkThresholds, createReplayLLM } from './eval_harness.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_CHANGED_ROWS = 50;

export const REPLAY_DISCLAIMER = [
  '> **What this measures.** The last live run published on the eval dashboard is replayed against this PR\'s code:',
  '> its recorded LLM responses are served again, so parsing, `decideVerdict` and the scorers run, the model does not.',
  '> **A prompt change is not measured** — the recorded responses stay those of the old prompt. Run the Evals workflow',
  '> (live) to measure a prompt or model change.',
].join('\n');

// ---------------------------------------------------------------------------
// Published runs
// ---------------------------------------------------------------------------

// get(rel) → { status, ok, json() }. Pages sits behind a CDN (max-age=600): bypass both caches.
export function siteGetter(siteUrl, fetchImpl = fetch, { cacheBust = Date.now(), timeoutMs = 20_000 } = {}) {
  const base = siteUrl.replace(/\/+$/, '');
  return (rel) => fetchImpl(`${base}/${rel}?v=${cacheBust}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
}

// Same contract over a local copy of the site (an unzipped eval-site-<runId> artifact, a test fixture).
export function dirGetter(dir) {
  return async (rel) => {
    try {
      const text = await fs.readFile(path.join(dir, decodeURIComponent(rel)), 'utf8');
      return { status: 200, ok: true, json: async () => JSON.parse(text) };
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 404, ok: false, json: async () => null };
      throw err;
    }
  };
}

// → { available: false, reason } | { available: true, suites: { [name]: { recorded } | { missing } }, warnings }
export async function loadPublishedRuns(get, suiteNames) {
  let scorecard;
  try {
    const res = await get('scorecard.json');
    if (!res.ok) return { available: false, reason: `scorecard.json: HTTP ${res.status}` };
    scorecard = await res.json();
  } catch (err) {
    return { available: false, reason: `scorecard.json: ${err.message}` };
  }
  if (scorecard?.version !== 1 || typeof scorecard.suites !== 'object' || scorecard.suites === null) {
    return { available: false, reason: 'scorecard.json: unsupported format' };
  }

  const suites = {};
  const warnings = [];
  for (const name of suiteNames) {
    const runs = scorecard.suites[name]?.runs ?? [];
    if (runs.length === 0) {
      suites[name] = { missing: 'no live run published for this suite' };
      continue;
    }
    // Newest first; a run without a detail page (pruned, failed upload) is skipped for the next one.
    for (const run of runs) {
      let res;
      let recorded;
      try {
        res = await get(`runs/${encodeURIComponent(run.run_id)}.json`);
        if (res.ok) recorded = await res.json();
      } catch (err) {
        suites[name] = { missing: `runs/${run.run_id}.json: ${err.message}` };
        break;
      }
      if (res.status === 404) {
        warnings.push(`${name}: run ${run.run_id} has no detail page on the site; trying the previous one`);
        continue;
      }
      if (!res.ok) {
        suites[name] = { missing: `runs/${run.run_id}.json: HTTP ${res.status}` };
        break;
      }
      if (!Array.isArray(recorded?.results) || recorded.meta?.suite !== name) {
        suites[name] = { missing: `runs/${run.run_id}.json: not a ${name} results file` };
        break;
      }
      suites[name] = { recorded };
      break;
    }
    suites[name] ??= { missing: 'no published run has a detail page' };
  }
  return { available: true, suites, warnings };
}

// ---------------------------------------------------------------------------
// Dataset drift
// ---------------------------------------------------------------------------

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// status: 'same' (hash match), 'changed' (hash differs), 'unknown' (the run recorded no hash).
export function diffDataset({ recorded, cases, currentSha, expectedLabel }) {
  const recordedSha = recorded.meta?.dataset_sha256 ?? null;
  const status = recordedSha == null ? 'unknown' : recordedSha === currentSha ? 'same' : 'changed';
  const recordedIds = new Set(recorded.results.map((r) => r.case_id));
  const currentIds = new Set(cases.map((c) => c.id));
  const recordedLabel = new Map(recorded.results.map((r) => [r.case_id, r.expected_label ?? null]));
  const relabelled = [];
  if (expectedLabel) {
    for (const c of cases) {
      if (!recordedIds.has(c.id)) continue;
      const now = expectedLabel(c.expected);
      if (recordedLabel.get(c.id) !== now) relabelled.push({ case_id: c.id, before: recordedLabel.get(c.id), after: now });
    }
  }
  return {
    status,
    recordedSha,
    currentSha,
    added: cases.filter((c) => !recordedIds.has(c.id)).map((c) => c.id),
    removed: [...recordedIds].filter((id) => !currentIds.has(id)),
    common: new Set(cases.filter((c) => recordedIds.has(c.id)).map((c) => c.id)),
    relabelled,
  };
}

// ---------------------------------------------------------------------------
// Replay and comparison
// ---------------------------------------------------------------------------

export async function replayRecorded({ suite, cases, recorded, common }) {
  const recordedResults = recorded.results.filter((r) => common.has(r.case_id));
  return runSuite({
    suite,
    cases: cases.filter((c) => common.has(c.id)),
    llmFor: createReplayLLM(recordedResults),
    repeats: recorded.meta?.repeats ?? 1,
  });
}

const metricAt = (obj, metricPath) => metricPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Quality metrics only: latency and token estimates of a replay say nothing.
export function metricPaths(...summaries) {
  const paths = new Set(['error_rate']);
  for (const s of summaries) {
    for (const name of Object.keys(s?.scores ?? {})) paths.add(`scores.${name}.mean`);
    if (s?.consistency != null) paths.add('consistency');
    for (const cls of Object.keys(s?.per_class ?? {})) for (const m of ['precision', 'recall', 'f1']) paths.add(`per_class.${cls}.${m}`);
  }
  return [...paths];
}

export function metricDeltas(before, after) {
  return metricPaths(before, after).map((metric) => {
    const b = metricAt(before, metric) ?? null;
    const a = metricAt(after, metric) ?? null;
    return { metric, before: b, after: a, delta: a == null || b == null ? null : Number((a - b).toFixed(4)) };
  });
}

const outcome = (r) => (r.error ? 'error' : r.label ?? '—');

// Case × repeat whose outcome (label, or error) differs between the recorded run and the replay.
export function verdictChanges(recordedResults, replayResults) {
  const before = new Map(recordedResults.map((r) => [`${r.case_id}#${r.repeat}`, r]));
  const changes = [];
  for (const r of replayResults) {
    const prev = before.get(`${r.case_id}#${r.repeat}`);
    if (!prev || outcome(prev) === outcome(r)) continue;
    changes.push({ case_id: r.case_id, repeat: r.repeat, expected: r.expected_label, before: outcome(prev), after: outcome(r), error: r.error });
  }
  return changes;
}

export function classifyGate({ replayFailures, baselineFailures, datasetStatus }) {
  if (datasetStatus !== 'same') return { blocking: [], preexisting: [], advisory: replayFailures };
  const known = new Set(baselineFailures.map((f) => f.metric));
  return {
    blocking: replayFailures.filter((f) => !known.has(f.metric)),
    preexisting: replayFailures.filter((f) => known.has(f.metric)),
    advisory: [],
  };
}

// One suite end to end. status: 'pass' | 'fail' | 'warn' | 'neutral'.
export async function evaluateSuite({ suite, published, repoRoot = REPO_ROOT }) {
  if (!published?.recorded) return { suite: suite.name, status: 'neutral', reason: published?.missing ?? 'no published run' };
  const { recorded } = published;
  const datasetPath = path.resolve(repoRoot, suite.dataset);
  const cases = await loadDataset(datasetPath);
  const dataset = diffDataset({ recorded, cases, currentSha: sha256(await fs.readFile(datasetPath)), expectedLabel: suite.expectedLabel });
  if (dataset.common.size === 0) {
    return { suite: suite.name, status: 'neutral', reason: 'no case in common with the published run', run: recorded.meta, dataset };
  }

  const results = await replayRecorded({ suite, cases, recorded, common: dataset.common });
  const summary = summarize(results);
  const recordedCommon = recorded.results.filter((r) => dataset.common.has(r.case_id));
  // Same dataset: compare with the numbers as published. Otherwise re-summarize the common subset.
  const baseline = dataset.status === 'same' ? recorded.summary : summarize(recordedCommon);
  const gate = classifyGate({
    replayFailures: checkThresholds(summary, suite.thresholds),
    baselineFailures: dataset.status === 'same' ? (recorded.failures ?? []) : [],
    datasetStatus: dataset.status,
  });
  const status = gate.blocking.length ? 'fail' : gate.preexisting.length || gate.advisory.length || dataset.status !== 'same' ? 'warn' : 'pass';
  return {
    suite: suite.name,
    status,
    run: recorded.meta,
    dataset,
    deltas: metricDeltas(baseline, summary),
    changes: verdictChanges(recordedCommon, results),
    gate,
    summary,
  };
}

export function overallStatus(reports) {
  if (reports.some((r) => r.status === 'fail')) return 'fail';
  if (reports.length === 0 || reports.every((r) => r.status === 'neutral')) return 'neutral';
  return reports.some((r) => r.status !== 'pass') ? 'warn' : 'pass';
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmt = (v) => (v == null ? '—' : String(v));
const signed = (d) => (d == null ? '—' : d === 0 ? '=' : d > 0 ? `▲ ${d}` : `▼ ${Math.abs(d)}`);
const ICON = { pass: '✅', fail: '❌', warn: '⚠️', neutral: '⚪' };
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);

function formatSuite(r, siteUrl) {
  const lines = [`## ${ICON[r.status]} \`${r.suite}\``, ''];
  if (r.status === 'neutral' && !r.dataset) {
    lines.push(`Not replayed: ${r.reason}.`, '');
    return lines;
  }
  const runLink = siteUrl ? `[${r.run.run_id}](${siteUrl.replace(/\/+$/, '')}/runs/${encodeURIComponent(r.run.run_id)}.html)` : `\`${r.run.run_id}\``;
  lines.push(`Published run ${runLink} · ${fmt(r.run.ts)} · \`${fmt(r.run.model)}\` · repeats ${fmt(r.run.repeats)}`, '');

  const d = r.dataset;
  if (d.status !== 'same') {
    lines.push(d.status === 'changed'
      ? `⚠️ **Dataset changed since the run** (\`${d.recordedSha.slice(0, 12)}\` → \`${d.currentSha.slice(0, 12)}\`): ${d.common.size} common case(s) replayed, thresholds are advisory.`
      : `⚠️ **The run recorded no dataset hash**: ${d.common.size} common case(s) replayed, thresholds are advisory.`, '');
    if (d.added.length) lines.push(`- Added (not replayed): ${d.added.map((id) => `\`${id}\``).join(', ')}`);
    if (d.removed.length) lines.push(`- Removed (recorded, no longer in the dataset): ${d.removed.map((id) => `\`${id}\``).join(', ')}`);
    if (d.relabelled.length) lines.push(`- Relabelled: ${d.relabelled.map((c) => `\`${c.case_id}\` ${c.before} → ${c.after}`).join(', ')}`);
    if (d.added.length || d.removed.length || d.relabelled.length) lines.push('');
  }
  if (r.status === 'neutral') {
    lines.push(`Not replayed: ${r.reason}.`, '');
    return lines;
  }

  lines.push('| Metric | Published | Replay | Δ |', '|---|---|---|---|');
  for (const m of r.deltas) lines.push(`| \`${m.metric}\` | ${fmt(m.before)} | ${fmt(m.after)} | ${signed(m.delta)} |`);
  lines.push('');

  const { blocking, preexisting, advisory } = r.gate;
  if (blocking.length) lines.push('**❌ Thresholds broken by this PR**', '', ...blocking.map((f) => `- \`${f.metric}\`: ${f.reason}`), '');
  if (preexisting.length) lines.push('**⚠️ Already failing in the published run**', '', ...preexisting.map((f) => `- \`${f.metric}\`: ${f.reason}`), '');
  if (advisory.length) lines.push('**⚠️ Threshold failures (advisory, dataset changed)**', '', ...advisory.map((f) => `- \`${f.metric}\`: ${f.reason}`), '');
  if (!blocking.length && !preexisting.length && !advisory.length) lines.push('All thresholds met.', '');

  if (r.changes.length === 0) {
    lines.push('No case changes verdict.', '');
  } else {
    lines.push(`**${r.changes.length} case run(s) change verdict**`, '', '| case | repeat | expected | published | replay | error |', '|---|---|---|---|---|---|');
    for (const c of r.changes.slice(0, MAX_CHANGED_ROWS)) {
      lines.push(`| \`${c.case_id}\` | ${c.repeat} | ${fmt(c.expected)} | ${c.before} | ${c.after} | ${cell(c.error)} |`);
    }
    if (r.changes.length > MAX_CHANGED_ROWS) lines.push('', `…and ${r.changes.length - MAX_CHANGED_ROWS} more.`);
    lines.push('');
  }
  return lines;
}

export function formatReplayReport({ reports, siteUrl, unavailable, warnings = [] }) {
  const status = unavailable ? 'neutral' : overallStatus(reports);
  const lines = [`# ${ICON[status]} Eval replay`, '', REPLAY_DISCLAIMER, ''];
  if (unavailable) {
    lines.push(`⚪ **Eval dashboard unreachable** (${unavailable}): nothing replayed, the check is neutral.`, '');
    return lines.join('\n');
  }
  for (const w of warnings) lines.push(`- ⚠️ ${w}`);
  if (warnings.length) lines.push('');
  for (const r of reports) lines.push(...formatSuite(r, siteUrl));
  return lines.join('\n');
}

// GitHub Actions annotations: neutral and advisory outcomes are warnings, broken thresholds errors.
export function annotations({ reports, unavailable, warnings = [] }) {
  if (unavailable) return [`::warning::Eval replay skipped: dashboard unreachable (${unavailable})`];
  const out = warnings.map((w) => `::warning::${w}`);
  for (const r of reports) {
    if (r.status === 'neutral') out.push(`::warning::Eval replay ${r.suite}: not replayed (${r.reason})`);
    if (r.dataset && r.dataset.status !== 'same' && r.status !== 'neutral') out.push(`::warning::Eval replay ${r.suite}: dataset ${r.dataset.status === 'changed' ? 'changed since' : 'hash not recorded by'} the published run; thresholds are advisory`);
    for (const f of r.gate?.preexisting ?? []) out.push(`::warning::Eval replay ${r.suite}: ${f.metric} already failing in the published run (${f.reason})`);
    for (const f of r.gate?.advisory ?? []) out.push(`::warning::Eval replay ${r.suite}: ${f.metric} ${f.reason} (advisory)`);
    for (const f of r.gate?.blocking ?? []) out.push(`::error::Eval replay ${r.suite}: ${f.metric} ${f.reason}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point used by scripts/replay_evals_ci.mjs
// ---------------------------------------------------------------------------

export async function runReplayCi({ get, suites, siteUrl, repoRoot = REPO_ROOT }) {
  const published = await loadPublishedRuns(get, suites.map((s) => s.name));
  if (!published.available) {
    const report = { reports: [], siteUrl, unavailable: published.reason };
    return { status: 'neutral', markdown: formatReplayReport(report), annotations: annotations(report), reports: [] };
  }
  const reports = [];
  for (const suite of suites) reports.push(await evaluateSuite({ suite, published: published.suites[suite.name], repoRoot }));
  const report = { reports, siteUrl, warnings: published.warnings };
  return { status: overallStatus(reports), markdown: formatReplayReport(report), annotations: annotations(report), reports };
}
