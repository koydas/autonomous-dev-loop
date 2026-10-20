import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PIPELINE_ROOT, targetConfigDir, configRelPath } from './roots.mjs';

// Paths the model must never write (ADR-0021, ADR-0044). The floor is hard-coded and universal: it
// covers what executes with secrets or controls what gets installed, whatever the repository holds.
// A repository adds its own entries in config/protected-paths.yaml; the result is always the union,
// a config can never remove a floor entry.
//
// Entry forms (matched against the lower-cased, normalized path):
//   `dir/`        root-level directory prefix (or the bare directory name)
//   `a/b.json`    exact root-relative file
//   `name`        file name at any depth; one `*` per entry stands for any run of non-`/` characters
export const PROTECTED_PATHS_CONFIG_PATH = 'config/protected-paths.yaml';

export const PROTECTED_FLOOR = Object.freeze([
  // Git metadata and CI: executed with repository secrets on push (ADR-0021).
  '.git/',
  '.github/',
  // Node: manifests, lock files and registry config control what gets installed.
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  // The per-repo list itself: otherwise a PR could drop an entry from it (ADR-0044).
  PROTECTED_PATHS_CONFIG_PATH,
  // .NET: project files hold the PackageReferences; the props/targets run MSBuild tasks at build and
  // restore; NuGet.config and global.json choose the package sources and the SDK (ADR-0044).
  '*.csproj',
  '*.fsproj',
  '*.vbproj',
  'Directory.Packages.props',
  'Directory.Build.props',
  'Directory.Build.targets',
  'NuGet.config',
  'global.json',
  'packages.lock.json',
  // Python: requirements and project metadata drive installs; setup.py executes at install;
  // pip.conf can redirect the package index like .npmrc does.
  'requirements*.txt',
  'pyproject.toml',
  'poetry.lock',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Pipfile.lock',
  'uv.lock',
  'pip.conf',
]);

const KEY = 'protected_paths';

function fail(message) {
  throw new Error(`${PROTECTED_PATHS_CONFIG_PATH}: ${message}`);
}

function unquote(raw) {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return raw;
  if (raw.length >= 2 && raw.at(-1) === quote) return raw.slice(1, -1);
  return fail(`unbalanced quotes in "${raw}"`);
}

function validateEntry(entry, index) {
  const field = `${KEY}[${index}]`;
  if (!entry) fail(`${field} must not be empty`);
  if (/\s#/.test(entry)) fail(`${field} "${entry}" has an inline comment (not supported)`);
  if (entry.startsWith('/') || entry.startsWith('./') || entry.includes('\\') || entry.includes('//') || entry.includes('..')) {
    fail(`${field} "${entry}" must be a relative path with forward slashes, no "./", ".." or "//"`);
  }
  if (/[?[\]{}]/.test(entry)) fail(`${field} "${entry}" uses an unsupported glob character (only "*" in a bare file name)`);
  if (entry.includes('*')) {
    if (entry.includes('/')) fail(`${field} "${entry}" uses "*" outside a bare file name`);
    if ((entry.match(/\*/g) ?? []).length > 1) fail(`${field} "${entry}" has more than one "*"`);
    if (!/[^*]/.test(entry)) fail(`${field} "${entry}" has no literal character`);
  }
  return entry;
}

/**
 * Parses config/protected-paths.yaml into its entries. The file holds one key, `protected_paths`, as
 * a `- entry` list (or `[]`); quote an entry that starts with `*` (it is a YAML alias otherwise).
 * Any other content is rejected with the offending field path: a typo must not silently drop protection.
 */
export function parseProtectedPathsConfig(content) {
  let seenKey = false;
  let inline = false;
  const entries = [];
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item) {
      if (!seenKey) fail(`list item "${item[1].trim()}" before the \`${KEY}\` key`);
      if (inline) fail(`\`${KEY}\` is declared inline and also as a list`);
      entries.push(validateEntry(unquote(item[1].trim()), entries.length));
      continue;
    }
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!top || /^\s/.test(line)) fail(`unparseable line "${line.trim()}"`);
    if (top[1] !== KEY) fail(`unknown key "${top[1]}" (only \`${KEY}\` is allowed)`);
    if (seenKey) fail(`duplicate key \`${KEY}\``);
    seenKey = true;
    if (top[2].trim() === '[]') inline = true;
    else if (top[2].trim()) fail(`\`${KEY}\` must be a list (\`- entry\` lines) or \`[]\`, got "${top[2].trim()}"`);
  }
  if (!seenKey) fail(`missing required key \`${KEY}\``);
  return entries;
}

/**
 * Floor ∪ extra entries, de-duplicated ignoring case, directory entries first (a path matching several
 * entries reports the first). Never a subtraction: every floor entry is always in the result.
 */
export function resolveProtectedPaths(extra = []) {
  const seen = new Set();
  const union = [];
  for (const entry of [...PROTECTED_FLOOR, ...extra]) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(entry);
  }
  const dirs = union.filter((entry) => entry.endsWith('/'));
  return Object.freeze([...dirs, ...union.filter((entry) => !entry.endsWith('/'))]);
}

export const DEFAULT_CONFIG_FILE = resolve(PIPELINE_ROOT, PROTECTED_PATHS_CONFIG_PATH);

/**
 * Where the repository's list is read. This repository: next to the pipeline scripts (ADR-0044 §5).
 * A target repository (ADL_CONFIG_DIR set, ADR-0045): its own `protected-paths.yaml` in the trusted
 * default-branch checkout of its config directory; the pipeline's own list is never inherited.
 */
export function defaultConfigFile(env = process.env) {
  const dir = targetConfigDir(env);
  return dir ? join(dir, 'protected-paths.yaml') : DEFAULT_CONFIG_FILE;
}

/**
 * The repository's additional entries. The file is resolved next to the pipeline scripts, so a
 * pipeline run from the default branch (ADR-0023) reads the default branch's list, never the PR's.
 * A missing file means no additional entries (floor only); any other read error propagates.
 */
export function loadProtectedPathsConfig(file = defaultConfigFile()) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return parseProtectedPathsConfig(content);
}

/** The effective denylist: floor ∪ the repository's config. Throws on an invalid config (fail-fast). */
export function loadProtectedPaths(file = defaultConfigFile()) {
  const extra = loadProtectedPathsConfig(file);
  // A target's config directory is protected as a whole, whatever its own list says (ADR-0045).
  if (targetConfigDir()) extra.push(`${configRelPath()}/`);
  return resolveProtectedPaths(extra);
}

/** True when `normalizedPath` (lower-cased, forward slashes, no leading "./") falls under `entry`. */
export function entryMatches(entry, normalizedPath) {
  const key = entry.toLowerCase();
  if (key.endsWith('/')) return normalizedPath.startsWith(key) || normalizedPath === key.slice(0, -1);
  if (key.includes('/')) return normalizedPath === key;
  const baseName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  if (!key.includes('*')) return baseName === key;
  const [head, tail] = key.split('*');
  return baseName.length >= head.length + tail.length && baseName.startsWith(head) && baseName.endsWith(tail);
}
