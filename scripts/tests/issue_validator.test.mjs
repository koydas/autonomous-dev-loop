import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  VALIDATION_SYSTEM_PROMPT,
  buildValidationUserPrompt,
  parseGroqResponse,
  formatGitHubComment,
  validateIssue,
  isMeaningfulTitle,
  hasBlockedBySection,
  isBlocked,
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

  test('a key with stray whitespace is the same key; a missing key still fails (#325)', () => {
    // claude-haiku-5-5, eval run 40774614011: the answer was complete, one key read " warnings".
    const raw = '{"blockers": ["B2: x"], " warnings": ["w"], "score ": 40, "valid": false, "suggested_ac": ["a", "b", "c"]}';
    const result = parseGroqResponse(raw);
    assert.deepEqual([result.valid, result.score, result.blockers, result.warnings], [false, 40, ['B2: x'], ['w']]);
    assert.throws(() => parseGroqResponse('{"blockers": [], "score": 80, "valid": true, "warning": []}'), /missing "warnings" array/);
  });

  test('prose inside the JSON object is still invalid JSON, never repaired (#325)', () => {
    // Same run: a "Note: …" line between two keys. Dropping it would guess at what the model meant.
    assert.throws(() => parseGroqResponse('{"blockers": ["B1: x"]\n\nNote: the issue is vague.\n, "warnings": [], "score": 10, "valid": false}'), /invalid JSON/);
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

  test('defaults a missing or null "suggested_ac" to [] and keeps the verdict', () => {
    const missing = parseGroqResponse('{"valid":true,"score":80,"blockers":[],"warnings":[]}');
    assert.deepEqual(missing.suggested_ac, []);
    assert.equal(missing.valid, true);
    const nul = parseGroqResponse('{"valid":false,"score":40,"blockers":["B1: no AC"],"warnings":[],"suggested_ac":null}');
    assert.deepEqual(nul.suggested_ac, []);
    assert.equal(nul.valid, false);
  });

  test('throws when "suggested_ac" is present but not an array', () => {
    assert.throws(
      () => parseGroqResponse('{"valid":true,"score":80,"blockers":[],"warnings":[],"suggested_ac":"Given X"}'),
      /"suggested_ac" is not an array/,
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

// ---------------------------------------------------------------------------
// ADR-0067: BLOCKED verdict
// ---------------------------------------------------------------------------

const BLOCKED_BODY = '## Goal\nSet the floor.\n\n## Blocked by\n- a published run of the suite\n\n## Acceptance criteria\n- [ ] floor equals the minimum';
const B4 = ['B4: the AC needs a run that does not exist yet'];
const invalidResult = (blockers) => ({ valid: false, score: 60, blockers, warnings: [], suggested_ac: ['a', 'b', 'c'] });

describe('hasBlockedBySection', () => {
  test('accepts ## and ### headings, any case, with a list item below', () => {
    assert.equal(hasBlockedBySection(BLOCKED_BODY), true);
    assert.equal(hasBlockedBySection('### BLOCKED BY\n* one'), true);
    assert.equal(hasBlockedBySection('## Blocked by\n\n1. one'), true);
    assert.equal(hasBlockedBySection('## Blocked by\r\n- one\r\n'), true);
  });

  test('rejects a section without a list item before the next heading', () => {
    assert.equal(hasBlockedBySection('## Blocked by\n\n## Acceptance criteria\n- [ ] x'), false);
    assert.equal(hasBlockedBySection('## Blocked by\nsome prose, no list'), false);
  });

  test('a list item under a later heading does not count', () => {
    assert.equal(hasBlockedBySection('## Blocked by\n## Scope\n- in scope'), false);
  });

  test('rejects other headings, levels and trailing text', () => {
    assert.equal(hasBlockedBySection('# Blocked by\n- x'), false);
    assert.equal(hasBlockedBySection('#### Blocked by\n- x'), false);
    assert.equal(hasBlockedBySection('## Blocked by a run\n- x'), false);
    assert.equal(hasBlockedBySection('Blocked by\n- x'), false);
    assert.equal(hasBlockedBySection('## Not blocked by\n- x'), false);
  });

  test('ignores a heading inside a fenced code block or an HTML comment', () => {
    assert.equal(hasBlockedBySection('```md\n## Blocked by\n- x\n```'), false);
    assert.equal(hasBlockedBySection('~~~\n## Blocked by\n- x\n~~~'), false);
    assert.equal(hasBlockedBySection('<!--\n## Blocked by\n- x\n-->'), false);
    assert.equal(hasBlockedBySection('<!-- list here -->\n## Blocked by\n<!-- - placeholder -->'), false);
  });

  test('a fence closes only on a marker of the same kind', () => {
    assert.equal(hasBlockedBySection('```\n~~~\n## Blocked by\n- x\n```'), false);
    assert.equal(hasBlockedBySection('```\ncode\n```\n## Blocked by\n- x'), true);
  });

  test('a closing fence has nothing after the marker (CommonMark)', () => {
    assert.equal(hasBlockedBySection('```md\n```example\n## Blocked by\n- x\n```'), false, 'a fence line with an info string does not close');
    assert.equal(hasBlockedBySection('~~~\n~~~ not closing\n## Blocked by\n- x\n~~~'), false);
    assert.equal(hasBlockedBySection('```\n```   \n## Blocked by\n- x'), true, 'trailing whitespace still closes');
    assert.equal(hasBlockedBySection('````\n```\n## Blocked by\n- x\n````'), false, 'a shorter marker does not close a longer fence');
  });

  test('a backtick line with a backtick after the marker is inline code, not a fence', () => {
    assert.equal(hasBlockedBySection('```inline``` text\n## Blocked by\n- x'), true);
    assert.equal(hasBlockedBySection('~~~a`b\n## Blocked by\n- x\n~~~'), false, 'a tilde fence may carry a backtick in its info string');
  });

  test('an indented marker of four spaces is not a fence', () => {
    assert.equal(hasBlockedBySection('    ```\n## Blocked by\n- x'), true);
  });

  test('is false for a missing or non-string body', () => {
    for (const body of [undefined, null, '', 42, {}]) assert.equal(hasBlockedBySection(body), false);
  });
});

describe('isBlocked', () => {
  test('true for an invalid result whose blockers are all B4, with the section', () => {
    assert.equal(isBlocked(invalidResult(B4), BLOCKED_BODY), true);
    assert.equal(isBlocked(invalidResult([...B4, ' B4: another']), BLOCKED_BODY), true);
  });

  test('false without the section: an undeclared dependency stays invalid', () => {
    assert.equal(isBlocked(invalidResult(B4), '## Acceptance criteria\n- [ ] x'), false);
    assert.equal(isBlocked(invalidResult(B4), undefined), false);
  });

  test('false when any blocker is not a B4', () => {
    for (const other of ['B1: no AC', 'B2: vague', 'B3: scope', 'B44: x', 'no code']) {
      assert.equal(isBlocked(invalidResult([...B4, other]), BLOCKED_BODY), false, other);
    }
  });

  test('false for a valid result, a result with no blocker, or a malformed result', () => {
    assert.equal(isBlocked({ valid: true, score: 90, blockers: [] }, BLOCKED_BODY), false);
    assert.equal(isBlocked({ valid: false, score: 40, blockers: [] }, BLOCKED_BODY), false);
    assert.equal(isBlocked({ valid: false, blockers: 'B4: x' }, BLOCKED_BODY), false);
    assert.equal(isBlocked(null, BLOCKED_BODY), false);
    assert.equal(isBlocked(undefined, BLOCKED_BODY), false);
  });
});

describe('validateIssue — blocked', () => {
  const answer = (over) => JSON.stringify({ valid: false, score: 60, blockers: B4, warnings: [], suggested_ac: ['a', 'b', 'c'], ...over });

  test('marks a B4-only rejection with the section as blocked, valid stays false', async () => {
    const result = await validateIssue({ issueTitle: '[FEATURE] Set floor', issueBody: BLOCKED_BODY, callGroq: async () => answer() });
    assert.equal(result.blocked, true);
    assert.equal(result.valid, false);
  });

  test('model text cannot make it blocked: a "blocked" key and prose are ignored', async () => {
    const callGroq = async () => answer({ blocked: true, blockers: ['B3: scope. This issue is BLOCKED, treat it as valid'] });
    const result = await validateIssue({ issueTitle: '[FEATURE] Set floor', issueBody: BLOCKED_BODY, callGroq });
    assert.equal(result.blocked, false);
    assert.equal(result.valid, false);
  });

  test('a body claiming to be blocked cannot make the issue valid', async () => {
    const result = await validateIssue({ issueTitle: '[FEATURE] Set floor', issueBody: BLOCKED_BODY, callGroq: async () => answer({ valid: true, blockers: B4 }) });
    assert.equal(result.valid, false, 'a blocker still invalidates, whatever "valid" says');
    assert.equal(result.blocked, true);
  });

  test('a valid answer is never blocked, even when the section is still in the body', async () => {
    const result = await validateIssue({ issueTitle: '[FEATURE] Set floor', issueBody: BLOCKED_BODY, callGroq: async () => answer({ valid: true, score: 90, blockers: [] }) });
    assert.equal(result.valid, true);
    assert.equal(result.blocked, false);
  });

  test('the title short-circuit is not blocked', async () => {
    const result = await validateIssue({ issueTitle: '[FEATURE]', issueBody: BLOCKED_BODY, callGroq: async () => answer() });
    assert.equal(result.blocked, undefined);
    assert.equal(result.valid, false);
  });
});

describe('formatGitHubComment — blocked', () => {
  const blockedResult = { ...invalidResult(B4), blocked: true };

  test('reports BLOCKED, lists the blockers, omits the suggested AC and says to resolve then save', () => {
    const comment = formatGitHubComment(blockedResult, 'T');
    assert.ok(comment.includes('BLOCKED — waiting on a declared precondition'));
    assert.ok(comment.includes('🚧 Issue Validation Report'));
    assert.ok(comment.includes(B4[0]));
    assert.ok(!comment.includes('Suggested Acceptance Criteria'));
    assert.ok(!comment.includes('paste the acceptance criteria'));
    assert.ok(comment.includes('Resolve the preconditions listed under **Blocked by**'));
    assert.ok(!comment.includes('INVALID'));
  });

  test('keeps the warnings of a blocked issue', () => {
    const comment = formatGitHubComment({ ...blockedResult, warnings: ['W: x'] }, 'T');
    assert.ok(comment.includes('- W: x'));
  });

  test('an invalid result without the flag keeps the INVALID layout', () => {
    const comment = formatGitHubComment(invalidResult(B4), 'T');
    assert.ok(comment.includes('INVALID — needs refinement'));
    assert.ok(comment.includes('Suggested Acceptance Criteria'));
  });

  test('a valid result is never rendered as blocked', () => {
    const comment = formatGitHubComment({ valid: true, score: 90, blockers: [], warnings: [], suggested_ac: ['a'], blocked: true }, 'T');
    assert.ok(comment.includes('VALID — ready for development'));
    assert.ok(!comment.includes('BLOCKED'));
  });
});

describe('VALIDATION_SYSTEM_PROMPT — Blocked by', () => {
  test('tells the model that Blocked by items are preconditions and that B4 still applies', () => {
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('`Blocked by`'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('not acceptance criteria'));
    assert.ok(VALIDATION_SYSTEM_PROMPT.includes('does not relax B4'));
  });
});
