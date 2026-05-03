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

  return `\n\nAutomation gates context:\n- automation_scope: true\n- changed_files: ${changedFiles.join(', ') || '(none)'}\n- unit_test_updates_present: ${hasUnitTestChanges}\n- docs_updates_present: ${hasDocsUpdates}\n- coverage_signal_present: ${hasCoverageSignal}\n\nUse this context while deciding whether to request changes.`;
}
