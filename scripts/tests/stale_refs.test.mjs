import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeText, isSearchedPath, parseDiffBlocks, findStaleReferences, formatStaleRefsContext, formatStaleRefsSection,
  MIN_MATCH_CHARS, MIN_RUN_CHARS, QUOTE_SLACK_CHARS, MAX_LIVE_SOURCE_CHARS, MAX_REPORTED_HITS,
} from '../lib/stale_refs.mjs';
import { parseFlatYaml } from '../lib/yaml.mjs';
import { loadReviewSystemPrompt } from '../lib/review_prompt.mjs';
import { LOW_HEADROOM_RATIO, computePromptBudgetImpact } from '../lib/prompt_budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const RULE = 'The reviewer must flag every new module that ships without a coverage step in the workflow file.';
const fileDiff = (file, body, start = 10) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${start},3 +${start},3 @@\n${body}\n`;
const repo = (files) => ({ listFiles: () => Object.keys(files), readFile: (p) => files[p] });
const silent = () => {};
const run = (rawDiff, files, logFn = silent) => findStaleReferences({ rawDiff, ...repo(files), logFn });

// normalizeText / isSearchedPath

test('normalizeText strips backticks, * and _, collapses whitespace and lowercases', () => {
  assert.equal(normalizeText('  **Use** `foo_bar`\n\t in  _CI_ '), 'use foobar in ci');
  assert.equal(normalizeText(null), '');
});

test('isSearchedPath covers docs, skills and AGENTS.md, never CHANGELOG.md or prompts (live rules)', () => {
  for (const p of ['docs/a.md', 'docs/adr/0001-x.md', '.claude/skills/x/SKILL.md', 'AGENTS.md']) assert.ok(isSearchedPath(p), p);
  for (const p of ['CHANGELOG.md', 'docs/CHANGELOG.md', 'prompts/p.md', 'prompts/sub/p.md', 'README.md', 'docs/a.txt', 'scripts/a.mjs']) assert.equal(isSearchedPath(p), false, p);
});

// parseDiffBlocks

test('parseDiffBlocks groups consecutive - lines per hunk with their old-file line', () => {
  const diff = fileDiff('a.md', ' ctx\n-one\n-two\n ctx\n-three\n+added', 5);
  const { removed, added, paths } = parseDiffBlocks(diff);
  assert.deepEqual(removed, [{ file: 'a.md', newFile: 'a.md', line: 6, text: 'one\ntwo' }, { file: 'a.md', newFile: 'a.md', line: 9, text: 'three' }]);
  assert.deepEqual(added.get('a.md'), ['added']);
  assert.deepEqual([...paths], ['a.md']);
});

test('parseDiffBlocks ignores file headers and lines outside a hunk, and records both rename paths', () => {
  const diff = 'diff --git a/old.md b/new.md\n--- a/old.md\n+++ b/new.md\n-not in a hunk\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y';
  const { removed, paths } = parseDiffBlocks(diff);
  assert.deepEqual(removed, [{ file: 'old.md', newFile: 'new.md', line: 1, text: 'x' }]);
  assert.deepEqual([...paths], ['old.md', 'new.md']);
  assert.deepEqual(parseDiffBlocks('@@ -1 +1 @@\n-orphan').removed, []);
  assert.deepEqual(parseDiffBlocks(undefined).removed, []);
});

// findStaleReferences

test('findStaleReferences reports removed text still quoted in a doc, with the line of the quote', () => {
  const hits = run(fileDiff('prompts/review.md', `-${RULE}`), { 'docs/guide.md': `# Guide\n\nIntro.\n\n> ${RULE}\n` });
  assert.deepEqual(hits, [{ removedText: RULE, file: 'prompts/review.md', line: 10, foundIn: [{ path: 'docs/guide.md', line: 5 }] }]);
});

test('findStaleReferences returns [] when no searched file quotes the removed text', () => {
  assert.deepEqual(run(fileDiff('prompts/review.md', `-${RULE}`), { 'docs/guide.md': 'Unrelated content only.', 'scripts/a.mjs': RULE }), []);
});

test('findStaleReferences ignores removed blocks under 60 normalized chars', () => {
  const short = 'Coverage is enforced for checkpoint only.';
  assert.ok(normalizeText(short).length < MIN_MATCH_CHARS);
  assert.deepEqual(run(fileDiff('prompts/review.md', `-${short}`), { 'docs/guide.md': short }), []);
});

test('findStaleReferences excludes CHANGELOG.md', () => {
  assert.deepEqual(run(fileDiff('prompts/review.md', `-${RULE}`), { 'CHANGELOG.md': `- ${RULE}` }), []);
});

test('findStaleReferences excludes the file the text was removed from', () => {
  assert.deepEqual(run(fileDiff('docs/guide.md', `-${RULE}`), { 'docs/guide.md': `Same text again later: ${RULE}` }), []);
});

test('findStaleReferences excludes a file the diff re-adds the text to (a move), not the others', () => {
  const diff = fileDiff('prompts/review.md', `-${RULE}`) + fileDiff('docs/moved.md', `+${RULE}`);
  const hits = run(diff, { 'docs/moved.md': RULE, 'docs/other.md': RULE });
  assert.deepEqual(hits.map((h) => h.foundIn), [[{ path: 'docs/other.md', line: 1 }]]);
});

test('findStaleReferences matches despite backtick, emphasis, case and line-wrap differences', () => {
  const removed = '-The reviewer must flag every `new module` that ships\n-without a coverage step in the **workflow file**.';
  const doc = 'Policy:\nthe Reviewer must flag every *new module* that ships without\n   a coverage step in the workflow file.';
  const hits = run(fileDiff('prompts/review.md', removed), { 'docs/policy.md': doc });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].removedText, 'The reviewer must flag every `new module` that ships\nwithout a coverage step in the **workflow file**.');
  assert.deepEqual(hits[0].foundIn, [{ path: 'docs/policy.md', line: 2 }]);
});

test('findStaleReferences matches a doc quoting only a 60-char window of a longer block, at its longest quote', () => {
  const removed = `-Preamble that the doc never quotes at all. ${RULE} Trailing words nobody kept.`;
  const doc = `Partial: the reviewer must flag every new module that ships without a coverage check.\nFull: never quotes at all. ${RULE}`;
  const hits = run(fileDiff('prompts/review.md', removed), { 'docs/a.md': doc });
  assert.deepEqual(hits[0].foundIn, [{ path: 'docs/a.md', line: 2 }]);
});

test('findStaleReferences returns [] without removed text, without reading any file', () => {
  const failing = () => { throw new Error('must not be called'); };
  assert.deepEqual(findStaleReferences({ rawDiff: fileDiff('a.md', '+only added'), listFiles: failing, readFile: failing }), []);
});

test('findStaleReferences returns [] and logs a warn event when a file cannot be read', () => {
  const events = [];
  const hits = findStaleReferences({
    rawDiff: fileDiff('prompts/review.md', `-${RULE}`),
    listFiles: () => ['docs/a.md'],
    readFile: () => { throw new Error('EACCES: permission denied'); },
    logFn: (e) => events.push(e),
  });
  assert.deepEqual(hits, []);
  assert.deepEqual(events, [{ stage: 'review', event: 'review.stale_refs_error', level: 'warn', meta: { error: 'EACCES: permission denied' } }]);
});

test('findStaleReferences returns [] and logs a warn event when the file listing fails', () => {
  const events = [];
  const hits = findStaleReferences({
    rawDiff: fileDiff('prompts/review.md', `-${RULE}`),
    listFiles: () => { throw new Error('not a git repository'); },
    readFile: () => '',
    logFn: (e) => events.push(e),
  });
  assert.deepEqual(hits, []);
  assert.equal(events[0].level, 'warn');
});

test('findStaleReferences logs through observability by default (stderr JSON, no throw)', () => {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const hits = findStaleReferences({ rawDiff: fileDiff('prompts/review.md', `-${RULE}`), listFiles: () => { throw new Error('boom'); }, readFile: () => '' });
    assert.deepEqual(hits, []);
  } finally {
    process.stderr.write = original;
  }
  assert.match(writes.join(''), /"event":"review\.stale_refs_error".*"level":"warn"/);
});

test('findStaleReferences ignores removed text still in the head version of its source file (a reworded line)', () => {
  const diff = fileDiff('prompts/review.md', `-Old wording. ${RULE}\n+${RULE} New wording.`);
  const files = { 'prompts/review.md': `${RULE} New wording.`, 'docs/guide.md': `> Old wording. ${RULE}` };
  assert.deepEqual(run(diff, files), []);
  // A deleted source file holds nothing: the quote is stale.
  assert.equal(run(diff, { 'docs/guide.md': files['docs/guide.md'] }).length, 1);
  // A renamed source file is read at its new path.
  const renamed = diff.replace('diff --git a/prompts/review.md b/prompts/review.md', 'diff --git a/scripts/old.mjs b/scripts/new.mjs');
  assert.deepEqual(run(renamed, { 'scripts/new.mjs': `// ${RULE} New wording.`, 'docs/guide.md': files['docs/guide.md'] }), []);
  assert.equal(run(renamed, { 'scripts/new.mjs': 'Unrelated.', 'docs/guide.md': files['docs/guide.md'] }).length, 1);
});

test('findStaleReferences does not scan a live source over MAX_LIVE_SOURCE_CHARS: its text stays stale', () => {
  const diff = fileDiff('data/big.json', `-${RULE}`);
  const big = `${RULE}${' '.repeat(MAX_LIVE_SOURCE_CHARS)}`;
  assert.equal(run(diff, { 'data/big.json': big, 'docs/guide.md': RULE }).length, 1);
  assert.deepEqual(run(diff, { 'data/big.json': RULE, 'docs/guide.md': RULE }), []);
});

test('findStaleReferences ignores removed text a prompt still holds, and never reports a prompt', () => {
  const diff = fileDiff('prompts/auto-fix.md', `-${RULE}`);
  assert.deepEqual(run(diff, { 'prompts/generation.md': RULE, 'docs/guide.md': RULE }), []);
  assert.deepEqual(run(diff, { 'prompts/generation.md': 'Unrelated.', 'docs/guide.md': RULE }).map((h) => h.foundIn), [[{ path: 'docs/guide.md', line: 1 }]]);
});

test('findStaleReferences reports every doc quoting removed text: docs do not keep each other live', () => {
  const hits = run(fileDiff('prompts/review.md', `-${RULE}`), { 'docs/a.md': RULE, 'AGENTS.md': RULE });
  assert.deepEqual(hits[0].foundIn, [{ path: 'AGENTS.md', line: 1 }, { path: 'docs/a.md', line: 1 }]);
});

test('findStaleReferences keeps a source file live for its own blocks only: a doc the diff edits elsewhere masks nothing', () => {
  // The PR changes the rule in code and removes another paragraph of a doc that still quotes the rule.
  const other = 'An unrelated paragraph of the guide that this pull request removes during a cleanup pass.';
  const diff = fileDiff('scripts/x.mjs', `-// ${RULE}\n+// New behavior.`) + fileDiff('docs/guide.md', `-${other}`, 20);
  const files = { 'scripts/x.mjs': '// New behavior.\n', 'docs/guide.md': `# Guide\n\n${RULE}\n`, 'docs/runbook.md': RULE };
  const hits = run(diff, files);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].foundIn, [{ path: 'docs/guide.md', line: 3 }, { path: 'docs/runbook.md', line: 1 }]);
});

test('findStaleReferences reports the quote line when the removed block carries a `//` or `-` prefix', () => {
  for (const prefix of ['// ', '- ']) {
    const hits = run(fileDiff('scripts/x.mjs', `-${prefix}${RULE}`), { 'docs/guide.md': `# Guide\n\nIntro.\n\n${RULE}\n` });
    assert.deepEqual(hits[0].foundIn, [{ path: 'docs/guide.md', line: 5 }], prefix);
  }
});

test('findStaleReferences needs a MIN_RUN_CHARS quote of a longer block, the whole block when shorter', () => {
  const long = `${RULE} It also applies to every workflow that runs one of these modules in CI.`;
  const shortQuote = normalizeText(RULE).slice(0, MIN_RUN_CHARS - 10);
  assert.ok(shortQuote.length >= MIN_MATCH_CHARS);
  assert.deepEqual(run(fileDiff('prompts/review.md', `-${long}`), { 'docs/a.md': shortQuote }), []);
  assert.equal(run(fileDiff('prompts/review.md', `-${long}`), { 'docs/a.md': long.slice(0, MIN_RUN_CHARS + 5) }).length, 1);
  // A block shorter than MIN_RUN_CHARS counts when quoted whole, give or take QUOTE_SLACK_CHARS (a
  // comment prefix), not when only a window of it is.
  const block = `// ${RULE}`;
  assert.ok(normalizeText(block).length < MIN_RUN_CHARS);
  assert.equal(run(fileDiff('scripts/a.mjs', `-${block}`), { 'docs/a.md': RULE }).length, 1);
  const window = RULE.slice(0, RULE.length - QUOTE_SLACK_CHARS);
  assert.ok(normalizeText(window).length >= MIN_MATCH_CHARS);
  assert.deepEqual(run(fileDiff('scripts/a.mjs', `-${block}`), { 'docs/a.md': window }), []);
});

// Regression: PR #207 reworded every line of prompts/auto-fix-system.md (diff and head file as of
// 46ee7d2, the head the review raised a High on). Six docs shared a 60-char window of generic
// phrasing with the removed lines (excerpts around each quoted line); every rule still exists, in the
// reworded prompt or in prompts/generation-system.md. None is stale.
const PR207 = resolve(ROOT, 'scripts/tests/fixtures/stale-refs-pr207');
const PR207_FILES = [
  'prompts/auto-fix-system.md', 'prompts/generation-system.md', 'prompts/generation-user.md', 'docs/code-generation.md',
  'docs/runbook.md', 'docs/adr/0009-llm-agent-guardrails.md', 'docs/adr/0021-protected-write-path-denylist.md',
];

test('findStaleReferences reports nothing on PR #207 (reworded prompt, rules still in the tree)', () => {
  const rawDiff = readFileSync(resolve(PR207, 'pr207.diff'), 'utf8');
  const files = Object.fromEntries(PR207_FILES.map((p) => [p, readFileSync(resolve(PR207, 'head', p), 'utf8')]));
  // The fixture reproduces the trigger: each of the six locations shares a 60-char window with a removed block.
  const windows = parseDiffBlocks(rawDiff).removed.flatMap(({ text }) => {
    const n = normalizeText(text);
    return Array.from({ length: Math.max(0, n.length - MIN_MATCH_CHARS + 1) }, (_, at) => n.slice(at, at + MIN_MATCH_CHARS));
  });
  for (const p of PR207_FILES.slice(1)) assert.ok(windows.some((w) => normalizeText(files[p]).includes(w)), p);
  assert.deepEqual(run(rawDiff, files), []);
});

// Regression: PR #186 removed the old gate (c) rule from prompts/pr-review-system.md; ADR-0012
// (Decision, line 18) still quoted it and the reviewer missed it (only the diff was shown).
// #186 then marked ADR-0012 Superseded: the fixture restores the status it had during that review.
const GATE_C_REMOVED = '-* For gate (c), CI enforces coverage only for `scripts/lib/checkpoint.mjs` via c8 in test.yml. For all other changed automation logic, if the diff does not add/maintain an explicit minimum unit-test coverage policy/check for that flow, report HIGH severity.';
const GATE_C_ADDED = '+* For gate (c), CI enforces a minimum of 80% unit-test coverage with a dedicated step for each listed file.';
const ADR_0012 = 'docs/adr/0012-coverage-enforcement-delegation-to-ci.md';

test('findStaleReferences flags ADR-0012 for the gate (c) rule removed by PR #186', () => {
  const adr = readFileSync(resolve(ROOT, ADR_0012), 'utf8').replace(/^- \*\*Status:\*\*.*$/m, '- **Status:** Accepted');
  const hits = run(fileDiff('prompts/pr-review-system.md', `${GATE_C_REMOVED}\n${GATE_C_ADDED}`, 16), { [ADR_0012]: adr, 'CHANGELOG.md': GATE_C_REMOVED });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'prompts/pr-review-system.md');
  assert.equal(hits[0].line, 16);
  assert.deepEqual(hits[0].foundIn, [{ path: ADR_0012, line: 18 }]);
});

test('findStaleReferences skips Superseded and Deprecated ADRs (they quote the replaced rule on purpose)', () => {
  const current = readFileSync(resolve(ROOT, ADR_0012), 'utf8');
  assert.match(current, /^- \*\*Status:\*\* Superseded/m);
  const diff = fileDiff('prompts/pr-review-system.md', GATE_C_REMOVED, 16);
  assert.deepEqual(run(diff, { [ADR_0012]: current }), []);
  const deprecated = `# ADR-0009: X\n\n- **Status:** Deprecated\n\n> ${GATE_C_REMOVED.slice(1)}`;
  assert.deepEqual(run(diff, { 'docs/adr/0009-x.md': deprecated }), []);
  // The status line only counts in an ADR: a guide mentioning "Superseded" is still searched.
  const guide = `- **Status:** Superseded by nothing, this is a guide.\n\n${GATE_C_REMOVED.slice(1)}`;
  assert.deepEqual(run(diff, { 'docs/guide.md': guide }).map((h) => h.foundIn), [[{ path: 'docs/guide.md', line: 3 }]]);
});

// formatting

test('formatStaleRefsContext and formatStaleRefsSection are empty without hits', () => {
  assert.equal(formatStaleRefsContext([]), '');
  assert.equal(formatStaleRefsContext(undefined), '');
  assert.equal(formatStaleRefsSection([]), '');
  assert.equal(formatStaleRefsSection(null), '');
});

test('formatStaleRefsContext quotes the removed text (capped) and every location', () => {
  const long = `${RULE} ${'x'.repeat(300)}`;
  const ctx = formatStaleRefsContext([{ removedText: long, file: 'prompts/p.md', line: 3, foundIn: [{ path: 'docs/a.md', line: 7 }, { path: 'AGENTS.md', line: 2 }] }]);
  assert.match(ctx, /^\n\n## Stale references/);
  assert.match(ctx, /Removed from prompts\/p\.md:3 — "The reviewer must flag.*x…" — still referenced in: docs\/a\.md:7, AGENTS\.md:2/);
  assert.ok(ctx.length < 700);
});

test('formatStaleRefsContext and formatStaleRefsSection cap the number of hits', () => {
  const hits = Array.from({ length: MAX_REPORTED_HITS + 2 }, (_, i) => ({ removedText: `t${i}`, file: `f${i}.md`, line: i, foundIn: [{ path: 'docs/a.md', line: 1 }] }));
  const ctx = formatStaleRefsContext(hits);
  const section = formatStaleRefsSection(hits);
  assert.equal((ctx.match(/^- Removed from/gm) ?? []).length, MAX_REPORTED_HITS);
  assert.match(ctx, /…and 2 more$/);
  assert.match(section, /^\n### 🔗 Stale References/);
  assert.match(section, /- `f0\.md:0` → `docs\/a\.md:1`/);
  assert.match(section, /…and 2 more$/);
});

// The block is a lead, never a verdict input (ADR-0035): the system prompt and the block both cap it at
// one Low "verify" issue, and the rule must not push pr-review-system.md under the ADR-0037 margin.
test('stale references are capped at a Low verify note in the prompt, within the review headroom', () => {
  const ctx = formatStaleRefsContext([{ removedText: RULE, file: 'prompts/p.md', line: 1, foundIn: [{ path: 'docs/a.md', line: 1 }] }]);
  assert.match(ctx, /at most one Low "Verify stale reference" issue, never Medium or High, never a reason for REQUEST_CHANGES/);
  assert.doesNotMatch(ctx, /gate \(b\)/);
  const PROMPT = 'prompts/pr-review-system.md';
  const system = readFileSync(resolve(ROOT, PROMPT), 'utf8');
  // The rule is split between the neutral core and this repository's rules (ADR-0045): the assembled prompt keeps both halves.
  assert.match(loadReviewSystemPrompt({ self: true }), /"Stale references" block is a lead.*at most one Low issue, "Verify stale reference".*never a Medium or High finding, never a reason for REQUEST_CHANGES\. A hit alone is never a gate \(b\) finding; judge gate \(b\) from the diff as usual/);
  const models = parseFlatYaml(readFileSync(resolve(ROOT, 'config/models.yaml'), 'utf8'));
  const [impact] = computePromptBudgetImpact({
    rawDiff: `diff --git a/${PROMPT} b/${PROMPT}\n--- a/${PROMPT}\n+++ b/${PROMPT}\n@@ -1 +1 @@\n-a\n+b\n`,
    readBase: () => system, readHead: (p) => readFileSync(resolve(ROOT, p), 'utf8'), models, logFn: () => {},
  });
  assert.equal(impact.stage, 'review');
  assert.ok(impact.headroomTokens >= Math.ceil(impact.maxInputTokens * LOW_HEADROOM_RATIO), `${impact.headroomTokens} of ${impact.maxInputTokens}`);
});
