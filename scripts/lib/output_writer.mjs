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
export const PROTECTED_WRITE_PATHS = Object.freeze([
  '.git/',
  '.github/',
  'scripts/',
  'config/',
  'prompts/',
  'checkpoints/',
  'metrics/',
  'observability/',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
]);

function findProtectedPathEntry(targetPath) {
  // Normalize before matching: backslashes, "./" and "." segments, repeated slashes, case.
  const normalized = path.posix
    .normalize(targetPath.replaceAll('\\', '/'))
    .replace(/^(\.\/)+/, '')
    .toLowerCase();
  const baseName = path.posix.basename(normalized);
  if (normalized.split('/').includes('.git')) return '.git/';
  return PROTECTED_WRITE_PATHS.find((entry) => (entry.endsWith('/')
    ? normalized.startsWith(entry) || normalized === entry.slice(0, -1)
    : baseName === entry));
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
    throw new Error(`AI response changes[${index}] target_path must be a safe relative path`);
  }
  const protectedEntry = findProtectedPathEntry(targetPath);
  if (protectedEntry) {
    throw new Error(`AI response changes[${index}] target_path "${targetPath}" is in a protected path (${protectedEntry})`);
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
    throw new Error(`target_path "${targetPath}" escapes the repository through a symlink`);
  }
  if (relParent.split(path.sep)[0] === '.git') {
    throw new Error(`target_path "${targetPath}" resolves into git metadata through a symlink`);
  }
  let stat = null;
  try {
    stat = await fs.lstat(outputPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat?.isSymbolicLink()) {
    throw new Error(`target_path "${targetPath}" is a symlink; refusing to write through it`);
  }
}

export async function writeGeneratedFiles(changes) {
  const writtenPaths = [];
  const repoRoot = await fs.realpath(process.cwd());

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
