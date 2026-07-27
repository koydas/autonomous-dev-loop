import fs from 'node:fs/promises';
import path from 'node:path';
import { shouldIncludeFile } from './file_filters.mjs';

const MAX_FILE_SIZE = 8000;
const MAX_FILES = 10;

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

  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}

export function formatDependencyAllowlist(deps) {
  if (!deps || Object.keys(deps).length === 0) return '';
  const names = Object.keys(deps).sort();
  return (
    '### Allowed npm dependencies (from package.json)\n' +
    names.map((name) => `- ${name}`).join('\n') +
    '\n\nDo not import any package outside this list. Language/runtime built-ins ' +
    '(e.g. AbortController, fetch, crypto, fs, path) do not need to be listed here ' +
    'and are always allowed.'
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
