// Active lessons of the meta-loop (ADR-0051): recurring adverse signals recorded by the pipeline itself become
// a short block of constraints appended to the system prompt of the next generation and auto-fix runs.
//
// What makes this safe where ADR-0046 forbade the meta-loop to edit prompts:
//   - the signals are a closed vocabulary (guardrail rule ids, review axis ids) written by code, never text a model
//     or a pull request produced; a line carrying anything else counts for nothing;
//   - the text injected is the fixed catalog below, written and reviewed by people like any other prompt text: no
//     model output, issue body, review comment or run record string is ever copied into a prompt;
//   - a lesson restates a rule the prompt already has (the guardrails of ADR-0009, the review axes): it can make the
//     model more careful, never relax a rule, and `LESSONS` is the only place that decides what may be said;
//   - it is bounded (MAX_LESSONS, MAX_LESSONS_CHARS), expires with the window, and a failure to read the signals
//     means no lessons, never a failed run (see lessons_loader.mjs).
// Pure, deterministic, no LLM.

/** Stages whose prompt receives lessons: the two that write code. The reviewer is not told what to look for by its past verdicts. */
export const LESSON_STAGES = Object.freeze(['generation', 'autofix']);

/** Signal ids → the constraint they teach. `rule:` = a guardrail rejection of the write guard; `axis:` = a review axis on a blocking finding. */
export const LESSONS = Object.freeze({
  'rule:module_system': 'Keep every file in its module system: `.mjs` is ESM (`import`/`export` only, never `require`), CJS files stay CJS.',
  'rule:exported_signature': 'Do not rename, re-type or change the return type of an exported function unless the task names that function.',
  'rule:unresolved_import': 'Import only what exists: a relative path that resolves, or a package already imported in the file or listed in package.json.',
  'rule:unshown_file': 'Edit only files whose full content is shown above; never invent the content of a file you were not given.',
  'rule:withheld_file': 'Never target a file marked as withheld: its content was not shown, so a rewrite would delete it.',
  'rule:mass_deletion': 'Make targeted edits: removing more than half of an existing file is rejected, so keep every line the task does not ask to remove.',
  'rule:test_count_drop': 'A test file keeps every existing test: only add cases, or change the one the task names.',
  'axis:robustness': 'Reviews blocked patches for robustness: handle empty, null, boundary and failing inputs explicitly, and cover each with a test.',
  'axis:side_effects': 'Reviews blocked patches for side effects: before changing a function, check its callers and shared state, and touch nothing the task does not ask for.',
  'axis:types': 'Reviews blocked patches for type integrity: keep signatures, return shapes and coercions consistent with their callers and with the existing code.',
  'axis:issue_fit': 'Reviews blocked patches for not matching the issue: implement exactly what it asks, with its acceptance criteria met, and nothing beyond it.',
});

/** Signals counted over the newest lines carrying one, and how many occurrences make a lesson. */
export const WINDOW = 30;
export const MIN_OCCURRENCES = 2;
/** A signal older than this is not recurring, it is history. */
export const MAX_AGE_DAYS = 30;
export const MAX_LESSONS = 3;
export const MAX_LESSONS_CHARS = 700;

const DAY_MS = 86400000;

/**
 * The signals of one `metrics/runs.jsonl` line: `rule:<id>` per rule of a guardrail rejection (`codegen_skip`,
 * `autofix_skip`), `axis:<id>` per axis of a `review_signal`. Anything outside `LESSONS` is dropped here, so an
 * unknown or forged value cannot reach a prompt. `ts` is the line's timestamp in ms, or null.
 * @returns {{ id: string, ts: number | null }[]}
 */
export function signalsOfLine(line) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return [];
  const ts = typeof line.ts === 'string' && !Number.isNaN(Date.parse(line.ts)) ? Date.parse(line.ts) : null;
  let ids = [];
  if ((line.type === 'codegen_skip' || line.type === 'autofix_skip') && line.reason === 'guardrail_rejected' && Array.isArray(line.rules)) {
    ids = line.rules.map((r) => `rule:${r}`);
  } else if (line.type === 'review_signal' && Array.isArray(line.axes)) {
    ids = line.axes.map((a) => `axis:${a}`);
  }
  return [...new Set(ids)].filter((id) => Object.hasOwn(LESSONS, id)).map((id) => ({ id, ts }));
}

/**
 * Parses the text of `metrics/runs.jsonl` into signals, oldest first. A line that is not JSON is skipped.
 * Only the last `maxLines` lines are read: the file only grows.
 */
export function parseSignals(text, { maxLines = 2000 } = {}) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim()).slice(-maxLines);
  const signals = [];
  for (const raw of lines) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    signals.push(...signalsOfLine(parsed));
  }
  return signals;
}

/**
 * The active lessons: signals that occur at least `minOccurrences` times among the newest `window` signals no older
 * than `maxAgeDays`, most frequent first (ties by catalog order), at most `max`. A signal with no timestamp counts
 * as current: the window is its only bound.
 * @returns {{ id: string, count: number, text: string }[]}
 */
export function extractLessons(signals, { now = Date.now(), window = WINDOW, minOccurrences = MIN_OCCURRENCES, maxAgeDays = MAX_AGE_DAYS, max = MAX_LESSONS } = {}) {
  const recent = (Array.isArray(signals) ? signals : [])
    .filter((s) => Object.hasOwn(LESSONS, s?.id) && (s.ts == null || now - s.ts <= maxAgeDays * DAY_MS))
    .slice(-window);
  const counts = new Map();
  for (const { id } of recent) counts.set(id, (counts.get(id) ?? 0) + 1);
  const order = Object.keys(LESSONS);
  return [...counts.entries()]
    .filter(([, count]) => count >= minOccurrences)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .slice(0, max)
    .map(([id, count]) => ({ id, count, text: LESSONS[id] }));
}

/**
 * The block appended to a system prompt, or '' when there is no lesson or the stage does not take them. Whole
 * lessons only: one that would push the block over `maxChars` is left out, never cut.
 */
export function formatLessonsContext(lessons, stage, { maxChars = MAX_LESSONS_CHARS } = {}) {
  if (!LESSON_STAGES.includes(stage) || !Array.isArray(lessons) || lessons.length === 0) return '';
  const head = '\n\nLEARNED CONSTRAINTS — rules this repository\'s recent runs broke again and again. They restate the rules above and never relax them:';
  let block = head;
  for (const { text, count } of lessons) {
    const line = `\n- ${text} (seen ${count} times recently)`;
    if (block.length + line.length > maxChars) break;
    block += line;
  }
  return block === head ? '' : block;
}
