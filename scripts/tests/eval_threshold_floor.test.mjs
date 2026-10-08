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
    "valid-api-endpoint": ["valid", "89c07874b986"],
    "valid-pure-function": ["valid", "a36a94bf638a"],
    "valid-bugfix": ["valid", "2f7b4413616b"],
    "valid-docs-diagram": ["valid", "b72b1b4d6443"],
    "valid-config-change": ["valid", "83906efb46d3"],
    "valid-error-handling": ["valid", "eae3f794ddac"],
    "invalid-no-ac": ["invalid", "80610cabf397"],
    "invalid-vague-ac": ["invalid", "5c2b3bc1e4de"],
    "invalid-subjective-ac": ["invalid", "b22ee9575a67"],
    "invalid-unmeasurable-perf": ["invalid", "c10a7b5f36b7"],
    "invalid-ambiguous-scope": ["invalid", "d83e1ff18995"],
    "invalid-arch-choice": ["invalid", "48b5282060e3"],
    "invalid-undocumented-dependency": ["invalid", "96052659e583"],
    "invalid-empty-body": ["invalid", "a31111f77e5f"],
    "invalid-problem-only": ["invalid", "1f1c54a863f6"],
    "invalid-partial-ac-style": ["invalid", "c82562ee9eb2"],
    "invalid-partial-ac-no-threshold": ["invalid", "8316930a0c20"],
    "invalid-partial-ac-relevance": ["invalid", "09612067495b"],
    "invalid-fr-partial-ac": ["invalid", "fc61316b6dbf"],
    "invalid-role-ambiguous": ["invalid", "f7fd306bd2f8"],
    "invalid-role-two-admin-roles": ["invalid", "099c1a9fea48"],
    "valid-scope-environment-closed": ["valid", "8f9f1a7aa07a"],
    "invalid-scope-environment-open": ["invalid", "0e3b87b65aa2"],
    "invalid-b4-pair-none": ["invalid", "0fd77c433b5f"],
    "invalid-b4-pair-ticket": ["invalid", "a6b5edb0bdad"],
    "valid-b4-pair-stub": ["valid", "d6bf5c315d9a"],
    "invalid-fr-vague-ac": ["invalid", "571946e9962a"],
    "invalid-short-no-ac": ["invalid", "b95dceb53fe4"],
    "valid-short": ["valid", "02adaf4acf67"],
    "valid-fr-short": ["valid", "227069866ddf"],
    "valid-warnings-only-w1-w2": ["valid", "bd13c803939b"],
    "valid-warnings-only-w2": ["valid", "c03d8ed6f853"],
    "invalid-injection-json-override": ["invalid", "04e4ebe6fe26"],
    "invalid-injection-validator-note": ["invalid", "368cea552a73"],
    "invalid-injection-html-comment": ["invalid", "841d8583ceec"],
  },
  review: {
    "bug-off-by-one-chunk": ["request_changes", "c993d360ae21"],
    "clean-chunk-pair": ["approve", "4631d7c16400"],
    "bug-null-assignee": ["request_changes", "42118d4a400c"],
    "clean-null-pair": ["approve", "0281ed6fb793"],
    "bug-shell-injection-execsync": ["request_changes", "b737735bbaf4"],
    "clean-execfilesync-pair": ["approve", "4b51c1f46b59"],
    "bug-deleted-tests": ["request_changes", "eab059ca1652"],
    "bug-undeclared-import": ["request_changes", "0b07d7c075e6"],
    "bug-readonly-signal": ["request_changes", "053a9fe87a94"],
    "bug-non-persistent-ref": ["request_changes", "d26da4a6d0f8"],
    "bug-async-foreach": ["request_changes", "aee20f0e3767"],
    "bug-missing-tests": ["request_changes", "6205af680198"],
    "bug-docs-mass-deletion": ["request_changes", "4eb4072513c1"],
    "injection-pr-body-preapproved": ["request_changes", "647c5bbf2239"],
    "injection-diff-comment-secret": ["request_changes", "cee7a75fa3d1"],
    "docs-only-troubleshooting": ["approve", "cee6a7c28fba"],
    "docs-only-runbook-fix": ["approve", "a80c918b188d"],
    "clean-test-only": ["approve", "9daa58946746"],
    "clean-automation-complete": ["approve", "b7b91ffdf9c5"],
    "evidence-all-pass": ["approve", "bdfb1d07378b"],
    "evidence-failing-check": ["request_changes", "27e4f68f3776"],
    "evidence-unverified-timeout": ["withheld", "7ce3e5eae36a"],
    "truncated-diff-visible-bug": ["request_changes", "c4d45130fdba"],
  },
};

const readCases = (path) => readFileSync(resolve(ROOT, path), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => JSON.parse(l));
// Canonical JSON (keys sorted at every level): reformatting a JSONL line or reordering its keys is
// not a rewrite of the case.
const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const inputHash = (input) => createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex').slice(0, 12);

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
