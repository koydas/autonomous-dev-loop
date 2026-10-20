#!/usr/bin/env node
/**
 * Diagnostic (ADR-0045): prints, as JSON on stdout, the roots a run resolves and where each
 * configuration file comes from — pipeline defaults, the target repository's layer, or absent.
 * Reads ADL_CONFIG_DIR / ADL_CONFIG_PATH / ADL_TARGET_ROOT like every other script; changes nothing.
 * Not a pipeline stage: no trace, no metrics.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeRoots, pipelineDefaultFile, repoConfigFile, targetConfigDir } from './lib/roots.mjs';
import { loadModelsConfig, loadLabelsConfigAll } from './lib/layered_config.mjs';
import { defaultConfigFile, protectedPathsFor } from './lib/protected_paths.mjs';
import { parseFlatYaml } from './lib/yaml.mjs';

export function resolveConfig(env = process.env) {
  const roots = describeRoots(env);
  const dir = targetConfigDir(env);
  const layer = (name) => {
    const file = repoConfigFile(name, env);
    return { default: pipelineDefaultFile(name), target: dir && existsSync(file) ? file : null };
  };
  const defaults = parseFlatYaml(readFileSync(pipelineDefaultFile('models.yaml'), 'utf8'));
  const models = loadModelsConfig(env);
  const labels = loadLabelsConfigAll(env);
  const evidenceFile = repoConfigFile('review-evidence.yaml', env);
  return {
    roots,
    files: {
      'models.yaml': layer('models.yaml'),
      'labels.yaml': layer('labels.yaml'),
      'protected-paths.yaml': { path: defaultConfigFile(env), present: existsSync(defaultConfigFile(env)) },
      'review-evidence.yaml': { path: evidenceFile, present: existsSync(evidenceFile) },
    },
    modelsOverridden: Object.keys(models).filter((key) => models[key] !== defaults[key]),
    labels: { ready: labels.issue.valid.name, changes: labels.review.changes.name },
    protectedPaths: [...protectedPathsFor(env)],
    evidenceRequired: existsSync(evidenceFile),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(resolveConfig(), null, 2)}\n`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
