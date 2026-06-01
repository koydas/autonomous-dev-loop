// Core logic for the changelog gate — extracted for unit testability.

export const ENTRYPOINT_RE = /^scripts\/[^/]+\.mjs$/;
export const ADR_RE = /^docs\/adr\/\d{4}-[^/]+\.md$/;

export function matchesTrigger(filePath) {
  return ENTRYPOINT_RE.test(filePath) || ADR_RE.test(filePath);
}

export function findTriggerFiles(changedFiles) {
  return changedFiles.filter(matchesTrigger);
}

/**
 * Returns true when the CHANGELOG.md diff contains at least one added non-empty
 * line inside the ## [Unreleased] section (before the next dated ## [...] heading).
 */
export function hasUnreleasedEntry(diff) {
  const lines = diff.split('\n');
  let inUnreleased = false;

  for (const line of lines) {
    if (
      line.startsWith('diff ') || line.startsWith('index ') ||
      line.startsWith('--- ') || line.startsWith('+++ ') ||
      line.startsWith('@@ ')
    ) continue;

    const isAdded = line.startsWith('+');
    const content = line.slice(1);

    if (/^## \[Unreleased\]/i.test(content)) {
      inUnreleased = true;
      continue;
    }

    if (inUnreleased) {
      if (/^## \[/.test(content)) break;          // next dated section — stop
      if (isAdded && content.trim().length > 0) return true;
    }
  }

  return false;
}
