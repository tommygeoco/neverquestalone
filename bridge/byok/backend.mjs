// The local backend (public BYOK PRD §5.2, §5.3, §6.2–§6.5, §7.2–§7.5, §9.4, §10, §13.1; BUILD-PLAN
// "the seam"): what service.mjs calls, by chat id, answered inside the bridge with the prompt pack and a
// provider's API. (Code health BR-22: the retired gateway's RPC isn't emulated here any more:
// no session keys, agents.list, synthetic hello, chat.history, label sync or idempotency mapping.)
//
//   createLocalBackend(handlers, opts) → { kind: 'byok', displayName, persona, start, stop, send, abort,
//                                          forget, setChatModel, outcomes, slotExtras, chatSlot, status,
//                                          diagnostics, refresh, setConfig, pause, holdRuns, lastRequest,
//                                          usageHistory, memory, forgetMemory, caps, ledger, transcripts, … }
//
// handlers are the core's: onReady() once start() is done (what an earlier process left is settled by
// then: see outcomes below); onState({state, since, reason}) with ready | no_key | key_invalid |
// paused; onResume() when the state comes back to ready after start (a key added, unpaused: the core
// sends what its outbox held at once); onChange({push}) when what the slot shows changed outside a
// turn (a model switch, setConfig, a chat's own model dropped; push: true where the addon must read it
// now, which rings its push doorbell: setConfig, a model switched or dropped); onEvent({event, payload})
// with
//   chat  {state: final|error|aborted, chatId, runId, message?, usage?, errorKind?, errorMessage?, action?, requestId?, stopReason?}
//   agent {stream: lifecycle|item, chatId, runId, data}
// Every handler call is wrapped: one that throws is logged (byok-handler-error) and never ends a turn.
//
// The core's calls, every one synchronous (a stop right after a send finds its turn on the run queue,
// which drops it unbilled: there is no answer on its way to wait for):
//   send({chatId, idem, turn, thinking}) → {runId, status}   a turn (below). turn is the core's raw turn
//       ({kind: msg|evt|recap, typed, contextLines, useContext, state, event, notes, intro, loc, stale});
//       thinking the chat's /bones think level, which outranks the player's effort for that turn.
//   abort(chatId) → {aborted}   the chat's running turn stopped, its waiting ones dropped.
//   forget(chatId) → {ok}       the chat's transcript, its own model and its last request go; its turns stop.
//   setChatModel(chatId, model) → {ok, model} | {ok: false, error}   /bones model (below).
//   outcomes(ids, chats) → [{runId, state, …}]   what became of turns the core sent (below); chats is
//       {runId: chatId}, the core's word for each run's chat.
//   persona                     the companion's name (default Bones).
// A chat id that isn't one (c + 6 hex) is refused (INVALID_REQUEST), as is a send with no key.
//
// A chat's own model (BUILD-PLAN "Contract: what the addon reads", chats[]): setChatModel with a model
// the provider offers (listed in its manifest, or any id where it allows any) is kept in
// byok-chats.json with its provider and used from the chat's next turn; an id it doesn't offer
// answers {ok:false, error:'unknown_model'} and changes nothing. A provider change drops them all;
// a turn the provider answers model_not_found drops that chat's and says it went back to the
// provider's model. chatSlot(chatId, {think}) is what the core publishes in chats[] beside its own
// fields: model and modelName (the chat's own, absent: the provider's), effortSupported (for the
// model the chat's next turn uses) and effort (what that turn sends: the chat's /bones think level,
// else the player's effort; absent where the model has none). A reply's usage.model is always the
// id the turn asked for; a provider-returned alias (a dated snapshot) goes to the log only.
//
// send is idempotent through the ledger (RT-8): a key already 'done' answers {status:'ok'}, one
// 'queued' or 'sending' answers 'in_flight', one that failed answers its state; a new key is begun in
// the ledger, answered {runId, status:'started'}, and put on the run queue (one run per chat, 2 across
// chats, RT-7) before send returns. runId is the idempotency key. The core asks outcomes() about a run
// it didn't start, so a resend after a crash (the same key) is never run or billed twice.
//
// outcomes(ids, chats), from the ledger and the transcripts (code health BR-22), one answer per id, in order:
//   {runId, state: 'running'}       queued or running in this process (its own events will end it)
//   {runId, chatId, state: 'done', message?, usage?}   answered: message is its reply row as its final
//       carried it (__nqa {id, seq}), found by the ledger's replyT, or by the reply row that names the
//       run (one written just before a crash that left the ledger 'sending'). A 'done' entry an older
//       build wrote has no replyT and its rows name no run: that one reply isn't found, and the answer
//       has no message (the core ends the run; the reply stays in the transcript).
//   {runId, chatId, state: 'failed'}   over, its line said (or stopped)
//   {runId, chatId, state: 'interrupted', errorKind, errorMessage, action: 'send_again'}   an earlier
//       process left it unanswered (DB20: never resent, since a resend may pay twice)
//   {runId, state: 'unknown'}       the ledger has no such turn (one that couldn't be read was kept aside),
//       and the chat's transcript (chats' word for it) has no reply row naming it (one that has is done)
// At start, before onReady, every turn an earlier process left 'sending' with no reply written is booked
// at its estimate, once, and every one it left 'queued' is marked failed; their lines are the core's to
// say, through outcomes().
//
// A turn: KY-10 (a key-shaped message is refused, never sent or saved) → the request (prompt pack,
// memory digest, the game data block from the context lines and the sanitized state, the windowed
// history, the player's text; effort from the chat's think level through the manifest's effort map,
// null where the model has none) → the per-turn ceiling (history dropped first) → the logbook for an
// event or recap with a state (no model in the loop, RT-5) → caps.check of the estimate (§9.4;
// refused only at a daily spend cap the player set) → the ledger's 'sending' → provider.stream,
// retried only for transient kinds (at most 2, honoring retry-after, "Trying again in N seconds" as
// an agent item the addon shows; a context too long is trimmed and tried once more; a reply with no
// text is tried once more, at the model's lowest thinking level when it ran out of room, and empty
// again it's empty_reply) → the reply: datamarks
// stripped, pseudonyms unmasked → transcripts (the player's row, and the reply's with its run and its
// cost) → caps.book at the real cost (the usage history, the one store of daily totals) → the ledger's
// 'done' (with the reply row's time, replyT, and the cost) → a chat final whose message carries __nqa
// {id, seq} (seq is the reply row's time, strictly rising per chat) and usage {in, out, micros, model,
// exact}. A failure
// books what went out (nothing when nothing left the machine), marks the ledger 'failed', and sends
// a chat error with the ProviderError's kind, its fixed line (§10: headline and second line, never
// provider text) and the action the addon offers ('retry' | 'desktop' | 'send_again' | 'none'), and
// alt ('pick_provider') where the line offers another AI (D7). A map block the model got wrong isn't
// repaired with a second paid call (systems plan D6): the core says "Couldn't draw the route".
//
// The money rules around that:
// - The public build sets no usage limits of its own (maintainer, 2026-09-26): no typed-message or
//   automatic-turn cap and no default spend cap. Every turn is still metered and booked (the
//   accounting), and a daily spend cap the player set in the app is honored (cap_spend). Turns
//   running at the same moment are booked when they're over, so a cap can be passed by what the two
//   of them cost (at most about $0.10).
// - One 3-minute limit for the whole run (PV-7, §7.5): attempts and retry waits. At the limit the
//   turn ends as `timeout`.
// - A stop (/bones stop) or a forget during any await ends the turn as aborted: nothing is published
//   or written after it. What went out is still counted.
// - Anything that throws after a request went out books what it cost: metered attempts at their
//   cost, one whose outcome is unknown at max(metered, estimate); a request that never left, nothing.
//   A bridge stop books what went and leaves the ledger 'sending' for the next start; a turn an
//   earlier process left 'sending' is booked at its estimate then (unless its reply was written).
// - A reply's rate-limit headers with a bucket at 0 put rt in 'slowed' until its reset (US-3).
//
// - A failure after the provider began generating (partial usage reported, or reply text streamed:
//   Anthropic's overloaded mid-stream) counts at max(metered, estimate), like an unknown outcome.
// - Network down before anything left (§10): the turn is held, not failed. The chat's run line says
//   "Can't reach <P>. Check your internet. Your message will send when it's back."; the ledger steps
//   back to 'queued'; the provider's host is probed (a HEAD with no key) at 5 s, doubling to 60 s,
//   and any request of this backend that gets an answer wakes it at once. Back within 10 minutes of
//   the message: it goes (a fresh run limit). Past them: the Retry line. One held turn per chat
//   (the run queue's one run per chat); /bones stop and a forget end it (aborted, nothing counted).
//
// What the app reads besides (BUILD-PLAN "the app API"):
// - lastRequest(chatId) (KY-8, PR-3, §8.4 item 3): the exact request each chat's last turn sent, in
//   memory only: method, URL, headers (the auth header as
//   `sk-ant-…A1b2 (redacted)`, any other credential header "[redacted]") and the JSON body. Never
//   written, logged or put in diagnostics.
// - usageHistory({days}) (§9.2 "Totals"): usage/history.mjs, <dataDir>/usage-history.json.
// - the model check (PV-3, §10 "Model not found"): at start and on a provider, model or key change,
//   the provider's model list; a model gone is replaced by the manifest's named replacement or the
//   nearest listed model no dearer (resolveModel), status().notice says {kind:'model_switched', from,
//   to}, and the next turn's chat gets the §10 line once ("<M> isn't available on your <P> account.
//   Switched to <M2> for now. Change it in the NeverQuestAlone app."). A list that can't be read keeps the model.
// - memory(char) and forgetMemory(char): the digest and the logbook's files; transcripts.forget and
//   transcripts.deleteAll also drop the chat's last request.
//
// Nothing here logs or stores prompt or reply text outside the transcripts: log lines carry ids,
// sizes, kinds, codes and costs only, and keys come from the key store for each request.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileQuick } from '../files.mjs';
import { CHAT_RE } from '../transport/records.mjs';
import { loadManifests, createProvider, userLine, retryPlan, resolveModel, manifestFor, effortLevels, thinkRoom, outputCeiling, EFFORT_LEVELS, THINK_ROOM, DEFAULT_TIMEOUTS } from './providers/index.mjs';
import { makeError, errorLogFields, cleanRequestId } from './providers/errors.mjs';
import { loadPack, loadChatPack, personaName } from './runtime/pack.mjs';
import { FILES as MEMORY_FILES, MEMORY_DIR, charKey } from './runtime/logbook.mjs';
import { createUsageHistory } from './usage/history.mjs';
import { buildRequest, replyTranscript, stripDatamark, resolveEffort, modelHasEffort, MAX_TOKENS, EFFORTS } from './runtime/context.mjs';
import { createTranscripts, rowUsage, HISTORY_BUDGET, RETENTION_DAYS } from './runtime/history.mjs';
import { createPseudonymizer } from './runtime/pseudonym.mjs';
import { createMemory, liveQuests } from './runtime/memory.mjs';
import { applyLogbook } from './runtime/logbook.mjs';
import { sanitizeState, sanitizeArgs, sanitizeGameString, typedLooksLikeKey } from './runtime/sanitize.mjs';
import { createPriceBook, localPrice } from './usage/prices.mjs';
import { estimateTurn, meterReply } from './usage/meter.mjs';
import { createCaps, localDay } from './usage/caps.mjs';
import { createLedger } from './ledger.mjs';
import { createRunQueue } from './runqueue.mjs';
import { looksLikeKey } from './security/keycheck.mjs';
import { redact, redactKeys, redactKeysInProse } from './security/redact.mjs';
import { STATE_WORDS, STATE_TONE, NEEDS_PLAYER, SPEND_UNKNOWN_WORDS } from './status-view.mjs';

export const KIND = 'byok';
export const PRODUCT = 'NeverQuestAlone';
// What the slot adds to bridge.caps with this backend (the addon's UX-1…UX-8 gates).
export const SLOT_CAPS = Object.freeze(['provider', 'usage', 'ekind', 'model']);
export const KEY_REFUSED = "That looks like an API key. It wasn't sent.";
export const CONCURRENCY = 2;
export const MAX_RETRIES = 2;
export const LAST_REQUESTS = 8; // the chats whose last request lastRequest() keeps, used last first (BR-12)
export const STOP_WAIT_MS = 2000;
export const ACTIONS = Object.freeze(['retry', 'desktop', 'send_again', 'none']);
export const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,80}$/; // a chat's own model (/bones model): the addon's own rule
export const RUN_MS = DEFAULT_TIMEOUTS.runMs; // one wall-clock limit per run, retries included (PV-7)
export const HOLD_MS = 10 * 60 * 1000; // a turn that never left waits this long from its message for the network (§10)
export const HOLD_PROBE_MS = Object.freeze({ first: 5000, max: 60000 }); // the held turn's probes, doubling
export const SLOWED_WAIT_MAX_MS = 120 * 1000; // a rate limit's reset this close is waited out, as a retry would be; past it, the turn isn't sent (SY-05)
export const PRUNE_EVERY_MS = 24 * 3600 * 1000; // transcripts past the retention, while running
export const RETENTION_MAX_DAYS = 365;
// How many of a chat's last transcript rows outcomes() reads first for a reply, and how far a clock set
// back between a turn's start and its reply may put the reply's row before the turn's ledger entry.
export const OUTCOME_ROWS = 40;
export const ROW_SLACK_MS = 10 * 60 * 1000;

// Kinds that mean nothing left the machine (no cost, no turn), and kinds after which we can't know
// whether the provider billed (the turn is booked at its estimate).
const NOT_SENT = new Set(['no_key', 'network_before_send', 'local_unreachable', 'egress_blocked', 'tls']);
const NOT_SENT_CODES = new Set(['bad_request_shape']);
const UNKNOWN_OUTCOME = new Set(['network_after_send', 'timeout', 'interrupted']);
const TURN_KINDS = { msg: 'typed', evt: 'auto', recap: 'auto' };
// The first meeting's output cap, for a greeting alone (onboarding spec §9.3), and the locale the
// hello names (deDE).
export const INTRO_MAX_TOKENS = 120;
export const GREETING_RE = /^\s*(?:hi|hii+|hey|hello|hallo|hullo|howdy|yo|greetings|hola|salut|bonjour|ciao|hej|moin|servus|ol[aá]|oi|hiya|sup)\s*[!.?]*\s*$/i;
const LOCALE_RE = /^[a-z]{2}[A-Z]{2}$/;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const short = e => redact(String(e?.message ?? e)).slice(0, 160);

/** A userLine action → what the addon offers under the bubble. */
export function actionOf(a) {
  if (!a) return 'none';
  if (a.id === 'retry') return 'retry';
  if (a.id === 'send_again') return 'send_again';
  if (a.desktop) return 'desktop';
  return 'none';
}

/** The backend's settings from the bridge config (its `byok` section, or the object itself). */
export function settingsOf(config) {
  const c = isObj(config?.byok) ? config.byok : isObj(config) ? config : {};
  const effort = c.effort === null ? null : EFFORTS.includes(c.effort) ? c.effort : 'low'; // DB22: low by default
  return {
    provider: typeof c.provider === 'string' && c.provider ? c.provider : 'anthropic',
    model: typeof c.model === 'string' && c.model ? c.model : null,
    // Other's service (provider 'custom'): its base URL and model (providers/index.mjs customManifest).
    custom: isObj(c.custom) ? { baseUrl: typeof c.custom.baseUrl === 'string' ? c.custom.baseUrl : null, model: typeof c.custom.model === 'string' ? c.custom.model : null } : null,
    effort,
    auth: c.auth === 'oauth' ? 'oauth' : 'key',
    persona: personaName(c.persona?.name ?? c.companion),
    caps: isObj(c.caps) ? { ...c.caps } : {},
    identity: c.privacy?.identity === true,
    sendNames: c.privacy?.otherNames === true,
    memory: c.memory !== false,
    historyBudget: Number.isInteger(c.history?.budget) && c.history.budget >= 0 ? c.history.budget : HISTORY_BUDGET,
    requestOptions: isObj(c.requestOptions) ? { ...c.requestOptions } : null,
    safetyId: typeof c.safetyId === 'string' && /^[0-9a-f-]{8,64}$/i.test(c.safetyId) ? c.safetyId : null,
    // How long transcripts are kept (§6.4, §13.1; the app's setting, 1 to 365 days, default 30).
    retentionDays: Number.isInteger(c.transcripts?.retentionDays) && c.transcripts.retentionDays >= 1 && c.transcripts.retentionDays <= RETENTION_MAX_DAYS ? c.transcripts.retentionDays : RETENTION_DAYS,
  };
}

// {name, realm} of the character a turn is about: the state's, else the context's "Character:" line.
function charOf(state, contextLines) {
  if (isObj(state?.char) && typeof state.char.name === 'string' && state.char.name) return { name: state.char.name, realm: state.char.realm ?? null };
  const ctx = Array.isArray(contextLines) ? contextLines.join('\n') : String(contextLines ?? '');
  const m = /^Character: (.+?) on ([^,\n]+)/m.exec(ctx);
  return m ? { name: sanitizeGameString(m[1], 60), realm: sanitizeGameString(m[2], 60) } : null;
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const on = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', on); resolve(true); }, ms);
    signal?.addEventListener('abort', on, { once: true });
  });
}

// One provider call, collected: {text, usage, finish, requestId, rateLimit, error, started, served}.
// started: the provider answered 200 and its stream began. served: the model id the provider says
// answered, when it names one (a dated alias of the one asked for): for the log only, never the
// reply's usage.model. hooks: onRequest (the request as sent, the "Last request" view), onStart (an
// answer came: the network is up).
const servedOf = v => (typeof v === 'string' && MODEL_ID_RE.test(v) ? v : null);
async function streamOnce(provider, req, signal, id, { onRequest = null, onStart = null, now = Date.now } = {}) {
  // firstAt: when the model first wrote (reasoning or text), so its pace leaves out the prompt's reading.
  const out = { text: '', usage: null, finish: null, requestId: null, rateLimit: null, error: null, started: false, served: null, reasoned: false, firstAt: null };
  try {
    for await (const ev of provider.stream(req, { signal, onRequest })) {
      if (ev.type === 'start') {
        out.started = true;
        out.requestId = cleanRequestId(ev.requestId) ?? null; // KB-09: the ledger and the log get only an id-shaped one
        out.rateLimit = ev.rateLimit ?? null;
        out.served = servedOf(ev.model) ?? out.served;
        try { onStart?.(); } catch { /* a hook never ends the call */ }
      } else if (ev.type === 'text') { out.text += ev.delta; out.firstAt ??= now(); }
      else if (ev.type === 'reasoning') { out.reasoned = true; out.firstAt ??= now(); }
      else if (ev.type === 'usage') {
        out.usage = ev.usage;
        out.served = servedOf(ev.usage?.model) ?? out.served;
        if (ev.usage?.reasoning > 0) out.reasoned = true; // hidden reasoning, counted (OpenAI's reasoning_tokens)
      }
      else if (ev.type === 'done') out.finish = ev.finish;
      else if (ev.type === 'error') out.error = ev.error;
    }
  } catch {
    out.error = makeError({ kind: signal?.aborted ? 'interrupted' : 'unknown', provider: id, aborted: signal?.aborted || undefined, code: 'stream_threw' });
  }
  if (!out.error && !out.finish) out.error = makeError({ kind: 'unknown', provider: id, code: 'no_finish' });
  // Thinking an Other server sent as the reply's own text is reasoning, never the reply (a failed attempt
  // keeps its text: it says generation began, failedMidReply). The AI companies' own APIs never do this.
  const thought = out.error || provider.manifest?.custom !== true ? null : splitThink(out.text);
  if (thought) { out.text = thought.text; out.reasoned = true; }
  return out;
}

/**
 * A reply's thinking sent as its text: DeepSeek-R1 and Qwen3 write it "within <think> </think> tags", and a
 * server that doesn't take it out sends it as text: LM Studio before 0.4.7 (its separate reasoning_content
 * became the default then), llama.cpp run with --reasoning-format none, some gateways, older Ollama. A
 * leading <think> block, or, where the server's template opened it in the prompt, the text up to a lone
 * </think>, goes: → {text: the reply after it} ('' when the block never closed: the reply's room ran out
 * while it thought), or null for a reply with none.
 */
export function splitThink(text) {
  if (typeof text !== 'string') return null;
  const close = text.search(/<\/think>/i);
  if (/^\s*<think>/i.test(text)) return { text: close < 0 ? '' : text.slice(close + 8).replace(/^\s+/, '') };
  if (close >= 0 && !/<think>/i.test(text.slice(0, close))) return { text: text.slice(close + 8).replace(/^\s+/, '') };
  return null;
}

// What a turn's attempts cost, and whether they reached the provider. inFlight: a request is out and
// its outcome not yet read (a throw or a stop then can't know whether it was billed).
function newSpend() { return { micros: 0, in: 0, out: 0, exact: true, metered: false, answered: false, unknown: false, inFlight: false }; }
function addAttempt(sp, r, price) {
  sp.inFlight = false;
  if (r.usage) {
    const m = meterReply(r.usage, price, { errorKind: r.error?.kind ?? null });
    sp.micros += m.micros;
    sp.in += m.in;
    sp.out += m.out;
    sp.exact = sp.exact && m.exact;
    sp.metered = true;
  }
  const e = r.error;
  if (!e) sp.answered = true;
  else if (UNKNOWN_OUTCOME.has(e.kind)) sp.unknown = true; // billed, or billed past what was metered: we can't know
  else if (failedMidReply(r)) { sp.unknown = true; sp.exact = false; } // generation began: the partial count may be short
  else if (r.usage || (!NOT_SENT.has(e.kind) && !(e.kind === 'unknown' && NOT_SENT_CODES.has(e.code)))) sp.answered = true;
  return sp;
}

/**
 * Did this attempt fail after the provider began generating? Its stream had started and it reported
 * partial usage (Anthropic's message_start, then overloaded mid-stream) or streamed reply text with
 * no count at all. Such an attempt counts at max(metered, estimate). A failure with a complete count
 * (a context-window stop) or with nothing generated (an error inside a 200) counts what it reported.
 */
export function failedMidReply(r) {
  if (!r?.error || !r.started) return false;
  if (r.usage) return r.usage.partial === true;
  return typeof r.text === 'string' && r.text.length > 0;
}

/**
 * The request a reply with no text that ran out of room (finish 'length': a thinking model that
 * thought its whole output ceiling away) is tried again with, never the same one:
 * - 'lower': the model's lowest thinking level (Off where it has it) with the same reply ceiling, so
 *   only the thinking room shrinks;
 * - 'room': where it can't go lower (no levels, or at its lowest already), the same level with more
 *   room: the output ceiling raised by the next level up's room (THINK_ROOM's next step above its own
 *   room for a model with no levels), never past the model's output ceiling (outputCeiling). A model with
 *   no levels that was seen thinking (reasoned: Other's qwen3, deepseek-r1 or gpt-oss, which think by
 *   default and count it in max_tokens) gets High's room at least: Minimal's 1,024 more never fit one.
 * Within the run's time: never more than the failed attempt's pace (perSecond: tokens it wrote a second
 * from its first one) writes in PACE_SHARE of the time left to write in (leftMs). A try that can't write
 * at least THINK_ROOM's first step more than this one can't help, so there's none: a slow local model
 * ends with its line now rather than the same line, or a timeout, a minute later.
 * → {how, req}, or null when there's no more room to give (the turn ends with its line).
 */
export const PACE_SHARE = 0.8;
export function roomForRetry(req, manifest, model, { reasoned = false, perSecond = 0, leftMs = Infinity } = {}) {
  if (!req) return null;
  const reply = Number.isInteger(req.replyTokens) && req.replyTokens > 0 ? req.replyTokens : MAX_TOKENS;
  const ceiling = outputCeiling(manifest, model);
  const levels = req.effort ? effortLevels(manifest, model) : [];
  const low = levels[0] ?? null;
  if (low && low !== req.effort) return { how: 'lower', req: { ...req, effort: low, maxTokens: Math.min(reply + thinkRoom(low, manifest, model), ceiling) } };
  const at = levels.indexOf(req.effort);
  const next = at >= 0 ? levels[at + 1] : undefined;
  const room = thinkRoom(req.effort ?? null, manifest, model);
  const step = THINK_ROOM[EFFORT_LEVELS.find(l => THINK_ROOM[l] > room)] ?? 0;
  const more = next ? THINK_ROOM[next] : reasoned && !levels.length ? Math.max(step, THINK_ROOM.high) : step;
  let maxTokens = Math.min(req.maxTokens + more, ceiling);
  if (perSecond > 0 && leftMs < Infinity) maxTokens = Math.min(maxTokens, Math.floor(perSecond * Math.max(0, leftMs) / 1000 * PACE_SHARE));
  return maxTokens >= req.maxTokens + THINK_ROOM.minimal ? { how: 'room', req: { ...req, maxTokens } } : null;
}

/** Does this model have thinking levels (the Thinking menu in the window, Thinking in the app)? */
export function hasThinking(manifest, model) {
  return !!manifest && modelHasEffort(manifest, model) !== false && effortLevels(manifest, model).length > 0;
}

/** A reply's usage as its transcript row keeps it (runtime/history.mjs rowUsage): {in, out, micros, model, exact} in whole numbers, or null. */
export const turnUsage = rowUsage;

/** Does the provider offer this model id to a chat (/bones model)? Listed, or any id where the manifest allows any. */
export function modelOffered(manifest, id) {
  if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) return false;
  return manifest?.models?.allowAny === true || (manifest?.models?.list ?? []).some(e => e?.id === id);
}

/** The memory digest as plain lines, for the app's memory page (the object is what a turn sends). */
export function digestText(d) {
  if (!isObj(d)) return '';
  const parts = [];
  if (d.updated) parts.push(`Updated ${d.updated}`);
  const section = (title, lines) => { if (Array.isArray(lines) && lines.length) parts.push(`${title}:\n${lines.map(l => `- ${l}`).join('\n')}`); };
  section('Character', d.character);
  section('Recent', d.recent);
  section('Notes', d.notes);
  section('Quests', d.quests);
  return parts.join('\n\n');
}

/** A character from the app: {name, realm}, or "Name-Realm" (a character name has no hyphen). */
export function charArg(char) {
  if (isObj(char) && typeof char.name === 'string' && char.name.trim()) {
    return { name: char.name.trim().slice(0, 60), realm: typeof char.realm === 'string' && char.realm.trim() ? char.realm.trim().slice(0, 60) : null };
  }
  if (typeof char !== 'string' || !char.trim()) return null;
  const s = char.trim();
  const i = s.indexOf('-');
  return i > 0 ? { name: s.slice(0, i).slice(0, 60), realm: s.slice(i + 1).slice(0, 60) || null } : { name: s.slice(0, 60), realm: null };
}

/** What a turn's attempts count for under the caps: {micros, exact}, or null when nothing left the machine. */
export function spendOf(sp, est = 0) {
  if (!sp) return null;
  if (sp.unknown || sp.inFlight) return { micros: Math.max(sp.micros, est || 0), exact: false };
  if (sp.answered || sp.metered) return { micros: sp.micros, exact: sp.exact };
  return null;
}

/**
 * createLocalBackend(handlers, opts). opts:
 *   config      the bridge config (its `byok` section is read: provider, model, effort, auth,
 *               persona {name}, caps, privacy {identity, otherNames}, memory,
 *               history {budget}, requestOptions, safetyId)
 *   dataDir     the per-user app data folder (0700): transcripts/, memory/, ledger.json,
 *               usage-history.json, byok-chats.json
 *   keystore    security/keystore.mjs's store (get, list); keys are read for each request only
 *   manifests   loadManifests()'s list (default: the bundled ones)
 *   priceBook   usage/prices.mjs's createPriceBook() (default: the bundled table)
 *   providerOpts  extra createProvider options (timeouts, headers); fetch: an injected fetch
 *   log, now, random, concurrency, sleep(ms, signal) → Promise<bool>
 *   runMs       the whole run's wall-clock limit (default: providerOpts.timeouts.runMs, else 180 s)
 *   deadline(ms) → an AbortSignal that aborts ms from now (default AbortSignal.timeout; tests: a fake clock's)
 *   holdMs      how long a turn that never left waits for the network, from its message (10 min)
 *   holdProbeMs {first, max}: the held turn's probe waits (5 s doubling to 60 s)
 *   checks      {models}: the start-time model check (PV-3), on by default; the test helpers turn it
 *               off unless a test asks
 *   pruneEveryMs   how often transcripts past the retention are pruned while running (daily)
 *   writer      the bridge's write queue (code health BR-04, write-queue.mjs): the ledger's
 *               writes go through it, in order with the core's, and its 'sending' mark is awaited
 */
export function createLocalBackend(handlers = {}, opts = {}) {
  const {
    dataDir, keystore = null, log = () => {}, now = Date.now, random = Math.random,
    providerOpts = {}, concurrency = CONCURRENCY, sleep = wait, deadline: deadlineAfter = ms => AbortSignal.timeout(ms),
  } = opts;
  if (!dataDir) throw new Error('createLocalBackend needs the data folder (dataDir)');
  const runMs = [opts.runMs, providerOpts.timeouts?.runMs].find(v => Number.isFinite(v) && v > 0) ?? RUN_MS;
  const holdMs = Number.isFinite(opts.holdMs) && opts.holdMs >= 0 ? opts.holdMs : HOLD_MS;
  const holdProbe = {
    first: Number.isFinite(opts.holdProbeMs?.first) && opts.holdProbeMs.first > 0 ? opts.holdProbeMs.first : HOLD_PROBE_MS.first,
    max: Number.isFinite(opts.holdProbeMs?.max) && opts.holdProbeMs.max > 0 ? opts.holdProbeMs.max : HOLD_PROBE_MS.max,
  };
  const checks = { models: opts.checks?.models !== false };
  const pruneEveryMs = Number.isFinite(opts.pruneEveryMs) && opts.pruneEveryMs > 0 ? opts.pruneEveryMs : PRUNE_EVERY_MS;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch { /* Windows: the per-user folder's ACL */ }
  const clock = () => +now();
  // The local brain (odd/tasks/nqa-brain.md B6): sourced facts for what the player asks, from
  // <dataDir>/brain/brain.sqlite when it exists (tools/brain). Loaded once in the background; a turn
  // that comes before it, or any error, simply goes without facts.
  const brain = { retrieve: null, db: null, tried: false };
  const brainChat = opts.brainChat !== false && process.env.NQA_BRAIN_CHAT !== '0';
  const FAST_MAX_TOKENS = 500; // a short answer, its map block and the TL;DR
  let chatPackCache = null;
  const chatPack = () => (chatPackCache && chatPackCache.name === personaName(settings.persona) ? chatPackCache : (chatPackCache = loadChatPack({ persona: { name: settings.persona } })));
  const brainFacts = (question, state) => {
    if (opts.brain === false) return [];
    if (!brain.tried) {
      const file = path.join(dataDir, 'brain', 'brain.sqlite');
      // Not there yet (not imported): try again on a later turn.
      if (fs.existsSync(file)) {
        brain.tried = true;
        Promise.all([import('../../tools/brain/db.mjs'), import('../../tools/brain/retrieve.mjs'), import('../../tools/brain/profile.mjs')])
          .then(([d, r, p]) => { brain.db = d.openBrain(file, { readOnly: true }); brain.retrieve = r.retrieve; brain.profile = p; log('byok-brain', { ready: true }); })
          .catch(e => log('byok-brain', { ready: false, error: short(e) }));
      }
      return [];
    }
    if (!question || !brain.retrieve || !brain.db) return [];
    try {
      const r = brain.retrieve({ db: brain.db, question, state });
      if (r.lines.length) log('byok-brain-facts', { facts: r.lines.length, ms: r.ms });
      const who = brain.profile && brain.profile.profileLines(brain.db, brain.profile.charKey(state));
      const lines = [...(who || []).slice(0, 6), ...r.lines];
      lines.found = r.lines.length;
      return lines;
    } catch (e) { log('byok-brain', { error: short(e) }); return []; }
  };
  brainFacts('', null); // start loading it now
  // After a typed turn (B4): the character's profile from the game, what the player said about
  // themselves, and both sides of the exchange as said rows (the model's words never become facts).
  const brainW = { db: null, profile: null, tried: false };
  const brainRemember = (state, typed, replyText) => {
    if (opts.brain === false) return;
    if (!brainW.tried) {
      brainW.tried = true;
      const file = path.join(dataDir, 'brain', 'brain.sqlite');
      if (fs.existsSync(file)) {
        Promise.all([import('../../tools/brain/db.mjs'), import('../../tools/brain/profile.mjs')])
          .then(([d, p]) => { brainW.db = d.openBrain(file); brainW.profile = p; })
          .catch(e => log('byok-brain', { write: false, error: short(e) }));
      }
    }
    if (!brainW.db || !brainW.profile) return;
    try {
      const P = brainW.profile;
      const key = P.updateFromState(brainW.db, state) || P.charKey(state);
      if (!key) return;
      const learned = typed ? P.learnFromPlayer(brainW.db, key, typed) : [];
      if (typed) P.recordSaid(brainW.db, key, 'player', 'chat', typed);
      if (replyText) P.recordSaid(brainW.db, key, 'brain', 'chat', replyText);
      if (learned.length) log('byok-brain-learned', { keys: learned });
    } catch (e) { log('byok-brain', { write: false, error: short(e) }); }
  };
  const manifests = opts.manifests ?? loadManifests({ onWarning: w => log('byok-manifest-warn', { provider: w.id, reason: String(w.reason).slice(0, 160) }) });
  const priceBook = opts.priceBook ?? createPriceBook();
  let settings = settingsOf(opts.config);
  // What this session learned of an Other model (by its address and id): the thinking controls its server
  // reported (provider.thinking; undefined until read), the room a reply needed once it was seen thinking,
  // and the pace it last answered at (tokens a second from its first), so later turns ask for what the
  // model takes and don't waste a first try thinking its room away, within what that pace writes in a
  // run (PACE_SHARE of it). A run that times out forgets the room: the next turn learns it again.
  const learned = new Map();
  const learnedOf = p => {
    const key = `${p.manifest.baseUrl}\u0000${p.model}`;
    if (!learned.has(key)) learned.set(key, { options: undefined, room: 0, pace: 0 });
    return learned.get(key);
  };
  const safe = (fn) => { try { return fn(); } catch (e) { log('byok-handler-error', { error: short(e) }); return undefined; } };
  const on = {
    ready: h => safe(() => handlers.onReady?.(h)),
    state: s => safe(() => handlers.onState?.(s)),
    event: e => safe(() => handlers.onEvent?.(e)),
    resume: () => safe(() => handlers.onResume?.()),
    // push: the player changed something in the app (or a model was switched under a chat), and
    // the addon reads a slot only when its push doorbell rings: ring it (a retired model's notice needn't).
    change: ({ push = false } = {}) => { if (started && !stopped) safe(() => handlers.onChange?.({ push: push === true })); },
  };

  const ledger = createLedger(path.join(dataDir, 'ledger.json'), { now: clock, log, writer: opts.writer ?? null });
  // The usage history is the one store of daily totals; caps checks a cap the player set against it.
  const usageHist = createUsageHistory({ file: path.join(dataDir, 'usage-history.json'), now: clock, log });
  const caps = createCaps({ history: usageHist, config: settings.caps, now: clock, log });
  // The retention is read at each use, so a change in the app applies at once (final review L5-5).
  const transcripts = createTranscripts(dataDir, { now: clock, retentionDays: () => settings.retentionDays });
  const memory = createMemory(dataDir);
  const pseudonymizer = createPseudonymizer(); // one per bridge run: "Player A" is stable for the session
  const queue = createRunQueue({ concurrency });
  let pack = loadPack({ persona: { name: settings.persona } });

  // ---------------------------------------------------------------- byok-chats.json
  // The per-install safety id, and per chat its own model (/bones model) and the provider it's for. An
  // older build kept each chat's session key, session id, label, last row time and turns' idempotency
  // keys here too, for the deleted gateway's chat.history (code health BR-22): read past, and dropped at
  // the next write. That build reads this file as before (what it misses, it starts afresh).
  const sideFile = path.join(dataDir, 'byok-chats.json');
  let side = { v: 1, safetyId: null, chats: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(sideFile, 'utf8'));
    if (isObj(raw) && isObj(raw.chats)) side = { v: 1, safetyId: typeof raw.safetyId === 'string' ? raw.safetyId : null, chats: {} };
    for (const [id, c] of Object.entries(raw?.chats ?? {})) {
      if (!CHAT_RE.test(id) || !isObj(c)) continue;
      if (typeof c.model === 'string' && MODEL_ID_RE.test(c.model) && typeof c.modelProvider === 'string' && c.modelProvider) {
        side.chats[id] = { model: c.model, modelProvider: c.modelProvider.slice(0, 32) };
      }
    }
  } catch (e) { if (e.code !== 'ENOENT') log('byok-chats-read-failed', { code: e.code || 'corrupt' }); }
  const saveSide = () => {
    try { writeFileQuick(sideFile, JSON.stringify(side) + '\n', 0o600); } catch (e) { log('byok-chats-write-failed', { code: e.code || 'error' }); }
  };
  // The install's safety id is made once and kept (§7.2, §13.1).
  if (!side.safetyId) { side.safetyId = crypto.randomUUID(); saveSide(); }
  // Row times rise strictly per chat (they are the rows' seq, and a reply's __nqa id): past the chat's
  // last row, which its transcript says once per run of the app.
  const lastTs = new Map();
  const nextT = (chatId) => {
    let last = lastTs.get(chatId);
    if (last === undefined) { try { last = transcripts.rows(chatId, 1)[0]?.t ?? 0; } catch { last = 0; } }
    const t = Math.max(clock(), last + 1);
    lastTs.set(chatId, t);
    return t;
  };
  const safetyId = () => settings.safetyId || side.safetyId;

  // The transcripts as the app sees them: forgetting a chat's (or all of them) also drops the chat's
  // last request.
  const transcriptsApi = Object.freeze({
    dir: transcripts.dir,
    append: (chatId, row) => transcripts.append(chatId, row),
    window: (chatId, budget) => transcripts.window(chatId, budget),
    rows: (chatId, limit) => transcripts.rows(chatId, limit),
    chats: () => transcripts.chats(),
    prune: days => transcripts.prune(days),
    /** Delete one chat's transcript: true when there was one. */
    forget(chatId) {
      if (!CHAT_RE.test(String(chatId ?? ''))) return false;
      const had = transcripts.forget(chatId);
      dropRequests(chatId);
      log('byok-transcript-forget', { chat: chatId, had });
      return had;
    },
    /** Delete every transcript ("delete all"): how many. */
    deleteAll: deleteAllTranscripts,
    forgetAll: deleteAllTranscripts,
  });
  function deleteAllTranscripts() {
    const n = transcripts.forgetAll();
    dropRequests();
    log('byok-transcript-forget', { all: true, count: n });
    return n;
  }

  // ---------------------------------------------------------------- the provider
  let prov = null;
  function current() {
    if (prov) return prov;
    const manifest = manifestFor(settings.provider, manifests, settings.custom);
    if (!manifest) throw new Error(`unknown provider ${String(settings.provider).slice(0, 32)}`);
    const model = settings.model ?? manifest.models?.default ?? null;
    const listed = manifest.models?.list?.find(e => e.id === model);
    const provider = createProvider(manifest, {
      getKey: async (id) => {
        if (!keystore) return null;
        const key = await keystore.get(id);
        return key && settings.auth === 'oauth' ? { key, kind: 'oauth' } : key;
      },
      log,
      now: clock,
      requestOptions: settings.requestOptions,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...providerOpts,
    });
    // free: a server on this computer, or one at home serving its own model (customManifest's priceSource).
    prov = { id: manifest.id, manifest, model, provider, local: manifest.local === true, free: manifest.local === true || manifest.priceSource === 'free', name: manifest.name, modelName: listed?.label ?? model ?? '' };
    return prov;
  }
  const names = () => {
    let p = null;
    try { p = current(); } catch { /* an unknown provider: its id stands in */ }
    return { provider: p?.name ?? settings.provider, model: p ? p.modelName || p.model || undefined : undefined, companion: settings.persona, product: PRODUCT };
  };

  // ---------------------------------------------------------------- a chat's own model (/bones model)
  /** The chat's own model while its provider is the one in use, else null (the provider's applies). */
  function ownModel(chatId) {
    const c = side.chats[chatId];
    if (!c?.model) return null;
    let p;
    try { p = current(); } catch { return null; }
    return c.modelProvider === p.id ? c.model : null;
  }
  /** The provider as a chat's turn uses it: with the chat's own model in place of the provider's. */
  function viewFor(p, model) {
    if (!model || model === p.model) return p;
    return { ...p, model, modelName: p.manifest.models?.list?.find(e => e.id === model)?.label || model };
  }
  /** /bones model: set (an id the provider offers) or clear (null, 'default') a chat's own model. */
  function setChatModel(chatId, v) {
    if (!CHAT_RE.test(String(chatId ?? ''))) throw badRequest('chatId must be a chat id');
    const want = v === null || v === undefined || (typeof v === 'string' && v.trim().toLowerCase() === 'default') ? null : v;
    if (want !== null && (typeof want !== 'string' || !MODEL_ID_RE.test(want) || looksLikeKey(want))) return { ok: false, error: 'bad_model' };
    let p;
    try { p = current(); } catch { return { ok: false, error: 'unknown_model' }; }
    if (want !== null && !modelOffered(p.manifest, want)) {
      log('byok-chat-model', { chat: chatId, provider: p.id, refused: 'unknown_model' });
      return { ok: false, error: 'unknown_model' };
    }
    if (want === null) delete side.chats[chatId]; else side.chats[chatId] = { model: want, modelProvider: p.id };
    saveSide();
    log('byok-chat-model', { chat: chatId, provider: p.id, model: want ?? 'default' });
    return { ok: true, model: want };
  }
  /** Drop a chat's own model (a provider change, or the provider said it has no such model). */
  function dropOwnModel(chatId) {
    if (!side.chats[chatId]?.model) return false;
    delete side.chats[chatId];
    saveSide();
    return true;
  }
  /**
   * What the core publishes in chats[] for a chat (BUILD-PLAN "Contract: what the addon reads"):
   * {model?, modelName?, effortSupported, efforts?, effort?}. model/modelName: the chat's own, absent
   * when it uses the provider's; effortSupported: for the model its next turn uses; efforts: the
   * chat's own model's thinking levels, cheapest first, as one space-separated string ("off low
   * medium high xhigh max"), only with model (a chat on the provider's model reads bridge.provider's
   * efforts, so the slot head doesn't carry one list per chat); effort: the level that turn sends
   * (think, the chat's /bones think as the core sends it with send's `thinking`, else the player's
   * effort, as the model's nearest level), absent when the model has none or none is set.
   */
  function chatSlot(chatId, { think = null } = {}) {
    let base;
    try { base = current(); } catch { return undefined; }
    const own = ownModel(chatId);
    const p = viewFor(base, own);
    const supported = modelHasEffort(p.manifest, p.model) !== false;
    const out = {};
    if (own) { out.model = own; out.modelName = p.modelName || own; }
    out.effortSupported = supported;
    const levels = own && supported ? effortLevels(p.manifest, p.model) : [];
    if (levels.length) out.efforts = levels.join(' ');
    const want = EFFORTS.includes(think) ? think : settings.effort;
    let effort = null;
    if (supported && EFFORTS.includes(want)) { try { effort = resolveEffort(want, p.manifest, p.model); } catch { effort = null; } }
    if (effort) out.effort = effort;
    return out;
  }

  // ---------------------------------------------------------------- the last request (KY-8)
  // Per chat, the last turn's request exactly as it went (the provider layer redacts the auth
  // header): in memory only, never written, logged or put in the diagnostics bundle.
  // Each holds a whole prompt, so only the LAST_REQUESTS chats used last keep theirs (code health BR-12).
  const lastRequests = new Map(); // chatId → view, the chat used last at the end
  let lastRequestAny = null;
  function keepRequest(chatId, purpose, p, r) {
    const one = { at: clock(), method: r.method || 'POST', url: redact(String(r.url || '')), headers: { ...r.headers }, body: r.body };
    const view = { chatId, purpose: 'turn', provider: p.id, model: p.model || '', ...one };
    lastRequests.delete(chatId);
    lastRequests.set(chatId, view);
    while (lastRequests.size > LAST_REQUESTS) lastRequests.delete(lastRequests.keys().next().value);
    lastRequestAny = view;
  }
  function dropRequests(chatId = null) {
    if (chatId === null) { lastRequests.clear(); lastRequestAny = null; return; }
    lastRequests.delete(chatId);
    if (lastRequestAny?.chatId === chatId) lastRequestAny = [...lastRequests.values()].sort((a, b) => b.at - a.at)[0] ?? null;
  }

  // ---------------------------------------------------------------- transcripts past the retention
  let pruneTimer = null;
  // Asynchronous reads, each transcript's head first (code health BR-20: runtime/history.mjs pruneAsync).
  async function pruneTranscripts(reason) {
    try {
      const r = await transcripts.pruneAsync();
      if (r?.removed) log('byok-transcripts-pruned', { reason, rows: r.removed, files: r.files, days: settings.retentionDays });
    } catch (e) { log('byok-prune-error', { error: short(e) }); }
  }

  // ---------------------------------------------------------------- the model check (PV-3)
  // A provider or key change starts a new generation: a model check from before it is dropped when it lands.
  let provGen = 0;
  let notice = null; // {kind: 'model_switched', from, to, at} | {kind: 'model_retired', model, at}
  let noticeLine = null; // the §10 line the next turn's chat gets once
  let modelCheck = null; // {at, ok, models?, errorKind?, code?}
  let discoveredModels = []; // current service only; populated by the existing /models check
  let checkBusy = null;
  let checkFor = -1; // the generation the running check is for
  const modelLabel = (manifest, id) => manifest.models?.list?.find(e => e.id === id)?.label || id;
  /**
   * The provider's model list against the chosen model: kept, switched (the named replacement, else
   * the nearest no dearer; a notice), or retired (a notice, the model kept: the turn says so if it
   * fails). A list that can't be read keeps the model. Resolves to {ok, switched?, from?, to?}.
   */
  function checkModel({ reason = 'start' } = {}) {
    if (!checks.models || stopped) return Promise.resolve(null);
    let p;
    try { p = current(); } catch { return Promise.resolve(null); }
    if (!p.model || keyState === 'missing') return Promise.resolve(null);
    if (checkBusy && checkFor === provGen) return checkBusy; // one from before a provider or key change bails out when it lands
    const gen = provGen;
    checkFor = gen;
    const run = (async () => {
      try {
        const r = await p.provider.validate({});
        if (stopped || prov !== p || gen !== provGen) return null;
        if (!r.ok) {
          modelCheck = { at: clock(), ok: false, errorKind: r.error?.kind ?? 'unknown', code: r.error?.code ?? undefined };
          log('byok-model-check', { reason, provider: p.id, model: p.model, kept: true, ...errorLogFields(r.error) });
          if (r.error?.kind === 'auth_invalid' || r.error?.kind === 'oauth_expired') { noteTrouble(r.error); syncState(); }
          return { ok: false };
        }
        modelCheck = { at: clock(), ok: true, models: r.models.length };
        const previous = JSON.stringify(modelChoices(p));
        discoveredModels = r.models;
        if (JSON.stringify(modelChoices(p)) !== previous) on.change({ push: true });
        const res = resolveModel(p.manifest, r.models, p.model);
        if (res.model && !res.switched) {
          log('byok-model-check', { reason, provider: p.id, model: p.model, available: true });
          if (notice?.kind === 'model_retired' && notice.model === p.model) notice = null;
          return { ok: true, switched: false };
        }
        if (res.switched) {
          const from = p.model;
          settings = { ...settings, model: res.model };
          prov = null;
          current();
          notice = { kind: 'model_switched', from, to: res.model, at: clock() };
          noticeLine = lineFor({ kind: 'model_not_found', provider: p.id }, { model: modelLabel(p.manifest, from), fallbackModel: modelLabel(p.manifest, res.model) });
          log('byok-model-switched', { reason, provider: p.id, from, to: res.model, by: res.by });
          on.change({ push: true });
          return { ok: true, switched: true, from, to: res.model };
        }
        notice = { kind: 'model_retired', model: p.model, at: clock() };
        log('byok-model-check', { reason, provider: p.id, model: p.model, available: false, replacement: false });
        on.change();
        return { ok: true, switched: false, retired: true };
      } catch (e) {
        log('byok-model-check', { reason, error: short(e), kept: true });
        return null;
      } finally { if (checkBusy === run) checkBusy = null; }
    })();
    checkBusy = run;
    return run;
  }
  // A new provider, model or key: what was read about the old one goes, and the check runs again.
  function providerChanged({ keyChanged = false } = {}) {
    provGen += 1;
    discoveredModels = [];
    if (keyChanged) modelCheck = null;
    checkModel({ reason: keyChanged ? 'key' : 'provider' });
  }

  // ---------------------------------------------------------------- state
  let started = false;
  let stopped = false;
  let paused = false;
  let keyState = 'ok'; // ok | missing | invalid | expired
  let keyReason = null;
  let st = { state: 'connecting', since: clock(), reason: null };
  let trouble = null; // out_of_credit | provider_down | local_down, until a turn succeeds
  let slowedUntil = 0;
  let slowedBy = null; // the error that slowed us ({kind}), for the line a held turn gets
  // The last refusal at the player's spend cap today, {day, reason, est, kind}: rt says 'cap' while a
  // turn like it would still be refused (a raised or cleared cap makes room again).
  let capHit = null;
  let lastError = null; // {kind, code, at} for status()

  function evalState() {
    if (paused) return ['paused', 'paused'];
    if (keyState === 'missing') return ['no_key', keyReason || 'no key'];
    if (keyState === 'invalid') return ['key_invalid', 'key rejected'];
    if (keyState === 'expired') return ['key_invalid', 'sign-in ended'];
    return ['ready', null];
  }
  let helloSent = false; // onReady went out: a later return to ready is a resume
  function syncState() {
    if (!started || stopped) return;
    const [state, reason] = evalState();
    if (st.state === state && st.reason === reason) return;
    const wasReady = st.state === 'ready';
    st = { state, since: clock(), reason };
    on.state({ state, since: st.since, reason });
    // Back to ready (a key added or replaced, unpaused): the core sends what it held now, not at its
    // next 30-second flush. Its first ready comes with onReady, which flushes anyway.
    if (state === 'ready' && !wasReady && helloSent) on.resume();
  }
  async function checkKey() {
    let p;
    try { p = current(); } catch { keyState = 'missing'; keyReason = 'unknown provider'; return; }
    if (p.local) { keyState = 'ok'; return; }
    // Other (custom) runs with or without a key: the service it names decides (a 401 is auth_invalid).
    if (p.manifest.auth?.optional === true) { if (keyState === 'missing') { keyState = 'ok'; keyReason = null; } return; }
    if (!keystore) { keyState = 'missing'; keyReason = 'no key store'; return; }
    try {
      const has = typeof keystore.list === 'function' ? (await keystore.list([p.id])).includes(p.id) : !!(await keystore.get(p.id));
      if (!has) { keyState = 'missing'; keyReason = 'no key'; } else if (keyState === 'missing') { keyState = 'ok'; keyReason = null; }
    } catch {
      keyState = 'missing';
      keyReason = 'key store unreadable';
    }
  }
  // The last failure, for status(): streak counts the one-off kinds (bad_request, unknown) in a row
  // with no reply between, so the desktop can tell one from a pattern (desktop UI critic D-33).
  const ONE_OFF = new Set(['bad_request', 'unknown']);
  function noteLastError(err) {
    const prev = lastError;
    const streak = prev && ONE_OFF.has(prev.kind) && ONE_OFF.has(err.kind) ? (prev.streak ?? 1) + 1 : 1;
    lastError = { kind: err.kind, code: err.code ?? null, at: clock(), streak };
  }
  function noteTrouble(err) {
    noteLastError(err);
    switch (err.kind) {
      case 'auth_invalid': keyState = 'invalid'; break;
      case 'oauth_expired': keyState = 'expired'; break;
      case 'no_key': keyState = 'missing'; keyReason = err.code === 'keystore_error' ? 'key store unreadable' : 'no key'; break;
      case 'rate_limited': slowedUntil = clock() + (Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 60000); slowedBy = { kind: err.kind }; break;
      case 'rate_limited_daily':
        slowedUntil = Number.isFinite(err.resetAt) ? err.resetAt : clock() + 3600000;
        slowedBy = { kind: err.kind };
        break;
      case 'out_of_credit': trouble = 'out_of_credit'; break;
      case 'overloaded': case 'timeout': trouble = 'provider_down'; break;
      case 'local_unreachable': trouble = 'local_down'; break;
      case 'cap_spend': capHit = { day: localDay(clock()), reason: err.kind, est: err.capEst ?? null, kind: err.capKind ?? 'typed' }; break;
      default: break;
    }
  }
  // A reply's rate-limit headers (US-3): a bucket at 0 means slowed until it resets (all of them).
  function noteRateLimit(rl) {
    if (!isObj(rl)) return;
    const at = clock();
    const resets = Object.values(rl).filter(b => isObj(b) && b.remaining === 0 && Number.isFinite(b.resetAt) && b.resetAt > at).map(b => b.resetAt);
    if (resets.length && Math.max(...resets) > slowedUntil) { slowedUntil = Math.max(...resets); slowedBy = { kind: 'rate_limited' }; }
  }

  // ---------------------------------------------------------------- events
  function emit(event, payload) {
    if (stopped) return;
    on.event({ event, payload });
  }
  const emitChat = (t, fields) => emit('chat', { chatId: t.chatId, runId: t.runId, ...fields });
  const emitAgent = (t, stream, data) => emit('agent', { chatId: t.chatId, runId: t.runId, stream, data });

  // The fixed line for a kind (§10): userLine's for the provider's kinds, the bridge's own for its.
  function lineFor(err, extra = {}) {
    if (err.kind === 'refused') return { headline: 'That looks like an API key.', detail: "It wasn't sent.", action: 'none' };
    const snap = caps.snapshot();
    // capHeld: a cap held because today's spend couldn't be read (BR-09), whose refusal says so, not "reached".
    const l = userLine(err, { ...names(), capMicros: snap.capMicros, ...(snap.held ? { capHeld: snap.held } : {}), now: clock(), ...extra });
    let { detail } = l;
    let action = actionOf(l.action);
    // After the retries, a request that never left isn't waiting to go: say so, and offer Retry.
    if (err.kind === 'network_before_send' && extra.final !== false) { detail = "Nothing was sent. Click Retry when you're back online."; action = 'retry'; }
    // A second choice beside the fix (D7): Pick Another AI on the busy and out-of-credit lines.
    return { headline: l.headline, detail, action, ...(l.alt?.id ? { alt: l.alt.id } : {}) };
  }
  const lineText = l => [l.headline, l.detail].filter(Boolean).join(' ');
  const bridgeError = (kind, extra = {}) => {
    const p = prov ?? null;
    return { kind, provider: p?.id ?? settings.provider, retryable: false, ...extra };
  };
  // A write on this computer failed (the ledger, a total): its own kind and line, never the AI's (SY-12).
  const localWrite = e => bridgeError('local_write', { code: /^E[A-Z]+$/.test(String(e?.fsCode ?? '')) ? e.fsCode : 'write_failed' });

  // A turn that counted (a reply, or a failure the provider may have billed), booked once: the usage
  // history's day totals, which a cap is checked against, and this session's.
  function noteUsage(t, p, { micros, exact, inTokens = 0, outTokens = 0, error = null }) {
    try {
      caps.book({ chatId: t.chatId, provider: p?.id ?? settings.provider, model: p?.model ?? '', in: inTokens, out: outTokens,
        micros, exact, auto: t.capKind === 'auto', error: error ?? undefined });
    } catch (e) { log('byok-usage-history-error', { error: short(e) }); }
  }

  function finishFailed(t, err, { final = true, fallbackModel = null, model = null } = {}) {
    // Out of time with a room it learned (the model got slower: the game on the same graphics card): the
    // next turn starts from the reply's own again, and learns it at the pace it has then.
    if (err.kind === 'timeout' && t.p?.manifest?.custom === true && learnedOf(t.p).room) {
      Object.assign(learnedOf(t.p), { room: 0, pace: 0 });
      log('byok-thinking-room', { provider: t.p.id, room: 0, reason: 'timeout' });
    }
    // What went out, booked once: nothing for a turn refused before it could send, or whose request
    // never left. At a bridge stop the ledger stays 'sending' and the next start books it at its
    // estimate (settleLeft), so it isn't booked here too.
    const counted = t.checked && !t.booked && !stopped ? spendOf(t.spend, t.est) : null;
    if (counted) {
      t.booked = true;
      noteUsage(t, t.p ?? prov, { micros: counted.micros, exact: counted.exact, inTokens: t.spend?.in || 0, outTokens: t.spend?.out || 0, error: err.kind });
    }
    if (stopped) return;
    try {
      ledger.set(t.idem, 'failed', { errorKind: err.kind, status: err.status, code: err.code, type: err.type, requestId: err.requestId, reason: err.aborted ? 'aborted' : undefined });
    } catch (e) { log('byok-ledger-error', { error: short(e) }); }
    noteTrouble(err);
    if (err.kind === 'interrupted' && err.aborted) emitChat(t, { state: 'aborted', stopReason: 'aborted' });
    else {
      // The model the line names: the one the turn went to (a chat's own model, not the provider's).
      const named = model ?? t.ownLabel ?? null;
      const tp = t.p ?? prov;
      const thinking = err.kind === 'empty_reply' && tp ? { thinking: hasThinking(tp.manifest, tp.model) } : {};
      const l = lineFor(err, { final, ...(fallbackModel ? { fallbackModel } : {}), ...(named ? { model: named } : {}), ...thinking });
      emitChat(t, { state: 'error', errorKind: err.kind, errorMessage: lineText(l), action: l.action, ...(l.alt ? { alt: l.alt } : {}), ...(err.requestId ? { requestId: String(err.requestId).slice(0, 64) } : {}) });
    }
    if (t.lifecycle) emitAgent(t, 'lifecycle', { phase: 'end' });
    log('byok-error', { chat: t.chatId, turn: t.wowKind, ...errorLogFields(err) });
    syncState();
  }

  // ---------------------------------------------------------------- the request
  // History rows still shaped like a key after redactKeys (a row kept before replies were redacted, with a
  // no-break space where its key's dash was: only KY-10's third look sees it) go, each with the other row
  // of its turn, so the roles still alternate and no key goes back to the model (code health, the old
  // audit's KA-02 follow-up a). The log says how many, never what.
  function keyFreePairs(rows, chatId) {
    const out = [];
    let dropped = 0;
    for (let i = 0; i < rows.length; i++) {
      const pair = rows[i].role === 'user' && rows[i + 1]?.role === 'assistant' ? [rows[i], rows[++i]] : [rows[i]];
      if (pair.some(r => typedLooksLikeKey(r.content))) dropped += pair.length;
      else out.push(...pair);
    }
    if (dropped) log('byok-key-dropped', { chat: chatId, where: 'history', n: dropped });
    return out;
  }
  // KY-10 (the old audit's KB-03): lines shaped like an API key (another addon's context line, a forged
  // record's note, a backup the player wrote into a memory file) never go; the rest does. The log says
  // how many, never what.
  function keyFree(list, where, chatId) {
    const out = list.filter(l => !typedLooksLikeKey(String(l)));
    if (out.length < list.length) log('byok-key-dropped', { chat: chatId, where, n: list.length - out.length });
    return out;
  }
  /** A memory digest without key-shaped lines (what a turn carries, and the app's memory page shows). */
  function keyFreeDigest(d, chatId = null) {
    if (!isObj(d)) return d;
    const out = { ...d };
    let n = 0;
    for (const k of ['character', 'recent', 'notes', 'quests']) {
      if (!Array.isArray(d[k])) continue;
      out[k] = d[k].filter(l => !typedLooksLikeKey(String(l)));
      n += d[k].length - out[k].length;
    }
    if (n) log('byok-key-dropped', { chat: chatId ?? undefined, where: 'memory', n });
    return out;
  }
  function build(t, p, withHistory) {
    const w = t.wow;
    const stateDoc = isObj(w.state) ? sanitizeState(w.state) : null; // RT-11: again, whatever the core did
    const game = {};
    if (w.useContext !== false && w.contextLines) {
      game.context = keyFree(Array.isArray(w.contextLines) ? w.contextLines : String(w.contextLines).split(/\r\n|\r|\n/), 'context', t.chatId);
    }
    if (t.wowKind === 'evt') {
      game.event = { kind: String(w.event?.kind ?? ''), args: sanitizeArgs(w.event?.args) };
      if (stateDoc) game.state = stateDoc;
    } else if (t.wowKind === 'recap') {
      if (stateDoc) game.recap = stateDoc;
    } else if (stateDoc) game.state = stateDoc;
    // The core's mark for a state older than the one the turn named (rawTurn): the count line says so.
    if (game.state && w.stale === true) game.stale = true;
    // Sourced facts for what the player typed (the brain): data, quoted, with their source.
    let found = 0;
    if (t.wowKind === 'msg') { const facts = brainFacts(t.typed, w.state); if (facts.length) game.facts = facts; found = facts.found || 0; }
    const notes = keyFree(Array.isArray(w.notes) ? w.notes.filter(x => typeof x === 'string' && x) : [], 'notes', t.chatId);
    if (notes.length) game.notes = notes;
    // The first meeting (onboarding spec §9.3, §9.6): Say Hi's "hi" before any first reply. The pack's
    // rule reads game.intro and game.locale; a greeting alone gets a short answer's output cap.
    const intro = t.wowKind === 'msg' && w.intro === true;
    if (intro) {
      game.intro = true;
      if (LOCALE_RE.test(String(w.loc ?? ''))) game.locale = w.loc;
    }
    let mem = null;
    const char = settings.memory ? charOf(stateDoc, w.contextLines) : null;
    // With the live quest log in the block, memory's older quest lines stay out: one list, the whole one.
    // Without it they're the only titles, for the quests the context's line says are in the log.
    const withList = Array.isArray(game.state?.quests);
    const live = withList ? null : liveQuests(w.contextLines);
    if (char) { try { mem = keyFreeDigest(memory.digest(char, { identity: settings.identity, quests: !withList, live }), t.chatId); } catch (e) { log('byok-memory-error', { error: short(e) }); } }
    // A row kept before replies were redacted goes out without its key, or not at all (keyFreePairs).
    const history = keyFreePairs((withHistory && settings.historyBudget > 0 ? transcripts.window(t.chatId, settings.historyBudget) : [])
      .map(m => ({ ...m, content: redactKeys(m.content) })), t.chatId);
    const perTurnOut = caps.config().perTurnOutput || MAX_TOKENS;
    // The first meeting's cap is the reply's (fix-102): a model that thinks gets its level's thinking
    // room on top of it (buildRequest, THINK_ROOM), so its thinking never eats the short answer.
    const introCap = intro && GREETING_RE.test(t.typed);
    // The short path (odd/tasks/nqa-fast-chat.md F3): a typed question the brain found facts for goes
    // with the compact pack (the answer starts about 2 s sooner). The first meeting, a message with
    // linked tooltips, and anything the brain has nothing for keep the full pack and the logbook.
    const fast = brainChat && found > 0 && !intro && !/Linked from the game/i.test(String(t.typed || ''));
    if (fast) log('byok-brain-chat', { fast: true, facts: found });
    const req = buildRequest({
      pack: fast ? chatPack() : pack, memory: fast ? null : mem, game, history, userText: t.wowKind === 'msg' ? t.typed : '',
      pseudonymizer, sendNames: settings.sendNames, identity: settings.identity,
      manifest: p.manifest, model: p.model, effort: t.effort, safetyId: safetyId(),
      maxTokens: Math.max(1, Math.min(fast ? FAST_MAX_TOKENS : MAX_TOKENS, perTurnOut, p.manifest.limits?.maxOutputTokens || MAX_TOKENS, introCap ? INTRO_MAX_TOKENS : MAX_TOKENS)),
    });
    if (p.manifest.custom !== true) return req;
    // Other: what its server said the model takes, and the room it needed to think and still answer.
    const l = learnedOf(p);
    const room = l.pace > 0 ? Math.min(l.room, Math.floor(l.pace * runMs / 1000 * PACE_SHARE)) : l.room;
    return { ...req, ...(l.options ? { serverOptions: l.options } : {}), ...(room > req.maxTokens ? { maxTokens: room } : {}) };
  }

  // The logbook for an event or a recap that carries a state (RT-5): deterministic, before any model.
  function runLogbook(t) {
    if ((t.wowKind !== 'evt' && t.wowKind !== 'recap') || !isObj(t.wow.state)) return;
    const r = applyLogbook(sanitizeState(t.wow.state), { dataDir });
    if (!r.ok) log('byok-logbook-skip', { chat: t.chatId, reason: String(r.error).slice(0, 120) });
    else if (r.changed?.length) log('byok-logbook', { chat: t.chatId, changed: r.changed, lines: r.log?.length || 0 });
  }

  // ---------------------------------------------------------------- a turn held for the network (§10)
  const held = new Map(); // chatId → the turn waiting for the network
  // An answer came from a provider: every held turn goes now.
  function networkBack() {
    for (const h of held.values()) h.wake?.();
  }
  /**
   * Hold a turn whose request never left (network_before_send) until the provider's host answers:
   * 'back' (send it now), 'expired' (10 minutes from the message: the Retry line) or 'aborted' (a
   * stop, a forget, the bridge stopping). Paused, it waits without probing.
   */
  async function holdForNetwork(t, p, err, signal) {
    const until = t.at + holdMs;
    if (clock() >= until) return 'expired';
    const l = lineFor(err, { final: false });
    emitAgent(t, 'item', { kind: 'tool', phase: 'start', name: 'held', title: lineText(l) });
    try { ledger.set(t.idem, 'queued', { reason: 'held' }); } catch { /* 'sending' stays: a restart reports it, never resends it */ }
    log('byok-held', { chat: t.chatId, ...errorLogFields(err), untilMs: until - clock() });
    held.set(t.chatId, t);
    let delay = holdProbe.first;
    try {
      for (;;) {
        const left = until - clock();
        if (left <= 0) return 'expired';
        const wake = new AbortController();
        let woke = false;
        t.wake = () => { woke = true; wake.abort(); };
        await sleep(Math.min(delay, left), AbortSignal.any([signal, wake.signal]));
        t.wake = null;
        if (stopped || signal.aborted) return 'aborted';
        if (paused) continue;
        if (woke) return 'back';
        const r = await p.provider.reach({ signal });
        if (stopped || signal.aborted) return 'aborted';
        if (r.ok) { networkBack(); return 'back'; }
        delay = Math.min(delay * 2, holdProbe.max);
      }
    } finally {
      t.wake = null;
      if (held.get(t.chatId) === t) held.delete(t.chatId);
    }
  }

  // ---------------------------------------------------------------- a turn
  async function execTurn(t, signal) {
    const base = current();
    // The chat's own model when it had one at send for this provider (/bones model), else the provider's.
    const p = viewFor(base, t.modelProvider === base.id ? t.model : null);
    t.p = p; // what the turn went to, whatever a model switch does to the settings meanwhile
    if (p !== base) t.ownLabel = p.modelName;
    // One wall-clock limit for the whole run (PV-7): attempts and retry waits. A turn held for the
    // network starts a fresh one when it goes (nothing had left).
    let deadline = deadlineAfter(runMs);
    let runFrom = clock(); // the run limit's start, for the time a retry has left (roomForRetry)
    let sig = AbortSignal.any([signal, deadline]);
    const abortedErr = () => makeError({ kind: 'interrupted', provider: p.id, aborted: true });
    const timeoutErr = () => makeError({ kind: 'timeout', provider: p.id, phase: 'run', afterMs: runMs, retryable: false });
    // What ends the turn now: a stop or a forget (the turn's own signal), else the run limit.
    const cut = () => (signal.aborted ? abortedErr() : deadline.aborted ? timeoutErr() : null);
    if (signal.aborted) return finishFailed(t, abortedErr());
    // A model switched at the check (PV-3): this chat hears it once, before the reply. It answers
    // no message (answers: 'none'): the turn it rides with still gets its own reply, so the addon
    // keeps that message pending and the core keeps the chat busy (final review L4-2).
    if (noticeLine) {
      const l = noticeLine;
      noticeLine = null;
      emit('chat', { chatId: t.chatId, runId: `notice:${t.runId}`, state: 'error', errorKind: 'model_not_found', errorMessage: lineText(l), action: l.action, answers: 'none' });
    }
    // Slowed (a rate limit whose reset is still ahead, US-3): a request now would be refused
    // (SY-05). A reset within SLOWED_WAIT_MAX_MS is waited out, as a retry would be; a later one (a
    // daily limit) ends the turn with the line that limit got, and nothing is sent or counted.
    const slowLeft = slowedUntil - clock();
    if (slowLeft > 0) {
      const by = slowedBy ?? { kind: 'rate_limited' };
      const err = makeError({ ...by, provider: p.id, retryable: false, code: 'slowed', ...(by.kind === 'rate_limited_daily' ? { resetAt: slowedUntil } : { retryAfterMs: slowLeft }) });
      if (by.kind === 'rate_limited_daily' || slowLeft > SLOWED_WAIT_MAX_MS) {
        log('byok-slowed', { chat: t.chatId, kind: by.kind, waitMs: slowLeft, sent: false });
        return finishFailed(t, err);
      }
      const l = lineFor(err, { final: false, retryInMs: slowLeft });
      // The line and its countdown, as a retry's: "Trying again in 18 seconds." (STYLE §8) [PUI-01]
      emitAgent(t, 'item', { kind: 'tool', phase: 'start', name: 'retry', title: lineText(l) });
      log('byok-slowed', { chat: t.chatId, kind: by.kind, waitMs: slowLeft, sent: true });
      await sleep(slowLeft, sig);
      if (stopped || signal.aborted) return finishFailed(t, abortedErr());
      if (deadline.aborted) return finishFailed(t, timeoutErr());
    }
    // Other: what its server says the model takes (Ollama's thinking controls), read once a session.
    if (p.manifest.custom === true && typeof p.provider.thinking === 'function' && learnedOf(p).options === undefined) {
      const o = await p.provider.thinking({ model: p.model, signal });
      if (o !== undefined) { learnedOf(p).options = o; log('byok-thinking', { provider: p.id, options: o }); }
      if (stopped || signal.aborted) return finishFailed(t, abortedErr());
    }
    // A server on this computer (Other at localhost) costs nothing: no reservation at the unknown-model ceiling.
    const price = p.free ? localPrice(p.id, p.model) : priceBook.priceFor(p.id, p.model, clock());
    let built;
    try {
      built = build(t, p, true);
      if (!caps.fitsTurn(built)) {
        built = build(t, p, false); // the per-turn ceiling: history goes first (§9.4)
        if (!caps.fitsTurn(built)) return finishFailed(t, bridgeError('context_too_long', { code: 'per_turn_ceiling' }));
      }
    } catch (e) {
      log('byok-build-failed', { chat: t.chatId, error: short(e) });
      return finishFailed(t, bridgeError('unknown', { code: 'build_failed' }));
    }
    try { runLogbook(t); } catch (e) { log('byok-logbook-error', { error: short(e) }); }

    let est;
    try { est = estimateTurn(built, price); } catch (e) { log('byok-estimate-failed', { error: short(e) }); return finishFailed(t, bridgeError('unknown', { code: 'estimate_failed' })); }
    // A cap the player set, against today's spend and this turn's estimate (§9.4).
    let no;
    try { no = caps.check(est, t.capKind); } catch (e) {
      log('byok-caps-error', { error: short(e) });
      return finishFailed(t, bridgeError('unknown', { code: 'cap_check_failed' }));
    }
    if (no) return finishFailed(t, bridgeError(no, { capEst: { estMicros: est.estMicros, free: est.free }, capKind: t.capKind }));
    t.checked = true; // from here what goes out is booked
    t.est = est.estMicros;
    t.lifecycle = true;
    emitAgent(t, 'lifecycle', { phase: 'start' });
    try {
      // On disk, fsynced, before the request (with the bridge's write queue, code health BR-04: the mark's
      // write is the worker's, and the turn waits for its answer).
      await ledger.set(t.idem, 'sending', { provider: p.id, model: p.model, estMicros: est.estMicros });
    } catch (e) {
      log('byok-ledger-error', { error: short(e) });
      return finishFailed(t, localWrite(e)); // never send what the ledger can't record
    }

    const spend = t.spend;
    const hooks = purpose => ({ onRequest: r => keepRequest(t.chatId, purpose, p, r), onStart: networkBack });
    let attempt = 0;
    let trimmed = false;
    let emptied = null; // an empty reply's finish ('length' | 'stop') once it was tried again
    let learnRoom = 0; // the room a thinking Other model got on its one more try: kept once it answers
    let pace = 0; // the last attempt's tokens a second from its first, where its usage counts them
    let result = null;
    for (;;) {
      const c = cut();
      if (c) return finishFailed(t, c); // stopped, or out of time, before this attempt left
      spend.inFlight = true;
      const sentAt = clock();
      const one = await streamOnce(p.provider, built, sig, p.id, { ...hooks('turn'), now: clock });
      const endAt = clock();
      pace = one.firstAt != null && endAt > one.firstAt && one.usage?.output > 0 ? one.usage.output * 1000 / (endAt - one.firstAt) : 0;
      addAttempt(spend, one, price);
      if (stopped) return finishFailed(t, abortedErr());
      noteRateLimit(one.rateLimit);
      let err = one.error;
      if (!err && (one.finish === 'refusal' || one.finish === 'content_filter')) err = makeError({ kind: 'content_blocked', provider: p.id, code: one.finish, requestId: one.requestId ?? undefined });
      if (!err && !one.text.trim()) err = makeError({ kind: 'empty_reply', provider: p.id, code: one.finish === 'length' ? 'length' : 'stop', requestId: one.requestId ?? undefined });
      if (!err) { result = one; break; }
      if (signal.aborted) return finishFailed(t, abortedErr());
      if (deadline.aborted) return finishFailed(t, timeoutErr());
      // Too long: trim the history and try once more (§10); it counts as this turn.
      if (err.kind === 'context_too_long' && err.reason !== 'num_ctx' && !trimmed && (built.meta?.historyMessages || 0) > 0) {
        trimmed = true;
        try { built = build(t, p, false); } catch { return finishFailed(t, err); }
        log('byok-trim', { chat: t.chatId });
        continue;
      }
      // No text: try once more (it counts as this turn, as the trim's try does). Finished with
      // nothing: as it was. Out of room (a thinking model that thought its whole ceiling away): at
      // the model's lowest thinking level with the same reply ceiling, or, where it can't go lower,
      // the same level with more room (High's at least for a model with no levels seen thinking, in
      // the time the run has left at this attempt's pace), after the player's spend cap is checked
      // against this turn's spend so far and the bigger request's estimate; never the same request
      // again. Empty again, no more room, or the cap says no: its own line.
      if (err.kind === 'empty_reply' && !emptied) {
        emptied = err.code;
        const from = { effort: built.effort ?? undefined, maxTokens: built.maxTokens, reasoned: one.reasoned };
        let how = 'same';
        if (err.code === 'length') {
          // Its pace: the tokens it wrote (its whole ceiling, unless its usage says) from its first one (a
          // cold model's load and the prompt's reading left out), and the time left to write in once a
          // retry has waited as long again for its first.
          const wrote = one.usage?.output > 0 ? one.usage.output : built.maxTokens;
          const firstAt = one.firstAt ?? sentAt;
          const leftMs = runMs - (clock() - runFrom) - (firstAt - sentAt);
          const next = roomForRetry(built, p.manifest, p.model, { reasoned: one.reasoned, perSecond: endAt > firstAt ? wrote * 1000 / (endAt - firstAt) : 0, leftMs });
          if (!next) {
            log('byok-empty-retry', { chat: t.chatId, finish: err.code, ...from, skipped: 'no_room', leftMs, requestId: err.requestId });
            return finishFailed(t, err);
          }
          if (next.how === 'room') {
            let no;
            try {
              const more = estimateTurn(next.req, price);
              no = more.free ? null : caps.check({ estMicros: spend.micros + more.estMicros }, t.capKind);
            } catch (e) { log('byok-caps-error', { error: short(e) }); no = 'cap_check_failed'; }
            if (no) {
              log('byok-empty-retry', { chat: t.chatId, finish: err.code, ...from, skipped: no, requestId: err.requestId });
              return finishFailed(t, err);
            }
          }
          how = next.how;
          built = next.req;
          if (how === 'room' && one.reasoned && p.manifest.custom === true) learnRoom = built.maxTokens;
        }
        log('byok-empty-retry', { chat: t.chatId, finish: err.code, how, ...from, retryEffort: built.effort ?? undefined, retryMaxTokens: built.maxTokens, requestId: err.requestId });
        continue;
      }
      // Nothing left the machine: hold the turn until the network is back (§10), then send it.
      if (err.kind === 'network_before_send' && !p.local) {
        const how = await holdForNetwork(t, p, err, signal);
        if (how === 'aborted') return finishFailed(t, abortedErr());
        if (how === 'expired') return finishFailed(t, err);
        try {
          await ledger.set(t.idem, 'sending', { provider: p.id, model: p.model, estMicros: est.estMicros });
        } catch (e) {
          log('byok-ledger-error', { error: short(e) });
          return finishFailed(t, localWrite(e));
        }
        deadline = deadlineAfter(runMs);
        runFrom = clock();
        sig = AbortSignal.any([signal, deadline]);
        log('byok-resend', { chat: t.chatId, heldMs: clock() - t.at });
        continue;
      }
      // A chat's own model the provider doesn't have: the chat goes back to the provider's model,
      // and the line says so (§10). The provider's own model isn't in question.
      if (err.kind === 'model_not_found' && p !== base) {
        if (dropOwnModel(t.chatId)) { log('byok-chat-model', { chat: t.chatId, provider: p.id, dropped: 'model_not_found' }); on.change({ push: true }); }
        return finishFailed(t, err, { model: p.modelName, fallbackModel: base.model ? base.modelName || base.model : null });
      }
      // A model gone mid-session: look at the list again, and say what it was switched to (§10).
      if (err.kind === 'model_not_found' && checks.models) {
        const sw = await checkModel({ reason: 'error' });
        if (signal.aborted) return finishFailed(t, abortedErr());
        if (sw?.switched) {
          noticeLine = null; // this line says it
          return finishFailed(t, err, { model: modelLabel(p.manifest, p.model), fallbackModel: modelLabel(p.manifest, sw.to) });
        }
      }
      const plan = retryPlan(err, attempt, { maxRetries: MAX_RETRIES, random });
      if (!plan.retry) return finishFailed(t, err);
      noteTrouble(err);
      // The line and its countdown, "Trying again in 18 seconds." (STYLE §8) [PUI-01]
      const l = lineFor(err, { final: false, retryInMs: plan.delayMs });
      emitAgent(t, 'item', { kind: 'tool', phase: 'start', name: 'retry', title: lineText(l) });
      log('byok-retry', { chat: t.chatId, attempt: attempt + 1, delayMs: plan.delayMs, ...errorLogFields(err) });
      await sleep(plan.delayMs, sig);
      if (stopped) return finishFailed(t, abortedErr());
      attempt += 1;
    }
    // A stop or a forget that came as the reply finished: the player asked for nothing more of it.
    if (signal.aborted) return finishFailed(t, abortedErr());
    // The room a thinking Other model needed to answer: its next turns start with it, at the pace it answered.
    if (p.manifest.custom === true) {
      const l = learnedOf(p);
      if (learnRoom > l.room) { l.room = learnRoom; log('byok-thinking-room', { provider: p.id, room: learnRoom }); }
      if (l.room && pace > 0) l.pace = pace;
    }

    // The reply: datamarks off, then the real names back. A map block the model got wrong isn't
    // repaired with a second paid call (systems plan D6): the core says "Couldn't draw the route".
    // A key the reply quotes reaches no slot, record or transcript (code health, the old audit's KA-02):
    // the prose shapes here, so its words stay words in game (follow-up b).
    const wire = redactKeysInProse(built.meta?.datamark ? stripDatamark(result.text) : result.text);
    const text = pseudonymizer.unmask(wire);

    // What the reply cost. With no usage from the provider, the turn counts at its estimate (never as free).
    const main = spendOf(spend, t.est);
    const micros = result.usage ? main.micros : Math.max(main.micros, spend.micros + t.est);
    const exact = main.exact && !!result.usage;
    const usage = { in: spend.in, out: spend.out, micros, model: p.model || '', exact };

    // Transcripts first: once the ledger says done, the reply must be readable from the transcript, and
    // its row names its turn and carries its cost, so outcomes() finds it, cost and all, even when a
    // crash comes before the ledger's 'done' lands (code health BR-22).
    const userT = nextT(t.chatId);
    const replyT = nextT(t.chatId);
    try {
      // What's kept, both rows: the strict shapes (a fragment in the player's own row KY-10 let through too).
      transcripts.append(t.chatId, { ...built.transcript, text: redactKeys(built.transcript.text), t: userT });
      const kept = replyTranscript(wire, pseudonymizer);
      transcripts.append(t.chatId, { ...kept, text: redactKeys(kept.text), t: replyT, run: t.idem, usage });
    } catch (e) { log('byok-transcript-error', { chat: t.chatId, error: short(e) }); }
    if (t.wowKind === 'msg') brainRemember(t.wow?.state, t.typed, redactKeys(String(wire ?? '')));

    t.booked = true;
    noteUsage(t, p, { micros, exact, inTokens: usage.in, outTokens: usage.out });
    // replyT and the cost (a ledger format addition, BR-22): where outcomes() finds the reply the core
    // may not have published (a crash between this and its publish), with what it cost.
    try {
      ledger.set(t.idem, 'done', { outMicros: micros, requestId: result.requestId ?? undefined, replyT, inTokens: usage.in, outTokens: usage.out, exact });
    } catch (e) { log('byok-ledger-error', { error: short(e) }); }
    trouble = null;
    lastError = null; // a reply went through: the desktop's card for the last failure goes (desktop UI critic D-01)
    emitChat(t, {
      state: 'final', stopReason: result.finish,
      message: { role: 'assistant', content: [{ type: 'text', text }], __nqa: { id: `byok:${t.chatId}:${replyT}`, seq: replyT } },
      usage,
    });
    t.answered = true; // the run is over: nothing after this may end it a second time
    emitAgent(t, 'lifecycle', { phase: 'end' });
    // usage.model above is the id asked for; an alias the provider named (a dated snapshot) is logged only.
    log('byok-turn', { chat: t.chatId, turn: t.wowKind, provider: p.id, model: p.model, served: result.served && result.served !== p.model ? result.served : undefined,
      own: p !== base || undefined, attempts: attempt + 1, trimmed: trimmed || undefined, emptied: emptied ?? undefined,
      in: usage.in, out: usage.out, micros, exact, chars: text.length, finish: result.finish,
      requestId: result.requestId ?? undefined, ms: clock() - t.at });
    syncState();
  }

  const turns = new Map(); // idem → turn, from send() until its run settles
  const active = new Map(); // chatId → the turn running now

  // Paused (the app's switch), or sending paused by the core's typed guard (holdRuns): nothing that
  // waits starts while either holds (code health BR-03: pause only set a flag, and every queued run
  // still ran and billed). A turn the run queue starts then waits here, before its run limit, the cap,
  // the ledger's 'sending' or any request, until both are over; a stop, a forget or the bridge's stop
  // ends the wait. A turn already sending finishes; the core's outbox keeps what it hasn't sent.
  let sendHeld = false;
  const holding = () => paused || sendHeld;
  const resumeWaiters = new Set();
  function untilResumed(signal) {
    return new Promise((resolve) => {
      if (!holding() || signal.aborted) { resolve(); return; }
      const done = () => { resumeWaiters.delete(done); signal.removeEventListener('abort', done); resolve(); };
      resumeWaiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  function wakeHeld() {
    if (!holding()) for (const w of [...resumeWaiters]) w();
  }

  async function runTurn(t, signal) {
    await new Promise(r => setImmediate(r)); // send's answer reaches the core before any event of its run
    if (stopped) return;
    if (holding()) {
      log('byok-turn-held', { chat: t.chatId, by: paused ? 'paused' : 'send_paused' });
      await untilResumed(signal);
      if (stopped) return;
    }
    active.set(t.chatId, t);
    try {
      await execTurn(t, signal);
    } catch (e) {
      // Anything that throws: what went out is still counted (finishFailed), and the player gets a line.
      try { log('byok-turn-crash', { chat: t.chatId, error: short(e) }); } catch { /* the log is what threw */ }
      if (!t.answered) finishFailed(t, bridgeError('unknown', { code: 'internal' }));
    } finally {
      if (active.get(t.chatId) === t) active.delete(t.chatId);
    }
  }

  // A turn dropped from the queue before it ran (/bones stop, or the chat forgotten).
  function dropped(t, e) {
    if (stopped) return; // a stop leaves it 'queued': the next start reports it
    if (e?.name !== 'AbortError') { log('byok-turn-crash', { chat: t.chatId, error: short(e) }); finishFailed(t, bridgeError('unknown', { code: 'internal' })); return; }
    try { ledger.set(t.idem, 'failed', { errorKind: 'interrupted', reason: 'aborted' }); } catch { /* final already */ }
    setImmediate(() => emitChat(t, { state: 'aborted', stopReason: 'aborted' }));
  }

  // ---------------------------------------------------------------- the core's calls (code health BR-22)
  function badRequest(what) {
    const e = new Error(`INVALID_REQUEST: ${what}`);
    e.code = 'INVALID_REQUEST';
    return e;
  }
  const isChat = chatId => typeof chatId === 'string' && CHAT_RE.test(chatId);

  /**
   * A turn, by chat id ({chatId, idem, turn, thinking}): synchronous through ledger.begin and the run
   * queue, never an await before queue.run, so a stop that comes right after it finds the turn on the
   * queue, which drops it unbilled. → {runId, status}.
   */
  function send({ chatId, idem, turn, thinking } = {}) {
    if (!isChat(chatId)) throw badRequest('chatId must be a chat id (c and 6 hex digits)');
    if (typeof idem !== 'string' || !idem || idem.length > 200) throw badRequest('idem (the turn\'s idempotency key) is required');
    const runId = idem;
    const seen = ledger.get(idem);
    if (seen) {
      if (seen.state === 'done') return { runId, status: 'ok' };
      if (seen.state === 'queued' || seen.state === 'sending') return { runId, status: 'in_flight' };
      return { runId, status: seen.state }; // failed or interrupted: answered once, never resent (DB20)
    }
    if (stopped) throw new Error('NOT_READY: the backend is stopped');
    const w = isObj(turn) ? turn : {};
    const wowKind = Object.hasOwn(TURN_KINDS, w.kind) ? w.kind : 'msg';
    const typed = wowKind === 'msg' ? String(w.typed ?? '') : '';
    const p = current();
    const own = ownModel(chatId); // the chat's own model as the message went (/bones model)
    const t = {
      idem, runId, chatId, wow: w, wowKind, capKind: TURN_KINDS[wowKind], typed,
      effort: EFFORTS.includes(thinking) ? thinking : settings.effort, at: clock(),
      model: own, modelProvider: own ? p.id : null,
      checked: false, booked: false, est: 0, spend: newSpend(), lifecycle: false,
    };
    // A ledger that can't be written: nothing is sent (it couldn't be kept to once), and the player
    // gets the line now rather than a message that waits forever. Sending it again is a new turn.
    try {
      ledger.begin(idem, { chatId, kind: t.capKind, provider: p.id, model: own ?? p.model });
    } catch (e) {
      const err = e?.code === 'LEDGER_WRITE_FAILED' ? localWrite(e) : bridgeError('unknown', { code: 'ledger_error' });
      log('byok-error', { chat: chatId, turn: wowKind, ...errorLogFields(err) });
      noteLastError(err);
      const l = lineFor(err);
      setImmediate(() => emitChat(t, { state: 'error', errorKind: err.kind, errorMessage: lineText(l), action: l.action }));
      return { runId, status: 'started' };
    }
    // KY-10: a key-shaped message is never sent or saved (the addon refuses it first).
    if (wowKind === 'msg' && typedLooksLikeKey(typed)) {
      try { ledger.set(idem, 'failed', { errorKind: 'refused' }); } catch { /* the entry is enough */ }
      log('byok-refused', { chat: chatId, reason: 'looks like an API key' });
      setImmediate(() => emitChat(t, { state: 'error', errorKind: 'refused', errorMessage: KEY_REFUSED, action: 'none' }));
      return { runId, status: 'started' };
    }
    turns.set(idem, t);
    queue.run(chatId, signal => runTurn(t, signal))
      .catch(e => dropped(t, e))
      .finally(() => { if (turns.get(idem) === t) turns.delete(idem); });
    return { runId, status: 'started' };
  }

  /** /bones stop: the chat's running turn stopped, its waiting ones dropped (they never ran: nothing billed). */
  function abort(chatId) {
    if (!isChat(chatId)) return { aborted: false };
    const r = queue.abort(chatId);
    return { aborted: r.aborted || r.dropped > 0 };
  }

  /** The player deleted the chat: its turns stop, and its transcript, its own model and its last request go. */
  function forget(chatId) {
    if (!isChat(chatId)) throw badRequest('chatId must be a chat id (c and 6 hex digits)');
    queue.abort(chatId);
    try { transcripts.forget(chatId); } catch (e) { log('byok-forget-error', { error: short(e) }); }
    lastTs.delete(chatId);
    if (side.chats[chatId]) { delete side.chats[chatId]; saveSide(); }
    dropRequests(chatId);
    log('byok-forget', { chat: chatId });
    return { ok: true };
  }

  // A turn's reply row in its chat's transcript: the row at the ledger's replyT when there is one (and,
  // when that row names a run, it's this one), else the reply row that names the run (one written just
  // before a crash that left the ledger 'sending'). Rows rise in time, and a run's reply comes after its
  // turn began (since: its ledger entry's time), so the chat's last OUTCOME_ROWS rows are read, and every
  // row only when all of those came after the turn began (or when neither time is known): an interrupted
  // turn in a long chat never reads the whole transcript at start.
  function replyRow(chatId, runId, { replyT = null, since = null } = {}) {
    const mine = r => r?.role === 'assistant' && (Number.isFinite(replyT) ? r.t === replyT && (r.run === undefined || r.run === runId) : r.run === runId);
    try {
      const tail = transcripts.rows(chatId, OUTCOME_ROWS);
      const hit = tail.find(mine);
      if (hit || tail.length < OUTCOME_ROWS) return hit ?? null;
      const from = Number.isFinite(replyT) ? replyT : Number.isFinite(since) && since > 0 ? since - ROW_SLACK_MS : null;
      if (from !== null && tail[0].t < from) return null; // the tail reaches back past where it would be
      return transcripts.rows(chatId, 0).find(mine) ?? null;
    } catch (e) { log('byok-outcome-read-failed', { chat: chatId, error: short(e) }); return null; }
  }
  // The reply as its final carried it: the row's text, its id and seq (the row's time).
  const replyMessage = (chatId, row) => ({ role: 'assistant', content: [{ type: 'text', text: row.text }], __nqa: { id: `byok:${chatId}:${row.t}`, seq: row.t } });

  /**
   * What became of turns the core sent: one answer per id (see the header). The core asks at its start
   * for the runs it had in flight, for a run it didn't start (a resend the ledger already had), and for
   * a run it has heard nothing of for the run limit. From the ledger and the transcripts; it changes
   * nothing, so asking twice answers the same.
   */
  // chats: {runId: chatId}, the core's word for each run's chat, read only for a run the ledger has no
  // entry for (a ledger that couldn't be read is kept aside): a reply its transcript names it by is found.
  function outcomes(ids, chats = null) {
    const out = [];
    for (const runId of Array.isArray(ids) ? ids : []) {
      if (typeof runId !== 'string' || !runId || runId.length > 200) continue;
      const hint = isObj(chats) && Object.hasOwn(chats, runId) && isChat(chats[runId]) ? chats[runId] : null;
      out.push(outcomeOf(runId, hint));
    }
    return out;
  }
  function outcomeOf(runId, hint = null) {
    const e = ledger.get(runId);
    const live = turns.has(runId);
    const done = (chatId, row, usage) => ({ runId, chatId, state: 'done', ...(row && chatId ? { message: replyMessage(chatId, row) } : {}), ...(usage ? { usage } : {}) });
    if (!e) {
      if (live) return { runId, state: 'running' };
      const row = hint ? replyRow(hint, runId) : null;
      return row ? done(hint, row, turnUsage(row.usage)) : { runId, state: 'unknown' };
    }
    const chatId = isChat(e.meta?.chatId) ? e.meta.chatId : hint;
    if (e.state === 'done') {
      const row = chatId ? replyRow(chatId, runId, { replyT: Number.isFinite(e.extra?.replyT) ? e.extra.replyT : null, since: e.createdAt }) : null;
      const x = e.extra ?? {};
      return done(chatId, row, turnUsage({ in: x.inTokens, out: x.outTokens, micros: x.outMicros, model: x.model ?? e.meta?.model, exact: x.exact }) ?? turnUsage(row?.usage));
    }
    if ((e.state === 'queued' || e.state === 'sending') && live) return { runId, chatId, state: 'running' };
    // Not running here, and the ledger never heard it end: its reply may still have been written.
    const written = chatId && e.state !== 'failed' ? replyRow(chatId, runId, { since: e.createdAt }) : null;
    if (written) return done(chatId, written, turnUsage(written.usage));
    // Left unanswered by an earlier process: 'sending' (now interrupted), or 'queued' (marked failed at start).
    if (e.state !== 'failed' || e.extra?.reason === 'restart') {
      const l = lineFor({ kind: 'interrupted', provider: settings.provider });
      return { runId, chatId, state: 'interrupted', errorKind: 'interrupted', errorMessage: lineText(l), action: 'send_again' };
    }
    return { runId, chatId, state: 'failed' };
  }

  // ---------------------------------------------------------------- what the slot and the app read
  // An optional, small list for the in-game picker. Custom services publish the IDs their own
  // /models endpoint returned; bundled providers use only the supported manifest entries.
  function modelChoices(p) {
    const entries = p.manifest.models?.list ?? [];
    const ids = [p.model, ...(p.manifest.models?.allowAny ? discoveredModels : entries.map(e => e.id))];
    const seen = new Set(), out = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !MODEL_ID_RE.test(id) || looksLikeKey(id) || seen.has(id)) continue;
      seen.add(id);
      const named = entries.find(e => e.id === id)?.label;
      const label = typeof named === 'string' && !looksLikeKey(named) ? named.replace(/[\x00-\x1f\x7f|]/g, '').slice(0, 60) : id;
      const item = { id, label };
      if (out.length >= 24 || Buffer.byteLength(JSON.stringify([...out, item])) > 2048) break;
      out.push(item);
    }
    return out;
  }
  function providerView() {
    const p = current();
    const effort = (() => { try { return resolveEffort(settings.effort, p.manifest, p.model); } catch { return null; } })();
    const supported = modelHasEffort(p.manifest, p.model) !== false;
    const levels = supported ? effortLevels(p.manifest, p.model) : [];
    return {
      id: p.id, name: p.name, model: p.model || '', modelName: p.modelName || p.model || '',
      models: modelChoices(p),
      // effort: the level the next turn goes at (the player's, as the model's nearest level); efforts:
      // the model's levels, cheapest first, space-separated (chatSlot's).
      effort: effort ?? undefined, effortSupported: supported, ...(levels.length ? { efforts: levels.join(' ') } : {}),
      auth: p.local ? 'local' : settings.auth, keyState: keyState === 'missing' ? 'missing' : keyState,
      privacy: p.manifest.privacy?.class ?? 'cloud', product: PRODUCT, companion: settings.persona,
    };
  }
  // Is the player at their own daily spend cap now ('cap_spend', or null)? Only with a cap they set:
  // today's spend used up, or the last refusal today would still be refused (a refusal only another
  // cap raised or cleared ends it at once).
  function capReason() {
    const s = caps.snapshot();
    if (!Number.isInteger(s.capMicros)) return null; // no cap set: the public build has none of its own
    const free = current().free;
    if (s.held && !free) return s.held; // 'load_error': today's spend couldn't be read, not spent (BR-09)
    if (!free && s.spentMicros >= s.capMicros) return 'cap_spend';
    if (!capHit || capHit.day !== s.day) return null;
    if (!capHit.est) return capHit.reason; // no estimate kept: say what the refusal said
    try {
      return caps.check(capHit.est, capHit.kind) === 'cap_spend' ? 'cap_spend' : null;
    } catch { return null; }
  }
  function usageView() {
    const s = caps.snapshot();
    const free = current().free;
    let needs = null;
    if (keyState === 'invalid' || keyState === 'expired') needs = 'key_invalid';
    else if (trouble === 'out_of_credit') needs = 'out_of_credit';
    else if (capReason()) needs = 'cap';
    else if (slowedUntil > clock()) needs = 'slowed';
    else if (!free && Number.isInteger(s.capMicros) && s.capMicros > 0 && s.spentMicros >= 0.8 * s.capMicros) needs = 'near_cap';
    return { ...s, needs: needs ?? undefined };
  }
  function rtView() {
    const t = clock();
    if (st.state === 'paused') return { state: 'paused' };
    if (st.state === 'no_key') return { state: 'no_key', reason: st.reason || undefined };
    if (st.state === 'key_invalid') return { state: 'key_invalid', reason: st.reason || undefined };
    if (slowedUntil > t) return { state: 'slowed', retryIn: Math.ceil((slowedUntil - t) / 1000) };
    if (trouble === 'out_of_credit') return { state: 'out_of_credit' };
    const cap = capReason();
    if (cap) return { state: 'cap', reason: cap };
    if (trouble === 'provider_down') return { state: 'provider_down' };
    if (trouble === 'local_down') return { state: 'local_down' };
    return { state: 'ready' };
  }
  // The slot's rt also carries its words (systems plan Batch 3b, D5's one vocabulary; the one addon
  // renders them): line (status-view.mjs STATE_WORDS, the app's words; straight apostrophes in game),
  // tone, the action the addon offers ('desktop' where only the player can fix it, there) and alt
  // 'pick_provider' beside out of credit and an AI not answering (D7). Today's addon reads state,
  // reason and retryIn, as before; status().rt stays the bare state.
  function rtSlot() {
    const rt = rtView();
    // A cap held because today's spend couldn't be read (BR-09) is the app's tray word, never "reached" (UX-W02).
    const line = rt.state === 'cap' && rt.reason === 'load_error' ? SPEND_UNKNOWN_WORDS : STATE_WORDS[rt.state];
    return {
      ...rt,
      ...(line ? { line: line.replace(/\u2019/g, "'"), tone: STATE_TONE[rt.state] } : {}),
      action: NEEDS_PLAYER.includes(rt.state) ? 'desktop' : 'none',
      ...(rt.state === 'out_of_credit' || rt.state === 'provider_down' ? { alt: 'pick_provider' } : {}),
    };
  }
  // Each part on its own: one that throws (a provider no longer in the manifests: current() throws)
  // is left out and logged, and the caps stay, so the slot still reads as the public build's.
  function slotExtras() {
    const part = (name, view) => {
      try { return view(); } catch (e) { log('byok-slot-error', { part: name, error: short(e) }); return undefined; }
    };
    return { bridge: { caps: [...SLOT_CAPS], provider: part('provider', providerView), usage: part('usage', usageView) }, rt: part('rt', rtSlot) };
  }
  function status() {
    let provider = null;
    let usage = null;
    try { provider = providerView(); usage = usageView(); } catch (e) { log('byok-status-error', { error: short(e) }); }
    return {
      kind: KIND, state: st.state, since: st.since, reason: st.reason, rt: rtView(), provider, usage, runs: queue.stats(), caps: caps.config(), lastError,
      notice: notice ? { ...notice } : null, modelCheck: modelCheck ? { ...modelCheck } : null,
      held: [...held.values()].map(h => ({ chatId: h.chatId, until: h.at + holdMs })),
    };
  }
  // The app's diagnostics bundle (SL-7): states, counts and codes; never text, keys or idempotency keys.
  function diagnostics() {
    const counts = {};
    for (const e of ledger.list()) counts[e.state] = (counts[e.state] || 0) + 1;
    const recent = ledger.list().sort((a, b) => a.updatedAt - b.updatedAt).slice(-20).map(e => ({ state: e.state, meta: e.meta, extra: e.extra, at: e.updatedAt }));
    const d = {
      at: new Date(clock()).toISOString(), kind: KIND, status: status(), usage: caps.details(),
      ledger: { counts, recent }, transcripts: { chats: safe(() => transcripts.chats().length) ?? 0 },
      settings: { provider: settings.provider, model: settings.model, effort: settings.effort, auth: settings.auth, persona: settings.persona,
        identity: settings.identity, otherNames: settings.sendNames, memory: settings.memory, historyBudget: settings.historyBudget },
    };
    return JSON.parse(redact(JSON.stringify(d)));
  }

  // ---------------------------------------------------------------- lifecycle
  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    let left = [];
    try { left = ledger.interruptedAtStartup(); } catch (e) { log('byok-ledger-error', { error: short(e) }); }
    const pruned = pruneTranscripts('start'); // BR-20: beside the key check, done before ready
    // Rows age past the retention while the app runs (a login item runs for weeks): pruned daily too.
    pruneTimer = setInterval(() => pruneTranscripts('timer'), pruneEveryMs);
    pruneTimer.unref?.();
    try { caps.startSession(); } catch { /* totals only */ }
    await checkKey();
    await pruned;
    if (stopped) return;
    syncState();
    // What an earlier process left, settled before the core hears ready, so outcomes() answers for it.
    for (const e of left) settleLeft(e);
    if (left.length) log('byok-interrupted', { count: left.length });
    on.ready();
    helloSent = true;
    // The model check (PV-3), which holds no turn.
    checkModel({ reason: 'start' });
  }

  // A turn an earlier process left (the ledger's interruptedAtStartup): one it left 'queued' never went,
  // and is marked failed; one it left 'sending' may have been billed, so it's booked at its estimate,
  // once (DB20), unless its reply was written (booked with it then). Never resent. The core says what
  // became of it, through outcomes().
  function settleLeft(e) {
    if (e.neverSent) { try { ledger.set(e.key, 'failed', { errorKind: 'interrupted', reason: 'restart' }); } catch { /* final */ } return; }
    const chatId = isChat(e.meta?.chatId) ? e.meta.chatId : null;
    if (chatId && replyRow(chatId, e.key, { since: e.createdAt })) return;
    const est = Number.isFinite(e.extra?.estMicros) ? e.extra.estMicros : Number.isFinite(e.meta?.estMicros) ? e.meta.estMicros : 0;
    try {
      caps.book({ chatId: chatId ?? undefined, provider: e.extra?.provider ?? e.meta?.provider, model: e.extra?.model ?? e.meta?.model ?? '',
        micros: Math.max(0, est), exact: false, auto: e.meta?.kind === 'auto', error: 'interrupted' });
    } catch (err) { log('byok-usage-history-error', { error: short(err) }); }
  }

  async function stop() {
    if (stopped) return;
    stopped = true; // no more writes or events: a run cut here stays 'sending', and the next start settles it
    clearInterval(pruneTimer);
    pruneTimer = null;
    queue.abortAll();
    const until = Date.now() + STOP_WAIT_MS;
    while (queue.stats().running > 0 && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  }

  return {
    kind: KIND,
    get displayName() { try { return current().name; } catch { return 'NeverQuestAlone'; } },
    /** The companion's name: the persona the player gave Bones in the app. */
    get persona() { return settings.persona; },
    start,
    stop,
    send,
    abort,
    forget,
    /** /bones model (UX-6): the chat's own model from its next turn, or the provider's again (null, 'default'). */
    setChatModel,
    outcomes,
    slotExtras,
    chatSlot,
    status,
    diagnostics,
    /** Look at the key store again (after a key was set, replaced or deleted); keyChanged clears a rejected key. */
    async refresh({ keyChanged = false } = {}) {
      if (keyChanged) { keyState = 'ok'; keyReason = null; }
      await checkKey();
      syncState();
      if (keyChanged) providerChanged({ keyChanged: true });
      return status();
    },
    /** Change settings (provider, model, effort, persona, caps, privacy, …); returns the settings in force. */
    async setConfig(partial = {}) {
      const before = settings;
      const merged = { ...before, ...(isObj(partial) ? partial : {}) };
      const next = settingsOf({
        provider: merged.provider, model: merged.model, custom: merged.custom, effort: merged.effort, auth: merged.auth, persona: { name: merged.persona?.name ?? merged.persona },
        caps: { ...before.caps, ...(isObj(partial.caps) ? partial.caps : {}) },
        privacy: { identity: partial.privacy?.identity ?? before.identity, otherNames: partial.privacy?.otherNames ?? before.sendNames },
        memory: merged.memory,
        history: { budget: partial.history?.budget ?? before.historyBudget }, requestOptions: merged.requestOptions, safetyId: merged.safetyId,
        transcripts: { retentionDays: partial.transcripts?.retentionDays ?? before.retentionDays },
      });
      const newProvider = next.provider !== before.provider || next.model !== before.model || next.auth !== before.auth || JSON.stringify(next.requestOptions) !== JSON.stringify(before.requestOptions)
        || JSON.stringify(next.custom) !== JSON.stringify(before.custom);
      if (newProvider) {
        prov = null;
        keyState = 'ok';
        trouble = null;
        lastError = null;
        // A rate limit was the old AI's (SY-17): Pick Another AI must reach the new one now, not at
        // the old one's reset. If the new one is limited too, its own 429 slows it again.
        slowedUntil = 0;
        slowedBy = null;
      }
      // Another provider: the chats' own models were its ids, so every chat goes back to the new one's.
      if (next.provider !== before.provider || (next.provider === 'custom' && next.custom?.baseUrl !== before.custom?.baseUrl)) {
        let n = 0;
        for (const id of Object.keys(side.chats)) if (dropOwnModel(id)) n += 1;
        if (n) log('byok-chat-model', { dropped: 'provider_changed', chats: n });
      }
      // A provider or model the player picked ends a notice about the one it replaced.
      if (isObj(partial) && (Object.hasOwn(partial, 'model') || Object.hasOwn(partial, 'provider'))) { notice = null; noticeLine = null; }
      if (next.persona !== before.persona) pack = loadPack({ persona: { name: next.persona } });
      if (isObj(partial.caps)) {
        caps.setConfig(partial.caps);
        // The player set their cap in the app (setCaps), where the status said why it was held: a usage
        // history that couldn't be read is acknowledged, and today's spend counts from here (code health BR-09).
        if (caps.acknowledgeLoadError()) log('byok-usage-acknowledged', {});
        capHit = null;
      }
      settings = next;
      if (next.retentionDays !== before.retentionDays) await pruneTranscripts('setting');
      current();
      await checkKey();
      syncState();
      if (newProvider) providerChanged();
      // What the slot shows may have changed (the provider, model, effort, caps; and boot's privacy
      // wrapper reads the companion and echo switches then): the core publishes again and rings the
      // push doorbell, so the addon reads it now, not at the player's next message (C3 review).
      on.change({ push: true });
      return { ...settings };
    },
    /** Pause or resume (the app's switch): unsent turns wait in the core's outbox, queued ones here (BR-03). */
    pause(onOff = true) { paused = !!onOff; syncState(); wakeHeld(); return st.state; },
    /**
     * The core's typed guard paused sending (true) or the player pressed Resume sending (false): queued
     * turns wait meanwhile, as they do while paused (code health BR-03). Returns whether it holds.
     */
    holdRuns(onOff = true) {
      if (sendHeld !== !!onOff) log('byok-send-held', { held: !!onOff });
      sendHeld = !!onOff;
      wakeHeld();
      return sendHeld;
    },
    /**
     * Forget the last failure: the app's key test went through for the provider in use, so what the
     * player fixed at the provider (a spend limit, a region, a blocked connection) is fixed (D-32).
     */
    clearLastError() {
      if (!lastError) return false;
      lastError = null;
      on.change();
      return true;
    },
    /**
     * The app's key test (or a local server's check) passed for the provider in use (D-38): what the
     * player fixed (credit added, the provider or the local app back) is fixed, so the trouble a
     * failed turn left (out_of_credit, provider_down, local_down) goes with the last failure, as a
     * good reply would clear it. True when something changed.
     */
    clearAfterTest() {
      if (!trouble && !lastError) return false;
      trouble = null;
      lastError = null;
      on.change();
      return true;
    },
    /** A new random safety id for providers that take one (§7.2, §13.1). */
    regenerateSafetyId() {
      side.safetyId = crypto.randomUUID();
      saveSide();
      // A safety id the config pinned would keep winning over the new one: this one is used from now.
      if (settings.safetyId) settings = { ...settings, safetyId: null };
      log('byok-safety-id', { regenerated: true });
      return true;
    },
    get caps() { return caps; },
    get ledger() { return ledger; },
    get transcripts() { return transcriptsApi; },

    /**
     * The exact request a chat's last turn sent (KY-8, PR-3), or the most recent across chats with no
     * chatId: {chatId, at, purpose: 'turn', provider, model, method, url, headers, body}, or null. In memory
     * only; the auth header is redacted (`sk-ant-…A1b2 (redacted)`).
     */
    lastRequest(chatId) {
      const v = chatId === undefined || chatId === null ? lastRequestAny : lastRequests.get(chatId) ?? null;
      return v ? structuredClone(v) : null;
    },
    /**
     * The app's usage page (§9.2): {days: [{day, micros, turns, auto, byProvider: {<id>: {micros, turns, auto}}}]
     * (every day of the window, oldest first), recent: [{at, chatId, provider, model, in, out, micros,
     * exact, auto?, error?}] (the last 50, newest first)}.
     */
    usageHistory({ days = 30 } = {}) { return usageHist.view({ days }); },
    /** Run the model check now (PV-3): {ok, switched?, from?, to?, retired?} or null. */
    checkModel: () => checkModel({ reason: 'app' }),
    /**
     * One character's memory (§6.2, read-only): {char: {name, realm}, key, dir, digest, text, files:
     * [{name, bytes, modifiedAt}]}; digest is what a turn would carry (identity setting applied), text
     * the same as lines. With no character: {characters: ['Name-Realm', …]}.
     */
    memory(char) {
      if (char === undefined || char === null) {
        try {
          const root = path.join(dataDir, MEMORY_DIR);
          return { characters: fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() };
        } catch (e) { if (e.code === 'ENOENT') return { characters: [] }; throw e; }
      }
      const c = charArg(char);
      if (!c) return { ok: false, error: 'no character' };
      const dir = memory.dir(c);
      const files = [];
      for (const name of Object.values(MEMORY_FILES)) {
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile()) files.push({ name, bytes: st.size, modifiedAt: Math.floor(st.mtimeMs) });
        } catch { /* not written yet */ }
      }
      let digest = null;
      try { digest = keyFreeDigest(memory.digest(c, { identity: settings.identity })); } catch (e) { log('byok-memory-error', { error: short(e) }); }
      return { ok: true, char: c, key: charKey(c), dir, digest, text: digestText(digest), files };
    },
    /** Delete one character's memory folder (the app's "delete"): {ok, removed}. */
    forgetMemory(char) {
      const c = charArg(char);
      if (!c) return { ok: false, error: 'no character' };
      const removed = memory.forget(c);
      log('byok-memory-forget', { removed });
      return { ok: true, removed };
    },
    /** Delete every character's memory: {ok, removed: folders}. */
    forgetAllMemory() {
      const removed = memory.forgetAll();
      log('byok-memory-forget', { all: true, removed });
      return { ok: true, removed };
    },
  };
}
