#!/usr/bin/env node

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { requireEnv, loadLLMConfig } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { filterDiff, shouldIncludeFile } from './lib/file_filters.mjs';
import { loadPrompt, interpolatePrompt } from './lib/prompts.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles } from './lib/output_writer.mjs';
import { log, error as logError } from './lib/logger.mjs';

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  process.exit(1);
});

const MAX_ATTEMPTS = 3;
const MAX_FILE_SIZE = 2000;
const MAX_FILES = 5;
const ATTEMPT_LABEL_PREFIX = 'auto-fix-attempt-';
const TOKEN_SAFETY_MARGIN = 200;

const MODEL_TPM = {
  'qwen/qwen3-32b': 6000,
  'llama-3.1-8b-instant': 30000,
};

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(text, tokenBudget) {
  if (tokenBudget <= 0) return '';
  const maxChars = tokenBudget * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

const githubToken = requireEnv('GITHUB_TOKEN');
const repository = requireEnv('GITHUB_REPOSITORY');
const eventPath = requireEnv('GITHUB_EVENT_PATH');
const { provider: llmProvider, apiKey: llmApiKey, model, apiUrl, temperature: llmTemperature, maxTokens: llmMaxTokens } = loadLLMConfig('autofix');

let event;
try {
  event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`, { cause: err });
}
if (!event || typeof event !== 'object') throw new Error('GitHub event payload is not a valid object');

const prNumber = event.pull_request?.number;
if (!prNumber) throw new Error('Missing pull_request.number in event payload');

const re