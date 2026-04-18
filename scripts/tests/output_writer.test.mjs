import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAiOutput } from '../lib/output_writer.mjs';

test('validateAiOutput returns trimmed fields for valid input', () => {
  const result = validateAiOutput({
    summary: '  Add readme  ',
    target_path: 'docs/readme.md',
    file_content: '# Hello',
  });
  assert.equal(result.summary, 'Add readme');
  assert.equal(result.targetPath, 'docs/readme.md');
  assert.equal(result.fileContent, '# Hello');
});

test('validateAiOutput throws when summary is missing', () => {
  assert.throws(
    () => validateAiOutput({ summary: '', target_path: 'a.md', file_content: 'x' }),
    /missing non-empty summary/,
  );
});

test('validateAiOutput throws when target_path is missing', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', target_path: '', file_content: 'x' }),
    /missing non-empty target_path/,
  );
});

test('validateAiOutput throws when file_content is blank', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', target_path: 'a.md', file_content: '   ' }),
    /missing non-empty file_content/,
  );
});

test('validateAiOutput throws for absolute path', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', target_path: '/etc/passwd', file_content: 'x' }),
    /safe relative path/,
  );
});

test('validateAiOutput throws for path with ..', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', target_path: '../outside/file.md', file_content: 'x' }),
    /safe relative path/,
  );
});

test('validateAiOutput throws for embedded .. traversal', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', target_path: 'docs/../../etc/passwd', file_content: 'x' }),
    /safe relative path/,
  );
});

test('validateAiOutput throws when file_content exceeds 16000 chars', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', target_path: 'a.md', file_content: 'x'.repeat(16001) }),
    /too large/,
  );
});

test('validateAiOutput accepts file_content exactly at 16000 chars', () => {
  const result = validateAiOutput({
    summary: 'ok',
    target_path: 'a.md',
    file_content: 'x'.repeat(16000),
  });
  assert.equal(result.fileContent.length, 16000);
});

test('validateAiOutput coerces non-string fields to strings', () => {
  const result = validateAiOutput({
    summary: 42,
    target_path: 'a.md',
    file_content: true,
  });
  assert.equal(result.summary, '42');
});
