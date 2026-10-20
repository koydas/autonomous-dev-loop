import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_STAGE_TO_PIPELINE_STAGE, pipelineStage, callCost, sumCosts, addCosts, formatUsd, costBasis, costLine,
} from '../lib/llm_cost.mjs';

const opus = (over = {}) => ({ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1_000_000, tokens_out: 100_000, ...over });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('pipelineStage maps every llm stage, keeps a pipeline stage name, null otherwise', () => {
  for (const [llm, stage] of Object.entries(LLM_STAGE_TO_PIPELINE_STAGE)) assert.equal(pipelineStage(llm), stage);
  assert.equal(pipelineStage('code_gen'), 'code_gen');
  assert.equal(pipelineStage('pr_prepare'), null);
  assert.equal(pipelineStage('eval'), null);
  assert.equal(pipelineStage(null), null);
  assert.equal(pipelineStage(42), null);
});

test('callCost: an estimated call prices every input token at the input price, no cache split', () => {
  const c = callCost(opus({ estimated: true, cache_read: 900_000 }));
  assert.equal(c.basis, 'estimated');
  close(c.usd, 4 + 2);
  assert.equal(callCost(opus()).basis, 'estimated', 'no flag: estimated');
});

test('callCost: a measured call prices cache reads and writes apart from the uncached input', () => {
  const c = callCost(opus({ estimated: false, cache_read: 800_000, cache_write: 100_000 }));
  assert.equal(c.basis, 'measured');
  // 100k uncached × $4 + 800k read × $0.20 + 100k write × $5 + 100k out × $20, per MTok
  close(c.usd, 0.4 + 0.16 + 0.5 + 2);
  close(callCost(opus({ estimated: false })).usd, 4 + 2);
  close(callCost(opus({ estimated: false, cache_read: 2_000_000 })).usd, 2_000_000 * 0.2 / 1e6 + 2);
});

test('callCost: a price without cache entries falls back to the input price', async () => {
  const { PRICES_USD_PER_MTOK } = await import('../lib/eval_scorecard.mjs');
  PRICES_USD_PER_MTOK['anthropic:test-model'] = { in: 1, out: 2 };
  try {
    close(callCost({ provider: 'anthropic', model: 'test-model', tokens_in: 1e6, tokens_out: 0, cache_read: 5e5, cache_write: 5e5, estimated: false }).usd, 1);
  } finally {
    delete PRICES_USD_PER_MTOK['anthropic:test-model'];
  }
});

test('callCost: Groq is free, an unknown model, missing tokens or an over-limit prompt is unpriced', () => {
  assert.deepEqual(callCost({ provider: 'groq', model: 'openai/gpt-oss-120b', tokens_in: 9, tokens_out: 9 }), { usd: 0, basis: 'free' });
  assert.deepEqual(callCost({ provider: 'anthropic', model: 'claude-unknown', tokens_in: 1, tokens_out: 1 }), { usd: null, basis: 'unpriced' });
  assert.deepEqual(callCost(opus({ tokens_in: null })), { usd: null, basis: 'unpriced' });
  assert.deepEqual(callCost(opus({ tokens_out: undefined })), { usd: null, basis: 'unpriced' });
  assert.deepEqual(callCost({ provider: 'anthropic', model: 'claude-haiku-5-5', tokens_in: 100_001, tokens_out: 1 }), { usd: null, basis: 'unpriced' });
  assert.equal(callCost({ provider: 'anthropic', model: 'claude-haiku-5-5', tokens_in: 100_000, tokens_out: 0 }).basis, 'estimated');
  assert.deepEqual(callCost(null), { usd: null, basis: 'unpriced' });
});

test('sumCosts adds amounts, tokens and counts per basis; addCosts sums two of them', () => {
  const calls = [
    opus({ estimated: false, cache_read: 500_000, cache_write: 0 }),
    opus({ tokens_in: 1000, tokens_out: 10 }),
    { provider: 'groq', model: 'g', tokens_in: 50, tokens_out: 5 },
    { provider: 'other', model: 'x', tokens_in: -3, tokens_out: 1.5 },
  ];
  const s = sumCosts(calls);
  assert.deepEqual({ ...s, usd: undefined }, { usd: undefined, calls: 4, measured: 1, estimated: 1, free: 1, unpriced: 1, tokens_in: 1_001_050, tokens_out: 100_015, cache_read: 500_000, cache_write: 0 });
  close(s.usd, (500_000 * 4 + 500_000 * 0.2 + 100_000 * 20) / 1e6 + (1000 * 4 + 10 * 20) / 1e6);
  assert.deepEqual(sumCosts(), sumCosts([]));
  assert.equal(addCosts(s, s).calls, 8);
  close(addCosts(s, sumCosts([])).usd, s.usd);
});

test('formatUsd, costBasis and costLine', () => {
  assert.equal(formatUsd(0.024), '$0.0240');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(NaN), '—');
  const one = (c) => sumCosts([c]);
  assert.equal(costBasis(one(opus({ estimated: false }))), 'measured');
  assert.equal(costBasis(one(opus())), 'estimated');
  assert.equal(costBasis(sumCosts([opus(), opus({ estimated: false })])), 'measured + estimated');
  assert.equal(costBasis(one({ provider: 'groq' })), null);
  assert.equal(costLine(sumCosts([])), 'Not recorded');
  assert.equal(costLine(sumCosts([opus({ tokens_in: 1000, tokens_out: 1000 }), { provider: 'x' }, { provider: 'groq' }])), '$0.0240 USD + 1 unpriced call(s) (1 Groq free-tier call(s) at no cost)');
});
