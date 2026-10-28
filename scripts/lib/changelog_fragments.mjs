/**
 * Deterministic changelog fragments. Pure render/validate operations.
 * Only the release operator writes the root changelog.
 */
export const FRAGMENT_NAME = /^changes\/([1-9]\d*)\.md$/;
const CATEGORIES = new Set(['Added', 'Changed', 'Fixed', 'Removed']);
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

export function validateFragments(fragments) {
  return Object.entries(fragments).map(([path, content]) => ({
    path, number: Number(FRAGMENT_NAME.exec(path)?.[1]), content: validateFragment(path, content),
  })).sort((a, b) => a.number - b.number);
}

export function assembleChangelog(changelog, fragments) {
  const start = changelog.indexOf(HEADER);
  if (start < 0) throw new Error('CHANGELOG.md: missing ## [Unreleased]');
  const from = start + HEADER.length;
  const after = changelog.slice(from);
  const match = /^## \[[^\n]+\]/m.exec(after);
  const released = match ? after.slice(match.index) : '';
  const existing = match ? after.slice(0, match.index) : after;
  // Markers make subsequent assemblies idempotent and preserve migrated notes.
  const marker = '<!-- generated changelog fragments -->';
  const legacy = existing.split(marker)[0].trim();
  const notes = validateFragments(fragments).map(f => f.content).join('\n\n');
  const retained = legacy ? (legacy.includes(LEGACY) ? legacy : LEGACY + '\n\n' + legacy) : '';
  const rendered = [retained, marker, notes].filter(Boolean).join('\n\n');
  return changelog.slice(0, start) + HEADER + '\n\n' + rendered + '\n\n' + released;
}

export function rolloverChangelog(changelog, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('Release requires semver and YYYY-MM-DD');
  const heading = '## [' + version + '] - ' + date;
  if (changelog.includes(heading)) throw new Error('Release already exists: ' + version);
  const start = changelog.indexOf(HEADER);
  if (start < 0) throw new Error('Missing Unreleased');
  const next = changelog.slice(start + HEADER.length).search(/^## \[[^\n]+\]/m);
  const split = next < 0 ? changelog.length : start + HEADER.length + next;
  const notes = changelog.slice(start + HEADER.length, split)
    .replace('<!-- generated changelog fragments -->', '').trim();
  return changelog.slice(0, start) + HEADER + '\n\n' + heading + '\n\n' + notes + '\n\n' + changelog.slice(split);
}
