// The pure part of the auto-fix stage, shared by auto_fix_pr.mjs and the future `autofix` eval suite (EV-03) so that
// what an eval scores is what production runs: the token budget, the prompt built from a review's feedback, a diff and
// the files of a tree, the reading of the model's answer and the write guard's verdict on the patch. No GitHub call, no
// LLM call, no write: the callers own those. `root` is the repository (production: the PR checkout; an eval: a fixture).

import fs from 'node:fs';
import path from 'node:path';
import { filterDiff, shouldIncludeFile } from './file_filters.mjs';
import { interpolatePrompt } from './prompts.mjs';
import { parseJsonResponse, shrinkRejection } from './output_writer.mjs';
import { normalizeRepoPath } from './autofix_guard.mjs';
import { findGuardrailViolations } from './static_verifier.mjs';
import { readPackageJsonDependencies } from './dependency_manifest.mjs';
import { readPrTreeFile } from './pr_tree_reader.mjs';

export const MAX_FILE_SIZE = 8000;
export const MAX_FILES = 5;
export const TOKEN_SAFETY_MARGIN = 200;

export const MODEL_CONTEXT_WINDOW = {
  'qwen/qwen3-32b': 32768, // retired by Groq 2026-07-17 (ADR-0025)
  'llama-3.1-8b-instant': 32768,
  'llama-3.3-70b-versatile': 131072, // retired by Groq 2026-08-16 (ADR-0025)
  'openai/gpt-oss-120b': 131072,
  'claude-opus-4-7': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5-20251001': 200000,
};

export function truncateToTokenBudget(text, tokenBudget) {
  if (tokenBudget <= 0) return '';
  const maxChars = tokenBudget * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/** The diff and feedback shares of the input budget (config, else 0.15 and 0.25); their sum must leave room for files. */
export function resolveBudgetRatios({ diffRatio, feedbackRatio }) {
  const effectiveDiffRatio = diffRatio ?? 0.15;
  const effectiveFeedbackRatio = feedbackRatio ?? 0.25;
  if (effectiveDiffRatio + effectiveFeedbackRatio >= 1) {
    throw new Error(`Token budget config error: autofix_diff_ratio (${effectiveDiffRatio}) + autofix_feedback_ratio (${effectiveFeedbackRatio}) must sum to less than 1.0; adjust config/models.yaml`);
  }
  return { diffRatio: effectiveDiffRatio, feedbackRatio: effectiveFeedbackRatio };
}

/**
 * The input budget of a request and its split between the diff, the feedback and the files. The context window of a
 * model missing from MODEL_CONTEXT_WINDOW is 32,768 on Groq and 200,000 otherwise; `maxInputTokens` (config) can only
 * lower the budget. The ratios are already resolved by the caller.
 */
export function fitAutofixBudget({ provider, model, systemTokens, userWrapperTokens, maxOutputBudget, maxInputTokens, diffRatio, feedbackRatio }) {
  const contextWindow = MODEL_CONTEXT_WINDOW[model] ?? (provider === 'groq' ? 32768 : 200000);
  const contextWindowBudget = Math.max(0, contextWindow - TOKEN_SAFETY_MARGIN - systemTokens - maxOutputBudget);
  const rawInputBudget = maxInputTokens != null ? Math.min(contextWindowBudget, maxInputTokens) : contextWindowBudget;
  const inputBudget = Math.max(0, rawInputBudget - userWrapperTokens);
  const diffBudget = Math.floor(inputBudget * diffRatio);
  const feedbackBudget = Math.floor(inputBudget * feedbackRatio);
  const fileBudget = Math.max(0, inputBudget - diffBudget - feedbackBudget);
  return { contextWindow, inputBudget, diffBudget, feedbackBudget, fileBudget };
}

/** The paths a unified diff touches, once each, in diff order. */
export function listChangedFiles(rawDiff) {
  return [...new Set([...rawDiff.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]))];
}

/**
 * What the stage shows the model. A file is either shown in full or withheld with an explicit marker, never cut
 * silently: the model returns whole files, so a truncated view becomes deleted content (ADR-0029). The tree is data
 * (ADR-0023, F02): read through the shared reader, never following a symlink and never reading more than
 * MAX_FILE_SIZE bytes. `onWithheld({ path, reason })` is called for a path that is not a regular file.
 * `dependencies` is a snapshot taken before the call: the verified manifest is never one the patch wrote.
 */
export async function buildAutofixContext({ root, userPromptTemplate, feedbackParts, rawDiff, budgets, onWithheld = () => {} }) {
  const { diffBudget, feedbackBudget, fileBudget } = budgets;
  const reviewFeedback = truncateToTokenBudget(
    feedbackParts.join('\n\n---\n\n') || '(No specific review feedback provided)',
    feedbackBudget,
  );
  const diff = truncateToTokenBudget(filterDiff(rawDiff, diffBudget * 4), diffBudget);
  const changedFiles = listChangedFiles(rawDiff).filter(shouldIncludeFile);
  const dependencies = await readPackageJsonDependencies(root);

  const fileContentParts = [];
  const shownPaths = new Set();
  const hiddenPaths = new Set();
  let fileCharsLeft = fileBudget * 4;
  const withhold = (filePath, marker) => {
    fileContentParts.push(marker);
    hiddenPaths.add(normalizeRepoPath(filePath));
    fileCharsLeft -= marker.length + 2;
  };
  for (const filePath of changedFiles.slice(0, MAX_FILES)) {
    let read;
    try {
      read = readPrTreeFile(root, filePath, { maxBytes: MAX_FILE_SIZE });
    } catch {
      continue; // Unreadable — skip
    }
    if (read.kind === 'missing') continue; // File deleted — skip
    if (read.kind === 'other') {
      onWithheld({ path: filePath, reason: read.reason });
      withhold(filePath, `### File withheld (not a regular file in the PR tree): ${filePath} — do NOT target this file`);
      continue;
    }
    const part = read.kind === 'file' ? `### Current file: ${filePath}\n\`\`\`\n${read.content}\n\`\`\`` : null;
    if (part !== null && part.length <= fileCharsLeft) {
      fileContentParts.push(part);
      shownPaths.add(normalizeRepoPath(filePath));
      fileCharsLeft -= part.length + 2;
    } else {
      withhold(filePath, `### File withheld (too large for the context budget): ${filePath} — do NOT target this file`);
    }
  }
  const fileContents =
    fileContentParts.length > 0
      ? fileContentParts.join('\n\n')
      : 'No existing files identified as relevant to this review.';

  const userPrompt = interpolatePrompt(userPromptTemplate, { reviewFeedback, diff, fileContents });

  // ADR-0040: what the token budget cut from the prompt (truncateToTokenBudget slices at budget × 4 chars).
  const budgetCuts = {
    hidden_files: [...hiddenPaths],
    skipped_files: Math.max(0, changedFiles.length - MAX_FILES),
    diff_truncated: diff.length < rawDiff.length,
    feedback_truncated: reviewFeedback.length >= feedbackBudget * 4,
  };
  return { reviewFeedback, diff, changedFiles, dependencies, shownPaths, hiddenPaths, fileContents, userPrompt, budgetCuts };
}

/**
 * The model's answer as an object. A failure carries `kind`: `json` (not parseable, `cause` has the parser's
 * message) or `shape` (parsed, but not an object).
 */
export function parseAutofixResponse(raw) {
  let aiOutput;
  try {
    aiOutput = parseJsonResponse(raw);
  } catch (err) {
    throw Object.assign(new Error('AI response was not valid JSON', { cause: err }), { kind: 'json' });
  }
  if (!aiOutput || typeof aiOutput !== 'object' || Array.isArray(aiOutput)) {
    throw Object.assign(new Error('AI response JSON must be an object'), { kind: 'shape' });
  }
  return aiOutput;
}

/**
 * The write guard's violations (ADR-0019, ADR-0029, ADR-0009) for a validated patch against the tree at `root`.
 * The pre-patch content comes through the same reader (F02). A non-regular target (symlink, directory, FIFO, device)
 * is a `non_regular_target` violation. A target over MAX_FILE_SIZE bytes was never shown, so its content is not
 * needed: a non-null placeholder lets the guard reject it as withheld / unshown without an unbounded read.
 */
export function findAutofixViolations({ changes, context, root, mentionText }) {
  const existing = new Map();
  const nonRegular = [];
  for (const { targetPath } of changes) {
    const key = normalizeRepoPath(targetPath);
    const read = readPrTreeFile(root, key, { maxBytes: MAX_FILE_SIZE });
    if (read.kind === 'other') {
      nonRegular.push({ targetPath, rule: 'non_regular_target', reason: `target is not a regular file in the PR tree (${read.reason})` });
    }
    existing.set(key, read.kind === 'file' ? read.content : read.kind === 'too_large' ? '' : null);
  }
  const rejectedTargets = new Set(nonRegular.map((v) => normalizeRepoPath(v.targetPath)));
  return [...nonRegular, ...findGuardrailViolations(changes.filter((c) => !rejectedTargets.has(normalizeRepoPath(c.targetPath))), {
    existing,
    shownPaths: context.shownPaths,
    hiddenPaths: context.hiddenPaths,
    dependencies: context.dependencies,
    fileExists: (p) => fs.existsSync(path.resolve(root, p)),
    mentionText,
  })];
}

/**
 * The ADR-0009 shrink guard on a validated patch, as a dry run: production applies it when it writes
 * (`writeGeneratedFiles`), an eval must not write. Same predicate and message (`shrinkRejection`). A new file, a file
 * that is not a regular one (already a `non_regular_target` violation) and a target over MAX_FILE_SIZE bytes (never
 * shown, already rejected as withheld) have no comparable content.
 */
export function findShrinkViolations({ changes, root }) {
  const violations = [];
  for (const { targetPath, fileContent } of changes) {
    const read = readPrTreeFile(root, normalizeRepoPath(targetPath), { maxBytes: MAX_FILE_SIZE });
    if (read.kind !== 'file') continue;
    const reason = shrinkRejection(targetPath, read.content, fileContent);
    if (reason) violations.push({ targetPath, rule: 'destructive_shrink', reason });
  }
  return violations;
}
