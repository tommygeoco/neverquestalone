// The local backend (bridge/byok/backend.mjs; public BYOK PRD §5.3, §6.4, §6.5, §7.5, §9.4, §10):
// every call the core makes (send, abort, forget, setChatModel, outcomes), the ledger's idempotency, the rows' shape,
// retries, KY-10 and a restart mid-run, against the providers' mock server on 127.0.0.1 with
// canary keys. No real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startMock, reply, errorReply, makeBackend, canaryKeystore, sendParams, waitFor, sleep, tmpDir, CANARY_KEYS, manifestsAt, flatPrices,
} from './helpers/byok-env.mjs';
import { KEY_REFUSED, SLOT_CAPS, actionOf, settingsOf, roomForRetry, splitThink, PACE_SHARE, LAST_REQUESTS, createLocalBackend } from '../../bridge/byok/backend.mjs';
import { getManifest, customManifest } from '../../bridge/byok/providers/index.mjs';
import { loadPack } from '../../bridge/byok/runtime/pack.mjs';
import { readDataBlock } from '../../bridge/byok/runtime/context.mjs';
import { effectivePrice } from '../../bridge/byok/usage/prices.mjs';

const CHAT = 'c3f9a1e';
const CHAT2 = 'c4b2d0f';
const CTX = 'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)\nCharacter: Tavi on Testrealm, level 6 Tauren Warrior (Horde)\nLocation: Mulgore - Red Cloud Mesa';
const chatCalls = mock => mock.requests.filter(r => r.method === 'POST' && r.url.endsWith('/messages'));
// The words a turn's request ends with (the player's, after the data block).
const lastWords = r => String(r.body?.messages?.at(-1)?.content ?? '').split('\n').at(-1);

async function started(opts) {
  const env = makeBackend(opts);
  await env.backend.start();
  return env;
}

test('backend: start says ready, then onReady once; the persona is the app\'s (NeverQuestAlone by default); the gateway\'s RPC is gone (code health BR-22)', async () => {
  const keystore = await canaryKeystore();
  const env = await started({ keystore, config: { persona: { name: 'Mortimer' } } });
  try {
    assert.deepEqual(env.states.map(s => s.state), ['ready']);
    assert.equal(env.readies.length, 1);
    assert.equal(env.backend.persona, 'Mortimer');
    // The core calls these by chat id; nothing answers the deleted gateway's methods any more.
    for (const m of ['send', 'abort', 'forget', 'setChatModel', 'outcomes']) assert.equal(typeof env.backend[m], 'function', m);
    assert.equal(env.backend.request, undefined, 'no request(method, params)');
    assert.equal(env.backend.kind, 'byok');
    assert.equal(env.backend.displayName, 'Anthropic');
    // The default persona is NeverQuestAlone.
    const d = await started({ keystore });
    assert.equal(d.backend.persona, 'NeverQuestAlone');
    await d.backend.stop();
  } finally { await env.backend.stop(); }
});

test('backend: no key is no_key (never key_invalid); a key set later and refresh() make it ready; Other needs none (a server here, or a service that takes none)', async () => {
  const keystore = await canaryKeystore([]);
  const env = await started({ keystore });
  try {
    assert.deepEqual(env.states.map(s => [s.state, s.reason]), [['no_key', 'no key']]);
    assert.equal(env.readies.length, 1, 'ready all the same: the core asks what became of its runs and sends nothing');
    assert.equal(env.backend.slotExtras().rt.state, 'no_key');
    assert.equal(env.backend.slotExtras().bridge.provider.keyState, 'missing');
    await keystore.set('anthropic', CANARY_KEYS.anthropic);
    await env.backend.refresh({ keyChanged: true });
    assert.deepEqual(env.states.map(s => s.state), ['no_key', 'ready']);
    env.backend.pause(true);
    assert.equal(env.states.at(-1).state, 'paused');
    env.backend.pause(false);
    assert.equal(env.states.at(-1).state, 'ready');
    const local = await started({ config: { provider: 'custom', model: 'qwen3:8b', custom: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' } } });
    assert.deepEqual(local.states.map(s => s.state), ['ready']);
    assert.equal(local.backend.slotExtras().bridge.provider.auth, 'local');
    assert.equal(local.backend.slotExtras().bridge.provider.name, '127.0.0.1:11434', 'Other is named by its service\'s host');
    await local.backend.stop();
    const remote = await started({ keystore: await canaryKeystore([]), config: { provider: 'custom', model: 'llama-3.3-70b-versatile', custom: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' } } });
    assert.deepEqual(remote.states.map(s => s.state), ['ready'], 'Other with no key: the service decides (a 401 is auth_invalid)');
    assert.equal(remote.backend.slotExtras().bridge.provider.keyState, 'ok');
    await remote.backend.stop();
    const unset = await started({ config: { provider: 'custom' } });
    assert.deepEqual(unset.states.map(s => [s.state, s.reason]), [['no_key', 'unknown provider']], 'Other before its service is set is no AI yet');
    await unset.backend.stop();
  } finally { await env.backend.stop(); }
});

test('backend: send answers started at once, by chat id, and runs; the final carries the chat id, the message with __nqa {id, seq} and usage; lifecycle start and end', async () => {
  const mock = await startMock(() => reply('Mulgore, near Red Cloud Mesa.\n\nTL;DR: Mulgore.', { input: 1500, output: 60 }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const res = await env.backend.send(sendParams(CHAT, 'a3f1_1', 'what zone am I in?', { contextLines: CTX }));
    assert.deepEqual(res, { runId: 'nqa:3fa9c2d1:a3f1_1', status: 'started' });
    assert.equal(env.events.length, 0, 'nothing of the run before send has answered');
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'final');
    assert.equal(fin.chatId, CHAT);
    assert.equal(fin.sessionKey, undefined, 'no session keys (code health BR-22)');
    assert.equal(fin.runId, res.runId);
    assert.deepEqual(fin.message.content, [{ type: 'text', text: 'Mulgore, near Red Cloud Mesa.\n\nTL;DR: Mulgore.' }]);
    assert.equal(fin.message.role, 'assistant');
    assert.match(fin.message.__nqa.id, /^byok:c3f9a1e:\d+$/);
    assert.ok(Number.isInteger(fin.message.__nqa.seq));
    assert.equal(fin.usage.in, 1500);
    assert.equal(fin.usage.out, 60);
    assert.equal(fin.usage.model, 'claude-sonnet-5-5', 'Claude\'s default (fix-102)');
    assert.equal(fin.usage.exact, false, 'Anthropic costs are estimates from the price table');
    assert.equal(fin.usage.micros, 1500 * 2 + 60 * 10, 'Sonnet 5.5: $2 in, $10 out per 1M');
    const life = env.events.filter(e => e.event === 'agent' && e.payload.stream === 'lifecycle').map(e => e.payload.data.phase);
    assert.deepEqual(life, ['start', 'end']);
    assert.equal(env.backend.ledger.get(res.runId).state, 'done');
    assert.equal(chatCalls(mock).length, 1);
    // The key went only in its header, to the mock (the provider's host).
    assert.equal(chatCalls(mock)[0].headers['x-api-key'], CANARY_KEYS.anthropic);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: idempotency through the ledger: the same key while running is in_flight, once done is ok, and never a second provider call', async () => {
  const mock = await startMock(() => reply('Slow answer.\n\nTL;DR: slow.', { delayMs: 800 }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const p = sendParams(CHAT, 'a3f1_2', 'take your time');
    assert.equal((await env.backend.send(p)).status, 'started');
    await waitFor(() => chatCalls(mock).length === 1, 3000, 'the call');
    assert.deepEqual(await env.backend.send(p), { runId: p.idem, status: 'in_flight' });
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    assert.deepEqual(await env.backend.send(p), { runId: p.idem, status: 'ok' });
    await sleep(100);
    assert.equal(chatCalls(mock).length, 1, 'one provider call for one key');
    assert.equal(env.chats('final').length, 1);
    // A failed key answers its state and is never resent either.
    const r = sendParams(CHAT, 'a3f1_3', `here: ${CANARY_KEYS.anthropic}`);
    await env.backend.send(r);
    await waitFor(() => env.chats('error').length === 1, 2000, 'refusal');
    assert.equal((await env.backend.send(r)).status, 'failed');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: outcomes() answers from the ledger and the transcripts (code health BR-22): done with the reply as its final carried it and its cost, running while queued or going, unknown for a key it never had; the rows rise and survive a restart', async () => {
  let n = 0;
  const mock = await startMock(() => reply(`Answer ${++n}.\n\nTL;DR: ${n}.`, { delayMs: n >= 2 ? 800 : 0 }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const p1 = sendParams(CHAT, 'a3f1_4', 'first question');
    env.backend.send(p1);
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'first final');
    const [o1] = env.backend.outcomes([p1.idem]);
    assert.deepEqual(o1, { runId: p1.idem, chatId: CHAT, state: 'done', message: fin.message, usage: fin.usage }, 'the reply and its cost, as the final had them');
    // Its reply row names its turn and carries its cost, written with the reply.
    const rows = env.backend.transcripts.rows(CHAT, 10);
    assert.deepEqual(rows.map(r => r.role), ['user', 'assistant']);
    assert.equal(rows[0].text, 'first question');
    assert.deepEqual([rows[1].run, rows[1].usage, rows[1].t], [p1.idem, fin.usage, fin.message.__nqa.seq]);
    assert.equal(rows[0].run, undefined, 'the player\'s row names none');
    assert.equal(env.backend.ledger.get(p1.idem).extra.replyT, fin.message.__nqa.seq, 'and the ledger says where it is (the format addition)');
    // A slow second turn and a follow-up behind it: both running.
    const p2 = sendParams(CHAT, 'a3f1_5', 'second');
    const p3 = sendParams(CHAT, 'a3f1_6', 'third');
    env.backend.send(p2);
    env.backend.send(p3);
    await waitFor(() => chatCalls(mock).length === 2, 3000, 'second call');
    assert.deepEqual(env.backend.outcomes([p2.idem, p3.idem, 'nqa:3fa9c2d1:never']).map(o => o.state), ['running', 'running', 'unknown']);
    await waitFor(() => env.chats('final').length === 3, 5000, 'both finals');
    const all = env.backend.transcripts.rows(CHAT, 0);
    assert.deepEqual(all.map(r => r.text), ['first question', 'Answer 1.\n\nTL;DR: 1.', 'second', 'Answer 2.\n\nTL;DR: 2.', 'third', 'Answer 3.\n\nTL;DR: 3.']);
    const seqs = all.map(r => r.t);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    assert.equal(new Set(seqs).size, seqs.length, 'unique');
    // The follow-up's request carried the earlier exchanges as history.
    const third = chatCalls(mock)[2].body;
    assert.deepEqual(third.messages.slice(0, 4).map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(third.messages[0].content, 'first question');
    // A new backend on the same folder (a restart) answers the same, from the ledger and the transcript.
    const finals = env.chats('final');
    const again = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir: env.dataDir });
    assert.deepEqual(again.backend.outcomes([p1.idem, p2.idem, p3.idem]).map(o => [o.state, o.message, o.usage]), finals.map(f => ['done', f.message, f.usage]));
    assert.deepEqual(again.backend.outcomes(['', 42, 'x'.repeat(201)]), [], 'ids that can\'t be a turn\'s are left out');
    await again.backend.stop();
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: abort(chatId) stops the running run (aborted event, ledger failed, nothing in the transcript) and drops the queued one; nothing running answers aborted: false', async () => {
  const mock = await startMock(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, hangBeforeHeaders: true }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const p1 = sendParams(CHAT, 'a3f1_7', 'one');
    const p2 = sendParams(CHAT, 'a3f1_8', 'two');
    await env.backend.send(p1);
    await env.backend.send(p2);
    await waitFor(() => chatCalls(mock).length === 1, 3000, 'the first call');
    const res = env.backend.abort(CHAT);
    assert.deepEqual(res, { aborted: true });
    const ab = await waitFor(() => env.chats('aborted').length === 2 && env.chats('aborted'), 3000, 'two aborted events');
    assert.deepEqual(ab.map(x => x.runId).sort(), [p1.idem, p2.idem].sort());
    assert.ok(ab.every(x => x.stopReason === 'aborted' && x.chatId === CHAT));
    assert.equal(env.backend.ledger.get(p1.idem).state, 'failed');
    assert.equal(env.backend.ledger.get(p2.idem).state, 'failed');
    assert.deepEqual(env.backend.outcomes([p1.idem, p2.idem]).map(o => o.state), ['failed', 'failed'], 'over, with nothing more to say');
    assert.equal(chatCalls(mock).length, 1, 'the queued one never went out');
    assert.deepEqual(env.backend.transcripts.rows(CHAT, 10), []);
    assert.deepEqual(env.backend.abort(CHAT), { aborted: false });
    assert.deepEqual(env.backend.abort('old:session:c3f9a1e'), { aborted: false }, 'a chat id only');
    // The aborted run counts at its estimate (it may have been billed); the dropped one never went: nothing.
    assert.equal(env.backend.caps.details().typed, 1);
    assert.ok(env.backend.caps.details().spentMicros > 0);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: forget(chatId) forgets the chat\'s transcript, its own model and its last request, and stops its turns; a key-shaped or bad id is refused (code health BR-22)', async () => {
  const mock = await startMock(() => reply('Hi.\n\nTL;DR: hi.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const p = sendParams(CHAT, 'a3f1_9', 'hello');
    env.backend.send(p);
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    assert.deepEqual(env.backend.setChatModel(CHAT, 'claude-haiku-4-5'), { ok: true, model: 'claude-haiku-4-5' });
    assert.ok(env.backend.lastRequest(CHAT));
    assert.ok(fs.existsSync(path.join(env.dataDir, 'transcripts', `${CHAT}.jsonl`)));
    assert.deepEqual(env.backend.forget(CHAT), { ok: true });
    assert.ok(!fs.existsSync(path.join(env.dataDir, 'transcripts', `${CHAT}.jsonl`)), 'transcript deleted');
    assert.equal(env.backend.chatSlot(CHAT).model, undefined, 'its own model gone');
    assert.equal(env.backend.lastRequest(CHAT), null, 'and its last request');
    const side = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'byok-chats.json'), 'utf8'));
    assert.deepEqual(Object.keys(side.chats), [], 'nothing of it beside the transcripts');
    assert.equal(typeof side.safetyId, 'string', 'the install\'s safety id stays');
    assert.throws(() => env.backend.forget('old:session:c3f9a1e'), /INVALID_REQUEST/);
    assert.throws(() => env.backend.forget(`sk-ant-api03-${'x'.repeat(40)}`), /INVALID_REQUEST/);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: the run queue: one run per chat in arrival order, at most 2 chats at once', async () => {
  let open = 0;
  let most = 0;
  const order = [];
  const mock = await startMock(async (rec) => {
    open += 1; most = Math.max(most, open);
    order.push(rec.body.messages.at(-1).content.split('\n').at(-1));
    await sleep(150);
    open -= 1;
    return reply('ok.\n\nTL;DR: ok.');
  });
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), config: { history: { budget: 0 } } });
  try {
    const chats = ['c000001', 'c000002', 'c000003'];
    let k = 0;
    for (const c of chats) for (const w of ['a', 'b']) await env.backend.send(sendParams(c, `q_${++k}`, `${c}-${w}`));
    await waitFor(() => env.chats('final').length === 6, 8000, 'six finals');
    assert.equal(most, 2, 'two at once, never three');
    for (const c of chats) assert.ok(order.indexOf(`${c}-a`) < order.indexOf(`${c}-b`), `${c} in order`);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend (KA-02 follow-up a, code health): a transcript row kept before replies were redacted, whose key redaction can\'t take (a no-break space where its dash was), is left out of the history with its turn\'s other row; a redactable one goes without its key', async () => {
  const mock = await startMock(() => reply('Fine.\n\nTL;DR: fine.'));
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), log: (kind, data) => lines.push({ kind, ...data }) });
  try {
    const spliced = `sk-ant-api03\u{a0}${CANARY_KEYS.anthropic.slice('sk-ant-api03-'.length)}`;
    const dir = path.join(env.dataDir, 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const t = Date.now() - 60_000;
    fs.writeFileSync(path.join(dir, `${CHAT}.jsonl`), [
      { t, role: 'user', text: `is this right? ${spliced}` }, { t: t + 1, role: 'assistant', text: 'Never paste a key here.\n\nTL;DR: rotate it.' },
      { t: t + 2, role: 'user', text: 'where do I train?' }, { t: t + 3, role: 'assistant', text: `Thunder Bluff. Not with ${CANARY_KEYS.xai} though.\n\nTL;DR: Thunder Bluff.` },
    ].map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    await env.backend.send(sendParams(CHAT, 'a3f1_33', 'and after that?', { contextLines: CTX }));
    const out = await waitFor(() => env.chats('final')[0] || env.chats('error')[0], 5000, 'an answer');
    assert.equal(out.state, 'final', 'the turn goes');
    const body = JSON.stringify(chatCalls(mock)[0].body);
    assert.ok(!body.includes('CANARY'), 'neither old row\'s key goes');
    assert.ok(!body.includes('Never paste a key here'), 'the unredactable row goes with its turn\'s other row');
    assert.ok(body.includes('Thunder Bluff. Not with <redacted> though.'), 'the other turn rides, its key taken out');
    const dropped = lines.find(l => l.kind === 'byok-key-dropped');
    assert.deepEqual([dropped?.where, dropped?.n], ['history', 2]);
    assert.ok(!JSON.stringify(lines).includes('CANARY'));
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend (KA-02, code health): a reply that quotes a key: the final, the reply\'s row and the player\'s row on disk hold none of it', async () => {
  const mock = await startMock(() => reply(`Here it is: ${CANARY_KEYS.anthropic}\n\nTL;DR: here.`));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    await env.backend.send(sendParams(CHAT, 'a3f1_34', `what about${CANARY_KEYS.openrouter.slice(0, 22)}?`));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
    assert.equal(fin.message.content[0].text, 'Here it is: <redacted>\n\nTL;DR: here.');
    const kept = fs.readFileSync(path.join(env.dataDir, 'transcripts', `${CHAT}.jsonl`), 'utf8');
    assert.ok(!kept.includes('CANARY'), kept);
    assert.match(kept, /what about<redacted>\?/, 'the fragment KY-10 let through in the player\'s own row');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend (KY-10): a key-shaped message is refused with a fixed line: no provider call, nothing in the transcript or the ledger\'s metadata', async () => {
  const mock = await startMock(() => reply('never'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const p = sendParams(CHAT, 'a3f1_10', `my key is ${CANARY_KEYS.openai} ok?`);
    assert.equal((await env.backend.send(p)).status, 'started');
    const err = await waitFor(() => env.chats('error')[0], 2000, 'the refusal');
    assert.equal(err.errorKind, 'refused');
    assert.equal(err.errorMessage, KEY_REFUSED);
    assert.equal(err.action, 'none');
    assert.equal(chatCalls(mock).length, 0);
    assert.ok(!fs.existsSync(path.join(env.dataDir, 'transcripts', `${CHAT}.jsonl`)));
    for (const f of fs.readdirSync(env.dataDir).filter(f => f.endsWith('.json'))) {
      assert.ok(!fs.readFileSync(path.join(env.dataDir, f), 'utf8').includes('CANARY'), `${f} holds no key`);
    }
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend (KY-10): a key with an invisible character inside is refused too: that character is stripped on the way to the provider (final review L5-2)', async () => {
  const mock = await startMock(() => reply('never'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const key = CANARY_KEYS.anthropic;
    let n = 20;
    for (const ch of ['\u200b', '\u00ad', '\u2060', '\ufeff', '\u200d']) {
      for (const at of [3, 7]) {
        const hidden = key.slice(0, at) + ch + key.slice(at);
        await env.backend.send(sendParams(CHAT, `a3f1_${++n}`, `here: ${hidden}`));
      }
    }
    await waitFor(() => env.chats('error').length === 10, 2000, 'ten refusals');
    assert.ok(env.chats('error').every(e => e.errorKind === 'refused' && e.errorMessage === KEY_REFUSED));
    assert.equal(chatCalls(mock).length, 0, 'no provider call');
    assert.ok(!fs.existsSync(path.join(env.dataDir, 'transcripts', `${CHAT}.jsonl`)), 'nothing in the transcript');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: the request: the pack as the cached prefix, the game data block from the context and the state, effort from the think level through the effort map', async () => {
  const mock = await startMock(() => reply('Fine.\n\nTL;DR: fine.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), config: { persona: { name: 'Mortimer' } } });
  try {
    const state = { v: 1, sid: 'aaaabbbbccccdddd', seq: 3, t: 1790000000, char: { name: 'Tavi', realm: 'Testrealm', level: 6 }, quests: [{ id: 747, title: 'The Hunt\u0007 Begins|r' }] };
    await env.backend.send(sendParams(CHAT, 'a3f1_11', 'where next?', { contextLines: CTX, state }));
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    const body = chatCalls(mock)[0].body;
    const pack = loadPack({ persona: { name: 'Mortimer' } });
    assert.equal(body.system[0].text, pack.text, 'the prompt pack, with the persona\'s name');
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    // Claude Sonnet 5.5 at the default Low (fix-102): the reply's 1,200 and Low's thinking room.
    assert.equal(body.max_tokens, 1200 + 2048);
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.thinking, undefined, 'adaptive thinking, the model\'s own');
    const last = body.messages.at(-1);
    assert.equal(last.role, 'user');
    const block = readDataBlock(last.content);
    assert.ok(block, 'a labeled data block first');
    assert.equal(block.data.source, 'game');
    assert.deepEqual(block.data.game.context.slice(0, 2), ['Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)', 'Character: your character on your realm, level 6 Tauren Warrior (Horde)']);
    assert.equal(block.data.game.state.quests[0].title, 'The Hunt Begins', 'state strings sanitized (RT-11)');
    assert.ok(last.content.endsWith('\n\nwhere next?'));
    assert.ok(!JSON.stringify(body).includes('Tavi'), 'the character\'s own name stays home (§13.1)');
    // Sonnet 5 has an effort control: the chat's think level reaches the wire as the manifest maps it.
    await env.backend.setConfig({ model: 'claude-sonnet-5' });
    await env.backend.send(sendParams(CHAT, 'a3f1_12', 'think hard', { thinking: 'high' }));
    await waitFor(() => env.chats('final').length === 2, 5000, 'second final');
    assert.deepEqual(chatCalls(mock)[1].body.output_config, { effort: 'high' });
    assert.equal(chatCalls(mock)[1].body.max_tokens, 1200 + 8192, 'High\'s room');
    assert.equal(env.backend.slotExtras().bridge.provider.effortSupported, true);
    // Off on Sonnet 5: thinking disabled at effort low, and no room.
    await env.backend.send(sendParams(CHAT, 'a3f1_12b', 'quick one', { thinking: 'off' }));
    await waitFor(() => env.chats('final').length === 3, 5000, 'third final');
    assert.deepEqual([chatCalls(mock)[2].body.thinking, chatCalls(mock)[2].body.output_config, chatCalls(mock)[2].body.max_tokens], [{ type: 'disabled' }, { effort: 'low' }, 1200]);
    // A 1.0.x player's saved Haiku with no level stays as it was: no thinking, the reply alone.
    await env.backend.setConfig({ model: 'claude-haiku-4-5', effort: null });
    await env.backend.send(sendParams(CHAT, 'a3f1_12c', 'and now?'));
    await waitFor(() => env.chats('final').length === 4, 5000, 'fourth final');
    const haiku = chatCalls(mock)[3].body;
    assert.deepEqual([haiku.model, haiku.thinking, haiku.output_config, haiku.max_tokens], ['claude-haiku-4-5', undefined, undefined, 1200]);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: transient errors retry at most twice, honoring retry-after, with a "Trying again in N seconds" item; the last failure is the final line with Retry', async () => {
  let n = 0;
  const mock = await startMock(() => {
    n += 1;
    return n <= 2 ? errorReply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after-ms': '30' }) : reply('Made it.\n\nTL;DR: ok.');
  });
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), random: () => 0 });
  try {
    await env.backend.send(sendParams(CHAT, 'a3f1_13', 'hi'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'final after two retries');
    const items = env.events.filter(e => e.event === 'agent' && e.payload.stream === 'item').map(e => e.payload.data);
    assert.equal(items.length, 2);
    assert.ok(items.every(d => d.kind === 'tool' && d.phase === 'start' && /^Anthropic asked NeverQuestAlone to slow down\. Trying again in 1 second\.$/.test(d.title)), JSON.stringify(items));
    assert.equal(chatCalls(mock).length, 3);
  } finally { await env.backend.stop(); await mock.close(); }

  const busy = await startMock(() => errorReply(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after-ms': '10' }));
  const b = await started({ url: busy.url, keystore: await canaryKeystore(), random: () => 0 });
  try {
    await b.backend.send(sendParams(CHAT, 'a3f1_14', 'hi'));
    const err = await waitFor(() => b.chats('error')[0], 5000, 'error');
    assert.equal(err.errorKind, 'overloaded');
    assert.equal(err.errorMessage, 'Anthropic is busy right now. Still busy. Try again in a minute.');
    assert.equal(err.action, 'retry');
    assert.equal(chatCalls(busy).length, 3, 'the first try and two retries');
    assert.equal(b.backend.slotExtras().rt.state, 'provider_down');
  } finally { await b.backend.stop(); await busy.close(); }
});

test('backend: the first meeting (onboarding spec §9.3, §9.6): an intro turn carries intro and the client\'s locale in the game data; a greeting alone gets the 120-token reply cap, with the level\'s thinking room on top (fix-102); the pack says what to do with it', async () => {
  const mock = await startMock(() => reply('There you are!\n\nTL;DR: hi.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  const intro = (key, text, extra = {}) => { const p = sendParams(CHAT, key, text, { contextLines: CTX }); Object.assign(p.turn, { intro: true, loc: 'deDE' }, extra); return p; };
  try {
    await env.backend.send(intro('a3f1_31', 'hi'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    let body = chatCalls(mock).at(-1).body;
    let block = readDataBlock(body.messages.at(-1).content);
    assert.equal(block.data.game.intro, true);
    assert.equal(block.data.game.locale, 'deDE');
    assert.equal(body.max_tokens, 120 + 2048, 'Sonnet 5.5 at Low: a 120-token reply, and Low\'s room to think before it');
    assert.match(body.system[0].text, /\*\*First meeting\.\*\* When the game data has `"intro":true`/);
    // A question in the first message: the rule, not the cap.
    await env.backend.send(intro('a3f1_32', 'where do I train?'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'final 2');
    body = chatCalls(mock).at(-1).body;
    assert.equal(readDataBlock(body.messages.at(-1).content).data.game.intro, true);
    assert.equal(body.max_tokens, 1200 + 2048);
    // A locale that isn't one is left out; no intro, no marks.
    await env.backend.send(intro('a3f1_33', 'hi', { loc: 'de-DE"}' }));
    await waitFor(() => env.chats('final').length === 3, 5000, 'final 3');
    block = readDataBlock(chatCalls(mock).at(-1).body.messages.at(-1).content);
    assert.equal(block.data.game.locale, undefined);
    await env.backend.send(sendParams(CHAT, 'a3f1_34', 'hi', { contextLines: CTX }));
    await waitFor(() => env.chats('final').length === 4, 5000, 'final 4');
    body = chatCalls(mock).at(-1).body;
    block = readDataBlock(body.messages.at(-1).content);
    assert.equal(block.data.game.intro, undefined);
    assert.equal(body.max_tokens, 1200 + 2048);
    // Every model gets the 120 cap on its reply: its thinking has its own room, so it can't eat it.
    await env.backend.setConfig({ model: 'claude-sonnet-5', effort: 'high' });
    await env.backend.send(intro('a3f1_35', 'hi'));
    await waitFor(() => env.chats('final').length === 5, 5000, 'final 5');
    body = chatCalls(mock).at(-1).body;
    assert.equal(readDataBlock(body.messages.at(-1).content).data.game.intro, true);
    assert.equal(body.max_tokens, 120 + 8192);
    // A model with no level (a 1.0.x Haiku): the reply is all the output.
    await env.backend.setConfig({ model: 'claude-haiku-4-5', effort: null });
    await env.backend.send(intro('a3f1_36', 'hi'));
    await waitFor(() => env.chats('final').length === 6, 5000, 'final 6');
    body = chatCalls(mock).at(-1).body;
    assert.equal(body.max_tokens, 120);
    assert.equal(body.thinking, undefined);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: slotExtras keeps its caps when a part fails (a provider gone from the manifests): that part is left out and logged, so the slot still reads as the public build\'s', () => {
  const lines = [];
  const env = makeBackend({ config: { provider: 'gone-provider' }, log: (kind, data) => lines.push({ kind, ...data }) });
  const x = env.backend.slotExtras();
  assert.deepEqual(x.bridge.caps, [...SLOT_CAPS]);
  assert.equal(x.bridge.provider, undefined);
  assert.equal(x.bridge.usage, undefined);
  assert.equal(typeof x.rt.state, 'string');
  assert.deepEqual(lines.filter(l => l.kind === 'byok-slot-error').map(l => l.part), ['provider', 'usage']);
});

test('backend: slotExtras: the addon\'s caps, bridge.provider, bridge.usage (with needs) and rt', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.', { input: 100, output: 10 }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), config: { caps: { dailyUsd: 0.5 } } });
  try {
    const x = env.backend.slotExtras();
    assert.deepEqual(x.bridge.caps, [...SLOT_CAPS]);
    assert.deepEqual(x.bridge.caps, ['provider', 'usage', 'ekind', 'model']);
    // Claude's default, Sonnet 5.5, at Low; its levels for the in-game list (fix-102).
    assert.deepEqual(x.bridge.provider, {
      id: 'anthropic', name: 'Anthropic', model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', effort: 'low', effortSupported: true,
      models: [
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
        { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      ],
      efforts: 'off low medium high xhigh max',
      auth: 'key', keyState: 'ok', privacy: 'cloud-no-train', product: 'NeverQuestAlone', companion: 'NeverQuestAlone',
    });
    assert.equal(x.bridge.usage.capMicros, 500000, 'the cap the player set');
    assert.equal(x.bridge.usage.capTurns, undefined, 'no typed-message cap');
    assert.equal(x.bridge.usage.autoLeft, undefined, 'no automatic-turn cap');
    assert.equal(x.bridge.usage.spentMicros, 0);
    assert.equal(x.bridge.usage.needs, undefined);
    assert.deepEqual(x.rt, { state: 'ready', line: 'Ready', tone: 'ok', action: 'none' }, 'the state and its words (Batch 3b)');
    await env.backend.send(sendParams(CHAT, 'a3f1_15', 'hi'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    const y = env.backend.slotExtras();
    assert.equal(y.bridge.usage.spentMicros, 100 * 2 + 10 * 10, 'Sonnet 5.5: $2 in, $10 out per 1M');
    assert.equal(y.bridge.usage.turns, 1);
    assert.equal(y.bridge.usage.auto, 0);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(y.bridge.usage.day));
    // The player clears the cap: none in the slot (the public build has none of its own).
    await env.backend.setConfig({ caps: { dailyUsd: null } });
    const u = env.backend.slotExtras().bridge.usage;
    assert.deepEqual(Object.keys(u).filter(k => u[k] !== undefined).sort(), ['auto', 'day', 'exact', 'spentMicros', 'turns']);
    // A 1.0.x player's Haiku with no level: its levels are listed (it has thinking budgets now), none is set.
    await env.backend.setConfig({ model: 'claude-haiku-4-5', effort: null });
    const h = env.backend.slotExtras().bridge.provider;
    assert.deepEqual([h.model, h.effort, h.effortSupported, h.efforts], ['claude-haiku-4-5', undefined, true, 'off minimal low medium high xhigh max']);
    // A level the model hasn't: the one it runs, its nearest (Opus 5.5 always thinks: Off runs as Low).
    await env.backend.setConfig({ model: 'claude-opus-5-5', effort: 'off' });
    const o = env.backend.slotExtras().bridge.provider;
    assert.deepEqual([o.effort, o.efforts], ['low', 'low medium high xhigh max']);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: a stop mid-run leaves the turn for the next start: booked at its estimate once, before ready; outcomes() says interrupted with Send again, every time it\'s asked; never a second provider call (RT-8, B2.13, DB20)', async () => {
  const mock = await startMock(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, hangBeforeHeaders: true }));
  const dataDir = tmpDir();
  const a = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
  const p = sendParams(CHAT, 'a3f1_16', 'what now?');
  a.backend.send(p);
  const p2 = sendParams(CHAT, 'a3f1_17', 'and then?'); // queued behind it: never sent
  a.backend.send(p2);
  await waitFor(() => chatCalls(mock).length === 1, 3000, 'the call');
  await a.backend.stop(); // the process goes away mid-request
  assert.equal(a.chats().length, 0, 'nothing reported by the stopping backend');
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
  try {
    assert.equal(b.chats().length, 0, 'nothing emitted at start: the core asks (code health BR-22)');
    // A request out at the stop counts at its estimate, settled before ready (from the ledger): it may have been billed.
    const est = b.backend.ledger.get(p.idem).extra.estMicros;
    assert.ok(est > 0);
    assert.equal(b.backend.caps.details().spentMicros, est, 'the one that went, at its estimate; the queued one, nothing');
    const said = b.backend.outcomes([p.idem, p2.idem]);
    for (const [o, x] of [[said[0], p], [said[1], p2]]) {
      assert.deepEqual(o, { runId: x.idem, chatId: CHAT, state: 'interrupted', errorKind: 'interrupted',
        errorMessage: 'NeverQuestAlone restarted before NeverQuestAlone answered.', action: 'send_again' });
    }
    assert.deepEqual(b.backend.outcomes([p.idem, p2.idem]), said, 'the same each time: it changes nothing');
    assert.deepEqual(b.backend.send(p), { runId: p.idem, status: 'interrupted' }, 'the core\'s resend: not sent again');
    assert.deepEqual(b.backend.send(p2), { runId: p2.idem, status: 'failed' });
    await sleep(100);
    assert.equal(chatCalls(mock).length, 1, 'no second call');
    const c = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
    assert.equal(c.backend.caps.details().spentMicros, est, 'booked once');
    assert.deepEqual(c.backend.outcomes([p.idem]).map(o => o.state), ['interrupted']);
    await c.backend.stop();
  } finally { await b.backend.stop(); await mock.close(); }
});

// ---------------------------------------------------------------- code health BR-22: the core's calls and outcomes()

test('backend (code health BR-22 r3): send is synchronous, the turn on the run queue before it returns: an abort in the same tick drops it before anything is built or sent: no request, nothing booked, the ledger failed (aborted), one aborted event', async () => {
  const mock = await startMock(() => reply('Never said.\n\nTL;DR: never.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    const p = sendParams(CHAT, 'r3_1', 'stop me at once');
    const res = env.backend.send(p);
    assert.equal(typeof res?.then, 'undefined', 'a plain answer, never a promise: nothing is awaited before the run queue has the turn');
    assert.deepEqual(res, { runId: p.idem, status: 'started' });
    assert.equal(env.backend.ledger.get(p.idem).state, 'queued', 'begun in the ledger before send returned');
    assert.deepEqual(env.backend.abort(CHAT), { aborted: true }, 'the same tick\'s abort finds it');
    await waitFor(() => env.chats('aborted').length === 1, 3000, 'aborted');
    await sleep(100);
    assert.equal(chatCalls(mock).length, 0, 'nothing went to the AI');
    assert.deepEqual([env.backend.ledger.get(p.idem).state, env.backend.ledger.get(p.idem).extra.reason], ['failed', 'aborted']);
    assert.equal(env.backend.caps.details().spentMicros, 0, 'nothing booked');
    assert.equal(env.backend.caps.details().typed, 0, 'no turn counted');
    assert.deepEqual(env.chats().map(c => c.state), ['aborted'], 'one aborted event, nothing else');
    assert.deepEqual(env.backend.outcomes([p.idem]), [{ runId: p.idem, chatId: CHAT, state: 'failed' }]);
    assert.throws(() => env.backend.send({ ...p, chatId: 'old:session:c3f9a1e', idem: 'nqa:3fa9c2d1:r3_2' }), /INVALID_REQUEST/, 'a chat id only');
    assert.throws(() => env.backend.send({ ...p, idem: '' }), /INVALID_REQUEST/, 'a key is required');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend (code health BR-22 r1): the ledger\'s done says where the reply is (replyT) and what it cost, so a restart finds it; a done entry an older build wrote (no replyT) whose rows name no run answers done with no message: that one reply isn\'t found', async () => {
  const mock = await startMock(() => reply('Kept.\n\nTL;DR: kept.', { input: 900, output: 30 }));
  const dataDir = tmpDir();
  const a = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir });
  const p = sendParams(CHAT, 'r1_1', 'remember me');
  a.backend.send(p);
  const fin = await waitFor(() => a.chats('final')[0], 5000, 'final');
  const led = a.backend.ledger.get(p.idem);
  assert.deepEqual([led.state, led.extra.replyT, led.extra.inTokens, led.extra.outTokens, led.extra.exact, led.extra.outMicros],
    ['done', fin.message.__nqa.seq, 900, 30, false, fin.usage.micros], 'the format addition: where, and what it cost');
  await a.backend.stop();
  // A restart finds it from the ledger: the core missed this final (a crash between the backend's done and its publish).
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir });
  assert.deepEqual(b.backend.outcomes([p.idem]), [{ runId: p.idem, chatId: CHAT, state: 'done', message: fin.message, usage: fin.usage }]);
  await b.backend.stop();
  // As an older build left them: no replyT or cost in the ledger's done, no run or cost on the reply's row.
  const lf = path.join(dataDir, 'ledger.json');
  const raw = JSON.parse(fs.readFileSync(lf, 'utf8'));
  for (const k of ['replyT', 'inTokens', 'outTokens', 'exact']) delete raw.entries[p.idem].extra[k];
  fs.writeFileSync(lf, JSON.stringify(raw));
  const tf = path.join(dataDir, 'transcripts', `${CHAT}.jsonl`);
  fs.writeFileSync(tf, fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); delete r.run; delete r.usage; return JSON.stringify(r); }).join('\n') + '\n');
  const c = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir });
  try {
    assert.deepEqual(c.backend.outcomes([p.idem]), [{ runId: p.idem, chatId: CHAT, state: 'done' }], 'over, with no reply to give: the documented gap');
    assert.equal(c.backend.transcripts.rows(CHAT, 10).at(-1).text, 'Kept.\n\nTL;DR: kept.', 'the reply stays in the transcript');
  } finally { await c.backend.stop(); await mock.close(); }
});

test('backend (code health BR-22): a crash after the reply\'s rows were written, before the ledger\'s done: the next start books nothing more (it was booked with the reply), and outcomes() answers done with the reply and its cost from its row', async () => {
  const mock = await startMock(() => reply('Written.\n\nTL;DR: written.', { input: 800, output: 20 }));
  const dataDir = tmpDir();
  const a = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
  const p = sendParams(CHAT, 'w_1', 'write it down');
  a.backend.send(p);
  const fin = await waitFor(() => a.chats('final')[0], 5000, 'final');
  const spent = a.backend.caps.details().spentMicros;
  assert.ok(spent > 0);
  await a.backend.stop();
  // The ledger as that crash leaves it: still 'sending', with the request's estimate.
  const lf = path.join(dataDir, 'ledger.json');
  const raw = JSON.parse(fs.readFileSync(lf, 'utf8'));
  const e = raw.entries[p.idem];
  e.state = 'sending';
  for (const k of ['replyT', 'inTokens', 'outTokens', 'exact', 'outMicros', 'requestId']) delete e.extra[k];
  assert.ok(e.extra.estMicros > spent, 'its estimate is more than the reply cost: booking it again would show');
  fs.writeFileSync(lf, JSON.stringify(raw));
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
  try {
    assert.equal(b.backend.caps.details().spentMicros, spent, 'booked once: with the reply, not again at its estimate');
    assert.deepEqual(b.backend.outcomes([p.idem]), [{ runId: p.idem, chatId: CHAT, state: 'done', message: fin.message, usage: fin.usage }], 'found by the run its row names');
    assert.equal(b.chats().length, 0, 'nothing said at the start itself');
    assert.equal(chatCalls(mock).length, 1, 'never sent again');
  } finally { await b.backend.stop(); await mock.close(); }
});

test('backend (code health BR-22): a ledger that can\'t be read (kept aside): a run the core names with its chat is still found by the reply row naming it; with no reply, unknown; a reply is looked for past the last 40 rows only when they all came after the turn began', async () => {
  const mock = await startMock(r => reply(`Reply to ${lastWords(r)}.`));
  const dataDir = tmpDir();
  const a = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir });
  const p = sendParams(CHAT, 'l_1', 'the one that counts');
  a.backend.send(p);
  const fin = await waitFor(() => a.chats('final')[0], 5000, 'final');
  // 25 more turns: its row is 50 back.
  for (let i = 0; i < 25; i++) a.backend.send(sendParams(CHAT, `l_more${i}`, `more ${i}`));
  await waitFor(() => a.chats('final').length === 26, 15000, 'the rest');
  assert.deepEqual(a.backend.outcomes([p.idem]), [{ runId: p.idem, chatId: CHAT, state: 'done', message: fin.message, usage: fin.usage }], 'found by replyT, past the last 40 rows');
  await a.backend.stop();
  fs.writeFileSync(path.join(dataDir, 'ledger.json'), 'not json');
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir });
  try {
    assert.deepEqual(b.backend.outcomes([p.idem], { [p.idem]: CHAT }), [{ runId: p.idem, chatId: CHAT, state: 'done', message: fin.message, usage: fin.usage }], 'by the row that names its run');
    assert.deepEqual(b.backend.outcomes([p.idem]), [{ runId: p.idem, state: 'unknown' }], 'no chat to look in');
    assert.deepEqual(b.backend.outcomes(['nqa:3fa9c2d1:never'], { 'nqa:3fa9c2d1:never': CHAT }), [{ runId: 'nqa:3fa9c2d1:never', state: 'unknown' }]);
    assert.deepEqual(b.backend.outcomes([p.idem], { [p.idem]: 'old:session:c3f9a1e' }), [{ runId: p.idem, state: 'unknown' }], 'a chat id only');
  } finally { await b.backend.stop(); await mock.close(); }
});

test('backend (code health BR-22): a core handler that throws never ends a turn: the backend logs it, the turn is done in the ledger, and outcomes() has the reply the core never saw', async () => {
  const mock = await startMock(() => reply('Through.\n\nTL;DR: through.'));
  const lines = [];
  const events = [];
  const backend = createLocalBackend({
    onEvent: (e) => { events.push(e); if (e.event === 'chat') throw new Error('the core\'s handler broke'); },
  }, { config: { provider: 'anthropic' }, dataDir: tmpDir(), keystore: await canaryKeystore(), manifests: manifestsAt(mock.url), checks: { models: false },
    log: (kind, data) => lines.push({ kind, ...data }), providerOpts: { timeouts: { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 } } });
  await backend.start();
  try {
    const p = sendParams(CHAT, 'h_1', 'say it anyway');
    backend.send(p);
    await waitFor(() => backend.ledger.get(p.idem)?.state === 'done', 5000, 'done');
    await sleep(50);
    assert.ok(lines.some(l => l.kind === 'byok-handler-error'), 'logged');
    assert.deepEqual(events.filter(e => e.event === 'chat').map(e => e.payload.state), ['final'], 'one final, no error after it');
    const [o] = backend.outcomes([p.idem]);
    assert.deepEqual([o.state, o.message.content[0].text], ['done', 'Through.\n\nTL;DR: through.']);
  } finally { await backend.stop(); await mock.close(); }
});

test('backend: helpers: actions, settings', () => {
  assert.equal(actionOf({ id: 'retry', desktop: true }), 'retry');
  assert.equal(actionOf({ id: 'send_again' }), 'send_again');
  assert.equal(actionOf({ id: 'replace_key', desktop: true }), 'desktop');
  assert.equal(actionOf({ id: 'rephrase' }), 'none');
  const s = settingsOf({ byok: { provider: 'openai', effort: 'turbo', persona: { name: 'x' }, privacy: { identity: true } } });
  assert.equal(s.provider, 'openai');
  assert.equal(s.effort, 'low', 'an unknown effort is the default, low (DB22)');
  assert.equal(s.persona, 'NeverQuestAlone', 'an unusable persona name is the default');
  assert.equal(s.identity, true);
  assert.equal(settingsOf({}).historyBudget, 1500);
  assert.ok(manifestsAt('http://127.0.0.1:1').find(m => m.id === 'anthropic').baseUrl.startsWith('http://127.0.0.1:1/'));
});

test('backend: automatic turns are counted apart from typed ones and never capped; a recap turn runs the logbook and carries the recap', async () => {
  const mock = await startMock(() => reply('Noted.\n\nTL;DR: noted.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const doc = { v: 1, kind: 'session', sid: 'aaaabbbbccccdddd', ended: 'quit', char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN' },
      start: { t: 1790000000, level: 8, xp: 100, xpMax: 1400, money: 1000 }, end: { t: 1790003600, level: 9, xp: 50, xpMax: 1500, money: 2500 } };
    await env.backend.send(sendParams('c0ffee0', 'r_1', '', { kind: 'recap', state: doc }));
    await waitFor(() => env.chats('final').length === 1, 5000, 'the recap reply');
    const content = chatCalls(mock)[0].body.messages.at(-1).content;
    const block = readDataBlock(content);
    assert.equal(block.data.game.recap.kind, 'session');
    assert.equal(block.data.game.recap.end.level, 9);
    assert.ok(content.endsWith('\n\n[NeverQuestAlone event] Session recap. Sent by the app after the game closed, not typed by the player.'));
    const log = fs.readFileSync(path.join(env.dataDir, 'memory', 'Tavi-Testrealm', 'log.md'), 'utf8');
    assert.match(log, /nqa:m /, 'the session line, written by the logbook (RT-5)');
    // An event after the recap goes too (no automatic-turn cap), and a typed turn beside them.
    await env.backend.send(sendParams('c0ffee0', 'e_1', '', { kind: 'evt', event: { kind: 'route_done', args: {} } }));
    await waitFor(() => env.chats('final').length === 2, 5000, 'the event reply');
    await env.backend.send(sendParams(CHAT, 't_1', 'typed still works'));
    await waitFor(() => env.chats('final').length === 3, 5000, 'the typed reply');
    assert.equal(env.chats('error').length, 0);
    const u = env.backend.slotExtras().bridge.usage;
    assert.deepEqual([u.auto, u.turns, u.autoLeft], [2, 1, undefined], 'the recap and the event are automatic turns');
    assert.equal(chatCalls(mock).length, 3);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: other players\' names from game data go as "Player A" and come back real in the reply and the transcript; memory rides along as labeled data', async () => {
  const mock = await startMock(() => reply('Player A is a level 10 warrior. Group up with Player A.\n\nTL;DR: Player A can help.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    // Something the logbook wrote earlier for this character.
    const mem = path.join(env.dataDir, 'memory', 'Tavi-Testrealm');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'character.md'), '# Character\n\n## Facts (from the game)\n<!-- nqa:facts:start -->\n- Level 8 Tauren Shaman\n<!-- nqa:facts:end -->\n\nPlan: tank build for Tavi.\n');
    const ask = 'What do you know about my target: Bread (a player, level 10 Warrior)?';
    await env.backend.send(sendParams(CHAT, 'a3f1_20', ask, { contextLines: CTX }));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'final');
    const wire = chatCalls(mock)[0].body.messages.at(-1).content;
    assert.ok(wire.endsWith('What do you know about my target: Player A (a player, level 10 Warrior)?'), 'pseudonymized (RT-12)');
    assert.ok(!JSON.stringify(chatCalls(mock)[0].body).includes('Bread'));
    const block = readDataBlock(wire);
    assert.deepEqual(block.data.memory.character, ['Level 8 Tauren Shaman']);
    assert.deepEqual(block.data.memory.notes, ['Plan: tank build for your character.'], 'the character\'s name replaced in memory too');
    assert.equal(fin.message.content[0].text, 'Bread is a level 10 warrior. Group up with Bread.\n\nTL;DR: Bread can help.', 'unmasked for the player');
    const rows = env.backend.transcripts.rows(CHAT);
    assert.equal(rows[0].text, ask, 'the transcript keeps the real text');
    assert.deepEqual(rows[0].names, ['Bread']);
    assert.deepEqual(rows[1].names, ['Bread']);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend: Other at a server on this computer: game text is datamarked and the marks come out of the reply; the turn is free but counted', async () => {
  const chunk = (d, extra = {}) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'qwen3:8b', choices: [{ index: 0, delta: d, finish_reason: null }], ...extra })}\n\n`;
  const sse = chunk({ role: 'assistant', content: 'Headˆto ' }) + chunk({ content: 'Bloodhoofˆvillage.\n\nTL;DR: go.' })
    + `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6000, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`;
  const mock = await startMock(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }));
  const env = await started({ config: { provider: 'custom', model: 'qwen3:8b', custom: { baseUrl: `${mock.url}/v1`, model: 'qwen3:8b' } } });
  try {
    await env.backend.send(sendParams(CHAT, 'a3f1_21', 'where now?', { contextLines: CTX }));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'final');
    const sent = mock.requests.find(r => r.url === '/v1/chat/completions');
    const block = readDataBlock(sent.body.messages.at(-1).content);
    assert.equal(block.data.datamark, 'ˆ');
    assert.ok(block.data.game.context[2].startsWith('Location:ˆMulgore'), 'spaces in game text marked');
    assert.equal(sent.body.model, 'qwen3:8b');
    assert.equal(sent.headers.authorization, undefined, 'no key: no header');
    assert.equal(fin.message.content[0].text, 'Head to Bloodhoof village.\n\nTL;DR: go.');
    assert.deepEqual(fin.usage, { in: 6000, out: 20, micros: 0, model: 'qwen3:8b', exact: true });
    const u = env.backend.slotExtras().bridge.usage;
    assert.equal(u.turns, 1);
    assert.equal(u.spentMicros, 0);
    assert.equal(env.backend.slotExtras().bridge.provider.privacy, 'local');
    assert.equal(chatCalls(mock).length, 0, 'no Anthropic call');
    assert.equal(mock.requests.filter(r => r.url === '/v1/chat/completions').length, 1, 'one call (no repair pass: systems plan D6)');
  } finally { await env.backend.stop(); await mock.close(); }
});

// ---------------------------------------------------------------- a reply with no text (fix-empty-reply)
// A thinking model that spends the whole output ceiling thinking finishes on it ('length': Anthropic's
// max_tokens, OpenAI's incomplete max_output_tokens) with no text. The turn tries once more, at the
// model's lowest thinking level with the same reply ceiling; a reply that finished with nothing tries
// once more as it was. Empty again: its own line, never "Something went wrong". Both attempts count.
const sseOf = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
/** An Anthropic stream that only thinks, then stops at max_tokens (or ends its turn with nothing). */
function anthropicThinkingOnly({ input = 1500, output = 9392, stop = 'max_tokens' } = {}) {
  const body = sseOf('message_start', { message: { id: 'msg_01EMPTY', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null,
    usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } })
    + sseOf('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
    + sseOf('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'The player asks where to go. Let me weigh every quest in the log…' } })
    + sseOf('content_block_stop', { index: 0 })
    + sseOf('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } })
    + sseOf('message_stop', {});
  return { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_EMPTY' }, body };
}
/** A Responses stream (OpenAI) that only reasons, then is cut at max_output_tokens. */
function openaiReasoningOnly({ input = 1500, output = 9392 } = {}) {
  const usage = { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: output }, total_tokens: input + output };
  const body = sseOf('response.created', { sequence_number: 0, response: { id: 'resp_EMPTY', status: 'in_progress', model: 'gpt-6.1-sol' } })
    + sseOf('response.output_item.added', { sequence_number: 1, output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } })
    + sseOf('response.output_item.done', { sequence_number: 2, output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } })
    + sseOf('response.incomplete', { sequence_number: 3, response: { id: 'resp_EMPTY', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage } });
  return { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_EMPTY' }, body };
}
/** A Responses stream (OpenAI) with a reply. */
function openaiReply(text, { input = 1500, output = 60 } = {}) {
  const usage = { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output };
  const body = sseOf('response.created', { sequence_number: 0, response: { id: 'resp_OK', status: 'in_progress', model: 'gpt-6.1-sol' } })
    + sseOf('response.output_text.delta', { sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text })
    + sseOf('response.completed', { sequence_number: 2, response: { id: 'resp_OK', status: 'completed', usage } });
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body };
}
const responsesCalls = mock => mock.requests.filter(r => r.method === 'POST' && r.url.endsWith('/responses'));
// A flat price, with reasoning billed inside the output count as OpenAI bills it.
const insideOutput = (provider, model) => effectivePrice({ provider, model, input: 0.1, output: 0.5, reasoningInOutput: true });
const openaiEnv = (mock, extra = {}) => started({ url: mock.url, config: { provider: 'openai' }, keystore: null, manifests: manifestsAt(mock.url, ['openai']),
  priceBook: { priceFor: insideOutput, worstPriceFor: p => insideOutput(p, null) }, ...extra });
const NO_REPLY = "NeverQuestAlone couldn't finish a reply. Ask again, or lower Thinking.";

test('empty reply (Anthropic): thinking that used the whole ceiling (max_tokens, no text) is tried once more at the lowest level (Off on Sonnet 5.5), same reply ceiling; the reply goes through and both attempts count', async () => {
  let n = 0;
  const mock = await startMock(() => (++n === 1 ? anthropicThinkingOnly({ input: 1500, output: 9392 }) : reply('Head to Bloodhoof.\n\nTL;DR: Bloodhoof.', { input: 1500, output: 60 })));
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), log: (k, d) => lines.push([k, d]) });
  try {
    const p = sendParams(CHAT, 'e_1', 'where now?', { thinking: 'high' });
    await env.backend.send(p);
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
    assert.equal(fin.message.content[0].text, 'Head to Bloodhoof.\n\nTL;DR: Bloodhoof.');
    const [first, second] = chatCalls(mock).map(r => r.body);
    assert.equal(chatCalls(mock).length, 2, 'one more try, no third');
    assert.deepEqual([first.output_config, first.thinking, first.max_tokens], [{ effort: 'high' }, undefined, 1200 + 8192], 'High: the reply\'s 1,200 and High\'s thinking room');
    assert.deepEqual([second.output_config, second.thinking, second.max_tokens], [{ effort: 'low' }, { type: 'between_tools' }, 1200], 'Off (Sonnet 5.5\'s lowest): the same reply ceiling, no thinking room');
    assert.deepEqual(second.messages, first.messages, 'the same message, game data and history');
    assert.equal(env.chats('error').length, 0);
    assert.equal(env.events.filter(e => e.event === 'agent' && e.payload.data?.name === 'retry').length, 0, 'no "Trying again" line: it goes at once');
    assert.deepEqual([fin.usage.in, fin.usage.out], [3000, 9452], 'both attempts');
    assert.equal(fin.usage.micros, 3000 * 0.1 + 9452 * 0.5);
    const d = env.backend.caps.details();
    assert.deepEqual([d.spentMicros, d.typed], [3000 * 0.1 + 9452 * 0.5, 1], 'booked once, as one turn, at what both cost');
    assert.equal(env.backend.ledger.get(p.idem).state, 'done');
    const retry = lines.find(([k]) => k === 'byok-empty-retry')?.[1];
    assert.deepEqual([retry?.finish, retry?.effort, retry?.retryEffort], ['length', 'high', 'off']);
    assert.equal(lines.find(([k]) => k === 'byok-turn')?.[1].emptied, 'length');
    assert.equal(env.backend.status().lastError, null);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('empty reply (Anthropic): empty again after the one more try: its own kind and line (never the generic one), Retry, no third call; both attempts booked, the ledger failed', async () => {
  const mock = await startMock(() => anthropicThinkingOnly({ input: 1500, output: 2000 }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    const p = sendParams(CHAT, 'e_2', 'where now?', { thinking: 'medium' });
    await env.backend.send(p);
    const err = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.deepEqual([err.errorKind, err.errorMessage, err.action], ['empty_reply', NO_REPLY, 'retry']);
    assert.equal(err.requestId, 'req_EMPTY');
    assert.doesNotMatch(err.errorMessage, /Something went wrong/);
    await sleep(50);
    assert.equal(chatCalls(mock).length, 2, 'one more try only');
    assert.deepEqual(chatCalls(mock).map(r => r.body.max_tokens), [1200 + 4096, 1200]);
    assert.equal(env.chats('final').length, 0);
    const d = env.backend.caps.details();
    assert.deepEqual([d.spentMicros, d.typed], [2 * (1500 * 0.1 + 2000 * 0.5), 1], 'both attempts, one turn');
    const led = env.backend.ledger.get(p.idem);
    assert.equal(led.state, 'failed');
    assert.deepEqual([led.extra?.errorKind, led.extra?.code], ['empty_reply', 'length']);
    assert.deepEqual([env.backend.status().lastError.kind, env.backend.status().lastError.code], ['empty_reply', 'length']);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('empty reply (Anthropic): one that finished normally with no text (end_turn) is tried once more as it was: the same level and ceiling', async () => {
  let n = 0;
  const mock = await startMock(() => (++n === 1 ? reply('', { input: 1500, output: 3 }) : reply('Bloodhoof.\n\nTL;DR: Bloodhoof.', { input: 1500, output: 40 })));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    await env.backend.send(sendParams(CHAT, 'e_3', 'where now?', { thinking: 'high' }));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
    assert.equal(fin.message.content[0].text, 'Bloodhoof.\n\nTL;DR: Bloodhoof.');
    const [first, second] = chatCalls(mock).map(r => r.body);
    assert.equal(chatCalls(mock).length, 2);
    assert.deepEqual(second, first, 'the same request: not a ceiling problem');
    assert.deepEqual([fin.usage.in, fin.usage.out], [3000, 43]);
  } finally { await env.backend.stop(); await mock.close(); }

  // Empty twice: the same line, code stop.
  const twice = await startMock(() => reply('  ', { input: 1500, output: 4 }));
  const b = await started({ url: twice.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    await b.backend.send(sendParams(CHAT, 'e_4', 'where now?'));
    const err = await waitFor(() => b.chats('error')[0], 5000, 'the error');
    assert.deepEqual([err.errorKind, err.errorMessage, err.action], ['empty_reply', NO_REPLY, 'retry']);
    assert.equal(chatCalls(twice).length, 2);
    assert.equal(b.backend.status().lastError.code, 'stop');
    assert.equal(b.backend.caps.details().spentMicros, 2 * (1500 * 0.1 + 4 * 0.5));
  } finally { await b.backend.stop(); await twice.close(); }
});

test('empty reply (OpenAI): reasoning that used the whole ceiling (incomplete, max_output_tokens) is tried once more at the model\'s lowest level (Low on GPT-6.1 Sol); empty again, the same line', async () => {
  let n = 0;
  const mock = await startMock(() => (++n === 1 ? openaiReasoningOnly() : openaiReply('Head to Goldshire.\n\nTL;DR: Goldshire.')));
  const env = await openaiEnv(mock, { keystore: await canaryKeystore(['openai']) });
  try {
    await env.backend.send(sendParams(CHAT, 'e_5', 'where now?', { thinking: 'high' }));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
    assert.equal(fin.message.content[0].text, 'Head to Goldshire.\n\nTL;DR: Goldshire.');
    const [first, second] = responsesCalls(mock).map(r => r.body);
    assert.equal(responsesCalls(mock).length, 2);
    assert.deepEqual([first.reasoning?.effort, first.max_output_tokens], ['high', 1200 + 8192]);
    assert.deepEqual([second.reasoning?.effort, second.max_output_tokens], ['low', 1200 + 2048], 'its lowest level (it has no Off), the same reply ceiling');
    assert.deepEqual(second.input, first.input);
    assert.deepEqual([fin.usage.in, fin.usage.out], [3000, 9452], 'both attempts');
  } finally { await env.backend.stop(); await mock.close(); }

  let m = 0;
  const twice = await startMock(() => openaiReasoningOnly({ output: ++m === 1 ? 3248 : 7344 }));
  const b = await openaiEnv(twice, { keystore: await canaryKeystore(['openai']) });
  try {
    await b.backend.send(sendParams(CHAT, 'e_6', 'where now?'));
    const err = await waitFor(() => b.chats('error')[0], 5000, 'the error');
    assert.deepEqual([err.errorKind, err.errorMessage, err.action], ['empty_reply', NO_REPLY, 'retry']);
    await sleep(50);
    assert.equal(responsesCalls(twice).length, 2, 'one more try, then the line');
    assert.deepEqual(responsesCalls(twice).map(r => [r.body.reasoning?.effort, r.body.max_output_tokens]), [['low', 1200 + 2048], ['low', 1200 + 2048 + 4096]],
      'Low is its lowest: never the same request again, but Low with Medium\'s room more');
    assert.equal(b.backend.caps.details().spentMicros, (1500 * 0.1 + 3248 * 0.5) + (1500 * 0.1 + 7344 * 0.5));
  } finally { await b.backend.stop(); await twice.close(); }
});

// Other's model that thinks by default (qwen3, deepseek-r1, gpt-oss on Ollama or LM Studio): it reasons
// first, needs `need` tokens of it before its answer, and counts it inside max_tokens. With less room it
// ends on the ceiling with reasoning only; with more, the answer follows. `how`: where its reasoning goes
// (reasoning_content: DeepSeek, LM Studio's separate field; reasoning: Ollama, LM Studio for gpt-oss;
// think: in the text, <think>…</think>, as llama.cpp with --reasoning-format none and older LM Studio send
// it; usage: hidden, only counted in usage's reasoning_tokens). With reasoning_effort "none" (Ollama's no
// thinking) it answers at once. `show`: what /api/show answers (Ollama's thinking controls), or a 404 (null).
// `waitMs`, `writeMs`: real ms before its first chunk and between it and the end (a scaled clock reads them).
function thinker({ need = 3000, model = 'qwen3:8b', how = 'reasoning_content', answer = 'Head to the Crossroads.\n\nTL;DR: The Crossroads.', show = null, waitMs = 0, writeMs = 0, counted = null, onCall = null } = {}) {
  const chunk = (d, finish = null, extra = {}) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra })}\n\n`;
  const thought = 'Let me think about every quest…';
  return rec => {
    if (rec.url === '/api/show') return show ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(show) } : { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not found"}' };
    onCall?.(rec);
    const room = rec.body?.max_tokens ?? 0;
    const off = rec.body?.reasoning_effort === 'none';
    const think = how === 'think' ? chunk({ role: 'assistant', content: `<think>${thought}` }) : how === 'usage' ? chunk({ role: 'assistant' }) : chunk({ role: 'assistant', [how]: thought });
    const usage = out => ({ usage: { prompt_tokens: 6000, completion_tokens: out, ...(how === 'usage' ? { completion_tokens_details: { reasoning_tokens: Math.min(out, need) } } : {}) } });
    // Gemini's own reason as a gateway passes it on, MAX_TOKENS, is the ceiling too.
    const tail = off ? chunk({ content: answer }) + chunk({}, 'stop', usage(60))
      : room < need ? chunk({}, 'MAX_TOKENS', usage(counted ?? room))
        : (how === 'think' ? chunk({ content: '</think>\n\n' }) : '') + chunk({ content: answer }) + chunk({}, 'stop', usage(need + 60));
    const head = off ? '' : think;
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, script: [[waitMs, head || chunk({ role: 'assistant' })], [writeMs, ': tail\n\n' + tail + 'data: [DONE]\n\n']] };
  };
}
const customCalls = mock => mock.requests.filter(r => r.url === '/v1/chat/completions').map(r => r.body);
const OTHER = (url, model = 'qwen3:8b') => ({ provider: 'custom', model, custom: { baseUrl: `${url}/v1`, model } });
// A clock the test moves, and a fetch that moves it as the model would while the backend reads its answer:
// `wait` ms before the first chunk, `write` ms before the part from thinker's ": tail" comment on (split off
// if it came with the head). The body is read only as the backend asks for it, so the pace it measures and
// the time it has left are exact, however busy the machine. timings: {wait, write}, or a function of the
// chat call's index; a call it gives `hang` never answers.
function pacedNet(timings = {}) {
  const clock = { t: Date.parse('2026-10-06T12:00:00Z') };
  let call = 0;
  const enc = new TextEncoder();
  const fetchFn = async (url, init) => {
    const res = await fetch(url, init);
    if (!String(url).endsWith('/chat/completions') || !res.body) return res;
    const { wait = 0, write = 0 } = (typeof timings === 'function' ? timings(call++) : timings) || {};
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let first = true;
    let tail = null;
    const body = new ReadableStream({
      async pull(ctrl) {
        if (tail) { clock.t += write; ctrl.enqueue(tail); tail = null; return; }
        const { value, done } = await reader.read();
        if (done) { ctrl.close(); return; }
        if (first) { clock.t += wait; first = false; }
        const text = dec.decode(value, { stream: true });
        const i = text.indexOf(': tail');
        if (i > 0) { ctrl.enqueue(enc.encode(text.slice(0, i))); tail = enc.encode(text.slice(i)); return; }
        if (i === 0) clock.t += write;
        ctrl.enqueue(enc.encode(text));
      },
      cancel(r) { return reader.cancel(r); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  return { clock, now: () => clock.t, fetch: fetchFn };
}
const paced = (perSecond, leftMs) => Math.floor(perSecond * leftMs / 1000 * PACE_SHARE);

test('empty reply (Other, a model that thinks by default on this computer): out of room with reasoning only, it\'s tried once more with High\'s room (free here) and answers; nothing else in the request changes; the next turn starts with that room', async () => {
  for (const how of ['reasoning_content', 'reasoning', 'usage']) {
    const mock = await startMock(thinker({ how }));
    const lines = [];
    const env = await started({ config: OTHER(mock.url), log: (k, d) => lines.push([k, d]) });
    try {
      await env.backend.send(sendParams(CHAT, `e_7${how}`, 'where now?'));
      const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
      assert.equal(fin.message.content[0].text, 'Head to the Crossroads.\n\nTL;DR: The Crossroads.', how);
      const calls = customCalls(mock);
      assert.deepEqual(calls.map(c => c.max_tokens), [1200, 1200 + 8192], `${how}: the reply's 1,200, then High's room more (Minimal's 1,024 never fit a thinking model)`);
      assert.deepEqual({ ...calls[1], max_tokens: 0 }, { ...calls[0], max_tokens: 0 }, 'the rest as it was');
      assert.ok(!('reasoning_effort' in calls[0]), 'its server reported no thinking controls (a 404): nothing asked');
      // Both attempts counted once (a counted reasoning part is inside the output: TM-13), at nothing (a server here).
      assert.deepEqual([fin.usage.out, fin.usage.micros, fin.usage.exact], [1200 + 3060, 0, true], how);
      const retry = lines.find(([k]) => k === 'byok-empty-retry')?.[1];
      assert.deepEqual([retry?.how, retry?.reasoned, retry?.maxTokens, retry?.retryMaxTokens], ['room', true, 1200, 9392]);
      assert.equal(env.backend.status().lastError, null);
      // The next turn starts with the room it needed: one call, no thinking-only first try.
      await env.backend.send(sendParams(CHAT, `e_7${how}2`, 'and then?'));
      await waitFor(() => env.chats('final').length === 2, 5000, 'the second final');
      assert.deepEqual(customCalls(mock).map(c => c.max_tokens), [1200, 9392, 9392]);
      assert.equal(mock.requests.filter(r => r.url === '/api/show').length, 1, 'its server asked once a session');
    } finally { await env.backend.stop(); await mock.close(); }
  }
});

test('Other on Ollama: the model\'s thinking controls from /api/show, once a session: no thinking where it can be turned off (qwen3:8b: one call, the answer), the lowest named level where it can\'t (gpt-oss), nothing for one that always thinks (qwen3:30b) or one its server reports nothing for (deepseek-r1, any model on an older Ollama)', async () => {
  const cases = [
    { model: 'qwen3:8b', show: { thinking: { values: [false, true], default: true } }, want: 'none', calls: 1 }, // a template with /think and /no_think
    { model: 'gpt-oss:20b', show: { thinking: { values: ['low', 'medium', 'high'], default: 'medium' } }, want: 'low', calls: 2 },
    { model: 'qwen3:30b', show: { thinking: { values: [true], default: true } }, want: undefined, calls: 2 }, // a template that always opens a thinking block
    { model: 'deepseek-r1:8b', show: { license: 'MIT', template: '{{ .Prompt }}' }, want: undefined, calls: 2 }, // no thinking field for its template on any Ollama, as for any model on one before 0.34.3
  ];
  for (const c of cases) {
    const mock = await startMock(thinker({ model: c.model, show: c.show }));
    const lines = [];
    const env = await started({ config: OTHER(mock.url, c.model), log: (k, d) => lines.push([k, d]) });
    try {
      await env.backend.send(sendParams(CHAT, `e_8${c.calls}${c.want}`, 'where now?'));
      const fin = await waitFor(() => env.chats('final')[0], 5000, `${c.model}: the final`);
      assert.equal(fin.message.content[0].text, 'Head to the Crossroads.\n\nTL;DR: The Crossroads.', c.model);
      const calls = customCalls(mock);
      assert.deepEqual([calls.length, calls[0].reasoning_effort], [c.calls, c.want], c.model);
      const show = mock.requests.find(r => r.url === '/api/show');
      assert.deepEqual([show.method, show.body, show.headers.authorization], ['POST', { model: c.model }, undefined], 'the model asked about, no key sent');
      assert.deepEqual(lines.find(([k]) => k === 'byok-thinking')?.[1].options, c.want ? { reasoning_effort: c.want } : null);
    } finally { await env.backend.stop(); await mock.close(); }
  }
});

test('empty reply (Other): a model that never answers, even with High\'s room, ends with the line that sends the player to another model, never to a Thinking it doesn\'t have; no third call', async () => {
  const mock = await startMock(thinker({ need: 1e9 }));
  const env = await started({ config: OTHER(mock.url) });
  try {
    await env.backend.send(sendParams(CHAT, 'e_7n', 'where now?'));
    const err = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.deepEqual([err.errorKind, err.errorMessage, err.action],
      ['empty_reply', "NeverQuestAlone couldn't finish a reply. Ask again, or pick another model in the NeverQuestAlone app.", 'retry']);
    assert.deepEqual(customCalls(mock).map(c => c.max_tokens), [1200, 9392]);
    assert.equal(env.backend.status().lastError.code, 'length', 'MAX_TOKENS is the ceiling');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('empty reply (Other): the more-room try fits the run\'s time at the pace the model wrote from its first token; one that can\'t write 1,024 more in the time left isn\'t tried: its line now, not the same line or a timeout later', async () => {
  const run = async (key, timing, mockOpts = {}) => {
    const net = pacedNet(timing);
    const mock = await startMock(thinker(mockOpts));
    const lines = [];
    const env = await started({ config: OTHER(mock.url), now: net.now, fetch: net.fetch, runMs: 180000, log: (k, d) => lines.push([k, d]) });
    try {
      await env.backend.send(sendParams(CHAT, key, 'where now?'));
      await waitFor(() => env.chats('final')[0] || env.chats('error')[0], 5000, 'the end');
      return { calls: customCalls(mock).map(c => c.max_tokens), retry: lines.find(([k]) => k === 'byok-empty-retry')?.[1] };
    } finally { await env.backend.stop(); await mock.close(); }
  };
  // 1,200 tokens in 20 s (60 a second): 160 s left, 80% of it at that pace: 7,680, under High's 9,392.
  assert.deepEqual((await run('e_7f', { write: 20000 })).calls, [1200, paced(60, 160000)]);
  // 20 a second (60 s): 120 s left fits 1,920, not 1,024 more than it had: no more try.
  const slow = await run('e_7s', { write: 60000 });
  assert.deepEqual([slow.calls, slow.retry?.skipped, slow.retry?.leftMs, slow.retry?.reasoned], [[1200], 'no_room', 120000, true]);
  // A cold model: 50 s before its first token, then 120 a second; tried, though 1,200 in 60 s from the send
  // is 20 a second. The time left takes that wait off again: 180 - 60 - 50 = 70 s.
  assert.deepEqual((await run('e_7c', { wait: 50000, write: 10000 })).calls, [1200, paced(120, 70000)]);
  // What its usage says it wrote is its pace: 600 counted in 20 s is 30 a second, not 60.
  assert.deepEqual((await run('e_7o', { write: 20000 }, { counted: 600 })).calls, [1200, paced(30, 160000)]);
});

test('Other: a held turn\'s run limit starts again when it goes, so its more-room try has the time it\'s owed', async () => {
  // A cloud model through a server here (not local, so a refused connection holds the turn).
  const net = pacedNet({ write: 20000 });
  let down = true;
  const fetchFn = async (url, init) => {
    if (down && String(url).includes('/chat/completions')) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    return net.fetch(url, init);
  };
  const mock = await startMock(thinker({ model: 'gpt-oss:120b-cloud' }));
  const env = await started({ config: OTHER(mock.url, 'gpt-oss:120b-cloud'), now: net.now, runMs: 180000, fetch: fetchFn, holdProbeMs: { first: 30, max: 60 } });
  try {
    await env.backend.send(sendParams(CHAT, 'e_7h', 'where now?'));
    await waitFor(() => env.backend.status().held?.length === 1, 3000, 'held');
    net.clock.t += 170000; // held 170 s: most of a run limit, had it kept running
    down = false;
    await waitFor(() => env.chats('final')[0] || env.chats('error')[0], 5000, 'the end');
    assert.deepEqual(customCalls(mock).map(c => c.max_tokens), [1200, paced(60, 160000)], 'a fresh 180 s from the send');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('Other: the room a thinking model learned is held to what its last answer\'s pace writes in a run, and a run that times out forgets it', async () => {
  // Turn 1: 1,200 in 10 s (120 a second), then the answer's 3,060 in 100 s (30.6 a second). Turn 2 starts
  // with the room it learned, held to 30.6 a second for 80% of 180 s. Turn 3 hangs past its run limit;
  // turn 4 starts from the reply's own 1,200 again.
  const net = pacedNet(i => [{ write: 10000 }, { write: 100000 }, { write: 1000 }, {}, { write: 1000 }][i] ?? {});
  const think = thinker();
  const asks = (rec, words) => (rec.body?.messages ?? []).some(m => String(m.content).includes(words));
  // Turn 3 ("still there?") never answers; under load its 100 ms may even end before it's sent.
  const mock = await startMock(rec => (rec.url === '/v1/chat/completions' && asks(rec, 'still there?') ? { status: 200, headers: { 'content-type': 'text/event-stream' }, hangBeforeHeaders: true } : think(rec)));
  let short = false;
  const lines = [];
  const env = await started({ config: OTHER(mock.url), now: net.now, fetch: net.fetch, runMs: 180000, deadline: ms => AbortSignal.timeout(short ? 100 : ms), log: (k, d) => lines.push([k, d]) });
  try {
    await env.backend.send(sendParams(CHAT, 'e_9a', 'where now?'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'turn 1');
    await env.backend.send(sendParams(CHAT, 'e_9b', 'and then?'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'turn 2');
    assert.deepEqual(customCalls(mock).map(c => c.max_tokens), [1200, 9392, paced(30.6, 180000)]);
    short = true;
    await env.backend.send(sendParams(CHAT, 'e_9c', 'still there?'));
    await waitFor(() => env.chats('error').length === 1, 5000, 'turn 3 times out');
    assert.equal(env.chats('error')[0].errorKind, 'timeout');
    short = false;
    await env.backend.send(sendParams(CHAT, 'e_9d', 'hello?'));
    const turn4 = await waitFor(() => mock.requests.find(r => r.url === '/v1/chat/completions' && asks(r, 'hello?')), 5000, 'turn 4');
    assert.equal(turn4.body.max_tokens, 1200, 'the room forgotten');
    assert.ok(lines.some(([k, d]) => k === 'byok-thinking-room' && d.reason === 'timeout'));
  } finally { await env.backend.stop(); await mock.close(); }
});

test('Other at home: a server on the home network serving its own model is free, as the README says: $0 booked, and a daily limit never stops it', async () => {
  const mock = await startMock(thinker({ need: 0 }));
  const home = 'http://192.168.1.20:11434';
  const fetchFn = (url, init) => fetch(String(url).replace(home, mock.url), init);
  const env = await started({ config: { provider: 'custom', model: 'qwen3:8b', custom: { baseUrl: `${home}/v1`, model: 'qwen3:8b' } }, fetch: fetchFn });
  try {
    await env.backend.setConfig({ caps: { dailyUsd: 0.000001 } });
    for (const key of ['e_10a', 'e_10b']) {
      await env.backend.send(sendParams(CHAT, key, 'where now?'));
    }
    await waitFor(() => env.chats('final').length === 2, 5000, 'two replies under a tiny limit');
    assert.deepEqual(env.chats('final').map(f => [f.usage.micros, f.usage.exact]), [[0, true], [0, true]]);
    assert.equal(env.backend.caps.details().spentMicros, 0);
    // Spent past the limit at another AI earlier today: the free server at home isn't held at the limit.
    env.backend.caps.book({ provider: 'anthropic', micros: 5000, exact: true });
    assert.deepEqual([env.backend.status().rt.state, env.backend.status().usage?.needs ?? null], ['ready', null]);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('Other: a failed attempt keeps its thinking text, so it counts as begun (at least its estimate), never as nothing', async () => {
  const chunk = d => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm-cloud', choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`;
  const err = `data: ${JSON.stringify({ error: { message: 'bad request', type: 'invalid_request_error', code: 'bad_request' } })}\n\n`;
  const mock = await startMock(rec => (rec.url === '/api/show' ? { status: 404, headers: {}, body: '' } : { status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunk({ role: 'assistant', content: '<think>Let me plan' }) + err }));
  const env = await started({ config: OTHER(mock.url, 'm-cloud') });
  try {
    const p = sendParams(CHAT, 'e_7x', 'where now?');
    await env.backend.send(p);
    await waitFor(() => env.chats('error')[0], 5000, 'the error');
    const est = env.backend.ledger.get(p.idem).extra.estMicros;
    assert.ok(est > 0 && env.backend.caps.details().spentMicros >= est, 'counted at its estimate (failedMidReply), not 0');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('Other: thinking sent as the reply\'s text (<think>…</think>) is never the reply; one that never closed is reasoning only and gets the room to answer; the AI companies\' replies are left as they are', async () => {
  const mock = await startMock(thinker({ how: 'think', need: 3000 }));
  const env = await started({ config: OTHER(mock.url, 'deepseek-r1-distill-qwen-7b') });
  try {
    await env.backend.send(sendParams(CHAT, 'e_7t', 'where now?'));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
    assert.equal(fin.message.content[0].text, 'Head to the Crossroads.\n\nTL;DR: The Crossroads.', 'the answer alone');
    assert.deepEqual(customCalls(mock).map(c => c.max_tokens), [1200, 9392], 'the first, cut inside its <think>, had no reply');
  } finally { await env.backend.stop(); await mock.close(); }
  // Claude's reply quoting a lone </think> stays whole.
  const claude = await startMock(() => reply('Type </think> to end it.\n\nTL;DR: </think>.'));
  const a = await started({ url: claude.url, keystore: await canaryKeystore() });
  try {
    await a.backend.send(sendParams(CHAT, 'e_7u', 'how do I end a think tag?'));
    const fin = await waitFor(() => a.chats('final')[0], 5000, 'the final');
    assert.equal(fin.message.content[0].text, 'Type </think> to end it.\n\nTL;DR: </think>.');
  } finally { await a.backend.stop(); await claude.close(); }
  assert.deepEqual(splitThink('<think>plan</think>\n\nGo north.'), { text: 'Go north.' });
  assert.deepEqual(splitThink('  <THINK>plan, cut off'), { text: '' }, 'never closed: no reply');
  assert.deepEqual(splitThink('plan, the tag opened by the template</think>Go north.'), { text: 'Go north.' });
  assert.equal(splitThink('Go north. Then <think>…</think>?'), null, 'only a leading block');
  assert.equal(splitThink('Go north.'), null);
});

test('empty reply (Other, a paid service): the bigger try is checked against the player\'s daily limit first, at the unknown model\'s price; refused, nothing more is sent, and the first attempt is booked at what it cost', async () => {
  // A cloud model through a server on this computer (Ollama's -cloud): priced as any service's.
  let release;
  const gate = new Promise(r => { release = r; });
  const think = thinker({ model: 'gpt-oss:120b-cloud' });
  const mock = await startMock(async rec => { if (rec.url !== '/api/show') await gate; return think(rec); });
  const lines = [];
  const env = await started({ config: OTHER(mock.url, 'gpt-oss:120b-cloud'), log: (k, d) => lines.push([k, d]) });
  try {
    const p = sendParams(CHAT, 'e_7c', 'where now?');
    await env.backend.send(p);
    await waitFor(() => customCalls(mock).length === 1, 3000, 'the first call');
    const est = env.backend.ledger.get(p.idem).extra.estMicros;
    assert.ok(est > 0, 'not free: the service prices it');
    await env.backend.setConfig({ caps: { dailyUsd: (est + 100) / 1e6 } });
    release();
    const err = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.equal(err.errorKind, 'empty_reply', 'the empty reply\'s line, not the limit\'s');
    await sleep(50);
    assert.equal(customCalls(mock).length, 1, 'no second call');
    assert.equal(lines.find(([k]) => k === 'byok-empty-retry')?.[1].skipped, 'cap_spend');
    assert.ok(env.backend.caps.details().spentMicros > 0, 'the first attempt, booked');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('empty reply: a stop during the one more try ends the turn as aborted (nothing more sent); the run limit holds across it', async () => {
  let n = 0;
  const mock = await startMock(() => (++n === 1 ? anthropicThinkingOnly() : { status: 200, headers: { 'content-type': 'text/event-stream' }, hangBeforeHeaders: true }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    const p = sendParams(CHAT, 'e_8', 'where now?');
    await env.backend.send(p);
    await waitFor(() => chatCalls(mock).length === 2, 3000, 'the second call');
    assert.equal(env.backend.abort(CHAT).aborted, true);
    await waitFor(() => env.chats('aborted').length === 1, 3000, 'aborted');
    await sleep(50);
    assert.deepEqual(env.chats().map(c => c.state), ['aborted']);
    assert.equal(chatCalls(mock).length, 2);
    assert.equal(env.backend.ledger.get(p.idem).state, 'failed');
    assert.ok(env.backend.caps.details().spentMicros >= 1500 * 0.1 + 9392 * 0.5, 'the first attempt, at least');
  } finally { await env.backend.stop(); await mock.close(); }

  // The one run limit (PV-7): a second try that hangs ends as timeout, never a third call.
  let m = 0;
  const slow = await startMock(() => (++m === 1 ? anthropicThinkingOnly() : { status: 200, headers: { 'content-type': 'text/event-stream' }, hangBeforeHeaders: true }));
  const b = await started({ url: slow.url, keystore: await canaryKeystore(), runMs: 600 });
  try {
    await b.backend.send(sendParams(CHAT, 'e_9', 'where now?'));
    const err = await waitFor(() => b.chats('error')[0], 5000, 'the timeout');
    assert.equal(err.errorKind, 'timeout');
    assert.equal(chatCalls(slow).length, 2);
  } finally { await b.backend.stop(); await slow.close(); }
});

test('empty reply: roomForRetry never gives the same request: the lowest level, else more room (the next level\'s, or THINK_ROOM\'s next step), held to the model\'s output ceiling; null with none left', () => {
  const a = getManifest('anthropic');
  const x = getManifest('xai');
  const req = (effort, maxTokens, extra = {}) => ({ effort, maxTokens, replyTokens: 1200, messages: [{ role: 'user', content: 'x' }], ...extra });
  assert.deepEqual(roomForRetry(req('high', 9392), a, 'claude-sonnet-5-5'), { how: 'lower', req: req('off', 1200) });
  assert.deepEqual(roomForRetry(req('max', 64000), a, 'claude-haiku-4-5'), { how: 'lower', req: req('off', 1200) });
  assert.deepEqual(roomForRetry(req('low', 3248), a, 'claude-opus-5-5'), { how: 'room', req: req('low', 3248 + 4096) }, 'Opus 5.5\'s lowest is Low: Medium\'s room more');
  assert.deepEqual(roomForRetry(req('off', 1200), a, 'claude-sonnet-5-5'), { how: 'room', req: req('off', 1200 + 2048) }, 'at Off: Low\'s room more');
  assert.deepEqual(roomForRetry(req(null, 1200 + 4096), x, 'grok-4.20-0309-reasoning'), { how: 'room', req: req(null, 1200 + 4096 + 8192) }, 'no levels, 4,096 of its own: the next step up, 8,192');
  assert.deepEqual(roomForRetry(req(null, 1200), x, 'grok-4.20-0309-non-reasoning'), { how: 'room', req: req(null, 1200 + 1024) });
  // A model with no levels seen thinking (Other's qwen3 on Ollama): High's room at least, within the time the
  // run has left at the failed attempt's pace; not seen thinking, as before; a model with levels, its next.
  const other = customManifest(getManifest('custom'), { baseUrl: 'http://localhost:8080/v1', model: 'qwen3:8b' });
  assert.deepEqual(roomForRetry(req(null, 1200), other, 'qwen3:8b', { reasoned: true }), { how: 'room', req: req(null, 1200 + 8192) });
  assert.deepEqual(roomForRetry(req(null, 1200), other, 'qwen3:8b'), { how: 'room', req: req(null, 1200 + 1024) });
  assert.deepEqual(roomForRetry(req(null, 1200 + 4096), x, 'grok-4.20-0309-reasoning', { reasoned: true }), { how: 'room', req: req(null, 1200 + 4096 + 8192) }, 'its next step is High\'s anyway');
  assert.deepEqual(roomForRetry(req(null, 1200), other, 'qwen3:8b', { reasoned: true, perSecond: 50, leftMs: 100000 }), { how: 'room', req: req(null, Math.floor(50 * 100 * PACE_SHARE)) }, '4,000 tokens in the time left');
  assert.equal(roomForRetry(req(null, 1200), other, 'qwen3:8b', { reasoned: true, perSecond: 10, leftMs: 60000 }), null, '480 in the time left: less than it had');
  assert.deepEqual(roomForRetry(req('low', 3248), a, 'claude-opus-5-5', { reasoned: true }), { how: 'room', req: req('low', 3248 + 4096) }, 'levels: the next one\'s, reasoned or not');
  // Held to the model's own output ceiling; at it already, no retry (never the same request).
  const tight = { ...a, models: { ...a.models, list: a.models.list.map(e => (e.id === 'claude-opus-5-5' ? { ...e, outputTokens: 5000 } : e)) } };
  assert.deepEqual(roomForRetry(req('low', 3248), tight, 'claude-opus-5-5'), { how: 'room', req: req('low', 5000) });
  assert.equal(roomForRetry(req('low', 5000), tight, 'claude-opus-5-5'), null);
  const roomy = { ...x, models: { ...x.models, list: x.models.list.map(e => (e.id === 'grok-4.20-0309-reasoning' ? { ...e, thinkRoom: 65536 } : e)) } };
  assert.equal(roomForRetry(req(null, 1200 + 65536), roomy, 'grok-4.20-0309-reasoning'), null, 'a room at THINK_ROOM\'s last step: nothing more to give');
});

test('empty reply (Anthropic, at the lowest level): out of room at Low on Opus 5.5 (it has no Off) is tried once more at Low with more room, never the same request; the reply goes through', async () => {
  let n = 0;
  const mock = await startMock(() => (++n === 1 ? anthropicThinkingOnly({ input: 1500, output: 3248 }) : reply('Head to Bloodhoof.\n\nTL;DR: Bloodhoof.', { input: 1500, output: 60 })));
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), config: { model: 'claude-opus-5-5' }, log: (k, d) => lines.push([k, d]) });
  try {
    const p = sendParams(CHAT, 'e_10', 'where now?');
    await env.backend.send(p);
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
    assert.equal(fin.message.content[0].text, 'Head to Bloodhoof.\n\nTL;DR: Bloodhoof.');
    const [first, second] = chatCalls(mock).map(r => r.body);
    assert.equal(chatCalls(mock).length, 2);
    assert.equal(first.model, 'claude-opus-5-5');
    assert.deepEqual([first.output_config, first.max_tokens], [{ effort: 'low' }, 1200 + 2048]);
    assert.deepEqual([second.output_config, second.max_tokens], [{ effort: 'low' }, 1200 + 2048 + 4096], 'the same level, Medium\'s room more');
    assert.deepEqual(second.messages, first.messages);
    assert.deepEqual([fin.usage.in, fin.usage.out], [3000, 3308], 'both attempts');
    assert.equal(env.backend.caps.details().spentMicros, (1500 * 0.1 + 3248 * 0.5) + (1500 * 0.1 + 60 * 0.5));
    const retry = lines.find(([k]) => k === 'byok-empty-retry')?.[1];
    assert.deepEqual([retry?.how, retry?.effort, retry?.maxTokens, retry?.retryMaxTokens], ['room', 'low', 3248, 7344]);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('empty reply (at the lowest level): the more-room try is checked against the player\'s daily spend limit first; refused, nothing more is sent and the turn ends with its line, the first attempt booked', async () => {
  const head = anthropicThinkingOnly({ input: 1500, output: 3248 });
  // The first answer waits until the limit is set from the turn's own estimate.
  let release;
  const gate = new Promise(r => { release = r; });
  const mock = await startMock(async () => { await gate; return head; });
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), config: { model: 'claude-opus-5-5' }, log: (k, d) => lines.push([k, d]) });
  try {
    const p = sendParams(CHAT, 'e_11', 'where now?');
    await env.backend.send(p);
    await waitFor(() => chatCalls(mock).length === 1, 3000, 'the first call');
    const est = env.backend.ledger.get(p.idem).extra.estMicros;
    // Room for this turn as estimated, not for its first attempt and a bigger second one on top.
    await env.backend.setConfig({ caps: { dailyUsd: (est + 100) / 1e6 } });
    release();
    const err = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.deepEqual([err.errorKind, err.errorMessage, err.action], ['empty_reply', NO_REPLY, 'retry'], 'the empty reply\'s line, not the limit\'s');
    await sleep(50);
    assert.equal(chatCalls(mock).length, 1, 'no second call');
    assert.deepEqual([env.backend.status().lastError.kind, env.backend.status().lastError.code], ['empty_reply', 'length']);
    assert.equal(env.backend.ledger.get(p.idem).state, 'failed');
    assert.equal(env.backend.caps.details().spentMicros, 1500 * 0.1 + 3248 * 0.5, 'the first attempt, at what it cost');
    assert.equal(lines.find(([k]) => k === 'byok-empty-retry')?.[1].skipped, 'cap_spend');
  } finally { await env.backend.stop(); await mock.close(); }
});

// ------------------------------------------------------------------ pause holds what waits (code health BR-03)

test('code health BR-03: while paused, a queued turn never starts (nothing reserved or sent) and runs on resume; a running one finishes; the typed guard\'s hold the same; a stop ends a held one', async () => {
  let gate = null; // the first call is answered when the test says
  const mock = await startMock(async (r) => {
    if (!gate) { gate = 'open'; await new Promise((res) => { gate = res; }); }
    return reply(`Re ${String(r.body?.messages?.at(-1)?.content ?? '').slice(-2)}.\n\nTL;DR: ok.`);
  });
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), log: (k, d) => lines.push([k, d]) });
  try {
    // One running in CHAT; two behind it there, and one in CHAT2 waiting for a slot, then paused.
    await env.backend.send(sendParams(CHAT, 'h_1', 'a1'));
    await waitFor(() => chatCalls(mock).length === 1 && typeof gate === 'function', 3000, 'the first call out');
    env.backend.pause(true);
    for (const [chat, key, text] of [[CHAT, 'h_2', 'a2'], [CHAT, 'h_3', 'a3'], [CHAT2, 'h_4', 'b1']]) await env.backend.send(sendParams(chat, key, text));
    gate(); // the running one finishes
    await waitFor(() => env.chats('final').length === 1, 3000, 'the running turn\'s reply');
    await sleep(200);
    assert.equal(chatCalls(mock).length, 1, 'paused: nothing waiting started');
    for (const k of ['h_2', 'h_3', 'h_4']) assert.equal(env.backend.ledger.get(`nqa:3fa9c2d1:${k}`).state, 'queued', `${k}: nothing reserved`);
    assert.equal(env.backend.caps.details().typed, 1, 'billed: only the one that ran');
    assert.ok(lines.some(([k, d]) => k === 'byok-turn-held' && d.by === 'paused'));
    env.backend.pause(false);
    await waitFor(() => env.chats('final').length === 4, 5000, 'they run on resume');
    assert.equal(chatCalls(mock).length, 4);
    // The core's typed guard tripped: held the same way until Resume sending, independent of Pause.
    env.backend.holdRuns(true);
    await env.backend.send(sendParams(CHAT, 'h_5', 'a5'));
    await env.backend.send(sendParams(CHAT2, 'h_6', 'b6'));
    await sleep(200);
    assert.equal(chatCalls(mock).length, 4, 'sending paused: nothing started');
    env.backend.pause(true);
    env.backend.holdRuns(false);
    await sleep(100);
    assert.equal(chatCalls(mock).length, 4, 'still paused: both must be over');
    // A stop ends a held turn: aborted, nothing sent or counted.
    env.backend.abort(CHAT2);
    await waitFor(() => env.chats('aborted').length === 1, 3000, 'the held turn stopped');
    env.backend.pause(false);
    await waitFor(() => env.chats('final').length === 5, 5000, 'the other runs');
    await sleep(100);
    assert.equal(chatCalls(mock).length, 5);
    assert.equal(env.backend.ledger.get('nqa:3fa9c2d1:h_6').state, 'failed');
    assert.equal(env.backend.caps.details().typed, 5);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('code health BR-12: lastRequest keeps the requests of the 8 chats used last (each holds a whole prompt), the oldest going first', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const chats = Array.from({ length: 10 }, (_, i) => `c${(0xa00000 + i).toString(16)}`);
    const turn = async (chat, key) => {
      const before = env.chats('final').length;
      await env.backend.send(sendParams(chat, key, 'hi'));
      await waitFor(() => env.chats('final').length === before + 1, 5000, `the turn in ${chat}`);
    };
    for (const [i, chat] of chats.entries()) await turn(chat, `lr_${i}`);
    assert.equal(LAST_REQUESTS, 8);
    assert.deepEqual(chats.map(c => env.backend.lastRequest(c) !== null), [false, false, true, true, true, true, true, true, true, true]);
    // Used again, a chat is the newest: the next one in evicts the oldest still kept.
    await turn(chats[2], 'lr_again');
    await turn(chats[0], 'lr_back');
    assert.deepEqual(chats.map(c => env.backend.lastRequest(c) !== null), [true, false, true, false, true, true, true, true, true, true]);
    assert.equal(env.backend.lastRequest().chatId, chats[0], 'the most recent across chats');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend (KY-10, code health BR-22): byok-chats.json keeps the safety id and each chat\'s own model only: an older build\'s session keys, labels (a key-shaped one too) and turn keys are read past, and gone at the next write', async () => {
  const dataDir = tmpDir();
  const safetyId = 'f00dfeed-0000-4000-8000-000000000000';
  fs.writeFileSync(path.join(dataDir, 'byok-chats.json'), JSON.stringify({ v: 1, safetyId, chats: {
    [CHAT]: { sessionKey: `old:session:${CHAT}`, sessionId: 's1', label: `WoW · ${CANARY_KEYS.openai}`, lastT: 5,
      turns: [{ idem: 'nqa:3fa9c2d1:a3f1_1', userT: 4, replyT: 5 }], model: 'claude-haiku-4-5', modelProvider: 'anthropic' },
    [CHAT2]: { sessionKey: `old:session:${CHAT2}`, sessionId: 's2', label: 'WoW · Hyjal route', lastT: 0, turns: [] },
  } }));
  const env = await started({ keystore: await canaryKeystore(), dataDir });
  try {
    assert.equal(env.backend.chatSlot(CHAT).model, 'claude-haiku-4-5', 'a chat\'s own model is kept');
    assert.equal(env.backend.chatSlot(CHAT2).model, undefined);
    assert.deepEqual(env.backend.setChatModel(CHAT2, 'claude-sonnet-5-5'), { ok: true, model: 'claude-sonnet-5-5' }); // a write
    const side = fs.readFileSync(path.join(dataDir, 'byok-chats.json'), 'utf8');
    assert.ok(!side.includes('CANARY'), 'no key in byok-chats.json');
    assert.deepEqual(JSON.parse(side), { v: 1, safetyId, chats: {
      [CHAT]: { model: 'claude-haiku-4-5', modelProvider: 'anthropic' }, [CHAT2]: { model: 'claude-sonnet-5-5', modelProvider: 'anthropic' } } });
    assert.throws(() => env.backend.setChatModel('old:session:c3f9a1e', 'claude-haiku-4-5'), /INVALID_REQUEST/, 'a chat id only');
  } finally { await env.backend.stop(); }
});

test('backend (KY-10, KB-03, code health): a key in the player\'s memory notes, a context line or a ride-along note never reaches the provider; the rest still rides; the log says how many, never what', async () => {
  const mock = await startMock(() => reply('Fine.\n\nTL;DR: fine.'));
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), log: (kind, data) => lines.push({ kind, ...data }) });
  try {
    const ctx = 'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)\nCharacter: Testchar on Testrealm, level 8 Tauren Shaman (Horde)\nLocation: Mulgore - Red Cloud Mesa';
    const mem = path.join(env.dataDir, 'memory', 'Testchar-Testrealm');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'character.md'), '# Character\n\n## Facts (from the game)\n<!-- nqa:facts:start -->\n- Level 8 Tauren Shaman\n<!-- nqa:facts:end -->\n\n'
      + `- Backup: ${CANARY_KEYS.openai}\nPlan: tank build.\n`);
    fs.writeFileSync(path.join(mem, 'quests.md'), `# Quests\n\nmy other key ${CANARY_KEYS.anthropic}\n`);
    const p = sendParams(CHAT, 'a3f1_31', 'where next?', { contextLines: `${ctx}\nNote: ${CANARY_KEYS.xai}` });
    p.turn.notes = [`Held while automatic help was paused: ${CANARY_KEYS.google}`, 'Held while automatic help was paused: Level up'];
    await env.backend.send(p);
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    const body = chatCalls(mock)[0].body;
    assert.ok(!JSON.stringify(body).includes('CANARY'), 'no key in the request');
    const block = readDataBlock(body.messages.at(-1).content);
    assert.deepEqual(block.data.memory.character, ['Level 8 Tauren Shaman']);
    assert.deepEqual(block.data.memory.notes, ['Plan: tank build.']);
    assert.ok(block.data.game.context.includes('Location: Mulgore - Red Cloud Mesa'), 'the other context lines still ride');
    assert.ok(block.data.game.notes.includes('Held while automatic help was paused: Level up'));
    assert.ok(!block.data.game.notes.some(n => n.includes('CANARY')));
    const dropped = Object.fromEntries(lines.filter(l => l.kind === 'byok-key-dropped').map(l => [l.where, l.n]));
    assert.deepEqual(dropped, { context: 1, notes: 1, memory: 2 });
    assert.ok(!JSON.stringify(lines).includes('CANARY'), 'and the log lines hold no key');
    // The app's memory page shows what a turn carries: no key there either.
    assert.ok(!JSON.stringify(env.backend.memory({ name: 'Testchar', realm: 'Testrealm' }).digest).includes('CANARY'));
  } finally { await env.backend.stop(); await mock.close(); }
});

test('backend (KB-09, code health): a request id the provider or a proxy echoes a key in is dropped at the stream\'s start: never in the log, the ledger or an error', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.', { requestId: CANARY_KEYS.anthropic }));
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), log: (kind, data) => lines.push({ kind, ...data }) });
  try {
    await env.backend.send(sendParams(CHAT, 'rq_1', 'hi'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    assert.equal(lines.find(l => l.kind === 'byok-turn').requestId, undefined);
    assert.ok(!JSON.stringify(lines).includes('CANARY'), 'no log line holds it');
    assert.ok(!JSON.stringify(env.backend.ledger.list()).includes('CANARY'));
  } finally { await env.backend.stop(); await mock.close(); }
});
