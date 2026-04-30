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

export function log(msg, data = {}) {
  console.log(safeStringify({ level: 'info', msg, ...data }));
}

export function error(msg, data = {}) {
  console.error(safeStringify({ level: 'error', msg, ...data }));
}