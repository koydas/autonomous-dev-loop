// Finding-level measurement of the review stage (RV-01): which of the defects a case is known to contain did the
// review find, and how many of the findings it raised are not one of them. Pure and deterministic, no LLM: a
// finding is matched on where it points (file, lines) and on what it says is wrong, never on the verdict alone.
//
// A case lists its known defects in `expected.findings`:
//   { id, path, severity: 'high' | 'medium' | 'low', lines?: [start, end?], match?: 'a|b', needs?, blocking? }
// `match` is "a|b|c": the finding's text contains any alternative, case-insensitive. `needs` says what it takes to
// see the defect, so a miss can be attributed: 'diff' (visible in the hunks), 'context' (code or docs outside
// them), 'knowledge' (behavior of a tool or platform), 'reasoning' (several steps), 'execution' (needs a run).
// `blocking: false` marks an advisory defect that a Low finding may report; the others need a High or Medium one.

export const FINDING_NEEDS = Object.freeze(['diff', 'context', 'knowledge', 'reasoning', 'execution']);
export const FINDING_SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const DEFAULT_LINE_TOLERANCE = 5;

const FINDING_START = /^\s*(?:[-*]|\d+[.)])\s*\**\[?\**(High|Medium|Low)\b/i;
const ANY_BULLET = /^\s*(?:[-*]|\d+[.)])\s/;
const clean = (token) => token.trim().replace(/^[`'"([]+|[`'")\].,;:]+$/g, '').replace(/^\.\//, '');

/**
 * The findings of an "Issues Found" section: one per `- [High|Medium|Low] …` bullet, with its continuation lines.
 * A bullet that is not a finding ("- None.") ends the current finding, so its text is never attached to the one
 * before it.
 * @returns {{ severity: 'high' | 'medium' | 'low', text: string, files: string[], lines: [number, number] | null }[]}
 */
export function parseFindings(issuesText) {
  const entries = [];
  let current = null;
  for (const line of String(issuesText ?? '').split('\n')) {
    const start = line.match(FINDING_START);
    if (start) {
      current = { severity: start[1].toLowerCase(), text: line };
      entries.push(current);
    } else if (ANY_BULLET.test(line)) {
      current = null;
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  return entries.map(({ severity, text }) => {
    const fileField = text.match(/\bFile:\s*(.+?)(?=\s+Lines?:|\s+Root cause:|\s+Fix:|\s+Axis:|\n|$)/i)?.[1] ?? '';
    const files = [];
    let inlineLine = null;
    for (const raw of fileField.split(/\s*,\s*|\s+and\s+/)) {
      const [file, line] = clean(raw).split(/:(?=\d+(?:-\d+)?$)/);
      if (file) files.push(file);
      if (line && inlineLine === null) inlineLine = line;
    }
    const range = text.match(/\bLines?:\s*(\d+)(?:\s*[-–]\s*(\d+))?/i) ?? (inlineLine ? inlineLine.match(/^(\d+)(?:-(\d+))?$/) : null);
    const lines = range ? [Number(range[1]), Number(range[2] ?? range[1])] : null;
    return { severity, text, files, lines };
  });
}

/** A path names a file when equal, or when one is a `/`-suffix of the other (`utils.mjs` for `scripts/utils.mjs`). */
export function pathMatches(a, b) {
  const x = clean(String(a));
  const y = clean(String(b));
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

const alternatives = (entry) => String(entry).split('|').map((k) => k.trim().toLowerCase()).filter(Boolean);
const hits = (text, entry) => {
  const haystack = String(text).toLowerCase();
  return alternatives(entry).filter((k) => haystack.includes(k)).length;
};
const anyOf = (text, entry) => hits(text, entry) > 0;

const isBlocking = (severity) => severity === 'high' || severity === 'medium';
const overlaps = (a, b, tolerance) => a[0] - tolerance <= b[1] && b[0] - tolerance <= a[1];

/** The checks one detected finding must pass to be the expected one, and how well it fits (more specific = higher). */
function fit(expected, detected, tolerance) {
  if (expected.blocking !== false && !isBlocking(detected.severity)) return -1;
  if (!detected.files.some((f) => pathMatches(f, expected.path))) return -1;
  let score = 1;
  if (expected.lines && detected.lines) {
    const range = [expected.lines[0], expected.lines[1] ?? expected.lines[0]];
    if (!overlaps(range, detected.lines, tolerance)) return -1;
    score += 1;
  }
  if (expected.match) {
    const found = hits(detected.text, expected.match);
    if (found === 0) return -1;
    // The more of the defect's own vocabulary a finding uses, the more specific the fit: a finding that says
    // "symbolic link" is that defect's, not the one whose list only shares a word like "digest" with it.
    score += 1 + found / alternatives(expected.match).length;
  }
  return score;
}

// Minimum-cost assignment of n rows to m columns (n <= m), Hungarian algorithm: the column of each row.
function assignRows(cost) {
  const n = cost.length;
  const m = cost[0].length;
  const u = Array(n + 1).fill(0);
  const v = Array(m + 1).fill(0);
  const p = Array(m + 1).fill(0);
  const way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(m + 1).fill(Infinity);
    const used = Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const columnOf = Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) columnOf[p[j] - 1] = j - 1;
  return columnOf;
}

// A pair is worth more than any combination of scores, so the assignment first reports as many defects as can be
// reported at all; among those, the best total fit wins; the last term settles ties towards the diagonal (the earlier
// defect with the earlier finding). Integers, so the sums stay exact.
const PAIR_BASE = 1e12;
const weight = (score, ei, di) => PAIR_BASE + Math.round(score * 1000) * 10000 - Math.min((di - ei) ** 2, 9999);

/**
 * Pairs expected defects with detected findings, one to one: the most defects reported first, then the best fit.
 * A finding that could account for two defects goes to the one that no other finding can explain, and otherwise to
 * the one whose own vocabulary it uses most. Ties go to the earlier defect and the earlier finding.
 * @returns {{ matched: { id: string, detected: number }[], missed: string[], unmatched: number[] }} indexes refer to `detected`
 */
export function matchFindings(expected, detected, { lineTolerance = DEFAULT_LINE_TOLERANCE } = {}) {
  const w = expected.map((e, ei) => detected.map((d, di) => {
    const score = fit(e, d, lineTolerance);
    return score < 0 ? 0 : weight(score, ei, di);
  }));
  const taken = Array(expected.length).fill(-1);
  if (expected.length > 0 && detected.length > 0) {
    // Rows are the smaller side: the algorithm needs n <= m.
    if (expected.length <= detected.length) {
      assignRows(w.map((row) => row.map((x) => -x))).forEach((col, ei) => { taken[ei] = col; });
    } else {
      const transposed = detected.map((_, di) => expected.map((__, ei) => -w[ei][di]));
      assignRows(transposed).forEach((ei, di) => { if (ei >= 0) taken[ei] = di; });
    }
  }
  const matched = [];
  const usedDetected = new Set();
  expected.forEach((e, ei) => {
    const di = taken[ei];
    if (di >= 0 && w[ei][di] > 0) {
      matched.push({ id: e.id, detected: di });
      usedDetected.add(di);
    }
  });
  const matchedIds = new Set(matched.map((m) => m.id));
  return {
    matched,
    missed: expected.filter((e) => !matchedIds.has(e.id)).map((e) => e.id),
    unmatched: detected.map((_, i) => i).filter((i) => !usedDetected.has(i)),
  };
}

/**
 * Recall, precision and critical recall of one review against the defects of its case. `acceptable`
 * (`{ path?, match? }[]`) lists blocking findings that are not defects but are not false alarms either.
 * Each ratio is null when it has no denominator (no expected defect, no blocking finding raised).
 * @returns {{ detected: object[], matched: { id: string, detected: number }[], missed: { id: string, needs: string | null }[], falsePositives: object[], recall: number | null, precision: number | null, criticalRecall: number | null }}
 */
export function analyzeFindings(issuesText, expectedFindings, { acceptable = [], lineTolerance } = {}) {
  const detected = parseFindings(issuesText);
  const expected = Array.isArray(expectedFindings) ? expectedFindings : [];
  const { matched, missed, unmatched } = matchFindings(expected, detected, { lineTolerance });
  const byId = new Map(expected.map((e) => [e.id, e]));
  const isAcceptable = (d) => acceptable.some((a) => (!a.path || d.files.some((f) => pathMatches(f, a.path))) && (!a.match || anyOf(d.text, a.match)));
  const blockingDetected = detected.filter((d) => isBlocking(d.severity));
  const falsePositives = unmatched.map((i) => detected[i]).filter((d) => isBlocking(d.severity) && !isAcceptable(d));
  const blockingExpected = expected.filter((e) => e.blocking !== false);
  const matchedIds = new Set(matched.map((m) => m.id));
  const critical = expected.filter((e) => e.severity === 'high' && e.blocking !== false);
  const ratio = (num, den) => (den === 0 ? null : num / den);
  const acceptedBlocking = unmatched.map((i) => detected[i]).filter((d) => isBlocking(d.severity) && isAcceptable(d)).length;
  const blockingMatched = matched.filter((m) => isBlocking(detected[m.detected].severity)).length;
  return {
    detected,
    matched,
    missed: missed.map((id) => ({ id, needs: byId.get(id)?.needs ?? null })),
    falsePositives,
    recall: ratio(blockingExpected.filter((e) => matchedIds.has(e.id)).length, blockingExpected.length),
    precision: ratio(blockingMatched, blockingDetected.length - acceptedBlocking),
    criticalRecall: ratio(critical.filter((e) => matchedIds.has(e.id)).length, critical.length),
  };
}

/** Problems of a case's `expected.findings`, for the dataset invariants. [] when the list is well formed. */
export function validateExpectedFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return ['findings must be a non-empty array'];
  const problems = [];
  const ids = new Set();
  for (const [i, f] of findings.entries()) {
    const at = `findings[${i}]`;
    if (!f || typeof f !== 'object') {
      problems.push(`${at}: not an object`);
      continue;
    }
    if (typeof f.id !== 'string' || f.id === '') problems.push(`${at}: id missing`);
    else if (ids.has(f.id)) problems.push(`${at}: duplicate id ${f.id}`);
    else ids.add(f.id);
    if (typeof f.path !== 'string' || f.path === '') problems.push(`${at}: path missing`);
    if (!FINDING_SEVERITIES.includes(f.severity)) problems.push(`${at}: severity must be one of ${FINDING_SEVERITIES.join(', ')}`);
    if (f.lines !== undefined && !(Array.isArray(f.lines) && f.lines.length >= 1 && f.lines.length <= 2 && f.lines.every(Number.isInteger) && (f.lines[1] ?? f.lines[0]) >= f.lines[0])) problems.push(`${at}: lines must be [start] or [start, end]`);
    if (f.match !== undefined && (typeof f.match !== 'string' || f.match.trim() === '')) problems.push(`${at}: match must be a non-empty string`);
    if (f.needs !== undefined && !FINDING_NEEDS.includes(f.needs)) problems.push(`${at}: needs must be one of ${FINDING_NEEDS.join(', ')}`);
    if (f.blocking !== undefined && typeof f.blocking !== 'boolean') problems.push(`${at}: blocking must be a boolean`);
  }
  return problems;
}
