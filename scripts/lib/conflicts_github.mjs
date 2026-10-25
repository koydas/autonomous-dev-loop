// GitHub REST access of the conflicts-fix stage (ADR-0058): one request function with the retry policy of
// ADR-0022, and the label / comment helpers both scripts share. Every helper takes `request`, so the tests
// inject a fake. REST only: nothing here uses GraphQL, so ADR-0011's fallback does not apply.
import { retryWithBackoff, transientHttpError, isRetrySafeGitHubRequest } from './retry.mjs';

/** `request(method, path, body?)` → `{ status, ok, json }` against `/repos/<repository>`; 429/5xx retried, the rest returned. */
export function createRequest({ token, repository, apiBase = 'https://api.github.com', fetchImpl = fetch }) {
  const base = `${apiBase.trim().replace(/\/+$/, '')}/repos/${repository}`;
  return async function request(method, path, body) {
    const retrySafe = isRetrySafeGitHubRequest(method, path);
    let last = null;
    try {
      return await retryWithBackoff(async () => {
        last = null;
        let res;
        try {
          res = await fetchImpl(`${base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
        } catch (err) {
          if (!retrySafe) err.retryable = false;
          throw err;
        }
        const transient = transientHttpError(res, `GitHub API (${path})`, { retrySafe });
        if (transient) { last = res; throw transient; }
        return res;
      }).then(toResult);
    } catch (err) {
      if (last) return toResult(last);
      throw new Error(`Network error calling GitHub API (${path}): ${err.message}`, { cause: err });
    }
  };
}

async function toResult(res) {
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: res.ok, json };
}

/** Every page of a list endpoint (`path` without paging parameters). */
export async function paginate(request, path) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const res = await request('GET', `${path}${sep}per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`GitHub API GET ${path} (page ${page}) → ${res.status}`);
    const batch = Array.isArray(res.json) ? res.json : [];
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

/** Creates the label when missing (422 = exists) and applies it to the PR. */
export async function addLabel(request, prNumber, label) {
  const created = await request('POST', '/labels', { name: label.name, color: label.color, description: label.description });
  if (!created.ok && created.status !== 422) throw new Error(`Label create failed for "${label.name}": ${created.status}`);
  const applied = await request('POST', `/issues/${prNumber}/labels`, { labels: [label.name] });
  if (!applied.ok) throw new Error(`Add label "${label.name}" failed: ${applied.status}`);
}

/** Removes a label; an absent one (404) is fine. */
export async function removeLabel(request, prNumber, name) {
  const res = await request('DELETE', `/issues/${prNumber}/labels/${encodeURIComponent(name)}`);
  if (!res.ok && res.status !== 404) throw new Error(`Remove label "${name}" failed: ${res.status}`);
  return res.status !== 404;
}

/** Posts a comment; returns its html_url (null when GitHub does not give one). */
export async function postComment(request, prNumber, body) {
  const res = await request('POST', `/issues/${prNumber}/comments`, { body });
  if (!res.ok) throw new Error(`Comment failed: ${res.status}`);
  return res.json?.html_url ?? null;
}

/** The label objects of the `conflicts` group of the (layered) labels config. */
export function conflictLabels(labels) {
  const g = labels.conflicts;
  if (!g?.conflicting || !g.attempt1 || !g.attempt2) throw new Error('labels config conflicts.{conflicting,attempt1,attempt2} is missing');
  return { conflicting: g.conflicting, attempts: [g.attempt1, g.attempt2], needsHuman: labels.autofix.needs_human };
}
