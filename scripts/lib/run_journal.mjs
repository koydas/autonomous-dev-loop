// Run journal (ADR-0040): every observability event of the run, kept in the trace file next to the
// spans, plus a run envelope (workflow, run, trigger, actor, issue/PR, head SHA, LLM calls, links).
// observability.mjs feeds it: log() → recordEvent(), createTracer() → attachJournal(). Never throws.
import fs from 'node:fs';
import path from 'node:path';
import { scrubString, secretValues } from './run_record.mjs';

export const TRACE_SCHEMA_VERSION = 1;
export const JOURNAL_MAX_EVENTS = 500;
export const JOURNAL_MAX_BYTES = 256 * 1024;
// A single event over this size keeps its name, level and timing; its meta is replaced by its size.
export const EVENT_MAX_BYTES = 8 * 1024;

const state = {
  sink: null, // { tracePath, skeleton, base: { events, overflow }, payload, secrets }
  events: [],
  bytes: 0,
  overflow: { count: 0, bytes: 0 },
  flushing: false,
  failureReported: false,
};

const toInt = (v) => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Scrubbed in the producing process, whose env holds the step's secrets (LLM keys): the
// "Commit metrics" step that runs redactTrace() does not have them (ADR-0040 §4).
function scrubMeta(value, secrets) {
  if (typeof value === 'string') return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrubMeta(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubMeta(v, secrets)]));
  }
  return value;
}

// This process's non-public env values, computed once per tracer (the env does not change during a run).
const processSecrets = () => state.sink?.secrets ?? secretValues(process.env);

// The run this process belongs to, as buildEnvelope() records it.
const currentRun = (env) => ({ runId: env.GITHUB_RUN_ID || null, runAttempt: toInt(env.GITHUB_RUN_ATTEMPT) ?? 1 });

const firstMeta = (events, key) => {
  for (const e of events) if (e?.meta?.[key] != null) return e.meta[key];
  return null;
};

/**
 * Run envelope derived from the Actions environment, the event payload and the journal.
 * Numbers missing from the payload (a push-triggered review) are taken from the first event
 * meta that carries them (`prNumber`, `issueNumber`, `headSha`).
 */
export function buildEnvelope(env = {}, payload = null, events = []) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const server = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const repository = env.GITHUB_REPOSITORY || null;
  const runId = env.GITHUB_RUN_ID || null;
  const runAttempt = toInt(env.GITHUB_RUN_ATTEMPT) ?? 1;
  const isPrIssue = Boolean(p.issue?.pull_request);
  const prNumber = toInt(p.pull_request?.number ?? (isPrIssue ? p.issue.number : null) ?? firstMeta(events, 'prNumber'));
  const issueNumber = toInt((!isPrIssue ? p.issue?.number : null) ?? p.inputs?.issue_number ?? firstMeta(events, 'issueNumber'));
  const headSha = p.pull_request?.head?.sha ?? (typeof p.after === 'string' ? p.after : null) ?? firstMeta(events, 'headSha');
  const actor = env.GITHUB_ACTOR || null;
  const actorType = p.sender?.type === 'Bot' || /\[bot\]$/.test(actor ?? '') ? 'bot' : actor ? 'human' : null;
  const repoUrl = repository ? `${server}/${repository}` : null;
  return {
    workflow: env.GITHUB_WORKFLOW || null,
    run_id: runId,
    run_attempt: runAttempt,
    event_name: env.GITHUB_EVENT_NAME || null,
    actor,
    actor_type: actorType,
    repository,
    issue_number: issueNumber,
    pr_number: prNumber,
    head_sha: typeof headSha === 'string' ? headSha : null,
    run_url: repoUrl && runId ? `${repoUrl}/actions/runs/${runId}/attempts/${runAttempt}` : null,
    issue_url: repoUrl && issueNumber ? `${repoUrl}/issues/${issueNumber}` : null,
    pr_url: repoUrl && prNumber ? `${repoUrl}/pull/${prNumber}` : null,
    links: events.filter((e) => typeof e?.meta?.url === 'string').map((e) => ({ event: e.event, url: e.meta.url })),
    llm_calls: events
      .filter((e) => e?.event === 'llm_call' || e?.event === 'llm_call_failed')
      .map((e) => ({
        stage: e.stage ?? null,
        provider: e.meta?.provider ?? null,
        model: e.meta?.model ?? null,
        fallback: e.meta?.fallback === true,
        outcome: e.event === 'llm_call' ? 'answered' : 'failed',
        duration_ms: e.duration_ms ?? null,
      })),
  };
}

function readPayload(env) {
  try {
    const raw = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    // Only the fields the envelope reads are kept in memory.
    return {
      pull_request: raw?.pull_request ? { number: raw.pull_request.number, head: { sha: raw.pull_request.head?.sha } } : undefined,
      issue: raw?.issue ? { number: raw.issue.number, pull_request: raw.issue.pull_request ? true : undefined } : undefined,
      inputs: raw?.inputs ? { issue_number: raw.inputs.issue_number } : undefined,
      after: raw?.after,
      sender: raw?.sender ? { type: raw.sender.type } : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * The trace with the journal merged in: schema version, envelope, events and overflow counters.
 * Span meta is scrubbed here like event meta: every tracer write goes through merge().
 */
function merge(trace) {
  const base = state.sink?.base ?? { events: [], overflow: { count: 0, bytes: 0 } };
  const events = [...base.events, ...state.events];
  const secrets = processSecrets();
  return {
    ...trace,
    ...(Array.isArray(trace?.spans) && {
      spans: trace.spans.map((s) => (s && typeof s === 'object' ? { ...s, meta: scrubMeta(s.meta, secrets) } : s)),
    }),
    schema_version: TRACE_SCHEMA_VERSION,
    envelope: buildEnvelope(process.env, state.sink?.payload ?? null, events),
    events,
    events_overflow: {
      count: base.overflow.count + state.overflow.count,
      bytes: base.overflow.bytes + state.overflow.bytes,
    },
  };
}

function flush() {
  if (!state.sink || state.flushing) return null;
  state.flushing = true;
  try {
    let trace;
    try {
      trace = JSON.parse(fs.readFileSync(state.sink.tracePath, 'utf8'));
    } catch (err) {
      // Unparsable: a tracer write is in flight; the next tracer write carries these events.
      if (err instanceof SyntaxError) return null;
      if (err.code !== 'ENOENT') throw err;
      trace = state.sink.skeleton();
    }
    fs.writeFileSync(state.sink.tracePath, JSON.stringify(merge(trace), null, 2), 'utf8');
    return null;
  } catch (err) {
    // A missing directory is not an error here: the first span write creates it.
    if (err.code === 'ENOENT' || state.failureReported) return null;
    state.failureReported = true;
    return err;
  } finally {
    state.flushing = false;
  }
}

/**
 * Records one serialized log() line, its meta strings scrubbed of this process's non-public env
 * values and credential shapes (the stderr line is unchanged). Over JOURNAL_MAX_EVENTS /
 * JOURNAL_MAX_BYTES (this process and the processes before it in the same trace) the event is
 * counted in `events_overflow`, not kept;
 * the counter reaches the file with the next tracer write.
 * Returns the first flush error of the process (for one `trace_write_failed` warn), else null.
 */
export function recordEvent(line) {
  try {
    let event = JSON.parse(line);
    event = { ...event, meta: scrubMeta(event.meta, processSecrets()) };
    let bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (bytes > EVENT_MAX_BYTES) {
      event = { ...event, meta: { _meta_dropped_bytes: bytes } };
      bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    }
    const base = state.sink?.base ?? { events: [], bytes: 0 };
    const count = base.events.length + state.events.length;
    const total = (base.bytes ?? 0) + state.bytes;
    if (count >= JOURNAL_MAX_EVENTS || total + bytes > JOURNAL_MAX_BYTES) {
      // Counted only: the next tracer write (endSpan, finalize) persists the counter, so a long run
      // (evals) does not rewrite a full trace file per event once the journal is full.
      state.overflow.count += 1;
      state.overflow.bytes += bytes;
      return null;
    }
    state.events.push(event);
    state.bytes += bytes;
    return flush();
  } catch {
    return null;
  }
}

/**
 * Points the journal at a trace file. Events logged before (in this process) are kept; a trace
 * already on disk contributes its events as the base only when its envelope names this run and
 * attempt (an earlier step of the same job). Any other trace at that path — e.g. a file committed
 * in the checked-out PR head — is replaced by a fresh one, so it can neither inject events nor spans.
 * Returns `merge(trace)` for the tracer's own writes.
 */
export function attachJournal({ tracePath, skeleton }) {
  try {
    if (state.sink && state.sink.tracePath !== tracePath) {
      state.events = [];
      state.bytes = 0;
      state.overflow = { count: 0, bytes: 0 };
    }
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(tracePath, 'utf8')); } catch { /* no trace yet */ }
    const run = currentRun(process.env);
    const foreign = existing !== null && (
      typeof existing !== 'object'
      || (existing.envelope?.run_id ?? null) !== run.runId
      || (toInt(existing.envelope?.run_attempt) ?? 1) !== run.runAttempt
    );
    if (foreign) existing = null;
    const baseEvents = Array.isArray(existing?.events) ? existing.events : [];
    state.sink = {
      tracePath,
      skeleton,
      payload: readPayload(process.env),
      secrets: secretValues(process.env),
      base: {
        events: baseEvents,
        bytes: baseEvents.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), 'utf8'), 0),
        overflow: {
          count: Number(existing?.events_overflow?.count) || 0,
          bytes: Number(existing?.events_overflow?.bytes) || 0,
        },
      },
    };
    try { fs.mkdirSync(path.dirname(tracePath), { recursive: true }); } catch { /* reported on write */ }
    if (foreign) fs.writeFileSync(tracePath, JSON.stringify(merge(skeleton()), null, 2), 'utf8');
  } catch {
    // never propagate observability failures into business logic
  }
  return { merge };
}
