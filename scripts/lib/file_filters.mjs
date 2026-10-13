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

  return truncateContextLines(filtered || rawDiff, maxContextLineChars).slice(0, maxChars);
}
