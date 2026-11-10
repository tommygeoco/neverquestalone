'use strict';
// The NeverQuestAlone addon (addon/NeverQuestAlone) in a fengari Lua VM on upstream's WoW stub
// (tests/helpers/nqa-vm.js), against the protocol v2 contract
// (docs/PROTOCOL.md) and its shared vectors (tests/fixtures/protocol-v2.json):
// what it draws parses with the bridge's own parser, byte for byte; the slot
// the bridge's encoder writes applies as specified; and the transport,
// notification, command and security rules hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newVM, reloadVM, lstr, ADDON } = require('./helpers/nqa-vm');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'protocol-v2.json'), 'utf8'));
// The addon's version, from Store.lua; the TOC must say the same. The shared
// vectors' hello carries a fixed ver (data to the bridge's parser); the addon's
// own hello is checked against it with this version in its place.
const VERSION = fs.readFileSync(path.join(ADDON, 'Store.lua'), 'utf8').match(/ns\.VERSION = "([^"]+)"/)[1];
const withVersion = s => s.replace(/;ver=[^;]*;/, `;ver=${VERSION};`);
// The hello and seen as the addon draws them: the vectors' records with where its next slot
// load is and the way its records go out (slot=, mode=; SY-03), which the bridge's parser
// reads as it reads the rest.
const withSlot = (s, slot, mode) => s.replace(/(\x1f(?:cur=[^\x1f]*?))(;sid=[^\x1f]*)?\x1f/, (m, head, sid) => `${head};slot=${slot}${mode ? `;mode=${mode}` : ''}${sid || ''}\x1f`);
const TOKEN = '3fa9c2d1';
const CHAT = 'c3f9a1e';
const SID = '3fa9c2d1e07b4c55'; // the vectors' session id (companion)
const VCTX = V.records[0].parsed.body; // the vectors' game context

let mods;
async function bridge() {
  if (!mods) {
    mods = {
      records: await import('../bridge/transport/records.mjs'),
      luaenc: await import('../bridge/transport/luaenc.mjs'),
    };
  }
  return mods;
}

// Saved data for the vectors: their token and chat.
function vectorDB(extra = '') {
  return `NQADB = { token = "${TOKEN}", sendCounter = 0, cursor = 0, chats = { { id = "${CHAT}", name = "Hyjal route", agent = "main", history = {}, pending = {}, unread = 0 } }, activeChat = "${CHAT}", companion = { chars = { ["Testchar-Test Realm"] = { sid = "${SID}" } } }${extra} }`;
}

// A session whose nonce and game context are the vectors' (CTX can change).
function vectorVM(nonce, opts = {}) {
  return newVM({
    db: vectorDB(),
    before: `NS.NewNonce = function() return "${nonce}" end; CTX = ${lstr(opts.ctx || VCTX)}; NS.Chats.GameContext = function() return CTX end`,
    ...opts,
  });
}

// A doorbell pulse (PROTOCOL §3): the bell reads missing for one poll, then
// present again at the next. Push rings take turns on the two bells, as the
// bridge's do.
function ring(vm, bell = null) {
  if (!bell) bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false);
  vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true);
  vm.run('NS.Transport.Poll()');
  return vm;
}

// The hello goes up 3 s after login; the bridge answers it in the slots and
// rings push. (Push 0 here, so there's no push counter to report afterwards.)
function confirmHello(vm) {
  vm.advance(3.1);
  vm.slot(slotLua({ nonce: vm.evaluate('NS.R.nonce'), push: 0 }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}

// A slot load draws a seen that says where the next load is (SY-03); it's up for a few
// seconds. A test that watches the strip lets it go first.
function settleSeen(vm) {
  vm.advance(5.1);
  return vm;
}

// A beat from the bridge (§3): a pulse on the alive bells, which take turns.
function beat(vm) {
  vm.aliveBell = vm.aliveBell === 'alive_a' ? 'alive_b' : 'alive_a';
  return ring(vm, vm.aliveBell);
}

// The bridge acks keys: they're in the next slot's acked list, and push rings
// (PROTOCOL §3.1). The ring's load waits for the last load to be 1.5 s old.
function ackKeys(vm, keys, extra = {}) {
  vm.slot(slotLua({ acked: keys, push: 0, nonce: vm.evaluate('NS.R.nonce'), ...extra }));
  ring(vm);
  vm.advance(1.6);
  vm.run('STUB.onLoadAddOn = nil');
  return vm;
}

// A slot table as the bridge writes it (docs/PROTOCOL.md §4.1), for this
// install's token unless another is given.
function slotLua({ token = null, push = 0, nonce = null, acked = [], gw = '{ state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }', records = [], chats = '{}', v = 2, ver = '1.1.0', warn = null, extra = '' } = {}) {
  const tok = token ? `"${token}"` : 'NQADB.token';
  const w = warn ? `, warn = ${lstr(warn)}` : '';
  return `{ v = ${v}, ts = "2026-09-25T18:04:00Z", now = time(), token = ${tok}, bridge = { ver = "${ver}", push = ${push}, nonce = ${nonce ? `"${nonce}"` : 'nil'}, acked = { ${acked.map(k => `"${k}"`).join(', ')} }${w} }, gw = ${gw}, agents = { { id = "main", name = "NeverQuestAlone" }, { id = "coder", name = "Coder" } }, chats = ${chats}, records = { ${records.join(', ')} }${extra} }`;
}

function replyRec(seq, chat, text, extra = '') {
  return `{ seq = ${seq}, t = "reply", chat = "${chat}", mid = "m-${seq}", agent = "main", text = ${lstr(text)}, summary = "", more = 0${extra} }`;
}

function apply(vm, slot) {
  vm.run(`NS.Transport.HandleSlotData(${slot}, "slot")`);
}

function activeId(vm) {
  return vm.evaluate('NQADB.activeChat');
}

function lastKey(vm) {
  const out = vm.outboxWires();
  return out[out.length - 1].key;
}

const played = vm => vm.list('STUB.played');
// A command's answer (Chats.Notice): shown in the window, never saved.
const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
// What the history budget counts, every entry: its words and 150 bytes of the rest (code health AD-07).
const HISTORY_TOTAL = `(function() local n = 0 for _, c in ipairs(NQADB.chats) do for _, e in ipairs(c.history) do
  n = n + 150 + #(e.text or "") + #(e.summary or "") + #(e.typed or "")
  for _, chip in ipairs(e.chips or {}) do n = n + #chip end end end return n end)()`;

// --------------------------------------------------------------------------
// Loading
// --------------------------------------------------------------------------

test('every keyed record the addon writes parses with the bridge\'s own parser (a record it rejects is never acked, and stays on the strip)', async () => {
  const { parseRecord } = await import('../bridge/transport/records.mjs');
  const vm = confirmHello(newVM().login());
  const id = vm.evaluate('NQADB.activeChat');
  vm.send('where are the thornweavers?');                                   // msg
  vm.run(`NS.Chats.Stop("${id}")`);                                         // stop
  vm.slash('think high');                                                   // patch
  vm.run(`NS.Chats.Rename("${id}", "Ridge")`);                              // patch
  vm.run('NS.Companion.Send("level_up", { from = 9, to = 10 }, "t:1")');    // evt
  const bare = vm.evaluate(`NS.Transport.NewKeyed("patch", "${id}", { { "agent", "main" }, { "think", "low" } }, "")`); // a caller that leaves cur out
  vm.run(`NS.Chats.Delete("${id}")`);                                       // forget
  const wires = vm.outboxWires();
  const types = new Set();
  for (const { key, wire } of wires) {
    const r = parseRecord(wire);
    assert.equal(r.ok, true, `${key}: ${r.reason} (${JSON.stringify(wire)})`);
    types.add(r.record.type);
  }
  for (const t of ['msg', 'stop', 'patch', 'evt', 'forget']) assert.ok(types.has(t), `a ${t} record was written: ${[...types]}`);
  assert.match(wires.find(e => e.key === bare).wire, /\x1fcur=\d+;agent=main;think=low\x1f/, 'the cursor goes first where a caller left it out');
});

test('saved data is checked at load: a bad token is replaced, broken outbox entries and chats are dropped', () => {
  const vm = newVM({
    db: `NQADB = { token = "NOT-HEX!", sendCounter = 7.9, cursor = -3, reported = 99,
      outbox = { { key = "a3f1_1", hex = "zz" }, { key = "a3f1_2" }, "junk", { key = "a3f1_3", hex = "${Buffer.from(`2\x1fdeadbeef\x1fa3f1_3\x1fstop\x1fc3f9a1e\x1fcur=0\x1f`).toString('hex')}" },
        { key = "11b2_102", hex = "${Buffer.from(`2\x1f7d63a4fb\x1f11b2_102\x1fupd\x1f\x1fa=check\x1f`).toString('hex')}" } },
      chats = { { id = "not-a-chat", name = "x" }, { id = "c3f9a1e", name = "Kept", history = "oops", pending = { "bad", { key = "a3f1_3", acked = true } } }, { id = "c3f9a1e", name = "Duplicate" } },
      activeChat = "c999999", settings = { echo = "loud", mode = "warp" } }`,
  }).login();
  assert.match(vm.evaluate('NQADB.token'), /^[0-9a-f]{8}$/);
  assert.equal(vm.num('NQADB.sendCounter'), 7);
  assert.equal(vm.num('NQADB.cursor'), 0);
  assert.equal(vm.num('NQADB.reported'), 0, 'never above the cursor');
  assert.deepEqual(vm.outboxWires().map(e => e.key), ['a3f1_3'],
    'only a well-formed { key, hex } survives: not one without a cursor, which the bridge never acks (0.4.0-0.4.4\'s Check for Updates stayed on the strip)');
  assert.deepEqual(vm.list('NQADB.chats').map(c => c.name), ['Kept']);
  assert.equal(vm.num('#NQADB.chats[1].pending'), 1);
  assert.equal(vm.evaluate('NQADB.activeChat'), CHAT);
  assert.equal(vm.evaluate('NQADB.settings.echo'), 'summary');
  assert.equal(vm.evaluate('NQADB.settings.mode'), 'pixel');
  // A fresh install: a token, one chat on main, everything at zero.
  const fresh = newVM().login();
  assert.deepEqual([fresh.num('NQADB.sendCounter'), fresh.num('NQADB.cursor'), fresh.num('#NQADB.outbox')], [0, 0, 0]);
});

test('chats: up to 40, in a list that scrolls; the 41st is refused with a note', () => {
  const vm = newVM().login();
  for (let i = 2; i <= 40; i++) vm.slash(`new Chat number ${i}`);
  assert.equal(vm.num('#NQADB.chats'), 40);
  assert.equal(vm.num('#NS.UI.ui.rows'), 40, 'one row per chat inside the scroll frame');
  assert.equal(vm.num('NS.UI.ui.listContent.height'), 40 * 52, 'two-line rows at 12 pt, with room around them (the owner: "not so crammed"): the name, then the newest line and its age');
  vm.slash('new One too many');
  assert.equal(vm.num('#NQADB.chats'), 40);
  assert.match(notice(vm), /^You have 40 chats, the most the window holds\. Delete one first: right-click it in the list\.$/);
  const ids = vm.list('NQADB.chats').map(c => c.id);
  assert.equal(new Set(ids).size, 40, 'ids are unique');
  assert.ok(ids.every(id => /^c[0-9a-f]{6}$/.test(id)));
});

test('NeverQuestAlone loads, builds its window, registers /nqa, /bones and /br, and exports no send function', () => {
  const vm = newVM().login();
  assert.equal(vm.evaluate('SLASH_BONES1'), '/nqa');
  assert.equal(vm.evaluate('SLASH_BONES2'), '/bones', '/bones, the earlier command, is a silent alias of the one command');
  assert.equal(vm.evaluate('SLASH_BONESREPLY1'), '/br');
  assert.equal(vm.evaluate('type(SlashCmdList.BONES)'), 'function');
  assert.equal(vm.evaluate('type(SlashCmdList.BONESREPLY)'), 'function');
  assert.equal(vm.evaluate('NQAFrame ~= nil and NQAMini ~= nil'), 'true');
  assert.equal(vm.num('#NQADB.chats'), 1);
  assert.match(vm.evaluate('NQADB.chats[1].id'), /^c[0-9a-f]{6}$/);
  assert.match(vm.evaluate('NQADB.token'), /^[0-9a-f]{8}$/);
  assert.equal(vm.evaluate('NQADB.chats[1].agent'), 'main', 'new chats are on the default agent, main (CS-2)');
  // The one public table reads the game, opens the window, asks the three
  // fixed quick questions and says Okay to the HUD's news (which sends
  // nothing); it takes no words of anyone's, and the frames that send have no
  // global names (TB5; the /nqa handler, the saved outbox and the strip stay
  // reachable by other addons: ADDON.md, Safety).
  const pub = Object.keys(vm.json('NeverQuestAlone')).sort();
  assert.deepEqual(pub, ['Okay', 'OpenAndType', 'QuickAsk', 'Voice', 'version'], 'no unused exports (code health AD-19); Voice: the voice keys (Bindings.xml)');
  assert.doesNotThrow(() => vm.run('NeverQuestAlone.Voice("say this for me")'), 'Voice takes only its own kinds and sends nothing for others');
  assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("say this for me")'), 'false', 'QuickAsk takes only its own kinds');
  vm.run('NeverQuestAlone.Okay("say this for me")');
  assert.equal(vm.outboxWires().length, 0, 'Okay sends nothing, whatever it is given');
  for (const name of ['NQAInput', 'NQASend', 'NQAStop', 'NQAReloadButton']) {
    assert.equal(vm.evaluate(name), null, name);
  }
  assert.equal(vm.evaluate('NS.UI.ui.input ~= nil and NS.UI.ui.send ~= nil and NS.UI.ui.work.stop ~= nil'), 'true');
  assert.equal(vm.evaluate('BINDING_HEADER_NQA'), 'NeverQuestAlone', 'the name of the keys\' section in Keybindings, in the AddOns list\'s words (C-124, C-127); its ID stays');
  assert.equal(vm.evaluate('BINDING_NAME_NQA_OPEN_AND_TYPE'), 'Open or Close the Window');
  const bindings = fs.readFileSync(path.join(ADDON, 'Bindings.xml'), 'utf8');
  assert.match(bindings, /<Binding name="NQA_OPEN_AND_TYPE"/);
  assert.match(bindings, /NeverQuestAlone\.OpenAndType\(\)/);
  for (const [name, kind] of [['NQA_ASK_NEXT', 'next'], ['NQA_ASK_TARGET', 'target'], ['NQA_ASK_ITEM', 'item']]) {
    assert.match(bindings, new RegExp(`<Binding name="${name}"[^>]*>\\s*if NeverQuestAlone and NeverQuestAlone\\.QuickAsk then NeverQuestAlone\\.QuickAsk\\("${kind}"\\) end`));
    assert.ok(vm.evaluate(`BINDING_NAME_${name}`).startsWith('Ask '), name);
  }
  const toc = fs.readFileSync(path.join(ADDON, 'NeverQuestAlone.toc'), 'utf8');
  // The AddOns list's row: the product's name, and notes in plain words (C-120): the addon works on its
  // own by Copy and Paste, and the app is what brings replies back by themselves (E-050); the last
  // bullet names the app (rename spec H1).
  for (const line of ['## Interface: 16001', '## Title: NeverQuestAlone',
    '## Notes: • Ask anything, right in the game|n• Quest help, routes and gear advice|n• Your route drawn on the map|n• Quality-of-life helpers you turn on|n• Any AI, with or without the free NeverQuestAlone app',
    `## Version: ${VERSION}`, '## SavedVariables: NQADB, NQAMapDB']) {
    assert.ok(toc.split('\n').includes(line), line);
  }
  for (const field of ['Title', 'Notes']) {
    const text = toc.match(new RegExp(`^## ${field}: (.*)$`, 'm'))[1];
    assert.doesNotMatch(text, /bridge|\bMac\b/, `${field}: no plumbing, no one system`);
  }
  assert.equal(vm.evaluate('NQA_Inbox'), null, 'the placeholder inbox is empty');
  assert.equal(vm.evaluate('NQA_Codec.MAGIC1 .. "," .. NQA_Codec.MAGIC2'), '199,44');
});

// --------------------------------------------------------------------------
// Records: the shared vectors, byte for byte
// --------------------------------------------------------------------------

test('hello: the vector record byte for byte, with its next slot and the way out (strip v2: magic C7 2C, Fletcher-16), parsed by the bridge', async () => {
  const { records } = await bridge();
  const vm = vectorVM('a3f1').login();
  assert.equal(vm.strip(), null, 'nothing drawn before the hello');
  vm.advance(3.1);
  assert.deepEqual(vm.stripWires(), [withSlot(withVersion(V.records[0].wire), 1, 'pixel')]);
  const { records: got, rejected } = records.parsePayload(vm.strip().payload);
  assert.equal(rejected.length, 0);
  for (const [k, v] of Object.entries(V.records[0].parsed)) assert.deepEqual(got[0][k], k === 'args' ? { ...v, ver: VERSION, slot: '1', mode: 'pixel' } : v, k);
});

test('msg, stop, patch and forget: the vector records byte for byte, and the payload vector newest first', async () => {
  const { records } = await bridge();
  const vm = vectorVM('a3f1', { ctx: 'Game: an older context' }).login();
  confirmHello(vm);
  assert.deepEqual(vm.stripWires(), [`2\x1f${TOKEN}\x1fa3f1\x1fseen\x1f\x1fcur=0;slot=2\x1f`], 'a confirmed hello leaves the strip; the seen after its slot load says where the next one is');
  settleSeen(vm);
  assert.equal(vm.strip(), null);
  const byKey = () => Object.fromEntries(vm.outboxWires().map(e => [e.key, e.wire]));

  // The context changed since the hello, so this msg carries it (ctx=1).
  vm.run(`CTX = ${lstr(VCTX)}`);
  vm.send('fastest way to Hyjal from here?');
  assert.equal(byKey().a3f1_1, V.records[1].wire);

  // Cursor 3, a name that needs percent-encoding, a leading slash, and a US typed
  // into the text: the addon turns bytes 0x1D-0x1F into spaces (§2.2), so that
  // vector's raw US (there for the bridge's parser) is drawn as a space.
  vm.run('NQADB.cursor = 3; NQADB.chats[1].name = "50% off; a=b"');
  vm.send('/exec rm -rf ~ ; a=b \x1f still text');
  const want2 = V.records[2].wire.replace('b \x1f still', 'b   still');
  assert.equal(byKey().a3f1_2, want2);
  const p2 = records.parseRecord(byKey().a3f1_2);
  assert.equal(p2.ok, true);
  for (const [k, v] of Object.entries(V.records[2].parsed)) {
    const want = typeof v === 'string' ? v.replace('\x1f', ' ') : v;
    assert.deepEqual(p2.record[k], want, k);
  }

  vm.run('NQADB.cursor = 5');
  vm.slash('stop');
  assert.equal(byKey().a3f1_3, V.records[3].wire);

  // The bridge acks a3f1_2: the strip carries the stop and the first msg, newest first (once
  // the seen after that slot load has had its few seconds).
  ackKeys(vm, ['a3f1_2']);
  assert.ok(vm.stripWires().includes(`2\x1f${TOKEN}\x1fa3f1\x1fseen\x1f\x1fcur=5;slot=3\x1f`), 'the ack\'s slot load says where the next one is');
  settleSeen(vm);
  assert.equal(vm.strip().payload, V.payload.wire);
  assert.deepEqual(records.parsePayload(vm.strip().payload).records.map(r => r.key), V.payload.keys);

  vm.slash('rename Hyjal & back');
  assert.equal(byKey().a3f1_4, V.records[4].wire);
  vm.slash('delete');
  vm.run('StaticPopupDialogs.NQA_DELETE.OnAccept({}, STUB.popup.data)'); // deleting asks first
  assert.equal(byKey().a3f1_5, V.records[5].wire);

  // Everything on the strip parses with the bridge's parser into the vector forms, cur on each.
  const parsed = records.parsePayload(vm.strip().payload);
  assert.equal(parsed.rejected.length, 0);
  assert.deepEqual(parsed.records.map(r => r.key), ['a3f1_5', 'a3f1_4', 'a3f1_3', 'a3f1_1']);
  for (const r of parsed.records) {
    const v = V.records.find(x => x.parsed.key === r.key);
    for (const [k, x] of Object.entries(v.parsed)) assert.deepEqual(r[k], x, `${r.key}.${k}`);
    assert.match(r.args.cur, /^\d+$/);
  }
});

test('seen: the vector record, drawn once the applied cursor is 10 records past the reported one', async () => {
  const { records } = await bridge();
  const vm = vectorVM('b7e2').login();
  vm.advance(3.1);
  const twelve = Array.from({ length: 12 }, (_, i) => replyRec(i + 1, 'c000000', 'orphan ' + (i + 1)));
  vm.slot(slotLua({ nonce: 'b7e2', records: twelve }));
  ring(vm).advance(0.3); // the hello answer (§4.2 rule 2) applies all twelve
  assert.equal(vm.num('NQADB.cursor'), 12);
  assert.equal(vm.num('NS.R.orphans'), 12, 'records for an unknown chat create nothing (§4.3)');
  assert.equal(vm.num('#NQADB.chats'), 1);
  // The vector's seen, with where the next slot load is (SY-03).
  const seenWire = withSlot(V.records[6].wire, 2);
  assert.deepEqual(vm.stripWires(), [seenWire]);
  const r = records.parseRecord(seenWire).record;
  for (const [k, v] of Object.entries(V.records[6].parsed)) assert.deepEqual(r[k], k === 'args' ? { ...v, slot: '2' } : v, k);
  // After a few seconds it leaves the strip and counts as reported.
  vm.advance(6);
  assert.equal(vm.strip(), null);
  assert.equal(vm.num('NQADB.reported'), 12);
  // Nothing new to report: no second seen.
  vm.advance(60);
  assert.equal(vm.strip(), null);
});

test('seen also goes out 30 s after an unreported record, and a waiting keyed record reports instead', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'one')] }));
  assert.equal(vm.strip(), null, 'one record: not yet');
  vm.advance(32); // 30 s, and the 2-second tick that finds them past
  assert.match(vm.stripWires()[0] || '', /\x1fseen\x1f\x1fcur=1;slot=2\x1f$/);
  vm.advance(6);
  assert.equal(vm.num('NQADB.reported'), 1);
  // A msg drawn with cur=2 reports the cursor itself once acked; no seen.
  apply(vm, slotLua({ records: [replyRec(2, id, 'two')] }));
  vm.send('thanks');
  const key = lastKey(vm);
  vm.advance(40);
  assert.ok(!vm.stripWires().some(w => w.includes('\x1fseen\x1f')), 'no seen while a keyed record carries the cursor');
  ackKeys(vm, [key]);
  assert.equal(vm.num('NQADB.reported'), 2);
});

test('the strip draws newest first within 3,200 bytes; older records wait for a later frame', async () => {
  const { records } = await bridge();
  const vm = confirmHello(newVM().login());
  for (let i = 1; i <= 4; i++) vm.slash(`message ${i} ` + 'x'.repeat(1400));
  const out = vm.outboxWires();
  assert.equal(out.length, 4);
  const fit = entries => {
    const drawn = [];
    let size = 0;
    for (const e of entries) {
      const add = Buffer.byteLength(e.wire) + (drawn.length ? 1 : 0);
      if (size + add > 3200) break;
      drawn.push(e.wire);
      size += add;
    }
    return drawn;
  };
  const want = fit([...out].reverse());
  assert.equal(want.length, 2);
  assert.deepEqual(vm.stripWires(), want);
  const frame1 = vm.strip().frame;
  const parsed = records.parsePayload(vm.strip().payload);
  assert.equal(parsed.rejected.length, 0);
  assert.ok(parsed.records.every(r => /^\d+$/.test(r.args.cur)), 'cur on every record');
  // The newest is acked: the next older one joins, and the frame counter moves.
  ackKeys(vm, [out[3].key]);
  assert.deepEqual(vm.stripWires(), fit([out[2], out[1], out[0]]));
  assert.notEqual(vm.strip().frame, frame1, 'the frame counter changes with the content');
});

// [code health AD-03] A full draw was 16,800 widget calls (a colour and a Show for every cell),
// twice a send. Now a frame colours only the cells whose value changed, shows only the ones
// that were hidden and hides only the rows it dropped; the capture decoders read every shown
// cell, so each frame must be exactly what a fresh draw of it would be.
test('the strip touches only the cells that changed: every frame\'s shown cells are exactly a fresh encoding\'s, no stale row stays shown, and a redraw that changes only the frame counter touches a handful of cells (code health AD-03)', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  // Every colour, Show and Hide on a cell, counted (the strip's textures, made from now on too).
  vm.run(`STUB.cellCalls = 0
    local function Count(t)
      for _, m in ipairs({ "SetColorTexture", "Show", "Hide" }) do
        local real = getmetatable(t).__index(t, m)
        t[m] = function(...) STUB.cellCalls = STUB.cellCalls + 1; return real(...) end
      end
    end
    local strip = NS.Transport.EnsureStrip()
    for _, t in ipairs(strip.textures) do Count(t) end
    local make = getmetatable(strip).__index(strip, "CreateTexture")
    strip.CreateTexture = function(...) local t = make(...); Count(t); return t end
    -- The shown cells against a fresh encoding of what the strip carries now, cell by cell.
    function STUB.CheckStrip()
      local cells = NQA_Codec.Encode(NS.R.frame, NS.R.stripPayload)
      local want = math.ceil(#cells / 200) * 200
      local shown, bad = 0, 0
      for i, t in ipairs(NQAStrip.textures) do
        if t.shown then
          shown = shown + 1
          local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
          if i > want or v ~= (cells[i] or 0) or t.color[4] ~= 1 then bad = bad + 1 end
        end
      end
      return string.format("%d/%d shown, %d wrong", shown, want, bad)
    end`);
  const check = what => {
    const want = vm.evaluate('math.ceil(#NQA_Codec.Encode(NS.R.frame, NS.R.stripPayload) / 200) * 200');
    assert.equal(vm.evaluate('STUB.CheckStrip()'), `${want}/${want} shown, 0 wrong`, what);
    assert.ok(vm.strip(), what);
  };
  const calls = () => vm.num('STUB.cellCalls');
  vm.send('first');
  check('one record');
  vm.send('second ' + 'x'.repeat(1500));
  check('a longer frame: more rows');
  vm.send('third ' + 'y'.repeat(900));
  check('the newest first: every cell after it moved');
  const keys = vm.outboxWires().map(e => e.key);
  ackKeys(vm, [keys[1]]);
  settleSeen(vm);
  check('a record acked from the middle: fewer rows, the dropped rows hidden');
  // Hidden and drawn again with the same records: a new frame counter, so only the header's
  // and the checksum's cells can change (of some 2,400 here).
  const before = calls();
  vm.run('NS.Transport.HideStrip(); NS.Transport.RefreshStrip()');
  assert.ok(calls() - before <= 16, `${calls() - before} cell calls`);
  check('drawn again');
  ackKeys(vm, [keys[0], keys[2]]);
  settleSeen(vm);
  assert.equal(vm.strip(), null, 'nothing left to draw');
  vm.send('after a hidden strip');
  check('drawn again after it was hidden, rows shown again');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

// [code health AD-03] The backstop to drawing only what changed: a cell left wrong stays wrong
// (nothing colours a cell whose value didn't change), and the app would stop reading the strip,
// and the replies stop, without a word. While what's drawn waits for the bridge's answer, the
// strip is drawn again in full: once a frame that has waited 12 visible seconds (T.HEAL_ACK: the
// slowest ack in normal play is about 10 s) and every 30 s (T.HEAL_EVERY) however often it changes.
test('the strip heals itself: a cell another addon recolours between frames is drawn again in full once the frame has waited 12 s for its ack, or every 30 s while frames keep changing; an ack in time costs no full draw, nor does a strip no app reads, and /nqa diag counts them (code health AD-03)', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  const heal = () => vm.json('{ ack = NS.R.heal.ack, timer = NS.R.heal.timer, heard = NS.R.heal.heard }');
  // Another writer recolours a cell of the payload (cell 40, byte 14): its red flips.
  const clobber = () => vm.run(`local t = NQAStrip.textures[40]
    t:SetColorTexture(t.color[1] >= 0.5 and 0 or 1, t.color[2], t.color[3], 1)`);
  const unread = what => assert.throws(() => vm.strip(), /fletcher/, what);
  // Every shown cell against a fresh encoding of what the strip carries (the AD-03 test's check).
  const exact = what => {
    vm.run(`local cells = NQA_Codec.Encode(NS.R.frame, NS.R.stripPayload)
      local want = math.ceil(#cells / 200) * 200
      local shown, bad = 0, 0
      for i, t in ipairs(NQAStrip.textures) do
        if t.shown then
          shown = shown + 1
          local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
          if i > want or v ~= (cells[i] or 0) or t.color[4] ~= 1 then bad = bad + 1 end
        end
      end
      STUB.exact = string.format("%d/%d shown, %d wrong", shown, want, bad)`);
    const want = vm.evaluate('math.ceil(#NQA_Codec.Encode(NS.R.frame, NS.R.stripPayload) / 200) * 200');
    assert.equal(vm.evaluate('STUB.exact'), `${want}/${want} shown, 0 wrong`, what);
  };
  vm.slash('diag');
  assert.match(notice(vm), /\nStrip self-heal: no full redraws this session\n/);
  vm.run('NS.UI.Toggle(false)'); // the window shut: no progress loads (rule 3) change the frames below

  // Normal play: the slowest ack (a turn's, rung within 8 s, then the bell and the push gap) costs none.
  vm.send('first');
  vm.advance(10.4);
  ackKeys(vm, [lastKey(vm)]);
  settleSeen(vm);
  assert.deepEqual(heal(), { ack: 0, timer: 0, heard: 0 }, 'an ack in about 10 s: no full draw');

  // (a) A frame whose cell was recoloured: unread until it has waited 12 s, then drawn in full,
  // same frame, every cell right again.
  vm.send('second ' + 'x'.repeat(600));
  const frame = vm.num('NS.R.frame');
  const payload = vm.strip().payload;
  clobber();
  unread('a recoloured cell: the checksum fails');
  vm.advance(11);
  unread('11 s: still waiting');
  assert.deepEqual(heal(), { ack: 0, timer: 0, heard: 0 });
  vm.advance(1.5);
  assert.deepEqual(heal(), { ack: 1, timer: 0, heard: 0 }, 'one full draw at 12 s');
  assert.equal(vm.num('NS.R.frame'), frame, 'the same frame: the capture reads it as new only once it decodes');
  assert.equal(vm.strip().payload, payload);
  exact('drawn in full: every shown cell a fresh encoding\'s');
  vm.advance(10);
  ackKeys(vm, [lastKey(vm)]);
  settleSeen(vm);
  assert.deepEqual(heal(), { ack: 1, timer: 0, heard: 1 }, 'its ack came within 12 s of the full draw');

  // (b) Frames that keep changing (here every 10 s, only their counter) never wait 12 s, and a
  // frame changes only the cells whose value changed: the recoloured cell stays. Every 30 s while
  // something waits, a full draw.
  beat(vm);
  vm.send('third');
  clobber();
  for (let i = 0; i < 2; i++) {
    vm.advance(10);
    vm.run('NS.Transport.HideStrip(); NS.Transport.RefreshStrip()');
    unread(`a new frame counter, the recoloured cell kept (${i + 1})`);
  }
  vm.advance(9);
  unread('29 s');
  assert.deepEqual(heal(), { ack: 1, timer: 0, heard: 1 });
  vm.advance(2);
  assert.deepEqual(heal(), { ack: 1, timer: 1, heard: 1 }, 'the timer\'s full draw at 30 s');
  exact('the timer\'s full draw');
  ackKeys(vm, [lastKey(vm)]);
  settleSeen(vm);

  // (c) No word from the app for over 2 minutes (T.RedAfter): nothing reads the strip, so no full
  // draws; once it's heard again, its clocks start over. (A message sent then goes by Copy and
  // Paste, so this one went first.)
  vm.send('fourth');
  clobber();
  unread('recoloured again');
  vm.run('NS.R.bridgeSeenAt = GetTime() - 200');
  vm.advance(40);
  unread('no app: nothing redrawn');
  assert.deepEqual(heal(), { ack: 1, timer: 1, heard: 2 });
  beat(vm);
  vm.advance(12.5);
  assert.deepEqual(heal(), { ack: 2, timer: 1, heard: 2 }, '12 s after the app is heard');
  exact('drawn in full after the app came back');
  vm.advance(14);
  assert.deepEqual(heal(), { ack: 2, timer: 1, heard: 2 }, 'once a frame: the 30 s timer takes it from there');
  vm.slash('diag');
  assert.match(notice(vm), /\nStrip self-heal: 3 full redraw\(s\) \(2 with no ack for 12 s, 1 on the 30 s timer\), 2 followed by an ack; last \d+ s ago\n/);
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

// --------------------------------------------------------------------------
// Keys, acks, pushes, slot loads
// --------------------------------------------------------------------------

test('keys: a new nonce at every login and /reload, n only increases, the unacked outbox is drawn again verbatim', () => {
  const vm = confirmHello(newVM().login());
  const n1 = vm.evaluate('NS.R.nonce');
  assert.match(n1, /^[0-9a-f]{4}$/);
  vm.send('first');
  vm.send('second');
  assert.deepEqual(vm.outboxWires().map(e => e.key), [`${n1}_1`, `${n1}_2`]);
  ackKeys(vm, [`${n1}_1`]);
  const kept = vm.outboxWires();
  assert.deepEqual(kept.map(e => e.key), [`${n1}_2`]);

  // Same random seed after the reload: the first nonce drawn repeats n1 and is skipped.
  const vm2 = reloadVM(vm).login();
  const n2 = vm2.evaluate('NS.R.nonce');
  assert.notEqual(n2, n1);
  assert.deepEqual(vm2.stripWires(), [kept[0].wire], 'redrawn verbatim, with its old key, right at login');
  vm2.send('third');
  assert.deepEqual(vm2.outboxWires().map(e => e.key), [`${n1}_2`, `${n2}_3`]);
  assert.deepEqual(vm2.json('NQADB.nonces').slice(0, 2), [n2, n1]);

  const vm3 = reloadVM(vm2, { seed: 99 }).login();
  const n3 = vm3.evaluate('NS.R.nonce');
  assert.ok(n3 !== n1 && n3 !== n2);
  vm3.send('fourth');
  assert.equal(lastKey(vm3), `${n3}_4`, 'n keeps counting across sessions');
});

test('ack: the slot\'s acked list, announced by a push ring, takes the record off the strip and out of the outbox', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  vm.run('NS.UI.Toggle(true)'); // the window draws its working line only while it shows (code health AD-05)
  vm.send('ping');
  const key = lastKey(vm);
  assert.equal(vm.stripWires().length, 1);
  assert.equal(vm.evaluate('NS.UI.ui.work.text.text').startsWith('Sending'), true);
  vm.advance(1);
  assert.equal(vm.outboxWires().length, 1, 'no ack, still waiting');
  ackKeys(vm, [key]);
  assert.equal(vm.outboxWires().length, 0);
  assert.deepEqual(vm.stripWires().map(w => w.split('\x1f')[3]), ['seen'], 'off the strip: only the seen after the slot load is left');
  assert.equal(vm.num('NS.R.acks.slot'), 1, 'acked by the slot list the ring announced');
  assert.equal(vm.bool('NQADB.chats[1].pending[1].acked'), true, 'the send is acked, its run pending');
  assert.match(vm.evaluate('NS.UI.ui.work.text.text'), /^Working · /);
});

test('hello: toc says the TOC\'s version as the game read it at its start (a /reload doesn\'t reread it), so the bridge knows when an update\'s new files are loaded; none when the client can\'t say', () => {
  const vm = newVM({ extra: 'STUB.tocVersion = "0.3.1"' }).login();
  vm.advance(3.1);
  const hello = vm.stripWires().find(w => w.includes('\x1fhello\x1f')) || '';
  assert.ok(hello.includes(`;ver=${VERSION};`), 'the Lua that ran');
  assert.match(hello, /;toc=0\.3\.1[;\x1f]/, 'the TOC the game started with');
  const plain = newVM().login();
  plain.advance(3.1);
  assert.doesNotMatch(plain.stripWires().find(w => w.includes('\x1fhello\x1f')) || '', /toc=/);
});

test('ack: when signals are unusable (slot-only mode), the slot\'s bridge.acked list acks', () => {
  const vm = newVM({ signals: false }).login();
  assert.equal(vm.evaluate('NS.R.sig.static'), 'present-missing');
  vm.advance(3.1);
  assert.match(vm.stripWires()[0], /;sig=present-missing;/, 'the hello reports the self-test');
  vm.send('hello?');
  const key = lastKey(vm);
  ackKeys(vm, [key]);
  assert.equal(vm.outboxWires().length, 1, 'slot-only mode trusts no signal file');
  vm.slot(slotLua({ acked: [key] }));
  vm.advance(5); // rule 4's first load, 5 s after the send
  assert.equal(vm.outboxWires().length, 0);
  assert.equal(vm.num('NS.R.acks.slot'), 1);
});

test('push: a ring on either push bell loads one slot, at most one per 1.5 s; a seen reports the push counter read, and the hello carries it after a reload', () => {
  const vm = newVM().login();
  vm.advance(3.1);
  const nonce = vm.evaluate('NS.R.nonce');
  vm.slot(slotLua({ push: 137, nonce }));
  ring(vm).advance(0.3);
  assert.equal(vm.loads(), 1, 'the hello answer, announced by a ring');
  assert.equal(vm.num('NS.R.push.known'), 137);
  assert.equal(vm.evaluate('NS.R.sig.live'), 'ok');
  assert.match(vm.stripWires().find(w => w.includes('\x1fseen\x1f')) || '', /\x1fcur=0;p=137;slot=2\x1f$/, 'what was read goes back to the bridge, with the next slot');
  vm.advance(6);
  assert.equal(vm.num('NS.R.push.reported'), 137, 'counted as told once the seen has been up a few seconds');
  vm.advance(20);
  assert.equal(vm.loads(), 1, 'no ring, no load');
  // Two rings close together (on the two bells): one load now, the next 1.5 s after it.
  vm.slot(slotLua({ push: 138 }));
  ring(vm);
  assert.equal(vm.loads(), 2);
  vm.slot(slotLua({ push: 139 }));
  ring(vm);
  assert.equal(vm.loads(), 2, 'within 1.5 s of the last load: it waits');
  vm.advance(1.6);
  assert.equal(vm.loads(), 3);
  assert.equal(vm.num('NS.R.push.known'), 139);
  assert.equal(vm.num('NS.R.slots.reasons.push'), 3);
  assert.equal(vm.num('NS.R.bells.push_a.rings') + vm.num('NS.R.bells.push_b.rings'), 3);
  // A counter that drops by more than 100 means the bridge's state was reset.
  apply(vm, slotLua({ push: 500 }));
  apply(vm, slotLua({ push: 7 }));
  assert.equal(vm.num('NS.R.push.known'), 7);
  // After a reload, the hello says what the reload inbox had.
  const token = vm.evaluate('NQADB.token');
  const vm2 = reloadVM(vm, { inbox: 'NQA_Inbox = ' + slotLua({ token, push: 9 }) }).login();
  vm2.advance(3.1);
  assert.match(vm2.stripWires().find(w => w.includes('\x1fhello\x1f')) || '', /;slots=\d+;p=9[;\x1f]/);
});

test('push: a seen the bridge missed goes up again at its next ring, rather than every re-ring loading another slot', () => {
  const vm = newVM().login();
  vm.advance(3.1);
  vm.slot(slotLua({ push: 137, nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm).advance(0.3);
  const seen = () => vm.stripWires().find(w => w.includes('\x1fseen\x1f')) || '';
  assert.match(seen(), /;p=137;slot=2\x1f$/);
  vm.advance(6);
  assert.equal(vm.num('NS.R.push.reported'), 137, 'counted as told once the seen has been up a few seconds');
  // The capture missed it, so the bridge rings again for the same publish (push 137): every
  // 10 s six times, then every 60 s up to 10 minutes, until a seen says p=137 (PROTOCOL §3).
  const loads = vm.loads();
  for (const gap of [10, 10, 10, 10, 10, 10, 60, 60, 60, 60, 60, 60, 60, 60, 60]) {
    if (/;p=137;slot=\d+\x1f$/.test(seen())) break; // the bridge reads it now: no more rings
    vm.advance(gap - 0.3);
    ring(vm).advance(0.3);
  }
  assert.equal(vm.loads() - loads, 1, 'one more slot: the seen goes up again at the first re-ring');
  assert.equal(vm.num('NS.R.slots.reasons.push'), 2);
  // A slot in another protocol isn't read, its push counter neither: the seen after that load
  // says only where the next one is (SY-03), with the counter read before it.
  vm.advance(6);
  vm.slot(slotLua({ push: 150, v: 3 }));
  ring(vm).advance(0.3);
  assert.equal(vm.num('NS.R.push.known'), 137, 'nothing read');
  assert.match(seen(), /\x1fcur=0;p=137;slot=4\x1f$/, 'nothing said of it: only the next slot');
});

test('doorbells: a first read of missing isn\'t a ring; 10 s missing is dead; both push bells dead means slot-only mode; with present.wav missing nothing is read', () => {
  // push_a was missing when the UI loaded: never heard, dead after 10 s; push_b still works.
  const one = newVM({ extra: `STUB.sounds["Interface\\\\AddOns\\\\NeverQuestAlone\\\\sig\\\\ctl\\\\bell_push_a.wav"] = nil` }).login();
  one.advance(3.1);
  const nonce = one.evaluate('NS.R.nonce');
  one.advance(11);
  assert.equal(one.bool('NS.R.bells.push_a.dead'), true);
  assert.equal(one.evaluate('NS.R.sig.live'), 'pending', 'one push bell left: still fine');
  one.slot(slotLua({ nonce, push: 1 }));
  ring(one, 'push_b').advance(0.3);
  assert.equal(one.evaluate('NS.R.sig.live'), 'ok');
  assert.equal(one.loads(), 1);
  // Both push bells missing at load: slot-only mode, and it says why.
  const none = newVM({ extra: `STUB.sounds["Interface\\\\AddOns\\\\NeverQuestAlone\\\\sig\\\\ctl\\\\bell_push_a.wav"] = nil; STUB.sounds["Interface\\\\AddOns\\\\NeverQuestAlone\\\\sig\\\\ctl\\\\bell_push_b.wav"] = nil` }).login();
  none.advance(15);
  assert.equal(none.evaluate('NS.R.sig.live'), 'fail');
  assert.equal(none.bool('NS.Transport.SlotOnly()'), true);
  assert.ok(none.chatLines().some(l => l.includes('Replies arrive more slowly for now: the addon checks for them on a timer.')));
  // A dead bell that comes back (the bridge restarted mid-pulse) is used again.
  const back = confirmHello(newVM().login());
  back.signal('ctl', 'bell_push_a', false).advance(11);
  assert.equal(back.bool('NS.R.bells.push_a.dead'), true);
  back.signal('ctl', 'bell_push_a').advance(2.1);
  assert.equal(back.bool('NS.R.bells.push_a.dead'), false);
  // present.wav missing (sound off): no bell is read, so nothing rings or dies.
  const quiet = confirmHello(newVM().login());
  const rings = quiet.num('NS.R.push.rings');
  quiet.signal('ctl', 'present', false).signal('ctl', 'bell_push_a', false);
  quiet.run('NS.Transport.Poll()');
  assert.equal(quiet.num('NS.R.push.rings'), rings);
});

test('live self-test: the hello answer\'s ring settles it; with no ring in 30 s one load decides, and an answer found there means slot-only mode', () => {
  const vm = newVM().login();
  vm.advance(3.1);
  vm.slot(slotLua({ nonce: vm.evaluate('NS.R.nonce'), push: 1 }));
  ring(vm).advance(0.3);
  assert.equal(vm.evaluate('NS.R.sig.live'), 'ok');
  assert.equal(vm.num('NS.R.slots.reasons.push'), 1);
  // No ring reaches this client: 30 s after the hello went up, one load finds the answer, so the ring was missed.
  const deaf = newVM().login();
  deaf.advance(3.1);
  deaf.slot(slotLua({ nonce: deaf.evaluate('NS.R.nonce'), push: 1 }));
  deaf.advance(29);
  assert.equal(deaf.loads(), 0);
  deaf.advance(1.5);
  assert.equal(deaf.num('NS.R.slots.reasons.hello'), 1);
  assert.equal(deaf.evaluate('NS.R.sig.live'), 'fail');
  assert.equal(deaf.bool('NS.Transport.SlotOnly()'), true);
  assert.ok(deaf.chatLines().some(l => l.includes("Replies arrive more slowly for now: the game can't hear the sound that says a reply is ready.")));
});

test('rule 3: progress text only with the window open on a chat busy 30 s; one per 60 s, 3 per run, 30 per session', () => {
  const vm = newVM().login();
  vm.advance(3.1);
  const nonce = vm.evaluate('NS.R.nonce');
  const id = activeId(vm);
  const busyChats = `{ { id = "${id}", key = "wow:${id}", agent = "main", label = "x", busy = true, queued = 0, run = { actions = 2, last = "Web search" } } }`;
  vm.slot(slotLua({ nonce, chats: busyChats }));
  ring(vm).advance(0.3);
  const progress = () => vm.num('NS.R.slots.reasons.progress or 0');
  vm.send('a long task');
  ackKeys(vm, [lastKey(vm)], { chats: busyChats });
  vm.advance(60);
  assert.equal(progress(), 0, 'window closed: no progress loads');
  vm.run('NS.UI.Toggle(true)');
  vm.advance(2.1);
  assert.equal(progress(), 1);
  assert.match(vm.evaluate('NS.UI.ui.work.text.text'), /^Working · 2 actions · .+ · Web search$/);
  vm.advance(50);
  assert.equal(progress(), 1, 'at most one per 60 s');
  vm.advance(12);
  assert.equal(progress(), 2);
  vm.advance(62);
  assert.equal(progress(), 3);
  vm.advance(300);
  assert.equal(progress(), 3, 'at most 3 per run');
  // The run ends; a new one starts: nothing before it has been busy 30 s.
  apply(vm, slotLua({ records: [replyRec(1, id, 'done')], chats: `{ { id = "${id}", busy = false, queued = 0 } }` }));
  assert.equal(vm.bool(`NS.Chats.IsBusy(NS.Chats.Find("${id}"))`), false);
  vm.send('another task');
  ackKeys(vm, [lastKey(vm)], { chats: busyChats });
  vm.advance(22.4);
  assert.equal(progress(), 3, 'busy for less than 30 s');
  vm.advance(8);
  assert.equal(progress(), 4);
  vm.run('NS.R.progress.session = 30; NS.R.progress.perRun = {}');
  vm.advance(300);
  assert.equal(progress(), 4, 'at most 30 per UI session');
});

test('slot-only mode: loads 5, 12, 25 and 45 s after a send, then every 30 s while it\'s busy, 3 s after a stop, and every 10 minutes when idle', () => {
  const vm = newVM({ signals: false }).login();
  vm.slot(slotLua({ push: 1 }));
  vm.advance(3.1 + 8.5);
  assert.equal(vm.num('NS.R.slots.reasons.hello'), 1, 'the hello answer, read once');
  const base = vm.loads();
  vm.send('do the thing');
  const since = () => vm.loads() - base;
  vm.advance(4.5);
  assert.equal(since(), 0);
  vm.advance(1);
  assert.equal(since(), 1);
  vm.advance(7);
  assert.equal(since(), 2);
  vm.advance(13);
  assert.equal(since(), 3);
  vm.advance(20);
  assert.equal(since(), 4);
  // Still busy after the schedule: a load every 30 s (rule 4's tail), so a long run's reply isn't left for the idle check.
  vm.advance(29);
  assert.equal(since(), 4);
  vm.advance(3);
  assert.equal(since(), 5);
  vm.advance(31.5);
  assert.equal(since(), 6);
  assert.equal(vm.num('NS.R.slots.reasons.busy'), 2);
  vm.slash('stop');
  vm.advance(2.5);
  assert.equal(since(), 6);
  vm.advance(1);
  assert.equal(since(), 7);
  assert.equal(vm.num('NS.R.slots.reasons.stop'), 1);
  // The run is over: the send is acked and answered, and the follow-ups stop.
  const id = activeId(vm);
  apply(vm, slotLua({ acked: [lastKey(vm)], records: [replyRec(1, id, 'stopped')], chats: `{ { id = "${id}", busy = false, queued = 0 } }` }));
  // The other sends were seen running, and now the chat is idle: they're done.
  apply(vm, slotLua({ acked: vm.json('NS.Chats.Active().pending').map(p => p.key), chats: `{ { id = "${id}", busy = true, queued = 0 } }` }));
  apply(vm, slotLua({ chats: `{ { id = "${id}", busy = false, queued = 0 } }` }));
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Active())'), false);
  // The idle check runs on the 2-second tick: 10 minutes after the last load.
  const before = vm.loads();
  vm.advance(596);
  assert.equal(vm.loads(), before);
  vm.advance(6);
  assert.equal(vm.loads(), before + 1);
  assert.equal(vm.num('NS.R.slots.reasons.idle'), 1);
  vm.advance(595);
  assert.equal(vm.num('NS.R.slots.reasons.idle'), 1);
  vm.advance(8);
  assert.equal(vm.num('NS.R.slots.reasons.idle'), 2);
});

// [code health AD-17] A send's strip clocks (sentAt, vis, missed, carried) stayed all session after its
// ack (a Discard cleared them), and the reload inbox's table stayed in a global all session.
test('an ack clears its send\'s strip clocks as a Discard does, while slot-only follow-ups still time an acked run by its send; the reload inbox is read once and let go (code health AD-17)', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  vm.send('ping');
  const key = lastKey(vm);
  vm.advance(1);
  assert.notEqual(vm.evaluate(`NS.R.sentAt["${key}"]`), null);
  ackKeys(vm, [key]);
  for (const t of ['sentAt', 'vis', 'missed', 'carried']) assert.equal(vm.evaluate(`NS.R.${t}["${key}"]`), null, t);
  // Slot-only: the schedule's first load acks the send and the run goes on: a follow-up every 30 s still.
  const so = newVM({ signals: false }).login();
  so.slot(slotLua({ push: 1 }));
  so.advance(3.1 + 8.5);
  const base = so.loads();
  so.send('do the thing');
  const sent = lastKey(so);
  so.slot(slotLua({ acked: [sent], chats: `{ { id = "${activeId(so)}", busy = true, queued = 0 } }` }));
  so.advance(46); // the schedule: 5, 12, 25 and 45 s after the send
  assert.equal(so.loads() - base, 4);
  assert.equal(so.evaluate(`NS.R.sentAt["${sent}"]`), null, 'acked at the first');
  assert.equal(so.bool('NS.Chats.IsBusy(NS.Chats.Active())'), true, 'its run goes on');
  so.advance(32);
  assert.equal(so.loads() - base, 5, 'a follow-up 30 s on, for the acked run');
  // The reload inbox: read at login, then let go.
  const vi = newVM({ inbox: 'NQA_Inbox = ' + slotLua({ push: 3 }) }).login();
  assert.equal(vi.num('NS.R.push.known'), 3, 'read');
  assert.equal(vi.evaluate('NQA_Inbox'), null, 'and let go');
});

test('self-test: static (present plays, absent_* doesn\'t) and live (the hello answer\'s ring); a failure means slot-only mode', () => {
  const ok = confirmHello(newVM().login());
  assert.equal(ok.evaluate('NS.R.sig.static'), 'ok');
  assert.equal(ok.evaluate('NS.R.sig.live'), 'ok');
  assert.equal(ok.bool('NS.Transport.SlotOnly()'), false);

  // A client where every file "plays" (the case that would fake every ack).
  const all = newVM({ extra: 'function PlaySoundFile(path) return true, 1 end' }).login();
  assert.equal(all.evaluate('NS.R.sig.static'), 'absent-plays');
  all.advance(3.1);
  assert.match(all.stripWires()[0], /;sig=absent-plays;/);
  all.send('hello');
  all.advance(3);
  assert.equal(all.outboxWires().length, 1, 'no false ack');

  // Live fails: the bridge says it handled our nonce, but no push ring was heard.
  const live = newVM().login();
  live.advance(3.1);
  const nonce = live.evaluate('NS.R.nonce');
  live.slot(slotLua({ nonce }));
  live.advance(29);
  assert.equal(live.loads(), 0);
  live.advance(3);
  assert.equal(live.loads(), 1, 'one load settles it (the hello answer)');
  assert.equal(live.evaluate('NS.R.sig.live'), 'fail');
  assert.equal(live.bool('NS.Transport.SlotOnly()'), true);
  assert.match(live.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), /the game can't hear the sound that says a reply is ready/, 'a notice, not a line saved in the chat');
  assert.match(live.evaluate('select(2, NS.Transport.Light())'), /\nReplies arrive more slowly for now\. A \/reload usually fixes it\.$/);

  // The static part runs again every 60 s, and when a Sound_* CVar changes.
  const retry = newVM({ signals: false }).login();
  assert.equal(retry.evaluate('NS.R.sig.static'), 'present-missing');
  retry.signal('ctl', 'present').advance(61);
  assert.equal(retry.evaluate('NS.R.sig.static'), 'ok');
  retry.signal('ctl', 'present', false);
  retry.run('STUB.FireEvent("CVAR_UPDATE", "Sound_EnableSFX")');
  assert.equal(retry.evaluate('NS.R.sig.static'), 'present-missing');
  retry.run('STUB.FireEvent("CVAR_UPDATE", "cameraDistanceMax")');
  assert.ok(retry.num('NS.R.absentCount') >= 3, 'a fresh absent_* name every run');
});

test('alive: a pulse on either alive bell is the bridge\'s beat', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.epoch = 1790359440 - 1000' }).login());
  vm.run('NS.R.bridgeSeenAt = nil');
  vm.advance(2.1);
  beat(vm);
  assert.ok(vm.num('NS.Transport.BridgeAge()') < 1);
  vm.advance(100);
  assert.ok(vm.num('NS.Transport.BridgeAge()') > 99);
  beat(vm);
  assert.ok(vm.num('NS.Transport.BridgeAge()') < 1, 'the other bell of the pair counts too');
  assert.equal(vm.num('NS.R.bells.alive_a.rings') + vm.num('NS.R.bells.alive_b.rings'), 2);
});

test('self-test: with all sound off the channel reports nothing, which reads as sound-off', () => {
  const vm = newVM({ extra: 'STUB.cvars.Sound_EnableAllSound = "0"; function PlaySoundFile() return nil end' }).login();
  assert.equal(vm.evaluate('NS.R.sig.static'), 'sound-off');
  vm.advance(3.1);
  assert.match(vm.stripWires()[0], /;sig=sound-off;/);
  assert.equal(vm.bool('NS.Transport.SlotOnly()'), true);
});

// --------------------------------------------------------------------------
// Applying records (§4.3)
// --------------------------------------------------------------------------

test('apply: the shared vector slot, written by the bridge\'s encoder, applies in seq order; replay = 1 is silent', async () => {
  const { luaenc } = await bridge();
  const vm = vectorVM('a3f1').login();
  vm.advance(3.1);
  vm.send('fastest way to Hyjal from here?');
  vm.send('and back?');
  assert.deepEqual(vm.outboxWires().map(e => e.key), ['a3f1_1', 'a3f1_2']);
  vm.slotText(luaenc.slotTable('NQA_SlotData', V.slot).text);
  ring(vm).advance(0.3); // rule 2: the hello answer is this slot
  assert.equal(vm.loads(), 1);
  assert.equal(vm.num('NQADB.cursor'), 514);
  const h = vm.history();
  assert.deepEqual(h.map(e => e.role), ['user', 'user', 'assistant', 'system', 'assistant']);
  assert.equal(h[2].text, V.slot.records[0].text, 'agent text kept exactly as the bridge escaped it');
  assert.equal(h[2].mid, 'byok:c3f9a1e:1790359430');
  assert.equal(h[2].summary, 'Fly from Thunder Bluff.');
  assert.equal(h[3].text, V.slot.records[1].text);
  assert.equal(h[3].kind, 'stop');
  assert.equal(h[4].text, 'replayed');
  assert.equal(vm.outboxWires().length, 0, 'bridge.acked acked both sends');
  assert.equal(vm.num('NS.R.acks.slot'), 2);
  // One ping for the batch; the replayed record made no sound, toast or echo.
  assert.deepEqual(played(vm), [844]);
  assert.equal(vm.num('STUB.flashed'), 1);
  const chat = vm.chatLines();
  assert.equal(chat.length, 2, 'an echo for the reply and one for the error, none for the replay');
  assert.equal(chat[0], `|cff7ec8ff[NeverQuestAlone · Hyjal route]|r Fly from Thunder Bluff.  |cff7ec8ff|Haddon:NeverQuestAlone:open:${CHAT}|h[Open]|h|r |cff55ff55|Haddon:NeverQuestAlone:reply:${CHAT}|h[Reply]|h|r`);
  assert.match(chat[1], /^\|cff7ec8ff\[NeverQuestAlone · Hyjal route\]\|r \|cffff7070Nothing was running\.\|r {2}/);
  assert.ok(!chat.join('\n').includes('replayed'));
  assert.equal(vm.num('NQADB.chats[1].unread'), 2, 'the reply and the error, not the replay');
  // With the HUD on (the default), the HUD shows it: no toast.
  assert.equal(vm.evaluate('NQAToast1'), null);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says', 'the newest entry in the chat');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Still working on your next message.');
  // The agents list names NeverQuestAlone: the title says it; the header names the chat's model
  // (none reported here). The window draws them, and its bubbles, once it shows (code health AD-05).
  vm.run('NS.UI.Toggle(true)');
  assert.equal(vm.evaluate('NQADB.agentNames.main'), 'NeverQuestAlone');
  assert.equal(vm.evaluate('NS.UI.ui.title.text'), 'NeverQuestAlone');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'No model yet');
  // The bubble shows the text as it came; the working bubble shows the snapshot's
  // tool title with its | doubled (it isn't escaped by the bridge).
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[3].body.text'), V.slot.records[0].text);
  assert.match(vm.evaluate('NS.UI.ui.work.text.text'), /^Working · 7 actions · .+ · A title with "quotes" \|\| a pipe$/);
  assert.equal(vm.evaluate('NS.Transport.Light()'), 'green');
  assert.equal(vm.num('NS.R.push.known'), 137);
});

test('a cursor rollback (a client crash) replays silently: nothing pings twice', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  const crashPoint = vm.saved(); // the saved data as of the last /reload
  apply(vm, slotLua({ records: [replyRec(1, id, 'first answer'), replyRec(2, id, 'second answer')] }));
  assert.equal(played(vm).length, 1);
  assert.equal(vm.chatLines().length, 2);
  // The client crashes: the saved data rolls back to cursor 0. The bridge has had
  // cursor 2 reported, so records 1 and 2 come back with replay = 1.
  const vm2 = newVM({ now: vm.num('STUB.now'), db: 'NQADB = ' + crashPoint, sounds: vm.sounds(), seed: 11 }).login();
  confirmHello(vm2);
  assert.equal(vm2.num('NQADB.cursor'), 0);
  apply(vm2, slotLua({ records: [replyRec(1, id, 'first answer', ', replay = 1'), replyRec(2, id, 'second answer', ', replay = 1'), replyRec(3, id, 'third answer')] }));
  assert.equal(vm2.num('NQADB.cursor'), 3);
  assert.deepEqual(vm2.history().map(e => e.text), ['first answer', 'second answer', 'third answer'], 'history catches up silently');
  assert.equal(played(vm2).length, 1, 'one ping, for record 3 only');
  assert.equal(vm2.chatLines().length, 1);
  assert.match(vm2.chatLines()[0], /third answer/);
  assert.equal(vm2.num('NQADB.chats[1].unread'), 1);
  // The same records again are at or below the cursor: nothing.
  apply(vm2, slotLua({ records: [replyRec(3, id, 'third answer')] }));
  assert.equal(played(vm2).length, 1);
  assert.equal(vm2.history().length, 3);
});

test('a slot for another install token applies no records, but its gw, agents and chats are used', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  vm.send('mine');
  const key = lastKey(vm);
  apply(vm, slotLua({ token: 'deadbeef', acked: [key], records: [replyRec(7, id, 'not yours')], gw: '{ state = "connecting", queued = 3 }', chats: `{ { id = "${id}", busy = true } }` }));
  assert.equal(vm.num('NQADB.cursor'), 0);
  assert.equal(vm.history().length, 1);
  assert.equal(played(vm).length, 0);
  assert.equal(vm.outboxWires().length, 1, 'another install\'s acks aren\'t ours');
  assert.equal(vm.evaluate('NS.R.mismatch'), 'deadbeef');
  assert.equal(vm.evaluate('NS.R.gw.state'), 'connecting');
  assert.equal(vm.evaluate('NQADB.agentNames.coder'), 'Coder');
  assert.equal(vm.bool(`NS.R.snap["${id}"].busy`), true);
  vm.slash('diag');
  assert.match(notice(vm), /another install \(token hidden\)/, 'the token only with /nqa diag full (UX-7)');
  vm.slash('diag full');
  assert.match(notice(vm), /another install \(token deadbeef\)/);
});

test('an unsolicited reply (a subagent result) applies with nothing pending and notifies; a waiting send stays pending', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Subagent finished: sponsor recap')] }));
  assert.equal(vm.lastHistory().text, 'Subagent finished: sponsor recap');
  assert.deepEqual(played(vm), [844]);
  assert.equal(vm.num('STUB.flashed'), 1);
  assert.equal(vm.chatLines().length, 1);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says', 'the HUD shows it (no toast while it is on)');
  // A send the bridge hasn't acked yet stays pending when another reply lands.
  vm.send('next question');
  const key = lastKey(vm);
  apply(vm, slotLua({ records: [replyRec(2, id, 'another subagent result')] }));
  assert.equal(vm.num('#NQADB.chats[1].pending'), 1);
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Active())'), true);
  // Once acked, the next answer is its answer.
  ackKeys(vm, [key]);
  apply(vm, slotLua({ records: [replyRec(3, id, 'the answer')] }));
  assert.equal(vm.num('#NQADB.chats[1].pending'), 0);
  assert.equal(played(vm).length, 3);
});

test('records for an unknown chat and record types of later milestones are counted, not applied; the cursor moves on', () => {
  const vm = confirmHello(newVM().login());
  apply(vm, slotLua({ records: [replyRec(1, 'c0ffee1', 'lost'), '{ seq = 2, t = "notice", src = "cron", title = "daily-brief finished", text = "x" }'] }));
  assert.equal(vm.num('NQADB.cursor'), 2);
  assert.equal(vm.num('NS.R.orphans'), 1);
  assert.equal(vm.num('NS.R.skipped'), 1);
  assert.equal(vm.num('#NQADB.chats'), 1, 'no chat created');
  assert.equal(played(vm).length, 0);
});

test('errors and aborts are system bubbles; an abort you asked for is silent; more > 0 is noted', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  const sendAcked = text => {
    if (text === 'stop') vm.slash(text); else vm.send(text);
    const key = lastKey(vm);
    ackKeys(vm, [key]);
    return key;
  };
  sendAcked('research this');
  apply(vm, slotLua({ records: [`{ seq = 1, t = "error", chat = "${id}", kind = "gateway", text = "The service is unreachable." }`] }));
  let last = vm.lastHistory();
  assert.deepEqual([last.role, last.kind, last.text], ['system', 'gateway', 'The service is unreachable.']);
  assert.equal(played(vm).length, 1, 'errors ping');
  assert.equal(vm.bool('NS.Chats.IsBusy(NS.Chats.Active())'), false);
  // /nqa stop, then its aborted record: a bubble, no ping.
  sendAcked('try again');
  sendAcked('stop');
  vm.run('NS.UI.Toggle(true)'); // the working line is drawn while the window shows (code health AD-05)
  assert.match(vm.evaluate('NS.UI.ui.work.text.text'), /^Stopping · /);
  vm.run('NS.UI.Toggle(false)');
  apply(vm, slotLua({ records: [`{ seq = 2, t = "aborted", chat = "${id}", kind = "user", text = "Stopped." }`] }));
  last = vm.lastHistory();
  assert.deepEqual([last.kind, last.text], ['aborted', 'Stopped.']);
  assert.equal(played(vm).length, 1, 'no ping for the abort you asked for');
  // An abort nobody here asked for pings.
  sendAcked('third try');
  apply(vm, slotLua({ records: [`{ seq = 3, t = "aborted", chat = "${id}", kind = "user", text = "Stopped from the Control UI." }`] }));
  assert.equal(played(vm).length, 2);
  // more > 0
  apply(vm, slotLua({ records: [replyRec(4, id, 'Long answer, first part.', ', more = 2345')] }));
  vm.run('NS.UI.Toggle(true)');
  const n = vm.num('#NS.Chats.Active().history');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${n}].body.text`),
    'Long answer, first part.\n\n|cff9d9d9d(… the rest didn\'t fit in the window: ask for it)|r', 'no count: ask NeverQuestAlone for the rest (UXC-UI-20)');
});

// --------------------------------------------------------------------------
// Status, notifications, do-not-disturb
// --------------------------------------------------------------------------

// [code health AD-05, AD-18] A slot load with an ack and a reply ran 4 full renders, each drawing the
// chat list and up to 100 bubbles with the window closed; the 2-second status tick redrew the window's
// header, the small bar, the banner and the HUD's lines with nothing changed.
test('with the window closed a reply draws no chat list or bubble and a slot load renders once less; opening the window shows it all; a status tick with nothing new sets no text (code health AD-05, AD-18)', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  vm.run(`local U = NS.UI
    for name, k in pairs({ RenderList = "list", RenderTranscript = "transcript", Render = "render" }) do
      local real = U[name]
      U[name] = function(what, ...) if what ~= "status" then STUB.drawn[k] = STUB.drawn[k] + 1 end; return real(what, ...) end
    end`); // full renders (the 2-second tick's status ones aside)
  const reset = () => vm.run('STUB.drawn = { list = 0, transcript = 0, render = 0 }');
  const id = activeId(vm);
  reset();
  vm.send('where now?');
  assert.deepEqual(vm.json('STUB.drawn'), { list: 0, transcript: 0, render: 1 }, 'a send: one render, no list or bubbles');
  // The ack and the reply in one slot, which a ring announces.
  reset();
  vm.slot(slotLua({ acked: [lastKey(vm)], push: 0, nonce: vm.evaluate('NS.R.nonce'), records: [replyRec(1, id, 'North, past the inn.')] }));
  ring(vm);
  vm.advance(1.6);
  vm.run('STUB.onLoadAddOn = nil');
  assert.equal(vm.lastHistory().text, 'North, past the inn.');
  assert.deepEqual(vm.json('STUB.drawn'), { list: 0, transcript: 0, render: 3 }, 'the ack, the news and the slot: no list, no bubbles, and no fourth render');
  // Opening the window draws everything, the new reply too.
  vm.run('NS.UI.Toggle(true)');
  assert.ok(vm.num('STUB.drawn.list') === 1 && vm.num('STUB.drawn.transcript') === 1, 'opening it renders the list and the transcript');
  const n = vm.num('#NS.Chats.Active().history');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${n}].body.text`), 'North, past the inn.');
  assert.equal(vm.evaluate('NS.UI.ui.rows[1].label.text'), vm.evaluate('NS.Chats.Active().name'));
  // Closed again, with nothing new: a status tick sets no text anywhere (the HUD's lines, the small
  // bar, the banner; the window's header waits for it to open).
  vm.run('NS.UI.Toggle(false)');
  vm.advance(2.1);
  vm.run('STUB.texts = {}; NS.Refresh("status"); NS.Refresh("status"); NS.Refresh()');
  assert.deepEqual(vm.list('STUB.texts'), [], 'nothing new, nothing drawn');
  // Something new is drawn at once: a reply on the HUD's lines.
  apply(vm, slotLua({ records: [replyRec(2, id, 'Then west to the river.', ', summary = "West to the river."')] }));
  assert.ok(vm.list('STUB.texts').includes('West to the river.'), 'the HUD shows the new reply');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

test('the status light: green, yellow (the app\'s own state: connecting, a rejected key; messages waiting), red after 2 min of silence; PRD §8.3 tooltips', () => {
  const vm = newVM({ extra: 'STUB.epoch = 1790359440 - 1000' }).login();
  const light = () => vm.json('{ NS.Transport.Light() }');
  assert.deepEqual(light(), ['wait', 'Waiting to hear from the NeverQuestAlone app…']);
  vm.advance(2.1); // the bells' first reads
  beat(vm);
  assert.deepEqual(light(), ['yellow', 'The NeverQuestAlone app is running. Waiting for its first report…']);
  apply(vm, slotLua());
  assert.equal(light()[0], 'green');
  assert.match(light()[1], /^Connected to your AI\. Last heard from the NeverQuestAlone app \d+ seconds? ago\.$/, 'no machine\'s name (EX-01)');
  apply(vm, slotLua({ gw: '{ state = "connecting", queued = 0 }' }));
  assert.deepEqual(light(), ['yellow', "The NeverQuestAlone app is running but can't reach your AI: connecting."]);
  apply(vm, slotLua({ gw: '{ state = "key_invalid", reason = "key rejected", queued = 2 }' }));
  assert.deepEqual(light(), ['yellow', "The NeverQuestAlone app is running but can't reach your AI: key rejected. 2 messages wait."]);
  vm.advance(124); // 2 min, and the next 2-second redraw
  assert.deepEqual(light(), ['red', 'No word from the NeverQuestAlone app for 2 minutes. Is it running?']);
  assert.equal(vm.evaluate('NQALight.icon.texture'), 'Interface\\FriendsFrame\\StatusIcon-DnD');
  assert.equal(vm.evaluate('NQALight.tip').split('\n')[0], 'No word from the NeverQuestAlone app for 2 minutes. Is it running?');
  assert.equal(vm.evaluate('NQAMiniLight.icon.texture'), 'Interface\\FriendsFrame\\StatusIcon-DnD', 'the mini bar shows it too');
  // Nothing at all since login: red after 2 min as well.
  const quiet = newVM().login();
  quiet.advance(125);
  assert.equal(quiet.evaluate('NS.Transport.Light()'), 'red');
});

test('combat do-not-disturb: only the badge moves in combat; the rest arrives within 3 s after, one line past three', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('hud off'); // toasts are for when the HUD is off
  vm.run('STUB.chat = {}');
  const id = activeId(vm);
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  apply(vm, slotLua({ records: [replyRec(1, id, 'one'), replyRec(2, id, 'two')] }));
  assert.equal(played(vm).length, 0);
  assert.equal(vm.chatLines().length, 0);
  assert.equal(vm.num('STUB.flashed'), 0);
  assert.equal(vm.evaluate('NQAToast1'), null, 'no toast');
  assert.equal(vm.num('NQADB.chats[1].unread'), 2, 'the badge moves');
  assert.match(vm.evaluate('NS.UI.ui.miniBadge.text'), /2 new/);
  vm.advance(30);
  assert.equal(played(vm).length, 0, 'still in combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(0.5);
  assert.equal(played(vm).length, 0);
  vm.advance(2.4);
  assert.equal(played(vm).length, 1, 'delivered within 3 s of the fight ending');
  assert.equal(vm.chatLines().length, 2);
  assert.equal(vm.num('STUB.flashed'), 1);
  assert.deepEqual([vm.evaluate('NQAToast1.shown'), vm.evaluate('NS.UI.ui.toastOrder[1].line.text'), vm.evaluate('NQAToast2')], ['true', 'two', null],
    'one banner: the newest takes its place');
  // More than three: one sound, one toast, one line.
  vm.slash('new Sponsor');
  const id2 = activeId(vm);
  vm.run('STUB.chat = {}; STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  apply(vm, slotLua({ records: [replyRec(3, id, 'a'), replyRec(4, id2, 'b'), replyRec(5, id, 'c'), replyRec(6, id2, 'd'), replyRec(7, id, 'e')] }));
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(3);
  assert.equal(played(vm).length, 2);
  assert.equal(vm.chatLines().length, 1);
  assert.equal(vm.chatLines()[0], `|cff7ec8ff[NeverQuestAlone]|r 5 replies arrived during combat: Chat 1 (3), Sponsor (2)  |cff7ec8ff|Haddon:NeverQuestAlone:open:${id}|h[Open]|h|r |cff55ff55|Haddon:NeverQuestAlone:reply:${id}|h[Reply]|h|r`);
  assert.equal(vm.evaluate('NS.UI.ui.toastOrder[1].line.text'), '5 replies arrived during combat');
  // Only errors: the count says errors, never replies (UXC-UI-19).
  const ve = newVM().login();
  ve.run('local c = NS.Chats.Active(); local n = {} for i = 1, 4 do n[i] = { chat = c.id, kind = "error", text = "NeverQuestAlone is offline." } end NS.Notify.DeliverCollapsed(n)');
  assert.match(ve.chatLines().at(-1), /\]\|r 4 errors arrived during combat: /);
  // /nqa dnd combat off: pings right away.
  vm.slash('dnd combat off');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  apply(vm, slotLua({ records: [replyRec(8, id, 'now')] }));
  assert.equal(played(vm).length, 3);
});

test('low slots: a banner at 25 free with a Reload button (the click reloads), hidden in combat; at 0 free, the reload path', () => {
  const vm = newVM({ extra: 'for i = 1, 175 do STUB.loaded[string.format("NQA_S%03d", i)] = true end' }).login();
  assert.equal(vm.num('NS.R.slots.free'), 25);
  vm.run('NS.UI.Toggle(true)');
  assert.equal(vm.evaluate('NQABanner.shown'), 'true');
  assert.equal(vm.evaluate('NQABanner.text.text'), 'Reload soon: 25 more replies fit before the next reload.');
  assert.match(vm.evaluate('NS.UI.ui.miniBadge.text'), /Reload soon/);
  vm.run('NS.R.slots.free = 1; NS.Refresh("all")');
  assert.equal(vm.evaluate('NQABanner.text.text'), 'Reload soon: 1 more reply fits before the next reload.', 'one reply, one verb');
  vm.run('NS.R.slots.free = 25; NS.Refresh("all")');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(vm.evaluate('NQABanner.shown'), 'false', 'hidden in combat');
  vm.run('local b = NS.UI.ui.banner.reload; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('STUB.reloaded'), 'false', 'no reload during combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(3);
  assert.equal(vm.evaluate('STUB.reloaded'), 'false', 'never from PLAYER_REGEN_ENABLED or a timer (upstream #7)');
  assert.equal(vm.evaluate('NQABanner.shown'), 'true');
  // Minimized, the banner hangs under the mini bar.
  vm.run('NS.UI.Minimize(true)');
  vm.advance(2.1);
  assert.equal(vm.evaluate('NQABanner.shown'), 'true');
  vm.run('local b = NS.UI.ui.banner.reload; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true', 'the click is the hardware event');

  // 0 free: the reload path until the reload (RV-4).
  const vm0 = newVM({ extra: 'for i = 1, 200 do STUB.loaded[string.format("NQA_S%03d", i)] = true end' }).login();
  assert.equal(vm0.bool('NS.R.reloadFallback'), true);
  assert.match(vm0.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), /Reload to keep going: messages and replies wait until you do\. Type \/reload when you're ready\./);
  vm0.advance(3.1);
  assert.equal(vm0.strip(), null, 'no strip: the hello waits in the outbox');
  vm0.send('still there?');
  assert.equal(vm0.strip(), null);
  assert.deepEqual(vm0.outboxWires().map(e => e.key.includes('_')), [false, true], 'the hello (key = nonce), then the msg');
  vm0.run('NS.UI.Toggle(true)');
  assert.equal(vm0.evaluate('NQABanner.text.text'), 'Reload to keep going: messages and replies wait until you do.');
  assert.match(vm0.evaluate('NS.UI.StatusText()'), /Reload to keep going: messages and replies wait until you do\./, 'the status line says it the same way (C-116)');
  vm0.run('NS.UI.RenderMini()');
  assert.match(vm0.evaluate('NS.UI.ui.miniBadge.text'), /Reload now/);
  vm0.signal('push', '5').advance(20);
  assert.equal(vm0.loads(), 0, 'nothing tries to load a slot');
  // After the reload every slot is free and the msg goes out on the strip.
  const vm1 = reloadVM(vm0).login();
  assert.equal(vm1.num('NS.R.slots.free'), 200);
  assert.equal(vm1.bool('NS.R.reloadFallback'), false);
  assert.ok(vm1.stripWires().some(w => w.endsWith('\x1fstill there?')));
  assert.equal(vm1.outboxWires().length, 1, 'last session\'s hello entry is gone');
});

test('reload path: mode reload and stream mode keep hex records in db.outbox that the bridge parses; the inbox acks them', async () => {
  const { records } = await bridge();
  const vm = confirmHello(newVM().login());
  vm.slash('mode reload');
  assert.equal(vm.evaluate('NQADB.settings.mode'), 'reload');
  vm.send('by the reload path');
  // The mode seen that says the strip is no longer the way out stays its 5 s (DR-08), then the strip goes.
  vm.advance(5.1);
  assert.equal(vm.strip(), null, 'nothing drawn');
  const e = vm.outboxWires().pop();
  const p = records.parseRecord(e.wire);
  assert.equal(p.ok, true);
  assert.equal(p.record.type, 'msg');
  assert.equal(p.record.key, e.key);
  assert.equal(p.record.text, 'by the reload path');
  assert.equal(p.record.token, vm.evaluate('NQADB.token'));
  assert.equal(p.record.args.q, 'followup');
  vm.run('NS.UI.Toggle(true)');
  assert.equal(vm.evaluate('NQABanner.text.text'), '1 message waits for a reload to go out.');
  assert.match(vm.evaluate('NS.UI.ui.work.text.text'), /^Waiting for a reload to go out$/);
  // Nothing but a click or a typed command reloads.
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(1800);
  assert.equal(vm.evaluate('STUB.reloaded'), 'false');
  vm.slash('reload');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  // After the reload, NQA_Inbox acks it and carries the answer.
  const id = activeId(vm);
  const inbox = 'NQA_Inbox = ' + slotLua({ push: 9, acked: [e.key], records: [replyRec(1, id, 'got it via reload')] });
  const vm2 = reloadVM(vm, { inbox }).login();
  assert.equal(vm2.outboxWires().length, 0);
  assert.equal(vm2.num('NS.R.acks.inbox'), 1);
  assert.equal(vm2.lastHistory().text, 'got it via reload');
  assert.equal(vm2.num('NS.R.push.known'), 9, 'the inbox gives the push counter');
  assert.equal(vm2.loads(), 0, 'mode reload loads no slots');

  // Stream mode: the same way out, and no strip even for the hello.
  const vm3 = newVM({ db: 'NQADB = { settings = { stream = true } }' }).login();
  vm3.advance(3.1);
  assert.equal(vm3.strip(), null);
  const hello = vm3.outboxWires()[0];
  assert.equal(records.parseRecord(hello.wire).record.type, 'hello');
  assert.equal(hello.key, vm3.evaluate('NS.R.nonce'));
  vm3.send('streaming now');
  assert.equal(vm3.strip(), null);
  assert.equal(vm3.outboxWires().length, 2);
  vm3.slash('stream off');
  assert.ok(vm3.stripWires().some(w => w.endsWith('\x1fstreaming now')), 'back on the strip');
});

// [code health BR-02, the addon half] The outbox had no cap: a macro or a loop could queue paid
// messages without end for the reload path, which hands them all to the app in one write.
test('at most 20 typed messages wait for their ack, on the strip or for a reload: the next is refused in that mode\'s words, kept nowhere but the box (through a reload too); acked, typing goes again (code health BR-02)', () => {
  const typed = vm => vm.outboxWires().filter(e => e.wire.split('\x1f')[3] === 'msg');
  // On the strip: a loop at machine speed fills the outbox in one frame, before any ack.
  const vm = confirmHello(newVM().login());
  for (let i = 1; i <= 25; i++) vm.send(`loop ${i}`);
  assert.equal(typed(vm).length, 20, 'the outbox stops at 20');
  assert.equal(vm.history().filter(e => e.role === 'user').length, 20, 'the refused ones are in no history');
  // With Screen Reading on they go as the app reads them: no reload to ask for.
  assert.equal(notice(vm), 'Not sent: 20 messages are still sending. Send your message again once they\'ve gone out.');
  assert.equal(vm.evaluate('select(2, NS.Chats.Send("loop 26"))'), '20 messages are still sending. Send yours again soon.', 'the short words, for the HUD\'s line');
  // A stop and a rename aren't typed messages: they still go.
  const n = vm.outboxWires().length;
  vm.slash('stop');
  vm.slash('rename Looped');
  assert.equal(vm.outboxWires().length, n + 2);
  // The app acks them: typing goes again.
  ackKeys(vm, typed(vm).map(e => e.key));
  assert.equal(typed(vm).length, 0);
  vm.send('after the acks');
  assert.equal(typed(vm).length, 1);
  assert.equal(vm.lastHistory().text, 'after the acks');

  // The reload path: the same 20, and a reload's inbox that acks them frees the way.
  const r = confirmHello(newVM().login());
  r.slash('mode reload');
  for (let i = 1; i <= 20; i++) r.send(`reload loop ${i}`);
  // The 21st, typed in the window: refused in the banner's words and count, its words kept in the box.
  r.run('NS.UI.Toggle(true); NS.UI.ui.input:SetText("one more, please"); NS.UI.SendFromInput()');
  assert.equal(typed(r).length, 20);
  assert.equal(notice(r), 'Not sent: 20 messages wait for a reload to go out. Click Reload above the window to send them.');
  assert.equal(r.evaluate('NQABanner.text.text'), '20 messages wait for a reload to go out.', 'the banner above the window says the same');
  assert.equal(r.evaluate('select(2, NS.Chats.Send("loop 22"))'), 'Reload to send the others first.', 'the short words, for the HUD\'s line');
  assert.equal(r.evaluate('NS.UI.ui.input:GetText()'), 'one more, please');
  // Game Data unchecked for it, and words refused in the HUD's Ask box too.
  r.run('NS.R.skipGameData = true');
  r.run('NS.HUD.OpenReply(NS.QuickChat()); NS.HUD.h.replyBox:SetText("and from the HUD"); NS.HUD.SubmitAsk()');
  assert.equal(r.evaluate('NS.HUD.h.replyBox:GetText()'), 'and from the HUD', 'refused: the words stay');
  const keys = typed(r).map(e => e.key);
  r.slash('reload');
  r.run('STUB.FireEvent("PLAYER_LOGOUT")'); // as the client does at a reload, before it writes saved data
  const r2 = reloadVM(r, { inbox: 'NQA_Inbox = ' + slotLua({ push: 1, acked: keys }) }).login();
  assert.equal(r2.evaluate('NS.UI.ui.input:GetText()'), 'one more, please', 'the refused words are back in the box after the reload');
  assert.equal(r2.bool('NS.R.skipGameData'), true, 'with Game Data still unchecked for them');
  r2.run('NS.HUD.OpenReply(NS.QuickChat())');
  assert.equal(r2.evaluate('NS.HUD.h.replyBox:GetText()'), 'and from the HUD', 'the Ask box\'s words are back for their chat');
  assert.equal(r2.evaluate('NQADB.askDraft'), null, 'and gone from saved data');
  assert.equal(typed(r2).length, 0);
  r2.send('after the reload');
  assert.equal(typed(r2).length, 1);
  assert.deepEqual(r2.list('STUB.forbidden'), []);
});

test('commands: each one works, and free text that starts with a command word is sent as a message', () => {
  const vm = confirmHello(newVM().login());
  const sent = t => vm.outboxWires().some(e => e.wire.endsWith('\x1f' + t));
  const last = () => notice(vm);
  vm.slash('');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true', '/nqa toggles the window');
  vm.slash('');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'false');
  vm.slash('new Sponsor recap');
  assert.equal(vm.num('#NQADB.chats'), 2);
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Sponsor recap');
  vm.slash('chat 1');
  assert.equal(activeId(vm), vm.evaluate('NQADB.chats[1].id'));
  vm.slash('chat 2');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Chat 1', 'the newest chat is first in the list');
  vm.slash('chat sponsor recap');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Sponsor recap');
  vm.slash('chat');
  assert.equal(last(), 'Chats (/nqa chat <number> opens one):\n1. Sponsor recap  (current)\n2. Chat 1');
  vm.slash('rename Recap');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Recap');
  assert.equal(vm.outboxWires().length, 0, 'a chat that never sent needs no patch');
  vm.slash('rename');
  assert.equal(vm.evaluate('STUB.popup.which'), 'NQA_RENAME');
  vm.slash('echo full');
  assert.equal(vm.evaluate('NQADB.settings.echo'), 'full');
  assert.equal(last(), 'Replies in Your Chat Frame: Whole Reply. Settings has it too.');
  vm.slash('echo summary');
  vm.slash('context off');
  assert.equal(vm.evaluate('NQADB.settings.context'), 'false');
  assert.match(last(), /^Game Data with Messages: Off\. Your next message tells NeverQuestAlone to forget the game data sent before\./);
  vm.slash('context on');
  assert.match(last(), /^Game Data with Messages: On\. [\s\S]*Character: Testchar/);
  vm.slash('dnd combat off');
  assert.equal(vm.evaluate('NQADB.settings.dndCombat'), 'false');
  vm.slash('dnd combat on');
  assert.equal(vm.evaluate('NQADB.settings.dndCombat'), 'true');
  vm.slash('dnd instance on');
  assert.match(last(), /later version/);
  vm.slash('mode reload');
  assert.equal(vm.evaluate('NQADB.settings.mode'), 'reload');
  vm.slash('mode pixel');
  assert.equal(vm.evaluate('NQADB.settings.mode'), 'pixel');
  vm.slash('stream on');
  assert.equal(vm.evaluate('NQADB.settings.stream'), 'true');
  vm.slash('stream off');
  assert.equal(vm.evaluate('NQADB.settings.stream'), 'false');
  vm.slash('diag');
  const d = last();
  for (const s of ['Diagnostics:', 'Mode: pixel; doorbells on', 'Capture seen:', 'Self-test: static ok, live ok', 'Free slots: 199 of 200', 'Push:', 'Provider: no report from NeverQuestAlone yet', 'last beat', 'Outbox: 0 waiting', 'Cursor: 0 (reported 0)', 'Light: ']) {
    assert.ok(d.includes(s), s);
  }
  vm.slash('slots');
  assert.equal(last(), '199 of 200 parts are free this session (a reload frees them all).', 'no "slot" (UX-W13)');
  vm.slash('help');
  assert.match(last(), /\/br <message>/);
  vm.slash('help all');
  assert.match(last(), /\/nqa new \[name\]/);
  assert.match(last(), /\/nqa mode pixel\|r  Go back to screen reading/);
  assert.doesNotMatch(last(), /\bslots?\b/i, 'no "slot" in the help a player reads (UX-W13)');
  vm.slash('map');
  assert.ok(vm.list('STUB.prints').some(p => p.includes('[NeverQuestAlone]')));
  // [C-138] No upstream data addon's name; and no node pins to promise (code health AD-19).
  assert.ok(!vm.list('STUB.prints').some(p => p.includes('WoWAI_Nodes') || p.includes('Nodes:')));
  // /nqa model is a command: the model the app picked, once it says (no model here yet).
  vm.slash('model gpt');
  assert.equal(last(), 'The NeverQuestAlone app hasn\'t answered yet. Is it running?');
  // Nothing sent: the outbox holds only the mode seens the switches above left there (DR-08).
  assert.deepEqual(vm.outboxWires().filter(e => !/\x1fseen\x1f/.test(e.wire)), []);
  // Free text is a message, the old roadmap's words (reset, agent, steer…) among it.
  const free = ['delete the unused imports', 'stop the music', 'help me with this macro', 'chat with me about it', 'map out a route to Hyjal',
    'echo this back to me', 'context matters here', 'mode of transport?', 'reload the page please', 'diag nostics', 'reset the counter',
    'agent smith says hi', 'dnd means?', 'stream the game', 'copy that', 'slots are fun', 'watch out', 'more of that please',
    'reset', 'agent', 'agent coder', 'main on', 'attach sponsor thread', 'detach', 'inbox', 'watch cron on', 'quiet 30', 'more', 'rhook on', 'steer go left instead'];
  for (const [i, t] of free.entries()) {
    vm.slash(t);
    assert.ok(sent(t), t);
    // At most 20 typed messages wait for their ack (code health BR-02): the app acks them as it reads them.
    if (i % 10 === 9) ackKeys(vm, vm.outboxWires().filter(e => /\x1fmsg\x1f/.test(e.wire)).map(e => e.key));
  }
  assert.equal(vm.num('#NQADB.chats'), 2, 'nothing deleted');
  vm.slash('stop');
  assert.match(vm.outboxWires().pop().wire, /\x1fstop\x1f/);
  apply(vm, slotLua({ records: [replyRec(1, activeId(vm), 'copy me ||')] }));
  vm.slash('copy');
  assert.equal(vm.evaluate('NQACopy.shown'), 'true');
  assert.equal(vm.evaluate('NQACopyBox:GetText()'), 'copy me |');
  vm.slash('delete');
  assert.equal(vm.evaluate('STUB.popup.which'), 'NQA_DELETE', 'it asks first');
  vm.run('StaticPopupDialogs.NQA_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#NQADB.chats'), 1);
  assert.match(vm.outboxWires().pop().wire, /\x1fforget\x1f/);
  vm.run('SlashCmdList.BONES("reload")');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
});

test('sending: 2,900 bytes at most, shift-clicked links expanded, the chat named from its first message, Queue while busy', () => {
  const vm = confirmHello(newVM().login());
  vm.run('NS.UI.Toggle(true)');
  vm.run(`NS.UI.ui.input:SetText(${lstr('y'.repeat(2901))}); NS.UI.SendFromInput()`);
  assert.equal(vm.outboxWires().length, 0);
  assert.equal(notice(vm), 'That message is too long to send. Split it into shorter messages.');
  assert.equal(vm.num('#NS.UI.ui.input:GetText()'), 2901, 'the text stays in the box');
  vm.run('NS.UI.UpdateCounter()');
  assert.match(vm.evaluate('NS.UI.ui.counter.text'), /2901 \/ 2900/);
  vm.run(`NS.UI.ui.input:SetText(${lstr('z'.repeat(2900))}); NS.UI.SendFromInput()`);
  assert.equal(vm.outboxWires().length, 1, 'exactly 2,900 goes');
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '');
  const link = '|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r';
  vm.run('STUB.tooltips["item:2140:0:0:0:0:0:0:0:60:0:0"] = { "Fine Longsword", { "Main Hand", "Sword" }, { "17 - 33 Damage", "Speed 2.70" }, "Requires Level 14" }');
  vm.run(`NS.UI.ui.input:SetText("is this good for me? "); NS.UI.ui.input:ClearFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), 'is this good for me? ', 'without focus the shift-click keeps its meaning');
  vm.run(`NS.UI.ui.input:SetFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), 'is this good for me? ' + link);
  vm.run(`ChatEdit_InsertLink("${link}")`);
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), 'is this good for me? ' + link + link, 'the old name reaches the one hook once');
  vm.run(`NS.UI.ui.input:SetText("is this good for me? ${link}"); NS.UI.SendFromInput()`);
  const expected = ['is this good for me? [Fine Longsword]', '', '--- Linked from the game ---', '[Fine Longsword] item 2140 (Uncommon)',
    '  Fine Longsword', '  Main Hand  Sword', '  17 - 33 Damage  Speed 2.70', '  Requires Level 14'].join('\n');
  assert.ok(vm.outboxWires().pop().wire.endsWith('\x1f' + expected));
  assert.equal(vm.lastHistory().text, expected, 'the transcript shows what was sent');
  // Queue while busy: the button says so, the send is still q=followup, its bubble says queued.
  assert.equal(vm.evaluate('NS.UI.ui.send.text'), 'Queue');
  vm.send('and one more thing');
  const w = vm.outboxWires().pop();
  assert.match(w.wire, /;q=followup\x1f/);
  ackKeys(vm, [...vm.outboxWires().map(e => e.key), w.key]);
  const n = vm.num('#NS.Chats.Active().history');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${n}].who.text`), 'You · queued');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${n}].body.text`), 'and one more thing');
  // A fresh chat takes its name from its first message, which the bridge gets as name=.
  vm.slash('new');
  vm.send('route me to the Barrens please');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Route me to the Barrens');
  assert.match(vm.outboxWires().pop().wire, /;name=Route me to the Barrens;/);
});

test('game context: upstream\'s lines ride on the hello; a msg carries them when they changed; off sends an empty context once', async () => {
  const { records } = await bridge();
  const vm = newVM().login();
  vm.advance(3.1);
  const hello = records.parseRecord(vm.stripWires()[0]).record;
  assert.equal(hello.args.ctx, '1');
  assert.deepEqual(hello.body.split('\n'), [
    'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)',
    'Character: Testchar on Test Realm, level 23 Night Elf Hunter (Alliance), guild <Test Guild>',
    'Location: Duskwood - Darkshire',
    'Position: 45.2, 67.8 (map 1431)',
    'Money: 1g 23s 45c; XP: 1234/5000',
    'Talents: Beast Mastery 10 / Marksmanship 5 / Survival 0',
    'Professions: Skinning 75/75, First Aid 40/75',
  ]);
  ring(vm).advance(0.3);
  const lastMsg = () => records.parseRecord(vm.outboxWires().pop().wire).record;
  vm.send('same place');
  let m = lastMsg();
  assert.deepEqual([m.args.ctx, m.context, m.text], ['0', null, 'same place']);
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = ""; STUB.posX = 0.1');
  vm.send('where am I');
  m = lastMsg();
  assert.equal(m.args.ctx, '1');
  assert.ok(m.context.includes('Location: Elwynn Forest\n'));
  assert.ok(m.context.includes('Position: 10.0, 67.8 on Duskwood (map 1431)'));
  assert.equal(m.text, 'where am I');
  vm.slash('context off');
  vm.send('now without');
  m = lastMsg();
  assert.deepEqual([m.args.ctx, m.context, m.text], ['1', '', 'now without'], 'an empty context tells the bridge to drop it');
  vm.send('still without');
  assert.equal(lastMsg().args.ctx, '0');
  vm.slash('context on');
  vm.send('with again');
  m = lastMsg();
  assert.equal(m.args.ctx, '1');
  assert.ok(m.context.startsWith('Game: World of Warcraft: Forever'));
});

test('notifications: echo summary (default), full, short and off with [open] [reply] links; sound, toast, Dock flash; link clicks', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('hud off'); // toasts are for when the HUD is off
  const id = activeId(vm);
  let seq = 0;
  const reply = (text, summary = '') => {
    vm.run('STUB.chat = {}');
    seq += 1;
    apply(vm, slotLua({ records: [`{ seq = ${seq}, t = "reply", chat = "${id}", mid = "m${seq}", agent = "main", text = ${lstr(text)}, summary = ${lstr(summary)}, more = 0 }`] }));
    return vm.chatLines();
  };
  const links = `|cff7ec8ff|Haddon:NeverQuestAlone:open:${id}|h[Open]|h|r |cff55ff55|Haddon:NeverQuestAlone:reply:${id}|h[Reply]|h|r`;
  const prefix = '|cff7ec8ff[NeverQuestAlone · Chat 1]|r ';
  assert.equal(vm.evaluate('NQADB.settings.echo'), 'summary');
  assert.deepEqual(reply('Long line one\nLong line two\n\nTL;DR: Renamed foo.', 'Renamed foo. Tests pass.'), [`${prefix}Renamed foo. Tests pass.  ${links}`]);
  assert.deepEqual(reply('First line here.\nSecond line.'), [`${prefix}First line here.  ${links}`], 'no summary: the first line');
  vm.slash('echo short');
  assert.deepEqual(reply('Line one\nLine two'), [`${prefix}Line one Line two  ${links}`]);
  const longOne = reply('w'.repeat(300))[0];
  assert.ok(longOne.startsWith(prefix + 'w'.repeat(200) + ' …  '), 'short is one line of at most 200 bytes');
  vm.slash('echo full');
  assert.deepEqual(reply('Line one\nLine two\n\nLine three', 'Short.'), [`${prefix}Line one`, '    Line two', '    Line three', '    ' + links]);
  // A reply longer than the chat frame holds: the rest is in the window, with no byte count (UXC-UI-19).
  assert.ok(reply('word '.repeat(1200), 'Long.').some(l => l.includes('(… the rest is in the window: click [Open])')));
  vm.slash('echo off');
  assert.deepEqual(reply('quiet'), []);
  assert.equal(played(vm).length, seq, 'every reply played the note sound');
  assert.ok(played(vm).every(s => s === 844), 'a paper sound, not the whisper (3081)');
  assert.equal(vm.num('STUB.flashed'), seq, 'and flashed the Dock icon');
  assert.equal(vm.evaluate('NS.UI.ui.toastOrder[1].line.text'), 'quiet', 'the newest in the banner');
  // One banner, which stays until Okay (the owner: nothing goes by itself); Okay reads it and puts it away.
  // Without the game's top-centre widget frame, it hangs at TOP -30.
  assert.equal(vm.num('#NS.UI.ui.toastOrder'), 1);
  assert.deepEqual(vm.json('{ NS.UI.ui.toastOrder[1].anchor.point, NS.UI.ui.toastOrder[1].anchor.relPoint, NS.UI.ui.toastOrder[1].points.TOP.y }'), ['TOP', 'TOP', -30]);
  vm.advance(60);
  assert.equal(vm.num('#NS.UI.ui.toastOrder'), 1, 'still there a minute later');
  assert.ok(vm.num('NQADB.chats[1].unread') > 0);
  vm.run('local t = NS.UI.ui.toastOrder[1]; t.okay.scripts.OnClick(t.okay)');
  assert.deepEqual([vm.num('#NS.UI.ui.toastOrder'), vm.evaluate('NQAToast1.shown'), vm.num('NQADB.chats[1].unread')], [0, 'false', 0]);
  // A toast's Open opens its chat (the rest of it lets clicks through).
  reply('click me');
  assert.equal(vm.evaluate('NS.UI.ui.toastOrder[1].mouse'), 'false', 'click-through');
  vm.run('local t = NS.UI.ui.toastOrder[1]; t.open.scripts.OnClick(t.open)');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  // With the chat on screen there's no toast and no badge.
  const unread = vm.num('NQADB.chats[1].unread');
  reply('while watching');
  assert.equal(vm.num('#NS.UI.ui.toastOrder'), 0);
  assert.equal(vm.num('NQADB.chats[1].unread'), unread);
  // [open] and [reply]: one click, one action, though both routes fire.
  vm.run('NS.UI.Toggle(false); TOGGLES = 0; local real = NS.UI.Toggle; NS.UI.Toggle = function(...) TOGGLES = TOGGLES + 1; return real(...) end');
  vm.slash('new Elsewhere');
  vm.run(`SetItemRef("addon:NeverQuestAlone:open:${id}", "[Open]", "LeftButton", DEFAULT_CHAT_FRAME)`);
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(activeId(vm), id);
  assert.equal(vm.num('TOGGLES'), 2, '/nqa new toggled once, the link once');
  vm.run('NS.UI.ui.input:ClearFocus()');
  vm.advance(0.1);
  vm.run(`SetItemRef("addon:NeverQuestAlone:reply:${id}", "[Reply]", "LeftButton", DEFAULT_CHAT_FRAME)`);
  assert.equal(vm.evaluate('STUB.focus == NS.UI.ui.input'), 'true', '[reply] puts the cursor in the box');
  vm.run('SetItemRef("addon:OtherAddon:open:c123456", "[x]", "LeftButton", DEFAULT_CHAT_FRAME)');
  assert.equal(vm.num('TOGGLES'), 3, 'other addons\' links are left alone');
});

test('/br answers in the chat that last pinged you', () => {
  const vm = confirmHello(newVM().login());
  const first = activeId(vm);
  vm.slash('new Other');
  apply(vm, slotLua({ records: [replyRec(1, first, 'ping from the first chat')] }));
  assert.equal(vm.evaluate('NQADB.lastPing'), first);
  vm.reply('thanks!');
  assert.equal(activeId(vm), first);
  const w = vm.outboxWires().pop().wire;
  assert.ok(w.includes(`\x1fmsg\x1f${first}\x1f`) && w.endsWith('\x1fthanks!'));
  vm.slash('chat 2');
  vm.reply('');
  assert.equal(activeId(vm), first, '/br alone opens that chat');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(vm.evaluate('STUB.focus == NS.UI.ui.input'), 'true');
  vm.reply('delete');
  assert.ok(vm.outboxWires().pop().wire.endsWith('\x1fdelete'), 'after /br every word is text');
  assert.equal(vm.num('#NQADB.chats'), 2);
});

test('without EventRegistry the links are nqa: links, handled by a SetItemRef post-hook', () => {
  const vm = confirmHello(newVM({ extra: 'EventRegistry = nil' }).login());
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'hi')] }));
  assert.ok(vm.chatLines()[0].includes(`|Hnqa:open:${id}|h[Open]|h`));
  vm.run(`SetItemRef("nqa:open:${id}", "[Open]", "LeftButton", DEFAULT_CHAT_FRAME)`);
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(vm.evaluate('STUB.itemRef'), `nqa:open:${id}`, 'Blizzard\'s SetItemRef still ran: a post-hook, not a replacement');
});

// --------------------------------------------------------------------------
// Security (PRD §11, AC1.9, AC1.10)
// --------------------------------------------------------------------------

test('security: no reply, echo or command reaches SendChatMessage, a channel, RunScript or loadstring', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  const nasty = [
    '/run SendChatMessage("gold for sale", "SAY")',
    '|Hitem:2140|h[Fine Longsword]|h and |cffff0000red|r and |TInterface\\Icons\\x:16|t',
    'RunScript("print(1)") loadstring("x")() /script DoEmote("dance")',
    '/cast Fireball\n/y hello everyone',
  ];
  let seq = 0;
  for (const mode of ['summary', 'full', 'short', 'off']) {
    vm.slash('echo ' + mode);
    apply(vm, slotLua({ records: nasty.map(t => replyRec(++seq, id, t)) }));
  }
  const cmds = ['', '', 'new X', 'chat 1', 'chat', 'rename Y', 'context', 'context off', 'context on', 'dnd combat off', 'dnd combat on',
    'map', 'map ore on', 'map stop', 'stream on', 'stream off', 'mode reload', 'mode pixel', 'diag', 'slots', 'help', 'copy', 'steer x',
    'hello there', 'stop', 'chat Y', 'stop', 'delete', 'chat 1', 'echo summary']; // Y: the new chat, renamed (the newest is chat 1)
  for (const c of cmds) vm.slash(c);
  vm.reply('thanks');
  vm.reply('');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  apply(vm, slotLua({ records: nasty.map(t => replyRec(++seq, id, t)) }));
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  vm.advance(700);
  assert.deepEqual(vm.list('STUB.forbidden'), [], 'nothing called SendChatMessage, RunScript, loadstring or a channel API');
  // An escape that didn't come through the bridge's renderer is shown inert.
  const shown = vm.list(`NS.Chats.Find("${id}").history`).find(e => e.text.includes('Fine Longsword'));
  assert.equal(shown.text, '||Hitem:2140||h[Fine Longsword]||h and |cffff0000red|r and ||TInterface\\Icons\\x:16||t');
});

test('security: the source never names a chat-sending or code-running API, hooks only by post-hooks, touches no chat edit box', () => {
  const lua = fs.readdirSync(ADDON).filter(f => f.endsWith('.lua'));
  const code = {};
  for (const f of lua) code[f] = fs.readFileSync(path.join(ADDON, f), 'utf8').replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, '');
  const forbidden = /\b(SendChatMessage|SendAddonMessage|C_ChatInfo|BNSendWhisper|SendMail|RunScript|RunMacroText|RunBinding|loadstring|loadfile|dofile|setfenv|getfenv|ChatEdit_SendText|ChatEdit_ActivateChat|ChatFrame_OpenChat|OpenChat|CastSpellByName|UseAction|SetBinding|SaveBindings|SecureActionButtonTemplate|GetActiveWindow)\b|(?<![\w.:])load\s*\(/;
  for (const [f, src] of Object.entries(code)) assert.doesNotMatch(src, forbidden, f);
  const all = Object.values(code).join('\n');
  const hooks = [...all.matchAll(/hooksecurefunc\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.deepEqual(hooks.sort(), [
    '"ChatEdit_InsertLink", TakeLink', '"SetItemRef", function(link', 'ChatFrameUtil, "InsertLink", TakeLink', 'WorldMapFrame, "OnMapChanged", M.Refresh',
    '"ShowUIPanel", StepAsideSoon', '"HideUIPanel", StepAsideSoon', '"QuestInfo_Display", Safe(function(template, parent',
    '"QuestInfo_HideAlphaDependentText", Safe(Hide', '"QuestInfo_ShowAlphaDependentText", Safe(Reveal', '"QuestInfo_FadeInAlphaDependentText", Safe(FadeIn',
  ].sort(), 'post-hooks only: link insertion, SetItemRef, the map\'s redraw, the game\'s panels opening and closing, and the quest page\'s layout and text fade-in (Chains.lua\'s line)');
  assert.doesNotMatch(all, /^\s*(ChatFrameUtil|ChatEdit_\w+|SetItemRef|StaticPopup_Show|ReloadUI|ChatFrame\d\w*)\s*(\.\s*\w+\s*)?=/m, 'no Blizzard function is replaced');
  assert.doesNotMatch(all, /ChatFrame\d*EditBox|ChatFrame%d/, 'Blizzard\'s chat edit boxes are never touched (no /cast taint)');
  const reloads = [...all.matchAll(/ReloadUI\s*\(/g)].length;
  assert.equal(reloads, 1, 'ReloadUI is called in one place (ns.Reload)');
  assert.ok(code['UI.lua'].includes('if type(ReloadUI) == "function" then ReloadUI() end'));
  const callers = Object.entries(code).flatMap(([f, src]) => [...src.matchAll(/(?<!function )ns\.Reload\(\)/g)].map(() => f));
  assert.deepEqual(callers.sort(), ['Commands.lua', 'UI.lua'], 'only the Reload button and /nqa reload call it');
});

// [code health AD-14] The same small helpers were defined two or three times (Call in UI.lua and
// HUD.lua; Try, Esc, Trim, Pipes and CharKey copies in Map.lua, Paste.lua and Companion.lua), and
// game text had three escape strippers with three rules. One of each now: ns.Call, ns.Try,
// ns.Escape, ns.Trim and ns.CharKey, and the key check's generated StripEscapes.
test('one copy of each small helper, and the key check\'s StripEscapes is the one escape stripper for game text (code health AD-14)', () => {
  for (const f of fs.readdirSync(ADDON).filter(x => x.endsWith('.lua'))) {
    const src = fs.readFileSync(path.join(ADDON, f), 'utf8');
    assert.doesNotMatch(src, /^local function (Call|Try|Esc|Trim|Pipes|CharKey)\(/m, `${f}: its own copy of a helper Store.lua or Chats.lua has`);
    if (f !== 'Chats.lua') assert.doesNotMatch(src, /\|T\.-\|t|\|H\.-\|h|\|A\.-\|a/, `${f}: an escape stripper of its own`);
  }
  const vm = confirmHello(newVM().login());
  vm.run('STUB.stripped = 0; local real = NS.Chats.StripEscapes; NS.Chats.StripEscapes = function(s) STUB.stripped = STUB.stripped + 1; return real(s) end');
  // Game data (Companion.Clean): links keep their names, out of their brackets, as before.
  assert.equal(vm.evaluate(`NS.Companion.Clean(${lstr('|cffff0000Red|r |Hquest:748|h[Linked]|h |TInterface/Icons/X:0|t|A:atlas:16:16|a next|line')})`), 'Red Linked nextline');
  assert.equal(vm.evaluate(`NS.Companion.Clean(${lstr('|cnIQ1:|Hitem:5776::::::::9:14|h[Worn Staff]|h|r')})`), 'Worn Staff');
  assert.equal(vm.num('STUB.stripped'), 2, 'through StripEscapes');
  // A linked item's tooltip lines (PlainTip) too.
  vm.run('STUB.stripped = 0');
  vm.run(`STUB.tooltips["item:2140"] = { "|cff1eff00Fine Longsword|r", "|TInterface/Icons/X:0|t One-Hand" }`);
  vm.send('this one? |cff1eff00|Hitem:2140|h[Fine Longsword]|h|r');
  assert.ok(vm.num('STUB.stripped') >= 2, 'each tooltip line through StripEscapes');
  const wire = vm.outboxWires().pop().wire;
  assert.match(wire, /\n {2}Fine Longsword\n {2}One-Hand$/, 'plain words');
  assert.ok(!/\|c[0-9a-f]{8}|\|T/i.test(wire.split('--- Linked from the game ---')[1]), 'no codes in what the tooltip adds');
});

test('copy box: the bridge\'s colour codes gone, || back to | unless that could start an escape, and it stays as it was', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'Take the ||cff00ff00 flight path||r at |cffffd100Thunder Bluff|r.\nA pipe: a || b')] }));
  vm.run('NS.UI.Toggle(true)');
  const n = vm.num('#NS.Chats.Active().history');
  vm.run(`local b = NS.UI.ui.bubbles[${n}]; b.scripts.OnMouseUp(b, "RightButton")`); // right-click copies
  assert.equal(vm.evaluate('NQACopy.shown'), 'true');
  // The agent literally wrote "|cff00ff00 ... |r": kept doubled, so it shows as
  // written and can't turn into a live colour; the plain pipe comes back single.
  const want = 'Take the ||cff00ff00 flight path||r at Thunder Bluff.\nA pipe: a | b';
  assert.equal(vm.evaluate('NQACopyBox:GetText()'), want);
  assert.equal(vm.evaluate('NQACopyBox.highlighted'), 'true');
  vm.run('NQACopyBox:SetText("edited"); NQACopyBox.scripts.OnTextChanged(NQACopyBox, true)');
  assert.equal(vm.evaluate('NQACopyBox:GetText()'), want, 'typing puts the text back');
  vm.send('my | own text');
  const m = vm.num('#NS.Chats.Active().history');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${m}].body.text`), 'my || own text', 'what you typed shows literally');
  vm.run(`local b = NS.UI.ui.bubbles[${m}]; b.scripts.OnMouseUp(b, "RightButton")`);
  assert.equal(vm.evaluate('NQACopyBox:GetText()'), 'my | own text');
  assert.equal(vm.evaluate(`NS.CopyText(${lstr('a||b |cff112233c|r d||r e|x x|| y')})`), 'a||b c d||r e||x x| y', 'a | that could start an escape stays doubled');
  assert.equal(vm.evaluate(`NS.SafeText(${lstr('a||b |cff112233c|r |Hx|h |')})`), 'a||b |cff112233c|r ||Hx||h ||');
});

// --------------------------------------------------------------------------
// Map, window, strip, versions, progress
// --------------------------------------------------------------------------

// Map-specific client stubs (first written for upstream wow-ai's map test): Loch Modan (1432)
// sits at x .5-.6, y .4-.5 of Eastern Kingdoms (1415), 10000 x 15000 yards.
const MAP_STUB = `
Enum = { UIMapType = { Continent = 2, Zone = 3 } }
local MAPS = { [1432] = { name = "Loch Modan", mapType = 3, parentMapID = 1415 }, [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 }, [947] = { name = "Azeroth", mapType = 1, parentMapID = 0 } }
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { name = m.name, mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
C_Map.GetBestMapForUnit = function() return 1432 end
C_Map.GetMapRectOnMap = function(child, parent) if child == 1432 and parent == 1415 then return 0.5, 0.6, 0.4, 0.5 end end
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1415 then return 0, { x = v.x * 10000, y = v.y * 15000 } end end
function GetPlayerFacing() return 0 end
local canvas = CreateFrame("Frame", "WorldMapCanvas")
canvas.width, canvas.height = 1000, 700
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
function WorldMapFrame:GetCanvas() return canvas end
function WorldMapFrame:GetMapID() return 1432 end
function WorldMapFrame:GetCanvasScale() return 1 end
function WorldMapFrame:OnMapChanged() end
MINING, HERBALISM = "Mining", "Herbalism"
`;
const LAYER = `{ epoch = "e1", version = 1, layers = { { name = "mining", title = "Copper loop", ordered = true, loop = true, points = {
  { 1432, 50, 40, "1. Copper Vein", "ore" }, { 1432, 60, 50, "2. Copper Vein", "ore" }, { 1432, 55, 70, "3. Tin Vein", "ore" } } } } }`;

test('map: the module loads as NQAMap and NQAMapDB, takes the slot\'s and the inbox\'s map, and answers /nqa map', () => {
  const vm = confirmHello(newVM({ extra: MAP_STUB }).login());
  assert.equal(vm.evaluate('type(NQAMap)'), 'table');
  assert.equal(vm.evaluate('WoWAIMap'), null);
  apply(vm, slotLua({ extra: `, map = ${LAYER}` }));
  assert.equal(vm.evaluate('NQAMapDB.map.layers[1].title'), 'Copper loop');
  assert.equal(vm.evaluate('NQAMapDB.nav.layer'), 'mining', 'a new route starts the navigator');
  assert.equal(vm.evaluate('NQANavigator ~= nil'), 'true');
  assert.ok(vm.list('STUB.prints').some(p => p === '|cff7ec8ff[NeverQuestAlone]|r Route of 3 stops on your map: Copper loop. Open the map (M) to see it.'));
  vm.slash('map hide mining');
  assert.equal(vm.evaluate('NQAMapDB.hidden.mining'), 'true');
  vm.slash('map show mining');
  assert.equal(vm.evaluate('NQAMapDB.hidden.mining'), null);
  vm.slash('map nav mining 3');
  assert.equal(vm.num('NQAMapDB.nav.index'), 3);
  vm.slash('map stop');
  assert.equal(vm.evaluate('NQAMapDB.nav'), null);
  vm.slash('map');
  // The commands, as the help writes them, each | doubled so the chat frame shows it.
  const HELP = ['/nqa map show||hide <name>  Show or hide routes and marks on your map', '/nqa map nav [name [stop number]]  Follow a route',
    '/nqa map next||prev  Go to the next or previous stop', '/nqa map stop  End the route you\'re following', '/nqa map minimap [on||off]  Show or hide pins on the minimap'];
  for (const h of HELP) assert.ok(vm.list('STUB.prints').some(p => p.endsWith(h)), h);
  // Upstream's node pins are gone (code health AD-19): their words still run as commands, and answer with the map's state.
  vm.run('STUB.prints = {}');
  vm.slash('map ore on');
  assert.ok(vm.list('STUB.prints').some(p => p.endsWith(HELP[0])));
  assert.equal(vm.evaluate('NQAMapDB.nodes'), null);
  // A slot for another install leaves the map alone.
  apply(vm, slotLua({ token: 'deadbeef', extra: ', map = { epoch = "e9", version = 9, layers = {} }' }));
  assert.equal(vm.evaluate('NQAMapDB.map.epoch'), 'e1');
  // The reload inbox's map too.
  const vm2 = newVM({ extra: MAP_STUB, db: `NQADB = { token = "${TOKEN}" }`, inbox: 'NQA_Inbox = ' + slotLua({ token: TOKEN, extra: `, map = ${LAYER}` }) }).login();
  assert.equal(vm2.evaluate('NQAMapDB.map.layers[1].name'), 'mining');
});

test('window: Blizzard templates with fallbacks, Esc minimizes to the bar, size and place are saved, the key binding opens it', () => {
  const vm = newVM().login();
  assert.equal(vm.evaluate('NS.UI.ui.template'), 'PortraitFrameTemplate');
  assert.ok(vm.list('UISpecialFrames').includes('NQAFrame'));
  assert.equal(vm.evaluate('NQAFrame.shown'), 'false');
  vm.run('NeverQuestAlone.OpenAndType(); STUB.Advance(0)');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(vm.evaluate('STUB.focus == NS.UI.ui.input'), 'true');
  vm.run('NQAFrame:Hide()'); // what Esc does to a UISpecialFrames window
  assert.equal(vm.evaluate('NQADB.settings.minimized'), 'true');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true', 'the HUD stands in for the small bar');
  assert.equal(vm.evaluate('NQAMini.shown'), 'false');
  vm.slash('hud off');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'false');
  assert.equal(vm.evaluate('NQAMini.shown'), 'true', 'with the HUD off, the bar is back');
  vm.run('local c = NS.UI.ui.miniClose; c.scripts.OnClick(c)');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'false');
  assert.equal(vm.evaluate('NQAMini.shown'), 'false');
  assert.equal(vm.evaluate('NQADB.settings.shown'), 'false');
  vm.run('NS.UI.Toggle(true); NQAFrame:SetSize(900, 610); NS.UI.ui.grip.scripts.OnMouseUp()');
  assert.equal(vm.num('NQADB.settings.width'), 900);
  assert.equal(vm.num('NQADB.settings.height'), 610);
  vm.run('NQAFrame.scripts.OnDragStop(NQAFrame)');
  assert.equal(vm.evaluate('NQADB.settings.point'), 'CENTER');
  const again = reloadVM(vm).login();
  assert.equal(again.evaluate('NQAFrame.shown'), 'true', 'it comes back as it was');
  assert.equal(again.num('NQAFrame.width'), 900);

  // A client without Blizzard's frame templates: the BackdropTemplate dialog border.
  const bare = newVM({ extra: 'C_XMLUtil = { GetTemplateInfo = function(name) if name == "BackdropTemplate" or name == "UIPanelButtonTemplate" or name == "UIPanelScrollFrameTemplate" or name == "UIPanelCloseButton" then return {} end end }' }).login();
  assert.equal(bare.evaluate('NS.UI.ui.template'), 'BackdropTemplate');
  assert.equal(bare.evaluate('NQAFrame.backdrop.edgeFile'), 'Interface\\DialogFrame\\UI-DialogBox-Border');
  // A template whose creation throws is skipped for the next.
  const thrown = newVM({ extra: 'local real = CreateFrame; CreateFrame = function(kind, name, parent, tpl) if tpl == "PortraitFrameTemplate" then error("Couldn\'t find inherited node") end return real(kind, name, parent, tpl) end' }).login();
  assert.equal(thrown.evaluate('NS.UI.ui.template'), 'ButtonFrameTemplate');

  // The chat menu: Blizzard's MenuUtil when present, our own frame when not.
  const mu = newVM({ extra: 'MENU = {}; MENUFN = {}; MenuUtil = { CreateContextMenu = function(owner, gen) local root = { CreateTitle = function(self, t) table.insert(MENU, "title:" .. t) end, CreateButton = function(self, t, fn) table.insert(MENU, t); MENUFN[t] = fn end }; gen(owner, root) end }' }).login();
  mu.run('NS.UI.ChatMenu(NQADB.chats[1].id, NQAFrame)');
  assert.deepEqual(mu.list('MENU'), ['title:Chat 1', 'Pin to Top', 'Rename…', 'Delete']);
  mu.run('MENUFN["Pin to Top"]()');
  assert.equal(mu.evaluate('NQADB.chats[1].pinned'), 'true', 'Blizzard\'s menu pins too');
  mu.run('MENUFN["Rename…"]()');
  assert.equal(mu.evaluate('STUB.popup.which'), 'NQA_RENAME');
  mu.run('StaticPopupDialogs.NQA_RENAME.OnAccept({ GetEditBox = function() return { GetText = function() return "  Renamed  " end } end }, STUB.popup.data)');
  assert.equal(mu.evaluate('NQADB.chats[1].name'), 'Renamed', 'GetEditBox()');
  mu.run('StaticPopupDialogs.NQA_RENAME.OnAccept({ editBox = { GetText = function() return "Again" end } }, STUB.popup.data)');
  assert.equal(mu.evaluate('NQADB.chats[1].name'), 'Again', '.editBox');
  const before = mu.evaluate('NQADB.chats[1].id');
  mu.run('MENUFN["Delete"]()');
  assert.equal(mu.evaluate('STUB.popup.which'), 'NQA_DELETE');
  mu.run('StaticPopupDialogs.NQA_DELETE.OnAccept({}, STUB.popup.data)');
  assert.notEqual(mu.evaluate('NQADB.chats[1].id'), before, 'deleted; a fresh chat takes its place');
  vm.run('NS.UI.ChatMenu(NQADB.chats[1].id, NQAFrame)');
  assert.equal(vm.evaluate('NQAChatMenu.shown'), 'true');
  assert.equal(vm.evaluate('NQAChatMenu.title.text'), 'Chat 1');
});

test('the strip keeps one UI unit per pixel: its scale follows UI_SCALE_CHANGED and DISPLAY_SIZE_CHANGED (upstream #8)', () => {
  const vm = newVM().login();
  vm.advance(3.1);
  assert.ok(Math.abs(vm.num('NQAStrip.scale') - 768 / 1080) < 1e-9);
  assert.deepEqual([vm.num('NQAStrip.x'), vm.num('NQAStrip.y')], [0, 0], 'anchored at the top-left of UIParent');
  assert.equal(vm.num('NQAStrip.width'), 800);
  vm.run('function GetPhysicalScreenSize() return 3456, 2234 end; STUB.FireEvent("UI_SCALE_CHANGED")');
  assert.ok(Math.abs(vm.num('NQAStrip.scale') - 768 / 2234) < 1e-9);
  vm.run('function GetPhysicalScreenSize() return 2560, 1440 end; STUB.FireEvent("DISPLAY_SIZE_CHANGED")');
  assert.ok(Math.abs(vm.num('NQAStrip.scale') - 768 / 1440) < 1e-9);
});

test('protocol mismatch: a slot that isn\'t v2 is not applied and says so; a bridge of another major version warns once', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  apply(vm, slotLua({ v: 3, records: [replyRec(1, id, 'from the future')] }));
  assert.equal(vm.num('NQADB.cursor'), 0);
  // No protocol in the player's words: the app updates the addon (UX-W03).
  const cantRead = 'This addon can\'t read what the NeverQuestAlone app sends, so nothing from it was applied. Update the app; it updates the addon too.';
  assert.equal(vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), cantRead);
  assert.ok(vm.chatLines().some(l => l.endsWith(cantRead)));
  assert.equal(vm.evaluate('NS.UI.StatusText()'), '|cffff5555This addon can\'t read what the NeverQuestAlone app sends. Update the app; it updates the addon too.|r');
  vm.slash('diag');
  assert.ok(notice(vm).includes('NeverQuestAlone writes protocol v3; this addon reads v2.'), 'the numbers for a bug report');
  apply(vm, slotLua({ ver: '2.2.0', records: [replyRec(1, id, 'hello')] }));
  assert.equal(vm.num('NQADB.cursor'), 1, 'v2 records still apply');
  const warned = () => vm.chatLines().filter(l => /The NeverQuestAlone app is version 2\.2\.0 and this addon is 1\.\d+\.\d+\. Update the app; it updates the addon too\.$/.test(l)).length;
  assert.equal(warned(), 1);
  apply(vm, slotLua({ ver: '2.2.0' }));
  assert.equal(warned(), 1, 'once per session');
  assert.doesNotMatch(vm.evaluate('NS.UI.StatusText()'), /can't read/);
  // The bridge's own mismatch warning (bridge.warn): a system line once, the light's tooltip, /nqa diag.
  const text = 'The slot addons are for interface 16000; this client is 16001. Run setup again.';
  const said = 'A note from the NeverQuestAlone app: ' + text;
  apply(vm, slotLua({ warn: text }));
  apply(vm, slotLua({ warn: text }));
  assert.equal(vm.chatLines().filter(l => l.endsWith(said)).length, 1, 'once, and never saved into the chat');
  assert.equal(vm.history().filter(e => e.text === said).length, 0);
  assert.ok(vm.evaluate('select(2, NS.Transport.Light())').endsWith('\n' + said));
  vm.slash('diag');
  assert.ok(notice(vm).includes('NeverQuestAlone warns: ' + text));
  apply(vm, slotLua());
  assert.equal(vm.evaluate('NS.R.bridgeWarn'), null, 'gone once the bridge stops saying it');
});

test('working bubble: act pulses count actions, with the elapsed time, the tool title (escaped) and Stop', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  const work = () => vm.evaluate('NS.UI.ui.work.text.text');
  vm.run('NS.UI.Toggle(true)');
  vm.send('research the route');
  const key = lastKey(vm);
  assert.match(work(), /^Sending · \d+ s$/);
  assert.equal(vm.evaluate('NS.UI.ui.send.text'), 'Queue');
  ackKeys(vm, [key]);
  for (let i = 0; i < 3; i++) ring(vm, 'act');
  assert.equal(vm.num(`NS.R.acts["${key}"].count`), 3);
  vm.advance(10.4);
  assert.match(work(), /^Working · 3 actions · 1\d s$/);
  apply(vm, slotLua({ chats: `{ { id = "${id}", busy = true, queued = 0, run = { actions = 7, last = "Browser: open \\"hyjal\\" | route" } } }` }));
  vm.advance(2.1);
  assert.match(work(), /^Working · 7 actions · \d+ s · Browser: open "hyjal" \|\| route$/);
  vm.run('local s = NS.UI.ui.work.stop; s.scripts.OnClick(s)');
  assert.match(vm.outboxWires().pop().wire, /\x1fstop\x1f/);
  assert.match(work(), /^Stopping · /);
  // After a /reload only that session's sends are counted.
  const vm2 = reloadVM(vm).login();
  vm2.advance(2.1);
  ring(vm2, 'act');
  assert.equal(vm2.evaluate(`NS.R.acts["${key}"]`), null);
});

// --------------------------------------------------------------------------
// Edge cases
// --------------------------------------------------------------------------

test('a hello the bridge missed leaves the strip after 20 s and goes up again once the bridge shows life', () => {
  const vm = newVM({ extra: 'STUB.epoch = 1790359440 - 1000' }).login();
  vm.advance(3.1);
  const nonce = vm.evaluate('NS.R.nonce');
  assert.ok(vm.stripWires()[0].includes('\x1fhello\x1f'));
  vm.advance(20.5);
  assert.equal(vm.strip(), null, 'the bridge is away: the hello leaves the strip');
  vm.advance(60);
  assert.equal(vm.strip(), null, 'and stays off while nothing is heard');
  // The bridge starts: a beat, and the hello goes up again.
  beat(vm).advance(2.1);
  assert.ok(vm.stripWires().some(w => w.includes(`\x1f${nonce}\x1fhello\x1f`)));
  vm.slot(slotLua({ push: 3, nonce }));
  ring(vm).advance(0.3);
  assert.deepEqual(vm.stripWires().map(w => w.split('\x1f')[3]), ['seen'], 'confirmed: only the push report is left');
  assert.match(vm.stripWires()[0], /;p=3;slot=3\x1f$/, 'with the next slot: the live check\'s load and the ring\'s came first');
  // One load checked the live self-test at 30 s (nothing there then); the ring's load reads the answer.
  assert.equal(vm.num('NS.R.slots.reasons.hello'), 1);
  assert.equal(vm.num('NS.R.slots.reasons.push'), 1);
  assert.equal(vm.bool('NS.R.helloAnswered'), true);
  assert.equal(vm.evaluate('NS.R.sig.live'), 'ok');
});

test('the status line says so when the bridge beats but doesn\'t read the strip (capture stopped): the message is stuck (DR-07)', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.epoch = 1790359440 - 1000' }).login());
  vm.send('anyone?');
  vm.advance(10);
  assert.equal(vm.evaluate('NS.UI.StatusText()'), '', 'the status line only speaks when something needs you');
  beat(vm).advance(12);
  beat(vm).advance(12);
  assert.equal(vm.evaluate('NS.UI.StatusText()'), '|cffffd100NeverQuestAlone hasn\'t read your message yet.|r', 'on screen unread for 15 s, in the player\'s words (DR-07)');
  assert.ok(vm.strip() !== null, 'the record stays up until it is acked');
});

test('a slot addon that won\'t load (not installed): replies wait for a reload, and no more loads are tried', () => {
  const vm = newVM({ extra: 'STUB.slotReason = "MISSING"' }).login();
  vm.advance(3.1);
  const nonce = vm.evaluate('NS.R.nonce');
  ring(vm).advance(0.3);
  assert.equal(vm.loads(), 1);
  assert.equal(vm.evaluate('NS.R.slots.broken'), 'NQA_S001 (MISSING)', 'the part and the game\'s reason, for /nqa diag');
  // In the player's words (C-121): a part, what to do, no reason code or plumbing word.
  const said = 'A part of NeverQuestAlone didn\'t load, so replies wait for a reload. In the NeverQuestAlone app, click Settings, Show more, then Run setup again, and restart WoW.';
  assert.equal(notice(vm), said);
  assert.ok(vm.chatLines().some(l => l.endsWith(said)), 'said in the chat frame too');
  assert.match(vm.evaluate('NS.UI.StatusText()'), /Replies can't load right now: they arrive when you reload\./);
  vm.run('NS.R.push.known = 1');
  vm.signal('push', '2').advance(10);
  assert.equal(vm.loads(), 1, 'no more tries this session');
  vm.send('still sending?');
  assert.ok(vm.stripWires().some(w => w.endsWith('\x1fstill sending?')), 'the way out still works');
  vm.slash('diag');
  assert.match(notice(vm), /unavailable: NQA_S001 \(MISSING\)/, '/nqa diag keeps the part and the code');
});

test('C-121, C-128: the parts turned off in the AddOns list (their row\'s "Disable All AddOns"): the way to turn them back on, in the game\'s own words', () => {
  const vm = newVM({ extra: 'STUB.slotReason = "DISABLED"' }).login();
  vm.advance(3.1);
  ring(vm).advance(0.3);
  assert.equal(vm.loads(), 1);
  assert.equal(vm.evaluate('NS.R.slots.broken'), 'NQA_S001 (DISABLED)');
  const said = 'NeverQuestAlone Parts are turned off in the AddOns list, so replies wait for a reload. To turn them back on: Game Menu > AddOns, right-click NeverQuestAlone Parts, click Enable All AddOns (on that row it turns on only the parts), then click Reload UI.';
  assert.equal(notice(vm), said, 'setup writes the parts, not whether they\'re on: the way back is the list\'s own menu (its words: the C-128 test)');
  assert.ok(vm.chatLines().some(l => l.endsWith(said)));
  assert.doesNotMatch(said, /\bslots?\b|bridge|DISABLED/, 'no plumbing word, no reason code');
  assert.match(vm.evaluate('NS.UI.StatusText()'), /Replies can't load right now: they arrive when you reload\./);
  // The HUD's line says it in short (T.Warn's flash).
  assert.equal(vm.evaluate('NS.HUD.Active() and "on" or "off"'), 'on');
  assert.equal(vm.evaluate('rawget(NS.HUD.h.status, "text")'), 'Parts turned off: replies wait for a reload');
  // Once a session: another load isn't tried, and the line isn't said again.
  vm.run('NS.R.push.known = 1');
  vm.signal('push', '2').advance(10);
  assert.equal(vm.loads(), 1);
  assert.equal(vm.chatLines().filter(l => l.endsWith(said)).length, 1);
  vm.slash('diag');
  assert.match(notice(vm), /unavailable: NQA_S001 \(DISABLED\)/);
});

// The game's own words, from its GlobalStrings on 1.60.1.70009 (tests/fixtures/game-strings-70009.json).
const GS = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'game-strings-70009.json'), 'utf8')).strings).map(([k, v]) => [k, v.text]));

test('C-128: a line that names the game\'s menus quotes the game\'s own words: the parts\' way back (Enable All AddOns, Reload UI) and the Keybindings path', () => {
  const partsOff = (globals = '') => {
    const vm = newVM({ extra: `STUB.slotReason = "DISABLED"\n${globals}` }).login();
    vm.advance(3.1);
    ring(vm).advance(0.3);
    return notice(vm);
  };
  // What the parts' row's menu offers on this build: Enable All AddOns turns on only the parts there
  // (AddonListNodeMixin:SetEnabledAll walks the category's direct children), and the line says so.
  const way = g => `To turn them back on: ${g.MAINMENU_BUTTON} > ${g.ADDONS}, right-click NeverQuestAlone Parts, click ${g.ADDON_LIST_ENABLE_CATEGORY} (on that row it turns on only the parts), then click ${g.RELOADUI}.`;
  // A client without the globals (the stub): the English of 1.60.1.70009.
  const bare = partsOff();
  assert.ok(bare.endsWith(way(GS)), bare);
  assert.ok(bare.includes(`click ${GS.ADDON_LIST_ENABLE_CATEGORY} (`) && bare.endsWith(`then click ${GS.RELOADUI}.`));
  assert.doesNotMatch(bare, /in Category/, 'no such menu item on this build');
  // The game's globals, as that build has them: the same line.
  const asGame = Object.entries(GS).map(([k, v]) => `${k} = ${lstr(v)}`).join('\n');
  assert.equal(partsOff(asGame), bare);
  // Another client's words for the same four: the line follows the game, not our English.
  const other = { MAINMENU_BUTTON: 'Spielmenü', ADDONS: 'Addons', ADDON_LIST_ENABLE_CATEGORY: 'Alle Addons aktivieren', RELOADUI: 'UI neu laden' };
  assert.ok(partsOff(Object.entries(other).map(([k, v]) => `${k} = ${lstr(v)}`).join('\n')).endsWith(way(other)));
  // An empty or missing global keeps the English.
  assert.equal(partsOff('ADDON_LIST_ENABLE_CATEGORY = ""\nRELOADUI = nil'), bare);
  // The Keybindings path (Bind Keys without the Settings API): Options > Keybindings, as the game names them.
  const vm = newVM().login();
  vm.run('NS.Settings.OpenKeybindings()');
  const line = vm.chatLines().pop().replace(/\|c[0-9a-f]{8}|\|r/g, '');
  assert.ok(line.includes(`${GS.SETTINGS_TITLE} > ${GS.SETTINGS_KEYBINDINGS_LABEL} > NeverQuestAlone`), line);
  // Nowhere in the addon: the menu item that isn't there.
  for (const f of fs.readdirSync(ADDON).filter(f => /\.(lua|xml|toc)$/.test(f))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ADDON, f), 'utf8'), /(Enable|Disable) All in Category/, f);
  }
});

test('C-129: every description of the item key uses its name\'s words (Ask About the Hovered Item: "the hovered item")', async () => {
  const { luaStrings } = await import('./helpers/player-strings.mjs');
  const name = newVM().login().evaluate('BINDING_NAME_NQA_ASK_ITEM');
  assert.equal(name, 'Ask About the Hovered Item', 'the key\'s name on the Keybindings page');
  const words = name.replace(/^Ask About /, '').toLowerCase();
  const strings = fs.readdirSync(ADDON).filter(f => f.endsWith('.lua')).flatMap(f => luaStrings(path.join(ADDON, f)).map(s => ({ ...s, f })));
  // Bind Keys' tooltip (Settings' button; the one-build HUD has no welcome card) and /nqa help all's line.
  const about = strings.filter(s => /ask about your target or |^\/nqa ask item /.test(s.text));
  assert.deepEqual(about.map(s => s.f).sort(), ['Commands.lua', 'Settings.lua']);
  for (const s of about) assert.ok(s.text.includes(words), `${s.f}:${s.line}: ${s.text}`);
  assert.deepEqual(strings.filter(s => /item under the mouse/i.test(s.text)).map(s => `${s.f}:${s.line}`), [], 'one ask, one name');
});

test('turning combat do-not-disturb off delivers what was held, even mid-fight', () => {
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  apply(vm, slotLua({ records: [replyRec(1, id, 'held')] }));
  assert.equal(played(vm).length, 0);
  vm.slash('dnd combat off');
  assert.equal(played(vm).length, 1);
  assert.ok(vm.chatLines().some(l => l.includes('held')));
});

test('the live self-test gets settled later: when the static part starts passing, and after a send', () => {
  // Static fails at login; the slot-only hello answer names our nonce, so live is left pending.
  const vm = newVM({ signals: false }).login();
  vm.advance(3.1);
  const nonce = vm.evaluate('NS.R.nonce');
  vm.slot(slotLua({ nonce }));
  vm.advance(8.5);
  assert.equal(vm.bool('NS.R.helloAnswered'), true);
  assert.equal(vm.evaluate('NS.R.sig.live'), 'pending');
  // Sound comes back: the static part passes. The hello was answered already, so the
  // next push ring would settle live; this client never had the bells at load, so
  // both push bells are dead 10 s later, and live fails.
  vm.signal('ctl', 'present');
  vm.run('STUB.FireEvent("CVAR_UPDATE", "Sound_EnableAllSound")');
  assert.equal(vm.evaluate('NS.R.sig.static'), 'ok');
  assert.equal(vm.evaluate('NS.R.sig.live'), 'pending');
  vm.advance(12.5);
  assert.equal(vm.evaluate('NS.R.sig.live'), 'fail', 'the bridge answered, but its doorbells are never heard');
  assert.equal(vm.bool('NS.Transport.SlotOnly()'), true);

  // The bridge was away at the 30 s check; a send carries the hello again and re-arms it.
  const vm2 = newVM().login();
  vm2.advance(3.1);
  const n2 = vm2.evaluate('NS.R.nonce');
  vm2.advance(31);
  assert.equal(vm2.num('NS.R.slots.reasons.hello'), 1, 'the 30 s check found nothing written');
  assert.equal(vm2.evaluate('NS.R.sig.live'), 'pending');
  vm2.slot(slotLua({ nonce: n2 })); // the bridge handles the hello, but its rings aren't heard here
  vm2.send('anyone there?');
  vm2.advance(29);
  assert.equal(vm2.num('NS.R.slots.reasons.hello'), 1);
  vm2.advance(2);
  assert.equal(vm2.num('NS.R.slots.reasons.hello'), 2);
  assert.equal(vm2.evaluate('NS.R.sig.live'), 'fail');
  assert.equal(vm2.bool('NS.Transport.SlotOnly()'), true);
});

test('slot-only mode: a rename or a delete gets one slot load 5 s later, for its ack', () => {
  const vm = newVM({ signals: false }).login();
  vm.slot(slotLua());
  vm.advance(12);
  vm.send('first message');
  vm.advance(60);
  const before = vm.loads();
  vm.slash('rename Renamed');
  vm.run('NS.UI.Toggle(false)'); // /nqa rename opens the window, which would allow progress loads (rule 3)
  const key = lastKey(vm);
  vm.slot(slotLua({ acked: [key] }));
  vm.advance(4);
  assert.equal(vm.loads(), before);
  vm.advance(1.5);
  assert.equal(vm.loads(), before + 1);
  assert.equal(vm.num('NS.R.slots.reasons.ack'), 1);
  assert.ok(!vm.outboxWires().some(e => e.key === key), 'acked by the slot\'s list');
  assert.ok(!vm.evaluate('NS.UI.StatusText()').includes('NeverQuestAlone Capture'), 'no capture warning in slot-only mode');
});

test('after /reload a record still waiting counts its wait from then, and once the new session\'s slots load without its ack, it didn\'t go through (DR-07, SY-29)', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.epoch = 1790359440 - 1000' }).login());
  vm.send('waiting through a reload');
  const vm2 = reloadVM(vm).login();
  vm2.run('NS.UI.Toggle(true)');
  vm2.advance(12);
  assert.match(vm2.evaluate('NS.UI.ui.work.text.text'), /^Sending · 1\d s$/);
  beat(vm2).advance(12);
  beat(vm2).advance(12);
  // The Reload put it in SavedVariables: not "not read yet" (the app reads the file), and nothing
  // is said before this session's first slot load.
  assert.equal(vm2.evaluate('NS.UI.StatusText()'), '');
  apply(vm2, slotLua({ nonce: vm2.evaluate('NS.R.nonce') }));
  beat(vm2).advance(8);
  beat(vm2).advance(8);
  assert.equal(vm2.evaluate('NS.UI.StatusText()'), '|cffffd100Your message didn\'t go through.|r');
});

test('a message too long to carry the changed context goes without it, and the next one carries it', async () => {
  const { records } = await bridge();
  const vm = confirmHello(newVM().login());
  vm.run('STUB.zone = "Elwynn Forest"');
  vm.slash('x'.repeat(2800));
  let m = records.parseRecord(vm.outboxWires().pop().wire).record;
  assert.deepEqual([m.args.ctx, m.context], ['0', null]);
  vm.send('a short one');
  m = records.parseRecord(vm.outboxWires().pop().wire).record;
  assert.equal(m.args.ctx, '1');
  assert.ok(m.context.includes('Location: Elwynn Forest'));
});

test('seen also goes out once 16 KB of record text has been applied past the reported cursor', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  const id = activeId(vm);
  apply(vm, slotLua({ records: [replyRec(1, id, 'b'.repeat(9000)), replyRec(2, id, 'c'.repeat(9000))] }));
  assert.match(vm.stripWires()[0] || '', /\x1fseen\x1f\x1fcur=2;slot=2\x1f$/);
});

test('a link\'s tooltip reaches the agent as plain words, without colour codes or textures', () => {
  const vm = confirmHello(newVM().login());
  vm.run('STUB.tooltips["item:19019"] = { "|cffff8000Thunderfury|r", { "|cffffffffOne-Hand|r", "Sword" }, "|TInterface\\\\Icons\\\\x:0|t Chance on hit" }');
  vm.send('is this good? |cffff8000|Hitem:19019|h[Thunderfury]|h|r');
  const w = vm.outboxWires().pop().wire;
  assert.ok(w.endsWith('\x1fis this good? [Thunderfury]\n\n--- Linked from the game ---\n[Thunderfury] item 19019\n  Thunderfury\n  One-Hand  Sword\n  Chance on hit'), JSON.stringify(w));
});

test('map layer names and titles from the bridge are shown with | doubled', () => {
  const vm = confirmHello(newVM({ extra: MAP_STUB }).login());
  apply(vm, slotLua({ extra: ', map = { epoch = "e1", version = 1, layers = { { name = "x", title = "A |Hlink|h", ordered = false, loop = false, points = { { 1432, 10, 10, "p", "poi" } } } } }' }));
  assert.ok(vm.list('STUB.prints').includes('|cff7ec8ff[NeverQuestAlone]|r 1 pin on your map: A ||Hlink||h. Open the map (M) to see it.'));
});

// Minimap pins (MinimapPins.lua). Loch Modan (1432) spans x 0.5-0.6 and y 0.4-0.5
// of Eastern Kingdoms (1415), which measures 10,000 by 15,000 yards, so 1% of the
// zone is 10 yards east-west and 15 yards north-south. The player stands at 50, 40;
// the minimap is 198 px across and sees 200 yards: 0.495 px per yard.
const MINIMAP_STUB = MAP_STUB + `
STUB.posX, STUB.posY, STUB.radius, STUB.facing, STUB.mapID = 0.5, 0.4, 200, 0, 1432
Minimap = CreateFrame("Minimap", "Minimap")
Minimap.width, Minimap.height = 198, 198
C_Minimap = {
	GetViewRadius = function() return STUB.radius end,
	IsRotateMinimapIgnored = function() return STUB.rotateIgnored == true end,
}
function GetPlayerFacing() return STUB.facing end
C_Map.GetBestMapForUnit = function() return STUB.mapID end
-- Durotar (1411) on Kalimdor (1414): another continent.
local info, rect, world = C_Map.GetMapInfo, C_Map.GetMapRectOnMap, C_Map.GetWorldPosFromMapPos
C_Map.GetMapInfo = function(id)
	if id == 1411 then return { name = "Durotar", mapType = 3, parentMapID = 1414, mapID = 1411 } end
	if id == 1414 then return { name = "Kalimdor", mapType = 2, parentMapID = 947, mapID = 1414 } end
	return info(id)
end
C_Map.GetMapRectOnMap = function(child, parent) if child == 1411 and parent == 1414 then return 0.6, 0.7, 0.4, 0.5 end return rect(child, parent) end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1414 then return 1, { x = v.x * 12000, y = v.y * 18000 } end return world(id, v) end
STUB.tip = {}
function GameTooltip:AddLine(text) table.insert(STUB.tip, text) end
-- The pins drawn: the pool's first ones, those with a point (MinimapPins.Update).
function STUB.Used() local n = 0; while NS.MinimapPins.pool[n + 1] and NS.MinimapPins.pool[n + 1].pt do n = n + 1 end return n end
function STUB.MinimapPins()
	local out = {}
	for i = 1, STUB.Used() do
		local b = NS.MinimapPins.pool[i]
		out[#out + 1] = { layer = b.pt.layer, index = b.pt.index, next = b.isNext and true or false, x = b.x, y = b.y, shown = b.shown, edge = b.arrow.shown, rotation = b.arrow.rotation or 0, size = b.width }
	end
	return out
end
function STUB.Tick(sec) local d = NS.MinimapPins.driver; d.scripts.OnUpdate(d, sec or 0.1) end
`;
// A route of three stops (60 yd east, 90 yd north, and 424 yd to the south-east) and two marks (30 yd west, far away).
const ROUTE = `{ name = "bloodhoof", title = "Bloodhoof loop", ordered = true, loop = false, points = {
  { 1432, 56, 40, "1. East stop", "quest" }, { 1432, 50, 34, "2. North stop", "turnin" }, { 1432, 80, 60, "3. Far stop", "flight" } } }`;
const MARKS = `{ name = "marks", title = "Marks", ordered = false, loop = false, points = {
  { 1432, 47, 40, "Herb |cffff0000patch", "herb" }, { 1432, 10, 90, "Far away", "ore" } } }`;
const mapLua = (version, layers) => `, map = { epoch = "e1", version = ${version}, layers = { ${layers.join(', ')} } }`;
function minimapPins(vm) {
  const v = vm.json('STUB.MinimapPins()');
  return Array.isArray(v) ? v : [];
}
const pinFor = (vm, layer, index) => minimapPins(vm).find(p => p.layer === layer && p.index === index);
const near = (a, b) => Math.abs(a - b) < 0.01;

test('minimap pins: layers near the player show with the world map\'s icons; the next stop is highlighted, and pinned to the edge pointing at it when far', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB }).login());
  assert.equal(vm.evaluate('NQAMapDB.minimap'), 'true', 'on by default');
  apply(vm, slotLua({ extra: mapLua(1, [ROUTE, MARKS]) }));
  assert.equal(minimapPins(vm).length, 3, JSON.stringify(minimapPins(vm)));
  const s1 = pinFor(vm, 'bloodhoof', 1);
  assert.ok(s1.next && near(s1.x, 29.7) && near(s1.y, 0) && !s1.edge, JSON.stringify(s1));
  assert.equal(s1.size, 18, 'the next stop is drawn bigger');
  const s2 = pinFor(vm, 'bloodhoof', 2);
  assert.ok(!s2.next && near(s2.x, 0) && near(s2.y, 44.55) && s2.size === 14, JSON.stringify(s2));
  const herb = pinFor(vm, 'marks', 1);
  assert.ok(near(herb.x, -14.85) && near(herb.y, 0) && herb.size === 12, JSON.stringify(herb));
  assert.equal(pinFor(vm, 'bloodhoof', 3), undefined, 'out of range, and not the next stop');
  assert.equal(pinFor(vm, 'marks', 2), undefined);
  // The world map's icon for each kind: its colour on a dot, a black ring, white for the next stop.
  const style = (layer) => vm.evaluate(`(function() for i = 1, STUB.Used() do local b = NS.MinimapPins.pool[i]; if b.pt.layer == "${layer}" and not b.isNext then return table.concat(b.dot.vcolor, ",") .. "/" .. b.dot.texture .. "/" .. table.concat(b.ring.vcolor, ",") .. "/" .. b.num.text end end end)()`);
  assert.equal(style('marks'), '0.35,0.95,0.35,1/Interface\\CHARACTERFRAME\\TempPortraitAlphaMask/0,0,0,0.9/');
  assert.equal(style('bloodhoof'), '0.35,0.8,1,1/Interface\\CHARACTERFRAME\\TempPortraitAlphaMask/0,0,0,0.9/2');
  // Hovering a pin shows its label (| doubled), its layer and how far it is.
  vm.run('for i = 1, STUB.Used() do local b = NS.MinimapPins.pool[i]; if b.pt.layer == "marks" then b.scripts.OnEnter(b) end end');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Herb ||cffff0000patch', 'the addon\'s one shape: the title is the pin');
  assert.deepEqual(vm.list('STUB.tip'), ['On Marks.', '30 yd away.']);
  vm.run('STUB.tip = {}; for i = 1, STUB.Used() do local b = NS.MinimapPins.pool[i]; if b.isNext then b.scripts.OnEnter(b) end end');
  assert.equal(vm.evaluate('GameTooltip.text'), '1. East stop');
  assert.deepEqual(vm.list('STUB.tip'), ['Your next stop: 1 of 3.', '60 yd away.']);
  // Stop 3 as the next stop: out of range, so it sits inside the rim and its arrow points south-east.
  vm.slash('map nav bloodhoof 3');
  const s3 = pinFor(vm, 'bloodhoof', 3);
  const r = 99 - 24;
  assert.ok(s3.next && s3.edge && near(s3.x, r * Math.SQRT1_2) && near(s3.y, -r * Math.SQRT1_2), JSON.stringify(s3));
  assert.ok(near(s3.rotation, -3 * Math.PI / 4), 'the arrow points south-east');
  assert.equal(pinFor(vm, 'bloodhoof', 1).next, false, 'stop 1 is a plain route pin again');
  assert.equal(minimapPins(vm).length, 4);
});

test('minimap pins: they follow a rotating minimap, zooming and the indoor view', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB }).login());
  apply(vm, slotLua({ extra: mapLua(1, [ROUTE, MARKS]) }));
  // Facing west (pi/2) on a rotating minimap: the herb to the west is ahead (up), stop 1 to the east behind.
  vm.run('STUB.cvars.rotateMinimap = "1"; STUB.FireEvent("CVAR_UPDATE", "rotateMinimap", "1"); STUB.facing = math.pi / 2; STUB.Tick(0.01)');
  let herb = pinFor(vm, 'marks', 1), s1 = pinFor(vm, 'bloodhoof', 1);
  assert.ok(near(herb.x, 0) && near(herb.y, 14.85), JSON.stringify(herb));
  assert.ok(near(s1.x, 0) && near(s1.y, -29.7), JSON.stringify(s1));
  // Turning redraws on the next frame, without waiting for the 20-a-second check.
  vm.run('STUB.facing = math.pi; STUB.Tick(0.001)');
  assert.ok(near(pinFor(vm, 'marks', 1).x, 14.85), 'facing south, west is to the right');
  // Where the game ignores rotation, the pins don't turn.
  vm.run('STUB.rotateIgnored = true; STUB.Tick()');
  assert.ok(near(pinFor(vm, 'marks', 1).x, -14.85));
  // A turning minimap without the facing (hidden in instances): no pins rather than wrong ones.
  vm.run('STUB.rotateIgnored = false; STUB.facing = nil; STUB.Tick()');
  assert.equal(minimapPins(vm).length, 0);
  // The setting turned off without an event is picked up within a second.
  vm.run('STUB.facing = 0; STUB.cvars.rotateMinimap = "0"; STUB.Tick(1)');
  assert.ok(near(pinFor(vm, 'bloodhoof', 1).x, 29.7), 'north is up again');
  // Zooming in to 100 yd doubles the distances.
  vm.run('STUB.radius = 100; STUB.Tick()');
  assert.ok(near(pinFor(vm, 'bloodhoof', 1).x, 59.4));
  // Indoors the minimap sees 50 yd: stop 1 (60 yd), the next stop, moves to the east edge; the herb (30 yd) still fits.
  vm.run('STUB.radius = 50; STUB.FireEvent("MINIMAP_UPDATE_ZOOM"); STUB.Tick()');
  s1 = pinFor(vm, 'bloodhoof', 1);
  assert.ok(s1.edge && near(s1.x, 75) && near(s1.y, 0) && near(s1.rotation, -Math.PI / 2), JSON.stringify(s1));
  assert.ok(near(pinFor(vm, 'marks', 1).x, -59.4));
  assert.equal(pinFor(vm, 'bloodhoof', 2), undefined, '90 yd is out of range indoors');
});

test('minimap pins: the next stop advances with the navigator; zone changes; hide, clear, clearall and the toggle remove them', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB }).login());
  apply(vm, slotLua({ extra: mapLua(1, [ROUTE, MARKS]) }));
  assert.equal(pinFor(vm, 'bloodhoof', 1).next, true);
  // Walk onto stop 1: the navigator arrives and moves on, and the minimap shows its new stop.
  vm.run('STUB.posX = 0.56; NQAMap.UpdateNavigator()');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2);
  const s2 = pinFor(vm, 'bloodhoof', 2);
  assert.ok(s2.next && near(s2.x, -29.7) && near(s2.y, 44.55), JSON.stringify(s2));
  assert.equal(pinFor(vm, 'bloodhoof', 1).next, false);
  // Durotar is on another continent: no pins. Back in Loch Modan they return.
  vm.run('STUB.mapID = 1411; STUB.FireEvent("ZONE_CHANGED_NEW_AREA"); STUB.Tick()');
  assert.equal(minimapPins(vm).length, 0);
  vm.run('STUB.mapID = 1432; STUB.FireEvent("ZONE_CHANGED_NEW_AREA"); STUB.Tick()');
  assert.equal(pinFor(vm, 'bloodhoof', 2).next, true);
  // A loading screen (no map for the player) hides them too.
  vm.run('STUB.mapID = nil; STUB.Tick()');
  assert.equal(minimapPins(vm).length, 0);
  vm.run('STUB.mapID = 1432; STUB.Tick()');
  assert.equal(minimapPins(vm).length, 3);
  // The toggle: off hides every pin and stops the checks, and the setting is saved.
  vm.slash('map minimap off');
  assert.equal(minimapPins(vm).length, 0);
  assert.equal(vm.evaluate('NQAMapDB.minimap'), 'false');
  assert.equal(vm.evaluate('NS.MinimapPins.driver.scripts.OnUpdate'), null);
  assert.ok(vm.list('STUB.prints').includes('|cff7ec8ff[NeverQuestAlone]|r Minimap pins hidden.'));
  vm.slash('map');
  assert.ok(vm.list('STUB.prints').includes('|cff7ec8ff[NeverQuestAlone]|r Minimap pins: off.'));
  vm.slash('map minimap on');
  assert.equal(minimapPins(vm).length, 3);
  vm.slash('map minimap');
  assert.equal(vm.evaluate('NQAMapDB.minimap'), 'false', 'no word toggles');
  vm.slash('map minimap');
  // A hidden layer leaves the minimap too.
  vm.slash('map hide marks');
  assert.equal(pinFor(vm, 'marks', 1), undefined);
  vm.slash('map show marks');
  assert.ok(pinFor(vm, 'marks', 1));
  // clear (the bridge drops a layer) and clearall.
  apply(vm, slotLua({ extra: mapLua(2, [ROUTE]) }));
  assert.equal(pinFor(vm, 'marks', 1), undefined);
  assert.ok(pinFor(vm, 'bloodhoof', 2).next);
  apply(vm, slotLua({ extra: mapLua(3, []) }));
  assert.equal(minimapPins(vm).length, 0);
  assert.equal(vm.evaluate('NS.MinimapPins.driver.scripts.OnUpdate'), null, 'nothing left to draw: the checks stop');
});

test('minimap pins: 1,500 points cost only the ones near the player, frames are reused, and nothing redraws while nothing changes', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB }).login());
  // 1,500 points in four layers (400, 400, 400, 300) on a grid over the whole
  // continent, 2% apart: 200 yd east-west, 300 yd north-south.
  const layers = [];
  for (let l = 0, k = 0; l < 4; l++) {
    const pts = [];
    for (let i = 0; i < (l < 3 ? 400 : 300); i++, k++) pts.push(`{ 1415, ${(k % 50) * 2}, ${Math.floor(k / 50) * 2}, "p${k}", "herb" }`);
    layers.push(`{ name = "grid${l}", title = "Grid ${l}", ordered = false, loop = false, points = { ${pts.join(', ')} } }`);
  }
  apply(vm, slotLua({ extra: mapLua(1, layers) }));
  // The player is at 55%, 44% of the continent: only the points 100 yd west and east are in range.
  const pins = minimapPins(vm);
  assert.deepEqual(pins.map(p => p.x).sort((a, b) => a - b).map(x => Math.round(x * 100) / 100), [-49.5, 49.5]);
  assert.equal(vm.num('#NS.MinimapPins.pool'), 2, 'two frames made, not 1,500');
  // Standing still: checks run, nothing redraws.
  const draws = vm.num('NS.MinimapPins.draws');
  vm.run('for i = 1, 20 do STUB.Tick() end');
  assert.equal(vm.num('NS.MinimapPins.draws'), draws);
  // Moving: one redraw per check, the same two frames.
  vm.run('STUB.posX = 0.505; STUB.Tick()');
  assert.equal(vm.num('NS.MinimapPins.draws'), draws + 1);
  assert.equal(vm.num('#NS.MinimapPins.pool'), 2);
  const moved = minimapPins(vm).map(p => p.x).sort((a, b) => a - b);
  assert.ok(near(moved[0], -51.975) && near(moved[1], 47.025), JSON.stringify(moved)); // 105 yd west, 95 yd east
  // Between checks (under 0.05 s) nothing is read at all.
  vm.run('STUB.posX = 0.51; STUB.Tick(0.01)');
  assert.equal(vm.num('NS.MinimapPins.draws'), draws + 1);
});

// [code health AD-15] Map Sync kept any points table, and the navigator works with a stop's map id,
// x and y 10 times a second: one malformed point raised an error every tick.
test('map: Sync drops points the game can\'t place (no numeric map id, x or y), so a bad point can\'t raise an error every tick (code health AD-15)', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB }).login());
  const mixed = `{ name = "mixed", title = "Mixed", ordered = true, loop = false, points = {
    { 1432, nil, 40, "no x", "quest" }, { "1432", 50, 40, "map id as text", "quest" }, { 1432, 56, 0/0, "y not a number", "quest" },
    { 1432, 56, 1/0, "y past the end", "quest" }, "not a point", { 1432, 56, 40, "1. Good", "quest" }, { 1432, 50, 34, "2. Good too", "turnin" } } }`;
  apply(vm, slotLua({ extra: mapLua(1, [mixed]) }));
  assert.deepEqual(vm.list('NQAMapDB.map.layers[1].points').map(p => p[3]), ['1. Good', '2. Good too'], 'only the points the game can place');
  for (let i = 0; i < 20; i++) vm.run('NQAMap.UpdateNavigator(); local d = NQAMap.driver; if d.scripts.OnUpdate then d.scripts.OnUpdate(d, 0.2) end; NS.MinimapPins.Update(true)');
  assert.equal(vm.evaluate('NS.MapShared.navView.label'), '1. Good', 'the route is followed from its first good stop');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

// [code health AD-10, AD-20] Moving along a route, the pins redrew 20 times a second after
// 0.05 yd and the hidden navigator box had its line set 10 times a second; and the route's
// ticker ran every frame for good, checking for a ghost 10 times a second.
test('the minimap pins move once the player moved a pixel\'s worth; the hidden navigator box sets no text; the route\'s ticker runs only while there\'s a route or a corpse (code health AD-10, AD-20)', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB + 'UnitIsGhost = function(unit) return unit == "player" and STUB.ghost == true end' }).login());
  const driving = () => vm.evaluate('NQAMap.driver.scripts.OnUpdate') !== null;
  const tick = () => vm.run('local d = NQAMap.driver; if d.scripts.OnUpdate then d.scripts.OnUpdate(d, 0.2) end');
  tick();
  assert.equal(driving(), false, 'no route, alive: no ticker');
  apply(vm, slotLua({ extra: mapLua(1, [ROUTE, MARKS]) }));
  assert.equal(driving(), true, 'a route starts it');
  tick();
  // 1 px on this minimap is 200 yd / 99 px (2 yd), 0.00202 of the map across.
  const draws = () => vm.num('NS.MinimapPins.draws');
  vm.run('STUB.Tick()');
  const d0 = draws();
  vm.run('STUB.posX = STUB.posX + 0.001; STUB.Tick()');
  vm.run('STUB.posX = STUB.posX + 0.0008; STUB.Tick()');
  assert.equal(draws(), d0, 'under a pixel: no redraw');
  vm.run('STUB.posX = STUB.posX + 0.0004; STUB.Tick()');
  assert.equal(draws(), d0 + 1, 'past a pixel from the last draw: one');
  // The HUD shows the route, so the navigator's box is hidden: its line isn't set, tick after tick.
  vm.run('STUB.navTexts = 0; local t = NQANavigator.text; local set = getmetatable(t).__index(t, "SetText"); t.SetText = function(...) STUB.navTexts = STUB.navTexts + 1; return set(...) end');
  for (let i = 0; i < 10; i++) { vm.run('STUB.posY = STUB.posY + 0.001'); tick(); }
  assert.equal(vm.num('STUB.navTexts'), 0, 'hidden: no text');
  assert.equal(vm.evaluate('NQANavigator.shown'), 'false');
  vm.run('NS.HUD.ShowsRoute = function() return false end');
  tick();
  assert.equal(vm.evaluate('NQANavigator.shown'), 'true');
  assert.match(vm.evaluate('NQANavigator.text.text'), /^\d+ yd {2}\|cff888888Bloodhoof loop\|r/, 'shown: its line at once');
  assert.equal(vm.evaluate('NQANavigator.title.shown'), 'true', 'laid out again as it shows');
  vm.run('NS.HUD.ShowsRoute = function() return true end');
  // The route ends: the ticker stops after its last look.
  vm.slash('map stop');
  tick();
  tick();
  assert.equal(driving(), false, 'no route: stopped');
  // Dying and releasing (a ghost) starts it, coming back stops it.
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick();
  assert.equal(driving(), false, 'dead but not released: nothing to point at yet');
  vm.run('STUB.ghost = true; STUB.FireEvent("PLAYER_ALIVE")');
  assert.equal(driving(), true, 'a ghost: it looks for the corpse');
  tick();
  assert.equal(driving(), true);
  vm.run('STUB.ghost = false; STUB.FireEvent("PLAYER_UNGHOST")');
  tick();
  assert.equal(driving(), false, 'alive again: stopped');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

// [code health AD-09] While a reply was on its way, every quarter-second poll read all five
// doorbells (20 probes a second) and made their paths again each time. The alive bells pulse
// 2.5 s, so the 2-second tick reads them.
test('doorbells: while a reply is on its way the alive bells are read on the 2-second tick only, and a beat is still heard whenever it starts (code health AD-09)', () => {
  const vm = settleSeen(confirmHello(newVM().login()));
  vm.run(`STUB.probes = {}
    local real = PlaySoundFile
    PlaySoundFile = function(path, ...) STUB.probes[path] = (STUB.probes[path] or 0) + 1; return real(path, ...) end`);
  vm.send('ping'); // a reply on its way: the quarter-second tick polls
  vm.run('STUB.probes = {}');
  vm.advance(10);
  const p = vm.json('STUB.probes');
  const n = bell => p[`${vm.evaluate('NS.SIG')}ctl\\bell_${bell}.wav`] || 0;
  assert.ok(n('push_a') >= 38, `the push bells, 4 times a second: ${n('push_a')}`);
  assert.ok(n('alive_a') <= 6 && n('alive_a') >= 4, `the alive bells, every 2 s: ${n('alive_a')}`);
  // A beat (alive_a missing for 2.5 s), started a quarter second later in the 2-second cycle each
  // time (6.25 s apart, as the app's are 20 s apart a bell): heard once each time.
  for (let k = 0; k < 8; k++) {
    const rings = vm.num('NS.R.bells.alive_a and NS.R.bells.alive_a.rings or 0');
    vm.advance(0.25);
    vm.signal('ctl', 'bell_alive_a', false);
    vm.advance(2.5);
    vm.signal('ctl', 'bell_alive_a', true);
    vm.advance(3.5);
    assert.equal(vm.num('NS.R.bells.alive_a.rings'), rings + 1, `a beat started at phase ${k} of 8`);
  }
});

// The player's quest log as C_QuestLog gives it on build 70009.
const QUEST_STUB = `
STUB.log = {
	{ id = 761, title = "The Hunt Continues", complete = false, objectives = { { text = "Prairie Wolf Paw: 3/8", finished = false }, { text = "Plainstrider Talon: 6/6", finished = true } } },
	{ id = 766, title = "Swoop Hunting", complete = true, objectives = { { text = "Trophy Swoop Quill: 8/8", finished = true } } },
}
STUB.done, STUB.titles = {}, { [770] = "Rite of Vision" }
local function Q(id) for _, q in ipairs(STUB.log) do if q.id == id then return q end end end
C_QuestLog = {
	GetNumQuestLogEntries = function() return #STUB.log end,
	GetInfo = function(i) local q = STUB.log[i]; if q then return { title = q.title, questID = q.id, isHeader = false } end end,
	IsOnQuest = function(id) return Q(id) ~= nil end,
	IsComplete = function(id) local q = Q(id); return q ~= nil and q.complete end,
	ReadyForTurnIn = function(id) local q = Q(id); return q ~= nil and q.complete end,
	IsQuestFlaggedCompleted = function(id) return STUB.done[id] == true end,
	GetTitleForQuestID = function(id) local q = Q(id); return q and q.title or STUB.titles[id] end,
	GetQuestObjectives = function(id) local q = Q(id); return q and q.objectives or {} end,
}
`;
// A quest route: kill (quest 761 given), turn in (Swoop Hunting, named only in
// the label), pick up (quest 770 given).
const QUEST_ROUTE = `{ name = "mulgore", title = "Mulgore quests", ordered = true, loop = false, points = {
  { 1432, 56, 40, "2. Wolves and striders", "kill", "Kill 8 Prairie Wolves and 6 Plainstriders; loot their paws and talons.", { 761 } },
  { 1432, 50, 34, "3. Harken: Swoop Hunting", "turnin" },
  { 1432, 80, 60, "4. Zarlman", "quest", "Pick up the next step here.", { 770 } } } }`;

test('map pins: a stop\'s quests as the HUD lists them (CF-LC-30): the title on its own line, then an objective a line, count first and no "slain" (grey, with the tracker\'s check, once done); a done, ready or missing quest is "{title} · …", never a colon after the name', () => {
  const vm = confirmHello(newVM({ extra: QUEST_STUB }).login());
  vm.run(`STUB.log[1].objectives = { { text = "1/8 Razormane Water Seeker slain", finished = false }, { text = "Sunscale Scytheclaw slain: 5/5", finished = true }, { text = "Find the cache", finished = false } }
    STUB.done[770] = true`);
  const lines = ids => vm.run(`STUB.out = NS.MapShared.StopLines({ 1432, 56, 40, "Stop", "kill", "", { ${ids} } })`) || vm.list('STUB.out');
  assert.deepEqual(lines('761'), ['|cffffd100The Hunt Continues|r', '- 1/8 Razormane Water Seeker', '|cff808080|TInterface\\Buttons\\UI-CheckBox-Check:0|t 5/5 Sunscale Scytheclaw|r', '- Find the cache']);
  assert.deepEqual(lines('766'), ['|cff1aff1aSwoop Hunting · complete, turn it in|r']);
  assert.deepEqual(lines('770'), ['|cff808080Rite of Vision · turned in|r']);
  assert.deepEqual(lines('999'), ['|cff808080Quest 999 · not in your quest log|r']);
});

test('navigator: the stop, what to do there and the quest counts; quest stops move on when their quests are done, not on arrival', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB + QUEST_STUB }).login());
  // The navigator's box shows (and draws its line) only where the HUD doesn't show the route (code health AD-10).
  vm.run('NS.HUD.ShowsRoute = function() return false end');
  apply(vm, slotLua({ extra: mapLua(1, [QUEST_ROUTE]) }));
  const tick = () => vm.run('NQAMap.UpdateNavigator()');
  tick();
  assert.equal(vm.evaluate('NQANavigator.title.text'), '1/3  2. Wolves and striders');
  assert.equal(vm.evaluate('NQANavigator.note.text'), 'Kill 8 Prairie Wolves and 6 Plainstriders; loot their paws and talons.');
  // The quest's title on its own line, then an objective a line, count first, as the HUD lists them (CF-LC-30).
  assert.equal(vm.evaluate('NQANavigator.quests.text'), '|cffffd100The Hunt Continues|r\n- 3/8 Prairie Wolf Paw\n|cff808080|TInterface\\Buttons\\UI-CheckBox-Check:0|t 6/6 Plainstrider Talon|r');
  assert.equal(vm.evaluate('NQANavigator.text.text'), '60 yd  |cff888888Mulgore quests|r|cff888888  then 3. Harken: Swoop Hunting|r');
  // No descriptions on the box (the owner): what to do there and the quests' counts are in its tooltip only,
  // and a right-click never steps the route.
  assert.deepEqual([vm.evaluate('NQANavigator.note.shown'), vm.evaluate('NQANavigator.quests.shown')], ['false', 'false']);
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local n = NQANavigator; n.scripts.OnEnter(n)');
  assert.ok(vm.list('STUB.tip').includes('Kill 8 Prairie Wolves and 6 Plainstriders; loot their paws and talons.'));
  assert.equal(vm.evaluate('NQANavigator.scripts.OnMouseUp'), null, 'no right-click step');
  // The minimap pin's tooltip has the same lines.
  vm.run('STUB.tip = {}; for i = 1, STUB.Used() do local b = NS.MinimapPins.pool[i]; if b.isNext then b.scripts.OnEnter(b) end end');
  assert.equal(vm.evaluate('GameTooltip.text'), '2. Wolves and striders');
  assert.deepEqual(vm.list('STUB.tip'), ['Your next stop: 1 of 3.', 'Kill 8 Prairie Wolves and 6 Plainstriders; loot their paws and talons.',
    '|cffffd100The Hunt Continues|r', '- 3/8 Prairie Wolf Paw', '|cff808080|TInterface\\Buttons\\UI-CheckBox-Check:0|t 6/6 Plainstrider Talon|r', '60 yd away.']);
  // Standing in the kill area doesn't move on; the counts follow the quest log.
  vm.run('STUB.posX = 0.56'); tick();
  assert.equal(vm.num('NQAMapDB.nav.index'), 1, 'arriving at a quest stop is not finishing it');
  vm.run('STUB.log[1].objectives[1].text = "Prairie Wolf Paw: 7/8"; STUB.FireEvent("QUEST_LOG_UPDATE")'); tick();
  assert.ok(vm.evaluate('NQANavigator.quests.text').includes('- 7/8 Prairie Wolf Paw'));
  // The quest completes: on to the turn-in, with the arrival ping.
  const pings = () => vm.list('STUB.played').filter(s => String(s) === '3175').length;
  const before = pings();
  vm.run('STUB.log[1].complete = true; STUB.FireEvent("QUEST_LOG_UPDATE")'); tick();
  assert.equal(vm.num('NQAMapDB.nav.index'), 2);
  assert.equal(pings(), before + 1);
  tick();
  assert.equal(vm.evaluate('NQANavigator.quests.text'), '|cff1aff1aSwoop Hunting · complete, turn it in|r', 'found by the title in the label');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2, 'complete is not turned in');
  // Turned in: the quest leaves the log, and the stop still knows it.
  vm.run('table.remove(STUB.log, 2); STUB.FireEvent("QUEST_TURNED_IN", 766, 100, 0)'); tick();
  assert.equal(vm.num('NQAMapDB.nav.index'), 3);
  tick();
  assert.equal(vm.evaluate('NQANavigator.quests.text'), '|cff808080Rite of Vision · pick it up here|r');
  assert.deepEqual(vm.json('{ NS.MapShared.navView.quests[1].state, NS.MapShared.navView.quests[1].pickup }'), ['missing', true], 'one to pick up here: the HUD says where its chain leads (UC-02)');
  // Picked up: the route is finished.
  vm.run('table.insert(STUB.log, { id = 770, title = "Rite of Vision", complete = false, objectives = {} }); STUB.FireEvent("QUEST_ACCEPTED", 770)'); tick();
  assert.equal(vm.evaluate('NQAMapDB.nav'), null);
  assert.ok(vm.list('STUB.prints').includes('|cff7ec8ff[NeverQuestAlone]|r Route finished: Mulgore quests.'));
});

test('navigator: stops already done when a route is drawn are skipped without a ping; stops without quests still move on arrival', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB + QUEST_STUB }).login());
  vm.run('STUB.log[1].complete = true');
  apply(vm, slotLua({ extra: mapLua(1, [QUEST_ROUTE, ROUTE]) }));
  const pings = () => vm.list('STUB.played').filter(s => String(s) === '3175').length;
  const before = pings();
  vm.run('NQAMap.UpdateNavigator()');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2, 'the finished kill stop is skipped');
  assert.equal(pings(), before, 'quietly');
  // A route without quests: arriving at a stop moves on, as before.
  vm.slash('map nav bloodhoof 1');
  vm.run('STUB.posX = 0.56; NQAMap.UpdateNavigator()');
  assert.equal(vm.evaluate('NQAMapDB.nav.layer'), 'bloodhoof');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2);
});

test('navigator (A1): a stop whose quests are all missing, with no pickup ahead, is passed over once the quest log has loaded; pickups and loops never', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB + QUEST_STUB }).login());
  const layer = (name, loop, pts) => `{ name = "${name}", title = "${name}", ordered = true, loop = ${loop}, points = { ${pts.join(', ')} } }`;
  const gone = '{ 1432, 56, 40, "1. Abandoned", "kill", "Kill things.", { 999 } }';
  const wolves = '{ 1432, 50, 34, "2. Wolves", "kill", "Paws.", { 761 } }';
  apply(vm, slotLua({ extra: mapLua(1, [layer('a1', 'false', [gone, wolves]), layer('a1pick', 'false', [gone, '{ 1432, 80, 60, "3. Giver", "quest", "Pick it up.", { 999 } }']),
    layer('a1loop', 'true', [gone, wolves])]) }));
  const at = (name) => { vm.slash(`map nav ${name} 1`); vm.run('NQAMap.UpdateNavigator()'); return vm.num('NQAMapDB.nav.index'); };
  assert.equal(at('a1'), 1, 'before the first QUEST_LOG_UPDATE every quest looks missing: nothing is skipped');
  vm.run('STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(at('a1'), 2, 'quest 999 is not in the log and nothing ahead picks it up: passed over');
  assert.ok(vm.list('STUB.prints').some(l => l.includes("Skipped 1. Abandoned: it isn't in your quest log.")));
  assert.equal(at('a1pick'), 1, 'a pickup for it lies ahead: the stop stays');
  assert.equal(at('a1loop'), 1, 'loops are exempt');
});

test('navigator: a route finished by arriving tells the companion (route_done); skipping past the last stop by hand doesn\'t', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB + QUEST_STUB }).login());
  // The bridge takes states and events, and the app's check-ins switch is on (usage.autoOn).
  const withCaps = s => s.replace(/acked = \{[^}]*\}/, m => `${m}, caps = { "state", "evt", "usage" }, usage = { autoOn = true }`);
  const walk = '{ name = "walk", title = "Walk", ordered = true, loop = false, points = { { 1432, 50, 40, "1. Here", "poi" }, { 1432, 60, 40, "2. There", "poi" } } }';
  apply(vm, withCaps(slotLua({ extra: mapLua(1, [walk]) })));
  const evts = () => vm.outboxWires().filter(e => e.wire.includes('\x1fevt\x1f'));
  vm.slash('map nav walk 1');
  vm.slash('map next');
  vm.slash('map next'); // past the end by hand
  vm.advance(3);
  assert.equal(evts().length, 0, 'a skip is not finishing');
  vm.slash('map nav walk 1');
  vm.run('STUB.posX, STUB.posY = 0.5, 0.4; NQAMap.UpdateNavigator()');
  vm.run('STUB.posX = 0.6; NQAMap.UpdateNavigator()');
  vm.advance(3);
  assert.equal(evts().length, 1, 'arriving at the last stop finishes it');
  assert.ok(evts()[0].wire.includes('kind=route_done'));
});

test('navigator: a stop you step to (the HUD\'s bar, next, prev) is held: chosen where you stand it stays until you\'ve been away; following a route (map nav) isn\'t held', () => {
  const vm = confirmHello(newVM({ extra: MINIMAP_STUB + QUEST_STUB }).login());
  const walk = '{ name = "walk", title = "Walk", ordered = true, loop = false, points = { { 1432, 50, 40, "1. Here", "poi" }, { 1432, 60, 40, "2. There", "poi" }, { 1432, 70, 40, "3. Far", "poi" } } }';
  apply(vm, slotLua({ extra: mapLua(1, [walk]) }));
  vm.slash('map nav walk 1');
  vm.run('STUB.posX, STUB.posY = 0.6, 0.4'); // standing at stop 2
  vm.run('NQAMap.Focus(2); NQAMap.UpdateNavigator(); NQAMap.UpdateNavigator()');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2, 'chosen where you stand: it stays');
  assert.equal(vm.evaluate('NQAMap.StopLabel(2)'), '2. There');
  vm.run('STUB.posX = 0.7; NQAMap.UpdateNavigator()'); // away
  assert.equal(vm.num('NQAMapDB.nav.index'), 2);
  vm.run('STUB.posX = 0.6; NQAMap.UpdateNavigator()'); // back: reached
  assert.equal(vm.num('NQAMapDB.nav.index'), 3, 'away and back: reached, on to the next');
  // prev by hand holds too: standing at 2, it stays.
  vm.slash('map prev');
  vm.run('NQAMap.UpdateNavigator(); NQAMap.UpdateNavigator()');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2, 'prev: held');
  // Following the route again isn't a step: standing at stop 1, it's reached at once.
  vm.run('STUB.posX = 0.5');
  vm.slash('map nav walk 1');
  vm.run('NQAMap.UpdateNavigator()');
  assert.equal(vm.num('NQAMapDB.nav.index'), 2, 'map nav starts where it can');
});

test('/nqa probe: the doorbells as this client hears them, and the push counter read and told', () => {
  const vm = confirmHello(newVM().login());
  vm.slot(slotLua({ push: 4 }));
  ring(vm).advance(6);
  vm.signal('ctl', 'bell_push_b', false).advance(11); // goes missing (heard as a ring), and stays so: dead
  vm.slash('probe');
  const text = notice(vm);
  assert.match(text, /^Signal probe:\npresent\.wav: plays\n/);
  assert.match(text, /\nbell_push_a\.wav: armed; 1 ring\(s\) heard\n/);
  assert.match(text, /\nbell_push_b\.wav: dead: missing since \d+ s ago \(a \/reload brings it back if it was missing when the UI loaded\); 2 ring\(s\) heard\n/);
  assert.match(text, /\nbell_alive_a\.wav: armed; 0 ring\(s\) heard\n/);
  assert.match(text, /\nPush: read up to 4, told NeverQuestAlone 4; last ring \d+ s ago\nSelf-test: static ok, live ok; doorbells on$/);
});

test('pins: a pinned chat moves to the top with a pin and a divider, newest pin first; the menu, /nqa pin|unpin, and kept across a reload', () => {
  const vm = confirmHello(newVM().login());
  for (const n of ['Alpha', 'Beta', 'Gamma']) vm.slash('new ' + n);
  const names = (v = vm) => v.json('(function() local o = {} for i, c in ipairs(NQADB.chats) do o[i] = c.name end return o end)()');
  assert.deepEqual(names(), ['Gamma', 'Beta', 'Alpha', 'Chat 1'], 'the most recent first');
  vm.slash('pin Beta');
  assert.deepEqual(names(), ['Beta', 'Gamma', 'Alpha', 'Chat 1']);
  assert.equal(notice(vm), 'Pinned to the top: Beta');
  vm.run('NS.UI.Toggle(true); NS.UI.RenderList()');
  const row = i => vm.json(`{ pin = NS.UI.ui.rows[${i}].pin.shown, sep = NS.UI.ui.rows[${i}].sep.shown, x = NS.UI.ui.rows[${i}].label.points.LEFT.x }`);
  assert.deepEqual(row(1), { pin: true, sep: true, x: 6 }, 'the pin, the divider under the pinned group, and the name where every name starts (the owner: "left ... aligned")');
  assert.deepEqual(row(2), { pin: false, sep: false, x: 6 });
  assert.deepEqual(vm.json('{ NS.UI.ui.rows[1].pin.anchor.point, NS.UI.ui.rows[1].pin.anchor.relPoint, NS.UI.ui.rows[1].label.points.RIGHT.rel == NS.UI.ui.rows[1].pin }'), ['RIGHT', 'TOPRIGHT', true],
    'the pin at the right of the name\'s line, the name stopping short of it');
  vm.slash('pin 4'); // Chat 1, by its number
  assert.deepEqual(names(), ['Chat 1', 'Beta', 'Gamma', 'Alpha'], 'the newest pin goes on top');
  vm.run('NS.UI.RenderList()');
  assert.deepEqual([row(1).sep, row(2).sep], [false, true], 'the divider moves under the last pinned chat');
  // The right-click menu says Unpin on a pinned chat, and does it.
  vm.run('NS.UI.ChatMenu(NQADB.chats[1].id, NS.UI.ui.rows[1])');
  assert.equal(vm.evaluate('NQAChatMenu.pin.label.text'), 'Unpin');
  vm.run('local it = NQAChatMenu.pin; it.scripts.OnClick(it)');
  assert.deepEqual(names(), ['Beta', 'Gamma', 'Alpha', 'Chat 1'], 'unpinned: back where its last message puts it');
  vm.run('NS.UI.ChatMenu(NQADB.chats[2].id, NS.UI.ui.rows[2])');
  assert.equal(vm.evaluate('NQAChatMenu.pin.label.text'), 'Pin to Top');
  // /nqa chat numbers follow the list; the list marks pins.
  vm.slash('chat 1');
  assert.equal(vm.evaluate('NS.Chats.Active().name'), 'Beta');
  vm.slash('chat');
  assert.match(notice(vm), /^Chats \(\/nqa chat <number> opens one\):\n1\. Beta  \(pinned\)  \(current\)\n2\. Gamma\n/);
  vm.slash('unpin');
  assert.equal(vm.evaluate('NS.Chats.Active().pinned'), null);
  vm.slash('pin Nobody');
  assert.equal(notice(vm), 'No chat called "Nobody". /nqa chat lists them.');
  // Kept across a reload.
  vm.slash('pin Alpha');
  const vm2 = reloadVM(vm).login();
  assert.equal(names(vm2)[0], 'Alpha');
  assert.equal(vm2.evaluate('NQADB.chats[1].pinned'), 'true');
});

test('a chat that never sent: stop says there is nothing to stop, delete and rename send nothing', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('stop');
  assert.equal(notice(vm), 'Nothing to stop: this chat hasn\'t sent anything yet.');
  vm.slash('rename Quiet one');
  vm.slash('delete');
  vm.run('StaticPopupDialogs.NQA_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.outboxWires().length, 0);
  assert.equal(vm.num('#NQADB.chats'), 1, 'a fresh chat takes its place');
  assert.equal(vm.evaluate('NQADB.chats[1].name'), 'Chat 1');
});

test('window: never bigger than the screen (so it can be dragged and its grip reached); the title bar drags it; /nqa window reset', () => {
  // The owner's saved window, taller than their 893.6-unit-high screen.
  const vm = newVM({ db: 'NQADB = { settings = { width = 1287.5, height = 945.5, point = "TOP", relPoint = "TOP", x = -90.75, y = -39.5 } }' }).login();
  vm.run('NS.UI.Toggle(true)');
  assert.equal(vm.num('NQAFrame:GetWidth()'), 1287.5, 'the width fits (1382.4 wide, less 16 each side)');
  assert.equal(vm.num('NQAFrame:GetHeight()'), 861, 'the height shrinks to the screen, less 16 top and bottom');
  assert.equal(vm.num('NQADB.settings.height'), 861, 'and the fitted size is saved');
  // A UI scale change that makes the screen smaller fits it again.
  vm.run('UIParent.width, UIParent.height = 1000, 700; STUB.FireEvent("UI_SCALE_CHANGED")');
  assert.deepEqual([vm.num('NQAFrame:GetWidth()'), vm.num('NQAFrame:GetHeight()')], [968, 668]);
  // The title bar drags the window, and the place is saved.
  vm.run('NQAFrame.StartMoving = function() STUB.moving = true end; local d = NS.UI.ui.drag; d.scripts.OnDragStart(d); d.scripts.OnDragStop(d)');
  assert.equal(vm.evaluate('STUB.moving'), 'true');
  assert.equal(vm.evaluate('NQADB.settings.point'), 'CENTER');
  // /nqa window reset: the default size, top left where the game's own panels open; on this
  // 700-tall screen it already shows more than 140 above the bottom (700 - 116 - 380), clear of the bars.
  vm.slash('window reset');
  assert.deepEqual([vm.num('NQAFrame:GetWidth()'), vm.num('NQAFrame:GetHeight()')], [420, 380]);
  assert.deepEqual([vm.num('NQADB.settings.width'), vm.num('NQADB.settings.height'), vm.evaluate('NQADB.settings.point')], [420, 380, 'TOPLEFT']);
  assert.deepEqual([vm.num('NQAFrame.x'), vm.num('NQAFrame.y')], [16, -116]);
  assert.equal(vm.evaluate('NQAFrame:IsShown()'), 'true');
});

test('key binding: one key opens (cursor in the box) and closes the window, even while typing with a chord', () => {
  const vm = newVM().login();
  vm.run(`
    STUB.keys = {}
    function IsControlKeyDown() return STUB.keys.ctrl == true end
    function IsAltKeyDown() return false end
    function IsShiftKeyDown() return false end
    function GetBindingKey(name) if name == "NQA_OPEN_AND_TYPE" then return STUB.bound end end
  `);
  vm.run('NS.UI.Toggle(false)');
  vm.run('NeverQuestAlone.OpenAndType()');
  assert.equal(vm.evaluate('NQAFrame:IsShown()'), 'true', 'first press opens');
  assert.equal(vm.evaluate('STUB.focus == NS.UI.ui.input'), 'false', 'focus waits a frame, so the key isn\'t typed');
  vm.run('STUB.Advance(0)');
  assert.equal(vm.evaluate('STUB.focus == NS.UI.ui.input'), 'true', 'with the cursor in the box');
  // If the key's character still reaches the box right away, it is taken back.
  vm.run('NS.UI.ui.input:SetText("`"); NS.UI.ui.input:GetScript("OnChar")(NS.UI.ui.input, "`")');
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '', 'the opening key leaves no character behind');
  vm.run('STUB.now = STUB.now + 1; NS.UI.ui.input:SetText("h"); NS.UI.ui.input:GetScript("OnChar")(NS.UI.ui.input, "h")');
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), 'h', 'normal typing afterwards is untouched');
  vm.run('NS.UI.ui.input:SetText("")');
  vm.run('NS.UI.ui.input:ClearFocus(); NeverQuestAlone.OpenAndType()');
  assert.equal(vm.evaluate('NQAFrame:IsShown()'), 'false', 'second press closes');
  // Bound to Ctrl-B: pressed while typing, the box closes the window and keeps the draft.
  vm.run('STUB.bound = "CTRL-B"; NeverQuestAlone.OpenAndType(); STUB.Advance(0); NS.UI.ui.input:SetText("half a thought")');
  vm.run('STUB.keys.ctrl = true; NS.UI.ui.input:GetScript("OnKeyDown")(NS.UI.ui.input, "B"); STUB.keys.ctrl = false');
  assert.equal(vm.evaluate('NQAFrame:IsShown()'), 'false', 'Ctrl-B closes while typing');
  assert.equal(vm.evaluate('STUB.focus == nil'), 'true', 'the keyboard goes back to the game');
  vm.run('NeverQuestAlone.OpenAndType(); STUB.Advance(0)');
  assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), 'half a thought', 'the draft comes back');
  // Bound to a plain letter: typing that letter must not close the window.
  vm.run('STUB.bound = "B"; NS.UI.ui.input:GetScript("OnKeyDown")(NS.UI.ui.input, "B")');
  assert.equal(vm.evaluate('NQAFrame:IsShown()'), 'true', 'a plain letter keeps typing');
  // A function key works too.
  vm.run('STUB.bound = "F9"; NS.UI.ui.input:GetScript("OnKeyDown")(NS.UI.ui.input, "F9")');
  assert.equal(vm.evaluate('NQAFrame:IsShown()'), 'false', 'F9 closes while typing');
});

test('composer: a click anywhere in the text area puts the cursor in the box, at the end', () => {
  const vm = newVM().login();
  vm.run('NS.UI.Toggle(true); NS.UI.ui.input:SetText("hello"); NS.UI.ui.input:ClearFocus()');
  vm.run('NQAInputScroll:GetScript("OnMouseDown")(NQAInputScroll, "LeftButton")');
  assert.equal(vm.evaluate('STUB.focus == NS.UI.ui.input'), 'true', 'below the first line (the scroll frame) focuses the box');
  vm.run('NS.UI.ui.input:ClearFocus(); NQAInputScroll:GetParent():GetScript("OnMouseDown")(NQAInputScroll:GetParent(), "LeftButton")');
  assert.equal(vm.evaluate('STUB.focus == NS.UI.ui.input'), 'true', 'the inset around it too');
});

test('a linked item\'s text is the game\'s own tooltip data (C_TooltipInfo), never a rendered tooltip frame, so no other addon\'s line goes with it (CV-03: a bag tracker named an alt); without that data, only what the link is', () => {
  const vm = confirmHello(newVM().login());
  const link = '|cffffffff|Hitem:2589:0:0:0:0:0:0:0:12:0:0|h[Linen Cloth]|h|r';
  vm.run('STUB.tooltips["item:2589:0:0:0:0:0:0:0:12:0:0"] = { "Linen Cloth", "Crafting Reagent", { "Max Stack: 200", "|cffffffff1s|r" } }');
  // Another addon's post-call, on every tooltip frame: an alt's bags and a total.
  vm.run('STUB.postCall = { { "|cff00ccffAltchar-Testrealm (bags)|r", "18" }, "|cff00ccffTotal: 30|r" }');
  vm.slash('');
  vm.run(`NS.UI.ui.input:SetText(${lstr('should I keep this? ' + link)}); NS.UI.SendFromInput()`);
  const sent = vm.outboxWires().pop().wire.split('\x1f').pop();
  assert.ok(sent.endsWith(['[Linen Cloth] item 2589', '  Linen Cloth', '  Crafting Reagent', '  Max Stack: 200  1s'].join('\n')), sent);
  assert.doesNotMatch(sent, /Altchar|Total: 30/, 'no other addon\'s line');
  // A client without C_TooltipInfo: what the link is, and nothing read off a frame.
  const old = confirmHello(newVM({ extra: 'C_TooltipInfo = nil' }).login());
  old.run('STUB.tooltips["item:2589:0:0:0:0:0:0:0:12:0:0"] = { "Linen Cloth", "Crafting Reagent" }; STUB.postCall = { "Altchar-Testrealm (bags) 18" }');
  old.slash('');
  old.run(`NS.UI.ui.input:SetText(${lstr('should I keep this? ' + link)}); NS.UI.SendFromInput()`);
  const bare = old.outboxWires().pop().wire.split('\x1f').pop();
  assert.ok(bare.endsWith('[Linen Cloth] item 2589'), bare);
  assert.doesNotMatch(bare, /Altchar|Crafting Reagent/);
});

test('saved history has a byte budget as well as a count (security audit PF-06: up to 50 MB of SavedVariables, parsed at every login): over it, the oldest entries go from the chats you used least recently first, (the Companion\'s last), down to their newest 20, then to their newest one; only then the one in use, down to 20', () => {
  const vm = confirmHello(newVM().login());
  // A small budget for the test (the addon's is 1.5 MB); 3,000-byte replies (3,154 bytes each counted, AD-07).
  vm.run(`NS.HISTORY_BYTES = 210000
    local big = string.rep("x", 3000)
    NS.TestChats = {}
    for i = 1, 6 do
      local c = NS.Chats.New("Chat " .. i)
      NS.TestChats[i] = c
      for j = 1, 60 do NS.Chats.AddHistory(c, { role = "assistant", text = big .. i .. ":" .. j, t = 1000 + i * 100 + j }) end
    end`);
  const total = () => vm.num(HISTORY_TOTAL);
  assert.ok(total() <= 210000, `within the budget: ${total()}`);
  const count = i => vm.num(`#NS.TestChats[${i}].history`);
  // The chat in use (6, just written) keeps all 60; the others, least recently used first, went down to 20, then
  // to their newest one, until the words fit.
  assert.equal(count(6), 60);
  assert.equal(count(1), 1, 'the least recently used: its newest one');
  for (const i of [2, 3, 4, 5]) assert.ok(count(i) >= 1 && count(i) <= 20, `chat ${i}: ${count(i)}`);
  assert.equal(vm.evaluate('NS.TestChats[6].history[#NS.TestChats[6].history].text:sub(-4)'), '6:60', 'the newest entry intact');
  assert.equal(vm.evaluate('NS.TestChats[1].history[1].text:sub(-4)'), '1:60', 'a trimmed chat keeps its newest');
  // A pinned chat goes after the unpinned ones (C-113), the Companion's last: chat 1 pinned, a fresh fill.
  // (Filled straight into saved data, as if read at a login: the running total is counted again.)
  vm.run(`for i = 1, 6 do local c = NS.TestChats[i]; c.history = {}; for j = 1, 60 do table.insert(c.history, { role = "assistant", text = string.rep("y", 3000) .. i .. ":" .. j, t = 1000 + i * 100 + j }) end; c.lastAt = 1000 + i * 100 + 60 end
    NS.R.historyBytes = nil
    NS.Chats.SetPinned(NS.TestChats[1].id, true)
    NS.Chats.AddHistory(NS.TestChats[6], { role = "user", text = "hello" })`);
  assert.ok(total() <= 210000);
  assert.ok(count(1) > count(2), `the pinned chat, though used least recently, keeps more: ${count(1)} vs ${count(2)}`);
  // A budget the other chats can't meet alone: the chat in use goes down to its newest 20, never fewer.
  vm.run('NS.HISTORY_BYTES = 50000; NS.Chats.AddHistory(NS.TestChats[6], { role = "user", text = "one more" })');
  assert.equal(count(6), 20);
  assert.equal(vm.evaluate('NS.TestChats[6].history[20].text'), 'one more');
});

// [code health AD-07, AD-08] The budget counted only the text and the TL;DR, so saved data reached
// 4.6 MB under 1.5 MB (what was typed, the chips, usage, refs, keys); and every new entry walked
// every saved one. An entry counts its words and 150 bytes of the rest, and the total is kept.
test('the history budget counts what saved data holds (what was typed, the chips, 150 bytes of the rest an entry), and a new entry walks no saved one (code health AD-07, AD-08)', () => {
  const vm = confirmHello(newVM().login());
  // 20 chats of 200 entries each (the count caps allow 41), filled the way a long season does: links
  // typed, three chips, usage and refs. A 200 KB budget for the test (the addon's is 1.5 MB).
  vm.run(`NS.HISTORY_BYTES = 200000
    local function U(n, k) return string.rep(string.char(97 + k % 26), n) end
    while NS.Chats.OwnCount() < 20 do NS.Chats.New("Chat", { quiet = true }) end
    local i = 0
    for _, c in ipairs(NQADB.chats) do
      for k = 1, 100 do
        i = i + 1
        NS.Chats.AddHistory(c, { role = "user", text = U(20, i) .. i, typed = U(60, i) .. " |cff1eff00|Hitem:2140::::::::7:::::|h[Fine Longsword]|h|r " .. i, key = "ab01_" .. i })
        NS.Chats.AddHistory(c, { role = "assistant", text = U(40, i) .. i, summary = U(150, i), mid = "m" .. i, agent = "main", more = 0,
          chips = { U(78, i), U(78, i + 1), U(78, i + 2) }, usage = { tin = 123456, tout = 1200, micros = 12345, model = "claude-haiku-4-5", exact = true },
          refs = { q = { 1, 2, 3, 4, 5, 6, 7, 8 }, i = { 1, 2, 3, 4, 5, 6, 7, 8 } } })
      end
    end`);
  const saved = Buffer.byteLength(vm.evaluate('STUB.Serialize(NQADB.chats)'));
  assert.ok(vm.num(HISTORY_TOTAL) <= 200000, `counted: ${vm.num(HISTORY_TOTAL)}`);
  // Saved data in the client's form (keys, quotes, numbers) beside what's counted: about 1.4 here, where
  // the text and the TL;DR alone let it reach 5.2 times the budget (the audit's 4.64 MB at 0.89 MB counted).
  assert.ok(saved <= 200000 * 1.5, `saved data stays near the budget: ${saved} bytes`);
  assert.equal(vm.num('NS.R.historyBytes'), vm.num(HISTORY_TOTAL), 'the kept total is the count');
  // A new entry walks no chat's saved entries: the total is kept, not counted again.
  vm.run(`STUB.walks = 0
    local histories = {}
    for _, c in ipairs(NQADB.chats) do histories[c.history] = true end
    local real = ipairs
    ipairs = function(t) if histories[t] then STUB.walks = STUB.walks + 1 end return real(t) end
    local c = NS.Chats.Active()
    for k = 1, 50 do NS.Chats.AddHistory(c, { role = "user", text = "more " .. k }) end
    ipairs = real`);
  assert.equal(vm.num('STUB.walks'), 0, 'no walk over the saved entries');
  // A deleted chat leaves the total; it's counted again once, and agrees.
  vm.run('NS.Chats.Delete(NQADB.chats[3].id); NS.Chats.AddHistory(NS.Chats.Active(), { role = "user", text = "after a delete" })');
  assert.equal(vm.num('NS.R.historyBytes'), vm.num(HISTORY_TOTAL));
});

// Every shown text under a frame (EditBoxes left out), for what a player reads on it.
function shownTexts(vm, root) {
  return vm.evaluate(`(function() local out = {}
    local function walk(f, vis) if type(f) ~= "table" then return end
      local shown = vis and (f.shown ~= false)
      if type(f.text) == "string" and f.text ~= "" and shown and f.kind ~= "EditBox" then out[#out + 1] = f.text end
      for _, c in ipairs(f.children or {}) do walk(c, shown) end
      for _, r in ipairs(f.regions or {}) do walk(r, shown) end
    end
    if ${root} == nil then return "" end
    walk(${root}, true); return table.concat(out, " || ") end)()`);
}

test('C-137: a fresh install with no app (Copy and Paste on) gets main\'s Welcome, never the app-only setup it can\'t finish; an app\'s install still gets the setup rows', () => {
  const vm = newVM({ linked: false }).login();
  for (const t of [2, 30, 200]) {
    vm.advance(t);
    const hud = shownTexts(vm, 'NQAHUD');
    assert.match(hud, /Click Ask/, `the Welcome's words at +${t} s: ${hud}`);
    assert.doesNotMatch(hud, /of 3 done|Say Hi works once|Open the NeverQuestAlone app/, `no setup rows at +${t} s: ${hud}`);
  }
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.equal(vm.evaluate('NS.HUD.h.label.text'), 'Welcome');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), vm.evaluate('NS.Paste.Named(NS.Paste.WELCOME)'));
  assert.equal(vm.evaluate('tostring(NS.HUD.h.setupOk:IsShown())'), 'true', 'its Okay');
  assert.equal(vm.evaluate('tostring(NS.HUD.h.sayHiBtn:IsShown())'), 'false', 'no Say Hi to grey out');
  vm.run('NS.UI.Toggle(true)'); vm.advance(0.5);
  const win = shownTexts(vm, 'NQAFrame');
  assert.doesNotMatch(win, /Setting up NeverQuestAlone/, win);
  assert.match(win, /Each message opens a window where you copy it into ChatGPT/, 'the Copy and Paste starter stays');
  assert.equal(vm.evaluate('tostring(NS.UI.StarterStale(NS.Chats.Active()))'), 'false', 'the empty chat isn\'t redrawn every tick');
  // Okay puts it away for the session.
  vm.run('NS.HUD.h.setupOk:Click()'); vm.advance(1);
  assert.doesNotMatch(shownTexts(vm, 'NQAHUD'), /Click Ask and ask me anything/);
  // An install an app has answered keeps the setup block (linked is the default here).
  const app = newVM().login().advance(2);
  assert.doesNotMatch(shownTexts(app, 'NQAHUD'), /Click Ask and ask me anything/);
  assert.equal(app.evaluate('tostring(NS.HUD.PasteWelcome())'), 'false');
});
