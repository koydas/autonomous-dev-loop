import fs from 'node:fs/promises';
import path from 'node:path';

export function validateAiOutput(aiOutput) {
  const summary = String(aiOutput.summary || '').trim();
  const targetPath = String(aiOutput.target_path || '').trim();
  const fileContent = String(aiOutput.file_content || '');

  if (!summary) {
    throw new Error('AI response missing non-empty summary');
  }
  if (!targetPath) {
    throw new Error('AI response missing non-empty target_path');
  }
  if (!fileContent.trim()) {
    throw new Error('AI response missing non-empty file_content');
  }
  if (targetPath.startsWith('/') || targetPath.includes('..')) {
    throw new Error('AI response target_path must be a safe relative path');
  }
  if (fileContent.length > 16000) {
    throw new Error('AI response file_content too large (>16000 chars)');
  }

  return { summary, targetPath, fileContent };
}

export async function writeGeneratedFiles({ targetPath, fileContent }) {
  const outputPath = path.normalize(targetPath).replaceAll('\\', '/');
  const parentDir = path.dirname(outputPath);
  if (parentDir && parentDir !== '.') {
    await fs.mkdir(parentDir, { recursive: true });
  }
  await fs.writeFile(outputPath, fileContent, 'utf8');
  return outputPath;
}
