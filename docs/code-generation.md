# Code Generation Guidelines

## Testing Requirements
All automation logic changes must maintain:
- Minimum 80% unit test coverage for core workflows
- 100% coverage for error handling and security-critical paths
- Explicit test documentation in PR descriptions

## Coverage Enforcement
CI pipelines will fail if:
- New automation logic introduces uncovered code
- Test coverage drops below 80% for any module
- Label reset workflow tests don't verify DELETE/POST sequence

## Workflow Documentation
Critical automation behavior must include:
1. PR creation workflow steps
2. Label management sequence diagrams
3. Test coverage policy references

## Automation Gates
PR validation requires:
- [x] Unit test updates
- [x] Documentation updates
- [x] 100% test coverage enforcement

## Core Workflow Sequence
1. Label removal via DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}
2. Label application via POST /repos/{owner}/{repo}/issues/{issue_number}/labels

[Original guidelines content preserved...]