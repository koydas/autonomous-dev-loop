import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/test.yml'), 'utf8');

const GATED_MODULES = ['checkpoint.mjs', 'config.mjs', 'llm_client.mjs', 'output_writer.mjs'];

test('test.yml enforces c8 coverage for all four critical modules', () => {
  for (const mod of GATED_MODULES) {
    assert.ok(workflow.includes(`scripts/lib/${mod}`), `Missing coverage gate for ${mod}`);
  }
});

test('test.yml uses --check-coverage for each gated module', () => {
  const gateCount = (workflow.match(/--check-coverage/g) || []).length;
  assert.equal(gateCount, GATED_MODULES.length,
    `Expected ${GATED_MODULES.length} --check-coverage flags, found ${gateCount}`);
});

test('test.yml sets 80% threshold on all four dimensions for each gate', () => {
  for (const flag of ['--lines 80', '--branches 80', '--functions 80', '--statements 80']) {
    const count = (workflow.match(new RegExp(flag.replace(' ', '\\s+'), 'g')) || []).length;
    assert.equal(count, GATED_MODULES.length,
      `Expected ${GATED_MODULES.length} occurrences of "${flag}", found ${count}`);
  }
});

test('test.yml pairs each coverage gate with its dedicated test file', () => {
  const pairs = [
    ['checkpoint.mjs', 'checkpoint.test.mjs'],
    ['config.mjs', 'config.test.mjs'],
    ['llm_client.mjs', 'llm_client.test.mjs'],
    ['output_writer.mjs', 'output_writer.test.mjs'],
  ];
  for (const [lib, testFile] of pairs) {
    assert.ok(workflow.includes(`scripts/lib/${lib}`), `Missing lib reference: ${lib}`);
    assert.ok(workflow.includes(`scripts/tests/${testFile}`), `Missing test reference: ${testFile}`);
  }
});

const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');
const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

function readWorkflows() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ name: f, text: readFileSync(resolve(WORKFLOWS_DIR, f), 'utf8') }));
}

test('every issue_comment-triggered workflow gates on trusted comment author_association', () => {
  const commentWorkflows = readWorkflows().filter(({ text }) => /^\s+issue_comment:/m.test(text));
  assert.ok(commentWorkflows.length > 0, 'expected at least one issue_comment workflow (auto-fix-pr.yml)');
  for (const { name, text } of commentWorkflows) {
    assert.match(text, /github\.event\.comment\.author_association/, `${name} must check comment author_association`);
    for (const assoc of TRUSTED_ASSOCIATIONS) {
      assert.ok(text.includes(`"${assoc}"`), `${name} must allow-list ${assoc}`);
    }
    assert.ok(!/"(CONTRIBUTOR|FIRST_TIME_CONTRIBUTOR|FIRST_TIMER|NONE|MANNEQUIN)"/.test(text), `${name} must not trust non-member associations`);
  }
});
