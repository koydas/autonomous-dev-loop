// Pipeline views of the dashboard (ADR-0027 amendment): the activity feed, one page per work-item
// trace, one per run, the health page and the provider:model cross-links, under pipeline/ next to the
// eval pages. Pure: the model (pipeline_model.mjs) and the health data (pipeline_health.mjs) in, a map
// of { path: html } out. Every record string is escaped (escapeHtml); numbers are formatted here;
// inline styles carry computed numbers only. No external script: the feed filter is inline.
import { escapeHtml, page, modelAnchor } from './eval_site.mjs';
import { feedEntries } from './pipeline_model.mjs';
import { flowDashboard, FLOW_STYLE, FLOW_SCRIPT } from './flow_dashboard.mjs';
import { TOKEN_SERIES } from './pipeline_health.mjs';
import { pipelineOverview, executionBrowser, workItemBrowser, flowSteps } from './dashboard_ui.mjs';
import { callCost, sumCosts, formatUsd, costAmount, costLine, costBasis, pipelineStage } from './llm_cost.mjs';

// The newest actions on pipeline/index.html; each month page holds at most MONTH_FEED_CAP (the run
// pages keep every event).
export const FEED_CAP = 300;
export const MONTH_FEED_CAP = 2000;

const e = escapeHtml;
const KIND_LABEL = { run: 'run', stage: 'stage', llm: 'LLM call', effect: 'side effect' };
const KIND_VAR = { run: '--s1', stage: '--s2', llm: '--s3', effect: '--s4' };
const SERIES_VAR = ['--s1', '--s2', '--s3', '--s4'];
const repo = 'https://github.com/koydas/autonomous-dev-loop/blob/main';

const STYLE = `
.nav2 { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 16px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin: 8px 0 12px; font-size: 13px; color: var(--ink-2); }
.filters label { display: flex; flex-direction: column; gap: 2px; }
.filters select, .filters input { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; min-width: 110px; }
.wf td { padding: 3px 8px; } .wf td.name { white-space: nowrap; } .wf .lvl { color: var(--muted); }
.wf-track { position: relative; height: 14px; min-width: 220px; background: linear-gradient(var(--grid), var(--grid)) 0 50% / 100% 1px no-repeat; }
.wf-bar { position: absolute; top: 2px; height: 10px; min-width: 2px; border-radius: 0 4px 4px 0; }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.note { border-left: 3px solid var(--axis); padding: 4px 10px; color: var(--ink-2); margin: 8px 0; }
td.wrap { white-space: normal; word-break: break-word; min-width: 200px; }
svg text { font-family: inherit; }
.wf .status { white-space: nowrap; }
`;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Duration in ms → `850 ms`, `4.2 s`, `3 min 05 s`, `2 h 14 min`, `3 d 4 h`; null → `—`. */
export function formatDuration(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return '—';
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  const s = Math.round(v / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

const time = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19).replace('T', ' ') : '—');
const compact = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)} %`);
const runHref = (root, id) => `${root}runs/${encodeURIComponent(id)}.html`;
const traceHref = (root, id) => `${root}traces/${encodeURIComponent(id)}.html`;
const link = (url, label) => (url ? `<a href="${e(url)}">${e(label)}</a>` : '');
const itemLabel = (item) => (item ? `${item.kind === 'issue' ? 'issue' : item.kind === 'pr' ? 'PR' : 'run'} #${item.number}` : 'no work item');
const providerModel = (p, m) => (p || m ? `${p ?? '?'}:${m ?? '?'}` : '');

function statusHtml(status, outcome) {
  const label = outcome ?? status;
  if (status === 'error' || outcome === 'failed') return `<span class="status status-critical">✕ ${e(label)}</span>`;
  if (outcome === 'partial' || outcome === 'skipped') return `<span class="status status-warning">${e(label)}</span>`;
  if (status === 'ok' || outcome === 'success') return `<span class="status status-good">✓ ${e(label)}</span>`;
  return `<span class="muted">– ${e(label ?? 'unset')}</span>`;
}

function levelHtml(level) {
  if (level === 'error') return '<span class="status status-critical">✕ error</span>';
  if (level === 'warn') return '<span class="status status-warning">warn</span>';
  return `<span class="muted">${e(level ?? '—')}</span>`;
}

function nav(root, months = []) {
  const monthLinks = months.map((m) => `<a href="${root}feed/${e(m)}.html">${e(m)}</a>`).join(' ');
  return `<p class="nav2"><a href="${root}index.html">Activity</a><a href="${root}traces/index.html">Work-item traces</a><a href="${root}health.html">Health</a><a href="${root}models.html">Models</a>${monthLinks ? `<span class="muted">Months: ${monthLinks}</span>` : ''}</p>`;
}

const pipelinePage = (title, body, depth) => page(title, body, { depth, pipeline: true, style: STYLE });
const emptyCard = (text) => `<div class="card muted">${e(text)}</div>`;

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

const distinct = (rows, key) => [...new Set(rows.map((r) => r[key]).filter((v) => v != null && v !== ''))].sort((a, b) => String(a).localeCompare(String(b)));

function feedFilters(rows) {
  const select = (name, label, values) => `<label>${e(label)}<select data-filter="${name}"><option value="">all</option>${values.map((v) => `<option value="${e(v)}">${e(v)}</option>`).join('')}</select></label>`;
  return `<div class="filters" id="feed-filters">${select('stage', 'Stage', distinct(rows, 'stage'))}${select('outcome', 'Run outcome', distinct(rows, 'outcome'))}${select('level', 'Level', distinct(rows, 'level'))}<label>Issue #<input data-filter="issue" inputmode="numeric" size="6"></label><label>PR #<input data-filter="pr" inputmode="numeric" size="6"></label><span class="muted" id="feed-count" role="status"></span></div>`;
}

// Inline filter: hides rows whose data-* differ; reads only data attributes and writes textContent.
const FEED_SCRIPT = `<script>
(() => {
  const box = document.getElementById('feed-filters'); if (!box) return;
  const rows = [...document.querySelectorAll('#feed tbody tr')], count = document.getElementById('feed-count');
  const apply = () => {
    const want = {}; box.querySelectorAll('[data-filter]').forEach((el) => { want[el.dataset.filter] = el.value.trim().replace(/^#/, ''); });
    let shown = 0;
    for (const r of rows) { const ok = Object.entries(want).every(([k, v]) => !v || r.dataset[k] === v); r.hidden = !ok; if (ok) shown++; }
    count.textContent = shown + ' / ' + rows.length + ' actions';
  };
  box.addEventListener('input', apply); apply();
})();
</script>`;

function feedTable(rows, root) {
  if (!rows.length) return emptyCard('No pipeline action recorded in this period.');
  const body = rows.map((r) => `<tr data-stage="${e(r.stage ?? '')}" data-outcome="${e(r.outcome ?? '')}" data-level="${e(r.level ?? '')}" data-issue="${e(r.issue ?? '')}" data-pr="${e(r.pr ?? '')}"><td>${e(time(r.ts))}</td><td><code>${e(r.stage ?? '—')}</code></td><td><code>${e(r.event)}</code></td><td>${levelHtml(r.level)}</td><td class="wrap">${e(r.summary)}${r.url ? ` · ${link(r.url, 'link')}` : ''}</td><td>${r.issue ? `#${e(r.issue)}` : '—'}</td><td>${r.pr ? `#${e(r.pr)}` : '—'}</td><td><a href="${runHref(root, r.run_id)}">${e(r.run_id)}</a><br><span class="muted">${e(r.workflow ?? '—')}</span></td><td>${statusHtml(null, r.outcome)}</td></tr>`).join('');
  return `${feedFilters(rows)}<div class="card table-wrap"><table id="feed"><thead><tr><th>Time (UTC)</th><th>Stage</th><th>Action</th><th>Level</th><th>Detail</th><th>Issue</th><th>PR</th><th>Run</th><th>Run outcome</th></tr></thead><tbody>${body}</tbody></table></div>${FEED_SCRIPT}`;
}

function warningsHtml(model) {
  const w = model.warnings ?? [];
  if (!w.length) return '';
  return `<details class="card"><summary>${e(w.length)} input warning(s)</summary><ul>${w.slice(0, 50).map((m) => `<li>${e(m)}</li>`).join('')}</ul></details>`;
}

export function renderFeedIndex(model, { generatedAt = null } = {}) {
  const all = feedEntries(model.runs);
  const shown = all.slice(0, FEED_CAP);
  const latest = model.runs[0];
  const tiles = [
    ['Runs (window)', compact(model.runs.length)],
    ['Work-item traces', compact(model.traces.length)],
    ['Actions', compact(all.length)],
    ['LLM cost (window)', costAmount(sumCosts(model.runs.flatMap((r) => r.llm)))],
    ['Latest run', latest ? time(latest.started_at) : '—'],
  ].map(([l, v]) => `<div class="tile"><div class="label">${e(l)}</div><div class="value">${e(v)}</div></div>`).join('');
  const window = model.months.length ? `Records of ${e(model.months.at(-1))} → ${e(model.months[0])}${model.skippedMonths.length ? ` (older months stay on the <code>metrics</code> branch: ${model.skippedMonths.map(e).join(', ')})` : ''}.` : 'No run record on the <code>metrics</code> branch yet.';
  return pipelinePage('Pipeline activity', `<h1>Pipeline activity</h1>
<p class="sub">Every action of the issue → PR pipeline, newest first, from the redacted run records on the <code>metrics</code> branch (<a href="${repo}/docs/observability.md">docs</a>, <a href="${repo}/docs/adr/0040-run-journal-and-public-run-record.md">ADR-0040</a>, <a href="${repo}/docs/adr/0041-end-to-end-work-item-tracing.md">ADR-0041</a>). ${window}${generatedAt ? ` Updated ${e(generatedAt)}.` : ''}</p>
${nav('', model.months)}
<div class="tiles">${tiles}</div>
${warningsHtml(model)}
${pipelineOverview(model)}
${executionBrowser(model)}
<details class="detail-panel"><summary>All recorded actions · technical journal</summary><h2>Latest actions</h2>
${all.length > shown.length ? `<p class="note">The newest ${e(FEED_CAP)} of ${e(all.length)} actions; older ones are on the month pages and every run page.</p>` : ''}
${feedTable(shown, '')}</details>`, 1);
}

export function renderFeedMonth(model, month) {
  const all = feedEntries(model.runs.filter((r) => r.month === month));
  const shown = all.slice(0, MONTH_FEED_CAP);
  return pipelinePage(`Pipeline activity ${month}`, `<h1>Pipeline activity · ${e(month)}</h1>
${nav('../', model.months)}
${all.length > shown.length ? `<p class="note">The newest ${e(MONTH_FEED_CAP)} of ${e(all.length)} actions this month; the run pages keep every event.</p>` : ''}
${feedTable(shown, '../')}`, 2);
}

// ---------------------------------------------------------------------------
// Waterfall
// ---------------------------------------------------------------------------

function legend() {
  return `<div class="legend">${Object.entries(KIND_LABEL).map(([k, l]) => `<span><span class="key" style="background:var(${KIND_VAR[k]})"></span>${e(l)}</span>`).join('')}</div>`;
}

function tokensHtml(t) {
  if (!t) return '';
  return `${e(compact(t.in))} → ${e(compact(t.out))}${t.estimated ? ' <span class="muted">est.</span>' : t.cache_read ? ` <span class="muted">${e(compact(t.cache_read))} cached</span>` : ''}`;
}

const spanCall = (s) => ({ provider: s.provider, model: s.model, tokens_in: s.tokens?.in, tokens_out: s.tokens?.out, cache_read: s.tokens?.cache_read, cache_write: s.tokens?.cache_write, estimated: s.tokens?.estimated });

function costHtml(cost) {
  if (!cost) return '';
  if (cost.basis === 'free') return '<span class="muted">free tier</span>';
  if (cost.usd == null) return '<span class="muted">unpriced</span>';
  return `${e(formatUsd(cost.usd))}${cost.basis === 'estimated' ? ' <span class="muted">est.</span>' : ''}`;
}

// How a cost was obtained, for the note under a cost tile row.
const BASIS_TEXT = {
  measured: 'provider-measured tokens (prompt cache priced apart, thinking inside the output)',
  estimated: 'chars/4 token estimates (records before measured usage: no thinking, no cache discount)',
  'measured + estimated': 'provider-measured tokens where the record has them, chars/4 estimates for older records',
};
const costSub = (sum) => `${BASIS_TEXT[costBasis(sum)] ?? 'no priced call'}; list price (<code>PRICES_USD_PER_MTOK</code>), never a bill${sum.unpriced ? `; ${e(sum.unpriced)} unpriced call(s) not counted` : ''}${sum.free ? `; ${e(sum.free)} Groq free-tier call(s) at $0` : ''}.`;
const costTiles = (sum, extra = []) => [
  ['LLM cost', costAmount(sum)], ['LLM calls', compact(sum.calls)], ['Input tokens', compact(sum.tokens_in)],
  ['of which cache reads', compact(sum.cache_read)], ['Output tokens', compact(sum.tokens_out)], ...extra,
].map(([l, v]) => `<div class="tile"><div class="label">${e(l)}</div><div class="value">${e(v)}</div></div>`).join('');

/** Cost per pipeline stage of some runs: rows for a table (Stage, Calls, Input, Cache read, Output, USD). */
function stageCostRows(runs) {
  const byStage = new Map();
  for (const run of runs) {
    for (const c of run.llm) {
      const stage = c.pipeline_stage ?? pipelineStage(c.stage) ?? (run.stages.length === 1 && run.stages[0].stage ? run.stages[0].stage : 'unattributed');
      byStage.set(stage, [...(byStage.get(stage) ?? []), c]);
    }
  }
  return [...byStage.entries()].map(([stage, calls]) => {
    const t = sumCosts(calls);
    return [`<code>${e(stage)}</code>`, e(t.calls), e(compact(t.tokens_in)), e(compact(t.cache_read)), e(compact(t.tokens_out)), e(costLine(t))];
  });
}
const STAGE_COST_HEAD = ['Stage', { label: 'Calls', num: true }, { label: 'Input', num: true }, { label: 'Cache reads', num: true }, { label: 'Output', num: true }, 'Cost'];

/**
 * Rows of spans on one time axis [t0, t1]. `rows`: { label, depth, kind, start, end, status, outcome,
 * provider, model, tokens, links, href? }. Bar positions are computed numbers; every label is escaped.
 */
export function waterfall(rows, { t0, t1, root = '../' } = {}) {
  if (!rows.length) return emptyCard('No span recorded.');
  const lo = Number.isFinite(t0) ? t0 : Math.min(...rows.map((r) => r.start ?? Infinity));
  const hi = Number.isFinite(t1) ? t1 : Math.max(...rows.map((r) => r.end ?? r.start ?? -Infinity));
  const span = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? hi - lo : null;
  const body = rows.map((r) => {
    const dur = r.start != null && r.end != null && r.end >= r.start ? r.end - r.start : null;
    let bar = '<span class="muted">no timing</span>';
    if (r.start != null && span) {
      const left = Math.max(0, Math.min(100, ((r.start - lo) / span) * 100));
      const width = Math.max(0, Math.min(100 - left, ((dur ?? 0) / span) * 100));
      bar = `<div class="wf-track" title="${e(`${r.label} · ${formatDuration(dur)}`)}"><span class="wf-bar" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:var(${KIND_VAR[r.kind] ?? '--s2'})"></span></div>`;
    } else if (r.start != null) {
      bar = '<div class="wf-track"><span class="wf-bar" style="left:0;width:0;background:var(--s1)"></span></div>';
    }
    const pm = providerModel(r.provider, r.model);
    const name = r.href ? `<a href="${e(r.href)}">${e(r.label)}</a>` : e(r.label);
    const links = (r.links ?? []).map((l) => link(l.url ?? l, l.label ?? 'link')).filter(Boolean).join(' · ');
    return `<tr><td class="name" style="padding-left:${8 + Math.min(r.depth ?? 0, 12) * 16}px"><span class="key" style="background:var(${KIND_VAR[r.kind] ?? '--s2'})"></span>${name} <span class="lvl">${e(KIND_LABEL[r.kind] ?? 'span')}</span></td><td>${bar}</td><td class="num">${e(formatDuration(dur))}</td><td>${statusHtml(r.status, r.outcome)}</td><td>${pm ? `<a href="${root}models.html#${modelAnchor(r.model)}"><code>${e(pm)}</code></a>` : ''}</td><td class="num">${tokensHtml(r.tokens)}</td><td class="num">${costHtml(r.cost)}</td><td>${links}</td></tr>`;
  }).join('');
  return `${legend()}<div class="card table-wrap"><table class="wf"><thead><tr><th>Span</th><th>Timeline${span ? ` (${e(formatDuration(span))})` : ''}</th><th class="num">Duration</th><th>Status</th><th>provider:model</th><th class="num">Tokens in → out</th><th class="num">Cost</th><th>Links</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

const spanRows = (run, depthOffset = 0) => run.waterfall.map((s) => ({
  label: s.name, depth: s.depth + depthOffset, kind: s.kind, start: s.start, end: s.end, status: s.status, outcome: s.outcome,
  provider: s.provider, model: s.kind === 'llm' ? s.model : null, tokens: s.tokens, links: s.links.map((url) => ({ url, label: 'link' })),
  cost: s.kind === 'llm' && s.tokens ? callCost(spanCall(s)) : null,
}));

function runLinks(run) {
  return [
    run.run_url && { url: run.run_url, label: 'workflow run' },
    run.issue_url && { url: run.issue_url, label: `issue #${run.issue_number ?? ''}` },
    run.pr_url && { url: run.pr_url, label: `PR #${run.pr_number ?? ''}` },
    ...run.links.map((l) => ({ url: l.url, label: l.event ?? 'link' })),
  ].filter(Boolean);
}

function overflowHtml(run) {
  const notes = [];
  if (run.events_overflow.count) notes.push(`${run.events_overflow.count} event(s) over the journal or record cap were not kept (events_overflow).`);
  if (run.spans_overflow.count || run.spans_overflow.events) notes.push(`${run.spans_overflow.count} span(s) and ${run.spans_overflow.events} span event(s) over the cap were not kept (spans_overflow).`);
  return notes.map((n) => `<p class="note">${e(n)}</p>`).join('');
}

// ---------------------------------------------------------------------------
// Run page
// ---------------------------------------------------------------------------

export function renderRunPage(run, model) {
  const trace = run.trace_id ? model.tracesById?.get(run.trace_id) : null;
  const facts = [
    ['Workflow', run.workflow], ['Trigger', run.event_name], ['Actor', run.actor ? `${run.actor}${run.actor_type ? ` (${run.actor_type})` : ''}` : null],
    ['Work item', itemLabel(run.item)], ['Head SHA', run.head_sha?.slice(0, 12)], ['Started (UTC)', time(run.started_at)],
    ['Duration', formatDuration(run.duration_ms)], ['Record', `schema ${run.schema_version}`],
  ].map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v ?? '—')}</td></tr>`).join('');
  const links = runLinks(run).map((l) => link(l.url, l.label)).join(' · ');
  const cost = run.cost ?? sumCosts(run.llm);
  const calls = run.llm.length ? table(['Time (UTC)', 'Stage', 'provider:model', { label: 'Input', num: true }, { label: 'Cache reads', num: true }, { label: 'Cache writes', num: true }, { label: 'Output', num: true }, 'Tokens', 'Cost'],
    run.llm.map((c) => [e(time(c.ts)), `<code>${e(c.pipeline_stage ?? c.stage ?? '—')}</code>`, `<code>${e(providerModel(c.provider, c.model) || '?')}</code>${c.fallback ? ' <span class="muted">fallback</span>' : ''}${c.failed ? ' <span class="status status-critical">failed</span>' : ''}`,
      e(compact(c.tokens_in)), e(c.estimated === false ? compact(c.cache_read ?? 0) : '—'), e(c.estimated === false ? compact(c.cache_write ?? 0) : '—'), e(compact(c.tokens_out)), c.estimated === false ? 'measured' : '<span class="muted">estimated</span>', costHtml(c.cost ?? callCost(c))])) : emptyCard('No LLM call in this run.');
  const events = run.events.length ? `<div class="card table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Stage</th><th>Event</th><th>Level</th><th class="num">ms</th><th>Meta</th></tr></thead><tbody>${run.events.map((ev) => `<tr><td>${e(time(ev.ts))}</td><td><code>${e(ev.stage ?? '—')}</code></td><td><code>${e(ev.event)}</code></td><td>${levelHtml(ev.level)}</td><td class="num">${e(ev.duration_ms ?? '—')}</td><td class="wrap"><code>${e(JSON.stringify(ev.meta))}</code></td></tr>`).join('')}</tbody></table></div>` : emptyCard('No event in this record.');
  return pipelinePage(`Run ${run.run_id}`, `<h1>Run <code>${e(run.run_id)}</code> ${statusHtml(null, run.outcome)}</h1>
${nav('../', model.months)}
<p class="sub">${links || 'No link recorded.'}${trace ? ` · <a href="${traceHref('../', trace.trace_id)}">work-item trace (${e(itemLabel(trace.item))})</a>` : run.trace_id ? ' · <span class="muted">no trace index for this work item</span>' : ''}</p>
<details class="detail-panel"><summary>Execution context · workflow, actor & revision</summary><div class="card table-wrap"><table><tbody>${facts}</tbody></table></div></details>
${overflowHtml(run)}
<details class="detail-panel" open><summary>LLM cost · tokens & USD per call</summary><h2>LLM cost</h2>
<div class="tiles">${costTiles(cost)}</div>
<p class="sub">${costSub(cost)}</p>
${calls}</details>
<details class="detail-panel"><summary>Timing & span waterfall</summary><h2>Spans</h2>
${run.flat ? '<p class="note">Schema 1 record (ADR-0040): no span tree — the run and its stages are shown flat; the events below hold every action.</p>' : ''}
${waterfall(spanRows(run), { t0: run.started_at, t1: run.completed_at })}</details>
<h2>Events</h2>
${events}`, 2);
}

// ---------------------------------------------------------------------------
// Work-item trace pages
// ---------------------------------------------------------------------------

export function renderTracePage(trace, model) {
  const rows = [];
  for (const r of trace.runs) {
    if (r.run) {
      const runRows = spanRows(r.run);
      runRows[0] = { ...runRows[0], label: `${r.run.workflow ?? 'run'} · ${r.run_id}`, href: runHref('../', r.run_id), links: runLinks(r.run).slice(0, 1) };
      rows.push(...runRows);
    } else {
      rows.push({ label: `${r.workflow ?? 'run'} · ${r.run_id} (record not loaded)`, depth: 0, kind: 'run', start: r.started_at, end: r.completed_at, status: 'unset', outcome: r.outcome, links: [] });
    }
  }
  const running = trace.running_ms;
  const waiting = trace.waiting_ms;
  const notes = [];
  if (trace.runs_overflow) notes.push(`${trace.runs_overflow} more run(s) of this item are not listed (runs_overflow: the index keeps 500).`);
  if (trace.dropped_runs) notes.push(`${trace.dropped_runs} index entr(y/ies) with a malformed run id ignored.`);
  const missing = trace.runs.filter((r) => !r.run).length;
  if (missing) notes.push(`${missing} run(s) listed by the index have no loaded record (missing, malformed or older than the month window).`);
  for (const r of trace.runs) if (r.run && (r.run.spans_overflow.count || r.run.spans_overflow.events)) notes.push(`Run ${r.run_id}: ${r.run.spans_overflow.count} span(s), ${r.run.spans_overflow.events} span event(s) over the cap (spans_overflow).`);
  const loaded = trace.runs.map((r) => r.run).filter(Boolean);
  const cost = sumCosts(loaded.flatMap((r) => r.llm));
  const costPanel = cost.calls ? `<details class="detail-panel" open><summary>LLM cost · per stage & per run</summary><h2>LLM cost</h2>
<div class="tiles">${costTiles(cost, [['Runs with LLM calls', compact(loaded.filter((r) => r.llm.length).length)]])}</div>
<p class="sub">${costSub(cost)}${missing ? ` ${e(missing)} run(s) without a loaded record are not counted.` : ''}</p>
${table(STAGE_COST_HEAD, stageCostRows(loaded))}
${table(['Run', 'Workflow', { label: 'Calls', num: true }, { label: 'Input', num: true }, { label: 'Output', num: true }, 'Cost'], loaded.filter((r) => r.llm.length).map((r) => { const c = r.cost ?? sumCosts(r.llm); return [`<a href="${runHref('../', r.run_id)}">${e(r.run_id)}</a>`, e(r.workflow ?? '—'), e(c.calls), e(compact(c.tokens_in)), e(compact(c.tokens_out)), e(costLine(c))]; }))}</details>` : '';
  return pipelinePage(`Trace ${itemLabel(trace.item)}`, `<h1>Work-item trace · ${e(itemLabel(trace.item))}</h1>
${nav('../', model.months)}
<p class="sub">Trace <code>${e(trace.trace_id)}</code>${trace.item?.key ? ` · <code>${e(trace.item.key)}</code>` : ''} · ${e(trace.runs.length)} run(s)</p>
<div class="tiles">
<div class="tile"><div class="label">Lead time (first start → last end)</div><div class="value">${e(formatDuration(trace.lead_time_ms))}</div></div>
<div class="tile"><div class="label">Running</div><div class="value">${e(formatDuration(running))}</div></div>
<div class="tile"><div class="label">Waiting between runs</div><div class="value">${e(formatDuration(waiting))}</div></div>
<div class="tile"><div class="label">LLM cost</div><div class="value">${e(costAmount(cost))}</div></div>
</div>
${notes.map((n) => `<p class="note">${e(n)}</p>`).join('')}
<p class="note">Runs are separate jobs on different runners: spans are placed by their own clocks, so offsets between runs are approximate (ADR-0041 §6).</p>
${costPanel}
<h2>Flow history</h2>${flowSteps(trace)}
<details class="detail-panel"><summary>Full trace · Waterfall, spans, models & tokens</summary><h2>Waterfall</h2>
${waterfall(rows, { t0: trace.first_started_at, t1: trace.last_completed_at })}</details>`, 2);
}

export function renderTraceIndex(model) {
  const body = model.traces.map((t) => {
    const last = t.runs.at(-1);
    return `<tr><td><a href="${encodeURIComponent(t.trace_id)}.html">${e(itemLabel(t.item))}</a><br><span class="muted"><code>${e(t.trace_id.slice(0, 12))}</code></span></td><td class="num">${e(t.runs.length)}${t.runs_overflow ? ` (+${e(t.runs_overflow)})` : ''}</td><td>${e(time(t.first_started_at))}</td><td>${e(time(t.last_completed_at))}</td><td class="num">${e(formatDuration(t.lead_time_ms))}</td><td>${e(last?.workflow ?? '—')}</td><td>${statusHtml(null, last?.outcome)}</td></tr>`;
  }).join('');
  return pipelinePage('Work-item traces', `<h1>Work-item traces</h1>
${nav('../', model.months)}
<p class="sub">One trace per issue (or PR without an issue): every run that touched it, from <code>metrics/traces/&lt;trace_id&gt;.json</code> (ADR-0041).</p>
${workItemBrowser(model)}
<details class="detail-panel"><summary>All trace metadata · original table</summary>${body ? `<div class="card table-wrap"><table><thead><tr><th>Work item</th><th class="num">Runs</th><th>First start</th><th>Last end</th><th class="num">Lead time</th><th>Last workflow</th><th>Last outcome</th></tr></thead><tbody>${body}</tbody></table></div>` : emptyCard('No trace index on the metrics branch yet.')}</details>`, 2);
}

// ---------------------------------------------------------------------------
// Health charts (inline SVG; every value is also in a table)
// ---------------------------------------------------------------------------

// Horizontal bar, square at the baseline (x), 4px rounded data end.
function hbarPath(x, y, w, h) {
  if (w <= 0) return '';
  const r = Math.min(4, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

// Column from the baseline (y0) up, 4px rounded top.
function colPath(x, y0, w, h, round = true) {
  if (h <= 0) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y0}V${y0 - h + r}Q${x},${y0 - h} ${x + r},${y0 - h}H${x + w - r}Q${x + w},${y0 - h} ${x + w},${y0 - h + r}V${y0}Z`;
}

/** One-series horizontal bars: rows `{ label, value, note? }`; value null → the note instead of a bar. */
export function hbars(rows, { label = 'Bar chart', max = null, format = compact } = {}) {
  if (!rows.length) return emptyCard('No data.');
  const W = 640, L = 260, R = 64, BAR = 16, GAP = 10;
  const top = Math.max(1, max ?? Math.max(...rows.map((r) => r.value ?? 0)));
  const H = rows.length * (BAR + GAP) + 4;
  const marks = rows.map((r, i) => {
    const y = 2 + i * (BAR + GAP);
    const name = `<text x="${L - 8}" y="${y + BAR - 4}" text-anchor="end" font-size="12" fill="var(--ink-2)">${e(r.label)}</text>`;
    if (r.value == null) return `<g>${name}<text x="${L}" y="${y + BAR - 4}" font-size="12" fill="var(--muted)">${e(r.note ?? 'not recorded')}</text></g>`;
    const w = ((W - L - R) * r.value) / top;
    return `<g><title>${e(`${r.label}: ${r.value}`)}</title>${name}<rect x="${L}" y="${y - GAP / 2}" width="${W - L}" height="${BAR + GAP}" fill="transparent"/><path d="${hbarPath(L, y, w, BAR)}" fill="var(--s1)"/><text x="${L + w + 6}" y="${y + BAR - 4}" font-size="12" fill="var(--ink)">${e(format(r.value))}</text></g>`;
  }).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" style="max-width:${W}px" role="img" aria-label="${e(label)}; values in the table"><line x1="${L}" x2="${L}" y1="0" y2="${H}" stroke="var(--axis)" stroke-width="1"/>${marks}</svg></div>`;
}

const table = (head, rows) => `<div class="card table-wrap"><table><thead><tr>${head.map((h) => `<th${h.num ? ' class="num"' : ''}>${e(h.label ?? h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${head[i]?.num ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const tile = (label, value, sub = '') => `<div class="tile"><div class="label">${e(label)}</div><div class="value">${e(value)}</div>${sub ? `<div class="delta">${e(sub)}</div>` : ''}</div>`;

/** Groq tokens per day, stacked by TOKEN_SERIES, against the TPD limit; eval cron days marked. */
export function tokenChart(tokens) {
  if (!tokens.days.length) return emptyCard('No Groq LLM call recorded in the window.');
  const W = 720, H = 260, L = 48, R = 12, T = 12, B = 44;
  const top = Math.max(tokens.limit, ...tokens.days.map((d) => d.total)) * 1.08;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const slot = (W - L - R) / tokens.days.length;
  const bw = Math.min(24, slot - 4);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((tokens.limit * f) / 1000) * 1000);
  const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${e(compact(v))}</text>`).join('');
  const cols = tokens.days.map((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    let base = y(0);
    const segs = TOKEN_SERIES.map((s, si) => ({ s, si, v: d.series[s] })).filter((p) => p.v > 0);
    const marks = segs.map((p, k) => {
      const h = y(0) - y(p.v);
      const path = colPath(x, base, bw, Math.max(0, h - (k ? 2 : 0)), k === segs.length - 1);
      base -= h;
      return `<path d="${path}" fill="var(${SERIES_VAR[p.si]})"/>`;
    }).join('');
    const tip = `${d.day}: ${d.total} tokens (est.)${Object.entries(d.workflows).map(([w, v]) => `, ${w} ${v}`).join('')}${d.crons.length ? ` · eval cron: ${d.crons.join(', ')}` : ''}`;
    const cron = d.crons.length ? `<text x="${x + bw / 2}" y="${H - B + 28}" text-anchor="middle" font-size="10" fill="var(--ink-2)">▲ ${e(d.crons.map((c) => c[0].toUpperCase()).join(''))}</text>` : '';
    const label = (tokens.days.length - 1 - i) % 7 === 0 ? `<text x="${x + bw / 2}" y="${H - B + 14}" text-anchor="middle" font-size="10" fill="var(--muted)">${e(d.day.slice(5))}</text>` : '';
    return `<g><title>${e(tip)}</title><rect x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>${marks}${label}${cron}</g>`;
  }).join('');
  const limit = `<line x1="${L}" x2="${W - R}" y1="${y(tokens.limit)}" y2="${y(tokens.limit)}" stroke="var(--critical)" stroke-width="1"/><text x="${W - R}" y="${y(tokens.limit) - 4}" text-anchor="end" font-size="11" fill="var(--ink-2)">${e(compact(tokens.limit))} TPD (Groq free tier)</text>`;
  const legendHtml = `<div class="legend">${TOKEN_SERIES.map((s, i) => `<span><span class="key" style="background:var(${SERIES_VAR[i]})"></span>${e(s)}</span>`).join('')}<span>▲ V / R: weekly eval cron (validation / review)</span></div>`;
  return `${legendHtml}<div class="chart"><svg viewBox="0 0 ${W} ${H}" style="max-width:${W}px" role="img" aria-label="Estimated Groq tokens per day against the 200k tokens-per-day limit; values in the table below">${grid}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>${cols}${limit}</svg></div>`;
}

/** Per item: share of the lead time spent running vs waiting between runs (100% stacked bars). */
export function criticalPathChart(items) {
  if (!items.length) return emptyCard('No work-item trace with a lead time yet.');
  const W = 640, L = 160, R = 120, BAR = 14, GAP = 10;
  const H = items.length * (BAR + GAP) + 4;
  const rows = items.map((it, i) => {
    const y = 2 + i * (BAR + GAP);
    const total = it.lead_time_ms || 1;
    const wRun = ((W - L - R) * Math.min(it.running_ms, total)) / total;
    const wWait = Math.max(0, W - L - R - wRun - (it.waiting_ms ? 2 : 0));
    return `<g><title>${e(`${itemLabel(it.item)}: lead ${formatDuration(it.lead_time_ms)}, running ${formatDuration(it.running_ms)}, waiting ${formatDuration(it.waiting_ms)}`)}</title><text x="${L - 8}" y="${y + BAR - 3}" text-anchor="end" font-size="12" fill="var(--ink-2)">${e(itemLabel(it.item))}</text><rect x="${L}" y="${y}" width="${wRun.toFixed(2)}" height="${BAR}" fill="var(--s1)"/>${it.waiting_ms ? `<path d="${hbarPath(L + wRun + 2, y, wWait, BAR)}" fill="var(--axis)"/>` : ''}<text x="${W - R + 8}" y="${y + BAR - 3}" font-size="12" fill="var(--ink)">${e(formatDuration(it.lead_time_ms))}</text></g>`;
  }).join('');
  return `<div class="legend"><span><span class="key" style="background:var(--s1)"></span>running</span><span><span class="key" style="background:var(--axis)"></span>waiting between runs</span></div><div class="chart"><svg viewBox="0 0 ${W} ${H}" style="max-width:${W}px" role="img" aria-label="Share of each work item's lead time spent running versus waiting; values in the table">${rows}</svg></div>`;
}

export function renderHealth(health, model) {
  const { funnel, reviews, autofix, llm, latency, critical_path: cp, tokens, costs } = health;
  const funnelRows = funnel.stages.map((s) => ({ label: s.stage, value: s.count, note: 'not recorded — no workflow journals a merge' }));
  const causes = reviews.causes.filter((c) => c.count > 0);
  const autofixRows = [
    { label: 'Pushed a fix', value: autofix.push }, { label: 'No-op (no changes)', value: autofix.no_op },
    { label: 'Guardrail rejected', value: autofix.guardrail_rejected }, { label: 'Max attempts reached', value: autofix.max_attempts },
    { label: 'Skipped: head already approved', value: autofix.approved_skip }, { label: 'Error', value: autofix.error },
    { label: 'Other skip', value: autofix.other_skip },
  ];
  const tokenTable = tokens.days.filter((d) => d.total > 0 || d.crons.length).map((d) => [e(d.day), ...tokens.workflows.map((w) => e(compact(d.workflows[w] ?? 0))), e(compact(d.total)), e(pct(d.total / tokens.limit)), e(d.crons.join(', ') || '—')]);
  const cpSorted = [...cp].sort((a, b) => b.lead_time_ms - a.lead_time_ms).slice(0, 25);
  const body = `<h1>Pipeline health</h1>
${nav('', model.months)}
<p class="sub">${e(health.window.runs)} run record(s), ${e(health.window.traces)} work-item trace(s)${health.window.months.length ? `, ${e(health.window.months.at(-1))} → ${e(health.window.months[0])}` : ''}. Token counts are provider-measured where the record has them (ADR-0041 amendment), chars/4 estimates for older records.</p>

${costPanel(costs)}

<details class="detail-panel" open><summary>Delivery funnel · progress through the loop</summary><h2>Funnel</h2>
<p class="sub">Issue work items that reached each stage (each stage counts items that also reached the previous one). PRs without an issue: ${e(funnel.pr_items.total)}, ${e(funnel.pr_items.approved)} approved.</p>
${hbars(funnelRows, { label: 'Funnel: issues validated, PR opened, approved, merged' })}
${table(['Stage', { label: 'Work items', num: true }], funnel.stages.map((s) => [e(s.stage), e(s.count ?? 'not recorded')]))}</details>

<details class="detail-panel" open><summary>Review decisions · approvals & changes needed</summary><h2>Reviews</h2>
<div class="tiles">${tile('WITHHELD rate', pct(reviews.withheld_rate), `${reviews.verdicts.WITHHELD} of ${reviews.total} verdicts`)}${tile('APPROVE', compact(reviews.verdicts.APPROVE))}${tile('REQUEST_CHANGES', compact(reviews.verdicts.REQUEST_CHANGES))}${tile('REQUEST_CHANGES → WITHHELD (#220)', compact(reviews.rc_to_withheld), 'unseen-code backstop')}${tile('Reviews of a cut diff', compact(reviews.diff_cut.reviews), `${reviews.diff_cut.withheld} withheld (ADR-0038)`)}</div>
<h3>WITHHELD causes</h3>
${causes.length ? hbars(causes.map((c) => ({ label: c.label.length > 40 ? `${c.label.slice(0, 39)}…` : c.label, value: c.count })), { label: 'WITHHELD verdicts by cause' }) : ''}
${table(['Cause', { label: 'Verdicts', num: true }], reviews.causes.map((c) => [e(c.label), e(c.count)]))}
<h3>Review cycles per PR</h3>
${hbars(reviews.cycles_distribution.map((d) => ({ label: `${d.cycles} cycle${d.cycles > 1 ? 's' : ''}`, value: d.prs })), { label: 'Number of PRs by review cycles' })}
${table(['PR', { label: 'Review cycles', num: true }], reviews.cycles_per_pr.slice(0, 30).map((r) => [`#${e(r.pr)}`, e(r.cycles)]))}</details>

<details class="detail-panel"><summary>Auto-fix outcomes · fixes, skips & guardrails</summary><h2>Auto-fix outcomes</h2>
${hbars(autofixRows, { label: 'Auto-fix attempts by outcome' })}
${table(['Guardrail rule', { label: 'Rejections', num: true }], autofix.rules.map((r) => [`<code>${e(r.rule)}</code>`, e(r.count)]))}
${autofix.legacy_counted ? `<p class="note">${e(autofix.legacy_counted)} outcome(s) from legacy <code>runs.jsonl</code> lines whose run has no record.</p>` : ''}</details>

<details class="detail-panel"><summary>Providers · failures, fallbacks & rate limits</summary><h2>LLM providers</h2>
<div class="tiles">${tile('LLM calls', compact(llm.calls))}${tile('Fallbacks', compact(llm.fallbacks), 'llm_fallback')}${tile('No provider answered', compact(llm.failed), 'llm_call_failed')}${tile('Fallback disabled', compact(llm.fallback_disabled))}${tile('Rate-limit waits', compact(llm.rate_limit_waits), 'retry.wait on 429')}${tile('Circuit-breaker trips', 'not recorded', 'eval runs only, see note')}</div>
<p class="note">The circuit breaker is an eval-harness mechanism: a tripped eval run fails <code>error_rate</code>, is never added to the scorecard, and eval traces stay workflow artifacts (no record on the <code>metrics</code> branch). Its trips are in the Evals workflow logs (<code>eval.error</code>, <code>reason: provider_quota</code>).</p>

</details><details class="detail-panel"><summary>Performance · latency & critical path</summary><h2>Latency per stage</h2>
${latency.length ? table(['Stage', { label: 'Runs', num: true }, { label: 'p50', num: true }, { label: 'p95', num: true }], latency.map((l) => [`<code>${e(l.stage)}</code>`, e(l.n), e(formatDuration(l.p50)), e(formatDuration(l.p95))])) : emptyCard('No stage span recorded.')}

<h2>Critical path per work item</h2>
<p class="sub">Lead time (first start → last end) split into time spent in runs and time between them; runner clocks differ, so this is approximate (ADR-0041 §6). Longest 25.</p>
${criticalPathChart(cpSorted)}
${table(['Work item', { label: 'Runs', num: true }, { label: 'Lead time', num: true }, { label: 'Running', num: true }, { label: 'Waiting', num: true }], cpSorted.map((c) => [`<a href="${traceHref('', c.trace_id)}">${e(itemLabel(c.item))}</a>`, e(c.runs), e(formatDuration(c.lead_time_ms)), e(formatDuration(c.running_ms)), e(formatDuration(c.waiting_ms))]))}

</details><details class="detail-panel"><summary>Token usage · daily estimates & quotas</summary><h2>Groq tokens per day</h2>
<p class="sub">Estimated tokens (in + out) of Groq calls per UTC day over ${e(tokens.days.length)} days, pipeline runs by workflow and eval runs from the scorecard, against the ${e(compact(tokens.limit))} tokens-per-day free-tier limit. Groq counts real tokens and its prompt cache: the estimate is an approximation.</p>
${tokenChart(tokens)}
${tokenTable.length ? table(['Day', ...tokens.workflows, { label: 'Total', num: true }, { label: '% of TPD', num: true }, 'Eval cron'], tokenTable) : ''}</details>`;
  return pipelinePage('Pipeline health', body, 1);
}

// A mean is shown only when the group has a priced call; otherwise it would read as a $0 cost.
const perRun = (g) => (g.measured + g.estimated ? formatUsd(g.per_run_usd) : '—');
const costRow = (label, g, extra = []) => [label, ...extra, e(g.calls), e(compact(g.tokens_in)), e(compact(g.cache_read)), e(compact(g.tokens_out)), e(costLine(g))];
const COST_COLS = [{ label: 'Calls', num: true }, { label: 'Input', num: true }, { label: 'Cache reads', num: true }, { label: 'Output', num: true }, 'Cost'];

/** Health panel: LLM cost of the window per stage, workflow, day, and the most expensive runs / work items. */
export function costPanel(costs) {
  if (!costs?.total.calls) return `<details class="detail-panel" open><summary>LLM cost · per stage, run & work item</summary>${emptyCard('No LLM call recorded in the window.')}</details>`;
  const t = costs.total;
  const priced = t.measured + t.estimated > 0;
  const extra = [['Mean per run', priced && costs.runs ? formatUsd(t.usd / costs.runs) : '—'], ['Mean per work item', priced && costs.items ? formatUsd(costs.items_usd / costs.items) : '—']];
  const stages = costs.by_stage.filter((g) => g.usd > 0);
  return `<details class="detail-panel" open><summary>LLM cost · per stage, run & work item</summary><h2>LLM cost</h2>
<div class="tiles">${costTiles(t, extra)}</div>
<p class="sub">${costSub(t)} The mean per work item counts work items with a trace index only.</p>
<h3>Per stage</h3>
${stages.length ? hbars(stages.map((g) => ({ label: g.key, value: g.usd })), { label: 'LLM cost in USD per pipeline stage', format: formatUsd }) : ''}
${table([{ label: 'Stage' }, { label: 'Runs', num: true }, ...COST_COLS, { label: 'Per run', num: true }], costs.by_stage.map((g) => [...costRow(`<code>${e(g.key)}</code>`, g, [e(g.runs)]), e(perRun(g))]))}
<h3>Per workflow</h3>
${table([{ label: 'Workflow' }, { label: 'Runs', num: true }, ...COST_COLS, { label: 'Per run', num: true }], costs.by_workflow.map((g) => [...costRow(e(g.key), g, [e(g.runs)]), e(perRun(g))]))}
<h3>Most expensive runs</h3>
${table([{ label: 'Run' }, 'Workflow', 'Work item', ...COST_COLS], costs.top_runs.map((r) => costRow(`<a href="${runHref('', r.run_id)}">${e(r.run_id)}</a><br><span class="muted">${e(time(r.started_at))}</span>`, r, [e(r.workflow ?? '—'), e(itemLabel(r.item))])))}
<h3>Most expensive work items</h3>
${costs.top_items.length ? table([{ label: 'Work item' }, { label: 'Runs', num: true }, ...COST_COLS], costs.top_items.map((it) => costRow(`<a href="${traceHref('', it.trace_id)}">${e(itemLabel(it.item))}</a>`, it, [e(it.runs)]))) : emptyCard('No work-item trace with an LLM call.')}
<h3>Per day (UTC)</h3>
${table([{ label: 'Day' }, { label: 'Runs', num: true }, ...COST_COLS], costs.by_day.slice().reverse().map((g) => costRow(e(g.key), g, [e(g.runs)])))}</details>`;
}

// ---------------------------------------------------------------------------
// provider:model cross-links (eval runs ↔ pipeline runs)
// ---------------------------------------------------------------------------

export function renderModels(models, model) {
  const seen = new Set();
  const sections = models.map((m) => {
    // Anchors are per model (the eval pages know no provider): two providers of one model share it, and
    // the cross-links land on the first.
    const anchor = modelAnchor(m.model);
    const id = seen.has(anchor) ? '' : ` id="${anchor}"`;
    seen.add(anchor);
    const runs = m.runs.map((r) => `<a href="${runHref('', r)}">${e(r)}</a>`).join(', ');
    const evals = m.evals.map((ev) => `<a href="../runs/${encodeURIComponent(ev.run_id)}.html">${e(ev.suite)} ${e(ev.run_id)}</a> ${ev.passed ? '<span class="ok">✓</span>' : '<span class="ko">✕</span>'}`).join(', ');
    return `<section${id}><h2><code>${e(m.key)}</code></h2>
<div class="tiles">${tile('Pipeline LLM calls', compact(m.calls))}${tile('Failed', compact(m.failed))}${tile('Fallback answers', compact(m.fallback))}${tile('Tokens', compact(m.tokens))}${tile('LLM cost', costAmount(m.cost ?? sumCosts([])), m.unpriced ? `${m.unpriced} unpriced call(s)` : '')}${tile('Eval runs', compact(m.evals.length))}</div>
<p class="sub">Pipeline runs: ${runs || '<span class="muted">none in the window</span>'}</p>
<p class="sub">Eval runs: ${evals || '<span class="muted">none on the scorecard</span>'}</p></section>`;
  }).join('\n');
  return pipelinePage('Models', `<h1>Models</h1>
${nav('', model.months)}
<p class="sub">Every provider:model of the pipeline's LLM calls and of the eval scorecard: how a model scores on the datasets next to how it behaves in production. Eval runs record the model only; the provider is inferred (<code>claude-*</code> → anthropic, else groq).</p>
${sections || emptyCard('No LLM call or eval run recorded yet.')}`, 1);
}

/**
 * Every pipeline page: `{ 'pipeline/…': html }`. `model` from buildPipelineModel(), `health` from
 * computeHealth(), `models` from modelUsage().
 */
export function buildPipelineSite({ model, health, models, generatedAt = null }) {
  const files = {
    'pipeline/flows.html': pipelinePage('Flow map', flowDashboard(model) + FLOW_SCRIPT, 1).replace('</style>', FLOW_STYLE + '</style>'),
    'pipeline/index.html': renderFeedIndex(model, { generatedAt }),
    'pipeline/traces/index.html': renderTraceIndex(model),
    'pipeline/health.html': renderHealth(health, model),
    'pipeline/models.html': renderModels(models, model),
  };
  for (const month of model.months) files[`pipeline/feed/${month}.html`] = renderFeedMonth(model, month);
  for (const run of model.runs) files[`pipeline/runs/${run.run_id}.html`] = renderRunPage(run, model);
  for (const trace of model.traces) files[`pipeline/traces/${trace.trace_id}.html`] = renderTracePage(trace, model);
  return files;
}

