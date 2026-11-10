# Optional source-mode voice companion

Talk to the companion, interrupt it and receive spoken answers, captions and validated map pins. The game controls include Talk, microphone, pause/resume, persona, Read and Tips. This is a developer/source-mode contribution; the published desktop installer does not yet start these services for you.

## Requirements

- The modified core and addon from this branch, with game context enabled when you want character-aware answers. `/nqa live on` keeps the snapshot current between written messages.
- Node 22.19 or later and Chrome/Edge on the same computer.
- An OpenAI API key with the necessary Realtime access and billing. Realtime voice is billed separately; a text subscription does not pay for it. Estimates are not invoice guarantees.
- For the default shared-brain mode, a local text service such as `tools/subscription-proxy/proxy.mjs`, configured with the operator's own supported CLI/account. The voice listens/speaks and asks that service for game-content answers using local sourced knowledge.

Only one core may serve an AddOns folder. Quit the installed desktop app before running the source core. On Windows, `tools/voice/run-from-source.ps1` can start the modified core and voice; inspect its switches and provide your own private key file. Addon installation requires WoW fully closed.

To start only the voice service alongside an already running modified core:

```sh
node tools/voice/server.mjs --key-file ~/.config/neverquestalone/api-keys.json --app-data <core-data-folder>
```

Then open `http://localhost:8790`. The key file can hold the key or JSON with an `openai` field; keep it readable only by your account. `OPENAI_API_KEY` is another supported source. Never commit keys or pass them in a command-line argument. The page receives a short-lived client secret, not the permanent key.

## Configuration

`--brain-base` and `--brain-model` select the local text endpoint/model; the defaults are the loopback subscription proxy and `claude-code:sonnet`. `--no-brain` selects the earlier direct-Realtime tool mode. `--app-data` must point to the same data folder as the modified core.

`--persona`, `--voice` and `--lang` select speech behavior. The default language is Spanish, with player-language guidance. `--web` opts into bounded Wowhead tooltips by ID. `--host` accepts loopback only; the microphone needs a secure browser context and the server can spend the key. Do not expose it to a LAN or the public internet.

The source supports several voice/model defaults; availability depends on the account and provider. End-to-end answer time includes transcription, local retrieval, the text backend and speech. Fast initial acknowledgement does not mean the complete answer arrives at the same latency.

## Data and limitations

The service reads the core's privacy-filtered `bridge/companion.json`. Exchanges and pins are placed in individual atomic JSON entries under `bridge/voice-inbox/`, which the modified core publishes once to the Companion chat and validates before drawing. Replies already spoken by Realtime are not repeated through WoW TTS.

The local knowledge layer keeps sourced data separate from player/model statements. Importers do not ship third-party game databases, and imported prices or recipes are not automatically complete/current. Current source-mode crafting support lacks a full learned-recipe/material feed: do not advertise complete profession-profit recommendations. Gathered materials still have opportunity cost; missing quotes and fees remain unknown.

Unit tests use fake accounts/transports: `node --test tests/voice_test.mjs`. The optional `tools/voice/e2e.mjs` uses a recorded question and real APIs and is billed to the operator.
