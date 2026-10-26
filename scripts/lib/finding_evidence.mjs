// Proof for the findings about code outside the diff (RV-04a, ADR-0061). The review prompt allows a finding to concern
// existing code or text the diff does not touch (a caller, a test, a document) when it quotes it: `Evidence: path:line
// "exact text"`. This module reads those quotes and checks them against the PR tree, deterministically: the model may
// reason about what a quote means, it may not invent the quote. A blocking finding about outside code whose evidence is
// missing or not found is unproven, and a review whose blocking findings are all unproven requests no change
// (review_decision.mjs). Pure: the caller passes `lookup(path) -> text | null`.

import { issuesFoundText } from './review_prompt.mjs';
import { parseFindings, pathMatches } from './review_findings.mjs';

export const MAX_EVIDENCE_PER_FINDING = 5;
export const MAX_FINDINGS_CHECKED = 30;
export const LINE_WINDOW = 5;
export const MIN_QUOTE_CHARS = 6;
const MAX_NOTE_TEXT = 140;

const EVIDENCE_FIELD = /\bEvidence:\s*([\s\S]*?)(?=\s+(?:Fix|Axis|Root cause|File|Lines?):|$)/i;
// path:line (or path:from-to), then the quote in double, curly or back quotes. Linear: no nested quantifier.
const EVIDENCE_ITEM = /`?([\w./@-]+)`?:(\d+)(?:[-–]\d+)?[\s:—-]*(?:"([^"]+)"|“([^”]+)”|`([^`]+)`)/g;

const squash = (text) => String(text ?? '').replace(/[`“”"']/g, '').replace(/\s+/g, ' ').trim();
const plain = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_TEXT);

/** The `path:line "quote"` items of a finding's Evidence field (at most MAX_EVIDENCE_PER_FINDING). */
export function parseEvidence(findingText) {
  const field = EVIDENCE_FIELD.exec(String(findingText ?? ''))?.[1];
  if (!field) return [];
  return [...field.matchAll(EVIDENCE_ITEM)]
    .slice(0, MAX_EVIDENCE_PER_FINDING)
    .map((m) => ({ path: m[1], line: Number(m[2]), quote: m[3] ?? m[4] ?? m[5] }));
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
 * - `status`: `none` (no evidence given), `verified` (every quote found) or `unverified` (a quote is not where it says).
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
      return { ...item, found: text != null && quoteIsAt(text, item.line, item.quote) };
    });
    const status = evidence.length === 0 ? 'none' : evidence.every((e) => e.found) ? 'verified' : 'unverified';
    return { severity: f.severity, files: f.files, blocking, outside, evidence, status, unproven: blocking && outside && status !== 'verified' };
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

/** The comment section: findings about outside code and what their evidence came to. Empty when there is none. */
export function formatEvidenceCheck(assessment) {
  const shown = (assessment?.findings ?? []).filter((f) => f.outside || f.status !== 'none');
  if (shown.length === 0) return '';
  const lines = ['', '### 🔎 Evidence Check', '_A finding about code outside the diff must quote it (`Evidence: path:line "text"`); the quote is looked up in the PR tree, no LLM. An unproven finding does not request changes alone._', ''];
  for (const f of shown) {
    const where = f.files.map((x) => `\`${plain(x)}\``).join(', ') || '(no file)';
    const quotes = f.evidence.map((e) => `\`${plain(`${e.path}:${e.line}`)}\` ${e.found ? 'found' : 'not found'}`).join(', ');
    const mark = f.unproven ? '⚠️ unproven' : f.status === 'verified' ? '✅ verified' : '• not checked';
    lines.push(`- ${mark} — [${f.severity}] ${where}${f.outside ? ' (outside the diff)' : ''}${quotes ? `: ${quotes}` : f.unproven ? ': no evidence quoted' : ''}`);
  }
  return lines.join('\n');
}

/** Note appended when every blocking finding is unproven and the review is therefore withheld. */
export function formatUnprovenNote(assessment) {
  return [
    '',
    `> **Changes not requested** — every blocking finding above (${assessment.unproven}) concerns code outside the diff and does not quote it, or quotes text the PR tree does not hold.`,
    '> An unproven claim about code nobody showed is not a reason to change the PR, and auto-fix cannot edit what it is not shown: a human decides. Auto-fix is not triggered.',
  ].join('\n');
}

/** Counts for the `review.finding_evidence` event. */
export const evidenceCounts = (assessment) => ({
  findings: assessment.findings.length,
  blocking: assessment.blocking,
  outside: assessment.outside,
  verified: assessment.verified,
  unverified: assessment.unverified,
  unproven: assessment.unproven,
});
