import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  parseEvidenceConfig,
  sanitizeEnv,
  tailOutput,
  runCheck,
  buildEvidence,
  parseEvidence,
  isEvidenceConfigTouched,
  assessEvidence,
  formatEvidenceContext,
  formatEvidenceSection,
  DEFAULT_TIMEOUT_SECONDS,
  EVIDENCE_SCHEMA_VERSION,
} from '../lib/review_evidence.mjs';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function evidenceJson(checks, headSha = SHA) {
  return JSON.stringify(buildEvidence({ headSha, results: checks, generatedAt: '2026-10-01T00:00:00Z' }));
}

const PASS = { name: 'tests', command: 'npm test', status: 'pass', exit_code: 0, duration_ms: 10, output_tail: 'ok' };
const FAIL = { name: 'lint', command: 'npm run lint', status: 'fail', exit_code: 1, duration_ms: 5, output_tail: 'SyntaxError: boom' };
const TIMEOUT = { name: 'slow', command: 'sleep 999', status: 'timeout', exit_code: null, duration_ms: 1000, output_tail: 'Timed out' };

// --- parseEvidenceConfig ---

test('parseEvidenceConfig: parses checks in declaration order with timeouts', () => {
  const checks = parseEvidenceConfig('checks:\n  tests:\n    command: npm test\n    timeout_seconds: 120\n  lint:\n    command: npm run lint\n');
  assert.deepEqual(checks, [
    { name: 'tests', command: 'npm test', timeoutMs: 120000 },
    { name: 'lint', command: 'npm run lint', timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000 },
  ]);
});

test('parseEvidenceConfig: throws when checks section is absent', () => {
  assert.throws(() => parseEvidenceConfig('other:\n  x:\n    command: y\n'), /at least one check under `checks`/);
});

test('parseEvidenceConfig: throws on empty or undefined content', () => {
  assert.throws(() => parseEvidenceConfig(''), /at least one check/);
  assert.throws(() => parseEvidenceConfig(undefined), /at least one check/);
});

test('parseEvidenceConfig: throws with field path when command is missing', () => {
  assert.throws(
    () => parseEvidenceConfig('checks:\n  tests:\n    timeout_seconds: 10\n'),
    /checks\.tests\.command/,
  );
});

test('parseEvidenceConfig: rejects non-positive or non-integer timeout_seconds', () => {
  for (const bad of ['0', '-5', 'abc', '1.5']) {
    assert.throws(
      () => parseEvidenceConfig(`checks:\n  tests:\n    command: npm test\n    timeout_seconds: ${bad}\n`),
      /checks\.tests\.timeout_seconds must be a positive integer/,
      `expected rejection for ${bad}`,
    );
  }
});

// --- sanitizeEnv ---

test('sanitizeEnv: drops credential-like variables and keeps the rest', () => {
  const env = sanitizeEnv({
    PATH: '/bin',
    GITHUB_TOKEN: 't',
    ANTHROPIC_API_KEY: 'k',
    MY_SECRET: 's',
    DB_PASSWORD: 'p',
    AWS_CREDENTIALS: 'c',
    NODE_ENV: 'test',
  });
  assert.deepEqual(env, { PATH: '/bin', NODE_ENV: 'test' });
});

test('sanitizeEnv: drops the whole env-injected git config family, not only KEY_n', () => {
  const env = sanitizeEnv({
    PATH: '/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic xyz',
    GIT_AUTHOR_NAME: 'bot',
  });
  assert.deepEqual(env, { PATH: '/bin', GIT_AUTHOR_NAME: 'bot' });
});

test('sanitizeEnv: tolerates undefined input', () => {
  assert.deepEqual(sanitizeEnv(undefined), {});
});

// --- tailOutput ---

test('tailOutput: returns short output unchanged', () => {
  assert.equal(tailOutput('hello', 10), 'hello');
});

test('tailOutput: keeps only the last maxChars characters with a truncation marker', () => {
  const out = tailOutput('0123456789', 4);
  assert.equal(out, '…(truncated)\n6789');
});

test('tailOutput: strips ANSI escape sequences', () => {
  assert.equal(tailOutput('\x1b[31mred\x1b[0m text'), 'red text');
});

test('tailOutput: tolerates null', () => {
  assert.equal(tailOutput(null), '');
});

// --- runCheck ---

test('runCheck: exit 0 resolves to pass with captured output', async () => {
  const r = await runCheck({ name: 'ok', command: 'echo hello', timeoutMs: 5000 });
  assert.equal(r.status, 'pass');
  assert.equal(r.exit_code, 0);
  assert.match(r.output_tail, /hello/);
  assert.equal(r.name, 'ok');
  assert.equal(r.command, 'echo hello');
  assert.ok(r.duration_ms >= 0);
});

test('runCheck: non-zero exit resolves to fail with exit code and stderr', async () => {
  const r = await runCheck({ name: 'bad', command: 'echo broken >&2; exit 3', timeoutMs: 5000 });
  assert.equal(r.status, 'fail');
  assert.equal(r.exit_code, 3);
  assert.match(r.output_tail, /broken/);
});

test('runCheck: exceeding the timeout resolves to timeout', async () => {
  const r = await runCheck({ name: 'slow', command: 'sleep 5', timeoutMs: 200 });
  assert.equal(r.status, 'timeout');
  assert.match(r.output_tail, /Timed out after 0.2s/);
});

test('runCheck: credential env vars are not visible to the check', async () => {
  const r = await runCheck(
    { name: 'env', command: 'echo "token=[$GITHUB_TOKEN] path=[${PATH:+set}]"', timeoutMs: 5000 },
    { env: { PATH: process.env.PATH, GITHUB_TOKEN: 'leak-me' } },
  );
  assert.equal(r.status, 'pass');
  assert.match(r.output_tail, /token=\[\] path=\[set\]/);
});

test('runCheck: synchronous spawn failure resolves to error', async () => {
  const spawnFn = () => {
    throw new Error('spawn EACCES');
  };
  const r = await runCheck({ name: 'x', command: 'x', timeoutMs: 5000 }, { spawnFn });
  assert.equal(r.status, 'error');
  assert.equal(r.exit_code, null);
  assert.match(r.output_tail, /spawn EACCES/);
});

test('runCheck: asynchronous child error event resolves to error', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('error', new Error('ENOENT bash')));
    return child;
  };
  const r = await runCheck({ name: 'x', command: 'x', timeoutMs: 5000 }, { spawnFn });
  assert.equal(r.status, 'error');
  assert.match(r.output_tail, /ENOENT bash/);
});

// --- buildEvidence / parseEvidence ---

test('buildEvidence: produces a versioned document', () => {
  const e = buildEvidence({ headSha: SHA, results: [PASS], generatedAt: 't' });
  assert.deepEqual(e, { version: EVIDENCE_SCHEMA_VERSION, head_sha: SHA, generated_at: 't', checks: [PASS] });
});

test('parseEvidence: accepts a valid document', () => {
  const r = parseEvidence(evidenceJson([PASS, FAIL]));
  assert.equal(r.ok, true);
  assert.equal(r.evidence.checks.length, 2);
});

test('parseEvidence: rejects invalid JSON', () => {
  const r = parseEvidence('{not json');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not valid JSON/);
});

test('parseEvidence: rejects non-object JSON', () => {
  for (const raw of ['null', '[]', '"x"']) {
    const r = parseEvidence(raw);
    assert.equal(r.ok, false, raw);
    assert.match(r.reason, /not a JSON object/);
  }
});

test('parseEvidence: rejects unsupported version', () => {
  const r = parseEvidence(JSON.stringify({ version: 99, head_sha: SHA, checks: [] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported evidence version: 99/);
});

test('parseEvidence: rejects missing head_sha', () => {
  const r = parseEvidence(JSON.stringify({ version: 1, checks: [] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /head_sha/);
});

test('parseEvidence: rejects missing checks array', () => {
  const r = parseEvidence(JSON.stringify({ version: 1, head_sha: SHA }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /checks/);
});

test('parseEvidence: rejects an entry with an unknown status', () => {
  const r = parseEvidence(evidenceJson([PASS, { name: 'x', status: 'maybe' }]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /checks\[1\]/);
});

// --- isEvidenceConfigTouched ---

test('isEvidenceConfigTouched: detects a modified evidence config', () => {
  const diff = 'diff --git a/config/review-evidence.yaml b/config/review-evidence.yaml\n--- a/config/review-evidence.yaml\n+++ b/config/review-evidence.yaml\n';
  assert.equal(isEvidenceConfigTouched(diff), true);
});

test('isEvidenceConfigTouched: detects a newly added evidence config', () => {
  const diff = '--- /dev/null\n+++ b/config/review-evidence.yaml\n';
  assert.equal(isEvidenceConfigTouched(diff), true);
});

test('isEvidenceConfigTouched: ignores other files and empty diffs', () => {
  assert.equal(isEvidenceConfigTouched('diff --git a/config/models.yaml b/config/models.yaml\n'), false);
  assert.equal(isEvidenceConfigTouched('+ mentions config/review-evidence.yaml in a line\n'), false);
  assert.equal(isEvidenceConfigTouched(undefined), false);
});

// --- assessEvidence ---

test('assessEvidence: failed parse is missing with its reason', () => {
  const a = assessEvidence({ ok: false, reason: 'no evidence file at x' }, { prHeadSha: SHA });
  assert.equal(a.state, 'missing');
  assert.equal(a.reason, 'no evidence file at x');
  assert.deepEqual(a.failing, []);
});

test('assessEvidence: undefined parse result is missing', () => {
  assert.equal(assessEvidence(undefined).state, 'missing');
});

test('assessEvidence: head mismatch is stale, never failing', () => {
  const a = assessEvidence(parseEvidence(evidenceJson([FAIL])), { prHeadSha: OTHER_SHA });
  assert.equal(a.state, 'stale');
  assert.deepEqual(a.failing, []);
  assert.deepEqual(a.unverified, ['lint']);
  assert.match(a.reason, /aaaaaaa.*bbbbbbb/);
});

test('assessEvidence: available splits failing from unverified', () => {
  const a = assessEvidence(parseEvidence(evidenceJson([PASS, FAIL, TIMEOUT])), { prHeadSha: SHA });
  assert.equal(a.state, 'available');
  assert.deepEqual(a.failing, ['lint']);
  assert.deepEqual(a.unverified, ['slow']);
});

test('assessEvidence: without a PR head SHA the evidence is used as-is', () => {
  const a = assessEvidence(parseEvidence(evidenceJson([FAIL])));
  assert.equal(a.state, 'available');
  assert.deepEqual(a.failing, ['lint']);
});

// --- formatEvidenceContext ---

test('formatEvidenceContext: missing evidence tells the model nothing is verified', () => {
  const ctx = formatEvidenceContext(assessEvidence({ ok: false, reason: 'gone' }));
  assert.match(ctx, /## Tool evidence/);
  assert.match(ctx, /No usable tool evidence \(missing: gone\)/);
});

test('formatEvidenceContext: lists results and the output tail of failing checks only', () => {
  const ctx = formatEvidenceContext(assessEvidence(parseEvidence(evidenceJson([PASS, FAIL])), { prHeadSha: SHA }));
  assert.match(ctx, /tests \(`npm test`\): PASS \(exit 0\)/);
  assert.match(ctx, /lint \(`npm run lint`\): FAIL \(exit 1\)/);
  assert.match(ctx, /SyntaxError: boom/);
  assert.doesNotMatch(ctx, /Output tail of failing check `tests`/);
});

test('formatEvidenceContext: flags a self-modified evidence config', () => {
  const ctx = formatEvidenceContext(assessEvidence(parseEvidence(evidenceJson([PASS])), { configTouched: true }));
  assert.match(ctx, /not authoritative/);
});

// --- formatEvidenceSection ---

test('formatEvidenceSection: missing evidence renders a notice', () => {
  const s = formatEvidenceSection(assessEvidence({ ok: false, reason: 'gone' }));
  assert.match(s, /### 🧪 Tool Evidence/);
  assert.match(s, /No usable tool evidence — missing: gone/);
});

test('formatEvidenceSection: renders a table and collapsible output for failures', () => {
  const s = formatEvidenceSection(assessEvidence(parseEvidence(evidenceJson([PASS, FAIL, TIMEOUT]))));
  assert.match(s, /\| tests \| `npm test` \| PASS \(exit 0\) \|/);
  assert.match(s, /\| lint \| `npm run lint` \| FAIL \(exit 1\) \|/);
  assert.match(s, /\| slow \| `sleep 999` \| TIMEOUT \|/);
  assert.match(s, /<summary>Output tail — lint<\/summary>/);
  assert.doesNotMatch(s, /Verdict overridden/);
});

test('formatEvidenceSection: states the override and the config warning', () => {
  const s = formatEvidenceSection(
    assessEvidence(parseEvidence(evidenceJson([FAIL])), { configTouched: true }),
    { overridden: true },
  );
  assert.match(s, /Verdict overridden to REQUEST_CHANGES\*\* — failing checks: lint/);
  assert.match(s, /⚠️ .*not authoritative/);
});

// --- run_review_evidence.mjs entrypoint ---

async function makeGitRepo(configContent) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-evidence-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  if (configContent !== null) await fs.writeFile(path.join(dir, 'evidence.yaml'), configContent);
  return dir;
}

function runEntrypoint(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, 'run_review_evidence.mjs')], {
      cwd,
      env: { PATH: process.env.PATH, REVIEW_EVIDENCE_CONFIG: 'evidence.yaml', GITHUB_RUN_ID: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('run_review_evidence: writes evidence for HEAD and exits 0 even when a check fails', async () => {
  const dir = await makeGitRepo('checks:\n  ok:\n    command: echo fine\n  bad:\n    command: exit 4\n');
  try {
    const { code, stderr } = await runEntrypoint(dir);
    assert.equal(code, 0, stderr);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const parsed = parseEvidence(await fs.readFile(path.join(dir, 'evidence', 'review-evidence.json'), 'utf8'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.evidence.head_sha, head);
    assert.deepEqual(parsed.evidence.checks.map((c) => [c.name, c.status, c.exit_code]), [['ok', 'pass', 0], ['bad', 'fail', 4]]);
    assert.match(stderr, /review_evidence\.complete/);
    await fs.access(path.join(dir, 'observability', 'traces', 'test-evidence.json'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_review_evidence: exits 1 when the config file is missing', async () => {
  const dir = await makeGitRepo(null);
  try {
    const { code, stderr } = await runEntrypoint(dir);
    assert.equal(code, 1);
    assert.match(stderr, /Review evidence config not found: evidence\.yaml/);
    assert.match(stderr, /review_evidence\.error/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_review_evidence: exits 1 when the config is invalid', async () => {
  const dir = await makeGitRepo('checks:\n  tests:\n    timeout_seconds: 5\n');
  try {
    const { code, stderr } = await runEntrypoint(dir);
    assert.equal(code, 1);
    assert.match(stderr, /checks\.tests\.command/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
