// Strip v2 records (docs/PROTOCOL.md §2). Pure functions: parse what the
// capture app decoded, and encode records the same way the addon does (tests
// and the reload path use it).
//
//   2 US token US key US type US chat US args US body     (records joined by RS)
import zlib from 'node:zlib';

export const RS = '\x1e';
export const US = '\x1f';
export const GS = '\x1d';

export const TYPES = new Set(['hello', 'msg', 'stop', 'patch', 'forget', 'seen', 'evt', 'state', 'upd', 'vc']);
const UNKEYED = new Set(['hello', 'seen', 'state']);
const TOKEN_RE = /^[0-9a-f]{8}$/;
const NONCE_RE = /^[0-9a-f]{4}$/;
const KEY_RE = /^([0-9a-f]{4})_(\d{1,9})$/;
export const CHAT_RE = /^c[0-9a-f]{6}$/;
// Counters read off the screen (cur, p): at most 12 digits. 10^12 turns is decades of play, and
// a longer number (a garbled strip, another addon drawing in the corner) would move the store's
// numbering past what a double can count in ones (SY-19).
const COUNT_RE = /^\d{1,12}$/;

/** Percent-encode an args value: %, ;, = and bytes below 0x20 or 0x7F. */
export function encodeArg(v) {
  return String(v ?? '').replace(/[%;=\x00-\x1f\x7f]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

export function decodeArg(v) {
  return String(v).replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function parseArgs(s) {
  const out = {};
  if (!s) return out;
  for (const pair of String(s).split(';')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    out[pair.slice(0, i)] = decodeArg(pair.slice(i + 1));
  }
  return out;
}

export function encodeArgs(args) {
  return Object.entries(args).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeArg(v)}`).join(';');
}

/**
 * Parse one record. Returns { ok: true, record } or { ok: false, reason }.
 * record: { v, token, key, nonce, n, type, chat, args, body, context?, text? }
 */
export function parseRecord(wire) {
  const f = String(wire).split(US);
  if (f.length < 7) return { ok: false, reason: 'fields' };
  if (f[0] !== '2') return { ok: false, reason: 'version' };
  const [, token, key, type, chat, argStr] = f;
  const body = f.slice(6).join(US);
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'token' };
  if (!TYPES.has(type)) return { ok: false, reason: 'type' };
  let nonce, n = null;
  if (UNKEYED.has(type)) {
    if (!NONCE_RE.test(key)) return { ok: false, reason: 'key' };
    nonce = key;
  } else {
    const m = key.match(KEY_RE);
    if (!m) return { ok: false, reason: 'key' };
    nonce = m[1];
    n = Number(m[2]);
  }
  // From here a keyed record's token and key are good: a rejection carries
  // them, so the bridge can ack it anyway and the addon stops drawing it.
  const keyed = n === null ? {} : { token, key };
  // upd (the addon's updates) and vc (a voice command: odd/tasks/nqa-voice-controls.md T2) are keyed,
  // so acked and deduped, but about no chat.
  if (UNKEYED.has(type) || type === 'upd' || type === 'vc' ? chat !== '' : !CHAT_RE.test(chat)) return { ok: false, reason: 'chat', ...keyed };
  const args = parseArgs(argStr);
  if (!COUNT_RE.test(args.cur || '')) return { ok: false, reason: 'cur', ...keyed };
  // p (the push counter read) is optional: one out of range is dropped, the record kept.
  if (args.p !== undefined && !COUNT_RE.test(args.p)) delete args.p;
  const record = { v: 2, token, key, nonce, n, type, chat, args, body };
  if (type === 'msg') {
    if (args.ctx === '1') {
      const i = body.indexOf(GS);
      record.context = i >= 0 ? body.slice(0, i) : '';
      record.text = i >= 0 ? body.slice(i + 1) : body;
    } else {
      record.context = null;
      record.text = body;
    }
  }
  return { ok: true, record };
}

/** Parse a whole payload: { records: [...], rejected: [{ reason, wire, token?, key? }] }. */
export function parsePayload(payload) {
  const records = [];
  const rejected = [];
  for (const wire of String(payload).split(RS)) {
    if (!wire) continue;
    const r = parseRecord(wire);
    if (r.ok) records.push(r.record);
    else rejected.push({ reason: r.reason, wire, token: r.token, key: r.key });
  }
  return { records, rejected };
}

const INFLATE = [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync];

/**
 * A body marked z=1 (cap z, PROTOCOL §2.6): its text deflated, in base64. The
 * client's CompressString "Deflate" is raw deflate; zlib and gzip wrappers are
 * taken too. `limits` is { maxBody, maxText } (a number sets both): a body
 * longer than maxBody is refused, and inflating stops at maxText bytes, so a
 * small body can't grow into a big one.
 * Returns { ok: true, text } or { ok: false, reason }.
 */
export function inflateBody(body, limits) {
  const { maxBody, maxText } = typeof limits === 'number' ? { maxBody: limits, maxText: limits } : limits;
  const b64 = String(body ?? '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return { ok: false, reason: 'z: not base64' };
  if (b64.length > maxBody) return { ok: false, reason: 'z: too large' };
  const packed = Buffer.from(b64, 'base64');
  for (const inflate of INFLATE) {
    try {
      return { ok: true, text: inflate(packed, { maxOutputLength: maxText }).toString('utf8') };
    } catch (e) {
      if (e.code === 'ERR_BUFFER_TOO_LARGE') return { ok: false, reason: 'z: too large' };
    }
  }
  return { ok: false, reason: 'z: not deflate' };
}

/** A body as the addon sends it with z=1 (tests and fixtures). */
export function deflateBody(text) {
  return zlib.deflateRawSync(Buffer.from(String(text ?? ''), 'utf8')).toString('base64');
}

/** Field cleaning as the addon does it: RS/US/GS in user text become spaces. */
export function cleanField(s) {
  return String(s ?? '').replace(/[\x1d-\x1f]/g, ' ');
}

/** Encode a record exactly as the addon draws it (for tests and fixtures). */
export function encodeRecord({ token, key, type, chat = '', args = {}, body = '', context = null, text = null }) {
  let b = body;
  if (type === 'msg' && text !== null) {
    b = context !== null && context !== undefined ? cleanField(context) + GS + cleanField(text) : cleanField(text);
  }
  return ['2', token, key, type, chat, encodeArgs(args), b].join(US);
}
