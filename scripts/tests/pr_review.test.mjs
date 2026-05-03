import { reviewPR } from '../pr_review.mjs';

// Existing tests...

// New test for unit-test gate enforcement
describe('Automation scope unit-test gate', () => {
  it('should request changes when script modified without unit test updates', async () => {
    const mockDiff = 'diff --git a/scripts/example.js b/scripts/example.js\nindex 123..456\n--- a/scripts/example.js\n+++ b/scripts/example.js\n@@ -1,2 +1,3 @@\n console.log(1);
 console.log(2);
+console.log(3);
';

    const result = await reviewPR({
      diff: mockDiff,
      unit_test_updates_present: false
    });

    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.comments).toContain('Missing required unit-test updates');
  });
});

describe('Automation scope coverage gate', () => {
  it('should request changes when script modified without coverage documentation', async () => {
    const mockDiff = 'diff --git a/scripts/example.js b/scripts/example.js\nindex 123..456\n--- a/scripts/example.js\n+++ b/scripts/example.js\n@@ -1,2 +1,3 @@\n console.log(1);
 console.log(2);
+console.log(3);
';

    const result = await reviewPR({
      diff: mockDiff,
      coverage_documentation_present: false
    });

    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.comments).toContain('Missing minimum coverage documentation');
  });
});