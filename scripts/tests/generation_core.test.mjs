import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGenerationContext, parseGenerationResponse, decideGeneration, findGeneratedViolations } from '../lib/generation_core.mjs';
import { GuardrailError } from '../lib/output_writer.mjs';
import { BLOCKED_SOURCES } from '../lib/generation_blocked.mjs';

let root;

const write = async (rel, content) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
};

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-core-'));
  await write('package.json', '{"type":"module","dependencies":{}}\n');
  await write('src/customers.mjs', 'export function find(list, id) {\n  return list.find((c) => c.id === id).name;\n}\n');
  await write('src/legacy.mjs', 'export const legacy = 1;\n');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const config = (over = {}) => ({ issueNumber: '7', issueTitle: 'Guard missing customer in src/customers.mjs', issueBody: 'find() throws on an unknown id', ...over });
const answer = (changes, extra = {}) => ({ summary: 'Guards the lookup', changes, ...extra });
const change = (target_path, file_content) => ({ target_path, file_content });

test('buildGenerationContext reads the files the issue names from the given root, and shows them to the model', async () => {
  const ctx = await buildGenerationContext({ config: config(), root });
  assert.ok(ctx.fileContext.shownPaths.has('src/customers.mjs'));
  assert.ok(!ctx.fileContext.shownPaths.has('src/legacy.mjs'));
  assert.match(ctx.prompt, /src\/customers\.mjs/);
  assert.match(ctx.prompt, /find\(list, id\)/);
  assert.ok(ctx.systemPrompt.length > 0);
  assert.equal(ctx.deterministicBlock, null);
  assert.deepEqual(Object.keys(ctx.dependencies ?? {}).length >= 0, true);
});

test('buildGenerationContext resolves fileExists against the root, not the working directory', async () => {
  const ctx = await buildGenerationContext({ config: config(), root });
  assert.equal(ctx.fileExists('src/legacy.mjs'), true);
  assert.equal(ctx.fileExists('src/absent.mjs'), false);
  assert.equal(ctx.fileExists('scripts/generate_issue_change.mjs'), false);
});

test('buildGenerationContext: an issue whose every needed file is protected has a deterministic block', async () => {
  const ctx = await buildGenerationContext({ config: config({ issueTitle: 'Change .github/workflows/test.yml', issueBody: 'edit .github/workflows/test.yml' }), root });
  assert.ok(ctx.deterministicBlock, 'protected path blocks before the LLM call');
  assert.ok(ctx.deterministicBlock.paths.length > 0);
});

test('parseGenerationResponse: an object passes, fenced JSON too; anything else fails with its kind', () => {
  assert.deepEqual(parseGenerationResponse('{"summary":"s"}'), { summary: 's' });
  assert.deepEqual(parseGenerationResponse('```json\n{"summary":"s"}\n```'), { summary: 's' });
  for (const bad of ['not json', '{"summary":', '']) {
    assert.throws(() => parseGenerationResponse(bad), (e) => e.kind === 'json' && e.message === 'AI response was not valid JSON' && e.cause instanceof Error, bad);
  }
  for (const bad of ['[1,2]', 'null', '"text"', '42']) {
    assert.throws(() => parseGenerationResponse(bad), (e) => e.kind === 'shape' && e.message === 'AI response JSON must be an object', bad);
  }
});

test('decideGeneration: a valid answer yields summary and normalized changes, not blocked', async () => {
  const context = await buildGenerationContext({ config: config(), root });
  const d = decideGeneration({ aiOutput: answer([change('src/customers.mjs', 'export const x = 1;\n')]), context, labels: ['bug'] });
  assert.equal(d.blocked, null);
  assert.equal(d.summary, 'Guards the lookup');
  assert.deepEqual(d.changes.map((c) => c.targetPath), ['src/customers.mjs']);
});

test('decideGeneration: the model signal, the deterministic block and a notes-only patch for a bug are blocked, with their source', async () => {
  const context = await buildGenerationContext({ config: config(), root });
  const model = decideGeneration({ aiOutput: answer([change('src/customers.mjs', 'x')], { blocked: true, blocked_reason: 'depends on an unmerged PR' }), context });
  assert.equal(model.blocked?.source, BLOCKED_SOURCES.MODEL);
  const notes = decideGeneration({ aiOutput: answer([change('notes/plan.md', '# plan\n')]), context, labels: ['bug'] });
  assert.equal(notes.blocked?.source, BLOCKED_SOURCES.NOTES_ONLY);
  const protectedCtx = await buildGenerationContext({ config: config({ issueTitle: 'Change .github/workflows/test.yml', issueBody: 'edit .github/workflows/test.yml' }), root });
  const denied = decideGeneration({ aiOutput: answer([change('src/customers.mjs', 'x')]), context: protectedCtx });
  assert.equal(denied.blocked?.source, BLOCKED_SOURCES.DENYLIST);
});

test('decideGeneration: a malformed answer and a protected target path throw, as validateAiOutput does', async () => {
  const context = await buildGenerationContext({ config: config(), root });
  assert.throws(() => decideGeneration({ aiOutput: { changes: [] }, context }), /missing non-empty summary/);
  assert.throws(() => decideGeneration({ aiOutput: answer([]), context }), /non-empty changes array/);
  assert.throws(() => decideGeneration({ aiOutput: answer([change('.github/workflows/test.yml', 'x')]), context }), (e) => e instanceof GuardrailError);
});

test('findGeneratedViolations: the file the issue showed can change, an unshown existing file and a require() in .mjs cannot', async () => {
  const cfg = config();
  const context = await buildGenerationContext({ config: cfg, root });
  const ok = await findGeneratedViolations({ changes: [{ targetPath: 'src/customers.mjs', fileContent: 'export function find(list, id) {\n  return list.find((c) => c.id === id)?.name ?? null;\n}\n' }], context, config: cfg, root });
  assert.deepEqual(ok, []);
  const unshown = await findGeneratedViolations({ changes: [{ targetPath: 'src/legacy.mjs', fileContent: 'export const legacy = 2;\n' }], context, config: cfg, root });
  assert.deepEqual(unshown.map((v) => v.rule), ['unshown_file']);
  const cjs = await findGeneratedViolations({ changes: [{ targetPath: 'src/fresh.mjs', fileContent: "const fs = require('fs');\nexport const x = fs;\n" }], context, config: cfg, root });
  assert.ok(cjs.some((v) => v.rule === 'module_system'));
});

test('findGeneratedViolations reads existing files from the root: a new file is not an existing one, any other read error is thrown', async () => {
  const cfg = config();
  const context = await buildGenerationContext({ config: cfg, root });
  const fresh = await findGeneratedViolations({ changes: [{ targetPath: 'src/brand-new.mjs', fileContent: 'export const n = 1;\n' }], context, config: cfg, root });
  assert.deepEqual(fresh, []);
  // A path through a regular file is not "missing": the read fails with ENOTDIR and the failure is not swallowed.
  await assert.rejects(findGeneratedViolations({ changes: [{ targetPath: 'src/customers.mjs/inner.mjs', fileContent: 'x' }], context, config: cfg, root }), (e) => e.code === 'ENOTDIR');
});
