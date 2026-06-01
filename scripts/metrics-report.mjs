#!/usr/bin/env node

import { readMetrics } from './lib/metrics.mjs';

const records = await readMetrics();

if (records.length === 0) {
  console.log('# Metrics Report\n\n_No data recorded yet._');
  process.exit(0);
}

const issueRecords = records.filter((r) => r.type === 'issue');
const prRecords = records.filter((r) => r.type === 'pr');

const approvedIssues = issueRecords.filter((r) => r.verdict === 'APPROVE');
const manualIssues = issueRecords.filter((r) => r.verdict === 'MANUAL');

const approvedPRs = prRecords.filter((r) => r.final_verdict === 'APPROVE');
const manualPRs = prRecords.filter((r) => r.final_verdict === 'MANUAL');

function pct(n, total) {
  return total === 0 ? 'N/A' : `${((n / total) * 100).toFixed(1)}%`;
}

function avg(arr, key) {
  if (!arr.length) return 'N/A';
  return (arr.reduce((s, r) => s + (r[key] ?? 0), 0) / arr.length).toFixed(1);
}

function fmtMs(ms) {
  if (ms == null) return 'N/A';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const avgIssueDuration = issueRecords.length
  ? fmtMs(issueRecords.reduce((s, r) => s + (r.duration_ms ?? 0), 0) / issueRecords.length)
  : 'N/A';

const avgPRDuration = prRecords.length
  ? (() => {
      const withDates = prRecords.filter((r) => r.started_at && r.ended_at);
      if (!withDates.length) return 'N/A';
      const ms = withDates.reduce((s, r) => s + (new Date(r.ended_at) - new Date(r.started_at)), 0);
      return fmtMs(ms / withDates.length);
    })()
  : 'N/A';

const totalInputTokens = records.reduce(
  (s, r) => s + (r.input_tokens_est ?? r.total_input_tokens_est ?? 0), 0);
const totalOutputTokens = records.reduce(
  (s, r) => s + (r.output_tokens_est ?? r.total_output_tokens_est ?? 0), 0);
// Claude Sonnet 4.6: $3/MTok input, $15/MTok output
const estimatedCost = (totalInputTokens * 3e-6 + totalOutputTokens * 15e-6).toFixed(4);

const avgCycles = avg(prRecords, 'review_cycles');
const avgAutoFix = avg(prRecords, 'auto_fix_pushes');

const verdictDist = {};
for (const r of issueRecords) verdictDist[r.verdict] = (verdictDist[r.verdict] ?? 0) + 1;
const prVerdictDist = {};
for (const r of prRecords) prVerdictDist[r.final_verdict] = (prVerdictDist[r.final_verdict] ?? 0) + 1;

const lines = [
  `# Metrics Report`,
  ``,
  `Generated: ${new Date().toISOString()}  |  Total records: ${records.length}`,
  ``,
  `## Issue Validation`,
  ``,
  `| Metric | Value |`,
  `|--------|-------|`,
  `| Issues processed | ${issueRecords.length} |`,
  `| Approved | ${approvedIssues.length} (${pct(approvedIssues.length, issueRecords.length)}) |`,
  `| Manual intervention | ${manualIssues.length} (${pct(manualIssues.length, issueRecords.length)}) |`,
  `| Avg validation time | ${avgIssueDuration} |`,
  ``,
  `## PR Reviews`,
  ``,
  `| Metric | Value |`,
  `|--------|-------|`,
  `| PRs completed | ${prRecords.length} |`,
  `| Auto-approved | ${approvedPRs.length} (${pct(approvedPRs.length, prRecords.length)}) |`,
  `| Manual intervention | ${manualPRs.length} (${pct(manualPRs.length, prRecords.length)}) |`,
  `| Avg review cycles | ${avgCycles} |`,
  `| Avg auto-fix pushes | ${avgAutoFix} |`,
  `| Avg time to resolution | ${avgPRDuration} |`,
  ``,
  `## Token Usage & Estimated Cost`,
  ``,
  `| Metric | Value |`,
  `|--------|-------|`,
  `| Total input tokens (est.) | ${totalInputTokens.toLocaleString()} |`,
  `| Total output tokens (est.) | ${totalOutputTokens.toLocaleString()} |`,
  `| Estimated cost | $${estimatedCost} USD |`,
  ``,
  `> Cost estimate based on Claude Sonnet 4.6 pricing ($3/MTok input, $15/MTok output). Token counts are character-length estimates.`,
  ``,
  `## Verdict Distribution`,
  ``,
  `**Issues**`,
  ``,
  ...Object.entries(verdictDist).map(([v, n]) => `- ${v}: ${n} (${pct(n, issueRecords.length)})`),
  ``,
  `**PRs**`,
  ``,
  ...Object.entries(prVerdictDist).map(([v, n]) => `- ${v}: ${n} (${pct(n, prRecords.length)})`),
];

console.log(lines.join('\n'));
