// Finding → lever table of the meta-loop (ADR-0046, ADR-0047 §2): which setting or prompt governs the pattern
// a Diagnostics rule reports. Advice, not a diagnosis: the table says where to look, never that the lever is
// the cause (`verified` is always false), and applying one is an ordinary change under every existing gate.
// Pure, deterministic, no LLM.
//
// Target kinds: `config` (`config/<file>.yaml#<key>`, resolved by a test), `variable` (a repository variable),
// `prompt` (a file under `prompts/`), `policy` / `external` (a documented behavior or a provider plan: nothing
// to resolve). `gate` is the eval suite that measures a change to the target (ADR-0031), or null when none exists.

const target = (kind, ref, gate = null) => Object.freeze({ kind, ref, gate });
const entry = (stage, summary, targets, adr) => Object.freeze({ stage, summary, targets: Object.freeze(targets), adr: Object.freeze(adr) });

const REVIEW_BUDGET = [
  target('config', 'config/models.yaml#review_max_input_tokens', 'review'),
  target('config', 'config/models.yaml#anthropic_review_max_diff_chars', 'review'),
];

/** Lever per rule id (a rule family for ids that carry a stage, see `ruleKey`). */
export const LEVERS = Object.freeze({
  'review-withheld': entry('review', 'Reviews are withheld on code the prompt budget or the CI evidence leaves unseen', [
    ...REVIEW_BUDGET, target('variable', 'AI_PROVIDER_REVIEW', 'review'), target('config', 'config/review-evidence.yaml#checks', 'review'),
    target('prompt', 'prompts/pr-review-system.md', 'review'),
  ], ['0026', '0038', '0049']),
  'review-coverage': entry('review', 'Reviews are cut or withheld on a prompt budget that does not fit the diffs', [
    ...REVIEW_BUDGET, target('variable', 'AI_PROVIDER_REVIEW', 'review'),
  ], ['0028', '0038']),
  'autofix-ineffective': entry('autofix', 'Auto-fix attempts end without a delivered push', [
    target('config', 'config/models.yaml#autofix_max_input_tokens'), target('config', 'config/models.yaml#autofix_diff_ratio'),
    target('config', 'config/models.yaml#autofix_feedback_ratio'), target('prompt', 'prompts/auto-fix-system.md'),
  ], ['0017', '0029']),
  'codegen-blocked': entry('generation', 'Code generation is blocked before it proposes a patch', [
    target('config', 'config/models.yaml#generation_max_input_tokens'), target('prompt', 'prompts/generation-system.md'),
    target('prompt', 'prompts/validation-system.md', 'validation'),
  ], ['0029']),
  'llm-fallbacks': entry('provider', 'The primary provider fails often enough that the fallback answers', [
    target('variable', 'AI_PROVIDER_<STAGE>'), target('policy', 'retry policy (ADR-0022)'), target('external', 'provider tier'),
  ], ['0022', '0025']),
});

/** Rules that have no lever, with the reason. A rule is in `LEVERS` or here, never both (a test pins it). */
export const NO_LEVER = Object.freeze({
  'review-duplicates': 'fixed in .github/ workflow triggers, which no lever may name (ADR-0046 §5); the ADR-0028 marker is code, not a setting',
  'runs-failed': 'a failed run needs a root cause (docs/runbook.md), not a setting',
  'stage-failures-*': 'a repeated stage failure needs a root cause (docs/runbook.md), not a setting',
  'review-stuck': 'depends on the content of the pull request',
  escalations: 'a person is the lever (ADR-0001)',
  'rate-limit-waits': 'a symptom of the provider tier; revisit with data',
  'duration-*': 'a symptom of the provider tier; revisit with data',
});

// Rules that put a stage in their id are one family in the tables.
const FAMILIES = ['stage-failures-', 'duration-'];

/** The key of a finding id in `LEVERS` / `NO_LEVER`: `duration-review` → `duration-*`. */
export function ruleKey(id) {
  const family = FAMILIES.find((p) => typeof id === 'string' && id.startsWith(p));
  return family ? `${family}*` : id;
}

// ADR-0046 §5: no lever may point at a gate, a floor, a pipeline definition or a credential. Checked on every
// ref of the table by a test, and exported so a drafting consumer can apply the same refusal to what it writes.
const FORBIDDEN = [
  [/^\.github\//, 'a workflow or token scope (.github/)'],
  [/protected-paths/i, 'the protected-paths floor (ADR-0044)'],
  [/(^|[/#_.<-])(thresholds?|datasets?|floors?|optional)([/#_.>-]|$)/i, 'an eval threshold, dataset or floor (ADR-0031)'],
  [/^evals\//, 'the eval suites (ADR-0031)'],
  [/attempt/i, 'the auto-fix attempt cap (ADR-0034)'],
  [/secrets?\.|\b(GH_TOKEN|AI_PR_TOKEN)\b|API_KEY\b|(^|\/)\.env/i, 'a secret or credential'],
];

/** What no lever may point at (ADR-0046 §5), in words, for the page that lists the levers. */
export const FORBIDDEN_REASONS = Object.freeze(FORBIDDEN.map(([, why]) => why));

/** The reason a ref is a forbidden lever target (ADR-0046 §5), or null. */
export function forbiddenTarget(ref) {
  const text = String(ref ?? '');
  return FORBIDDEN.find(([re]) => re.test(text))?.[1] ?? null;
}

const requirement = (t) => (t.gate ? 'evals' : 'no-eval-gate');

/**
 * The lever of a finding, or null: only an `active` finding of severity `warning` or `critical` from a mapped
 * rule has one. A resolved finding, an `info` finding (a guardrail doing its job) and a rule without an entry
 * are observations, not proposals. `requires` is derived, never stored: per target `evals` (a live suite
 * measures it) or `no-eval-gate` (verify by hand and say so), and `docs-and-tests` always (AGENTS.md).
 */
export function leverFor(finding) {
  const key = ruleKey(finding?.id);
  const lever = Object.hasOwn(LEVERS, key) ? LEVERS[key] : undefined; // own keys only: 'constructor' is not a rule
  if (!lever || finding.status !== 'active' || (finding.severity !== 'warning' && finding.severity !== 'critical')) return null;
  const targets = lever.targets.map((t) => ({ ...t, requires: requirement(t) }));
  return {
    stage: lever.stage, summary: lever.summary, targets, adr: [...lever.adr],
    requires: [...new Set(targets.map((t) => t.requires)), 'docs-and-tests'], verified: false,
  };
}
