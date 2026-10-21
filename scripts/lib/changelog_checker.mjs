// Core logic for the changelog gate — extracted for unit testability.

export const ENTRYPOINT_RE = /^scripts\/[^/]+\.mjs$/;
export const ADR_RE = /^docs\/adr\/\d{4}-[^/]+\.md$/;
// What a repository using the pipeline from elsewhere depends on (ADR-0045): the reusable workflows, the
// caller templates and the snapshot of the workflows' interface. Changing one is a release note.
export const REUSABLE_WORKFLOW_RE = /^\.github\/workflows\/adl-[^/]+\.yml$/;
export const CALLER_TEMPLATE_RE = /^templates\/consumer\/[^/]+\.yml$/;
export const INTERFACE_SNAPSHOT_RE = /^docs\/workflow-interface\.json$/;

export function matchesTrigger(filePath) {
  return ENTRYPOINT_RE.test(filePath) || ADR_RE.test(filePath) || REUSABLE_WORKFLOW_RE.test(filePath)
    || CALLER_TEMPLATE_RE.test(filePath) || INTERFACE_SNAPSHOT_RE.test(filePath);
}

export function findTriggerFiles(changedFiles) {
  return changedFiles.filter(matchesTrigger);
}

/**
 * Returns true when the CHANGELOG.md diff contains at least one added non-empty
 * line inside the ## [Unreleased] section.
 *
 * Uses changelogContent (post-change file) to find section boundaries so the
 * check works even when the ## [Unreleased] heading is not in the diff hunk
 * (e.g. when adding a bullet to a long existing section).
 */
export function hasUnreleasedEntry(diff, changelogContent = '') {
  // Find [Unreleased] section boundaries (1-indexed line numbers) in the post-change file.
  const fileLines = changelogContent.split('\n');
  let sectionStart = -1;
  let sectionEnd = fileLines.length + 1;

  for (let i = 0; i < fileLines.length; i++) {
    if (/^## \[Unreleased\]/i.test(fileLines[i])) {
      sectionStart = i + 2; // 1-indexed line after the heading
    } else if (sectionStart !== -1 && /^## \[/.test(fileLines[i])) {
      sectionEnd = i + 1;   // 1-indexed line of the next section heading
      break;
    }
  }

  if (sectionStart === -1) return false;

  // Walk the diff, tracking new-file line numbers via @@ hunk headers.
  let newLineNum = 0;
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLineNum = parseInt(hunk[1], 10); continue; }

    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    if (line.startsWith('+')) {
      if (newLineNum >= sectionStart && newLineNum < sectionEnd &&
          /^[-*] /.test(line.slice(1))) return true;
      newLineNum++;
    } else if (!line.startsWith('-')) {
      newLineNum++; // context line
    }
    // removed lines (-) do not advance the new-file counter
  }

  return false;
}
