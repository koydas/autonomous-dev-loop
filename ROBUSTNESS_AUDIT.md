# Robustness Audit — Error Handling & Exit Codes

> Scope: all `.mjs` source files in `scripts/` (excluding `node_modules`, `dist`, test files).  
> Date: 2026-04-28

---

### Summary

| Metric | Count |
|---|---|
| Files audited | 17 |
| HIGH findings | 1 |
| MEDIUM findings | 10 |
| LOW findings | 10 |

---

### Findings

---

**[HIGH] `scripts/pr_review.mjs:194`** — Process exits 0 on critical-path failure

```js
if (permissionLikeFailure) {
  logError('PR review submit skipped: token lacks permission …', {
    prNumber, status: reviewRes.status,
  });
}
// execution falls through — labels are applied, script exits 0
```

> The sole purpose of this script is to submit a formal PR review (APPROVE / REQUEST\_CHANGES). When the API returns 401/403/422, the error is logged but execution continues: labels are still applied and the process exits 0. Downstream automation (e.g., the auto-fix label trigger) sees a successful CI run even though the review state was never changed.

```js
process.exit(1); // add immediately after the logError call
```

---

**[MEDIUM] `scripts/auto_fix_pr.mjs:36`** — Error re-wrapped as `err.message`; original stack discarded

```js
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`);
}
```

> `new Error(err.message)` creates a fresh error whose stack points to this line, not the original `SyntaxError` from `JSON.parse`. The parse offset, unexpected token, and inner stack frame are permanently lost, making event-payload failures hard to diagnose in CI logs.

```js
throw new Error(`Failed to parse GitHub event payload`, { cause: err });
```

---

**[MEDIUM] `scripts/auto_fix_pr.mjs:62`** — Network error re-wrapped as `err.message`; original cause discarded

```js
} catch (err) {
  throw new Error(`Network error calling GitHub API (${endpoint}): ${err.message}`);
}
```

> Same issue: the original `TypeError` / `ECONNREFUSED` stack is replaced with a shallow wrapper. `{ cause: err }` preserves both the message and the original trace.

```js
throw new Error(`Network error calling GitHub API (${endpoint})`, { cause: err });
```

---

**[MEDIUM] `scripts/auto_fix_pr.mjs:1`** — Top-level-await entry point with no `unhandledRejection` guard

> The file uses top-level `await` throughout with no `main()` wrapper and no `process.on('unhandledRejection', …)` handler. Any promise that rejects outside an `await` chain (e.g., inside a timer or library callback) will use Node's default formatting, bypassing the repo's structured JSON logger. In Node.js ≥ 15 the exit code is 1, but the error message format is inconsistent with the rest of the pipeline.

```js
process.on('unhandledRejection', (reason) => {
  error('unhandledRejection', { reason: String(reason), stack: reason?.stack });
  process.exit(1);
});
```

---

**[MEDIUM] `scripts/generate_issue_change.mjs:54`** — `err.message` logged; stack trace silently discarded

```js
main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
```

> Only the message string is passed to `logError`. The full stack — showing which LLM call, file write, or JSON parse failed — is thrown away. CI logs show `"AI response was not valid JSON"` with no indication of where the error originated.

```js
logError('Fatal error', { message: err.message, stack: err.stack });
```

---

**[MEDIUM] `scripts/manage_labels.mjs:91`** — `err.message` logged; stack trace silently discarded

```js
main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
```

> Same pattern as `generate_issue_change.mjs:54`. Stack trace lost on every fatal exit.

```js
logError('Fatal error', { message: err.message, stack: err.stack });
```

---

**[MEDIUM] `scripts/pr_review.mjs:19`** — Error re-wrapped as `err.message`; original stack discarded

```js
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`);
}
```

> Identical pattern to `auto_fix_pr.mjs:36`. `{ cause: err }` is the fix.

```js
throw new Error(`Failed to parse GitHub event payload`, { cause: err });
```

---

**[MEDIUM] `scripts/pr_review.mjs:57`** — Network error re-wrapped as `err.message`; original cause discarded

```js
} catch (err) {
  throw new Error(`Network error calling GitHub API (${path}): ${err.message}`);
}
```

> Identical pattern to `auto_fix_pr.mjs:62`.

```js
throw new Error(`Network error calling GitHub API (${path})`, { cause: err });
```

---

**[MEDIUM] `scripts/pr_review.mjs:1`** — Top-level-await entry point with no `unhandledRejection` guard

> Same issue as `auto_fix_pr.mjs:1`. The entire file is top-level `await` with no `main()` wrapper and no process-level rejection guard.

```js
process.on('unhandledRejection', (reason) => {
  error('unhandledRejection', { reason: String(reason), stack: reason?.stack });
  process.exit(1);
});
```

---

**[MEDIUM] `scripts/upsert_issue_validation_comment.mjs:87`** — `err.message` logged; stack trace silently discarded

```js
main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
```

> Same pattern as `generate_issue_change.mjs:54`.

```js
logError('Fatal error', { message: err.message, stack: err.stack });
```

---

**[MEDIUM] `scripts/validate_issue.mjs:40`** — `err.message` logged; stack trace silently discarded

```js
main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
```

> Same pattern as `generate_issue_change.mjs:54`.

```js
logError('Fatal error', { message: err.message, stack: err.stack });
```

---

**[LOW] `scripts/auto_fix_pr.mjs:115`** — Inline-comment fetch failure silently swallowed (no log)

```js
if (inlineRes.ok) {
  const inlineComments = await inlineRes.json();
  // … push to feedbackParts
}
// no else: non-2xx silently ignored, feedbackParts receives no inline comments
```

> If the inline-comments fetch fails (rate limit, permissions), the auto-fix proceeds with incomplete review feedback and no observable signal. At minimum, an `logError` on the else branch would surface the degraded state.

```js
} else {
  logError('Inline comments fetch failed', { status: inlineRes.status, prNumber });
}
```

---

**[LOW] `scripts/auto_fix_pr.mjs:221`** — Label-create failure logged but script continues and exits 0

```js
if (!createLabelRes.ok && createLabelRes.status !== 422) {
  logError(`Auto-fix label create failed: ${createLabelRes.status}`, { attemptLabelName });
}
```

> The attempt label won't exist to be applied in the next step, breaking the `MAX_ATTEMPTS` guard: if `attemptCount` can't be incremented reliably, the pipeline may run more than `MAX_ATTEMPTS` auto-fix cycles.

```js
process.exit(1); // or throw new Error(`Label create failed: ${createLabelRes.status}`)
```

---

**[LOW] `scripts/auto_fix_pr.mjs:229`** — Label-apply failure logged but script continues and exits 0

```js
if (!applyLabelRes.ok) {
  logError(`Auto-fix label apply failed: ${applyLabelRes.status}`, { attemptLabelName });
}
```

> Same consequence as the label-create failure above: the attempt counter is not updated, and the `MAX_ATTEMPTS` guard is silently undermined.

```js
process.exit(1); // or throw new Error(`Label apply failed: ${applyLabelRes.status}`)
```

---

**[LOW] `scripts/lib/anthropic_client.mjs:39`** — Empty catch re-throws without original parse error

```js
try {
  raw = JSON.parse(rawText);
} catch {
  throw new Error('Anthropic API returned non-JSON response');
}
```

> The `SyntaxError` from `JSON.parse` (offset, unexpected token) is lost. Diagnosing a partially-malformed Anthropic response requires guessing without the original detail.

```js
} catch (err) {
  throw new Error('Anthropic API returned non-JSON response', { cause: err });
}
```

---

**[LOW] `scripts/lib/file_injector.mjs:48`** — Documented empty catch swallows all error types, not just ENOENT

```js
} catch {
  // Non-existent or unreadable — skip silently.
}
```

> Intent is documented, but the catch swallows every possible error (OOM, EMFILE, unexpected `fs` bugs), not only "file not found." An unexpected error here would result in silently incomplete file context for the LLM.

```js
} catch (err) {
  if (err.code !== 'ENOENT') throw err; // surface unexpected errors
}
```

---

**[LOW] `scripts/generate_issue_change.mjs:31`** — Empty catch re-throws without original parse error

```js
} catch {
  throw new Error('AI response was not valid JSON');
}
```

> The original `SyntaxError` from `parseJsonResponse` is silently discarded. Add `{ cause: err }` to preserve it.

```js
} catch (err) {
  throw new Error('AI response was not valid JSON', { cause: err });
}
```

---

**[LOW] `scripts/lib/groq_client.mjs:72`** — Empty catch re-throws without original parse error

```js
try {
  raw = JSON.parse(rawText);
} catch {
  throw new Error('Groq API returned non-JSON response');
}
```

> Same pattern as `anthropic_client.mjs:39`.

```js
} catch (err) {
  throw new Error('Groq API returned non-JSON response', { cause: err });
}
```

---

**[LOW] `scripts/lib/issue_validator.mjs:47`** — Empty catch re-throws without original parse error

```js
try {
  parsed = JSON.parse(rawText.slice(start, end + 1));
} catch {
  throw new Error('Groq response contained invalid JSON');
}
```

> Same pattern as `anthropic_client.mjs:39`.

```js
} catch (err) {
  throw new Error('Groq response contained invalid JSON', { cause: err });
}
```

---

**[LOW] `scripts/lib/output_writer.mjs:9`** — Three empty catches in `parseJsonResponse` swallow intermediate parse errors

```js
try { return JSON.parse(raw); } catch {}
// …
try { return JSON.parse(fenced[1].trim()); } catch {}
// …
try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
throw new Error('AI response was not valid JSON');
```

> The multi-format fallback strategy is intentional and the final `throw` is correct. However, all three intermediate parse failures are invisible — even at debug level. When diagnosing a malformed AI response, there is no record of which format was tried or what each attempt's error was.

```js
} catch (err) { /* optionally: log({ level: 'debug', stage: 'direct', parseErr: err.message }) */ }
```

---

**[LOW] `scripts/generate_issue_change.mjs:53`, `scripts/manage_labels.mjs:90`, `scripts/upsert_issue_validation_comment.mjs:86`, `scripts/validate_issue.mjs:39`** — `main().catch()` without a process-level `unhandledRejection` guard

```js
main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
```

> `.catch()` only intercepts rejections that propagate through `main()`'s promise chain. Any rejection that escapes the chain (floating promise inside a library, event emitter error) will be handled by Node's default handler using plain text formatting instead of the repo's structured JSON logger. A process-level guard closes this gap.

```js
process.on('unhandledRejection', (reason) => {
  error('unhandledRejection', { reason: String(reason), stack: reason?.stack });
  process.exit(1);
});
```
