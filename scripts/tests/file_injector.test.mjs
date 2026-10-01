import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  extractFilePaths,
  readRelevantFiles,
  formatFileContents,
  readPackageJsonDependencies,
  formatDependencyAllowlist,
  buildFileContentsBlock,
} from '../lib/file_injector.mjs';

// ---------------------------------------------------------------------------
// extractFilePaths
// ---------------------------------------------------------------------------

describe('extractFilePaths', () => {
  test('extracts a relative path with directory components from the body', () => {
    const paths = extractFilePaths('Fix bug', 'Update scripts/lib/config.mjs to fix it');
    assert.ok(paths.includes('scripts/lib/config.mjs'));
  });

  test('extracts a relative path mentioned in the issue title', () => {
    const paths = extractFilePaths('Update prompts/generation-user.md', '');
    assert.ok(paths.some((p) => p === 'prompts/generation-user.md'));
  });

  test('extracts a plain filename with a code extension', () => {
    const paths = extractFilePaths('Fix config.mjs', '');
    assert.ok(paths.includes('config.mjs'));
  });

  test('extracts multiple paths from a longer body', () => {
    const body = 'Change scripts/lib/config.mjs and also update README.md';
    const paths = extractFilePaths('', body);
    assert.ok(paths.some((p) => p.includes('config.mjs')));
    assert.ok(paths.some((p) => p === 'README.md'));
  });

  test('deduplicates identical paths appearing in title and body', () => {
    const paths = extractFilePaths('Fix config.mjs', 'Update config.mjs please');
    assert.equal(paths.filter((p) => p === 'config.mjs').length, 1);
  });

  test('does not extract absolute paths', () => {
    const paths = extractFilePaths('Update /etc/passwd', '');
    assert.equal(paths.filter((p) => p.startsWith('/')).length, 0);
  });

  test('does not extract paths containing directory traversal', () => {
    const paths = extractFilePaths('Update ../outside', 'read ../secret.txt');
    assert.equal(paths.filter((p) => p.includes('..')).length, 0);
  });

  test('returns an array (possibly empty) when no file paths are found', () => {
    const paths = extractFilePaths('Fix login bug', 'The login button does not work');
    assert.ok(Array.isArray(paths));
  });

  test('returns an empty array for empty inputs', () => {
    const paths = extractFilePaths('', '');
    assert.ok(Array.isArray(paths));
    assert.equal(paths.length, 0);
  });

  test('does not throw on a body containing a GitHub blob URL', () => {
    assert.doesNotThrow(() =>
      extractFilePaths('', 'See https://github.com/owner/repo/blob/main/scripts/lib/config.mjs'),
    );
  });
});

// ---------------------------------------------------------------------------
// readRelevantFiles
// ---------------------------------------------------------------------------

describe('readRelevantFiles', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-test-'));
    await fs.writeFile(path.join(tmpDir, 'hello.js'), 'console.log("hello");', 'utf8');
    await fs.mkdir(path.join(tmpDir, 'sub'));
    await fs.writeFile(path.join(tmpDir, 'sub', 'world.mjs'), 'export const x = 1;', 'utf8');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('reads an existing file at the repo root', async () => {
    const files = await readRelevantFiles(['hello.js'], tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'hello.js');
    assert.ok(files[0].content.includes('console.log'));
  });

  test('reads a file in a subdirectory', async () => {
    const files = await readRelevantFiles(['sub/world.mjs'], tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'sub/world.mjs');
    assert.ok(files[0].content.includes('export const x'));
  });

  test('skips non-existent files silently', async () => {
    const files = await readRelevantFiles(['nonexistent.js'], tmpDir);
    assert.equal(files.length, 0);
  });

  test('skips ENOTDIR path-like tokens silently', async () => {
    const files = await readRelevantFiles(['hello.js/section'], tmpDir);
    assert.equal(files.length, 0);
  });

  test('prevents traversal outside the repo root', async () => {
    const files = await readRelevantFiles(['../outside.js'], tmpDir);
    assert.equal(files.length, 0);
  });

  test('skips node_modules paths', async () => {
    const files = await readRelevantFiles(['node_modules/foo/index.js'], tmpDir);
    assert.equal(files.length, 0);
  });

  test('skips lock files', async () => {
    const files = await readRelevantFiles(['package-lock.json'], tmpDir);
    assert.equal(files.length, 0);
  });

  test('limits results to MAX_FILES (10)', async () => {
    const names = [];
    for (let i = 0; i < 15; i++) {
      const name = `limit${i}.js`;
      await fs.writeFile(path.join(tmpDir, name), `const x = ${i};`, 'utf8');
      names.push(name);
    }
    const files = await readRelevantFiles(names, tmpDir);
    assert.ok(files.length <= 10);
  });

  test('skips directory entries', async () => {
    const files = await readRelevantFiles(['sub'], tmpDir);
    assert.equal(files.length, 0);
  });

  test('returns empty array for an empty candidates list', async () => {
    const files = await readRelevantFiles([], tmpDir);
    assert.equal(files.length, 0);
  });
});

// ---------------------------------------------------------------------------
// formatFileContents
// ---------------------------------------------------------------------------

describe('formatFileContents', () => {
  test('returns the fallback message for an empty array', () => {
    assert.equal(
      formatFileContents([]),
      'No existing files identified as relevant to this issue.',
    );
  });

  test('formats a single file with a ### header and fenced code block', () => {
    const result = formatFileContents([{ path: 'src/foo.js', content: 'const x = 1;' }]);
    assert.ok(result.includes('### Current file: src/foo.js'));
    assert.ok(result.includes('```'));
    assert.ok(result.includes('const x = 1;'));
  });

  test('formats multiple files and includes all headers', () => {
    const result = formatFileContents([
      { path: 'a.js', content: 'a' },
      { path: 'b.js', content: 'b' },
    ]);
    assert.ok(result.includes('### Current file: a.js'));
    assert.ok(result.includes('### Current file: b.js'));
  });

  test('separates multiple files with a blank line', () => {
    const result = formatFileContents([
      { path: 'a.js', content: 'a' },
      { path: 'b.js', content: 'b' },
    ]);
    assert.ok(result.includes('\n\n'));
  });
});

// ---------------------------------------------------------------------------
// buildFileContentsBlock — integration
// ---------------------------------------------------------------------------

describe('buildFileContentsBlock', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-integration-'));
    await fs.writeFile(path.join(tmpDir, 'widget.js'), 'export function widget() {}', 'utf8');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns a formatted block when an identified file exists in the repo', async () => {
    const block = await buildFileContentsBlock('Fix widget.js', '', tmpDir);
    assert.ok(block.includes('### Current file: widget.js'));
    assert.ok(block.includes('export function widget'));
  });

  test('returns the fallback message when no identified files exist', async () => {
    const block = await buildFileContentsBlock(
      'Fix login bug',
      'The login button does not work on mobile',
      tmpDir,
    );
    assert.equal(block, 'No existing files identified as relevant to this issue.');
  });
});

// ---------------------------------------------------------------------------
// readPackageJsonDependencies
// ---------------------------------------------------------------------------

describe('readPackageJsonDependencies', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns null when no package.json exists', async () => {
    const deps = await readPackageJsonDependencies(tmpDir);
    assert.equal(deps, null);
  });

  test('returns null for a malformed package.json instead of throwing', async () => {
    const badDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-bad-'));
    await fs.writeFile(path.join(badDir, 'package.json'), '{ not valid json', 'utf8');
    await assert.doesNotReject(async () => {
      const deps = await readPackageJsonDependencies(badDir);
      assert.equal(deps, null);
    });
    await fs.rm(badDir, { recursive: true, force: true });
  });

  test('returns null instead of throwing when package.json is valid JSON but not an object (null)', async () => {
    const nullDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-null-'));
    await fs.writeFile(path.join(nullDir, 'package.json'), 'null', 'utf8');
    await assert.doesNotReject(async () => {
      const deps = await readPackageJsonDependencies(nullDir);
      assert.equal(deps, null);
    });
    await fs.rm(nullDir, { recursive: true, force: true });
  });

  test('returns null instead of throwing when package.json is a top-level array', async () => {
    const arrDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-arr-'));
    await fs.writeFile(path.join(arrDir, 'package.json'), '["react"]', 'utf8');
    const deps = await readPackageJsonDependencies(arrDir);
    assert.equal(deps, null);
    await fs.rm(arrDir, { recursive: true, force: true });
  });

  test('ignores a non-object dependency field instead of spreading its indices as package names', async () => {
    const shapeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-shape-'));
    await fs.writeFile(
      path.join(shapeDir, 'package.json'),
      JSON.stringify({ dependencies: ['react'], devDependencies: { vitest: '1.0.0' } }),
      'utf8',
    );
    const deps = await readPackageJsonDependencies(shapeDir);
    assert.deepEqual(deps, { vitest: '1.0.0' });
    assert.ok(!('0' in deps));
    await fs.rm(shapeDir, { recursive: true, force: true });
  });

  test('merges dependencies and devDependencies', async () => {
    const depDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-deps-'));
    await fs.writeFile(
      path.join(depDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '18.0.0' }, devDependencies: { vitest: '1.0.0' } }),
      'utf8',
    );
    const deps = await readPackageJsonDependencies(depDir);
    assert.deepEqual(deps, { react: '18.0.0', vitest: '1.0.0' });
    await fs.rm(depDir, { recursive: true, force: true });
  });

  test('also merges peerDependencies and optionalDependencies', async () => {
    const depDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-peer-'));
    await fs.writeFile(
      path.join(depDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '18.0.0' },
        devDependencies: { vitest: '1.0.0' },
        peerDependencies: { 'react-dom': '18.0.0' },
        optionalDependencies: { fsevents: '2.3.0' },
      }),
      'utf8',
    );
    const deps = await readPackageJsonDependencies(depDir);
    assert.deepEqual(deps, {
      react: '18.0.0',
      vitest: '1.0.0',
      'react-dom': '18.0.0',
      fsevents: '2.3.0',
    });
    await fs.rm(depDir, { recursive: true, force: true });
  });

  test('returns an empty object when package.json has no dependency fields', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-empty-'));
    await fs.writeFile(path.join(emptyDir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    const deps = await readPackageJsonDependencies(emptyDir);
    assert.deepEqual(deps, {});
    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  test('rethrows unexpected non-ENOENT read errors instead of swallowing them', async () => {
    const dirDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-direrr-'));
    // Make package.json a directory instead of a file: reading it throws EISDIR, not ENOENT.
    await fs.mkdir(path.join(dirDir, 'package.json'));
    await assert.rejects(
      () => readPackageJsonDependencies(dirDir),
      (err) => err.code === 'EISDIR',
    );
    await fs.rm(dirDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// formatDependencyAllowlist
// ---------------------------------------------------------------------------

describe('formatDependencyAllowlist', () => {
  test('returns an empty string for null', () => {
    assert.equal(formatDependencyAllowlist(null), '');
  });

  test('emits an explicit zero-dependencies block for an empty object (not silence)', () => {
    const block = formatDependencyAllowlist({});
    assert.ok(block.includes('### Allowed npm dependencies'));
    assert.ok(block.includes('zero dependencies'));
    assert.ok(block.includes('Do not introduce ANY new external npm package'));
  });

  test('lists dependency names sorted alphabetically', () => {
    const block = formatDependencyAllowlist({ zod: '1.0.0', axios: '2.0.0' });
    assert.ok(block.indexOf('- axios') < block.indexOf('- zod'));
  });

  test('mentions that built-ins are always allowed', () => {
    const block = formatDependencyAllowlist({ react: '18.0.0' });
    assert.ok(block.toLowerCase().includes('built-in'));
  });

  test('includes the section header', () => {
    const block = formatDependencyAllowlist({ react: '18.0.0' });
    assert.ok(block.includes('### Allowed npm dependencies'));
  });

  test('does not claim to override imports already used in the target file', () => {
    const block = formatDependencyAllowlist({ react: '18.0.0' });
    assert.ok(block.includes('already imported elsewhere in the target file'));
  });

  test('truncates to MAX_DEPENDENCIES (200) entries with a note, for very large manifests', () => {
    const manyDeps = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`pkg-${String(i).padStart(3, '0')}`, '1.0.0']),
    );
    const block = formatDependencyAllowlist(manyDeps);
    const listedCount = (block.match(/^- pkg-/gm) || []).length;
    assert.equal(listedCount, 200);
    assert.ok(block.includes('truncated'));
    assert.ok(block.includes('250'));
  });

  test('a truncated list explicitly overrides the "exhaustive" framing for this request', () => {
    const manyDeps = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`pkg-${String(i).padStart(3, '0')}`, '1.0.0']),
    );
    const block = formatDependencyAllowlist(manyDeps);
    assert.ok(block.includes('NOT'));
    assert.ok(block.includes('exhaustive'));
  });

  test('a non-truncated list does not carry the "not exhaustive" override note', () => {
    const block = formatDependencyAllowlist({ react: '18.0.0' });
    assert.ok(!block.includes('NOT'));
  });

  test('does not truncate when at or under MAX_DEPENDENCIES (200)', () => {
    const exactlyMax = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`pkg-${String(i).padStart(3, '0')}`, '1.0.0']),
    );
    const block = formatDependencyAllowlist(exactlyMax);
    assert.ok(!block.includes('truncated'));
  });

  test('truncates by character footprint even when well under MAX_DEPENDENCIES, for long scoped package names', () => {
    // 60 entries at ~100 chars each = ~6000 chars, over MAX_ALLOWLIST_CHARS (4000),
    // while staying far below the 200-entry count cap — the count cap alone would not
    // have bounded this list's size.
    const longNames = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `@some-very-long-organization-name-${String(i).padStart(3, '0')}/some-very-long-package-name-here`,
        '1.0.0',
      ]),
    );
    const block = formatDependencyAllowlist(longNames);
    const listedCount = (block.match(/^- @some-very-long/gm) || []).length;
    assert.ok(listedCount < 60, `expected truncation before all 60 entries, got ${listedCount}`);
    assert.ok(block.includes('truncated'));
    assert.ok(block.includes('60'));
  });
});

// ---------------------------------------------------------------------------
// buildFileContentsBlock — dependency allowlist integration
// ---------------------------------------------------------------------------

describe('buildFileContentsBlock with package.json present', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-integration-'));
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '18.0.0' } }),
      'utf8',
    );
    await fs.writeFile(path.join(tmpDir, 'widget.js'), 'export function widget() {}', 'utf8');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('prepends the allowlist block before the file contents', async () => {
    const block = await buildFileContentsBlock('Fix widget.js', '', tmpDir);
    assert.ok(block.includes('### Allowed npm dependencies'));
    assert.ok(block.includes('- react'));
    assert.ok(block.includes('### Current file: widget.js'));
    assert.ok(block.indexOf('Allowed npm dependencies') < block.indexOf('Current file: widget.js'));
  });

  test('still returns the fallback file message alongside the allowlist when no files are identified', async () => {
    const block = await buildFileContentsBlock('Fix login bug', 'no file mentioned here', tmpDir);
    assert.ok(block.includes('### Allowed npm dependencies'));
    assert.ok(block.includes('No existing files identified as relevant to this issue.'));
  });
});

describe('buildFileContentsBlock with package.json declaring zero dependencies', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-injector-pkg-empty-int-'));
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('still emits an explicit zero-dependencies allowlist block rather than staying silent', async () => {
    const block = await buildFileContentsBlock('Fix login bug', '', tmpDir);
    assert.ok(block.includes('### Allowed npm dependencies'));
    assert.ok(block.includes('zero dependencies'));
  });
});
