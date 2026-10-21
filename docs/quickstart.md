# Quickstart: Install the Pipeline in Your Repository

From zero to a first AI-generated pull request in a repository that is not this one. About 15 minutes, plus the first run. Reference material (permission table, configuration files, updating, uninstalling) is in [installation.md](installation.md); this page is the linear path and does not repeat it.

> **Status of this guide.** It follows the interfaces on `main` (ADR-0045, parts 0–3). It has **not** yet been walked end to end by someone who only had this page; ADR-0045's assumptions A1, A3 and A4 are still to be checked once in a scratch repository (see [Known limits](#6-known-limits)). Any deviation you meet is a documentation bug: report it.

## 1. Prerequisites

**Secrets** (Settings → Secrets and variables → Actions → *Secrets*). At least one provider key:

| Secret | Needed for |
|---|---|
| `GROQ_API_KEY` | Default provider (`openai/gpt-oss-120b`, every stage) |
| `ANTHROPIC_API_KEY` | Optional primary, or automatic fallback when the primary fails (ADR-0032) |
| `AI_PR_TOKEN` | Recommended. Events created with the workflow token (a PR, a push, a label) do not start other workflows, and some organizations forbid it creating PRs (ADR-0004). Without it, enable *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests* |

The repository does not specify the scopes of `AI_PR_TOKEN`; it performs the pull request, label and review writes that the callers' `contents`, `pull-requests` and `issues: write` ceilings cover, so give it those on this repository only. Secrets are mapped one by one in the callers; `secrets: inherit` is never used.

**Variables** (same page → *Variables*), all optional:

| Variable | Effect |
|---|---|
| `AI_PROVIDER` | `groq` or `anthropic`: primary provider of every stage. Unset: Anthropic if only its key is set, Groq otherwise |
| `AI_PROVIDER_VALIDATION`, `_GENERATION`, `_REVIEW`, `_AUTOFIX` | Primary provider of one stage, over `AI_PROVIDER` |
| `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `GROQ_MODEL`, `GROQ_REASONING_EFFORT` | Override the per-stage models of `config/models.yaml` for every stage: leave unset unless you measured the model ([code-generation.md](code-generation.md#per-stage-model-keys)) |

The other provider is the fallback when its key is set. A wrong value never fails a job: it logs `provider_config_fallback`.

**Indicative cost per review.** Only what the repository states; nothing else is priced here.

| Provider | Review model | Bound on one review |
|---|---|---|
| Groq | `openai/gpt-oss-120b` | No price in the repository. Free tier: 8 000 tokens per minute shared by every PR and stage of the account; the review input is cut to 6 300 estimated tokens (`review_max_input_tokens`), so a large PR is cut (see §6). Paid tiers: check Groq's price list |
| Anthropic | `claude-sonnet-5-5` (`anthropic_review`) | Input ≤ $0.10 (diff capped at 200 000 characters ≈ 50k tokens, $2/MTok per the comment in `config/models.yaml`). Output (≤ 16 000 tokens, thinking included) is **not** priced in the repository |
| Anthropic, `anthropic_review: claude-opus-5-5` | Opus | Input ≤ $0.20 ($4/MTok, same comment) |

A PR costs one review per pushed head plus one per auto-fix attempt (≤ 3). Measure your own: the trace's `review.llm_request` / `review.llm_response` events carry `input_tokens_est` / `output_tokens_est` ([observability.md](observability.md)).

**Repository settings.** The callers' `issues` and `push` triggers only fire from workflow files on the **default branch**: merge step 2 before testing.

## 2. Files to add

### 2.1 Pick a commit to pin

The line `uses: …@<SHA>` of each caller is the **only** pin; a branch name is refused at run time. No release tag exists yet, so pin a commit of `main`:

```bash
git ls-remote https://github.com/koydas/autonomous-dev-loop refs/heads/main
```

Use the 40-character SHA. Once a `vMAJOR.MINOR.PATCH` tag exists ([releasing.md](releasing.md)), prefer its commit (`git ls-remote … 'refs/tags/v*'`; for an annotated tag take the `<tag>^{}` line).

### 2.2 The callers

Copy the five files of [`templates/consumer/`](../templates/consumer/) into `.github/workflows/`, **keeping their names** (`validate-issue.yml`, `code-generation.yml`, `reset-auto-fix.yml`, `pr-review.yml`, `auto-fix-pr.yml`: they look each other up by name). In each, replace `<PIPELINE_SHA>` with the commit and `<PIPELINE_VERSION>` with a comment for people and bots (the tag, or `main@2026-10-21`). In `pr-review.yml`, replace `!main` with your default branch.

Smallest working caller (`validate-issue.yml`; the others differ by trigger, permissions and inputs, so copy them from `templates/consumer/`):

```yaml
name: Issue Validation Agent
on:
  issues:
    types: [opened, edited]
permissions:
  contents: read
jobs:
  validate:
    permissions:
      contents: write   # the `metrics` branch (run records)
      issues: write
      actions: write    # dispatches code-generation.yml
    uses: koydas/autonomous-dev-loop/.github/workflows/adl-validate-issue.yml@bd0d8ac30c9e014f6b396aa39a2ce2986a7ae8a6 # main@2026-10-21
    with:
      config_dir: .autonomous-dev-loop
      codegen_workflow_file: code-generation.yml
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

The SHA above is the commit of `main` when this page was written: use a current one. A caller job must grant at least the permissions of the jobs it calls, or the run fails at startup (ceilings: [installation.md](installation.md#permissions-the-callers-grant)).

### 2.3 Configuration (optional but read this)

All files live in `.autonomous-dev-loop/` and are read from your **default branch**, so a PR that changes them takes effect once merged. With none of them, three defaults matter:

- **No `review-evidence.yaml` → the review can approve without running any check.** Add one with your build and test commands ([example](installation.md#configuration-directory)).
- **No `protected-paths.yaml` → only the built-in floor** (`.git/`, `.github/`, package manifests and lock files, .NET and Python install files). Everything else, including your `scripts/` or `infra/`, is writable by the model. List what it must never touch.
- **No `review-guidelines.md` → neutral review rules.** State your conventions there (≤ 6 000 characters).

Minimal `.autonomous-dev-loop/protected-paths.yaml`:

```yaml
protected_paths:
  - infra/
  - deploy/
```

Check what a run will resolve, from a clone of the pipeline at the pinned commit, inside your repository:

```bash
ADL_CONFIG_DIR=$PWD/.autonomous-dev-loop ADL_CONFIG_PATH=.autonomous-dev-loop \
  node /path/to/pipeline/scripts/print_resolved_config.mjs
```

Merge the callers and the configuration to the default branch.

## 3. Create the labels

Copy [`templates/consumer/setup-labels.yml`](../templates/consumer/setup-labels.yml) into `.github/workflows/` with the same two placeholders, merge it, then **Actions → ADL Setup Labels → Run workflow**. It creates, idempotently, every label of the effective configuration:

| Label | Meaning |
|---|---|
| `ready-for-dev` / `needs-refinement` | Issue validated / under-specified |
| `review-approved` / `changes-requested` / `review-withheld` | Review verdicts; `review-withheld` = approval withheld (§6) |
| `auto-fix-attempt-1` … `-3` | Auto-fix round counter |
| `needs-human` | Automation stopped; a person decides |

Tick *update* to bring the color and description of existing labels back to the configuration.

## 4. First journey

1. **Open an issue** with a title, a description and explicit acceptance criteria. Name the file to change if you can: generation is bounded to 6 files, 16 000 characters each, and never writes a protected path.
2. **Validation** (Actions → *Issue Validation Agent*, job `validate / validate`, seconds). The issue gets a validation comment and `ready-for-dev` or `needs-refinement`. On `needs-refinement`, edit the issue: it is re-validated.
3. **Code generation** (Actions → *Code Generation*, started by the validation run). A PR from branch `ai/issue-<n>` with `Closes #<n>` in its body. A blocked or rejected patch opens no PR: the issue gets `needs-human` and a *Code Generation: Blocked* / *Patch Rejected* comment saying why.
4. **Review** (Actions → *PR Review*, on every push to the branch). One comment per head, marked `<!-- adl-review sha=… -->`, with the verdict and, when you configured checks, a *Tool Evidence* section. Label: `review-approved`, `changes-requested` or `review-withheld`.
5. **Auto-fix** (Actions → *Auto-Fix PR*), only after `changes-requested`: up to 3 attempts (`auto-fix-attempt-N`), each a commit `fix(ai): auto-fix attempt N`, each followed by a new review. After the third, or when it cannot fix, `needs-human`.
6. **You merge.** Nothing in the pipeline merges.

Where to look:

| What | Where |
|---|---|
| Stage progress, errors | Actions → the workflow run; a reusable workflow shows as `<caller job> / <called job>` |
| State of an issue or PR | Its labels and comments (table above) |
| Trace of a run | Run page → Artifacts → `run-trace-<run_id>` (JSON; `jq '[.spans[] \| {stage, outcome, duration_ms}]'`, [runbook](runbook.md#run-trace-artifacts)) |
| Run records | Branch `metrics` of **your** repository, created by the first run. The dashboard of the pipeline repository shows its own runs, not yours |

## 5. Troubleshooting

The five most likely failures at install time, in order of appearance:

| # | Symptom | Cause and fix |
|---|---|---|
| 1 | The caller run fails in seconds at **Resolve pipeline version**, or at startup with a permissions error | A branch or floating tag in `uses:`, a trigger on `pull_request_target`, or a caller job granting less than the called one: [runbook: a reusable workflow fails before any stage script](runbook.md#a-reusable-workflow-fails-before-any-stage-script-adr-0045). Ceilings: [installation.md](installation.md#permissions-the-callers-grant) |
| 2 | `models.yaml (…): unknown key`, `protected_paths[0] …`, `ADL_CONFIG_DIR … must be an absolute path` | Invalid file in `.autonomous-dev-loop/` on the default branch: [runbook: checking which configuration a run resolves](runbook.md#checking-which-configuration-a-run-resolves-adr-0045) |
| 3 | Nothing starts when an issue is opened; or the issue stays unlabelled | Caller not on the default branch, Actions disabled, or no provider key (`Fails with clear error if neither key is present`); labels missing (§3). [Runbook: `validate-issue`](runbook.md#validate-issue) |
| 4 | Generation fails with `GitHub Actions is not permitted to create or approve pull requests` | Set `AI_PR_TOKEN` or allow Actions to create PRs: [code-generation.md](code-generation.md#github-actions-pr-permission-requirement) |
| 5 | `ready-for-dev` is applied, but no PR / no review / no auto-fix follows | Label renamed in `labels.yaml` without re-running *ADL Setup Labels*; events created by the workflow token start nothing (set `AI_PR_TOKEN`); issue blocked by a protected path (`needs-human` + comment). [Runbook: symptom → probable cause](runbook.md#symptom--probable-cause-mapping) |

## 6. Known limits

- **Groq free tier.** 8 000 tokens per minute for the whole account, and a daily token budget (200k TPD on the free tier, [evals.md](evals.md#token-budget)) shared with everything else on the key. Jobs queue behind each other (`retry` events with `waitMs: 60000` are normal) and can reach their timeout. Each stage has an input budget (`config/models.yaml`); an issue citing large files, or a PR title/body beyond it, fails before any call instead of returning HTTP 413. Raise the budgets on a higher tier, or use `AI_PROVIDER=anthropic`.
- **`review-withheld` on large PRs (ADR-0038).** When the PR's code does not fit the review input (Groq: roughly 150 lines of diff), the model approves without having seen the cut files; the pipeline then replaces `APPROVE` with `WITHHELD`: label `review-withheld`, no auto-fix, a re-run gives the same result. Review the listed files by hand, split the PR, or review on Anthropic (diff cap 200 000 characters).
- **No evidence, no checks.** Without `review-evidence.yaml` the review cannot run your tests. A PR that changes the files controlling the evidence job (`package.json`, the `pr-review.yml` caller) gets non-authoritative PASS rows.
- **Protected paths (ADR-0021, ADR-0044).** The model cannot write the built-in floor plus your `protected-paths.yaml`. An issue whose files are all protected ends `needs-human`; a patch that deletes more than half of a 20-line-or-longer file, drops a test, changes an exported signature, adds an unresolvable import or mixes ESM/CJS is rejected (ADR-0019).
- **No auto-merge.** A person merges, always. Branch protection and required reviews stay yours.
- **Bounded loop.** At most 3 auto-fix attempts per fix round; the pipeline's own prompts cannot be overridden by the target.
- **Assumptions not yet verified (ADR-0045 A1, A3, A4).** That `vars.*` resolves to *your* repository variables inside the cross-repository workflows, that `referenced_workflows` reports the pinned commit, and that the pipeline repository is reachable from yours (public, or allowed under Settings → Actions → General). If a variable you set is ignored, or the version step fails on a valid pin, report it: ADR-0045 documents the fallback.
- **Third-party actions** inside the reusable workflows (`actions/checkout`, `peter-evans/create-pull-request`, …) are pinned by tag, not by SHA.
- **Auto-fix on its own code.** The guard that skips auto-fix when a PR modifies `scripts/auto_fix_pr.mjs` applies to the pipeline repository only.
