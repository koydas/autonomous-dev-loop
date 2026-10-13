import { log } from './observability.mjs';
import { parseDiffBlocks } from './stale_refs.mjs';
import { isTestFile } from './change_classifier.mjs';

// Related ADRs for the review (ADR-0035): the docs/adr/NNNN-*.md files that cite a path the PR
// changes, so the reviewer knows which recorded decision governs the change. Pure apart from the
// injected `listFiles` / `readFile`.

export const DEFAULT_EXCERPT_CHARS = 400;
const ADR_PATH = /^docs\/adr\/(\d{4})-[^/]+\.md$/;
const INACTIVE_STATUS = /^(superseded|deprecated)\b/i;
// Touched by most PRs (changelog gate): citing it says nothing about the change itself.
const HISTORICAL = /(^|\/)CHANGELOG\.md$/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A path or basename counts only as a whole token: `review.mjs` must not match `pr_review.mjs`.
const mentions = (content, needle) => new RegExp(`(?<![\\w.-])${escapeRe(needle)}(?![\\w-])`).test(content);
// Negative when key `a` ranks before `b` (higher counts first).
const compareKeys = (a, b) => a.reduce((d, v, i) => d || b[i] - v, 0);
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/** Parses id, title, status, superseding ADR id and the Decision excerpt of one ADR file. */
export function parseAdr(filePath, content, excerptChars = DEFAULT_EXCERPT_CHARS) {
  const number = filePath.match(ADR_PATH)[1];
  const title = (content.match(/^# (.+)$/m)?.[1] ?? '').replace(/^ADR-\d{4}:\s*/, '').trim();
  const status = (content.match(/^- \*\*Status:\*\*\s*(.+)$/m)?.[1] ?? '').trim();
  const supersededBy = INACTIVE_STATUS.test(status) ? (status.match(/ADR-(\d{4})/)?.[1] ?? null) : null;
  const decision = content.match(/^## Decision[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
  const flat = decision.replace(/\s+/g, ' ').trim();
  const decisionExcerpt = flat.length > excerptChars ? `${flat.slice(0, excerptChars).trimEnd()}…` : flat;
  return { id: `ADR-${number}`, number, path: filePath, title, status, supersededBy, decisionExcerpt };
}

/**
 * ADRs citing a path changed by the diff (exact repo-relative path, or the basename when it is
 * unique among `listFiles()`). CHANGELOG.md is not a changed path for this purpose. Ranked by
 * changed non-test paths cited, then all changed paths cited, then those cited by exact path,
 * then most recent first.
 * Superseded / Deprecated ADRs are skipped; the ADR that supersedes one (when named) takes its
 * place. ADRs the diff itself changes are skipped (their content is already in the diff).
 * A listing or read error logs a `review.related_adrs_error` warn event and returns [].
 * @returns {Array<{ id: string, title: string, status: string, decisionExcerpt: string }>}
 */
export function findRelatedAdrs({ rawDiff, listFiles, readFile, excerptChars = DEFAULT_EXCERPT_CHARS, logFn = log }) {
  const changed = [...parseDiffBlocks(rawDiff).paths].filter((p) => !HISTORICAL.test(p));
  if (!changed.length) return [];
  let adrs;
  let files;
  try {
    files = listFiles();
    adrs = files.filter((p) => ADR_PATH.test(p)).map((p) => {
      const content = readFile(p);
      return { ...parseAdr(p, content, excerptChars), content };
    });
  } catch (err) {
    logFn({ stage: 'review', event: 'review.related_adrs_error', level: 'warn', meta: { error: err.message } });
    return [];
  }
  const baseCounts = new Map();
  for (const f of files) baseCounts.set(basename(f), (baseCounts.get(basename(f)) ?? 0) + 1);
  const needles = changed.map((p) => (baseCounts.get(basename(p)) === 1 ? [p, basename(p)] : [p]));
  const byNumber = new Map(adrs.map((a) => [a.number, a]));

  // Rank key, compared left to right: changed non-test paths cited (an ADR governs behavior; tests
  // only enforce it), all changed paths cited, of which by exact path (stronger than a basename),
  // then the most recent ADR.
  const scored = new Map();
  for (const adr of adrs) {
    if (changed.includes(adr.path)) continue;
    const cited = needles.filter((alts) => alts.some((n) => mentions(adr.content, n)));
    if (!cited.length) continue;
    const key = [cited.filter(([p]) => !isTestFile(p)).length, cited.length, cited.filter(([p]) => mentions(adr.content, p)).length];
    let target = adr;
    if (INACTIVE_STATUS.test(adr.status)) {
      target = byNumber.get(adr.supersededBy);
      if (!target || INACTIVE_STATUS.test(target.status) || changed.includes(target.path)) continue;
    }
    const prev = scored.get(target.number);
    if (!prev || compareKeys(key, prev) < 0) scored.set(target.number, key);
  }
  return [...scored]
    .sort(([a, ka], [b, kb]) => compareKeys(ka, kb) || b.localeCompare(a))
    .map(([n]) => {
      const { id, title, status, decisionExcerpt } = byNumber.get(n);
      return { id, title, status, decisionExcerpt };
    });
}

/** Prompt block listing up to `max` related ADRs (empty when none or `max` is 0). */
export function formatRelatedAdrsContext(adrs, max) {
  const shown = (adrs ?? []).slice(0, max);
  if (!shown.length) return '';
  const lines = [
    '',
    '',
    '## Related ADRs',
    'Recorded decisions that cite files this PR changes. If the diff contradicts one without updating it or adding a new ADR, report it:',
  ];
  for (const a of shown) lines.push(`- ${a.id}: ${a.title} (${a.status}) — Decision: ${a.decisionExcerpt}`);
  return lines.join('\n');
}
