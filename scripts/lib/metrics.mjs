import fs from 'node:fs/promises';
import path from 'node:path';

const METRICS_DIR = path.resolve('./metrics');
const METRICS_FILE = path.join(METRICS_DIR, 'runs.jsonl');

export function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4);
}

export async function appendMetric(record) {
  await fs.mkdir(METRICS_DIR, { recursive: true });
  await fs.appendFile(METRICS_FILE, JSON.stringify(record) + '\n', 'utf8');
}

export async function readMetrics() {
  try {
    const raw = await fs.readFile(METRICS_FILE, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
