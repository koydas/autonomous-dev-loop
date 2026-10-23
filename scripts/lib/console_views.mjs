// Overview and Diagnostics views of the dashboard (ADR-0043), and the pieces they share with the
// Pipelines and Investigation pages: status tones, the journey of a work item, key events of a run, the
// filter bar and the browser-side GitHub PR states. Presentation only: the data comes from
// pipeline_journey.mjs, pipeline_kpis.mjs and pipeline_diagnostics.mjs. Every record string is escaped;
// inline styles carry computed numbers only; client scripts write textContent, never HTML.
import { escapeHtml as e } from './eval_site.mjs';
import { safeUrl } from './pipeline_model.mjs';
import { journeys as journeysOf, STATES, STEPS } from './pipeline_journey.mjs';
import { computeOverview, computeWindows, DEFINITIONS, RUN_CLASSES } from './pipeline_kpis.mjs';
import { diagnose, RULES } from './pipeline_diagnostics.mjs';
import { waitingOnYou } from './pipeline_waiting.mjs';
import { leverFor, LEVERS, NO_LEVER, FORBIDDEN_REASONS } from './meta_levers.mjs';
import { costAmount, costBasis } from './llm_cost.mjs';

/** Everything the console views render, computed once per build. */
export function consoleContext(model, { protectedPaths } = {}) {
  const journeys = journeysOf(model);
  return {
    journeys, traces: model?.traces ?? [], overview: computeOverview({ model, journeys }), windows: computeWindows({ model, journeys }),
    diagnosis: diagnose({ model, journeys, protectedPaths }), waiting: waitingOnYou({ model, journeys, protectedPaths }),
  };
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

export const TONE_ICON = Object.freeze({ good: '✓', bad: '✕', warn: '!', neutral: '–', unknown: '○' });
const TONE_WORD = { good: 'ok', bad: 'failed', warn: 'attention', neutral: 'neutral', unknown: 'not recorded' };
export const toneMark = (tone) => `<span class="tone-mark tone-${tone}" aria-hidden="true">${TONE_ICON[tone] ?? '○'}</span>`;
export const pill = (tone, text, attrs = '') => `<span class="pill tone-${tone}"${attrs}>${toneMark(tone)}${e(text)}</span>`;
const SEVERITY_TONE = { critical: 'bad', warning: 'warn', info: 'neutral' };
const pct = (v) => (v == null ? '—' : v > 0 && v < 0.01 ? `${(v * 100).toFixed(1)} %` : `${Math.round(v * 100)} %`);
const time = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—');
export const itemTitle = (item) => (item ? `${item.kind === 'issue' ? 'Issue' : item.kind === 'pr' ? 'PR' : 'Run'} #${item.number}` : 'Unlinked work');
export const itemUrl = (item) => (item && item.kind !== 'run' ? `https://github.com/koydas/autonomous-dev-loop/${item.kind === 'issue' ? 'issues' : 'pull'}/${encodeURIComponent(item.number)}` : null);
const runHref = (root, id) => `${root}runs/${encodeURIComponent(id)}.html`;

export function duration(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return '—';
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  if (v < 3600000) return `${Math.round(v / 60000)} min`;
  if (v < 86400000) return `${(v / 3600000).toFixed(1)} h`;
  return `${(v / 86400000).toFixed(1)} d`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export const CONSOLE_STYLE = `
:root { --bad-bg:color-mix(in srgb, var(--critical) 13%, var(--surface)); --warn-bg:color-mix(in srgb, var(--warning) 14%, var(--surface)); --good-bg:color-mix(in srgb, var(--good) 12%, var(--surface)); }
.tone-good { --tone:var(--good); } .tone-bad { --tone:var(--critical); } .tone-warn { --tone:var(--warn-ink); } .tone-neutral { --tone:var(--ink-2); } .tone-unknown { --tone:var(--muted); }
.tone-mark { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:50%; border:1.5px solid var(--tone); color:var(--tone); font-size:12px; font-weight:800; line-height:1; flex:none; }
.tone-unknown .tone-mark,.tone-mark.tone-unknown { border-style:dashed; }
.pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px 3px 4px; border-radius:20px; border:1px solid var(--border); color:var(--tone); font-size:12px; font-weight:650; background:var(--surface); white-space:nowrap; }
.pill.tone-bad { background:var(--bad-bg); } .pill.tone-warn { background:var(--warn-bg); }
.status-banner { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:18px 20px; border:1px solid var(--border); border-left:6px solid var(--tone); border-radius:var(--radius); background:var(--surface); margin:20px 0; }
.status-banner .tone-mark { width:34px; height:34px; font-size:18px; }
.status-banner h2 { margin:0; font-size:20px; }
.status-banner p { margin:4px 0 0; color:var(--ink-2); font-size:13px; }
.status-banner > div { flex:1; min-width:220px; }
.kpi-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin:18px 0; }
.kpi { display:flex; flex-direction:column; gap:6px; padding:16px 18px; border:1px solid var(--border); border-top:4px solid var(--tone, var(--border)); border-radius:12px; background:var(--surface); color:var(--ink); text-decoration:none; min-width:0; }
.kpi:hover { border-color:var(--s1); }
.kpi .kpi-value { font-size:30px; font-weight:750; letter-spacing:-.8px; line-height:1.1; color:var(--tone, var(--ink)); font-variant-numeric:tabular-nums; }
.kpi .kpi-label { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.8px; color:var(--ink-2); }
.kpi .kpi-note { font-size:12px; color:var(--muted); }
.kpi-def { font-size:11px; }
.console-grid { display:grid; grid-template-columns:minmax(0,3fr) minmax(0,2fr); gap:16px; }
.panel { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); padding:18px 20px; min-width:0; margin:16px 0; }
.panel > h3 { margin:0 0 12px; display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:baseline; }
.panel > h3 a { font-size:13px; font-weight:600; }
.problem-list,.state-list,.key-events,.gap-list { list-style:none; margin:0; padding:0; }
.problem-list li,.state-list li { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-top:1px solid var(--grid); }
.problem-list li:first-child,.state-list li:first-child { border-top:0; }
.problem-list p,.state-list p { margin:2px 0 0; font-size:12px; color:var(--muted); }
.state-list li { align-items:center; } .state-list .count { margin-left:auto; font-weight:700; font-variant-numeric:tabular-nums; }
.state-list li[data-resolved] { opacity:.55; }
.stackbar { display:flex; height:12px; border-radius:6px; overflow:hidden; background:var(--grid); margin:4px 0 14px; }
.stackbar span { display:block; height:100%; background:var(--tone); }
.stackbar span + span { border-left:2px solid var(--surface); }
.trend-note { font-size:13px; color:var(--ink-2); }
.finding { border:1px solid var(--border); border-left:5px solid var(--tone); border-radius:12px; background:var(--surface); padding:16px 20px; margin:14px 0; scroll-margin-top:100px; }
.finding header { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.finding h2 { font-size:18px; margin:0; flex:1; min-width:200px; }
.finding .eyebrow { margin-right:4px; }
.facts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 20px; margin:12px 0; }
.facts dt { font-size:11px; font-weight:750; text-transform:uppercase; letter-spacing:.8px; color:var(--ink-2); }
.facts dd { margin:2px 0 0; font-size:14px; }
.facts .wide { grid-column:1 / -1; }
.hypothesis, .lever { border:1px dashed var(--axis); border-radius:8px; padding:8px 12px; background:var(--page); }
.hypothesis dt::after { content:' — interpretation, not verified'; text-transform:none; letter-spacing:0; font-weight:500; color:var(--muted); }
.lever dt::after { content:' — where to look, not verified'; text-transform:none; letter-spacing:0; font-weight:500; color:var(--muted); }
.lever ul, .targets { margin:6px 0; padding-left:20px; }
.nowrap { white-space:nowrap; }
.lever .copy { user-select:all; }
@media(min-width:761px) and (max-width:1180px) { .finding { scroll-margin-top:130px; } }
.gap-list li { padding:10px 0; border-top:1px solid var(--grid); }
.gap-list li:first-child { border-top:0; }
.key-events li { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; padding:8px 0; border-top:1px solid var(--grid); }
.key-events li:first-child { border-top:0; }
.key-events .ke-meta { grid-column:2; font-size:12px; color:var(--muted); }
.journey { list-style:none; padding:0; margin:12px 0; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; }
.journey > li { border:1px solid var(--border); border-top:4px solid var(--tone); border-radius:10px; padding:10px 12px; background:var(--surface); min-width:0; }
.journey strong { display:block; font-size:13px; }
.journey p { margin:4px 0 0; font-size:12px; color:var(--ink-2); }
.attempt-strip { display:flex; flex-wrap:wrap; gap:3px; margin-top:6px; }
.attempt-strip a,.attempt-strip span { text-decoration:none; }
.filterbar { display:flex; flex-wrap:wrap; gap:10px 12px; align-items:end; margin:16px 0; padding:14px; border:1px solid var(--border); border-radius:12px; background:var(--surface); }
.filterbar label { display:grid; gap:4px; font-size:12px; color:var(--ink-2); }
.filterbar label.grow { flex:1; min-width:180px; }
.filterbar input,.filterbar select { min-height:40px; padding:6px 10px; border:1px solid var(--border); border-radius:8px; font:inherit; color:var(--ink); background:var(--surface); width:100%; }
.filterbar [data-filter-count] { font-size:13px; color:var(--muted); margin-left:auto; }
.tablist { display:flex; gap:2px; border-bottom:1px solid var(--border); margin:18px 0 0; overflow-x:auto; }
.tab { border:0; border-radius:0; background:none; min-height:40px; padding:8px 14px; color:var(--ink-2); font-weight:600; box-shadow:inset 0 -2px 0 transparent; white-space:nowrap; }
.tab:hover { background:var(--surface); }
.tab[aria-selected="true"] { color:var(--ink); box-shadow:inset 0 -2px 0 var(--accent); }
[data-tabs] > section[role="tabpanel"] > h2:first-child { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.trace-overview { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:16px; align-items:start; }
.trace-overview .key-info { margin-top:16px; }
@media(max-width:1000px) { .trace-overview { grid-template-columns:1fr; } }
.finding-meta { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin:6px 0 0; }
.chip-row { display:flex; flex-wrap:wrap; gap:6px; margin:14px 0 10px; }
.chip { min-height:30px; padding:3px 12px; border-radius:16px; font-size:12px; font-weight:600; color:var(--ink-2); background:var(--surface); }
.chip .n { color:var(--muted); font-variant-numeric:tabular-nums; }
.chip[aria-pressed="true"] { color:var(--ink); background:var(--accent-soft); border-color:var(--accent); }
@media(max-width:760px) { .status-banner { padding:12px 14px; gap:10px; } .status-banner h2 { font-size:16px; } .status-banner .tone-mark { width:26px; height:26px; font-size:14px; } .nav2 { flex-wrap:nowrap; overflow-x:auto; white-space:nowrap; } .finding { padding:14px; } .finding h2 { font-size:16px; } }
.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.crumbs { font-size:13px; color:var(--muted); margin:0 0 8px; }
.crumbs a { color:var(--ink-2); }
@media(max-width:900px) { .kpi-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .console-grid { grid-template-columns:1fr; } .journey { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:600px) { .kpi-grid { grid-template-columns:1fr 1fr; gap:10px; } .kpi { padding:12px; } .kpi .kpi-value { font-size:24px; } .facts { grid-template-columns:1fr; } .journey { grid-template-columns:1fr; } .filterbar label { flex:1 1 140px; } .filterbar [data-filter-count] { margin-left:0; width:100%; } }
`;

// ---------------------------------------------------------------------------
// Client scripts
// ---------------------------------------------------------------------------

// PR states from the public GitHub API: the only source of merge facts (merged_at). At most 10 pages of
// 100, cached for 5 minutes in sessionStorage (best effort). Issue hints: the repository-owned
// ai/issue-<n> branch, else the first same-repository closing reference of the body (64 KiB).
export const PR_STATES_SCRIPT = `<script>
function adlIssueHint(pr) {
 const branch = pr.head?.repo?.full_name === 'koydas/autonomous-dev-loop' && /^ai\\/issue-(\\d{1,9})$/.exec(pr.head?.ref || '');
 const closing = /(?:^|[^\\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \\t]*:?[ \\t]+#(\\d{1,9})\\b/i.exec(String(pr.body || '').slice(0, 65536));
 // Normalize like branchIssue(): ai/issue-007 joins issue 7; issue 0 is no hint.
 const asIssue = m => m && Number(m[1]) > 0 ? String(Number(m[1])) : '';
 return asIssue(branch) || asIssue(closing);
}
async function adlPullStates() {
 try { const c = JSON.parse(sessionStorage.getItem('adl-pulls-v1') || 'null'); if (c && Date.now() - c.at < 300000 && Array.isArray(c.pulls)) return c; } catch {}
 const pulls = []; let more = false;
 for (let page = 1; page <= 10; page++) {
  const response = await fetch('https://api.github.com/repos/koydas/autonomous-dev-loop/pulls?state=all&sort=updated&direction=desc&per_page=100&page=' + page, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error('GitHub HTTP ' + response.status);
  const prs = await response.json(); if (!Array.isArray(prs)) throw new Error('Invalid GitHub response');
  for (const p of prs) if (Number.isSafeInteger(p.number) && p.number > 0) pulls.push({ number: p.number, state: p.state === 'open' ? 'open' : 'closed', merged_at: typeof p.merged_at === 'string' ? p.merged_at : null, merge_commit_sha: typeof p.merge_commit_sha === 'string' ? p.merge_commit_sha : null, title: String(p.title || ''), hint: adlIssueHint(p) });
  more = prs.length === 100; if (!more) break;
 }
 const out = { at: Date.now(), pulls, more };
 try { sessionStorage.setItem('adl-pulls-v1', JSON.stringify(out)); } catch {}
 return out;
}
// Merge state of a work item: its recorded PR numbers first, else PRs whose hint names its issue, unless
// another work item recorded that PR (recorded identity takes precedence over a hint).
function adlMergeOf(prs, issue, pulls, claimed = new Set()) {
 const own = pulls.filter(p => prs.includes(p.number) || (issue && !prs.length && p.hint === issue && !claimed.has(p.number)));
 const merged = own.filter(p => p.merged_at).sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))[0];
 if (merged) return { state: 'merged', pr: merged };
 if (own.length && own.every(p => p.state === 'closed')) return { state: 'closed', pr: own[0] };
 if (own.some(p => p.state === 'open')) return { state: 'open', pr: own.find(p => p.state === 'open') };
 return { state: 'unknown', pr: null };
}
</script>`;

// Filter bars: [data-filter-scope] holds [data-filter-key] controls and [data-filter-item] entries.
// A select matches one token of the item's data-<key> (space separated); q matches the text; period keeps
// items whose data-last is within N days of the scope's data-ref. Values are kept in the URL query.
export const FILTER_SCRIPT = `<script>
(() => {
 for (const box of document.querySelectorAll('[data-filter-scope]')) {
  const controls = [...box.querySelectorAll('[data-filter-key]')];
  const params = new URLSearchParams(location.search);
  for (const c of controls) { const v = params.get(c.dataset.filterKey); if (v != null && (c.tagName !== 'SELECT' || [...c.options].some(o => o.value === v))) c.value = v; }
  const apply = () => {
   const items = [...box.querySelectorAll('[data-filter-item]')];
   const want = controls.map(c => [c.dataset.filterKey, c.value.trim().toLowerCase()]).filter(([, v]) => v);
   const ref = Number(box.dataset.ref) || 0;
   // Sidebar facets: a group with every box checked filters nothing; otherwise one checked token must match.
   const facets = {};
   for (const f of document.querySelectorAll('[data-facet]')) (facets[f.dataset.facet] = facets[f.dataset.facet] || []).push(f);
   const groups = Object.entries(facets).filter(([, boxes]) => !boxes.every(b => b.checked));
   let n = 0;
   for (const it of items) {
    const tokens = (k) => String(it.dataset[k] || '').split(' ');
    const ok = groups.every(([k, boxes]) => boxes.some(b => b.checked && tokens(k).includes(b.value))) && want.every(([k, v]) => {
     if (k === 'q') return it.textContent.toLowerCase().includes(v);
     if (k === 'period') return ref - (Number(it.dataset.last) || 0) <= Number(v) * 86400000;
     return String(it.dataset[k] || '').toLowerCase().split(' ').includes(v);
    });
    it.hidden = !ok; if (ok) n++;
   }
   const count = box.querySelector('[data-filter-count]'); if (count) count.textContent = n + ' of ' + items.length + ' shown';
   const empty = box.querySelector('[data-filter-empty]'); if (empty) empty.hidden = n !== 0 || !items.length;
   const next = new URLSearchParams(location.search);
   for (const c of controls) { if (c.value.trim()) next.set(c.dataset.filterKey, c.value.trim()); else next.delete(c.dataset.filterKey); }
   const qs = next.toString();
   try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch {}
  };
  // Chips set the control they name (data-chip = its filter key) and show which value is active.
  const chips = [...box.querySelectorAll('[data-chip]')];
  const press = () => { for (const c of chips) { const ctl = controls.find(x => x.dataset.filterKey === c.dataset.chip); c.setAttribute('aria-pressed', String((ctl?.value || '') === c.dataset.chipValue)); } };
  for (const c of chips) c.addEventListener('click', () => { const ctl = controls.find(x => x.dataset.filterKey === c.dataset.chip); if (ctl) { ctl.value = c.dataset.chipValue; ctl.dispatchEvent(new Event('change', { bubbles: true })); } });
  box.addEventListener('input', apply); box.addEventListener('change', apply); box.addEventListener('change', press); box.addEventListener('adl:refilter', apply); apply(); press();
 }
 document.addEventListener('change', (ev) => { if (ev.target.matches?.('[data-facet]')) for (const b of document.querySelectorAll('[data-filter-scope]')) b.dispatchEvent(new Event('adl:refilter')); });
})();
</script>`;

// Tabs: each [data-tabs] > section[data-tab] becomes a tab panel; without JavaScript every section shows.
// The open tab is kept in the URL hash (#tab-…).
export const TABS_SCRIPT = `<script>
(() => {
 for (const box of document.querySelectorAll('[data-tabs]')) {
  const panels = [...box.querySelectorAll(':scope > section[data-tab]')];
  const list = document.createElement('div'); list.className = 'tablist'; list.setAttribute('role', 'tablist');
  const tabs = panels.map((p) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'tab'; b.setAttribute('role', 'tab'); b.textContent = p.dataset.tab; b.setAttribute('aria-controls', p.id); p.setAttribute('role', 'tabpanel'); list.append(b); return b; });
  const show = (i, push) => { panels.forEach((p, k) => { p.hidden = k !== i; tabs[k].setAttribute('aria-selected', String(k === i)); tabs[k].tabIndex = k === i ? 0 : -1; }); if (push) try { history.replaceState(null, '', '#' + panels[i].id); } catch {} };
  tabs.forEach((t, i) => { t.addEventListener('click', () => show(i, true)); t.addEventListener('keydown', (ev) => { const d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0; if (d) { const n = (i + d + tabs.length) % tabs.length; show(n, true); tabs[n].focus(); } }); });
  box.prepend(list);
  const start = panels.findIndex((p) => '#' + p.id === location.hash);
  show(start < 0 ? 0 : start, false);
 }
})();
</script>`;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const STATUS_TEXT = {
  critical: (n) => `Attention needed: ${n} critical problem(s) detected`,
  warning: (n) => `Running with issues: ${n} problem(s) to look at`,
  ok: () => 'No problem detected by the rules',
  no_data: () => 'No pipeline run recorded yet',
};
const STATUS_TONE = { critical: 'bad', warning: 'warn', ok: 'good', no_data: 'unknown' };

export function statusBanner(diagnosis, overview, root) {
  const { status, findings, gaps } = diagnosis;
  const serious = findings.filter((f) => f.severity !== 'info').length;
  const w = overview.window;
  const scope = w.runs ? `${w.runs} run(s), ${w.items} work item(s), ${time(w.from)} → ${time(w.to)} UTC` : 'No run record on the metrics branch';
  return `<div class="status-banner tone-${STATUS_TONE[status]}" role="status">${toneMark(STATUS_TONE[status])}<div><h2>${e(STATUS_TEXT[status](status === 'critical' ? findings.filter((f) => f.severity === 'critical').length : serious))}</h2><p>${e(scope)} · ${e(gaps.length)} data gap(s) limit what the rules can see${status === 'ok' ? ': no finding is not proof of health' : ''}.</p></div><a class="button-link" href="${root}diagnostics.html">Open diagnostics →</a></div>`;
}

const CLASS_TONE = { failed: 'bad', adverse: 'warn', progressed: 'good', neutral: 'unknown' };
const CLASS_LABEL = { failed: 'failed', adverse: 'adverse decision', progressed: 'moved forward', neutral: 'skip / no decision' };

/** Runs per day stacked by class (inline SVG, values in a table below). */
export function trendChart(trend, { W = 720, H = 180 } = {}) {
  if (!trend.days.length) return '<p class="muted">No dated run recorded.</p>';
  const L = 32, R = 8, T = 10, B = 26;
  const top = Math.max(1, ...trend.days.map((d) => d.total));
  const slot = (W - L - R) / trend.days.length;
  const bw = Math.min(28, slot - 6);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const cols = trend.days.map((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    let base = y(0);
    const segs = RUN_CLASSES.filter((c) => d[c] > 0).map((c) => {
      const h = y(0) - y(d[c]);
      base -= h;
      return `<rect x="${x.toFixed(1)}" y="${base.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - 1).toFixed(1)}" rx="2" class="tone-${CLASS_TONE[c]}" fill="var(--tone)"/>`;
    }).join('');
    const label = i % 2 === trend.days.length % 2 ? '' : `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${e(d.day.slice(5))}</text>`;
    return `<g><title>${e(`${d.day}: ${d.total} run(s) · ${RUN_CLASSES.map((c) => `${CLASS_LABEL[c]} ${d[c]}`).join(', ')}`)}</title>${segs}${label}</g>`;
  }).join('');
  const legend = `<div class="legend">${RUN_CLASSES.map((c) => `<span>${toneMark(CLASS_TONE[c])} ${e(CLASS_LABEL[c])}</span>`).join('')}</div>`;
  const rows = trend.days.filter((d) => d.total).map((d) => `<tr><td>${e(d.day)}</td>${RUN_CLASSES.map((c) => `<td class="num">${e(d[c])}</td>`).join('')}<td class="num">${e(d.total)}</td></tr>`).join('');
  return `${legend}<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Runs per day by class over ${trend.days.length} days; values in the table"><line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)"/><text x="${L - 6}" y="${y(top) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${top}</text>${cols}</svg></div><details><summary>Values</summary><div class="table-wrap"><table><thead><tr><th>Day</th>${RUN_CLASSES.map((c) => `<th class="num">${e(CLASS_LABEL[c])}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

export function definitionsPanel() {
  const rows = Object.entries(DEFINITIONS).map(([id, d]) => `<tr id="def-${id}"><th>${e(d.label)}</th><td>${e(d.source)}</td><td>${e(d.method)}</td><td>${e(d.period)}</td><td>${e(d.population)}</td><td>${e(d.limits)}</td></tr>`).join('');
  return `<details class="detail-panel" id="definitions"><summary>Metric definitions · source, method, period, population, limits</summary><div class="table-wrap"><table><thead><tr><th>Indicator</th><th>Source</th><th>Method</th><th>Period</th><th>Population</th><th>Known limits</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

// ---------------------------------------------------------------------------
// Diagnostics page body
// ---------------------------------------------------------------------------

function evidenceTable(f, root) {
  if (!f.evidence.length) return '';
  const rows = f.evidence.map((ev) => `<tr><td>${e(time(ev.ts))}</td><td><a href="${runHref(root, ev.run_id)}">${e(ev.run_id)}</a></td><td>${ev.pr ? `#${e(ev.pr)}` : '—'}</td><td><code>${e(ev.event ?? '—')}</code></td><td class="wrap">${e(ev.summary || '—')}</td><td>${ev.url ? `<a href="${e(ev.url)}">GitHub</a>` : ''}</td></tr>`).join('');
  const more = f.runs.length > f.evidence.length ? `<p class="muted">First ${f.evidence.length} entries; ${f.runs.length} run(s) affected.</p>` : '';
  return `<details><summary>Evidence · ${e(f.evidence.length)} entr${f.evidence.length === 1 ? 'y' : 'ies'}</summary><div class="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Run</th><th>PR</th><th>Event</th><th>Recorded detail</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>${more}</details>`;
}

// ADR-0047 §3: where a mapped, active warning / critical finding may be acted on. Under the hypothesis, never
// above the fact; absent without a lever. Every string comes from the lever table, escaped like the rest.
/** What applying a lever target requires, in words: a live eval suite, or a check by hand when none measures it. */
export const requirementLabel = (target) => (target.requires === 'evals'
  ? `run the live evals.yml (suite ${target.gate})`
  : 'no eval suite measures it: verify by hand and say so in the PR');

/** The `ai-dev-tools` command that drafts a proposal for one finding; its `--finding` value is the finding's `key` in findings.json. */
export const leverCommand = (f) => `/ai-dev-tools:loop-insights --finding ${f.id}`;

function leverBlock(f, root) {
  const lever = leverFor(f);
  if (!lever) return '';
  const targets = lever.targets.map((t) => `<li><code>${e(t.ref)}</code> <span class="muted">· ${e(requirementLabel(t))}</span></li>`).join('');
  return `<div class="wide lever"><dt>Suggested lever</dt><dd><p>${e(lever.summary)}</p><ul>${targets}</ul><p class="muted">Stage ${e(lever.stage)} · ${lever.adr.map((a) => `ADR-${e(a)}`).join(', ')} · every change also requires <code>docs-and-tests</code>; the lever says where to look, not what caused the finding (<a href="${root}levers.html#rule-${e(f.id)}">this rule's entry</a>).</p><p class="muted">Draft a proposal (read-only, nothing is posted or created): <code class="copy">${e(leverCommand(f))}</code></p></dd></div>`;
}

export function findingCard(f, root) {
  const tone = SEVERITY_TONE[f.severity];
  const since = f.evidence.map((x) => x.ts).filter((t) => typeof t === 'number');
  const meta = `<p class="finding-meta"><span>Affects ${e(f.runs.length)} run(s)${f.items.length ? ` · ${e(f.items.length)} item(s)` : ''}</span>${since.length ? `<span>Since <span data-ts="${Math.min(...since)}">${e(time(Math.min(...since)))} UTC</span></span>` : ''}${f.status ? `<span>${e(f.status)}${Number.isFinite(f.last_seen) ? ` · last seen <span data-ts="${f.last_seen}">${e(time(f.last_seen))} UTC</span>` : ''}</span>` : ''}</p>`;
  return `<article class="finding tone-${tone}" id="${e(f.id)}" data-filter-item data-severity="${e(f.severity)}" data-category="${e(f.category.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}"><header>${pill(tone, f.severity)}<span class="eyebrow">${e(f.category)}</span><h2>${e(f.title)}</h2></header>${meta}
<dl class="facts"><div class="wide"><dt>Observed</dt><dd>${e(f.fact)}</dd></div><div><dt>Impact</dt><dd>${e(f.impact)}</dd></div><div><dt>Frequency</dt><dd>${e(f.frequency)}${f.runs.length ? ` · ${e(f.runs.length)} run(s) affected` : ''}</dd></div>${f.hypothesis ? `<div class="wide hypothesis"><dt>Hypothesis</dt><dd>${e(f.hypothesis)}</dd></div>` : ''}${leverBlock(f, root)}</dl>
${evidenceTable(f, root)}${f.link ? `<p><a class="button-link" href="${root}${e(f.link)}">Investigate →</a></p>` : ''}</article>`;
}

// ---------------------------------------------------------------------------
// Rules and levers page (ADR-0047): the lever table itself, so it cannot drift from the code
// ---------------------------------------------------------------------------

export function leversBody(root = '') {
  const withLever = Object.entries(LEVERS).map(([rule, l]) => {
    const targets = l.targets.map((t) => `<li><code>${e(t.ref)}</code> <span class="muted">· ${e(requirementLabel({ ...t, requires: t.gate ? 'evals' : 'no-eval-gate' }))}</span></li>`).join('');
    return `<tr id="rule-${e(rule)}"><th><code>${e(rule)}</code></th><td class="nowrap">${e(l.stage)}</td><td>${e(l.summary)}</td><td><ul class="targets">${targets}</ul></td><td>${l.adr.map((a) => `ADR-${e(a)}`).join(', ')}</td></tr>`;
  }).join('');
  const without = Object.entries(NO_LEVER).map(([rule, why]) => `<tr id="rule-${e(rule)}"><th><code>${e(rule)}</code></th><td>${e(why)}</td></tr>`).join('');
  return `<h1>Rules and levers</h1>
<p class="sub">Which setting or prompt governs the pattern each diagnostic rule reports (<code>LEVERS</code> and <code>NO_LEVER</code> in <code>scripts/lib/meta_levers.mjs</code>, ADR-0047): this page is generated from that table. A lever says where to look, not what caused a finding. A Diagnostics card shows it only for an <strong>active</strong> <code>warning</code> or <code>critical</code> finding of a rule below; an <code>info</code> finding (a guardrail working as designed) or a resolved one has none. When the rule fires and what counts as an anomaly: <a href="${root}diagnostics.html#rules">Rules and thresholds</a>.</p>
<section class="panel" id="with-lever"><h3>Rules with a lever</h3><div class="table-wrap"><table><thead><tr><th>Rule</th><th>Stage</th><th>What it governs</th><th>Where to look, and what a change requires</th><th>Decisions</th></tr></thead><tbody>${withLever}</tbody></table></div><p class="muted">Every change also needs docs and tests in the same pull request, and is applied by a person: the dashboard and <code>/loop-insights</code> create nothing on GitHub.</p></section>
<section class="panel" id="without-lever"><h3>Rules without a lever</h3><div class="table-wrap"><table><thead><tr><th>Rule</th><th>Why there is none</th></tr></thead><tbody>${without}</tbody></table></div></section>
<section class="panel" id="never"><h3>A lever never points at</h3><ul>${FORBIDDEN_REASONS.map((r) => `<li>${e(r)}</li>`).join('')}</ul><p class="muted">ADR-0046 §5: no lever lowers a threshold, removes a dataset case or weakens a gate.</p></section>`;
}

/**
 * The line that ties the page to its machine-readable copy: `findings.json` at the site root, the input of
 * `/ai-dev-tools:loop-insights` (ADR-0047). It states what the file holds (the findings above, over the same runs)
 * and when it was generated, so an old file is visible from the page.
 */
export function exportNote(diagnosis, overview, root = '', generatedAt = null) {
  const runs = overview.window.runs;
  const stamp = typeof generatedAt === 'string' && generatedAt ? `, generated <time datetime="${e(generatedAt)}">${e(generatedAt)}</time>` : '';
  return `<p class="export-note muted">Machine-readable copy: <a href="${root}../findings.json">findings.json</a> — the ${e(diagnosis.findings.length)} finding(s) below, over ${e(runs)} recorded run(s)${stamp}. It is the input of <code>/ai-dev-tools:loop-insights</code> (<a href="${root}levers.html">Rules and levers</a>).</p>`;
}

export function diagnosticsBody(ctx, root = '', { generatedAt = null } = {}) {
  const { diagnosis: d, overview: o } = ctx;
  const categories = [...new Set(d.findings.map((f) => f.category))];
  const counts = ['critical', 'warning', 'info'].map((s) => `${d.findings.filter((f) => f.severity === s).length} ${s}`).join(' · ');
  // The severity select is driven by the chips above it: kept for the URL and the filter, not shown.
  const select = (key, label, values) => `<label${key === 'severity' ? ' hidden' : ''}>${e(label)}<select data-filter-key="${key}"><option value="">All</option>${values.map(([v, l]) => `<option value="${e(v)}">${e(l)}</option>`).join('')}</select></label>`;
  const gaps = d.gaps.map((g) => `<li>${pill('unknown', 'insufficient data')} <strong>${e(g.title)}</strong><p class="muted">${e(g.detail)}</p></li>`).join('');
  return `<h1>Diagnostics</h1>
<p class="sub">Problems detected by fixed rules over ${e(o.window.runs)} recorded run(s) and ${e(o.window.items)} work item(s) — no LLM involved. Each finding separates what was <strong>observed</strong> from a <strong>hypothesis</strong> about it, and lists the runs it was computed from.</p>
${statusBanner(d, o, root).replace(/<a class="button-link"[^>]*>[^<]*<\/a>/, '')}
${exportNote(d, o, root, generatedAt)}
<section data-filter-scope><div class="chip-row" role="group" aria-label="Severity">${[['', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']].map(([v, l]) => `<button type="button" class="chip" data-chip="severity" data-chip-value="${v}">${l} <span class="n">${v ? d.findings.filter((f) => f.severity === v).length : d.findings.length}</span></button>`).join('')}</div><div class="filterbar">${select('severity', 'Severity', [['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']])}${select('category', 'Category', categories.map((c) => [c.toLowerCase().replace(/[^a-z0-9]+/g, '-'), c]))}<span data-filter-count role="status">${e(counts)}</span></div>
<p data-filter-empty class="muted" hidden>No finding matches these filters.</p>
${d.findings.map((f) => findingCard(f, root)).join('') || '<div class="panel"><p>No rule fired on the recorded data. That is not proof of health: see the data gaps below.</p></div>'}</section>
<section class="panel" id="data-gaps"><h3>Data gaps · what the records cannot tell</h3><ul class="gap-list">${gaps || '<li class="muted">None detected.</li>'}</ul></section>
<details class="detail-panel" id="rules"><summary>Rules and thresholds</summary><p class="sub">A pattern is reported only above these thresholds (<code>RULES</code> in <code>scripts/lib/pipeline_diagnostics.mjs</code>); below them it is not separated from noise. Which setting governs each rule: <a href="${root}levers.html">Rules and levers</a>.</p><div class="table-wrap"><table><tbody>${Object.entries(RULES).map(([k, v]) => `<tr><th><code>${e(k)}</code></th><td class="num">${e(v)}</td></tr>`).join('')}</tbody></table></div></details>
${FILTER_SCRIPT}`;
}

// ---------------------------------------------------------------------------
// Journey (trace page) and key events (run page)
// ---------------------------------------------------------------------------

/** Step summary of a work item: final status, decision, attempts (linked) and what earlier ones hid. */
export function journeyPanel(j, root = '../') {
  const steps = j.steps.map((s) => {
    const tone = s.final ? s.final.tone : 'unknown';
    const strip = s.attempts.map((a, i) => `<a href="${runHref(root, a.run_id)}" title="${e(`#${i + 1} ${a.status}${a.decision ? ` · ${a.decision.label}` : ''} · ${time(a.started_at)}`)}"><span class="tone-mark tone-${a.tone}" aria-hidden="true">${TONE_ICON[a.tone]}</span><span class="visually-hidden">Attempt ${i + 1}: ${e(TONE_WORD[a.tone])}</span></a>`).join('');
    const final = s.final ? `${e(s.final.status.replace('-', ' '))}${s.final.decision ? ` · ${e(s.final.decision.label)}${s.final.decision.reason ? ` (${e(s.final.decision.reason)})` : ''}` : ''}` : e(s.note ?? 'Not recorded');
    const history = s.attempts.length > 1 ? `<p>${e(s.attempts.length)} attempts · ${e(s.failures)} failed · ${e(s.adverse)} adverse${s.recovered ? ' · recovered' : ''}</p>` : '';
    return `<li class="tone-${tone}"><strong>${toneMark(tone)} ${e(s.name)}</strong><p>${final}</p>${history}${strip ? `<div class="attempt-strip" aria-label="Attempts in order">${strip}</div>` : ''}</li>`;
  }).join('');
  const esc = j.escalations.map((x) => `<li>${toneMark('warn')}<div><strong>${e(x.event)}</strong>${x.reason ? ` · ${e(x.reason)}` : ''} · ${e(time(x.ts))} · <a href="${runHref(root, x.run_id)}">run ${e(x.run_id)}</a>${x.url ? ` · <a href="${e(x.url)}">GitHub</a>` : ''}</div></li>`).join('');
  return `<section class="panel"><h3>Journey ${pill(j.tone, j.label)}</h3><ol class="journey" aria-label="Pipeline steps">${steps}</ol><p class="trend-note">${j.closing ? `Journaled: ${j.closing.merged ? 'merged' : 'closed'} ${e(time(j.closing.ts))} UTC.` : 'No merge or closing journaled (only items closed since item-closed.yml are): check the PR on GitHub'}${j.prs.length ? ` (${j.prs.map((n) => `<a href="https://github.com/koydas/autonomous-dev-loop/pull/${n}">#${n}</a>`).join(', ')})` : ''} or the Pipelines page.</p>${esc ? `<h3>Interventions</h3><ul class="problem-list">${esc}</ul>` : ''}</section>`;
}

const KEY_EVENT = /(\.verdict|\.skipped|\.escalated|\.push|\.pass|\.fail|\.complete|\.error|\.max_attempts_reached|\.pr_operation|\.comment_posted|^llm_fallback|^llm_provider_error|^llm_call_failed)$/;

// Meta keys eventSummary() leaves out but that explain a key event (coverage, fallback route, score).
const KEY_DETAIL = ['withheld_from', 'unreviewed_code_files', 'diff_truncated', 'max_input_tokens', 'from', 'to', 'score', 'blockers_count', 'changes_count', 'source'];

/** Decisions, errors, warnings and side effects of a run, before its full journal. */
export function keyEvents(run, summarize) {
  const list = run.events.map((ev, i) => ({ ev, i })).filter(({ ev }) => ev.level === 'error' || (ev.level === 'warn' && ev.event !== 'retry.wait') || KEY_EVENT.test(ev.event));
  const waits = run.events.filter((ev) => ev.event === 'retry.wait');
  const tone = (ev) => {
    if (ev.level === 'error' || /\.error$|failed$/.test(ev.event)) return 'bad';
    if (ev.event === 'review.verdict') return ev.meta.verdict === 'APPROVE' ? 'good' : 'warn';
    if (ev.event === 'review.skipped' || (ev.event === 'autofix.skipped' && ev.meta.reason === 'approved')) return 'neutral';
    return ev.level === 'warn' || /escalated|skipped|fallback|\.fail$/.test(ev.event) ? 'warn' : 'good';
  };
  const detail = (meta) => [summarize(meta), ...KEY_DETAIL.filter((k) => meta[k] != null && meta[k] !== '').map((k) => `${k}=${Array.isArray(meta[k]) ? meta[k].join(',') : meta[k]}`)].filter(Boolean).join(' · ');
  const items = list.map(({ ev, i }) => `<li>${toneMark(tone(ev))}<div><a href="#ev-${i}"><code>${e(ev.event)}</code></a> ${e(detail(ev.meta))}${safeUrl(ev.meta.url) ? ` · <a href="${e(ev.meta.url)}">GitHub</a>` : ''}</div><span class="ke-meta">${e(time(ev.ts))} · ${e(ev.stage ?? '—')}</span></li>`).join('');
  const waitNote = waits.length ? `<p class="trend-note">${e(waits.length)} retry wait(s), ${e(duration(waits.reduce((t, ev) => t + (Number.isFinite(ev.meta.wait_ms) ? ev.meta.wait_ms : 0), 0)))} in total (in the full journal).</p>` : '';
  return `<section class="panel"><h3>Key events · decisions, errors, side effects</h3>${items ? `<ul class="key-events">${items}</ul>` : '<p class="muted">No decision, warning or error recorded in this run.</p>'}${waitNote}</section>`;
}

/** Step attempts of one run (run page): which step it ran, its status and its decision. */
export function runSteps(run, attemptOf) {
  const steps = [...new Set(run.stages.map((s) => s.stage).filter(Boolean))];
  if (!steps.length) return '';
  return `<ul class="state-list">${steps.map((s) => { const a = attemptOf(run, s); const name = STEPS.find((d) => d.key === s)?.name ?? s; return `<li>${toneMark(a.tone)}<div><strong>${e(name)}</strong> · execution ${e(a.status.replace('-', ' '))}${a.decision ? ` · decision ${e(a.decision.label)}${a.decision.reason ? ` (${e(a.decision.reason)})` : ''}` : ' · no decision recorded'}</div></li>`; }).join('')}</ul>`;
}
