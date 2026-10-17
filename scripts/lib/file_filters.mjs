const IGNORED_PATHS = /(\/|^)(node_modules|dist)\//;
const LOCK_FILES =
  /(package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb|Cargo\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock)$/;

export function shouldIncludeFile(filePath) {
  return !!filePath && !IGNORED_PATHS.test(filePath) && !LOCK_FILES.test(filePath);
}

// Unchanged context lines (` ` prefix inside a hunk) carry no review signal past their first
// chars; a single CHANGELOG entry can be 1–2k chars and push real hunks past `maxChars`.
// Cut them with a visible marker before the cap. `+`/`-` lines and all headers are never touched.
export function truncateContextLines(diff, maxLineChars = 200) {
  let inHunk = false;
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) inHunk = false;
      else if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && line.startsWith(' ') && line.length > maxLineChars) {
        const cut = `${line.slice(0, maxLineChars)} …[+${line.length - maxLineChars} chars]`;
        if (cut.length < line.length) return cut;
      }
      return line;
    })
    .join('\n');
}

export function filterDiff(rawDiff, maxChars = 12000, maxContextLineChars = 200) {
  const filtered = rawDiff
    .split('\ndiff --git ')
    .map((chunk, i) => (i ? `diff --git ${chunk}` : chunk))
    .filter((chunk) => {
      const match = chunk.match(/^diff --git a\/(.+?) b\//m);
      return shouldIncludeFile(match?.[1] || '');
    })
    .join('\n');

  return cutDiffAtBoundary(truncateContextLines(filtered || rawDiff, maxContextLineChars), maxChars);
}

// A diff cut to a budget ends on a whole line, never inside one (#219: `- name:` cut to `- n` read as
// broken YAML), and never on a file or hunk header with no line under it. A hunk boundary is
// preferred while it keeps at least HUNK_CUT_MIN_RATIO of what a line boundary would keep; below
// that, one huge hunk would hide most of the budget, so the cut falls between two lines of it.
// The marker line names what was left out, so the reviewer knows where the content stops.
export const DIFF_CUT_MARKER_PREFIX = '… [diff cut: ';
const HUNK_CUT_MIN_RATIO = 0.5;
const MARKER_MAX_FILES = 5;

// 'meta' = a file header line (`diff --git` up to its first `@@`), 'hunk' = an `@@` line, 'body' = the rest.
// A cut may end after a body line, or after a whole header block with no hunk (binary file, rename, mode).
function lineKinds(lines) {
  let inMeta = false;
  return lines.map((line) => {
    if (line.startsWith('diff --git ')) inMeta = true;
    else if (line.startsWith('@@')) {
      inMeta = false;
      return 'hunk';
    }
    return inMeta ? 'meta' : 'body';
  });
}

function formatCutMarker(omittedLines, files) {
  const shown = files.slice(0, MARKER_MAX_FILES).map((f) => (f.partly ? `${f.path} (partly shown)` : f.path));
  if (files.length > MARKER_MAX_FILES) shown.push(`${files.length - MARKER_MAX_FILES} more files`);
  const where = shown.length ? `, in ${shown.join(', ')}` : '';
  return `${DIFF_CUT_MARKER_PREFIX}${omittedLines} more line${omittedLines === 1 ? '' : 's'} not shown${where}]`;
}

/**
 * Cuts `diff` to at most `maxChars` on a line boundary (preferably a hunk boundary) and appends a
 * `… [diff cut: N more lines not shown, in <files>]` line. Returns `diff` unchanged when it fits,
 * and '' when not even the marker fits.
 * @returns {string}
 */
export function cutDiffAtBoundary(diff, maxChars) {
  const text = String(diff ?? '');
  if (text.length <= maxChars) return text;
  const lines = text.replace(/\n$/, '').split('\n');
  const kinds = lineKinds(lines);
  const files = [];
  lines.forEach((line, i) => {
    const path = line.startsWith('diff --git ') && line.match(/^diff --git a\/(.+?) b\//)?.[1];
    if (path) files.push({ path, start: i });
  });
  // prefixLength[k]: length of the first k lines joined by '\n'.
  const prefixLength = [0];
  for (const line of lines) prefixLength.push(prefixLength.length === 1 ? line.length : prefixLength.at(-1) + 1 + line.length);
  const markerAt = (k) => formatCutMarker(lines.length - k, files
    .filter((f, i) => (i + 1 < files.length ? files[i + 1].start : lines.length) > k)
    .map((f) => ({ path: f.path, partly: f.start < k })));
  let lineCut = null;
  let hunkCut = null;
  const endsWhole = (k) => k === 0 || kinds[k - 1] === 'body' || (kinds[k - 1] === 'meta' && lines[k].startsWith('diff --git '));
  for (let k = lines.length - 1; k >= 0 && hunkCut == null; k--) {
    if (!endsWhole(k) || prefixLength[k] >= maxChars) continue;
    const marker = markerAt(k);
    if ((k > 0 ? prefixLength[k] + 1 : 0) + marker.length > maxChars) continue;
    lineCut ??= { k, marker };
    if (k === 0 || kinds[k] !== 'body') hunkCut = { k, marker };
  }
  if (!lineCut) return '';
  const { k, marker } = hunkCut && prefixLength[hunkCut.k] >= prefixLength[lineCut.k] * HUNK_CUT_MIN_RATIO ? hunkCut : lineCut;
  return k === 0 ? marker : `${lines.slice(0, k).join('\n')}\n${marker}`;
}

/** `diff` without the trailing marker line cutDiffAtBoundary appends: the shown prefix of the uncut diff. */
export function stripDiffCutMarker(diff) {
  const text = String(diff ?? '');
  const at = text.lastIndexOf(DIFF_CUT_MARKER_PREFIX);
  if (at < 0 || (at > 0 && text[at - 1] !== '\n') || text.indexOf('\n', at) !== -1) return text;
  return text.slice(0, Math.max(0, at - 1));
}
