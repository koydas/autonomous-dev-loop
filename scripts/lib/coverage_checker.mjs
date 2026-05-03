export function extractChangedFiles(rawDiffText) {
  const files = [];
  for (const line of String(rawDiffText || '').split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) files.push(match[1]);
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

  return `

Automation gates context:
- automation_scope: true
- changed_files: ${changedFiles.join(', ') || '(none)'}
- unit_test_updates_present: ${hasUnitTestChanges}
- docs_updates_present: ${hasDocsUpdates}
- coverage_signal_present: ${hasCoverageSignal}

Use this context while deciding whether to request changes.`;
}
