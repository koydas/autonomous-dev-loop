// Adversarial review protocol (ADR-0049): the review must attack the diff on four fixed axes before it may
// approve, and an APPROVED that names fewer than MIN_CRITICAL_POINTS risks is withheld in code, whatever the
// prompt asked. Pure, deterministic, no LLM. The axis ids are a closed vocabulary: they are the only part of the
// analysis that leaves this module (run journal, lessons), never the model's text.

export const MIN_CRITICAL_POINTS = 2;

/** Axes of the protocol, in prompt order. `pattern` matches the axis name a review line starts with. */
export const ADVERSARIAL_AXES = Object.freeze([
  { id: 'robustness', label: 'Robustness', pattern: /^robustness|^edge[- ]?cases?/i },
  { id: 'side_effects', label: 'Side effects', pattern: /^(?:hidden )?side[- ]?effects?/i },
  { id: 'types', label: 'Type integrity', pattern: /^type(?:s| integrity| safety)?\b/i },
  { id: 'issue_fit', label: 'Issue fit', pattern: /^(?:strict )?(?:issue|adequacy|fit)\b/i },
]);

const SECTION_HEADING = /^\s*(?:#{1,3}\s|\*\*)[^\n]*adversarial analysis/i;
// Any other heading closes the section: "### ⚠️ Issues Found", "**🚀 Verdict**", "## 🔍 …".
const ANY_HEADING = /^\s*(?:#{1,3}\s|\*\*[^*\n]+\*\*:?\s*$)/;
// "- **Robustness** — text", "* Side effects: text", "1. Types - text"
const AXIS_LINE = /^\s*(?:[-*]|\d+[.)])\s+\**\s*([^*:—–\n-][^*:—–\n]*?)\s*\**\s*(?:[:—–]|\s-\s)\s*(.*)$/;
// A line that says nothing was found is not a risk. "None found (checked: …)" and "No risk" are the allowed forms.
const NO_RISK = /^\**\s*(?:none|no (?:risk|issue|concern|edge case|side effect|problem)s?|n\/a|nothing|not applicable|clean|ok)\b/i;
// The user template's own `<risk file:line, or none + what you checked>` echoed back is not an analysis.
const PLACEHOLDER = /^<[^<>]*>\.?$/;
// Shorter than this is a label, not an observation.
const MIN_RISK_CHARS = 12;

// The lines of the Adversarial Analysis section that belong to an axis: `{ id, text }`, text without markup. One parse
// for analyzeAdversarial and verifyAxes, so the two never disagree on which line counts.
function parseAxisLines(review) {
  const lines = [];
  let present = false;
  let inSection = false;
  for (const line of String(review ?? '').split('\n')) {
    if (SECTION_HEADING.test(line)) {
      present = true;
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (ANY_HEADING.test(line)) {
      inSection = false;
      continue;
    }
    const match = line.match(AXIS_LINE);
    if (!match) continue;
    const axis = ADVERSARIAL_AXES.find((a) => a.pattern.test(match[1].trim()));
    if (!axis) continue;
    lines.push({ id: axis.id, text: match[2].replace(/[*_`]/g, '').trim(), raw: match[2] });
  }
  return { present, lines };
}

const isRiskText = (text) => text.length >= MIN_RISK_CHARS && !NO_RISK.test(text) && !PLACEHOLDER.test(text);

/**
 * Parses the "Adversarial Analysis" section of a review.
 * `criticalPoints`: axes (each counted once) whose line states a risk. `axes`: per axis, whether it was covered
 * and whether it states a risk. `present`: the section exists. A risk is an observation, never a finding: the
 * Issues Found rules alone decide REQUEST_CHANGES.
 * @returns {{ present: boolean, criticalPoints: number, axes: { id: string, covered: boolean, risk: boolean }[], atRisk: string[] }}
 */
export function analyzeAdversarial(review) {
  const state = new Map(ADVERSARIAL_AXES.map((a) => [a.id, { id: a.id, covered: false, risk: false }]));
  const { present, lines } = parseAxisLines(review);
  for (const { id, text } of lines) {
    const entry = state.get(id);
    entry.covered = true;
    entry.risk ||= isRiskText(text);
  }
  const axes = [...state.values()];
  const atRisk = axes.filter((a) => a.risk).map((a) => a.id);
  return { present, criticalPoints: atRisk.length, axes, atRisk };
}

// Things a line can name that a string search can look for in the diff: `code` spans, paths and file names, and
// identifiers written in camelCase or snake_case. Plain words ("empty", "return") name nothing. A name is taken whole,
// as written: a run of name characters (`[\w$.-]` and `/`), never a piece of it, so `src/a.js.map` is looked up as
// `src/a.js.map` and not as `a.js`, and `my_file.mjs.map` not as `my_file`.
const NAME_TOKEN = /[\w$.-]+(?:\/[\w$.-]+)*/g;
const FILE_LIKE = /\/|\.[A-Za-z][A-Za-z0-9]{0,5}$/;
const IDENTIFIER = /^(?:[a-z]+[A-Z][A-Za-z0-9]{2,}|[A-Za-z0-9]+_[A-Za-z0-9_]+)$/;
const MIN_CANDIDATE_CHARS = 4;

function candidatesOf(rawLine) {
  const found = [];
  for (const m of rawLine.matchAll(/`([^`\n]{4,})`/g)) found.push(m[1]);
  for (const m of rawLine.matchAll(NAME_TOKEN)) {
    const token = m[0].replace(/^[.-]+|[.-]+$/g, '');
    if (FILE_LIKE.test(token) || IDENTIFIER.test(token)) found.push(token);
  }
  return found.map((c) => c.replace(/^[.,;:()]+|[.,;:()]+$/g, '')).filter((c) => c.length >= MIN_CANDIDATE_CHARS);
}

// The candidate must stand alone in the diff, not be a piece of a longer name: `RATE` is not found inside `RATED`, and a
// file name or path (a candidate with a `.` or a `/`) is not found inside `data.json`, `x.a.js`, `my-a.js`, `a.js.map` or
// `a.js-old`: for those, a `.` or a `-` goes on with the name. An identifier may be followed by a `.` (`RATE.value`).
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const standsAlone = (candidate, diff) => {
  const fileLike = /[./]/.test(candidate);
  const before = fileLike ? '(?<![\\w$.-])' : '(?<![\\w$])';
  const after = fileLike ? '(?![\\w$-]|\\.[\\w$])' : '(?![\\w$])';
  return new RegExp(`${before}${escapeRegExp(candidate)}${after}`).test(diff);
};

const namesSomethingIn = (rawLine, diff) => candidatesOf(rawLine).some((candidate) => standsAlone(candidate, diff));

/**
 * Axes whose line is verified (ADR-0065, shadow): the line is a real statement (not a placeholder, not a label) and names
 * something that is in the diff, a risk with its `file:line` or a `none` with what was looked at. Journaled by
 * pr_review.mjs as `verified_axes` and published by the `review` suite; it gates nothing until ADR-0065 is accepted.
 * A string search, no LLM: it is a floor on specificity, not proof that the check was done.
 * @param {string} review
 * @param {string} rawDiff
 * @returns {{ verified: string[], count: number }} closed axis ids, in axis order
 */
export function verifyAxes(review, rawDiff) {
  const diff = String(rawDiff ?? '');
  const found = new Set();
  for (const { id, text, raw } of parseAxisLines(review).lines) {
    if (text.length >= MIN_RISK_CHARS && !PLACEHOLDER.test(text) && namesSomethingIn(raw, diff)) found.add(id);
  }
  const verified = ADVERSARIAL_AXES.map((a) => a.id).filter((id) => found.has(id));
  return { verified, count: verified.length };
}

const ISSUES_HEADING = /^\s*(?:#{1,3}\s|\*\*)[^\n]*issues found/i;
const FINDING_START = /^\s*(?:[-*]|\d+[.)])\s*\**\[?\**(High|Medium)\b/i;
const AXIS_TAG = /\bAxis:\s*\**\s*([A-Za-z][A-Za-z _-]{2,20})/i;

/**
 * Axes tagged on the blocking (High or Medium) findings of a review: the `Axis:` token the review template asks
 * for on every finding, kept only when it is one of the closed ids. These are the review's adverse decisions
 * the meta-loop learns from (ADR-0051); a missing or unknown tag is simply not counted.
 * @returns {string[]} unique axis ids, in axis order
 */
export function blockingFindingAxes(review) {
  // One entry per finding bullet, with its continuation lines; only High and Medium entries are read.
  const findings = [];
  let inIssues = false;
  for (const line of String(review ?? '').split('\n')) {
    if (ISSUES_HEADING.test(line)) inIssues = true;
    else if (ANY_HEADING.test(line)) inIssues = false;
    else if (inIssues && /^\s*(?:[-*]|\d+[.)])\s/.test(line)) findings.push({ blocking: FINDING_START.test(line), text: line });
    else if (inIssues && findings.length) findings[findings.length - 1].text += `\n${line}`;
  }
  const found = new Set();
  for (const { blocking, text } of findings) {
    if (!blocking) continue;
    const tag = text.match(AXIS_TAG)?.[1]?.trim().toLowerCase().replace(/[ -]+/g, '_');
    if (tag) found.add(tag === 'side_effect' ? 'side_effects' : tag === 'type' || tag === 'type_integrity' ? 'types' : tag);
  }
  return ADVERSARIAL_AXES.map((a) => a.id).filter((id) => found.has(id));
}

/**
 * Applies the protocol to a verdict decision ({ verdict, reason }, see decideVerdict): an APPROVE whose review
 * lists fewer than `minPoints` critical points becomes WITHHELD (no approval, and no REQUEST_CHANGES either, so
 * auto-fix is not asked to fix a missing analysis: ADR-0026 path). Any other verdict passes through unchanged.
 * @returns {{ verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'WITHHELD', reason: string | null }}
 */
export function enforceAdversarialProtocol(decision, analysis, { minPoints = MIN_CRITICAL_POINTS } = {}) {
  if (decision.verdict !== 'APPROVE' || analysis.criticalPoints >= minPoints) return decision;
  const why = analysis.present ? `${analysis.criticalPoints} of ${minPoints} critical points listed` : 'no Adversarial Analysis section';
  return { verdict: 'WITHHELD', reason: `adversarial protocol not met (${why})` };
}

/** Markdown note appended to the review comment when an approval is withheld for the protocol (ADR-0049). */
export function formatProtocolNote(analysis, { minPoints = MIN_CRITICAL_POINTS } = {}) {
  const axes = analysis.present
    ? ADVERSARIAL_AXES.map((a) => `${a.label}: ${analysis.atRisk.includes(a.id) ? 'risk named' : 'no risk named'}`).join('; ')
    : 'the section is missing';
  return [
    '',
    `> **Approval withheld** — the review approved without the adversarial analysis the protocol requires (at least ${minPoints} axes naming a risk): ${axes}.`,
    '> No check failed and no defect was reported, so auto-fix is not triggered. Push a new commit or re-run the review; a human may also approve.',
  ].join('\n');
}
