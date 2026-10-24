// Round-trips with an external review bot (Codex), counted from the PR's own GitHub data.
// The internal review's `review_cycles` never sees them, so a PR that took seven Codex rounds
// recorded one cycle. Observational: a lower bound when the bot has not yet answered the head.
// Unknown stays null, never 0 (the caller passes null when GitHub could not be read).

export const EXTERNAL_REVIEWER_LOGIN = /^chatgpt-codex-connector(\[bot\])?$/i;

const isExternal = (item) => EXTERNAL_REVIEWER_LOGIN.test(item?.user?.login ?? '');
// The bot marks priority with a badge image: .../badge/P1-orange. No badge: not counted as P0/P1.
const priorityOf = (body) => String(body ?? '').match(/\/badge\/(P\d)\b/)?.[1] ?? null;

/**
 * @param {{ reviews: object[]|null, comments: object[]|null }} input REST lists of a PR
 *   (`/pulls/N/reviews`, `/pulls/N/comments`).
 * @returns {{ rounds: number, threads: number, p0p1: number }|null} null when either list is unknown.
 *   rounds = distinct commits the bot reviewed; threads = its root inline comments (replies excluded);
 *   p0p1 = those marked P0 or P1.
 */
export function summarizeExternalReview({ reviews, comments } = {}) {
  if (!Array.isArray(reviews) || !Array.isArray(comments)) return null;
  const rounds = new Set(reviews.filter(isExternal).map((r) => r.commit_id).filter(Boolean));
  const roots = comments.filter((c) => isExternal(c) && !c.in_reply_to_id);
  return {
    rounds: rounds.size,
    threads: roots.length,
    p0p1: roots.filter((c) => ['P0', 'P1'].includes(priorityOf(c.body))).length,
  };
}
