import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/test.yml'), 'utf8');

const GATED_MODULES = ['checkpoint.mjs', 'config.mjs', 'llm_client.mjs', 'anthropic_client.mjs', 'groq_client.mjs', 'output_writer.mjs', 'protected_paths.mjs', 'review_evidence.mjs', 'eval_harness.mjs', 'eval_scorecard.mjs', 'eval_site.mjs', 'eval_suites.mjs', 'review_prompt.mjs', 'eval_replay_ci.mjs', 'pr_evals.mjs', 'static_verifier.mjs', 'issue_validator.mjs', 'stale_refs.mjs', 'related_adrs.mjs', 'prompt_budget.mjs', 'event_docs.mjs', 'generation_blocked.mjs', 'run_journal.mjs', 'run_record.mjs', 'trace_context.mjs', 'otlp_trace.mjs', 'pipeline_model.mjs', 'pipeline_health.mjs', 'pipeline_site.mjs', 'pipeline_journey.mjs', 'pipeline_kpis.mjs', 'pipeline_diagnostics.mjs', 'console_views.mjs', 'console_overview.mjs', 'pr_tree_reader.mjs', 'github_output.mjs', 'llm_cost.mjs'];

// Entrypoints (scripts/*.mjs) under the same gate, measured through their own test file.
const GATED_ENTRYPOINTS = [['build_eval_site.mjs', 'build_eval_site.test.mjs']];
const GATE_COUNT = GATED_MODULES.length + GATED_ENTRYPOINTS.length;

test('test.yml enforces c8 coverage for gated entrypoints with their dedicated test file', () => {
  for (const [script, testFile] of GATED_ENTRYPOINTS) {
    assert.ok(workflow.includes(`--include 'scripts/${script}'`), `Missing coverage gate for ${script}`);
    assert.ok(workflow.includes(`node --test scripts/tests/${testFile}`), `Missing test reference: ${testFile}`);
  }
});

test('test.yml enforces c8 coverage for all critical modules', () => {
  for (const mod of GATED_MODULES) {
    assert.ok(workflow.includes(`scripts/lib/${mod}`), `Missing coverage gate for ${mod}`);
  }
});

test('test.yml uses --check-coverage for each gated module', () => {
  const gateCount = (workflow.match(/--check-coverage/g) || []).length;
  assert.equal(gateCount, GATE_COUNT,
    `Expected ${GATE_COUNT} --check-coverage flags, found ${gateCount}`);
});

test('pr-review-system.md lists exactly the files gated by c8 in test.yml (gate (c) must not drift)', () => {
  const prompt = readFileSync(resolve(ROOT, 'prompts/pr-review-system.md'), 'utf8');
  const gateLine = prompt.split('\n').find((line) => line.startsWith('* For gate (c),'));
  assert.ok(gateLine, 'gate (c) rule missing from prompts/pr-review-system.md');
  const gated = [...workflow.matchAll(/--include '([^']+)'/g)].map((m) => m[1]).sort();
  const listed = [...gateLine.matchAll(/`(scripts\/[^`]+\.mjs)`/g)].map((m) => m[1]).filter((f) => !f.includes('*')).sort();
  assert.equal(gated.length, GATE_COUNT);
  assert.deepEqual(listed, gated);
});

test('test.yml sets 80% threshold on all four dimensions for each gate', () => {
  for (const flag of ['--lines 80', '--branches 80', '--functions 80', '--statements 80']) {
    const count = (workflow.match(new RegExp(flag.replace(' ', '\\s+'), 'g')) || []).length;
    assert.equal(count, GATE_COUNT,
      `Expected ${GATE_COUNT} occurrences of "${flag}", found ${count}`);
  }
});

test('test.yml pairs each coverage gate with its dedicated test file', () => {
  const pairs = [
    ['checkpoint.mjs', 'checkpoint.test.mjs'],
    ['config.mjs', 'config.test.mjs'],
    ['llm_client.mjs', 'llm_client.test.mjs'],
    ['anthropic_client.mjs', 'anthropic_client.test.mjs'],
    ['groq_client.mjs', 'groq_client.test.mjs'],
    ['output_writer.mjs', 'output_writer.test.mjs'],
    ['protected_paths.mjs', 'protected_paths.test.mjs'],
    ['review_evidence.mjs', 'review_evidence.test.mjs'],
    ['eval_harness.mjs', 'eval_harness.test.mjs'],
    ['eval_scorecard.mjs', 'eval_scorecard.test.mjs'],
    ['eval_site.mjs', 'eval_site.test.mjs'],
    ['eval_replay_ci.mjs', 'eval_replay_ci.test.mjs'],
    ['pr_evals.mjs', 'pr_evals.test.mjs'],
    ['static_verifier.mjs', 'static_verifier.test.mjs'],
    ['issue_validator.mjs', 'issue_validator.test.mjs'],
    ['stale_refs.mjs', 'stale_refs.test.mjs'],
    ['related_adrs.mjs', 'related_adrs.test.mjs'],
    ['prompt_budget.mjs', 'prompt_budget.test.mjs'],
    ['run_journal.mjs', 'run_journal.test.mjs'],
    ['run_record.mjs', 'run_record.test.mjs'],
    ['trace_context.mjs', 'trace_context.test.mjs'],
    ['otlp_trace.mjs', 'otlp_trace.test.mjs'],
    ['pipeline_model.mjs', 'pipeline_model.test.mjs'],
    ['pipeline_health.mjs', 'pipeline_health.test.mjs'],
    ['pipeline_site.mjs', 'pipeline_site.test.mjs'],
    ['pipeline_journey.mjs', 'pipeline_journey.test.mjs'],
    ['pipeline_kpis.mjs', 'pipeline_kpis.test.mjs'],
    ['pipeline_diagnostics.mjs', 'pipeline_diagnostics.test.mjs'],
    ['console_views.mjs', 'console_views.test.mjs'],
    ['console_overview.mjs', 'console_overview.test.mjs'],
    ['github_output.mjs', 'github_output.test.mjs'],
    ['llm_cost.mjs', 'llm_cost.test.mjs'],
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
const MUTATING_WORKFLOWS = ['auto-fix-pr.yml', 'pr-review.yml', 'code-generation.yml', 'validate-issue.yml', 'reset-auto-fix.yml', 'evals.yml', 'pr-evals.yml', 'pipeline-site.yml'];
// Pages hosts one site (ADR-0027 amendment, 2026-10-17): the two deploy jobs share this group, and
// pipeline-site.yml serializes its own runs on one repository-wide group. Neither calls an LLM.
const SITE_GROUP = 'pages-site-${{ github.repository }}';
const SITE_WORKFLOW_GROUP = 'pipeline-site-${{ github.repository }}';
// Triggers fire for unrelated labels/comments too; a workflow-level group would let a
// skipped run replace the pending real one, so the group must sit on the gated job.
const JOB_LEVEL_CONCURRENCY = ['auto-fix-pr.yml', 'code-generation.yml', 'pr-evals.yml'];

test('every workflow declares a concurrency group keyed per PR/issue', () => {
  const workflows = readWorkflows();
  assert.equal(workflows.length, 11, `expected 11 workflows, found ${workflows.map((w) => w.name).join(', ')}`);
  for (const { name, text } of workflows) {
    const groups = [...text.matchAll(/^\s*concurrency:\s*\n\s+group:\s*(.+)$/gm)].map((m) => m[1].trim()).filter((g) => g !== SITE_GROUP);
    assert.equal(groups.length, 1, `${name} must declare exactly one concurrency group besides the shared Pages group`);
    if (name === 'pipeline-site.yml') {
      assert.equal(groups[0], SITE_WORKFLOW_GROUP, 'pipeline-site.yml rebuilds the one site: one repository-wide group');
      continue;
    }
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
  assert.deepEqual(committing.map((w) => w.name).sort(), ['auto-fix-pr.yml', 'code-generation.yml', 'pr-review.yml', 'reset-auto-fix.yml', 'validate-issue.yml']);
  for (const { name, text } of committing) {
    assert.ok(!/(wc -l|tail|cat)[^\n]*metrics\/runs\.jsonl/.test(text), `${name} must not read the working-tree metrics file`);
    // ADR-0041: reset-auto-fix writes no runs.jsonl line, only its run record and the trace index.
    if (name === 'reset-auto-fix.yml') { assert.ok(!text.includes('METRICS_FILE'), `${name}: record only`); continue; }
    const envLines = text.match(/METRICS_FILE: \$\{\{ runner\.temp \}\}\/pipeline-metrics\.jsonl/g) ?? [];
    assert.ok(envLines.length >= 2, `${name} must pass METRICS_FILE under runner.temp to the script and to "Commit metrics"`);
  }
});

// ADR-0013 amendment: main only takes changes through a pull request, so every metrics read and
// write targets the `metrics` branch; a Contents API call without it would hit main and fail (409).
// ADR-0040: the step is scripts/commit_run_record.mjs, which writes runs.jsonl and the run record in one
// commit on the metrics branch (Git Data API); it runs the trusted copy where the checkout is a PR tree.
test('workflows that commit metrics read and write the metrics branch, never the default branch', async () => {
  const { METRICS_BRANCH, RUNS_JSONL_PATH } = await import('../lib/run_record.mjs');
  assert.equal(METRICS_BRANCH, 'metrics');
  assert.equal(RUNS_JSONL_PATH, 'metrics/runs.jsonl');
  const committing = readWorkflows().filter(({ text }) => text.includes('name: Commit metrics'));
  assert.equal(committing.length, 5);
  for (const { name, text } of committing) {
    const step = text.slice(text.indexOf('- name: Commit metrics')).split(/\n      - name: /)[0];
    const trusted = BRANCH_TRIGGERED_SECRET_WORKFLOWS.includes(name);
    if (trusted) {
      assert.ok(step.includes('SCRIPT="$RUNNER_TEMP/pipeline/scripts/commit_run_record.mjs"') && step.includes('node "$SCRIPT"'), `${name}: Commit metrics runs the trusted commit_run_record.mjs`);
      // Best effort like the shell step it replaced: a default branch without the script warns, never fails the job.
      assert.match(step, /\[ -f "\$SCRIPT" \] \|\| \{ echo "::warning::[^"]+"; exit 0; \}/, `${name}: a trusted copy without the script is a warning, exit 0`);
    } else {
      assert.ok(step.includes('run: node scripts/commit_run_record.mjs'), `${name}: Commit metrics runs commit_run_record.mjs`);
    }
    assert.match(step, /if: always\(\)/, `${name}: Commit metrics runs on failure too`);
    assert.doesNotMatch(step, /contents\/metrics\/runs\.jsonl/, `${name}: no Contents API write (one file per commit) left in the step`);
  }
  const script = readFileSync(resolve(ROOT, 'scripts/lib/run_record.mjs'), 'utf8');
  assert.match(script, /git\/refs\/heads\/\$\{METRICS_BRANCH\}`, \{ sha: newCommit\.json\.sha, force: false \}/, 'fast-forward update of the metrics ref only');
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
  // review and evidence jobs (ADR-0024): PR branch + trusted pipeline each.
  assert.equal(checkouts.length, 4);
  for (const c of checkouts) assert.match(c, /persist-credentials: false/);
});

test('pr-review.yml evidence job runs PR checks without secrets, from the trusted pipeline (ADR-0024)', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'pr-review.yml'), 'utf8');
  const evidence = text.slice(text.indexOf('\n  evidence:\n'), text.indexOf('\n  review:\n'));
  assert.ok(evidence.length > 0, 'expected an evidence job before the review job');
  assert.match(evidence, /\n    permissions:\n      contents: read\n/);
  assert.ok(!/secrets\./.test(evidence), 'evidence job must not reference secrets');
  assert.match(evidence, /node "\$RUNNER_TEMP\/pipeline\/scripts\/run_review_evidence\.mjs"/);
  assert.match(evidence, /REVIEW_EVIDENCE_PATH: \$\{\{ runner\.temp \}\}\//, 'evidence must be written outside the checkout');
  const review = text.slice(text.indexOf('\n  review:\n'));
  assert.match(review, /needs: evidence/);
  assert.match(review, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(review, /REVIEW_EVIDENCE_PATH: \$\{\{ runner\.temp \}\}\//, 'review must read evidence from outside the checkout');
});

test('workflows that run PR code without secrets use a read-only token', () => {
  for (const name of ['test.yml', 'changelog-check.yml', 'eval-replay.yml']) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.match(text, /^permissions:\n  contents: read\n/m, `${name} must declare permissions: contents: read`);
    assert.ok(!/secrets\./.test(text), `${name} must not use secrets`);
  }
});

// ADR-0039: the LangGraph prototype's Python tests run in CI, on the declared minimum version.
test('test.yml runs the LangGraph prototype tests on Python 3.11 and 3.13', () => {
  const job = workflow.split(/^  prototype-langgraph:\n/m)[1];
  assert.ok(job, 'test.yml must declare a prototype-langgraph job');
  assert.match(job, /python: \["3\.11", "3\.13"\]/);
  assert.match(job, /working-directory: prototypes\/langgraph-loop/);
  assert.match(job, /pip install -r requirements\.txt/);
  assert.match(job, /python -m unittest -v tests\.test_loop/);
});

// `echo "ref=$(gh api ...)"` does not fail under `bash -e`: an API failure would yield an
// empty ref and the global group `pr-pipeline-`. The lookup must fail the job instead.
test('head-ref lookups fail closed instead of producing an empty concurrency key', () => {
  for (const name of ['auto-fix-pr.yml', 'reset-auto-fix.yml']) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.ok(!/echo "ref=\$\(gh api/.test(text), `${name} must not swallow gh api errors inside echo`);
    assert.match(text, /REF=\$\(gh api [^\n]+\)\n\s+\[ -n "\$REF" \] \|\| \{ echo "::error::[^"]+"; exit 1; \}\n\s+echo "ref=\$REF" >> "\$GITHUB_OUTPUT"/,
      `${name} must assign, check non-empty, then write the ref`);
  }
});

test('auto-fix-pr.yml resolves the head ref only for trusted rerun comments', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'auto-fix-pr.yml'), 'utf8');
  const loadLabels = text.slice(text.indexOf('  load-labels:'), text.indexOf('\n  auto-fix:'));
  const headIf = loadLabels.match(/- id: head\n\s+if: (.+)/)?.[1] ?? '';
  assert.match(headIf, /github\.event\.comment\.author_association/);
  assert.match(headIf, /- \[x\] Relancer Auto Fixer/);
});

// ADR-0028 amendment: a Groq rate limit must never fail a job. Every workflow that hands
// GROQ_API_KEY to a step must let that step wait out TPM windows (hint-less limits wait 60 s)
// within an explicit job timeout, keeping 3 minutes for evidence, the call and the rest.
const LLM_WORKFLOWS = ['pr-review.yml', 'auto-fix-pr.yml', 'code-generation.yml', 'validate-issue.yml', 'evals.yml', 'pr-evals.yml'];

// Splits a workflow into its jobs (2-space-indented keys under `jobs:`).
function jobsOf(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  return body.split(/\n(?=  [A-Za-z0-9_-]+:\n)/).map((chunk) => ({ name: chunk.match(/^\s*([A-Za-z0-9_-]+):/)?.[1], text: chunk }));
}

function llmRetryBudget(name) {
  const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
  const job = jobsOf(text).find((j) => j.text.includes('secrets.GROQ_API_KEY'));
  assert.ok(job, `${name}: no job receives GROQ_API_KEY`);
  const step = job.text.split(/\n(?=      - )/).find((st) => st.includes('secrets.GROQ_API_KEY'));
  return {
    job: job.name,
    timeoutMin: Number(job.text.match(/^    timeout-minutes: (\d+)/m)?.[1]),
    waitMs: Number(step.match(/LLM_MAX_RETRY_WAIT_MS: '(\d+)'/)?.[1]),
    retries: Number(step.match(/GROQ_MAX_RETRIES: '(\d+)'/)?.[1]),
  };
}

test('exactly the expected workflows hand GROQ_API_KEY to a step', () => {
  const withKey = readWorkflows().filter(({ text }) => text.includes('secrets.GROQ_API_KEY')).map(({ name }) => name).sort();
  assert.deepEqual(withKey, [...LLM_WORKFLOWS].sort());
});

for (const name of LLM_WORKFLOWS) {
  test(`${name} waits out Groq rate limits (one 60 s TPM window per retry) within an explicit job timeout`, () => {
    const { job, timeoutMin, waitMs, retries } = llmRetryBudget(name);
    assert.ok(Number.isFinite(timeoutMin), `${name} job ${job} must declare timeout-minutes`);
    assert.ok(waitMs >= 60_000, `${name}: LLM_MAX_RETRY_WAIT_MS (${waitMs}) must cover a full TPM window (60000)`);
    assert.ok(retries >= 5, `${name}: GROQ_MAX_RETRIES (${retries}) must be >= 5`);
    assert.ok(retries * waitMs <= (timeoutMin - 3) * 60_000,
      `${name}: ${retries} x ${waitMs} ms of waits must fit timeout-minutes (${timeoutMin}) - 3 min`);
  });
}

test('evals.yml measures consistency by default and tolerates a long TPM queue', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'evals.yml'), 'utf8');
  const repeats = text.slice(text.indexOf('      repeats:'));
  assert.equal(repeats.match(/default: '(\d+)'/)?.[1], '3');
  assert.ok(llmRetryBudget('evals.yml').retries >= 10);
});

// ADR-0031: a gated eval run covers the whole dataset. --tags / --limit make run_evals.mjs skip the
// thresholds of the classes they leave out, so no workflow may pass them.
test('evals.yml and pr-evals.yml never run a filtered subset (ADR-0031)', () => {
  for (const name of ['evals.yml', 'pr-evals.yml']) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.match(text, /run_evals\.mjs/, `${name}: no run_evals.mjs invocation`);
    assert.doesNotMatch(text, /--tags|--limit/, `${name}: filtered eval run`);
  }
});

test('no workflow serializes LLM calls through a global concurrency group (GitHub keeps one pending run per group and cancels the rest)', () => {
  for (const { name, text } of readWorkflows()) {
    for (const [, group] of text.matchAll(/group: (.+)/g)) {
      assert.match(group, /\$\{\{/, `${name}: concurrency group "${group}" must be keyed per PR/issue/ref`);
    }
  }
});

// ADR-0028: estimated input × 1.10 (chars/4 under-estimates by ~3%) + max_tokens <= 8000 TPM.
test('config/models.yaml: every Groq stage input budget + max_tokens keeps the 10% margin under 8K TPM', async () => {
  const { parseFlatYaml } = await import('../lib/yaml.mjs');
  const { estimateTokens } = await import('../lib/metrics.mjs');
  const models = parseFlatYaml(readFileSync(resolve(ROOT, 'config/models.yaml'), 'utf8'));
  assert.equal(models.groq_max_retries, undefined, 'retries are per workflow (GROQ_MAX_RETRIES), sized to each job timeout');
  // autofix_max_input_tokens bounds the user prompt only: its system prompt comes on top.
  const autofixSystem = estimateTokens(readFileSync(resolve(ROOT, 'prompts/auto-fix-system.md'), 'utf8').trim());
  const extra = { autofix: autofixSystem };
  for (const stage of ['validation', 'generation', 'review', 'autofix']) {
    const maxTokens = Number(models[`${stage}_max_tokens`]);
    const budget = Number(models[`${stage}_max_input_tokens`]);
    assert.ok(maxTokens > 0 && budget > 0, `${stage}: max_tokens and max_input_tokens must be set`);
    const input = budget + (extra[stage] ?? 0);
    assert.ok(input * 1.1 + maxTokens <= 8000, `${stage}: ${input} x 1.10 + ${maxTokens} = ${Math.round(input * 1.1 + maxTokens)} > 8000`);
  }
});

test('config/models.yaml: the review budget leaves room for a diff after the fixed prompt', async () => {
  const { parseFlatYaml } = await import('../lib/yaml.mjs');
  const { estimateTokens } = await import('../lib/metrics.mjs');
  const models = parseFlatYaml(readFileSync(resolve(ROOT, 'config/models.yaml'), 'utf8'));
  const fixed = ['pr-review-system', 'pr-review-user'].reduce((n, f) => n + estimateTokens(readFileSync(resolve(ROOT, `prompts/${f}.md`), 'utf8')), 0);
  assert.ok(Number(models.review_max_input_tokens) - fixed >= 2000, `review prompts (${fixed}) leave < 2000 tokens for diff, body and contexts`);
});

// ADR-0028: a run that reviewed nothing must not replace the newest checkpoints-pr-<N> artifact.
test('pr-review.yml uploads checkpoints only when the review step did not skip', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'pr-review.yml'), 'utf8');
  assert.match(text, /- name: Run automated review\n\s+id: review\n/);
  assert.match(text, /- name: Upload checkpoint artifact\n\s+if: \$\{\{ always\(\) && steps\.review\.outputs\.skipped != 'true' \}\}/);
});

// ADR-0027: the eval workflow publishes the dashboard to GitHub Pages; it never commits.
test('evals.yml deploys the eval dashboard to Pages and never pushes', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'evals.yml'), 'utf8');
  assert.doesNotMatch(text, /git (push|add|commit)\b/);
  assert.doesNotMatch(text, /gh pr (create|merge|edit)/);
  assert.match(text, /args=\(--out "\$SITE_DIR" --pipeline-dir "\$PIPELINE_DIR"\)/);
  assert.match(text, /args\+=\(--site-url "\$SITE_URL"\)/);
  assert.match(text, /node scripts\/build_eval_site\.mjs "\$\{args\[@\]\}" "\$\{results\[@\]\}"/);
  // An empty history is opt-in (init_site), never a fallback; every deployed tree is backed up.
  assert.match(text, /if \[ "\$INIT_SITE" = "true" \]; then args\+=\(--allow-empty\); fi/);
  assert.match(text, /name: eval-site-\$\{\{ github\.run_id \}\}[\s\S]*?retention-days: 90/);
  assert.match(text, /args\+=\(--previous-dir "\$RESTORE_DIR"\)/);
  assert.match(text, /uses: actions\/configure-pages@v\d+/);
  assert.match(text, /uses: actions\/upload-pages-artifact@v\d+/);
  assert.match(text, /uses: actions\/deploy-pages@v\d+/);
  assert.match(text, /name: github-pages/);
});

test('evals.yml keeps write access out of the eval job and publishes from the default branch only', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'evals.yml'), 'utf8');
  const evalJob = text.slice(text.indexOf('\n  eval:'), text.indexOf('\n  publish:'));
  const publishJob = text.slice(text.indexOf('\n  publish:'));
  assert.match(text, /^permissions:\n  contents: read$/m);
  assert.match(evalJob, /persist-credentials: false/);
  assert.doesNotMatch(evalJob, /contents: write|git push/);
  assert.match(publishJob, /needs: eval/);
  assert.match(publishJob, /pages: write/);
  assert.match(publishJob, /id-token: write/);
  assert.doesNotMatch(publishJob, /contents: write|pull-requests: write/);
  assert.match(publishJob, /if: \$\{\{ !cancelled\(\) && \(github\.event_name == 'schedule' \|\| inputs\.publish\) && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) \}\}/);
  assert.doesNotMatch(publishJob, /secrets\./, 'the publish job must not receive LLM API keys');
});

test('evals.yml offers exactly the registered eval suites as a choice', async () => {
  const { SUITES } = await import('../lib/eval_suites.mjs');
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'evals.yml'), 'utf8');
  const suite = text.slice(text.indexOf('      suite:'), text.indexOf('      repeats:'));
  assert.match(suite, /type: choice/);
  const options = [...suite.slice(suite.indexOf('options:')).matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(options, Object.keys(SUITES));
});

// ADR-0027 amendment (weekly run): the published run that eval-replay.yml and pr-evals.yml compare
// with is refreshed every week. On `schedule` every input is empty, so each default is explicit.
const evalsYml = () => readFileSync(resolve(WORKFLOWS_DIR, 'evals.yml'), 'utf8');
const evalsJobs = () => Object.fromEntries(jobsOf(evalsYml()).map((j) => [j.name, j.text]));

// ADR-0027 amendment (2026-10-12): one cron per suite. Groq's free-tier TPD (200k, shared with
// production) holds one suite × 3 repeats, not two in a row (run 38271632735).
const evalsCrons = () => [...evalsYml().matchAll(/^\s+- cron: '([^']+)'(?: #.*)?$/gm)].map((m) => m[1]);
const evalsCronSuites = () => {
  const map = evalsJobs().eval.match(/fromJSON\('(\{[^']+\})'\)\[github\.event\.schedule\]/);
  assert.ok(map, 'matrix: a JSON map from cron string to suite, indexed by github.event.schedule');
  return JSON.parse(map[1]);
};

test('evals.yml runs each suite weekly, early morning UTC, off the hour, on days at least 48 h apart', () => {
  const crons = evalsCrons();
  assert.ok(crons.length >= 2);
  const days = [];
  for (const cron of crons) {
    const [minute, hour, dom, month, dow] = cron.split(' ');
    assert.ok(Number(minute) % 15 !== 0, `${cron}: minute ${minute} must not be round (GitHub delays :00 schedules)`);
    assert.ok(Number(hour) >= 5 && Number(hour) <= 7, `${cron}: hour ${hour} must be about 06:00 UTC`);
    assert.deepEqual([dom, month], ['*', '*'], `${cron}: weekly only`);
    assert.match(dow, /^[0-6]$/, `${cron}: one day of the week`);
    days.push(Number(dow));
  }
  // A delayed schedule (hours, run 38271632735) must still start on a TPD the previous suite no longer holds.
  const sorted = [...days].sort((a, b) => a - b);
  sorted.forEach((d, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 7;
    assert.ok(next - d >= 2, `suite days ${d} and ${next % 7} are less than 48 h apart`);
  });
  assert.match(evalsYml(), /^on:\n  schedule:\n[\s\S]*?\n  workflow_dispatch:\n/m);
});

test('evals.yml never starts an empty history nor restores a backup on schedule', () => {
  const text = evalsYml();
  const publish = evalsJobs().publish;
  // init_site and restore_run_id are read once each, behind the schedule guard, into job env.
  assert.deepEqual([...text.matchAll(/inputs\.init_site\b[^\n]*/g)].map((m) => m[0]), ['inputs.init_site }}']);
  assert.match(publish, /^      INIT_SITE: \$\{\{ github\.event_name != 'schedule' && inputs\.init_site \}\}$/m);
  assert.deepEqual([...text.matchAll(/inputs\.restore_run_id\b/g)].length, 1);
  assert.match(publish, /^      RESTORE_RUN_ID: \$\{\{ github\.event_name != 'schedule' && inputs\.restore_run_id \|\| '' \}\}$/m);
  // Steps read the guarded env only, and --allow-empty comes from INIT_SITE alone.
  assert.equal([...text.matchAll(/^\s+INIT_SITE:/gm)].length, 1, 'no step may redefine INIT_SITE');
  assert.equal([...text.matchAll(/^\s+RESTORE_RUN_ID:/gm)].length, 1, 'no step may redefine RESTORE_RUN_ID');
  assert.equal([...text.matchAll(/--allow-empty/g)].length, 1);
  assert.match(publish, /if: env\.RESTORE_RUN_ID != ''/);
  assert.match(publish, /name: eval-site-\$\{\{ env\.RESTORE_RUN_ID \}\}\n\s+run-id: \$\{\{ env\.RESTORE_RUN_ID \}\}/);
  // publish defaults on for schedule; repeats defaults to 3 when the input is empty.
  assert.match(publish, /\(github\.event_name == 'schedule' \|\| inputs\.publish\)/);
  assert.match(evalsJobs().eval, /REPEATS: \$\{\{ inputs\.repeats \|\| '3' \}\}/);
});

test('evals.yml schedule runs every registered suite once a week, one suite per cron, each under its own run_id', async () => {
  const { SUITES } = await import('../lib/eval_suites.mjs');
  const job = evalsJobs().eval;
  assert.match(job, /suite: \$\{\{ fromJSON\(format\('\["\{0\}"\]', github\.event_name == 'schedule' && fromJSON\('[^']+'\)\[github\.event\.schedule\] \|\| inputs\.suite\)\) \}\}/,
    'matrix: the cron\'s suite on schedule, the chosen one on dispatch');
  const cronSuites = evalsCronSuites();
  // Every cron is mapped (an unmapped one would run an empty suite), every suite has exactly one cron.
  assert.deepEqual(Object.keys(cronSuites).sort(), [...evalsCrons()].sort());
  assert.deepEqual(Object.values(cronSuites).sort(), Object.keys(SUITES).sort());
  assert.match(job, /max-parallel: 1\n/, 'suites share the 8K TPM: never in parallel');
  assert.match(job, /fail-fast: false\n/, 'a failing suite must not cancel the next one');
  assert.match(job, /SUITE: \$\{\{ matrix\.suite \}\}/);
  assert.match(job, /EVAL_RUN_ID: \$\{\{ github\.run_id \}\}-\$\{\{ matrix\.suite \}\}/);
  assert.match(job, /name: eval-results-\$\{\{ github\.run_id \}\}-\$\{\{ matrix\.suite \}\}\n/);
  assert.match(job, /name: run-trace-\$\{\{ github\.run_id \}\}-\$\{\{ matrix\.suite \}\}\n/);
  // Every suite, worst case, within the per-suite job timeout.
  assert.ok(Number(job.match(/^    timeout-minutes: (\d+)$/m)[1]) >= 90);
});

// The pre-flight estimate (tokensPerRunEst × runs) ignores Groq's prompt cache: any budget under the
// TPD would refuse every weekly run. Gates only tighten (ADR-0031), so the scheduled run keeps repeats 3.
test('evals.yml scheduled runs keep repeats 3 and ignore EVAL_TOKEN_BUDGET; manual runs keep it', () => {
  const job = evalsJobs().eval;
  assert.equal([...evalsYml().matchAll(/EVAL_TOKEN_BUDGET:/g)].length, 1);
  assert.match(job, /^          EVAL_TOKEN_BUDGET: \$\{\{ github\.event_name != 'schedule' && vars\.EVAL_TOKEN_BUDGET \|\| '' \}\}$/m);
  assert.match(job, /REPEATS: \$\{\{ inputs\.repeats \|\| '3' \}\}/);
  assert.doesNotMatch(job, /REPEATS:[^\n]*schedule/, 'no lower repeats on schedule (consistency gate)');
});

test('evals.yml publishes every suite of the run in one Pages deploy', () => {
  const publish = evalsJobs().publish;
  assert.match(publish, /pattern: eval-results-\$\{\{ github\.run_id \}\}-\*\n\s+merge-multiple: true\n/);
  assert.equal([...publish.matchAll(/uses: actions\/deploy-pages@/g)].length, 1);
  assert.match(publish, /needs: eval\n/);
  assert.match(publish, /^    timeout-minutes: \d+$/m);
});

// Issue #199: a manual run can measure another provider; production's vars.AI_PROVIDER is never overridden
// outside the eval step, and a scheduled run always uses it.
test('evals.yml provider input: a choice of the providers, defaulting to the repository variable', async () => {
  const { PROVIDERS } = await import('../lib/config.mjs');
  const text = evalsYml();
  const input = text.slice(text.indexOf('      provider:'), text.indexOf('      anthropic_model:'));
  assert.match(input, /type: choice/);
  assert.match(input, /default: repo-variable/);
  const options = [...input.slice(input.indexOf('options:')).matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(options, ['repo-variable', ...PROVIDERS]);
});

test('evals.yml passes the provider input as AI_PROVIDER to the eval step only, never on schedule', () => {
  const text = evalsYml();
  const expr = "AI_PROVIDER: ${{ github.event_name != 'schedule' && inputs.provider != 'repo-variable' && inputs.provider || vars.AI_PROVIDER }}";
  assert.equal([...text.matchAll(/^\s+AI_PROVIDER:/gm)].length, 1, 'one AI_PROVIDER, on the eval step');
  assert.equal([...text.matchAll(/inputs\.provider\b/g)].length, 5, 'inputs.provider: the AI_PROVIDER(_<STAGE>) expressions and MODEL_CHANGE_FAILS only');
  const step = evalsJobs().eval.split(/\n(?=      - )/).find((st) => st.includes('- name: Run eval suite'));
  assert.ok(step.includes(expr));
  assert.doesNotMatch(evalsJobs().publish, /AI_PROVIDER/);
});

// Review of #208: a model change on the repo's configured provider is drift, never a silent notice (#209).
test('evals.yml fails the publish on a model change for schedule and repo-variable runs only', () => {
  const publish = evalsJobs().publish;
  assert.ok(publish.includes("      MODEL_CHANGE_FAILS: ${{ github.event_name == 'schedule' || (inputs.provider == 'repo-variable' && inputs.anthropic_model == '' && inputs.anthropic_effort == 'models-yaml') }}\n"),
    'a dispatch with an explicit provider, Anthropic model or effort is a measurement: notice only');
  assert.equal([...evalsYml().matchAll(/^\s+MODEL_CHANGE_FAILS:/gm)].length, 1, 'no step may redefine MODEL_CHANGE_FAILS');
  assert.match(publish, /if \[ "\$MODEL_CHANGE_FAILS" = "true" \]; then args\+=\(--fail-on-model-change\); fi/);
  assert.equal([...evalsYml().matchAll(/--fail-on-model-change/g)].length, 1);
});

// #209: a new series (rebaseline) is an explicit manual request: off by default, never on schedule.
test('evals.yml rebaseline input: boolean, default false, passed as --rebaseline on workflow_dispatch only', () => {
  const text = evalsYml();
  const input = text.slice(text.indexOf('      rebaseline:'), text.indexOf('\npermissions:'));
  assert.match(input, /^      rebaseline:\n        description: [^\n]+\n        type: boolean\n        default: false\n$/);
  assert.equal([...text.matchAll(/inputs\.rebaseline\b/g)].length, 1, 'read once, behind the dispatch guard');
  const publish = evalsJobs().publish;
  assert.ok(publish.includes("      REBASELINE: ${{ github.event_name == 'workflow_dispatch' && inputs.rebaseline }}\n"),
    'schedule (empty inputs) and any other event never enable it');
  assert.equal([...text.matchAll(/^\s+REBASELINE:/gm)].length, 1, 'no step may redefine REBASELINE');
  assert.doesNotMatch(evalsJobs().eval, /REBASELINE|rebaseline/, 'the eval job (API keys) never sees it');
  assert.match(publish, /if \[ "\$REBASELINE" = "true" \]; then args\+=\(--rebaseline\); fi/);
  assert.equal([...text.matchAll(/--rebaseline/g)].length, 1, 'the build step only');
  // --fail-on-model-change stays as is: the rebaseline accepts an eligible model change, it does not mute drift.
  assert.match(publish, /if \[ "\$MODEL_CHANGE_FAILS" = "true" \]; then args\+=\(--fail-on-model-change\); fi\n\s+if \[ "\$REBASELINE" = "true" \]/);
});

// ADR-0032 amendment: one manual run measures a stage on another Anthropic model or effort.
test('evals.yml anthropic_model / anthropic_effort inputs: empty / models-yaml by default, efforts from config', async () => {
  const text = evalsYml();
  const model = text.slice(text.indexOf('      anthropic_model:'), text.indexOf('      anthropic_effort:'));
  assert.match(model, /default: ''\n/);
  assert.doesNotMatch(model, /type: choice/, 'free-form: any model id');
  const effort = text.slice(text.indexOf('      anthropic_effort:'), text.indexOf('      publish:'));
  assert.match(effort, /type: choice/);
  assert.match(effort, /default: models-yaml\n/);
  const options = [...effort.slice(effort.indexOf('options:')).matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(options, ['models-yaml', 'low', 'medium', 'high', 'xhigh', 'max'], 'no `off`: the 5.5 stage models reject it');
});

test('evals.yml passes the Anthropic overrides to the eval step only, never on schedule', () => {
  const text = evalsYml();
  const step = evalsJobs().eval.split(/\n(?=      - )/).find((st) => st.includes('- name: Run eval suite'));
  assert.ok(step.includes("          EVAL_ANTHROPIC_MODEL: ${{ github.event_name != 'schedule' && inputs.anthropic_model || '' }}\n"));
  assert.ok(step.includes("          EVAL_ANTHROPIC_EFFORT: ${{ github.event_name != 'schedule' && inputs.anthropic_effort != 'models-yaml' && inputs.anthropic_effort || '' }}\n"));
  assert.equal([...text.matchAll(/^\s+EVAL_ANTHROPIC_(MODEL|EFFORT):/gm)].length, 2, 'set once, on the eval step');
  // The repository variables stay what production reads; the run input goes through EVAL_ANTHROPIC_*.
  assert.ok(step.includes('          ANTHROPIC_MODEL: ${{ vars.ANTHROPIC_MODEL }}\n'));
  assert.ok(step.includes('          ANTHROPIC_EFFORT: ${{ vars.ANTHROPIC_EFFORT }}\n'));
  assert.equal([...text.matchAll(/inputs\.anthropic_model\b/g)].length, 2, 'the eval step and MODEL_CHANGE_FAILS only');
  assert.equal([...text.matchAll(/inputs\.anthropic_effort\b/g)].length, 3, 'the eval step and MODEL_CHANGE_FAILS only');
  assert.doesNotMatch(evalsJobs().publish, /EVAL_ANTHROPIC|ANTHROPIC_MODEL:/);
});

// Per-stage provider (ADR-0032 amendment): each production workflow passes its stage's AI_PROVIDER_<STAGE>.
test('LLM workflows pass AI_PROVIDER_<STAGE> with AI_PROVIDER for the stages they run', () => {
  const stages = {
    'validate-issue.yml': ['VALIDATION'], 'code-generation.yml': ['GENERATION'], 'pr-review.yml': ['REVIEW'],
    'auto-fix-pr.yml': ['AUTOFIX'], 'pr-evals.yml': ['VALIDATION', 'REVIEW'],
  };
  for (const [file, expected] of Object.entries(stages)) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8');
    const found = [...text.matchAll(/^\s+AI_PROVIDER_([A-Z]+): \$\{\{ vars\.AI_PROVIDER_\1 \}\}$/gm)].map((m) => m[1]);
    assert.deepEqual(found, expected, file);
    assert.match(text, /^\s+AI_PROVIDER: \$\{\{ vars\.AI_PROVIDER \}\}$/m, `${file}: the repo-wide provider stays the default`);
  }
});

test('evals.yml: per-stage providers from the repository variables, blanked by an explicit provider input', () => {
  const step = evalsJobs().eval.split(/\n(?=      - )/).find((st) => st.includes('- name: Run eval suite'));
  for (const stage of ['VALIDATION', 'REVIEW']) {
    assert.ok(step.includes(`          AI_PROVIDER_${stage}: \${{ (github.event_name == 'schedule' || inputs.provider == 'repo-variable') && vars.AI_PROVIDER_${stage} || '' }}\n`), stage);
  }
});

test('evals.yml reports the run against the published baseline without API keys, never deciding the job', () => {
  const job = evalsJobs().eval;
  const step = job.split(/\n(?=      - )/).find((st) => st.includes('- name: Report run vs published baseline'));
  assert.ok(step, 'report step missing');
  assert.match(step, /if: always\(\)/);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /node scripts\/build_eval_site\.mjs --report --site-url "\$EVAL_SITE_URL" "\$\{files\[@\]\}"/);
  assert.doesNotMatch(step, /secrets\./);
  // After the eval step, before the artifact upload (which stays unconditional).
  assert.ok(job.indexOf('- name: Run eval suite') < job.indexOf('- name: Report run vs published baseline'));
  assert.ok(job.indexOf('- name: Report run vs published baseline') < job.indexOf('- name: Upload eval results'));
  assert.match(job, /- name: Upload eval results\n\s+if: always\(\)/);
});

// evals.yml and pr-evals.yml share the Groq quota but must never queue behind (or cancel) each other.
test('evals.yml and pr-evals.yml use disjoint concurrency groups that never cancel a running eval', () => {
  const groupOf = (text) => text.match(/^\s*concurrency:\s*\n\s+group:\s*(.+)$/m)[1].trim();
  const prEvalsText = readFileSync(resolve(WORKFLOWS_DIR, 'pr-evals.yml'), 'utf8');
  // "evals-refs/heads/…" can never equal "pr-evals-<number>": neither run waits for the other.
  assert.equal(groupOf(evalsYml()), 'evals-${{ github.ref }}');
  assert.equal(groupOf(prEvalsText), 'pr-evals-${{ needs.plan.outputs.pr_number }}');
  for (const text of [evalsYml(), prEvalsText]) assert.match(text, /cancel-in-progress: false/);
});

// ADR-0027 amendment: the eval replay gate runs PR code, so it is read-only and secret-free, and
// it only triggers on the files a replay can judge (parsers, decideVerdict, scorers, prompts, datasets).
const evalReplay = () => readFileSync(resolve(WORKFLOWS_DIR, 'eval-replay.yml'), 'utf8');

function pathsFilter(text) {
  const block = text.slice(text.indexOf('    paths:\n'), text.indexOf('\npermissions:'));
  return [...block.matchAll(/^      - '([^']+)'$/gm)].map((m) => m[1]);
}

// GitHub paths-filter globs: `**` crosses directories, `*` does not.
function globMatch(glob, file) {
  const re = glob.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${re}$`).test(file);
}

test('eval-replay.yml runs on pull_request only, read-only, without secrets or a persisted credential', () => {
  const text = evalReplay();
  assert.match(text, /^on:\n  pull_request:\n    paths:\n/m);
  assert.doesNotMatch(text, /^\s+pull_request_target:/m);
  assert.doesNotMatch(text, /^\s+(push|workflow_run|issue_comment):/m);
  assert.match(text, /^permissions:\n  contents: read\n\n/m);
  assert.equal((text.match(/^\s+permissions:/gm) ?? []).length, 1, 'no job-level permission override');
  assert.doesNotMatch(text, /secrets\.|github\.token|GITHUB_TOKEN/);
  assert.match(text, /uses: actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/);
  assert.doesNotMatch(text, /git (push|commit)|gh (pr|api)/);
});

test('eval-replay.yml triggers on parser, verdict, scorer, prompt and dataset changes, not on docs', () => {
  const paths = pathsFilter(evalReplay());
  for (const required of ['prompts/**', 'scripts/lib/issue_validator.mjs', 'scripts/lib/review_prompt.mjs', 'scripts/lib/review_evidence.mjs', 'scripts/lib/output_writer.mjs', 'scripts/lib/eval_*.mjs']) {
    assert.ok(paths.includes(required), `missing paths filter ${required}`);
  }
  const triggers = (file) => paths.some((g) => globMatch(g, file));
  for (const file of ['prompts/pr-review-system.md', 'scripts/lib/review_prompt.mjs', 'scripts/lib/eval_harness.mjs', 'scripts/lib/eval_replay_ci.mjs', 'evals/datasets/review.jsonl', 'config/models.yaml']) {
    assert.ok(triggers(file), `${file} must trigger the replay`);
  }
  for (const file of ['README.md', 'docs/evals.md', 'CHANGELOG.md', 'docs/adr/0027-offline-eval-harness.md', 'scripts/lib/eval/nested.mjs', 'scripts/lib/llm_client.mjs']) {
    assert.ok(!triggers(file), `${file} must not trigger the replay`);
  }
});

test('eval-replay.yml keys concurrency on the PR, keeps the observability contract and only orchestrates', () => {
  const text = evalReplay();
  assert.match(text, /^concurrency:\n  group: eval-replay-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true$/m);
  assert.match(text, /GITHUB_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(text, /- name: Upload run trace\n\s+if: always\(\)\n\s+uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: run-trace-\$\{\{ github\.run_id \}\}\n\s+path: \.\/observability\/traces\/\$\{\{ github\.run_id \}\}\.json/);
  assert.match(text, /^    timeout-minutes: \d+$/m);
  const runs = [...text.matchAll(/^\s+run: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(runs, ['node scripts/replay_evals_ci.mjs --site-url "$EVAL_SITE_URL"']);
});

// Relative imports reachable from the replay entry points: a module the suites load that the paths
// filter misses lets a PR break every replayed case without triggering the gate (#179 review).
function relativeImportClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(resolve(ROOT, file), 'utf8');
    for (const [, spec] of text.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      queue.push(posix.normalize(posix.join(posix.dirname(file), spec)));
    }
  }
  return [...seen].sort();
}

test('eval-replay.yml paths filter covers every module the replay loads', () => {
  const closure = relativeImportClosure(['scripts/replay_evals_ci.mjs', 'scripts/lib/eval_replay_ci.mjs', 'scripts/lib/eval_suites.mjs']);
  assert.ok(closure.includes('scripts/lib/prompts.mjs') && closure.includes('scripts/lib/token_budget.mjs'), closure.join(', '));
  const paths = pathsFilter(evalReplay());
  const uncovered = closure.filter((file) => !paths.some((g) => globMatch(g, file)));
  assert.deepEqual(uncovered, [], `add to eval-replay.yml paths: ${uncovered.join(', ')}`);
  // config.mjs parses config/models.yaml at import time.
  assert.ok(paths.includes('config/models.yaml'));
});

// ADR-0030: live eval of a PR's prompts. The job holding the LLM secrets runs default-branch code only
// and takes prompts/** from the PR as data; a human with write access triggers it; the comment is
// posted by a job without LLM secrets; nothing is published.
const prEvals = () => readFileSync(resolve(WORKFLOWS_DIR, 'pr-evals.yml'), 'utf8');
const prEvalsJobs = () => Object.fromEntries(jobsOf(prEvals()).map((j) => [j.name, j.text]));

test('pr-evals.yml is human-triggered only: run-evals label (pull_request_target) or dispatch, never push or pull_request', async () => {
  const { RUN_EVALS_LABEL } = await import('../lib/pr_evals.mjs');
  const text = prEvals();
  assert.match(text, /^on:\n  pull_request_target:\n    types: \[labeled\]\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(text, /^  (push|pull_request|issue_comment|workflow_run|schedule):/m);
  const { plan } = prEvalsJobs();
  assert.match(plan, new RegExp(`if: \\$\\{\\{ github\\.event_name == 'workflow_dispatch' \\|\\| github\\.event\\.label\\.name == '${RUN_EVALS_LABEL}' \\}\\}`));
  // The labeler's write access is checked from the API (labeled payloads carry no author_association).
  assert.match(plan, /gh api "repos\/\$GITHUB_REPOSITORY\/collaborators\/\$ACTOR\/permission"/);
  assert.match(plan, /--permission "\$PERMISSION"/);
  assert.match(plan, /--expect-sha "\$HEAD_SHA"/);
  assert.match(plan, /ACTOR: \$\{\{ github\.event\.sender\.login \}\}/);
});

test('pr-evals.yml repeats: 1 by default, 3 on dispatch', () => {
  const text = prEvals();
  const repeats = text.slice(text.indexOf('      repeats:'), text.indexOf('\npermissions:'));
  assert.match(repeats, /type: choice/);
  assert.match(repeats, /default: '1'/);
  assert.deepEqual([...repeats.matchAll(/^\s+- '(\d)'$/gm)].map((m) => m[1]), ['1', '3']);
  assert.match(prEvalsJobs().plan, /REPEATS: \$\{\{ inputs\.repeats \|\| '1' \}\}/);
});

test('pr-evals.yml declares least-privilege permissions per job', () => {
  const text = prEvals();
  assert.match(text, /^permissions:\n  contents: read\n\n/m);
  const jobs = prEvalsJobs();
  assert.deepEqual(Object.keys(jobs), ['plan', 'eval', 'comment']);
  const perms = (job) => job.match(/\n    permissions:\n((?:      .+\n)+)/)?.[1].trim().split(/\n\s*/);
  assert.deepEqual(perms(jobs.plan), ['contents: read', 'pull-requests: read']);
  assert.deepEqual(perms(jobs.eval), ['contents: read']);
  assert.deepEqual(perms(jobs.comment), ['contents: read', 'pull-requests: write']);
  assert.doesNotMatch(text, /contents: write|pages: write|id-token: write|actions: write|issues: write/);
});

test('pr-evals.yml hands LLM secrets to the eval job only', () => {
  const jobs = prEvalsJobs();
  assert.match(jobs.eval, /secrets\.GROQ_API_KEY/);
  assert.match(jobs.eval, /secrets\.ANTHROPIC_API_KEY/);
  for (const name of ['plan', 'comment']) assert.doesNotMatch(jobs[name], /secrets\./, `${name} must not receive secrets`);
  assert.doesNotMatch(jobs.eval, /github\.token|GH_TOKEN|GITHUB_TOKEN/, 'the eval job holds no GitHub token in its env');
});

test('pr-evals.yml checks out the default branch only; the PR head is fetched as objects', () => {
  const text = prEvals();
  const checkouts = text.match(/uses: actions\/checkout@v4\n\s+with:\n(\s{10}.+\n)+/g) ?? [];
  assert.equal(checkouts.length, 3);
  for (const c of checkouts) assert.match(c, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(text, /ref: \$\{\{ github\.(event\.pull_request\.head|head_ref)/);
  assert.doesNotMatch(text, /github\.head_ref/);
  const jobs = prEvalsJobs();
  for (const name of ['eval', 'comment']) assert.match(jobs[name], /persist-credentials: false/, `${name} must not persist a credential`);
  assert.match(jobs.plan, /git fetch --no-tags origin "\+refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/pr\/head"/);
  assert.doesNotMatch(jobs.eval, /git (fetch|checkout|worktree)/, 'the eval job never touches the PR head');
});

test('pr-evals.yml eval job applies the PR prompts, runs the default-branch harness and never publishes', () => {
  const text = prEvals();
  const { eval: evalJob } = prEvalsJobs();
  assert.match(evalJob, /needs: plan\n    if: \$\{\{ needs\.plan\.outputs\.status == 'run' \}\}/);
  const apply = evalJob.indexOf('node scripts/plan_pr_evals.mjs apply --plan "$RUNNER_TEMP/pr-evals/plan.json"');
  const run = evalJob.indexOf('node scripts/run_evals.mjs --suite "$suite" --repeats "$REPEATS"');
  assert.ok(apply > 0 && run > apply, 'prompts are applied before the suites run');
  assert.doesNotMatch(text, /--scorecard|build_eval_site|deploy-pages|upload-pages-artifact|configure-pages|github-pages/);
  assert.doesNotMatch(text, /git (push|commit|add)\b/);
  assert.match(evalJob, /EVAL_HISTORY_FILE: \$\{\{ runner\.temp \}\}\//);
  assert.match(evalJob, /^    concurrency:\n      group: pr-evals-\$\{\{ needs\.plan\.outputs\.pr_number \}\}\n      cancel-in-progress: false$/m);
});

test('pr-evals.yml comment job reads the artifacts, comments and always removes the label', async () => {
  const { RUN_EVALS_LABEL } = await import('../lib/pr_evals.mjs');
  const { comment } = prEvalsJobs();
  assert.match(comment, /needs: \[plan, eval\]\n    if: \$\{\{ !cancelled\(\) && needs\.plan\.result != 'skipped' \}\}/);
  assert.match(comment, /name: pr-evals-plan-\$\{\{ github\.run_id \}\}/);
  assert.match(comment, /name: pr-evals-results-\$\{\{ github\.run_id \}\}/);
  assert.match(comment, /node scripts\/report_pr_evals\.mjs --plan /);
  assert.match(comment, /gh api "repos\/\$GITHUB_REPOSITORY\/issues\/\$PR_NUMBER\/comments" -F "body=@\$REPORT"/);
  assert.match(comment, new RegExp(`- name: Remove ${RUN_EVALS_LABEL} label\\n\\s+if: \\$\\{\\{ always\\(\\) && github\\.event_name == 'pull_request_target' \\}\\}`));
  assert.match(comment, new RegExp(`gh api -X DELETE "repos/\\$GITHUB_REPOSITORY/issues/\\$PR_NUMBER/labels/${RUN_EVALS_LABEL}"`));
});

test('pr-evals.yml passes event values through env, never interpolated into run scripts', () => {
  const text = prEvals();
  const runBlocks = [...text.matchAll(/^\s+run: (?:\||>-)?\n?((?:\s{10,}.+\n)+|.+)/gm)].map((m) => m[1]);
  assert.ok(runBlocks.length >= 6);
  for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/, `run script interpolates an expression: ${block.trim().slice(0, 80)}`);
});

test('pr-evals.yml keeps the observability contract in every job', () => {
  for (const [name, job] of Object.entries(prEvalsJobs())) {
    assert.match(job, /GITHUB_RUN_ID: \$\{\{ github\.run_id \}\}/, `${name}: GITHUB_RUN_ID`);
    assert.match(job, new RegExp(`- name: Upload run trace\\n\\s+if: always\\(\\)\\n\\s+uses: actions/upload-artifact@v4\\n\\s+with:\\n\\s+name: run-trace-\\$\\{\\{ github\\.run_id \\}\\}-${name}\\n`), `${name}: trace upload`);
    assert.match(job, /^    timeout-minutes: \d+$/m, `${name}: timeout`);
  }
});

// ---------------------------------------------------------------------------
// Pipeline views on the Pages site (ADR-0027 amendment, 2026-10-17)
// ---------------------------------------------------------------------------

const pipelineSite = () => readFileSync(resolve(WORKFLOWS_DIR, 'pipeline-site.yml'), 'utf8');
const metricsCheckout = /- name: Check out the metrics branch\n\s+uses: actions\/checkout@v\d+\n\s+with:\n\s+ref: metrics\n\s+path: \.metrics\n\s+persist-credentials: false\n\s+sparse-checkout: metrics\n/;

test('pipeline-site.yml rebuilds on the pipeline workflows completing, a push to metrics and a dispatch', () => {
  const text = pipelineSite();
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'));
  // Every workflow that commits a record, by its name: GITHUB_TOKEN commits create no push event.
  const committing = readWorkflows().filter(({ text: t }) => t.includes('name: Commit metrics')).map(({ text: t }) => t.match(/^name: (.+)$/m)[1]).sort();
  const listed = on.match(/workflows: \[([^\]]+)\]/)[1].split(',').map((w) => w.trim()).sort();
  assert.deepEqual(listed, committing);
  assert.match(on, /workflow_run:\n\s+workflows: \[[^\]]+\]\n\s+types: \[completed\]\n/);
  assert.match(on, /\n  push:\n    branches: \[metrics\]\n/);
  assert.match(on, /\n  workflow_dispatch:\n/);
  assert.doesNotMatch(on, /pull_request|issue_comment|schedule/);
});

test('pipeline-site.yml deploys Pages with contents: read, pages: write, id-token: write only, and no secret', () => {
  const text = pipelineSite();
  assert.match(text, /^permissions:\n  contents: read\n\n/m);
  const job = jobsOf(text).find((j) => j.name === 'publish').text;
  const perms = job.match(/\n    permissions:\n((?:      .+\n)+)/)[1].trim().split(/\n\s*/).sort();
  assert.deepEqual(perms, ['contents: read', 'id-token: write', 'pages: write']);
  assert.doesNotMatch(text, /secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN:/);
  assert.doesNotMatch(text, /git (push|add|commit)\b/);
  assert.match(job, /uses: actions\/upload-pages-artifact@v\d+/);
  assert.equal([...job.matchAll(/uses: actions\/deploy-pages@/g)].length, 1);
  assert.match(job, /name: github-pages/);
  assert.match(job, /^    timeout-minutes: \d+$/m);
});

test('pipeline-site.yml runs the default-branch builder only, reading the metrics branch as data', () => {
  const text = pipelineSite();
  const job = jobsOf(text).find((j) => j.name === 'publish').text;
  assert.match(job, /if: \$\{\{ github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/metrics'\) \}\}/);
  assert.match(job, /- uses: actions\/checkout@v\d+\n\s+with:\n\s+ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n\s+persist-credentials: false\n/);
  assert.match(job, metricsCheckout);
  // A workflow_run never checks out the triggering run's code.
  assert.doesNotMatch(text, /workflow_run\.head_(sha|branch)|github\.event\.workflow_run\.head/);
  assert.match(job, /args=\(--out "\$SITE_DIR" --pipeline-dir "\$PIPELINE_DIR" --site-url "\$SITE_URL"\)/);
  assert.match(job, /node scripts\/build_eval_site\.mjs "\$\{args\[@\]\}"\n/);
  assert.match(job, /PIPELINE_DIR: \$\{\{ github\.workspace \}\}\/\.metrics/);
  // An empty eval history is a manual opt-in, never the default of an unattended rebuild.
  assert.match(job, /^      INIT_SITE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.init_site \}\}$/m);
  assert.equal([...text.matchAll(/--allow-empty/g)].length, 1);
  assert.match(job, /if \[ "\$INIT_SITE" = "true" \]; then args\+=\(--allow-empty\); fi/);
  assert.doesNotMatch(job, /--previous-dir|restore_run_id/, 'restore stays an evals.yml input (ADR-0027)');
});

test('evals.yml and pipeline-site.yml deploy jobs share one never-cancelled Pages group', () => {
  const evalsPublish = evalsJobs().publish;
  const sitePublish = jobsOf(pipelineSite()).find((j) => j.name === 'publish').text;
  for (const [name, job] of [['evals.yml publish', evalsPublish], ['pipeline-site.yml publish', sitePublish]]) {
    assert.ok(job.includes(`    concurrency:\n      group: ${SITE_GROUP}\n      cancel-in-progress: false\n`), `${name} must join ${SITE_GROUP}`);
  }
  // At most one job of each side in the shared group (one running + one pending): GitHub's
  // one-pending-per-group rule can then never cancel a pending eval publish.
  assert.match(pipelineSite(), new RegExp(`^concurrency:\\n  group: ${SITE_WORKFLOW_GROUP.replace(/[$.{}]/g, '\\$&')}\\n  cancel-in-progress: false$`, 'm'));
  assert.match(evalsYml(), /^concurrency:\n  group: evals-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m);
  assert.equal([...readWorkflows().map(({ text }) => text).join('\n').matchAll(/uses: actions\/deploy-pages@/g)].length, 2, 'only these two jobs deploy Pages');
});

test('evals.yml publish rebuilds the pipeline views from the metrics branch, never from the site', () => {
  const publish = evalsJobs().publish;
  assert.match(publish, metricsCheckout);
  assert.match(publish, /PIPELINE_DIR: \$\{\{ github\.workspace \}\}\/\.metrics/);
  assert.ok(publish.indexOf('- name: Check out the metrics branch') < publish.indexOf('- name: Build eval dashboard'));
});

test('pipeline_health EVAL_CRONS mirror the evals.yml crons and their suites', async () => {
  const { EVAL_CRONS } = await import('../lib/pipeline_health.mjs');
  const cronSuites = evalsCronSuites();
  assert.deepEqual(Object.fromEntries(EVAL_CRONS.map((c) => [c.cron, c.suite])), cronSuites);
  for (const c of EVAL_CRONS) assert.equal(Number(c.cron.split(' ')[4]), c.weekday);
});

// Audit 2026-10-19 F04/F28: a fixed heredoc delimiter lets a value line close the block and forge outputs.
test('no workflow writes a fixed heredoc delimiter to GITHUB_OUTPUT', () => {
  for (const { name, text } of readWorkflows()) {
    const fixed = [...text.matchAll(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g)]
      .filter((m) => /^\s*(echo|printf)\b/.test(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index)));
    assert.deepEqual(fixed.map((m) => m[0]), [], `${name} writes a fixed heredoc delimiter to an output file`);
  }
});

test('code-generation.yml writes the issue body and title with a random delimiter, number/labels last', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'code-generation.yml'), 'utf8');
  assert.ok(!text.includes('__DELIM__'), 'fixed __DELIM__ delimiter must be gone');
  assert.match(text, /DELIM="ghadelim_\$\(openssl rand -hex 16\)"/);
  const step = text.slice(text.indexOf('- name: Resolve issue data'), text.indexOf('- name: Download checkpoint artifact'));
  assert.ok(!step.includes('${{ github.event.issue.body'), 'the body must never be interpolated into the script');
  const order = ['echo "body<<$DELIM"', 'echo "title<<$DELIM"', 'echo "number=$NUMBER"', 'echo "labels=$LABELS"'].map((l) => step.indexOf(l));
  assert.ok(order.every((i) => i >= 0), `missing output writes: ${order}`);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'heredocs first, single-line control outputs last');
  assert.equal((step.match(/echo "\$DELIM"/g) || []).length, 2, 'each heredoc closes with the random delimiter');
});

// ---------------------------------------------------------------------------
// Workflow hardening (audit 2026-10-19 F14, F15; ADR-0007 amendment 2026-10-20)
// ---------------------------------------------------------------------------

// Every `run:` script of a workflow, block scalars included: [{ line, body }].
function runScripts(text) {
  const lines = text.split('\n');
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (!/^[|>]/.test(m[2])) { scripts.push({ line: i + 1, body: m[2] }); continue; }
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].match(/^\s*/)[0].length > m[1].length); j++) body.push(lines[j]);
    scripts.push({ line: i + 1, body: body.join('\n') });
  }
  return scripts;
}

// Attacker-influenced values (ref names, titles, bodies, comment text): expanded into a script, they
// are shell source. They reach a `run:` through `env:` and a quoted variable only.
const UNTRUSTED_EXPRESSIONS = [
  'github.ref_name',
  'github.head_ref',
  'github.event.pull_request.head.ref',
  'github.event.pull_request.title',
  'github.event.pull_request.body',
  'github.event.issue.title',
  'github.event.issue.body',
  'github.event.comment.body',
];

test('no run: script interpolates a ref name, title, body or comment text (audit F14)', () => {
  let scanned = 0;
  for (const { name, text } of readWorkflows()) {
    for (const { line, body } of runScripts(text)) {
      scanned++;
      for (const expr of UNTRUSTED_EXPRESSIONS) {
        const pattern = new RegExp(`\\$\\{\\{[^}]*${expr.replace(/\./g, '\\.')}\\b[^}]*\\}\\}`);
        assert.doesNotMatch(body, pattern, `${name}:${line} interpolates ${expr} into a run: script; pass it through env:`);
      }
    }
  }
  assert.ok(scanned > 50, `expected to scan every run: script, scanned ${scanned}`);
});

test('the run: script scanner sees one-line and block scripts', () => {
  const sample = 'steps:\n  - run: echo "${{ github.head_ref }}"\n  - name: x\n    run: |\n      A=1\n      echo "${{ github.event.comment.body }}"\n    env:\n      B: ${{ github.ref_name }}\n';
  const scripts = runScripts(sample);
  assert.equal(scripts.length, 2);
  assert.match(scripts[0].body, /github\.head_ref/);
  assert.match(scripts[1].body, /github\.event\.comment\.body/);
  assert.ok(!scripts.some((s) => s.body.includes('ref_name')), 'env: values are not part of the script');
});

test('pr-review.yml passes the branch to its shell steps through env (audit F14)', () => {
  const text = readFileSync(resolve(WORKFLOWS_DIR, 'pr-review.yml'), 'utf8');
  const step = (name) => text.slice(text.indexOf(`- name: ${name}`)).split(/\n      - (?:name|uses): /)[0];
  assert.match(step('Resolve PR number for checkpoint'), /\n\s+BRANCH: \$\{\{ github\.ref_name \}\}\n/);
  assert.match(step('Find latest auto-fix run for checkpoint'), /\n\s+BRANCH: \$\{\{ github\.event\.pull_request\.head\.ref \|\| github\.ref_name \}\}\n/);
  for (const name of ['Resolve PR number for checkpoint', 'Find latest auto-fix run for checkpoint']) {
    assert.match(step(name), /--head "\$BRANCH"|--branch "\$BRANCH"/, `${name} uses the quoted variable`);
  }
});

// `gh workflow run` (a dispatch) is the only call that needs actions: write; listing runs and
// downloading artifacts need actions: read.
const ACTIONS_WRITE_ALLOWED = {
  // Trigger Code Generation step: POST /actions/workflows/code-generation.yml/dispatches (ADR-0007 amendment).
  'validate-issue.yml': 1,
};

test('no workflow grants actions: write, except the validate-issue dispatch (audit F15)', () => {
  for (const { name, text } of readWorkflows()) {
    const count = (text.match(/^\s+actions:\s*write\b/gm) ?? []).length;
    assert.equal(count, ACTIONS_WRITE_ALLOWED[name] ?? 0, `${name} grants actions: write ${count} time(s)`);
  }
  const validate = readFileSync(resolve(WORKFLOWS_DIR, 'validate-issue.yml'), 'utf8');
  assert.match(validate, /gh workflow run code-generation\.yml/, 'the allowed actions: write is for the dispatch');
});

const workflowPermissions = (text) => text.match(/^permissions:\s*(\{\}|\n((?: {2}.+\n)+))/m);

test('multi-job workflows grant write scopes per job, never workflow-level (audit F15)', () => {
  let multiJob = 0;
  for (const { name, text } of readWorkflows()) {
    const jobsBlock = text.slice(text.search(/^jobs:\n/m));
    const jobs = jobsBlock.match(/^ {2}[A-Za-z0-9_-]+:\s*$/gm) ?? [];
    const perms = workflowPermissions(text);
    if (jobs.length < 2) continue;
    multiJob++;
    assert.ok(perms, `${name}: declare a read-only workflow-level permissions block`);
    assert.doesNotMatch(perms[0], /:\s*write\b|write-all/, `${name}: workflow-level permissions grant a write scope`);
  }
  assert.ok(multiJob >= 7, `expected the multi-job workflows to be scanned, saw ${multiJob}`);
});

test('pipeline workflows declare the inventoried scopes per job (ADR-0007 amendment)', () => {
  const expected = {
    'pr-review.yml': { evidence: ['contents: read'], review: ['actions: read', 'contents: write', 'issues: write', 'pull-requests: write'] },
    'auto-fix-pr.yml': { 'load-labels': ['contents: read', 'pull-requests: read'], 'auto-fix': ['actions: read', 'contents: write', 'issues: write', 'pull-requests: write'] },
    'code-generation.yml': { 'load-labels': ['contents: read'], 'generate-pr': ['actions: read', 'contents: write', 'issues: write', 'pull-requests: write'] },
    'validate-issue.yml': { validate: ['actions: write', 'contents: write', 'issues: write'] },
    'reset-auto-fix.yml': { resolve: ['pull-requests: read'], reset: ['contents: write', 'issues: write', 'pull-requests: write'] },
  };
  for (const [name, jobs] of Object.entries(expected)) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.match(text, /^permissions:\n  contents: read\n/m, `${name}: workflow-level default is contents: read`);
    const jobsBlock = text.slice(text.search(/^jobs:\n/m));
    const parts = jobsBlock.split(/^ {2}(?=[A-Za-z0-9_-]+:\s*$)/m).slice(1);
    const byName = Object.fromEntries(parts.map((p) => [p.slice(0, p.indexOf(':')), p]));
    assert.deepEqual(Object.keys(byName).sort(), Object.keys(jobs).sort(), `${name}: jobs`);
    for (const [job, scopes] of Object.entries(jobs)) {
      const block = byName[job].match(/\n {4}permissions:\n((?: {6}.+\n)+)/)?.[1] ?? '';
      const got = block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).sort();
      assert.deepEqual(got, scopes, `${name} ${job}: permissions`);
    }
  }
});

test('jobs that never git push check out without persisting the token (audit F15)', () => {
  const checkouts = (text) => text.match(/uses: actions\/checkout@v4(\n\s+with:(\n\s{10}.+)+)?/g) ?? [];
  for (const name of ['validate-issue.yml', 'code-generation.yml', 'reset-auto-fix.yml']) {
    const text = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8');
    assert.ok(!runScripts(text).some(({ body }) => /\bgit push\b/.test(body)), `${name} has no git push`);
    const found = checkouts(text);
    assert.ok(found.length > 0, `${name}: expected a checkout`);
    for (const c of found) assert.match(c, /persist-credentials: false/, `${name}: ${c}`);
  }
  // auto-fix pushes with the credential persisted by its PR-branch checkout (AI_PR_TOKEN || GITHUB_TOKEN).
  const autofix = readFileSync(resolve(WORKFLOWS_DIR, 'auto-fix-pr.yml'), 'utf8');
  const prCheckout = autofix.slice(autofix.indexOf('- name: Checkout PR branch'), autofix.indexOf('- name: Checkout trusted pipeline'));
  assert.match(prCheckout, /token: \$\{\{ secrets\.AI_PR_TOKEN \|\| secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(prCheckout, /persist-credentials: false/, 'the auto-fix push needs the persisted credential');
  assert.match(autofix, /git push origin HEAD:"\$\{PR_BRANCH\}"/);
});
