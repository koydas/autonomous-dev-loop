#!/usr/bin/env node
/**
 * Fails if a PR modifies entrypoint scripts or ADR files without updating CHANGELOG.md.
 * Called by .github/workflows/changelog-check.yml on pull_request events.
 */
import { execSync } from 'node:child_process';

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

// Top-level scripts only (not lib/ or tests/)
const ENTRYPOINT_RE = /^scripts\/[^/]+\.mjs$/;
// ADR records (docs/adr/NNNN-*.md)
const ADR_RE = /^docs\/adr\/\d{4}-[^/]+\.md$/;
const CHANGELOG = 'CHANGELOG.md';

const triggerFiles = changedFiles.filter(f => ENTRYPOINT_RE.test(f) || ADR_RE.test(f));

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

console.log(`Changelog check passed (${triggerFiles.length} trigger file(s), CHANGELOG.md updated).`);
