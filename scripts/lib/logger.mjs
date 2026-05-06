export function safeStringify(obj) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch (e) {
    return JSON.stringify({ _serializationError: '[unserializable data]' });
  }
}

function normalizePayload(data) {
  if (data !== null && typeof data === 'object') return data;
  return { data };
}

let logContext = {};

export function setLogContext(context) {
  logContext = context;
}

export function log(msg, data = {}) {
  const context = { ...logContext, ...normalizePayload(data) };
  console.log(safeStringify({ level: 'info', msg, ...context }));
}

export function error(msg, data = {}) {
  const context = { ...logContext, ...normalizePayload(data) };
  console.error(safeStringify({ level: 'error', msg, ...context }));
}

let startTime = {};

export function logStart(step) {
  startTime[step] = performance.now();
}

export function logEnd(step, result) {
  const endTime = performance.now();
  const durationMs = startTime[step] ? endTime - startTime[step] : null;
  const context = { ...logContext, step, result, durationMs };
  console.log(safeStringify({ level: 'info', msg: 'step_end', ...context }));
}

export function logSummary({ success, stepsCompleted, errors }) {
  const context = { ...logContext, success, stepsCompleted, errors };
  console.log(safeStringify({ level: 'info', msg: 'run_summary', ...context }));
}
