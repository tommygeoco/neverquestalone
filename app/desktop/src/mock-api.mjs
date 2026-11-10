// A stand-in for bridge/byok/app-api.mjs (BUILD-PLAN "Contract: the app API
// the desktop shell calls") with fake data, so the shell can be built, tested
// and self-tested before the real bridge lands. Selected by NQA_MOCK_API=1,
// by --self-test, or while app-api.mjs doesn't exist yet.
//
// It touches nothing: no files, no network, no keychain, no WoW folder. Keys
// are kept only as masks. A few strings are deliberately hostile (markup in a
// memory note and in a request) so the self-test can prove the window renders
// untrusted text as text.
//
// createMockApi({ controllable: true }) adds api.control for the screenshot
// mode (src/screenshots.mjs, development runs only): reset(patch) puts the
// fake bridge in a given state (keys, provider, spend, the player's daily spend
// limit, the runaway fuse, WoW, capture, the model notice, a forced status or
// call result), and hold(call) keeps a call pending
// until the returned release() runs, so "Checking…" can be seen. wrapApi never
// passes control on to the window.
import { maskKey } from './redact.mjs';
import { importBridge } from './bridge-module.mjs';

// The one vocabulary (bridge/byok/status-view.mjs), as the real status() carries it.
const { statusView } = await importBridge('bridge/byok/status-view.mjs');
// Setup's words for each AI (the manifests' display blocks), as the real providers() carries them.
const { loadManifests, checkCustomUrl, effortLevels, nearestEffort, startThinkRoom, THINK_ROOM, retiringOf } = await importBridge('bridge/byok/providers/index.mjs');
const { displayOf } = await importBridge('bridge/byok/providers/display.mjs');
const { createPriceBook } = await importBridge('bridge/byok/usage/prices.mjs');
const { typicalCost } = await importBridge('bridge/byok/usage/meter.mjs');
const MANIFESTS = loadManifests();
const DISPLAY = Object.fromEntries(MANIFESTS.map(m => [m.id, displayOf(m)]));

const DAY_MS = 24 * 3600 * 1000;

// Every model an AI offers, as the real providers() lists them (bridge/byok/app-api.mjs modelsOf):
// the manifests' lineups, newest first, their thinking levels, and each one's typical cost from the
// bundled price table (usage/meter.mjs typicalCost: a reply cached to uncached, a day at 40, with the
// model's thinking at its start level).
const PRICES = createPriceBook();
function manifestModels(id) {
  const m = MANIFESTS.find(x => x.id === id);
  return (m?.models?.list ?? []).map(e => ({
    id: e.id, name: e.label || e.id,
    tier: e.id === m.models.default ? 'default' : e.id === m.models.smarter ? 'smarter' : 'other',
    effort: e.effort === true, efforts: e.effort === true ? effortLevels(m, e.id) : [],
    priceHint: typicalCost(PRICES.priceFor(id, e.id, Date.now()), { thinkRoom: startThinkRoom(m, e.id) }),
    levelDays: e.effort === true ? Object.fromEntries(effortLevels(m, e.id).map(l => [l, typicalCost(PRICES.priceFor(id, e.id, Date.now()), { thinkRoom: THINK_ROOM[l] ?? 0 }).dayUsd])) : undefined,
    costRank: Number.isInteger(e.costRank) ? e.costRank : null, older: typeof e.replacedBy === 'string',
  }));
}

const PROVIDERS = [
  {
    id: 'anthropic', name: 'Anthropic', hidden: false, auth: 'key', keyPrefixes: ['sk-ant-'],
    models: manifestModels('anthropic'),
    notes: ['A Claude Pro or Max subscription isn’t an API key and doesn’t include API credit.', 'New Console accounts get a small starter credit.'],
    privacyCard: { short: 'Keeps messages 30 days or more; no training unless you send feedback.', keeps: 'Deleted within 30 days by default; longer on some newer models. Flagged content is kept up to 2 years.', trains: 'No, unless you send Anthropic feedback.', zeroRetention: 'By arrangement with Anthropic’s sales team.', sets: 'Nothing extra.', link: 'anthropic.privacy', class: 'cloud-no-train' },
    terms: { link: 'anthropic.terms' },
  },
  {
    id: 'openai', name: 'OpenAI', hidden: false, auth: 'key', keyPrefixes: ['sk-proj-', 'sk-'],
    models: manifestModels('openai'),
    notes: ['Use a normal API key. Admin keys can’t be used here.'],
    privacyCard: { short: 'Keeps abuse logs up to 30 days; no training by default.', keeps: 'Abuse logs up to 30 days.', trains: 'No, unless your OpenAI organization turned on data sharing. You can check that in your OpenAI account.', zeroRetention: 'By OpenAI’s approval.', sets: 'Asks OpenAI to keep nothing beyond its abuse logs, and sends a random ID for this install.', link: 'openai.privacy', class: 'cloud-no-train' },
    terms: { link: 'openai.terms' },
  },
  // A plan that signs in (chatgpt.json): no key, no price per reply.
  {
    id: 'chatgpt', name: 'ChatGPT', hidden: false, auth: 'signin', keyPrefixes: [],
    models: manifestModels('chatgpt').map(m => ({ ...m, priceHint: { plan: true }, levelDays: undefined })),
    notes: ['Uses your ChatGPT plan instead of an API key, with no charge per reply.', 'Replies count toward your plan’s usage limits, which reset every few hours.'],
    privacyCard: { short: 'Follows your ChatGPT data controls; uses your plan’s limits.', keeps: 'What ChatGPT keeps for your account. You can check it in ChatGPT’s data controls.', trains: 'Only if Improve the model for everyone is on in your ChatGPT settings.', zeroRetention: '', sets: 'Asks OpenAI not to store the replies.', link: 'chatgpt.privacy', class: 'cloud' },
    terms: { link: 'chatgpt.terms' },
  },
  {
    id: 'xai', name: 'xAI', hidden: false, auth: 'key', keyPrefixes: ['xai-'],
    models: manifestModels('xai'),
    notes: ['xAI charges $0.05 for each request it refuses under its usage rules.'],
    privacyCard: { short: 'Keeps messages 30 days, encrypted; no training without your permission.', keeps: 'Stored 30 days, encrypted, to check for abuse, then deleted.', trains: 'Not without your permission.', zeroRetention: 'A team-wide switch in the xAI console.', sets: 'Asks xAI to keep nothing beyond its 30-day abuse check.', link: 'xai.privacy', class: 'cloud-no-train' },
    terms: { link: 'xai.terms' },
  },
  {
    id: 'google', name: 'Google', hidden: false, auth: 'key', keyPrefixes: ['AQ.', 'AIza'],
    models: manifestModels('google'),
    notes: ['Google’s terms for its API say you must be 18 or older.', 'A Gemini app subscription isn’t an API key and doesn’t include API credit.'],
    privacyCard: { short: 'Keeps messages up to 55 days; may train on them before billing.', keeps: 'Kept up to 55 days to check for abuse. On Google’s free tier, people at Google may read your messages.', trains: 'Not on the paid tier. The free tier’s messages may be used to improve Google’s products.', zeroRetention: '', sets: 'Nothing extra.', link: 'google.privacy', class: 'cloud' },
    terms: { link: 'google.terms' },
  },
  // Other (custom): its service, model and whether it's this computer come from the mock's state
  // (s.custom), as the real providers() builds them from the player's settings.
  {
    id: 'custom', name: 'Other', hidden: false, auth: 'custom', models: [],
    notes: ['Works with OpenRouter, Groq, Together, Ollama, LM Studio and other OpenAI-compatible services.'],
    privacyCard: { short: '', keeps: 'Up to the service you connect. Check its privacy policy.', trains: 'Up to the service you connect.', zeroRetention: '', sets: 'Nothing extra.', link: 'custom.privacy', class: 'cloud' },
    terms: { link: null },
  },
];
/** Other's privacy card when its service is on this computer (custom.json privacy.local). */
const CUSTOM_LOCAL_CARD = { short: '', keeps: 'Your messages stay on this {os:Mac}.', trains: 'No.', zeroRetention: '', sets: 'Nothing to set.', link: 'custom.privacy', class: 'local' };

const clone = v => JSON.parse(JSON.stringify(v));

const initialState = () => ({
  keys: new Map(),            // provider → { masked, state }
  choice: null,               // { provider, model, effort }
  caps: { dailyUsd: null },   // the player's own daily spend limit: none until they set one (no limits of ours)
  privacy: { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: true },
  paused: false,
  spentMicros: 180_000, turns: 12, autoTurns: 3,
  fuse: false,                // the check-ins fuse holds (usage.autoPaused, usage.fuse: {turns, windowMs}); true: the minute window
  sendingPaused: null,        // the typed guard holds: {turns, windowMs} (backend.sendingPaused), until resumeSending
  addonInstalled: false,
  addonDirs: [],              // installs the addon was put in (installAddon)
  wowChosen: null,            // the install "Choose folder…" found
  memoryChars: ['Thokk-Testrealm', 'Brakka-Testrealm'],
  transcripts: 14,
  wow: { found: true, running: false }, // route: the map's route ({next, stops, title}, CL-design-41); installs: [{path, addon?, version?}] for several; chosen: what "Choose folder…" finds; patch: a new WoW's update ({to, restart, failed?}, SY-29)
  capture: null,              // a capture block to report instead of the default
  notice: null,               // backend.notice (the model check, §10)
  retiring: false,            // true: a retiring model in use is said from the manifest (retiresAfter, moveTo), as app-api's status does (SY-102-5)
  rt: null,                   // a forced backend.rt (the §10 states)
  held: false,                // today's spend couldn't be read with a limit set (code health BR-09): rt cap with reason load_error and usage.held, until setCaps
  writeError: null,           // a write the disk refused (code health BR-11): status().store.writeError, {file, code, at, diskFull}
  lastError: null,            // the backend's last failure ({kind, at}), shown through the real lastErrorView
  results: {},                // call → a forced result (testKey, connectCustom, installAddon, caps)
  permissions: null,          // the AddOns folder's permissions check an install reports (TH12, L3-5)
  noSid: false,               // Windows: this account's SID couldn't be read (no command, D-37)
  safetyIdRegens: 0,          // OpenAI's per-install safety identifier, regenerated (L5-6)
  blocked: [],                // Connections: refused rows
  keysPersistent: true,       // false: boot's memory key store (no Secret Service, or no Credential Manager)
  terms: null,                // {provider: version} recorded; null: every saved key's AI (they were saved through setup)
  keyState: {},               // provider → 'no_credit' (a first key saved while its account had no credit, T1)
  creditLanded: false,        // credit added at the AI company: a no-credit key's next test passes (the bridge learns it only then)
  setup: null,                // a patch over status().setup (the rows' facts: permission, hello, first reply, …)
  addonState: null,           // row 1's state when a scene names it (armed, eperm, older, …)
  addonUpdate: false,         // the failed install was an update of an older addon (the real bridge's setupView update)
  hidden: [],                 // providers hidden by the data file
  extraModels: {},            // provider → more model entries than its list (a longer list, as the data files will carry)
  smarter: {},                // provider → the model a data file names smarter (UX-W33's tags; beside the manifests' own)
  custom: null,               // Other's service: {baseUrl, model} (connectCustom), as byok.custom
  armed: null,                // an install armed for when WoW closes: its path
  permission: null,           // Screen Recording: 'not_asked' | 'asked' | 'denied' | 'granted' (macOS)
});

export function createMockApi({ now = Date.now, platform = process.platform, delayMs = 120, controllable = false } = {}) {
  const listeners = new Set();
  let s = initialState();
  // The real manifests' player text (the screenshot mode loads it: bridge/byok/app-api.mjs playerCard), by provider.
  let playerText = null;
  // The bridge's own lastErrorView (app-api.mjs), which turns the backend's last failure into the window's card.
  let lastErrorView = null;
  const holds = new Map();
  let generation = 0;
  // A held call released by a reset (the next scene) stops there: it never writes into the new state.
  const gate = async (name) => {
    const h = holds.get(name);
    if (!h) return;
    const gen = generation;
    await h.promise;
    if (gen !== generation) throw new Error('reset while held');
  };
  const forced = name => (Object.hasOwn(s.results, name) ? clone(s.results[name]) : undefined);
  const wait = (ms = delayMs) => (delayMs === 0 ? Promise.resolve() : new Promise(r => setTimeout(r, ms)));
  /** Other's service as the bridge sees it: its address checked, its host, its model, whether it's this computer. */
  const customNow = () => {
    const c = s.custom ? checkCustomUrl(s.custom.baseUrl) : { ok: false };
    return c.ok ? { baseUrl: c.baseUrl, host: new URL(c.baseUrl).host, model: s.custom.model, local: c.local } : null;
  };
  /** A provider as the bridge lists it: Other with its service's name, model and local flag. */
  const find = (id) => {
    const p0 = PROVIDERS.find(x => x.id === id);
    // More models than the data files carry today (a scene or test of a longer list): appended.
    const p = p0 && Array.isArray(s.extraModels?.[id]) ? { ...p0, models: [...p0.models, ...s.extraModels[id]] } : p0;
    if (!p || p.id !== 'custom') return p;
    const c = customNow();
    if (!c) return p;
    return { ...p, name: c.host, local: c.local, models: [{ id: c.model, name: c.model, tier: 'default', effort: false, ...(c.local ? { priceHint: { local: true } } : {}) }], privacyCard: c.local ? CUSTOM_LOCAL_CARD : p.privacyCard };
  };
  const isLocalP = p => p?.auth === 'local' || (p?.auth === 'custom' && p.local === true);
  const modelOf = (p, id) => p?.models.find(m => m.id === id) ?? p?.models[0];

  function rtState() {
    if (s.rt?.state) return s.rt.state;
    if (s.paused) return 'paused';
    if (!s.choice) return 'no_key';
    const p = find(s.choice.provider);
    // Other's key is optional: the service it names decides (a key it rejected is rejected all the same).
    if (!isLocalP(p)) {
      const k = s.keys.get(p.id);
      if (!k && p.auth !== 'custom') return 'no_key';
      if (k?.state === 'invalid') return 'key_invalid';
    }
    if (heldNow()) return 'cap';
    if (!isLocalP(p) && capMicros() != null && s.spentMicros >= capMicros()) return 'cap';
    return 'ready';
  }
  /** The limit held as reached because today's spend couldn't be read (BR-09): only with a limit, never for a free model. */
  function heldNow() {
    return !!s.held && !!s.choice && capMicros() != null && !isLocalP(find(s.choice.provider));
  }
  /** backend.rt: a forced one, else the state, with the bridge's reason for a held limit. */
  function rtBlock() {
    if (s.rt) return { ...s.rt };
    const state = rtState();
    return state === 'cap' && heldNow() ? { state, reason: 'load_error' } : { state };
  }
  function providerBlock() {
    if (!s.choice) return null;
    const p = find(s.choice.provider);
    const m = modelOf(p, s.choice.model);
    const k = s.keys.get(p.id);
    return {
      id: p.id, name: p.name, model: m.id, modelName: m.name, effort: s.choice.effort, effortSupported: !!m.effort,
      ...(m.efforts?.length ? { efforts: m.efforts.join(' ') } : {}),
      auth: isLocalP(p) ? 'local' : p.auth === 'custom' ? 'key' : p.auth, keyState: isLocalP(p) || p.auth === 'custom' ? (k && k.state === 'invalid' ? 'invalid' : 'ok') : (k ? (k.state === 'invalid' ? 'invalid' : s.keyState[p.id] === 'no_credit' ? 'no_credit' : 'ok') : 'missing'),
      privacy: p.privacyCard.class, product: 'NeverQuestAlone', companion: s.companion ?? 'NeverQuestAlone',
    };
  }
  /** The player's daily spend limit in micro-dollars, or null: none (the default). */
  function capMicros() {
    return typeof s.caps?.dailyUsd === 'number' ? Math.round(s.caps.dailyUsd * 1e6) : null;
  }
  /** The real usage block's shape (bridge/byok/usage/caps.mjs snapshot): capMicros only with a limit set. */
  function usageBlock() {
    const p = s.choice ? find(s.choice.provider) : null;
    const cap = capMicros();
    const local = isLocalP(p);
    const needs = !p ? null : rtState() === 'cap' ? 'cap' : !local && cap != null && cap > 0 && s.spentMicros >= cap * 0.8 ? 'near_cap' : null;
    // Held (BR-09): the day counts as at the limit, and says why, as the caps snapshot does.
    const held = heldNow();
    const out = {
      day: new Date(now()).toISOString().slice(0, 10), spentMicros: local ? 0 : held ? Math.max(s.spentMicros, cap) : s.spentMicros, ...(cap != null ? { capMicros: cap } : {}),
      turns: s.turns, auto: s.autoTurns, exact: false, needs, ...(held ? { held: 'load_error' } : {}),
    };
    if (s.fuse) Object.assign(out, { autoPaused: true, fuse: s.fuse === true ? { turns: 10, windowMs: 60_000 } : { ...s.fuse } });
    return out;
  }
  const wowPath = () => (platform === 'win32' ? 'C:\\Program Files (x86)\\World of Warcraft\\_forever_' : '/Applications/World of Warcraft/_forever_');
  /** The installs findWow sees: the one default, several (wow.installs), plus one chosen with "Choose folder…". */
  function installs() {
    if (!s.wow.found && !s.wowChosen) return [];
    const list = s.wow.found ? (Array.isArray(s.wow.installs) && s.wow.installs.length ? s.wow.installs.map(w => ({ ...w })) : [{ path: wowPath(), addon: s.addonInstalled }]) : [];
    if (s.wowChosen && !list.some(w => w.path === s.wowChosen.path)) list.push({ ...s.wowChosen });
    return list.map(w => ({ ...w, addon: !!(w.addon || s.addonDirs.includes(w.path)) }));
  }
  /** A passing test for the provider in use: what the player fixed is fixed (backend clearAfterTest). */
  function clearAfterTest(provider) {
    if (s.choice?.provider !== provider) return;
    let any = false;
    if (s.lastError) { s.lastError = null; any = true; }
    if (s.rt && ['out_of_credit', 'provider_down', 'local_down'].includes(s.rt.state)) { s.rt = null; any = true; }
    if (any) changed();
  }
  /** The permissions check with the administrator's command (bridge/byok/app-api.mjs adminCommand's shape). */
  function permissionsWithCommand(p) {
    if (!p) return { ok: true, fixable: false, fixed: [], paths: [], detail: '', command: null, explanation: null };
    const q = x => `'${x.replace(/'/g, `'\\''`)}'`;
    if (p.ok !== false || !p.paths?.length) return { ...clone(p), command: null, explanation: null };
    if (platform === 'win32') {
      // No SID read (whoami failed): no command, only what to ask for (bridge/byok/app-api.mjs adminCommand).
      if (s.noSid) return { ...clone(p), command: null, explanation: 'Ask an administrator to remove write access for Users from this folder.' };
      return { ...clone(p), command: `icacls "${p.paths[0]}" /inheritance:d /grant:r *S-1-5-32-545:(OI)(CI)RX *S-1-5-21-1004336348-1177238915-682003330-1001:(OI)(CI)M`, explanation: 'Stops other accounts from changing the AddOns folder; yours still can.' };
    }
    return { ...clone(p), command: `sudo chmod go-w ${p.paths.map(q).join(' ')}`, explanation: 'Stops other accounts from changing these folders; nothing else changes.' };
  }
  /** A 1-line §10 failure the desktop way (bridge/byok/app-api.mjs desktopLine), for the mock's own errors. */
  const fail = (error, headline, detail, action) => ({ ok: false, error, headline, detail, action, line: `${headline} ${detail}` });
  function keyTest(p, key, context = null) {
    const setup = context === 'setup';
    if (/BADKEY/.test(key)) return setup ? { ok: false, error: 'auth_invalid', documented: false, inferred: false, tier: false } : fail('auth_invalid', `Your ${p.name} key was rejected.`, `Replace your key, or make a new one at ${p.name}.`, 'replace_key');
    if (/NOCREDIT/.test(key)) return setup ? { ok: false, error: 'out_of_credit', documented: p.id !== 'xai', inferred: p.id === 'xai', tier: false } : fail('out_of_credit', `Your ${p.name} account is out of credit.`, `Add credit at ${p.name}, then click Test key.`, 'add_credit');
    return { ok: true, models: p.models.map(m => m.id), testCall: { ok: true, usage: { input: 9, output: 1 }, micros: 14 } };
  }
  /** The terms are recorded for an AI: explicitly (s.terms), or, by default, for every AI with a saved key. */
  function termsRecorded(id) {
    if (s.terms && typeof s.terms === 'object') return Number(s.terms[id]) >= 1;
    return s.keys.has(id);
  }
  /** status().setup, as the real setupView builds it: the mock's facts, then a scene's patch. */
  function setupBlock() {
    const list = installs();
    const wowIn = list.find(w => w.path === (s.current ?? s.wowChosen?.path ?? wowPath())) ?? list[0] ?? null;
    let state = s.addonState;
    if (!state) {
      if (s.armed) state = 'armed';
      else if (!list.length) state = 'not_found';
      else if (list.length > 1 && !s.wowChosen && !s.current && !list.some(w => w.addon)) state = 'choose';
      else if (wowIn?.addon) state = 'current';
      else state = s.wow.running ? 'running' : 'found';
    }
    const base = {
      addon: { state, path: s.armed ?? wowIn?.path ?? null, candidates: list.map(w => ({ path: w.path, ...(w.version ? { version: w.version } : {}), addon: !!w.addon })), admin: null, othersCanWrite: state === 'current' && s.othersCanWrite ? true : null, ...(['eperm', 'disk_full', 'failed', 'race'].includes(state) ? { update: !!s.addonUpdate } : {}) },
      permission: platform === 'darwin' ? (s.permission ?? 'not_asked') : 'n/a',
      launcher: true,
      game: { running: !!s.wow.running, hello: null, ifaceMismatch: false, facts: { permission: platform === 'darwin' ? s.permission === 'granted' : null, window: false, frames: 0, decoded: 0, typedError: null } },
      captureState: 'unknown',
      firstMsgAt: null, firstReplyAt: null, firstReplyBefore: false, firstWords: null,
    };
    const out = merge(base, s.setup);
    // The app's Screen Reading switch off: nothing to allow, as the real view says (setup-view captureStateOf).
    if (s.privacy?.screenReading === false) out.captureState = 'off';
    return out;
  }
  function merge(a, b) {
    if (b == null) return a;
    if (typeof b !== 'object' || Array.isArray(b)) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
    return out;
  }
  function status() {
    const out = {
      mock: true,
      bridge: { version: '0.0.0-mock', running: true, paused: s.paused },
      backend: { rt: rtBlock(), provider: providerBlock(), usage: usageBlock() },
      // The app's Screen Reading switch off: no helper, so 'off' by the reload path (app-api captureView).
      capture: s.capture ? clone(s.capture) : s.privacy?.screenReading === false ? {
        state: 'off', mode: 'reload', signals: 'sound_off',
        steps: { game: true, strip: false, message: true, reply: true },
      } : {
        state: 'ok', mode: 'capture', signals: 'sound_off',
        steps: { game: true, strip: true, message: true, reply: true },
      },
      wow: s.wow.found
        ? { found: true, path: wowPath(), running: !!s.wow.running, combat: false, addon: s.addonInstalled || s.addonDirs.length > 0, ...(s.wow.patch ? { patch: clone(s.wow.patch) } : {}), ...(s.wow.route ? { route: clone(s.wow.route) } : {}) }
        : { found: false, running: !!s.wow.running, combat: false, addon: false },
      keys: { persistent: s.keysPersistent !== false },
      setup: setupBlock(),
    };
    // With the models' names from the provider's list, as the bridge's status carries them (app-api namedNotice).
    // Without one, a retiring model in use, from the real manifest (scenes that set retiring), as app-api says it.
    const retiring = !s.notice && s.retiring && s.choice ? retiringOf(MANIFESTS.find(m => m.id === s.choice.provider), s.choice.model) : null;
    if (s.notice || retiring) {
      const n = s.notice ? clone(s.notice) : { kind: 'model_retiring', ...retiring, at: null };
      const label = id => { const m = find(s.choice?.provider)?.models.find(x => x.id === id); return m && m.name !== id ? m.name : null; };
      if (n.kind === 'model_switched') { if (label(n.from)) n.fromName = label(n.from); if (label(n.to)) n.toName = label(n.to); }
      if (n.kind === 'model_retired' && label(n.model)) n.name = label(n.model);
      if (n.kind === 'model_retiring') { if (label(n.model)) n.name = label(n.model); if (label(n.to)) n.toName = label(n.to); }
      out.backend.notice = n;
    }
    if (s.sendingPaused) out.backend.sendingPaused = { turns: 20, windowMs: 60_000, ...clone(s.sendingPaused) };
    if (s.writeError) out.store = { writeError: clone(s.writeError) };
    if (s.lastError && lastErrorView) {
      const pb = out.backend.provider;
      const le = lastErrorView(s.lastError, { provider: pb?.name, model: pb?.modelName, companion: 'NeverQuestAlone', platform });
      if (le) out.backend.lastError = le;
    }
    out.view = statusView(out, { platform });
    return out;
  }
  const changed = () => { const st = status(); for (const cb of listeners) { try { cb(clone(st)); } catch {} } };

  const api = {
    mock: true,
    async status() { return clone(status()); },
    async providers() {
      return clone(PROVIDERS.map(x => find(x.id)).map(p => {
        const display = { ...(playerText?.[p.id]?.display ?? DISPLAY[p.id] ?? {}) };
        const k = s.keys.get(p.id);
        if (p.auth === 'custom') {
          // As app-api providers(): Other's service ({baseUrl, host, model, local}), no terms of ours.
          return { ...p, hidden: s.hidden.includes(p.id), local: !!p.local, custom: customNow(), display, terms: { link: null, recorded: true }, key: k ? { saved: true, ...k } : { saved: false } };
        }
        return {
          ...p,
          hidden: s.hidden.includes(p.id),
          ...(s.smarter?.[p.id] ? { models: p.models.map(m => ({ ...m, tier: m.id === s.smarter[p.id] ? 'smarter' : m.tier })) } : {}),
          ...(playerText?.[p.id] ? { privacyCard: { ...p.privacyCard, ...playerText[p.id].privacyCard }, notes: playerText[p.id].notes } : {}),
          display,
          terms: { ...p.terms, recorded: p.auth === 'local' || termsRecorded(p.id) },
          key: p.auth === 'local' ? null : (k ? { saved: true, ...k, state: s.keyState[p.id] === 'no_credit' ? 'no_credit' : k.state } : { saved: false }),
        };
      }));
    },
    async setKey(provider, key) {
      await wait();
      s.keys.set(provider, { masked: maskKey(key), state: /BADKEY/.test(key) ? 'invalid' : /NOCREDIT/.test(key) ? 'nocredit' : 'ok' });
      if (!s.choice || s.choice.provider !== provider) s.choice = { provider, model: find(provider).models[0].id, effort: 'low' };
      changed();
      return { ok: true, masked: maskKey(key) };
    },
    async testKey(provider) {
      await wait(300);
      await gate('testKey');
      const f = forced('testKey');
      if (f) return f;
      const p = find(provider);
      if (p.auth === 'custom') {
        if (!customNow()) return fail('no_key', 'Other isn’t set up yet.', 'Connect a service first.', 'add_key');
        clearAfterTest(provider);
        return { ok: true, models: p.models.map(m => m.id), testCall: { ok: true, usage: { input: 9, output: 1 }, micros: 0 } };
      }
      const k = s.keys.get(provider);
      if (!k) return fail('no_key', `No ${p.name} key is set up.`, `Add your ${p.name} key.`, 'add_key');
      if (k.state === 'invalid') return fail('auth_invalid', `Your ${p.name} key was rejected.`, `Replace your key, or make a new one at ${p.name}.`, 'replace_key');
      if (k.state === 'nocredit' || (s.keyState[provider] === 'no_credit' && !s.creditLanded)) return fail('out_of_credit', `Your ${p.name} account is out of credit.`, `Add credit at ${p.name}, then click Test key.`, 'add_credit');
      clearAfterTest(provider); // D-32, D-38
      if (s.keyState[provider]) { delete s.keyState[provider]; changed(); }
      return { ok: true, models: p.models.map(m => m.id), testCall: { ok: true, usage: { input: 9, output: 1 }, micros: 14 } };
    },
    /** A pasted key, tested before it's stored (D-03): nothing is saved, whatever the outcome. */
    async testStagedKey(provider, getKey, o = {}) {
      await wait(300);
      await gate('testStagedKey');
      const f = forced('testStagedKey');
      if (f) return f;
      const p = find(provider);
      if (!p || p.auth === 'local' || p.auth === 'custom') return { ok: false, error: 'bad_input' };
      if (!termsRecorded(provider)) return { ok: false, error: 'terms_required' };
      const key = typeof getKey === 'function' ? await getKey(provider) : null;
      if (typeof key !== 'string' || !key) return { ok: false, error: 'key_expired' };
      return keyTest(p, key, o?.context ?? null);
    },
    async recordTerms(provider, v = 1) {
      if (!s.terms || typeof s.terms !== 'object') s.terms = Object.fromEntries([...s.keys.keys()].map(id => [id, 1]));
      s.terms[provider] = Number.isInteger(v) && v > 0 ? v : 1;
      return { ok: true, v: s.terms[provider] };
    },
    /** As app-api.mjs connect: save a key that passed (or a first no-credit key), and use it. */
    async connect(provider, key, o = {}) {
      await wait();
      const f = forced('connect');
      if (f) return f;
      const p = find(provider);
      if (!p || p.auth === 'local' || p.auth === 'custom') return { ok: false, error: 'bad_input' };
      const had = s.keys.has(provider);
      if (o?.noCredit && had) return { ok: false, error: 'bad_input' };
      s.keys.set(provider, { masked: maskKey(key), state: 'ok' });
      if (o?.noCredit) s.keyState[provider] = 'no_credit'; else delete s.keyState[provider];
      const inUse = s.choice?.provider === provider && had;
      if (!inUse) {
        const m = p.models[0];
        s.choice = { provider, model: m.id, effort: m.effort ? 'low' : null };
      }
      changed();
      const m = modelOf(p, s.choice.model);
      return { ok: true, masked: maskKey(key), model: m.name, first: !had };
    },
    async useSavedKey(provider) {
      await wait(300);
      await gate('useSavedKey');
      const f = forced('useSavedKey');
      if (f) return f;
      const p = find(provider);
      const k = s.keys.get(provider);
      if (!p || !k) return { ok: false, error: 'no_key' };
      if (!termsRecorded(provider)) return { ok: false, error: 'terms_required' };
      if (s.keyState[provider] === 'no_credit') return { ok: false, error: 'out_of_credit', documented: true, inferred: false, tier: false };
      if (s.choice?.provider !== provider) s.choice = { provider, model: p.models[0].id, effort: p.models[0].effort ? 'low' : null };
      changed();
      return { ok: true, masked: k.masked, testCall: { ok: true, micros: 14 } };
    },
    /** As app-api.mjs signIn: the browser flow, then one tiny test; the mock signs in at once. */
    async signIn(provider) {
      await wait(300);
      await gate('signIn');
      const f = forced('signIn');
      if (f) return f;
      const p = find(provider);
      if (!p || p.auth !== 'signin') return { ok: false, error: 'bad_input', field: 'provider' };
      if (!termsRecorded(provider)) return { ok: false, error: 'terms_required' };
      s.keys.set(provider, { masked: null, state: 'ok', signedIn: true });
      if (s.choice?.provider !== provider) s.choice = { provider, model: p.models[0].id, effort: p.models[0].effort ? 'low' : null };
      changed();
      return { ok: true, plan: 'plus', model: p.models[0].name, testCall: { ok: true, micros: 0 } };
    },
    async cancelSignIn() { return { ok: true }; },
    async deleteKey(provider) { s.keys.delete(provider); changed(); return { ok: true }; },
    /**
     * As app-api.mjs connectCustom: Other's service, tested with one tiny request and saved when it
     * answers. In the mock, a key with BADKEY is rejected, an address with "down" in it can't be
     * reached, and a model named "missing" isn't offered; anything else answers.
     */
    async connectCustom(v = {}) {
      await wait(300);
      await gate('connectCustom');
      const f = forced('connectCustom');
      if (f) return f;
      const c = checkCustomUrl(v?.baseUrl);
      if (!c.ok) return { ok: false, error: c.error };
      const model = typeof v?.model === 'string' ? v.model.trim() : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(model)) return { ok: false, error: 'bad_model' };
      const key = typeof v?.key === 'string' && v.key.trim() ? v.key.trim() : null;
      if (key && /BADKEY/.test(key)) return { ok: false, error: 'auth_invalid', kind: 'auth_invalid', documented: false, inferred: false, tier: false, model };
      if (/down/.test(c.baseUrl)) return { ok: false, error: 'network', kind: 'network_before_send', documented: false, inferred: false, tier: false, model };
      if (model === 'missing') return { ok: false, error: 'model_access', kind: 'model_not_found', documented: false, inferred: false, tier: false, model };
      s.custom = { baseUrl: c.baseUrl, model };
      if (key) s.keys.set('custom', { masked: maskKey(key), state: 'ok' }); else s.keys.delete('custom');
      s.choice = { provider: 'custom', model, effort: null };
      changed();
      return { ok: true, name: new URL(c.baseUrl).host, model, local: c.local, ...(key ? { masked: maskKey(key) } : {}), testCall: { ok: true, micros: 0 } };
    },
    // As the real choose saves it: the model's nearest level to the one asked for (none for a model without levels).
    async choose({ provider, model, effort }) {
      const m = find(provider)?.models.find(x => x.id === model);
      s.choice = { provider, model, effort: effort == null ? null : (nearestEffort(m?.efforts ?? [], effort) ?? null) };
      changed();
      return { ok: true };
    },
    async caps() {
      // A forced result: the saved limit that couldn't be read (main then asks before one is set).
      const f = forced('caps');
      if (f) return f;
      const local = s.choice ? isLocalP(find(s.choice.provider)) : false;
      return { dailyUsd: typeof s.caps?.dailyUsd === 'number' ? s.caps.dailyUsd : null, spentTodayMicros: local ? 0 : s.spentMicros };
    },
    /** As app-api.mjs setCaps: {dailyUsd: 0–100 with cents} sets the limit, {dailyUsd: null} clears it. */
    async setCaps(c) {
      if (!c || typeof c !== 'object' || !Object.hasOwn(c, 'dailyUsd')) return { ok: false, error: 'bad_input' };
      const d = c.dailyUsd;
      if (d !== null && (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d > 100 || Math.abs(d * 100 - Math.round(d * 100)) > 1e-6)) return { ok: false, error: 'bad_input', detail: 'dailyUsd' };
      s.caps = { dailyUsd: d };
      s.held = false; // the player's own limit change acknowledges a history that couldn't be read (backend.mjs setConfig, BR-09)
      changed();
      return { ok: true };
    },
    async privacy() { return clone(s.privacy); },
    async setPrivacy(p) { const f = forced('setPrivacy'); if (f) return f; s.privacy = { ...p }; changed(); return { ok: true }; },
    async usage({ days = 30 } = {}) {
      const t = now();
      const rows = Array.from({ length: Math.min(days, 14) }, (_, i) => ({
        day: new Date(t - i * DAY_MS).toISOString().slice(0, 10),
        spentMicros: i === 0 ? s.spentMicros : 90_000 + ((i * 37_000) % 210_000),
        turns: i === 0 ? s.turns : 8 + ((i * 7) % 30), auto: i === 0 ? s.autoTurns : i % 3,
      }));
      return {
        today: usageBlock(), caps: await api.caps(), days: rows,
        perProvider: [{ provider: 'anthropic', name: 'Anthropic', spentMicros: 1_830_000, turns: 240, auto: 36 }, { provider: 'google', name: 'Google', spentMicros: 210_000, turns: 31, auto: 0 }],
        replies: [
          { at: t - 5 * 60e3, model: 'claude-haiku-4-5', in: 7412, out: 331, micros: 4_300, exact: false },
          { at: t - 19 * 60e3, model: 'claude-haiku-4-5', in: 7105, out: 402, micros: 9_100, exact: false },
          { at: t - 64 * 60e3, model: 'claude-haiku-4-5', in: 6630, out: 250, micros: 3_900, exact: false },
        ],
      };
    },
    async connections() {
      const t = now();
      return {
        rows: [
          { host: 'api.anthropic.com', port: 443, count: 14, first: t - 3 * 3600e3, last: t - 5 * 60e3, feature: 'provider call' },
          { host: 'generativelanguage.googleapis.com', port: 443, count: 3, first: t - 26 * 3600e3, last: t - 25 * 3600e3, feature: 'key test' },
          { host: '127.0.0.1', port: 11434, count: 1, first: t - 50 * 3600e3, last: t - 50 * 3600e3, feature: 'local model' },
        ],
        blocked: clone(s.blocked),
        note: 'Connections lists every host the app itself connected to. A host that isn\'t on the list is refused before anything is sent to it.',
      };
    },
    async lastRequest(chatId) {
      const chats = [{ id: 'c3f9a1e', title: 'NeverQuestAlone' }, { id: 'b77e012', title: 'Route planning' }];
      const id = chats.some(c => c.id === chatId) ? chatId : chats[0].id;
      return {
        chats, chatId: id, at: now() - 5 * 60e3, provider: 'anthropic', model: 'claude-haiku-4-5',
        request: {
          method: 'POST', url: 'https://api.anthropic.com/v1/messages',
          headers: { 'x-api-key': 'sk-ant-…A1b2 (redacted)', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: {
            model: 'claude-haiku-4-5', max_tokens: 1200, stream: true,
            system: [{ type: 'text', text: '(prompt pack v1, 5,512 tokens)', cache_control: { type: 'ephemeral', ttl: '1h' } }],
            // The real turn's shape (bridge/byok/runtime/context.mjs): the game data block, then the text.
            messages: [
              { role: 'user', content: `<game_data id="9f3c2a71">\n${JSON.stringify({ source: 'game', memory: { digest: 'Prefers short answers.' }, game: { state: { char: { class: 'WARRIOR', race: 'Tauren', level: 6 }, loc: { zone: 'Mulgore', sub: 'Bloodhoof Village', x: 44.1, y: 76.3 }, quests: [{ id: 748, title: 'Poison Water' }, { id: 749, title: 'The Ravaged Caravan' }, { id: 750, title: 'The Hunt Continues' }, { id: 761, title: 'Swoop Hunting' }], gear: { mainHand: 'Worn Axe' } } } })}\n</game_data id="9f3c2a71">\n\nwhere do I turn in <img src=x onerror="alert(1)">?` },
            ],
          },
        },
      };
    },
    async memory(char) {
      if (!char) return { chars: [...s.memoryChars] };
      if (!s.memoryChars.includes(char)) return { ok: false, error: 'not_found' };
      return {
        char, updated: now() - 2 * 3600e3,
        digest: 'Level 6 Tauren Warrior. Prefers short answers. Working through Mulgore; skipped the Venture Co. chain.',
        notes: [
          { at: now() - 2 * 3600e3, text: 'Finished "The Hunt Begins".' },
          { at: now() - 26 * 3600e3, text: 'Player asked: <script>alert("not markup")</script> — shown as text.' },
        ],
      };
    },
    async forgetMemory(char) { s.memoryChars = s.memoryChars.filter(c => c !== char); return { ok: true }; },
    async transcripts({ deleteAll } = {}) {
      if (deleteAll) { const n = s.transcripts; s.transcripts = 0; return { ok: true, deleted: n, retentionDays: s.retentionDays ?? 30 }; }
      return { ok: true, count: s.transcripts, retentionDays: s.retentionDays ?? 30 };
    },
    async retentionPreview(days) {
      const cur = s.retentionDays ?? 30;
      // The mock's conversations are spread evenly over the time they're kept.
      const older = days < cur ? Math.round(s.transcripts * (cur - days) / cur) : 0;
      return { ok: true, retentionDays: cur, days, chats: older, trimmed: older ? 1 : 0, messages: older * 6 };
    },
    async setRetention(days) {
      if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, error: 'bad_input' };
      s.retentionDays = days;
      changed();
      return { ok: true, retentionDays: days };
    },
    async regenerateSafetyId() { s.safetyIdRegens += 1; return { ok: true }; },
    async findWow() {
      await wait();
      await gate('findWow');
      const list = installs();
      if (!list.length) return { found: false, running: !!s.wow.running, candidates: [] };
      const pick = list.find(w => s.wowChosen && w.path === s.wowChosen.path) ?? list[0];
      return {
        found: true, path: pick.path, flavor: '_forever_', account: 'TESTACCOUNT', running: !!s.wow.running, addon: pick.addon,
        candidates: list.map(w => ({ path: w.path, flavor: '_forever_', ...(w.version ? { version: w.version } : {}), addon: w.addon })),
      };
    },
    async useWowFolder(dir) {
      await wait();
      if (!s.wow.chosen || typeof dir !== 'string') return { ok: false, error: 'not_wow', detail: 'That folder doesn’t have World of Warcraft: Forever in it. Pick the folder the game is installed in.' };
      s.wowChosen = { path: s.wow.chosen, addon: false };
      return { ok: true, ...(await api.findWow()) };
    },
    async installAddon(v = {}) {
      await wait(400);
      const f = forced('installAddon');
      if (f) return f;
      if (s.wow.running) return { ok: false, error: 'wow_running', detail: 'Quit World of Warcraft completely first (not just log out).' };
      const target = v?.flavorDir ?? installs()[0]?.path ?? null;
      if (!target || !installs().some(w => w.path === target)) return { ok: false, error: 'wow_not_found' };
      if (target === wowPath()) s.addonInstalled = true;
      if (!s.addonDirs.includes(target)) s.addonDirs.push(target);
      s.current = target; // the install the bridge now uses (config.wow.flavorDir)
      // The permissions check (TH12): tighten fixes what this account owns.
      let permissions = permissionsWithCommand(s.permissions);
      if (v?.tighten === true && permissions.fixable) {
        permissions = { ok: true, fixable: false, fixed: permissions.paths, paths: [], detail: '', command: null };
        s.permissions = null;
      }
      changed();
      return { ok: true, steps: [{ name: 'Addon folder', ok: true }, { name: '200 slot folders', ok: true }, { name: 'Doorbell folder', ok: true }, { name: 'Checked every file', ok: true }], restartNeeded: true, permissions };
    },
    async wowRunning() { return { running: !!s.wow.running }; },
    async setupInstall(v = {}) {
      s.armed = null;
      if (s.wow.running) return { ok: false, error: 'wow_running', detail: 'Quit World of Warcraft completely first (not just log out).' };
      const was = s.addonState;
      const target = v?.flavorDir ?? installs()[0]?.path ?? null;
      s.addonUpdate = was === 'older' || installs().some(w => w.path === target && w.addon);
      s.addonState = 'installing';
      changed();
      await gate('setupInstall');
      s.addonState = null;
      const r = await api.installAddon({ flavorDir: v?.flavorDir });
      if (r?.ok === false && r.error !== 'wow_running') { s.addonState = r.error === 'eperm' ? 'eperm' : r.error === 'disk_full' ? 'disk_full' : 'failed'; changed(); }
      if (r?.ok) { s.othersCanWrite = r.permissions?.ok === false; changed(); }
      return r;
    },
    async armInstall(v = {}) {
      if (!s.wow.running) return api.setupInstall(v);
      const list = installs();
      s.armed = v?.flavorDir ?? list[0]?.path ?? wowPath();
      changed();
      return { ok: true, armed: true, path: s.armed };
    },
    async cancelInstall() { const was = !!s.armed; s.armed = null; changed(); return { ok: true, cancelled: was }; },
    async launcher() { return { found: true, path: platform === 'darwin' ? '/Applications/Battle.net.app' : 'C:\\Program Files (x86)\\Battle.net\\Battle.net Launcher.exe' }; },
    async requestScreenPermission() {
      if (platform !== 'darwin') return { ok: false, error: 'unsupported' };
      s.permission = 'asked';
      changed();
      return { ok: true, requestedAt: now() };
    },
    async screenPermission() { return { ok: true, permission: platform === 'darwin' ? s.permission === 'granted' : null }; },
    async tightenAddonPermissions() {
      const p = permissionsWithCommand(s.permissions);
      if (p.ok === false && p.fixable) {
        s.permissions = null;
        return { ok: true, permissions: { ok: true, fixable: false, fixed: p.paths, paths: [], detail: '', command: null } };
      }
      return { ok: true, permissions: p };
    },
    async addonPermissions() {
      if (!s.addonInstalled && !s.addonDirs.length) return { ok: true, permissions: null };
      return { ok: true, permissions: permissionsWithCommand(s.permissions) };
    },
    async diagnostics() {
      return {
        text: [
          'bridge 0.0.0-mock (demo data)',
          `os ${platform}`,
          'capture ok · slots 200/200 · doorbells ok (sound off → slow mode)',
          'errors today: none',
          '-- last log lines --',
          '10:02:11 provider anthropic ready (key sk-ant-…A1b2)',
          '10:04:40 turn c3f9a1e ok 7412/331 tokens',
        ].join('\n'),
      };
    },
    async resumeSending() {
      await wait();
      if (!s.sendingPaused) return { ok: false, error: 'not_paused' };
      s.sendingPaused = null;
      changed();
      return { ok: true };
    },
    async setPaused(paused) { s.paused = !!paused; changed(); return { ok: true, paused: s.paused }; },
    async uninstall({ removeAddon } = {}) { return { ok: true, removed: removeAddon ? ['addon', 'slots', 'doorbells', 'keys', 'data'] : ['keys', 'data'], mock: true }; },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async stop() { listeners.clear(); for (const h of holds.values()) h.release(); holds.clear(); },
  };
  if (controllable) {
    api.control = {
      /** Start from the fake bridge's first state, then apply patch (keys as {provider: {masked, state}}). */
      reset(patch = {}) {
        generation += 1;
        for (const h of holds.values()) h.release();
        holds.clear();
        const { keys, ...rest } = patch;
        s = { ...initialState(), ...clone(rest) };
        for (const [id, k] of Object.entries(keys ?? {})) s.keys.set(id, { ...k });
        changed();
      },
      /** A status push mid-scene: the setup block patched (a row is checked off in place). */
      patchSetup(patch) { s.setup = merge(s.setup ?? {}, patch ?? {}); changed(); },
      /** Put the fake bridge's facts in place without a reset (keys, WoW, permission): then a push. */
      patch(fields) { const { keys, ...rest } = fields ?? {}; Object.assign(s, clone(rest)); for (const [id, k] of Object.entries(keys ?? {})) s.keys.set(id, { ...k }); changed(); },
      /** Use the real manifests' player text ({id: {privacyCard, notes}}) for every scene from now on. */
      usePlayerText(map) { playerText = map && typeof map === 'object' ? clone(map) : null; },
      /** Answer as this OS would (paths, the administrator's command): the screenshot mode's Windows scenes. */
      usePlatform(p) { platform = typeof p === 'string' && p ? p : process.platform; },
      /** Use the bridge's lastErrorView (app-api.mjs) for the backend's last failure. */
      useLastErrorView(fn) { lastErrorView = typeof fn === 'function' ? fn : null; },
      /** Give up on every held call: they stop where they are and change nothing (a scene that's over). */
      abandon() {
        generation += 1;
        for (const h of [...holds.values()]) h.release();
        holds.clear();
      },
      /** Keep call pending until release() (a key test "Checking…", a sign-in "Waiting…"). */
      hold(name) {
        let release;
        const promise = new Promise(r => { release = r; });
        const h = { promise, release: () => { holds.delete(name); release(); } };
        holds.set(name, h);
        return h.release;
      },
      changed,
    };
  }
  return api;
}
