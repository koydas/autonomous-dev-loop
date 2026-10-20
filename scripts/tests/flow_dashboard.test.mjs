import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import { flowDashboard, FLOW_SCRIPT, FLOW_STYLE } from '../lib/flow_dashboard.mjs';
import { PR_STATES_SCRIPT } from '../lib/console_views.mjs';

// The inline scripts of FLOW_SCRIPT, as the browser runs them.
const scripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

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
 const parts = scripts(FLOW_SCRIPT);
 assert.equal(parts.length, 3, 'PR states, flow map, filters');
 for (const src of parts) new Script(src);
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

// Execute the client join logic (adlIssueHint + adlMergeOf) with recorded identities, without a browser/network.
const helpers = scripts(PR_STATES_SCRIPT)[0];
const issueRecord = { dataset: { prs: '', issue: '7' } };
const prRecord = { dataset: { prs: '42', issue: '8' } };
// The card PR 42 lands on, as the flow script assigns it: recorded PR numbers first, then the issue hint
// unless another card recorded that PR; '' when none.
const join = (head, body = '', original = [issueRecord]) => runInNewContext(`${helpers}
 const pull = { number: 42, state: 'closed', merged_at: '2026-10-01T00:00:00Z', hint: adlIssueHint(pr) };
 const claimed = new Set(original.flatMap(c => c.dataset.prs.split(',').filter(Boolean).map(Number)));
 original.find(c => adlMergeOf(c.dataset.prs.split(',').filter(Boolean).map(Number), c.dataset.issue, [pull], claimed).state === 'merged') || '';`,
 { pr: { number: 42, head, body }, original });

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
 const flow = scripts(FLOW_SCRIPT)[1];
 const setIcon = flow.slice(flow.indexOf('const setIcon'), flow.indexOf('const load'));
 const icon = { dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
 runInNewContext(`${setIcon} setIcon(c, 'success', 'Merge: success', '✓');`, { c: { querySelector: sel => (sel === '[data-merge-status] [data-stage-status]' ? icon : null) } });
 assert.equal(icon.dataset.stageStatus, 'success');
 assert.equal(icon.textContent, '✓');
 assert.equal(icon.className, 'flow-status-icon success');
 assert.equal(icon.attrs['aria-label'], 'Merge: success');
 assert.equal(icon.title, 'Merge: success');
 // Success is set only in the merged_at branches; closed and open PRs get their own, non-success icon.
 assert.equal((flow.match(/setIcon\(c, 'success'/g) ?? []).length, 2);
 assert.ok(flow.indexOf("setIcon(c, 'success'") > flow.indexOf("m.state === 'merged'"));
 assert.match(flow, /setIcon\(c, 'skipped', 'Merge: closed without merge'/);
 assert.match(flow, /setIcon\(c, 'not-recorded', 'Merge: PR open'/);
 // A merged PR is never inferred from an open or unmerged closed one.
 const m = (pulls, prs = [7]) => runInNewContext(`${helpers} adlMergeOf(prs, '', pulls).state`, { pulls, prs });
 assert.equal(m([{ number: 7, state: 'closed', merged_at: null }]), 'closed');
 assert.equal(m([{ number: 7, state: 'open', merged_at: null }]), 'open');
 assert.equal(m([{ number: 7, state: 'closed', merged_at: 'x' }, { number: 8, state: 'open' }], [7, 8]), 'merged');
 assert.equal(m([]), 'unknown');
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

test('an all-unpriced flow shows unpriced on its chip and executions, never $0', () => {
 const html = flowDashboard({ traces: [trace([{ ...run, llm: [{ provider: 'anthropic', model: 'claude-unknown', tokens_in: 1, tokens_out: 1 }] }])] });
 assert.match(html, /<span class="flow-cost-chip"[^>]*>unpriced<\/span>/);
 assert.match(html, /partial · 1\.2 s · unpriced<\/summary>/);
});

test('a repeated step with only Groq calls shows no per-execution mean', () => {
 const groq = { ...run, llm: [{ provider: 'groq', model: 'openai/gpt-oss-120b', stage: 'review', pipeline_stage: 'review', tokens_in: 10, tokens_out: 1 }] };
 const html = flowDashboard({ traces: [trace([groq, { ...groq, run_id: '125-1' }])] });
 assert.match(html, /<p class="flow-step-cost" data-step-cost>LLM: \$0\.0000 USD \(2 Groq free-tier call\(s\) at no cost\) · 2 call\(s\) · 20 in \/ 2 out<\/p>/);
 assert.doesNotMatch(html, /per execution/);
});

// ADR-0043: the final status never hides earlier failed or adverse attempts.
test('Review failed, failed, success: final ✓ with the two failures and the recovery visible', () => {
 const html = flowDashboard({ traces: [trace([staged('1-1', 'review', 'failed', 1000), staged('2-1', 'review', 'failed', 2000), staged('3-1', 'review', 'success', 3000)])] });
 const review = statuses(html).find(([, l]) => l.startsWith('Review'));
 assert.deepEqual(review, ['success', 'Review: success · after 2 failed or adverse attempt(s)']);
 assert.match(html, /<sup class="flow-retry" aria-hidden="true">×3<\/sup>/);
 assert.match(html, /Final: <span class="pill tone-good">.*success<\/span> <span class="muted">2 failed · 0 adverse before or at it · recovered automatically<\/span>/);
 // Every attempt stays listed in order with its own status.
 const attempts = [...html.matchAll(/#(\d) · no decision recorded<\/span> — run partial/g)].map(m => m[1]);
 assert.deepEqual(attempts, ['1', '2', '3']);
 assert.match(html, /Execution: failed ·/);
});

test('a completed step with an adverse decision gets its decision in the label and an amber ring, not a failure', () => {
 const withheld = { ...staged('1-1', 'review', 'success', 1), events: [{ event: 'review.verdict', meta: { verdict: 'WITHHELD', withheld_from: 'APPROVE', unreviewed_code_files: 3 } }] };
 const html = flowDashboard({ traces: [trace([withheld])] });
 assert.match(html, /class="flow-status-icon success decision-warn" data-stage-status="success" role="img" aria-label="Review: success · Withheld"/);
 assert.match(html, /#1 · Withheld \(approval withheld: 3 code file\(s\) not reviewed\)/);
 assert.match(html, /data-state="withheld attention"/);
 assert.match(html, /data-problem="any review"/);
 assert.match(html, /<span class="pill tone-warn">.*Approval withheld<\/span>/);
});

test('cards carry the filter attributes; the filter bar and URL-kept filters are on the page', () => {
 const t = trace([{ ...staged('1-1', 'review', 'success', Date.parse('2026-10-20T00:00:00Z')), llm: [{ provider: 'groq', model: 'm', tokens_in: 1, tokens_out: 1 }] }]);
 t.runs[0].completed_at = Date.parse('2026-10-20T00:00:10Z');
 const html = flowDashboard({ traces: [t] });
 assert.match(html, /data-kind="issue" data-problem="" data-provider="groq" data-last="1792454410000"/);
 assert.match(html, /<section data-flow-dashboard data-filter-scope data-ref="1792454410000">/);
 for (const key of ['q', 'state', 'problem', 'kind', 'provider', 'period']) assert.ok(html.includes(`data-filter-key="${key}"`), key);
 assert.match(html, /<option value="groq">groq<\/option>/);
 assert.match(html, /<option value="merged">Merged \(live\)<\/option>/);
 assert.match(FLOW_SCRIPT, /data-filter-scope/);
 // Conditional steps are explained, not shown as missing evidence only.
 const pr = trace([staged('1-1', 'review', 'success', 1)]);
 pr.item = { kind: 'pr', number: 5 };
 const prHtml = flowDashboard({ traces: [pr] });
 assert.match(prHtml, /<strong>Validation<\/strong><p>No linked issue: not part of this flow<\/p>/);
 assert.match(prHtml, /<strong>Auto-fix<\/strong><p>Not triggered: no REQUEST_CHANGES verdict recorded<\/p>/);
});

test('escalations are surfaced on the card with their comment link', () => {
 const esc = { ...staged('1-1', 'autofix', 'success', 1), events: [{ event: 'autofix.escalated', meta: { reason: 'no_changes', url: 'https://github.com/koydas/autonomous-dev-loop/pull/9#c' } }] };
 const html = flowDashboard({ traces: [trace([esc])] });
 assert.match(html, /Escalated to a human: autofix\.escalated \(no changes\) · <a href="https:\/\/github\.com\/koydas\/autonomous-dev-loop\/pull\/9#c">comment<\/a>/);
 assert.match(html, /data-state="escalated attention"/);
});
