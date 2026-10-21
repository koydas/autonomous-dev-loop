#!/usr/bin/env node
/**
 * item-closed.yml (issues: closed, pull_request: closed): journals the end of a work item as one
 * `item.closed` event, so the dashboard stops listing as waiting an item nobody has to act on any more
 * (ADR-0043 amendment 2026-10-21). The run joins the trace of the item like every other run (ADR-0041):
 * the work item comes from the event payload, nothing is passed in. No LLM, no secret, no GitHub call.
 * Env: ITEM_KIND (`issue` | `pull_request`), ITEM_STATE_REASON (issue), ITEM_MERGED (pull request),
 * GITHUB_RUN_ID. Published meta is `state_reason` and `merged` only (EVENT_META_ALLOWLIST).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log as obsLog, createTracer } from './lib/observability.mjs';

const STAGE = 'item';
// GitHub's closing reasons of an issue; anything else is published as unknown (null), never as given.
export const STATE_REASONS = Object.freeze(['completed', 'not_planned', 'duplicate']);

/**
 * The meta of `item.closed` from the workflow's env values. An issue gives its closing reason, a pull
 * request whether it was merged; the other key is absent. Throws on an unknown kind (fail fast).
 */
export function closedMeta({ kind, stateReason, merged } = {}) {
  if (kind === 'issue') return { state_reason: STATE_REASONS.includes(stateReason) ? stateReason : null };
  if (kind === 'pull_request') {
    if (merged !== 'true' && merged !== 'false') throw new Error('ITEM_MERGED must be "true" or "false" for a pull request');
    return { merged: merged === 'true' };
  }
  throw new Error('ITEM_KIND must be "issue" or "pull_request"');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const startMs = Date.now();
  const tracer = createTracer({ runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  try {
    obsLog({ stage: STAGE, event: 'item.start', level: 'info', meta: {} });
    const meta = closedMeta({ kind: process.env.ITEM_KIND, stateReason: process.env.ITEM_STATE_REASON, merged: process.env.ITEM_MERGED });
    obsLog({ stage: STAGE, event: 'item.closed', level: 'info', duration_ms: Date.now() - startMs, meta });
    await tracer.finalize('success');
  } catch (err) {
    obsLog({ stage: STAGE, event: 'item.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    await tracer.finalize('failed');
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
