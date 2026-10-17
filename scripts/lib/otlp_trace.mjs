// Span tree of a run and its OTLP-JSON encoding (ADR-0041). Pure: no I/O, no redaction — the
// public record applies the per-span-name attribute allowlist (run_record.mjs) between the two.
//
//   run (root)                         one per trace file, attributes: work item, workflow, outcome
//   ├── <stage>                        createTracer() spans (issue_validation, review, autofix, …)
//   │   ├── llm_call                   withSpan() child spans (GenAI attributes); retries, fallback
//   │   │                              and llm_call are its span events
//   │   └── review.comment_posted …    GitHub side effects journaled as events (ADR-0040 §1)
//   └── workflow.push …                workflow-step effects (commit_run_record.mjs)
import { SPAN_ID_RE, derivedSpanId } from './trace_context.mjs';

export const OTLP_SCOPE = Object.freeze({ name: 'autonomous-dev-loop', version: '1' });
export const SERVICE_NAME = 'autonomous-dev-loop';
// OTLP enums (opentelemetry-proto trace.proto).
export const SPAN_KIND = Object.freeze({ internal: 1, client: 3 });
export const STATUS_CODE = Object.freeze({ unset: 0, ok: 1, error: 2 });

// Events that are a side effect on GitHub: a zero-or-measured-duration child span of their enclosing
// span. Every other event is a span event of its enclosing span.
export const SIDE_EFFECT_EVENTS = Object.freeze(new Set([
  'issue_validation.comment_posted', 'issue_validation.labels_applied',
  'code_gen.escalated',
  'review.comment_posted', 'review.review_submitted', 'review.labels_applied',
  'autofix.reset', 'autofix.attempt_labeled', 'autofix.escalated', 'autofix.push', 'autofix.max_attempts_reached',
  'autofix_reset.labels_removed', 'autofix_reset.retriggered',
  'workflow.pr_operation', 'workflow.push',
]));

/** `prNumber` → `adl.pr_number`: the attribute name of a meta key. */
export function attributeName(key) {
  return `adl.${String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const metaAttributes = (meta) => (isObj(meta) ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [attributeName(k), v])) : {});
const outcomeStatus = (outcome) => (outcome === 'failed' ? 'error' : outcome == null ? 'unset' : 'ok');
const minIso = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * The span tree of a trace file (schema 1 or 2), parents before children, siblings by start time
 * (runners' clocks differ: only start order is meaningful across runs). Spans of a v1 trace, which
 * recorded no ids, get ids derived from the run id and stage. Unknown parent → the root.
 * Returns `{ rootSpanId, spans: [{ span_id, parent_span_id, name, kind, start, end, status, attributes, events }] }`.
 */
export function buildSpanTree(trace) {
  const t = isObj(trace) ? trace : {};
  const runKey = String(t.envelope?.run_id ?? t.run_id ?? 'unknown');
  const validId = (v) => (typeof v === 'string' && SPAN_ID_RE.test(v) ? v : null);
  const rootId = validId(t.root_span_id) ?? derivedSpanId(`${runKey}:root`);
  const events = (Array.isArray(t.events) ? t.events : []).filter(isObj);

  const env = isObj(t.envelope) ? t.envelope : {};
  const item = isObj(t.item) ? t.item : {};
  const root = {
    span_id: rootId,
    parent_span_id: null,
    name: 'run',
    kind: 'internal',
    start: iso(t.started_at),
    end: iso(t.completed_at),
    status: outcomeStatus(t.outcome ?? null),
    attributes: {
      'adl.item.kind': item.kind ?? null,
      'adl.item.number': item.number ?? null,
      'adl.item.source': item.source ?? null,
      'cicd.pipeline.name': env.workflow ?? null,
      'cicd.pipeline.run.id': env.run_id ?? null,
      'adl.run.attempt': env.run_attempt ?? null,
      'adl.event_name': env.event_name ?? null,
      'adl.actor_type': env.actor_type ?? null,
      'adl.issue_number': env.issue_number ?? null,
      'vcs.change.id': env.pr_number ?? null,
      'vcs.ref.head.revision': env.head_sha ?? null,
      'adl.outcome': t.outcome ?? null,
    },
    events: [],
  };
  const spans = [root];
  const byId = new Map([[rootId, root]]);
  const add = (span) => {
    if (byId.has(span.span_id)) return;
    byId.set(span.span_id, span);
    spans.push(span);
  };

  for (const s of (Array.isArray(t.spans) ? t.spans : []).filter(isObj)) {
    const start = iso(s.started_at);
    add({
      span_id: validId(s.span_id) ?? derivedSpanId(`${runKey}:stage:${s.stage}`),
      parent_span_id: validId(s.parent_span_id),
      name: String(s.stage ?? 'stage'),
      kind: 'internal',
      start,
      end: iso(s.completed_at),
      status: outcomeStatus(s.outcome ?? null),
      attributes: { ...metaAttributes(s.meta), 'adl.outcome': s.outcome ?? null },
      events: [],
    });
  }
  for (const s of (Array.isArray(t.child_spans) ? t.child_spans : []).filter(isObj)) {
    const id = validId(s.span_id);
    if (!id) continue;
    add({
      span_id: id,
      parent_span_id: validId(s.parent_span_id),
      name: String(s.name ?? 'span'),
      kind: s.name === 'llm_call' ? 'client' : 'internal',
      start: iso(s.started_at),
      end: iso(s.completed_at),
      status: s.status === 'error' ? 'error' : s.status === 'ok' ? 'ok' : 'unset',
      attributes: isObj(s.attributes) ? { ...s.attributes } : {},
      events: [],
    });
  }
  events.forEach((e, i) => {
    const ts = iso(e.ts);
    const name = typeof e.event === 'string' ? e.event : 'event';
    if (SIDE_EFFECT_EVENTS.has(name)) {
      const duration = typeof e.duration_ms === 'number' && Number.isFinite(e.duration_ms) && e.duration_ms > 0 ? e.duration_ms : 0;
      const failed = e.level === 'error' || e.meta?.outcome === 'failure';
      add({
        span_id: derivedSpanId(`${runKey}:event:${i}:${name}`),
        parent_span_id: validId(e.span_id),
        name,
        kind: 'client',
        start: ts && new Date(Date.parse(ts) - duration).toISOString(),
        end: ts,
        status: failed ? 'error' : 'ok',
        attributes: metaAttributes(e.meta),
        events: [],
      });
      return;
    }
    const owner = byId.get(validId(e.span_id)) ?? root;
    owner.events.push({ ts, name, level: e.level ?? null, attributes: metaAttributes(e.meta) });
  });

  // Parent ids that point nowhere (a span over the journal cap, a foreign id) attach to the root.
  for (const s of spans) if (s !== root && !byId.has(s.parent_span_id)) s.parent_span_id = rootId;
  // A root without timing takes it from what it contains.
  for (const s of spans) {
    root.start = minIso(root.start, s.start ?? s.events[0]?.ts ?? null);
    root.end = maxIso(root.end, s.end ?? s.events.at(-1)?.ts ?? null);
  }

  // Parents before children (breadth-first), siblings by start time then id.
  const children = new Map();
  for (const s of spans) {
    if (s === root) continue;
    if (!children.has(s.parent_span_id)) children.set(s.parent_span_id, []);
    children.get(s.parent_span_id).push(s);
  }
  const byStart = (a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.span_id.localeCompare(b.span_id);
  const ordered = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const s = queue.shift();
    if (seen.has(s.span_id)) continue;
    seen.add(s.span_id);
    ordered.push(s);
    queue.push(...(children.get(s.span_id) ?? []).sort(byStart));
  }
  // A parent cycle (forged ids) is unreachable from the root: re-attached to it, never lost.
  for (const s of spans) if (!seen.has(s.span_id)) { s.parent_span_id = rootId; ordered.push(s); }
  return { rootSpanId: rootId, spans: ordered };
}

/** One OTLP AnyValue; null/undefined → undefined (the attribute is omitted). */
export function toOtlpValue(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return undefined;
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toOtlpValue).filter(Boolean) } };
  if (isObj(v)) return { kvlistValue: { values: toOtlpAttributes(v) } };
  return undefined;
}

/** `{ k: v }` → OTLP `[{ key, value }]`, null values omitted. */
export function toOtlpAttributes(obj) {
  return Object.entries(isObj(obj) ? obj : {})
    .map(([key, v]) => ({ key, value: toOtlpValue(v) }))
    .filter((a) => a.value !== undefined);
}

/** ISO timestamp → OTLP fixed64 nanoseconds as a decimal string ('0' when unknown). */
export function unixNano(isoTs) {
  const ms = typeof isoTs === 'string' ? Date.parse(isoTs) : NaN;
  return Number.isFinite(ms) ? (BigInt(ms) * 1000000n).toString() : '0';
}

/** One span of buildSpanTree() → an OTLP JSON span. An unfinished span ends at its start. */
export function toOtlpSpan(span, traceId) {
  const start = unixNano(span.start);
  return {
    traceId,
    spanId: span.span_id,
    ...(span.parent_span_id && { parentSpanId: span.parent_span_id }),
    name: span.name,
    kind: SPAN_KIND[span.kind] ?? SPAN_KIND.internal,
    startTimeUnixNano: start,
    endTimeUnixNano: span.end ? unixNano(span.end) : start,
    attributes: toOtlpAttributes(span.attributes),
    events: (span.events ?? []).map((e) => ({ timeUnixNano: unixNano(e.ts), name: e.name, attributes: toOtlpAttributes(e.attributes) })),
    status: { code: STATUS_CODE[span.status] ?? STATUS_CODE.unset },
  };
}

/** The OTLP/JSON export request body (`ExportTraceServiceRequest`) of already-encoded spans. */
export function toOtlpDocument({ resource = {}, spans = [] } = {}) {
  return {
    resourceSpans: [{
      resource: { attributes: toOtlpAttributes({ 'service.name': SERVICE_NAME, ...resource }) },
      scopeSpans: [{ scope: { ...OTLP_SCOPE }, spans }],
    }],
  };
}
