// The slot contract's bridge half (BUILD-PLAN "Contract: what the addon reads"; public BYOK PRD
// §9.4, §10, §13.1, §16.4 UX-4/UX-6, PR-1, TH13): the local backend's per-chat fields (chatSlot:
// model, modelName, effortSupported, effort), setChatModel for /nqa model, the id a
// reply's usage.model names, setConfig making the core publish, boot's privacy wrapper (usage.autoOn,
// bridge.echo), the core putting chatSlot into chats[] and taking a model patch, the slot head's
// budget, and the core's side of the backend seam (the raw turn it hands the backend, the lines that
// name it, an older addon's upd acked, event args as game text). Against the providers' mock server on
// 127.0.0.1 with canary keys, or a backend stand-in; no real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, BRIDGE_VERSION } from '../../bridge/service.mjs';
import { installSlots } from '../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { slotTable, HEAD_BYTES_MAX } from '../../bridge/transport/luaenc.mjs';
import { createLocalBackend, modelOffered, MODEL_ID_RE } from '../../bridge/byok/backend.mjs';
import { withPrivacy } from '../../bridge/byok/boot.mjs';
import { loadManifests } from '../../bridge/byok/providers/index.mjs';
import { fixture } from './helpers/mock-provider.mjs';
import {
  startMock, reply, makeBackend, canaryKeystore, sendParams, waitFor, sleep, tmpDir, manifestsAt, NO_CHECKS,
} from './helpers/byok-env.mjs';

const CHAT = 'c3f9a1e';
const CHAT2 = 'c4b2d0f';
const posts = mock => mock.requests.filter(r => r.method === 'POST');

async function started(opts) {
  const env = makeBackend(opts);
  await env.backend.start();
  return env;
}

test('chatSlot: a chat on the provider\'s model has no model of its own; its effort is its think level, else the player\'s, as the model\'s nearest level; none where the model has none', async () => {
  const sonnet = await started({ keystore: await canaryKeystore(), config: { model: 'claude-sonnet-5', effort: 'medium' } });
  const haiku = await started({ keystore: await canaryKeystore(), config: { model: 'claude-haiku-4-5', effort: 'medium' } });
  const none = await started({ keystore: await canaryKeystore(), config: { model: 'claude-sonnet-5', effort: null } });
  const grok = await started({ keystore: await canaryKeystore(), config: { provider: 'xai', model: 'grok-4.20-0309-non-reasoning', effort: 'medium' } });
  try {
    assert.deepEqual(sonnet.backend.chatSlot(CHAT), { effortSupported: true, effort: 'medium' });
    assert.deepEqual(sonnet.backend.chatSlot(CHAT, { think: 'high' }), { effortSupported: true, effort: 'high' });
    assert.deepEqual(sonnet.backend.chatSlot(CHAT, { think: 'ludicrous' }), { effortSupported: true, effort: 'medium' }, 'not a level: the player\'s');
    // fix-102: every level is one; a level the model hasn't is its nearest (the next one up, else its highest).
    assert.deepEqual(sonnet.backend.chatSlot(CHAT, { think: 'max' }), { effortSupported: true, effort: 'max' });
    assert.deepEqual(sonnet.backend.chatSlot(CHAT, { think: 'minimal' }), { effortSupported: true, effort: 'low' }, 'Sonnet 5 has no Minimal');
    assert.deepEqual(haiku.backend.chatSlot(CHAT, { think: 'high' }), { effortSupported: true, effort: 'high' }, 'Haiku 4.5 has thinking budgets now');
    assert.deepEqual(none.backend.chatSlot(CHAT), { effortSupported: true }, 'the player chose none');
    assert.deepEqual(none.backend.chatSlot(CHAT, { think: 'low' }), { effortSupported: true, effort: 'low' }, 'a chat\'s own level still goes');
    assert.deepEqual(grok.backend.chatSlot(CHAT, { think: 'high' }), { effortSupported: false }, 'Grok 4.20 without thinking has no levels');
    // The provider's view agrees with a chat on the provider's model, and carries the model's levels
    // (a chat on it has no list of its own: the slot head stays small).
    const p = sonnet.backend.slotExtras().bridge.provider;
    assert.deepEqual([p.model, p.modelName, p.effort, p.effortSupported, p.efforts], ['claude-sonnet-5', 'Claude Sonnet 5', 'medium', true, 'off low medium high xhigh max']);
    assert.equal(grok.backend.slotExtras().bridge.provider.efforts, undefined);
  } finally { await sonnet.backend.stop(); await haiku.backend.stop(); await none.backend.stop(); await grok.backend.stop(); }
});

test('setChatModel: an id the provider offers becomes the chat\'s own (kept on disk); one it doesn\'t, or a key, changes nothing; default clears it', async () => {
  const keystore = await canaryKeystore();
  const env = await started({ keystore, config: { model: 'claude-sonnet-5', effort: 'low' } });
  try {
    const b = env.backend;
    const changes = env.changes.length;
    assert.deepEqual(b.setChatModel(CHAT, 'claude-haiku-4-5'), { ok: true, model: 'claude-haiku-4-5' });
    assert.equal(env.changes.length, changes, 'the core publishes after its patch itself');
    // A chat's own model carries its own levels (fix-102): Haiku 4.5's thinking budgets.
    assert.deepEqual(b.chatSlot(CHAT, { think: 'high' }), { model: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5', effortSupported: true, efforts: 'off minimal low medium high xhigh max', effort: 'high' });
    assert.deepEqual(b.chatSlot(CHAT2), { effortSupported: true, effort: 'low' }, 'another chat keeps the provider\'s');
    assert.deepEqual(b.setChatModel(CHAT2, 'gpt-9'), { ok: false, error: 'unknown_model' });
    assert.deepEqual(b.chatSlot(CHAT2), { effortSupported: true, effort: 'low' }, 'nothing changed');
    assert.equal(b.setChatModel(CHAT2, 'sk-ant-api03-' + 'x'.repeat(60)).error, 'bad_model');
    assert.equal(b.setChatModel(CHAT2, 'has space').error, 'bad_model');
    // Kept in byok-chats.json with its provider: a new run has it.
    const side = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'byok-chats.json'), 'utf8'));
    assert.deepEqual([side.chats[CHAT].model, side.chats[CHAT].modelProvider], ['claude-haiku-4-5', 'anthropic']);
    await b.stop();
    const again = await started({ keystore, dataDir: env.dataDir, config: { model: 'claude-sonnet-5' } });
    assert.equal(again.backend.chatSlot(CHAT).model, 'claude-haiku-4-5');
    // default (or null) goes back to the provider's.
    assert.deepEqual(again.backend.setChatModel(CHAT, 'default'), { ok: true, model: null });
    assert.equal(again.backend.chatSlot(CHAT).model, undefined);
    again.backend.setChatModel(CHAT, 'claude-haiku-4-5');
    assert.deepEqual(again.backend.setChatModel(CHAT, null), { ok: true, model: null });
    // Forgetting the chat forgets its own model.
    again.backend.setChatModel(CHAT, 'claude-haiku-4-5');
    assert.equal(again.backend.chatSlot(CHAT).model, 'claude-haiku-4-5');
    again.backend.forget(CHAT);
    assert.equal(again.backend.chatSlot(CHAT).model, undefined);
    await again.backend.stop();
  } finally { await env.backend.stop(); }
});

test('modelOffered: listed ids, or any id where the manifest allows any (Other: the player\'s own service)', () => {
  const byId = Object.fromEntries(loadManifests().map(m => [m.id, m]));
  assert.equal(modelOffered(byId.anthropic, 'claude-haiku-4-5'), true);
  assert.equal(modelOffered(byId.anthropic, 'claude-9'), false);
  assert.equal(modelOffered(byId.google, 'gemini-3.8-flash'), true);
  assert.equal(modelOffered(byId.custom, 'anthropic/claude-haiku-4.5'), true);
  assert.equal(modelOffered(byId.custom, 'llama3.3:70b'), true);
  assert.equal(modelOffered(byId.custom, 'no spaces allowed'), false);
  assert.ok(MODEL_ID_RE.test('meta-llama/llama-3.3-70b-instruct:free'));
  assert.ok(!MODEL_ID_RE.test('x'.repeat(81)));
});

test('a chat\'s own model: its turns go to it and its replies\' usage.model name it; other chats keep the provider\'s; the dated alias a provider answers with never becomes usage.model', async () => {
  const mock = await startMock((r) => {
    const out = reply('Sure.\n\nTL;DR: sure.', { input: 1000, output: 40 });
    return { ...out, body: out.body.replace('"model":"claude-haiku-4-5"', `"model":"${r.body.model}-20251001"`) };
  });
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), config: { model: 'claude-sonnet-5', effort: 'high' } });
  try {
    const b = env.backend;
    await b.send(sendParams(CHAT, 'a3f1_1', 'first', { thinking: 'low' }));
    let fin = await waitFor(() => env.chats('final')[0], 5000, 'first final');
    assert.equal(posts(mock)[0].body.model, 'claude-sonnet-5');
    assert.equal(posts(mock)[0].body.output_config?.effort, 'low', 'the chat\'s level, as chatSlot said');
    assert.equal(fin.usage.model, 'claude-sonnet-5', 'the id asked for, not claude-sonnet-5-20251001');
    b.setChatModel(CHAT, 'claude-haiku-4-5');
    await b.send(sendParams(CHAT, 'a3f1_2', 'second', { thinking: 'low' }));
    fin = await waitFor(() => env.chats('final')[1], 5000, 'second final');
    assert.equal(posts(mock)[1].body.model, 'claude-haiku-4-5');
    assert.equal(posts(mock)[1].body.output_config, undefined, 'Haiku takes no effort field');
    assert.deepEqual(posts(mock)[1].body.thinking, { type: 'enabled', budget_tokens: 2048 }, 'the chat\'s Low: Haiku\'s thinking budget (fix-102)');
    assert.equal(posts(mock)[1].body.max_tokens, 1200 + 2048);
    assert.equal(fin.usage.model, 'claude-haiku-4-5');
    await b.send(sendParams(CHAT2, 'a3f1_3', 'third'));
    fin = await waitFor(() => env.chats('final')[2], 5000, 'third final');
    assert.equal(posts(mock)[2].body.model, 'claude-sonnet-5', 'another chat: the provider\'s');
    assert.equal(fin.usage.model, 'claude-sonnet-5');
    // The transcript keeps each reply's usage.model as it went.
    assert.deepEqual(b.transcripts.rows(CHAT, 10).filter(r => r.role === 'assistant').map(r => r.usage.model), ['claude-sonnet-5', 'claude-haiku-4-5']);
    // The last request view names the chat's model.
    assert.equal(b.lastRequest(CHAT).model, 'claude-haiku-4-5');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('a chat\'s own model the provider answers model_not_found: the chat goes back to the provider\'s model, the line names both, the slot changes', async () => {
  const mock = await startMock(r => (r.body.model === 'claude-haiku-4-5' ? fixture('anthropic', 'http-404-not-found.json') : reply('Fine.\n\nTL;DR: fine.')));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), config: { model: 'claude-sonnet-5' } });
  try {
    const b = env.backend;
    b.setChatModel(CHAT, 'claude-haiku-4-5');
    const changes = env.changes.length;
    await b.send(sendParams(CHAT, 'a3f1_1', 'hi'));
    const e = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.equal(e.errorKind, 'model_not_found');
    assert.equal(e.action, 'desktop');
    assert.equal(e.errorMessage, "Claude Haiku 4.5 isn't available on your Anthropic account. Switched to Claude Sonnet 5 for now. Change it in the NeverQuestAlone app.");
    assert.equal(b.chatSlot(CHAT).model, undefined, 'back on the provider\'s model');
    assert.ok(env.changes.length > changes, 'the core publishes the change');
    assert.equal(b.status().notice, null, 'the provider\'s model isn\'t in question');
    await b.send(sendParams(CHAT, 'a3f1_2', 'again'));
    await waitFor(() => env.chats('final')[0], 5000, 'the next turn');
    assert.equal(posts(mock).at(-1).body.model, 'claude-sonnet-5');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('setConfig: the core publishes again (onChange); another provider drops every chat\'s own model', async () => {
  const keystore = await canaryKeystore(['anthropic', 'openai']);
  const env = await started({ keystore, config: { model: 'claude-sonnet-5' } });
  try {
    const b = env.backend;
    b.setChatModel(CHAT, 'claude-haiku-4-5');
    let n = env.changes.length;
    await b.setConfig({ privacy: { identity: true } });
    assert.ok(env.changes.length > n, 'a privacy change publishes (boot\'s wrapper reads autoOn and echo then)');
    assert.equal(env.changes.at(-1).push, true, 'and rings the push doorbell: the addon reads a slot only then (C3 review)');
    assert.equal(b.chatSlot(CHAT).model, 'claude-haiku-4-5', 'the same provider: kept');
    n = env.changes.length;
    await b.setConfig({ effort: 'high' });
    assert.ok(env.changes.length > n);
    assert.equal(b.chatSlot(CHAT2).effort, 'high');
    await b.setConfig({ provider: 'openai', model: 'gpt-5-mini' });
    assert.equal(b.chatSlot(CHAT).model, undefined, 'its ids were Anthropic\'s');
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.dataDir, 'byok-chats.json'), 'utf8')).chats[CHAT], undefined, 'nothing of it kept');
  } finally { await env.backend.stop(); }
});

test('withPrivacy (boot): bridge.usage.autoOn is the app\'s companion switch and bridge.echo its echo switch, read at every publish; the echo cap once', async () => {
  const env = await started({ keystore: await canaryKeystore() });
  try {
    const privacy = { companion: false, echo: false };
    const w = withPrivacy(env.backend, () => privacy);
    let x = w.slotExtras();
    assert.equal(x.bridge.usage.autoOn, false);
    assert.equal(x.bridge.echo, 'off');
    assert.equal(x.bridge.caps.filter(c => c === 'echo').length, 1);
    assert.equal(x.bridge.usage.spentMicros, 0, 'the backend\'s usage fields stay');
    privacy.companion = true;
    privacy.echo = true;
    x = w.slotExtras();
    assert.equal(x.bridge.usage.autoOn, true);
    assert.equal(x.bridge.echo, 'on');
    assert.equal(typeof w.chatSlot, 'function', 'chatSlot passes through');
    assert.deepEqual(w.chatSlot(CHAT), env.backend.chatSlot(CHAT));
    // A privacy function that throws or gives nothing: both off.
    x = withPrivacy(env.backend, () => { throw new Error('no'); }).slotExtras();
    assert.deepEqual([x.bridge.usage.autoOn, x.bridge.echo], [false, 'off']);
  } finally { await env.backend.stop(); }
});

// ---------------------------------------------------------------- the core

const TOKEN = '3fa9c2d1';
const nonce = 'a3f1';
let n = 0;
const rec = (type, chat, args = {}, extra = {}) => encodeRecord({ token: TOKEN, key: type === 'hello' ? nonce : `${nonce}_${++n}`, type, chat: type === 'hello' ? '' : chat, args: { cur: 0, ...args }, ...extra });
const hello = () => rec('hello', '', { ver: '1.4.0', build: '70009', iface: '16001', n: 0, ctx: 0, sig: 'ok', slots: 2, sid: 'a1b2c3d4e5f60718' });
const patch = (chat, args) => rec('patch', chat, { agent: 'main', ...args });
const msg = (chat, text) => rec('msg', chat, { agent: 'main', name: 'Route', ctx: 0, q: 'followup' }, { text });

function coreOn(gatewayFactory, config = {}) {
  const tmp = tmpDir('nqa-contract-core-');
  const addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  installSlots(addons, { count: 2, iface: '16001' });
  const lines = [];
  const bridge = createBridge({ transport: { slots: 2 }, ...config }, {
    stateDir: path.join(tmp, 'state'), addonsDir: addons, log: (kind, data) => lines.push({ kind, ...data }),
    publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 30, alive: 25, act: 5 }, actGapMs: 5 },
    gatewayFactory,
  });
  bridge.lines = lines;
  return bridge;
}

test('core: chats[] carries the backend\'s chatSlot fields (only the contract\'s, plain values); a /nqa model patch goes to setChatModel; a refusal is the model_not_found line', async () => {
  const mock = await startMock(() => reply('Ok.\n\nTL;DR: ok.'));
  const keystore = await canaryKeystore();
  const dataDir = tmpDir('nqa-contract-data-');
  let backend = null;
  const bridge = coreOn((h) => {
    backend = createLocalBackend(h, { config: { byok: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' } }, dataDir, keystore, manifests: manifestsAt(mock.url), checks: NO_CHECKS });
    return backend;
  });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', 3000, 'ready');
    bridge.handlePayload(hello());
    bridge.handlePayload(patch(CHAT, { think: 'high' }));
    await sleep(20);
    let c = bridge.buildSlot().chats.find(x => x.id === CHAT);
    assert.deepEqual({ think: c.think, effort: c.effort, effortSupported: c.effortSupported, model: c.model, efforts: c.efforts }, { think: 'high', effort: 'high', effortSupported: true, model: undefined, efforts: undefined });
    assert.equal(bridge.buildSlot().bridge.provider.efforts, 'off low medium high xhigh max', 'the provider\'s model\'s levels, once');
    assert.equal(c.key, undefined, 'no session keys (RT-10)');
    bridge.handlePayload(patch(CHAT, { model: 'claude-haiku-4-5' }));
    await waitFor(() => bridge.buildSlot().chats.find(x => x.id === CHAT)?.model === 'claude-haiku-4-5', 2000, 'the model in chats[]');
    c = bridge.buildSlot().chats.find(x => x.id === CHAT);
    assert.deepEqual({ modelName: c.modelName, effortSupported: c.effortSupported, efforts: c.efforts, effort: c.effort }, { modelName: 'Claude Haiku 4.5', effortSupported: true, efforts: 'off minimal low medium high xhigh max', effort: 'high' }, 'its own model\'s levels (fix-102)');
    assert.ok(bridge.buildSlot().bridge.acked.includes(`${nonce}_${n}`), 'the patch is acked');
    // The next message goes to it.
    bridge.handlePayload(msg(CHAT, 'hi'));
    await waitFor(() => bridge.buildSlot().records.some(r => r.t === 'reply'), 5000, 'the reply');
    assert.equal(posts(mock).at(-1).body.model, 'claude-haiku-4-5');
    assert.equal(bridge.buildSlot().records.find(r => r.t === 'reply').usage.model, 'claude-haiku-4-5');
    // One the provider doesn't offer: the model_not_found line (the addon ends its "asked for"), nothing changed.
    bridge.handlePayload(patch(CHAT, { model: 'gpt-9' }));
    const e = await waitFor(() => bridge.buildSlot().records.find(r => r.t === 'error'), 2000, 'the refusal');
    assert.deepEqual({ kind: e.kind, action: e.action, text: e.text }, { kind: 'model_not_found', action: 'none', text: "gpt-9 isn't one of the Anthropic models you can pick. Nothing was changed. See them in the NeverQuestAlone app." });
    assert.equal(bridge.buildSlot().chats.find(x => x.id === CHAT).model, 'claude-haiku-4-5');
    // default: the provider's again; junk and key-shaped ids are never sent to the backend.
    bridge.handlePayload(patch(CHAT, { model: 'DEFAULT' }));
    await waitFor(() => bridge.buildSlot().chats.find(x => x.id === CHAT)?.model === undefined, 2000, 'back to the provider\'s');
    bridge.handlePayload(patch(CHAT, { model: 'rm -rf' }));
    bridge.handlePayload(patch(CHAT, { model: 'sk-ant-api03-' + 'y'.repeat(60) }));
    await sleep(30);
    assert.equal(bridge.lines.filter(l => l.kind === 'model-invalid').length, 2);
    assert.ok(!JSON.stringify(bridge.lines).includes('yyyyyyyyyy'), 'never logged');
    // No version pin: nothing warns.
    assert.equal(bridge.buildSlot().bridge.warn, undefined);
  } finally { await bridge.stop(); await mock.close(); }
});

test('core: a backend without chatSlot adds nothing to chats[] and ignores a model patch; junk chatSlot fields are dropped', async () => {
  const requests = [];
  const handlers = {};
  const fake = extra => (h) => {
    Object.assign(handlers, h);
    return {
      ...extra,
      start() { setImmediate(() => { h.onState({ state: 'ready', since: Date.now(), reason: null }); h.onReady(); }); },
      stop() {},
      send: (args) => { requests.push({ method: 'send', params: args }); return { runId: args.idem, status: 'started' }; },
      setChatModel: (chatId, model) => { requests.push({ method: 'setChatModel', params: { chatId, model } }); return { ok: true, model }; },
      outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
    };
  };
  const oc = coreOn(fake({}));
  try {
    oc.start();
    await waitFor(() => oc.status().gateway.state === 'ready', 3000, 'ready');
    oc.handlePayload(hello());
    oc.handlePayload(patch(CHAT, { think: 'low', model: 'gpt-5' }));
    await sleep(30);
    const c = oc.buildSlot().chats.find(x => x.id === CHAT);
    assert.deepEqual(Object.keys(c).filter(k => ['model', 'modelName', 'effortSupported', 'efforts', 'effort'].includes(k)), []);
    assert.equal(requests.filter(r => r.method === 'setChatModel').length, 0, 'no model patch to such a backend');
    assert.ok(oc.lines.some(l => l.kind === 'model-unsupported'));
    assert.equal(oc.buildSlot().bridge.warn, undefined, 'no version pin: nothing warns');
  } finally { await oc.stop(); }
  const junk = coreOn(fake({ chatSlot: () => ({ model: 7, modelName: 'X'.repeat(200), effortSupported: 'yes', efforts: ['low', 'high'], effort: 'high', extra: { a: 1 } }) }));
  try {
    junk.start();
    await waitFor(() => junk.status().gateway.state === 'ready', 3000, 'ready');
    junk.handlePayload(hello());
    junk.handlePayload(patch(CHAT, { think: 'low' }));
    await sleep(30);
    const c = junk.buildSlot().chats.find(x => x.id === CHAT);
    assert.equal(c.model, undefined);
    assert.equal(c.modelName.length, 80);
    assert.equal(c.effortSupported, undefined);
    assert.equal(c.efforts, undefined, 'a list that isn\'t the contract\'s string is dropped');
    assert.equal(c.effort, 'high');
    assert.equal(c.extra, undefined);
  } finally { await junk.stop(); }
  const throws = coreOn(fake({ chatSlot: () => { throw new Error('boom'); } }));
  try {
    throws.start();
    await waitFor(() => throws.status().gateway.state === 'ready', 3000, 'ready');
    throws.handlePayload(hello());
    throws.handlePayload(patch(CHAT, { think: 'low' }));
    await sleep(30);
    assert.equal(throws.buildSlot().chats.find(x => x.id === CHAT).think, 'low', 'the slot is still built');
  } finally { await throws.stop(); }
});

test('luaenc: a slot head over its 8 KB drops chats[].modelName after the progress titles (the addon shows the id)', () => {
  const chats = Array.from({ length: 40 }, (_, i) => ({ id: `c${String(i).padStart(6, '0')}`, agent: 'main', label: `Chat ${i}`, busy: false, queued: 0,
    model: 'meta-llama/llama-3.3-70b-instruct:free', modelName: 'Meta: Llama 3.3 70B Instruct (free) — a long display name', effortSupported: true, effort: 'high' }));
  const slot = { v: 2, ts: 't', now: 1, token: 'ab', bridge: {}, gw: {}, agents: [], chats, records: [] };
  const out = slotTable('NQA_SlotData', slot).text;
  const head = out.slice(0, out.indexOf('\trecords = {'));
  assert.ok(Buffer.byteLength(head) <= HEAD_BYTES_MAX, String(Buffer.byteLength(head)));
  assert.ok(!head.includes('modelName'));
  assert.ok(head.includes('model = "meta-llama/llama-3.3-70b-instruct:free"'));
  const few = slotTable('NQA_SlotData', { ...slot, chats: chats.slice(0, 3) }).text;
  assert.ok(few.includes('modelName = "Meta: Llama 3.3 70B Instruct (free)'), 'kept while it fits');
});

// ---------------------------------------------------------------- the public build's slot fields and first meeting

// A core on a fake backend (with kind: a provider's name and caps, as bridge/byok/backend.mjs gives
// them; without: a bare backend object) that answers send and keeps what it was sent; deps as the
// host (boot.mjs) gives them.
function coreWith({ kind = null, deps = {} } = {}) {
  const tmp = tmpDir('nqa-contract-pub-');
  const addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  installSlots(addons, { count: 2, iface: '16001' });
  const lines = [];
  const sent = [];
  const handlers = {};
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: path.join(tmp, 'state'), addonsDir: addons, log: (k, data) => lines.push({ kind: k, ...data }),
    publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 30, alive: 25, act: 5 }, actGapMs: 5 },
    gatewayFactory: (h) => {
      Object.assign(handlers, h);
      return {
        ...(kind ? { kind, displayName: 'Anthropic', slotExtras: () => ({ bridge: { caps: ['provider'] } }) } : {}),
        start() { setImmediate(() => { h.onState({ state: 'ready', since: Date.now(), reason: null }); h.onReady(); }); },
        stop() {},
        send: (args) => { sent.push(args); return { runId: args.idem, status: 'started' }; },
        outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
      };
    },
    ...deps,
  });
  const final = (args, text, id) => handlers.onEvent({ event: 'chat', payload: { state: 'final', chatId: args.chatId, runId: args.idem,
    message: { role: 'assistant', content: [{ type: 'text', text }], __nqa: { id } } } });
  return { bridge, lines, sent, final };
}
const introMsg = (chat, text) => rec('msg', chat, { agent: 'main', name: 'Quick questions', ctx: 0, q: 'followup', intro: 1 }, { text });
const WITH_CHIPS = 'There you are! A level 12 mage in Westfall.\n\n```wowchips\nRoute me to my quests\nWhat should I train?\n```\n\nTL;DR:\nHi.';

// The capture state (display DR-04, SY-20): one publisher, the watchdog (transport/capture-health.mjs),
// whose { state, since, cause? } the slot carries under cap capture. The host (boot) hands it the
// helper's lines; here the test does, on a watchdog that publishes a typed state at once.
const pubCapture = { captureHealth: { platform: 'win32', thresholds: { typedWaitMs: 0, accessLostWaitMs: 0 } } };

test('core: the slot names its backend (bridge.backend) and carries the watchdog\'s capture state under cap capture: { state, since, cause? }; a change rings once; minimized is never published; a host with no watchdog gives neither field nor cap', async () => {
  const pub = coreWith({ kind: 'byok', deps: pubCapture });
  try {
    pub.bridge.start();
    await waitFor(() => pub.bridge.status().gateway.state === 'ready', 3000, 'ready');
    let b = pub.bridge.buildSlot().bridge;
    assert.equal(b.backend, 'byok');
    assert.ok(b.caps.includes('capture') && b.caps.includes('provider'), b.caps.join(','));
    assert.deepEqual(Object.keys(b.capture), ['state', 'since']);
    assert.equal(b.capture.state, 'ok');
    assert.ok(Number.isInteger(b.capture.since) && Math.abs(b.capture.since - Date.now() / 1000) < 60, 'unix seconds');
    assert.equal(pub.bridge.status().capture.state, 'ok');
    // A minimized WoW is held: never in the slot, never rung (the legacy publisher put minimized there).
    await sleep(40);
    let push = pub.bridge.status().push;
    pub.bridge.onCaptureStatus({ connected: true });
    pub.bridge.onGame({ state: 'running', pid: 77 });
    pub.bridge.onCaptureError({ kind: 'window_minimized', message: 'World of Warcraft is minimized; restore it to keep chatting' });
    pub.bridge.captureHealth.tick();
    await sleep(40);
    assert.equal(pub.bridge.buildSlot().bridge.capture.state, 'ok');
    assert.equal(pub.bridge.status().push, push, 'nothing rung');
    // Blocked: published with its cause, and rung once.
    pub.bridge.onCaptureStatus({ error: null });
    pub.bridge.onCaptureError({ kind: 'capture_blocked_by_app', message: 'x' });
    pub.bridge.captureHealth.tick();
    await waitFor(() => pub.bridge.status().push > push, 2000, 'rung');
    b = pub.bridge.buildSlot().bridge;
    assert.deepEqual([b.capture.state, b.capture.cause], ['blocked', 'capture_blocked_by_app']);
    assert.ok(pub.lines.some(l => l.kind === 'capture-health' && l.from === 'ok' && l.to === 'blocked' && l.rung === true), 'and logged');
    await sleep(40);
    push = pub.bridge.status().push;
    pub.bridge.captureHealth.tick();
    await sleep(40);
    assert.equal(pub.bridge.status().push, push, 'once');
    // Cleared: ok, rung (the non-ok rang).
    pub.bridge.onCaptureStatus({ error: null });
    await waitFor(() => pub.bridge.status().push > push, 2000, 'the ok rung');
    assert.deepEqual(pub.bridge.buildSlot().bridge.capture, { state: 'ok', since: pub.bridge.buildSlot().bridge.capture.since });
  } finally { await pub.bridge.stop(); }
  const none = coreWith();
  try {
    none.bridge.start();
    await waitFor(() => none.bridge.status().gateway.state === 'ready', 3000, 'ready');
    const b = none.bridge.buildSlot().bridge;
    assert.equal(b.backend, 'byok', 'the backend named whatever the backend object says');
    assert.equal(b.capture, undefined);
    assert.deepEqual(b.caps, ['state', 'evt', 'think', 'z', 'ctx', 'qlog', 'voice'], 'the core\'s own caps');
    assert.equal(none.bridge.status().capture, null);
    assert.equal(none.bridge.captureHealth, null, 'a host that feeds the strip itself has no watchdog');
  } finally { await none.bridge.stop(); }
});

// CI 36349344668 found the legacy publisher's check comparing with the last slot built, which a publish
// that doesn't ring could carry first. The watchdog rings at the change itself: the slots built before it
// carry the old state, every one after the new.
test('core: a capture change is rung when it happens, whatever slots were built before or after it', async () => {
  const pub = coreWith({ kind: 'byok', deps: pubCapture });
  try {
    pub.bridge.start();
    await waitFor(() => pub.bridge.status().gateway.state === 'ready', 3000, 'ready');
    pub.bridge.buildSlot();
    await sleep(40);
    const push = pub.bridge.status().push;
    pub.bridge.onCaptureError({ kind: 'capture_unsupported', message: 'DXGI_ERROR_UNSUPPORTED' });
    pub.bridge.buildSlot(); // a slot built without a ring, before the watchdog's tick
    pub.bridge.captureHealth.tick();
    assert.deepEqual([pub.bridge.buildSlot().bridge.capture.state, pub.bridge.buildSlot().bridge.capture.cause], ['unsupported', 'capture_unsupported'], 'SY-24: its own state');
    await waitFor(() => pub.bridge.status().push > push, 2000, 'rung');
    assert.equal(pub.lines.filter(l => l.kind === 'capture-health' && l.to === 'unsupported').length, 1);
  } finally { await pub.bridge.stop(); }
});

test('core: the first meeting: the hello\'s locale reaches Say Hi\'s turn with intro; its reply carries exactly "What should I do next?"; the first reply is noted and intro is ignored after it; fr=1 is noted, never as a reply', async () => {
  const pub = coreWith({ kind: 'byok' });
  try {
    pub.bridge.start();
    await waitFor(() => pub.bridge.status().gateway.state === 'ready', 3000, 'ready');
    pub.bridge.handlePayload(rec('hello', '', { ver: '1.4.4', build: '70009', iface: '16001', n: 0, ctx: 0, sig: 'ok', slots: 2, sid: 'a1b2c3d4e5f60718', loc: 'deDE' }));
    pub.bridge.handlePayload(introMsg(CHAT, 'hi'));
    await waitFor(() => pub.sent.length === 1, 2000, 'sent');
    assert.equal(pub.sent[0].turn.intro, true);
    assert.equal(pub.sent[0].turn.loc, 'deDE');
    assert.equal(pub.bridge.status().first.replyAt, null);
    assert.equal(typeof pub.bridge.status().first.msgAt, 'number');
    pub.final(pub.sent[0], WITH_CHIPS, 'm-1');
    let r = pub.bridge.buildSlot().records.find(x => x.t === 'reply');
    assert.deepEqual(r.chips, ['What should I do next?'], 'exactly the one chip, whatever the model wrote (C-41)');
    assert.equal(typeof pub.bridge.status().first.replyAt, 'number');
    // A first reply exists: intro is ignored, the model's chips stand.
    pub.bridge.handlePayload(introMsg(CHAT, 'hi'));
    await waitFor(() => pub.sent.length === 2, 2000, 'sent 2');
    assert.equal(pub.sent[1].turn.intro, undefined);
    pub.final(pub.sent[1], WITH_CHIPS.replace('Westfall', 'Duskwood'), 'm-2');
    r = pub.bridge.buildSlot().records.filter(x => x.t === 'reply').at(-1);
    assert.deepEqual(r.chips, ['Route me to my quests', 'What should I train?']);
    // A plain message without intro never gets the rule, and a hello's fr=1 is only noted.
    pub.bridge.handlePayload(rec('hello', '', { ver: '1.4.4', build: '70009', iface: '16001', n: 0, ctx: 0, sig: 'ok', slots: 2, sid: 'a1b2c3d4e5f60718', loc: 'xx-YY', fr: 1 }));
    assert.equal(pub.bridge.status().first.replyBefore, true);
  } finally { await pub.bridge.stop(); }
  // A plain message on a fresh bridge: no intro, the model's chips; its reply is still the first.
  const plain = coreWith({ kind: 'byok' });
  try {
    plain.bridge.start();
    await waitFor(() => plain.bridge.status().gateway.state === 'ready', 3000, 'ready');
    plain.bridge.handlePayload(hello());
    plain.bridge.handlePayload(msg(CHAT, 'hi'));
    await waitFor(() => plain.sent.length === 1, 2000, 'sent');
    assert.equal(plain.sent[0].turn.intro, undefined);
    plain.final(plain.sent[0], WITH_CHIPS, 'm-1');
    assert.deepEqual(plain.bridge.buildSlot().records.find(x => x.t === 'reply').chips, ['Route me to my quests', 'What should I train?']);
    assert.equal(typeof plain.bridge.status().first.replyAt, 'number');
  } finally { await plain.bridge.stop(); }
});

// ------------------------------------------------------------------ the core's side of the seam
// (BUILD-PLAN B1; moved from the retired backend's test when that backend went: the core hands
// the backend the raw turn, names it in player-facing lines and merges its slot extras.)

const SEAM_CTX = [
  'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)',
  'Character: Tavi on Testrealm, level 6 Tauren Warrior (Horde), guild <Night Shift>',
  'Location: Mulgore - Red Cloud Mesa',
  'Position: 44.1, 76.3 on Mulgore (map 1412)',
  'Money: 1g 2s 3c; XP: 100/1000',
  'Professions: Mining 50/75, Herbalism 12/75',
  'Quest log (id, * = ready to turn in): 747,750*,752',
].join('\n');
function seamSetup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-seam-'));
  const addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  installSlots(addons, { count: 2, iface: '16001' });
  return { tmp, addons, state: path.join(tmp, 'state') };
}
const seamRec = (type, args = {}, extra = {}) => rec(type, type === 'hello' ? '' : CHAT, args, extra);
const seamMsg = (text, ctx = null) => seamRec('msg', { agent: 'main', name: 'Hyjal route', ctx: ctx ? 1 : 0, q: 'followup' }, { text, context: ctx });
// A backend stand-in, ready at start, its send answering as told (started, by default).
function seamBackend(onSend = args => ({ runId: args.idem, status: 'started' }), extra = {}) {
  return (handlers) => ({
    ...extra,
    start() { handlers.onState({ state: 'ready', since: Date.now() }); handlers.onReady(); },
    stop() {},
    send: args => onSend(args),
    outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
  });
}

test('core (seam): the bridge hands the backend the raw turn: the words as typed, its context lines, the kind; the slot carries the core\'s own fields', async () => {
  const env = seamSetup();
  const raw = [];
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 1, progressMs: 0 },
    gatewayFactory: seamBackend((args) => { raw.push(structuredClone(args)); return { runId: args.idem, status: 'started' }; }),
  });
  try {
    bridge.start();
    bridge.handlePayload(seamRec('hello', { ver: '1.2.0', ctx: 1 }, { body: SEAM_CTX }));
    const k1 = `a3f1_${n + 1}`;
    bridge.handlePayload(seamMsg('/status please', SEAM_CTX));
    await waitFor(() => raw.length === 1, 3000, 'the first send');
    bridge.handlePayload(seamMsg('and hey !elevated'));
    await waitFor(() => raw.length === 2, 3000, 'the second send');
    // The core formats nothing: the backend builds its request from the turn's kind, the words as
    // typed and its context lines (C1).
    assert.deepEqual(raw[0], { chatId: CHAT, idem: `nqa:${TOKEN}:${k1}`, turn: { contextLines: SEAM_CTX, useContext: true, kind: 'msg', typed: '/status please' } });
    assert.equal(raw[1].turn.typed, 'and hey !elevated', 'as typed, nothing neutralized');
    assert.equal(raw[1].turn.contextLines, SEAM_CTX, 'the stored context rides along');
    // A backend that adds nothing: the slot is the core's own.
    const slot = bridge.buildSlot();
    assert.deepEqual(Object.keys(slot), ['v', 'ts', 'now', 'token', 'bridge', 'gw', 'agents', 'chats', 'records', 'map']);
    // epoch: the store's (systems plan SY-02), so an addon can tell a store that started over; backend: what it runs on.
    assert.deepEqual(Object.keys(slot.bridge), ['ver', 'push', 'epoch', 'nonce', 'acked', 'warn', 'caps', 'stateSeq', 'stateSid', 'backend', 'voice']);
    assert.equal(slot.bridge.backend, 'byok');
  } finally {
    await bridge.stop();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('core (seam): player-facing lines name the backend (displayName, else "Your AI"), and its slotExtras merge into the slot', async () => {
  const env = seamSetup();
  const refuse = () => { throw Object.assign(new Error('INVALID_REQUEST: chatId must be a chat id'), { code: 'INVALID_REQUEST' }); };
  const extras = { bridge: { provider: 'anthropic', usage: { today: 3 } }, rt: { model: 'm1' } };
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 1, progressMs: 0 },
    gatewayFactory: seamBackend(refuse, { displayName: 'Testprovider', slotExtras: () => extras }),
  });
  try {
    bridge.start();
    bridge.handlePayload(seamRec('hello', { ver: '1.2.0', ctx: 0 }));
    await sleep(20);
    bridge.handlePayload(seamMsg('hello there'));
    const err = await waitFor(() => bridge.buildSlot().records.find(r => r.t === 'error'), 3000, 'the refusal line');
    assert.equal(err.kind, 'send');
    assert.equal(err.text, 'Testprovider refused this message: INVALID_REQUEST: chatId must be a chat id');
    const slot = bridge.buildSlot();
    assert.equal(slot.bridge.warn, undefined, 'no version pin');
    assert.equal(slot.bridge.provider, 'anthropic');
    assert.deepEqual(slot.bridge.usage, { today: 3 });
    assert.equal(slot.bridge.ver, BRIDGE_VERSION, 'bridge extras merge into the bridge\'s own fields');
    assert.ok(slot.bridge.caps.includes('state'));
    assert.deepEqual(slot.rt, { model: 'm1' });
  } finally {
    await bridge.stop();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }

  // A backend without a displayName: "Your AI".
  const env2 = seamSetup();
  const plain = createBridge({ transport: { slots: 2 } }, {
    stateDir: env2.state, addonsDir: env2.addons, log: () => {}, publisherOpts: { coalesceMs: 1, progressMs: 0 },
    gatewayFactory: seamBackend(refuse),
  });
  try {
    plain.start();
    plain.handlePayload(seamRec('hello', { ver: '1.2.0', ctx: 0 }));
    await sleep(20);
    plain.handlePayload(seamMsg('hello again'));
    const err = await waitFor(() => plain.buildSlot().records.find(r => r.t === 'error'), 3000, 'the refusal line');
    assert.match(err.text, /^Your AI refused this message: /);
    assert.equal('rt' in plain.buildSlot(), false);
  } finally {
    await plain.stop();
    fs.rmSync(env2.tmp, { recursive: true, force: true });
  }
});

test('core (seam): slot addons for another interface than the client\'s warn in the slot (bridge.warn) with the product\'s fix: install the addon again with WoW quit; the same interface warns of nothing', async () => {
  const warnFor = async (slotIface) => {
    const env = seamSetup();
    const bridge = createBridge({ transport: { slots: 2 } }, {
      stateDir: env.state, addonsDir: env.addons, log: () => {}, slotInterface: () => slotIface, publisherOpts: { coalesceMs: 1, progressMs: 0 },
      gatewayFactory: seamBackend(),
    });
    try {
      bridge.start();
      bridge.handlePayload(seamRec('hello', { ver: '1.4.3', ctx: 0, iface: '16001' }));
      await sleep(20);
      return { warn: bridge.buildSlot().bridge.warn, status: bridge.status().warn };
    } finally {
      await bridge.stop();
      fs.rmSync(env.tmp, { recursive: true, force: true });
    }
  };
  const other = await warnFor('16000');
  assert.equal(other.warn, 'slot addons are for interface 16000, the client is 16001: quit WoW, install the addon again and start WoW');
  assert.doesNotMatch(other.warn, /setup/, 'no setup to run again: the app\'s installer (or the command line\'s install) writes the slots');
  assert.equal(other.status, other.warn, 'status() says it too');
  assert.equal((await warnFor('16001')).warn, undefined, 'the same interface: no warning');
});

test('core (seam): an upd from an older addon (its Check for Updates) is acked and does nothing else: no upd cap, no bridge.update, nothing checked (the app keeps the addon up to date)', async () => {
  const env = seamSetup();
  const events = [];
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: env.state, addonsDir: env.addons, log: (ev) => events.push(ev), publisherOpts: { coalesceMs: 1, progressMs: 0 },
    gatewayFactory: seamBackend(undefined, { kind: 'byok', displayName: 'Anthropic' }),
  });
  try {
    bridge.start();
    bridge.handlePayload(seamRec('hello', { ver: '1.4.3', ctx: 0, toc: '0.4.3' }));
    await sleep(20);
    const key = `a3f1_${n + 1}`;
    bridge.handlePayload(encodeRecord({ token: TOKEN, key, type: 'upd', chat: '', args: { cur: 0, a: 'check' }, body: '' }));
    await waitFor(() => bridge.buildSlot().bridge.acked.includes(key), 3000, 'the upd ack');
    await sleep(100);
    const slot = bridge.buildSlot();
    assert.equal(slot.bridge.caps.includes('upd'), false, 'no upd cap, so no addon offers an update from the game');
    assert.equal(slot.bridge.update, undefined, 'no bridge.update');
    assert.deepEqual(events.filter(e => e.startsWith('update')), [], 'nothing checked or installed');
  } finally {
    await bridge.stop();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('core (seam): event args are game text (RT-11): controls, escapes, | and extra spaces go, 64 characters at most, empties dropped', async () => {
  const zones = [' Elwynn  Forest ', 'Stormwind|r City', `${'a'.repeat(63)}😀tail`, ''];
  const events = [...zones.map(zone => ['zone_first', { zone }]), ['level_up', { from: '', to: '12', layer: ' x ' }]];
  const env = seamSetup();
  const sent = [];
  const stored = [];
  let bridge = null;
  const answer = (args) => {
    // The outbox entry is still there while its send is going: the args as onEvt kept them.
    stored.push(structuredClone(bridge.store.outbox.find(o => args.idem === `nqa:${o.token}:${o.key}`)?.args));
    sent.push(args);
    return { runId: args.idem, status: 'started' };
  };
  bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 1, progressMs: 0 },
    gatewayFactory: seamBackend(answer, { kind: 'byok', displayName: 'Anthropic' }),
  });
  try {
    bridge.start();
    bridge.handlePayload(seamRec('hello', { ver: '1.4.3', ctx: 0 }));
    await sleep(20);
    for (const [i, [kind, args]] of events.entries()) {
      bridge.handlePayload(encodeRecord({ token: TOKEN, key: `a3f1_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind, agent: 'main', name: 'Companion', ...args }, body: '' }));
      await waitFor(() => sent.length === i + 1, 3000, `the ${kind} turn`);
    }
  } finally {
    await bridge.stop();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  assert.deepEqual(stored, [{ zone: 'Elwynn Forest' }, { zone: 'Stormwind City' }, { zone: `${'a'.repeat(63)}😀` }, {}, { to: '12', layer: 'x' }], 'game text, sanitized');
  assert.deepEqual(sent.slice(0, 2).map(p => p.turn.event.args.zone), ['Elwynn Forest', 'Stormwind City'], 'the zone rides as game text in the event\'s args');
  assert.deepEqual(sent[4].turn.event, { kind: 'level_up', args: { to: '12', layer: 'x' } }, 'the event rides with the turn, sanitized');
});
