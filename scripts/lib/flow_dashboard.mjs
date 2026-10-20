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

function attemptHtml(r, a, i) {
  const decision = a.decision ? `${a.decision.label}${a.decision.reason ? ` (${a.decision.reason})` : ''}` : 'no decision recorded';
  return `<li><details><summary><span class="flow-attempt">${toneMark(a.tone)}#${i + 1} · ${e(decision)}</span> — run ${e(r.outcome ?? 'Unknown')} · ${duration(r.duration_ms)}${r.llm.length ? ` · ${e(costAmount(r.cost ?? sumCosts(r.llm)))}` : ''}</summary><p>Execution: ${e(a.status.replace('-', ' '))} · ${e(r.workflow)} · ${e(r.event_name ?? 'trigger not recorded')} · ${e(r.actor ?? 'Unknown actor')} · ${e(r.head_sha ?? 'SHA not recorded')}</p><p>${e(r.llm.map(callText).join(', ') || 'Model not recorded')}</p><p>${e(time(r.started_at))} · ${r.events.length} actions</p><a class="button-link" href="runs/${encodeURIComponent(r.run_id)}.html">Agent trace, events & spans →</a></details></li>`;
}

function stepNode(step, runs) {
  const byId = new Map(runs.map(r => [r.run_id, r]));
  const matching = step.attempts.map(a => byId.get(a.run_id));
  const cost = sumCosts(stepCalls(matching, step.key));
  const tone = step.final?.tone ?? 'unknown';
  const final = step.final ? `<p class="flow-step-final">Final: ${pill(tone, `${step.final.status.replace('-', ' ')}${step.final.decision ? ` · ${step.final.decision.label}` : ''}`)}${step.attempts.length > 1 ? ` <span class="muted">${step.failures} failed · ${step.adverse} adverse before or at it${step.recovered ? ' · recovered automatically' : ''}</span>` : ''}</p>` : '';
  return `<li class="flow-node tone-${tone}${matching.length ? '' : ' missing'}" data-step="${step.key}"><strong>${e(step.name)}</strong><p>${matching.length ? `${matching.length} execution(s)` : e(step.note ?? 'Not recorded')}</p>${cost.calls ? `<p class="flow-step-cost" data-step-cost>LLM: ${costLine(cost)} · ${cost.calls} call(s) · ${tokens(cost.tokens_in)} in / ${tokens(cost.tokens_out)} out${matching.length > 1 && cost.measured + cost.estimated ? ` · ${meanAmount(cost, matching.length)} per execution` : ''}</p>` : ''}${final}${matching.length ? `<ol class="flow-attempts">${matching.map((r, i) => attemptHtml(r, step.attempts[i], i)).join('')}</ol>` : ''}</li>`;
}

function card(trace) {
  const runs = trace.runs.map(r => r.run).filter(Boolean);
  const j = workItemJourney(trace);
  const total = sumCosts(runs.flatMap(r => r.llm));
  const tokensOf = [j.state, j.attention ? 'attention' : ''].filter(Boolean).join(' ');
  const steps = j.steps;
  const title = `${trace.item?.kind ?? 'Work item'} #${trace.item?.number ?? 'unknown'}`;
  return `<article class="widget flow-card tone-${j.tone}" data-flow data-filter-item data-prs="${j.prs.join(',')}" data-issue="${j.issue ?? ''}" data-state="${e(tokensOf)}" data-kind="${e(trace.item?.kind ?? '')}" data-problem="${e(j.problem_steps.length ? `any ${j.problem_steps.join(' ')}` : '')}" data-provider="${e(j.providers.join(' '))}" data-last="${j.last_activity ?? ''}"><details class="flow-details"><summary class="flow-summary"><h2 data-flow-title>${e(title)}</h2><span class="flow-status">${steps.map(s => statusIcon(s.name, s.status, s.attempts.length ? s : null)).join('')}<span data-merge-status>${statusIcon('Merge', 'not-recorded')}</span>${total.calls ? `<span class="flow-cost-chip" title="LLM cost of this flow (list price)">${e(costAmount(total))}</span>` : ''}</span><span class="flow-state"><span data-state-pill>${pill(j.tone, j.label)}</span><span class="muted">${e(j.runs)} run(s) · lead ${e(shortDuration(j.lead_time_ms))}${j.last_activity ? ` · last ${e(new Date(j.last_activity).toISOString().slice(0, 10))}` : ''}${j.problem_steps.length ? ` · problems: ${e(j.problem_steps.map(k => STEPS.find(s => s.key === k).name).join(', '))}` : ''}</span></span></summary><p data-merge>Merge status: not checked</p><p data-related></p>${j.escalations.length ? `<p class="flow-escalation">${toneMark('warn')} Escalated to a human: ${j.escalations.map(x => `${e(x.event)}${x.reason ? ` (${e(x.reason)})` : ''}${x.url ? ` · <a href="${e(x.url)}">comment</a>` : ''}`).join('; ')}</p>` : ''}<div class="widget-meta"><span>Recorded running: ${duration(trace.running_ms)}</span><span>Waiting: ${duration(trace.waiting_ms)}</span><span>${trace.runs.length} executions</span></div><p>LLM cost estimate: ${costLine(total)} · ${total.calls ? `${total.calls} call(s), ${tokens(total.tokens_in)} input / ${tokens(total.tokens_out)} output tokens · ` : ''}${costNote(total)}</p><ol class="flow-pipeline">${steps.map(s => stepNode(s, runs)).join('')}<li class="flow-node missing" data-merge-node><strong>Merge</strong><p data-merge-step>Not checked</p></li></ol><p>${trace.runs.filter(r => !r.run).length} execution record(s) unavailable · ${e(trace.runs_overflow)} outside index</p>${trace.trace_id ? `<a class="button-link" href="traces/${trace.trace_id}.html">Full chronological flow →</a>` : ''}</details></article>`;
}

const option = (v, l) => `<option value="${e(v)}">${e(l)}</option>`;

export function flowDashboard(model) {
  const traces = model.traces ?? [];
  const ref = Math.max(0, ...traces.flatMap(t => t.runs.map(r => r.completed_at ?? r.started_at ?? 0)));
  const providers = [...new Set(traces.flatMap(t => t.runs.flatMap(r => r.run?.llm.map(c => c.provider) ?? [])).filter(Boolean))].sort();
  const states = Object.entries(STATES).filter(([k]) => k !== 'no_data');
  const filters = `<div class="filterbar"><label class="grow">Search <input type="search" data-filter-key="q" data-flow-search placeholder="PR, issue, model, decision…"></label><label>State<select data-filter-key="state"><option value="">All</option>${option('attention', 'Needs a person')}${states.map(([k, s]) => option(k, s.label)).join('')}${option('merged', 'Merged (live)')}${option('open', 'PR open (live)')}${option('closed', 'Closed unmerged (live)')}</select></label><label>Step with problems<select data-filter-key="problem"><option value="">Any or none</option>${option('any', 'Any step')}${STEPS.map(s => option(s.key, s.name)).join('')}</select></label><label>Kind<select data-filter-key="kind"><option value="">All</option>${option('issue', 'Issue')}${option('pr', 'PR')}</select></label><label>Provider<select data-filter-key="provider"><option value="">All</option>${providers.map(p => option(p, p)).join('')}</select></label><label>Period<select data-filter-key="period"><option value="">All retained</option>${option('7', 'Last 7 days')}${option('30', 'Last 30 days')}</select></label><span data-filter-count role="status"></span></div>`;
  return `<h1>Pipelines</h1><p class="sub">One card per recorded work item (issue, or PR without an issue). Each step shows its <strong>final</strong> execution status — ✓ success, ✗ failed, ⊘ skipped, ○ not recorded (never a failure) — with an amber ring when the step completed but decided not to move the item forward; ×N counts its attempts. Expand a card for every attempt. Merge is confirmed only by GitHub's <code>merged_at</code>, checked live; a running step is not observable (records are written when a run completes).</p><section data-flow-dashboard data-filter-scope data-ref="${ref}"><div class="link-row"><button type="button" data-load-flows>Refresh merge status</button><a class="button-link" href="traces/index.html">Trace table & open issues</a></div><p data-flow-status role="status">JavaScript and GitHub API access are needed to check merges. Recorded flows are available below.</p>${filters}<p data-filter-empty class="muted" hidden>No work item matches these filters.</p><div data-flow-list class="flow-list">${traces.map(card).join('') || '<p>No recorded flows yet.</p>'}</div><template data-missing-flow>${card({ runs: [], item: null, running_ms: null, waiting_ms: null, runs_overflow: 0, trace_id: '' })}</template></section>`;
}

export const FLOW_STYLE = `
.flow-list { display:grid; gap:14px; margin-top:12px; }
.flow-card { overflow-wrap:anywhere; border-left:5px solid var(--tone, var(--border)); padding:14px 18px; }
.flow-pipeline { list-style:none; padding:0; display:grid; grid-template-columns:1fr; gap:24px; }
@media(min-width:1000px) { .flow-pipeline { grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; } .flow-node:not(:last-child)::after { content:none; } }
.flow-node { position:relative; border:1px solid var(--border); border-top:4px solid var(--tone, var(--s1)); border-radius:10px; padding:12px 14px; min-width:0; }
.flow-node:not(:last-child)::after { content:'↓'; position:absolute; bottom:-23px; left:50%; color:var(--muted); }
.flow-node.missing { border-top-color:var(--muted); background:var(--page); color:var(--muted); }
.flow-node summary, .flow-summary { min-height:44px; cursor:pointer; }
.flow-summary { display:flex; flex-wrap:wrap; align-items:center; gap:6px 16px; list-style-position:outside; }
.flow-summary h2 { display:inline; margin:0; font-size:19px; min-width:110px; }
.flow-status { display:flex; flex-wrap:wrap; gap:6px; margin-top:0; align-items:center; }
.flow-state { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; font-size:12px; flex-basis:100%; }
.flow-step-icon { position:relative; display:inline-flex; }
.flow-retry { position:absolute; right:-7px; top:-6px; font-size:10px; font-weight:700; color:var(--ink-2); background:var(--surface); border-radius:6px; padding:0 2px; }
.flow-status-icon { display:inline-flex; align-items:center; justify-content:center; min-width:28px; height:28px; border:1px solid var(--border); border-radius:50%; font-weight:700; }
.flow-status-icon.success { color:var(--good); } .flow-status-icon.failed { color:var(--critical); border-color:var(--critical); border-width:2px; }
.flow-status-icon.decision-warn { border:2px solid var(--warning); }
.flow-cost-chip { display:inline-flex; align-items:center; min-height:28px; padding:0 10px; border:1px solid var(--border); border-radius:14px; font-size:12px; font-weight:650; color:var(--ink-2); font-variant-numeric:tabular-nums; }
.flow-step-cost { font-variant-numeric:tabular-nums; }
.flow-status-icon.skipped { color:var(--ink-2); } .flow-status-icon.not-recorded { color:var(--muted); border-style:dashed; }
.flow-attempts { list-style:none; padding:0; margin:8px 0 0; display:grid; gap:4px; }
.flow-attempts summary { min-height:32px; font-size:12px; }
.flow-attempt { display:inline-flex; gap:6px; align-items:center; font-weight:650; color:var(--ink); }
.flow-step-final { font-size:12px; }
.flow-escalation { display:flex; gap:8px; align-items:center; }
@media(max-width:600px) { .flow-pipeline { grid-template-columns:1fr; } .flow-card h2 { font-size:18px; } [data-flow-search] { width:100%; } }
`;

// Merge facts: every recorded card stays; GitHub's PR state is laid over it (merged_at → merged, closed
// without it → closed unmerged), and a merged PR without a recorded flow gets an empty card.
export const FLOW_SCRIPT = `${PR_STATES_SCRIPT}<script>
(() => {
 const box = document.querySelector('[data-flow-dashboard]'); if (!box) return;
 const list = box.querySelector('[data-flow-list]'), status = box.querySelector('[data-flow-status]'), button = box.querySelector('[data-load-flows]');
 const original = [...list.querySelectorAll('[data-flow]')].map(c => c.cloneNode(true));
 const refilter = () => box.dispatchEvent(new Event('adl:refilter'));
 const setIcon = (c, state, label, glyph) => {
  const icon = c.querySelector('[data-merge-status] [data-stage-status]');
  icon.dataset.stageStatus = state; icon.className = 'flow-status-icon ' + state; icon.textContent = glyph;
  icon.setAttribute('aria-label', label); icon.title = label;
 };
 const load = async () => {
  button.disabled = true; status.textContent = 'Loading PR states from GitHub…';
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
    if (!m.pr) { c.querySelector('[data-merge]').textContent = 'Merge status: no matching PR among the ' + pulls.length + ' most recently updated'; continue; }
    const a = document.createElement('a'); a.href = 'https://github.com/koydas/autonomous-dev-loop/pull/' + m.pr.number; a.textContent = 'PR #' + m.pr.number + ' · ' + m.pr.title; related.append(related.childNodes.length ? ' · ' : '', a);
    if (m.state === 'merged') {
     merged++;
     c.querySelector('[data-merge]').textContent = 'Merged ' + m.pr.merged_at + ' · ' + (m.pr.merge_commit_sha || 'SHA not available');
     c.querySelector('[data-merge-node]').classList.remove('missing'); c.querySelector('[data-merge-step]').textContent = 'Merged · ' + m.pr.merged_at;
     setIcon(c, 'success', 'Merge: success', '✓');
     const pill = c.querySelector('[data-state-pill]'); const note = document.createElement('span'); note.className = 'pill tone-good'; note.textContent = '✓ Merged'; pill.prepend(note, ' last recorded: ');
    } else if (m.state === 'closed') {
     c.querySelector('[data-merge]').textContent = 'PR #' + m.pr.number + ' closed without merge';
     c.querySelector('[data-merge-step]').textContent = 'Closed without merge'; setIcon(c, 'skipped', 'Merge: closed without merge', '⊘');
    } else {
     c.querySelector('[data-merge]').textContent = 'PR #' + m.pr.number + ' is open: not merged yet';
     c.querySelector('[data-merge-step]').textContent = 'PR open'; setIcon(c, 'not-recorded', 'Merge: PR open', '○');
    }
   }
   for (const pr of pulls.filter(p => p.merged_at).sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))) {
    if (claimed.has(pr.number) || (pr.hint && cards.some(c => c.dataset.issue === pr.hint && !c.dataset.prs))) continue;
    const c = box.querySelector('template').content.firstElementChild.cloneNode(true);
    c.dataset.prs = String(pr.number); c.dataset.state = 'merged'; c.dataset.last = String(Date.parse(pr.merged_at) || '');
    if (pr.hint) c.dataset.issue = pr.hint;
    const title = c.querySelector('[data-flow-title]'); title.replaceChildren();
    const a = document.createElement('a'); a.href = 'https://github.com/koydas/autonomous-dev-loop/pull/' + pr.number; a.textContent = 'PR #' + pr.number + ' · ' + pr.title; title.append(a);
    c.querySelector('[data-merge]').textContent = 'Merged ' + pr.merged_at + ' · ' + (pr.merge_commit_sha || 'SHA not available') + ' · no recorded pipeline run';
    c.querySelector('[data-merge-node]').classList.remove('missing'); c.querySelector('[data-merge-step]').textContent = 'Merged · ' + pr.merged_at;
    setIcon(c, 'success', 'Merge: success', '✓'); merged++;
    const pill = c.querySelector('[data-state-pill]'); pill.textContent = '✓ Merged · no recorded pipeline run'; pill.className = 'pill tone-good';
    c.querySelector('a.button-link')?.remove();
    cards.push(c);
   }
   list.replaceChildren(...cards); refilter();
   status.textContent = pulls.length + ' PRs checked · ' + merged + ' merged · ' + new Date().toLocaleString() + (more ? ' · Limited to the 1,000 most recently updated PRs.' : '');
  } catch (err) { status.textContent = 'Merge status unavailable (' + err.message + '). Showing recorded flows; merge is not inferred from job success.'; list.replaceChildren(...original.map(c => c.cloneNode(true))); refilter(); }
  finally { button.disabled = false; }
 };
 button.addEventListener('click', () => { try { sessionStorage.removeItem('adl-pulls-v1'); } catch {} load(); }); load();
})();
</script>${FILTER_SCRIPT}`;

