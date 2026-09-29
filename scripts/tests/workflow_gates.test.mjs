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

test('auto-fix-pr.yml concurrency group handles both pull_request and issue_comment events', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'auto-fix-pr.yml'), 'utf8');
  const group = text.match(/^\s*concurrency:\s*\n\s+group:\s*(.+)$/m)?.[1] ?? '';
  // pull_request carries the head ref; issue_comment does not, so load-labels resolves it.
  assert.match(group, /github\.event\.pull_request\.head\.ref/);
  assert.match(group, /needs\.load-labels\.outputs\.head_ref/);
  const loadLabels = text.slice(text.indexOf('  load-labels:'), text.indexOf('\n  auto-fix:'));
  assert.match(loadLabels, /head_ref: \$\{\{ steps\.head\.outputs\.ref \}\}/);
  assert.match(loadLabels, /github\.event\.issue\.pull_request\.url/);
});

// ADR-0020 (amended): the three workflows that read/write a PR's review and attempt labels
// serialize on one group per PR head branch (the only key available to push events).
test('pr-review, auto-fix-pr and reset-auto-fix share one per-PR concurrency group', () => {
  const expected = {
    'pr-review.yml': /^pr-pipeline-\$\{\{ github\.event\.pull_request\.head\.ref \|\| github\.ref_name \}\}$/,
    'auto-fix-pr.yml': /^pr-pipeline-\$\{\{ github\.event\.pull_request\.head\.ref \|\| needs\.load-labels\.outputs\.head_ref \}\}$/,
    'reset-auto-fix.yml': /^pr-pipeline-\$\{\{ needs\.resolve\.outputs\.head_ref \}\}$/,
  };
  for (const [name, pattern] of Object.entries(expected)) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    const group = text.match(/^\s*concurrency:\s*\n\s+group:\s*(.+)$/m)?.[1]?.trim() ?? '';
    assert.match(group, pattern, `${name} group was ${group}`);
  }
  const reset = readFileSync(resolve(WORKFLOWS_DIR, 'reset-auto-fix.yml'), 'utf8');
  assert.match(reset, /needs: resolve/);
  assert.ok(!/^concurrency:/m.test(reset), 'reset-auto-fix group must be job-level (it needs the resolved head ref)');
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

// ADR-0021: the model writes into the checkout, so metrics committed to the default
// branch must come from a file outside it, never from the working-tree metrics/runs.jsonl.
test('workflows that commit metrics read them from $RUNNER_TEMP, not the checkout', () => {
  const committing = readWorkflows().filter(({ text }) => text.includes('name: Commit metrics'));
  assert.deepEqual(committing.map((w) => w.name).sort(), ['auto-fix-pr.yml', 'pr-review.yml', 'validate-issue.yml']);
  for (const { name, text } of committing) {
    assert.ok(!/(wc -l|tail|cat)[^\n]*metrics\/runs\.jsonl/.test(text), `${name} must not read the working-tree metrics file`);
    const envLines = text.match(/METRICS_FILE: \$\{\{ runner\.temp \}\}\/pipeline-metrics\.jsonl/g) ?? [];
    assert.ok(envLines.length >= 2, `${name} must pass METRICS_FILE under runner.temp to the script and to "Commit metrics"`);
  }
});

// ADR-0023: workflows triggered by branch/PR activity hold LLM secrets and AI_PR_TOKEN;
// they must execute pipeline code from the default branch, never from the checked-out branch.
const BRANCH_TRIGGERED_SECRET_WORKFLOWS = ['auto-fix-pr.yml', 'pr-review.yml'];

test('branch-triggered workflows with secrets run pipeline scripts from the trusted default-branch copy', () => {
  for (const name of BRANCH_TRIGGERED_SECRET_WORKFLOWS) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.ok(!/run:\s*node\s+scripts\//.test(text), `${name} must not run scripts/ from the checked-out branch`);
    assert.match(text, /run: node "\$RUNNER_TEMP\/pipeline\/scripts\/[a-z_]+\.mjs"/, `${name} must run the trusted copy`);
    assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n\s+path: \.trusted-pipeline\n\s+persist-credentials: false/,
      `${name} must check out the default branch as the trusted pipeline without credentials`);
    assert.match(text, /mv \.trusted-pipeline "\$RUNNER_TEMP\/pipeline"/, `${name} must move the trusted copy out of the workspace`);
  }
});

test('auto-fix-pr.yml load-labels job executes default-branch code only', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'auto-fix-pr.yml'), 'utf8');
  const loadLabels = text.slice(text.indexOf('  load-labels:'), text.indexOf('\n  auto-fix:'));
  assert.match(loadLabels, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(loadLabels, /persist-credentials: false/);
});

test('pr-review.yml does not persist credentials in the PR-branch checkout', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'pr-review.yml'), 'utf8');
  const checkouts = text.match(/uses: actions\/checkout@v4(\n\s+with:(\n\s{10}.+)+)?/g) ?? [];
  assert.equal(checkouts.length, 2);
  for (const c of checkouts) assert.match(c, /persist-credentials: false/);
});

test('workflows that run PR code without secrets use a read-only token', () => {
  for (const name of ['test.yml', 'changelog-check.yml']) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.match(text, /^permissions:\n  contents: read\n/m, `${name} must declare permissions: contents: read`);
    assert.ok(!/secrets\./.test(text), `${name} must not use secrets`);
  }
});
