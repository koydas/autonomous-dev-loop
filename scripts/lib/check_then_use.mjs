// Check-then-use on a filesystem path (TOCTOU), read from the hunks of a diff (guardrail rule `check_then_use`,
// issue #341, ADR-0060): a `stat` / `lstat` / `access` / `exists` call on an identifier, then a `readFile` / `open` /
// `writeFile` / `rm` ... call on the SAME identifier, in the same function body. The path can change between the two
// calls (a symlink swapped in, a file replaced), so the check proves nothing about what the second call touches; the
// fix is to open once and ask the handle (`open` → `fh.stat()` → `fh.read`), which this rule does not flag.
//
// Pure and deterministic, no LLM, no parser: the new side of each hunk (added and context lines) is masked with
// `maskSource` (comments and strings do not count), then scanned once for calls and for the braces and arrow bodies that
// delimit a function. A hunk is all the review has (the `review` eval suite has no tree), so the limits are the hunk's:
// no flow between functions or modules, no alias through reassignment, and a function whose opening is outside the hunk
// is read as the hunk's own top level. At least one of the two calls must be on an added line: a pair the PR did not
// touch is not its defect.

import { maskSource, mentions } from './static_verifier.mjs';

const MAX_CHECKS_PER_FILE = 200;
const MAX_FINDINGS_PER_FILE = 3;
const NAME_LOOKBACK = 300;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'with', 'return', 'try', 'else', 'do']);

const QUALIFIER = String.raw`(?<![\w$.])((?:(?:fs|fsp|fsPromises|promises)\.)*)`;
const ARG = String.raw`([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)`;
const CHECK = new RegExp(`${QUALIFIER}(stat|lstat|access|exists)(?:Sync)?\\s*\\(\\s*${ARG}\\s*[,)]`, 'g');
const USE = new RegExp(`${QUALIFIER}(readFile|open|createReadStream|writeFile|appendFile|rm|unlink|rename|copyFile|readdir)(?:Sync)?\\s*\\(\\s*${ARG}\\s*(?:,\\s*${ARG}\\s*)?[,)]`, 'g');
const TWO_PATHS = new Set(['rename', 'copyFile']);
const NEW_STATEMENT = /^\s*(?:const|let|var|function|class|export|import|if|for|while|return|throw|try|switch|do|async\s+function)\b/;

const FUNCTION_NAMES = [
  /function\s*\*?\s*([\w$]+)\s*\([^()]*\)\s*$/,
  /([\w$]+)\s*[:=]\s*(?:async\s*)?(?:function\s*\*?\s*)?\([^()]*\)\s*$/,
  /([\w$]+)\s*[:=]\s*(?:async\s*)?[\w$]+\s*$/,
  /(?:^|[\s;{},])(?:async\s+|static\s+|get\s+|set\s+)*\*?([\w$]+)\s*\([^()]*\)\s*$/,
];

/** The name of the function whose body opens right after `before` (the masked text up to its `{` or its `=>`), or null. */
function functionName(before) {
  const pre = before.slice(-NAME_LOOKBACK).replace(/\s*=>\s*$/, '').replace(/\s+$/, '');
  for (const re of FUNCTION_NAMES) {
    const name = re.exec(pre)?.[1];
    if (name && !KEYWORDS.has(name)) return name;
  }
  return null;
}

/** The function named in a hunk header (`@@ -1,4 +1,6 @@ export function readManifest(dir) {`), the hunk's own top level. */
const headerName = (context) => {
  const text = String(context ?? '');
  return /function\s*\*?\s*([\w$]+)/.exec(text)?.[1] ?? /([\w$]+)\s*[:=]\s*(?:async\s*)?(?:\(|[\w$]+\s*=>)/.exec(text)?.[1] ?? (/^\s*(?:async\s+|static\s+)*([\w$]+)\s*\(/.exec(text)?.[1] ?? null);
};

// A waiver names the function in a paragraph that also owns the risk. Naming it alone is not one: a PR body names the
// function it fixes, and the incident this rule comes from (PR #194) says "`readManifest` now refuses ..." about the
// very check that is the defect.
const ACKNOWLEDGES = /\b(?:toctou|race|races|check[- ]then[- ]use|time[- ]of[- ]check|intentional|intentionally|on purpose|accepted)\b/i;
const isWaived = (text, name) => String(text ?? '').split(/\n\s*\n/).some((paragraph) => ACKNOWLEDGES.test(paragraph) && mentions(paragraph, name));

const normal = (ident) => ident.replace(/\?\./g, '.');

// Every check and use call of the masked code of a hunk, with the scope it stands in. A scope is a brace body or an
// arrow expression body; the root is the hunk itself. `chain` lists the scope ids from the root to the call.
function scan(code, rootName) {
  const calls = [];
  const byIndex = new Map();
  for (const [kind, re] of [['check', CHECK], ['use', USE]]) {
    for (const m of code.matchAll(re)) {
      const idents = [normal(m[3])];
      if (kind === 'use' && TWO_PATHS.has(m[2]) && m[4]) idents.push(normal(m[4]));
      const call = { kind, fn: m[2], idents, index: m.index + m[1].length, chain: [] };
      calls.push(call);
      byIndex.set(call.index, call);
    }
  }
  let nextId = 0;
  let stack = [{ id: nextId, kind: 'root', name: rootName }];
  const chainNow = () => stack.filter((f) => f.kind === 'root' || f.kind === 'brace' || f.kind === 'arrow').map((f) => ({ id: f.id, name: f.name }));
  const popTo = (kinds) => {
    while (stack.length > 1 && !kinds.includes(stack[stack.length - 1].kind)) stack.pop();
    return stack.length > 1 ? stack.pop() : null;
  };
  const closeArrows = () => {
    while (stack.length > 1 && stack[stack.length - 1].kind === 'arrow') stack.pop();
  };
  for (let i = 0; i < code.length; i += 1) {
    const here = byIndex.get(i);
    if (here) here.chain = chainNow();
    const c = code[i];
    if (c === '=' && code[i + 1] === '>') {
      let j = i + 2;
      while (j < code.length && /\s/.test(code[j])) j += 1;
      if (code[j] !== '{') stack.push({ id: (nextId += 1), kind: 'arrow', name: functionName(code.slice(0, i)) });
      i += 1;
    } else if (c === '{') {
      stack.push({ id: (nextId += 1), kind: 'brace', name: functionName(code.slice(0, i)) });
    } else if (c === '(' || c === '[') {
      stack.push({ id: (nextId += 1), kind: c === '(' ? 'paren' : 'bracket' });
    } else if (c === '}') {
      // A `}` with no `{` in the hunk closes the function the hunk started in: what follows is another scope.
      if (!popTo(['brace'])) stack = [{ id: (nextId += 1), kind: 'root', name: null }];
    } else if (c === ')' || c === ']') {
      popTo([c === ')' ? 'paren' : 'bracket']);
    } else if (c === ';' || c === ',') {
      if (stack[stack.length - 1].kind === 'arrow') closeArrows();
    } else if (c === '\n' && stack[stack.length - 1].kind === 'arrow' && NEW_STATEMENT.test(code.slice(i + 1, i + 40))) {
      closeArrows();
    }
  }
  return calls.filter((c) => c.chain.length > 0).sort((a, b) => a.index - b.index);
}

/**
 * The check-then-use pairs of one file's hunks. `mentionText` waives a pair when a paragraph of it names a function the pair stands in and owns the risk (toctou, race, intentional ...).
 * @param {{ lines: { text: string, added: boolean, no: number | null }[], context?: string }[]} hunks as parseDiffChanges reads them
 * @returns {{ check: { fn: string, ident: string, line: number | null }, use: { fn: string, ident: string, line: number | null }, scope: string | null }[]}
 */
export function findCheckThenUse(hunks, { mentionText = '' } = {}) {
  const found = [];
  let checks = 0;
  for (const hunk of hunks ?? []) {
    const lines = hunk.lines ?? [];
    if (lines.length === 0) continue;
    const { code } = maskSource(lines.map((l) => l.text).join('\n'), { keepLines: true });
    const breaks = [];
    for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) breaks.push(i);
    const lineAt = (index) => {
      let lo = 0;
      let hi = breaks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (breaks[mid] < index) lo = mid + 1;
        else hi = mid;
      }
      return lines[Math.min(lo, lines.length - 1)];
    };
    const calls = scan(code, headerName(hunk.context));
    const uses = calls.filter((c) => c.kind === 'use');
    for (const check of calls.filter((c) => c.kind === 'check')) {
      if (checks >= MAX_CHECKS_PER_FILE) return found;
      checks += 1;
      const scope = check.chain[check.chain.length - 1];
      const use = uses.find((u) => u.index > check.index && u.idents.includes(check.idents[0]) && u.chain.some((s) => s.id === scope.id));
      if (!use) continue;
      const first = lineAt(check.index);
      const second = lineAt(use.index);
      if (!first.added && !second.added) continue;
      const ident = check.idents[0];
      const reassigned = new RegExp(`(?<![\\w$.])${ident.replace(/[$.]/g, '\\$&')}\\s*=(?![=>])`).test(code.slice(check.index, use.index));
      if (reassigned) continue;
      const names = [...new Set([...check.chain, ...use.chain].map((s) => s.name).filter(Boolean))];
      if (names.some((n) => isWaived(mentionText, n))) continue;
      found.push({
        check: { fn: check.fn, ident, line: first.no },
        use: { fn: use.fn, ident, line: second.no },
        scope: names.length > 0 ? names[names.length - 1] : null,
      });
      if (found.length >= MAX_FINDINGS_PER_FILE) return found;
    }
  }
  return found;
}
