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

/**
 * Parses the "Adversarial Analysis" section of a review.
 * `criticalPoints`: axes (each counted once) whose line states a risk. `axes`: per axis, whether it was covered
 * and whether it states a risk. `present`: the section exists. A risk is an observation, never a finding: the
 * Issues Found rules alone decide REQUEST_CHANGES.
 * @returns {{ present: boolean, criticalPoints: number, axes: { id: string, covered: boolean, risk: boolean }[], atRisk: string[] }}
 */
export function analyzeAdversarial(review) {
  const state = new Map(ADVERSARIAL_AXES.map((a) => [a.id, { id: a.id, covered: false, risk: false }]));
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
    const text = match[2].replace(/[*_`]/g, '').trim();
    const entry = state.get(axis.id);
    entry.covered = true;
    entry.risk ||= text.length >= MIN_RISK_CHARS && !NO_RISK.test(text) && !PLACEHOLDER.test(text);
  }
  const axes = [...state.values()];
  const atRisk = axes.filter((a) => a.risk).map((a) => a.id);
  return { present, criticalPoints: atRisk.length, axes, atRisk };
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
  const findings = [];
  let inIssues = false;
  for (const line of String(review ?? '').split('\n')) {
    if (ISSUES_HEADING.test(line)) inIssues = true;
    else if (ANY_HEADING.test(line)) inIssues = false;
    else if (inIssues && FINDING_START.test(line)) findings.push(line);
    else if (inIssues && findings.length && !/^\s*(?:[-*]|\d+[.)])\s/.test(line)) findings[findings.length - 1] += `\n${line}`;
    else if (inIssues) findings.push('');
  }
  const found = new Set();
  for (const finding of findings) {
    const tag = finding.match(AXIS_TAG)?.[1]?.trim().toLowerCase().replace(/[ -]+/g, '_');
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
