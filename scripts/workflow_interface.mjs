#!/usr/bin/env node
/**
 * The interface of the reusable workflows (ADR-0045): for each .github/workflows/adl-*.yml, its inputs, its
 * secrets and the permission ceiling a caller must grant (the union of the scopes of its jobs). It is what a
 * caller depends on, so a change to it is the definition of a breaking change; docs/workflow-interface.json
 * is the committed snapshot and the test suite fails when the workflows and the snapshot differ.
 *
 *   node scripts/workflow_interface.mjs            check the snapshot (same as --check)
 *   node scripts/workflow_interface.mjs --write    regenerate the snapshot
 *   node scripts/workflow_interface.mjs --base <old-snapshot.json>
 *                                                  list the breaking changes since an older snapshot (release time)
 * Options: --snapshot <file> (default docs/workflow-interface.json), --workflows <dir> (default .github/workflows).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_ROOT } from './lib/roots.mjs';

export const SNAPSHOT_PATH = 'docs/workflow-interface.json';
const LEVEL = { read: 1, write: 2 };

const unquote = (raw) => {
  const v = String(raw).trim();
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
};

// Entries of an indented mapping: `key:` at `indent` spaces, its fields at `indent + 2`.
function entries(block, indent) {
  const out = {};
  let current = null;
  const head = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):\\s*$`);
  const field = new RegExp(`^ {${indent + 2}}([a-z_]+):\\s*(.*)$`);
  for (const line of block.split('\n')) {
    const h = head.exec(line);
    if (h) { current = out[h[1]] = {}; continue; }
    const f = current && field.exec(line);
    if (f) current[f[1]] = unquote(f[2]);
  }
  return out;
}

/** inputs, secrets, jobs and ceiling of one reusable workflow's text. */
export function readInterface(text) {
  const on = text.slice(text.indexOf('\non:\n'), text.search(/\npermissions:\n/));
  if (!/\n {2}workflow_call:\n/.test(on)) throw new Error('not a reusable workflow (no on.workflow_call)');
  const inputsBlock = on.slice(on.indexOf('\n    inputs:\n') + '\n    inputs:\n'.length, on.includes('\n    secrets:\n') ? on.indexOf('\n    secrets:\n') : undefined);
  const secretsBlock = on.includes('\n    secrets:\n') ? on.slice(on.indexOf('\n    secrets:\n') + '\n    secrets:\n'.length) : '';
  const inputs = Object.fromEntries(Object.entries(entries(inputsBlock, 6)).map(([name, f]) => [name, {
    type: f.type ?? 'string',
    required: f.required === 'true',
    ...(f.default !== undefined ? { default: f.default } : {}),
  }]));
  const secrets = Object.fromEntries(Object.entries(entries(secretsBlock, 6)).map(([name, f]) => [name, { required: f.required === 'true' }]));
  const jobsText = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const jobs = [];
  const ceiling = {};
  for (const chunk of jobsText.split(/\n(?=  [A-Za-z0-9_-]+:\n)/)) {
    const name = chunk.match(/^\s*([A-Za-z0-9_-]+):/)?.[1];
    if (!name) continue;
    jobs.push(name);
    const block = chunk.match(/\n {4}permissions:\n((?: {6}.+\n)+)/)?.[1] ?? '';
    for (const line of block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
      const [scope, level] = line.split(/:\s*/);
      if ((LEVEL[level] ?? 0) > (LEVEL[ceiling[scope]] ?? 0)) ceiling[scope] = level;
    }
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { inputs: sorted(inputs), secrets: sorted(secrets), jobs, ceiling: sorted(ceiling) };
}

/** { 'adl-x.yml': interface } for every reusable workflow of a workflows directory. */
export function readAllInterfaces(dir) {
  const out = {};
  for (const file of readdirSync(dir).filter((f) => /^adl-[^/]+\.yml$/.test(f)).sort()) {
    out[file] = readInterface(readFileSync(path.join(dir, file), 'utf8'));
  }
  return out;
}

/**
 * What a caller written against `before` cannot rely on in `after`: a workflow, input or secret removed; an
 * input whose type or default changed, or that became required (or is new and required without a default); a
 * secret that became required; a permission ceiling that grew (a scope added or raised). Additions of optional
 * inputs and secrets, new workflows and a smaller ceiling are not breaking.
 * @returns {string[]}
 */
export function compareInterfaces(before, after) {
  const breaking = [];
  for (const [file, old] of Object.entries(before)) {
    const now = after[file];
    if (!now) { breaking.push(`${file}: removed`); continue; }
    for (const [name, spec] of Object.entries(old.inputs)) {
      const next = now.inputs[name];
      if (!next) { breaking.push(`${file}: input ${name} removed`); continue; }
      if (next.type !== spec.type) breaking.push(`${file}: input ${name} changed type ${spec.type} → ${next.type}`);
      if (next.required && !spec.required) breaking.push(`${file}: input ${name} became required`);
      if (next.default !== spec.default) breaking.push(`${file}: input ${name} default changed ${JSON.stringify(spec.default ?? null)} → ${JSON.stringify(next.default ?? null)}`);
    }
    for (const [name, spec] of Object.entries(now.inputs)) {
      if (!old.inputs[name] && spec.required && spec.default === undefined) breaking.push(`${file}: new required input ${name}`);
    }
    for (const [name, spec] of Object.entries(old.secrets)) {
      const next = now.secrets[name];
      if (!next) breaking.push(`${file}: secret ${name} removed`);
      else if (next.required && !spec.required) breaking.push(`${file}: secret ${name} became required`);
    }
    for (const [name, spec] of Object.entries(now.secrets)) {
      if (!old.secrets[name] && spec.required) breaking.push(`${file}: new required secret ${name}`);
    }
    for (const [scope, level] of Object.entries(now.ceiling)) {
      const was = old.ceiling[scope];
      if (!was) breaking.push(`${file}: permission ${scope}: ${level} added to the ceiling`);
      else if ((LEVEL[level] ?? 0) > (LEVEL[was] ?? 0)) breaking.push(`${file}: permission ${scope} raised ${was} → ${level}`);
    }
  }
  return breaking;
}

export function formatSnapshot(interfaces) {
  return `${JSON.stringify(interfaces, null, 2)}\n`;
}

/** Differences between the committed snapshot and the workflows, one line each (empty = in sync). */
export function snapshotDrift(snapshot, current) {
  const drift = [];
  for (const file of new Set([...Object.keys(snapshot), ...Object.keys(current)])) {
    if (!snapshot[file]) drift.push(`${file}: not in the snapshot`);
    else if (!current[file]) drift.push(`${file}: in the snapshot but not a reusable workflow any more`);
    else if (JSON.stringify(snapshot[file]) !== JSON.stringify(current[file])) drift.push(`${file}: its interface differs from the snapshot`);
  }
  return drift.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const option = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };
    const known = new Set(['--write', '--check', '--base', '--snapshot', '--workflows']);
    const stray = args.filter((a) => a.startsWith('--') && !known.has(a));
    if (stray.length) throw new Error(`unknown option ${stray.join(', ')}`);
    for (const name of ['--base', '--snapshot', '--workflows']) if (args.includes(name) && !option(name)) throw new Error(`${name} needs a value`);
    const snapshotFile = path.resolve(option('--snapshot') ?? path.join(PIPELINE_ROOT, SNAPSHOT_PATH));
    const current = readAllInterfaces(path.resolve(option('--workflows') ?? path.join(PIPELINE_ROOT, '.github/workflows')));
    if (args.includes('--write')) {
      writeFileSync(snapshotFile, formatSnapshot(current));
      console.log(`wrote ${snapshotFile} (${Object.keys(current).length} reusable workflows)`);
    } else if (option('--base')) {
      const breaking = compareInterfaces(JSON.parse(readFileSync(path.resolve(option('--base')), 'utf8')), current);
      if (breaking.length) {
        console.log(`Breaking changes for a caller (${breaking.length}): a new major version.\n${breaking.map((b) => `- ${b}`).join('\n')}`);
        process.exit(1);
      }
      console.log('No breaking change for a caller since the base snapshot.');
    } else {
      const drift = snapshotDrift(JSON.parse(readFileSync(snapshotFile, 'utf8')), current);
      if (drift.length) {
        console.error(`::error::The reusable workflows and ${path.relative(process.cwd(), snapshotFile) || snapshotFile} differ:\n${drift.map((d) => `- ${d}`).join('\n')}\nRun: node scripts/workflow_interface.mjs --write, review the diff, and add a CHANGELOG entry (### Breaking when node scripts/workflow_interface.mjs --base <previous snapshot> lists a change).`);
        process.exit(1);
      }
      console.log(`Snapshot in sync (${Object.keys(current).length} reusable workflows).`);
    }
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
