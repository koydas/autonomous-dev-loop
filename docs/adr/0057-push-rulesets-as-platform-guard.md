# ADR-0057: Push rulesets as a platform-level path guard: not viable here, and not sufficient where available

- **Date:** 2026-10-24
- **Status:** Proposed

## Context

[ADR-0054](./0054-provider-admission-invariants.md) requires the write guard to be preventive on any path that can reach `main`. A provider that writes on its own cannot run our guard before the write, but the platform might: GitHub's **push rulesets** with the "Restrict file paths" rule block commits that change listed paths, server-side, for every pusher (F22, F23 of [`copilot-integration.md`](../copilot-integration.md)). If that covered the guard, Copilot could be admitted to a path to `main` by a platform control rather than by one of ours. This ADR is conditional on that question and records the answer.

Findings (register ids in brackets):

- **Availability.** The sources list push rulesets for **private and internal** repositories and their fork networks, on GitHub Team (private) and Enterprise Cloud (internal and enterprise-wide) [F22, F24]. This repository is **public and user-owned** [F26] and no source lists public repositories: not available here [H6]. User-owned private repositories: not established [O8].
- **Server-side.** The rule "blocks pushes"; the exact ordering against the ref update is not stated in what was read [H7]. A rejected push is the normal pre-receive behaviour, which is what preventive requires; it is to be tested, not assumed.
- **Coverage.** The rule matches paths (`fnmatch`, at most 200 entries of 200 characters) [F23]. It reads no content. Against the guard of [ADR-0054](./0054-provider-admission-invariants.md): protected paths close; shrink, deletion share, test count, files shown, module format, signatures, imports: none; the 6-file cap: no limit on files per push found; symlinks and case: not documented [O10]; the rejection as an event in our trace: not established. Full table in `copilot-integration.md` finding 5.
- **Subjects.** It applies to every pusher; a maintainer editing `scripts/`, `docs/` or `README.md` (this repository's own protected entries, [ADR-0044](./0044-protected-paths-floor-and-repo-config.md)) would need a bypass. Whether the Copilot app is subject to it, and what it does when rejected, is not documented [O9]. Path exceptions are in public preview [F25].

## Decision

1. **Not viable for this repository; Copilot stays benchmark-only.** On a public, user-owned repository the platform control is unavailable, so there is no platform-level preventive guard for a Copilot push. The path to `main` of this repository remains closed to Copilot ([ADR-0054](./0054-provider-admission-invariants.md) state table, [ADR-0055](./0055-copilot-benchmark-mode.md)).
2. **Not sufficient where available.** Even in a private or organization-owned repository with push rulesets, the rule covers the path component of invariant 1 only; the content rules would remain detective. It therefore does **not** admit Copilot to a path to `main` by itself, and this ADR does not amend [ADR-0054](./0054-provider-admission-invariants.md). It qualifies as **defence in depth** and as a **precondition** for any later proposal (for example a gateway, shape C of the integration document), not as a replacement for the guard.
3. **If a future repository adopts it, it is generated, not written.** The ruleset's path list is produced from the same source as the denylist (`resolveProtectedPaths()`, floor ∪ `config/protected-paths.yaml`, [ADR-0044](./0044-protected-paths-floor-and-repo-config.md)) by a documented, read-only step, so there are not two lists to keep in step. The people allowed to bypass it are a short list of humans; no agent identity, ours or a vendor's, is a bypass actor. A drift check compares the two lists.
4. **Open items are closed by experiment before any change of mind.** Test T6 of the plan: a ruleset on a user-owned private repository and, if available, an organization repository; push as the Copilot app, as a bypass actor, with a symlink, with a case variant; check that the branch is not updated by a rejected push, how the agent reacts, and whether the rejection is visible to our trace. A result that makes the rule viable for a repository changes decision 1 for **that repository** by a new ADR; it does not change decision 2 unless a platform feature covers content.
5. **Nothing here changes `.github/`, `config/` or `scripts/`.** No ruleset is created or proposed for this repository.

## Alternatives Considered

- **Treat the ruleset as the preventive guard and admit Copilot on the path component.** Splits invariant 1: half preventive, half detective, with the detective half being the incidents that motivated the guard (ADR-0009, ADR-0021). Rejected.
- **Make the repository private or move it to an organization to get the feature.** Changes the project's public, dogfooded nature for a control that covers a fraction of the guard. Rejected; revisit only for another reason.
- **Use required status checks instead.** Detective ([ADR-0054](./0054-provider-admission-invariants.md)): the write has happened, and `.github/` edits reach the push-event residual of [ADR-0023](./0023-trusted-pipeline-execution.md). Kept as defence in depth in the sandbox measurement, not as admission.
- **Branch protection with "restrict who can push".** Controls who may update a branch, not what the update contains; and the Copilot app is already limited to its own branch (F11). Not an alternative to a path rule.
- **A GitHub Actions workflow that rejects the push (revert).** After the fact and history-rewriting on someone else's branch, which this repository never does. Rejected.
- **Wait for a content-aware platform rule.** The only route to admitting a provider on a path to `main` that does not run our code before the write. Monitored, not built: if GitHub documents one, the register and this ADR are updated.

## Consequences

- ✅ The Copilot decision does not depend on an unavailable feature; the benchmark proceeds on the sandbox.
- ✅ The partial value of path rules is recorded with its generated-list rule, so a later adoption does not create a second denylist.
- ✅ A clear trigger to revisit: a platform rule that reads content, or documented availability on public or user-owned repositories.
- ⚠️ Copilot remains unable to contribute to the real repository through its native flow; the cost of that exclusion is the measurement's job ([ADR-0055](./0055-copilot-benchmark-mode.md)).
- ⚠️ The availability finding rests on documentation excerpts (H6): if a private user-owned repository turns out to qualify (O8), the sandbox gains a stronger isolation story, but the decision for the public repository does not change.
- ⚠️ Preview behaviour (path exceptions) and plan boundaries move; the register is the place to re-check.

## Invariants check

| Invariant | Status |
|---|---|
| 1. Write guard preventive on any path that can reach `main` | **Preserved**: no Copilot-written change reaches such a path (decision 1); the platform control is not relied on to claim otherwise (decision 2). |
| 2. Every stage on such a path fully traced | **Preserved**: a path rule does not trace anything, and the ADR does not admit a provider on its strength. |

**Related:** [ADR-0003](./0003-safe-output-scope.md), [ADR-0021](./0021-protected-write-path-denylist.md), [ADR-0023](./0023-trusted-pipeline-execution.md), [ADR-0044](./0044-protected-paths-floor-and-repo-config.md), [ADR-0053](./0053-copilot-opt-in-codegen-provider.md), [ADR-0054](./0054-provider-admission-invariants.md), [ADR-0055](./0055-copilot-benchmark-mode.md).
