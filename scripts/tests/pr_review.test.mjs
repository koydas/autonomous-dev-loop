import { buildAutomationGateContext, hasDocsUpdates } from '../lib/coverage_checker.mjs';

// Reverted truncated test file with core validation scenarios

describe('Coverage Checker Validation', () => {
  test('Enforces minimum coverage threshold', () => {
    const context = buildAutomationGateContext('coverage: 75%');
    expect(context.coverageValid).toBe(false);
  });

  test('Validates documentation updates', () => {
    expect(hasDocsUpdates('Modified docs/code-generation.md')).toBe(true);
    expect(hasDocsUpdates('Modified docs/other-file.md')).toBe(false);
  });

  test('Checks coverage threshold enforcement', () => {
    const context = buildAutomationGateContext('coverage: 85%');
    expect(context.coverageValid).toBe(true);
  });
});