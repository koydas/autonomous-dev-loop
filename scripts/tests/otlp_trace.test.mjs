// ADR-0041: span tree of a run (parents, ordering, retries, fallback, side effects) and its OTLP JSON
// encoding, validated against a minimal OTLP/JSON fixture so an export needs no remodeling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSpanTree, toOtlpSpan, toOtlpDocument, toOtlpValue, toOtlpAttributes, unixNano, attributeName,
  SIDE_EFFECT_EVENTS, SPAN_KIND, STATUS_CODE,
} from '../lib/otlp_trace.mjs';
import { derivedSpanId, SPAN_ID_RE, TRACE_ID_RE } from '../lib/trace_context.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'otlp', 'minimal-trace.json'), 'utf8'));
const TRACE_ID = 'a'.repeat(32);
const ROOT = '1'.repeat(16);
const STAGE = '2'.repeat(16);
const LLM = '3'.repeat(16);

// Structural check against the fixture: every key we emit exists at the same path in the fixture,
// with the same JSON type (arrays: the union of the fixture's elements).
const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
function merged(list) {
  const out = {};
  for (const el of list) for (const [k, v] of Object.entries(el)) out[k] = k in out && kind(out[k]) === 'array' ? [...out[k], ...v] : (k in out && kind(out[k]) === 'object' ? merged([out[k], v]) : v);
  return out;
}
function assertShape(value, ref, at = '$') {
  assert.equal(kind(value), kind(ref), `${at}: ${kind(value)} where the OTLP fixture has ${kind(ref)}`);
  if (Array.isArray(ref)) {
    const objects = ref.filter((r) => kind(r) === 'object');
    value.forEach((v, i) => assertShape(v, objects.length ? merged(objects) : ref[0], `${at}[${i}]`));
  } else if (kind(ref) === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(k in ref, `${at}.${k} is not an OTLP field`);
      // KeyValue lists share one shape (resource, span and event attributes): the fixture's union.
      assertShape(v, k === 'attributes' ? ATTRIBUTES_REF : ref[k], `${at}.${k}`);
    }
  }
}
const ATTRIBUTES_REF = (() => {
  const all = [];
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (kind(o) === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'attributes') all.push(...v); walk(v); } };
  walk(FIXTURE);
  return all;
})();
function assertAnyValue(v, at) {
  const keys = Object.keys(v);
  assert.equal(keys.length, 1, `${at}: exactly one AnyValue field`);
  if (keys[0] === 'intValue') assert.match(v.intValue, /^-?\d+$/);
  if (keys[0] === 'arrayValue') v.arrayValue.values.forEach((x, i) => assertAnyValue(x, `${at}[${i}]`));
  if (keys[0] === 'kvlistValue') v.kvlistValue.values.forEach((x) => assertAnyValue(x.value, `${at}.${x.key}`));
}
function assertOtlp(doc) {
  assertShape(doc, FIXTURE);
  for (const rs of doc.resourceSpans) {
    rs.resource.attributes.forEach((a) => assertAnyValue(a.value, a.key));
    for (const ss of rs.scopeSpans) {
      for (const s of ss.spans) {
        assert.match(s.traceId, TRACE_ID_RE);
        assert.match(s.spanId, SPAN_ID_RE);
        if ('parentSpanId' in s) assert.match(s.parentSpanId, SPAN_ID_RE);
        assert.match(s.startTimeUnixNano, /^\d+$/);
        assert.match(s.endTimeUnixNano, /^\d+$/);
        assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano), `${s.name}: ends before it starts`);
        assert.ok(Number.isInteger(s.kind) && s.kind >= 0 && s.kind <= 5, `${s.name}: SpanKind 0-5`);
        assert.ok(Object.values(STATUS_CODE).includes(s.status.code));
        s.attributes.forEach((a) => assertAnyValue(a.value, `${s.name}.${a.key}`));
        s.events.forEach((e) => { assert.match(e.timeUnixNano, /^\d+$/); e.attributes.forEach((a) => assertAnyValue(a.value, `${e.name}.${a.key}`)); });
      }
    }
  }
}

const ev = (event, spanId, meta = {}, extra = {}) => ({ ts: '2026-10-16T10:00:05.000Z', stage: 'review', event, level: 'info', duration_ms: null, span_id: spanId, meta, ...extra });

function v2Trace(overrides = {}) {
  return {
    schema_version: 2,
    run_id: '900',
    started_at: '2026-10-16T10:00:00.000Z',
    completed_at: '2026-10-16T10:01:00.000Z',
    outcome: 'partial',
    trace_id: TRACE_ID,
    item: { kind: 'issue', number: 5, source: 'branch', key: 'o/r#issue-5' },
    root_span_id: ROOT,
    envelope: { workflow: 'PR Review', run_id: '900', run_attempt: 1, event_name: 'push', actor_type: 'bot', pr_number: 8, head_sha: 'f'.repeat(40) },
    spans: [{ stage: 'review', span_id: STAGE, parent_span_id: ROOT, started_at: '2026-10-16T10:00:01.000Z', completed_at: '2026-10-16T10:00:50.000Z', duration_ms: 49000, outcome: 'success', meta: { prNumber: 8, verdict: 'APPROVE' } }],
    child_spans: [{
      span_id: LLM, parent_span_id: STAGE, name: 'llm_call', started_at: '2026-10-16T10:00:02.000Z', completed_at: '2026-10-16T10:00:20.000Z', duration_ms: 18000, status: 'ok',
      attributes: { 'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'groq-model', 'gen_ai.response.model': 'claude', 'adl.llm.fallback': true, 'gen_ai.usage.input_tokens': 1200 },
    }],
    events: [
      ev('review.start', ROOT, { prNumber: 8 }, { ts: '2026-10-16T10:00:00.500Z' }),
      ev('retry.wait', LLM, { attempt: 0, wait_ms: 1000, status: 429 }, { ts: '2026-10-16T10:00:03.000Z' }),
      ev('llm_fallback', LLM, { from: 'groq', to: 'anthropic', error_type: 'TRANSIENT' }, { ts: '2026-10-16T10:00:04.000Z' }),
      ev('llm_call', LLM, { provider: 'anthropic', model: 'claude', fallback: true }, { ts: '2026-10-16T10:00:20.000Z', duration_ms: 18000 }),
      ev('review.comment_posted', STAGE, { prNumber: 8, action: 'created', url: 'https://github.com/o/r/pull/8#c' }, { ts: '2026-10-16T10:00:30.000Z', duration_ms: 400 }),
      ev('workflow.push', 'f'.repeat(16), { outcome: 'failure' }, { ts: '2026-10-16T10:00:55.000Z', level: 'warn' }),
      ev('review.verdict', 'not-an-id', { verdict: 'APPROVE' }, { ts: '2026-10-16T10:00:51.000Z' }),
    ],
    ...overrides,
  };
}

test('buildSpanTree: root → stage → llm_call, side effects as child spans, parents before children', () => {
  const { rootSpanId, spans } = buildSpanTree(v2Trace());
  assert.equal(rootSpanId, ROOT);
  const by = Object.fromEntries(spans.map((s) => [s.name, s]));
  assert.equal(spans[0].name, 'run');
  assert.equal(by.run.parent_span_id, null);
  assert.equal(by.review.parent_span_id, ROOT);
  assert.equal(by.llm_call.parent_span_id, STAGE);
  assert.equal(by.llm_call.kind, 'client');
  assert.equal(by['review.comment_posted'].parent_span_id, STAGE);
  assert.equal(by['review.comment_posted'].start, '2026-10-16T10:00:29.600Z', 'start = ts − duration_ms');
  assert.equal(by['workflow.push'].parent_span_id, ROOT, 'unknown parent → root');
  assert.equal(by['workflow.push'].status, 'error', 'a failed push is an error span');
  const index = (n) => spans.findIndex((s) => s.name === n);
  assert.ok(index('run') < index('review') && index('review') < index('llm_call'));
  assert.deepEqual(by.run.attributes['adl.item.kind'], 'issue');
  assert.equal(by.run.attributes['vcs.change.id'], 8);
  assert.equal(by.review.attributes['adl.pr_number'], 8);
  assert.equal(by.review.status, 'ok');
  assert.equal(by.run.status, 'ok');
});

test('buildSpanTree: retries and the fallback are span events of the LLM call span; stray events go to the root', () => {
  const { spans } = buildSpanTree(v2Trace());
  const llm = spans.find((s) => s.name === 'llm_call');
  assert.deepEqual(llm.events.map((e) => e.name), ['retry.wait', 'llm_fallback', 'llm_call']);
  assert.deepEqual(llm.events[0].attributes, { 'adl.attempt': 0, 'adl.wait_ms': 1000, 'adl.status': 429 });
  const root = spans.find((s) => s.name === 'run');
  assert.deepEqual(root.events.map((e) => e.name), ['review.start', 'review.verdict']);
});

test('buildSpanTree: siblings ordered by start time only, then id', () => {
  const a = { stage: 'b_late', span_id: '4'.repeat(16), started_at: '2026-10-16T10:00:09.000Z' };
  const b = { stage: 'a_early', span_id: '5'.repeat(16), started_at: '2026-10-16T10:00:02.000Z' };
  const c = { stage: 'same_time', span_id: '0'.repeat(15) + '9', started_at: '2026-10-16T10:00:02.000Z' };
  const { spans } = buildSpanTree(v2Trace({ spans: [a, b, c], child_spans: [], events: [] }));
  assert.deepEqual(spans.map((s) => s.name), ['run', 'same_time', 'a_early', 'b_late']);
});

test('buildSpanTree: a v1 trace (no ids) gets derived ids, stable across calls', () => {
  const v1 = { schema_version: 1, run_id: '77', started_at: '2026-10-16T10:00:00.000Z', spans: [{ stage: 'code_gen', outcome: 'failed', meta: { issueNumber: 3 } }], events: [{ ts: '2026-10-16T10:00:01.000Z', event: 'code_gen.error', level: 'error', meta: {} }] };
  const one = buildSpanTree(v1);
  assert.equal(one.rootSpanId, derivedSpanId('77:root'));
  assert.deepEqual(one, buildSpanTree(v1));
  const stage = one.spans.find((s) => s.name === 'code_gen');
  assert.equal(stage.span_id, derivedSpanId('77:stage:code_gen'));
  assert.equal(stage.parent_span_id, one.rootSpanId);
  assert.equal(stage.status, 'error');
  assert.deepEqual(one.spans[0].events.map((e) => e.name), ['code_gen.error']);
  assert.equal(one.spans[0].status, 'unset', 'no outcome → unset');
});

test('buildSpanTree: malformed input and forged parent cycles never lose a span', () => {
  assert.equal(buildSpanTree(null).spans.length, 1);
  assert.equal(buildSpanTree({ spans: 'x', child_spans: 5, events: {} }).spans.length, 1);
  const x = '6'.repeat(16);
  const y = '7'.repeat(16);
  const cyc = buildSpanTree(v2Trace({ spans: [], events: [], child_spans: [
    { span_id: x, parent_span_id: y, name: 'a' }, { span_id: y, parent_span_id: x, name: 'b' },
    { span_id: 'bad', name: 'no id' }, { span_id: x, name: 'duplicate' }, null,
  ] }));
  assert.deepEqual(cyc.spans.map((s) => s.name).sort(), ['a', 'b', 'run']);
  assert.ok(cyc.spans.filter((s) => s.name !== 'run').some((s) => s.parent_span_id === ROOT), 'the cycle is re-attached to the root');
  const timed = buildSpanTree({ root_span_id: ROOT, events: [{ ts: '2026-10-16T09:00:00.000Z', event: 'x' }] });
  assert.equal(timed.spans[0].start, '2026-10-16T09:00:00.000Z', 'a root without timing takes it from its events');
});

test('toOtlpDocument: the encoded spans match the OTLP JSON fixture shape', () => {
  const { spans } = buildSpanTree(v2Trace());
  const doc = toOtlpDocument({ resource: { 'adl.repository': 'o/r' }, spans: spans.map((s) => toOtlpSpan(s, TRACE_ID)) });
  assertOtlp(FIXTURE); // the validator accepts the reference itself
  assertOtlp(doc);
  const out = doc.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(out.length, spans.length);
  assert.ok(!('parentSpanId' in out[0]), 'the root has no parent');
  assert.equal(out.find((s) => s.name === 'llm_call').kind, SPAN_KIND.client);
  assert.equal(out.find((s) => s.name === 'workflow.push').status.code, STATUS_CODE.error);
  assert.equal(out[0].startTimeUnixNano, String(Date.parse('2026-10-16T10:00:00.000Z')) + '000000');
  assert.deepEqual(doc.resourceSpans[0].resource.attributes[0], { key: 'service.name', value: { stringValue: 'autonomous-dev-loop' } });
});

test('toOtlpSpan: an unfinished span (killed job) ends at its start; unknown kind/status fall back', () => {
  const s = toOtlpSpan({ span_id: LLM, parent_span_id: null, name: 'x', kind: 'weird', start: '2026-10-16T10:00:00.000Z', end: null, status: 'odd', attributes: {}, events: [] }, TRACE_ID);
  assert.equal(s.endTimeUnixNano, s.startTimeUnixNano);
  assert.equal(s.kind, SPAN_KIND.internal);
  assert.equal(s.status.code, STATUS_CODE.unset);
  assert.equal(unixNano(null), '0');
  assert.equal(unixNano('nope'), '0');
});

test('toOtlpValue / toOtlpAttributes: every AnyValue form, nulls omitted', () => {
  assert.deepEqual(toOtlpValue(true), { boolValue: true });
  assert.deepEqual(toOtlpValue(3), { intValue: '3' });
  assert.deepEqual(toOtlpValue(0.25), { doubleValue: 0.25 });
  assert.equal(toOtlpValue(Infinity), undefined);
  assert.deepEqual(toOtlpValue(['a', null, 1]), { arrayValue: { values: [{ stringValue: 'a' }, { intValue: '1' }] } });
  assert.deepEqual(toOtlpValue({ k: 'v', n: null }), { kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } });
  assert.equal(toOtlpValue(undefined), undefined);
  assert.equal(toOtlpValue(() => 1), undefined);
  assert.deepEqual(toOtlpAttributes({ a: null, b: 'x' }), [{ key: 'b', value: { stringValue: 'x' } }]);
  assert.deepEqual(toOtlpAttributes(null), []);
});

test('attributeName and the side-effect set', () => {
  assert.equal(attributeName('prNumber'), 'adl.pr_number');
  assert.equal(attributeName('headSha'), 'adl.head_sha');
  assert.equal(attributeName('wait_ms'), 'adl.wait_ms');
  for (const name of ['review.comment_posted', 'autofix.attempt_labeled', 'workflow.push', 'autofix_reset.retriggered']) assert.ok(SIDE_EFFECT_EVENTS.has(name));
  assert.ok(!SIDE_EFFECT_EVENTS.has('retry.wait'));
});
