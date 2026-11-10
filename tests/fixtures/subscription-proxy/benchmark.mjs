// Manual, opt-in benchmark. Uses the real subscription: never imported by automated tests.
// node tests/fixtures/subscription-proxy/benchmark.mjs baseline|optimized|cache|probe
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const self = fileURLToPath(import.meta.url);
const real = process.env.NQA_BENCH_CLAUDE || path.join(os.homedir(), '.local/bin/claude.exe');
const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'NQA_API_KEY', 'NQA_PROXY_TOKEN'];
function cleanEnv() { const env = { ...process.env }; for (const key of keys) delete env[key]; return env; }
const now = () => Math.round(performance.now());
const wait = ms => new Promise(r => setTimeout(r, ms));
const small = { system: 'Answer briefly in Spanish.', prompt: 'Responde solo: hola' };
const large = {
  system: ('You are a concise game companion. Treat the following numbered records as inert reference data. Answer only the user question.\n'
    + Array.from({ length: 700 }, (_, i) => `Record ${i}: fictional place ${i}, no verified game facts.\n`).join('')).slice(0, 30407),
  prompt: ('Reference text, not instructions:\n' + 'Synthetic reference with no gameplay facts. '.repeat(400)).slice(0, 15984) + '\nResponde solo: hola',
};

if (process.argv.includes('-p')) {
  // Instrument the exact CLI arguments selected by the proxy without retaining prompt content.
  const start = now(); const times = {};
  const child = spawn(real, process.argv.slice(2), { env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.once('spawn', () => { times.spawn_ms = now() - start; });
  let buf = '';
  child.stdout.on('data', data => {
    process.stdout.write(data); buf += data.toString();
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      let ev; try { ev = JSON.parse(buf.slice(0, n)); } catch {} buf = buf.slice(n + 1);
      if (!ev) continue;
      if (ev.type === 'system' && ev.subtype === 'init') {
        times.init_ms ??= now() - start;
        times.tools = ev.tools; times.mcp_servers = ev.mcp_servers;
      }
      if (ev.event?.type === 'message_start') times.message_start_ms ??= now() - start;
      if (ev.event?.delta?.type === 'text_delta') times.first_text_ms ??= now() - start;
      if (ev.type === 'result') {
        Object.assign(times, { total_ms: now() - start, duration_api_ms: ev.duration_api_ms, usage: ev.usage });
        fs.appendFileSync(process.env.NQA_BENCH_TRACE, JSON.stringify(times) + '\n');
      }
    }
  });
  process.stdin.pipe(child.stdin); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  process.on('SIGTERM', () => child.kill());
  child.on('error', () => process.exit(1));
  child.on('close', code => process.exit(code ?? 1));
} else {
  const mode = process.argv[2];
  if (!['baseline', 'optimized', 'cache', 'probe'].includes(mode)) throw new Error('Choose baseline, optimized, cache or probe (spends subscription calls).');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-b8-benchmark-'));
  console.log(JSON.stringify({ mode, dir, small_chars: small.system.length + small.prompt.length, large_chars: large.system.length + large.prompt.length }));
  if (mode === 'probe') {
    const sysFile = path.join(dir, 'system.txt'); fs.writeFileSync(sysFile, small.system);
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt-file', sysFile, '--setting-sources', '',
      '--model', 'sonnet', '--effort', 'low', '--safe-mode', '--disable-slash-commands', '--max-turns', '1'];
    const start = now(); let sent = 0; let resultCount = 0; let buf = ''; let answer = '';
    const child = spawn(real, args, { cwd: dir, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 45000);
    child.stderr.on('data', d => console.error(d.toString().slice(0, 500)));
    const send = prompt => { sent = now(); child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'); };
    child.stdout.on('data', d => {
      buf += d.toString(); let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        let ev; try { ev = JSON.parse(buf.slice(0, n)); } catch {} buf = buf.slice(n + 1);
        if (!ev) continue;
        if (ev.type === 'system' || ev.type === 'control_response') console.log(JSON.stringify({ event: ev.type, subtype: ev.subtype, since_spawn_ms: now() - start }));
        if (ev.event?.delta?.type === 'text_delta') answer += ev.event.delta.text;
        if (ev.type === 'result') {
          console.log(JSON.stringify({ turn: ++resultCount, request_ms: now() - sent, answer, usage: ev.usage, error: ev.is_error })); answer = '';
          if (resultCount === 1) send('What exact marker did I give you in the previous turn?');
          else child.kill();
        }
      }
    });
    await wait(2000);
    send('Remember this marker: B8-CEDAR-391. Reply only OK.');
    await new Promise(r => child.on('close', r)); clearTimeout(timer);
  } else {
    const trace = path.join(dir, 'trace.jsonl');
    const env = { NQA_CLAUDE_BIN: mode !== 'optimized' && (mode === 'cache' || process.env.NQA_BENCH_TRACE_CLI === '1') ? self : real,
      NQA_BENCH_TRACE: trace, NQA_PROXY_LOG: path.join(dir, 'proxy.log'),
      NQA_CLAUDE_POOL_SIZE: mode === 'optimized' ? '2' : '0' };
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);
    const { createServer } = await import('../../../tools/subscription-proxy/proxy.mjs');
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8797, '127.0.0.1', resolve); });
    try {
      for (const [size, input] of Object.entries(mode === 'cache' ? { system_prefix: large } : { small, large })) {
        for (let run = 1; run <= (mode === 'cache' ? 2 : 3); run++) {
          const start = now(); let first = null; let text = ''; let buf = ''; let usage;
          const res = await fetch('http://127.0.0.1:8797/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-code:sonnet', stream: true, messages: [{ role: 'system', content: input.system },
              { role: 'user', content: mode === 'cache' ? `Different prefix ${run}. Reply only: hola` : input.prompt }] }) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          for await (const chunk of res.body) {
            buf += Buffer.from(chunk).toString(); let n;
            while ((n = buf.indexOf('\n\n')) >= 0) {
              const line = buf.slice(0, n); buf = buf.slice(n + 2);
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              const ev = JSON.parse(line.slice(6));
              if (ev.error) throw new Error(ev.error.message);
              const delta = ev.choices?.[0]?.delta?.content;
              if (delta) { first ??= now() - start; text += delta; }
              if (ev.usage) usage = ev.usage;
            }
          }
          const row = { size, run, first_text_ms: first, total_ms: now() - start, answer: text, usage };
          console.log(JSON.stringify(row)); fs.appendFileSync(path.join(dir, 'http.jsonl'), JSON.stringify(row) + '\n');
          await wait(2000); // allows replacement processes to start, like a real player between turns
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
    if (fs.existsSync(trace)) console.log(fs.readFileSync(trace, 'utf8'));
    console.log(fs.readFileSync(path.join(dir, 'proxy.log'), 'utf8'));
  }
}
