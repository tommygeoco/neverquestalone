// One provider request from the pack, memory, game data, history and the player's text
// (public BYOK PRD §5.2 step 5, §6.2, §6.4, §7.4, §7.5, §12.3 TH5, §13.1; RT-2, RT-11, RT-12; BUILD-PLAN "runtime").
//
// req = { model, system: [{text: pack, cache: true}], messages, maxTokens, effort, safetyId, meta, transcript }
//   system     the prompt pack, the cached prefix
//   messages   the chat's windowed history (whole exchanges, oldest first), then one user turn:
//                <game_data id="<nonce>">
//                {"source":"game","memory":{…},"game":{…}}      one line of JSON
//                </game_data id="<nonce>">
//
//                <the player's text, or the fixed event line>
//              content is that text; parts splits it ({type:'data'} then {type:'text'}) for an
//              adapter that sends third-party content as its own block. Only {role, content} (and
//              the new turn's parts) are in messages.
//   maxTokens  the reply's ceiling, 1,200 by default (§7.5), plus the thinking room of the turn's
//              level (THINK_ROOM, providers/util.mjs: every AI here counts thinking as output inside
//              that ceiling), or of a model that always thinks (its list entry's thinkRoom); never
//              past the model's own output ceiling (its list entry's outputTokens, SY-102-6)
//   replyTokens the reply's own ceiling, the part the per-turn ceiling (caps.mjs) holds
//   effort     'low' by default (DB22); one of the thinking levels (EFFORTS: off, minimal, low,
//              medium, high, xhigh, max) or null; the model's nearest level when it hasn't the one
//              asked for; null when the manifest says the model has no control (§7.4)
//   meta       what the app's "Last request" view and the log want: pack version, nonce, sizes
//   transcript the row to append to the chat's transcript for this turn (history.mjs): the real
//              text (the player's typed text or the event line, never the data block) and the
//              other players' names in it. It's local: never sent, never logged.
// After the reply, replyTranscript(reply, pseudonymizer) gives the assistant row the same way.
//
// Game data is data (TH5): every game string is sanitized (sanitize.mjs), the block is JSON on one
// line with `<`, `>` and the line separators escaped, and its closing line carries a random id, so
// no game text can end the block or start a line of its own. The block is capped (10,000 characters
// encoded by default): linked tooltips, then the quests' objective texts, then memory, then the
// state's lists (the chains to start among them), where each quest's chain leads, the rest of the
// quests' detail and the context lines are cut first, and a note in
// game.notes says what was left out. Every quest in the log stays (PROTOCOL §2.6): its id, title and
// whether it's ready to turn in are never cut, and the first note says how many there are
// (questLogLine), so the model never takes the list for a cut one. For a local model (manifest.local)
// game text is also datamarked: every space in its strings becomes "ˆ" and the block says so
// ("datamark"), which the pack explains (spotlighting, [S155]).
// Other players' names from game data are pseudonymized (RT-12) in the block, the player's text and
// the history, unless the player opted in; the character's own name, realm and guild become "your
// character", "your realm" and "your guild" unless the player opted in to sending them (§13.1).
import crypto from 'node:crypto';
import { eventSummary, questLogLine } from '../../app/companion.mjs';
import { sanitizeState, sanitizeLines, sanitizeTyped, sanitizeArgs, sanitizeGameString, encodeData } from './sanitize.mjs';
import { namesFromMessage, namesFromLinked, replaceWords, wordsRegex, normalizeName, LINKED_MARK, DATAMARK } from './pseudonym.mjs';
import { estimateTokens } from './history.mjs';
import { EFFORT_LEVELS, THINK_ROOM, effortLevels, nearestEffort, thinkRoom, outputCeiling, START_EFFORT } from '../providers/util.mjs';

export const MAX_TOKENS = 1200;
export const DEFAULT_EFFORT = START_EFFORT;
/** The thinking levels, cheapest first (providers/util.mjs EFFORT_LEVELS). */
export const EFFORTS = EFFORT_LEVELS;
export { THINK_ROOM };
export const DATA_MAX_CHARS = 10000;
export const TAG = 'game_data';
/** The addon's "about my target" line (Commands.lua QuickAsk): the target's name, then its description when there is one. */
export const TARGET_ASK_RE = /What do you know about my target: (.+?)(?: \([^()]*\))?\?/;
const EVENT_KINDS = new Set(['level_up', 'route_done', 'route_stale', 'zone_first']);
const LOCALE_RE = /^[a-z]{2}[A-Z]{2}$/; // a client locale as GetLocale() names it: deDE

export { estimateTokens, encodeData, LINKED_MARK, DATAMARK };

/**
 * A message as the addon sends it → { typed, linked }: the text the player typed (links shown as
 * [Name]) and the "Linked from the game" block's tooltips, grouped per link:
 * [{ head: "[Fine Longsword] item 2140 (Uncommon)", lines: ["Main Hand Sword", …] }].
 */
export function splitLinked(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const at = s.indexOf(LINKED_MARK);
  if (at < 0) return { typed: s, linked: [] };
  const linked = [];
  for (const raw of s.slice(at + LINKED_MARK.length).split('\n')) {
    if (!raw.trim()) continue;
    const indented = /^\s/.test(raw);
    const line = sanitizeGameString(raw, 200);
    if (!line) continue;
    if (!indented || !linked.length) {
      if (linked.length >= 8) break;
      linked.push({ head: line, lines: [] });
    } else if (linked[linked.length - 1].lines.length < 30) linked[linked.length - 1].lines.push(line);
  }
  return { typed: s.slice(0, at), linked };
}

/** The fixed line of an event turn, or null for an unknown kind: never game text (the summary takes numbers only). */
export function eventLine(event) {
  const kind = event?.kind;
  if (kind === 'recap') return '[NeverQuestAlone event] Session recap. Sent by the app after the game closed, not typed by the player.';
  if (!EVENT_KINDS.has(kind)) return null;
  return `[NeverQuestAlone event] ${eventSummary(kind, event?.args || event || {})}. Sent by the addon, not typed by the player.`;
}

// Apply fn to every string in a JSON value.
function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map(x => mapStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

const isEmpty = v => v === undefined || v === null || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** The game data block for a content string, parsed back: { id, data } or null (tests, the app's view). */
export function readDataBlock(content) {
  const m = String(content ?? '').match(/^<game_data id="([0-9a-f]+)">\n(.*)\n<\/game_data id="\1">(?:\n|$)/);
  if (!m) return null;
  try { return { id: m[1], data: JSON.parse(m[2]) }; } catch { return null; }
}

/** A reply from a datamarked turn with any copied marks turned back into spaces. */
export const stripDatamark = text => String(text ?? '').split(DATAMARK).join(' ');

/**
 * Does the manifest give this model an effort control (§7.4)? The manifest's effort map is keyed by
 * model id or id prefix, the longest match winning, "*" the fallback (as providers/util.mjs reads it).
 * Undefined when there's no manifest to ask.
 */
export function modelHasEffort(manifest, model) {
  if (!isObj(manifest)) return undefined;
  const listed = Array.isArray(manifest.models?.list) ? manifest.models.list.find(m => m?.id === model) : null;
  if (listed && typeof listed.effort === 'boolean') return listed.effort;
  return effortLevels(manifest, model).length > 0;
}

/**
 * The effort to send: checked, 'low' when unset, null for a model the manifest says has no control,
 * and the model's nearest level (providers/util.mjs nearestEffort) when it hasn't the one asked for.
 */
export function resolveEffort(effort, manifest, model) {
  const e = effort === undefined ? DEFAULT_EFFORT : effort;
  if (e !== null && !EFFORTS.includes(e)) throw new Error(`effort must be one of ${EFFORTS.join(', ')} or null, not ${JSON.stringify(String(effort)).slice(0, 20)}`);
  if (modelHasEffort(manifest, model) === false) return null;
  if (e === null || !isObj(manifest)) return e;
  const levels = effortLevels(manifest, model);
  return levels.length ? nearestEffort(levels, e) : e;
}

// thinkRoom (providers/util.mjs): the output room a turn thinks in on top of its reply's ceiling.
export { thinkRoom };

/** The character's own name, realm and guild, from what the caller knows and the game data. */
function selfOf(self, game) {
  const st = isObj(game?.state) ? game.state : {};
  const rc = isObj(game?.recap) ? game.recap : {};
  const ch = st.char || rc.char || {};
  const ctx = Array.isArray(game?.context) ? game.context.join('\n') : String(game?.context ?? '');
  return {
    name: self?.name ?? ch.name ?? (ctx.match(/^Character: (.+?)(?: on [^,]+)?(?:,|$)/m) || [])[1] ?? null,
    realm: self?.realm ?? ch.realm ?? (ctx.match(/^Character: .+? on ([^,]+)/m) || [])[1] ?? null,
    guild: self?.guild ?? (ctx.match(/guild <([^>]*)>/) || [])[1] ?? null,
  };
}

// History as the provider wants it: {role, content, names} strings, starting with the player,
// alternating, ending with a reply (a trailing unanswered turn is dropped; neighbours with one role
// are joined, their names too).
function normalizeHistory(history) {
  const out = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : typeof m.text === 'string' ? m.text : null;
    if (!content || !content.trim()) continue;
    if (!out.length && m.role !== 'user') continue;
    const names = Array.isArray(m.names) ? m.names.filter(n => typeof n === 'string') : [];
    const last = out[out.length - 1];
    if (last && last.role === m.role) { last.content += `\n\n${content}`; last.names.push(...names); } else out.push({ role: m.role, content, names });
  }
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

/**
 * The count line for a state's quest log (questLogLine): how many quests against the game's cap, and
 * that every one is listed, or how many the game listed with no id yet and that they're still in the log; stale: the state is
 * older than the one the turn named (STALE_NOTE). null for a state with no quest log.
 */
export function questNote(state, { stale = false } = {}) {
  if (!isObj(state) || (!Array.isArray(state.quests) && !Number.isInteger(state.questCount))) return null;
  return questLogLine(state, { stale });
}

// No state's quest list, only the context's Quest log line: ids only. Quest titles come only with the
// state, which a turn that names none (an older addon's with the companion switch off, say) doesn't
// have, so a quest the player names by title can't be matched to an id.
export const IDS_ONLY_NOTE = 'Quest log: ids only in this game data (the context\'s Quest log line): quest names come only with the game state, which this turn doesn\'t have. A quest the player names by title may be any of them: never say it isn\'t in their log (memory\'s quest notes, when there, have older titles).';

// Said after the count when the state has quest chains (PROTOCOL §2.6): what a quest's chain and the
// chains to start mean, and how to use them, in the app's own words. Only on turns that have them, so the
// prompt pack, the cached prefix every turn pays for, stays as it is.
export const CHAIN_NOTE = 'Quest chains from classic quest data, for this character: a quest\'s "chain" (and each of "chainStarts", first steps near their level) has "step" of "of", "to" ("kind": dungeon, raid or reward; a reward\'s "item" (one the class can equip), "quality" and "choice" when it\'s one of that many picks the class could take) and the "next" quest. Rank a chain step higher, even a minor-looking one, and say where it leads. Trust these over memory; never guess a missing step or count.';
const hasChains = st => isObj(st) && ((Array.isArray(st.chainStarts) && st.chainStarts.length > 0)
  || (Array.isArray(st.quests) && st.quests.some(q => isObj(q) && isObj(q.chain))));

// Quest titles are the game's, never the player's: the character's own name, redacted everywhere else,
// stays in them (a character named Fire keeps "Call of Fire"). src: the state before.
function keepQuestTitles(data, src) {
  const st = data?.state;
  if (!isObj(st) || !isObj(src)) return data;
  const back = (list, ok) => (Array.isArray(list) && Array.isArray(src[ok.key])
    ? list.map((x, i) => (isObj(x) && isObj(src[ok.key][i]) && ok.test(src[ok.key][i]) && typeof src[ok.key][i].title === 'string' ? { ...x, title: src[ok.key][i].title } : x))
    : list);
  const quests = back(st.quests, { key: 'quests', test: () => true });
  const pending = back(st.pending, { key: 'pending', test: p => p.kind === 'quest_done' });
  return { ...data, state: { ...st, ...(quests ? { quests } : {}), ...(pending ? { pending } : {}) } };
}

// What goes first when the block is too big, in order: [label, next], next(d, at) giving the one piece
// to cut now, { cut, box? }, or null when there's nothing left. Linked tooltips first (the player can
// link again), then the quests' objective texts, then memory (background), then the state's long
// lists, the rest of the quests' detail, the context lines, the recap and the rest of the state. No
// step takes a quest (its id, title, cut and complete stay), the context's Quest log line or the quest
// note: past them the block goes over the cap instead. box (code health BR-14): the object or array
// the cut changes in place, which stays where it is, so the block's size changes by exactly its own
// (encodeData is JSON, and its escapes are character for character); a cut without one (a key
// deleted, or the notes the size line joins) has the block measured whole again. at: the step's own
// place, kept from one cut to the next within one fit.
const QUEST_LINE = new RegExp(`^Quest[ ${DATAMARK}]log\\b`); // datamarked or not
const QUEST_KEEP = new Set(['id', 'title', 'cut', 'complete']);
const STATE_KEEP = new Set(['questCount', 'questMax', 'questUnread', 'quests']);
// The last item of a list.
const popNext = a => (Array.isArray(a) && a.length ? { box: a, cut: () => a.pop() } : null);

/**
 * A typed turn's state while the app's companion switch is off (PRIVACY.md, audit CV-01, QL-F-14): the
 * game information alone, as the addon sends it then (Companion.lua P.ListOnly), whatever an addon
 * sent or the core kept from while it was on: the character, the place and the quest log, every quest
 * with its id, title (and cut) and whether it's ready to turn in. Objectives, quest levels, quest chains,
 * gear, points of interest, professions and milestones stay home; omitted keeps only the title steps (the
 * rest weren't left out to fit). A state with no quest list (too_large) goes as it is.
 */
const LIST_ONLY_KEEP = new Set(['v', 'sid', 'seq', 't', 'state', 'char', 'loc', ...STATE_KEEP, 'omitted']);
export function listOnlyState(state) {
  if (!isObj(state)) return state;
  const out = Object.fromEntries(Object.entries(state).filter(([k]) => LIST_ONLY_KEEP.has(k)));
  if (Array.isArray(out.quests)) out.quests = out.quests.map(q => (isObj(q) ? Object.fromEntries(Object.entries(q).filter(([k]) => QUEST_KEEP.has(k))) : q));
  if (Array.isArray(out.omitted)) out.omitted = out.omitted.filter(k => typeof k === 'string' && k.startsWith('quests.title'));
  return out;
}

// One quest's detail at a time, from the end of the log: every quest stays. can(q): there's some to
// cut; cut(q) cuts it. Each quest is cut once (its detail is gone after), so the next look starts
// where the last one stopped.
const questDetail = (can, cut) => (d, at) => {
  const qs = d.game?.state?.quests;
  if (!Array.isArray(qs)) return null;
  for (at.i = Math.min(at.i ?? qs.length - 1, qs.length - 1); at.i >= 0; at.i--) {
    const q = qs[at.i];
    if (isObj(q) && can(q)) return { box: q, cut: () => cut(q) };
  }
  return null;
};
// The last line of a list that isn't the quest log's.
const otherLine = (o, k) => {
  const l = o?.[k];
  if (!Array.isArray(l)) return -1;
  for (let i = l.length - 1; i >= 0; i--) if (!QUEST_LINE.test(String(l[i]))) return i;
  return -1;
};
const extraKeys = q => Object.keys(q).filter(k => !QUEST_KEEP.has(k));
const FIT_STEPS = [
  ['linked', (d) => {
    const l = d.game?.linked;
    if (!Array.isArray(l) || !l.length) return null;
    const withLines = [...l].reverse().find(x => Array.isArray(x?.lines) && x.lines.length);
    return withLines ? popNext(withLines.lines) : popNext(l);
  }],
  // The quests' objective texts, from the end of the log (their counts stay): before memory, the
  // player's own notes among it. The addon now keeps them whenever the state has room, which can
  // be more than this block has (critic r2, round 3).
  ['state.quests.obj.text', questDetail(q => Array.isArray(q.obj) && q.obj.some(o => isObj(o) && 'text' in o),
    q => q.obj.forEach(o => { if (isObj(o)) delete o.text; }))],
  ['memory.quests', d => popNext(d.memory?.quests)],
  ['memory.notes', d => popNext(d.memory?.notes)],
  ['memory.recent', (d) => { const r = d.memory?.recent; return Array.isArray(r) && r.length ? { box: r, cut: () => r.shift() } : null; }],
  ['memory', d => (d.memory ? { cut: () => { delete d.memory; } } : null)],
  ['state.poi', d => popNext(d.game?.state?.poi)],
  ['state.chainStarts', d => popNext(d.game?.state?.chainStarts)],
  ['state.gear', d => popNext(d.game?.state?.gear)],
  ['state.pending', d => popNext(d.game?.state?.pending)],
  ['state.quests.obj', questDetail(q => 'obj' in q, (q) => { delete q.obj; })],
  // Where each quest's chain leads (CHAIN_NOTE), then the rest of a quest's detail.
  ['state.quests.chain', questDetail(q => 'chain' in q, (q) => { delete q.chain; })],
  ['state.quests.level', questDetail(q => extraKeys(q).length > 0, (q) => { for (const k of extraKeys(q)) delete q[k]; })],
  ['context', (d) => { const i = otherLine(d.game, 'context'); return i < 0 ? null : { box: d.game.context, cut: () => d.game.context.splice(i, 1) }; }],
  ['recap', d => (d.game?.recap ? { cut: () => { delete d.game.recap; } } : null)],
  ['state.rest', (d) => { // what the state holds besides the quest log
    const st = d.game?.state;
    if (!isObj(st)) return null;
    const k = Object.keys(st).reverse().find(x => !STATE_KEEP.has(x));
    if (k) return { cut: () => { delete st[k]; } };
    if (Array.isArray(st.quests) && st.quests.length) return null;
    return { cut: () => { delete d.game.state; } };
  }],
  // The notes the size line joins: measured whole, as that line's comma depends on them.
  ['notes', (d) => { const i = otherLine(d.game, 'notes'); return i < 0 ? null : { cut: () => d.game.notes.splice(i, 1) }; }],
];

/**
 * The block's data cut to at most max characters encoded (encodeData, as sent), with a line in
 * game.notes naming what was left out. Every quest stays, at least its id, title and whether it's
 * ready to turn in, with the quest log's lines: when those alone are over max, the block is too.
 * Returns { data, omitted }. Mutates and returns data.
 *
 * Code health BR-14: the block was encoded whole after every single cut, 23.6 ms a turn with 120
 * quests. Its size is now kept as it goes: a cut in place changes it by its box's own size, and the
 * block is encoded whole only when the size line changes (a step's first cut) or a cut has no box.
 * The cuts, and so the block, are the same. whole: true measures it whole after every cut, as before
 * (tests compare the two).
 */
export function fitData(data, max = DATA_MAX_CHARS, { whole = false } = {}) {
  const omitted = [];
  const noted = () => {
    if (!omitted.length) return data;
    const quests = Array.isArray(data.game?.state?.quests) && data.game.state.quests.length;
    const note = `Left out to fit the size limit: ${omitted.join(', ')}.${quests ? ' No quest was left out.' : ''}`;
    return { ...data, game: { ...(data.game || {}), notes: [...(data.game?.notes || []), note] } };
  };
  const measure = () => encodeData(noted()).length;
  let size = measure();
  for (const [label, next] of FIT_STEPS) {
    const at = {};
    while (size > max) {
      const piece = next(data, at);
      if (!piece) break;
      const box = whole ? null : piece.box;
      const before = box ? encodeData(box).length : 0;
      piece.cut();
      const first = !omitted.includes(label);
      if (first) omitted.push(label);
      size = !box || first ? measure() : size + encodeData(box).length - before;
    }
    if (size <= max) break;
  }
  const out = noted();
  for (const k of ['memory', 'game']) if (k in out && isEmpty(out[k])) delete out[k];
  return { data: out, omitted };
}

/**
 * buildRequest({ pack, memory, game, history, userText, … }) → req (see the top of this file).
 *   pack           loadPack()'s result, or the text
 *   memory         memory.digest()'s result, or null
 *   game           { state, context (lines or text), linked, event: {kind, args}, recap, notes, intro, locale } (gameBlock also accepted)
 *   history        transcripts.window(chatId, budget): [{role, content, names}] with real names
 *   userText       the message as the addon sent it ("Linked from the game" block included); empty on events
 *   pseudonymizer  the session's createPseudonymizer(); names: other players' names the caller found
 *   sendNames      the player opted in to sending other players' names (default false)
 *   identity       the player opted in to sending their character's name, realm and guild (default false)
 *   self           {name, realm, guild} when the caller knows them better than the game data
 *   manifest       the provider's manifest: effort capability (§7.4), local → datamark, id → meta
 *   datamark       mark game text for the model (default: manifest.local)
 *   dataMax        the block's cap in encoded characters (default 10,000)
 *   model, safetyId: passed through; effort: see resolveEffort; maxTokens: the reply's ceiling, 1,200
 *                  unless a positive whole number (the request's is that plus thinkRoom, held to outputCeiling)
 */
export function buildRequest({
  pack, memory = null, game = null, gameBlock = null, history = [], userText = '',
  pseudonymizer = null, names = [], sendNames = false, identity = false, self = null,
  manifest = null, model, effort, maxTokens = MAX_TOKENS, safetyId = null, cacheKey = null,
  datamark = manifest?.local === true, dataMax = DATA_MAX_CHARS,
  nonce = crypto.randomBytes(4).toString('hex'),
} = {}) {
  const packText = typeof pack === 'string' ? pack : pack?.text;
  if (!packText) throw new Error('buildRequest needs the prompt pack');
  if (!/^[0-9a-f]{4,32}$/.test(nonce)) throw new Error('nonce must be hex');
  const effortOut = resolveEffort(effort, manifest, model);
  const reply = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : MAX_TOKENS;
  const g = game ?? gameBlock ?? {};

  // The player's text and the linked tooltips, apart.
  const { typed, linked } = splitLinked(userText);

  // Game data, sanitized (RT-11).
  const out = {};
  if (isObj(g.state)) out.state = sanitizeState(g.state);
  if (g.context) out.context = sanitizeLines(g.context, { maxLine: 240, maxLines: 12, questLine: true });
  const links = linked.length ? linked : Array.isArray(g.linked) ? g.linked.slice(0, 8) : [];
  if (links.length) out.linked = sanitizeState(links, { max: 200 });
  const isEvent = !!(isObj(g.event) && EVENT_KINDS.has(g.event.kind));
  const isRecap = !isEvent && isObj(g.recap);
  if (isEvent) {
    const { kind: _forged, ...args } = sanitizeArgs(g.event.args); // an arg can't stand in for the real kind
    out.event = { kind: g.event.kind, ...args };
  }
  if (isObj(g.recap)) out.recap = sanitizeState(g.recap);
  // The quest log's count first (questNote): the model reads the list as whole, or what isn't in it,
  // or that the context's line has ids only.
  const quests = questNote(out.state, { stale: g.stale === true }) ?? (out.context?.some(l => QUEST_LINE.test(l)) ? IDS_ONLY_NOTE : null);
  const chains = hasChains(out.state) ? CHAIN_NOTE : null;
  const notes = [quests, chains, ...(g.notes ? sanitizeLines(g.notes, { maxLine: 400, maxLines: 5 }) : [])].filter(Boolean);
  if (notes.length) out.notes = notes;
  // The first meeting (onboarding spec §9.3, §9.6): the bridge's own marks, never game text. The
  // pack's rule reads them: intro, and the game client's locale for the reply's language.
  if (g.intro === true) out.intro = true;
  if (typeof g.locale === 'string' && LOCALE_RE.test(g.locale)) out.locale = g.locale;
  let gameData = Object.fromEntries(Object.entries(out).filter(([, v]) => !isEmpty(v)));
  let mem = isObj(memory) ? sanitizeState(memory, { max: 240 }) : null;

  // The character's own identity (§13.1): replaced unless the player opted in.
  const me = selfOf(self, { ...g, context: out.context });
  const mine = [me.name, me.realm, me.guild].map(x => sanitizeGameString(x ?? '', 60)).filter(x => [...x].length >= 2);
  if (!identity) {
    const swaps = [[me.name, 'your character'], [me.realm, 'your realm'], [me.guild, 'your guild']]
      .map(([k, v]) => [sanitizeGameString(k ?? '', 60), v]).filter(([k]) => [...k].length >= 2);
    const redact = s => replaceWords(s, swaps);
    gameData = keepQuestTitles(mapStrings(gameData, redact), out.state);
    if (mem) mem = mapStrings(mem, redact);
  }

  // Other players' names from game data (RT-12): from the caller, the quick ask's target, the linked
  // tooltips however they came (player links, "Made by" lines), and the history rows' own names, so a
  // new session masks old turns with its own labels. Pseudonymized unless the player opted in.
  const text = isEvent ? eventLine(g.event) : isRecap ? eventLine({ kind: 'recap' }) : sanitizeTyped(typed);
  const hist = normalizeHistory(history);
  const notMine = n => !mine.includes(sanitizeGameString(n, 60));
  const clean = list => list.map(normalizeName).filter(n => n && notMine(n));
  // Strong names (final review L5-4): the ones the player talks about, masked in their own text too:
  // the caller's, the "my target" ask's (this message's and the history's), player links' heads. A
  // "Made by" line's is masked in game data and the model's replies only.
  const histTargets = hist.filter(m => m.role === 'user').flatMap(m => namesFromMessage(m.content));
  const strongNames = new Set(clean([...(Array.isArray(names) ? names : []), ...namesFromMessage(typed), ...namesFromLinked(out.linked, { madeBy: false }), ...histTargets]));
  const found = [...new Set(clean([
    ...(Array.isArray(names) ? names : []), ...namesFromMessage(typed), ...namesFromLinked(out.linked),
    ...hist.flatMap(m => m.names), ...histTargets,
  ]))];
  if (pseudonymizer) {
    // A label already in the history that this session didn't hand out (wire-form storage, or one
    // the model made up) is kept from ever naming someone new; then the names are registered, even
    // when they're sent as they are (namesIn needs them), in order, each as strong or not.
    for (const m of hist) pseudonymizer.reserveLabelsIn(m.content);
    for (const n of found) pseudonymizer.register([n], { strong: strongNames.has(n) });
  }
  let wireText = text;
  let wireHist = hist.map(m => ({ role: m.role, content: m.content }));
  if (!sendNames) {
    if (found.length && !pseudonymizer) throw new Error('buildRequest: names from game data need the session pseudonymizer');
    if (pseudonymizer) {
      const mask = s => pseudonymizer.mask(s);
      const maskOwn = s => pseudonymizer.maskStrong(s);
      gameData = mapStrings(gameData, mask);
      if (mem) mem = mapStrings(mem, mask);
      if (!isEvent && !isRecap) wireText = maskOwn(text);
      wireHist = wireHist.map(m => ({ role: m.role, content: m.role === 'user' ? maskOwn(m.content) : mask(m.content) }));
    }
  }
  // The "my target" quick ask with the player's own character targeted (F1, a click on their own
  // portrait): the addon wrote that name into the line, as the game gave it, so with identity off
  // it goes as the data block has it, "your character" (§13.1; final review L5-3). What the player
  // typed themselves still goes as typed.
  if (!identity && me.name) {
    const own = sanitizeGameString(me.name, 60);
    const selfAsk = s => String(s).replace(TARGET_ASK_RE, (m, name) => (sanitizeGameString(name, 60) === own ? m.replace(`target: ${name}`, 'target: your character') : m));
    if (!isEvent && !isRecap) wireText = selfAsk(wireText);
    wireHist = wireHist.map(m => (m.role === 'user' ? { role: m.role, content: selfAsk(m.content) } : m));
  }

  // Datamarks for local models (TH5): every space in game text becomes the mark.
  if (datamark) {
    const markIt = s => s.replace(/ /g, DATAMARK);
    gameData = mapStrings(gameData, markIt);
    if (mem) mem = mapStrings(mem, markIt);
  }

  let data = { source: 'game' };
  if (datamark) data.datamark = DATAMARK;
  if (mem && !isEmpty(mem)) data.memory = mem;
  if (!isEmpty(gameData)) data.game = gameData;
  const fitted = fitData(data, Math.max(1000, Number(dataMax) || DATA_MAX_CHARS));
  data = fitted.data;
  const block = data.memory || data.game ? `<${TAG} id="${nonce}">\n${encodeData(data)}\n</${TAG} id="${nonce}">` : null;
  if (!block && !wireText.trim()) throw new Error('buildRequest: nothing to send');
  const content = block ? (wireText ? `${block}\n\n${wireText}` : block) : wireText;
  const parts = [];
  if (block) parts.push({ type: 'data', source: 'game', text: block });
  if (wireText) parts.push({ type: 'text', text: wireText });

  // What the transcript keeps for this turn: the real text and the names in it (never the block).
  const rowNames = pseudonymizer ? pseudonymizer.namesIn(text, { strongOnly: true }) : namesInText(text, [...strongNames]);
  const transcript = { role: 'user', text, names: rowNames };
  if (isEvent || isRecap) transcript.kind = isEvent ? g.event.kind : 'recap';

  return {
    model,
    system: [{ text: packText, cache: true }],
    messages: [...wireHist, { role: 'user', content, parts }],
    maxTokens: Math.min(reply + thinkRoom(effortOut, manifest, model), outputCeiling(manifest, model)),
    replyTokens: reply,
    effort: effortOut,
    safetyId,
    // The chat's cache key (a provider whose manifest names cacheKey: the ChatGPT plan): opaque, per chat.
    ...(typeof cacheKey === 'string' && cacheKey ? { cacheKey } : {}),
    meta: {
      packVersion: typeof pack === 'object' ? pack.version ?? null : null,
      provider: manifest?.id ?? null,
      nonce,
      dataTokens: estimateTokens(block ?? ''),
      historyMessages: wireHist.length,
      historyTokens: wireHist.reduce((n, m) => n + estimateTokens(m.content), 0),
      pseudonyms: pseudonymizer && !sendNames ? pseudonymizer.size : 0,
      identity: !!identity,
      datamark: !!datamark,
      omitted: fitted.omitted,
    },
    transcript,
  };
}

// The candidate names that occur in a text, whole words, each once.
function namesInText(text, candidates) {
  const re = wordsRegex(candidates);
  return re ? [...new Set(String(text ?? '').match(re) || [])] : [];
}

/**
 * The transcript row for a reply (history.mjs append): the reply with the real names put back, and
 * the known names in it, so a later session can mask it again. The reply as the model wrote it
 * (pseudonyms) is what a repair call in this session uses; this is what's kept.
 */
export function replyTranscript(reply, pseudonymizer = null) {
  const text = pseudonymizer ? pseudonymizer.unmask(reply) : String(reply ?? '');
  return { role: 'assistant', text, names: pseudonymizer ? pseudonymizer.namesIn(text) : [] };
}
