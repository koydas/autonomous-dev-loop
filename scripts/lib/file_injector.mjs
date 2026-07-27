import fs from 'node:fs/promises';
import path from 'node:path';
import { shouldIncludeFile } from './file_filters.mjs';

const MAX_FILE_SIZE = 8000;
const MAX_FILES = 10;
const MAX_DEPENDENCIES = 200;

// Matches relative paths that contain at least one directory separator.
// Negative lookbehind on `:` and `/` prevents matching URL segments.
const REL_PATH_RE = /(?<![:/])\b([a-zA-Z0-9_][a-zA-Z0-9_.\-]*(?:\/[a-zA-Z0-9_.\-]+)+)\b/g;

// Matches plain filenames with common code/config extensions.
const FILENAME_EXT_RE =
  /\b([a-zA-Z0-9_][a-zA-Z0-9_.\-]*\.(?:mjs|cjs|js|ts|jsx|tsx|json|yaml|yml|md|sh|py|rb|go|rs|toml|txt|cfg|conf|env|html|css|scss|sql))\b/g;

export function extractFilePaths(issueTitle, issueBody) {
  const text = `${issueTitle}\n${issueBody}`;
  const candidates = new Set();

  for (const [, p] of text.matchAll(REL_PATH_RE)) {
    if (!p.startsWith('/') && !p.includes('..')) candidates.add(p);
  }
  for (const [, p] of text.matchAll(FILENAME_EXT_RE)) {
    if (!p.startsWith('/') && !p.includes('..')) candidates.add(p);
  }

  return [...candidates];
}

export async function readRelevantFiles(candidates, repoRoot) {
  const absRepoRoot = path.resolve(repoRoot);
  const files = [];

  for (const candidate of candidates) {
    if (files.length >= MAX_FILES) break;
    if (!shouldIncludeFile(candidate)) continue;

    const absPath = path.resolve(absRepoRoot, candidate);
    // Ensure resolved path stays inside the repo root.
    if (!absPath.startsWith(absRepoRoot + '/')) continue;

    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) continue;
      const raw = await fs.readFile(absPath, 'utf8');
      files.push({ path: candidate, content: raw.slice(0, MAX_FILE_SIZE) });
    } catch (err) {
      // Ignore expected file-system misses; surface unexpected failures.
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'].includes(err?.code)) {
        throw err;
      }
    }
  }

  return files;
}

export function formatFileContents(files) {
  if (files.length === 0) {
    return 'No existing files identified as relevant to this issue.';
  }
  return files
    .map(({ path: p, content }) => `### Current file: ${p}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');
}

// Reads dependencies + devDependencies from the target repo's package.json, if present.
// Returns null when there is no package.json or it isn't valid JSON — callers should treat
// that as "no allowlist available" rather than an error, since not every repo is Node.js-based.
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Returns `field` only if it's a plain object (a valid package.json dependency map);
// otherwise an empty object, so a malformed shape (array, string, null) is silently
// ignored rather than corrupting the merged result (e.g. spreading an array would add
// numeric-index keys like "0" as if they were package names).
function asDependencyMap(field) {
  return isPlainObject(field) ? field : {};
}

export async function readPackageJsonDependencies(repoRoot) {
  const absRepoRoot = path.resolve(repoRoot);
  let raw;
  try {
    raw = await fs.readFile(path.join(absRepoRoot, 'package.json'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }

  // JSON.parse succeeds for any valid JSON value, not just objects (e.g. `null`, `"x"`,
  // `[1,2]`) — package.json must be a top-level object for any of this to be meaningful.
  if (!isPlainObject(pkg)) return null;

  return {
    ...asDependencyMap(pkg.dependencies),
    ...asDependencyMap(pkg.devDependencies),
    ...asDependencyMap(pkg.peerDependencies),
    ...asDependencyMap(pkg.optionalDependencies),
  };
}

export function formatDependencyAllowlist(deps) {
  if (!deps || Object.keys(deps).length === 0) return '';
  const allNames = Object.keys(deps).sort();
  const truncated = allNames.length > MAX_DEPENDENCIES;
  const names = truncated ? allNames.slice(0, MAX_DEPENDENCIES) : allNames;
  // When truncated, this list can no longer be treated as exhaustive — a real, already-declared
  // dependency sorting after entry 200 would otherwise be wrongly rejected as unauthorized. The
  // static prompt text (generation-system.md/generation-user.md) calls this list "exhaustive";
  // this note overrides that framing for this specific request when it doesn't hold.
  const truncationNote = truncated
    ? `\n\n(List truncated to the first ${MAX_DEPENDENCIES} of ${allNames.length} declared dependencies, ` +
      'sorted alphabetically, to bound prompt size. Because of this truncation, this list is NOT ' +
      'exhaustive for this request — do not reject an import solely for not appearing here; only ' +
      'flag an import as unauthorized if it also fails to match a plausible real package name pattern ' +
      'or is otherwise clearly suspicious.)'
    : '';
  return (
    '### Allowed npm dependencies (from the repository root package.json)\n' +
    names.map((name) => `- ${name}`).join('\n') +
    truncationNote +
    '\n\nAvoid introducing a package outside this list. Language/runtime built-ins ' +
    '(e.g. AbortController, fetch, crypto, fs, path) do not need to be listed here ' +
    'and are always allowed. This list reflects only the repository root manifest — ' +
    "it doesn't override the separate allowance for a package already imported " +
    'elsewhere in the target file, and it may not cover nested workspace-package ' +
    'manifests this scan does not read.'
  );
}

export async function buildFileContentsBlock(issueTitle, issueBody, repoRoot) {
  const candidates = extractFilePaths(issueTitle, issueBody);
  const files = await readRelevantFiles(candidates, repoRoot);
  const filesBlock = formatFileContents(files);

  const deps = await readPackageJsonDependencies(repoRoot);
  const allowlistBlock = formatDependencyAllowlist(deps);

  return allowlistBlock ? `${allowlistBlock}\n\n${filesBlock}` : filesBlock;
}
