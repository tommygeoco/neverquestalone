#!/usr/bin/env node
// End-to-end check of the voice companion (odd/tasks/nqa-voice.md T5): a real Chrome (headless) with
// a fake microphone playing a recorded question, the real voice page and server, and the real OpenAI
// Realtime API. Not part of npm test: it costs a few cents and needs Chrome and an OpenAI key.
//
//   node tools/voice/e2e.mjs --wav <question.wav> [--key-file ~/.config/neverquestalone/api-keys.json]
//        [--chrome /usr/bin/google-chrome] [--expect <regex the answer must match>] [--timeout 60]
//        [--from-app <app data dir>]   copy that app's game state and brain into the throwaway folder
//                                        (the player's real data; nothing is written back there)
//
// It builds a throwaway app folder with a game state (Wailing Caverns quest, The Barrens), so the
// model's get_game_state call has something to read, and prints what was heard, what was answered,
// the tools called, the voice inbox the bridge would publish, and the estimated cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, readKey, DEFAULTS } from './server.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const wav = opt('wav');
if (!wav || !fs.existsSync(wav)) { console.error('--wav <file> is required'); process.exit(2); }
const key = readKey({ keyFile: opt('key-file', path.join(os.homedir(), '.config', 'neverquestalone', 'api-keys.json')) });
if (!key) { console.error('no OpenAI key'); process.exit(2); }
const chrome = opt('chrome', '/usr/bin/google-chrome');
const expect = opt('expect') ? new RegExp(opt('expect'), 'i') : null;
const timeoutMs = Number(opt('timeout', 60)) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A throwaway app folder with one game state.
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-voice-e2e-'));
fs.mkdirSync(path.join(appData, 'bridge'));
fs.writeFileSync(path.join(appData, 'bridge', 'companion.json'), JSON.stringify({ states: { '3fa9c2d1': { sid: 'a1b2c3d4e5f60718', seq: 9, at: Date.now(), state: {
  v: 1, sid: 'a1b2c3d4e5f60718', seq: 9,
  char: { name: 'Arystar', class: 'HUNTER', race: 'Orc', level: 21, xp: 9000, xpMax: 18000, money: 45210 },
  loc: { zone: 'The Barrens', sub: 'The Crossroads', map: 1413, x: 51.9, y: 30.3 },
  questCount: 3, questMax: 40, quests: [
    { id: 914, title: 'Leaders of the Fang', level: 22, complete: false, obj: [{ t: 'Gem of Cobrahn', have: 0, need: 1 }, { t: 'Gem of Anacondra', have: 1, need: 1 }] },
    { id: 882, title: 'Ishamuhale', level: 19, complete: true, obj: [] },
    { id: 959, title: 'Trouble at the Docks', level: 18, complete: false, obj: [{ t: 'Mad Magglish', have: 0, need: 1 }] },
  ],
} } } }));
// The player's real game state and brain, copied (odd/tasks/nqa-brain.md B13).
const fromApp = opt('from-app');
if (fromApp) {
  fs.copyFileSync(path.join(fromApp, 'bridge', 'companion.json'), path.join(appData, 'bridge', 'companion.json'));
  const brain = path.join(fromApp, 'brain', 'brain.sqlite');
  if (fs.existsSync(brain)) { fs.mkdirSync(path.join(appData, 'brain')); fs.copyFileSync(brain, path.join(appData, 'brain', 'brain.sqlite')); }
  console.log('using the game state and brain of', fromApp);
}

const o = { ...DEFAULTS, appData, port: 0 };
const server = createServer(o, { key, log: (...a) => console.log('[server]', ...a) });
await new Promise(r => server.listen(0, '127.0.0.1', r));
o.port = server.address().port;
const url = `http://localhost:${o.port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-voice-chrome-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); } }
  if (!port) throw new Error('Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map(); const consoleLines = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled') consoleLines.push(d.params.args.map(a => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION ' + (d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text));
  };
  const cdp = (method, params = {}) => new Promise(res => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(1000);
  const t0 = Date.now();
  await evaluate("document.getElementById('connect').click()");
  let text = '';
  while (Date.now() - t0 < timeoutMs) {
    text = await evaluate("document.getElementById('log').innerText") || '';
    const answered = /NeverQuestAlone: \S[\s\S]{20,}/.test(text) && /Tú: /.test(text);
    const status = await evaluate("document.getElementById('status').innerText");
    if (answered && status === 'Escuchando') break;
    await sleep(500);
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const cost = await evaluate("document.getElementById('cost').innerText");
  const game = await evaluate("document.getElementById('game').innerText");
  const latencies = await evaluate('JSON.stringify(window.NQAVoice.status().latencies)');
  await evaluate("document.getElementById('connect').click()");
  let inbox = '';
  try {
    const dir = path.join(appData, 'bridge', 'voice-inbox');
    inbox = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  } catch { /* none */ }
  console.log('--- page log ---\n' + text);
  console.log('--- status ---', { seconds, cost, game, firstWordsMs: latencies });
  console.log('--- voice inbox ---\n' + (inbox || '(empty)'));
  if (consoleLines.length) console.log('--- console ---\n' + consoleLines.join('\n'));
  const ok = /Tú: /.test(text) && /NeverQuestAlone: \S/.test(text) && /Consultando tus datos del juego/.test(text) && (!expect || expect.test(text));
  console.log(ok ? 'E2E OK' : 'E2E FAILED');
  process.exitCode = ok ? 0 : 1;
} finally {
  try { ws?.close(); } catch { /* gone */ }
  proc.kill();
  server.close();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(appData, { recursive: true, force: true });
}
