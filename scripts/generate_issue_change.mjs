#!/usr/bin/env node

import { buildDeterministicPrompt, loadConfigFromEnv } from './lib/config.mjs';
import { callGroq } from './lib/groq_client.mjs';
import { validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';

async function main() {
  const config = loadConfigFromEnv();
  const prompt = buildDeterministicPrompt(config);

  console.log('[INFO] Calling Groq model with deterministic prompt template...');
  const aiOutput = await callGroq({
    prompt,
    apiKey: config.apiKey,
    model: config.model,
    apiUrl: config.apiUrl,
  });

  const { summary, contentMarkdown } = validateAiOutput(aiOutput);
  const outputPath = await writeGeneratedFiles({
    issueNumber: config.issueNumber,
    issueTitle: config.issueTitle,
    summary,
    contentMarkdown,
  });

  console.log(`[INFO] Wrote generated change: ${outputPath}`);
  console.log('[INFO] Wrote PR summary helper: .ai-summary.txt');
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
});
