import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import {
  consoleContext, diagnosticsBody, findingCard, journeyPanel, keyEvents, runSteps, trendChart, statusBanner,
  definitionsPanel, duration, itemTitle, itemUrl, pill, FILTER_SCRIPT, PR_STATES_SCRIPT, TABS_SCRIPT, CONSOLE_STYLE,
} from '../lib/console_views.mjs';
import { consoleOverview, kpiRow, delta, sparkline, statusBadge, durationChart, providerList, issueCards } from '../lib/console_overview.mjs';
import { attemptOf, workItemJourney } from '../lib/pipeline_journey.mjs';
import { DEFINITIONS } from '../lib/pipeline_kpis.mjs';
import { buildPipelineModel, eventSummary } from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf, HOSTILE, RAW_MARKERS } from './fixtures/pipeline/records.mjs';

const T = Date.parse('2026-10-16T10:00:00Z');
const modelOf = (records) => buildPipelineModel({ records: asFiles(records), traces: indexesOf(records) });
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const noRaw = (html) => { for (const raw of RAW_MARKERS) assert.ok(!html.includes(raw), `raw ${raw}`); };

// from REQUEST_CHANGES: an anomaly cause, so the finding stays a warning (an approval withheld on a cut is info).
const withheld = (runId, t, pr = 50, from = 'APPROVE') => makeRecord({ runId, start: t, prNumber: pr, events: [
  { event: 'review.prompt_truncated', level: 'warn', meta: { diff_truncated: true, unreviewed_code_files: 5, prNumber: pr } },
  { event: 'review.verdict', meta: { verdict: 'WITHHELD', withheld_from: from, unreviewed_code_files: 5, prNumber: pr } },
] });

test('formatting helpers', () => {
  assert.deepEqual([500, 45000, 600000, 7200000, 3 * 86400000].map(duration), ['0.5 s', '45.0 s', '10 min', '2.0 h', '3.0 d']);
  for (const bad of [null, -1, NaN, 'x']) assert.equal(duration(bad), '—');
  assert.equal(itemTitle({ kind: 'issue', number: 3 }), 'Issue #3');
  assert.equal(itemTitle({ kind: 'pr', number: 3 }), 'PR #3');
  assert.equal(itemTitle({ kind: 'run', number: 3 }), 'Run #3');
  assert.equal(itemTitle(null), 'Unlinked work');
  assert.equal(itemUrl({ kind: 'pr', number: 3 }), 'https://github.com/koydas/autonomous-dev-loop/pull/3');
  assert.equal(itemUrl({ kind: 'issue', number: 3 }), 'https://github.com/koydas/autonomous-dev-loop/issues/3');
  assert.equal(itemUrl({ kind: 'run', number: 3 }), null);
  assert.match(pill('warn', '<b>'), /class="pill tone-warn"><span class="tone-mark tone-warn" aria-hidden="true">!<\/span>&lt;b&gt;/);
});

test('a hostile string in any recorded field is escaped on the overview, diagnostics and journey', () => {
  const records = [makeRecord({ runId: '840', start: T, hostile: true, events: [
    { event: 'review.verdict', meta: { verdict: 'WITHHELD', prNumber: 7, reason: HOSTILE, url: HOSTILE } },
    { event: 'autofix.escalated', meta: { reason: HOSTILE, url: HOSTILE } },
    { event: 'llm_fallback', meta: { from: HOSTILE, to: HOSTILE, error_type: HOSTILE } },
    { event: 'llm_fallback', meta: { from: HOSTILE, to: HOSTILE, error_type: HOSTILE } },
  ] }), withheld('841', T + 1000), withheld('842', T + 2000, 51)];
  const m = modelOf(records);
  const ctx = consoleContext(m);
  const pages = [consoleOverview(ctx, ''), diagnosticsBody(ctx, ''), ...ctx.journeys.map((j) => journeyPanel(j)), keyEvents(m.runs.at(-1), eventSummary)];
  for (const html of pages) {
    noRaw(html);
    assert.doesNotMatch(html, /href="(&lt;|<|javascript:)/);
  }
  assert.ok(pages[1].includes('&lt;script&gt;alert(1)'), 'the hostile text is shown escaped, not dropped');
});

test('diagnostics: finding card separates observed facts from a labelled hypothesis; filters and gaps', () => {
  const ctx = consoleContext(modelOf([withheld('850', T, 50, 'REQUEST_CHANGES'), withheld('851', T + 1000, 51, 'REQUEST_CHANGES'), withheld('852', T + 2000, 52, 'REQUEST_CHANGES')]));
  const html = diagnosticsBody(ctx, '');
  assert.match(html, /<h1>Diagnostics<\/h1>/);
  assert.match(html, /no LLM involved/);
  assert.match(html, /<article class="finding tone-warn" id="review-withheld" data-filter-item data-severity="warning" data-category="review">/);
  assert.match(html, /<dt>Observed<\/dt><dd>3 of 3 verdicts are WITHHELD/);
  assert.match(html, /<div class="wide hypothesis"><dt>Hypothesis<\/dt>/);
  assert.match(CONSOLE_STYLE, /\.hypothesis dt::after \{ content:' — interpretation, not verified'/);
  assert.match(html, /<summary>Evidence · 3 entries<\/summary>/);
  assert.match(html, /<a href="runs\/850-1\.html">850-1<\/a>/);
  assert.match(html, /<a class="button-link" href="health\.html#reviews">Investigate →<\/a>/);
  assert.match(html, /<select data-filter-key="severity">/);
  assert.match(html, /<option value="review">Review<\/option>/);
  assert.match(html, /id="data-gaps".*insufficient data.*Merge is not journaled/s);
  assert.match(html, /<code>withheldShare<\/code>/);
  assert.doesNotMatch(html, /Open diagnostics/, 'no self link');
  // Findings without hypothesis, evidence or link.
  const bare = findingCard({ id: 'x', severity: 'info', category: 'A b', title: 't', fact: 'f', impact: 'i', frequency: 'n', hypothesis: null, items: [], runs: [], evidence: [], link: null }, '');
  assert.doesNotMatch(bare, /hypothesis|Evidence|Investigate/);
  assert.match(bare, /data-category="a-b"/);
  const one = findingCard({ id: 'y', severity: 'critical', category: 'c', title: 't', fact: 'f', impact: 'i', frequency: 'n', hypothesis: null, items: [], runs: ['1-1', '2-1'], evidence: [{ run_id: '1-1', ts: null, event: null, summary: '', pr: null, url: null }], link: null }, '');
  assert.match(one, /Evidence · 1 entry/);
  assert.match(one, /First 1 entries; 2 run\(s\) affected/);
  // Nothing fired: said explicitly.
  assert.match(diagnosticsBody(consoleContext(buildPipelineModel({})), ''), /No rule fired on the recorded data\. That is not proof of health/);
});

test('journey panel: final status and decision per step, attempts in order, interventions', () => {
  const records = [withheld('860', T, 70), makeRecord({ runId: '861', start: T + 1000, prNumber: 70, events: [{ event: 'review.verdict', meta: { verdict: 'APPROVE', prNumber: 70 } }] })];
  const m = modelOf(records);
  const html = journeyPanel(workItemJourney(m.traces[0]), '../');
  assert.match(html, /Journey <span class="pill tone-good">/);
  assert.match(html, /success · Approved/);
  assert.match(html, /2 attempts · 0 failed · 1 adverse · recovered/);
  assert.ok(html.indexOf('runs/860-1.html') < html.indexOf('runs/861-1.html'), 'attempts in chronological order');
  assert.match(html, /Attempt 1: attention/);
  assert.match(html, /No linked issue: not part of this flow/);
  assert.match(html, /<a href="https:\/\/github\.com\/koydas\/autonomous-dev-loop\/pull\/70">#70<\/a>/);
  const esc = journeyPanel(workItemJourney(modelOf([makeRecord({ runId: '862', start: T, stage: 'autofix', events: [{ event: 'autofix.escalated', meta: { reason: 'no_changes', url: 'https://github.com/c' } }] })]).traces[0]));
  assert.match(esc, /<h3>Interventions<\/h3>.*autofix\.escalated<\/strong> · no changes.*<a href="https:\/\/github\.com\/c">GitHub<\/a>/s);
  const noPr = journeyPanel({ ...workItemJourney(m.traces[0]), prs: [] });
  assert.doesNotMatch(noPr, /pull\/70/);
});

test('key events: decisions, warnings and side effects first, with tones; retry waits summarised', () => {
  const m = modelOf([makeRecord({ runId: '870', start: T, events: [
    { event: 'retry.wait', level: 'warn', meta: { status: 429, wait_ms: 2000 } },
    { event: 'review.prompt_truncated', level: 'warn', meta: { diff_truncated: true, unreviewed_code_files: 4 } },
    { event: 'review.verdict', meta: { verdict: 'WITHHELD', withheld_from: 'APPROVE' } },
    { event: 'review.labels_applied', meta: { added: ['x'] } },
    { event: 'review.comment_posted', meta: { action: 'updated', url: 'https://github.com/c' } },
    { event: 'review.error', level: 'error', meta: { error_type: 'TRANSIENT' } },
    { event: 'review.skipped', meta: { reason: 'superseded' } },
  ] })]);
  const html = keyEvents(m.runs[0], eventSummary);
  assert.doesNotMatch(html, /labels_applied/, 'routine events stay in the journal');
  assert.doesNotMatch(html, /<code>retry\.wait/);
  assert.match(html, /1 retry wait\(s\), 2\.0 s in total/);
  assert.match(html, /tone-warn" aria-hidden="true">!<\/span><div><a href="#ev-1"><code>review\.prompt_truncated<\/code><\/a> unreviewed_code_files=4 · diff_truncated=true/);
  assert.match(html, /tone-warn" aria-hidden="true">!<\/span><div><a href="#ev-2"><code>review\.verdict<\/code><\/a> verdict=WITHHELD · withheld_from=APPROVE/);
  assert.match(html, /tone-good" aria-hidden="true">✓<\/span><div><a href="#ev-4"><code>review\.comment_posted<\/code><\/a> action=updated · <a href="https:\/\/github\.com\/c">GitHub<\/a>/);
  assert.match(html, /tone-bad" aria-hidden="true">✕<\/span><div><a href="#ev-5">/);
  assert.match(html, /tone-neutral" aria-hidden="true">–<\/span><div><a href="#ev-6">/);
  const approve = keyEvents({ events: [{ event: 'review.verdict', level: 'info', ts: T, meta: { verdict: 'APPROVE' } }] }, eventSummary);
  assert.match(approve, /tone-good/);
  assert.match(keyEvents({ events: [] }, eventSummary), /No decision, warning or error recorded/);
});

test('run steps: execution status and decision side by side', () => {
  const m = modelOf([withheld('880', T)]);
  assert.match(runSteps(m.runs[0], attemptOf), /<strong>Review<\/strong> · execution success · decision Withheld \(approval withheld: 5 code file\(s\) not reviewed\)/);
  assert.match(runSteps({ ...m.runs[0], events: [], stages: [{ stage: 'custom', outcome: 'success' }] }, attemptOf), /custom<\/strong> · execution success · no decision recorded/);
  assert.equal(runSteps({ stages: [] }, attemptOf), '');
});

test('trend chart: stacked days with a values table; empty trend said', () => {
  const days = Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, failed: i === 13 ? 1 : 0, adverse: 2, progressed: 1, neutral: 0, total: i === 13 ? 4 : 3 }));
  const html = trendChart({ days });
  assert.match(html, /role="img" aria-label="Runs per day by class over 14 days; values in the table"/);
  assert.match(html, /<title>2026-10-14: 4 run\(s\) · failed 1, adverse decision 2, moved forward 1, skip \/ no decision 0<\/title>/);
  assert.equal((html.match(/<tr><td>2026-10-/g) ?? []).length, 14);
  assert.equal(trendChart({ days: [] }), '<p class="muted">No dated run recorded.</p>');
  assert.match(definitionsPanel(), /Known limits/);
});

test('client scripts parse and write text only', () => {
  for (const src of [...scripts(PR_STATES_SCRIPT), ...scripts(FILTER_SCRIPT), ...scripts(TABS_SCRIPT)]) new Script(src);
  for (const s of [PR_STATES_SCRIPT, FILTER_SCRIPT, TABS_SCRIPT]) assert.doesNotMatch(s, /innerHTML|document\.write|<script src/);
  assert.match(PR_STATES_SCRIPT, /page <= 10/);
  assert.match(PR_STATES_SCRIPT, /sessionStorage/);
});

// A minimal DOM for the filter bar: items with dataset/textContent, controls with values, a URL.
function filterDom(params, items) {
  const controls = Object.entries({ q: '', state: '', period: '', ...params.controls }).map(([key, value]) => ({ dataset: { filterKey: key }, tagName: key === 'q' ? 'INPUT' : 'SELECT', value, options: [{ value: '' }, { value: 'attention' }, { value: 'merged' }, { value: '7' }] }));
  const count = { textContent: '' }, empty = { hidden: false };
  const box = {
    dataset: { ref: String(params.ref ?? 0) },
    querySelectorAll: (sel) => (sel === '[data-filter-key]' ? controls : sel === '[data-chip]' ? [] : items),
    querySelector: (sel) => (sel === '[data-filter-count]' ? count : empty),
    addEventListener: () => {},
  };
  const replaced = [];
  runInNewContext(scripts(FILTER_SCRIPT)[0], {
    document: { querySelectorAll: (sel) => (sel === '[data-filter-scope]' ? [box] : sel === '[data-facet]' ? (params.facets ?? []) : []), addEventListener: () => {} }, URLSearchParams,
    location: { search: params.search ?? '', pathname: '/p/flows.html', hash: '' },
    history: { replaceState: (a, b, url) => replaced.push(url) },
  });
  return { count, empty, replaced, controls };
}

test('filter bar: token, text and period filters, URL kept in sync and restored', () => {
  const day = 86400000;
  const items = [
    { dataset: { state: 'withheld attention', last: String(10 * day) }, textContent: 'PR #241', hidden: false },
    { dataset: { state: 'approved', last: String(2 * day) }, textContent: 'issue #237', hidden: false },
  ];
  const { count, replaced, controls } = filterDom({ search: '?state=attention&period=bogus', ref: 10 * day }, items);
  assert.equal(controls.find((c) => c.dataset.filterKey === 'state').value, 'attention', 'restored from the URL');
  assert.equal(controls.find((c) => c.dataset.filterKey === 'period').value, '', 'an unknown option is ignored');
  assert.deepEqual(items.map((i) => i.hidden), [false, true]);
  assert.equal(count.textContent, '1 of 2 shown');
  assert.equal(replaced.at(-1), '/p/flows.html?state=attention');
  // Period: 7 days before the reference (the latest recorded activity), and free text.
  filterDom({ controls: { period: '7' }, ref: 10 * day }, items);
  assert.deepEqual(items.map((i) => i.hidden), [false, true]);
  // Sidebar facets: all checked filters nothing; an unchecked value hides the items carrying only it.
  filterDom({ facets: [{ dataset: { facet: 'state' }, value: 'withheld', checked: false }, { dataset: { facet: 'state' }, value: 'approved', checked: true }] }, items);
  assert.deepEqual(items.map((i) => i.hidden), [true, false]);
  filterDom({ facets: [{ dataset: { facet: 'state' }, value: 'withheld', checked: true }, { dataset: { facet: 'state' }, value: 'approved', checked: true }] }, items);
  assert.deepEqual(items.map((i) => i.hidden), [false, false]);
  const { empty } = filterDom({ controls: { q: 'nothing' } }, items);
  assert.deepEqual(items.map((i) => i.hidden), [true, true]);
  assert.equal(empty.hidden, false, 'the empty message shows');
});

test('merge join in the browser: recorded PRs, issue hints, claimed PRs', () => {
  const helpers = scripts(PR_STATES_SCRIPT)[0];
  const run = (code, ctx) => runInNewContext(`${helpers} ${code}`, ctx);
  const pulls = [{ number: 5, state: 'closed', merged_at: '2026-10-02T00:00:00Z', hint: '7' }, { number: 6, state: 'closed', merged_at: '2026-10-03T00:00:00Z', hint: '7' }];
  assert.equal(run('adlMergeOf([], "7", pulls).pr.number', { pulls }), 6, 'newest merge wins');
  assert.equal(run('adlMergeOf([], "7", pulls, new Set([5, 6])).state', { pulls }), 'unknown', 'claimed PRs are not borrowed');
  assert.equal(run('adlMergeOf([9], "7", pulls).state', { pulls }), 'unknown', 'recorded PRs replace the hint');
  assert.equal(run("adlIssueHint({ head: { ref: 'ai/issue-12', repo: { full_name: 'koydas/autonomous-dev-loop' } } })", {}), '12');
});

test('tabs: one tab per section, the hash picks the open one, no JavaScript shows every section', () => {
  const src = scripts(TABS_SCRIPT)[0];
  new Script(src);
  assert.match(src, /:scope > section\[data-tab\]/);
  assert.match(src, /setAttribute\('role', 'tablist'\)/);
  assert.match(src, /'#' \+ p\.id === location\.hash/);
  assert.match(src, /ArrowRight/);
  assert.match(CONSOLE_STYLE, /\.tab\[aria-selected="true"\]/);
  // Without the script nothing is hidden: panels only get role/hidden from it.
  assert.doesNotMatch(TABS_SCRIPT, /innerHTML/);
});
