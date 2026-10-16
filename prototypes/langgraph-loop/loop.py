"""Bounded-autonomy self-correction loop on LangGraph.

    START -> generate_code -> execute_evals -> should_continue
        pass                          -> ready_for_merge   -> END
        fail, attempt_counter < 3     -> generate_code      (auto-fix, report passed back)
        fail, attempt_counter >= 3    -> escalate_to_human -> END (state frozen)

The budget is enforced in code at three points, none of them reachable from a prompt:
  1. should_continue routes on attempt_counter vs MAX_ATTEMPTS.
  2. generate_code_node refuses to run once the budget is spent or an outcome is set
     (guards a resumed/re-invoked thread whose checkpoint already holds the counter).
  3. recursion_limit caps graph supersteps as a default backstop. It is a config default:
     a caller's config={"recursion_limit": ...} overrides it, so 1 and 2 are the cap.
"""

from __future__ import annotations

import secrets
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from pydantic import BaseModel, Field
# Pydantic rejects typing.TypedDict as a model field on Python < 3.12.
from typing_extensions import TypedDict

MAX_ATTEMPTS: Final = 3
# gen + eval per attempt, + one terminal node, + 1 margin.
RECURSION_LIMIT: Final = 2 * MAX_ATTEMPTS + 2
MAX_LOG_CHARS: Final = 4000


# ── State ────────────────────────────────────────────────────────────────────


class EvalReport(TypedDict):
    status: Literal["pass", "fail"]
    exit_code: int | None  # None = timeout
    errors: str  # tail of test output, bounded to MAX_LOG_CHARS


Outcome = Literal["ready_for_merge", "needs_human_review"]


class LoopState(BaseModel):
    issue_description: str
    # Acceptance tests are an input, never LLM output: the generator cannot grade itself.
    acceptance_tests: str
    generated_code: str | None = None
    eval_report: EvalReport | None = None
    attempt_counter: int = Field(default=0, ge=0)
    outcome: Outcome | None = None


class LoopInput(BaseModel):
    """Graph input: the caller cannot set attempt_counter or outcome (budget reset)."""

    issue_description: str
    acceptance_tests: str


# ── Runtime context (injected dependencies, not state) ───────────────────────

# (issue, previous_code, last_failed_report) -> code
CodeGenerator = Callable[[str, str | None, EvalReport | None], str]


@dataclass(frozen=True)
class LoopContext:
    generator: CodeGenerator
    eval_timeout_s: float = 30.0


class BudgetExhaustedError(RuntimeError):
    pass


# ── Nodes ────────────────────────────────────────────────────────────────────


def generate_code_node(state: LoopState, runtime: Runtime[LoopContext]) -> dict:
    if state.outcome is not None or state.attempt_counter >= MAX_ATTEMPTS:
        raise BudgetExhaustedError(
            f"generation refused: attempt_counter={state.attempt_counter}, "
            f"outcome={state.outcome}, max={MAX_ATTEMPTS}"
        )
    last_failure = state.eval_report if state.eval_report and state.eval_report["status"] == "fail" else None
    code = runtime.context.generator(state.issue_description, state.generated_code, last_failure)
    return {"generated_code": code, "attempt_counter": state.attempt_counter + 1}


# Prints the parent's nonce only once the runner has returned with tests run and none
# failed: generated code that ends the process early (sys.exit(0) / os._exit(0) at
# import) exits 0 without it.
EVAL_HARNESS: Final = """\
import sys, unittest
nonce = sys.stdin.readline().strip()
suite = unittest.defaultTestLoader.loadTestsFromName("test_solution")
result = unittest.TextTestRunner(verbosity=2).run(suite)
if result.testsRun > 0 and result.wasSuccessful():
    print(nonce)
    sys.exit(0)
sys.exit(1)
"""


def execute_evals_node(state: LoopState, runtime: Runtime[LoopContext]) -> dict:
    """Deterministic verdict = the acceptance suite ran to completion and passed. No LLM involved.

    Prototype runs in a temp dir with the current interpreter; production must run
    this in an isolated container (LLM-generated code is untrusted, and runs in the
    harness process).
    """
    nonce = secrets.token_hex(16)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "solution.py").write_text(state.generated_code or "", encoding="utf-8")
        (work / "test_solution.py").write_text(state.acceptance_tests, encoding="utf-8")
        (work / "_eval_harness.py").write_text(EVAL_HARNESS, encoding="utf-8")
        try:
            proc = subprocess.run(
                [sys.executable, "-E", "-s", "_eval_harness.py"],
                cwd=work,
                input=nonce + "\n",
                capture_output=True,
                text=True,
                timeout=runtime.context.eval_timeout_s,
            )
        except subprocess.TimeoutExpired:
            return {"eval_report": EvalReport(
                status="fail", exit_code=None,
                errors=f"timeout after {runtime.context.eval_timeout_s}s",
            )}

    passed = proc.returncode == 0 and nonce in proc.stdout.splitlines()
    output = proc.stdout + proc.stderr
    if proc.returncode == 0 and not passed:
        output += "\nexit 0 without a completed passing run: the process ended before the test runner returned"
    return {"eval_report": EvalReport(
        status="pass" if passed else "fail",
        exit_code=proc.returncode,
        errors="" if passed else output[-MAX_LOG_CHARS:],
    )}


def ready_for_merge_node(state: LoopState) -> dict:
    return {"outcome": "ready_for_merge"}


def escalate_to_human_node(state: LoopState) -> dict:
    return {"outcome": "needs_human_review"}


# ── Conditional edge ─────────────────────────────────────────────────────────

Route = Literal["ready_for_merge", "generate_code", "escalate_to_human"]


def should_continue(state: LoopState) -> Route:
    report = state.eval_report
    if report is None:
        raise RuntimeError("should_continue reached without an eval_report (graph wiring bug)")
    if report["status"] == "pass":
        return "ready_for_merge"
    if state.attempt_counter < MAX_ATTEMPTS:
        return "generate_code"
    return "escalate_to_human"


# ── Graph ────────────────────────────────────────────────────────────────────


def build_graph(checkpointer: BaseCheckpointSaver | None = None) -> CompiledStateGraph:
    g = StateGraph(LoopState, context_schema=LoopContext, input_schema=LoopInput)
    g.add_node("generate_code", generate_code_node)
    g.add_node("execute_evals", execute_evals_node)
    g.add_node("ready_for_merge", ready_for_merge_node)
    g.add_node("escalate_to_human", escalate_to_human_node)

    g.add_edge(START, "generate_code")
    g.add_edge("generate_code", "execute_evals")
    g.add_conditional_edges("execute_evals", should_continue)
    g.add_edge("ready_for_merge", END)
    g.add_edge("escalate_to_human", END)

    return g.compile(checkpointer=checkpointer).with_config(recursion_limit=RECURSION_LIMIT)


# ── Demo ─────────────────────────────────────────────────────────────────────


class ScriptedGenerator:
    """Stand-in for the LLM: returns canned attempts in order, records what it was fed."""

    def __init__(self, attempts: list[str]) -> None:
        self._attempts = attempts
        self.calls: list[EvalReport | None] = []

    def __call__(self, issue: str, previous_code: str | None, last_failure: EvalReport | None) -> str:
        self.calls.append(last_failure)
        return self._attempts[min(len(self.calls), len(self._attempts)) - 1]


DEMO_ISSUE = "Implement add(a, b) returning the sum of two integers."
DEMO_TESTS = """\
import unittest
from solution import add

class TestAdd(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)
"""
BUGGY = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"


if __name__ == "__main__":
    from langgraph.checkpoint.memory import InMemorySaver

    app = build_graph(checkpointer=InMemorySaver())

    for thread_id, attempts in [("fixed-on-2nd", [BUGGY, FIXED]), ("never-fixed", [BUGGY])]:
        cfg = {"configurable": {"thread_id": thread_id}}
        final = app.invoke(
            {"issue_description": DEMO_ISSUE, "acceptance_tests": DEMO_TESTS},
            config=cfg,
            context=LoopContext(generator=ScriptedGenerator(attempts)),
        )
        print(f"[{thread_id}] outcome={final['outcome']} attempts={final['attempt_counter']} "
              f"eval={final['eval_report']['status']}")
        # Frozen state stays inspectable for the human reviewer via the checkpointer.
        assert app.get_state(cfg).next == ()

    graph = app.get_graph()
    Path("loop_graph.mmd").write_text(graph.draw_mermaid(), encoding="utf-8")
    # PNG rendering calls the mermaid.ink API (network); use the .mmd offline.
    try:
        graph.draw_mermaid_png(output_file_path="loop_graph.png")
    except Exception as exc:  # demo only: offline is a normal case, loop_graph.mmd is written
        print(f"loop_graph.png skipped (mermaid.ink unreachable: {exc!r}); use loop_graph.mmd", file=sys.stderr)
