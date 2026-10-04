// One LLM review per PR head SHA (ADR-0028). pr_review.mjs ends its review comment with a
// hidden marker naming the head SHA it judged and the resulting verdict; the next pr-review
// run reads it to skip a duplicate review, and auto_fix_pr.mjs reads it to skip an approved head.

export const REVIEW_VERDICTS = ['APPROVE', 'REQUEST_CHANGES', 'WITHHELD'];

const SHA_RE = /^[0-9a-f]{7,64}$/;
// Anchored: only the marker pr_review.mjs appends last counts. A marker quoted earlier in the
// body (LLM echo of a diff, injection via PR content) never wins.
const MARKER_RE = /<!-- adl-review sha=([0-9a-f]{7,64}) verdict=(APPROVE|REQUEST_CHANGES|WITHHELD) -->\s*$/;
const ANY_MARKER_RE = /<!--\s*adl-review[\s\S]*?-->/gi;
// Authors whose review comment is trusted: the Actions bot (GITHUB_TOKEN) or a repo member
// (AI_PR_TOKEN is a member's PAT). Anyone else can comment on a public PR.
const TRUSTED_BOT_LOGIN = 'github-actions[bot]';
const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const NULL_SHA_RE = /^0+$/;

export function isCommitSha(sha) {
  return typeof sha === 'string' && SHA_RE.test(sha) && !NULL_SHA_RE.test(sha);
}

export function formatReviewMarker({ sha, verdict } = {}) {
  if (!isCommitSha(sha)) throw new Error(`Invalid review marker sha: ${sha}`);
  if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`Invalid review marker verdict: ${verdict}`);
  return `<!-- adl-review sha=${sha} verdict=${verdict} -->`;
}

// Removes marker-like comments from untrusted text (LLM output, evidence tails) before the
// real marker is appended.
export function stripReviewMarkers(text) {
  return typeof text === 'string' ? text.replace(ANY_MARKER_RE, '') : text;
}

export function isTrustedReviewComment(comment) {
  return comment?.user?.login === TRUSTED_BOT_LOGIN || TRUSTED_ASSOCIATIONS.includes(comment?.author_association);
}

// The most recent trusted comment carrying the review heading (comments are listed oldest first).
export function findLatestReviewComment(comments, heading) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (typeof c?.body === 'string' && c.body.includes(heading) && isTrustedReviewComment(c)) return c;
  }
  return null;
}

// Returns { sha, verdict } from a review comment body, or null when it carries no marker
// (comments written before ADR-0028, or by a human).
export function parseReviewMarker(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(MARKER_RE);
  return m ? { sha: m[1], verdict: m[2] } : null;
}

// The commit the run was triggered for: pull_request.head.sha, or `after` for a push.
// null when the payload carries neither, or for a branch deletion (all-zero SHA).
export function eventHeadSha(event) {
  const sha = event?.pull_request?.head?.sha ?? event?.after ?? null;
  return isCommitSha(sha) ? sha : null;
}

// Whether this pr-review run should call the LLM.
// - superseded: the PR head moved past the commit this run's evidence was built for; the run
//   for the newer push reviews it, so reviewing here would only produce a stale/WITHHELD verdict.
// - already_reviewed: a review comment already judged this head (push + pull_request.opened
//   both fire for a new PR). WITHHELD is not a judgement of the head (evidence missing or
//   stale, ADR-0026), so it never dedups. A manual re-run (runAttempt > 1) bypasses this check only.
export function decideReviewRun({ eventSha = null, headSha = null, previous = null, runAttempt = 1 } = {}) {
  if (!headSha) return { run: true, reason: 'unknown_head' };
  if (eventSha && eventSha !== headSha) return { run: false, reason: 'superseded' };
  if (Number(runAttempt) > 1) return { run: true, reason: 'manual_rerun' };
  if (previous?.sha === headSha && previous.verdict !== 'WITHHELD') return { run: false, reason: 'already_reviewed' };
  return { run: true, reason: 'new_head' };
}

// Whether auto-fix should run: a `changes-requested` label can outlive the review that set
// it (the next review approved the corrective push), so an APPROVE on the current head wins —
// unless a human explicitly asked for a rerun (human as gate).
export function decideAutofixRun({ headSha = null, previous = null, manualRerun = false } = {}) {
  if (manualRerun) return { run: true, reason: 'manual_rerun' };
  if (headSha && previous?.sha === headSha && previous.verdict === 'APPROVE') {
    return { run: false, reason: 'approved' };
  }
  return { run: true, reason: null };
}

// The model may legitimately find nothing to change; that is a no-op, not a malformed answer.
// A missing or non-array `changes` stays an error (validateAiOutput).
export function hasNoProposedChanges(aiOutput) {
  return Array.isArray(aiOutput?.changes) && aiOutput.changes.length === 0;
}
