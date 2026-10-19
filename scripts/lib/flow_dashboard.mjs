// Recorded evidence is rendered at build time; GitHub supplies merge facts in the browser.
import { escapeHtml as e } from './eval_site.mjs';
import { PRICES_USD_PER_MTOK } from './eval_scorecard.mjs';

const stages = [['Validation', 'issue_validation'], ['Code generation', 'code_gen'], ['PR preparation', 'pr_prepare'], ['Review', 'review'], ['Auto-fix', 'autofix']];
const duration = v => v == null ? 'Not recorded' : `${(v / 1000).toFixed(1)} s`;

function card(trace) {
  const runs = trace.runs.map(r => r.run).filter(Boolean);
  const calls = runs.flatMap(r => r.llm);
  let usd = 0, unpriced = 0;
  for (const call of calls) {
    const price = PRICES_USD_PER_MTOK[`${call.provider}:${call.model}`];
    if (!price || call.tokens_in == null || call.tokens_out == null || (price.maxPromptTokens && call.tokens_in > price.maxPromptTokens)) unpriced++;
    else usd += (call.tokens_in * price.in + call.tokens_out * price.out) / 1e6;
  }
  const numbers = [...new Set(runs.flatMap(r => [r.pr_number, ...r.events.map(ev => ev.meta?.prNumber)]).filter(n => Number.isSafeInteger(n) && n > 0))];
  if (trace.item?.kind === 'pr' && !numbers.includes(trace.item.number)) numbers.push(trace.item.number);
  return `<article class="widget flow-card" data-flow data-prs="${numbers.join(',')}" data-issue="${trace.item?.kind === 'issue' ? trace.item.number : ''}"><h2 data-flow-title>${e(trace.item?.kind ?? 'Work item')} #${e(trace.item?.number ?? 'unknown')}</h2><p data-merge>Merge status: not checked</p><p data-related></p><div class="widget-meta"><span>Recorded running: ${duration(trace.running_ms)}</span><span>Waiting: ${duration(trace.waiting_ms)}</span><span>${trace.runs.length} executions</span></div><p>LLM cost estimate: ${calls.length ? `$${usd.toFixed(4)} USD${unpriced ? ` + ${unpriced} unpriced call(s)` : ''}` : 'Not recorded'} · excludes thinking and cache adjustments; never a bill.</p><ol class="flow-pipeline">${stages.map(([name, stage]) => {
    const matching = runs.filter(r => r.stages.some(s => s.stage === stage) || r.events.some(ev => ev.stage === stage));
    return `<li class="flow-node${matching.length ? '' : ' missing'}"><strong>${name}</strong><p>${matching.length ? `${matching.length} execution(s)` : 'Not recorded'}</p>${matching.map(r => `<details><summary>${e(r.outcome ?? 'Unknown')} · ${duration(r.duration_ms)}</summary><p>${e(r.workflow)} · ${e(r.actor ?? 'Unknown actor')} · ${e(r.head_sha ?? 'SHA not recorded')}</p><p>${e(r.llm.map(c => `${c.provider ?? '?'}:${c.model ?? '?'} · ${c.tokens_in ?? '?'} input / ${c.tokens_out ?? '?'} output tokens (estimated)${c.fallback ? ' · fallback' : ''}${c.failed ? ' · failed call' : ''}`).join(', ') || 'Model not recorded')}</p><p>${r.started_at == null ? 'Start not recorded' : e(new Date(r.started_at).toISOString())} · ${r.events.length} actions</p><a class="button-link" href="runs/${encodeURIComponent(r.run_id)}.html">Agent trace, events & spans →</a></details>`).join('')}</li>`;
  }).join('')}<li class="flow-node missing" data-merge-node><strong>Merge</strong><p data-merge-step>Not checked</p></li></ol><p>${trace.runs.filter(r => !r.run).length} execution record(s) unavailable · ${e(trace.runs_overflow)} outside index</p>${trace.trace_id ? `<a class="button-link" href="traces/${trace.trace_id}.html">Full chronological flow →</a>` : ''}</article>`;
}

export function flowDashboard(model) {
  return `<h1>Flow map</h1><p>One box per merged PR. Every pipeline step stays visible; grey means no recorded evidence, not a failure or a skipped step. Metrics cover the retained work-item trace (which can include several PRs), not the entire PR lifetime. Review and auto-fix may repeat: expand an execution to debug it.</p><section data-flow-dashboard><button type="button" data-load-flows>Refresh merged PRs</button><p data-flow-status role="status">JavaScript and GitHub API access are needed to check merges. Recorded flows are available below.</p><label>Search flows <input type="search" data-flow-search placeholder="PR, issue, model, outcome…"></label><div data-flow-list class="flow-list">${model.traces.map(card).join('') || '<p>No recorded flows yet.</p>'}</div><template data-missing-flow>${card({ runs: [], item: null, running_ms: null, waiting_ms: null, runs_overflow: 0, trace_id: '' })}</template></section>`;
}

export const FLOW_STYLE = `
@media(min-width:1000px) { .flow-list { grid-template-columns:repeat(2,minmax(0,1fr)); } }
.flow-list { display:grid; gap:20px; margin-top:20px; }
.flow-card { overflow-wrap:anywhere; }
.flow-pipeline { list-style:none; padding:0; display:grid; grid-template-columns:1fr; gap:24px; }
.flow-node { position:relative; border:1px solid var(--border); border-left:4px solid var(--s1); border-radius:10px; padding:14px; min-width:0; }
.flow-node:not(:last-child)::after { content:'↓'; position:absolute; bottom:-23px; left:50%; color:var(--muted); }
.flow-node.missing { border-left-color:var(--muted); background:var(--page); color:var(--muted); }
.flow-node summary { min-height:44px; cursor:pointer; }
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
    // Match recorded PR identity first, then the same pipeline branch convention as tracing.
    const branch = /^ai\\/issue-(\\d{1,9})$/.exec(pr.head?.ref || '');
    const closing = /(?:^|[^\\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \\t]*:?[ \\t]+#(\\d{1,9})\\b/i.exec(String(pr.body || '').slice(0, 65536));
    const issueHint = branch?.[1] || (closing && Number(closing[1]) > 0 ? String(Number(closing[1])) : '');
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
