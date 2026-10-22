#!/usr/bin/env node
// Run the c8 coverage gates of config/coverage-gates.json (the CI step of test.yml, and the local command), or
// rewrite the list of gated files in the review prompt from that config.
// Usage: node scripts/coverage_gates.mjs [--only <scripts/lib/module.mjs>]   run the gates (all, or one)
//        node scripts/coverage_gates.mjs --sync                              rewrite the gate (c) list of prompts/pr-review-repo-rules.md
// Every gate runs even if one fails; the exit status is 1 if any did. Node ≥ 20, no external dependency.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GATES_CONFIG_PATH, parseGates, runGates, syncGatePrompt } from './lib/coverage_gates.mjs';
import { PIPELINE_ROOT as ROOT } from './lib/roots.mjs';

const PROMPT_PATH = path.join(ROOT, 'prompts', 'pr-review-repo-rules.md');
const USAGE = 'Usage: node scripts/coverage_gates.mjs [--only <scripts/lib/module.mjs> | --sync]';

export function parseArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 1 && argv[0] === '--sync') return { sync: true };
  if (argv.length === 2 && argv[0] === '--only' && argv[1] && !argv[1].startsWith('-')) return { only: argv[1] };
  throw new Error(`unknown arguments ${JSON.stringify(argv)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const config = parseGates(readFileSync(path.join(ROOT, GATES_CONFIG_PATH), 'utf8'));
    if (args.sync) {
      const before = readFileSync(PROMPT_PATH, 'utf8');
      const after = syncGatePrompt(before, config.gates);
      if (after !== before) writeFileSync(PROMPT_PATH, after);
      console.log(after === before ? 'prompts/pr-review-repo-rules.md already lists the gated files' : 'prompts/pr-review-repo-rules.md: gated files rewritten');
    } else {
      // npx has no Windows-neutral spawn without a shell; the gates run in CI (Linux) and locally on any POSIX shell.
      const run = (npxArgs) => spawnSync('npx', npxArgs, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
      const { results, failed } = runGates(config, run, { only: args.only ?? null, log: console.log });
      console.log(`${results.length - failed.length} of ${results.length} coverage gate(s) passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
      if (failed.length) process.exit(1);
    }
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
}
