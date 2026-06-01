import fs from 'node:fs/promises';
import path from 'node:path';

function getMetricsFile() {
  return process.env.METRICS_FILE ?? path.resolve('./metrics/runs.jsonl');
}

export function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4);
}

export async function appendMetric(record) {
  const file = getMetricsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

export async function readMetrics() {
  const file = getMetricsFile();
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function deduplicateMetrics(records) {
  const seen = new Set();
  return records.filter((r) => {
    if (r.run_id == null) return true;
    if (seen.has(r.run_id)) return false;
    seen.add(r.run_id);
    return true;
  });
}
