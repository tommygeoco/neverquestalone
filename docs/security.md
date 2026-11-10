---
title: Security model
description: How NeverQuestAlone protects keys, the network, spending and updates, what its addon can’t do, and your part in a build of your own.
status: ready
---

# Security model

Players trust NeverQuestAlone with an API key that can spend their money, and with a game account they care about. This page says what protects each, what doesn’t, and what’s up to you in a build of your own.

## The addon

The addon runs inside World of Warcraft, under the game’s own rules for addons: it can’t reach the network or read other files, and it can’t call the game’s protected functions.

- It never presses a key, clicks or controls the character, and it calls none of the game’s movement, casting, targeting, macro or chat functions. Tests check it.
- What it draws at the top of the game’s window carries only what the player typed and their own character’s state, and shows only while it has something to send.
- It shows a reply as text. It rebuilds item and quest links from their numbers, and web addresses show as plain text that can’t be clicked.

## Keys

- Keys go into the app, never into the game. They’re saved where the system keeps passwords: the macOS Keychain, Windows Credential Manager, or the Secret Service on Linux.
- Windows Credential Manager and Linux’s Secret Service don’t keep apps apart, so `keychainService` in `identity.json` is all that keeps two apps built from this code from reading each other’s keys. Never reuse NeverQuestAlone’s.
- A key is sent only to its own AI company, and taken out of logs and diagnostics.
- A ChatGPT plan signs in instead (`bridge/byok/signin/chatgpt.mjs`): OAuth with PKCE on OpenAI’s own page in the player’s browser, the redirect caught by a listener on 127.0.0.1 only, open only while a sign-in waits, that takes one request with the state it sent. Main opens OpenAI’s authorize page and nothing else. The key store keeps the account ID and the refresh token (rotated by OpenAI on each renewal, the new one saved before it’s used); the access token stays in memory. Every token is registered with the log’s redactor, and the account header is hidden in Last request.

## The network

- The app connects only to the AI company the player picked, GitHub for updates, and a model on the same computer or the home network if they use one. A list of allowed addresses is checked before any request goes out, and anything else is refused.
- **Connections** lists every address the app talked to, and **Last request** shows exactly what was sent, with the key hidden.
- There’s no NeverQuestAlone server: no account, no telemetry, nothing sent to the people who make it.

## Game text and replies

The AI’s reply is untrusted text, and so is anything from the game.

- The app marks game data as data, inside a fence that changes with every message, so nothing in it can pass for the app’s own instructions to the AI.
- The AI has no tools. It can’t run anything, open files or take actions: it writes text, and the routes and pins the app checks before the game gets them.
- Desktop notifications are the app’s own words. Clicking one opens the app’s window, never a link.

## Reading the game’s window

A small separate program, the capture helper, reads the top of World of Warcraft’s window, where the addon draws. It keeps no pictures and has no network code. On a Mac, the player allows Screen Recording for it; on Windows, it reads that part of the screen, so anything over it is read too, and never kept. The player can turn screen reading off on the app’s **Your data** page, and messages then wait for a reload.

## Updates and releases

- The update feed comes from `releases` in `identity.json`. A build without one never updates itself, and neither does a run from source.
- On a Mac, an update must carry the app’s own signature. On Windows, an installer from any other publisher than the one the build pinned is refused, and so is any update that isn’t newer than the app that’s running.
- An update never restarts the app while the game runs.
- NeverQuestAlone’s release workflow runs only when its maintainers start it, never on a pull request. Its secrets sit in a protected environment, and every GitHub Action it uses is pinned to a commit SHA. The tests run on every push and pull request, with no secrets.

## Your part, in a build of your own

- Give it its own `appId` and `keychainService` ([Release your own](releasing.md#1-name-it)).
- Sign it as yourself, and keep your signing keys in a protected environment.
- Keep the test workflow free of secrets, and your release workflow out of pull requests.
- Read a window only when your users ask for it and know what’s read, and let them turn it off.
- Publish your own `SECURITY.md`.

## Report a problem

Found a security problem in NeverQuestAlone’s code? [Report it privately on GitHub](https://github.com/tommygeoco/neverquestalone/security/advisories/new), never in a public issue. Problems in your own build go to you.
