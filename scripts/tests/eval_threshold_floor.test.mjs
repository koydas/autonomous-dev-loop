// ADR-0031: eval gates are a ratchet. A failing eval is fixed in the stage, never by
// loosening the gate. This floor fails when a threshold is relaxed, a gated metric is
// dropped or made optional, or a dataset loses cases. Tightening raises the floor here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUITES } from '../lib/eval_suites.mjs';

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

const caseCount = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;

test('every registered suite has a threshold floor', () => {
  assert.deepEqual(Object.keys(SUITES).sort(), Object.keys(FLOOR).sort());
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
    assert.ok(caseCount(SUITES[name].dataset) >= floor.cases, `${name}: dataset shrank below ${floor.cases} cases`);
  });
}
