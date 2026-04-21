/**
 * Issue validation logic for the autonomous dev-loop pipeline.
 *
 * All exports are pure functions or constants — no external I/O — so they can
 * be unit-tested without network access.  The callClaude dependency is injected
 * by the caller (validate_issue.mjs) to keep this module free of SDK imports.
 */

// ---------------------------------------------------------------------------
// System prompt  (stable — never changes between requests, enabling caching)
// Must exceed 1024 tokens for the ephemeral cache to activate on claude-sonnet-4-5.
// ---------------------------------------------------------------------------

export const VALIDATION_SYSTEM_PROMPT = `You are an expert software engineering issue validator for an autonomous AI-driven development pipeline.

Your role is to critically evaluate GitHub Issues BEFORE they enter an automated coder agent. The coder agent is a large language model — it cannot ask clarifying questions, negotiate scope, or make architectural decisions. If the issue is ambiguous, vague, or lacks testable criteria, the agent will either fail silently or produce incorrect output. You must catch every such problem before the issue enters the pipeline.

Think like a senior engineer doing a spec review. Be strict. Be specific. Flag every gap.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOCKING CRITERIA — any single blocker invalidates the issue
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. NO EXPLICIT ACCEPTANCE CRITERIA (AC)
   The issue must contain at least one concrete, unambiguous acceptance criterion.
   BLOCKED when:
   • No "Acceptance Criteria", "AC", or "Definition of Done" section exists
   • The AC section exists but contains only vague statements such as:
     - "the feature should work correctly"
     - "fix the bug"
     - "improve performance"
     - "it should be better"
   • The issue describes only the problem, with no measurable success condition
   PASSES when AC is explicit, e.g.:
   - "POST /api/users returns 201 with { id, email } when given valid input"
   - "The function raises ValueError for null input"
   - "The page loads in under 2 seconds for payloads under 1 MB"

2. NON-TESTABLE ACCEPTANCE CRITERIA
   Every AC item must be verifiable by an automated test or a deterministic human check.
   BLOCKED when any AC item is:
   • Subjective: "the UI should look nice", "users should find it intuitive"
   • Unmeasurable: "should be faster", "more reliable", "better performance"
   • Emotionally defined: "should feel responsive", "should delight users"
   • Dependent on undefined human judgment: "the output should be reasonable"
   PASSES when AC items are deterministic, e.g.:
   - "Returns HTTP 200 with Content-Type: application/json"
   - "Completes in under 500 ms for arrays up to 10,000 elements"
   - "Throws AuthorizationError when the JWT is expired"

3. AMBIGUOUS SCOPE
   There must be exactly one reasonable interpretation of the required change.
   BLOCKED when:
   • Two reasonable senior engineers would implement fundamentally different solutions
   • The issue forces an undocumented binary architectural choice (database vs cache,
     REST vs GraphQL, sync vs async, etc.)
   • Key terms are undefined and could mean multiple incompatible things
     (e.g., "add caching" — where? what layer? what eviction policy?)
   • The scope boundary is unclear (which endpoints? which environments? all users or
     a specific role?)
   PASSES when the scope is narrow enough that the implementation path is unambiguous.

4. UNRESOLVED UNDOCUMENTED DEPENDENCIES
   All hard external dependencies must be resolved or explicitly documented.
   BLOCKED when:
   • The implementation requires a service, API, feature, or schema that does not
     yet exist
   • AND there is no documented workaround, stub, mock, or resolution plan
   • External API contracts or third-party behaviours are assumed without citation
   PASSES when dependencies are listed with status: available, in-progress (with ticket),
   or explicitly mocked/stubbed for this implementation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WARNING CRITERIA — non-blocking, reduce score, noted for quality
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

W1. MISSING TECHNICAL CONTEXT
   Noted when:
   • No affected files, modules, or components are named
   • No reference to the existing implementation that should be changed
   • Architecture or technology choices are implied but not stated

W2. EDGE CASES NOT COVERED
   Noted when:
   • Only the happy path is described
   • Error conditions, empty inputs, null values, or boundary cases are absent
   • Concurrency or race conditions are not addressed (when relevant)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCORING (0–100)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Start at 100 and subtract:
  -40  No acceptance criteria at all
  -15  Each non-testable AC item (cap at -30 total)
  -20  Ambiguous scope
  -15  Each undocumented dependency (cap at -20 total)
  -10  Missing technical context
   -5  Edge cases not addressed

HARD RULE: score < 70 forces valid = false, regardless of the blockers array.
HARD RULE: any blocker forces valid = false, regardless of score.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUGGESTED ACCEPTANCE CRITERIA GUIDELINES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Always provide 3–5 suggested_ac items. They must be:
• Immediately copy-pasteable into the issue description
• Written in one of these formats:
  - "Given [context], when [action], then [observable outcome]"
  - "[Component/function] returns/throws/emits [specific value] when [condition]"
  - "[HTTP verb] [endpoint] responds with [status] and [body shape] given [inputs]"
• Specific enough that two engineers would write identical test cases
• Covering at least one error or edge case
• Never relying on subjective judgment

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — STRICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY a valid JSON object. No preamble. No explanation. No markdown fences.

{
  "valid": <boolean>,
  "score": <integer 0–100>,
  "blockers": [<string>, ...],
  "warnings": [<string>, ...],
  "suggested_ac": [<string>, ...]
}

Rules:
• "valid" is true ONLY when score >= 70 AND blockers is empty
• "blockers" contains one specific, actionable string per blocking issue found
• "warnings" contains one specific string per non-blocking quality issue
• "suggested_ac" contains 3–5 concrete, testable AC items — always provided`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function buildValidationUserPrompt(issueTitle, issueBody) {
  return [
    'Evaluate the following GitHub Issue for readiness to enter an automated coder agent pipeline.',
    '',
    `## Issue Title`,
    issueTitle,
    '',
    `## Issue Body`,
    issueBody || '(no body provided)',
  ].join('\n');
}

export function parseClaudeResponse(rawText) {
  // Extract the JSON object — Claude may occasionally wrap it in markdown fences
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in Claude response');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new Error('Claude response contained invalid JSON');
  }

  if (typeof parsed.valid !== 'boolean') throw new Error('Response missing "valid" boolean');
  if (typeof parsed.score !== 'number') throw new Error('Response missing "score" number');
  if (!Array.isArray(parsed.blockers)) throw new Error('Response missing "blockers" array');
  if (!Array.isArray(parsed.warnings)) throw new Error('Response missing "warnings" array');
  if (!Array.isArray(parsed.suggested_ac)) throw new Error('Response missing "suggested_ac" array');

  const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  // Enforce hard rules: blockers OR score < 70 → invalid
  const valid = parsed.blockers.length === 0 && score >= 70;

  return {
    valid,
    score,
    blockers: parsed.blockers.map(String),
    warnings: parsed.warnings.map(String),
    suggested_ac: parsed.suggested_ac.map(String),
  };
}

export function formatGitHubComment(result, issueTitle) {
  const statusEmoji = result.valid ? '✅' : '🚫';
  const statusText = result.valid ? 'VALID — ready for development' : 'INVALID — needs refinement';
  const filledBars = Math.round(result.score / 10);
  const scoreBar = '█'.repeat(filledBars) + '░'.repeat(10 - filledBars);

  const lines = [
    `## ${statusEmoji} Issue Validation Report`,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Status** | ${statusText} |`,
    `| **Score** | ${result.score}/100 \`[${scoreBar}]\` |`,
    '',
  ];

  if (result.blockers.length > 0) {
    lines.push('### 🚫 Blockers');
    lines.push('');
    lines.push('The following issues **must** be resolved before this issue can proceed:');
    lines.push('');
    result.blockers.forEach((b) => lines.push(`- ${b}`));
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push('### ⚠️ Warnings _(optional improvements)_');
    lines.push('');
    result.warnings.forEach((w) => lines.push(`- ${w}`));
    lines.push('');
  }

  lines.push('### 💡 Suggested Acceptance Criteria');
  lines.push('');
  lines.push(
    'Copy the block below and paste it into the issue description, then save. ' +
    'Saving will re-trigger validation automatically.',
  );
  lines.push('');
  lines.push('```markdown');
  lines.push('## Acceptance Criteria');
  lines.push('');
  result.suggested_ac.forEach((ac) => lines.push(`- [ ] ${ac}`));
  lines.push('```');

  if (!result.valid) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(
      '> **Next step:** Edit this issue, paste the acceptance criteria above ' +
      '(or write your own testable AC), and click **Save**. ' +
      'This will re-trigger the validation agent automatically.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration (callClaude is injected by the caller for testability)
// ---------------------------------------------------------------------------

export async function validateIssue({ issueTitle, issueBody, callClaude }) {
  const userPrompt = buildValidationUserPrompt(issueTitle, issueBody);
  const rawResponse = await callClaude({ userPrompt });
  return parseClaudeResponse(rawResponse);
}
