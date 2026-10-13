// Core logic of the observability event-docs check (#198), extracted for unit testability.
// docs/observability.md is the schema reference of the events (ADR-0018): every event name a
// script emits must have a row there.

// `event: '<name>'` with a literal name. A template literal with `${…}` (e.g. `${stage}.error`)
// is not matched: dynamic names are out of scope and must be documented by hand.
const EMITTED_RE = /\bevent:\s*(['"`])([a-z0-9_]+(?:\.[a-z0-9_]+)*)\1/g;
// A table row whose first cell is a backticked name: | `review.verdict` | info | …
const DOCUMENTED_RE = /^\|\s*`([a-z0-9_]+(?:\.[a-z0-9_]+)*)`\s*\|/gm;

/** Literal event names emitted in a source file, unique, in order of first appearance. */
export function extractEmittedEvents(source) {
  return [...new Set([...String(source ?? '').matchAll(EMITTED_RE)].map((m) => m[2]))];
}

/** Event names documented in the first cell of a Markdown table row. */
export function extractDocumentedEvents(markdown) {
  return new Set([...String(markdown ?? '').matchAll(DOCUMENTED_RE)].map((m) => m[1]));
}

/**
 * Emitted events with no row in the doc, sorted by name, each with the files that emit it.
 * `sources` is `[{ path, content }]`.
 * @returns {{ event: string, files: string[] }[]}
 */
export function findUndocumentedEvents(sources, markdown) {
  const documented = extractDocumentedEvents(markdown);
  const missing = new Map();
  for (const { path, content } of sources) {
    for (const event of extractEmittedEvents(content)) {
      if (documented.has(event)) continue;
      if (!missing.has(event)) missing.set(event, []);
      missing.get(event).push(path);
    }
  }
  return [...missing.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([event, files]) => ({ event, files }));
}
