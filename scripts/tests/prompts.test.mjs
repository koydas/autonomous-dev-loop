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
  'auto-fix-system',
  'auto-fix-user',
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

  test('throws explicit error for a non-existent prompt file', () => {
    assert.throws(() => loadPrompt('nonexistent'), /Prompt file not found/);
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
    assert.ok(content.includes('changes'));
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
    assert.ok(content.includes('changes'));
    assert.ok(content.includes('target_path'));
    assert.ok(content.includes('file_content'));
  });

  test('pr-review-system is a non-empty string', () => {
    assert.ok(loadPrompt('pr-review-system').length > 0);
  });

  test('pr-review-system generalizes the test-coverage gate beyond automation paths', () => {
    const content = loadPrompt('pr-review-system');
    assert.ok(content.includes('NOT limited to automation paths'));
    assert.ok(content.includes('tests_expected'));
  });

  test('pr-review-system trusts has_test_file_changes over the visible diff text', () => {
    const content = loadPrompt('pr-review-system');
    assert.ok(content.includes('has_test_file_changes'));
    assert.ok(content.includes('truncated'));
  });

  test('pr-review-system requires disclosing a truncated diff', () => {
    const content = loadPrompt('pr-review-system');
    assert.ok(content.includes('diff_truncated'));
    assert.ok(content.includes('partial view'));
  });

  test('pr-review-system includes the named defect checklist', () => {
    const content = loadPrompt('pr-review-system');
    assert.ok(content.includes('Read-only property assignment'));
    assert.ok(content.includes('Unauthorized dependency'));
    assert.ok(content.includes('Non-persistent "ref" pattern'));
  });

  test('auto-fix-system distinguishes no-import globals from importable Node built-ins', () => {
    const content = loadPrompt('auto-fix-system');
    assert.ok(content.includes('AbortController'));
    assert.ok(/still need an explicit.*import.*require/i.test(content));
  });

  test('auto-fix-system requires including missing tests regardless of path', () => {
    const content = loadPrompt('auto-fix-system');
    assert.ok(content.includes('regardless of its path'));
  });

  test('auto-fix-system requires a read-only property and persistence self-check', () => {
    const content = loadPrompt('auto-fix-system');
    assert.ok(content.includes('read-only/getter-only built-in property'));
    assert.ok(content.includes('useRef'));
  });

  test('pr-review-user contains {{diff}} placeholder', () => {
    assert.ok(loadPrompt('pr-review-user').includes('{{diff}}'));
  });

  test('pr-review-user contains the expected output sections', () => {
    const content = loadPrompt('pr-review-user');
    assert.ok(content.includes('Summary'));
    assert.ok(content.includes('Verdict'));
  });

  test('auto-fix-system mentions the required JSON output keys', () => {
    const content = loadPrompt('auto-fix-system');
    assert.ok(content.includes('summary'));
    assert.ok(content.includes('changes'));
    assert.ok(content.includes('target_path'));
    assert.ok(content.includes('file_content'));
  });

  test('auto-fix-system constrains scope to issues explicitly in the review', () => {
    const content = loadPrompt('auto-fix-system');
    assert.ok(content.includes('explicit'));
  });

  test('auto-fix-user contains {{reviewFeedback}}, {{diff}}, and {{fileContents}} placeholders', () => {
    const content = loadPrompt('auto-fix-user');
    assert.ok(content.includes('{{reviewFeedback}}'));
    assert.ok(content.includes('{{diff}}'));
    assert.ok(content.includes('{{fileContents}}'));
  });

  test('auto-fix-user contains the JSON output schema', () => {
    const content = loadPrompt('auto-fix-user');
    assert.ok(content.includes('summary'));
    assert.ok(content.includes('changes'));
    assert.ok(content.includes('target_path'));
    assert.ok(content.includes('file_content'));
  });
});
