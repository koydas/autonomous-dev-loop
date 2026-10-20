// Presentation only: the published scorecard, run records and trace indexes remain authoritative.
// No framework, credentials or third-party assets are needed by the generated pages.
import { costAmount, sumCosts } from './llm_cost.mjs';

const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (v) => String(v ?? 'Unknown').replace(/_/g, ' ');
const date = (v) => v == null || !Number.isFinite(new Date(v).getTime()) ? 'Not recorded' : new Date(v).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const itemName = (item) => item ? `${item.kind === 'issue' ? 'Issue' : item.kind === 'pr' ? 'PR' : 'Run'} #${item.number}` : 'Unlinked work';
const runUrl = (root, run) => `${root}runs/${encodeURIComponent(run.run_id)}.html`;
const outcome = (v) => v === 'success' ? 'good' : v === 'failed' ? 'bad' : 'neutral';
const badge = (v) => `<span class="result-badge ${outcome(v)}">${v === 'success' ? '✓' : v === 'failed' ? '✕' : '○'} ${e(label(v))}</span>`;
const metric = (title, value, note, href, tone = '') => `<a class="stat-card ${tone}" href="${e(href)}"><span class="eyebrow">${e(title)}</span><strong>${e(value)}</strong><span class="stat-note">${e(note)} <span aria-hidden="true">→</span></span></a>`;

// Console theme (ADR-0043): dark by default, light on demand (theme toggle, kept per browser). Declared after
// the eval page tokens, so it wins over both their light and dark sets.
export const DASHBOARD_STYLE = `
:root, :root:where(:not([data-theme="light"])) { color-scheme:dark; --page:#0a0f1d; --surface:#111a2c; --surface-2:#16213a; --ink:#e8edf7; --ink-2:#b3bed3; --muted:#8190ab; --border:#22304b; --grid:#1b2640; --axis:#2d3b58; --good:#22c55e; --critical:#f05252; --warning:#f59e0b; --warn-ink:#fbbf24; --accent:#7c5cff; --accent-soft:rgba(124,92,255,.16); --link:#7aa7ff; --s1:#7c5cff; --s2:#f97316; --s3:#22c55e; --s4:#eab308; --radius:12px; }
:root[data-theme="light"] { color-scheme:light; --page:#f4f6fb; --surface:#ffffff; --surface-2:#f7f8fc; --ink:#101828; --ink-2:#475467; --muted:#667085; --border:#e3e8f0; --grid:#edf0f6; --axis:#cfd6e3; --good:#16a34a; --critical:#dc2626; --warning:#d97706; --warn-ink:#b45309; --accent:#6941f5; --accent-soft:rgba(105,65,245,.10); --link:#2f5fe0; --s1:#6941f5; }
html { scroll-behavior:smooth; scroll-padding-top:90px; }
body { font-size:14px; -webkit-font-smoothing:antialiased; background:var(--page); color:var(--ink); }
a { color:var(--link); text-underline-offset:3px; }
a:hover { text-decoration-thickness:2px; }
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:4px; }
[hidden] { display:none !important; }
.skip-link { position:absolute; left:12px; top:-100px; z-index:30; background:var(--surface); padding:12px; }
.skip-link:focus { top:12px; }
.app-header { position:sticky; top:0; z-index:20; background:color-mix(in srgb, var(--page) 88%, transparent); backdrop-filter:blur(8px); border-bottom:1px solid var(--border); }
.app-header-inner { max-width:1480px; margin:auto; padding:10px 24px; display:flex; align-items:center; gap:22px; }
.brand { display:flex; align-items:center; gap:10px; font-weight:750; font-size:16px; color:var(--ink); text-decoration:none; letter-spacing:-.3px; white-space:nowrap; }
.brand-icon { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; color:#fff; background:linear-gradient(135deg,#8b5cf6,#6366f1); font-size:17px; }
.primary-nav { display:flex; gap:2px; }
.primary-nav a { display:inline-flex; align-items:center; gap:7px; padding:9px 12px; text-decoration:none; border-radius:8px; color:var(--ink-2); font-size:13px; font-weight:600; border-bottom:2px solid transparent; }
.primary-nav a:hover { color:var(--ink); background:var(--surface); }
.primary-nav a[aria-current="page"] { color:var(--ink); background:var(--accent-soft); box-shadow:inset 0 -2px 0 var(--accent); }
.nav-icon { width:16px; height:16px; flex:none; }
.header-tools { margin-left:auto; display:flex; align-items:center; gap:12px; font-size:12px; color:var(--muted); }
.updated-dot { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
.updated-dot::before { content:''; width:8px; height:8px; border-radius:50%; background:var(--good); }
.updated-dot:empty { display:none; }
.theme-toggle { min-height:32px; padding:4px 10px; font-size:12px; }
.source-link { font-size:12px; }
.app-body { max-width:1480px; margin:auto; display:grid; grid-template-columns:220px minmax(0,1fr); gap:0; }
.app-body.no-side { grid-template-columns:minmax(0,1fr); }
.sidebar { position:sticky; top:56px; align-self:start; max-height:calc(100vh - 56px); overflow:auto; padding:22px 14px 40px 20px; border-right:1px solid var(--border); }
.side-nav { display:grid; gap:2px; margin-bottom:22px; }
.side-nav a { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; color:var(--ink-2); text-decoration:none; font-weight:600; font-size:13px; }
.side-nav a:hover { background:var(--surface); color:var(--ink); }
.side-nav a[aria-current="page"] { background:var(--accent-soft); color:var(--ink); box-shadow:inset 3px 0 0 var(--accent); }
.nav-badge { margin-left:auto; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--critical); color:#fff; font-size:11px; display:inline-grid; place-items:center; }
.nav-badge:empty { display:none; }
.side-title { text-transform:uppercase; letter-spacing:1.1px; font-size:10.5px; font-weight:750; color:var(--muted); margin:18px 10px 8px; }
.facet { display:grid; gap:1px; margin:0 0 6px; border:0; padding:0; }
.facet legend { font-size:12px; font-weight:650; color:var(--ink-2); margin:10px 10px 6px; padding:0; }
.facet label { display:flex; align-items:center; gap:8px; padding:5px 10px; border-radius:6px; font-size:12.5px; color:var(--ink-2); cursor:pointer; }
.facet label:hover { background:var(--surface); }
.facet input { accent-color:var(--accent); width:15px; height:15px; margin:0; }
.facet .n { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; font-size:11.5px; }
.facet-note { font-size:11px; color:var(--muted); margin:8px 10px 0; line-height:1.4; }
main { max-width:none; margin:0; padding:24px 28px 80px; min-width:0; }
.legacy-nav { font-size:11px; margin:0 0 14px; color:var(--muted); }
.legacy-nav a { color:var(--muted); }
h1 { font-size:clamp(22px,3vw,28px); line-height:1.2; letter-spacing:-.6px; margin:0 0 4px; overflow-wrap:anywhere; }
h2 { font-size:18px; letter-spacing:-.3px; margin-top:28px; overflow-wrap:anywhere; }
h3 { font-size:15px; }
.sub { max-width:95ch; line-height:1.6; color:var(--ink-2); }
.eyebrow { text-transform:uppercase; letter-spacing:1.1px; font-size:10.5px; font-weight:750; color:var(--muted); }
.section-intro { display:flex; align-items:start; justify-content:space-between; flex-wrap:wrap; gap:12px; margin:24px 0 14px; }
.section-intro h2 { margin:0 0 4px; }
.section-intro p { margin:0; color:var(--muted); }
.card,.tile { border-radius:var(--radius); background:var(--surface); border:1px solid var(--border); }
.card { padding:16px; }
.tiles { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
.tile .value { font-size:22px; white-space:normal; overflow-wrap:anywhere; }
.tile .label { font-size:12px; }
.summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin:18px 0; }
.stat-card { display:flex; flex-direction:column; gap:8px; padding:18px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); color:var(--ink); text-decoration:none; min-width:0; }
.stat-card:hover { border-color:var(--accent); }
.stat-card strong { font-size:30px; line-height:1.15; letter-spacing:-1px; }
.stat-note { color:var(--muted); font-size:12px; }
.stat-card.good strong { color:var(--good); } .stat-card.bad strong { color:var(--critical); }
.widget-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.widget { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:18px; min-width:0; }
.widget h3 { margin:0; font-size:16px; }
.widget-head { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:start; margin-bottom:12px; }
.widget p { color:var(--ink-2); font-size:13px; overflow-wrap:anywhere; }
.widget-meta { display:flex; flex-wrap:wrap; gap:8px 18px; color:var(--muted); font-size:12px; margin:12px 0; }
.result-badge { display:inline-flex; align-items:center; gap:6px; border:1px solid currentColor; border-radius:30px; padding:2px 10px; font-size:12px; font-weight:650; line-height:1.5; }
.result-badge.good { color:var(--good); } .result-badge.bad { color:var(--critical); } .result-badge.neutral { color:var(--ink-2); }
.metric-big { font-size:30px; font-weight:750; letter-spacing:-1px; }
.metric-name { color:var(--muted); font-size:12px; display:block; }
meter { display:block; width:100%; height:10px; margin:12px 0; accent-color:var(--good); }
.button-link,button { display:inline-flex; justify-content:center; align-items:center; gap:6px; padding:8px 13px; min-height:38px; background:var(--surface); border:1px solid var(--border); border-radius:8px; font:inherit; font-size:13px; font-weight:600; color:var(--ink); text-decoration:none; cursor:pointer; }
.button-link:hover,button:hover { background:var(--surface-2); border-color:var(--accent); }
button:disabled { opacity:.6; cursor:wait; }
.link-row { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0; }
.detail-panel { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); padding:0 18px; margin:16px 0; }
.detail-panel > summary { color:var(--ink); font-weight:650; min-height:48px; padding:14px 0; }
.detail-panel[open] { padding-bottom:14px; }
.detail-panel .card { box-shadow:none; }
details summary { cursor:pointer; color:var(--ink); }
section[id],article[id] { scroll-margin-top:90px; }
.nav2 { display:flex; flex-wrap:wrap; padding:0 0 12px; gap:6px 16px; border-bottom:1px solid var(--border); margin:0 0 16px; font-size:13px; }
.nav2 a { padding:4px 0; color:var(--ink-2); }
.filters { background:var(--surface); border:1px solid var(--border); padding:12px; border-radius:var(--radius); }
.filters select,.filters input,input[type="search"],select[data-pick],select { min-height:38px; min-width:0; max-width:100%; border:1px solid var(--border); padding:7px 10px; border-radius:8px; font:inherit; color:var(--ink); background:var(--surface-2); }
.browse-toolbar { display:flex; flex-wrap:wrap; gap:12px; align-items:end; margin:18px 0; }
.browse-toolbar label { display:grid; gap:5px; font-size:12px; color:var(--ink-2); }
.browse-toolbar label:first-child { flex:1; min-width:180px; }
.browse-toolbar input { width:100%; }
.browse-count,.empty-message { color:var(--muted); font-size:13px; }
.flow-steps { list-style:none; padding:0; margin:18px 0; display:grid; gap:10px; }
.flow-step { position:relative; padding:14px 16px; border:1px solid var(--border); border-left:4px solid var(--accent); border-radius:10px; background:var(--surface); }
.flow-step .widget-head { margin:0; }
.flow-step p { margin:8px 0 0; color:var(--muted); font-size:13px; }
.table-wrap { max-width:100%; overscroll-behavior-x:contain; }
table { font-size:13px; } th,td { padding:9px 12px; border-bottom-color:var(--grid); }
th { color:var(--muted); font-weight:600; font-size:12px; }
td,th,code { overflow-wrap:anywhere; }
code { font-size:.92em; }
pre { max-width:100%; background:var(--surface-2); }
.wf-track { min-width:180px; }
.notice { padding:12px 16px; border:1px solid var(--border); border-left:4px solid var(--accent); background:var(--surface); border-radius:10px; color:var(--ink-2); font-size:13px; }
.note { border-left-color:var(--axis); }
.page-footer { border-top:1px solid var(--border); margin-top:40px; padding-top:16px; font-size:12px; color:var(--muted); }
.mobile-nav { display:none; }
@media(min-width:900px) { .suite-details > .tiles { grid-template-columns:repeat(4,minmax(0,1fr)); } }
@media(max-width:1100px) { .app-body { grid-template-columns:minmax(0,1fr); } .sidebar { position:static; max-height:none; border-right:0; padding:16px 24px 0; } .side-nav { display:none; } .sidebar .side-title:first-child { display:none; } .side-filters { display:flex; flex-wrap:wrap; gap:0 18px; } .facet { min-width:150px; } }
@media(max-width:850px) { .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .source-link { display:none; } }
@media(max-width:760px) {
  .primary-nav,.theme-toggle { display:none; } .app-header-inner { padding:10px 16px; }
  .mobile-nav { display:grid; grid-template-columns:repeat(5,1fr); position:fixed; bottom:0; left:0; right:0; z-index:25; background:var(--surface); border-top:1px solid var(--border); padding:4px 4px calc(4px + env(safe-area-inset-bottom)); }
  .mobile-nav a,.mobile-nav summary { display:grid; justify-items:center; gap:2px; padding:6px 2px; font-size:10.5px; font-weight:600; color:var(--muted); text-decoration:none; list-style:none; min-height:44px; }
  .mobile-nav summary::-webkit-details-marker { display:none; }
  .mobile-nav a[aria-current="page"] { color:var(--accent); }
  .mobile-nav details { position:relative; }
  .mobile-nav details > div { position:absolute; bottom:56px; right:4px; display:grid; min-width:170px; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:6px; box-shadow:0 8px 24px rgba(0,0,0,.35); }
  .mobile-nav details > div a { display:block; padding:10px 12px; font-size:13px; color:var(--ink); text-align:left; }
  body { padding-bottom:72px; }
  .sidebar { display:none; }
}
@media(max-width:600px) {
  main { padding:18px 14px 48px; }
  .brand { font-size:15px; } .summary-grid { gap:10px; } .stat-card { padding:14px; } .stat-card strong { font-size:26px; }
  .widget-grid { grid-template-columns:1fr; } .widget { padding:16px; } .detail-panel { padding-left:12px; padding-right:12px; }
  .card { padding:12px; } .legacy-nav { overflow-wrap:anywhere; } .tiles { grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  .mobile-stack thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  .mobile-stack,.mobile-stack tbody { display:block; width:100%; }
  .mobile-stack tbody tr { display:block; padding:10px 0; border-bottom:1px solid var(--border); }
  .mobile-stack tbody td { display:block; position:relative; border:0; padding:5px 0 5px 36%; text-align:left; white-space:normal; min-width:0; min-height:28px; }
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
  for (const link of document.querySelectorAll('.primary-nav a, .side-nav a, .mobile-nav a')) {
    if (new URL(link.href).pathname === location.pathname) link.setAttribute('aria-current', 'page');
  }
  // Relative times ("5 min ago") from data-ts (epoch ms or ISO); the absolute time stays in the title.
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const relative = (scope) => {
    for (const el of scope.querySelectorAll('[data-ts]')) {
      const t = /^\\d+$/.test(el.dataset.ts) ? Number(el.dataset.ts) : Date.parse(el.dataset.ts);
      if (!Number.isFinite(t)) continue;
      el.title = new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      el.textContent = (el.dataset.prefix || '') + ago(t);
    }
  };
  relative(document);
  // Lists rebuilt later (live merge status) get the same treatment.
  new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) relative(n); }).observe(document.body, { childList: true, subtree: true });
  const toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) {
    const set = (v) => { document.documentElement.dataset.theme = v; toggle.textContent = v === 'light' ? '☾ Dark' : '☀ Light'; };
    set(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    toggle.addEventListener('click', () => { const v = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; set(v); try { localStorage.setItem('adl-theme', v); } catch {} });
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

const ICONS = {
  overview: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
  diagnostics: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  pipelines: '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6h4a4 4 0 0 1 4 4v0M7 18h4a4 4 0 0 0 4-4"/>',
  investigation: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  metrics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
};
export const navIcon = (name) => `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// Primary sections: Overview, Diagnostics, Pipelines, Investigation, Metrics (ADR-0043).
const sections = (root) => [
  ['overview', 'Overview', `${root}index.html`],
  ['diagnostics', 'Diagnostics', `${root}pipeline/diagnostics.html`],
  ['pipelines', 'Pipelines', `${root}pipeline/flows.html`],
  ['investigation', 'Investigation', `${root}pipeline/index.html`],
  ['metrics', 'Metrics', `${root}pipeline/health.html`],
];

// The badge is filled at build time (assembleSite: data-diag-badge) with the count of findings.
const navLinks = (root, pipeline) => sections(root).filter(([k]) => pipeline || k === 'overview')
  .map(([k, label, href]) => `<a href="${href}">${navIcon(k)}${label}${k === 'diagnostics' ? '<span class="nav-badge" data-diag-badge></span>' : ''}</a>`).join('');

// Applied before the first paint: a stored light choice, dark otherwise.
const THEME_BOOT = `<script>try { if (localStorage.getItem('adl-theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch {}</script>`;

export function dashboardHeader(root, pipeline) {
  return `${THEME_BOOT}<a class="skip-link" href="#main-content">Skip to content</a><header class="app-header"><div class="app-header-inner"><a class="brand" href="${root}index.html"><span class="brand-icon" aria-hidden="true">↻</span>Autonomous Dev Loop</a><nav class="primary-nav" aria-label="Main navigation">${sections(root).filter(([k]) => pipeline || k === 'overview').map(([k, label, href]) => `<a href="${href}">${navIcon(k)}${label}</a>`).join('')}</nav><div class="header-tools"><span class="updated-dot" data-generated="" data-prefix="Updated "></span><button type="button" class="theme-toggle" data-theme-toggle>☀ Light</button><a class="source-link" href="https://github.com/koydas/autonomous-dev-loop">Repository →</a></div></div></header>`;
}

/** Left column: section links, then page-specific filters (Overview, Pipelines). */
export function sidebar(root, pipeline, filters = '') {
  return `<aside class="sidebar" aria-label="Sections and filters"><p class="side-title">Sections</p><nav class="side-nav" aria-label="Sections">${navLinks(root, pipeline)}</nav>${filters ? `<div class="side-filters">${filters}</div>` : ''}</aside>`;
}

/** Bottom tab bar on phones: four sections and a More menu. */
export function mobileNav(root, pipeline) {
  if (!pipeline) return '';
  const [overview, diagnostics, pipelines, investigation, metrics] = sections(root);
  const tab = ([k, label, href]) => `<a href="${href}">${navIcon(k)}${label}</a>`;
  return `<nav class="mobile-nav" aria-label="Sections">${tab(overview)}${tab(diagnostics)}${tab(pipelines)}${tab(investigation)}<details><summary>${navIcon('more')}More</summary><div><a href="${metrics[2]}">Metrics</a><a href="${root}pipeline/models.html">Models</a><a href="${root}pipeline/traces/index.html">Trace table</a><a href="${root}index.html#evaluations">Evaluations</a></div></details></nav>`;
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
  const cards = model.runs.map(run => `<article class="widget" data-entry data-result="${e(run.outcome || 'unknown')}"><div class="widget-head"><h3><a href="${runUrl(root, run)}">${e(run.workflow ?? 'Workflow')}</a></h3>${badge(run.outcome)}</div><p>${e(itemName(run.item))} · execution ${e(run.run_id)}</p>${executionFacts(run)}<div class="widget-meta"><span>${e(date(run.started_at))}</span><span>${e(run.events.length)} actions</span><span>${e(run.event_name ?? 'Unknown trigger')}</span>${run.llm?.length ? `<span>LLM ${e(costAmount(run.cost ?? sumCosts(run.llm)))} · ${e(run.llm.length)} call(s)</span>` : ''}</div><div class="link-row"><a class="button-link" href="${runUrl(root, run)}">Inspect execution →</a>${model.tracesById?.has(run.trace_id) ? `<a class="button-link" href="${root}traces/${encodeURIComponent(run.trace_id)}.html">Full flow</a>` : ''}</div></article>`).join('');
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
  return `<ol class="flow-steps" aria-label="Workflow execution history">${[...trace.runs].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0)).map((r, i) => `<li class="flow-step"><div class="widget-head"><strong>${i + 1}. ${r.run ? `<a href="../runs/${encodeURIComponent(r.run_id)}.html">${e(r.workflow ?? 'Workflow')}</a>` : e(r.workflow ?? 'Workflow') + ' (record not loaded)'}</strong>${badge(r.outcome)}</div><p>${e(date(r.started_at))} · ${e(r.run_id)}${r.run ? ` · ${e(r.run.events.length)} actions` : ''}${r.run?.llm?.length ? ` · LLM ${e(costAmount(r.run.cost ?? sumCosts(r.run.llm)))}` : ''}</p></li>`).join('')}</ol>`;
}
