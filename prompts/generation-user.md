Create a small, safe repository patch from a GitHub issue.

Deterministic issue data:
* issue_number: {{issueNumber}}
* issue_title: {{issueTitle}}
* issue_body: {{issueBody}}

Current repository files relevant to this issue are provided below. If an "Allowed npm dependencies" list is present, it is the exhaustive set of external packages you may import from — anything else must be a relative project import or a language/runtime built-in.
You MUST use these as the base for any modifications — do not reconstruct file content from memory or assumptions.

{{fileContents}}

Requirements:
1. Preserve all existing content not targeted by the issue. Never delete sections, headings, or content unless explicitly requested in the issue.
2. Modify existing files when possible. Only create new files if strictly necessary.
3. Propose 1 to 6 file creations/updates (never more than 6 files).
4. Changes must directly address the issue. No speculative improvements.
5. Prefer focused, coherent changes over broad refactors.
6. Generated code must be syntactically valid and consistent. No unresolved imports or references.
7. Every path must be relative (no ../ and no absolute paths).
8. If a file is shown in the provided current content block and you modify it, preserve unchanged sections verbatim and apply minimal edits.
9. If the issue requires information that is missing from the issue text or provided files, choose the safest minimal implementation and avoid inventing external APIs/contracts.
10. Do not add explanations, comments, or metadata outside the required output.
11. Include/update unit tests whenever the issue explicitly requests them, or whenever the change introduces new non-trivial logic (a function, class, hook, component, or endpoint) — regardless of the target file's path — so the change is verifiable. For changes in scripts/, prompts/, or .github/workflows/ specifically, this also means keeping/raising minimum unit test coverage expectations for the touched behavior.
12. When workflow behavior, setup, or operator expectations change, update docs/code-generation.md in the same patch.

Output JSON only: { "summary": "One sentence summary of the generated change", "changes": [ { "target_path": "relative/path/to/file.ext", "file_content": "Exact content to write in the file" } ] }
