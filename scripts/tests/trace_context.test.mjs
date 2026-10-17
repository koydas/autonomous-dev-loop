// ADR-0041: trace identity — deterministic trace id per work item, resolution order, hostile PR text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  traceIdFor, derivedSpanId, newSpanId, branchIssue, closingIssues, payloadWorkItemHint, prWorkItemHint,
  resolveWorkItem, workItem, TRACE_ID_RE, SPAN_ID_RE, MAX_SCANNED_CHARS, MAX_CLOSING_REFS,
} from '../lib/trace_context.mjs';

const REPO = 'owner/repo';

test('traceIdFor: 32 lowercase hex, the first 128 bits of SHA-256 of the key, stable across calls', () => {
  const id = traceIdFor(`${REPO}#issue-12`);
  assert.match(id, TRACE_ID_RE);
  assert.equal(id, createHash('sha256').update(`${REPO}#issue-12`).digest('hex').slice(0, 32));
  assert.equal(id, traceIdFor(`${REPO}#issue-12`));
  assert.notEqual(id, traceIdFor(`${REPO}#pr-12`));
  assert.notEqual(id, traceIdFor(`other/repo#issue-12`));
});

test('span ids: 16 hex, random ones differ, derived ones are stable, an all-zero id is never produced', () => {
  assert.match(newSpanId(), SPAN_ID_RE);
  assert.notEqual(newSpanId(), newSpanId());
  assert.equal(newSpanId(() => Buffer.alloc(8)), '0000000000000001', 'W3C: all-zero is invalid');
  assert.equal(derivedSpanId('a'), derivedSpanId('a'));
  assert.match(derivedSpanId('a'), SPAN_ID_RE);
  assert.notEqual(derivedSpanId('a'), derivedSpanId('b'));
});

test('branchIssue: only ai/issue-<n>, with or without refs/heads/', () => {
  assert.equal(branchIssue('ai/issue-42'), 42);
  assert.equal(branchIssue('refs/heads/ai/issue-7'), 7);
  for (const ref of ['ai/issue-', 'ai/issue-4x', 'feature/ai/issue-4', 'ai/issue-0', 'ai/issue-1234567890', null, 5, `ai/issue-1${'0'.repeat(300)}`]) {
    assert.equal(branchIssue(ref), null, String(ref));
  }
});

test('closingIssues: GitHub closing keywords, body order, dedup, same-repository refs only', () => {
  assert.deepEqual(closingIssues('Closes #12'), [12]);
  assert.deepEqual(closingIssues('fixes: #3\nResolved #9 and closes #3\nCLOSE #4'), [3, 9, 4]);
  assert.deepEqual(closingIssues('closes owner/repo#5, see #6, closes https://x/y#7, unfixes #8, refs #9'), []);
  assert.deepEqual(closingIssues('Closes #0 Closes #1234567890'), [], 'zero and over-long numbers are ignored');
  assert.deepEqual(closingIssues(null), []);
  assert.deepEqual(closingIssues({ body: 'Closes #1' }), []);
});

test('closingIssues: a hostile body is bounded in length scanned and references kept', () => {
  const many = Array.from({ length: 500 }, (_, i) => `Closes #${i + 1}`).join('\n');
  assert.equal(closingIssues(many).length, MAX_CLOSING_REFS);
  const late = `${'x'.repeat(MAX_SCANNED_CHARS)} Closes #77`;
  assert.deepEqual(closingIssues(late), [], 'a reference past the scanned prefix is not read');
  const start = Date.now();
  closingIssues(`${'closes '.repeat(50000)}#`);
  closingIssues(`${'#'.repeat(200000)}`);
  assert.ok(Date.now() - start < 1000, 'linear time on adversarial input');
});

test('payloadWorkItemHint: issue event, dispatch inputs, PR event, issue_comment on a PR, push', () => {
  assert.deepEqual(payloadWorkItemHint({ issue: { number: 12, body: 'Closes #99' } }), { issueNumber: 12, prNumber: null, branchIssue: null, closingIssues: [] });
  assert.equal(payloadWorkItemHint({ inputs: { issue_number: '13' } }).issueNumber, 13);
  assert.equal(payloadWorkItemHint({ inputs: { pr_number: 20 } }).prNumber, 20);
  assert.deepEqual(payloadWorkItemHint({ pull_request: { number: 8, head: { ref: 'ai/issue-5' }, body: 'Closes #6' } }), { issueNumber: null, prNumber: 8, branchIssue: 5, closingIssues: [6] });
  assert.deepEqual(payloadWorkItemHint({ issue: { number: 8, pull_request: {}, body: 'fixes #6' } }), { issueNumber: null, prNumber: 8, branchIssue: null, closingIssues: [6] });
  assert.equal(payloadWorkItemHint({ ref: 'refs/heads/ai/issue-3' }).branchIssue, 3);
  assert.deepEqual(payloadWorkItemHint(null), { issueNumber: null, prNumber: null, branchIssue: null, closingIssues: [] });
  assert.equal(payloadWorkItemHint({ inputs: { issue_number: '1; rm -rf' } }).issueNumber, null);
});

test('prWorkItemHint: the PR a script fetched', () => {
  assert.deepEqual(prWorkItemHint({ number: 8, head: { ref: 'feat/x' }, body: 'Resolves #4' }), { prNumber: 8, branchIssue: null, closingIssues: [4] });
  assert.deepEqual(prWorkItemHint(null), { prNumber: null, branchIssue: null, closingIssues: [] });
});

test('resolveWorkItem: each source, in order issue event → branch → closes → pr → run', () => {
  const r = (hints, runId = '900') => resolveWorkItem({ repository: REPO, runId, hints });
  assert.deepEqual(r([{ issueNumber: 12 }]), { kind: 'issue', number: 12, source: 'issue_event', key: `${REPO}#issue-12`, trace_id: traceIdFor(`${REPO}#issue-12`) });
  assert.equal(r([{ prNumber: 8, branchIssue: 5, closingIssues: [6] }]).key, `${REPO}#issue-5`, 'branch wins over the body');
  assert.equal(r([{ prNumber: 8, branchIssue: 5 }]).source, 'branch');
  assert.deepEqual([r([{ prNumber: 8, closingIssues: [6, 2] }]).key, r([{ prNumber: 8, closingIssues: [6, 2] }]).source], [`${REPO}#issue-6`, 'closes'], 'several issues: the first in body order');
  assert.deepEqual([r([{ prNumber: 8, closingIssues: [] }]).key, r([{ prNumber: 8 }]).source], [`${REPO}#pr-8`, 'pr']);
  assert.deepEqual([r([]).key, r([]).source], [`${REPO}#run-900`, 'run']);
  assert.equal(r([], 'local-1'), null, 'no item and no numeric run id');
  assert.equal(resolveWorkItem(), null);
});

test('resolveWorkItem: the same item resolves to the same trace from every workflow of its life', () => {
  const issue = traceIdFor(`${REPO}#issue-5`);
  const runs = [
    [payloadWorkItemHint({ issue: { number: 5 } })], // validate-issue
    [payloadWorkItemHint({ inputs: { issue_number: 5 } })], // code-generation (dispatch)
    [payloadWorkItemHint({ pull_request: { number: 8, head: { ref: 'ai/issue-5' }, body: 'Closes #5' } })], // pr-review opened
    [payloadWorkItemHint({ ref: 'refs/heads/ai/issue-5' }), { prNumber: 8 }], // pr-review push
    [payloadWorkItemHint({ issue: { number: 8, pull_request: {}, body: 'Closes #5' } })], // auto-fix rerun comment
    [payloadWorkItemHint({ inputs: { pr_number: 8 } }), prWorkItemHint({ number: 8, head: { ref: 'ai/issue-5' }, body: '' })], // reset-auto-fix
  ];
  for (const hints of runs) assert.equal(resolveWorkItem({ repository: REPO, runId: '1', hints }).trace_id, issue);
});

test('resolveWorkItem: the payload wins over event hints; malformed hints are ignored', () => {
  const item = resolveWorkItem({ repository: REPO, hints: [{ issueNumber: 3 }, { issueNumber: 4 }] });
  assert.equal(item.number, 3);
  const odd = resolveWorkItem({ repository: '', runId: 7, hints: [null, 'x', { issueNumber: -1, branchIssue: 'ai', closingIssues: 'Closes #1', prNumber: 1.5 }] });
  assert.equal(odd.key, 'local#run-7');
  assert.equal(resolveWorkItem({ repository: REPO, hints: 'nope', runId: '2' }).kind, 'run');
});

test('workItem: unknown kind or invalid number → null', () => {
  assert.equal(workItem(REPO, 'commit', 3), null);
  assert.equal(workItem(REPO, 'issue', 0), null);
  assert.equal(workItem(null, 'pr', 3).key, 'local#pr-3');
});
