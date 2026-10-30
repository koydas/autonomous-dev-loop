#!/usr/bin/env node
/**
 * Assemble release notes from independent fragments.
 * Usage: node scripts/assemble_changelog.mjs [--release X.Y.Z YYYY-MM-DD]
 * Release mode consumes fragments; commit the deletion with the changelog.
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { assembleChangelog, rolloverChangelog, validateFragments } from './lib/changelog_fragments.mjs';

const dir = 'changes';
const paths = existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith('.md')).map(x => dir + '/' + x) : [];
const fragments = Object.fromEntries(paths.map(p => [p, readFileSync(p, 'utf8')]));
validateFragments(fragments);
const source = readFileSync('CHANGELOG.md', 'utf8');
const assembled = assembleChangelog(source, fragments);
const release = process.argv[2] === '--release';
if (process.argv.length !== (release ? 5 : 2))
  throw new Error('Usage: node scripts/assemble_changelog.mjs [--release X.Y.Z YYYY-MM-DD]');
const output = release ? rolloverChangelog(assembled, process.argv[3], process.argv[4]) : assembled;
if (source !== output) writeFileSync('CHANGELOG.md', output);
if (release) paths.forEach(p => unlinkSync(p));
console.log(release ? 'Release changelog generated; commit deleted fragments.' : 'Unreleased changelog assembled.');
