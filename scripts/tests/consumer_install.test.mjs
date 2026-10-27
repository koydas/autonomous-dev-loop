import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseInstallArgs,
  pickReleaseTag,
  validatePin,
  renderTemplate,
  planInstall,
  UNTAGGED,
} from '../lib/consumer_install.mjs';
import { install } from '../install_consumer.mjs';

// ADR-0045: the installer renders templates/consumer/ for another repository, pinned to the clone's HEAD.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATES = path.join(REPO, 'templates', 'consumer');
const SHA = 'a'.repeat(40);
const PIN = { sha: SHA, version: 'v1.2.3', defaultBranch: 'main' };

// --- parseInstallArgs ---

test('parseInstallArgs: defaults', () => {
  assert.deepEqual(parseInstallArgs([]), { target: '.', defaultBranch: null, force: false, dryRun: false, allowUntagged: false });
});

test('parseInstallArgs: every flag', () => {
  assert.deepEqual(
    parseInstallArgs(['--target', 'x', '--default-branch', 'trunk', '--force', '--dry-run', '--allow-untagged']),
    { target: 'x', defaultBranch: 'trunk', force: true, dryRun: true, allowUntagged: true },
  );
});

test('parseInstallArgs: a flag missing its value or followed by another flag throws', () => {
  assert.throws(() => parseInstallArgs(['--target']), /--target needs a value/);
  assert.throws(() => parseInstallArgs(['--default-branch', '--force']), /--default-branch needs a value/);
});

test('parseInstallArgs: an unknown argument throws', () => {
  assert.throws(() => parseInstallArgs(['--sha', SHA]), /unknown argument: --sha/);
});

// --- pickReleaseTag ---

test('pickReleaseTag: the highest semver tag, numerically, other names ignored', () => {
  assert.equal(pickReleaseTag(['v1.9.0', 'v1.10.0', 'v1.2.30', 'latest', 'v2', '']), 'v1.10.0');
  assert.equal(pickReleaseTag(['v0.1.1', 'v0.1.0']), 'v0.1.1');
  assert.equal(pickReleaseTag(['v2.0.0', 'v10.0.0']), 'v10.0.0');
});

test('pickReleaseTag: no release tag → null', () => {
  assert.equal(pickReleaseTag([]), null);
  assert.equal(pickReleaseTag(['', 'v1', 'release-1.0.0']), null);
});

// --- validatePin ---

test('validatePin: accepts a release and the untagged marker', () => {
  validatePin(PIN);
  validatePin({ ...PIN, version: UNTAGGED, defaultBranch: 'release/2.x' });
});

test('validatePin: rejects a short or uppercase SHA, a non-semver version, an unsafe branch', () => {
  assert.throws(() => validatePin({ ...PIN, sha: 'abc' }), /^Error: sha:/);
  assert.throws(() => validatePin({ ...PIN, sha: 'A'.repeat(40) }), /^Error: sha:/);
  assert.throws(() => validatePin({ ...PIN, sha: undefined }), /^Error: sha:/);
  assert.throws(() => validatePin({ ...PIN, version: 'main' }), /^Error: version:/);
  assert.throws(() => validatePin({ ...PIN, version: undefined }), /^Error: version:/);
  for (const b of ['', '-x', 'a b', 'a"]', 'a,b', undefined]) {
    assert.throws(() => validatePin({ ...PIN, defaultBranch: b }), /^Error: defaultBranch:/, String(b));
  }
});

// --- renderTemplate on the shipped templates ---

const shipped = fs.readdirSync(TEMPLATES).filter((n) => n.endsWith('.yml')).sort();

test('renderTemplate: every shipped template renders with no placeholder left and the pin in place', () => {
  assert.ok(shipped.length >= 7);
  for (const name of shipped) {
    const out = renderTemplate(name, fs.readFileSync(path.join(TEMPLATES, name), 'utf8'), PIN);
    assert.ok(!out.includes('<PIPELINE_'), name);
    // install.yml takes the version as a workflow input: the only template with no pin to fill.
    if (name === 'install.yml') assert.ok(!out.includes(SHA), name);
    else assert.ok(out.includes(`${SHA} # v1.2.3`), name);
  }
});

test('renderTemplate: the default branch replaces main in pr-review.yml and conflicts-fix.yml only', () => {
  const pin = { ...PIN, defaultBranch: 'trunk' };
  const review = renderTemplate('pr-review.yml', fs.readFileSync(path.join(TEMPLATES, 'pr-review.yml'), 'utf8'), pin);
  assert.match(review, /\n    branches: \["\*\*", "!trunk"\]\n/);
  const conflicts = renderTemplate('conflicts-fix.yml', fs.readFileSync(path.join(TEMPLATES, 'conflicts-fix.yml'), 'utf8'), pin);
  assert.match(conflicts, /\n    branches: \["trunk"\]\n/);
  for (const name of shipped.filter((n) => !['pr-review.yml', 'conflicts-fix.yml'].includes(n))) {
    const text = fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
    assert.equal(renderTemplate(name, text, pin), renderTemplate(name, text, PIN), `${name}: no branch to replace`);
  }
});

test('renderTemplate: a branch name YAML would read as a number, null or boolean stays a string', () => {
  const text = fs.readFileSync(path.join(TEMPLATES, 'conflicts-fix.yml'), 'utf8');
  for (const b of ['123', 'null', 'true', 'on', '1.0', 'yes']) {
    const out = renderTemplate('conflicts-fix.yml', text, { ...PIN, defaultBranch: b });
    assert.ok(out.includes(`\n    branches: ["${b}"]\n`), b);
  }
});

test('renderTemplate: a CRLF checkout (autocrlf) gets the default branch too, line endings kept', () => {
  const pin = { ...PIN, defaultBranch: 'trunk' };
  for (const name of ['pr-review.yml', 'conflicts-fix.yml']) {
    const crlf = fs.readFileSync(path.join(TEMPLATES, name), 'utf8').replace(/\n/g, '\r\n');
    const out = renderTemplate(name, crlf, pin);
    assert.equal(out, renderTemplate(name, crlf.replace(/\r\n/g, '\n'), pin).replace(/\n/g, '\r\n'), name);
    assert.match(out, /trunk/, name);
  }
});

test('renderTemplate: an unknown placeholder left in a template throws with the file and line', () => {
  assert.throws(() => renderTemplate('x.yml', 'a: <PIPELINE_SHA>\nb: <PIPELINE_OTHER>\n', PIN), /x\.yml: placeholder left after rendering: b: <PIPELINE_OTHER>/);
});

test('renderTemplate: an invalid pin throws before rendering', () => {
  assert.throws(() => renderTemplate('x.yml', 'a: 1\n', { ...PIN, sha: 'x' }), /^Error: sha:/);
});

// --- planInstall ---

const T = [{ name: 'a.yml', text: 'uses: x@<PIPELINE_SHA> # <PIPELINE_VERSION>\n' }, { name: 'b.yml', text: 'b\n' }];

test('planInstall: absent → create, same content → unchanged, different → conflict', () => {
  const rendered = `uses: x@${SHA} # v1.2.3\n`;
  assert.deepEqual(planInstall({ templates: T, existing: new Map(), pin: PIN }).map((s) => [s.path, s.action]), [
    ['.github/workflows/a.yml', 'create'],
    ['.github/workflows/b.yml', 'create'],
  ]);
  const plan = planInstall({ templates: T, existing: new Map([['a.yml', rendered], ['b.yml', 'old\n']]), pin: PIN });
  assert.deepEqual(plan.map((s) => s.action), ['unchanged', 'conflict']);
  assert.equal(plan[0].content, rendered);
});

test('planInstall: --force turns a conflict into an overwrite, never an unchanged file', () => {
  const plan = planInstall({ templates: T, existing: new Map([['a.yml', `uses: x@${SHA} # v1.2.3\n`], ['b.yml', 'old\n']]), pin: PIN, force: true });
  assert.deepEqual(plan.map((s) => s.action), ['unchanged', 'overwrite']);
});

test('planInstall: no template throws', () => {
  assert.throws(() => planInstall({ templates: [], existing: new Map(), pin: PIN }), /templates: none found/);
});

// --- install (entrypoint), against a throwaway pipeline clone ---

function withPipeline(fn, { tag = 'v0.3.0' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adl-install-')));
  const pipeline = path.join(base, 'pipeline');
  const target = path.join(base, 'target');
  const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
  try {
    fs.mkdirSync(target);
    fs.cpSync(TEMPLATES, path.join(pipeline, 'templates', 'consumer'), { recursive: true });
    run(pipeline, 'init', '-q');
    run(pipeline, 'add', '-A');
    run(pipeline, 'commit', '-q', '-m', 'p');
    if (tag) run(pipeline, 'tag', tag);
    const sha = execFileSync('git', ['-C', pipeline, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return fn({ pipeline, target, sha, run });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const quiet = () => {};

test('install: writes every caller pinned to HEAD and its tag, then a rerun changes nothing', () => {
  withPipeline(({ pipeline, target, sha }) => {
    const res = install(['--target', target, '--default-branch', 'trunk'], { pipelineRoot: pipeline, log: quiet });
    assert.equal(res.sha, sha);
    assert.equal(res.version, 'v0.3.0');
    assert.deepEqual(fs.readdirSync(path.join(target, '.github', 'workflows')).sort(), shipped);
    const review = fs.readFileSync(path.join(target, '.github', 'workflows', 'pr-review.yml'), 'utf8');
    assert.ok(review.includes(`adl-pr-review.yml@${sha} # v0.3.0`));
    assert.ok(review.includes('"!trunk"'));
    const again = install(['--target', target, '--default-branch', 'trunk'], { pipelineRoot: pipeline, log: quiet });
    assert.ok(again.plan.every((s) => s.action === 'unchanged'));
  });
});

test('install: --dry-run writes nothing; the default branch falls back to main without an origin', () => {
  withPipeline(({ pipeline, target }) => {
    const lines = [];
    const res = install(['--target', target, '--dry-run'], { pipelineRoot: pipeline, log: (l) => lines.push(l) });
    assert.equal(res.defaultBranch, 'main');
    assert.equal(fs.existsSync(path.join(target, '.github')), false);
    assert.match(lines[0], /\(dry run\)/);
  });
});

test('install: a differing caller is a conflict (nothing written) until --force', () => {
  withPipeline(({ pipeline, target }) => {
    const dir = path.join(target, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pr-review.yml'), 'mine\n');
    assert.throws(() => install(['--target', target], { pipelineRoot: pipeline, log: quiet }), /1 existing caller\(s\) differ/);
    assert.equal(fs.readFileSync(path.join(dir, 'pr-review.yml'), 'utf8'), 'mine\n');
    assert.equal(fs.existsSync(path.join(dir, 'validate-issue.yml')), false);
    install(['--target', target, '--force'], { pipelineRoot: pipeline, log: quiet });
    assert.notEqual(fs.readFileSync(path.join(dir, 'pr-review.yml'), 'utf8'), 'mine\n');
  });
});

test('install: an untagged HEAD is refused unless --allow-untagged', () => {
  withPipeline(({ pipeline, target, sha }) => {
    assert.throws(() => install(['--target', target], { pipelineRoot: pipeline, log: quiet }), /carries no vMAJOR\.MINOR\.PATCH tag/);
    const res = install(['--target', target, '--allow-untagged'], { pipelineRoot: pipeline, log: quiet });
    assert.equal(res.version, UNTAGGED);
    assert.ok(fs.readFileSync(path.join(target, '.github', 'workflows', 'validate-issue.yml'), 'utf8').includes(`@${sha} # untagged`));
  }, { tag: null });
});

test('install: local changes to templates/consumer/ are refused', () => {
  withPipeline(({ pipeline, target }) => {
    fs.appendFileSync(path.join(pipeline, 'templates', 'consumer', 'pr-review.yml'), '# edited\n');
    assert.throws(() => install(['--target', target], { pipelineRoot: pipeline, log: quiet }), /templates\/consumer\/ has local changes/);
  });
});

test('install: a missing target and the pipeline itself as target are refused', () => {
  withPipeline(({ pipeline, target }) => {
    assert.throws(() => install(['--target', path.join(target, 'nope')], { pipelineRoot: pipeline, log: quiet }), /--target: not a directory/);
    assert.throws(() => install(['--target', pipeline], { pipelineRoot: pipeline, log: quiet }), /the pipeline repository itself/);
  });
});

test('install: a pipeline root that is not a git repository fails with the git command and directory', () => {
  withPipeline(({ pipeline, target }) => {
    fs.rmSync(path.join(pipeline, '.git'), { recursive: true, force: true });
    assert.throws(() => install(['--target', target], { pipelineRoot: pipeline, log: quiet }), /^Error: git status --porcelain -- templates\/consumer failed in .+: .+/);
  });
});

test('install: the default branch comes from the target origin HEAD when not given', () => {
  withPipeline(({ pipeline, target, run }) => {
    run(target, 'init', '-q');
    run(target, 'commit', '-q', '--allow-empty', '-m', 't');
    run(target, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    run(target, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    const res = install(['--target', target, '--dry-run'], { pipelineRoot: pipeline, log: quiet });
    assert.equal(res.defaultBranch, 'develop');
  });
});
