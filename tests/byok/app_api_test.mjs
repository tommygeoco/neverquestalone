// The app API (bridge/byok/app-api.mjs; BUILD-PLAN "Contract: the app API the desktop shell
// calls"; public BYOK PRD §8, §9, §13, §15 SL-7, §16): every call against a real local backend on a
// temp data folder, the providers' mock server on 127.0.0.1 and canary keys in a memory key store,
// with the same shapes as app/desktop/src/mock-api.mjs (the window was written against it). WoW is
// temp folders and stubbed commands; the egress guard is a recording stand-in. No real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAppApi } from '../../bridge/byok/app-api.mjs';
import { createLocalBackend } from '../../bridge/byok/backend.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { loadManifests } from '../../bridge/byok/providers/index.mjs';
import { ADDON_SOURCE, RESTART_LINE } from '../../bridge/byok/wow.mjs';
import { addonListFile, SLOT_CATEGORY } from '../../bridge/transport/slots.mjs';
import { configWithDefaults, saveConfig } from '../../bridge/config.mjs';
import { createWindowsCapture } from '../../bridge/transport/capture.mjs';
import { createMockApi } from '../../app/desktop/src/mock-api.mjs';
import { startMock, reply, errorReply, manifestsAt, waitFor, sendParams, tmpDir, CANARY_KEYS } from './helpers/byok-env.mjs';
import { scanDirForCanaries } from './helpers/canary.mjs';

const CHAT = 'c3f9a1e';
const TIMEOUTS = { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 };
const keysOf = o => Object.keys(o ?? {}).sort();
// WoW running as this OS's process list shows it (bridge/byok/wow.mjs wowRunning): pgrep's pid lines,
// or tasklist's CSV on Windows (run by its full System32 path).
const wowProcess = cmd => (cmd === 'pgrep' ? { status: 0, stdout: '4242\n' }
  : /tasklist\.exe$/i.test(cmd) ? { status: 0, stdout: '"WowClassicB.exe","4242","Console","1","900,000 K"\r\n' } : { status: 1, stdout: '' });

function fakeEgress(rows = []) {
  const widened = [];
  const active = new Set();
  return {
    widened, active,
    ledger: () => rows,
    widen(hosts, feature) { const id = Symbol(feature); widened.push([hosts, feature]); active.add(id); return () => active.delete(id); },
  };
}

/** A running backend and the API over it. */
async function rig(t, { provider = 'anthropic', keys = [], handler = null, byok = {}, wow = {}, flavorDir = null, openExternal = null, fetch = undefined, restart = null, egressRows = [], platform = undefined, bridge = undefined } = {}) {
  const mock = handler ? await startMock(handler) : null;
  const dataDir = tmpDir('nqa-api-');
  const home = tmpDir('bones-home-');
  const configFile = path.join(dataDir, 'config.json');
  const keystore = createKeyStore({ backend: 'memory' });
  for (const id of keys) await keystore.set(id, CANARY_KEYS[id]);
  const manifests = mock ? manifestsAt(mock.url, ['anthropic', 'google', 'openai']) : loadManifests();
  // The AI companies' terms recorded, as setup's dialog does before any request (onboarding spec §9.3).
  const terms = { anthropic: { at: 1, v: 1 }, openai: { at: 1, v: 1 }, xai: { at: 1, v: 1 }, google: { at: 1, v: 1 } };
  const config = configWithDefaults({ wow: { flavorDir: flavorDir ?? path.join(home, 'nowhere') }, byok: { provider, terms, ...byok } });
  const lines = [];
  const secrets = new Set();
  const log = (k, d) => lines.push(JSON.stringify({ k, ...d }));
  log.addSecret = s => secrets.add(s);
  const backend = createLocalBackend({}, { config, dataDir, keystore, manifests, log, providerOpts: { timeouts: TIMEOUTS }, checks: { models: false } });
  await backend.start();
  const egress = fakeEgress(egressRows);
  const restarts = [];
  const api = createAppApi({
    backend, keystore, config, paths: { userData: dataDir, version: '0.1.0-test' }, log, egress, manifests, home, ...(bridge ? { bridge } : {}),
    saveConfig: cfg => saveConfig({ wow: cfg.wow, byok: cfg.byok }, configFile), configFile, openExternal, fetch,
    // roots: [] unless a test names its own: the run stub says WoW isn't running even while it is,
    // so findWow/installAddon must never see the real install (final review L1-5, the 4175ac2 class).
    wow: { run: () => ({ status: 1, stdout: '' }), roots: [], ...wow }, restart: restart ?? (async () => { restarts.push(Date.now()); }),
    ...(platform ? { platform } : {}),
  });
  t.after(async () => { await api.stop(); await backend.stop(); await mock?.close(); });
  return { api, backend, keystore, config, configFile, dataDir, home, mock, egress, lines, secrets, restarts };
}

test('the rig never searches this computer for WoW: findWow and installAddon see only a test\'s own roots (final review L1-5)', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.api.findWow(), { found: false, running: false, candidates: [] });
  assert.equal((await r.api.installAddon()).error, 'wow_not_found');
});

test('setRetention: saved, applied to the backend at once; regenerateSafetyId drops a pinned id and asks the backend for a new one (final review L5-5, L5-6)', async (t) => {
  const r = await rig(t, { byok: { safetyId: '11111111-2222-3333-4444-555555555555' } });
  assert.deepEqual(await r.api.setRetention(7), { ok: true, retentionDays: 7 });
  assert.equal(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).byok.transcripts.retentionDays, 7, 'saved');
  assert.equal((await r.api.transcripts({ deleteAll: false })).retentionDays, 7);
  const side = () => JSON.parse(fs.readFileSync(path.join(r.dataDir, 'byok-chats.json'), 'utf8')).safetyId;
  assert.deepEqual(await r.api.regenerateSafetyId(), { ok: true });
  const first = side();
  assert.match(first, /^[0-9a-f-]{36}$/);
  await r.api.regenerateSafetyId();
  assert.notEqual(side(), first, 'a new one each time');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).byok, 'safetyId'), false, 'the pinned id is gone from the config');
});

const noCanary = (label, ...things) => {
  for (const x of things) assert.ok(!JSON.stringify(x ?? '').includes('CANARY'), `${label}: ${JSON.stringify(x).slice(0, 300)}`);
};

test('status and providers have the mock API\'s shape, and never carry a key', async (t) => {
  const r = await rig(t, { keys: ['anthropic'] });
  const mock = createMockApi({ delayMs: 0 });
  const [st, ms] = [await r.api.status(), await mock.status()];
  assert.deepEqual(keysOf(st), keysOf(ms).filter(k => k !== 'mock'));
  assert.deepEqual(keysOf(st.backend), keysOf(ms.backend));
  assert.deepEqual(keysOf(st.capture), keysOf(ms.capture));
  assert.deepEqual(keysOf(st.capture.steps), keysOf(ms.capture.steps));
  assert.equal(st.backend.rt.state, 'ready');
  assert.equal(st.backend.provider.id, 'anthropic');
  // The usage block as BUILD-PLAN's contract has it since 2026-09-26 (no limits of ours: capMicros only
  // with a cap the player set, no capTurns or autoLeft, auto beside turns), and the mock the same.
  assert.deepEqual(keysOf(st.backend.usage), ['auto', 'day', 'exact', 'needs', 'spentMicros', 'turns']);
  await mock.setKey('anthropic', CANARY_KEYS.anthropic);
  assert.deepEqual(keysOf((await mock.status()).backend.usage), keysOf(st.backend.usage));
  // With a limit the player set, capMicros on both.
  assert.deepEqual(await r.api.setCaps({ dailyUsd: 2 }), { ok: true });
  assert.deepEqual(await mock.setCaps({ dailyUsd: 2 }), { ok: true });
  const [capped, mcapped] = [(await r.api.status()).backend.usage, (await mock.status()).backend.usage];
  assert.deepEqual(keysOf(mcapped), keysOf(capped));
  assert.equal(capped.capMicros, 2_000_000);
  assert.equal(mcapped.capMicros, 2_000_000);
  assert.deepEqual(keysOf(await mock.caps()), keysOf(await r.api.caps()));
  await r.api.setCaps({ dailyUsd: null });
  assert.equal(st.backend.usage.needs, null);
  assert.deepEqual(st.wow, { found: false, running: false, addon: false });
  assert.deepEqual(st.bridge, { version: st.bridge.version, running: false, paused: false, error: 'wow_not_found' });
  assert.equal(st.capture.state, 'no_game');

  const list = await r.api.providers();
  const mlist = await mock.providers();
  assert.deepEqual(list.map(p => p.id).sort(), mlist.map(p => p.id).sort());
  for (const p of list) {
    const m = mlist.find(x => x.id === p.id);
    for (const k of ['id', 'name', 'hidden', 'auth', 'models', 'privacyCard', 'terms', 'key']) assert.ok(Object.hasOwn(p, k), `${p.id}.${k}`);
    assert.deepEqual(keysOf(p.privacyCard), keysOf(m.privacyCard), p.id);
    assert.deepEqual(keysOf(p.terms), keysOf(m.terms), p.id);
    assert.equal(p.auth, m.auth, p.id);
    assert.equal(p.hidden, m.hidden, p.id);
    for (const x of p.models) assert.ok(['id', 'name', 'tier', 'effort', 'efforts'].every(k => Object.hasOwn(x, k)), `${p.id} model`);
    // The mock lists the same lineups, levels and costs (it reads the same manifests and prices).
    assert.deepEqual(p.models.map(x => [x.id, x.tier, x.efforts, x.priceHint, x.levelDays, x.costRank, x.older]), m.models.map(x => [x.id, x.tier, x.efforts, x.priceHint, x.levelDays, x.costRank, x.older]), `${p.id}: the mock's models`);
  }
  const an = list.find(p => p.id === 'anthropic');
  assert.deepEqual(an.key, { saved: true, masked: 'sk-ant-…xxxx', state: 'ok' });
  // fix-102: Claude's whole lineup, newest first with the default (Sonnet 5.5) at the top; Opus 5.5 the
  // smarter one, tagged Smartest in the full list (CL-words-35).
  assert.deepEqual(an.models.map(x => [x.id, x.tier]), [['claude-sonnet-5-5', 'default'], ['claude-opus-5-5', 'smarter'], ['claude-fable-5-1', 'other'], ['claude-sonnet-5', 'other'], ['claude-haiku-4-5', 'other']]);
  assert.deepEqual(an.models[0].priceHint, { replyCents: [1.93, 3.35], dayUsd: [0.77, 1.34], at: 40, think: 1024 }, 'PRD §7.3\'s typical turn on Sonnet 5.5 (the prompt pack as its prefix, BR-18), from the bundled prices, with half of Low\'s thinking room (SY-102-1)');
  assert.deepEqual(an.models.find(x => x.id === 'claude-haiku-4-5').priceHint, { replyCents: [0.97, 1.68], dayUsd: [0.39, 0.67], at: 40, think: 1024 }, 'every model its own cost line (Haiku 4.5 starts at Low too: a 2,048 budget)');
  assert.deepEqual(an.models.find(x => x.id === 'claude-fable-5-1').priceHint, { replyCents: [9.07, 16.76], dayUsd: [3.63, 6.7], at: 40, think: 1024 });
  // A day at each level (CL-design-37): Low is the start level's figure; Off prices no thinking; Max the most.
  const son = an.models[0];
  assert.deepEqual(son.levelDays.low, son.priceHint.dayUsd, 'Low is the start level\'s day');
  assert.deepEqual(Object.keys(son.levelDays), son.efforts);
  assert.ok(son.levelDays.off[1] < son.levelDays.low[1] && son.levelDays.low[1] < son.levelDays.max[1], 'more thinking, a dearer day');
  assert.deepEqual([son.costRank, son.older, an.models.find(x => x.id === 'claude-sonnet-5').older], [2, false, true], 'the rank, and older where a newer model replaces it');
  // Each model's thinking levels, cheapest first: Off only where it can answer without thinking.
  assert.deepEqual(an.models[0].efforts, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(an.models.find(x => x.id === 'claude-opus-5-5').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(an.models.find(x => x.id === 'claude-haiku-4-5').efforts, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const grok = list.find(p => p.id === 'xai').models.find(x => x.id === 'grok-4.20-0309-non-reasoning');
  assert.deepEqual([grok.effort, grok.efforts], [false, []], 'no levels, no list');
  assert.equal(grok.priceHint.think, 0, 'a model that never thinks is priced without thinking');
  assert.equal(list.find(p => p.id === 'xai').models.find(x => x.id === 'grok-4.20-0309-reasoning').priceHint.think, 2048, 'one that always thinks, with half its thinkRoom');
  const gem = list.find(p => p.id === 'google');
  assert.deepEqual([gem.models[0].id, gem.models[0].name, gem.models[0].tier, gem.auth], ['gemini-3.8-flash', 'Gemini 3.8 Flash', 'default', 'key']);
  assert.ok(Array.isArray(gem.models[0].priceHint.dayUsd), 'Gemini’s day, from the bundled prices');
  const other = list.find(p => p.id === 'custom');
  assert.deepEqual([other.name, other.auth, other.custom, other.models, other.key], ['Other', 'custom', null, [], { saved: false }], 'Other before its service is set');
  assert.deepEqual(list.find(p => p.id === 'openai').key, { saved: false });
  // What the app sets, as the provider step and the Privacy page show it: OpenAI's per-install id too
  // (final review L5-6), in the player's words (D-22).
  assert.equal(list.find(p => p.id === 'openai').privacyCard.sets, 'Asks OpenAI to keep nothing beyond its abuse logs, and sends a random ID for this install.');
  noCanary('providers', list, st);
});

test('status carries the last failure the game sends to the desktop (D-01): the desktop line and its fix; the next reply that goes through clears it', async (t) => {
  let fail = true;
  const r = await rig(t, { keys: ['anthropic'], handler: (req) => {
    if (req.method !== 'POST') return null;
    return fail ? errorReply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'something odd about <this> request' } }) : reply('Mulgore.', { input: 900, output: 20 });
  } });
  await r.backend.send(sendParams(CHAT, 'a3f1_1', 'where am I?'));
  await waitFor(async () => !!(await r.api.status()).backend.lastError, 5000, 'the failure in status');
  const st = await r.api.status();
  assert.equal(st.backend.rt.state, 'ready', 'no rt state covers it');
  assert.deepEqual(Object.keys(st.backend.lastError).sort(), ['action', 'at', 'detail', 'headline', 'kind', 'notice']);
  assert.equal(st.backend.lastError.kind, 'bad_request');
  assert.equal(st.backend.lastError.headline, 'Anthropic couldn’t take that message.', 'curly, like the rest of the window (D-30)');
  assert.equal(st.backend.lastError.notice, true, 'one bad request is an event (D-33)');
  assert.equal(st.backend.lastError.action, 'details');
  assert.ok(!JSON.stringify(st).includes('something odd'), 'never the provider\'s text');
  // Two in a row: a state again (D-33).
  await r.backend.send(sendParams(CHAT, 'a3f1_1b', 'and again?'));
  await waitFor(async () => (await r.api.status()).backend.lastError?.notice === undefined, 5000, 'the second one in a row');
  assert.equal(r.backend.status().lastError.streak, 2);
  fail = false;
  await r.backend.send(sendParams(CHAT, 'a3f1_2', 'and now?'));
  await waitFor(async () => !(await r.api.status()).backend.lastError, 5000, 'cleared by the next reply');
  // Kinds an rt state says, and in-game fixes, are no card.
  const { lastErrorView } = await import('../../bridge/byok/app-api.mjs');
  for (const kind of ['auth_invalid', 'out_of_credit', 'cap_spend', 'rate_limited', 'local_unreachable', 'network_before_send', 'content_blocked', 'context_too_long', 'interrupted', 'model_not_found']) {
    assert.equal(lastErrorView({ kind, at: 1 }, { provider: 'Anthropic' }), null, kind);
  }
  for (const [kind, action] of [['region_blocked', 'pick_provider'], ['identifier_blocked', 'details'], ['spend_limit', 'provider_limits'], ['egress_blocked', 'connections'], ['unknown', 'details']]) {
    const v = lastErrorView({ kind, at: 1 }, { provider: 'OpenAI' });
    assert.equal(v.action, action, kind);
    assert.doesNotMatch(`${v.headline} ${v.detail}`, /on your desktop/);
  }
  assert.match(lastErrorView({ kind: 'identifier_blocked' }, { provider: 'OpenAI' }).detail, /blocks an install after a serious policy violation/);
  // D-32: the kinds fixed at the provider offer a key test; D-33: one-offs are notices until they repeat.
  for (const k of ['spend_limit', 'region_blocked', 'egress_blocked']) assert.equal(lastErrorView({ kind: k }, { provider: 'OpenAI' }).retest, true, k);
  assert.equal(lastErrorView({ kind: 'identifier_blocked' }, { provider: 'OpenAI' }).retest, undefined);
  assert.equal(lastErrorView({ kind: 'unknown', streak: 1 }, { provider: 'OpenAI' }).notice, true);
  assert.equal(lastErrorView({ kind: 'unknown', streak: 2 }, { provider: 'OpenAI' }).notice, undefined);
  assert.equal(lastErrorView({ kind: 'region_blocked', streak: 1 }, { provider: 'OpenAI' }).notice, undefined, 'a region block is a state from the first');
  // SY-18: a failed write on this computer is said as such in the window too, never blamed on the AI.
  const full = lastErrorView({ kind: 'local_write', code: 'ENOSPC', at: 1 }, { provider: 'Anthropic' });
  assert.deepEqual([full.headline, full.detail, full.action], ['Your disk is full, so nothing was sent.', 'Free up space, then click Retry in game.', null], 'no button: Retry is the game\'s (UX-W22: click, and the table’s “Retry in game”)');
  const ro = lastErrorView({ kind: 'local_write', code: 'EROFS', at: 1 }, { provider: 'Anthropic' });
  assert.equal(`${ro.headline} ${ro.detail}`, 'NeverQuestAlone couldn’t save on this computer, so nothing was sent. Click Retry in game, or restart your computer.');
  for (const v of [full, ro]) assert.doesNotMatch(`${v.headline} ${v.detail}`, /Anthropic|Something went wrong/);
  // SY-12: a certificate failure is this computer's to fix too (its clock, or HTTPS scanning), never "offline".
  const tls = lastErrorView({ kind: 'tls', code: 'CERT_NOT_YET_VALID', at: 1 }, { provider: 'Anthropic' });
  assert.deepEqual([tls.headline, tls.detail, tls.action], ['Couldn’t make a secure connection to Anthropic.', 'Check your computer’s date and time, then click Retry in game.', null]);
  assert.equal(lastErrorView({ kind: 'tls', code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }, { provider: 'Anthropic' }).detail, 'Turn off HTTPS scanning in your antivirus, then click Retry in game.');
  // fix-empty-reply: an empty reply, twice, is said in the window too (the game's Retry sends it
  // again): Thinking on Your AI, or another model where it has none; the card's button opens the model.
  const empty = lastErrorView({ kind: 'empty_reply', code: 'length', at: 1, streak: 1 }, { provider: 'Anthropic', companion: 'NeverQuestAlone', thinking: true });
  assert.deepEqual([empty.kind, empty.headline, empty.detail, empty.action, empty.notice, empty.retest],
    ['empty_reply', 'NeverQuestAlone couldn’t finish a reply.', 'Lower Thinking in Your AI, or ask again in game.', 'pick_model', undefined, undefined]);
  const noLevels = lastErrorView({ kind: 'empty_reply', code: 'length', at: 1 }, { provider: 'Ollama', companion: 'NeverQuestAlone', thinking: false });
  assert.deepEqual([noLevels.headline, noLevels.detail, noLevels.action], ['NeverQuestAlone couldn’t finish a reply.', 'Pick another model, or ask again in game.', 'pick_model']);
  for (const v of [empty, noLevels]) assert.doesNotMatch(`${v.headline} ${v.detail}`, /Something went wrong|Anthropic|Ollama|'/);
  // D-30: desktop text has one kind of apostrophe.
  const { desktopLine } = await import('../../bridge/byok/app-api.mjs');
  for (const kind of ['region_blocked', 'spend_limit', 'bad_request', 'local_unreachable', 'oauth_expired', 'unknown', 'rate_limited']) {
    const l = desktopLine({ kind }, { provider: 'Anthropic' });
    assert.doesNotMatch(`${l.headline} ${l.detail} ${l.line}`, /'/, kind);
  }
});

test('a passing key test for the provider in use clears the last failure the player fixed at the provider (D-32)', async (t) => {
  let status = 402;
  const r = await rig(t, { keys: ['anthropic'], handler: (req) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }], has_more: false }) };
    if (req.method !== 'POST') return null;
    if (req.body?.max_tokens === 1 && status === 200) return reply('ok', { input: 9, output: 1 });
    return status === 200 ? reply('Mulgore.') : errorReply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'This request would exceed your organization\'s specified API usage limits.' } });
  } });
  await r.backend.send(sendParams(CHAT, 'a3f1_1', 'where am I?'));
  await waitFor(async () => !!(await r.api.status()).backend.lastError, 5000, 'the failure in status');
  const le = (await r.api.status()).backend.lastError;
  assert.equal(le.kind, 'spend_limit');
  assert.equal(le.retest, true);
  const still = await r.api.testKey('anthropic');
  assert.equal(still.ok, false, 'the limit is still there: the card stays');
  assert.ok((await r.api.status()).backend.lastError);
  status = 200;
  assert.equal((await r.api.testKey('anthropic')).ok, true);
  await waitFor(async () => !(await r.api.status()).backend.lastError, 3000, 'cleared by the passing test');
  assert.equal(r.backend.clearLastError(), false, 'nothing left to clear');
});

test('an empty reply, twice (fix-empty-reply): the window\'s card says it in its words, with Thinking where the model has levels, and goes with the next reply', async (t) => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const thinkingOnly = ev('message_start', { message: { id: 'msg_E', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 900, output_tokens: 1 } } })
    + ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }) + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 3248 } }) + ev('message_stop', {});
  let empty = true;
  const r = await rig(t, { keys: ['anthropic'], handler: (req) => {
    if (req.method !== 'POST') return null;
    return empty ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: thinkingOnly } : reply('Mulgore.');
  } });
  await r.backend.send(sendParams(CHAT, 'e_1', 'where am I?'));
  await waitFor(async () => !!(await r.api.status()).backend.lastError, 5000, 'the failure in status');
  const le = (await r.api.status()).backend.lastError;
  assert.deepEqual([le.kind, le.headline, le.detail, le.action, le.notice], ['empty_reply', 'NeverQuestAlone couldn’t finish a reply.', 'Lower Thinking in Your AI, or ask again in game.', 'pick_model', undefined]);
  assert.equal(r.mock.requests.filter(q => q.method === 'POST').length, 2, 'one more try in the turn, then the line');
  empty = false;
  await r.backend.send(sendParams(CHAT, 'e_2', 'where am I?'));
  await waitFor(async () => !(await r.api.status()).backend.lastError, 5000, 'gone with the next reply');
});

test('tightenAddonPermissions (D-29): only the permissions, with tighten, no reinstall, even while WoW runs', async (t) => {
  const root = tmpDir('bones-tight-');
  const flavor = path.join(root, '_forever_');
  fs.mkdirSync(path.join(flavor, 'Interface', 'AddOns'), { recursive: true });
  const asked = [];
  const run = wowProcess; // WoW is running
  const r = await rig(t, { flavorDir: flavor, wow: { run, permissions: (ad, o) => { asked.push(o.tighten === true); return o.tighten ? { ok: true, fixable: false, paths: [], fixed: [ad], detail: '' } : { ok: false, fixable: true, paths: [ad], fixed: [], detail: 'loose' }; }, install: () => { throw new Error('no reinstall'); } } });
  assert.equal((await r.api.wowRunning()).running, true);
  const res = await r.api.tightenAddonPermissions();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.permissions.ok, true);
  assert.deepEqual(res.permissions.fixed, [path.join(flavor, 'Interface', 'AddOns')]);
  assert.deepEqual(asked, [true], 'the check with tighten, once');
  const none = await rig(t);
  assert.equal((await none.api.tightenAddonPermissions()).error, 'wow_not_found');
});

test('addonPermissions and adminCommand (D-23, D-37): the check on demand, with a fixed command for an administrator and the sentence for exactly that command', async (t) => {
  const { adminCommand, accountSid, ADMIN_EXPLAIN } = await import('../../bridge/byok/app-api.mjs');
  assert.deepEqual(adminCommand({ ok: false, paths: ['/Games/WoW/_forever_/Interface/AddOns', "/it's"] }, { platform: 'darwin' }),
    { command: "sudo chmod go-w '/Games/WoW/_forever_/Interface/AddOns' '/it'\\''s'", explanation: 'Stops other accounts from changing these folders; nothing else changes.' });
  assert.equal(adminCommand({ ok: false, paths: ['/a', '/link'], links: ['/link'] }, { platform: 'linux' }).command, "sudo chmod go-w '/a'", 'never through a link');
  const dir = 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns';
  const loose = { ok: false, grants: ['BUILTIN\\Users:(OI)(CI)(F)', 'Everyone:(M)'] };
  const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
  // Windows: this account keeps its own modify grant by SID, whatever its name.
  assert.deepEqual(adminCommand(loose, { platform: 'win32', addonsDir: dir, sid: SID }), {
    command: `icacls "${dir}" /inheritance:d /grant:r *S-1-5-32-545:(OI)(CI)RX *S-1-1-0:(OI)(CI)RX *${SID}:(OI)(CI)M`,
    explanation: 'Stops other accounts from changing the AddOns folder; yours still can.',
  });
  // No SID: no command (it could lock the player out), only what to ask for.
  assert.deepEqual(adminCommand(loose, { platform: 'win32', addonsDir: dir, sid: null }), { command: null, explanation: ADMIN_EXPLAIN.noSid });
  assert.equal(ADMIN_EXPLAIN.noSid, 'Ask an administrator to remove write access for Users from this folder.');
  assert.deepEqual(adminCommand(loose, { platform: 'win32', addonsDir: dir, sid: 'Tavi' }), { command: null, explanation: ADMIN_EXPLAIN.noSid }, 'a name is not a SID');
  assert.equal(adminCommand({ ok: false, grants: ['Everyone:(M)'] }, { platform: 'win32', addonsDir: 'C:\\x" & del *', sid: SID }).command, null, 'a path that can\'t be quoted safely: none');
  assert.deepEqual(adminCommand({ ok: true }, { platform: 'darwin' }), { command: null, explanation: null });
  // The SID, from whoami by its System32 path, for an ASCII name, a non-ASCII name, a missing one; none when whoami fails.
  const calls = [];
  const whoami = out => (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: out }; };
  const env = { SystemRoot: 'C:\\Windows' };
  assert.equal(accountSid({ env, run: whoami(`"desktop-7\\tavi","${SID}"\r\n`) }), SID);
  assert.deepEqual(calls[0], ['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']]);
  assert.equal(accountSid({ env, run: whoami(`"DESKTOP-7\\José","S-1-5-21-1-2-3-1002"`) }), 'S-1-5-21-1-2-3-1002');
  assert.equal(accountSid({ env, run: whoami(`"DESKTOP-7\\山田","S-1-5-21-4-5-6-1003"`) }), 'S-1-5-21-4-5-6-1003');
  assert.equal(accountSid({ env, run: whoami(`"","S-1-5-21-7-8-9-1004"`) }), 'S-1-5-21-7-8-9-1004', 'a missing name');
  assert.equal(accountSid({ env, run: () => ({ status: 1, stdout: '' }) }), null, 'whoami failed');
  assert.equal(accountSid({ env, run: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(accountSid({ env, run: whoami('"desktop\\tavi","not a sid"') }), null);
  // Through the API on Windows: the SID read once; without one, the explanation and no command.
  const root = tmpDir('bones-perm-');
  const flavor = path.join(root, '_forever_');
  fs.mkdirSync(path.join(flavor, 'Interface', 'AddOns'), { recursive: true });
  const perm = () => ({ ok: false, fixable: false, paths: [path.join(flavor, 'Interface', 'AddOns')], fixed: [], detail: 'Every account on this PC can change the AddOns folder.', grants: ['BUILTIN\\Users:(OI)(CI)(F)'] });
  let sidReads = 0;
  const w = await rig(t, { flavorDir: flavor, platform: 'win32', wow: { permissions: perm, sid: () => { sidReads += 1; return SID; } } });
  const wp = await w.api.addonPermissions();
  assert.match(wp.permissions.command, new RegExp(`\\*${SID}:\\(OI\\)\\(CI\\)M$`));
  assert.equal(wp.permissions.explanation, ADMIN_EXPLAIN.win32);
  await w.api.addonPermissions();
  assert.equal(sidReads, 1, 'read once');
  const n = await rig(t, { flavorDir: flavor, platform: 'win32', wow: { permissions: perm, sid: () => null } });
  const np = await n.api.addonPermissions();
  assert.equal(np.permissions.command, null);
  assert.equal(np.permissions.explanation, ADMIN_EXPLAIN.noSid);
  // And on this OS.
  const r = await rig(t, { flavorDir: flavor, wow: { permissions: () => ({ ...perm(), grants: ['x'] }) } });
  const p = await r.api.addonPermissions();
  assert.equal(p.ok, true);
  assert.equal(p.permissions.ok, false);
  if (process.platform !== 'win32') assert.match(p.permissions.command, /^sudo chmod go-w '/);
  assert.equal(p.permissions.grants, undefined, 'no grant lines to the window');
  const none = await rig(t);
  assert.deepEqual(await none.api.addonPermissions(), { ok: true, permissions: null });
});

test('a passing key test for the provider in use clears the trouble a failed turn left (D-38): out of credit, credit added, Test, ready', async (t) => {
  let credit = false;
  const r = await rig(t, { keys: ['anthropic'], handler: (req) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }], has_more: false }) };
    if (req.method !== 'POST') return null;
    return credit ? reply('ok', { input: 9, output: 1 }) : errorReply(402, { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low.' } });
  } });
  await r.backend.send(sendParams(CHAT, 'a3f1_1', 'where am I?'));
  await waitFor(async () => (await r.api.status()).backend.rt.state === 'out_of_credit', 5000, 'out of credit');
  assert.equal((await r.api.testKey('anthropic')).ok, false, 'no credit yet: the card stays');
  assert.equal((await r.api.status()).backend.rt.state, 'out_of_credit');
  credit = true;
  assert.equal((await r.api.testKey('anthropic')).ok, true);
  await waitFor(async () => (await r.api.status()).backend.rt.state === 'ready', 3000, 'ready after the passing test');
  assert.equal(r.backend.clearAfterTest(), false, 'nothing left to clear');
});

test('Other at a server on this computer: its passing check clears local_down the same way (D-38)', async (t) => {
  const r = await rig(t, { handler: (req) => (req.method === 'POST' && req.url === '/v1/chat/completions'
    ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` } : null) });
  assert.equal((await r.api.connectCustom({ baseUrl: `${r.mock.url}/v1`, model: 'qwen3:8b' })).ok, true);
  let cleared = 0;
  const orig = r.backend.clearAfterTest;
  r.backend.clearAfterTest = () => { cleared += 1; return orig(); };
  const res = await r.api.testKey('custom');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.testCall.micros, 0, 'free on this computer');
  assert.equal(cleared, 1, 'the provider in use: cleared');
  await r.api.testKey('anthropic').catch(() => null);
  assert.equal(cleared, 1, 'another provider\'s test clears nothing');
});

test('retentionPreview (D-24): what a shorter time would delete now, counted from the transcripts; nothing is deleted by asking', async (t) => {
  const r = await rig(t);
  const tr = r.backend.transcripts;
  const DAY = 86400_000;
  const at = Date.now();
  tr.append('c0000a1', { role: 'user', text: 'old', t: at - 40 * DAY });
  tr.append('c0000a1', { role: 'assistant', text: 'old reply', t: at - 40 * DAY + 1 });
  tr.append('c0000b2', { role: 'user', text: 'old', t: at - 20 * DAY });
  tr.append('c0000b2', { role: 'user', text: 'new', t: at - DAY });
  tr.append('c0000c3', { role: 'user', text: 'new', t: at - 2 * DAY });
  assert.deepEqual(await r.api.retentionPreview(10), { ok: true, retentionDays: 30, days: 10, chats: 1, trimmed: 1, messages: 3 });
  assert.deepEqual(await r.api.retentionPreview(30), { ok: true, retentionDays: 30, days: 30, chats: 1, trimmed: 0, messages: 2 });
  assert.equal((await r.api.retentionPreview(90)).messages, 0);
  assert.deepEqual(tr.chats().sort(), ['c0000a1', 'c0000b2', 'c0000c3'], 'asking deletes nothing');
});

test('D-22: providers() carries only the manifests\' player text; the developer notes never reach the window', async (t) => {
  const r = await rig(t);
  const list = await r.api.providers();
  const text = JSON.stringify(list);
  for (const dev of ['anthropic-workspace-id', 'top_p', 'store:false', 'data_collection', 'zdr:true', '/v1/messages', 'safety_identifier', 'Covered Models', 'DB6', 'num_ctx', 'VPN', 'attribution headers']) {
    assert.ok(!text.includes(dev), `providers() carries "${dev}"`);
  }
  const strings = [];
  for (const p of list) {
    assert.deepEqual(Object.keys(p.privacyCard).sort(), ['class', 'keeps', 'link', 'sets', 'short', 'trains', 'zeroRetention']);
    assert.deepEqual(Object.keys(p.terms), ['link', 'recorded']);
    assert.equal(typeof p.terms.recorded, 'boolean');
    for (const k of ['keeps', 'trains', 'zeroRetention', 'sets', 'short']) strings.push([`${p.id}.privacyCard.${k}`, p.privacyCard[k]]);
    for (const n of p.notes) strings.push([`${p.id}.notes`, n]);
    assert.ok(p.privacyCard.keeps && p.privacyCard.trains && p.privacyCard.sets, p.id);
  }
  // Plain words only: no request field, header, API path or JSON-ish token. The one token allowed is
  // {os:Mac}, the player's computer by its system's name, which the window fills (UX-W41).
  const BAD = /[_:{}[\]=`<>"|\\]|header|top_p|\/v1|\b(?:true|false|null)\b|[a-z]\.[a-z]/i;
  for (const [where, s] of strings) assert.doesNotMatch(s.replace(/\{os:Mac\}/g, 'Mac'), BAD, where);
  assert.match(list.find(p => p.id === 'anthropic').notes.join(' '), /isn’t an API key/);
  assert.match(list.find(p => p.id === 'google').notes.join(' '), /18 or older/);
  // The manifests themselves: the schema refuses developer words in the player fields, so a data file can't slip them in.
  const { loadManifests, validateManifest, PLAYER_TEXT_BAD } = await import('../../bridge/byok/providers/index.mjs');
  for (const m of loadManifests()) {
    assert.deepEqual(validateManifest(m), [], m.id);
    for (const s of [...Object.values(m.privacy.player), ...m.terms.playerNotes]) assert.doesNotMatch(s.replace(/\{os:Mac\}/g, 'Mac'), BAD, `${m.id}: ${s}`);
  }
  assert.match(loadManifests().find(m => m.id === 'custom').privacy.local.player.keeps, /^Your messages stay on this \{os:Mac\}\./, 'this Mac, this PC: the window fills it');
  // Any other token is still refused: only {os:Mac}.
  for (const bad of ['Your messages stay on this {os:Computer}.', 'Stays on {name}.', 'Stays here {os:Mac']) {
    const t = structuredClone(loadManifests().find(m => m.id === 'google'));
    t.privacy.player.keeps = bad;
    assert.ok(validateManifest(t).some(p => /privacy\.player/.test(p)), bad);
  }
  const base = structuredClone(loadManifests().find(m => m.id === 'google'));
  for (const bad of ['data_collection: deny', 'zdr:true routing', 'Sends the x-title header.', 'Uses /v1/messages.', '{"store": false}', 'Fable 5/5.1']) {
    assert.match(bad, PLAYER_TEXT_BAD, bad);
    const m = structuredClone(base);
    m.privacy.player.sets = bad;
    assert.ok(validateManifest(m).some(p => /privacy\.player/.test(p)), bad);
    const n = structuredClone(base);
    n.terms.playerNotes = [bad];
    assert.ok(validateManifest(n).some(p => /playerNotes/.test(p)), bad);
  }
});

test('setKey: provider and key checked (shape, provider match, admin keys); stored; the mask back; refresh makes it ready', async (t) => {
  const r = await rig(t);
  assert.equal((await r.api.status()).backend.rt.state, 'no_key');
  assert.equal((await r.api.setKey('nope', CANARY_KEYS.anthropic)).error, 'bad_input');
  assert.equal((await r.api.setKey('custom', CANARY_KEYS.anthropic)).error, 'bad_input', 'Other’s key comes with its service’s address (connectCustom)');
  assert.equal((await r.api.setKey('google', CANARY_KEYS.anthropic)).error, 'key_mismatch', 'Gemini takes a Google key');
  assert.equal((await r.api.setKey('anthropic', 42)).error, 'bad_input');
  assert.equal((await r.api.setKey('anthropic', 'short')).error, 'not_a_key', 'shapes are the IPC schema\'s; here, the key against its provider');
  assert.equal((await r.api.setKey('anthropic', 'this is not a key at all, just words')).error, 'not_a_key');
  assert.equal((await r.api.setKey('anthropic', 'plainly-not-a-key-but-long-enough')).error, 'not_a_key');
  const mism = await r.api.setKey('anthropic', CANARY_KEYS.openai);
  assert.equal(mism.error, 'key_mismatch');
  assert.equal(mism.detail, 'That’s a key from OpenAI. Pick OpenAI, or paste a key from Anthropic.');
  assert.equal(mism.guess, 'openai', 'so the window can offer "Pick OpenAI"');
  assert.equal((await r.api.setKey('anthropic', `sk-ant-admin01-CANARY${'x'.repeat(60)}`)).error, 'admin_key');
  assert.deepEqual(await r.keystore.list(), [], 'nothing stored by a refusal');

  const ok = await r.api.setKey('anthropic', `  ${CANARY_KEYS.anthropic}\n`);
  assert.deepEqual(ok, { ok: true, masked: 'sk-ant-…xxxx' });
  assert.equal(await r.keystore.get('anthropic'), CANARY_KEYS.anthropic);
  assert.ok(r.secrets.has(CANARY_KEYS.anthropic), 'registered with the log\'s redactor before use');
  await waitFor(async () => (await r.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  assert.equal(r.config.byok.authBy.anthropic, 'key');
  const saved = fs.readFileSync(r.configFile, 'utf8');
  assert.ok(!saved.includes('CANARY'), 'the config never holds a key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.configFile).mode & 0o777, 0o600);
  noCanary('log', r.lines);
});

test('testKey: the model list and a 1-token call, its cost; the provider\'s hosts allowed only while it runs; a rejected key is the §10 line', async (t) => {
  let status = 200;
  const r = await rig(t, { keys: ['anthropic'], handler: (req) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return status === 200 ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5' }], has_more: false }) } : errorReply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (req.method === 'POST' && req.url === '/v1/messages') return reply('ok', { input: 9, output: 1 });
    return null;
  } });
  const res = await r.api.testKey('anthropic');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.models, ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  assert.equal(res.testCall.ok, true);
  assert.ok(res.testCall.micros > 0 && res.testCall.micros < 100, `under $0.0001: ${res.testCall.micros}`);
  const call = r.mock.requests.find(x => x.method === 'POST');
  assert.equal(call.body.max_tokens, 1);
  assert.equal(call.body.model, 'claude-sonnet-5-5', 'Claude\'s default (fix-102)');
  assert.deepEqual([call.body.thinking, call.body.output_config], [{ type: 'between_tools' }, { effort: 'low' }], 'its lowest level: a key test that doesn\'t think');
  assert.deepEqual(r.egress.widened, [[['api.anthropic.com'], 'key_test']]);
  assert.equal(r.egress.active.size, 0, 'released afterwards');
  status = 401;
  const bad = await r.api.testKey('anthropic');
  // The desktop's way (D-01): the headline, a next step that names the fix in the window, the action id.
  assert.deepEqual(bad, {
    ok: false, error: 'auth_invalid', headline: 'Your Anthropic key was rejected.', detail: 'Replace your key, or make a new one at Anthropic.',
    action: 'replace_key', line: 'Your Anthropic key was rejected. Replace your key, or make a new one at Anthropic.',
  });
  assert.doesNotMatch(JSON.stringify(bad), /on your desktop/);
  assert.equal(r.egress.active.size, 0);
  assert.equal((await r.api.testKey('openrouter')).error, 'bad_input', 'no OpenRouter of its own: it connects through Other');
  assert.equal((await r.api.testKey('custom')).error, 'bad_input', 'Other before its service is set');
  noCanary('testKey', res, bad, r.lines);
});

test('testStagedKey (D-03): a pasted key is tested without being stored; a failed test leaves the saved key as it was', async (t) => {
  const NEW = CANARY_KEYS.anthropic.replace(/x{8}$/, 'NEWNEWNE');
  let reject = false;
  const r = await rig(t, { keys: ['anthropic'], handler: (req) => {
    const key = req.headers['x-api-key'];
    const denied = reject && key === NEW;
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return denied ? errorReply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }], has_more: false }) };
    if (req.method === 'POST' && req.url === '/v1/messages') return reply('ok', { input: 9, output: 1 });
    return null;
  } });
  // A working new key: the test runs with it, and nothing is written.
  const ok = await r.api.testStagedKey('anthropic', () => NEW);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.testCall.micros > 0);
  assert.equal(r.mock.requests.at(-1).headers['x-api-key'], NEW, 'the test used the pasted key');
  assert.equal(await r.keystore.get('anthropic'), CANARY_KEYS.anthropic, 'the saved key is untouched');
  // A rejected new key: the §10 line, and the saved key stays.
  reject = true;
  const bad = await r.api.testStagedKey('anthropic', async () => NEW);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'auth_invalid');
  assert.equal(bad.action, 'replace_key');
  assert.equal(await r.keystore.get('anthropic'), CANARY_KEYS.anthropic, 'the old key stays when the new one fails');
  // The same shape checks as setKey, before any request.
  const before = r.mock.requests.length;
  assert.equal((await r.api.testStagedKey('anthropic', () => CANARY_KEYS.openai)).error, 'key_mismatch');
  assert.equal((await r.api.testStagedKey('anthropic', () => 'short')).error, 'not_a_key');
  assert.equal((await r.api.testStagedKey('anthropic', () => null)).error, 'key_expired');
  assert.equal((await r.api.testStagedKey('ollama', () => NEW)).error, 'bad_input');
  assert.equal(r.mock.requests.length, before, 'no request for a key that fails its shape');
  assert.ok(r.secrets.has(NEW), 'the pasted key is registered with the redactor before use');
  assert.deepEqual(r.egress.widened.at(-1), [['api.anthropic.com'], 'key_test']);
  assert.equal(r.egress.active.size, 0);
  noCanary('testStagedKey', ok, bad, r.lines);
});

test('desktopLine (D-01): the §10 headline and action id, with a next step for the window, never "on your desktop"', async () => {
  const { desktopLine } = await import('../../bridge/byok/app-api.mjs');
  const names = { provider: 'Anthropic', model: 'Claude Haiku 4.5', platform: 'darwin', capMicros: 1_000_000 };
  const kinds = ['no_key', 'egress_blocked', 'auth_invalid', 'out_of_credit', 'spend_limit', 'cap_spend', 'rate_limited', 'rate_limited_daily', 'overloaded',
    'model_not_found', 'context_too_long', 'content_blocked', 'network_before_send', 'network_after_send', 'local_unreachable', 'oauth_expired', 'region_blocked',
    'identifier_blocked', 'interrupted', 'timeout', 'bad_request', 'unknown'];
  for (const kind of kinds) {
    const l = desktopLine({ kind }, names);
    assert.ok(l.headline && typeof l.detail === 'string', kind);
    assert.doesNotMatch(`${l.headline} ${l.detail}`, /on your desktop|in NeverQuestAlone on/i, kind);
    assert.equal(l.line, [l.headline, l.detail].filter(Boolean).join(' '));
  }
  // The window's words for the states a card names (bones-ux-writer onboarding r3, UX-W31): the
  // card's headline, and a next step that names the window's own button.
  assert.deepEqual([desktopLine({ kind: 'out_of_credit' }, names).headline, desktopLine({ kind: 'out_of_credit' }, names).detail], ['Your Anthropic account is out of credit.', 'Add credit at Anthropic, then click Test key.']);
  assert.equal(desktopLine({ kind: 'out_of_credit' }, names).action, 'add_credit');
  assert.deepEqual([desktopLine({ kind: 'cap_spend' }, names).headline, desktopLine({ kind: 'cap_spend' }, names).detail], ['You’ve reached your daily spend limit ($1.00).', 'Click Raise limit, or it resets at midnight.']);
  assert.equal(desktopLine({ kind: 'network_before_send' }, names).line, 'Can’t reach Anthropic. Check your internet, then click Test key.', 'said once');
  assert.equal(desktopLine({ kind: 'oauth_expired' }, { ...names, provider: 'OpenRouter' }).action, 'sign_in');
  assert.equal(desktopLine({ kind: 'no_key', code: 'keystore_error' }, names).detail, 'Unlock your login keychain, then click Test key.', 'homeCard.keyUnreadable.detail');
  assert.equal(desktopLine({ kind: 'no_key', code: 'keystore_error' }, { ...names, platform: 'win32' }).detail, 'Click Test key, or restart Windows if it keeps happening.', 'homeCard.keyUnreadable.detailWin');
  assert.equal(desktopLine({ kind: 'local_unreachable' }, { ...names, provider: 'Ollama' }).detail, 'Start Ollama, then click Check again.');
  // A time of day keeps Intl's AM and PM (STYLE §8), as setup's results say it.
  const reset = desktopLine({ kind: 'spend_limit', resetAt: Date.parse('2026-09-26T23:19:00Z') }, { ...names, now: Date.parse('2026-09-26T20:00:00Z'), timeZone: 'America/Los_Angeles' });
  assert.equal(reset.detail, 'Raise it there, or wait until 4:19 PM.');
});

test('testKey on Gemini: the model list (models/ ids made bare) and one tiny Chat Completions request to Google’s OpenAI-compatible address', async (t) => {
  const r = await rig(t, { provider: 'google', keys: ['google'], handler: (req) => {
    if (req.method === 'GET' && req.url === '/v1beta/openai/models') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ object: 'list', data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.1-flash-lite' }] }) };
    if (req.method === 'POST' && req.url === '/v1beta/openai/chat/completions') return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n` };
    return null;
  } });
  const res = await r.api.testKey('google');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.models, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
  const call = r.mock.requests.find(x => x.method === 'POST');
  assert.equal(call.headers.authorization, `Bearer ${CANARY_KEYS.google}`);
  assert.equal(call.body.model, 'gemini-3.8-flash');
  assert.equal(call.body.max_tokens, 16);
  assert.equal(call.body.reasoning_effort, 'low', 'Gemini 3 always thinks: the least');
  assert.ok(!('store' in call.body) && !('reasoning' in call.body));
  assert.deepEqual(r.egress.widened, [[['generativelanguage.googleapis.com'], 'key_test']]);
  noCanary('testKey', res, r.lines);
});

test('deleteKey removes it from the store; the provider shows "key missing"', async (t) => {
  const r = await rig(t, { keys: ['anthropic'] });
  assert.equal((await r.api.deleteKey('ollama')).error, 'bad_input');
  assert.deepEqual(await r.api.deleteKey('custom'), { ok: true }, 'Other’s entry, set or not');
  assert.deepEqual(await r.api.deleteKey('anthropic'), { ok: true });
  assert.equal(await r.keystore.get('anthropic'), null);
  await waitFor(async () => (await r.api.status()).backend.rt.state === 'no_key', 3000, 'no_key');
  assert.deepEqual((await r.api.providers()).find(p => p.id === 'anthropic').key, { saved: false });
});

test('choose: a listed model (any id on Other), effort checked; the backend and the saved config follow', async (t) => {
  const r = await rig(t, { keys: ['anthropic'], byok: { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' } } });
  assert.deepEqual(await r.api.choose({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium' }), { ok: true });
  const p = (await r.api.status()).backend.provider;
  assert.equal(p.model, 'claude-sonnet-5');
  assert.equal(p.effort, 'medium');
  const saved = JSON.parse(fs.readFileSync(r.configFile, 'utf8')).byok;
  assert.deepEqual([saved.provider, saved.model, saved.effort], ['anthropic', 'claude-sonnet-5', 'medium']);
  assert.equal((await r.api.choose({ provider: 'anthropic', model: 'claude-opus-99' })).error, 'unknown_model');
  assert.equal((await r.api.choose({ provider: 'google', model: 'gemini-2.0-flash' })).error, 'unknown_model', 'Gemini offers its listed models, never a shut-down one');
  // fix-102: every thinking level is one; a level the model hasn't is saved as the one it runs, its nearest.
  assert.equal((await r.api.choose({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'ultra' })).error, 'bad_input');
  assert.deepEqual(await r.api.choose({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'off' }), { ok: true });
  assert.deepEqual([r.config.byok.model, r.config.byok.effort], ['claude-opus-5-5', 'low'], 'Opus 5.5 always thinks: its lowest');
  assert.deepEqual(await r.api.choose({ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'xhigh' }), { ok: true });
  assert.equal(r.config.byok.effort, 'xhigh');
  assert.deepEqual(await r.api.choose({ provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'minimal' }), { ok: true });
  assert.equal(r.config.byok.effort, 'minimal', 'Haiku 4.5\'s smallest thinking budget');
  assert.deepEqual(await r.api.choose({ provider: 'anthropic', model: 'claude-haiku-4-5', effort: null }), { ok: true });
  assert.equal(r.config.byok.effort, null, 'none asked stays none: the model\'s own');
  assert.deepEqual(await r.api.choose({ provider: 'google', model: 'gemini-3.1-flash-lite', effort: 'off' }), { ok: true });
  assert.deepEqual([r.config.byok.provider, r.config.byok.model, r.config.byok.effort], ['google', 'gemini-3.1-flash-lite', 'minimal'], 'Gemini 3 can\'t turn thinking off: its lowest');
  assert.equal((await r.api.choose({ provider: 'openrouter', model: 'x/y' })).error, 'bad_input', 'no OpenRouter of its own');
  assert.equal((await r.api.choose({ provider: 'anthropic', model: '../../etc' })).error, 'unknown_model');
  assert.equal((await r.api.choose(null)).error, 'bad_input');
  assert.deepEqual(await r.api.choose({ provider: 'custom', model: 'meta-llama/llama-4-scout:free', effort: null }), { ok: true });
  const st = (await r.api.status()).backend.provider;
  assert.deepEqual([st.id, st.name, st.model], ['custom', 'openrouter.ai', 'meta-llama/llama-4-scout:free']);
  assert.deepEqual(r.config.byok.custom, { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-4-scout:free' }, 'Other’s model is saved with its service');
});

test('caps and privacy: checked, saved, applied live (the player\'s own spend cap in the backend, none by default; companion turns and game context in the core\'s config)', async (t) => {
  const r = await rig(t, { keys: ['anthropic'] });
  // No limits of ours (the owner, 2026-09-26): no cap until the player sets one, never pre-filled.
  assert.deepEqual(await r.api.caps(), { dailyUsd: null, spentTodayMicros: 0 });
  assert.deepEqual(await r.api.setCaps({ dailyUsd: 2.5 }), { ok: true });
  assert.deepEqual(await r.api.caps(), { dailyUsd: 2.5, spentTodayMicros: 0 });
  assert.equal(r.backend.caps.config().dailyUsd, 2.5);
  assert.equal((await r.api.status()).backend.usage.capMicros, 2_500_000);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).byok.caps, { v: 2, dailyUsd: 2.5 }, 'saved with v: 2, so a relaunch keeps it as the player\'s');
  // An older window's typedPerDay and autoPerDay are ignored: those limits are gone.
  assert.deepEqual(await r.api.setCaps({ dailyUsd: 3, typedPerDay: 50, autoPerDay: 5 }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).byok.caps, { v: 2, dailyUsd: 3 });
  // Cleared: no cap again.
  assert.deepEqual(await r.api.setCaps({ dailyUsd: null }), { ok: true });
  assert.deepEqual(await r.api.caps(), { dailyUsd: null, spentTodayMicros: 0 });
  assert.equal(r.backend.caps.config().dailyUsd, null);
  assert.equal((await r.api.status()).backend.usage.capMicros, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).byok.caps, { v: 2, dailyUsd: null });

  assert.deepEqual(await r.api.privacy(), { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: true });
  const p = { identity: true, otherNames: false, companion: true, echo: true, gameContext: false, screenReading: true };
  assert.deepEqual(await r.api.setPrivacy(p), { ok: true });
  assert.deepEqual(await r.api.privacy(), p);
  // The one place the switches live (code health BR-28): the core reads byok.privacy, no copy.
  assert.deepEqual(r.config.byok.privacy, p, 'automatic turns on, game context off, where the core reads them');
  assert.deepEqual([r.config.companion, r.config.gameContext], [undefined, undefined]);
  assert.equal(r.backend.diagnostics().settings.identity, true, 'the backend sends the character\'s name now');
});

// The screen-reading switch (SY-05): an off that couldn't be saved would come back at the next launch,
// so it isn't applied either: the call fails and the switch stays on.
// chmod can't lock the owner out on Windows or as root (as ledger_test's lockOutSkip).
const readOnlySkip = process.platform === 'win32' ? "chmod can't make a folder unwritable to its owner on Windows" : process.getuid?.() === 0 ? "running as root, whom chmod can't lock out" : false;
test('setPrivacy: Screen reading that can\'t be saved isn\'t applied; the call says so', { skip: readOnlySkip }, async (t) => {
  const r = await rig(t);
  const dir = path.dirname(r.configFile);
  if (fs.existsSync(r.configFile)) fs.chmodSync(r.configFile, 0o400);
  fs.chmodSync(dir, 0o500);
  t.after(() => { fs.chmodSync(dir, 0o700); if (fs.existsSync(r.configFile)) fs.chmodSync(r.configFile, 0o600); });
  const p = await r.api.privacy();
  assert.deepEqual(await r.api.setPrivacy({ ...p, screenReading: false }), { ok: false, error: 'failed' });
  assert.equal((await r.api.privacy()).screenReading, true, 'still on, as saved');
});

test('setCaps: a cap the backend refuses isn\'t shown or saved as if it held (reviews of the no-limits change)', async (t) => {
  const r = await rig(t, { keys: ['anthropic'] });
  assert.deepEqual(await r.api.setCaps({ dailyUsd: 2 }), { ok: true });
  const take = r.backend.setConfig;
  r.backend.setConfig = async () => { throw new Error('refused'); };
  assert.deepEqual(await r.api.setCaps({ dailyUsd: 5 }), { ok: false, error: 'failed' });
  assert.deepEqual(await r.api.caps(), { dailyUsd: 2, spentTodayMicros: 0 }, 'still the one in force');
  assert.deepEqual(await r.api.setCaps({ dailyUsd: null }), { ok: false, error: 'failed' });
  assert.equal((await r.api.caps()).dailyUsd, 2);
  assert.equal(r.backend.caps.config().dailyUsd, 2);
  r.backend.setConfig = take;
  assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).byok.caps, { v: 2, dailyUsd: 2 });
});

test('the runaway fuse (the core\'s; spec §9.9): status().backend.usage and usage().today carry autoPaused: true while the bridge says it holds; left out otherwise', async (t) => {
  let holds = true;
  const bridge = { status: () => ({ version: '0.3.1', seq: 0, push: 0, companion: { today: 11, gamePid: null, autoPaused: holds } }), store: { state: { chats: {}, tokens: {} } } };
  const r = await rig(t, { keys: ['anthropic'], bridge });
  const st = await r.api.status();
  assert.equal(st.backend.usage.autoPaused, true);
  assert.deepEqual(st.backend.usage.fuse, { turns: 10, windowMs: 60_000 }, 'the window that tripped: the core\'s autoPausedBy, else the per-minute one');
  assert.match(st.view.checkIns.line, /^NeverQuestAlone paused check-ins: more than 10 came in a minute, which normal play doesn’t do\. Your next message turns them back on\.$/);
  assert.equal((await r.api.usage({ days: 1 })).today.autoPaused, true);
  // The hourly window (systems plan D4), when the core says it's the one that tripped.
  bridge.status = () => ({ version: '0.3.1', seq: 0, push: 0, companion: { today: 61, gamePid: null, autoPaused: holds, autoPausedBy: { turns: 60, windowMs: 3_600_000 } } });
  assert.match((await r.api.status()).view.checkIns.line, /more than 60 came in an hour/);
  bridge.status = () => ({ version: '0.3.1', seq: 0, push: 0, companion: { today: 11, gamePid: null, autoPaused: holds } });
  // Otherwise the mock's shape.
  const mock = createMockApi({ delayMs: 0, controllable: true });
  mock.control.reset({ keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null }, addonInstalled: true });
  holds = false;
  const [off, ms] = [await r.api.status(), await mock.status()];
  assert.equal(Object.hasOwn(off.backend.usage, 'autoPaused'), false);
  assert.deepEqual(keysOf(off.backend.usage), keysOf(ms.backend.usage), 'the mock\'s shape with the fuse off');
  assert.equal(Object.hasOwn((await r.api.usage({ days: 1 })).today, 'autoPaused'), false);
});

test('a turn, then usage, lastRequest and transcripts in the window\'s shapes', async (t) => {
  const r = await rig(t, { keys: ['anthropic'], handler: () => reply('Mulgore, near Red Cloud Mesa.', { input: 1500, output: 60 }) });
  const sent = await r.backend.send(sendParams(CHAT, 'a3f1_1', 'what zone am I in?'));
  assert.equal(sent.status, 'started');
  await waitFor(async () => ((await r.api.usage({ days: 7 })).replies ?? []).length === 1, 5000, 'the reply counted');
  const u = await r.api.usage({ days: 7 });
  const mu = await createMockApi({ delayMs: 0 }).usage({ days: 7 });
  assert.deepEqual(keysOf(u), keysOf(mu));
  assert.equal(u.today.turns, 1);
  assert.ok(u.today.spentMicros > 0);
  assert.equal(u.days[0].turns, 1, 'today first');
  assert.ok(u.days.length <= 7);
  assert.deepEqual(keysOf(u.days[0]), ['auto', 'day', 'spentMicros', 'turns']);
  assert.deepEqual(u.perProvider.map(p => [p.provider, p.name, p.turns, p.auto]), [['anthropic', 'Anthropic', 1, 0]]);
  assert.deepEqual(keysOf(u.perProvider[0]), keysOf(mu.perProvider[0]), 'the mock\'s shape');
  assert.deepEqual(keysOf(u.replies[0]).filter(k => !['provider', 'auto', 'error'].includes(k)), keysOf(mu.replies[0]));
  assert.equal(u.replies[0].model, 'claude-sonnet-5-5', 'Claude\'s default (fix-102)');
  assert.equal(u.replies[0].in, 1500);

  const lr = await r.api.lastRequest(CHAT);
  assert.deepEqual(keysOf(lr).filter(k => k !== 'purpose'), keysOf(await createMockApi({ delayMs: 0 }).lastRequest()));
  assert.equal(lr.chatId, CHAT);
  assert.equal(lr.provider, 'anthropic');
  assert.equal(lr.request.method, 'POST');
  assert.match(lr.request.url, /\/v1\/messages$/);
  assert.match(lr.request.headers['x-api-key'], /^sk-ant-…xxxx \(redacted\)$/);
  assert.ok(JSON.stringify(lr.request.body).includes('what zone am I in?'), 'what the model saw');
  noCanary('lastRequest', lr);
  // A chat with no request yet this session (they're kept in memory only): the chat list stays,
  // so the window can still offer the others; request: null is its "No requests yet".
  const none = await r.api.lastRequest('c000000');
  assert.deepEqual(none, { chats: none.chats, chatId: 'c000000', at: null, provider: null, model: null, request: null });
  assert.ok(Array.isArray(none.chats));

  assert.deepEqual(await r.api.transcripts({ deleteAll: false }), { ok: true, count: 1, retentionDays: 30 });
  assert.deepEqual(await r.api.transcripts({ deleteAll: true }), { ok: true, deleted: 1, retentionDays: 30 });
  assert.deepEqual(await r.api.transcripts({ deleteAll: false }), { ok: true, count: 0, retentionDays: 30 });
  assert.deepEqual(scanDirForCanaries(r.dataDir), [], 'nothing the bridge wrote holds a key');
});

test('memory: the characters, one\'s digest (never its folder), forget', async (t) => {
  const r = await rig(t, { keys: ['anthropic'] });
  assert.deepEqual(await r.api.memory(), { chars: [] });
  const dir = path.join(r.dataDir, 'memory', 'Tavi-Testrealm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character.md'), '# Tavi\n\n<!-- nqa:facts:start -->\n- Level 6 Tauren Warrior\n<!-- nqa:facts:end -->\n\nBuild plan: arms.\n');
  fs.writeFileSync(path.join(dir, 'log.md'), '- 2026-09-26 Reached level 6\n');
  assert.deepEqual(await r.api.memory(), { chars: ['Tavi-Testrealm'] });
  const m = await r.api.memory('Tavi-Testrealm');
  assert.deepEqual(keysOf(m), ['char', 'digest', 'notes', 'updated']);
  assert.equal(m.char, 'Tavi-Testrealm');
  assert.equal(typeof m.digest, 'string');
  assert.ok(!JSON.stringify(m).includes(r.dataDir), 'no folder path');
  assert.equal((await r.api.memory('Nobody-Here')).error, 'not_found');
  assert.equal((await r.api.memory('../../etc')).error, 'bad_input');
  assert.deepEqual(await r.api.forgetMemory('Tavi-Testrealm'), { ok: true });
  assert.equal(fs.existsSync(dir), false);
  assert.equal((await r.api.forgetMemory('')).error, 'bad_input');
});

test('findWow, installAddon (the bridge restarts for a new folder), wowRunning; refused while WoW runs', async (t) => {
  const root = tmpDir('bones-wowroot-');
  const flavor = path.join(root, '_forever_');
  fs.mkdirSync(path.join(flavor, 'Interface', 'AddOns'), { recursive: true });
  fs.mkdirSync(path.join(flavor, 'WTF', 'Account', 'ACCT'), { recursive: true });
  let running = false;
  const run = (cmd) => (running ? wowProcess(cmd) : { status: 1, stdout: '' });
  const r = await rig(t, { keys: ['anthropic'], wow: { roots: [root], run } });
  r.config.transport.slots = 3;
  const fw = await r.api.findWow();
  assert.deepEqual(fw, { found: true, path: flavor, flavor: '_forever_', account: 'ACCT', running: false, addon: false, candidates: [{ path: flavor, flavor: '_forever_', account: 'ACCT', addon: false }] });
  assert.deepEqual(await r.api.wowRunning(), { running: false });
  running = true;
  assert.deepEqual(await r.api.wowRunning(), { running: true });
  const refused = await r.api.installAddon();
  assert.equal(refused.error, 'wow_running');
  assert.match(refused.detail, new RegExp(RESTART_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(r.restarts.length, 0);
  running = false;
  const res = await r.api.installAddon();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.steps.map(s => s.ok), [true, true, true, true]);
  assert.equal(res.restartNeeded, true);
  assert.equal(r.restarts.length, 1, 'a new folder: the bridge starts for it');
  assert.equal(r.config.wow.flavorDir, flavor);
  assert.equal(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).wow.flavorDir, flavor);
  assert.ok(fs.existsSync(path.join(flavor, 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc')));
  // The parts' row in the game's AddOns list, folded for its first start and recorded once in the
  // app's config (C-119), which the save after the install keeps.
  assert.equal(JSON.parse(fs.readFileSync(r.configFile, 'utf8')).partsFolded, SLOT_CATEGORY);
  assert.match(fs.readFileSync(addonListFile(flavor), 'latin1'), /\["NeverQuestAlone Parts"\] = true/);
  assert.ok(r.lines.map(l => JSON.parse(l)).some(l => l.k === 'app-addon-installed' && l.partsFold === 'folded'), 'logged');
  assert.equal((await r.api.status()).wow.addon, true);
  assert.equal((await r.api.installAddon({ flavorDir: '/somewhere/else' })).error, 'wow_not_found', 'only a folder findWow knows');
  assert.ok(ADDON_SOURCE);
});

test('useWowFolder (D-09): a folder the player chose holds WoW: Forever (the flavor folder or the one above it); findWow then offers it and installAddon accepts it', async (t) => {
  const root = tmpDir('bones-chosen-');
  const flavor = path.join(root, '_forever_');
  fs.mkdirSync(path.join(flavor, 'Interface', 'AddOns'), { recursive: true });
  const r = await rig(t, { keys: ['anthropic'], wow: { roots: [] } });
  r.config.transport.slots = 3;
  assert.equal((await r.api.findWow()).found, false, 'not in the usual places');
  assert.equal((await r.api.installAddon({ flavorDir: flavor })).error, 'wow_not_found', 'not before it was chosen');
  const other = tmpDir('bones-not-wow-');
  const no = await r.api.useWowFolder(other);
  assert.equal(no.error, 'not_wow');
  assert.match(no.detail, /doesn’t have World of Warcraft: Forever in it/);
  for (const bad of [42, '', 'relative/path', `${root}\u0000x`]) assert.equal((await r.api.useWowFolder(bad)).error, 'bad_input', String(bad));
  const yes = await r.api.useWowFolder(root);
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(yes.path, flavor, 'the flavor folder under the one chosen');
  assert.deepEqual(yes.candidates.map(c => c.path), [flavor]);
  assert.equal((await r.api.useWowFolder(flavor)).path, flavor, 'the flavor folder itself works too');
  assert.equal((await r.api.findWow()).path, flavor, 'findWow offers it from now on');
  const inst = await r.api.installAddon({ flavorDir: flavor });
  assert.equal(inst.ok, true, JSON.stringify(inst));
  assert.equal(r.config.wow.flavorDir, flavor);
  assert.equal((await r.api.findWow()).candidates[0].addon, true, 'each candidate says whether the addon is there');
});

test('connections: the ledger split into allowed and refused, and the honest note; no self-test and no extra hosts (SY-13, D6)', async (t) => {
  const rows = [
    { host: 'api.anthropic.com', port: 443, feature: 'provider', allowed: true, count: 4, first: 1, last: 9 },
    { host: 'evil.example', port: 443, feature: 'unknown', allowed: false, count: 1, first: 5, last: 5 },
  ];
  const r = await rig(t, { keys: ['anthropic'], egressRows: rows });
  const c = await r.api.connections();
  assert.deepEqual(c.rows, [{ host: 'api.anthropic.com', port: 443, count: 4, first: 1, last: 9, feature: 'provider' }]);
  assert.deepEqual(c.blocked, [{ host: 'evil.example', port: 443, count: 1, first: 5, last: 5, feature: 'unknown' }]);
  assert.match(c.note, /every host the app itself connected to/);
  assert.deepEqual(Object.keys(c).sort(), ['blocked', 'note', 'rows']);
  assert.equal(r.api.setExtraHost, undefined);
});

test('diagnostics (SL-7): versions, OS, config, status, connections, log lines; never a key, the install token, the home folder or message text', async (t) => {
  const r = await rig(t, { keys: ['anthropic'], handler: () => reply('A secret reply about Mulgore.', { input: 100, output: 10 }) });
  await r.backend.send(sendParams(CHAT, 'a3f1_2', 'my private question'));
  await waitFor(async () => (await r.api.usage({ days: 1 })).replies.length === 1, 5000, 'reply');
  const api2 = createAppApi({
    backend: r.backend, keystore: r.keystore, config: r.config, paths: { userData: r.dataDir }, home: r.home, manifests: loadManifests(),
    logLines: () => [`${new Date().toISOString()} hello {"token":"3fa9c2d1","file":"${r.home}/Library/x"}`, `key ${CANARY_KEYS.anthropic} read`],
    bridge: {
      status: () => ({ version: '0.3.1', seq: 3, push: 2, pushOk: 1, token: { sig: 'ok' }, reading: { unreadMs: 12400 },
        publishes: { publishes: 9, lastFiles: 13, ms: 2, slotErrors: 1, slotRetries: 4 }, signalErrors: 0, signalRetries: 2,
        slotWindow: { mode: 'ring', from: 3, to: 14 }, store: { problems: [{ file: 'state.json', error: 'parse', keptAs: 'state.json.corrupt-1' }], behind: null } }),
      store: { state: { tokens: { '3fa9c2d1': {} }, chats: {} } },
    },
  });
  const { text } = await api2.diagnostics();
  // SY-08, SY-18: the transport's counts (the NTFS retries among them) are in Diagnostics, one line.
  assert.match(text, /\ntransport: push 2 \(ok 1\) · unread 12 s · publishes 9, last 13 files in 2 ms · slot errors 1, retries 4 · bell errors 0, retries 2 · window ring 3-14 · store moved aside state\.json:parse\n/);
  assert.match(text, /^== NeverQuestAlone \(bridge\) ==\nbridge /);
  assert.match(text, /Node \d+\.\d+/);
  assert.match(text, new RegExp(`${process.platform} `));
  assert.match(text, /config: \{"wow":\{"flavorDir":"[^"]*nowhere"\},"byok":\{"provider":"anthropic"/);
  assert.match(text, /status: \{/);
  assert.match(text, /== Last log lines ==/);
  assert.ok(!text.includes('CANARY'), 'no key');
  assert.ok(!text.includes('3fa9c2d1'), 'no install token');
  assert.ok(!text.includes(r.home), 'no home folder');
  assert.ok(!text.includes('my private question') && !text.includes('A secret reply'), 'no message text');
  await api2.stop();
});

test('onChange: status pushes, debounced, only when something changed; stop ends them', async (t) => {
  const r = await rig(t, { keys: ['anthropic'] });
  const got = [];
  const off = r.api.onChange(s => got.push(s));
  r.api.changed();
  r.api.changed();
  r.api.changed();
  await waitFor(() => got.length === 1, 2000, 'one push');
  r.api.changed();
  await new Promise(res => setTimeout(res, 300));
  assert.equal(got.length, 1, 'the same status is not pushed again');
  await r.api.setPaused(true);
  await waitFor(() => got.length === 2, 2000, 'paused pushed');
  assert.equal(got[1].backend.rt.state, 'paused');
  assert.equal(got[1].bridge.paused, true);
  off();
  await r.api.setPaused(false);
  await new Promise(res => setTimeout(res, 300));
  assert.equal(got.length, 2);
});

test('uninstall: every key out of the store, the app\'s data out of its folder; the addon folders only when asked and never while WoW runs', async (t) => {
  const root = tmpDir('bones-wowroot-');
  const flavor = path.join(root, '_forever_');
  const addons = path.join(flavor, 'Interface', 'AddOns');
  for (const d of ['NeverQuestAlone', 'NQA_S001', 'NQA_S002', 'NQA_Data', 'SomeoneElsesAddon']) fs.mkdirSync(path.join(addons, d), { recursive: true });
  // The game's copy of the chats in each account's SavedVariables (code health AP-11), beside other addons' files.
  const saved = (account, name) => path.join(flavor, 'WTF', 'Account', account, 'SavedVariables', name);
  for (const [account, name] of [['ACCOUNT1', 'NeverQuestAlone.lua'], ['ACCOUNT1', 'NeverQuestAlone.lua.bak'], ['ACCOUNT1', 'SomeoneElsesAddon.lua'], ['ACCOUNT2', 'NeverQuestAlone.lua'], ['ACCOUNT2', 'Blizzard_Console.lua']]) {
    fs.mkdirSync(path.dirname(saved(account, name)), { recursive: true });
    fs.writeFileSync(saved(account, name), 'NQADB = { chats = {} }\n');
  }
  fs.mkdirSync(path.join(flavor, 'WTF', 'Account', 'ACCOUNT3'), { recursive: true }); // an account with nothing saved yet
  fs.writeFileSync(path.join(flavor, 'WTF', 'Account', 'config-cache.wtf'), 'a file, not an account');
  const savedLeft = () => fs.readdirSync(path.join(flavor, 'WTF', 'Account')).filter(a => fs.statSync(path.join(flavor, 'WTF', 'Account', a)).isDirectory())
    .flatMap(a => (fs.existsSync(path.dirname(saved(a, 'x'))) ? fs.readdirSync(path.dirname(saved(a, 'x'))).map(f => `${a}/${f}`) : [])).sort();
  let running = true;
  const run = (cmd) => (running ? wowProcess(cmd) : { status: 1, stdout: '' });
  const r = await rig(t, { keys: ['anthropic', 'google'], flavorDir: flavor, wow: { run }, handler: () => reply('Mulgore.', { input: 100, output: 5 }) });
  await r.keystore.set('custom', CANARY_KEYS.openrouter);
  await r.keystore.set('openrouter', CANARY_KEYS.openrouter); // saved before Other replaced OpenRouter's card
  // Data a session leaves: a turn (ledger, transcript, usage), a memory note, the settings, the core's store.
  await r.backend.send(sendParams(CHAT, 'k1', 'where am I?'));
  await waitFor(async () => (await r.api.usage({ days: 1 })).replies.length === 1, 5000, 'reply');
  fs.mkdirSync(path.join(r.dataDir, 'memory', 'Tavi-Testrealm'), { recursive: true });
  fs.writeFileSync(path.join(r.dataDir, 'memory', 'Tavi-Testrealm', 'notes.md'), 'Grouped with Thrall.\n');
  fs.mkdirSync(path.join(r.dataDir, 'bridge'));
  fs.writeFileSync(path.join(r.dataDir, 'bridge', 'state.json'), '{}');
  await r.api.setCaps({ dailyUsd: 2 });
  fs.writeFileSync(path.join(r.dataDir, 'not-ours.txt'), 'kept');
  const before = fs.readdirSync(r.dataDir);
  for (const f of ['ledger.json', 'transcripts', 'memory', 'config.json', 'bridge']) assert.ok(before.includes(f), `${f} in ${before}`);
  assert.equal((await r.api.uninstall({ removeAddon: true })).error, 'wow_running');
  assert.deepEqual(await r.keystore.list([...await r.keystore.list(), 'openrouter']), ['anthropic', 'google', 'custom', 'openrouter'], 'nothing removed');
  assert.ok(fs.existsSync(path.join(r.dataDir, 'ledger.json')));
  assert.equal(savedLeft().length, 5, 'the game’s files untouched while WoW runs (it would write them back)');
  running = false;
  assert.deepEqual(await r.api.uninstall({ removeAddon: true }), { ok: true, removed: ['keys', 'data', 'addon', 'slots', 'doorbells', 'savedVariables'] });
  assert.deepEqual(await r.keystore.list([...await r.keystore.list(), 'openrouter']), [], 'every provider’s key, and the old OpenRouter one');
  assert.deepEqual(fs.readdirSync(r.dataDir), ['not-ours.txt'], 'only what the bridge keeps there, by name');
  assert.deepEqual(fs.readdirSync(addons), ['SomeoneElsesAddon'], 'only ours');
  assert.deepEqual(savedLeft(), ['ACCOUNT1/SomeoneElsesAddon.lua', 'ACCOUNT2/Blizzard_Console.lua'], 'every account’s NeverQuestAlone.lua and .bak (installer.nsh’s rule); other addons’ files stay');
  assert.ok(fs.existsSync(path.join(flavor, 'WTF', 'Account', 'config-cache.wtf')));
});

test('uninstall without "remove the addon" leaves the game’s copy of the chats, as it leaves the addon (code health AP-11)', async (t) => {
  const flavor = path.join(tmpDir('bones-wowroot-'), '_forever_');
  const file = path.join(flavor, 'WTF', 'Account', 'ACCOUNT1', 'SavedVariables', 'NeverQuestAlone.lua');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'NQADB = {}\n');
  fs.mkdirSync(path.join(flavor, 'Interface', 'AddOns', 'NeverQuestAlone'), { recursive: true });
  const r = await rig(t, { flavorDir: flavor, wow: { run: () => ({ status: 1, stdout: '' }) } });
  assert.deepEqual(await r.api.uninstall({ removeAddon: false }), { ok: true, removed: ['keys', 'data'] });
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(flavor, 'Interface', 'AddOns', 'NeverQuestAlone')));
});

test('status carries the model check\'s notice when there is one (PV-3, §10)', async () => {
  let notice = null;
  const backend = { status: () => ({ rt: { state: 'ready' }, provider: { id: 'anthropic', model: 'claude-sonnet-5-5' }, usage: null, notice }) };
  const api = createAppApi({ backend, keystore: createKeyStore({ backend: 'memory' }), config: configWithDefaults({ wow: { flavorDir: '/nowhere' } }), paths: { userData: tmpDir('nqa-api-') }, wow: { run: () => ({ status: 1, stdout: '' }) } });
  assert.equal(Object.hasOwn((await api.status()).backend, 'notice'), false, 'none: the mock\'s shape');
  notice = { kind: 'model_switched', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', at: 1 };
  // With each model's name from the manifest, so the window never says a raw id (UX-W35).
  assert.deepEqual((await api.status()).backend.notice, { ...notice, fromName: 'Claude Sonnet 5', toName: 'Claude Haiku 4.5' });
  notice = { kind: 'model_switched', from: 'claude-old-1', to: 'claude-haiku-4-5', at: 2 };
  assert.deepEqual((await api.status()).backend.notice, { ...notice, toName: 'Claude Haiku 4.5' }, 'a model the manifest no longer lists has no name');
  await api.stop();
});

// SY-102-5: Claude Haiku 4.5 retires "not sooner than October 15, 2026" and nothing no dearer replaces
// it; the 1.0.0 install base saved it by name. While it's the model in use the status says so before
// the day, from the manifest (retiresAfter, moveTo), with both models' names; the model check's own
// notice (a switch, a retired model) says more and comes first.
test('status says a retiring model in use before its day, from the manifest, and only for that model (SY-102-5)', async () => {
  let model = 'claude-haiku-4-5';
  let notice = null;
  let id = 'anthropic';
  const backend = { status: () => ({ rt: { state: 'ready' }, provider: { id, model }, usage: null, notice }) };
  const api = createAppApi({ backend, keystore: createKeyStore({ backend: 'memory' }), config: configWithDefaults({ wow: { flavorDir: '/nowhere' } }), paths: { userData: tmpDir('nqa-api-') }, wow: { run: () => ({ status: 1, stdout: '' }) } });
  const want = { kind: 'model_retiring', model: 'claude-haiku-4-5', after: '2026-10-15', to: 'claude-sonnet-5-5', at: null, name: 'Claude Haiku 4.5', toName: 'Claude Sonnet 5.5' };
  const st = await api.status();
  assert.deepEqual(st.backend.notice, want);
  model = 'claude-sonnet-5-5';
  const without = await api.status();
  model = 'claude-haiku-4-5';
  assert.equal(st.view.key, without.view.key, 'news, not a state: the view and the tray are as ever');
  assert.equal(st.view.needsPlayer, without.view.needsPlayer);
  for (const other of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5', '']) {
    model = other;
    assert.equal(Object.hasOwn((await api.status()).backend, 'notice'), false, other || 'no model');
  }
  model = 'claude-haiku-4-5';
  notice = { kind: 'model_retired', model: 'claude-haiku-4-5', at: 3 };
  assert.deepEqual((await api.status()).backend.notice, { ...notice, name: 'Claude Haiku 4.5' }, 'once it\'s gone, the retired card says it');
  notice = null;
  id = 'openai';
  model = 'claude-haiku-4-5';
  assert.equal(Object.hasOwn((await api.status()).backend, 'notice'), false, 'another AI\'s manifest has no such model');
  await api.stop();
});


// One publisher (display DR-04, SY-20): the window's screen state is the capture watchdog's, the same
// the game's row reads (bridge status().capture), never the app's own ranking of the helper's errors.
test('DR-04 (SY-20): the window\'s screen state is the watchdog\'s: a helper\'s own error names nothing; what the watchdog publishes does, with its fix per OS; the addon\'s reload mode shows as no screen reading', async (t) => {
  let capture = { state: 'ok', cause: null, since: 1, minimized: false, seen: true, game: true, connected: true };
  let cs = { kind: 'windows-helper', connected: true, window: { w: 1, h: 1 }, stats: { decoded: 3 }, error: null };
  let token = { sig: 'ok' };
  const bridge = { status: () => ({ version: '0.3.1', seq: 1, push: 1, companion: { gamePid: 4242 }, token, capture }), store: { state: { chats: {}, tokens: {} } } };
  // Each helper on its own OS: what a fix says is the platform's (Screen Recording is a Mac's).
  const apiOn = (platform) => {
    const a = createAppApi({ bridge, capture: { status: () => cs }, keystore: createKeyStore({ backend: 'memory' }), config: configWithDefaults({ byok: { provider: 'anthropic' } }), home: tmpDir('bones-home-'), platform, wow: { run: () => ({ status: 1, stdout: '' }), roots: [] } });
    t.after(() => a.stop());
    return a;
  };
  let api = apiOn('win32');
  assert.equal((await api.status()).capture.state, 'ok');
  // The helper holds a typed error in its status: on its own it names nothing (the watchdog decides,
  // after its wait, whether it's a problem, a hold or nothing).
  cs = { ...cs, error: { kind: 'window_minimized', message: 'x', at: 1 } };
  assert.equal((await api.status()).capture.state, 'ok');
  assert.equal(noteGone(api), true, 'no second store of the helper\'s errors (SY-27)');
  // The watchdog published no_signal: can't see the game, the tray asks while WoW runs.
  capture = { ...capture, state: 'no_signal', cause: 'blind' };
  let st = await api.status();
  assert.equal(st.capture.state, 'no_signal');
  assert.equal(st.view.screen.ok, false);
  assert.equal(st.view.needsPlayer, true, 'WoW runs (the helper\'s game pid): the tray asks');
  assert.equal(st.wow.running, true, 'the game\'s own pid, no process list');
  // A Mac: a revoked permission is Screen Recording's fix.
  api = apiOn('darwin');
  cs = { kind: 'mac-app', connected: true, permission: false, window: null, stats: null, error: null };
  capture = { ...capture, state: 'no_permission', cause: 'no_permission' };
  st = await api.status();
  assert.deepEqual([st.capture.state, st.view.screen.detail, st.view.screen.action], ['no_permission', 'Allow Screen Recording in System Settings.', 'screen_recording']);
  capture = { ...capture, state: 'ok', cause: null };
  cs = { ...cs, permission: true };
  assert.equal((await api.status()).capture.state, 'ok');
  // The addon on the reload path (/nqa mode reload; its hello says mode=reload).
  token = { sig: 'ok', mode: 'reload' };
  st = await api.status();
  assert.equal(st.capture.mode, 'reload');
  assert.equal(st.view.screen.mode, 'none');
  assert.equal(st.view.screen.detail, 'Nothing is drawn, so your messages wait for a reload, and replies still come in.');
});
const noteGone = api => api.noteCaptureError === undefined;

// The screen state DR-06's card reads (display DR-06's bridge half, SY-27): the watchdog's published
// state, else the app's own: waiting (WoW closed, or the helper not started), window_minimized (said,
// never an alarm) and watching (no strip read since the helper's current attach: no claim either way).
// "NeverQuestAlone can see the game." only after a strip read since that attach. A problem with the game's window
// gives way to waiting while WoW is closed; one with the helper or the Mac's permission doesn't.
test('DR-06 (SY-27): the screen state from the watchdog\'s view: its published problem first; else waiting with WoW closed or the helper not started, a minimized WoW without an alarm, and "can see the game" only after a strip read since the attach', async (t) => {
  const base = { state: 'ok', cause: null, since: 1, minimized: false, seen: true, game: true, connected: true };
  let capture = base;
  let gamePid = 4242;
  const cs = { kind: 'windows-helper', connected: true, window: { w: 1, h: 1 }, stats: { decoded: 3 }, error: null };
  const bridge = { status: () => ({ version: '0.3.1', seq: 1, push: 1, companion: { gamePid }, token: { sig: 'ok' }, capture }), store: { state: { chats: {}, tokens: {} } } };
  // A clock past the app's 5 s look at the process list between views: WoW closed reads as closed.
  let clock = 1_000_000;
  const api = createAppApi({ bridge, capture: { status: () => cs }, keystore: createKeyStore({ backend: 'memory' }), config: configWithDefaults({ byok: { provider: 'anthropic' } }), home: tmpDir('bones-home-'), platform: 'win32', now: () => clock, wow: { run: () => ({ status: 1, stdout: '' }), roots: [] } });
  t.after(() => api.stop());
  const view = async (c, pid = 4242) => { capture = { ...base, ...c }; gamePid = pid; clock += 10_000; const st = await api.status(); return [st.capture.state, st.view.screen.ok, st.view.screen.ok === false && st.wow.running === true, st.view.screen.action ?? null]; };
  // [state, the card's ok, the tray asks about screen reading (a problem while WoW runs), the card's action]
  assert.deepEqual(await view({}), ['ok', true, false, null]);
  assert.deepEqual(await view({ seen: false }), ['watching', true, false, null], 'nothing read since the attach: no claim');
  assert.deepEqual(await view({ connected: false }), ['waiting', true, false, null], 'the helper not started yet');
  assert.deepEqual(await view({ game: false }, 0), ['waiting', true, false, null], 'WoW closed');
  assert.deepEqual(await view({ minimized: true }), ['window_minimized', true, false, null], 'a minimized WoW: no alarm while it runs');
  // A published problem keeps its headline and action, minimized or not.
  assert.deepEqual(await view({ state: 'no_signal', cause: 'blind', minimized: true }), ['no_signal', false, true, 'restart_capture']);
  assert.deepEqual(await view({ state: 'blocked', cause: 'capture_blocked_by_app' }), ['blocked', false, true, null]);
  assert.deepEqual(await view({ state: 'unsupported', cause: 'capture_unsupported' }), ['unsupported', false, true, 'no_screen_reading'], 'SY-24: its own words and action');
  // WoW closed: the game's window has no problem to name; the helper and the permission still do.
  assert.deepEqual(await view({ state: 'no_signal', cause: 'blind', game: false }, 0), ['waiting', true, false, null]);
  assert.deepEqual(await view({ state: 'blocked', cause: 'capture_blocked_by_app', game: false }, 0), ['waiting', true, false, null]);
  assert.deepEqual(await view({ state: 'damaged', cause: 'helper_missing', game: false }, 0), ['damaged', false, false, 'download'], 'said; the tray asks only while WoW runs');
  assert.deepEqual(await view({ state: 'off' }), ['off', true, false, null]);
  // The window's status carries only the state (never the stats), whatever the view holds (SY-10).
  capture = { ...base, lastStats: { interval: { frames: 40 } }, window: { pid: 4242 } };
  const st = await api.status();
  assert.deepEqual(Object.keys(st.capture).sort(), ['mode', 'signals', 'state', 'steps']);
});

// The real Windows supervisor (capture.mjs, DR-03) behind the button, with a stand-in for the helper's process.
function standInChild() {
  const c = new EventEmitter();
  c.stdin = { on() {}, end() {} };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = false;
  c.kill = () => { c.killed = true; setImmediate(() => { c.emit('exit', null, 'SIGTERM'); c.emit('close', null, 'SIGTERM'); }); };
  return c;
}

test('DR-06: restartCapture starts screen reading over through the supervisor: a running helper is stopped and comes back once; one that can\'t start is looked for at once, once (never twice); the watchdog counts its backoff from the click; without a helper it says so', async (t) => {
  const resets = [];
  const bridge = { status: () => ({ version: '0.3.1', seq: 0, push: 0, companion: {}, capture: { state: 'no_signal', cause: 'blind', since: 1, minimized: false, seen: false, game: true, connected: true } }),
    captureHealth: { reset: () => resets.push('reset') }, store: { state: { chats: {}, tokens: {} } } };
  const dir = tmpDir('bones-cap-');
  const exe = path.join(dir, 'nqa-capture.exe');
  fs.writeFileSync(exe, 'MZ');
  const spawns = [];
  const errors = [];
  const supervisor = () => createWindowsCapture({ exe, relaunchMs: 20, retryMs: [60_000], onError: e => errors.push(e),
    spawnImpl: () => { const c = standInChild(); spawns.push(c); return c; } });
  const appApi = capture => createAppApi({ bridge, capture, keystore: createKeyStore({ backend: 'memory' }), config: configWithDefaults({ byok: { provider: 'anthropic' } }), home: tmpDir('bones-home-'), platform: 'win32', wow: { run: () => ({ status: 1, stdout: '' }), roots: [] } });
  // A running helper: stopped, and relaunched once as after any exit.
  const cap = supervisor();
  const api = appApi(cap);
  t.after(() => { api.stop(); cap.stop(); });
  cap.start();
  await waitFor(() => spawns.length === 1, 2000, 'the helper launched');
  spawns[0].stdout.emit('data', Buffer.from('{"info":"nqa-capture started"}\n'));
  await waitFor(() => cap.status().connected, 2000, 'connected');
  assert.deepEqual(await api.restartCapture(), { ok: true, restarted: true });
  assert.equal(spawns[0].killed, true);
  await waitFor(() => spawns.length === 2, 2000, 'relaunched');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(spawns.length, 2, 'once');
  assert.deepEqual(resets, ['reset'], 'the watchdog counts its backoff from the click');
  assert.equal((await api.status()).view.screen.action, 'restart_capture', 'the card\'s one action for no_signal');
  // A helper that can't start (quarantined): the backoff's next try is a minute away; the click looks at
  // once, exactly once, and a helper that's back starts.
  fs.rmSync(exe);
  const gone = supervisor();
  const api2 = appApi(gone);
  t.after(() => { api2.stop(); gone.stop(); });
  const launched = spawns.length;
  gone.start();
  await waitFor(() => errors.filter(e => e.kind === 'helper_missing').length === 1, 2000, 'helper_missing');
  assert.deepEqual(await api2.restartCapture(), { ok: true, restarted: true });
  assert.equal(errors.filter(e => e.kind === 'helper_missing').length, 2, 'looked for once more, not twice');
  fs.writeFileSync(exe, 'MZ');
  assert.deepEqual(await api2.restartCapture(), { ok: true, restarted: true });
  await waitFor(() => spawns.length === launched + 1, 2000, 'back, it starts');
  // No helper at all (screen reading off in the app): nothing to restart.
  const none = appApi(null);
  t.after(() => none.stop());
  assert.deepEqual(await none.restartCapture(), { ok: false, error: 'no_capture' });
});

test('D4: resumeSending asks the part that paused sending to resume, only while it holds; status carries the typed guard\'s card', async (t) => {
  let paused = { paused: true, turns: 20, windowMs: 60_000, at: 5 };
  const resumed = [];
  const bridge = { status: () => ({ version: '0.3.1', seq: 0, push: 0, companion: {}, ...(paused ? { sending: paused } : {}) }), resumeSending: () => { resumed.push(1); paused = null; }, store: { state: { chats: {}, tokens: {} } } };
  const r = await rig(t, { keys: ['anthropic'], bridge });
  const st = await r.api.status();
  assert.deepEqual(st.backend.sendingPaused, { turns: 20, windowMs: 60_000, at: 5 });
  assert.equal(st.view.key, 'sending_paused');
  assert.deepEqual(st.view.sending, { headline: 'Sending is paused.', detail: 'More than 20 messages went in a minute, which normal play doesn’t do.', action: 'resume_sending' });
  assert.deepEqual(await r.api.resumeSending(), { ok: true });
  assert.equal(resumed.length, 1);
  assert.equal((await r.api.status()).backend.sendingPaused, undefined);
  assert.deepEqual(await r.api.resumeSending(), { ok: false, error: 'not_paused' });
  assert.ok(r.lines.some(l => l.includes('app-resume-sending')));
  // A core with the guard but no way to resume it says so.
  const r2 = await rig(t, { keys: ['anthropic'], bridge: { status: () => ({ version: '0.3.1', seq: 0, push: 0, companion: {}, sending: { paused: true } }), store: { state: { chats: {}, tokens: {} } } } });
  assert.deepEqual(await r2.api.resumeSending(), { ok: false, error: 'unsupported' });
});

test('CL-design-41: status carries the map’s route for Home (its next stop and how many, words clipped); none without one', async (t) => {
  let route = { title: 'Camp Narache', next: '  The Hunt Begins  ', stops: 7, at: 5 };
  const bridge = { status: () => ({ version: '0.3.1', seq: 0, push: 0, companion: {}, route }), store: { state: { chats: {}, tokens: {} } } };
  const r = await rig(t, { keys: ['anthropic'], bridge });
  assert.deepEqual((await r.api.status()).wow.route, { next: 'The Hunt Begins', stops: 7, title: 'Camp Narache' });
  route = { next: 'x'.repeat(200), stops: 'many' };
  assert.deepEqual((await r.api.status()).wow.route, { next: 'x'.repeat(80), stops: 1, title: '' });
  route = null;
  assert.equal((await r.api.status()).wow.route, undefined);
  route = { next: '   ', stops: 3 };
  assert.equal((await r.api.status()).wow.route, undefined, 'a stop with no name is no route');
});
