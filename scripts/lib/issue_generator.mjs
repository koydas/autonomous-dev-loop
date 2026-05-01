import { loadPrompt, interpolatePrompt } from './prompts.mjs';
import { parseJsonResponse, validateAiOutput } from './output_writer.mjs';

export function buildGenerationUserPrompt(issueTitle, issueBody) {
  const template = loadPrompt('generation-user');
  return interpolatePrompt(template, {
    issueNumber: '',
    issueTitle,
    issueBody: issueBody || '(no body provided)',
    fileContents: 'No existing files identified as relevant to this issue.',
  });
}

export async function generateIssueChange({ issueTitle, issueBody, callGroq }) {
  const prompt = buildGenerationUserPrompt(issueTitle, issueBody);
  const rawResponse = await callGroq({ prompt });
  const aiOutput = parseJsonResponse(String(rawResponse));
  const { summary, changes } = validateAiOutput(aiOutput);
  return { summary, changes: changes.map(({ targetPath, fileContent }) => ({ target_path: targetPath, file_content: fileContent })) };
}
