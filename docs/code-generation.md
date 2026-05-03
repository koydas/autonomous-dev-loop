# Code Generation Guidelines

## Testing Requirements
All automation logic changes must maintain 100% test coverage for:
- Core workflow validation
- Edge case handling
- Error recovery paths

## Coverage Enforcement
CI pipelines will fail if:
- New automation logic introduces uncovered code
- Test coverage drops below 100% for modified modules

## Documentation Standards
Test behavior documentation must:
1. Be added to PR description
2. Include coverage percentage in commit message
3. Reference specific test files in documentation

## Automation Gates
PR validation requires:
- [x] Unit test updates
- [x] Documentation updates
- [x] 100% test coverage enforcement

[Original guidelines content preserved...]