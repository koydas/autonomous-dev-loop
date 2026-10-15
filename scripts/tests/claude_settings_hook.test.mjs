import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachePath, isPushCommand, summarizeFailure } from '../../.claude/hooks/test-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(REPO_ROOT, '.claude', 'hooks', 'test-gate.mjs');
const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// Throwaway git project whose only test writes a marker file (and fails on demand),
// so we can observe whether the gate ran the suite without recursing into the real one.
// origin/main points at the initial commit, like a feature branch checkout.
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-project-'));
  mkdirSync(join(dir, 'scripts', 'tests'), { recursive: true });
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  writeFileSync(join(dir, 'prompts', 'p.md'), 'prompt\n');
  writeFileSync(join(dir, '.gitignore'), 'ran.marker\n');
  writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  writeStub(dir, false);
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

function commitAll(dir, msg = 'change') {
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg);
}

function writeStub(dir, failing) {
  const marker = join(dir, 'ran.marker');
  writeFileSync(
    join(dir, 'scripts', 'tests', 'stub.test.mjs'),
    `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('stub', () => {
  appendFileSync(${JSON.stringify(marker)}, 'x');
  ${failing ? "throw new Error('stub failure');" : ''}
});
`,
  );
}

function runs(dir) {
  const marker = join(dir, 'ran.marker');
  return existsSync(marker) ? readFileSync(marker, 'utf8').length : 0;
}

function gate(dir, mode, payload = {}) {
  // Drop NODE_TEST_CONTEXT so the nested runner doesn't think it is a child of this one.
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const res = spawnSync(process.execPath, [GATE, mode], {
    input: JSON.stringify(payload),
    env: { ...env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function withProject(fn) {
  const dir = makeProject();
  try {
    fn(dir);
  } finally {
    rmSync(cachePath(dir), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const PUSH = { tool_input: { command: 'git push -u origin feature' } };

test('settings.json runs the gate on Stop and before Bash, with headroom above the suite runtime', () => {
  const stop = settings.hooks.Stop[0].hooks[0];
  const pre = settings.hooks.PreToolUse.find((h) => h.matcher === 'Bash').hooks[0];
  assert.match(stop.command, /\.claude\/hooks\/test-gate\.mjs" stop$/);
  assert.match(pre.command, /\.claude\/hooks\/test-gate\.mjs" pre-push$/);
  for (const h of [stop, pre]) {
    assert.equal(h.type, 'command');
    assert.match(h.command, /\$CLAUDE_PROJECT_DIR/);
    assert.ok(h.timeout >= 120, `timeout ${h.timeout}s is too close to the suite runtime`);
  }
  assert.equal(settings.hooks.PostToolUse, undefined, 'the per-edit suite run is replaced by the gate');
});

test('settings.json declares the ai-dev-tools plugin marketplace', () => {
  assert.deepEqual(settings.extraKnownMarketplaces['ai-dev-tools'].source, { source: 'github', repo: 'koydas/ai-dev-tools' });
  assert.equal(settings.enabledPlugins['ai-dev-tools@ai-dev-tools'], true);
});

test('stop: an uncommitted scripts/ change runs the suite', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 2;\n');
    const { status } = gate(dir, 'stop');
    assert.equal(status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('stop: a .github/workflows/ change runs the suite', () => {
  withProject((dir) => {
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: pull_request\n');
    assert.equal(gate(dir, 'stop').status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('stop: a change already committed on the branch still runs the suite', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 3;\n');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'change');
    assert.equal(gate(dir, 'stop').status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('stop: a new untracked file under scripts/ runs the suite', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'new.mjs'), 'export {};\n');
    assert.equal(gate(dir, 'stop').status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('stop: changes outside scripts/ and .github/workflows/ skip the suite', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    assert.equal(gate(dir, 'stop').status, 0);
    assert.equal(runs(dir), 0);
  });
});

test('stop: an unchanged change set is not re-run after a pass', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 4;\n');
    gate(dir, 'stop');
    assert.equal(gate(dir, 'stop').status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('stop: a failing suite exits 2 with the failure on stderr and nothing on stdout', () => {
  withProject((dir) => {
    writeStub(dir, true);
    const { status, stdout, stderr } = gate(dir, 'stop');
    assert.equal(status, 2);
    assert.match(stderr, /stub failure/);
    assert.equal(stdout, '');
  });
});

test('stop: the same failing change set does not block twice (no Stop loop), a new edit re-runs', () => {
  withProject((dir) => {
    writeStub(dir, true);
    assert.equal(gate(dir, 'stop').status, 2);
    assert.equal(gate(dir, 'stop').status, 0);
    assert.equal(runs(dir), 1);
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 5;\n');
    assert.equal(gate(dir, 'stop').status, 2);
    assert.equal(runs(dir), 2);
  });
});

test('pre-push: a Bash command that is not git push is let through without running the suite', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 6;\n');
    assert.equal(gate(dir, 'pre-push', { tool_input: { command: 'git status' } }).status, 0);
    assert.equal(runs(dir), 0);
  });
});

test('pre-push: git push on an untested committed change set runs the suite and blocks on failure', () => {
  withProject((dir) => {
    writeStub(dir, true);
    commitAll(dir);
    const { status, stderr } = gate(dir, 'pre-push', PUSH);
    assert.equal(status, 2);
    assert.match(stderr, /push blocked/);
    assert.equal(runs(dir), 1);
  });
});

test('pre-push: git push on a change set that already failed is blocked without re-running', () => {
  withProject((dir) => {
    writeStub(dir, true);
    commitAll(dir);
    gate(dir, 'stop');
    const { status, stderr } = gate(dir, 'pre-push', PUSH);
    assert.equal(status, 2);
    assert.match(stderr, /failed on this exact change set/);
    assert.equal(runs(dir), 1);
  });
});

test('pre-push: git push on a change set that already passed is let through without re-running', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 7;\n');
    commitAll(dir);
    gate(dir, 'stop');
    assert.equal(gate(dir, 'pre-push', PUSH).status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('pre-push: committed break with an uncommitted fix is blocked — HEAD is what gets pushed', () => {
  withProject((dir) => {
    writeStub(dir, true);
    commitAll(dir, 'break');
    writeStub(dir, false);
    const { status, stderr } = gate(dir, 'pre-push', PUSH);
    assert.equal(status, 2);
    assert.match(stderr, /uncommitted changes/);
    assert.match(stderr, /stub\.test\.mjs/);
    assert.equal(runs(dir), 0);
  });
});

test('pre-push: an untracked file under a watched path blocks the push', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'new.mjs'), 'export {};\n');
    const { status, stderr } = gate(dir, 'pre-push', PUSH);
    assert.equal(status, 2);
    assert.match(stderr, /scripts\/new\.mjs/);
  });
});

test('pre-push: uncommitted changes outside watched paths do not block', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 8;\n');
    commitAll(dir);
    writeFileSync(join(dir, 'README.md'), 'local note\n');
    assert.equal(gate(dir, 'pre-push', PUSH).status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('stop: a prompts/ change runs the suite', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'prompts', 'p.md'), 'changed prompt\n');
    assert.equal(gate(dir, 'stop').status, 0);
    assert.equal(runs(dir), 1);
  });
});

test('gate exits 2 when CLAUDE_PROJECT_DIR is unusable', () => {
  const { status, stderr } = gate(join(tmpdir(), 'no-such-project-dir'), 'stop');
  assert.equal(status, 2);
  assert.match(stderr, /not a directory/);
});

test('gate runs the suite every time outside a git tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-nogit-'));
  try {
    mkdirSync(join(dir, 'scripts', 'tests'), { recursive: true });
    writeStub(dir, false);
    gate(dir, 'stop');
    gate(dir, 'stop');
    assert.equal(runs(dir), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate rejects an unknown mode', () => {
  const res = spawnSync(process.execPath, [GATE, 'post-edit'], { input: '{}', encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});

test('isPushCommand matches git push forms only', () => {
  for (const c of ['git push', 'git push -u origin x', 'cd a && git push', 'git -C repo push', 'git -c k=v push --force-with-lease', '/usr/bin/git push', 'bash -c "git push"', "sh -c 'git push origin x'"]) {
    assert.equal(isPushCommand(c), true, c);
  }
  for (const c of ['git status', 'git log --grep push', 'echo git', 'npm run push', undefined, 42]) {
    assert.equal(isPushCommand(c), false, String(c));
  }
});

test('isPushCommand ignores "git push" inside commit messages, echo text and heredoc bodies', () => {
  const heredoc = "git commit -F - <<'EOF'\nfix: git push gate\nEOF";
  const subst = `git commit -m "$(cat <<'EOF'\nfix: git push gate tests HEAD\nEOF\n)"`;
  for (const c of ['git commit -am "fix: git push gate tests HEAD"', "git commit -m 'git push'", 'git add -A && git commit -m "docs: explain git push flow"', 'echo "run git push later"', heredoc, subst]) {
    assert.equal(isPushCommand(c), false, c);
  }
  for (const c of ['git commit -m "wip" && git push', `${heredoc}\ngit push -u origin x`, `${subst} && git push`, 'git -c "k=v" push']) {
    assert.equal(isPushCommand(c), true, c);
  }
});

test('pre-push: a commit whose message mentions git push is not blocked on a dirty tree', () => {
  withProject((dir) => {
    writeFileSync(join(dir, 'scripts', 'lib.mjs'), 'export const x = 9;\n');
    const commit = { tool_input: { command: 'git add -A && git commit -m "fix: git push gate tests HEAD"' } };
    assert.equal(gate(dir, 'pre-push', commit).status, 0);
    assert.equal(runs(dir), 0);
  });
});

test('summarizeFailure keeps the failing-tests section, else the tail, capped', () => {
  assert.equal(summarizeFailure('ok 1\n✖ failing tests:\n\nstub failure'), 'failing tests:\n\nstub failure');
  const tail = summarizeFailure(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
  assert.match(tail, /^line 120\n/);
  assert.ok(summarizeFailure('failing tests:' + 'x'.repeat(20000)).length <= 12002);
});
