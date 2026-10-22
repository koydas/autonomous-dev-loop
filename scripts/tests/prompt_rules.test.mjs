import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const prompt = (name) => readFileSync(resolve(ROOT, 'prompts', name), 'utf8');

// Over-strictness fixes: the rules below are what keeps the review and validation stages from
// rejecting clean changes. A rewrite that drops one must do it on purpose, with an eval run.
test('pr-review-system.md: a stated consolidation is not an unintended deletion', () => {
  const system = prompt('pr-review-system.md');
  assert.match(system, /unless the title or description accounts for them \(remove, trim, merge, deduplicate, replace, move\)/);
  assert.match(system, /neither title nor description mentions deletion, consolidation or replacement/);
});

test('pr-review-system.md: the verdict follows High/Medium findings or a FAIL check, Low notes alone approve', () => {
  const system = prompt('pr-review-system.md');
  assert.match(system, /REQUEST_CHANGES needs a High or Medium finding or a FAIL check;/);
  assert.match(system, /Low notes alone \([^)]*\) mean APPROVED/);
  assert.match(system, /A High or Medium finding names the concrete input or state that makes it fail/);
});

test('pr-review-system.md: a change the description claims past a diff cut is unverified, not a finding', () => {
  assert.match(prompt('pr-review-system.md'), /its absence from the visible diff is unverified, not a finding/);
});

test('validation-system.md: a blocker names what the issue leaves open, otherwise it is a warning', () => {
  const system = prompt('validation-system.md');
  assert.match(system, /Every blocker must pass this test, or it is a warning/);
  assert.match(system, /A keyword \(all, every, deployed, current\) is not a blocker by itself/);
  // The B2 rule still says that naming where a reference lives does not state it: the new text must not contradict it.
  assert.match(system, /Naming where the reference lives .* does not state it/);
});
