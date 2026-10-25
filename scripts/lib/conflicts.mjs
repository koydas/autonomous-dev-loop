// Auto conflicts-fix, pure part (ADR-0058): classification of a PR's mergeability, the circuit breaker's
// signature and marker, conflict-marker parsing, the resolver allowlist and the post-checks of a model
// resolution, ADR renumbering. No I/O, no LLM: scripts/conflicts_fix.mjs and scripts/detect_conflicts.mjs
// own both. Conflict hunks are data, never interpolated into a command and never logged.
import { createHash } from 'node:crypto';
import { normalizeRepoPath } from './autofix_guard.mjs';

/** Conflict-fix attempts per conflicting state of a PR; the review budget (auto-fix-attempt-N) is separate. */
export const MAX_CONFLICT_ATTEMPTS = 2;
/** Files the model resolves in one run; more is escalated. */
export const MAX_MODEL_FILES = 3;
/** Same conflict signature in consecutive runs at which the breaker opens (ADR-0050 shape). */
export const CONFLICT_BREAKER_THRESHOLD = 2;

const ADR_PATH_RE = /^docs\/adr\/(\d{4})-[^/]+\.md$/;
const ADR_INDEX = 'docs/adr/README.md';
const CHANGELOG = 'CHANGELOG.md';
const LOCKFILE = 'package-lock.json';
const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * What a pull request's mergeability says (REST `pulls/{n}`). `dirty` is a conflict; `mergeable: null` /
 * `unknown` is not computed yet and is never read as clean nor as conflicting.
 * @returns {'conflicting' | 'clean' | 'unknown' | 'closed'}
 */
export function classifyMergeability(pr) {
  if (!pr || pr.state === 'closed' || pr.merged === true) return 'closed';
  if (pr.mergeable_state === 'dirty' || pr.mergeable === false) return 'conflicting';
  if (pr.mergeable === null || pr.mergeable === undefined || pr.mergeable_state === 'unknown') return 'unknown';
  return 'clean';
}

/** Whether the pipeline can push to the PR's head branch: same repository, or a fork that allows maintainers to. */
export function canPushToHead(pr, repository) {
  const headRepo = pr?.head?.repo?.full_name;
  if (!headRepo) return false; // the fork was deleted
  if (headRepo.toLowerCase() === String(repository).toLowerCase()) return true;
  return pr.maintainer_can_modify === true;
}

/**
 * Fingerprint of a conflict: the conflicted files and the incoming (base) side of their hunks. The base moving on
 * to unrelated commits does not change it; the same hunks conflicting again do not either. null: nothing to compare.
 * @param {{ path: string, theirs: string }[]} conflicts
 */
export function conflictSignature(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return null;
  const items = conflicts
    .map(({ path, theirs }) => [normalizeRepoPath(path), createHash('sha256').update(String(theirs ?? '')).digest('hex').slice(0, 16)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 10);
}

/** Hidden marker ending a comment of this stage: the head it acted on, the outcome and the conflict signature. */
export function formatConflictMarker({ sha, outcome, sig = null, streak = 1 } = {}) {
  if (!SHA_RE.test(String(sha))) throw new Error(`Invalid conflict marker sha: ${sha}`);
  if (!['detected', 'resolved', 'escalated'].includes(outcome)) throw new Error(`Invalid conflict marker outcome: ${outcome}`);
  const sigPart = /^[0-9a-f]{10}$/.test(String(sig)) ? ` sig=${sig} streak=${Math.min(Math.max(1, streak | 0), 99)}` : '';
  return `<!-- adl-conflicts head=${sha} outcome=${outcome}${sigPart} -->`;
}

const MARKER_RE = /<!-- adl-conflicts head=([0-9a-f]{7,64}) outcome=(detected|resolved|escalated)(?: sig=([0-9a-f]{10}) streak=(\d{1,2}))? -->\s*$/;
const TRUSTED_BOT_LOGIN = 'github-actions[bot]';
const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** `{ sha, outcome, sig, streak }` from a comment body (anchored at its end), or null. */
export function parseConflictMarker(body) {
  const m = typeof body === 'string' ? body.match(MARKER_RE) : null;
  return m ? { sha: m[1], outcome: m[2], sig: m[3] ?? null, streak: m[4] ? Number(m[4]) : 1 } : null;
}

/** The newest marker of a trusted author (the Actions bot, or a member: AI_PR_TOKEN is a member's PAT). Comments are oldest first. */
export function latestConflictMarker(comments) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c?.user?.login !== TRUSTED_BOT_LOGIN && !TRUSTED_ASSOCIATIONS.includes(c?.author_association)) continue;
    const marker = parseConflictMarker(c?.body);
    if (marker) return marker;
  }
  return null;
}

/** Streak of consecutive runs reporting the same signature after this run. */
export function nextConflictStreak(previous, sig) {
  if (sig && previous?.sig === sig && previous.outcome === 'escalated') return (previous.streak ?? 1) + 1;
  return 1;
}

/**
 * Whether a run starts. `attempts` counts the conflict-fix-attempt labels; `previous` is the newest marker.
 * A manual dispatch bypasses the breaker and the cap for one run, as a rerun of auto-fix does.
 * @returns {{ run: true } | { run: false, reason: 'attempts_exhausted' | 'circuit_open' }}
 */
export function decideConflictRun({ attempts, previous, sig, manual = false }) {
  if (manual) return { run: true };
  if (attempts >= MAX_CONFLICT_ATTEMPTS) return { run: false, reason: 'attempts_exhausted' };
  if (sig && previous?.outcome === 'escalated' && previous.sig === sig && (previous.streak ?? 1) >= CONFLICT_BREAKER_THRESHOLD) {
    return { run: false, reason: 'circuit_open' };
  }
  return { run: true };
}

// ── conflict markers ────────────────────────────────────────────────────────────────────────────────

const START_RE = /^<{7}(?: .*)?$/;
const BASE_RE = /^\|{7}(?: .*)?$/;
const MID_RE = /^={7}$/;
const END_RE = /^>{7}(?: .*)?$/;
const bare = (line) => line.replace(/\r?\n$/, '');
// Lines keep their terminator, so a splice never changes anything outside a conflict block.
const rawLines = (content) => String(content).split(/(?<=\n)/).filter((l) => l !== '');

/**
 * Splits a file with conflict markers (merge.conflictStyle merge or diff3) into text and conflict segments.
 * `ours` is the PR side, `theirs` the incoming base side, `base` the common ancestor ('' without diff3);
 * each side keeps its line terminators. Throws on a malformed or nested marker block: the file is then
 * escalated, never guessed at.
 * @returns {({ type: 'text', text: string } | { type: 'conflict', ours: string, base: string, theirs: string })[]}
 */
export function parseConflicts(content) {
  const lines = rawLines(content);
  const segments = [];
  let text = [];
  let i = 0;
  while (i < lines.length) {
    if (!START_RE.test(bare(lines[i]))) { text.push(lines[i++]); continue; }
    const ours = []; const base = []; const theirs = [];
    let part = ours;
    let closed = false;
    for (i += 1; i < lines.length; i++) {
      const line = bare(lines[i]);
      if (START_RE.test(line)) throw new Error('nested conflict marker');
      if (BASE_RE.test(line) && part === ours) { part = base; continue; }
      if (MID_RE.test(line) && part !== theirs) { part = theirs; continue; }
      if (END_RE.test(line) && part === theirs) { closed = true; i += 1; break; }
      part.push(lines[i]);
    }
    if (!closed) throw new Error('unterminated conflict marker');
    if (text.length) segments.push({ type: 'text', text: text.join('') });
    text = [];
    segments.push({ type: 'conflict', ours: ours.join(''), base: base.join(''), theirs: theirs.join('') });
  }
  if (text.length) segments.push({ type: 'text', text: text.join('') });
  return segments;
}

/** The conflict segments only. */
export const conflictsOf = (segments) => segments.filter((s) => s.type === 'conflict');

/**
 * Whether a line of the text opens or closes a conflict block. The bare `=======` and `|||||||` lines are not
 * counted on their own: a Markdown setext heading is made of them, and a real block always has its two ends.
 */
export function hasConflictMarkers(content) {
  return rawLines(content).map(bare).some((l) => START_RE.test(l) || END_RE.test(l));
}

/**
 * Splices the resolved hunks into the file, in order; nothing outside the conflict blocks changes.
 * @param {string[]} resolutions one string per conflict segment ('' deletes the hunk)
 */
export function applyResolutions(segments, resolutions) {
  const count = conflictsOf(segments).length;
  if (resolutions.length !== count) throw new Error(`expected ${count} resolutions, got ${resolutions.length}`);
  let next = 0;
  return segments.map((s) => {
    if (s.type === 'text') return s.text;
    const resolved = String(resolutions[next++]);
    return resolved === '' || resolved.endsWith('\n') ? resolved : `${resolved}\n`;
  }).join('');
}

// ── resolver allowlist (ADR-0058 §F) ──────────────────────────────────────────────────────────────

/**
 * How a conflicted path is resolved: the ladder rung and, for the model, the resolver that post-checks it.
 * Paths the model must never write (ADR-0021) go to the model only through a named allowlist entry;
 * every other protected path is escalated. `protectedEntry` is `protectedPathEntry(path)`.
 * @returns {{ rung: 'L1' | 'L2' | 'L3', resolver?: 'lockfile' | 'changelog' | 'adr_index' | 'adr' | 'generic', reason?: string }}
 */
export function planFile(path, protectedEntry) {
  const p = normalizeRepoPath(path);
  if (p === LOCKFILE) return { rung: 'L1', resolver: 'lockfile' };
  if (p === CHANGELOG) return { rung: 'L2', resolver: 'changelog' };
  if (p === ADR_INDEX) return { rung: 'L2', resolver: 'adr_index' };
  if (ADR_PATH_RE.test(p)) return { rung: 'L2', resolver: 'adr' };
  if (protectedEntry) return { rung: 'L3', reason: 'protected_path' };
  return { rung: 'L2', resolver: 'generic' };
}

const nonBlank = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean);
const topBullets = (text) => String(text).split('\n').filter((l) => /^- \S/.test(l)).map((l) => l.trimEnd());

/** Lines of `resolved` found in none of the three sides (whitespace-trimmed, blank lines ignored). */
export function inventedLines(resolved, { ours, base = '', theirs }) {
  const known = new Set([...nonBlank(ours), ...nonBlank(base), ...nonBlank(theirs)]);
  return nonBlank(resolved).filter((l) => !known.has(l));
}

/** Share of invented lines tolerated in a generic (code) resolution: a merged import line is legitimate. */
export const GENERIC_INVENTED_RATIO = 0.25;
export const GENERIC_INVENTED_FREE = 3;

/**
 * Post-check of one model-resolved hunk. Returns the violated rules (empty: accepted).
 *  - every resolver: no marker left;
 *  - changelog / adr_index: nothing invented, and every top-level bullet (or index line) of both sides kept;
 *  - adr: nothing invented (the model only merges; the renumber is mechanical);
 *  - generic: invented lines bounded.
 */
export function checkHunkResolution(resolver, { ours, base = '', theirs }, resolved) {
  const violations = [];
  if (hasConflictMarkers(resolved)) violations.push('marker_left');
  const invented = inventedLines(resolved, { ours, base, theirs });
  if (resolver === 'generic') {
    const total = nonBlank(resolved).length;
    if (invented.length > Math.max(GENERIC_INVENTED_FREE, Math.floor(total * GENERIC_INVENTED_RATIO))) violations.push('invented_content');
    return violations;
  }
  if (invented.length > 0) violations.push('invented_content');
  if (resolver === 'changelog') {
    const kept = new Set(String(resolved).split('\n').map((l) => l.trimEnd()));
    if (![...topBullets(ours), ...topBullets(theirs)].every((b) => kept.has(b))) violations.push('entry_dropped');
  } else if (resolver === 'adr_index') {
    const kept = new Set(nonBlank(resolved));
    if (![...nonBlank(ours), ...nonBlank(theirs)].every((l) => kept.has(l))) violations.push('entry_dropped');
  }
  return violations;
}

// ── ADR renumbering (mechanical, ADR-0058 §E) ─────────────────────────────────────────────────────

/** ADR number of a repo path (`docs/adr/0058-x.md` → 58), or null. */
export function adrNumber(path) {
  const m = ADR_PATH_RE.exec(normalizeRepoPath(path));
  return m ? Number(m[1]) : null;
}

const pad = (n) => String(n).padStart(4, '0');

/**
 * ADRs the PR adds whose number the merged tree gives to another file. The base keeps its number (it is merged);
 * the PR's ADR takes the next free one, in file order.
 * @param {string[]} treePaths  every path of the merge result
 * @param {string[]} addedPaths ADR paths the PR adds (merge-base → head)
 * @returns {{ from: string, to: string, fromPath: string, toPath: string }[]}
 */
export function planAdrRenumber(treePaths, addedPaths) {
  const adrs = treePaths.map(normalizeRepoPath).filter((p) => ADR_PATH_RE.test(p));
  const added = new Set(addedPaths.map(normalizeRepoPath).filter((p) => ADR_PATH_RE.test(p)));
  const baseNumbers = new Set(adrs.filter((p) => !added.has(p)).map(adrNumber));
  let next = Math.max(0, ...adrs.map(adrNumber)) + 1;
  const plan = [];
  for (const fromPath of [...added].filter((p) => adrs.includes(p)).sort()) {
    const n = adrNumber(fromPath);
    if (!baseNumbers.has(n)) continue;
    const to = pad(next++);
    plan.push({ from: pad(n), to, fromPath, toPath: fromPath.replace(`docs/adr/${pad(n)}-`, `docs/adr/${to}-`) });
  }
  return plan;
}

/**
 * Rewrites `ADR-<from>` and `/<from>-` link targets to `<to>` on the lines the PR itself added (exact match),
 * so references to the base's own ADR of that number elsewhere in the file are left alone.
 * @param {string} content merged file
 * @param {Set<string>} addedLines lines the PR added to this file (merge-base → head)
 */
export function renumberReferences(content, addedLines, { from, to }) {
  const rewrite = (line) => line.replaceAll(`ADR-${from}`, `ADR-${to}`).replace(new RegExp(`(/|\\./)${from}-`, 'g'), `$1${to}-`);
  return String(content).split('\n').map((line) => (addedLines.has(line) && (line.includes(`ADR-${from}`) || line.includes(`${from}-`)) ? rewrite(line) : line)).join('\n');
}

/** Whole-file renumber of the PR's own ADR (title, self references). */
export function renumberOwnAdr(content, { from, to }) {
  return String(content).replaceAll(`ADR-${from}`, `ADR-${to}`);
}

/** Lines present in `after` and absent from `before` (multiset difference), as a Set for exact-line matching. */
export function addedLinesOf(before, after) {
  const remaining = new Map();
  for (const l of String(before ?? '').split('\n')) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const added = new Set();
  for (const l of String(after ?? '').split('\n')) {
    const n = remaining.get(l) ?? 0;
    if (n > 0) remaining.set(l, n - 1);
    else if (l.trim()) added.add(l);
  }
  return added;
}

export const CONFLICT_ESCALATION_REASONS = Object.freeze([
  'protected_path', 'unsupported_conflict', 'binary_file', 'too_many_files', 'too_large', 'parse_failed', 'guard_rejected',
  'model_rejected', 'syntax_error', 'lockfile_failed', 'lockfile_unsafe', 'push_failed', 'fork_not_writable',
  'attempts_exhausted', 'circuit_open', 'workflow_scope',
]);
