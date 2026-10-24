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
// Test names are read from the runner's output, so it is kept far beyond the 2,000-character diagnostic tail of the evidence checks.
export const GRADER_OUTPUT_CHARS = 1_000_000;
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
  incomplete: 'TESTS_INCOMPLETE',
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

const frame = (buf) => {
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(buf.length));
  return Buffer.concat([len, buf]);
};

/**
 * Deterministic digest of a directory, independent of mtime and listing order. Every entry is a type byte (F file,
 * L symlink) then its path and its payload, each preceded by its length: no choice of contents can make two different
 * trees feed the hash the same bytes (a NUL separator would let a file hold the next entry's header).
 */
export async function digestTree(root) {
  const h = createHash('sha256');
  for (const f of await listFiles(root)) {
    const payload = f.link !== undefined ? Buffer.from(f.link) : await fs.readFile(path.join(root, f.path));
    h.update(Buffer.concat([Buffer.from(f.link !== undefined ? 'L' : 'F'), frame(Buffer.from(f.path)), frame(payload)]));
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
  try {
    const tree = await listFiles(fixtureDir);
    if (tree.some((f) => f.link !== undefined)) throw Object.assign(new Error('fixture contains a symlink'), { code: GRADER_FAILURES.symlink });
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
  } catch (err) {
    // The caller never receives `work` on a throw, so nothing else would remove it.
    await fs.rm(work, { recursive: true, force: true });
    throw err;
  }
}

/** Hidden tests are copied in after the patch: whatever the patch wrote at their paths is overwritten. */
export async function restoreGraderFiles(workDir, hiddenDir, files) {
  for (const f of files) {
    const src = path.join(hiddenDir, f);
    // copyFile follows links: a link in the grader tree would run content the digest does not pin.
    if ((await fs.lstat(src)).isSymbolicLink()) throw Object.assign(new Error('grader file is a symlink'), { code: GRADER_FAILURES.symlink });
    const dest = path.join(workDir, f);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rm(dest, { force: true });
    await fs.copyFile(src, dest);
  }
}

/** The escaping of Node's TAP reporter, in its order: control characters, then backslashes (so `\n` is reported `\\n`), then `#`. */
export function tapEscape(name) {
  return String(name)
    .replaceAll('\b', '\\b').replaceAll('\f', '\\f').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\v', '\\v')
    .replaceAll('\\', '\\\\')
    .replaceAll('#', '\\#');
}

const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A zero exit status is not evidence that the tests ran: code the patch executes can `process.exit(0)` while the test
 * file is being loaded, and Node then counts the file itself as one passing test. Completion is read from the runner's
 * own TAP output instead: its closing summary must report exactly the expected number of tests, all passing and none
 * skipped, cancelled or todo, and every expected test name must appear as a passing top-level result. Node prefixes any
 * line the tested code prints with `# `, so a patch cannot forge either. Fails closed: output that cannot be read, for
 * example truncated, is not complete.
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function verifyTestRun(output, expected) {
  const text = String(output ?? '');
  const last = (key) => [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].map((m) => Number(m[1])).at(-1);
  const n = expected.length;
  if (last('tests') !== n || last('pass') !== n) return { ok: false, reason: 'summary does not report the expected tests' };
  if (['fail', 'cancelled', 'skipped', 'todo'].some((k) => last(k) !== 0)) return { ok: false, reason: 'summary reports failed, cancelled, skipped or todo tests' };
  const missing = expected.filter((name) => !new RegExp(`^\\s*ok \\d+ - ${escapeRegExp(tapEscape(name))}$`, 'm').test(text));
  return missing.length ? { ok: false, reason: 'expected tests missing from the output' } : { ok: true, reason: null };
}

/** Digest of the given files of a work dir; a missing file has its own marker, so a deletion changes it too. */
export async function digestFiles(workDir, files) {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    const content = await fs.readFile(path.join(workDir, f)).catch(() => null);
    h.update(Buffer.concat([Buffer.from(content === null ? 'M' : 'F'), frame(Buffer.from(f)), frame(content ?? Buffer.alloc(0))]));
  }
  return h.digest('hex');
}

/**
 * Runs the grader's commands, each in a fresh copy of the patched fixture (`prepare()` returns
 * `{ workDir, protectedFiles, cleanup }`): code the patch runs during the existing tests can neither rewrite the hidden
 * tests for the next command nor leave state behind. The protected files (hidden tests, tests the fixture has) are
 * digested around each run: a change, even by a process that exits 0, is GRADER_TAMPERING. `grader.existing_tests` and
 * `grader.hidden_tests` are `{ command, expected }`: a command of the allowed shape and the names of the tests it must
 * report (`verifyTestRun`); one that is not is GRADER_ERROR (configuration), a timeout
 * is TIMEOUT: neither is a success.
 * @returns {Promise<{ passed: boolean, checks: { name: string, status: string, exit_code: number | null }[], failure: string | null }>}
 */
export async function runGraderChecks(prepare, grader, { timeoutMs = DEFAULT_GRADER_TIMEOUT_MS, run = runCheck } = {}) {
  const checks = [];
  for (const [name, failure] of [['existing_tests', GRADER_FAILURES.existingTests], ['hidden_tests', GRADER_FAILURES.hiddenTests]]) {
    const { command, expected } = grader?.[name] ?? {};
    const wellFormed = Array.isArray(expected) && expected.length > 0 && expected.every((t) => typeof t === 'string' && t !== '');
    if (!isAllowedCommand(command) || !wellFormed) return { passed: false, checks, failure: GRADER_FAILURES.graderError };
    const { workDir, protectedFiles = [], cleanup } = await prepare();
    // HOME and TMPDIR are per command too: a file the first run leaves there must not prime the second.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-grader-home-'));
    try {
      const before = await digestFiles(workDir, protectedFiles);
      // The reporter is forced: the default depends on whether stdout is a terminal and on the Node version.
      const r = await run({ name, command: command.replace(/^node --test/, 'node --test --test-reporter=tap'), timeoutMs, outputChars: GRADER_OUTPUT_CHARS }, { cwd: workDir, env: graderEnv(home) });
      checks.push({ name, status: r.status, exit_code: r.exit_code });
      if ((await digestFiles(workDir, protectedFiles)) !== before) return { passed: false, checks, failure: GRADER_FAILURES.tampering };
      if (r.status === 'timeout') return { passed: false, checks, failure: GRADER_FAILURES.timeout };
      if (r.status === 'error') return { passed: false, checks, failure: GRADER_FAILURES.graderError };
      if (r.status === 'fail') return { passed: false, checks, failure };
      if (!verifyTestRun(r.output_tail, expected).ok) return { passed: false, checks, failure: GRADER_FAILURES.incomplete };
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await cleanup?.();
    }
  }
  return { passed: true, checks, failure: null };
}

/**
 * The whole grader phase for one case. Never throws: every outcome is a result object.
 * `input`: { output (parsed model-output.json), fixtureDir, fixtureSha256, graderDir, graderSha256, grader, allowedPaths, mustNotChange, hiddenFiles }
 * @returns {Promise<{ outcome: 'PASS' | 'FAIL' | 'ERROR', failure: string | null, path: string | null, checks: object[] }>}
 */
export async function evaluatePatch(input, { timeoutMs, run } = {}) {
  const result = (outcome, failure, extra = {}) => ({ outcome, failure, path: null, checks: [], ...extra });
  try {
    const parsed = validateModelOutput(input?.output);
    if (!parsed.ok) return result('ERROR', parsed.reason);
    // A missing or unreadable fixture / grader directory throws here: it is a classified ERROR, never an abort.
    if ((await digestTree(input.fixtureDir)) !== input.fixtureSha256) return result('ERROR', GRADER_FAILURES.fixtureDigest);
    if ((await digestTree(input.graderDir)) !== input.graderSha256) return result('ERROR', GRADER_FAILURES.graderDigest);
    // A link is pinned by its target's name, not its content, and copying follows it: the digest would not pin what runs.
    for (const dir of [input.fixtureDir, input.graderDir]) {
      if ((await listFiles(dir)).some((f) => f.link !== undefined)) return result('ERROR', GRADER_FAILURES.symlink);
    }
    const existingTestFiles = (await listFiles(input.fixtureDir)).map((f) => f.path).filter(isTestFile);
    const paths = checkPatchPaths(parsed.changes, { allowedPaths: input.allowedPaths, mustNotChange: input.mustNotChange, graderFiles: input.hiddenFiles, existingTestFiles });
    if (!paths.ok) return result('FAIL', paths.reason === GRADER_FAILURES.protectedPath ? GRADER_FAILURES.tampering : paths.reason, { path: paths.path });
    const protectedFiles = [...new Set([...existingTestFiles, ...(input.hiddenFiles ?? [])])];
    const prepare = async () => {
      const workDir = await applyPatchToCopy(input.fixtureDir, parsed.changes);
      const cleanup = () => fs.rm(workDir, { recursive: true, force: true });
      try {
        await restoreGraderFiles(workDir, input.graderDir, input.hiddenFiles);
      } catch (err) {
        await cleanup();
        throw err;
      }
      return { workDir, protectedFiles, cleanup };
    };
    const checked = await runGraderChecks(prepare, input.grader, { timeoutMs, run });
    if (checked.passed) return result('PASS', null, { checks: checked.checks });
    const isError = checked.failure === GRADER_FAILURES.timeout || checked.failure === GRADER_FAILURES.graderError;
    return result(isError ? 'ERROR' : 'FAIL', checked.failure, { checks: checked.checks });
  } catch (err) {
    const code = Object.values(GRADER_FAILURES).includes(err?.code) ? err.code : GRADER_FAILURES.graderError;
    return result(code === GRADER_FAILURES.graderError ? 'ERROR' : 'FAIL', code);
  }
}
