# Landscape

Where this repository sits among cloud coding agents, compared on the axes it cares about. **Not** price, **not** autonomy, **not** benchmark scores.

Positioning, in one line: **a governance and measurement layer for coding agents, provider-agnostic.** The skeleton (issue → patch → review → human) is commodity: Copilot's coding agent, Devin, Codex cloud, Jules and Cursor's cloud agents all cover it. What this repository adds is what decides whether an agent's output may reach `main` and how well it did: guards enforced in code, evidence-gated review, gated evals, a trace of every stage, bounded escalation ([`autonomy-levels.md`](autonomy-levels.md)).

## How to read the table

- **"Not documented"** means: not found in the sources listed below, searched on 2026-10-24. It is **not** a claim of absence. A product may do it and not say so, or say so on a page not read.
- Cells cite a source key (`C1`…); a cell without a key describes this repository (verifiable in its ADRs).
- Only first-party documentation counts as a FACT here. A cell resting on a third-party write-up is marked **(3P)** and is a HYPOTHESIS. As in [`copilot-integration.md`](copilot-integration.md#how-to-read-the-claims), **the pages themselves could not be opened from the analysis environment** (network policy); each cell rests on an official URL surfaced by search together with the excerpt that supports it. Re-read the pages before quoting a cell.
- Products change monthly. Dates in the sources are the freshest signal; this page is a snapshot, not a ranking.

## Comparison on this repository's axes

| Axis | This repository (Level 2) | GitHub Copilot cloud agent | Devin | Codex cloud | Jules | Cursor cloud agents |
|---|---|---|---|---|---|---|
| **Human position** | Ends only: validation label, merge. No merge call exists | Assign an issue or start a task, then PR; workflow runs need a write-access user's approval by default; the requester cannot approve the PR; iterate with `@copilot` (C1, C2, C3) | Sessions started in the UI or by API, optionally on behalf of another user; PR review shows how many approvals a PR needs (C9, C10) | Tasks run in a cloud environment; where the human sits before the PR: Not documented in the sources read | Plan is shown and approved before code changes; API has an approve-plan call; manual approval is the default mode (C13, C14) | Agent pushes a branch and opens a draft PR for review (3P, C15) |
| **Guardrails: code-enforced vs prompted** | Enforced: protected-path denylist, shrink and deletion guards, test-count, module-format, signature, import checks, 6-file cap, attempt cap; patch rejected **before** write (ADR-0021, 0019, 0029, 0044). Prompted: a named defect checklist, stated as such in the README | Platform-enforced: one `copilot/` branch only, no push to the default branch, branch protections and required checks apply, firewall (with documented gaps), filtering of hidden characters (C2). Content-level guards on what is written (shrink, test removal): Not documented | Sandboxed environment with its own shell, editor and browser (3P). Enforcement beyond that: Not documented | Internet access off by default in the agent phase, configurable, routed through a proxy (C11). Content-level guards: Not documented | Human approval of the plan is a gate on intent, not a check of the diff (C13). Code-enforced guards: Not documented | Network egress modes with an allow-list; admin repository block-list and protected Git scopes (C15). Content-level guards: Not documented |
| **Evidence-gated review** (tool results can force the verdict) | Yes: any failing declared check forces `REQUEST_CHANGES`; missing or stale evidence withholds approval; evidence job holds no secrets (ADR-0024, 0026) | A separate code-review feature exists and consumes Actions minutes and credits (C7); whether tool results force its verdict: Not documented | Devin Review posts action-required flags on PRs (C9); whether test results force a verdict: Not documented | Not documented | Not documented | Not documented |
| **Agent identity and secrets** | PAT (`AI_PR_TOKEN`) for PR writes; LLM keys and the PAT live in the review job; PR code runs in a job with none (ADR-0004, 0023, 0024) | Bot `copilot-swe-agent`; PR can be opened under the agent's own app identity; the agent sees only secrets and variables of the `copilot` environment, not the repository's or organization's (C1, C2); assignment needs a user token (C1) | Secrets attachable per session; organization API covers secrets; a GitHub App rather than a PAT is advised (3P) (C9, C10) | Secrets are available to setup scripts and removed before the agent phase; newer "network secrets" are substituted by the proxy for allowed domains (3P) (C11, C12) | API key; secrets handling: Not documented | Three secret kinds (environment, runtime, build); runtime secrets are redacted from transcripts, tool output and commits; repositories reachable only if authorized through the Git connection (C15) |
| **Published evals** | Yes: per-stage offline and live suites, thresholds only tighten (ADR-0027, 0030, 0031), results on the public dashboard | Not documented | Not documented | Not documented | Not documented | Not documented |
| **Bounded escalation** | 3 auto-fix attempts, then `needs-human`; circuit breaker on 3 identical failures; explicit blocked outcome on generation (ADR-0006, 0029, 0050) | A stuck session times out after one hour; the documented retry is unassign and reassign (C4). A cap on `@copilot` rounds: Not documented | Not documented | Not documented | Not documented | Not documented |
| **Cost visibility** | Per-run list-price cost of LLM calls, per provider, in the run record; known limits stated (ADR-0040, 0043) | Billing is usage-based since 2026-06-01: Actions minutes plus AI credits by model and tokens (C5, C6); per-session usage only at enterprise level (C8) | Not documented | Not documented | Not documented | Not documented |

### Notes on the table

- **The columns are not symmetric in evidence.** The left column is documented in this repository's ADRs, where each claim can be checked against code and tests; the others rest on vendor documentation that was searched, not read in full. A reader should treat the right-hand "Not documented" cells as *unknown* and fill them from the vendor's current pages before drawing a comparison.
- **Where the others are ahead.** Platform-level isolation (a managed sandbox, an egress firewall, secret scoping per environment) is built in by the vendors and is not something this repository reproduces: its stages run on Actions runners, which are not a sandbox against a determined escape ([ADR-0052](adr/0052-isolated-oracle-for-executable-evals.md) §3 says so). Plan approval (Jules) is an intent gate this repository has no equivalent for except the validator.
- **Where the claim is narrow.** "Published evals" here means evals of *this loop's stages*, not of any model. "Enforced in code" is true of the writes the loop makes; it says nothing about a different agent's writes. That asymmetry is why [ADR-0054](adr/0054-provider-admission-invariants.md) sets admission invariants instead of listing providers.
- **Price and autonomy are omitted on purpose.** They change faster than the properties above and do not bear on whether output may reach `main`.

## Positioning

**Governance and measurement layer for coding agents, provider-agnostic.**

| It is | It is not |
|---|---|
| A harness that decides what an agent may write on the way to `main` (preventive guards), whether its output was checked by executed evidence, and what it did (trace) | A coding agent that competes on pass rate |
| A way to put two providers on the same validated issues with the same review and caps, and publish the outcome numbers | A ranking of vendors |
| Honest about what it cannot see: an opaque stage is labelled "not traced", never filled in ([ADR-0056](adr/0056-dashboard-writer-and-not-traced.md)) | A promise that any provider can be admitted: one that cannot meet the invariants is confined to a sandbox ([ADR-0054](adr/0054-provider-admission-invariants.md), [ADR-0055](adr/0055-copilot-benchmark-mode.md)) |

What would make the claim false, and should be re-checked: a vendor documents content-level, pre-write guards that a repository can configure; a vendor publishes per-stage evals; a platform feature closes the gap between a path rule and our guard ([ADR-0057](adr/0057-push-rulesets-as-platform-guard.md)). Any of these moves a cell of the table and possibly a provider's admission state.

## Sources

| Key | URL | Cells |
|---|---|---|
| C1 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api | Copilot: assignment, token |
| C2 | https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations | Copilot: approvals, branches, secrets, firewall, filtering |
| C3 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github | Copilot: `@copilot` iteration |
| C4 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/troubleshoot-cloud-agent | Copilot: one-hour timeout, retry |
| C5 | https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent | Copilot: billing units |
| C6 | https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ | Copilot: usage-based billing |
| C7 | https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ | Copilot: code review consumes minutes and credits |
| C8 | https://github.blog/changelog/2026-07-02-copilot-agent-session-streaming-is-now-in-public-preview/ | Copilot: enterprise usage records |
| C9 | https://docs.devin.ai/release-notes/2026 | Devin: PR review, secrets per session |
| C10 | https://docs.devin.ai/api-reference/overview | Devin: organization API, on-behalf-of sessions |
| C11 | https://developers.openai.com/codex/cloud and https://developers.openai.com/codex/cloud/environments | Codex: internet access, secrets |
| C12 | https://siliconangle.com/2026/09/29/openais-codex-gets-reusable-cloud-environments-that-follow-developers-across-devices/ (3P) | Codex: network secrets |
| C13 | https://jules.google/docs/ | Jules: plan approval |
| C14 | https://developers.google.com/jules/api (API labelled `v1alpha`) | Jules: approve-plan call, automation mode |
| C15 | https://cursor.com/docs/cloud-agent/security (draft-PR flow and RBAC from third-party guides, 3P) | Cursor: network, secrets, scopes |
