// Pipelines view (ADR-0042, ADR-0043): one card per recorded work item, every canonical step with every
// attempt, its final status and what earlier attempts hid. Recorded evidence is rendered at build time;
// GitHub supplies merge facts (merged_at) in the browser.
import { escapeHtml as e } from './eval_site.mjs';
import { callCost, sumCosts, costAmount, meanAmount, costLine, costBasis, formatUsd } from './llm_cost.mjs';
import { workItemJourney, STATES, STEPS } from './pipeline_journey.mjs';
import { pill, toneMark, FILTER_SCRIPT, PR_STATES_SCRIPT, duration as shortDuration } from './console_views.mjs';

const duration = v => v == null ? 'Not recorded' : `${(v / 1000).toFixed(1)} s`;
// Collapsed-card icons: the final execution's span outcome; anything else is not recorded, never success.
const STATUS = new Map([['success', '✓'], ['failed', '✗'], ['skipped', '⊘']]);
const statusIcon = (name, status, step = null) => {
  const earlier = step ? step.attempts.slice(0, -1).filter(a => a.tone === 'bad' || a.tone === 'warn').length : 0;
  const decision = step?.final?.decision;
  const label = `${name}: ${status.replace('-', ' ')}${decision ? ` · ${decision.label}` : ''}${earlier ? ` · after ${earlier} failed or adverse attempt(s)` : ''}`;
  const tone = decision && decision.tone !== 'good' && status !== 'failed' ? ` decision-${decision.tone}` : '';
  const retry = step && step.attempts.length > 1 ? `<sup class="flow-retry" aria-hidden="true">×${step.attempts.length}</sup>` : '';
  return `<span class="flow-step-icon"><span class="flow-status-icon ${status}${tone}" data-stage-status="${status}" role="img" aria-label="${e(label)}" title="${e(label)}">${STATUS.get(status) ?? '○'}</span>${retry}</span>`;
};

const tokens = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const BASIS_NOTE = {
  measured: 'provider-measured tokens, thinking and prompt cache included',
  estimated: 'chars/4 token estimate, excludes thinking and cache adjustments',
  'measured + estimated': 'provider-measured tokens where recorded, chars/4 estimate for older records',
};
const costNote = sum => `${BASIS_NOTE[costBasis(sum)] ? `${BASIS_NOTE[costBasis(sum)]}; ` : ''}list price, never a bill.`;
// A call belongs to the step its adl.stage names; a call without one (older record) to the run's only stage.
const stepCalls = (runs, stage) => runs.flatMap(r => r.llm.filter(c => (c.pipeline_stage ?? (r.stages.length === 1 ? r.stages[0].stage : null)) === stage));
const callText = c => {
  const cost = c.cost ?? callCost(c);
  const cache = c.cache_read ? ` (${c.cache_read} from cache)` : '';
  return `${c.provider ?? '?'}:${c.model ?? '?'} · ${c.tokens_in ?? '?'} input${cache} / ${c.tokens_out ?? '?'} output tokens (${c.estimated === false ? 'measured' : 'estimated'}) · ${cost.basis === 'free' ? 'free tier' : cost.usd == null ? 'unpriced' : formatUsd(cost.usd)}${c.fallback ? ' · fallback' : ''}${c.failed ? ' · failed call' : ''}`;
};
const time = t => t == null || !Number.isFinite(t) ? 'Start not recorded' : new Date(t).toISOString();

function attemptHtml(r, a, i, root = '') {
  const decision = a.decision ? `${a.decision.label}${a.decision.reason ? ` (${a.decision.reason})` : ''}` : 'no decision recorded';
  return `<li><details><summary><span class="flow-attempt">${toneMark(a.tone)}#${i + 1} · ${e(decision)}</span> — run ${e(r.outcome ?? 'Unknown')} · ${duration(r.duration_ms)}${r.llm.length ? ` · ${e(costAmount(r.cost ?? sumCosts(r.llm)))}` : ''}</summary><p>Execution: ${e(a.status.replace('-', ' '))} · ${e(r.workflow)} · ${e(r.event_name ?? 'trigger not recorded')} · ${e(r.actor ?? 'Unknown actor')} · ${e(r.head_sha ?? 'SHA not recorded')}</p><p>${e(r.llm.map(callText).join(', ') || 'Model not recorded')}</p><p>${e(time(r.started_at))} · ${r.events.length} actions</p><a class="button-link" href="${root}runs/${encodeURIComponent(r.run_id)}.html">Agent trace, events & spans →</a></details></li>`;
}

const sumDurations = (attempts) => {
  const v = attempts.map(a => a.duration_ms).filter(d => typeof d === 'number');
  return v.length ? v.reduce((t, d) => t + d, 0) : null;
};
const STATUS_WORD = { success: 'Success', failed: 'Failed', skipped: 'Skipped', 'not-recorded': 'Not recorded' };

// One stage box of the detail panel: total duration, final status and decision, attempts (collapsed), cost.
function stepNode(step, runs, root) {
  const byId = new Map(runs.map(r => [r.run_id, r]));
  const matching = step.attempts.map(a => byId.get(a.run_id));
  const cost = sumCosts(stepCalls(matching, step.key));
  const tone = step.final?.tone ?? 'unknown';
  const final = step.final ? `<p class="flow-step-final">Final: ${pill(tone, `${step.final.status.replace('-', ' ')}${step.final.decision ? ` · ${step.final.decision.label}` : ''}`)}${step.attempts.length > 1 ? ` <span class="muted">${step.failures} failed · ${step.adverse} adverse before or at it${step.recovered ? ' · recovered automatically' : ''}</span>` : ''}</p>` : '';
  const head = `<span class="box-head">${toneMark(tone)}<strong>${e(step.name)}</strong></span>${matching.length ? `<span class="box-time">${e(shortDuration(sumDurations(step.attempts)))}</span><span class="box-status tone-${tone}">${e(step.final.decision?.label ?? STATUS_WORD[step.status])}</span>` : ''}`;
  return `<li class="flow-node tone-${tone}${matching.length ? '' : ' missing'}" data-step="${step.key}">${head}<p>${matching.length ? `${matching.length} execution(s)` : e(step.note ?? 'Not recorded')}</p>${cost.calls ? `<p class="flow-step-cost" data-step-cost>LLM: ${costLine(cost)} · ${cost.calls} call(s) · ${tokens(cost.tokens_in)} in / ${tokens(cost.tokens_out)} out${matching.length > 1 && cost.measured + cost.estimated ? ` · ${meanAmount(cost, matching.length)} per execution` : ''}</p>` : ''}${final}${matching.length ? `<details class="attempt-list"${matching.length > 1 ? '' : ' open'}><summary>Attempts (${matching.length})</summary><ol class="flow-attempts">${matching.map((r, i) => attemptHtml(r, step.attempts[i], i, root)).join('')}</ol></details>` : ''}</li>`;
}

const keyRow = (label, value) => `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`;

/** Key information of a work item (detail panel, trace page). */
export function keyInformation(trace, j, total) {
  const issue = j.issue ? `<a href="https://github.com/koydas/autonomous-dev-loop/issues/${j.issue}">#${j.issue}</a>` : '<span class="muted">No linked issue</span>';
  const prs = j.prs.length ? j.prs.map(n => `<a href="https://github.com/koydas/autonomous-dev-loop/pull/${n}">#${n}</a>`).join(', ') : '<span class="muted">Not recorded</span>';
  const first = trace.first_started_at ?? Math.min(...trace.runs.map(r => r.started_at ?? Infinity));
  return `<dl class="key-info">${keyRow('Issue', issue)}${keyRow('Pull request', prs)}${keyRow('Workflows', e(j.workflows.join(', ') || 'Not recorded'))}${keyRow('Started', Number.isFinite(first) ? `<span data-ts="${first}">${e(new Date(first).toISOString().slice(0, 16).replace('T', ' '))} UTC</span>` : 'Not recorded')}${keyRow('Lead time', `${e(shortDuration(j.lead_time_ms))} <span class="muted">(running ${e(shortDuration(j.running_ms))})</span>`)}${keyRow('Executions', `${e(j.runs)}${j.missing_runs ? ` <span class="muted">(${e(j.missing_runs)} without record)</span>` : ''}`)}${keyRow('Total cost (est.)', e(costAmount(total)))}${keyRow('Last recorded state', `<span data-state-pill>${pill(j.tone, j.label)}</span>`)}${keyRow('Merge', '<span data-merge>Merge status: not checked</span>')}</dl>`;
}

/**
 * One work item as a table row that expands into its detail: stage boxes with every attempt, key
 * information and links. `root` is the path to pipeline/ ('' on pipeline pages, 'pipeline/' on the home page).
 */
export function pipelineRow(trace, root = '') {
  const runs = trace.runs.map(r => r.run).filter(Boolean);
  const j = workItemJourney(trace);
  const total = sumCosts(runs.flatMap(r => r.llm));
  const tokensOf = [j.state, j.attention ? 'attention' : ''].filter(Boolean).join(' ');
  // An optional step (conflicts-fix) is drawn only when it ran: most items never conflict, and an icon "not recorded" on every card says nothing.
  const steps = j.steps.filter((s) => s.attempts.length || !STEPS.find((d) => d.key === s.key)?.optional);
  const title = `${trace.item?.kind === 'issue' ? 'Issue' : trace.item?.kind === 'pr' ? 'PR' : 'Work item'} #${trace.item?.number ?? 'unknown'}`;
  const stages = steps.filter(s => s.attempts.length).map(s => s.key);
  const href = trace.trace_id ? `${root}traces/${trace.trace_id}.html` : null;
  return `<article class="flow-card tone-${j.tone}" data-flow data-filter-item data-prs="${j.prs.join(',')}" data-issue="${j.issue ?? ''}" data-state="${e(tokensOf)}" data-kind="${e(trace.item?.kind ?? '')}" data-problem="${e(j.problem_steps.length ? `any ${j.problem_steps.join(' ')}` : '')}" data-provider="${e(j.providers.join(' ') || 'none')}" data-stage="${e(stages.join(' ') || 'none')}" data-last="${j.last_activity ?? ''}"><details class="flow-details"><summary class="flow-summary"><span class="col-title"><h2 data-flow-title>${e(title)}</h2><span class="live-title muted" data-live-title></span></span><span class="col-status"><span data-state-pill>${pill(j.tone, j.label)}</span></span><span class="flow-status col-stages">${steps.map(s => statusIcon(s.name, s.status, s.attempts.length ? s : null)).join('')}<span data-merge-status>${statusIcon('Merge', 'not-recorded')}</span></span><span class="col-num" data-col="Duration">${e(shortDuration(j.lead_time_ms))}</span><span class="col-num" data-col="Attempts">${e(j.runs)}</span><span class="col-num" data-col="Cost">${total.calls ? `<span class="flow-cost-chip" title="LLM cost of this flow (list price)">${e(costAmount(total))}</span>` : '<span class="muted">—</span>'}</span><span class="col-num muted" data-col="Updated">${j.last_activity ? `<span data-ts="${j.last_activity}">${e(new Date(j.last_activity).toISOString().slice(0, 10))}</span>` : '—'}</span><span class="chevron" aria-hidden="true">›</span></summary>
<div class="pl-detail"><div class="pl-detail-head"><p data-related></p>${j.problem_steps.length ? `<p class="muted">Steps with problems: ${e(j.problem_steps.map(k => STEPS.find(s => s.key === k).name).join(', '))}</p>` : ''}${j.escalations.length ? `<p class="flow-escalation">${toneMark('warn')} Escalated to a human: ${j.escalations.map(x => `${e(x.event)}${x.reason ? ` (${e(x.reason)})` : ''}${x.url ? ` · <a href="${e(x.url)}">comment</a>` : ''}`).join('; ')}</p>` : ''}</div>
<div class="pl-detail-grid"><div><ol class="flow-pipeline">${steps.map(s => stepNode(s, runs, root)).join('')}<li class="flow-node missing" data-merge-node><span class="box-head">${toneMark('unknown')}<strong>Merge</strong></span><p data-merge-step>Not checked</p></li></ol>
<div class="widget-meta"><span>Recorded running: ${duration(trace.running_ms)}</span><span>Waiting: ${duration(trace.waiting_ms)}</span><span>${trace.runs.length} executions</span><span>${trace.runs.filter(r => !r.run).length} execution record(s) unavailable · ${e(trace.runs_overflow)} outside index</span></div>
<p class="cost-note">LLM cost estimate: ${costLine(total)} · ${total.calls ? `${total.calls} call(s), ${tokens(total.tokens_in)} input / ${tokens(total.tokens_out)} output tokens · ` : ''}${costNote(total)}</p></div>
<aside>${keyInformation(trace, j, total)}${href ? `<a class="button-link" href="${href}">Full chronological flow →</a>` : ''}</aside></div></div></details></article>`;
}

// Column headers of the rows (the rows themselves are details/summary, so this is a visual table).
const ROW_HEAD = '<div class="pl-head" aria-hidden="true"><span>Work item</span><span>Status</span><span>Stages</span><span>Duration</span><span>Attempts</span><span>Cost (est.)</span><span>Updated</span><span></span></div>';

const option = (v, l) => `<option value="${e(v)}">${e(l)}</option>`;
const STATE_ORDER = ['failed', 'escalated', 'withheld', 'rejected', 'changes_requested', 'approved', 'in_progress', 'merged', 'closed', 'no_data'];

/** Sidebar facets (status, stage, provider) with counts; every box checked shows everything. */
export function pipelineFacets(journeys) {
  const count = (pred) => journeys.filter(pred).length;
  const box = (facet, value, label, n) => `<label><input type="checkbox" data-facet="${facet}" value="${e(value)}" checked>${e(label)}<span class="n">${e(n)}</span></label>`;
  const states = STATE_ORDER.filter(s => count(j => j.state === s)).map(s => box('state', s, STATES[s].label, count(j => j.state === s)));
  const stages = STEPS.map(st => box('stage', st.key, st.name, count(j => j.steps.some(x => x.key === st.key && x.attempts.length))));
  const providers = [...new Set(journeys.flatMap(j => j.providers))].sort().map(p => box('provider', p, p, count(j => j.providers.includes(p))));
  const none = count(j => !j.providers.length);
  return `<p class="side-title">Filter pipelines</p><fieldset class="facet"><legend>Status</legend>${states.join('')}</fieldset><fieldset class="facet"><legend>Stage reached</legend>${stages.join('')}</fieldset><fieldset class="facet"><legend>LLM provider</legend>${providers.join('')}${none ? box('provider', 'none', 'No LLM call', none) : ''}</fieldset><p class="facet-note">Filters apply to the pipeline lists, not to the indicators.</p>`;
}

/** The rows of some traces inside a filter scope; `limit` keeps the newest only. */
export function pipelineList(traces, { root = '', limit = null, appendMerged = false, toolbar = '' } = {}) {
  const shown = limit ? traces.slice(0, limit) : traces;
  const ref = Math.max(0, ...traces.flatMap(t => t.runs.map(r => r.completed_at ?? r.started_at ?? 0)));
  return `<section data-flow-dashboard data-filter-scope data-ref="${ref}"${appendMerged ? ' data-append-merged' : ''}>${toolbar}<p data-flow-status class="muted flow-status-line" role="status">JavaScript and GitHub API access are needed to check merges. Recorded flows are available below.</p><p data-filter-empty class="muted" hidden>No work item matches these filters.</p><div class="pl-table">${ROW_HEAD}<div data-flow-list class="flow-list">${shown.map(t => pipelineRow(t, root)).join('') || '<p class="muted">No recorded flows yet.</p>'}</div></div>${appendMerged ? `<template data-missing-flow>${pipelineRow({ runs: [], item: null, running_ms: null, waiting_ms: null, runs_overflow: 0, trace_id: '' }, root)}</template>` : ''}</section>`;
}

export function flowDashboard(model) {
  const traces = model.traces ?? [];
  const js = traces.map(workItemJourney);
  const providers = [...new Set(js.flatMap(j => j.providers))].sort();
  // merged / closed have their own options below: the journaled state and the live GitHub state share the token.
  const states = Object.entries(STATES).filter(([k]) => k !== 'no_data' && k !== 'merged' && k !== 'closed');
  const chips = `<div class="chip-row" role="group" aria-label="Status">${[['', 'All', js.length], ['attention', 'Needs a person', js.filter(j => j.attention).length], ...STATE_ORDER.filter(s => js.some(j => j.state === s)).map(s => [s, STATES[s].label, js.filter(j => j.state === s).length])].map(([v, l, n]) => `<button type="button" class="chip" data-chip="state" data-chip-value="${e(v)}">${e(l)} <span class="n">${e(n)}</span></button>`).join('')}</div>`;
  const filters = `<div class="filterbar"><label class="grow">Search <input type="search" data-filter-key="q" data-flow-search placeholder="Issue, PR, model, decision…"></label><label>State<select data-filter-key="state"><option value="">All</option>${option('attention', 'Needs a person')}${states.map(([k, s]) => option(k, s.label)).join('')}${option('merged', 'Merged (live)')}${option('open', 'PR open (live)')}${option('closed', 'Closed unmerged (live)')}</select></label><label>Step with problems<select data-filter-key="problem"><option value="">Any or none</option>${option('any', 'Any step')}${STEPS.map(s => option(s.key, s.name)).join('')}</select></label><label>Kind<select data-filter-key="kind"><option value="">All</option>${option('issue', 'Issue')}${option('pr', 'PR')}</select></label><label>Provider<select data-filter-key="provider"><option value="">All</option>${providers.map(p => option(p, p)).join('')}</select></label><label>Period<select data-filter-key="period"><option value="">All retained</option>${option('7', 'Last 7 days')}${option('30', 'Last 30 days')}</select></label><span data-filter-count role="status"></span><button type="button" data-load-flows>Refresh merge status</button></div>`;
  return `<div class="page-head"><div><h1>Pipelines</h1><p class="sub">Every recorded work item (issue, or PR without an issue). Each stage icon is the <strong>final</strong> attempt's execution status — ✓ success, ✗ failed, ⊘ skipped, ○ not recorded (never a failure) — with an amber ring when the stage completed but decided not to move the item forward, and ×N for its attempts. Open a row for every attempt. Merge comes only from GitHub's <code>merged_at</code>; a running stage is not observable.</p></div><a class="button-link" href="traces/index.html">Trace table & open issues</a></div>${pipelineList(traces, { root: '', appendMerged: true, toolbar: chips + filters })}`;
}

export const FLOW_STYLE = `
.page-head { display:flex; justify-content:space-between; align-items:start; gap:16px; flex-wrap:wrap; }
.page-head .sub { margin:4px 0 0; font-size:13px; }
.flow-status-line { font-size:12px; margin:6px 0; }
.pl-table { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); overflow:hidden; }
.pl-head, .flow-summary { display:grid; grid-template-columns:minmax(140px,1.5fr) minmax(178px,1.2fr) minmax(250px,1.7fr) 70px 68px 86px 84px 18px; gap:10px; align-items:center; padding:10px 16px; }
.pl-head { font-size:11.5px; font-weight:650; color:var(--muted); border-bottom:1px solid var(--border); background:var(--surface-2); }
.flow-list { display:grid; }
.flow-card { overflow-wrap:anywhere; border-bottom:1px solid var(--grid); box-shadow:inset 3px 0 0 var(--tone, transparent); }
.flow-card:last-child { border-bottom:0; }
.flow-card:hover { background:var(--surface-2); }
.flow-summary { list-style:none; min-height:52px; cursor:pointer; }
.flow-summary::-webkit-details-marker { display:none; }
.flow-summary h2 { display:inline; margin:0; font-size:14px; font-weight:700; letter-spacing:0; }
.col-title { display:grid; min-width:0; }
.live-title { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.col-num { font-variant-numeric:tabular-nums; font-size:13px; }
.chevron { color:var(--muted); font-size:18px; transition:transform .15s; }
.flow-details[open] .chevron { transform:rotate(90deg); }
.flow-details[open] > .flow-summary { background:var(--surface-2); }
.flow-status { display:flex; flex-wrap:wrap; gap:9px; align-items:center; }
.col-status .pill { white-space:normal; line-height:1.25; }
.flow-step-icon { position:relative; display:inline-flex; }
.flow-retry { position:absolute; right:-7px; top:-7px; font-size:9.5px; font-weight:700; color:var(--ink-2); background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:0 2px; line-height:1.3; }
.flow-status-icon { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border:1.5px solid var(--border); border-radius:50%; font-weight:800; font-size:12px; }
.flow-status-icon.success { color:var(--good); border-color:var(--good); } .flow-status-icon.failed { color:var(--critical); border-color:var(--critical); background:var(--bad-bg); }
.flow-status-icon.decision-warn { border:2px solid var(--warning); color:var(--warn-ink); background:var(--warn-bg); }
.flow-status-icon.skipped { color:var(--ink-2); } .flow-status-icon.not-recorded { color:var(--muted); border-style:dashed; }
.flow-cost-chip { font-size:12.5px; font-weight:650; color:var(--ink); font-variant-numeric:tabular-nums; }
.pl-detail { padding:6px 16px 18px; border-top:1px solid var(--grid); background:var(--surface-2); }
.pl-detail-head p { margin:8px 0; font-size:13px; }
.pl-detail-grid { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:18px; }
.flow-pipeline { list-style:none; padding:0; margin:8px 0; display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; }
.flow-node { position:relative; border:1px solid var(--border); border-top:3px solid var(--tone, var(--axis)); border-radius:10px; padding:10px; min-width:0; background:var(--surface); font-size:12px; }
.flow-node.missing { border-top-color:var(--axis); color:var(--muted); background:transparent; border-style:dashed; }
.flow-node p { margin:4px 0; font-size:12px; color:var(--ink-2); }
.box-head { display:flex; align-items:center; gap:6px; font-size:12.5px; }
.box-head .tone-mark { width:18px; height:18px; font-size:11px; }
.box-time { display:block; margin-top:6px; font-size:13px; font-weight:700; font-variant-numeric:tabular-nums; }
.box-status { display:block; font-size:12px; font-weight:650; color:var(--tone); }
.flow-step-cost { font-variant-numeric:tabular-nums; }
.flow-step-final { font-size:12px; } .flow-step-final .pill { white-space:normal; }
.attempt-list summary { font-size:12px; color:var(--link); min-height:28px; padding-top:4px; }
.flow-attempts { list-style:none; padding:0; margin:6px 0 0; display:grid; gap:4px; }
.flow-attempts summary { min-height:28px; font-size:11.5px; color:var(--ink-2); }
.flow-attempts p { font-size:11.5px; }
.flow-attempt { display:inline-flex; gap:5px; align-items:center; font-weight:650; color:var(--ink); }
.flow-attempt .tone-mark { width:16px; height:16px; font-size:10px; }
.flow-escalation { display:flex; gap:8px; align-items:center; }
.cost-note { font-size:12px; color:var(--muted); }
.key-info { margin:8px 0 12px; padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--surface); display:grid; gap:8px; font-size:12.5px; }
.key-info > div { display:flex; justify-content:space-between; gap:12px; }
.key-info dt { color:var(--muted); } .key-info dd { margin:0; text-align:right; }
@media(max-width:1300px) { .flow-pipeline { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media(max-width:1000px) {
  .pl-head { display:none; }
  .flow-summary { display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; padding:12px 14px; }
  .col-title { flex:1 1 140px; } .col-status { flex:0 1 auto; }
  .col-stages { flex:1 1 100%; }
  .flow-summary .col-num { flex:0 0 auto; font-size:12px; } .flow-summary .col-num::before { content:attr(data-col) ' '; color:var(--muted); font-size:11px; }
  .chevron { display:none; }
  .pl-detail-grid { grid-template-columns:1fr; }
}
@media(max-width:600px) { .flow-pipeline { grid-template-columns:1fr 1fr; } .flow-summary h2 { font-size:14px; } [data-flow-search] { width:100%; } }
`;

// Merge facts: every recorded row stays; GitHub's PR state is laid over it (merged_at → merged, closed
// without it → closed unmerged, open), with the PR title; on the Pipelines page (data-append-merged) a
// merged PR without a recorded flow gets an empty row. Status chips drive the State select.
export const FLOW_SCRIPT = `${PR_STATES_SCRIPT}<script>
(() => {
 for (const box of document.querySelectorAll('[data-flow-dashboard]')) {
  const list = box.querySelector('[data-flow-list]'), status = box.querySelector('[data-flow-status]'), button = box.querySelector('[data-load-flows]');
  const original = [...list.querySelectorAll('[data-flow]')].map(c => c.cloneNode(true));
  const refilter = () => box.dispatchEvent(new Event('adl:refilter'));
  const setIcon = (c, state, label, glyph) => {
   const icon = c.querySelector('[data-merge-status] [data-stage-status]');
   icon.dataset.stageStatus = state; icon.className = 'flow-status-icon ' + state; icon.textContent = glyph;
   icon.setAttribute('aria-label', label); icon.title = label;
  };
  const load = async () => {
   if (button) button.disabled = true; status.textContent = 'Loading PR states from GitHub…';
   try {
    const { pulls, more } = await adlPullStates();
    const cards = original.map(c => c.cloneNode(true));
    const claimed = new Set(cards.flatMap(c => c.dataset.prs.split(',').filter(Boolean).map(Number)));
    let merged = 0;
    for (const c of cards) {
     const prs = c.dataset.prs.split(',').filter(Boolean).map(Number);
     const m = adlMergeOf(prs, c.dataset.issue, pulls, claimed);
     // A merged or closed PR settles the item: it no longer waits on a person, whatever was last recorded.
     const base = c.dataset.state.split(' ').filter(Boolean);
     const next = base.filter(s => s !== 'attention');
     if (m.state !== 'unknown') next.push(m.state);
     if (base.includes('attention') && m.state !== 'merged' && m.state !== 'closed') next.push('attention');
     c.dataset.state = next.join(' ');
     const related = c.querySelector('[data-related]');
     if (c.dataset.issue) { const issue = document.createElement('a'); issue.href = 'https://github.com/koydas/autonomous-dev-loop/issues/' + c.dataset.issue; issue.textContent = 'Issue #' + c.dataset.issue; related.append(issue); }
     if (!m.pr) { c.querySelector('[data-merge]').textContent = 'No matching PR among the ' + pulls.length + ' most recently updated'; continue; }
     const a = document.createElement('a'); a.href = 'https://github.com/koydas/autonomous-dev-loop/pull/' + m.pr.number; a.textContent = 'PR #' + m.pr.number + ' · ' + m.pr.title; related.append(related.childNodes.length ? ' · ' : '', a);
     const live = c.querySelector('[data-live-title]'); if (live) live.textContent = m.pr.title;
     const pills = [...c.querySelectorAll('[data-state-pill]')];
     if (m.state === 'merged') {
      merged++;
      c.querySelector('[data-merge]').textContent = 'Merged ' + m.pr.merged_at + ' · ' + (m.pr.merge_commit_sha || 'SHA not available');
      c.querySelector('[data-merge-node]').classList.remove('missing'); c.querySelector('[data-merge-step]').textContent = 'Merged · ' + m.pr.merged_at;
      setIcon(c, 'success', 'Merge: success', '✓');
      // The row shows Merged; the key information keeps the last recorded state next to it.
      const row = pills[0]; row.title = 'Last recorded: ' + row.textContent.trim(); row.replaceChildren(Object.assign(document.createElement('span'), { className: 'pill tone-good', textContent: '✓ Merged' }));
      if (pills[1]) { const note = document.createElement('span'); note.className = 'pill tone-good'; note.textContent = '✓ Merged'; pills[1].prepend(note, ' last recorded: '); }
     } else if (m.state === 'closed') {
      c.querySelector('[data-merge]').textContent = 'PR #' + m.pr.number + ' closed without merge';
      c.querySelector('[data-merge-step]').textContent = 'Closed without merge'; setIcon(c, 'skipped', 'Merge: closed without merge', '⊘');
     } else {
      c.querySelector('[data-merge]').textContent = 'PR #' + m.pr.number + ' is open: not merged yet';
      c.querySelector('[data-merge-step]').textContent = 'PR open'; setIcon(c, 'not-recorded', 'Merge: PR open', '○');
     }
    }
    if (box.hasAttribute('data-append-merged')) for (const pr of pulls.filter(p => p.merged_at).sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))) {
     if (claimed.has(pr.number) || (pr.hint && cards.some(c => c.dataset.issue === pr.hint && !c.dataset.prs))) continue;
     const c = box.querySelector('template').content.firstElementChild.cloneNode(true);
     c.dataset.prs = String(pr.number); c.dataset.kind = 'pr'; c.dataset.state = 'merged'; c.dataset.last = String(Date.parse(pr.merged_at) || '');
     if (pr.hint) c.dataset.issue = pr.hint;
     const title = c.querySelector('[data-flow-title]'); title.replaceChildren();
     const a = document.createElement('a'); a.href = 'https://github.com/koydas/autonomous-dev-loop/pull/' + pr.number; a.textContent = 'PR #' + pr.number; title.append(a);
     c.querySelector('[data-live-title]').textContent = pr.title;
     c.querySelector('[data-merge]').textContent = 'Merged ' + pr.merged_at + ' · ' + (pr.merge_commit_sha || 'SHA not available') + ' · no recorded pipeline run';
     c.querySelector('[data-merge-node]').classList.remove('missing'); c.querySelector('[data-merge-step]').textContent = 'Merged · ' + pr.merged_at;
     setIcon(c, 'success', 'Merge: success', '✓'); merged++;
     for (const pill of c.querySelectorAll('[data-state-pill]')) { pill.textContent = '✓ Merged · no recorded pipeline run'; pill.className = 'pill tone-good'; }
     c.querySelector('a.button-link')?.remove();
     cards.push(c);
    }
    list.replaceChildren(...cards); refilter();
    status.textContent = pulls.length + ' PRs checked · ' + merged + ' merged · ' + new Date().toLocaleString() + (more ? ' · Limited to the 1,000 most recently updated PRs.' : '');
   } catch (err) { status.textContent = 'Merge status unavailable (' + err.message + '). Showing recorded flows; merge is not inferred from job success.'; list.replaceChildren(...original.map(c => c.cloneNode(true))); refilter(); }
   finally { if (button) button.disabled = false; }
  };
  button?.addEventListener('click', () => { try { sessionStorage.removeItem('adl-pulls-v1'); } catch {} load(); }); load();
 }
})();
</script>${FILTER_SCRIPT}`;
