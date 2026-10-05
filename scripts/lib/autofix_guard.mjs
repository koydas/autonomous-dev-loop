import path from 'node:path';

// Deterministic write guard for auto-fix (ADR-0028). The model returns whole-file contents,
// so anything it did not see in full is at risk of being dropped. Prompt guardrails
// (ADR-0009) ask the model not to do that; this module enforces it before anything is written.

export const MAX_DELETED_LINE_RATIO = 0.3;
export const MIN_DELETED_LINES_ALLOWED = 20;

const TEST_FILE_PATTERN = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_CALL_PATTERN = /\b(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/g;

export function normalizeRepoPath(p) {
  return path.posix.normalize(String(p ?? '').replaceAll('\\', '/')).replace(/^(\.\/)+/, '');
}

export function isTestFile(p) {
  return TEST_FILE_PATTERN.test(normalizeRepoPath(p));
}

export function countTestCalls(content) {
  return (String(content ?? '').match(TEST_CALL_PATTERN) || []).length;
}

// Lines of `before` with no counterpart in `after` (multiset difference, blank lines ignored).
// Order-insensitive on purpose: a moved block is not a deletion.
export function countDeletedLines(before, after) {
  const remaining = new Map();
  for (const line of String(after ?? '').split('\n')) {
    const key = line.trim();
    if (key) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let deleted = 0;
  let total = 0;
  for (const line of String(before ?? '').split('\n')) {
    const key = line.trim();
    if (!key) continue;
    total += 1;
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else deleted += 1;
  }
  return { deleted, total };
}

/**
 * Returns the list of guard violations for a validated set of changes; empty means safe to write.
 *
 * @param {{ targetPath: string, fileContent: string }[]} changes
 * @param {{ existing: Map<string, string|null>, shownPaths: Set<string>, hiddenPaths: Set<string> }} context
 *   existing: current on-disk content per normalized target path (null when the file does not exist);
 *   shownPaths: files included in full in the prompt; hiddenPaths: files withheld for size/budget.
 * @returns {{ targetPath: string, reason: string }[]}
 */
export function findUnsafeChanges(changes, { existing, shownPaths, hiddenPaths }) {
  const violations = [];
  for (const { targetPath, fileContent } of changes) {
    const key = normalizeRepoPath(targetPath);
    const before = existing.get(key) ?? null;
    if (before === null) continue; // new file: nothing to lose

    if (hiddenPaths.has(key)) {
      violations.push({ targetPath, reason: 'file was withheld from the prompt (too large for the context budget)' });
      continue;
    }
    if (!shownPaths.has(key)) {
      violations.push({ targetPath, reason: 'existing file was not shown to the model' });
      continue;
    }

    const { deleted, total } = countDeletedLines(before, fileContent);
    const limit = Math.max(MIN_DELETED_LINES_ALLOWED, Math.floor(total * MAX_DELETED_LINE_RATIO));
    if (deleted > limit) {
      violations.push({ targetPath, reason: `removes ${deleted} of ${total} non-blank lines (limit ${limit})` });
      continue;
    }

    if (isTestFile(key)) {
      const beforeTests = countTestCalls(before);
      const afterTests = countTestCalls(fileContent);
      if (afterTests < beforeTests) {
        violations.push({ targetPath, reason: `test count drops from ${beforeTests} to ${afterTests}` });
      }
    }
  }
  return violations;
}
