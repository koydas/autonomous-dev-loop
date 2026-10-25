// Runs the RV-03 guardrail checks (guardrail_review.mjs) in a child process with a deadline. The checks parse PR text
// with regular expressions in the review's own process, where a try/catch cannot interrupt a pattern that backtracks
// (static_verifier.mjs rescans the text for every unclosed `export {`: quadratic on a 1 MiB file). A child that
// overruns is killed by the OS and the review goes on without the check (ADR-0060). The child runs our code on
// untrusted text; it never executes the PR's code.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGuardrailFindings, declaredPackages, findFileRuleViolations, findTestCountDrops } from './guardrail_review.mjs';
import { lstatPrTreePath, readPrTreeFile, PR_TREE_MAX_BYTES } from './pr_tree_reader.mjs';
import { PIPELINE_ROOT } from './roots.mjs';

export const GUARDRAIL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Whether an imported path is a file of the PR tree, by lstat only: no content is read, so the 1 MiB read limit does
 * not apply (Node imports a large file). A symlink is not followed and counts as a file, and an lstat error counts as
 * existing: the rule must not block on what it could not check. A directory, a special file or a path outside the tree
 * is not a file (`import './lib'` is ERR_UNSUPPORTED_DIR_IMPORT; the resolver then tries `lib.mjs`, `lib/index.mjs`).
 */
export function pathIsFileInTree(repoRoot, p) {
  try {
    const kind = lstatPrTreePath(repoRoot, p);
    return kind.kind === 'file' || (kind.kind === 'other' && kind.reason === 'symlink');
  } catch {
    return true;
  }
}

/**
 * The guardrail findings of a PR: `rawDiff` plus the files of `repoRoot` (head) and of `mergeBase` (base, read with
 * `git show`). A file that cannot be read is skipped by the rules.
 * @returns {{ findings: object[], omitted: number }}
 */
export function computeGuardrails({ rawDiff, mentionText, repoRoot, mergeBase }, { gitShow = defaultGitShow } = {}) {
  const readHead = (p) => {
    const read = readPrTreeFile(repoRoot, p, { maxBytes: PR_TREE_MAX_BYTES });
    if (read.kind === 'file') return read.content;
    if (read.kind === 'missing') return null;
    throw new Error(`${p} is not readable (${read.kind})`);
  };
  const readBase = (p) => {
    if (!mergeBase) throw new Error('PR base SHA unknown');
    return gitShow(repoRoot, mergeBase, p);
  };
  return collectGuardrailFindings([
    findTestCountDrops(rawDiff, { mentionText, readBase, readHead }),
    findFileRuleViolations(rawDiff, {
      readBase,
      readHead,
      manifestFor: (p) => declaredPackages(p, readHead),
      fileExists: (p) => pathIsFileInTree(repoRoot, p),
      mentionText,
    }),
  ]);
}

function defaultGitShow(repoRoot, rev, p) {
  return execFileSync('git', ['show', `${rev}:${p}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: PR_TREE_MAX_BYTES * 2, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * `computeGuardrails` in a child process, killed after `timeoutMs`. Throws on a timeout, a crash or a malformed answer;
 * the caller skips the check.
 */
export function runGuardrailChecks(input, { timeoutMs = GUARDRAIL_TIMEOUT_MS } = {}) {
  const out = execFileSync(process.execPath, [path.join(PIPELINE_ROOT, 'scripts', 'lib', 'guardrail_runner.mjs')], {
    input: JSON.stringify(input),
    cwd: input.repoRoot,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const result = JSON.parse(out);
  if (!Array.isArray(result?.findings) || !Number.isInteger(result?.omitted)) throw new Error('guardrail child returned a malformed result');
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify(computeGuardrails(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  });
}
