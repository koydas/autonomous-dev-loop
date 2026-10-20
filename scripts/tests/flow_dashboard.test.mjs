import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { flowDashboard, FLOW_SCRIPT, FLOW_STYLE } from '../lib/flow_dashboard.mjs';

const trace = runs => ({ trace_id: 'a'.repeat(32), item: { kind: 'issue', number: 7 }, runs: runs.map(run => ({ run })), running_ms: 1000, waiting_ms: 2000, runs_overflow: 0 });
const run = { run_id: '123-1', stages: [{ stage: 'review' }], events: [], pr_number: 9, workflow: '<script>bad</script>', actor: 'bot', duration_ms: 1200, outcome: 'partial', llm: [] };

test('flow cards preserve all steps and missing evidence without inventing success', () => {
 const html = flowDashboard({ traces: [trace([run])] });
 for (const name of ['Validation', 'Code generation', 'PR preparation', 'Review', 'Auto-fix', 'Merge']) assert.ok(html.includes(name));
 assert.match(html, /data-prs="9" data-issue="7"/);
 assert.match(html, /partial · 1.2 s/);
 assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
 assert.doesNotMatch(html, /<script>bad/);
 assert.match(html, /runs\/123-1.html/);
 assert.match(html, /flow-node missing/);
 assert.match(html, /LLM cost estimate: Not recorded/);
});

test('cost uses shared prices and explicitly marks unpriced calls and empty flows', () => {
 const html = flowDashboard({ traces: [trace([{ ...run, llm: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 1000 }, { provider: 'other', model: 'unknown' }] }]), trace([null])] });
 assert.match(html, /\$0.0240 USD \+ 1 unpriced/);
 assert.match(html, /1 execution record\(s\) unavailable/);
 assert.match(flowDashboard({ traces: [] }), /No recorded flows yet/);
});

test('client script parses and includes bounded API loading, safe rendering, merge facts and recovery', () => {
 new Script(FLOW_SCRIPT.replace(/^<script>|<\/script>$/g, ''));
 assert.match(FLOW_SCRIPT, /page <= 10/);
 assert.match(FLOW_SCRIPT, /p.merged_at/);
 assert.match(FLOW_SCRIPT, /textContent = 'PR #'/);
 assert.doesNotMatch(FLOW_SCRIPT, /innerHTML/);
 assert.match(FLOW_SCRIPT, /Merge status unavailable/);
 assert.match(FLOW_SCRIPT, /replaceChildren\(\.\.\.original/);
 assert.match(FLOW_STYLE, /@media\(max-width:600px\)/);
 assert.match(FLOW_STYLE, /grid-template-columns:1fr/);
});

test('repeat executions remain independently inspectable and PR-only identities join', () => {
 const t = trace([run, { ...run, run_id: '124-1', outcome: 'failed' }]);
 t.item = { kind: 'pr', number: 10 };
 const html = flowDashboard({ traces: [t] });
 assert.match(html, /data-prs="9,10" data-issue=""/);
 assert.match(html, /2 execution\(s\)/);
 assert.match(html, /runs\/124-1.html/);
 assert.match(html, /failed · 1.2 s/);
});

test('over-limit Haiku calls stay unpriced and a zero-token call costs zero', () => {
 const html = flowDashboard({ traces: [trace([{ ...run, llm: [
  { provider: 'anthropic', model: 'claude-haiku-5-5', tokens_in: 100001, tokens_out: 1 },
  { provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 0, tokens_out: 0 },
 ] }])] });
 assert.match(html, /\$0.0000 USD \+ 1 unpriced call/);
});

test('Groq free-tier calls cost nothing and are never counted as unpriced', () => {
 const html = flowDashboard({ traces: [trace([{ ...run, llm: [
  { provider: 'groq', model: 'openai/gpt-oss-120b', tokens_in: 5000, tokens_out: 500 },
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
 ] }])] });
 assert.match(html, /LLM cost estimate: \$0.0000 USD \(2 Groq free-tier call\(s\) at no cost\)/);
 assert.match(html, /<span class="flow-cost-chip"[^>]*>free tier<\/span>/, 'Groq-only flow: free tier, not $0');
 assert.doesNotMatch(html, /unpriced/);
 const mixed = flowDashboard({ traces: [trace([{ ...run, llm: [
  { provider: 'groq', model: 'openai/gpt-oss-120b', tokens_in: 1, tokens_out: 1 },
  { provider: 'other', model: 'unknown' },
 ] }])] });
 assert.match(mixed, /\$0.0000 USD \+ 1 unpriced call\(s\) \(1 Groq free-tier call\(s\) at no cost\)/);
});

// Execute the client join logic with recorded identities, without a browser/network.
const joinSource = FLOW_SCRIPT.slice(FLOW_SCRIPT.indexOf('const branch ='), FLOW_SCRIPT.indexOf('const c = source'));
const issueRecord = { dataset: { prs: '', issue: '7' } };
const prRecord = { dataset: { prs: '42', issue: '8' } };
const join = (head, body = '', original = [issueRecord]) => runInNewContext(
 `${joinSource} source;`, { pr: { number: 42, head, body }, original });

test('local pipeline branch matches its issue trace', () => {
 assert.equal(join({ ref: 'ai/issue-7', repo: { full_name: 'koydas/autonomous-dev-loop' } }), issueRecord);
});

test('zero-padded pipeline branches join the normalized issue; issue 0 is no hint (PR #226)', () => {
 const repo = { full_name: 'koydas/autonomous-dev-loop' };
 assert.equal(join({ ref: 'ai/issue-007', repo }), issueRecord);
 assert.equal(join({ ref: 'ai/issue-0', repo }, '', [{ dataset: { prs: '', issue: '0' } }]), '');
 assert.equal(join({ ref: 'ai/issue-0', repo }, 'Closes #007'), issueRecord);
});

test('fork branch cannot borrow a local issue trace (PR #226)', () => {
 assert.equal(join({ ref: 'ai/issue-7', repo: { full_name: 'someone/fork' } }), '');
});

test('missing or deleted head repositories cannot supply branch hints', () => {
 for (const head of [undefined, { ref: 'ai/issue-7' }, { ref: 'ai/issue-7', repo: null }]) {
  assert.equal(join(head), '');
 }
});

test('fork heads retain local closing references and explicit PR identity takes precedence', () => {
 const head = { ref: 'ai/issue-99', repo: { full_name: 'someone/fork' } };
 assert.equal(join(head, 'Closes #7'), issueRecord);
 assert.equal(join(head, 'Closes #7', [issueRecord, prRecord]), prRecord);
 assert.equal(join(head, 'Closes someone/fork#7'), '');
});

// Collapsed cards (#236): one icon per step from the latest execution's span outcome.
const statuses = html => [...html.matchAll(/data-stage-status="([^"]+)" role="img" aria-label="([^"]+)"/g)].map(m => [m[1], m[2]]);
const staged = (id, stage, outcome, started_at) => ({ ...run, run_id: id, started_at, stages: [{ stage, ...(outcome === undefined ? {} : { outcome }) }] });

test('cards start collapsed with title and step icons in the summary (#236)', () => {
 const html = flowDashboard({ traces: [trace([staged('1-1', 'issue_validation', 'success', 1), staged('2-1', 'code_gen', 'failed', 2), staged('3-1', 'autofix', 'skipped', 3)])] });
 assert.match(html, /<details class="flow-details"><summary class="flow-summary"><h2 data-flow-title>issue #7<\/h2><span class="flow-status">/);
 assert.doesNotMatch(html, /<details class="flow-details" open/);
 assert.deepEqual(statuses(html.slice(0, html.indexOf('</summary>'))), [
  ['success', 'Validation: success'], ['failed', 'Code generation: failed'], ['not-recorded', 'PR preparation: not recorded'],
  ['not-recorded', 'Review: not recorded'], ['skipped', 'Auto-fix: skipped'], ['not-recorded', 'Merge: not recorded'],
 ]);
 // Not recorded stays distinct from failed: own glyph and class.
 assert.match(html, /class="flow-status-icon failed"[^>]*>✗</);
 assert.match(html, /class="flow-status-icon not-recorded"[^>]*>○</);
 assert.match(html, /class="flow-status-icon skipped"[^>]*>⊘</);
 assert.match(html, /<\/summary><p data-merge>/);
 assert.match(html, /<\/ol>.*<\/details><\/article>/s);
});

test('a step icon reflects the latest execution; undated runs rank last (#236)', () => {
 const review = html => statuses(html).find(([, l]) => l.startsWith('Review'))[0];
 assert.equal(review(flowDashboard({ traces: [trace([staged('2-1', 'review', 'success', 2000), staged('1-1', 'review', 'failed', 1000)])] })), 'success');
 assert.equal(review(flowDashboard({ traces: [trace([staged('1-1', 'review', 'success', 1000), staged('2-1', 'review', 'failed', 2000)])] })), 'failed');
 assert.equal(review(flowDashboard({ traces: [trace([staged('1-1', 'review', 'failed', 1000), staged('9-1', 'review', 'success', null)])] })), 'failed');
 // Ties keep trace order.
 assert.equal(review(flowDashboard({ traces: [trace([staged('1-1', 'review', 'failed', 5), staged('2-1', 'review', 'success', 5)])] })), 'failed');
});

test('missing or unknown span outcomes are not recorded, never success (#236)', () => {
 for (const outcome of [undefined, null, 'running', 'constructor', '__proto__']) {
  const html = flowDashboard({ traces: [trace([staged('1-1', 'review', outcome, 1)])] });
  assert.ok(statuses(html).some(([s, l]) => s === 'not-recorded' && l === 'Review: not recorded'), String(outcome));
 }
 // A run matched by an event only has no span outcome for that stage.
 const html = flowDashboard({ traces: [trace([{ ...run, stages: [], events: [{ stage: 'review' }] }])] });
 assert.ok(statuses(html).some(([s, l]) => s === 'not-recorded' && l === 'Review: not recorded'));
 // The template card for an unrecorded merged PR: six not-recorded icons.
 const empty = flowDashboard({ traces: [] });
 const tpl = empty.slice(empty.indexOf('<template'));
 assert.deepEqual(statuses(tpl).map(([s]) => s), Array(6).fill('not-recorded'));
});

test('client script turns the merge icon to success only on a confirmed merge (#236)', () => {
 const block = FLOW_SCRIPT.slice(FLOW_SCRIPT.indexOf("const mergeIcon"), FLOW_SCRIPT.indexOf("if (!source)"));
 const icon = { dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
 runInNewContext(block, { c: { querySelector: sel => (sel === '[data-merge-status] [data-stage-status]' ? icon : null) } });
 assert.equal(icon.dataset.stageStatus, 'success');
 assert.equal(icon.textContent, '✓');
 assert.equal(icon.className, 'flow-status-icon success');
 assert.equal(icon.attrs['aria-label'], 'Merge: success');
 assert.equal(icon.title, 'Merge: success');
 // It sits after the merged_at facts: the failure path restores recorded cards untouched.
 assert.ok(FLOW_SCRIPT.indexOf('const mergeIcon') > FLOW_SCRIPT.indexOf("'Merged · ' + pr.merged_at"));
 assert.match(FLOW_STYLE, /\.flow-status \{ display:flex; flex-wrap:wrap;/);
 assert.match(FLOW_STYLE, /\.flow-node summary, \.flow-summary \{ min-height:44px;/);
});

test('each step shows its own LLM cost, each execution its amount, the summary a cost chip', () => {
 const opus = { provider: 'anthropic', model: 'claude-opus-5-5' };
 const review = { ...run, run_id: '200-1', llm: [{ ...opus, stage: 'review', pipeline_stage: 'review', tokens_in: 1000, tokens_out: 1000, estimated: false, cache_read: 0 }] };
 const review2 = { ...review, run_id: '201-1' };
 const autofix = { ...run, run_id: '202-1', stages: [{ stage: 'autofix' }], llm: [{ ...opus, tokens_in: 10_000, tokens_out: 0 }] };
 const html = flowDashboard({ traces: [trace([review, review2, autofix])] });
 assert.match(html, /<span class="flow-cost-chip"[^>]*>\$0\.0880<\/span>/);
 assert.match(html, /<strong>Review<\/strong><p>2 execution\(s\)<\/p><p class="flow-step-cost" data-step-cost>LLM: \$0\.0480 USD · 2 call\(s\) · 2\.0k in \/ 2\.0k out · \$0\.0240 per execution<\/p>/);
 assert.match(html, /<strong>Auto-fix<\/strong><p>1 execution\(s\)<\/p><p class="flow-step-cost" data-step-cost>LLM: \$0\.0400 USD · 1 call\(s\) · 10\.0k in \/ 0 out<\/p>/, 'a call without a stage goes to the run\'s only stage');
 assert.match(html, /partial · 1\.2 s · \$0\.0240<\/summary>/);
 assert.match(html, /1000 input \/ 1000 output tokens \(measured\) · \$0\.0240/);
 assert.match(html, /10000 input \/ 0 output tokens \(estimated\) · \$0\.0400/);
 assert.match(html, /provider-measured tokens where recorded, chars\/4 estimate for older records; list price, never a bill/);
 assert.doesNotMatch(html.slice(html.indexOf('<strong>Validation')), /^<strong>Validation<\/strong><p>Not recorded<\/p><p class="flow-step-cost"/);
});

test('cost note names the basis: measured only, estimated only; cache reads are shown per call', () => {
 const measured = flowDashboard({ traces: [trace([{ ...run, llm: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 5000, tokens_out: 10, estimated: false, cache_read: 4000 }] }])] });
 assert.match(measured, /provider-measured tokens, thinking and prompt cache included; list price, never a bill/);
 assert.match(measured, /5000 input \(4000 from cache\)/);
 const estimated = flowDashboard({ traces: [trace([{ ...run, llm: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1, tokens_out: 1 }] }])] });
 assert.match(estimated, /chars\/4 token estimate, excludes thinking and cache adjustments; list price, never a bill/);
});
