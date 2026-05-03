import { hasCoverageSignal } from './lib/coverage_checker.mjs';

function buildAutomationGateContext({ modifiedFiles }) {
  const isAutomationScope = modifiedFiles.some(file =>
    ['.github/workflows/', 'scripts/', 'prompts/', 'docs/code-generation.md'].some(prefix =>
      file.startsWith(prefix)
    )
  );

  if (!isAutomationScope) return {};

  return {
    unitTestStatus: detectUnitTestExecution(modifiedFiles),
    coverageThreshold: 80,
    hasCoverage: hasCoverageSignal(modifiedFiles),
    documentationStatus: checkDocsUpdated(modifiedFiles)
  };
}

function detectUnitTestExecution(files) {
  return files.some(file =>
    file.includes('__tests__') ||
    file.endsWith('.test.mjs') ||
    file.endsWith('.spec.js')
  ) ? 'EXECUTED' : 'PENDING';
}

function checkDocsUpdated(files) {
  return files.includes('docs/code-generation.md') ? 'UPDATED' : 'PENDING';
}

// Main review logic
if (!prNumber) {
  prNumber = prs[0].number;
}