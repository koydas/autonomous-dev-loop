/**
 * Issue validation logic for the autonomous dev-loop pipeline.
 *
 * All exports are pure functions or constants — no external I/O — so they can
 * be unit-tested without network access.  The callClaude dependency is injected
 * by the caller (validate_issue.mjs) to keep this module free of SDK imports.
 */

import { loadPrompt, interpolatePrompt } from './prompts.mjs';

// ---------------------------------------------------------------------------
// System prompt  (stable — never changes between requests, enabling caching)
// Must exceed 1024 tokens for the ephemeral cache to activate on claude-sonnet-4-5.
// ---------------------------------------------------------------------------

export const VALIDATION_SYSTEM_PROMPT = loadPrompt('validation-system');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function buildValidationUserPrompt(issueTitle, issueBody) {
  const template = loadPrompt('validation-user');
  return interpolatePrompt(template, {
    issueTitle,
    issueBody: issueBody || '(no body provided)',
  });
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
