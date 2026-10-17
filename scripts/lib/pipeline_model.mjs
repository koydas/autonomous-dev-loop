// Pipeline views of the dashboard (ADR-0027 amendment, ADR-0040, ADR-0041): the run records, trace
// indexes and legacy runs.jsonl lines of the `metrics` branch → the model the pipeline pages render.
// Pure: the builder reads the files. Every string of a record is untrusted text — the allowlist limits
// keys, not content — so it is kept as data here and escaped by the renderer; ids that become file
// paths are validated, URLs are kept only when https.
import { readRunRecord } from './run_record.mjs';
import { TRACE_ID_RE, SPAN_ID_RE } from './trace_context.mjs';
import { SIDE_EFFECT_EVENTS } from './otlp_trace.mjs';

export const RUN_ID_RE = /^\d{1,20}-\d{1,4}$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Months of records rendered (newest first): older months stay on the `metrics` branch only.
export const MAX_MONTHS = 6;
const MAX_SPANS = 1000;
const MAX_DEPTH = 32;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const ms = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** An https URL kept as given, else null (a record's meta `url` is scrubbed text, not a validated URL). */
export function safeUrl(v) {
  if (typeof v !== 'string' || v.length > 300 || !/^https:\/\/[^\s"'<>`\\]+$/.test(v)) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/** One OTLP AnyValue → a JS value (strings, numbers, booleans, arrays of them); anything else → null. */
export function anyValue(v) {
  if (!isObj(v)) return null;
  if (Object.hasOwn(v, 'stringValue')) return str(v.stringValue);
  if (Object.hasOwn(v, 'intValue')) {
    const n = typeof v.intValue === 'string' && /^-?\d{1,16}$/.test(v.intValue) ? Number(v.intValue) : num(v.intValue);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (Object.hasOwn(v, 'doubleValue')) return num(v.doubleValue);
  if (Object.hasOwn(v, 'boolValue')) return typeof v.boolValue === 'boolean' ? v.boolValue : null;
  if (Object.hasOwn(v, 'arrayValue')) {
    return Array.isArray(v.arrayValue?.values) ? v.arrayValue.values.slice(0, 50).map(anyValue).filter((x) => x !== null && typeof x !== 'object') : null;
  }
  return null;
}

/** OTLP `[{ key, value }]` → `{ key: value }` (first wins, at most 100 keys). */
export function otlpAttributes(list) {
  const out = {};
  for (const a of (Array.isArray(list) ? list : []).slice(0, 100)) {
    if (!isObj(a) || typeof a.key !== 'string' || Object.hasOwn(out, a.key)) continue;
    const v = anyValue(a.value);
    if (v !== null) out[a.key] = v;
  }
  return out;
}

/** OTLP decimal-string nanoseconds → epoch ms; '0', malformed or out of range → null. */
export function nanoToMs(v) {
  if (typeof v !== 'string' || !/^\d{1,20}$/.test(v)) return null;
  const t = Number(BigInt(v) / 1000000n);
  return t > 0 ? t : null;
}

function spanKind(name, isRoot) {
  if (isRoot && name === 'run') return 'run';
  if (name === 'llm_call') return 'llm';
  if (SIDE_EFFECT_EVENTS.has(name)) return 'effect';
  return 'stage';
}

function llmFields(kind, attrs) {
  if (kind !== 'llm') return { provider: null, model: str(attrs['adl.model']), tokens: null };
  const tin = num(attrs['gen_ai.usage.input_tokens']);
  const tout = num(attrs['gen_ai.usage.output_tokens']);
  return {
    provider: str(attrs['gen_ai.system']),
    model: str(attrs['gen_ai.response.model']) ?? str(attrs['gen_ai.request.model']),
    tokens: tin == null && tout == null ? null : { in: tin, out: tout, estimated: attrs['adl.usage.estimated'] === true },
    fallback: attrs['adl.llm.fallback'] === true,
    error_type: str(attrs['error.type']),
  };
}

// Depth-first (children right after their parent), siblings by start: the waterfall order.
function nest(spans) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const children = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parent && s.parent !== s.id && byId.has(s.parent)) {
      if (!children.has(s.parent)) children.set(s.parent, []);
      children.get(s.parent).push(s);
    } else roots.push(s);
  }
  const byStart = (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id.localeCompare(b.id);
  const out = [];
  const seen = new Set();
  const stack = roots.sort(byStart).reverse().map((s) => [s, 0]);
  while (stack.length) {
    const [s, depth] = stack.pop();
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ ...s, depth: Math.min(depth, MAX_DEPTH) });
    for (const c of (children.get(s.id) ?? []).sort(byStart).reverse()) stack.push([c, depth + 1]);
  }
  // A parent cycle (forged ids) is unreachable from any root: shown under the first root, never lost.
  for (const s of spans) if (!seen.has(s.id)) out.push({ ...s, depth: 1 });
  return out;
}

function waterfallFromOtlp(otlp) {
  const raw = (otlp.resourceSpans ?? []).flatMap((rs) => (Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : []))
    .flatMap((ss) => (Array.isArray(ss?.spans) ? ss.spans : []))
    .filter((s) => isObj(s) && typeof s.spanId === 'string' && SPAN_ID_RE.test(s.spanId))
    .slice(0, MAX_SPANS);
  const ids = new Set();
  const spans = [];
  for (const s of raw) {
    if (ids.has(s.spanId)) continue;
    ids.add(s.spanId);
    const parent = typeof s.parentSpanId === 'string' && SPAN_ID_RE.test(s.parentSpanId) ? s.parentSpanId : null;
    const name = str(s.name) ?? 'span';
    const attrs = otlpAttributes(s.attributes);
    const kind = spanKind(name, !parent);
    const start = nanoToMs(s.startTimeUnixNano);
    const end = nanoToMs(s.endTimeUnixNano);
    spans.push({
      id: s.spanId,
      parent,
      name,
      kind,
      start,
      end: end ?? start,
      status: s.status?.code === 2 ? 'error' : s.status?.code === 1 ? 'ok' : 'unset',
      outcome: str(attrs['adl.outcome']),
      ...llmFields(kind, attrs),
      links: [safeUrl(attrs['adl.url'])].filter(Boolean),
      events: (Array.isArray(s.events) ? s.events : []).filter(isObj).slice(0, 200)
        .map((e) => ({ ts: nanoToMs(e.timeUnixNano), name: str(e.name) ?? 'event' })),
    });
  }
  return nest(spans);
}

// A v1 record (or a v2 one without its OTLP block): the run and its stages, flat.
function waterfallFlat(rec, started, completed) {
  const root = {
    id: 'run', parent: null, name: 'run', kind: 'run', start: started, end: completed ?? started,
    status: rec.outcome === 'failed' ? 'error' : rec.outcome ? 'ok' : 'unset', outcome: str(rec.outcome),
    provider: null, model: null, tokens: null, links: [], events: [],
  };
  const stages = rec.spans.filter(isObj).slice(0, MAX_SPANS).map((s, i) => ({
    id: `stage-${i}`, parent: 'run', name: str(s.stage) ?? 'stage', kind: 'stage',
    start: ms(s.started_at), end: ms(s.completed_at) ?? ms(s.started_at),
    status: s.outcome === 'failed' ? 'error' : s.outcome ? 'ok' : 'unset', outcome: str(s.outcome),
    provider: null, model: isObj(s.meta) ? str(s.meta.model) : null, tokens: null, links: [], events: [], depth: 1,
  }));
  return [{ ...root, depth: 0 }, ...stages];
}

function normalizeEvents(events) {
  return events.filter(isObj).map((e) => ({
    ts: ms(e.ts),
    stage: str(e.stage),
    event: str(e.event) ?? 'event',
    level: ['info', 'warn', 'error'].includes(e.level) ? e.level : null,
    duration_ms: num(e.duration_ms),
    span_id: typeof e.span_id === 'string' && SPAN_ID_RE.test(e.span_id) ? e.span_id : null,
    meta: isObj(e.meta) ? e.meta : {},
  }));
}

// LLM calls with their (estimated) tokens: the llm_call spans of a v2 record; for a v1 record the
// envelope's llm_calls, with the stage's request/response token estimates on the first call.
function llmCalls(waterfall, envelope, events) {
  const spans = waterfall.filter((s) => s.kind === 'llm');
  if (spans.length) {
    return spans.map((s) => ({
      provider: s.provider, model: s.model, ts: s.start, duration_ms: s.start != null && s.end != null ? s.end - s.start : null,
      tokens_in: s.tokens?.in ?? 0, tokens_out: s.tokens?.out ?? 0, estimated: s.tokens?.estimated ?? true,
      fallback: s.fallback === true, failed: s.status === 'error',
    }));
  }
  const calls = (Array.isArray(envelope.llm_calls) ? envelope.llm_calls : []).filter(isObj);
  const sum = (suffix, key) => events.filter((e) => e.event.endsWith(suffix)).reduce((t, e) => t + (num(e.meta[key]) ?? 0), 0);
  const tin = sum('.llm_request', 'input_tokens_est');
  const tout = sum('.llm_response', 'output_tokens_est');
  if (!calls.length && !tin && !tout) return [];
  const first = events.find((e) => e.event.endsWith('.llm_request'))?.ts ?? null;
  const list = calls.length ? calls : [{}];
  return list.map((c, i) => ({
    provider: str(c.provider), model: str(c.model), ts: first, duration_ms: num(c.duration_ms),
    tokens_in: i === 0 ? tin : 0, tokens_out: i === 0 ? tout : 0, estimated: true,
    fallback: c.fallback === true, failed: c.outcome === 'failed',
  }));
}

/**
 * One stored record (raw text or object) at `path` (metrics/runs/<YYYY-MM>/<run>.json) → the run the
 * pages render, or `{ error }` for anything readRunRecord() rejects or whose run id cannot name a page.
 */
export function normalizeRun(raw, path = '') {
  const rec = readRunRecord(raw);
  if (!rec) return { error: 'not a readable run record' };
  if (typeof rec.run_id !== 'string' || !RUN_ID_RE.test(rec.run_id)) return { error: 'run_id missing or malformed' };
  const envelope = isObj(rec.envelope) ? rec.envelope : {};
  const started = ms(rec.started_at);
  const completed = ms(rec.completed_at);
  const month = /^metrics\/runs\/(\d{4}-\d{2})\//.exec(path)?.[1] ?? (rec.started_at ?? '').slice(0, 7);
  const events = normalizeEvents(rec.events);
  const otlp = rec.schema_version >= 2 && rec.otlp ? waterfallFromOtlp(rec.otlp) : [];
  const flat = otlp.length === 0;
  const waterfall = flat ? waterfallFlat(rec, started, completed) : otlp;
  const item = isObj(rec.item) && ['issue', 'pr', 'run'].includes(rec.item.kind) && posInt(rec.item.number) ? { kind: rec.item.kind, number: rec.item.number, key: str(rec.item.key) } : null;
  return {
    run: {
      run_id: rec.run_id,
      path,
      month: MONTH_RE.test(month) ? month : null,
      schema_version: rec.schema_version,
      trace_id: typeof rec.trace_id === 'string' && TRACE_ID_RE.test(rec.trace_id) ? rec.trace_id : null,
      item,
      workflow: str(envelope.workflow),
      event_name: str(envelope.event_name),
      actor: str(envelope.actor),
      actor_type: str(envelope.actor_type),
      issue_number: posInt(envelope.issue_number) ?? (item?.kind === 'issue' ? item.number : null),
      pr_number: posInt(envelope.pr_number),
      head_sha: typeof envelope.head_sha === 'string' && /^[0-9a-f]{40}$/.test(envelope.head_sha) ? envelope.head_sha : null,
      run_url: safeUrl(envelope.run_url),
      issue_url: safeUrl(envelope.issue_url),
      pr_url: safeUrl(envelope.pr_url),
      links: (Array.isArray(envelope.links) ? envelope.links : []).filter(isObj)
        .map((l) => ({ event: str(l.event), url: safeUrl(l.url) })).filter((l) => l.url),
      started_at: started,
      completed_at: completed,
      duration_ms: started != null && completed != null && completed >= started ? completed - started : null,
      outcome: str(rec.outcome),
      stages: rec.spans.filter(isObj).map((s) => ({ stage: str(s.stage), duration_ms: num(s.duration_ms), outcome: str(s.outcome), meta: isObj(s.meta) ? s.meta : {} })),
      events,
      waterfall,
      flat,
      llm: llmCalls(waterfall, envelope, events),
      events_overflow: { count: num(rec.events_overflow?.count) ?? 0, bytes: num(rec.events_overflow?.bytes) ?? 0 },
      spans_overflow: { count: num(rec.spans_overflow?.count) ?? 0, events: num(rec.spans_overflow?.events) ?? 0 },
    },
  };
}

// Union of [start, end] intervals, in ms.
function unionMs(intervals) {
  const sorted = intervals.filter(([a, b]) => a != null && b != null && b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of sorted) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  return cur ? total + cur[1] - cur[0] : 0;
}

/**
 * One trace index (metrics/traces/<trace_id>.json) joined to the loaded runs, or `{ error }`. A listed
 * run whose record is not loaded (missing, malformed or outside the month window) stays as a row with
 * `run: null`. The critical path splits the lead time into running (union of the runs' own spans)
 * and waiting (between runs); runner clocks differ, so it is an approximation (ADR-0041 §6).
 */
export function normalizeTrace(raw, runsById = new Map()) {
  let idx = raw;
  if (typeof idx === 'string') try { idx = JSON.parse(idx); } catch { return { error: 'not JSON' }; }
  if (!isObj(idx) || idx.schema_version !== 1) return { error: 'not a trace index (schema_version 1)' };
  if (typeof idx.trace_id !== 'string' || !TRACE_ID_RE.test(idx.trace_id)) return { error: 'trace_id missing or malformed' };
  if (!Array.isArray(idx.runs)) return { error: 'runs is not an array' };
  const runs = idx.runs.filter((r) => isObj(r) && typeof r.run_id === 'string' && RUN_ID_RE.test(r.run_id)).map((r) => {
    const run = runsById.get(r.run_id) ?? null;
    return {
      run_id: r.run_id,
      workflow: str(r.workflow) ?? run?.workflow ?? null,
      event_name: str(r.event_name) ?? run?.event_name ?? null,
      outcome: str(r.outcome) ?? run?.outcome ?? null,
      started_at: ms(r.started_at) ?? run?.started_at ?? null,
      completed_at: ms(r.completed_at) ?? run?.completed_at ?? null,
      run,
    };
  });
  const first = ms(idx.first_started_at) ?? Math.min(...runs.map((r) => r.started_at ?? Infinity));
  const last = ms(idx.last_completed_at) ?? Math.max(...runs.map((r) => r.completed_at ?? -Infinity));
  const lead = num(idx.lead_time_ms) ?? (Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null);
  const running = unionMs(runs.map((r) => [r.started_at, r.completed_at]));
  const item = isObj(idx.item) && ['issue', 'pr', 'run'].includes(idx.item.kind) && posInt(idx.item.number) ? { kind: idx.item.kind, number: idx.item.number, key: str(idx.item.key) } : null;
  return {
    trace: {
      trace_id: idx.trace_id,
      item,
      first_started_at: Number.isFinite(first) ? first : null,
      last_completed_at: Number.isFinite(last) ? last : null,
      lead_time_ms: lead,
      runs,
      dropped_runs: idx.runs.length - runs.length,
      runs_overflow: num(idx.runs_overflow) ?? 0,
      running_ms: running,
      waiting_ms: lead == null ? null : Math.max(0, lead - running),
    },
  };
}

/** Legacy metrics/runs.jsonl → its parseable object lines (a bad line is counted, never fatal). */
export function parseRunsJsonl(text) {
  const lines = [];
  let bad = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isObj(v) && typeof v.type === 'string') lines.push(v);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { lines, bad };
}

/**
 * The pipeline model from the `metrics` branch files: `records` and `traces` are `[{ path, text }]`,
 * `runsJsonl` the raw legacy file. Records of the newest `maxMonths` months are kept (by path month);
 * a malformed record, a duplicate run id or a broken index is skipped with a warning (`log`), never fatal.
 * Returns `{ runs (newest first), runsById, traces (newest first), legacy, months, skippedMonths, warnings }`.
 */
export function buildPipelineModel({ records = [], traces = [], runsJsonl = '', maxMonths = MAX_MONTHS, log = () => {} } = {}) {
  const warnings = [];
  const warn = (msg) => { warnings.push(msg); log(`Warning: ${msg}`); };
  const monthOf = (p) => /^metrics\/runs\/(\d{4}-\d{2})\//.exec(p)?.[1] ?? null;
  const allMonths = [...new Set(records.map((r) => monthOf(r.path)).filter((m) => m && MONTH_RE.test(m)))].sort().reverse();
  const months = allMonths.slice(0, maxMonths);
  const keep = new Set(months);
  const runsById = new Map();
  for (const { path, text } of [...records].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    if (!keep.has(monthOf(path))) continue;
    const { run, error } = normalizeRun(text, path);
    if (error) { warn(`${path} skipped: ${error}`); continue; }
    if (runsById.has(run.run_id)) { warn(`${path} skipped: run ${run.run_id} already loaded from ${runsById.get(run.run_id).path}`); continue; }
    runsById.set(run.run_id, run);
  }
  const traceList = [];
  for (const { path, text } of traces) {
    const { trace, error } = normalizeTrace(text, runsById);
    if (error) { warn(`${path} skipped: ${error}`); continue; }
    for (const r of trace.runs) {
      if (!r.run && keep.has((r.started_at ? new Date(r.started_at).toISOString() : '').slice(0, 7))) {
        warn(`${path}: run ${r.run_id} has no loadable record`);
      }
    }
    traceList.push(trace);
  }
  const byNewest = (a, b) => (b.started_at ?? 0) - (a.started_at ?? 0) || b.run_id.localeCompare(a.run_id);
  traceList.sort((a, b) => (b.last_completed_at ?? 0) - (a.last_completed_at ?? 0) || a.trace_id.localeCompare(b.trace_id));
  const { lines, bad } = parseRunsJsonl(runsJsonl);
  if (bad) warn(`metrics/runs.jsonl: ${bad} unparseable line(s) skipped`);
  return {
    runs: [...runsById.values()].sort(byNewest),
    runsById,
    traces: traceList,
    tracesById: new Map(traceList.map((t) => [t.trace_id, t])),
    legacy: lines,
    months,
    skippedMonths: allMonths.slice(maxMonths),
    warnings,
  };
}

const SUMMARY_KEYS = ['verdict', 'review_event', 'reason', 'operation', 'outcome', 'action', 'label', 'state', 'rules', 'error'];

/** A short `key=value` summary of an event's meta (render-escaped by the caller). */
export function eventSummary(meta) {
  const parts = [];
  for (const k of SUMMARY_KEYS) {
    const v = meta?.[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    parts.push(`${k}=${Array.isArray(v) ? v.join(',') : String(v)}`);
  }
  return parts.join(' · ').slice(0, 240);
}

/** Every event of every run, newest first, with its run context: the activity feed. */
export function feedEntries(runs) {
  const out = [];
  for (const run of runs) {
    for (const e of run.events) {
      out.push({
        ts: e.ts, stage: e.stage, event: e.event, level: e.level,
        run_id: run.run_id, workflow: run.workflow, outcome: run.outcome,
        issue: run.issue_number, pr: run.pr_number ?? (posInt(e.meta.prNumber) ?? null),
        url: safeUrl(e.meta.url), summary: eventSummary(e.meta),
      });
    }
  }
  return out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || b.run_id.localeCompare(a.run_id));
}
