// ADR-0031: eval gates are a ratchet. A failing eval is fixed in the stage, never by
// loosening the gate. This floor fails when a threshold is relaxed, a gated metric is
// dropped or made optional, a dataset loses cases, or a pinned case is relabelled, removed or
// rewritten, or a suite's prompts quote its dataset. Tightening raises the floor here.
// ADR-0031 §7: a case tagged known-gap is outside the gate. It must be listed in KNOWN_GAP and never pinned
// (a gated case can never be tagged), and every other case must be pinned: removing the tag pins the case,
// which enters the gate for good.
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
    cases: 37,
    thresholds: {
      'scores.verdict_match.mean': { min: 0.8 },
      'per_class.invalid.recall': { min: 0.8 },
      'per_class.valid.recall': { min: 0.8 },
      consistency: { min: 0.9, optional: true },
      error_rate: { max: 0.05 },
    },
  },
  review: {
    cases: 34,
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
    "invalid-role-two-admin-roles": ["invalid", "87cf4380707c"],
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
    "invalid-b2-pair-unranked": ["invalid", "6929c02be5c6"],
    "valid-b2-pair-ranked": ["valid", "3b8f1fa11e6b"],
  },
  review: {
    "bug-off-by-one-chunk": ["request_changes", "c993d360ae21"],
    "clean-chunk-pair": ["approve", "4631d7c16400"],
    "bug-null-assignee": ["request_changes", "42118d4a400c"],
    "clean-null-pair": ["approve", "0281ed6fb793"],
    "bug-shell-injection-execsync": ["request_changes", "b737735bbaf4"],
    "clean-execfilesync-pair": ["approve", "4b51c1f46b59"],
    "bug-deleted-tests": ["request_changes", "eab059ca1652"],
    // RV-03: was known-gap (PR #276); the guardrail check finds it in code, whatever the model says.
    "incident-removed-test-case": ["request_changes", "96c7fb461153"],
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
    "incident-note-instead-of-fix": ["request_changes", "bc1f549ee629"],
    "incident-stale-refs-shared-phrasing": ["approve", "a8a1b16fb636"],
    "incident-finding-on-cut-hunks": ["approve", "f5ac114479c2"],
    "incident-unreadable-verdict-clean-change": ["approve", "3e1b8c1b9dd7"],
    "incident-clean-code-cut": ["withheld", "634e54f32f55"],
    "incident-cut-mid-step-name": ["withheld", "75c37e934634"],
    "incident-missing-step-in-cut": ["withheld", "c2b057607c25"],
    "incident-untested-claim-symlink-dir": ["approve", "5d4cb27b9cb0"],
    "incident-tested-claim-symlink-dir": ["approve", "6a0f1dd5b97a"],
    "clean-empty-body-no-claim": ["approve", "e74a011dc1df"],
    "docs-only-behavior-sentence": ["approve", "722511175605"],
    "truncated-claim-tests-past-cut": ["approve", "875c4df1e00a"],
  },
};

// Cases tagged known-gap, id → input hash. Only a case that was never gated (never in PINNED) can be listed:
// removing the tag moves it to PINNED, and a pinned case can never come back here.
const KNOWN_GAP = {
  validation: {},
  review: {
    // PR #194 incident, expected missed on Groq: the #199 provider comparison case.
    "incident-toctou-untested-claim": "3f6da6d06c69",
    // RV-01: Codex findings on PR #276, #279 and #283 that the review approved; outside the gate until a live run shows the review finds them.
    "incident-low-continuation-axes": "685e8b033c27",
    "incident-docs-contradict-new-behavior": "5de4f9671656",
    "incident-grader-first-push": "8206d6405973",
    // RV-02: the defect is visible only through the Impact analysis block (a caller outside the diff); outside the gate until a live run shows the review uses it.
    "impact-caller-misses-new-parameter": "27e31dbcc397",
  },
};
const KNOWN_GAP_TAG = 'known-gap';

const readCases = (path) => readFileSync(resolve(ROOT, path), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => JSON.parse(l));
// Canonical JSON (keys sorted at every level): reformatting a JSONL line or reordering its keys is
// not a rewrite of the case.
const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const inputHash = (input) => createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex').slice(0, 12);

const isKnownGap = (c) => (c.tags ?? []).includes(KNOWN_GAP_TAG);

// ADR-0031 §7 rules over one dataset: [] when they hold, else one message per violation.
function knownGapViolations({ cases, pinned, knownGap }) {
  const out = [];
  for (const c of cases) {
    if (isKnownGap(c)) {
      if (pinned[c.id]) out.push(`${c.id}: a pinned (gated) case cannot be tagged ${KNOWN_GAP_TAG}`);
      else if (!knownGap[c.id]) out.push(`${c.id}: tagged ${KNOWN_GAP_TAG} but not listed in KNOWN_GAP`);
      else if (knownGap[c.id] !== inputHash(c.input)) out.push(`${c.id}: known-gap case input was rewritten`);
    } else if (!pinned[c.id]) {
      out.push(`${c.id}: gated case not pinned${knownGap[c.id] ? ' (its known-gap tag was removed: move it from KNOWN_GAP to PINNED)' : ''}`);
    }
  }
  const ids = new Set(cases.map((c) => c.id));
  for (const id of Object.keys(knownGap)) {
    if (pinned[id]) out.push(`${id}: listed in KNOWN_GAP and PINNED`);
    else if (!ids.has(id)) out.push(`${id}: listed in KNOWN_GAP but not in the dataset`);
  }
  return out;
}

test('every registered suite has a threshold floor', () => {
  assert.deepEqual(Object.keys(SUITES).sort(), Object.keys(FLOOR).sort());
  assert.deepEqual(Object.keys(SUITES).sort(), Object.keys(PINNED).sort());
  assert.deepEqual(Object.keys(SUITES).sort(), Object.keys(KNOWN_GAP).sort());
});

test('known-gap rules: a gated case can never be (re-)tagged, an untagged case must be pinned (ADR-0031 §7)', () => {
  const input = { title: 't' };
  const hash = inputHash(input);
  const gap = { id: 'g', tags: [KNOWN_GAP_TAG], input };
  const gated = { id: 'p', tags: [], input };
  assert.deepEqual(knownGapViolations({ cases: [gap, gated], pinned: { p: ['x', hash] }, knownGap: { g: hash } }), []);
  // A case that passed into the gate (pinned) gets the tag back: refused, whether or not it is also listed.
  assert.deepEqual(knownGapViolations({ cases: [{ ...gated, tags: [KNOWN_GAP_TAG] }], pinned: { p: ['x', hash] }, knownGap: {} }),
    ['p: a pinned (gated) case cannot be tagged known-gap']);
  assert.deepEqual(knownGapViolations({ cases: [{ ...gated, tags: [KNOWN_GAP_TAG] }], pinned: { p: ['x', hash] }, knownGap: { p: hash } }),
    ['p: a pinned (gated) case cannot be tagged known-gap', 'p: listed in KNOWN_GAP and PINNED']);
  // The tag removed: the case is gated and must be pinned in the same PR.
  assert.deepEqual(knownGapViolations({ cases: [{ ...gap, tags: [] }], pinned: {}, knownGap: { g: hash } }),
    ['g: gated case not pinned (its known-gap tag was removed: move it from KNOWN_GAP to PINNED)']);
  // A new tag must be declared; a declared case keeps its input; a stale declaration fails.
  assert.deepEqual(knownGapViolations({ cases: [gap], pinned: {}, knownGap: {} }), ['g: tagged known-gap but not listed in KNOWN_GAP']);
  assert.deepEqual(knownGapViolations({ cases: [{ ...gap, input: { title: 'u' } }], pinned: {}, knownGap: { g: hash } }), ['g: known-gap case input was rewritten']);
  assert.deepEqual(knownGapViolations({ cases: [], pinned: {}, knownGap: { g: hash } }), ['g: listed in KNOWN_GAP but not in the dataset']);
  assert.deepEqual(knownGapViolations({ cases: [{ id: 'n', input }], pinned: {}, knownGap: {} }), ['n: gated case not pinned']);
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

  test(`${name}: the dataset keeps at least ${floor.cases} gated cases, known-gap ones not counted (ADR-0031)`, () => {
    const gated = readCases(SUITES[name].dataset).filter((c) => !isKnownGap(c)).length;
    assert.ok(gated >= floor.cases, `${name}: ${gated} gated cases, below the floor of ${floor.cases}`);
  });

  test(`${name}: known-gap cases are declared and were never gated; every gated case is pinned (ADR-0031 §7)`, () => {
    assert.deepEqual(knownGapViolations({ cases: readCases(SUITES[name].dataset), pinned: PINNED[name], knownGap: KNOWN_GAP[name] }), []);
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
