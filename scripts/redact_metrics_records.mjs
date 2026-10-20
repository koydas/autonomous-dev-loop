#!/usr/bin/env node
/**
 * One-shot cleanup of the `metrics` branch (ADR-0040 amendment, audit F01/F06/F20): re-applies the
 * current redaction (redactStoredRecord) to every metrics/runs/**\/*.json record and the current
 * sanitizer (redactMetricsLine) to every metrics/runs.jsonl line of a local checkout of that branch.
 *
 *   node scripts/redact_metrics_records.mjs <metrics-checkout-dir> [--write]
 *
 * Dry run by default: prints each file that would change and its number of redacted strings, never
 * the content. --write rewrites those files in place. No git and no network operation: the operator
 * commits and pushes (docs/runbook.md). Symlinks and unreadable files are skipped and listed.
 */
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactStoredRecord, redactMetricsLine, countRedactedStrings, RUNS_JSONL_PATH } from './lib/run_record.mjs';

const RUNS_DIR = 'metrics/runs';

/** Record files under <dir>/metrics/runs, relative POSIX paths, sorted; symlinks are not followed. */
export function findRecordFiles(dir) {
  const root = path.join(dir, RUNS_DIR);
  let entries;
  try {
    entries = readdirSync(root, { recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .map((p) => path.posix.join(RUNS_DIR, String(p).split(path.sep).join('/')))
    .filter((p) => p.endsWith('.json'))
    .sort();
}

/** One stored record (file text) → `{ content, redacted }`; throws on JSON that is not a run record. */
export function redactRecordText(text) {
  const before = JSON.parse(text);
  const after = redactStoredRecord(before);
  if (!after) throw new Error('not a run record (unknown schema_version)');
  // Unchanged JSON keeps the file as is, whatever its formatting.
  if (JSON.stringify(after) === JSON.stringify(before)) return { content: text, redacted: 0 };
  return { content: `${JSON.stringify(after)}\n`, redacted: countRedactedStrings(before, after) };
}

/** metrics/runs.jsonl text → `{ content, redacted, invalid }`; a line that is not JSON is kept as is. */
export function redactRunsJsonlText(text) {
  let redacted = 0;
  let invalid = 0;
  const lines = String(text).split('\n').map((line) => {
    if (!line.trim()) return line;
    let before;
    try {
      before = JSON.parse(line);
    } catch {
      invalid += 1;
      return line;
    }
    const after = redactMetricsLine(before);
    const n = countRedactedStrings(before, after);
    if (n === 0) return line;
    redacted += n;
    return JSON.stringify(after);
  });
  return { content: lines.join('\n'), redacted, invalid };
}

/**
 * Re-redacts a metrics checkout. Returns `{ changed: [{ path, redacted }], unreadable: [{ path, reason }],
 * scanned, redacted, invalidLines }`; writes the changed files only with `write: true`.
 */
export function redactMetricsDir(dir, { write = false } = {}) {
  const changed = [];
  const unreadable = [];
  let invalidLines = 0;
  const targets = [...findRecordFiles(dir).map((p) => ({ path: p, jsonl: false })), { path: RUNS_JSONL_PATH, jsonl: true }];
  let scanned = 0;
  for (const target of targets) {
    const file = path.join(dir, target.path);
    let text;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) {
        unreadable.push({ path: target.path, reason: stat.isSymbolicLink() ? 'symlink' : 'not a regular file' });
        continue;
      }
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' && target.jsonl) continue;
      unreadable.push({ path: target.path, reason: err.code ?? 'read failed' });
      continue;
    }
    scanned += 1;
    let result;
    try {
      result = target.jsonl ? redactRunsJsonlText(text) : redactRecordText(text);
    } catch (err) {
      unreadable.push({ path: target.path, reason: err instanceof SyntaxError ? 'invalid JSON' : err.message });
      continue;
    }
    invalidLines += result.invalid ?? 0;
    if (result.content === text) continue;
    changed.push({ path: target.path, redacted: result.redacted });
    if (write) writeFileSync(file, result.content, 'utf8');
  }
  return { changed, unreadable, scanned, redacted: changed.reduce((n, c) => n + c.redacted, 0), invalidLines };
}

/** CLI arguments → `{ dir, write }`; throws a usage error. */
export function parseArgs(argv) {
  const write = argv.includes('--write');
  const rest = argv.filter((a) => a !== '--write');
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    throw new Error('Usage: node scripts/redact_metrics_records.mjs <metrics-checkout-dir> [--write]');
  }
  return { dir: rest[0], write };
}

export function main(argv = process.argv.slice(2), out = console.log) {
  const { dir, write } = parseArgs(argv);
  const report = redactMetricsDir(dir, { write });
  for (const c of report.changed) out(`${write ? 'rewritten' : 'would rewrite'} ${c.path} (${c.redacted} redacted string(s))`);
  for (const u of report.unreadable) out(`skipped ${u.path} (${u.reason})`);
  if (report.invalidLines) out(`${RUNS_JSONL_PATH}: ${report.invalidLines} line(s) not JSON, kept as is`);
  out(`${report.scanned} file(s) scanned, ${report.changed.length} ${write ? 'rewritten' : 'to rewrite'}, ${report.redacted} redacted string(s)${write ? '' : ' (dry run: pass --write to rewrite)'}.`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
