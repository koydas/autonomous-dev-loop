#!/usr/bin/env node
/**
 * Installer (ADR-0045): writes the caller workflows of templates/consumer/ into another repository's
 * .github/workflows/, pinned to the commit this clone of the pipeline is checked out at.
 *
 *   git clone https://github.com/koydas/autonomous-dev-loop adl && git -C adl checkout vX.Y.Z
 *   node adl/scripts/install_consumer.mjs --target path/to/your-repo [--default-branch main] [--dry-run] [--force]
 *
 * The pin is HEAD of this clone and its version comment the release tag pointing at HEAD, so the templates
 * written are the ones of the pinned commit. Refuses an untagged HEAD (unless --allow-untagged), local changes
 * to templates/consumer/, a target that is the pipeline itself, and an existing caller that differs (unless
 * --force). Not a pipeline stage: no trace, no metrics.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_ROOT } from './lib/roots.mjs';
import { parseInstallArgs, pickReleaseTag, planInstall, UNTAGGED, WORKFLOWS_DIR } from './lib/consumer_install.mjs';

function git(cwd, ...args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const detail = String(err.stderr ?? '').trim().split('\n')[0] || err.message;
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`);
  }
}

function detectDefaultBranch(target) {
  try {
    return git(target, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
  } catch {
    return null;
  }
}

export function install(argv, { pipelineRoot = PIPELINE_ROOT, log = console.log } = {}) {
  const templatesDir = join(pipelineRoot, 'templates', 'consumer');
  const opts = parseInstallArgs(argv);
  const target = resolve(opts.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`--target: not a directory: ${target}`);
  if (realpathSync(target) === realpathSync(pipelineRoot)) {
    throw new Error('--target is the pipeline repository itself: its own callers are not installed this way');
  }

  if (git(pipelineRoot, 'status', '--porcelain', '--', 'templates/consumer')) {
    throw new Error('templates/consumer/ has local changes: they would not match the pinned commit');
  }
  const sha = git(pipelineRoot, 'rev-parse', 'HEAD');
  let version = pickReleaseTag(git(pipelineRoot, 'tag', '--points-at', 'HEAD').split('\n'));
  if (!version) {
    if (!opts.allowUntagged) {
      throw new Error(`HEAD ${sha} carries no vMAJOR.MINOR.PATCH tag: check out a release (git tag -l 'v*'), or pass --allow-untagged`);
    }
    version = UNTAGGED;
  }
  const defaultBranch = opts.defaultBranch ?? detectDefaultBranch(target) ?? 'main';

  const names = readdirSync(templatesDir).filter((n) => n.endsWith('.yml')).sort();
  const templates = names.map((name) => ({ name, text: readFileSync(join(templatesDir, name), 'utf8') }));
  const dir = join(target, WORKFLOWS_DIR);
  const existing = new Map(names.filter((n) => existsSync(join(dir, n))).map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
  const plan = planInstall({ templates, existing, pin: { sha, version, defaultBranch }, force: opts.force });

  log(`Pin: ${sha} # ${version}  default branch: ${defaultBranch}${opts.dryRun ? '  (dry run)' : ''}`);
  for (const step of plan) log(`  ${step.action.padEnd(9)} ${step.path}`);
  const conflicts = plan.filter((s) => s.action === 'conflict');
  if (conflicts.length > 0) {
    throw new Error(`${conflicts.length} existing caller(s) differ: review them, then pass --force to overwrite`);
  }
  if (!opts.dryRun) {
    mkdirSync(dir, { recursive: true });
    for (const step of plan) if (step.action !== 'unchanged') writeFileSync(join(target, step.path), step.content);
    log('Next: add ANTHROPIC_API_KEY or GROQ_API_KEY (and AI_PR_TOKEN) as Actions secrets, commit the callers,');
    log('then run "ADL Setup Labels" from the Actions tab (docs/installation.md of the pipeline).');
  }
  return { sha, version, defaultBranch, plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    install(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
