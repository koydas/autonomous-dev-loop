#!/usr/bin/env node

import { buildDeterministicPrompt, loadConfigFromEnv } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadPrompt } from './lib/prompts.mjs';
import { validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';
import { log, error as logError } from './lib/logger.mjs';
import { buildFileContentsBlock } from './lib/file_injector.mjs';
import fs from 'node:fs/promises';

async function main() {
  const config = loadConfigFromEnv();
  const fileContents = await buildFileContentsBlock(config.issueTitle, config.issueBody, process.cwd());
  const prompt = buildDeterministicPrompt({ ...config, fileContents });
  const systemPrompt = loadPrompt('generation-system');

  log('Calling LLM with deterministic prompt template');
  const raw = await callLLM({
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

  log('Wrote generated changes', { paths: outputPaths.join(', ') });
  log('Exported workflow outputs: summary, generated_paths');
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
