// The c8 coverage gates (AGENTS.md → Test Coverage Policy): one list, config/coverage-gates.json, read by the
// CI step (scripts/coverage_gates.mjs), by the tests that pin it and by the review prompt's gate (c) rule,
// which is rewritten from it (`syncGatePrompt`). Pure: no I/O, no process.
import path from 'node:path';

export const GATES_CONFIG_PATH = 'config/coverage-gates.json';
const PROMPT_LIST = /(`config\/coverage-gates\.json`: )(.*?)(\. A changed file on this list)/s;

/**
 * Parses the config: `{ threshold, gates }` where a gate is a module path (`scripts/<name>.mjs`, measured through
 * `scripts/tests/<name>.test.mjs`) or `{ module, test, note }` when another test file measures it or the gate has a reason worth keeping (`note`: free text, never read by CI). Throws, naming the
 * field, on anything else, on a duplicate module and on a test file that is not a bare `*.test.mjs` name.
 */
export function parseGates(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (err) { throw new Error(`${GATES_CONFIG_PATH} is not valid JSON: ${err.message}`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${GATES_CONFIG_PATH} must be an object`);
  const { threshold, gates } = raw;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new Error(`threshold must be an integer from 1 to 100, got ${JSON.stringify(threshold)}`);
  if (!Array.isArray(gates) || gates.length === 0) throw new Error('gates must be a non-empty array');
  const seen = new Set();
  const parsed = gates.map((entry, i) => {
    const at = `gates[${i}]`;
    const spec = typeof entry === 'string' ? { module: entry } : entry;
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${at} must be a module path or { module, test }`);
    const { module, test = null, note = null } = spec;
    if (typeof module !== 'string' || !/^scripts\/(lib\/)?[\w-]+\.mjs$/.test(module)) throw new Error(`${at}.module must be scripts/<name>.mjs or scripts/lib/<name>.mjs, got ${JSON.stringify(module)}`);
    if (seen.has(module)) throw new Error(`${at}.module ${module} is listed twice`);
    seen.add(module);
    const testFile = test ?? `${path.posix.basename(module, '.mjs')}.test.mjs`;
    if (typeof testFile !== 'string' || !/^[\w-]+\.test\.mjs$/.test(testFile)) throw new Error(`${at}.test must be a bare <name>.test.mjs file name, got ${JSON.stringify(test)}`);
    if (note !== null && (typeof note !== 'string' || note.length > 300)) throw new Error(`${at}.note must be a string of at most 300 characters`);
    return { module, test: testFile, note };
  });
  return { threshold, gates: parsed };
}

/** The arguments of `npx` that run one gate: c8 over the module, measured through its test file. */
export function c8Args({ module, test }, threshold) {
  return ['--yes', 'c8', '--include', module, '--check-coverage', ...['lines', 'branches', 'functions', 'statements'].flatMap((k) => [`--${k}`, String(threshold)]), 'node', '--test', `scripts/tests/${test}`];
}

/** The gated files as the review prompt lists them: `a`, `b`, `c`. */
export const gatedFilesProse = (gates) => gates.map((g) => `\`${g.module}\``).join(', ');

/** The prompt text with its list of gated files rewritten from `gates`; throws when the sentence is not found. */
export function syncGatePrompt(text, gates) {
  if (!PROMPT_LIST.test(text)) throw new Error('the gate (c) rule of the review prompt does not carry the list of gated files after "`config/coverage-gates.json`: "');
  return text.replace(PROMPT_LIST, (_, head, __, tail) => `${head}${gatedFilesProse(gates)}${tail}`);
}

/**
 * Runs every gate (or the one named by `only`), through `run(args)` → exit status. A failure does not stop the
 * others: all are reported. Returns `{ results: [{ module, status }], failed: [module] }`.
 */
export function runGates({ gates, threshold }, run, { only = null, log = () => {} } = {}) {
  const chosen = only === null ? gates : gates.filter((g) => g.module === only);
  if (only !== null && chosen.length === 0) throw new Error(`${only} is not a coverage gate; the gates are in ${GATES_CONFIG_PATH}`);
  const results = chosen.map((gate) => {
    log(`::group::c8 ${gate.module} (≥${threshold}%, ${gate.test})`);
    const status = run(c8Args(gate, threshold));
    log('::endgroup::');
    if (status !== 0) log(`::error::coverage gate failed: ${gate.module} (run: node scripts/coverage_gates.mjs --only ${gate.module})`);
    return { module: gate.module, status };
  });
  return { results, failed: results.filter((r) => r.status !== 0).map((r) => r.module) };
}
