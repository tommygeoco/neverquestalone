// The desktop app's IPC surface (BYOK PRD §11.2 "Hardening the shell", SC-3;
// BUILD-PLAN "Contract: the app API"): every handler's input is schema-checked
// (good and hostile inputs), the risky calls need a native confirm and do
// nothing when it's declined, a pasted key is never sent back, and the
// preload's list of calls matches the main process's. Also the API loader's
// real-or-mock rule and the shell's own settings file. No Electron needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, HANDLERS, CALLS, CONFIRMED, createIpc, registerIpc, createKeyStager, guessProvider,
  LINKS, LINK_IDS, COMMANDS, PROVIDER_IDS, diagnosticsText, CHANNEL_PREFIX, saysRestart, THINKING_LEVELS,
} from '../../app/desktop/ipc.mjs';
import { STRINGS } from '../../app/desktop/src/strings.mjs';
import { createMockApi } from '../../app/desktop/src/mock-api.mjs';
import { loadApi, wrapApi, unavailableApi, apiCandidates, bridgeRoots, isInside, bridgeLogger, API_METHODS, BRIDGE_FILES } from '../../app/desktop/src/api-loader.mjs';
import { createShellLedger } from '../../app/desktop/src/net-guard.mjs';
import { createAppState, normalizeState } from '../../app/desktop/src/app-state.mjs';
import { idleUpdater } from '../../app/desktop/updater.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', '..', 'app', 'desktop');
const CANARY = `sk-ant-api03-CANARY${'x'.repeat(60)}A1b2`;
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0);
const SCRIPT = '<script>alert(1)</script>';
const IMG = '<img src=x onerror="alert(1)">';

/** A ctx like main.mjs builds, over the mock API, recording API calls and confirms. */
function makeCtx({ confirm = true, api: apiOverride = null, updaterState = 'idle', state = {} } = {}) {
  const calls = [];
  const confirms = [];
  // The mock with every AI company's terms recorded (setup records them at its dialog; tests/byok/app_keyflow_test.mjs covers that).
  const mockApi = createMockApi({ delayMs: 0, controllable: true });
  mockApi.control.reset({ terms: { anthropic: 1, openai: 1, xai: 1, google: 1 }, ...state });
  const base = apiOverride ?? wrapApi(mockApi);
  const api = {};
  for (const m of [...API_METHODS, 'onChange', 'stop']) {
    api[m] = (...a) => { calls.push([m, ...a]); return base[m](...a); };
  }
  const clipboard = [];
  const opened = [];
  const ctx = {
    api,
    keys: createKeyStager(),
    ledger: createShellLedger(),
    updater: { ...idleUpdater({ pkg: {}, prefs: {}, current: '0.1.0' }), status: () => ({ state: updaterState, mode: 'notify', available: { version: '0.2.0' } }), installNow: () => ({ ok: true, installing: true }) },
    appState: { get: () => ({ onboarded: false }), set: v => ({ onboarded: !!v.onboarded }) },
    platform: 'darwin',
    confirm: async spec => { confirms.push(spec); return typeof confirm === 'function' ? confirm(spec) : confirm; },
    links: { open: url => { opened.push(url); return { ok: true }; } },
    clipboard: { writeText: t => clipboard.push(t) },
    loginItem: { set: open => ({ ok: true, openAtLogin: open }) },
    info: () => ({ version: '0.1.0', electron: '44.4.5', chrome: '152', node: '24.21.0', platform: 'darwin', arch: 'arm64', packaged: false, apiMode: 'mock' }),
    notices: () => [],
    companion: () => 'NeverQuestAlone',
    releasesUrl: () => null,
    uninstallShell: r => ({ ...r, quitting: true }),
    shellLog: () => [],
    log: () => {},
  };
  return { ctx, ipc: createIpc(ctx), calls, confirms, clipboard, opened };
}
const apiCalled = (calls, name) => calls.some(c => c[0] === name);

// ---------------------------------------------------------------------------
// The schema checker.

test('check: strings — type, length in code points, pattern, control and direction characters', () => {
  const s = { type: 'string', minLength: 2, maxLength: 5, pattern: /^[a-z]+$/ };
  assert.equal(check(s, 'abc').ok, true);
  for (const bad of [1, null, undefined, true, ['abc'], { a: 1 }, 'a', 'abcdef', 'ABC', `ab${NUL}`, `ab${RLO}`, `ab${ZWSP}`, 'ab\n']) {
    assert.equal(check(s, bad).ok, false, `refuses ${JSON.stringify(bad)}`);
  }
  assert.equal(check({ type: 'string', maxLength: 3 }, '😀😀😀').ok, true, 'length counts code points');
  assert.equal(check({ type: 'string' }, 'x'.repeat(257)).ok, false, 'default cap 256');
  assert.equal(check({ type: 'string', enum: ['a', 'b'] }, 'c').ok, false);
  assert.equal(check({ type: 'string', enum: ['a', 'b'] }, 'a').ok, true);
});

test('check: numbers — finite, range, decimals; integers; booleans; nullable', () => {
  const n = { type: 'number', minimum: 0, maximum: 100, maxDecimals: 2 };
  for (const good of [0, 1, 2.5, 99.99, 100]) assert.equal(check(n, good).ok, true, String(good));
  for (const bad of [-0.01, 100.01, 1.005, NaN, Infinity, -Infinity, '1', null, [], {}, 1e9]) assert.equal(check(n, bad).ok, false, String(bad));
  const i = { type: 'integer', minimum: 1, maximum: 10 };
  for (const bad of [0, 11, 1.5, '5', NaN, true]) assert.equal(check(i, bad).ok, false, String(bad));
  assert.equal(check(i, 5).ok, true);
  assert.equal(check({ type: 'boolean' }, 'true').ok, false);
  assert.equal(check({ type: 'boolean' }, 0).ok, false);
  assert.equal(check({ type: 'boolean' }, false).ok, true);
  const nb = { type: 'nullable', of: { type: 'string', enum: ['low'] } };
  assert.equal(check(nb, null).ok, true);
  assert.equal(check(nb, 'low').ok, true);
  assert.equal(check(nb, 'high').ok, false);
});

test('check: objects — plain only, unknown and prototype keys refused, output holds only declared keys', () => {
  const o = { type: 'object', properties: { a: { type: 'boolean' }, b: { type: 'boolean' } }, required: ['a'] };
  assert.deepEqual(check(o, { a: true }).value, { a: true });
  assert.equal(check(o, { a: true, c: 1 }).ok, false);
  assert.equal(check(o, {}).ok, false, 'required');
  for (const bad of [[], 'x', 1, null, new Map(), new Date(), Object.create({ a: true })]) assert.equal(check(o, bad).ok, false);
  const proto = JSON.parse('{"a": true, "__proto__": {"polluted": true}}');
  assert.equal(check(o, proto).ok, false, '__proto__ as an own key is refused');
  assert.equal(check(o, JSON.parse('{"a": true, "constructor": 1}')).ok, false);
  assert.equal({}.polluted, undefined);
  const r = check(o, Object.assign(Object.create(null), { a: false }));
  assert.equal(r.ok, true, 'null-prototype objects are plain');
  assert.equal(Object.getPrototypeOf(r.value), Object.prototype);
  const none = { type: 'none' };
  assert.equal(check(none, undefined).ok, true);
  assert.equal(check(none, {}).ok, true);
  assert.equal(check(none, { x: 1 }).ok, false);
  assert.equal(check(none, 'x').ok, false);
});

test('every call has a schema, and every call refuses the wrong shape of input', async () => {
  const { ipc } = makeCtx({ confirm: false });
  assert.deepEqual([...CALLS].sort(), Object.keys(HANDLERS).sort());
  for (const name of CALLS) {
    const h = HANDLERS[name];
    assert.ok(h.input && typeof h.input.type === 'string', `${name} has an input schema`);
    for (const hostile of [SCRIPT, 42, ['a'], true]) {
      const r = await ipc.call(name, hostile);
      assert.equal(r.ok, false, `${name} refuses ${JSON.stringify(hostile)}`);
      assert.equal(r.error, 'bad_input', `${name}: ${JSON.stringify(r)}`);
    }
    const extra = await ipc.call(name, { [`x${SCRIPT}`]: 1 });
    assert.equal(extra.error, 'bad_input', `${name} refuses an unknown key`);
  }
});

test('the dispatcher: unknown calls, oversized input and thrown errors', async () => {
  const { ipc } = makeCtx();
  assert.equal((await ipc.call('eval', {})).error, 'unknown_call');
  assert.equal((await ipc.call('__proto__', {})).error, 'unknown_call');
  assert.equal((await ipc.call('toString', {})).error, 'unknown_call');
  const big = await ipc.call('stageKey', { key: 'k'.repeat(9000) });
  assert.equal(big.error, 'bad_input');
  assert.match(big.detail, /too large/);
  const throwing = makeCtx({ api: wrapApi({ status: async () => { throw new Error(`boom ${CANARY}`); } }) });
  const r = await throwing.ipc.call('status');
  assert.deepEqual(r, { ok: false, error: 'failed' });
});

// ---------------------------------------------------------------------------
// Keys (KY-1, KY-3, §16.1 step 4).

test('guessProvider: the key shapes of §16.1 step 4', () => {
  assert.equal(guessProvider(CANARY), 'anthropic');
  assert.equal(guessProvider('sk-proj-CANARY0123456789abcdef'), 'openai');
  assert.equal(guessProvider('sk-svcacct-CANARY0123456789'), 'openai');
  assert.equal(guessProvider('sk-or-v1-CANARY0123456789abcdef'), 'openrouter');
  assert.equal(guessProvider('xai-CANARY0123456789abcdefghij'), 'xai');
  assert.equal(guessProvider(`AIza${'C'.repeat(35)}`), 'google');
  assert.equal(guessProvider('AQ.CANARY0123456789abcdefghij'), 'google');
  assert.equal(guessProvider('sk-CANARY0123456789abcdefghij'), 'openai');
  assert.equal(guessProvider('hello there'), null);
});

test('stageKey: accepts a key (unwrapped as players paste it), never returns it; text that isn’t a key is never staged; oversize and wrong types refused', async () => {
  const { ipc, ctx } = makeCtx();
  const r = await ipc.call('stageKey', { key: CANARY });
  assert.equal(r.ok, true);
  assert.equal(r.guess, 'anthropic');
  assert.equal(r.guessName, 'Anthropic');
  assert.match(r.stageId, /^[0-9a-f]{32}$/);
  assert.equal(r.masked, 'sk-ant-…A1b2', 'the key store\'s own mask (one masker)');
  assert.ok(!JSON.stringify(r).includes('CANARY'), 'the result carries no part of the key but its mask');
  assert.equal(ctx.keys.peek(r.stageId), CANARY);
  // A trailing space, a line break, quotes, a zero-width character: the key inside is staged.
  for (const wrapped of [`${CANARY} `, `${CANARY}\n`, `"${CANARY}"`, `${ZWSP}${CANARY}`]) {
    const x = await ipc.call('stageKey', { key: wrapped });
    assert.equal(x.ok, true, JSON.stringify(wrapped).slice(0, 30));
    assert.equal(ctx.keys.peek(x.stageId), CANARY);
  }
  const before = ctx.keys.size;
  for (const text of [SCRIPT, IMG, 'short', `sk-ant-${RLO}abcdefghijklmnopqrstuvwxyz`]) {
    const x = await ipc.call('stageKey', { key: text });
    assert.equal(x.ok, false);
    assert.equal(x.error, 'not_a_key', `not a key: ${text.slice(0, 30)}`);
  }
  assert.equal(ctx.keys.size, before, 'nothing that isn’t a key is staged');
  for (const bad of ['k'.repeat(4097), 12345678901234567890, null, { key: CANARY }]) {
    const x = await ipc.call('stageKey', { key: bad });
    assert.equal(x.error, 'bad_input', `refuses ${String(bad).slice(0, 30)}`);
  }
});

test('the key stager: five-minute life, bounded, cleared', () => {
  let t = 1000;
  const s = createKeyStager({ now: () => t, ttlMs: 5000, max: 2 });
  const a = s.stage('key-a');
  assert.equal(s.peek(a), 'key-a');
  t += 5001;
  assert.equal(s.peek(a), null, 'expired');
  const b = s.stage('key-b');
  s.stage('key-c');
  s.stage('key-d');
  assert.equal(s.peek(b), null, 'the oldest is dropped past the bound');
  assert.equal(s.size, 2);
  s.clear();
  assert.equal(s.size, 0);
});

test('chooseWowFolder (D-09): main\'s folder dialog, then the bridge checks it; relaunch only while the engine failed to start (D-05)', async () => {
  const r = makeCtx();
  assert.deepEqual(await r.ipc.call('chooseWowFolder'), { ok: false, error: 'cancelled' }, 'no dialog in this ctx: cancelled');
  r.ctx.pickFolder = async () => '/Games/World of Warcraft';
  const out = await r.ipc.call('chooseWowFolder');
  assert.equal(out.error, 'not_wow', 'the mock finds no WoW there');
  assert.deepEqual(r.calls.find(c => c[0] === 'useWowFolder'), ['useWowFolder', '/Games/World of Warcraft']);
  const offered = (await r.ipc.call('findWow')).path; // the mock's install, as this OS writes it
  assert.ok(offered);
  assert.equal((await r.ipc.call('installAddon', { flavorDir: offered })).ok, true);
  assert.equal((await r.ipc.call('installAddon', { flavorDir: '' })).error, 'bad_input');
  assert.equal((await r.ipc.call('relaunch')).error, 'not_needed');
  let relaunched = 0;
  r.ctx.relaunch = () => { relaunched += 1; return { ok: true }; };
  r.ctx.info = () => ({ apiMode: 'error' });
  assert.equal((await r.ipc.call('relaunch')).ok, true);
  assert.equal(relaunched, 1);
});

test('fix-102: Quit and reopen also runs while the bridge says it needs a restart: after a result whose fix it is, or a status that says the bridge stopped', async () => {
  let relaunched = 0;
  const relaunch = () => { relaunched += 1; return { ok: true }; };
  // A key test the app's own guard refused (desktopLine's restart): its card's Quit and reopen works.
  const base = wrapApi(createMockApi({ delayMs: 0 }));
  const restartLine = { ok: false, error: 'egress_blocked', action: 'restart', headline: 'NeverQuestAlone needs a restart.', detail: 'Click Quit and reopen.' };
  const a = makeCtx({ api: { ...base, testKey: async () => restartLine } });
  a.ctx.relaunch = relaunch;
  assert.equal((await a.ipc.call('relaunch')).error, 'not_needed', 'nothing asked for it yet');
  assert.equal((await a.ipc.call('testKey', { provider: 'anthropic' })).action, 'restart');
  assert.equal((await a.ipc.call('relaunch')).ok, true);
  assert.equal(relaunched, 1);
  // Setup's own result for it (its retest of a saved key answers the same way).
  const b = makeCtx({ api: { ...base, testKey: async () => ({ ok: false, error: 'restart', kind: 'egress_blocked' }) } });
  b.ctx.relaunch = relaunch;
  assert.equal((await b.ipc.call('testKey', { provider: 'anthropic' })).error, 'restart');
  assert.equal((await b.ipc.call('relaunch')).ok, true);
  assert.equal(relaunched, 2);
  // A status that says the bridge stopped (the not-running card's restart words), even one the page got by a push.
  const stoppedStatus = { backend: { rt: { state: 'not_running', reason: 'app_stopped' } } };
  const c = makeCtx({ api: { ...base, status: async () => stoppedStatus } });
  c.ctx.relaunch = relaunch;
  assert.equal((await c.ipc.call('relaunch')).ok, true);
  assert.equal(relaunched, 3);
  assert.equal(saysRestart(stoppedStatus), true);
  assert.equal(saysRestart({ ok: false, error: 'network' }), false, 'a real network failure asks for no restart');
});

test('connectKey: hostile and impossible inputs never reach the dialog (the old setKey call is gone, code health AP-14)', async () => {
  const { ipc, confirms, calls } = makeCtx();
  const st = await ipc.call('stageKey', { key: CANARY });
  const cases = [
    [{ provider: SCRIPT, stageId: st.stageId }, 'bad_input'],
    [{ provider: 'anthropic', stageId: '../../etc/passwd' }, 'bad_input'],
    [{ provider: 'anthropic', stageId: st.stageId, key: CANARY }, 'bad_input'],
    [{ provider: 'anthropic', stageId: 'f'.repeat(32) }, 'stage_expired'],
    [{ provider: 'openrouter', stageId: st.stageId }, 'bad_input'],
    [{ provider: 'ollama', stageId: st.stageId }, 'bad_input'],
    [{ provider: 'openai', stageId: st.stageId }, 'key_mismatch'],
    [{ provider: 'custom', stageId: st.stageId }, 'key_mismatch'],
  ];
  for (const [input, error] of cases) assert.equal((await ipc.call('connectKey', input)).error, error, JSON.stringify(input));
  assert.equal(confirms.length, 0);
  assert.equal(apiCalled(calls, 'testStagedKey'), false);
  assert.equal(apiCalled(calls, 'connect'), false);
  // setKey (its confirm showed no mask), wowRunning, diagnostics and setZoom: no page called them, so
  // main no longer answers them; nor dismissUpdateReminder, whose reminder the owner's trim cut (AP-08).
  for (const gone of ['setKey', 'wowRunning', 'diagnostics', 'setZoom', 'dismissUpdateReminder']) {
    assert.equal(CALLS.includes(gone), false, gone);
    assert.deepEqual(await ipc.call(gone, {}), { ok: false, error: 'unknown_call' }, gone);
  }
});
test('results are redacted: an API that echoes a staged key or any key shape never gets it to the page', async () => {
  const leaky = wrapApi({
    ...createMockApi({ delayMs: 0 }),
    testKey: async () => ({ ok: false, error: 'auth_invalid', line: 'rejected', debug: `key was ${CANARY}`, headers: { authorization: 'Bearer sk-proj-LEAK0123456789abcdef' } }),
  });
  const { ipc } = makeCtx({ api: leaky });
  await ipc.call('stageKey', { key: CANARY });
  const r = await ipc.call('testKey', { provider: 'anthropic' });
  const text = JSON.stringify(r);
  assert.ok(!text.includes('CANARY'), text);
  assert.ok(!text.includes('LEAK'), text);
  assert.equal(r.line, 'rejected');
});

test('deleteKey and connectCustom: confirm-gated; declined means the API is never called', async () => {
  const no = makeCtx({ confirm: false });
  assert.equal((await no.ipc.call('deleteKey', { provider: 'openai' })).error, 'cancelled');
  assert.equal((await no.ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini', key: `sk-or-v1-CANARY${'x'.repeat(56)}` })).error, 'cancelled');
  assert.equal(apiCalled(no.calls, 'deleteKey'), false);
  assert.equal(apiCalled(no.calls, 'connectCustom'), false);
  assert.equal(no.confirms[0].destructive, true, 'deleting a key defaults to Cancel');
  assert.equal(no.confirms[1].message, 'Connect NeverQuestAlone to openrouter.ai?');
  assert.match(no.confirms[1].detail, /https:\/\/openrouter\.ai\/api\/v1/);
  assert.ok(!JSON.stringify(no.confirms).includes('CANARY'), 'the key is never in a dialog');
  const yes = makeCtx({ confirm: true });
  assert.equal((await yes.ipc.call('deleteKey', { provider: 'openai' })).ok, true);
  const got = await yes.ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini', key: `sk-or-v1-CANARY${'x'.repeat(56)}` });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.masked, 'sk-or-…xxxx');
  assert.ok(!JSON.stringify(got).includes('CANARY'), 'the key is not returned, only its mask');
  // The schema: only these fields, a URL of at most 512 characters, a model id's shape.
  for (const bad of [{ baseUrl: 'https://x.example/v1' }, { baseUrl: 'https://x.example/v1', model: 'm', extra: 1 }, { baseUrl: `https://x.example/${'a'.repeat(600)}`, model: 'm' }, { baseUrl: 'https://x.example/v1', model: 'has space' }, { baseUrl: 'https://x.example/\u202e', model: 'm' }]) {
    assert.equal((await yes.ipc.call('connectCustom', bad)).error, 'bad_input', JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await yes.ipc.call('signInOpenRouter')).error, 'unknown_call', 'no sign-in: OpenRouter connects through Other');
});

// ---------------------------------------------------------------------------
// Provider, caps, privacy.

test('choose: checked against the provider list before the confirm; the confirm names the privacy change', async () => {
  const { ipc, confirms, calls } = makeCtx({ confirm: false });
  for (const [input, error] of [
    [{ provider: 'anthropic', model: SCRIPT }, 'bad_input'],
    [{ provider: 'anthropic', model: 'm'.repeat(129) }, 'bad_input'],
    [{ provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'ultra' }, 'bad_input'],
    [{ provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'none' }, 'bad_input'],
    [{ provider: 'anthropic', model: 'claude-haiku-4-5', effort: 1 }, 'bad_input'],
    [{ provider: 'anthropic', model: 'gpt-6-sol' }, 'unknown_model'],
    [{ provider: 'google', model: 'gemini-2.0-flash' }, 'unknown_model'],
    [{ provider: 'ollama', model: 'qwen3:8b' }, 'bad_input'],
  ]) assert.equal((await ipc.call('choose', input)).error, error, JSON.stringify(input));
  assert.equal(confirms.length, 0);
  // Other at a server on this computer, in use: a switch to Claude asks, and says it leaves this computer.
  const local = makeCtx({ confirm: false, state: { custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' }, choice: { provider: 'custom', model: 'qwen3:8b', effort: null } } });
  assert.equal((await local.ipc.call('choose', { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null })).error, 'cancelled', 'a switch asks; declined');
  assert.match(local.confirms[0].detail, /off this computer/);
  assert.equal(local.calls.filter(c => c[0] === 'choose').length, 0, 'the declined switch never reached the API');

  // A provider that lists no models (Other before its service is set): nothing can be chosen.
  const empty = makeCtx({ confirm: true });
  assert.equal((await empty.ipc.call('choose', { provider: 'custom', model: 'qwen3:8b' })).error, 'no_models');
  assert.equal(empty.confirms.length, 0, 'refused before the confirm');
  assert.equal(apiCalled(empty.calls, 'choose'), false);

  // D-12: the first choice (no provider in use yet) and another model at the same provider need
  // no confirm; a switch of provider does, in display names.
  const yes = makeCtx({ confirm: true, state: { custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' } } });
  assert.equal((await yes.ipc.call('choose', { provider: 'custom', model: 'qwen3:8b' })).ok, true);
  assert.deepEqual(yes.calls.find(c => c[0] === 'choose')[1], { provider: 'custom', model: 'qwen3:8b', effort: null });
  assert.equal(yes.confirms.length, 0, 'the first choice: no dialog');
  assert.equal((await yes.ipc.call('choose', { provider: 'custom', model: 'qwen3:8b', effort: null })).ok, true);
  assert.equal(yes.confirms.length, 0, 'the same model, same provider: no dialog');
  await yes.ipc.call('choose', { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' });
  assert.equal(yes.confirms.length, 1, 'a provider switch: a dialog');
  assert.equal(yes.confirms[0].message, 'Switch to Claude Sonnet 5 at Anthropic?');
  assert.match(yes.confirms[0].detail, /Claude Sonnet 5, with low thinking\./);
  assert.doesNotMatch(JSON.stringify(yes.confirms[0]), /claude-sonnet-5/, 'names, never raw ids');
  assert.match(yes.confirms[0].detail, /off this computer/, 'local → cloud says so');
  // fix-102: every level the model has, named as the model runs it (a level it hasn't is its nearest).
  for (const [model, effort, words] of [
    ['claude-sonnet-5-5', 'off', 'with thinking off'], ['claude-sonnet-5-5', 'xhigh', 'with extra high thinking'], ['claude-sonnet-5-5', 'max', 'with max thinking'],
    ['claude-opus-5-5', 'off', 'with low thinking'], ['claude-haiku-4-5', 'minimal', 'with minimal thinking'],
  ]) {
    const c = makeCtx({ confirm: false, state: { custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' }, choice: { provider: 'custom', model: 'qwen3:8b', effort: null } } });
    assert.equal((await c.ipc.call('choose', { provider: 'anthropic', model, effort })).error, 'cancelled');
    assert.match(c.confirms[0].detail, new RegExp(`, ${words}\\. `), `${model} ${effort}: ${c.confirms[0].detail}`);
  }
  // STYLE §12: every level is a whole sentence in main's table, never "with {level} thinking" spliced.
  assert.deepEqual(Object.keys(STRINGS.switchConfirm.replyAt), [...THINKING_LEVELS], 'one sentence per thinking level');
  for (const line of Object.values(STRINGS.switchConfirm.replyAt)) assert.match(line, /^\{name\}’s next reply comes from \{model\}, .+\.$/);
  // A provider that has no key isn't in use: choosing away from it is a first choice.
  const fresh = makeCtx({ confirm: true });
  await fresh.ctx.api.setKey('anthropic', CANARY);
  await fresh.ctx.api.deleteKey('anthropic');
  assert.equal((await fresh.ipc.call('choose', { provider: 'openai', model: 'gpt-6-luna', effort: 'low' })).ok, true);
  assert.equal(fresh.confirms.length, 0);
});

test('setCaps: the player\'s own daily spend limit only (no limits of ours): a number in range with cents at most, or null for none; declined changes nothing', async () => {
  const { ipc, confirms, calls } = makeCtx({ confirm: false });
  // Nothing set by default, never pre-filled (the owner, 2026-09-26).
  assert.deepEqual(await ipc.call('caps'), { dailyUsd: null, spentTodayMicros: 180_000 });
  for (const bad of [
    { dailyUsd: '2.50' }, { dailyUsd: SCRIPT }, { dailyUsd: -1 }, { dailyUsd: 1e9 }, { dailyUsd: 100.01 }, { dailyUsd: 1.005 }, { dailyUsd: Infinity },
    {}, { dailyUsd: 2, extra: true },
    // The message limits are gone: a window that still sends them is refused, never half-applied.
    { dailyUsd: 2.5, typedPerDay: 200, autoPerDay: 20 }, { typedPerDay: 200 },
  ]) assert.equal((await ipc.call('setCaps', bad)).error, 'bad_input', JSON.stringify(bad));
  assert.equal(confirms.length, 0);
  // A first limit asks nothing: it can only lower what's spent (UX-W11, spec §3.12).
  assert.equal((await ipc.call('setCaps', { dailyUsd: 2.5 })).ok, true);
  assert.equal(confirms.length, 0, 'setting a first limit: no dialog');
  assert.deepEqual(await ipc.call('caps'), { dailyUsd: 2.5, spentTodayMicros: 180_000 });
  // A raise asks, and a no changes nothing.
  assert.equal((await ipc.call('setCaps', { dailyUsd: 3 })).error, 'cancelled');
  assert.equal(confirms[0].message, 'Raise your daily spend limit to $3.00?');
  assert.equal(confirms[0].detail, 'It’s $2.50 now. NeverQuestAlone keeps sending until today’s spend reaches $3.00.');
  assert.equal(confirms[0].okLabel, 'Raise limit');
  assert.equal(confirms[0].cancelLabel, 'Cancel');
  assert.deepEqual(await ipc.call('caps'), { dailyUsd: 2.5, spentTodayMicros: 180_000 }, 'declined: unchanged');
  // No limit to no limit: nothing to ask.
  const none = makeCtx({ confirm: false });
  assert.equal((await none.ipc.call('setCaps', { dailyUsd: null })).ok, true);
  assert.equal(none.confirms.length, 0, 'clearing nothing: no dialog');

  // D-12: lowering (or keeping) the limit asks nothing; raising it asks, and so does turning it off.
  const yes = makeCtx({ confirm: true });
  assert.equal((await yes.ipc.call('setCaps', { dailyUsd: 2 })).ok, true);
  assert.equal(yes.confirms.length, 0, 'setting: no dialog');
  assert.deepEqual(await yes.ctx.api.caps(), { dailyUsd: 2, spentTodayMicros: 180_000 });
  assert.equal((await yes.ipc.call('setCaps', { dailyUsd: 0.5 })).ok, true);
  assert.equal((await yes.ipc.call('setCaps', { dailyUsd: 0.5 })).ok, true);
  assert.equal(yes.confirms.length, 0, 'lowering, then the same: no dialog');
  assert.equal((await yes.ipc.call('setCaps', { dailyUsd: 0.75 })).ok, true);
  assert.equal(yes.confirms[0].message, 'Raise your daily spend limit to $0.75?');
  assert.equal(yes.confirms[0].detail, 'It’s $0.50 now. NeverQuestAlone keeps sending until today’s spend reaches $0.75.');
  assert.equal((await yes.ipc.call('setCaps', { dailyUsd: null })).ok, true);
  assert.equal(yes.confirms[1].message, 'Turn off your daily spend limit?', 'turning it off is the largest raise');
  assert.equal(yes.confirms[1].detail, 'It’s $0.75 a day now. Without it, NeverQuestAlone keeps answering whatever today costs. Your AI company’s own limits still apply.');
  assert.equal(yes.confirms[1].okLabel, 'Turn off limit');
  assert.deepEqual(await yes.ctx.api.caps(), { dailyUsd: null, spentTodayMicros: 180_000 });
  assert.deepEqual(yes.calls.filter(c => c[0] === 'setCaps').map(c => c[1]), [{ dailyUsd: 2 }, { dailyUsd: 0.5 }, { dailyUsd: 0.5 }, { dailyUsd: 0.75 }, { dailyUsd: null }], 'only dailyUsd reaches the bridge');
  // A limit that can't be read: every change asks, and nothing says how it compares.
  const blind = makeCtx({ confirm: true, api: { ...wrapApi(createMockApi({ delayMs: 0 })), caps: async () => ({ ok: false, error: 'failed' }) } });
  await blind.ipc.call('setCaps', { dailyUsd: 0.1 });
  await blind.ipc.call('setCaps', { dailyUsd: null });
  assert.deepEqual(blind.confirms.map(c => c.message), ['Set your daily spend limit to $0.10?', 'Turn off your daily spend limit?']);
  assert.equal(blind.confirms[0].okLabel, 'Set limit');
  assert.equal(blind.confirms[1].detail, 'Without it, NeverQuestAlone keeps answering whatever today costs. Your AI company’s own limits still apply.');
});

test('setPrivacy: six booleans, all required; no confirm', async () => {
  const { ipc, confirms } = makeCtx();
  const good = { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: true };
  assert.equal((await ipc.call('setPrivacy', good)).ok, true);
  assert.equal((await ipc.call('setPrivacy', { ...good, identity: 'true' })).error, 'bad_input');
  assert.equal((await ipc.call('setPrivacy', { identity: true })).error, 'bad_input');
  // Screen Reading (the app's Your data switch): a boolean only, and required like the rest. Off
  // reads less and on is the default, so neither asks first.
  assert.equal((await ipc.call('setPrivacy', { ...good, screenReading: false })).ok, true);
  for (const bad of ['off', 0, 1, null, 'false', {}]) assert.equal((await ipc.call('setPrivacy', { ...good, screenReading: bad })).error, 'bad_input', String(bad));
  const { screenReading: _, ...five } = good;
  assert.equal((await ipc.call('setPrivacy', five)).error, 'bad_input', 'the old five alone');
  assert.equal(confirms.length, 0);
});

// ---------------------------------------------------------------------------
// What happened: usage, connections, last request, memory, transcripts.

test('usage, lastRequest, memory: optional inputs with checked shapes', async () => {
  const { ipc } = makeCtx();
  assert.ok(Array.isArray((await ipc.call('usage')).days));
  assert.ok(Array.isArray((await ipc.call('usage', { days: 7 })).days));
  for (const bad of [{ days: 0 }, { days: 91 }, { days: '30' }, { days: 7.5 }]) assert.equal((await ipc.call('usage', bad)).error, 'bad_input');
  const lr = await ipc.call('lastRequest');
  assert.equal(lr.request.headers['x-api-key'], 'sk-ant-…A1b2 (redacted)', 'an already-masked key passes as its mask');
  for (const bad of ['../../etc', SCRIPT, 'x'.repeat(65), '']) assert.equal((await ipc.call('lastRequest', { chatId: bad })).error, 'bad_input');
  assert.deepEqual((await ipc.call('memory')).chars, ['Thokk-Testrealm', 'Brakka-Testrealm']);
  assert.equal((await ipc.call('memory', { char: 'Thokk-Testrealm' })).char, 'Thokk-Testrealm');
  assert.equal((await ipc.call('memory', { char: 'Zoë' })).error, 'not_found', 'accented names pass the check');
  for (const bad of ['<b>x</b>', ' Tavi', 'Tavi ', '', 'x'.repeat(65), `Ta${RLO}vi`, 'Ta/vi']) {
    assert.equal((await ipc.call('memory', { char: bad })).error, 'bad_input', JSON.stringify(bad));
  }
});

test('forgetMemory and transcripts({deleteAll}) are confirm-gated; reading transcripts is not', async () => {
  const { ipc, confirms, calls } = makeCtx({ confirm: false });
  assert.equal((await ipc.call('forgetMemory', { char: 'Thokk-Testrealm' })).error, 'cancelled');
  assert.equal((await ipc.call('transcripts', { deleteAll: true })).error, 'cancelled');
  assert.equal(apiCalled(calls, 'forgetMemory'), false);
  assert.equal(calls.filter(c => c[0] === 'transcripts').length, 0);
  assert.equal(confirms.length, 2);
  assert.ok(confirms.every(c => c.destructive));
  const read = await ipc.call('transcripts', { deleteAll: false });
  assert.equal(read.retentionDays, 30);
  assert.equal(confirms.length, 2, 'no dialog to read');
  assert.equal((await ipc.call('transcripts', { deleteAll: 'yes' })).error, 'bad_input');
});

test('forgetMemory({all: true}): every character the memory lists, after one confirm (Settings’ Forget all, CL-words-76); the page never names them', async () => {
  const no = makeCtx({ confirm: false });
  assert.equal((await no.ipc.call('forgetMemory', { all: true })).error, 'cancelled');
  assert.equal(no.confirms.length, 1, 'one dialog for every character');
  assert.equal(no.confirms[0].message, 'Forget what NeverQuestAlone remembers about all your characters?');
  assert.equal(no.confirms[0].detail, 'The notes on this computer are deleted. Chat history stays. This can’t be undone.');
  assert.equal(no.confirms[0].okLabel, 'Forget all');
  assert.equal(no.confirms[0].destructive, true);
  assert.equal(apiCalled(no.calls, 'forgetMemory'), false, 'a no forgets nothing');
  const yes = makeCtx({ confirm: true });
  assert.deepEqual(await yes.ipc.call('forgetMemory', { all: true }), { ok: true, forgot: 2 });
  assert.equal(yes.confirms.length, 1);
  assert.deepEqual(yes.calls.filter(c => c[0] === 'forgetMemory').map(c => c[1]), ['Thokk-Testrealm', 'Brakka-Testrealm']);
  for (const bad of [{ all: false }, { all: true, char: 'Thokk-Testrealm' }, {}, { all: 'yes' }]) {
    assert.equal((await yes.ipc.call('forgetMemory', bad)).error, 'bad_input', JSON.stringify(bad));
  }
  assert.equal(yes.confirms.length, 1, 'no dialog for a bad call');
});

test('the retention is a setting the window changes, behind a confirm; the delete-all dialog says the game keeps its own copy (final review L5-1, L5-5)', async () => {
  const { ipc, confirms, calls } = makeCtx({ confirm: false });
  assert.equal((await ipc.call('setRetention', { days: 7 })).error, 'cancelled');
  assert.equal(apiCalled(calls, 'setRetention'), false);
  // D-24: only a shorter time asks, and it says what that deletes now.
  assert.equal(confirms[0].message, 'Keep chat history for 7 days instead of 30 days?');
  assert.match(confirms[0].detail, /This deletes 11 chats older than 7 days now, and the older messages of 1 chat more\./);
  assert.match(confirms[0].detail, /The chat window in the game keeps its own copy/);
  assert.equal(confirms[0].destructive, true);
  assert.deepEqual(await ipc.call('setRetention', { days: 90 }), { ok: true, retentionDays: 90 }, 'longer: no confirm');
  assert.deepEqual(await ipc.call('setRetention', { days: 90 }), { ok: true, retentionDays: 90 }, 'the same: no confirm');
  assert.equal(confirms.length, 1);
  for (const bad of [{ days: 0 }, { days: 366 }, { days: 7.5 }, { days: '7' }, {}]) assert.equal((await ipc.call('setRetention', bad)).error, 'bad_input', JSON.stringify(bad));
  const yes = makeCtx({ confirm: true });
  assert.deepEqual(await yes.ipc.call('setRetention', { days: 7 }), { ok: true, retentionDays: 7 });
  assert.deepEqual(yes.calls.find(c => c[0] === 'setRetention'), ['setRetention', 7]);
  assert.equal((await yes.ipc.call('transcripts', { deleteAll: false })).retentionDays, 7);
  await yes.ipc.call('transcripts', { deleteAll: true });
  assert.match(yes.confirms.at(-1).detail, /The chat window in the game keeps its own copy/);
});

test('tightenAddonPermissions: no input, main\'s native confirm first, then only the permissions (D-29)', async () => {
  const no = makeCtx({ confirm: false });
  assert.equal((await no.ipc.call('tightenAddonPermissions')).error, 'cancelled');
  assert.equal(apiCalled(no.calls, 'tightenAddonPermissions'), false);
  assert.equal(no.confirms[0].okLabel, 'Fix permissions');
  assert.match(no.confirms[0].detail, /WoW can stay open/);
  assert.equal((await no.ipc.call('tightenAddonPermissions', { tighten: true })).error, 'bad_input');
  const yes = makeCtx({ confirm: true });
  assert.equal((await yes.ipc.call('tightenAddonPermissions')).ok, true);
  assert.equal(apiCalled(yes.calls, 'installAddon'), false, 'no reinstall');
  assert.ok(CONFIRMED.includes('tightenAddonPermissions'));
});

test('regenerateSafetyId reaches the API with no input (final review L5-6)', async () => {
  const { ipc, calls, confirms } = makeCtx();
  assert.deepEqual(await ipc.call('regenerateSafetyId'), { ok: true });
  assert.ok(apiCalled(calls, 'regenerateSafetyId'));
  assert.equal(confirms.length, 0);
  assert.equal((await ipc.call('regenerateSafetyId', { id: 'x' })).error, 'bad_input');
});

test('installAddon: plain, or tighten after a fixable permissions check, which asks first (TH12, final review L3-5)', async () => {
  const { ipc, calls, confirms } = makeCtx({ confirm: false });
  await ipc.call('installAddon');
  assert.deepEqual(calls.find(c => c[0] === 'setupInstall'), ['setupInstall', {}], 'setup’s install: no dialog, no tighten');
  await ipc.call('installAddon', { whenClosed: true });
  assert.deepEqual(calls.find(c => c[0] === 'armInstall'), ['armInstall', {}], 'or armed for when WoW closes');
  assert.equal(confirms.length, 0);
  assert.equal((await ipc.call('installAddon', { tighten: true })).error, 'cancelled');
  assert.equal(confirms[0].message, 'Fix the addon folder’s permissions?');
  assert.equal(confirms[0].okLabel, 'Fix permissions');
  assert.equal(calls.filter(c => c[0] === 'installAddon').length, 0, 'the cancelled tighten installs nothing');
  const yes = makeCtx({ confirm: true });
  await yes.ipc.call('installAddon', { tighten: true });
  assert.deepEqual(yes.calls.find(c => c[0] === 'installAddon'), ['installAddon', { tighten: true }]);
  assert.equal((await ipc.call('installAddon', { tighten: 'yes' })).error, 'bad_input');
});

test('connections merges the bridge ledger with the shell ledger', async () => {
  const { ipc, ctx } = makeCtx();
  ctx.ledger.record({ allow: true, kind: 'update', host: 'github.com', port: 443 }, 'https://github.com/OWNER/r/releases.atom');
  const c = await ipc.call('connections');
  assert.ok(c.bridge.rows.some(r => r.host === 'api.anthropic.com'));
  assert.deepEqual(c.shell.allowed.map(r => [r.host, r.feature]), [['github.com', 'update check']]);
});

// ---------------------------------------------------------------------------
// Links, commands, app state, login item, updates, uninstall.

test('openLink: ids only; every URL is fixed and https (the macOS settings panes: fixed literals); no page takes a template now', async () => {
  const { ipc, opened } = makeCtx();
  for (const [id, url] of Object.entries(LINKS)) {
    if (['mac.screenRecording', 'mac.loginItems', 'mac.privacy'].includes(id)) assert.match(url, /^x-apple\.systempreferences:com\.apple\./, id);
    else assert.match(url, /^https:\/\/[a-z0-9.-]+(\/|$)/, id);
  }
  assert.equal((await ipc.call('openLink', { id: 'anthropic.limits' })).ok, true);
  assert.equal(opened.at(-1), LINKS['anthropic.limits']);
  for (const bad of [{ id: 'https://evil.example' }, { id: 'javascript:alert(1)' }, { id: SCRIPT }, { id: 'anthropic.limits', url: 'https://evil.example' }, { id: 'openrouter.keySettings', hash: 'a'.repeat(64) }, { id: 'custom.privacy' }]) {
    assert.equal((await ipc.call('openLink', bad)).error, 'bad_input', JSON.stringify(bad));
  }
  assert.equal((await ipc.call('openLink', { id: 'google.keys' })).ok, true);
  assert.equal(opened.at(-1), 'https://aistudio.google.com/apikey');
  assert.equal((await ipc.call('openLink', { id: 'releases' })).error, 'no_link', 'no releases repo configured');
  assert.ok(LINK_IDS.includes('releases'));
});

test('copyCommand puts only fixed commands on the clipboard', async () => {
  const { ipc, clipboard } = makeCtx();
  assert.equal((await ipc.call('copyCommand', { id: 'bones_hi' })).text, '/nqa hi');
  assert.equal((await ipc.call('copyCommand', { id: 'bones_mode_reload' })).text, '/nqa mode reload');
  assert.equal((await ipc.call('copyCommand', { id: 'rm -rf /' })).error, 'bad_input');
  assert.equal((await ipc.call('copyCommand', { text: 'evil' })).error, 'bad_input');
  assert.deepEqual(clipboard, ['/nqa hi', '/nqa mode reload']);
  assert.deepEqual(Object.values(COMMANDS).every(c => c.startsWith('/nqa ')), true);
});

test('app state, login item, update mode: checked shapes', async () => {
  const { ipc } = makeCtx();
  assert.equal((await ipc.call('setAppState', { onboarded: true })).ok, true);
  assert.equal((await ipc.call('setAppState', {})).error, 'bad_input', 'at least one field');
  assert.equal((await ipc.call('setAppState', { onboarded: 'yes' })).error, 'bad_input');
  assert.equal((await ipc.call('setLoginItem', { openAtLogin: true })).openAtLogin, true);
  assert.equal((await ipc.call('setLoginItem', { openAtLogin: 1 })).error, 'bad_input');
  assert.equal((await ipc.call('setUpdateMode', { mode: 'always' })).error, 'bad_input');
  assert.equal((await ipc.call('setUpdateMode', { mode: 'never' })).ok, true);
});

test('installUpdateNow needs a ready update, WoW closed, and a confirm', async () => {
  const idle = makeCtx({ updaterState: 'idle' });
  assert.equal((await idle.ipc.call('installUpdateNow')).error, 'no_update_ready');
  assert.equal(idle.confirms.length, 0);
  const running = makeCtx({ updaterState: 'ready', api: wrapApi({ ...createMockApi({ delayMs: 0 }), wowRunning: async () => ({ running: true }) }) });
  assert.equal((await running.ipc.call('installUpdateNow')).error, 'wow_running');
  const ready = makeCtx({ updaterState: 'ready', confirm: false });
  assert.equal((await ready.ipc.call('installUpdateNow')).error, 'cancelled');
  assert.match(ready.confirms[0].message, /0\.2\.0/);
});

test('uninstall is confirm-gated and lists what goes', async () => {
  const no = makeCtx({ confirm: false });
  // The last step is in the confirm too (D-18), and the plumbing words aren't.
  await no.ipc.call('uninstall', { removeAddon: true });
  assert.match(no.confirms[0].detail, /To finish, drag NeverQuestAlone from Applications to the Trash\./);
  assert.doesNotMatch(no.confirms[0].detail, /slot|doorbell/i);
  no.confirms.length = 0;
  assert.equal((await no.ipc.call('uninstall', { removeAddon: true })).error, 'cancelled');
  assert.equal(apiCalled(no.calls, 'uninstall'), false);
  assert.match(no.confirms[0].detail, /addon/);
  assert.match(no.confirms[0].detail, /Keychain/);
  assert.match(no.confirms[0].detail, /Screen Recording/);
  // The addon takes the game's copy of the chats with it (code health AP-11); without it, neither goes.
  assert.ok(no.confirms[0].detail.split('\n').includes('• the NeverQuestAlone addon, its folders and chats in WoW'), no.confirms[0].detail);
  await no.ipc.call('uninstall', { removeAddon: false });
  assert.doesNotMatch(no.confirms.at(-1).detail, /addon|in WoW/);
  const yes = makeCtx({ confirm: true });
  const r = await yes.ipc.call('uninstall', { removeAddon: false });
  assert.equal(r.quitting, true);
  assert.equal((await yes.ipc.call('uninstall', {})).error, 'bad_input');
});

test('the confirm-gated calls are exactly the risky ones, and only one dialog shows at a time', async () => {
  assert.deepEqual([...CONFIRMED].sort(), ['choose', 'connectKey', 'deleteKey', 'forgetMemory', 'installAddon', 'installUpdateNow', 'pasteKey', 'setCaps', 'setRetention', 'connectCustom', 'tightenAddonPermissions', 'transcripts', 'uninstall', 'useSavedKey', 'signIn'].sort());
  let release;
  const gate = new Promise(r => { release = r; });
  const { ipc, confirms } = makeCtx({ confirm: () => gate });
  const first = ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'm' });
  await new Promise(r => setImmediate(r));
  // (A call that always asks: a first spend limit no longer does.)
  const second = await ipc.call('forgetMemory', { char: 'Thrall' });
  assert.deepEqual(second, { ok: false, error: 'busy' });
  release(false);
  assert.equal((await first).error, 'cancelled');
  assert.equal(confirms.length, 1);
});

test('diagnostics: the shell adds its lines, and the whole bundle is redacted (keys, home folder)', async () => {
  const home = os.homedir();
  const api = wrapApi({ diagnostics: async () => ({ text: `log: key ${CANARY} read from ${path.join(home, 'secret.txt')}; Authorization: Bearer abc.def.ghi` }) });
  const { ipc, clipboard } = makeCtx({ api });
  const r = await ipc.call('copyDiagnostics');
  assert.equal(r.ok, true);
  for (const text of [r.text, clipboard[0]]) {
    assert.ok(!text.includes('CANARY'));
    assert.ok(!text.includes(home));
    assert.ok(!text.includes('abc.def.ghi'));
    assert.match(text, /NeverQuestAlone \(desktop shell\)/);
    assert.ok(text.includes(`~${path.sep}secret.txt`), 'the home folder is ~, the rest of the path as it was');
  }
  const { ctx } = makeCtx({ api });
  assert.equal(await diagnosticsText(ctx), (await createIpc(ctx).call('copyDiagnostics')).text);
});

// ---------------------------------------------------------------------------
// The wire: preload list, channel names, the trusted-sender gate.

test('preload.cjs exposes exactly the calls ipc.mjs handles, through contextBridge only', () => {
  const src = fs.readFileSync(path.join(APP, 'preload.cjs'), 'utf8');
  const list = /const CALLS = \[([\s\S]*?)\];/.exec(src)[1];
  const names = [...list.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]);
  assert.deepEqual([...names].sort(), [...CALLS].sort());
  assert.match(src, /contextBridge\.exposeInMainWorld\('nqa', Object\.freeze\(api\)\)/);
  assert.equal((src.match(/require\(/g) ?? []).length, 1, 'requires only electron');
  assert.match(src, /require\('electron'\)/);
  assert.doesNotMatch(src, /exposeInMainWorld\([^)]*ipcRenderer/, 'never exposes ipcRenderer itself');
  assert.equal(CHANNEL_PREFIX, 'nqa:');
});

test('registerIpc refuses calls from anything but the app page', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const { ipc } = makeCtx();
  let trusted = false;
  registerIpc(ipcMain, ipc, { isTrustedSender: () => trusted });
  assert.equal(handlers.size, CALLS.length);
  assert.ok([...handlers.keys()].every(k => k.startsWith('nqa:')));
  assert.deepEqual(await handlers.get('nqa:status')({}, undefined), { ok: false, error: 'forbidden' });
  trusted = true;
  assert.equal((await handlers.get('nqa:status')({}, undefined)).mock, true);
});

// ---------------------------------------------------------------------------
// The API loader: mock only when asked or when app-api.mjs is absent; a
// broken real module is an error, never a silent fall back to fake data.

test('loadApi: forced mock, NQA_MOCK_API=1, missing module → mock with the reason', async () => {
  const appDir = path.join(APP);
  assert.equal((await loadApi({ appDir, forceMock: true })).mode, 'mock');
  assert.equal((await loadApi({ appDir, env: { NQA_MOCK_API: '1' } })).reason, 'NQA_MOCK_API=1');
  const missing = await loadApi({ appDir, env: {}, exists: () => false });
  assert.equal(missing.mode, 'mock', 'a development run without the bridge yet');
  assert.match(missing.reason, /not in this build/);
});

test('loadApi: a packaged app without its bridge is an error state, never the demo data (a key saved there would go nowhere)', async () => {
  const appDir = path.join(os.tmpdir(), 'NeverQuestAlone.app', 'Contents', 'Resources', 'app.asar');
  const logged = [];
  const out = await loadApi({ appDir, packaged: true, env: {}, exists: () => false, log: l => logged.push(l) });
  assert.equal(out.mode, 'error');
  assert.equal(out.api.mock, false);
  assert.match(out.reason, /missing its bridge/);
  assert.equal((await out.api.setKey('anthropic', 'x')).error, 'bridge_unavailable');
  assert.equal((await out.api.status()).backend.rt.reason, 'bridge_unavailable');
  assert.equal(logged.length, 1);
});

/** A fake bridge/byok/boot.mjs, recording every call in order. */
function fakeBridge(overrides = {}) {
  const calls = [];
  const mods = {
    boot: {
      bootByok: async (opts) => {
        calls.push(['bootByok', opts]);
        const api = { status: async () => ({ real: 1 }), stop: async () => { calls.push(['api.stop']); } };
        return {
          api, bridge: { kind: 'bridge' }, backend: { kind: 'local-backend' }, keystore: { kind: 'keystore' }, config: { byok: {} },
          stop: async () => { await api.stop(); calls.push(['bridge.stop']); },
        };
      },
    },
    ...overrides,
  };
  const imported = [];
  const importer = async file => {
    imported.push(file);
    const key = Object.keys(BRIDGE_FILES).find(k => file.endsWith(path.join(...BRIDGE_FILES[k].split('/'))));
    if (!key || !mods[key]) throw new Error(`no such module ${file}`);
    return mods[key];
  };
  return { calls, imported, importer, find: name => calls.find(c => c[0] === name) };
}
const PATHS = { userData: '/u/NeverQuestAlone', state: '/u/NeverQuestAlone/bridge', logs: '/u/logs', appDir: APP, version: '0.1.0' };
const inRepo = p => p.endsWith(path.join('bridge', 'byok', 'boot.mjs'));

test('loadApi: main boots the bridge through bridge/byok/boot.mjs with its folders, log and opener', async () => {
  const f = fakeBridge();
  const openExternal = async () => {};
  const out = await loadApi({ appDir: APP, env: {}, exists: inRepo, importer: f.importer, paths: PATHS, platform: 'darwin', openExternal });
  assert.equal(out.mode, 'real');
  assert.deepEqual(await out.api.status(), { real: 1 });
  assert.equal((await out.api.uninstall()).error, 'unsupported', 'missing calls answer unsupported');
  assert.deepEqual(BRIDGE_FILES, { boot: 'bridge/byok/boot.mjs' });

  const [, opts] = f.find('bootByok');
  assert.equal(opts.paths, PATHS, 'bridge state under the app’s own folder, never the retired build’s');
  assert.equal(opts.platform, 'darwin');
  assert.equal(opts.openExternal, openExternal, 'the sign-in opener');
  assert.equal(opts.confirmControl, undefined, 'no control pipe (systems plan D6)');
  assert.equal(typeof opts.log, 'function');
  assert.equal(typeof opts.log.addSecret, 'function', 'keys are registered with the shell’s redactor');
  assert.equal(typeof opts.importer, 'function');
  await assert.rejects(opts.importer('/elsewhere/evil.mjs'), /refused bridge code from outside the app/, 'boot’s own lazy imports stay inside the bridge root');

  await out.api.stop();
  assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ['api.stop', 'bridge.stop']);
});

test('loadApi: a module that fails to load or start is an error state, never demo data', async () => {
  const broken = await loadApi({ appDir: APP, env: {}, exists: inRepo, importer: async () => { throw new Error(`cannot load ${CANARY}`); } });
  assert.equal(broken.mode, 'error');
  assert.ok(!broken.reason.includes('CANARY'), 'the reason is redacted');
  assert.equal((await broken.api.setCaps({})).error, 'bridge_unavailable');
  assert.equal((await broken.api.status()).backend.rt.reason, 'bridge_unavailable');

  const noBoot = await loadApi({ appDir: APP, env: {}, exists: inRepo, importer: fakeBridge({ boot: { startAppBridge: async () => ({}) } }).importer });
  assert.equal(noBoot.mode, 'error');
  assert.match(noBoot.reason, /bootByok/, 'only the export boot.mjs names counts');

  const throws = await loadApi({ appDir: APP, env: {}, exists: inRepo, importer: fakeBridge({ boot: { bootByok: async () => { throw Object.assign(new Error('Another copy of NeverQuestAlone is already running for this World of Warcraft (pid 42). Quit it first.'), { code: 'BRIDGE_RUNNING' }); } } }).importer, paths: PATHS });
  assert.equal(throws.mode, 'error');
  assert.match(throws.reason, /already running/, 'the plain message reaches the window');

  let stopped = false;
  const noApi = await loadApi({ appDir: APP, env: {}, exists: inRepo, importer: fakeBridge({ boot: { bootByok: async () => ({ stop: async () => { stopped = true; } }) } }).importer, paths: PATHS });
  assert.equal(noApi.mode, 'error');
  assert.ok(stopped, 'a half-started bridge is stopped');
  assert.equal((await unavailableApi('x').providers()).length, 0);
});

test('loadApi: a packaged app imports bridge code only from inside app.asar (SC-9)', async () => {
  // A per-user NSIS install: the folder beside app.asar is the player's to write.
  const appDir = path.join(os.tmpdir(), 'Programs', 'NeverQuestAlone', 'resources', 'app.asar');
  const planted = path.resolve(appDir, '..', '..', 'bridge', 'byok', 'boot.mjs');
  const f = fakeBridge();
  const looked = [];
  const out = await loadApi({ appDir, packaged: true, env: {}, importer: f.importer, paths: PATHS, exists: p => { looked.push(path.resolve(p)); return path.resolve(p) === planted; } });
  assert.equal(out.mode, 'error', 'the planted file is never seen: no bridge inside the app');
  assert.deepEqual(f.imported, [], 'nothing imported');
  assert.ok(!looked.includes(planted), 'nor even looked for');
  assert.deepEqual(apiCandidates(appDir, { packaged: true }), [path.join(appDir, 'bridge', 'byok', 'boot.mjs')]);
  assert.deepEqual(bridgeRoots(appDir, { packaged: true }), [path.resolve(appDir)]);

  const inside = fakeBridge();
  const real = await loadApi({ appDir, packaged: true, env: {}, exists: () => true, importer: inside.importer, paths: PATHS });
  assert.equal(real.mode, 'real');
  assert.equal(inside.imported.length, Object.keys(BRIDGE_FILES).length);
  assert.ok(inside.imported.every(p => isInside(appDir, p)), 'every module from inside the asar');
  const [, opts] = inside.find('bootByok');
  await assert.rejects(opts.importer(planted), /refused bridge code from outside the app/);

  const mockEnv = await loadApi({ appDir, packaged: true, env: { NQA_MOCK_API: '1' }, exists: () => true, importer: fakeBridge().importer, paths: PATHS });
  assert.equal(mockEnv.mode, 'real', 'NQA_MOCK_API is for development runs only');
  assert.equal(apiCandidates(APP).length, 2, 'a development run also looks in the repo');
  assert.equal(isInside('/a/b', '/a/b/../c/x'), false);
});

test('bridgeLogger: the bridge’s (event, data) lines go to the shell log redacted', () => {
  const lines = [];
  const blog = bridgeLogger(l => lines.push(l));
  blog.addSecret('tok-SECRET-123456');
  blog('turn', { key: CANARY, token: 'tok-SECRET-123456', n: 1 }); // gitleaks:allow (a canary)
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^bridge turn /);
  assert.ok(!lines[0].includes('CANARY') && !lines[0].includes('SECRET'), lines[0]);
});

test('the shell\'s own log: a staged key of no known shape, or one the bridge registered, never reaches it (C3 review)', async () => {
  const { secretSet, redactText } = await import('../../app/desktop/src/redact.mjs');
  // Shapes stageKey takes but no KEY_PATTERN names (a provider we don't know the prefix of).
  const staged = 'bones-TESTKEY-0123456789abcdefghij';
  const registered = 'ProviderX.TESTKEY.9876543210zyxwvu';
  assert.equal(redactText(`boom ${staged}`), `boom ${staged}`, 'the patterns alone miss it');
  const set = secretSet();
  const stager = { list: [staged] };
  set.from(() => stager.list);
  set.from(() => { throw new Error('a source that fails'); });
  set.add('short');
  assert.deepEqual(set.list(), [staged]);
  // bridgeLogger hands every key the bridge registers to the shell's log as well.
  const lines = [];
  const log = l => lines.push(redactText(String(l), { extra: set.list() }));
  log.addSecret = s => set.add(s);
  const blog = bridgeLogger(log);
  blog.addSecret(registered);
  assert.deepEqual(set.list().sort(), [registered, staged].sort());
  // The shell's own lines (an uncaught exception, a failed start) go through log() alone.
  log(`uncaught: Error: bad request with ${staged} and ${registered}\n    at x (main.mjs:1:1)`);
  assert.ok(!lines.at(-1).includes(staged) && !lines.at(-1).includes(registered), lines.at(-1));
  assert.match(lines.at(-1), /<redacted> and <redacted>/);
  stager.list = [];
  assert.deepEqual(set.list(), [registered], 'a staged key leaves with its stage');
  // main.mjs: log() redacts with the set, which holds the key stager's keys and the bridge's; so
  // does log.scrub, which the bridge's lines are redacted with once before log.write takes them
  // (code health BR-21), and a crash's lines are written at once.
  const main = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  assert.match(main, /const logSecrets = secretSet\(\);/);
  assert.match(main, /function log\(line\) \{\n  logLine\(redactText\(String\(line\), \{ extra: logSecrets\.list\(\) \}\)\);\n\}/);
  assert.match(main, /log\.addSecret = s => logSecrets\.add\(s\);\nlog\.scrub = s => redactText\(String\(s \?\? ''\), \{ extra: logSecrets\.list\(\) \}\);\nlog\.write = logLine;/);
  assert.match(main, /process\.on\('uncaughtException', \(e\) => \{ log\(`uncaught: \$\{e\?\.stack \?\? e\}`\); if \(!logFlush\.writing\) flushLogSync\(\); \}\);/);
  assert.match(main, /process\.on\('exit', flushLogSync\);/);
  // The bridge's lines through bridgeLogger: redacted once, with the shell's set, then written as they are.
  const shell = [];
  const slog = l => shell.push(['log', l]);
  slog.scrub = s => redactText(String(s), { extra: set.list() });
  slog.write = l => shell.push(['write', l]);
  const blog2 = bridgeLogger(slog);
  blog2('turn', { said: `bad ${registered}` });
  blog2.line(blog2.scrub(`turn {"said":"bad ${registered}"}`));
  assert.deepEqual(shell, [['write', 'bridge turn {"said":"bad <redacted>"}'], ['write', 'bridge turn {"said":"bad <redacted>"}']]);
  assert.match(main, /keys = createKeyStager\(\);\n  logSecrets\.from\(\(\) => keys\.secrets\(\)\);/);
});

test('the mock API follows the contract and never returns a key', async () => {
  const api = createMockApi({ delayMs: 0 });
  const st = await api.status();
  assert.equal(st.backend.rt.state, 'no_key');
  const list = await api.providers();
  assert.deepEqual(list.map(p => p.id).sort(), [...PROVIDER_IDS].sort());
  assert.equal(list.find(p => p.id === 'google').display.card, 'Gemini');
  for (const p of list) assert.ok(Array.isArray(p.models) && (p.models.length || p.id === 'custom') && p.privacyCard && p.terms, p.id);
  assert.deepEqual(list.find(p => p.id === 'custom').custom, null, 'Other before its service is set');
  const set = await api.setKey('anthropic', CANARY);
  assert.equal(set.masked, 'sk-ant-…A1b2');
  assert.ok(!JSON.stringify(await api.providers()).includes('CANARY'));
  assert.ok(!JSON.stringify(await api.status()).includes('CANARY'));
  assert.equal((await api.status()).backend.rt.state, 'ready');
  assert.equal((await api.testKey('anthropic')).testCall.micros, 14);
  await api.setKey('openai', 'sk-proj-BADKEY0123456789abcdef');
  assert.equal((await api.testKey('openai')).error, 'auth_invalid');
  let pushed = null;
  api.onChange(s => { pushed = s; });
  await api.setPaused(true);
  assert.equal(pushed.backend.rt.state, 'paused');
});

// ---------------------------------------------------------------------------
// The shell's settings file.

test('app-state: defaults, normalization, owner-only atomic writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bones-app-state-'));
  try {
    const s = createAppState(dir);
    assert.equal(s.get().onboarded, false);
    assert.equal(s.get().updates.mode, 'notify');
    s.set({ onboarded: true });
    s.saveUpdatesPrefs({ mode: 'never', neverSince: 5 });
    const again = createAppState(dir);
    assert.equal(again.get().onboarded, true);
    assert.equal(again.get().updates.mode, 'never');
    assert.equal(again.get().updates.neverSince, 5);
    if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
    fs.writeFileSync(s.file, '{not json');
    assert.equal(createAppState(dir).get().onboarded, false, 'damaged → defaults');
    assert.deepEqual(normalizeState({ onboarded: 'yes', updates: { mode: 'sometimes', lastCheck: 'x' }, evil: 1 }), {
      v: 1, onboarded: false, notifications: true, zoom: 0, updates: { mode: 'notify', auto: true, relaunchHidden: false, neverSince: null, lastReminder: null, lastCheck: null }, noticesSeen: [],
      defaultsSeen: false, alertsAsked: false, addonConsent: null, setup: null,
    });
    // Setup's saved screen (onboarding spec §3.11): v2, known screens and paths, no secrets.
    assert.deepEqual(normalizeState({ setup: { v: 2, screen: 'connect', path: 'key', provider: 'anthropic', key: 'sk-x' } }).setup, { v: 2, screen: 'connect', path: 'key', provider: 'anthropic' });
    assert.equal(normalizeState({ setup: { v: 1, screen: 'connect' } }).setup, null, 'a v1 file has no saved screen');
    assert.equal(normalizeState({ setup: { v: 2, screen: 'evil' } }).setup, null);
    // The window's zoom (D-16): half steps, in range; anything else is 100%.
    assert.equal(normalizeState({ zoom: 1.2 }).zoom, 1);
    assert.equal(normalizeState({ zoom: 99 }).zoom, 3);
    assert.equal(normalizeState({ zoom: '2' }).zoom, 0);
    s.set({ zoom: -1.5 });
    assert.equal(createAppState(dir).get().zoom, -1.5, 'kept across restarts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one redactor (SY-13): the shell\u2019s redactText is the bridge\u2019s redact(), so shell.log never keeps a raw authorization header, code_verifier or ?code=', async () => {
  const { redactText, REDACTED: SHELL } = await import('../../app/desktop/src/redact.mjs');
  const { redact, REDACTED } = await import('../../bridge/byok/security/redact.mjs');
  assert.equal(SHELL, REDACTED, 'one marker');
  const leaked = [
    'authorization: sk-raw-token-with-no-known-prefix-0123456789',
    '{"code_verifier":"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"}',
    'GET http://127.0.0.1:53682/callback?code=4/0AbCdEf-123_secret&state=x',
  ];
  for (const line of leaked) {
    const out = redactText(line, { home: '/nonexistent-home' });
    assert.equal(out, redact(line), line);
    assert.ok(out.includes(REDACTED), line);
    assert.doesNotMatch(out, /sk-raw|dBjftJeZ|0AbCdEf/, line);
  }
  assert.equal(redactText('/Users/p/Library/x', { home: '/Users/p' }), '~/Library/x', 'the home folder, the shell\'s one addition');
  const src = fs.readFileSync(new URL('../../app/desktop/src/redact.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /KEY_PATTERNS|sk-ant-\[|AIza\[/, 'no key patterns of its own');
});

test('main.mjs gives ipc the clipboard’s readText (SY-18), or a saved key never leaves the clipboard (PRD §8.1)', () => {
  const main = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  assert.match(main, /readText: async \(\) => \(SHOTS \? shotsClipboard : HEADLESS \? '' : clipboard\.readText\(\)\) \},/);
});

// DU-03 (desktop UI critic r2): the page may say "Checking with {co}…" only once the player agreed.
test('onAgreed: after Agree in a key’s or Other’s dialog (with the key’s AI), never on Cancel or before the dialog; a saved key with its terms recorded has no dialog and says it at once', async () => {
  const heard = [];
  let order = [];
  const agreeing = makeCtx({ confirm: () => { order.push('dialog'); return true; } });
  agreeing.ctx.onAgreed = (call, provider) => { order.push('agreed'); heard.push([call, provider]); };
  agreeing.ctx.clipboard.readText = async () => `sk-ant-api03-CANARY${'x'.repeat(80)}`; // gitleaks:allow (a canary)
  const base = agreeing.ctx.api.testStagedKey;
  agreeing.ctx.api.testStagedKey = (...a) => { order.push('test'); return base(...a); };
  const r = await agreeing.ipc.call('pasteKey', { provider: 'anthropic' });
  assert.equal(r.ok, true);
  assert.deepEqual(heard, [['pasteKey', 'anthropic']]);
  assert.deepEqual(order, ['dialog', 'agreed', 'test'], 'agreed after the dialog, before the test');
  const cancel = makeCtx({ confirm: false });
  const none = [];
  cancel.ctx.onAgreed = (...a) => none.push(a);
  cancel.ctx.clipboard.readText = async () => `sk-ant-api03-CANARY${'x'.repeat(80)}`; // gitleaks:allow (a canary)
  assert.equal((await cancel.ipc.call('pasteKey', { provider: 'anthropic' })).error, 'cancelled');
  cancel.ctx.clipboard.readText = async () => 'not a key';
  cancel.ctx.lastPasteAt = 0;
  assert.equal((await cancel.ipc.call('pasteKey', { provider: 'anthropic' })).error, 'not_a_key');
  assert.deepEqual(none, [], 'nothing on Cancel, and nothing when there was no dialog to agree to');
  // Use saved key with the terms recorded: no dialog, and the test starts at once.
  const saved = makeCtx({ confirm: () => { throw new Error('no dialog expected'); } });
  const said = [];
  saved.ctx.onAgreed = (...a) => said.push(a);
  await saved.ctx.api.setKey('anthropic', `sk-ant-api03-CANARY${'x'.repeat(80)}`); // gitleaks:allow (a canary)
  await saved.ipc.call('useSavedKey', { provider: 'anthropic' });
  assert.deepEqual(said, [['useSavedKey', 'anthropic']]);
  // Only these five calls say it (signIn: after its dialog, as the browser opens): a plain setting never does.
  const others = makeCtx();
  const quiet = [];
  others.ctx.onAgreed = (...a) => quiet.push(a);
  await others.ipc.call('setPrivacy', { identity: true, otherNames: false, companion: false, echo: false, gameContext: true });
  assert.deepEqual(quiet, []);
  assert.deepEqual(Object.entries(HANDLERS).filter(([, h]) => h.announce).map(([n]) => n).sort(), ['connectCustom', 'connectKey', 'pasteKey', 'signIn', 'useSavedKey']);
  // Other's form: agreed after its dialog, with Other's id, before its one test request.
  const custom = makeCtx({ confirm: () => true });
  const heardCustom = [];
  custom.ctx.onAgreed = (...a) => heardCustom.push(a);
  assert.equal((await custom.ipc.call('connectCustom', { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' })).ok, true);
  assert.deepEqual(heardCustom, [['connectCustom', 'custom']]);
});
