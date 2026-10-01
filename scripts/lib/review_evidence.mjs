import { spawn } from 'node:child_process';
import { parseNestedYaml } from './yaml.mjs';

// Tool evidence for PR review (ADR-0020): run declared checks in a secret-free job,
// then let the review stage consume the results and override its verdict on failure.

export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_CONFIG_PATH = 'config/review-evidence.yaml';
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const OUTPUT_TAIL_CHARS = 2000;

const CHECK_STATUSES = new Set(['pass', 'fail', 'timeout', 'error']);
const SECRET_ENV_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;
// Env-injected git config (e.g. http.extraheader auth) is dropped as a whole family: removing only the
// KEY_n entries the pattern above matches would leave GIT_CONFIG_COUNT dangling and make git fail.
const GIT_CONFIG_ENV_PATTERN = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Parses config/review-evidence.yaml into an ordered list of checks.
 * Throws with the offending field path on any invalid entry.
 */
export function parseEvidenceConfig(content) {
  const parsed = parseNestedYaml(content ?? '');
  const checks = parsed.checks;
  if (!checks || Object.keys(checks).length === 0) {
    throw new Error('Review evidence config must declare at least one check under `checks`');
  }
  return Object.entries(checks).map(([name, fields]) => {
    const command = (fields.command ?? '').trim();
    if (!command) throw new Error(`Missing review evidence config field: checks.${name}.command`);
    let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
    if (fields.timeout_seconds !== undefined) {
      timeoutSeconds = Number(fields.timeout_seconds);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error(
          `Invalid review evidence config field: checks.${name}.timeout_seconds must be a positive integer, got "${fields.timeout_seconds}"`,
        );
      }
    }
    return { name, command, timeoutMs: timeoutSeconds * 1000 };
  });
}

/** Drops env vars whose name looks like a credential, and env-injected git config, before handing env to PR code. */
export function sanitizeEnv(env) {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([key]) => !SECRET_ENV_PATTERN.test(key) && !GIT_CONFIG_ENV_PATTERN.test(key)),
  );
}

/** Strips ANSI escapes and keeps the last `maxChars` characters. */
export function tailOutput(text, maxChars = OUTPUT_TAIL_CHARS) {
  const clean = String(text ?? '').replace(ANSI_PATTERN, '');
  if (clean.length <= maxChars) return clean;
  return `…(truncated)\n${clean.slice(-maxChars)}`;
}

/**
 * Runs one check through `bash -c` in its own process group so a timeout kills the whole tree.
 * Never rejects: spawn failures resolve to status `error`.
 */
export function runCheck(check, { spawnFn = spawn, env = process.env, cwd = process.cwd(), now = Date.now } = {}) {
  const startedAt = now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (status, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: check.name,
        command: check.command,
        status,
        exit_code: exitCode,
        duration_ms: now() - startedAt,
        output_tail: tailOutput(output),
      });
    };

    let child;
    try {
      child = spawnFn('bash', ['-c', check.command], {
        cwd,
        env: sanitizeEnv(env),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      output = err.message;
      finish('error', null);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill?.('SIGKILL');
      }
    }, check.timeoutMs);

    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (err) => {
      output += `\n${err.message}`;
      finish('error', null);
    });
    child.on('close', (code) => {
      if (timedOut) {
        output += `\nTimed out after ${check.timeoutMs / 1000}s`;
        finish('timeout', code);
      } else {
        finish(code === 0 ? 'pass' : 'fail', code);
      }
    });
  });
}

export function buildEvidence({ headSha, results, generatedAt = new Date().toISOString() }) {
  return { version: EVIDENCE_SCHEMA_VERSION, head_sha: headSha, generated_at: generatedAt, checks: results };
}

/**
 * Validates a raw evidence file. Returns `{ ok: true, evidence }` or `{ ok: false, reason }` —
 * never throws, since missing evidence must degrade the review, not abort it.
 */
export function parseEvidence(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `evidence file is not valid JSON: ${err.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'evidence file is not a JSON object' };
  }
  if (data.version !== EVIDENCE_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported evidence version: ${data.version}` };
  }
  if (typeof data.head_sha !== 'string' || !data.head_sha) {
    return { ok: false, reason: 'missing evidence field: head_sha' };
  }
  if (!Array.isArray(data.checks)) {
    return { ok: false, reason: 'missing evidence field: checks' };
  }
  for (const [i, c] of data.checks.entries()) {
    if (!c || typeof c.name !== 'string' || !CHECK_STATUSES.has(c.status)) {
      return { ok: false, reason: `invalid evidence entry: checks[${i}]` };
    }
  }
  return { ok: true, evidence: data };
}

/** True when the PR diff modifies the evidence config itself. */
export function isEvidenceConfigTouched(rawDiff, configPath = EVIDENCE_CONFIG_PATH) {
  const escaped = configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^diff --git a/${escaped} |^(?:---|\\+\\+\\+) [ab]/${escaped}$`, 'm').test(rawDiff ?? '');
}

/**
 * Classifies evidence relative to the PR head under review.
 * state: `available` | `missing` | `stale`. Only `available` evidence can produce `failing` checks.
 */
export function assessEvidence(parseResult, { prHeadSha = null, configTouched = false } = {}) {
  if (!parseResult?.ok) {
    return { state: 'missing', reason: parseResult?.reason ?? 'no evidence file', checks: [], failing: [], unverified: [], configTouched };
  }
  const { evidence } = parseResult;
  if (prHeadSha && evidence.head_sha !== prHeadSha) {
    return {
      state: 'stale',
      reason: `evidence was produced for ${evidence.head_sha.slice(0, 7)}, PR head is ${prHeadSha.slice(0, 7)}`,
      checks: evidence.checks,
      failing: [],
      unverified: evidence.checks.map((c) => c.name),
      configTouched,
    };
  }
  return {
    state: 'available',
    reason: null,
    checks: evidence.checks,
    failing: evidence.checks.filter((c) => c.status === 'fail').map((c) => c.name),
    unverified: evidence.checks.filter((c) => c.status === 'timeout' || c.status === 'error').map((c) => c.name),
    configTouched,
  };
}

const CONFIG_TOUCHED_NOTE =
  `This PR modifies \`${EVIDENCE_CONFIG_PATH}\`: the checks ran under the PR's own config, so a passing result is not authoritative.`;

/** Prompt block appended to the review user prompt. */
export function formatEvidenceContext(assessment) {
  const lines = ['', '', '## Tool evidence'];
  if (assessment.state !== 'available') {
    lines.push(`No usable tool evidence (${assessment.state}: ${assessment.reason}). Treat every check as unverified; do not claim tests or lint pass.`);
    return lines.join('\n');
  }
  lines.push('Results of executing the repository checks on the PR head commit:');
  for (const c of assessment.checks) {
    lines.push(`- ${c.name} (\`${c.command}\`): ${c.status.toUpperCase()}${c.exit_code != null ? ` (exit ${c.exit_code})` : ''}`);
  }
  for (const c of assessment.checks.filter((x) => x.status === 'fail')) {
    lines.push('', `Output tail of failing check \`${c.name}\`:`, '```', c.output_tail ?? '', '```');
  }
  if (assessment.configTouched) lines.push('', CONFIG_TOUCHED_NOTE);
  return lines.join('\n');
}

/** Deterministic markdown section appended to the review comment. */
export function formatEvidenceSection(assessment, { overridden = false } = {}) {
  const lines = ['', '### 🧪 Tool Evidence'];
  if (assessment.state !== 'available') {
    lines.push(`_No usable tool evidence — ${assessment.state}: ${assessment.reason}._`);
  } else {
    lines.push('| Check | Command | Result |', '|---|---|---|');
    for (const c of assessment.checks) {
      lines.push(`| ${c.name} | \`${c.command}\` | ${c.status.toUpperCase()}${c.exit_code != null ? ` (exit ${c.exit_code})` : ''} |`);
    }
    for (const c of assessment.checks.filter((x) => x.status === 'fail')) {
      lines.push('', `<details><summary>Output tail — ${c.name}</summary>`, '', '```', c.output_tail ?? '', '```', '', '</details>');
    }
    if (assessment.configTouched) lines.push('', `> ⚠️ ${CONFIG_TOUCHED_NOTE}`);
  }
  if (overridden) {
    lines.push('', `> **Verdict overridden to REQUEST_CHANGES** — failing checks: ${assessment.failing.join(', ')}.`);
  }
  return lines.join('\n');
}
