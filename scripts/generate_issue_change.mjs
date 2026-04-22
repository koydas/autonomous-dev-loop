#!/usr/bin/env node

import { buildDeterministicPrompt, loadConfigFromEnv } from './lib/config.mjs';
import { callGroq } from './lib/groq_client.mjs';
import { loadPrompt } from './lib/prompts.mjs';
import { validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';
import fs from 'node:fs/promises';

async function main() {
  const config = loadConfigFromEnv();
  const prompt = buildDeterministicPrompt(config);
  const systemPrompt = loadPrompt('generation-system');

  console.log('[INFO] Calling Groq model with deterministic prompt template...');
  const raw = await callGroq({
    prompt,
    systemPrompt,
    apiKey: config.apiKey,
    model: config.model,
    apiUrl: config.apiUrl,
  });

  let aiOutput;
  try {
    aiOutput = JSON.parse(raw);
  } catch {
    throw new Error('AI response was not valid JSON');
  }
  if (!aiOutput || typeof aiOutput !== 'object' || Array.isArray(aiOutput)) {
    throw new Error('AI response JSON must be an object');
  }

  const { summary, changes } = validateAiOutput(aiOutput);
  const outputPaths = await writeGeneratedFiles(changes);

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `summary<<EOF\n${summary}\nEOF\ngenerated_paths<<EOF\n${outputPaths.join('\n')}\nEOF\n`,
      'utf8',
    );
  }

  console.log(`[INFO] Wrote generated changes: ${outputPaths.join(', ')}`);
  console.log('[INFO] Exported workflow outputs: summary, generated_paths');
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
});
