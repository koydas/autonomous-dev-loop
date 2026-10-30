/**
 * Case-level repeat diagnostics of a recorded eval run (#325). Pure: reads results, calls no LLM.
 *
 * The run-level `consistency` metric says how many cases flipped, not which, nor whether a case is wrong
 * on every repeat. This report keeps the two apart, per case:
 *   - inconsistent       — the repeats disagree on the verdict (an error counts as its own verdict);
 *   - consistently_wrong — every repeat agrees, on the wrong verdict (stability does not fix it);
 *   - stable             — every repeat agrees on the expected verdict.
 * Blocker codes (B1–B4 prefixes, `unknown` for any other blocker) are listed per repeat, with the
 * dataset's expected codes when known, so a verdict that holds while its rule changes shows too.
 */

const CODE = /^\W*(B[1-4])\b/i;

// One code per blocker: B1–B4 from its prefix, else `unknown` (never dropped: it is still a blocker).
export function blockerCodesOf(blockers) {
  if (!Array.isArray(blockers)) return [];
  const codes = blockers.map((b) => String(b).match(CODE)?.[1].toUpperCase() ?? 'unknown');
  return [...new Set(codes)].sort();
}

const verdictOf = (r) => (r.error ? 'error' : r.label ?? 'none');
const sameCodes = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
const changes = (values, same = (a, b) => a === b) => values.slice(1).filter((v, i) => !same(v, values[i])).length;

// results: the `results` array of a results file. expectedBlockers: optional { case_id: ['B2'] } from the dataset.
export function buildCaseReport(results, { expectedBlockers = {} } = {}) {
  const byCase = new Map();
  for (const r of results ?? []) {
    if (!byCase.has(r.case_id)) byCase.set(r.case_id, []);
    byCase.get(r.case_id).push(r);
  }
  const cases = [...byCase].map(([caseId, runs]) => {
    runs.sort((a, b) => a.repeat - b.repeat);
    // A skipped run records no expected label: take it from the case's other runs.
    const expected = runs.find((r) => r.expected_label != null)?.expected_label ?? null;
    const repeats = runs.map((r) => {
      const verdict = verdictOf(r);
      return { repeat: r.repeat, verdict, correct: expected != null && verdict === expected, codes: r.error ? [] : blockerCodesOf(r.output?.blockers) };
    });
    const verdicts = repeats.map((r) => r.verdict);
    const nIncorrect = repeats.filter((r) => !r.correct).length;
    const flips = changes(verdicts);
    const kind = flips > 0 ? 'inconsistent' : nIncorrect === repeats.length ? 'consistently_wrong' : 'stable';
    return {
      case_id: caseId,
      tags: runs[0].tags ?? [],
      expected,
      expected_codes: expectedBlockers[caseId] ?? null,
      repeats,
      n_incorrect: nIncorrect,
      flips,
      blocker_flips: changes(repeats.map((r) => r.codes), sameCodes),
      kind,
    };
  });
  // Most incorrect repeats first, then most verdict flips, then most blocker-code changes; id breaks ties.
  cases.sort((a, b) => b.n_incorrect - a.n_incorrect || b.flips - a.flips || b.blocker_flips - a.blocker_flips
    || (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0));
  const count = (kind) => cases.filter((c) => c.kind === kind).length;
  return {
    n_cases: cases.length,
    n_runs: cases.reduce((s, c) => s + c.repeats.length, 0),
    incorrect_runs: cases.reduce((s, c) => s + c.n_incorrect, 0),
    inconsistent: count('inconsistent'),
    consistently_wrong: count('consistently_wrong'),
    stable: count('stable'),
    blocker_unstable: cases.filter((c) => c.flips === 0 && c.blocker_flips > 0).length,
    cases,
  };
}

const cell = (codes) => (codes.length ? codes.join(',') : '—');
const runCell = (r) => `${r.verdict}${r.correct ? '' : ' ✗'} ${cell(r.codes)}`;

// Markdown. all: every case; otherwise only cases with a wrong repeat, a verdict flip or a blocker-code change.
export function formatCaseReport(report, { all = false } = {}) {
  const width = Math.max(1, ...report.cases.map((c) => c.repeats.length));
  const lines = [
    '## Case diagnostics',
    '',
    `${report.n_cases} cases / ${report.n_runs} runs · ${report.incorrect_runs} incorrect runs · `
      + `inconsistent ${report.inconsistent} · consistently wrong ${report.consistently_wrong} · stable ${report.stable}`
      + ` (of which blocker codes change across repeats: ${report.blocker_unstable})`,
    '',
  ];
  const shown = report.cases.filter((c) => all || c.n_incorrect > 0 || c.flips > 0 || c.blocker_flips > 0);
  if (!shown.length) return [...lines, 'Every case is stable and correct, with the same blocker codes on every repeat.', ''].join('\n');
  const heads = Array.from({ length: width }, (_, i) => `#${i + 1}`);
  lines.push(`| case | kind | expected | ${heads.join(' | ')} | wrong | flips | code changes |`,
    `|---|---|---|${heads.map(() => '---').join('|')}|---|---|---|`);
  for (const c of shown) {
    const runs = Array.from({ length: width }, (_, i) => (c.repeats[i] ? runCell(c.repeats[i]) : ''));
    const expected = `${c.expected ?? '?'}${c.expected_codes ? ` ${cell(c.expected_codes)}` : ''}`;
    lines.push(`| ${c.case_id} | ${c.kind} | ${expected} | ${runs.join(' | ')} | ${c.n_incorrect}/${c.repeats.length} | ${c.flips} | ${c.blocker_flips} |`);
  }
  lines.push('', '✗ = repeat whose verdict differs from the expected one; codes are the B1–B4 prefixes of its blockers (`unknown`: no such prefix).', '');
  return lines.join('\n');
}
