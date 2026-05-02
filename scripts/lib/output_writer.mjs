import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_COUNT = 6;

export function parseJsonResponse(raw) {
  const parseErrors = [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    parseErrors.push(`direct parse: ${err.message}`);
  }

  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (err) {
      parseErrors.push(`fenced parse: ${err.message}`);
    }
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      parseErrors.push(`slice parse: ${err.message}`);
    }
  }

  throw new Error(`AI response was not valid JSON (${parseErrors.join('; ')})`);
}
const MAX_FILE_CONTENT_LENGTH = 16000;

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

export async function writeGeneratedFiles(changes) {
  const writtenPaths = [];

  for (const { targetPath, fileContent } of changes) {
    const outputPath = path.normalize(targetPath).replaceAll('\\', '/');
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
