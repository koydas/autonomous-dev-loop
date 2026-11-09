// The test cases of a node:test file, as the two test-count guards read them (issue #339): the auto-fix / generation
// write guard (autofix_guard.mjs, ADR-0029) and the review guardrail check (guardrail_review.mjs, ADR-0060).
//
// A case is *inactive* when its call is `.skip(` / `.todo(` or its options object has a truthy `skip` / `todo` key
// (`true`, a non-empty string, any expression that is not a falsy literal); `test.only` is active. Both guards compare
// active cases: a case that goes from active to inactive is a removal, a case already inactive before is not counted
// either side (deleting it is still a removal, as it always was). A kept case also keeps its assertions: the number of
// `assert(` / `assert.<name>(` / `t.assert.<name>(` calls in its body, read on masked code (comments and string
// contents do not count). Deterministic, regex and masking only: no LLM, no execution.
//
// Import cycle: static_verifier.mjs → autofix_guard.mjs → this module → static_verifier.mjs. It is safe because no
// module of the cycle calls across it at load time (only function declarations cross it, and they are hoisted).

import { maskSource } from './static_verifier.mjs';

export const CASE_STATES = Object.freeze({ ACTIVE: 'active', SKIPPED: 'skipped', TODO: 'todo' });
export const DYNAMIC_TITLE = '(dynamic title)';
export const MIN_TITLE_CHARS = 8;

// Masked reading: a statement-start call (comments gone, strings are `"S<n>"`). 1: modifiers, 2: title string index.
const CASE_CALL = /(?:^|[;\n{}])[ \t]*(?:(?:await|void)[ \t]+)?(?:test|it)((?:\.[A-Za-z]+)*)\s*\(\s*(?:"S(\d+)")?/g;
// Raw reading: a line-start call on the unmasked text (block comments before the title, on its line). 1: modifiers, 2: quote, 3: title.
const RAW_CASE_CALL = /^[ \t]*(?:(?:await|void)[ \t]+)?(?:test|it)((?:\.[A-Za-z]+)*)\s*\(\s*(?:\/\*(?:[^*\n]|\*(?!\/))*\*\/\s*)*(?:(['"`])((?:\\.|(?!\2)[^\\\n])*)\2)?/gm;
// One line of a diff (the title alternatives are disjoint: a backslash is only ever consumed by `\\.`, so an unclosed
// title is linear): `re.test(x)` inside an assertion does not open a statement, so it is not a case.
const CASE_LINE = /^\s*(?:(?:await|void)\s+)?(?:test|it)((?:\.[A-Za-z]+)*)\s*\(\s*(?:\/\*(?:[^*]|\*(?!\/))*\*\/\s*)*(?:(['"`])((?:\\.|(?!\2)[^\\])*)\2)?/;
// The options object opens right after the title (or first); comments around it are skipped (raw text, diff lines).
// An options object longer than this is read up to the cap: the properties seen so far still count.
export const MAX_OPTIONS_CHARS = 2000;
const OPTION_ENTRY = /^\s*(?:(skip|todo)|"S(\d+)"|(['"])(skip|todo)\3)\s*(?::([\s\S]*))?$/;
// A masked template is `` whatever its text, so it is never read as falsy.
const FALSY_LITERAL = /^(?:false|0|-0|0n|null|undefined|NaN|""|'')$/;
const ASSERTION = /(?<![\w$.])(?:t\.)?assert(?:\.[A-Za-z_$][\w$]*)*\s*\(/g;
// A `/` left in masked code is a regex literal or a division: the lexer and the parenthesis matcher cannot tell, and a
// regex such as `/\)/` would end the case early. A body holding one is not read (its assertions are null).
const AMBIGUOUS_BODY = /\//;

const plain = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim();
/** A case title as a reason may quote it: untrusted text, flattened to one line and clipped. */
export const clipTitle = (title) => plain(title).slice(0, 160);

/** Whether the PR / issue text names the case: an explicit request to remove or change it (≥ MIN_TITLE_CHARS). */
export function isWaived(title, mentionText) {
  const t = plain(title).toLowerCase();
  return t.length >= MIN_TITLE_CHARS && plain(mentionText).toLowerCase().includes(t);
}

/**
 * The state an options object gives a case. `stringAt(token)` returns the content of a string token (`"S<n>"` on
 * masked code, a quoted literal on raw text) or null. A key without a value (`{ skip }`) or with an expression is
 * truthy: only a falsy literal keeps the case active.
 */
export function stateOfOptions(text, stringAt = () => null) {
  let state = CASE_STATES.ACTIVE;
  for (const part of topLevelParts(text)) {
    const m = OPTION_ENTRY.exec(part);
    if (!m) continue;
    const key = m[1] ?? m[4] ?? (m[2] !== undefined ? stringAt(`"S${m[2]}"`) : null);
    if (key !== 'skip' && key !== 'todo') continue;
    const value = m[5]?.trim();
    const falsy = value !== undefined && (FALSY_LITERAL.test(value) || stringAt(value) === '');
    if (falsy) continue;
    if (key === 'skip') return CASE_STATES.SKIPPED;
    state = CASE_STATES.TODO;
  }
  return state;
}

function stateOf(modifiers, options, stringAt) {
  if (/\.skip\b/.test(modifiers)) return CASE_STATES.SKIPPED;
  if (/\.todo\b/.test(modifiers)) return CASE_STATES.TODO;
  return options === null ? CASE_STATES.ACTIVE : stateOfOptions(options, stringAt);
}

// Index past the whitespace and comments at `i`, bounded by MAX_OPTIONS_CHARS (masked code has none; raw text and diff
// lines do). An unclosed comment ends the search at the bound: many of them cannot make the reading quadratic.
function skipTrivia(text, i, limit = text.length) {
  const end = Math.min(limit, i + MAX_OPTIONS_CHARS);
  for (;;) {
    while (i < end && /\s/.test(text[i])) i += 1;
    const block = text.startsWith('/*', i);
    if (!block && !text.startsWith('//', i)) return i;
    const close = text.slice(i + 2, end).indexOf(block ? '*/' : '\n');
    if (close < 0) return end;
    i = i + 2 + close + (block ? 2 : 1);
  }
}

// Index of the quote closing the string opened at `i` (backslash escapes honoured), or -1 before `end`.
function quoteEnd(text, i, end) {
  for (let j = i + 1; j < end; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === text[i]) return j;
  }
  return -1;
}

// The text of an object whose `{` is just before `from`, up to its balanced `}` (or the cap / end of text), comments
// removed. Quoted text is skipped, so a brace, a comma or a comment marker inside a string does not count.
function objectBody(text, from, limit = text.length) {
  let depth = 0;
  let out = '';
  const end = Math.min(limit, from + MAX_OPTIONS_CHARS);
  for (let i = from; i < end; i += 1) {
    const ch = text[i];
    if (ch === '/' && (text[i + 1] === '*' || text[i + 1] === '/')) {
      const close = text[i + 1] === '*' ? text.slice(i + 2, end).indexOf('*/') : text.slice(i + 2, end).indexOf('\n');
      out += ' ';
      i = close < 0 ? end : i + 2 + close + (text[i + 1] === '*' ? 1 : 0);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const close = quoteEnd(text, i, end); // bounded by the cap: an unclosed quote cannot make it quadratic
      const stop = close < 0 ? end : close;
      out += text.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return out;
      depth -= 1;
    }
    out += ch;
  }
  return out;
}

// The comma-separated parts of an object body at its own level: a comma inside `{}`, `()`, `[]` or a string is not one.
function topLevelParts(body) {
  const text = String(body ?? '');
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const close = quoteEnd(text, i, text.length);
      i = close < 0 ? text.length : close;
    } else if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// `limit`: where the next case call starts. An unclosed object never reads into it, so a file of many unclosed objects
// is read once in total, not once per case.
const optionsAt = (text, index, titled, limit = text.length) => {
  let i = skipTrivia(text, index, limit);
  if (titled) {
    if (text[i] !== ',') return null;
    i = skipTrivia(text, i + 1, limit);
  }
  return text[i] === '{' && i < limit ? objectBody(text, i + 1, limit) : null;
};

const rawStringAt = (token) => {
  const m = /^(['"`])([\s\S]*)\1$/.exec(String(token ?? '').trim());
  return m ? m[2] : null;
};

// Matching `)` of every `(` in one pass (a stack), so reading every case body stays linear.
function closingParens(code) {
  const close = new Map();
  const open = [];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '(') open.push(i);
    else if (code[i] === ')' && open.length > 0) close.set(open.pop(), i);
  }
  return close;
}

// Number of sorted positions inside [from, to].
const countBetween = (sorted, from, to) => {
  const first = (x) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return first(to + 1) - first(from);
};

/**
 * Cases of a whole file on masked code: a `test(` inside a fixture or a comment is not a case, but the lexer is
 * heuristic (a regex literal holding a quote or a backtick can hide the code after it). `assertions` is the count in
 * the call's arguments, or null when the body cannot be read without doubt: its closing parenthesis is not found, or
 * it holds a `/` (a regex literal can carry a parenthesis that ends the call early; a division is withheld with it).
 * @returns {{ title: string, state: string, assertions: number | null }[]}
 */
export function maskedCases(source) {
  const { code, strings } = maskSource(source);
  const stringAt = (token) => {
    const m = /^"S(\d+)"$/.exec(String(token ?? '').trim());
    return m ? strings[Number(m[1])] : null;
  };
  const close = closingParens(code);
  const asserts = [...code.matchAll(ASSERTION)].map((m) => m.index);
  const calls = [...code.matchAll(CASE_CALL)];
  return calls.map((m, k) => {
    const titled = m[2] !== undefined;
    const end = m.index + m[0].length;
    const next = k + 1 < calls.length ? calls[k + 1].index : code.length;
    const open = m.index + m[0].indexOf('(');
    const closeAt = close.get(open);
    return {
      title: titled ? strings[Number(m[2])] : DYNAMIC_TITLE,
      state: stateOf(m[1], optionsAt(code, end, titled, Math.max(end, next)), stringAt),
      assertions: closeAt === undefined || AMBIGUOUS_BODY.test(code.slice(open, closeAt)) ? null : countBetween(asserts, open, closeAt),
    };
  });
}

/** Cases of a whole file on the raw text: every line-start call, fixtures and comments included, no lexer to fool. */
export function rawCases(source) {
  const text = String(source ?? '');
  const calls = [...text.matchAll(RAW_CASE_CALL)];
  return calls.map((m, k) => {
    const titled = m[3] !== undefined;
    const end = m.index + m[0].length;
    const next = k + 1 < calls.length ? calls[k + 1].index : text.length;
    return {
      title: m[2] === '`' || !titled ? DYNAMIC_TITLE : m[3],
      state: stateOf(m[1], optionsAt(text, end, titled, Math.max(end, next)), rawStringAt),
    };
  });
}

/** Cases written on diff lines (one line each: options on a later line are not seen). */
export function lineCases(lines) {
  return (lines ?? []).map((line) => {
    const m = CASE_LINE.exec(line);
    if (!m) return null;
    const titled = m[3] !== undefined;
    return { title: titled ? m[3] : DYNAMIC_TITLE, state: stateOf(m[1], optionsAt(line, m[0].length, titled), rawStringAt) };
  }).filter(Boolean);
}

// What `a` has that `b` does not, as multisets.
export const without = (a, b) => {
  const left = [...b];
  return a.filter((t) => {
    const at = left.indexOf(t);
    if (at >= 0) left.splice(at, 1);
    return at < 0;
  });
};

const isActive = (c) => c.state === CASE_STATES.ACTIVE;
const take = (list, title) => {
  const at = list.indexOf(title);
  if (at >= 0) list.splice(at, 1);
  return at >= 0;
};

/**
 * One reading, before → after. Removed: an active case with no active counterpart (`became` names its inactive state
 * when it is still there, skipped or todo), and an inactive case that is gone altogether. Added: an active case with no
 * active counterpart that re-enables nothing. An inactive case kept inactive counts for nothing.
 * @returns {{ removed: { title: string, became: string | null }[], added: string[] }}
 */
export function compareCases(was, is) {
  const titles = (list, active) => list.filter((c) => isActive(c) === active).map((c) => c.title);
  const added = without(titles(is, true), titles(was, true));
  const inactiveIs = is.filter((c) => !isActive(c));
  const leftInactive = without(inactiveIs.map((c) => c.title), titles(was, false));
  const goneInactive = without(titles(was, false), inactiveIs.map((c) => c.title)).filter((t) => !take(added, t));
  const became = (title) => {
    if (!take(leftInactive, title)) return null;
    return inactiveIs.find((c) => c.title === title).state;
  };
  return {
    removed: [...without(titles(was, true), titles(is, true)).map((title) => ({ title, became: became(title) })), ...goneInactive.map((title) => ({ title, became: null }))],
    added,
  };
}

/**
 * What a whole file lost and gained, read twice. The masked reading (the real lexer) decides; the raw one only confirms
 * that a case is there or gone, never its state, which it reads with a weaker lexer (PR #345 review: a comment or an
 * escaped quote in the options must not hide a skip):
 * - a case gone from the masked reading is lost only when the raw reading agrees (gone, or inactive): a lexer fooled
 *   into hiding code cannot make a kept case look removed, and a fixture can only make a removal go unseen;
 * - a case the masked reading sees turned skip / todo is lost when the raw reading still sees the case, in any state;
 * - a gain counts when the masked reading sees it, or when the raw one sees a title the masked reading does not see at
 *   all (a case the lexer hid). A raw misreading of a case's state never pays for a removal.
 * @returns {{ removed: string[], added: string[], became: Map<string, string> }}
 */
export function casesChange(before, after) {
  const maskedIs = maskedCases(after);
  const rawIs = rawCases(after);
  const masked = compareCases(maskedCases(before), maskedIs);
  const raw = compareCases(rawCases(before), rawIs);
  const lostRaw = raw.removed.map((r) => r.title);
  const presentRaw = rawIs.map((c) => c.title);
  const kept = masked.removed.filter((r) => (r.became ? take(presentRaw, r.title) : take(lostRaw, r.title)));
  const became = new Map(kept.filter((r) => r.became).map((r) => [r.title, r.became]));
  const seenMasked = maskedIs.map((c) => c.title);
  const hidden = without(raw.added, masked.added).filter((t) => !seenMasked.includes(t));
  return { removed: kept.map((r) => r.title), added: [...masked.added, ...hidden], became };
}

/**
 * Kept cases that lost assertions: a plain title active before and after (masked reading) and present on the raw one,
 * its body read without doubt on both sides, paired by title in order. A case added, removed or moved to another file is not compared.
 * @returns {{ title: string, was: number, is: number }[]}
 */
export function assertionDrops(before, after) {
  // The raw reading confirms the case is there (any state: its state is the masked reading's call).
  const presentTitles = (list) => list.map((c) => c.title);
  const rawWas = presentTitles(rawCases(before));
  const rawIs = presentTitles(rawCases(after));
  const byTitle = (list) => {
    const map = new Map();
    for (const c of list) if (isActive(c) && c.title !== DYNAMIC_TITLE) map.set(c.title, [...(map.get(c.title) ?? []), c.assertions]);
    return map;
  };
  const next = byTitle(maskedCases(after));
  const drops = [];
  for (const [title, counts] of byTitle(maskedCases(before))) {
    const later = next.get(title) ?? [];
    if (!rawWas.includes(title) || !rawIs.includes(title)) continue;
    counts.slice(0, later.length).forEach((was, i) => {
      const is = later[i];
      if (was !== null && is !== null && is < was) drops.push({ title, was, is });
    });
  }
  return drops;
}
