import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt, interpolatePrompt } from '../lib/prompts.mjs';

const PROMPT_NAMES = [
  'validation-system',
  'validation-user',
  'generation-system',
  'generation-user',
  'pr-review-system',
  'pr-review-user',
];

// ---------------------------------------------------------------------------
// loadPrompt
// ---------------------------------------------------------------------------

describe('loadPrompt', () => {
  for (const name of PROMPT_NAMES) {
    test(`loads "${name}" as a non-empty string`, () => {
      const content = loadPrompt(name);
      assert.equal(typeof content, 'string');
      assert.ok(content.length > 0, `"${name}" prompt file must not be empty`);
    });
  }

  test('throws ENOENT for a non-existent prompt file', () => {
    assert.throws(() => loadPrompt('nonexistent'), /ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// interpolatePrompt
// ---------------------------------------------------------------------------

describe('interpolatePrompt', () => {
  test('replaces a single {{variable}} placeholder', () => {
    assert.equal(interpolatePrompt('Hello {{name}}!', { name: 'World' }), 'Hello World!');
  });

  test('replaces multiple different placeholders', () => {
    assert.equal(interpolatePrompt('{{a}} and {{b}}', { a: 'foo', b: 'bar' }), 'foo and bar');
  });

  test('replaces a repeated placeholder every occurrence', () => {
    assert.equal(interpolatePrompt('{{x}} {{x}}', { x: 'y' }), 'y y');
  });

  test('leaves unknown placeholders unchanged', () => {
    assert.equal(interpolatePrompt('{{known}} {{unknown}}', { known: 'hi' }), 'hi {{unknown}}');
  });

  test('does not alter single-brace JSON content', () => {
    const json = '{ "key": "value" }';
    assert.equal(interpolatePrompt(json, {}), json);
  });
});

// ---------------------------------------------------------------------------
// Prompt file contents
// ---------------------------------------------------------------------------

describe('prompt file contents', () => {
  test('validation-system exceeds 4000 chars (proxy for >= 1024 tokens for caching)', () => {
    assert.ok(
      loadPrompt('validation-system').length > 4000,
      `validation-system must exceed 4000 chars for prompt caching`,
    );
  });

  test('validation-system contains required validation keywords', () => {
    const content = loadPrompt('validation-system');
    assert.ok(content.includes('acceptance criteria'));
    assert.ok(content.includes('score'));
    assert.ok(content.includes('blockers'));
    assert.ok(content.includes('suggested_ac'));
  });

  test('validation-system specifies the JSON output format', () => {
    const content = loadPrompt('validation-system');
    assert.ok(content.includes('"valid"'));
    assert.ok(content.includes('"score"'));
    assert.ok(content.includes('"warnings"'));
  });

  test('validation-user contains {{issueTitle}} and {{issueBody}} placeholders', () => {
    const content = loadPrompt('validation-user');
    assert.ok(content.includes('{{issueTitle}}'));
    assert.ok(content.includes('{{issueBody}}'));
  });

  test('generation-system mentions the three required JSON output keys', () => {
    const content = loadPrompt('generation-system');
    assert.ok(content.includes('summary'));
    assert.ok(content.includes('target_path'));
    assert.ok(content.includes('file_content'));
  });

  test('generation-user contains {{issueNumber}}, {{issueTitle}}, {{issueBody}} placeholders', () => {
    const content = loadPrompt('generation-user');
    assert.ok(content.includes('{{issueNumber}}'));
    assert.ok(content.includes('{{issueTitle}}'));
    assert.ok(content.includes('{{issueBody}}'));
  });

  test('generation-user contains the JSON output schema', () => {
    const content = loadPrompt('generation-user');
    assert.ok(content.includes('summary'));
    assert.ok(content.includes('target_path'));
    assert.ok(content.includes('file_content'));
  });

  test('pr-review-system is a non-empty string', () => {
    assert.ok(loadPrompt('pr-review-system').length > 0);
  });

  test('pr-review-user contains {{diff}} placeholder', () => {
    assert.ok(loadPrompt('pr-review-user').includes('{{diff}}'));
  });

  test('pr-review-user contains the expected output sections', () => {
    const content = loadPrompt('pr-review-user');
    assert.ok(content.includes('Summary'));
    assert.ok(content.includes('Verdict'));
  });
});
