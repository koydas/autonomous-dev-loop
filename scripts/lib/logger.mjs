function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    const { level, msg } = obj;
    return JSON.stringify({ level, msg, _serializationError: '[unserializable data]' });
  }
}

export function log(msg, data = {}) {
  console.log(safeStringify({ level: 'info', msg, ...data }));
}

export function error(msg, data = {}) {
  console.error(safeStringify({ level: 'error', msg, ...data }));
}
