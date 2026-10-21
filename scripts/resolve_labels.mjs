#!/usr/bin/env node
/**
 * Resolves one label name of the effective labels config (the pipeline defaults with the target
 * repository's layer, ADR-0045) and writes it as a step output. Replaces the inline Node programs of
 * the `load-labels` jobs: workflow YAML stays orchestration only.
 * Usage: node resolve_labels.mjs <group.section.leaf> <output-name>   e.g. issue.valid.name ready_for_dev
 * Reads ADL_CONFIG_DIR / ADL_CONFIG_PATH; writes `<output-name>=<value>` to $GITHUB_OUTPUT.
 */
import { fileURLToPath } from 'node:url';
import { loadLabelsConfigAll } from './lib/layered_config.mjs';
import { appendOutputs } from './lib/github_output.mjs';

/** The string at `dottedPath` of the labels config, or an error naming the path. */
export function resolveLabel(labels, dottedPath) {
  let node = labels;
  for (const key of String(dottedPath ?? '').split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) {
      throw new Error(`labels config has no "${dottedPath}"`);
    }
    node = node[key];
  }
  if (typeof node !== 'string' || !node.trim()) throw new Error(`labels config "${dottedPath}" is not a label name`);
  return node.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [dottedPath, outputName] = process.argv.slice(2);
    if (!dottedPath || !outputName) throw new Error('usage: resolve_labels.mjs <group.section.leaf> <output-name>');
    appendOutputs([[outputName, resolveLabel(loadLabelsConfigAll(), dottedPath)]]);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
