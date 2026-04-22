Create a small, safe repository patch from a GitHub issue.

Deterministic issue data:
- issue_number: {{issueNumber}}
- issue_title: {{issueTitle}}
- issue_body: {{issueBody}}

Requirements:
1) Keep scope small and non-destructive.
2) Propose 1 to 3 file creations/updates based on the issue (never more than 3 files).
3) Prefer focused, coherent changes over broad refactors.
4) Every path must be relative (no ../ and no absolute paths).
5) Return only final file contents, no surrounding explanations.

Output JSON only:
{
  "summary": "One sentence summary of the generated change",
  "changes": [
    {
      "target_path": "relative/path/to/file.ext",
      "file_content": "Exact content to write in the file"
    }
  ]
}
