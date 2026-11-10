# Subscription proxy

Use a Claude or ChatGPT subscription instead of an API key, for your own play. `proxy.mjs` is a small OpenAI-compatible server on your computer that answers each turn with the Claude Code CLI (`claude -p`, your Claude Pro or Max login) or the Codex CLI (`codex exec`, your ChatGPT login).

Personal use only. Your subscription's own terms apply: don't share or host it for others.

## Start it

```sh
node tools/subscription-proxy/proxy.mjs --port 8787
```

In the NeverQuestAlone app, pick **Other**, then **Connect another AI**:

- Base URL: `http://localhost:8787/v1`
- Key: leave it empty
- Model: one of the ids below

| Model | Uses | Measured reply time (Windows, WoW open, 2026-11-08) |
|---|---|---|
| `codex:gpt-reserve` | Codex, ChatGPT login | about 4.5 s |
| `codex:gpt-6-astra` | Codex, ChatGPT login | about 8 s |
| `codex:gpt-6-luna` | Codex, ChatGPT login, CLI 0.167 or newer (2026-11-09) | about 3.7 s on the short brain turn |
| `codex` | Codex's own default model | about 9 s |
| `claude-code:haiku` | Claude Code | about 2.3 s |
| `claude-code` (Sonnet), `claude-code:opus` | Claude Code | about 7.5 s and up |

`gpt-6-luna` depends on the Codex CLI's version: with a ChatGPT login 0.167.0 answers and 0.153.4 gets "not supported when using Codex with a ChatGPT account" (checked 2026-11-09), so point `NQA_CODEX_BIN` at the newest CLI installed. On the 10 test questions Luna took 2.6-4.4 s through the short brain turn (average 3.7 s) and about 4 s typed, with some turns of 10-22 s. `gpt-6.1-luna` is refused on both CLIs; `gpt-6-sol`, `gpt-6.1-sol` and `gpt-6.1-terra` were refused on 0.153 on 2026-11-08 and not rechecked. Codex also loads the user's global instructions (`AGENTS.md`), which can show up in answers (a `[Cierto]` tag did). With an API key, the app's own Claude or ChatGPT card is faster: it skips starting a CLI for every turn.

**Codex is disabled by default**, including the Codex models listed above. Use `claude-code` unless you explicitly accept the security risk below. The recorded reply times predate this hardening.

## Security: what it does and doesn't

- It listens on `127.0.0.1` only, so nothing else on your network can spend your subscription.
- Claude Code runs with no tools (`--tools ""`), no settings, hooks or MCP servers, and at low effort.
- Codex requests return HTTP 403 (`codex_tools_not_accepted`) before a CLI starts, including streaming requests, unless the proxy starts with exactly `NQA_PROXY_CODEX_TOOLS=accept`. A request cannot opt in for the operator.
- **Opting in is unsafe with untrusted game or web text.** A malicious quest title, chat message or web excerpt can try to make the agent use tools or disclose local files. A prompt saying "do not use tools" is not a security boundary. A scratch working directory does not confine file reads to that directory.
- When opted in, Codex uses a fresh empty scratch directory, `--sandbox read-only` (no writes or network for sandboxed commands), `approval_policy="never"` (no escalation approvals), disabled web search, an empty `mcp_servers` configuration, and disabled apps, plugins, remote plugins, hooks and skill MCP installation. Shell and local image tools are also disabled as defense in depth. User config and execpolicy rules are ignored; strict config parsing rejects unsupported settings. These restrictions are **not a verified no-tools mode** and do not guarantee that all local file access is impossible. Codex can still load global instructions such as `AGENTS.md`.
- Any `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment is removed for the CLI, so it uses your subscription, not API billing.
- The app shows a server on `localhost` as private ("your messages stay on this computer"). With this proxy they go to Anthropic or OpenAI.

### Evidence and explicit opt-in

Checked on 2026-11-08 with installed **codex-cli 0.166.0**: `codex --help`, `codex exec --help` and `codex features list`. Neither help command offers a general no-tools switch. The feature list confirms individual switches such as `shell_tool`, `view_image`, `apps` and `plugins`; their presence does not establish that every tool can be removed. OpenAI's [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents these separate controls and notes that user opt-outs of `unified_exec` are ignored. Its [sandbox documentation](https://learn.chatgpt.com/docs/agent-approvals-security) explicitly describes read-only mode as allowing file reads and command execution. We could not verify a supported zero-tools turn, so the proxy fails closed by default.

Only if you accept that risk, start it from PowerShell with:

```powershell
$env:NQA_PROXY_CODEX_TOOLS = 'accept'
node tools/subscription-proxy/proxy.mjs --port 8787
```

To revoke acceptance, stop the proxy, run `Remove-Item Env:NQA_PROXY_CODEX_TOOLS`, and restart it. Claude Code remains available without this opt-in. Network restrictions apply to agent tools; the CLI still needs to contact OpenAI to answer. Automated proxy tests use a fake CLI and verify refusal and arguments, not real Windows sandbox enforcement or resistance to prompt injection. Prefer Claude's no-tools route for untrusted game text.

| Environment variable | Default | What it does |
|---|---|---|
| `NQA_PROXY_PORT` | `8787` | The port |
| `NQA_CLAUDE_BIN`, `NQA_CODEX_BIN` | `claude`, `codex` | Where the CLIs are |
| `NQA_CLAUDE_EFFORT`, `NQA_CODEX_EFFORT` | `low` | Thinking effort |
| `NQA_CODEX_MODEL` | Codex's own | The model plain `codex` uses |
| `NQA_PROXY_CODEX_TOOLS` | unset (Codex refused) | Exactly `accept` enables the unsafe Codex route; read the security section first |
| `NQA_PROXY_MAX_RUNS` | `2` | Turns at once |
| `NQA_CLAUDE_POOL_SIZE` | `2` | Unused prestarted Claude workers, globally bounded to 0–2; `0` restores the original per-call path |
| `NQA_CLAUDE_IDLE_MS` | `180000` | Unused workers expire after three minutes; accepted range 100–300000 ms |
| `NQA_PROXY_LOG` | the temp folder | Its log file |

## Claude latency and isolation (B8, 2026-11-09)

Claude workers now start ahead of the next request. Each process receives **one user turn only** and is terminated at its result. This is process preparation, not shared conversation history. The pool starts lazily after the first successful turn, keeps at most two unused processes across all models, and matches both the model and a SHA-256 hash of the exact system prompt. A change of system or model starts cold; old unused workers are evicted when replacements are prepared. Active turns still use `NQA_PROXY_MAX_RUNS`. Replacement creation runs after response completion, so it does not add process-start time to the answer.

No warmup question is sent. Unused workers expire without being replaced until a later successful request. Server close, SIGINT/SIGTERM and normal process exit terminate tracked children; scratch directories are removed when children close. An abrupt OS termination (for example Windows `taskkill /F`) cannot run JavaScript cleanup and may leave children or temporary files. Up to two additional idle CLI processes consume memory; set the pool size to `1` or `0` if that cost outweighs the measured benefit.

All original safety arguments and API-key stripping remain. The optimized path also uses `--input-format stream-json --safe-mode --disable-slash-commands --max-turns 1`. It preserves the original system text, user transcript, model and reasoning effort. It does not shorten or omit game facts. The separate app-side prompt reduction is outside B8's proxy-only scope.

Before any text has been emitted, a technical failure retries once through the original isolated text-input path, within the same overall timeout. Optimization is then suspended for 60 seconds. Quota errors, cancelled/expired requests and errors after partial text are **not replayed**: replay could spend more subscription or concatenate two different answers. Such requests return an error instead of falsely completing. A dead idle worker is discarded. `NQA_CLAUDE_POOL_SIZE=0` disables the optimization entirely.

### What the installed CLI permits

Checked installed `%USERPROFILE%\.local\bin\claude.exe`, version **2.1.319**, using `--help`, `-p --help` and subscription calls:

- Streaming input keeps conversation state: a two-turn probe returned the first turn's marker in the second answer. `--max-turns 1` was accepted, but limits the agent loop per user turn; it does **not** erase history between user turns. Therefore workers are never reused after a request.
- `--resume` and `--continue` explicitly restore conversation history. They are unsuitable for independent HTTP requests and conflict with the route's `--no-session-persistence` policy. They were not exercised against personal sessions.
- `--strict-mcp-config`, empty `--setting-sources`, `--no-session-persistence` and empty `--tools` already existed. `--safe-mode` additionally disables custom hooks/plugins/skills and discovery without discarding subscription authentication; `--disable-slash-commands` blocks prompt-triggered skills. No MCP configuration needs to be supplied when strict mode has none. Real diagnostic init events reported `tools: []` and `mcp_servers: []`.
- `--bare` skips more startup work but explicitly disables OAuth/keychain authentication. It requires an API key or key helper, so it was rejected for this subscription-only route.
- Prompt caching already works across fresh processes. The repeated large input read **16,811 cached tokens** on calls 2 and 3. Changing the user question while keeping the 30,407-character system prefix reused **10,767 tokens** in two additional fresh processes. Caching is provider-managed; the pool neither caches answers nor transfers request text between sessions. Small inputs showed zero cache reads.

References: [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [streaming input and context persistence](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). Installed help and measured behavior take precedence over flags missing from an older published reference.

### Measurements

Windows, Node 24, `claude-code:sonnet`, unchanged `low` effort, loopback HTTP on **8797**. The installed proxy on **8787**, its files and scheduled task were not restarted or replaced. Inputs are reproducible synthetic text: small = 26-character system + 19-character user prompt; large = **30,407 + 16,004 = 46,411 ASCII bytes**. Each asks for `hola`, so this measures startup/input latency without confounding long answer generation. There are two seconds between requests. All answers were `hola` (occasionally capitalized).

Initial six-call diagnostic, before proxy changes (milliseconds, measured at the real CLI boundary):

| Input / run | OS spawn | CLI init event | First text | Result |
|---|---:|---:|---:|---:|
| Small 1 | 8 | 406 | 985 | 1307 |
| Small 2 | 12 | 476 | 1368 | 1383 |
| Small 3 | 8 | 410 | 1204 | 1225 |
| Large 1 | 10 | 413 | 1242 | 1252 |
| Large 2 | 9 | 423 | 1379 | 1396 |
| Large 3 | 9 | 420 | 1356 | 1370 |

OS spawn is included in init, and init is included in first text: **do not add the columns**. Init-to-first-text was 579–956 ms (network + provider processing, not a pure model-only timer). The CLI exposes first model stream/text arrival, not an exact server inference-start timestamp. Its `duration_api_ms` did not consistently match wall-clock boundaries, so it is retained in raw diagnostics but not used to partition latency. The diagnostic Node forwarding wrapper added about 40–70 ms at HTTP; it is absent from both final comparison paths below.

Final controlled comparison, exact same prompts, original flags with pool disabled versus the final optimized implementation, milliseconds at HTTP. Both large batches had 16,811 cached tokens. Optimized run 1 for each system is **cold**; runs 2–3 use unused prestarted workers. The legacy comparison was repeated after implementation to remove the diagnostic wrapper from both paths.

| Input / run | Original first text | Original total | Optimized first text | Optimized total |
|---|---:|---:|---:|---:|
| Small 1 | 1443 | 1459 | 1279 | 1309 |
| Small 2 | 1796 | 1805 | 860 | 884 |
| Small 3 | 1404 | 1415 | 906 | 935 |
| Large 1 | 1288 | 1305 | 1429 | 1460 |
| Large 2 | 1266 | 1279 | 1016 | 1080 |
| Large 3 | 1337 | 1347 | 1001 | 1044 |

Prepared workers reached init **31–61 ms after dispatch**, compared with the initial 406–476 ms cold startup. Final legacy small run 2 had an OS-spawn outlier of **493 ms** and init at 900 ms; the other final legacy spawns were 8–10 ms. The pool removes startup from the request's critical path but does not make it free. With three samples per input, network/scheduling variation is material: the cold large optimized call was slower. Do not interpret this as a guarantee or extrapolate `hola` results to real gameplay. Existing installed-proxy logs also showed 8–16-second replies of 815–1,432 characters; B8 has not established how much of those longer calls is reasoning versus text generation. The ten real game-question accuracy/latency trials belong to the coordinating task.

28 real subscription calls total: 6 initial diagnostics, 2 history probe, 6 first optimized measurement, 2 system-prefix cache probe, 6 final optimized measurement, 6 unwrapped legacy control. Idle preparation sends no model requests. Raw timing files were written only to task-specific temporary directories, with no private prompt content: `nqa-b8-benchmark-xLvuGs` (initial), `nqa-b8-benchmark-Qjqdpa` (system cache), `nqa-b8-benchmark-2Eb3ID` (final optimized), `nqa-b8-benchmark-AD7J2y` (legacy control), under the user's temp directory.

Reproduce manually (these commands spend subscription calls; the automated tests do not):

```powershell
node tests/fixtures/subscription-proxy/benchmark.mjs baseline
node tests/fixtures/subscription-proxy/benchmark.mjs optimized
# Optional two-call probes:
node tests/fixtures/subscription-proxy/benchmark.mjs cache
node tests/fixtures/subscription-proxy/benchmark.mjs probe
```

The benchmark binds only 8797, fails if that port is occupied, closes its own server and workers, and never reads the app's API-key file. It uses the installed native CLI by default; `NQA_BENCH_CLAUDE` can specify another executable. `NQA_BENCH_TRACE_CLI=1` adds detailed child-event diagnostics to the baseline only; that wrapper adds latency and is unsuitable for the warm pool.

Validation: `node --test tests/subscription_proxy_test.mjs` uses only the fake CLI. Tests cover original restrictions, zero-tool flags and stripped keys, one process per request, distinct system prompts and models, concurrent requests, lazy preparation without dummy turns, the global bound, idle expiry, server-close cleanup including scratch files, dead idle workers, legacy fallback/cooldown, disabled pooling, quota errors, partial-result failures, timeout, active cancellation and queued cancellation. Full repository/game/voice tests are outside this task's file scope; do not treat these proxy tests as in-game quality verification.
