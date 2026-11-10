// The typed chat's short path (odd/tasks/nqa-fast-chat.md F3): a typed question the local brain found
// facts for goes out with the compact pack and those facts; anything else keeps the full pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMock, reply, makeBackend, canaryKeystore, sendParams, waitFor, tmpDir } from './helpers/byok-env.mjs';
import { openBrain } from '../../tools/brain/db.mjs';
import { loadPack, loadChatPack } from '../../bridge/byok/runtime/pack.mjs';

const CTX = 'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)\nCharacter: Tavi on Testrealm, level 22 Orc Shaman (Horde)\nLocation: The Barrens';
const STATE = { v: 1, char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Orc', level: 22 }, loc: { zone: 'The Barrens', map: 1413, x: 50, y: 50 }, quests: [] };
const chatCalls = mock => mock.requests.filter(r => r.method === 'POST' && r.url.endsWith('/messages'));

function seedBrain(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'brain'), { recursive: true });
  const db = openBrain(path.join(dataDir, 'brain', 'brain.sqlite'));
  const now = Date.now();
  db.prepare('INSERT INTO npc (id, name, min_level, max_level, zone_area, friendly, raw, source, read_at) VALUES (?,?,?,?,?,?,?,?,?)').run(5767, 'Nalpak', 25, 25, 17, 'AH', '{}', 'questiedb-test', now);
  db.prepare('INSERT INTO spawn (kind, id, area_id, x, y, source) VALUES (?,?,?,?,?,?)').run('npc', 5767, 17, 46.0, 35.7, 'questiedb-test');
  db.prepare('INSERT INTO zone (area_id, name, ui_map_id, source) VALUES (?,?,?,?)').run(17, 'The Barrens', 1413, 'questiedb-test');
  db.prepare('INSERT INTO name_index (name, kind, id) VALUES (?,?,?)').run('Nalpak', 'npc', 5767);
  db.close();
}

async function ask(env, mock, key, text) {
  const before = chatCalls(mock).length;
  await env.backend.send(sendParams('c3f9a1e', key, text, { contextLines: CTX, state: STATE }));
  await waitFor(() => chatCalls(mock).length > before && env.chats('final').length > before, 5000, 'final');
  return chatCalls(mock).at(-1).body;
}

test('typed chat: a question the brain has facts for uses the compact pack; others keep the full pack; the switch turns it off', async () => {
  const mock = await startMock(() => reply('Nalpak está en The Barrens 46.0,35.7.', { input: 900, output: 30 }));
  const dataDir = tmpDir();
  seedBrain(dataDir);
  const env = makeBackend({ url: mock.url, keystore: await canaryKeystore(), dataDir });
  await env.backend.start();
  try {
    // The brain loads in the background from start: wait until a question gets its facts.
    let body;
    await waitFor(async () => { body = await ask(env, mock, `w${Date.now()}`, '¿Dónde está Nalpak?'); return /"facts":/.test(body.messages.at(-1).content); }, 8000, 'the brain is loaded');
    assert.equal(body.system[0].text, loadChatPack().text, 'the compact pack');
    assert.match(body.messages.at(-1).content, /\[questiedb-test\] NPC 5767 Nalpak \(level 25\); at The Barrens 46\.0,35\.7 \(map 1413\)/);
    assert.doesNotMatch(body.messages.at(-1).content, /Tavi|Testrealm/, 'identity stays out as before');
    // Nothing found: the full pack, as always.
    const other = await ask(env, mock, 'a2', 'gracias, hasta luego');
    assert.equal(other.system[0].text, loadPack().text);
    assert.ok(other.max_tokens > body.max_tokens, 'the short path asks for less room (500 against 1,200, plus thinking room)');
  } finally { await env.backend.stop(); await mock.close?.(); }
  // The switch.
  const mock2 = await startMock(() => reply('ok', { input: 900, output: 5 }));
  const env2 = makeBackend({ url: mock2.url, keystore: await canaryKeystore(), dataDir, brainChat: false });
  await env2.backend.start();
  try {
    let body;
    await waitFor(async () => { body = await ask(env2, mock2, `x${Date.now()}`, '¿Dónde está Nalpak?'); return /"facts":/.test(body.messages.at(-1).content); }, 8000, 'the brain is loaded');
    assert.equal(body.system[0].text, loadPack().text, 'facts still go, with the full pack');
  } finally { await env2.backend.stop(); await mock2.close?.(); }
});
