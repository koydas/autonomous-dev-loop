import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFragment, validateFragments, assembleChangelog, rolloverChangelog, isReleaseChange } from '../lib/changelog_fragments.mjs';

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

test('manual notes outside the generated block survive assembly and release', () => {
  const preview = assembleChangelog(base, fragments);
  const edited = preview.replace('\n\n## [0.1.0]', '\n\n### Breaking\n- Rename input foo\n\n## [0.1.0]');
  const again = assembleChangelog(edited, fragments);
  assert.equal(again, edited);
  const released = rolloverChangelog(again, '2.0.0', '2026-10-30');
  const section = released.slice(released.indexOf('## [2.0.0]'), released.indexOf('## [0.1.0]'));
  assert.match(section, /### Breaking\n- Rename input foo/);
  assert.match(section, /- Two/);
  assert.ok(!released.includes('<!--'));
});

test('assembly rejects manual notes it would drop', () => {
  const preview = assembleChangelog(base, fragments);
  const inside = preview.replace('- Ten', '- Ten\n\n### Breaking\n- Rename input foo');
  assert.throws(() => assembleChangelog(inside, fragments), /line not from a fragment.*### Breaking/);
  const noEnd = preview.replace('<!-- end generated changelog fragments -->', '### Breaking\n- x');
  assert.throws(() => assembleChangelog(noEnd, fragments), /missing <!-- end generated changelog fragments -->/);
});

test('assembly fails without an Unreleased heading', () => {
  assert.throws(() => assembleChangelog('# Changelog\n\n## [0.1.0] - 2026-10-27\n', fragments), /missing ## \[Unreleased\]/);
});

test('rollover failure branches', () => {
  const assembled = assembleChangelog(base, fragments);
  for (const [version, date] of [['1.2', '2026-10-28'], ['v1.2.0', '2026-10-28'], ['1.2.0', '28-10-2026'], ['1.2.0', '']])
    assert.throws(() => rolloverChangelog(assembled, version, date), /semver and YYYY-MM-DD/);
  assert.throws(() => rolloverChangelog(assembled, '0.1.0', '2026-10-27'), /Release already exists: 0.1.0/);
  assert.throws(() => rolloverChangelog('# Changelog\n', '1.2.0', '2026-10-28'), /Missing Unreleased/);
});

test('fragment validation rejects non-string, NUL and ## headings', () => {
  assert.throws(() => validateFragment('changes/2-first.md', undefined), /invalid UTF-8 content/);
  assert.throws(() => validateFragment('changes/2-first.md', Buffer.from('### Fixed\n- x')), /invalid UTF-8 content/);
  assert.throws(() => validateFragment('changes/2-first.md', '### Fixed\n- x\0'), /invalid UTF-8 content/);
  assert.throws(() => validateFragment('changes/2-first.md', '### Fixed\n- x\n## [9.9.9]'), /unexpected heading/);
  assert.throws(() => validateFragment('changes/2-first.md', '### Security\n- x'), /one category heading/);
  assert.throws(() => validateFragments({'changes/2-first.md': '### Fixed\n- x', 'changes/x.md': '### Fixed\n- y'}), /changes\/x.md: invalid fragment filename/);
});

test('release change: only CHANGELOG.md and deleted fragments', () => {
  assert.equal(isReleaseChange(['M\tCHANGELOG.md', 'D\tchanges/2-first.md', 'D\tchanges/10-second.md']), true);
  assert.equal(isReleaseChange(['M\tCHANGELOG.md']), true);
  assert.equal(isReleaseChange([]), false);
  assert.equal(isReleaseChange(['D\tchanges/2-first.md']), false, 'no CHANGELOG.md edit');
  assert.equal(isReleaseChange(['M\tCHANGELOG.md', 'A\tchanges/2-first.md']), false, 'adds a fragment');
  assert.equal(isReleaseChange(['M\tCHANGELOG.md', 'M\tscripts/x.mjs']), false, 'carries a code change');
  assert.equal(isReleaseChange(['M\tCHANGELOG.md', 'D\tchanges/notes.txt']), false, 'deletes a non-fragment');
  assert.equal(isReleaseChange(['M\tCHANGELOG.md', 'R100\tchanges/2-first.md\tchanges/3-first.md']), false, 'renames a fragment');
  assert.equal(isReleaseChange(['A\tCHANGELOG.md']), false, 'creates CHANGELOG.md');
});

test('an untouched generated block follows fragment corrections; a hand edit inside it is refused', () => {
  const preview = assembleChangelog(base, {'changes/2-first.md': '### Added\n- Original wording'});
  const corrected = assembleChangelog(preview, {'changes/2-first.md': '### Added\n- Corrected wording'});
  assert.ok(corrected.includes('- Corrected wording') && !corrected.includes('- Original wording'));
  assert.equal(assembleChangelog(preview, {}).includes('- Original wording'), false, 'a removed fragment leaves the block');
  const handEdited = preview.replace('- Original wording', '- Hand wording');
  assert.throws(() => assembleChangelog(handEdited, {'changes/2-first.md': '### Added\n- Corrected wording'}), /"- Hand wording"/);
  const legacyMarker = preview.replace(/ sha256:[0-9a-f]{64}/, '');
  assert.throws(() => assembleChangelog(legacyMarker, {'changes/2-first.md': '### Added\n- Corrected wording'}), /"- Original wording"/);
  assert.match(assembleChangelog(legacyMarker, {'changes/2-first.md': '### Added\n- Original wording'}), /sha256:[0-9a-f]{64}/);
});

test('rollover rejects a released version whatever the date', () => {
  const assembled = assembleChangelog(base, fragments);
  assert.throws(() => rolloverChangelog(assembled, '0.1.0', '2026-10-30'), /Release already exists: 0.1.0/);
  assert.match(rolloverChangelog(assembled.replace('## [0.1.0]', '## [0.10]'), '0.1.0', '2026-10-30'), /## \[0.1.0\] - 2026-10-30/, 'dots are literal');
});
