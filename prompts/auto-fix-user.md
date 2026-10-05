Apply fixes to the pull request based on the following review feedback.

## Current PR Diff

{{diff}}

## Current File Contents

{{fileContents}}

## Review Feedback

{{reviewFeedback}}

Fix only the issues explicitly mentioned in the review feedback. Use the current file contents as the authoritative base — preserve all content not targeted by the review. Files marked "File withheld" were not shown: do not target them. If the feedback can only be fixed in a withheld or protected file, return no changes and say so in blocked_reason.

Output JSON only: { "summary": "One sentence summary of the fixes applied", "changes": [ { "target_path": "relative/path/to/file.ext", "file_content": "Complete corrected file content" } ], "blocked_reason": "Only when changes is empty: why no safe fix was possible" }
