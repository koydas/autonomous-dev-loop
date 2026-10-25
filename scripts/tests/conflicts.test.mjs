import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CONFLICT_ATTEMPTS, MAX_MODEL_FILES, CONFLICT_BREAKER_THRESHOLD, classifyMergeability, canPushToHead, conflictSignature,
  formatConflictMarker, parseConflictMarker, latestConflictMarker, nextConflictStreak, decideConflictRun, parseConflicts,
  conflictsOf, hasConflictMarkers, applyResolutions, planFile, inventedLines, checkHunkResolution, adrNumber, planAdrRenumber,
  renumberReferences, addedLinesOf, CONFLICT_ESCALATION_REASONS,
} from '../lib/conflicts.mjs';
import { loadLabelsConfigAll } from '../lib/layered_config.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SHA = 'a'.repeat(40);

// ── mergeability ──────────────────────────────────────────────────────────────────────────────────

test('classifyMergeability: dirty is a conflict, null is unknown (never clean, never conflicting), closed and merged are out', () => {
  assert.equal(classifyMergeability({ state: 'open', mergeable: false, mergeable_state: 'dirty' }), 'conflicting');
  assert.equal(classifyMergeability({ state: 'open', mergeable: false }), 'conflicting');
  assert.equal(classifyMergeability({ state: 'open', mergeable: null, mergeable_state: 'unknown' }), 'unknown');
  assert.equal(classifyMergeability({ state: 'open', mergeable: true, mergeable_state: 'unknown' }), 'unknown');
  assert.equal(classifyMergeability({ state: 'open' }), 'unknown');
  assert.equal(classifyMergeability({ state: 'open', mergeable: true, mergeable_state: 'clean' }), 'clean');
  assert.equal(classifyMergeability({ state: 'open', mergeable: true, mergeable_state: 'blocked' }), 'clean', 'blocked by reviews is not a conflict');
  assert.equal(classifyMergeability({ state: 'closed', mergeable_state: 'dirty' }), 'closed');
  assert.equal(classifyMergeability({ state: 'open', merged: true }), 'closed');
  assert.equal(classifyMergeability(null), 'closed');
});

test('canPushToHead: same repository (any letter case), a fork only with maintainer edits, a deleted fork never', () => {
  const pr = (full_name, extra = {}) => ({ head: { repo: full_name ? { full_name } : null }, ...extra });
  assert.equal(canPushToHead(pr('Koydas/App'), 'koydas/app'), true);
  assert.equal(canPushToHead(pr('someone/app', { maintainer_can_modify: true }), 'koydas/app'), true);
  assert.equal(canPushToHead(pr('someone/app', { maintainer_can_modify: false }), 'koydas/app'), false);
  assert.equal(canPushToHead(pr('someone/app'), 'koydas/app'), false);
  assert.equal(canPushToHead(pr(null), 'koydas/app'), false);
  assert.equal(canPushToHead(undefined, 'koydas/app'), false);
});

// ── signature, marker, breaker ────────────────────────────────────────────────────────────────────

test('conflictSignature: order-independent, sensitive to the incoming side, null without a conflict', () => {
  const a = [{ path: 'a.js', theirs: 'x' }, { path: 'b.js', theirs: 'y' }];
  assert.match(conflictSignature(a), /^[0-9a-f]{10}$/);
  assert.equal(conflictSignature(a), conflictSignature([...a].reverse()));
  assert.equal(conflictSignature(a), conflictSignature([{ path: './a.js', theirs: 'x' }, { path: 'b.js', theirs: 'y' }]), 'paths are normalized');
  assert.notEqual(conflictSignature(a), conflictSignature([{ path: 'a.js', theirs: 'changed' }, a[1]]));
  assert.notEqual(conflictSignature(a), conflictSignature([a[0]]));
  assert.equal(conflictSignature([{ path: 'a.js' }]) !== null, true, 'a missing theirs is the empty side');
  assert.equal(conflictSignature([]), null);
  assert.equal(conflictSignature(undefined), null);
});

test('conflict marker: format, anchored parse, invalid inputs, and the signature part only with a valid signature', () => {
  const full = formatConflictMarker({ sha: SHA, outcome: 'escalated', sig: 'abcdef0123', streak: 2 });
  assert.equal(full, `<!-- adl-conflicts head=${SHA} outcome=escalated sig=abcdef0123 streak=2 -->`);
  assert.deepEqual(parseConflictMarker(`text\n\n${full}\n`), { sha: SHA, outcome: 'escalated', sig: 'abcdef0123', streak: 2 });
  assert.deepEqual(parseConflictMarker(formatConflictMarker({ sha: SHA, outcome: 'resolved' })), { sha: SHA, outcome: 'resolved', sig: null, streak: 1 });
  assert.equal(formatConflictMarker({ sha: SHA, outcome: 'detected', sig: 'not-a-sig' }).includes('sig='), false);
  assert.equal(formatConflictMarker({ sha: SHA, outcome: 'escalated', sig: 'abcdef0123', streak: 500 }).includes('streak=99'), true);
  assert.equal(formatConflictMarker({ sha: SHA, outcome: 'escalated', sig: 'abcdef0123', streak: 0 }).includes('streak=1'), true);
  assert.throws(() => formatConflictMarker({ sha: 'zz', outcome: 'resolved' }), /Invalid conflict marker sha/);
  assert.throws(() => formatConflictMarker({ sha: SHA, outcome: 'nope' }), /Invalid conflict marker outcome/);
  assert.throws(() => formatConflictMarker(), /Invalid conflict marker sha/);
  assert.equal(parseConflictMarker(`${full}\nmore text after`), null, 'a marker quoted mid-body never wins');
  assert.equal(parseConflictMarker(undefined), null);
});

test('latestConflictMarker: newest marker of a trusted author; a stranger forging one is ignored', () => {
  const marker = (outcome, sha = SHA) => formatConflictMarker({ sha, outcome });
  const bot = (body) => ({ user: { login: 'github-actions[bot]' }, author_association: 'NONE', body });
  const member = (body) => ({ user: { login: 'koydas' }, author_association: 'OWNER', body });
  const stranger = (body) => ({ user: { login: 'eve' }, author_association: 'NONE', body });
  assert.equal(latestConflictMarker([bot(marker('detected')), member(marker('resolved'))]).outcome, 'resolved');
  assert.equal(latestConflictMarker([bot(marker('escalated')), stranger(marker('resolved'))]).outcome, 'escalated');
  assert.equal(latestConflictMarker([stranger(marker('resolved'))]), null);
  assert.equal(latestConflictMarker([bot('no marker')]), null);
  assert.equal(latestConflictMarker([null, undefined, bot(marker('detected'))]).outcome, 'detected');
  assert.equal(latestConflictMarker('not a list'), null);
});

test('nextConflictStreak: the same signature after an escalation continues, anything else restarts', () => {
  const prev = { outcome: 'escalated', sig: 'abcdef0123', streak: 1 };
  assert.equal(nextConflictStreak(prev, 'abcdef0123'), 2);
  assert.equal(nextConflictStreak({ ...prev, streak: undefined }, 'abcdef0123'), 2);
  assert.equal(nextConflictStreak(prev, 'ffffffffff'), 1);
  assert.equal(nextConflictStreak(prev, null), 1);
  assert.equal(nextConflictStreak({ ...prev, outcome: 'resolved' }, 'abcdef0123'), 1);
  assert.equal(nextConflictStreak(null, 'abcdef0123'), 1);
});

test('decideConflictRun: cap, breaker, manual override; an unknown signature never opens the breaker', () => {
  const prev = { outcome: 'escalated', sig: 'abcdef0123', streak: CONFLICT_BREAKER_THRESHOLD };
  assert.deepEqual(decideConflictRun({ attempts: 0, previous: null, sig: null }), { run: true });
  assert.deepEqual(decideConflictRun({ attempts: MAX_CONFLICT_ATTEMPTS, previous: null, sig: null }), { run: false, reason: 'attempts_exhausted' });
  assert.deepEqual(decideConflictRun({ attempts: 1, previous: prev, sig: 'abcdef0123' }), { run: false, reason: 'circuit_open' });
  assert.deepEqual(decideConflictRun({ attempts: 1, previous: { ...prev, streak: 1 }, sig: 'abcdef0123' }), { run: true }, 'one failure is not a streak');
  assert.deepEqual(decideConflictRun({ attempts: 1, previous: { ...prev, streak: undefined }, sig: 'abcdef0123' }), { run: true });
  assert.deepEqual(decideConflictRun({ attempts: 1, previous: prev, sig: 'ffffffffff' }), { run: true }, 'another conflict');
  assert.deepEqual(decideConflictRun({ attempts: 1, previous: prev, sig: null }), { run: true });
  assert.deepEqual(decideConflictRun({ attempts: 1, previous: { ...prev, outcome: 'resolved' }, sig: 'abcdef0123' }), { run: true });
  assert.deepEqual(decideConflictRun({ attempts: 9, previous: prev, sig: 'abcdef0123', manual: true }), { run: true });
});

test('the conflict labels of config/labels.yaml match the attempt cap, and every escalation reason has a text in the comment', () => {
  const labels = loadLabelsConfigAll({});
  const attemptLabels = Object.keys(labels.conflicts).filter((k) => k.startsWith('attempt'));
  assert.equal(attemptLabels.length, MAX_CONFLICT_ATTEMPTS, 'conflict-fix-attempt-N labels are exactly MAX_CONFLICT_ATTEMPTS');
  assert.equal(labels.conflicts.conflicting.name, 'merge-conflict');
  assert.ok(MAX_MODEL_FILES >= 1);
  const script = readFileSync(resolve(ROOT, 'scripts/conflicts_fix.mjs'), 'utf8');
  for (const reason of CONFLICT_ESCALATION_REASONS.filter((r) => !['attempts_exhausted', 'circuit_open'].includes(r))) {
    assert.ok(script.includes(`${reason}:`), `conflicts_fix.mjs has no REASON_TEXT for ${reason}`);
  }
});

// ── conflict markers ──────────────────────────────────────────────────────────────────────────────

const DIFF3 = 'head\n<<<<<<< HEAD\nours 1\nours 2\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> sha\ntail\n';

test('parseConflicts: text and conflict segments keep their line terminators; diff3 base is read, merge style has none', () => {
  assert.deepEqual(parseConflicts(DIFF3), [
    { type: 'text', text: 'head\n' },
    { type: 'conflict', ours: 'ours 1\nours 2\n', base: 'base\n', theirs: 'theirs\n' },
    { type: 'text', text: 'tail\n' },
  ]);
  const merge = parseConflicts('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n');
  assert.deepEqual(merge, [{ type: 'conflict', ours: 'a\n', base: '', theirs: 'b\n' }]);
  assert.equal(conflictsOf(parseConflicts(`${DIFF3}${DIFF3}`)).length, 2);
  assert.deepEqual(parseConflicts('no conflict'), [{ type: 'text', text: 'no conflict' }]);
  assert.deepEqual(parseConflicts(''), []);
  assert.equal(parseConflicts('a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> z\r\n')[1].ours, 'x\r\n', 'CRLF files parse');
});

test('parseConflicts: unterminated, nested and misplaced markers throw instead of guessing', () => {
  assert.throws(() => parseConflicts('<<<<<<< HEAD\na\n=======\nb\n'), /unterminated/);
  assert.throws(() => parseConflicts('<<<<<<< HEAD\na\n'), /unterminated/);
  assert.throws(() => parseConflicts('<<<<<<< HEAD\na\n<<<<<<< HEAD\n'), /nested/);
  assert.throws(() => parseConflicts('<<<<<<< HEAD\na\n>>>>>>> x\n'), /unterminated/, 'an end marker before the separator is not an end');
  assert.deepEqual(parseConflicts('x\n=======\ny\n'), [{ type: 'text', text: 'x\n=======\ny\n' }], 'a bare separator outside a block is text');
});

test('hasConflictMarkers: the opening and closing lines of a block, not a setext heading or a look-alike', () => {
  for (const line of ['<<<<<<< HEAD', '>>>>>>> branch', '<<<<<<<', '>>>>>>>']) assert.equal(hasConflictMarkers(`a\n${line}\nb`), true, line);
  assert.equal(hasConflictMarkers('Title\n=======\ntext\n||||||| not a marker\n'), false);
  assert.equal(hasConflictMarkers('a = b ======= c\n<<<<<< six\n'), false);
  assert.equal(hasConflictMarkers(''), false);
});

test('applyResolutions: splices hunks in order and leaves the rest byte for byte; an empty resolution deletes the hunk', () => {
  const segments = parseConflicts(`${DIFF3}${DIFF3}`);
  assert.equal(applyResolutions(segments, ['one\n', 'two']), 'head\none\ntail\nhead\ntwo\ntail\n');
  assert.equal(applyResolutions(segments, ['', '']), 'head\ntail\nhead\ntail\n');
  assert.throws(() => applyResolutions(segments, ['only one']), /expected 2 resolutions, got 1/);
  assert.equal(applyResolutions(parseConflicts('no conflict'), []), 'no conflict');
});

// ── resolver allowlist ────────────────────────────────────────────────────────────────────────────

test('planFile: lockfile → L1, named allowlist and unprotected paths → L2, any other protected path → L3', () => {
  assert.deepEqual(planFile('package-lock.json', 'package-lock.json'), { rung: 'L1', resolver: 'lockfile' });
  assert.deepEqual(planFile('CHANGELOG.md', null), { rung: 'L2', resolver: 'changelog' });
  assert.deepEqual(planFile('./CHANGELOG.md', null), { rung: 'L2', resolver: 'changelog' });
  assert.deepEqual(planFile('docs/adr/README.md', 'docs/'), { rung: 'L2', resolver: 'adr_index' });
  assert.deepEqual(planFile('docs/adr/0058-x.md', 'docs/'), { rung: 'L2', resolver: 'adr' });
  assert.deepEqual(planFile('src/app.js', null), { rung: 'L2', resolver: 'generic' });
  assert.deepEqual(planFile('scripts/x.mjs', 'scripts/'), { rung: 'L3', reason: 'protected_path' });
  assert.deepEqual(planFile('.github/workflows/test.yml', '.github/'), { rung: 'L3', reason: 'protected_path' });
  assert.deepEqual(planFile('docs/guide.md', 'docs/'), { rung: 'L3', reason: 'protected_path' }, 'the allowlist is named, not all of docs/');
  assert.deepEqual(planFile('yarn.lock', 'yarn.lock'), { rung: 'L3', reason: 'protected_path' }, 'only package-lock.json is regenerated');
  assert.deepEqual(planFile('sub/package-lock.json', 'package-lock.json'), { rung: 'L3', reason: 'protected_path' }, 'only the root lockfile');
});

// ── hunk post-checks ──────────────────────────────────────────────────────────────────────────────

test('inventedLines: lines found in none of the three sides, trimmed, blanks ignored', () => {
  assert.deepEqual(inventedLines('a\n  b  \n\nnew\n', { ours: 'a\n', base: '', theirs: 'b\n' }), ['new']);
  assert.deepEqual(inventedLines('a', { ours: 'a', theirs: 'b' }), []);
});

test('checkHunkResolution changelog: keeps every entry of both sides, invents nothing, no marker', () => {
  const side = { ours: '- ours entry\n  detail\n', theirs: '- theirs entry\n' };
  assert.deepEqual(checkHunkResolution('changelog', side, '- theirs entry\n- ours entry\n  detail\n'), []);
  assert.deepEqual(checkHunkResolution('changelog', side, '- theirs entry\n'), ['entry_dropped']);
  assert.deepEqual(checkHunkResolution('changelog', side, '- ours entry\n  detail\n'), ['entry_dropped']);
  assert.deepEqual(checkHunkResolution('changelog', side, '- theirs entry\n- ours entry\n  detail\n- brand new\n'), ['invented_content']);
  assert.deepEqual(checkHunkResolution('changelog', side, '- theirs entry\n- ours entry\n  detail\n>>>>>>> x\n').sort(), ['invented_content', 'marker_left'].sort());
  assert.deepEqual(checkHunkResolution('changelog', side, '- theirs entry\n- ours entry rewritten\n  detail\n').sort(), ['entry_dropped', 'invented_content'].sort());
});

test('checkHunkResolution: a bare separator or base marker is a marker only when no side had it (setext headings stay)', () => {
  const side = { ours: 'Title\n=======\none\n', theirs: 'Title\n=======\ntwo\n' };
  assert.deepEqual(checkHunkResolution('generic', side, 'Title\n=======\none\ntwo\n'), [], 'the heading was in both sides');
  assert.deepEqual(checkHunkResolution('generic', { ours: 'a\n', theirs: 'b\n' }, 'a\n=======\n'), ['marker_left']);
  assert.deepEqual(checkHunkResolution('generic', { ours: 'a\n', theirs: 'b\n' }, 'a\n||||||| base\n'), ['marker_left']);
  assert.deepEqual(checkHunkResolution('generic', { ours: 'a\n', theirs: 'b\n' }, 'a\r\n=======\r\n'), ['marker_left'], 'CRLF');
});

test('checkHunkResolution adr_index: every line of both sides kept, nothing invented', () => {
  const side = { ours: '- [ADR-0058](./0058-a.md)\n', theirs: '- [ADR-0058](./0058-b.md)\n' };
  assert.deepEqual(checkHunkResolution('adr_index', side, '- [ADR-0058](./0058-b.md)\n- [ADR-0058](./0058-a.md)\n'), []);
  assert.deepEqual(checkHunkResolution('adr_index', side, '- [ADR-0058](./0058-b.md)\n'), ['entry_dropped']);
  assert.deepEqual(checkHunkResolution('adr_index', side, '- [ADR-0058](./0058-b.md)\n- [ADR-0059](./0059-a.md)\n').sort(), ['entry_dropped', 'invented_content']);
});

test('checkHunkResolution adr: invents nothing (the model never changes a number)', () => {
  const side = { ours: 'Status: Proposed\n', theirs: 'Status: Accepted\n' };
  assert.deepEqual(checkHunkResolution('adr', side, 'Status: Accepted\n'), []);
  assert.deepEqual(checkHunkResolution('adr', side, 'Status: Rejected\n'), ['invented_content']);
});

test('checkHunkResolution generic: a few combined lines are fine, a rewrite is not', () => {
  const side = { ours: 'import { a } from "x";\nconst one = 1;\n', theirs: 'import { b } from "x";\nconst two = 2;\n' };
  assert.deepEqual(checkHunkResolution('generic', side, 'import { a, b } from "x";\nconst one = 1;\nconst two = 2;\n'), []);
  const rewrite = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].join('\n');
  assert.deepEqual(checkHunkResolution('generic', side, rewrite), ['invented_content']);
  assert.deepEqual(checkHunkResolution('generic', side, '<<<<<<< HEAD\nconst one = 1;\n'), ['marker_left']);
  assert.deepEqual(checkHunkResolution('generic', { ours: '', theirs: '' }, ''), [], 'deleting both sides is allowed');
});

// ── ADR renumber ──────────────────────────────────────────────────────────────────────────────────

test('adrNumber: the number of an ADR path, null for anything else', () => {
  assert.equal(adrNumber('docs/adr/0058-x.md'), 58);
  assert.equal(adrNumber('./docs/adr/0058-x.md'), 58);
  assert.equal(adrNumber('docs/adr/README.md'), null);
  assert.equal(adrNumber('docs/adr/58-x.md'), null);
  assert.equal(adrNumber('docs/other/0058-x.md'), null);
});

test('planAdrRenumber: the PR takes the next free number when the base holds its own; no collision, no plan', () => {
  const tree = ['docs/adr/0057-a.md', 'docs/adr/0058-base.md', 'docs/adr/0058-pr.md', 'docs/adr/README.md', 'src/x.js'];
  assert.deepEqual(planAdrRenumber(tree, ['docs/adr/0058-pr.md']), [
    { from: '0058', to: '0059', fromPath: 'docs/adr/0058-pr.md', toPath: 'docs/adr/0059-pr.md' },
  ]);
  assert.deepEqual(planAdrRenumber(['docs/adr/0057-a.md', 'docs/adr/0058-pr.md'], ['docs/adr/0058-pr.md']), []);
  assert.deepEqual(planAdrRenumber(tree, []), []);
  assert.deepEqual(planAdrRenumber(tree, ['docs/adr/README.md', 'src/x.js']), []);
  assert.deepEqual(planAdrRenumber(['docs/adr/0058-base.md'], ['docs/adr/0058-gone.md']), [], 'an added file absent from the merged tree is ignored');
  const two = planAdrRenumber(['docs/adr/0010-b.md', 'docs/adr/0010-p1.md', 'docs/adr/0011-p2.md', 'docs/adr/0011-b2.md'], ['docs/adr/0010-p1.md', 'docs/adr/0011-p2.md']);
  assert.deepEqual(two.map((r) => [r.from, r.to]), [['0010', '0012'], ['0011', '0013']], 'consecutive free numbers, in file order');
});

test('renumberReferences: only the lines the PR added, ADR- labels and link targets; the base\'s own references stay', () => {
  const added = new Set(['- [ADR-0058: Mine](./0058-mine.md)', 'See ADR-0058 for details.']);
  const content = ['- [ADR-0058: Base](./0058-base.md)', '- [ADR-0058: Mine](./0058-mine.md)', 'See ADR-0058 for details.', 'See ADR-0058 for details.', 'unrelated'].join('\n');
  assert.equal(renumberReferences(content, added, { from: '0058', to: '0059' }), [
    '- [ADR-0058: Base](./0058-base.md)', '- [ADR-0059: Mine](./0059-mine.md)', 'See ADR-0059 for details.', 'See ADR-0059 for details.', 'unrelated',
  ].join('\n'));
  assert.equal(renumberReferences('a\nb', new Set(['b']), { from: '0058', to: '0059' }), 'a\nb', 'an added line without the number is untouched');
});

test('renumberReferences: several renames in one pass, a bare link target, an empty plan; no chain 0058 → 0059 → 0060', () => {
  const lines = new Set(['See ADR-0058 and ADR-0059, [a](0058-a.md) [b](./0059-b.md), ADR-00580.']);
  const content = [...lines][0];
  assert.equal(renumberReferences(content, lines, [{ from: '0058', to: '0059' }, { from: '0059', to: '0060' }]),
    'See ADR-0059 and ADR-0060, [a](0059-a.md) [b](./0060-b.md), ADR-00580.');
  assert.equal(renumberReferences(content, lines, []), content);
});

test('addedLinesOf', () => {
  assert.deepEqual([...addedLinesOf('a\nb\nb\n', 'a\nb\nb\nb\nc\n\n')].sort(), ['b', 'c'], 'multiset difference, blank lines ignored');
  assert.deepEqual([...addedLinesOf(undefined, 'x')], ['x']);
  assert.deepEqual([...addedLinesOf('x', 'x')], []);
});
