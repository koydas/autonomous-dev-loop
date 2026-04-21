import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts');

export function loadPrompt(name) {
  return readFileSync(resolve(PROMPTS_DIR, `${name}.md`), 'utf8').trim();
}

export function interpolatePrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in vars ? String(vars[key]) : match;
  });
}
