// The bridge's core (PRD §9.5, §9.6): strip records in, turns out to the backend (the player's own
// AI: bridge/byok/backend.mjs), replies back through slots, announced by doorbells (PROTOCOL §3).
//
//   capture/savedvars → records → handleRecord → outbox → backend.send
//   backend events (chat, agent) → records → publisher → slots + push
//
// The core calls the backend directly, by chat id (code health BR-22: the retired gateway's
// RPC isn't emulated any more): send, abort, forget, setChatModel, and outcomes for what became of a
// run it heard nothing of. It only ever looks at events whose chat id is one of its own chats; anything
// else is dropped unread and never logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parsePayload, parseRecord, inflateBody } from './transport/records.mjs';
import { createSignals, ALIVE_EVERY_MS } from './transport/signals.mjs';
import { createPublisher } from './transport/publisher.mjs';
import { createSlotWorker } from './write-queue.mjs';
import { slotWindow, SLOT_COUNT, WINDOW_MARGIN, SLOT_JOB } from './transport/slots.mjs';
import { newestSavedVariables } from './transport/savedvars.mjs';
import { createCaptureHealth } from './transport/capture-health.mjs';
import { createRetrier } from './transport/fsretry.mjs';
import { openStore } from './app/store.mjs';
import { renderReply, systemLine } from './app/render.mjs';
import { withState, parseContextLines, staleContext } from './app/context.mjs';
import { newMap, applyMapCommands, drawnLayers, fitMapBytes, toSlotMap, routeNow } from './app/map.mjs';
import { validateState, eventSummary, readLastSession, finishRecap, fillTitles, STATE_JSON_MAX, STATE_BODY_MAX } from './app/companion.mjs';
import { writeFileQuick } from './files.mjs';
import { looksLikeKey } from './byok/security/keycheck.mjs';
import { sanitizeState, sanitizeArgs, sanitizeGameString, typedLooksLikeKey } from './byok/runtime/sanitize.mjs';
import { mapFailureLine, mapFailureLog, mapTrimLine } from './byok/runtime/repair.mjs';
import { createAutoFuse, AUTO_FUSE, TYPED_GUARD, autoPausedLine, sendPausedLine } from './byok/usage/fuse.mjs';
import { cleanRequestId } from './byok/providers/errors.mjs';

export const BRIDGE_VERSION = '1.4.19';
export const ACKED_KEEP = 50;
export const RERING_FAST_MS = 10000; // PROTOCOL §3: re-ring every 10 s six times,
export const RERING_FAST_COUNT = 6;
export const RERING_SLOW_MS = 60000; // then every 60 s,
export const RERING_FOR_MS = 600000; // until 10 minutes after the publish
// A run with no word of it this long (the backend's 3-minute run limit, PV-7) is asked about once
// (backend.outcomes), and again after as long while it's still running (code health BR-22's safety net).
export const RUN_CHECK_MS = 180000;
export const COMPANION_CHAT = 'c0ffee0'; // PROTOCOL §2.6
// The voice companion's inbox in the bridge state folder (tools/voice/game.mjs INBOX_DIR: one JSON file
// per entry), the most entries one drain publishes, the most of one entry's file and of its text
// (odd/tasks/nqa-voice.md T7).
export const VOICE_INBOX = 'voice-inbox';
export const VOICE_PER_DRAIN = 50;
export const VOICE_FILE_MAX = 16 * 1024;
export const VOICE_TEXT_MAX = 6000;
// The addon's voice buttons and keys (cap voice; odd/tasks/nqa-voice-controls.md, tools/voice/game.mjs
// CONTROL_FILE/STATUS_FILE): the newest command for the voice page, and what the voice says it is doing.
export const VOICE_CONTROL = 'voice-control.json';
export const VOICE_STATUS = 'voice-status.json';
export const VOICE_COMMANDS = Object.freeze(['talk', 'tip', 'mute', 'unmute', 'pause', 'resume', 'persona', 'read']);
// The voice reading replies aloud (T16): its switch, and the queue of summaries for it to say.
export const VOICE_READ = 'voice-read.json';
export const VOICE_SAY = 'voice-say';
export const VOICE_SAY_MAX = 20;
export const VOICE_SAY_TEXT_MAX = 600;
// The check-ins the voice says by itself, and how far apart (S6: important ones only, one every 20-30 min).
export const VOICE_NUDGE_KINDS = Object.freeze(['level_up', 'gear_breaking', 'bags_full']);
export const VOICE_NUDGE_GAP_MS = 25 * 60 * 1000;
// Who the voice is (S4): the same fixed list as tools/voice/server.mjs PERSONAS and the addon's VOICE_PERSONAS.
export const VOICE_PERSONAS = Object.freeze(['skeleton', 'orc-shaman', 'troll', 'forsaken', 'tauren']);
export const VOICE_STATES = Object.freeze(['listening', 'muted', 'paused', 'connecting']);
export const VOICE_STATUS_FRESH_MS = 15000;
// The voice asking for bags and gear (tools/voice/game.mjs WANT_FILE): {v:1, n, at}, honoured for VOICE_WANT_FRESH_MS.
export const VOICE_WANT = 'voice-want.json';
export const VOICE_WANT_FRESH_MS = 20000;
export const VOICE_COMMAND_MAX_AGE_S = 30; // a voice command older than this is never applied (it was meant for then)
export const STATE_WAIT_MS = 2000; // a turn naming a state (st=) waits this long for it (companion F1)
export const RECAP_EXIT_WINDOW_MS = 60000; // lastSession and the game's exit within this: a quit (F6)
export const RELOAD_GRACE_MS = 2000; // the same session heard this long after a lastSession write: that write was a /reload's
export const HEARD_SAVE_MS = 60000; // the same session heard again saves companion.json at most this often (PF-04)
// /bones think (PROTOCOL §2.4 patch): the thinking levels, cheapest first (bridge/byok/providers/util.mjs
// EFFORT_LEVELS). A chat keeps the one it asked for; each turn goes at its model's nearest level.
export const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const KEY_REFUSED = "That looks like an API key. It wasn't sent."; // KY-10, the bridge's own check
// The first meeting (onboarding spec §9.3, C-41): the one chip on the reply to Say
// Hi's "hi", and the game client's locale as the hello names it.
export const FIRST_CHIP = 'What should I do next?';
export const LOCALE_RE = /^[a-z]{2}[A-Z]{2}$/;
// A turn's ack (a msg or an evt taken) rings push within this, or with the turn's first reply, error
// or aborted line if that comes first (audit PF-02): every slot carries bridge.acked, so a turn costs
// the addon one slot load of its 200 instead of two. config.transport.ackRingMs sets it (0: at once).
export const ACK_RING_MS = 8000;
// While World of Warcraft is closed the app's bridge does no in-game work (systems critic
// SY-30): the alive beat, re-rings, the SavedVariables poll, the capture-state check, the game's pid
// check, the quiet-run checks and the outbox retry run from the game's launch until GAME_LINGER_MS
// after it exits (the logout's SavedVariables and the session recap come in that minute). The rest
// of the time one slow check every GAME_CHECK_MS reads the SavedVariables file (a stat) and, when no
// capture helper reports the game, asks the process list.
export const GAME_LINGER_MS = 60000;
export const GAME_CHECK_MS = 30000;
// Code health BR-15: with no helper reporting the game (Screen Reading off), the slow check asked the
// process list (pgrep, tasklist on Windows) every 30 s for as long as WoW stayed closed. After a "not
// running" it asks again 2 min later, then every 5 min; a write under WTF/Account (a login's caches, a
// /reload's or a logout's SavedVariables) wakes the slow check at once, and asks.
export const GAME_ASK_MS = Object.freeze([120000, 300000]);
// A SavedVariables write is read this many records a poll, the rest at the next (code health BR-02:
// 200 typed records in one write held the main thread for 1.98 s).
export const RELOAD_BATCH = 50;
// A runaway of typed records read from SavedVariables across writes (code health BR-02): more than this
// many a minute, counted at their files' write times, trips the typed guard. One write trips it past the
// guard's own 20 new ones.
export const RELOAD_RUNAWAY = Object.freeze({ turns: 60, windowMs: 60_000 });
// The strip is taken as unread after this long with the game up, no payload and no frame the helper's
// stats decoded (code health BR-16): the slot window then can't follow the addon's loads.
export const STRIP_UNREAD_MS = 30000;

/** Plain text of a backend message (text parts only). */
export function messageText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  return '';
}

const hexToString = hex => Buffer.from(String(hex), 'hex').toString('utf8');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * What the backend adds to the slot (BYOK: bridge.provider, bridge.usage, rt), merged into the
 * slot's own fields: objects field by field (a nested object one level further), and the
 * bridge.caps lists joined, so the backend adds to what the bridge takes rather than replacing it.
 */
export function mergeSlotExtras(slot, extras) {
  if (!isObj(extras)) return slot;
  for (const [k, v] of Object.entries(extras)) {
    if (!isObj(slot[k]) || !isObj(v)) { slot[k] = v; continue; }
    const out = { ...slot[k] };
    for (const [k2, v2] of Object.entries(v)) {
      if (k2 === 'caps' && Array.isArray(out.caps) && Array.isArray(v2)) out.caps = [...new Set([...out.caps, ...v2])];
      else if (isObj(out[k2]) && isObj(v2)) out[k2] = { ...out[k2], ...v2 };
      else out[k2] = v2;
    }
    slot[k] = out;
  }
  return slot;
}

/** A reply's usage from the backend's final ({in, out, micros, model, exact}): whole numbers, or null. */
export function cleanUsage(u) {
  if (!isObj(u)) return null;
  const n = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const out = { in: n(u.in), out: n(u.out), micros: n(u.micros), model: typeof u.model === 'string' ? u.model.slice(0, 80) : undefined, exact: u.exact === true };
  return out.in === undefined && out.out === undefined && out.micros === undefined ? null : out;
}

const ERROR_ACTIONS = new Set(['retry', 'desktop', 'send_again', 'none']);
// A second choice an error line may offer beside its action (D7: Pick Another AI on the busy and
// out-of-credit lines, which opens Your AI on the desktop). The addon's second button is its half.
const ERROR_ALTS = new Set(['pick_provider']);

export function createBridge(config, deps) {
  const {
    stateDir, addonsDir, now = () => Date.now(), log = () => {},
    gatewayFactory, // (handlers) => backend (bridge/byok/backend.mjs, or a test double): the surface the core talks to
  } = deps;
  // A write that failed or came through again (a full disk, BR-11): the host's window reads it from
  // status().store.writeError, so it hears of it at once (deps.onHealthChange).
  // One ordered write queue (code health BR-04, durable writes; write-queue.mjs) when the host asks
  // for the slot worker (publisherOpts.worker: true, the app's boot; or a queue of its own, a test's): the slot
  // files, and every write of the outbox, state.json and the backend's ledger (gatewayFactory's second
  // argument), reach the disk in the order asked for, off the main thread. An outbox write queued before an
  // ack's slot lands first, and the ledger's 'sending' mark is on disk before the provider is asked. stop()
  // drains it, then ends it. Without one, every write is made in place, as before.
  const wanted = deps.publisherOpts?.worker;
  const writer = wanted ? (typeof wanted === 'object' ? wanted : createSlotWorker({ log })) : null;
  writer?.use?.(SLOT_JOB); // what runs the slot tables, before the store's first write starts the worker
  const store = openStore(stateDir, { log, now, writer, onWriteError: () => { try { deps.onHealthChange?.(); } catch { /* the host's business */ } } });
  const S = store.state;
  const signals = createSignals(addonsDir, { log, ...(deps.signalsOpts || {}) });
  // The player's privacy switches (config.byok.privacy, the app's Your data page): the one place they
  // live (code health BR-28). Automatic turns (companion) are opt-in, read at each event; game context
  // is on unless turned off, read once here (boot's privacy wrapper applies it live to typed turns). A
  // config with no byok section (a core built alone: tests, tools) has no switches set: both on.
  const privacy = () => (isObj(config.byok) ? (isObj(config.byok.privacy) ? config.byok.privacy : {}) : null);
  const companionOn = () => { const p = privacy(); return p ? p.companion === true : true; };
  const useContext = (() => { const p = privacy(); return p ? p.gameContext !== false : true; })();
  // The one persona (the backend's: the name the player gave Bones in the app), read when it's ready.
  const defaultAgent = 'main';
  let agents = [{ id: defaultAgent, name: 'NeverQuestAlone' }];
  let gwState = { state: 'connecting', since: now(), reason: null };
  const busy = new Map(); // chatId -> { started, actions, last }
  const queued = new Map(); // chatId -> count of followups waiting
  let lastPayloadAt = 0;
  let lastReloadAt = 0; // the last time records were read from SavedVariables
  let warn = null;
  let gateway = null; // the backend deps.gatewayFactory made
  // The backend's name in player-facing lines (the player's AI: the provider's name), else "Your AI".
  const backendName = () => gateway?.displayName || 'Your AI';
  // The companion's name in player-facing lines: the backend's agent (the persona), else Bones.
  const companionName = () => agents.find(a => a.id === defaultAgent)?.name || 'NeverQuestAlone';
  let pushDebounce = null;
  // The capture watchdog (transport/capture-health.mjs; display DR-04): the one source of the slot's
  // bridge.capture and the app's screen state (SY-20), and what starts a capture helper over. The
  // app's host (boot.mjs) asks for it with deps.captureHealth ({ platform, off }) and hands it the
  // supervisor through setCaptureControl; a host that feeds the strip itself (the tests) has none,
  // and its slot says nothing of capture.
  const health = deps.captureHealth ? createCaptureHealth({
    platform: deps.captureHealth.platform, now, log, off: deps.captureHealth.off, thresholds: deps.captureHealth.thresholds,
    publish: ({ ring }) => publisher.publish({ push: ring }),
    changed: () => { try { deps.onCaptureChange?.(); } catch { /* the app's push never breaks the bridge */ } },
  }) : null;
  let writeFirst = null; // while a SavedVariables write is read: its keyed records read there first (R4')
  const stTimers = new Map(); // outbox keys waiting for the state their turn names (st=)
  // What the slot says this bridge takes (PROTOCOL §4.1 bridge.caps): the companion's
  // records, the think patch, z, a state body deflated for the strip (§2.6), which
  // transport.deflate: false stops asking for, ctx: a turn that names a state
  // gets its game context from it, so a message beside the state may leave its own out,
  // and qlog: it takes a state of up to 12,000 bytes of JSON and puts back whole the
  // quest titles an earlier state sent (fillTitles), so the addon sends every quest.
  const caps = ['state', 'evt', 'think', ...(config.transport?.deflate === false ? [] : ['z']), 'ctx', 'qlog', 'voice'];

  if (!S.map) S.map = newMap();
  else if (fitMapBytes(S.map).changed) log('map-trimmed', { at: 'start' }); // one saved before the byte budget (DREW-SY-04)

  // ---------------------------------------------------------------- companion state
  // companion.json: the latest game state per token (F1), the session heard last per token, the
  // session recap waiting for its end (F6), and per token the quest titles its states sent whole
  // (titles, fillTitles).
  // companion-events.json: level-ups already turned (F3), today's count of
  // automatic turns, recaps sent, events riding with the next typed message (held
  // while the runaway fuse holds), and the fuse's state (autoFuse: its window's send
  // times and a pause, so a restart keeps both) and the typed guard's (typedGuard).
  const compFile = path.join(stateDir, 'companion.json');
  const evFile = path.join(stateDir, 'companion-events.json');
  const readJson = (file, base) => { try { return { ...base, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return base; } };
  let comp = readJson(compFile, { states: {}, pendingRecap: null, lastSessionSeen: null, heard: {}, titles: {} });
  if (!comp.heard) comp.heard = {};
  delete comp.chatSeq; // an earlier bridge's: the state seq each chat last got in a data block
  for (const st of Object.values(comp.states || {})) if (st && typeof st === 'object') delete st.json; // and the state's JSON for that block
  if (!comp.titles) comp.titles = {};
  const questLogSeen = new Map(); // token -> the last quest-log line logged
  let ev = readJson(evFile, { levels: {}, day: null, count: 0, recapped: [], ride: {} });
  // The runaway fuse (bridge/byok/usage/fuse.mjs, AUTO_FUSE; spec §9.9). deps.autoFuse is for tests
  // (null: off, as AUTO_FUSE = null turns it off in the build).
  const fuseLimits = deps.autoFuse !== undefined ? deps.autoFuse : AUTO_FUSE;
  const fuse = createAutoFuse(fuseLimits && { ...fuseLimits, now, state: ev.autoFuse });
  // The typed guard (fuse.mjs TYPED_GUARD, systems plan D4): more than 20 typed messages in a minute
  // pause sending until the player presses Resume sending in the desktop app (resumeSending()); a
  // typed message can't end it. Counted as they come in off the strip (a backlog read from
  // SavedVariables at a reload is one the player typed over time: reloadHolds counts those as a
  // runaway only). deps.typedGuard is for tests.
  const guardLimits = deps.typedGuard !== undefined ? deps.typedGuard : TYPED_GUARD;
  let guard = createAutoFuse(guardLimits && { ...guardLimits, now, state: ev.typedGuard });
  const reloadRunaway = createAutoFuse(guardLimits && { ...RELOAD_RUNAWAY, now });
  // Derived state: written without fsync (files.mjs, systems plan Batch 4).
  const saveJson = (file, obj) => { try { writeFileQuick(file, JSON.stringify(obj) + '\n'); } catch (e) { log('companion-save-error', { error: String(e.message).slice(0, 120) }); } };
  const saveComp = () => saveJson(compFile, comp);
  const saveEv = () => saveJson(evFile, ev);
  let gamePid = null;
  let gameExitedAt = 0;
  let exitedPid = null;
  let heardAtFile = null; // while records from SavedVariables are handled: when that file was written

  // ---------------------------------------------------------------- slots

  // What the backend adds to one chat's row in chats[] (BYOK chatSlot: the chat's own model, its
  // name, whether it takes an effort, its thinking levels, the effort its next turn sends), given the
  // level the core sends with that chat's turns. Only the contract's fields, and only plain values.
  const CHAT_EXTRAS = { model: 'string', modelName: 'string', effortSupported: 'boolean', efforts: 'string', effort: 'string' };
  function chatExtras(c) {
    if (typeof gateway?.chatSlot !== 'function') return {};
    let x;
    try { x = gateway.chatSlot(c.id, { think: thinkFor(c) }); } catch (e) { log('chat-slot-error', { chat: c.id, error: String(e?.message || e).slice(0, 120) }); return {}; }
    if (!isObj(x)) return {};
    const out = {};
    for (const [k, type] of Object.entries(CHAT_EXTRAS)) if (typeof x[k] === type) out[k] = type === 'string' ? x[k].slice(0, 80) : x[k];
    return out;
  }

  const patchState = () => { try { return deps.patchState?.() === 'failed' ? 'failed' : null; } catch { return null; } };

  let lastVoice = null; // the voice state the last slot carried (voiceStatus, cap voice)
  function buildSlot() {
    const token = S.lastToken;
    const t = token ? S.tokens[token] : null;
    const chats = Object.values(S.chats).filter(c => !token || c.token === token).map((c) => {
      const b = busy.get(c.id);
      // Busy from the moment a message is taken, not only once its run starts: the
      // ack goes out before the send, and an addon that read "acked and idle" there
      // took the question as answered and showed nothing for the whole run.
      const waiting = store.outbox.some(o => o.chat === c.id);
      const running = Object.values(S.inflight).some(r => r.chat === c.id);
      return {
        // A chat's session key stays in the bridge: the slot never carries it (RT-10).
        // A label is inert in the slot too (TH12, LS-11), one kept before labels were.
        id: c.id, agent: c.agent, label: sanitizeGameString(c.label || '', 64), think: thinkFor(c) || undefined,
        busy: !!b || waiting || running, queued: queued.get(c.id) || 0,
        run: b ? { started: Math.floor(b.started / 1000), actions: b.actions, last: b.last || '' } : undefined,
        // The backend's word for this chat (BYOK: model, modelName, effortSupported, effort; C-11).
        ...chatExtras(c),
      };
    });
    // The capture state (cap capture): { state, since, cause? } from the watchdog.
    const capture = health ? health.slot() : null;
    const slot = {
      v: 2, ts: new Date(now()).toISOString(), now: Math.floor(now() / 1000), token: token || '',
      bridge: { ver: BRIDGE_VERSION, push: S.push, epoch: S.epoch, nonce: t?.nonce || '', acked: t?.acked || [], warn: warn || undefined,
        caps: [...caps, ...(capture ? ['capture'] : [])], stateSeq: token && comp.states[token] ? comp.states[token].seq : undefined,
        stateSid: token && comp.states[token] ? comp.states[token].sid : undefined,
        // Which bridge wrote the slot. This addon reads nothing from it. The two-build addon an earlier
        // app build installed (until 2026-09-29) tells its public side by it (a flag it reads), which
        // matters while one still runs: until WoW restarts after the app installed this addon. It can
        // go once no install can still run that addon (with the first public release).
        backend: 'byok',
        // The voice companion's state for the addon's voice buttons (cap voice): off unless it said otherwise lately.
        voice: lastVoice = voiceStatus(),
        ...(capture ? { capture } : {}),
        // Patch day (SY-29): 'failed' while the host couldn't set the installed TOCs to the game's
        // interface number; the addon then says so in its own line.
        ...(patchState() ? { patch: patchState() } : {}) },
      gw: {
        state: gwState.state, since: Math.floor(gwState.since / 1000),
        reason: gwState.reason || undefined, queued: store.outbox.length,
      },
      agents,
      chats,
      records: token ? store.recordsFor(token) : [],
      map: toSlotMap(S.map),
    };
    // What the backend adds (BYOK: bridge.provider, bridge.usage, rt, and its caps).
    const out = mergeSlotExtras(slot, gateway?.slotExtras?.());
    // The runaway fuse: bridge.usage.autoPaused while it holds (under the usage cap; left out
    // otherwise), so the addon doesn't promise "Bones is on it".
    if (fuse.paused && isObj(out.bridge?.usage)) out.bridge.usage = { ...out.bridge.usage, autoPaused: true };
    // The typed guard: bridge.usage.sendPaused while it holds (the addon half shows it; D4).
    if (guard.paused && isObj(out.bridge?.usage)) out.bridge.usage = { ...out.bridge.usage, sendPaused: true };
    return out;
  }

  // ---------------------------------------------------------------- the slot window (SY-03)
  // Which slots a publish writes: the ones the talking token's addon can load next (slots.mjs
  // slotWindow). The addon reports where its next load is (slot=: on its hello and on a seen after
  // every load), and each report anchors the window; nothing is guessed. Every slot when there's no
  // report (an older addon that doesn't send one: correct, only heavier; a hello read only from
  // SavedVariables; a bridge that never saw one) or when transport.slotWindow is false. Kept in the
  // token (t.win), so a restart keeps it.
  const slotCount = config.transport?.slots || SLOT_COUNT;
  // The addon's pool is SLOT_COUNT slots, and the window counts in it: a pool set to another size
  // (tests) is always written whole.
  const windowOn = config.transport?.slotWindow !== false && slotCount === SLOT_COUNT;
  const winOf = () => { const t = S.lastToken ? S.tokens[S.lastToken] : null; return windowOn && t?.win && t.win.nonce === t.nonce ? t.win : null; };
  // The next slot the addon says it loads (slot=), or null: past the pool, it has none left.
  const reportedSlot = (r) => { const n = Number(r.args.slot); return Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT ? n : null; };
  // Only a report read off the strip, now: one from SavedVariables is from a session that already ended.
  const newWindow = (r, slot) => ({ nonce: r.nonce, base: slot, at: now(), mode: 'report', blanked: false, blankTo: 0 });
  function anchorWindow(t, r, via) {
    const slot = reportedSlot(r);
    t.win = slot !== null && via !== 'reload' ? newWindow(r, slot) : null;
  }
  // A record of this session after its hello. slot=: the lowest slot the addon can load next, so a
  // report higher than the anchor is the new anchor (the first report anchors one, for an addon
  // whose hello said none), and when its window reaches past the slots written with the table,
  // they're written now, so the addon's next loads find it.
  function windowEvidence(t, r, via) {
    noteSessionMode(r, via); // code health BR-04: every record passes here (handleRecord)
    queueModeCheck();
    if (r.type === 'hello' || r.nonce !== t.nonce) return;
    const slot = reportedSlot(r);
    if (slot === null) return;
    let w = t.win && t.win.nonce === r.nonce ? t.win : null;
    if (w && slot <= w.base) return; // an older report (a strip read again)
    if (w) Object.assign(w, { base: slot, at: now() });
    else if (via === 'reload') return;
    else w = t.win = newWindow(r, slot);
    if (slot + WINDOW_MARGIN > (w.top | 0) && winOf() === w) publisher.publish({});
  }
  // What the next ringing publish writes (status().slotWindow reads it; publishRange is the publisher's).
  function slotRange() {
    const w = winOf();
    return w && !fullDue() ? slotWindow(w, { count: slotCount }) : null;
  }
  // The window moves with the addon's slot= reports, which come off the strip: while the strip is unread
  // mid-session the addon loads on past the window's top into empty slots (code health BR-16), so every
  // slot is written then, bounded: at most once per STRIP_UNREAD_MS, and only for something new, a
  // ringing publish (a record, an ack, a hello's answer: what the addon must read). Any other publish,
  // and a ringing one inside the 30 s, goes to the window and empties nothing (what the last full write
  // left stays where the blind addon loads); that ringing one is owed a full write, made and rung at the
  // first 2 s tick past the 30 s (owedFull), so what it carried reaches every slot once. Unread: the
  // capture watchdog publishes no_signal, or the game is up and for over STRIP_UNREAD_MS no payload came
  // and the helper's last stats line decoded no frame in its interval (a strip that doesn't change is
  // decoded every frame but sent once).
  let lastFull = -Infinity; // when every slot was last written
  let fullOwed = false; // a ringing publish the 30 s kept to the window
  const fullDue = () => stripUnread() && now() - lastFull >= STRIP_UNREAD_MS;
  function publishRange({ push = false } = {}) {
    const w = winOf();
    if (!w) return null;
    if (!stripUnread()) return planFor(slotWindow(w, { count: slotCount }), w);
    if (push) {
      if (now() - lastFull >= STRIP_UNREAD_MS) return null;
      fullOwed = true;
    }
    const plan = slotWindow(w, { count: slotCount });
    return planFor(plan && { ...plan, blank: [] }, w);
  }
  function owedFull() {
    if (!fullOwed || now() - lastFull < STRIP_UNREAD_MS) return;
    fullOwed = false;
    if (stripUnread() && winOf()) publisher.publish({ push: true });
  }
  function stripUnread() {
    if (!health) return false;
    if (health.state() === 'no_signal') return true;
    if (gate && game.state !== 'up') return false;
    const t = now();
    if (t - lastStripAt <= STRIP_UNREAD_MS) return false;
    const st = health.info().lastStats;
    return !(st && Number(st.interval?.decoded) > 0 && t - st.at <= STRIP_UNREAD_MS);
  }
  // A plan carries the window it was made for (code health BR-04): the worker writes it a moment later,
  // and a new hello's window made meanwhile isn't the one these slots were written for.
  function planFor(plan, w) {
    if (plan) Object.defineProperty(plan, 'win', { value: w });
    return plan;
  }
  function slotsWritten(plan) {
    const w = winOf();
    if (!w || (plan?.win && plan.win !== w)) return;
    // Every slot written (the strip unread, BR-16, or a window that reaches every slot): what's outside
    // the window is emptied once again when it narrows, so no slot keeps a table it was left.
    if (!plan) {
      Object.assign(w, { blanked: false, blankTo: 0, top: slotCount });
      lastFull = now();
      fullOwed = false;
      return;
    }
    // Nothing emptied (the strip unread, BR-16; or nothing left to empty): the window's slots hold the table.
    if (!plan.blank.length) { w.top = Math.max(w.top | 0, plan.to); return; }
    w.blanked = true;
    w.blankTo = Math.max(w.blankTo, plan.from - 1);
    w.top = plan.to; // above it: emptied (at the start, or when a new anchor brought the top down)
  }

  // ---------------------------------------------------------------- bells nobody hears (code health BR-04)
  // In stream and reload modes the addon draws no strip, and without it reads no doorbell: it loads
  // slots on its own timers (Transport.lua T.SlotOnly; T.Poll reads the bells only with T.StripOut). So
  // while the talking session's mode is stream or reload, no ring, re-ring or beat sounds: each is a
  // bell removed and made again 3 s later in AddOns, on the main thread, up to 15 re-rings a publish,
  // that nothing heard. The push counter, its persistence and pushAt go on as before. The mode is the
  // last one the session said (its hello's mode=, or a mode seen's), else its hello's as kept in the
  // token (a restart); a record of it read off the strip without one says the strip is drawn, which
  // only pixel mode does (stream and reload draw a mode seen alone, and only for its few seconds). An
  // addon that says no mode (an older one) is rung as ever, and so is the start's ring for what's unread.
  const SESSION_MODES = new Set(['pixel', 'stream', 'reload']);
  const saidModes = new Map(); // `${token}/${nonce}` -> mode, for the last few sessions
  function noteSessionMode(r, via) {
    if (typeof r?.token !== 'string' || typeof r.nonce !== 'string') return;
    const key = `${r.token}/${r.nonce}`;
    const said = SESSION_MODES.has(r.args?.mode) ? r.args.mode : null;
    if (said) {
      saidModes.set(key, said);
      // The talking session's said mode is kept with its token too, so a restart or a relaunch reads
      // the addon's off (the capture gate, setup, Your data; SY-12), not only its first hello's.
      const t = S.tokens[r.token];
      if (t && t.nonce === r.nonce && t.mode !== said) { t.mode = said; store.saveState(); }
    } else if (via === 'strip' && saidModes.get(key) !== 'pixel') saidModes.set(key, 'pixel');
    else return;
    while (saidModes.size > 8) saidModes.delete(saidModes.keys().next().value);
  }
  /** The talking session's mode (pixel, stream, reload), or null before any session is known. */
  function sessionMode() {
    const t = S.lastToken ? S.tokens[S.lastToken] : null;
    if (!t) return null;
    return saidModes.get(`${S.lastToken}/${t.nonce}`) ?? t.mode ?? null;
  }
  function bellsHeard() {
    const mode = sessionMode();
    return mode !== 'stream' && mode !== 'reload';
  }
  // The host hears when the talking session's mode changes (boot stops the capture helper while the
  // addon's Screen Reading is off, SF-01), once a batch of records is handled.
  let modeTold;
  let modeCheck = false;
  function tellSessionMode() {
    modeCheck = false;
    const m = sessionMode();
    if (m === modeTold) return;
    modeTold = m;
    try { deps.onSessionMode?.(m); } catch { /* the host's hook never breaks the bridge */ }
  }
  function queueModeCheck() { if (!modeCheck) { modeCheck = true; queueMicrotask(tellSessionMode); } }

  const publisher = createPublisher({ store, signals, addonsDir, buildSlot, log, slotCount, now,
    range: publishRange, written: slotsWritten, heard: bellsHeard, ...(deps.publisherOpts || {}), worker: writer });

  function record(rec, { push = true, map = false } = {}) {
    const r = store.addRecord(rec, now());
    pruneRecords();
    publisher.publish({ push, map });
    return r;
  }

  // The records ring (final review L5-1): the published replies, real names and all, go with the
  // chat's transcript (a forget, "delete all") and after the same retention, once every token has
  // read them.
  const DAY_MS = 24 * 3600 * 1000;
  function retentionDays() {
    const d = Number(config.byok?.transcripts?.retentionDays);
    return Number.isInteger(d) && d >= 1 ? d : 30;
  }
  function pruneRecords() {
    const cutoff = now() - retentionDays() * DAY_MS;
    const oldest = store.records[0];
    if (!oldest || (oldest._at ?? 0) >= cutoff) return 0;
    const n = store.pruneRecords(cutoff);
    if (n) log('records-pruned', { count: n });
    return n;
  }
  // Tokens and chats not heard from within the same retention go (code health BR-12): an old install's
  // token, a chat the game no longer shows, with their cursors, labels, the companion's state and
  // quest-title cache for them, and the per-chat maps, were kept for good. Never the token talking now,
  // nor a chat with a message waiting or a run out. A chat from before chats kept when they were seen
  // starts its clock at its first look here.
  function pruneUnseen() {
    const cutoff = now() - retentionDays() * DAY_MS;
    let tokens = 0, chats = 0;
    for (const [id, tk] of Object.entries(S.tokens)) {
      if (id === S.lastToken || (tk?.lastSeen ?? 0) >= cutoff) continue;
      delete S.tokens[id];
      delete comp.states[id];
      delete comp.heard[id];
      delete comp.titles[id];
      questLogSeen.delete(id);
      heardSaved.delete(id);
      tokens += 1;
    }
    for (const [id, c] of Object.entries(S.chats)) {
      if (!Number.isFinite(c?.seen)) { if (c) c.seen = now(); continue; }
      if (c.seen >= cutoff || store.outbox.some(o => o.chat === id) || Object.values(S.inflight).some(x => x.chat === id)) continue;
      delete S.chats[id];
      dropChatMaps(id);
      chats += 1;
    }
    if (tokens || chats) {
      log('state-pruned', { tokens, chats });
      saveComp();
    }
    store.saveState();
    return { tokens, chats };
  }
  /** A chat's entries in the per-chat maps (a forget, a chat pruned). */
  function dropChatMaps(chatId) {
    busy.delete(chatId);
    queued.delete(chatId);
    heardAt.delete(chatId);
  }
  /** Forget the records of one chat (a chat id) or of every chat (null). */
  function forgetChatRecords(chatId = null) {
    const n = store.forgetRecords(r => (chatId === null ? typeof r.chat === 'string' && r.chat !== '' : r.chat === chatId));
    if (n) log('records-forgotten', { chat: chatId ?? 'all', count: n });
    return n;
  }

  // ---------------------------------------------------------------- tokens
  function ensureToken(token) {
    let t = S.tokens[token];
    if (!t) {
      // A new token starts at the current head (PROTOCOL §2.4 hello).
      t = S.tokens[token] = { nonce: '', nonces: [], startSeq: S.seq, lastReported: S.seq, maxReported: S.seq, ctx: null,
        sendCounter: 0, acked: [], readPush: S.push, firstSeen: now(), lastSeen: now() };
      log('token-new', { token });
    }
    t.lastSeen = now();
    return t;
  }

  // The ack goes into bridge.acked, and push rings so the addon reads it (§3.1).
  // The addon draws a record until it's acked, so copies keep arriving: a key
  // already in the list doesn't ring again (re-rings cover a missed ring).
  // soon: the ack that starts a turn (a msg or an evt taken) rings within ackRingMs(), or with the
  // turn's first ringing publish (PF-02); every other ack rings at once.
  function ackRingMs() {
    const v = config.transport?.ackRingMs;
    if (Number.isFinite(v) && v >= 0) return v;
    return ACK_RING_MS;
  }
  function noteAck(token, key, { soon = false } = {}) {
    const t = S.tokens[token];
    if (!t) return;
    const had = (t.acked || []).includes(key);
    t.acked = [...(t.acked || []).filter(k => k !== key), key].slice(-ACKED_KEEP);
    if (had) return;
    if (soon) publisher.pushWithin(ackRingMs());
    else publisher.publish({ push: true });
  }

  // The addon has read up to push counter p (seen p=, §3): no more re-rings for it.
  // A p past ours means this state is newer than what it read (state.json lost or
  // new): counting goes on from its number, or it would take new rings for old ones.
  function notePushRead(t, p) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) return;
    // A push counter past the store's own: the store started over under this addon (catchUp).
    store.catchUp({ push: n });
    if (n <= (t.readPush || 0)) return;
    t.readPush = Math.min(n, S.push);
    store.saveState();
  }

  // ---------------------------------------------------------------- records in
  function handlePayload(text, via = 'strip') {
    lastPayloadAt = now();
    // A strip read off the screen: the game is running (SY-30).
    if (via === 'strip') { lastStripAt = lastPayloadAt; setGame('up', 'strip'); }
    const { records, rejected } = parsePayload(text);
    for (const r of rejected) onRejected(r, via);
    try {
      // One record that throws (BR-11: a write the store couldn't make used to) never drops the rest.
      for (const r of records) {
        try { handleRecord(r, via); } catch (e) { log('record-error', { type: r.type, key: r.key || null, via, error: String(e?.message || e).slice(0, 120) }); }
      }
    } finally {
      // The strip was read (R6): after its records, so a new session's hello has started its ring count.
      if (via === 'strip') health?.strip(records);
    }
  }

  // A record the bridge can't take is logged. A keyed one whose token and key
  // are good is acked anyway: the addon draws a record until it's acked, so
  // otherwise it would stay on the strip for good (0.4.0-0.4.4's upd, no cur).
  function onRejected(r, via) {
    log('record-rejected', { reason: r.reason, via, key: r.key || null });
    if (r.token && r.key) noteAck(r.token, r.key);
  }

  function handleRecord(r, via = 'strip') {
    const t = ensureToken(r.token);
    // The token talking now is the one the slot files are written for.
    if (S.lastToken !== r.token) { S.lastToken = r.token; store.saveState(); }
    const cursorMoved = store.reportCursor(r.token, r.args.cur);
    if (r.args.p !== undefined) notePushRead(t, r.args.p);
    windowEvidence(t, r, via);
    // The watchdog keeps each UI session's mode (mode=, from its hello and any record carrying it), how
    // its hello came, and whether its slots ran out (SY-12, SY-17b). t.mode below is for status only.
    health?.record(r, via);
    if (r.type === 'hello') return onHello(r, t, via);
    if (r.type === 'seen') { if (cursorMoved) { store.saveState(); publisher.publish({}); } return; }
    if (r.type === 'state') return onState(r);
    // Keyed records: dedupe by (token, key) for 7 days; a duplicate is acked again.
    if (!store.firstTime(r.token, r.key, now())) {
      noteAck(r.token, r.key);
      if (cursorMoved) publisher.publish({});
      return;
    }
    // Read from SavedVariables first, never off the strip: the watchdog judges the write it came in (R4').
    if (writeFirst && via === 'reload') writeFirst.push({ token: r.token, nonce: r.nonce, key: r.key, type: r.type });
    if (r.type === 'msg') return onMsg(r, t, via);
    if (r.type === 'stop') return onStop(r);
    if (r.type === 'patch') return onPatch(r);
    if (r.type === 'forget') return onForget(r);
    if (r.type === 'evt') return onEvt(r, t, via);
    if (r.type === 'upd') return onUpd(r);
    if (r.type === 'vc') return onVoiceCommand(r, via);
  }

  function onHello(r, t, via) {
    const first = t.nonce !== r.nonce;
    t.nonce = r.nonce;
    if (first) t.nonces = [...(t.nonces || []).filter(n => n !== r.nonce), r.nonce].slice(-3);
    if (first) anchorWindow(t, r, via);
    t.ver = r.args.ver; t.build = r.args.build; t.iface = r.args.iface; t.sig = r.args.sig; t.slots = Number(r.args.slots) || null;
    // How this session's records reach us (SY-04): mode= from a later addon (pixel, stream or reload:
    // /bones mode reload is "no screen reading"), and the way this hello came (strip, or reload: read
    // from SavedVariables, so the screen wasn't read for it).
    if (first) {
      t.mode = ['pixel', 'stream', 'reload'].includes(r.args.mode) ? r.args.mode : undefined;
      t.helloVia = via;
    }
    t.helloAt = now();
    // Setup's rows (onboarding spec §9.3): the game's locale (deDE) and fr=1, an addon that already
    // had a first reply (a shared SavedVariables). fr never sets firstReplyAt: only a reply here does.
    t.loc = /^[a-z]{2}[A-Z]{2}$/.test(r.args.loc || '') ? r.args.loc : undefined;
    t.fr = r.args.fr === '1' ? true : undefined;
    if (t.fr) S.firstReplyBefore = true;
    t.sendCounter = Math.max(t.sendCounter || 0, Number(r.args.n) || 0);
    if (r.args.ctx === '1') t.ctx = r.body || null; else if (r.args.ctx === '0') t.ctx = null;
    // The first meeting (onboarding spec §9.3): the client's locale, for the first reply's
    // language, and fr=1 when the addon already had a first reply (never firstReplyAt).
    const loc = String(r.args.loc ?? '');
    if (LOCALE_RE.test(loc)) t.loc = loc;
    if (String(r.args.fr ?? '') === '1') S.firstReplyBefore = true;
    S.lastToken = r.token;
    if (first) gameExitedAt = 0; // a new UI session: the game is running again
    if (/^[0-9a-f]{16}$/.test(r.args.sid || '')) {
      t.sid = r.args.sid;
      heardSession(r.token, r.args.sid);
    }
    // The client's own interface number (patch day, SY-29): the host sets the
    // installed TOCs to it when they differ, before the check below reads them.
    if (t.iface && typeof deps.onClientInterface === 'function') { try { deps.onClientInterface(String(t.iface)); } catch { /* the host's business */ } }
    checkVersions(t);
    store.saveState();
    if (first) log('hello', { token: r.token, nonce: r.nonce, via, ver: t.ver, build: t.build, sig: t.sig, slots: t.slots, ctx: !!t.ctx });
    // The answer is bridge.nonce in the next slot; push rings once per nonce so the
    // addon reads it (later copies of the hello are re-rung by reRing, §3).
    publisher.publish({ push: first, map: first });
  }

  function checkVersions(t) {
    const problems = [];
    if (t.ver && t.ver.split('.')[0] !== BRIDGE_VERSION.split('.')[0]) problems.push(`addon ${t.ver} vs bridge ${BRIDGE_VERSION}`);
    // A host that sets the installed TOCs to the game's number itself (onClientInterface: the app,
    // SY-29) says so in its own words (the app's line, and the addon's own when that failed,
    // bridge.patch); without one, this line.
    const slotIface = deps.slotInterface && typeof deps.onClientInterface !== 'function' ? deps.slotInterface() : null;
    if (slotIface && t.iface && slotIface !== t.iface) problems.push(`slot addons are for interface ${slotIface}, the client is ${t.iface}: quit WoW, install the addon again and start WoW`);
    warn = problems.length ? problems.join('; ') : null;
    if (warn) log('version-warn', { warn });
  }

  function ensureChat(chatId, token, { agent, name } = {}) {
    // KY-10 (the old audit's KB-03): a name shaped like an API key (the addon titles a chat after its
    // first words, capitalized) is never kept, published or synced: the chat keeps the label it had.
    if (name && (typedLooksLikeKey(String(name)) || typedLooksLikeKey(String(name).toLowerCase()))) name = '';
    // Kept inert (TH12, the old audit's LS-11): no game escape or `|` from a forged name, 64 code points.
    if (name) name = sanitizeGameString(String(name), 64);
    let c = S.chats[chatId];
    if (!c) {
      const a = (agent && /^[a-z0-9_-]{1,32}$/.test(agent)) ? agent : defaultAgent;
      // key: the session key an older build routes this chat's events by, kept so state.json still
      // works for one (this one calls the backend by chat id: code health BR-22).
      c = S.chats[chatId] = { id: chatId, key: `agent:${a}:wow:${chatId}`, agent: a, label: name || '', started: false, created: now(), token };
    }
    if (name && name !== c.label) c.label = name;
    c.token = token;
    c.seen = now(); // pruneUnseen's clock
    return c;
  }

  function onMsg(r, t, via) {
    // Every refusal below comes before the chat exists or takes the message's name (code health BR-12,
    // the old audit's KA-03): the addon titles a new chat after its first words, so a refused message
    // (a key) leaves no chat and no label in state.json, the slots or byok-chats.json.
    // "[NeverQuestAlone" starts only what the bridge itself writes (game events and
    // session recaps), so typed text can't pass for one (TB5).
    if (/^\s*\[NeverQuestAlone/i.test(r.text || '')) {
      noteAck(r.token, r.key);
      store.saveState();
      record({ t: 'error', chat: r.chat, kind: 'refused', text: 'Not sent: messages can\'t start with "[NeverQuestAlone". That marks game events.' });
      log('msg-refused', { key: r.key, chat: r.chat, reason: 'reserved prefix' });
      return;
    }
    // KY-10: a message that looks like an API key is never sent or saved. The addon refuses it
    // first; a record that got past it (a forged one, an older addon) stops here, before the outbox.
    if (typedLooksLikeKey(r.text || '')) {
      noteAck(r.token, r.key);
      store.saveState();
      record({ t: 'error', chat: r.chat, kind: 'refused', text: KEY_REFUSED, action: 'none' });
      log('msg-refused', { key: r.key, chat: r.chat, reason: 'looks like an API key' });
      return;
    }
    // The typed guard (systems plan D4): past 20 typed messages in a minute, sending pauses
    // until Resume sending in the desktop app. A message while it holds is answered with the line and
    // not kept, so a loop's copies never go later. One read from SavedVariables counts only toward a
    // runaway (reloadHolds; code health BR-02: they skipped the guard, and 200 in one write started
    // 184 paid turns), so normal reload play never trips it.
    if (guard.on) {
      const held = via === 'reload' ? reloadHolds() : guardHolds();
      if (held) {
        noteAck(r.token, r.key);
        store.saveState();
        const l = sendPausedLine(guard.pausedBy ?? guardLimits);
        record({ t: 'error', chat: r.chat, kind: 'send_paused', text: `${l.headline} ${l.detail}`, action: 'desktop' });
        log('msg-refused', { key: r.key, chat: r.chat, reason: 'sending is paused (the typed guard)' });
        return;
      }
    }
    const c = ensureChat(r.chat, r.token, { agent: r.args.agent, name: r.args.name });
    if (r.context !== null && r.context !== undefined) t.ctx = r.context || null;
    const item = { token: r.token, key: r.key, chat: r.chat, kind: 'msg', text: r.text, st: /^\d+$/.test(r.args.st || '') ? Number(r.args.st) : null, context: r.context ?? null, firstSeen: now(), attempts: 0, via };
    // bare=1: the player left the game data out of this one message (0.3.1).
    if (r.args.bare === '1') item.bare = true;
    // The first meeting: Say Hi's "hi" (intro=1) before any first reply gets the pack's
    // first-meeting rule and its one chip; once a first reply exists, intro is ignored.
    if (r.args.intro === '1' && !S.firstReplyAt) item.intro = true;
    if (!S.firstMsgAt) S.firstMsgAt = now();
    store.addOutbox(item); // persisted before the ack (SE-2: ack on receipt, after persist)
    if (!S.firstMsgAt) S.firstMsgAt = now(); // setup's row 4: the first message heard (onboarding spec §9.3)
    // The runaway fuse: a typed message, in any chat, turns automatic help back on
    // (spec §9.9), and the events it held go with the next message that carries game data
    // (composeTurn). The addon hears it at once (a ring): it sends no events while the slot says
    // it's paused.
    const resumed = resetFuse(c);
    noteAck(r.token, r.key, { soon: true });
    if (busy.has(c.id)) queued.set(c.id, (queued.get(c.id) || 0) + 1);
    store.saveState();
    log('msg', { key: r.key, chat: r.chat, bytes: Buffer.byteLength(r.text || ''), via });
    publisher.publish({ push: resumed });
    sendInOrder(item);
  }

  // An upd from an older addon (its window's Check for Updates, /bones update): acked, and nothing
  // else. The desktop app's updater keeps the addon up to date; this addon sends none.
  function onUpd(r) {
    noteAck(r.token, r.key);
    store.saveState();
  }

  // A voice command from the addon's buttons or keys (cap voice; odd/tasks/nqa-voice-controls.md T2):
  // the newest goes to <bridge>/voice-control.json, numbered, where the voice companion's page reads it.
  // A command is only for now: one read from SavedVariables after a reload, or one the addon stamped
  // (at=, its time()) more than VOICE_COMMAND_MAX_AGE_S ago, is acked and never applied (Astra review 6).
  // The file is written (retried on Windows' passing locks) before the ack, so a failed write is
  // logged with the command instead of lost behind an ack (review 4).
  let voiceCmdN = 0;
  const voiceRetry = createRetrier();
  function onVoiceCommand(r, via) {
    const cmd = String(r.args.cmd || '');
    const at = Number(r.args.at);
    const stale = via === 'reload' || !Number.isFinite(at) || Math.abs(now() / 1000 - at) > VOICE_COMMAND_MAX_AGE_S;
    // persona carries a name from the fixed list; any other name isn't a command.
    const persona = cmd === 'persona' ? String(r.args.name || '') : undefined;
    const known = VOICE_COMMANDS.includes(cmd) && (cmd !== 'persona' || VOICE_PERSONAS.includes(persona));
    // read on|off (T16) is the bridge's own switch: new replies' summaries go to the voice to be said.
    if (cmd === 'read' && !stale) {
      const on = r.args.on === '1';
      try {
        const file = path.join(stateDir, VOICE_READ);
        const tmp = `${file}.tmp`;
        voiceRetry.run(() => fs.writeFileSync(tmp, JSON.stringify({ v: 1, on, at: now() }), { mode: 0o600 }));
        voiceRetry.run(() => fs.renameSync(tmp, file));
        voiceReadOn = on;
        log('voice-command', { cmd, on });
      } catch (e) { log('voice-command', { cmd, applied: false, error: e.code || String(e.message || e) }); }
    } else if (known && cmd !== 'read' && !stale) {
      const file = path.join(stateDir, VOICE_CONTROL);
      if (!voiceCmdN) { try { voiceCmdN = Number(JSON.parse(fs.readFileSync(file, 'utf8')).n) || 0; } catch { voiceCmdN = 0; } }
      try {
        const tmp = `${file}.tmp`;
        voiceRetry.run(() => fs.writeFileSync(tmp, JSON.stringify({ v: 1, n: voiceCmdN + 1, cmd, persona, at: now() }), { mode: 0o600 }));
        voiceRetry.run(() => fs.renameSync(tmp, file));
        voiceCmdN += 1;
        log('voice-command', { cmd, n: voiceCmdN });
      } catch (e) { log('voice-command', { cmd, applied: false, error: e.code || String(e.message || e) }); }
    } else {
      log('voice-command', { cmd: known ? cmd : 'bad', applied: false, via, stale: stale || undefined });
    }
    noteAck(r.token, r.key);
    store.saveState();
    publisher.publish({ push: true });
  }
  // Whether the voice reads replies aloud (T16), from <bridge>/voice-read.json, kept across restarts.
  let voiceReadOn = null;
  function voiceReads() {
    if (voiceReadOn === null) { try { voiceReadOn = JSON.parse(fs.readFileSync(path.join(stateDir, VOICE_READ), 'utf8')).on === true; } catch { voiceReadOn = false; } }
    return voiceReadOn;
  }
  // A reply's summary for the voice to say (only while it reads replies, never a voice reply itself):
  // one small JSON file each in <bridge>/voice-say/, written aside and renamed in; at most VOICE_SAY_MAX.
  // Which check-ins the voice says by itself (odd/tasks/nqa-brain.md B10, S6): only the important ones
  // (training at a level-up, gear about to break, bags full), at most one every VOICE_NUDGE_GAP_MS; a reply
  // to something the player asked is always said. Recaps and the rest stay in the window.
  let lastNudgeAt = 0;
  function voiceSays({ turn, event } = {}) {
    if (turn === 'msg' || turn == null) return true;
    if (turn !== 'evt' || !VOICE_NUDGE_KINDS.includes(event)) return false;
    if (now() - lastNudgeAt < VOICE_NUDGE_GAP_MS) { log('voice-say', { skipped: event, reason: 'gap' }); return false; }
    lastNudgeAt = now();
    return true;
  }
  function queueVoiceSay(summary, why = {}) {
    if (!voiceReads()) return;
    if (!voiceSays(why)) return;
    const text = String(summary || '').replace(/\|c[0-9a-fA-F]{8}|\|r/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, VOICE_SAY_TEXT_MAX);
    if (!text) return;
    try {
      const dir = path.join(stateDir, VOICE_SAY);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const names = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
      for (const old of names.slice(0, Math.max(0, names.length - VOICE_SAY_MAX + 1))) fs.rmSync(path.join(dir, old), { force: true });
      const id = crypto.randomUUID();
      const name = `${String(now()).padStart(14, '0')}-${id}.json`;
      const tmp = path.join(dir, `.${name}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, id, text, at: now() }), { mode: 0o600 });
      fs.renameSync(tmp, path.join(dir, name));
    } catch (e) { log('voice-say', { error: e.code || String(e.message || e) }); }
  }
  // What the voice companion says it is doing ({state, at}), for the addon; old or missing is off.
  function voiceStatus() {
    let out = { state: 'off' };
    try {
      const j = JSON.parse(fs.readFileSync(path.join(stateDir, VOICE_STATUS), 'utf8'));
      const age = now() - Number(j.at);
      if (VOICE_STATES.includes(j.state) && age >= -5000 && age <= VOICE_STATUS_FRESH_MS) {
        out = VOICE_PERSONAS.includes(j.persona) ? { state: j.state, persona: j.persona } : { state: j.state };
      }
    } catch { /* no voice companion */ }
    // The voice asked for bags and gear (odd/tasks/nqa-voice-controls.md T15, S7): a growing number the
    // addon answers once with a state that keeps them; only while the request is fresh.
    try {
      const w = JSON.parse(fs.readFileSync(path.join(stateDir, VOICE_WANT), 'utf8'));
      const age = now() - Number(w.at);
      if (Number.isInteger(w.n) && w.n > 0 && age >= -5000 && age <= VOICE_WANT_FRESH_MS) out.want = w.n;
    } catch { /* nothing asked */ }
    if (voiceReads()) out.read = true; // the voice reads replies aloud (T16): the bar shows it
    return out;
  }

  // A stop finds a turn in one of two places (code health BR-22): still in the outbox, where it's taken
  // back, or with the backend, whose send put it on the run queue before it returned, so one abort
  // reaches it there, running or waiting (a waiting one is dropped, unbilled). No send is ever on its
  // way for a stop to wait for.
  function onStop(r) {
    noteAck(r.token, r.key);
    store.saveState();
    publisher.publish({});
    const c = S.chats[r.chat];
    if (!c) return;
    const waiting = store.outbox.filter(o => o.chat === c.id);
    for (const o of waiting) {
      store.removeOutbox(o.token, o.key);
      record({ t: 'aborted', chat: c.id, kind: 'user', text: `Stopped before it went to ${companionName()}.` });
    }
    const inFlight = () => Object.values(S.inflight).some(x => x.chat === c.id);
    if (waiting.length && !inFlight() && !busy.has(c.id)) {
      log('stop', { chat: r.chat, cancelled: waiting.length });
      publisher.publish({ push: true });
      return;
    }
    try {
      const res = gateway.abort(c.id);
      log('stop', { chat: r.chat, aborted: !!res?.aborted });
      // A run the backend no longer has ends with its own event (or the safety net's outcomes()).
      if (!res?.aborted && !busy.has(c.id) && !inFlight()) record({ t: 'error', chat: c.id, kind: 'stop', text: 'Nothing was running.' });
    } catch (e) {
      record({ t: 'error', chat: c.id, kind: 'gateway', text: systemLine(`Couldn't stop: ${gwProblem() || e.message}`) });
    }
  }

  function onPatch(r) {
    noteAck(r.token, r.key);
    // agent: a think patch can come before the chat's first msg, and creates it with the right agent.
    const c = ensureChat(r.chat, r.token, { agent: r.args.agent, name: r.args.label });
    if (r.args.think !== undefined) setThink(c, r.args.think);
    // Before the publish: the snapshot then says whether the model took (chats[].model).
    if (r.args.model !== undefined) setModel(c, r.args.model);
    store.saveState();
    // The ack above rang already; a model patch rings again, since its answer (chats[].model) may
    // come after that ring's slot was written, and the addon reads a slot only when one rings.
    publisher.publish({ push: r.args.model !== undefined && typeof gateway?.chatSlot === 'function' });
  }

  // /bones model <id> (UX-6, cap model): the chat's own model from its next turn ('default': the
  // provider's again). Only a backend that keeps one per chat takes it (BYOK: setChatModel); one it
  // doesn't offer gets the model_not_found line, which ends the addon's "asked for" (Chats.lua).
  // Nothing is changed then.
  const MODEL_ARG = /^[A-Za-z0-9._:/-]{1,80}$/;
  function setModel(c, value) {
    const v = String(value ?? '').trim();
    if (typeof gateway?.chatSlot !== 'function' || typeof gateway?.setChatModel !== 'function') { log('model-unsupported', { chat: c.id }); return; }
    if (!MODEL_ARG.test(v) || looksLikeKey(v)) { log('model-invalid', { chat: c.id }); return; }
    const model = v.toLowerCase() === 'default' ? null : v;
    let res;
    try {
      res = gateway.setChatModel(c.id, model);
    } catch (e) {
      log('model-error', { chat: c.id, error: String(e?.message || e).slice(0, 120) });
      return;
    }
    if (res?.ok === false) {
      log('model-refused', { chat: c.id, error: String(res.error || '').slice(0, 40) });
      // answers: 'none': it answers the /bones model, not a message, so the addon pops no pending
      // send for it (a message still running in the chat gets its own answer).
      record({ t: 'error', chat: c.id, kind: 'model_not_found', action: 'none', answers: 'none',
        text: systemLine(`${model} isn't one of the ${backendName()} models you can pick. Nothing was changed. See them in the NeverQuestAlone app.`) });
      return;
    }
    log('model', { chat: c.id, model: model ?? 'default' });
  }

  // How hard Bones thinks in a chat (owner decision, 2026-09-25): a chat's /bones think goes with each
  // of its turns as send's `thinking`, which outranks the player's effort (byok.effort) for that
  // turn only; a chat without one sends none, so it runs at the player's effort.
  function thinkLevel(v) { return THINK_LEVELS.includes(String(v ?? '').toLowerCase()) ? String(v).toLowerCase() : null; }
  function thinkFor(c) { return thinkLevel(c?.think); }
  function setThink(c, value) {
    const v = String(value).toLowerCase();
    if (v === 'default') delete c.think;
    else if (thinkLevel(v)) c.think = v;
    // KB-10: whether it looked like a key, never any of it (a key's prefix and first characters were logged).
    else { log('think-invalid', { chat: c.id, keyShaped: looksLikeKey(String(value)) }); return; }
    log('think', { chat: c.id, level: thinkFor(c) || 'agent default' });
  }

  function onForget(r) {
    noteAck(r.token, r.key);
    const c = S.chats[r.chat];
    delete S.chats[r.chat];
    dropChatMaps(r.chat);
    // Its runs go with it: no reply reaches a deleted chat, and the Companion's fixed id
    // would pick an old run up again when that chat comes back.
    for (const [runId, run] of Object.entries(S.inflight)) if (run.chat === r.chat) { delete S.inflight[runId]; checkedAt.delete(runId); }
    forgetChatRecords(r.chat);
    store.saveState();
    publisher.publish({});
    if (!c || !c.started) return;
    // The backend forgets the chat too (its transcript; a turn still going is stopped). The companion's
    // chat (one fixed id, PROTOCOL §2.6) is forgotten as any chat: its next turn starts it again.
    try {
      gateway.forget(c.id);
      log('forget', { chat: r.chat });
    } catch (e) {
      log('forget-error', { chat: r.chat, error: String(e.message).slice(0, 120) });
    }
  }

  // ---------------------------------------------------------------- game state and events (the companion)
  // PROTOCOL §2.6, companion PRD F1/F3/F4/F6. The addon's state (JSON) is kept
  // per token; a game event becomes a turn for Bones in the Companion chat: the raw turn carries the
  // event and the state, and the backend writes the fixed event line and the game data block. No
  // daily cap: only the runaway fuse (AUTO_FUSE).
  const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  // An automatic turn held back while the runaway fuse holds: no turn; it goes along with the next
  // typed message (F3), at most 5 kept.
  function rideAlong(token, summary) {
    ev.ride[token] = [...(ev.ride[token] || []), summary].slice(-5);
    saveEv();
  }
  // The runaway fuse (bridge/byok/usage/fuse.mjs, spec §9.9). An automatic turn's
  // send time: the evt's at= (the addon's time(), whole epoch seconds) in ms; the arrival time when
  // at= is missing, not a whole number or later than arrival. So a backlog that arrives at once
  // (the reload path, capture or the bridge back after a gap) counts at its 120 s spacing.
  const sentAtOf = (at) => {
    const t = now();
    const s = String(at ?? '');
    if (!/^\d{1,12}$/.test(s)) return t;
    const ms = Number(s) * 1000;
    return ms > t ? t : ms;
  };
  // One automatic turn (an event, a session recap) about to start at sentAt: null when it goes;
  // else it's held ({tripped: true} for the turn that paused automatic help). The fuse's state is
  // saved with the rest of companion-events.json, so a restart keeps its window and a pause.
  function fuseHolds(sentAt) {
    const was = fuse.paused;
    const ok = fuse.allow(sentAt);
    ev.autoFuse = fuse.snapshot();
    saveEv();
    if (ok) return null;
    // The count, never game text.
    log('auto-fuse', { held: fuse.held, trips: fuse.trips, ...(was ? {} : { paused: true, turns: fuse.pausedBy?.turns, windowMs: fuse.pausedBy?.windowMs }) });
    if (!was) { try { deps.onAutoPause?.(true); } catch { /* a listener never breaks the bridge */ } }
    return { tripped: !was };
  }
  // The one line in the Companion chat when the fuse pauses automatic help (PRD §10): Okay, no
  // Retry (action 'none'), and it answers no pending send (the held events ride along).
  function autoPausedRecord(c) {
    record({ t: 'error', chat: c.id, kind: 'auto_paused', text: autoPausedLine(companionName()), action: 'none', answers: 'none' });
  }
  /**
   * A typed message coming in (off the strip): null when it may go; while the typed guard
   * holds, {tripped} (true for the one that paused sending). Saved with companion-events.json, so a
   * restart keeps a pause.
   */
  function guardHolds() {
    const was = guard.paused;
    const ok = guard.allow(now());
    ev.typedGuard = guard.snapshot();
    saveEv();
    if (ok) return null;
    log('send-paused', { held: guard.held, trips: guard.trips, ...(was ? {} : { paused: true, turns: guard.pausedBy?.turns, windowMs: guard.pausedBy?.windowMs }) });
    if (!was) {
      // What the backend has queued waits too, until Resume sending (code health BR-03).
      holdBackend(true);
      try { deps.onSendPause?.(true); } catch { /* a listener never breaks the bridge */ }
    }
    return { tripped: !was };
  }
  /**
   * A new typed record read from SavedVariables (code health BR-02): the player typed it before the
   * write, over any stretch of time, so the guard's 20 a minute (the strip's) says nothing of it, and a
   * /reload every few seconds with a few messages, or two of ten a minute apart, never trips anything.
   * A runaway does: more than the guard's 20 new ones in ONE write, or more than RELOAD_RUNAWAY (60 a
   * minute, at their files' write times) across writes, trips the same guard, with its line, Resume
   * sending and its hold on what's queued. While it holds, a reload record waits like the rest.
   */
  function reloadHolds() {
    if (guard.paused) return guardHolds();
    const w = svWrite;
    const inWrite = w ? (w.typed = (w.typed || 0) + 1) : 0;
    const steady = reloadRunaway.allow(heardAtFile ?? now());
    if (inWrite <= guardLimits.turns && steady) return null;
    reloadRunaway.reset();
    return tripGuard(inWrite > guardLimits.turns ? 'write' : 'runaway');
  }
  /** The typed guard paused from outside its own count: its machine as its own trip leaves it (the snapshot taken back). */
  function tripGuard(why) {
    const s = guard.snapshot();
    guard = createAutoFuse({ ...guardLimits, now,
      state: { ...s, times: [], paused: true, pausedAt: now(), held: 1, by: { turns: guardLimits.turns, windowMs: guardLimits.windowMs }, trips: (s.trips || 0) + 1 } });
    ev.typedGuard = guard.snapshot();
    saveEv();
    log('send-paused', { held: guard.held, trips: guard.trips, paused: true, turns: guard.pausedBy?.turns, windowMs: guard.pausedBy?.windowMs, reload: why });
    holdBackend(true);
    try { deps.onSendPause?.(true); } catch { /* a listener never breaks the bridge */ }
    return { tripped: true };
  }
  /** The typed guard's hold on the backend's queued turns (BR-03); a backend without one has none. */
  function holdBackend(on) {
    try { gateway?.holdRuns?.(on); } catch (e) { log('send-hold-error', { error: String(e?.message || e).slice(0, 120) }); }
  }
  /** The desktop app's Resume sending: the only way the typed guard ends. True if it held. */
  function resumeSending() {
    const was = guard.reset();
    reloadRunaway.reset();
    ev.typedGuard = guard.snapshot();
    saveEv();
    if (!was) return false;
    log('send-paused', { resumed: true, trips: guard.trips });
    holdBackend(false);
    try { deps.onSendPause?.(false); } catch { /* a listener never breaks the bridge */ }
    publisher.publish({ push: true }); // the slot says it's over (bridge.usage.sendPaused goes)
    return true;
  }
  /** A typed message: the fuse resets (true when it had paused automatic help). */
  function resetFuse(c) {
    const had = fuse.snapshot();
    const was = fuse.reset();
    if (!was && !had.times?.length) return false;
    ev.autoFuse = fuse.snapshot();
    saveEv();
    if (!was) return false;
    log('auto-fuse', { resumed: true, chat: c.id, trips: fuse.trips });
    try { deps.onAutoPause?.(false); } catch { /* a listener never breaks the bridge */ }
    return true;
  }
  // The keys a level-up is known by: its session (sid, which a /reload keeps)
  // and, once a state names the character, that character.
  const levelKeys = (token, sid, to) => {
    const keys = [];
    if (/^[0-9a-f]{16}$/.test(sid || '')) keys.push(`s:${sid}:${to}`);
    const s = comp.states[token];
    const c = s && s.state && s.state.char;
    if (c && c.name && (!sid || s.sid === sid)) keys.push(`c:${c.name}-${c.realm || '?'}:${to}`);
    return keys.length ? keys : [`t:${token}:${to}`];
  };

  function onState(r) {
    // off=1, no body: the player turned check-ins off (/bones companion off, PROTOCOL §2.6). The
    // state held for that token goes, so no turn carries it again, and bridge.stateSeq leaves the
    // slot, which is how the addon knows it was heard.
    if (r.args.off === '1') return stateOff(r.token);
    // z=1: the JSON came deflated (cap z). Inflated first, so what's kept is exactly what the same
    // state sent plain gives.
    const z = r.args.z === '1';
    const body = z ? inflateBody(r.body, { maxBody: STATE_BODY_MAX, maxText: STATE_JSON_MAX }) : { ok: true, text: r.body };
    const v = body.ok ? validateState(body.text) : body;
    if (!v.ok) { log('state-rejected', { token: r.token, reason: v.reason, bytes: Buffer.byteLength(String(r.body || '')), z: z || undefined }); return; }
    heardSession(r.token, v.state.sid);
    const cur = comp.states[r.token];
    if (cur && cur.sid === v.state.sid && cur.seq >= v.state.seq) return; // not newer
    const newSession = cur && cur.sid !== v.state.sid;
    // Titles the addon shortened to fit get the whole title an earlier state sent
    // (cap qlog). Everything reads the filled state.
    const f = fillTitles(v.state, comp.titles[r.token]);
    comp.titles[r.token] = f.cache;
    comp.states[r.token] = { sid: v.state.sid, seq: v.state.seq, state: f.state, at: now() };
    saveComp();
    // How much of the quest log came (counts only): the game's cap as the addon read it,
    // quests the game listed with no id yet, titles still cut. Logged when it changes.
    const st = f.state;
    if (Array.isArray(st.quests)) {
      const ql = { token: r.token, count: st.quests.length, max: st.questMax ?? null, unread: st.questUnread || 0, cut: f.stillCut.length };
      const key = JSON.stringify(ql);
      if (questLogSeen.get(r.token) !== key) { questLogSeen.set(r.token, key); log('quest-log', ql); }
    }
    publisher.publish({}); // bridge.stateSeq and stateSid; no ring
    if (newSession) log('state-session', { token: r.token, sid: v.state.sid });
    for (const item of [...store.outbox]) {
      if (!item.st || item.token !== r.token || !stateReady(item)) continue;
      const id = `${item.token}:${item.key}`;
      clearTimeout(stTimers.get(id));
      stTimers.delete(id);
      trySend(item);
    }
  }

  // The voice companion's inbox (tools/voice/server.mjs, odd/tasks/nqa-voice.md T7): what was said by
  // voice, and map pins the voice model drew, one JSON file each ({v:1, id, kind:'exchange'|'pins',
  // text}), renamed into place whole by the writer, published into the addon's Companion chat as replies
  // marked voice (the addon doesn't read them aloud again), oldest first, only while a game token is
  // known. Each entry's id is its message id, so an entry read again (a delete that failed, a crash
  // between publishing and deleting) is never published twice (publishReply's isPublished). A reply's
  // map block goes through the same checks as the model's own (publishReply, renderReply).
  const voiceDir = path.join(stateDir, VOICE_INBOX);
  const VOICE_ID_RE = /^[0-9a-f-]{36}$/;
  function drainVoiceInbox() {
    const token = S.lastToken;
    if (!token) return 0;
    // The voice companion's state changed (muted, paused, talking again): the addon's buttons follow.
    const vs = lastVoice && voiceStatus();
    if (vs && (vs.state !== lastVoice.state || vs.persona !== lastVoice.persona || vs.want !== lastVoice.want)) publisher.publish({ push: true }); // rung, so the addon reads it soon (review 5)
    let names = [];
    try { names = fs.readdirSync(voiceDir).filter(f => /^\d{14}-[0-9a-f-]{36}\.json$/.test(f)).sort().slice(0, VOICE_PER_DRAIN); } catch { return 0; }
    let n = 0, bad = 0;
    for (const name of names) {
      const file = path.join(voiceDir, name);
      let e = null;
      try { if (fs.statSync(file).size <= VOICE_FILE_MAX) e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { e = null; }
      const ok = isObj(e) && e.v === 1 && VOICE_ID_RE.test(String(e.id)) && (e.kind === 'exchange' || e.kind === 'pins') && typeof e.text === 'string';
      const text = ok ? e.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, VOICE_TEXT_MAX).trim() : '';
      if (!text) bad += 1;
      else {
        const c = ensureChat(COMPANION_CHAT, token, { agent: defaultAgent, name: 'Companion' });
        if (publishReply(c, { text, __nqa: { id: `voice:${e.id}` } }, { voice: true })) n += 1;
      }
      try { fs.rmSync(file, { force: true }); } catch { /* read again next time: its id keeps it from showing twice */ }
    }
    if (n || bad) log('voice-inbox', { published: n, bad: bad || undefined });
    return n;
  }

  function stateOff(token) {
    if (!comp.states[token]) return;
    delete comp.states[token];
    saveComp();
    log('state-off', { token });
    publisher.publish({}); // bridge.stateSeq and stateSid go; no ring
  }

  function onEvt(r, t, via) {
    const kind = eventSummary(r.args.kind) ? r.args.kind : null;
    const drop = (reason) => {
      noteAck(r.token, r.key);
      store.saveState();
      log('evt-dropped', { key: r.key, event: String(r.args.kind || '').slice(0, 20), reason });
    };
    if (!kind || kind === 'recap') return drop('unknown kind');
    if (r.chat !== COMPANION_CHAT) return drop('not the Companion chat'); // events never land in a chat in use
    if (!companionOn()) return drop('companion off');
    const c = ensureChat(COMPANION_CHAT, r.token, { agent: r.args.agent, name: r.args.name || 'Companion' });
    // One level-up turn per character and level (F3), whatever the addon resends.
    const lkeys = kind === 'level_up' && /^\d+$/.test(r.args.to || '') ? levelKeys(r.token, r.args.sid, r.args.to) : [];
    if (lkeys.some(k => ev.levels[k] != null)) return drop('level already turned');
    const day = localDay(now());
    if (ev.day !== day) { ev.day = day; ev.count = 0; }
    // No daily or zone limit (maintainer, 2026-09-26), only the runaway fuse, counted by the event's send
    // time. While it holds, the event takes no turn and rides along with the next typed message; the
    // one that pauses it writes the one line.
    const held = fuseHolds(sentAtOf(r.args.at));
    if (held) {
      rideAlong(r.token, eventSummary(kind, r.args));
      noteAck(r.token, r.key);
      store.saveState();
      if (held.tripped) autoPausedRecord(c);
      log('evt-held', { key: r.key, event: kind, reason: 'automatic help is paused (the runaway fuse)' });
      return;
    }
    ev.count += 1;
    for (const k of lkeys) ev.levels[k] = now();
    const ks = Object.keys(ev.levels);
    if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delete ev.levels[k];
    saveEv();
    // Its args are game text (RT-11): controls, escapes and | go, 64 characters at most.
    const args = {};
    for (const k of ['from', 'to', 'n', 'layer', 'sid', 'zone']) {
      if (r.args[k] === undefined) continue;
      const v = sanitizeGameString(String(r.args[k]), 64);
      if (v) args[k] = v;
    }
    // Inventory nudges carry only numeric facts, never game text. Slot ids are
    // a bounded comma-separated list because strip args are flat strings.
    if (kind === 'bags_full' || kind === 'gear_breaking') {
      for (const k of ['from', 'to', 'n', 'layer', 'zone']) delete args[k];
      if (kind === 'bags_full' && /^\d{1,4}$/.test(r.args.free || '') && Number(r.args.free) <= 2) args.free = Number(r.args.free);
      if (kind === 'gear_breaking') {
        if (/^\d{1,2}$/.test(r.args.pct || '') && Number(r.args.pct) <= 20) args.pct = Number(r.args.pct);
        const slots = String(r.args.slots || '').split(',');
        if (slots.length <= 19 && slots.every(s => /^(?:[1-9]|1[0-9])$/.test(s))) args.slots = [...new Set(slots)].join(',');
      }
    }
    const item = { token: r.token, key: r.key, chat: c.id, kind: 'evt', event: kind, args, st: /^\d+$/.test(r.args.st || '') ? Number(r.args.st) : null,
      text: '', context: null, firstSeen: now(), attempts: 0, via };
    store.addOutbox(item); // persisted before the ack, as for a msg (SE-2)
    noteAck(r.token, r.key, { soon: true });
    if (busy.has(c.id)) queued.set(c.id, (queued.get(c.id) || 0) + 1);
    store.saveState();
    log('evt', { key: r.key, event: kind, chat: c.id, st: item.st, today: ev.count, via });
    publisher.publish({});
    sendInOrder(item);
  }

  // The session a turn belongs to: the evt's own sid, else the token's latest hello.
  const turnSid = item => (item.args && item.args.sid) || S.tokens[item.token]?.sid || null;
  // The state for a turn: the token's latest, if it's from the turn's session
  // (after a crash or relog the bridge may still hold the last session's). A
  // typed message that names none (st=) gets none: the addon sent none with it
  // (Game Data off, or an older addon), so the one held may be long out of date,
  // and its quest list would read as the whole log now.
  const stateFor = item => {
    if ((item.kind || 'msg') === 'msg' && !item.st) return null;
    const st = comp.states[item.token];
    const sid = turnSid(item);
    return st && (!sid || st.sid === sid) ? st : null;
  };
  // Has the state a turn names (st=) arrived? Its seq or later, from the same session.
  const stateReady = item => { const st = stateFor(item); return !!st && st.seq >= item.st; };

  // What a typed turn carries besides itself, taken at send time: the events the runaway fuse held,
  // which ride along with the next typed message that has game data (F3), once. ride: how many of
  // them this turn takes; notes: their line for the backend's game data block.
  function composeTurn(item) {
    if (item.kind === 'evt' || item.kind === 'recap' || item.bare) return { ride: 0, notes: [] };
    const ride = ev.ride[item.token] || [];
    return { ride: ride.length, notes: ride.length ? [`Held while automatic help was paused: ${ride.join('; ')}`] : [] };
  }

  // ---------------------------------------------------------------- session recap (F6)
  // lastSession is written at every PLAYER_LOGOUT, and a /reload is one too. The
  // session ended only if nothing from it is heard after the write: the game
  // exits within 60 s (quit), or another session says hello (logout). The same
  // session heard again after the write means a /reload: no recap. A crash
  // writes nothing, so it leaves no recap either.
  const exitFits = (writtenAt) => gameExitedAt && gameExitedAt >= writtenAt - 5000 && gameExitedAt - writtenAt <= RECAP_EXIT_WINDOW_MS;

  function noteLastSession(json, token, writtenAt = now()) {
    if (!json || json === comp.lastSessionSeen) return;
    comp.lastSessionSeen = json;
    const fin = finishRecap(json, 'unknown');
    if (!fin || ev.recapped.includes(fin.doc.sid)) { saveComp(); return; }
    const tk = token || S.lastToken;
    const heard = comp.heard[tk];
    if (heard && heard.sid === fin.doc.sid && heard.at > writtenAt + RELOAD_GRACE_MS) {
      // Its own session was heard after this write (the hello came before the poll): a /reload.
      if (comp.pendingRecap && comp.pendingRecap.sid === fin.doc.sid) comp.pendingRecap = null;
      saveComp();
      log('recap-skip', { sid: fin.doc.sid, reason: 'the session went on (a /reload)' });
      return;
    }
    // A new write from another session first settles the one pending (it logged out).
    if (comp.pendingRecap && comp.pendingRecap.sid !== fin.doc.sid) sendRecap('logout');
    comp.pendingRecap = { sid: fin.doc.sid, json, token: tk, writtenAt, at: now() };
    saveComp();
    log('recap-pending', { sid: fin.doc.sid });
    if (exitFits(writtenAt)) sendRecap('quit');
  }

  // A hello or a state names its session. Another session than the pending
  // recap's: that one logged out. The same one, after the write: a /reload.
  // companion.json is saved when that changes something (a new session, a recap settled). The
  // same session heard again is kept in memory and saved at most once a minute (audit PF-04): the
  // strip redraws its state line with every change, and each copy was a save.
  const heardSaved = new Map(); // token -> when its heard entry was last saved
  function heardSession(token, sid) {
    // A record read from SavedVariables was written with the file, not now.
    const at = heardAtFile ?? now();
    const was = comp.heard[token];
    comp.heard[token] = { sid, at };
    let save = !was || was.sid !== sid || now() - (heardSaved.get(token) ?? 0) >= HEARD_SAVE_MS;
    const pr = comp.pendingRecap;
    if (pr && pr.sid !== sid) { sendRecap('logout'); save = true; }
    else if (pr && at > (pr.writtenAt ?? pr.at) + RELOAD_GRACE_MS) {
      comp.pendingRecap = null;
      log('recap-skip', { sid, reason: 'the session went on (a /reload)' });
      save = true;
    }
    if (!save) return;
    heardSaved.set(token, now());
    saveComp();
  }

  function sendRecap(ended) {
    const pr = comp.pendingRecap;
    if (!pr) return;
    comp.pendingRecap = null;
    const fin = finishRecap(pr.json, ended);
    saveComp();
    if (!fin || ev.recapped.includes(fin.doc.sid)) return;
    ev.recapped = [...ev.recapped, fin.doc.sid].slice(-50);
    saveEv();
    const token = pr.token || S.lastToken;
    if (!token || !companionOn()) return;
    const c = ensureChat(COMPANION_CHAT, token, { agent: defaultAgent, name: 'Companion' });
    // A recap is an automatic turn too (the backend books it as one): the runaway fuse counts it
    // (sent now), and while the fuse holds it takes no turn and rides along, as a held event does.
    const held = fuseHolds(now());
    if (held) {
      rideAlong(token, eventSummary('recap'));
      if (held.tripped) autoPausedRecord(c);
      log('recap-held', { sid: fin.doc.sid, reason: 'automatic help is paused (the runaway fuse)' });
      return;
    }
    const item = { token, key: `recap-${fin.doc.sid}`, chat: c.id, kind: 'recap', json: fin.json, text: '', context: null, firstSeen: now(), attempts: 0, via: 'bridge' };
    store.addOutbox(item);
    store.saveState();
    log('recap', { sid: fin.doc.sid, ended, ...(fin.zeroed ? { endUnknown: 'read as 0 at logout' } : {}) });
    trySend(item);
  }

  /** The capture app's game lines: {"game":"running|launched|exited|absent","pid"} (and the window's pid). */
  function onGame({ state, pid } = {}) {
    health?.game({ state, pid });
    if ((state === 'running' || state === 'launched') && Number.isInteger(pid)) {
      gamePid = pid;
      if (pid !== exitedPid) gameExitedAt = 0; // a new game process: an old exit says nothing about it
      setGame('up', 'helper');
      return;
    }
    if (state === 'absent') { gamePid = null; setGame('down', 'helper'); return; }
    if (state === 'exited') {
      if (gameExitedAt && now() - gameExitedAt < 5000) return;
      gamePid = null;
      exitedPid = Number.isInteger(pid) ? pid : null;
      gameExitedAt = now();
      log('game-exited', { pid: pid ?? null });
      setGame('down', 'exited');
      const pr = comp.pendingRecap;
      if (pr && exitFits(pr.writtenAt ?? pr.at)) sendRecap('quit');
      // Otherwise the logout's SavedVariables may still be on their way (the poll
      // runs every 2 s); with none within 60 s it was a crash: no recap, nothing guessed.
      else log('recap-wait', { pending: !!pr });
    }
  }

  // The fallback when the capture app can't say: the attached pid, every 10 s.
  function checkGamePid() {
    if (!gamePid) return;
    try { process.kill(gamePid, 0); } catch (e) { if (e.code === 'ESRCH') onGame({ state: 'exited', pid: gamePid }); }
  }

  // ---------------------------------------------------------------- sending
  function gwProblem() {
    if (gwState.state === 'ready') return null;
    return `${backendName()} isn't reachable (${gwState.reason || gwState.state})`;
  }

  // A turn to the backend (code health BR-22): synchronous, so the turn is in the outbox until the
  // backend's send has put it on its run queue, and nothing else runs in between: a stop finds it in
  // one place or the other, and a chat's next message is composed after this one has recorded what it
  // carried (the held events ride along once).
  function trySend(item) {
    if (gwState.state !== 'ready' || !gateway) return false;
    const id = `${item.token}:${item.key}`;
    // Sent or dropped meanwhile (a state wait's timer can fire after the send).
    if (!store.outbox.some(o => o.token === item.token && o.key === item.key)) return false;
    // A turn that names a state (st=) waits up to 2 s for it, then goes with what's there (F1).
    if (item.st && !stateReady(item)) {
      item.stWaitSince ||= now();
      if (now() - item.stWaitSince < (deps.stateWaitMs ?? STATE_WAIT_MS)) {
        if (!stTimers.has(id)) stTimers.set(id, setTimeout(() => { stTimers.delete(id); trySend(item); }, 250));
        return false;
      }
    }
    const c = S.chats[item.chat];
    if (!c) { store.removeOutbox(item.token, item.key); return false; }
    // The backend's idempotency key: a resend of a turn it has (the core's store behind its ledger
    // after a crash) is answered by its ledger, never run or billed twice (RT-8), and outcomes() says
    // what became of it.
    const idem = `nqa:${item.token}:${item.key}`;
    try {
      const t = S.tokens[item.token];
      // The game context: what this message carried, else the stored one (the hello's,
      // or the last message's that carried it). A turn that names a state the bridge
      // has (st=, cap ctx) gets the state's level, place, money, XP, professions and
      // quests put in: a message beside its state leaves the context out. Without that
      // state (not arrived in time, another session's, too_large): the stored one.
      let ctxText = item.bare ? null : (item.context ?? t?.ctx ?? null);
      const fromState = !!ctxText && item.context == null && !!item.st && stateReady(item) && stateFor(item).state?.state !== 'too_large';
      if (fromState) ctxText = withState(ctxText, stateFor(item).state);
      // The state it named isn't there (or too_large): the stored context's quest line may be older.
      else if (ctxText && item.context == null && item.st) ctxText = staleContext(ctxText);
      // Whether the turn carries game context (the log's `context`): lines naming the game or the character.
      const ctxFields = useContext && ctxText ? parseContextLines(ctxText) : null;
      const withContext = !!ctxFields && !!(ctxFields.game || ctxFields.character);
      const composed = composeTurn(item);
      // The raw turn: the backend builds its model's request from it (the kind, the typed words, the
      // event and the state, RT-11 sanitized, the context lines and the notes that ride along).
      const turn = { contextLines: ctxText, useContext, ...rawTurn(item, composed) };
      const think = thinkFor(c);
      item.attempts++;
      store.saveOutbox();
      const res = gateway.send({ chatId: c.id, idem, turn, ...(think ? { thinking: think } : {}) });
      const runId = res?.runId || idem;
      c.started = true;
      S.inflight[runId] = { chat: c.id, key: item.key, token: item.token, sentAt: now(), actions: 0, kind: item.kind, event: item.event || undefined };
      // A typed message's run (its reply is a first reply) and Say Hi's (its one chip).
      if ((item.kind || 'msg') === 'msg') {
        S.inflight[runId].msg = true;
        if (item.intro) S.inflight[runId].intro = true;
      }
      // The run is persisted before the outbox entry goes: a crash in between leaves both, and the
      // start's outcomes() ends the run and drops that copy (the backend's ledger keeps it to one turn).
      store.saveState();
      store.removeOutbox(item.token, item.key);
      // The held events this turn carried, as composed.
      if (composed.ride) { ev.ride[item.token] = (ev.ride[item.token] || []).slice(composed.ride); if (!ev.ride[item.token].length) delete ev.ride[item.token]; saveEv(); }
      log('sent', { key: item.key, chat: c.id, status: res?.status, context: withContext, ctxState: (withContext && fromState) || undefined, turn: item.kind || 'msg' });
      // A resend the backend already had (its ledger says ok, in_flight or how it ended): what became
      // of it, from the backend, now. It speaks for this run only: the chat's next message goes meanwhile.
      if (res?.status && res.status !== 'started') applyOutcomes([runId], 'resend');
      publisher.publish({});
      return true;
    } catch (e) {
      const msg = String(e?.message || e);
      // A turn the backend refuses as malformed can't go (retrying would only block the chat's
      // next ones); anything else (it's stopping, NOT_READY) waits for the next try.
      const permanent = /INVALID_REQUEST/.test(msg);
      log('send-error', { key: item.key, error: msg.slice(0, 160), permanent });
      if (permanent) {
        store.removeOutbox(item.token, item.key);
        record({ t: 'error', chat: c.id, kind: 'send', text: systemLine(`${backendName()} refused this message: ${msg.slice(0, 200)}`) });
      }
      return false;
    } finally {
      // The chat's next message goes once this one is through or dropped (a
      // failed send stays first in line for the retry).
      if (!store.outbox.some(o => o.token === item.token && o.key === item.key)) {
        const next = store.outbox.find(o => o.chat === item.chat);
        if (next) setTimeout(() => trySend(next), 0);
      }
    }
  }

  // What the backend builds its model's request from: the turn's kind, the words as typed, the event
  // and its args, the state (a recap's, else this session's latest: the backend keeps no earlier game
  // data in its history, so every turn but a bare one carries it), and the ride-along lines, with
  // every game string sanitized (RT-11).
  function rawTurn(item, turn) {
    const kind = item.kind === 'evt' || item.kind === 'recap' ? item.kind : 'msg';
    const out = { kind };
    if (kind === 'msg') out.typed = item.text ?? '';
    if (kind === 'msg' && item.intro) {
      out.intro = true;
      const loc = S.tokens[item.token]?.loc;
      if (LOCALE_RE.test(loc || '')) out.loc = loc;
    }
    if (kind === 'evt') out.event = { kind: item.event, args: sanitizeArgs(item.args) };
    let doc = null;
    const st = kind === 'recap' || item.bare ? null : stateFor(item);
    if (kind === 'recap') { try { doc = JSON.parse(item.json); } catch { doc = null; } } else doc = st?.state ?? null;
    if (isObj(doc)) out.state = sanitizeState(doc);
    // The state the turn named (st=) didn't come within the wait: the older one goes, and says so (STALE_NOTE).
    if (out.state && st && item.st && st.seq < item.st) out.stale = true;
    if (turn.notes?.length) out.notes = turn.notes;
    return out;
  }

  // A chat's turns go in order: a new one tries the chat's oldest still waiting (held while the
  // backend wasn't ready, or after a failed send), and follows it through trySend.
  function sendInOrder(item) {
    return trySend(store.outbox.find(o => o.chat === item.chat) || item);
  }

  function flushOutbox() {
    for (const item of [...store.outbox]) trySend(item);
  }

  // ---------------------------------------------------------------- backend events
  // The first reply's first words for the app's final setup state: plain text, at most 200
  // characters, cut at a sentence end. Memory only (never saved, never logged).
  let firstWords = null;
  function firstWordsOf(text) {
    const t = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\|c[0-9a-fA-F]{8}|\|r|\|T[^|]*\|t/g, '').replace(/\s+/g, ' ').trim();
    if (t.length <= 200) return t || null;
    const cut = t.slice(0, 200);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end >= 40 ? cut.slice(0, end + 1) : `${cut.slice(0, 199).trimEnd()}…`;
  }

  function publishReply(c, message, { runId = null, usage = null, voice = false } = {}) {
    const mid = message?.__nqa?.id || null;
    if (mid && store.isPublished(mid)) return false;
    const raw = messageText(message);
    if (!raw.trim()) return false;
    const r = renderReply(raw);
    let mapChanged = false, drew = null, fit = null;
    if (r.mapCommands.length) {
      mapChanged = applyMapCommands(S.map, r.mapCommands, now()).changed;
      // Within what a slot always carries (DREW-SY-04), before drew: it never names a layer the game can't get.
      fit = fitMapBytes(S.map);
      if (fit.changed) {
        mapChanged = true;
        log('map-trimmed', { chat: c.id, dropped: fit.dropped.length || undefined, notes: fit.notes ? true : undefined, stops: fit.stops ? `${fit.stops.kept}/${fit.stops.of}` : undefined });
      }
      if (mapChanged) S.mapChangedAt = now();
      drew = drawnLayers(S.map, r.mapCommands);
    }
    // The reply's cost as the backend metered it (BYOK, US-7): {in, out, micros, model, exact}.
    const u = cleanUsage(usage);
    // The first meeting: the reply to Say Hi's "hi" carries exactly one chip, whatever
    // the model wrote (C-41); the first reply to a typed message is noted (firstReplyAt).
    const run = runId ? S.inflight[runId] : null;
    const chips = run?.intro && !S.firstReplyAt ? [FIRST_CHIP] : r.chips;
    // Setup ends on the first real reply to a message (onboarding spec §3.9, §9.3): never a hello's
    // answer, an error record or a check-in. Its first words stay in memory only.
    if (!S.firstReplyAt && (run?.msg || (S.firstMsgAt && !(run?.kind && run.kind !== 'msg')))) {
      S.firstReplyAt = now();
      firstWords = firstWordsOf(r.summary || r.text);
    }
    // run: the reply's run, kept in records.json (never in a slot), so a crash before the marks
    // below are saved can't publish it again (openStore marks it from there).
    const rec = store.addRecord({ t: 'reply', chat: c.id, mid: mid || undefined, run: runId || undefined, agent: c.agent, text: r.text, summary: r.summary, more: r.more,
      chips: chips || undefined, refs: r.refs || undefined, weights: r.weights || undefined, drew: drew || undefined, usage: u || undefined,
      voice: voice ? 1 : undefined }, now());
    // The voice says it too while it reads replies (T16); what the voice itself said is never said twice.
    if (!voice) queueVoiceSay(r.summary || r.text, { turn: run?.kind || (run?.msg ? 'msg' : null), event: run?.event });
    // A map block that failed to draw says so in game, once, and the log says why (RT-3).
    // Looking at the block never loses the reply: a throw there is logged, and the reply stands.
    try {
      const line = mapFailureLine(raw);
      if (line) {
        store.addRecord({ t: 'error', chat: c.id, kind: 'map_block', text: systemLine(line), action: 'none' }, now());
        log('map-block', { chat: c.id, why: mapFailureLog(raw) });
      }
      // What the map's size took off, said once, as a note on the reply (DREW-SY-04).
      const cut = fit?.changed ? mapTrimLine(fit) : null;
      if (cut) store.addRecord({ t: 'error', chat: c.id, kind: 'map_block', text: systemLine(cut), action: 'none' }, now());
    } catch (e) { log('map-block-error', { chat: c.id, error: String(e?.message || e).slice(0, 120) }); }
    if (mid) store.markPublished(mid, rec.seq);
    if (runId) store.markRun(runId, rec.seq);
    if (runId) { delete S.inflight[runId]; checkedAt.delete(runId); }
    store.saveState();
    log('reply', { chat: c.id, seq: rec.seq, mid, chars: raw.length, more: r.more || undefined, map: mapChanged || undefined, drew: drew || undefined,
      chips: chips ? chips.length : undefined, refs: r.refs ? true : undefined, weights: r.weights ? true : undefined,
      uiErrors: r.uiErrors?.length ? r.uiErrors : undefined });
    publisher.publish({ push: true, map: mapChanged });
    return true;
  }

  // A chat error's record: the backend names what the player can do (BYOK: retry, desktop, send_again
  // or none, cap ekind), and alt where its line offers another AI.
  function errorRecord(c, p) {
    record({ t: 'error', chat: c.id, kind: p.errorKind || 'error', text: systemLine(p.errorMessage || 'The run failed.'),
      action: ERROR_ACTIONS.has(p.action) ? p.action : undefined, alt: ERROR_ALTS.has(p.alt) ? p.alt : undefined,
      requestId: cleanRequestId(p.requestId), // KB-09: never a key, nor a cut of an odd string, whatever the backend says
      answers: p.answers === 'none' ? 'none' : undefined });
  }

  // A run ended. The queued count only drops when a queued run starts (lifecycle
  // start); with no run left in flight for the chat, nothing can still be queued.
  function markIdle(c) {
    busy.delete(c.id);
    if (!Object.values(S.inflight).some(r => r.chat === c.id)) queued.set(c.id, 0);
  }

  function onGatewayEvent(evt) {
    const p = evt.payload || {};
    const c = typeof p.chatId === 'string' && Object.hasOwn(S.chats, p.chatId) ? S.chats[p.chatId] : null;
    if (!c) return; // not one of ours: dropped unread
    heardAt.set(c.id, now());
    if (evt.event === 'chat') {
      if (p.state === 'final') {
        // Shown once: a run's reply already published (outcomes() found it first) isn't published
        // again, and publishReply skips a message id it has published.
        if (p.message && !store.isRunPublished(p.runId)) publishReply(c, p.message, { runId: p.runId, usage: p.usage });
        delete S.inflight[p.runId]; // a final with no message ends the run too
        markIdle(c);
        publisher.publish({});
      } else if (p.state === 'error') {
        // A line that answers no message (the backend's model notice, answers: 'none') ends no
        // run: the chat stays busy and the addon keeps its pending send (final review L4-2).
        const answersNone = p.answers === 'none';
        if (!answersNone) {
          delete S.inflight[p.runId];
          markIdle(c);
        }
        errorRecord(c, p);
      } else if (p.state === 'aborted') {
        delete S.inflight[p.runId];
        markIdle(c);
        record({ t: 'aborted', chat: c.id, kind: p.stopReason || 'aborted', text: 'Stopped.' });
      }
      return;
    }
    if (evt.event === 'agent') {
      const d = p.data || {};
      if (p.stream === 'lifecycle' && d.phase === 'start') {
        if (!busy.has(c.id)) busy.set(c.id, { started: now(), actions: 0, last: '' });
        const q = queued.get(c.id) || 0;
        if (q > 0) queued.set(c.id, q - 1);
        publisher.publish({});
      } else if (p.stream === 'lifecycle' && d.phase === 'end') {
        busy.delete(c.id);
        publisher.publish({});
      } else if (p.stream === 'item' && d.kind === 'tool' && d.phase === 'start') {
        const b = busy.get(c.id) || { started: now(), actions: 0, last: '' };
        b.actions += 1;
        b.last = String(d.title || d.name || 'tool').slice(0, 120);
        busy.set(c.id, b);
        const run = S.inflight[p.runId];
        if (run) {
          run.actions = (run.actions || 0) + 1;
          if (bellsHeard()) signals.act(); // an act pulse per action of a run started from WoW (none unheard: BR-04)
        }
        publisher.publish({ progress: true });
      }
    }
  }

  function onGatewayState(st) {
    const wasReady = gwState.state === 'ready';
    gwState = { state: st.state, since: st.since, reason: st.reason };
    const nowReady = st.state === 'ready';
    if (wasReady !== nowReady) {
      // Ready ↔ not-ready transitions push, debounced 30 s (PROTOCOL §3.1).
      clearTimeout(pushDebounce);
      pushDebounce = setTimeout(() => publisher.publish({ push: true }), nowReady ? 0 : 30000);
      pushDebounce.unref?.();
    }
    publisher.publish({});
    log('gateway-state', { state: st.state, reason: st.reason || undefined });
  }

  // The backend is up at start (code health BR-22): the persona's name, then what became of the runs
  // an earlier run of the bridge left in flight (RV-1, C-6: the backend's outcomes, from its ledger and
  // transcripts), then what the outbox held. All in one go: no message comes in between.
  function onGatewayReady() {
    const name = gateway?.persona;
    if (typeof name === 'string' && name) agents = [{ id: defaultAgent, name }];
    if (S.lastToken) checkVersions(S.tokens[S.lastToken] || {});
    applyOutcomes(Object.keys(S.inflight), 'start');
    flushOutbox();
    S.lastOnlineAt = now();
    store.saveState();
    publisher.publish({});
  }

  /**
   * What became of runs in flight, from the backend (backend.outcomes, code health BR-22): at start for
   * the runs an earlier run left, for a resend the backend already had, and for a run quiet past the
   * run limit (checkRuns). done: its reply, published once (a run or message id already published
   * isn't again); interrupted: the backend's line, with Send again; failed or unknown: over, nothing to
   * say; running: still in flight (its own events end it). A copy of an ended run left in the outbox (a
   * crash between saving the run and dropping its message) goes with it, so it's never sent again.
   */
  function applyOutcomes(runIds, why) {
    const ids = runIds.filter(id => Object.hasOwn(S.inflight, id));
    if (!ids.length || typeof gateway?.outcomes !== 'function') return;
    let answers;
    try { answers = gateway.outcomes(ids, Object.fromEntries(ids.map(id => [id, S.inflight[id].chat]))); } catch (e) { log('outcomes-error', { why, error: String(e?.message || e).slice(0, 120) }); return; }
    const said = {};
    for (const o of Array.isArray(answers) ? answers : []) {
      const runId = typeof o?.runId === 'string' ? o.runId : null;
      const run = runId && Object.hasOwn(S.inflight, runId) ? S.inflight[runId] : null;
      if (!run) continue;
      const state = ['running', 'done', 'failed', 'interrupted'].includes(o.state) ? o.state : 'unknown';
      said[state] = (said[state] || 0) + 1;
      if (state === 'running') {
        checkedAt.set(runId, now());
        if (!busy.has(run.chat)) busy.set(run.chat, { started: now(), actions: 0, last: '' });
        continue;
      }
      if (store.outbox.some(x => x.token === run.token && x.key === run.key)) store.removeOutbox(run.token, run.key);
      const c = S.chats[run.chat];
      if (c && state === 'done' && isObj(o.message) && !store.isRunPublished(runId)) publishReply(c, o.message, { runId, usage: o.usage ?? null });
      else if (c && state === 'interrupted') {
        errorRecord(c, { errorKind: 'interrupted', errorMessage: typeof o.errorMessage === 'string' ? o.errorMessage : undefined, action: 'send_again' });
      }
      // Over, whatever was said (a chat that's gone hears nothing). The chat goes idle only when no run
      // of it is left in flight: one sent since keeps its progress (BTT-SY-04).
      delete S.inflight[runId];
      checkedAt.delete(runId);
      if (c && !Object.values(S.inflight).some(r => r.chat === c.id)) markIdle(c);
    }
    log('outcomes', { why, ...said });
    store.saveState();
    publisher.publish({});
  }

  // The safety net (code health BR-22): the backend's events reach the core in this process, so one is
  // lost only when a handler threw. A run with no word of it for the run limit (RUN_CHECK_MS, the
  // backend's 3 minutes) is asked about once, and again each time as long passes while it's still
  // running (held for the network, paused). force: every run in flight now (tests, a host).
  const heardAt = new Map(); // chatId → the last event of the chat
  const checkedAt = new Map(); // runId → when outcomes() last said it was running
  function checkRuns(force = false) {
    if (gwState.state !== 'ready' || !gateway) return;
    const limit = deps.runCheckMs || RUN_CHECK_MS;
    const due = Object.entries(S.inflight)
      .filter(([id, r]) => force || now() - Math.max(r.sentAt || 0, heardAt.get(r.chat) || 0, checkedAt.get(id) || 0) >= limit)
      .map(([id]) => id);
    for (const id of checkedAt.keys()) if (!Object.hasOwn(S.inflight, id)) checkedAt.delete(id);
    if (due.length) applyOutcomes(due, force ? 'asked' : 'quiet');
  }

  // ---------------------------------------------------------------- reload path
  // The file: deps.savedVariablesFile (a path, or a function giving one), else the newest
  // NeverQuestAlone.lua under deps.wtfDir, looked up at each poll (two accounts, a stale folder, or none
  // until the first login: SY-04, plan Batch 2).
  let svMtime = 0;
  let svFile = null;
  const savedVariablesOn = () => !!(deps.savedVariablesFile || deps.wtfDir);
  function savedVariablesFile() {
    const f = deps.savedVariablesFile;
    if (typeof f === 'function') { try { return f() || null; } catch { return null; } }
    if (f) return f;
    return deps.wtfDir ? newestSavedVariables(deps.wtfDir) : null;
  }
  // A write is read RELOAD_BATCH records a poll, each poll's outbox written once (store.batchOutbox),
  // and the rest at the next poll whether the file changed or not (code health BR-02). A newer write
  // takes the place of what's left of the one before: it holds every record the addon hasn't seen acked.
  let svWrite = null; // the write being read: { hexes, next, mtimeMs, first, last, token, typed }
  function pollSavedVariables() {
    const file = savedVariablesFile();
    let st = null;
    if (file) { try { st = fs.statSync(file); } catch { st = null; } }
    if (st && !(st.mtimeMs === svMtime && file === svFile)) readWrite(file, st);
    if (svWrite) readRecords(svWrite);
  }
  function readWrite(file, st) {
    if (svFile && file !== svFile) log('savedvariables-account', { changed: true });
    svMtime = st.mtimeMs;
    svFile = file;
    // Read as bytes (latin1: one character per byte). The hex and the token are
    // ASCII either way; lastSession's text may hold raw UTF-8 or \ddd escapes.
    let src = '';
    try { src = fs.readFileSync(file).toString('latin1'); } catch { return; }
    const block = src.match(/\["outbox"\]\s*=\s*\{([\s\S]*?)\n\t\}/);
    const hexes = [...(block ? block[1] : src).matchAll(/\["hex"\]\s*=\s*"([0-9a-fA-F]+)"/g)].map(m => m[1]);
    if (svWrite) endWrite(svWrite);
    // The session recap the addon writes at logout (companion F6), noted once the write's records are read.
    const token = (src.match(/\["token"\]\s*=\s*"([0-9a-f]{8})"/) || [])[1] || null;
    svWrite = { hexes, next: 0, mtimeMs: st.mtimeMs, first: [], last: readLastSession(src), token, typed: 0 };
  }
  function readRecords(w) {
    const part = w.hexes.slice(w.next, w.next + RELOAD_BATCH);
    w.next += part.length;
    heardAtFile = w.mtimeMs;
    lastReloadAt = now();
    writeFirst = w.first;
    try {
      store.batchOutbox(() => {
        for (const hex of part) {
          const r = parseRecord(hexToString(hex));
          if (!r.ok) { onRejected(r, 'reload'); continue; }
          try { handleRecord(r.record, 'reload'); } catch (e) { log('record-error', { type: r.record.type, key: r.record.key || null, via: 'reload', error: String(e?.message || e).slice(0, 120) }); }
        }
      });
    } finally {
      heardAtFile = null;
      writeFirst = null;
      if (w.next >= w.hexes.length) endWrite(w);
    }
  }
  function endWrite(w) {
    if (svWrite === w) svWrite = null;
    // The watchdog judges the write once all of it is read (R4': its first-time keyed records, against
    // the helper's attach at the file's mtime), then the write ends the episode.
    health?.write({ mtimeMs: w.mtimeMs, first: w.first });
    noteLastSession(w.last, w.token, w.mtimeMs);
  }

  // A write the disk refused (BR-11) made now: what was kept only in memory (a reply, a message) is on
  // disk again, and the slots are written and rung again, in case the full disk took them too. Made in the
  // write queue (BR-04), that's once the queue answers.
  function retryWrites() {
    const recovered = () => { log('store-write-recovered', {}); publisher.publish({ push: true }); };
    if (!store.retryWrites(recovered)) return false;
    recovered();
    return true;
  }

  // ---------------------------------------------------------------- doorbells
  // While the addon hasn't read the latest ringing publish, ring again (§3):
  // every 10 s six times, then every 60 s, until 10 minutes after it.
  let rering = { push: -1, count: 0, next: 0 };
  function reRing() {
    // While no_signal is published, a blind strip can't answer, and each re-ring costs the addon a slot
    // load (D-29, the bridge's half): the ok publish's own ring catches it up.
    if (health?.pausesRering()) return;
    // Screen reading off (the app's switch or the addon's): nothing can say a ring was read, so each
    // publish rings once and is never rung again (the screen-reading switch, SY-01).
    if (health?.state?.() === 'off') return;
    // A session that reads no doorbell (stream, reload) loads its slots on its own timers (BR-04).
    if (!bellsHeard()) return;
    const t = S.lastToken ? S.tokens[S.lastToken] : null;
    // The newest publish on disk (BR-04, the 1.4.1 revert): one the worker is still writing rings when
    // it's written, and a ring now would find a slot without it.
    const P = publisher.settledPush();
    if (!t || (t.readPush || 0) >= P) return;
    const at = S.pushAt || 0;
    if (now() - at > RERING_FOR_MS) return;
    if (rering.push !== P) rering = { push: P, count: 0, next: at + RERING_FAST_MS };
    if (now() < rering.next) return;
    rering.count += 1;
    rering.next = now() + (rering.count < RERING_FAST_COUNT ? RERING_FAST_MS : RERING_SLOW_MS);
    signals.ringPush();
    log('rering', { push: P, read: t.readPush || 0, count: rering.count });
    store.saveState();
  }

  // ---------------------------------------------------------------- the game's presence (SY-30)
  // Without deps.gameGate (tests that don't ask for it) the in-game work
  // runs all the time, as it always has. With it (the app's boot) the work follows the game:
  //   up       the capture helper says the game runs (running, launched, a window's pid), a strip
  //            was read off the screen, or the slow check found it: the in-game work runs;
  //   down     the helper says it's absent or has exited, or the slow check found none: after an
  //            exit the work runs on for GAME_LINGER_MS, then stops with every bell in place, and
  //            only the slow check runs;
  //   unknown  from the start until the game is known: the work runs, as without the gate (a helper
  //            that never says leaves it here).
  // The slow check, every GAME_CHECK_MS while down: the SavedVariables poll (a stat, so a reload's
  // records are read whatever a helper says) and, when no helper reports the game, deps.gameCheck()
  // (the process list, off the main thread: true/false, or {running, pids}). deps.gameHelper: a
  // helper is on its way (boot starts it right after the bridge), so the start waits for its word
  // instead of asking the process list. A game the process list found, with no helper, is followed
  // by its pid (checkGamePid, every 10 s while it runs: no process list), so its exit is seen too.
  const gate = deps.gameGate === true;
  const game = { state: 'unknown', since: now() };
  let gameWork = []; // the in-game work's intervals, while they run
  let lingerTimer = null;
  let slowTimer = null;
  let checkSeq = 0;
  let lastStripAt = 0;
  let halted = false;
  let notRunning = 0;      // the process list's "not running" answers in a row (BR-15)
  let askAfter = 0;        // and no process list before this
  let accountsWatch = null; // the watch on WTF/Account while the game is closed
  let wakeTimer = null;
  const lingerMs = () => (Number.isFinite(deps.gameLingerMs) ? deps.gameLingerMs : GAME_LINGER_MS);
  const checkMs = () => deps.gameCheckMs || GAME_CHECK_MS;
  const askMs = () => (Array.isArray(deps.gameAskMs) && deps.gameAskMs.length ? deps.gameAskMs : GAME_ASK_MS); // tests: shorter
  const helperReports = () => { try { return deps.gameReported?.() === true; } catch { return false; } };
  // Held like every timer the core ran before the gate; stop() clears them.
  const every = (list, ms, fn) => { list.push(setInterval(fn, ms)); };

  function startGameWork() {
    if (gameWork.length) return;
    // The alive beat only for an addon that reads its bells (code health BR-04).
    const beat = () => { if (bellsHeard()) signals.beat(); };
    beat();
    every(gameWork, deps.aliveEveryMs || ALIVE_EVERY_MS, beat);
    every(gameWork, deps.ringEveryMs || 2000, everyTwoSeconds); // ringEveryMs: tests only
    every(gameWork, deps.gamePidEveryMs || 10000, checkGamePid);
    every(gameWork, deps.runCheckEveryMs || 5000, () => checkRuns()); // the safety net (BR-22)
    every(gameWork, deps.voiceEveryMs || 1500, drainVoiceInbox); // the voice companion's inbox (T7)
    if (savedVariablesOn()) every(gameWork, deps.savedVarsEveryMs || 2000, pollSavedVariables);
    // The other addons' saved data (Auctionator prices, Syndicator, RXPGuides) into the local brain, read
    // from disk: when the game comes up and every 30 minutes while it runs (odd/tasks/nqa-fast-chat.md F5). Read-only toward the game.
    if (deps.wtfDir && deps.brainAddons !== false) {
      const brainImport = async () => {
        try {
          const { importAddonsIntoBrain } = await import('../tools/brain/addons.mjs');
          const rows = importAddonsIntoBrain({ brainFile: path.join(stateDir, '..', 'brain', 'brain.sqlite'), wtfDir: deps.wtfDir });
          if (rows) log('brain-addons', rows);
        } catch (e) { log('brain-addons', { error: String(e?.message || e).slice(0, 160) }); }
      };
      brainImport(); // once now (the game is up: this runs with the game's work, never while it is closed)
      every(gameWork, deps.brainAddonsEveryMs || 30 * 60 * 1000, brainImport);
    }
    // A send that failed on a transient error is retried every 30 s while the backend is ready, and a
    // write the disk refused (BR-11) is made again first. deps.flushEveryMs: tests only.
    every(gameWork, deps.flushEveryMs || 30000, () => {
      retryWrites();
      if (gwState.state === 'ready' && store.outbox.length) flushOutbox();
    });
  }
  function stopGameWork() {
    if (!gameWork.length) return;
    for (const t of gameWork) clearInterval(t);
    gameWork = [];
    signals.stop(); // no pulse left half way: every bell is in place when the UI next loads
  }
  function startSlowCheck() {
    if (slowTimer || halted) return;
    slowTimer = setInterval(slowCheck, checkMs());
    slowTimer.unref?.();
    watchAccounts();
  }
  function stopSlowCheck() {
    clearInterval(slowTimer);
    slowTimer = null;
    unwatchAccounts();
  }
  function slowCheck({ woken = false } = {}) {
    pollSavedVariables();
    // The host's own slow look (the app: has a World of Warcraft update landed? SY-29).
    try { deps.onSlowCheck?.(); } catch { /* the host's business */ }
    if (!accountsWatch) watchAccounts();
    if (!helperReports() && (woken || now() >= askAfter)) askGame();
  }
  // WTF/Account, watched while the game is closed (BR-15): the account folder the SavedVariables are
  // read from (deps.wtfDir's, or the one deps.savedVariablesFile names). A folder that isn't there yet
  // (no login so far) is watched from the slow check that finds it.
  function accountsDir() {
    if (deps.wtfDir) return path.join(deps.wtfDir, 'Account');
    const f = typeof deps.savedVariablesFile === 'string' ? deps.savedVariablesFile : null;
    return f ? path.dirname(path.dirname(path.dirname(f))) : null;
  }
  function watchAccounts() {
    const dir = gate && !halted && !accountsWatch ? accountsDir() : null;
    if (!dir) return;
    try {
      accountsWatch = fs.watch(dir, { recursive: true, persistent: false }, wake);
      accountsWatch.on('error', unwatchAccounts);
    } catch { accountsWatch = null; }
  }
  function unwatchAccounts() {
    try { accountsWatch?.close(); } catch { /* closed */ }
    accountsWatch = null;
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  // A write under WTF/Account: the game may have started; the slow check now (once the burst is over),
  // which asks the process list whatever its backoff says.
  function wake() {
    if (wakeTimer || halted || game.state === 'up') return;
    wakeTimer = setTimeout(() => { wakeTimer = null; if (!halted && game.state !== 'up') slowCheck({ woken: true }); }, deps.wakeMs ?? 1000);
    wakeTimer.unref?.();
  }
  /** The process list's word (deps.gameCheck → true/false), unless a helper reports by the time it comes. */
  function askGame() {
    if (!gate || typeof deps.gameCheck !== 'function') return;
    const seq = ++checkSeq;
    const askedAt = now();
    let answer;
    try { answer = Promise.resolve(deps.gameCheck()); } catch { return; }
    answer.then((said) => {
      if (seq !== checkSeq || halted || helperReports()) return;
      const running = typeof said === 'object' && said !== null ? said.running === true : said;
      // Its backoff (BR-15): asked again 2 min after a "not running", then every 5 min.
      if (running === false) {
        const steps = askMs();
        notRunning += 1;
        askAfter = now() + steps[Math.min(notRunning, steps.length) - 1];
      } else if (running === true) { notRunning = 0; askAfter = 0; }
      if (running === true) {
        const pid = Array.isArray(said?.pids) ? said.pids.find(p => Number.isInteger(p) && p > 0) : undefined;
        if (!gamePid && pid) { gamePid = pid; if (pid !== exitedPid) gameExitedAt = 0; }
        setGame('up', 'check');
      }
      // A strip read since the question, or lately, says otherwise (a process list that missed the
      // game): the strip wins.
      else if (running === false && lastStripAt < askedAt && now() - lastStripAt > 2 * checkMs()) setGame('down', 'check');
    }, () => {});
  }
  function setGame(state, why) {
    if (!gate || halted) return;
    if (state === 'up') {
      clearTimeout(lingerTimer);
      lingerTimer = null;
      stopSlowCheck();
      notRunning = 0; // the next closed spell starts its backoff over
      askAfter = 0;
      if (game.state === 'up') return;
      game.state = 'up';
      game.since = now();
      log('game-state', { state, why });
      startGameWork();
      try { deps.onGameState?.('up'); } catch { /* the host's business */ }
      return;
    }
    if (game.state === 'down') return;
    const was = game.state;
    game.state = 'down';
    game.since = now();
    log('game-state', { state, why, ...(was === 'up' ? { lingerMs: lingerMs() } : {}) });
    try { deps.onGameState?.('down'); } catch { /* the host's business */ }
    const rest = () => {
      lingerTimer = null;
      if (game.state !== 'down' || halted) return;
      stopGameWork();
      startSlowCheck();
    };
    // After a game that ran: a minute more for its logout's SavedVariables and the recap.
    if (was === 'up') {
      clearTimeout(lingerTimer);
      lingerTimer = setTimeout(rest, lingerMs());
      lingerTimer.unref?.();
    } else rest();
  }

  // The in-game work's 2 s beat, one timer: re-rings, then the capture watchdog's rules (R1-R4',
  // display DR-04), which count in the core's time and start nothing of their own.
  function everyTwoSeconds() {
    owedFull(); // BR-16: a ringing publish the 30 s held to the window reaches every slot
    reRing();
    health?.tick();
  }

  // ---------------------------------------------------------------- lifecycle
  const timers = [];
  return {
    store,
    signals,
    publisher,
    handlePayload,
    handleRecord,
    buildSlot,
    checkRuns,
    flushOutbox,
    drainVoiceInbox,
    onGatewayEvent,
    onGatewayState,
    onGatewayReady,
    start() {
      const missing = signals.missingFolders();
      if (missing.length) log('setup-warn', { warn: `signal folders missing (${missing.join(', ')}): run setup, then restart WoW` });
      // The doorbells must exist when the UI loads: any made now are seen after the next /reload.
      const made = signals.ensure();
      if (made.length) log('bells-made', { made, note: 'seen in game after the next /reload' });
      const legacy = signals.cleanupLegacy();
      if (legacy) log('legacy-signals-removed', { files: legacy });
      // Tokens from before doorbells: treat everything published so far as read.
      for (const tk of Object.values(S.tokens)) if (tk.readPush === undefined) tk.readPush = S.push;
      store.saveState();
      gateway = gatewayFactory({
        onReady: () => { try { onGatewayReady(); } catch (e) { log('ready-error', { error: String(e?.message || e).slice(0, 160) }); } },
        onEvent: onGatewayEvent,
        onState: onGatewayState,
        // The backend is usable again after start (BYOK: a key added, unpaused): what the outbox
        // held goes now, not at the next 30-second flush.
        onResume: () => {
          if (gwState.state !== 'ready' || !store.outbox.length) return;
          log('resume-flush', { queued: store.outbox.length });
          try { flushOutbox(); } catch (e) { log('flush-error', { error: String(e?.message || e).slice(0, 160) }); }
        },
        // What the backend adds to the slot changed outside a turn (BYOK: a model switch, a setting
        // the player changed in the app). push: the addon must read it now (it reads a slot
        // only when the push doorbell rings), so ring.
        onChange: o => publisher.publish({ push: o?.push === true }),
      }, { writer }); // the ledger's writes in the same queue as the core's (BR-04)
      // A pause the typed guard kept across a restart holds the backend's queue from its start (BR-03).
      if (guard.paused) holdBackend(true);
      gateway.start?.();
      // The in-game work (beats, re-rings, polls, run checks, retries): from here on without the gate;
      // with it, while the game isn't known yet, then as the game comes and goes (SY-30).
      startGameWork();
      // With the gate and no helper on its way, the process list says whether the game runs.
      if (gate && !deps.gameHelper) askGame();
      // Unread publishes from before this start: ring now, and re-ring from here.
      const lt = S.lastToken ? S.tokens[S.lastToken] : null;
      if (lt && lt.readPush < S.push) { S.pushAt = now(); signals.ringPush(); }
      pruneRecords();
      pruneUnseen();
      // Replies, tokens and chats age past the retention while it runs, the game or not.
      timers.push(setInterval(() => { pruneRecords(); pruneUnseen(); }, 3600e3));
      for (const t of timers) t.unref?.();
      publisher.publish({});
    },
    async stop() {
      halted = true;
      clearTimeout(lingerTimer);
      stopSlowCheck();
      for (const t of gameWork) clearInterval(t);
      gameWork = [];
      for (const t of timers) clearInterval(t);
      for (const t of stTimers.values()) clearTimeout(t);
      stTimers.clear();
      clearTimeout(pushDebounce);
      publisher.flushNow();
      publisher.stop();
      signals.stop(); // every bell back in place, so none is missing at the next load
      store.saveState();
      store.flush();
      await gateway?.stop?.();
      store.flush(); // what the backend's stop settled
      writer?.stop(); // the write queue drained, then ended (BR-04): every write above is on disk
    },
    status() {
      return {
        version: BRIDGE_VERSION, gateway: { ...gwState }, warn,
        lastPayloadAt,
        // What the bridge reads of the game (SY-04), for a status that never says "ok" while nothing
        // is read: the last record off the screen (strip) and from SavedVariables (reload), and how
        // long a publish the addon was rung for has gone unread (0: none; the addon answers a ring it
        // hears with a seen on the strip, so a long wait while WoW runs means the screen isn't read).
        reading: (() => {
          const tk = S.lastToken ? S.tokens[S.lastToken] : null;
          const unread = tk && (tk.readPush || 0) < publisher.settledPush() && S.pushAt ? Math.max(0, now() - S.pushAt) : 0;
          return { strip: lastPayloadAt || null, reload: lastReloadAt || null, unreadMs: unread, mode: tk?.mode ?? null, helloVia: tk?.helloVia ?? null };
        })(),
        // The game as the bridge knows it (SY-30, with the gate): up, down or unknown, since when,
        // whether a capture helper reports it, and whether the in-game work runs (it lingers after an exit).
        ...(gate ? { game: { state: game.state, since: game.since, helper: helperReports(), working: gameWork.length > 0 } } : {}),
        publishes: publisher.stats(), slotWindow: (() => { const w = winOf(); const r = w ? slotRange() : null; return w ? { mode: w.mode, from: r?.from ?? 1, to: r?.to ?? slotCount } : null; })(),
        outbox: store.outbox.length, inflight: Object.keys(S.inflight).length,
        // push: the newest publish on disk (one the slot worker is writing counts once it's written; BR-04).
        chats: Object.keys(S.chats).length, seq: S.seq, push: publisher.settledPush(), pushOk: S.pushOk ?? 0, epoch: S.epoch, store: store.health(), bells: signals.stats().rings,
        signalErrors: signals.stats().errors, signalRetries: signals.stats().retried,
        companion: { today: ev.day === localDay(now()) ? ev.count : 0, stateSeq: S.lastToken ? comp.states[S.lastToken]?.seq ?? null : null, pendingRecap: !!comp.pendingRecap, gamePid,
          autoPaused: fuse.paused, ...(fuse.paused ? { autoPausedBy: fuse.pausedBy } : {}) },
        // The typed guard (D4): {paused: true, turns, windowMs, at} while it holds; the app's Resume sending.
        sending: guard.paused ? { paused: true, ...guard.pausedBy, at: guard.pausedAt } : { paused: false },
        // The first meeting (onboarding spec §9.3), and the capture state the last slot carried.
        first: { msgAt: S.firstMsgAt ?? null, replyAt: S.firstReplyAt ?? null, replyBefore: !!S.firstReplyBefore }, capture: health ? health.info() : null,
        token: S.lastToken ? { id: S.lastToken, ...S.tokens[S.lastToken], acked: undefined, ctx: S.tokens[S.lastToken]?.ctx ? '<context>' : null } : null,
        // Setup's last rows (onboarding spec §9.3): the first message heard, the first reply to one.
        firstMsgAt: S.firstMsgAt ?? null, firstReplyAt: S.firstReplyAt ?? null, firstReplyBefore: S.firstReplyBefore === true, firstWords,
        // The route on the map now (CL-design-41): {title, next, stops, at}, or null; the app's Home leads with it.
        route: routeNow(S.map),
      };
    },
    get gateway() { return gateway; },
    pollSavedVariables,
    reRing,
    onGame,
    /** The capture helper's lines (boot's onStatus) and typed errors (onError), for the watchdog. */
    onCaptureStatus: ev => health?.status(ev),
    onCaptureError: e => health?.error(e),
    /** The supervisor ({ restart(reason), kind }; capture.mjs), once boot has made it. */
    setCaptureControl: c => health?.control(c),
    /** The capture helper went away (the app's Screen Reading off): a game not known yet is asked about now (SY-07). */
    helperGone: () => { if (gate && game.state === 'unknown') askGame(); },
    /** The talking session's mode (pixel, stream, reload) or null: boot's capture gate (SF-01). */
    sessionMode,
    /** The watchdog itself (null without one): the app's Restart screen reading resets its backoff. */
    captureHealth: health,
    forgetChatRecords,
    pruneRecords,
    pruneUnseen,
    resumeSending,
    retryWrites,
    /** Whether writes wait in the write queue (BR-04; tests, the bench). */
    writesQueued: () => !!writer?.busy?.(),
    /** How much per-token and per-chat state the core holds (code health BR-12; tests, diagnostics). */
    sizes: () => ({ tokens: Object.keys(S.tokens).length, chats: Object.keys(S.chats).length, busy: busy.size, queued: queued.size,
      heard: heardAt.size, checked: checkedAt.size, titles: Object.keys(comp.titles).length, states: Object.keys(comp.states).length }),
  };
}
