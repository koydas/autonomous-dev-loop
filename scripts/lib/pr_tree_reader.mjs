import fs from 'node:fs';
import path from 'node:path';

// ADR-0023: the repo root comes from the runner, everything under it may come from a PR and is never
// followed. One reader for every PR-tree consumer (review, auto-fix, dependency manifest; F02/F22 of
// the 2026-10-19 audit): component-wise lstat, an O_NOFOLLOW | O_NONBLOCK open re-checked with fstat,
// and a size bound checked before any byte is read.

/** Default bound for a PR-tree read when the consumer has no tighter limit of its own. */
export const PR_TREE_MAX_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const outside = { kind: 'other', reason: 'outside_tree' };
const symlink = { kind: 'other', reason: 'symlink' };
const notRegular = { kind: 'other', reason: 'not_regular_file' };

/**
 * Kind of a PR-tree path without opening it. Every component is lstat'ed: a single lstat of the full
 * path would follow a symlinked parent (config -> /etc).
 * `relPath` must be relative and stay inside `repoRoot` after normalization.
 * @returns {{ kind: 'file', size: number } | { kind: 'missing' } | { kind: 'other', reason: 'outside_tree'|'symlink'|'not_regular_file' }}
 *   Throws on any lstat error other than ENOENT / ENOTDIR.
 */
export function lstatPrTreePath(repoRoot, relPath) {
  if (typeof relPath !== 'string' || relPath === '' || path.isAbsolute(relPath)) return outside;
  const normalized = path.normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return outside;
  if (normalized === '.' || normalized === `.${path.sep}`) return notRegular;
  const parts = normalized.split(path.sep).filter(Boolean);
  let full = path.resolve(repoRoot);
  let st;
  for (const [i, part] of parts.entries()) {
    full = path.join(full, part);
    try {
      st = fs.lstatSync(full);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { kind: 'missing' };
      throw err;
    }
    if (st.isSymbolicLink()) return symlink;
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return notRegular;
  }
  return { kind: 'file', size: st.size };
}

/**
 * Reads a regular PR-tree file, never following a symlink and never reading more than `maxBytes` + 1.
 * The lstat → open race (a symlink or FIFO swapped in between) is closed by O_NOFOLLOW (where the
 * platform has it), O_NONBLOCK (a FIFO open never blocks) and an fstat re-check on the descriptor.
 * @param {string} repoRoot runner-provided root
 * @param {string} relPath repo-relative path (PR data)
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ kind: 'file', content: string } | { kind: 'missing' } |
 *   { kind: 'other', reason: 'outside_tree'|'symlink'|'not_regular_file' } | { kind: 'too_large', size: number }}
 *   `too_large.size` is the fstat size, or the bytes seen when the file grew past `maxBytes` during the read.
 *   Throws on any other filesystem error (EACCES, EIO, …).
 */
export function readPrTreeFile(repoRoot, relPath, { maxBytes = PR_TREE_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError(`maxBytes must be a non-negative integer, got ${maxBytes}`);
  const kind = lstatPrTreePath(repoRoot, relPath);
  if (kind.kind !== 'file') return kind;
  if (kind.size > maxBytes) return { kind: 'too_large', size: kind.size };

  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(path.join(path.resolve(repoRoot), path.normalize(relPath)), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if (err?.code === 'ENOENT') return { kind: 'missing' };
    if (err?.code === 'ELOOP') return symlink;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return notRegular;
    if (st.size > maxBytes) return { kind: 'too_large', size: st.size };
    // Chunked until EOF: the fstat size is only a hint (the file may grow), maxBytes + 1 is the bound.
    const chunk = Buffer.alloc(Math.min(maxBytes + 1, READ_CHUNK_BYTES));
    const chunks = [];
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return { kind: 'too_large', size: Math.max(st.size, total) };
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return { kind: 'file', content: Buffer.concat(chunks, total).toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}
