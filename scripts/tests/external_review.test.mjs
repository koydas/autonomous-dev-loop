import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeExternalReview, EXTERNAL_REVIEWER_LOGIN } from '../lib/external_review.mjs';

const bot = { login: 'chatgpt-codex-connector[bot]' };
const human = { login: 'koydas' };
const review = (sha, user = bot) => ({ user, commit_id: sha });
const thread = (prio, user = bot, extra = {}) => ({ user, body: `**<sub><sub>![${prio} Badge](https://img.shields.io/badge/${prio}-orange?style=flat)</sub></sub>  Title**`, ...extra });

test('counts distinct reviewed commits, root threads and P0/P1 of the bot only', () => {
  const out = summarizeExternalReview({
    reviews: [review('a'), review('a'), review('b'), review('c', human)],
    comments: [thread('P1'), thread('P2'), thread('P0'), thread('P1', human), thread('P1', bot, { in_reply_to_id: 5 })],
  });
  assert.deepEqual(out, { rounds: 2, threads: 3, p0p1: 2 });
});

test('a comment without a badge counts as a thread but not as P0/P1', () => {
  const out = summarizeExternalReview({ reviews: [], comments: [{ user: bot, body: 'plain' }, { user: bot }] });
  assert.deepEqual(out, { rounds: 0, threads: 2, p0p1: 0 });
});

test('a review without commit_id is not a round', () => {
  assert.equal(summarizeExternalReview({ reviews: [{ user: bot }], comments: [] }).rounds, 0);
});

test('an unknown list is null, never zero', () => {
  assert.equal(summarizeExternalReview({ reviews: null, comments: [] }), null);
  assert.equal(summarizeExternalReview({ reviews: [], comments: undefined }), null);
  assert.equal(summarizeExternalReview(), null);
});

test('a missing user is ignored and only the connector login matches', () => {
  assert.deepEqual(summarizeExternalReview({ reviews: [{ commit_id: 'a' }], comments: [{ body: 'x' }] }), { rounds: 0, threads: 0, p0p1: 0 });
  assert.ok(EXTERNAL_REVIEWER_LOGIN.test('chatgpt-codex-connector'));
  assert.ok(!EXTERNAL_REVIEWER_LOGIN.test('someone-codex-connector[bot]'));
  assert.ok(!EXTERNAL_REVIEWER_LOGIN.test('github-actions[bot]'));
});
