# ADR-0015: Three-tier JSON parsing with typed errors

- **Date:** 2026-06-01
- **Status:** Accepted

## Context

LLM responses intended to be JSON are not always clean JSON. Models occasionally wrap
their output in a markdown code fence (` ```json … ``` `), prepend explanatory prose,
or emit both a preamble and a well-formed JSON object. A single `JSON.parse()` fails
on cases 2 and 3.

The existing `parseJsonResponse()` in `scripts/lib/output_writer.mjs` already attempted
direct parse, fence-strip, and brace-extraction, but had three gaps:

1. **Ordering risk** — if the fence regex ran before `JSON.parse()`, valid JSON whose
   string fields contained triple-backtick snippets (e.g. a code-review payload quoting
   a fenced code block from the PR diff) could be mis-parsed. The ordering guarantee was
   implicit rather than documented and enforced.

2. **Silent failure mode** — when all three strategies failed, the thrown `Error` had
   only a concatenated string message. Callers needing to log the raw response for
   diagnosis or classify which tier failed had to re-parse the message string.

3. **Missing diagnostic accumulation** — the fence tier silently skipped its error
   accumulation when no fence was found, and the slice tier did the same when no brace
   pair was found, producing incomplete diagnostic strings.

## Decision

Formalise the three-tier cascade in `parseJsonResponse()` and introduce a typed error
class in `scripts/lib/output_writer.mjs`.

**`JsonParseError`** extends `Error` with two structured fields:
- `raw` — the original LLM response string, for logging and debugging.
- `parseErrors[]` — one diagnostic string per tier, in order, so callers know exactly
  which tier failed and why.

**Tier ordering (invariant: Tier 1 always runs first):**

| Tier | Strategy | Rationale |
|------|----------|-----------|
| 1 | `JSON.parse(raw)` directly | Must be first: valid JSON strings may contain `` ``` `` sequences that the Tier 2 regex would incorrectly match as a fence |
| 2 | Strip markdown fence (`` ```[json]…``` ``), then `JSON.parse` interior | Handles the common model behaviour of wrapping output in a code block |
| 3 | Slice from first `{` to last `}`, then `JSON.parse` | Handles prose-prefixed JSON; only entered if Tier 2 finds no fence |

Each tier records its failure reason (or "no fence found" / "no brace pair found") into
`parseErrors[]` unconditionally. If all three fail, a `JsonParseError` is thrown with
all three diagnostics populated.

The fence regex uses the `i` flag to match `` ```JSON `` (uppercase) in addition to
`` ```json ``.

## Alternatives Considered

**Fence-first ordering** — apply the fence regex before `JSON.parse()`. Rejected
because valid JSON containing triple-backtick sequences in string values (e.g. a
code-review payload quoting a fenced code block from the PR diff) would be silently
mis-parsed. Tier 1 must protect this case.

**LLM-side enforcement via `response_format: { type: "json_object" }`** — Groq's API
supports this mode; Anthropic's does not. Applying it only to Groq would create
divergent parsing logic per provider. Keeping a unified three-tier parser across
providers is simpler.

**Throw a plain `Error` with a structured `cause`** — keeps the class hierarchy simple
but requires callers to downcast or inspect `cause` for diagnostics, which is less
ergonomic than named fields on a dedicated class.

## Consequences

- ✅ Callers can `instanceof JsonParseError` to distinguish JSON-format failures from
  other errors (network, auth) without string matching.
- ✅ `raw` and `parseErrors[]` are always populated on failure, giving operators the
  full context needed to diagnose why a specific LLM response was rejected.
- ✅ The Tier 1 → Tier 2 → Tier 3 ordering is documented and enforced by code comment,
  preventing future refactors from silently breaking the invariant.
- ⚠️ The three-tier cascade adds two additional parse attempts on every failure path.
  This is negligible in practice (JSON.parse is fast; LLM call latency dominates) but
  not zero cost.
- ⚠️ Tier 3 (brace extraction) is a heuristic: it returns the substring between the
  first `{` and the last `}`, which is incorrect for responses embedding multiple
  top-level JSON objects or `{` in prose before the actual object. Such cases produce a
  Tier 3 parse error rather than a wrong parse, which is the safer failure mode.
