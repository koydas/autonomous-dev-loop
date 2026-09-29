import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles, JsonParseError, PROTECTED_WRITE_PATHS } from '../lib/output_writer.mjs';

// parseJsonResponse tests

test('parseJsonResponse parses plain JSON', () => {
  const result = parseJsonResponse('{"summary":"fix","changes":[]}');
  assert.deepEqual(result, { summary: 'fix', changes: [] });
});

test('parseJsonResponse parses JSON wrapped in ```json fences', () => {
  const result = parseJsonResponse('```json\n{"summary":"fix","changes":[]}\n```');
  assert.deepEqual(result, { summary: 'fix', changes: [] });
});

test('parseJsonResponse parses JSON wrapped in plain ``` fences', () => {
  const result = parseJsonResponse('```\n{"summary":"fix","changes":[]}\n```');
  assert.deepEqual(result, { summary: 'fix', changes: [] });
});

test('parseJsonResponse extracts JSON when there is surrounding prose', () => {
  const result = parseJsonResponse('Here is the output:\n{"summary":"fix","changes":[]}\nDone.');
  assert.deepEqual(result, { summary: 'fix', changes: [] });
});

test('parseJsonResponse throws for completely non-JSON text', () => {
  assert.throws(() => parseJsonResponse('not json at all'), /not valid JSON/);
});

test('parseJsonResponse parses JSON wrapped in ```JSON (uppercase) fences', () => {
  const result = parseJsonResponse('```JSON\n{"summary":"fix","changes":[]}\n```');
  assert.deepEqual(result, { summary: 'fix', changes: [] });
});

test('parseJsonResponse parses JSON wrapped in ```Json (mixed-case) fences', () => {
  const result = parseJsonResponse('```Json\n{"summary":"fix","changes":[]}\n```');
  assert.deepEqual(result, { summary: 'fix', changes: [] });
});

test('parseJsonResponse throws JsonParseError (not generic Error) for invalid input', () => {
  assert.throws(
    () => parseJsonResponse('not json at all'),
    (err) => err instanceof JsonParseError,
  );
});

test('parseJsonResponse error includes all three strategy entries in parseErrors', () => {
  let caught;
  try {
    parseJsonResponse('not json at all');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof JsonParseError);
  assert.ok(caught.parseErrors.some((e) => e.startsWith('fenced parse:')));
  assert.ok(caught.parseErrors.some((e) => e.startsWith('direct parse:')));
  assert.ok(caught.parseErrors.some((e) => e.startsWith('slice parse:')));
});

test('parseJsonResponse error attaches raw input to JsonParseError.raw', () => {
  const input = 'totally not json';
  let caught;
  try {
    parseJsonResponse(input);
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.raw, input);
});

test('parseJsonResponse records direct parse error first, then fenced parse error', () => {
  let caught;
  try {
    parseJsonResponse('```json\nnot valid json\n```');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof JsonParseError);
  assert.match(caught.parseErrors[0], /^direct parse:/);
  assert.match(caught.parseErrors[1], /^fenced parse:/);
});

test('validateAiOutput returns trimmed fields for valid input', () => {
  const result = validateAiOutput({
    summary: '  Add docs update  ',
    changes: [{ target_path: 'docs/readme.md', file_content: '# Hello' }],
  });
  assert.equal(result.summary, 'Add docs update');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].targetPath, 'docs/readme.md');
  assert.equal(result.changes[0].fileContent, '# Hello');
});

test('validateAiOutput throws when summary is missing', () => {
  assert.throws(
    () => validateAiOutput({ summary: '', changes: [{ target_path: 'a.md', file_content: 'x' }] }),
    /missing non-empty summary/,
  );
});

test('validateAiOutput throws when changes is missing', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', changes: [] }),
    /missing non-empty changes array/,
  );
});

test('validateAiOutput throws when changes contains more than 6 files', () => {
  assert.throws(
    () => validateAiOutput({
      summary: 'ok',
      changes: [
        { target_path: 'a.md', file_content: 'x' },
        { target_path: 'b.md', file_content: 'x' },
        { target_path: 'c.md', file_content: 'x' },
        { target_path: 'd.md', file_content: 'x' },
        { target_path: 'e.md', file_content: 'x' },
        { target_path: 'f.md', file_content: 'x' },
        { target_path: 'g.md', file_content: 'x' },
      ],
    }),
    /too large/,
  );
});

test('validateAiOutput throws when target_path is missing', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', changes: [{ target_path: '', file_content: 'x' }] }),
    /missing non-empty target_path/,
  );
});

test('validateAiOutput throws when file_content is blank', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', changes: [{ target_path: 'a.md', file_content: '   ' }] }),
    /missing non-empty file_content/,
  );
});

test('validateAiOutput throws for absolute path', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', changes: [{ target_path: '/etc/passwd', file_content: 'x' }] }),
    /safe relative path/,
  );
});

test('validateAiOutput throws for path with ..', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', changes: [{ target_path: '../outside/file.md', file_content: 'x' }] }),
    /safe relative path/,
  );
});

test('validateAiOutput throws for embedded .. traversal', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', changes: [{ target_path: 'docs/../../etc/passwd', file_content: 'x' }] }),
    /safe relative path/,
  );
});

test('validateAiOutput throws when file_content exceeds 16000 chars', () => {
  assert.throws(
    () => validateAiOutput({ summary: 'ok', changes: [{ target_path: 'a.md', file_content: 'x'.repeat(16001) }] }),
    /too large/,
  );
});

test('validateAiOutput accepts file_content exactly at 16000 chars', () => {
  const result = validateAiOutput({
    summary: 'ok',
    changes: [{ target_path: 'a.md', file_content: 'x'.repeat(16000) }],
  });
  assert.equal(result.changes[0].fileContent.length, 16000);
});

test('validateAiOutput coerces non-string fields to strings', () => {
  const result = validateAiOutput({
    summary: 42,
    changes: [{ target_path: 'a.md', file_content: true }],
  });
  assert.equal(result.summary, '42');
  assert.equal(result.changes[0].fileContent, 'true');
});

test('validateAiOutput rejects duplicate target paths', () => {
  assert.throws(
    () => validateAiOutput({
      summary: 'ok',
      changes: [
        { target_path: 'a.md', file_content: '1' },
        { target_path: 'a.md', file_content: '2' },
      ],
    }),
    /duplicate target_path/,
  );
});

// writeGeneratedFiles tests

test('writeGeneratedFiles returns empty array for empty input', async () => {
  const paths = await writeGeneratedFiles([]);
  assert.deepEqual(paths, []);
});

test('writeGeneratedFiles writes a single flat file and returns its path', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const paths = await writeGeneratedFiles([{ targetPath: 'output.txt', fileContent: 'hello world' }]);
    assert.deepEqual(paths, ['output.txt']);
    const content = await fs.readFile(path.join(tmpDir, 'output.txt'), 'utf8');
    assert.equal(content, 'hello world');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('writeGeneratedFiles creates nested parent directories', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const paths = await writeGeneratedFiles([{ targetPath: 'src/lib/utils.js', fileContent: 'export {}' }]);
    assert.deepEqual(paths, ['src/lib/utils.js']);
    const content = await fs.readFile(path.join(tmpDir, 'src/lib/utils.js'), 'utf8');
    assert.equal(content, 'export {}');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('writeGeneratedFiles writes correct content for each file in a batch', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    await writeGeneratedFiles([
      { targetPath: 'alpha.txt', fileContent: 'alpha content' },
      { targetPath: 'beta.txt', fileContent: 'beta content' },
    ]);
    assert.equal(await fs.readFile(path.join(tmpDir, 'alpha.txt'), 'utf8'), 'alpha content');
    assert.equal(await fs.readFile(path.join(tmpDir, 'beta.txt'), 'utf8'), 'beta content');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('writeGeneratedFiles returns all written paths in order', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const paths = await writeGeneratedFiles([
      { targetPath: 'a.txt', fileContent: 'a' },
      { targetPath: 'b.txt', fileContent: 'b' },
      { targetPath: 'sub/c.txt', fileContent: 'c' },
    ]);
    assert.deepEqual(paths, ['a.txt', 'b.txt', 'sub/c.txt']);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('writeGeneratedFiles overwrites an existing file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'old content');
    await writeGeneratedFiles([{ targetPath: 'existing.txt', fileContent: 'new content' }]);
    const content = await fs.readFile(path.join(tmpDir, 'existing.txt'), 'utf8');
    assert.equal(content, 'new content');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

// Protected write-path denylist (ADR-0021)

function changeAt(targetPath) {
  return { summary: 'ok', changes: [{ target_path: targetPath, file_content: 'x' }] };
}

test('PROTECTED_WRITE_PATHS exports every required prefix and file', () => {
  for (const entry of ['.github/', 'scripts/', 'config/', 'prompts/', 'checkpoints/', 'metrics/', 'observability/',
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.npmrc', '.yarnrc', '.yarnrc.yml']) {
    assert.ok(PROTECTED_WRITE_PATHS.includes(entry), `missing ${entry}`);
  }
  assert.ok(Object.isFrozen(PROTECTED_WRITE_PATHS), 'denylist must be immutable');
});

for (const target of [
  '.github/workflows/ci.yml',
  '.github/actions/setup/action.yml',
  '.github/CODEOWNERS',
  'scripts/auto_fix_pr.mjs',
  'scripts/lib/output_writer.mjs',
  'config/models.yaml',
  'prompts/generation-system.md',
]) {
  test(`validateAiOutput rejects protected prefix target_path ${target}`, () => {
    assert.throws(() => validateAiOutput(changeAt(target)), /protected path/);
  });
}

for (const target of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'packages/app/package.json', 'web/yarn.lock']) {
  test(`validateAiOutput rejects protected manifest/lock file ${target}`, () => {
    assert.throws(() => validateAiOutput(changeAt(target)), /protected path/);
  });
}

for (const target of [
  './.github/workflows/ci.yml',
  '././.github/workflows/ci.yml',
  '.\\.github\\workflows\\ci.yml',
  '.github\\workflows\\ci.yml',
  '.GITHUB/workflows/ci.yml',
  '.GitHub/Workflows/ci.yml',
  '.github//workflows/ci.yml',
  '.github/./workflows/ci.yml',
  '  .github/workflows/ci.yml  ',
  '.github',
  'Scripts/lib/x.mjs',
  'scripts\\lib\\x.mjs',
  './config/./labels.yaml',
  'PROMPTS/auto-fix-system.md',
  'PACKAGE.JSON',
  './Package-Lock.json',
]) {
  test(`validateAiOutput rejects normalization bypass ${JSON.stringify(target)}`, () => {
    assert.throws(() => validateAiOutput(changeAt(target)), /protected path/);
  });
}

for (const target of ['src/config.js', 'docs/scripts/readme.md', 'scriptsx/a.js', 'githubstuff/a.md', 'src/.github-notes.md', 'package.json.md', 'docs/package-json.md']) {
  test(`validateAiOutput accepts non-protected target_path ${target}`, () => {
    const result = validateAiOutput(changeAt(target));
    assert.equal(result.changes[0].targetPath, target);
  });
}

test('validateAiOutput rejects the whole batch when one change targets a protected path', () => {
  assert.throws(
    () => validateAiOutput({
      summary: 'ok',
      changes: [
        { target_path: 'src/a.js', file_content: '1' },
        { target_path: '.github/workflows/pwn.yml', file_content: '2' },
      ],
    }),
    /changes\[1\].*protected path/,
  );
});

// Pipeline state lives in the same working tree the model writes to: checkpoints are
// uploaded as artifacts and metrics/runs.jsonl is PUT to the default branch by
// "Commit metrics"; npm/yarn rc files redirect the registry used by `npx` in CI.
for (const target of [
  'checkpoints/pr-55/review.json',
  './Checkpoints/issue-1/validate.json',
  'metrics/runs.jsonl',
  'metrics\\runs.jsonl',
  'observability/traces/1.json',
  '.npmrc',
  'sub/.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
]) {
  test(`validateAiOutput rejects pipeline-state / registry-config target_path ${JSON.stringify(target)}`, () => {
    assert.throws(() => validateAiOutput(changeAt(target)), /protected path/);
  });
}
