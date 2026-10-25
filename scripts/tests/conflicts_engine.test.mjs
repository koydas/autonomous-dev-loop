import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeForward, cleanEnv, runNpmLockOnly } from '../lib/conflicts_engine.mjs';

// Real git, real files, in a temporary repository: the engine is mostly git plumbing, so a fake would test the fake.
function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conflicts-engine-'));
  const git = (...args) => {
    const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    if (res.status !== 0 && !args.includes('--allow-fail')) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };
  const commit = (message, files = {}) => {
    for (const [file, content] of Object.entries(files)) write(file, content);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, write, commit, read: (file) => fs.readFileSync(path.join(cwd, file), 'utf8'), exists: (file) => fs.existsSync(path.join(cwd, file)), cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

/** main has the base commit, `pr` branched from it; returns the main tip after `onBase` and checks `pr` out after `onPr`. */
function diverge(r, base, onBase, onPr) {
  r.commit('base', base);
  r.git('checkout', '-q', '-b', 'pr');
  onPr();
  r.git('checkout', '-q', 'main');
  onBase();
  const baseSha = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', 'pr');
  return baseSha;
}

// A model that unions both sides, base first: what the CHANGELOG and index resolvers expect.
const sideOf = (hunks, start, end) => hunks.split(start)[1].split(end)[0].replace(/^[^\n]*\n/, '').replace(/\n$/, '');
const unionModel = async ({ hunks }) => JSON.stringify({
  resolutions: hunks.split(/### Hunk /).filter(Boolean).map((chunk, index) => {
    const ours = chunk.split('<<<<<<< ours (the pull request)\n')[1].split('\n|||||||')[0];
    const theirs = chunk.split('\n=======\n')[1].split('\n>>>>>>> theirs')[0];
    return { index, content: `${theirs}\n${ours}\n` };
  }),
});
const refusingModel = async () => { throw new Error('the model must not be called'); };
const input = (r, baseSha, extra = {}) => ({ cwd: r.cwd, baseSha, baseRef: 'main', title: 'PR', prNumber: 7, budgetChars: 50_000, callModel: unionModel, runNpm: () => {}, ...extra });
const CL = (...entries) => `# Changelog\n\n## [Unreleased]\n\n${entries.join('\n')}\n`;

test('cleanEnv carries no token or key, only what git and npm need', () => {
  const saved = { t: process.env.GITHUB_TOKEN, k: process.env.ANTHROPIC_API_KEY };
  process.env.GITHUB_TOKEN = 'secret'; process.env.ANTHROPIC_API_KEY = 'secret';
  try {
    const env = cleanEnv({ EXTRA: '1' });
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.EXTRA, '1');
    assert.ok(env.PATH);
  } finally {
    if (saved.t === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved.t;
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
  }
});

test('noop: a base already merged into the head is left alone (GitHub\'s dirty was stale)', async () => {
  const r = repo();
  try {
    const base = r.commit('base', { 'a.txt': 'a\n' });
    r.git('checkout', '-q', '-b', 'pr');
    r.commit('pr work', { 'b.txt': 'b\n' });
    const res = await mergeForward(input(r, base, { callModel: refusingModel }));
    assert.equal(res.outcome, 'noop');
    assert.equal(r.git('rev-parse', 'HEAD'), res.headSha);
  } finally { r.cleanup(); }
});

test('L0: a base that merges cleanly is merged, no model call, one merge commit with the standard message', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, () => r.commit('base work', { 'a.txt': 'a changed\n' }), () => r.commit('pr work', { 'b.txt': 'b changed\n' }));
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel }));
    assert.equal(res.outcome, 'resolved');
    assert.equal(res.rung, 'L0');
    assert.deepEqual(res.files, []);
    assert.equal(r.read('a.txt'), 'a changed\n');
    assert.equal(r.read('b.txt'), 'b changed\n');
    assert.equal(r.git('log', '-1', '--format=%s'), `fix(ai): resolve merge conflicts with main@${baseSha.slice(0, 7)}`);
    assert.equal(r.git('log', '-1', '--format=%p').split(' ').length, 2, 'a merge commit');
    assert.equal(r.git('status', '--porcelain'), '');
  } finally { r.cleanup(); }
});

test('L2: the CHANGELOG conflict is resolved by the model, hunks only, and the signature is returned', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'CHANGELOG.md': CL('- base entry'), 'src/keep.txt': 'untouched\n' },
      () => r.commit('base', { 'CHANGELOG.md': CL('- theirs entry', '- base entry') }),
      () => r.commit('pr', { 'CHANGELOG.md': CL('- ours entry', '- base entry') }));
    const res = await mergeForward(input(r, baseSha));
    assert.equal(res.outcome, 'resolved');
    assert.equal(res.rung, 'L2');
    assert.equal(res.hunks, 1);
    assert.deepEqual(res.files, ['CHANGELOG.md']);
    assert.match(res.sig, /^[0-9a-f]{10}$/);
    const text = r.read('CHANGELOG.md');
    assert.ok(text.indexOf('- theirs entry') < text.indexOf('- ours entry'), 'base entries first');
    assert.ok(text.includes('- base entry'));
    assert.ok(!/^[<>=|]{7}/m.test(text));
    assert.equal(r.read('src/keep.txt'), 'untouched\n');
    assert.equal(r.git('status', '--porcelain'), '');
  } finally { r.cleanup(); }
});

test('L3: a conflict on a protected path is escalated before any model call, and the merge is aborted', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'scripts/x.mjs': 'export const a = 1;\n' },
      () => r.commit('base', { 'scripts/x.mjs': 'export const a = 2;\n' }), () => r.commit('pr', { 'scripts/x.mjs': 'export const a = 3;\n' }));
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel }));
    assert.equal(res.outcome, 'escalated');
    assert.equal(res.reason, 'protected_path');
    assert.deepEqual(res.blocked, ['scripts/x.mjs']);
    assert.equal(r.git('rev-parse', 'HEAD'), res.headSha, 'nothing committed');
    assert.equal(r.git('status', '--porcelain'), '', 'the merge was aborted: the tree is the head again');
    assert.equal(r.read('scripts/x.mjs'), 'export const a = 3;\n');
  } finally { r.cleanup(); }
});

test('L3: one protected file among resolvable ones stops the whole run', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'CHANGELOG.md': CL('- b'), '.github/w.yml': 'a: 1\n' },
      () => r.commit('base', { 'CHANGELOG.md': CL('- t', '- b'), '.github/w.yml': 'a: 2\n' }), () => r.commit('pr', { 'CHANGELOG.md': CL('- o', '- b'), '.github/w.yml': 'a: 3\n' }));
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel }));
    assert.deepEqual([res.outcome, res.reason, res.blocked], ['escalated', 'protected_path', ['.github/w.yml']]);
  } finally { r.cleanup(); }
});

test('unsupported conflicts: modify/delete and binary files are escalated, never guessed at', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' },
      () => { fs.rmSync(path.join(r.cwd, 'src/a.txt')); r.commit('base deletes', {}); },
      () => r.commit('pr edits', { 'src/a.txt': 'a edited\n' }));
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel }));
    assert.deepEqual([res.outcome, res.reason, res.blocked], ['escalated', 'unsupported_conflict', ['src/a.txt']]);
    assert.equal(r.git('status', '--porcelain'), '');
  } finally { r.cleanup(); }
  const r2 = repo();
  try {
    const baseSha = diverge(r2, { 'img.bin': Buffer.from([0, 1, 2]).toString('latin1') },
      () => r2.commit('base', { 'img.bin': Buffer.from([0, 1, 3]).toString('latin1') }), () => r2.commit('pr', { 'img.bin': Buffer.from([0, 1, 4]).toString('latin1') }));
    const res = await mergeForward(input(r2, baseSha, { callModel: refusingModel }));
    assert.deepEqual([res.outcome, res.reason], ['escalated', 'binary_file']);
  } finally { r2.cleanup(); }
});

test('size limits: a file past the byte cap and more files than the model resolves in one run are escalated', async () => {
  const r = repo();
  try {
    const big = (tag) => `${'x'.repeat(250_000)}\n${tag}\n`;
    const baseSha = diverge(r, { 'src/big.txt': big('base') }, () => r.commit('base', { 'src/big.txt': big('theirs') }), () => r.commit('pr', { 'src/big.txt': big('ours') }));
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel }));
    assert.deepEqual([res.outcome, res.reason], ['escalated', 'too_large']);
  } finally { r.cleanup(); }
  const r2 = repo();
  try {
    const files = (v) => Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`src/${n}.txt`, `${v}\n`]));
    const baseSha = diverge(r2, files('base'), () => r2.commit('base', files('theirs')), () => r2.commit('pr', files('ours')));
    const res = await mergeForward(input(r2, baseSha, { callModel: refusingModel }));
    assert.deepEqual([res.outcome, res.reason, res.blocked.length], ['escalated', 'too_many_files', 4]);
  } finally { r2.cleanup(); }
});

test('the model: absent, over budget, rejected by the post-check or answering garbage all escalate with a reason', async () => {
  const setup = (r) => diverge(r, { 'CHANGELOG.md': CL('- b') }, () => r.commit('base', { 'CHANGELOG.md': CL('- t', '- b') }), () => r.commit('pr', { 'CHANGELOG.md': CL('- o', '- b') }));
  const cases = [
    ['no model', { callModel: null }, 'model_rejected', ['no_model']],
    ['over budget', { budgetChars: 5 }, 'too_large', undefined],
    ['drops an entry', { callModel: async () => JSON.stringify({ resolutions: [{ index: 0, content: '- t\n' }] }) }, 'model_rejected', ['entry_dropped']],
    ['garbage', { callModel: async () => 'I cannot do that' }, 'parse_failed', undefined],
  ];
  for (const [label, extra, reason, rules] of cases) {
    const r = repo();
    try {
      const baseSha = setup(r);
      const res = await mergeForward(input(r, baseSha, extra));
      assert.equal(res.outcome, 'escalated', label);
      assert.equal(res.reason, reason, label);
      assert.deepEqual(res.rules, rules, label);
      assert.equal(r.git('status', '--porcelain'), '', `${label}: aborted`);
    } finally { r.cleanup(); }
  }
});

test('beforeResolve: a reason stops the run before any model call (circuit breaker); null lets it go on', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'CHANGELOG.md': CL('- b') }, () => r.commit('base', { 'CHANGELOG.md': CL('- t', '- b') }), () => r.commit('pr', { 'CHANGELOG.md': CL('- o', '- b') }));
    let seen;
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel, beforeResolve: (plan) => { seen = plan; return 'circuit_open'; } }));
    assert.deepEqual([res.outcome, res.reason], ['escalated', 'circuit_open']);
    assert.deepEqual(seen.files, ['CHANGELOG.md']);
    assert.match(seen.sig, /^[0-9a-f]{10}$/);
    const ok = await mergeForward(input(r, baseSha, { beforeResolve: () => null }));
    assert.equal(ok.outcome, 'resolved');
  } finally { r.cleanup(); }
});

test('guards: a resolution that does not parse, or that drops tests against both sides, is rejected', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'src/a.mjs': 'export const a = 1;\n' }, () => r.commit('base', { 'src/a.mjs': 'export const a = 2;\n' }), () => r.commit('pr', { 'src/a.mjs': 'export const a = 3;\n' }));
    const res = await mergeForward(input(r, baseSha, { callModel: async () => JSON.stringify({ resolutions: [{ index: 0, content: 'export const a = ;\n' }] }) }));
    assert.deepEqual([res.outcome, res.reason, res.blocked], ['escalated', 'syntax_error', ['src/a.mjs']]);
    const fine = await mergeForward(input(r, baseSha, { callModel: async () => JSON.stringify({ resolutions: [{ index: 0, content: 'export const a = 2;\nexport const b = 3;\n' }] }) }));
    assert.equal(fine.outcome, 'resolved', 'a combined resolution of two valid sides passes');
  } finally { r.cleanup(); }
  const r2 = repo();
  try {
    const tests = (...names) => `import { test } from 'node:test';\n${names.map((n) => `test('${n}', () => {});`).join('\n')}\n`;
    const baseSha = diverge(r2, { 'src/x.test.mjs': tests('a', 'b') },
      () => r2.commit('base', { 'src/x.test.mjs': tests('a2', 'b2') }), () => r2.commit('pr', { 'src/x.test.mjs': tests('a3', 'b3') }));
    const res = await mergeForward(input(r2, baseSha, { callModel: async () => JSON.stringify({ resolutions: [{ index: 0, content: "test('a2', () => {});\n" }] }) }));
    assert.deepEqual([res.outcome, res.reason], ['escalated', 'guard_rejected']);
    assert.ok(res.rules.includes('test_count_drop'));
  } finally { r2.cleanup(); }
});

test('guards: taking the base\'s own change is the merge doing its job, not a violation', async () => {
  const r = repo();
  try {
    const many = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const baseSha = diverge(r, { 'src/long.txt': many },
      () => r.commit('base trims the file and edits line 0', { 'src/long.txt': 'line 0 base\nline 1\n' }), () => r.commit('pr edits line 0', { 'src/long.txt': many.replace('line 0\n', 'line 0 pr\n') }));
    // The model takes the base side: against the head (60 lines) the file lost most of its lines, against the base it lost nothing.
    const res = await mergeForward(input(r, baseSha, { callModel: async () => JSON.stringify({ resolutions: [{ index: 0, content: 'line 0 base\n' }] }) }));
    assert.equal(res.outcome, 'resolved');
    assert.equal(r.read('src/long.txt'), 'line 0 base\nline 1\n');
  } finally { r.cleanup(); }
});

test('L1: the lockfile is regenerated from the merged manifest, never edited; a failing npm or a changed .npmrc escalates', async () => {
  const lock = (v) => JSON.stringify({ name: 'x', lockfileVersion: 3, v }) + '\n';
  const make = (r) => diverge(r, { 'package.json': '{"name":"x"}\n', 'package-lock.json': lock(0) },
    () => r.commit('base', { 'package-lock.json': lock(1) }), () => r.commit('pr', { 'package-lock.json': lock(2) }));
  const r = repo();
  try {
    const baseSha = make(r);
    const calls = [];
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel, runNpm: (cwd) => { calls.push(cwd); fs.writeFileSync(path.join(cwd, 'package-lock.json'), lock(9)); } }));
    assert.deepEqual([res.outcome, res.rung, res.files], ['resolved', 'L1', ['package-lock.json']]);
    assert.deepEqual(calls, [r.cwd]);
    assert.equal(r.read('package-lock.json'), lock(9));
    assert.ok(!/^[<>=]{7}/m.test(r.read('package-lock.json')));
  } finally { r.cleanup(); }
  const r2 = repo();
  try {
    const baseSha = make(r2);
    const res = await mergeForward(input(r2, baseSha, { runNpm: () => { throw new Error('registry down'); } }));
    assert.deepEqual([res.outcome, res.reason], ['escalated', 'lockfile_failed']);
    const bad = await mergeForward(input(r2, baseSha, { runNpm: (cwd) => fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{ not json') }));
    assert.deepEqual([bad.outcome, bad.reason], ['escalated', 'lockfile_failed'], 'a lockfile that does not parse is not committed');
    assert.equal(r2.git('status', '--porcelain'), '');
  } finally { r2.cleanup(); }
  const r3 = repo();
  try {
    r3.commit('base', { 'package.json': '{"name":"x"}\n', 'package-lock.json': lock(0), '.npmrc': '' });
    r3.git('checkout', '-q', '-b', 'pr');
    r3.commit('pr', { 'package-lock.json': lock(2), '.npmrc': 'registry=https://evil.example/\n' });
    r3.git('checkout', '-q', 'main');
    const baseSha = r3.commit('base', { 'package-lock.json': lock(1) });
    r3.git('checkout', '-q', 'pr');
    const res = await mergeForward(input(r3, baseSha, { runNpm: () => { throw new Error('must not run'); } }));
    assert.deepEqual([res.outcome, res.reason], ['escalated', 'lockfile_unsafe']);
  } finally { r3.cleanup(); }
});

test('runNpmLockOnly runs npm with no scripts, no user config and no token in its environment', () => {
  const r = repo();
  try {
    const bin = path.join(r.cwd, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$*" "$NPM_CONFIG_USERCONFIG" "${GITHUB_TOKEN:-unset}" > "$PWD/npm-call"\n', { mode: 0o755 });
    const savedPath = process.env.PATH; const savedToken = process.env.GITHUB_TOKEN;
    process.env.PATH = `${bin}:${savedPath}`; process.env.GITHUB_TOKEN = 'secret';
    try { runNpmLockOnly(r.cwd); } finally { process.env.PATH = savedPath; if (savedToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedToken; }
    assert.equal(r.read('npm-call'), 'install --package-lock-only --ignore-scripts --no-audit --no-fund\n/dev/null\nunset\n');
  } finally { r.cleanup(); }
});

test('ADR renumber: the base keeps its number, the PR\'s ADR takes the next free one, with the index line and the changelog entry it added', async () => {
  const r = repo();
  try {
    const index = (...lines) => `# ADRs\n\n## Records\n\n${lines.join('\n')}\n`;
    const adr = (n, t) => `# ADR-${n}: ${t}\n\n- **Status:** Proposed\n\nSee ADR-${n} itself.\n`;
    const baseSha = diverge(r,
      { 'docs/adr/README.md': index('- [ADR-0057: Old](./0057-old.md)'), 'docs/adr/0057-old.md': adr('0057', 'Old'), 'CHANGELOG.md': CL('- old') },
      () => r.commit('base adds 0058', { 'docs/adr/0058-base.md': adr('0058', 'Base'), 'docs/adr/README.md': index('- [ADR-0057: Old](./0057-old.md)', '- [ADR-0058: Base](./0058-base.md)'), 'CHANGELOG.md': CL('- base ADR-0058 entry', '- old') }),
      () => r.commit('pr adds 0058', { 'docs/adr/0058-pr.md': adr('0058', 'Mine'), 'docs/adr/README.md': index('- [ADR-0057: Old](./0057-old.md)', '- [ADR-0058: Mine](./0058-pr.md)'), 'CHANGELOG.md': CL('- pr ADR-0058 entry', '- old') }));
    const res = await mergeForward(input(r, baseSha));
    assert.equal(res.outcome, 'resolved');
    assert.deepEqual(res.renumbered, [{ from: '0058', to: '0059' }]);
    assert.ok(!r.exists('docs/adr/0058-pr.md'), 'the PR file moved');
    assert.equal(r.read('docs/adr/0059-pr.md'), adr('0059', 'Mine'), 'title and self references rewritten');
    assert.equal(r.read('docs/adr/0058-base.md'), adr('0058', 'Base'), 'the base\'s ADR is untouched');
    const idx = r.read('docs/adr/README.md');
    assert.ok(idx.includes('- [ADR-0058: Base](./0058-base.md)'));
    assert.ok(idx.includes('- [ADR-0059: Mine](./0059-pr.md)'));
    assert.ok(!idx.includes('0058-pr.md'));
    const log = r.read('CHANGELOG.md');
    assert.ok(log.includes('- base ADR-0058 entry'), 'the base\'s own entry keeps its number');
    assert.ok(log.includes('- pr ADR-0059 entry'), 'the PR\'s entry follows its ADR');
    assert.ok(res.files.includes('docs/adr/0059-pr.md'));
    assert.equal(r.git('status', '--porcelain'), '');
  } finally { r.cleanup(); }
});

test('ADR renumber without any textual conflict: two ADRs of the same number still collide in the merged tree', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'docs/adr/0057-old.md': '# ADR-0057: Old\n' },
      () => r.commit('base adds 0058', { 'docs/adr/0058-base.md': '# ADR-0058: Base\n' }), () => r.commit('pr adds 0058', { 'docs/adr/0058-pr.md': '# ADR-0058: Mine\n' }));
    const res = await mergeForward(input(r, baseSha, { callModel: refusingModel }));
    assert.deepEqual([res.outcome, res.rung, res.renumbered], ['resolved', 'L0', [{ from: '0058', to: '0059' }]]);
    assert.equal(r.read('docs/adr/0059-pr.md'), '# ADR-0059: Mine\n');
  } finally { r.cleanup(); }
});

test('an unexpected failure aborts the merge before it propagates', async () => {
  const r = repo();
  try {
    const baseSha = diverge(r, { 'CHANGELOG.md': CL('- b') }, () => r.commit('base', { 'CHANGELOG.md': CL('- t', '- b') }), () => r.commit('pr', { 'CHANGELOG.md': CL('- o', '- b') }));
    await assert.rejects(mergeForward(input(r, baseSha, { callModel: async () => { throw new Error('All providers failed'); } })), /All providers failed/);
    assert.equal(r.git('status', '--porcelain'), '', 'no half-merged tree is left behind');
  } finally { r.cleanup(); }
});
