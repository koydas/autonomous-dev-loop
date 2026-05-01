import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIssue } from '../lib/issue_validator.mjs';
import { generateIssueChange } from '../lib/issue_generator.mjs';

const ISSUE_TITLE = 'Add user login endpoint';
const ISSUE_BODY = 'We need a secure user login endpoint that accepts username and password.';

function makeValidationResponse(overrides = {}) {
  return JSON.stringify({ valid: true, score: 85, blockers: [], warnings: [], suggested_ac: [], ...overrides });
}

function makeGenerationResponse(overrides = {}) {
  return JSON.stringify({
    summary: 'summary',
    changes: [{ target_path: 'path/to/file.js', file_content: 'content' }],
    ...overrides,
  });
}

test('validate_issue runs end-to-end with a mocked LLM', async () => {
  const callGroq = () => makeValidationResponse();
  const result = await validateIssue({ issueTitle: ISSUE_TITLE, issueBody: ISSUE_BODY, callGroq });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.score, 85);
  assert.deepStrictEqual(result.blockers, []);
});

test('generate_issue_change runs end-to-end with a mocked LLM', async () => {
  const callGroq = () => makeGenerationResponse();
  const result = await generateIssueChange({ issueTitle: ISSUE_TITLE, issueBody: ISSUE_BODY, callGroq });
  assert.strictEqual(result.summary, 'summary');
  assert.deepStrictEqual(result.changes, [{ target_path: 'path/to/file.js', file_content: 'content' }]);
});

test('validate_issue handles a malformed LLM response', async () => {
  const callGroq = () => 'malformed response';
  await assert.rejects(
    () => validateIssue({ issueTitle: ISSUE_TITLE, issueBody: ISSUE_BODY, callGroq }),
  );
});

test('generate_issue_change handles a malformed LLM response', async () => {
  const callGroq = () => 'malformed response';
  await assert.rejects(
    () => generateIssueChange({ issueTitle: ISSUE_TITLE, issueBody: ISSUE_BODY, callGroq }),
  );
});
