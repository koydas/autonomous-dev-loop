import fs from 'node:fs/promises';

export function validateAiOutput(aiOutput) {
  const summary = String(aiOutput.summary || '').trim();
  const contentMarkdown = String(aiOutput.content_markdown || '').trim();

  if (!summary) {
    throw new Error('AI response missing non-empty summary');
  }
  if (!contentMarkdown) {
    throw new Error('AI response missing non-empty content_markdown');
  }
  if (contentMarkdown.length > 8000) {
    throw new Error('AI response content_markdown too large (>8000 chars)');
  }

  return { summary, contentMarkdown };
}

export async function writeGeneratedFiles({ issueNumber, issueTitle, summary, contentMarkdown }) {
  const outputPath = `ai-generated/issue-${issueNumber}.md`;
  const fileContent = `# AI Draft for Issue #${issueNumber}\n\n**Title:** ${issueTitle}\n\n## Generated Proposal\n\n${contentMarkdown}\n`;

  await fs.mkdir('ai-generated', { recursive: true });
  await fs.writeFile(outputPath, fileContent, 'utf8');
  await fs.writeFile('.ai-summary.txt', `${summary}\n`, 'utf8');

  return outputPath;
}
