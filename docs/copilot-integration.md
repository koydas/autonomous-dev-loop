# GitHub Copilot coding agent: findings and opt-in design

Status: **analysis and proposal** (2026-10-24). Nothing here is implemented. Decisions are in [ADR-0053](adr/0053-copilot-opt-in-codegen-provider.md) to [ADR-0057](adr/0057-push-rulesets-as-platform-guard.md), all `Proposed`.

Context: the product named "Copilot coding agent" in older pages is called "Copilot cloud agent" in the current documentation; both names appear in the sources below. It covers the same skeleton as this repository (issue → draft PR → review → human) inside a GitHub-run sandbox. The value of this repository is not the skeleton but the governance and measurement layer ([`autonomy-levels.md`](autonomy-levels.md), [`landscape.md`](landscape.md)). Two invariants decide what can be admitted ([ADR-0054](adr/0054-provider-admission-invariants.md)):

1. the write guard stays **preventive** on any path that can reach `main`;
2. every stage on such a path is **fully traced**.

## How to read the claims

| Label | Meaning |
|---|---|
| **FACT** | Stated by an official vendor page (GitHub Docs or GitHub Changelog) or observed in this repository. The source is cited. |
| **HYPOTHESIS** | Inference, or a claim carried only by a community post, an issue, or a third-party write-up. It is cited when it has a source. |
| **OPEN QUESTION** | Not established. Each one has an experiment in [the sandbox test plan](#sandbox-test-plan). |

**Verification level, stated once.** The sandbox this analysis ran in blocks direct fetches of `docs.github.com` and `github.blog` (proxy `403` on CONNECT, `ENOTFOUND` on the fetch tool). Every FACT below is therefore an official URL **surfaced by a web search together with the excerpt that supports the claim**; the page itself was not opened. Field names and quotations are the ones the excerpts gave. Before an ADR of this set is accepted, re-read the pages in [the re-verification checklist](#re-verification-checklist). Preview features change: the dates below are the ones in the sources.

Source keys used in the register: `S1` to `S13`, listed in [Sources](#sources).

---

## Findings

### 1. Assigning Copilot through the API

| ID | Label | Claim | Source |
|---|---|---|---|
| F1 | FACT | An issue can be assigned to Copilot with either the GraphQL API or the REST API; both support an optional agent assignment input to customise the task. The feature is in public preview and subject to change. | S1, S2 |
| F2 | FACT | The docs map the GraphQL parameters to REST ones; the target repository and base branch are `target_repo` and `base_branch`. | S1 |
| H1 | HYPOTHESIS | The REST request is `POST /repos/{owner}/{repo}/issues` (create) or `PATCH …/issues/{n}` (update) with `assignees: ["copilot-swe-agent[bot]"]` and an `agent_assignment` object carrying `target_repo`, `base_branch`, `custom_instructions`, `custom_agent` and `model`. The first two are in F2; the last three come from community examples and automation-failure reports, not from an excerpt of the docs. | S1; community [#173575](https://github.com/orgs/community/discussions/173575), [gh-aw#71523](https://github.com/github/gh-aw/issues/71523) |
| F3 | FACT | GraphQL requests carry the header `GraphQL-Features: issues_copilot_assignment_api_support`; the docs' examples add `coding_agent_model_selection`. | S1 |
| F4 | FACT | Availability is checked through the repository's `suggestedActors`: with Copilot cloud agent enabled for the user and the repository, the first node has the login `copilot-swe-agent`. | S1 |
| F5 | FACT | Authentication is by a **user token** (a personal access token or a GitHub App user-to-server token). Fine-grained PAT: read on metadata, read and write on actions, contents, issues and pull requests. Classic PAT: `repo`. | S1 |
| H2 | HYPOTHESIS | A GitHub App **installation** token is rejected (error text "Assigning agents is not supported with GitHub App installation tokens", reported in a third-party PR), and the Actions `GITHUB_TOKEN` cannot add the bot as an assignee (HTTP 422, reported in a community post). Consistent with F5, but neither message is in an official excerpt. | [rajbos/Jarvis#288](https://github.com/rajbos/Jarvis/pull/288), community [#186820](https://github.com/orgs/community/discussions/186820) |
| H3 | HYPOTHESIS | The GraphQL equivalent is the mutation `replaceActorsForAssignable` with an `agentAssignment` input that includes `customAgent` (the only sub-field the excerpts quote). The other sub-field names were not verified. | S1; community [#180431](https://github.com/orgs/community/discussions/180431) |
| O1 | OPEN QUESTION | One community post (Dec 2025) says the GraphQL mutation has no parameter for a custom agent; the docs show `customAgent`. Which is current? | S1 vs #180431 |
| F6 | FACT | **Agent tasks API** (public preview): `POST /agents/repos/{owner}/{repo}/tasks` (required `prompt`; optional `base_ref`, model; omitted model means auto selection); list tasks per repository and for the authenticated user; get a task by id with its associated sessions. | S3, S4 |
| F7 | FACT | The agent tasks API supports **user-to-server tokens only**; installation tokens are not supported (the May 2026 changelog said support was "coming soon"). | S3, S4 |
| O2 | OPEN QUESTION | Eligibility: the May 2026 changelog and the endpoint docs say Copilot Business or Enterprise; the 2026-06-04 changelog says Pro, Pro+ and Max can start and track tasks. Which is current? Does the owner of the token need a seat? | S3, S4, S5 |

Consequence for this repository: **there is no bot-identity path.** Assigning requires a person's token or a dedicated machine user's PAT; the existing `AI_PR_TOKEN` strategy ([ADR-0004](adr/0004-pr-authentication-token-strategy.md)) does not extend to it without a seat-holding account. The agent tasks API is the better observation channel (F6: status and sessions by id) and takes the prompt directly, so the validated issue text is what the agent receives.

### 2. Workflow runs on Copilot PRs

| ID | Label | Claim | Source |
|---|---|---|---|
| F8 | FACT | Actions workflows triggered by a PR raised by Copilot cloud agent need approval from a user with write access before they run ("Approve and run workflows" in the merge box). Copilot is treated like an outside contributor in an open-source project. | S6, S7, S8 |
| F9 | FACT | A repository setting lets admins skip that approval (changelog 2026-03-13). The docs warn that the workflows may then run unreviewed agent code with write access to the repository or access to Actions secrets. | S7, S8 |
| F10 | FACT | The agent has no access to Actions organization or repository secrets or variables at run time; only those of the `copilot` environment. | S6 |
| F11 | FACT | The agent can push to one branch only: a new `copilot/` branch, or the PR branch when triggered by `@copilot` on an existing PR. It cannot push to the default branch. Branch protections and required checks apply to it. | S6 |
| F12 | FACT (repo) | `pr-review.yml` triggers on `push` to any branch but `main`; GitHub reads the workflow YAML of a `push` from the pushed branch. [ADR-0023](adr/0023-trusted-pipeline-execution.md) states it as an accepted residual (⚠️ last bullet); `.github/` is protected only by the write denylist of [ADR-0021](adr/0021-protected-write-path-denylist.md). | repo |

**Mapping to ADR-0023 and ADR-0024: is skipping the approval defensible here?**

| Exposure if the approval is skipped | Covered by | Verdict |
|---|---|---|
| A pushed branch edits `scripts/`, `prompts/`, `config/` and the stages then run it with secrets | [ADR-0023](adr/0023-trusted-pipeline-execution.md): stages run from the default branch, branch is data | **Covered** |
| PR code (tests, `npm test`) runs with credentials | [ADR-0024](adr/0024-tool-evidence-for-pr-review.md): evidence job holds no secrets, `contents: read`, no persisted credentials, credential-like env stripped | **Covered** for the evidence job |
| The branch edits `.github/workflows/pr-review.yml`; its `review` job holds `AI_PR_TOKEN` and the LLM keys, and `push` reads the YAML from the branch | Only the write denylist ([ADR-0021](adr/0021-protected-write-path-denylist.md)), which a Copilot push never goes through. [ADR-0023](adr/0023-trusted-pipeline-execution.md) names it as residual. | **Not covered** |
| The branch edits `package.json`, `.npmrc` or another install-surface file; `test.yml` runs `npx c8` in the PR checkout | [ADR-0023](adr/0023-trusted-pipeline-execution.md) §4 (`contents: read`, no secrets) bounds the damage; [ADR-0024](adr/0024-tool-evidence-for-pr-review.md) §4 flags the paths (`EVIDENCE_TRUSTED_PATHS`) | **Bounded, flagged, not prevented** |
| A shrunk or stubbed file reaches a PR | [ADR-0021](adr/0021-protected-write-path-denylist.md) amendment, [ADR-0029](adr/0029-autofix-deterministic-write-guard.md): rejected before write for our stages; for a Copilot push only the review can catch it | **Detective only** |

Conclusion (H4, HYPOTHESIS drawn from the table): on `main`'s repository, skipping approval is **not defensible**, because the one hole (workflow YAML from the branch with secrets in the same workflow) is closed only by a preventive path guard that a Copilot push does not pass through. Keeping the approval is defensible but changes the position of the human: a person clicks in the middle of Level 2, which is no longer P1 ([`autonomy-levels.md`](autonomy-levels.md)); and a click with no gate's context is a weak control. In an **isolated sandbox** the setting is defensible: the secrets there are sandbox-scoped with a spend cap, so the blast radius is the sandbox ([ADR-0055](adr/0055-copilot-benchmark-mode.md)).

### 3. Merge approvals

| ID | Label | Claim | Source |
|---|---|---|---|
| F13 | FACT | Copilot prevents the user who asked it to create the PR from approving it; this keeps the "Required approvals" rule and branch protection meaningful. | S6 |
| F14 | FACT | If the repository requires pull request approvals, the requester's approval of a Copilot PR does not count toward the required number; another reviewer must approve. | S9 |
| F15 | FACT | When Copilot opens a PR under its own app identity, one more approval is required before merge, provided the repository already requires at least one. | S6 |
| H5 | HYPOTHESIS | "The user who asked" is the owner of the token used to assign (F5 forbids installation tokens, so a "bot token" can only be a machine user's PAT). With a machine user as requester, a maintainer's approval counts; with the maintainer's own PAT it does not. Not stated in the excerpts. | inference from F5, F13 |
| O3 | OPEN QUESTION | Does `main` of this repository require approvals? Not readable from this session. If it does and the maintainer is the sole writer and the token owner, a Copilot PR is unmergeable (F14). | repo settings |
| O4 | OPEN QUESTION | Does the rule apply per token owner, per `agent_assignment` actor, or per the user who last commented `@copilot`? | sandbox T3 |

Effect for the design: the merge gate ([ADR-0001](adr/0001-trigger-policy-and-label-gate.md), "the loop never merges") is untouched, but who can satisfy a required-approval rule changes. In the sandbox it does not matter (no approval rule); on any path to `main` it must be tested first (T3).

### 4. Iteration through `@copilot` comments

| ID | Label | Claim | Source |
|---|---|---|---|
| F16 | FACT | Only users with write access can trigger the agent; comments from users without write access are never presented to it. | S6, S10 |
| F17 | FACT | `@copilot` mentions work on open PRs (Copilot's own and others'); once the PR is merged or closed, new mentions are ignored. | S10 |
| F18 | FACT | A valid mention gets a 👀 reaction and a "Copilot started work" event in the PR timeline; "View session" opens the logs. | S10 |
| F19 | FACT | On an existing PR the agent gets write access to the PR branch and pushes commits there. | S10 |
| F20 | FACT | Each follow-up mention starts a new session; context from earlier sessions on the same PR is kept. Batching review comments ("Start a review") avoids one session per comment. | S10 |
| F21 | FACT | A stuck session times out after one hour; the documented retry is unassign and reassign. | S10 |
| O5 | OPEN QUESTION | Is a `@copilot` comment posted by a machine user's PAT, or by a GitHub App, a "user with write access"? | T4 |
| O6 | OPEN QUESTION | What is the completion signal? No webhook or timeline event for "session ended" was found in the sources; the agent tasks API (F6) returns sessions by id and is the candidate. | T5 |
| O7 | OPEN QUESTION | Behavior of a second mention while a session runs (queued, merged, dropped)? | T4 |

**Can the loop-with-guard (3-attempt cap) drive it deterministically?** Split by side:

| Side | Deterministic? | Why |
|---|---|---|
| **Trigger** (whether and when we post `@copilot`) | **Yes** | We decide; the cap is a count of our own posts, kept in the existing `auto-fix-attempt-N` labels ([ADR-0006](adr/0006-label-driven-auto-fix-trigger.md), [ADR-0034](adr/0034-review-fix-loop-converges.md)); the circuit breaker ([ADR-0050](adr/0050-circuit-breaker-review-loop.md)) and one-review-per-head ([ADR-0028](adr/0028-one-review-per-head-sha.md)) act on pushed heads and do not care who pushed. |
| **Effect** (what is pushed, when, whether at all) | **No** | New session per mention, model chosen by the platform unless fixed, duration unbounded up to the one-hour timeout (F21), no documented end-of-session event (O6). |
| **Guard on the effect** | **Detective only** | The agent writes to the PR branch first (F19); our write guard rejects a patch *before* a write. After the push the choices are a `REQUEST_CHANGES`, `needs-human`, or a revert by a person. History is never rewritten on someone's branch. |

Two more differences from our auto-fix: (a) the "fixer" no longer receives only the bounded, evidence-grounded review comment: it also reads the PR, the issue and whatever the agent decides to read, so the review comment is no longer the whole contract; (b) the review comment is LLM-generated text forwarded verbatim to a second agent; hidden-character filtering exists on the platform side ([ADR-0049](adr/0049-adversarial-review-protocol.md) is about the reviewer's analysis, not about sanitising text forwarded as an instruction). Treat it as untrusted input to the second agent.

### 5. Push rulesets, "restrict file paths"

| ID | Label | Claim | Source |
|---|---|---|---|
| F22 | FACT | Push rulesets block pushes to a **private or internal** repository and its entire fork network, by file extension, path length, file and folder paths, and file size. They need no branch targeting: they apply to every push. | S11 |
| F23 | FACT | "Restrict file paths" blocks commits that change the listed paths; patterns are `fnmatch`; limit 200 entries of at most 200 characters. | S11 |
| F24 | FACT | Plan: GitHub Team for private (and internal) repositories; the Enterprise Cloud page adds internal repositories and enterprise-wide rulesets. Forks inherit; bypass permissions follow the root repository. | S11, S12 |
| F25 | FACT | Path **exceptions** are in public preview (2026-08-25): a file matching an exception can be pushed even if it matches a restricted path. | S11 |
| F26 | FACT (repo) | `koydas/autonomous-dev-loop` is **public** and owned by a **user** account (`private: false`, owner type `User`, read through the GitHub API in this session). | repo |
| H6 | HYPOTHESIS | Push rulesets are therefore **not available on this repository**: the sources list private and internal repositories only (F22), and no source lists public ones. | inference from F22, F26 |
| O8 | OPEN QUESTION | Are push rulesets available on a **user-owned private** repository (no organization)? The sources are silent; the GA changelog ties them to Team. | T6 |
| H7 | HYPOTHESIS | The check is server-side and rejects the push, so the branch ref is not updated ("block pushes"). The ordering relative to the ref update is not stated in the excerpts. | inference from S11 wording |
| O9 | OPEN QUESTION | Is a push from the Copilot app subject to the rule, and can it be put on the bypass list by default? F11 says branch protections and required checks apply to it; push rules are not mentioned. What does the agent do when its push is rejected? | T6 |
| O10 | OPEN QUESTION | Symlink handling by the path rule; case sensitivity of patterns. | T6 |

**Gaps against our guard**, where a ruleset would be available:

| Our guard | Push ruleset | Gap |
|---|---|---|
| Protected-path denylist: floor and config, any-depth file names, case-insensitive ([ADR-0021](adr/0021-protected-write-path-denylist.md), [ADR-0044](adr/0044-protected-paths-floor-and-repo-config.md)) | Restrict file paths (`fnmatch`, ≤ 200 entries) | **Close.** Expressible; the list would have to be generated from `protected_paths.mjs` to avoid two sources. Case rule: O10. |
| Same list blocks *humans* only through review; no human is blocked | Applies to every pusher | Maintainers need a bypass for `scripts/`, `docs/`, `README.md` (this repository's own entries). The bypass is a people list, never the agent. |
| Shrink guard: file ≥ 20 lines cut under 50 % of lines or non-whitespace characters ([ADR-0021](adr/0021-protected-write-path-denylist.md) amendment) | None: path rules do not read content | **Total.** |
| ADR-0029: more than max(20, 30 %) of non-blank lines removed; test count drop; file not shown | None | **Total.** |
| ADR-0019: module format, exported signature, unresolved import | None | **Total.** |
| 6 files, 16 000 characters per file ([ADR-0003](adr/0003-safe-output-scope.md)) | File size rules exist; a limit on the number of files per push or PR was not found | **Partial / OPEN.** |
| Non-regular target (symlink, FIFO) never followed ([ADR-0023](adr/0023-trusted-pipeline-execution.md), audit F02) | Not documented | **OPEN (O10).** |
| Rejection is an event: `autofix.skipped` / `code_gen.skipped`, comment, metric, label | A rejected push; whether our trace can see it is not established | **Trace gap (OPEN).** |

A ruleset can therefore cover the *path* component of invariant 1 and only that. See [ADR-0057](adr/0057-push-rulesets-as-platform-guard.md).

### 6. Observability: what Copilot exposes

| ID | Label | Claim | Source |
|---|---|---|---|
| F27 | FACT | Per-session logs show the agent's reasoning and tool use ("View session" from the PR timeline); every agent commit links to its session log; admins can reach them with audit log events. | S6, S10, S13 |
| F28 | FACT | Agent tasks API returns a task and its sessions by id (F6). | S3 |
| F29 | FACT | Enterprise-level: session streaming to a SIEM or event collector and `GET /enterprises/{enterprise}/copilot/usage-records` (last 48 hours), public preview, for GitHub Enterprise Cloud with enterprise managed users; enabled by an admin in AI Controls. | S14 |
| F30 | FACT | Billing is usage-based since 2026-06-01: cloud agent consumes GitHub Actions minutes and AI credits; credits depend on the model and the tokens processed. The earlier unit (one premium request per session) is legacy. | S15, S16 |
| O11 | OPEN QUESTION | Are session **logs** retrievable by API (not only in the UI)? Only task status and sessions were found. | T5 |
| O12 | OPEN QUESTION | Is per-session token or credit usage available below the enterprise level (repository or user)? Conversion of AI credits to currency? | T5 |
| O13 | OPEN QUESTION | Which PR timeline events (`copilot_work_started`, …) the issue events API exposes. | T5 |

What our traces could ingest, and what stays opaque:

| Stage fact | Source | Ingestable? | In the public run record? |
|---|---|---|---|
| Assignment request, response status, task id | Our own call | Yes (we emit it) | Yes: ids, status, duration only |
| Task status and session ids over time | Agent tasks API (F6) | Yes, by polling, preview API | Yes: ids, status, timestamps |
| PR opened, each push (head SHA), review rounds, `@copilot` posts | GitHub events, our own workflows | Yes | Yes |
| Wall-clock from assignment to first push | Derived | Yes | Yes |
| Session reasoning and tool calls | Session log (UI), O11 | **Not by API as far as found** | **Never**: model output and file content are not published ([ADR-0040](adr/0040-run-journal-and-public-run-record.md)) |
| Tokens, model actually used, cost per session | Billing (F30); enterprise API (F29) | Aggregate only, enterprise only | Not per call |
| What the agent read, its prompt composition, its internal retries | Not documented | **Opaque** | No |

So the codegen stage of a Copilot run has **boundaries** (start, outcome, duration, pushes) and an **opaque interior**. That is not "fully traced" in the sense of [ADR-0018](adr/0018-structured-observability.md) / [ADR-0040](adr/0040-run-journal-and-public-run-record.md) (every side effect an event). It is what the dashboard must say plainly ([ADR-0056](adr/0056-dashboard-provider-copilot-not-traced.md)).

### 7. Market landscape

In [`landscape.md`](landscape.md).

---

## Design for opt-in use

Three shapes were considered ([ADR-0053](adr/0053-copilot-opt-in-codegen-provider.md), [ADR-0054](adr/0054-provider-admission-invariants.md)):

| Shape | Invariant 1 (preventive guard) | Invariant 2 (traced) | Status |
|---|---|---|---|
| **A. Direct**: Copilot PR targets `main`'s repository, human merges | ✗ Copilot writes first; guard is detective (finding 4); path guard unavailable here (finding 5) | ✗ opaque interior (finding 6) | **Rejected** for this repository |
| **B. Benchmark**: Copilot runs against an isolated sandbox repository, never `main`; results measured, nothing promoted | n/a: nothing reaches `main` | n/a: nothing reaches `main`; boundaries traced, interior declared "not traced" | **Proposed** ([ADR-0055](adr/0055-copilot-benchmark-mode.md)) |
| **C. Gateway** (candidate, not decided): Copilot's PR targets a staging branch (`base_branch`, F2); a trusted job runs our write guard on the diff and only then writes `ai/issue-<n>` for `main` | ✓ for the branch that reaches `main`: the patch is checked before our pipeline writes it | ✗ if the Copilot session counts as a stage on the path; ✓ if it is classed as an *external patch source* like a human contributor | **Needs a decision** from the maintainer, then a spike |

**The reading of invariant 2 decides shape C.** Under the strict reading ("an opaque stage on such a path is not acceptable") C fails, and Copilot stays benchmark-only. Under the reading "the path begins at the patch source; the source of a patch is outside the pipeline, as a human is", C satisfies both invariants but introduces a new class of input (a patch with no model call of ours behind it) and a promotion step that reads file contents from a branch we do not control (symlinks, non-regular files: [ADR-0023](adr/0023-trusted-pipeline-execution.md), audit F02). This document does **not** adopt that reading; it lists it as a decision for the maintainer (see the PR description).

### Mode B, concretely

- **Where:** a sandbox repository (name chosen by the maintainer; this analysis uses `adl-copilot-sandbox`), user-owned, no secrets shared with production, LLM keys with a spend cap, its own machine user for the assignment PAT (F5) with fine-grained access to the sandbox only.
- **Same pipeline:** the sandbox adopts the reusable workflows ([ADR-0045](adr/0045-reusable-pipeline-workflows.md)): same validator, same evidence job, same review, same caps, so the only variable is the provider of the patch.
- **Trigger:** the label `codegen:copilot` on an issue that already carries `ready-for-dev` (validator passed). The production repository refuses the label (fail closed: provider routing only when `github.repository` is in an allow-list that is empty by default).
- **Assignment:** agent tasks API (F6) or issue assignment (F1), whichever the test plan T1/T2 shows more observable; `base_branch`/`base_ref` set to the sandbox's branch; custom instructions identical to the instruction block of our generation prompt except that nothing in it is a guard.
- **Iteration:** at most 3 `@copilot` rounds, counted by the existing attempt labels; the circuit breaker applies unchanged; then `needs-human`.
- **Approval of workflow runs:** skipped in the sandbox (F9), because the blast radius is sandbox-scoped; this keeps lead time comparable.
- **Detective guard, for measurement:** the same rules our stages enforce (protected paths, shrink, ADR-0029, ADR-0019) are replayed read-only over the Copilot PR diff and recorded as *would have been rejected*. This is a metric, not a control.
- **Cost:** recorded as two non-comparable series ([ADR-0055](adr/0055-copilot-benchmark-mode.md)).

### What is gained and lost

| | Gained | Lost |
|---|---|---|
| Quality | A second, independent coder on the same validated issues; an external reference for our own generation | — |
| Measurement | Paired comparison on identical issues, same review and caps: the first outcome numbers that are not self-referential | Comparability is partial: models differ, context gathering differs, cost units differ |
| Operations | No maintenance of generation prompts or write guards for that arm | Preventive guard; deterministic iteration effect; most of the trace interior; our free-tier cost profile |
| Security | Platform controls we did not build: `copilot/` branch only, firewall, `copilot` environment secrets, hidden-character filter, CodeQL/secret scanning (S6) | The firewall has documented gaps (not applied to MCP servers or setup steps; self-hosted runners unsupported) (S6); a human click or a weakened approval setting (finding 2) |
| Independence | — | Dependence on a public-preview API surface and on user-token auth |

### Open questions

The register above lists O1 to O13. The decisions that need the maintainer, not an experiment, are in the PR description: the invariant-2 reading (shape C), the sandbox repository's name and ownership, the key name for the provider on runs ([ADR-0056](adr/0056-dashboard-provider-copilot-not-traced.md)), and whether a machine-user seat is acceptable.

### Sandbox test plan

Each experiment is a few API calls in the sandbox; each closes an OPEN item and goes into the follow-up PR that implements [ADR-0055](adr/0055-copilot-benchmark-mode.md).

| Test | Closes | Procedure |
|---|---|---|
| T1 | F1, H1, H2, H3, O1 | Assign a trivial issue by REST with each `agent_assignment` field; repeat with GraphQL; try an installation token and `GITHUB_TOKEN` and record the error body |
| T2 | O2, F6, F7 | Start a task through the agent tasks API with a Pro/Business seat; record eligibility and the response shape |
| T3 | H5, O3, O4 | Require 1 approval on a sandbox branch; open a Copilot PR assigned by the maintainer's PAT, then by a machine user's PAT; try approving as each |
| T4 | O5, O7 | Post `@copilot` as the machine user and as an App; post two mentions in a row |
| T5 | O6, O11, O12, O13 | Poll the task and the issue events during a session; look for an end-of-session signal, log access, usage figures |
| T6 | O8, O9, O10, H7 | Create a push ruleset (user-owned private repository, then an organization if available); push as Copilot, as a bypass actor, with a symlink and a case variant |
| T7 | F8, F9 | Confirm that with the approval setting off a workflow edited on the Copilot branch runs with sandbox secrets (the exposure of finding 2, on purpose, in the sandbox) |

### Re-verification checklist

Before accepting any of ADR-0053 to ADR-0057, open and re-read: S1 (field names, tokens, headers), S3 and S4 (agent tasks), S6 (risks and mitigations: approvals, branches, secrets, firewall), S7 and S8 (workflow approval and the skip setting), S11 (push rules: plan and repository types, `fnmatch`, limits), S15 and S16 (billing). Anything that differs from the register is corrected in the register first, then in the ADRs that cite its id.

---

## Sources

| Key | URL | Used for |
|---|---|---|
| S1 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api | F1–F5, H1, H3 |
| S2 | https://github.blog/changelog/2025-12-03-assign-issues-to-copilot-using-the-api/ | F1 |
| S3 | https://docs.github.com/en/rest/agent-tasks/agent-tasks | F6, F7, F28 |
| S4 | https://github.blog/changelog/2026-05-13-start-copilot-cloud-agent-tasks-via-the-rest-api/ | F6, F7, O2 |
| S5 | https://github.blog/changelog/2026-06-04-agent-tasks-rest-api-now-available-for-copilot-pro-pro-and-max/ | O2 |
| S6 | https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations | F8, F10, F11, F13, F15, F16, F27 |
| S7 | https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/ | F8, F9 |
| S8 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/configuring-agent-settings | F8, F9 |
| S9 | https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/reviewing-a-pull-request-created-by-copilot | F14 |
| S10 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github and https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/troubleshoot-cloud-agent | F16–F21, F27 |
| S11 | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets and https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets and https://github.blog/changelog/2026-08-25-push-rules-in-rulesets-now-support-path-exceptions/ | F22–F25 |
| S12 | https://github.blog/changelog/2024-09-10-push-rules-are-now-generally-available-and-updates-to-custom-properties/ and https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets | F24 |
| S13 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/track-copilot-sessions | F27 |
| S14 | https://github.blog/changelog/2026-07-02-copilot-agent-session-streaming-is-now-in-public-preview/ and https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/monitor-agentic-activity | F29 |
| S15 | https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent | F30 |
| S16 | https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ (legacy unit: https://github.blog/changelog/2025-07-10-github-copilot-coding-agent-now-uses-one-premium-request-per-session/) | F30 |

Community and third-party (HYPOTHESIS only): [community #173575](https://github.com/orgs/community/discussions/173575), [#186820](https://github.com/orgs/community/discussions/186820), [#180431](https://github.com/orgs/community/discussions/180431), [gh-aw#71523](https://github.com/github/gh-aw/issues/71523), [rajbos/Jarvis#288](https://github.com/rajbos/Jarvis/pull/288).
