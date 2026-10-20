// System overview, the dashboard home (ADR-0043): status, four windowed indicators with their change and a
// sparkline, results / duration / provider charts, the problems that need attention and the recent
// pipelines. Windows (7 / 14 / 30 days, pipeline_kpis.mjs) are all rendered; a select shows one. Pure.
import { escapeHtml as e } from './eval_site.mjs';
import { costAmount, costBasis, formatUsd } from './llm_cost.mjs';
import { DEFINITIONS, WINDOWS, RUN_CLASSES } from './pipeline_kpis.mjs';
import { toneMark, pill, trendChart, definitionsPanel, duration } from './console_views.mjs';
import { pipelineList, FLOW_SCRIPT } from './flow_dashboard.mjs';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)} %`);
const SEVERITY_TONE = { critical: 'bad', warning: 'warn', info: 'neutral' };
const STATUS = {
  critical: ['bad', 'Attention needed', (n) => `${n} critical problem(s)`],
  warning: ['warn', 'Running with issues', (n) => `${n} problem(s) to look at`],
  ok: ['good', 'No problem detected', () => 'by the rules — not proof of health'],
  no_data: ['unknown', 'No data', () => 'no pipeline run recorded yet'],
};

/** The status badge of the page head: the diagnostic status, never a claim the rules cannot make. */
export function statusBadge(d, root) {
  const [tone, title, sub] = STATUS[d.status];
  const n = d.status === 'critical' ? d.findings.filter((f) => f.severity === 'critical').length : d.findings.filter((f) => f.severity !== 'info').length;
  return `<a class="status-badge tone-${tone}" href="${root}diagnostics.html">${toneMark(tone)}<span><strong>${e(title)}</strong><small>${e(sub(n))}</small></span></a>`;
}

/**
 * Change of a value against the previous window: `{ text, tone }`. `better` is the direction that is good
 * (`up`, `down` or null for neutral); `points` compares rates in percentage points. No previous value: said.
 */
export function delta(cur, prev, { better = null, points = false, days = 7 } = {}) {
  if (cur == null || prev == null || (!points && prev === 0)) return { text: `no prior ${days} d data`, tone: 'unknown', arrow: '' };
  const d = points ? (cur - prev) * 100 : ((cur - prev) / prev) * 100;
  const r = Math.round(d);
  if (r === 0) return { text: `= vs prior ${days} d`, tone: 'neutral', arrow: '' };
  const up = r > 0;
  const tone = better == null ? 'neutral' : (up === (better === 'up')) ? 'good' : 'bad';
  return { text: `${up ? '+' : ''}${r}${points ? ' pts' : ' %'} vs prior ${days} d`, tone, arrow: up ? '↑' : '↓' };
}

/** Sparkline of a series (nulls are gaps), area under the line; a flat or empty series stays flat. */
export function sparkline(values, { tone = 'neutral', label = '' } = {}) {
  const W = 200, H = 44;
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(label)}: not enough data for a trend"><line x1="0" x2="${W}" y1="${H - 2}" y2="${H - 2}" stroke="var(--axis)" stroke-dasharray="3 3"/></svg>`;
  const max = Math.max(...pts.map(([, v]) => v)), min = Math.min(0, ...pts.map(([, v]) => v));
  const x = (i) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v) => H - 3 - ((v - min) / ((max - min) || 1)) * (H - 8);
  // Contiguous runs of values: a null is a gap, never bridged by the line or the area.
  const segments = [];
  values.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { if (segments.at(-1)?.length) segments.push([]); return; }
    if (!segments.length) segments.push([]);
    segments.at(-1).push([i, v]);
  });
  const marks = segments.filter((seg) => seg.length).map((seg) => {
    if (seg.length === 1) return `<circle cx="${x(seg[0][0]).toFixed(1)}" cy="${y(seg[0][1]).toFixed(1)}" r="2.5" fill="var(--tone)"/>`;
    const line = seg.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<polygon points="${x(seg[0][0]).toFixed(1)},${H} ${line} ${x(seg.at(-1)[0]).toFixed(1)},${H}" fill="var(--tone)" opacity=".14"/><polyline points="${line}" fill="none" stroke="var(--tone)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return `<svg class="spark tone-${tone}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${e(label)}">${marks}</svg>`;
}

const ICON = {
  runs: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  rate: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  time: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  cost: '<path d="M12 4v16M16 8c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 2.6 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3"/>',
};
const icon = (k) => `<span class="kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg></span>`;

function kpi({ id, ic, href, value, change, note, visual, tone = 'neutral' }) {
  return `<a class="kpi2 tone-${tone}" href="${e(href)}" data-kpi="${id}">${icon(ic)}<span class="kpi-body"><span class="kpi-label">${e(DEFINITIONS[id].label)}</span><span class="kpi-row"><strong class="kpi-value">${e(value)}</strong><span class="kpi-delta tone-${change.tone}">${e(change.arrow)} ${e(change.text)}</span></span></span>${visual}<span class="kpi-note">${note}</span></a>`;
}

const CLASS_TONE = { failed: 'bad', adverse: 'warn', progressed: 'good', neutral: 'unknown' };
const CLASS_LABEL = { failed: 'failed', adverse: 'adverse', progressed: 'moved forward', neutral: 'no decision' };

function segments(c) {
  const total = RUN_CLASSES.reduce((n, k) => n + c[k], 0);
  if (!total) return '<span class="segbar"></span>';
  return `<span class="segbar" role="img" aria-label="${e(RUN_CLASSES.map((k) => `${CLASS_LABEL[k]} ${c[k]}`).join(', '))}">${['progressed', 'adverse', 'failed', 'neutral'].filter((k) => c[k]).map((k) => `<span class="tone-${CLASS_TONE[k]}" style="width:${((c[k] / total) * 100).toFixed(2)}%"></span>`).join('')}</span>`;
}

// A cost is comparable only when every call is priced or free: an unpriced call makes the sum a lower bound.
const comparableCost = (sum) => sum.calls > 0 && !sum.unpriced;

/** The four indicators of one window. root: path to pipeline/. */
export function kpiRow(w, root, hasWithheld) {
  const c = w.current, p = w.previous;
  const prevRuns = p.runs || null;
  const has = (s) => s.verdicts > 0;
  const cards = [
    kpi({ id: 'executions', ic: 'runs', href: `${root}index.html#executions`, value: String(c.runs), change: delta(c.runs, prevRuns, { days: w.days }), visual: segments(c), note: `<span class="tone-good">${e(c.progressed)} moved forward</span> · <span class="tone-warn">${e(c.adverse)} adverse</span> · <span class="tone-bad">${e(c.failed)} failed</span> · ${e(c.neutral)} no decision`, tone: c.failed ? 'bad' : 'neutral' }),
    kpi({ id: 'approve_rate', ic: 'rate', href: hasWithheld ? `${root}diagnostics.html#review-withheld` : `${root}health.html#reviews`, value: pct(c.approve_rate), change: delta(c.approve_rate, has(p) ? p.approve_rate : null, { better: 'up', points: true, days: w.days }), visual: sparkline(w.series.map((s) => s.approve_rate), { tone: 'good', label: 'Approval rate per day' }), note: c.verdicts ? `${e(c.approve)} of ${e(c.verdicts)} verdicts · ${e(c.withheld)} withheld · ${e(c.request_changes)} changes requested` : 'No verdict recorded in the window', tone: c.approve_rate == null ? 'unknown' : c.approve_rate < 0.5 ? 'warn' : 'good' }),
    kpi({ id: 'run_duration', ic: 'time', href: `${root}health.html#performance`, value: duration(c.duration.mean), change: delta(c.duration.mean, p.duration.mean, { better: 'down', days: w.days }), visual: sparkline(w.series.map((s) => s.avg_ms), { tone: 'accent', label: 'Average run duration per day' }), note: c.duration.n ? `p95 ${e(duration(c.duration.p95))} · ${e(c.duration.n)} run(s)` : 'No timed run in the window', tone: 'neutral' }),
    kpi({ id: 'llm_cost', ic: 'cost', href: `${root}health.html#cost`, value: costAmount(c.cost), change: comparableCost(c.cost) && comparableCost(p.cost) ? delta(c.cost.usd, p.cost.usd, { better: 'down', days: w.days }) : { text: c.cost.unpriced || p.cost.unpriced ? 'no change: unpriced calls make a side incomplete' : `no prior ${w.days} d data`, tone: 'unknown', arrow: '' }, visual: sparkline(w.series.map((s) => s.usd), { tone: 'info', label: 'LLM cost per day' }), note: c.cost.calls ? `${e(c.cost.calls)} call(s) · ${e(costBasis(c.cost) ?? (c.cost.free === c.cost.calls ? 'free tier only' : 'no priced call'))}${c.cost.unpriced ? ` · ${e(c.cost.unpriced)} unpriced, not counted` : ''} · list price` : 'No LLM call in the window', tone: 'neutral' }),
  ];
  return `<div class="kpi-grid4">${cards.join('')}</div>`;
}

/** Average and p95 run duration per day (inline SVG; values in a table). */
export function durationChart(series) {
  const pts = series.filter((s) => s.avg_ms != null);
  if (!pts.length) return '<p class="muted">No timed run in the window.</p>';
  const W = 380, H = 210, L = 44, R = 8, T = 10, B = 24;
  const top = Math.max(...series.map((s) => s.p95_ms ?? 0), 1000);
  const x = (i) => L + (series.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (series.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const path = (key) => series.map((s, i) => (s[key] == null ? null : `${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`)).filter(Boolean).join(' ');
  const dots = (key, cls) => series.map((s, i) => (s[key] == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(s[key]).toFixed(1)}" r="3" class="${cls}"><title>${e(`${s.day}: ${key === 'avg_ms' ? 'average' : 'p95'} ${duration(s[key])}`)}</title></circle>`)).join('');
  const ticks = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W - R}" y1="${y(top * f)}" y2="${y(top * f)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(top * f) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${e(duration(top * f))}</text>`).join('');
  const labels = series.map((s, i) => (i % Math.ceil(series.length / 7) === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${e(s.day.slice(5))}</text>` : '')).join('');
  const rows = series.filter((s) => s.avg_ms != null).map((s) => `<tr><td>${e(s.day)}</td><td class="num">${e(duration(s.avg_ms))}</td><td class="num">${e(duration(s.p95_ms))}</td></tr>`).join('');
  return `<div class="legend"><span><i class="line-key accent"></i>Average</span><span><i class="line-key dashed"></i>p95</span></div><div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average and p95 run duration per day; values in the table">${ticks}<polyline points="${path('p95_ms')}" fill="none" stroke="var(--link)" stroke-width="1.6" stroke-dasharray="4 4"/><polyline points="${path('avg_ms')}" fill="none" stroke="var(--accent)" stroke-width="2.2"/>${dots('avg_ms', 'dot-accent')}${labels}</svg></div><details><summary>Values</summary><div class="table-wrap"><table><thead><tr><th>Day</th><th class="num">Average</th><th class="num">p95</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

/** LLM providers of the window: cost and calls, with their shares. */
// A provider's amount: free tier, unpriced, a lower bound (≥) when some of its calls are unpriced, or exact.
const providerAmount = (p) => {
  if (p.free === p.calls) return 'free tier';
  if (!p.measured && !p.estimated) return 'unpriced';
  return `${p.unpriced ? '≥ ' : ''}${formatUsd(p.usd)}`;
};

export function providerList(providers) {
  if (!providers.length) return '<p class="muted">No LLM call in the window.</p>';
  return `<ol class="provider-list">${providers.map((p, i) => `<li><span class="rank">${i + 1}</span><span class="pname">${e(p.provider)}</span><span class="pcost">${e(providerAmount(p))}</span><span class="pshare">${e(p.usd_share == null ? '—' : pct(p.usd_share))}</span><span class="pbar" role="img" aria-label="${e(`${pct(p.usd_share)} of cost, ${pct(p.call_share)} of calls`)}"><span style="width:${((p.usd_share ?? 0) * 100).toFixed(1)}%"></span></span><span class="pcalls muted">${e(p.calls)} call(s) · ${e(pct(p.call_share))} of calls</span></li>`).join('')}</ol>`;
}

function windowBlock(w, root, hasWithheld, hidden) {
  const body = w.empty
    ? '<div class="panel"><p>No pipeline run recorded yet: no indicator to compute.</p></div>'
    : `${kpiRow(w, root, hasWithheld)}<div class="chart-grid"><section class="panel"><h3>Pipeline results <a href="${root}index.html#executions">Executions →</a></h3>${trendChart({ days: w.series }, { W: 380, H: 210 })}</section><section class="panel"><h3>Duration trend <a href="${root}health.html#performance">Metrics →</a></h3>${durationChart(w.series)}</section><section class="panel"><h3>LLM providers (cost) <a href="${root}models.html">Models →</a></h3>${providerList(w.providers)}<p class="trend-note">List price, never a bill; Groq free tier at $0.${w.providers.some((p) => p.unpriced) ? ' Some calls are unpriced: amounts marked ≥ are lower bounds and cost shares are not shown.' : ''}</p></section></div>`;
  return `<div data-window="${w.days}"${hidden ? ' hidden' : ''}>${body}</div>`;
}

/** Problems that need attention: the top findings as cards. */
export function issueCards(d, root, limit = 3) {
  const cards = d.findings.slice(0, limit).map((f) => {
    const since = f.evidence.map((x) => x.ts).filter((t) => typeof t === 'number');
    return `<a class="issue-card tone-${SEVERITY_TONE[f.severity]}" href="${root}diagnostics.html#${e(f.id)}"><span class="issue-head">${toneMark(SEVERITY_TONE[f.severity])}<strong>${e(f.title)}</strong>${pill(SEVERITY_TONE[f.severity], f.severity)}</span><span class="issue-text">${e(f.impact)}</span><span class="issue-meta"><span>Affects ${e(f.runs.length)} run(s)</span>${since.length ? `<span>Since: <span data-ts="${Math.min(...since)}">${e(new Date(Math.min(...since)).toISOString().slice(0, 10))}</span></span>` : ''}</span></a>`;
  }).join('');
  return `<section class="panel attention-panel tone-${d.findings.length ? SEVERITY_TONE[d.findings[0].severity] : 'unknown'}"><h3><span>Issues requiring attention <small class="muted">${e(d.findings.length)} detected over the retained window</small></span><a href="${root}diagnostics.html">View all →</a></h3>${cards ? `<div class="issue-grid">${cards}</div>` : `<p class="muted">No rule fired on the recorded data (${e(d.gaps.length)} data gap(s): not proof of health).</p>`}</section>`;
}

function secondary(o, root) {
  const items = [
    ['Waiting on a person', `${o.items.needs_attention} / ${o.window.items}`, `${root}flows.html?state=attention`, 'last recorded state; merges are re-checked on Pipelines'],
    ['Steps recovered automatically', o.recovery.troubled ? `${o.recovery.recovered} / ${o.recovery.troubled}` : '—', `${root}flows.html?problem=any`, 'final attempt moved forward after a failed or adverse one'],
    ['Lead time per work item', o.lead_time.n ? `${duration(o.lead_time.p50)} · p90 ${duration(o.lead_time.p90)}` : '—', `${root}health.html#performance`, `${pct(o.running_share.value)} of it running`],
    ['Waiting on rate limits', o.rate_limit_wait.waits ? duration(o.rate_limit_wait.ms) : '—', `${root}diagnostics.html#rate-limit-waits`, `${o.rate_limit_wait.waits} retry wait(s) on HTTP 429`],
  ];
  return `<div class="mini-stats">${items.map(([l, v, h, n]) => `<a href="${e(h)}" title="${e(n)}"><span>${e(l)}</span><strong>${e(v)}</strong></a>`).join('')}</div>`;
}

/** The overview: `ctx` from consoleContext(), `root` the path to pipeline/ ('pipeline/' on the home page). */
export function consoleOverview(ctx, root = '') {
  const { diagnosis: d, overview: o, windows } = ctx;
  const hasWithheld = d.findings.some((f) => f.id === 'review-withheld');
  const range = `<label class="range-select">Range <select data-range>${WINDOWS.map((n) => `<option value="${n}">Last ${n} days</option>`).join('')}</select></label>`;
  const recent = [...ctx.traces].sort((a, b) => (b.last_completed_at ?? 0) - (a.last_completed_at ?? 0));
  const toolbar = `<div class="section-intro"><div><h2>Recent pipelines</h2><p>Latest work items and their status. Open a row for its stages, attempts and key information.</p></div><div class="toolbar-inline"><input type="search" data-filter-key="q" placeholder="Search by issue, PR, workflow…" aria-label="Search recent pipelines"><select data-filter-key="state" aria-label="Status"><option value="">All status</option><option value="attention">Needs a person</option><option value="withheld">Approval withheld</option><option value="escalated">Escalated</option><option value="approved">Approved</option><option value="failed">Failed</option><option value="merged">Merged (live)</option></select><a class="button-link" href="${root}flows.html">View all →</a></div></div>`;
  return `<section class="console" aria-label="System overview">
<div class="page-head"><div><h1>System overview</h1><p class="sub">What the recorded runs say about the pipeline. Windows end on the latest recorded run (${e(o.window.to ? new Date(o.window.to).toISOString().slice(0, 16).replace('T', ' ') : '—')} UTC).</p></div><div class="head-tools">${range}${statusBadge(d, root)}</div></div>
${WINDOWS.map((n, i) => windowBlock(windows[n], root, hasWithheld, i > 0)).join('')}
${secondary(o, root)}
${issueCards(d, root)}
${pipelineList(recent, { root, limit: 10, toolbar })}
${definitionsPanel()}
</section>${FLOW_SCRIPT}${RANGE_SCRIPT}`;
}

// The range select shows one precomputed window; the choice is kept in the URL (?range=14).
const RANGE_SCRIPT = `<script>
(() => {
 const pick = document.querySelector('[data-range]'); if (!pick) return;
 const blocks = [...document.querySelectorAll('[data-window]')];
 const v = new URLSearchParams(location.search).get('range');
 if ([...pick.options].some(o => o.value === v)) pick.value = v;
 const show = () => { for (const b of blocks) b.hidden = b.dataset.window !== pick.value; const p = new URLSearchParams(location.search); p.set('range', pick.value); try { history.replaceState(null, '', location.pathname + '?' + p + location.hash); } catch {} };
 pick.addEventListener('change', show); show();
})();
</script>`;

export const OVERVIEW_STYLE = `
.head-tools { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.range-select { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); }
.status-badge { display:flex; align-items:center; gap:10px; padding:9px 14px; border:1px solid var(--tone); border-radius:10px; background:color-mix(in srgb, var(--tone) 12%, var(--surface)); color:var(--ink); text-decoration:none; }
.status-badge strong { display:block; color:var(--tone); font-size:14px; } .status-badge small { color:var(--ink-2); font-size:11.5px; }
.kpi-grid4 { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin:18px 0; }
.kpi2 { display:grid; grid-template-columns:auto 1fr; grid-template-areas:'icon body' 'visual visual' 'note note'; gap:8px 12px; padding:16px; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--ink); text-decoration:none; min-width:0; }
.kpi2:hover { border-color:var(--accent); }
.kpi-icon { grid-area:icon; display:grid; place-items:center; width:38px; height:38px; border-radius:10px; background:var(--accent-soft); color:var(--accent); }
.kpi2.tone-bad .kpi-icon { background:var(--bad-bg); color:var(--critical); } .kpi2.tone-warn .kpi-icon { background:var(--warn-bg); color:var(--warn-ink); } .kpi2.tone-good .kpi-icon { background:var(--good-bg); color:var(--good); }
.kpi-icon svg { width:20px; height:20px; }
.kpi-body { grid-area:body; display:grid; gap:2px; min-width:0; }
.kpi2 .kpi-label { font-size:12.5px; color:var(--ink-2); font-weight:600; text-transform:none; letter-spacing:0; }
.kpi-row { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.kpi2 .kpi-value { font-size:28px; font-weight:750; letter-spacing:-.8px; line-height:1.1; font-variant-numeric:tabular-nums; }
.kpi-delta { font-size:11.5px; font-weight:650; color:var(--tone); }
.kpi-delta.tone-unknown,.kpi-delta.tone-neutral { color:var(--muted); font-weight:500; }
.kpi2 .spark, .kpi2 .segbar { grid-area:visual; }
.kpi2 .kpi-note { grid-area:note; font-size:11.5px; color:var(--muted); }
.spark { width:100%; height:44px; display:block; } .spark.tone-accent { --tone:var(--accent); } .spark.tone-info { --tone:var(--link); }
.segbar { display:flex; height:8px; margin-top:14px; border-radius:4px; overflow:hidden; background:var(--grid); gap:2px; }
.segbar span { background:var(--tone); }
.chart-grid { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1.15fr) minmax(0,1fr); gap:14px; }
.chart-grid .panel { margin:0; }
.line-key { display:inline-block; width:16px; height:0; border-top:2px solid var(--accent); vertical-align:middle; margin-right:6px; } .line-key.dashed { border-top:2px dashed var(--link); }
.dot-accent { fill:var(--accent); stroke:var(--surface); stroke-width:1.5; }
.provider-list { list-style:none; padding:0; margin:0; display:grid; gap:12px; }
.provider-list li { display:grid; grid-template-columns:22px 1fr auto 44px; grid-template-areas:'rank name cost share' 'rank bar bar bar' 'rank calls calls calls'; gap:3px 10px; align-items:center; font-size:13px; }
.rank { grid-area:rank; display:grid; place-items:center; width:22px; height:22px; border-radius:50%; background:var(--accent-soft); color:var(--accent); font-size:11px; font-weight:700; }
.pname { grid-area:name; font-weight:650; } .pcost { grid-area:cost; font-variant-numeric:tabular-nums; } .pshare { grid-area:share; text-align:right; color:var(--muted); font-size:12px; }
.pbar { grid-area:bar; height:6px; border-radius:3px; background:var(--grid); overflow:hidden; } .pbar span { display:block; height:100%; background:var(--link); }
.pcalls { grid-area:calls; font-size:11.5px; }
.mini-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; margin:14px 0; border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; background:var(--border); }
.mini-stats a { display:grid; gap:2px; padding:10px 14px; background:var(--surface); color:var(--ink); text-decoration:none; }
.mini-stats a:hover { background:var(--surface-2); }
.mini-stats span { font-size:11.5px; color:var(--muted); } .mini-stats strong { font-size:15px; font-variant-numeric:tabular-nums; }
.attention-panel { border-color:color-mix(in srgb, var(--tone) 45%, var(--border)); background:linear-gradient(180deg, color-mix(in srgb, var(--tone) 7%, var(--surface)), var(--surface)); }
.attention-panel h3 small { display:block; font-weight:500; font-size:12px; margin-top:2px; }
.issue-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.issue-card { display:grid; gap:8px; padding:14px; border:1px solid color-mix(in srgb, var(--tone) 40%, var(--border)); border-radius:10px; background:var(--surface); color:var(--ink); text-decoration:none; }
.issue-card:hover { border-color:var(--tone); }
.issue-head { display:flex; gap:8px; align-items:center; } .issue-head strong { flex:1; font-size:14px; }
.issue-text { font-size:12.5px; color:var(--ink-2); }
.issue-meta { display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); }
.toolbar-inline { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.toolbar-inline input { min-width:220px; }
@media(max-width:1250px) { .kpi-grid4 { grid-template-columns:repeat(2,minmax(0,1fr)); } .chart-grid { grid-template-columns:1fr 1fr; } .chart-grid .panel:last-child { grid-column:1 / -1; } }
@media(max-width:760px) { .chart-grid,.issue-grid { grid-template-columns:1fr; } .mini-stats { grid-template-columns:1fr 1fr; } .head-tools { width:100%; justify-content:space-between; } .toolbar-inline input { min-width:0; flex:1; } }
@media(max-width:600px) { .kpi-grid4 { grid-template-columns:1fr 1fr; gap:10px; } .kpi2 { grid-template-columns:1fr; grid-template-areas:'body' 'visual' 'note'; padding:12px; } .kpi-icon { display:none; } .kpi2 .kpi-value { font-size:22px; } .kpi2 .kpi-note { display:none; } }
`;

