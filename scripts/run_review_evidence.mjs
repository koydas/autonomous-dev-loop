#!/usr/bin/env node
/**
 * Runs the checks declared in config/review-evidence.yaml against the checked-out commit and
 * writes the results for the PR review stage (ADR-0020).
 * Called by the secret-free `evidence` job in .github/workflows/pr-review.yml.
 *
 * Exits 0 whether checks pass or fail — results are data for the review, not a gate here.
 * Exits 1 only when the evidence itself cannot be produced (invalid config, unknown HEAD).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEvidenceConfig, runCheck, buildEvidence, EVIDENCE_CONFIG_PATH } from './lib/review_evidence.mjs';
import { log, error as logError } from './lib/logger.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';

const startMs = Date.now();
const configPath = process.env.REVIEW_EVIDENCE_CONFIG ?? EVIDENCE_CONFIG_PATH;
const outputPath = process.env.REVIEW_EVIDENCE_PATH ?? path.join('evidence', 'review-evidence.json');
// Suffixed so the trace does not collide with the review job's trace of the same workflow run.
const runId = `${process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`}-evidence`;
const tracer = createTracer({ runId, issueNumber: null, traceDir: path.join(process.cwd(), 'observability', 'traces') });

obsLog({ stage: 'review_evidence', event: 'review_evidence.start', level: 'info', meta: { configPath } });
tracer.startSpan('review_evidence', { configPath });

try {
  if (!fs.existsSync(configPath)) throw new Error(`Review evidence config not found: ${configPath}`);
  const checks = parseEvidenceConfig(fs.readFileSync(configPath, 'utf8'));
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const results = [];
  for (const check of checks) {
    const result = await runCheck(check);
    log('Review evidence check finished', { name: result.name, status: result.status, exit_code: result.exit_code, duration_ms: result.duration_ms });
    results.push(result);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(buildEvidence({ headSha, results }), null, 2)}\n`);
  log('Review evidence written', { outputPath, headSha });

  const summary = Object.fromEntries(results.map((r) => [r.name, r.status]));
  obsLog({ stage: 'review_evidence', event: 'review_evidence.complete', level: 'info', duration_ms: Date.now() - startMs, meta: { headSha, checks: summary } });
  tracer.endSpan('review_evidence', { outcome: 'success', meta: { checks: summary } });
  await tracer.finalize('success');
} catch (err) {
  logError('Review evidence failed', { error: err.message });
  obsLog({ stage: 'review_evidence', event: 'review_evidence.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
  tracer.endSpan('review_evidence', { outcome: 'failed', meta: { error: err.message } });
  await tracer.finalize('failed');
  process.exit(1);
}
