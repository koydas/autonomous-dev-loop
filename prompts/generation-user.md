Create a small, safe repository patch from a GitHub issue.

Deterministic issue data:
- issue_number: {{issueNumber}}
- issue_title: {{issueTitle}}
- issue_body: {{issueBody}}

Requirements:
1) Keep scope small and non-destructive.
2) Modify existing files when possible. Only create new files if strictly necessary.
3) Propose 1 to 3 file creations/updates (never more than 3 files).
4) Changes must directly address the issue. No speculative improvements.
5) Prefer focused, coherent changes over broad refactors.
6) Generated code must be syntactically valid and consistent. No unresolved imports or references.
7) Every path must be relative (no ../ and no absolute paths).
8) Do not add explanations, comments, or metadata outside the required output.

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
