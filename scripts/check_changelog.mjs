#!/usr/bin/env node
/**
 * Gate changelog fragments for PRs touching release-relevant files.
 * Requires BASE_REF and optionally PR_BODY from the workflow.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findTriggerFiles } from './lib/changelog_checker.mjs';
import { validateFragment } from './lib/changelog_fragments.mjs';

const baseRef = process.env.BASE_REF || 'main';
const changedFiles = execFileSync('git', ['diff', '--name-only', 'origin/' + baseRef + '...HEAD'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const triggers = findTriggerFiles(changedFiles);
const fragments = changedFiles.filter(p => p.startsWith('changes/') && p.endsWith('.md'));
const exempt = /^No-Changelog: true\s*$/m.test(process.env.PR_BODY || '');

if (changedFiles.includes('CHANGELOG.md')) {
  console.error('CHANGELOG.md is release-owned; feature PRs must use changes/<issue-number>.md.');
  process.exit(1);
}
try {
  for (const file of fragments) validateFragment(file, readFileSync(file, 'utf8'));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (triggers.length && !exempt && !fragments.length) {
  console.error('Missing changelog fragment: add changes/<issue-number>.md or PR body line No-Changelog: true');
  process.exit(1);
}
console.log('Changelog fragment gate passed.');
