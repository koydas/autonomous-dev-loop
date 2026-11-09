import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCheckThenUse } from '../lib/check_then_use.mjs';

// A hunk from lines: a leading `+` marks an added line, anything else is context.
const hunk = (lines, context = '') => [{ context, lines: lines.map((t, i) => ({ text: t[0] === '+' ? t.slice(1) : t, added: t[0] === '+', no: i + 1 })) }];
const pairs = (lines, opts) => findCheckThenUse(hunk(lines), opts).map((p) => [p.check.fn, p.check.ident, p.check.line, p.use.fn, p.use.ident, p.use.line]);

test('lstat then readFile on the same identifier is a pair, with both lines', () => {
  assert.deepEqual(pairs(['function read(p) {', '+  const st = fs.lstatSync(p);', '+  return fs.readFileSync(p, "utf8");', '}']), [['lstat', 'p', 2, 'readFile', 'p', 3]]);
});

test('stat then open, promises and callback forms, member paths and a bare import are pairs', () => {
  assert.equal(pairs(['async function f(p) {', '+  await fsp.stat(p);', '+  return open(p);', '}']).length, 1);
  assert.equal(pairs(['async function f(p) {', '+  await fs.promises.access(p);', '+  await fs.promises.unlink(p);', '}']).length, 1);
  assert.equal(pairs(['function f(opts) {', '+  fs.stat(opts.file, (err, st) => {', '+    fs.readFile(opts.file, (e, d) => d);', '+  });', '}']).length, 1, 'callback form: the use is nested in the callback');
  assert.equal(pairs(['function f(p) {', '+  if (existsSync(p)) rmSync(p);', '}']).length, 1);
  assert.equal(pairs(['function f(o) {', '+  stat(o?.path);', '+  readdir(o.path);', '}']).length, 1, 'optional chaining is the same path');
  assert.equal(pairs(['function f(a, b) {', '+  access(b);', '+  copyFile(a, b);', '}']).length, 1, 'the destination of copyFile / rename is a path too');
});

test('open then fh.stat() then fh.read is not a check-then-use', () => {
  assert.deepEqual(pairs(['async function f(p) {', '+  const fh = await open(p, "r");', '+  const st = await fh.stat();', '+  if (!st.isFile()) throw new Error("x");', '+  return fh.readFile();', '}']), []);
});

test('different identifiers, other methods and a call without an identifier argument are not pairs', () => {
  assert.deepEqual(pairs(['function f(a, b) {', '+  fs.statSync(a);', '+  fs.readFileSync(b);', '}']), []);
  assert.deepEqual(pairs(['function f(p) {', '+  cache.stat(p);', '+  db.readFile(p);', '}']), [], 'a method of another object is not fs');
  assert.deepEqual(pairs(['function f(p) {', '+  fs.statSync(p);', '+  fs.readFileSync(join(p, "x"));', '}']), [], 'a computed path is not the same identifier');
  assert.deepEqual(pairs(['function f(p) {', '+  fs.readFileSync(p);', '+  fs.statSync(p);', '}']), [], 'the use must come after the check');
});

test('a check in one function and a use in another are not a pair', () => {
  assert.deepEqual(pairs(['function a(p) {', '+  return fs.statSync(p);', '}', 'function b(p) {', '+  return fs.readFileSync(p);', '}']), []);
  assert.deepEqual(pairs(['const a = (p) => fs.statSync(p);', '+const b = (p) => fs.readFileSync(p);']), [], 'expression-bodied arrows are scopes');
  assert.deepEqual(pairs(['const a = (p) => fs.statSync(p)', '+const b = (p) => fs.readFileSync(p)']), [], 'an arrow body ends before the next statement');
  assert.deepEqual(pairs(['const o = {', '+  a: (p) => fs.statSync(p),', '+  b: (p) => fs.readFileSync(p),', '};']), []);
  assert.deepEqual(pairs(['  if (x) {', '+    fs.statSync(p);', '  }', '+  fs.readFileSync(p);']), [], 'a check inside a closed block is not read');
});

test('a hunk that starts inside a function reads the closing brace as the end of that function', () => {
  assert.deepEqual(pairs(['+  fs.statSync(p);', '}', 'function b(p) {', '+  fs.readFileSync(p);', '}']), []);
});

test('removed lines are not in the new side, comments and strings do not count', () => {
  const removed = hunk(['function f(p) {', '+  const st = fs.lstatSync(p);', '  return 1;', '}']);
  assert.deepEqual(findCheckThenUse(removed), [], 'the use was on a removed line, so it is not in the hunk lines');
  assert.deepEqual(pairs(['function f(p) {', '+  // fs.statSync(p);', '+  return fs.readFileSync(p);', '}']), []);
  assert.deepEqual(pairs(['function f(p) {', '+  /* fs.statSync(p);', '+     more */', '+  return fs.readFileSync(p);', '}']), []);
  assert.deepEqual(pairs(['function f(p) {', '+  const doc = "fs.statSync(p) then fs.readFileSync(p)";', '+  return `see fs.statSync(p)`;', '}']), []);
});

test('line numbers survive a block comment and a template literal between the calls', () => {
  assert.deepEqual(pairs(['function f(p) {', '+  fs.statSync(p);', '+  /* one', '+     two */', '+  const t = `a', '+  b`;', '+  return fs.readFileSync(p);', '}']), [['stat', 'p', 2, 'readFile', 'p', 7]]);
});

test('a pair the PR did not touch is not reported; one added call is enough', () => {
  assert.deepEqual(pairs(['function f(p) {', '  fs.statSync(p);', '  return fs.readFileSync(p);', '}']), []);
  assert.equal(pairs(['function f(p) {', '  fs.statSync(p);', '+  return fs.readFileSync(p);', '}']).length, 1);
  assert.equal(pairs(['function f(p) {', '+  fs.statSync(p);', '  return fs.readFileSync(p);', '}']).length, 1, 'the target incident: the use is a context line');
});

test('a reassignment of the identifier between the calls ends the pair', () => {
  assert.deepEqual(pairs(['function f(p) {', '+  fs.statSync(p);', '+  p = fresh();', '+  return fs.readFileSync(p);', '}']), []);
  assert.equal(pairs(['function f(p) {', '+  fs.statSync(p);', '+  if (p === q) log(p);', '+  return fs.readFileSync(p);', '}']).length, 1, '=== is a comparison');
});

test('waiver: a paragraph that names the function and owns the risk; naming the function alone is not one', () => {
  const lines = ['export function readManifest(dir) {', '+  fs.lstatSync(dir);', '+  return fs.readFileSync(dir);', '}'];
  assert.equal(pairs(lines, { mentionText: 'readManifest now refuses anything that is not a regular file.' }).length, 1);
  assert.deepEqual(pairs(lines, { mentionText: 'Fixes it.\n\nThe check-then-use in `readManifest` is intentional: the directory is private.' }), []);
  assert.equal(pairs(lines, { mentionText: 'A race is possible.\n\nreadManifest refuses links.' }).length, 1, 'the acknowledgement and the name are in different paragraphs');
  assert.equal(pairs(lines, { mentionText: 'The check-then-use in readManifestAll is intentional.' }).length, 1, 'a longer name is another function');
  assert.deepEqual(pairs(['+  fs.lstatSync(dir);', '+  return fs.readFileSync(dir);'].map((l) => l), { mentionText: 'x' }).length, 1);
});

test('the function named in the hunk header is the name of the hunk top level', () => {
  const lines = ['+  fs.lstatSync(p);', '+  return fs.readFileSync(p);'];
  assert.equal(findCheckThenUse(hunk(lines, 'export async function loadConfig(p) {'), { mentionText: 'unrelated' }).length, 1);
  assert.deepEqual(findCheckThenUse(hunk(lines, 'export async function loadConfig(p) {'), { mentionText: 'toctou accepted in loadConfig' }), []);
  assert.deepEqual(findCheckThenUse(hunk(lines, 'const loadConfig = async (p) => {'), { mentionText: 'toctou accepted in loadConfig' }), []);
  assert.deepEqual(findCheckThenUse(hunk(lines, '  loadConfig(p) {'), { mentionText: 'toctou accepted in loadConfig' }), []);
});

test('scope names: declarations, arrows assigned to a name, methods, keywords are not names', () => {
  const body = (head) => [head, '+  fs.statSync(p);', '+  fs.readFileSync(p);', '}'];
  for (const head of ['async function* gen(p) {', 'const run = async (p) => {', 'const run = p => {', 'run: function (p) {', 'class A { static async run(p) {']) {
    assert.deepEqual(pairs(body(head), { mentionText: 'toctou intentional in run, gen' }), [], head);
  }
  assert.equal(pairs(body('if (p) {'), { mentionText: 'toctou intentional in if' }).length, 1, 'if is not a function name');
});

test('findings are capped per file and by the check count; empty or malformed hunks give nothing', () => {
  const many = ['function f(p) {', ...Array.from({ length: 6 }, (_, i) => `+  fs.statSync(p${i}); fs.readFileSync(p${i});`), '}'];
  assert.equal(findCheckThenUse(hunk(many)).length, 3);
  assert.equal(findCheckThenUse([...hunk(['function f(p) {', '+  fs.statSync(p);', '+  fs.readFileSync(p);', '}']), ...hunk(['function g(q) {', '+  fs.statSync(q);', '+  fs.readFileSync(q);', '}'])]).length, 2);
  const flood = hunk(['function f(p) {', ...Array.from({ length: 300 }, () => '+  fs.statSync(p);'), '}']);
  assert.deepEqual(findCheckThenUse(flood), [], 'no use at all: nothing, and the scan is bounded');
  assert.deepEqual(findCheckThenUse([]), []);
  assert.deepEqual(findCheckThenUse(undefined), []);
  assert.deepEqual(findCheckThenUse([{ lines: [] }, { context: 'x' }]), []);
  const unnumbered = [{ context: '', lines: [{ text: 'fs.statSync(p);', added: true, no: null }, { text: 'fs.readFileSync(p);', added: true, no: null }] }];
  assert.deepEqual(findCheckThenUse(unnumbered).map((p) => [p.check.line, p.use.line]), [[null, null]]);
});

test('hostile text stays linear: thousands of unclosed brackets, arrows and braces', () => {
  const t0 = Date.now();
  findCheckThenUse(hunk(['+' + '(['.repeat(20000), '+' + '=> '.repeat(20000), '+' + '{'.repeat(20000), '+fs.statSync(p); fs.readFileSync(p);']));
  assert.ok(Date.now() - t0 < 3000);
});

test('a nested function that rebinds the checked name is another variable (parameter, arrow parameter, declaration)', () => {
  assert.deepEqual(pairs(['function inspect(p) {', '+  fs.statSync(p);', '+  function unrelated(p) { return fs.readFileSync(p); }', '}']), [], 'a parameter shadows');
  assert.deepEqual(pairs(['function inspect(p) {', '+  fs.statSync(p);', '+  const later = (p) => fs.readFileSync(p);', '}']), [], 'an arrow parameter shadows');
  assert.deepEqual(pairs(['function inspect(p) {', '+  fs.statSync(p);', '+  const later = p => fs.readFileSync(p);', '}']), [], 'a bare arrow parameter shadows');
  assert.deepEqual(pairs(['function inspect(p) {', '+  fs.statSync(p);', '+  const later = () => { const p = other(); return fs.readFileSync(p); };', '}']), [], 'a declaration shadows');
  assert.deepEqual(pairs(['function inspect(o) {', '+  fs.statSync(o.file);', '+  const later = (o) => fs.readFileSync(o.file);', '}']), [], 'a member path shadows through its root');
  assert.equal(pairs(['function inspect(p) {', '+  fs.statSync(p);', '+  const later = (q) => fs.readFileSync(p);', '}']).length, 1, 'another parameter name leaves the outer p in use');
  assert.equal(pairs(['function inspect(p) {', '+  fs.stat(p, (err) => {', '+    fs.readFile(p, (e, d) => d);', '+  });', '}']).length, 1, 'a callback that does not rebind p is still a pair');
});

test('line numbers survive interpolations in a multiline template literal', () => {
  assert.deepEqual(pairs(['function f(p) {', '  fs.statSync(p);', '+  const t = `head', '+${fs.readFileSync(p)}', '+tail`;', '}']), [['stat', 'p', 2, 'readFile', 'p', 4]], 'the read keeps its own line, not the template opening line');
});

test('line numbers survive a backslash-continued string', () => {
  assert.deepEqual(pairs(['function f(p) {', '+  fs.statSync(p);', '+  const s = "one \\', '+  two";', '+  return fs.readFileSync(p);', '}']), [['stat', 'p', 2, 'readFile', 'p', 5]]);
});

test('the destination of rename / copyFile is matched whatever the source argument is', () => {
  assert.equal(pairs(['function f(dest) {', '+  fs.accessSync(dest);', "+  fs.copyFileSync('source.txt', dest);", '}']).length, 1, 'literal source');
  assert.equal(pairs(['function f(dest, d) {', '+  fs.accessSync(dest);', '+  fs.renameSync(join(d, "a"), dest);', '}']).length, 1, 'computed source');
  assert.equal(pairs(['function f(dest) {', '+  fs.accessSync(dest);', '+  fs.copyFileSync(path.join(a, b), dest);', '}']).length, 1, 'nested call in the source');
  assert.deepEqual(pairs(['function f(dest) {', '+  fs.accessSync(dest);', "+  fs.copyFileSync(dest + '.bak', other);", '}']), [], 'the destination is another name');
  assert.deepEqual(pairs(['function f(dest) {', '+  fs.accessSync(dest);', "+  fs.readFileSync('x', dest);", '}']), [], 'only rename / copyFile read a second path');
});

test('a control-flow header binds nothing: an if / while condition on the checked name is still a pair', () => {
  assert.equal(pairs(['function f(p) {', '+  if (fs.existsSync(p)) {', '+    return fs.readFileSync(p);', '+  }', '}']).length, 1, 'if (exists(p)) { read(p) }');
  assert.equal(pairs(['function f(p) {', '+  while (fs.existsSync(p)) {', '+    fs.rmSync(p);', '+  }', '}']).length, 1, 'while');
  assert.equal(pairs(['function f(p) {', '+  fs.statSync(p);', '+  if (ok(p)) {', '+    fs.readFileSync(p);', '+  }', '}']).length, 1, 'a later if (ok(p)) block does not hide the use');
  assert.deepEqual(pairs(['function f(p) {', '+  fs.statSync(p);', '+  for (const p of list) {', '+    fs.readFileSync(p);', '+  }', '}']), [], 'for (const p of ...) rebinds p');
  assert.deepEqual(pairs(['function f(p) {', '+  fs.statSync(p);', '+  try { x(); } catch (p) {', '+    fs.readFileSync(p);', '+  }', '}']), [], 'catch (p) rebinds p');
});
