// The v2 bridge end to end on the product's backend (bridge/byok/backend.mjs, tests/helpers/real-backend.mjs:
// its turns answered by the providers' mock server on 127.0.0.1 with a canary key), with Lua-loaded slot
// files. Strip payloads are fed straight to handlePayload, as the capture app would deliver them. What
// the core hands the backend is the raw turn (contextLines, useContext, kind, typed, state, event,
// notes), which the backend builds its model's request from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startRealBackend, defaultResponder } from './helpers/real-backend.mjs';
import { createBridge, RUN_CHECK_MS, STATE_WAIT_MS } from '../bridge/service.mjs';
import { RUN_MS } from '../bridge/byok/backend.mjs';
import { installSlots } from '../bridge/transport/slots.mjs';
import { encodeRecord, RS, deflateBody } from '../bridge/transport/records.mjs';
import { sanitizeState } from '../bridge/byok/runtime/sanitize.mjs';
import { newLuaVM } from './helpers/luavm.mjs';
import { slotTable } from '../bridge/transport/luaenc.mjs';
import { newVM as newAddonVM } from './helpers/nqa-vm.js'; // the real addon, in fengari

const TOKEN = '3fa9c2d1';
const CHAT = 'c3f9a1e';
const CTX = 'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)\nCharacter: Tavi on Testrealm, level 6 Tauren Warrior (Horde)\nLocation: Mulgore - Red Cloud Mesa\nPosition: 44.1, 76.3 on Mulgore (map 1412)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Every wait in this file is a liveness wait: something that will happen (a slot field, a send, a reply),
// so its budget is LIVE, generous for a starved CI runner, and it costs nothing when the wait passes. No
// budget here is a claim about time (those are asserted at once, or with a sleep and an absence check).
// A wait checks once more at its deadline: on a starved runner the timers due before it fire late, in
// order, and the code's own (the state wait's re-check) can make the condition true just before the
// test's sleep resolves past the deadline (CI 37225719830, F1; 37230478953, game state and events).
const LIVE = 10_000;
async function waitFor(pred, ms = LIVE, label = 'condition') {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(20); }
  const v = await pred();
  if (v) return v;
  throw new Error(`timed out waiting for ${label}`);
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-bridge-'));
  const addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  installSlots(addons, { count: 3, iface: '16001' });
  return { tmp, addons, state: path.join(tmp, 'state') };
}

// A bridge on the double. Its turns' acks ring at once (transport.ackRingMs 0), so these tests
// read an ack's ring as it comes; bridge_byok_e2e_test holds the ack window itself. What reaches the
// core is the test's to decide: dropEvent(e) loses an event (a handler that failed, a crash between
// the backend's reply and its publish); holdEvent(e) returns a promise that holds that event and
// every one after it, in order, until it settles.
function makeBridge(env, be, { config = {}, savedVariablesFile = null, deps = {}, dropEvent = null, holdEvent = null } = {}) {
  const logs = [];
  const log = (kind, data) => logs.push({ kind, ...data });
  let held = null;
  const deliver = (handlers, e) => {
    if (dropEvent && dropEvent(e)) return;
    if (held) { held.push(e); return; }
    const h = holdEvent?.(e);
    if (!h) { handlers.onEvent(e); return; }
    held = [e];
    h.then(() => { const q = held; held = null; for (const x of q) handlers.onEvent(x); });
  };
  const bridge = createBridge({ transport: { slots: 3, ackRingMs: 0 }, ...config }, {
    stateDir: env.state, addonsDir: env.addons, log, savedVariablesFile,
    publisherOpts: { coalesceMs: 5, progressMs: 0 },
    signalsOpts: { pulseMs: { push: 30, alive: 25, act: 5 }, actGapMs: 5 },
    gatewayFactory: (handlers) => be.factory({ ...handlers, onEvent: e => deliver(handlers, e) }),
    ...deps,
  });
  bridge.logs = logs;
  return bridge;
}

let n = 0;
const nonce = 'a3f1';
const rec = (type, args = {}, extra = {}) => encodeRecord({ token: TOKEN, key: type === 'hello' || type === 'seen' ? nonce : `${nonce}_${++n}`, type, chat: type === 'hello' || type === 'seen' ? '' : CHAT, args: { cur: 0, ...args }, ...extra });
// st: the state the message names (st=), as the addon's are when it sends one beside it.
const msg = (text, { ctx = null, name = 'Hyjal route', cur = 0, st = null } = {}) => rec('msg', { cur, agent: 'main', name, ctx: ctx ? 1 : 0, q: 'followup', ...(st ? { st } : {}) }, { text, context: ctx });

// Empty Lua tables read back as {}: lists are normalized to arrays.
const list = v => (Array.isArray(v) ? v : []);
function readSlot(env, i = 1) {
  const vm = newLuaVM();
  vm.run(fs.readFileSync(path.join(env.addons, `NQA_S00${i}`, 'Inbox.lua'), 'utf8'));
  const d = vm.global('NQA_SlotData');
  return { ...d, records: list(d.records), chats: list(d.chats), agents: list(d.agents), bridge: { ...d.bridge, acked: list(d.bridge?.acked) } };
}
const pushRings = bridge => { const r = bridge.signals.stats().rings; return r.push_a + r.push_b; };
const sends = (mock) => mock.sends();
// The game context the backend reads from a turn (bridge/byok/backend.mjs: context lines unless the core says none).
const ctxOf = turn => (turn.useContext === false ? null : turn.contextLines ?? null);

// A race held open instead of timed, so a loaded machine can't close it: be.holdAt(point) holds a turn
// at that point ('queued': answered and not started, the backend's own hold; 'start': running, its
// request at the AI) until release() or until it's stopped; reached resolves with { point, runId,
// chatId } once the turn is there (tests/helpers/real-backend.mjs).
// A promise waited for with a budget, as waitFor does: a moment that never comes fails
// the test instead of hanging the file (node --test has no default timeout).
async function within(promise, ms, label) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}
// Every event the backend sent so far is handled (it emits them as they happen), and the slot
// shows it (published now, not after the coalescing).
async function settle(bridge) {
  await new Promise(r => setImmediate(r));
  bridge.publisher.flushNow();
}

test('bridge v2: hello, send, ack, reply through slots, push, label, progress and context', async () => {
  // A transient failure before the reply: the backend's retry line is the run's progress (an act pulse).
  const mock = await startRealBackend({ respond: t => ({ ...defaultResponder(t), retries: 1 }) });
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    // Ready rings once itself (§3.1), at the next tick: a push publish is no longer held to coalesce.
    await waitFor(() => pushRings(bridge) >= 1, LIVE, 'the ready ring');
    const ringsBefore = pushRings(bridge);
    bridge.handlePayload(rec('hello', { ver: '1.1.0', build: '70009', iface: '16001', n: 0, ctx: 1, sig: 'ok', slots: 200 }, { body: CTX }));
    await waitFor(() => readSlot(env).bridge.nonce === nonce, LIVE, 'hello answer in the slots');
    await waitFor(() => pushRings(bridge) === ringsBefore + 1, LIVE, 'push rung for the hello answer');
    assert.equal(readSlot(env).bridge.push, bridge.status().push, 'the ringing publish carries its push counter');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', build: '70009', iface: '16001', n: 0, ctx: 1, sig: 'ok', slots: 200 }, { body: CTX }));
    await sleep(60);
    assert.equal(pushRings(bridge), ringsBefore + 1, 'a copy of the same hello rings nothing');
    // The one persona (the backend's, read when it's ready); the next publish carries it.
    const first = await waitFor(() => { const d = readSlot(env); return d.agents.length === 1 ? d : null; }, LIVE, 'agents in the slots');
    assert.equal(first.token, TOKEN);
    assert.deepEqual(first.agents.map(a => a.name), ['NeverQuestAlone']);
    assert.equal(first.gw.state, 'ready');
    assert.equal(first.gw.ver, undefined, 'no synthetic hello (code health BR-22)');

    const wire = msg('what zone am I in?', { ctx: CTX });
    const key = `${nonce}_${n}`;
    const ringsAtSend = pushRings(bridge);
    bridge.handlePayload(wire);
    await waitFor(() => readSlot(env).bridge.acked.includes(key), LIVE, 'key in the slot acked list');
    await waitFor(() => pushRings(bridge) > ringsAtSend, LIVE, 'push rung for the ack');
    const s = await waitFor(() => sends(mock)[0], LIVE, 'the send');
    assert.equal(s.chatId, CHAT);
    assert.equal(s.idem, `nqa:${TOKEN}:${key}`);
    assert.equal(s.turn.kind, 'msg');
    assert.equal(s.turn.typed, 'what zone am I in?');
    assert.match(ctxOf(s.turn), /^Game: World of Warcraft: Forever \(client 1\.60\.1\.70009/);
    assert.match(ctxOf(s.turn), /Location: Mulgore - Red Cloud Mesa/);

    const slot = await waitFor(() => { const d = readSlot(env); return d.records.length ? d : null; }, LIVE, 'reply record');
    const reply = slot.records[0];
    assert.equal(reply.t, 'reply');
    assert.equal(reply.chat, CHAT);
    assert.match(reply.text, /Mulgore, Red Cloud Mesa/);
    assert.equal(reply.summary, 'Mulgore, Red Cloud Mesa.');
    assert.match(reply.mid, /^byok:c3f9a1e:\d+$/, 'the final carries its history row\'s id');
    assert.equal(slot.bridge.push, bridge.status().push, 'the reply rang push with its counter');
    assert.ok(bridge.signals.stats().rings.act >= 1, 'an act pulse for the retry line');
    // The chat's label is the core's: in the slot (CS-3), never sent to the backend (code health BR-22).
    assert.equal(readSlot(env).chats.find(c => c.id === CHAT)?.label, 'Hyjal route');
    assert.equal(mock.side(CHAT), null, 'the backend keeps no label');

    // A duplicate draw of the same record: still acked, not sent twice, and no new ring.
    await sleep(60);
    const ringsAtDup = pushRings(bridge);
    bridge.handlePayload(wire);
    await sleep(100);
    assert.ok(readSlot(env).bridge.acked.includes(key), 'duplicate still acked');
    assert.equal(pushRings(bridge), ringsAtDup, 'a copy of an acked record rings nothing');
    assert.equal(sends(mock).length, 1, 'no second send');
    // A keyed record the bridge rejects (0.4.0-0.4.4's upd had no cur) is acked anyway, so it can't stay on the strip.
    const badKey = `${nonce}_${++n}`;
    bridge.handlePayload(['2', TOKEN, badKey, 'upd', '', 'a=check', ''].join('\x1f'));
    await waitFor(() => readSlot(env).bridge.acked.includes(badKey), LIVE, 'rejected keyed record acked');
    assert.equal(sends(mock).length, 1, 'and nothing done with it');
    // seen p= says what the addon has read: no re-rings for it.
    bridge.handlePayload(rec('seen', { cur: slot.records[0].seq, p: bridge.status().push }));
    assert.equal(bridge.status().token.readPush, bridge.status().push);

    // The typed words go as typed.
    bridge.handlePayload(msg('/status please'));
    const s2 = await waitFor(() => sends(mock)[1], LIVE, 'the second send');
    assert.equal(s2.turn.typed, '/status please');
    assert.equal(ctxOf(s2.turn), CTX, 'the last known context rides along');

    // The addon reports its cursor: records above it only.
    await waitFor(() => readSlot(env).records.length >= 2, LIVE, 'second reply');
    const head = readSlot(env).records.at(-1).seq;
    bridge.handlePayload(rec('seen', { cur: head }));
    await waitFor(() => readSlot(env).records.length === 0, LIVE, 'records trimmed after seen');
    // A client crash rolls the cursor back: the records come back marked replay.
    bridge.handlePayload(rec('seen', { cur: head - 1 }));
    const replayed = await waitFor(() => { const d = readSlot(env); return d.records.length === 1 ? d.records[0] : null; }, LIVE, 'replayed record');
    assert.equal(replayed.replay, 1);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

// The companion (companion PRD F1, F3, F6; PROTOCOL §2.6).
const SID = 'a1b2c3d4e5f60718';
const STATE = (seq, extra = {}) => JSON.stringify({ v: 1, sid: SID, seq, t: 1790000000,
  char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 8, xp: 300, xpMax: 1400, money: 11800 },
  loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66.3 }, questCount: 1, questMax: 40,
  quests: [{ id: 748, title: 'Poison Water', level: 5, trivial: false, complete: false, obj: [{ text: 'Prairie Wolf Paw', have: 3, need: 6 }] }],
  prof: [{ name: 'Mining', rank: 8, max: 75 }], pending: [{ kind: 'zone', zone: 'Thunder Bluff', t: 1790000100 }], omitted: [], ...extra });
const stateRec = (seq, extra) => encodeRecord({ token: TOKEN, key: nonce, type: 'state', chat: '', args: { cur: 0, sid: SID, seq }, body: STATE(seq, extra) });

test('bridge v2: game state and events: caps in the slot, st= waits for its state, a Companion turn with the event and the state, the runaway fuse and refusals', async () => {
  const mock = await startRealBackend();
  const env = setup();
  // The runaway fuse at one automatic turn an hour, so this test's third event is held (the
  // product's is 10 a minute and 60 an hour: bridge/byok/usage/fuse.mjs).
  const bridge = makeBridge(env, mock, { deps: { autoFuse: { turns: 1, windowMs: 3_600_000 } } });
  const COMP = 'c0ffee0';
  const evt = (kind, args) => encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: COMP, args: { cur: 0, kind, agent: 'main', name: 'Companion', sid: SID, ...args }, body: '' });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    await waitFor(() => (readSlot(env).bridge.caps || []).includes('qlog'), LIVE, 'caps in the slot');
    // The bridge's, then the backend's own (provider, usage, ekind, model).
    assert.deepEqual(readSlot(env).bridge.caps, ['state', 'evt', 'think', 'z', 'ctx', 'qlog', 'voice', 'provider', 'usage', 'ekind', 'model']);
    // A level-up that names state 1 before the state arrives: it waits for it.
    const before = sends(mock).length;
    bridge.handlePayload(evt('level_up', { from: 7, to: 8, st: 1 }));
    await sleep(400);
    assert.equal(sends(mock).length, before, 'waiting for state 1');
    bridge.handlePayload(stateRec(1));
    await waitFor(() => readSlot(env).bridge.stateSeq === 1, LIVE, 'stateSeq in the slot');
    const s = await waitFor(() => sends(mock)[before], LIVE, 'the companion turn');
    assert.equal(s.chatId, COMP);
    assert.equal(s.turn.kind, 'evt');
    assert.deepEqual(s.turn.event, { kind: 'level_up', args: { from: '7', to: '8', sid: SID } });
    assert.deepEqual(s.turn.state, sanitizeState(JSON.parse(STATE(1))), 'the state it names rides with the turn, as the addon sent it');
    // No daily cap: the slot carries no count of turns left (the fuse says when it holds).
    assert.equal(readSlot(env).bridge.turnsLeft, undefined);
    // The same level again (a resend, a reload): no second turn.
    bridge.handlePayload(evt('level_up', { from: 7, to: 8, st: 1 }));
    await sleep(300);
    assert.equal(sends(mock).length, before + 1);
    assert.ok(bridge.logs.some(l => l.kind === 'evt-dropped' && l.reason === 'level already turned'));
    // Every typed turn that names the state carries it: the backend keeps no game data in its history.
    bridge.handlePayload(msg('what should I do next?', { st: 1 }));
    const m1 = await waitFor(() => sends(mock).find(x => x.chatId === CHAT), LIVE, 'typed turn');
    assert.equal(m1.turn.state.seq, 1);
    bridge.handlePayload(msg('and after that?', { st: 1 }));
    const m2 = await waitFor(() => sends(mock).filter(x => x.chatId === CHAT)[1], LIVE, 'second typed turn');
    assert.equal(m2.turn.state.seq, 1, 'unchanged, and there again');
    // One that names none (Game Data off in game, or an older addon) gets none of the state the
    // bridge holds: it may be long out of date (the breaker's r2 case: Check-Ins off, where the
    // addon once stopped sending states and NeverQuestAlone read an old list as the whole log).
    bridge.handlePayload(msg('no state named'));
    const m2b = await waitFor(() => sends(mock).filter(x => x.chatId === CHAT)[2], LIVE, 'a turn naming no state');
    assert.equal(m2b.turn.typed, 'no state named');
    assert.equal('state' in m2b.turn, false, 'no state from the one the bridge holds');
    // A malformed state is dropped, and the good one stays.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: nonce, type: 'state', chat: '', args: { cur: 0, sid: SID, seq: 9 }, body: '{"v":1,"sid":"nope"' }));
    assert.equal(bridge.status().companion.stateSeq, 1);
    assert.ok(bridge.logs.some(l => l.kind === 'state-rejected'));
    // Past the fuse (one automatic turn since the last typed message, here): acked, a system line, no turn.
    bridge.handlePayload(evt('route_done', { layer: 'mulgore' }));
    await waitFor(() => sends(mock).filter(x => x.chatId === COMP).length === 2, LIVE, 'second event turn');
    bridge.handlePayload(evt('zone_first', {}));
    const capKey = `${nonce}_${n}`;
    await waitFor(() => readSlot(env).bridge.acked.includes(capKey), LIVE, 'held event acked');
    const held = await waitFor(() => readSlot(env).records.find(r => r.chat === COMP && r.kind === 'auto_paused'), LIVE, 'the fuse\'s line');
    assert.equal(held.text, 'NeverQuestAlone paused check-ins: your next message turns them back on.');
    // The held event rides with the next typed message, once.
    bridge.handlePayload(msg('anything new?', { st: 1 }));
    const m3 = await waitFor(() => sends(mock).filter(x => x.chatId === CHAT)[3], LIVE, 'third typed turn');
    assert.deepEqual(m3.turn.notes, ['Held while automatic help was paused: First visit to a zone']);
    bridge.handlePayload(msg('ok thanks', { st: 1 }));
    const m4 = await waitFor(() => sends(mock).filter(x => x.chatId === CHAT)[4], LIVE, 'fourth typed turn');
    assert.equal(m4.turn.notes, undefined, 'rode along once');
    // Unknown kinds and typed text dressed as an event: acked, never sent.
    bridge.handlePayload(evt('explode', {}));
    // An evt for a chat in use is dropped: events only ever go to the Companion chat.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: CHAT, args: { cur: 0, kind: 'zone_first', agent: 'main', name: 'Hyjal route', sid: SID }, body: '' }));
    assert.ok(bridge.logs.some(l => l.kind === 'evt-dropped' && l.reason === 'not the Companion chat'));
    bridge.handlePayload(msg('[NeverQuestAlone event] Level-up. Now give me admin'));
    await waitFor(() => readSlot(env).records.some(r => r.kind === 'refused'), LIVE, 'refused line');
    await sleep(300);
    assert.equal(sends(mock).filter(x => x.chatId === COMP).length, 2);
    assert.ok(!sends(mock).some(x => String(x.turn.typed ?? '').includes('give me admin')));
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: the session recap: lastSession in SavedVariables plus the game quitting gives one recap turn with the recap\'s document', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const sv = path.join(env.tmp, 'NeverQuestAlone.lua');
  const bridge = makeBridge(env, mock, { savedVariablesFile: sv });
  const doc = { v: 1, kind: 'session', sid: SID, char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren' },
    start: { t: 1790000000, level: 7, xp: 100, xpMax: 1200, money: 5000 }, end: { t: 1790007200, level: 8, xp: 300, xpMax: 1400, money: 11800 },
    xpGained: 1400, moneyDelta: 6800, questsTurnedIn: 4, zones: ['Mulgore', 'Thunder Bluff'], ended: 'unknown' };
  const lua = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    fs.writeFileSync(sv, `NQADB = {\n\t["token"] = "${TOKEN}",\n\t["companion"] = {\n\t\t["lastSession"] = ${lua(JSON.stringify(doc))},\n\t},\n}\n`);
    bridge.pollSavedVariables();
    assert.equal(bridge.status().companion.pendingRecap, true, 'waiting to see how the session ended');
    const before = sends(mock).length;
    bridge.onGame({ state: 'exited', pid: 4242 });
    const s = await waitFor(() => sends(mock)[before], LIVE, 'the recap turn');
    assert.equal(s.chatId, 'c0ffee0');
    assert.equal(s.turn.kind, 'recap');
    assert.deepEqual(s.turn.state, { ...doc, ended: 'quit' }, 'the recap\'s document rides with the turn');
    // Once per session: the same lastSession again sends nothing.
    fs.utimesSync(sv, new Date(), new Date(Date.now() + 5000));
    bridge.pollSavedVariables();
    bridge.onGame({ state: 'exited', pid: 4242 });
    await sleep(300);
    assert.equal(sends(mock).length, before + 1);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: the session recap after a logout (a hello with another sid); a /reload write with a later exit makes none', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const sv = path.join(env.tmp, 'NeverQuestAlone.lua');
  let clock = Date.now();
  const bridge = makeBridge(env, mock, { savedVariablesFile: sv, deps: { now: () => clock } });
  const doc = sid => ({ v: 1, kind: 'session', sid, char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren' },
    start: { t: 1790000000, level: 7, xp: 100, xpMax: 1200, money: 5000 }, end: { t: 1790003600, level: 7, xp: 900, xpMax: 1200, money: 6000 },
    xpGained: 800, moneyDelta: 1000, questsTurnedIn: 1, zones: ['Mulgore'], ended: 'unknown' });
  const lua = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  let bump = 0;
  const writeSv = d => { fs.writeFileSync(sv, `NQADB = {\n\t["token"] = "${TOKEN}",\n\t["companion"] = {\n\t\t["lastSession"] = ${lua(JSON.stringify(d))},\n\t},\n}\n`); const t = new Date(Date.now() + (++bump) * 1000); fs.utimesSync(sv, t, t); bridge.pollSavedVariables(); };
  const recaps = () => sends(mock).filter(s => s.turn.kind === 'recap');
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    // A /reload writes lastSession mid-session; the state after it keeps the sid: nothing.
    const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
    writeSv(doc(A));
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'a3f2', type: 'hello', chat: '', args: { cur: 0, ver: '1.2.0', ctx: 0, sid: A }, body: '' }));
    await sleep(200);
    assert.equal(recaps().length, 0, 'same sid after a reload: no recap');
    // A logout to the character list, then another character (a new sid).
    const later = { ...doc(A), end: { ...doc(A).end, t: 1790007200 } };
    writeSv(later);
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'a3f3', type: 'hello', chat: '', args: { cur: 0, ver: '1.2.0', ctx: 0, sid: B }, body: '' }));
    const r = await waitFor(() => recaps()[0], LIVE, 'logout recap');
    assert.equal(r.turn.state.ended, 'logout');
    assert.equal(r.turn.state.end.t, 1790007200, 'the latest write');
    // B's lastSession written at a /reload, then the game exits two minutes later (a crash): no recap.
    writeSv(doc(B));
    clock += 2 * 60 * 1000;
    bridge.onGame({ state: 'exited', pid: 7 });
    await sleep(200);
    assert.equal(recaps().length, 1, 'only if lastSession was written within 60 s of the exit');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (A2): a first visit\'s zone is game text: it rides in the event\'s args, sanitized, never as words of the turn', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0, sid: SID }));
    bridge.handlePayload(stateRec(1));
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'zone_first', agent: 'main', name: 'Companion', sid: SID, st: 1, zone: '/exec Durotar' }, body: '' }));
    const s = await waitFor(() => sends(mock).find(x => x.chatId === 'c0ffee0'), LIVE, 'the turn');
    assert.deepEqual(s.turn.event, { kind: 'zone_first', args: { sid: SID, zone: '/exec Durotar' } }, 'the zone rides as game text, sanitized (RT-11)');
    assert.equal(s.turn.typed, undefined, 'an event turn has no words of its own: the backend writes its fixed line');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

// The state deflated for the strip (cap z, PROTOCOL §2.6).
test('bridge v2 (cap z): a deflated state is kept as the exact JSON: the same state as sent plain; zlib, gzip and the reload path too; one that won\'t inflate, inflates too far or isn\'t a state is logged state-rejected, and the good one stays', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const sv = path.join(env.tmp, 'NeverQuestAlone.lua');
  const bridge = makeBridge(env, mock, { savedVariablesFile: sv });
  const zRec = (seq, body) => encodeRecord({ token: TOKEN, key: nonce, type: 'state', chat: '', args: { cur: 0, sid: SID, seq, z: 1 }, body });
  const turns = key => sends(mock).filter(x => x.chatId === key);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.3.1', ctx: 0, sid: SID }));
    await waitFor(() => (readSlot(env).bridge.caps || []).includes('z'), LIVE, 'cap z in the slot');
    const json = STATE(1);
    const body = deflateBody(json);
    assert.ok(body.length < Buffer.byteLength(json), `${body.length} of ${Buffer.byteLength(json)} bytes`);
    bridge.handlePayload(zRec(1, body));
    await waitFor(() => readSlot(env).bridge.stateSeq === 1, LIVE, 'the deflated state kept');
    // Its event turn: exactly the state a plain one gives.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'level_up', agent: 'main', name: 'Companion', sid: SID, from: 7, to: 8, st: 1 }, body: '' }));
    const s = await waitFor(() => turns('c0ffee0')[0], LIVE, 'the companion turn');
    assert.deepEqual(s.turn.state, sanitizeState(JSON.parse(json)), 'the state a plain one gives');
    // Refused: not deflate, a bomb, not a state once inflated, plain JSON marked z=1. No crash; state 1 stays.
    bridge.handlePayload(zRec(2, Buffer.from('not deflate at all').toString('base64')));
    bridge.handlePayload(zRec(3, zlib.deflateRawSync(Buffer.alloc(1 << 20)).toString('base64')));
    bridge.handlePayload(zRec(4, deflateBody('{"v":1,"sid":"nope","seq":4}')));
    bridge.handlePayload(zRec(5, STATE(5)));
    assert.deepEqual(bridge.logs.filter(l => l.kind === 'state-rejected').map(l => [l.reason, l.z]),
      [['z: not deflate', true], ['z: too large', true], ['sid', true], ['z: not base64', true]]);
    assert.equal(bridge.status().companion.stateSeq, 1, 'the good state stays');
    // zlib and gzip wrappers are read too, and a deflated state on the reload path.
    bridge.handlePayload(zRec(6, zlib.deflateSync(STATE(6)).toString('base64')));
    assert.equal(bridge.status().companion.stateSeq, 6);
    bridge.handlePayload(zRec(7, zlib.gzipSync(STATE(7)).toString('base64')));
    assert.equal(bridge.status().companion.stateSeq, 7);
    fs.writeFileSync(sv, `NQADB = {\n\t["outbox"] = {\n\t\t{\n\t\t\t["key"] = "${nonce}",\n\t\t\t["hex"] = "${Buffer.from(zRec(8, deflateBody(STATE(8)))).toString('hex')}",\n\t\t},\n\t},\n}\n`);
    bridge.pollSavedVariables();
    assert.equal(bridge.status().companion.stateSeq, 8, 'from SavedVariables');
    // A typed message naming it: the state a plain state 8 gives.
    bridge.handlePayload(rec('msg', { agent: 'main', name: 'Hyjal route', ctx: 0, q: 'followup', st: 8 }, { text: 'what next?' }));
    const m = await waitFor(() => turns(CHAT)[0], LIVE, 'the typed turn');
    assert.deepEqual(m.turn.state, sanitizeState(JSON.parse(STATE(8))));
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (cap z): transport.deflate false leaves z out of the caps, so the addon sends the state as JSON', () => {
  assert.deepEqual(makeBridge(setup(), null).buildSlot().bridge.caps, ['state', 'evt', 'think', 'z', 'ctx', 'qlog', 'voice']);
  const off = makeBridge(setup(), null, { config: { transport: { slots: 3, deflate: false } } });
  assert.deepEqual(off.buildSlot().bridge.caps, ['state', 'evt', 'think', 'ctx', 'qlog', 'voice']);
});

// The game context from the state (cap ctx, PROTOCOL §2.6).
const caseMsg = (chat, text, args = {}, extra = {}) => encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'msg', chat,
  args: { cur: 0, agent: 'main', name: 'Case', ctx: extra.context != null ? 1 : 0, q: 'followup', ...args }, text, ...extra });
const turnIn = (mock, chat) => sends(mock).find(x => x.chatId === chat);

test('bridge v2 (cap ctx): a message beside its state gets its context lines from the state and the stored context; one that carried its own, or names no state, goes as before; an event turn gets them from its state too', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.3.1', ctx: 1, sid: SID }, { body: CTX }));
    await waitFor(() => (readSlot(env).bridge.caps || []).includes('ctx'), LIVE, 'cap ctx in the slot');
    bridge.handlePayload(stateRec(1)); // level 8, Bloodhoof Village (49.6, 66.3), 1g 18s, 300/1400 XP, Mining 8/75, quest 748
    // Beside its state, without a context: the state's level, place, money, XP, professions and quests.
    bridge.handlePayload(caseMsg('c000001', 'where next?', { st: 1 }));
    // No state named (the companion off, or an older addon): the stored context, as before.
    bridge.handlePayload(caseMsg('c000002', 'and the bank?'));
    const [a, b] = await Promise.all([waitFor(() => turnIn(mock, 'c000001'), 3000, 'turn 1'), waitFor(() => turnIn(mock, 'c000002'), LIVE, 'turn 2')]);
    assert.deepEqual(ctxOf(a.turn).split('\n'), [
      'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)',
      'Character: Tavi on Testrealm, level 8 Tauren Warrior (Horde)',
      'Location: Mulgore - Bloodhoof Village',
      'Position: 49.6, 66.3 (map 1412)',
      'Money: 1g 18s 0c; XP: 300/1400',
      'Professions: Mining 8/75',
      'Quest log (id, * = ready to turn in): 1 of 40 quests, all listed: 748',
    ]);
    assert.equal(ctxOf(b.turn), CTX);
    // The bridge logs a send once the backend has answered it.
    const sentLog = chat => bridge.logs.find(l => l.kind === 'sent' && l.chat === chat);
    await waitFor(() => sentLog('c000001') && sentLog('c000002'), LIVE, 'both sends logged');
    assert.deepEqual([sentLog('c000001').ctxState, sentLog('c000002').ctxState], [true, undefined], 'the log says which came from the state');
    // A message that carried its own context goes with it, as before, and it becomes the stored one.
    const CTX2 = CTX.replace('level 6', 'level 8').replace('Red Cloud Mesa', 'Thunder Bluff').replace('44.1, 76.3', '38.2, 29.9');
    bridge.handlePayload(caseMsg('c000003', 'ok', { st: 1 }, { context: CTX2 }));
    assert.equal(ctxOf((await waitFor(() => turnIn(mock, 'c000003'), LIVE, 'turn 3')).turn), CTX2);
    // An event turn (no context of its own) gets it from the state it names, over the stored one.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'level_up', agent: 'main', name: 'Companion', sid: SID, from: 7, to: 8, st: 1 }, body: '' }));
    const e = await waitFor(() => turnIn(mock, 'c0ffee0'), LIVE, 'the event turn');
    assert.match(ctxOf(e.turn), /^Character: Tavi on Testrealm, level 8 Tauren Warrior \(Horde\)\nLocation: Mulgore - Bloodhoof Village\nPosition: 49\.6, 66\.3 \(map 1412\)$/m);
    // bare=1: none at all, as before.
    bridge.handlePayload(caseMsg('c000004', 'just words', { bare: 1 }));
    assert.equal(ctxOf((await waitFor(() => turnIn(mock, 'c000004'), LIVE, 'turn 4')).turn), null);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (cap ctx): without the state it names (not arrived in 2 s, another session\'s, too_large) a turn gets the stored context as before; with the context off, none', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  const OTHER = 'bbbbbbbbbbbbbbbb';
  const tooLarge = seq => encodeRecord({ token: TOKEN, key: nonce, type: 'state', chat: '', args: { cur: 0, sid: SID, seq }, body: JSON.stringify({ v: 1, sid: SID, seq, state: 'too_large' }) });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.3.1', ctx: 1, sid: SID }, { body: CTX }));
    bridge.handlePayload(tooLarge(1));
    bridge.handlePayload(caseMsg('c000011', 'too large?', { st: 1 }));
    bridge.handlePayload(caseMsg('c000012', 'never came', { st: 5 }));
    const [a, b] = await Promise.all([waitFor(() => turnIn(mock, 'c000011'), 3000, 'too_large turn'), waitFor(() => turnIn(mock, 'c000012'), LIVE, 'turn after the wait')]);
    for (const x of [a, b]) assert.equal(ctxOf(x.turn), CTX);
    // Another session says hello: the state the bridge has (SID's) isn't this turn's.
    bridge.handlePayload(stateRec(2));
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'b0b0', type: 'hello', chat: '', args: { cur: 0, ver: '1.3.1', ctx: 1, sid: OTHER }, body: CTX }));
    bridge.handlePayload(caseMsg('c000013', 'new character', { st: 2 }));
    assert.equal(ctxOf((await waitFor(() => turnIn(mock, 'c000013'), LIVE, 'other session turn')).turn), CTX);
    // The context off (a hello with ctx=0): no context lines, even with this session's state there.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'c0c0', type: 'hello', chat: '', args: { cur: 0, ver: '1.3.1', ctx: 0, sid: SID }, body: '' }));
    bridge.handlePayload(stateRec(3));
    bridge.handlePayload(caseMsg('c000014', 'context off', { st: 3 }));
    assert.equal(ctxOf((await waitFor(() => turnIn(mock, 'c000014'), LIVE, 'context-off turn')).turn), null);
    const sent = () => bridge.logs.filter(l => l.kind === 'sent');
    await waitFor(() => sent().length === 4, LIVE, 'the four sends logged');
    assert.ok(!sent().some(l => l.ctxState), 'none of these went through the state');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

// The whole quest log (cap qlog, PROTOCOL §2.6): Forever's cap, 40 quests, as the addon sends
// them (tests/fixtures/protocol-v2.json fullLogState), the last 1527 Call of Fire under Shaman.
const FULL_LOG = JSON.parse(fs.readFileSync(new URL('./fixtures/protocol-v2.json', import.meta.url), 'utf8')).fullLogState.json;

test('bridge v2 (cap qlog): a full 40-quest log, deflated, reaches the backend whole on each typed turn that names it and on an event turn; titles sent shortened come back whole; the quest log is logged once per change', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  const state = (seq, json) => encodeRecord({ token: TOKEN, key: nonce, type: 'state', chat: '', args: { cur: 0, sid: SID, seq, z: 1 }, body: deflateBody(json) });
  const turns = chat => sends(mock).filter(x => x.chatId === chat);
  const doc = JSON.parse(FULL_LOG);
  const ids = doc.quests.map(q => q.id);
  const titles = sanitizeState(doc).quests.map(q => q.title);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.5.4', ctx: 1, sid: SID }, { body: CTX }));
    await waitFor(() => (readSlot(env).bridge.caps || []).includes('qlog'), LIVE, 'cap qlog in the slot');
    assert.ok(Buffer.byteLength(FULL_LOG) > 2800, 'past what a bridge without qlog takes');
    bridge.handlePayload(state(1, FULL_LOG));
    await waitFor(() => readSlot(env).bridge.stateSeq === 1, LIVE, 'the full log kept');
    assert.deepEqual(bridge.logs.find(l => l.kind === 'quest-log'), { kind: 'quest-log', token: TOKEN, count: 40, max: 40, unread: 0, cut: 0 });
    // Typed turns that name it, the state unchanged on the second: every quest each time.
    for (const [i, text] of [[0, 'where do I turn in Call of Fire?'], [1, 'and after that?']]) {
      bridge.handlePayload(caseMsg('c00a001', text, { st: 1 }));
      const w = (await waitFor(() => turns('c00a001')[i], LIVE, `typed turn ${i + 1}`)).turn;
      assert.deepEqual(w.state.quests.map(q => q.id), ids, `every quest, turn ${i + 1}`);
      assert.deepEqual([w.state.quests.at(-1).title, w.state.quests.at(-1).complete], ['Call of Fire', true]);
      assert.deepEqual([w.state.questCount, w.state.questMax], [40, 40]);
    }
    // An event turn: the same list.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'level_up', agent: 'main', name: 'Companion', sid: SID, from: 19, to: 20, st: 1 }, body: '' }));
    const e = (await waitFor(() => turns('c0ffee0')[0], LIVE, 'event turn')).turn;
    assert.deepEqual(e.state.quests.map(q => q.id), ids);
    // A tighter state sends titles cut to 24 bytes: the bridge has them whole from state 1.
    const cut24 = (t) => { let out = ''; for (const ch of t) { if (Buffer.byteLength(out + ch) > 24) break; out += ch; } return out; };
    const cut = JSON.stringify({ ...doc, seq: 2, quests: doc.quests.map(q => (Buffer.byteLength(q.title) > 24 ? { ...q, title: cut24(q.title), cut: true } : q)),
      omitted: [...doc.omitted, 'quests.title.short'] });
    assert.ok(JSON.parse(cut).quests.some(q => q.cut), 'some titles went cut');
    bridge.handlePayload(state(2, cut));
    await waitFor(() => readSlot(env).bridge.stateSeq === 2, LIVE, 'state 2');
    bridge.handlePayload(caseMsg('c00a001', 'anything cut?', { st: 2 }));
    const m3 = (await waitFor(() => turns('c00a001')[2], LIVE, 'third typed turn')).turn;
    assert.deepEqual(m3.state.quests.map(q => q.title), titles, 'every title whole');
    assert.ok(m3.state.quests.every(q => !q.cut), 'none still cut');
    assert.equal(bridge.logs.filter(l => l.kind === 'quest-log').length, 1, 'the same counts: logged once');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

// The recap's end-of-session rules (companion F6), from the peer review of ac276c6.
async function recapHarness(fn) {
  const mock = await startRealBackend();
  const env = setup();
  const sv = path.join(env.tmp, 'NeverQuestAlone.lua');
  let clock = Date.now();
  const bridge = makeBridge(env, mock, { savedVariablesFile: sv, deps: { now: () => clock } });
  const doc = (sid, endT) => ({ v: 1, kind: 'session', sid, char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren' },
    start: { t: 1790000000, level: 7, xp: 100, xpMax: 1200, money: 5000 }, end: { t: endT, level: 7, xp: 900, xpMax: 1200, money: 6000 },
    xpGained: 800, moneyDelta: 1000, questsTurnedIn: 1, zones: ['Mulgore'], ended: 'unknown' });
  const lua = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  // SavedVariables written now (by the fake clock); outbox: reload-path records written with it.
  const writeSv = (d, { outbox = [], poll = true } = {}) => {
    const ob = outbox.length ? `\t["outbox"] = {\n${outbox.map(w => `\t\t{ ["key"] = "x", ["hex"] = "${Buffer.from(w, 'utf8').toString('hex')}" },`).join('\n')}\n\t},\n` : '';
    fs.writeFileSync(sv, `NQADB = {\n\t["token"] = "${TOKEN}",\n${ob}\t["companion"] = {\n\t\t["lastSession"] = ${lua(JSON.stringify(d))},\n\t},\n}\n`);
    fs.utimesSync(sv, new Date(clock), new Date(clock));
    if (poll) bridge.pollSavedVariables();
  };
  let nk = 0;
  const hello = sid => encodeRecord({ token: TOKEN, key: `b${String(++nk).padStart(3, '0')}`, type: 'hello', chat: '', args: { cur: 0, ver: '1.2.0', ctx: 0, sid }, body: '' });
  const recaps = () => sends(mock).filter(s => s.turn.kind === 'recap').map(s => s.turn.state);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    await fn({ bridge, doc, writeSv, hello, recaps, tick: ms => { clock += ms; }, poll: () => bridge.pollSavedVariables() });
  } finally {
    await bridge.stop();
    await mock.close();
  }
}
const [A, B, C] = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];

test('bridge v2 (F6): a /reload\'s lastSession makes no recap, even when the game later crashes and the next session says hello', async () => {
  await recapHarness(async ({ bridge, doc, writeSv, hello, recaps, tick }) => {
    bridge.handlePayload(hello(B));
    tick(10 * 60 * 1000);
    writeSv(doc(B, 1790000600)); // a /reload writes lastSession...
    tick(5000);
    bridge.handlePayload(hello(B)); // ...and the session goes on: its hello comes back
    assert.equal(bridge.status().companion.pendingRecap, false, 'the session went on: that write was a /reload');
    tick(50 * 60 * 1000);
    bridge.onGame({ state: 'exited', pid: 7 }); // a crash: no SavedVariables
    tick(24 * 60 * 60 * 1000);
    bridge.onGame({ state: 'launched', pid: 8 });
    bridge.handlePayload(hello(C));
    await sleep(300);
    assert.equal(recaps().length, 0, 'a /reload never makes a recap, and a crash leaves none');
  });
});

test('bridge v2 (F6): a /reload noticed after the session\'s next hello (either order) makes no recap; the real logout later does', async () => {
  await recapHarness(async ({ bridge, doc, writeSv, hello, recaps, tick, poll }) => {
    bridge.handlePayload(hello(B));
    tick(60 * 1000);
    writeSv(doc(B, 1790000060), { poll: false }); // the /reload's write, not polled yet
    tick(5000);
    bridge.handlePayload(hello(B)); // the hello after the reload lands first
    tick(1000);
    poll(); // then the poller sees the write: from before that hello
    assert.equal(bridge.status().companion.pendingRecap, false);
    tick(60 * 60 * 1000);
    writeSv(doc(B, 1790003660)); // the real logout
    assert.equal(bridge.status().companion.pendingRecap, true);
    tick(20 * 1000);
    bridge.onGame({ state: 'exited', pid: 7 });
    const r = await waitFor(() => recaps()[0], LIVE, 'the quit recap');
    assert.equal(r.ended, 'quit');
    assert.equal(r.end.t, 1790003660, 'the logout\'s totals, not the reload\'s');
  });
});

test('bridge v2 (F6): an old exit says nothing about a relaunched game: a /reload soon after is no "quit", and that session\'s real recap still goes', async () => {
  await recapHarness(async ({ bridge, doc, writeSv, hello, recaps, tick }) => {
    bridge.handlePayload(hello(A));
    writeSv(doc(A, 1790003600)); // a quit
    tick(3000);
    bridge.onGame({ state: 'exited', pid: 7 });
    await waitFor(() => recaps()[0], LIVE, 'recap A');
    tick(15 * 1000);
    bridge.onGame({ state: 'launched', pid: 8 }); // relaunched at once
    tick(20 * 1000);
    bridge.handlePayload(hello(C));
    tick(10 * 1000);
    writeSv(doc(C, 1790003700)); // a /reload 45 s after the old exit
    tick(5000);
    bridge.handlePayload(hello(C));
    await sleep(300);
    assert.deepEqual(recaps().map(r => `${r.sid.slice(0, 1)}:${r.ended}`), ['a:quit'], 'nothing for C while it\'s played');
    tick(30 * 60 * 1000);
    writeSv(doc(C, 1790005500)); // C logs out
    tick(1000);
    bridge.handlePayload(hello(B)); // another character: C's session ended
    await waitFor(() => recaps().length === 2, LIVE, 'recap C');
    assert.deepEqual(recaps().map(r => `${r.sid.slice(0, 1)}:${r.ended}`), ['a:quit', 'c:logout']);
  });
});

test('bridge v2 (F6): in reload mode the session\'s own records ride in the same SavedVariables write: a late poll still reads the logout right', async () => {
  await recapHarness(async ({ bridge, doc, writeSv, hello, recaps, tick, poll }) => {
    bridge.handlePayload(hello(B));
    tick(60 * 1000);
    // The logout writes lastSession with the session's hello and state in the outbox; the poll runs 5 s late.
    const st = encodeRecord({ token: TOKEN, key: 'b777', type: 'state', chat: '', args: { cur: 0, sid: B, seq: 4 }, body: JSON.stringify({ v: 1, sid: B, seq: 4, t: 1, omitted: [] }) });
    writeSv(doc(B, 1790000060), { outbox: [hello(B), st], poll: false });
    tick(5000);
    poll();
    assert.equal(bridge.status().companion.pendingRecap, true, 'records from the file are heard at its write time, not "after" it');
    tick(10 * 1000);
    bridge.onGame({ state: 'exited', pid: 7 });
    const r = await waitFor(() => recaps()[0], LIVE, 'the quit recap');
    assert.equal(r.ended, 'quit');
  });
});

test('bridge v2 (F6): an end read as 0 at logout (the 70009 client, an addon before the fix) goes to NeverQuestAlone as unknown, not as money lost, and the log says so', async () => {
  await recapHarness(async ({ bridge, doc, writeSv, hello, recaps, tick }) => {
    bridge.handlePayload(hello(A));
    const d = doc(A, 1790003600);
    writeSv({ ...d, end: { ...d.end, xp: 0, xpMax: 0, money: 0 }, moneyDelta: -5000 });
    tick(3000);
    bridge.onGame({ state: 'exited', pid: 7 });
    const r = await waitFor(() => recaps()[0], LIVE, 'the quit recap');
    assert.deepEqual([r.end, r.moneyDelta, r.xpGained, r.ended], [{ t: 1790003600, level: 7, xp: null, xpMax: null, money: null }, null, 800, 'quit']);
    assert.ok(bridge.logs.some(l => l.kind === 'recap' && l.sid === A && l.endUnknown === 'read as 0 at logout'));
  });
});

test('bridge v2 (F1): after a crash or relog, a turn never uses the last session\'s state: st= waits for this session\'s, and without it there\'s no block', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  const OLD = 'a1b2c3d4e5f60718', NEW = 'fedcba9876543210';
  // The production wait this test pins end to end: its last wait's budget (LIVE) bounds it only with this.
  assert.equal(STATE_WAIT_MS, 2000);
  const state = (sid, seq, name) => encodeRecord({ token: TOKEN, key: nonce, type: 'state', chat: '', args: { cur: 0, sid, seq }, body: JSON.stringify({ v: 1, sid, seq, t: 1, char: { name, realm: 'Testrealm', level: 8 }, quests: [], omitted: [] }) });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'c001', type: 'hello', chat: '', args: { cur: 0, ver: '1.2.0', ctx: 0, sid: OLD }, body: '' }));
    bridge.handlePayload(state(OLD, 6, 'Oldsession'));
    // The crash, the relaunch: a new session whose first state has the same seq.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'c002', type: 'hello', chat: '', args: { cur: 0, ver: '1.2.0', ctx: 0, sid: NEW }, body: '' }));
    await waitFor(() => readSlot(env).bridge.stateSid === OLD, LIVE, 'the slot says whose state it holds');
    const before = sends(mock).length;
    bridge.handlePayload(msg('where am I?', { cur: 0 }).replace(';q=followup', ';q=followup;st=6'));
    await sleep(500);
    assert.equal(sends(mock).length, before, 'seq 6 from the old session is not the state this message names');
    bridge.handlePayload(state(NEW, 6, 'Newsession'));
    const s = await waitFor(() => sends(mock)[before], LIVE, 'the turn');
    assert.equal(s.turn.state.char.name, 'Newsession', 'this session\'s state, not the last one\'s');
    await waitFor(() => readSlot(env).bridge.stateSid === NEW, LIVE, 'stateSid follows');
    // With no state from this session at all, a turn goes without a block rather than with the old one.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'c003', type: 'hello', chat: '', args: { cur: 0, ver: '1.2.0', ctx: 0, sid: OLD.replace('a1', 'b2') }, body: '' }));
    bridge.handlePayload(msg('and now?', { st: 6 }));
    const s2 = await waitFor(() => sends(mock)[before + 1], LIVE, 'the second turn, after the wait');
    assert.equal('state' in s2.turn, false, 'no state');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

// A stand-in backend, for timing the tests control: ready at start; send records the core's send
// ({chatId, idem, turn, thinking}) and answers onSend's (started, by default); outcomes() records what
// the core asked and answers outcome's for each run (running, by default); event() is one of its events.
function fakeGateway({ onSend = null, outcome = null, ready = true } = {}) {
  const g = { sent: [], asked: [], aborts: [], handlers: null, bridge: null };
  g.factory = (handlers) => {
    g.handlers = handlers;
    return {
      kind: 'byok',
      persona: 'NeverQuestAlone',
      start() { if (ready) g.up(); },
      stop() {},
      send: (args) => { g.sent.push(args); return onSend?.(args) ?? { runId: args.idem, status: 'started' }; },
      abort: (chatId) => { g.aborts.push(chatId); return { aborted: false }; },
      forget: () => ({ ok: true }),
      outcomes: (ids) => { g.asked.push([...ids]); return ids.map(runId => outcome?.(runId) ?? { runId, state: 'running' }); },
    };
  };
  // What the backend does once it's ready at start.
  g.up = () => { g.handlers.onState({ state: 'ready', since: Date.now() }); g.handlers.onReady(); };
  g.event = (event, payload) => g.handlers.onEvent({ event, payload });
  return g;
}
// One the test brings up itself (g.up()).
const manualGateway = opts => fakeGateway({ ...opts, ready: false });
const standIn = (env, g, deps = {}) => {
  const bridge = createBridge({ transport: { slots: 3 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 5, progressMs: 0 }, gatewayFactory: g.factory, ...deps });
  g.bridge = bridge;
  return bridge;
};
// A message to CHAT, sent and in flight: its runId.
async function ask(bridge, text) {
  bridge.handlePayload(msg(text));
  const runId = `nqa:${TOKEN}:${nonce}_${n}`;
  await waitFor(() => bridge.store.state.inflight[runId], LIVE, `"${text}" in flight`);
  return runId;
}
// A run's live chat final, as the backend sends it: the reply with its row's id and seq.
let finalSeq = 1000;
const replyRow = (text, seq = ++finalSeq) => ({ role: 'assistant', content: [{ type: 'text', text }], __nqa: { id: `byok:${CHAT}:${seq}`, seq } });
const liveFinal = (g, runId, text, message = replyRow(text)) => g.event('chat', { runId, chatId: CHAT, state: 'final', message });

test('bridge v2 (F1, F3): an event held while a send\'s run goes rides with the next typed turn, with the state that came meanwhile; the send made before it never carried it (code health BR-22: a send is composed and made at once)', async () => {
  const env = setup();
  // The runaway fuse at one automatic turn an hour: of two events after the first send, the
  // second is held (a typed message resets the fuse, so it's counted from the first send on).
  const g = fakeGateway();
  const bridge = createBridge({ transport: { slots: 3 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 5, progressMs: 0 },
    autoFuse: { turns: 1, windowMs: 3_600_000 },
    gatewayFactory: g.factory,
  });
  const typed = () => g.sent.filter(p => p.chatId === CHAT);
  const zone = () => encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'zone_first', agent: 'main', name: 'Companion', sid: SID }, body: '' });
  try {
    bridge.start();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0, sid: SID }));
    bridge.handlePayload(stateRec(1));
    bridge.handlePayload(msg('first', { st: 1 }));
    await waitFor(() => typed().length === 1, LIVE, 'the first send');
    assert.equal(typed()[0].turn.state.seq, 1);
    assert.equal(typed()[0].turn.notes, undefined);
    // While its run goes (no word of it yet): a newer state, an event that takes its turn, and one the fuse holds.
    bridge.handlePayload(stateRec(2));
    bridge.handlePayload(zone());
    bridge.handlePayload(zone());
    await waitFor(() => bridge.store.records.some(r => r.kind === 'auto_paused'), LIVE, 'the second event held');
    bridge.handlePayload(msg('second', { st: 2 }));
    await waitFor(() => typed().length === 2, LIVE, 'the second send');
    assert.equal(typed()[1].turn.state.seq, 2, 'the state that came since the first send');
    assert.deepEqual(typed()[1].turn.notes, ['Held while automatic help was paused: First visit to a zone'], 'the held event rides now');
    bridge.handlePayload(msg('third', { st: 2 }));
    await waitFor(() => typed().length === 3, LIVE, 'the third send');
    assert.equal(typed()[2].turn.notes, undefined, 'once');
  } finally {
    await bridge.stop();
  }
});

test('bridge v2 (code health BR-22): a followup the backend holds in its queue keeps the chat busy through the safety net\'s checks (outcomes() says running), until the backend says what became of it', async () => {
  const env = setup();
  let queued = true;
  const g = fakeGateway({ outcome: runId => (queued ? { runId, state: 'running' } : { runId, chatId: CHAT, state: 'done', message: replyRow('There now.') }) });
  const bridge = createBridge({ transport: { slots: 3 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 5, progressMs: 0 },
    runCheckMs: 50, runCheckEveryMs: 20,
    gatewayFactory: g.factory,
  });
  try {
    bridge.start();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    bridge.handlePayload(msg('queued behind another lane'));
    await waitFor(() => bridge.status().inflight === 1, LIVE, 'sent');
    await waitFor(() => g.asked.length >= 2, LIVE, 'several checks');
    assert.equal(bridge.status().inflight, 1, 'still waiting for the queued run');
    assert.equal(bridge.buildSlot().chats.find(c => c.id === CHAT)?.busy, true, 'and its chat busy');
    queued = false;
    await waitFor(() => bridge.status().inflight === 0, LIVE, 'over');
    assert.deepEqual(bridge.store.records.filter(r => r.t === 'reply').map(r => r.text), ['There now.'], 'its reply, once');
    assert.equal(bridge.buildSlot().chats.find(c => c.id === CHAT)?.busy, false);
  } finally {
    await bridge.stop();
  }
});

test('bridge v2: level-ups and the day\'s count survive a bridge restart; the count resets at local midnight (no daily cap)', async () => {
  const mock = await startRealBackend();
  const env = setup();
  let clock = new Date(2026, 8, 25, 23, 59, 0).getTime();
  const opts = { deps: { now: () => clock } };
  const evt = (key, kind, args) => encodeRecord({ token: TOKEN, key, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind, agent: 'main', name: 'Companion', sid: SID, ...args }, body: '' });
  const turns = () => sends(mock).filter(s => s.chatId === 'c0ffee0').length;
  let a = makeBridge(env, mock, opts);
  try {
    a.start();
    await waitFor(() => a.status().gateway.state === 'ready', LIVE, 'backend ready');
    a.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    a.handlePayload(evt('a3f1_901', 'level_up', { from: 9, to: 10 }));
    // Sent and answered, so the next bridge has nothing of it to send again.
    await waitFor(() => turns() === 1 && a.status().outbox === 0, LIVE, 'level 10 turn');
    await a.stop();
    a = makeBridge(env, mock, opts);
    a.start();
    await waitFor(() => a.status().gateway.state === 'ready', LIVE, 'backend ready again');
    // A resend under a new key (a crash rolled the saved data back): still no second turn for the
    // level; another event takes its turn (there's no daily cap), and the day's count goes on.
    a.handlePayload(evt('b4e2_901', 'level_up', { from: 9, to: 10 }));
    a.handlePayload(evt('b4e2_902', 'route_done', { layer: 'mulgore' }));
    await waitFor(() => turns() === 2, LIVE, 'the route turn');
    await sleep(200);
    assert.equal(turns(), 2, 'level already turned');
    assert.equal(a.status().companion.today, 2, 'the day\'s count came back from companion-events.json');
    clock += 2 * 60 * 1000; // past local midnight
    a.handlePayload(evt('b4e2_903', 'route_done', { layer: 'mulgore' }));
    await waitFor(() => turns() === 3, LIVE, 'a new day, a new turn');
    assert.equal(a.status().companion.today, 1, 'the count starts over at midnight');
  } finally {
    await a.stop();
    await mock.close();
  }
});

test('bridge v2 (UI v2): a reply\'s wowchips, wowrefs and wowweights reach the slot as chips, refs and weights, and leave its text', async () => {
  const text = 'The forge is east.\n```wowchips\nRoute me there\nThanks\n```\n```wowrefs\n{"q":[766],"i":[4804]}\n```\n```wowweights\n{"str":1,"sta":0.5}\n```\n\nTL;DR: Forge east.';
  const mock = await startRealBackend({ respond: () => ({ text }) });
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.3.0', ctx: 0 }));
    bridge.handlePayload(msg('where is the forge'));
    const slot = await waitFor(() => { const d = readSlot(env); return d.records.some(r => r.t === 'reply') ? d : null; }, LIVE, 'the reply');
    const reply = slot.records.find(r => r.t === 'reply');
    assert.match(reply.text, /^The forge is east\./);
    assert.doesNotMatch(reply.text, /wowchips|wowrefs|wowweights|4804/);
    assert.equal(reply.summary, 'Forge east.');
    assert.deepEqual(list(reply.chips), ['Route me there', 'Thanks']);
    assert.deepEqual(list(reply.refs.q), [766]);
    assert.deepEqual(list(reply.refs.i), [4804]);
    assert.deepEqual({ ...reply.weights }, { str: 1, sta: 0.5 });
    assert.ok(bridge.logs.some(l => l.kind === 'reply' && l.chips === 2 && l.refs === true && l.weights === true));
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: a reply\'s wowmap routes reach the slot as its record\'s drew (the layers on the map after it, in its order), for the game\'s Okay to follow; a reply that draws nothing carries none', async () => {
  const route = '{"op":"set","layer":"loop","title":"Loop","ordered":true,"points":[{"m":1413,"x":50,"y":40,"label":"1. Oasis","kind":"object"},{"m":1413,"x":42,"y":30,"label":"2. Prowlers","kind":"kill"}]}';
  const pin = '{"op":"set","layer":"kreenig","title":"Kreenig","points":[{"m":1413,"x":58.5,"y":27,"label":"Kreenig","kind":"kill"}]}';
  let turn = 0;
  const mock = await startRealBackend({ respond: () => (++turn === 1
    ? { text: `A loop, and Kreenig marked.\n\`\`\`wowmap\n${route}\n${pin}\n{"op":"set","layer":"gone","points":[{"m":1413,"x":1,"y":1,"label":"x","kind":"poi"}]}\n{"op":"clear","layer":"gone"}\n\`\`\`\n\nTL;DR: Drew a loop.` }
    : { text: 'Nothing to draw.\n\nTL;DR: Nothing.' }) });
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.4.7', ctx: 0 }));
    bridge.handlePayload(msg('route me'));
    const slot = await waitFor(() => { const d = readSlot(env); return d.records.some(r => r.t === 'reply') ? d : null; }, LIVE, 'the reply');
    const reply = slot.records.find(r => r.t === 'reply');
    assert.deepEqual(list(reply.drew), ['loop', 'kreenig'], 'the route and the pin; the layer it cleared again is not');
    assert.doesNotMatch(reply.text, /wowmap/);
    assert.ok(bridge.logs.some(l => l.kind === 'reply' && l.map === true && Array.isArray(l.drew) && l.drew.join() === 'loop,kreenig'));
    bridge.handlePayload(msg('and now?'));
    const second = await waitFor(() => { const d = readSlot(env); const r = d.records.filter(x => x.t === 'reply'); return r.length === 2 ? r[1] : null; }, LIVE, 'the second reply');
    assert.equal(second.drew, undefined);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (UI v2): "leave it out once" (bare=1) sends the words alone, with no game context, no state and no data block; the next message has them', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.3.0', ctx: 1 }, { body: CTX }));
    bridge.handlePayload(stateRec(1));
    await waitFor(() => bridge.status().companion.stateSeq === 1, LIVE, 'state 1');
    bridge.handlePayload(rec('msg', { agent: 'main', name: 'Hyjal route', ctx: 0, q: 'followup', bare: 1 }, { text: 'no context please' }));
    const s1 = await waitFor(() => sends(mock)[0], LIVE, 'the bare send');
    assert.equal(s1.turn.typed, 'no context please', 'the words alone');
    assert.equal(ctxOf(s1.turn), null, 'no game context, although the bridge knows it');
    assert.equal('state' in s1.turn, false, 'and no state');
    bridge.handlePayload(msg('now with it', { st: 1 }));
    const s2 = await waitFor(() => sends(mock)[1], LIVE, 'the next send');
    assert.match(ctxOf(s2.turn), /Location: Mulgore - Bloodhoof Village/, 'from the state it names');
    assert.equal(s2.turn.state.char.name, 'Tavi');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (UI v2, code health BR-22 r2): a reply whose final never reached the core is published from outcomes() at the next start, byok-chats.json lost or not: by its run, once, and new although its words match one shown', async () => {
  let turn = 0, drop = false;
  const mock = await startRealBackend({ respond: () => { turn++; return { text: `Done.\n\`\`\`wowchips\n${turn === 1 ? 'Next stop' : 'Train first'}\n\`\`\`` }; } });
  const env = setup();
  let bridge = makeBridge(env, mock, { dropEvent: e => drop && e.event === 'chat' && e.payload?.state === 'final' });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.3.0', ctx: 0 }));
    bridge.handlePayload(msg('one'));
    await waitFor(() => readSlot(env).records.filter(r => r.t === 'reply').length === 1, LIVE, 'the first reply, live');
    drop = true; // the second run's final never reaches the core (the bridge dies between the backend's reply and its publish)
    bridge.handlePayload(msg('two'));
    const second = await waitFor(() => sends(mock)[1], LIVE, 'the second send');
    await within(mock.runEnded(second.idem), LIVE, 'the second run over');
    await bridge.stop();
    // byok-chats.json is lost too: outcomes() finds the reply by the ledger's replyT and its row's run.
    mock.loseSideFile();
    bridge = makeBridge(env, mock);
    bridge.start();
    await waitFor(() => bridge.status().inflight === 0, LIVE, 'the start asked what became of the run');
    bridge.publisher.flushNow();
    assert.deepEqual(readSlot(env).records.filter(x => x.t === 'reply').map(r => list(r.chips)), [['Next stop'], ['Train first']], 'the second reply, from outcomes()');
    assert.ok(bridge.logs.some(l => l.kind === 'outcomes' && l.why === 'start' && l.done === 1), 'by the start');
    bridge.checkRuns(true); // nothing in flight: nothing asked, nothing more shown
    bridge.publisher.flushNow();
    assert.equal(readSlot(env).records.filter(r => r.t === 'reply').length, 2, 'each shown once');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: sends wait in the outbox while the backend has no key, and go exactly once when one is added (SE-3)', async () => {
  const mock = await startRealBackend({ noKey: true });
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('queued with no key'));
    await sleep(300);
    assert.equal(bridge.store.outbox.length, 1, 'kept in the outbox');
    assert.equal(readSlot(env).gw.state, 'no_key');
    assert.equal(readSlot(env).gw.queued, 1);
    // A message taken but not yet sent makes its chat busy in the slot: an addon that
    // read "acked and idle" here took the question as answered (the HUD said Ready).
    assert.equal(readSlot(env).chats.find(c => c.id === CHAT)?.busy, true, 'busy while it waits');
    assert.equal(sends(mock).length, 0, 'nothing sent');
    await mock.addKey(); // the player adds a key in the app: the backend is ready, and the core resumes
    await waitFor(() => sends(mock).length === 1, LIVE, 'sent once the key is there');
    await waitFor(() => readSlot(env).records.length === 1, LIVE, 'the reply');
    await sleep(200);
    assert.equal(sends(mock).length, 1, 'exactly once');
    assert.equal(bridge.store.outbox.length, 0);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (code health BR-22 r2): outcomes() publishing a reply just before its live final is handled doesn\'t publish it twice', async () => {
  // The final's delivery to the core is held with the run over in the ledger: the safety net's check
  // lands in between however loaded the machine is.
  let release;
  const released = new Promise(r => { release = r; });
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock, { holdEvent: e => (e.event === 'chat' && e.payload?.state === 'final' ? released : undefined) });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('first'));
    const s = await waitFor(() => sends(mock)[0], LIVE, 'the send');
    await within(mock.runEnded(s.idem), LIVE, 'the turn over, its final held');
    assert.equal(bridge.status().inflight, 1, 'the core still has the run');
    bridge.checkRuns(true); // the safety net, before the final is handled
    await waitFor(() => readSlot(env).records.some(r => r.t === 'reply'), LIVE, 'published from outcomes()');
    release();
    await settle(bridge);
    assert.equal(readSlot(env).records.filter(r => r.t === 'reply').length, 1, 'the live final was not published again');
  } finally {
    release();
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (code health BR-22): a chat\'s turns go in order, one at a time: a quick second message is handed to the backend at once, after the first, and runs once the first is through; the chat is busy meanwhile', async () => {
  const mock = await startRealBackend({ respond: ({ typed }) => ({ text: `re: ${typed}` }) });
  const running = mock.holdAt('start');
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('one'));
    await within(running.reached, LIVE, 'the first turn at the AI');
    bridge.handlePayload(msg('two')); // while the first is being answered
    assert.deepEqual(sends(mock).map(s => s.turn.typed), ['one', 'two'], 'both handed over, in order, at once');
    await sleep(200);
    assert.equal(mock.calls().length, 1, 'the second waits in the backend\'s queue: one run per chat');
    await waitFor(() => readSlot(env).chats.find(c => c.id === CHAT)?.busy === true, LIVE, 'busy meanwhile');
    running.release();
    await waitFor(() => readSlot(env).records.filter(r => r.t === 'reply').length === 2, LIVE, 'both replies');
    assert.deepEqual(readSlot(env).records.filter(r => r.t === 'reply').map(r => r.text), ['re: one', 're: two'], 'in order');
  } finally {
    running.release();
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (code health BR-22 r2): a reply that says what an earlier run said is still new: outcomes() finding it after its final was lost shows it; finding one before its live final is handled shows it once', async () => {
  const done = new Map();
  const g = manualGateway({ outcome: runId => (done.has(runId) ? { runId, chatId: CHAT, state: 'done', message: done.get(runId) } : { runId, state: 'running' }) });
  const env = setup();
  const bridge = standIn(env, g);
  const replies = () => { bridge.publisher.flushNow(); return readSlot(env).records.filter(r => r.t === 'reply').map(r => r.text); };
  try {
    bridge.start();
    g.up();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    const first = await ask(bridge, 'first');
    liveFinal(g, first, 'Okay.');
    assert.deepEqual(replies(), ['Okay.']);
    // The second run answers the same words, and its live final is lost: the safety net shows it.
    const second = await ask(bridge, 'second');
    done.set(second, replyRow('Okay.'));
    bridge.checkRuns(true);
    assert.deepEqual(replies(), ['Okay.', 'Okay.'], 'the second reply, from outcomes()');
    assert.equal(bridge.status().inflight, 0, 'both runs over');
    // The third's reply is found before its live final is handled.
    const third = await ask(bridge, 'third');
    const row = replyRow('Okay.');
    done.set(third, row);
    bridge.checkRuns(true);
    assert.deepEqual(replies(), ['Okay.', 'Okay.', 'Okay.'], 'shown from outcomes()');
    liveFinal(g, third, 'Okay.', row);
    assert.deepEqual(replies(), ['Okay.', 'Okay.', 'Okay.'], 'its live final is the reply already shown: once');
  } finally {
    await bridge.stop();
  }
});

test('bridge v2 (code health BR-22): after the whole state folder is lost, a chat\'s old replies are never shown again: the core reads no history, and outcomes() speaks of its own runs only', async () => {
  const mock = await startRealBackend({ respond: ({ typed }) => ({ text: `Reply to ${typed}.` }) });
  const env = setup();
  let bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    bridge.handlePayload(msg('old 1'));
    bridge.handlePayload(msg('old 2'));
    await waitFor(() => readSlot(env).records.filter(r => r.t === 'reply').length === 2, LIVE, 'the old replies');
    await bridge.stop();
    fs.rmSync(env.state, { recursive: true, force: true }); // the core's store lost; the backend's transcripts kept
    const queued = mock.holdAt('queued');
    bridge = makeBridge(env, mock);
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0, cur: 500 }));
    bridge.handlePayload(msg('new question'));
    await within(queued.reached, LIVE, 'its turn waiting to start');
    bridge.checkRuns(true); // what the safety net does
    assert.deepEqual(bridge.store.records.filter(r => r.t === 'reply').map(r => r.text), [], 'none of the old replies');
    queued.release();
    await waitFor(() => bridge.store.records.some(r => r.t === 'reply'), LIVE, 'the new reply');
    assert.deepEqual(bridge.store.records.filter(r => r.t === 'reply').map(r => r.text), ['Reply to new question.']);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: a bridge whose state was reset (state.json lost or new) still reaches the addon: its records go above the cursor the addon reports, its pushes above the counter it read', async () => {
  // The real addon applied records up to 500 and read push 50 (the old bridge's last inbox);
  // this bridge starts from nothing. Its strip goes to the bridge, the bridge's slot file to its loads.
  const vm = newAddonVM({
    db: `NQADB = { token = "${TOKEN}", sendCounter = 0, cursor = 500, reported = 500, chats = { { id = "${CHAT}", name = "Hyjal route", agent = "main", history = {}, pending = {}, unread = 0 } }, activeChat = "${CHAT}" }`,
    inbox: `NQA_Inbox = { v = 2, now = time(), token = "${TOKEN}", bridge = { ver = "1.4.6", push = 50, acked = {} }, records = {}, chats = {} }`,
  }).login();
  const env = setup();
  // stateWaitMs 0: after a reset the bridge doesn't have the game state a message names, and
  // needn't spend its 2 s waiting for it here.
  let g = manualGateway();
  let bridge = standIn(env, g, { stateWaitMs: 0 });
  // A push ring: the addon loads what the bridge just published (the slot table, whichever
  // slot file it loads next); what it draws goes to the bridge.
  const ringAddon = () => {
    bridge.publisher.flushNow();
    vm.slotText(slotTable('NQA_SlotData', bridge.buildSlot()).text);
    vm.advance(1.6); // its last load is 1.5 s old
    vm.signal('ctl', 'bell_push_a', false).run('NS.Transport.Poll()');
    vm.signal('ctl', 'bell_push_a', true).run('NS.Transport.Poll()');
    if (vm.strip()) bridge.handlePayload(vm.strip().payload);
  };
  // A message from the game, answered: the addon's strip goes to the bridge, the reply comes back at a ring.
  const exchange = async (text, answer) => {
    vm.send(text);
    bridge.handlePayload(vm.strip().payload);
    await waitFor(() => Object.keys(bridge.store.state.inflight).length === 1, LIVE, `"${text}" sent`);
    ringAddon(); // the ack
    liveFinal(g, Object.keys(bridge.store.state.inflight)[0], answer);
    ringAddon();
    const last = vm.lastHistory();
    return last && [last.role, last.text];
  };
  try {
    bridge.start();
    await g.up();
    vm.advance(3.1);
    assert.match(vm.strip().payload, /\x1fhello\x1f\x1fcur=500;.*;p=50[;\x1f]/, 'the hello says what it has');
    bridge.handlePayload(vm.strip().payload);
    ringAddon();
    assert.equal(vm.bool('NS.R.helloAnswered'), true);
    assert.deepEqual(await exchange('still there?', 'Still here.'), ['assistant', 'Still here.'], 'the reply is shown');
    assert.ok(vm.num('NQADB.cursor') > 500, 'applied past the old cursor');
    assert.equal(vm.num('NS.R.push.known'), bridge.status().push, 'the push counter goes on from the one the addon read');
    assert.ok(bridge.status().push > 50);
    // The bridge starts from nothing again while the game runs on: no hello this time. The next
    // message carries the cursor; the ring for its ack has a counter below the addon's, so the
    // addon's seen says its own, and the bridge counts on from that.
    vm.advance(6); // its last seen has been up its few seconds: counted as told
    const cursor = vm.num('NQADB.cursor'), known = vm.num('NS.R.push.known');
    assert.equal(vm.num('NS.R.push.reported'), known);
    await bridge.stop();
    fs.rmSync(env.state, { recursive: true, force: true });
    g = manualGateway();
    bridge = standIn(env, g, { stateWaitMs: 0 });
    bridge.start();
    await g.up();
    assert.deepEqual(await exchange('and now?', 'Back again.'), ['assistant', 'Back again.'], 'the reply is shown');
    assert.ok(vm.num('NQADB.cursor') > cursor);
    assert.ok(bridge.status().push > known);
    assert.equal(vm.num('NS.R.push.known'), bridge.status().push, 'and the push counter goes on');
  } finally {
    await bridge.stop();
  }
});

test('bridge v2: a state.json lost with records.json kept: the next record is numbered after every record kept, so no two share a seq', async () => {
  const env = setup();
  fs.mkdirSync(env.state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(env.state, 'records.json'), JSON.stringify([6, 7].map(seq => ({ seq, t: 'reply', chat: CHAT, text: `kept ${seq}` }))) + '\n', { mode: 0o600 });
  const g = manualGateway();
  const bridge = standIn(env, g);
  try {
    bridge.start();
    await g.up();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0, cur: 5 })); // the addon applied up to 5
    const run = await ask(bridge, 'first after the reset');
    liveFinal(g, run, 'Here.');
    const seqs = bridge.store.records.map(r => r.seq);
    assert.equal(new Set(seqs).size, seqs.length, `no seq given twice: ${seqs}`);
    assert.ok(seqs.at(-1) > 7, `the reply's seq (${seqs.at(-1)}) is past every kept record`);
    // A cursor or push counter past what the addon can write (%d, 32 bits on Windows) moves nothing.
    const before = [bridge.store.state.seq, bridge.store.state.push];
    bridge.handlePayload(rec('seen', { cur: 2 ** 40, p: 2 ** 40 }));
    assert.deepEqual([bridge.store.state.seq, bridge.store.state.push], before);
  } finally {
    await bridge.stop();
  }
});

test('bridge v2 (code health BR-22): the safety net waits out the backend\'s run limit before it asks about a quiet run', () => {
  assert.equal(RUN_CHECK_MS, RUN_MS, 'one 3-minute limit: a run past it is over in the backend, one way or another');
  assert.equal(RUN_MS, 180_000);
});

test('bridge v2 (code health BR-22): a run whose live final never arrives is published by the safety net once it has been quiet the run limit (outcomes()); with nothing in flight, nothing is asked', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock, { deps: { runCheckMs: 600, runCheckEveryMs: 100 },
    dropEvent: e => e.event === 'chat' && e.payload?.state === 'final' });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('first'));
    const slot = await waitFor(() => { const d = readSlot(env); return d.records.length ? d : null; }, LIVE, 'reply from the safety net');
    assert.equal(slot.records.filter(r => r.t === 'reply').length, 1);
    assert.ok(bridge.logs.some(l => l.kind === 'outcomes' && l.why === 'quiet' && l.done === 1));
    await waitFor(() => bridge.status().inflight === 0, LIVE, 'run cleared');
    const asked = bridge.logs.filter(l => l.kind === 'outcomes').length;
    await sleep(900);
    assert.equal(bridge.logs.filter(l => l.kind === 'outcomes').length, asked, 'nothing in flight: nothing asked');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

// Code health BR-22 r1: what a crash between the backend's done and the core's publish leaves, as the
// next start finds it. caseOf(edit): one turn whose final the core never hears, the bridge stopped, the
// backend's files edited as the case leaves them, a new bridge started on them.
async function crashCase(edit) {
  const mock = await startRealBackend();
  const env = setup();
  let bridge = makeBridge(env, mock, { dropEvent: e => e.event === 'chat' && e.payload?.state === 'final' });
  bridge.start();
  await waitFor(() => bridge.status().gateway.state === 'ready');
  bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
  bridge.handlePayload(msg('remember this'));
  const run = (await waitFor(() => sends(mock)[0], LIVE, 'the send')).idem;
  await within(mock.runEnded(run), LIVE, 'the turn done');
  await bridge.stop();
  const ledgerFile = path.join(mock.dataDir, 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const rowsFile = path.join(mock.dataDir, 'transcripts', `${CHAT}.jsonl`);
  const rows = fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const replyUsage = rows.at(-1).usage;
  // Every day's booked spend, as the usage history keeps it on disk.
  const spent = () => Object.values(JSON.parse(fs.readFileSync(path.join(mock.dataDir, 'usage-history.json'), 'utf8')).days).reduce((n, d) => n + d.micros, 0);
  const before = spent();
  edit({ entry: ledger.entries[run], rows });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  fs.writeFileSync(rowsFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  bridge = makeBridge(env, mock);
  bridge.start();
  await waitFor(() => bridge.status().inflight === 0, LIVE, 'the start asked what became of the run');
  bridge.publisher.flushNow();
  return { mock, bridge, env, run, replyUsage, spentBefore: before, spentAfter: spent() };
}

test('bridge v2 (code health BR-22 r1): a crash between the backend\'s done and the core\'s publish: the next start publishes the reply once, with its cost; with the crash before the done (its rows written, the ledger still sending) too, booked once', async () => {
  for (const how of ['after the done', 'before the done']) {
    const c = await crashCase(({ entry }) => {
      if (how === 'after the done') return;
      entry.state = 'sending';
      for (const k of ['replyT', 'inTokens', 'outTokens', 'exact', 'outMicros', 'requestId']) delete entry.extra[k];
    });
    try {
      const replies = c.bridge.store.records.filter(r => r.t === 'reply');
      assert.deepEqual(replies.map(r => [r.text, r.usage]), [['OK', c.replyUsage]], `${how}: published once, with its cost`);
      assert.equal(c.bridge.store.records.filter(r => r.t === 'error').length, 0, `${how}: no interrupted line`);
      assert.equal(c.spentAfter, c.spentBefore, `${how}: booked once, with the reply`);
      assert.ok(c.bridge.logs.some(l => l.kind === 'outcomes' && l.why === 'start' && l.done === 1));
      assert.equal(c.mock.calls().length, 1, `${how}: never sent again`);
      assert.equal(readSlot(c.env).chats.find(x => x.id === CHAT)?.busy, false);
    } finally { await c.bridge.stop(); await c.mock.close(); }
  }
});

test('bridge v2 (code health BR-22 r1, the documented gap): a done entry an older build wrote (no replyT) whose rows name no run: the next start ends the run with nothing shown and no line; the reply stays in the transcript', async () => {
  const c = await crashCase(({ entry, rows }) => {
    for (const k of ['replyT', 'inTokens', 'outTokens', 'exact']) delete entry.extra[k];
    for (const r of rows) { delete r.run; delete r.usage; }
  });
  try {
    assert.equal(c.bridge.store.records.filter(r => r.t === 'reply' || r.t === 'error').length, 0, 'nothing shown, no line');
    assert.equal(c.bridge.status().inflight, 0, 'the run is over');
    assert.equal(readSlot(c.env).chats.find(x => x.id === CHAT)?.busy, false, 'the chat idle');
    assert.equal(c.spentAfter, c.spentBefore, 'nothing booked again');
    assert.equal(c.mock.rows(CHAT).at(-1).text, 'OK', 'the reply is still in the transcript (its next turns see it)');
  } finally { await c.bridge.stop(); await c.mock.close(); }
});

test('bridge v2: a bridge killed mid-run: its turn comes back interrupted with Send again, once, and is never sent again (RV-1, DB20)', async () => {
  // The run is held while its reply is on its way; the bridge, and its backend with it, stop there.
  const mock = await startRealBackend();
  const running = mock.holdAt('start');
  const env = setup();
  const a = makeBridge(env, mock);
  a.start();
  await waitFor(() => a.status().gateway.state === 'ready');
  a.handlePayload(rec('hello', { ver: '1.1.0', ctx: 1 }, { body: CTX }));
  a.handlePayload(msg('what zone am I in?'));
  const { runId } = await within(running.reached, LIVE, 'the run going');
  await waitFor(() => a.status().inflight === 1, LIVE, 'the bridge has the run');
  await a.stop(); // killed mid-run
  const b = makeBridge(env, mock);
  try {
    b.start();
    const e = await waitFor(() => readSlot(env).records.find(r => r.t === 'error'), LIVE, 'the interrupted line');
    assert.equal(e.chat, CHAT);
    assert.equal(e.kind, 'interrupted');
    assert.equal(e.action, 'send_again');
    assert.equal(e.text, 'NeverQuestAlone restarted before NeverQuestAlone answered.');
    await waitFor(() => b.status().inflight === 0, LIVE, 'no run left in flight');
    await sleep(300);
    assert.equal(sends(mock).filter(s => s.idem === runId).length, 1, 'never sent again');
    assert.equal(readSlot(env).records.filter(r => r.t === 'error').length, 1, 'said once');
    assert.ok(!readSlot(env).records.some(r => r.t === 'reply'), 'no reply');
    assert.equal(readSlot(env).chats.find(c => c.id === CHAT)?.busy, false, 'the chat is idle');
  } finally {
    await b.stop();
    await mock.close();
  }
});

test('bridge v2: stop aborts a turn still waiting to start, on the first try (SE-9), and forget makes the backend forget the chat (CS-4)', async () => {
  const mock = await startRealBackend();
  const queued = mock.holdAt('queued');
  const env = setup();
  const bridge = makeBridge(env, mock);
  const stops = () => bridge.logs.filter(l => l.kind === 'stop');
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('take your time'));
    await waitFor(() => readSlot(env).chats.find(c => c.id === CHAT)?.busy, LIVE, 'busy');
    await waitFor(() => bridge.status().inflight === 1, LIVE, 'the bridge has the run'); // its send is through
    await within(queued.reached, LIVE, 'the turn answered, not started');
    bridge.handlePayload(rec('stop'));
    const aborted = await waitFor(() => readSlot(env).records.find(r => r.t === 'aborted'), LIVE, 'aborted record');
    assert.equal(aborted.chat, CHAT);
    assert.deepEqual(stops().map(l => [l.aborted, !!l.late]), [[true, false]], 'the backend has the turn: aborted on the first try');
    assert.equal(mock.aborts().length, 1, 'one abort');
    assert.ok(!readSlot(env).records.some(r => r.t === 'reply'), 'no reply');
    await waitFor(() => bridge.status().inflight === 0, LIVE, 'nothing in flight');
    bridge.handlePayload(rec('forget'));
    await waitFor(() => !mock.knows(CHAT), LIVE, 'the backend forgot the chat');
    await waitFor(() => !readSlot(env).chats.some(c => c.id === CHAT), LIVE, 'chat dropped');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: stop aborts a run that is already going on its first try, once (SE-9)', async () => {
  const mock = await startRealBackend({ respond: () => ({ text: 'slow' }) });
  const running = mock.holdAt('start');
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('take your time'));
    await within(running.reached, LIVE, 'the run going');
    await settle(bridge); // the bridge has its send's answer and its start
    bridge.handlePayload(rec('stop'));
    await waitFor(() => bridge.logs.some(l => l.kind === 'stop'), LIVE, 'the abort answered');
    running.release();
    const aborted = await waitFor(() => readSlot(env).records.find(r => r.t === 'aborted'), LIVE, 'aborted record');
    assert.equal(aborted.chat, CHAT);
    await settle(bridge);
    assert.deepEqual(bridge.logs.filter(l => l.kind === 'stop').map(l => [l.aborted, !!l.late]), [[true, false]], 'one abort, on the first try');
    assert.equal(mock.aborts().length, 1, 'one abort');
    assert.ok(!readSlot(env).records.some(r => r.t === 'reply' || r.t === 'error'), 'no reply, no error line');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (code health BR-22 r3): a stop in the same tick as its message: the backend had the turn on its queue, and drops it before it runs: nothing to the AI, nothing billed, one abort on the first try, Stopped (SE-9)', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  const stops = () => bridge.logs.filter(l => l.kind === 'stop');
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    // One payload: the message, then its stop, handled in the same tick.
    bridge.handlePayload([msg('take your time'), rec('stop')].join(RS));
    assert.equal(sends(mock).length, 1, 'the backend had the turn when the stop came');
    assert.deepEqual(stops().map(l => l.aborted), [true], 'aborted on the first try');
    assert.equal(mock.aborts().length, 1, 'one abort');
    const aborted = await waitFor(() => readSlot(env).records.find(r => r.t === 'aborted'), LIVE, 'aborted record');
    assert.equal(aborted.chat, CHAT);
    const run = sends(mock)[0].idem;
    assert.equal((await within(mock.runEnded(run), LIVE, 'the turn over')).state, 'failed');
    await sleep(100);
    assert.equal(mock.calls().length, 0, 'nothing went to the AI');
    assert.equal(mock.backend.caps.details().spentMicros, 0, 'nothing billed');
    assert.ok(!readSlot(env).records.some(r => r.t === 'reply'), 'no reply');
    await waitFor(() => bridge.status().inflight === 0, LIVE, 'nothing in flight');
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2 (code health BR-22): a message that comes before the backend is ready waits in the outbox; once it is, it goes and keeps its run: its chat stays busy, and a stop aborts it on the first try', async () => {
  const mock = await startRealBackend({ noKey: true });
  const queued = mock.holdAt('queued');
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'no_key');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('sent while connecting'));
    assert.equal(bridge.store.outbox.length, 1, 'waits in the outbox');
    await mock.addKey(); // ready: what the outbox held goes
    await within(queued.reached, LIVE, 'the turn answered, not started');
    assert.equal(bridge.status().inflight, 1, 'its run is in flight');
    bridge.publisher.flushNow();
    assert.equal(readSlot(env).chats.find(c => c.id === CHAT)?.busy, true, 'and its chat busy');
    bridge.handlePayload(rec('stop'));
    const aborted = await waitFor(() => readSlot(env).records.find(r => r.t === 'aborted'), LIVE, 'the turn aborted');
    assert.equal(aborted.chat, CHAT);
    assert.ok(bridge.logs.some(l => l.kind === 'stop' && l.aborted === true), 'on the first try');
  } finally {
    queued.release();
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: after a restart, the turn a killed bridge left comes back interrupted at the start (outcomes()), and a message sent right after to the same chat keeps its run', async () => {
  // Bridge A is killed with a turn running. Bridge B's start asks the backend what became of it; a
  // new message to the chat goes right after, its turn held before it starts.
  const mock = await startRealBackend({ respond: () => ({ text: 'reply 2' }) });
  const env = setup();
  const runKeys = x => Object.values(x.store.state.inflight).map(r => r.key);
  let a = makeBridge(env, mock), b = null;
  try {
    const running = mock.holdAt('start');
    a.start();
    await waitFor(() => a.status().gateway.state === 'ready');
    a.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    a.handlePayload(msg('first'));
    const first = `${nonce}_${n}`;
    await within(running.reached, LIVE, 'the first turn running');
    await waitFor(() => runKeys(a).includes(first), LIVE, 'the first run in flight');
    await a.stop(); // killed mid-turn
    a = null;
    const queued = mock.holdAt('queued');
    b = makeBridge(env, mock);
    const onlineBefore = b.store.state.lastOnlineAt;
    b.start();
    await waitFor(() => b.status().gateway.state === 'ready');
    b.handlePayload(msg('second'));
    const second = `${nonce}_${n}`;
    await waitFor(() => runKeys(b).includes(second), LIVE, 'the second run in flight');
    const { runId: secondRun } = await within(queued.reached, LIVE, 'the second turn answered, not started');
    assert.ok(b.store.state.lastOnlineAt > onlineBefore, 'the start is done');
    assert.deepEqual(runKeys(b), [second], 'the first run is over; the second is not');
    b.publisher.flushNow();
    const e = readSlot(env).records.find(r => r.t === 'error');
    assert.deepEqual([e?.kind, e?.action], ['interrupted', 'send_again'], 'the first came back interrupted, with Send again');
    assert.equal(readSlot(env).chats.find(c => c.id === CHAT)?.busy, true, 'the chat stays busy with the second');
    queued.release();
    await within(mock.runEnded(secondRun), LIVE, 'the second turn over');
    await settle(b);
    assert.deepEqual(readSlot(env).records.filter(r => r.t === 'reply').map(r => r.text), ['reply 2'], 'the second, live; the first never ran again');
    assert.equal(sends(mock).filter(s => s.idem === `nqa:${TOKEN}:${first}`).length, 1);
  } finally {
    await a?.stop();
    await b?.stop();
    await mock.close();
  }
});

test('bridge v2 (code health BR-22): the safety net asks only about runs quiet for the run limit: a run sent to the same chat since stays in flight, its chat busy, until it goes quiet too', async () => {
  const env = setup();
  let skew = 0;
  const g = fakeGateway({ outcome: runId => ({ runId, chatId: CHAT, state: 'failed' }) });
  const bridge = createBridge({ transport: { slots: 3 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 5, progressMs: 0 },
    runCheckMs: 600, runCheckEveryMs: 3600000, now: () => Date.now() + skew,
    gatewayFactory: g.factory,
  });
  const runKeys = () => Object.values(bridge.store.state.inflight).map(r => r.key);
  try {
    bridge.start();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    bridge.handlePayload(msg('first')); // no event ever comes for it
    const first = `${nonce}_${n}`;
    await waitFor(() => runKeys().includes(first), LIVE, 'the first run in flight');
    skew += 600; // the first run has gone quiet
    bridge.handlePayload(msg('second'));
    const second = `${nonce}_${n}`;
    await waitFor(() => runKeys().includes(second), LIVE, 'the second run in flight');
    bridge.checkRuns();
    assert.deepEqual(g.asked, [[`nqa:${TOKEN}:${first}`]], 'only the quiet one is asked about');
    assert.deepEqual(runKeys(), [second], 'the quiet run is over; the one just sent is not');
    assert.equal(bridge.buildSlot().chats.find(c => c.id === CHAT)?.busy, true, 'its chat stays busy');
    skew += 600;
    bridge.checkRuns();
    assert.deepEqual(runKeys(), [], 'quiet as well now: over');
    assert.equal(bridge.buildSlot().chats.find(c => c.id === CHAT)?.busy, false);
  } finally {
    await bridge.stop();
  }
});

test('bridge v2 (code health BR-22): a resend the backend already had (its ledger answers how it ended) is asked about at once, for its own run only: the chat\'s next message stays in flight', async () => {
  const env = setup();
  const g = fakeGateway({ onSend: args => ({ runId: args.idem, status: args.turn.typed === 'first' ? 'failed' : 'started' }),
    outcome: runId => ({ runId, chatId: CHAT, state: 'failed' }) });
  const bridge = standIn(env, g);
  const runKeys = () => Object.values(bridge.store.state.inflight).map(r => r.key);
  try {
    bridge.start();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    bridge.handlePayload(msg('first'));
    const first = `${nonce}_${n}`;
    bridge.handlePayload(msg('second'));
    const second = `${nonce}_${n}`;
    await waitFor(() => runKeys().includes(second), LIVE, 'the second sent');
    assert.ok(!runKeys().includes(first), 'the first run over: the backend said how it ended');
    assert.deepEqual(g.asked, [[`nqa:${TOKEN}:${first}`]], 'asked about the resend alone, at once');
    assert.deepEqual(runKeys(), [second], 'the second stays in flight');
  } finally {
    await bridge.stop();
  }
});

test('bridge v2 (code health BR-22, BTT-SY-04): the safety net never ends a run still going: running keeps its progress (actions, last line) while a quiet run of the same chat that ended goes', async () => {
  let skew = 0;
  let firstRun = null;
  const g = manualGateway({ outcome: runId => (runId === firstRun ? { runId, chatId: CHAT, state: 'failed' } : { runId, state: 'running' }) });
  const env = setup();
  const bridge = standIn(env, g, { runCheckMs: 600, runCheckEveryMs: 3600000, now: () => Date.now() + skew });
  const retryLine = 'Anthropic is busy right now. Trying again in 2 seconds.';
  try {
    bridge.start();
    g.up();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    bridge.handlePayload(msg('first')); // no event ever comes for it
    firstRun = `nqa:${TOKEN}:${nonce}_${n}`;
    await waitFor(() => bridge.store.state.inflight[firstRun], LIVE, 'the first run in flight');
    bridge.handlePayload(msg('second'));
    const second = `nqa:${TOKEN}:${nonce}_${n}`;
    await waitFor(() => bridge.store.state.inflight[second], LIVE, 'the second run in flight');
    g.event('agent', { runId: second, chatId: CHAT, stream: 'lifecycle', data: { phase: 'start' } });
    g.event('agent', { runId: second, chatId: CHAT, stream: 'item', data: { kind: 'tool', phase: 'start', name: 'retry', title: retryLine } });
    skew += 1200; // both quiet past the limit
    bridge.checkRuns();
    assert.deepEqual(Object.keys(bridge.store.state.inflight), [second], 'the first run is over, the second not');
    const run = bridge.buildSlot().chats.find(c => c.id === CHAT)?.run;
    assert.deepEqual([run?.actions, run?.last], [1, retryLine], 'and its progress stays');
  } finally {
    await bridge.stop();
  }
});

test('bridge v2 (BTT-SY-02): messages typed before the backend is ready go in order once it is, and one typed right after goes after them', async () => {
  const g = manualGateway();
  const env = setup();
  const bridge = standIn(env, g);
  try {
    bridge.start(); // not ready yet
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    bridge.handlePayload(msg('typed before the connect'));
    bridge.handlePayload(msg('typed before it too'));
    assert.equal(bridge.status().outbox, 2, 'they wait in the outbox');
    g.up();
    bridge.handlePayload(msg('typed right after it'));
    await waitFor(() => g.sent.length === 3, LIVE, 'all sent');
    assert.deepEqual(g.sent.map(s => s.turn.typed), ['typed before the connect', 'typed before it too', 'typed right after it'], 'in order');
  } finally {
    await bridge.stop();
  }
});

test('bridge v2 (BTT-SY-05): forgetting a chat forgets its runs in flight: the safety net asks nothing about them, and the Companion chat doesn\'t pick one up when it comes back', async () => {
  const env = setup();
  let skew = 0;
  const g = fakeGateway();
  const bridge = createBridge({ transport: { slots: 3 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 5, progressMs: 0 },
    runCheckMs: 600, runCheckEveryMs: 3600000, now: () => Date.now() + skew,
    gatewayFactory: g.factory,
  });
  const COMP = 'c0ffee0';
  try {
    bridge.start();
    bridge.handlePayload(rec('hello', { ver: '1.2.0', ctx: 0 }));
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'msg', chat: COMP, args: { cur: 0, agent: 'main', name: 'Companion', ctx: 0, q: 'followup' }, text: 'how am I doing?' }));
    await waitFor(() => bridge.status().inflight === 1, LIVE, 'its run in flight'); // no event ever comes for it
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'forget', chat: COMP, args: { cur: 0 }, body: '' }));
    assert.equal(bridge.status().inflight, 0, 'forgotten with the chat');
    skew += 600;
    bridge.checkRuns();
    assert.deepEqual(g.asked, [], 'nothing asked about it');
    // The Companion chat comes back (its id is fixed): only its new turn is in flight.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'msg', chat: COMP, args: { cur: 0, agent: 'main', name: 'Companion', ctx: 0, q: 'followup' }, text: 'and now?' }));
    await waitFor(() => bridge.status().inflight === 1, LIVE, 'the new turn in flight');
    assert.deepEqual(Object.values(bridge.store.state.inflight).map(r => r.key), [`${nonce}_${n}`]);
  } finally {
    await bridge.stop();
  }
});

test('bridge v2: deleting the Companion chat forgets it as any chat: the backend forgets its transcript, its records go, and its next turn starts it again', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  const COMP = 'c0ffee0';
  const toChat = (chat, text) => encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'msg', chat, args: { cur: 0, agent: 'main', name: 'Companion', ctx: 0, q: 'followup' }, text });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(toChat(COMP, 'first'));
    await waitFor(() => readSlot(env).records.some(r => r.t === 'reply' && r.chat === COMP), LIVE, 'the companion reply');
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'forget', chat: COMP, args: { cur: 0 }, body: '' }));
    await waitFor(() => !readSlot(env).chats.some(c => c.id === COMP), LIVE, 'chat dropped');
    await waitFor(() => !mock.knows(COMP), LIVE, 'the backend forgot its transcript');
    assert.ok(!bridge.store.records.some(r => r.chat === COMP), 'its records forgotten with it');
    // Its next turn (the id is fixed) starts the chat again, with only its own rows.
    bridge.handlePayload(toChat(COMP, 'second'));
    await waitFor(() => readSlot(env).records.some(r => r.t === 'reply' && r.chat === COMP), LIVE, 'the new reply');
    assert.deepEqual(mock.rows(COMP).map(r => r.text), ['second', 'OK']);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: the reload path reads hex records from SavedVariables', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const sv = path.join(env.tmp, 'NeverQuestAlone.lua');
  const bridge = makeBridge(env, mock, { savedVariablesFile: sv });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    const wire = msg('sent by reload');
    const key = `${nonce}_${n}`;
    fs.writeFileSync(sv, `NQADB = {\n\t["outbox"] = {\n\t\t{\n\t\t\t["key"] = "${key}",\n\t\t\t["hex"] = "${Buffer.from(wire).toString('hex')}",\n\t\t},\n\t},\n\t["cursor"] = 0,\n}\n`);
    bridge.pollSavedVariables();
    await waitFor(() => sends(mock).length === 1, LIVE, 'send from the reload path');
    // The backend takes the send at once; the ack reaches the slot with the next publish.
    await waitFor(() => readSlot(env).bridge.acked.includes(key), LIVE, 'acked through the slot list');
    bridge.pollSavedVariables(); // unchanged file: nothing new
    await sleep(100);
    assert.equal(sends(mock).length, 1);
  } finally {
    await bridge.stop();
    await mock.close();
  }
});

test('bridge v2: an event for a chat the core doesn\'t know is dropped unread (a turn the backend reports after the core\'s store was lost); a payload with several records works', async () => {
  const mock = await startRealBackend();
  const running = mock.holdAt('start');
  const env = setup();
  const a = makeBridge(env, mock);
  a.start();
  await waitFor(() => a.status().gateway.state === 'ready');
  a.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
  a.handlePayload(msg('where do I go?'));
  await within(running.reached, LIVE, 'the turn running');
  await a.stop(); // killed mid-turn, and its state folder lost with it
  fs.rmSync(env.state, { recursive: true, force: true });
  const b = makeBridge(env, mock);
  try {
    b.start();
    await waitFor(() => b.status().gateway.state === 'ready' && b.store.state.lastOnlineAt > 0, LIVE, 'ready');
    await sleep(100);
    assert.equal(b.store.records.length, 0, 'nothing for a chat it doesn\'t know');
    assert.ok(!JSON.stringify(b.logs).includes(CHAT), 'not even logged');
    b.handlePayload([rec('hello', { ver: '1.1.0', ctx: 0 }), msg('one'), msg('two')].join(RS));
    await waitFor(() => sends(mock).length === 3, LIVE, 'both sent');
  } finally {
    await b.stop();
    await mock.close();
  }
});


// ---------------------------------------------------------------- code health BR-12 (and the old audit's KA-03)
const CHAT2 = 'c4b2d0f';
const msgIn = (chat, text, name) => rec('msg', { agent: 'main', name, ctx: 0, q: 'followup' }, { chat, text, context: null });

test('code health BR-12 (KA-03): a message refused for a key, or by the typed guard, leaves no chat and no title anywhere; its refusal still answers in that chat', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock, { deps: { typedGuard: { turns: 1, windowMs: 60_000 } } });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    // A key as a new chat's first message, titled after its first words (as the addon titles a new chat).
    const keyText = `sk-ant-api03-CANARY${'x'.repeat(40)}`;
    bridge.handlePayload(msgIn(CHAT, keyText, keyText.slice(0, 30)));
    await settle(bridge);
    assert.equal(bridge.store.state.chats[CHAT], undefined, 'no chat for a message refused as a key');
    const refused = bridge.buildSlot().records.find(r => r.t === 'error' && r.kind === 'refused');
    assert.equal(refused.chat, CHAT, 'the refusal answers in that chat');
    // The guard (1 a minute here): the first goes; the next, a new chat's first, is refused before the chat exists.
    bridge.handlePayload(msgIn(CHAT, 'where now?', 'Route'));
    bridge.handlePayload(msgIn(CHAT2, 'and again', 'Second Chat'));
    await settle(bridge);
    assert.ok(bridge.buildSlot().records.some(r => r.t === 'error' && r.kind === 'send_paused' && r.chat === CHAT2));
    assert.deepEqual(Object.keys(bridge.store.state.chats), [CHAT]);
    assert.deepEqual(bridge.buildSlot().chats.map(c => c.label), ['Route']);
    await sleep(100);
    bridge.publisher.flushNow();
    bridge.store.flush();
    const disk = fs.readFileSync(path.join(env.state, 'state.json'), 'utf8');
    assert.ok(!disk.includes('CANARY') && !disk.includes('Second Chat'), 'no refused title on disk');
    assert.equal(mock.knows(CHAT2), false, 'nor at the backend');
  } finally { await bridge.stop(); await mock.close(); }
});

test('code health BR-12: a forget clears the chat\'s per-chat maps; tokens and chats unheard within the retention go with their state, never the token talking now', async () => {
  const mock = await startRealBackend();
  const env = setup();
  let clock = Date.now();
  const bridge = makeBridge(env, mock, { deps: { now: () => clock } });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msgIn(CHAT, 'first', 'One'));
    bridge.handlePayload(msgIn(CHAT2, 'second', 'Two'));
    await waitFor(() => bridge.buildSlot().records.filter(r => r.t === 'reply').length === 2, LIVE, 'both replies');
    assert.deepEqual([bridge.sizes().chats, bridge.sizes().heard], [2, 2]);
    bridge.handlePayload(rec('forget', {}, { chat: CHAT2, body: '' }));
    await settle(bridge);
    assert.deepEqual([bridge.sizes().chats, bridge.sizes().heard, bridge.sizes().busy], [1, 1, 0], 'the forgotten chat\'s maps go with it');
    // Another install's addon talks now; a month and a day later the first token and its chat go.
    bridge.handlePayload(encodeRecord({ token: 'b0b0b0b0', key: 'b0b0', type: 'hello', chat: '', args: { cur: 0, ver: '1.1.0', ctx: 0 } }));
    clock += 31 * 24 * 3600 * 1000;
    assert.deepEqual(bridge.pruneUnseen(), { tokens: 1, chats: 1 });
    assert.deepEqual([bridge.sizes().tokens, bridge.sizes().chats, bridge.sizes().heard, bridge.sizes().busy, bridge.sizes().queued], [1, 0, 0, 0, 0]);
    assert.equal(bridge.status().token.id, 'b0b0b0b0', 'the token talking now stays, however long it has been');
    assert.deepEqual(bridge.pruneUnseen(), { tokens: 0, chats: 0 });
  } finally { await bridge.stop(); await mock.close(); }
});

test('code health (KB-10): a think patch that isn\'t a level is logged with no part of what it said, only whether it looked like a key', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(rec('patch', { agent: 'main', think: `sk-ant-api03-CANARY${'x'.repeat(80)}` }, { body: '' }));
    bridge.handlePayload(rec('patch', { agent: 'main', think: 'ludicrous' }, { body: '' }));
    const bad = await waitFor(() => { const l = bridge.logs.filter(x => x.kind === 'think-invalid'); return l.length === 2 ? l : null; }, LIVE, 'two think-invalid lines');
    assert.ok(!JSON.stringify(bridge.logs).toLowerCase().includes('sk-ant-api03-c'), 'no part of the key');
    assert.ok(!JSON.stringify(bridge.logs).includes('ludicrous'), 'nor of anything else it said');
    assert.deepEqual(bad.map(l => l.keyShaped), [true, false]);
  } finally { await bridge.stop(); await mock.close(); }
});

test('code health (KB-09): a chat error\'s request id reaches the record only when it looks like one: never a key, never a long or odd string', async () => {
  const mock = await startRealBackend();
  const env = setup();
  let handlers = null;
  const bridge = createBridge({ transport: { slots: 3, ackRingMs: 0 } }, {
    stateDir: env.state, addonsDir: env.addons, log: () => {}, publisherOpts: { coalesceMs: 5, progressMs: 0 },
    gatewayFactory: (h) => { handlers = h; return mock.factory(h); },
  });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    bridge.handlePayload(msg('hello there'));
    await waitFor(() => bridge.buildSlot().records.some(r => r.t === 'reply'), LIVE, 'the chat\'s first reply');
    const ids = [`req_sk-ant-api03-CANARY${'x'.repeat(60)}`, 'r'.repeat(65), 'req id with spaces', 'req_011CUabcDEF123'];
    for (const [i, requestId] of ids.entries()) {
      handlers.onEvent({ event: 'chat', payload: { chatId: CHAT, runId: `x${i}`, state: 'error', errorKind: 'auth_invalid', errorMessage: 'The key was rejected.', requestId } });
    }
    assert.deepEqual(bridge.buildSlot().records.filter(r => r.t === 'error').map(e => e.requestId), [undefined, undefined, undefined, 'req_011CUabcDEF123']);
    assert.ok(!JSON.stringify(bridge.buildSlot()).includes('CANARY'));
  } finally { await bridge.stop(); await mock.close(); }
});

test('code health BR-11: a full disk is never silent: a message the outbox can\'t keep still goes, a billed reply the records can\'t keep still shows and the chat isn\'t left busy; status says disk full; the 30-second flush writes it all once there\'s room', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const health = [];
  const bridge = makeBridge(env, mock, { deps: { flushEveryMs: 40, onHealthChange: () => health.push(bridge.status().store.writeError?.code ?? null) } });
  // Every write into the bridge's state folder fails with ENOSPC while `full`.
  const real = { writeFileSync: fs.writeFileSync, openSync: fs.openSync };
  let full = false;
  const inState = p => String(p).startsWith(env.state);
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  fs.writeFileSync = function (p, ...a) { if (full && inState(p)) throw enospc(); return real.writeFileSync.call(this, p, ...a); };
  fs.openSync = function (p, flags, ...a) { if (full && inState(p) && /w|a/.test(String(flags))) throw enospc(); return real.openSync.call(this, p, flags, ...a); };
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', LIVE, 'backend ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    await settle(bridge);
    full = true;
    bridge.handlePayload(msg('what zone am I in?', { ctx: CTX }));
    const shown = await waitFor(() => { const d = readSlot(env); return d.records.some(r => r.t === 'reply') ? d : null; }, LIVE, 'the reply in the slot file');
    assert.match(shown.records.find(r => r.t === 'reply').text, /Mulgore, Red Cloud Mesa/);
    await waitFor(() => !bridge.buildSlot().chats.find(c => c.id === CHAT)?.busy, LIVE, 'the chat not left busy');
    assert.equal(sends(mock).length, 1, 'the message went though the outbox couldn\'t keep it');
    const err = bridge.status().store.writeError;
    assert.deepEqual([err.code, err.diskFull], ['ENOSPC', true]);
    assert.ok(['outbox.jsonl', 'records.json', 'state.json'].includes(err.file));
    assert.equal(health[0], 'ENOSPC', 'the host heard it at once');
    assert.ok(bridge.logs.some(l => l.kind === 'store-write-error'));
    assert.ok(!fs.existsSync(path.join(env.state, 'records.json')) || !fs.readFileSync(path.join(env.state, 'records.json'), 'utf8').includes('Mulgore'));
    // Room again: the next flush writes what was owed, says so, and the status clears.
    full = false;
    await waitFor(() => bridge.status().store.writeError === null, LIVE, 'the write made again');
    assert.match(fs.readFileSync(path.join(env.state, 'records.json'), 'utf8'), /Mulgore, Red Cloud Mesa/);
    assert.equal(health.at(-1), null);
    assert.ok(bridge.logs.some(l => l.kind === 'store-write-recovered'));
  } finally {
    full = false;
    Object.assign(fs, real);
    await bridge.stop();
    await mock.close();
  }
});

// ---------------------------------------------------------------- code health BR-02: normal reload play
/** A SavedVariables write whose outbox holds these records, written at `at` (its mtime). */
function svWriteAt(sv, wires, at) {
  const items = wires.map((w, i) => `\t\t{\n\t\t\t["key"] = "w${i}",\n\t\t\t["hex"] = "${Buffer.from(w).toString('hex')}",\n\t\t},`).join('\n');
  fs.writeFileSync(sv, `NQADB = {\n\t["outbox"] = {\n${items}\n\t},\n\t["cursor"] = 0,\n}\n`);
  const t = new Date(at);
  fs.utimesSync(sv, t, t);
}
function reloadRig(env, mock) {
  const sv = path.join(env.tmp, 'NeverQuestAlone.lua');
  const clock = { t: Date.now() };
  const paused = [];
  const bridge = makeBridge(env, mock, { savedVariablesFile: sv, deps: { now: () => clock.t, savedVarsEveryMs: 3_600_000, onSendPause: on => paused.push(on) } });
  let sent = 0;
  const reload = (k, gapMs) => {
    clock.t += gapMs;
    svWriteAt(sv, Array.from({ length: k }, (_, i) => msg(`reload ${sent + i + 1}`)), clock.t);
    bridge.pollSavedVariables();
    sent += k;
  };
  return { bridge, paused, reload, sent: () => sent };
}
const heldLines = bridge => bridge.buildSlot().records.filter(r => r.t === 'error' && r.kind === 'send_paused');

test('code health BR-02: normal reload play never trips the typed guard: a /reload every 5 s with 1 to 3 new messages for 2 minutes, then two /reloads a minute apart with 10 each', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const { bridge, paused, reload, sent } = reloadRig(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    // 24 reloads 5 s apart: 54 messages in 2 minutes, up to 33 in a minute (over the strip's 20).
    for (const k of [1, 3, 2, 3, 1, 2, 3, 3, 2, 1, 3, 2, 3, 3, 1, 2, 3, 2, 3, 1, 2, 3, 3, 2]) reload(k, 5000);
    assert.equal(sent(), 54);
    assert.deepEqual([paused, heldLines(bridge).length, bridge.status().sending.paused], [[], 0, false]);
    await waitFor(() => sends(mock).length === 54, LIVE, 'every message went');
    reload(10, 60_000);
    reload(10, 60_000);
    assert.deepEqual([paused, heldLines(bridge).length, bridge.status().sending.paused], [[], 0, false]);
    await waitFor(() => sends(mock).length === 74, LIVE, 'and these');
  } finally { await bridge.stop(); await mock.close(); }
});

test('code health BR-02: a runaway still trips it: more than 20 new typed records in one write, or more than 60 a minute across writes', async () => {
  const mock = await startRealBackend();
  const env = setup();
  const { bridge, paused, reload } = reloadRig(env, mock);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready');
    bridge.handlePayload(rec('hello', { ver: '1.1.0', ctx: 0 }));
    // Writes of 15 a few seconds apart (each under one write's 20): the 61st in a minute trips it.
    for (let i = 0; i < 4; i++) reload(15, 10_000);
    assert.deepEqual([paused, heldLines(bridge).length], [[], 0], '60 in under a minute: still sending');
    reload(15, 10_000);
    assert.deepEqual(paused, [true]);
    assert.equal(heldLines(bridge).length, 15, 'the 61st and the rest of its write are answered with the paused line');
    assert.deepEqual(bridge.status().sending, { paused: true, turns: 20, windowMs: 60_000, at: bridge.status().sending.at });
    assert.ok(bridge.logs.some(l => l.kind === 'send-paused' && l.reload === 'runaway'));
    // Resume sending; then one write of 21 trips it again at its 21st.
    assert.equal(bridge.resumeSending(), true);
    reload(21, 60_000);
    assert.deepEqual(paused, [true, false, true]);
    assert.equal(heldLines(bridge).length, 16);
    assert.ok(bridge.logs.some(l => l.kind === 'send-paused' && l.reload === 'write'));
  } finally { await bridge.stop(); await mock.close(); }
});
