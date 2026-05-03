import { buildAutomationGateContext } from '../lib/coverage_checker.js';
import assert from 'assert';

describe('PR Review Automation Gates', () => {
  it('should inject automation gate context for scope changes', () => {
    const mockDiff = `diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml
new file mode 100644
+++ b/.github/workflows/test.yml
@@ -0,0 +1 @@
+new workflow config
`; 

    const gateContext = buildAutomationGateContext(mockDiff);
    assert.strictEqual(gateContext.includes('unit-test status is explicitly reviewed'), true, 'Missing unit-test gate check');
    assert.strictEqual(gateContext.includes('documentation updates are required'), true, 'Missing docs gate check');
    assert.strictEqual(gateContext.includes('minimum unit-test coverage expectations'), true, 'Missing coverage gate check');
  });
});