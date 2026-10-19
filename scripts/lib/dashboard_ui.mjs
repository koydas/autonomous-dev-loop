// Presentation only: the published scorecard, run records and trace indexes remain authoritative.
// No framework, credentials or third-party assets are needed by the generated pages.
const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (v) => String(v ?? 'Unknown').replace(/_/g, ' ');
const date = (v) => v == null || !Number.isFinite(new Date(v).getTime()) ? 'Not recorded' : new Date(v).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const itemName = (item) => item ? `${item.kind === 'issue' ? 'Issue' : item.kind === 'pr' ? 'PR' : 'Run'} #${item.number}` : 'Unlinked work';
const runUrl = (root, run) => `${root}runs/${encodeURIComponent(run.run_id)}.html`;
const outcome = (v) => v === 'success' ? 'good' : v === 'failed' ? 'bad' : 'neutral';
const badge = (v) => `<span class="result-badge ${outcome(v)}">${v === 'success' ? '✓' : v === 'failed' ? '✕' : '○'} ${e(label(v))}</span>`;
const metric = (title, value, note, href, tone = '') => `<a class="stat-card ${tone}" href="${e(href)}"><span class="eyebrow">${e(title)}</span><strong>${e(value)}</strong><span class="stat-note">${e(note)} <span aria-hidden="true">→</span></span></a>`;

export const DASHBOARD_STYLE = `
:root { --page:#f3f6fa; --surface:#fff; --ink:#15263d; --ink-2:#465b73; --muted:#5d6f83; --border:#dce4ee; --good:#11734e; --critical:#ba343f; --warning:#bf8015; --s1:#245db5; --radius:16px; }
@media(prefers-color-scheme:dark) { :root:where(:not([data-theme="light"])) { --page:#0c1421; --surface:#152133; --ink:#e9f0fa; --ink-2:#b9c8db; --muted:#a0b2c9; --border:#2b3c53; --good:#65d7a7; --critical:#ff929b; --s1:#95bfff; } }
html { scroll-behavior:smooth; scroll-padding-top:100px; }
body { font-size:15px; -webkit-font-smoothing:antialiased; }
main { max-width:1320px; padding:36px 32px 80px; min-width:0; }
a { text-underline-offset:3px; }
a:hover { text-decoration-thickness:2px; }
:focus-visible { outline:3px solid var(--s1); outline-offset:4px; border-radius:4px; }
[hidden] { display:none !important; }
.skip-link { position:absolute; left:12px; top:-100px; z-index:30; background:var(--surface); padding:12px; }
.skip-link:focus { top:12px; }
.app-header { position:sticky; top:0; z-index:20; background:var(--surface); border-bottom:1px solid var(--border); }
.app-header-inner { max-width:1320px; margin:auto; padding:14px 32px; display:flex; align-items:center; gap:28px; flex-wrap:wrap; }
.brand { display:flex; align-items:center; gap:10px; font-weight:750; color:var(--ink); text-decoration:none; letter-spacing:-.4px; }
.brand-icon { display:grid; place-items:center; width:34px; height:34px; border-radius:10px; color:white; background:#205e65; font-size:23px; }
.primary-nav { display:flex; flex-wrap:wrap; gap:4px; }
.primary-nav a { padding:9px 12px; text-decoration:none; border-radius:8px; color:var(--ink-2); font-size:14px; font-weight:600; min-height:42px; }
.primary-nav a:hover,.primary-nav a[aria-current="page"] { background:var(--page); color:var(--s1); }
.source-link { margin-left:auto; font-size:13px; }
.legacy-nav { font-size:12px; margin-bottom:26px; }
h1 { font-size:clamp(26px,4vw,38px); line-height:1.2; letter-spacing:-1px; margin-bottom:12px; overflow-wrap:anywhere; }
h2 { font-size:22px; letter-spacing:-.4px; margin-top:36px; overflow-wrap:anywhere; }
h3 { font-size:17px; }
.sub { max-width:95ch; line-height:1.65; }
.eyebrow { text-transform:uppercase; letter-spacing:1.2px; font-size:11px; font-weight:750; color:var(--ink-2); }
.section-intro { display:flex; align-items:start; justify-content:space-between; flex-wrap:wrap; gap:12px; margin:28px 0 16px; }
.section-intro h2 { margin:0 0 6px; }
.section-intro p { margin:0; color:var(--muted); }
.card,.tile { border-radius:var(--radius); }
.card { padding:20px; }
.tiles { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
.tile .value { font-size:25px; white-space:normal; overflow-wrap:anywhere; }
.tile .label { font-size:12px; }
.summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:16px; margin:22px 0; }
.stat-card { display:flex; flex-direction:column; gap:10px; padding:22px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); color:var(--ink); text-decoration:none; min-width:0; }
.stat-card:hover { border-color:var(--s1); }
.stat-card strong { font-size:36px; line-height:1.15; letter-spacing:-1px; }
.stat-note { color:var(--muted); font-size:12px; }
.stat-card.good strong { color:var(--good); } .stat-card.bad strong { color:var(--critical); }
.widget-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.widget { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:22px; min-width:0; }
.widget h3 { margin:0; font-size:19px; }
.widget-head { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:start; margin-bottom:14px; }
.widget p { color:var(--ink-2); font-size:13px; overflow-wrap:anywhere; }
.widget-meta { display:flex; flex-wrap:wrap; gap:8px 18px; color:var(--muted); font-size:12px; margin:14px 0; }
.result-badge { display:inline-flex; align-items:center; gap:6px; border:1px solid currentColor; border-radius:30px; padding:3px 10px; font-size:12px; font-weight:650; line-height:1.5; }
.result-badge.good { color:var(--good); } .result-badge.bad { color:var(--critical); } .result-badge.neutral { color:var(--ink-2); }
.metric-big { font-size:32px; font-weight:750; letter-spacing:-1px; }
.metric-name { color:var(--muted); font-size:12px; display:block; }
meter { display:block; width:100%; height:12px; margin:12px 0; accent-color:var(--good); }
.button-link,button { display:inline-flex; justify-content:center; align-items:center; padding:10px 14px; min-height:44px; background:var(--surface); border:1px solid var(--border); border-radius:8px; font:inherit; font-size:13px; font-weight:650; color:var(--s1); text-decoration:none; cursor:pointer; }
.button-link:hover,button:hover { background:var(--page); border-color:var(--s1); }
button:disabled { opacity:.6; cursor:wait; }
.link-row { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
.detail-panel { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); padding:0 20px; margin:18px 0; }
.detail-panel > summary { color:var(--ink); font-weight:650; min-height:54px; padding:16px 0; }
.detail-panel[open] { padding-bottom:16px; }
.detail-panel .card { box-shadow:none; }
section[id],article[id] { scroll-margin-top:100px; }
.nav2 { padding:12px 0; gap:10px 18px; border-bottom:1px solid var(--border); }
.nav2 a { padding:7px 0; }
.filters { background:var(--surface); border:1px solid var(--border); padding:14px; border-radius:12px; }
.filters select,.filters input,input[type="search"],select[data-pick] { min-height:44px; min-width:0; max-width:100%; border:1px solid var(--border); padding:10px; border-radius:8px; font:inherit; color:var(--ink); background:var(--surface); }
.browse-toolbar { display:flex; flex-wrap:wrap; gap:12px; align-items:end; margin:20px 0; }
.browse-toolbar label { display:grid; gap:5px; font-size:12px; color:var(--ink-2); }
.browse-toolbar label:first-child { flex:1; min-width:180px; }
.browse-toolbar input { width:100%; }
.browse-count,.empty-message { color:var(--muted); font-size:13px; }
.flow-steps { list-style:none; padding:0; margin:20px 0; display:grid; gap:12px; }
.flow-step { position:relative; padding:16px 18px; border:1px solid var(--border); border-left:4px solid var(--s1); border-radius:10px; background:var(--surface); }
.flow-step .widget-head { margin:0; }
.flow-step p { margin:8px 0 0; color:var(--muted); font-size:13px; }
.table-wrap { max-width:100%; overscroll-behavior-x:contain; }
table { font-size:13px; } th,td { padding:10px 12px; }
td,th,code { overflow-wrap:anywhere; }
pre { max-width:100%; }
.wf-track { min-width:180px; }
.notice { padding:14px 18px; border:1px solid var(--border); border-left:4px solid var(--s1); background:var(--surface); border-radius:10px; color:var(--ink-2); font-size:13px; }
.page-footer { border-top:1px solid var(--border); margin-top:48px; padding-top:18px; font-size:12px; color:var(--muted); }
@media(min-width:900px) { .suite-details > .tiles { grid-template-columns:repeat(4,minmax(0,1fr)); } }
@media(max-width:850px) { .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .source-link { display:none; } .app-header-inner { gap:10px 20px; } }
@media(max-width:600px) {
  main { padding:24px 16px 48px; } .app-header-inner { padding:10px 16px; gap:10px; }
  .brand { font-size:15px; } .primary-nav { width:100%; gap:2px; } .primary-nav a { padding:9px 10px; font-size:12px; flex:1; text-align:center; }
  .app-header { position:relative; } .summary-grid { gap:10px; } .stat-card { padding:16px; } .stat-card strong { font-size:30px; }
  .widget-grid { grid-template-columns:1fr; } .widget { padding:18px; } .detail-panel { padding-left:14px; padding-right:14px; }
  .card { padding:14px; } .legacy-nav { overflow-wrap:anywhere; } .tiles { grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  .mobile-stack thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  .mobile-stack,.mobile-stack tbody { display:block; width:100%; }
  .mobile-stack tbody tr { display:block; padding:12px 0; border-bottom:1px solid var(--border); }
  .mobile-stack tbody td { display:block; position:relative; border:0; padding:6px 0 6px 36%; text-align:left; white-space:normal; min-width:0; min-height:30px; }
  .mobile-stack td::before { content:attr(data-label); position:absolute; left:0; width:32%; color:var(--muted); font-size:12px; font-weight:500; }
  .mobile-stack td.out,.mobile-stack td.wrap { min-width:0; }
  .mobile-stack td > * { min-width:0; }
  .tip { white-space:normal; max-width:100%; }
  .browse-toolbar > label { flex:1; } .filters label { flex:1; } .filters select,.filters input { width:100%; }
}
@media(prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
`;

// Runs after the document: native details work without JavaScript; enhancements use textContent only.
export const DASHBOARD_SCRIPT = `<script>
(() => {
  for (const region of document.querySelectorAll('.table-wrap')) {
    region.tabIndex = 0; region.setAttribute('role', 'region'); region.setAttribute('aria-label', 'Scrollable data table');
  }
  for (const table of document.querySelectorAll('table:not(.wf):not(.matrix)')) {
    const heads = [...table.querySelectorAll('thead th')].map(h => h.textContent.trim());
    if (heads.length < 3) continue;
    table.classList.add('mobile-stack');
    for (const row of table.querySelectorAll('tbody tr')) [...row.cells].forEach((cell, i) => { cell.dataset.label = heads[i] || 'Result'; });
  }
  for (const link of document.querySelectorAll('.primary-nav a')) {
    if (new URL(link.href).pathname === location.pathname) link.setAttribute('aria-current', 'page');
  }
  for (const box of document.querySelectorAll('[data-browser]')) {
    const cards = [...box.querySelectorAll('[data-entry]')], search = box.querySelector('[data-search]'), pick = box.querySelector('[data-pick]');
    const initial = box.dataset.browser === 'executions' ? new URLSearchParams(location.search).get('result') : null;
    if ([...pick.options].some(o => o.value === initial)) pick.value = initial;
    const apply = () => {
      let n = 0;
      for (const card of cards) {
        card.hidden = !(card.textContent.toLowerCase().includes(search.value.trim().toLowerCase()) && (!pick.value || card.dataset.result === pick.value));
        if (!card.hidden) n++;
      }
      box.querySelector('[data-count]').textContent = n + ' of ' + cards.length + ' shown';
      box.querySelector('[data-empty]').hidden = n !== 0;
    };
    box.addEventListener('input', apply); box.addEventListener('change', apply); apply();
  }
  for (const box of document.querySelectorAll('[data-open-issues]')) {
    const status = box.querySelector('[data-issue-status]'), list = box.querySelector('[data-issue-list]'), button = box.querySelector('button');
    const load = async () => {
      button.disabled = true; status.textContent = 'Loading open issues from GitHub…';
      const items = []; let more = false;
      try {
        for (let page = 1; page <= 10; page++) {
          const response = await fetch('https://api.github.com/repos/koydas/autonomous-dev-loop/issues?state=open&per_page=100&page=' + page, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(12000) });
          if (!response.ok) throw new Error('GitHub HTTP ' + response.status);
          const data = await response.json(); if (!Array.isArray(data)) throw new Error('Invalid GitHub response');
          items.push(...data.filter(i => !i.pull_request)); more = data.length === 100;
          if (!more) break;
        }
        const fragment = document.createDocumentFragment();
        for (const issue of items) {
          if (!Number.isSafeInteger(issue.number) || issue.number <= 0) continue;
          const card = document.createElement('article'); card.className = 'widget';
          const h = document.createElement('h3'), a = document.createElement('a');
          a.href = 'https://github.com/koydas/autonomous-dev-loop/issues/' + issue.number; a.textContent = '#' + issue.number + ' ' + issue.title; h.append(a); card.append(h);
          const p = document.createElement('p'); p.textContent = 'Open · ' + (issue.labels || []).map(l => typeof l === 'string' ? l : l.name).join(' · '); card.append(p);
          const trace = [...document.querySelectorAll('[data-issue-number]')].find(el => el.dataset.issueNumber === String(issue.number));
          if (trace) { const link = document.createElement('a'); link.href = trace.href; link.className = 'button-link'; link.textContent = 'Explore recorded flow →'; card.append(link); }
          fragment.append(card);
        }
        list.replaceChildren(fragment);
        status.textContent = items.length + ' open issue(s) · checked ' + new Date().toLocaleTimeString() + (more ? ' · first 1,000 GitHub items only; see GitHub for the complete list.' : '') + (items.length ? '' : ' · No open issues.');
      } catch (err) { list.replaceChildren(); status.textContent = 'Live issue status unavailable (' + err.message + '). Use “Open issues on GitHub”; recorded flows remain available below.'; }
      finally { button.disabled = false; }
    };
    button.addEventListener('click', load); load();
  }
})();
</script>`;

export function dashboardHeader(root, pipeline) {
  return `<a class="skip-link" href="#main-content">Skip to content</a><header class="app-header"><div class="app-header-inner"><a class="brand" href="${root}index.html"><span class="brand-icon" aria-hidden="true">↻</span>Dev loop <span class="muted">/ monitor</span></a><nav class="primary-nav" aria-label="Main navigation"><a href="${root}index.html">Overview</a>${pipeline ? `<a href="${root}pipeline/flows.html">Flow map</a><a href="${root}pipeline/traces/index.html">Issues & flows</a><a href="${root}pipeline/index.html">Executions</a><a href="${root}pipeline/health.html">Health</a>` : ''}</nav><a class="source-link" href="https://github.com/koydas/autonomous-dev-loop">View repository →</a></div></header>`;
}

export function evalOverview(suites) {
  if (!suites.length) return '';
  const passing = suites.filter(([, s]) => s.runs[0].passed).length;
  return `<div class="summary-grid">${metric('Suites passing', passing, `of ${suites.length} latest evaluations`, '#evaluations', 'good')}${metric('Needs attention', suites.length - passing, 'Suites below their quality gate', '#evaluations', suites.length > passing ? 'bad' : '')}${metric('Recorded evaluations', suites.reduce((n, [, s]) => n + s.runs.length, 0), 'Explore the history of each suite', '#evaluations')}${metric('Cases in latest runs', suites.reduce((n, [, s]) => n + (s.runs[0].n_cases ?? 0), 0), 'Labelled cases across suites', '#evaluations')}</div>`;
}

export function suiteWidget(name, run) {
  const first = Object.entries(run.scores ?? {})[0];
  const score = first?.[1];
  return `<article class="widget"><div class="widget-head"><h3>${e(label(name))}</h3>${badge(run.passed ? 'success' : 'failed')}</div>${first ? `<span class="metric-big">${typeof score === 'number' ? e((score * 100).toFixed(1)) + '%' : '—'}</span><span class="metric-name">${e(label(first[0]))}</span>${typeof score === 'number' ? `<meter min="0" max="1" value="${Math.max(0, Math.min(1, score))}" aria-label="${e(label(first[0]))}">${e(score)}</meter>` : ''}` : ''}<p>${run.passed ? 'All required quality thresholds met.' : `Quality thresholds need attention: ${e((run.failures ?? []).join(', ') || 'see run details')}.`}</p><div class="widget-meta"><span>${e(run.n_cases ?? '—')} cases × ${e(run.repeats ?? '—')} repeats</span><span>${e(date(run.ts))}</span></div><a class="button-link" href="runs/${encodeURIComponent(run.run_id)}.html">Explore evaluation →</a></article>`;
}

function browse(kind, content, count) {
  return `<div data-browser="${e(kind)}"><div class="browse-toolbar"><label>Search ${e(kind)}<input type="search" data-search placeholder="Number, workflow, result…"></label><label>Result<select data-pick><option value="">All results</option><option value="success">Success</option><option value="failed">Failed</option><option value="partial">Partial</option><option value="skipped">Skipped</option><option value="unknown">Not recorded</option></select></label><span class="browse-count" data-count role="status">${count} shown</span></div><p data-empty class="empty-message" hidden>No matching ${e(kind)}. Clear the search or change the result filter.</p><div class="widget-grid">${content}</div></div>`;
}

export function pipelineOverview(model, root = '') {
  const runs = model.runs ?? [];
  const successful = runs.filter(r => r.outcome === 'success').length;
  const failed = runs.filter(r => r.outcome === 'failed').length;
  return `<section aria-label="Pipeline summary"><div class="section-intro"><div><span class="eyebrow">Pipeline monitor</span><h2>What happened in the loop?</h2><p>Recorded executions in the retained window. A successful job does not imply an approved or merged PR. Recorded outcomes mix execution and business decisions: partial does not imply a failed job. This is not an end-to-end success rate.</p></div><a class="button-link" href="${root}traces/index.html">Issues & flows →</a></div><div class="summary-grid">${metric('Successful executions', successful, 'Runs recorded as success; not an approval rate', root + 'index.html?result=success#executions', 'good')}${metric('Failed executions', failed, 'Inspect the failure and its trace', root + 'index.html?result=failed#executions', failed ? 'bad' : '')}${metric('Other results', runs.length - successful - failed, 'Partial, skipped or unknown', root + 'index.html#executions')}${metric('Work-item flows', model.traces?.length ?? 0, 'Issues and PRs with recorded traces', root + 'traces/index.html')}</div></section>`;
}

// Explain recorded facts without turning a business verdict into a job status.
function executionFacts(run) {
  const events = run.events ?? [];
  const latest = (name) => events.filter(event => event.event === name).at(-1)?.meta;
  const review = latest('review.verdict');
  const skipped = latest('review.skipped');
  const autofix = latest('autofix.skipped');
  const escalation = latest('autofix.escalated');
  const budget = latest('review.prompt_truncated');
  const facts = [];
  if (review) {
    facts.push(`Review verdict: ${review.verdict ?? 'Not recorded'}`);
    if (review.withheld_from) facts.push(`Withheld from: ${review.withheld_from}`);
    if (review.evidence_state) facts.push(`CI evidence: ${review.evidence_state}`);
  }
  if (skipped) facts.push(`Review skipped: ${skipped.reason ?? 'Not recorded'}`);
  if (autofix) facts.push(`Auto-fix skipped: ${autofix.reason ?? 'Not recorded'}`);
  if (escalation) facts.push(`Human escalation: ${escalation.reason ?? 'Not recorded'}`);
  const incomplete = review?.unreviewed_code_files ?? budget?.unreviewed_code_files;
  if (Number.isSafeInteger(incomplete) && incomplete >= 0) facts.push(`Code files not fully reviewed: ${incomplete}`);
  if (budget?.diff_truncated === true) facts.push('Review diff truncated');
  return `<p>Recorded outcome: ${e(run.outcome ?? 'Not recorded')}</p><p>${facts.length ? facts.map(e).join(' · ') : 'Decision and cause: Not recorded'}</p>`;
}

export function executionBrowser(model, root = '') {
  const cards = model.runs.map(run => `<article class="widget" data-entry data-result="${e(run.outcome || 'unknown')}"><div class="widget-head"><h3><a href="${runUrl(root, run)}">${e(run.workflow ?? 'Workflow')}</a></h3>${badge(run.outcome)}</div><p>${e(itemName(run.item))} · execution ${e(run.run_id)}</p>${executionFacts(run)}<div class="widget-meta"><span>${e(date(run.started_at))}</span><span>${e(run.events.length)} actions</span><span>${e(run.event_name ?? 'Unknown trigger')}</span></div><div class="link-row"><a class="button-link" href="${runUrl(root, run)}">Inspect execution →</a>${model.tracesById?.has(run.trace_id) ? `<a class="button-link" href="${root}traces/${encodeURIComponent(run.trace_id)}.html">Full flow</a>` : ''}</div></article>`).join('');
  return `<section id="executions"><div class="section-intro"><div><h2>Executions</h2><p>One card per recorded workflow run. Search, filter, then inspect its actions and spans.</p></div></div>${cards ? browse('executions', cards, model.runs.length) : '<p class="notice">No executions recorded yet.</p>'}</section>`;
}

export function workItemBrowser(model) {
  const cards = model.traces.map(trace => {
    const last = [...trace.runs].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
    const href = `${encodeURIComponent(trace.trace_id)}.html`;
    return `<article class="widget" data-entry data-result="${e(last?.outcome || 'unknown')}"><div class="widget-head"><h3><a ${trace.item?.kind === 'issue' ? `data-issue-number="${e(trace.item.number)}" ` : ''}href="${href}">${e(itemName(trace.item))}</a></h3>${badge(last?.outcome)}</div><p>Last recorded workflow: ${e(last?.workflow ?? 'Not recorded')}</p><div class="widget-meta"><span>${e(trace.runs.length)} executions${trace.runs_overflow ? ` (+${e(trace.runs_overflow)} outside index)` : ''}</span><span>${e(date(last?.started_at))}</span></div><a class="button-link" href="${href}">Follow the flow →</a></article>`;
  }).join('');
  return `<section data-open-issues><div class="section-intro"><div><span class="eyebrow">Current work</span><h2>Open issues</h2><p>Live public GitHub status, separate from the recorded execution history.</p></div><button type="button">Refresh issues</button></div><p data-issue-status role="status" aria-live="polite">Live status needs JavaScript and access to the GitHub API.</p><p><a href="https://github.com/koydas/autonomous-dev-loop/issues?q=is%3Aissue%20is%3Aopen">Open issues on GitHub →</a></p><div class="widget-grid" data-issue-list></div></section><section id="recorded-flows"><div class="section-intro"><div><h2>Recorded flows</h2><p>Latest known execution result per issue or PR. This is history, not its current open/closed status.</p></div></div>${cards ? browse('flows', cards, model.traces.length) : '<p class="notice">No recorded flow yet.</p>'}</section>`;
}

export function flowSteps(trace) {
  return `<ol class="flow-steps" aria-label="Workflow execution history">${[...trace.runs].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0)).map((r, i) => `<li class="flow-step"><div class="widget-head"><strong>${i + 1}. ${r.run ? `<a href="../runs/${encodeURIComponent(r.run_id)}.html">${e(r.workflow ?? 'Workflow')}</a>` : e(r.workflow ?? 'Workflow') + ' (record not loaded)'}</strong>${badge(r.outcome)}</div><p>${e(date(r.started_at))} · ${e(r.run_id)}${r.run ? ` · ${e(r.run.events.length)} actions` : ''}</p></li>`).join('')}</ol>`;
}
