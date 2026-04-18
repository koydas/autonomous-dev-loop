# Testing

Unit tests cover all core Node.js modules using the built-in `node:test` runner — no external dependencies required.

## Running Tests

```bash
npm test
```

Requires Node.js 20+. All 31 tests should pass in under a second.

## Coverage

| File | Tests | What is covered |
|------|-------|-----------------|
| `scripts/lib/output_writer.mjs` | 10 | Field validation, path safety (absolute paths, `..` traversal), 16 000-char size limit, type coercion |
| `scripts/lib/config.mjs` | 12 | `requireEnv` missing/empty vars, `loadConfigFromEnv` defaults and required fields, `buildDeterministicPrompt` output structure |
| `scripts/lib/groq_client.mjs` | 9 | HTTP errors, non-JSON response, malformed `choices`, invalid AI JSON (array vs object), Authorization header, temperature payload |

## Adding Tests

Test files live in `scripts/tests/` and follow the `*.test.mjs` naming convention. Each file imports directly from the module under test.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myFunction } from '../lib/my_module.mjs';

test('describes expected behavior', () => {
  assert.equal(myFunction('input'), 'expected');
});
```

Per `AGENTS.md`: run `npm test` and ensure all tests pass before committing any change to `scripts/`.

## CI

The workflow `.github/workflows/test.yml` runs `npm test` on every push and pull request targeting any branch.
