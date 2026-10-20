import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PIPELINE_ROOT } from './roots.mjs';

const PROMPTS_DIR = resolve(PIPELINE_ROOT, 'prompts');

export function loadPrompt(name) {
  const promptPath = resolve(PROMPTS_DIR, `${name}.md`);
  if (!existsSync(promptPath)) {
    throw new Error(`Prompt file not found for "${name}" at ${promptPath}`);
  }
  let content;
  try {
    content = readFileSync(promptPath, 'utf8');
  } catch (err) {
    throw new Error(`Prompt file not found for "${name}" at ${promptPath}`, { cause: err });
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(`Prompt file is empty for "${name}" at ${promptPath}`);
  }
  return trimmed;
}

export function interpolatePrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in vars ? String(vars[key]) : match;
  });
}
