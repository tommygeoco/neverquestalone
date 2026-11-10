// Optional web lookup for the voice companion (odd/tasks/nqa-voice.md T13): one Wowhead tooltip for
// World of Warcraft: Forever, by type and numeric id only (no free-text search: Wowhead's search
// refuses automated reads, and an id from the game data can't steer the request anywhere else).
// One fixed host, no redirects, a size cap, HTML stripped to plain text, and the result marked as
// quoted web data so the model treats it as reference, never as instructions.
export const WOWHEAD_HOST = 'nether.wowhead.com';
export const WOWHEAD_TYPES = Object.freeze(['quest', 'item', 'spell', 'npc']);
export const TEXT_MAX = 1500;
const BODY_MAX = 64 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** Tooltip HTML → plain text lines. */
export function tooltipText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>|<\/(?:tr|div|p|table|li)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
    .slice(0, TEXT_MAX);
}

/** The body as text, read in chunks and stopped at max bytes (null past it): never the whole of a huge one. */
export async function readCapped(res, max) {
  if (!res.body?.getReader) { const t = await res.text(); return Buffer.byteLength(t) > max ? null : t; }
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf8');
}

export async function lookupWowhead(type, id, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  if (!WOWHEAD_TYPES.includes(type)) return { error: `type must be one of ${WOWHEAD_TYPES.join(', ')}` };
  if (!Number.isInteger(id) || id <= 0 || id > 10_000_000) return { error: 'id must be a whole number from the game data' };
  const url = `https://${WOWHEAD_HOST}/forever/tooltip/${type}/${id}`;
  let res;
  try {
    res = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  } catch (e) {
    return { error: `Wowhead didn't answer (${String(e?.name || e).slice(0, 40)})` };
  }
  if (!res.ok) { await res.body?.cancel?.().catch(() => {}); return { error: `Wowhead answered ${res.status}` }; }
  const raw = await readCapped(res, BODY_MAX);
  if (raw == null) return { error: 'Wowhead sent more than a tooltip' };
  let j;
  try { j = JSON.parse(raw); } catch { return { error: 'Wowhead sent something that is not a tooltip' }; }
  const name = tooltipText(j?.name).slice(0, 80);
  const text = tooltipText(j?.tooltip);
  if (!name && !text) return { error: 'No tooltip for that id' };
  return { source: `Wowhead (World of Warcraft: Forever), ${type} ${id}`, quotedWebData: true, name, text };
}
