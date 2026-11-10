#!/usr/bin/env node
// Times the companion's answers to a set of questions (odd/tasks/nqa-brain.md B1, B5, B8), the way
// the app asks them: the request is built with the app's own buildRequest (the prompt pack, the
// player's current game state from the app's companion.json, the last turns of a chat as history)
// and sent to the subscription proxy (or any OpenAI-compatible endpoint), one question at a time.
//
//   node tools/brain/bench.mjs [--mode app|brain] [--model claude-code:sonnet] [--base http://127.0.0.1:8787/v1]
//        [--app-data <dir>] [--chat c0ffee0] [--history 6] [--only 1,3] [--out <file.json>]
//
// --mode app    today's turn (the full pack + game data + history), the baseline.
// --mode brain  the brain's turn (tools/brain/turn.mjs: compact prompt + retrieved, sourced facts).
// Prints each question's time and the answer's first words; --out keeps the answers for checking.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildRequest } from '../../bridge/byok/runtime/context.mjs';
import { loadPack } from '../../bridge/byok/runtime/pack.mjs';
import { createPseudonymizer } from '../../bridge/byok/runtime/pseudonym.mjs';

// The 10 questions of the test (odd/tasks/nqa-brain.md, S8), for the level 22 Tauren Shaman.
export const QUESTIONS = Object.freeze([
  '¿Dónde consigo un mejor pecho para mi nivel?',
  '¿Dónde está Islen Waterseer?',
  '¿Cómo llego a la entrega de Call of Water?',
  '¿Dónde está el siguiente paso de Call of Water?',
  'No encuentro cómo subir a la elevación de Thunder Bluff donde está el entrenador de chamanes.',
  '¿Qué mecánicas tiene Mutanus the Devourer?',
  '¿Qué me recomiendas farmear a mi nivel?',
  '¿Qué objetos buenos para mí hay en Wailing Caverns?',
  '¿Quién da y quién recibe Deviate Hides?',
  '¿Dónde están los Deviate Hides que me faltan?',
]);

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt; };

/** The newest game state the app keeps (companion.json), or null. */
export function latestState(appData) {
  try {
    const comp = JSON.parse(fs.readFileSync(path.join(appData, 'bridge', 'companion.json'), 'utf8'));
    const all = Object.values(comp.states || {}).filter(s => s && s.state);
    return all.sort((a, b) => (b.at || 0) - (a.at || 0))[0]?.state ?? null;
  } catch { return null; }
}

/** The last n messages of a chat's transcript, as buildRequest takes history. */
export function lastTurns(appData, chat, n) {
  try {
    const rows = fs.readFileSync(path.join(appData, 'transcripts', `${chat}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    return rows.slice(-n).map(r => ({ role: r.role, content: String(r.text || ''), names: r.names || [] }));
  } catch { return []; }
}

/** An OpenAI-style chat request from buildRequest's result (what the app's custom provider sends). */
export function toChat(req, model) {
  const system = req.system.map(s => s.text).join('\n\n');
  return { model, max_tokens: req.maxTokens, messages: [{ role: 'system', content: system }, ...req.messages.map(m => ({ role: m.role, content: m.content }))] };
}

export async function ask(base, body, { fetchFn = fetch } = {}) {
  const t0 = performance.now();
  const r = await fetchFn(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const ms = Math.round(performance.now() - t0);
  return { ms, ok: r.ok, text: j.choices?.[0]?.message?.content ?? '', error: r.ok ? null : (j.error?.message || `HTTP ${r.status}`) };
}

async function main() {
  const mode = arg('mode', 'app');
  const model = arg('model', 'claude-code:sonnet');
  const base = arg('base', 'http://127.0.0.1:8787/v1');
  const appData = arg('app-data', path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NeverQuestAlone', 'dev'));
  const chat = arg('chat', 'c0ffee0');
  const historyN = Number(arg('history', '6'));
  const only = arg('only') ? new Set(arg('only').split(',').map(Number)) : null;
  const out = arg('out');
  const state = latestState(appData);
  if (!state) { console.error('No game state in', appData); process.exit(2); }
  const results = [];
  const brainHistory = []; // brain mode: its own last exchanges, as the voice keeps them
  for (const [i, q] of QUESTIONS.entries()) {
    if (only && !only.has(i + 1)) continue;
    let body, meta = {};
    if (mode === 'brain') {
      const { brainRequest } = await import('./turn.mjs');
      const r = await brainRequest({ appData, question: q, state, history: brainHistory.slice(-8) });
      body = { model, max_tokens: r.maxTokens, messages: r.messages };
      meta = r.meta;
    } else {
      // As bridge/byok/backend.mjs does: the brain's facts in the game data; the compact pack when it found any.
      const { openBrain, brainFile } = await import('./db.mjs');
      const { retrieve } = await import('./retrieve.mjs');
      const { loadChatPack } = await import('../../bridge/byok/runtime/pack.mjs');
      const db = fs.existsSync(brainFile(appData)) ? openBrain(brainFile(appData), { readOnly: true }) : null;
      const found = db ? retrieve({ db, question: q, state }) : { lines: [] };
      if (db) db.close();
      const fast = mode === 'app' && found.lines.length > 0;
      const req = buildRequest({ pack: fast ? loadChatPack() : loadPack(), game: { state, ...(found.lines.length ? { facts: found.lines } : {}) }, history: lastTurns(appData, chat, historyN), userText: q, pseudonymizer: createPseudonymizer(), model, ...(fast ? { maxTokens: 500 } : {}) });
      meta = { facts: found.lines.length, retrieveMs: found.ms, fast };
      body = toChat(req, model);
    }
    const chars = body.messages.reduce((n, m) => n + String(m.content).length, 0);
    const r = await ask(base, body);
    results.push({ n: i + 1, question: q, ms: r.ms, chars, ok: r.ok, error: r.error, answer: r.text, meta });
    if (mode === 'brain' && r.ok) brainHistory.push({ role: 'user', content: q }, { role: 'assistant', content: r.text.replace(/```wowmap[\s\S]*?```/g, '').trim() });
    console.log(`${String(i + 1).padStart(2)} ${String(r.ms).padStart(6)} ms ${String(chars).padStart(6)} chars ${r.ok ? '' : 'ERROR ' + r.error} | ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  const done = results.filter(r => r.ok);
  const avg = done.length ? Math.round(done.reduce((n, r) => n + r.ms, 0) / done.length) : null;
  console.log(`mode ${mode}, model ${model}: ${done.length}/${results.length} answered, average ${avg} ms`);
  if (out) fs.writeFileSync(out, JSON.stringify({ mode, model, at: new Date().toISOString(), avg, results }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
