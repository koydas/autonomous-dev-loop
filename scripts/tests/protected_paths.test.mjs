import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROTECTED_FLOOR,
  PROTECTED_PATHS_CONFIG_PATH,
  DEFAULT_CONFIG_FILE,
  parseProtectedPathsConfig,
  resolveProtectedPaths,
  loadProtectedPathsConfig,
  loadProtectedPaths,
  entryMatches,
} from '../lib/protected_paths.mjs';
import { PROTECTED_WRITE_PATHS, protectedPathEntry, validateAiOutput, GuardrailError } from '../lib/output_writer.mjs';
import { guardrailRules } from '../lib/static_verifier.mjs';
import { findDeterministicBlock } from '../lib/generation_blocked.mjs';

// ADR-0044: what this repository protects beyond the floor. Dropping one of these from
// config/protected-paths.yaml (or deleting the file) must fail here, not pass silently.
const THIS_REPO_ENTRIES = ['scripts/', 'config/', 'prompts/', 'checkpoints/', 'metrics/', 'observability/', 'docs/', 'README.md', '.claude/', 'AGENTS.md', 'CLAUDE.md', 'evals/fixtures/', 'evals/graders/'];

const entryFor = (list, target) => list.find((entry) => entryMatches(entry, target.toLowerCase())) ?? null;

function withConfig(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-paths-'));
  try {
    const file = path.join(dir, 'protected-paths.yaml');
    if (content !== null) fs.writeFileSync(file, content);
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const parseError = (content, pattern) => assert.throws(() => parseProtectedPathsConfig(content), pattern);

test("this repository's config declares every self-protection and governance entry", () => {
  assert.ok(fs.existsSync(DEFAULT_CONFIG_FILE), `${PROTECTED_PATHS_CONFIG_PATH} must exist`);
  const declared = loadProtectedPathsConfig();
  for (const entry of THIS_REPO_ENTRIES) assert.ok(declared.includes(entry), `${PROTECTED_PATHS_CONFIG_PATH} must list ${entry}`);
  for (const entry of THIS_REPO_ENTRIES) assert.ok(PROTECTED_WRITE_PATHS.includes(entry), `effective list must contain ${entry}`);
});

test('the effective list of this repository is the floor plus its config, frozen', () => {
  for (const entry of PROTECTED_FLOOR) assert.ok(PROTECTED_WRITE_PATHS.includes(entry), `floor entry ${entry} missing`);
  assert.ok(Object.isFrozen(PROTECTED_WRITE_PATHS));
  assert.ok(Object.isFrozen(PROTECTED_FLOOR));
});

test('the floor holds the universal entries, the non-Node equivalents and the config file itself', () => {
  for (const entry of ['.git/', '.github/', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.npmrc', '.yarnrc', '.yarnrc.yml',
    'Directory.Packages.props', 'NuGet.config', 'global.json', 'requirements*.txt', 'pyproject.toml', 'poetry.lock', PROTECTED_PATHS_CONFIG_PATH]) {
    assert.ok(PROTECTED_FLOOR.includes(entry), `floor missing ${entry}`);
  }
  for (const entry of THIS_REPO_ENTRIES) assert.ok(!PROTECTED_FLOOR.includes(entry), `${entry} is repo policy, not floor`);
});

test('a repository without config protects the floor only', () => {
  const list = resolveProtectedPaths([]);
  assert.deepEqual([...list].sort(), [...PROTECTED_FLOOR].sort());
  for (const writable of ['scripts/a.mjs', 'config/app.yaml', 'prompts/x.md', 'docs/guide.md', 'README.md', 'src/a.js']) {
    assert.equal(entryFor(list, writable), null, `${writable} must be writable without config`);
  }
  assert.equal(entryFor(list, '.github/workflows/ci.yml'), '.github/');
  assert.equal(entryFor(list, 'src/App.csproj'), '*.csproj');
});

test('a missing config file means the floor only', () => {
  withConfig(null, (file) => {
    assert.deepEqual(loadProtectedPathsConfig(file), []);
    assert.deepEqual([...loadProtectedPaths(file)].sort(), [...PROTECTED_FLOOR].sort());
  });
});

test('an unreadable config propagates the error instead of falling back to the floor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-paths-'));
  try {
    assert.throws(() => loadProtectedPathsConfig(dir), (err) => err.code === 'EISDIR');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a config cannot remove a floor entry: an empty or re-listed config still protects .github/', () => {
  for (const content of ['protected_paths: []\n', 'protected_paths:\n  - docs/\n', 'protected_paths:\n  - .GITHUB/\n  - Package.json\n']) {
    withConfig(content, (file) => {
      const list = loadProtectedPaths(file);
      for (const entry of PROTECTED_FLOOR) assert.ok(list.includes(entry) || list.some((e) => e.toLowerCase() === entry.toLowerCase()), `lost ${entry}`);
      assert.equal(entryFor(list, '.github/workflows/ci.yml')?.toLowerCase(), '.github/');
      assert.equal(entryFor(list, 'config/protected-paths.yaml') !== null, true);
    });
  }
});

test('there is no syntax to subtract: removal-looking keys are rejected', () => {
  parseError('unprotected_paths:\n  - .github/\n', /unknown key "unprotected_paths"/);
  parseError('protected_paths:\n  - docs/\nallow:\n  - .github/\n', /unknown key "allow"/);
});

test('config entries are added after the floor, de-duplicated ignoring case, directories first', () => {
  const list = resolveProtectedPaths(['scripts/', 'DOCS/', 'Docs/', 'README.md', 'package.json']);
  assert.equal(list.filter((e) => e.toLowerCase() === 'docs/').length, 1);
  assert.equal(list.filter((e) => e.toLowerCase() === 'package.json').length, 1);
  const firstFile = list.findIndex((e) => !e.endsWith('/'));
  assert.ok(list.slice(firstFile).every((e) => !e.endsWith('/')), 'directory entries come before file entries');
  assert.ok(Object.isFrozen(list));
});

test('parseProtectedPathsConfig reads a list, comments, blank lines, quotes and CRLF', () => {
  const content = '# header\r\n\r\nprotected_paths:\r\n  # why\r\n  - scripts/\r\n  - "*.gen.cs"\r\n  - \'src/generated/\'\r\n  - data/lock.json\r\n';
  assert.deepEqual(parseProtectedPathsConfig(content), ['scripts/', '*.gen.cs', 'src/generated/', 'data/lock.json']);
  assert.deepEqual(parseProtectedPathsConfig('protected_paths: []'), []);
  assert.deepEqual(parseProtectedPathsConfig('protected_paths:\n'), []);
});

test('parseProtectedPathsConfig rejects invalid input with the field path', () => {
  parseError('', /protected-paths\.yaml: missing required key `protected_paths`/);
  parseError(undefined, /missing required key/);
  parseError('# only a comment\n', /missing required key/);
  parseError('protected_paths: scripts/\n', /`protected_paths` must be a list/);
  parseError('protected_paths:\nprotected_paths:\n', /duplicate key/);
  parseError('  - docs/\nprotected_paths:\n', /before the `protected_paths` key/);
  parseError('protected_paths: []\n  - docs/\n', /declared inline and also as a list/);
  parseError('protected_paths:\n  - docs/\n  -   \n', /unparseable line/);
  parseError('protected_paths:\n  - ""\n', /protected_paths\[0\] must not be empty/);
  parseError('protected_paths:\n  - docs/\n  - "abc\n', /unbalanced quotes/);
  parseError('protected_paths:\n  - docs/ # note\n', /protected_paths\[0\] "docs\/ # note" has an inline comment/);
  parseError('not yaml at all\n', /unparseable line/);
  parseError('protected_paths:\n  - docs/\n  - /etc/\n', /protected_paths\[1\] "\/etc\/" must be a relative path/);
  parseError('protected_paths:\n  - ./docs/\n', /protected_paths\[0\].*relative path/);
  parseError('protected_paths:\n  - a\\b\n', /protected_paths\[0\].*relative path/);
  parseError('protected_paths:\n  - ../x\n', /protected_paths\[0\].*relative path/);
  parseError('protected_paths:\n  - a//b/\n', /protected_paths\[0\].*relative path/);
  parseError('protected_paths:\n  - "src/**/*.cs"\n', /protected_paths\[0\] "src\/\*\*\/\*\.cs" uses "\*" outside a bare file name/);
  parseError('protected_paths:\n  - "a*b*c"\n', /protected_paths\[0\].*more than one "\*"/);
  parseError('protected_paths:\n  - "*"\n', /protected_paths\[0\].*no literal character/);
  parseError('protected_paths:\n  - "file?.txt"\n', /protected_paths\[0\].*unsupported glob character/);
  parseError('protected_paths:\n  - "[ab].txt"\n', /protected_paths\[0\].*unsupported glob character/);
});

test('an invalid config file makes loadProtectedPaths throw (fail-fast at startup)', () => {
  withConfig('protected_paths:\n  - docs/\n  - ../x\n', (file) => {
    assert.throws(() => loadProtectedPaths(file), /protected-paths\.yaml: protected_paths\[1\]/);
  });
});

test('entryMatches: directory prefix, exact root file, bare name at any depth, single wildcard', () => {
  assert.equal(entryMatches('docs/', 'docs/a.md'), true);
  assert.equal(entryMatches('docs/', 'docs'), true);
  assert.equal(entryMatches('docs/', 'src/docs/a.md'), false);
  assert.equal(entryMatches('docs/', 'docsx/a.md'), false);
  assert.equal(entryMatches('Config/Protected-Paths.yaml', 'config/protected-paths.yaml'), true);
  assert.equal(entryMatches('config/protected-paths.yaml', 'a/config/protected-paths.yaml'), false);
  assert.equal(entryMatches('package.json', 'packages/app/package.json'), true);
  assert.equal(entryMatches('package.json', 'package.json.bak'), false);
  assert.equal(entryMatches('*.csproj', 'src/App/App.csproj'), true);
  assert.equal(entryMatches('*.csproj', 'app.csproj.user'), false);
  assert.equal(entryMatches('*.csproj', '.csproj'), true);
  assert.equal(entryMatches('requirements*.txt', 'svc/requirements-dev.txt'), true);
  assert.equal(entryMatches('requirements*.txt', 'requirements.txt'), true);
  assert.equal(entryMatches('requirements*.txt', 'requirements.md'), false);
  assert.equal(entryMatches('requirements*.txt', 'requirementstxt'), false);
  assert.equal(entryMatches('ab*ba', 'aba'), false, 'head and tail must not overlap');
});

test('every floor entry is rejected by validateAiOutput, at any depth and case where the form allows it', () => {
  const sample = {
    '*.csproj': 'src/App.csproj', '*.fsproj': 'a/b/X.FSPROJ', '*.vbproj': 'v.vbproj', 'requirements*.txt': 'svc/Requirements-Dev.txt',
    '.git/': 'nested/.git/config', '.github/': '.github/workflows/ci.yml', [PROTECTED_PATHS_CONFIG_PATH]: './config/Protected-Paths.yaml',
  };
  for (const entry of PROTECTED_FLOOR) {
    const target = sample[entry] ?? `pkg/${entry}`;
    assert.throws(
      () => validateAiOutput({ summary: 's', changes: [{ target_path: target, file_content: 'x' }] }),
      (err) => err instanceof GuardrailError && /protected path/.test(err.message),
      `${target} must be rejected (${entry})`,
    );
  }
});

test('protectedPathEntry keeps its answers for non-protected and nearby paths', () => {
  assert.equal(protectedPathEntry('src/requirements.md'), null);
  assert.equal(protectedPathEntry('src/App.cs'), null);
  assert.equal(protectedPathEntry('src/config/protected-paths.yaml'), null);
  assert.equal(protectedPathEntry('config/protected-paths.yaml'), 'config/');
});

test('generation_blocked and static_verifier answer from the same list as the writer', () => {
  const blocked = findDeterministicBlock({ issueTitle: 'Bump src/App/App.csproj', issueBody: '' });
  assert.deepEqual(blocked?.paths.map((p) => p.path), ['src/App/App.csproj']);
  assert.match(blocked.paths[0].why, /protected path \(\*\.csproj, ADR-0021\)/);
  assert.equal(findDeterministicBlock({ issueTitle: 'Edit src/App/App.cs', issueBody: '' }), null);

  let rejection;
  try {
    validateAiOutput({ summary: 's', changes: [{ target_path: 'src/App/App.csproj', file_content: 'x' }] });
  } catch (err) {
    rejection = err;
  }
  assert.deepEqual(guardrailRules(rejection), ['protected_path']);
});

// ADR-0021 amendment (audit F16): hooks and agent rules run or steer on a developer's machine.
test('this repository rejects writes to agent rules and hooks, at any depth for the rule files, case-insensitively', () => {
  for (const target of ['.claude/settings.json', '.claude/hooks/test-gate.mjs', '.claude/skills/x/SKILL.md', 'AGENTS.md', 'services/api/CLAUDE.md', 'claude.MD']) {
    assert.ok(protectedPathEntry(target), `${target} must be protected`);
  }
  // Directory entries are root-level only: a nested .claude/ is not covered, and similar names are not matched.
  for (const target of ['src/claude.mjs', 'claude-notes.md', 'src/.claude/x.json']) {
    assert.equal(protectedPathEntry(target), null, `${target} must stay writable`);
  }
});

// ADR-0052 amendment: the autofix suite scores a patch with tests the model never sees, pinned with their fixture.
test('this repository rejects writes to eval fixtures and graders, not to the rest of evals/', () => {
  for (const target of ['evals/fixtures/autofix/fix-page-offset/src/page.mjs', 'evals/graders/autofix/fix-page-offset/test/hidden.check.mjs', 'evals/graders/autofix/fix-page-offset/reference.json', 'EVALS/Graders/x.json']) {
    assert.ok(protectedPathEntry(target), `${target} must be protected`);
  }
  // Only the two trees: datasets are extended by a PR that fixes an incident, and similar names are not matched.
  for (const target of ['evals/datasets/autofix.jsonl', 'evals/fixtures-notes.md', 'evals/graders.md', 'src/evals/fixtures/x.mjs']) {
    assert.equal(protectedPathEntry(target), null, `${target} must stay writable`);
  }
});
