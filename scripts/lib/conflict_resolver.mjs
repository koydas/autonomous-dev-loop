// Model resolution of the conflict hunks of one file (ADR-0059 §C-E). The model returns resolved HUNKS, never the
// file: the script splices them into the conflict blocks, so the non-conflicting part of the file is untouched
// (the whole-file contract of ADR-0029 would let a conflict serve as cover for a rewrite). Pure apart from the
// injected `callModel`; every refusal is a reason code, never model text.
import { parseJsonResponse } from './output_writer.mjs';
import { parseConflicts, conflictsOf, applyResolutions, checkHunkResolution, hasConflictMarkers } from './conflicts.mjs';

/** Characters of hunks (three sides) one model call accepts; the stage's input budget minus the fixed prompt. */
export function hunkCharBudget({ maxInputTokens, fixedTokens = 0 }) {
  return Math.max(0, (maxInputTokens - fixedTokens) * 4);
}

/** The user prompt body for one file: numbered hunks with the three sides, fenced so a side cannot close a section. */
export function formatHunks(conflicts) {
  return conflicts.map((c, index) => [
    `### Hunk ${index}`,
    '<<<<<<< ours (the pull request)',
    c.ours.replace(/\n$/, ''),
    '||||||| common ancestor',
    c.base.replace(/\n$/, ''),
    '=======',
    c.theirs.replace(/\n$/, ''),
    '>>>>>>> theirs (the base branch)',
  ].join('\n')).join('\n\n');
}

/**
 * The model answer as one string per hunk. Throws a reason-coded Error on anything but a complete, ordered answer.
 * @returns {string[]}
 */
export function parseResolutions(raw, count) {
  let parsed;
  try { parsed = parseJsonResponse(raw); } catch { throw reasoned('parse_failed'); }
  const list = parsed?.resolutions;
  if (!Array.isArray(list) || list.length !== count) throw reasoned('model_rejected');
  const out = new Array(count).fill(null);
  for (const item of list) {
    const i = item?.index;
    if (!Number.isInteger(i) || i < 0 || i >= count || out[i] !== null || typeof item.content !== 'string') throw reasoned('model_rejected');
    out[i] = item.content;
  }
  return out;
}

function reasoned(reason) {
  const err = new Error(reason);
  err.reason = reason;
  return err;
}

/**
 * Resolves every conflict hunk of `content` with the model, post-checks each hunk with its resolver and returns
 * the spliced file. `ok: false` carries a reason code from CONFLICT_ESCALATION_REASONS.
 * @param {{ path: string, resolver: string, content: string, title?: string, budgetChars: number,
 *   callModel: (input: { hunks: string, path: string, resolver: string, title: string }) => Promise<string> }} input
 * @returns {Promise<{ ok: true, content: string, hunks: number } | { ok: false, reason: string, rules?: string[] }>}
 */
export async function resolveFile({ path, resolver, content, title = '', budgetChars, callModel }) {
  let segments;
  try { segments = parseConflicts(content); } catch { return { ok: false, reason: 'parse_failed' }; }
  const conflicts = conflictsOf(segments);
  if (conflicts.length === 0) return { ok: false, reason: 'parse_failed' };
  const hunks = formatHunks(conflicts);
  if (hunks.length > budgetChars) return { ok: false, reason: 'too_large' };

  let resolutions;
  try {
    resolutions = parseResolutions(await callModel({ hunks, path, resolver, title: String(title).slice(0, 200) }), conflicts.length);
  } catch (err) {
    if (err.reason) return { ok: false, reason: err.reason };
    throw err;
  }
  const rules = new Set();
  conflicts.forEach((c, i) => checkHunkResolution(resolver, c, resolutions[i]).forEach((r) => rules.add(r)));
  if (rules.size) return { ok: false, reason: 'model_rejected', rules: [...rules] };
  const resolved = applyResolutions(segments, resolutions);
  if (hasConflictMarkers(resolved)) return { ok: false, reason: 'model_rejected', rules: ['marker_left'] };
  return { ok: true, content: resolved, hunks: conflicts.length };
}
