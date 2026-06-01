import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesTrigger, findTriggerFiles, hasUnreleasedEntry } from '../lib/changelog_checker.mjs';

// --- matchesTrigger ---

test('matchesTrigger: top-level entrypoint scripts are triggers', () => {
  assert.equal(matchesTrigger('scripts/auto_fix_pr.mjs'), true);
  assert.equal(matchesTrigger('scripts/check_changelog.mjs'), true);
  assert.equal(matchesTrigger('scripts/validate_issue.mjs'), true);
});

test('matchesTrigger: lib/ and tests/ scripts are not triggers', () => {
  assert.equal(matchesTrigger('scripts/lib/llm_client.mjs'), false);
  assert.equal(matchesTrigger('scripts/lib/changelog_checker.mjs'), false);
  assert.equal(matchesTrigger('scripts/tests/foo.test.mjs'), false);
});

test('matchesTrigger: ADR records are triggers', () => {
  assert.equal(matchesTrigger('docs/adr/0009-llm-agent-guardrails.md'), true);
  assert.equal(matchesTrigger('docs/adr/0013-some-adr.md'), true);
});

test('matchesTrigger: docs/adr/README.md is not a trigger', () => {
  assert.equal(matchesTrigger('docs/adr/README.md'), false);
});

test('matchesTrigger: other changed files are not triggers', () => {
  assert.equal(matchesTrigger('CHANGELOG.md'), false);
  assert.equal(matchesTrigger('CONTRIBUTING.md'), false);
  assert.equal(matchesTrigger('.github/workflows/test.yml'), false);
  assert.equal(matchesTrigger('docs/runbook.md'), false);
});

// --- findTriggerFiles ---

test('findTriggerFiles: returns only entrypoints and ADRs', () => {
  const files = [
    'scripts/auto_fix_pr.mjs',
    'scripts/lib/llm_client.mjs',
    'docs/adr/0013-some-adr.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
  ];
  assert.deepEqual(findTriggerFiles(files), [
    'scripts/auto_fix_pr.mjs',
    'docs/adr/0013-some-adr.md',
  ]);
});

test('findTriggerFiles: returns empty array when no triggers', () => {
  assert.deepEqual(findTriggerFiles(['CHANGELOG.md', 'scripts/lib/foo.mjs']), []);
});

// --- hasUnreleasedEntry ---

test('hasUnreleasedEntry: added bullet under [Unreleased]', () => {
  const diff = [
    '--- a/CHANGELOG.md',
    '+++ b/CHANGELOG.md',
    '@@ -3,6 +3,9 @@',
    ' ## [Unreleased]',
    '+',
    '+### Added',
    '+- New feature (PR #99)',
    ' ',
    ' ## [2026-06-01]',
  ].join('\n');
  assert.equal(hasUnreleasedEntry(diff), true);
});

test('hasUnreleasedEntry: only dated section edited — no [Unreleased] addition', () => {
  const diff = [
    '--- a/CHANGELOG.md',
    '+++ b/CHANGELOG.md',
    '@@ -8,1 +8,1 @@',
    ' ## [2026-06-01]',
    '-Old text',
    '+Fixed typo',
  ].join('\n');
  assert.equal(hasUnreleasedEntry(diff), false);
});

test('hasUnreleasedEntry: [Unreleased] section present but no added content in it', () => {
  const diff = [
    '--- a/CHANGELOG.md',
    '+++ b/CHANGELOG.md',
    '@@ -3,5 +3,5 @@',
    ' ## [Unreleased]',
    ' ',
    ' ## [2026-06-01]',
    '-Old dated entry',
    '+New dated entry',
  ].join('\n');
  assert.equal(hasUnreleasedEntry(diff), false);
});

test('hasUnreleasedEntry: new file with [Unreleased] section and content', () => {
  const diff = [
    '--- /dev/null',
    '+++ b/CHANGELOG.md',
    '@@ -0,0 +1,10 @@',
    '+# Changelog',
    '+',
    '+## [Unreleased]',
    '+',
    '+### Added',
    '+- Something new',
    '+',
    '+## [2026-06-01]',
  ].join('\n');
  assert.equal(hasUnreleasedEntry(diff), true);
});

test('hasUnreleasedEntry: new file with empty [Unreleased] section', () => {
  const diff = [
    '--- /dev/null',
    '+++ b/CHANGELOG.md',
    '@@ -0,0 +1,5 @@',
    '+# Changelog',
    '+',
    '+## [Unreleased]',
    '+',
    '+## [2026-06-01]',
  ].join('\n');
  assert.equal(hasUnreleasedEntry(diff), false);
});

test('hasUnreleasedEntry: empty diff string', () => {
  assert.equal(hasUnreleasedEntry(''), false);
});
