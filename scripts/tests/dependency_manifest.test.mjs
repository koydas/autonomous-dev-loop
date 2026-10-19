import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  readPackageJsonDependencies,
  formatDependencyManifestContext,
  buildDependencyManifestContext,
  MAX_PACKAGE_JSON_BYTES,
} from '../lib/dependency_manifest.mjs';

// ---------------------------------------------------------------------------
// readPackageJsonDependencies
// ---------------------------------------------------------------------------

// Captures the dependency_manifest warn events observability.mjs writes to stderr during `fn`.
async function withWarnEvents(fn) {
  const write = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    const result = await fn();
    const events = lines.join('').split('\n').filter((l) => l.includes('"event":"dependency_manifest.package_json_ignored"')).map((l) => JSON.parse(l));
    assert.ok(events.every((e) => e.level === 'warn'));
    return { result, events };
  } finally {
    process.stderr.write = write;
  }
}

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

  // #195 (ADR-0023): was "rethrows EISDIR"; a non-regular package.json is now "no manifest", never an abort.
  test('returns null with one warn event instead of throwing when package.json is a directory', async () => {
    const dirDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-direrr-'));
    await fs.mkdir(path.join(dirDir, 'package.json'));
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(dirDir));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    await fs.rm(dirDir, { recursive: true, force: true });
  });

  test('returns null without following a symlink to a package.json outside the tree', async () => {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-link-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-outside-'));
    await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify({ dependencies: { leak: '1' } }), 'utf8');
    await fs.symlink(path.join(outside, 'package.json'), path.join(tree, 'package.json'));
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(tree));
    assert.equal(result, null, 'the symlink target is never read');
    assert.equal(events.length, 1);
    assert.equal(events[0].stage, 'dependency_manifest');
    assert.deepEqual(events[0].meta, { path: 'package.json', reason: 'not_regular_file' });
    await Promise.all([tree, outside].map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  test('returns null instead of throwing when package.json is a symlink to a directory', async () => {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-linkdir-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-outside-dir-'));
    await fs.symlink(outside, path.join(tree, 'package.json'));
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(tree));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    await Promise.all([tree, outside].map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  test('returns null without hanging when package.json is a FIFO', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-fifo-'));
    execFileSync('mkfifo', [path.join(tree, 'package.json')]);
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(tree));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    await fs.rm(tree, { recursive: true, force: true });
  });

  // F22: an oversized package.json is ignored without being read.
  test('returns null with a too_large warn event when package.json is over MAX_PACKAGE_JSON_BYTES', async () => {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-large-'));
    const pkg = JSON.stringify({ dependencies: { leak: '1' }, pad: 'x'.repeat(MAX_PACKAGE_JSON_BYTES) });
    await fs.writeFile(path.join(tree, 'package.json'), pkg, 'utf8');
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(tree));
    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].meta, { path: 'package.json', reason: 'too_large' });
    await fs.rm(tree, { recursive: true, force: true });
  });

  test('returns null with one warn event when package.json cannot be read', async (t) => {
    t.mock.method(fsSync, 'lstatSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(tmpDir));
    assert.equal(result, null);
    assert.deepEqual(events.map((e) => e.meta), [{ path: 'package.json', reason: 'EACCES' }]);
  });

  test('a missing package.json returns null without a warn event', async () => {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-missing-'));
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(tree));
    assert.equal(result, null);
    assert.equal(events.length, 0);
    await fs.rm(tree, { recursive: true, force: true });
  });

  test('a regular package.json is read as before, without a warn event', async () => {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-regular-'));
    await fs.writeFile(path.join(tree, 'package.json'), JSON.stringify({ dependencies: { a: '1' } }), 'utf8');
    const { result, events } = await withWarnEvents(() => readPackageJsonDependencies(tree));
    assert.deepEqual(result, { a: '1' });
    assert.equal(events.length, 0);
    await fs.rm(tree, { recursive: true, force: true });
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
