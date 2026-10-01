import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function safeStringify(obj) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({ _serializationError: '[unserializable data]' });
  }
}

/**
 * Emit one structured JSON log line to stderr.
 * Safe to call from any context — never throws.
 */
export function log({ stage, event, level = 'info', duration_ms = null, meta = {} }) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      run_id: process.env.GITHUB_RUN_ID ?? 'local',
      stage,
      event,
      level,
      duration_ms,
      meta,
    };
    process.stderr.write(safeStringify(entry) + '\n');

    if (level === 'error' && process.env.GITHUB_ACTIONS === 'true') {
      const file = meta.file ?? '';
      const lineStr = meta.line != null ? `,line=${meta.line}` : '';
      const loc = file ? ` file=${file}${lineStr}` : '';
      process.stderr.write(`::error${loc}::${stage}/${event}: ${safeStringify(meta)}\n`);
    }
  } catch {
    // never propagate observability failures into business logic
  }
}

/**
 * Create a run tracer that manages a JSON trace file at
 * <traceDir>/<runId>.json.  Spans are appended incrementally on
 * each startSpan / endSpan call so the file is always readable
 * mid-run.  Call finalize() at the very end of the run to record
 * completed_at and the overall outcome.
 */
export function createTracer({ runId, issueNumber = null, traceDir }) {
  const spanStartTimes = {};
  let traceStartedAt = null;
  const tracePath = path.join(traceDir, `${runId}.json`);

  function ensureDirSync() {
    try { fs.mkdirSync(traceDir, { recursive: true }); } catch { /* already exists */ }
  }

  function readTrace() {
    try { return JSON.parse(fs.readFileSync(tracePath, 'utf8')); } catch { return null; }
  }

  function writeTrace(data) {
    try {
      ensureDirSync();
      fs.writeFileSync(tracePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      log({ stage: 'observability', event: 'trace_write_failed', level: 'warn', meta: { error: err.message } });
    }
  }

  function ensureTrace() {
    const now = new Date().toISOString();
    if (!traceStartedAt) traceStartedAt = now;
    return readTrace() ?? {
      run_id: runId,
      issue_number: issueNumber,
      started_at: traceStartedAt,
      completed_at: null,
      outcome: null,
      spans: [],
    };
  }

  return {
    startSpan(stage, meta = {}) {
      try {
        const now = new Date().toISOString();
        if (!traceStartedAt) traceStartedAt = now;
        spanStartTimes[stage] = Date.now();

        const trace = ensureTrace();
        const idx = trace.spans.findIndex(s => s.stage === stage);
        const span = { stage, started_at: now, completed_at: null, duration_ms: null, outcome: null, meta };
        if (idx >= 0) trace.spans[idx] = span;
        else trace.spans.push(span);
        writeTrace(trace);
      } catch (err) {
        log({ stage: 'observability', event: 'start_span_failed', level: 'warn', meta: { error: err.message, stage } });
      }
    },

    endSpan(stage, { outcome = 'success', meta: extraMeta = {} } = {}) {
      try {
        const completedAt = new Date().toISOString();
        const startMs = spanStartTimes[stage];
        const duration_ms = startMs != null ? Date.now() - startMs : null;

        const trace = ensureTrace();
        const idx = trace.spans.findIndex(s => s.stage === stage);
        const existing = idx >= 0 ? trace.spans[idx] : null;
        const span = {
          stage,
          started_at: existing?.started_at ?? completedAt,
          completed_at: completedAt,
          duration_ms,
          outcome,
          meta: { ...(existing?.meta ?? {}), ...extraMeta },
        };
        if (idx >= 0) trace.spans[idx] = span;
        else trace.spans.push(span);
        writeTrace(trace);
      } catch (err) {
        log({ stage: 'observability', event: 'end_span_failed', level: 'warn', meta: { error: err.message, stage } });
      }
    },

    async finalize(outcome) {
      try {
        const now = new Date().toISOString();
        await fsPromises.mkdir(traceDir, { recursive: true });
        const trace = readTrace() ?? {
          run_id: runId,
          issue_number: issueNumber,
          started_at: traceStartedAt ?? now,
          completed_at: null,
          outcome: null,
          spans: [],
        };
        trace.completed_at = now;
        trace.outcome = outcome;
        await fsPromises.writeFile(tracePath, JSON.stringify(trace, null, 2), 'utf8');
      } catch (err) {
        log({ stage: 'observability', event: 'trace_finalize_failed', level: 'warn', meta: { error: err.message } });
      }
    },
  };
}
