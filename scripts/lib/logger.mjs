export function log(msg, data = {}) {
  console.log(JSON.stringify({ level: 'info', msg, ...data }));
}

export function error(msg, data = {}) {
  console.error(JSON.stringify({ level: 'error', msg, ...data }));
}
