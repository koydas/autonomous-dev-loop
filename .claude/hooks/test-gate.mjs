#!/usr/bin/env node
/**
 * Claude Code test gate for interactive sessions (not the GitHub Actions pipeline).
 *
 *   node .claude/hooks/test-gate.mjs stop      Stop hook: end of each turn
 *   node .claude/hooks/test-gate.mjs pre-push  PreToolUse(Bash) hook: before `git push`
 *
 * Runs `node --test scripts/tests/*.test.mjs` once per distinct change set under
 * WATCHED_PATHS (vs the merge-base with origin/main), instead of after every edit.
 * Stop tests the working tree; pre-push tests HEAD — what `git push` sends — and
 * refuses while watched paths have uncommitted or untracked changes. The result is cached per change set:
 * an unchanged set is never re-run, so a failing Stop does not loop, and `git push`
 * on a set that already failed is refused without re-running.
 *
 * Exit 2 + stderr: Claude Code feeds the failure back to the model (Stop: keeps the
 * turn going; PreToolUse: blocks the push). Node built-ins only.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCHED_PATHS = ['scripts', 'prompts', 'config', 'evals', '.github/workflows'];
const MAX_REPORT_CHARS = 12000;
const SUITE_TIMEOUT_MS = 280_000; // under the 300 s hook timeout, so a hang fails explicitly

/**
 * The command without its data: heredoc bodies and quoted strings (commit messages, echo
 * text) are blanked, except the quoted script of `sh -c "…"`, which is code.
 */
function shellCode(command) {
  return command
    .replace(/<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, ' $3')
    .replace(/(-c\s+)?('[^']*'|"(?:\\.|[^"\\])*")/g, (_m, c, q) => (c ? c + q : ' '));
}

export function isPushCommand(command) {
  return typeof command === 'string' && /(^|[\s;&|("'/])git\s+(?:-[Cc]\s+\S+\s+|-\S+\s+)*push\b/.test(shellCode(command));
}

function git(projectDir, args) {
  return execFileSync('git', args, { cwd: projectDir, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Hash of the watched changes, or `null` when nothing under WATCHED_PATHS differs from
 * the merge-base with origin/main (HEAD when there is no origin/main).
 * `ref` unset: working tree + untracked files. `ref: 'HEAD'`: committed state only.
 * Throws when git cannot describe the tree; the caller then runs the suite.
 */
export function changeFingerprint(projectDir, { ref } = {}) {
  let base;
  try {
    base = git(projectDir, ['merge-base', 'HEAD', 'origin/main']).toString().trim();
  } catch {
    base = 'HEAD';
  }
  const diff = git(projectDir, ['diff', '--binary', base, ...(ref ? [ref] : []), '--', ...WATCHED_PATHS]);
  const untracked = ref ? [] : git(projectDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...WATCHED_PATHS])
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort();
  if (diff.length === 0 && untracked.length === 0) return null;
  const hash = createHash('sha256').update(diff);
  for (const rel of untracked) {
    hash.update(`\0${rel}\0`);
    try {
      hash.update(readFileSync(join(projectDir, rel)));
    } catch {
      hash.update('<unreadable>');
    }
  }
  return hash.digest('hex');
}

export function cachePath(projectDir) {
  const key = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `adl-test-gate-${key}.json`);
}

function readCache(projectDir) {
  try {
    return JSON.parse(readFileSync(cachePath(projectDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(projectDir, entry) {
  try {
    writeFileSync(cachePath(projectDir), JSON.stringify(entry));
  } catch {
    // A lost cache only costs a re-run.
  }
}

/** Failing-tests section of the spec reporter output, else its tail, capped. */
export function summarizeFailure(output) {
  const marker = output.lastIndexOf('failing tests:');
  const text = marker === -1 ? output.split('\n').slice(-80).join('\n') : output.slice(marker);
  return text.length > MAX_REPORT_CHARS ? `…\n${text.slice(-MAX_REPORT_CHARS)}` : text;
}

/** Watched paths with uncommitted or untracked changes (porcelain lines). */
export function dirtyWatchedPaths(projectDir) {
  return git(projectDir, ['status', '--porcelain', '--untracked-files=all', '--', ...WATCHED_PATHS])
    .toString()
    .split('\n')
    .filter(Boolean);
}

function runSuite(projectDir) {
  const testDir = join(projectDir, 'scripts', 'tests');
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(testDir, f));
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: SUITE_TIMEOUT_MS,
  });
  const timedOut = res.error?.code === 'ETIMEDOUT' ? `\ntest suite killed after ${SUITE_TIMEOUT_MS / 1000} s\n` : '';
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}${timedOut}` };
}

/** Returns the process exit code; writes the model-facing message to `stderr`. */
export function runGate({ mode, input, projectDir, stderr = process.stderr }) {
  if (mode === 'pre-push' && !isPushCommand(input?.tool_input?.command)) return 0;

  if (!projectDir || !existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    stderr.write(`test-gate: CLAUDE_PROJECT_DIR is not a directory (${projectDir ?? 'unset'}); tests not run.\n`);
    return 2;
  }

  let fingerprint;
  try {
    if (mode === 'pre-push') {
      const dirty = dirtyWatchedPaths(projectDir);
      if (dirty.length > 0) {
        stderr.write(
          `test-gate: push blocked — watched paths have uncommitted changes, so the tested tree would not be what is pushed. Commit or stash them first:\n${dirty.slice(0, 20).join('\n')}\n`,
        );
        return 2;
      }
    }
    // With a clean watched tree, HEAD and working-tree fingerprints are equal: Stop's cache entry is reused.
    fingerprint = changeFingerprint(projectDir, mode === 'pre-push' ? { ref: 'HEAD' } : {});
  } catch {
    fingerprint = undefined; // not a git tree: always run, never cache
  }
  if (fingerprint === null) return 0;

  const cached = fingerprint && readCache(projectDir);
  if (cached && cached.fingerprint === fingerprint) {
    if (cached.ok || mode === 'stop') return 0;
    stderr.write('test-gate: the test suite failed on this exact change set; fix it before pushing (node --test scripts/tests/*.test.mjs).\n');
    return 2;
  }

  const { ok, output } = runSuite(projectDir);
  if (fingerprint) writeCache(projectDir, { fingerprint, ok });
  if (ok) return 0;
  stderr.write(`test-gate: node --test scripts/tests/*.test.mjs failed${mode === 'pre-push' ? ' — push blocked' : ''}.\n${summarizeFailure(output)}\n`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== 'stop' && mode !== 'pre-push') {
    process.stderr.write('usage: test-gate.mjs stop|pre-push\n');
    process.exit(2);
  }
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    input = {};
  }
  process.exitCode = runGate({ mode, input, projectDir: process.env.CLAUDE_PROJECT_DIR });
}
