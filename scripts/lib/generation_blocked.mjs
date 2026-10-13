import path from 'node:path';
import { extractFilePaths } from './file_injector.mjs';
import { protectedPathEntry } from './output_writer.mjs';
import { normalizeRepoPath } from './autofix_guard.mjs';

// "Blocked" outcome of code generation (ADR-0029 amendment). When the issue cannot be implemented,
// the stage opens no PR: #191 (issue #190) and #196 (issue #195) each opened a PR holding only a
// markdown handoff note, the review bot approved it, and merging it would have closed the issue.
// Pure except for the GitHub calls of `escalateBlocked`, which go through the injected `request`.

export const BLOCKED_SOURCES = Object.freeze({
  DENYLIST: 'denylist',
  MODEL: 'model',
  NOTES_ONLY: 'notes_only',
});

// Issue labels that ask for a code change: a patch made only of new notes cannot implement them.
export const CODE_CHANGE_LABELS = Object.freeze(['bug', 'feature']);

// Files an issue names alongside the real change (changelog gate) that never implement it alone.
const COMPANION_FILES = new Set(['changelog.md', 'changelog']);
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const NOTE_FILE_PATTERN = /\.(?:md|markdown)$/i;
const MAX_TEXT_CHARS = 4000;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const cap = (value) => (value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}\n…(truncated)` : value);

/**
 * Repo paths the issue says the change needs. URLs are dropped first (`…/autonomous-dev-loop/pull/188`
 * would read as a path). A bare file name counts only when it exists at the repository root and is
 * not the base name of a path the issue also names; `CHANGELOG.md` is a companion, never the change.
 */
export function findNeededPaths(issueTitle, issueBody, { fileExists = () => false } = {}) {
  const candidates = extractFilePaths(String(issueTitle ?? '').replace(URL_PATTERN, ' '), String(issueBody ?? '').replace(URL_PATTERN, ' '))
    .map(normalizeRepoPath);
  const named = new Set(candidates.filter((p) => p.includes('/')).map((p) => path.posix.basename(p).toLowerCase()));
  const needed = candidates.filter((p) => {
    const base = path.posix.basename(p).toLowerCase();
    if (COMPANION_FILES.has(base) && !p.includes('/')) return false;
    if (p.includes('/')) return true;
    return !named.has(base) && fileExists(p);
  });
  return [...new Set(needed)];
}

/**
 * Deterministic check, before the LLM call: every path the issue needs is protected (ADR-0021) or
 * was withheld from the prompt (ADR-0029). null when the issue names no path or any path is writable.
 * @returns {{ paths: { path: string, why: string }[] } | null}
 */
export function findDeterministicBlock({ issueTitle, issueBody, hiddenPaths = new Set(), fileExists = () => false }) {
  const needed = findNeededPaths(issueTitle, issueBody, { fileExists });
  if (needed.length === 0) return null;
  const paths = [];
  for (const p of needed) {
    const entry = protectedPathEntry(p);
    if (entry) paths.push({ path: p, why: `protected path (${entry}, ADR-0021)` });
    else if (hiddenPaths.has(p)) paths.push({ path: p, why: 'withheld from the prompt (too large for the context budget, ADR-0029)' });
    else return null;
  }
  return { paths };
}

/**
 * The model's structured signal: `blocked` must be the JSON boolean `true`. Absent, null or false
 * means not blocked, whatever the summary says. Any other value is a malformed response.
 * @returns {{ reason: string, plannedFix: string } | null}
 */
export function readBlockedSignal(aiOutput) {
  const value = aiOutput?.blocked;
  if (value === undefined || value === null || value === false) return null;
  if (value !== true) throw new Error(`AI response blocked must be a boolean (got ${typeof value})`);
  return { reason: text(aiOutput.blocked_reason) || '(no reason given)', plannedFix: text(aiOutput.planned_fix) };
}

/** Labels from ISSUE_LABELS: a JSON array of names, or a comma-separated list. */
export function parseIssueLabels(raw) {
  const value = text(raw);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((l) => typeof l === 'string').map((l) => l.trim()).filter(Boolean);
  } catch {
    // not JSON: comma-separated below
  }
  return value.split(',').map((l) => l.trim()).filter(Boolean);
}

function noteChanges(changes) {
  return (Array.isArray(changes) ? changes : [])
    .filter((c) => c && typeof c === 'object' && typeof c.target_path === 'string' && NOTE_FILE_PATTERN.test(c.target_path.trim()))
    .map((c) => ({ path: normalizeRepoPath(c.target_path.trim()), content: text(c.file_content) }));
}

/**
 * Deterministic refusal on the model output: for an issue labelled bug or feature, a patch whose
 * only files are new Markdown files outside docs/ is a handoff note, not an implementation.
 * @returns {{ label: string, paths: string[] } | null}
 */
export function findNotesOnlyChange(changes, { labels = [], fileExists = () => false } = {}) {
  const label = labels.find((l) => CODE_CHANGE_LABELS.includes(String(l).toLowerCase()));
  if (!label || !Array.isArray(changes) || changes.length === 0) return null;
  const notes = noteChanges(changes);
  if (notes.length !== changes.length) return null;
  if (notes.some(({ path: p }) => p.toLowerCase().startsWith('docs/') || fileExists(p))) return null;
  return { label, paths: notes.map((n) => n.path) };
}

/**
 * Precedence: the deterministic check, then the model's `blocked: true`, then the notes-only
 * refusal. Facts about the repository win over the model, so `blocked: false` never overrides
 * them; the model can only add a blocker the code cannot see (an unmerged PR dependency).
 * The planned fix is the model's `planned_fix`, else the content of the note it wrote, else its summary.
 * @returns {{ source: string, reason: string, plannedFix: string } | null}
 */
export function decideGenerationBlocked({ deterministic = null, aiOutput, labels = [], fileExists = () => false }) {
  const signal = readBlockedSignal(aiOutput);
  const notes = noteChanges(aiOutput?.changes);
  const plannedFix = cap(signal?.plannedFix
    || notes.filter((n) => n.content).map((n) => (notes.length > 1 ? `**${n.path}**\n\n${n.content}` : n.content)).join('\n\n')
    || text(aiOutput?.summary));
  if (deterministic) {
    const list = deterministic.paths.map((p) => `\`${p.path}\` (${p.why})`).join(', ');
    const modelReason = signal ? ` Model: ${signal.reason}` : '';
    return { source: BLOCKED_SOURCES.DENYLIST, reason: cap(`every file this issue needs is off-limits to code generation: ${list}.${modelReason}`), plannedFix };
  }
  if (signal) return { source: BLOCKED_SOURCES.MODEL, reason: cap(signal.reason), plannedFix };
  const notesOnly = findNotesOnlyChange(aiOutput?.changes, { labels, fileExists });
  if (notesOnly) {
    const list = notesOnly.paths.map((p) => `\`${p}\``).join(', ');
    return { source: BLOCKED_SOURCES.NOTES_ONLY, reason: `the patch only adds new Markdown notes outside docs/ (${list}) for an issue labelled \`${notesOnly.label}\`: a note is not an implementation.`, plannedFix };
  }
  return null;
}

const SOURCE_LABELS = {
  [BLOCKED_SOURCES.DENYLIST]: 'deterministic check (protected or withheld files)',
  [BLOCKED_SOURCES.MODEL]: 'the model (`blocked: true`)',
  [BLOCKED_SOURCES.NOTES_ONLY]: 'deterministic check (notes-only patch)',
};

export function formatBlockedComment(blocked, { needsHuman, readyForDev }) {
  return [
    '## ⛔ Code Generation: Blocked',
    '',
    `Code generation cannot implement this issue, so no branch was pushed and no pull request was opened. \`${readyForDev}\` was replaced by \`${needsHuman}\`.`,
    '',
    `**Detected by:** ${SOURCE_LABELS[blocked.source] ?? blocked.source}`,
    '',
    `**Reason:** ${blocked.reason}`,
    '',
    '### Planned fix',
    '',
    blocked.plannedFix || '_(none provided)_',
    '',
    `Unblock it (merge the dependency, or implement the protected part by hand), then remove \`${needsHuman}\` and re-apply \`${readyForDev}\`.`,
  ].join('\n');
}

/**
 * GitHub side of the blocked outcome: `needsHuman` created if missing and applied, `readyForDev`
 * removed (404: already gone), then the comment. Throws on the first failed call.
 * `request(endpoint, options)` returns a fetch Response (ghFetch in the entrypoint).
 */
export async function escalateBlocked({ request, repository, issueNumber, blocked, needsHuman, readyForDev }) {
  const base = `/repos/${repository}`;
  const createRes = await request(`${base}/labels`, { method: 'POST', body: JSON.stringify(needsHuman) });
  if (!createRes.ok && createRes.status !== 422) throw new Error(`Label create failed for "${needsHuman.name}": ${createRes.status}`);
  const applyRes = await request(`${base}/issues/${issueNumber}/labels`, { method: 'POST', body: JSON.stringify({ labels: [needsHuman.name] }) });
  if (!applyRes.ok) throw new Error(`Add label "${needsHuman.name}" failed: ${applyRes.status}`);
  const removeRes = await request(`${base}/issues/${issueNumber}/labels/${encodeURIComponent(readyForDev)}`, { method: 'DELETE' });
  if (!removeRes.ok && removeRes.status !== 404) throw new Error(`Remove label "${readyForDev}" failed: ${removeRes.status}`);
  const body = formatBlockedComment(blocked, { needsHuman: needsHuman.name, readyForDev });
  const commentRes = await request(`${base}/issues/${issueNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  if (!commentRes.ok) throw new Error(`Blocked comment failed: ${commentRes.status}`);
}
