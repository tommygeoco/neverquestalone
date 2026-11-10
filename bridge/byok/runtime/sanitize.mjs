// Game text on its way into a prompt (public BYOK PRD §12.3 TH5, TH7, TH8; RT-11).
//
// Everything that comes from the game is forgeable (BT1): other addons, pasted macros and other
// players can put text into quest titles, zone names, tooltips and event args. The addon already
// strips escapes, `|`, newlines and controls and cuts strings to 60 bytes (PROTOCOL §2.6); the bridge
// does it again here, because a forged record never went through the addon's code:
//   - C0 and C1 controls (newlines and tabs included) become a space: no line of game text can
//     start a new line of the prompt ("\n--- end of game data ---\nSystem: ...").
//   - Game escapes go whole, as the addon's Clean does (Companion.lua): colours (|cAARRGGBB, |cn…:)
//     and |r, textures (|T…|t) and atlases (|A…|a); a link (|H…|h[Name]|h) keeps its [Name]. Then
//     any `|` left goes: no game escape survives, and none leaves stray letters ("cffff0000") behind.
//   - Format and default-ignorable characters go (\p{Cf} and \p{Default_Ignorable_Code_Point}: bidi
//     controls, zero-width characters, Hangul fillers, tag characters, variation selectors, the
//     interlinear annotation marks, musical format controls, ...), which can smuggle text a reader
//     never sees, and so do unpaired surrogates.
//   - Whitespace collapses, the ends are trimmed, and the length is capped in code points.
// Pure functions; the imports are the key shapes (typedLooksLikeKey) and the quest list's bound.
import { looksLikeKey } from '../security/keycheck.mjs';
import { QUEST_LIST_MAX } from '../../app/companion.mjs';

export const GAME_STRING_MAX = 60;
export const LINE_MAX = 240;
// A context line that starts "Quest log" holds every quest's id (PROTOCOL §2.6): it's kept whole
// (up to QUEST_LIST_MAX ids of up to 7 characters with their "*" and comma, after its count), never
// cut at LINE_MAX. (1,200 cut a log of 200 quests at 183 ids: the breaker's r2 d200.)
export const QUEST_LINE_MAX = 200 + 9 * QUEST_LIST_MAX;
export const QUEST_LINE = /^Quest log\b/;

// Controls (C0, DEL, C1) and the line and paragraph separators: replaced by a space.
const BREAKS = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}]/gu;
// Invisible or direction-changing characters, removed: every format character (Cf: soft hyphen,
// Arabic letter mark, zero-width space and joiners, LRM/RLM, bidi embeddings, overrides and
// isolates, word joiner, invisible operators, BOM, interlinear annotation marks, tag characters,
// musical format controls), every default-ignorable code point (combining grapheme joiner, Hangul
// fillers, Khmer inherent vowels, Mongolian selectors, variation selectors, deprecated format
// characters U+206A-206F), and unpaired surrogates (with the u flag a surrogate range matches only those).
export const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u{d800}-\u{dfff}]/gu;
// Game escapes (Companion.lua Clean): colours old and new, the colour end, textures, atlases; links keep their text.
const ESCAPES = [
  [/\|c[0-9a-fA-F]{8}/g, ''], [/\|cn[^:|]*:/g, ''], [/\|r/g, ''],
  [/\|H[^|]*\|h(.*?)\|h/g, '$1'], [/\|T[^|]*\|t/g, ''], [/\|A[^|]*\|a/g, ''],
];

/** Game escape sequences taken out whole (a link keeps its [Name]); a `|` that's left stays for the caller. */
export function stripEscapes(s) {
  let t = String(s ?? '');
  if (!t.includes('|')) return t;
  for (const [re, to] of ESCAPES) t = t.replace(re, to);
  return t;
}

/** Cut to at most max code points (never inside a surrogate pair). */
export function capCodePoints(s, max) {
  const t = String(s);
  if (t.length <= max) return t;
  return Array.from(t).slice(0, max).join('');
}

/** One game string, safe for a prompt: one line, no controls, `|` or invisible characters, capped. */
export function sanitizeGameString(s, max = GAME_STRING_MAX) {
  if (s === null || s === undefined) return '';
  const t = stripEscapes(String(s)).replace(INVISIBLE, '').replace(BREAKS, ' ').replace(/\|/g, '').replace(/\s+/g, ' ').trim();
  return capCodePoints(t, max).trim();
}

/**
 * Lines of game text (context lines, tooltip lines): each sanitized, empties dropped, capped.
 * questLine: the first line starting "Quest log" is kept, up to QUEST_LINE_MAX, wherever it is.
 */
export function sanitizeLines(text, { maxLine = LINE_MAX, maxLines = 40, questLine = false } = {}) {
  const lines = Array.isArray(text) ? text : String(text ?? '').split(/\r\n|\r|\n/);
  const out = [];
  let n = 0, quest = !questLine;
  for (const l of lines) {
    if (!quest) {
      const q = sanitizeGameString(l, QUEST_LINE_MAX);
      if (QUEST_LINE.test(q)) { out.push(q); quest = true; continue; }
    }
    if (n >= maxLines) { if (quest) break; continue; }
    const s = sanitizeGameString(l, maxLine);
    if (s) { out.push(s); n += 1; }
  }
  return out;
}

/**
 * What the player typed: controls other than newline and tab removed, and the invisible characters
 * above; `|` and line breaks stay (it's their text, and the model sees it as theirs). Capped.
 */
export function sanitizeTyped(s, max = 4000) {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, '')
    .replace(/[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}]/gu, '').replace(/[\u{2028}\u{2029}]/gu, '\n');
  return capCodePoints(t, max).trim();
}

/**
 * A model's text on its way to the game (SC-7 step 3, TH7; code health BR-07, the old audit's LS-04):
 * what sanitizeTyped takes out (controls but newline and tab, and the invisible characters: bidi
 * overrides and isolates, zero-width characters, the BOM, the soft hyphen; line and paragraph
 * separators become newlines), with no cap and no trim.
 */
export function cleanOutput(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, '')
    .replace(/[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}]/gu, '').replace(/[\u{2028}\u{2029}]/gu, '\n');
}

// KY-10's second look: the controls sanitizeTyped takes out (tab, line feed and carriage return
// stay: they end a key, as a space does). Its third: the no-break and fixed-width spaces, every
// space separator but the space itself, which a page or a mail can put where a key's dash was.
const KEY_CONTROLS = /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}]/gu;
const KEY_SPACES = /[\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}]/gu;

/**
 * KY-10 on what the player typed, three looks: the text as it came; with every character
 * sanitizeTyped takes out on the way to the model taken out (an invisible character inside a key,
 * U+200B, U+2066, U+FE0F: what some pages and mail clients put into long tokens, final review
 * L5-2, KA-04); and then with the game's escapes (a key pasted right after an item link, KA-04)
 * and the no-break spaces (KA-02) out too. The addon's C.KeyShaped is generated from this
 * (luaKeyShapedSource), so the two can't drift.
 */
export function typedLooksLikeKey(s) {
  const t = String(s ?? '');
  if (looksLikeKey(t)) return true;
  const v = t.replace(INVISIBLE, '').replace(KEY_CONTROLS, '').replace(/[\u{2028}\u{2029}]/gu, '\n');
  return looksLikeKey(v) || looksLikeKey(stripEscapes(v).replace(KEY_SPACES, ''));
}

// Code-point ranges [lo, hi] of the characters `hit` takes, over every code point.
function rangesOf(hit) {
  const out = [];
  let lo = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const h = cp < 0x110000 && hit(String.fromCodePoint(cp));
    if (h && lo < 0) lo = cp;
    else if (!h && lo >= 0) { out.push([lo, cp - 1]); lo = -1; }
  }
  return out;
}
const matcher = re => { const one = new RegExp(re.source, 'u'); return ch => one.test(ch); };
const luaRanges = ranges => ranges.map(([a, b]) => `{0x${a.toString(16).toUpperCase()}, 0x${b.toString(16).toUpperCase()}}`)
  .reduce((lines, r, i) => { if (i % 6 === 0) lines.push([]); lines.at(-1).push(r); return lines; }, [])
  .map(l => `\t${l.join(', ')},`).join('\n');

/**
 * typedLooksLikeKey's Lua 5.1 twin, for the addon (WoW's Lua has no utf8 library): the code points
 * the second and third looks take out (from INVISIBLE, KEY_CONTROLS and KEY_SPACES, as ranges),
 * a small UTF-8 decoder (plain ASCII skips it), and <table>.Visible, .StripEscapes (ESCAPES, with
 * `.` as [^\r\n]: after Visible no U+2028 or U+2029 is left) and .KeyShaped, which calls
 * .LooksLikeKey (keycheck.mjs's luaKeyCheckSource). tests/byok/runtime_sanitize_test.mjs runs it in
 * fengari and LuaJIT against typedLooksLikeKey. Regenerate the addon's copy with:
 *   node -e "import('./bridge/byok/runtime/sanitize.mjs').then(m => console.log(m.luaKeyShapedSource()))"
 */
export function luaKeyShapedSource({ table = 'C' } = {}) {
  const invisible = matcher(INVISIBLE), controls = matcher(KEY_CONTROLS);
  return [
    '-- KY-10: generated from bridge/byok/runtime/sanitize.mjs (typedLooksLikeKey); do not edit by hand.',
    'local KEY_HIDDEN = {',
    luaRanges(rangesOf(ch => invisible(ch) || controls(ch))),
    '}',
    'local KEY_SPACES = {',
    luaRanges(rangesOf(matcher(KEY_SPACES))),
    '}',
    'local function KeyIn(ranges, cp)',
    '\tlocal lo, hi = 1, #ranges',
    '\twhile lo <= hi do',
    '\t\tlocal mid = math.floor((lo + hi) / 2)',
    '\t\tif cp < ranges[mid][1] then hi = mid - 1',
    '\t\telseif cp > ranges[mid][2] then lo = mid + 1',
    '\t\telse return true end',
    '\tend',
    '\treturn false',
    'end',
    'local function KeyDrop(s, ranges)',
    '\ts = string.gsub(s, "%c", function(c) if KeyIn(ranges, string.byte(c)) then return "" end end)',
    '\tif not string.find(s, "[\\128-\\255]") then return s end',
    '\treturn (string.gsub(s, "[\\192-\\247][\\128-\\191]*", function(c)',
    '\t\tlocal n, b = #c, string.byte(c)',
    '\t\tlocal cp, min',
    '\t\tif n == 2 and b < 224 then cp, min = b % 32, 128',
    '\t\telseif n == 3 and b >= 224 and b < 240 then cp, min = b % 16, 2048',
    '\t\telseif n == 4 and b >= 240 then cp, min = b % 8, 65536',
    '\t\telse return nil end',
    '\t\tfor i = 2, n do cp = cp * 64 + string.byte(c, i) % 64 end',
    '\t\tif cp >= min and cp <= 1114111 and KeyIn(ranges, cp) then return "" end',
    '\tend))',
    'end',
    `${table}.Visible = function(s)`,
    '\treturn (string.gsub(KeyDrop(tostring(s or ""), KEY_HIDDEN), "\\226\\128[\\168\\169]", "\\n"))',
    'end',
    `${table}.StripEscapes = function(s)`,
    '\ts = tostring(s or "")',
    '\tif not string.find(s, "|", 1, true) then return s end',
    '\ts = string.gsub(s, "|c%x%x%x%x%x%x%x%x", "")',
    '\ts = string.gsub(s, "|cn[^:|]*:", "")',
    '\ts = string.gsub(s, "|r", "")',
    '\ts = string.gsub(s, "|H[^|]*|h([^\\r\\n]-)|h", "%1")',
    '\ts = string.gsub(s, "|T[^|]*|t", "")',
    '\ts = string.gsub(s, "|A[^|]*|a", "")',
    '\treturn s',
    'end',
    `${table}.KeyShaped = function(s)`,
    '\tif type(s) ~= "string" then return false end',
    `\tif ${table}.LooksLikeKey(s) then return true end`,
    `\tlocal v = ${table}.Visible(s)`,
    `\treturn ${table}.LooksLikeKey(v) or ${table}.LooksLikeKey(KeyDrop(${table}.StripEscapes(v), KEY_SPACES))`,
    'end',
    '',
  ].join('\n');
}

// Per-key list limits: the addon's own (PROTOCOL §2.6), so a forged state can't be longer than a real one.
// Quests have none of their own (every quest in the log goes): QUEST_LIST_MAX is past what a state the
// bridge takes can hold (12,000 bytes), so it bounds only a forged list.
const LIST_MAX = { quests: QUEST_LIST_MAX, obj: 5, poi: 40, chainStarts: 3, prof: 6, gear: 19, pending: 10, omitted: 24, zones: 25, q: 6 };
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/;
// Keys that an object literal treats specially: `out.__proto__ = x` sets the prototype instead of
// adding a key, so attacker data would be reachable by property access and hidden from JSON.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const okKey = k => KEY_RE.test(k) && !UNSAFE_KEYS.has(k);

// New optional game sections have explicit schemas: unknown keys (especially
// player identities) never enter a prompt. Counts and IDs are whole numbers.
const sectionObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sectionInt = (v, min = 0, max = 2147483647) => Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const sectionText = v => typeof v === 'string' ? sanitizeGameString(v, GAME_STRING_MAX) : undefined;
const sectionEnum = (v, values) => values.includes(v) ? v : undefined;
const compactSection = fields => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const sectionList = (v, cap, read) => Array.isArray(v) ? v.slice(0, cap).map(read).filter(v => v !== undefined) : undefined;
const identitySection = (v, fields) => sectionObject(v) && sectionInt(v.id, 1) !== undefined
  ? compactSection({ id: v.id, ...fields(v) }) : undefined;
const GAME_SECTIONS = {
  rewards: v => sectionList(v, 20, q => identitySection(q, q => ({
    items: sectionList(q.items, 6, i => identitySection(i, i => ({ name: sectionText(i.name), quality: sectionInt(i.quality, 0, 8),
      equipLoc: sectionText(i.equipLoc), ilvl: sectionInt(i.ilvl, 0, 10000), minLevel: sectionInt(i.minLevel, 0, 1000),
      count: sectionInt(i.count, 1, 1000000), choice: typeof i.choice === 'boolean' ? i.choice : undefined }))),
  }))),
  durability: v => sectionList(v, 19, i => sectionObject(i) && sectionInt(i.slot, 1, 19) !== undefined && sectionInt(i.pct, 0, 100) !== undefined
    ? { slot: i.slot, pct: i.pct } : undefined),
  rested: v => sectionInt(v),
  hearth: v => sectionObject(v) ? compactSection({ bind: sectionText(v.bind), left: sectionInt(v.left) }) : undefined,
  talents: v => sectionList(v, 5, t => sectionObject(t) && sectionInt(t.tree, 1, 5) !== undefined
    ? compactSection({ tree: t.tree, name: sectionText(t.name), points: sectionInt(t.points, 0, 1000) }) : undefined),
  gear: v => sectionList(v, 19, i => identitySection(i, i => ({ slot: sectionInt(i.slot, 1, 19), name: sectionText(i.name),
    ilvl: sectionInt(i.ilvl, 0, 10000), quality: sectionInt(i.quality, 0, 8), sell: sectionInt(i.sell) }))),
  bags: v => sectionObject(v) ? compactSection({
    free: sectionInt(v.free, 0, 1000), slots: sectionInt(v.slots, 0, 1000), partial: v.partial === true ? true : undefined,
    items: sectionList(v.items, 32, i => identitySection(i, i => ({ name: sectionText(i.name), count: sectionInt(i.count, 1, 1000000),
      kind: sectionEnum(i.kind, ['quest', 'foodDrink', 'potion', 'reagent']), quality: sectionInt(i.quality, 0, 8), sell: sectionInt(i.sell) }))),
  }) : undefined,
  auras: v => sectionList(v, 32, a => identitySection(a, a => ({ name: sectionText(a.name), kind: sectionEnum(a.kind, ['buff', 'debuff']),
    count: sectionInt(a.count, 0, 1000000), duration: sectionInt(a.duration), left: sectionInt(a.left) }))),
  rep: v => sectionList(v, 6, f => identitySection(f, f => ({ name: sectionText(f.name), standing: sectionInt(f.standing, 1, 8),
    min: sectionInt(f.min, -2147483647), max: sectionInt(f.max, -2147483647), value: sectionInt(f.value, -2147483647), watched: f.watched === true ? true : undefined }))),
  target: v => sectionObject(v) ? compactSection({ name: sectionText(v.name), level: sectionInt(v.level, -1, 1000),
    classification: sectionEnum(v.classification, ['normal', 'elite', 'rareelite', 'worldboss', 'rare', 'minus', 'trivial']), reaction: sectionInt(v.reaction, 1, 8) }) : undefined,
  group: v => sectionObject(v) ? compactSection({ size: sectionInt(v.size, 1, 40), members: sectionList(v.members, 40, m => sectionObject(m) ? compactSection({
    class: sectionEnum(m.class, ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'DEATHKNIGHT', 'SHAMAN', 'MAGE', 'WARLOCK', 'MONK', 'DRUID', 'DEMONHUNTER', 'EVOKER']),
    level: sectionInt(m.level, 0, 1000), role: sectionEnum(m.role, ['TANK', 'HEALER', 'DAMAGER']),
  }) : undefined) }) : undefined,
};

/**
 * A copy of a game state (or recap, or any game JSON) that's safe to put in a prompt: every string
 * sanitized and capped (60 by default), non-finite numbers and unknown types dropped, odd keys
 * dropped (and __proto__, constructor, prototype), lists capped (the addon's limits, else 25; the
 * quest list at QUEST_LIST_MAX, past any real state), at most 6 levels and 40 keys an object.
 */
export function sanitizeState(value, { max = GAME_STRING_MAX, depth = 6 } = {}) {
  // Schemas are a fixed bounded shape; still honor callers' smaller depth
  // and string budgets without applying generic 25-entry list limits again.
  const boundSection = (v, d) => {
    if (typeof v === 'string') return capCodePoints(v, Math.min(max, GAME_STRING_MAX)).trim();
    if (!v || typeof v !== 'object') return v;
    if (d <= 0) return undefined;
    if (Array.isArray(v)) return v.map(x => boundSection(x, d - 1)).filter(x => x !== undefined);
    return compactSection(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, boundSection(x, d - 1)])));
  };
  const walk = (v, d, key) => {
    if (d > 0 && Object.hasOwn(GAME_SECTIONS, key)) return boundSection(GAME_SECTIONS[key](v), d);
    if (v === null) return null;
    if (typeof v === 'string') return sanitizeGameString(v, max);
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean') return v;
    if (d <= 0 || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v.slice(0, LIST_MAX[key] ?? 25)) {
        const y = walk(x, d - 1, key);
        if (y !== undefined) out.push(y);
      }
      return out;
    }
    const out = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (!okKey(k) || n >= 40) continue;
      const y = walk(x, d - 1, k);
      if (y !== undefined) { out[k] = y; n += 1; }
    }
    return out;
  };
  return walk(value, depth, null);
}

/** An event's args ({kind, from, to, n, layer, zone, sid}): flat, strings and numbers only, sanitized. */
export function sanitizeArgs(args, max = GAME_STRING_MAX) {
  const out = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return out;
  for (const [k, v] of Object.entries(args)) {
    if (!okKey(k) || Object.keys(out).length >= 16) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' || typeof v === 'boolean') {
      const s = sanitizeGameString(String(v), max);
      if (s) out[k] = s;
    }
  }
  return out;
}

/** JSON on one line that no string inside can break out of: `<`, `>` and line separators escaped. */
export function encodeData(data) {
  return JSON.stringify(data).replace(/[<>\u{2028}\u{2029}]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
