import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFragment, validateFragments, assembleChangelog, rolloverChangelog } from '../lib/changelog_fragments.mjs';

const base = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-27\n\nOld history\n';
const fragments = {'changes/10.md': '### Fixed\n- Ten', 'changes/2.md': '### Added\n- Two'};
test('numeric ordering, idempotence, history preservation', () => {
  const first = assembleChangelog(base, fragments);
  assert.ok(first.indexOf('- Two') < first.indexOf('- Ten'));
  assert.equal(assembleChangelog(first, fragments), first);
  assert.ok(first.endsWith('## [0.1.0] - 2026-10-27\n\nOld history\n'));
});
test('strict fragment validation', () => {
  for (const [name, content] of [
    ['changes/abc.md', '### Fixed\n- x'],
    ['changes/02.md', '### Fixed\n- x'],
    ['changes/2.md', '### Fixed'],
    ['changes/2.md', '### Fixed\n### Added\n- x'],
    ['changes/2.md', '### Fixed\n- x\uFFFD'],
  ]) assert.throws(() => validateFragment(name, content));
  assert.equal(validateFragment('changes/2.md', '### Fixed\r\n- x'), '### Fixed\n- x');
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
