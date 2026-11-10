// What the local backend gives the desktop app (bridge/byok/backend.mjs; public BYOK PRD §6.2, §8.4
// item 3, §9.2, §10 "Model not found", KY-8, PR-3, PV-3, US-7): lastRequest(chatId),
// usageHistory({days}), the model check and its notice,
// memory(char) and forgetMemory(char), transcripts.forget/deleteAll, and the reply's usage kept
// beside its history row. Against the providers' mock on 127.0.0.1 with canary keys; temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  startMock, reply, errorReply, makeBackend, canaryKeystore, sendParams, waitFor, sleep, tmpDir, manifestsAt, flatPrices, CANARY_KEYS,
} from './helpers/byok-env.mjs';
import { fixture } from './helpers/mock-provider.mjs';
import { scanDirForCanaries } from './helpers/canary.mjs';
import { turnUsage, digestText, charArg, settingsOf } from '../../bridge/byok/backend.mjs';
import { createTranscripts } from '../../bridge/byok/runtime/history.mjs';
import { applyLogbook } from '../../bridge/byok/runtime/logbook.mjs';

const CHAT = 'c3f9a1e';
const CHAT2 = 'c4b2d0f';
const chatCalls = mock => mock.requests.filter(r => r.method === 'POST');
const gets = (mock, re) => mock.requests.filter(r => r.method === 'GET' && re.test(r.url));
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function started(opts) {
  const env = makeBackend(opts);
  await env.backend.start();
  return env;
}

// ------------------------------------------------------------------------------------------ KY-8

test('lastRequest(chatId): the exact request each chat sent, the key redacted, in memory only; the most recent across chats with none', async () => {
  const mock = await startMock(() => reply('Mulgore.\n\nTL;DR: Mulgore.'));
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), log: (k, d) => lines.push(JSON.stringify([k, d])) });
  try {
    assert.equal(env.backend.lastRequest(CHAT), null);
    assert.equal(env.backend.lastRequest(), null);
    await env.backend.send(sendParams(CHAT, 'a_1', 'where am I?'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'first');
    await env.backend.send(sendParams(CHAT2, 'a_2', 'and now?'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'second');
    const a = env.backend.lastRequest(CHAT);
    assert.equal(a.chatId, CHAT);
    assert.equal(a.purpose, 'turn');
    assert.equal(a.provider, 'anthropic');
    assert.equal(a.model, 'claude-sonnet-5-5', 'Claude\'s default (fix-102)');
    assert.equal(a.method, 'POST');
    assert.equal(a.url, `${mock.url}/v1/messages`);
    assert.deepEqual(a.body, chatCalls(mock)[0].body, 'exactly the JSON that went');
    assert.match(a.headers['x-api-key'], /^sk-ant-…xxxx \(redacted\)$/, '§8.4: the auth header as sk-ant-…A1b2 (redacted)');
    assert.equal(a.headers['anthropic-version'], '2023-06-01');
    assert.ok(Number.isFinite(a.at));
    assert.equal(env.backend.lastRequest().chatId, CHAT2, 'no chat id: the most recent');
    assert.deepEqual(env.backend.lastRequest(CHAT2).body, chatCalls(mock)[1].body);
    // A copy: changing it changes nothing kept.
    a.body.messages = [];
    assert.ok(env.backend.lastRequest(CHAT).body.messages.length > 0);
    // Never written, logged or in the diagnostics: no key anywhere, and no request text either.
    const everything = JSON.stringify([env.backend.lastRequest(CHAT), env.backend.lastRequest(CHAT2)]);
    assert.ok(!everything.includes(CANARY_KEYS.anthropic));
    assert.ok(!JSON.stringify(env.backend.diagnostics()).includes('where am I?'));
    assert.ok(!lines.join('\n').includes('where am I?'));
    for (const f of fs.readdirSync(env.dataDir).filter(f => f.endsWith('.json'))) {
      assert.ok(!fs.readFileSync(path.join(env.dataDir, f), 'utf8').includes('"x-api-key"'), `${f} holds no request`);
    }
    assert.deepEqual(scanDirForCanaries(env.dataDir), []);
    // A forgotten chat's request goes with it; the most recent falls back to the other chat's.
    env.backend.forget(CHAT2);
    assert.equal(env.backend.lastRequest(CHAT2), null);
    assert.equal(env.backend.lastRequest().chatId, CHAT);
    env.backend.transcripts.deleteAll();
    assert.equal(env.backend.lastRequest(CHAT), null);
    assert.equal(env.backend.lastRequest(), null);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('lastRequest: the turn\'s request is the view; a broken map block makes no second call (no repair pass: systems plan D6)', async () => {
  const BROKEN = 'Route.\n\n```wowmap\n{"op":"set","layer":"mulgore","title":"Route","ordered":true,"points":[{"x":49.5,"y":67.5,"label":"Wolves"}]}\n```\n\nTL;DR: route.';
  const mock = await startMock(() => reply(BROKEN));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    await env.backend.send(sendParams(CHAT, 'r_1', 'draw it'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    const r = env.backend.lastRequest(CHAT);
    assert.equal(r.purpose, 'turn');
    assert.deepEqual(r.body, chatCalls(mock)[0].body, 'what the model saw for the turn');
    assert.equal(r.repair, undefined);
    assert.equal(chatCalls(mock).length, 1, 'one call');
    assert.match(env.chats('final')[0].message.content[0].text, /```wowmap/, 'the reply as the model wrote it; the core says the route couldn\'t be drawn');
    // The next turn replaces it.
    await env.backend.send(sendParams(CHAT, 'r_2', 'draw it again'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'second final');
    assert.deepEqual(env.backend.lastRequest(CHAT).body, chatCalls(mock)[1].body);
  } finally { await env.backend.stop(); await mock.close(); }
});

// ------------------------------------------------------------------------------ usage history

test('usageHistory({days}): each turn that counted, by day and provider; the last replies with their costs; numbers and ids only on disk', async () => {
  let n = 0;
  const mock = await startMock(() => (++n === 2 ? errorReply(402, { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low' } }) : reply('ok.\n\nTL;DR: ok.', { input: 2000, output: 80 })));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices({ input: 1, output: 5 }) });
  try {
    await env.backend.send(sendParams(CHAT, 'u_1', 'first question'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'reply');
    await env.backend.send(sendParams(CHAT, 'u_2', 'second question'));
    await waitFor(() => env.chats('error').length === 1, 5000, 'the billing error');
    await env.backend.send(sendParams('c0ffee0', 'u_3', '', { kind: 'evt', event: { kind: 'route_done', args: {} } }));
    await waitFor(() => env.chats('final').length === 2, 5000, 'the event reply');
    const h = env.backend.usageHistory({ days: 7 });
    assert.equal(h.days.length, 7);
    const today = h.days.at(-1);
    assert.equal(today.day, env.backend.caps.snapshot().day);
    assert.equal(today.micros, 2 * (2000 + 80 * 5), 'the 402 answered and billed nothing');
    assert.equal(today.turns, 2, 'typed turns, the refused one included (it reached the provider)');
    assert.equal(today.auto, 1);
    assert.deepEqual(today.byProvider, { anthropic: { micros: 4800, turns: 3, auto: 1 } });
    assert.equal(h.recent.length, 3);
    assert.deepEqual(h.recent[0], { at: h.recent[0].at, chatId: 'c0ffee0', provider: 'anthropic', model: 'claude-sonnet-5-5', in: 2000, out: 80, micros: 2400, exact: false, auto: true });
    assert.equal(h.recent[1].error, 'out_of_credit');
    assert.equal(h.recent[1].micros, 0);
    assert.equal(h.recent[2].chatId, CHAT);
    // The caps agree on today's spend.
    assert.equal(env.backend.caps.snapshot().spentMicros, today.micros);
    const raw = fs.readFileSync(path.join(env.dataDir, 'usage-history.json'), 'utf8');
    assert.ok(!/question|ok\.|TL;DR|credit balance/.test(raw), 'no prompt, reply or provider text');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(env.dataDir, 'usage-history.json')).mode & 0o777, 0o600); // Windows has no POSIX modes
    // A new process reads it back.
    const again = makeBackend({ url: mock.url, keystore: await canaryKeystore(), dataDir: env.dataDir });
    assert.equal(again.backend.usageHistory({ days: 1 }).days[0].micros, 4800);
    assert.equal(again.backend.usageHistory().days.length, 30, '30 days by default');
  } finally { await env.backend.stop(); await mock.close(); }
});

// --------------------------------------------------------------------------- the reply's usage

test('the reply\'s usage is kept with its row in the transcript and in the ledger: outcomes() returns it, after a restart too (code health BR-22)', async () => {
  const mock = await startMock(() => reply('Mulgore.\n\nTL;DR: Mulgore.', { input: 1500, output: 60 }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    await env.backend.send(sendParams(CHAT, 'h_1', 'where?'));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'final');
    const want = { in: 1500, out: 60, micros: 1500 * 2 + 60 * 10, model: 'claude-sonnet-5-5', exact: false };
    assert.deepEqual(fin.usage, want);
    const [user, asst] = env.backend.transcripts.rows(CHAT, 10);
    assert.equal(user.usage, undefined, 'the player\'s row carries none');
    assert.deepEqual(asst.usage, want);
    assert.deepEqual(env.backend.outcomes([fin.runId])[0].usage, want);
    await env.backend.stop();
    const b = makeBackend({ url: mock.url, keystore: await canaryKeystore(), dataDir: env.dataDir });
    await b.backend.start();
    assert.deepEqual(b.backend.outcomes([fin.runId])[0].usage, want, 'read back from the ledger');
    await b.backend.stop();
  } finally { await env.backend.stop(); await mock.close(); }
  assert.deepEqual(turnUsage({ in: 1.9, out: 2, micros: 3, model: 'm', exact: 1 }), { in: 1, out: 2, micros: 3, model: 'm', exact: false });
  assert.equal(turnUsage({ in: 1, out: 2 }), null);
  assert.equal(turnUsage('x'), null);
});

// ---------------------------------------------------------------------------- the transcripts

test('transcripts.forget(chatId) and transcripts.deleteAll(): the rows (their run and usage with them) and the last requests go', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    await env.backend.send(sendParams(CHAT, 't_1', 'one'));
    await env.backend.send(sendParams(CHAT2, 't_2', 'two'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'both');
    assert.equal(env.backend.transcripts.rows(CHAT).length, 2);
    assert.equal(env.backend.transcripts.forget(CHAT), true);
    assert.equal(env.backend.transcripts.forget(CHAT), false, 'gone already');
    assert.equal(env.backend.transcripts.forget('../etc'), false, 'not a chat id');
    assert.deepEqual(env.backend.transcripts.rows(CHAT), []);
    assert.equal(env.backend.lastRequest(CHAT), null);
    assert.ok(env.backend.lastRequest(CHAT2));
    assert.equal(env.backend.outcomes(['nqa:3fa9c2d1:t_1'])[0].message, undefined, 'its reply is gone with its rows');
    assert.equal(env.backend.transcripts.deleteAll(), 1);
    assert.deepEqual(env.backend.transcripts.chats(), []);
    // The chat goes on: its next turn's rows still rise past the old ones.
    await env.backend.send(sendParams(CHAT2, 't_3', 'three'));
    await waitFor(() => env.chats('final').length === 3, 5000, 'third');
    assert.equal(env.backend.transcripts.rows(CHAT2).length, 2);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('transcripts: the configured retention applies at start, while running (a daily prune) and at once when the app changes it (final review L5-5)', async () => {
  const DAY = 86400e3;
  assert.equal(settingsOf({ transcripts: { retentionDays: 7 } }).retentionDays, 7);
  for (const bad of [undefined, 0, -1, 1.5, '7', 400]) assert.equal(settingsOf({ transcripts: { retentionDays: bad } }).retentionDays, 30, String(bad));
  const dataDir = tmpDir();
  let clock = Date.now();
  const seed = (chat, daysAgo) => {
    const tr = createTranscripts(dataDir, { now: () => clock - daysAgo * DAY });
    tr.append(chat, { role: 'user', text: `asked ${daysAgo} days ago` });
    tr.append(chat, { role: 'assistant', text: 'answered' });
  };
  seed(CHAT, 10);
  seed(CHAT2, 5);
  const env = await started({ dataDir, config: { transcripts: { retentionDays: 7 } }, now: () => clock, pruneEveryMs: 30 });
  try {
    assert.deepEqual(env.backend.transcripts.chats(), [CHAT2], 'a 10-day-old exchange goes at start with 7 days kept');
    clock += 3 * DAY; // the app keeps running
    await waitFor(() => env.backend.transcripts.chats().length === 0, 2000, 'the running prune');
    seed('c0ffee0', 3);
    await env.backend.setConfig({ transcripts: { retentionDays: 2 } });
    assert.deepEqual(env.backend.transcripts.chats(), [], 'a shorter retention applies at once');
  } finally { await env.backend.stop(); }
});

test('regenerateSafetyId: a new random id for the next OpenAI request, even over one the config pinned (final review L5-6)', async () => {
  const mock = await startMock(() => fixture('openai', 'http-403-region.json'));
  const pinned = '11111111-2222-3333-4444-555555555555';
  const env = await started({ url: mock.url, manifests: manifestsAt(mock.url, ['openai']), keystore: await canaryKeystore(['openai']), config: { provider: 'openai', safetyId: pinned } });
  const ids = () => chatCalls(mock).map(r => r.body.safety_identifier);
  try {
    await env.backend.send(sendParams(CHAT, 's_1', 'one'));
    await waitFor(() => env.chats('error').length === 1, 5000, 'first');
    assert.deepEqual(ids(), [pinned]);
    assert.equal(env.backend.regenerateSafetyId(), true);
    const fresh = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'byok-chats.json'), 'utf8')).safetyId;
    await env.backend.send(sendParams(CHAT, 's_2', 'two'));
    await waitFor(() => env.chats('error').length === 2, 5000, 'second');
    assert.equal(ids()[1], fresh);
    assert.notEqual(fresh, pinned);
  } finally { await env.backend.stop(); await mock.close(); }
});

// --------------------------------------------------------------------------------- the memory

test('memory(char): the digest (identity setting applied), its text and the logbook\'s files; memory() lists characters; forgetMemory deletes one', async () => {
  const env = await started({ keystore: await canaryKeystore() });
  try {
    assert.deepEqual(env.backend.memory(), { characters: [] });
    const doc = { v: 1, sid: 'a1b2c3d4e5f60718', seq: 1, t: 1790000000,
      char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 9, xp: 10, xpMax: 1500, money: 11800 },
      loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66.3 },
      quests: [{ id: 748, title: 'Poison Water', level: 5, trivial: false, complete: false, obj: [] }], prof: [], pending: [], omitted: [] };
    assert.equal(applyLogbook(doc, { dataDir: env.dataDir }).ok, true);
    assert.deepEqual(env.backend.memory(), { characters: ['Tavi-Testrealm'] });
    const m = env.backend.memory({ name: 'Tavi', realm: 'Testrealm' });
    assert.equal(m.ok, true);
    assert.deepEqual(m.char, { name: 'Tavi', realm: 'Testrealm' });
    assert.equal(m.key, 'Tavi-Testrealm');
    assert.equal(m.dir, path.join(env.dataDir, 'memory', 'Tavi-Testrealm'));
    assert.deepEqual(m.files.map(f => f.name).filter(n => n !== 'log.md').sort(), ['character.md', 'quests.md'], 'what the logbook wrote (log.md once there is a milestone)');
    assert.ok(m.files.every(f => f.bytes > 0 && Number.isFinite(f.modifiedAt)));
    assert.ok(m.digest.character.some(l => /level 9/.test(l)));
    assert.ok(!JSON.stringify(m.digest).includes('Tavi'), 'identity off: what a turn sends');
    assert.match(m.text, /^Updated .*\n\nCharacter:\n- /);
    assert.match(m.text, /Poison Water/);
    assert.deepEqual(env.backend.memory('Tavi-Testrealm').files, m.files, '"Name-Realm" works too');
    assert.deepEqual(env.backend.memory({ name: 'Nobody', realm: 'Testrealm' }).files, []);
    assert.equal(env.backend.memory({ name: 'Nobody' }).digest, null);
    assert.deepEqual(env.backend.forgetMemory(''), { ok: false, error: 'no character' });
    assert.deepEqual(env.backend.forgetMemory('Tavi-Testrealm'), { ok: true, removed: true });
    assert.deepEqual(env.backend.forgetMemory('Tavi-Testrealm'), { ok: true, removed: false });
    assert.deepEqual(env.backend.memory(), { characters: [] });
    applyLogbook(doc, { dataDir: env.dataDir });
    assert.deepEqual(env.backend.forgetAllMemory(), { ok: true, removed: 1 });
  } finally { await env.backend.stop(); }
  assert.deepEqual(charArg('Tavi-Area 52'), { name: 'Tavi', realm: 'Area 52' });
  assert.deepEqual(charArg({ name: ' Tavi ' }), { name: 'Tavi', realm: null });
  assert.equal(charArg(null), null);
  assert.equal(digestText(null), '');
});

// ----------------------------------------------------------------------------- the model check

function anthropicWith(models, onPost = () => reply('Fine.\n\nTL;DR: fine.')) {
  return startMock((r) => {
    if (r.method === 'GET' && r.url.startsWith('/v1/models')) return json({ data: models.map(id => ({ id, type: 'model' })), has_more: false });
    if (r.method === 'POST') return onPost(r);
    return null;
  });
}

test('the model check (PV-3): a model gone is switched to the nearest no dearer, status().notice says so, and the next turn\'s chat hears it once', async () => {
  const mock = await anthropicWith(['claude-haiku-4-5-20251001']);
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), config: { model: 'claude-sonnet-5' }, checks: { models: true },
    log: (k, d) => lines.push([k, d]) });
  try {
    await waitFor(() => env.backend.status().notice, 3000, 'the notice');
    const s = env.backend.status();
    assert.deepEqual({ ...s.notice, at: undefined }, { kind: 'model_switched', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', at: undefined });
    assert.deepEqual({ ...s.modelCheck, at: undefined }, { ok: true, models: 1, at: undefined });
    assert.equal(s.provider.model, 'claude-haiku-4-5');
    assert.equal(env.backend.slotExtras().bridge.provider.modelName, 'Claude Haiku 4.5');
    assert.ok(env.changes.length >= 1, 'the core is told the slot changed');
    assert.deepEqual(lines.find(([k]) => k === 'byok-model-switched')[1], { reason: 'start', provider: 'anthropic', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', by: 'cost' });
    await env.backend.send(sendParams(CHAT, 'm_1', 'hi'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'the reply');
    const notice = env.chats('error');
    assert.equal(notice.length, 1);
    assert.equal(notice[0].runId, 'notice:nqa:3fa9c2d1:m_1');
    assert.equal(notice[0].chatId, CHAT);
    assert.equal(notice[0].errorKind, 'model_not_found');
    assert.equal(notice[0].action, 'desktop');
    assert.equal(notice[0].answers, 'none', 'it answers no message (final review L4-2)');
    assert.equal(notice[0].errorMessage, "Claude Sonnet 5 isn't available on your Anthropic account. Switched to Claude Haiku 4.5 for now. Change it in the NeverQuestAlone app.");
    assert.ok(env.events.findIndex(e => e.payload.state === 'error') < env.events.findIndex(e => e.payload.state === 'final'), 'before the reply');
    assert.equal(chatCalls(mock)[0].body.model, 'claude-haiku-4-5');
    await env.backend.send(sendParams(CHAT2, 'm_2', 'again'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'the second reply');
    assert.equal(env.chats('error').length, 1, 'once');
    // The player picks a model: the notice ends.
    await env.backend.setConfig({ model: 'claude-haiku-4-5' });
    assert.equal(env.backend.status().notice, null);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('the model check: a list that can\'t be read keeps the model; a model with no replacement is kept with a retired notice and no line in game', async () => {
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const dead = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(r => closed.close(r));
  const a = await started({ url: dead, keystore: await canaryKeystore(), config: { model: 'claude-sonnet-5' }, checks: { models: true } });
  try {
    await waitFor(() => a.backend.status().modelCheck, 3000, 'the check');
    assert.deepEqual({ ...a.backend.status().modelCheck, at: undefined }, { ok: false, errorKind: 'network_before_send', code: 'ECONNREFUSED', at: undefined });
    assert.equal(a.backend.status().provider.model, 'claude-sonnet-5', 'kept');
    assert.equal(a.backend.status().notice, null);
  } finally { await a.backend.stop(); }

  // A saved Claude Haiku 4.5 (the 1.0.x default): nothing cheaper listed, so it's kept with a notice.
  const mock = await anthropicWith(['claude-sonnet-5']);
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), config: { model: 'claude-haiku-4-5' }, checks: { models: true } });
  try {
    await waitFor(() => b.backend.status().notice, 3000, 'the notice');
    assert.equal(b.backend.status().notice.kind, 'model_retired');
    assert.equal(b.backend.status().notice.model, 'claude-haiku-4-5');
    assert.equal(b.backend.status().provider.model, 'claude-haiku-4-5', 'never up to a dearer model');
    await b.backend.send(sendParams(CHAT, 'm_3', 'hi'));
    await waitFor(() => b.chats('final').length === 1, 5000, 'it still answers (the list may be short)');
    assert.equal(b.chats('error').length, 0);
  } finally { await b.backend.stop(); await mock.close(); }

  // The default, Claude Sonnet 5.5, on a key its list doesn't show yet: the nearest no dearer (Sonnet 5,
  // the same price), never Opus 5.5 or Fable 5.1 (fix-102).
  const older = await anthropicWith(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  const c = await started({ url: older.url, keystore: await canaryKeystore(), checks: { models: true } });
  try {
    await waitFor(() => c.backend.status().notice, 3000, 'the notice');
    assert.deepEqual({ ...c.backend.status().notice, at: undefined }, { kind: 'model_switched', from: 'claude-sonnet-5-5', to: 'claude-sonnet-5', at: undefined });
    assert.equal(c.backend.status().provider.model, 'claude-sonnet-5');
  } finally { await c.backend.stop(); await older.close(); }
});

test('the model check runs again on a model or key change, and a model_not_found mid-session switches with the §10 line', async () => {
  let list = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];
  const mock = await startMock((r) => {
    if (r.method === 'GET' && r.url.startsWith('/v1/models')) return json({ data: list.map(id => ({ id })), has_more: false });
    if (r.method === 'POST' && r.body?.model === 'claude-sonnet-5' && !list.includes('claude-sonnet-5')) return fixture('anthropic', 'http-404-not-found.json');
    if (r.method === 'POST') return reply('Fine.\n\nTL;DR: fine.');
    return null;
  });
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), config: { model: 'claude-sonnet-5' }, checks: { models: true } });
  try {
    await waitFor(() => env.backend.status().modelCheck, 3000, 'the first check');
    assert.equal(env.backend.status().notice, null);
    const before = gets(mock, /\/v1\/models/).length;
    await env.backend.refresh({ keyChanged: true });
    await waitFor(() => gets(mock, /\/v1\/models/).length === before + 1, 3000, 'checked again for the new key');
    await sleep(30);
    // Gone while the bridge runs: the turn fails, the list is read, the line says what it's now on.
    list = ['claude-haiku-4-5-20251001'];
    await env.backend.send(sendParams(CHAT, 'm_4', 'hi'));
    const e = await waitFor(() => env.chats('error')[0], 5000, 'the line');
    assert.equal(e.errorKind, 'model_not_found');
    assert.equal(e.errorMessage, "Claude Sonnet 5 isn't available on your Anthropic account. Switched to Claude Haiku 4.5 for now. Change it in the NeverQuestAlone app.");
    assert.equal(e.runId, 'nqa:3fa9c2d1:m_4', 'the turn\'s own error, not a separate notice');
    assert.equal(env.backend.status().provider.model, 'claude-haiku-4-5');
    await env.backend.send(sendParams(CHAT, 'm_5', 'again'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'the next goes to the new model');
    assert.equal(env.chats('error').length, 1, 'no second notice');
    assert.equal(chatCalls(mock).at(-1).body.model, 'claude-haiku-4-5');
  } finally { await env.backend.stop(); await mock.close(); }
});

// ------------------------------------------------------------------------------- the ChatGPT plan

test('the ChatGPT plan: each chat\'s turns name one session (session_id, prompt_cache_key), another chat another; the key names neither the chat nor the install', async () => {
  const sse = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'fixtures', 'byok', 'providers', 'openai', 'success.sse'), 'utf8');
  const mock = await startMock(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }));
  const signIns = { for: m => (m?.auth?.signIn ? { credentials: async () => ({ key: 'eyJ.test.token', kind: 'oauth', headers: { 'chatgpt-account-id': 'acct-1' } }) } : null) };
  const env = await started({ url: mock.url, manifests: manifestsAt(mock.url, ['chatgpt']), keystore: await canaryKeystore([]), config: { provider: 'chatgpt', auth: 'oauth' }, signIns });
  try {
    await env.backend.send(sendParams(CHAT, 'p_1', 'one'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'first');
    await env.backend.send(sendParams(CHAT, 'p_2', 'two'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'second');
    await env.backend.send(sendParams(CHAT2, 'p_3', 'three'));
    await waitFor(() => env.chats('final').length === 3, 5000, 'third');
    const calls = chatCalls(mock);
    assert.equal(calls.length, 3);
    const keys = calls.map(r => r.body.prompt_cache_key);
    assert.match(keys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(keys[0], keys[1], 'one chat, one key');
    assert.notEqual(keys[0], keys[2], 'another chat, another key');
    for (const r of calls) {
      assert.equal(r.headers.session_id, r.body.prompt_cache_key, 'the header and the body agree');
      assert.equal(r.headers['chatgpt-account-id'], 'acct-1');
      assert.equal(r.headers.authorization, 'Bearer eyJ.test.token');
    }
    const sid = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'byok-chats.json'), 'utf8')).safetyId;
    for (const k of keys) for (const leak of [CHAT, CHAT2, sid, sid.replace(/-/g, '')]) assert.ok(!k.includes(leak), 'a hash, not the ids');
    assert.equal(calls[0].body.safety_identifier, undefined, 'the plan gets no safety identifier');
  } finally { await env.backend.stop(); await mock.close(); }
});
