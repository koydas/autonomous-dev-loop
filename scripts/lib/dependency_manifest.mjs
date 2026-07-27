import fs from 'node:fs/promises';
import path from 'node:path';

// Reads dependencies + devDependencies + peerDependencies + optionalDependencies from the
// target repo's package.json, if present. Returns null when there is no package.json or it
// isn't valid JSON — callers should treat that as "no manifest available" rather than an
// error, since not every repo this pipeline touches is Node.js-based.
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

  return {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
    ...(pkg.optionalDependencies || {}),
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
