import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BREAKER_THRESHOLD, failureSignature, nextStreak, isBreakerOpen, formatEscalationNote } from '../lib/circuit_breaker.mjs';

const finding = (file, line = 1, severity = 'High') => `### ⚠️ Issues Found\n- [${severity}] Title — File: ${file} Lines: ${line} Root cause: x Fix: y\n\n### 🚀 Verdict\nREQUEST_CHANGES`;

test('failureSignature is stable across wording, line numbers, severity and order, and differs by file or check', () => {
  const base = failureSignature({ review: finding('scripts/a.mjs', 10) });
  assert.match(base, /^[0-9a-f]{10}$/);
  assert.equal(failureSignature({ review: finding('scripts/a.mjs', 99, 'Medium') }), base, 'a fix that moves the defect is the same failure');
  assert.notEqual(failureSignature({ review: finding('scripts/b.mjs', 10) }), base);
  const two = `### ⚠️ Issues Found\n- [High] Title — File: scripts/a.mjs Lines: 1\n- [Low] Other — File: scripts/b.mjs Lines: 2`;
  const swapped = `### ⚠️ Issues Found\n- [Low] Other — File: scripts/b.mjs Lines: 2\n- [High] Title — File: scripts/a.mjs Lines: 1`;
  assert.equal(failureSignature({ review: two }), failureSignature({ review: swapped }));
  assert.notEqual(failureSignature({ failing: ['tests'], review: finding('scripts/a.mjs') }), base, 'a failing check is part of the failure');
  assert.equal(failureSignature({ failing: ['lint', 'tests'] }), failureSignature({ failing: ['tests', 'lint', 'tests'] }));
});

test('failureSignature is null when the review names neither a check nor a file', () => {
  assert.equal(failureSignature(), null);
  assert.equal(failureSignature({ review: '### ⚠️ Issues Found\nNone.' }), null);
  assert.equal(failureSignature({ failing: [], review: '' }), null);
});

test('nextStreak counts consecutive REQUEST_CHANGES with the same signature and restarts on anything else', () => {
  const rc = { verdict: 'REQUEST_CHANGES', streak: 2, sig: 'aaaaaaaaaa' };
  assert.deepEqual(nextStreak(rc, { verdict: 'REQUEST_CHANGES', sig: 'aaaaaaaaaa' }), { streak: 3, sig: 'aaaaaaaaaa' });
  assert.deepEqual(nextStreak(rc, { verdict: 'REQUEST_CHANGES', sig: 'bbbbbbbbbb' }), { streak: 1, sig: 'bbbbbbbbbb' }, 'another failure');
  assert.deepEqual(nextStreak(null, { verdict: 'REQUEST_CHANGES', sig: 'aaaaaaaaaa' }), { streak: 1, sig: 'aaaaaaaaaa' }, 'no previous review');
  assert.deepEqual(nextStreak({ verdict: 'WITHHELD' }, { verdict: 'REQUEST_CHANGES', sig: 'aaaaaaaaaa' }), { streak: 1, sig: 'aaaaaaaaaa' });
  assert.deepEqual(nextStreak({ verdict: 'REQUEST_CHANGES', sig: 'aaaaaaaaaa' }, { verdict: 'REQUEST_CHANGES', sig: 'aaaaaaaaaa' }), { streak: 2, sig: 'aaaaaaaaaa' }, 'a marker without a streak counts as 1');
  assert.deepEqual(nextStreak(rc, { verdict: 'REQUEST_CHANGES', sig: null }), { streak: 1, sig: null }, 'nothing to compare: no streak is claimed');
  assert.deepEqual(nextStreak({ verdict: 'REQUEST_CHANGES', streak: 2, sig: null }, { verdict: 'REQUEST_CHANGES', sig: null }), { streak: 1, sig: null });
  for (const verdict of ['APPROVE', 'WITHHELD']) assert.deepEqual(nextStreak(rc, { verdict, sig: 'aaaaaaaaaa' }), { streak: 0, sig: null }, verdict);
});

test('isBreakerOpen opens at the threshold, and only for a whole number', () => {
  assert.equal(BREAKER_THRESHOLD, 3);
  assert.deepEqual([0, 1, 2, 3, 4, 999].map((n) => isBreakerOpen(n)), [false, false, false, true, true, true]);
  assert.equal(isBreakerOpen(2, 2), true, 'the threshold is a parameter');
  for (const bad of [undefined, null, NaN, '3', 3.5]) assert.equal(isBreakerOpen(bad), false, String(bad));
});

test('formatEscalationNote names the streak and how the loop resumes', () => {
  const note = formatEscalationNote(4);
  assert.match(note, /ESCALATED/);
  assert.match(note, /the last 4 automated reviews \(at least 3 needed\)/);
  assert.match(note, /`needs-human`/);
  assert.match(note, /rerun box/);
});
