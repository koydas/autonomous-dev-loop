Create exactly one repository file change from a GitHub issue.

Deterministic issue data:
- issue_number: {{issueNumber}}
- issue_title: {{issueTitle}}
- issue_body: {{issueBody}}

Requirements:
1) Keep scope small and non-destructive.
2) Propose exactly one file creation or update (never multiple files).
3) The path must be relative (no ../ and no absolute paths).
4) Return only the final file content, no surrounding explanations.

Output JSON only:
{
  "summary": "One sentence summary of the generated change",
  "target_path": "relative/path/to/file.ext",
  "file_content": "Exact content to write in the file"
}