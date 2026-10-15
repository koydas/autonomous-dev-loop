import { log } from './observability.mjs';

// Stale-reference check (ADR-0035): text a PR removes that is still quoted, near-verbatim, in the
// repo's docs, skills or AGENTS.md, and that the PR tree no longer holds in its source or a prompt.
// Deterministic (text search, no LLM); the result is informational evidence for the reviewer and
// never changes the verdict on its own.

export const MIN_MATCH_CHARS = 60;
// A doc is reported only for a contiguous quote of at least this many normalized chars: on #207,
// reworded lines shared 61–86-char runs of generic phrasing with docs. A shorter block must be quoted
// whole, give or take QUOTE_SLACK_CHARS (a `//`, `-` or `>` prefix, end punctuation).
export const MIN_RUN_CHARS = 100;
export const QUOTE_SLACK_CHARS = 10;
const minRun = (norm) => Math.max(MIN_MATCH_CHARS, Math.min(MIN_RUN_CHARS, norm.length - QUOTE_SLACK_CHARS));
// A live source (head source file, prompt) larger than this is not scanned: its text is not live.
export const MAX_LIVE_SOURCE_CHARS = 1_000_000;
export const MAX_REPORTED_HITS = 5;
export const MAX_QUOTED_CHARS = 160;

const SEARCHED_PATHS = [/^docs\/.+\.md$/, /^\.claude\/skills\/.+\.md$/, /^AGENTS\.md$/];
// Prompts are the rules themselves, not descriptions of them: text still in one is still live.
const LIVE_PATHS = /^prompts\/[^/]+\.md$/;
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
 * per file. Paths come from `diff --git a/X b/Y`; a block's `file` is X, `newFile` Y (they differ on a
 * rename), and its `line` is its first old-file line.
 * @returns {{ removed: Array<{ file: string, newFile: string, line: number, text: string }>, added: Map<string, string[]>, paths: Set<string> }}
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
      block ??= { file, newFile, line: oldLine, text: '' };
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
    // A run can start on the space joining two lines (a block with a `//` or `-` prefix).
    if (norm[offset] === ' ') offset++;
    let line = 1;
    for (const [start, l] of starts) {
      if (start > offset) break;
      line = l;
    }
    return line;
  };
  return { norm, lineAt };
}

// Per block index: start offset and window count of its longest matched run in `norm` (consecutive
// window hits). Windows live for a block (`isLive(gram, i)`: still in the head tree) break its run.
function scan(norm, index, isLive = () => false) {
  const best = new Map();
  const open = new Map(); // block index -> [runStart, lastHitOffset]
  for (let at = 0; at + MIN_MATCH_CHARS <= norm.length; at++) {
    const gram = norm.slice(at, at + MIN_MATCH_CHARS);
    for (const i of index.get(gram) ?? []) {
      if (isLive(gram, i)) continue;
      const run = open.get(i);
      if (run && run[1] === at - 1) run[1] = at;
      else open.set(i, [at, at]);
      const [start, end] = open.get(i);
      const prev = best.get(i);
      if (!prev || end - start + 1 > prev.windows) best.set(i, { at: start, windows: end - start + 1 });
    }
  }
  return best;
}

// Windows of the removed text that the PR tree still holds: in the head version of a file text was
// removed from (a reworded line), or in a prompt. Removed text still there is not stale. Prompts keep
// every block live; a source file only its own blocks, so a doc the diff also edits elsewhere never
// keeps the other docs' quotes live.
function liveWindows(files, blocks, readFile, index) {
  const sources = new Set(blocks.flatMap((b) => [b.file, b.newFile]));
  const prompts = new Set();
  const bySource = new Map();
  for (const p of files.filter((f) => sources.has(f) || LIVE_PATHS.test(f)).sort()) {
    const content = readFile(p);
    if (content.length > MAX_LIVE_SOURCE_CHARS) continue;
    const norm = normalizeText(content);
    const live = LIVE_PATHS.test(p) ? prompts : new Set();
    for (let at = 0; at + MIN_MATCH_CHARS <= norm.length; at++) {
      const gram = norm.slice(at, at + MIN_MATCH_CHARS);
      if (index.has(gram)) live.add(gram);
    }
    if (live !== prompts) bySource.set(p, live);
  }
  // The head version of a renamed file is at its new path.
  return (gram, i) => prompts.has(gram) || [blocks[i].file, blocks[i].newFile].some((f) => bySource.get(f)?.has(gram));
}

/**
 * Finds removed text (blocks of ≥ 60 normalized chars) still quoted in docs/**\/*.md,
 * .claude/skills/**\/*.md and AGENTS.md of the PR tree. A doc is reported when it holds a contiguous
 * run of ≥ MIN_RUN_CHARS (or the whole of a shorter block, within QUOTE_SLACK_CHARS) of removed text
 * that the head tree no longer holds elsewhere: windows still in the head version of the block's own
 * source file or in any prompts/*.md are live (sources over MAX_LIVE_SOURCE_CHARS are not scanned).
 * Excluded: CHANGELOG.md and Superseded / Deprecated ADRs (historical by design), the file the text
 * was removed from, and any file the diff re-adds it to.
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
    const files = listFiles();
    const isLive = liveWindows(files, blocks, readFile, index);
    for (const p of files.filter(isSearchedPath).sort()) {
      const content = readFile(p);
      if (ADR_PATH.test(p) && INACTIVE_ADR.test(content)) continue;
      const { norm, lineAt } = normalizeLines(content);
      for (const [i, { at, windows }] of scan(norm, index, isLive)) {
        if (p === blocks[i].file || reAdded[i].has(p)) continue;
        if (windows + MIN_MATCH_CHARS - 1 < minRun(blocks[i].norm)) continue;
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
    'Text this diff removes is still quoted, near-verbatim, in files the diff does not update. Leads only: at most one Low "Verify stale reference" issue, never Medium or High, never a reason for REQUEST_CHANGES.',
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
