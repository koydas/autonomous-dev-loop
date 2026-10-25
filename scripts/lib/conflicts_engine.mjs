// Local part of conflicts-fix (ADR-0058 §C): merges a fetched base commit into the checked-out PR head and walks
// the ladder (L0 merge, L1 lockfile, L2 model, mechanical ADR renumber), then guards the result. Everything runs in
// `cwd` with git; nothing here touches the network or GitHub (fetch, push, labels and comments belong to
// scripts/conflicts_fix.mjs), and the merge is aborted on any refusal so nothing half-resolved is left behind.
// The PR tree is data (ADR-0023): git runs with hooks disabled and a clean environment, paths are passed as arguments.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { protectedPathEntry } from './output_writer.mjs';
import { normalizeRepoPath } from './autofix_guard.mjs';
import { findGuardrailViolations } from './static_verifier.mjs';
import { readPackageJsonDependencies } from './dependency_manifest.mjs';
import { log as obsLog } from './observability.mjs';
import {
  planFile, parseConflicts, conflictsOf, conflictSignature, hasConflictMarkers, MAX_MODEL_FILES,
  planAdrRenumber, renumberReferences, renumberOwnAdr, addedLinesOf,
} from './conflicts.mjs';
import { resolveFile } from './conflict_resolver.mjs';

const MAX_FILE_BYTES = 200_000;
const STAGE = 'conflicts';
const CLEAN_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'];

/** Environment of every child process: no token, no API key (the model is called by this process, never by a child). */
export const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(CLEAN_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...extra });

const GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=github-actions[bot]', '-c', 'user.email=github-actions[bot]@users.noreply.github.com'];

function makeGit(cwd) {
  const run = (args, { allowFail = false, input } = {}) => {
    const res = spawnSync('git', [...GIT_CONFIG, ...args], { cwd, encoding: 'utf8', env: cleanEnv(), maxBuffer: 256 * 1024 * 1024, input });
    if (res.error) throw res.error;
    if (res.status !== 0 && !allowFail) throw new Error(`git ${args[0]} failed (${res.status})`);
    return { status: res.status, out: res.stdout ?? '' };
  };
  return {
    out: (args, opts) => run(args, opts).out,
    ok: (args) => run(args, { allowFail: true }).status === 0,
    run,
  };
}

const lines0 = (s) => s.split('\0').filter(Boolean);
const isText = (buf) => !buf.includes(0);

/** Unmerged paths with their index stages: { path, stages: Set<1|2|3>, modes: Set<string> }. */
function unmergedEntries(git) {
  const byPath = new Map();
  for (const rec of lines0(git.out(['ls-files', '-u', '-z']))) {
    const [meta, file] = rec.split('\t');
    const [mode, , stage] = meta.split(' ');
    const e = byPath.get(file) ?? { path: file, stages: new Set(), modes: new Set() };
    e.stages.add(Number(stage));
    e.modes.add(mode);
    byPath.set(file, e);
  }
  return [...byPath.values()];
}

const blob = (git, rev, file) => {
  const res = git.run(['show', `${rev}:${file}`], { allowFail: true });
  return res.status === 0 ? res.out : null;
};

function syntaxError(file, content) {
  if (/\.(?:mjs|cjs|js)$/i.test(file)) {
    const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'conflict-syntax-')), path.basename(file));
    try {
      fs.writeFileSync(tmp, content);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore', env: cleanEnv() });
      return false;
    } catch { return true; } finally { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
  }
  if (/\.json$/i.test(file)) {
    try { JSON.parse(content); return false; } catch { return true; }
  }
  return false;
}

/** Guard rules a resolution violates against BOTH sides: taking one side's change is the merge doing its job. */
async function guardRules(file, resolved, ours, theirs, deps, repoRoot) {
  const check = (before) => {
    const changes = [{ targetPath: file, fileContent: resolved }];
    const key = normalizeRepoPath(file);
    return new Set(findGuardrailViolations(changes, {
      existing: new Map([[key, before]]), shownPaths: new Set([key]), hiddenPaths: new Set(),
      dependencies: deps, fileExists: (p) => fs.existsSync(path.resolve(repoRoot, p)), mentionText: '',
    }).map((v) => v.rule));
  };
  const vsOurs = check(ours);
  const vsTheirs = theirs === null ? new Set() : check(theirs);
  return [...vsOurs].filter((r) => vsTheirs.has(r) || theirs === null);
}

/** Default `npm install --package-lock-only`: no scripts, no user/global npm config, no token in the environment. */
export function runNpmLockOnly(cwd) {
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd, stdio: 'ignore', timeout: 300_000,
    env: cleanEnv({ NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null' }),
  });
}

/**
 * @param {{ cwd: string, baseSha: string, baseRef: string, title?: string, prNumber?: number | null,
 *   budgetChars: number, callModel?: Function | null, runNpm?: (cwd: string) => void,
 *   protectedEntryOf?: (path: string) => string | null,
 *   beforeResolve?: (plan: { sig: string | null, files: string[] }) => Promise<string | null> | string | null }} input
 *   beforeResolve runs after the plan and before any model call: a reason code stops the run (circuit breaker).
 * @returns {Promise<{ outcome: 'noop' | 'resolved' | 'escalated', rung?: 'L0'|'L1'|'L2', files: string[],
 *   conflicts: number, hunks: number, renumbered: { from: string, to: string }[], sig: string | null,
 *   reason?: string, rules?: string[], blocked?: string[], headSha: string }>}
 */
export async function mergeForward(input) {
  const { cwd, baseSha, baseRef, title = '', prNumber = null, budgetChars, callModel = null, runNpm = runNpmLockOnly, protectedEntryOf = protectedPathEntry, beforeResolve = null } = input;
  const git = makeGit(cwd);
  const headSha = git.out(['rev-parse', 'HEAD']).trim();
  const result = { files: [], conflicts: 0, hunks: 0, renumbered: [], sig: null, headSha };
  const escalate = (reason, extra = {}) => {
    git.run(['merge', '--abort'], { allowFail: true });
    return { ...result, outcome: 'escalated', reason, ...extra };
  };

  if (git.ok(['merge-base', '--is-ancestor', baseSha, 'HEAD'])) return { ...result, outcome: 'noop' };
  const mergeBase = git.run(['merge-base', 'HEAD', baseSha], { allowFail: true }).out.trim();
  if (!mergeBase) return escalate('unsupported_conflict', { blocked: [] });

  try {
    const merge = git.run(['-c', 'merge.conflictStyle=diff3', 'merge', '--no-commit', '--no-ff', baseSha], { allowFail: true });
    const entries = merge.status === 0 ? [] : unmergedEntries(git);
    if (merge.status !== 0 && entries.length === 0) return escalate('unsupported_conflict');
    result.conflicts = entries.length;
    let rung = 'L0';
    const resolvedFiles = [];

    // Plan: every file's rung is known before anything is written.
    const plans = [];
    for (const e of entries) {
      if (!(e.stages.has(2) && e.stages.has(3)) || [...e.modes].some((m) => m === '120000' || m === '160000')) {
        return escalate('unsupported_conflict', { blocked: [e.path] });
      }
      const plan = planFile(e.path, protectedEntryOf(e.path));
      if (plan.rung === 'L3') return escalate(plan.reason, { blocked: [e.path] });
      const buf = fs.readFileSync(path.join(cwd, e.path));
      if (!isText(buf)) return escalate('binary_file', { blocked: [e.path] });
      if (buf.length > MAX_FILE_BYTES) return escalate('too_large', { blocked: [e.path] });
      plans.push({ ...e, ...plan, content: buf.toString('utf8') });
    }
    if (plans.filter((p) => p.rung === 'L2').length > MAX_MODEL_FILES) return escalate('too_many_files', { blocked: plans.filter((p) => p.rung === 'L2').map((p) => p.path) });
    result.sig = conflictSignature(plans.map((p) => {
      let theirs = '';
      try { theirs = conflictsOf(parseConflicts(p.content)).map((c) => c.theirs).join(''); } catch { /* unparsable: signature on the path alone */ }
      return { path: p.path, theirs };
    }));

    const stop = beforeResolve ? await beforeResolve({ sig: result.sig, files: plans.map((p) => p.path) }) : null;
    if (stop) return escalate(stop, { blocked: plans.map((p) => p.path) });

    // L1: the lockfile is regenerated from the merged manifest, never edited.
    for (const p of plans.filter((x) => x.rung === 'L1')) {
      if (!git.ok(['diff', '--quiet', mergeBase, 'HEAD', '--', '.npmrc'])) return escalate('lockfile_unsafe', { blocked: [p.path] });
      try {
        git.run(['checkout', '--ours', '--', p.path]);
        runNpm(cwd);
        JSON.parse(fs.readFileSync(path.join(cwd, p.path), 'utf8'));
      } catch { return escalate('lockfile_failed', { blocked: [p.path] }); }
      git.run(['add', '--', p.path]);
      rung = 'L1';
      resolvedFiles.push(p.path);
    }

    // L2: the model resolves hunks; each hunk is post-checked by its resolver.
    const modelPlans = plans.filter((p) => p.rung === 'L2');
    if (modelPlans.length && !callModel) return escalate('model_rejected', { blocked: modelPlans.map((p) => p.path), rules: ['no_model'] });
    const repoRoot = path.resolve(cwd);
    const written = new Map();
    for (const p of modelPlans) {
      const res = await resolveFile({ path: p.path, resolver: p.resolver, content: p.content, title, budgetChars, callModel });
      if (!res.ok) return escalate(res.reason, { blocked: [p.path], rules: res.rules });
      result.hunks += res.hunks;
      written.set(p.path, res.content);
      rung = 'L2';
    }

    // Guards on the model's files: syntax, then the ADR-0029/0019 rules against both sides.
    const deps = await readPackageJsonDependencies(repoRoot);
    for (const [file, content] of written) {
      if (syntaxError(file, content)) return escalate('syntax_error', { blocked: [file] });
      const ours = blob(git, 'HEAD', file);
      const theirs = blob(git, baseSha, file);
      if (ours !== null) {
        const rules = await guardRules(file, content, ours, theirs, deps, repoRoot);
        if (rules.length) return escalate('guard_rejected', { blocked: [file], rules });
      }
    }
    for (const [file, content] of written) {
      fs.writeFileSync(path.join(cwd, file), content);
      git.run(['add', '--', file]);
      resolvedFiles.push(file);
    }

    // Mechanical ADR renumber (not a model decision): the PR's ADR takes the next free number when the base holds its own.
    const addedAdrs = lines0(git.out(['diff', '--name-only', '--diff-filter=A', '-z', mergeBase, 'HEAD', '--', 'docs/adr']));
    const tree = lines0(git.out(['ls-files', '-z']));
    const plan = planAdrRenumber(tree, addedAdrs);
    if (plan.length) {
      const prChanged = lines0(git.out(['diff', '--name-only', '--diff-filter=AM', '-z', mergeBase, 'HEAD']));
      for (const r of plan) {
        git.run(['mv', '--', r.fromPath, r.toPath]);
        const own = path.join(cwd, r.toPath);
        fs.writeFileSync(own, renumberOwnAdr(fs.readFileSync(own, 'utf8'), r));
        git.run(['add', '--', r.toPath]);
        for (const file of prChanged) {
          if (file === r.fromPath || !tree.includes(file) || /^docs\/adr\/\d{4}-/.test(file)) continue;
          const buf = fs.readFileSync(path.join(cwd, file));
          if (!isText(buf)) continue;
          const before = blob(git, mergeBase, file) ?? '';
          const added = addedLinesOf(before, blob(git, 'HEAD', file) ?? '');
          const next = renumberReferences(buf.toString('utf8'), added, r);
          if (next === buf.toString('utf8')) continue;
          fs.writeFileSync(path.join(cwd, file), next);
          git.run(['add', '--', file]);
          resolvedFiles.push(file);
        }
        resolvedFiles.push(r.toPath);
        result.renumbered.push({ from: r.from, to: r.to });
        obsLog({ stage: STAGE, event: 'conflicts.adr_renumbered', level: 'info', meta: { prNumber, from: r.from, to: r.to } });
      }
    }

    // Nothing may stay unmerged or carry a marker.
    if (unmergedEntries(git).length) return escalate('unsupported_conflict');
    for (const file of resolvedFiles) {
      if (fs.existsSync(path.join(cwd, file)) && hasConflictMarkers(fs.readFileSync(path.join(cwd, file), 'utf8'))) return escalate('model_rejected', { blocked: [file], rules: ['marker_left'] });
    }

    git.run(['commit', '-m', `fix(ai): resolve merge conflicts with ${baseRef}@${baseSha.slice(0, 7)}`]);
    return { ...result, outcome: 'resolved', rung, files: [...new Set(resolvedFiles)] };
  } catch (err) {
    git.run(['merge', '--abort'], { allowFail: true });
    throw err;
  }
}
