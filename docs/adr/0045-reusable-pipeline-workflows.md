# ADR-0045: Reusable pipeline workflows for target repositories

- **Date:** 2026-10-20
- **Status:** Proposed

## Context

The only way to use the pipeline is to copy this repository. Target repositories should install it with a few caller workflows plus their own configuration, and take updates by changing one pinned reference.

Today three roots coincide and the code assumes it:

- the **pipeline root** (scripts, prompts, default config), resolved through `import.meta.url` in `config.mjs`, `prompts.mjs`, `protected_paths.mjs`, `pr_review.mjs` and `run_review_evidence.mjs`;
- the **target root** (the working directory: the PR branch as data, `observability/traces`, `checkpoints`, file context, writes);
- the **trusted configuration** — read from the default branch, never from a PR (ADR-0023).

`reset_auto_fix.mjs` reads `config/labels.yaml` relative to the working directory and the `load-labels` jobs import `./scripts/lib/yaml.mjs` from the workspace: both only work because workspace and pipeline are the same tree. ADR-0044 §5 reads `protected-paths.yaml` "next to the pipeline scripts", which on a target would be the pipeline's own file. Some review heuristics (`coverage_checker.mjs`, `prompt_budget.mjs`, the c8 list in `pr-review-system.md`, `SELF_PATH` in `auto_fix_pr.mjs`) describe this repository, not the one under review.

## Decision

1. **Reusable workflows.** The bodies of `validate-issue`, `code-generation`, `pr-review`, `auto-fix-pr` and `reset-auto-fix` move to `.github/workflows/adl-<name>.yml` (`on: workflow_call` only). The existing files become thin callers (triggers, `name:`, `uses: ./.github/workflows/adl-<name>.yml`), so file names that other workflows pass to `gh` stay valid. `evals`, `pr-evals`, `eval-replay`, `pipeline-site`, `test` and `changelog-check` stay internal.
   - Common inputs: `pipeline_repository` (default `koydas/autonomous-dev-loop`), `config_dir` (default `.autonomous-dev-loop`), `pipeline_ref` (optional, self-call only: see 2). There is **one pin per caller**: the literal ref of `uses: koydas/autonomous-dev-loop/.github/workflows/adl-<name>.yml@<ref>`, since GitHub accepts no expression there.
   - Others: `codegen_workflow_file` (validate-issue, default `code-generation.yml`), `autofix_workflow_file` (pr-review, default `auto-fix-pr.yml`), `issue_number` / `validate_run_id` (code-generation), `pr_number` / `retrigger` (reset-auto-fix).
   - Secrets, all optional, mapped explicitly (never `secrets: inherit`): `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `AI_PR_TOKEN`.
   - Each job keeps its own minimal `permissions` block (ADR-0007 amendment). A caller job must grant at least the union of its called jobs' blocks; the documented ceilings are in `docs/code-generation.md`.
2. **Pipeline code from a pinned ref.** The pipeline version is **derived, never a second input**: a first job reads the run's `referenced_workflows` (`GET /repos/{repo}/actions/runs/{run_id}`, `actions: read`), takes the entry whose path is `<pipeline_repository>/.github/workflows/adl-*.yml` and uses its `sha`; it fails closed when the entry is missing, and refuses an entry whose `ref` is a branch (accepted: a 40-hex SHA or `refs/tags/vMAJOR.MINOR.PATCH`). Workflow orchestration and scripts therefore always come from the same commit. Self-calls (`./.github/workflows/...`, `pipeline_repository == github.repository`) would resolve to the caller's own commit, i.e. the PR head on `push`; they pass `pipeline_ref` (the default branch) instead, honored only in that case and ignored for any other repository. A second `actions/checkout` fetches the pipeline at the resolved SHA into the workspace, then `mv` to `$RUNNER_TEMP/pipeline` (ADR-0023 pattern). Every `run:` becomes `node "$RUNNER_TEMP/pipeline/scripts/<name>.mjs"`. Scripts have no third-party imports, so no install step. Prompts are the pipeline's; a target cannot override them.
3. **Three roots, one module.** `scripts/lib/roots.mjs` is the only place that computes them: `pipelineRoot` (from `import.meta.url`), `targetRoot()` (the working directory; an environment override exists for tests only) and `resolveConfigFile(name)`. A test forbids root arithmetic from `import.meta.url` elsewhere (CLI detection excepted).
4. **Trusted target configuration.** In `pr-review` and `auto-fix-pr`, a sparse checkout of the target's **default branch** limited to `config_dir` goes to `$RUNNER_TEMP/target-config` and is exported as `ADL_CONFIG_DIR`. The PR workspace's configuration is never used for a decision. `validate-issue`, `code-generation` and `reset-auto-fix` run on the default branch already and read `config_dir` from their checkout. This amends ADR-0023 (trusted pipeline = pinned ref of the pipeline repository, not "default branch of the same repository") and ADR-0044 §5 (location of the per-repository file).
5. **Configuration resolution.**
   - `models.yaml`, `labels.yaml`: leaf-key overlay of the target file on the pipeline defaults; an unknown key is an error naming its path.
   - `protected-paths.yaml`: floor ∪ target list. This repository's own list is not inherited (ADR-0044 §7). A missing file means floor only.
   - `review-evidence.yaml`: target only; missing means evidence is not required (existing `evidenceRequired` semantics).
   - The floor stays hard-coded and always active; the resolved `<config_dir>/` directory itself (not only its `protected-paths.yaml`) and `.autonomous-dev-loop/` join it, so a non-default `config_dir` such as this repository's `config` is protected as a whole. A target `protected_paths: []` removes nothing.
   - `scripts/print_resolved_config.mjs --json` reports roots and the source of each file.
6. **Repository-specific heuristics and review prompt.** `coverage_checker`, `prompt_budget` and `SELF_PATH` apply only when the target is the pipeline repository. `prompts/pr-review-system.md` is split into a target-neutral core and a repository-rules part (this repository's documentation and c8 gate requirements) appended only for self-calls; the assembled prompt for this repository is byte-identical to today's (pinned by test, so eval-neutral, ADR-0031). On a target the core is used, plus an optional `<config_dir>/review-guidelines.md` read from the trusted configuration (decision 4). The `gate (c)` drift test follows the repository-rules part.
7. **Labels.** `scripts/ensure_labels.mjs` creates every label of the resolved `labels.yaml` plus `auto-fix-attempt-1..N`, idempotently (`gh api --paginate`, REST fallback of ADR-0011). A `setup-labels.yml` template runs it through `workflow_dispatch`.
8. **Security.**
   - `pull_request_target` is forbidden in workflows and templates (test) and refused at run time by the first job.
   - The `evidence` job keeps no `secrets.` reference and a read-only token, and runs the pinned pipeline against the PR tree as data (ADR-0024).
   - No caller or template uses `secrets: inherit`; templates pin `@<SHA>` with a version comment, and that is the only pin.
9. **Dogfooding.** This repository's callers use `uses: ./.github/workflows/adl-*.yml` with `pipeline_ref: ${{ github.event.repository.default_branch }}`, which keeps ADR-0023 behavior. `github.workflow` is the caller's, so traces, run records and the `metrics` branch layout are unchanged; the metrics, artifact and checkpoint steps move verbatim. The pinned-SHA path is exercised by a fixture repository and a `consumer-smoke` CI job.
10. **Versioning.** Immutable `vMAJOR.MINOR.PATCH` tags. A committed snapshot of the five `adl-*` interfaces (inputs, secrets, permissions) is compared by test; changing it requires a CHANGELOG entry. Breaking for a caller: an input or secret removed, renamed or made required; a wider permission ceiling; a new required caller trigger; an assumed caller file name; a configuration schema change (keys, label groups, `protected-paths` grammar, `review-evidence` format); label, artifact or checkpoint names, `metrics` layout; a higher minimum Node version. Not breaking: prompts, model defaults, fixes; a wider floor is logged under `### Security`.

## Assumptions to verify

- A1: `vars.*` resolves to the caller's repository variables inside a cross-repository reusable workflow. Fallback: explicit string inputs for `AI_PROVIDER*` and model settings.
- A2: `github.workflow` and `GITHUB_RUN_ID` are the caller's. Documented by GitHub; checked once manually in a scratch repository after the first reusable workflows land.
- A3: `referenced_workflows` of the workflow run lists the called workflow with its `sha` and `ref` for a reusable workflow in another repository. Fallback if it does not: an explicit `pipeline_ref` input plus a mandatory consistency check against the caller; verified with A1 and A2.
- A4: `koydas/autonomous-dev-loop` is public. If private, the repository must allow access from caller repositories and the second checkout needs a token (extra `pipeline_token` secret).

## Alternatives Considered

- **Composite actions:** no job-level `permissions`, `concurrency` or `if`, so the least-privilege layout of ADR-0007 would be lost.
- **Template repository / copy:** the status quo; no update path.
- **Marketplace-style JavaScript action:** a rewrite of the orchestration into a different runtime; contradicts "workflow YAML is dumb, logic in Node scripts".
- **Floating `v1` tag as the recommended pin:** mutable, so it defeats the pinned-SHA policy; tags stay informational.
- **Target configuration in `config/`:** collides with ordinary target code (ADR-0044 context). A dedicated directory plus `config_dir` avoids it and leaves this repository untouched (`config_dir: config`).
- **Reading target configuration from the PR workspace:** simpler, but contradicts ADR-0023.
- **`pipeline_ref` as a required input (first draft):** two literals per caller that can diverge, so orchestration from one version could run scripts and prompts from another; replaced by derivation from `referenced_workflows`.
- **Self-calls pinned to the last release:** a pipeline change would only apply after a release.

## Consequences

- ✅ A target installs five caller files plus a config directory and updates by changing one SHA.
- ✅ This repository's behavior, traces and `metrics` branch are unchanged.
- ✅ Trust model preserved: code from a pinned ref, configuration from the default branch, PR as data.
- ⚠️ Every caller job needs `actions: read` for the version lookup (added to the ceilings of validate-issue and reset-auto-fix).
- ⚠️ Callers must grant the permission ceilings; a narrower caller fails at startup.
- ⚠️ A target without `review-evidence.yaml` can get APPROVE without checks.
- ⚠️ On a target, the coverage and prompt-budget heuristics are off and the review uses the neutral core; repository-specific review rules come only from its own `review-guidelines.md`.
- ⚠️ Trust boundary of self-calls is unchanged: on `push` GitHub takes the caller workflow (and, for `./` calls, the called one) from the pushed branch, as ADR-0023 already records for `pr-review.yml`. Both files sit under `.github/`, in the protected floor, so generation and auto-fix cannot write them; whoever can push a branch could before and still can. A pinned remote literal would not close it (the caller stays branch-controlled). Hardening (ruleset restricting branch pushes or requiring workflows) is a repository setting, outside this ADR.
- ⚠️ Third-party actions inside the workflows are still referenced by tag, not SHA (separate follow-up).
