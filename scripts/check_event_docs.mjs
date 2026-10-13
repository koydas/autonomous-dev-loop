#!/usr/bin/env node
/**
 * Fails when a script emits an observability event that has no row in docs/observability.md (#198).
 * Scans scripts/**\/*.mjs from the working directory, scripts/tests/ excluded.
 * Called by .github/workflows/test.yml.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findUndocumentedEvents } from './lib/event_docs.mjs';

const DOC = 'docs/observability.md';
const root = process.cwd();

let markdown;
try {
  markdown = readFileSync(path.join(root, DOC), 'utf8');
} catch (err) {
  console.error(`Event docs check failed: cannot read ${DOC} (${err.message}).`);
  process.exit(1);
}

const sources = readdirSync(path.join(root, 'scripts'), { recursive: true })
  .map((p) => path.posix.join('scripts', p.split(path.sep).join('/')))
  .filter((p) => p.endsWith('.mjs') && !p.startsWith('scripts/tests/'))
  .sort()
  .map((p) => ({ path: p, content: readFileSync(path.join(root, p), 'utf8') }));

const missing = findUndocumentedEvents(sources, markdown);
if (missing.length > 0) {
  console.error(
    `\nEvent docs check failed: ${missing.length} event(s) emitted without a row in ${DOC}:\n` +
    missing.map(({ event, files }) => `  - ${event}  (${files.join(', ')})`).join('\n') +
    `\n\nAdd a row (| \`<event>\` | <level> | <duration_ms> | <meta> |) under the stage's table in ${DOC}.\n`,
  );
  process.exit(1);
}

console.log(`Event docs check passed (${sources.length} scripts scanned).`);
