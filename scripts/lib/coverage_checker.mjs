export function extractChangedFiles(rawDiffText) {
  const files = [];
  for (const line of String(rawDiffText || '').split('\n')) {
    const addMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (addMatch) { files.push(addMatch[1]); continue; }
    // Capture deleted files (path only appears on --- a/... line; +++ side is /dev/null)
    const delMatch = line.match(/^--- a\/(.+)$/);
    if (delMatch) files.push(delMatch[1]);
  }
  return [...new Set(files)];
}

export function isAutomationScopeFile(filePath) {
  return (
    filePath.startsWith('.github/workflows/') ||
    filePath.startsWith('scripts/') ||
    filePath.startsWith('prompts/') ||
    filePath === 'docs/code-generation.md'
  );
}

export function buildAutomationGateContext(rawDiffText) {
  const changedFiles = extractChangedFiles(rawDiffText);
  const automationScope = changedFiles.some(isAutomationScopeFile);
  if (!automationScope) return '';

  const hasUnitTestChanges = changedFiles.some(
    (filePath) => filePath.startsWith('scripts/tests/') || /(^|\/)tests?\/.+\.test\.mjs$/.test(filePath),
  );
  const hasDocsUpdates = changedFiles.some((filePath) => filePath.startsWith('docs/'));
  const hasCoverageSignal = /coverage|min(?:imum)?\s+coverage|unit[-\s]?test coverage/i.test(rawDiffText);

  // Extract any explicit minimum coverage percentage stated in the diff (e.g. "coverage 80%" or "80% coverage")
  const pctMatch = rawDiffText.match(/\b(\d{1,3})\s*%\s*(?:minimum\s+)?(?:unit[-\s]?test\s+)?coverage\b|coverage[:\s]+(\d{1,3})\s*%/i);
  const minimumCoveragePctStated = pctMatch ? (pctMatch[1] || pctMatch[2]) : null;

  return `

Automation gates context:
- automation_scope: true
- changed_files: ${changedFiles.join(', ') || '(none)'}
- unit_test_updates_present: ${hasUnitTestChanges}
- docs_updates_present: ${hasDocsUpdates}
- coverage_signal_present: ${hasCoverageSignal}
- minimum_coverage_pct_stated: ${minimumCoveragePctStated ?? 'not stated'}

Use this context while deciding whether to request changes.`;
}
