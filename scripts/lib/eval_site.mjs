/**
 * Eval dashboard — static site published to GitHub Pages by the Evals workflow (ADR-0027).
 *
 * Pure: buildSite() turns the scorecard (summary per run, last MAX_RUNS per suite) and the
 * full results of those runs into a map of { path: content }. The deployed site is also the
 * history store: the next publish reads scorecard.json and runs/<id>.json back from it.
 */

import { formatScorecard, MAX_RUNS } from './eval_scorecard.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON embedded in <script>: no "</" sequence may close the tag early.
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const fmt = (v) => (v == null ? '—' : String(v));
const day = (ts) => String(ts ?? '').slice(0, 10);
const stamp = (ts) => String(ts ?? '').slice(5, 16).replace('T', ' ');
const compact = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const runFile = (runId) => `runs/${encodeURIComponent(runId)}`;
// A run published before workflow_run_id existed has the workflow run ID as run_id; anything else
// (a local EVAL_RUN_ID) has no workflow run to link.
const workflowRunId = (meta) => meta.workflow_run_id ?? (/^\d+$/.test(String(meta.run_id ?? '')) ? meta.run_id : null);

function deltaHtml(current, previous) {
  if (current == null || previous == null) return '';
  const d = Number((current - previous).toFixed(4));
  if (d === 0) return '<span class="delta">=</span>';
  return d > 0 ? `<span class="delta">▲ ${d}</span>` : `<span class="delta">▼ ${Math.abs(d)}</span>`;
}

function gateHtml(passed, failures = []) {
  return passed
    ? '<span class="status status-good">✓ Pass</span>'
    : `<span class="status status-critical">✕ Fail</span>${failures.length ? ` <span class="muted">${escapeHtml(failures.join(', '))}</span>` : ''}`;
}

// The first scorer is the suite's headline metric (badge, KPI order).
export function headlineScore(run) {
  const [name, value] = Object.entries(run.scores ?? {})[0] ?? [];
  return name ? { name, value } : null;
}

// shields.io endpoint badge: https://shields.io/badges/endpoint-badge
export function formatBadge(suite, run) {
  if (!run) return { schemaVersion: 1, label: `eval ${suite}`, message: 'no run yet', color: 'lightgrey' };
  const head = headlineScore(run);
  const metric = head ? `${head.name.replace(/_/g, ' ')} ${fmt(head.value)} · ` : '';
  return {
    schemaVersion: 1,
    label: `eval ${suite}`,
    message: `${metric}${run.passed ? 'pass' : 'fail'}`,
    color: run.passed ? 'brightgreen' : 'red',
    cacheSeconds: 300,
  };
}

export function describeThreshold({ min, max }) {
  return [min != null ? `≥ ${min}` : null, max != null ? `≤ ${max}` : null].filter(Boolean).join(' and ');
}

function metricAt(summaryLike, metricPath) {
  return metricPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), summaryLike);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --good: #0ca30c; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--s1); }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 19px; margin: 32px 0 12px; } h3 { font-size: 16px; margin: 24px 0 8px; }
.muted { color: var(--muted); } .sub { color: var(--ink-2); margin: 0 0 16px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 12px 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.tile .label { color: var(--ink-2); font-size: 13px; } .tile .value { font-size: 22px; font-weight: 600; white-space: nowrap; }
.delta { display: block; color: var(--ink-2); font-size: 13px; font-weight: 400; }
.status { font-weight: 600; } .status-good { color: var(--good); } .status-critical { color: var(--critical); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; white-space: nowrap; } td:first-child { white-space: nowrap; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
details summary { cursor: pointer; color: var(--s1); }
td.out { min-width: 320px; }
pre { white-space: pre-wrap; word-break: break-word; background: var(--page); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-size: 12px; max-height: 320px; overflow: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: var(--ink-2); margin: 4px 0 8px; }
.legend i { display: inline-block; width: 14px; height: 2px; vertical-align: middle; margin-right: 6px; }
.chart { position: relative; }
.chart svg { width: 100%; height: auto; display: block; }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.15); display: none; white-space: nowrap; }
.ok { color: var(--good); } .ko { color: var(--critical); }
`;

function page(title, body, { depth = 0 } = {}) {
  const root = depth ? '../' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="muted"><a href="${root}index.html">Eval dashboard</a> · <a href="https://github.com/koydas/autonomous-dev-loop">autonomous-dev-loop</a> · <a href="${root}scorecard.json">scorecard.json</a></p>
${body}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Trend chart (inline SVG + crosshair tooltip)
// ---------------------------------------------------------------------------

const SERIES_VARS = ['--s1', '--s2', '--s3', '--s4'];

// runs: newest first (scorecard order). Plots every scorer (0..1), capped at 4 series.
export function trendChart(chartId, runs) {
  const ordered = [...runs].reverse();
  const names = [...new Set(ordered.flatMap((r) => Object.keys(r.scores ?? {})))].slice(0, SERIES_VARS.length);
  if (ordered.length < 2 || names.length === 0) {
    return '<p class="muted">The trend chart appears from the second recorded run.</p>';
  }
  const W = 720, H = 240, L = 40, R = 16, T = 12, B = 28;
  // Scores live in 0..1 but cluster near the top: zoom the domain to the data, in 0.1 steps.
  const values = ordered.flatMap((r) => names.map((n) => r.scores?.[n])).filter((v) => v != null);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 0.05) * 10) / 10);
  const span = 1 - lo || 1;
  const x = (i) => L + (i * (W - L - R)) / (ordered.length - 1);
  const y = (v) => T + ((1 - v) / span) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Number((lo + f * span).toFixed(3)));
  const grid = ticks
    .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`)
    .join('');
  const lines = names.map((name, s) => {
    const pts = ordered.map((r, i) => (r.scores?.[name] == null ? null : `${x(i)},${y(r.scores[name])}`));
    const path = pts.filter(Boolean).join(' ');
    const dots = ordered
      .map((r, i) => (r.scores?.[name] == null ? '' : `<circle cx="${x(i)}" cy="${y(r.scores[name])}" r="4" fill="var(${SERIES_VARS[s]})" stroke="var(--surface)" stroke-width="2"/>`))
      .join('');
    return `<polyline points="${path}" fill="none" stroke="var(${SERIES_VARS[s]})" stroke-width="2" stroke-linejoin="round"/>${dots}`;
  }).join('');
  const labels = ordered
    .map((r, i) => (i === 0 || i === ordered.length - 1 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : 'end'}" font-size="11" fill="var(--muted)">${escapeHtml(stamp(r.ts))}</text>` : ''))
    .join('');
  const legend = names.map((n, s) => `<span><i style="background:var(${SERIES_VARS[s]})"></i>${escapeHtml(n)}</span>`).join('');
  const data = { names, points: ordered.map((r, i) => ({ x: x(i), run: r.run_id, date: stamp(r.ts), model: r.model, values: names.map((n) => r.scores?.[n] ?? null) })), W, T, B, H };
  return `<div class="legend">${legend}</div>
<div class="chart" id="${chartId}">
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score trend over the last ${ordered.length} runs; values are in the history table below">
${grid}<line x1="${L}" x2="${W - R}" y1="${y(lo)}" y2="${y(lo)}" stroke="var(--axis)" stroke-width="1"/>
${lines}${labels}
<line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>
<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
</svg>
<div class="tip" role="status"></div>
<script type="application/json">${jsonForScript(data)}</script>
</div>
<script>
(() => {
  const root = document.getElementById(${JSON.stringify(chartId)});
  const d = JSON.parse(root.querySelector('script[type="application/json"]').textContent);
  const svg = root.querySelector('svg'), tip = root.querySelector('.tip'), xh = root.querySelector('.xhair');
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect(), px = ((e.clientX - box.left) / box.width) * d.W;
    let best = d.points[0];
    for (const p of d.points) if (Math.abs(p.x - px) < Math.abs(best.x - px)) best = p;
    xh.setAttribute('x1', best.x); xh.setAttribute('x2', best.x); xh.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const head = document.createElement('div'); head.textContent = best.date + ' · run ' + best.run; tip.append(head);
    d.names.forEach((n, i) => { const row = document.createElement('div'); const b = document.createElement('strong'); b.textContent = best.values[i] == null ? '—' : String(best.values[i]); row.append(b, ' ' + n); tip.append(row); });
    tip.style.display = 'block';
    const left = (best.x / d.W) * box.width;
    tip.style.left = Math.min(Math.max(0, left + 12), box.width - tip.offsetWidth) + 'px';
    tip.style.top = '8px';
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; xh.setAttribute('visibility', 'hidden'); });
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function suiteSection(name, runs, thresholds = {}) {
  const [run, last] = runs;
  const prev = last && (last.dataset_sha256 ?? null) === (run.dataset_sha256 ?? null) ? last : null;
  const tiles = [
    ...Object.entries(run.scores).map(([k, v]) => [k, fmt(v), deltaHtml(v, prev?.scores?.[k])]),
    ...Object.entries(run.per_class ?? {}).map(([cls, m]) => [`${cls} recall`, fmt(m.recall), deltaHtml(m.recall, prev?.per_class?.[cls]?.recall)]),
    ['error_rate', fmt(run.error_rate), deltaHtml(run.error_rate, prev?.error_rate)],
    ['consistency', fmt(run.consistency), ''],
    ['latency p95', run.latency_p95_ms == null ? '—' : `${(run.latency_p95_ms / 1000).toFixed(1)} s`, ''],
    ['tokens in / out', run.tokens_est ? `${compact(run.tokens_est.in)} / ${compact(run.tokens_est.out)}` : '—', ''],
  ].map(([label, value, delta]) => `<div class="tile"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}${delta}</div></div>`).join('');

  const thresholdRows = Object.entries(thresholds).map(([metric, rule]) => {
    const value = metricAt({ scores: Object.fromEntries(Object.entries(run.scores).map(([k, v]) => [k, { mean: v }])), per_class: run.per_class, error_rate: run.error_rate, consistency: run.consistency }, metric);
    const failed = run.failures?.includes(metric);
    const status = failed ? '<span class="ko">✕ fail</span>' : value == null && rule.optional ? '<span class="muted">– not measured</span>' : '<span class="ok">✓ pass</span>';
    return `<tr><td><code>${escapeHtml(metric)}</code></td><td>${escapeHtml(describeThreshold(rule))}</td><td class="num">${escapeHtml(fmt(value))}</td><td>${status}</td></tr>`;
  }).join('');

  const scoreNames = [...new Set(runs.flatMap((r) => Object.keys(r.scores ?? {})))];
  const history = runs.map((r) => `<tr><td>${escapeHtml(day(r.ts))}</td><td><a href="${runFile(r.run_id)}.html">${escapeHtml(r.run_id)}</a></td><td><code>${escapeHtml(r.model)}</code></td><td><code>${escapeHtml((r.dataset_sha256 ?? '').slice(0, 8) || '—')}</code></td>${scoreNames.map((s) => `<td class="num">${escapeHtml(fmt(r.scores?.[s]))}</td>`).join('')}<td class="num">${escapeHtml(fmt(r.error_rate))}</td><td class="num">${escapeHtml(fmt(r.consistency))}</td><td>${r.passed ? '<span class="ok">✓</span>' : '<span class="ko">✕</span>'}</td></tr>`).join('');

  return `<section>
<h2><code>${escapeHtml(name)}</code> ${gateHtml(run.passed, run.failures)}</h2>
<p class="sub">Last run <strong>${escapeHtml(day(run.ts))}</strong> · <a href="${runFile(run.run_id)}.html">run ${escapeHtml(run.run_id)}</a> · model <code>${escapeHtml(run.model)}</code> · ${escapeHtml(run.n_cases)} cases × ${escapeHtml(run.repeats)} repeats${last && !prev ? ' · <em>dataset changed since the previous run: no Δ shown</em>' : ''}</p>
<div class="tiles">${tiles}</div>
${thresholdRows ? `<h3>Thresholds</h3><div class="card table-wrap"><table><thead><tr><th>Metric</th><th>Gate</th><th class="num">Value</th><th>Status</th></tr></thead><tbody>${thresholdRows}</tbody></table></div>` : ''}
<h3>Trend</h3>
<div class="card">${trendChart(`trend-${name}`, runs)}</div>
<h3>History</h3>
<div class="card table-wrap"><table><thead><tr><th>Date</th><th>Run</th><th>Model</th><th>Dataset</th>${scoreNames.map((s) => `<th class="num">${escapeHtml(s)}</th>`).join('')}<th class="num">error_rate</th><th class="num">consistency</th><th>Gate</th></tr></thead><tbody>${history}</tbody></table></div>
</section>`;
}

export function renderIndex(scorecard, { thresholds = {}, generatedAt } = {}) {
  const suites = Object.entries(scorecard.suites).filter(([, s]) => s.runs?.length);
  const body = suites.length
    ? suites.map(([name, s]) => suiteSection(name, s.runs, thresholds[name])).join('\n')
    : '<div class="card">No live eval run recorded yet. Run <strong>Actions → Evals</strong> on the default branch with <code>publish</code> ticked.</div>';
  return page('Eval dashboard', `<h1>Eval dashboard</h1>
<p class="sub">Offline evals of the LLM pipeline stages against labelled datasets (<a href="https://github.com/koydas/autonomous-dev-loop/blob/main/docs/evals.md">docs</a>, <a href="https://github.com/koydas/autonomous-dev-loop/blob/main/docs/adr/0027-offline-eval-harness.md">ADR-0027</a>). Last ${MAX_RUNS} live runs per suite; runs that failed on error_rate (provider outage) are left out.${generatedAt ? ` Updated ${escapeHtml(generatedAt)}.` : ''}</p>
${body}`);
}

function confusionTable(confusion = {}) {
  const expected = Object.keys(confusion);
  if (!expected.length) return '';
  const predicted = [...new Set(expected.flatMap((e) => Object.keys(confusion[e])))];
  const rows = expected.map((e) => `<tr><th>${escapeHtml(e)}</th>${predicted.map((p) => `<td class="num">${escapeHtml(confusion[e][p] ?? 0)}</td>`).join('')}</tr>`).join('');
  return `<h3>Confusion matrix</h3><div class="card table-wrap"><table><thead><tr><th>expected ↓ / predicted →</th>${predicted.map((p) => `<th class="num">${escapeHtml(p)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderRun(detail) {
  const { meta = {}, summary = {}, failures = [], results = [] } = detail;
  const scoreNames = Object.keys(summary.scores ?? {});
  const metrics = [
    ['cases / runs', `${fmt(summary.n_cases)} / ${fmt(summary.n_runs)}`],
    ...scoreNames.map((s) => [`scores.${s}`, `${fmt(summary.scores[s].mean)} (n=${fmt(summary.scores[s].n)})`]),
    ['error_rate', fmt(summary.error_rate)],
    ['consistency', fmt(summary.consistency)],
    ...Object.entries(summary.per_class ?? {}).map(([cls, m]) => [`${cls} precision / recall / F1`, `${fmt(m.precision)} / ${fmt(m.recall)} / ${fmt(m.f1)} (support ${fmt(m.support)})`]),
    ['latency p50 / p95 (ms)', `${fmt(summary.latency_ms?.p50)} / ${fmt(summary.latency_ms?.p95)}`],
    ['llm calls · tokens in / out (est.)', `${fmt(summary.llm_calls)} · ${fmt(summary.tokens_est?.in)} / ${fmt(summary.tokens_est?.out)}`],
  ].map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${escapeHtml(v)}</td></tr>`).join('');

  const caseRows = results.map((r) => {
    const failing = r.error || Object.values(r.scores ?? {}).some((v) => v != null && v < 1);
    const raw = (r.calls ?? []).map((c, i) => `<p class="muted">call ${i + 1} · ${escapeHtml(fmt(c.latency_ms))} ms · ~${escapeHtml(fmt(c.tokens_in_est))} → ${escapeHtml(fmt(c.tokens_out_est))} tokens</p><pre>${escapeHtml(c.raw)}</pre>`).join('');
    const output = r.output ? `<p class="muted">parsed output</p><pre>${escapeHtml(JSON.stringify(r.output, null, 2))}</pre>` : '';
    return `<tr><td>${failing ? '<span class="ko">✕</span>' : '<span class="ok">✓</span>'}</td><td><code>${escapeHtml(r.case_id)}</code><br><span class="muted">${escapeHtml((r.tags ?? []).join(', '))}</span></td><td class="num">${escapeHtml(r.repeat)}</td><td>${escapeHtml(fmt(r.expected_label))}</td><td>${escapeHtml(fmt(r.label))}</td>${scoreNames.map((s) => `<td class="num">${escapeHtml(fmt(r.scores?.[s]))}</td>`).join('')}<td class="num">${escapeHtml(fmt(r.duration_ms))}</td><td class="out">${escapeHtml(r.error ?? '')}${raw || output ? `<details><summary>model output</summary>${output}${raw}</details>` : ''}</td></tr>`;
  }).join('');

  return page(`Eval run ${meta.run_id}`, `<h1>Run <code>${escapeHtml(meta.run_id)}</code> · <code>${escapeHtml(meta.suite)}</code> ${gateHtml(failures.length === 0, failures.map((f) => f.metric))}</h1>
<p class="sub">${escapeHtml(meta.ts)} · model <code>${escapeHtml(meta.model)}</code> · ${escapeHtml(fmt(meta.repeats))} repeats · dataset <code>${escapeHtml(meta.dataset)}</code> (<code>${escapeHtml((meta.dataset_sha256 ?? '').slice(0, 12))}</code>)${workflowRunId(meta) ? ` · <a href="https://github.com/koydas/autonomous-dev-loop/actions/runs/${encodeURIComponent(workflowRunId(meta))}">workflow run</a>` : ''} · <a href="${encodeURIComponent(meta.run_id)}.json">results JSON</a></p>
${failures.length ? `<div class="card"><strong class="ko">Threshold failures</strong><ul>${failures.map((f) => `<li><code>${escapeHtml(f.metric)}</code>: ${escapeHtml(f.reason)}</li>`).join('')}</ul></div>` : ''}
<h3>Metrics</h3><div class="card table-wrap"><table><tbody>${metrics}</tbody></table></div>
${confusionTable(summary.confusion)}
<h3>Cases</h3>
<div class="card table-wrap"><table><thead><tr><th></th><th>Case</th><th class="num">Repeat</th><th>Expected</th><th>Got</th>${scoreNames.map((s) => `<th class="num">${escapeHtml(s)}</th>`).join('')}<th class="num">ms</th><th>Error / output</th></tr></thead><tbody>${caseRows}</tbody></table></div>`, { depth: 1 });
}

// details: { [run_id]: full results JSON } for runs still on the scorecard; a run without
// details keeps its history row but gets no detail page.
export function buildSite({ scorecard, details = {}, thresholds = {}, generatedAt = null }) {
  const files = {
    '.nojekyll': '',
    'index.html': renderIndex(scorecard, { thresholds, generatedAt }),
    'scorecard.json': JSON.stringify(scorecard, null, 2) + '\n',
    'scorecard.md': formatScorecard(scorecard),
  };
  // Every registered suite (thresholds keys) gets a badge: a missing file is a 404 that
  // shields.io renders as a red "resource not found" in the README.
  for (const suite of new Set([...Object.keys(thresholds), ...Object.keys(scorecard.suites)])) {
    files[`badges/${suite}.json`] = JSON.stringify(formatBadge(suite, scorecard.suites[suite]?.runs?.[0])) + '\n';
  }
  for (const { runs = [] } of Object.values(scorecard.suites)) {
    for (const run of runs) {
      const detail = details[run.run_id];
      if (!detail) continue;
      files[`${runFile(run.run_id)}.json`] = JSON.stringify(detail) + '\n';
      files[`${runFile(run.run_id)}.html`] = renderRun(detail);
    }
  }
  return files;
}
