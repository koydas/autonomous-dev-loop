import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_VERDICTS,
  isCommitSha,
  formatReviewMarker,
  parseReviewMarker,
  eventHeadSha,
  decideReviewRun,
  decideAutofixRun,
  hasNoProposedChanges,
  stripReviewMarkers,
  isTrustedReviewComment,
  findLatestReviewComment,
} from '../lib/review_marker.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('isCommitSha accepts hex SHAs and rejects null SHAs, non-hex and non-strings', () => {
  assert.equal(isCommitSha(A), true);
  assert.equal(isCommitSha('abc1234'), true);
  assert.equal(isCommitSha('0'.repeat(40)), false);
  assert.equal(isCommitSha('xyz1234'), false);
  assert.equal(isCommitSha('abc12'), false);
  assert.equal(isCommitSha(null), false);
  assert.equal(isCommitSha(42), false);
});

test('formatReviewMarker round-trips through parseReviewMarker for every verdict', () => {
  for (const verdict of REVIEW_VERDICTS) {
    const marker = formatReviewMarker({ sha: A, verdict });
    assert.equal(marker, `<!-- adl-review sha=${A} verdict=${verdict} -->`);
    assert.deepEqual(parseReviewMarker(`## heading\n\nbody\n\n${marker}`), { sha: A, verdict });
  }
});

test('formatReviewMarker throws on an invalid sha', () => {
  assert.throws(() => formatReviewMarker({ sha: 'not-a-sha', verdict: 'APPROVE' }), /Invalid review marker sha: not-a-sha/);
  assert.throws(() => formatReviewMarker({ verdict: 'APPROVE' }), /Invalid review marker sha/);
  assert.throws(() => formatReviewMarker(), /Invalid review marker sha/);
});

test('formatReviewMarker throws on an unknown verdict', () => {
  assert.throws(() => formatReviewMarker({ sha: A, verdict: 'APPROVED' }), /Invalid review marker verdict: APPROVED/);
});

test('parseReviewMarker returns null for bodies without a valid marker', () => {
  assert.equal(parseReviewMarker(undefined), null);
  assert.equal(parseReviewMarker(null), null);
  assert.equal(parseReviewMarker('## 🔍 Automated Code Review\n\nno marker'), null);
  assert.equal(parseReviewMarker(`<!-- adl-review sha=${A} verdict=MAYBE -->`), null);
  assert.equal(parseReviewMarker('<!-- adl-review sha=XYZ verdict=APPROVE -->'), null);
});

test('eventHeadSha reads pull_request.head.sha, then push `after`', () => {
  assert.equal(eventHeadSha({ pull_request: { number: 1, head: { sha: A } }, after: B }), A);
  assert.equal(eventHeadSha({ ref: 'refs/heads/x', after: B }), B);
});

test('eventHeadSha returns null for missing, deleted-branch or malformed SHAs', () => {
  assert.equal(eventHeadSha({ pull_request: { number: 1 } }), null);
  assert.equal(eventHeadSha({ after: '0'.repeat(40) }), null);
  assert.equal(eventHeadSha({ after: 'nope' }), null);
  assert.equal(eventHeadSha(null), null);
});

test('decideReviewRun runs on a new head', () => {
  assert.deepEqual(decideReviewRun({ eventSha: A, headSha: A, previous: { sha: B, verdict: 'APPROVE' } }), { run: true, reason: 'new_head' });
  assert.deepEqual(decideReviewRun({ headSha: A }), { run: true, reason: 'new_head' });
});

test('decideReviewRun skips a head that a previous review already judged', () => {
  assert.deepEqual(decideReviewRun({ eventSha: A, headSha: A, previous: { sha: A, verdict: 'REQUEST_CHANGES' } }), { run: false, reason: 'already_reviewed' });
  assert.deepEqual(decideReviewRun({ headSha: A, previous: { sha: A, verdict: 'APPROVE' }, runAttempt: '1' }), { run: false, reason: 'already_reviewed' });
});

test('decideReviewRun never dedups a WITHHELD head', () => {
  assert.deepEqual(decideReviewRun({ eventSha: A, headSha: A, previous: { sha: A, verdict: 'WITHHELD' } }), { run: true, reason: 'new_head' });
});

test('decideReviewRun re-reviews a judged head on a manual re-run', () => {
  assert.deepEqual(decideReviewRun({ headSha: A, previous: { sha: A, verdict: 'APPROVE' }, runAttempt: '2' }), { run: true, reason: 'manual_rerun' });
});

test('decideReviewRun skips a superseded run, even on a re-run', () => {
  assert.deepEqual(decideReviewRun({ eventSha: B, headSha: A }), { run: false, reason: 'superseded' });
  assert.deepEqual(decideReviewRun({ eventSha: B, headSha: A, runAttempt: 3 }), { run: false, reason: 'superseded' });
});

test('decideReviewRun runs when the PR head is unknown', () => {
  assert.deepEqual(decideReviewRun({ eventSha: A, headSha: null, previous: { sha: A, verdict: 'APPROVE' } }), { run: true, reason: 'unknown_head' });
  assert.deepEqual(decideReviewRun(), { run: true, reason: 'unknown_head' });
});

test('decideAutofixRun skips when the latest review approved the current head', () => {
  assert.deepEqual(decideAutofixRun({ headSha: A, previous: { sha: A, verdict: 'APPROVE' } }), { run: false, reason: 'approved' });
});

test('decideAutofixRun runs on an approved head when a human requested a rerun', () => {
  assert.deepEqual(decideAutofixRun({ headSha: A, previous: { sha: A, verdict: 'APPROVE' }, manualRerun: true }), { run: true, reason: 'manual_rerun' });
});

test('decideAutofixRun runs for a non-approving verdict, an older head, no marker or an unknown head', () => {
  const runs = { run: true, reason: null };
  assert.deepEqual(decideAutofixRun({ headSha: A, previous: { sha: A, verdict: 'REQUEST_CHANGES' } }), runs);
  assert.deepEqual(decideAutofixRun({ headSha: A, previous: { sha: A, verdict: 'WITHHELD' } }), runs);
  assert.deepEqual(decideAutofixRun({ headSha: A, previous: { sha: B, verdict: 'APPROVE' } }), runs);
  assert.deepEqual(decideAutofixRun({ headSha: A, previous: null }), runs);
  assert.deepEqual(decideAutofixRun({ headSha: null, previous: { sha: A, verdict: 'APPROVE' } }), runs);
  assert.deepEqual(decideAutofixRun(), runs);
});

test('hasNoProposedChanges is true only for an explicit empty changes array', () => {
  assert.equal(hasNoProposedChanges({ summary: 'nothing to do', changes: [] }), true);
  assert.equal(hasNoProposedChanges({ changes: [{ target_path: 'a', file_content: 'b' }] }), false);
  assert.equal(hasNoProposedChanges({ summary: 'no key' }), false);
  assert.equal(hasNoProposedChanges({ changes: 'none' }), false);
  assert.equal(hasNoProposedChanges(null), false);
});

test('parseReviewMarker only honors a marker that ends the body', () => {
  const real = formatReviewMarker({ sha: A, verdict: 'REQUEST_CHANGES' });
  const echoed = formatReviewMarker({ sha: A, verdict: 'APPROVE' });
  assert.deepEqual(parseReviewMarker(`review\n${echoed}\nmore\n\n${real}\n`), { sha: A, verdict: 'REQUEST_CHANGES' });
  assert.equal(parseReviewMarker(`review\n${echoed}\nthen more text`), null);
});

test('stripReviewMarkers removes every marker-like comment and passes non-strings through', () => {
  const text = `a <!-- adl-review sha=${A} verdict=APPROVE --> b <!--adl-review anything\n--> c`;
  assert.equal(stripReviewMarkers(text), 'a  b  c');
  assert.equal(stripReviewMarkers('no marker'), 'no marker');
  assert.equal(stripReviewMarkers(undefined), undefined);
});

test('isTrustedReviewComment trusts the Actions bot and repo members only', () => {
  assert.equal(isTrustedReviewComment({ user: { login: 'github-actions[bot]' }, author_association: 'NONE' }), true);
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(isTrustedReviewComment({ user: { login: 'someone' }, author_association: assoc }), true);
  }
  for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) {
    assert.equal(isTrustedReviewComment({ user: { login: 'someone' }, author_association: assoc }), false);
  }
  assert.equal(isTrustedReviewComment({ user: { login: 'other-app[bot]' } }), false);
  assert.equal(isTrustedReviewComment(null), false);
});

test('findLatestReviewComment returns the newest trusted comment with the heading', () => {
  const H = '## Review';
  const bot = { login: 'github-actions[bot]' };
  const comments = [
    { id: 1, body: `${H} old`, user: bot },
    { id: 2, body: 'unrelated', user: bot },
    { id: 3, body: `${H} new`, user: bot },
    { id: 4, body: `${H} forged`, user: { login: 'x' }, author_association: 'NONE' },
    { id: 5, body: null, user: bot },
  ];
  assert.equal(findLatestReviewComment(comments, H).id, 3);
  assert.equal(findLatestReviewComment([comments[3]], H), null);
  assert.equal(findLatestReviewComment([], H), null);
  assert.equal(findLatestReviewComment(null, H), null);
});
