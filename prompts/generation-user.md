Create a small, safe repository patch from a GitHub issue.

Deterministic issue data:
- issue_number: {{issueNumber}}
- issue_title: {{issueTitle}}
- issue_body: {{issueBody}}

Requirements:
1) Keep scope small and non-destructive.
2) Modify existing files when possible. Only create new files if strictly necessary.
3) MAXIMUM 3 files total. If the task seems to need more, consolidate: combine entry point + component into one file, use a zero-config bundler that needs no config file, inline styles instead of a separate CSS file, etc.
4) Changes must directly address the issue. No speculative improvements.
5) Prefer focused, coherent changes over broad refactors.
6) Generated code must be syntactically valid and consistent. No unresolved imports or references.
7) Every path must be relative (no ../ and no absolute paths).
8) Do not add explanations, comments, or metadata outside the required output.

Example of fitting a React app into 3 files: package.json (Parcel or similar zero-config bundler, no bundler config file needed), index.html, src/index.jsx.

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
