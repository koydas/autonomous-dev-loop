import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  extractFilePaths,
  readRelevantFiles,
  formatFileContents,
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
