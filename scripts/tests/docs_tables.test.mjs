import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PIPELINE_ROOT } from '../lib/roots.mjs';

// A Markdown table row with a cell too many (text appended after the last pipe, a stray separator) renders as a
// broken table and was shipped once in docs/testing.md. Every table of the docs must have, on each row, the number of
// cells of its header. Pipes inside `code` spans and escaped pipes do not split a cell; fenced code is skipped.

/** The cells of one table row. */
export function splitRow(line) {
  const cells = [];
  let cell = '';
  let code = false;
  let escaped = false;
  for (const ch of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (escaped) { cell += ch; escaped = false; continue; }
    if (ch === '\\') { cell += ch; escaped = true; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { cells.push(cell); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** `{ line, cells, expected }` for each row whose cell count differs from its table header's. */
export function badRows(markdown) {
  const bad = [];
  let header = null;
  let fenced = false;
  markdown.split('\n').forEach((text, i) => {
    if (/^\s*```/.test(text)) { fenced = !fenced; header = null; return; }
    if (fenced || !text.startsWith('|')) { header = null; return; }
    const cells = splitRow(text).length;
    if (header === null) header = cells;
    else if (cells !== header) bad.push({ line: i + 1, cells, expected: header });
  });
  return bad;
}

const files = ['AGENTS.md', ...fs.readdirSync(path.join(PIPELINE_ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => path.join('docs', f))];

for (const file of files) {
  test(`${file}: every table row has the number of cells of its header`, () => {
    const found = badRows(fs.readFileSync(path.join(PIPELINE_ROOT, file), 'utf8'));
    assert.deepEqual(found, [], `${file}: rows with the wrong number of cells: ${found.map((b) => `line ${b.line} has ${b.cells}, header ${b.expected}`).join('; ')}`);
  });
}

test('badRows finds a cell appended after the last pipe, and ignores code spans, escaped pipes and fenced code', () => {
  assert.deepEqual(badRows('| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 |'), [{ line: 3, cells: 3, expected: 2 }]);
  assert.deepEqual(badRows('| a | b |\n|---|---|\n| `x | y` | 2 |\n| p \\| q | 2 |'), []);
  assert.deepEqual(badRows('```\n| a | b |\n| 1 | 2 | 3 |\n```\n| a | b |\n|---|---|\n| 1 | 2 |'), []);
  assert.deepEqual(badRows('| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |'), [], 'a new table has its own header');
  assert.deepEqual(splitRow('| a | `b | c` | d \\| e |'), [' a ', ' `b | c` ', ' d \\| e ']);
});
