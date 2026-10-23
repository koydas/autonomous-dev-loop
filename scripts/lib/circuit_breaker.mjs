// Circuit breaker of the review → auto-fix loop (ADR-0050). The auto-fix cap (3 attempts, AGENTS.md) counts
// labels, which a manual reset or an APPROVE clears; the breaker counts something the loop cannot clear: how many
// consecutive reviews of the PR reported the same failure. The count travels in the review marker
// (review_marker.mjs), next to the head SHA and verdict, so it needs no store and no new permission.
// Pure, deterministic, no LLM.
import { createHash } from 'node:crypto';
import { findingCitedFiles } from './review_prompt.mjs';

/** Consecutive reviews reporting the same failure at which the loop is ESCALATED: a 3rd attempt of the same fix never starts. */
export const BREAKER_THRESHOLD = 3;

/**
 * Fingerprint of what a REQUEST_CHANGES reports: the failing checks of the tool evidence and the files its
 * findings cite. Line numbers, wording and severities are left out on purpose: a fix that moves the defect a few
 * lines, or a reviewer that rephrases it, is still the same failure. null when the review names neither
 * (nothing to compare, so no streak is claimed).
 * @param {{ failing?: string[], review?: string }} input
 * @returns {string | null} 10 hex chars
 */
export function failureSignature({ failing = [], review = '' } = {}) {
  const checks = [...new Set(failing.map(String))].sort();
  const files = [...new Set(findingCitedFiles(review).flat())].sort();
  if (checks.length === 0 && files.length === 0) return null;
  return createHash('sha256').update(JSON.stringify({ checks, files })).digest('hex').slice(0, 10);
}

/**
 * Streak of consecutive identical failures after this review. `previous` is the marker of the review before
 * (`{ verdict, streak?, sig? }`) or null. Anything but a REQUEST_CHANGES ends the streak (APPROVE: converged;
 * WITHHELD: not a judgement of the head, ADR-0026); a different or unknown signature restarts it at 1.
 * @returns {{ streak: number, sig: string | null }}
 */
export function nextStreak(previous, { verdict, sig = null } = {}) {
  if (verdict !== 'REQUEST_CHANGES') return { streak: 0, sig: null };
  if (sig && previous?.verdict === 'REQUEST_CHANGES' && previous.sig === sig) return { streak: (previous.streak ?? 1) + 1, sig };
  return { streak: 1, sig };
}

/** Whether a streak opens the breaker (the loop is ESCALATED: no re-pulse of `changes-requested`, no auto-fix). */
export const isBreakerOpen = (streak, threshold = BREAKER_THRESHOLD) => Number.isInteger(streak) && streak >= threshold;

/** Markdown note appended to the review comment when the breaker opens (ADR-0050). */
export function formatEscalationNote(streak, { threshold = BREAKER_THRESHOLD } = {}) {
  return [
    '',
    `> **🚨 ESCALATED** — the last ${streak} automated reviews (at least ${threshold} needed) reported the same failure: the fixes did not change the outcome, so the loop stops spending tokens on it.`,
    '> Auto-fix is not triggered and `needs-human` is set. A different finding or an APPROVE resets the count; ticking the auto-fix rerun box of the escalation comment overrides it for one run.',
  ].join('\n');
}
