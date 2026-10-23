import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LESSONS, LESSON_STAGES, MAX_LESSONS, MAX_LESSONS_CHARS, signalsOfLine, parseSignals, extractLessons, formatLessonsContext,
} from '../lib/lessons.mjs';
import { loadLessons } from '../lib/lessons_loader.mjs';
import { ADVERSARIAL_AXES } from '../lib/adversarial_review.mjs';
import { RULES } from '../lib/static_verifier.mjs';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const skip = (rules, ts = day(1), type = 'codegen_skip') => ({ type, reason: 'guardrail_rejected', rules, ts });
const sig = (id, ageDays = 1) => ({ id, ts: NOW - ageDays * 86400000 });

test('the catalog covers every rule of the static verifier and every review axis, and each lesson is one bounded sentence', () => {
  for (const rule of Object.values(RULES)) assert.ok(Object.hasOwn(LESSONS, `rule:${rule}`), `rule:${rule}`);
  for (const rule of ['unshown_file', 'withheld_file', 'mass_deletion', 'test_count_drop']) assert.ok(Object.hasOwn(LESSONS, `rule:${rule}`), `rule:${rule}`);
  for (const { id } of ADVERSARIAL_AXES) assert.ok(Object.hasOwn(LESSONS, `axis:${id}`), `axis:${id}`);
  for (const [id, text] of Object.entries(LESSONS)) {
    assert.match(id, /^(rule|axis):[a-z_]+$/);
    assert.ok(text.length > 20 && text.length <= 220, `${id}: ${text.length} chars`);
    assert.doesNotMatch(text, /ignore|disregard|override|you may|relax/i, `${id}: a lesson never loosens a rule`);
  }
  assert.deepEqual([...LESSON_STAGES], ['generation', 'autofix']);
});

test('signalsOfLine reads the rules of a guardrail rejection and the axes of a review signal, nothing else', () => {
  assert.deepEqual(signalsOfLine(skip(['module_system', 'module_system', 'unshown_file'])).map((s) => s.id), ['rule:module_system', 'rule:unshown_file']);
  assert.deepEqual(signalsOfLine(skip(['mass_deletion'], day(2), 'autofix_skip')).map((s) => s.id), ['rule:mass_deletion']);
  assert.deepEqual(signalsOfLine({ type: 'review_signal', axes: ['robustness', 'types'], ts: day(1) }).map((s) => s.id), ['axis:robustness', 'axis:types']);
  assert.equal(signalsOfLine(skip(['module_system'], day(1)))[0].ts, NOW - 86400000);
  assert.equal(signalsOfLine({ ...skip(['module_system']), ts: 'yesterday' })[0].ts, null);
});

test('signalsOfLine drops anything outside the catalog, a rejection that is not a guardrail one and malformed lines', () => {
  assert.deepEqual(signalsOfLine(skip(['<script>alert(1)</script>', 'constructor', '__proto__', 'protected_path'])), [], 'unknown ids reach no prompt');
  assert.deepEqual(signalsOfLine({ type: 'autofix_skip', reason: 'no_changes', rules: ['module_system'] }), []);
  assert.deepEqual(signalsOfLine({ type: 'pr', rules: ['module_system'] }), []);
  assert.deepEqual(signalsOfLine({ type: 'review_signal', axes: 'robustness' }), []);
  assert.deepEqual(signalsOfLine({ type: 'codegen_skip', reason: 'guardrail_rejected', rules: 'module_system' }), []);
  for (const bad of [null, undefined, 'x', 3, [], [skip(['module_system'])]]) assert.deepEqual(signalsOfLine(bad), []);
});

test('parseSignals reads JSONL, skips lines that are not JSON, and keeps only the last maxLines', () => {
  const text = [JSON.stringify(skip(['module_system'])), 'not json', '', '{"type":"pr"}', JSON.stringify({ type: 'review_signal', axes: ['types'], ts: day(1) })].join('\n');
  assert.deepEqual(parseSignals(text).map((s) => s.id), ['rule:module_system', 'axis:types']);
  const many = Array.from({ length: 10 }, (_, i) => JSON.stringify(skip(i < 8 ? ['module_system'] : ['unresolved_import']))).join('\n');
  assert.deepEqual(parseSignals(many, { maxLines: 2 }).map((s) => s.id), ['rule:unresolved_import', 'rule:unresolved_import']);
  assert.deepEqual(parseSignals(null), []);
  assert.deepEqual(parseSignals(''), []);
});

test('extractLessons keeps signals that recur, most frequent first, at most MAX_LESSONS', () => {
  const signals = [sig('rule:module_system'), sig('rule:unresolved_import'), sig('rule:module_system'), sig('axis:types'), sig('rule:module_system'), sig('axis:types'), sig('rule:mass_deletion'), sig('rule:mass_deletion'), sig('rule:test_count_drop'), sig('rule:test_count_drop'), sig('axis:robustness')];
  const lessons = extractLessons(signals, { now: NOW });
  assert.deepEqual(lessons.map((l) => [l.id, l.count]), [['rule:module_system', 3], ['rule:mass_deletion', 2], ['rule:test_count_drop', 2]], 'ties by catalog order; axis:types (2) is the 4th and is cut');
  assert.equal(lessons.length, MAX_LESSONS);
  assert.equal(lessons[0].text, LESSONS['rule:module_system']);
  assert.deepEqual(extractLessons(signals, { now: NOW, max: 1 }).map((l) => l.id), ['rule:module_system']);
  assert.deepEqual(extractLessons([sig('rule:module_system')], { now: NOW }), [], 'one occurrence is not recurring');
  assert.deepEqual(extractLessons(signals, { now: NOW, minOccurrences: 4 }), []);
});

test('extractLessons expires old signals and only looks at the newest window', () => {
  assert.deepEqual(extractLessons([sig('rule:module_system', 40), sig('rule:module_system', 1)], { now: NOW }), [], 'a signal older than 30 days is history');
  assert.equal(extractLessons([sig('rule:module_system', 31), sig('rule:module_system', 29), sig('rule:module_system', 2)], { now: NOW })[0].count, 2);
  const old = Array.from({ length: 5 }, () => sig('rule:module_system', 5));
  const recent = Array.from({ length: 30 }, () => sig('axis:types', 1));
  assert.deepEqual(extractLessons([...old, ...recent], { now: NOW }).map((l) => l.id), ['axis:types'], 'the window is 30 signals: the pattern that left it is resolved');
  assert.equal(extractLessons([{ id: 'rule:module_system', ts: null }, { id: 'rule:module_system', ts: null }], { now: NOW }).length, 1, 'no timestamp: the window is the only bound');
  assert.deepEqual(extractLessons([{ id: 'constructor', ts: null }, { id: 'constructor', ts: null }], { now: NOW }), [], 'not in the catalog');
  assert.deepEqual(extractLessons(undefined, { now: NOW }), []);
});

test('formatLessonsContext builds the block for a code stage only, whole lessons only, within the bound', () => {
  const lessons = extractLessons([sig('rule:module_system'), sig('rule:module_system'), sig('axis:types'), sig('axis:types')], { now: NOW });
  const block = formatLessonsContext(lessons, 'generation');
  assert.match(block, /^\n\nLEARNED CONSTRAINTS — .*never relax them:\n- Keep every file in its module system.*\(seen 2 times recently\)\n- Reviews blocked patches for type integrity/s);
  assert.ok(block.length <= MAX_LESSONS_CHARS);
  assert.equal(formatLessonsContext(lessons, 'autofix'), block);
  for (const stage of ['review', 'validation', undefined]) assert.equal(formatLessonsContext(lessons, stage), '', String(stage));
  assert.equal(formatLessonsContext([], 'generation'), '');
  assert.equal(formatLessonsContext(null, 'generation'), '');
  const tight = formatLessonsContext(lessons, 'generation', { maxChars: block.length - 5 });
  assert.match(tight, /module system/);
  assert.doesNotMatch(tight, /type integrity/, 'the lesson that does not fit is left out, not cut');
  assert.equal(formatLessonsContext(lessons, 'generation', { maxChars: 50 }), '', 'nothing fits: no block, not a bare heading');
});

// ── lessons_loader ──────────────────────────────────────────────────────────────────────────────────────────────
const ARGS = { stage: 'generation', repository: 'owner/repo', token: 't', apiBase: 'http://api.test', now: NOW };
const respond = (status, text = '') => async () => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const recurring = [skip(['module_system']), skip(['module_system'])].map((l) => JSON.stringify(l)).join('\n');

test('loadLessons reads metrics/runs.jsonl on the metrics branch with a read-only call and returns the context', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(200, recurring)(); };
  const { lessons, context } = await loadLessons({ ...ARGS, fetchImpl, env: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://api.test/repos/owner/repo/contents/metrics/runs.jsonl?ref=metrics');
  assert.equal(calls[0].init.method, undefined, 'GET');
  assert.match(calls[0].init.headers.Accept, /raw/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  assert.deepEqual(lessons.map((l) => l.id), ['rule:module_system']);
  assert.match(context, /LEARNED CONSTRAINTS/);
});

test('loadLessons returns nothing without a call for a stage that takes no lessons or when ADL_LESSONS=off', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return respond(200, recurring)(); };
  for (const args of [{ stage: 'review' }, { stage: undefined }, { env: { ADL_LESSONS: 'off' } }, { env: { ADL_LESSONS: ' OFF ' } }]) {
    assert.deepEqual(await loadLessons({ ...ARGS, fetchImpl, env: {}, ...args }), { lessons: [], context: '' });
  }
  assert.equal(calls, 0);
  assert.equal((await loadLessons({ ...ARGS, fetchImpl, env: { ADL_LESSONS: 'on' } })).lessons.length, 1);
});

test('loadLessons: a missing metrics branch is no lesson and no warning; every other failure is one warn event and no lesson', async () => {
  const stderr = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    assert.deepEqual(await loadLessons({ ...ARGS, fetchImpl: respond(404), env: {} }), { lessons: [], context: '' });
    assert.equal(stderr.join('').includes('lessons.unavailable'), false);
    for (const [fetchImpl, reason] of [
      [respond(500), 'http_error'],
      [respond(403), 'http_error'],
      [async () => { throw Object.assign(new Error('boom'), { name: 'TypeError' }); }, 'network_error'],
      [async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); }, 'timeout'],
      [async () => { throw Object.assign(new Error('abort'), { name: 'AbortError' }); }, 'timeout'],
    ]) {
      stderr.length = 0;
      assert.deepEqual(await loadLessons({ ...ARGS, fetchImpl, env: {} }), { lessons: [], context: '' }, reason);
      assert.match(stderr.join(''), new RegExp(`"event":"lessons\\.unavailable"[^\\n]*"reason":"${reason}"`), reason);
    }
    stderr.length = 0;
    assert.deepEqual(await loadLessons({ ...ARGS, token: '', fetchImpl: respond(200, recurring), env: {} }), { lessons: [], context: '' });
    assert.match(stderr.join(''), /"reason":"not_configured"/);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('loadLessons gives up after its timeout instead of holding the run', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 10); // AbortSignal.timeout does not keep the event loop alive by itself
  const result = await loadLessons({ ...ARGS, fetchImpl, timeoutMs: 20, env: {} }).finally(() => clearInterval(keepAlive));
  assert.deepEqual(result, { lessons: [], context: '' });
  assert.ok(Date.now() - started < 2000);
});
