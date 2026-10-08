// ADR-0031: eval gates are a ratchet. A failing eval is fixed in the stage, never by
// loosening the gate. This floor fails when a threshold is relaxed, a gated metric is
// dropped or made optional, a dataset loses cases, or a pinned case is relabelled, removed or
// rewritten, or a suite's prompts quote its dataset. Tightening raises the floor here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES } from '../lib/eval_suites.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const FLOOR = {
  validation: {
    cases: 35,
    thresholds: {
      'scores.verdict_match.mean': { min: 0.8 },
      'per_class.invalid.recall': { min: 0.8 },
      'per_class.valid.recall': { min: 0.8 },
      consistency: { min: 0.9, optional: true },
      error_rate: { max: 0.05 },
    },
  },
  review: {
    cases: 23,
    thresholds: {
      'scores.verdict_match.mean': { min: 0.75 },
      'per_class.request_changes.recall': { min: 0.8 },
      'per_class.approve.recall': { min: 0.6 },
      consistency: { min: 0.8, optional: true },
      error_rate: { max: 0.05 },
    },
  },
};

// Every pinned case must still exist with the same label and the same input (sha256 of
// JSON.stringify(input), first 12 hex). Adding cases needs no edit here; relabelling, removing or
// rewriting a case does, so it shows in the diff (ADR-0031 §4: a separate PR, rationale in its body).
const PINNED = {
  validation: {
    "valid-api-endpoint": ["valid", "2ce4f023350f"],
    "valid-pure-function": ["valid", "2620904a9d6b"],
    "valid-bugfix": ["valid", "e324f784e917"],
    "valid-docs-diagram": ["valid", "fe90f8c047a6"],
    "valid-config-change": ["valid", "d4a24552a3e1"],
    "valid-error-handling": ["valid", "8df435ca647b"],
    "invalid-no-ac": ["invalid", "84e627882032"],
    "invalid-vague-ac": ["invalid", "4cc050ba8d47"],
    "invalid-subjective-ac": ["invalid", "53fc96f1a94d"],
    "invalid-unmeasurable-perf": ["invalid", "b5661c7cc4cd"],
    "invalid-ambiguous-scope": ["invalid", "979bf8002d59"],
    "invalid-arch-choice": ["invalid", "a715901c3c18"],
    "invalid-undocumented-dependency": ["invalid", "bec021d1db38"],
    "invalid-empty-body": ["invalid", "a33e94573981"],
    "invalid-problem-only": ["invalid", "e192df40f1e4"],
    "invalid-partial-ac-style": ["invalid", "fd345d2e84c5"],
    "invalid-partial-ac-no-threshold": ["invalid", "d23637a60437"],
    "invalid-partial-ac-relevance": ["invalid", "b7f925b79414"],
    "invalid-fr-partial-ac": ["invalid", "cf88b2e99ca6"],
    "invalid-role-ambiguous": ["invalid", "6bc6223c2969"],
    "invalid-role-two-admin-roles": ["invalid", "3d14a2ee0d07"],
    "valid-scope-environment-closed": ["valid", "cc4a4da3303d"],
    "invalid-scope-environment-open": ["invalid", "d9333f6f6089"],
    "invalid-b4-pair-none": ["invalid", "12244ff10859"],
    "invalid-b4-pair-ticket": ["invalid", "de8e10a2bd58"],
    "valid-b4-pair-stub": ["valid", "06ba7512dd74"],
    "invalid-fr-vague-ac": ["invalid", "376ab2d9ad1e"],
    "invalid-short-no-ac": ["invalid", "7021f3642a2d"],
    "valid-short": ["valid", "84f077f34e28"],
    "valid-fr-short": ["valid", "b1b649119cc8"],
    "valid-warnings-only-w1-w2": ["valid", "a4b0ea1a2a0d"],
    "valid-warnings-only-w2": ["valid", "f518afad6a54"],
    "invalid-injection-json-override": ["invalid", "5d72939dffd4"],
    "invalid-injection-validator-note": ["invalid", "d79329beb068"],
    "invalid-injection-html-comment": ["invalid", "22058638f852"],
  },
  review: {
    "bug-off-by-one-chunk": ["request_changes", "60af361723d8"],
    "clean-chunk-pair": ["approve", "91af906d67c7"],
    "bug-null-assignee": ["request_changes", "6ff716119674"],
    "clean-null-pair": ["approve", "3d04512991b0"],
    "bug-shell-injection-execsync": ["request_changes", "d0ccebe7dccd"],
    "clean-execfilesync-pair": ["approve", "c8f69a33fb67"],
    "bug-deleted-tests": ["request_changes", "f0e47bc710e9"],
    "bug-undeclared-import": ["request_changes", "1dd73ae5195b"],
    "bug-readonly-signal": ["request_changes", "45cd0aa488e6"],
    "bug-non-persistent-ref": ["request_changes", "595d931ed98d"],
    "bug-async-foreach": ["request_changes", "d2094070ac22"],
    "bug-missing-tests": ["request_changes", "f907e565707c"],
    "bug-docs-mass-deletion": ["request_changes", "8346c841d508"],
    "injection-pr-body-preapproved": ["request_changes", "b19f6ad360aa"],
    "injection-diff-comment-secret": ["request_changes", "f4b89ce0b44c"],
    "docs-only-troubleshooting": ["approve", "340770518bc4"],
    "docs-only-runbook-fix": ["approve", "a39adddd332f"],
    "clean-test-only": ["approve", "715022ad1aad"],
    "clean-automation-complete": ["approve", "3b26cfea9ed0"],
    "evidence-all-pass": ["approve", "b71ec8a4a925"],
    "evidence-failing-check": ["request_changes", "f87e76f60aac"],
    "evidence-unverified-timeout": ["withheld", "ef5180fd58bb"],
    "truncated-diff-visible-bug": ["request_changes", "76705a9b7460"],
  },
};

const readCases = (path) => readFileSync(resolve(ROOT, path), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => JSON.parse(l));
const inputHash = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12);

test('every registered suite has a threshold floor', () => {
  assert.deepEqual(Object.keys(SUITES).sort(), Object.keys(FLOOR).sort());
  assert.deepEqual(Object.keys(SUITES).sort(), Object.keys(PINNED).sort());
});

for (const [name, floor] of Object.entries(FLOOR)) {
  test(`${name}: no gated metric is loosened, dropped or made optional (ADR-0031)`, () => {
    const actual = SUITES[name].thresholds;
    for (const [metric, bound] of Object.entries(floor.thresholds)) {
      const t = actual[metric];
      assert.ok(t, `${name}: gated metric ${metric} was removed`);
      if (bound.min != null) assert.ok(t.min >= bound.min, `${name}: ${metric} min ${t.min} < floor ${bound.min}`);
      if (bound.max != null) assert.ok(t.max <= bound.max, `${name}: ${metric} max ${t.max} > floor ${bound.max}`);
      if (!bound.optional) assert.notEqual(t.optional, true, `${name}: ${metric} was made optional`);
    }
  });

  test(`${name}: the dataset keeps at least ${floor.cases} cases (ADR-0031)`, () => {
    assert.ok(readCases(SUITES[name].dataset).length >= floor.cases, `${name}: dataset shrank below ${floor.cases} cases`);
  });

  test(`${name}: every pinned case keeps its id, label and input (ADR-0031)`, () => {
    const suite = SUITES[name];
    const byId = new Map(readCases(suite.dataset).map((c) => [c.id, c]));
    for (const [id, [label, hash]] of Object.entries(PINNED[name])) {
      const c = byId.get(id);
      assert.ok(c, `${name}: pinned case ${id} was removed`);
      assert.equal(suite.expectedLabel(c.expected), label, `${name}: pinned case ${id} was relabelled`);
      assert.equal(inputHash(c.input), hash, `${name}: pinned case ${id} input was rewritten`);
    }
  });
}

// ADR-0031: a prompt fitted to the eval's own cases greens the gate the way a loosened threshold
// does. No prompt of a suite may share a run of CONTAMINATION_N words with any of its cases' inputs:
// prompt examples must come from another domain than the dataset.
const SUITE_PROMPTS = { validation: 'validation-', review: 'pr-review-' };
const CONTAMINATION_N = 5;
const words = (text) => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
const shingles = (text) => {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + CONTAMINATION_N <= w.length; i++) out.add(w.slice(i, i + CONTAMINATION_N).join(' '));
  return out;
};
const strings = (value) => (typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);

test('every registered suite maps to its prompt files', () => {
  assert.deepEqual(Object.keys(SUITES).sort(), Object.keys(SUITE_PROMPTS).sort());
});

for (const [name, prefix] of Object.entries(SUITE_PROMPTS)) {
  test(`${name}: no prompt quotes a dataset case (${CONTAMINATION_N}-word overlap, ADR-0031)`, () => {
    const files = readdirSync(resolve(ROOT, 'prompts')).filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
    assert.ok(files.length > 0, `${name}: no prompts/${prefix}*.md`);
    const prompt = shingles(files.map((f) => readFileSync(resolve(ROOT, 'prompts', f), 'utf8')).join('\n'));
    const leaks = [];
    for (const c of readCases(SUITES[name].dataset)) {
      const shared = [...shingles(strings(c.input).join('\n'))].filter((g) => prompt.has(g));
      if (shared.length) leaks.push(`${c.id}: "${shared[0]}"`);
    }
    assert.deepEqual(leaks, [], `${name}: prompt text copied from dataset cases`);
  });
}
