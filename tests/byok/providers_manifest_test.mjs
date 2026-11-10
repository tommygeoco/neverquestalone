// Manifests and key routing (PRD §7.1, §7.2, §7.4, §13.3, PV-2, PV-4):
// the schema for the five setup offers (Claude, ChatGPT, Grok, Gemini, and
// Other's template), the per-provider request defaults, paste routing by key
// shape (sk-ant- before OpenAI's generic sk-, AIza for Gemini), the
// effort-map rules, and model fallback within a provider. No signed data
// file: a manifest change ships with an app update. Other (custom.json) has
// its own file: providers_custom_test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifests, validateManifest, pickProviderForKey, getManifest, resolveModel, modelAvailable, retiringOf, createProvider, ADAPTERS, EFFORT_FIELDS } from '../../bridge/byok/providers/index.mjs';
import { hasEffortControl, effortFragment, withQuery, effortLevels, nearestEffort, EFFORT_LEVELS, THINK_ROOM } from '../../bridge/byok/providers/util.mjs';
import { CANARY, serveOne, fixture, mockProvider, collect, req } from './helpers/mock-provider.mjs';

// The four AIs a key comes from, and the ChatGPT plan, which signs in; custom.json is Other's template
// (no base URL until the player sets one).
const IDS = ['anthropic', 'openai', 'chatgpt', 'xai', 'google'];
// URLs with a user part are built with AT: the scrub scanner reads user@host as an email address,
// and these files go out with the public tree (security review SR-02).
const AT = '@';

test('the six manifests load (four keyed AIs, the ChatGPT plan and Other\'s template), pass the schema and are frozen', () => {
  const ms = loadManifests();
  assert.deepEqual([...ms.map(m => m.id)].sort(), [...IDS, 'custom'].sort());
  for (const m of ms) {
    assert.deepEqual(validateManifest(m), [], m.id);
    assert.ok(Object.isFrozen(m) && Object.isFrozen(m.models) && Object.isFrozen(m.defaultRequestOptions), `${m.id} frozen`);
    assert.ok(Object.hasOwn(ADAPTERS, m.adapter));
  }
});

test('setup offers exactly six, in order: Claude, ChatGPT, ChatGPT plan, Grok, Gemini, Other; OpenRouter, Ollama and LM Studio are no AIs of their own', () => {
  const cards = loadManifests().filter(m => !m.hidden && m.display?.card).sort((a, b) => a.display.order - b.display.order);
  assert.deepEqual(cards.map(m => m.display.card), ['Claude', 'ChatGPT', 'ChatGPT plan', 'Grok', 'Gemini', 'Other']);
  for (const id of ['openrouter', 'ollama', 'lmstudio']) assert.equal(getManifest(id), null, id);
  assert.equal(Object.hasOwn(ADAPTERS, 'ollama'), false, 'Ollama is reached through its OpenAI-compatible address');
  assert.equal(Object.hasOwn(ADAPTERS, 'gemini'), false, 'Gemini is reached through its OpenAI-compatible address');
});

test('adapters per §7.1: Messages, Responses (OpenAI, xAI), Chat Completions (Gemini, Other, xAI fallback)', () => {
  const want = { anthropic: 'anthropic-messages', openai: 'openai-responses', chatgpt: 'openai-responses', xai: 'openai-responses', google: 'openai-chat', custom: 'openai-chat' };
  for (const [id, a] of Object.entries(want)) assert.equal(getManifest(id).adapter, a, id);
  assert.equal(getManifest('xai').altAdapter, 'openai-chat');
});

test('Gemini: Google\'s OpenAI-compatible endpoint (its one host), a Bearer key, gemini-3.8-flash with its thinking level, the 18+ note', () => {
  const g = getManifest('google');
  assert.equal(g.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.deepEqual(g.hosts, ['generativelanguage.googleapis.com']);
  assert.deepEqual(g.auth, { header: 'authorization', scheme: 'Bearer' });
  assert.equal(g.paths.chat, '/chat/completions');
  assert.equal(g.models.default, 'gemini-3.8-flash');
  assert.deepEqual(effortFragment(g, 'gemini-3.8-flash', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(effortFragment(g, 'gemini-3.8-flash', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(g.defaultRequestOptions, {});
  assert.equal(g.display.card, 'Gemini');
  assert.equal(g.display.maker, 'Google');
  assert.match(g.terms.playerNotes.join(' '), /18 or older/);
  assert.ok(g.links.keys.startsWith('https://aistudio.google.com/'));
});

test('request defaults per §7.2: store:false (OpenAI, xAI), nothing extra for Gemini or Other, nothing sampling-related anywhere', () => {
  assert.equal(getManifest('openai').defaultRequestOptions.store, false);
  assert.equal(getManifest('xai').defaultRequestOptions.store, false);
  assert.deepEqual(getManifest('google').defaultRequestOptions, {});
  assert.deepEqual(getManifest('custom').defaultRequestOptions, {});
  assert.deepEqual(getManifest('anthropic').defaultRequestOptions, {});
  for (const id of IDS) assert.doesNotMatch(JSON.stringify(getManifest(id).defaultRequestOptions) + JSON.stringify(getManifest(id).effort), /temperature|top_p|top_k/, id);
  assert.equal(getManifest('openai').safetyIdentifier, true);
  for (const id of IDS.filter(i => i !== 'openai')) assert.equal(getManifest(id).safetyIdentifier, false, id);
});

test('the AIs use https and name their host', () => {
  for (const id of IDS) {
    const m = getManifest(id);
    const u = new URL(m.baseUrl);
    assert.ok(m.hosts.includes(u.hostname), id);
    assert.equal(m.local, false, id);
    assert.equal(u.protocol, 'https:');
    assert.ok(m.auth.header);
  }
  assert.equal(getManifest('anthropic').auth.header, 'x-api-key');
});

// fix-102, the owner (2026-09-30): "defaulting to the fronteir cheaper models. so not haiku but sonnet
// 5.5", then "we need more model options nad thinking levels". Each AI's default is its newest
// mid-tier model, and it offers its whole current lineup, newest first, each model read on its
// company's own models page that day (the entry's source).
test('defaults (fix-102): each AI\'s newest mid-tier model, and its whole current lineup, newest first', () => {
  const d = (id) => [getManifest(id).models.default, getManifest(id).models.smarter];
  // The most capable model is named, so the full list tags it Smartest (clarity r4, CL-words-35); xAI's
  // default is its top model.
  assert.deepEqual(d('anthropic'), ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(d('openai'), ['gpt-6.1-sol', 'gpt-6-astra']);
  // The ChatGPT plan's default is its fastest (the reply's 1.5 s at low), its smarter the top model.
  assert.deepEqual(d('chatgpt'), ['gpt-6-luna', 'gpt-6-astra']);
  assert.deepEqual(d('xai'), ['grok-4.7', null]);
  assert.deepEqual(d('google'), ['gemini-3.8-flash', 'gemini-3.1-pro-preview']);
  assert.equal(getManifest('custom').models.default, null, 'Other\'s model is the player\'s');
  const ids = id => getManifest(id).models.list.map(e => e.id);
  assert.deepEqual(ids('anthropic'), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5']);
  assert.deepEqual(ids('openai'), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  assert.deepEqual(ids('xai'), ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning']);
  assert.deepEqual(ids('google'), ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview']);
  for (const id of IDS) {
    const list = getManifest(id).models.list;
    assert.equal(list[0].id, getManifest(id).models.default, `${id}: the default comes first`);
    for (const e of list) {
      assert.match(e.source ?? '', /https:\/\/\S+/, `${id} ${e.id}: where its facts come from`);
      assert.match(e.source, id === 'chatgpt' ? /2026-11-09/ : /2026-09-(24|30)/, `${id} ${e.id}: when they were read`);
    }
  }
  // Older models stay selectable: every model 1.0.1 offered is still listed, so a saved choice keeps working.
  for (const [id, old] of [['anthropic', ['claude-haiku-4-5', 'claude-sonnet-5']], ['openai', ['gpt-6-luna', 'gpt-6-sol']], ['xai', ['grok-4.3', 'grok-4.7']], ['google', ['gemini-3.8-flash']]]) {
    for (const m of old) assert.ok(ids(id).includes(m), `${id} keeps ${m}`);
  }
  // A replaced model names its successor, so a retirement moves to it rather than down a tier.
  assert.equal(getManifest('anthropic').models.list.find(e => e.id === 'claude-sonnet-5').replacedBy, 'claude-sonnet-5-5');
  assert.equal(getManifest('openai').models.list.find(e => e.id === 'gpt-6-sol').replacedBy, 'gpt-6.1-sol');
  assert.equal(getManifest('xai').models.list.find(e => e.id === 'grok-4.6').replacedBy, 'grok-4.7');
  for (const old of ['gemini-3.7-flash', 'gemini-3.6-flash']) assert.equal(getManifest('google').models.list.find(e => e.id === old).replacedBy, 'gemini-3.8-flash');
});

// Every model gets every thinking level its company documents for it, with honest names: Off only
// where the model can answer without thinking; the rest by the companies' own names (xhigh is
// "Extra high" in the window). Each level asks with the request fields that company documents.
test('thinking levels (fix-102): each model\'s own, cheapest first, Off only where thinking can be turned off', () => {
  const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];
  const a = getManifest('anthropic');
  // Claude Sonnet 5.5: the lowest setting is thinking between_tools (no up-front thinking; disabled is
  // refused), at effort high or below: Off at low effort. Effort low to max.
  assert.deepEqual(effortLevels(a, 'claude-sonnet-5-5'), ['off', ...FULL]);
  assert.deepEqual(effortFragment(a, 'claude-sonnet-5-5', 'off'), { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
  for (const l of FULL) assert.deepEqual(effortFragment(a, 'claude-sonnet-5-5', l), { output_config: { effort: l } }, l);
  // Claude Opus 5.5 and Fable 5.1 always think: no Off.
  for (const id of ['claude-opus-5-5', 'claude-fable-5-1']) {
    assert.deepEqual(effortLevels(a, id), FULL, id);
    for (const l of FULL) assert.deepEqual(effortFragment(a, id, l), { output_config: { effort: l } }, `${id} ${l}`);
  }
  // Claude Sonnet 5: Off is thinking disabled at low effort; Low is low effort with thinking on.
  assert.deepEqual(effortLevels(a, 'claude-sonnet-5'), ['off', ...FULL]);
  assert.deepEqual(effortFragment(a, 'claude-sonnet-5', 'off'), { thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
  assert.deepEqual(effortFragment(a, 'claude-sonnet-5', 'low'), { output_config: { effort: 'low' } });
  // Claude Haiku 4.5: extended thinking only, off by default; each level a budget of its room (at least 1,024).
  assert.deepEqual(effortLevels(a, 'claude-haiku-4-5'), [...EFFORT_LEVELS]);
  assert.equal(hasEffortControl(a, 'claude-haiku-4-5'), true);
  assert.deepEqual(effortFragment(a, 'claude-haiku-4-5', 'off'), {});
  // Its budget is its level's room, except Max, held to its 64K output less the reply's 1,200 (SY-102-6).
  for (const l of EFFORT_LEVELS.slice(1)) assert.deepEqual(effortFragment(a, 'claude-haiku-4-5', l), { thinking: { type: 'enabled', budget_tokens: l === 'max' ? 64000 - 1200 : THINK_ROOM[l] } }, l);
  // OpenAI: reasoning.effort none is Off where the model takes it; GPT-6.1 Sol and GPT-6 Astra don't.
  const o = getManifest('openai');
  for (const id of ['gpt-6.1-sol', 'gpt-6-astra']) assert.deepEqual(effortLevels(o, id), FULL, id);
  for (const id of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.deepEqual(effortLevels(o, id), ['off', ...FULL], id);
    assert.deepEqual(effortFragment(o, id, 'off'), { reasoning: { effort: 'none' } }, id);
  }
  for (const l of FULL) assert.deepEqual(effortFragment(o, 'gpt-6.1-sol', l), { reasoning: { effort: l } }, l);
  assert.deepEqual(effortFragment(o, 'gpt-6-luna', 'low'), { reasoning: { effort: 'low' } }, 'Low is low effort, not none: none is Off');
  // xAI: xhigh from grok-4.6 on; grok-4.3 can turn thinking off (none); the 4.20 pair has no control.
  const x = getManifest('xai');
  const xl = { 'grok-4.7': ['low', 'medium', 'high', 'xhigh'], 'grok-4.6': ['low', 'medium', 'high', 'xhigh'], 'grok-4.5': ['low', 'medium', 'high'], 'grok-4.3': ['off', 'low', 'medium', 'high'], 'grok-4.20-0309-reasoning': [], 'grok-4.20-0309-non-reasoning': [] };
  for (const [id, want] of Object.entries(xl)) {
    assert.deepEqual(effortLevels(x, id), want, id);
    assert.deepEqual(effortLevels({ effort: x.effortAlt }, id), want, `${id} on the Chat Completions fallback`);
    for (const l of want) {
      const wire = l === 'off' ? 'none' : l;
      assert.deepEqual(effortFragment(x, id, l), { reasoning: { effort: wire } }, `${id} ${l}`);
      assert.deepEqual(x.effortAlt[id][l], { reasoning_effort: wire }, `${id} ${l} on the fallback`);
    }
  }
  assert.equal(x.models.list.find(e => e.id === 'grok-4.20-0309-reasoning').thinkRoom, 4096, 'it always thinks: room for it');
  assert.equal(x.models.list.find(e => e.id === 'grok-4.20-0309-non-reasoning').thinkRoom, undefined);
  // Google: thinking can't be turned off on Gemini 3; minimal where the model has it.
  const g = getManifest('google');
  const gl = { 'gemini-3.8-flash': ['low', 'medium', 'high'], 'gemini-3.7-flash': ['low', 'medium', 'high'], 'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'], 'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'], 'gemini-3.5-flash': ['minimal', 'low', 'medium', 'high'], 'gemini-3.1-flash-lite': ['minimal', 'low', 'medium', 'high'], 'gemini-3.1-pro-preview': ['low', 'medium', 'high'], 'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'] };
  for (const [id, want] of Object.entries(gl)) {
    assert.deepEqual(effortLevels(g, id), want, id);
    for (const l of want) assert.deepEqual(effortFragment(g, id, l), { reasoning_effort: l }, `${id} ${l}`);
  }
  assert.equal(hasEffortControl(getManifest('custom'), 'whatever'), false, 'Other sends no effort field a service might refuse');
  // Every listed model with levels starts at Low (DB22), which every one of them has.
  for (const id of IDS) for (const e of getManifest(id).models.list) if (e.effort) assert.ok(effortLevels(getManifest(id), e.id).includes('low'), `${id} ${e.id} has Low`);
});

test('nearestEffort (fix-102): a level a model lacks runs as its next one up, else its highest', () => {
  assert.equal(nearestEffort(['low', 'medium', 'high', 'xhigh', 'max'], 'off'), 'low', 'a model that always thinks: its lowest');
  assert.equal(nearestEffort(['off', 'low', 'medium', 'high'], 'minimal'), 'low');
  assert.equal(nearestEffort(['low', 'medium', 'high', 'xhigh'], 'max'), 'xhigh', 'past its highest: its highest');
  assert.equal(nearestEffort(['minimal', 'low', 'medium', 'high'], 'off'), 'minimal');
  assert.equal(nearestEffort(['off', 'low'], 'low'), 'low');
  assert.equal(nearestEffort([], 'low'), null, 'no levels, no level');
  assert.equal(nearestEffort(['low', 'high'], 'nonsense'), 'low', 'an unknown one: the lowest');
});

test('validateManifest checks thinking levels (fix-102): known levels, budgets within their room, thinkRoom only without levels, the fallback\'s levels the same', () => {
  const a = structuredClone(getManifest('anthropic'));
  const with_ = (patch) => validateManifest({ ...structuredClone(a), ...patch });
  assert.ok(with_({ effort: { ...a.effort, 'claude-opus-5-5': { ...a.effort['claude-opus-5-5'], ultra: { output_config: { effort: 'max' } } } } }).some(p => /unknown level ultra/.test(p)));
  const haiku = (frag) => with_({ effort: { ...a.effort, 'claude-haiku-4-5': { ...a.effort['claude-haiku-4-5'], low: frag } } });
  assert.ok(haiku({ thinking: { type: 'enabled', budget_tokens: 4096 } }).some(p => /budget_tokens must be a whole number from 1,024 to 2048/.test(p)), 'more than its room: max_tokens would not stay above it');
  assert.ok(haiku({ thinking: { type: 'enabled', budget_tokens: 512 } }).some(p => /budget_tokens/.test(p)), 'below the API\'s 1,024');
  assert.ok(haiku({ thinking: { budget_tokens: 2048 } }).some(p => /needs thinking\.type enabled/.test(p)));
  assert.deepEqual(haiku({ thinking: { type: 'enabled', budget_tokens: 1024 } }), [], 'a smaller budget is fine');
  const list = a.models.list.map(e => (e.id === 'claude-opus-5-5' ? { ...e, thinkRoom: 4096 } : e));
  assert.ok(with_({ models: { ...a.models, list } }).some(p => /thinkRoom is for a model with no levels/.test(p)));
  // SY-102-6: a model's output ceiling (outputTokens) holds the reply, and every thinking budget with the reply on top.
  const ceil = (id, n) => ({ models: { ...a.models, list: a.models.list.map(e => (e.id === id ? { ...e, outputTokens: n } : e)) } });
  assert.ok(with_(ceil('claude-opus-5-5', 1000)).some(p => /claude-opus-5-5: outputTokens must be a whole number of at least the reply's 1200/.test(p)));
  assert.ok(with_(ceil('claude-haiku-4-5', 63999)).some(p => /claude-haiku-4-5: max's thinking budget and the reply's 1200 must fit its outputTokens \(63999\)/.test(p)), 'Max\'s 62,800 and the reply\'s 1,200 need 64,000');
  assert.deepEqual(with_(ceil('claude-haiku-4-5', 64000)), []);
  for (const [id, e] of [['anthropic', 'claude-sonnet-5-5'], ['anthropic', 'claude-haiku-4-5'], ['openai', 'gpt-6.1-sol']]) {
    assert.ok(Number.isInteger(getManifest(id).models.list.find(m => m.id === e).outputTokens), `${e}: its documented output ceiling`);
  }
  const x = structuredClone(getManifest('xai'));
  const alt = { ...x.effortAlt, 'grok-4.7': { low: { reasoning_effort: 'low' } } };
  assert.ok(validateManifest({ ...x, effortAlt: alt }).some(p => /grok-4\.7: effortAlt offers other levels than effort/.test(p)));
});

// SY-102-5: Claude Haiku 4.5, which the 1.0.0 install base saved by name, retires "not sooner than
// October 15, 2026" (Anthropic's model deprecations page) and nothing no dearer replaces it, so no
// switch happens by itself. The day and the model the window offers are the manifest's data.
test('a retiring model names its earliest day and the model offered in its place (retiresAfter, moveTo; SY-102-5)', () => {
  const a = getManifest('anthropic');
  const haiku = a.models.list.find(e => e.id === 'claude-haiku-4-5');
  assert.equal(haiku.retiresAfter, '2026-10-15');
  assert.equal(haiku.moveTo, 'claude-sonnet-5-5', 'the default: no cheaper Claude replaces it');
  assert.equal(haiku.replacedBy, undefined, 'no automatic move: Sonnet 5.5 ranks dearer');
  assert.match(haiku.source, /model-deprecations, read 2026-10-02\): active, tentative retirement date not sooner than October 15, 2026/);
  assert.deepEqual(retiringOf(a, 'claude-haiku-4-5'), { model: 'claude-haiku-4-5', after: '2026-10-15', to: 'claude-sonnet-5-5' });
  assert.equal(retiringOf(a, 'claude-sonnet-5-5'), null);
  assert.equal(retiringOf(a, 'claude-old-1'), null);
  assert.equal(retiringOf(null, 'claude-haiku-4-5'), null);
  for (const id of IDS) for (const e of getManifest(id).models.list) if (e.id !== 'claude-haiku-4-5') assert.equal(e.retiresAfter, undefined, `${id} ${e.id}`);
  // The schema: a real day, and a listed model that isn't retiring itself.
  const set = (patch, id = 'claude-haiku-4-5') => validateManifest({ ...structuredClone(a), models: { ...a.models, list: a.models.list.map(e => (e.id === id ? { ...e, ...patch } : e)) } });
  assert.deepEqual(set({}), []);
  for (const day of ['2026-02-30', 'Oct 15', '2026-10-15T00:00:00Z', 20261015]) assert.ok(set({ retiresAfter: day }).some(p => /retiresAfter is a day/.test(p)), String(day));
  assert.ok(set({ moveTo: undefined }).some(p => /names another model to move to/.test(p)));
  assert.ok(set({ moveTo: 'claude-haiku-4-5' }).some(p => /names another model to move to/.test(p)));
  assert.ok(set({ moveTo: 'claude-nope' }).some(p => /moveTo claude-nope must be a listed model that isn't retiring/.test(p)));
  assert.ok(set({ retiresAfter: undefined }).some(p => /retiresAfter is a day/.test(p)), 'moveTo needs the day');
  const both = { ...structuredClone(a), models: { ...a.models, list: a.models.list.map(e => (e.id === 'claude-sonnet-5-5' ? { ...e, retiresAfter: '2027-09-28', moveTo: 'claude-opus-5-5' } : e)) } };
  assert.ok(validateManifest(both).some(p => /moveTo claude-sonnet-5-5 must be a listed model that isn't retiring/.test(p)));
});

test('privacy cards carry the §13.3 fields', () => {
  for (const id of [...IDS, 'custom']) {
    const p = getManifest(id).privacy;
    for (const k of ['class', 'retention', 'trains', 'zdr', 'sets', 'notes']) assert.equal(typeof p[k], 'string', `${id}.${k}`);
  }
  assert.equal(getManifest('custom').privacy.local.class, 'local', 'Other at a server on this computer');
  assert.equal(getManifest('google').privacy.class, 'cloud', 'the free tier may train on messages');
  assert.match(getManifest('anthropic').terms.notes.join(' '), /isn't an API key/);
});

test('validateManifest catches the dangerous mistakes', () => {
  const base = structuredClone(getManifest('anthropic'));
  const bad = (patch) => validateManifest({ ...structuredClone(base), ...patch });
  assert.ok(bad({ baseUrl: 'http://api.anthropic.com/v1' }).some(p => /https/.test(p)));
  assert.ok(bad({ hosts: ['evil.example'] }).some(p => /hosts/.test(p)));
  assert.ok(bad({ keyPattern: '([' }).some(p => /keyPattern/.test(p)));
  assert.ok(bad({ defaultRequestOptions: { temperature: 0.7 } }).some(p => /sampling/.test(p)));
  assert.ok(bad({ errorMap: { codes: { x: 'made_up_kind' } } }).some(p => /unknown kind/.test(p)));
  assert.ok(bad({ adapter: 'nope' }).some(p => /adapter/.test(p)));
  assert.ok(bad({ baseUrl: `https://user:pw${AT}api.anthropic.com/v1` }).some(p => /credentials/.test(p)));
  assert.ok(bad({ local: true, baseUrl: 'http://192.168.1.5:11434', auth: null, keyPattern: null }).some(p => /loopback/.test(p)));
  assert.ok(bad({ effortAlt: {} }).some(p => /effortAlt needs an altAdapter/.test(p)));
  const x = structuredClone(getManifest('xai'));
  assert.ok(validateManifest({ ...x, effortAlt: { 'grok-4.7': { low: { reasoning_effort: 'low', store: true } } } }).some(p => /effortAlt grok-4\.7\.low may not set store/.test(p)));
  assert.ok(validateManifest({ ...x, defaultRequestOptionsAlt: { top_p: 1 } }).some(p => /sampling/.test(p)));
});

test('pickProviderForKey routes by shape: sk-ant- (any kind) before generic sk-, AQ. and AIza for Gemini, nothing to Other', () => {
  assert.deepEqual(pickProviderForKey(CANARY.anthropic), { id: 'anthropic', hidden: false });
  assert.equal(pickProviderForKey(CANARY.openrouter).id, null, 'an OpenRouter key connects through Other, never by its shape');
  assert.deepEqual(pickProviderForKey(CANARY.openai), { id: 'openai', hidden: false });
  assert.deepEqual(pickProviderForKey('sk-svcacct-' + 'A'.repeat(40)), { id: 'openai', hidden: false });
  assert.deepEqual(pickProviderForKey('sk-' + 'a1'.repeat(24)), { id: 'openai', hidden: false }, 'legacy sk-');
  assert.deepEqual(pickProviderForKey(CANARY.xai), { id: 'xai', hidden: false });
  assert.deepEqual(pickProviderForKey(`AIza${'C'.repeat(35)}`), { id: 'google', hidden: false });
  assert.deepEqual(pickProviderForKey(`AIzaSy${'a1_-'.repeat(8)}a`), { id: 'google', hidden: false });
  assert.equal(pickProviderForKey(`AIza${'C'.repeat(34)}`).id, null, 'a Google key is 39 characters');
  // Google AI Studio issues Auth keys (AQ.Ab…) since 2026-05-28; Standard AIza keys stopped working in September.
  assert.deepEqual(pickProviderForKey(`AQ.Ab${'C'.repeat(40)}`), { id: 'google', hidden: false }, 'an Auth key');
  assert.equal(pickProviderForKey('AQ.short').id, null, 'too short for a key');
  assert.deepEqual(pickProviderForKey(`sk-ant-usr-${'a1'.repeat(30)}`), { id: 'anthropic', hidden: false }, 'any sk-ant- kind goes to Anthropic\'s test');
  assert.deepEqual(pickProviderForKey(`  ${CANARY.anthropic}\n`), { id: 'anthropic', hidden: false }, 'whitespace from a paste');
});

test('pickProviderForKey refuses admin keys and unknown shapes', () => {
  assert.deepEqual(pickProviderForKey('sk-admin-' + 'x'.repeat(40)), { id: null, reason: 'admin_key', provider: 'openai' });
  assert.deepEqual(pickProviderForKey('sk-ant-admin01-' + 'x'.repeat(40)), { id: null, reason: 'admin_key', provider: 'anthropic' });
  assert.equal(pickProviderForKey('hello there').id, null);
  assert.equal(pickProviderForKey('').reason, 'empty');
  assert.equal(pickProviderForKey('sk-ant-short').id, null, 'too short for any shape');
  assert.equal(pickProviderForKey(null).id, null);
});

// A shipped manifest with a patch, through the schema: {m} the patched one when it passes, else the
// shipped one, and {warnings} the schema's problems (as {id, reason}).
const override = (id, patch) => {
  const candidate = { ...structuredClone(getManifest(id)), ...structuredClone(patch) };
  const problems = validateManifest(candidate);
  return { m: problems.length ? getManifest(id) : candidate, warnings: problems.map(reason => ({ id, reason })) };
};
const levels = (frag) => ({ low: frag, medium: frag, high: frag });

test('an effort map can\'t change privacy defaults: data_collection, store and num_ctx are refused (PV-4)', () => {
  const g = override('google', { effort: { 'gemini-3': levels({ provider: { data_collection: 'allow' }, reasoning_effort: 'low' }) } });
  assert.deepEqual(g.m.effort, getManifest('google').effort, 'the shipped effort map stays');
  assert.ok(g.warnings.some(w => w.id === 'google' && /may not set provider\.data_collection/.test(w.reason)));
  const gs = override('google', { effort: { 'gemini-3': levels({ reasoning_effort: 'low', store: true }) } });
  assert.deepEqual(gs.m.effort, getManifest('google').effort);
  assert.ok(gs.warnings.some(w => /may not set store/.test(w.reason)));
  const oa = override('openai', { effort: { 'gpt-6': levels({ reasoning: { effort: 'low' }, store: true }), 'gpt-6-luna': levels({ reasoning: { effort: 'none' } }) } });
  assert.ok(oa.warnings.some(w => /may not set store/.test(w.reason)));
  assert.deepEqual(oa.m.effort, getManifest('openai').effort);
  const an = override('anthropic', { effort: { 'claude-sonnet-5': levels({ output_config: { effort: 'low' }, temperature: 1 }) } });
  assert.ok(an.warnings.some(w => /may not set temperature/.test(w.reason)));
  const nested = override('xai', { effort: { 'grok-4.7': levels({ reasoning: { effort: { nested: 1 } } }) } });
  assert.ok(nested.warnings.some(w => /may not set reasoning\.effort\.nested/.test(w.reason)));
  for (const value of [['low'], null]) {
    const shape = override('google', { effort: { 'gemini-3': levels({ reasoning_effort: value }) } });
    assert.ok(shape.warnings.some(w => /must be a string, number or boolean/.test(w.reason)), JSON.stringify(value));
    assert.deepEqual(shape.m.effort, getManifest('google').effort);
  }
});

test('an effort map that stays within the adapter\'s effort fields passes the schema', () => {
  const { m, warnings } = override('google', { effort: { 'gemini-3': { low: { reasoning_effort: 'minimal' }, medium: { reasoning_effort: 'low' }, high: { reasoning_effort: 'high' } } } });
  assert.deepEqual(warnings, []);
  assert.equal(effortFragment(m, 'gemini-3.8-flash', 'low').reasoning_effort, 'minimal');
  assert.deepEqual(Object.keys(EFFORT_FIELDS).sort(), Object.keys(ADAPTERS).sort(), 'every adapter lists its effort fields');
});

test('the adapters apply the manifest defaults over any effort fragment (a second guard behind the schema)', async () => {
  const cases = [
    ['google', 'gemini-3.8-flash', 'success.sse', { 'gemini-3': levels({ reasoning_effort: 'low' }) }, (b) => assert.equal(b.reasoning_effort, 'low')],
    ['openai', 'gpt-6-sol', 'success.sse', { 'gpt-6': levels({ store: true }) }, (b) => assert.equal(b.store, false)],
    ['xai', 'grok-4.7', 'success.sse', { 'grok-4.7': levels({ store: true }) }, (b) => assert.equal(b.store, false)],
  ];
  for (const [id, model, name, effort, check] of cases) {
    const mock = await serveOne(fixture(id, name));
    try {
      const { manifest } = mockProvider(id, mock.url);
      const provider = createProvider({ ...manifest, effort }, { getKey: async () => CANARY[id] ?? null });
      await collect(provider.stream(req(model, { effort: 'low' })));
      check(mock.requests[0].body);
    } finally { await mock.close(); }
  }
});

test('links the desktop app opens must be https URLs', () => {
  for (const bad of ['http://aistudio.google.com/apikey', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', `https://user:pw${AT}aistudio.google.com/`, 7]) {
    const { m, warnings } = override('google', { links: { keys: bad, verified: true } });
    assert.equal(m.links.keys, 'https://aistudio.google.com/apikey', String(bad));
    assert.ok(warnings.some(w => /links\.keys must be an https URL/.test(w.reason)), String(bad));
  }
  assert.ok(override('google', { links: { verified: 'yes' } }).warnings.some(w => /links\.verified/.test(w.reason)));
  assert.equal(override('google', { links: { keys: 'https://aistudio.google.com/app/apikey', verified: true } }).m.links.keys, 'https://aistudio.google.com/app/apikey');
});

test('withQuery sets one parameter and keeps the rest', () => {
  assert.equal(withQuery('/models', 'after_id', 'a'), '/models?after_id=a');
  assert.equal(withQuery('/models?limit=1000', 'after_id', 'a'), '/models?limit=1000&after_id=a');
  assert.equal(withQuery('/models?limit=1000&after_id=a', 'after_id', 'b'), '/models?limit=1000&after_id=b');
  assert.equal(withQuery('/models?after_id=a&limit=5', 'after_id', 'b'), '/models?after_id=b&limit=5');
  assert.equal(withQuery('/models', 'pageToken', 'a/b+c'), '/models?pageToken=a%2Fb%2Bc');
});

test('a bundled manifest that fails the schema throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-manifests-'));
  const m = structuredClone(getManifest('anthropic'));
  m.baseUrl = 'http://insecure.example';
  fs.writeFileSync(path.join(dir, 'anthropic.json'), JSON.stringify(m));
  try { assert.throws(() => loadManifests({ dir }), /manifest anthropic/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('modelAvailable: dated snapshots count for their alias, other suffixes do not', () => {
  assert.ok(modelAvailable('claude-haiku-4-5', ['claude-haiku-4-5-20251001']));
  assert.ok(!modelAvailable('claude-sonnet-5', ['claude-sonnet-5-1']));
  assert.ok(modelAvailable('qwen3', ['qwen3:latest']));
  assert.ok(!modelAvailable('gpt-6-luna', []));
});

test('resolveModel falls back only to an equal or cheaper model in the same provider (§10, PV-3)', () => {
  const a = getManifest('anthropic');
  assert.deepEqual(resolveModel(a, ['claude-sonnet-5', 'claude-haiku-4-5-20251001'], 'claude-sonnet-5'), { model: 'claude-sonnet-5', switched: false });
  assert.deepEqual(resolveModel(a, ['claude-haiku-4-5-20251001'], 'claude-sonnet-5'), { model: 'claude-haiku-4-5', switched: true, from: 'claude-sonnet-5', by: 'cost' });
  assert.deepEqual(resolveModel(a, ['claude-sonnet-5'], 'claude-haiku-4-5'), { model: null, reason: 'retired' }, 'never up to a pricier model');
  assert.deepEqual(resolveModel(getManifest('custom'), ['qwen/qwen3-8b'], null), { model: 'qwen/qwen3-8b', switched: false });
  assert.deepEqual(resolveModel(getManifest('google'), ['gemini-3.1-flash-lite'], 'some/unknown'), { model: null, reason: 'retired' });
});

test('resolveModel takes the entry\'s named replacement first (replacedBy), never a dearer one', () => {
  const m = {
    models: { default: 'mid', list: [
      { id: 'top', costRank: 3 }, { id: 'mid', costRank: 2, replacedBy: 'low' }, { id: 'mid2', costRank: 2 }, { id: 'low', costRank: 1 },
      { id: 'cheap', costRank: 1, replacedBy: 'top' },
    ] },
  };
  assert.deepEqual(resolveModel(m, ['top', 'mid2', 'low'], 'mid'), { model: 'low', switched: true, from: 'mid', by: 'replacement' });
  assert.deepEqual(resolveModel(m, ['top', 'mid2'], 'mid'), { model: 'mid2', switched: true, from: 'mid', by: 'cost' }, 'the replacement gone: the nearest no dearer');
  assert.deepEqual(resolveModel(m, ['top'], 'cheap'), { model: null, reason: 'retired' }, 'a replacement dearer than the model is never taken');
});

test('provider ids live in the manifests alone (SY-14): the desktop app derives its ids, names, local set and links; nothing else keeps a list', async () => {
  const { PROVIDER_IDS, PROVIDER_NAMES, LINK_IDS, LINKS } = await import('../../app/desktop/ipc.mjs');
  const { providerIds, providerLinks } = await import('../../bridge/byok/providers/index.mjs');
  const visible = loadManifests().filter(m => !m.hidden);
  assert.deepEqual([...PROVIDER_IDS], providerIds(visible));
  for (const m of visible) {
    assert.equal(PROVIDER_NAMES[m.id], m.name);
    for (const kind of Object.keys(m.links).filter(k => k !== 'verified')) assert.ok(LINK_IDS.includes(`${m.id}.${kind}`), `${m.id}.${kind}`);
  }
  for (const [id, url] of Object.entries(providerLinks(visible))) {
    if (url.includes('{hash}')) assert.equal(LINKS[id], undefined, `${id} is filled in main from a checked hash`);
    else assert.equal(LINKS[id], url, id);
  }
  for (const m of visible.filter(x => !x.local && !x.custom && !x.auth?.signIn)) for (const k of ['keys', 'billing', 'limits', 'privacy', 'terms']) assert.ok(m.links[k], `${m.id}.${k}`);
  // A plan that signs in has no key or billing page: its plans, its usage, its privacy and terms.
  for (const m of visible.filter(x => x.auth?.signIn)) for (const k of ['plans', 'usage', 'privacy', 'terms']) assert.ok(m.links[k], `${m.id}.${k}`);
  assert.deepEqual(Object.keys(getManifest('custom').links), ['verified'], 'Other\'s service has no pages the app knows');
  // No other hand-kept list of the AIs in what ships (the mock and its screenshots are development only).
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // a URL's pathname isn't a Windows path
  const files = ['app/desktop/ipc.mjs', 'app/desktop/main.mjs', 'app/desktop/src/api-loader.mjs', 'app/desktop/src/status-text.mjs', 'app/desktop/renderer/app.js', 'app/desktop/renderer/format.js',
    'bridge/byok/app-api.mjs', 'bridge/byok/boot.mjs', 'bridge/byok/security/keystore.mjs', 'bridge/byok/security/redact.mjs'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.doesNotMatch(text, /\[[^\]]*'anthropic'[^\]]*'(?:openai|google|xai)'/, f);
  }
});
