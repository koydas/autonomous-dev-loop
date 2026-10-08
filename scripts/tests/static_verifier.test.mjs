import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES,
  isJsFile,
  maskSource,
  extractImportSpecifiers,
  findModuleSystemViolation,
  extractExportedSignatures,
  findSignatureViolations,
  packageRoot,
  findUnresolvedImports,
  findGuardrailViolations,
  guardrailErrorFor,
  guardrailRules,
} from '../lib/static_verifier.mjs';
import { GuardrailError } from '../lib/output_writer.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adr0009-pr122-attempt3');
const fixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');

function ctx({ existing = {}, shown = [], hidden = [], dependencies = {}, files = [], mentionText = '' } = {}) {
  return {
    existing: new Map(Object.entries(existing)),
    shownPaths: new Set(shown.length ? shown : Object.keys(existing)),
    hiddenPaths: new Set(hidden),
    dependencies,
    fileExists: (p) => files.includes(p),
    mentionText,
  };
}

const imports = (files = [], deps = []) => ({ dependencies: new Set(deps), fileExists: (p) => files.includes(p) });

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

test('isJsFile matches JS/TS sources only', () => {
  for (const p of ['a.js', 'a.mjs', 'a.cjs', 'a.ts', 'a.mts', 'a.cts', 'a.jsx', 'a.tsx']) assert.ok(isJsFile(p), p);
  for (const p of ['a.json', 'a.md', 'a.yml', 'Makefile', undefined]) assert.ok(!isJsFile(p), String(p));
});

test('maskSource drops comments and makes strings opaque', () => {
  const { code, strings } = maskSource(`// require('a')\n/* import b from 'b' */\nconst s = "x"; const t = 'y'; const u = \`require('z')\`;`);
  assert.doesNotMatch(code, /require|import/);
  assert.deepEqual(strings, ['x', 'y']);
  assert.match(code, /const s = "S0"; const t = "S1"; const u = ``;/);
});

test('maskSource tolerates an empty or missing source', () => {
  assert.deepEqual(maskSource(undefined), { code: '', strings: [] });
});

test('extractImportSpecifiers finds static, side-effect, re-export, dynamic and require specifiers', () => {
  const src = [
    "import fs from 'node:fs';",
    "import { a,\n  b as c } from './lib/a.mjs';",
    "import './side-effect.js';",
    "import * as ns from \"pkg\";",
    "export { x } from '@scope/pkg/sub';",
    "const m = await import('dyn');",
    "const r = require('cjs-pkg');",
    "const notImport = 'import z from \"zz\"';",
    "obj.require('not-a-call');",
  ].join('\n');
  assert.deepEqual(extractImportSpecifiers(src).sort(), ['./lib/a.mjs', './side-effect.js', '@scope/pkg/sub', 'cjs-pkg', 'dyn', 'node:fs', 'pkg']);
});

// ---------------------------------------------------------------------------
// Rule 1 — module system
// ---------------------------------------------------------------------------

test('module system: adding require() to an .mjs file is rejected (ADR-0009, PR #122 attempt 3)', () => {
  assert.match(findModuleSystemViolation('scripts/lib/a.mjs', "import x from 'x';\n", "import x from 'x';\nconst nyc = require('nyc');\n"), /require\(\) to an ES module/);
});

test('module system: a new .mjs file with require() is rejected', () => {
  assert.match(findModuleSystemViolation('src/new.mjs', null, "const x = require('x');"), /ESM-only/);
});

test('module system: an .mjs edit without require(), or keeping an existing one, passes', () => {
  assert.equal(findModuleSystemViolation('a.mjs', "import x from 'x';", "import x from 'x';\nexport const y = x;"), null);
  const legacy = "const r = createRequire(import.meta.url);\nconst x = require('x');";
  assert.equal(findModuleSystemViolation('a.mjs', legacy, `${legacy}\nexport const y = 1;`), null);
});

test('module system: require() mentioned in a comment or string does not count', () => {
  assert.equal(findModuleSystemViolation('a.mjs', '', "// never require('x') here\nconst msg = \"require('y')\";"), null);
});

test('module system: converting a .cjs file to ESM is rejected; a CJS-only edit passes', () => {
  const before = "const fs = require('fs');\nmodule.exports = { a: 1 };\n";
  assert.match(findModuleSystemViolation('lib/a.cjs', before, "import fs from 'fs';\nexport const a = 1;\n"), /converts a CommonJS file \(\.cjs\)/);
  assert.equal(findModuleSystemViolation('lib/a.cjs', before, `${before}module.exports.b = 2;\n`), null);
  assert.equal(findModuleSystemViolation('lib/a.cjs', before, `${before}const m = await import('x');\n`), null, 'dynamic import() is valid CommonJS');
});

test('module system: a CommonJS .js file stays CommonJS', () => {
  const before = "const fs = require('fs');\nexports.read = () => fs;\n";
  assert.match(findModuleSystemViolation('lib/a.js', before, "import fs from 'fs';\nexport const read = () => fs;\n"), /converts a CommonJS file to ESM/);
  assert.equal(findModuleSystemViolation('lib/a.js', before, `${before}exports.write = () => fs;\n`), null);
});

test('module system: an ESM .js file stays require-free', () => {
  const before = "import fs from 'fs';\nexport const read = () => fs;\n";
  assert.match(findModuleSystemViolation('lib/a.js', before, `${before}const x = require('x');\n`), /adds require\(\) to an ES module$/);
  assert.equal(findModuleSystemViolation('lib/a.js', before, `${before}export const write = () => fs;\n`), null);
});

test('module system: new .js/.cjs files, format-less .js files and non-JS files are not checked', () => {
  assert.equal(findModuleSystemViolation('lib/new.js', null, "import x from 'x';\nconst y = require('y');"), null);
  assert.equal(findModuleSystemViolation('lib/new.cjs', null, "export const x = 1;"), null);
  assert.equal(findModuleSystemViolation('lib/plain.js', 'const a = 1;', "import x from 'x';"), null);
  assert.equal(findModuleSystemViolation('notes.md', '', "const x = require('x');"), null);
});

// ---------------------------------------------------------------------------
// Rule 2 — exported signatures
// ---------------------------------------------------------------------------

test('extractExportedSignatures covers declarations, arrows, defaults, export lists and CommonJS', () => {
  const sigs = extractExportedSignatures([
    'export function plain(a, b = 1) {}',
    'export async function* gen(x) {}',
    'export default function main(opts) {}',
    'export const arrow = async ({ a: renamed = 1, b }, ...rest) => a;',
    'export const single = x => x;',
    'export const fnExpr = function (y) {};',
    'export const typed = <T>(value: Map<string, T>, cb: (e: Error) => void): T => value;',
    'export const notFn = (1 + 2);',
    'function local(p, q) {}',
    'const localArrow = (r) => r;',
    'export { local as aliased, localArrow };',
    'exports.cjsFn = function (z) {};',
    'module.exports = { renamedCjs: local, localArrow };',
  ].join('\n'));
  const view = Object.fromEntries([...sigs].map(([name, s]) => [name, `${s.isAsync ? 'async ' : ''}(${s.params.join(',')})`]));
  assert.deepEqual(view, {
    plain: '(a,b)',
    gen: 'async (x)',
    default: '(opts)',
    arrow: 'async ({a,b},...rest)',
    single: '(x)',
    fnExpr: '(y)',
    typed: '(value,cb)',
    aliased: '(p,q)',
    localArrow: '(r)',
    cjsFn: '(z)',
    renamedCjs: '(p,q)',
  });
});

test('extractExportedSignatures ignores an unbalanced parameter list and re-exports', () => {
  assert.equal(extractExportedSignatures("export function broken(a, b {\nexport { x } from './x.js';").size, 0);
});

test('signature: the PR #122 attempt-3 rewrite of coverage_checker.mjs is rejected (ADR-0009)', () => {
  const reasons = findSignatureViolations('scripts/lib/coverage_checker.mjs', fixture('coverage_checker.before.txt'), fixture('coverage_checker.after.txt'));
  assert.ok(reasons.some((r) => /parameters of exported buildAutomationGateContext\(rawDiffText\) to buildAutomationGateContext\(\{prBody,coverageReport\}\)/.test(r)), reasons.join('\n'));
  assert.ok(reasons.some((r) => /removes exported function extractChangedFiles/.test(r)));
});

test('signature: renamed parameter, changed arity, removed export and async switch are each rejected', () => {
  const before = 'export function a(x) {}\nexport function b(x) {}\nexport function c(x) {}\nexport function d(x) {}\nexport async function e(x) {}';
  const after = 'export function a(y) {}\nexport function b(x, y) {}\nexport async function d(x) {}\nexport function e(x) {}';
  assert.deepEqual(findSignatureViolations('m.mjs', before, after), [
    'changes the parameters of exported a(x) to a(y)',
    'changes the arity of exported b(x) to b(x, y)',
    'removes exported function c(x)',
    'makes exported d(x) async (return type changes)',
    'makes exported e(x) synchronous (return type changes)',
  ]);
});

test('signature: body edits, default values, type annotations and new exports pass', () => {
  const before = "export function a(x = 1, { y } = {}) { return x; }\nexport const b = (z: string) => z;";
  const after = "export function a(x = 2, { y = 3 } = {}) { return x + 1; }\nexport const b = (z: number) => z;\nexport function added(q) {}";
  assert.deepEqual(findSignatureViolations('m.ts', before, after), []);
});

test('signature: a change is allowed when the issue or feedback names the function', () => {
  const before = 'export function buildAutomationGateContext(rawDiffText) {}\nfunction local(a) {}\nexport { local as alias };';
  const after = 'export function buildAutomationGateContext(diff, opts) {}\nfunction local(a, b) {}\nexport { local as alias };';
  assert.deepEqual(findSignatureViolations('m.mjs', before, after, 'Please change `buildAutomationGateContext` and `local` to take options.'), []);
  assert.equal(findSignatureViolations('m.mjs', before, after, 'buildAutomationGateContextV2 only').length, 2, 'a longer identifier is not a mention');
});

test('signature: new files, files without exported functions and non-JS files are not checked', () => {
  assert.deepEqual(findSignatureViolations('m.mjs', null, 'export function a() {}'), []);
  assert.deepEqual(findSignatureViolations('m.mjs', 'export const VALUE = 1;', ''), []);
  assert.deepEqual(findSignatureViolations('m.md', 'export function a(x) {}', ''), []);
});

// ---------------------------------------------------------------------------
// Rule 3 — imports resolve
// ---------------------------------------------------------------------------

test('packageRoot keeps the scope and drops subpaths', () => {
  assert.equal(packageRoot('react/jsx-runtime'), 'react');
  assert.equal(packageRoot('@scope/pkg/sub'), '@scope/pkg');
  assert.equal(packageRoot('lodash'), 'lodash');
});

test('imports: an undeclared package is rejected (ADR-0009 nyc, ADR-0019 abort-controller)', () => {
  assert.deepEqual(findUnresolvedImports('src/hook.js', null, "import AbortController from 'abort-controller';", imports()), [
    'imports package "abort-controller", which is not declared in package.json',
  ]);
  assert.deepEqual(findUnresolvedImports('scripts/lib/c.mjs', fixture('coverage_checker.before.txt'), fixture('coverage_checker.after.txt'), imports()), [
    'imports package "nyc", which is not declared in package.json',
  ]);
});

test('imports: declared packages, their subpaths and packages the file already used pass', () => {
  const src = "import React from 'react';\nimport { jsx } from 'react/jsx-runtime';\nimport p from '@scope/pkg/sub';";
  assert.deepEqual(findUnresolvedImports('a.js', null, src, imports([], ['react', '@scope/pkg'])), []);
  assert.deepEqual(findUnresolvedImports('a.js', "import w from 'workspace-lib';", "import w from 'workspace-lib';\nimport x from 'workspace-lib/extra';", imports()), []);
});

test('imports: node builtins pass with or without the prefix; an unknown node: module is rejected', () => {
  const src = "import fs from 'fs';\nimport fsp from 'node:fs/promises';\nimport { test } from 'node:test';";
  assert.deepEqual(findUnresolvedImports('a.mjs', null, src, imports()), []);
  assert.deepEqual(findUnresolvedImports('a.mjs', null, "import x from 'node:nope';", imports()), ['imports "node:nope", which is not a Node.js builtin']);
});

test('imports: relative paths must exist after the patch, with extension and index resolution', () => {
  const files = ['src/lib/util.mjs', 'src/lib/index.ts', 'src/data.json'];
  const ok = "import u from './lib/util.mjs';\nimport v from './lib/util';\nimport i from './lib';\nimport d from './data.json';\nimport q from './lib/util.mjs?raw';";
  assert.deepEqual(findUnresolvedImports('src/app.mjs', null, ok, imports(files)), []);
  assert.deepEqual(findUnresolvedImports('src/app.mjs', null, "import m from './missing.mjs';\nimport e from '../../outside.mjs';", imports(files)), [
    'imports "./missing.mjs", which does not resolve to a file after the patch',
    'imports "../../outside.mjs", which does not resolve to a file after the patch',
  ]);
});

test('imports: absolute paths and URLs are rejected; aliases and #imports are not checked', () => {
  assert.deepEqual(findUnresolvedImports('a.js', null, "import a from '/abs/a.js';\nimport b from 'https://cdn.example/b.js';", imports()), [
    'imports absolute path "/abs/a.js"',
    'imports URL "https://cdn.example/b.js"',
  ]);
  assert.deepEqual(findUnresolvedImports('a.js', null, "import a from '#internal';\nimport b from '@/utils';\nimport c from '~/c';", imports()), []);
});

test('imports: specifiers already in the file are not re-checked, non-JS files are skipped', () => {
  const before = "import gone from './deleted-long-ago.mjs';";
  assert.deepEqual(findUnresolvedImports('a.mjs', before, `${before}\nexport const x = 1;`, imports()), []);
  assert.deepEqual(findUnresolvedImports('a.json', null, "import x from 'x';", imports()), []);
});

// ---------------------------------------------------------------------------
// Combined entry point and escalation helpers
// ---------------------------------------------------------------------------

test('findGuardrailViolations: a clean patch passes', () => {
  const before = "import fs from 'node:fs';\nexport function read(p) { return fs.readFileSync(p); }\n";
  const after = `${before}export function write(p, d) { return fs.writeFileSync(p, d); }\n`;
  const changes = [{ targetPath: 'src/io.mjs', fileContent: after }, { targetPath: 'src/use.mjs', fileContent: "import { read } from './io.mjs';" }];
  assert.deepEqual(findGuardrailViolations(changes, ctx({ existing: { 'src/io.mjs': before } })), []);
});

test('findGuardrailViolations reports every rule with its id, and a patched file resolves imports', () => {
  const changes = [
    { targetPath: 'src/a.mjs', fileContent: "const x = require('x');\nexport function f(a, b) {}\n" },
    { targetPath: 'src/b.mjs', fileContent: "import { f } from './a.mjs';\nimport y from 'left-pad';\n" },
  ];
  const violations = findGuardrailViolations(changes, ctx({ existing: { 'src/a.mjs': 'export function f(a) {}\n' }, dependencies: null }));
  assert.deepEqual(violations.map((v) => [v.targetPath, v.rule]), [
    ['src/a.mjs', RULES.MODULE_SYSTEM],
    ['src/a.mjs', RULES.EXPORTED_SIGNATURE],
    ['src/a.mjs', RULES.UNRESOLVED_IMPORT],
    ['src/b.mjs', RULES.UNRESOLVED_IMPORT],
  ]);
  assert.match(violations[3].reason, /left-pad/);
});

test('findGuardrailViolations runs the ADR-0029 write guard first and skips static rules for its rejections', () => {
  const changes = [
    { targetPath: 'src/hidden.mjs', fileContent: "const x = require('x');" },
    { targetPath: 'src/unshown.mjs', fileContent: "const x = require('x');" },
  ];
  const violations = findGuardrailViolations(changes, ctx({
    existing: { 'src/hidden.mjs': 'a', 'src/unshown.mjs': 'b' },
    shown: ['src/other.mjs'],
    hidden: ['src/hidden.mjs'],
  }));
  assert.deepEqual(violations.map((v) => v.rule), ['withheld_file', 'unshown_file']);
});

test('findGuardrailViolations defaults: no manifest, nothing on disk, no mention text', () => {
  const violations = findGuardrailViolations([{ targetPath: 'a.mjs', fileContent: "import x from './x.mjs';" }], {
    existing: new Map(),
    shownPaths: new Set(),
    hiddenPaths: new Set(),
  });
  assert.deepEqual(violations.map((v) => v.rule), [RULES.UNRESOLVED_IMPORT]);
});

test('guardrailErrorFor builds one GuardrailError with every reason and the distinct rules', () => {
  const err = guardrailErrorFor([
    { targetPath: 'a.mjs', rule: RULES.MODULE_SYSTEM, reason: 'r1' },
    { targetPath: 'a.mjs', rule: RULES.MODULE_SYSTEM, reason: 'r2' },
    { targetPath: 'b.mjs', rule: RULES.UNRESOLVED_IMPORT, reason: 'r3' },
  ]);
  assert.ok(err instanceof GuardrailError);
  assert.equal(err.message, '`a.mjs`: r1; `a.mjs`: r2; `b.mjs`: r3');
  assert.deepEqual(err.rules, [RULES.MODULE_SYSTEM, RULES.UNRESOLVED_IMPORT]);
});

test('guardrailRules classifies output_writer rejections that carry no rules', () => {
  assert.deepEqual(guardrailRules(guardrailErrorFor([{ targetPath: 'a', rule: 'mass_deletion', reason: 'x' }])), ['mass_deletion']);
  assert.deepEqual(guardrailRules(new GuardrailError('target_path "README.md" is in a protected path (readme.md)')), ['protected_path']);
  assert.deepEqual(guardrailRules(new GuardrailError('target_path "a" would shrink from 40 to 2 lines')), ['destructive_shrink']);
  assert.deepEqual(guardrailRules(new GuardrailError('target_path "a" is a symlink')), ['unsafe_path']);
  assert.deepEqual(guardrailRules(Object.assign(new GuardrailError('x'), { rules: [] })), ['unsafe_path']);
  assert.deepEqual(guardrailRules(undefined), ['unsafe_path']);
});
