# ADR-0052: Executable evals: model call, oracle and scoring run in three jobs with one-way data flow

- **Date:** 2026-10-23
- **Status:** Proposed

## Context

The two registered suites (`validation`, `review`) score a decision or a text: the stage output is parsed and compared, nothing it produced is executed. The `generation` and `autofix` stages (EV-02, EV-03) produce a patch, and the only honest measure of a patch is to apply it to a fixture and run tests the model never saw. That puts model output, which must be treated as hostile even when the dataset is ours (a patch can add a `postinstall`, rewrite the test command, or read the environment), next to the secrets the eval job holds today: `GROQ_API_KEY`, `ANTHROPIC_API_KEY` and a token that can write to GitHub (`evals.yml`, `pr-evals.yml`).

ADR-0031 forbids loosening a gate to pass, so an oracle that the patch itself can alter or bypass would also defeat the measurement, not only the repository's security.

## Decision

1. **Three jobs, one-way flow.**
   - `eval-model`: runs the trusted default-branch code, holds the provider keys, calls the stage through the production path (prompt build, LLM, parse, write guard in dry-run) and uploads `model-output.json` (response, parsed patch, usage, durations). It never applies or executes the patch.
   - `eval-oracle`: no secrets, `permissions: contents: read`, `persist-credentials: false`. It downloads `model-output.json` as **data**, checks the digests of the dataset, the fixture and the oracle file against the pinned values, applies the patch to a temporary copy of the fixture and runs the oracle commands there with a CPU/time/memory limit and no network where the runner allows it. It uploads `oracle-result.json`.
   - `eval-score`: trusted code, no secrets, reads both artifacts as data, produces the case results in the existing result shape (`outcome`, `scores`, `failure_reasons`, `changed_paths`, …) and hands them to the existing `publish` job, whose history, baseline and versioning rules are unchanged.
2. **Trusted code only.** The scoring script, the oracle runner and the oracle commands are loaded from the default branch, never from a PR head. A PR that changes them is evaluated by the previous version until it merges.
3. **Where it runs.** Executable suites run on `schedule` and `workflow_dispatch` from the default branch. They do not run on `pull_request` (`eval-replay.yml` keeps replaying recorded responses without executing anything) until a dedicated disposable runner exists; a GitHub-hosted runner is not a sandbox against a determined escape, which is acceptable for our own dataset and our own model calls, and not for the output of a third party's PR.
4. **The oracle is out of the patch's reach.** Fixture and oracle are pinned by SHA-256 in the case; hidden tests and the oracle file are never in a prompt; the patch may only touch `visible_paths` minus `must_not_change`; a path that resolves outside the fixture, a symlink, a change to the test command, to a fixture manifest or to a test file is a deterministic `ORACLE_TAMPERING` failure, not a retry.
5. **Failure semantics.** A timeout, a crash of the oracle or a missing artifact is `ERROR`, never `success` and never an expected block. `BLOCKED_EXPECTED` counts as correct only where the case requires a block.
6. **Reuse, no parallel implementation.** The parser, write guard and prompt fitting of the stage are imported by an adapter (`generation_eval_adapter.mjs`, `autofix_eval_adapter.mjs`), as `reviewSuite` already does through `resolveReviewDecision` (EV-01): the thing scored is the thing production runs.

## Alternatives Considered

- **One job, secrets stripped from the child process environment** (the `sanitizeEnv` approach of `review_evidence.mjs`). That protects the environment variables of a child, not the job: the runner still holds the checkout credentials, the cached provider variables and the network, and the patch runs in the same trust domain as the scorer. Fine for repository tests, not for model output. Rejected for patches.
- **Container with `--network none` inside the same job.** A useful defense in depth inside `eval-oracle`, not a boundary on its own: the job keeps whatever it was given. Kept as an option for the oracle step.
- **Dedicated VM or runner per case** (ephemeral microVM). The right answer before evaluating third-party PRs; more infrastructure than the first suites justify. Deferred, with point 3 as the limit until then.
- **An LLM as the oracle.** A judge model agrees with the generator more than a test does and is not independent evidence; rejected as the only oracle (it may complement one).
- **Run the executable suites on `pull_request`.** Would give per-PR signal, but needs secrets and untrusted code in the same event. Rejected until the dedicated runner exists.

## Consequences

- ✅ A hostile patch sees no key and no write token; an altered oracle or test command fails deterministically instead of passing.
- ✅ The model call stays comparable with production (same code path), and the published history keeps its meaning: suite version, dataset, fixture and oracle digests join the run metadata.
- ✅ The existing `publish`, baseline and ADR-0031 rules apply unchanged to the new suites.
- ⚠️ Three jobs and two artifacts per run: more wall time and moving parts than the current single job; the schedule budget (Groq TPD, one suite per scheduled run) is unchanged and must be re-measured per suite.
- ⚠️ No per-PR signal for `generation` and `autofix` until the dedicated runner exists; PRs that change their prompts are measured by a manual dispatch from the default branch, or after merge.
- ⚠️ "No network where the runner allows it" is a best effort on hosted runners. The residual risk is bounded by points 2 and 3 (our dataset, our model call, no secrets in the job) and must be restated if third-party output is ever evaluated.
- ⚠️ Nothing is implemented by this ADR; EV-02 and EV-03 depend on it and carry the workflow, the artifact schema and the tamper tests.
