// Proof for the findings about code outside the diff (RV-04a, ADR-0061). The review prompt allows a finding to concern
// existing code or text the diff does not touch (a caller, a test, a document) when it quotes it: `Evidence: path:line
// "exact text"`. This module reads those quotes and checks them against the PR tree, deterministically: the model may
// reason about what a quote means, it may not invent the quote. A blocking finding about outside code whose evidence is
// missing or not found is unproven, and a review whose blocking findings are all unproven requests no change
// (review_decision.mjs). Pure: the caller passes `lookup(path) -> text | null`.
//
// RV-05 (ADR-0063) generalizes the check to every finding: `substantiateFindings` gives each one a status, VERIFIED /
// SUPPORTED / UNVERIFIED / REFUTED, and a blocking finding that is neither verified nor supported is unproven.

import { issuesFoundText } from './review_prompt.mjs';
import { parseFindings, pathMatches, DEFAULT_LINE_TOLERANCE } from './review_findings.mjs';
import { parseDiffChanges } from './guardrail_review.mjs';

export const MAX_EVIDENCE_PER_FINDING = 5;
export const MAX_FINDINGS_CHECKED = 30;
export const LINE_WINDOW = 5;
export const MIN_QUOTE_CHARS = 12;
const MAX_NOTE_TEXT = 140;

const EVIDENCE_FIELD = /\bEvidence:\s*([\s\S]*?)(?=\s+(?:Fix|Axis|Root cause|File|Lines?):|$)/i;
// An item starts at `path:line` (or `path:from-to`) followed by an opening quote mark. Linear: no nested quantifier.
const ITEM_START = /`?([\w./@-]+)`?:(\d+)(?:[-–]\d+)?[\s:—-]*(?=["“`])/g;
const CLOSING = { '"': '"', '“': '”', '`': '`' };

const squash = (text) => String(text ?? '').replace(/[`“”"']/g, '').replace(/\s+/g, ' ').trim();
const plain = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_TEXT);

/**
 * The `path:line "quote"` items of a finding's Evidence field (at most MAX_EVIDENCE_PER_FINDING). An item runs from its
 * opening quote mark to the last matching mark before the next item (or the end of the field), so a quoted source line
 * that holds quote marks of its own is read whole: stopping at the first inner mark would accept a prefix of the quote as
 * proof of all of it. An item whose quote is never closed is dropped.
 */
export function parseEvidence(findingText) {
  const field = EVIDENCE_FIELD.exec(String(findingText ?? ''))?.[1];
  if (!field) return [];
  const starts = [...field.matchAll(ITEM_START)];
  const items = [];
  starts.forEach((m, i) => {
    const from = m.index + m[0].length;
    const segment = field.slice(from, i + 1 < starts.length ? starts[i + 1].index : field.length);
    const end = segment.lastIndexOf(CLOSING[segment[0]]);
    if (end > 0) items.push({ path: m[1], line: Number(m[2]), quote: segment.slice(1, end) });
  });
  return items.slice(0, MAX_EVIDENCE_PER_FINDING);
}

/** Whether `quote` is written in `text` within LINE_WINDOW lines of `line` (whitespace and quote marks ignored). */
export function quoteIsAt(text, line, quote) {
  const wanted = squash(quote);
  if (wanted.length < MIN_QUOTE_CHARS || !Number.isInteger(line) || line < 1) return false;
  const lines = String(text ?? '').split('\n');
  const from = Math.max(0, line - 1 - LINE_WINDOW);
  return squash(lines.slice(from, line + LINE_WINDOW).join(' ')).includes(wanted);
}

/**
 * Looks at each finding of the review's Issues Found section.
 * - `anchored`: it cites a file of the diff, or no file at all: it is judged as before.
 * - `outside`: it cites files and none is in the diff: it needs proof. Without a list of the files of the diff (a diff with
 *   no `diff --git` header) nothing can be said to be outside it, and no finding is judged.
 * - `status`: `none` (no evidence given), `verified` (every quote found, and at least one is in a file the finding cites:
 *   a quote from another file proves nothing about it) or `unverified`.
 * - `unproven`: a High or Medium finding about outside code without verified evidence.
 * @param {{ review: string, diffFiles: string[], lookup: (path: string) => string | null }} input
 */
export function assessFindings({ review, diffFiles = [], lookup }) {
  const parsed = parseFindings(issuesFoundText(review)).slice(0, MAX_FINDINGS_CHECKED);
  const findings = parsed.map((f) => {
    const blocking = f.severity === 'high' || f.severity === 'medium';
    const outside = diffFiles.length > 0 && f.files.length > 0 && !f.files.some((file) => diffFiles.some((d) => pathMatches(file, d)));
    const evidence = parseEvidence(f.text).map((item) => {
      let text = null;
      try {
        text = lookup(item.path);
      } catch {
        text = null;
      }
      return { ...item, read: text != null, found: text != null && quoteIsAt(text, item.line, item.quote) };
    });
    const about = evidence.some((e) => f.files.some((file) => pathMatches(file, e.path)));
    const status = evidence.length === 0 ? 'none' : evidence.every((e) => e.found) && (about || !outside) ? 'verified' : 'unverified';
    return { severity: f.severity, files: f.files, lines: f.lines, text: f.text, blocking, outside, evidence, status, unproven: blocking && outside && status !== 'verified' };
  });
  const count = (pick) => findings.filter(pick).length;
  return {
    findings,
    blocking: count((f) => f.blocking),
    outside: count((f) => f.outside),
    verified: count((f) => f.status === 'verified'),
    unverified: count((f) => f.status === 'unverified'),
    unproven: count((f) => f.unproven),
  };
}

export const FINDING_STATUSES = Object.freeze(['verified', 'supported', 'unverified', 'refuted']);

/**
 * Line ranges of each file's hunks (old and new side), from a unified diff: the lines the reviewer was shown. A file
 * is keyed by both its paths; a file with no hunk (a pure rename, a binary file) has an empty list.
 * @returns {Map<string, Array<[number, number]>>}
 */
export function diffHunkRanges(rawDiff) {
  const ranges = new Map();
  for (const part of String(rawDiff ?? '').split(/^diff --git /m).slice(1)) {
    const names = part.match(/^a\/(.+?) b\/(.+)$/m);
    if (!names) continue;
    const list = [];
    for (const m of part.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      list.push([Number(m[1]), Number(m[1]) + Math.max(Number(m[2] ?? 1), 1) - 1], [Number(m[3]), Number(m[3]) + Math.max(Number(m[4] ?? 1), 1) - 1]);
    }
    for (const name of new Set([names[1], names[2]])) ranges.set(name, list);
  }
  return ranges;
}

// A finding that cites a file of the diff is located when its lines (if any) fall within a hunk of that file, give or
// take the tolerance the finding-level metrics use; a file with no hunk cannot be judged and counts as located.
function isLocated(finding, ranges) {
  const cited = [...ranges.entries()].filter(([file]) => finding.files.some((f) => pathMatches(f, file)));
  if (cited.length === 0) return false;
  if (!finding.lines) return true;
  const [from, to] = finding.lines;
  return cited.some(([, list]) => list.length === 0 || list.some(([a, b]) => from - DEFAULT_LINE_TOLERANCE <= b && a - DEFAULT_LINE_TOLERANCE <= to));
}

/**
 * The status of every finding of the review (RV-05, ADR-0063), deterministic and without an LLM:
 * - `verified`: every quote of its Evidence field is written in the PR tree (see assessFindings).
 * - `supported`: it points at the diff: a cited file is in the diff and its lines, if given, fall in a hunk. The
 *   reviewer was shown that code, and so is the auto-fixer. Without a list of the files of the diff nothing can be
 *   judged and a finding is supported as before.
 * - `refuted`: it is not located in the diff and a quote it gives is not in a file that was read.
 * - `unverified`: any other finding that is not located in the diff (outside it, no file, lines the diff does not show).
 * A blocking finding that is neither verified nor supported is `unproven`: a review whose blocking findings are all
 * unproven requests no change (review_decision.mjs), and the ones that remain are kept out of the auto-fixer's feedback.
 * @param {{ review: string, rawDiff: string, lookup: (path: string) => string | null }} input
 */
export function substantiateFindings({ review, rawDiff, lookup }) {
  const diffFiles = parseDiffChanges(rawDiff).flatMap((f) => [f.after, f.before]);
  const ranges = diffHunkRanges(rawDiff);
  const base = assessFindings({ review, diffFiles, lookup });
  const findings = base.findings.map((f) => {
    const judged = diffFiles.length > 0;
    const status = f.status === 'verified' ? 'verified'
      : !judged || (!f.outside && f.files.length > 0 && isLocated(f, ranges)) ? 'supported'
      : f.evidence.some((e) => e.read && !e.found) ? 'refuted'
      : 'unverified';
    return { ...f, status, unproven: f.blocking && (status === 'unverified' || status === 'refuted') };
  });
  const count = (pick) => findings.filter(pick).length;
  return {
    findings,
    blocking: base.blocking,
    outside: base.outside,
    verified: count((f) => f.status === 'verified'),
    supported: count((f) => f.status === 'supported'),
    unverified: count((f) => f.status === 'unverified'),
    refuted: count((f) => f.status === 'refuted'),
    unproven: count((f) => f.unproven),
  };
}

const MAX_LOOKUP_LINE = 100_000;

/**
 * A `lookup` for a place with no tree (the `review` eval suite): the files of an Impact analysis block, made of the
 * lines it lists at their line numbers. Only those lines can be quoted.
 */
export function impactLookup(impact) {
  const files = new Map();
  for (const symbol of impact?.symbols ?? []) {
    for (const ref of symbol.refs ?? []) {
      if (!Number.isInteger(ref.line) || ref.line < 1 || ref.line > MAX_LOOKUP_LINE) continue;
      if (!files.has(ref.path)) files.set(ref.path, []);
      files.get(ref.path)[ref.line - 1] = ref.text;
    }
  }
  return (path) => (files.has(path) ? Array.from(files.get(path), (line) => line ?? '').join('\n') : null);
}

const MARKS = { verified: '✅ verified', supported: '✔️ supported', refuted: '❌ refuted', unverified: '⚠️ unverified' };

/** The comment section: each blocking finding with its status, and the other findings that are outside the diff or quote something. */
export function formatEvidenceCheck(assessment) {
  const shown = (assessment?.findings ?? []).filter((f) => f.blocking || f.outside || f.evidence.length > 0);
  if (shown.length === 0) return '';
  const lines = ['', '### 🔎 Evidence Check', '_Each blocking finding is checked in code, no LLM: **verified** (its `Evidence:` quotes are in the PR tree), **supported** (it points at lines of the diff), **unverified** (outside the diff without a checked quote, or lines the diff does not show) or **refuted** (a quote it gives is not in the file). An unsubstantiated finding does not request changes alone and is not sent to auto-fix._', ''];
  for (const f of shown) {
    const where = f.files.map((x) => `\`${plain(x)}\``).join(', ') || '(no file)';
    const quotes = f.evidence.map((e) => `\`${plain(`${e.path}:${e.line}`)}\` ${e.found ? 'found' : 'not found'}`).join(', ');
    const mark = MARKS[f.status] ?? '• not checked';
    lines.push(`- ${mark} — [${f.severity}] ${where}${f.outside ? ' (outside the diff)' : ''}${quotes ? `: ${quotes}` : f.unproven ? ': no evidence quoted' : ''}`);
  }
  return lines.join('\n');
}

/** Note appended when every blocking finding is unsubstantiated and the review is therefore withheld. */
export function formatUnprovenNote(assessment) {
  return [
    '',
    `> **Changes not requested** — every blocking finding above (${assessment.unproven}) is unsubstantiated: it concerns code outside the diff without a quote the PR tree holds, or points at lines the diff does not show.`,
    '> An unproven claim is not a reason to change the PR, and auto-fix cannot edit what it is not shown: a human decides. Auto-fix is not triggered.',
  ].join('\n');
}

/** Counts for the `review.finding_evidence` event. */
export const evidenceCounts = (assessment) => ({
  findings: assessment.findings.length,
  blocking: assessment.blocking,
  outside: assessment.outside,
  verified: assessment.verified,
  supported: assessment.supported ?? 0,
  unverified: assessment.unverified,
  refuted: assessment.refuted ?? 0,
  unproven: assessment.unproven,
});
