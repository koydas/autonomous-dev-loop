import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGates, c8Args, runGates, GATES_CONFIG_PATH } from '../lib/coverage_gates.mjs';
import { parseArgs } from '../coverage_gates.mjs';

const cfg = (gates, threshold = 80) => JSON.stringify({ threshold, gates });
const rejects = (text, pattern) => assert.throws(() => parseGates(text), pattern);

test('parseGates: a bare module path is measured through <name>.test.mjs; { module, test, note } overrides it', () => {
  const { threshold, gates } = parseGates(cfg(['scripts/lib/a.mjs', { module: 'scripts/lib/b.mjs', test: 'c.test.mjs', note: 'why' }, { module: 'scripts/entry.mjs' }]));
  assert.equal(threshold, 80);
  assert.deepEqual(gates, [
    { module: 'scripts/lib/a.mjs', test: 'a.test.mjs', note: null },
    { module: 'scripts/lib/b.mjs', test: 'c.test.mjs', note: 'why' },
    { module: 'scripts/entry.mjs', test: 'entry.test.mjs', note: null },
  ]);
});

test('parseGates: every malformed config is refused with the field named', () => {
  rejects('not json', /is not valid JSON/);
  for (const bad of ['null', '[]', '"x"', '5']) rejects(bad, /must be an object/);
  for (const t of [0, 101, 80.5, '80', null, undefined]) rejects(JSON.stringify({ threshold: t, gates: ['scripts/a.mjs'] }), /threshold must be an integer from 1 to 100/);
  for (const g of [undefined, [], 'scripts/a.mjs', {}]) rejects(JSON.stringify({ threshold: 80, gates: g }), /gates must be a non-empty array/);
  rejects(cfg([5]), /gates\[0\] must be a module path or \{ module, test \}/);
  rejects(cfg([null]), /gates\[0\] must be a module path/);
  rejects(cfg([['scripts/a.mjs']]), /gates\[0\] must be a module path/);
  for (const m of ['lib/a.mjs', 'scripts/a.js', 'scripts/a/b/c.mjs', '../scripts/a.mjs', 'scripts/lib/a b.mjs', '', 5]) rejects(cfg([{ module: m }]), /gates\[0\]\.module must be scripts\/<name>\.mjs or scripts\/lib\/<name>\.mjs/);
  rejects(cfg(['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/lib/a.mjs']), /gates\[2\]\.module scripts\/lib\/a\.mjs is listed twice/);
  for (const t of ['dir/a.test.mjs', 'a.mjs', '../a.test.mjs', 5]) rejects(cfg([{ module: 'scripts/lib/a.mjs', test: t }]), /gates\[0\]\.test must be a bare <name>\.test\.mjs/);
  rejects(cfg([{ module: 'scripts/lib/a.mjs', note: 'x'.repeat(301) }]), /gates\[0\]\.note must be a string of at most 300 characters/);
  rejects(cfg([{ module: 'scripts/lib/a.mjs', note: 7 }]), /\.note must be a string/);
});

test('the real config parses, names a test file for every gate and keeps the reasons of its notes', () => {
  const { threshold, gates } = parseGates(readFileSync(new URL(`../../${GATES_CONFIG_PATH}`, import.meta.url), 'utf8'));
  assert.equal(threshold, 80);
  assert.ok(gates.length >= 43);
  assert.deepEqual(gates.find((g) => g.module === 'scripts/lib/pipeline_waiting.mjs'), { module: 'scripts/lib/pipeline_waiting.mjs', test: 'waiting_on_you.test.mjs', note: null });
  assert.equal(gates.find((g) => g.module === 'scripts/lib/layered_config.mjs').test, 'roots.test.mjs');
  assert.match(gates.find((g) => g.module === 'scripts/build_eval_site.mjs').note, /Entrypoint gate/);
});

test('c8Args: c8 over the module with all four dimensions at the threshold, measured through its test file', () => {
  assert.deepEqual(c8Args({ module: 'scripts/lib/a.mjs', test: 'a.test.mjs' }, 80), [
    '--yes', 'c8', '--include', 'scripts/lib/a.mjs', '--check-coverage', '--lines', '80', '--branches', '80', '--functions', '80', '--statements', '80',
    'node', '--test', 'scripts/tests/a.test.mjs',
  ]);
  assert.equal(c8Args({ module: 'scripts/x.mjs', test: 'y.test.mjs' }, 90).filter((a) => a === '90').length, 4);
});

test('runGates: every gate runs and is reported, a failure does not stop the others and names its reproduction', () => {
  const config = { threshold: 80, gates: [{ module: 'scripts/lib/a.mjs', test: 'a.test.mjs' }, { module: 'scripts/lib/b.mjs', test: 'b.test.mjs' }, { module: 'scripts/lib/c.mjs', test: 'c.test.mjs' }] };
  const ran = [];
  const logs = [];
  const out = runGates(config, (args) => { ran.push(args[args.indexOf('--include') + 1]); return args.includes('scripts/lib/b.mjs') ? 1 : 0; }, { log: (l) => logs.push(l) });
  assert.deepEqual(ran, ['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/lib/c.mjs']);
  assert.deepEqual(out.failed, ['scripts/lib/b.mjs']);
  assert.deepEqual(out.results.map((r) => r.status), [0, 1, 0]);
  assert.equal(logs.filter((l) => l.startsWith('::group::c8 ')).length, 3);
  assert.equal(logs.filter((l) => l === '::endgroup::').length, 3);
  assert.deepEqual(logs.filter((l) => l.startsWith('::error::')), ['::error::coverage gate failed: scripts/lib/b.mjs (run: node scripts/coverage_gates.mjs --only scripts/lib/b.mjs)']);
  assert.ok(logs[0].includes('(≥80%, a.test.mjs)'));
  // All green: nothing failed, nothing logged as an error; the default logger is silent.
  assert.deepEqual(runGates(config, () => 0).failed, []);
});

test('runGates --only: one gate; an unknown module is an error that points at the config', () => {
  const config = { threshold: 80, gates: [{ module: 'scripts/lib/a.mjs', test: 'a.test.mjs' }, { module: 'scripts/lib/b.mjs', test: 'b.test.mjs' }] };
  const ran = [];
  const out = runGates(config, (args) => { ran.push(args[args.indexOf('--include') + 1]); return 0; }, { only: 'scripts/lib/b.mjs' });
  assert.deepEqual(ran, ['scripts/lib/b.mjs']);
  assert.equal(out.results.length, 1);
  assert.throws(() => runGates(config, () => 0, { only: 'scripts/lib/nope.mjs' }), /scripts\/lib\/nope\.mjs is not a coverage gate; the gates are in config\/coverage-gates\.json/);
});

test('CLI arguments: none, or --only <module>; anything else is refused (--sync is gone: the prompt carries no list)', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['--only', 'scripts/lib/a.mjs']), { only: 'scripts/lib/a.mjs' });
  for (const bad of [['--only'], ['--only', '--sync'], ['--only', ''], ['--sync'], ['--sync', 'x'], ['--run'], ['scripts/lib/a.mjs'], ['--only', 'a', 'b']]) {
    assert.throws(() => parseArgs(bad), /unknown arguments/, JSON.stringify(bad));
  }
});
