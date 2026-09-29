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

// Workflows whose jobs push commits or mutate labels/comments: a run must never be
// cancelled halfway, so they queue (cancel-in-progress: false) instead.
const MUTATING_WORKFLOWS = ['auto-fix-pr.yml', 'pr-review.yml', 'code-generation.yml', 'validate-issue.yml', 'reset-auto-fix.yml'];
// Triggers fire for unrelated labels/comments too; a workflow-level group would let a
// skipped run replace the pending real one, so the group must sit on the gated job.
const JOB_LEVEL_CONCURRENCY = ['auto-fix-pr.yml', 'code-generation.yml'];

test('every workflow declares a concurrency group keyed per PR/issue', () => {
  const workflows = readWorkflows();
  assert.equal(workflows.length, 7, `expected 7 workflows, found ${workflows.map((w) => w.name).join(', ')}`);
  for (const { name, text } of workflows) {
    const groups = [...text.matchAll(/^\s*concurrency:\s*\n\s+group:\s*(.+)$/gm)].map((m) => m[1]);
    assert.equal(groups.length, 1, `${name} must declare exactly one concurrency group`);
    assert.match(groups[0], /\$\{\{.*(number|ref).*\}\}/, `${name} concurrency group must be keyed per PR/issue`);
  }
});

test('mutating workflows never cancel an in-progress run', () => {
  for (const { name, text } of readWorkflows()) {
    const cancel = text.match(/^\s+cancel-in-progress:\s*(\S+)/m)?.[1];
    if (MUTATING_WORKFLOWS.includes(name)) {
      assert.equal(cancel, 'false', `${name} pushes or mutates labels and must use cancel-in-progress: false`);
    } else {
      assert.ok(cancel === 'true' || cancel === 'false', `${name} must set cancel-in-progress explicitly`);
    }
  }
});

test('auto-fix-pr.yml concurrency group handles both pull_request.number and issue.number', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'auto-fix-pr.yml'), 'utf8');
  const group = text.match(/^\s*concurrency:\s*\n\s+group:\s*(.+)$/m)?.[1] ?? '';
  assert.match(group, /github\.event\.pull_request\.number/);
  assert.match(group, /github\.event\.issue\.number/);
});

test('label/comment-triggered mutating workflows scope concurrency to the gated job', () => {
  for (const name of JOB_LEVEL_CONCURRENCY) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.ok(!/^concurrency:/m.test(text), `${name} must not declare workflow-level concurrency`);
    assert.match(text, /^    concurrency:/m, `${name} must declare job-level concurrency`);
  }
});

test('auto-fix-pr.yml does not write the raw multi-line PR payload to GITHUB_OUTPUT', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'auto-fix-pr.yml'), 'utf8');
  // Multi-line JSON written as `name=value` without a heredoc delimiter breaks the step.
  assert.ok(!/echo\s+"payload=\$\{?PAYLOAD\}?"\s*>>\s*"\$GITHUB_OUTPUT"/.test(text), 'payload must not be echoed to GITHUB_OUTPUT');
  assert.match(text, /echo "head_ref=\$\(echo "\$\{PAYLOAD\}" \| jq -r '\.head\.ref'\)" >> "\$GITHUB_OUTPUT"/, 'head_ref output must remain');
});
