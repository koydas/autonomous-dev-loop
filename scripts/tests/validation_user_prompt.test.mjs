import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt, interpolatePrompt } from '../lib/prompts.mjs';

const prompt = loadPrompt('validation-user');

test('validation-user ends with a Reminder section after the issue body', () => {
  const body = prompt.indexOf('{{issueBody}}');
  const reminder = prompt.indexOf('## Reminder');
  assert.ok(body !== -1, 'issueBody placeholder is present');
  assert.ok(reminder > body, 'Reminder comes after the issue body');
});

test('validation-user Reminder covers B1–B4 and text addressed to the validator', () => {
  const reminder = prompt.slice(prompt.indexOf('## Reminder'));
  assert.match(reminder, /B1–B4/);
  assert.match(reminder, /"warnings"/);
});

test('validation-user keeps both placeholders interpolatable', () => {
  const out = interpolatePrompt(prompt, { issueTitle: 'T-1', issueBody: 'B-1' });
  assert.ok(out.includes('T-1') && out.includes('B-1'));
  assert.ok(!out.includes('{{'), 'no placeholder left unresolved');
});
