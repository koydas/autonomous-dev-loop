// site-kit (koydas/koydas ADR-0001): every dashboard page carries the shared top bar and footer, the home carries the
// shared page header, and the vendored copy (scripts/lib/site_kit/) matches the version and hash it declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { page, renderHome, BASE_STYLE } from '../lib/eval_site.mjs';
import { dashboardHeader, DASHBOARD_STYLE } from '../lib/dashboard_ui.mjs';
import { consoleOverview } from '../lib/console_overview.mjs';
import { consoleContext } from '../lib/console_views.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf } from './fixtures/pipeline/records.mjs';

const DIR = fileURLToPath(new URL('../lib/site_kit/', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(readFileSync(join(DIR, 'KIT.json'), 'utf8'));
const SITES = ['koydas', 'agent-patterns', 'autonomous-dev-loop', 'ai-dev-tools', 'repo-orchestrator'];

test('site-kit copy: files match the version and hash it declares (profile node)', () => {
  const actual = Object.fromEntries(Object.keys(manifest.files).sort().map((f) => [f, sha(readFileSync(join(DIR, f)))]));
  assert.deepEqual(actual, manifest.files);
  assert.equal(sha(Buffer.from(Object.keys(actual).sort().map((f) => `${f} ${actual[f]}\n`).join(''))), manifest.hash);
  assert.equal(manifest.profile, 'node');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

for (const pipeline of [true, false]) {
  test(`page(): shared bar after the skip link and before the dashboard header, shared footer after the page, pipeline=${pipeline}`, () => {
    const html = page('T', '<p>body</p>', { pipeline });
    const skip = html.indexOf('class="skip-link"');
    const bar = html.indexOf('class="sk-bar"');
    const header = html.indexOf('<header class="app-header">');
    const footer = html.indexOf('class="sk-footer"');
    assert.ok(skip > 0 && skip < bar && bar < header, 'skip link, kit bar, dashboard header');
    assert.ok(footer > html.indexOf('</main>'), 'kit footer after main');
    assert.match(html, new RegExp(`data-site-kit="${manifest.version}"`));
    for (const part of [html.slice(bar, header), html.slice(footer, html.indexOf('</body>'))]) {
      assert.equal((part.match(/aria-current="true"/g) ?? []).length, 1);
      assert.match(part, /<a href="https:\/\/koydas\.github\.io\/autonomous-dev-loop\/" aria-current="true">/);
      for (const s of SITES.filter((x) => x !== 'autonomous-dev-loop')) assert.ok(part.includes(`https://koydas.github.io/${s}/"`), s);
    }
    assert.match(html, /href="https:\/\/github\.com\/koydas\/autonomous-dev-loop">GitHub</);
  });
}

test('the kit tokens and shell CSS ship once, in the base style (inline without pipeline views, console.css with them)', () => {
  assert.equal(BASE_STYLE.split('/* site-kit design tokens').length, 2);
  assert.ok(BASE_STYLE.includes('--sk-bar-h: 52px') && BASE_STYLE.includes('.sk-bar {'));
  assert.ok(page('T', '', { pipeline: false }).includes('--sk-bar-h: 52px'));
  assert.ok(!page('T', '', { pipeline: true }).includes('--sk-bar-h: 52px'), 'with pipeline views the kit CSS is in pipeline/console.css');
});

test('the shell adds no script of its own: the only scripts are the theme boot and the dashboard script', () => {
  const bar = dashboardHeader('', true);
  const kit = bar.slice(bar.indexOf('class="sk-bar"'), bar.indexOf('<header class="app-header">'));
  assert.doesNotMatch(kit, /<script|<link|\son\w+=|javascript:/i);
});

test('sticky: the dashboard header and the sidebar sit below the kit bar', () => {
  assert.match(DASHBOARD_STYLE, /\.app-header \{ position:sticky; top:var\(--sk-bar-h, 0px\);/);
  assert.match(DASHBOARD_STYLE, /\.sidebar \{ position:sticky; top:calc\(56px \+ var\(--sk-bar-h, 0px\)\);/);
  assert.match(DASHBOARD_STYLE, /scroll-padding-top:calc\(90px \+ var\(--sk-bar-h, 0px\)\)/);
});

test('home: opens with the shared page header, which carries the only h1; the overview has no second heading or hero', () => {
  const home = renderHome();
  assert.match(home, /<div class="sk-pagehead">[\s\S]*?<p class="sk-eyebrow">Autonomous Dev Loop · Dashboard<\/p>\s*<h1 class="sk-title">System overview<\/h1>/);
  assert.ok(home.indexOf('class="sk-pagehead"') < home.indexOf('class="app-body'), 'page header above the app body');
  const ctx = consoleContext(buildPipelineModel({ records: asFiles([makeRecord({ runId: '1', outcome: 'success' })]), traces: indexesOf([makeRecord({ runId: '1', outcome: 'success' })]) }));
  const overview = consoleOverview(ctx, 'pipeline/', { heading: false });
  assert.doesNotMatch(overview, /<h1|home-hero/);
  assert.match(consoleOverview(ctx, 'pipeline/'), /<h1>System overview<\/h1>[\s\S]*class="home-hero"/, 'default: unchanged');
  assert.equal(((home.replace('<!-- pipeline-overview -->', overview)).match(/<h1/g) ?? []).length, 1);
});

test('other pages have no page header block of their own (they keep their h1)', () => {
  assert.doesNotMatch(page('T', '<h1>Own</h1>', { pipeline: true }), /class="sk-pagehead"/);
});
