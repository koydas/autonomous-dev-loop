export function buildAutomationGateContext(diffText) {
  const hasCoverageChanges = diffText.includes('coverage');
  const hasDocsChanges = diffText.includes('docs/code-generation.md');
  const hasTestChanges = diffText.includes('test') || diffText.includes('spec');

  // Enforce minimum coverage threshold (80%)
  const coverageThreshold = 80;
  const currentCoverage = 75; // Example value - would be dynamically calculated

  return {
    hasCoverageChanges,
    hasDocsChanges,
    hasTestChanges,
    coverageThreshold,
    currentCoverage,
    coverageValid: currentCoverage >= coverageThreshold
  };
}

export function hasDocsUpdates(diffText) {
  // Restrict to only docs/code-generation.md
  return diffText.includes('docs/code-generation.md');
}

export function extractChangedFiles(rawDiffText) {
  const files = [];
  for (const line of String(rawDiffText || '').split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) {
      files.push(match[1]);
    }
  }
  return files;
}