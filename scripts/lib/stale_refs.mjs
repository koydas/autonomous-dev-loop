import { log } from './observability.mjs';

// Stale-reference check (ADR-0034): text a PR removes that is still quoted, near-verbatim, in the
// repo's docs, skills, prompts or AGENTS.md. Deterministic (text search, no LLM); the result is
// informational evidence for the reviewer and never changes the verdict on its own.

export const MIN_MATCH_CHARS = 60;
export const MAX_REPORTED_HITS = 5;
export const MAX_QUOTED_CHARS = 160;

const SEARCHED_PATHS = [/^docs\/.+\.md$/, /^\.claude\/skills\/.+\.md$/, /^prompts\/[^/]+\.md$/, /^AGENTS\.md$/];
const HISTORICAL = /(^|\/)CHANGELOG\.md$/;
// A Superseded or Deprecated ADR quotes the replaced rule on purpose, like CHANGELOG.md.
const INACTIVE_ADR = /^- \*\*Status:\*\*\s*(superseded|deprecated)\b/im;
const ADR_PATH = /^docs\/adr\/\d{4}-[^/]+\.md$/;

/** Markdown-insensitive form used on both sides of the search: no backticks, `*`, `_`; one space; lowercase. */
export function normalizeText(text) {
  return String(text ?? '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isSearchedPath(p) {
  return SEARCHED_PATHS.some((re) => re.test(p)) && !HISTORICAL.test(p);
}

/**
 * Parses a unified diff into removed blocks (consecutive `-` lines of one hunk) and the added text
 * per file. Paths come from `diff --git a/X b/Y`; a block's `line` is its first old-file line.
 * @returns {{ removed: Array<{ file: string, line: number, text: string }>, added: Map<string, string[]>, paths: Set<string> }}
 */
export function parseDiffBlocks(rawDiff) {
  const removed = [];
  const added = new Map();
  const paths = new Set();
  let file = null;
  let newFile = null;
  let oldLine = 0;
  let inHunk = false;
  let block = null;
  const flush = () => {
    if (block) removed.push(block);
    block = null;
  };
  for (const line of String(rawDiff ?? '').split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      flush();
      [, file, newFile] = header;
      paths.add(file).add(newFile);
      inHunk = false;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)/);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      inHunk = file !== null;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('-')) {
      block ??= { file, line: oldLine, text: '' };
      block.text += `${block.text ? '\n' : ''}${line.slice(1)}`;
      oldLine++;
      continue;
    }
    flush();
    if (line.startsWith('+')) {
      if (!added.has(newFile)) added.set(newFile, []);
      added.get(newFile).push(line.slice(1));
    } else if (line.startsWith(' ')) {
      oldLine++;
    }
  }
  flush();
  return { removed, added, paths };
}

// Every MIN_MATCH_CHARS-long window of each block, so a doc quoting part of a block still matches.
function indexWindows(blocks) {
  const index = new Map();
  blocks.forEach((b, i) => {
    for (let at = 0; at + MIN_MATCH_CHARS <= b.norm.length; at++) {
      const gram = b.norm.slice(at, at + MIN_MATCH_CHARS);
      if (!index.has(gram)) index.set(gram, new Set());
      index.get(gram).add(i);
    }
  });
  return index;
}

// Normalized content of a file, with the 1-based source line of every normalized offset.
function normalizeLines(content) {
  let norm = '';
  const starts = [];
  content.split('\n').forEach((raw, i) => {
    const n = normalizeText(raw);
    if (!n) return;
    if (norm) norm += ' ';
    starts.push([norm.length, i + 1]);
    norm += n;
  });
  const lineAt = (offset) => {
    let line = 1;
    for (const [start, l] of starts) {
      if (start > offset) break;
      line = l;
    }
    return line;
  };
  return { norm, lineAt };
}

// Per block index: start offset of its longest matched run in `norm` (consecutive window hits).
function scan(norm, index) {
  const best = new Map();
  const open = new Map(); // block index -> [runStart, lastHitOffset]
  for (let at = 0; at + MIN_MATCH_CHARS <= norm.length; at++) {
    for (const i of index.get(norm.slice(at, at + MIN_MATCH_CHARS)) ?? []) {
      const run = open.get(i);
      if (run && run[1] === at - 1) run[1] = at;
      else open.set(i, [at, at]);
      const [start, end] = open.get(i);
      const prev = best.get(i);
      if (!prev || end - start > prev.length) best.set(i, { at: start, length: end - start });
    }
  }
  return new Map([...best].map(([i, { at }]) => [i, at]));
}

/**
 * Finds removed text (blocks of ≥ 60 normalized chars) still present in docs/**\/*.md,
 * .claude/skills/**\/*.md, prompts/*.md and AGENTS.md of the PR tree. Excluded: CHANGELOG.md and
 * Superseded / Deprecated ADRs (historical by design), the file the text was removed from, and any
 * file the diff re-adds it to.
 * `listFiles()` returns repo-relative paths, `readFile(path)` their content (both injected).
 * A listing or read error must not abort the review: it logs a `review.stale_refs_error` warn
 * event and returns [].
 * @returns {Array<{ removedText: string, file: string, line: number, foundIn: Array<{ path: string, line: number }> }>}
 */
export function findStaleReferences({ rawDiff, listFiles, readFile, logFn = log }) {
  const { removed, added } = parseDiffBlocks(rawDiff);
  const blocks = removed
    .map((b) => ({ ...b, norm: normalizeText(b.text) }))
    .filter((b) => b.norm.length >= MIN_MATCH_CHARS);
  if (!blocks.length) return [];
  const index = indexWindows(blocks);

  // A file the diff re-adds the text to (a move) is not a stale reference to it.
  const reAdded = blocks.map(() => new Set());
  for (const [file, lines] of added) {
    for (const i of scan(normalizeText(lines.join('\n')), index).keys()) reAdded[i].add(file);
  }

  const results = blocks.map((b) => ({ removedText: b.text, file: b.file, line: b.line, foundIn: [] }));
  try {
    for (const p of listFiles().filter(isSearchedPath).sort()) {
      const content = readFile(p);
      if (ADR_PATH.test(p) && INACTIVE_ADR.test(content)) continue;
      const { norm, lineAt } = normalizeLines(content);
      for (const [i, at] of scan(norm, index)) {
        if (p === blocks[i].file || reAdded[i].has(p)) continue;
        results[i].foundIn.push({ path: p, line: lineAt(at) });
      }
    }
  } catch (err) {
    logFn({ stage: 'review', event: 'review.stale_refs_error', level: 'warn', meta: { error: err.message } });
    return [];
  }
  return results.filter((r) => r.foundIn.length > 0);
}

const quote = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_QUOTED_CHARS ? `${flat.slice(0, MAX_QUOTED_CHARS)}…` : flat;
};
const where = (r) => r.foundIn.map((f) => `${f.path}:${f.line}`).join(', ');

/** Prompt block for the review (empty without hits). Capped at MAX_REPORTED_HITS to bound input tokens. */
export function formatStaleRefsContext(hits) {
  if (!hits?.length) return '';
  const lines = [
    '',
    '',
    '## Stale references (deterministic text search)',
    'Text this diff removes is still quoted, near-verbatim, in files the diff does not update. Check each one: if that file now describes behavior the PR removed or changed, it is a documentation gap (gate (b)).',
  ];
  for (const r of hits.slice(0, MAX_REPORTED_HITS)) {
    lines.push(`- Removed from ${r.file}:${r.line} — "${quote(r.removedText)}" — still referenced in: ${where(r)}`);
  }
  if (hits.length > MAX_REPORTED_HITS) lines.push(`- …and ${hits.length - MAX_REPORTED_HITS} more`);
  return lines.join('\n');
}

/** Review-comment section (empty without hits): informational, it does not affect the verdict. */
export function formatStaleRefsSection(hits) {
  if (!hits?.length) return '';
  const lines = ['', '### 🔗 Stale References', '_Removed text still referenced elsewhere (text search; informational, not a verdict input):_', ''];
  for (const r of hits.slice(0, MAX_REPORTED_HITS)) {
    lines.push(`- \`${r.file}:${r.line}\` → ${r.foundIn.map((f) => `\`${f.path}:${f.line}\``).join(', ')}`);
  }
  if (hits.length > MAX_REPORTED_HITS) lines.push(`- …and ${hits.length - MAX_REPORTED_HITS} more`);
  return lines.join('\n');
}
