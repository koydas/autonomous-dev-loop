import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_SOURCES,
  CODE_CHANGE_LABELS,
  decideGenerationBlocked,
  escalateBlocked,
  findDeterministicBlock,
  findNeededPaths,
  findNotesOnlyChange,
  formatBlockedComment,
  parseIssueLabels,
  readBlockedSignal,
} from '../lib/generation_blocked.mjs';
import { protectedPathEntry } from '../lib/output_writer.mjs';

// Abridged bodies of the two issues that produced notes-only PRs (#191, #196).
const ISSUE_190 = {
  issueTitle: '[BUG] pr_review: a symlinked config/models.yaml in the PR tree aborts the review; symlink handling untested',
  issueBody: [
    '> **Blocked by #188.** The code concerned (`readHeadOrNull`) exists only on #188\'s branch.',
    'Both findings were reported in the #188 review: https://github.com/koydas/autonomous-dev-loop/pull/188#issuecomment-6137106038',
    '- Component: `scripts/pr_review.mjs` (review stage entrypoint)',
    '- Environment: `pr-review.yml` review job',
    '- `grep -i symlink scripts/tests/pr_review.test.mjs` finds nothing.',
    '1. `ln -sf /dev/zero config/models.yaml`',
    '- A symlinked `docs/**/*.md` or ADR is skipped by both searches.',
    '- [ ] Entrypoint test in `scripts/tests/pr_review.test.mjs`.',
    '- [ ] `CHANGELOG.md` entry under `[Unreleased]`.',
    '- Edit scope limited to `scripts/pr_review.mjs`. No change to exported signatures in `scripts/lib/`.',
    '- Observability through `scripts/lib/observability.mjs` only.',
  ].join('\n'),
};
const ISSUE_195 = {
  issueTitle: '[BUG] dependency_manifest: a symlinked package.json in the PR tree is followed',
  issueBody: [
    'Reported in the #194 review: https://github.com/koydas/autonomous-dev-loop/pull/194#issuecomment-6137656513',
    '- Component: `scripts/lib/dependency_manifest.mjs`, called at top level in `scripts/pr_review.mjs`.',
    '- `package.json -> /some/dir` → `EISDIR`; `package.json -> /dev/zero` hangs.',
    '- Log one `warn` event through `observability.mjs`.',
    '- [ ] Unit tests in `scripts/tests/`.',
    '- [ ] `CHANGELOG.md` entry if an entrypoint changes.',
  ].join('\n'),
};
const atRoot = (...names) => (p) => names.includes(p);

// ---------------------------------------------------------------------------
// findNeededPaths
// ---------------------------------------------------------------------------

test('findNeededPaths drops URL segments, CHANGELOG.md and bare names of paths the issue also names', () => {
  const needed = findNeededPaths(ISSUE_190.issueTitle, ISSUE_190.issueBody, { fileExists: atRoot('CHANGELOG.md', 'scripts/lib') });
  assert.deepEqual(needed.sort(), ['config/models.yaml', 'scripts/lib', 'scripts/lib/observability.mjs', 'scripts/pr_review.mjs', 'scripts/tests/pr_review.test.mjs']);
});

test('findNeededPaths keeps a bare name only when it exists at the repository root', () => {
  assert.deepEqual(findNeededPaths('Update package.json and helper.mjs', '', { fileExists: atRoot('package.json') }), ['package.json']);
});

test('findNeededPaths keeps a nested CHANGELOG.md (only the root companion is dropped)', () => {
  assert.deepEqual(findNeededPaths('Edit packages/a/CHANGELOG.md', '', {}), ['packages/a/CHANGELOG.md']);
});

test('findNeededPaths drops prose with a slash that is neither an existing path nor a file name (#134, #150, #209, #211, #236)', () => {
  const body = 'Retry/fallback on 401/403 and 500/502/503/504, old/new model, open/closed, TPD/RPD. Edit scripts/lib/llm_client.mjs and scripts/tests.';
  assert.deepEqual(findNeededPaths('Chaos tests', body, { fileExists: atRoot('scripts/tests') }).sort(), ['scripts/lib/llm_client.mjs', 'scripts/tests']);
  assert.deepEqual(findNeededPaths('Chaos tests', body).sort(), ['scripts/lib/llm_client.mjs'], 'a directory counts only when it exists');
});

test('findNeededPaths keeps a new file with a known extension even when it does not exist yet', () => {
  assert.deepEqual(findNeededPaths('Add docs/new-note.md', ''), ['docs/new-note.md']);
});

test('findNeededPaths keeps a file whose extension the context injector does not list', () => {
  assert.deepEqual(findNeededPaths('Update src/App/App.csproj', ''), ['src/App/App.csproj']);
});

test('findNeededPaths restores the leading dot the extractor drops', () => {
  assert.deepEqual(findNeededPaths('Edit .github/workflows/evals.yml', 'and github/other.yml'), ['.github/workflows/evals.yml', 'github/other.yml']);
  assert.deepEqual(findNeededPaths('See the my.github/x.yml file', ''), ['my.github/x.yml'], 'a dot inside another word is not a leading dot');
});

test('findNeededPaths returns nothing for an issue that names no path', () => {
  assert.deepEqual(findNeededPaths('Add a helper', undefined), []);
});

// ---------------------------------------------------------------------------
// findDeterministicBlock
// ---------------------------------------------------------------------------

test('findDeterministicBlock still blocks when the issue also contains prose with slashes (#134 shape)', () => {
  const block = findDeterministicBlock({
    issueTitle: 'Chaos test scenarios',
    issueBody: 'Retry/fallback on 401/403 and 500/502/503/504; delays 200/400/800.\nScope: scripts/tests/retry.test.mjs, scripts/lib/llm_client.mjs, .github/workflows/evals.yml.',
    fileExists: atRoot('scripts/tests'),
  });
  assert.deepEqual(block.paths.map((p) => p.path).sort(), ['.github/workflows/evals.yml', 'scripts/lib/llm_client.mjs', 'scripts/tests/retry.test.mjs']);
});

test('findDeterministicBlock blocks issue #190: every needed path is protected', () => {
  const block = findDeterministicBlock({ ...ISSUE_190, fileExists: atRoot('CHANGELOG.md') });
  assert.ok(block);
  assert.ok(block.paths.every((p) => /protected path \(scripts\/|protected path \(config\//.test(p.why)), JSON.stringify(block.paths));
});

test('findDeterministicBlock blocks issue #195: scripts/ and package.json are protected', () => {
  const block = findDeterministicBlock({ ...ISSUE_195, fileExists: atRoot('CHANGELOG.md', 'package.json') });
  assert.ok(block);
  assert.ok(block.paths.some((p) => p.path === 'package.json' && /package\.json/.test(p.why)));
});

test('findDeterministicBlock blocks when the only writable-looking path was withheld from the prompt', () => {
  const block = findDeterministicBlock({ issueTitle: 'Fix src/big.js', issueBody: 'see scripts/x.mjs', hiddenPaths: new Set(['src/big.js']) });
  assert.deepEqual(block.paths.map((p) => p.path), ['src/big.js', 'scripts/x.mjs']);
  assert.match(block.paths[0].why, /withheld/);
});

test('findDeterministicBlock does not block when one needed path is writable', () => {
  assert.equal(findDeterministicBlock({ issueTitle: 'Fix src/app.js', issueBody: 'like scripts/pr_review.mjs does' }), null);
});

test('findDeterministicBlock does not block an issue that names no path (left to the model)', () => {
  assert.equal(findDeterministicBlock({ issueTitle: 'Add a helper', issueBody: 'Make it fast.' }), null);
});

test('protectedPathEntry returns the denylist entry or null', () => {
  assert.equal(protectedPathEntry('./Scripts/a.mjs'), 'scripts/');
  assert.equal(protectedPathEntry('pkg/README.md'), 'README.md');
  assert.equal(protectedPathEntry('src/a.js'), null);
  assert.equal(protectedPathEntry(undefined), null);
});

// ---------------------------------------------------------------------------
// readBlockedSignal
// ---------------------------------------------------------------------------

test('readBlockedSignal reads blocked: true with its reason and planned fix', () => {
  assert.deepEqual(readBlockedSignal({ blocked: true, blocked_reason: ' Blocked by #188 ', planned_fix: 'edit x' }), { reason: 'Blocked by #188', plannedFix: 'edit x' });
});

test('readBlockedSignal defaults a missing reason and planned fix', () => {
  assert.deepEqual(readBlockedSignal({ blocked: true, blocked_reason: 42 }), { reason: '(no reason given)', plannedFix: '' });
});

test('readBlockedSignal: absent, null or false is not blocked, whatever the summary says', () => {
  assert.equal(readBlockedSignal({ summary: 'This issue is blocked by #188', changes: [] }), null);
  assert.equal(readBlockedSignal({ blocked: null }), null);
  assert.equal(readBlockedSignal({ blocked: false, blocked_reason: 'blocked' }), null);
  assert.equal(readBlockedSignal(undefined), null);
});

test('readBlockedSignal rejects a non-boolean blocked value (free text is never a signal)', () => {
  assert.throws(() => readBlockedSignal({ blocked: 'true' }), /blocked must be a boolean \(got string\)/);
  assert.throws(() => readBlockedSignal({ blocked: 1 }), /got number/);
});

// ---------------------------------------------------------------------------
// parseIssueLabels
// ---------------------------------------------------------------------------

test('parseIssueLabels reads a JSON array, a comma list, and empty input', () => {
  assert.deepEqual(parseIssueLabels('["bug","ready-for-dev"]'), ['bug', 'ready-for-dev']);
  assert.deepEqual(parseIssueLabels('[" bug ", 3, ""]'), ['bug']);
  assert.deepEqual(parseIssueLabels('bug, ready-for-dev'), ['bug', 'ready-for-dev']);
  assert.deepEqual(parseIssueLabels('{"a":1}'), ['{"a":1}']);
  assert.deepEqual(parseIssueLabels(''), []);
  assert.deepEqual(parseIssueLabels(undefined), []);
});

// ---------------------------------------------------------------------------
// findNotesOnlyChange
// ---------------------------------------------------------------------------

const note = (target_path, file_content = '# Plan\n') => ({ target_path, file_content });

test('findNotesOnlyChange refuses new .md notes outside docs/ for a bug or feature issue (#191, #196)', () => {
  assert.deepEqual(findNotesOnlyChange([note('notes/issue-190-blocked.md')], { labels: ['Bug'] }), { label: 'Bug', paths: ['notes/issue-190-blocked.md'] });
  assert.deepEqual(findNotesOnlyChange([note('patches/issue-195-dependency-manifest.MD')], { labels: ['feature'] }).paths, ['patches/issue-195-dependency-manifest.MD']);
  assert.deepEqual([...CODE_CHANGE_LABELS], ['bug', 'feature']);
});

test('findNotesOnlyChange ignores issues without a bug or feature label', () => {
  assert.equal(findNotesOnlyChange([note('notes/a.md')], { labels: ['ready-for-dev', 'documentation'] }), null);
  assert.equal(findNotesOnlyChange([note('notes/a.md')]), null);
});

test('findNotesOnlyChange allows a patch with any non-Markdown file', () => {
  assert.equal(findNotesOnlyChange([note('notes/a.md'), note('src/a.js', 'x')], { labels: ['bug'] }), null);
});

test('findNotesOnlyChange allows editing an existing Markdown file, and leaves docs/ to the denylist', () => {
  assert.equal(findNotesOnlyChange([note('CONTRIBUTING.md')], { labels: ['bug'], fileExists: atRoot('CONTRIBUTING.md') }), null);
  assert.equal(findNotesOnlyChange([note('docs/guide.md')], { labels: ['bug'] }), null);
});

test('findNotesOnlyChange returns null for empty or malformed changes', () => {
  assert.equal(findNotesOnlyChange([], { labels: ['bug'] }), null);
  assert.equal(findNotesOnlyChange('nope', { labels: ['bug'] }), null);
  assert.equal(findNotesOnlyChange([{ target_path: 3 }], { labels: ['bug'] }), null);
});

// ---------------------------------------------------------------------------
// decideGenerationBlocked — precedence
// ---------------------------------------------------------------------------

const DETERMINISTIC = { paths: [{ path: 'scripts/pr_review.mjs', why: 'protected path (scripts/, ADR-0021)' }] };

test('decideGenerationBlocked: the deterministic check wins over the model saying blocked: false', () => {
  const blocked = decideGenerationBlocked({
    deterministic: DETERMINISTIC,
    aiOutput: { summary: 'Write a handoff note', blocked: false, changes: [note('notes/issue-190-blocked.md', '## Planned fix\nguard readHeadOrNull')] },
  });
  assert.equal(blocked.source, BLOCKED_SOURCES.DENYLIST);
  assert.match(blocked.reason, /`scripts\/pr_review\.mjs` \(protected path/);
  assert.equal(blocked.plannedFix, '## Planned fix\nguard readHeadOrNull', 'the note content is the planned fix');
});

test('decideGenerationBlocked: the deterministic reason carries the model reason when both fire', () => {
  const blocked = decideGenerationBlocked({ deterministic: DETERMINISTIC, aiOutput: { blocked: true, blocked_reason: 'Blocked by #188', planned_fix: 'plan', changes: [] } });
  assert.equal(blocked.source, BLOCKED_SOURCES.DENYLIST);
  assert.match(blocked.reason, /Model: Blocked by #188$/);
  assert.equal(blocked.plannedFix, 'plan');
});

test('decideGenerationBlocked: the model signal blocks when the deterministic check does not', () => {
  const blocked = decideGenerationBlocked({ aiOutput: { summary: 's', blocked: true, blocked_reason: 'Blocked by #188 (unmerged)', planned_fix: 'add a guard', changes: [] } });
  assert.deepEqual(blocked, { source: BLOCKED_SOURCES.MODEL, reason: 'Blocked by #188 (unmerged)', plannedFix: 'add a guard' });
});

test('decideGenerationBlocked: the notes-only refusal applies last, with the notes as the planned fix', () => {
  const blocked = decideGenerationBlocked({
    aiOutput: { summary: 'Notes', changes: [note('notes/a.md', 'first'), note('notes/b.md', 'second')] },
    labels: ['bug'],
  });
  assert.equal(blocked.source, BLOCKED_SOURCES.NOTES_ONLY);
  assert.match(blocked.reason, /`notes\/a\.md`, `notes\/b\.md`.*labelled `bug`/);
  assert.equal(blocked.plannedFix, '**notes/a.md**\n\nfirst\n\n**notes/b.md**\n\nsecond');
});

test('decideGenerationBlocked: falls back to the summary and caps long text', () => {
  const blocked = decideGenerationBlocked({ deterministic: DETERMINISTIC, aiOutput: { summary: 'x'.repeat(5000), changes: 'bad' } });
  assert.equal(blocked.plannedFix.length, 4000 + '\n…(truncated)'.length);
});

test('decideGenerationBlocked: not blocked returns null (a real patch proceeds)', () => {
  assert.equal(decideGenerationBlocked({ aiOutput: { summary: 'Add helper', changes: [note('src/a.js', 'x')] }, labels: ['bug'] }), null);
});

test('decideGenerationBlocked: a malformed blocked value throws instead of guessing', () => {
  assert.throws(() => decideGenerationBlocked({ deterministic: DETERMINISTIC, aiOutput: { blocked: 'yes' } }), /must be a boolean/);
});

// ---------------------------------------------------------------------------
// formatBlockedComment / escalateBlocked
// ---------------------------------------------------------------------------

const BLOCKED = { source: BLOCKED_SOURCES.MODEL, reason: 'Blocked by #188', plannedFix: 'Guard readHeadOrNull.' };
const NEEDS_HUMAN = { name: 'needs-human', color: 'b60205', description: 'd' };

test('formatBlockedComment states the outcome, source, reason and planned fix', () => {
  const body = formatBlockedComment(BLOCKED, { needsHuman: 'needs-human', readyForDev: 'ready-for-dev' });
  assert.match(body, /Code Generation: Blocked/);
  assert.match(body, /no branch was pushed and no pull request was opened\. `ready-for-dev` was replaced by `needs-human`/);
  assert.match(body, /\*\*Detected by:\*\* the model \(`blocked: true`\)/);
  assert.match(body, /\*\*Reason:\*\* Blocked by #188/);
  assert.match(body, /### Planned fix\n\nGuard readHeadOrNull\./);
});

test('formatBlockedComment names the deterministic sources, an unknown source, and a missing plan', () => {
  assert.match(formatBlockedComment({ ...BLOCKED, source: 'denylist' }, { needsHuman: 'n', readyForDev: 'r' }), /protected or withheld files/);
  assert.match(formatBlockedComment({ ...BLOCKED, source: 'notes_only' }, { needsHuman: 'n', readyForDev: 'r' }), /notes-only patch/);
  const body = formatBlockedComment({ source: 'other', reason: 'r', plannedFix: '' }, { needsHuman: 'n', readyForDev: 'r' });
  assert.match(body, /\*\*Detected by:\*\* other/);
  assert.match(body, /_\(none provided\)_/);
});

function fakeRequest(statuses = {}) {
  const calls = [];
  const request = async (endpoint, options) => {
    calls.push({ endpoint, method: options.method, body: options.body });
    const status = statuses[`${options.method} ${endpoint}`] ?? 200;
    return { ok: status >= 200 && status < 300, status };
  };
  return { calls, request };
}
const ESCALATION = { repository: 'o/r', issueNumber: '7', blocked: BLOCKED, needsHuman: NEEDS_HUMAN, readyForDev: 'ready-for-dev' };

test('escalateBlocked creates and applies needs-human, removes ready-for-dev, then comments', async () => {
  const { calls, request } = fakeRequest({ 'POST /repos/o/r/labels': 422 });
  await escalateBlocked({ request, ...ESCALATION });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.endpoint}`), [
    'POST /repos/o/r/labels',
    'POST /repos/o/r/issues/7/labels',
    'DELETE /repos/o/r/issues/7/labels/ready-for-dev',
    'POST /repos/o/r/issues/7/comments',
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), { labels: ['needs-human'] });
  assert.match(JSON.parse(calls[3].body).body, /Code Generation: Blocked/);
});

test('escalateBlocked tolerates ready-for-dev already removed (404) and encodes the label name', async () => {
  const { calls, request } = fakeRequest({ 'DELETE /repos/o/r/issues/7/labels/ready%20for%20dev': 404 });
  await escalateBlocked({ request, ...ESCALATION, readyForDev: 'ready for dev' });
  assert.equal(calls.length, 4);
});

test('escalateBlocked throws on each failed call and stops there', async () => {
  const cases = [
    ['POST /repos/o/r/labels', /Label create failed for "needs-human": 403/, 1],
    ['POST /repos/o/r/issues/7/labels', /Add label "needs-human" failed: 403/, 2],
    ['DELETE /repos/o/r/issues/7/labels/ready-for-dev', /Remove label "ready-for-dev" failed: 403/, 3],
    ['POST /repos/o/r/issues/7/comments', /Blocked comment failed: 403/, 4],
  ];
  for (const [call, message, count] of cases) {
    const { calls, request } = fakeRequest({ [call]: 403 });
    await assert.rejects(() => escalateBlocked({ request, ...ESCALATION }), message);
    assert.equal(calls.length, count, call);
  }
});
