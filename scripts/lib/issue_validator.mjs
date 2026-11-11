/**
 * Issue validation logic for the autonomous dev-loop pipeline.
 *
 * All exports are pure functions or constants — no external I/O — so they can
 * be unit-tested without network access.  The callGroq dependency is injected
 * by the caller (validate_issue.mjs) to keep this module free of SDK imports.
 */

import { loadPrompt, interpolatePrompt } from './prompts.mjs';

// ---------------------------------------------------------------------------
// System prompt  (stable — never changes between requests)
// ---------------------------------------------------------------------------

export const VALIDATION_SYSTEM_PROMPT = loadPrompt('validation-system');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Returns false when the title is empty or contains only a [TAG] prefix with no
// descriptive text — e.g. "[FEATURE]" alone is not a valid title.
export function isMeaningfulTitle(title) {
  if (!title || !title.trim()) return false;
  const withoutPrefix = title.trim().replace(/^\[[^\]]+\]\s*/, '');
  return withoutPrefix.length > 0;
}

// ADR-0067: a `Blocked by` section is the author's declaration that an external precondition (a run,
// an approval, a decision) is still to come. Recognised here, in code, never by the model: a
// heading line `## Blocked by` or `### Blocked by` (case-insensitive) outside fenced code blocks
// and HTML comments, followed before the next heading by at least one list item. The items are data.
export function hasBlockedBySection(issueBody) {
  if (typeof issueBody !== 'string') return false;
  const text = issueBody.replace(/<!--[\s\S]*?-->/g, '');
  let fence = null;
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    if (/^ {0,3}#{1,6}[ \t]/.test(line)) {
      inSection = /^ {0,3}#{2,3}[ \t]+blocked by[ \t]*$/i.test(line);
      continue;
    }
    if (inSection && /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/.test(line)) return true;
  }
  return false;
}

// ADR-0067: blocked = invalid, every blocker is a B4 (undocumented dependency), and the body declares
// its precondition under `Blocked by`. Derived from the parsed result, never from a model assertion;
// it only relabels an INVALID issue — `valid` stays false, so nothing downstream of it changes.
export function isBlocked(result, issueBody) {
  if (!result || result.valid !== false) return false;
  if (!Array.isArray(result.blockers) || result.blockers.length === 0) return false;
  if (!result.blockers.every((b) => /^\s*B4:/.test(String(b)))) return false;
  return hasBlockedBySection(issueBody);
}

export function buildValidationUserPrompt(issueTitle, issueBody) {
  const template = loadPrompt('validation-user');
  return interpolatePrompt(template, {
    issueTitle,
    issueBody: issueBody || '(no body provided)',
  });
}

export function parseGroqResponse(rawText) {
  // Extract the JSON object — the model may occasionally wrap it in markdown fences
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in Groq response');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch (err) {
    throw new Error('Groq response contained invalid JSON', { cause: err });
  }
  // A key with stray whitespace (`" warnings"`, seen on claude-haiku-5-5 in eval run 40774614011, #325) is the
  // same key: the answer is complete, only the key's spelling drifted. Values are left untouched.
  parsed = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.trim(), value]));

  if (typeof parsed.valid !== 'boolean') throw new Error('Response missing "valid" boolean');
  if (typeof parsed.score !== 'number') throw new Error('Response missing "score" number');
  if (!Array.isArray(parsed.blockers)) throw new Error('Response missing "blockers" array');
  if (!Array.isArray(parsed.warnings)) throw new Error('Response missing "warnings" array');
  // suggested_ac is advisory (it never changes the verdict): a missing one costs the
  // suggestions, not the validation run. Any other non-array value is still malformed.
  parsed.suggested_ac ??= [];
  if (!Array.isArray(parsed.suggested_ac)) throw new Error('Response "suggested_ac" is not an array');

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
  const blocked = result.blocked === true && !result.valid;
  const statusEmoji = result.valid ? '✅' : blocked ? '🚧' : '🚫';
  const statusText = result.valid
    ? 'VALID — ready for development'
    : blocked ? 'BLOCKED — waiting on a declared precondition' : 'INVALID — needs refinement';
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
    lines.push(
      blocked
        ? 'These depend on the preconditions declared under **Blocked by**; no rewording of the issue clears them:'
        : 'The following issues **must** be resolved before this issue can proceed:',
    );
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

  if (!blocked) {
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
  }

  if (blocked) {
    lines.push('---');
    lines.push('');
    lines.push(
      '> **Next step:** Resolve the preconditions listed under **Blocked by**, then edit this issue ' +
      'and click **Save**. This re-runs validation; once nothing is missing the issue becomes valid.',
    );
  } else if (!result.valid) {
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
// Orchestration (callGroq is injected by the caller for testability)
// ---------------------------------------------------------------------------

export async function validateIssue({ issueTitle, issueBody, callGroq }) {
  if (!isMeaningfulTitle(issueTitle)) {
    return {
      valid: false,
      score: 0,
      blockers: ['Issue title must contain a descriptive name beyond the type prefix (e.g. "[FEATURE] Add login endpoint")'],
      warnings: [],
      suggested_ac: [],
    };
  }
  const prompt = buildValidationUserPrompt(issueTitle, issueBody);
  const rawResponse = await callGroq({ prompt });
  const parsed = parseGroqResponse(rawResponse);
  return { ...parsed, blocked: isBlocked(parsed, issueBody) };
}
