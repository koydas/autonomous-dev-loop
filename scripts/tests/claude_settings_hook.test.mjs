import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
const hookEntry = settings.hooks.PostToolUse[0];
const hook = hookEntry.hooks[0];

const hasJq = spawnSync('jq', ['--version']).status === 0;

// Runs the hook command against a throwaway project whose only test writes a
// marker file, so we can observe whether the suite ran without recursing into
// the real one.
function runHook(filePath, { failing = false } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'hook-project-'));
  const marker = join(project, 'ran.marker');
  mkdirSync(join(project, 'scripts', 'tests'), { recursive: true });
  writeFileSync(
    join(project, 'scripts', 'tests', 'stub.test.mjs'),
    `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('stub', () => {
  writeFileSync(${JSON.stringify(marker)}, 'ran');
  ${failing ? "throw new Error('stub failure');" : ''}
});
`,
  );
  const cwd = mkdtempSync(join(tmpdir(), 'hook-cwd-'));
  try {
    const payload = filePath === undefined ? {} : { tool_input: { file_path: filePath } };
    // Drop NODE_TEST_CONTEXT so the nested runner doesn't think it is a
    // child of this one and swallow its own execution.
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const res = spawnSync('bash', ['-c', hook.command], {
      cwd,
      input: JSON.stringify(payload),
      env: { ...env, CLAUDE_PROJECT_DIR: project },
      encoding: 'utf8',
    });
    return { status: res.status, ran: existsSync(marker) };
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('settings.json declares a Write|Edit PostToolUse command hook', () => {
  assert.equal(hookEntry.matcher, 'Write|Edit');
  assert.equal(hook.type, 'command');
  assert.match(hook.command, /node --test scripts\/tests\/\*\.test\.mjs/);
});

test('hook timeout leaves headroom above the suite runtime', () => {
  assert.ok(hook.timeout >= 120, `timeout ${hook.timeout}s is too close to the suite runtime`);
});

test('hook runs the suite from CLAUDE_PROJECT_DIR for scripts/ edits', { skip: !hasJq && 'jq not installed' }, () => {
  const { status, ran } = runHook('/repo/scripts/lib/foo.mjs');
  assert.equal(status, 0);
  assert.equal(ran, true);
});

test('hook runs the suite for .github/workflows/ edits', { skip: !hasJq && 'jq not installed' }, () => {
  const { status, ran } = runHook('/repo/.github/workflows/test.yml');
  assert.equal(status, 0);
  assert.equal(ran, true);
});

test('hook skips the suite for unrelated edits', { skip: !hasJq && 'jq not installed' }, () => {
  const { status, ran } = runHook('/repo/README.md');
  assert.equal(status, 0);
  assert.equal(ran, false);
});

test('hook skips the suite when the payload has no file_path', { skip: !hasJq && 'jq not installed' }, () => {
  const { status, ran } = runHook(undefined);
  assert.equal(status, 0);
  assert.equal(ran, false);
});

test('hook exits non-zero when the suite fails', { skip: !hasJq && 'jq not installed' }, () => {
  const { status, ran } = runHook('/repo/scripts/foo.mjs', { failing: true });
  assert.equal(ran, true);
  assert.notEqual(status, 0);
});
