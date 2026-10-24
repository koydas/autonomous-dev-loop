// The pure part of the code-generation stage, shared by generate_issue_change.mjs and the `generation` eval suite so
// that what an eval scores is what production runs: the context and prompt of an issue, the reading of the model's
// answer, the blocked / patch decision and the write guard's verdict on the patch. No GitHub call, no LLM call, no
// write: the callers own those. `root` is the repository (production: the working directory; an eval: a fixture).

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildDeterministicPrompt } from './config.mjs';
import { loadPrompt } from './prompts.mjs';
import { parseJsonResponse, validateAiOutput } from './output_writer.mjs';
import { buildFileContext } from './file_injector.mjs';
import { readPackageJsonDependencies } from './dependency_manifest.mjs';
import { normalizeRepoPath } from './autofix_guard.mjs';
import { findGuardrailViolations } from './static_verifier.mjs';
import { decideGenerationBlocked, findDeterministicBlock } from './generation_blocked.mjs';

/**
 * What the stage knows before the LLM call. `fileExists` resolves a repo path against `root`.
 * `dependencies` is a snapshot taken before the call: the verified manifest is never one the patch wrote.
 * @returns {Promise<{ fileContext: object, deterministicBlock: object | null, dependencies: object, prompt: string, systemPrompt: string, fileExists: (p: string) => boolean }>}
 */
export async function buildGenerationContext({ config, root = process.cwd() }) {
  const fileExists = (p) => existsSync(path.resolve(root, p));
  const fileContext = await buildFileContext(config.issueTitle, config.issueBody, root);
  const deterministicBlock = findDeterministicBlock({ ...config, hiddenPaths: fileContext.hiddenPaths, fileExists });
  const dependencies = await readPackageJsonDependencies(root);
  const prompt = buildDeterministicPrompt({ ...config, fileContents: fileContext.block });
  const systemPrompt = loadPrompt('generation-system');
  return { fileContext, deterministicBlock, dependencies, prompt, systemPrompt, fileExists };
}

/**
 * The model's answer as an object. A failure carries `kind`: `json` (not parseable, `cause` has the parser's
 * message) or `shape` (parsed, but not an object).
 */
export function parseGenerationResponse(raw) {
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
 * Blocked (ADR-0029 amendment) or a validated patch. Throws what `validateAiOutput` throws (a GuardrailError for a
 * protected path, a plain Error for a malformed answer).
 * @returns {{ blocked: object | null, summary?: string, changes?: { targetPath: string, content: string }[] }}
 */
export function decideGeneration({ aiOutput, context, labels = [] }) {
  const blocked = decideGenerationBlocked({ deterministic: context.deterministicBlock, aiOutput, labels, fileExists: context.fileExists });
  if (blocked) return { blocked };
  const { summary, changes } = validateAiOutput(aiOutput);
  return { blocked: null, summary, changes };
}

/** The write guard's violations for a patch against the files as they are in `root` (ADR-0019, ADR-0029). */
export async function findGeneratedViolations({ changes, context, config, root = process.cwd() }) {
  const existing = new Map();
  for (const { targetPath } of changes) {
    const key = normalizeRepoPath(targetPath);
    try {
      existing.set(key, await fs.readFile(path.resolve(root, key), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      existing.set(key, null);
    }
  }
  return findGuardrailViolations(changes, {
    existing,
    shownPaths: context.fileContext.shownPaths,
    hiddenPaths: context.fileContext.hiddenPaths,
    dependencies: context.dependencies,
    fileExists: context.fileExists,
    mentionText: `${config.issueTitle}\n${config.issueBody}`,
  });
}
