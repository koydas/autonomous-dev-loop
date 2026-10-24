# ADR-0053: Copilot coding agent as an opt-in code-generation provider

- **Date:** 2026-10-24
- **Status:** Proposed

## Context

GitHub Copilot's coding agent covers the skeleton this repository implements: issue in, draft PR out, iteration by comment, a person at the end ([`autonomy-levels.md`](../autonomy-levels.md), [`copilot-integration.md`](../copilot-integration.md)). It can be started from this repository's own trigger, a labelled issue, through an API (F1, F6 of the register). What it cannot be, today, is a provider of the existing code-generation stage:

- It writes to a branch **before** any guard of ours can reject the patch (F11, F19): the guard of [ADR-0021](./0021-protected-write-path-denylist.md), [ADR-0019](./0019-static-verification-backstop.md) and [ADR-0029](./0029-autofix-deterministic-write-guard.md) becomes detective.
- Its session interior is not available to our traces (finding 6): the stage is partly opaque.
- Its workflow runs need a person's approval or an admin setting that opens an exposure this repository documents as residual (finding 2, [ADR-0023](./0023-trusted-pipeline-execution.md)).
- It authenticates as a user and bills in units we do not meter (F5, F30).

Those are properties of the provider, not defects of the idea. The two non-negotiable invariants ([ADR-0054](./0054-provider-admission-invariants.md)) decide whether a provider may sit on a path that reaches `main`; this ADR decides how Copilot is *offered*, whatever the answer.

## Decision

1. **Opt-in per issue, never default, and only after `ready-for-dev`.** Copilot is selected only by the label `codegen:copilot` on an issue that **already carries `ready-for-dev`** ([ADR-0001](./0001-trigger-policy-and-label-gate.md)): the validator ran and passed, with its score and blockers. Nothing happens before that label: an issue without it is neither mirrored nor assigned, and removing `ready-for-dev` (or a `needs-human`/`needs-refinement` label appearing) before the sync cancels the request. A repository setting never routes issues to Copilot by default, and no fallback sends an issue to Copilot when our own generation fails or is blocked (a block is explicit and ends at `needs-human`, [ADR-0029](./0029-autofix-deterministic-write-guard.md) amendment).
2. **In production the label means "observe", never "assign".** In any repository that can reach `main`, `codegen:copilot` requests **observation**: after `ready-for-dev`, the issue is mirrored into the isolated sandbox and Copilot runs there under the benchmark protocol ([ADR-0055](./0055-copilot-benchmark-mode.md) decision 3). The production issue continues through our own generation exactly as without the label, which is the control arm; nothing Copilot writes comes back. Assignment of Copilot happens only in repositories listed in `copilot.allowed_repositories` (empty by default; today the sandbox only), and the router fails closed on anything else. **The mirror is pulled, not pushed:** a scheduled workflow in the sandbox reads the production repository's public issues (labels, title, body) with no production credential, and production holds no credential for the sandbox. Listing a repository that can reach `main` as an assignment target requires an ADR that supersedes or amends this one and shows [ADR-0054](./0054-provider-admission-invariants.md) satisfied.
3. **One stage, one provider per issue.** Within the sandbox the label selects the provider of the code-generation stage and of the iteration that follows it for that issue. Validation, evidence, review, caps, labels, concurrency ([ADR-0020](./0020-per-pr-workflow-concurrency.md)) and the merge gate are unchanged and shared. A mixed run (our generation, Copilot auto-fix, or the reverse) is not offered: it would make the measurement of [ADR-0055](./0055-copilot-benchmark-mode.md) uninterpretable.
4. **Identity and secrets are separate, in both directions.** The assignment uses a user token (F5), held by a dedicated machine user and stored only in the sandbox repository's secrets; it has no access to production repositories and is not `AI_PR_TOKEN`. The production repository holds no Copilot-capable token and no sandbox credential (the mirror is pulled from public data, decision 2). No Actions secret is shared between production and sandbox.
5. **Iteration is bounded by our counter.** A Copilot-provided PR is iterated with at most 3 `@copilot` rounds, counted by the existing `auto-fix-attempt-N` labels ([ADR-0006](./0006-label-driven-auto-fix-trigger.md), [ADR-0034](./0034-review-fix-loop-converges.md)); the circuit breaker ([ADR-0050](./0050-circuit-breaker-review-loop.md)) applies unchanged. The count is deterministic on the trigger side; the effect of a round is not (finding 4), and the ADR does not claim otherwise.
6. **Nothing is implemented by this ADR.** The router, the allow-list, the label and the workflows are follow-up work behind [ADR-0055](./0055-copilot-benchmark-mode.md)'s test plan. Until they exist `codegen:copilot` has no meaning in any repository.

## Alternatives Considered

- **Copilot as the default coder, ours as fallback.** Reverses the trust order: the provider that cannot meet the invariants would be on the main path. Rejected.
- **Fallback to Copilot when our generation blocks.** The block exists because the needed files are protected or the model signalled a dependency ([ADR-0029](./0029-autofix-deterministic-write-guard.md)); sending the issue to an agent that is not subject to the protected list defeats it. Rejected.
- **Honour the label in production, rely on review.** Detective-only on a path to `main`; violates [ADR-0054](./0054-provider-admission-invariants.md) invariant 1. Rejected.
- **A repository-level switch instead of a per-issue label.** Moves the decision away from the person who sees the issue and makes the provider a default. Rejected.
- **Assign through the organization-wide app identity.** Not possible: installation tokens are rejected by the assignment surface (F5, H2). Not an alternative, a constraint.
- **Push the mirror from production** (a production workflow creates the sandbox issue). Needs a sandbox-write credential in production; the pull model needs none and reads only public data. Rejected.
- **Assign Copilot in production for observation, discard the PR.** The PR would exist on a branch of the real repository, with the approval exposure of finding 2. Rejected.
- **Mixed arms (our generation, Copilot iteration).** Considered for cost; rejected for the measurement reason in 3. May return as a third arm once the two pure arms have data.

## Consequences

- ✅ A person decides, per issue, to have Copilot observed on it, after the validator has passed it; every observed real issue is a paired case with our own arm for free.
- ✅ The production repository cannot reach Copilot by accident: no token, no allow-list entry, nothing pushed to the sandbox, nothing pulled back.
- ✅ Review, evidence, caps and the human gate stay exactly what they are for both providers.
- ⚠️ The opt-in changes nothing in production (no Copilot patch is ever applied there) until a later ADR admits a provider. The first value is observation and measurement, not throughput.
- ⚠️ The pull model is scheduled, so the mirror lags the label by up to one interval; lead time of the Copilot arm starts at the mirror's creation, and the lag is recorded, not hidden.
- ⚠️ Issue text is untrusted input; mirroring it into the sandbox is acceptable because the sandbox holds nothing of value ([ADR-0055](./0055-copilot-benchmark-mode.md)), and the validator has already passed it.
- ⚠️ A machine user needs a Copilot seat (F5; O2 of the register); the cost is a licence, not tokens.
- ⚠️ The label is an interface: the router must treat label events from untrusted actors as it treats `ready-for-dev` ([ADR-0001](./0001-trigger-policy-and-label-gate.md)); a collaborator-only rule applies.
- ⚠️ Public-preview APIs (F1, F6): the adapter will need a version pin and a contract test against a recorded response, as `ai-dev-tools` ADR-011 does for its GraphQL transport.

## Invariants check

| Invariant | Status |
|---|---|
| 1. Write guard preventive on any path that can reach `main` | **Preserved**: no Copilot-written change reaches a path to `main` through this ADR (decision 2: production only mirrors and observes). In the sandbox nothing reaches `main`. |
| 2. Every stage on such a path fully traced | **Preserved** for the same reason; the sandbox traces boundaries and declares the interior "not traced" ([ADR-0056](./0056-dashboard-writer-and-not-traced.md)). |

**Related:** [ADR-0001](./0001-trigger-policy-and-label-gate.md), [ADR-0004](./0004-pr-authentication-token-strategy.md), [ADR-0006](./0006-label-driven-auto-fix-trigger.md), [ADR-0021](./0021-protected-write-path-denylist.md), [ADR-0023](./0023-trusted-pipeline-execution.md), [ADR-0029](./0029-autofix-deterministic-write-guard.md), [ADR-0045](./0045-reusable-pipeline-workflows.md), [ADR-0050](./0050-circuit-breaker-review-loop.md), [ADR-0054](./0054-provider-admission-invariants.md) to [ADR-0057](./0057-push-rulesets-as-platform-guard.md). Amends none; contradicts no accepted ADR.

**Acceptance:** this ADR stays `Proposed` until the sandbox tests T1 to T7 ([`copilot-integration.md`](../copilot-integration.md#sandbox-test-plan)) have closed the OPEN items it depends on (O1, O2, O5, O6).
