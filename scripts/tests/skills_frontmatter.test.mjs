import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A plain YAML scalar cannot hold ": " or " #": a strict loader rejects the frontmatter and the skill is not
// registered. Descriptions are double-quoted; the name matches the directory.

const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '../../.claude/skills');

for (const { name: dir } of readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  test(`skill ${dir}: frontmatter has a name equal to its directory and a double-quoted description`, () => {
    const text = readFileSync(resolve(SKILLS, dir, 'SKILL.md'), 'utf8');
    const match = /^---\r?\nname: (.+?)\r?\ndescription: (.+?)\r?\n---\r?\n/.exec(text);
    assert.ok(match, 'frontmatter must be name then description between --- lines');
    assert.equal(match[1], dir);
    assert.match(match[2], /^"[^"]+"$/, 'description must be a double-quoted scalar without inner double quotes');
  });
}
