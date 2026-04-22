import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  VALIDATION_SYSTEM_PROMPT,
  buildValidationUserPrompt,
  parseGroqResponse,
  formatGitHubComment,
  validateIssue,
  isMeaningfulTitle,
} from '../lib/issue_validator.mjs';

// ---------------------------------------------------------------------------
// VALIDATION_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe('VALIDATION_SYSTEM_PROMPT', () => {
  test('is a non-empty string', () => {
    assert.equal(typeof VALIDATION_SYSTEM_PROMPT, 'string');
    assert.ok(VALIDATION_SYSTEM_PROMPT.length > 0);
  });

  test('exceeds 4000 characters (proxy for >= 1024 tokens for caching)', () => {
    assert.ok(
      VALIDATION_SYSTEM_PROMPT.length > 4000,
      `System prompt is ${VALIDATION_SYSTEM_PROMPT.length} chars — must exceed 4000 for caching`,
    );
  });

  test('contains key validation criteria keywords', () => {
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('acceptance criteria'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('testable') || VALIDATION_SYSTEM_PROMPT.includes('Testable'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('score'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('blockers'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('suggested_ac'));
  });

  test('specifies the JSON output format', () => {
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('"valid"'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('"score"'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('"warnings"'));
  });
});

// ---------------------------------------------------------------------------
// isMeaningfulTitle
// ---------------------------------------------------------------------------

describe('isMeaningfulTitle', () => {
  test('returns false for empty string', () => {
    assert.equal(isMeaningfulTitle(''), false);
  });

  test('returns false for whitespace-only string', () => {
    assert.equal(isMeaningfulTitle('   '), false);
  });

  test('returns false for null/undefined', () => {
    assert.equal(isMeaningfulTitle(null), false);
    assert.equal(isMeaningfulTitle(undefined), false);
  });

  test('returns false for [FEATURE] with no description', () => {
    assert.equal(isMeaningfulTitle('[FEATURE]'), false);
  });

  test('returns false for [BUG] with trailing whitespace only', () => {
    assert.equal(isMeaningfulTitle('[BUG]   '), false);
  });

  test('returns false for [CHORE] alone', () => {
    assert.equal(isMeaningfulTitle('[CHORE]'), false);
  });

  test('returns true for [FEATURE] with a description', () => {
    assert.equal(isMeaningfulTitle('[FEATURE] Add login endpoint'), true);
  });

  test('returns true for [BUG] with a description', () => {
    assert.equal(isMeaningfulTitle('[BUG] Fix null pointer on login'), true);
  });

  test('returns true for a plain title with no prefix', () => {
    assert.equal(isMeaningfulTitle('Add login endpoint'), true);
  });
});

// ---------------------------------------------------------------------------
// buildValidationUserPrompt
// ---------------------------------------------------------------------------

describe('buildValidationUserPrompt', () => {
  test('includes issue title', () => {
    const prompt = buildValidationUserPrompt('Add login endpoint', 'Some body');
    assert.ok(prompt.includes('Add login endpoint'));
  });

  test('includes issue body', () => {
    const prompt = buildValidationUserPrompt('Title', 'Detailed body here');
    assert.ok(prompt.includes('Detailed body here'));
  });

  test('uses fallback text when body is empty', () => {
    const prompt = buildValidationUserPrompt('Title', '');
    assert.ok(prompt.includes('(no body provided)'));
  });

  test('uses fallback text when body is null/undefined', () => {
    const prompt = buildValidationUserPrompt('Title', null);
    assert.ok(prompt.includes('(no body provided)'));
  });

  test('returns a non-empty string', () => {
    const prompt = buildValidationUserPrompt('T', 'B');
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0);
  });
});

// ---------------------------------------------------------------------------
// parseGroqResponse
// ---------------------------------------------------------------------------

function makeRawResponse(overrides = {}) {
  return JSON.stringify({
    valid: true,
    score: 80,
    blockers: [],
    warnings: [],
    suggested_ac: ['Given X when Y then Z'],
    ...overrides,
  });
}

describe('parseGroqResponse', () => {
  test('returns correct structure for a passing issue', () => {
    const result = parseGroqResponse(makeRawResponse());
    assert.equal(result.valid, true);
    assert.equal(result.score, 80);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.suggested_ac.length, 1);
  });

  test('forces valid=false when score < 70 even if Claude says valid=true', () => {
    const raw = makeRawResponse({ valid: true, score: 65, blockers: [] });
    const result = parseGroqResponse(raw);
    assert.equal(result.valid, false);
  });

  test('forces valid=false when blockers exist even if score >= 70', () => {
    const raw = makeRawResponse({ valid: true, score: 85, blockers: ['Missing AC'] });
    const result = parseGroqResponse(raw);
    assert.equal(result.valid, false);
  });

  test('valid=true only when score >= 70 AND blockers empty', () => {
    const raw = makeRawResponse({ valid: true, score: 70, blockers: [] });
    const result = parseGroqResponse(raw);
    assert.equal(result.valid, true);
  });

  test('clamps score to 0–100', () => {
    const raw = makeRawResponse({ score: 150 });
    assert.equal(parseGroqResponse(raw).score, 100);

    const raw2 = makeRawResponse({ score: -10 });
    assert.equal(parseGroqResponse(raw2).score, 0);
  });

  test('rounds score to integer', () => {
    const raw = makeRawResponse({ score: 74.7 });
    assert.equal(parseGroqResponse(raw).score, 75);
  });

  test('coerces array items to strings', () => {
    const raw = makeRawResponse({ blockers: [42, true], suggested_ac: [{ x: 1 }] });
    const result = parseGroqResponse(raw);
    assert.equal(typeof result.blockers[0], 'string');
    assert.equal(typeof result.suggested_ac[0], 'string');
  });

  test('extracts JSON when prefixed with prose text', () => {
    const raw = 'Here is my evaluation:\n' + makeRawResponse({ score: 75 });
    const result = parseGroqResponse(raw);
    assert.equal(result.score, 75);
  });

  test('extracts JSON when wrapped in markdown fences', () => {
    const raw = '```json\n' + makeRawResponse({ score: 82 }) + '\n```';
    const result = parseGroqResponse(raw);
    assert.equal(result.score, 82);
  });

  test('throws when no JSON object is present', () => {
    assert.throws(() => parseGroqResponse('No JSON here'), /No JSON object found/);
  });

  test('throws when JSON is malformed', () => {
    assert.throws(() => parseGroqResponse('{bad: json, stuff}'), /invalid JSON/);
  });

  test('throws when "valid" is missing', () => {
    assert.throws(
      () => parseGroqResponse('{"score":80,"blockers":[],"warnings":[],"suggested_ac":[]}'),
      /"valid"/,
    );
  });

  test('throws when "score" is missing', () => {
    assert.throws(
      () => parseGroqResponse('{"valid":true,"blockers":[],"warnings":[],"suggested_ac":[]}'),
      /"score"/,
    );
  });

  test('throws when "blockers" is not an array', () => {
    assert.throws(
      () => parseGroqResponse('{"valid":true,"score":80,"blockers":"none","warnings":[],"suggested_ac":[]}'),
      /"blockers"/,
    );
  });

  test('throws when "suggested_ac" is missing', () => {
    assert.throws(
      () => parseGroqResponse('{"valid":true,"score":80,"blockers":[],"warnings":[]}'),
      /"suggested_ac"/,
    );
  });
});

// ---------------------------------------------------------------------------
// formatGitHubComment
// ---------------------------------------------------------------------------

describe('formatGitHubComment', () => {
  const validResult = {
    valid: true,
    score: 85,
    blockers: [],
    warnings: [],
    suggested_ac: ['Given a valid user, when POST /login, then 200 with JWT'],
  };

  const invalidResult = {
    valid: false,
    score: 45,
    blockers: ['No acceptance criteria found'],
    warnings: ['Missing technical context'],
    suggested_ac: ['Given X when Y then Z', 'Given A when B then C'],
  };

  test('includes the score', () => {
    const comment = formatGitHubComment(validResult, 'Test Issue');
    assert.ok(comment.includes('85'));
  });

  test('includes VALID status for passing issues', () => {
    const comment = formatGitHubComment(validResult, 'Test Issue');
    assert.ok(comment.toLowerCase().includes('valid'));
  });

  test('includes INVALID status for failing issues', () => {
    const comment = formatGitHubComment(invalidResult, 'Test Issue');
    assert.ok(comment.toLowerCase().includes('invalid'));
  });

  test('includes blockers section when blockers exist', () => {
    const comment = formatGitHubComment(invalidResult, 'Test Issue');
    assert.ok(comment.includes('No acceptance criteria found'));
  });

  test('does not include blockers section when blockers array is empty', () => {
    const comment = formatGitHubComment(validResult, 'Test Issue');
    assert.ok(!comment.includes('🚫 Blockers'));
  });

  test('includes warnings when present', () => {
    const comment = formatGitHubComment(invalidResult, 'Test Issue');
    assert.ok(comment.includes('Missing technical context'));
  });

  test('includes all suggested_ac items in a copy-pasteable block', () => {
    const comment = formatGitHubComment(invalidResult, 'Test Issue');
    assert.ok(comment.includes('Given X when Y then Z'));
    assert.ok(comment.includes('Given A when B then C'));
    assert.ok(comment.includes('## Acceptance Criteria'));
  });

  test('suggested_ac items are formatted as checkboxes', () => {
    const comment = formatGitHubComment(invalidResult, 'Test Issue');
    assert.ok(comment.includes('- [ ]'));
  });

  test('includes next-step instruction for invalid issues', () => {
    const comment = formatGitHubComment(invalidResult, 'Test Issue');
    assert.ok(comment.toLowerCase().includes('next step'));
  });

  test('does not include next-step instruction for valid issues', () => {
    const comment = formatGitHubComment(validResult, 'Test Issue');
    assert.ok(!comment.toLowerCase().includes('next step'));
  });

  test('returns a non-empty string', () => {
    const comment = formatGitHubComment(validResult, 'Test Issue');
    assert.equal(typeof comment, 'string');
    assert.ok(comment.length > 0);
  });
});

// ---------------------------------------------------------------------------
// validateIssue (integration — callGroq is mocked)
// ---------------------------------------------------------------------------

describe('validateIssue', () => {
  test('calls callGroq with a prompt string', async () => {
    let capturedArgs = null;
    const mockCallClaude = async (args) => {
      capturedArgs = args;
      return makeRawResponse({ score: 80 });
    };

    await validateIssue({ issueTitle: 'T', issueBody: 'B', callGroq: mockCallClaude });

    assert.ok(capturedArgs !== null);
    assert.equal(typeof capturedArgs.prompt, 'string');
    assert.ok(capturedArgs.prompt.includes('T'));
    assert.ok(capturedArgs.prompt.includes('B'));
  });

  test('returns parsed result from callGroq response', async () => {
    const mockCallClaude = async () =>
      makeRawResponse({ valid: true, score: 90, blockers: [], suggested_ac: ['AC item'] });

    const result = await validateIssue({ issueTitle: 'T', issueBody: 'B', callGroq: mockCallClaude });

    assert.equal(result.valid, true);
    assert.equal(result.score, 90);
    assert.equal(result.suggested_ac[0], 'AC item');
  });

  test('propagates errors from callGroq', async () => {
    const mockCallClaude = async () => { throw new Error('API failure'); };

    await assert.rejects(
      () => validateIssue({ issueTitle: 'T', issueBody: 'B', callGroq: mockCallClaude }),
      /API failure/,
    );
  });

  test('enforces hard score rule via parseGroqResponse', async () => {
    const mockCallClaude = async () => makeRawResponse({ valid: true, score: 60, blockers: [] });

    const result = await validateIssue({ issueTitle: 'T', issueBody: 'B', callGroq: mockCallClaude });
    assert.equal(result.valid, false);
  });

  test('returns invalid without calling callGroq when title is only a [FEATURE] prefix', async () => {
    let called = false;
    const mockCallGroq = async () => { called = true; return makeRawResponse(); };

    const result = await validateIssue({ issueTitle: '[FEATURE]', issueBody: 'Body', callGroq: mockCallGroq });

    assert.equal(called, false, 'callGroq should not be invoked for a prefix-only title');
    assert.equal(result.valid, false);
    assert.equal(result.score, 0);
    assert.ok(result.blockers.length > 0);
    assert.ok(result.blockers[0].toLowerCase().includes('title'));
  });

  test('returns invalid without calling callGroq when title is empty', async () => {
    let called = false;
    const mockCallGroq = async () => { called = true; return makeRawResponse(); };

    const result = await validateIssue({ issueTitle: '', issueBody: 'Body', callGroq: mockCallGroq });

    assert.equal(called, false);
    assert.equal(result.valid, false);
  });

  test('proceeds to callGroq when title has content beyond prefix', async () => {
    let called = false;
    const mockCallGroq = async () => { called = true; return makeRawResponse({ score: 80 }); };

    await validateIssue({ issueTitle: '[FEATURE] Add login endpoint', issueBody: 'Body', callGroq: mockCallGroq });

    assert.equal(called, true, 'callGroq should be invoked for a meaningful title');
  });
});
