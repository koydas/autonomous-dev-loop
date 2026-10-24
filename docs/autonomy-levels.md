# Autonomy levels

Two repositories implement the same skeleton at two positions of the human. This page fixes the vocabulary, the primitive mapping and the handoff between the levels. It decides nothing new: the decisions it relies on are the ADRs it links.

```
analyze  →  code  →  review  →  human gate
```

| | Level 1 — `koydas/ai-dev-tools` | Level 2 — `koydas/autonomous-dev-loop` (this repository) |
|---|---|---|
| Runtime | Claude Code, interactive, on a developer's machine or cloud session | GitHub Actions, headless |
| Trigger | The human types the command | A label (`ready-for-dev`, `changes-requested`) set by a validator, a reviewer or a person |
| Human position | At **every** handoff (`NEEDS_REVIEW` halts the pipeline) | At the **ends** only: the validation gate (issue quality, label) and the merge gate (the loop never merges) |
| What bounds the agent | The human reading each step; `NEEDS_REVIEW` | Limits enforced in code: validator, 6-file cap, protected paths, write guards, attempt cap, circuit breaker |
| "Simple task" means | What the person judges simple | What Level 2's limits admit, operationally (below) |

## Human-position axis

The axis is *where the human sits relative to the agent's writes*, not how capable the agent is.

| Position | Human acts | Agent writes before the human sees it | Example |
|---|---|---|---|
| P0 — in the loop | Before each step | Nothing | Level 1 `issue-code-generation`: analyst brief, then builder, then reviewer, each stopped at a gate |
| P1 — at the ends | Before the pipeline starts and before the merge | A patch, a PR, review rounds, fixes — all bounded by code | Level 2 |
| P2 — at the end only | At the merge | Everything, including its own scope | A coding agent assigned from an issue that opens a draft PR (the provider-agnostic description; the products are in [`landscape.md`](landscape.md)) |
| P3 — on exception | Only when the agent escalates | Merge included | Out of scope: this repository has no merge call ([`mvp.md`](mvp.md)) |

Level 2 is P1, and what makes P1 acceptable is that **everything the agent can do between the ends is bounded by code, not by a prompt** ([ADR-0009](adr/0009-llm-agent-guardrails.md), [ADR-0019](adr/0019-static-verification-backstop.md), [ADR-0021](adr/0021-protected-write-path-denylist.md), [ADR-0029](adr/0029-autofix-deterministic-write-guard.md)). An external coding agent sits at P2 by default; admitting one to Level 2 means holding it to the same two properties ([ADR-0054](adr/0054-provider-admission-invariants.md)):

1. the write guard is **preventive** on any path that can reach `main`: the patch is rejected before anything is written;
2. every stage on such a path is **fully traced**.

A step where a person must click in the middle of Level 2 (for example approving a workflow run) is not P1: it moves a human into the pipeline without the context a gate needs, and it is treated as a cost of the provider, not as a free control ([`copilot-integration.md`](copilot-integration.md), finding 2).

## "Simple task", defined by Level 2's limits

A task is simple at Level 2 when all of these hold; each is a limit already enforced in code:

| Limit | Enforced by |
|---|---|
| The issue passes the validator and carries `ready-for-dev` | [ADR-0001](adr/0001-trigger-policy-and-label-gate.md), `validate-issue.yml` |
| At most 6 files, relative paths, 16 000 characters each | [ADR-0003](adr/0003-safe-output-scope.md) |
| None of the needed files is on the protected list | [ADR-0021](adr/0021-protected-write-path-denylist.md), [ADR-0044](adr/0044-protected-paths-floor-and-repo-config.md); a block is explicit ([ADR-0029](adr/0029-autofix-deterministic-write-guard.md) amendment) |
| No existing file loses more than half of its lines; tests never shrink; no module-format, signature or unresolved-import change | [ADR-0019](adr/0019-static-verification-backstop.md), [ADR-0029](adr/0029-autofix-deterministic-write-guard.md) |
| Review converges within 3 auto-fix attempts and without 3 identical failures | [ADR-0006](adr/0006-label-driven-auto-fix-trigger.md), [ADR-0034](adr/0034-review-fix-loop-converges.md), [ADR-0050](adr/0050-circuit-breaker-review-loop.md) |

A task that fails one of these is not "hard" in the abstract: it is outside Level 2, and the loop says so (`needs-human`, a comment with the source of the block).

## Primitive mapping

Level 1's three primitives ([ADR-001](https://github.com/koydas/ai-dev-tools/blob/main/docs/adr/ADR-001-human-as-gate.md), [ADR-002](https://github.com/koydas/ai-dev-tools/blob/main/docs/adr/ADR-002-three-primitive-architecture.md) there) are rules, agents and commands. Level 2 has no agent files: a "stage" is a workflow plus a script plus a prompt. The mapping is by role.

| Role | Level 1 agent (`ai-dev-tools/agents/`) | Level 2 stage | Where the Level 2 stage is enforced |
|---|---|---|---|
| Analyze | `ticket-analyst` (brief, acceptance criteria, scope) | Validator (`issue_validator.mjs`, `validate-issue.yml`) | Score and blockers decide the `ready-for-dev` label; under-specified issues never reach generation |
| Code | `code-builder` (and `-bug`, `-feature`, `-refactor`) | Code generation (`generate_issue_change.mjs`) and Auto-fix (`auto_fix_pr.mjs`) | Write guards before any write; 6-file cap; protected paths |
| Review | `code-reviewer` (tool-grounded, [ADR-009 there](https://github.com/koydas/ai-dev-tools/blob/main/docs/adr/ADR-009-tool-grounded-review.md)) | PR review (`pr_review.mjs`) plus the evidence job | Failing check forces `REQUEST_CHANGES`; missing evidence withholds approval ([ADR-0024](adr/0024-tool-evidence-for-pr-review.md), [ADR-0026](adr/0026-withhold-approval-on-unverified-evidence.md)) |
| Human gate | The human at each `NEEDS_REVIEW` | Validation label, `needs-human`, merge | No merge call exists in `scripts/` or the workflows |

Level 1 has agents with no Level 2 counterpart (`code-challenger`, `impact-analyst`, `issue-router`, `pr-analyst`); Level 2 has stages with no Level 1 counterpart (circuit breaker, run journal, evals). The mapping is a role map, not an equivalence: the same role is done by a different mechanism and under a different set of guarantees.

What differs in kind, not in degree, is the guarantee on the *coder*: at Level 1 a person reads the patch before it is applied; at Level 2 a function rejects it. That is why an external coder cannot be admitted by being good: it is admitted by being *checkable at the same point*.

## Level 2 → Level 1 handoff on `needs-human`

`needs-human` is the point where Level 2 gives up and a person continues, usually at Level 1 (`/pr-fixer`, `/issue-code-generation`, `/ac-check`). What a person (or the Level 1 command) can read today, per cause:

| Cause (what the label means) | Context already published | Where |
|---|---|---|
| Generation blocked (`denylist`, `model`, `notes_only`) | Source of the block, reason, the model's `planned_fix`, the protected paths that forced it | `Code Generation: Blocked` comment on the issue ([ADR-0029](adr/0029-autofix-deterministic-write-guard.md) amendment) |
| Patch rejected | Rule and reason per file | `Code Generation: Patch Rejected` / `Auto-Fix: Patch Rejected` comment ([ADR-0019](adr/0019-static-verification-backstop.md)) |
| Attempt cap (3) reached | The three review comments, each with the tool-evidence table and findings; `auto-fix-attempt-N` labels | PR conversation ([ADR-0006](adr/0006-label-driven-auto-fix-trigger.md), [ADR-0034](adr/0034-review-fix-loop-converges.md)) |
| Circuit breaker open (3 identical failures) | `🚨 ESCALATED` note, failure signature (failing checks and cited files), streak in the review marker | Review comment ([ADR-0050](adr/0050-circuit-breaker-review-loop.md)) |
| Any | Trace identity of the work item; stage spans and decisions; redacted run record | `metrics` branch, Pipelines and Investigation pages ([ADR-0040](adr/0040-run-journal-and-public-run-record.md), [ADR-0041](adr/0041-end-to-end-work-item-tracing.md), [ADR-0043](adr/0043-diagnostic-observability-console.md)) |

What does **not** transfer, by design: prompts, model output and file contents (never in the public run record, [ADR-0040](adr/0040-run-journal-and-public-run-record.md)), and the checkpoints (artifacts expire). A Level 1 session starting from `needs-human` therefore re-reads the PR and the issue and recomputes; it does not inherit the model's reasoning.

**Gap (OPEN QUESTION):** there is no single document to hand over. A person assembles it from comments, labels and the dashboard. A handoff packet, a read-only function from (issue, PR, review comments, run record) to one JSON document, is the natural shape and follows the meta-loop's pattern ([ADR-0046](adr/0046-meta-loop-read-only-stats-to-levers.md): pure, read-only, no write on GitHub). Not proposed here as an ADR: the consumer is a Level 1 command in another repository, so the contract belongs to a joint decision (`ai-dev-tools` ADR-017 is the precedent for how `findings.json` is read). Until then the table above is the contract by convention.

## Router across levels (future work)

A router decides *which level and which provider* takes a task, before anything runs. Nothing here is built; this is the shape it would have to take so it does not contradict the invariants.

- **Input:** the validated issue (score, blockers, files named, protected paths hit, size), the history of the repository (rejection rate per rule, escalation rate), and a provider registry with each provider's admission state ([ADR-0054](adr/0054-provider-admission-invariants.md)).
- **Output:** a route: Level 2 / provider A, Level 2 / provider B (benchmark only), Level 1, or "needs a person". Level 1 is the default for anything the deterministic blocks of generation already detect (all needed paths protected, an unmerged dependency).
- **Constraints:** the route is a *label*, set by a deterministic rule first; an LLM may only propose a route a person or a rule confirms (the ADR-0043 and ADR-0046 rule: a generated diagnosis could present a hypothesis as a fact). A provider that is not admitted is never routable outside its sandbox ([ADR-0055](adr/0055-copilot-benchmark-mode.md)).
- **Why not now:** the router needs per-provider outcome data that the benchmark ([ADR-0055](adr/0055-copilot-benchmark-mode.md)) is meant to produce, and the existing `issue-router` agent at Level 1 routes issues to code-builder variants, not across levels.
