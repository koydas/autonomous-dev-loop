// Grader side of the executable evals (ADR-0052): validates the model-phase artifact, applies the patch to a copy of a
// pinned fixture, runs the grader's tests and classifies the result. Everything here is data in, data out: it never
// reads a secret, and the patch can neither choose the commands nor touch what the grader restores afterwards.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCheck } from './review_evidence.mjs';
import { normalizeRepoPath, isTestFile } from './autofix_guard.mjs';

export const MODEL_OUTPUT_SCHEMA_VERSION = 1;
export const MAX_CHANGES = 20;
export const MAX_CONTENT_CHARS = 200_000;
export const DEFAULT_GRADER_TIMEOUT_MS = 60_000;

/** Closed vocabulary of failure codes: the only text of a failed case that leaves this module. */
export const GRADER_FAILURES = Object.freeze({
  schema: 'SCHEMA_INVALID',
  fixtureDigest: 'FIXTURE_DIGEST_MISMATCH',
  graderDigest: 'GRADER_DIGEST_MISMATCH',
  pathEscape: 'PATH_ESCAPE',
  symlink: 'SYMLINK',
  protectedPath: 'PROTECTED_PATH',
  notAllowed: 'PATH_NOT_ALLOWED',
  tampering: 'GRADER_TAMPERING',
  hiddenTests: 'HIDDEN_TESTS_FAILED',
  existingTests: 'EXISTING_TESTS_FAILED',
  timeout: 'TIMEOUT',
  graderError: 'GRADER_ERROR',
});

/** Environment of the grader process: an allowlist, never a filter of process.env. */
export function graderEnv(home) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home, CI: 'true', NODE_ENV: 'test', LANG: 'C.UTF-8' };
}

const COMMAND_PATTERN = /^node --test(?: [\w./-]+)+$/;

/** `node --test <paths>` only: the grader file is trusted data, but a command outside this shape is a configuration error. */
export function isAllowedCommand(command) {
  return typeof command === 'string' && COMMAND_PATTERN.test(command) && !command.includes('..');
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function listFiles(root, rel = '') {
  const out = [];
  for (const entry of (await fs.readdir(path.join(root, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) out.push({ path: p, link: await fs.readlink(path.join(root, p)) });
    else if (entry.isDirectory()) out.push(...(await listFiles(root, p)));
    else out.push({ path: p });
  }
  return out;
}

/** Deterministic digest of a directory: file paths, contents and symlink targets, independent of mtime and listing order. */
export async function digestTree(root) {
  const h = createHash('sha256');
  for (const f of await listFiles(root)) {
    h.update(`${f.path}\0`);
    h.update(f.link !== undefined ? `link:${f.link}` : await fs.readFile(path.join(root, f.path)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Validates the artifact the model phase uploads. Returns { ok, changes, reason }: reason is a failure code, never model text. */
export function validateModelOutput(output) {
  const bad = (reason) => ({ ok: false, changes: [], reason });
  if (!output || typeof output !== 'object' || Array.isArray(output)) return bad(GRADER_FAILURES.schema);
  if (output.schema_version !== MODEL_OUTPUT_SCHEMA_VERSION) return bad(GRADER_FAILURES.schema);
  if (!Array.isArray(output.changes) || output.changes.length > MAX_CHANGES) return bad(GRADER_FAILURES.schema);
  for (const c of output.changes) {
    if (!c || typeof c.targetPath !== 'string' || typeof c.content !== 'string' || c.content.length > MAX_CONTENT_CHARS || c.targetPath === '') return bad(GRADER_FAILURES.schema);
  }
  return { ok: true, changes: output.changes.map((c) => ({ targetPath: normalizeRepoPath(c.targetPath), content: c.content })), reason: null };
}

/**
 * Checks the patch paths against the case before anything is written. `allowedPaths`: the files the model was shown
 * (and new files under their directories are refused: only listed paths). `mustNotChange`: exact paths or `dir/` prefixes.
 * @returns {{ ok: boolean, reason: string | null, path: string | null }}
 */
export function checkPatchPaths(changes, { allowedPaths = [], mustNotChange = [], graderFiles = [], existingTestFiles = [] } = {}) {
  const seen = new Set();
  for (const { targetPath } of changes) {
    if (path.posix.isAbsolute(targetPath) || /^[A-Za-z]:/.test(targetPath) || targetPath === '..' || targetPath.startsWith('../') || targetPath.includes('\0')) {
      return { ok: false, reason: GRADER_FAILURES.pathEscape, path: targetPath };
    }
    if (seen.has(targetPath)) return { ok: false, reason: GRADER_FAILURES.schema, path: targetPath };
    seen.add(targetPath);
    // A test the fixture already has is never rewritten: a patch that weakens it would pass the existing suite for free.
    if (graderFiles.includes(targetPath) || existingTestFiles.includes(targetPath) || mustNotChange.some((m) => (m.endsWith('/') ? targetPath.startsWith(m) : targetPath === m))) {
      return { ok: false, reason: GRADER_FAILURES.protectedPath, path: targetPath };
    }
    if (!allowedPaths.includes(targetPath)) return { ok: false, reason: GRADER_FAILURES.notAllowed, path: targetPath };
  }
  return { ok: true, reason: null, path: null };
}

/** Copies the fixture to a fresh temporary directory (symlinks refused) and writes the patch there. Returns the work dir. */
export async function applyPatchToCopy(fixtureDir, changes) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-grader-'));
  const tree = await listFiles(fixtureDir);
  if (tree.some((f) => f.link !== undefined)) {
    await fs.rm(work, { recursive: true, force: true });
    throw Object.assign(new Error('fixture contains a symlink'), { code: GRADER_FAILURES.symlink });
  }
  await fs.cp(fixtureDir, work, { recursive: true, verbatimSymlinks: true });
  for (const { targetPath, content } of changes) {
    const dest = path.join(work, targetPath);
    if (path.relative(work, dest).startsWith('..')) throw Object.assign(new Error('path escape'), { code: GRADER_FAILURES.pathEscape });
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // A symlink planted by an earlier write would redirect this one outside the work dir.
    const existing = await fs.lstat(dest).catch(() => null);
    if (existing?.isSymbolicLink()) throw Object.assign(new Error('symlink target'), { code: GRADER_FAILURES.symlink });
    await fs.writeFile(dest, content);
  }
  return work;
}

/** Hidden tests are copied in after the patch: whatever the patch wrote at their paths is overwritten. */
export async function restoreGraderFiles(workDir, hiddenDir, files) {
  for (const f of files) {
    const dest = path.join(workDir, f);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rm(dest, { force: true });
    await fs.copyFile(path.join(hiddenDir, f), dest);
  }
}

/**
 * Runs the grader's commands in `workDir`. `grader.hidden_tests` and `grader.existing_tests` are commands (allowlisted
 * shape); a command that does not pass is GRADER_ERROR (configuration), a timeout is TIMEOUT: neither is a success.
 * @returns {Promise<{ passed: boolean, checks: { name: string, status: string, exit_code: number | null }[], failure: string | null }>}
 */
export async function runGraderChecks(workDir, grader, { timeoutMs = DEFAULT_GRADER_TIMEOUT_MS, run = runCheck } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-grader-home-'));
  const checks = [];
  try {
    for (const [name, failure] of [['existing_tests', GRADER_FAILURES.existingTests], ['hidden_tests', GRADER_FAILURES.hiddenTests]]) {
      const command = grader?.[name];
      if (!isAllowedCommand(command)) return { passed: false, checks, failure: GRADER_FAILURES.graderError };
      const r = await run({ name, command, timeoutMs }, { cwd: workDir, env: graderEnv(home) });
      checks.push({ name, status: r.status, exit_code: r.exit_code });
      if (r.status === 'timeout') return { passed: false, checks, failure: GRADER_FAILURES.timeout };
      if (r.status === 'error') return { passed: false, checks, failure: GRADER_FAILURES.graderError };
      if (r.status === 'fail') return { passed: false, checks, failure };
    }
    return { passed: true, checks, failure: null };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/**
 * The whole grader phase for one case. Never throws: every outcome is a result object.
 * `input`: { output (parsed model-output.json), fixtureDir, fixtureSha256, graderDir, graderSha256, grader, allowedPaths, mustNotChange, hiddenFiles }
 * @returns {Promise<{ outcome: 'PASS' | 'FAIL' | 'ERROR', failure: string | null, path: string | null, checks: object[] }>}
 */
export async function evaluatePatch(input, { timeoutMs, run } = {}) {
  const result = (outcome, failure, extra = {}) => ({ outcome, failure, path: null, checks: [], ...extra });
  const parsed = validateModelOutput(input.output);
  if (!parsed.ok) return result('ERROR', parsed.reason);
  if ((await digestTree(input.fixtureDir)) !== input.fixtureSha256) return result('ERROR', GRADER_FAILURES.fixtureDigest);
  if ((await digestTree(input.graderDir)) !== input.graderSha256) return result('ERROR', GRADER_FAILURES.graderDigest);
  const existingTestFiles = (await listFiles(input.fixtureDir)).map((f) => f.path).filter(isTestFile);
  const paths = checkPatchPaths(parsed.changes, { allowedPaths: input.allowedPaths, mustNotChange: input.mustNotChange, graderFiles: input.hiddenFiles, existingTestFiles });
  if (!paths.ok) return result('FAIL', paths.reason === GRADER_FAILURES.protectedPath ? GRADER_FAILURES.tampering : paths.reason, { path: paths.path });
  let work;
  try {
    work = await applyPatchToCopy(input.fixtureDir, parsed.changes);
    await restoreGraderFiles(work, input.graderDir, input.hiddenFiles);
    const checked = await runGraderChecks(work, input.grader, { timeoutMs, run });
    if (checked.passed) return result('PASS', null, { checks: checked.checks });
    return result(checked.failure === GRADER_FAILURES.timeout || checked.failure === GRADER_FAILURES.graderError ? 'ERROR' : 'FAIL', checked.failure, { checks: checked.checks });
  } catch (err) {
    const code = Object.values(GRADER_FAILURES).includes(err?.code) ? err.code : GRADER_FAILURES.graderError;
    return result(code === GRADER_FAILURES.graderError ? 'ERROR' : 'FAIL', code);
  } finally {
    if (work) await fs.rm(work, { recursive: true, force: true });
  }
}
