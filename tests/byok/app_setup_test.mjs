// Setup in the window (app/desktop/renderer/app.js; the redesign's build spec §6.1), run in the mini
// DOM over the real IPC layer and the mock API (helpers/page-rig.mjs): NeverQuestAlone's panel and the quest
// tracker, step 2 "Connect your AI" and every key result, Other's form, step 3 "Say hi in game" and its
// objectives, "You're set", reopening and Finish later, and the scans every setup state must pass.
// Canary keys only; the clipboard is the rig's (main reads it), never the page's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageRig } from './helpers/page-rig.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const ANT = `sk-ant-api03-CANARY${'x'.repeat(80)}`;
const BAD = `sk-ant-api03-CANARY${'x'.repeat(74)}BADKEY`;
const OAI = `sk-proj-CANARY${'x'.repeat(60)}`;
const NOCREDIT = `sk-ant-api03-CANARY${'x'.repeat(70)}NOCREDIT`; // gitleaks:allow
const SAVED = { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } };
const REJECTED = { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null };
const CONNECTED = { keys: SAVED, choice: HAIKU, terms: { anthropic: 1 } };
const CUSTOM_LOCAL = { custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' }, choice: { provider: 'custom', model: 'qwen3:8b', effort: null } };
const AT = screen => ({ defaultsSeen: screen === 'wow', setup: { v: 2, screen, path: 'key', provider: 'anthropic' } });
const titleText = r => r.document.getElementById('page-title')?.textContent;
const active = r => r.document.activeElement;
const fk = (r, key) => r.document.querySelector(`[data-fk="${key}"]`);
const label = b => (b.querySelector('.btn-label') || b).textContent;
const primaries = r => r.document.querySelectorAll('#page .btn-primary, #banners .btn-primary, #topbar .btn-primary');
const result = r => r.document.querySelector('#result-slot .result');
// Setup goes straight on to step 3 once a key works, saying the result once on the way (2026-10-05:
// a player stopped at "Claude is connected." and never reached the addon install).
const wentOn = (r, said) => {
  assert.equal(titleText(r), 'Set up WoW', 'straight on to step 3, no Continue to find');
  assert.ok(r.liveText().some(t => t === said), `said: ${said}`);
};
const whyBox = r => r.document.getElementById('still-waiting-box')?.textContent ?? '';
const picked = r => r.document.querySelector('.choice[aria-checked="true"]')?.getAttribute('data-fk');
// "provider" is left out: the manifests' privacy cards (their player text) still use it for the
// companies OpenRouter routes to; that's the copy session's to change, not setup's.
const PLUMBING = /\b(?:bridge|gateway|slots?|strip|tokens?|egress|doorbell|payload|endpoint|JSON|protocol|pixel mode|transport|engine|backend|onboarding|wizard)\b/i;

/** Every string the window shows (text and accessible names), for the scans. */
function shown(r) {
  const names = r.document.querySelectorAll('[aria-label]').map(e => e.getAttribute('aria-label'));
  return `${r.stageText()} ${r.statusText()} ${r.sheetText()} ${names.join(' ')}`;
}
function scan(r, labelText) {
  // "sign-in token" is STYLE §10's allowed phrase (the one line that says it isn't an API key).
  const t = shown(r).replace(/sk-ant-…xxxx|sk-proj-…xxxx/g, '').replace(/sign-in token/g, '');
  assert.doesNotMatch(t, /⟦[^⟧]+⟧/, `${labelText}: an id the table doesn't have`);
  assert.doesNotMatch(t, PLUMBING, `${labelText}: a plumbing word`);
  assert.doesNotMatch(t, /Step \d+ of \d+/, `${labelText}: never "Step N of M"`);
  assert.doesNotMatch(t, /stops at/i, `${labelText}: no stop promised (DB26)`);
  assert.doesNotMatch(t, /\{[a-zA-Z]+\}|undefined/, `${labelText}: a placeholder left unfilled`);
}
async function pick(r, id) { await r.press(fk(r, `card-${id}`)); }
async function paste(r, text, where = 'paste-key') { r.setClipboard(text); await r.press(fk(r, where)); }
const atWow = (state = {}, o = {}) => pageRig({ onboarded: false, state: { ...CONNECTED, ...state }, appState: AT('wow'), ...o });

// ---------------------------------------------------------------------------
// NeverQuestAlone's panel and the tracker.

test('NeverQuestAlone’s panel: the landmark is named for the companion shown, a renamed one too (CL-words-71)', async () => {
  const r = await pageRig({ state: { ...CONNECTED, companion: 'Mort' } });
  assert.match(r.document.getElementById('bones-btn').getAttribute('aria-label'), /^Mort\b/);
  assert.equal(r.document.getElementById('companion').getAttribute('aria-label'), 'Mort');
  assert.equal(r.document.getElementById('portrait').getAttribute('aria-hidden'), 'true');
  assert.equal(r.document.getElementById('portrait').getAttribute('aria-label'), null, 'the hidden portrait has no label of its own');
});

test('NeverQuestAlone’s panel in setup: his portrait (named for him, nothing to open yet), no status word and no speech line (the 1.3 refresh), the tracker by name, never Step N of M; no nav', async () => {
  const r = await pageRig({ onboarded: false });
  assert.equal(r.document.getElementById('app').getAttribute('data-mode'), 'setup');
  const bb = r.document.getElementById('bones-btn');
  assert.equal(bb.getAttribute('aria-hidden'), 'true', 'in setup the steps say where things stand: the portrait is a picture');
  assert.equal(bb.getAttribute('tabindex'), '-1');
  assert.equal(r.statusText(), '', 'no status word in setup');
  assert.equal(r.document.getElementById('says'), null, 'no speech line (the owner, 2026-10-02)');
  assert.equal(r.document.getElementById('nav').hidden, true, 'setup has the tracker, not the nav');
  const tr = r.document.getElementById('tracker');
  assert.equal(tr.hidden, false);
  assert.equal(tr.getAttribute('aria-label'), 'Setup progress');
  assert.deepEqual(tr.querySelectorAll('.tracker-text').map(e => e.textContent), ['Download', 'Connect your AI', 'Set up WoW']);
  assert.deepEqual(tr.querySelectorAll('.sr-only').map(e => e.textContent), ['Download, done', 'Connect your AI', 'Set up WoW']);
  assert.equal(tr.querySelectorAll('[aria-current="step"]').length, 1);
  assert.equal(tr.querySelector('[aria-current="step"] .sr-only').textContent, 'Connect your AI');
  assert.ok(tr.querySelectorAll('.tracker-mark').every(m => m.getAttribute('aria-hidden') === 'true'), 'the diamonds are decoration');
  assert.doesNotMatch(tr.textContent, /Step \d/);
  scan(r, 'step 2');
  // Needs credit and Key rejected are said on the tracker, never a done mark.
  const nc = await atWow({ keyState: { anthropic: 'no_credit' }, addonInstalled: true });
  assert.ok(nc.document.querySelectorAll('#tracker .sr-only').some(e => e.textContent === 'Connect your AI, needs credit'));
  assert.ok(nc.document.querySelector('#tracker .tracker-credit .ico-dia-warn'));
  const rj = await atWow({ keys: REJECTED });
  assert.ok(rj.document.querySelectorAll('#tracker .sr-only').some(e => e.textContent === 'Connect your AI, key rejected'));
  // His eyes follow his state: step 3's objectives, then the first reply, then a card that stops him.
  const s3 = await atWow();
  assert.equal(s3.document.getElementById('portrait').getAttribute('data-mood'), 'idle');
  const done = await atWow({ addonInstalled: true, setup: { firstReplyAt: 3 } });
  assert.equal(done.document.getElementById('portrait').getAttribute('data-mood'), 'happy', 'his eyes brighten, once');
  assert.equal(nc.document.getElementById('portrait').getAttribute('data-mood'), 'needs');
});

test('Finish later: counts as done; Home names the first missing piece with Finish setup, which opens the saved screen', async () => {
  const r = await pageRig({ onboarded: false });
  await pick(r, 'openai');
  await r.click('Finish later');
  assert.equal(r.appState().onboarded, true);
  assert.equal(r.appState().setup.screen, 'ai', 'the saved screen');
  assert.equal(r.appState().setup.provider, 'openai', 'and the AI picked');
  assert.equal(titleText(r), 'Almost set up', 'the title never repeats the button');
  assert.match(r.pageText(), /NeverQuestAlone can’t answer yet\./);
  assert.deepEqual(primaries(r).map(label), ['Finish setup']);
  await r.press(fk(r, 'finish-setup'));
  assert.equal(titleText(r), 'Connect your AI');
  assert.equal(picked(r), 'card-openai', 'the AI picked before');
  const addon = await pageRig({ state: CONNECTED, appState: { ...AT('wow'), onboarded: true } });
  assert.match(addon.pageText(), /The addon isn’t in WoW yet\./);
  const screen = await pageRig({ state: { ...CONNECTED, addonInstalled: true }, appState: { ...AT('wow'), onboarded: true } });
  assert.match(screen.pageText(), /NeverQuestAlone can’t see the game yet\./);
  // On another page, no banner (the app trim): the nav's Finish setup is the way back, and Home says what's missing.
  await screen.click('Settings');
  assert.equal(screen.bannerText(), '', 'no banner on another page');
  assert.equal(screen.document.querySelector('[data-nav="setup-now"]').hidden, false, 'the nav’s Finish setup is there');
  await screen.press(screen.document.querySelector('[data-nav="home"]'));
  assert.equal(titleText(screen), 'Almost set up');
  const done = await pageRig({ state: { ...CONNECTED, addonInstalled: true, setup: { firstReplyAt: 1 } }, appState: { ...AT('wow'), onboarded: true } });
  assert.doesNotMatch(done.pageText() + done.bannerText(), /Finish setup/, 'nothing once the first reply came');
  const plain = await pageRig({ state: CONNECTED });
  assert.doesNotMatch(plain.pageText() + plain.bannerText(), /Finish setup/, 'only for a setup left with Finish later');
});

test('reopening: the saved screen when its prerequisite holds, else the first stage not done (§3.11); the old screens map to the new steps', async () => {
  const open = async (state, appState) => titleText(await pageRig({ onboarded: false, state, appState }));
  assert.equal(await open({}, { setup: { v: 2, screen: 'connect', path: 'key', provider: 'anthropic' } }), 'Connect your AI', 'the old Connect <AI> is step 2');
  const hidden = await pageRig({ onboarded: false, state: { hidden: ['xai'] }, appState: { setup: { v: 2, screen: 'connect', path: 'key', provider: 'xai' } } });
  assert.equal(titleText(hidden), 'Connect your AI');
  assert.match(hidden.pageText(), /Grok isn’t available right now\. Pick another\./);
  assert.equal(await open({}, { setup: { v: 2, screen: 'connect', path: 'custom', provider: 'custom' } }), 'Connect another AI');
  assert.equal(await open(CONNECTED, AT('defaults')), 'Set up WoW', 'the old Check your defaults is gone: step 3');
  assert.equal(await open({}, AT('defaults')), 'Connect your AI', 'no AI: the first stage');
  assert.equal(await open(CONNECTED, AT('wow')), 'Set up WoW');
  assert.equal(await open({ ...CONNECTED, keyState: { anthropic: 'no_credit' } }, AT('wow')), 'Set up WoW', 'a key saved with no credit still reaches it');
  assert.equal(await open(CONNECTED, {}), 'Set up WoW', 'no saved screen: the first not done');
  // A key rejected while the window was closed: Say hi in game with its banner (Replace key).
  const s4 = await pageRig({ onboarded: false, state: { ...CONNECTED, keys: REJECTED }, appState: AT('wow') });
  assert.equal(titleText(s4), 'Set up WoW');
  assert.match(s4.pageText(), /Anthropic rejected your key\./);
  assert.deepEqual(primaries(s4).map(label), ['Replace key']);
  // Step 2 with it: the row's chip says Key rejected (the bad tone), and Paste new key is the primary.
  const s2 = await pageRig({ onboarded: false, state: { ...CONNECTED, keys: REJECTED }, appState: { setup: { v: 2, screen: 'ai', path: 'key', provider: null } } });
  assert.equal(titleText(s2), 'Connect your AI');
  const chip = fk(s2, 'card-anthropic').querySelector('.chip');
  assert.equal(chip.textContent, 'Key rejected');
  assert.match(chip.className, /\bchip-bad\b/);
  assert.deepEqual(primaries(s2).map(label), ['Paste new key']);
  assert.equal(s2.byText('Use saved key').length, 0, 'a rejected key is never offered again');
  assert.equal(s2.document.querySelector('.pick-head .lead').textContent, '', 'the chip is a result: no words at all, never a credit need beside Key rejected (CL-words-68; the app trim dropped the plain lead)');
  assert.match(s2.document.querySelector('.pick-head .lead').className, /\blead-slot\b/, 'its slot kept, so the rows never move (CL-design-51)');
  const ok1 = await pageRig({ onboarded: false, state: CONNECTED, appState: { setup: { v: 2, screen: 'ai', path: 'key', provider: null } } });
  assert.equal(fk(ok1, 'card-anthropic').querySelector('.chip').textContent, 'Key saved');
  assert.match(fk(ok1, 'card-anthropic').querySelector('.chip').className, /\bchip-ok\b/);
});

// ---------------------------------------------------------------------------
// Step 2: Connect your AI.

test('the welcome (a first run): what NeverQuestAlone does for your questing, his window in WoW, the AI a supporting line; one primary, Set up NeverQuestAlone, to step 2', async () => {
  const r = await pageRig({ onboarded: false, welcome: true });
  assert.equal(titleText(r), 'Meet NeverQuestAlone');
  assert.equal(active(r).id, 'page-title');
  assert.match(r.pageText(), /^Meet NeverQuestAlonePicks your next quests, draws the route and tracks things down\.Runs on the AI you pick\.Set up NeverQuestAlone$/, 'the AI line under the lead, before the one primary (APP-D-22)');
  assert.equal(r.document.getElementById('portrait').getAttribute('data-mood'), 'happy');
  // The hero is the promise pictured: the route drawn on the map (CL-design-23).
  const map = r.document.querySelector('#page figure.mapfig');
  assert.ok(map && map.querySelector('img'), 'the route on the map');
  assert.equal(map.getAttribute('aria-label'), 'NeverQuestAlone’s route on your map: your next quests, in order.');
  // No step is current on the welcome (CL-design-31).
  assert.equal(r.document.querySelector('#tracker [aria-current="step"]'), null);
  assert.deepEqual(primaries(r).map(label), ['Set up NeverQuestAlone']);
  assert.equal(r.document.querySelector('[data-fk="back"]'), null);
  assert.ok(fk(r, 'finish-later'), 'Finish later, as on every setup screen');
  scan(r, 'welcome');
  await r.press(fk(r, 'start-setup'));
  assert.equal(titleText(r), 'Connect your AI');
  assert.equal(r.appState().setup.screen, 'ai', 'a reopen comes back to step 2, never the welcome again');
  // Only a first run: a saved screen, or a set-up AI, goes straight on.
  const back = await pageRig({ onboarded: false, welcome: true, appState: { setup: { v: 2, screen: 'ai', path: 'key', provider: 'openai' } } });
  assert.equal(titleText(back), 'Connect your AI');
  const set = await pageRig({ onboarded: false, welcome: true, state: CONNECTED });
  assert.equal(titleText(set), 'Set up WoW');
});

test('step 2: five rows from the manifests (a name, its company, a day’s cost), Claude picked; the one line says what the picked AI needs (credit at its company, CL-player-29); one primary (Paste Anthropic key ⌘V), the AI company’s key page, Show details; no long text on the stage', async () => {
  const r = await pageRig({ onboarded: false });
  assert.equal(titleText(r), 'Connect your AI');
  assert.equal(r.document.querySelector('.pick-head .lead').textContent, 'Claude needs an API key and credit at Anthropic.', 'the AI is the subject (CL-words-65)');
  assert.equal(active(r).id, 'page-title');
  const group = r.document.querySelector('.choices');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-label'), 'AI');
  const rows = group.querySelectorAll('.choice');
  assert.deepEqual(rows.map(c => c.querySelector('.choice-title').textContent), ['Claude', 'ChatGPT', 'Grok', 'Gemini', 'Other']);
  assert.equal(rows.filter(c => c.querySelector('.choice-maker')).length, 0, 'a row is its name and its cost: the company is on the button (the app trim)');
  assert.deepEqual(rows.map(c => c.querySelector('.choice-cost').textContent), ['$0.77–1.34 a day', '$0.74–1.34 a day', '$0.65–1.12 a day', '$0.29–0.50 a day', 'Cost varies'], 'each AI\'s default (fix-102), from the price table');
  assert.ok(rows.every(c => c.getAttribute('role') === 'radio'));
  assert.deepEqual(rows.map(c => c.getAttribute('aria-checked')), ['true', 'false', 'false', 'false', 'false'], 'Claude picked on a fresh run');
  assert.deepEqual(rows.map(c => c.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1'], 'a roving tab stop');
  assert.equal(r.document.querySelector('.pick-head .label'), null, 'no column header: each cost says a day');
  assert.deepEqual(primaries(r).map(label), ['Paste Anthropic key']);
  const paste1 = fk(r, 'paste-key');
  assert.equal(paste1.querySelector('kbd').textContent, '⌘V');
  assert.equal(paste1.getAttribute('aria-keyshortcuts'), 'Meta+V');
  assert.ok(r.byText('Open Anthropic’s key page').length, 'the AI company’s key page');
  await r.click('Open Anthropic’s key page');
  assert.ok(r.opened.some(u => /claude\.com|anthropic\.com/.test(u)));
  assert.equal(label(fk(r, 'details')), 'Show details');
  assert.equal(fk(r, 'finish-later').parentNode.id, 'side-foot', 'Finish later in the panel’s foot, beside the version (the owner, 2026-10-02)');
  assert.equal(r.document.querySelector('[data-fk="back"]'), null, 'no Back on step 2');
  // What used to be on the screen is behind Show details now.
  assert.doesNotMatch(r.pageText(), /Keychain|terms|unofficial|Claude Pro|A day is about 40 replies/i);
  assert.equal(r.byText('Try NeverQuestAlone free').length, 0, 'no free path');
  assert.doesNotMatch(r.pageText(), /daily limit/i);
  scan(r, 'step 2');
  // ChatGPT's first link is its credit page; a hidden AI has no row.
  await pick(r, 'openai');
  assert.equal(picked(r), 'card-openai');
  assert.deepEqual(primaries(r).map(label), ['Paste OpenAI key']);
  assert.ok(r.byText('Open OpenAI’s key page').length, 'one key link, the same words for every AI (player-29)');
  assert.equal(r.appState().setup.provider, 'openai', 'the pick is saved for a reopen');
  const hid = await pageRig({ onboarded: false, state: { hidden: ['xai'] } });
  assert.deepEqual(hid.document.querySelectorAll('.choice .choice-title').map(c => c.textContent), ['Claude', 'ChatGPT', 'Gemini', 'Other']);
  const win = await pageRig({ onboarded: false, platform: 'win32' });
  assert.equal(fk(win, 'paste-key').querySelector('kbd').textContent, 'Ctrl+V');
  assert.equal(fk(win, 'paste-key').getAttribute('aria-keyshortcuts'), 'Control+V');
});

test('step 2’s rows are a radio group: the arrow keys move and pick; Other picked makes the primary Set up Other and hides the key page', async () => {
  const r = await pageRig({ onboarded: false });
  const claude = fk(r, 'card-anthropic');
  claude.focus();
  claude.dispatchEvent(r.event('keydown', { key: 'ArrowDown' }));
  await r.settle(20);
  assert.equal(picked(r), 'card-openai');
  assert.equal(active(r).getAttribute('data-fk'), 'card-openai', 'focus moves with the pick');
  active(r).dispatchEvent(r.event('keydown', { key: 'ArrowUp' }));
  await r.settle(20);
  assert.equal(picked(r), 'card-anthropic');
  active(r).dispatchEvent(r.event('keydown', { key: 'ArrowUp' }));
  await r.settle(20);
  assert.equal(picked(r), 'card-custom', 'it wraps');
  assert.deepEqual(primaries(r).map(label), ['Connect another AI']);
  assert.equal(r.byText('Open Anthropic’s key page').length + r.byText('Add credit at OpenAI').length, 0);
  await r.press(fk(r, 'set-up-other'));
  assert.equal(titleText(r), 'Connect another AI');
});

test('step 2, Show details: the sheet scoped to the AI picked (cost, your key, what leaves your Mac, where it’s kept, terms, fine print); focus in it, Esc closes it back to Show details', async () => {
  const r = await pageRig({ onboarded: false });
  await r.press(fk(r, 'details'));
  const sheet = r.document.querySelector('#sheet-host .sheet');
  assert.ok(sheet);
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(r.document.getElementById('sheet-title').textContent, 'Claude, in detail');
  assert.equal(active(r).id, 'sheet-title', 'focus moves to its heading');
  assert.equal(r.document.getElementById('main-body').hasAttribute('inert'), true, 'the rest waits behind it');
  const t = r.sheetText();
  assert.deepEqual(sheet.querySelectorAll('.label').map(e => e.textContent), ['Cost', 'Your key', 'Where it goes', 'At Anthropic']);
  assert.match(t, /Priced for about 40 replies a day, thinking at Low\. You pay Anthropic as you go\./);
  assert.match(t, /A Claude Pro or Max subscription isn’t an API key\./);
  assert.match(t, /In your macOS Keychain\. Never in the game; sent only to Anthropic\./);
  // The picture of where it goes, then one line; what Anthropic keeps is the manifest's own short line.
  // Every section is a card of rows (the owner, 2026-10-03; APP-D-40): the picture is Where it goes' first row.
  const pic = sheet.querySelector('.sheet-card .sheet-flow');
  assert.equal(pic.getAttribute('aria-label'), 'Your messages and game data go from your Mac straight to Anthropic. Nothing goes to NeverQuestAlone.');
  assert.equal(pic.querySelector('.sheet-row-quiet'), null, 'not inside the picture, whose alt a screen reader reads instead (APP-W-18)');
  assert.equal(pic.nextSibling.textContent, 'In each message: your question, level, zone, quests and gear.', 'one line after the picture, not five pills (APP-D-08)');
  const secs = sheet.querySelectorAll('.sheet-sec').filter(x => !x.classList.contains('sheet-fine'));
  assert.ok(secs.length >= 4 && secs.every(x => x.childNodes.filter(c => c.classList && c.classList.contains('sheet-card')).length === 1), 'each section one card');
  assert.equal(fk(r, 'terms-anthropic').className, 'sheet-row sheet-link', 'the terms: the last row of At Anthropic');
  assert.doesNotMatch(t, /go straight to Anthropic\. No account/, 'the picture says it; no sentence repeats it (CL-words-23)');
  assert.match(t, /Deletes messages within 30 days by default; no training without your feedback\./);
  assert.match(t, /Unofficial\. Not made or reviewed by Blizzard\. It never plays for you\./);
  assert.ok(t.split(/\s+/).length < 110, `about 60 words and the picture's labels: ${t.split(/\s+/).length}`);
  await r.click('Open Anthropic’s terms');
  assert.ok(r.opened.some(u => /anthropic\.com|claude\.com/.test(u)));
  scan(r, 'the sheet');
  r.document.dispatchEvent(r.event('keydown', { key: 'Escape' }));
  await r.settle(10);
  assert.equal(r.document.querySelector('#sheet-host .sheet'), null);
  assert.equal(active(r).getAttribute('data-fk'), 'details', 'focus back on Show details');
  assert.equal(r.document.getElementById('main-body').hasAttribute('inert'), false);
  // Scoped: Grok's has its note on refused requests; Gemini's the 18+ line; ChatGPT's credit first.
  for (const [id, want] of [['xai', /xAI charges \$0\.05 for each request it refuses/], ['google', /18 or older/], ['openai', /Add \$5 of credit at OpenAI first/]]) {
    const s = await pageRig({ onboarded: false });
    await pick(s, id);
    await s.press(fk(s, 'details'));
    assert.match(s.sheetText(), want, id);
  }
  // The scrim and × close it too; Windows says Credential Manager, and a work PC's roaming line.
  const w = await pageRig({ onboarded: false, platform: 'win32', info: { workPc: true } });
  await w.press(fk(w, 'details'));
  assert.match(w.sheetText(), /from your PC straight to Anthropic|Your PC/);
  assert.match(w.sheetText(), /In Windows Credential Manager\./);
  assert.match(w.sheetText(), /On a work PC, your key may follow your Windows account/);
  await w.press(w.document.querySelector('.scrim'));
  assert.equal(w.document.querySelector('#sheet-host .sheet'), null);
  await w.press(fk(w, 'details'));
  await w.press(fk(w, 'sheet-close'));
  assert.equal(w.document.querySelector('#sheet-host .sheet'), null);
});

test('step 2 Paste: the key read in main, the dialog, then ✓ connected, said once, and straight on to step 3 with the old defaults applied silently; Back shows step 2 connected, with Continue', async () => {
  const r = await pageRig({ onboarded: false });
  await paste(r, ANT);
  assert.equal(r.confirms.length, 1, 'main read it and asked');
  wentOn(r, 'Claude is connected.');
  // "Check your defaults" is gone: its defaults apply at once, as they were (start at login on,
  // notifications on), each changeable later in the window.
  assert.deepEqual(r.loginSets, [true], 'start at login on, in one call (finishDefaults)');
  assert.equal(r.appState().notifications, true);
  assert.equal(r.appState().defaultsSeen, true);
  assert.equal(r.appState().setup.screen, 'wow');
  assert.equal(fk(r, 'back').parentNode.className, 'say-head', '‹ Back heads step 3’s title row (its say-head), on the column’s edge (the owner, 2026-10-02)');
  assert.equal(fk(r, 'back').parentNode.lastChild, fk(r, 'details'), 'and Show details still ends it');
  assert.equal(fk(r, 'back').parentNode.firstChild, fk(r, 'back'));
  assert.equal(label(fk(r, 'back')), 'Back', 'its name is still Back, said by a screen reader and shown on hover');
  assert.equal(fk(r, 'back').getAttribute('title'), 'Back');
  await r.press(fk(r, 'back'));
  assert.equal(titleText(r), 'Connect your AI');
  assert.equal(fk(r, 'card-anthropic').getAttribute('aria-checked'), 'true');
  assert.equal(fk(r, 'card-anthropic').querySelector('.chip').textContent, 'Key saved', 'back on step 2, the key is saved');
  assert.deepEqual(primaries(r).map(label), ['Use saved key']);
});

test('Paste detects: a key from another AI picks its row and connects it (no “Use ChatGPT instead” step); an OpenRouter key opens Other’s form with its address and the key', async () => {
  const r = await pageRig({ onboarded: false });
  assert.equal(picked(r), 'card-anthropic');
  await paste(r, OAI);
  assert.equal(r.confirms[0].message, 'Connect ChatGPT with this key?');
  wentOn(r, 'ChatGPT is connected.');
  await r.press(fk(r, 'back'));
  assert.equal(picked(r), 'card-openai', 'the row the key belongs to');
  const g = await pageRig({ onboarded: false });
  await pick(g, 'openai');
  await paste(g, `AIza${'C'.repeat(35)}`);
  wentOn(g, 'Gemini is connected.');
  await g.press(fk(g, 'back'));
  assert.equal(picked(g), 'card-google');
  const o = await pageRig({ onboarded: false });
  await paste(o, `sk-or-v1-CANARY${'x'.repeat(56)}`);
  assert.equal(o.confirms.length, 0, 'no dialog for a key no row takes');
  assert.equal(titleText(o), 'Connect another AI');
  assert.equal(o.document.getElementById('custom-url').value, 'https://openrouter.ai/api/v1');
  assert.equal(o.document.getElementById('custom-key').value, '', 'the page never holds the key');
  assert.equal(o.document.getElementById('custom-key').getAttribute('placeholder'), 'Pasted: sk-or-…xxxx');
  assert.equal(o.document.getElementById('custom-model').getAttribute('placeholder'), 'meta-llama/llama-3.3-70b-instruct');
  const m = o.document.getElementById('custom-model');
  m.value = 'openai/gpt-5-mini'; m.dispatchEvent(o.event('input'));
  await o.press(fk(o, 'custom-go'));
  const call = o.calls.filter(c => c[0] === 'connectCustom').at(-1);
  assert.equal(call[1].key, `sk-or-v1-CANARY${'x'.repeat(56)}`, 'main connects with the key it staged at the paste');
  wentOn(o, 'Connected to openrouter.ai.');
  assert.ok(!o.page().textContent.includes('CANARY') && !JSON.stringify(o.confirms).includes('CANARY'), 'the key never shows');
  const hid = await pageRig({ onboarded: false, state: { hidden: ['xai'] } });
  await paste(hid, `xai-CANARY${'x'.repeat(40)}`);
  assert.match(hid.pageText(), /Grok isn’t available right now\. Pick another\./);
});

test('⌘V anywhere on step 2 is Paste, never reading the event’s clipboard; not while the sheet is open or Other is picked', async () => {
  const r = await pageRig({ onboarded: false });
  r.setClipboard(ANT);
  let read = 0;
  const ev = r.event('paste', { clipboardData: { getData: () => { read += 1; return 'not this'; } } });
  r.document.getElementById('page').dispatchEvent(ev);
  await r.settle(30);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(read, 0, 'the page never reads the clipboard');
  assert.equal(r.confirms.length, 1, 'main read it and asked');
  wentOn(r, 'Claude is connected.');
  const s = await pageRig({ onboarded: false });
  await s.press(fk(s, 'details'));
  const ev2 = s.event('paste', { clipboardData: { getData: () => '' } });
  s.document.getElementById('page').dispatchEvent(ev2);
  await s.settle(20);
  assert.equal(s.confirms.length, 0, 'the sheet is open: nothing');
  const c = await pageRig({ onboarded: false });
  await pick(c, 'custom');
  c.document.getElementById('page').dispatchEvent(c.event('paste', { clipboardData: { getData: () => '' } }));
  await c.settle(20);
  assert.equal(c.calls.filter(x => x[0] === 'pasteKey').length, 0, 'Other takes its key in its form');
});

// Every §6.1 result: one line, the primary relabelled rather than added, at most one extra button.
const localDate = ms => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ms));
void localDate;
const ROWS = [
  ['clipboard_empty', { text: '' }, 'Your clipboard is empty. Copy your key first.', 'Paste Anthropic key', ['Open Anthropic’s key page']],
  ['not_a_key', { text: 'hello there' }, 'Anthropic keys start with sk-ant-. Copy the whole key.', 'Paste Anthropic key', ['Open Anthropic’s key page']],
  ['subscription_token', { text: `sk-ant-oat01-CANARY${'x'.repeat(60)}` }, 'That’s a Claude sign-in token, not an API key.', 'Paste Anthropic key', ['Open Anthropic’s key page']],
  ['admin_key', { text: `sk-ant-admin01-CANARY${'x'.repeat(60)}` }, 'That key is for account admins.', 'Paste new key', ['Open Anthropic’s key page']],
  ['cancelled', { confirm: false }, 'Not connected. Click Paste Anthropic key to try again.', 'Paste Anthropic key', ['Open Anthropic’s key page']],
  ['terms_required', { forced: { error: 'terms_required' } }, 'Agree to Anthropic’s terms again.', 'Connect', ['Open Anthropic’s key page']],
  ['auth_invalid', { text: BAD }, 'Anthropic didn’t accept that key.', 'Paste new key', ['Open Anthropic’s key page']],
  ['spend_limit', { forced: { error: 'spend_limit' } }, 'This key hit its spend limit.', 'Open Anthropic’s limits page', ['Test again']],
  ['spend_limit tier', { forced: { error: 'spend_limit', tier: true, resetAt: Date.UTC(2026, 9, 1) } }, 'Anthropic’s monthly limit is reached.', 'Open Anthropic’s limits page', ['Test again']],
  ['workspace_required', { forced: { error: 'workspace_required' } }, 'Make a new key on Anthropic’s key page.', 'Paste new key', ['Open Anthropic’s key page']],
  ['model_access', { forced: { error: 'model_access', model: 'Claude Haiku 4.5' } }, 'This key can’t use that model.', 'Paste new key', ['Open Anthropic’s key page']],
  ['key_restricted', { forced: { error: 'key_restricted' } }, 'This key can’t send messages.', 'Paste new key', ['Open Anthropic’s key page']],
  ['org_verification', { forced: { error: 'org_verification', model: 'Claude Haiku 4.5' } }, 'Anthropic needs to verify your account first.', 'Open Anthropic’s settings page', ['Test again']],
  // CL-words-56: a region the AI doesn't serve has no Paste and no key page; the rows are the next step.
  ['region_blocked', { forced: { error: 'region_blocked' } }, 'Anthropic isn’t available where you are. Pick another AI.', null, []],
  ['rate_limited', { forced: { error: 'rate_limited' } }, 'Anthropic is limiting this key. Test again in a minute.', 'Test again', ['Open Anthropic’s key page']],
  ['overloaded', { forced: { error: 'overloaded' } }, 'Anthropic is busy. Test again soon.', 'Test again', ['Open Anthropic’s key page']],
  ['network', { forced: { error: 'network' } }, 'Can’t reach Anthropic. Check your internet, then click Test again.', 'Test again', ['Open Anthropic’s key page']],
  // fix-102: the app's own guard refused Anthropic's own address; never "check your internet".
  ['restart', { forced: { error: 'restart', kind: 'egress_blocked' } }, 'NeverQuestAlone needs a restart before it can reach Anthropic.', 'Quit and reopen', ['Open Anthropic’s key page']],
  ['keystore_error', { connect: { ok: false, error: 'keystore_error' } }, 'The key works but wasn’t saved.', 'Save again', ['Open Anthropic’s key page']],
  ['stage_expired', { forced: { error: 'stage_expired' } }, 'The pasted key expired.', 'Paste new key', ['Open Anthropic’s key page']],
  ['busy', { forced: { error: 'busy' } }, 'Finish the open dialog first.', 'Paste Anthropic key', ['Open Anthropic’s key page']],
  ['failed', { forced: { error: 'failed' } }, 'Something went wrong with Anthropic.', 'Test again', ['Open Anthropic’s key page']],
  ['out_of_credit (first key, documented: saved, T1)', { text: NOCREDIT }, 'Key saved. Your account has no credit.', 'Add credit at Anthropic', ['Test again', 'Continue anyway']], // the fix first (CL-words-22)
];
for (const [name, how, want, primaryLabel, others] of ROWS) {
  test(`step 2 key result: ${name}`, async () => {
    const state = {};
    if (how.forced) state.results = { testStagedKey: { ok: false, documented: false, inferred: false, tier: false, ...how.forced } };
    if (how.connect) state.results = { connect: how.connect };
    const r = await pageRig({ onboarded: false, state, confirm: how.confirm ?? true });
    await paste(r, how.text ?? ANT);
    assert.ok(result(r), `${name}: a line`);
    assert.equal(result(r).textContent, want);
    assert.equal(r.document.querySelectorAll('#result-slot .result').length, 1, 'one line');
    assert.deepEqual(primaries(r).map(label), primaryLabel ? [primaryLabel] : [], `${name}: the one primary`);
    // No key yet? is a help link (its numbered steps behind it), not an action (onboarding review ON-01, ON-15).
    const actions = r.document.querySelector('.actions').querySelectorAll('button').filter(b => !/\bbtn-primary\b/.test(b.className) && !['details', 'no-key'].includes(b.getAttribute('data-fk'))).map(label);
    assert.deepEqual(actions, others, `${name}: at most one extra button (and a way on)`);
    assert.ok(r.liveText().some(t => t.startsWith(want)), `${name}: said in the live region`);
    assert.ok(r.document.querySelectorAll('#page, #topbar, #banners').every(el => !el.textContent.includes('CANARY')), 'never a key on the page');
    scan(r, name);
  });
}

test('the no-credit result: Test again tests the saved key and says the retest’s own kind; Continue anyway goes to step 3; the returning no-credit row does the same', async () => {
  const KINDS = [
    [{ ok: false, error: 'out_of_credit', headline: 'x', detail: 'y' }, 'Still no credit at Anthropic.', 'Add credit at Anthropic'],
    [{ ok: false, error: 'overloaded', headline: 'x', detail: 'y' }, 'Anthropic is busy. Test again soon.', 'Test again'],
    [{ ok: false, error: 'network_before_send', headline: 'x', detail: 'y' }, 'Can’t reach Anthropic. Check your internet, then click Test again.', 'Test again'],
    // fix-102: the app's own guard refused the company's address: a restart, never the internet.
    [{ ok: false, error: 'egress_blocked', action: 'restart', headline: 'x', detail: 'y' }, 'NeverQuestAlone needs a restart before it can reach Anthropic.', 'Quit and reopen'],
    [{ ok: false, error: 'rate_limited', headline: 'x', detail: 'y' }, 'Anthropic is limiting this key. Test again in a minute.', 'Test again'],
    [{ ok: false, error: 'auth_invalid', headline: 'x', detail: 'y' }, 'Anthropic didn’t accept that key.', 'Paste new key'],
    [{ ok: false, error: 'no_key', action: 'keys', headline: 'x', detail: 'y' }, 'Your saved key couldn’t be read.', 'Paste new key'],
  ];
  for (const [forced, want, primary] of KINDS) {
    const r = await pageRig({ onboarded: false });
    await paste(r, NOCREDIT);
    assert.equal(result(r).textContent, 'Key saved. Your account has no credit.');
    r.mock.control.patch({ results: { testKey: forced } });
    await r.press(fk(r, 'test-again'));
    assert.equal(result(r).textContent, want, forced.error);
    assert.deepEqual(primaries(r).map(label), [primary], forced.error);
  }
  const c = await pageRig({ onboarded: false });
  await paste(c, NOCREDIT);
  await c.press(fk(c, 'carry-on'));
  assert.equal(titleText(c), 'Set up WoW');
  assert.equal(c.appState().defaultsSeen, true);
  const back = await pageRig({ onboarded: false, state: { keys: SAVED, terms: { anthropic: 1 }, keyState: { anthropic: 'no_credit' } } });
  assert.equal(fk(back, 'card-anthropic').querySelector('.chip').textContent, 'No credit');
  assert.deepEqual(primaries(back).map(label), ['Add credit at Anthropic'], 'the fix first (CL-words-22)');
  assert.equal(back.document.querySelector('.pick-head .lead').textContent, 'Claude needs an API key and credit at Anthropic.', 'no credit: the lead names the same need as the chip');
  assert.ok(fk(back, 'test-again'), 'Test again, quiet');
  back.mock.control.patch({ results: { testKey: { ok: false, error: 'overloaded', headline: 'x', detail: 'y' } } });
  await back.press(fk(back, 'test-again'));
  assert.equal(result(back).textContent, 'Anthropic is busy. Test again soon.');
});

test('returning: Use saved key (no dialog with the terms recorded), Paste new key second; the read failing says so', async () => {
  const r = await pageRig({ onboarded: false, state: { keys: SAVED, terms: { anthropic: 1 } } });
  assert.equal(fk(r, 'card-anthropic').querySelector('.chip').textContent, 'Key saved');
  assert.deepEqual(primaries(r).map(label), ['Use saved key']);
  assert.ok(fk(r, 'paste-key'), 'Paste new key');
  assert.equal(label(fk(r, 'paste-key')), 'Paste new key');
  await r.click('Use saved key');
  assert.equal(r.confirms.length, 0);
  wentOn(r, 'Claude is connected.');
  const f = await pageRig({ onboarded: false, state: { keys: SAVED, terms: { anthropic: 1 }, results: { useSavedKey: { ok: false, error: 'read_failed' } } } });
  await f.click('Use saved key');
  assert.equal(result(f).textContent, 'Your saved key couldn’t be read.');
  assert.deepEqual(primaries(f).map(label), ['Paste new key']);
});

test('Paste says what it’s doing only after Agree (DU-03): its label behind the dialog, then “Checking with Anthropic…” on the button and once in the live region', async () => {
  let answer;
  const r = await pageRig({ onboarded: false, confirm: () => new Promise(res => { answer = res; }) });
  const release = r.mock.control.hold('testStagedKey');
  r.setClipboard(ANT);
  const b = fk(r, 'paste-key');
  b.focus();
  b.click();
  await r.settle(20);
  assert.equal(r.confirms.length, 1, 'the dialog is up');
  assert.equal(label(fk(r, 'paste-key')), 'Paste Anthropic key', 'its own label behind the dialog');
  assert.equal(fk(r, 'paste-key').getAttribute('aria-disabled'), 'true');
  assert.ok(!r.liveText().some(t => /Checking/.test(t)), 'nothing said before Agree');
  answer(true);
  await r.settle(20);
  assert.equal(label(fk(r, 'paste-key')), 'Checking with Anthropic…');
  assert.equal(fk(r, 'paste-key').getAttribute('aria-busy'), 'true');
  assert.equal(fk(r, 'paste-key').querySelector('kbd'), null, 'the spinner, not the key hint, while it checks');
  assert.equal(r.liveText().filter(t => t === 'Checking with Anthropic…').length, 1, 'said once, after Agree');
  release();
  await r.settle(30);
  wentOn(r, 'Claude is connected.');
  // A Google key says Google once agreed, never a bare "Checking…".
  const g = await pageRig({ onboarded: false });
  const hold = g.mock.control.hold('testStagedKey');
  g.setClipboard(`AIza${'C'.repeat(35)}`);
  await g.press(fk(g, 'paste-key'));
  await g.settle(20);
  assert.equal(label(fk(g, 'paste-key')), 'Checking with Google…');
  hold();
  await g.settle(30);
});

test('Test again on a held key needs no paste and no dialog (retryConnect)', async () => {
  const r = await pageRig({ onboarded: false, state: { results: { testStagedKey: { ok: false, error: 'overloaded' } } } });
  await paste(r, ANT);
  assert.equal(r.confirms.length, 1);
  r.mock.control.patch({ results: {} });
  await r.press(fk(r, 'test-again'));
  assert.equal(r.confirms.length, 1, 'no second dialog');
  assert.equal(r.calls.filter(c => c[0] === 'testStagedKey').length, 2, 'the held key tested again');
  wentOn(r, 'Claude is connected.');
  // main refuses a retry of a key never agreed to: Paste the key again.
  const n = await pageRig({ onboarded: false, state: { results: { testStagedKey: { ok: false, error: 'overloaded' } } } });
  await paste(n, ANT);
  n.window.nqa.retryConnect = async () => ({ ok: false, error: 'needs_confirm', provider: 'anthropic' });
  await n.press(fk(n, 'test-again'));
  assert.equal(result(n).textContent, 'Paste the key again.');
  assert.deepEqual(primaries(n).map(label), ['Paste new key']);
});

test('step 2’s banners: Move to Applications above the title (Mac), and the one state setup can’t fix (couldn’t start)', async () => {
  const move = await pageRig({ onboarded: false, info: { inApplications: false } });
  assert.match(move.pageText(), /Move to Applications\./);
  await move.click('Move');
  assert.match(move.pageText(), /Couldn’t move it\./);
  const err = await pageRig({ onboarded: false, apiMode: 'error' });
  assert.match(err.bannerText(), /NeverQuestAlone couldn’t start\./);
  assert.ok(err.byText('Quit and reopen').length);
  assert.equal(err.document.getElementById('portrait').getAttribute('data-mood'), 'away');
});

// ---------------------------------------------------------------------------
// 6.1.2 Other.

test('Other: one small form (Base URL, API key optional, Model), Connect the one primary; checked before anything is sent; one dialog naming the address; ✓ Connected, Continue', async () => {
  const r = await pageRig({ onboarded: false });
  await pick(r, 'custom');
  await r.press(fk(r, 'set-up-other'));
  assert.equal(titleText(r), 'Connect another AI');
  assert.match(r.pageText(), /Any OpenAI-compatible service works\./);
  assert.deepEqual(r.document.querySelectorAll('.custom-form label').map(l => l.textContent), ['Base URL', 'API key', 'Model']);
  assert.equal(r.document.getElementById('custom-key').getAttribute('placeholder'), 'Optional for a local server');
  assert.equal(r.document.getElementById('custom-key').getAttribute('type'), 'password');
  assert.deepEqual(primaries(r).map(label), ['Connect']);
  assert.equal(r.appState().setup.path, 'custom', 'a reopen comes back here');
  assert.ok(fk(r, 'back'), '‹ Back to step 2');
  scan(r, 'Other');
  const fill = async (url, model, key = '') => {
    for (const [id, v] of [['custom-url', url], ['custom-model', model]]) { const f = r.document.getElementById(id); f.value = v; f.dispatchEvent(r.event('input')); }
    if (key) r.document.getElementById('custom-key').value = key;
    await r.press(fk(r, 'custom-go'));
  };
  await fill('', 'm');
  assert.equal(result(r).textContent, 'That isn’t a web address.');
  assert.equal(active(r).id, 'custom-url');
  await fill('https://openrouter.ai/api/v1', '');
  assert.equal(result(r).textContent, 'Type the model’s exact name.');
  assert.equal(r.calls.filter(c => c[0] === 'connectCustom').length, 0);
  await fill('http://8.8.8.8:11434/v1', 'qwen3:8b'); // a public address over http (a home one is fine since 2026-10-05)
  assert.equal(result(r).textContent, 'Use https, or an address on your home network.');
  assert.equal(r.confirms.length, 0);
  await fill('https://openrouter.ai/api/v1/', 'openai/gpt-5-mini', `sk-or-v1-CANARY${'x'.repeat(56)}`);
  assert.equal(r.confirms.length, 1);
  assert.equal(r.confirms[0].message, 'Connect NeverQuestAlone to openrouter.ai?');
  wentOn(r, 'Connected to openrouter.ai.');
  assert.equal(r.appState().defaultsSeen, true);
  // Step 2 again: Other's row names the service and says Connected; Continue is the primary.
  await r.press(fk(r, 'back'));
  assert.equal(titleText(r), 'Connect your AI');
  assert.equal(fk(r, 'card-custom').querySelector('.choice-cost').textContent, 'openrouter.ai');
  assert.equal(fk(r, 'card-custom').querySelector('.chip').textContent, 'Connected');
  // A server on this computer: its own words.
  let l = await pageRig({ onboarded: false });
  await pick(l, 'custom');
  await l.press(fk(l, 'set-up-other'));
  for (const [id, v] of [['custom-url', 'http://localhost:11434/v1'], ['custom-model', 'qwen3:8b']]) { const f = l.document.getElementById(id); f.value = v; f.dispatchEvent(l.event('input')); }
  await l.press(fk(l, 'custom-go'));
  assert.match(l.confirms[0].detail, /Your messages stay on this Mac\./);
  wentOn(l, 'localhost:11434 is running with qwen3:8b.');
  // The hint follows the address: Groq's ids at Groq, an Ollama tag at Ollama's port (a fresh form:
  // the one above went on to step 3).
  l = await pageRig({ onboarded: false });
  await pick(l, 'custom');
  await l.press(fk(l, 'set-up-other'));
  const u = l.document.getElementById('custom-url');
  for (const [addr, want] of [['https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'], ['http://localhost:11434/v1', 'llama3.2'], ['https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct']]) {
    u.value = addr; u.dispatchEvent(l.event('input'));
    assert.equal(l.document.getElementById('custom-model').getAttribute('placeholder'), want, addr);
  }
  // Show details: what works with it, the key, what leaves.
  await l.press(fk(l, 'details'));
  assert.equal(l.document.getElementById('sheet-title').textContent, 'Other, in detail');
  assert.match(l.sheetText(), /OpenRouter, Groq, Together, Ollama, LM Studio/);
});

test('Other: a paste into API key is read in main, never the page; the field shows only its mask, and Connect saves it and takes it off the clipboard (code health AP-05)', async () => {
  const KEY = `exk_CANARY${'x'.repeat(40)}`;
  const r = await pageRig({ onboarded: false });
  await pick(r, 'custom');
  await r.press(fk(r, 'set-up-other'));
  for (const [id, v] of [['custom-url', 'https://api.example.com/v1'], ['custom-model', 'm']]) { const f = r.document.getElementById(id); f.value = v; f.dispatchEvent(r.event('input')); }
  r.setClipboard(`${KEY}\n`);
  let read = 0;
  const ev = r.event('paste', { clipboardData: { getData: () => { read += 1; return 'not this'; } } });
  r.document.getElementById('custom-key').dispatchEvent(ev);
  await r.settle(30);
  assert.equal(ev.defaultPrevented, true, 'nothing lands in the field');
  assert.equal(read, 0, 'the page never reads the clipboard');
  assert.equal(r.confirms.length, 0, 'no dialog at the paste: Connect asks');
  assert.equal(r.document.getElementById('custom-key').value, '', 'the page never holds the key');
  assert.equal(r.document.getElementById('custom-key').getAttribute('placeholder'), 'Pasted: …xxxx');
  assert.equal(active(r).id, 'custom-key');
  await r.press(fk(r, 'custom-go'));
  assert.equal(r.confirms.length, 1);
  assert.equal(r.calls.filter(c => c[0] === 'connectCustom').at(-1)[1].key, KEY, 'main connects with the key it read at the paste');
  wentOn(r, 'Connected to api.example.com.');
  assert.equal(r.clip.text, '', 'off the clipboard once saved');
  assert.ok(!r.page().textContent.includes('CANARY') && !JSON.stringify(r.confirms).includes('CANARY'), 'the key never shows');
  // Not a key (spaces in it): the form's own line, and nothing staged; an empty clipboard does nothing.
  const n = await pageRig({ onboarded: false });
  await pick(n, 'custom');
  await n.press(fk(n, 'set-up-other'));
  n.setClipboard('two words');
  n.document.getElementById('custom-key').dispatchEvent(n.event('paste', { clipboardData: { getData: () => '' } }));
  await n.settle(30);
  assert.equal(result(n).textContent, 'That doesn’t look like a key.');
  assert.equal(n.ctx.keys.size, 0);
  n.setClipboard('');
  n.document.getElementById('custom-key').dispatchEvent(n.event('paste', { clipboardData: { getData: () => '' } }));
  await n.settle(30);
  assert.equal(n.document.getElementById('custom-key').getAttribute('placeholder'), 'Optional for a local server');
  scan(n, 'Other paste');
});

test('Other’s failures in the table’s words: a rejected key, an unreachable service, a model it doesn’t offer, Cancel', async () => {
  const at = async (url, model, key = '', o = {}) => {
    const r = await pageRig({ onboarded: false, ...o });
    await pick(r, 'custom');
    await r.press(fk(r, 'set-up-other'));
    for (const [id, v] of [['custom-url', url], ['custom-model', model]]) { const f = r.document.getElementById(id); f.value = v; f.dispatchEvent(r.event('input')); }
    if (key) r.document.getElementById('custom-key').value = key;
    await r.press(fk(r, 'custom-go'));
    return r;
  };
  assert.equal(result(await at('https://openrouter.ai/api/v1', 'm', `sk-or-v1-CANARY${'x'.repeat(56)}BADKEY`)).textContent, 'openrouter.ai didn’t accept that key.');
  assert.equal(result(await at('https://down.example.com/v1', 'm')).textContent, 'Can’t reach down.example.com.');
  assert.equal(result(await at('https://openrouter.ai/api/v1', 'missing')).textContent, 'openrouter.ai doesn’t offer that model.');
  // fix-102: the app's own guard refused the service's address: a restart, and Quit and reopen takes Connect's place.
  const rs = await at('https://openrouter.ai/api/v1', 'm', '', { state: { results: { connectCustom: { ok: false, error: 'restart', kind: 'egress_blocked', documented: false, inferred: false, tier: false, model: 'm' } } } });
  assert.equal(result(rs).textContent, 'NeverQuestAlone needs a restart before it can reach openrouter.ai.');
  assert.deepEqual(primaries(rs).map(label), ['Quit and reopen']);
  await rs.press(primaries(rs)[0]);
  assert.ok(rs.calls.some(c => c[0] === 'relaunch'), 'main was asked to quit and reopen');
  const no = await at('https://openrouter.ai/api/v1', 'm', '', { confirm: false });
  assert.equal(result(no).textContent, 'Nothing was sent or saved.');
  assert.equal(no.calls.filter(c => c[0] === 'connectCustom').length, 0, 'declined: the API is never called');
  scan(no, 'Other failure');
});

// ---------------------------------------------------------------------------
// Step 3: Say hi in game.

test('step 3: three objectives (two on Windows); only the current one has a line and an action; the primary is its next step; a push ticks one off in place and never changes the screen', async () => {
  const r = await atWow();
  assert.equal(titleText(r), 'Set up WoW');
  const rows = r.document.querySelectorAll('.obj');
  assert.deepEqual(rows.map(o => o.querySelector('.obj-title span').textContent), ['Install the addon', 'Allow Screen Recording', 'Turn on the addon']);
  assert.deepEqual(rows.map(o => /obj-(\w+)/.exec(o.className)[1]), ['now', 'next', 'next']);
  assert.equal(rows[0].getAttribute('aria-current'), 'step');
  assert.equal(rows[1].querySelector('.obj-meta'), null, 'the next rows are their titles alone');
  assert.match(rows[0].textContent, /Found World of Warcraft: Forever\./);
  assert.deepEqual(primaries(r).map(label), ['Install']);
  await r.press(primaries(r)[0]);
  const after = r.document.querySelectorAll('.obj');
  assert.match(after[0].className, /\bobj-done\b/);
  assert.equal(after[0].querySelector('.sr-only').textContent, 'Install the addon, done');
  assert.deepEqual(primaries(r).map(label), ['Allow']);
  assert.match(after[1].textContent, /Reads only the top of WoW’s window, so your messages go at once\. Never keeps or sends pictures\./, 'what it reads, and that no picture is kept or sent (player-31, CL-player-48; never “sends nothing”, CL-words-63)');
  await r.press(primaries(r)[0]);
  assert.match(r.pageText(), /Click Open System Settings, then turn on NeverQuestAlone\./);
  assert.deepEqual(primaries(r).map(label), ['Open System Settings']);
  for (const patch of [{ permission: 'granted' }, { game: { running: true } }]) {
    r.mock.control.patchSetup(patch);
    await r.push();
    assert.equal(titleText(r), 'Set up WoW', 'a push ticks a row off in place');
  }
  assert.match(r.pageText(), /Waiting for the addon…/);
  // The one push that moves the screen: the addon's hello finishes setup (the owner, 2026-10-05).
  r.mock.control.patchSetup({ game: { running: true, hello: { at: 1, sig: 'ok', mode: 'pixel' } } });
  await r.push();
  assert.equal(titleText(r), 'You’re set');
  // The app trim: the list stands alone. No picture of his window beside it, no frames, no timer.
  assert.equal(r.document.querySelector('#page .ingame'), null, 'no in-game picture');
  assert.equal(r.document.querySelector('#page img'), null, 'no image on step 3');
  const css = fs.readFileSync(path.join(APP, 'renderer', 'style.css'), 'utf8');
  assert.doesNotMatch(css, /@keyframes ingame|\.ingame-frame \{ animation/, 'one still: no timer');
  for (const s of ['1x', '2x']) assert.ok(!fs.existsSync(path.join(APP, 'renderer', 'img', `ingame-reply@${s}.webp`)), `${s}: the still is gone`);
});

test('step 3 row 1: WoW open (Install when WoW closes), armed (Cancel, row 2 current), several copies (the folder and Install on one line), not found, a bad folder, the race, an update', async () => {
  const open = await atWow({ wow: { found: true, running: true } });
  assert.match(open.pageText(), /WoW is open\./);
  assert.deepEqual(primaries(open).map(label), ['Install when WoW closes']);
  await open.press(primaries(open)[0]);
  assert.ok(open.calls.some(c => c[0] === 'armInstall'), 'armed: it installs when WoW closes');
  assert.match(open.pageText(), /Installs when you quit WoW\./);
  assert.ok(open.byText('Cancel').length);
  assert.deepEqual(primaries(open).map(label), ['Allow'], 'row 2 becomes current');
  const two = await atWow({ wow: { found: true, installs: [{ path: '/Applications/World of Warcraft/_forever_', version: '1.60.1.70009' }, { path: '/Volumes/Games/World of Warcraft/_forever_', version: '1.60.1.70009' }] } });
  assert.match(two.pageText(), /2 copies of WoW: Forever found\./);
  const acts = two.document.getElementById('wow-install').parentNode;
  assert.match(acts.className, /\bobj-actions\b/);
  assert.deepEqual(acts.children.map(e => e.tagName), ['LABEL', 'SELECT', 'BUTTON']);
  const nf = await atWow({ wow: { found: false, running: false } });
  assert.match(nf.pageText(), /Couldn’t find World of Warcraft: Forever\./);
  assert.deepEqual(primaries(nf).map(label), ['Choose WoW folder…']);
  assert.ok(nf.byText('Check again').length);
  assert.match(nf.document.querySelector('[data-row="row-install"]').className, /\bobj-error\b/);
  const bad = await atWow({ addonState: 'bad_folder' });
  assert.match(bad.pageText(), /That folder isn’t WoW: Forever\./);
  const race = await atWow({ addonState: 'race' });
  assert.match(race.pageText(), /WoW started mid-install\. It didn’t load\./);
  assert.deepEqual(primaries(race).map(label), ['Install again']);
  const older = await atWow({ addonState: 'older' });
  assert.match(older.pageText(), /The addon needs an update\./);
  assert.deepEqual(primaries(older).map(label), ['Update']);
});

test('step 3 row 1’s failures: an update says update; no free space; the install failed (Copy diagnostics); can’t write to AddOns (what to ask for is in Show details, with the command to copy)', async () => {
  const failed = await atWow({ addonState: 'failed' });
  assert.match(failed.pageText(), /The addon didn’t install\./);
  assert.deepEqual(failed.document.querySelectorAll('[data-row="row-install"] .obj-actions button').map(label), ['Install again', 'Copy diagnostics']);
  await failed.click('Copy diagnostics');
  assert.match(failed.pageText(), /Diagnostics copied\./);
  const upd = await atWow({ addonState: 'failed', setup: { addon: { update: true } } });
  assert.match(upd.pageText(), /The addon didn’t update\./);
  assert.ok(upd.byText('Update again').length);
  const full = await atWow({ addonState: 'disk_full' });
  assert.match(full.pageText(), /No free space for the addon\./);
  const eperm = await atWow({ addonState: 'eperm' });
  assert.match(eperm.pageText(), /NeverQuestAlone can’t write to AddOns\./);
  assert.deepEqual(primaries(eperm).map(label), ['Choose another folder…']);
  await eperm.press(fk(eperm, 'details'));
  assert.match(eperm.sheetText(), /Ask an administrator to give your account permission to change WoW’s AddOns folder\./);
  // (addonInstalled: the mock answers addonPermissions only once an addon folder exists.)
  const cmd = await atWow({ addonState: 'eperm', addonInstalled: true, permissions: { ok: false, fixable: false, paths: ['C:\\WoW\\_forever_\\Interface\\AddOns'], detail: 'Every account on this PC can change the AddOns folder.' }, setup: { addon: { admin: { command: 'icacls "C:\\WoW" /grant x', explanation: 'Gives your account its own change permission there.' } } } }, { platform: 'win32' });
  await cmd.press(fk(cmd, 'details'));
  assert.match(cmd.sheetText(), /Gives your account its own change permission there\./);
  await cmd.press(fk(cmd, 'copy-command'));
  assert.match(cmd.clip.text, /^icacls "C:\\WoW\\_forever_\\Interface\\AddOns" /, 'the bridge’s own command, copied');
  assert.match(cmd.pageText(), /Copied\. An administrator can paste it into Command Prompt, opened with Run as administrator\./);
  const others = await atWow({ addonInstalled: true, setup: { addon: { othersCanWrite: true } } });
  assert.match(others.pageText(), /Other accounts can change WoW’s addons\./);
  await others.click('Open Diagnostics');
  assert.equal(titleText(others), 'Diagnostics');
  assert.ok(fk(others, 'back-to-setup'), '‹ Back to setup');
  await others.press(fk(others, 'back-to-setup'));
  assert.equal(titleText(others), 'Set up WoW');
  assert.equal(active(others).getAttribute('data-fk'), 'open-diagnostics', 'focus on the control the player left from');
});

test('step 3 row 2: asked, denied (the pane’s path in Show details, macOS 14 and 15+), Skip screen reading? turns it off in one click (the app’s switch); Screen Reading off counts as done', async () => {
  const asked = await atWow({ addonInstalled: true, permission: 'asked' });
  assert.match(asked.pageText(), /Click Open System Settings, then turn on NeverQuestAlone\./);
  const den = await atWow({ addonInstalled: true, permission: 'denied' });
  assert.match(den.pageText(), /Screen Recording is off\./);
  await den.press(fk(den, 'details'));
  assert.match(den.sheetText(), /Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording\./);
  const den14 = await atWow({ addonInstalled: true, permission: 'denied' }, { info: { osRelease: '23.6.0' } });
  await den14.press(fk(den14, 'details'));
  assert.match(den14.sheetText(), /Privacy & Security > Screen Recording\./);
  // The app trim: the first ask (Allow) carries no Skip link; it comes once Allow was pressed and the box is up.
  const first = await atWow({ addonInstalled: true });
  assert.equal(fk(first, 'no-reading'), null, 'one button on the first ask');
  assert.deepEqual(primaries(first).map(label), ['Allow']);
  const waiting = await atWow({ addonInstalled: true, permission: 'asked' });
  assert.equal(fk(waiting, 'no-reading'), null, 'while the macOS box is up, one button (the app trim)');
  const r = await atWow({ addonInstalled: true, permission: 'denied' });
  const d = fk(r, 'no-reading');
  assert.equal(label(d), 'Skip screen reading?');
  assert.equal(d.getAttribute('aria-expanded'), 'false');
  assert.equal(fk(r, 'reading-off'), null, 'only after its click');
  await r.press(d);
  assert.equal(fk(r, 'no-reading').getAttribute('aria-expanded'), 'true');
  assert.match(r.pageText(), /Your messages then wait for a \/reload\. Replies still come in\./, 'what you lose, and what you keep (CL-player-32)');
  assert.doesNotMatch(r.pageText(), /\/nqa reading off|In chat, type/, 'no command to copy: one click in the app (the orchestrator’s trust plan, 2026-10-03)');
  // One click: the app's own switch (Your data's Screen reading), through setPrivacy; the row is then done.
  assert.equal(label(fk(r, 'reading-off')), 'Turn off screen reading');
  await r.press(fk(r, 'reading-off'));
  const set = r.calls.filter(c => c[0] === 'setPrivacy');
  assert.equal(set.length, 1);
  assert.deepEqual(set[0][1], { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: false }, 'only screen reading changes');
  assert.match(r.document.querySelector('[data-row="row-permission"]').className, /\bobj-skipped\b/, 'nothing left to allow: skipped, never drawn as allowed (APP-D-51)');
  assert.match(r.document.querySelector('[data-row="row-permission"] .sr-only').textContent, /Allow Screen Recording, skipped/);
  assert.match(r.pageText(), /Screen reading off\./);
  const off = await atWow({ addonInstalled: true, setup: { captureState: 'off' } });
  assert.match(off.document.querySelector('[data-row="row-permission"]').className, /\bobj-skipped\b/);
  assert.match(off.pageText(), /Screen reading off\./);
  // The app trim: no "Use screen reading instead?" here; turning it back on is the addon's (its Settings, /nqa reading on).
  assert.equal(fk(off, 'use-reading'), null);
  assert.doesNotMatch(off.pageText(), /Use screen reading instead|\/nqa reading on/);
});

test('the Listening dot breathes only while the window is in front: hidden, minimized or behind the game it holds still, so the software compositor has nothing to draw (code health, the audit’s .listen-dot note)', async () => {
  const r = await atWow({ addonInstalled: true, wow: { found: true, running: true }, permission: 'granted' });
  assert.ok(r.document.querySelector('.listen .listen-dot'), 'Listening, with its dot');
  const html = r.document.documentElement;
  assert.equal(html.getAttribute('data-away'), null, 'in front: it breathes');
  r.document.visibilityState = 'hidden';
  r.document.dispatchEvent(r.event('visibilitychange'));
  assert.equal(html.getAttribute('data-away'), '', 'hidden or minimized');
  r.document.visibilityState = 'visible';
  r.document.hasFocus = () => false;
  r.document.dispatchEvent(r.event('visibilitychange'));
  assert.equal(html.getAttribute('data-away'), '', 'shown, but the game is in front');
  r.document.hasFocus = () => true;
  r.document.dispatchEvent(r.event('visibilitychange'));
  assert.equal(html.getAttribute('data-away'), null, 'back in front');
  const app = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
  assert.match(app, /window\.addEventListener\('focus', markAway\); window\.addEventListener\('blur', markAway\);/, 'focus and blur too');
  const css = fs.readFileSync(path.join(APP, 'renderer', 'style.css'), 'utf8');
  const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
  assert.match(motion, /^\s+\.listen-dot \{ animation: breathe 2\.4s ease-in-out infinite; \}$/m, 'the same breath as before');
  assert.match(motion, /^\s+\[data-away\] \.listen-dot \{ animation: none; \}$/m, 'and none while away');
});

test('step 3 row 3: the steps in the game and Open Battle.net, no command to type; once WoW runs, Listening and Still waiting? (each cause worked out on its click, never by a timer); the hello finishes setup', async () => {
  const g = await atWow({ addonInstalled: true, permission: 'granted' });
  const row = g.document.querySelector('[data-row="row-start"]');
  // The steps in the game, in order and always on screen (2026-10-05).
  assert.deepEqual([...row.querySelectorAll('ol.obj-steps li')].map(li => li.textContent),
    ['Start WoW.', 'At character select, click AddOns and make sure NeverQuestAlone is checked.', 'Log in. NeverQuestAlone shows up beside your quest tracker.']);
  assert.equal(row.querySelector('code.cmd'), null, 'nothing to type (the owner, 2026-10-05: saying hi was a needless task)');
  assert.deepEqual(primaries(g).map(label), ['Open Battle.net']);
  await g.press(primaries(g)[0]);
  assert.ok(g.calls.some(c => c[0] === 'openGame'));
  const causes = [
    [{ permission: 'granted', setup: { game: { facts: { window: true, frames: 40, decoded: 0 } } } }, /The addon starts once you’re in the world\. If you are, open AddOns or switch WoW to Windowed mode\./],
    [{ permission: 'granted', setup: { game: { facts: { typedError: 'window_minimized' } } } }, /WoW is minimized\. Click it in the taskbar\./],
    [{ permission: 'granted', setup: { game: { facts: { typedError: 'capture_blocked_by_app' } } } }, /Another program blocks screen reading\. Close it\./],
    [{ permission: 'granted', setup: { game: { facts: { window: false, frames: 0 } } } }, /The app can’t find WoW’s window yet\. Click Check again in a moment\./],
  ];
  for (const [state, want] of causes) {
    const r = await atWow({ addonInstalled: true, wow: { found: true, running: true }, ...state });
    assert.match(r.pageText(), /Waiting for the addon…/);
    assert.equal(r.document.getElementById('still-waiting-box'), null, 'not before the click');
    await r.press(fk(r, 'still-waiting'));
    assert.equal(fk(r, 'still-waiting').getAttribute('aria-expanded'), 'true');
    assert.match(whyBox(r), want);
    assert.ok(fk(r, 'why-check'), 'Check again works it out again');
  }
  // The addon's hello (it loaded, and the app can see it) finishes setup: You're set.
  const hi = await atWow({ addonInstalled: true, permission: 'granted', wow: { found: true, running: true }, setup: { game: { hello: { at: 1, sig: 'ok', mode: 'pixel' } } } });
  assert.equal(titleText(hi), 'You’re set');
  assert.ok(hi.liveText().some(t => t === 'NeverQuestAlone is in your game. You’re set.'));
  const snd = await atWow({ addonInstalled: true, permission: 'granted', wow: { found: true, running: true }, setup: { game: { hello: { at: 1, sig: 'muted', mode: 'pixel' } } } });
  assert.doesNotMatch(snd.pageText(), /Turn game sound on/, 'no sound tip (the app trim): the hello is the hello');
  assert.equal(snd.byText('Okay').length, 0);
  // A first message that failed: its line, its fix.
  const ff = await atWow({ addonInstalled: true, permission: 'granted', lastError: { kind: 'spend_limit', at: 1 }, setup: { firstMsgAt: 1 } });
  assert.match(ff.document.querySelector('[data-row="row-start"]').className, /\bobj-error\b/);
  assert.match(ff.pageText(), /Once it’s fixed, say hi again\./);
});

// SY-06: with screen reading off, the hello waits in the addon's saved data: Still waiting? says type /reload.
test('step 3, screen reading off and no hello yet: Still waiting? says the hello waits for a /reload', async () => {
  const r = await atWow({ addonInstalled: true, permission: 'denied', wow: { found: true, running: true }, privacy: { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: false } });
  await r.press(fk(r, 'still-waiting'));
  assert.match(r.pageText(), /Screen reading is off, so the app finds the addon at your next \/reload\. In chat, type \/reload\./);
  assert.doesNotMatch(whyBox(r), /At character select/, 'not the AddOns advice');
});

test('step 3 on Windows: no Screen Recording row but a Screen reading row that says it’s on, with Skip screen reading? under it until the addon is in, then its title alone (ON-21); Open Battle.net tucks the window away', async () => {
  const r = await atWow({}, { platform: 'win32' });
  assert.equal(r.document.querySelector('[data-row="row-permission"]'), null);
  assert.equal(r.document.querySelectorAll('.obj').length, 3);
  const reading = r.document.querySelector('[data-row="row-reading"]');
  assert.match(reading.className, /\bobj-done\b/, 'nothing to allow on Windows: done');
  assert.match(reading.textContent, /Screen reading.*On\. Reads the top of WoW’s window\. Never keeps or sends pictures\./, 'off a Mac a window over the strip is read too: never "only" (ON-23)');
  assert.doesNotMatch(r.pageText(), /Tucks this window into the tray/, "no tray hint: the screen keeps to its 50 words");
  assert.ok(reading.querySelector('[data-fk="no-reading"]'));
  const inGame = await atWow({ addonInstalled: true }, { platform: 'win32' });
  const done = inGame.document.querySelector('[data-row="row-reading"]');
  assert.doesNotMatch(done.textContent, /On\. Reads/, 'the addon in: the row is its title alone, like every finished row');
  assert.equal(done.querySelector('[data-fk="no-reading"]'), null);
  assert.deepEqual(primaries(inGame).map(label), ['Open Battle.net']);
  await r.press(fk(r, 'no-reading'));
  assert.match(r.document.querySelector('[data-row="row-reading"]').textContent, /Your messages then wait for a \/reload\. Replies still come in\./);
  assert.ok(r.document.querySelector('[data-row="row-reading"] [data-fk="reading-off"]'), 'one click on Windows too');
  const hi = await atWow({ addonInstalled: true, wow: { found: true, running: true }, setup: { game: { hello: { at: 1, sig: 'ok', mode: 'pixel' } } } }, { platform: 'win32' });
  assert.equal(titleText(hi), 'You’re set', 'the hello finishes setup');
});

test('step 3’s banners over the list: no credit (Add credit the primary, the fix first; Test again quiet), a rejected key (Replace key), the model app down (Check again); WoW updated; a damaged file; the login item held under the list', async () => {
  const nc = await atWow({ addonInstalled: true, keyState: { anthropic: 'no_credit' } });
  const ban = nc.document.querySelector('#page .banner');
  assert.equal(ban.getAttribute('aria-label'), 'No credit at Anthropic.');
  assert.deepEqual(ban.querySelectorAll('button').map(label), ['Add credit', 'Test again'], 'the line names the company once; the fix first (CL-words-22)');
  assert.deepEqual(primaries(nc).map(label), ['Add credit'], 'its fix is the one primary; the row’s steps go quiet');
  const bad = await atWow({ addonInstalled: true });
  bad.mock.control.patch({ keys: REJECTED });
  await bad.push();
  assert.equal(titleText(bad), 'Set up WoW');
  assert.match(bad.pageText(), /Anthropic rejected your key\./);
  assert.deepEqual(primaries(bad).map(label), ['Replace key']);
  const down = await atWow({ addonInstalled: true, keys: {}, ...CUSTOM_LOCAL, rt: { state: 'local_down' } });
  assert.match(down.pageText(), /Can’t reach localhost:11434\./);
  assert.deepEqual(primaries(down).map(label), ['Check again']);
  assert.doesNotMatch(down.pageText(), /\{(co|ai|app)\}|⟦/);
  const iface = await atWow({ addonInstalled: true, permission: 'granted', wow: { found: true, running: true }, setup: { game: { ifaceMismatch: true } } }, { info: { releases: true }, releases: 'https://github.com/example/releases' });
  assert.match(iface.pageText(), /The addon’s out of date\./, 'what’s true, in the game’s words; the button is the fix (CL-words-81)');
  await iface.click('Open download page');
  assert.deepEqual(iface.opened, ['https://github.com/example/releases']);
  const dmg = await atWow({ addonInstalled: true, permission: 'granted', setup: { captureState: 'damaged' } });
  assert.match(dmg.pageText(), /NeverQuestAlone is damaged\./);
  // The app trim: step 3 never carries the held login item (Settings says it beside Start at login).
  const held = await atWow({ addonInstalled: true }, { info: { loginItem: { supported: true, openAtLogin: true, status: 'requires-approval' } } });
  assert.doesNotMatch(held.pageText(), /macOS paused Start at login\./);
  assert.equal(held.byText('Open Login Items settings').length, 0);
  assert.equal(held.document.querySelector('.login-held'), null);
});

test('a banner’s check that passes on step 3 says so in its place, once, with no Okay, and focus goes to the rows’ next step (DU-36, UX-W39)', async () => {
  const r = await atWow({ keyState: { anthropic: 'no_credit' }, creditLanded: true });
  await r.press(fk(r, 'card-test'));
  await r.settle(20);
  assert.equal(r.document.querySelector('#page .banner'), null, 'the banner goes');
  const line = r.document.querySelector('.say-passed');
  assert.equal(line.textContent, 'Claude is connected.');
  assert.equal(r.liveText().filter(t => t === 'Claude is connected.').length, 1, 'said once');
  assert.equal(r.document.querySelector('#banners .notice'), null, 'never a notice above setup');
  assert.equal(label(active(r)), 'Install', 'focus on the rows’ next step');
  await r.push();
  assert.equal(r.liveText().filter(t => t === 'Claude is connected.').length, 1, 'not said again on a push');
  const l = await atWow({ addonInstalled: true, keys: {}, ...CUSTOM_LOCAL, rt: { state: 'local_down' } });
  await l.press(fk(l, 'card-check'));
  await l.settle(20);
  assert.equal(l.document.querySelector('.say-passed').textContent, 'localhost:11434 is running with qwen3:8b.');
  assert.doesNotMatch(l.pageText() + l.bannerText(), /ready again/);
  const f = await atWow({ addonInstalled: true, keyState: { anthropic: 'no_credit' } });
  await f.press(fk(f, 'card-test'));
  assert.match(f.document.querySelector('#page .banner').textContent, /Still no credit\./, 'a check that fails says only that nothing changed');
});

test('Replace key from step 3’s banner: Your AI with Replace open and ‹ Back to setup at the top; back comes to step 3', async () => {
  const rej = await atWow({ keys: REJECTED });
  await rej.press(fk(rej, 'replace-key'));
  assert.equal(titleText(rej), 'Your AI');
  assert.ok(fk(rej, 'back-to-setup'));
  assert.equal(fk(rej, 'back-to-setup').parentNode.className, 'title-row');
  assert.ok(rej.document.getElementById('key-field'), 'Replace key is open');
  assert.equal(rej.document.getElementById('app').getAttribute('data-mode'), 'app');
  assert.equal(rej.document.querySelector('[data-nav="setup-now"]').hidden, false, 'Finish setup above the nav while setup is under way');
  await rej.press(fk(rej, 'back-to-setup'));
  assert.equal(titleText(rej), 'Set up WoW');
  assert.equal(rej.liveText().filter(t => /rejected your key/.test(t)).length, 1, 'said once across the pages (DU-19)');
});

test('You’re set: the title, one line, where he stays, Open Home; said once in the live region; his first words are never drawn (the app trim)', async () => {
  const words = '<img src=x onerror=alert(1)> Well met.';
  const r = await atWow({ addonInstalled: true, permission: 'granted', setup: { game: { hello: { at: 1, sig: 'ok', mode: 'pixel' } }, firstMsgAt: 2, firstReplyAt: 3, firstWords: words } }, { info: { loginItem: { supported: true, openAtLogin: true, status: 'enabled' } } });
  assert.equal(titleText(r), 'You’re set');
  assert.equal(r.document.querySelector('.flourish'), null, 'no flourish');
  assert.equal(r.document.querySelector('.quote'), null, 'no quote of his first words');
  assert.doesNotMatch(r.pageText(), /Well met|just now/, 'hostile or not, his words never reach this page');
  assert.equal(r.document.querySelector('#page img'), null, 'text, never markup');
  assert.match(r.pageText(), /NeverQuestAlone stays in your menu bar\./);
  assert.equal(r.liveText().filter(t => t === 'NeverQuestAlone is in your game. You’re set.').length, 1);
  assert.equal(r.byText('Finish later').length, 0);
  assert.deepEqual(primaries(r).map(label), ['Open Home']);
  assert.ok(r.document.querySelectorAll('#tracker .tracker-done').length === 3, 'every tracker row done');
  await r.press(primaries(r)[0]);
  assert.equal(r.document.getElementById('app').getAttribute('data-mode'), 'app');
  const off = await atWow({ addonInstalled: true, setup: { firstReplyAt: 3 } }, { info: { loginItem: { supported: true, openAtLogin: false } } });
  assert.match(off.pageText(), /Start NeverQuestAlone yourself when you play\./);
  assert.equal(off.document.querySelector('.quote'), null, 'no quote, first words or not');
  const win = await atWow({ addonInstalled: true, setup: { firstReplyAt: 3 } }, { platform: 'win32', info: { loginItem: { supported: true, openAtLogin: true } } });
  assert.match(win.pageText(), /NeverQuestAlone stays in your system tray\./);
});

test('a push patches step 3 in place (the controls stay the same nodes); a push that lands mid-press waits for the release, so the click counts (DU-02)', async () => {
  const r = await atWow({ addonInstalled: true });
  const allow = fk(r, 'row-primary');
  const titleEl = r.document.getElementById('page-title');
  assert.equal(label(allow), 'Allow');
  r.mock.control.patchSetup({ game: { facts: { frames: 41 } } });
  await r.push();
  assert.equal(fk(r, 'row-primary'), allow, 'the same node after a push');
  allow.dispatchEvent(r.event('pointerdown'));
  r.mock.control.patchSetup({ game: { running: true } });
  await r.push();
  assert.doesNotMatch(r.pageText(), /Waiting for the addon/, 'nothing drawn while the pointer is down');
  allow.dispatchEvent(r.event('pointerup'));
  await r.press(allow);
  await r.settle(30);
  assert.ok(r.calls.some(c => c[0] === 'requestScreenPermission'), 'the click counted');
  assert.equal(r.document.getElementById('page-title'), titleEl, 'the screen was patched, never swapped');
});

test('the nav and setup (DU-01, DU-11): while setup is under way Finish setup sits above the nav, one click back; Run setup again lives in Settings', async () => {
  const r = await pageRig({ onboarded: false });
  const now = x => x.document.querySelector('[data-nav="setup-now"]');
  await r.click('Finish later');
  assert.equal(now(r).hidden, false);
  assert.match(now(r).textContent, /^Finish setup/);
  assert.equal(now(r).querySelectorAll('.nav-mark').length, 3, 'three small diamonds');
  assert.equal(now(r).querySelector('.nav-marks').getAttribute('aria-hidden'), 'true');
  await r.press(now(r));
  assert.equal(titleText(r), 'Connect your AI', 'back at the saved screen');
  const home = await pageRig({ state: { ...CONNECTED, addonInstalled: true, setup: { firstReplyAt: 1 } } });
  assert.equal(now(home).hidden, true);
  await home.click('Settings');
  await home.click('Show more');
  await home.click('Run setup again');
  assert.equal(titleText(home), 'Connect your AI', 'setup starts over');
});

test('the scans over every screen: no id the table lacks, no plumbing word, no Step N of M, no stop promised; the render code names only ids the table has', async () => {
  const states = [
    [{}, {}, 'step 2'],
    [{ keys: SAVED, terms: { anthropic: 1 } }, { setup: { v: 2, screen: 'ai', path: 'key', provider: 'anthropic' } }, 'step 2 returning'],
    [{}, { setup: { v: 2, screen: 'connect', path: 'custom', provider: 'custom' } }, 'Other'],
    [{ ...CONNECTED, wow: { found: false, running: false } }, AT('wow'), 'step 3 not found'],
    [{ ...CONNECTED, addonInstalled: true, permission: 'asked' }, AT('wow'), 'step 3 asked'],
    [{ ...CONNECTED, addonState: 'eperm' }, AT('wow'), 'step 3 eperm'],
    [{ ...CONNECTED, addonState: 'older' }, AT('wow'), 'step 3 older'],
    [{ ...CONNECTED, addonInstalled: true, setup: { firstReplyAt: 1, firstWords: 'Hi.' } }, AT('wow'), 'You’re set'],
  ];
  for (const [state, appState, labelText] of states) {
    for (const platform of ['darwin', 'win32']) scan(await pageRig({ onboarded: false, state, appState, platform }), `${labelText} ${platform}`);
  }
  const app = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
  const fmt = fs.readFileSync(path.join(APP, 'renderer', 'format.js'), 'utf8');
  const strings = fs.readFileSync(path.join(APP, 'renderer', 'strings.js'), 'utf8');
  const table = new Function('window', `${strings}; return window.BonesStrings;`)({});
  const has = id => id.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), table) !== undefined;
  const ROOTS = Object.keys(table).join('|');
  const ids = [...`${app}\n${fmt}`.matchAll(new RegExp(`'((?:${ROOTS})\\.[a-zA-Z0-9.]+)'`, 'g'))].map(m => m[1]).filter(id => !id.endsWith('.') && !id.startsWith('connect.'));
  assert.ok(ids.length > 150, `the scan sees the ids (${ids.length})`);
  assert.deepEqual([...new Set(ids)].filter(id => !has(id)), []);
  // The screens the redesign removed are gone from the code: S1's welcome, S2's Connect <AI>, S3's defaults.
  for (const gone of ['defaults.', 'connectResult.', 'ai.card.', 'ai.leaves.', 'stage.connectLine2']) assert.ok(!app.includes(`'${gone}`), gone);
  assert.doesNotMatch(app, /I’m \{name\}|I'm NeverQuestAlone/, 'no first-person paragraph on the stage');
  assert.doesNotMatch(app, /display\.en|\ben\(/, 'no manifest words in the renderer');
});

test('onboarding review (2026-10-05): No key yet? opens the picked AI’s key in four numbered steps; a good key opens step 3 on its connected line; row 3 lists only true steps', async () => {
  const r = await pageRig({ onboarded: false });
  const link = fk(r, 'no-key');
  assert.ok(link, 'No key yet? on a fresh step 2');
  assert.equal(label(link), 'No key yet?');
  assert.equal(link.getAttribute('aria-expanded'), 'false');
  assert.equal(r.document.getElementById('no-key-box'), null, 'its steps wait behind its click');
  await r.press(link);
  const box = () => r.document.getElementById('no-key-box');
  assert.equal(box().getAttribute('data-behind'), 'click');
  assert.equal(fk(r, 'no-key').getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...box().querySelectorAll('li')].map(li => li.textContent), [
    'Click Open Anthropic’s key page, then sign in or make an account.', 'Add $5 of credit.', 'Click Create key, then Copy.', 'Come back to this window and click Paste Anthropic key.']);
  assert.doesNotMatch(box().textContent, /Claude Pro/, 'the subscriptions’ line stays in Show details (the box fits at 760×540)');
  await pick(r, 'openai');
  assert.match(box().textContent, /Click Create new secret key, then Copy\./, 'OpenAI’s own button');
  // A paste with no key in it keeps the help, and its box (OB-03).
  await paste(r, '');
  assert.ok(fk(r, 'no-key'), 'No key yet? stays after an empty clipboard');
  assert.ok(box(), 'and its box stays open');
  // A good key: step 3, its title row saying the key works (visible, and said once).
  const k = await pageRig({ onboarded: false });
  await paste(k, ANT);
  wentOn(k, 'Claude is connected.');
  assert.equal(k.document.querySelector('.say-passed')?.textContent, 'Claude is connected.');
  assert.equal(k.liveText().filter(t => t === 'Claude is connected.').length, 1, 'said once');
  await k.press(primaries(k)[0]);
  assert.equal(k.document.querySelector('.say-passed'), null, 'it greets step 3 and goes once the first row moves on (OB-14)');
  // Row 3 with WoW running and the addon in: no Start WoW step, it's done.
  const run = await atWow({ addonInstalled: true, permission: 'granted', wow: { found: true, running: true } });
  assert.deepEqual([...run.document.querySelectorAll('[data-row="row-start"] ol.obj-steps li')].map(li => li.textContent),
    ['At character select, click AddOns and make sure NeverQuestAlone is checked.', 'Log in. NeverQuestAlone shows up beside your quest tracker.']);
  // WoW running with the install waiting for it to close: the install stays the current row, and row 3 waits
  // for it with its title alone: no steps, no waiting status, no Still waiting? (ON-22).
  const armed = await atWow({ permission: 'granted', wow: { found: true, running: true } });
  await armed.press(primaries(armed)[0]);
  assert.ok(armed.calls.some(c => c[0] === 'armInstall'));
  assert.match(armed.pageText(), /Installs when you quit WoW\./);
  assert.equal(armed.document.querySelector('[data-row="row-install"]').getAttribute('aria-current'), 'step', 'the waiting install is the current step (OB-21)');
  assert.match(fk(armed, 'cancel-install').className, /\bbtn-ghost\b/, 'Cancel stays quiet on the current row');
  const r3 = armed.document.querySelector('[data-row="row-start"]');
  assert.equal(r3.querySelector('ol.obj-steps'), null);
  assert.doesNotMatch(r3.textContent, /Waiting for the addon|Still waiting\?/);
  // The real finish is the hello alone (since 1.4.8): You're set, Set up WoW ticked, the saved setup screen
  // gone, and Home with no Finish setup (ON-25, OB-23).
  const HI = { at: 1, sig: 'ok', mode: 'pixel' };
  const fin = await atWow({ addonInstalled: true, permission: 'granted', wow: { found: true, running: true }, setup: { game: { hello: HI } } });
  assert.equal(titleText(fin), 'You’re set');
  assert.match(fin.document.querySelector('.tracker-row[data-key="say"]').className, /\btracker-done\b/);
  assert.equal(fin.appState().setup, null, 'the saved setup screen goes with setup');
  await fin.press(fk(fin, 'home'));
  assert.equal(fin.document.querySelector('[data-fk="finish-setup"]'), null, 'no Finish setup after the hello');
  // The hello with no credit: Almost set up under the card, its button the one primary, no Say Hi line yet (OB-24).
  const nc = await atWow({ addonInstalled: true, permission: 'granted', wow: { found: true, running: true }, keyState: { anthropic: 'no_credit' }, setup: { game: { hello: HI } } });
  assert.equal(titleText(nc), 'Almost set up');
  assert.doesNotMatch(nc.pageText(), /click Say Hi/);
  assert.deepEqual(primaries(nc).map(label), ['Add credit']);
  assert.match(nc.document.querySelector('.tracker-row[data-key="connect"]').className, /\btracker-credit\b/);
});
