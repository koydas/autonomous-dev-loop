import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlatYaml, parseNestedYaml } from '../lib/yaml.mjs';

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
    'validation: qwen-qwq-32b',
    'generation: qwen-qwq-32b',
    'review:     qwen-qwq-32b',
  ].join('\n');
  const result = parseFlatYaml(yaml);
  assert.equal(result.validation, 'qwen-qwq-32b');
  assert.equal(result.generation, 'qwen-qwq-32b');
  assert.equal(result.review, 'qwen-qwq-32b');
});

// parseNestedYaml tests

test('parseNestedYaml parses 3-level nested structure', () => {
  const yaml = [
    'issue:',
    '  valid:',
    '    name: ready-for-dev',
    '    color: 0075ca',
  ].join('\n');
  const result = parseNestedYaml(yaml);
  assert.deepEqual(result, { issue: { valid: { name: 'ready-for-dev', color: '0075ca' } } });
});

test('parseNestedYaml parses multiple groups and sections', () => {
  const yaml = [
    'issue:',
    '  valid:',
    '    name: ready-for-dev',
    '  invalid:',
    '    name: needs-refinement',
    'review:',
    '  approved:',
    '    name: review-approved',
  ].join('\n');
  const result = parseNestedYaml(yaml);
  assert.equal(result.issue.valid.name, 'ready-for-dev');
  assert.equal(result.issue.invalid.name, 'needs-refinement');
  assert.equal(result.review.approved.name, 'review-approved');
});

test('parseNestedYaml ignores blank lines and comments', () => {
  const yaml = [
    '# top comment',
    'issue:',
    '  # section comment',
    '  valid:',
    '',
    '    name: ready-for-dev',
  ].join('\n');
  const result = parseNestedYaml(yaml);
  assert.equal(result.issue.valid.name, 'ready-for-dev');
});

test('parseNestedYaml handles values containing colons', () => {
  const yaml = [
    'group:',
    '  key:',
    '    url: https://example.com/path',
  ].join('\n');
  const result = parseNestedYaml(yaml);
  assert.equal(result.group.key.url, 'https://example.com/path');
});

test('parseNestedYaml returns empty object for empty input', () => {
  assert.deepEqual(parseNestedYaml(''), {});
});

test('parseNestedYaml parses labels.yaml structure correctly', () => {
  const yaml = [
    'issue:',
    '  valid:',
    '    name: ready-for-dev',
    '    color: 0075ca',
    '    description: Issue validated and ready for automated implementation',
    '  invalid:',
    '    name: needs-refinement',
    '    color: e4e669',
    '    description: Issue requires clearer acceptance criteria before automation',
    'review:',
    '  approved:',
    '    name: review-approved',
    '    color: 0e8a16',
    '    description: Automated code review passed without requested changes',
    '  changes:',
    '    name: changes-requested',
    '    color: d93f0b',
    '    description: Automated code review found issues requiring changes',
  ].join('\n');
  const result = parseNestedYaml(yaml);
  assert.equal(result.issue.valid.name, 'ready-for-dev');
  assert.equal(result.issue.valid.color, '0075ca');
  assert.equal(result.issue.invalid.name, 'needs-refinement');
  assert.equal(result.review.approved.name, 'review-approved');
  assert.equal(result.review.changes.name, 'changes-requested');
  assert.equal(result.review.changes.color, 'd93f0b');
});
