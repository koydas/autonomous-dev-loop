import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ADR-0045: a repository that only holds its own configuration. The fixture is copied to a temp
// directory and every pipeline entrypoint runs from there (as a child process, working directory =
// the target) while the scripts stay where they are: the two roots are two different trees.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(REPO, 'scripts', 'tests', 'fixtures', 'consumer-repo');
const CONFIG_REL = '.autonomous-dev-loop';

function withConsumer(fn, { git = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adl-consumer-')));
  try {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    if (git) {
      const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      run('init', '-q');
      run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A');
      run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'fixture');
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A trusted config checkout lives outside the workspace (ADR-0045): here, the fixture's own directory.
const targetEnv = (dir, extra = {}) => ({
  ...process.env,
  ADL_CONFIG_DIR: path.join(dir, CONFIG_REL),
  ADL_CONFIG_PATH: CONFIG_REL,
  ...extra,
});

function runScript(script, dir, env, args = []) {
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], { cwd: dir, env, encoding: 'utf8' });
}

function resolved(dir, env) {
  const res = runScript('print_resolved_config.mjs', dir, env);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('the two roots are different trees: scripts from the pipeline, state and config from the consumer', () => {
  withConsumer((dir) => {
    const out = resolved(dir, targetEnv(dir));
    assert.equal(out.roots.mode, 'target');
    assert.equal(out.roots.pipelineRoot, REPO);
    assert.equal(out.roots.targetRoot, dir);
    assert.notEqual(out.roots.pipelineRoot, out.roots.targetRoot);
    assert.equal(out.roots.configDir, path.join(dir, CONFIG_REL));
    assert.equal(out.roots.configRelPath, CONFIG_REL);
  });
});

test('the consumer layer overrides one model key; the other defaults and the labels come from the pipeline', () => {
  withConsumer((dir) => {
    const out = resolved(dir, targetEnv(dir));
    assert.deepEqual(out.modelsOverridden, ['anthropic_review_effort']);
    assert.equal(out.files['models.yaml'].target, path.join(dir, CONFIG_REL, 'models.yaml'));
    assert.equal(out.files['models.yaml'].default, path.join(REPO, 'config', 'models.yaml'));
    assert.equal(out.files['labels.yaml'].target, null);
    assert.deepEqual(out.labels, { ready: 'ready-for-dev', changes: 'changes-requested' });
  });
});

test('the protected list is the floor plus the consumer list plus its config directory, never this repository policy', () => {
  withConsumer((dir) => {
    const { protectedPaths } = resolved(dir, targetEnv(dir));
    for (const entry of ['.git/', '.github/', 'package.json', '*.csproj', 'infra/', '*.tf', `${CONFIG_REL}/`]) {
      assert.ok(protectedPaths.includes(entry), `missing ${entry}`);
    }
    for (const entry of ['scripts/', 'prompts/', 'docs/', 'README.md', 'metrics/']) {
      assert.ok(!protectedPaths.includes(entry), `${entry} is this repository policy, not the consumer's`);
    }
  });
});

test('an empty consumer list keeps the floor and the config directory (the floor is never overridable)', () => {
  withConsumer((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_REL, 'protected-paths.yaml'), 'protected_paths: []\n');
    const { protectedPaths } = resolved(dir, targetEnv(dir));
    for (const entry of ['.git/', '.github/', 'package.json', '*.csproj', `${CONFIG_REL}/`]) assert.ok(protectedPaths.includes(entry), `lost ${entry}`);
    assert.ok(!protectedPaths.includes('infra/'));
  });
});

test('a consumer without any configuration gets the defaults, the floor, and no review evidence requirement', () => {
  withConsumer((dir) => {
    fs.rmSync(path.join(dir, CONFIG_REL), { recursive: true });
    const out = resolved(dir, targetEnv(dir));
    assert.deepEqual(out.modelsOverridden, []);
    assert.equal(out.evidenceRequired, false);
    assert.equal(out.files['protected-paths.yaml'].present, false);
    assert.ok(out.protectedPaths.includes('.github/') && out.protectedPaths.includes(`${CONFIG_REL}/`));
  });
});

test('review evidence is required exactly when the consumer declares it', () => {
  withConsumer((dir) => {
    assert.equal(resolved(dir, targetEnv(dir)).evidenceRequired, true);
    // Own mode (no ADL_CONFIG_DIR) reads this repository's file, whatever the consumer holds.
    const own = resolved(dir, { ...process.env, ADL_CONFIG_DIR: '', ADL_CONFIG_PATH: '' });
    assert.equal(own.roots.mode, 'pipeline-repo');
    assert.equal(own.files['review-evidence.yaml'].path, path.join(REPO, 'config', 'review-evidence.yaml'));
  });
});

test('prompts come from the pipeline root; the consumer decoy prompt is never loaded', () => {
  withConsumer((dir) => {
    assert.ok(fs.existsSync(path.join(dir, 'prompts', 'validation-system.md')), 'the decoy must exist');
    const code = `import { loadPrompt } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/lib/prompts.mjs')).href)};
      process.stdout.write(loadPrompt('validation-system'));`;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: targetEnv(dir), encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, fs.readFileSync(path.join(REPO, 'prompts', 'validation-system.md'), 'utf8').trim());
    assert.ok(!res.stdout.includes('Decoy'));
  });
});

test('run_review_evidence reads the consumer config, checks the consumer tree and writes its trace there', () => {
  withConsumer((dir) => {
    const evidence = path.join(dir, '..', `adl-evidence-${path.basename(dir)}`, 'review-evidence.json');
    const before = fs.existsSync(path.join(REPO, 'observability', 'traces')) ? fs.readdirSync(path.join(REPO, 'observability', 'traces')) : [];
    const res = runScript('run_review_evidence.mjs', dir, targetEnv(dir, { REVIEW_EVIDENCE_PATH: evidence, GITHUB_RUN_ID: '4242' }));
    try {
      assert.equal(res.status, 0, res.stderr);
      const written = JSON.parse(fs.readFileSync(evidence, 'utf8'));
      assert.deepEqual(written.checks.map((c) => [c.name, c.status]), [['smoke', 'pass']]);
      assert.equal(written.head_sha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
      assert.ok(fs.existsSync(path.join(dir, 'observability', 'traces', '4242-evidence.json')), 'the trace belongs to the target');
      const after = fs.existsSync(path.join(REPO, 'observability', 'traces')) ? fs.readdirSync(path.join(REPO, 'observability', 'traces')) : [];
      assert.deepEqual(after, before, 'nothing is written under the pipeline root');
    } finally {
      fs.rmSync(path.dirname(evidence), { recursive: true, force: true });
    }
  }, { git: true });
});

test('run_review_evidence without a consumer config skips cleanly and writes no evidence', () => {
  withConsumer((dir) => {
    fs.rmSync(path.join(dir, CONFIG_REL, 'review-evidence.yaml'));
    const evidence = path.join(dir, 'out', 'review-evidence.json');
    const res = runScript('run_review_evidence.mjs', dir, targetEnv(dir, { REVIEW_EVIDENCE_PATH: evidence, GITHUB_RUN_ID: '4243' }));
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!fs.existsSync(evidence));
  });
});

test('an invalid consumer configuration fails fast with the file and the key', () => {
  withConsumer((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_REL, 'models.yaml'), 'anthropic_review_effrot: low\n');
    const res = runScript('print_resolved_config.mjs', dir, targetEnv(dir));
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /models\.yaml .*: unknown key "anthropic_review_effrot"/);
  });
  withConsumer((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_REL, 'protected-paths.yaml'), 'protected_paths:\n  - ../escape\n');
    const res = runScript('print_resolved_config.mjs', dir, targetEnv(dir));
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /protected_paths\[0\]/);
  });
  withConsumer((dir) => {
    const res = runScript('print_resolved_config.mjs', dir, targetEnv(dir, { ADL_CONFIG_PATH: '../up' }));
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /ADL_CONFIG_PATH/);
  });
});
