// A stand-in for the Claude Code and Codex CLIs (tests/subscription_proxy_test.mjs): it reads the
// prompt on stdin and answers in the CLI's own JSON lines, echoing what it was given.
import fs from 'node:fs';
import readline from 'node:readline';
const argv = process.argv.slice(2);
const streaming = argv.includes('--input-format');
const lifecycle = (event, extra = {}) => {
  if (process.env.FAKE_CLI_LIFECYCLE) fs.appendFileSync(process.env.FAKE_CLI_LIFECYCLE, JSON.stringify({ event, pid: process.pid, cwd: process.cwd(), streaming, ...extra }) + '\n');
};
lifecycle('spawn');
process.on('exit', () => lifecycle('exit'));
if (streaming && process.env.FAKE_CLI_STREAM_MODE === 'reject') process.exit(1);
if (streaming && process.env.FAKE_CLI_STREAM_MODE === 'die-idle') setTimeout(() => process.exit(1), 100);
const sys = argv[0] === 'exec' ? '' : fs.readFileSync(argv[argv.indexOf('--system-prompt-file') + 1], 'utf8');
if (process.env.FAKE_CLI_BOOT_MS) await new Promise(r => setTimeout(r, Number(process.env.FAKE_CLI_BOOT_MS)));
let input;
if (streaming) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const ev = JSON.parse(line);
    if (ev.type === 'user') { input = ev.message.content; break; }
  }
} else input = fs.readFileSync(0, 'utf8');
if (input === undefined) process.exit(1);
lifecycle('input', { input, system: sys });
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const env = { anthropic: !!process.env.ANTHROPIC_API_KEY, openai: !!process.env.OPENAI_API_KEY, nqa: !!process.env.NQA_API_KEY };
// Every start is counted in a file the test names, so a turn that never should start can be seen.
if (process.env.FAKE_CLI_STARTS) fs.appendFileSync(process.env.FAKE_CLI_STARTS, input.slice(-40).replace(/\n/g, ' ') + '\n');
if (input.includes('SLOW')) await new Promise(r => setTimeout(r, 1500));
if (input.includes('HANG')) await new Promise(r => setTimeout(r, 10000));
if (streaming && process.env.FAKE_CLI_STREAM_MODE === 'empty') process.exit(0);
if (argv[0] === 'exec') {
  if (input.includes('FAIL')) { out({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }); process.exit(1); }
  out({ type: 'thread.started', thread_id: 't' });
  const context = { cwd: process.cwd(), cd: argv[argv.indexOf('-C') + 1], files: fs.readdirSync(process.cwd()) };
  out({ type: 'item.completed', item: { type: 'agent_message', text: `codex saw ${input.length} chars; args ${argv.join(' ')}; env ${JSON.stringify(env)}; context ${JSON.stringify(context)}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 2 } });
} else {
  if (input.includes('FAIL')) { out({ type: 'result', is_error: true, result: 'You have hit your usage limit' }); process.exit(1); }
  out({ type: 'system', subtype: 'init' });
  for (const part of ['claude ', 'saw ', `system=${sys.length} prompt=${input.length}; args ${argv.filter(a => !a.includes('system')).join(' ')}; env ${JSON.stringify(env)}`]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  }
  if (input.includes('IDENTITY')) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ` identity=${JSON.stringify({ pid: process.pid, input, system: sys })}` } } });
  if (streaming && process.env.FAKE_CLI_STREAM_MODE === 'partial') process.exit(1);
  out({ type: 'result', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 50, cache_read_input_tokens: 10, output_tokens: 5 } });
  if (streaming) {
    // A real stream-json process stays alive waiting for another user turn.
    // Also expose output-after-result bugs in the proxy parser.
    setTimeout(() => { out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'LATE-TEXT-MUST-NOT-ESCAPE' } } }); }, 30);
    await new Promise(r => setTimeout(r, 10000));
  }
}
