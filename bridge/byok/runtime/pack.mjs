// The prompt pack (public BYOK PRD §6.2 "Skill", §7.3 caching, DB16, DB19; RT-2).
//
// pack.md is generated from prompts/companion.md by tools/gen-prompts.mjs (never edit it by hand).
// It's the whole system prompt of every BYOK call, sent as the cached prefix: persona, reader
// rules, the block grammar with its numbers from the code, companion rules, safety and the
// addon/macro primer. loadPack puts the persona's name in (a setting, default NeverQuestAlone) and returns
// the text with a content hash as its version, so a log line or the "Last request" view can say
// exactly which prompt a turn went with. Its size is kept at or above 4,096 tokens (estimated),
// Haiku's minimum for caching a prefix.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { estimateTokens } from './history.mjs';

export const DEFAULT_NAME = 'NeverQuestAlone';
// The default until 1.4.9 (the owner, 2026-10-05: one name, NeverQuestAlone). Every config saved before
// then holds it, so it reads as the default.
export const EARLIER_DEFAULT_NAME = 'Bones';
export const PACK_FILE = new URL('./pack.md', import.meta.url);
const BANNER_RE = /^<!--[^\n]*-->\n/;

let template = null;

/** The pack as generated, without its "generated from" line. */
export function packTemplate() {
  if (template === null) template = fs.readFileSync(PACK_FILE, 'utf8').replace(BANNER_RE, '');
  return template;
}

/**
 * The persona's name as the pack may hold it: letters (any script), digits, spaces, ' and -,
 * 2 to 24 characters, starting with a letter; anything else, or the earlier default, gives the default.
 */
export function personaName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!/^\p{L}[\p{L}\p{M}\p{N} '-]{1,23}$/u.test(s) || s === EARLIER_DEFAULT_NAME) return DEFAULT_NAME;
  return s;
}

export { estimateTokens };

/** The compact pack for a typed question the local brain found facts for (chat-pack.md, written by
 * hand): the truth rules and the reply's blocks, a tenth of the full pack, so the answer starts sooner. */
let chatPackText = null;
export function loadChatPack({ persona = {} } = {}) {
  chatPackText ??= fs.readFileSync(new URL('./chat-pack.md', import.meta.url), 'utf8');
  const name = personaName(persona?.name);
  const text = chatPackText.split('{{name}}').join(name);
  const version = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  return { version, text, name, tokens: estimateTokens(text), compact: true };
}

/** loadPack({persona: {name}}) → { version, text, name, tokens } */
export function loadPack({ persona = {} } = {}) {
  const name = personaName(persona?.name);
  const text = packTemplate().split('{{name}}').join(name);
  const version = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  return { version, text, name, tokens: estimateTokens(text) };
}
