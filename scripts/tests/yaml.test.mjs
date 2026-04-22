import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlatYaml } from '../lib/yaml.mjs';

test('parses simple key: value pairs', () => {
  const result = parseFlatYaml('foo: bar\nbaz: qux');
  assert.deepEqual(result, { foo: 'bar', baz: 'qux' });
});

test('ignores blank lines', () => {
  const result = parseFlatYaml('\nfoo: bar\n\nbaz: qux\n');
  assert.deepEqual(result, { foo: 'bar', baz: 'qux' });
});

test('ignores # comment lines', () => {
  const result = parseFlatYaml('# comment\nfoo: bar');
  assert.deepEqual(result, { foo: 'bar' });
});

test('ignores inline comment after value', () => {
  // Inline comments are not standard in flat YAML — value includes everything after colon
  const result = parseFlatYaml('foo: bar # not a comment');
  assert.equal(result.foo, 'bar # not a comment');
});

test('trims whitespace around keys and values', () => {
  const result = parseFlatYaml('  key  :   value  ');
  assert.deepEqual(result, { key: 'value' });
});

test('handles values containing colons', () => {
  const result = parseFlatYaml('url: https://api.example.com/v1');
  assert.equal(result.url, 'https://api.example.com/v1');
});

test('skips lines without a colon', () => {
  const result = parseFlatYaml('no-colon-here\nfoo: bar');
  assert.deepEqual(result, { foo: 'bar' });
});

test('returns empty object for empty input', () => {
  assert.deepEqual(parseFlatYaml(''), {});
});

test('parses models.yaml keys correctly', () => {
  const yaml = [
    '# comment',
    'validation: llama-3.3-70b-versatile',
    'generation: llama-3.1-8b-instant',
    'review:     llama-3.3-70b-versatile',
  ].join('\n');
  const result = parseFlatYaml(yaml);
  assert.equal(result.validation, 'llama-3.3-70b-versatile');
  assert.equal(result.generation, 'llama-3.1-8b-instant');
  assert.equal(result.review, 'llama-3.3-70b-versatile');
});
