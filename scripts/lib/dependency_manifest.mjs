import fs from 'node:fs/promises';
import path from 'node:path';

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

// Reads dependencies + devDependencies + peerDependencies + optionalDependencies from the
// target repo's package.json, if present. Returns null when there is no package.json, it
// isn't valid JSON, or it doesn't parse to a plain object (e.g. `null`, `[...]`, a string) —
// callers should treat that as "no manifest available" rather than an error, since not every
// repo this pipeline touches is Node.js-based.
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
