// Cost of the pipeline's LLM calls (dashboard): list price × tokens, per call and summed. Pure.
// A call carries the provider-measured usage of its llm_call span (ADR-0041 amendment: prompt cache split
// out, thinking inside the output) or, for older records, the chars/4 estimate; the basis is reported with
// the amount, never mixed silently. List price, never the bill.
import { PRICES_USD_PER_MTOK } from './eval_scorecard.mjs';

// adl.stage of an llm_call → the pipeline stage (stage span) it belongs to.
export const LLM_STAGE_TO_PIPELINE_STAGE = Object.freeze({
  validation: 'issue_validation',
  generation: 'code_gen',
  review: 'review',
  autofix: 'autofix',
});

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Pipeline stage of a call: its adl.stage mapped (an already-pipeline name kept), else null. */
export function pipelineStage(stage) {
  if (typeof stage !== 'string') return null;
  if (Object.hasOwn(LLM_STAGE_TO_PIPELINE_STAGE, stage)) return LLM_STAGE_TO_PIPELINE_STAGE[stage];
  return Object.values(LLM_STAGE_TO_PIPELINE_STAGE).includes(stage) ? stage : null;
}

/**
 * One call `{ provider, model, tokens_in, tokens_out, cache_read?, cache_write?, estimated }` →
 * `{ usd, basis }`. basis: `free` (Groq free tier, usd 0), `unpriced` (no price entry, over the price's prompt
 * limit, or counts that cannot be priced: input / output missing or not non-negative integers, a measured
 * cache count that is not one, or cache reads + writes over the input; usd null), `measured` (cache
 * read/write at their own price), `estimated` (chars/4: every input token at the input price, no thinking).
 */
export function callCost(call) {
  if (call?.provider === 'groq') return { usd: 0, basis: 'free' };
  const price = PRICES_USD_PER_MTOK[`${call?.provider}:${call?.model}`];
  const tin = call?.tokens_in;
  const tout = call?.tokens_out;
  const unpriced = { usd: null, basis: 'unpriced' };
  // Counts come from stored records (untrusted shape): only non-negative integers are priced.
  const valid = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!price || !valid(tin) || !valid(tout) || (price.maxPromptTokens && tin > price.maxPromptTokens)) return unpriced;
  if (call.estimated !== false) return { usd: (tin * price.in + tout * price.out) / 1e6, basis: 'estimated' };
  const read = call.cache_read ?? 0;
  const write = call.cache_write ?? 0;
  if (!valid(read) || !valid(write) || read + write > tin) return unpriced;
  const uncached = tin - read - write;
  const usd = (uncached * price.in + read * (price.cacheRead ?? price.in) + write * (price.cacheWrite ?? price.in) + tout * price.out) / 1e6;
  return { usd, basis: 'measured' };
}

/** Calls → `{ usd, calls, measured, estimated, free, unpriced, tokens_in, tokens_out, cache_read, cache_write }`. */
export function sumCosts(calls) {
  const out = { usd: 0, calls: 0, measured: 0, estimated: 0, free: 0, unpriced: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 };
  for (const call of calls ?? []) {
    const { usd, basis } = callCost(call);
    out.calls += 1;
    out[basis] += 1;
    if (usd != null) out.usd += usd;
    out.tokens_in += count(call?.tokens_in);
    out.tokens_out += count(call?.tokens_out);
    out.cache_read += count(call?.cache_read);
    out.cache_write += count(call?.cache_write);
  }
  return out;
}

/** `{ ...sumCosts }` + another one. */
export function addCosts(a, b) {
  return Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]]));
}

/** USD → `$0.0240` (4 decimals: one review call is a fraction of a cent). */
export const formatUsd = (usd) => (usd == null || !Number.isFinite(usd) ? '—' : `$${usd.toFixed(4)}`);

/** How the amount was obtained: `measured`, `estimated`, `measured + estimated`, or null with no priced call. */
export function costBasis(sum) {
  if (sum.measured && sum.estimated) return 'measured + estimated';
  if (sum.measured) return 'measured';
  if (sum.estimated) return 'estimated';
  return null;
}

/**
 * A sum as one short amount, never an unknown shown as $0: `—` without a call, `free tier` when every call
 * is Groq, `unpriced` when no call is priced, else `$0.0240` with ` + 2 unpriced` when some are not.
 */
export function costAmount(sum) {
  if (!sum.calls) return '—';
  if (sum.free === sum.calls) return 'free tier';
  if (!sum.measured && !sum.estimated) return 'unpriced';
  return `${formatUsd(sum.usd)}${sum.unpriced ? ` + ${sum.unpriced} unpriced` : ''}`;
}

/**
 * A sum spread over `n` runs, items or executions: `—` with nothing to divide or no priced call, `free tier`
 * when every call is Groq, `≥ $0.0120` when some calls are unpriced (their cost is missing, so the mean is
 * only a lower bound), else `$0.0120`.
 */
export function meanAmount(sum, n) {
  if (!n || !sum.calls) return '—';
  if (sum.free === sum.calls) return 'free tier';
  if (!sum.measured && !sum.estimated) return '—';
  return `${sum.unpriced ? '≥ ' : ''}${formatUsd(sum.usd / n)}`;
}

/**
 * One-line amount: `$0.0240 USD + 1 unpriced call(s) (2 Groq free-tier call(s) at no cost)`, or
 * `Not recorded` without any call.
 */
export function costLine(sum) {
  if (!sum.calls) return 'Not recorded';
  return `${formatUsd(sum.usd)} USD${sum.unpriced ? ` + ${sum.unpriced} unpriced call(s)` : ''}${sum.free ? ` (${sum.free} Groq free-tier call(s) at no cost)` : ''}`;
}
