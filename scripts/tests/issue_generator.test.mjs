import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerationUserPrompt, generateIssueChange } from '../lib/issue_generator.mjs';

// ---------------------------------------------------------------------------
// buildGenerationUserPrompt
// ---------------------------------------------------------------------------

test('includes issueTitle in the returned prompt', () => {
  const prompt = buildGenerationUserPrompt('Add dark mode', 'Users want dark mode');
  assert.ok(prompt.includes('Add dark mode'));
});

test('includes issueBody in the returned prompt', () => {
  const prompt = buildGenerationUserPrompt('T', 'Users want dark mode');
  assert.ok(prompt.includes('Users want dark mode'));
});

test('defaults issueBody to "(no body provided)" when passed empty string', () => {
  const prompt = buildGenerationUserPrompt('Fix bug', '');
  assert.ok(prompt.includes('(no body provided)'));
});

test('defaults issueBody to "(no body provided)" when passed undefined', () => {
  const prompt = buildGenerationUserPrompt('Fix bug', undefined);
  assert.ok(prompt.includes('(no body provided)'));
});

test('leaves no unsubstituted {{...}} placeholders', () => {
  const prompt = buildGenerationUserPrompt('Add feature', 'Some body');
  const unsubstituted = prompt.match(/\{\{[^}]*\}\}/)?.[0];
  assert.ok(!unsubstituted, `Unsubstituted placeholder found: ${unsubstituted}`);
});

test('includes the fileContents fallback sentence', () => {
  const prompt = buildGenerationUserPrompt('T', 'B');
  assert.ok(prompt.includes('No existing files identified as relevant to this issue.'));
});

test('returns a non-empty string', () => {
  const prompt = buildGenerationUserPrompt('T', 'B');
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 0);
});

// ---------------------------------------------------------------------------
// generateIssueChange
// ---------------------------------------------------------------------------

function makeCallGroq(response) {
  return async () => JSON.stringify(response);
}

test('returns summary and changes on a valid JSON response', async () => {
  const callGroq = makeCallGroq({
    summary: 'Implement feature',
    changes: [{ target_path: 'src/a.js', file_content: 'const x = 1;' }],
  });
  const result = await generateIssueChange({ issueTitle: 'T', issueBody: 'B', callGroq });
  assert.equal(result.summary, 'Implement feature');
  assert.equal(result.changes.length, 1);
});

test('output changes use snake_case target_path and file_content keys', async () => {
  const callGroq = makeCallGroq({
    summary: 'S',
    changes: [{ target_path: 'a/b.js', file_content: 'x' }],
  });
  const { changes } = await generateIssueChange({ issueTitle: 'T', issueBody: 'B', callGroq });
  assert.ok('target_path' in changes[0], 'expected snake_case target_path key');
  assert.ok('file_content' in changes[0], 'expected snake_case file_content key');
  assert.ok(!('targetPath' in changes[0]), 'camelCase targetPath key should be absent');
  assert.ok(!('fileContent' in changes[0]), 'camelCase fileContent key should be absent');
});

test('target_path and file_content values are preserved correctly', async () => {
  const callGroq = makeCallGroq({
    summary: 'S',
    changes: [{ target_path: 'src/widget.js', file_content: 'export const widget = 1;' }],
  });
  const { changes } = await generateIssueChange({ issueTitle: 'T', issueBody: 'B', callGroq });
  assert.equal(changes[0].target_path, 'src/widget.js');
  assert.equal(changes[0].file_content, 'export const widget = 1;');
});

test('rejects when LLM returns non-JSON text', async () => {
  await assert.rejects(
    () => generateIssueChange({ issueTitle: 'T', issueBody: 'B', callGroq: async () => 'not json' }),
  );
});

test('rejects when LLM returns an empty changes array', async () => {
  const callGroq = makeCallGroq({ summary: 'Nothing', changes: [] });
  await assert.rejects(
    () => generateIssueChange({ issueTitle: 'T', issueBody: 'B', callGroq }),
    /non-empty changes/,
  );
});

test('parses markdown-fenced JSON responses', async () => {
  const fenced = '```json\n{"summary":"Fenced","changes":[{"target_path":"x.js","file_content":"const y=1;"}]}\n```';
  const result = await generateIssueChange({
    issueTitle: 'T',
    issueBody: 'B',
    callGroq: async () => fenced,
  });
  assert.equal(result.summary, 'Fenced');
  assert.equal(result.changes[0].target_path, 'x.js');
});

test('passes the prompt as { prompt } object to callGroq', async () => {
  let received;
  const callGroq = async (arg) => {
    received = arg;
    return JSON.stringify({
      summary: 'S',
      changes: [{ target_path: 'f.js', file_content: 'x' }],
    });
  };
  await generateIssueChange({ issueTitle: 'T', issueBody: 'B', callGroq });
  assert.ok(received && typeof received.prompt === 'string', 'callGroq should receive { prompt: string }');
});

test('includes issueTitle in the prompt passed to callGroq', async () => {
  let receivedPrompt;
  const callGroq = async ({ prompt }) => {
    receivedPrompt = prompt;
    return JSON.stringify({
      summary: 'S',
      changes: [{ target_path: 'f.js', file_content: 'x' }],
    });
  };
  await generateIssueChange({ issueTitle: 'Unique title XYZ', issueBody: 'B', callGroq });
  assert.ok(receivedPrompt.includes('Unique title XYZ'));
});
