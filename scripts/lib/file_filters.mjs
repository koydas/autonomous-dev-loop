const IGNORED_PATHS = /(\/|^)(node_modules|dist)\//;
const LOCK_FILES =
  /(package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb|Cargo\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock)$/;

export function shouldIncludeFile(filePath) {
  return !!filePath && !IGNORED_PATHS.test(filePath) && !LOCK_FILES.test(filePath);
}

export function filterDiff(rawDiff, maxChars = 12000) {
  const filtered = rawDiff
    .split('\ndiff --git ')
    .map((chunk, i) => (i ? `diff --git ${chunk}` : chunk))
    .filter((chunk) => {
      const match = chunk.match(/^diff --git a\/(.+?) b\//m);
      return shouldIncludeFile(match?.[1] || '');
    })
    .join('\n');

  return (filtered || rawDiff).slice(0, maxChars);
}
