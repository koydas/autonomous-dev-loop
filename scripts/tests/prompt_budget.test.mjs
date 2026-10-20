import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlatYaml } from '../lib/yaml.mjs';
import {
  PROMPT_STAGES, LOW_HEADROOM_RATIO, promptTokens, stageBudget, changedPrompts, computePromptBudgetImpact,
  formatPromptBudgetContext, formatPromptBudgetSection,
} from '../lib/prompt_budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODELS = { review_max_input_tokens: '6300', review_max_tokens: '1024', autofix_max_input_tokens: '2600', autofix_max_tokens: '4096' };
const chars = (tokens) => 'x'.repeat(tokens * 4);
const diffFor = (file, header = '') => `diff --git a/${file} b/${file}\n${header}--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
const silent = () => {};
const run = ({ rawDiff, base = {}, head = {}, models = MODELS, ...rest }) => computePromptBudgetImpact({
  rawDiff, readBase: (p) => base[p], readHead: (p) => head[p] ?? null, models, logFn: silent, ...rest,
});

// mapping and helpers

test('PROMPT_STAGES maps every prompts/*.md loaded by a stage, auto-fix-system on the TPM window', () => {
  assert.deepEqual(Object.keys(PROMPT_STAGES).sort(), [
    'prompts/auto-fix-system.md', 'prompts/auto-fix-user.md', 'prompts/generation-system.md', 'prompts/generation-user.md',
    'prompts/pr-review-repo-rules.md', 'prompts/pr-review-system.md', 'prompts/pr-review-user.md', 'prompts/validation-system.md', 'prompts/validation-user.md',
  ]);
  assert.deepEqual(readdirSync(resolve(ROOT, 'prompts')).filter((f) => f.endsWith('.md')).map((f) => `prompts/${f}`).sort(), Object.keys(PROMPT_STAGES).sort(),
    'a prompts/*.md file is missing from PROMPT_STAGES (or the map names a file that does not exist)');
  assert.deepEqual(PROMPT_STAGES['prompts/auto-fix-system.md'], [{ stage: 'autofix', budget: 'tpm' }]);
  const models = parseFlatYaml(readFileSync(resolve(ROOT, 'config/models.yaml'), 'utf8'));
  for (const list of Object.values(PROMPT_STAGES)) {
    for (const { stage } of list) assert.ok(models[`${stage}_max_input_tokens`], `config/models.yaml has no ${stage}_max_input_tokens`);
  }
});

test('promptTokens ignores {{placeholders}} and missing content', () => {
  assert.equal(promptTokens('abcd{{diff}}efgh'), 2);
  assert.equal(promptTokens(null), 0);
});

test('stageBudget reads <stage>_max_input_tokens, the TPM bound for a tpm prompt, null when not configured', () => {
  assert.deepEqual(stageBudget(MODELS, 'review', 'input'), { maxInputTokens: 6300, reserved: 0 });
  assert.deepEqual(stageBudget(MODELS, 'autofix', 'tpm'), { maxInputTokens: Math.floor((8000 - 4096) / 1.1), reserved: 2600 });
  assert.deepEqual(stageBudget({}, 'review', 'input'), { maxInputTokens: null, reserved: 0 });
  assert.deepEqual(stageBudget({ review_max_input_tokens: 'abc' }, 'review', 'input'), { maxInputTokens: null, reserved: 0 });
  assert.deepEqual(stageBudget({ autofix_max_input_tokens: '2600' }, 'autofix', 'tpm'), { maxInputTokens: null, reserved: 0 });
  assert.deepEqual(stageBudget(undefined, 'autofix', 'tpm'), { maxInputTokens: null, reserved: 0 });
});

test('changedPrompts keeps top-level prompts/*.md only, with added and deleted flags', () => {
  const diff = diffFor('prompts/a.md') + diffFor('prompts/new.md', 'new file mode 100644\n') + diffFor('prompts/old.md', 'deleted file mode 100644\n')
    + diffFor('prompts/sub/x.md') + diffFor('docs/prompts/y.md') + diffFor('scripts/a.mjs');
  assert.deepEqual(changedPrompts(diff), [
    { path: 'prompts/a.md', basePath: 'prompts/a.md', added: false, deleted: false },
    { path: 'prompts/new.md', basePath: 'prompts/new.md', added: true, deleted: false },
    { path: 'prompts/old.md', basePath: 'prompts/old.md', added: false, deleted: true },
  ]);
  assert.deepEqual(changedPrompts(undefined), []);
});

// computePromptBudgetImpact

test('a renamed prompt is read from the base at its old path, without failing the other prompts', () => {
  const rename = 'diff --git a/prompts/old-review.md b/prompts/pr-review-user.md\nsimilarity index 90%\nrename from prompts/old-review.md\nrename to prompts/pr-review-user.md\n--- a/prompts/old-review.md\n+++ b/prompts/pr-review-user.md\n@@ -1 +1 @@\n-a\n+b\n';
  const base = { 'prompts/old-review.md': chars(200), 'prompts/pr-review-system.md': chars(2000) };
  const head = { 'prompts/pr-review-user.md': chars(250), 'prompts/pr-review-system.md': chars(2100) };
  const readBase = (p) => {
    if (!(p in base)) throw new Error(`fatal: path '${p}' does not exist in base`);
    return base[p];
  };
  const r = run({ rawDiff: rename + diffFor('prompts/pr-review-system.md'), head, readBase });
  assert.deepEqual(r.map((x) => [x.prompt, x.deltaTokens]), [['prompts/pr-review-user.md', 50], ['prompts/pr-review-system.md', 100]]);
});

test('a prompt that grows reports a positive delta and the headroom left by all the stage prompts', () => {
  const head = { 'prompts/pr-review-system.md': chars(2173), 'prompts/pr-review-user.md': chars(238) };
  const [r] = run({ rawDiff: diffFor('prompts/pr-review-system.md'), base: { 'prompts/pr-review-system.md': chars(1890) }, head });
  assert.deepEqual(r, {
    prompt: 'prompts/pr-review-system.md', stage: 'review', budget: 'input', deltaTokens: 283, headTokens: 2173,
    maxInputTokens: 6300, headroomTokens: 6300 - 2173 - 238, lowHeadroom: false,
  });
});

test('a prompt that shrinks reports a negative delta', () => {
  const [r] = run({ rawDiff: diffFor('prompts/pr-review-user.md'), base: { 'prompts/pr-review-user.md': chars(300) }, head: { 'prompts/pr-review-user.md': chars(200) } });
  assert.equal(r.deltaTokens, -100);
  assert.equal(r.headroomTokens, 6100);
});

test('a new prompt has no base: the delta is its full size, and readBase is not called', () => {
  const promptStages = { 'prompts/new.md': [{ stage: 'review', budget: 'input' }] };
  const [r] = run({
    rawDiff: diffFor('prompts/new.md', 'new file mode 100644\n'), head: { 'prompts/new.md': chars(50) }, promptStages,
    readBase: () => { throw new Error('must not be called'); },
  });
  assert.deepEqual([r.deltaTokens, r.headTokens, r.headroomTokens], [50, 50, 6250]);
});

test('a deleted prompt costs nothing on the head side, also when another changed prompt sums it', () => {
  const promptStages = { 'prompts/a.md': [{ stage: 'review', budget: 'input' }], 'prompts/b.md': [{ stage: 'review', budget: 'input' }] };
  const rawDiff = diffFor('prompts/a.md') + diffFor('prompts/b.md', 'deleted file mode 100644\n');
  const readHead = (p) => {
    if (p === 'prompts/b.md') throw new Error('deleted: must not be read');
    return chars(100);
  };
  const r = run({ rawDiff, base: { 'prompts/a.md': chars(100), 'prompts/b.md': chars(40) }, promptStages, readHead });
  assert.deepEqual(r.map((x) => [x.prompt, x.deltaTokens, x.headTokens, x.headroomTokens]), [['prompts/a.md', 0, 100, 6200], ['prompts/b.md', -40, 0, 6200]]);
});

test('a prompt whose stage has no input budget configured reports null budget and headroom', () => {
  const [r] = run({ rawDiff: diffFor('prompts/pr-review-system.md'), base: { 'prompts/pr-review-system.md': chars(10) }, head: { 'prompts/pr-review-system.md': chars(20) }, models: {} });
  assert.deepEqual([r.stage, r.deltaTokens, r.maxInputTokens, r.headroomTokens, r.lowHeadroom], ['review', 10, null, null, false]);
});

test('a prompt no stage loads reports stage null', () => {
  const [r] = run({ rawDiff: diffFor('prompts/notes.md'), base: { 'prompts/notes.md': '' }, head: { 'prompts/notes.md': chars(5) } });
  assert.deepEqual([r.stage, r.budget, r.deltaTokens, r.maxInputTokens, r.headroomTokens], [null, null, 5, null, null]);
});

test('a prompt shared by several stages reports one entry per stage, each against its own budget', () => {
  const promptStages = {
    'prompts/shared.md': [{ stage: 'review', budget: 'input' }, { stage: 'autofix', budget: 'input' }],
    'prompts/pr-review-user.md': [{ stage: 'review', budget: 'input' }],
  };
  const head = { 'prompts/shared.md': chars(400), 'prompts/pr-review-user.md': chars(100) };
  const r = run({ rawDiff: diffFor('prompts/shared.md'), base: { 'prompts/shared.md': chars(300) }, head, promptStages });
  assert.deepEqual(r.map((x) => [x.stage, x.deltaTokens, x.maxInputTokens, x.headroomTokens]), [['review', 100, 6300, 5800], ['autofix', 100, 2600, 2200]]);
});

test('auto-fix-system.md is measured against the TPM window, on top of autofix_max_input_tokens', () => {
  const [r] = run({ rawDiff: diffFor('prompts/auto-fix-system.md'), base: { 'prompts/auto-fix-system.md': chars(850) }, head: { 'prompts/auto-fix-system.md': chars(890) } });
  const tpmInput = Math.floor((8000 - 4096) / 1.1);
  assert.deepEqual([r.budget, r.maxInputTokens, r.headroomTokens, r.lowHeadroom], ['tpm', tpmInput, tpmInput - 2600 - 890, true]);
});

test('lowHeadroom is set under 10% of the budget left, not at or above it', () => {
  const at = (headTokens) => run({ rawDiff: diffFor('prompts/pr-review-user.md'), base: { 'prompts/pr-review-user.md': '' }, head: { 'prompts/pr-review-user.md': chars(headTokens) } })[0];
  assert.equal(LOW_HEADROOM_RATIO, 0.1);
  assert.deepEqual([at(5670).headroomTokens, at(5670).lowHeadroom], [630, false]);
  assert.deepEqual([at(5671).headroomTokens, at(5671).lowHeadroom], [629, true]);
  const over = at(7000);
  assert.deepEqual([over.headroomTokens, over.lowHeadroom], [-700, true]);
});

test('the threshold ratio is configurable', () => {
  const [r] = run({ rawDiff: diffFor('prompts/pr-review-user.md'), base: { 'prompts/pr-review-user.md': '' }, head: { 'prompts/pr-review-user.md': chars(5000) }, lowHeadroomRatio: 0.25 });
  assert.deepEqual([r.headroomTokens, r.lowHeadroom], [1300, true]);
});

test('computePromptBudgetImpact returns [] without changed prompts, without reading anything', () => {
  const failing = () => { throw new Error('must not be called'); };
  assert.deepEqual(computePromptBudgetImpact({ rawDiff: diffFor('scripts/a.mjs'), readBase: failing, readHead: failing, models: MODELS }), []);
});

test('a read error returns [] and logs a warn event', () => {
  const events = [];
  const r = computePromptBudgetImpact({
    rawDiff: diffFor('prompts/pr-review-system.md'),
    readBase: () => { throw new Error('fatal: invalid object name'); },
    readHead: () => 'x',
    models: MODELS,
    logFn: (e) => events.push(e),
  });
  assert.deepEqual(r, []);
  assert.deepEqual(events, [{ stage: 'review', event: 'review.prompt_budget_error', level: 'warn', meta: { error: 'fatal: invalid object name' } }]);
});

test('a read error logs through observability by default', () => {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    assert.deepEqual(computePromptBudgetImpact({ rawDiff: diffFor('prompts/a.md'), readBase: () => { throw new Error('boom'); }, readHead: () => '', models: MODELS }), []);
  } finally {
    process.stderr.write = original;
  }
  assert.match(writes.join(''), /"event":"review\.prompt_budget_error".*"level":"warn"/);
});

// formatting

const IMPACTS = [
  { prompt: 'prompts/pr-review-system.md', stage: 'review', budget: 'input', deltaTokens: 283, headTokens: 2173, maxInputTokens: 6300, headroomTokens: 3889, lowHeadroom: false },
  { prompt: 'prompts/auto-fix-system.md', stage: 'autofix', budget: 'tpm', deltaTokens: -12, headTokens: 890, maxInputTokens: 3549, headroomTokens: 59, lowHeadroom: true },
  { prompt: 'prompts/x.md', stage: 'review', budget: 'input', deltaTokens: 0, headTokens: 5, maxInputTokens: null, headroomTokens: null, lowHeadroom: false },
  { prompt: 'prompts/notes.md', stage: null, budget: null, deltaTokens: 5, headTokens: 5, maxInputTokens: null, headroomTokens: null, lowHeadroom: false },
];

test('formatPromptBudgetContext and formatPromptBudgetSection are empty without impacts', () => {
  for (const v of [[], undefined]) {
    assert.equal(formatPromptBudgetContext(v), '');
    assert.equal(formatPromptBudgetSection(v), '');
  }
});

test('formatPromptBudgetContext describes each case and flags low headroom', () => {
  const ctx = formatPromptBudgetContext(IMPACTS);
  assert.match(ctx, /^\n\n## Prompt budget impact/);
  assert.match(ctx, /LOW HEADROOM: under 10% of the budget left\./);
  assert.match(ctx, /- prompts\/pr-review-system\.md: \+283 tokens \(now 2173\) — stage `review`, review_max_input_tokens 6300: 3889 tokens left for the variable input\n/);
  assert.match(ctx, /- prompts\/auto-fix-system\.md: -12 tokens \(now 890\) — stage `autofix`, TPM-bounded input 3549 \(on top of autofix_max_input_tokens\): 59 tokens left for the variable input ⚠️ LOW HEADROOM/);
  assert.match(ctx, /- prompts\/x\.md: 0 tokens \(now 5\) — stage `review`: no input budget configured/);
  assert.match(ctx, /- prompts\/notes\.md: \+5 tokens \(now 5\) — not loaded by any pipeline stage$/);
  assert.match(formatPromptBudgetContext(IMPACTS, { lowHeadroomRatio: 0.2 }), /under 20%/);
});

test('formatPromptBudgetSection renders a table and a warning only when headroom is low', () => {
  const section = formatPromptBudgetSection(IMPACTS);
  assert.match(section, /^\n### 📏 Prompt Budget Impact\n\| Prompt \| Stage \|/);
  assert.match(section, /\| `prompts\/pr-review-system\.md` \| review \| \+283 \| 2173 \| 6300 \| 3889 \|/);
  assert.match(section, /\| `prompts\/auto-fix-system\.md` \| autofix \| -12 \| 890 \| 3549 \(TPM\) \| 59 ⚠️ \|/);
  assert.match(section, /\| `prompts\/notes\.md` \| — \| \+5 \| 5 \| — \| — \|/);
  assert.match(section, /> ⚠️ Headroom under 10% of the stage budget/);
  assert.doesNotMatch(formatPromptBudgetSection([IMPACTS[0]]), /⚠️/);
});
