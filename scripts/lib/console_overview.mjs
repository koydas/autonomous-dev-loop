// System overview, the dashboard home (ADR-0043 amendments 2026-10-24 and 2026-10-28): status, then the
// four 7-day indicators, the pipeline as five stages, the eval gates, then who waits on a person — one content
// at every width, laid out by CSS. Every card opens its page. The windowed indicators and charts (7 / 14 / 30
// days, pipeline_kpis.mjs) are overviewTrends(), on the Metrics page. Pure.
import { escapeHtml as e, headlineScore } from './eval_site.mjs';
import { costAmount, costBasis, formatUsd } from './llm_cost.mjs';
import { DEFINITIONS, WINDOWS, RUN_CLASSES } from './pipeline_kpis.mjs';
import { toneMark, trendChart, definitionsPanel, duration, itemTitle } from './console_views.mjs';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)} %`);
const STATUS = {
  critical: ['bad', 'Attention needed', (n) => `${n} critical problem(s)`],
  warning: ['warn', 'Running with issues', (n) => `${n} problem(s) to look at`],
  ok: ['good', 'No problem detected', () => 'by the rules — not proof of health'],
  no_data: ['unknown', 'No data', () => 'no pipeline run recorded yet'],
};

/**
 * Change of a value against the previous window: `{ text, tone }`. `better` is the direction that is good
 * (`up`, `down` or null for neutral); `points` compares rates in percentage points. No previous value: said.
 * `zeroBase`: a previous 0 is a real, populated value (e.g. a free-tier-only window), not missing data; a
 * change from it has no percentage and is stated as such.
 */
export function delta(cur, prev, { better = null, points = false, days = 7, zeroBase = false } = {}) {
  if (!points && prev === 0 && zeroBase && cur != null) {
    if (cur === 0) return { text: `= vs prior ${days} d`, tone: 'neutral', arrow: '' };
    const up = cur > 0;
    return { text: `${up ? 'up' : 'down'} from 0 vs prior ${days} d`, tone: better == null ? 'neutral' : (up === (better === 'up')) ? 'good' : 'bad', arrow: up ? '↑' : '↓' };
  }
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
  return `<a class="kpi2 tone-${tone}" href="${e(href)}" data-kpi="${id}">${icon(ic)}<span class="kpi-body"><span class="kpi-label">${e(DEFINITIONS[id].label)}</span><span class="kpi-row"><strong class="kpi-value">${e(value)}</strong>${change ? `<span class="kpi-delta tone-${change.tone}">${e(change.arrow)} ${e(change.text)}</span>` : ''}</span></span>${visual}<span class="kpi-note">${note}</span></a>`;
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

/**
 * The four indicators of one window. root: path to pipeline/. `minBase`: a change is shown only when the
 * previous window holds at least that many runs (verdicts for the approval rate), as on the home; `amount`
 * formats the cost (the home's has 2 decimals).
 */
export function kpiRow(w, root, hasWithheld, { minBase = 0, amount = costAmount } = {}) {
  const c = w.current, p = w.previous;
  const prevRuns = p.runs || null;
  const has = (s) => s.verdicts > 0;
  const gate = (base, change) => (base >= minBase ? change : null);
  const cards = [
    kpi({ id: 'executions', ic: 'runs', href: `${root}index.html#executions`, value: String(c.runs), change: gate(p.runs, delta(c.runs, prevRuns, { days: w.days })), visual: segments(c), note: `<span class="tone-good">${e(c.progressed)} moved forward</span> · <span class="tone-warn">${e(c.adverse)} adverse</span> · <span class="tone-bad">${e(c.failed)} failed</span> · ${e(c.neutral)} no decision`, tone: c.failed ? 'bad' : 'neutral' }),
    kpi({ id: 'approve_rate', ic: 'rate', href: hasWithheld ? `${root}diagnostics.html#review-withheld` : `${root}health.html#reviews`, value: pct(c.approve_rate), change: gate(p.verdicts, delta(c.approve_rate, has(p) ? p.approve_rate : null, { better: 'up', points: true, days: w.days })), visual: sparkline(w.series.map((s) => s.approve_rate), { tone: 'good', label: 'Approval rate per day' }), note: c.verdicts ? `${e(c.approve)} of ${e(c.verdicts)} verdicts · ${e(c.withheld)} withheld · ${e(c.request_changes)} changes requested` : 'No verdict recorded in the window', tone: c.approve_rate == null ? 'unknown' : c.approve_rate < 0.5 ? 'warn' : 'good' }),
    kpi({ id: 'run_duration', ic: 'time', href: `${root}health.html#performance`, value: duration(c.duration.mean), change: gate(p.runs, delta(c.duration.mean, p.duration.mean, { better: 'down', days: w.days })), visual: sparkline(w.series.map((s) => s.avg_ms), { tone: 'accent', label: 'Average run duration per day' }), note: c.duration.n ? `p95 ${e(duration(c.duration.p95))} · ${e(c.duration.n)} run(s)` : 'No timed run in the window', tone: 'neutral' }),
    kpi({ id: 'llm_cost', ic: 'cost', href: `${root}health.html#cost`, value: amount(c.cost), change: gate(p.runs, comparableCost(c.cost) && comparableCost(p.cost) ? delta(c.cost.usd, p.cost.usd, { better: 'down', days: w.days, zeroBase: p.cost.calls > 0 }) : { text: c.cost.unpriced || p.cost.unpriced ? 'no change: unpriced calls make a side incomplete' : `no prior ${w.days} d data`, tone: 'unknown', arrow: '' }), visual: sparkline(w.series.map((s) => s.usd), { tone: 'info', label: 'LLM cost per day' }), note: c.cost.calls ? `${e(c.cost.calls)} call(s) · ${e(costBasis(c.cost) ?? (c.cost.free === c.cost.calls ? 'free tier only' : 'no priced call'))}${c.cost.unpriced ? ` · ${e(c.cost.unpriced)} unpriced, not counted` : ''} · list price` : 'No LLM call in the window', tone: 'neutral' }),
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
  // One polyline per contiguous run of days with a value: a day without a timed run is a gap, never bridged.
  const paths = (key) => series.reduce((segs, s, i) => {
    if (s[key] == null) { if (segs.at(-1).length) segs.push([]); return segs; }
    segs.at(-1).push(`${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`);
    return segs;
  }, [[]]).filter((seg) => seg.length > 1);
  const dots = (key, cls) => series.map((s, i) => (s[key] == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(s[key]).toFixed(1)}" r="3" class="${cls}"><title>${e(`${s.day}: ${key === 'avg_ms' ? 'average' : 'p95'} ${duration(s[key])}`)}</title></circle>`)).join('');
  const ticks = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W - R}" y1="${y(top * f)}" y2="${y(top * f)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(top * f) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${e(duration(top * f))}</text>`).join('');
  const labels = series.map((s, i) => (i % Math.ceil(series.length / 7) === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${e(s.day.slice(5))}</text>` : '')).join('');
  const rows = series.filter((s) => s.avg_ms != null).map((s) => `<tr><td>${e(s.day)}</td><td class="num">${e(duration(s.avg_ms))}</td><td class="num">${e(duration(s.p95_ms))}</td></tr>`).join('');
  return `<div class="legend"><span><i class="line-key accent"></i>Average</span><span><i class="line-key dashed"></i>p95</span></div><div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average and p95 run duration per day; values in the table">${ticks}${paths('p95_ms').map((pts) => `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--link)" stroke-width="1.6" stroke-dasharray="4 4"/>`).join('')}${paths('avg_ms').map((pts) => `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.2"/>`).join('')}${dots('p95_ms', 'dot-p95')}${dots('avg_ms', 'dot-accent')}${labels}</svg></div><details><summary>Values</summary><div class="table-wrap"><table><thead><tr><th>Day</th><th class="num">Average</th><th class="num">p95</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
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

/** Active warning / critical findings, most severe first: what the home names; resolved and info stay on Diagnostics. */
export function activeProblems(d) {
  return d.findings.filter((f) => f.status !== 'resolved' && f.severity !== 'info');
}

/**
 * Waiting on you: the open work items whose last recorded state is an escalation to a human (ADR-0001), oldest
 * first. Each row: item, step, the reason in plain words (files named), the escalation comment and the age.
 * No severity: waiting here is the gate working; a finding is raised separately for what the design does not explain.
 */
export function waitingPanel(rows, root) {
  const time = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const list = rows.map((w) => `<li class="waiting-row"><div class="waiting-head"><a href="${root}traces/${encodeURIComponent(w.trace_id)}.html"><strong>${e(itemTitle(w.item))}</strong></a>${w.prs.filter((n) => n !== w.item?.number).map((n) => ` <span class="muted">PR #${e(n)}</span>`).join('')}<span class="pill tone-neutral">${e(w.step)}</span></div><p class="waiting-reason">${e(w.reason)}</p><p class="waiting-meta">${w.url ? `<a href="${e(w.url)}">Escalation comment</a>` : '<span class="muted">No comment link recorded</span>'} · ${w.since != null ? `waiting since <span data-ts="${w.since}">${e(time(w.since))} UTC</span>` : '<span class="muted">date not recorded</span>'}</p></li>`).join('');
  return `<section class="panel waiting-panel" id="waiting"><h3><span>Waiting on you <small class="muted">${e(rows.length)} open item(s) escalated to a human</small></span><a href="${root}flows.html?state=escalated">Filter →</a></h3>${list ? `<ul class="waiting-list">${list}</ul>` : '<p class="muted">Nothing waits on you: no open work item has an escalation as its last recorded state. Items closed before closings were journaled are not inferred (Diagnostics → data gaps).</p>'}</section>`;
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

/**
 * The windowed indicators, charts and definitions, head of the Metrics page (the home's former body): `root`
 * the path to pipeline/ ('' on a pipeline page).
 */
export function overviewTrends(ctx, root = '') {
  const { diagnosis: d, overview: o, windows } = ctx;
  const hasWithheld = d.findings.some((f) => f.id === 'review-withheld');
  const range = `<label class="range-select">Range <select data-range>${WINDOWS.map((n) => `<option value="${n}">Last ${n} days</option>`).join('')}</select></label>`;
  return `<section class="console" id="trends" aria-label="Trends">
<div class="section-intro"><div><h2>Trends</h2><p>Windows end on the latest recorded run (${e(o.window.to ? new Date(o.window.to).toISOString().slice(0, 16).replace('T', ' ') : '—')} UTC).</p></div><div class="head-tools">${range}</div></div>
${WINDOWS.map((n, i) => windowBlock(windows[n], root, hasWithheld, i > 0)).join('')}
${secondary(o, root)}
${definitionsPanel()}
</section>${RANGE_SCRIPT}`;
}

// The home: a change is shown only against a populated previous window (MIN_BASE runs or verdicts): a
// percentage on a handful of runs is noise (e.g. +3283 % after a quiet week).
const GLANCE_DAYS = 7;
const MIN_BASE = 10;
const usd2 = (usd) => (usd > 0 && usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`);
// A sum as a short amount: free tier, unpriced, a lower bound (≥) with unpriced calls, else 2 decimals.
export function shortAmount(sum) {
  if (!sum.calls) return '—';
  if (sum.free === sum.calls) return 'free tier';
  if (!sum.measured && !sum.estimated) return 'unpriced';
  return `${sum.unpriced ? '≥ ' : ''}${usd2(sum.usd)}`;
}
const chip = (href, tone, text, title = '') => `<a class="g-chip tone-${tone}" href="${e(href)}"${title ? ` title="${e(title)}"` : ''}>${toneMark(tone)}<span>${text}</span></a>`;
const row = (id, href, label, value, sub, chips) => `<section class="g-row" id="g-${id}"><a class="g-head" href="${e(href)}"><span class="g-label">${e(label)}</span><strong class="g-value">${value}</strong>${sub ? `<span class="g-sub">${sub}</span>` : ''}<span class="chevron" aria-hidden="true">›</span></a>${chips ? `<div class="g-chips">${chips}</div>` : ''}</section>`;

// The work items a `flows.html?period=N` link shows: the same reference (latest recorded run end) and the same
// rule (last activity within N days of it) as the Pipelines period filter, so a chip's count is its list's length.
export function periodItems(ctx, days) {
  const ref = Math.max(0, ...(ctx.traces ?? []).flatMap((t) => (t.runs ?? []).map((r) => r.completed_at ?? r.started_at ?? 0)));
  return (ctx.journeys ?? []).filter((j) => ref - (Number(j.last_activity) || 0) <= days * 86400000);
}

// The trend of a suite: its headline score against the previous run on the same dataset, else none.
function suiteTrend(runs) {
  const [last, prev] = runs;
  if (!prev || last.dataset_sha256 !== prev.dataset_sha256) return '';
  const a = headlineScore(last)?.value, b = headlineScore(prev)?.value;
  if (typeof a !== 'number' || typeof b !== 'number' || a === b) return '';
  return a > b ? ' ↑' : ' ↓';
}

// No severity on the waiting row either: waiting here is the gate working (waitingPanel).
function waitingRow(rows, root) {
  if (!rows.length) return row('waiting', `${root}flows.html#waiting`, 'Waiting on you', '0', 'nothing escalated to a person', '');
  const chips = rows.slice(0, 3).map((w) => chip(`${root}traces/${encodeURIComponent(w.trace_id)}.html`, 'neutral', `${e(itemTitle(w.item))} · ${e(w.step)}`, w.reason)).join('');
  const more = rows.length > 3 ? `<a class="g-chip g-more" href="${root}flows.html#waiting">+${e(rows.length - 3)}</a>` : '';
  return row('waiting', `${root}flows.html#waiting`, 'Waiting on you', e(rows.length), 'escalated to a person, oldest first', chips + more);
}

/** The status line: the diagnostic status and the most severe active problem, linked to Diagnostics. */
function statusLine(d, root) {
  const [tone, title] = STATUS[d.status];
  const top = activeProblems(d)[0];
  const n = activeProblems(d).length;
  const detail = top ? `${n} problem(s) · ${e(top.title)}` : e(STATUS[d.status][2](0));
  return `<a class="g-status status-banner tone-${tone}" href="${root}diagnostics.html${top ? `#${e(top.id)}` : ''}">${toneMark(tone)}<span><strong>${e(title)}</strong><small>${detail}</small></span><span class="chevron" aria-hidden="true">›</span></a>`;
}

// ---------------------------------------------------------------------------
// The cockpit (ADR-0043 amendment 2026-10-28): a hero, the four 7-day indicators, the pipeline as five
// stages with their daily activity, and the eval gates. Same content on a phone, stacked (CSS).
// ---------------------------------------------------------------------------

const svg = (body, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const STAGE_ICON = {
  issue: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4M13 6l-2 12"/>',
  review: '<path d="M4 5h16v11H9l-5 4z"/><path d="m9 10.5 2 2 4-4"/>',
  fix: '<path d="M15 4a5 5 0 0 0-4.6 6.9L4 17.3 6.7 20l6.4-6.4A5 5 0 0 0 20 9l-3 1-2-2 1-3z"/>',
  merge: '<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="12" r="2"/><path d="M7 7v10M7 7c0 4 4 5 8 5"/>',
};
const SHIELD = '<path d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6z"/><path d="m9 12 2 2 4-4"/>';
const LOGO = '<path d="M12 2.5 20.5 7.5v9L12 21.5 3.5 16.5v-9z"/><path d="M8.5 9.5 12 12l3.5-2.5M12 12v4.5"/>';

/** Bars of a daily series (one per day, scaled to its maximum); an all-zero series is a flat baseline. */
export function dayBars(values, label) {
  const W = 140, H = 34, gap = 3;
  const max = Math.max(0, ...values);
  const bw = (W - gap * (values.length - 1)) / Math.max(1, values.length);
  const bars = values.map((v, i) => {
    const h = max ? Math.max(2, (v / max) * (H - 2)) : 2;
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"${v ? '' : ' class="zero"'}/>`;
  }).join('');
  return `<svg class="day-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${e(`${label} per day: ${values.join(', ')}`)}">${bars}</svg>`;
}

function hero() {
  return `<div class="home-hero" aria-hidden="true"><div class="hero-brand"><span class="hero-logo">${svg(LOGO)}</span><div><p class="hero-title">Autonomous <span>Dev Loop</span></p><p class="hero-flow">Issue → Code → Review → Auto-fix → Merge</p></div></div><div class="hero-tag"><span class="hero-rule"></span><p>An evaluation-driven agentic SDLC</p><p>Build · Validate · Improve · Repeat</p></div></div>`;
}

const stageCard = ({ n, key, name, sub, href, value, unit, note, bars }) => `<a class="stage-card st-${key}" href="${e(href)}"><span class="stage-head"><span class="stage-icon">${svg(STAGE_ICON[key])}</span><strong>${n}. ${e(name)}</strong><small>${e(sub)}</small></span><span class="stage-value"><strong>${e(value)}</strong><span>${e(unit)}</span></span><span class="stage-note">${e(note)}</span>${bars}</a>`;

/** The five stages of the 7-day window: what each step decided, per day (definition `stage_flow`). */
export function stageStrip(w, ctx, root, hasWithheld) {
  const a = w.activity, c = w.current;
  const k = (step, key) => a[step].by_key[key] ?? 0;
  const day = (t) => Math.floor((t - w.from) / 86400000);
  const merged = periodItems(ctx, w.days).filter((j) => j.state === 'merged');
  const mergedPerDay = Array(w.days).fill(0);
  for (const j of merged) { const i = day(j.closing?.ts); if (i >= 0 && i < w.days) mergedPerDay[i] += 1; }
  const iv = a.issue_validation, pr = a.pr_prepare, cg = a.code_gen, af = a.autofix;
  const cards = [
    { key: 'issue', name: 'Issue', sub: 'Validate & scope', href: `${root}flows.html?kind=issue&period=${w.days}`, value: String(iv.decisions), unit: 'issues validated', note: iv.decisions ? `${k('issue_validation', 'pass')} passed · ${k('issue_validation', 'fail')} rejected${k('issue_validation', 'error') ? ` · ${k('issue_validation', 'error')} error(s)` : ''}` : 'No validation in the window', bars: dayBars(iv.per_day, 'Validations') },
    { key: 'code', name: 'Code', sub: 'Implement (AI)', href: `${root}health.html#funnel`, value: String(pr.good), unit: 'PRs prepared', note: `${cg.good} patch(es) generated${cg.decisions - cg.good ? ` · ${cg.decisions - cg.good} blocked or skipped` : ''}`, bars: dayBars(pr.good_per_day, 'PRs prepared') },
    { key: 'review', name: 'Review', sub: 'AI + human', href: hasWithheld ? `${root}diagnostics.html#review-withheld` : `${root}health.html#reviews`, value: pct(c.approve_rate), unit: 'approval rate', note: c.verdicts ? `${c.approve} of ${c.verdicts} verdicts` : 'No verdict in the window', bars: dayBars(w.series.map((s) => s.verdicts), 'Review verdicts') },
    { key: 'fix', name: 'Auto-fix', sub: 'Up to 3 attempts', href: `${root}health.html#autofix`, value: String(af.prs), unit: 'PRs auto-fixed', note: af.decisions ? `${af.good} fix(es) pushed · ${af.decisions - af.good} without a push` : 'No auto-fix in the window', bars: dayBars(af.good_per_day, 'Fixes pushed') },
    { key: 'merge', name: 'Merge', sub: 'Human approval', href: `${root}flows.html?state=merged&period=${w.days}`, value: String(merged.length), unit: 'merged', note: 'Journaled merges (item.closed)', bars: dayBars(mergedPerDay, 'Merges') },
  ];
  const arrow = `<span class="stage-arrow" aria-hidden="true">${svg('<path d="M4 12h15m-5-5 5 5-5 5"/>')}</span>`;
  return `<section class="stage-strip panel" aria-label="Pipeline stages, last ${w.days} days">${cards.map((card, i) => stageCard({ n: i + 1, ...card })).join(arrow)}</section>`;
}

/** The eval gates: per suite its headline score, a bar, the gate and the trend on the same dataset. */
export function qualityPanel(suites, evalRoot) {
  const evals = `${evalRoot}evals.html`;
  const passing = suites.filter(([, s]) => s.runs[0].passed).length;
  const rows = suites.map(([name, s]) => {
    const run = s.runs[0];
    const h = headlineScore(run);
    const v = typeof h?.value === 'number' ? h.value : null;
    const tone = run.passed ? 'good' : 'bad';
    return `<li><a class="tone-${tone}" href="${evals}#suite-${encodeURIComponent(name)}"><span class="q-name">${e(String(name).replace(/_/g, ' '))}</span><strong class="q-value">${v == null ? '—' : `${Math.round(v * 100)} %`}${e(suiteTrend(s.runs))}</strong><span class="q-bar"><span style="width:${((v ?? 0) * 100).toFixed(1)}%"></span></span><small>${e(h?.name ?? 'no score')} · gate ${run.passed ? 'passed' : 'failed'} · ${e(String(run.ts ?? '').slice(0, 10))}</small></a></li>`;
  }).join('');
  return `<section class="quality-panel panel" aria-label="Quality and reliability"><h3><span class="q-shield">${svg(SHIELD)}</span>Quality &amp; reliability<a href="${evals}">${suites.length ? `${e(passing)} / ${e(suites.length)} gates` : 'Evals'} →</a></h3>${rows ? `<ul class="q-list">${rows}</ul>` : '<p class="muted">No eval run published.</p>'}</section>`;
}

function cockpit(ctx, root, suites, evalRoot, hasWithheld) {
  const w = ctx.windows[GLANCE_DAYS];
  const head = w.empty ? '<div class="panel"><p>No pipeline run recorded yet: no indicator to compute.</p></div>' : kpiRow(w, root, hasWithheld, { minBase: MIN_BASE, amount: shortAmount });
  return `<div class="cockpit">${head}<div class="cockpit-grid">${w.empty ? '' : stageStrip(w, ctx, root, hasWithheld)}${qualityPanel(suites, evalRoot)}</div></div>`;
}

/**
 * The home: `ctx` from consoleContext(), `root` the path to pipeline/ ('pipeline/' on the home page),
 * `suites` the scorecard suites with runs (`[name, { runs }]`, latest first).
 */
export function consoleOverview(ctx, root = '', { suites = [] } = {}) {
  const { diagnosis: d } = ctx;
  const hasWithheld = d.findings.some((f) => f.id === 'review-withheld');
  const evalRoot = root.replace(/pipeline\/$/, '');
  return `<section class="console glance" aria-label="System overview">
<h1>System overview</h1>
${hero()}
${statusLine(d, root)}
${cockpit(ctx, root, suites, evalRoot, hasWithheld)}
${waitingRow(ctx.waiting ?? [], root)}
<p class="g-foot"><a href="${root}health.html#trends">Trends, 14 / 30 days and definitions →</a></p>
</section>`;
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
/* The h1 is for screen readers; the hero names the page. */
.glance h1 { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.g-status.status-banner { margin:0 0 8px; padding:8px 10px; gap:8px; border-left-width:5px; color:var(--ink); text-decoration:none; flex-wrap:nowrap; }
.g-status .tone-mark { width:24px; height:24px; font-size:13px; flex:none; }
.g-status > span:not(.chevron):not(.tone-mark) { flex:1; min-width:0; display:grid; }
.g-status strong { color:var(--tone); font-size:14px; } .g-status small { color:var(--ink-2); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.g-row { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); margin:0 0 8px; padding:8px 10px; }
.g-head { display:grid; grid-template-columns:auto 1fr auto; grid-template-areas:'label value chev' 'sub sub sub'; align-items:baseline; column-gap:8px; color:var(--ink); text-decoration:none; }
.g-label { grid-area:label; font-size:11px; font-weight:650; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; white-space:nowrap; }
.g-value { grid-area:value; justify-self:end; font-size:18px; font-weight:750; font-variant-numeric:tabular-nums; line-height:1.2; white-space:nowrap; }
.g-value .kpi-delta { font-size:11px; vertical-align:middle; }
.g-sub { grid-area:sub; font-size:11.5px; color:var(--muted); min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .g-sub .segbar { margin-top:5px; height:6px; }
.g-head .chevron { grid-area:chev; color:var(--muted); font-size:18px; }
.g-chips { display:flex; flex-wrap:nowrap; gap:6px; margin:6px -10px 0; padding:0 10px; overflow-x:auto; scrollbar-width:none; }
.g-chips::-webkit-scrollbar { display:none; }
.g-chip { flex:none; display:inline-flex; align-items:center; gap:5px; min-height:30px; padding:2px 9px; border:1px solid color-mix(in srgb, var(--tone) 40%, var(--border)); border-radius:999px; background:color-mix(in srgb, var(--tone) 8%, var(--surface)); color:var(--ink); font-size:12.5px; text-decoration:none; font-variant-numeric:tabular-nums; white-space:nowrap; }
.g-chip .tone-mark { width:16px; height:16px; font-size:10px; }
.g-chip.g-more { --tone:var(--muted); }
.g-foot { margin:2px 0 0; font-size:12px; }
@media(max-width:600px) { main:has(> .glance) { padding-top:10px; } }
.glance { --st-issue:#7aa7ff; --st-code:#22c55e; --st-review:#a78bfa; --st-fix:#8b5cf6; --st-merge:#2dd4bf; }
:root[data-theme="light"] .glance { --st-issue:#2f5fe0; --st-code:#16a34a; --st-review:#7c3aed; --st-fix:#6d28d9; --st-merge:#0d9488; }
.home-hero { position:relative; overflow:hidden; display:flex; justify-content:space-between; align-items:center; gap:24px; flex-wrap:wrap; margin:0 0 14px; padding:22px 26px; border:1px solid var(--border); border-radius:var(--radius); background:radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--accent) 30%, transparent) 1px, transparent 1.5px) 0 0 / 14px 14px, linear-gradient(120deg, color-mix(in srgb, var(--accent) 12%, var(--surface)), var(--surface) 55%); }
.home-hero::before { content:''; position:absolute; inset:0; background:linear-gradient(90deg, transparent 0, var(--surface) 38%); pointer-events:none; }
.home-hero > * { position:relative; }
.hero-brand { display:flex; align-items:center; gap:16px; }
.hero-logo { display:grid; place-items:center; width:52px; height:52px; border-radius:14px; color:var(--accent); background:var(--accent-soft); border:1px solid color-mix(in srgb, var(--accent) 45%, transparent); }
.hero-logo svg { width:30px; height:30px; }
.hero-title { margin:0; font-size:clamp(24px,2.6vw,34px); font-weight:800; letter-spacing:-.8px; line-height:1.1; color:var(--ink); }
.hero-title span { background:linear-gradient(90deg, var(--link), var(--accent)); -webkit-background-clip:text; background-clip:text; color:transparent; }
.hero-flow { margin:8px 0 0; font-size:11.5px; font-weight:650; letter-spacing:3.2px; text-transform:uppercase; color:var(--ink-2); }
.hero-tag { display:grid; gap:6px; justify-items:end; text-align:right; }
.hero-tag p { margin:0; font-size:11px; font-weight:650; letter-spacing:3px; text-transform:uppercase; color:var(--ink-2); }
.hero-tag p + p { color:var(--muted); }
.hero-rule { width:min(260px,22vw); height:1px; background:linear-gradient(90deg, transparent, var(--accent)); position:relative; }
.hero-rule::after { content:''; position:absolute; right:-3px; top:-3px; width:7px; height:7px; border-radius:50%; background:var(--good); box-shadow:0 0 8px var(--good); }
.cockpit .kpi-grid4 { margin:14px 0; }
.cockpit .kpi2 { padding:18px; background:linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 60%, var(--surface)), var(--surface)); }
.cockpit .kpi-icon { width:46px; height:46px; border-radius:12px; } .cockpit .kpi-icon svg { width:22px; height:22px; }
.cockpit .kpi2 .kpi-value { font-size:34px; }
.cockpit .kpi2 .spark { height:56px; }
.cockpit [data-kpi="llm_cost"] .kpi-icon { background:color-mix(in srgb, var(--link) 16%, transparent); color:var(--link); }
.cockpit [data-kpi="llm_cost"] .spark { --tone:var(--link); }
.cockpit-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(250px,300px); gap:14px; align-items:stretch; margin:0 0 14px; }
.cockpit-grid > .panel { margin:0; }
.cockpit-grid > .quality-panel:only-child { grid-column:1 / -1; }
.stage-strip { display:flex; align-items:stretch; gap:4px; padding:12px; overflow-x:auto; }
.stage-card { flex:1 1 0; min-width:132px; display:flex; flex-direction:column; gap:8px; padding:14px 12px; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); color:var(--ink); text-decoration:none; --tone:var(--accent); }
.stage-card:hover { border-color:var(--tone); }
.st-issue { --tone:var(--st-issue); } .st-code { --tone:var(--st-code); } .st-review { --tone:var(--st-review); } .st-fix { --tone:var(--st-fix); } .st-merge { --tone:var(--st-merge); }
.stage-head { display:grid; grid-template-columns:auto 1fr; grid-template-areas:'icon name' 'icon sub'; align-items:center; column-gap:10px; min-width:0; }
.stage-head .stage-icon { grid-area:icon; }
.stage-head strong { grid-area:name; font-size:14px; white-space:nowrap; } .stage-head small { grid-area:sub; font-size:11.5px; color:var(--muted); }
.stage-icon { flex:none; display:grid; place-items:center; width:36px; height:36px; border-radius:10px; color:var(--tone); background:color-mix(in srgb, var(--tone) 15%, transparent); }
.stage-icon svg { width:19px; height:19px; }
.stage-value { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin-top:4px; }
.stage-value strong { font-size:30px; font-weight:750; letter-spacing:-.8px; line-height:1; font-variant-numeric:tabular-nums; }
.stage-value span { font-size:12px; color:var(--ink-2); }
.stage-note { font-size:11.5px; color:var(--muted); min-height:2.6em; }
.day-bars { width:100%; height:34px; display:block; margin-top:auto; } .day-bars rect { fill:var(--tone); } .day-bars rect.zero { fill:var(--grid); }
.stage-arrow { flex:none; align-self:center; color:var(--muted); } .stage-arrow svg { width:18px; height:18px; display:block; }
.quality-panel h3 { display:flex; flex-wrap:nowrap; justify-content:flex-start; align-items:center; gap:10px; margin:0 0 14px; white-space:nowrap; }
.quality-panel h3 a { margin-left:auto; font-size:12px; font-weight:600; }
.q-shield { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; color:var(--good); background:var(--good-bg); } .q-shield svg { width:18px; height:18px; }
.q-list { list-style:none; margin:0; padding:0; display:grid; gap:14px; }
.q-list a { display:grid; grid-template-columns:1fr auto; grid-template-areas:'name value' 'bar bar' 'note note'; gap:5px 10px; color:var(--ink); text-decoration:none; }
.q-name { grid-area:name; font-size:13px; color:var(--ink-2); text-transform:capitalize; } .q-value { grid-area:value; color:var(--tone); font-variant-numeric:tabular-nums; }
.q-bar { grid-area:bar; height:8px; border-radius:4px; background:var(--grid); overflow:hidden; } .q-bar span { display:block; height:100%; border-radius:4px; background:var(--tone); }
.q-list small { grid-area:note; font-size:11px; color:var(--muted); }
@media(max-width:1250px) { .cockpit-grid { grid-template-columns:1fr; } .q-list { grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); column-gap:24px; } }
/* Phone (ADR-0043 amendment 2026-10-28): the same content stacked — a compact hero, the indicators two by two
   with their notes, the stages as a vertical pipeline (value right, daily bars beside the note), the gates. */
@media(max-width:760px) {
  .home-hero { padding:14px 16px; gap:10px; margin-bottom:8px; }
  .hero-brand { gap:12px; } .hero-logo { width:40px; height:40px; border-radius:11px; } .hero-logo svg { width:24px; height:24px; }
  .hero-title { font-size:22px; } .hero-flow { margin-top:5px; font-size:9px; letter-spacing:1px; white-space:nowrap; }
  .hero-tag { display:none; }
  .stage-strip { flex-direction:column; gap:0; padding:8px; overflow:visible; }
  .stage-card { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:'head value' 'note bars'; align-items:center; gap:6px 12px; min-width:0; padding:10px 12px; }
  .stage-head { grid-area:head; } .stage-value { grid-area:value; justify-self:end; flex-direction:column; align-items:flex-end; gap:2px; margin:0; }
  .stage-value strong { font-size:24px; } .stage-value span { font-size:11px; text-align:right; }
  .stage-note { grid-area:note; min-height:0; } .day-bars { grid-area:bars; width:96px; height:24px; margin:0; }
  .stage-arrow { transform:rotate(90deg); margin:2px 0; } .stage-arrow svg { width:14px; height:14px; }
  .q-list { grid-template-columns:1fr; }
}
@media(max-width:600px) {
  .cockpit .kpi-grid4 { margin:8px 0; }
  .cockpit .kpi2 { padding:12px; gap:6px; }
  .cockpit .kpi2 .kpi-value { font-size:24px; }
  .cockpit .kpi2 .kpi-label { font-size:11.5px; }
  .cockpit .kpi2 .spark { height:36px; }
  .cockpit .kpi2 .kpi-note { display:block; font-size:10.5px; line-height:1.35; }
  .cockpit-grid { gap:8px; margin-bottom:8px; }
  .quality-panel { padding:12px; }
}
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
.dot-p95 { fill:var(--link); stroke:var(--surface); stroke-width:1.5; }
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
.waiting-list { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.waiting-row { padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--surface); }
.waiting-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.waiting-reason { margin:6px 0 4px; overflow-wrap:anywhere; }
.waiting-meta { margin:0; font-size:12px; color:var(--ink-2); }
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

