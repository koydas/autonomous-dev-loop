// Trace identity (ADR-0041): one trace per work item — an issue, or a PR without an issue — derived
// deterministically from the item, so the runs of different workflows join the same trace without
// passing any context between them. Pure functions: no I/O, no env.
import { createHash, randomBytes } from 'node:crypto';

export const TRACE_ID_RE = /^[0-9a-f]{32}$/;
export const SPAN_ID_RE = /^[0-9a-f]{16}$/;
export const ITEM_KINDS = Object.freeze(['issue', 'pr', 'run']);
// Untrusted PR text is read only up to this many characters, for at most this many references.
export const MAX_SCANNED_CHARS = 64 * 1024;
export const MAX_CLOSING_REFS = 20;

const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null;
};

// W3C trace-context forbids an all-zero id; a hash that is all zero is replaced by ...01.
const nonZero = (hex, zero) => (hex === zero ? `${zero.slice(0, -1)}1` : hex);

/** 32-hex trace id of a work-item key (`<repo>#issue-<n>`): the first 128 bits of its SHA-256. */
export function traceIdFor(key) {
  return nonZero(createHash('sha256').update(String(key)).digest('hex').slice(0, 32), ZERO_TRACE);
}

/** 16-hex span id derived from a seed (spans of a v1 trace, which recorded no id). */
export function derivedSpanId(seed) {
  return nonZero(createHash('sha256').update(`span:${seed}`).digest('hex').slice(0, 16), ZERO_SPAN);
}

/** Random 16-hex span id (W3C parent-id format). */
export function newSpanId(random = randomBytes) {
  return nonZero(random(8).toString('hex'), ZERO_SPAN);
}

/** The issue number of a pipeline branch `ai/issue-<n>` (optionally `refs/heads/`-prefixed), else null. */
export function branchIssue(ref) {
  if (typeof ref !== 'string' || ref.length > 255) return null;
  const m = /^(?:refs\/heads\/)?ai\/issue-(\d{1,9})$/.exec(ref);
  return m ? posInt(m[1]) : null;
}

/**
 * Issues a PR body closes with a GitHub closing keyword (`Closes #12`, `fixes: #3`), in body order,
 * deduplicated. Only same-repository `#<digits>` references count (`owner/repo#5` and URLs do not);
 * the text is untrusted: read up to MAX_SCANNED_CHARS, at most MAX_CLOSING_REFS references.
 */
export function closingIssues(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const re = /(?:^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]*:?[ \t]+#(\d{1,9})\b/gi;
  for (const m of text.slice(0, MAX_SCANNED_CHARS).matchAll(re)) {
    const n = posInt(m[1]);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= MAX_CLOSING_REFS) break;
  }
  return out;
}

/**
 * The work-item fields of a GitHub event payload, numbers only (the body is parsed, never kept):
 * `{ issueNumber, prNumber, branchIssue, closingIssues }`. An `issue` that is a PR (issue_comment on
 * a PR) counts as the PR; `inputs.issue_number` / `inputs.pr_number` cover workflow_dispatch.
 */
export function payloadWorkItemHint(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const issueIsPr = Boolean(p.issue?.pull_request);
  const prBody = p.pull_request?.body ?? (issueIsPr ? p.issue?.body : null);
  return {
    issueNumber: posInt((!issueIsPr ? p.issue?.number : null) ?? p.inputs?.issue_number),
    prNumber: posInt(p.pull_request?.number ?? (issueIsPr ? p.issue?.number : null) ?? p.inputs?.pr_number),
    branchIssue: branchIssue(p.pull_request?.head?.ref) ?? branchIssue(p.ref),
    closingIssues: closingIssues(prBody),
  };
}

/**
 * The work-item hint of a PR object a script fetched (`trace.work_item` event meta): the push-triggered
 * review and reset-auto-fix get no PR body or head ref in their payload.
 */
export function prWorkItemHint(pr) {
  return {
    prNumber: posInt(pr?.number),
    branchIssue: branchIssue(pr?.head?.ref),
    closingIssues: closingIssues(pr?.body),
  };
}

const firstOf = (hints, pick) => {
  for (const h of hints) {
    const v = h && typeof h === 'object' ? pick(h) : null;
    if (v != null) return v;
  }
  return null;
};

/**
 * Resolves the work item of a run from its hints (payload first, then `trace.work_item` events), in
 * this order: issue event → branch `ai/issue-<n>` → first closing reference of the PR body → the PR
 * itself → the run alone (no item: evals, local runs). Returns
 * `{ kind, number, source, key, trace_id }`, or null when not even a run id is known.
 */
export function resolveWorkItem({ repository, runId = null, hints = [] } = {}) {
  const repo = typeof repository === 'string' && repository ? repository : 'local';
  const list = Array.isArray(hints) ? hints : [];
  const candidates = [
    ['issue', 'issue_event', firstOf(list, (h) => posInt(h.issueNumber))],
    ['issue', 'branch', firstOf(list, (h) => posInt(h.branchIssue))],
    ['issue', 'closes', firstOf(list, (h) => (Array.isArray(h.closingIssues) ? posInt(h.closingIssues[0]) : null))],
    ['pr', 'pr', firstOf(list, (h) => posInt(h.prNumber))],
    ['run', 'run', posInt(typeof runId === 'string' ? runId : String(runId ?? ''))],
  ];
  const found = candidates.find(([, , n]) => n != null);
  if (!found) return null;
  const [kind, source, number] = found;
  return workItem(repo, kind, number, source);
}

/** A work item from its parts; null for an unknown kind or a non-positive number. */
export function workItem(repository, kind, number, source = null) {
  const n = posInt(number);
  if (!ITEM_KINDS.includes(kind) || n == null) return null;
  const key = `${typeof repository === 'string' && repository ? repository : 'local'}#${kind}-${n}`;
  return { kind, number: n, source, key, trace_id: traceIdFor(key) };
}
