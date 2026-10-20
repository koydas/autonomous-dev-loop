import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// The three roots a pipeline script deals with (ADR-0045):
//   pipeline root   scripts, prompts and default config. Resolved from this file, so a pipeline
//                   checked out elsewhere (a pinned ref in $RUNNER_TEMP/pipeline) finds its own files.
//   target root     the repository under work: the working directory (the PR branch as data, traces,
//                   checkpoints, file context, writes). ADL_TARGET_ROOT overrides it for tests only.
//   target config   the target's own configuration, read from a trusted checkout of its default branch
//                   (ADR-0023): ADL_CONFIG_DIR is that directory (absolute), ADL_CONFIG_PATH its
//                   repo-relative name. Neither set = this repository's own mode: `config/` of the
//                   pipeline serves as defaults and as repository configuration at once.
// This module is the only place that derives a root from `import.meta.url` (checked by test).

export const PIPELINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_CONFIG_PATH = 'config';

export function pipelineConfigDir() {
  return join(PIPELINE_ROOT, DEFAULT_CONFIG_PATH);
}

export function targetRoot(env = process.env) {
  return resolve(env.ADL_TARGET_ROOT || process.cwd());
}

/** Repo-relative name of the target's config directory, without trailing slash (default `config`). */
export function configRelPath(env = process.env) {
  const raw = (env.ADL_CONFIG_PATH ?? '').trim();
  if (!raw) return DEFAULT_CONFIG_PATH;
  const rel = raw.replace(/\/+$/, '');
  // A "." or ".." segment anywhere: the output writer normalizes generated paths before matching, so a
  // `ci/./adl/` entry would never match `ci/adl/…` and the directory would be left unprotected.
  if (!rel || isAbsolute(rel) || rel.includes('\\') || rel.includes('//') || rel.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`ADL_CONFIG_PATH "${raw}" must be a relative path with forward slashes, no "." or ".." segment and no "//"`);
  }
  return rel;
}

/**
 * Absolute trusted directory holding the target's configuration, or null in this repository's own mode.
 * A relative value is an error: scripts run with the pull request checkout as working directory, so it
 * would resolve inside contributor-controlled content instead of the trusted default-branch checkout.
 */
export function targetConfigDir(env = process.env) {
  const raw = (env.ADL_CONFIG_DIR ?? '').trim();
  if (!raw) return null;
  if (!isAbsolute(raw)) throw new Error(`ADL_CONFIG_DIR "${raw}" must be an absolute path (the trusted checkout of the target's config directory)`);
  return resolve(raw);
}

/** Defaults shipped with the pipeline: config/<name> next to its scripts. */
export function pipelineDefaultFile(name) {
  return join(pipelineConfigDir(), name);
}

/**
 * The file holding the repository's own configuration `name`: the target's trusted config directory
 * when ADL_CONFIG_DIR is set, the pipeline's config/ otherwise (this repository). May not exist.
 */
export function repoConfigFile(name, env = process.env) {
  const dir = targetConfigDir(env);
  return dir ? join(dir, name) : pipelineDefaultFile(name);
}

/** Roots and config source, for `print_resolved_config.mjs` and run diagnostics. */
export function describeRoots(env = process.env) {
  const configDir = targetConfigDir(env);
  return {
    mode: configDir ? 'target' : 'pipeline-repo',
    pipelineRoot: PIPELINE_ROOT,
    targetRoot: targetRoot(env),
    configDir: configDir ?? pipelineConfigDir(),
    configRelPath: configRelPath(env),
  };
}
