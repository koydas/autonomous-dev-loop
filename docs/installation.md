# Installing the Pipeline in Another Repository

ADR-0045. A repository installs the pipeline with five caller workflows and its own configuration directory. The scripts, prompts and default configuration are not copied: each run fetches them at the commit the callers pin, and an update is one new SHA.

## How it fits together

- **Callers** (`templates/consumer/*.yml` → your `.github/workflows/`): your triggers, your permission ceilings, one `uses: koydas/autonomous-dev-loop/.github/workflows/adl-<name>.yml@<SHA>` line each. That line is the **only** pin: the run reads the commit it points to and checks the pipeline out at that commit. A branch name is refused at run time.
- **Configuration** (`.autonomous-dev-loop/` in your repository, all files optional): read from your **default branch** whatever ref a run was started on, so a pull request that changes it takes effect once merged.
- **State**: run records go to a `metrics` branch of your repository (created by the first run, `contents: write`), checkpoints to workflow artifacts, labels to your issues and PRs. The dashboard, the evals and the pipeline's own tests stay in the pipeline repository.

## Prerequisites

| Item | Where | Notes |
|---|---|---|
| Access to the pipeline repository | `koydas/autonomous-dev-loop` | Public, or your organization allows its workflows (Settings → Actions → General → Access) and a token for the second checkout |
| `ANTHROPIC_API_KEY` or `GROQ_API_KEY` | Settings → Secrets and variables → Actions | At least one; both are optional secrets of the called workflows |
| `AI_PR_TOKEN` | Same | Recommended. Events created with the workflow token (a pull request, a push, a label) do not start other workflows (a GitHub rule), and some organizations forbid it creating pull requests (ADR-0004) |
| `AI_PROVIDER`, `AI_PROVIDER_<STAGE>`, `ANTHROPIC_MODEL`, `GROQ_MODEL`, … | Repository **variables** | Same names as in [code-generation.md](code-generation.md#per-stage-model-keys) |
| Pull requests from workflows | Settings → Actions → General | Allow GitHub Actions to create pull requests when `AI_PR_TOKEN` is unset |

## Install

1. **Pick a release** and its commit: `git ls-remote https://github.com/koydas/autonomous-dev-loop 'refs/tags/v*'` (an annotated tag lists the tag object, then the commit as `<tag>^{}`: use the commit).
2. **Copy the callers.** `templates/consumer/{validate-issue,code-generation,reset-auto-fix,pr-review,auto-fix-pr,conflicts-fix}.yml` into `.github/workflows/`, keeping the file names (the callers look each other up by name: `codegen_workflow_file`, `autofix_workflow_file`). In each, replace `<PIPELINE_SHA>` with the 40-character commit and `<PIPELINE_VERSION>` with the tag (a comment: it lets a bot bump the line). In `pr-review.yml`, replace `!main` with your default branch.
3. **Add the configuration** you need in `.autonomous-dev-loop/` (below). None is mandatory.
4. **Create the labels**: copy `templates/consumer/setup-labels.yml`, replace the same two placeholders, and run **ADL Setup Labels** from the Actions tab (`update` brings existing labels back to the configuration). It is idempotent; `node scripts/ensure_labels.mjs --dry-run` shows what it would do.
5. **Check what a run resolves**: from a clone of the pipeline at the pinned commit, in your repository: `ADL_CONFIG_DIR=$PWD/.autonomous-dev-loop ADL_CONFIG_PATH=.autonomous-dev-loop node /path/to/pipeline/scripts/print_resolved_config.mjs`.
6. **Open a test issue.** **Issue Validation Agent** should run as `validate / validate` and, once the issue is valid, dispatch **Code Generation**.

## Configuration directory

| File | Effect | Absent |
|---|---|---|
| `models.yaml` | Keys laid over the pipeline defaults (`config/models.yaml`); an unknown key fails the run, naming file and key | Defaults |
| `labels.yaml` | Same, for label names, colors and descriptions (`group.section.leaf`) | Defaults |
| `protected-paths.yaml` | `protected_paths:` list added to the hard-coded floor (`.git/`, `.github/`, package manifests and lock files, .NET and Python install files); never removes a floor entry; the directory itself is always protected | Floor only: your `scripts/`, `config/`, `docs/` are writable by the model |
| `review-evidence.yaml` | `checks:` run on the PR head before the review (`command`, `timeout_seconds`); a failing check forces `REQUEST_CHANGES` | No evidence required: the review can approve without checks |
| `review-guidelines.md` | Up to 6000 characters appended to the review prompt as your repository's rules | The review uses the neutral rules only |

Example `review-evidence.yaml` for a .NET repository:

```yaml
checks:
  build:
    command: dotnet build --nologo
    timeout_seconds: 600
  tests:
    command: dotnet test --nologo --no-build
    timeout_seconds: 900
```

On a repository that is not the pipeline's own: the review uses the neutral prompt (no test-coverage gates written for the pipeline, no `package.json` or React checks), no prompt-budget block, and auto-fix has no self-modification skip. State your own conventions in `review-guidelines.md`.

## Permissions the callers grant

A called job can only narrow the token of its caller, so each caller job grants exactly the union of what its workflow uses (the templates do; `docs/workflow-interface.json` is the contract).

| Caller | `contents` | `pull-requests` | `issues` | `actions` |
|---|---|---|---|---|
| validate-issue | write (metrics branch) | – | write | write (dispatch) |
| code-generation | write | write | write | read |
| reset-auto-fix | write | write | write | read |
| pr-review | write | write | write | read |
| auto-fix-pr | write | write | write | read |
| conflicts-fix | write (push to the PR branch, metrics branch) | write | write | read |

Inside `adl-pr-review.yml` the `evidence` job, which runs your pull request's code, has `contents: read` only and references no secret.

## Updating

Change the SHA (and the version comment) in the six callers and the label setup, in one pull request. A bot that handles GitHub Actions references (Dependabot, Renovate) can propose it from the version comment. Read the [CHANGELOG](../CHANGELOG.md) first: a `### Breaking` entry says what to change in your callers (a new input, a wider permission, a renamed label). Rolling back is the previous SHA.

## Security rules that hold for every installation

- Pin by commit. A tag can be moved by whoever controls it; the comment is for people and bots.
- Never trigger a caller on `pull_request_target`: the pipeline refuses to run on it. The `evidence` and `review` jobs treat the pull request as data.
- Secrets are mapped one by one in the callers; never `secrets: inherit`.
- Third-party actions used inside the reusable workflows (`actions/checkout`, `peter-evans/create-pull-request`, …) are referenced by tag; pinning them by SHA is a separate piece of work.

## When it does not start

[runbook.md](runbook.md#a-reusable-workflow-fails-before-any-stage-script-adr-0045) lists the messages of the version step and their fixes; [Checking Which Configuration a Run Resolves](runbook.md#checking-which-configuration-a-run-resolves-adr-0045) the configuration errors.

## Uninstall

Delete the six workflow files and `.autonomous-dev-loop/`. The labels, the `metrics` branch and the artifacts stay until you delete them.
