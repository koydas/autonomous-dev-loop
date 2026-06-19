#!/usr/bin/env node

import { buildDeterministicPrompt, loadConfigFromEnv, validateStartup } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadPrompt } from './lib/prompts.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';
import { log, error as logError } from './lib/logger.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { buildFileContentsBlock } from './lib/file_injector.mjs';
import { writeCheckpoint } from './lib/checkpoint.mjs';
import { estimateTokens } from './lib/metrics.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

let tracer;

process.on('unhandledRejection', async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  await tracer?.finalize('failed');
  process.exit(1);
});

async function main() {
  const startMs = Date.now();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const traceDir = path.join(process.cwd(), 'observability', 'traces');
  tracer = createTracer({ runId, issueNumber: null, traceDir });

  validateStartup();
  const config = loadConfigFromEnv();

  obsLog({ stage: 'code_gen', event: 'code_gen.start', level: 'info', meta: { issueNumber: config.issueNumber, model: config.model } });
  tracer.startSpan('code_gen', { issueNumber: config.issueNumber, model: config.model });

  let fileContents, prompt, systemPrompt;
  try {
    fileContents = await buildFileContentsBlock(config.issueTitle, config.issueBody, process.cwd());
    prompt = buildDeterministicPrompt({ ...config, fileContents });
    systemPrompt = loadPrompt('generation-system');
  } catch (err) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }

  const inputTokensEst = estimateTokens(systemPrompt + prompt);
  obsLog({ stage: 'code_gen', event: 'code_gen.llm_request', level: 'info', meta: { model: config.model, input_tokens_est: inputTokensEst } });
  log('Calling LLM with deterministic prompt template');

  let raw;
  try {
    raw = await callLLM({
      prompt,
      systemPrompt,
      apiKey: config.apiKey,
      model: config.model,
      apiUrl: config.apiUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
  } catch (err) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }

  obsLog({ stage: 'code_gen', event: 'code_gen.llm_response', level: 'info', meta: { output_tokens_est: estimateTokens(raw) } });

  let aiOutput;
  try {
    aiOutput = parseJsonResponse(raw);
  } catch (err) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: 'JSON parse failed', detail: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: 'JSON parse failed' } });
    await tracer.finalize('failed');
    throw new Error('AI response was not valid JSON', { cause: err });
  }
  if (!aiOutput || typeof aiOutput !== 'object' || Array.isArray(aiOutput)) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: 'AI response JSON must be an object' } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: 'invalid JSON shape' } });
    await tracer.finalize('failed');
    throw new Error('AI response JSON must be an object');
  }

  let summary, changes;
  try {
    ({ summary, changes } = validateAiOutput(aiOutput));
  } catch (err) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }
  const codeGenMs = Date.now() - startMs;
  obsLog({ stage: 'code_gen', event: 'code_gen.complete', level: 'info', duration_ms: codeGenMs, meta: { changes_count: changes.length } });
  tracer.endSpan('code_gen', { outcome: 'success', meta: { changes_count: changes.length } });

  // PR prepare stage: write files to disk (the GitHub Action step creates the actual PR)
  const prPrepareStartMs = Date.now();
  obsLog({ stage: 'pr_prepare', event: 'pr_prepare.start', level: 'info', meta: { changes_count: changes.length } });
  tracer.startSpan('pr_prepare', { changes_count: changes.length });

  let outputPaths;
  try {
    outputPaths = await writeGeneratedFiles(changes);
  } catch (err) {
    obsLog({ stage: 'pr_prepare', event: 'pr_prepare.error', level: 'error', duration_ms: Date.now() - prPrepareStartMs, meta: { error: err.message } });
    tracer.endSpan('pr_prepare', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }

  obsLog({ stage: 'pr_prepare', event: 'pr_prepare.complete', level: 'info', duration_ms: Date.now() - prPrepareStartMs, meta: { paths: outputPaths } });
  tracer.endSpan('pr_prepare', { outcome: 'success', meta: { paths: outputPaths } });

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `summary<<EOF\n${summary}\nEOF\ngenerated_paths<<EOF\n${outputPaths.join('\n')}\nEOF\n`,
      'utf8',
    );
  }

  log('Wrote generated changes', { paths: outputPaths.join(', ') });
  log('Exported workflow outputs: summary, generated_paths');

  const cpRunId = process.env.CHECKPOINT_RUN_ID ?? `issue-${process.env.ISSUE_NUMBER ?? 'unknown'}`;
  await writeCheckpoint(cpRunId, 'generate', { summary, outputPaths });
  log('Checkpoint written', { runId: cpRunId, step: 'generate' });

  await tracer.finalize('success');
}

main().catch(async (err) => {
  logError('Fatal error', { error: err.message, stack: err.stack });
  await tracer?.finalize('failed');
  process.exit(1);
});
