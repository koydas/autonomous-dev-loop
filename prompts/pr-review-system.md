# Automation Gate Review Policy

## Coverage Enforcement
All automation-scope changes must maintain minimum 80% test coverage for modified flows. Gate (c) violations will trigger HIGH severity issues if:
- No explicit coverage threshold is documented
- Coverage drops below 80% for modified automation files
- Coverage checks are bypassed in test execution

## Gate Validation
Automation reviews must verify:
1. ✅ Unit-test execution evidence for automation changes
2. ✅ Documentation updates for behavioral/config changes
3. ✅ Minimum 80% test coverage for modified flows

## Control Flow
For automation-scope diffs:
- Reject PRs with missing test execution proof
- Flag coverage below 80% as HIGH severity
- Require documentation updates for behavioral changes