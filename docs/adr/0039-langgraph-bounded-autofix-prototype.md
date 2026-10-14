# ADR-0039: LangGraph prototype of the bounded auto-fix loop

- **Date:** 2026-10-14
- **Status:** Proposed

## Context

The generate → evaluate → fix loop is spread over three workflows (`code-generation.yml`, `pr-review.yml`, `auto-fix-pr.yml`) chained by labels (ADR-0006). Its control state lives in GitHub: the attempt count is the `auto-fix-attempt-N` labels, the stop is `needs-human`, the reset is an APPROVE (ADR-0034). The loop's shape — which transitions exist, where the cap of 3 is checked — is only visible by reading `scripts/pr_review.mjs`, `scripts/auto_fix_pr.mjs` and the workflow triggers together.

We want to know whether an explicit state graph (LangGraph, Python) expresses the same bounded autonomy with less implicit state, before deciding on any migration. `prototypes/langgraph-loop/` is that experiment. It is not wired to any workflow.

## Decision

Keep a standalone prototype in `prototypes/langgraph-loop/` (`loop.py`, `test_loop.py`, pinned `langgraph==1.2.15`) with this contract:

1. **State** (`LoopState`, Pydantic): `issue_description`, `acceptance_tests`, `generated_code`, `eval_report` (`status: pass|fail`, `exit_code`, `errors`), `attempt_counter` (default 0, `ge=0`), `outcome` (`ready_for_merge | needs_human_review`).
2. **Acceptance tests are an input, never generator output.** The generator cannot write the tests that grade it.
3. **Evaluation is deterministic** (`execute_evals_node`): the verdict is the exit code of `python -m unittest` on the generated code, with a timeout (timeout = fail, `exit_code: null`). No LLM decides pass/fail. Output is cut to the last 4000 chars before it is fed back to the generator.
4. **Routing** (`should_continue`): pass → `ready_for_merge`; fail and `attempt_counter < 3` → `generate_code` with the failed report; fail and `attempt_counter >= 3` → `escalate_to_human`. Both terminal nodes set `outcome` and go to `END`.
5. **The cap is code, not prompt or config.** `MAX_ATTEMPTS` is a module `Final`, checked at three points: (a) `should_continue`; (b) `generate_code_node` raises `BudgetExhaustedError` when the budget is spent or `outcome` is set, so a checkpointed thread re-invoked after escalation cannot buy extra attempts; (c) `recursion_limit = 2 × MAX_ATTEMPTS + 2` on the compiled graph.
6. **The generator is injected** through LangGraph's runtime context (`LoopContext.generator`, signature `(issue, previous_code, last_failure) -> code`), not stored in state. The prototype ships a scripted stand-in; no provider call.
7. Flowchart export: `app.get_graph().draw_mermaid()` (offline) and `draw_mermaid_png()` (calls mermaid.ink).

## Alternatives Considered

- **Model the loop in the existing Node pipeline (a JS state machine).** Stays in one language and keeps ADR-0007-style tooling, but does not answer the question asked: whether LangGraph's checkpointing, interrupts and graph export are worth a second runtime. Not rejected — it is the baseline the prototype is measured against.
- **LLM-judged evaluation node.** Rejected: contradicts ADR-0024/0026 — a verdict comes from tools, not from the model's opinion.
- **Cap in config or runtime context.** Rejected: anything a caller or a prompt-adjacent config can set can be raised. The cap is a constant; changing it is a reviewed code change.
- **`interrupt()` in `escalate_to_human` instead of ending.** Lets the same thread resume after a human decision. Deferred: needs the node guard (5b) to accept a human-reset signal, which is the ADR-0034 "APPROVE resets the loop" question in graph form.

## Consequences

- ✅ The loop's transitions and the cap are in one file and in a generated Mermaid diagram.
- ✅ Attempt state is in the checkpoint, not in labels: no label drift, no re-pulse (ADR-0006) needed inside a run.
- ✅ 10 unit tests pin the routing table, the escalation at 3, the failure report fed back, timeout-as-fail, and the frozen-thread guard.
- ⚠️ **Not the production loop.** No workflow runs it; no observability events (ADR-0018); no write guards (ADR-0021, ADR-0029, ADR-0019); single-file output.
- ⚠️ **Generated code runs unsandboxed** in a temp dir with the current interpreter. Any real use must run `execute_evals_node` in a secret-less isolated job, as ADR-0024 does for PR code.
- ⚠️ **Cap scope differs from ADR-0034.** Here the cap is per thread; the production cap is per fix round, reset by APPROVE. A migration maps one fix round to one thread.
- ⚠️ A second language and dependency set (Python, LangGraph) in a Node repository. `node --test` does not run the prototype tests; CI does not run them either.
