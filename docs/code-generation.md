# Code Generation
## Introduction
This document outlines the code generation process.
## Automation Documentation
The PostToolUse hook is used to trigger tests on script/workflow edits. This hook is configured in .claude/settings.json and is triggered when a file in the scripts/ or .github/workflows/ directories is edited.
## Test Coverage Requirements
The test coverage requirements for automation workflows are as follows: at least 80% of the code must be covered by unit tests.