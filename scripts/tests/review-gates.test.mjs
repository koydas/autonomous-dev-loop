import { validateAutomationGates } from '../lib/review_rules.mjs';

// Test suite for automation-scope PR review gates
// Verifies enforcement of mandatory test/documentation/coverage gates

// Mock PR diff scenarios
test('Returns REQUEST_CHANGES when automation logic changes without test evidence', () => {
  const mockDiff = {
    modifiedFiles: ['.github/workflows/test-workflow.yml', 'prompts/pr-review-system.md'],
    hasTestUpdates: false
  };

  const result = validateAutomationGates(mockDiff);
  expect(result.verdict).toBe('REQUEST_CHANGES');
  expect(result.issues).toContainEqual(
    expect.objectContaining({
      severity: 'MEDIUM',
      file: 'pr-review-system.md',
      message: 'Missing unit-test execution evidence for automation-scope logic'
    })
  );
});

test('Approves automation changes with proper test coverage', () => {
  const mockDiff = {
    modifiedFiles: ['scripts/generate_pr.mjs', 'docs/code-generation.md'],
    hasTestUpdates: true
  };

  const result = validateAutomationGates(mockDiff);
  expect(result.verdict).toBe('APPROVED');
  expect(result.issues).toHaveLength(0);
});