Review this pull request diff.

Issue that triggered this PR:
Title: {{issueTitle}}
Body:
{{issueBody}}

Diff:
{{diff}}

Use the issue content to determine intent. Flag any diff behavior that contradicts or exceeds the stated scope of the issue.

## 🔍 Automated Code Review

### 🏷️ Change Classification
State the detected change type and whether tests are expected for this PR.
Format: "Type: <type> | Tests expected: <yes/no> — <one-sentence reason>"

### ✅ Summary
(1–3 lines describing only what changed in the diff)

### 🔬 Adversarial Analysis
- **Robustness** — <risk file:line, or none + what you checked>
- **Side effects** — <same>
- **Type integrity** — <same>
- **Issue fit** — <same>

### ⚠️ Issues Found
List only actionable issues from the diff.
Use one bullet per issue with this format:
- [High|Medium|Low] <short title> — File: <path> Lines: <start[-end]|unknown> Root cause: <one sentence> Fix: <one sentence> Axis: <robustness|side_effects|types|issue_fit|other>

If none found, write: None.

### 🚀 Verdict
(APPROVED | REQUEST_CHANGES)

Constraints:
- Max 320 words, analysis lines 25 words at most
- No generic advice
- No repetition
- If tests_expected is false in the classification context, omit all test-coverage findings
