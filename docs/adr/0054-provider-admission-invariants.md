# ADR-0054: Provider admission: a preventive write guard and full traceability

- **Date:** 2026-10-24
- **Status:** Proposed

## Context

Until now the only writer of patches was this repository's own stages, so the properties of the writer were properties of the code: every write passes `validateAiOutput()`, the static verifier and the write guard before anything touches disk ([ADR-0003](./0003-safe-output-scope.md), [ADR-0019](./0019-static-verification-backstop.md), [ADR-0021](./0021-protected-write-path-denylist.md), [ADR-0029](./0029-autofix-deterministic-write-guard.md)), and every side effect is an event in the run journal ([ADR-0018](./0018-structured-observability.md), [ADR-0040](./0040-run-journal-and-public-run-record.md), [ADR-0041](./0041-end-to-end-work-item-tracing.md)). Those two properties are why a human can be at the ends only ([`autonomy-levels.md`](../autonomy-levels.md)).

An external coding agent writes on its own. Whether it is allowed on a path to `main` should not depend on how good it is, how well it scored on a benchmark, or how much its vendor documents; ADR-0009 is the record of what happens when a guard is advice. The rule has to be about **what the loop can still do about a write**.

## Decision

Two invariants, both required, for any writer (any provider, any agent, any future version of ours) on **a path that can reach `main`**.

**Definition.** A path can reach `main` when a ref the writer can update is, or can become without a further write by an admitted writer, the head of a pull request into the default branch, or an ancestor of one. A branch that only an admitted writer can promote into such a ref is not on the path; the promotion is.

### Invariant 1: the write guard is preventive

The guard verdict is computed on the proposed change and a rejected change is **never written** to a ref on the path. "Preventive" means the whole guard, as enforced today:

- the protected paths, floor and config ([ADR-0021](./0021-protected-write-path-denylist.md), [ADR-0044](./0044-protected-paths-floor-and-repo-config.md));
- the shrink and deletion rules, the test-count rule, the files-shown rule ([ADR-0021](./0021-protected-write-path-denylist.md) amendment, [ADR-0029](./0029-autofix-deterministic-write-guard.md));
- the module-format, exported-signature and unresolved-import rules ([ADR-0019](./0019-static-verification-backstop.md));
- the limits of [ADR-0003](./0003-safe-output-scope.md) and non-regular targets ([ADR-0023](./0023-trusted-pipeline-execution.md) and the 2026-10-19 audit, F02).

The following do **not** satisfy it, by themselves or together: a required status check that runs after the push; a review that withholds approval; a revert; a rule that covers only paths (a push ruleset, [ADR-0057](./0057-push-rulesets-as-platform-guard.md)); a vendor's own safeguards that this repository cannot configure or observe. They are useful defence in depth and are kept; they are detective for the content of the write.

### Invariant 2: every stage on the path is fully traced

Every side effect of the stage is an event in the run journal and the stage has a span with its outcome and `duration_ms`, as [AGENTS.md](../../AGENTS.md) "Observability Rules" require of every pipeline stage; the trace identity is the work item's ([ADR-0041](./0041-end-to-end-work-item-tracing.md)); the public record is redacted by the allow-list ([ADR-0040](./0040-run-journal-and-public-run-record.md)). A stage whose interior is not observable by this repository (a call that returns a result with no account of what was read, called or retried) is **opaque**, and an opaque stage is not acceptable on the path. Boundary events around an opaque stage do not make it traced; they make its opacity visible, which is what the dashboard shows ([ADR-0056](./0056-dashboard-provider-copilot-not-traced.md)).

### Admission

A provider is **admitted** to a path only when both invariants hold *for that path*, shown by a test in this repository, not by a vendor statement. Otherwise it is **confined to an isolated benchmark sandbox** ([ADR-0055](./0055-copilot-benchmark-mode.md)): a repository or branch from which nothing can reach `main`, with credentials that cannot touch production.

| Writer | Invariant 1 | Invariant 2 | State |
|---|---|---|---|
| Own generation and auto-fix (Groq, Anthropic) | ✓ ([ADR-0019](./0019-static-verification-backstop.md), [ADR-0029](./0029-autofix-deterministic-write-guard.md)) | ✓ (`llm_call` spans, journal) | **Admitted** |
| GitHub Copilot coding agent, direct to `main`'s repository | ✗ writes first (F11, F19); path rules unavailable on this repository (F26, H6) and path-only anyway (finding 5) | ✗ interior opaque (finding 6) | **Not admitted**; sandbox only |

A change of state needs an ADR that amends this table and cites the test that shows each invariant, on the path in question.

### Not decided here

A **promotion gateway** (shape C of [`copilot-integration.md`](../copilot-integration.md#design-for-opt-in-use)): the agent's output lands on a staging ref outside the path, and a trusted job applies the guard to the diff and writes the PR branch itself. It would satisfy invariant 1 for the branch that reaches `main`. Whether it satisfies invariant 2 depends on whether the agent's session counts as a stage on the path or as a source of patches, as a human contributor is. This ADR does not take that reading. It is a decision for the maintainer and, if taken, a new ADR that also specifies how file content is read from a branch the pipeline does not control.

## Alternatives Considered

- **Admit on measured quality.** An accuracy or approval-rate threshold says how often the output is good, not what happens in the case where it is not. A guard exists for that case. Rejected; quality is measured in the sandbox, it does not admit.
- **Accept a detective guard plus a required check.** Merge is still human-gated, so the damage is bounded by review. But the failure modes recorded in ADR-0009 and ADR-0021 (a stubbed test suite, a stub `README`) passed an LLM review; the guard exists because review is not a substitute. And a detective control on `.github/` is exposed to the push-event residual of [ADR-0023](./0023-trusted-pipeline-execution.md) (finding 2). Rejected.
- **Trust the vendor's safeguards.** They are real (the agent pushes to one `copilot/` branch only, runs behind a firewall, sees only `copilot`-environment secrets; F10, F11), and none is a content guard we can configure or observe. Rejected as a substitute; accepted as defence in depth.
- **Per-provider exceptions in config.** A list of "trusted" providers invites the self-hosting failure ADR-0021 rejected for its opt-in flag. The state table above changes by ADR, not by config.
- **Require tracing but not prevention (or the reverse).** Each alone leaves the loop either blind or defenceless. Both are required.

## Consequences

- ✅ A short admission test that does not depend on any vendor's claims and applies to future providers unchanged.
- ✅ The sandbox rule has a reason a reader can check, not a preference.
- ✅ Explains in advance why a better-scoring agent is still not admitted.
- ⚠️ It excludes useful providers from the path that matters. The benchmark ([ADR-0055](./0055-copilot-benchmark-mode.md)) exists so that the cost of the exclusion is measured instead of guessed.
- ⚠️ "Fully traced" depends on the vendor exposing enough; a vendor that does later changes the state by ADR, not silently.
- ⚠️ The gateway question (above) is open and decides whether any external agent can ever be admitted here.

## Invariants check

This ADR *is* the invariants; it was checked against the accepted ones it relies on and contradicts none: [ADR-0019](./0019-static-verification-backstop.md), [ADR-0021](./0021-protected-write-path-denylist.md), [ADR-0023](./0023-trusted-pipeline-execution.md), [ADR-0029](./0029-autofix-deterministic-write-guard.md), [ADR-0040](./0040-run-journal-and-public-run-record.md), [ADR-0044](./0044-protected-paths-floor-and-repo-config.md). It adds a rule about *other* writers; it changes nothing about our own stages.

**Related:** [ADR-0053](./0053-copilot-opt-in-codegen-provider.md), [ADR-0055](./0055-copilot-benchmark-mode.md), [ADR-0056](./0056-dashboard-provider-copilot-not-traced.md), [ADR-0057](./0057-push-rulesets-as-platform-guard.md).
