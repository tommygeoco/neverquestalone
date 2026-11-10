import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeBackend, startMock, sendParams, waitFor } from './helpers/byok-env.mjs';
import { luaValue } from '../../bridge/transport/luaenc.mjs';
const require = createRequire(import.meta.url);
const { newVM } = require('../helpers/nqa-vm');
const { confirmHello, apply, byokSlot, provider } = require('../helpers/byok-slots');

const CHAT = 'c3f9a1e';
const config = url => ({ provider: 'custom', model: 'claude-code:sonnet', custom: { baseUrl: `${url}/v1`, model: 'claude-code:sonnet' } });
const modelsReply = ids => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: ids.map(id => ({ id })) }) });

test('model picker: discovers subscription models, sends a selected model, persists it, and clears the old list on service change', async () => {
  const ids = ['claude-code:sonnet', 'claude-code:haiku', 'codex:gpt-6-luna'];
  const mock = await startMock(r => r.method === 'GET' ? modelsReply(ids) : {
    status: 200, headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"choices":[{"delta":{"content":"Hello.\\n\\nTL;DR: Hello."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  });
  const other = await startMock(() => modelsReply(['other-model']));
  const env = makeBackend({ config: config(mock.url), checks: { models: true } });
  try {
    await env.backend.start();
    await env.backend.checkModel();
    const choices = env.backend.slotExtras().bridge.provider.models;
    assert.deepEqual(choices.map(m => m.id), ids);
    const vm = confirmHello(newVM().login());
    apply(vm, byokSlot({ p: luaValue(env.backend.slotExtras().bridge.provider) }));
    assert.deepEqual(vm.json('NS.UI.ModelChoices()').map(m => m.id), ids, 'the real backend list survives Lua encoding and addon parsing');
    assert.ok(env.changes.some(c => c.push), 'list arrival publishes a fresh slot');
    assert.equal(env.backend.setChatModel(CHAT, ids[2]).ok, true);
    assert.equal(env.backend.chatSlot(CHAT).model, ids[2]);
    await env.backend.send(sendParams(CHAT, 'abc1_1', 'Hello'));
    await waitFor(() => env.chats('final').length, 5000, 'selected-model reply');
    assert.equal(mock.requests.find(r => r.method === 'POST').body.model, ids[2], 'the request uses the selected model');
    const restarted = makeBackend({ dataDir: env.dataDir, config: config(mock.url) });
    try {
      await restarted.backend.start();
      assert.equal(restarted.backend.chatSlot(CHAT).model, ids[2]);
      assert.equal(restarted.backend.setChatModel(CHAT, 'default').ok, true);
      assert.equal(restarted.backend.chatSlot(CHAT).model, undefined);
    } finally { await restarted.backend.stop(); }
    await env.backend.setConfig(config(other.url));
    assert.equal(env.backend.chatSlot(CHAT).model, undefined, 'a different custom host also clears the old chat model');
    assert.ok(!env.backend.slotExtras().bridge.provider.models.some(m => m.id === ids[2]), 'no choices from the previous host');
    await env.backend.checkModel();
    assert.ok(env.backend.slotExtras().bridge.provider.models.some(m => m.id === 'other-model'));
  } finally { await env.backend.stop(); await mock.close(); await other.close(); }
});

test('model picker: discovery deduplicates and bounds IDs, rejects credentials and invalid IDs', async () => {
  const ids = ['claude-code:sonnet', 'claude-code:sonnet', 'bad id', 'x'.repeat(81), 'sk-proj-' + 'a'.repeat(48), ...Array.from({ length: 80 }, (_, i) => `model-${i}`)];
  const mock = await startMock(() => modelsReply(ids));
  const env = makeBackend({ config: config(mock.url), checks: { models: true } });
  try {
    await env.backend.start(); await env.backend.checkModel();
    const choices = env.backend.slotExtras().bridge.provider.models;
    assert.equal(new Set(choices.map(m => m.id)).size, choices.length);
    assert.ok(choices.length <= 24);
    assert.ok(Buffer.byteLength(JSON.stringify(choices)) <= 2048);
    assert.ok(!choices.some(m => /sk-proj|bad id|x{81}/.test(m.id)));
    assert.equal(choices[0].id, 'claude-code:sonnet');
  } finally { await env.backend.stop(); await mock.close(); }
});

function addon() {
  const vm = confirmHello(newVM().login());
  const list = '{ { id = "claude-code:sonnet", label = "Claude Sonnet" }, { id = "codex:gpt-6-luna", label = "GPT Luna" } }';
  const p = provider({ id: 'custom', model: 'claude-code:sonnet', modelName: 'Claude Sonnet', effortSupported: false }).replace(/ }$/, `, models = ${list} }`);
  apply(vm, byokSlot({ p }));
  vm.run('NS.Refresh("status")');
  return vm;
}

test('model picker: header opens model choices without thinking controls; selection is pending until confirmed', () => {
  const vm = addon();
  assert.equal(vm.evaluate('NS.UI.NoEffort(NS.Chats.Active())'), 'true');
  assert.equal(vm.evaluate('NS.UI.ui.thinkBtn.shown'), 'true');
  vm.run(`STUB.menu = {}; STUB.actions = {}; MenuUtil = { CreateContextMenu = function(owner, fn)
    local root = {}; function root:CreateTitle(t) table.insert(STUB.menu, t) end
    function root:CreateButton(t, cb) table.insert(STUB.menu, t); STUB.actions[t] = cb end
    fn(owner, root) end }; local b = NS.UI.ui.thinkBtn; b.scripts.OnClick(b)`);
  assert.deepEqual(vm.list('STUB.menu'), ['Model for This Chat', 'Default (Claude Sonnet)', 'Claude Sonnet', 'GPT Luna']);
  vm.run('STUB.actions["GPT Luna"]()');
  assert.ok(vm.outboxWires().some(e => e.wire.includes('model=codex:gpt-6-luna')));
  assert.equal(vm.evaluate('NS.Chats.Active().modelAsked'), 'codex:gpt-6-luna');
  assert.equal(vm.evaluate('NS.Chats.Active().model'), null, 'not confirmed early');
  vm.run('NS.Chats.ConfirmModel(NS.Chats.Active(), "codex:gpt-6-luna", true)');
  assert.equal(vm.evaluate('NS.Chats.Active().model'), 'codex:gpt-6-luna');
  vm.run('STUB.actions["Default (Claude Sonnet)"]()');
  assert.equal(vm.evaluate('NS.Chats.Active().modelAsked'), 'default');
});

test('model picker: older clients without MenuUtil still offer a clickable list', () => {
  const vm = addon();
  vm.run('MenuUtil = nil; local b = NS.UI.ui.thinkBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NS.UI.ui.popup.shown'), 'true');
  vm.run('local b = NS.UI.ui.popup.items[3]; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NS.Chats.Active().modelAsked'), 'codex:gpt-6-luna');
  assert.equal(vm.evaluate('NS.UI.ui.popup.shown'), 'false');
});
