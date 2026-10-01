# ADR-0020: Tool evidence for PR review

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

`scripts/pr_review.mjs` reviews a PR with a single LLM call over the filtered diff plus three statically-built context blocks (change classification, automation gate, dependency manifest). The reviewer never sees the result of executing anything: `test.yml` runs the suite on the same push, but its outcome is invisible to the review job.

ADR-0019 documents the consequence: a generated diff with an undeclared dependency, a read-only property assignment, and no tests was `APPROVED`. Prompt sharpening (#155, #156) reduces the rate of such misses but cannot make the reviewer *know* whether the code passes its own checks.

The "agentic code review" pattern addresses this with a reviewer that gathers context and runs tools (tests, linters, scans) before judging. Two variants were considered:

- **A — pushed evidence**: a deterministic step runs a fixed set of checks and injects the results into the review prompt.
- **B — tool-use loop**: the LLM is given tools (`read_file`, `run_tests`, …) and decides what to inspect, within a call budget.

## Decision

Adopt variant A.

### 1. Evidence job, isolated from secrets

`pr-review.yml` gains an `evidence` job that runs **before** `review` and holds no secrets:

- `permissions: contents: read`, `actions/checkout` with `persist-credentials: false`.
- Checks out the PR head SHA (`pull_request.head.sha`, falling back to `github.sha` on push), not the merge commit, so the evidence is attributable to the exact commit the reviewer sees.
- Runs `node scripts/run_review_evidence.mjs`, which executes the checks declared in `config/review-evidence.yaml` and writes `evidence/review-evidence.json`. Uploaded as artifact `review-evidence-<run_id>`.

Executing PR code (LLM-generated, or from a contributor branch) is thereby kept out of the job that holds `AI_PR_TOKEN` and the LLM API keys. The script additionally strips from each check's environment any env var whose name matches `TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL`, and the whole env-injected git config family (`GIT_CONFIG_COUNT` / `KEY_n` / `VALUE_n`, which can carry `http.extraheader` auth and breaks git if only partially removed) — defense in depth.

### 2. Declared checks, not discovered ones

`config/review-evidence.yaml` lists each check as `checks.<name>.command` (+ optional `timeout_seconds`, default 300). Commands are explicit configuration — no heuristic discovery from manifests. Per-check result:

| Status | Meaning |
|---|---|
| `pass` | exit code 0 |
| `fail` | non-zero exit code within the timeout |
| `timeout` | killed after `timeout_seconds` |
| `error` | could not be spawned |

Each result carries `exit_code`, `duration_ms`, and the last 2 000 characters of combined output (ANSI stripped).

### 3. Review consumes evidence; failures override the verdict in code

`review` declares `needs: evidence` with `if: ${{ !cancelled() }}`, so a crashed evidence job never blocks the review. `pr_review.mjs` reads the evidence file (`REVIEW_EVIDENCE_PATH`, default `evidence/review-evidence.json`) and assesses it:

- **missing** (no file, unreadable, or malformed) or **stale** (`head_sha` differs from the PR head returned by the API — a push raced the run) → all checks are unverified; no override.
- **available** → `fail` results are *failing*; `timeout` / `error` results are *unverified*.

Effects:

1. An `## Tool evidence` block is appended to the LLM user prompt; the system prompt instructs the model to treat failing checks as authoritative and unverified ones as unknown.
2. **Any failing check forces `REQUEST_CHANGES`**, regardless of the LLM verdict. This is enforced in code, not in the prompt.
3. A deterministic `### 🧪 Tool Evidence` section is appended to the review comment (status table + output tail of failing checks). Auto-fix already reads that comment as feedback, so the failure output reaches the fixer verbatim.
4. The `review.verdict` event gains `meta.evidence_state` and `meta.evidence_override`.

`timeout` / `error` do not force a verdict: they are usually infrastructure, and forcing `REQUEST_CHANGES` would spend auto-fix attempts on something code cannot fix.

### 4. Self-modification of the evidence config

If the PR diff touches `config/review-evidence.yaml`, the checks ran under the PR's own config, so a `pass` is not authoritative (a generated patch could neuter a check). The prompt block and comment section say so explicitly; `fail` results still force `REQUEST_CHANGES`.

## Alternatives Considered

**Variant B — LLM tool-use loop.** Lets the reviewer pull exactly the context it needs. Rejected for now: non-deterministic cost and latency; tool-calling reliability varies sharply across the models this pipeline targets (Groq/qwen3 default, local models per ADR-0019); and tool execution would have to live in the job holding the LLM key, or require a cross-job RPC. Revisit once A is in place — A's evidence block remains useful as the seed context for B.

**Read `test.yml`'s conclusion via the Checks API.** No duplicated execution, but both workflows start on the same push, so the review would have to poll or move to a `workflow_run` trigger (reopening ADR-0007), and the conclusion alone carries no failure output for the reviewer or auto-fix.

**Run checks inside the `review` job.** Simplest, but executes PR code in a job that holds `AI_PR_TOKEN` and LLM keys — the exact trust-boundary problem ADR-0019 raises for dependency installs.

**Auto-discover commands from `package.json` / CI files.** Convenient across target repos, but non-deterministic and spoofable by the PR itself. Explicit config matches AGENTS.md "prefer safe, deterministic behavior".

## Consequences

- ✅ A `fail` result deterministically blocks `APPROVE`, closing the "reviewer approved a red suite" class of miss independently of model quality.
- ✅ Failure output reaches auto-fix verbatim through the review comment, giving it a concrete target instead of an LLM paraphrase.
- ✅ Secrets stay out of the job that executes PR code.
- ✅ Natural home for ADR-0019's import-allowlist check: it becomes one more declared check.
- ⚠️ Checks run twice per push (`test.yml` and `evidence`). Acceptable at the current suite duration (~6 s); revisit if it grows.
- ⚠️ Adds one job (checkout + setup-node) to the review critical path.
- ⚠️ Evidence runs on push events even when the branch has no open PR (the review then exits early). Accepted to keep the workflow YAML free of PR-resolution logic.
- ⚠️ Commands come from config in the checked-out commit; see §4 for the self-modification mitigation. Reading the config from the base branch would close this fully but needs base-ref resolution on push events — left as a follow-up.
- ⚠️ `timeout` / `error` results are visible but never block — a persistently hanging suite needs an operator, not auto-fix.
