# Operator Runbook — Failure Triage

## Symptom → Probable Cause Mapping

| Symptom | Probable Cause |
|---------|----------------|
| `validate-issue` never starts after issue open/edit | Missing `issues: write` permission on `GITHUB_TOKEN`; workflow file syntax error; branch protection blocking Actions |
| Issue stays unlabelled after validation run | LLM API key missing or invalid; `manage_labels.mjs` failed to create labels (check for 403/404 in logs) |
| `ready-for-dev` applied but `code-generation` never triggers | Workflow trigger mismatch (label name drift vs `config/labels.yaml`); `AI_PR_TOKEN` / `GITHUB_TOKEN` lacks `contents: write` |
| Generation run completes but no PR is created | Empty LLM output (no valid JSON patch); all generated paths failed safety check; `AI_PR_TOKEN` scope too narrow; **Allow GitHub Actions to create pull requests** disabled |
| PR opens but files are wrong or empty | Prompt template issue (`generation-user.md` placeholders not resolved); model returned malformed JSON; `output_writer.mjs` rejected paths (absolute or `..` traversal) |
| `pr-review` never posts a comment | No open PR found for the push branch (exits silently by design); LLM API error; `pull-requests: write` permission missing |
| Review verdict is always `REQUEST_CHANGES` loop never resolves | AI prompt regression; issue body too vague for the generated code to satisfy review criteria; consider manual review |
| `auto-fix-pr` does not trigger after `changes-requested` label | Label name mismatch (`config/labels.yaml` `review.changes.name` vs actual label); `AI_PR_TOKEN` cannot emit `labeled` events; auto-fix workflow not enabled |
| Auto-fix loop stops at attempt 3 | Expected: 3-attempt hard limit reached — manual intervention required (see below) |
| Provider outage (Anthropic or Groq) | All LLM-calling workflows fail with HTTP 5xx or timeout; switch provider via `AI_PROVIDER` variable |
| Token permission drift | Workflows fail with 403; audit PAT/App token scopes and repository secret values |

---

## Log Locations

For every workflow run, navigate to:

**Actions → \<Workflow Name\> → \<Run\> → \<Job\> → Step logs**

Key steps to expand per workflow:

### `validate-issue` (`validate-issue.yml`)
- **Validate issue** — LLM call result, score, verdict
- **Manage labels** — label create/apply/remove HTTP status
- **Upsert issue comment** — comment POST/PATCH result

### `code-generation` (`code-generation.yml`)
- **Generate issue change** — prompt construction, LLM response, file write results
- **Create Pull Request** — PR number or error from `peter-evans/create-pull-request`

### `pr-review` (`pr-review.yml`)
- **Run PR review** — PR resolution, LLM call, comment upsert, review submit, label swap, re-pulse guard result

### `auto-fix-pr` (`auto-fix-pr.yml`)
- **Run auto-fix** — attempt count read, LLM call, file writes, commit push, attempt label apply

---

## Recovery Actions per Workflow

### `validate-issue`

| Failure | Recovery |
|---------|----------|
| API key missing | Add `ANTHROPIC_API_KEY` or `GROQ_API_KEY` in **Settings → Secrets → Actions**, re-run workflow |
| Label creation 403 | Ensure `GITHUB_TOKEN` or `AI_PR_TOKEN` has `issues: write`; re-run workflow |
| Workflow never triggered | Check **Settings → Actions → General → Actions permissions**; confirm `issues` trigger in `validate-issue.yml` |
| Manual label override needed | Apply `ready-for-dev` or `needs-refinement` directly from the issue Labels panel; `code-generation` will trigger on the next `labeled` event |

### `code-generation`

| Failure | Recovery |
|---------|----------|
| Empty generation output | Improve the issue body (title + clear acceptance criteria), remove and re-apply `ready-for-dev` |
| PR creation forbidden | Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** or set `AI_PR_TOKEN` with `pull-requests: write` |
| Branch `ai/issue-<N>` already exists with conflicts | Delete the stale branch manually via **Code → Branches**, then re-apply `ready-for-dev` |
| Provider outage | Set `AI_PROVIDER=groq` in **Settings → Variables → Actions** (or swap to `anthropic`) and re-run |

### `pr-review`

| Failure | Recovery |
|---------|----------|
| No PR found for branch | Expected for non-PR branches; if unexpected, verify branch name matches the open PR head |
| Review submit 422 warning | Enable **Allow GitHub Actions to create and approve pull requests**; comment and labels still apply — auto-fix can still trigger via the `changes-requested` label |
| Review submit 500 | Transient GitHub API issue; re-push an empty commit to re-trigger: `git commit --allow-empty -m "re-trigger review" && git push` |
| Re-pulse skipped (auto-fix already running) | Expected guard behavior; wait for the running auto-fix job to complete |

### `auto-fix-pr`

| Failure | Recovery |
|---------|----------|
| Attempt limit reached (3/3) | Review the PR manually; apply fixes, push, then remove `changes-requested` and apply `review-approved` if satisfied, or leave for human merge decision |
| LLM returns invalid JSON | Check `auto-fix-system.md` for prompt integrity; re-trigger by removing and re-applying `changes-requested` label |
| Commit push fails (branch protection) | Ensure `AI_PR_TOKEN` has `contents: write` and branch protection allows bot pushes |
| `auto-fix-attempt-N` label missing | Labels are auto-created on first use; if creation fails (403), grant `issues: write` to the token used |

---

## Escalation Criteria

Escalate to a human maintainer when:

1. Auto-fix loop has exhausted 3 attempts — check the PR comment from the bot for a summary of remaining issues.
2. LLM output is consistently off-target or empty for multiple issues — review prompt files in `prompts/` and `config/models.yaml`.
3. A provider (Anthropic / Groq) reports prolonged outage (> 30 min) — switch provider and notify team.
4. Secret or token rotation is needed — rotate in **Settings → Secrets**, coordinate with the team to avoid mid-run failures.
5. A generated PR touches unexpected files or paths — close the PR immediately, audit `output_writer.mjs` path-safety logic, and open a bug report.

---

## Manual Override Path

### Skip AI validation and force label

```bash
# From the issue page → Labels → apply directly
# Or via GitHub CLI:
gh issue edit <issue-number> --add-label ready-for-dev
```

### Re-trigger code generation after fixing the issue body

1. Remove the `ready-for-dev` label from the issue.
2. Edit the issue body with clearer acceptance criteria.
3. Re-apply `ready-for-dev` — the generation workflow triggers on the fresh `labeled` event.

### Force a new PR review cycle

```bash
git commit --allow-empty -m "re-trigger pr-review" && git push
```

### Reset the auto-fix attempt counter

Remove all `auto-fix-attempt-N` labels from the PR via the Labels panel, then re-apply `changes-requested` to restart the loop from attempt 1.

### Manually approve and close the loop

1. Remove `changes-requested` label from the PR.
2. Apply `review-approved` label.
3. Merge the PR through the normal GitHub merge UI.
