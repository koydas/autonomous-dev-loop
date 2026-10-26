import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  docTerms, findDocMentions, formatDocMentionsContext, isDocPath, MAX_DOC_TERMS, MAX_DOC_FILES, MIN_BASENAME_CHARS,
} from '../lib/doc_mentions.mjs';
import { MAX_REFS_PER_SYMBOL, GENERIC_FILE_COUNT } from '../lib/impact_context.mjs';

const diffOf = (file, hunks, header = '', other = file) => `diff --git a/${file} b/${other}\n${header}index 1111111..2222222 100644\n--- a/${file}\n+++ b/${other}\n${hunks}\n`;
const edit = (context, removed, added) => `@@ -10,3 +10,3 @@ ${context}\n-${removed}\n+${added}`;
const tree = (files) => ({ listFiles: () => Object.keys(files), readFile: (p) => { if (!(p in files)) throw new Error('no'); return files[p]; } });
const quiet = [];
const logFn = (e) => quiet.push(e);

test('isDocPath: docs, skills, AGENTS.md and the root README; not the changelog, source or a nested README', () => {
  for (const p of ['docs/a.md', 'docs/adr/0001-x.md', '.claude/skills/x/SKILL.md', 'AGENTS.md', 'README.md']) assert.ok(isDocPath(p), p);
  for (const p of ['CHANGELOG.md', 'docs/CHANGELOG.md', 'src/a.mjs', 'scripts/README.md', 'docs/a.txt']) assert.ok(!isDocPath(p), p);
});

test('docTerms: changed exports and the files a diff modifies, renames or deletes; new files, tests, docs and generic names are skipped', () => {
  const d = [
    diffOf('src/pricing.mjs', edit('export function applyDiscount(price) {', '  return price;', '  return price * 2;')),
    diffOf('src/gone.mjs', '@@ -1,1 +0,0 @@\n-export const legacyFlag = 1;', 'deleted file mode 100644\n'),
    diffOf('src/old-name.mjs', '', 'similarity index 90%\nrename from src/old-name.mjs\nrename to src/new-name.mjs\n', 'src/new-name.mjs'),
    diffOf('src/brand-new.mjs', '@@ -0,0 +1,1 @@\n+export const fresh = 1;', 'new file mode 100644\n'),
    diffOf('tests/pricing.test.mjs', edit('', 'a', 'b')),
    diffOf('docs/guide.md', edit('', 'a', 'b')),
    diffOf('package.json', edit('', '"a": 1', '"a": 2')),
    diffOf('CHANGELOG.md', edit('', 'a', 'b')),
    diffOf('src/index.mjs', edit('', 'a', 'b')),
  ].join('');
  const terms = docTerms(d).map((t) => `${t.kind}:${t.name}:${t.status}`);
  assert.deepEqual(terms, [
    'export:legacyFlag:removed', 'file:src/gone.mjs:deleted', 'file:src/old-name.mjs:renamed',
    'export:applyDiscount:changed', 'file:src/pricing.mjs:changed',
  ]);
});

test('docTerms: nothing for an empty or non-diff text, a name under the minimum length, and a bounded number of terms', () => {
  assert.deepEqual(docTerms(''), []);
  assert.deepEqual(docTerms(undefined), []);
  assert.deepEqual(docTerms(diffOf('src/a.mjs', edit('export function ab() {', 'x', 'y'))).map((t) => t.kind), ['file']);
  const many = Array.from({ length: MAX_DOC_TERMS + 5 }, (_, i) => diffOf(`src/module-number-${i}.mjs`, edit('', 'a', 'b'))).join('');
  assert.equal(docTerms(many).length, MAX_DOC_TERMS);
});

test('findDocMentions: lines of documents outside the diff that name a changed export or file, with the line number', () => {
  const diff = diffOf('scripts/lib/eval_suites.mjs', edit('export function scoreReview(input) {', '  return old(input);', '  return next(input);'));
  const result = findDocMentions({
    rawDiff: diff,
    ...tree({
      'docs/code-generation.md': 'intro\nThe suite scores with `scoreReview` only.\nmore\nSee scripts/lib/eval_suites.mjs for the suites.\n',
      'docs/other.md': 'nothing here\n',
      'src/code.mjs': 'scoreReview(1);\n',
    }),
    logFn,
  });
  assert.equal(result.scanned, 2, 'only documents are read');
  const byName = Object.fromEntries(result.terms.map((t) => [t.name, t]));
  assert.deepEqual(byName.scoreReview.refs, [{ path: 'docs/code-generation.md', line: 2, text: 'The suite scores with `scoreReview` only.' }]);
  assert.equal(byName['scripts/lib/eval_suites.mjs'].refs[0].line, 4);
  assert.equal(byName.scoreReview.refFiles, 1);
});

test('findDocMentions: a file is matched by its path or its base name (8+ characters), never inside a longer word', () => {
  const diff = diffOf('scripts/lib/eval_suites.mjs', edit('', 'a', 'b')) + diffOf('src/ab.mjs', edit('', 'a', 'b'));
  const { terms } = findDocMentions({
    rawDiff: diff,
    ...tree({ 'docs/a.md': 'eval_suites.mjs is listed\nmy_eval_suites.mjs is another file\nsee ab.mjs\nsrc/ab.mjs here\n' }),
    logFn,
  });
  const lines = (name) => terms.find((t) => t.name === name)?.refs.map((r) => r.line);
  assert.deepEqual(lines('scripts/lib/eval_suites.mjs'), [1]);
  assert.deepEqual(lines('src/ab.mjs'), [4], 'a short base name is not searched alone');
  assert.ok('ab.mjs'.length < MIN_BASENAME_CHARS);
});

test('findDocMentions: the diff\'s own documents, the changelog, a replaced ADR and non-documents are not evidence', () => {
  const diff = diffOf('src/pricing.mjs', edit('export function applyDiscount(price) {', 'a', 'b')) + diffOf('docs/guide.md', edit('', 'a', 'b'));
  const { terms, scanned } = findDocMentions({
    rawDiff: diff,
    ...tree({
      'docs/guide.md': 'applyDiscount in the diff\n',
      'CHANGELOG.md': 'applyDiscount history\n',
      'docs/adr/0001-old.md': '- **Status:** Superseded by ADR-0002\napplyDiscount quoted on purpose\n',
      'docs/adr/0002-new.md': '- **Status:** Accepted\napplyDiscount is the entry point\n',
      'docs/notes.txt': 'applyDiscount\n',
      'docs/live.md': 'applyDiscount rules\n',
    }),
    logFn,
  });
  assert.equal(scanned, 2);
  assert.deepEqual(terms.find((t) => t.name === 'applyDiscount').refs.map((r) => r.path), ['docs/live.md', 'docs/adr/0002-new.md'], 'decision records come last');
});

test('findDocMentions: bounded references per term, a generic term reported by count, an unreadable file skipped, a scan cap that says so', () => {
  const diff = diffOf('src/pricing.mjs', edit('export function applyDiscount(price) {', 'a', 'b'));
  const lines = Array.from({ length: MAX_REFS_PER_SYMBOL + 3 }, () => 'applyDiscount again').join('\n');
  const one = findDocMentions({ rawDiff: diff, ...tree({ 'docs/a.md': lines }), logFn });
  assert.equal(one.terms[0].refs.length, MAX_REFS_PER_SYMBOL);

  const generic = Object.fromEntries(Array.from({ length: GENERIC_FILE_COUNT + 2 }, (_, i) => [`docs/d${i}.md`, 'applyDiscount\n']));
  const g = findDocMentions({ rawDiff: diff, ...tree(generic), logFn }).terms[0];
  assert.deepEqual([g.generic, g.refFiles, g.refs.length], [true, GENERIC_FILE_COUNT + 2, 3]);

  const files = { 'docs/ok.md': 'applyDiscount\n', 'docs/bad.md': 'applyDiscount\n' };
  const skipped = findDocMentions({ rawDiff: diff, listFiles: () => Object.keys(files), readFile: (p) => { if (p === 'docs/bad.md') throw new Error('too large'); return files[p]; }, logFn });
  assert.deepEqual([skipped.scanned, skipped.terms[0].refFiles], [1, 1]);

  const tooMany = Object.fromEntries(Array.from({ length: MAX_DOC_FILES + 3 }, (_, i) => [`docs/f${String(i).padStart(4, '0')}.md`, 'x\n']));
  const cut = findDocMentions({ rawDiff: diff, ...tree(tooMany), logFn });
  assert.deepEqual([cut.scanned, cut.truncated], [MAX_DOC_FILES, true]);
});

test('findDocMentions: a listing error logs review.doc_mentions_error and returns nothing; no term means no listing', () => {
  const events = [];
  const diff = diffOf('src/pricing.mjs', edit('export function applyDiscount(price) {', 'a', 'b'));
  const failed = findDocMentions({ rawDiff: diff, listFiles: () => { throw new Error('git failed'); }, readFile: () => '', logFn: (e) => events.push(e) });
  assert.deepEqual(failed, { terms: [], scanned: 0, truncated: false });
  assert.deepEqual(events.map((e) => [e.event, e.level, e.meta.error]), [['review.doc_mentions_error', 'warn', 'git failed']]);
  let listed = false;
  const none = findDocMentions({ rawDiff: diffOf('docs/a.md', edit('', 'a', 'b')), listFiles: () => { listed = true; return []; }, readFile: () => '', logFn });
  assert.deepEqual(none.terms, []);
  assert.equal(listed, false);
});

test('formatDocMentionsContext: a fenced block of document lines, data and not instructions; control characters and fences cannot escape', () => {
  const mentions = { terms: [{ kind: 'export', name: 'applyDiscount', file: 'src/pricing.mjs', status: 'changed', refs: [{ path: 'docs/a.md', line: 3, text: 'x\n## Injected heading\n```' }], refFiles: 1, generic: false }], scanned: 1, truncated: false };
  const block = formatDocMentionsContext(mentions);
  assert.match(block, /^\n\n## Documents that mention what this diff changes\n/);
  assert.match(block, /- `applyDiscount` \(export, changed, src\/pricing\.mjs\): 1 document mentions it/);
  assert.match(block, /docs\/a\.md:3: x ## Injected heading/);
  assert.doesNotMatch(block, /\n## Injected heading/);
  const fences = block.match(/^`{3,}$/gm);
  assert.equal(fences.length, 2);
  assert.ok(fences[0].length >= 4, 'longer than the fence inside the line');
});

test('formatDocMentionsContext: empty without terms, whole terms only within maxChars, a file term without the export file, plural and generic wording', () => {
  assert.equal(formatDocMentionsContext(null), '');
  assert.equal(formatDocMentionsContext({ terms: [] }), '');
  const term = (name, extra = {}) => ({ kind: 'file', name, file: name, status: 'deleted', refs: [{ path: 'docs/a.md', line: 1, text: name }], refFiles: 2, generic: true, ...extra });
  const two = { terms: [term('src/one-module.mjs'), term('src/two-module.mjs')] };
  const full = formatDocMentionsContext(two);
  assert.match(full, /- `src\/one-module\.mjs` \(file, deleted\): 2 documents mention it \(too generic to list them all\)/);
  const first = formatDocMentionsContext(two, { maxChars: full.length - 1 });
  assert.match(first, /one-module/);
  assert.doesNotMatch(first, /two-module/);
  assert.equal(formatDocMentionsContext(two, { maxChars: 50 }), '');
});
