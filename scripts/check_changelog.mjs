#!/usr/bin/env node
/**
 * Fails if a PR modifies entrypoint scripts or ADR files without adding an entry
 * under ## [Unreleased] in CHANGELOG.md.
 * Called by .github/workflows/changelog-check.yml on pull_request events.
 */
import { execSync } from 'node:child_process';
import { findTriggerFiles, hasUnreleasedEntry } from './lib/changelog_checker.mjs';

const CHANGELOG = 'CHANGELOG.md';
const baseRef = process.env.BASE_REF ?? 'main';

let changedFiles;
try {
  changedFiles = execSync(`git diff --name-only origin/${baseRef}...HEAD`, { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
} catch {
  console.error(`Failed to get changed files against origin/${baseRef}. Ensure fetch-depth: 0 in checkout.`);
  process.exit(1);
}

const triggerFiles = findTriggerFiles(changedFiles);

if (triggerFiles.length === 0) {
  console.log('No entrypoint or ADR files changed — changelog check skipped.');
  process.exit(0);
}

if (!changedFiles.includes(CHANGELOG)) {
  console.error(
    `\nChangelog check failed.\n` +
    `These files require a CHANGELOG.md entry:\n` +
    triggerFiles.map(f => `  - ${f}`).join('\n') +
    `\n\nAdd an entry under [Unreleased] in CHANGELOG.md.\n` +
    `See CONTRIBUTING.md § Changelog Policy for format and examples.\n`
  );
  process.exit(1);
}

let changelogDiff;
try {
  changelogDiff = execSync(`git diff origin/${baseRef}...HEAD -- ${CHANGELOG}`, { encoding: 'utf8' });
} catch {
  changelogDiff = '';
}

if (!hasUnreleasedEntry(changelogDiff)) {
  console.error(
    `\nChangelog check failed.\n` +
    `CHANGELOG.md was modified but no entry was added under ## [Unreleased].\n` +
    `Add a new entry at the top of CHANGELOG.md under the [Unreleased] section.\n` +
    `See CONTRIBUTING.md § Changelog Policy for format and examples.\n`
  );
  process.exit(1);
}

console.log(`Changelog check passed (${triggerFiles.length} trigger file(s), [Unreleased] entry verified).`);
