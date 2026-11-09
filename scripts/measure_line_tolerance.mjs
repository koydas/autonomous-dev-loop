#!/usr/bin/env node

/**
 * Measure the RV-05 location tolerance (issue #333, ADR-0063) on a published `review` eval run. Offline, no LLM call,
 * nothing from a PR is executed: every recorded `calls[].raw` goes back through `substantiateFindings` with the
 * diff of its case, and each `unverified` blocking finding is bucketed by its distance to the nearest hunk.
 *
 *   node scripts/measure_line_tolerance.mjs --results <review-run.json> --dataset <review.jsonl>
 *
 * Not part of the pipeline: no workflow runs it. The run, the model, the repeat count and the dataset hash are pinned
 * below; a different input fails instead of being measured. The dataset is the one recorded in the run
 * (`git show 6147bf6:evals/datasets/review.jsonl`), not the one of the checked-out tree.
 */

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDataset } from './lib/eval_harness.mjs';
import { parseReviewVerdict } from './lib/review_prompt.mjs';
import { substantiateFindings, diffHunkRanges, impactLookup, FINDING_STATUSES } from './lib/finding_evidence.mjs';
import { pathMatches, DEFAULT_LINE_TOLERANCE } from './lib/review_findings.mjs';

export const PINNED_RUN = Object.freeze({
  workflow_run_id: '40161093183',
  model: 'anthropic:claude-sonnet-5-5',
  repeats: 3,
  dataset_sha256: '9add3de8ef544693a1fc73d51b01278869b8f2bcd1fb534b5938b678d178ce25',
});

/** Gaps are cumulative buckets: a finding 7 lines away counts in `within10` and `within20`. */
export const GAP_BUCKETS = Object.freeze([10, 20]);

/**
 * Where an unverified blocking finding stands against the diff, in this order:
 * `no_file` (cites no file), `off_diff` (no cited file is in the diff), `no_hunk` (a cited diff file has no hunk),
 * `no_line` (a cited diff file, no line given), `gap` (a cited diff file with lines: `gap` is the minimum absolute
 * distance to the closest hunk, 0 when the lines overlap one, over every cited diff file).
 * `gap` is the quantity `isLocated` compares to the tolerance: located iff gap <= tolerance.
 */
export function classifyUnverified(finding, ranges) {
  if (finding.files.length === 0) return { kind: 'no_file' };
  const cited = [...ranges.entries()].filter(([file]) => finding.files.some((f) => pathMatches(f, file)));
  if (cited.length === 0) return { kind: 'off_diff' };
  if (cited.some(([, list]) => list.length === 0)) return { kind: 'no_hunk' };
  if (!finding.lines) return { kind: 'no_line' };
  const [from, to] = finding.lines;
  const gap = Math.min(...cited.flatMap(([, list]) => list.map(([a, b]) => Math.max(0, a - to, from - b))));
  return { kind: 'gap', gap };
}

const emptyTable = () => ({
  total: 0,
  statuses: Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])),
  unverified: { no_file: 0, off_diff: 0, no_hunk: 0, no_line: 0, gap: 0, within10: 0, within20: 0, beyond20: 0, gaps: [] },
  // Where the supported findings sit, for the margin: `gaps` is the histogram of gap -> count (supported with lines in a hunk).
  supported: { no_file: 0, off_diff: 0, no_hunk: 0, no_line: 0, gap: 0, gaps: {} },
});

/**
 * Counts every blocking finding once per (case, repeat). `replays` is `[{ id, repeat, review, diff, impact?, doc_mentions? }]`.
 * `gaps` lists every in-diff unverified distance as `{ id, repeat, gap }` so the 6–10 window can be audited.
 */
export function measureReplays(replays, tolerance = DEFAULT_LINE_TOLERANCE) {
  const table = emptyTable();
  for (const r of replays) {
    const lookup = impactLookup({ symbols: [...(r.impact?.symbols ?? []), ...(r.doc_mentions?.terms ?? [])] });
    const result = substantiateFindings({ review: r.review, rawDiff: r.diff, lookup });
    const ranges = diffHunkRanges(r.diff);
    for (const f of result.findings.filter((x) => x.blocking)) {
      table.total += 1;
      table.statuses[f.status] += 1;
      if (f.status === 'supported') {
        const s = classifyUnverified(f, ranges);
        table.supported[s.kind] += 1;
        if (s.kind === 'gap') table.supported.gaps[s.gap] = (table.supported.gaps[s.gap] ?? 0) + 1;
        continue;
      }
      if (f.status !== 'unverified') continue;
      const c = classifyUnverified(f, ranges);
      const u = table.unverified;
      if (c.kind !== 'gap') {
        u[c.kind] += 1;
        continue;
      }
      u.gap += 1;
      u.gaps.push({ id: r.id, repeat: r.repeat, gap: c.gap });
      if (c.gap <= GAP_BUCKETS[0]) u.within10 += 1;
      if (c.gap <= GAP_BUCKETS[1]) u.within20 += 1;
      else u.beyond20 += 1;
    }
  }
  const window = table.unverified.gaps.filter((g) => g.gap > tolerance && g.gap <= 10);
  return { ...table, tolerance, window, locationTolerance: window.length === 0 ? tolerance : Math.max(...window.map((g) => g.gap)) };
}

/** Checks the pinned run and returns the replay inputs; throws on any mismatch, missing answer or missing diff. */
export function buildReplays({ run, datasetText }) {
  const meta = run?.meta ?? {};
  if (meta.repeats !== PINNED_RUN.repeats) throw new Error(`meta.repeats is ${meta.repeats}, expected ${PINNED_RUN.repeats}`);
  if (meta.model !== PINNED_RUN.model) throw new Error(`meta.model is ${meta.model}, expected ${PINNED_RUN.model}`);
  if (meta.workflow_run_id !== PINNED_RUN.workflow_run_id) throw new Error(`meta.workflow_run_id is ${meta.workflow_run_id}, expected ${PINNED_RUN.workflow_run_id}`);
  if (meta.dataset_sha256 !== PINNED_RUN.dataset_sha256) throw new Error(`meta.dataset_sha256 is ${meta.dataset_sha256}, expected ${PINNED_RUN.dataset_sha256}`);
  const actual = createHash('sha256').update(datasetText).digest('hex');
  if (actual !== PINNED_RUN.dataset_sha256) throw new Error(`dataset sha256 is ${actual}, expected ${PINNED_RUN.dataset_sha256}`);
  const cases = new Map(parseDataset(datasetText, 'dataset').map((c) => [c.id, c]));
  const results = run.results;
  if (!Array.isArray(results) || results.length === 0) throw new Error('run.results is missing or empty');
  const seen = new Set();
  const replays = results.map((res) => {
    const where = `${res?.case_id}#${res?.repeat}`;
    const testCase = cases.get(res?.case_id);
    if (!testCase) throw new Error(`${where}: case not in the dataset`);
    if (typeof testCase.input?.diff !== 'string' || !testCase.input.diff) throw new Error(`${where}: no input.diff in the dataset`);
    if (res.error) throw new Error(`${where}: recorded run errored (${res.error})`);
    if (!Number.isInteger(res.repeat) || res.repeat < 0 || res.repeat >= PINNED_RUN.repeats) throw new Error(`${where}: repeat out of range`);
    if (seen.has(where)) throw new Error(`${where}: duplicate result`);
    seen.add(where);
    const raw = res.calls?.length === 1 ? res.calls[0]?.raw : null;
    if (typeof raw !== 'string' || !raw) throw new Error(`${where}: no recorded answer (calls[0].raw)`);
    const { cleanReview, verdict } = parseReviewVerdict(raw);
    if (!verdict) throw new Error(`${where}: recorded answer has no verdict line`);
    return { id: res.case_id, repeat: res.repeat, review: cleanReview, diff: testCase.input.diff, impact: testCase.input.impact, doc_mentions: testCase.input.doc_mentions };
  });
  for (const id of cases.keys()) {
    for (let repeat = 0; repeat < PINNED_RUN.repeats; repeat++) if (!seen.has(`${id}#${repeat}`)) throw new Error(`${id}#${repeat}: no recorded result`);
  }
  return replays;
}

/** Markdown table of a measurement, the one published in docs/evals.md. */
export function formatTable(m) {
  const u = m.unverified;
  return [
    '| Blocking findings (per case and repeat) | Count |',
    '|---|---|',
    `| all | ${m.total} |`,
    ...FINDING_STATUSES.map((s) => `| ${s} | ${m.statuses[s]} |`),
    `| unverified, in-diff file with lines: gap ≤ 10 (cumulative) | ${u.within10} |`,
    `| unverified, in-diff file with lines: gap ≤ 20 (cumulative) | ${u.within20} |`,
    `| unverified, in-diff file with lines: gap > 20 | ${u.beyond20} |`,
    `| unverified, file outside the diff | ${u.off_diff} |`,
    `| unverified, no file cited | ${u.no_file} |`,
    `| unverified, line missing (in-diff file) | ${u.no_line} |`,
    `| unverified, diff file with no hunk | ${u.no_hunk} |`,
    `| unverified, gap 6–10 (decides the tolerance) | ${m.window.length} |`,
    `| supported, diff file with no hunk (located by default) | ${m.supported.no_hunk} |`,
    `| supported, line missing (located by default) | ${m.supported.no_line} |`,
    `| supported, lines near a hunk (gap → count) | ${Object.entries(m.supported.gaps).map(([g, n]) => `${g}→${n}`).join(', ') || 'none'} |`,
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { results: { type: 'string' }, dataset: { type: 'string' }, json: { type: 'boolean' } } });
  if (!values.results || !values.dataset) throw new Error('usage: measure_line_tolerance.mjs --results <review-run.json> --dataset <review.jsonl> [--json]');
  const run = JSON.parse(await fs.readFile(values.results, 'utf8'));
  const datasetText = await fs.readFile(values.dataset, 'utf8');
  const m = measureReplays(buildReplays({ run, datasetText }));
  console.log(values.json ? JSON.stringify(m, null, 2) : `${formatTable(m)}\n\ngaps: ${JSON.stringify(m.unverified.gaps)}\nlocation tolerance: ${m.locationTolerance} (default ${m.tolerance})`);
  return m;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
