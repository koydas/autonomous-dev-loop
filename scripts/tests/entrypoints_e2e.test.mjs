import { test } from 'node:test';
import { validateIssue } from '../lib/issue_validator.mjs';
import { generateIssueChange } from '../lib/output_writer.mjs';
import { callLLM } from '../lib/llm_client.mjs';
import { requireEnv } from '../lib/config.mjs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpDir = tmpdir();

async function setup() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';
  const { apiKey, model, apiUrl, temperature, maxTokens } = requireEnv('LLM_CONFIG');

  return { issueNumber, issueTitle, issueBody, apiKey, model, apiUrl, temperature, maxTokens };
}

test('validate_issue runs end-to-end with a mocked LLM', async (t) => {
  const { issueNumber, issueTitle, issueBody, apiKey, model, apiUrl, temperature, maxTokens } = await setup();
  const mockCallLLM = jest.fn(() => ({ valid: true, score: 0.5, blockers: [] }));
  const result = await validateIssue({ issueTitle, issueBody, callGroq: ({ prompt }) => mockCallLLM({ prompt, systemPrompt: 'system prompt', apiKey, model, apiUrl, temperature, maxTokens }) });
  t.equal(result.valid, true);
  t.equal(result.score, 0.5);
  t.deepEqual(result.blockers, []);
});

test('generate_issue_change runs end-to-end with a mocked LLM', async (t) => {
  const { issueNumber, issueTitle, issueBody, apiKey, model, apiUrl, temperature, maxTokens } = await setup();
  const mockCallLLM = jest.fn(() => ({ summary: 'summary', changes: [{ target_path: 'path', file_content: 'content' }] }));
  const result = await generateIssueChange({ issueTitle, issueBody, callGroq: ({ prompt }) => mockCallLLM({ prompt, systemPrompt: 'system prompt', apiKey, model, apiUrl, temperature, maxTokens }) });
  t.equal(result.summary, 'summary');
  t.deepEqual(result.changes, [{ target_path: 'path', file_content: 'content' }]);
});

test('validate_issue handles a malformed LLM response', async (t) => {
  const { issueNumber, issueTitle, issueBody, apiKey, model, apiUrl, temperature, maxTokens } = await setup();
  const mockCallLLM = jest.fn(() => 'malformed response');
  try {
    await validateIssue({ issueTitle, issueBody, callGroq: ({ prompt }) => mockCallLLM({ prompt, systemPrompt: 'system prompt', apiKey, model, apiUrl, temperature, maxTokens }) });
    t.fail('Expected an error to be thrown');
  } catch (error) {
    t.pass();
  }
});

test('generate_issue_change handles a malformed LLM response', async (t) => {
  const { issueNumber, issueTitle, issueBody, apiKey, model, apiUrl, temperature, maxTokens } = await setup();
  const mockCallLLM = jest.fn(() => 'malformed response');
  try {
    await generateIssueChange({ issueTitle, issueBody, callGroq: ({ prompt }) => mockCallLLM({ prompt, systemPrompt: 'system prompt', apiKey, model, apiUrl, temperature, maxTokens }) });
    t.fail('Expected an error to be thrown');
  } catch (error) {
    t.pass();
  }
});
