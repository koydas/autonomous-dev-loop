import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeGuardrails, pathIsFileInTree, runGuardrailChecks } from '../lib/guardrail_runner.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const fileDiff = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${lines.join('\n')}\n`;
const T = (title) => `test('${title}', () => {});\n`;

// A repository with a base commit and a head working tree.
function makeRepo({ base, head, links = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-runner-'));
  const write = (files) => {
    for (const [p, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), content);
    }
  };
  write(base);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  write(head);
  for (const [p, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, p));
  return { dir, sha, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('computeGuardrails reads the base with git and the head from the tree, and reports what the rules find', () => {
  const repo = makeRepo({
    base: { 'tests/a.test.mjs': T('kept case title') + T('removed case title'), 'src/p.mjs': 'export function f(a) {\n  return a;\n}\n' },
    head: { 'tests/a.test.mjs': T('kept case title'), 'src/p.mjs': 'export function f(a, b) {\n  return a;\n}\n' },
  });
  try {
    const diff = fileDiff('tests/a.test.mjs', ['-x']) + fileDiff('src/p.mjs', ['-x']);
    const { findings, omitted } = computeGuardrails({ rawDiff: diff, mentionText: '', repoRoot: repo.dir, mergeBase: repo.sha });
    assert.equal(omitted, 0);
    assert.deepEqual(findings.map((f) => [f.rule, f.path]), [['exported_signature', 'src/p.mjs'], ['test_count_drop', 'tests/a.test.mjs']]);
    // Without a base every read of the base fails: the rules skip the files instead of guessing.
    assert.deepEqual(computeGuardrails({ rawDiff: diff, mentionText: '', repoRoot: repo.dir, mergeBase: null }).findings, []);
  } finally {
    repo.cleanup();
  }
});

test('pathIsFileInTree: files, large files and symlinks exist; directories, special paths and the outside do not', () => {
  const repo = makeRepo({ base: { 'a.mjs': 'x', 'dir/inner.mjs': 'x' }, head: { 'big.mjs': 'x'.repeat(1024 * 1024 + 5) }, links: { 'link.mjs': 'a.mjs' } });
  try {
    const exists = (p) => pathIsFileInTree(repo.dir, p);
    assert.deepEqual(['a.mjs', 'big.mjs', 'link.mjs'].map(exists), [true, true, true]);
    assert.deepEqual(['dir', 'missing.mjs', '../outside.mjs', '/etc/passwd', 'a.mjs/under'].map(exists), [false, false, false, false, false]);
    assert.equal(pathIsFileInTree('/nonexistent-root-for-test', 'a.mjs'), false, 'a missing root is missing, not an error');
  } finally {
    repo.cleanup();
  }
});

test('runGuardrailChecks gives the child the same answer as computeGuardrails', () => {
  const repo = makeRepo({ base: { 'tests/a.test.mjs': T('kept case title') + T('removed case title') }, head: { 'tests/a.test.mjs': T('kept case title') } });
  try {
    const input = { rawDiff: fileDiff('tests/a.test.mjs', ['-x']), mentionText: '', repoRoot: repo.dir, mergeBase: repo.sha };
    assert.deepEqual(runGuardrailChecks(input), computeGuardrails(input));
    assert.equal(runGuardrailChecks({ ...input, mentionText: 'drops the removed case title test' }).findings.length, 0, 'the waiver reaches the child');
  } finally {
    repo.cleanup();
  }
});

test('runGuardrailChecks kills a child that overruns its deadline instead of stalling the review', () => {
  // static_verifier rescans the text for every unclosed `export {`: this file is quadratic for it.
  const hostile = 'export { '.repeat(100000) + '}\n'; // 900 KB: under the 1 MiB read limit
  const repo = makeRepo({ base: { 'src/a.mjs': 'export function f(a) {\n  return a;\n}\n' }, head: { 'src/a.mjs': hostile } });
  try {
    const started = performance.now();
    assert.throws(() => runGuardrailChecks({ rawDiff: fileDiff('src/a.mjs', ['-x']), mentionText: '', repoRoot: repo.dir, mergeBase: repo.sha }, { timeoutMs: 1500 }), (err) => err.code === 'ETIMEDOUT');
    assert.ok(performance.now() - started < 10_000, `took ${Math.round(performance.now() - started)} ms`);
  } finally {
    repo.cleanup();
  }
});

test('runGuardrailChecks throws when the child cannot start in the repository root', () => {
  assert.throws(() => runGuardrailChecks({ rawDiff: '', mentionText: '', repoRoot: '/nonexistent-root-for-test', mergeBase: null }));
});
