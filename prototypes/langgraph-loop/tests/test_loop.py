import unittest

from langgraph.checkpoint.memory import InMemorySaver

from loop import (
    BUGGY, DEMO_ISSUE, DEMO_TESTS, FIXED, MAX_ATTEMPTS,
    BudgetExhaustedError, LoopContext, LoopState, ScriptedGenerator,
    build_graph, should_continue,
)

INPUT = {"issue_description": DEMO_ISSUE, "acceptance_tests": DEMO_TESTS}


def run(attempts, **ctx):
    gen = ScriptedGenerator(attempts)
    final = build_graph().invoke(INPUT, context=LoopContext(generator=gen, **ctx))
    return final, gen


def failing(counter):
    return LoopState(**INPUT, attempt_counter=counter,
                     eval_report={"status": "fail", "exit_code": 1, "errors": "x"})


class ShouldContinue(unittest.TestCase):
    def test_pass_routes_to_merge_regardless_of_counter(self):
        s = LoopState(**INPUT, attempt_counter=MAX_ATTEMPTS,
                      eval_report={"status": "pass", "exit_code": 0, "errors": ""})
        self.assertEqual(should_continue(s), "ready_for_merge")

    def test_fail_under_budget_loops(self):
        for n in range(1, MAX_ATTEMPTS):
            self.assertEqual(should_continue(failing(n)), "generate_code")

    def test_fail_at_or_over_budget_escalates(self):
        for n in (MAX_ATTEMPTS, MAX_ATTEMPTS + 5):
            self.assertEqual(should_continue(failing(n)), "escalate_to_human")

    def test_missing_report_is_a_wiring_error(self):
        with self.assertRaises(RuntimeError):
            should_continue(LoopState(**INPUT))


class Graph(unittest.TestCase):
    def test_counter_starts_at_zero(self):
        self.assertEqual(LoopState(**INPUT).attempt_counter, 0)

    def test_pass_first_try(self):
        final, gen = run([FIXED])
        self.assertEqual((final["outcome"], final["attempt_counter"]), ("ready_for_merge", 1))
        self.assertEqual(gen.calls, [None])

    def test_autofix_receives_failure_report(self):
        final, gen = run([BUGGY, FIXED])
        self.assertEqual((final["outcome"], final["attempt_counter"]), ("ready_for_merge", 2))
        self.assertIsNone(gen.calls[0])
        self.assertEqual(gen.calls[1]["status"], "fail")
        self.assertIn("AssertionError", gen.calls[1]["errors"])

    def test_escalates_after_max_attempts(self):
        final, gen = run([BUGGY])
        self.assertEqual(final["outcome"], "needs_human_review")
        self.assertEqual(final["attempt_counter"], MAX_ATTEMPTS)
        self.assertEqual(len(gen.calls), MAX_ATTEMPTS)
        self.assertEqual(final["eval_report"]["status"], "fail")

    def test_timeout_is_a_fail_verdict(self):
        final, _ = run(["while True:\n    pass\n"], eval_timeout_s=0.5)
        self.assertEqual(final["outcome"], "needs_human_review")
        self.assertIsNone(final["eval_report"]["exit_code"])

    def test_frozen_thread_refuses_further_generation(self):
        app = build_graph(checkpointer=InMemorySaver())
        cfg = {"configurable": {"thread_id": "t"}}
        ctx = LoopContext(generator=ScriptedGenerator([BUGGY]))
        app.invoke(INPUT, config=cfg, context=ctx)
        # Re-submitting on the escalated thread must not buy extra attempts.
        with self.assertRaises(BudgetExhaustedError):
            app.invoke(INPUT, config=cfg, context=ctx)
        self.assertEqual(app.get_state(cfg).values["attempt_counter"], MAX_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
