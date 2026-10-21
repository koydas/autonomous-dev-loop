// ADR-0043 amendment (2026-10-21): "Waiting on you", the end of a work item (`item.closed`) and the findings
// kept for escalations the design does not explain. The scenario reproduces the shape of the production
// records that motivated it: ten escalations over seven work items, one still open (issue #200), six ended
// by a merge or a closing. Numbers follow the incident; the records are rebuilt, not copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../lib/pipeline_diagnostics.mjs';
import { journeys, closings, isLifecycleRun, STATES, workItemJourney } from '../lib/pipeline_journey.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { waitingOnYou, explainEscalation } from '../lib/pipeline_waiting.mjs';
import { consoleContext } from '../lib/console_views.mjs';
import { consoleOverview, waitingPanel } from '../lib/console_overview.mjs';
import { computeOverview, computeWindow } from '../lib/pipeline_kpis.mjs';
import { makeRecord, makeClosingRecord, asFiles, indexesOf, HOSTILE, RAW_MARKERS } from './fixtures/pipeline/records.mjs';

const T0 = Date.parse('2026-10-10T08:00:00Z');
const H = 3600000;
const URL = (n, c) => `https://github.com/koydas/autonomous-dev-loop/issues/${n}#issuecomment-${c}`;
let run = 1000;

// code_gen blocked (generate_issue_change.mjs): context_built, skipped, escalated.
const blocked = ({ issue, at, source = 'model', hidden = [] }) => makeRecord({
  runId: String(run++), workflow: 'Code Generation', stage: 'code_gen', start: at, issueNumber: issue, prNumber: null,
  events: [
    { event: 'code_gen.context_built', meta: { shown_files: [], hidden_files: hidden, deterministic_block: source === 'denylist' } },
    { event: 'code_gen.skipped', level: 'warn', meta: { reason: 'blocked', source } },
    { event: 'code_gen.escalated', level: 'warn', meta: { during: 'code_gen', reason: 'blocked', source, labels_added: ['needs-human'], url: URL(issue, run) } },
  ],
});

// auto-fix attempt that ended in an escalation (auto_fix_pr.mjs): prompt_budget, [skipped], escalated.
const autofix = ({ pr, issue = null, at, reason, shown = [], hidden = [], rules = [], withheld = [] }) => makeRecord({
  runId: String(run++), workflow: 'Auto-Fix PR', stage: 'autofix', start: at, prNumber: pr, ...(issue && { issueNumber: issue, item: { kind: 'issue', number: issue, source: 'branch' } }),
  events: [
    ...withheld.map((path) => ({ event: 'autofix.file_withheld', level: 'warn', meta: { prNumber: pr, path, reason: 'too_large' } })),
    { event: 'autofix.prompt_budget', meta: { prNumber: pr, shown_files: shown, hidden_files: hidden } },
    { event: 'autofix.skipped', level: 'warn', meta: { prNumber: pr, reason, rules } },
    { event: 'autofix.escalated', level: 'warn', meta: { prNumber: pr, reason, labels_added: ['needs-human'], url: URL(pr, run) } },
  ],
});

const closed = (o) => makeClosingRecord({ runId: String(run++), ...o });

// The ten escalations.
const ESCALATIONS = () => [
  blocked({ issue: 200, at: T0, hidden: ['src/big.mjs'] }), // 1: open
  autofix({ pr: 219, at: T0 + H, reason: 'no_changes', shown: ['package.json'] }), // 2: only a protected file shown
  autofix({ pr: 219, at: T0 + 2 * H, reason: 'no_changes', shown: ['package.json'] }), // 3
  autofix({ pr: 221, at: T0 + 3 * H, reason: 'guardrail_rejected', rules: ['protected_path'] }), // 4
  autofix({ pr: 225, issue: 211, at: T0 + 4 * H, reason: 'no_changes', hidden: ['docs/big.md'] }), // 5: files withheld by the budget
  autofix({ pr: 225, issue: 211, at: T0 + 5 * H, reason: 'no_changes', hidden: ['docs/big.md'] }), // 6
  blocked({ issue: 134, at: T0 + 6 * H, source: 'denylist', hidden: ['scripts/a.mjs'] }), // 7
  blocked({ issue: 150, at: T0 + 7 * H, hidden: ['src/huge.mjs'] }), // 8
  autofix({ pr: 209, at: T0 + 8 * H, reason: 'guardrail_rejected', rules: ['unshown_file', 'protected_path'], withheld: ['src/huge.mjs'] }), // 9
  autofix({ pr: 209, at: T0 + 9 * H, reason: 'guardrail_rejected', rules: ['unshown_file', 'protected_path'], withheld: ['src/huge.mjs'] }), // 10
];

// The seven closings: three merged PRs, one of them also closing its issue, two closed issues, one PR closed unmerged.
const CLOSINGS = () => {
  const at = T0 + 24 * H;
  return [
    closed({ start: at, eventName: 'pull_request', prNumber: 219, meta: { merged: true } }),
    closed({ start: at + H, eventName: 'pull_request', prNumber: 221, meta: { merged: true } }),
    closed({ start: at + 2 * H, eventName: 'pull_request', prNumber: 225, item: { kind: 'issue', number: 211, source: 'branch' }, meta: { merged: true } }),
    closed({ start: at + 2 * H + 1000, eventName: 'issues', issueNumber: 211, meta: { state_reason: 'completed' } }),
    closed({ start: at + 3 * H, eventName: 'issues', issueNumber: 134, meta: { state_reason: 'not_planned' } }),
    closed({ start: at + 4 * H, eventName: 'issues', issueNumber: 150, meta: { state_reason: 'completed' } }),
    closed({ start: at + 5 * H, eventName: 'pull_request', prNumber: 209, meta: { merged: false } }),
  ];
};

const build = (records) => {
  const model = buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });
  return { model, js: journeys(model) };
};
const stateOf = (js, kind, number) => js.find((j) => j.item.kind === kind && j.item.number === number)?.state;

test('scenario: ten escalations, seven closings → the queue holds #200 only and no warning is raised', () => {
  const { model, js } = build([...ESCALATIONS(), ...CLOSINGS()]);
  assert.equal(js.length, 7, 'seven work items');
  assert.equal(js.reduce((n, j) => n + j.escalations.length, 0), 10, 'ten escalations recorded');
  assert.equal(js.flatMap((j) => j.closing ? [j.closing] : []).length, 6, 'six items ended');
  const states = Object.fromEntries(js.map((j) => [`${j.item.kind}-${j.item.number}`, j.state]));
  assert.deepEqual(states, { 'issue-200': 'escalated', 'pr-219': 'merged', 'pr-221': 'merged', 'issue-211': 'merged', 'issue-134': 'closed', 'issue-150': 'closed', 'pr-209': 'closed' });

  const rows = waitingOnYou({ model, journeys: js });
  assert.equal(rows.length, 1);
  assert.deepEqual({ kind: rows[0].item.kind, number: rows[0].item.number }, { kind: 'issue', number: 200 });
  assert.equal(rows[0].step, 'Code generation');
  assert.match(rows[0].reason, /could not implement the issue; files withheld from its context: src\/big\.mjs/);
  assert.deepEqual(rows[0].files, ['src/big.mjs']);
  assert.equal(rows[0].by_design, true);
  assert.match(rows[0].url, /issues\/200#issuecomment-/);
  assert.equal(rows[0].since, T0 + 220, 'the escalation event, third of the run');

  const d = diagnose({ model, journeys: js });
  assert.deepEqual(d.findings.filter((f) => f.severity === 'warning' || f.severity === 'critical'), []);
  assert.ok(!d.findings.some((f) => f.id === 'escalations'));
  assert.notEqual(d.status, 'critical');
  assert.equal(d.status, 'ok');
});

test('closings before the journal exist are not inferred: the items stay waiting and the gap says so', () => {
  const { model, js } = build(ESCALATIONS());
  assert.equal(waitingOnYou({ model, journeys: js }).length, 7, 'silence is not a closing');
  const gap = diagnose({ model, journeys: js }).gaps.find((g) => g.id === 'closure-before-journal');
  assert.match(gap.detail, /does not infer a closing/);
  assert.ok(diagnose({ model: { ...model, runs: [] }, journeys: [] }).gaps.some((g) => g.id === 'closure-before-journal'));
});

test('every escalation of the scenario is explained by design, with the files or rules named', () => {
  const { model, js } = build(ESCALATIONS());
  const rows = waitingOnYou({ model, journeys: js });
  assert.ok(rows.every((r) => r.by_design), JSON.stringify(rows.filter((r) => !r.by_design)));
  const byItem = (n) => rows.find((r) => (r.item.number) === n);
  assert.match(byItem(219).reason, /only protected files shown \(package\.json\)/);
  assert.match(byItem(221).reason, /a target file is protected/);
  assert.match(byItem(211).reason, /files withheld by the budget \(docs\/big\.md\)/);
  assert.match(byItem(134).reason, /every file the issue needs is protected or too large \(scripts\/a\.mjs\)/);
  assert.match(byItem(209).reason, /not shown to the model.*src\/huge\.mjs/);
  assert.deepEqual(rows.map((r) => r.since), [...rows.map((r) => r.since)].sort((a, b) => a - b), 'oldest first');
});

test('a closing prevails over the escalation, a later run reactivates the item', () => {
  const esc = autofix({ pr: 40, at: T0, reason: 'no_changes', shown: ['package.json'] });
  const end = closed({ start: T0 + H, eventName: 'pull_request', prNumber: 40, meta: { merged: false } });
  assert.equal(stateOf(build([esc, end]).js, 'pr', 40), 'closed');
  assert.equal(build([esc, end]).js[0].closing.merged, false);
  // reopened and fixed: an attempt that starts after the closing means the item is live again.
  const again = autofix({ pr: 40, at: T0 + 2 * H, reason: 'no_changes', shown: ['package.json'] });
  assert.equal(stateOf(build([esc, end, again]).js, 'pr', 40), 'escalated');
  // merged beats closed, and a merge is journaled as such.
  const merged = closed({ start: T0 + H, eventName: 'pull_request', prNumber: 40, meta: { merged: true } });
  assert.equal(stateOf(build([esc, end, merged]).js, 'pr', 40), 'merged');
  assert.equal(STATES.merged.attention, false);
  assert.equal(STATES.closed.attention, false);
});

test('a PR closed unmerged ends an issue only when it is the issue\'s latest PR', () => {
  const issue = (pr, at) => autofix({ pr, issue: 7, at, reason: 'no_changes', shown: ['package.json'] });
  const closePr = (pr, at) => closed({ start: at, eventName: 'pull_request', prNumber: pr, item: { kind: 'issue', number: 7, source: 'branch' }, meta: { merged: false } });
  // PR 10 is replaced by PR 11 (open, escalated): closing PR 10 changes nothing.
  assert.equal(stateOf(build([issue(10, T0), issue(11, T0 + H), closePr(10, T0 + 2 * H)]).js, 'issue', 7), 'escalated');
  // closing the latest one ends the wait.
  assert.equal(stateOf(build([issue(10, T0), issue(11, T0 + H), closePr(11, T0 + 2 * H)]).js, 'issue', 7), 'closed');
});

test('closings(): the closed object comes from the event meta, then the workflow event; merged is never assumed', () => {
  const issue = { event_name: 'issues', pr_number: null, run_id: '1', started_at: 5, events: [{ event: 'item.closed', ts: 9, meta: { state_reason: 'not_planned' } }] };
  assert.deepEqual(closings(issue), [{ ts: 9, run_id: '1', object: 'issue', pr: null, merged: null, state_reason: 'not planned' }]);
  const pr = { event_name: 'pull_request', pr_number: 4, run_id: '2', started_at: 5, events: [{ event: 'item.closed', meta: { merged: false } }] };
  assert.deepEqual(closings(pr), [{ ts: 5, run_id: '2', object: 'pr', pr: 4, merged: false, state_reason: null }]);
  assert.equal(closings({ event_name: 'pull_request', pr_number: 4, run_id: '3', events: [{ event: 'item.closed' }] })[0].merged, null);
  assert.equal(closings({ event_name: null, pr_number: null, run_id: '4', events: [{ event: 'item.closed', meta: {} }] })[0].object, 'issue');
  assert.deepEqual(closings({ events: [{ event: 'review.verdict' }] }), []);
});

test('isLifecycleRun: only a run with item events and no stage; the indicators leave it out', () => {
  assert.equal(isLifecycleRun({ stages: [], events: [{ event: 'item.start' }, { event: 'item.closed' }] }), true);
  assert.equal(isLifecycleRun({ stages: [], events: [] }), false);
  assert.equal(isLifecycleRun({ stages: [{ stage: 'review' }], events: [{ event: 'item.closed' }] }), false);
  assert.equal(isLifecycleRun({ stages: [], events: [{ event: 'item.closed' }, { event: 'llm_call' }] }), false);
  const { model, js } = build([...ESCALATIONS(), ...CLOSINGS()]);
  const executions = model.runs.filter((r) => !isLifecycleRun(r)).length;
  assert.equal(computeOverview({ model, journeys: js }).window.runs, executions);
  assert.equal(computeWindow({ model, journeys: js, days: 30 }).current.runs, executions);
  assert.ok(model.runs.length > executions);
});

test('a failed closing run does not fail the item', () => {
  const esc = autofix({ pr: 50, at: T0, reason: 'no_changes', shown: ['package.json'] });
  const bad = closed({ start: T0 + H, eventName: 'pull_request', prNumber: 50, meta: { merged: true } });
  const { js } = build([esc, { ...bad, outcome: 'failed' }]);
  assert.equal(js[0].state, 'merged');
});

// ---------------------------------------------------------------------------
// What the design does not explain: the only escalations that still raise a finding
// ---------------------------------------------------------------------------

test('unexplained escalations raise one warning: modifiable file shown, content rejection, stage error, unknown reason', () => {
  const records = [
    autofix({ pr: 61, at: T0, reason: 'no_changes', shown: ['src/app.mjs', 'package.json'] }),
    autofix({ pr: 62, at: T0 + H, reason: 'guardrail_rejected', rules: ['module_format'] }),
    makeRecord({ runId: String(run++), stage: 'autofix', start: T0 + 3 * H, prNumber: 64, events: [{ event: 'autofix.escalated', level: 'warn', meta: { prNumber: 64, reason: 'mystery' } }] }),
    makeRecord({ runId: String(run++), stage: 'autofix', start: T0 + 4 * H, prNumber: 65, events: [{ event: 'autofix.prompt_budget', meta: { prNumber: 65, shown_files: [], hidden_files: [] } }, { event: 'autofix.escalated', level: 'warn', meta: { prNumber: 65, reason: 'no_changes' } }] }),
    autofix({ pr: 66, at: T0 + 5 * H, reason: 'no_changes', hidden: ['a.mjs'] }), // by design: not counted
  ];
  const { model, js } = build(records);
  const rows = waitingOnYou({ model, journeys: js });
  assert.deepEqual(rows.map((r) => [r.item.number, r.kind, r.by_design]), [[61, 'no_changes_modifiable', false], [62, 'guard_content', false], [64, 'unknown', false], [65, 'unknown', false], [66, 'no_changes_by_design', true]]);
  assert.match(rows[0].reason, /No change proposed although 1 modifiable file\(s\) were shown: src\/app\.mjs/);
  const f = diagnose({ model, journeys: js }).findings.find((x) => x.id === 'escalations');
  assert.equal(f.severity, 'warning');
  assert.equal(f.status, 'active');
  assert.match(f.fact, /4 of 5 open work item\(s\)/);
  assert.deepEqual(f.items.sort(), [61, 62, 64, 65]);
  assert.equal(f.evidence.length, 4);
  // The same escalations, closed: nothing waits, nothing is raised.
  const ends = [61, 62, 64, 65].map((n, i) => closed({ start: T0 + 24 * H + i * H, eventName: 'pull_request', prNumber: n, meta: { merged: false } }));
  const after = build([...records, ...ends]);
  assert.deepEqual(waitingOnYou({ model: after.model, journeys: after.js }).map((r) => r.item.number), [66]);
  assert.ok(!diagnose({ model: after.model, journeys: after.js }).findings.some((x) => x.id === 'escalations'));
});

test('explainEscalation: protected files come from the denylist given, the attempt limit and notes-only are designed', () => {
  const esc = { event: 'autofix.escalated', stage: 'autofix', ts: 1 };
  const run = (shown) => ({ events: [{ event: 'autofix.prompt_budget', stage: 'autofix', meta: { shown_files: shown, hidden_files: [] } }, { event: 'autofix.escalated', stage: 'autofix', ts: 1, level: 'warn', meta: { reason: 'no_changes' } }] });
  assert.equal(explainEscalation(esc, run(['scripts/a.mjs'])).by_design, false, 'the hard floor alone does not protect scripts/');
  assert.equal(explainEscalation(esc, run(['scripts/a.mjs']), ['scripts/']).by_design, true, 'the repository list does');
  assert.equal(explainEscalation(esc, run(['Scripts\\A.mjs']), ['scripts/']).by_design, true, 'case and separators are normalized');
  // An error of the stage before the escalation is an LLM or parsing failure, not a guardrail.
  const errored = { events: [{ event: 'autofix.error', stage: 'autofix', level: 'error', meta: {} }, { event: 'autofix.escalated', stage: 'autofix', ts: 1, level: 'warn', meta: { reason: 'no_changes' } }] };
  assert.deepEqual([explainEscalation(esc, errored).kind, explainEscalation(esc, errored).by_design], ['error', false]);
  assert.equal(explainEscalation({ event: 'autofix.max_attempts_reached', stage: 'autofix', ts: 1 }, { events: [] }).kind, 'attempt_limit');
  assert.equal(explainEscalation({ event: 'review.labels_applied', stage: 'review', ts: 1 }, null).kind, 'unknown');
  const gen = (meta) => explainEscalation({ event: 'code_gen.escalated', stage: 'code_gen', ts: 1 }, { events: [{ event: 'code_gen.escalated', stage: 'code_gen', ts: 1, meta }] });
  assert.equal(gen({ reason: 'blocked', source: 'notes_only' }).kind, 'blocked_notes_only');
  assert.equal(gen({ reason: 'blocked', source: 'model' }).kind, 'blocked_model');
  assert.equal(gen({ reason: 'blocked', source: 'weird' }).kind, 'unknown');
  assert.equal(gen({ reason: 'guardrail_rejected', rules: ['protected_path'] }).kind, 'guard_target');
  assert.equal(gen({ reason: 'guardrail_rejected', rules: [] }).kind, 'guard_content');
  assert.equal(gen({}).kind, 'unknown');
  assert.equal(explainEscalation({ event: 'autofix.escalated', stage: 'autofix', ts: 1 }, { events: [{ event: 'autofix.escalated', stage: 'autofix', ts: 1, meta: { reason: 'odd' } }] }).kind, 'unknown');
  const many = Array.from({ length: 8 }, (_, i) => `f${i}.mjs`);
  assert.match(explainEscalation(esc, run(many)).reason, /f0\.mjs, f1\.mjs, f2\.mjs, f3\.mjs, f4\.mjs, \+3 more/);
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

test('Overview: the queue replaces the escalation card, escapes record strings and names no severity', () => {
  const { model } = build([...ESCALATIONS(), ...CLOSINGS()]);
  const html = consoleOverview(consoleContext(model), 'pipeline/');
  assert.match(html, /<section class="panel waiting-panel" id="waiting"><h3><span>Waiting on you <small class="muted">1 open item\(s\) escalated to a human/);
  assert.match(html, /Issue #200/);
  assert.match(html, /files withheld from its context: src\/big\.mjs/);
  assert.match(html, /href="https:\/\/github\.com\/koydas\/autonomous-dev-loop\/issues\/200#issuecomment-\d+">Escalation comment/);
  assert.match(html, /waiting since <span data-ts="\d+">2026-10-10 08:00 UTC<\/span>/);
  assert.doesNotMatch(html, /Work items escalated to a human|Escalations the design does not explain/);
  const queue = html.slice(html.indexOf('id="waiting"'), html.indexOf('Issues requiring attention'));
  assert.doesNotMatch(queue, /tone-(bad|warn)|critical|warning/, 'the queue carries no severity');
  // Empty, and hostile strings.
  assert.match(waitingPanel([], ''), /Nothing waits on you.*not inferred/);
  const hostile = waitingPanel([{ trace_id: 'a'.repeat(32), item: { kind: 'issue', number: 1 }, prs: [HOSTILE], step: HOSTILE, reason: HOSTILE, url: null, since: null }], '');
  for (const raw of RAW_MARKERS) assert.ok(!hostile.includes(raw), raw);
  assert.match(hostile, /No comment link recorded.*date not recorded/);
});

test('the closed item leaves the Pipelines facets as its own state, once', () => {
  const { model } = build([...ESCALATIONS(), ...CLOSINGS()]);
  const ctx = consoleContext(model);
  assert.equal(ctx.waiting.length, 1);
  assert.equal(workItemJourney(model.traces[0]).closing === null || typeof workItemJourney(model.traces[0]).closing === 'object', true);
});
