// Fixtures of the pipeline views: run records built through the production redaction path
// (redactTrace), so they have the shape the metrics branch stores. HOSTILE goes into every field a page
// renders; the allowlist keeps it (it limits keys, not content), so only escaping protects the page.
import { readFileSync } from 'node:fs';
import { redactTrace, appendTraceIndex, recordPath } from '../../../lib/run_record.mjs';

export const HOSTILE = '<script>alert(1)</script>"\'&<img src=x onerror=alert(2)>';
// What a page may contain of HOSTILE: its escaped form only.
export const RAW_MARKERS = ['<script>alert(1)', '<img src=x', '"\'&<'];

const fixture = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
export const V1_REVIEW = () => fixture('v1-review-skipped.json');
export const V2_REVIEW = () => fixture('v2-review-withheld.json');
export const TRACE_PR_220 = () => fixture('trace-pr-220.json');

const iso = (t) => new Date(t).toISOString();
const sid = (n) => n.toString(16).padStart(16, '0');

/**
 * A v2 record of one run: a stage span, an llm_call child span and the given events (all within the
 * stage). `hostile` puts HOSTILE in every free-text field the redaction keeps. `usage` ({ cacheRead,
 * cacheWrite }) makes the call's tokens provider-measured instead of estimated.
 */
export function makeRecord({
  runId = '100', attempt = 1, workflow = 'PR Review', stage = 'review', start = Date.parse('2026-10-16T10:00:00Z'),
  durationMs = 4000, prNumber = 7, issueNumber = null, item = null, outcome = 'success', events = [], provider = 'groq',
  model = 'openai/gpt-oss-120b', tokensIn = 1000, tokensOut = 100, hostile = false, llmStatus = 'ok', repository = 'koydas/autonomous-dev-loop',
  usage = null,
} = {}) {
  const h = (v) => (hostile ? HOSTILE : v);
  const root = sid(Number(runId) * 10 + 1);
  const stageId = sid(Number(runId) * 10 + 2);
  const llmId = sid(Number(runId) * 10 + 3);
  const trace = {
    schema_version: 2,
    run_id: runId,
    started_at: iso(start),
    completed_at: iso(start + durationMs),
    outcome: h(outcome),
    root_span_id: root,
    item: item ?? (issueNumber ? { kind: 'issue', number: issueNumber, source: 'branch' } : { kind: 'pr', number: prNumber, source: 'pr' }),
    envelope: {
      workflow: h(workflow), run_id: runId, run_attempt: attempt, event_name: h('pull_request'), actor: h('koydas'), actor_type: 'human',
      repository: hostile ? HOSTILE : repository, issue_number: issueNumber, pr_number: prNumber, head_sha: 'a'.repeat(40),
      run_url: `https://github.com/koydas/autonomous-dev-loop/actions/runs/${runId}/attempts/${attempt}`,
      pr_url: prNumber ? `https://github.com/koydas/autonomous-dev-loop/pull/${prNumber}` : null,
      issue_url: issueNumber ? `https://github.com/koydas/autonomous-dev-loop/issues/${issueNumber}` : null,
      links: [], llm_calls: [{ stage: h(stage), provider: h(provider), model: h(model), fallback: false, outcome: 'answered', duration_ms: 500 }],
    },
    spans: [{ stage: h(stage), span_id: stageId, parent_span_id: root, started_at: iso(start + 10), completed_at: iso(start + durationMs), duration_ms: durationMs - 10, outcome: h('success'), meta: { prNumber, model: h(model), reason: h('ok') } }],
    child_spans: [{
      span_id: llmId, parent_span_id: stageId, name: 'llm_call', started_at: iso(start + 100), completed_at: iso(start + 600), duration_ms: 500, status: llmStatus,
      attributes: {
        'gen_ai.operation.name': 'chat', 'gen_ai.system': h(provider), 'gen_ai.request.model': h(model), 'gen_ai.response.model': h(model),
        'gen_ai.usage.input_tokens': tokensIn, 'gen_ai.usage.output_tokens': tokensOut, 'adl.usage.estimated': !usage, 'adl.stage': h(stage),
        ...(usage && { 'gen_ai.usage.cache_read.input_tokens': usage.cacheRead ?? 0, 'gen_ai.usage.cache_creation.input_tokens': usage.cacheWrite ?? 0 }),
      },
    }],
    events: events.map((e, i) => ({
      ts: iso(start + 200 + i * 10), stage: h(e.stage ?? stage), event: e.event, level: e.level ?? 'info', duration_ms: e.duration_ms ?? null,
      span_id: e.span_id === 'llm' ? llmId : stageId, meta: e.meta ?? {},
    })),
    events_overflow: { count: 0, bytes: 0 },
  };
  return redactTrace(trace, { env: { GITHUB_SERVER_URL: 'https://github.com' } });
}

/** `[{ path, text }]` of records, as readPipelineDir() returns them. */
export const asFiles = (records) => records.map((r) => ({ path: recordPath(r), text: JSON.stringify(r) }));

/** The trace indexes of records, built with the production appendTraceIndex(). */
export function indexesOf(records) {
  const byTrace = new Map();
  for (const r of records) {
    if (!r.trace_id) continue;
    byTrace.set(r.trace_id, appendTraceIndex(byTrace.get(r.trace_id) ?? null, r, recordPath(r)).index);
  }
  return [...byTrace.entries()].map(([id, index]) => ({ path: `metrics/traces/${id}.json`, text: JSON.stringify(index) }));
}
