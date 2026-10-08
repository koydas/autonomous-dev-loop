import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/test.yml'), 'utf8');

const GATED_MODULES = ['checkpoint.mjs', 'config.mjs', 'llm_client.mjs', 'output_writer.mjs', 'review_evidence.mjs', 'eval_harness.mjs', 'eval_scorecard.mjs', 'eval_site.mjs', 'eval_suites.mjs', 'review_prompt.mjs', 'eval_replay_ci.mjs', 'pr_evals.mjs', 'issue_validator.mjs'];

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
    ['output_writer.mjs', 'output_writer.test.mjs'],
    ['review_evidence.mjs', 'review_evidence.test.mjs'],
    ['eval_harness.mjs', 'eval_harness.test.mjs'],
    ['eval_scorecard.mjs', 'eval_scorecard.test.mjs'],
    ['eval_site.mjs', 'eval_site.test.mjs'],
    ['eval_replay_ci.mjs', 'eval_replay_ci.test.mjs'],
    ['pr_evals.mjs', 'pr_evals.test.mjs'],
    ['issue_validator.mjs', 'issue_validator.test.mjs'],
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
const MUTATING_WORKFLOWS = ['auto-fix-pr.yml', 'pr-review.yml', 'code-generation.yml', 'validate-issue.yml', 'reset-auto-fix.yml', 'evals.yml', 'pr-evals.yml'];
// Triggers fire for unrelated labels/comments too; a workflow-level group would let a
// skipped run replace the pending real one, so the group must sit on the gated job.
const JOB_LEVEL_CONCURRENCY = ['auto-fix-pr.yml', 'code-generation.yml', 'pr-evals.yml'];

test('every workflow declares a concurrency group keyed per PR/issue', () => {
  const workflows = readWorkflows();
  assert.equal(workflows.length, 10, `expected 10 workflows, found ${workflows.map((w) => w.name).join(', ')}`);
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
  assert.match(text, /args=\(--out "\$SITE_DIR"\)/);
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

test('evals.yml runs weekly on Monday morning UTC, off the hour', () => {
  const crons = [...evalsYml().matchAll(/^\s+- cron: '([^']+)'$/gm)].map((m) => m[1]);
  assert.equal(crons.length, 1);
  const [minute, hour, dom, month, dow] = crons[0].split(' ');
  assert.ok(Number(minute) % 15 !== 0, `minute ${minute} must not be round (GitHub delays :00 schedules)`);
  assert.ok(Number(hour) >= 5 && Number(hour) <= 7, `hour ${hour} must be about 06:00 UTC`);
  assert.deepEqual([dom, month, dow], ['*', '*', '1']);
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

test('evals.yml schedule runs every registered suite, one at a time, each under its own run_id', async () => {
  const { SUITES } = await import('../lib/eval_suites.mjs');
  const job = evalsJobs().eval;
  const matrix = job.match(/suite: \$\{\{ fromJSON\(github\.event_name == 'schedule' && '(\[[^']+\])' \|\| format\('\["\{0\}"\]', inputs\.suite\)\) \}\}/);
  assert.ok(matrix, 'matrix: every suite on schedule, the chosen one on dispatch');
  assert.deepEqual(JSON.parse(matrix[1]), Object.keys(SUITES));
  assert.match(job, /max-parallel: 1\n/, 'suites share the 8K TPM: never in parallel');
  assert.match(job, /fail-fast: false\n/, 'a failing suite must not cancel the next one');
  assert.match(job, /SUITE: \$\{\{ matrix\.suite \}\}/);
  assert.match(job, /EVAL_RUN_ID: \$\{\{ github\.run_id \}\}-\$\{\{ matrix\.suite \}\}/);
  assert.match(job, /name: eval-results-\$\{\{ github\.run_id \}\}-\$\{\{ matrix\.suite \}\}\n/);
  assert.match(job, /name: run-trace-\$\{\{ github\.run_id \}\}-\$\{\{ matrix\.suite \}\}\n/);
  // Every suite, worst case, within the per-suite job timeout.
  assert.ok(Number(job.match(/^    timeout-minutes: (\d+)$/m)[1]) >= 90);
});

test('evals.yml publishes every suite of the run in one Pages deploy', () => {
  const publish = evalsJobs().publish;
  assert.match(publish, /pattern: eval-results-\$\{\{ github\.run_id \}\}-\*\n\s+merge-multiple: true\n/);
  assert.equal([...publish.matchAll(/uses: actions\/deploy-pages@/g)].length, 1);
  assert.match(publish, /needs: eval\n/);
  assert.match(publish, /^    timeout-minutes: \d+$/m);
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
