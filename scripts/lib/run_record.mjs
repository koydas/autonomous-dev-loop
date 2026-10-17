// Public run record (ADR-0040): the redacted trace a dashboard reads from the `metrics` branch, and
// the single-commit write of that record with the run's metrics/runs.jsonl lines (ADR-0013).
// redactTrace() is the only path from a trace file to the store: the site is public.
// ADR-0041: schema 2 adds the work item, its trace id and the run's spans in OTLP JSON shape, and
// metrics/traces/<trace_id>.json, the index of the runs of a trace, written in the same commit.
import { buildSpanTree, toOtlpSpan, toOtlpDocument, attributeName, SIDE_EFFECT_EVENTS } from './otlp_trace.mjs';
import { TRACE_ID_RE, SPAN_ID_RE, ITEM_KINDS, workItem } from './trace_context.mjs';

export const RECORD_SCHEMA_VERSION = 2;
// Record versions readRunRecord() accepts.
export const READABLE_RECORD_VERSIONS = Object.freeze([1, 2]);
// The OTLP block takes at most this share of MAX_RECORD_BYTES; spans past it are counted.
export const MAX_OTLP_BYTES = 128 * 1024;
export const MAX_INDEX_RUNS = 500;
export const TRACE_INDEX_SCHEMA_VERSION = 1;
export const MAX_STRING = 200;
export const MAX_ARRAY = 50;
export const MAX_RECORD_BYTES = 256 * 1024;
export const METRICS_BRANCH = 'metrics';
export const RUNS_JSONL_PATH = 'metrics/runs.jsonl';

const REDACTED = '[redacted]';
const ID = ['prNumber', 'issueNumber', 'attempt'];
const ERR = ['error'];

// Meta keys kept per event. An event not listed keeps its name, level and timing, with meta {}.
// Never listed: prompts, raw model output, file contents, issue/PR titles and bodies, previews,
// env, stack traces, stderr tails, local paths (configPath).
export const EVENT_META_ALLOWLIST = Object.freeze({
  'issue_validation.start': [...ID, 'model'],
  'issue_validation.pass': [...ID, 'score', 'warnings_count'],
  'issue_validation.fail': [...ID, ...ERR, 'score', 'blockers_count'],
  'issue_validation.comment_posted': [...ID, 'action', 'url'],
  'issue_validation.labels_applied': [...ID, 'added', 'removed'],
  'code_gen.start': [...ID, 'model'],
  'code_gen.context_built': ['shown_files', 'hidden_files', 'deterministic_block'],
  'code_gen.llm_request': ['model', 'input_tokens_est'],
  'code_gen.llm_response': ['output_tokens_est'],
  'code_gen.complete': ['changes_count'],
  'code_gen.error': [...ERR, 'reason', 'source'],
  'code_gen.skipped': [...ERR, 'reason', 'rules', 'source', 'detail'],
  'code_gen.escalated': ['during', 'reason', 'source', 'rules', 'labels_added', 'labels_removed', 'url'],
  'pr_prepare.start': ['changes_count'],
  'pr_prepare.complete': ['paths'],
  'pr_prepare.error': ERR,
  'pr_prepare.skipped': [...ERR, 'reason', 'rules'],
  'review.start': [...ID, 'model'],
  'review.llm_request': [...ID, 'model', 'input_tokens_est'],
  'review.llm_response': [...ID, 'output_tokens_est'],
  'review.verdict': [...ID, 'verdict', 'evidence_state', 'evidence_override', 'unreviewed_code_files'],
  'review.skipped': [...ID, 'reason', 'headSha'],
  'review.error': ERR,
  'review.stale_refs_error': ERR,
  'review.related_adrs_error': ERR,
  'review.prompt_budget_error': ERR,
  'review.models_config_ignored': [...ERR, 'path'],
  'review.evidence_assessed': [...ID, 'state', 'reason', 'failing', 'unverified'],
  'review.prompt_truncated': [...ID, 'diff_truncated', 'body_truncated', 'unreviewed_code_files', 'adrs_shown', 'adrs_found', 'max_input_tokens'],
  'review.comment_posted': [...ID, 'action', 'headSha', 'url'],
  'review.review_submitted': [...ID, 'review_event', 'skipped', 'url'],
  'review.labels_applied': [...ID, 'added', 'removed', 'repulse_skipped'],
  'autofix.start': ID,
  'autofix.llm_request': [...ID, 'model', 'input_tokens_est'],
  'autofix.llm_response': [...ID, 'output_tokens_est'],
  'autofix.prompt_budget': [...ID, 'input_budget', 'shown_files', 'hidden_files', 'skipped_files', 'diff_truncated', 'feedback_truncated'],
  'autofix.push': [...ID, 'paths'],
  'autofix.max_attempts_reached': [...ID, 'url'],
  'autofix.skipped': [...ID, 'reason', 'headSha', 'rules', 'url'],
  'autofix.error': [...ID, ...ERR],
  'autofix.reset': [...ID, 'removed_labels', 'removed_checkpoints'],
  'autofix.attempt_labeled': [...ID, 'label'],
  'autofix.escalated': [...ID, 'reason', 'labels_added', 'url'],
  llm_call: ['provider', 'model', 'fallback'],
  llm_call_failed: ['providers'],
  llm_fallback: ['from', 'to', 'error_type', ...ERR],
  llm_fallback_disabled: ['from', 'error_type', ...ERR],
  provider_config_fallback: ['ai_provider', 'provider'],
  'dependency_manifest.package_json_ignored': ['path', 'reason'],
  'retry.wait': ['attempt', 'wait_ms', 'status', ...ERR],
  'workflow.pr_operation': [...ID, 'operation', 'url'],
  'workflow.push': [...ID, 'outcome'],
  'trace.work_item': ['prNumber', 'branchIssue', 'closingIssues'],
  'autofix_reset.start': ID,
  'autofix_reset.labels_removed': [...ID, 'removed_labels'],
  'autofix_reset.retriggered': [...ID, 'label'],
  'autofix_reset.complete': [...ID, 'retrigger'],
  'autofix_reset.error': [...ID, ...ERR],
  trace_write_failed: ERR,
  start_span_failed: [...ERR, 'stage'],
  end_span_failed: [...ERR, 'stage'],
  trace_finalize_failed: ERR,
});

// Span meta keys kept (any stage).
export const SPAN_META_ALLOWLIST = Object.freeze([
  ...ID, 'model', 'score', 'valid', 'verdict', 'reason', 'changes_count', 'paths', 'rules', 'source', ...ERR,
]);

// ADR-0041: span attributes kept per span name; any other attribute is dropped. Stage spans keep the
// SPAN_META_ALLOWLIST keys (as adl.<snake_case>); side-effect spans and span events keep the
// EVENT_META_ALLOWLIST keys of their event. Never listed: prompts, completions, file contents,
// titles/bodies, env values.
const STAGE_ATTRIBUTES = [...SPAN_META_ALLOWLIST.map(attributeName), 'adl.outcome'];
const STAGES = ['issue_validation', 'code_gen', 'pr_prepare', 'review', 'review_evidence', 'autofix', 'autofix_reset', 'eval', 'eval_replay', 'pr_evals', 'pr_evals_report'];
export const SPAN_ATTRIBUTE_ALLOWLIST = Object.freeze({
  run: ['adl.item.kind', 'adl.item.number', 'adl.item.source', 'cicd.pipeline.name', 'cicd.pipeline.run.id', 'adl.run.attempt',
    'adl.event_name', 'adl.actor_type', 'adl.issue_number', 'vcs.change.id', 'vcs.ref.head.revision', 'adl.outcome'],
  llm_call: ['gen_ai.operation.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.request.max_tokens',
    'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'adl.usage.estimated', 'adl.stage', 'adl.llm.fallback',
    'adl.llm.fallback_from', 'adl.llm.providers', 'adl.llm.input_budget_skipped', 'adl.llm.max_input_tokens', 'error.type'],
  'eval.case': ['adl.eval.suite', 'adl.eval.case_id', 'adl.eval.repeat', 'error.type'],
  ...Object.fromEntries(STAGES.map((stage) => [stage, STAGE_ATTRIBUTES])),
  ...Object.fromEntries([...SIDE_EFFECT_EVENTS].map((name) => [name, (EVENT_META_ALLOWLIST[name] ?? []).map(attributeName)])),
});
const eventAttributeAllowlist = (name) => (Object.hasOwn(EVENT_META_ALLOWLIST, name) ? EVENT_META_ALLOWLIST[name].map(attributeName) : []);

// Env vars whose values are public and may appear in a record (run metadata, model names).
const PUBLIC_ENV = new Set([
  'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SERVER_URL', 'GITHUB_API_URL', 'GITHUB_GRAPHQL_URL',
  'GITHUB_WORKFLOW', 'GITHUB_WORKFLOW_REF', 'GITHUB_ACTOR', 'GITHUB_TRIGGERING_ACTOR', 'GITHUB_EVENT_NAME',
  'GITHUB_REF', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'AI_PROVIDER',
]);
const PUBLIC_ENV_SUFFIX = /_(MODEL|EFFORT|PROVIDER)$/;
// Workflow outputs handed to commit_run_record.mjs (PR URL/number, push outcome, commit message).
const PUBLIC_ENV_PREFIX = /^RUN_RECORD_/;
// Any other env value this long is scrubbed wherever it appears: secrets, tokens, issue bodies,
// runner paths. Over-redaction is the failure mode, never a leak.
const MIN_SCRUBBED_ENV_LENGTH = 12;
// Credential shapes, scrubbed even when they come from somewhere other than the env.
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Env values to scrub, longest first (a value containing another is replaced whole). */
export function secretValues(env = {}) {
  return [...new Set(Object.entries(env)
    .filter(([name, value]) => typeof value === 'string' && value.length >= MIN_SCRUBBED_ENV_LENGTH
      && !PUBLIC_ENV.has(name) && !PUBLIC_ENV_SUFFIX.test(name) && !PUBLIC_ENV_PREFIX.test(name))
    .map(([, value]) => value))]
    .sort((a, b) => b.length - a.length);
}

/** Replaces every env value in `secrets` and every credential shape by [redacted]; no truncation. */
export function scrubString(value, secrets = []) {
  let s = String(value);
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join(REDACTED);
  for (const re of TOKEN_PATTERNS) s = s.replace(re, REDACTED);
  return s;
}

/** Scrub, then truncate to MAX_STRING characters (scrubbing first: a cut secret would no longer match). */
export function redactString(value, secrets = []) {
  const s = scrubString(value, secrets);
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
}

function redactValue(value, secrets, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => (v !== null && typeof v === 'object' ? null : redactValue(v, secrets, depth + 1)));
  }
  // One level of plain object with primitive values (e.g. a map of check name → status).
  if (typeof value === 'object' && depth === 0) {
    return Object.fromEntries(Object.entries(value).slice(0, MAX_ARRAY)
      .filter(([, v]) => v === null || typeof v !== 'object')
      .map(([k, v]) => [redactString(k, secrets), redactValue(v, secrets, depth + 1)]));
  }
  return null;
}

function pick(meta, keys, secrets) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const key of keys) if (Object.hasOwn(meta, key)) out[key] = redactValue(meta[key], secrets);
  return out;
}

const str = (v, secrets) => (typeof v === 'string' ? redactString(v, secrets) : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : null);
const spanId = (v) => (typeof v === 'string' && SPAN_ID_RE.test(v) ? v : null);
const ITEM_SOURCES = ['issue_event', 'branch', 'closes', 'pr', 'run', 'envelope'];

/**
 * The work item of a trace (ADR-0041): the one the producing run resolved (`trace.item`), else — a
 * v1 trace — from its envelope (issue, else PR, else the run alone). The key and trace id are
 * recomputed from the redacted repository, kind and number, never copied from the file.
 */
export function traceItem(trace, envelope) {
  const t = trace && typeof trace === 'object' ? trace : {};
  const repo = envelope?.repository ?? null;
  const it = t.item && typeof t.item === 'object' ? t.item : null;
  const source = ITEM_SOURCES.includes(it?.source) ? it.source : null;
  const fromTrace = ITEM_KINDS.includes(it?.kind) ? workItem(repo, it.kind, it.number, source) : null;
  return fromTrace
    ?? workItem(repo, 'issue', envelope?.issue_number, 'envelope')
    ?? workItem(repo, 'pr', envelope?.pr_number, 'envelope')
    ?? workItem(repo, 'run', envelope?.run_id, 'envelope');
}

function redactAttributes(attributes, allowed, secrets) {
  const out = {};
  for (const key of allowed) {
    if (!Object.hasOwn(attributes ?? {}, key)) continue;
    const v = redactValue(attributes[key], secrets);
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * The OTLP block of a record: spans of buildSpanTree(), attributes through SPAN_ATTRIBUTE_ALLOWLIST
 * (span events: EVENT_META_ALLOWLIST), names and strings scrubbed, within MAX_OTLP_BYTES. Spans are
 * added parents first; past the cap a span — and every span after it, so no child loses its parent —
 * is counted in `spans_overflow.count`, a span event that does not fit in `spans_overflow.events`.
 */
function redactOtlp(trace, traceId, envelope, secrets) {
  const overflow = { count: 0, events: 0 };
  if (!traceId) return { otlp: null, overflow };
  // The root span's attributes come from the validated envelope, like the record's own `envelope`.
  const { spans } = buildSpanTree({ ...trace, envelope });
  const doc = toOtlpDocument({ resource: { 'adl.repository': envelope.repository }, spans: [] });
  const out = doc.resourceSpans[0].scopeSpans[0].spans;
  let used = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  let full = false;
  for (const span of spans) {
    const name = str(span.name, secrets) ?? 'span';
    const allowed = Object.hasOwn(SPAN_ATTRIBUTE_ALLOWLIST, name) ? SPAN_ATTRIBUTE_ALLOWLIST[name] : [];
    const encoded = toOtlpSpan({ ...span, name, attributes: redactAttributes(span.attributes, allowed, secrets), events: [] }, traceId);
    let size = Buffer.byteLength(JSON.stringify(encoded), 'utf8') + 1;
    if (full || used + size > MAX_OTLP_BYTES) {
      full = true;
      overflow.count += 1;
      overflow.events += span.events.length;
      continue;
    }
    for (const e of span.events) {
      const eventName = str(e.name, secrets) ?? 'event';
      const [ev] = toOtlpSpan({ start: e.ts, events: [{ ...e, name: eventName, attributes: redactAttributes(e.attributes, eventAttributeAllowlist(eventName), secrets) }] }, traceId).events;
      const evSize = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1;
      if (used + size + evSize > MAX_OTLP_BYTES) { overflow.events += 1; continue; }
      encoded.events.push(ev);
      size += evSize;
    }
    out.push(encoded);
    used += size;
  }
  return { otlp: doc, overflow };
}

// A URL is kept whole or dropped: on the server host, URL-safe characters, nothing to scrub.
function redactUrl(v, server, secrets) {
  if (typeof v !== 'string' || v.length > 300 || !v.startsWith(`${server}/`)) return null;
  if (!/^[A-Za-z0-9/._~%#?=&:-]+$/.test(v)) return null;
  return redactString(v, secrets) === v ? v : null;
}

function redactEnvelope(e, secrets, server) {
  const env = e && typeof e === 'object' ? e : {};
  return {
    workflow: str(env.workflow, secrets),
    run_id: typeof env.run_id === 'string' && /^\d+$/.test(env.run_id) ? env.run_id : null,
    run_attempt: int(env.run_attempt),
    event_name: str(env.event_name, secrets),
    actor: str(env.actor, secrets),
    actor_type: env.actor_type === 'bot' || env.actor_type === 'human' ? env.actor_type : null,
    repository: str(env.repository, secrets),
    issue_number: int(env.issue_number),
    pr_number: int(env.pr_number),
    head_sha: sha(env.head_sha),
    run_url: redactUrl(env.run_url, server, secrets),
    issue_url: redactUrl(env.issue_url, server, secrets),
    pr_url: redactUrl(env.pr_url, server, secrets),
    links: (Array.isArray(env.links) ? env.links : [])
      .map((l) => ({ event: str(l?.event, secrets), url: redactUrl(l?.url, server, secrets) }))
      .filter((l) => l.url)
      .slice(0, MAX_ARRAY),
    llm_calls: (Array.isArray(env.llm_calls) ? env.llm_calls : []).slice(0, MAX_ARRAY).map((c) => ({
      stage: str(c?.stage, secrets),
      provider: str(c?.provider, secrets),
      model: str(c?.model, secrets),
      fallback: c?.fallback === true,
      outcome: c?.outcome === 'answered' || c?.outcome === 'failed' ? c.outcome : null,
      duration_ms: num(c?.duration_ms),
    })),
  };
}

/**
 * The public record of a trace file (ADR-0040). Allowlist only: unknown top-level keys, meta keys
 * not in EVENT_META_ALLOWLIST / SPAN_META_ALLOWLIST and nested objects are dropped; strings are
 * scrubbed of env values and credential shapes, then cut to MAX_STRING. Events past MAX_RECORD_BYTES
 * are counted in `events_overflow`, like the journal's own cap.
 */
export function redactTrace(trace, { env = {} } = {}) {
  const t = trace && typeof trace === 'object' ? trace : {};
  const secrets = secretValues(env);
  const server = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const envelope = redactEnvelope(t.envelope, secrets, server);
  const item = traceItem(t, envelope);
  const traceId = item && TRACE_ID_RE.test(item.trace_id) ? item.trace_id : null;
  const { otlp, overflow: spansOverflow } = redactOtlp(t, traceId, envelope, secrets);
  const record = {
    schema_version: RECORD_SCHEMA_VERSION,
    trace_schema_version: int(t.schema_version),
    run_id: envelope.run_id ? `${envelope.run_id}-${envelope.run_attempt ?? 1}` : null,
    trace_id: traceId,
    item: item && { kind: item.kind, number: item.number, source: item.source, key: str(item.key, secrets) },
    root_span_id: spanId(t.root_span_id),
    envelope,
    started_at: iso(t.started_at),
    completed_at: iso(t.completed_at),
    outcome: str(t.outcome, secrets),
    spans: (Array.isArray(t.spans) ? t.spans : []).slice(0, MAX_ARRAY).map((s) => ({
      stage: str(s?.stage, secrets),
      span_id: spanId(s?.span_id),
      parent_span_id: spanId(s?.parent_span_id),
      started_at: iso(s?.started_at),
      completed_at: iso(s?.completed_at),
      duration_ms: num(s?.duration_ms),
      outcome: str(s?.outcome, secrets),
      meta: pick(s?.meta, SPAN_META_ALLOWLIST, secrets),
    })),
    events: [],
    events_overflow: {
      count: int(t.events_overflow?.count) ?? 0,
      bytes: int(t.events_overflow?.bytes) ?? 0,
    },
    // Child spans over the journal cap, plus spans and span events over MAX_OTLP_BYTES.
    spans_overflow: {
      count: (int(t.spans_overflow?.count) ?? 0) + spansOverflow.count,
      events: spansOverflow.events,
    },
    otlp,
  };
  let bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  for (const e of Array.isArray(t.events) ? t.events : []) {
    const name = str(e?.event, secrets);
    const event = {
      ts: iso(e?.ts),
      stage: str(e?.stage, secrets),
      event: name,
      level: ['info', 'warn', 'error'].includes(e?.level) ? e.level : null,
      duration_ms: num(e?.duration_ms),
      span_id: spanId(e?.span_id),
      meta: pick(e?.meta, (name && Object.hasOwn(EVENT_META_ALLOWLIST, name)) ? EVENT_META_ALLOWLIST[name] : [], secrets),
    };
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    if (bytes + size > MAX_RECORD_BYTES) {
      record.events_overflow.count += 1;
      record.events_overflow.bytes += size;
      continue;
    }
    record.events.push(event);
    bytes += size;
  }
  return record;
}

/**
 * A stored run record of any readable version, normalized to the v2 fields a reader uses; null for
 * anything else. A v1 record has no trace id: it is derived from its envelope (issue, else PR),
 * and it carries no OTLP block (`otlp: null`).
 */
export function readRunRecord(raw) {
  let r = raw;
  if (typeof r === 'string') try { r = JSON.parse(r); } catch { return null; }
  if (!r || typeof r !== 'object' || !READABLE_RECORD_VERSIONS.includes(r.schema_version)) return null;
  const envelope = r.envelope && typeof r.envelope === 'object' ? r.envelope : {};
  const item = r.schema_version >= 2 && r.item ? traceItem({ item: r.item }, envelope) : traceItem({}, envelope);
  return {
    ...r,
    trace_id: typeof r.trace_id === 'string' && TRACE_ID_RE.test(r.trace_id) ? r.trace_id : (item?.trace_id ?? null),
    item: item && { kind: item.kind, number: item.number, source: item.source, key: item.key },
    spans: Array.isArray(r.spans) ? r.spans : [],
    events: Array.isArray(r.events) ? r.events : [],
    spans_overflow: r.spans_overflow ?? { count: 0, events: 0 },
    otlp: r.otlp && Array.isArray(r.otlp.resourceSpans) ? r.otlp : null,
  };
}

/** metrics/traces/<trace_id>.json: the runs of one work item's trace (ADR-0041). */
export function traceIndexPath(traceId) {
  return TRACE_ID_RE.test(String(traceId)) ? `metrics/traces/${traceId}.json` : null;
}

/**
 * The trace index with this record's run added (ADR-0041): one entry per run_id (first wins, like the
 * record), sorted by start time — runners' clocks differ, so lead time (first start → last end) is
 * the only cross-run duration it gives. Past MAX_INDEX_RUNS a run is counted in `runs_overflow`.
 * `existing` is the stored index (or null). Returns `{ index, changed }`; throws on an index that is
 * not a trace index of this trace (the caller leaves it untouched).
 */
export function appendTraceIndex(existing, record, path) {
  const rec = readRunRecord(record);
  if (!rec?.trace_id || !rec.run_id) throw new Error('record has no trace id or run id');
  if (existing != null && (typeof existing !== 'object' || existing.trace_id !== rec.trace_id || !Array.isArray(existing.runs))) {
    throw new Error('not a trace index of this trace');
  }
  const runs = existing ? existing.runs.filter((r) => r && typeof r === 'object') : [];
  let overflow = int(existing?.runs_overflow) ?? 0;
  const known = runs.some((r) => r.run_id === rec.run_id);
  if (!known) {
    if (runs.length >= MAX_INDEX_RUNS) overflow += 1;
    else {
      runs.push({
        run_id: rec.run_id,
        record_path: path,
        workflow: rec.envelope?.workflow ?? null,
        event_name: rec.envelope?.event_name ?? null,
        root_span_id: rec.root_span_id ?? null,
        started_at: rec.started_at ?? null,
        completed_at: rec.completed_at ?? null,
        outcome: rec.outcome ?? null,
      });
    }
  }
  runs.sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')) || String(a.run_id).localeCompare(String(b.run_id)));
  const starts = runs.map((r) => r.started_at).filter(Boolean).sort();
  const ends = runs.map((r) => r.completed_at).filter(Boolean).sort();
  const first = starts[0] ?? null;
  const last = ends.at(-1) ?? null;
  return {
    changed: !known,
    index: {
      schema_version: TRACE_INDEX_SCHEMA_VERSION,
      trace_id: rec.trace_id,
      item: rec.item,
      first_started_at: first,
      last_completed_at: last,
      lead_time_ms: first && last && last >= first ? Date.parse(last) - Date.parse(first) : null,
      runs,
      runs_overflow: overflow,
    },
  };
}

/** metrics/runs/<YYYY-MM>/<run_id>-<attempt>.json, month of the run start (UTC), else of `now`. */
export function recordPath(record, now = new Date()) {
  const month = (record?.started_at ?? now.toISOString()).slice(0, 7);
  return `metrics/runs/${month}/${record.run_id}.json`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Appends `newLines` to metrics/runs.jsonl and adds `record` (when not already stored for this
 * run_id + attempt) in ONE commit on the `metrics` branch (Git Data API: tree with base_tree,
 * commit, fast-forward ref update). A lost race (ref moved: 409/422) retries from a fresh read,
 * up to `attempts` times with 2^i s backoff — the retry of the former Contents API step.
 *
 * `request(method, path, body?, { raw }?)` resolves `{ status, json?, text? }` and never throws for
 * an HTTP status. Returns `{ committed, skipped, reason?, sha?, recordPath?, indexPath?, indexStatus? }`;
 * `indexPath` is the trace index written in the commit (ADR-0041), `indexStatus` one of
 * `updated` / `unchanged` (run already listed) / `unreadable` (stored index left untouched).
 */
export async function commitRunRecord({ request, repository, message, newLines = '', record = null, attempts = 3, wait = sleep, now = new Date() }) {
  const lines = String(newLines).trim();
  const repo = `/repos/${repository}`;
  const path = record?.run_id ? recordPath(record, now) : null;
  if (!lines && !path) return { committed: false, skipped: true, reason: 'nothing to commit' };

  // One read-modify-write pass: a result to return, or { retry: reason }.
  async function attemptOnce() {
    const ref = await request('GET', `${repo}/git/ref/heads/${METRICS_BRANCH}`);
    if (ref.status === 404) return { committed: false, skipped: false, reason: `branch ${METRICS_BRANCH} not found` };
    const parent = ref.json?.object?.sha;
    if (ref.status !== 200 || !parent) return { retry: `cannot read ${METRICS_BRANCH} ref (${ref.status})` };
    const commit = await request('GET', `${repo}/git/commits/${parent}`);
    const baseTree = commit.json?.tree?.sha;
    if (commit.status !== 200 || !baseTree) return { retry: `cannot read ${METRICS_BRANCH} commit (${commit.status})` };

    const tree = [];
    if (lines) {
      const current = await request('GET', `${repo}/contents/${RUNS_JSONL_PATH}?ref=${parent}`, undefined, { raw: true });
      if (current.status !== 200 && current.status !== 404) return { retry: `cannot read ${RUNS_JSONL_PATH} (${current.status})` };
      const existing = current.status === 200 ? String(current.text ?? '') : '';
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      tree.push({ path: RUNS_JSONL_PATH, mode: '100644', type: 'blob', content: `${existing}${sep}${lines}\n` });
    }
    let stored = false;
    let indexPath = null;
    let indexStatus = null;
    if (path) {
      // ADR-0013 dedup: the first record written for a run_id + attempt wins.
      const found = await request('GET', `${repo}/contents/${path}?ref=${parent}`);
      if (found.status !== 200 && found.status !== 404) return { retry: `cannot read ${path} (${found.status})` };
      stored = found.status === 200;
      if (!stored) tree.push({ path, mode: '100644', type: 'blob', content: `${JSON.stringify(record)}\n` });
      // ADR-0041: the trace index of the record's work item, in the same commit, same retry and dedup.
      const candidate = traceIndexPath(record.trace_id);
      if (candidate) {
        const current = await request('GET', `${repo}/contents/${candidate}?ref=${parent}`, undefined, { raw: true });
        if (current.status !== 200 && current.status !== 404) return { retry: `cannot read ${candidate} (${current.status})` };
        try {
          const existing = current.status === 200 ? JSON.parse(String(current.text ?? '')) : null;
          const { index, changed } = appendTraceIndex(existing, record, path);
          indexStatus = changed ? 'updated' : 'unchanged';
          if (changed) {
            indexPath = candidate;
            tree.push({ path: candidate, mode: '100644', type: 'blob', content: `${JSON.stringify(index)}\n` });
          }
        } catch {
          // An unreadable index is left as is (never rebuilt from one run): the record still lands.
          indexStatus = 'unreadable';
        }
      }
    }
    if (tree.length === 0) return { committed: false, skipped: true, reason: 'record already stored', recordPath: path, ...(indexStatus && { indexStatus }) };

    const newTree = await request('POST', `${repo}/git/trees`, { base_tree: baseTree, tree });
    if (newTree.status !== 201) return { retry: `tree create failed (${newTree.status})` };
    const newCommit = await request('POST', `${repo}/git/commits`, { message, tree: newTree.json.sha, parents: [parent] });
    if (newCommit.status !== 201) return { retry: `commit create failed (${newCommit.status})` };
    // force: false — a ref that moved since the read (concurrent run) is rejected, and the pass retries.
    const update = await request('PATCH', `${repo}/git/refs/heads/${METRICS_BRANCH}`, { sha: newCommit.json.sha, force: false });
    if (update.status !== 200) return { retry: `ref update failed (${update.status})` };
    return { committed: true, skipped: false, sha: newCommit.json.sha, recordPath: stored ? null : path, ...(indexPath && { indexPath }), ...(indexStatus && { indexStatus }) };
  }

  let reason = null;
  for (let i = 1; i <= attempts; i++) {
    const result = await attemptOnce();
    if (!result.retry) return result;
    reason = result.retry;
    if (i < attempts) await wait(2 ** i * 1000);
  }
  return { committed: false, skipped: false, reason };
}
