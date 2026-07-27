import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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

  test('rethrows unexpected non-ENOENT read errors instead of swallowing them', async () => {
    const dirDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-manifest-direrr-'));
    await fs.mkdir(path.join(dirDir, 'package.json'));
    await assert.rejects(
      () => readPackageJsonDependencies(dirDir),
      (err) => err.code === 'EISDIR',
    );
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
