import path from 'node:path';
import { isBuiltin } from 'node:module';
import { findUnsafeChanges, normalizeRepoPath } from './autofix_guard.mjs';
import { GuardrailError } from './output_writer.mjs';

// Static verification of a validated patch before anything is written (ADR-0019). It enforces in
// code the AGENTS.md "Hard Guardrails" that ADR-0009 left to the prompts — module format, exported
// signatures, resolvable imports — and runs the ADR-0029 write guard, for code generation and
// auto-fix alike. Pure: callers pass the on-disk state (existing contents, manifest, fileExists).

export const RULES = Object.freeze({
  MODULE_SYSTEM: 'module_system',
  EXPORTED_SIGNATURE: 'exported_signature',
  UNRESOLVED_IMPORT: 'unresolved_import',
});

const JS_FILE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const ESM_ONLY_PATTERN = /\.m[jt]s$/i;
const CJS_ONLY_PATTERN = /\.c[jt]s$/i;
const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.json', '.ts', '.mts', '.cts', '.tsx', '.jsx'];


export function isJsFile(p) {
  return JS_FILE_PATTERN.test(String(p ?? ''));
}

// Index just past the quoted string opening at `start`, or -1 when it is unterminated on its line.
function stringEnd(src, start) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') i += 1;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === '\n') return -1;
  }
  return -1;
}

// A template literal opening at `start`: index just past it, and its `${…}` expressions, which
// may themselves hold strings, braces and nested template literals.
function readTemplate(src, start) {
  const exprs = [];
  let i = start + 1;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') {
      i += 2;
    } else if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 0;
      let j = i + 2;
      for (; j < src.length; j += 1) {
        const c = src[j];
        if (c === '`') j = readTemplate(src, j).end - 1;
        else if (c === '"' || c === "'") j = (stringEnd(src, j) === -1 ? j + 1 : stringEnd(src, j)) - 1;
        else if (c === '{') depth += 1;
        else if (c === '}' && depth-- === 0) break;
      }
      exprs.push(src.slice(i + 2, j));
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return { end: Math.min(i + 1, src.length), exprs };
}

function mask(src, strings) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const eol = src.indexOf('\n', i);
      i = eol === -1 ? src.length : eol;
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      const end = stringEnd(src, i);
      if (end === -1) {
        out += c;
        i += 1;
      } else {
        strings.push(src.slice(i + 1, end - 1));
        out += `"S${strings.length - 1}"`;
        i = end;
      }
    } else if (c === '`') {
      // The literal text is never a specifier, but the code in its `${…}` is.
      const { end, exprs } = readTemplate(src, i);
      out += `\`\`${exprs.map((e) => `;${mask(e, strings)};`).join('')}`;
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Removes comments and replaces each quoted string with `"S<n>"`, so the regexes below only see
 * code. A template literal keeps only its `${…}` expressions (nesting included), masked the same
 * way. Heuristic lexer: a regex literal containing a quote or `//` can mask the rest of its line.
 */
export function maskSource(source) {
  const strings = [];
  const code = mask(String(source ?? ''), strings);
  return { code, strings };
}

const STR = String.raw`"S(\d+)"`;
const STATIC_IMPORT = new RegExp(String.raw`(?:^|[;\n}])\s*(?:import|export)\b(?:[\w$*{}\s,]*?\bfrom)?\s*${STR}`, 'g');
const DYNAMIC_IMPORT = new RegExp(String.raw`\bimport\s*\(\s*${STR}\s*\)`, 'g');
const REQUIRE_LITERAL = new RegExp(String.raw`(?<![.\w$])require\s*\(\s*${STR}\s*\)`, 'g');
const REQUIRE_CALL = /(?<![.\w$])require\s*\(/g;
const ESM_SYNTAX = /(?:^|[;\n{}])\s*(?:import\s*(?:[\w$*{]|"S)|export\s*(?:default\b|const\b|let\b|var\b|function\b|async\b|class\b|\{|\*))/g;
const CJS_SYNTAX = /(?<![.\w$])(?:require\s*\(|module\.exports\b|exports\.[\w$]+\s*=)/;

/** Every import / export-from / dynamic import / require specifier written as a string literal. */
export function extractImportSpecifiers(source) {
  const { code, strings } = maskSource(source);
  const specs = new Set();
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT, REQUIRE_LITERAL]) {
    for (const m of code.matchAll(re)) specs.add(strings[Number(m[1])]);
  }
  return [...specs];
}

function countMatches(code, re) {
  return (code.match(re) || []).length;
}

/** Rule 1: `.mjs` stays require-free, a CommonJS file is never converted to ESM. */
export function findModuleSystemViolation(targetPath, before, after) {
  if (!isJsFile(targetPath)) return null;
  const next = maskSource(after).code;
  const prev = before === null ? '' : maskSource(before).code;
  const addsRequire = countMatches(next, REQUIRE_CALL) > countMatches(prev, REQUIRE_CALL);
  const addsEsm = countMatches(next, ESM_SYNTAX) > countMatches(prev, ESM_SYNTAX);

  if (ESM_ONLY_PATTERN.test(targetPath)) {
    return addsRequire ? 'adds require() to an ES module (.mjs is ESM-only)' : null;
  }
  if (before === null) return null; // new .js/.cjs: no previous format to preserve
  if (CJS_ONLY_PATTERN.test(targetPath)) {
    return addsEsm ? 'converts a CommonJS file (.cjs) to ESM import/export' : null;
  }
  const wasEsm = countMatches(prev, ESM_SYNTAX) > 0;
  const wasCjs = !wasEsm && CJS_SYNTAX.test(prev);
  if (wasCjs && addsEsm) return 'converts a CommonJS file to ESM import/export';
  if (wasEsm && addsRequire) return 'adds require() to an ES module';
  return null;
}

// Index of the `)` matching the `(` at `open`, or -1.
function matchingParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// Splits on commas at depth 0 of () [] {} <> (TS generics); `=>` never closes a `<`.
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if ('([{<'.includes(c)) depth += 1;
    else if (')]}'.includes(c) || (c === '>' && text[i - 1] !== '=')) depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// Parameter as compared: its name, or the keys of a destructuring pattern (recursively), without
// default values, renames or type annotations: `{ a: x = 1, b }: Opts` → `{a,b}`.
function normalizeParam(param) {
  let p = param;
  for (const sep of ['=', ':']) p = splitTopLevel(p, sep)[0];
  p = p.trim().replace(/\?$/, '');
  const pattern = /^([{[])([\s\S]*)[}\]]$/.exec(p);
  if (!pattern) return p.replace(/\s+/g, '');
  const inner = splitTopLevel(pattern[2], ',').map(normalizeParam).filter(Boolean).join(',');
  return pattern[1] === '{' ? `{${inner}}` : `[${inner}]`;
}

function parseParams(code, open) {
  const close = matchingParen(code, open);
  if (close === -1) return null;
  return { params: splitTopLevel(code.slice(open + 1, close), ',').map(normalizeParam).filter(Boolean), close };
}

const FN_HEAD = String.raw`(async\s+)?function\b\s*\*?\s*([\w$]*)\s*(?:<[^>()]*>)?\s*\(`;
// `= [async] function (`, `= [async] (` (an arrow only if `=>` follows the `)`), `= [async] x =>`.
const ARROW_HEAD = String.raw`(async\s+)?(?:(function)\b\s*\*?\s*[\w$]*\s*(?:<[^>()]*>)?\s*\(|(?:<[^>()]*>)?\s*\(|([\w$]+)\s*=>)`;
const DECLARATOR = String.raw`(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=\s*`;

// `m` ends at the parameter list's `(` unless the single-parameter group `single` matched.
function signatureAt(code, m, { isAsync, single = null, arrow = false }) {
  if (single) return { params: [single], isAsync: Boolean(isAsync) };
  const parsed = parseParams(code, m.index + m[0].length - 1);
  if (!parsed) return null;
  if (arrow && !/^\s*(?::[^=;{]+)?=>/.test(code.slice(parsed.close + 1))) return null;
  return { params: parsed.params, isAsync: Boolean(isAsync) };
}

// Groups of a DECLARATOR + ARROW_HEAD match, from `offset`: name, async, `function`, single param.
function declaredSignature(code, m, offset) {
  const [name, isAsync, fn, single] = [m[offset], m[offset + 1], m[offset + 2], m[offset + 3]];
  return [name, signatureAt(code, m, { isAsync, single, arrow: !fn && !single })];
}

/**
 * Exported functions and their signatures: `export [async] function`, `export default function`,
 * `export const f = (…) =>` / `function`, `export { a, b as c }`, and CommonJS `exports.f = …` /
 * `module.exports = { a, b }`. Classes and re-exports from other modules are not tracked.
 * @returns {Map<string, { params: string[], isAsync: boolean, local: string }>}
 */
export function extractExportedSignatures(source) {
  const { code } = maskSource(source);
  const locals = new Map();
  const exported = new Map();
  const add = (map, name, sig, local = name) => { if (name && sig) map.set(name, { ...sig, local }); };

  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${FN_HEAD}`, 'g'))) {
    add(locals, m[2], signatureAt(code, m, { isAsync: m[1] }));
  }
  for (const m of code.matchAll(new RegExp(String.raw`\b${DECLARATOR}${ARROW_HEAD}`, 'g'))) {
    add(locals, ...declaredSignature(code, m, 1));
  }

  for (const m of code.matchAll(new RegExp(String.raw`\bexport\s+(default\s+)?${FN_HEAD}`, 'g'))) {
    add(exported, m[1] ? 'default' : m[3], signatureAt(code, m, { isAsync: m[2] }), m[3] || 'default');
  }
  for (const m of code.matchAll(new RegExp(String.raw`\bexport\s+${DECLARATOR}${ARROW_HEAD}`, 'g'))) {
    add(exported, ...declaredSignature(code, m, 1));
  }
  for (const m of code.matchAll(new RegExp(String.raw`(?<![.\w$])(?:module\.)?exports\.([\w$]+)\s*=\s*${ARROW_HEAD}`, 'g'))) {
    add(exported, ...declaredSignature(code, m, 1));
  }

  // `export { local as name }` and `module.exports = { name: local }` point at local functions.
  const lists = [
    ...[...code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from\b)/g)].map((m) => ({ list: m[1], esm: true })),
    ...[...code.matchAll(/\bmodule\.exports\s*=\s*\{([^}]*)\}/g)].map((m) => ({ list: m[1], esm: false })),
  ];
  for (const { list, esm } of lists) {
    for (const entry of list.split(',').map((e) => e.trim()).filter(Boolean)) {
      const [left, right] = entry.split(esm ? /\s+as\s+/ : /\s*:\s*/).map((s) => s.trim());
      const [localName, exportedName] = esm ? [left, right || left] : [right || left, left];
      const sig = locals.get(localName);
      if (sig && /^[\w$]+$/.test(exportedName)) exported.set(exportedName, { ...sig, local: localName });
    }
  }
  return exported;
}

function mentions(text, name) {
  if (!text || !name) return false;
  return new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`).test(text);
}

/**
 * Rule 2: an exported function keeps its name, arity, parameter names and sync/async return,
 * unless `mentionText` (issue title + body, or review feedback) names it explicitly. A mention
 * unlocks a signature change, never the removal of the export. An anonymous default export has
 * no name to mention (the word "default" does not count).
 * @returns {string[]} one reason per changed function
 */
export function findSignatureViolations(targetPath, before, after, mentionText = '') {
  if (before === null || !isJsFile(targetPath)) return [];
  const prev = extractExportedSignatures(before);
  if (prev.size === 0) return [];
  const next = extractExportedSignatures(after);
  const reasons = [];
  for (const [name, old] of prev) {
    const cur = next.get(name);
    const shown = (sig) => `${name}(${sig.params.join(', ')})`;
    if (!cur) {
      reasons.push(`removes exported function ${shown(old)}`);
      continue;
    }
    const names = [name, old.local].filter((n) => n !== 'default');
    if (names.some((n) => mentions(mentionText, n))) continue;
    if (cur.params.length !== old.params.length) {
      reasons.push(`changes the arity of exported ${shown(old)} to ${shown(cur)}`);
    } else if (cur.params.join(',') !== old.params.join(',')) {
      reasons.push(`changes the parameters of exported ${shown(old)} to ${shown(cur)}`);
    } else if (cur.isAsync !== old.isAsync) {
      reasons.push(`makes exported ${shown(old)} ${cur.isAsync ? 'async' : 'synchronous'} (return type changes)`);
    }
  }
  return reasons;
}

/** `react/jsx-runtime` → `react`, `@scope/pkg/sub` → `@scope/pkg`. */
export function packageRoot(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}


function resolvesRelative(targetPath, specifier, fileExists) {
  const base = path.posix.dirname(normalizeRepoPath(targetPath));
  const joined = path.posix.normalize(path.posix.join(base, specifier.replace(/[?#].*$/, '')));
  if (joined === '..' || joined.startsWith('../')) return false;
  const stem = joined.replace(/\/$/, '');
  const candidates = [stem, ...RESOLVE_EXTENSIONS.map((ext) => stem + ext), ...RESOLVE_EXTENSIONS.map((ext) => `${stem}/index${ext}`)];
  return candidates.some((candidate) => fileExists(candidate));
}

/**
 * Rule 3: each import specifier the patch adds resolves to a builtin (`node:x` or a bare builtin
 * name), a relative path that exists after the patch, or a package declared in package.json or
 * already imported by the file. `#` subpath imports and `@/` / `~/` aliases (package.json
 * `imports`, tsconfig `paths`) are not checked.
 * @param {{ dependencies: Set<string>, fileExists: (repoPath: string) => boolean }} ctx
 * @returns {string[]}
 */
export function findUnresolvedImports(targetPath, before, after, { dependencies, fileExists }) {
  if (!isJsFile(targetPath)) return [];
  const previous = new Set(before === null ? [] : extractImportSpecifiers(before));
  const previousRoots = new Set([...previous].map(packageRoot));
  const reasons = [];
  for (const spec of extractImportSpecifiers(after)) {
    if (previous.has(spec)) continue;
    if (spec.startsWith('.')) {
      if (!resolvesRelative(targetPath, spec, fileExists)) reasons.push(`imports "${spec}", which does not resolve to a file after the patch`);
    } else if (spec.startsWith('/')) {
      reasons.push(`imports absolute path "${spec}"`);
    } else if (spec.startsWith('node:')) {
      // isBuiltin, not builtinModules: `node:test` and `node:sqlite` exist only with the prefix.
      if (!isBuiltin(spec)) reasons.push(`imports "${spec}", which is not a Node.js builtin`);
    } else if (/^(?:#|@\/|~\/)/.test(spec) || isBuiltin(spec)) {
      continue;
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      reasons.push(`imports URL "${spec}"`);
    } else {
      const root = packageRoot(spec);
      if (!dependencies.has(root) && !previousRoots.has(root)) {
        reasons.push(`imports package "${root}", which is not declared in package.json`);
      }
    }
  }
  return reasons;
}

/**
 * Every guardrail violation of a validated patch: the ADR-0029 write guard (withheld or unshown
 * file, bulk deletion, test-count drop) then the static rules above. Empty means safe to write.
 *
 * @param {{ targetPath: string, fileContent: string }[]} changes
 * @param {{ existing: Map<string, string|null>, shownPaths: Set<string>, hiddenPaths: Set<string>,
 *   dependencies?: object|null, fileExists?: (repoPath: string) => boolean, mentionText?: string }} context
 *   dependencies: package.json dependency map snapshotted before the LLM call (null: no manifest);
 *   fileExists: whether a normalized repo path exists on disk; mentionText: issue or review text.
 * @returns {{ targetPath: string, rule: string, reason: string }[]}
 */
export function findGuardrailViolations(changes, context) {
  const { existing, dependencies = null, fileExists = () => false, mentionText = '' } = context;
  const violations = findUnsafeChanges(changes, context);
  const rejected = new Set(violations.map((v) => normalizeRepoPath(v.targetPath)));
  const patched = new Set(changes.map((c) => normalizeRepoPath(c.targetPath)));
  const imports = {
    dependencies: new Set(Object.keys(dependencies ?? {})),
    fileExists: (p) => patched.has(p) || fileExists(p),
  };

  for (const { targetPath, fileContent } of changes) {
    const key = normalizeRepoPath(targetPath);
    if (rejected.has(key)) continue;
    const before = existing.get(key) ?? null;
    const moduleReason = findModuleSystemViolation(key, before, fileContent);
    if (moduleReason) violations.push({ targetPath, rule: RULES.MODULE_SYSTEM, reason: moduleReason });
    for (const reason of findSignatureViolations(key, before, fileContent, mentionText)) {
      violations.push({ targetPath, rule: RULES.EXPORTED_SIGNATURE, reason });
    }
    for (const reason of findUnresolvedImports(key, before, fileContent, imports)) {
      violations.push({ targetPath, rule: RULES.UNRESOLVED_IMPORT, reason });
    }
  }
  return violations;
}

/** One GuardrailError listing every violation; `rules` feeds the rejection metric. */
export function guardrailErrorFor(violations) {
  const err = new GuardrailError(violations.map((v) => `\`${v.targetPath}\`: ${v.reason}`).join('; '));
  err.rules = [...new Set(violations.map((v) => v.rule))];
  return err;
}

/** Rules behind a GuardrailError, including the ones `output_writer.mjs` throws without `rules`. */
export function guardrailRules(err) {
  if (Array.isArray(err?.rules) && err.rules.length) return err.rules;
  const message = String(err?.message ?? '');
  if (/protected path/.test(message)) return ['protected_path'];
  if (/would shrink/.test(message)) return ['destructive_shrink'];
  return ['unsafe_path'];
}
