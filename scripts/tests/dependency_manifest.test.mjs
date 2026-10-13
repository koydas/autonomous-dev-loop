import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  readPackageJsonDependencies,
  formatDependencyManifestContext,
  buildDependencyManifestContext,
} from '../lib/dependency_manifest.mjs';

// ---------------------------------------------------------------------------
// readPackageJsonDependencies
// ---------------------------------------------------------------------------

describe('readPackageJsonDependencies', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns null when no package.json exists', async () => {
    const deps = await readPackageJsonDependencies(tmpDir);
    assert.equal(deps, null);
  });

  test('returns null for a malformed package.json instead of throwing', async () => {
    const badDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-bad-'));
    await fs.writeFile(path.join(badDir, 'package.json'), '{ not valid json', 'utf8');
    await assert.doesNotReject(async () => {
      const deps = await readPackageJsonDependencies(badDir);
      assert.equal(deps, null);
    });
    await fs.rm(badDir, { recursive: true, force: true });
  });

  test('returns null instead of throwing when package.json is valid JSON but not an object (null)', async () => {
    const nullDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-null-'));
    await fs.writeFile(path.join(nullDir, 'package.json'), 'null', 'utf8');
    await assert.doesNotReject(async () => {
      const deps = await readPackageJsonDependencies(nullDir);
      assert.equal(deps, null);
    });
    await fs.rm(nullDir, { recursive: true, force: true });
  });

  test('returns null instead of throwing when package.json is a top-level array', async () => {
    const arrDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-arr-'));
    await fs.writeFile(path.join(arrDir, 'package.json'), '["react"]', 'utf8');
    const deps = await readPackageJsonDependencies(arrDir);
    assert.equal(deps, null);
    await fs.rm(arrDir, { recursive: true, force: true });
  });

  test('ignores a non-object dependency field instead of spreading its indices as package names', async () => {
    const shapeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-shape-'));
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

  test('merges dependencies, devDependencies, peerDependencies, and optionalDependencies', async () => {
    const depDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-deps-'));
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

  // Issue #195: a directory used to be rethrown as EISDIR and aborted pr_review before the LLM
  // call. It is now "no manifest" (the warn event is checked in the non-regular describe below).
  test('returns null instead of rethrowing EISDIR when package.json is a directory', async () => {
    const dirDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-direrr-'));
    await fs.mkdir(path.join(dirDir, 'package.json'));
    await assert.doesNotReject(async () => {
      assert.equal(await readPackageJsonDependencies(dirDir), null);
    });
    await fs.rm(dirDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// formatDependencyManifestContext
// ---------------------------------------------------------------------------

describe('formatDependencyManifestContext', () => {
  test('returns an empty string for null', () => {
    assert.equal(formatDependencyManifestContext(null), '');
  });

  test('returns an empty string for an empty object', () => {
    assert.equal(formatDependencyManifestContext({}), '');
  });

  test('lists dependency names sorted alphabetically', () => {
    const block = formatDependencyManifestContext({ zod: '1.0.0', axios: '2.0.0' });
    assert.ok(block.indexOf('- axios') < block.indexOf('- zod'));
  });

  test('includes the section header', () => {
    const block = formatDependencyManifestContext({ react: '18.0.0' });
    assert.ok(block.includes('### Declared npm dependencies'));
  });

  test('instructs the reviewer to treat listed imports as already declared', () => {
    const block = formatDependencyManifestContext({ react: '18.0.0' });
    assert.ok(block.includes('not a violation'));
  });
});

// ---------------------------------------------------------------------------
// buildDependencyManifestContext — integration
// ---------------------------------------------------------------------------

describe('buildDependencyManifestContext', () => {
  test('returns an empty string when no package.json is present', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-int-empty-'));
    const ctx = await buildDependencyManifestContext(tmpDir);
    assert.equal(ctx, '');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns a formatted block when package.json declares dependencies', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-int-'));
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '18.0.0' } }),
      'utf8',
    );
    const ctx = await buildDependencyManifestContext(tmpDir);
    assert.ok(ctx.includes('- react'));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// Issue #195 / ADR-0023: the PR tree's package.json is data only. A symlink, directory or FIFO
// is treated as missing with one warn event: never followed, never an abort, never a hang.
describe('readPackageJsonDependencies on a non-regular package.json', () => {
  let tree;
  let outside;

  before(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-outside-'));
    await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify({ dependencies: { leak: '1' } }), 'utf8');
  });

  after(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  const freshTree = async () => {
    if (tree) await fs.rm(tree, { recursive: true, force: true });
    tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-tree-'));
    return tree;
  };

  // Warn events written by observability.mjs while `fn` runs.
  const captureWarns = async (fn) => {
    const writes = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    let result;
    try {
      result = await fn();
    } finally {
      process.stderr.write = original;
    }
    const events = writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'package_json_ignored');
    return { result, events };
  };

  after(async () => {
    if (tree) await fs.rm(tree, { recursive: true, force: true });
  });

  test('reads a regular package.json as before, without a warn event', async () => {
    const dir = await freshTree();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '1' } }), 'utf8');
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(dir));
    assert.deepEqual(result, { a: '1' });
    assert.equal(events.length, 0);
  });

  test('returns null for a symlink to a package.json outside the tree, without reading it', async () => {
    const dir = await freshTree();
    await fs.symlink(path.join(outside, 'package.json'), path.join(dir, 'package.json'));
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(dir));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].level, 'warn');
    assert.deepEqual(events[0].meta, { path: 'package.json', reason: 'symlink' });
    assert.ok(!(await buildDependencyManifestContext(dir)).includes('leak'));
  });

  test('returns null instead of throwing EISDIR for a symlink to a directory', async () => {
    const dir = await freshTree();
    await fs.symlink(outside, path.join(dir, 'package.json'));
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(dir));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].meta.reason, 'symlink');
  });

  test('returns null for a directory named package.json', async () => {
    const dir = await freshTree();
    await fs.mkdir(path.join(dir, 'package.json'));
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(dir));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].meta.reason, 'not_regular_file');
  });

  test('returns null without hanging for a FIFO package.json', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const dir = await freshTree();
    execFileSync('mkfifo', [path.join(dir, 'package.json')]);
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(dir));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].meta.reason, 'not_regular_file');
  });

  test('returns null without hanging for a symlink to /dev/zero', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const dir = await freshTree();
    await fs.symlink('/dev/zero', path.join(dir, 'package.json'));
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(dir));
    assert.equal(result, null);
    assert.equal(events.length, 1);
  });

  test('returns null with a warn event when package.json cannot be read', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const dir = await freshTree();
    const pkg = path.join(dir, 'package.json');
    await fs.writeFile(pkg, '{}', 'utf8');
    await fs.chmod(pkg, 0o000);
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(dir));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].meta.reason, 'EACCES');
  });

  test('returns null without a warn event when the repo root is a file (ENOTDIR)', async () => {
    const dir = await freshTree();
    const file = path.join(dir, 'not-a-dir');
    await fs.writeFile(file, '', 'utf8');
    const { result, events } = await captureWarns(() => readPackageJsonDependencies(file));
    assert.equal(result, null);
    assert.equal(events.length, 0);
  });
});
