import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFragment, validateFragments, assembleChangelog, rolloverChangelog } from '../lib/changelog_fragments.mjs';

const base = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-27\n\nOld history\n';
const fragments = {'changes/10-second.md': '### Fixed\n- Ten', 'changes/2-first.md': '### Added\n- Two'};
test('numeric ordering, idempotence, history preservation', () => {
  const first = assembleChangelog(base, fragments);
  assert.ok(first.indexOf('- Two') < first.indexOf('- Ten'));
  assert.equal(assembleChangelog(first, fragments), first);
  assert.ok(first.endsWith('## [0.1.0] - 2026-10-27\n\nOld history\n'));
});
test('strict fragment validation', () => {
  for (const [name, content] of [
    ['changes/abc-wrong.md', '### Fixed\n- x'],
    ['changes/02-wrong.md', '### Fixed\n- x'],
    ['changes/2-first.md', '### Fixed'],
    ['changes/2-first.md', '### Fixed\n### Added\n- x'],
    ['changes/2-first.md', '### Fixed\n- x\uFFFD'],
  ]) assert.throws(() => validateFragment(name, content));
  assert.equal(validateFragment('changes/2-first.md', '### Fixed\r\n- x'), '### Fixed\n- x');
});
test('empty fragments and retained legacy notes', () => {
  const legacy = base.replace('\n\n## [0.1.0]', '\n\n- Existing note\n\n## [0.1.0]');
  const result = assembleChangelog(legacy, {});
  assert.equal(assembleChangelog(result, {}), result);
  assert.equal(result.split('- Existing note').length, 2);
});
test('release rollover clears Unreleased and preserves history', () => {
  const assembled = assembleChangelog(base, fragments);
  const released = rolloverChangelog(assembled, '1.2.0', '2026-10-28');
  assert.match(released, /## \[1.2.0\] - 2026-10-28/);
  const empty = assembleChangelog(released, {});
  assert.ok(!empty.slice(empty.indexOf('## [Unreleased]'), empty.indexOf('## [1.2.0]')).includes('- Two'));
  assert.ok(empty.endsWith('## [0.1.0] - 2026-10-27\n\nOld history\n'));
});

test('two independent PRs for one issue use separate fragments', () => {
  const first = 'changes/321-alpha.md';
  const second = 'changes/321-beta.md';
  const merged = assembleChangelog(base, {[second]: '### Fixed\n- Beta', [first]: '### Fixed\n- Alpha'});
  assert.ok(merged.indexOf('- Alpha') < merged.indexOf('- Beta'));
  assert.equal(assembleChangelog(merged, {[first]: '### Fixed\n- Alpha', [second]: '### Fixed\n- Beta'}), merged);
  assert.throws(() => validateFragment('changes/321.md', '### Fixed\n- Old shared name'));
});
