import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInterface, readAllInterfaces, compareInterfaces, snapshotDrift, formatSnapshot, SNAPSHOT_PATH } from '../workflow_interface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');
const snapshot = () => JSON.parse(fs.readFileSync(path.join(REPO, SNAPSHOT_PATH), 'utf8'));

const SAMPLE = `name: X
on:
  workflow_call:
    inputs:
      pipeline_repository:
        description: 'd'
        type: string
        default: 'koydas/autonomous-dev-loop'
      pr_number:
        description: 'PR number'
        required: true
        type: number
      retrigger:
        type: boolean
        default: true
    secrets:
      TOKEN_A:
        required: false
      TOKEN_B:
        required: true

permissions:
  contents: read

jobs:
  first:
    runs-on: ubuntu-latest
    permissions:
      # a comment
      actions: read
      contents: read
    steps:
      - run: echo
  second:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: echo
`;

test('readInterface reads inputs, secrets, jobs and the permission ceiling of a reusable workflow', () => {
  assert.deepEqual(readInterface(SAMPLE), {
    inputs: {
      pipeline_repository: { type: 'string', required: false, default: 'koydas/autonomous-dev-loop' },
      pr_number: { type: 'number', required: true },
      retrigger: { type: 'boolean', required: false, default: 'true' },
    },
    secrets: { TOKEN_A: { required: false }, TOKEN_B: { required: true } },
    jobs: ['first', 'second'],
    ceiling: { actions: 'read', contents: 'write' },
  });
});

test('readInterface refuses a workflow that is not reusable, and reads one without secrets', () => {
  assert.throws(() => readInterface('name: X\non:\n  push:\n\npermissions:\n  contents: read\n\njobs:\n  a:\n    runs-on: x\n'), /not a reusable workflow/);
  const noSecrets = SAMPLE.replace(/    secrets:\n(?: {6}.+\n| {8}.+\n)+/, '');
  assert.deepEqual(readInterface(noSecrets).secrets, {});
});

test('the five reusable workflows are read, and the snapshot of the repository is in sync with them (a change needs a snapshot update and a CHANGELOG entry)', () => {
  const current = readAllInterfaces(WORKFLOWS);
  assert.deepEqual(Object.keys(current), ['adl-auto-fix-pr.yml', 'adl-code-generation.yml', 'adl-pr-review.yml', 'adl-reset-auto-fix.yml', 'adl-validate-issue.yml']);
  assert.deepEqual(snapshotDrift(snapshot(), current), [], 'run: node scripts/workflow_interface.mjs --write, then add a CHANGELOG entry');
  assert.equal(fs.readFileSync(path.join(REPO, SNAPSHOT_PATH), 'utf8'), formatSnapshot(current), 'the snapshot is the generated text, byte for byte');
});

test('every reusable workflow has the common inputs with their documented defaults, optional secrets and a ceiling', () => {
  for (const [file, spec] of Object.entries(readAllInterfaces(WORKFLOWS))) {
    assert.equal(spec.inputs.pipeline_repository.default, 'koydas/autonomous-dev-loop', file);
    assert.equal(spec.inputs.config_dir.default, '.autonomous-dev-loop', file);
    assert.equal(spec.inputs.pipeline_ref.default, '', file);
    assert.ok(Object.values(spec.secrets).every((s) => s.required === false), `${file}: secrets stay optional`);
    assert.ok(Object.keys(spec.ceiling).length > 0, file);
  }
  const all = readAllInterfaces(WORKFLOWS);
  assert.deepEqual(all['adl-reset-auto-fix.yml'].inputs.pr_number, { type: 'number', required: true });
  assert.equal(all['adl-pr-review.yml'].inputs.autofix_workflow_file.default, 'auto-fix-pr.yml');
  assert.equal(all['adl-validate-issue.yml'].inputs.codegen_workflow_file.default, 'code-generation.yml');
  assert.deepEqual(all['adl-validate-issue.yml'].ceiling, { actions: 'write', contents: 'write', issues: 'write' });
});

const base = () => structuredClone({ 'adl-x.yml': readInterface(SAMPLE) });

test('compareInterfaces: nothing a caller written against the base relies on changes for additions and a smaller ceiling', () => {
  const after = base();
  after['adl-x.yml'].inputs.extra = { type: 'string', required: false, default: '' };
  after['adl-x.yml'].inputs.required_with_default = { type: 'string', required: true, default: 'x' };
  after['adl-x.yml'].secrets.TOKEN_C = { required: false };
  after['adl-x.yml'].ceiling = { actions: 'read', contents: 'read' };
  after['adl-y.yml'] = readInterface(SAMPLE);
  assert.deepEqual(compareInterfaces(base(), after), []);
  assert.deepEqual(compareInterfaces(base(), base()), []);
});

test('compareInterfaces lists every kind of breaking change with its workflow', () => {
  const cases = {
    'workflow removed': [(a) => { delete a['adl-x.yml']; }, /adl-x\.yml: removed/],
    'input removed': [(a) => { delete a['adl-x.yml'].inputs.retrigger; }, /input retrigger removed/],
    'input type changed': [(a) => { a['adl-x.yml'].inputs.pr_number.type = 'string'; }, /input pr_number changed type number → string/],
    'input became required': [(a) => { a['adl-x.yml'].inputs.retrigger.required = true; }, /input retrigger became required/],
    'input default changed': [(a) => { a['adl-x.yml'].inputs.pipeline_repository.default = 'acme/fork'; }, /input pipeline_repository default changed "koydas\/autonomous-dev-loop" → "acme\/fork"/],
    'default dropped': [(a) => { delete a['adl-x.yml'].inputs.retrigger.default; }, /input retrigger default changed "true" → null/],
    'new required input without default': [(a) => { a['adl-x.yml'].inputs.fresh = { type: 'string', required: true }; }, /new required input fresh/],
    'secret removed': [(a) => { delete a['adl-x.yml'].secrets.TOKEN_A; }, /secret TOKEN_A removed/],
    'secret became required': [(a) => { a['adl-x.yml'].secrets.TOKEN_A.required = true; }, /secret TOKEN_A became required/],
    'new required secret': [(a) => { a['adl-x.yml'].secrets.TOKEN_C = { required: true }; }, /new required secret TOKEN_C/],
    'scope added to the ceiling': [(a) => { a['adl-x.yml'].ceiling.issues = 'read'; }, /permission issues: read added to the ceiling/],
    'scope raised': [(a) => { a['adl-x.yml'].ceiling.actions = 'write'; }, /permission actions raised read → write/],
  };
  for (const [label, [mutate, expected]] of Object.entries(cases)) {
    const after = base();
    mutate(after);
    const breaking = compareInterfaces(base(), after);
    assert.equal(breaking.length, 1, `${label}: ${breaking.join('; ')}`);
    assert.match(breaking[0], expected, label);
  }
});

test('snapshotDrift names the workflow that is new, gone or different', () => {
  const current = { 'adl-a.yml': readInterface(SAMPLE), 'adl-b.yml': readInterface(SAMPLE) };
  const changed = structuredClone(current);
  changed['adl-a.yml'].ceiling.issues = 'read';
  assert.deepEqual(snapshotDrift(current, current), []);
  assert.deepEqual(snapshotDrift(changed, current), ['adl-a.yml: its interface differs from the snapshot']);
  assert.deepEqual(snapshotDrift({ 'adl-a.yml': current['adl-a.yml'] }, current), ['adl-b.yml: not in the snapshot']);
  assert.deepEqual(snapshotDrift({ ...current, 'adl-c.yml': current['adl-a.yml'] }, current), ['adl-c.yml: in the snapshot but not a reusable workflow any more']);
});

function runCli(args, cwd = REPO) {
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', 'workflow_interface.mjs'), ...args], { cwd, encoding: 'utf8' });
}

test('the CLI checks the real snapshot, writes a new one, and compares against a base snapshot', () => {
  const ok = runCli([]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Snapshot in sync \(5 reusable workflows\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-iface-'));
  try {
    const workflows = path.join(dir, 'workflows');
    fs.mkdirSync(workflows);
    fs.writeFileSync(path.join(workflows, 'adl-x.yml'), SAMPLE);
    fs.writeFileSync(path.join(workflows, 'not-reusable.yml'), 'name: y\n');
    const snap = path.join(dir, 'snapshot.json');
    const write = runCli(['--write', '--snapshot', snap, '--workflows', workflows]);
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /\(1 reusable workflows\)/);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(snap, 'utf8'))), ['adl-x.yml']);
    assert.equal(runCli(['--snapshot', snap, '--workflows', workflows]).status, 0);
    // The workflow gains a required secret: out of sync with the snapshot, and breaking against it as a base.
    fs.writeFileSync(path.join(workflows, 'adl-x.yml'), SAMPLE.replace('TOKEN_A:\n        required: false', 'TOKEN_A:\n        required: true'));
    const drift = runCli(['--snapshot', snap, '--workflows', workflows]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /adl-x\.yml: its interface differs from the snapshot/);
    assert.match(drift.stderr, /node scripts\/workflow_interface\.mjs --write/);
    const breaking = runCli(['--base', snap, '--workflows', workflows]);
    assert.equal(breaking.status, 1);
    assert.match(breaking.stdout, /Breaking changes for a caller \(1\): a new major version\.\n- adl-x\.yml: secret TOKEN_A became required/);
    fs.writeFileSync(path.join(workflows, 'adl-x.yml'), SAMPLE);
    const none = runCli(['--base', snap, '--workflows', workflows]);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /No breaking change for a caller since the base snapshot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses an unknown option, an option without a value and a missing snapshot', () => {
  const unknown = runCli(['--force']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option --force/);
  const noValue = runCli(['--base']);
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /--base needs a value/);
  const missing = runCli(['--snapshot', path.join(os.tmpdir(), 'adl-no-such-snapshot.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /::error::.*ENOENT/);
});
