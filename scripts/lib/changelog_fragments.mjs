/**
 * Deterministic changelog fragments. Pure render/validate operations.
 * Only the release operator writes the root changelog.
 */
import { createHash } from 'node:crypto';

export const FRAGMENT_NAME = /^changes\/([1-9]\d*)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const HEADER = '## [Unreleased]';
const LEGACY = '### Legacy (pre-fragments)';

export function validateFragment(path, content) {
  if (!FRAGMENT_NAME.test(path)) throw new Error(path + ': invalid fragment filename');
  if (typeof content !== 'string' || content.includes('\uFFFD') || content.includes('\0'))
    throw new Error(path + ': invalid UTF-8 content');
  const lines = content.replace(/\r\n/g, '\n').trim().split('\n');
  if (!/^### (Added|Changed|Fixed|Removed)$/.test(lines[0]) ||
      lines.filter(x => x.startsWith('### ')).length !== 1 ||
      !lines.slice(1).some(x => x.startsWith('- ') && x.slice(2).trim()))
    throw new Error(path + ': expected one category heading and at least one bullet');
  if (lines.slice(1).some(x => x.startsWith('## ') || x.startsWith('### ')))
    throw new Error(path + ': unexpected heading');
  return lines.join('\n');
}

/**
 * A release change edits CHANGELOG.md and otherwise only deletes the fragments it consumed.
 * entries: lines of `git diff --name-status` ("M\tCHANGELOG.md", "D\tchanges/2-x.md").
 */
export function isReleaseChange(entries) {
  const parsed = entries.map(line => line.split('\t')).map(cols => ({ status: cols[0], path: cols.at(-1) }));
  return parsed.some(e => e.status === 'M' && e.path === 'CHANGELOG.md') &&
    parsed.every(e => (e.status === 'M' && e.path === 'CHANGELOG.md') ||
      (e.status === 'D' && FRAGMENT_NAME.test(e.path)));
}

export function validateFragments(fragments) {
  return Object.entries(fragments).map(([path, content]) => ({
    path, number: Number(FRAGMENT_NAME.exec(path)?.[1]), content: validateFragment(path, content),
  })).sort((a, b) => a.number - b.number || a.path.localeCompare(b.path, 'en'));
}

// Fragment notes live between the markers. Text before or after them is operator-owned
// (legacy notes, a manual ### Breaking section) and survives every assembly. The start marker
// records a digest of the block it wrote: an untouched block regenerates freely when fragments change.
const START = '<!-- generated changelog fragments';
const START_LINE = /<!-- generated changelog fragments(?: sha256:([0-9a-f]{64}))? -->/;
const digest = text => createHash('sha256').update(text).digest('hex');
const END = '<!-- end generated changelog fragments -->';

function splitUnreleased(existing, notes) {
  const marker = START_LINE.exec(existing);
  const at = marker ? marker.index : -1;
  if (at < 0) {
    const legacy = existing.trim();
    return { before: !legacy || legacy.includes(LEGACY) ? legacy : LEGACY + '\n\n' + legacy, after: '' };
  }
  const rest = existing.slice(at + marker[0].length);
  const end = rest.indexOf(END);
  if (end < 0) throw new Error('CHANGELOG.md: missing ' + END + '; notes after the generated block would be lost');
  const block = rest.slice(0, end).trim();
  const rendered = new Set(notes.split('\n').map(x => x.trim()));
  // A block that no longer matches its digest was edited by hand: keep only lines a fragment still produces.
  const foreign = marker[1] === digest(block) ? [] :
    block.split('\n').map(x => x.trim()).filter(x => x && !rendered.has(x));
  if (foreign.length) throw new Error('CHANGELOG.md: line not from a fragment inside the generated block: "' +
    foreign[0] + '"; move manual notes outside the markers or into changes/');
  return { before: existing.slice(0, at).trim(), after: rest.slice(end + END.length).trim() };
}

export function assembleChangelog(changelog, fragments) {
  const start = changelog.indexOf(HEADER);
  if (start < 0) throw new Error('CHANGELOG.md: missing ## [Unreleased]');
  const from = start + HEADER.length;
  const after = changelog.slice(from);
  const match = /^## \[[^\n]+\]/m.exec(after);
  const released = match ? after.slice(match.index) : '';
  const existing = match ? after.slice(0, match.index) : after;
  const notes = validateFragments(fragments).map(f => f.content).join('\n\n');
  const kept = splitUnreleased(existing, notes);
  const rendered = [kept.before, START + ' sha256:' + digest(notes) + ' -->', notes, END, kept.after].filter(Boolean).join('\n\n');
  return changelog.slice(0, start) + HEADER + '\n\n' + rendered + '\n\n' + released;
}

export function rolloverChangelog(changelog, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('Release requires semver and YYYY-MM-DD');
  const heading = '## [' + version + '] - ' + date;
  if (new RegExp('^## \\[' + version.replace(/\./g, '\\.') + '\\]', 'm').test(changelog))
    throw new Error('Release already exists: ' + version);
  const start = changelog.indexOf(HEADER);
  if (start < 0) throw new Error('Missing Unreleased');
  const next = changelog.slice(start + HEADER.length).search(/^## \[[^\n]+\]/m);
  const split = next < 0 ? changelog.length : start + HEADER.length + next;
  const notes = changelog.slice(start + HEADER.length, split)
    .replace(START_LINE, '').replace(END, '').replace(/\n{3,}/g, '\n\n').trim();
  return changelog.slice(0, start) + HEADER + '\n\n' + heading + '\n\n' + notes + '\n\n' + changelog.slice(split);
}
