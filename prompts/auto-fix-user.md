Apply fixes to the pull request based on the following review feedback.

## Review Feedback

{{reviewFeedback}}

## Current PR Diff

{{diff}}

## Current File Contents

{{fileContents}}

Fix only the issues explicitly mentioned in the review feedback. Use the current file contents as the authoritative base — preserve all content not targeted by the review.

Output JSON only: { "summary": "One sentence summary of the fixes applied", "changes": [ { "target_path": "relative/path/to/file.ext", "file_content": "Complete corrected file content" } ] }

Additional constraints for repository automation changes:
- If the fix touches scripts/, prompts/, or .github/workflows/, include necessary unit test updates for the touched behavior and preserve minimum unit test coverage expectations.
- If behavior/config/setup expectations change, include matching updates to docs/code-generation.md.
