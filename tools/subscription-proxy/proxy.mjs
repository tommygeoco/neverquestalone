#!/usr/bin/env node
// Subscription proxy: an OpenAI-compatible Chat Completions server on this computer that answers
// with the Claude Code CLI (`claude -p`, your Claude Pro/Max login) or the Codex CLI
// (`codex exec`, your ChatGPT login) instead of an API key.
//
// Connect it in the NeverQuestAlone app as Other:
//   Base URL  http://localhost:8787/v1     (no key)
//   Model     claude-code                  Claude Code, its default model (Sonnet)
//             claude-code:opus             Claude Code with another model alias or id
//             codex                        Codex, its default model
//             codex:gpt-reserve            Codex with another model id (the fastest a ChatGPT login takes)
//
// It listens on 127.0.0.1 only, so nothing else on the network can spend your subscription.
// Claude runs with no tools (--tools ""). Codex is disabled unless NQA_PROXY_CODEX_TOOLS=accept:
// its read-only sandbox is NOT a no-tools guarantee. Both run in a fresh scratch working folder,
// and no conversation is kept between turns: the app sends the whole chat
// each time, as it does to any provider.
//
// Personal use only. Your subscription's own terms apply; don't share or host this for others.
//
//   node tools/subscription-proxy/proxy.mjs [--port 8787]
//   env: NQA_PROXY_PORT, NQA_CLAUDE_BIN, NQA_CODEX_BIN, NQA_CLAUDE_EFFORT, NQA_CODEX_EFFORT (both default low),
//        NQA_CODEX_MODEL (the model plain `codex` uses; default: Codex's own), NQA_PROXY_CODEX_TOOLS,
//        NQA_PROXY_MAX_RUNS (default 2), NQA_PROXY_TIMEOUT_MS (default 170000), NQA_PROXY_LOG,
//        NQA_CLAUDE_POOL_SIZE (0 disables; default/max 2), NQA_CLAUDE_IDLE_MS (default 180000)
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argPort = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : NaN;
const PORT = Number.isInteger(argPort) && argPort > 0 ? argPort : Number(process.env.NQA_PROXY_PORT || 8787);
const HOST = '127.0.0.1';
const CLAUDE_BIN = process.env.NQA_CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.NQA_CODEX_BIN || 'codex';
const CODEX_EFFORT = process.env.NQA_CODEX_EFFORT || 'low';
// Low effort: a quest answer needs little thinking, and hidden thinking is most of the wait.
const CLAUDE_EFFORT = process.env.NQA_CLAUDE_EFFORT || 'low';
const CODEX_MODEL = process.env.NQA_CODEX_MODEL || '';
// Operator-only, captured at startup. Neither request text nor a request option can opt in.
const CODEX_TOOLS_ACCEPTED = process.env.NQA_PROXY_CODEX_TOOLS === 'accept';
const MAX_RUNS = Math.max(1, Number(process.env.NQA_PROXY_MAX_RUNS || 2));
// Below the app's own 180 s run limit, so the app hears a clean error rather than cutting us off.
const RUN_TIMEOUT_MS = Number(process.env.NQA_PROXY_TIMEOUT_MS || 170000);
const MAX_BODY = 8 * 1024 * 1024;
const WORK_ROOT = path.join(os.tmpdir(), 'nqa-subscription-proxy');
const LOG_FILE = process.env.NQA_PROXY_LOG || path.join(WORK_ROOT, 'proxy.log');
const boundedInt = (value, fallback, min, max) => Number.isInteger(Number(value)) && value !== undefined
  ? Math.min(max, Math.max(min, Number(value))) : fallback;
// Global idle limit also bounds each model: arbitrary request model ids cannot grow the pool.
const CLAUDE_POOL_SIZE = boundedInt(process.env.NQA_CLAUDE_POOL_SIZE, 2, 0, 2);
const CLAUDE_IDLE_MS = boundedInt(process.env.NQA_CLAUDE_IDLE_MS, 180000, 100, 300000);

export const MODELS = Object.freeze([
  { id: 'claude-code', owned_by: 'claude-code' },
  { id: 'claude-code:sonnet', owned_by: 'claude-code' },
  { id: 'claude-code:opus', owned_by: 'claude-code' },
  { id: 'claude-code:haiku', owned_by: 'claude-code' },
  { id: 'codex', owned_by: 'codex' },
  // The models a ChatGPT login takes. gpt-6-luna needs a recent Codex CLI: 0.167 answers, 0.153 is refused
  // it (checked 2026-11-09). gpt-6.1-luna is refused on both; gpt-6-sol, gpt-6.1-sol and gpt-6.1-terra were
  // refused on 0.153 (2026-11-08, not rechecked on 0.167).
  { id: 'codex:gpt-reserve', owned_by: 'codex' },
  { id: 'codex:gpt-6-astra', owned_by: 'codex' },
  { id: 'codex:gpt-6-luna', owned_by: 'codex' },
]);

fs.mkdirSync(WORK_ROOT, { recursive: true });

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* logging never breaks a turn */ }
  if (process.stdout.isTTY) process.stdout.write(line);
}

// ---- requests -> one prompt ------------------------------------------------------------

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return content == null ? '' : String(content);
};

/** {system, prompt} from Chat Completions messages: system/developer joined, the rest as a transcript. */
export function flatten(messages = []) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    const text = textOf(m?.content);
    if (m?.role === 'system' || m?.role === 'developer') system.push(text);
    else turns.push({ role: m?.role === 'assistant' ? 'assistant' : 'user', text });
  }
  let prompt;
  if (turns.length === 1 && turns[0].role === 'user') prompt = turns[0].text;
  else {
    prompt = 'The conversation so far, oldest first:\n\n'
      + turns.map(t => `<${t.role}>\n${t.text}\n</${t.role}>`).join('\n\n')
      + '\n\nWrite only the assistant\'s next reply to the last user message, in the format the instructions ask for.';
  }
  return { system: system.join('\n\n'), prompt };
}

/** 'claude-code:opus' -> {cli:'claude', model:'opus'}; unknown -> null. */
export function route(model) {
  // The model part goes on the CLI's command line: a plain id only (letters, digits, . _ : - /).
  const m = /^(claude-code|codex)(?::([A-Za-z0-9][A-Za-z0-9._:\/-]{0,63}))?$/.exec(String(model || ''));
  if (!m) return null;
  return { cli: m[1] === 'codex' ? 'codex' : 'claude', model: m[2] || null };
}

// ---- the CLIs ----------------------------------------------------------------------------

// API keys never reach either CLI: one would bill the API instead of the subscription, and the
// other provider's key has no business in a CLI at all.
export const KEY_VARS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'NQA_API_KEY', 'NQA_PROXY_TOKEN']);
function childEnv() {
  const env = { ...process.env };
  for (const k of KEY_VARS) delete env[k];
  return env;
}

function workDir() {
  const dir = path.join(WORK_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function claudeArgs(model, dir, optimized) {
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--system-prompt-file', path.join(dir, 'system.txt'), '--setting-sources', ''];
  if (model) argv.push('--model', model);
  if (CLAUDE_EFFORT) argv.push('--effort', CLAUDE_EFFORT);
  if (optimized) argv.push('--input-format', 'stream-json', '--safe-mode', '--disable-slash-commands', '--max-turns', '1');
  return argv;
}

function spawnCli(bin, argv, dir, cli) {
  if (/\.(?:cmd|bat)$/i.test(bin)) throw { status: 502, message: `${bin} is a .cmd/.bat shim: point NQA_${cli.toUpperCase()}_BIN at the CLI's .exe (or its .js entry point)` };
  const viaNode = /\.(?:mjs|js)$/i.test(bin);
  return spawn(viaNode ? process.execPath : bin, viaNode ? [bin, ...argv] : argv,
    { cwd: dir, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

// Only unused processes are pooled. A worker is never returned after receiving a user message.
// Key on the exact system bytes as well as the model; never move instructions into user content.
class CliWorkers {
  idle = [];
  children = new Set();
  closed = false;
  disabledUntil = 0;
  get enabled() { return !this.closed && CLAUDE_POOL_SIZE > 0 && Date.now() >= this.disabledUntil; }
  key(model, system) { return JSON.stringify([model, crypto.createHash('sha256').update(system).digest('hex')]); }
  track(child, dir) {
    this.children.add(child);
    child.once('close', () => {
      this.children.delete(child);
      fs.rm(dir, { recursive: true, force: true }, () => {});
    });
    return child;
  }
  discard(worker) {
    clearTimeout(worker.timer);
    this.idle = this.idle.filter(w => w !== worker);
    try { worker.child.kill(); } catch { /* already gone */ }
  }
  take(model, system) {
    const key = this.key(model, system);
    const worker = this.idle.find(w => w.key === key && !w.error && w.child.exitCode === null && !w.child.killed);
    if (!worker) return null;
    clearTimeout(worker.timer);
    this.idle = this.idle.filter(w => w !== worker);
    worker.taken = true;
    return worker;
  }
  disable() {
    this.disabledUntil = Date.now() + 60000;
    for (const worker of [...this.idle]) this.discard(worker);
  }
  fill(model, system) {
    if (!this.enabled) return;
    const key = this.key(model, system);
    // Keep only the most recently successful system/model; no unbounded map of prompt strings.
    for (const worker of [...this.idle]) if (worker.key !== key) this.discard(worker);
    while (this.idle.length < CLAUDE_POOL_SIZE) {
      let dir;
      try {
        dir = workDir();
        fs.writeFileSync(path.join(dir, 'system.txt'), system || 'You are a helpful assistant.');
        const child = this.track(spawnCli(CLAUDE_BIN, claudeArgs(model, dir, true), dir, 'claude'), dir);
        const worker = { key, dir, child, taken: false, error: null };
        this.idle.push(worker);
        // Drain diagnostics without retaining prompt data. stdout stays paused until take().
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => {});
        child.once('error', error => { worker.error = error; if (!worker.taken) this.disable(); });
        child.once('close', () => { if (!worker.taken && !child.killed) this.disable(); this.discard(worker); });
        worker.timer = setTimeout(() => this.discard(worker), CLAUDE_IDLE_MS);
        worker.timer.unref();
      } catch {
        if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
        this.disable();
        break;
      }
    }
  }
  close() {
    this.closed = true;
    for (const worker of [...this.idle]) this.discard(worker);
    for (const child of this.children) { try { child.kill(); } catch { /* gone */ } }
  }
}

function runTurn(r, flat, onText, workers) {
  let current; let stopped = false; let emitted = false;
  const optimized = r.cli === 'claude' && workers.enabled;
  const start = Date.now();
  const emit = text => { emitted = true; onText(text); };
  const done = (async () => {
    try {
      current = runCli(r, flat, emit, workers, { optimized, prepared: optimized ? workers.take(r.model, flat.system) : null });
      const result = await current.done;
      // Refill after the HTTP response's microtasks; spawning replacements must not delay it.
      if (optimized && !stopped) setImmediate(() => { if (!stopped) workers.fill(r.model, flat.system); });
      return result;
    } catch (error) {
      if (!optimized) throw error;
      const remaining = RUN_TIMEOUT_MS - (Date.now() - start);
      // Never duplicate already-streamed text, retry quota errors or revive a cancelled turn.
      if (stopped || error.status === 429 || remaining <= 0) throw error;
      workers.disable();
      if (emitted) throw error;
      log('claude', 'warm path failed; retrying isolated legacy process');
      current = runCli(r, flat, emit, workers, { timeout: remaining });
      return current.done;
    }
  })();
  return { done, kill() { stopped = true; current?.kill(); } };
}

/**
 * Runs one turn. onText(delta) gets text as it arrives; resolves {usage, finish} or rejects with
 * {status, message}. Abort with the returned kill().
 */
function runCli({ cli, model }, { system, prompt }, onText, workers, { optimized = false, prepared = null, timeout = RUN_TIMEOUT_MS } = {}) {
  const dir = prepared?.dir || workDir();
  const started = Date.now();
  let firstText = null; let initTime = null; let spawnTime = prepared ? 0 : null;
  let bin; let argv; let input;
  if (cli === 'claude') {
    const sysFile = path.join(dir, 'system.txt');
    if (!prepared) fs.writeFileSync(sysFile, system || 'You are a helpful assistant.');
    bin = CLAUDE_BIN;
    argv = claudeArgs(model, dir, optimized);
    input = optimized ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n' : prompt;
  } else {
    bin = CODEX_BIN;
    argv = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only', '--strict-config', '-C', dir,
      '-c', `model_reasoning_effort="${CODEX_EFFORT}"`, '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
      '-c', 'features.shell_tool=false', '-c', 'features.view_image=false',
      '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
      '-c', 'features.hooks=false', '-c', 'features.skill_mcp_dependency_install=false'];
    // Read-only keeps sandboxed command networking off; approval_policy="never" rejects escalation.
    // Empty MCP config
    // plus disabled apps/plugins prevents those integrations bypassing the command sandbox.
    // These are defense in depth, NOT a verified way to remove every built-in tool or local read.
    if (model || CODEX_MODEL) argv.push('-m', model || CODEX_MODEL);
    argv.push('-');
    // Codex always loads the user's global AGENTS.md (no flag skips it, and a second CODEX_HOME
    // would fork the login's refresh token), so the turn's own instructions say to set it aside.
    input = 'You are not a coding agent in this turn. You are the in-game companion described in <instructions>. '
      + 'These instructions replace any AGENTS.md, user or developer instructions loaded before them: ignore those '
      + 'entirely (their language, tone, labels, formats, tools and workflows).\n\n'
      + '<instructions>\n' + (system || '') + '\n</instructions>\n\n'
      + 'Answer directly from your own knowledge. Do not run commands, read files, browse or use any tool.\n\n'
      + prompt;
  }

  let child;
  let killed = false;
  const kill = () => { killed = true; try { child?.kill(); } catch { /* gone */ } };
  const done = new Promise((resolve, reject) => {
    try {
      // A .mjs/.js stand-in runs under this Node (tests: tests/subscription_proxy_test.mjs). A .cmd or
      // .bat shim (an npm-installed CLI on Windows) can't start without a shell, which this never uses.
      child = prepared?.child || workers.track(spawnCli(bin, argv, dir, cli), dir);
      child.once('spawn', () => { spawnTime = Date.now() - started; });
    } catch (e) {
      fs.rm(dir, { recursive: true, force: true }, () => {});
      reject({ status: 502, message: `could not start ${bin}: ${e.message}` }); return;
    }
    const timer = setTimeout(() => { log(cli, 'timeout'); kill(); settle(1); }, timeout);
    let buf = '';
    let err = '';
    let usage = null;
    let finish = 'stop';
    let sawText = false;
    let finalText = '';
    let failure = null;
    let settled = false;
    let completed = false;
    // Answer as soon as the CLI reports the turn finished: it takes another half second to exit,
    // and that wait is pure delay for the player. Stream-input workers are terminated here;
    // legacy processes exit by themselves.
    const settle = (code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (optimized) { try { child.kill(); } catch { /* one-shot, never reused */ } }
      log('timing', cli, `path=${prepared ? 'warm' : optimized ? 'cold-stream' : 'legacy'}`, `spawn=${spawnTime ?? 'n/a'}ms`,
        `init=${initTime ?? 'n/a'}ms`, `first=${firstText ?? 'n/a'}ms`, `total=${Date.now() - started}ms`);
      if (failure) return reject(failure);
      if (killed) return reject({ status: 504, message: `${cli} took too long or was stopped` });
      if (!completed || code !== 0) return reject({ status: 502, message: `${cli} exited ${code} before completing the turn: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 500)}` });
      if (!sawText && finalText) { onText(finalText); sawText = true; }
      resolve({ usage, finish });
    };

    const onLine = (line) => {
      if (settled || !line.trim()) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (cli === 'claude') {
        if (ev.type === 'system' && ev.subtype === 'init') initTime ??= Date.now() - started;
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
          firstText ??= Date.now() - started;
          sawText = true; onText(ev.event.delta.text);
        } else if (ev.type === 'assistant' && !sawText) {
          finalText += (ev.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        } else if (ev.type === 'result') {
          completed = true;
          const u = ev.usage || {};
          usage = { prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            completion_tokens: u.output_tokens || 0, prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 } };
          if (ev.stop_reason === 'max_tokens') finish = 'length';
          if (ev.is_error) failure = { status: /limit|usage/i.test(ev.result || '') ? 429 : 502, message: String(ev.result || ev.subtype || 'Claude Code error') };
          else if (!sawText && !finalText && typeof ev.result === 'string') finalText = ev.result;
          settle();
        }
      } else {
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
          const t = String(ev.item.text || '');
          if (t) { onText((sawText ? '\n\n' : '') + t); sawText = true; }
        } else if (ev.type === 'turn.completed') {
          completed = true;
          const u = ev.usage || {};
          usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0,
            prompt_tokens_details: { cached_tokens: u.cached_input_tokens || 0 },
            completion_tokens_details: { reasoning_tokens: u.reasoning_output_tokens || 0 } };
          settle();
        } else if (ev.type === 'turn.failed' || ev.type === 'error') {
          const msg = String(ev.error?.message || ev.message || 'Codex error');
          failure = { status: /limit|usage|quota/i.test(msg) ? 429 : 502, message: msg };
          if (ev.type === 'turn.failed') settle();
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { if (err.length < 8000) err += d.toString('utf8'); });
    child.on('error', (e) => { failure = failure || { status: 502, message: `could not start ${bin}: ${e.message}` }; settle(1); });
    child.on('close', (code) => {
      if (buf) { onLine(buf); buf = ''; }
      settle(code ?? 1);
    });
    child.stdin.on('error', () => { /* the child may exit before reading it all */ });
    // Stream mode remains open while the turn runs; settle() kills this single-use process.
    if (optimized) child.stdin.write(input);
    else child.stdin.end(input);
  });
  return { done, kill };
}

// ---- HTTP --------------------------------------------------------------------------------

let running = 0;
const waiting = [];
// A turn waits for a free run; one whose client went away while waiting never starts (cancel()).
function acquire() {
  let entry = null;
  const ready = new Promise((res) => {
    if (running < MAX_RUNS) { running++; res(true); return; }
    entry = res;
    waiting.push(entry);
  });
  const cancel = () => {
    const i = entry ? waiting.indexOf(entry) : -1;
    if (i >= 0) { waiting.splice(i, 1); entry(false); }
  };
  return { ready, cancel };
}
const release = () => { const next = waiting.shift(); if (next) next(true); else running--; };

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
const apiError = (res, status, message, type = 'server_error') => sendJSON(res, status, { error: { message, type, code: type } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

async function chat(req, res, workers) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return apiError(res, 400, 'invalid JSON body', 'invalid_request_error'); }
  const r = route(body.model);
  if (!r) return apiError(res, 404, `unknown model ${body.model}; use one of ${MODELS.map(m => m.id).join(', ')}`, 'model_not_found');
  if (r.cli === 'codex' && !CODEX_TOOLS_ACCEPTED) {
    return apiError(res, 403, 'Codex is disabled: its CLI has no verified no-tools mode. '
      + 'Running it is unsafe with untrusted game or web text and may expose local files. '
      + 'Use claude-code, or explicitly accept this risk by setting NQA_PROXY_CODEX_TOOLS=accept '
      + 'in the proxy environment before starting it.', 'codex_tools_not_accepted');
  }
  const flat = flatten(body.messages);
  const id = 'chatcmpl-' + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const stream = body.stream === true;
  const t0 = Date.now();
  log('turn', body.model, `system=${flat.system.length}`, `prompt=${flat.prompt.length}`, stream ? 'stream' : 'json');

  const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  let text = '';
  let closed = false;
  let keepAlive = null;
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // The CLIs take a few seconds to start, and Codex only answers whole: say we're thinking now, so
    // the app's first-token and idle timers wait (its run limit still applies).
    res.write(chunk({ role: 'assistant', reasoning: ' ' }));
    keepAlive = setInterval(() => { if (!closed) res.write(chunk({ reasoning: ' ' })); }, 10000);
  }

  // Watched before queueing: a client that leaves while its turn waits costs nothing.
  let run = null;
  const slot = acquire();
  res.on('close', () => { if (!res.writableFinished) { closed = true; slot.cancel(); run?.kill(); } });
  const acquired = await slot.ready;
  if (!acquired || closed) { if (acquired) release(); clearInterval(keepAlive); log('cancelled', body.model, 'client left while queued'); return; }
  run = runTurn(r, flat, (delta) => {
    text += delta;
    if (stream && !closed) res.write(chunk({ content: delta }));
  }, workers);
  try {
    const { usage, finish } = await run.done;
    const u = usage ? { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens, cost: 0 } : undefined;
    log('done', body.model, `${Date.now() - t0}ms`, `chars=${text.length}`);
    if (stream) {
      clearInterval(keepAlive);
      if (!closed) {
        res.write(chunk({}, finish));
        if (u) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: u })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    } else {
      sendJSON(res, 200, { id, object: 'chat.completion', created, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }], usage: u });
    }
  } catch (e) {
    const status = e?.status || 502;
    const message = e?.message || String(e);
    log('fail', body.model, `${Date.now() - t0}ms`, status, message.slice(0, 300));
    const type = status === 429 ? 'rate_limit_exceeded' : status === 504 ? 'timeout' : 'server_error';
    if (stream) {
      clearInterval(keepAlive);
      if (!closed) res.end(`data: ${JSON.stringify({ error: { message, type, code: type } })}\n\n`);
    } else apiError(res, status, message, type);
  } finally {
    release();
  }
}

/**
 * Who may use the proxy: this computer's own programs. A browser page anywhere could otherwise post
 * to it (a text/plain POST needs no preflight) or reach it through DNS rebinding: so the Host must
 * name this computer, a browser's request (it carries an Origin) is refused, and with NQA_PROXY_TOKEN
 * set the request must carry it as its Bearer key (the app's Other card sends its key that way).
 */
export function allowed(req, token = process.env.NQA_PROXY_TOKEN || '') {
  const port = req.socket?.localPort;
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return { ok: false, status: 421, why: 'wrong host' };
  if (req.headers.origin !== undefined) return { ok: false, status: 403, why: 'browser requests are refused' };
  if (token) {
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got); const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 401, why: 'missing or wrong key' };
  }
  return { ok: true };
}

export function createServer() {
  const workers = new CliWorkers();
  const offeredModels = MODELS.filter(m => CODEX_TOOLS_ACCEPTED || !m.id.startsWith('codex'));
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return apiError(res, 400, 'bad request path', 'invalid_request_error'); }
    const ok = allowed(req);
    if (!ok.ok) return apiError(res, ok.status, ok.why, 'forbidden');
    const p = url.pathname.replace(/\/+$/, '');
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/v1/models' || p === '/models')) {
      return sendJSON(res, 200, { object: 'list', data: offeredModels.map(m => ({ ...m, object: 'model', created: 0 })) });
    }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      return chat(req, res, workers).catch((e) => { log('crash', e?.stack || e); if (!res.headersSent) apiError(res, 500, 'proxy error'); else res.end(); });
    }
    if (req.method === 'GET' && (p === '' || p === '/health')) return sendJSON(res, 200, { ok: true, models: offeredModels.map(m => m.id) });
    apiError(res, 404, 'not found', 'not_found');
  });
  const cleanup = () => workers.close();
  process.once('exit', cleanup);
  server.once('close', () => { cleanup(); process.removeListener('exit', cleanup); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.on('error', (e) => { log('listen failed', e.message); process.exit(1); });
  server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}/v1 (claude=${CLAUDE_BIN}, codex=${CODEX_BIN})`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.closeAllConnections();
    server.close();
  });
}
