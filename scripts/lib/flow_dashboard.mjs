// Recorded evidence is rendered at build time; GitHub supplies merge facts in the browser.
import { escapeHtml as e } from './eval_site.mjs';
import { callCost, sumCosts, costLine, costBasis, formatUsd } from './llm_cost.mjs';

const stages = [['Validation', 'issue_validation'], ['Code generation', 'code_gen'], ['PR preparation', 'pr_prepare'], ['Review', 'review'], ['Auto-fix', 'autofix']];
const duration = v => v == null ? 'Not recorded' : `${(v / 1000).toFixed(1)} s`;
// Collapsed-card icons: the latest execution's span outcome; anything else is not recorded, never success.
const STATUS = new Map([['success', '✓'], ['failed', '✗'], ['skipped', '⊘']]);
const statusIcon = (name, status) => {
  const label = `${name}: ${status.replace('-', ' ')}`;
  return `<span class="flow-status-icon ${status}" data-stage-status="${status}" role="img" aria-label="${label}" title="${label}">${STATUS.get(status) ?? '○'}</span>`;
};
function stageStatus(matching, stage) {
  // Latest by started_at; undated runs rank last, ties keep trace order.
  const latest = matching.reduce((a, r) => (a && (r.started_at ?? -Infinity) <= (a.started_at ?? -Infinity) ? a : r), null);
  const outcome = latest?.stages.find(s => s.stage === stage)?.outcome;
  return STATUS.has(outcome) ? outcome : 'not-recorded';
}

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

function card(trace) {
  const runs = trace.runs.map(r => r.run).filter(Boolean);
  const calls = runs.flatMap(r => r.llm);
  const total = sumCosts(calls);
  const numbers = [...new Set(runs.flatMap(r => [r.pr_number, ...r.events.map(ev => ev.meta?.prNumber)]).filter(n => Number.isSafeInteger(n) && n > 0))];
  if (trace.item?.kind === 'pr' && !numbers.includes(trace.item.number)) numbers.push(trace.item.number);
  const steps = stages.map(([name, stage]) => {
    const matching = runs.filter(r => r.stages.some(s => s.stage === stage) || r.events.some(ev => ev.stage === stage));
    return { name, matching, status: stageStatus(matching, stage), cost: sumCosts(stepCalls(matching, stage)) };
  });
  return `<article class="widget flow-card" data-flow data-prs="${numbers.join(',')}" data-issue="${trace.item?.kind === 'issue' ? trace.item.number : ''}"><details class="flow-details"><summary class="flow-summary"><h2 data-flow-title>${e(trace.item?.kind ?? 'Work item')} #${e(trace.item?.number ?? 'unknown')}</h2><span class="flow-status">${steps.map(s => statusIcon(s.name, s.status)).join('')}<span data-merge-status>${statusIcon('Merge', 'not-recorded')}</span>${total.calls ? `<span class="flow-cost-chip" title="LLM cost of this flow (list price)">${total.free === total.calls ? 'free tier' : formatUsd(total.usd)}</span>` : ''}</span></summary><p data-merge>Merge status: not checked</p><p data-related></p><div class="widget-meta"><span>Recorded running: ${duration(trace.running_ms)}</span><span>Waiting: ${duration(trace.waiting_ms)}</span><span>${trace.runs.length} executions</span></div><p>LLM cost estimate: ${costLine(total)} · ${total.calls ? `${total.calls} call(s), ${tokens(total.tokens_in)} input / ${tokens(total.tokens_out)} output tokens · ` : ''}${costNote(total)}</p><ol class="flow-pipeline">${steps.map(({ name, matching, cost }) => {
    return `<li class="flow-node${matching.length ? '' : ' missing'}"><strong>${name}</strong><p>${matching.length ? `${matching.length} execution(s)` : 'Not recorded'}</p>${cost.calls ? `<p class="flow-step-cost" data-step-cost>LLM: ${costLine(cost)} · ${cost.calls} call(s) · ${tokens(cost.tokens_in)} in / ${tokens(cost.tokens_out)} out${matching.length > 1 ? ` · ${formatUsd(cost.usd / matching.length)} per execution` : ''}</p>` : ''}${matching.map(r => `<details><summary>${e(r.outcome ?? 'Unknown')} · ${duration(r.duration_ms)}${r.llm.length ? ` · ${formatUsd((r.cost ?? sumCosts(r.llm)).usd)}` : ''}</summary><p>${e(r.workflow)} · ${e(r.actor ?? 'Unknown actor')} · ${e(r.head_sha ?? 'SHA not recorded')}</p><p>${e(r.llm.map(callText).join(', ') || 'Model not recorded')}</p><p>${r.started_at == null ? 'Start not recorded' : e(new Date(r.started_at).toISOString())} · ${r.events.length} actions</p><a class="button-link" href="runs/${encodeURIComponent(r.run_id)}.html">Agent trace, events & spans →</a></details>`).join('')}</li>`;
  }).join('')}<li class="flow-node missing" data-merge-node><strong>Merge</strong><p data-merge-step>Not checked</p></li></ol><p>${trace.runs.filter(r => !r.run).length} execution record(s) unavailable · ${e(trace.runs_overflow)} outside index</p>${trace.trace_id ? `<a class="button-link" href="traces/${trace.trace_id}.html">Full chronological flow →</a>` : ''}</details></article>`;
}

export function flowDashboard(model) {
  return `<h1>Flow map</h1><p>One box per merged PR. Every pipeline step stays visible; grey means no recorded evidence, not a failure or a skipped step. Metrics cover the retained work-item trace (which can include several PRs), not the entire PR lifetime. Review and auto-fix may repeat: expand an execution to debug it. Cards start collapsed; each icon is the latest execution's outcome for that step: ✓ success, ✗ failed, ⊘ skipped, ○ not recorded.</p><section data-flow-dashboard><button type="button" data-load-flows>Refresh merged PRs</button><p data-flow-status role="status">JavaScript and GitHub API access are needed to check merges. Recorded flows are available below.</p><label>Search flows <input type="search" data-flow-search placeholder="PR, issue, model, outcome…"></label><div data-flow-list class="flow-list">${model.traces.map(card).join('') || '<p>No recorded flows yet.</p>'}</div><template data-missing-flow>${card({ runs: [], item: null, running_ms: null, waiting_ms: null, runs_overflow: 0, trace_id: '' })}</template></section>`;
}

export const FLOW_STYLE = `
@media(min-width:1000px) { .flow-list { grid-template-columns:repeat(2,minmax(0,1fr)); } }
.flow-list { display:grid; gap:20px; margin-top:20px; }
.flow-card { overflow-wrap:anywhere; }
.flow-pipeline { list-style:none; padding:0; display:grid; grid-template-columns:1fr; gap:24px; }
.flow-node { position:relative; border:1px solid var(--border); border-left:4px solid var(--s1); border-radius:10px; padding:14px; min-width:0; }
.flow-node:not(:last-child)::after { content:'↓'; position:absolute; bottom:-23px; left:50%; color:var(--muted); }
.flow-node.missing { border-left-color:var(--muted); background:var(--page); color:var(--muted); }
.flow-node summary, .flow-summary { min-height:44px; cursor:pointer; }
.flow-summary h2 { display:inline; }
.flow-status { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.flow-status-icon { display:inline-flex; align-items:center; justify-content:center; min-width:28px; height:28px; border:1px solid var(--border); border-radius:50%; font-weight:700; }
.flow-status-icon.success { color:var(--good); } .flow-status-icon.failed { color:var(--critical); border-color:var(--critical); }
.flow-cost-chip { display:inline-flex; align-items:center; min-height:28px; padding:0 10px; border:1px solid var(--border); border-radius:14px; font-size:12px; font-weight:650; color:var(--ink-2); font-variant-numeric:tabular-nums; }
.flow-step-cost { font-variant-numeric:tabular-nums; }
.flow-status-icon.skipped { color:var(--ink-2); } .flow-status-icon.not-recorded { color:var(--muted); border-style:dashed; }
@media(max-width:600px) { .flow-pipeline { grid-template-columns:1fr; } .flow-card h2 { font-size:22px; } [data-flow-search] { width:100%; } }
`;

export const FLOW_SCRIPT = `<script>
(() => {
 const box = document.querySelector('[data-flow-dashboard]'); if (!box) return;
 const list = box.querySelector('[data-flow-list]'), status = box.querySelector('[data-flow-status]'), button = box.querySelector('[data-load-flows]');
 const original = [...list.querySelectorAll('[data-flow]')].map(c => c.cloneNode(true));
 const search = box.querySelector('[data-flow-search]');
 const filter = () => { for (const c of list.querySelectorAll('[data-flow]')) c.hidden = !c.textContent.toLowerCase().includes(search.value.toLowerCase().trim()); };
 search.addEventListener('input', filter);
 const load = async () => {
  button.disabled = true; status.textContent = 'Loading merged PRs from GitHub…';
  try {
   const merged = []; let more = false;
   for (let page = 1; page <= 10; page++) {
    const response = await fetch('https://api.github.com/repos/koydas/autonomous-dev-loop/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=' + page, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error('GitHub HTTP ' + response.status);
    const prs = await response.json(); if (!Array.isArray(prs)) throw new Error('Invalid GitHub response');
    merged.push(...prs.filter(p => p.merged_at && Number.isSafeInteger(p.number) && p.number > 0));
    more = prs.length === 100; if (!more) break;
   }
   merged.sort((a,b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
   const fragment = document.createDocumentFragment();
   for (const pr of merged) {
    // Match recorded PR identity first; only repository-owned heads supply branch hints.
    const branch = pr.head?.repo?.full_name === 'koydas/autonomous-dev-loop' && /^ai\\/issue-(\\d{1,9})$/.exec(pr.head?.ref || '');
    const closing = /(?:^|[^\\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \\t]*:?[ \\t]+#(\\d{1,9})\\b/i.exec(String(pr.body || '').slice(0, 65536));
    // Normalize like branchIssue(): ai/issue-007 joins issue 7; issue 0 is no hint.
    const asIssue = m => m && Number(m[1]) > 0 ? String(Number(m[1])) : '';
    const issueHint = asIssue(branch) || asIssue(closing);
    const source = original.find(c => c.dataset.prs.split(',').includes(String(pr.number))) || (issueHint && original.find(c => c.dataset.issue === issueHint));
    const c = source ? source.cloneNode(true) : box.querySelector('template').content.firstElementChild.cloneNode(true);
    if (!c.dataset.issue && issueHint) c.dataset.issue = issueHint;
    const title = c.querySelector('[data-flow-title]'); title.replaceChildren();
    const a = document.createElement('a'); a.href = 'https://github.com/koydas/autonomous-dev-loop/pull/' + pr.number; a.textContent = 'PR #' + pr.number + ' · ' + pr.title; title.append(a);
    c.querySelector('[data-merge]').textContent = 'Merged ' + pr.merged_at + ' · ' + (pr.merge_commit_sha || 'SHA not available');
    const related = c.querySelector('[data-related]');
    if (c.dataset.issue) { const issue = document.createElement('a'); issue.href = 'https://github.com/koydas/autonomous-dev-loop/issues/' + c.dataset.issue; issue.textContent = 'Issue #' + c.dataset.issue; related.append(issue); }
    else related.textContent = 'Linked issue: not recorded';
    c.querySelector('[data-merge-node]').classList.remove('missing'); c.querySelector('[data-merge-step]').textContent = 'Merged · ' + pr.merged_at;
    const mergeIcon = c.querySelector('[data-merge-status] [data-stage-status]');
    mergeIcon.dataset.stageStatus = 'success'; mergeIcon.className = 'flow-status-icon success'; mergeIcon.textContent = '✓';
    mergeIcon.setAttribute('aria-label', 'Merge: success'); mergeIcon.title = 'Merge: success';
    if (!source) c.querySelector('a.button-link')?.remove();
    fragment.append(c);
   }
   list.replaceChildren(fragment); filter();
   status.textContent = merged.length + ' merged PRs · checked ' + new Date().toLocaleString() + (more ? ' · Limited to the 1,000 most recently updated closed PRs.' : '') + (merged.length ? '' : ' · No merged PRs found.');
  } catch (err) { status.textContent = 'Merge status unavailable (' + err.message + '). Showing recorded flows; merge is not inferred from job success.'; list.replaceChildren(...original.map(c => c.cloneNode(true))); filter(); }
  finally { button.disabled = false; }
 };
 button.addEventListener('click', load); load();
})();
</script>`;
