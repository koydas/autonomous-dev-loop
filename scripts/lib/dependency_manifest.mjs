import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { log } from './observability.mjs';

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

// ADR-0023: the repo root comes from the runner, everything under it may come from a PR and is
// never followed. Every component is lstat'ed (as `pathKind` in pr_review.mjs): a single lstat of the
// full path would follow a symlinked parent. `relPath` is a constant relative path. Returns 'file',
// 'missing' or 'other'; throws on any other lstat error.
async function treePathKind(absRoot, relPath) {
  const parts = path.normalize(relPath).split(path.sep);
  let full = absRoot;
  for (const [i, part] of parts.entries()) {
    full = path.join(full, part);
    let st;
    try {
      st = await fs.lstat(full);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'missing';
      throw err;
    }
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return 'other';
  }
  return 'file';
}

function warnIgnored(reason) {
  log({ stage: 'dependency_manifest', event: 'dependency_manifest.package_json_ignored', level: 'warn', meta: { path: 'package.json', reason } });
}

// Reads a regular package.json without following a symlink. null: missing, or not a regular file /
// unreadable (one warn event). The lstat → open race (a symlink or FIFO swapped in between) is closed
// by O_NOFOLLOW (where the platform has it), O_NONBLOCK (a FIFO open never blocks) and an fstat
// re-check on the opened descriptor.
async function readRegularPackageJson(absRepoRoot) {
  let kind;
  try {
    kind = await treePathKind(absRepoRoot, 'package.json');
  } catch (err) {
    warnIgnored(err?.code ?? err?.message ?? 'lstat_failed');
    return null;
  }
  if (kind === 'missing') return null;
  if (kind === 'other') {
    warnIgnored('not_regular_file');
    return null;
  }
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fsConstants;
  let handle;
  try {
    handle = await fs.open(path.join(absRepoRoot, 'package.json'), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!(await handle.stat()).isFile()) {
      warnIgnored('not_regular_file');
      return null;
    }
    return await handle.readFile('utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    warnIgnored(err?.code ?? err?.message ?? 'read_failed');
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Reads dependencies + devDependencies + peerDependencies + optionalDependencies from the
// target repo's package.json, if present. Returns null when there is no package.json, it is
// not a regular file (symlink, directory, FIFO, …; never followed, ADR-0023), it
// isn't valid JSON, or it doesn't parse to a plain object (e.g. `null`, `[...]`, a string) —
// callers should treat that as "no manifest available" rather than an error, since not every
// repo this pipeline touches is Node.js-based.
export async function readPackageJsonDependencies(repoRoot) {
  const absRepoRoot = path.resolve(repoRoot);
  const raw = await readRegularPackageJson(absRepoRoot);
  if (raw === null) return null;

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

export function formatDependencyManifestContext(deps) {
  if (!deps || Object.keys(deps).length === 0) return '';
  const names = Object.keys(deps).sort();
  return (
    '\n\n### Declared npm dependencies (from package.json)\n' +
    names.map((name) => `- ${name}`).join('\n') +
    '\n\nWhen applying the "Unauthorized dependency" check, treat any import matching a name ' +
    'in this list as already declared — not a violation — even if the import statement itself ' +
    'falls outside the diff hunks shown above. Only flag an import that matches neither this ' +
    'list nor a documented language/runtime built-in.'
  );
}

export async function buildDependencyManifestContext(repoRoot) {
  const deps = await readPackageJsonDependencies(repoRoot);
  return formatDependencyManifestContext(deps);
}
