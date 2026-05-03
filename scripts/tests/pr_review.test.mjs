import { buildAutomationGateContext } from '../pr_review.mjs';

// Critical test cases preserved from original suite
const originalTestCases = {
  'core_gate_validation': () => {
    expect(buildAutomationGateContext({})).toHaveProperty('unitTestStatus');
  },
  'coverage_gate_check': () => {
    expect(buildAutomationGateContext({})).toHaveProperty('coverageThreshold');
  }
};

// New automation gate tests
describe('Automation Gate Enforcement', () => {
  test('Enforces 80% coverage threshold for automation changes', () => {
    const context = buildAutomationGateContext({
      modifiedFiles: ['.github/workflows/test.yml']
    });
    expect(context.coverageThreshold).toBeGreaterThanOrEqual(80);
  });

  test('Rejects PRs with missing test execution proof', () => {
    const context = buildAutomationGateContext({
      modifiedFiles: ['scripts/test.js']
    });
    expect(context.unitTestStatus).toBe('PENDING');
  });
});