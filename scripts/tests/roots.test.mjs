import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PIPELINE_ROOT, DEFAULT_CONFIG_PATH, pipelineConfigDir, targetRoot, configRelPath, targetConfigDir,
  pipelineDefaultFile, repoConfigFile, describeRoots,
} from '../lib/roots.mjs';
import { overlayFlat, overlayNested, loadModelsConfig, loadLabelsConfigAll, modelsFromContent } from '../lib/layered_config.mjs';
import { defaultConfigFile, loadProtectedPaths, protectedPathsFor, DEFAULT_CONFIG_FILE, PROTECTED_FLOOR } from '../lib/protected_paths.mjs';
import { resolveConfig } from '../print_resolved_config.mjs';
import { resetLabels, resetLabelsFrom } from '../reset_auto_fix.mjs';
import { parseFlatYaml } from '../lib/yaml.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withTargetConfig(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-cfg-'));
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the pipeline root is the repository holding the scripts, whatever the working directory', () => {
  assert.equal(PIPELINE_ROOT, REPO);
  assert.equal(pipelineConfigDir(), path.join(REPO, DEFAULT_CONFIG_PATH));
  assert.equal(pipelineDefaultFile('models.yaml'), path.join(REPO, 'config', 'models.yaml'));
});

test('the target root is the working directory unless ADL_TARGET_ROOT says otherwise', () => {
  assert.equal(targetRoot({}), process.cwd());
  assert.equal(targetRoot({ ADL_TARGET_ROOT: '' }), process.cwd());
  assert.equal(targetRoot({ ADL_TARGET_ROOT: '/srv/target' }), path.resolve('/srv/target'));
});

test('configRelPath defaults to config and normalizes a trailing slash', () => {
  assert.equal(configRelPath({}), 'config');
  assert.equal(configRelPath({ ADL_CONFIG_PATH: '  ' }), 'config');
  assert.equal(configRelPath({ ADL_CONFIG_PATH: '.autonomous-dev-loop' }), '.autonomous-dev-loop');
  assert.equal(configRelPath({ ADL_CONFIG_PATH: 'ci/adl//' }), 'ci/adl');
});

test('configRelPath rejects absolute, dot-relative, parent, backslash and empty-segment paths', () => {
  for (const bad of ['/etc', './adl', '../adl', 'a/../b', 'a\\b', 'a//b', '/', 'ci/./adl', 'ci/adl/.', '.', 'ci/adl/./']) {
    assert.throws(() => configRelPath({ ADL_CONFIG_PATH: bad }), /ADL_CONFIG_PATH .* must be a relative path/, bad);
  }
});

test('targetConfigDir is null in the repository own mode and absolute otherwise', () => {
  assert.equal(targetConfigDir({}), null);
  assert.equal(targetConfigDir({ ADL_CONFIG_DIR: '  ' }), null);
  assert.equal(targetConfigDir({ ADL_CONFIG_DIR: '/tmp/x/.adl' }), path.resolve('/tmp/x/.adl'));
});

test('a relative ADL_CONFIG_DIR is an error: it would resolve inside the pull request checkout', () => {
  for (const bad of ['.autonomous-dev-loop', './adl', '../adl', 'adl/config']) {
    assert.throws(() => targetConfigDir({ ADL_CONFIG_DIR: bad }), /ADL_CONFIG_DIR ".*" must be an absolute path/, bad);
  }
  assert.throws(() => repoConfigFile('models.yaml', { ADL_CONFIG_DIR: 'adl' }), /must be an absolute path/);
  assert.throws(() => describeRoots({ ADL_CONFIG_DIR: 'adl' }), /must be an absolute path/);
});

test('repoConfigFile reads the pipeline config/ in own mode and the target directory otherwise, never both', () => {
  assert.equal(repoConfigFile('review-evidence.yaml', {}), path.join(REPO, 'config', 'review-evidence.yaml'));
  assert.equal(repoConfigFile('review-evidence.yaml', { ADL_CONFIG_DIR: '/tmp/t/.adl' }), path.join(path.resolve('/tmp/t/.adl'), 'review-evidence.yaml'));
});

test('describeRoots names the mode and the three roots', () => {
  const own = describeRoots({});
  assert.equal(own.mode, 'pipeline-repo');
  assert.equal(own.configDir, pipelineConfigDir());
  const target = describeRoots({ ADL_CONFIG_DIR: '/tmp/t/.adl', ADL_CONFIG_PATH: '.adl', ADL_TARGET_ROOT: '/tmp/t' });
  assert.deepEqual(target, { mode: 'target', pipelineRoot: REPO, targetRoot: path.resolve('/tmp/t'), configDir: path.resolve('/tmp/t/.adl'), configRelPath: '.adl' });
});

test('overlayFlat lays the override keys over the defaults without mutating them', () => {
  const defaults = { a: '1', b: '2' };
  assert.deepEqual(overlayFlat(defaults, { b: '3' }, 'f'), { a: '1', b: '3' });
  assert.deepEqual(defaults, { a: '1', b: '2' });
  assert.deepEqual(overlayFlat(defaults, {}, 'f'), defaults);
});

test('overlayFlat rejects a key the defaults do not know, naming the file and the key', () => {
  assert.throws(() => overlayFlat({ a: '1' }, { typo: 'x' }, 'models.yaml (t)'), /models\.yaml \(t\): unknown key "typo"/);
});

test('overlayNested overrides at leaf level and keeps the other leaves, without mutating the defaults', () => {
  const defaults = { review: { changes: { name: 'changes-requested', color: 'red' }, ok: { name: 'approved' } } };
  const merged = overlayNested(defaults, { review: { changes: { name: 'needs-work' } } }, 'labels.yaml');
  assert.deepEqual(merged, { review: { changes: { name: 'needs-work', color: 'red' }, ok: { name: 'approved' } } });
  assert.equal(defaults.review.changes.name, 'changes-requested');
});

test('overlayNested rejects an unknown group, section or leaf with its path', () => {
  const defaults = { review: { changes: { name: 'x' } } };
  assert.throws(() => overlayNested(defaults, { nope: {} }, 'labels.yaml'), /labels\.yaml: unknown group "nope"/);
  assert.throws(() => overlayNested(defaults, { review: { nope: {} } }, 'labels.yaml'), /unknown section "review\.nope"/);
  assert.throws(() => overlayNested(defaults, { review: { changes: { nope: 'x' } } }, 'labels.yaml'), /unknown key "review\.changes\.nope"/);
});

test('in the repository own mode the effective config is exactly the pipeline defaults', () => {
  const models = loadModelsConfig({});
  assert.deepEqual(models, parseFlatYaml(fs.readFileSync(path.join(REPO, 'config', 'models.yaml'), 'utf8')));
  assert.equal(loadLabelsConfigAll({}).review.changes.name, 'changes-requested');
});

test('a target layer overrides one key and keeps every other default', () => {
  withTargetConfig({ 'models.yaml': 'anthropic_review_effort: low\n', 'labels.yaml': 'review:\n  changes:\n    name: needs-work\n' }, (dir) => {
    const env = { ADL_CONFIG_DIR: dir };
    const models = loadModelsConfig(env);
    assert.equal(models.anthropic_review_effort, 'low');
    assert.equal(models.anthropic_validation, loadModelsConfig({}).anthropic_validation);
    const labels = loadLabelsConfigAll(env);
    assert.equal(labels.review.changes.name, 'needs-work');
    assert.equal(labels.issue.valid.name, loadLabelsConfigAll({}).issue.valid.name);
  });
});

test('a target without models.yaml or labels.yaml gets the defaults', () => {
  withTargetConfig({}, (dir) => {
    assert.deepEqual(loadModelsConfig({ ADL_CONFIG_DIR: dir }), loadModelsConfig({}));
    assert.deepEqual(loadLabelsConfigAll({ ADL_CONFIG_DIR: dir }), loadLabelsConfigAll({}));
  });
  assert.deepEqual(loadModelsConfig({ ADL_CONFIG_DIR: path.join(os.tmpdir(), 'adl-does-not-exist') }), loadModelsConfig({}));
});

test('a target key the defaults do not know fails with the file path and the key', () => {
  withTargetConfig({ 'models.yaml': 'not_a_real_key: 1\n' }, (dir) => {
    assert.throws(() => loadModelsConfig({ ADL_CONFIG_DIR: dir }), /models\.yaml .*: unknown key "not_a_real_key"/);
  });
  withTargetConfig({ 'labels.yaml': 'review:\n  changes:\n    nope: x\n' }, (dir) => {
    assert.throws(() => loadLabelsConfigAll({ ADL_CONFIG_DIR: dir }), /unknown key "review\.changes\.nope"/);
  });
});

test('an unreadable target file (a directory in its place) is an error, not a silent default', () => {
  withTargetConfig({}, (dir) => {
    fs.mkdirSync(path.join(dir, 'models.yaml'));
    assert.throws(() => loadModelsConfig({ ADL_CONFIG_DIR: dir }), /EISDIR/);
  });
});

test('modelsFromContent parses the whole file in own mode and overlays it for a target', () => {
  assert.deepEqual(modelsFromContent('a: 1\n', {}), { a: '1' });
  const merged = modelsFromContent('anthropic_review_effort: low\n', { ADL_CONFIG_DIR: '/tmp/t' });
  assert.equal(merged.anthropic_review_effort, 'low');
  assert.equal(merged.anthropic_validation, loadModelsConfig({}).anthropic_validation);
  assert.throws(() => modelsFromContent('typo: 1\n', { ADL_CONFIG_DIR: '/tmp/t' }), /pull request head\): unknown key "typo"/);
});

test('the protected paths list is read next to the scripts in own mode and from the target directory otherwise', () => {
  assert.equal(defaultConfigFile({}), DEFAULT_CONFIG_FILE);
  assert.equal(defaultConfigFile({ ADL_CONFIG_DIR: '/tmp/t/.adl' }), path.join(path.resolve('/tmp/t/.adl'), 'protected-paths.yaml'));
});

test('a target config directory is protected as a whole, and an empty target list removes no floor entry', () => {
  withTargetConfig({ 'protected-paths.yaml': 'protected_paths: []\n' }, (dir) => {
    const saved = { ...process.env };
    process.env.ADL_CONFIG_DIR = dir;
    process.env.ADL_CONFIG_PATH = 'ci/adl';
    try {
      const list = loadProtectedPaths();
      assert.ok(list.includes('ci/adl/'));
      for (const entry of PROTECTED_FLOOR) assert.ok(list.includes(entry), `lost ${entry}`);
      // Own mode: no extra directory entry.
      delete process.env.ADL_CONFIG_DIR;
      assert.ok(!loadProtectedPaths().includes('ci/adl/'));
    } finally {
      for (const key of ['ADL_CONFIG_DIR', 'ADL_CONFIG_PATH']) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; }
    }
  });
});

test('protectedPathsFor answers for the given environment, not the process one', () => {
  withTargetConfig({ 'protected-paths.yaml': 'protected_paths:\n  - infra/\n' }, (dir) => {
    const env = { ADL_CONFIG_DIR: dir, ADL_CONFIG_PATH: 'ci/adl' };
    const list = protectedPathsFor(env);
    assert.ok(list.includes('infra/') && list.includes('ci/adl/'));
    assert.ok(!list.includes('scripts/'), 'the pipeline repository policy is not inherited');
    // The process environment of this test run is untouched: own mode, this repository's list.
    assert.ok(!protectedPathsFor({}).includes('ci/adl/') && protectedPathsFor({}).includes('scripts/'));
    assert.ok(!protectedPathsFor({}).includes('infra/'));
  });
});

test('resolveConfig reports the protected paths of the environment it is given', () => {
  withTargetConfig({ 'protected-paths.yaml': 'protected_paths:\n  - infra/\n' }, (dir) => {
    const report = resolveConfig({ ADL_CONFIG_DIR: dir, ADL_CONFIG_PATH: 'ci/adl' });
    assert.ok(report.protectedPaths.includes('ci/adl/') && report.protectedPaths.includes('infra/'));
    assert.equal(report.roots.mode, 'target');
    assert.equal(resolveConfig({}).roots.mode, 'pipeline-repo');
    assert.ok(!resolveConfig({}).protectedPaths.includes('infra/'));
  });
});

test('an explicit file is read as is: the target config directory is not added to it', () => {
  withTargetConfig({ 'other.yaml': 'protected_paths:\n  - extra/\n' }, (dir) => {
    const saved = { ...process.env };
    process.env.ADL_CONFIG_DIR = dir;
    process.env.ADL_CONFIG_PATH = 'ci/adl';
    try {
      const list = loadProtectedPaths(path.join(dir, 'other.yaml'));
      assert.ok(list.includes('extra/'));
      assert.ok(!list.includes('ci/adl/'));
    } finally {
      for (const key of ['ADL_CONFIG_DIR', 'ADL_CONFIG_PATH']) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; }
    }
  });
});

test('a target without protected-paths.yaml protects the floor and its config directory only', () => {
  withTargetConfig({}, (dir) => {
    const saved = process.env.ADL_CONFIG_DIR;
    process.env.ADL_CONFIG_DIR = dir;
    try {
      const list = loadProtectedPaths();
      assert.ok(!list.includes('scripts/') && !list.includes('docs/'), 'the pipeline repository policy is not inherited');
    } finally {
      if (saved === undefined) delete process.env.ADL_CONFIG_DIR; else process.env.ADL_CONFIG_DIR = saved;
    }
  });
});

test('resetLabelsFrom takes the layered labels; resetLabels still parses a YAML string', () => {
  const yaml = fs.readFileSync(path.join(REPO, 'config', 'labels.yaml'), 'utf8');
  assert.deepEqual(resetLabels(yaml), resetLabelsFrom(loadLabelsConfigAll({})));
  const overlaid = overlayNested(loadLabelsConfigAll({}), { review: { changes: { name: 'needs-work' } } }, 'labels.yaml');
  assert.equal(resetLabelsFrom(overlaid).changesLabel, 'needs-work');
});

// ADR-0045: roots.mjs is the one module that turns the location of a script into a root. Everywhere
// else the working directory is the target and the pipeline root is imported; a script that computed
// its own root from import.meta.url would silently read the wrong tree once the pipeline is checked out
// next to the repository it works on.
const INTERNAL_REPO_ROOT_USERS = new Set([
  // Eval harness and dashboards run on this repository only (evals stay internal, ADR-0045).
  'scripts/run_evals.mjs', 'scripts/plan_pr_evals.mjs', 'scripts/build_eval_site.mjs', 'scripts/lib/eval_replay_ci.mjs',
]);
const CLI_DETECTION = /process\.argv\[1\] === fileURLToPath\(import\.meta\.url\)/;

function pipelineSources() {
  const files = [];
  for (const dir of ['scripts', 'scripts/lib']) {
    for (const name of fs.readdirSync(path.join(REPO, dir))) if (name.endsWith('.mjs')) files.push(`${dir}/${name}`);
  }
  return files;
}

test('no script derives a root from import.meta.url except roots.mjs and the internal eval tools', () => {
  const offenders = [];
  for (const file of pipelineSources()) {
    if (file === 'scripts/lib/roots.mjs' || INTERNAL_REPO_ROOT_USERS.has(file)) continue;
    const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/import\.meta\.(url|dirname|filename)/.test(line) && !CLI_DETECTION.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'import roots from scripts/lib/roots.mjs instead');
});

test('the internal eval tools are the only other users of a script-relative root (the allowlist cannot rot)', () => {
  for (const file of INTERNAL_REPO_ROOT_USERS) {
    assert.ok(fs.existsSync(path.join(REPO, file)), `${file} no longer exists: drop it from the allowlist`);
    assert.match(fs.readFileSync(path.join(REPO, file), 'utf8'), /import\.meta\.url/, `${file} no longer uses import.meta.url: drop it from the allowlist`);
  }
});

test('run state is written under the working directory (the target), never next to the scripts', () => {
  for (const [file, needle] of [
    ['scripts/pr_review.mjs', "path.join(process.cwd(), 'observability', 'traces')"],
    ['scripts/auto_fix_pr.mjs', "path.join(process.cwd(), 'observability', 'traces')"],
    ['scripts/generate_issue_change.mjs', "path.join(process.cwd(), 'observability', 'traces')"],
    ['scripts/validate_issue.mjs', "path.join(process.cwd(), 'observability', 'traces')"],
    ['scripts/run_review_evidence.mjs', "path.join(process.cwd(), 'observability', 'traces')"],
    ['scripts/commit_run_record.mjs', "path.join(process.cwd(), 'observability', 'traces')"],
    ['scripts/lib/checkpoint.mjs', "path.resolve('./checkpoints')"],
    ['scripts/lib/metrics.mjs', "path.resolve('./metrics/runs.jsonl')"],
  ]) {
    assert.ok(fs.readFileSync(path.join(REPO, file), 'utf8').includes(needle), `${file} must keep ${needle}`);
  }
});
