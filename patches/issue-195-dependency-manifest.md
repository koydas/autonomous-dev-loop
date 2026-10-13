# Issue #195: do not follow a symlinked package.json (handoff note)

Automated patch generation could not apply this fix. Every file it must touch is out of reach:

- `scripts/lib/dependency_manifest.mjs` and `scripts/tests/*` are under the protected `scripts/` path. One protected target rejects the whole generated patch.
- `scripts/pr_review.mjs`, `scripts/tests/pr_review.test.mjs` and `CHANGELOG.md` were withheld from the generation context, so they cannot be edited safely.

This note is not wired into the pipeline and changes no behavior. Below is the change a maintainer should apply by hand.

## 1. `scripts/lib/dependency_manifest.mjs`

The exported signature stays `readPackageJsonDependencies(repoRoot)`, returning `Promise<object|null>`.

The guard follows ADR-0023:

1. `lstat` the `package.json` path component.
2. Treat anything that is not a regular file (symlink, directory, FIFO, device) as missing.
3. Open with `O_NOFOLLOW | O_NONBLOCK` and re-check with `fstat`. This closes the lstat/open race and prevents a FIFO hang.

Replace the `fs.readFile` block with:

    const pkgPath = path.join(absRepoRoot, 'package.json');
    let st;
    try {
      st = await fs.lstat(pkgPath);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
      warnNotRegular(pkgPath, err?.code ?? 'lstat_failed');
      return null;
    }
    if (!st.isFile()) {
      warnNotRegular(pkgPath, st.isSymbolicLink() ? 'symlink' : 'not_regular_file');
      return null;
    }
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fsConstants;
    let handle;
    let raw;
    try {
      handle = await fs.open(pkgPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const fst = await handle.stat();
      if (!fst.isFile()) {
        warnNotRegular(pkgPath, 'not_regular_file');
        return null;
      }
      raw = await handle.readFile('utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      warnNotRegular(pkgPath, err?.code ?? 'open_failed');
      return null;
    } finally {
      await handle?.close();
    }

Add these imports:

    import { constants as fsConstants } from 'node:fs';

Also import the existing warn helper from `./observability.mjs`. Its exact export name was not visible in the generation context, so use the one already used by #190 / #194.

Then define `warnNotRegular(filePath, reason)`. It must emit exactly one `warn` event, for example `dependency_manifest.package_json_skipped`, with `{ path: 'package.json', reason }`.

The repo root itself comes from the runner (`process.cwd()`), so `package.json` is the only path component inside the PR tree.

Callers need no change: `buildDependencyManifestContext` already maps `null` to `''`. The generation and auto-fix callers inherit the fix through this function.

## 2. `scripts/tests/dependency_manifest.test.mjs` (add cases; keep existing ones)

Create a fresh `fs.mkdtemp` tree for each case:

- **Regular file:** `package.json` with `{"dependencies":{"a":"1"}}`. Expect `{ a: '1' }` (no regression).
- **Symlink to a file outside the tree:** an outside dir holds a valid `package.json` with `{"dependencies":{"leak":"1"}}`, and the tree has `fs.symlink(outsideFile, tree/package.json)`. Expect `null`, and `leak` must never appear.
- **Symlink to a directory:** `fs.symlink(someDir, tree/package.json)`. Expect `null` and no throw (the old code threw `EISDIR`).
- **Directory named package.json:** `fs.mkdir(tree/package.json)`. Expect `null`.
- **FIFO (POSIX only, skip on win32):** create it with `child_process.execFileSync('mkfifo', [p])`. Expect `null`, resolved without hanging; use the test `timeout` option as a guard.
- **Missing file:** expect `null`.

## 3. `scripts/tests/pr_review.test.mjs`

Add one entrypoint case using the `makePrTree` fixture from #194:

- Replace the tree's `package.json` with a symlink to a directory.
- Assert the review completes: the LLM mock is called and a verdict is posted.
- Assert one warn event is logged.

## 4. `CHANGELOG.md`

Add under Unreleased / Fixed:

> `pr_review`, generation and auto-fix no longer follow a symlinked or non-regular `package.json` from the PR tree; it is treated as missing (#195, ADR-0023).

## Verification

Run:

    node --test scripts/tests/*.test.mjs
    npm run lint
