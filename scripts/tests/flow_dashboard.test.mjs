import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
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
