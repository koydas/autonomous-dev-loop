import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASE_STATES, DYNAMIC_TITLE, MAX_OPTIONS_CHARS, MIN_TITLE_CHARS, assertionDrops, casesChange, clipTitle, compareCases, isWaived, lineCases, maskedCases, rawCases, stateOfOptions, without,
} from '../lib/test_cases.mjs';

const { ACTIVE, SKIPPED, TODO } = CASE_STATES;
const c = (title, state = ACTIVE) => ({ title, state });

test('maskedCases and rawCases read the state of every case: modifiers, options object, test.only', () => {
  const src = [
    "test('plain', () => {});",
    "test.only('only', () => {});",
    "it.skip('mod skip', () => {});",
    "test.todo('mod todo');",
    "test('opt skip', { skip: true }, () => {});",
    "test('opt todo', { todo: 'later' }, () => {});",
    "test('opt reason', { skip: 'flaky' }, () => {});",
    "test('opt false', { skip: false, todo: 0 }, () => {});",
    "test('opt empty', { skip: '' }, () => {});",
    "test('opt dynamic', { skip: process.env.CI }, () => {});",
    "test('opt shorthand', { skip }, () => {});",
    "test('opt quoted', { 'todo': true }, () => {});",
    "test('opt other', { timeout: 5 }, () => {});",
    "test({ skip: true }, () => {});",
  ].join('\n');
  const expected = [
    ['plain', ACTIVE], ['only', ACTIVE], ['mod skip', SKIPPED], ['mod todo', TODO], ['opt skip', SKIPPED], ['opt todo', TODO],
    ['opt reason', SKIPPED], ['opt false', ACTIVE], ['opt empty', ACTIVE], ['opt dynamic', SKIPPED], ['opt shorthand', SKIPPED],
    ['opt quoted', TODO], ['opt other', ACTIVE], [DYNAMIC_TITLE, SKIPPED],
  ];
  assert.deepEqual(maskedCases(src).map((x) => [x.title, x.state]), expected);
  assert.deepEqual(rawCases(src).map((x) => [x.title, x.state]), expected);
});

test('stateOfOptions: skip wins over todo, unknown entries are ignored, a missing text is active', () => {
  assert.equal(stateOfOptions(' todo: true, skip: true '), SKIPPED);
  assert.equal(stateOfOptions(' todo: true, skip: false '), TODO);
  assert.equal(stateOfOptions(' "S0": true ', (t) => (t === '"S0"' ? 'skip' : null)), SKIPPED);
  assert.equal(stateOfOptions(' "S0": true ', () => 'timeout'), ACTIVE);
  assert.equal(stateOfOptions(' skip: "S1" ', (t) => (t === '"S1"' ? '' : null)), ACTIVE, 'an empty masked string is falsy');
  assert.equal(stateOfOptions(' skip: `` '), SKIPPED, 'a masked template keeps no text: never read as falsy');
  assert.equal(stateOfOptions(null), ACTIVE);
  assert.equal(stateOfOptions('a: { b'), ACTIVE);
});

test('maskedCases counts assertions in the call only, on code: comments and strings do not count; an unclosed call is unread', () => {
  const src = "test('a case', (t) => {\n  assert.equal(1, 1);\n  assert(x);\n  t.assert.ok(y);\n  assert.strict.equal(1, 1);\n  // assert.ok(z)\n  const s = 'assert.ok(z)';\n  foo.assert(1);\n});\nassert.ok(outside);\n";
  assert.deepEqual(maskedCases(src), [{ title: 'a case', state: ACTIVE, assertions: 4 }]);
  assert.equal(maskedCases("test('open case', () => {\n  assert.ok(1);\n")[0].assertions, null);
  assert.equal(maskedCases(") test('x case', () => { assert.ok(1); });")[0], undefined, 'not a statement start');
  assert.deepEqual(maskedCases('test(`tpl ${x}`, () => {});').map((x) => x.title), [DYNAMIC_TITLE]);
  assert.deepEqual(rawCases('test(`tpl`, () => {});\ntest(name, () => {});').map((x) => x.title), [DYNAMIC_TITLE, DYNAMIC_TITLE]);
  assert.deepEqual([maskedCases(null), rawCases(undefined)], [[], []]);
});

test('lineCases reads one diff line each; options on a later line are not seen', () => {
  assert.deepEqual(lineCases(["test.skip('a', () => {", "  it('b', { todo: true }, () => {", "test('c', {", 'assert.ok(/x/.test(v));', "await test(\"d\", () => {"]),
    [c('a', SKIPPED), c('b', TODO), c('c'), c('d')]);
  assert.deepEqual(lineCases(null), []);
});

test('compareCases: deactivated, deleted, re-enabled, kept inactive and added cases', () => {
  assert.deepEqual(compareCases([c('a'), c('b')], [c('a', SKIPPED), c('b')]), { removed: [{ title: 'a', became: SKIPPED }], added: [] });
  assert.deepEqual(compareCases([c('a')], []), { removed: [{ title: 'a', became: null }], added: [] });
  assert.deepEqual(compareCases([c('p', TODO)], [c('p', TODO)]), { removed: [], added: [] }, 'already inactive and kept');
  assert.deepEqual(compareCases([c('p', TODO)], [c('p')]), { removed: [], added: [] }, 're-enabled: not a removal, not a replacement');
  assert.deepEqual(compareCases([c('p', SKIPPED)], []), { removed: [{ title: 'p', became: null }], added: [] }, 'an inactive case deleted');
  assert.deepEqual(compareCases([c('a')], [c('n'), c('x', SKIPPED)]), { removed: [{ title: 'a', became: null }], added: ['n'] });
  // The same title skipped before and after does not hide the new deactivation of its active twin (which twin is new is not knowable).
  const twins = compareCases([c('d'), c('d', SKIPPED)], [c('d', SKIPPED), c('d', TODO)]);
  assert.deepEqual([twins.removed.length, twins.removed[0].title, [SKIPPED, TODO].includes(twins.removed[0].became), twins.added], [1, 'd', true, []]);
});

test('casesChange: a removal needs both readings, a gain either; a fooled lexer cannot fake a deactivation', () => {
  const base = "test('kept case', () => {});\n";
  assert.deepEqual(casesChange(base, "test.skip('kept case', () => {});\n"), { removed: ['kept case'], added: [], became: new Map([['kept case', SKIPPED]]) });
  // In a fixture (template literal) the raw reading sees a skip the masked one does not: no removal.
  const fixture = "const fx = `\ntest.skip('kept case', () => {});\n`;\n";
  assert.deepEqual(casesChange(base + fixture, `${base}${fixture}`).removed, []);
  assert.deepEqual(casesChange("test('a case', () => {});\nconst fx = `\ntest('a case', () => {});\n`;\n", "test.skip('a case', () => {});\nconst fx = `\ntest('a case', () => {});\n`;\n").removed, ['a case']);
});

test('assertionDrops pairs kept titles in order and skips dynamic titles, unread bodies and cases the raw reading does not see', () => {
  const two = (n) => `test('dup case', () => {\n${'  assert.ok(1);\n'.repeat(n)}});\n`;
  assert.deepEqual(assertionDrops(two(2) + two(2), two(2) + two(1)), [{ title: 'dup case', was: 2, is: 1 }]);
  assert.deepEqual(assertionDrops(two(2) + two(2), two(2)), [], 'the second twin is gone: test_count_drop, not this rule');
  assert.deepEqual(assertionDrops('test(name, () => { assert.ok(1); });\n', 'test(name, () => {});\n'), []);
  assert.deepEqual(assertionDrops(two(2), "test('dup case', () => {\n  assert.ok(1);\n"), [], 'unclosed after: unread');
  assert.deepEqual(assertionDrops(two(2), `x; ${two(1)}`), [], 'not at a line start: the raw reading does not see the case');
  assert.deepEqual(assertionDrops(two(2), two(2).replace("test('dup case'", "test.skip('dup case'")), [], 'deactivated: test_count_drop, not this rule');
});

test('isWaived needs a title of MIN_TITLE_CHARS named in the text; clipTitle and without', () => {
  assert.equal(MIN_TITLE_CHARS, 8);
  assert.equal(isWaived('Named Case', 'this drops the named case test'), true);
  assert.equal(isWaived('short', 'short'), false);
  assert.equal(isWaived('named case', null), false);
  assert.equal(clipTitle(`a\n\`b\`${'x'.repeat(200)}`).length, 160);
  assert.equal(clipTitle('a\n`b`'), 'a b');
  assert.deepEqual(without(['a', 'a', 'b'], ['a']), ['a', 'b']);
});

// PR #345 review (Codex): the two finding classes, every reading.
test('options with nested braces, calls or arrays are read at their top level, on every reading', () => {
  const forms = [
    "{ skip: true, signal: new AbortController({}).signal }",
    "{ signal: f({ a: 1 }), skip: 'x' }",
    "{ meta: { owner: 'a' }, todo: true }",
    "{ tags: ['a', 'b'], skip: process.env.CI }",
    "{\n  timeout: 5,\n  meta: { a: { b: 1 } },\n  skip: true,\n}",
  ];
  for (const opts of forms) {
    const src = `test('nested case', ${opts}, () => {});\n`;
    const want = /todo: true/.test(opts) ? TODO : SKIPPED;
    assert.equal(maskedCases(src)[0].state, want, `masked ${opts}`);
    assert.equal(rawCases(src)[0].state, want, `raw ${opts}`);
    if (!opts.includes('\n')) assert.equal(lineCases([src.trim()])[0].state, want, `line ${opts}`);
  }
  // A nested skip is not the case's own option; a brace or a comma inside a string is text.
  assert.equal(maskedCases("test('n case', { meta: { skip: true } }, () => {});")[0].state, ACTIVE);
  assert.equal(rawCases("test('n case', { label: '}, skip: true', timeout: 1 }, () => {});")[0].state, ACTIVE);
  assert.equal(rawCases("test('n case', { label: '{', skip: true }, () => {});")[0].state, SKIPPED);
  // An object past the cap is read up to it; an unclosed quote stops at the cap.
  const long = `test('long case', { pad: '${'x'.repeat(MAX_OPTIONS_CHARS)}', skip: true }, () => {});`;
  assert.equal(rawCases(long)[0].state, ACTIVE, 'past the cap: not seen');
  assert.equal(rawCases(`test('open case', { skip: true, label: 'unclosed ${'y'.repeat(50)}`)[0].state, SKIPPED);
  assert.deepEqual(casesChange("test('kept test case', () => {});\n", "test('kept test case', { skip: true, signal: new AbortController({}).signal }, () => {});\n").removed, ['kept test case']);
});

test('a body holding a regex literal or a division is not read: no assertion drop is guessed', () => {
  const base = "test('kept test case', () => {\n  assert.ok(x);\n});\n";
  for (const added of ['const re = /\\)/;', 'const re = /\\(/;', 'const half = total / 2;']) {
    const head = base.replace('  assert.ok', `  ${added}\n  assert.ok`);
    assert.equal(maskedCases(head)[0].assertions, null, added);
    assert.deepEqual(assertionDrops(base, head), [], added);
  }
  // A regex outside every case body does not hide the drop of a case after it.
  const withRe = (n) => `const re = /\\)/;\ntest('kept test case', () => {\n${'  assert.ok(x);\n'.repeat(n)}});\n`;
  assert.deepEqual(assertionDrops(withRe(2), withRe(1)), [{ title: 'kept test case', was: 2, is: 1 }]);
});

// PR #345 review (Codex, round 2): a comment must not blind the raw reading, which a removal needs to agree.
test('comments around and inside an options object, and before the title, do not hide a skip on any reading', () => {
  const base = "test('kept test case', () => {});\n";
  const forms = [
    "test('kept test case', { /* flaky */ skip: true }, () => {});\n",
    "test('kept test case', /* why */ { skip: true }, () => {});\n",
    "test('kept test case', // why\n  { skip: true }, () => {});\n",
    "test('kept test case', {\n  // flaky on CI\n  skip: true,\n}, () => {});\n",
    "test(/* c */ 'kept test case', { skip: true }, () => {});\n",
    "test('kept test case', { label: 'a /* b', skip: true }, () => {});\n",
  ];
  for (const head of forms) {
    assert.deepEqual([maskedCases(head)[0].state, rawCases(head)[0].state, rawCases(head)[0].title], [SKIPPED, SKIPPED, 'kept test case'], head);
    assert.deepEqual(casesChange(base, head).removed, ['kept test case'], head);
  }
  assert.equal(lineCases(["test('kept test case', /* why */ { /* flaky */ todo: true }, () => {"])[0].state, TODO);
  assert.equal(lineCases(["test(/* c */ 'kept test case', () => {"])[0].title, 'kept test case');
  // A skip written only inside a comment is no option; an unclosed comment stops at the bound.
  assert.equal(rawCases("test('kept test case', { timeout: 5 /* skip: true */ }, () => {});")[0].state, ACTIVE);
  assert.equal(rawCases("test('kept test case', { timeout: 5 // skip: true\n }, () => {});")[0].state, ACTIVE);
  assert.equal(rawCases("test('kept test case', /* never closed { skip: true }")[0].state, ACTIVE);
  assert.equal(rawCases("test('kept test case', // never ends")[0].state, ACTIVE);
  assert.equal(rawCases("test('kept test case', { skip: true /* never closed")[0].state, SKIPPED);
  assert.equal(rawCases(`test('kept test case', ${' '.repeat(MAX_OPTIONS_CHARS)}{ skip: true }, () => {});`)[0].state, ACTIVE, 'past the bound');
});

test('hostile text: many unclosed comments and options objects stay linear', () => {
  const lines = 20000;
  const hostile = ["test(/* x\n", "test('t', /* x\n", "test('t', { /* x\n", "test('t', { a: '\n"].map((l) => l.repeat(lines));
  for (const text of hostile) {
    const started = Date.now();
    maskedCases(text);
    rawCases(text);
    casesChange(text, text);
    assert.ok(Date.now() - started < 5000, `${JSON.stringify(text.slice(0, 16))}: ${Date.now() - started} ms`);
  }
});
