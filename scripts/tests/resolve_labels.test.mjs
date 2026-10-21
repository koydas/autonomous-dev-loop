import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLabel } from '../resolve_labels.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LABELS = { issue: { valid: { name: 'ready-for-dev' } }, review: { changes: { name: ' changes-requested ' } } };

test('resolveLabel walks the dotted path and trims the name', () => {
  assert.equal(resolveLabel(LABELS, 'issue.valid.name'), 'ready-for-dev');
  assert.equal(resolveLabel(LABELS, 'review.changes.name'), 'changes-requested');
});

test('resolveLabel names the path it cannot resolve, and refuses a non-label', () => {
  for (const bad of ['issue.nope.name', 'nope', 'issue.valid.name.x', '', undefined, 'issue.valid', 'constructor', 'issue.__proto__']) {
    assert.throws(() => resolveLabel(LABELS, bad), /labels config (has no|".*" is not a label name)/, String(bad));
  }
  assert.throws(() => resolveLabel({ a: { b: '  ' } }, 'a.b'), /is not a label name/);
});

function run(args, env = {}) {
  const out = path.join(os.tmpdir(), `adl-out-${process.pid}-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(out, '');
  const res = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'resolve_labels.mjs'), ...args], {
    cwd: os.tmpdir(), env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env }, encoding: 'utf8',
  });
  const written = fs.readFileSync(out, 'utf8');
  fs.rmSync(out, { force: true });
  return { ...res, written };
}

test('resolve_labels writes the label as a step output (this repository, then a target layer)', () => {
  const own = run(['issue.valid.name', 'ready_for_dev']);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.written, 'ready_for_dev=ready-for-dev\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-labels-'));
  try {
    fs.writeFileSync(path.join(dir, 'labels.yaml'), 'review:\n  changes:\n    name: needs-work\n');
    const target = run(['review.changes.name', 'changes_requested'], { ADL_CONFIG_DIR: dir });
    assert.equal(target.status, 0, target.stderr);
    assert.equal(target.written, 'changes_requested=needs-work\n');
    // The CLI fails like every startup check: file and key in the message.
    fs.writeFileSync(path.join(dir, 'labels.yaml'), 'review:\n  changes:\n    nope: x\n');
    const bad = run(['review.changes.name', 'changes_requested'], { ADL_CONFIG_DIR: dir });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown key "review\.changes\.nope"/);
    assert.equal(bad.written, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve_labels fails with a usage line or the unresolved path', () => {
  const noArgs = run([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /::error::usage: resolve_labels\.mjs <group\.section\.leaf> <output-name>/);
  const noName = run(['issue.valid.name']);
  assert.equal(noName.status, 1);
  const unknown = run(['issue.valid.nope', 'x']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /labels config has no "issue\.valid\.nope"/);
  assert.equal(unknown.written, '');
});
