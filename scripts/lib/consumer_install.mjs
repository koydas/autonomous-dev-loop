/**
 * Installer core (ADR-0045): renders the caller templates of templates/consumer/ for another repository
 * and decides, file by file, what an install would do. Pure: the entrypoint (scripts/install_consumer.mjs)
 * owns git and the file system.
 */

const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
// A branch name that is safe unquoted in a YAML flow list and inside a double-quoted string.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const UNTAGGED = 'untagged';
export const WORKFLOWS_DIR = '.github/workflows';

/**
 * Parses the CLI arguments. Throws on an unknown flag or a flag missing its value.
 * @returns {{ target: string, defaultBranch: string|null, force: boolean, dryRun: boolean, allowUntagged: boolean }}
 */
export function parseInstallArgs(argv) {
  const out = { target: '.', defaultBranch: null, force: false, dryRun: false, allowUntagged: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') out.force = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--allow-untagged') out.allowUntagged = true;
    else if (arg === '--target' || arg === '--default-branch') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--target') out.target = value;
      else out.defaultBranch = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** The highest `vMAJOR.MINOR.PATCH` among `tags` (other names ignored), or null. */
export function pickReleaseTag(tags) {
  let best = null;
  for (const raw of tags) {
    const m = VERSION_RE.exec(raw.trim());
    if (!m) continue;
    const parts = m.slice(1).map(Number);
    const cmp = best ? parts.map((n, i) => n - best.parts[i]).find((d) => d !== 0) ?? 0 : 1;
    if (cmp > 0) best = { tag: raw.trim(), parts };
  }
  return best ? best.tag : null;
}

/** Throws with the field name when the pin or the branch cannot be written into a caller. */
export function validatePin({ sha, version, defaultBranch }) {
  if (!SHA_RE.test(sha ?? '')) throw new Error(`sha: expected a 40-character lowercase commit SHA, got ${JSON.stringify(sha)}`);
  if (version !== UNTAGGED && !VERSION_RE.test(version ?? '')) {
    throw new Error(`version: expected vMAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`);
  }
  if (!BRANCH_RE.test(defaultBranch ?? '')) throw new Error(`defaultBranch: not a plain branch name: ${JSON.stringify(defaultBranch)}`);
}

/**
 * Fills a template: the pin and its version comment, and the default branch where a template names `main`
 * (pr-review.yml excludes it, conflicts-fix.yml watches it). Throws if a placeholder is left.
 */
export function renderTemplate(name, text, pin) {
  validatePin(pin);
  const out = text
    .replaceAll('<PIPELINE_SHA>', pin.sha)
    .replaceAll('<PIPELINE_VERSION>', pin.version)
    .replace(/^(\s+branches: \["\*\*", ")!main("\])$/m, `$1!${pin.defaultBranch}$2`)
    .replace(/^(\s+branches: \[)main(\])$/m, `$1${pin.defaultBranch}$2`);
  const left = out.split('\n').find((line) => line.includes('<PIPELINE_'));
  if (left) throw new Error(`${name}: placeholder left after rendering: ${left.trim()}`);
  return out;
}

/**
 * What an install does to each caller.
 * @param {{ name: string, text: string }[]} templates
 * @param {Map<string, string>} existing  file name → current content in the target's .github/workflows/
 * @returns {{ path: string, content: string, action: 'create'|'overwrite'|'unchanged'|'conflict' }[]}
 */
export function planInstall({ templates, existing, pin, force = false }) {
  if (templates.length === 0) throw new Error('templates: none found');
  return templates.map(({ name, text }) => {
    const content = renderTemplate(name, text, pin);
    const current = existing.get(name);
    let action = 'create';
    if (current === content) action = 'unchanged';
    else if (current !== undefined) action = force ? 'overwrite' : 'conflict';
    return { path: `${WORKFLOWS_DIR}/${name}`, content, action };
  });
}
