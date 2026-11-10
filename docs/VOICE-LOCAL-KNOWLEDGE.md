# Voice and local knowledge: source-mode proposal

This branch offers optional companion improvements while preserving NeverQuestAlone's identity and existing API-key setup. It is a draft contribution for upstream review, following the private-import workflow in CONTRIBUTING.md. Existing published installers do not include these changes.

## Included

- Realtime voice with Talk, microphone, pause/resume, persona, Read and Tips controls in game. Spoken exchanges and validated map pins return through the companion inbox.
- More bounded game context: named equipment, bags, aura time remaining, reputation, target/group summaries, quest rewards, durability, talents and hearth information; inventory can be requested on demand.
- Per-chat model selection, with default reset and confirmed/pending state, including models exposed by a custom service.
- A local SQLite knowledge/profile store; source-labelled quest/NPC/item/drop facts and optional cached tooltip data; player statements and model statements remain distinct from sourced facts.
- A read-only importer for the user's local QuestieDB 1.0.13 Forever files, including faction/class variants and dynamic corrections, plus parsers for local Auctionator/Syndicator/RXPGuides saved data. No third-party databases, guide content, credentials or developer runtime state are included in this contribution.
- Compact request paths and single-use prepared Claude workers. Workers are not reused across independent requests; the pool is globally bounded.

## Setup and boundaries

Run the modified core and addon from this checkout; do not run an installed desktop app against the same AddOns folder at the same time. The Windows development launcher is `tools/voice/run-from-source.ps1`; `tools/voice/README.md` and `tools/subscription-proxy/README.md` describe their individual services.

Text can use the app's API providers or the optional local CLI proxy. The proxy is not an official subscription API; the user's own account and CLI terms apply. Claude has an empty tools/MCP/settings configuration. Codex remains blocked unless the operator explicitly accepts its documented tool-access risk. A game request cannot opt the operator in.

Speech requires a separate OpenAI API key and per-use Realtime billing. Keys stay in the local server; the page receives only a short-lived client secret. Both services bind to loopback and reject foreign Host/Origin requests. The voice page requires localhost or another secure browser context.

Game data is optional and governed by the existing privacy settings. The AI cannot move, target, cast, buy, sell, send game chat or inject input. Unknown sources, missing market quotes and unsupported version-specific mechanics must remain explicit. External data keeps its provenance and licensing; the importers do not establish redistribution rights.

## Current limits

- Full one-installer onboarding is still separate work. This branch is intended for developers/source-mode testing first.
- NPC and quest knowledge needs a local source import; no claim is made that the official installer supplies this database automatically.
- Learned crafting recipes and complete profession-profit calculations are not yet captured. Profession ranks can be present while recipe/material data is missing. Gathered materials have opportunity cost; no recipe should be labelled profitable without supported input/output quotes and explicit fees/uncertainty.
- Auction snapshots do not prove future sales or demand. Subscription/model availability and latency vary by CLI, account and machine.
- Source-mode voice and typed chat have separate conversational paths sharing the local knowledge store; the native desktop integration is not claimed complete here.

## Verification

Run `npm ci` and `npm test`. Focused suites include `tests/voice_test.mjs`, `tests/subscription_proxy_test.mjs`, `tests/voice_companion_addon_test.mjs`, the brain suites and `tests/byok/model_selector_test.mjs`. No real account/API calls run in the default suite. The optional voice E2E script uses the operator's account and is billed separately.

Local verification and environment/skipped checks are reported on the PR, for its exact contribution head. Acceptance and attribution follow the maintainer's CONTRIBUTING.md process; this proposal can be split into focused follow-ups.
