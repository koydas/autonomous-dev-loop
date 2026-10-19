import { test, describe, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readPrTreeFile, lstatPrTreePath, PR_TREE_MAX_BYTES } from '../lib/pr_tree_reader.mjs';

// F02 / F22 (2026-10-19 audit), ADR-0023: the PR tree is data, never followed, never read unbounded.
describe('readPrTreeFile', () => {
  let tree;
  let outside;

  before(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tree-reader-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tree-reader-outside-'));
    fs.mkdirSync(path.join(tree, 'src'));
    fs.writeFileSync(path.join(tree, 'src', 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tree, 'empty.txt'), '');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SENTINEL-OUTSIDE\n');
    fs.mkdirSync(path.join(outside, 'dir'));
    fs.writeFileSync(path.join(outside, 'dir', 'inner.txt'), 'SENTINEL-PARENT\n');
    fs.symlinkSync(path.join(tree, 'src', 'a.js'), path.join(tree, 'inside-link.js'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(tree, 'outside-link.txt'));
    fs.symlinkSync(path.join(outside, 'dir'), path.join(tree, 'linked-dir'));
  });

  after(() => {
    for (const d of [tree, outside]) fs.rmSync(d, { recursive: true, force: true });
  });

  afterEach(() => mock.restoreAll());

  test('reads a regular file', () => {
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js'), { kind: 'file', content: 'export const a = 1;\n' });
  });

  test('reads an empty file, also with maxBytes 0', () => {
    assert.deepEqual(readPrTreeFile(tree, 'empty.txt', { maxBytes: 0 }), { kind: 'file', content: '' });
  });

  test('a missing file, or one under a missing directory, is missing', () => {
    assert.deepEqual(readPrTreeFile(tree, 'src/none.js'), { kind: 'missing' });
    assert.deepEqual(readPrTreeFile(tree, 'nodir/none.js'), { kind: 'missing' });
  });

  test('ENOTDIR from lstat is missing', () => {
    mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error('not a dir'), { code: 'ENOTDIR' }); });
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js'), { kind: 'missing' });
  });

  test('a symlink to a file inside the repo is other, never opened', () => {
    const open = mock.method(fs, 'openSync');
    assert.deepEqual(readPrTreeFile(tree, 'inside-link.js'), { kind: 'other', reason: 'symlink' });
    assert.equal(open.mock.callCount(), 0);
  });

  test('a symlink to a file outside the repo is other, its content never read', () => {
    const result = readPrTreeFile(tree, 'outside-link.txt');
    assert.deepEqual(result, { kind: 'other', reason: 'symlink' });
    assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  });

  test('a file under a symlinked parent directory is other', () => {
    assert.deepEqual(readPrTreeFile(tree, 'linked-dir/inner.txt'), { kind: 'other', reason: 'symlink' });
  });

  test('a directory, or a path through a non-directory component, is not a regular file', () => {
    assert.deepEqual(readPrTreeFile(tree, 'src'), { kind: 'other', reason: 'not_regular_file' });
    assert.deepEqual(readPrTreeFile(tree, '.'), { kind: 'other', reason: 'not_regular_file' });
    assert.deepEqual(readPrTreeFile(tree, 'src/./'), { kind: 'other', reason: 'not_regular_file' });
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js/child'), { kind: 'other', reason: 'not_regular_file' });
  });

  test('a FIFO is other and does not block', { skip: process.platform === 'win32', timeout: 5000 }, () => {
    const fifo = path.join(tree, 'pipe');
    execFileSync('mkfifo', [fifo]);
    try {
      assert.deepEqual(readPrTreeFile(tree, 'pipe'), { kind: 'other', reason: 'not_regular_file' });
    } finally {
      fs.rmSync(fifo);
    }
  });

  test('a file over maxBytes is too_large with its size, never opened nor read', () => {
    const open = mock.method(fs, 'openSync');
    const read = mock.method(fs, 'readSync');
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js', { maxBytes: 5 }), { kind: 'too_large', size: 20 });
    assert.equal(open.mock.callCount(), 0);
    assert.equal(read.mock.callCount(), 0);
  });

  test('a file exactly at maxBytes is read', () => {
    assert.equal(readPrTreeFile(tree, 'src/a.js', { maxBytes: 20 }).kind, 'file');
  });

  test('absolute paths and paths escaping the root are rejected without any lstat', () => {
    const lstat = mock.method(fs, 'lstatSync');
    for (const p of [path.join(outside, 'secret.txt'), '/etc/passwd', '..', '../x', 'src/../../x', '', null]) {
      assert.deepEqual(readPrTreeFile(tree, p), { kind: 'other', reason: 'outside_tree' }, String(p));
    }
    assert.equal(lstat.mock.callCount(), 0);
  });

  test('a path normalized back inside the root is read', () => {
    assert.equal(readPrTreeFile(tree, 'src/../src/a.js').kind, 'file');
  });

  test('rejects an invalid maxBytes', () => {
    for (const maxBytes of [-1, 1.5, Number.NaN, '10']) {
      assert.throws(() => readPrTreeFile(tree, 'src/a.js', { maxBytes }), TypeError);
    }
  });

  test('the default bound is 1 MiB', () => {
    assert.equal(PR_TREE_MAX_BYTES, 1024 * 1024);
  });

  test('an lstat error other than ENOENT / ENOTDIR is thrown', () => {
    mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    assert.throws(() => readPrTreeFile(tree, 'src/a.js'), { code: 'EACCES' });
  });

  // lstat → open races: the path is swapped between the lstat and the open.
  test('a symlink swapped in before the open (ELOOP from O_NOFOLLOW) is other', () => {
    mock.method(fs, 'openSync', () => { throw Object.assign(new Error('loop'), { code: 'ELOOP' }); });
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js'), { kind: 'other', reason: 'symlink' });
  });

  test('a file removed before the open is missing', () => {
    mock.method(fs, 'openSync', () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js'), { kind: 'missing' });
  });

  test('any other open error is thrown', () => {
    mock.method(fs, 'openSync', () => { throw Object.assign(new Error('io'), { code: 'EIO' }); });
    assert.throws(() => readPrTreeFile(tree, 'src/a.js'), { code: 'EIO' });
  });

  test('a FIFO swapped in before the open is caught by fstat, without blocking', { skip: process.platform === 'win32', timeout: 5000 }, () => {
    const fifo = path.join(tree, 'swapped');
    execFileSync('mkfifo', [fifo]);
    const realLstat = fs.lstatSync;
    mock.method(fs, 'lstatSync', (p) => realLstat(p === fifo ? path.join(tree, 'src', 'a.js') : p));
    try {
      assert.deepEqual(readPrTreeFile(tree, 'swapped'), { kind: 'other', reason: 'not_regular_file' });
    } finally {
      fs.rmSync(fifo);
    }
  });

  test('a file that grew past maxBytes after the lstat is too_large (fstat check), never read', () => {
    const realFstat = fs.fstatSync;
    mock.method(fs, 'fstatSync', (fd) => Object.assign(realFstat(fd), { size: 1000 }));
    const read = mock.method(fs, 'readSync');
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js', { maxBytes: 100 }), { kind: 'too_large', size: 1000 });
    assert.equal(read.mock.callCount(), 0);
  });

  test('a file growing during the read stops at maxBytes + 1 bytes', () => {
    const realLstat = fs.lstatSync;
    const realFstat = fs.fstatSync;
    mock.method(fs, 'lstatSync', (p) => Object.assign(realLstat(p), p.endsWith('a.js') ? { size: 2 } : {}));
    mock.method(fs, 'fstatSync', (fd) => Object.assign(realFstat(fd), { size: 2 }));
    assert.deepEqual(readPrTreeFile(tree, 'src/a.js', { maxBytes: 4 }), { kind: 'too_large', size: 5 });
  });

  test('a file larger than one read chunk is read whole', () => {
    const big = 'x'.repeat(200 * 1024);
    fs.writeFileSync(path.join(tree, 'big.txt'), big);
    assert.deepEqual(readPrTreeFile(tree, 'big.txt'), { kind: 'file', content: big });
  });
});

describe('lstatPrTreePath', () => {
  test('returns the size of a regular file without opening it', () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tree-lstat-'));
    try {
      fs.writeFileSync(path.join(tree, 'f.txt'), 'abc');
      const open = mock.method(fs, 'openSync');
      assert.deepEqual(lstatPrTreePath(tree, 'f.txt'), { kind: 'file', size: 3 });
      assert.equal(open.mock.callCount(), 0);
    } finally {
      mock.restoreAll();
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});
