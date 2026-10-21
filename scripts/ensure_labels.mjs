#!/usr/bin/env node
/**
 * Creates the labels the pipeline uses in a repository (ADR-0045): every label of the effective labels
 * config (config/labels.yaml of the pipeline with the repository's own layer, so a renamed label is the
 * one created). Idempotent: an existing label is left alone, `--update` brings its color and description
 * back to the config, `--dry-run` writes nothing. Run once when a repository installs the pipeline, from
 * the setup-labels.yml template (workflow_dispatch) or by hand.
 * Env: GITHUB_TOKEN (or GH_TOKEN), GITHUB_REPOSITORY, GITHUB_API_URL (optional), ADL_CONFIG_DIR / ADL_CONFIG_PATH.
 */
import { fileURLToPath } from 'node:url';
import { loadLabelsConfigAll } from './lib/layered_config.mjs';
import { log as obsLog } from './lib/observability.mjs';

const STAGE = 'labels_install';
const PER_PAGE = 100;
// GitHub limits: a description is at most 100 characters, a color is six hex digits.
const DESCRIPTION_MAX = 100;

/** Every label of the (layered) config as { name, color, description }, validated with its config path. */
export function labelDefinitions(labels) {
  const definitions = [];
  const seen = new Map();
  for (const [group, sections] of Object.entries(labels)) {
    for (const [section, label] of Object.entries(sections)) {
      const path = `${group}.${section}`;
      const { name, color, description } = label;
      if (typeof name !== 'string' || !name.trim()) throw new Error(`labels config ${path}.name must not be empty`);
      if (!/^[0-9a-fA-F]{6}$/.test(color ?? '')) throw new Error(`labels config ${path}.color must be six hex digits (no #), got "${color ?? ''}"`);
      if (typeof description !== 'string') throw new Error(`labels config ${path}.description is missing`);
      if (description.length > DESCRIPTION_MAX) throw new Error(`labels config ${path}.description is ${description.length} characters, GitHub allows ${DESCRIPTION_MAX}`);
      const key = name.trim().toLowerCase();
      if (seen.has(key)) throw new Error(`labels config ${path} and ${seen.get(key)} both name the label "${name.trim()}"`);
      seen.set(key, path);
      definitions.push({ name: name.trim(), color: color.toLowerCase(), description });
    }
  }
  return definitions;
}

async function listLabels(request) {
  const existing = [];
  for (let page = 1; ; page++) {
    const res = await request('GET', `/labels?per_page=${PER_PAGE}&page=${page}`);
    if (!res.ok) throw new Error(`GitHub API GET /labels (page ${page}) → ${res.status}`);
    const batch = Array.isArray(res.json) ? res.json : [];
    existing.push(...batch);
    if (batch.length < PER_PAGE) return existing;
  }
}

/**
 * `request(method, path, body?)` resolves `{ status, ok, json? }` (path relative to /repos/<owner>/<repo>).
 * Returns { created, existing, updated, drift }: label names. A label created by someone else between the
 * listing and the POST (422) counts as existing; any other failure throws.
 */
export async function ensureLabels({ request, definitions, update = false, dryRun = false }) {
  const present = new Map((await listLabels(request)).map((l) => [String(l.name).toLowerCase(), l]));
  const result = { created: [], existing: [], updated: [], drift: [] };
  for (const def of definitions) {
    const found = present.get(def.name.toLowerCase());
    if (!found) {
      if (!dryRun) {
        const res = await request('POST', '/labels', def);
        if (res.status === 422) { result.existing.push(def.name); continue; }
        if (!res.ok) throw new Error(`GitHub API POST /labels (${def.name}) → ${res.status}`);
      }
      result.created.push(def.name);
      continue;
    }
    result.existing.push(def.name);
    const drifted = String(found.color ?? '').toLowerCase() !== def.color || (found.description ?? '') !== def.description;
    if (!drifted) continue;
    result.drift.push(def.name);
    if (update && !dryRun) {
      const res = await request('PATCH', `/labels/${encodeURIComponent(found.name)}`, { color: def.color, description: def.description });
      if (!res.ok) throw new Error(`GitHub API PATCH /labels/${found.name} → ${res.status}`);
      result.updated.push(def.name);
    }
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const startMs = Date.now();
  const flags = new Set(process.argv.slice(2));
  const unknown = [...flags].filter((f) => !['--update', '--dry-run'].includes(f));
  const env = process.env;
  let repository = null;
  try {
    if (unknown.length) throw new Error(`unknown option ${unknown.join(', ')} (expected --update, --dry-run)`);
    repository = (env.GITHUB_REPOSITORY ?? '').trim();
    const token = (env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
    if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) are required');
    const definitions = labelDefinitions(loadLabelsConfigAll());
    obsLog({ stage: STAGE, event: 'labels_install.start', level: 'info', meta: { repository, labels: definitions.length, update: flags.has('--update'), dry_run: flags.has('--dry-run') } });
    const base = `${(env.GITHUB_API_URL || 'https://api.github.com').trim()}/repos/${repository}`;
    const request = async (method, apiPath, body) => {
      const res = await fetch(`${base}${apiPath}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, ok: res.ok, json };
    };
    const result = await ensureLabels({ request, definitions, update: flags.has('--update'), dryRun: flags.has('--dry-run') });
    const verb = flags.has('--dry-run') ? 'would create' : 'created';
    console.log(`${repository}: ${verb} ${result.created.length}, already present ${result.existing.length}${result.created.length ? ` (${verb}: ${result.created.join(', ')})` : ''}`);
    if (result.drift.length) {
      console.log(`${result.drift.length} label(s) differ from the config in color or description: ${result.drift.join(', ')}${flags.has('--update') ? ` — ${flags.has('--dry-run') ? 'would update' : 'updated'}` : ' — run with --update to bring them back'}`);
    }
    obsLog({ stage: STAGE, event: 'labels_install.complete', level: 'info', duration_ms: Date.now() - startMs, meta: { repository, created: result.created.length, existing: result.existing.length, updated: result.updated.length, drift: result.drift.length } });
  } catch (err) {
    obsLog({ stage: STAGE, event: 'labels_install.error', level: 'error', duration_ms: Date.now() - startMs, meta: { repository, error: err.message } });
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
