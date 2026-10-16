// Public run record (ADR-0040): the redacted trace a dashboard reads from the `metrics` branch, and
// the single-commit write of that record with the run's metrics/runs.jsonl lines (ADR-0013).
// redactTrace() is the only path from a trace file to the store: the site is public.

export const RECORD_SCHEMA_VERSION = 1;
export const MAX_STRING = 200;
export const MAX_ARRAY = 50;
export const MAX_RECORD_BYTES = 256 * 1024;
export const METRICS_BRANCH = 'metrics';
export const RUNS_JSONL_PATH = 'metrics/runs.jsonl';

const REDACTED = '[redacted]';
const ID = ['prNumber', 'issueNumber', 'attempt'];
const ERR = ['error'];

// Meta keys kept per event. An event not listed keeps its name, level and timing, with meta {}.
// Never listed: prompts, raw model output, file contents, issue/PR titles and bodies, previews,
// env, stack traces, stderr tails, local paths (configPath).
export const EVENT_META_ALLOWLIST = Object.freeze({
  'issue_validation.start': [...ID, 'model'],
  'issue_validation.pass': [...ID, 'score', 'warnings_count'],
  'issue_validation.fail': [...ID, ...ERR, 'score', 'blockers_count'],
  'issue_validation.comment_posted': [...ID, 'action', 'url'],
  'issue_validation.labels_applied': [...ID, 'added', 'removed'],
  'code_gen.start': [...ID, 'model'],
  'code_gen.context_built': ['shown_files', 'hidden_files', 'deterministic_block'],
  'code_gen.llm_request': ['model', 'input_tokens_est'],
  'code_gen.llm_response': ['output_tokens_est'],
  'code_gen.complete': ['changes_count'],
  'code_gen.error': [...ERR, 'reason', 'source'],
  'code_gen.skipped': [...ERR, 'reason', 'rules', 'source', 'detail'],
  'code_gen.escalated': ['during', 'reason', 'source', 'rules', 'labels_added', 'labels_removed', 'url'],
  'pr_prepare.start': ['changes_count'],
  'pr_prepare.complete': ['paths'],
  'pr_prepare.error': ERR,
  'pr_prepare.skipped': [...ERR, 'reason', 'rules'],
  'review.start': [...ID, 'model'],
  'review.llm_request': [...ID, 'model', 'input_tokens_est'],
  'review.llm_response': [...ID, 'output_tokens_est'],
  'review.verdict': [...ID, 'verdict', 'evidence_state', 'evidence_override', 'unreviewed_code_files'],
  'review.skipped': [...ID, 'reason', 'headSha'],
  'review.error': ERR,
  'review.stale_refs_error': ERR,
  'review.related_adrs_error': ERR,
  'review.prompt_budget_error': ERR,
  'review.models_config_ignored': [...ERR, 'path'],
  'review.evidence_assessed': [...ID, 'state', 'reason', 'failing', 'unverified'],
  'review.prompt_truncated': [...ID, 'diff_truncated', 'body_truncated', 'unreviewed_code_files', 'adrs_shown', 'adrs_found', 'max_input_tokens'],
  'review.comment_posted': [...ID, 'action', 'headSha', 'url'],
  'review.review_submitted': [...ID, 'review_event', 'skipped', 'url'],
  'review.labels_applied': [...ID, 'added', 'removed', 'repulse_skipped'],
  'autofix.start': ID,
  'autofix.llm_request': [...ID, 'model', 'input_tokens_est'],
  'autofix.llm_response': [...ID, 'output_tokens_est'],
  'autofix.prompt_budget': [...ID, 'input_budget', 'shown_files', 'hidden_files', 'skipped_files', 'diff_truncated', 'feedback_truncated'],
  'autofix.push': [...ID, 'paths'],
  'autofix.max_attempts_reached': [...ID, 'url'],
  'autofix.skipped': [...ID, 'reason', 'headSha', 'rules', 'url'],
  'autofix.error': [...ID, ...ERR],
  'autofix.reset': [...ID, 'removed_labels', 'removed_checkpoints'],
  'autofix.attempt_labeled': [...ID, 'label'],
  'autofix.escalated': [...ID, 'reason', 'labels_added', 'url'],
  llm_call: ['provider', 'model', 'fallback'],
  llm_call_failed: ['providers'],
  llm_fallback: ['from', 'to', 'error_type', ...ERR],
  llm_fallback_disabled: ['from', 'error_type', ...ERR],
  provider_config_fallback: ['ai_provider', 'provider'],
  'dependency_manifest.package_json_ignored': ['path', 'reason'],
  'retry.wait': ['attempt', 'wait_ms', 'status', ...ERR],
  'workflow.pr_operation': [...ID, 'operation', 'url'],
  'workflow.push': [...ID, 'outcome'],
  trace_write_failed: ERR,
  start_span_failed: [...ERR, 'stage'],
  end_span_failed: [...ERR, 'stage'],
  trace_finalize_failed: ERR,
});

// Span meta keys kept (any stage).
export const SPAN_META_ALLOWLIST = Object.freeze([
  ...ID, 'model', 'score', 'valid', 'verdict', 'reason', 'changes_count', 'paths', 'rules', 'source', ...ERR,
]);

// Env vars whose values are public and may appear in a record (run metadata, model names).
const PUBLIC_ENV = new Set([
  'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_SERVER_URL', 'GITHUB_API_URL', 'GITHUB_GRAPHQL_URL',
  'GITHUB_WORKFLOW', 'GITHUB_WORKFLOW_REF', 'GITHUB_ACTOR', 'GITHUB_TRIGGERING_ACTOR', 'GITHUB_EVENT_NAME',
  'GITHUB_REF', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'AI_PROVIDER',
]);
const PUBLIC_ENV_SUFFIX = /_(MODEL|EFFORT|PROVIDER)$/;
// Workflow outputs handed to commit_run_record.mjs (PR URL/number, push outcome, commit message).
const PUBLIC_ENV_PREFIX = /^RUN_RECORD_/;
// Any other env value this long is scrubbed wherever it appears: secrets, tokens, issue bodies,
// runner paths. Over-redaction is the failure mode, never a leak.
const MIN_SCRUBBED_ENV_LENGTH = 12;
// Credential shapes, scrubbed even when they come from somewhere other than the env.
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Env values to scrub, longest first (a value containing another is replaced whole). */
export function secretValues(env = {}) {
  return [...new Set(Object.entries(env)
    .filter(([name, value]) => typeof value === 'string' && value.length >= MIN_SCRUBBED_ENV_LENGTH
      && !PUBLIC_ENV.has(name) && !PUBLIC_ENV_SUFFIX.test(name) && !PUBLIC_ENV_PREFIX.test(name))
    .map(([, value]) => value))]
    .sort((a, b) => b.length - a.length);
}

/** Replaces every env value in `secrets` and every credential shape by [redacted]; no truncation. */
export function scrubString(value, secrets = []) {
  let s = String(value);
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join(REDACTED);
  for (const re of TOKEN_PATTERNS) s = s.replace(re, REDACTED);
  return s;
}

/** Scrub, then truncate to MAX_STRING characters (scrubbing first: a cut secret would no longer match). */
export function redactString(value, secrets = []) {
  const s = scrubString(value, secrets);
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
}

function redactValue(value, secrets, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => (v !== null && typeof v === 'object' ? null : redactValue(v, secrets, depth + 1)));
  }
  // One level of plain object with primitive values (e.g. a map of check name → status).
  if (typeof value === 'object' && depth === 0) {
    return Object.fromEntries(Object.entries(value).slice(0, MAX_ARRAY)
      .filter(([, v]) => v === null || typeof v !== 'object')
      .map(([k, v]) => [redactString(k, secrets), redactValue(v, secrets, depth + 1)]));
  }
  return null;
}

function pick(meta, keys, secrets) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const key of keys) if (Object.hasOwn(meta, key)) out[key] = redactValue(meta[key], secrets);
  return out;
}

const str = (v, secrets) => (typeof v === 'string' ? redactString(v, secrets) : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : null);

// A URL is kept whole or dropped: on the server host, URL-safe characters, nothing to scrub.
function redactUrl(v, server, secrets) {
  if (typeof v !== 'string' || v.length > 300 || !v.startsWith(`${server}/`)) return null;
  if (!/^[A-Za-z0-9/._~%#?=&:-]+$/.test(v)) return null;
  return redactString(v, secrets) === v ? v : null;
}

function redactEnvelope(e, secrets, server) {
  const env = e && typeof e === 'object' ? e : {};
  return {
    workflow: str(env.workflow, secrets),
    run_id: typeof env.run_id === 'string' && /^\d+$/.test(env.run_id) ? env.run_id : null,
    run_attempt: int(env.run_attempt),
    event_name: str(env.event_name, secrets),
    actor: str(env.actor, secrets),
    actor_type: env.actor_type === 'bot' || env.actor_type === 'human' ? env.actor_type : null,
    repository: str(env.repository, secrets),
    issue_number: int(env.issue_number),
    pr_number: int(env.pr_number),
    head_sha: sha(env.head_sha),
    run_url: redactUrl(env.run_url, server, secrets),
    issue_url: redactUrl(env.issue_url, server, secrets),
    pr_url: redactUrl(env.pr_url, server, secrets),
    links: (Array.isArray(env.links) ? env.links : [])
      .map((l) => ({ event: str(l?.event, secrets), url: redactUrl(l?.url, server, secrets) }))
      .filter((l) => l.url)
      .slice(0, MAX_ARRAY),
    llm_calls: (Array.isArray(env.llm_calls) ? env.llm_calls : []).slice(0, MAX_ARRAY).map((c) => ({
      stage: str(c?.stage, secrets),
      provider: str(c?.provider, secrets),
      model: str(c?.model, secrets),
      fallback: c?.fallback === true,
      outcome: c?.outcome === 'answered' || c?.outcome === 'failed' ? c.outcome : null,
      duration_ms: num(c?.duration_ms),
    })),
  };
}

/**
 * The public record of a trace file (ADR-0040). Allowlist only: unknown top-level keys, meta keys
 * not in EVENT_META_ALLOWLIST / SPAN_META_ALLOWLIST and nested objects are dropped; strings are
 * scrubbed of env values and credential shapes, then cut to MAX_STRING. Events past MAX_RECORD_BYTES
 * are counted in `events_overflow`, like the journal's own cap.
 */
export function redactTrace(trace, { env = {} } = {}) {
  const t = trace && typeof trace === 'object' ? trace : {};
  const secrets = secretValues(env);
  const server = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const envelope = redactEnvelope(t.envelope, secrets, server);
  const record = {
    schema_version: RECORD_SCHEMA_VERSION,
    trace_schema_version: int(t.schema_version),
    run_id: envelope.run_id ? `${envelope.run_id}-${envelope.run_attempt ?? 1}` : null,
    envelope,
    started_at: iso(t.started_at),
    completed_at: iso(t.completed_at),
    outcome: str(t.outcome, secrets),
    spans: (Array.isArray(t.spans) ? t.spans : []).slice(0, MAX_ARRAY).map((s) => ({
      stage: str(s?.stage, secrets),
      started_at: iso(s?.started_at),
      completed_at: iso(s?.completed_at),
      duration_ms: num(s?.duration_ms),
      outcome: str(s?.outcome, secrets),
      meta: pick(s?.meta, SPAN_META_ALLOWLIST, secrets),
    })),
    events: [],
    events_overflow: {
      count: int(t.events_overflow?.count) ?? 0,
      bytes: int(t.events_overflow?.bytes) ?? 0,
    },
  };
  let bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  for (const e of Array.isArray(t.events) ? t.events : []) {
    const name = str(e?.event, secrets);
    const event = {
      ts: iso(e?.ts),
      stage: str(e?.stage, secrets),
      event: name,
      level: ['info', 'warn', 'error'].includes(e?.level) ? e.level : null,
      duration_ms: num(e?.duration_ms),
      meta: pick(e?.meta, (name && Object.hasOwn(EVENT_META_ALLOWLIST, name)) ? EVENT_META_ALLOWLIST[name] : [], secrets),
    };
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    if (bytes + size > MAX_RECORD_BYTES) {
      record.events_overflow.count += 1;
      record.events_overflow.bytes += size;
      continue;
    }
    record.events.push(event);
    bytes += size;
  }
  return record;
}

/** metrics/runs/<YYYY-MM>/<run_id>-<attempt>.json, month of the run start (UTC), else of `now`. */
export function recordPath(record, now = new Date()) {
  const month = (record?.started_at ?? now.toISOString()).slice(0, 7);
  return `metrics/runs/${month}/${record.run_id}.json`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Appends `newLines` to metrics/runs.jsonl and adds `record` (when not already stored for this
 * run_id + attempt) in ONE commit on the `metrics` branch (Git Data API: tree with base_tree,
 * commit, fast-forward ref update). A lost race (ref moved: 409/422) retries from a fresh read,
 * up to `attempts` times with 2^i s backoff — the retry of the former Contents API step.
 *
 * `request(method, path, body?, { raw }?)` resolves `{ status, json?, text? }` and never throws for
 * an HTTP status. Returns `{ committed, skipped, reason?, sha?, recordPath? }`.
 */
export async function commitRunRecord({ request, repository, message, newLines = '', record = null, attempts = 3, wait = sleep, now = new Date() }) {
  const lines = String(newLines).trim();
  const repo = `/repos/${repository}`;
  const path = record?.run_id ? recordPath(record, now) : null;
  if (!lines && !path) return { committed: false, skipped: true, reason: 'nothing to commit' };

  // One read-modify-write pass: a result to return, or { retry: reason }.
  async function attemptOnce() {
    const ref = await request('GET', `${repo}/git/ref/heads/${METRICS_BRANCH}`);
    if (ref.status === 404) return { committed: false, skipped: false, reason: `branch ${METRICS_BRANCH} not found` };
    const parent = ref.json?.object?.sha;
    if (ref.status !== 200 || !parent) return { retry: `cannot read ${METRICS_BRANCH} ref (${ref.status})` };
    const commit = await request('GET', `${repo}/git/commits/${parent}`);
    const baseTree = commit.json?.tree?.sha;
    if (commit.status !== 200 || !baseTree) return { retry: `cannot read ${METRICS_BRANCH} commit (${commit.status})` };

    const tree = [];
    if (lines) {
      const current = await request('GET', `${repo}/contents/${RUNS_JSONL_PATH}?ref=${parent}`, undefined, { raw: true });
      if (current.status !== 200 && current.status !== 404) return { retry: `cannot read ${RUNS_JSONL_PATH} (${current.status})` };
      const existing = current.status === 200 ? String(current.text ?? '') : '';
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      tree.push({ path: RUNS_JSONL_PATH, mode: '100644', type: 'blob', content: `${existing}${sep}${lines}\n` });
    }
    let stored = false;
    if (path) {
      // ADR-0013 dedup: the first record written for a run_id + attempt wins.
      const found = await request('GET', `${repo}/contents/${path}?ref=${parent}`);
      if (found.status !== 200 && found.status !== 404) return { retry: `cannot read ${path} (${found.status})` };
      stored = found.status === 200;
      if (!stored) tree.push({ path, mode: '100644', type: 'blob', content: `${JSON.stringify(record)}\n` });
    }
    if (tree.length === 0) return { committed: false, skipped: true, reason: 'record already stored', recordPath: path };

    const newTree = await request('POST', `${repo}/git/trees`, { base_tree: baseTree, tree });
    if (newTree.status !== 201) return { retry: `tree create failed (${newTree.status})` };
    const newCommit = await request('POST', `${repo}/git/commits`, { message, tree: newTree.json.sha, parents: [parent] });
    if (newCommit.status !== 201) return { retry: `commit create failed (${newCommit.status})` };
    // force: false — a ref that moved since the read (concurrent run) is rejected, and the pass retries.
    const update = await request('PATCH', `${repo}/git/refs/heads/${METRICS_BRANCH}`, { sha: newCommit.json.sha, force: false });
    if (update.status !== 200) return { retry: `ref update failed (${update.status})` };
    return { committed: true, skipped: false, sha: newCommit.json.sha, recordPath: stored ? null : path };
  }

  let reason = null;
  for (let i = 1; i <= attempts; i++) {
    const result = await attemptOnce();
    if (!result.retry) return result;
    reason = result.retry;
    if (i < attempts) await wait(2 ** i * 1000);
  }
  return { committed: false, skipped: false, reason };
}
