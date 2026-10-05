import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_COUNT = 6;

export class JsonParseError extends Error {
  constructor(message, { raw, parseErrors }) {
    super(message);
    this.name = 'JsonParseError';
    this.raw = raw;
    this.parseErrors = parseErrors;
  }
}

// A write the guardrails refuse (unsafe or protected path, symlink, destructive shrink), as opposed
// to a malformed model response. Callers escalate it to a human instead of crashing.
export class GuardrailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export function parseJsonResponse(raw) {
  const parseErrors = [];

  // Tier 1: direct parse — wins for any clean JSON (including JSON whose
  // string fields contain triple-backtick snippets that would confuse the
  // fence regex below)
  try {
    return JSON.parse(raw);
  } catch (err) {
    parseErrors.push(`direct parse: ${err.message}`);
  }

  // Tier 2: strip markdown code fence, then parse the interior
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (err) {
      parseErrors.push(`fenced parse: ${err.message}`);
    }
  } else {
    parseErrors.push('fenced parse: no fence found');
  }

  // Tier 3: brace-extraction slice (handles prose-wrapped JSON)
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      parseErrors.push(`slice parse: ${err.message}`);
    }
  } else {
    parseErrors.push('slice parse: no brace pair found');
  }

  throw new JsonParseError(
    `AI response was not valid JSON (${parseErrors.join('; ')})`,
    { raw, parseErrors },
  );
}
const MAX_FILE_CONTENT_LENGTH = 16000;

// Paths the model must never write (ADR-0021). Entries ending in "/" are root-level
// directory prefixes; the others are file names matched at any depth.
// Workflows, pipeline scripts, config and prompts run with secrets on push; checkpoints,
// metrics and traces are pipeline state read back from the same working tree; manifests,
// lock files and npm/yarn rc files control what gets installed. `.git/` is matched as a path
// segment at any depth: git metadata (config, hooks) executes on the next git command.
// `docs/` and `README.md` are human-owned documentation (ADR-0021 amendment): auto-fix attempt 2
// on #173 replaced README.md with a 9-line stub to "address" a coverage finding.
export const PROTECTED_WRITE_PATHS = Object.freeze([
  '.git/',
  '.github/',
  'scripts/',
  'config/',
  'prompts/',
  'checkpoints/',
  'metrics/',
  'observability/',
  'docs/',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'README.md',
]);

// A rewrite that drops most of an existing file is the ADR-0009 failure mode (a 690-line suite
// replaced by an 18-line stub, README.md 145 → 9 lines). Small files are exempt.
export const SHRINK_GUARD_MIN_LINES = 20;
export const SHRINK_GUARD_MAX_RATIO = 0.5;

function lineCount(text) {
  return text.split('\n').length;
}

// Non-whitespace characters: a stub padded with blank lines, or a file whose content sits on a
// few long lines, loses its content mass even when the line count holds.
function contentSize(text) {
  return text.replace(/\s/g, '').length;
}

export function isDestructiveShrink(existingContent, nextContent) {
  const before = lineCount(existingContent);
  if (before < SHRINK_GUARD_MIN_LINES) return false;
  return lineCount(nextContent) < before * SHRINK_GUARD_MAX_RATIO
    || contentSize(nextContent) < contentSize(existingContent) * SHRINK_GUARD_MAX_RATIO;
}

function findProtectedPathEntry(targetPath) {
  // Normalize before matching: backslashes, "./" and "." segments, repeated slashes, case.
  const normalized = path.posix
    .normalize(targetPath.replaceAll('\\', '/'))
    .replace(/^(\.\/)+/, '')
    .toLowerCase();
  const baseName = path.posix.basename(normalized);
  if (normalized.split('/').includes('.git')) return '.git/';
  return PROTECTED_WRITE_PATHS.find((entry) => {
    const key = entry.toLowerCase();
    return key.endsWith('/') ? normalized.startsWith(key) || normalized === key.slice(0, -1) : baseName === key;
  });
}

function validateSingleChange(change, index) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw new Error(`AI response changes[${index}] must be an object`);
  }

  const targetPath = String(change.target_path || '').trim();
  const fileContent = String(change.file_content || '');

  if (!targetPath) {
    throw new Error(`AI response changes[${index}] missing non-empty target_path`);
  }
  if (!fileContent.trim()) {
    throw new Error(`AI response changes[${index}] missing non-empty file_content`);
  }
  if (targetPath.startsWith('/') || targetPath.includes('..')) {
    throw new GuardrailError(`AI response changes[${index}] target_path must be a safe relative path`);
  }
  const protectedEntry = findProtectedPathEntry(targetPath);
  if (protectedEntry) {
    throw new GuardrailError(`AI response changes[${index}] target_path "${targetPath}" is in a protected path (${protectedEntry})`);
  }
  if (fileContent.length > MAX_FILE_CONTENT_LENGTH) {
    throw new Error(`AI response changes[${index}] file_content too large (>16000 chars)`);
  }

  return { targetPath, fileContent };
}

export function validateAiOutput(aiOutput) {
  const summary = String(aiOutput.summary || '').trim();
  const changes = aiOutput.changes;

  if (!summary) {
    throw new Error('AI response missing non-empty summary');
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('AI response missing non-empty changes array');
  }
  if (changes.length > MAX_FILE_COUNT) {
    throw new Error('AI response changes array too large (>6 files)');
  }

  const normalizedChanges = changes.map((change, index) => validateSingleChange(change, index));
  const uniquePathCount = new Set(normalizedChanges.map(({ targetPath }) => targetPath)).size;
  if (uniquePathCount !== normalizedChanges.length) {
    throw new Error('AI response changes contain duplicate target_path values');
  }

  return { summary, changes: normalizedChanges };
}

async function nearestExistingRealPath(dir) {
  let current = dir;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      if (err.code !== 'ENOENT' || current === path.dirname(current)) throw err;
      current = path.dirname(current);
    }
  }
}

// Validation works on the path string; a symlink already in the checkout could still redirect
// the write outside the repository or into .git/. Resolve before writing (ADR-0021).
async function assertRealWriteTarget(targetPath, outputPath, repoRoot) {
  const relParent = path.relative(repoRoot, await nearestExistingRealPath(path.dirname(outputPath)));
  if (relParent === '..' || relParent.startsWith(`..${path.sep}`) || path.isAbsolute(relParent)) {
    throw new GuardrailError(`target_path "${targetPath}" escapes the repository through a symlink`);
  }
  if (relParent.split(path.sep)[0] === '.git') {
    throw new GuardrailError(`target_path "${targetPath}" resolves into git metadata through a symlink`);
  }
  let stat = null;
  try {
    stat = await fs.lstat(outputPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat?.isSymbolicLink()) {
    throw new GuardrailError(`target_path "${targetPath}" is a symlink; refusing to write through it`);
  }
}

export async function writeGeneratedFiles(changes) {
  const writtenPaths = [];
  const repoRoot = await fs.realpath(process.cwd());

  // Check every change before writing any, so a rejected rewrite never leaves a partial patch.
  for (const { targetPath, fileContent } of changes) {
    const outputPath = path.normalize(targetPath).replaceAll('\\', '/');
    await assertRealWriteTarget(targetPath, outputPath, repoRoot);
    let existingContent = null;
    try {
      existingContent = await fs.readFile(outputPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (existingContent !== null && isDestructiveShrink(existingContent, fileContent)) {
      throw new GuardrailError(`target_path "${targetPath}" would shrink from ${lineCount(existingContent)} to ${lineCount(fileContent)} lines (${contentSize(existingContent)} to ${contentSize(fileContent)} non-blank chars, more than ${SHRINK_GUARD_MAX_RATIO * 100}% removed); rewrite rejected (ADR-0009)`);
    }
  }

  for (const { targetPath, fileContent } of changes) {
    const outputPath = path.normalize(targetPath).replaceAll('\\', '/');
    await assertRealWriteTarget(targetPath, outputPath, repoRoot);
    const parentDir = path.dirname(outputPath);
    if (parentDir && parentDir !== '.') {
      await fs.mkdir(parentDir, { recursive: true });
    }
    try {
      const existingContent = await fs.readFile(outputPath, 'utf8');
      if (existingContent === fileContent) {
        continue;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    await fs.writeFile(outputPath, fileContent, 'utf8');
    writtenPaths.push(outputPath);
  }

  return writtenPaths;
}
