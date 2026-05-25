import fs from 'node:fs/promises';
import path from 'node:path';

const CHECKPOINT_BASE = path.resolve('./checkpoints');

export async function writeCheckpoint(runId, step, data) {
  const dir = path.join(CHECKPOINT_BASE, String(runId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${step}.json`),
    JSON.stringify({ step, timestamp: new Date().toISOString(), data }, null, 2),
    'utf8',
  );
}

export async function readCheckpoint(runId, step) {
  const file = path.join(CHECKPOINT_BASE, String(runId), `${step}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
