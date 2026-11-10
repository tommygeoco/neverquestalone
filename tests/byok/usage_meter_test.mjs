// Metering (PRD §9.2, §9.4, §7.3, US-1): integer micro-dollars from usage and
// the price table, checked against §7.3's hand-computed turns (a typed turn is
// 7,500 input tokens, 5,500 of them a cacheable prefix, and 350 output), and
// an estimate that is a true upper bound and never silently $0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, localPrice } from '../../bridge/byok/usage/prices.mjs';
import { costMicros, estimateMicros, estimateTurn, isFreePrice, meterReply, normalizeUsage, turnTokens, typicalCost, typicalThink, TYPICAL_THINK_SHARE, TYPICAL_TURN, TYPICAL_PREFIX, BYTES_PER_TOKEN, BLOCK_OVERHEAD_TOKENS } from '../../bridge/byok/usage/meter.mjs';
import { loadPack } from '../../bridge/byok/runtime/pack.mjs';
import { THINK_ROOM } from '../../bridge/byok/providers/util.mjs';
import { effectivePrice, TIER_REACH } from '../../bridge/byok/usage/prices.mjs';

const AT = '2026-09-26T12:00:00Z';
const typedUncached = { input: 7500, output: 350 };
const typedCached = { input: 2000, cacheRead: 5500, output: 350 };
const usd = micros => micros / 1e6;

test('§7.3 typed turns, uncached and with the prefix cached', () => {
  const rows = [
    // model, provider, uncached micros, cached micros, §7.3's rounded figures
    ['claude-haiku-4-5', 'anthropic', 9250, 4300, '0.0093', '0.0043'],
    ['claude-sonnet-5', 'anthropic', 18500, 8600, '0.0185', '0.0086'],
    ['gpt-6-luna', 'openai', 925, 430, '0.0009', '0.0004'],
    ['gpt-6-sol', 'openai', 18500, 8600, '0.0185', '0.0086'],
    ['grok-4.3', 'xai', 10250, 4475, '0.0103', '0.0045'],
  ];
  for (const [model, provider, unc, cac, uncS, cacS] of rows) {
    const p = priceFor(provider, model, AT);
    assert.equal(costMicros(typedUncached, p), unc, `${model} uncached`);
    assert.equal(costMicros(typedCached, p), cac, `${model} cached`);
    // §7.3 rounds half away from zero at 4 places ($0.00925 → $0.0093).
    assert.equal((Math.round(usd(unc) * 1e4 + 1e-9) / 1e4).toFixed(4), uncS, `${model} uncached as printed`);
    assert.equal((Math.round(usd(cac) * 1e4 + 1e-9) / 1e4).toFixed(4), cacS, `${model} cached as printed`);
  }
  // Gemini has no measured cache: the uncached figures only.
  assert.equal(costMicros(typedUncached, priceFor('google', 'gemini-3.1-flash-lite', AT)), 2400);
  assert.equal(costMicros(typedUncached, priceFor('google', 'gemini-3.8-flash', AT)), 6938); // $0.0069375, rounded up
  assert.equal(costMicros(typedUncached, priceFor('google', 'gemini-3.8-flash', '2027-01-02')), 13875);
});

test('§7.3 day totals: 40 typed replies on Haiku, and the companion\'s 20 automatic turns', () => {
  const haiku = priceFor('anthropic', 'claude-haiku-4-5', AT);
  assert.equal(40 * costMicros(typedCached, haiku), 172000); // ≈ $0.17
  assert.equal(40 * costMicros(typedUncached, haiku), 370000); // ≈ $0.37
  assert.equal(20 * costMicros({ input: 6500, output: 250 }, haiku), 155000); // ≈ $0.16
});

test('cache writes: 5-minute at 1.25x and 1-hour at 2x on Anthropic; an unsaid TTL counts as 1-hour', () => {
  const haiku = priceFor('anthropic', 'claude-haiku-4-5', AT);
  const firstTurn5m = { input: 2000, cacheWrite: 5500, cacheWrite1h: 0, output: 350 };
  const firstTurn1h = { input: 2000, cacheWrite: 5500, cacheWrite1h: 5500, output: 350 };
  assert.equal(costMicros(firstTurn5m, haiku), 2000 + 6875 + 1750);
  assert.equal(costMicros(firstTurn1h, haiku), 2000 + 11000 + 1750);
  // An adapter that reports writes without a TTL split (BUILD-PLAN's usage shape) is billed at the 1-hour price (§7.3).
  assert.equal(costMicros({ input: 2000, cacheWrite: 5500, output: 350 }, haiku), 2000 + 11000 + 1750);
  assert.equal(costMicros({ input: 2000, cacheWrite: 5500, cacheWrite1h: NaN, output: 350 }, haiku), 2000 + 11000 + 1750);
  // A 1h count above the total is clamped to the total.
  assert.equal(costMicros({ ...firstTurn1h, cacheWrite1h: 99999 }, haiku), 2000 + 11000 + 1750);
  // OpenAI's single write price, whatever the TTL field says.
  const luna = priceFor('openai', 'gpt-6-luna', AT);
  assert.equal(costMicros({ input: 2000, cacheWrite: 5500, output: 350 }, luna), Math.ceil(200 + 687.5 + 175));
  assert.equal(costMicros({ input: 2000, cacheWrite: 5500, cacheWrite1h: 0, output: 350 }, luna), Math.ceil(200 + 687.5 + 175));
});

test('reasoning bills on top of output only where the provider\'s output count leaves it out', () => {
  // Gemini reports thoughtsTokenCount apart from the output count.
  const flash = priceFor('google', 'gemini-3.8-flash', AT);
  const base = costMicros(typedUncached, flash);
  assert.equal(costMicros({ ...typedUncached, reasoning: 1000 }, flash), base + 3750);
  // Anthropic and OpenAI count reasoning inside output (prices.json reasoningInOutput): never twice.
  for (const [prov, model] of [['anthropic', 'claude-sonnet-5'], ['openai', 'gpt-6-sol']]) {
    const p = priceFor(prov, model, AT);
    assert.equal(p.reasoningInOutput, true, model);
    assert.equal(costMicros({ ...typedUncached, reasoning: 1000 }, p), costMicros(typedUncached, p), model);
    assert.equal(meterReply({ ...typedUncached, reasoning: 1000 }, p).out, 350, `${model} out`);
  }
  // Other (Chat Completions: completion_tokens hold the reasoning): once, priced or free (a server here).
  for (const p of [priceFor('custom', 'deepseek/deepseek-r1', AT), localPrice('custom', 'qwen3:8b')]) {
    assert.equal(p.reasoningInOutput, true, p.model);
    assert.equal(meterReply({ ...typedUncached, reasoning: 1000 }, p).out, 350, `${p.model} out`);
    assert.equal(costMicros({ ...typedUncached, reasoning: 1000 }, p), costMicros(typedUncached, p), p.model);
  }
  // xAI's reasoning is billed on top (its default), and a usage-side flag can't lower a price.
  const grok = priceFor('xai', 'grok-4.3', AT);
  assert.equal(costMicros({ ...typedUncached, reasoning: 1000, reasoningInOutput: true }, grok), costMicros(typedUncached, grok) + 2500);
  // A separate reasoning price wins when a table gives one.
  assert.equal(costMicros({ reasoning: 1000 }, { input: 1, output: 5, reasoning: 2 }), 2000);
});

test('xAI charges its $0.05 fee for a request it blocks before generation', () => {
  const grok = priceFor('xai', 'grok-4.3', AT);
  assert.equal(grok.blockedRequestFee, 0.05);
  assert.equal(costMicros({}, grok, { errorKind: 'content_blocked' }), 50000);
  assert.equal(costMicros({ input: 7500 }, grok, { errorKind: 'content_blocked' }), 9375 + 50000);
  assert.equal(costMicros({}, grok, { errorKind: 'timeout' }), 0);
  assert.equal(meterReply({}, grok, { errorKind: 'content_blocked' }).micros, 50000);
  // Other providers charge nothing extra for a refusal.
  assert.equal(costMicros({}, priceFor('anthropic', 'claude-haiku-4-5'), { errorKind: 'content_blocked' }), 0);
});

test('OpenRouter\'s exact usage.cost wins over the table', () => {
  const p = priceFor('openrouter', 'anthropic/claude-sonnet-5', AT);
  assert.equal(costMicros({ ...typedUncached, costUsd: 0.001234 }, p), 1234);
  assert.equal(costMicros({ ...typedUncached, costUsd: 0 }, priceFor('openrouter', 'openrouter/free')), 0);
  // No cost in the reply (say the stream broke before usage): fall back to the estimate.
  assert.equal(costMicros(typedUncached, p), 18500);
  const r = meterReply({ ...typedUncached, costUsd: 0.0021 }, p);
  assert.deepEqual({ in: r.in, out: r.out, micros: r.micros, model: r.model, exact: r.exact }, { in: 7500, out: 350, micros: 2100, model: 'anthropic/claude-sonnet-5', exact: true });
});

test('local models cost $0 and read as exact', () => {
  const p = priceFor('ollama', 'qwen3:8b');
  const r = meterReply({ input: 9000, output: 400, reasoning: 200 }, p);
  assert.equal(r.micros, 0);
  assert.equal(r.exact, true);
  assert.equal(r.in, 9000);
  assert.equal(r.out, 600);
});

test('meterReply gives the slot\'s per-reply fields and tokens by kind', () => {
  const r = meterReply({ input: 2000, cacheRead: 5500, cacheWrite: 100, cacheWrite1h: 100, output: 300, reasoning: 50 }, priceFor('anthropic', 'claude-haiku-4-5', AT));
  assert.equal(r.in, 7600);
  assert.equal(r.out, 300);
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.exact, false);
  assert.equal(r.known, true);
  assert.equal(r.micros, 2000 + 550 + 200 + 1500);
  assert.deepEqual(r.tokens, { input: 2000, cacheRead: 5500, cacheWrite: 100, cacheWrite1h: 100, output: 300, reasoning: 50 });
  assert.equal(meterReply(typedUncached, priceFor('anthropic', 'claude-next')).known, false);
});

test('long-context tiers never apply (systems plan D6): the per-turn ceiling keeps every request under TIER_REACH, so xAI\'s 200k tier is left out; a tier within reach is folded into the base, at the higher price', () => {
  assert.equal(TIER_REACH, 20000);
  const grok = priceFor('xai', 'grok-4.3', AT);
  assert.equal(grok.input, 1.25);
  assert.equal(grok.tiers, undefined, 'a resolved price has one set of prices');
  assert.equal(costMicros({ input: 15000, cacheRead: 4000, output: 1000 }, grok), 15000 * 1.25 + 4000 * grok.cacheRead + 1000 * grok.output);
  const reachable = effectivePrice({ input: 1, output: 2, tiers: [{ minInput: 10000, input: 3, output: 1 }, { minInput: 200000, input: 9, output: 9 }] });
  assert.deepEqual([reachable.input, reachable.output], [3, 2], 'the 10k tier raised the input price; the 200k tier is out of reach');
});

test('estimateMicros charges input at the dearest input-side price, so no cache hint is needed', () => {
  const haiku = priceFor('anthropic', 'claude-haiku-4-5', AT);
  // 7,500 in at the 1-hour write price ($2) and 1,200 out at $5.
  assert.equal(estimateMicros({ inputTokens: 7500, maxOutputTokens: 1200 }, haiku), 15000 + 6000);
  // The reviewer's case: a 7,500/1,200 turn whose prefix is written for an hour costs 19,000; the bound covers it.
  assert.ok(costMicros({ input: 2000, cacheWrite: 5500, output: 1200 }, haiku) <= estimateMicros({ inputTokens: 7500, maxOutputTokens: 1200 }, haiku));
  // OpenAI: its write price ($2.50) is above input ($2).
  assert.equal(estimateMicros({ inputTokens: 1000, maxOutputTokens: 100 }, priceFor('openai', 'gpt-6-sol', AT)), 2500 + 1000);
  // Thinking billed outside output: the given budget, or the output ceiling again when an effort is set.
  const flash = priceFor('google', 'gemini-3.8-flash', AT);
  assert.equal(estimateMicros({ inputTokens: 6500, maxOutputTokens: 1200, reasoningTokens: 500 }, flash), Math.ceil(6500 * 0.75 + 1700 * 3.75));
  assert.equal(estimateMicros({ inputTokens: 6500, maxOutputTokens: 1200, effort: 'low' }, flash), Math.ceil(6500 * 0.75 + 2400 * 3.75));
  assert.equal(estimateMicros({ inputTokens: 6500, maxOutputTokens: 1200, effort: 'none' }, flash), Math.ceil(6500 * 0.75 + 1200 * 3.75));
  // Anthropic's max_tokens already bounds thinking.
  assert.equal(estimateMicros({ inputTokens: 7500, maxOutputTokens: 1200, effort: 'high', reasoningTokens: 5000 }, haiku), 21000);
  // xAI: a blocked request costs $0.05 instead of the output, so the bound is input + the larger.
  assert.equal(estimateMicros({ inputTokens: 7500, maxOutputTokens: 1200 }, priceFor('xai', 'grok-4.3', AT)), 9375 + 50000);
});

test('estimateMicros takes the BUILD-PLAN request and never makes a paid turn free', () => {
  const haiku = priceFor('anthropic', 'claude-haiku-4-5', AT);
  const req = { model: 'claude-haiku-4-5', system: [{ text: 'x'.repeat(20000), cache: true }], messages: [{ role: 'user', content: 'hi' }], maxTokens: 1200, effort: null };
  const t = turnTokens(req);
  assert.equal(t.inputTokens, Math.ceil(20002 / BYTES_PER_TOKEN) + 2 * BLOCK_OVERHEAD_TOKENS);
  assert.equal(t.maxOutputTokens, 1200);
  assert.equal(estimateMicros(req, haiku), t.inputTokens * 2 + 6000);
  // Content parts and CJK text (3 UTF-8 bytes, about a token each).
  assert.equal(turnTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: '竜'.repeat(300) }] }], maxTokens: 10 }).inputTokens, 300 + BLOCK_OVERHEAD_TOKENS);
  // A calibrated count wins over measuring the text (§9.3).
  assert.equal(turnTokens({ ...req, inputTokens: 9000 }).inputTokens, 9000);
  // Anything that would have read as $0 throws instead.
  for (const bad of [undefined, null, {}, { inputTokens: 7500 }, { maxOutputTokens: 1200 }, { ...req, maxTokens: undefined }, { messages: [], maxTokens: 1200 }, { inputTokens: -5, maxOutputTokens: 1200 }]) {
    assert.throws(() => estimateMicros(bad, haiku), /estimateMicros needs/, JSON.stringify(bad));
  }
  // A local or $0 price is free whatever the request, and estimateTurn says so.
  assert.equal(estimateMicros({}, priceFor('lmstudio', 'x')), 0);
  assert.deepEqual(estimateTurn({}, priceFor('ollama', 'qwen3:8b')), { estMicros: 0, free: true });
  assert.deepEqual(estimateTurn(req, priceFor('openrouter', 'google/gemma-4-31b-it:free')), { estMicros: 0, free: true });
  assert.deepEqual(estimateTurn(req, haiku), { estMicros: estimateMicros(req, haiku), free: false });
  assert.equal(isFreePrice(priceFor('xai', 'grok-4.3')), false);
  assert.equal(isFreePrice({ input: 0, output: 0, blockedRequestFee: 0.05 }), false, 'a fee makes it paid');
  assert.equal(isFreePrice({ input: 0, output: 0, tiers: [{ minInput: 100, input: 1 }] }), false, 'a paid tier makes it paid');
});

test('property: any usage inside the bounds costs no more than the estimate, for every bundled model', () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % (n + 1); };
  const models = [['anthropic', 'claude-haiku-4-5'], ['anthropic', 'claude-sonnet-5'], ['openai', 'gpt-6-luna'], ['openai', 'gpt-6-sol'],
    ['google', 'gemini-3.1-flash-lite'], ['google', 'gemini-3.8-flash'], ['xai', 'grok-4.3'], ['xai', 'grok-4.7']];
  for (const [prov, model] of models) {
    for (const at of [AT, '2027-02-01T00:00:00Z']) {
      const p = priceFor(prov, model, at);
      for (let i = 0; i < 200; i++) {
        const inputTokens = i % 50 === 0 ? 200000 + rand(50000) : 1000 + rand(19000);
        const maxOutputTokens = 1200;
        const reasoningTokens = rand(2000);
        const cacheWrite = rand(inputTokens);
        const cacheRead = rand(inputTokens - cacheWrite);
        const output = rand(maxOutputTokens);
        const usage = {
          input: inputTokens - cacheWrite - cacheRead, cacheRead, cacheWrite, output,
          // Inside output where the provider says so, else within the thinking budget.
          reasoning: p.reasoningInOutput ? rand(output) : rand(reasoningTokens),
        };
        if (rand(1)) usage.cacheWrite1h = rand(cacheWrite); // else unsaid: all 1-hour
        const bound = estimateMicros({ inputTokens, maxOutputTokens, reasoningTokens }, p);
        assert.ok(costMicros(usage, p) <= bound, `${model}: ${JSON.stringify(usage)}`);
        assert.ok(costMicros({ input: inputTokens }, p, { errorKind: 'content_blocked' }) <= bound, `${model} blocked`);
      }
    }
  }
});

test('money is always an integer number of micro-dollars, and junk usage counts as zero', () => {
  const luna = priceFor('openai', 'gpt-6-luna', AT);
  for (const u of [{ input: 1, output: 1 }, { input: 3, cacheRead: 7, output: 11 }, { input: 12345, output: 678, reasoning: 9 }]) {
    assert.ok(Number.isInteger(costMicros(u, luna)));
  }
  assert.equal(costMicros({ input: 1, output: 1 }, luna), 1); // $0.0000006 rounds up, never to 0
  assert.equal(costMicros({ input: -5, output: NaN, cacheRead: 'x' }, luna), 0);
  assert.equal(costMicros(undefined, luna), 0);
  assert.deepEqual(normalizeUsage({ input: 10.9, cacheWrite: 5, cacheWrite1h: 9 }), { input: 10, output: 0, cacheRead: 0, cacheWrite: 5, cacheWrite1h: 5, reasoning: 0 });
  assert.deepEqual(normalizeUsage({ cacheWrite: 5 }).cacheWrite1h, 5);
  assert.deepEqual(normalizeUsage({ cacheWrite: 5, cacheWrite1h: -3 }).cacheWrite1h, 0);
  assert.throws(() => costMicros(typedUncached, null), /needs input and output/);
});

// SY-102-1: every default model thinks at Low and every AI bills thinking as output, so the typical
// turn's figures carry a thinking allowance (half its start level's room), billed as each company
// bills it: inside output (Anthropic, OpenAI) or at the reasoning price (Google, xAI).
test('the typical cost counts the thinking a model does at its start level', () => {
  assert.equal(TYPICAL_THINK_SHARE, 0.5);
  assert.equal(typicalThink(THINK_ROOM.low), 1024);
  assert.equal(typicalThink(0), 0);
  assert.equal(typicalThink(undefined), 0);
  assert.equal(typicalThink(-5), 0);
  const sonnet = priceFor('anthropic', 'claude-sonnet-5-5', AT);
  // The prefix is the prompt pack's own size (code health BR-18: a hard-coded 5,500, under the pack alone).
  assert.equal(TYPICAL_PREFIX, loadPack().tokens);
  assert.ok(TYPICAL_PREFIX > 5500, `the pack: ${TYPICAL_PREFIX} tokens`);
  assert.deepEqual([TYPICAL_TURN.cached.cacheRead, TYPICAL_TURN.uncached.input], [TYPICAL_PREFIX, TYPICAL_PREFIX + 2000]);
  // Without thinking: the current pack cached at $0.20, 2,000 at $2, 350 out at $10; uncached all at $2.
  assert.deepEqual(typicalCost(sonnet), { replyCents: [0.91, 2.33], dayUsd: [0.36, 0.93], at: 40, think: 0 });
  // At Low: 1,024 more output tokens at $10 each end (10,240 micro-dollars).
  const low = typicalCost(sonnet, { thinkRoom: THINK_ROOM.low });
  assert.deepEqual(low, { replyCents: [1.93, 3.35], dayUsd: [0.77, 1.34], at: 40, think: 1024 });
  assert.equal(low.replyCents[1], Math.round(costMicros({ input: TYPICAL_TURN.uncached.input, output: 350 + 1024 }, sonnet) / 100) / 100);
  // Google bills thinking at its reasoning price (the output price where none is listed), on top of output.
  const flash = priceFor('google', 'gemini-3.8-flash', AT);
  assert.equal(effectivePrice(flash).reasoningInOutput, false);
  const g = typicalCost(flash, { thinkRoom: THINK_ROOM.low });
  assert.equal(g.replyCents[1], Math.round(costMicros({ input: TYPICAL_TURN.uncached.input, output: 350, reasoning: 1024 }, flash) / 100) / 100);
  assert.ok(g.dayUsd[1] > typicalCost(flash).dayUsd[1], 'thinking costs more on Google too');
  // A higher start room costs more; a model that never thinks costs what it did.
  assert.ok(typicalCost(sonnet, { thinkRoom: THINK_ROOM.high }).dayUsd[1] > low.dayUsd[1]);
});
