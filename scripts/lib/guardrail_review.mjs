// Deterministic review findings from the AGENTS.md Hard Guardrails (RV-03, ADR-0060). The reviewer used to approve
// diffs that break a rule the pipeline enforces in code for generated patches (ADR-0019, ADR-0029): a test case
// removed (PR #276), a changed signature, a module format switched, an import that does not resolve. Pure and
// deterministic: no LLM, no execution. The PR tree is untrusted text and is only parsed (static_verifier.mjs).

import path from 'node:path';
import { parseFindings, pathMatches } from './review_findings.mjs';
import { isTestFile, normalizeRepoPath } from './autofix_guard.mjs';
import {
  RULES, isJsFile, maskSource, extractExportedSignatures, findModuleSystemViolation, findSignatureViolations, findUnresolvedImports, mentions,
} from './static_verifier.mjs';

export const GUARDRAIL_RULES = Object.freeze({ ...RULES, TEST_COUNT_DROP: 'test_count_drop' });
export const MAX_FILES = 40;
export const MAX_FINDINGS = 12;
export const MIN_TITLE_CHARS = 8;
const MAX_TEXT_CHARS = 160;

// A test case opens a statement (the title alternatives are disjoint: a backslash is only ever consumed by `\\.`, so an unclosed title is linear): `re.test(x)` inside an assertion is not one.
const TEST_CASE_LINE = /^\s*(?:(?:await|void)\s+)?(?:test|it)(?:\.[A-Za-z]+)*\s*\(\s*(?:(['"`])((?:\\.|(?!\1)[^\\])*)\1)?/;
const SEVERITY = { module_system: 'High', unresolved_import: 'High', test_count_drop: 'High', exported_signature: 'Medium' };
const plain = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (text) => plain(text).slice(0, MAX_TEXT_CHARS);

/** The files a diff touches: before/after paths, status and the test-case lines it adds and removes. */
export function parseDiffChanges(rawDiff) {
  const files = [];
  for (const part of String(rawDiff ?? '').split(/^(?=diff --git )/m)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    if (!head) continue;
    const file = { before: head[1], after: head[2], isNew: false, isDeleted: false, added: [], removed: [] };
    let inHunk = false;
    for (const line of part.split('\n').slice(1)) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) {
        if (line.startsWith('new file mode')) file.isNew = true;
        else if (line.startsWith('deleted file mode')) file.isDeleted = true;
        else if (line.startsWith('rename from ')) file.before = line.slice('rename from '.length);
        else if (line.startsWith('rename to ')) file.after = line.slice('rename to '.length);
        continue;
      }
      if (line.startsWith('+')) file.added.push(line.slice(1));
      else if (line.startsWith('-')) file.removed.push(line.slice(1));
    }
    files.push(file);
  }
  return files;
}

const caseTitles = (lines) => lines.map((l) => TEST_CASE_LINE.exec(l)).filter(Boolean).map((m) => m[2] ?? '(dynamic title)');

// Test cases of a whole source file, two ways. Masked: comments are gone and each string is a placeholder, so a `test(`
// inside a template literal (a fixture) or a block comment is not a case, but the lexer is heuristic (a regex literal
// holding a quote or a backtick can hide the code after it). Raw: every statement-start call, fixtures and comments
// included, but no lexer to fool. A title that is not a plain string (template, variable) is "(dynamic title)".
const CASE_CALL = /(?:^|[;\n{}])[ \t]*(?:(?:await|void)[ \t]+)?(?:test|it)(?:\.[A-Za-z]+)*\s*\(\s*(?:"S(\d+)")?/g;
const RAW_CASE_CALL = /^[ \t]*(?:(?:await|void)[ \t]+)?(?:test|it)(?:\.[A-Za-z]+)*\s*\(\s*(?:(['"`])((?:\\.|(?!\1)[^\\\n])*)\1)?/gm;
const maskedCases = (source) => {
  const { code, strings } = maskSource(source);
  return [...code.matchAll(CASE_CALL)].map((m) => (m[1] === undefined ? '(dynamic title)' : strings[Number(m[1])]));
};
// A template title is dynamic on both readings (the masked code keeps no template text).
const rawCases = (source) => [...String(source ?? '').matchAll(RAW_CASE_CALL)].map((m) => (m[1] === '`' || m[2] === undefined ? '(dynamic title)' : m[2]));
// What `a` has that `b` does not, as multisets.
const without = (a, b) => {
  const left = [...b];
  return a.filter((t) => {
    const at = left.indexOf(t);
    if (at >= 0) left.splice(at, 1);
    return at < 0;
  });
};

// What a file lost and gained. A case counts as lost only when both readings agree it is gone: a lexer fooled into hiding
// code cannot make a kept case look removed, and a fixture can only make a removal go unseen, which is the safe side for
// a rule that blocks approval. A gain counts when either reading sees it.
const casesChange = (before, after) => {
  const [maskedWas, maskedIs, rawWas, rawIs] = [maskedCases(before), maskedCases(after), rawCases(before), rawCases(after)];
  const lostMasked = without(maskedWas, maskedIs);
  const lostRaw = without(rawWas, rawIs);
  const removed = lostMasked.filter((t) => {
    const at = lostRaw.indexOf(t);
    if (at >= 0) lostRaw.splice(at, 1);
    return at >= 0;
  });
  const gainedMasked = without(maskedIs, maskedWas);
  return { removed, added: [...gainedMasked, ...without(without(rawIs, rawWas), gainedMasked)] };
};

const isWaived = (title, mentionText) => {
  const t = plain(title).toLowerCase();
  return t.length >= MIN_TITLE_CHARS && plain(mentionText).toLowerCase().includes(t);
};

/**
 * Rule: a test file keeps its test cases. With `readBase(path)` / `readHead(path)` the cases are read from the whole
 * files on masked code (a fixture or a comment is not a case); a file that cannot be read is skipped, never guessed.
 * Without readers (the `review` eval suite has no tree) they come from the case lines the diff adds and removes,
 * which cannot tell code from a fixture. A case moved to another file of the diff, or renamed in place, is not a
 * loss; one whose title the PR text names is intended ("explicitly requested"). Deleted files are out of scope (the
 * tests of a removed module go with it).
 * @returns {{ rule: string, path: string, severity: string, reason: string }[]}
 */
export function findTestCountDrops(rawDiff, { mentionText = '', readBase = null, readHead = null } = {}) {
  const files = parseDiffChanges(rawDiff).filter((f) => !f.isDeleted && isTestFile(f.after) && isJsFile(f.after));
  // Every added case pays for at most one removed case: the same title in the same file first (a case kept), then in
  // another file of the diff (a move); what is left of a file's additions replaces what is left of its removals.
  const state = [];
  const withReaders = Boolean(readBase && readHead);
  files.forEach((f, i) => {
    // A file we do not read (over the cap, unreadable, missing) can still be the destination of a moved case: its
    // added case lines stand in as replacements and it reports nothing, so a move into it is never a loss.
    const unscanned = { file: f, removed: [], added: caseTitles(f.added) };
    if (!withReaders) {
      state.push({ file: f, removed: caseTitles(f.removed), added: caseTitles(f.added) });
      return;
    }
    if (i >= MAX_FILES) {
      state.push(unscanned);
      return;
    }
    try {
      const after = readHead(normalizeRepoPath(f.after));
      const before = f.isNew ? '' : readBase(normalizeRepoPath(f.before));
      state.push(after == null || before == null ? unscanned : { file: f, ...casesChange(before, after) });
    } catch {
      state.push(unscanned);
    }
  });
  const take = (list, title) => {
    const at = list.indexOf(title);
    if (at >= 0) list.splice(at, 1);
    return at >= 0;
  };
  for (const s of state) for (const t of [...s.removed]) if (take(s.added, t)) take(s.removed, t);
  for (const s of state) {
    for (const t of [...s.removed]) {
      const target = state.find((o) => o !== s && o.added.includes(t));
      if (target) { take(target.added, t); take(s.removed, t); }
    }
  }
  const findings = [];
  for (const { file: f, removed, added } of state) {
    const lost = removed.filter((t) => !isWaived(t, mentionText));
    const drop = lost.length - added.length;
    if (drop <= 0) continue;
    const shown = lost.slice(0, 3).map((t) => `"${clip(t)}"`).join(', ');
    findings.push({
      rule: GUARDRAIL_RULES.TEST_COUNT_DROP,
      path: normalizeRepoPath(f.after),
      severity: SEVERITY.test_count_drop,
      reason: `${drop} test case${drop === 1 ? '' : 's'} removed without a replacement (${shown}${lost.length > 3 ? ', …' : ''})`,
    });
  }
  return findings;
}

/** Whether the title or body of the PR names an exported function: an explicit request to change or remove it. */
const withMentionedRemovals = (reasons, before, after, mentionText) => {
  const next = extractExportedSignatures(after);
  const waived = [...extractExportedSignatures(before).keys()].filter((n) => !next.has(n) && n !== 'default' && mentions(mentionText, n));
  return reasons.filter((r) => !waived.some((n) => r.startsWith(`removes exported function ${n}(`)));
};

const countRaw = (text, re) => (String(text ?? '').match(re) || []).length;
const REQUIRE_RAW = /(?<![.\w$])require\s*\(/g;
const ESM_RAW = /^[ \t]*(?:import[\s{*"']|export\s)/gm;
const identifier = (name) => String(name).replace(/\$/g, '\\$');

/**
 * Whether the module may still export `name` through a re-export or an export list: `export * from`, `export * as ns`,
 * or an `export { ... name ... }` block (with or without `from`, on one line or several). Read on the masked code, so
 * a fixture or a comment is not an export. One pass: the closing brace is searched forward only, and a block that ends
 * where the previous one ended is not read twice, so hostile text cannot make it quadratic.
 */
export const mayStillExport = (source, name) => {
  const { code } = maskSource(source);
  const word = new RegExp(`(?<![\\w$])${identifier(name)}(?![\\w$])`);
  const opener = /\s*(\*|(?:type\s+)?\{)/y;
  let close = -1;
  let lastRead = -1;
  for (const m of code.matchAll(/(?<![\w$.])export(?![\w$])/g)) {
    opener.lastIndex = m.index + 6;
    const found = opener.exec(code);
    if (!found) continue;
    if (found[1] === '*') return true;
    const open = opener.lastIndex;
    if (close < open) close = code.indexOf('}', open) < 0 ? code.length : code.indexOf('}', open);
    if (close === lastRead) continue;
    lastRead = close;
    if (word.test(code.slice(open, close))) return true;
  }
  return false;
};

// A change of arity, parameters or sync/async is kept only when both parameter lists were read without doubt. The
// parameter parser cannot tell a regex literal from a division (`pattern = /\)/` ends the list early) nor a comparison
// from a TypeScript generic (`enabled = 1 < 0` opens a list that never closes): a masked list that still holds `/`, `<`
// or a `>` that is not the arrow `=>` is ambiguous, and the finding is withheld.
export const AMBIGUOUS_PARAMETER_TEXT = /\/|<|(?<!=)>/;
const parametersReadWithoutDoubt = (reason, before, after) => {
  const name = /exported ([\w$]+)\(/.exec(reason)?.[1];
  if (!name) return true;
  return [before, after].every((source) => {
    const sig = extractExportedSignatures(source).get(name);
    return !sig || !AMBIGUOUS_PARAMETER_TEXT.test(String(sig.raw ?? ''));
  });
};

/**
 * The lexer behind these rules is heuristic, so a reason is kept only when the raw text agrees with it: a regex literal
 * that hides code in one version of the file must not turn into a blocking finding.
 */
export const confirmedOnRawText = (rule, reason, before, after) => {
  if (rule === GUARDRAIL_RULES.MODULE_SYSTEM) {
    return /require\(\)/.test(reason) ? countRaw(after, REQUIRE_RAW) > countRaw(before, REQUIRE_RAW) : countRaw(after, ESM_RAW) > countRaw(before, ESM_RAW);
  }
  if (rule === GUARDRAIL_RULES.EXPORTED_SIGNATURE) {
    const removed = /^removes exported function ([\w$]+)\(/.exec(reason)?.[1];
    if (!removed) return parametersReadWithoutDoubt(reason, before, after);
    return !new RegExp(`\\bexport\\b[^\\n;]*(?<![\\w$])${identifier(removed)}(?![\\w$])`).test(after) && !mayStillExport(after, removed);
  }
  if (rule === GUARDRAIL_RULES.UNRESOLVED_IMPORT) {
    const named = /^imports (?:package )?"([^"]+)"/.exec(reason)?.[1];
    if (!named) return true;
    // The specifier must be written in the head (a lexer slip can invent one) and absent from the base text.
    return String(after).includes(named) && (before === null || !String(before).includes(named));
  }
  return true;
};

const TS_SOURCE = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };

/**
 * Rules of static_verifier.mjs applied to the files a PR changes: module format, exported signatures, imports.
 * `readBase(path)` / `readHead(path)` return the content or null (missing); one that throws skips that file.
 * `manifestFor(path)` returns the declared packages (Set) of the nearest package.json, or null: with no manifest
 * a bare package import is not judged. `fileExists` is the PR tree after the change.
 */
export function findFileRuleViolations(rawDiff, { readBase, readHead, manifestFor = () => null, fileExists, mentionText = '' }) {
  const exists = (p) => fileExists(p) || Object.entries(TS_SOURCE).some(([ext, alts]) => p.endsWith(ext) && alts.some((a) => fileExists(p.slice(0, -ext.length) + a)));
  const findings = [];
  const candidates = parseDiffChanges(rawDiff).filter((f) => !f.isDeleted && isJsFile(f.after));
  for (const f of candidates.slice(0, MAX_FILES)) {
    const key = normalizeRepoPath(f.after);
    let before = null;
    let after = null;
    try {
      after = readHead(key);
      before = f.isNew ? null : readBase(normalizeRepoPath(f.before));
    } catch {
      continue;
    }
    if (after == null) continue;
    const add = (rule, reason) => {
      if (confirmedOnRawText(rule, reason, before, after)) findings.push({ rule, path: key, severity: SEVERITY[rule], reason });
    };
    const moduleReason = findModuleSystemViolation(key, before, after);
    if (moduleReason) add(GUARDRAIL_RULES.MODULE_SYSTEM, moduleReason);
    if (before !== null) {
      for (const reason of withMentionedRemovals(findSignatureViolations(key, before, after, mentionText), before, after, mentionText)) add(GUARDRAIL_RULES.EXPORTED_SIGNATURE, reason);
    }
    const manifest = manifestFor(key);
    for (const reason of findUnresolvedImports(key, before, after, { dependencies: manifest ?? new Set(), fileExists: exists })) {
      if (manifest === null && /not declared in package\.json/.test(reason)) continue;
      add(GUARDRAIL_RULES.UNRESOLVED_IMPORT, reason);
    }
  }
  return findings;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * The packages declared by the nearest package.json above `filePath` (the file's own directory first), or null when
 * there is none or it is unreadable: the caller then judges no bare package import. `readFile` returns the text or
 * null for a missing file and may throw.
 */
export function declaredPackages(filePath, readFile) {
  let dir = path.posix.dirname(normalizeRepoPath(filePath));
  for (;;) {
    let text = null;
    try {
      text = readFile(dir === '.' ? 'package.json' : `${dir}/package.json`);
    } catch {
      return null;
    }
    if (text != null) {
      try {
        const pkg = JSON.parse(text);
        return new Set(DEPENDENCY_FIELDS.flatMap((field) => (pkg?.[field] && typeof pkg[field] === 'object' ? Object.keys(pkg[field]) : [])));
      } catch {
        return null;
      }
    }
    if (dir === '.') return null;
    dir = path.posix.dirname(dir);
  }
}

/** Findings sorted by file then rule, capped; `omitted` counts the ones left out. */
export function collectGuardrailFindings(parts) {
  const all = parts.flat().sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
  return { findings: all.slice(0, MAX_FINDINGS), omitted: Math.max(0, all.length - MAX_FINDINGS) };
}

const FIX_HINT = {
  test_count_drop: 'Restore the case, or name it in the PR description if removing it is the request.',
  exported_signature: 'Keep the contract, or name the function in the PR description if changing it is the request.',
  module_system: 'Keep the file’s module format.',
  unresolved_import: 'Add the file or the dependency, or drop the import.',
};

const bullet = (f) => `- [${f.severity}] Guardrail ${f.rule} — File: \`${plain(f.path)}\` Root cause: ${f.reason}. Fix: ${FIX_HINT[f.rule] ?? 'resolve it in this change.'}`;

// What a model finding says when it reports the defect a rule finds (a finding on the same file about something else is not it).
const SAME_DEFECT = {
  test_count_drop: /\b(?:test|tests|case|cases|spec)\b|remov|delet|drop|fewer|lost/i,
  exported_signature: /signature|arity|param|argument|export|remov|breaking|caller|contract/i,
  module_system: /require|import|esm|commonjs|module|\.mjs|\.cjs/i,
  unresolved_import: /import|resolve|depend|package|module|manifest/i,
};

/** Whether a High or Medium finding of the model, on the file, talks about the defect this guardrail finding reports. */
const alreadyReported = (modelFindings, f) => modelFindings.some((m) => {
  if (m.severity !== 'high' && m.severity !== 'medium') return false;
  if (!m.files.some((file) => pathMatches(file, f.path))) return false;
  const prose = m.files.reduce((text, file) => text.split(file).join(' '), m.text); // a path named `x.test.mjs` is not a word about tests
  return (SAME_DEFECT[f.rule] ?? /./).test(prose);
});

/**
 * The review text the `review` eval suite scores: the model's review plus the guardrail findings as an Issues Found
 * section, the form the finding parser and the scorers read (the comment of pr_review.mjs carries its own section).
 * A finding the model already reports (a blocking one on the same file about the same kind of defect) is not listed
 * again: the same defect twice would count as a false positive. An unrelated finding on that file hides nothing.
 */
export function withGuardrailIssues(review, { findings = [] } = {}) {
  const modelFindings = parseFindings(review);
  const extra = findings.filter((f) => !alreadyReported(modelFindings, f));
  return extra.length === 0 ? review : `${review}\n\n### ⚠️ Issues Found (guardrails)\n${extra.map(bullet).join('\n')}\n`;
}

/** The comment section; the same lines feed the review text the auto-fixer reads. Empty when there is no finding. */
export function formatGuardrailSection({ findings = [], omitted = 0 } = {}, { overridden = false } = {}) {
  if (findings.length === 0) return '';
  const lines = ['', '### 🛡️ Guardrail Findings', '_AGENTS.md Hard Guardrails checked in code against this diff (no LLM). Each one blocks approval; a rule that does not apply is waived by naming the test or function in the PR description._', ''];
  lines.push(...findings.map(bullet));
  if (omitted > 0) lines.push(`- … ${omitted} more not shown.`);
  if (overridden) lines.push('', '> **Verdict overridden to REQUEST_CHANGES** — guardrail findings above.');
  return lines.join('\n');
}

/** Failure-signature entries for the circuit breaker (ADR-0050): the same guardrail failure on the same file repeats. */
export const guardrailSignature = (findings) => findings.map((f) => `guardrail:${f.rule}:${f.path}`);
