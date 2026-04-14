#!/usr/bin/env node

import { buildDeterministicPrompt, loadConfigFromEnv } from './lib/config.mjs';
import { callGroq } from './lib/groq_client.mjs';
import { validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';
import fs from 'node:fs/promises';

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

  const { summary, targetPath, fileContent } = validateAiOutput(aiOutput);
  const outputPath = await writeGeneratedFiles({
    targetPath,
    fileContent,
  });

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `summary<<EOF\n${summary}\nEOF\ngenerated_path=${outputPath}\n`, 'utf8');
  }

  console.log(`[INFO] Wrote generated change: ${outputPath}`);
  console.log('[INFO] Exported workflow outputs: summary, generated_path');
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
});
