import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVERS, NO_LEVER, leverFor, ruleKey, forbiddenTarget } from '../lib/meta_levers.mjs';
import { diagnose } from '../lib/pipeline_diagnostics.mjs';
import { SUITES } from '../lib/eval_suites.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

// The rule ids declared in pipeline_diagnostics.mjs: `finding({ id: 'x'` (one rule) or ``finding({ id: `x-${…}` ``
// (a family). Telemetry gaps also have an `id` but are never built with finding().
function declaredRules() {
  const keys = new Set();
  for (const [, , id, dynamic] of read('scripts/lib/pipeline_diagnostics.mjs').matchAll(/finding\(\{\s*id: (['`])([^'`$]+)(\$\{)?/g)) keys.add(dynamic ? `${id}*` : id);
  return keys;
}

test('every diagnostic rule has a lever or an explained absence, and no entry is stale', () => {
  const rules = declaredRules();
  assert.ok(rules.size >= 11, `the scan found ${[...rules]}`);
  for (const rule of rules) {
    const inLevers = rule in LEVERS;
    const inNone = rule in NO_LEVER;
    assert.ok(inLevers || inNone, `rule ${rule} is neither mapped in LEVERS nor listed in NO_LEVER: decide and say why`);
    assert.ok(!(inLevers && inNone), `rule ${rule} is in both tables`);
  }
  for (const key of [...Object.keys(LEVERS), ...Object.keys(NO_LEVER)]) assert.ok(rules.has(key), `${key} names no rule of pipeline_diagnostics.mjs`);
  for (const [key, reason] of Object.entries(NO_LEVER)) assert.ok(reason.length > 10, `${key} needs a reason`);
});

test('ruleKey folds the rules that carry a stage into their family; other ids are unchanged', () => {
  assert.equal(ruleKey('duration-review'), 'duration-*');
  assert.equal(ruleKey('stage-failures-issue_validation'), 'stage-failures-*');
  assert.equal(ruleKey('review-withheld'), 'review-withheld');
  assert.equal(ruleKey(undefined), undefined);
});

test('no lever points at a gate, a floor, a pipeline definition or a credential (ADR-0046 §5)', () => {
  for (const [rule, lever] of Object.entries(LEVERS)) {
    for (const t of lever.targets) assert.equal(forbiddenTarget(t.ref), null, `${rule}: ${t.ref} is a forbidden target`);
  }
  const forbidden = ['.github/workflows/pr-review.yml', 'config/protected-paths.yaml', 'evals/review/dataset.jsonl', 'config/models.yaml#review_eval_threshold', 'evals/thresholds.json',
    'config/labels.yaml#attempt3', 'auto-fix-attempt-3', 'secrets.ANTHROPIC_API_KEY', 'AI_PR_TOKEN', 'GROQ_API_KEY', '.env', 'config/dataset.yaml#floor'];
  for (const ref of forbidden) assert.notEqual(forbiddenTarget(ref), null, `${ref} should be refused`);
  // The budgets named "tokens" are ordinary settings, not credentials.
  assert.equal(forbiddenTarget('config/models.yaml#review_max_input_tokens'), null);
  assert.equal(forbiddenTarget(undefined), null);
});

test('every target resolves: config key in its file, prompt file, repository variable, eval suite', () => {
  const workflows = readdirSync(resolve(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).map((f) => read(`.github/workflows/${f}`)).join('\n');
  for (const [rule, lever] of Object.entries(LEVERS)) {
    assert.ok(lever.targets.length > 0 && lever.adr.length > 0 && lever.summary && lever.stage, `${rule} is complete`);
    for (const t of lever.targets) {
      const at = `${rule}: ${t.ref}`;
      if (t.kind === 'config') {
        const m = /^config\/([\w-]+\.yaml)#([\w.]+)$/.exec(t.ref);
        assert.ok(m, `${at} is not config/<file>.yaml#<key>`);
        assert.ok(existsSync(resolve(ROOT, 'config', m[1])), `${at}: file missing`);
        assert.match(read(`config/${m[1]}`), new RegExp(`^${m[2].split('.')[0]}:`, 'm'), `${at}: key missing`);
      } else if (t.kind === 'prompt') {
        assert.match(t.ref, /^prompts\/[\w-]+\.md$/, at);
        assert.ok(existsSync(resolve(ROOT, t.ref)), `${at}: file missing`);
      } else if (t.kind === 'variable') {
        assert.ok(workflows.includes(t.ref.replace('<STAGE>', '')), `${at}: no workflow reads this variable`);
      } else {
        assert.ok(['policy', 'external'].includes(t.kind), `${at}: unknown kind ${t.kind}`);
      }
      assert.ok(t.gate === null || t.gate in SUITES, `${at}: gate ${t.gate} is not an eval suite`);
    }
  }
  // Generation and auto-fix prompts have no suite (docs/evals.md): their lever says so instead of naming a gate.
  const gateOf = (rule, ref) => LEVERS[rule].targets.find((t) => t.ref === ref).gate;
  assert.equal(gateOf('autofix-ineffective', 'prompts/auto-fix-system.md'), null);
  assert.equal(gateOf('codegen-blocked', 'prompts/generation-system.md'), null);
  assert.equal(gateOf('codegen-blocked', 'prompts/validation-system.md'), 'validation');
});

test('the tables are frozen and leverFor hands out copies', () => {
  assert.ok(Object.isFrozen(LEVERS) && Object.isFrozen(NO_LEVER) && Object.isFrozen(LEVERS['review-coverage']) && Object.isFrozen(LEVERS['review-coverage'].targets) && Object.isFrozen(LEVERS['review-coverage'].targets[0]));
  const lever = leverFor({ id: 'review-coverage', status: 'active', severity: 'warning' });
  lever.targets[0].ref = 'changed';
  lever.targets.push({});
  lever.adr.push('9999');
  lever.requires.length = 0;
  const again = leverFor({ id: 'review-coverage', status: 'active', severity: 'warning' });
  assert.equal(again.targets[0].ref, 'config/models.yaml#review_max_input_tokens');
  assert.deepEqual(again.adr, ['0028', '0038']);
  assert.equal(again.requires.length, 2);
});

test('leverFor: an active warning or critical finding of a mapped rule gets the lever, unverified', () => {
  for (const severity of ['warning', 'critical']) {
    const lever = leverFor({ id: 'review-coverage', status: 'active', severity });
    assert.equal(lever.stage, 'review');
    assert.equal(lever.verified, false);
    assert.deepEqual(lever.targets.map((t) => t.ref), ['config/models.yaml#review_max_input_tokens', 'config/models.yaml#anthropic_review_max_diff_chars', 'AI_PROVIDER_REVIEW']);
    assert.ok(lever.targets.every((t) => t.gate === 'review' && t.requires === 'evals'));
    assert.deepEqual(lever.requires, ['evals', 'docs-and-tests']);
  }
  // Requirements are per target: a stage can have a suite for one prompt and none for another.
  const gen = leverFor({ id: 'codegen-blocked', status: 'active', severity: 'warning' });
  assert.deepEqual(gen.targets.map((t) => [t.ref.split('#').at(-1), t.requires]), [['generation_max_input_tokens', 'no-eval-gate'], ['prompts/generation-system.md', 'no-eval-gate'], ['prompts/validation-system.md', 'evals']]);
  assert.deepEqual([...gen.requires].sort(), ['docs-and-tests', 'evals', 'no-eval-gate']);
  const fix = leverFor({ id: 'autofix-ineffective', status: 'active', severity: 'warning' });
  assert.deepEqual(fix.requires, ['no-eval-gate', 'docs-and-tests'], 'a stage with no suite says so, and never claims evals');
  assert.equal(leverFor({ id: 'llm-fallbacks', status: 'active', severity: 'warning' }).stage, 'provider');
  assert.equal(leverFor({ id: 'review-withheld', status: 'active', severity: 'warning' }).targets.length, 5);
});

test('leverFor is null for what is not actionable: resolved, info, unmapped, no lever, malformed', () => {
  const base = { id: 'review-coverage', status: 'active', severity: 'warning' };
  assert.equal(leverFor({ ...base, status: 'resolved' }), null);
  assert.equal(leverFor({ ...base, severity: 'info' }), null, 'a guardrail doing its job is not a proposal');
  assert.equal(leverFor({ ...base, status: undefined }), null);
  assert.equal(leverFor({ ...base, id: 'something-new' }), null);
  for (const id of ['runs-failed', 'stage-failures-review', 'duration-review', 'review-duplicates', 'review-stuck', 'escalations', 'external-review-churn', 'rate-limit-waits']) {
    assert.equal(leverFor({ ...base, id, severity: 'critical' }), null, id);
  }
  assert.equal(leverFor(null), null);
  assert.equal(leverFor(undefined), null);
  assert.equal(leverFor({}), null);
  assert.equal(leverFor({ id: '__proto__', status: 'active', severity: 'warning' }), null);
  assert.equal(leverFor({ id: 'constructor', status: 'active', severity: 'warning' }), null);
});

test('on a real diagnosis: an anomaly share yields the lever, the same rule as a guardrail does not', () => {
  const T = Date.parse('2026-10-20T12:00:00Z');
  let n = 0;
  const run = (meta) => ({
    run_id: `${++n}-1`, workflow: 'PR Review', event_name: 'pull_request', started_at: T + n, outcome: 'partial', pr_number: 9, head_sha: String(n).repeat(40).slice(0, 40), llm: [], trace_id: null,
    stages: [{ stage: 'review', outcome: 'success', duration_ms: 900 }], events: [{ stage: 'review', level: 'info', ts: T + n, event: 'review.verdict', meta: { verdict: 'WITHHELD', prNumber: 9, ...meta } }],
    events_overflow: { count: 0 }, spans_overflow: { count: 0, events: 0 },
  });
  const model = (runs) => ({ runs, traces: [], tracesById: new Map(), months: ['2026-10'], skippedMonths: [], warnings: [] });
  const leverOf = (runs) => leverFor(diagnose({ model: model(runs) }).findings.find((f) => f.id === 'review-withheld'));
  // Cause unknown (no cut, no CI evidence state, nothing withheld from): an anomaly.
  assert.equal(leverOf([1, 2, 3].map(() => run({ withheld_from: null, unreviewed_code_files: 0 }))).stage, 'review');
  // Missing CI evidence withholds by design (ADR-0026): info, so no lever.
  assert.equal(leverOf([1, 2, 3].map(() => run({ evidence_state: 'missing' }))), null);
});
