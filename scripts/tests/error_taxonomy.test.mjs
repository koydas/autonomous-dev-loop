import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../lib/error_taxonomy.mjs';

// TRANSIENT — explicit list entries

test('classifyError returns TRANSIENT for "429"', () => {
  assert.equal(classifyError('429'), 'TRANSIENT');
});

test('classifyError returns TRANSIENT for "timeout"', () => {
  assert.equal(classifyError('timeout'), 'TRANSIENT');
});

// TRANSIENT — 5xx regex branch

test('classifyError returns TRANSIENT for "500"', () => {
  assert.equal(classifyError('500'), 'TRANSIENT');
});

test('classifyError returns TRANSIENT for "503"', () => {
  assert.equal(classifyError('503'), 'TRANSIENT');
});

test('classifyError returns TRANSIENT for "599"', () => {
  assert.equal(classifyError('599'), 'TRANSIENT');
});

// PERMANENT

test('classifyError returns PERMANENT for "401"', () => {
  assert.equal(classifyError('401'), 'PERMANENT');
});

test('classifyError returns PERMANENT for "403"', () => {
  assert.equal(classifyError('403'), 'PERMANENT');
});

// UNKNOWN

test('classifyError returns UNKNOWN for an unrecognised string', () => {
  assert.equal(classifyError('unknown'), 'UNKNOWN');
});

test('classifyError returns UNKNOWN for "200"', () => {
  assert.equal(classifyError('200'), 'UNKNOWN');
});

test('classifyError returns UNKNOWN for an empty string', () => {
  assert.equal(classifyError(''), 'UNKNOWN');
});

test('classifyError returns UNKNOWN for "404"', () => {
  assert.equal(classifyError('404'), 'UNKNOWN');
});
