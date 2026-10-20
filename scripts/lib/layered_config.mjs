import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlatYaml, parseNestedYaml } from './yaml.mjs';
import { pipelineDefaultFile, targetConfigDir } from './roots.mjs';

// Configuration in layers (ADR-0045): the pipeline's config/<name> are the defaults; when the run
// targets another repository (ADL_CONFIG_DIR set) the leaf keys of that repository's own file are
// laid over them. A key the defaults do not know is an error naming its path, so a typo cannot
// silently leave a default in place. A missing file means defaults only; any other read error propagates.

function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Defaults with the keys of `overrides` laid over them (own keys only: `constructor` or `toString` are typos too); `file` names the source in errors. */
export function overlayFlat(defaults, overrides, file) {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`${file}: unknown key "${key}"`);
    merged[key] = value;
  }
  return merged;
}

/** Same for the 3-level files (group → section → leaf), at leaf level. */
export function overlayNested(defaults, overrides, file) {
  const merged = Object.fromEntries(Object.entries(defaults).map(([group, sections]) => [
    group,
    Object.fromEntries(Object.entries(sections).map(([section, leaves]) => [section, { ...leaves }])),
  ]));
  for (const [group, sections] of Object.entries(overrides)) {
    if (!Object.hasOwn(defaults, group)) throw new Error(`${file}: unknown group "${group}"`);
    for (const [section, leaves] of Object.entries(sections)) {
      if (!Object.hasOwn(defaults[group], section)) throw new Error(`${file}: unknown section "${group}.${section}"`);
      for (const [leaf, value] of Object.entries(leaves)) {
        if (!Object.hasOwn(defaults[group][section], leaf)) throw new Error(`${file}: unknown key "${group}.${section}.${leaf}"`);
        merged[group][section][leaf] = value;
      }
    }
  }
  return merged;
}

function layered(name, parse, overlay, env) {
  const defaults = parse(readFileSync(pipelineDefaultFile(name), 'utf8'));
  const dir = targetConfigDir(env);
  if (!dir) return defaults;
  const file = join(dir, name);
  const content = readOrNull(file);
  return content == null ? defaults : overlay(defaults, parse(content), `${name} (${file})`);
}

/**
 * models.yaml content read elsewhere (the PR head's copy): laid over the pipeline defaults for a
 * target repository, parsed as a whole file in this repository's own mode.
 */
export function modelsFromContent(content, env = process.env) {
  const parsed = parseFlatYaml(content);
  if (!targetConfigDir(env)) return parsed;
  return overlayFlat(parseFlatYaml(readFileSync(pipelineDefaultFile('models.yaml'), 'utf8')), parsed, 'models.yaml (pull request head)');
}

// The target's review guidelines are prompt text: bounded, so a repository cannot starve the diff of its budget.
export const REVIEW_GUIDELINES_MAX_CHARS = 6000;

/**
 * Review guidelines of a target repository: `review-guidelines.md` in its trusted config directory.
 * Empty in this repository's own mode (its rules are prompts/pr-review-repo-rules.md), when the file is
 * missing, or when it is blank. Over REVIEW_GUIDELINES_MAX_CHARS is an error naming the file; any read
 * error other than a missing file propagates.
 */
export function loadReviewGuidelines(env = process.env) {
  const dir = targetConfigDir(env);
  if (!dir) return '';
  const file = join(dir, 'review-guidelines.md');
  const content = readOrNull(file);
  const text = (content ?? '').trim();
  if (text.length > REVIEW_GUIDELINES_MAX_CHARS) {
    throw new Error(`review-guidelines.md (${file}): ${text.length} characters, the limit is ${REVIEW_GUIDELINES_MAX_CHARS}`);
  }
  return text;
}

/** Effective models.yaml: pipeline defaults, then the target's keys. */
export function loadModelsConfig(env = process.env) {
  return layered('models.yaml', parseFlatYaml, overlayFlat, env);
}

/** Effective labels.yaml as { group: { section: { leaf: value } } }. */
export function loadLabelsConfigAll(env = process.env) {
  return layered('labels.yaml', parseNestedYaml, overlayNested, env);
}
